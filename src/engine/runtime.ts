import {
	BudgetExceeded,
	invalidCallback,
	EngineError,
	ProcessExit,
	SimulationAbort,
	StepLimitReached,
} from './errors';
import { ASYNC_FUNCTION, formatArgs, formatUncaught } from './format';
import { PROVIDED_GLOBALS, RUNTIME_ID, type SourceMeta } from './instrument';
import { createNodeModules } from './node-modules';
import { createPromise, type JobKind } from './promise';
import type {
	ConsoleLevel,
	ItemOrigin,
	ItemQueue,
	LibuvKind,
	Phase,
	SimStep,
} from './types';

export interface SimulationLimits {
	/** Visual steps before the run is cut short (endless programs). */
	maxSteps: number;
	/** Simulated milliseconds before the run is cut short. */
	maxTime: number;
	/** Loop iterations + calls before the code is considered frozen. */
	maxOperations: number;
	/** Nested calls before a `RangeError` is thrown, like a real engine. */
	maxStackDepth: number;
}

export const DEFAULT_LIMITS: SimulationLimits = {
	maxSteps: 100_000,
	maxTime: 60_000,
	maxOperations: 1_000_000,
	maxStackDepth: 250,
};

/** libuv's default UV_THREADPOOL_SIZE. */
export const THREADPOOL_SIZE = 4;

/** Node coerces delays outside [1, TIMEOUT_MAX] to 1ms. */
const TIMEOUT_MAX = 2 ** 31 - 1;

type Callable = (...args: unknown[]) => unknown;

/** One syscall of an fs operation, run on a thread pool worker. */
export interface FsStage {
	name: string;
	duration: number;
}

const isCallable = (value: unknown): value is Callable =>
	typeof value === 'function';

const isConstructor = (value: unknown) => {
	if (typeof value !== 'function') return false;
	try {
		Reflect.construct(String, [], value);
		return true;
	} catch {
		return false;
	}
};

const isFatal = (error: unknown) =>
	error instanceof SimulationAbort || error instanceof EngineError;

const JOB_ORIGIN: Record<JobKind, ItemOrigin> = {
	reaction: 'promise',
	thenable: 'thenable',
	await: 'await',
};

/** A callback waiting in one of the JavaScript-side queues. */
interface Task {
	itemId: number;
	label: string;
	range?: [number, number];
	run: () => void;
	/** clearTimeout / clearImmediate can still cancel a queued callback */
	handle?: number;
	/** follows the callback from queue to queue (see SimStep.flow) */
	flow?: number;
	/** libuv's own work: shown in its queue, but no JavaScript runs */
	internal?: boolean;
}

interface Timer {
	handle: number;
	/** id of the item shown in the libuv panel */
	itemId: number;
	expiry: number;
	seq: number;
	delay: number;
	repeat: boolean;
	label: string;
	range?: [number, number];
	run: () => void;
	ref: boolean;
	flow: number;
}

interface ThreadpoolJob {
	itemId: number;
	end: number;
	seq: number;
	task: Omit<Task, 'itemId'> & { origin: ItemOrigin };
}

interface OpenHandle {
	itemId: number;
	ref: boolean;
	flow: number;
}

export type ProcessEvent =
	'exit' | 'beforeExit' | 'uncaughtException' | 'unhandledRejection';

/**
 * What the simulated Node modules (fs, net, timers/promises, ...) need from
 * the event loop. See node-modules.ts.
 */
export interface NodeHost {
	readonly time: number;
	Promise: ReturnType<typeof createPromise>['Promise'];
	newPromiseCapability: ReturnType<
		typeof createPromise
	>['newPromiseCapability'];
	inspectPromise: ReturnType<typeof createPromise>['inspect'];
	describe(fn: unknown): { label: string; range?: [number, number] };
	/** Runs `fn` on a libuv worker; `done` runs in the poll phase. */
	threadpool(
		operation: string,
		stages: readonly FsStage[],
		callback: unknown,
		done: () => void
	): void;
	addTimer(
		name: 'setTimeout' | 'setInterval',
		callback: Callable,
		label: { label: string; range?: [number, number] },
		delay: unknown,
		args: unknown[]
	): number;
	clearTimer(handle: number): void;
	setTimerRef(handle: number, ref: boolean): void;
	timerHasRef(handle: number): boolean;
	refreshTimer(handle: number): void;
	addImmediate(
		callback: Callable,
		label: { label: string; range?: [number, number] },
		args: unknown[]
	): number;
	clearImmediate(handle: number): void;
	setImmediateRef(handle: number, ref: boolean): void;
	nextTick(
		callback: Callable,
		label: { label: string; range?: [number, number] },
		args: unknown[]
	): void;
	/** A long-lived handle (e.g. a listening server) keeps the loop alive. */
	openHandle(label: string): number;
	/** The handle's close callback runs in the "close callbacks" phase. */
	closeHandle(handle: number, label: string, onClose?: () => void): void;
	/** A socket event the kernel reports; `done` runs in the poll phase. */
	networkEvent(operation: string, callback: unknown, done: () => void): void;
	/** Calls a listener / callback with a call stack frame. */
	callWithFrame<T>(fn: Callable, thisArg: unknown, args: unknown[]): T;
	print(level: ConsoleLevel, value: string): void;
	tick(): void;
	exit(code: number): never;
	processListeners: Record<ProcessEvent, Callable[]>;
	exitCode: number;
}

/**
 * Executes an instrumented program against a simulated Node.js process and
 * records every observable change as a {@link SimStep}.
 *
 * The model follows libuv's `uv_run` and Node's callback wrapper:
 *
 *   main module -> nextTicks + microtasks
 *   while (loop alive)
 *     timers -> pending callbacks -> idle, prepare -> poll -> check -> close
 *
 * After every callback, Node drains `process.nextTick` callbacks and then
 * the V8 microtask queue (Promises, queueMicrotask), repeating until both
 * are empty (Node >= 11).
 */
export class Runtime {
	readonly steps: SimStep[] = [];
	private time = 0;
	private iteration = 0;
	private nextItemId = 1;
	/** see SimStep `flow` */
	private nextFlow = 1;
	private nextHandle = 1;
	private timerSeq = 0;

	private nextTicks: Task[] = [];
	private microtasks: Task[] = [];
	private timers: Timer[] = [];
	private timerQueue: Task[] = [];
	private immediates: (Task & { ref: boolean })[] = [];
	private threadpoolJobs: ThreadpoolJob[] = [];
	private workers: number[] = Array.from({ length: THREADPOOL_SIZE }, () => 0);
	private pollQueue: Task[] = [];
	private closeQueue: Task[] = [];
	private handles = new Map<number, OpenHandle>();

	private frames: { itemId: number; label: string; flow?: number }[] = [];
	/**
	 * The callback that called process.exit() or crashed: Node runs the
	 * 'exit' listeners in its async context (async_hooks says so too).
	 */
	private exitFlow: number | undefined;
	private operations = 0;
	private pendingRejections = new Set<object>();
	private functionTags = new WeakMap<object, number>();
	private exitCode = 0;

	private promises = createPromise({
		enqueueJob: (job, kind, handler) => this.enqueueJob(job, kind, handler),
		trackRejection: (promise, operation) => {
			if (operation === 'reject') this.pendingRejections.add(promise);
			else this.pendingRejections.delete(promise);
		},
		isFatal,
	});

	private processListeners: Record<ProcessEvent, Callable[]> = {
		exit: [],
		beforeExit: [],
		uncaughtException: [],
		unhandledRejection: [],
	};

	private consoleCounts = new Map<string, number>();
	private consoleTimers = new Map<string, number>();
	private readonly globalObject: Record<string, unknown>;

	constructor(
		private meta: SourceMeta[],
		/** the original program, for Function.prototype.toString */
		private source: string,
		private limits: SimulationLimits = DEFAULT_LIMITS
	) {
		this.globalObject = this.createGlobals();
	}

	// --- public entry ----------------------------------------------------------

	run(
		code: string,
		isModule = false
	): { steps: SimStep[]; truncated: boolean } {
		let program: Callable;
		try {
			// executing the user's code is the whole point of the simulator; it
			// only reaches the sandboxed globals (see instrument.ts)

			program = new Function(
				RUNTIME_ID,
				...PROVIDED_GLOBALS,
				`"use strict";\n{\n${code}\n}`
			) as Callable;
		} catch (error) {
			throw new EngineError(
				'internal',
				`Compilation failed: ${String(error)}`,
				{ message: String(error) }
			);
		}
		// fn.toString() must show what the user wrote, not the instrumented code
		const nativeToString = Function.prototype.toString;
		const functionTags = this.functionTags;
		const { meta, source } = this;
		Function.prototype.toString = function (this: unknown) {
			const tag =
				typeof this === 'function' ? functionTags.get(this) : undefined;
			if (tag === undefined) return Reflect.apply(nativeToString, this, []);
			const [start, end] = meta[tag].range;
			return source.slice(start, end);
		};
		try {
			return this.execute(program, isModule);
		} finally {
			Function.prototype.toString = nativeToString;
		}
	}

	private execute(
		program: Callable,
		isModule: boolean
	): { steps: SimStep[]; truncated: boolean } {
		const provided = PROVIDED_GLOBALS.map((name) => this.globalObject[name]);

		let truncated = false;
		let crashed = false;
		try {
			this.log({
				type: 'start',
				time: this.time,
				moduleType: isModule ? 'esm' : 'commonjs',
			});
			this.enterPhase('main');
			this.invoke(isModule ? 'main.mjs' : 'main.js', undefined, () =>
				// CommonJS runs the file with `this === module.exports`
				Reflect.apply(
					program,
					isModule
						? undefined
						: (this.globalObject.module as { exports: unknown }).exports,
					[this.api(), ...provided]
				)
			);
			// an ES module is evaluated inside a promise job: V8 finishes its
			// microtask queue before Node gets to process.nextTick callbacks
			this.drain(isModule);
			this.loop();
		} catch (error) {
			if (error instanceof BudgetExceeded)
				throw new EngineError(
					'operationLimit',
					'The code runs too long without yielding (infinite loop?)',
					{ limit: this.limits.maxOperations }
				);
			if (error instanceof StepLimitReached) truncated = true;
			else if (error instanceof ProcessExit) {
				crashed = error.exitCode !== 0 && this.crashed;
				this.exitCode = error.exitCode;
			} else throw error;
		}

		if (
			!truncated &&
			!crashed &&
			this.modulePromise &&
			this.promises.inspect(this.modulePromise)?.state === 'pending'
		) {
			// Node 22: the loop is empty but the module never finished evaluating
			this.steps.push({
				type: 'push',
				queue: 'console',
				id: this.nextItemId++,
				value: 'Warning: Detected unsettled top-level await',
				level: 'warn',
				time: this.time,
			});
			this.exitCode = 13;
		}
		if (!truncated) {
			// 'exit' listeners are ordinary JavaScript again
			this.aborting = false;
			this.emitExit();
			if (!crashed) this.closeLeftovers();
		}
		// the step budget may already be used up: the final step always fits
		this.steps.push({
			type: 'end',
			time: this.time,
			exitCode: this.exitCode,
			truncated,
			crashed,
		});
		return { steps: this.steps, truncated };
	}

	private crashed = false;

	// --- the loop ----------------------------------------------------------------

	/** What keeps the loop running (libuv's active handles + requests). */
	private get refs() {
		return (
			this.timers.filter((t) => t.ref).length +
			this.timerQueue.length +
			this.immediates.filter((i) => i.ref).length +
			// one fs request may be split into several thread pool jobs
			this.threadpoolJobs.length +
			this.pollQueue.length +
			this.closeQueue.length +
			[...this.handles.values()].filter((h) => h.ref).length
		);
	}

	private get alive() {
		return this.refs > 0;
	}

	private loop() {
		for (;;) {
			if (!this.alive) {
				// 'beforeExit' listeners may schedule more work
				if (!this.processListeners.beforeExit.length) return;
				for (const listener of [...this.processListeners.beforeExit])
					this.invokeCallable(listener, undefined, [this.exitCode]);
				this.drain();
				if (!this.alive) return;
			}
			if (this.time > this.limits.maxTime) throw new StepLimitReached();
			this.iteration++;
			this.runTimers();
			this.enterPhase('pending');
			this.enterPhase('idle');
			this.runPoll();
			this.runCheck();
			this.runClose();
		}
	}

	private enterPhase(phase: Phase) {
		this.log({
			type: 'phase',
			phase,
			iteration: this.iteration,
			time: this.time,
			refs: this.refs,
		});
	}

	private runTimers() {
		this.enterPhase('timers');
		const due: Timer[] = [];
		while (this.timers.length && this.timers[0].expiry <= this.time)
			due.push(this.timers.shift()!);
		for (const timer of due) {
			this.log({
				type: 'delete',
				queue: 'libuv',
				id: timer.itemId,
				reason: 'done',
				time: this.time,
			});
			const itemId = this.pushItem(
				'timers',
				timer.label,
				timer.repeat ? 'setInterval' : 'setTimeout',
				timer.range,
				timer.flow
			);
			this.timerQueue.push({
				itemId,
				label: timer.label,
				range: timer.range,
				handle: timer.handle,
				run: timer.run,
				flow: timer.flow,
			});
		}
		this.runQueue(this.timerQueue, 'timers');
	}

	private runPoll() {
		this.enterPhase('poll');
		// uv_backend_timeout: don't block when immediates or closes are pending
		const mustNotBlock =
			this.immediates.length > 0 || this.closeQueue.length > 0;
		if (!mustNotBlock) {
			const nextTimer = this.timers.length ? this.timers[0].expiry : Infinity;
			const nextIo = this.threadpoolJobs.length
				? Math.min(...this.threadpoolJobs.map((job) => job.end))
				: Infinity;
			const until = Math.min(nextTimer, nextIo);
			if (until === Infinity) {
				// only open handles (e.g. a listening server) are left: Node waits forever
				if ([...this.handles.values()].some((h) => h.ref))
					throw new StepLimitReached();
			} else if (until > this.time) {
				this.log({
					type: 'wait',
					time: this.time,
					until,
					reason: nextIo <= nextTimer ? 'io' : 'timer',
				});
				this.time = until;
			}
		}

		const completed = this.threadpoolJobs
			.filter((job) => job.end <= this.time)
			.sort((a, b) => a.end - b.end || a.seq - b.seq);
		this.threadpoolJobs = this.threadpoolJobs.filter(
			(job) => job.end > this.time
		);
		for (const job of completed) {
			this.log({
				type: 'delete',
				queue: 'libuv',
				id: job.itemId,
				reason: 'done',
				time: this.time,
			});
			const itemId = this.pushItem(
				'poll',
				job.task.label,
				job.task.origin,
				job.task.range,
				job.task.flow
			);
			this.pollQueue.push({ ...job.task, itemId });
		}
		this.runQueue(this.pollQueue, 'poll');
	}

	private runCheck() {
		this.enterPhase('check');
		// immediates scheduled while this phase runs wait for the next iteration
		this.runQueue(this.immediates, 'check');
	}

	private runClose() {
		this.enterPhase('close');
		this.runQueue(this.closeQueue, 'close');
	}

	/**
	 * Runs the callbacks a phase queue held when the phase started, draining
	 * after each. Callbacks added meanwhile wait for the next iteration;
	 * callbacks cancelled meanwhile (clearTimeout, clearImmediate) are skipped.
	 */
	private runQueue(queue: Task[], name: ItemQueue) {
		for (const task of [...queue]) {
			const index = queue.indexOf(task);
			if (index === -1) continue;
			queue.splice(index, 1);
			this.log({
				type: 'shift',
				queue: name,
				id: task.itemId,
				time: this.time,
			});
			if (task.internal) continue;
			this.invoke(task.label, task.range, task.run, task.flow);
			this.drain();
		}
	}

	/**
	 * processTicksAndRejections(): every nextTick, then every microtask, then
	 * unhandled rejections, until nothing is left.
	 */
	private drain(microtasksFirst = false) {
		if (
			!this.nextTicks.length &&
			!this.microtasks.length &&
			!this.pendingRejections.size
		)
			return;
		this.log({ type: 'drain', time: this.time });
		if (microtasksFirst) this.runMicrotasks();
		do {
			while (this.nextTicks.length) {
				const task = this.nextTicks.shift()!;
				this.log({
					type: 'shift',
					queue: 'nextTick',
					id: task.itemId,
					time: this.time,
				});
				this.invoke(task.label, task.range, task.run, task.flow);
			}
			this.runMicrotasks();
			// like Node: rejections are looked at only once the tick queue is empty
		} while (
			this.nextTicks.length ||
			this.microtasks.length ||
			this.processRejections()
		);
	}

	/** V8's microtask checkpoint: Promises and queueMicrotask, until empty. */
	private runMicrotasks() {
		while (this.microtasks.length) {
			const task = this.microtasks.shift()!;
			this.log({
				type: 'shift',
				queue: 'microtask',
				id: task.itemId,
				time: this.time,
			});
			this.invoke(task.label, task.range, task.run, task.flow);
		}
	}

	/** Node >= 15 (--unhandled-rejections=throw): unhandled rejections crash. */
	/** Returns true when it ran something, so the drain loop goes on. */
	private processRejections() {
		const rejected = [...this.pendingRejections];
		this.pendingRejections.clear();
		for (const promise of rejected) {
			const reason = this.promises.inspect(promise)?.value;
			const { unhandledRejection } = this.processListeners;
			if (unhandledRejection.length) {
				for (const listener of [...unhandledRejection])
					this.invokeCallable(listener, undefined, [reason, promise]);
			} else {
				this.handleUncaught(reason, true);
			}
		}
		return rejected.length > 0;
	}

	/** An exception reached the event loop: Node crashes unless someone listens. */
	private handleUncaught(error: unknown, inPromise: boolean, flow?: number) {
		this.exitFlow = flow;
		const { uncaughtException } = this.processListeners;
		if (uncaughtException.length) {
			for (const listener of [...uncaughtException]) {
				const { label, range } = this.describe(listener);
				try {
					this.withFrame(label, range, () =>
						Reflect.apply(listener, undefined, [
							error,
							inPromise ? 'unhandledRejection' : 'uncaughtException',
						])
					);
				} catch (handlerError) {
					if (isFatal(handlerError)) throw handlerError;
					// Node: "Uncaught exception handler failed" -> exit code 7
					this.crash(handlerError, false, 7);
				}
			}
			return;
		}
		this.crash(error, inPromise, 1);
	}

	private crash(error: unknown, inPromise: boolean, exitCode: number): never {
		this.print(
			'error',
			formatUncaught(error, inPromise, this.promises.inspect)
		);
		this.crashed = true;
		this.aborting = true;
		throw new ProcessExit(exitCode);
	}

	/**
	 * A normal exit can leave unref()-ed timers and immediates behind: Node
	 * tears them down with the process, so they leave the libuv view too.
	 */
	private closeLeftovers() {
		const leftovers = [
			...this.timers.map((t) => ['libuv', t.itemId] as const),
			...this.immediates.map((i) => ['check', i.itemId] as const),
		];
		this.timers = [];
		this.immediates = [];
		for (const [queue, id] of leftovers) {
			if (this.steps.length >= this.limits.maxSteps) return;
			this.steps.push({
				type: 'delete',
				queue,
				id,
				reason: 'done',
				time: this.time,
			});
		}
	}

	private emitExit() {
		const listeners = [...this.processListeners.exit];
		this.processListeners.exit = [];
		for (const listener of listeners) {
			try {
				this.withFrame(
					this.describe(listener).label,
					this.describe(listener).range,
					() => Reflect.apply(listener, undefined, [this.exitCode]),
					'call',
					this.exitFlow
				);
			} catch (error) {
				if (error instanceof ProcessExit) {
					this.exitCode = error.exitCode;
					return;
				}
				if (isFatal(error)) return;
				this.print(
					'error',
					formatUncaught(error, false, this.promises.inspect)
				);
				this.exitCode = 1;
				return;
			}
		}
	}

	// --- step log ----------------------------------------------------------------

	private log(step: SimStep) {
		if (this.steps.length >= this.limits.maxSteps) {
			this.aborting = true;
			throw new StepLimitReached();
		}
		this.steps.push(step);
	}

	private pushItem(
		queue: ItemQueue,
		value: string,
		origin: ItemOrigin,
		range?: [number, number],
		flow?: number
	) {
		const id = this.nextItemId++;
		this.log({
			type: 'push',
			queue,
			id,
			value,
			origin,
			range,
			flow,
			time: this.time,
		});
		return id;
	}

	private pushLibuv(
		value: string,
		origin: ItemOrigin,
		kind: LibuvKind,
		start: number,
		end: number | undefined,
		range?: [number, number],
		flow?: number
	) {
		const id = this.nextItemId++;
		this.log({
			type: 'push',
			queue: 'libuv',
			id,
			value,
			origin,
			kind,
			start,
			end,
			range,
			flow,
			time: this.time,
		});
		return id;
	}

	private consoleIndent = 0;

	private print(level: ConsoleLevel, value: string) {
		this.log({
			type: 'push',
			queue: 'console',
			id: this.nextItemId++,
			// console.group() indents by two spaces per level, line by line
			value: value.replace(/^/gm, '  '.repeat(this.consoleIndent)),
			level,
			time: this.time,
		});
	}

	// --- labels --------------------------------------------------------------------

	private describe(fn: unknown): { label: string; range?: [number, number] } {
		const tag =
			typeof fn === 'function' ? this.functionTags.get(fn) : undefined;
		if (tag !== undefined) return this.meta[tag];
		const name = typeof fn === 'function' ? fn.name : '';
		return { label: name ? `${name}()` : 'anonymous()' };
	}

	// --- execution -------------------------------------------------------------------

	/** Runs a callback the event loop owns; exceptions go to handleUncaught. */
	private invoke(
		label: string,
		range: [number, number] | undefined,
		fn: () => unknown,
		flow?: number
	) {
		let failed = false;
		let failure: unknown;
		try {
			this.withFrame(label, range, fn, 'call', flow);
		} catch (error) {
			if (isFatal(error)) throw error;
			failed = true;
			failure = error;
		}
		if (failed) this.handleUncaught(failure, false, flow);
	}

	private invokeCallable(fn: Callable, thisArg: unknown, args: unknown[]) {
		const { label, range } = this.describe(fn);
		this.invoke(label, range, () => Reflect.apply(fn, thisArg, args));
	}

	private withFrame<T>(
		label: string,
		range: [number, number] | undefined,
		fn: () => T,
		origin: ItemOrigin = 'call',
		flow?: number
	): T {
		this.tick();
		if (this.frames.length >= this.limits.maxStackDepth)
			throw new RangeError('Maximum call stack size exceeded');
		const itemId = this.pushItem('callstack', label, origin, range, flow);
		this.frames.push({ itemId, label, flow });
		try {
			return fn();
		} finally {
			this.frames.pop();
			this.log({
				type: 'pop',
				queue: 'callstack',
				id: itemId,
				time: this.time,
			});
		}
	}

	private tick() {
		if (++this.operations > this.limits.maxOperations) {
			this.aborting = true;
			throw new BudgetExceeded();
		}
	}

	/**
	 * Set when the process is going down (process.exit, crash, limits):
	 * instrumented `finally` blocks check it, because a real exit runs no
	 * more JavaScript.
	 */
	private aborting = false;
	private modulePromise: object | null = null;

	private enqueueJob(job: () => void, kind: JobKind, handler: unknown) {
		const { label, range } =
			kind === 'await'
				? { label: String(handler), range: undefined }
				: kind === 'thenable'
					? { label: 'resolve(thenable)', range: undefined }
					: handler === undefined
						? { label: 'pass-through', range: undefined }
						: this.describe(this.promises.labelOf(handler));
		const flow = this.nextFlow++;
		const itemId = this.pushItem(
			'microtask',
			label,
			JOB_ORIGIN[kind],
			range,
			flow
		);
		this.microtasks.push({ itemId, label, range, run: job, flow });
	}

	// --- libuv: timers, immediates, thread pool, handles -----------------------------

	private scheduleTimer(timer: Omit<Timer, 'itemId' | 'expiry' | 'seq'>) {
		const expiry = this.time + timer.delay;
		const itemId = this.pushLibuv(
			timer.label,
			timer.repeat ? 'setInterval' : 'setTimeout',
			'timer',
			this.time,
			expiry,
			timer.range,
			timer.flow
		);
		const scheduled: Timer = { ...timer, itemId, expiry, seq: this.timerSeq++ };
		const index = this.timers.findIndex(
			(t) => t.expiry > expiry || (t.expiry === expiry && t.seq > scheduled.seq)
		);
		if (index === -1) this.timers.push(scheduled);
		else this.timers.splice(index, 0, scheduled);
	}

	private addTimer(
		name: 'setTimeout' | 'setInterval',
		callback: Callable,
		source: { label: string; range?: [number, number] },
		delay: unknown,
		args: unknown[]
	) {
		let after = Number(delay);
		if (!(after >= 1 && after <= TIMEOUT_MAX)) after = 1;
		// Node keeps whole milliseconds: 2.5 behaves like 2
		after = Math.trunc(after);
		const handle = this.nextHandle++;
		const repeat = name === 'setInterval';
		const timer: Omit<Timer, 'itemId' | 'expiry' | 'seq'> = {
			handle,
			flow: this.nextFlow++,
			delay: after,
			repeat,
			label: source.label,
			range: source.range,
			ref: true,
			// an interval is re-armed after its callback, unless it was cleared
			run: () => {
				try {
					Reflect.apply(callback, this.timeoutObjects.get(handle), args);
				} finally {
					if (repeat && this.activeTimers.has(handle))
						this.scheduleTimer({
							...timer,
							ref: this.timerRefs.get(handle) ?? true,
						});
					else this.activeTimers.delete(handle);
				}
			},
		};
		this.activeTimers.add(handle);
		this.timerRecords.set(handle, timer);
		this.scheduleTimer(timer);
		return handle;
	}

	private activeTimers = new Set<number>();
	/** every timer ever created, so refresh() can re-arm a fired one */
	private timerRecords = new Map<
		number,
		Omit<Timer, 'itemId' | 'expiry' | 'seq'>
	>();
	private clearedTimers = new Set<number>();
	private timerRefs = new Map<number, boolean>();
	/** Timeout objects by handle: `this` inside a timer callback. */
	private timeoutObjects = new Map<number, unknown>();

	private clearTimer(handle: number) {
		if (!this.activeTimers.delete(handle)) return;
		this.clearedTimers.add(handle);
		const index = this.timers.findIndex((t) => t.handle === handle);
		if (index !== -1) {
			const [timer] = this.timers.splice(index, 1);
			this.log({
				type: 'delete',
				queue: 'libuv',
				id: timer.itemId,
				reason: 'cancelled',
				time: this.time,
			});
		}
		const queued = this.timerQueue.findIndex((t) => t.handle === handle);
		if (queued !== -1) {
			const [task] = this.timerQueue.splice(queued, 1);
			this.log({
				type: 'delete',
				queue: 'timers',
				id: task.itemId,
				reason: 'cancelled',
				time: this.time,
			});
		}
	}

	/** Timeout#refresh(): restart the countdown, also for a timer that already fired. */
	private refreshTimer(handle: number) {
		const index = this.timers.findIndex((t) => t.handle === handle);
		if (index === -1) {
			const record = this.timerRecords.get(handle);
			if (!record || this.clearedTimers.has(handle)) return;
			// a timer waiting in the timers queue runs anyway; Node re-arms it too
			this.activeTimers.add(handle);
			this.scheduleTimer({
				...record,
				ref: this.timerRefs.get(handle) ?? true,
			});
			return;
		}
		const [timer] = this.timers.splice(index, 1);
		this.log({
			type: 'delete',
			queue: 'libuv',
			id: timer.itemId,
			reason: 'cancelled',
			time: this.time,
		});
		this.scheduleTimer(timer);
	}

	private addImmediate(
		callback: Callable,
		source: { label: string; range?: [number, number] },
		args: unknown[]
	) {
		const handle = this.nextHandle++;
		const flow = this.nextFlow++;
		const itemId = this.pushItem(
			'check',
			source.label,
			'setImmediate',
			source.range,
			flow
		);
		this.immediates.push({
			itemId,
			handle,
			flow,
			ref: true,
			label: source.label,
			range: source.range,
			run: () =>
				Reflect.apply(callback, this.immediateObjects.get(handle), args),
		});
		return handle;
	}

	private immediateObjects = new Map<number, unknown>();

	private clearImmediate(handle: number) {
		const index = this.immediates.findIndex((i) => i.handle === handle);
		if (index === -1) return;
		const [task] = this.immediates.splice(index, 1);
		this.log({
			type: 'delete',
			queue: 'check',
			id: task.itemId,
			reason: 'cancelled',
			time: this.time,
		});
	}

	private nextTick(
		callback: Callable,
		source: { label: string; range?: [number, number] },
		args: unknown[]
	) {
		const flow = this.nextFlow++;
		const itemId = this.pushItem(
			'nextTick',
			source.label,
			'nextTick',
			source.range,
			flow
		);
		this.nextTicks.push({
			itemId,
			flow,
			label: source.label,
			range: source.range,
			run: () => Reflect.apply(callback, undefined, args),
		});
	}

	/**
	 * Runs blocking work on the libuv thread pool. An fs call is a chain of
	 * syscalls (readFile = open -> fstat -> read -> close): every stage is a
	 * round trip to a worker, and its completion is picked up by the poll
	 * phase, which starts the next stage. Only the last stage runs the
	 * user's callback; that is why a file read needs several loop iterations.
	 */
	private threadpool(
		operation: string,
		stages: readonly FsStage[],
		callback: unknown,
		done: () => void
	) {
		const source = this.describe(callback);
		// one flow for the whole call: every syscall stage and the final callback
		const flow = this.nextFlow++;
		const runStage = (index: number) => {
			const stage = stages[index];
			const isLast = index === stages.length - 1;
			// the job waits for a free worker of the pool
			const worker = this.workers.indexOf(Math.min(...this.workers));
			const start = Math.max(this.time, this.workers[worker]);
			const end = start + stage.duration;
			this.workers[worker] = end;
			const itemId = this.pushLibuv(
				stages.length > 1 ? `${operation} · ${stage.name}` : operation,
				'fs',
				'threadpool',
				start,
				end,
				source.range,
				flow
			);
			this.threadpoolJobs.push({
				itemId,
				end,
				seq: this.timerSeq++,
				task: isLast
					? {
							label: source.label,
							range: source.range,
							origin: 'fs',
							run: done,
							flow,
						}
					: {
							label: `${operation}: ${stage.name} ✓ → ${stages[index + 1].name}`,
							origin: 'fsInternal',
							run: () => runStage(index + 1),
							flow,
						},
			});
		};
		runStage(0);
	}

	private openHandle(label: string) {
		const handle = this.nextHandle++;
		const flow = this.nextFlow++;
		const itemId = this.pushLibuv(
			label,
			'close',
			'handle',
			this.time,
			undefined,
			undefined,
			flow
		);
		this.handles.set(handle, { itemId, ref: true, flow });
		return handle;
	}

	/**
	 * uv_close(): the handle's close callback runs in the close callbacks
	 * phase. Without `onClose` only libuv works there (e.g. a server whose
	 * 'close' event Node emits on the next tick instead).
	 */
	private closeHandle(handle: number, label: string, onClose?: () => void) {
		const open = this.handles.get(handle);
		if (!open) return;
		this.handles.delete(handle);
		this.log({
			type: 'delete',
			queue: 'libuv',
			id: open.itemId,
			reason: 'done',
			time: this.time,
		});
		const itemId = this.pushItem('close', label, 'close', undefined, open.flow);
		this.closeQueue.push({
			itemId,
			label,
			run: onClose ?? (() => undefined),
			flow: open.flow,
			internal: !onClose,
		});
	}

	/**
	 * Network I/O is not blocking: no thread pool, the kernel reports it
	 * (epoll / kqueue) and the callback runs in the poll phase of the next
	 * pass over poll.
	 */
	private networkEvent(operation: string, callback: unknown, done: () => void) {
		const source = this.describe(callback);
		const flow = this.nextFlow++;
		const itemId = this.pushLibuv(
			operation,
			'net',
			'network',
			this.time,
			this.time,
			source.range,
			flow
		);
		this.threadpoolJobs.push({
			itemId,
			end: this.time,
			seq: this.timerSeq++,
			task: {
				label: source.label,
				range: source.range,
				origin: 'net',
				run: done,
				flow,
			},
		});
	}

	// --- the simulated environment -----------------------------------------------------

	private host(): NodeHost {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const runtime = this;
		return {
			get time() {
				return runtime.time;
			},
			Promise: this.promises.Promise,
			newPromiseCapability: this.promises.newPromiseCapability,
			inspectPromise: this.promises.inspect,
			describe: (fn) => this.describe(fn),
			threadpool: (operation, stages, callback, done) =>
				this.threadpool(operation, stages, callback, done),
			addTimer: (name, callback, label, delay, args) =>
				this.addTimer(name, callback, label, delay, args),
			clearTimer: (handle) => this.clearTimer(handle),
			setTimerRef: (handle, ref) => {
				this.timerRefs.set(handle, ref);
				for (const timer of this.timers)
					if (timer.handle === handle) timer.ref = ref;
			},
			timerHasRef: (handle) => this.timerRefs.get(handle) ?? true,
			refreshTimer: (handle) => this.refreshTimer(handle),
			addImmediate: (callback, label, args) =>
				this.addImmediate(callback, label, args),
			clearImmediate: (handle) => this.clearImmediate(handle),
			setImmediateRef: (handle, ref) => {
				for (const immediate of this.immediates)
					if (immediate.handle === handle) immediate.ref = ref;
			},
			nextTick: (callback, label, args) => this.nextTick(callback, label, args),
			openHandle: (label) => this.openHandle(label),
			closeHandle: (handle, label, onClose) =>
				this.closeHandle(handle, label, onClose),
			networkEvent: (operation, callback, done) =>
				this.networkEvent(operation, callback, done),
			callWithFrame: <T>(fn: Callable, thisArg: unknown, args: unknown[]) => {
				const { label, range } = this.describe(fn);
				return this.withFrame(label, range, () =>
					Reflect.apply(fn, thisArg, args)
				) as T;
			},
			print: (level, value) => this.print(level, value),
			tick: () => this.tick(),
			exit: (code) => {
				this.exitCode = code;
				this.exitFlow = this.frames.find((f) => f.flow !== undefined)?.flow;
				this.aborting = true;
				throw new ProcessExit(code);
			},
			processListeners: this.processListeners,
			get exitCode() {
				return runtime.exitCode;
			},
			set exitCode(code: number) {
				runtime.exitCode = code;
			},
		};
	}

	private createGlobals(): Record<string, unknown> {
		const consoleMethod =
			(level: ConsoleLevel) =>
			(...args: unknown[]) =>
				this.print(level, formatArgs(args, this.promises.inspect));
		// the Console spec converts labels with ToString, "[object Object]" included
		const labelOf = (label: unknown) =>
			label === undefined ? 'default' : String(label);

		const simConsole = {
			log: consoleMethod('log'),
			info: consoleMethod('info'),
			debug: consoleMethod('debug'),
			warn: consoleMethod('warn'),
			error: consoleMethod('error'),
			trace: consoleMethod('error'),
			dir: consoleMethod('log'),
			table: consoleMethod('log'),
			group: (...args: unknown[]) => {
				if (args.length) consoleMethod('log')(...args);
				this.consoleIndent++;
			},
			groupCollapsed: (...args: unknown[]) => {
				if (args.length) consoleMethod('log')(...args);
				this.consoleIndent++;
			},
			groupEnd: () => {
				this.consoleIndent = Math.max(0, this.consoleIndent - 1);
			},
			assert: (condition: unknown, ...args: unknown[]) => {
				if (condition) return;
				const message = formatArgs(args, this.promises.inspect);
				this.print('error', `Assertion failed${message ? `: ${message}` : ''}`);
			},
			count: (label?: unknown) => {
				const key = labelOf(label);
				const count = (this.consoleCounts.get(key) ?? 0) + 1;
				this.consoleCounts.set(key, count);
				this.print('log', `${key}: ${count}`);
			},
			countReset: (label?: unknown) =>
				this.consoleCounts.delete(labelOf(label)),
			time: (label?: unknown) =>
				this.consoleTimers.set(labelOf(label), this.time),
			timeLog: (label?: unknown) => {
				const key = labelOf(label);
				const start = this.consoleTimers.get(key);
				if (start !== undefined)
					this.print('log', `${key}: ${(this.time - start).toFixed(3)}ms`);
			},
			timeEnd: (label?: unknown) => {
				const key = labelOf(label);
				const start = this.consoleTimers.get(key);
				if (start === undefined) return;
				this.consoleTimers.delete(key);
				this.print('log', `${key}: ${(this.time - start).toFixed(3)}ms`);
			},
		};

		const modules = createNodeModules(this.host(), {
			timeoutObjects: this.timeoutObjects,
			immediateObjects: this.immediateObjects,
		});

		const globals: Record<string, unknown> = {
			console: simConsole,
			...modules.globals,
			queueMicrotask: (callback: unknown) => {
				if (!isCallable(callback)) throw invalidCallback('callback', callback);
				const { label, range } = this.describe(callback);
				const flow = this.nextFlow++;
				const itemId = this.pushItem(
					'microtask',
					label,
					'queueMicrotask',
					range,
					flow
				);
				this.microtasks.push({
					itemId,
					flow,
					label,
					range,
					run: () => Reflect.apply(callback, undefined, []),
				});
			},
			Promise: this.promises.Promise,
			performance: { now: () => this.time, timeOrigin: 0 },
			module: { exports: {} },
			__filename: '/app/main.js',
			__dirname: '/app',
		};
		globals.exports = (globals.module as { exports: unknown }).exports;
		globals.globalThis = globals;
		globals.global = globals;
		return globals;
	}

	/** The `__elx` object the instrumented code talks to. */
	private api() {
		const callFrame = <T>(callId: number, fn: () => T) => {
			const { label, range } = this.meta[callId];
			return this.withFrame(label, range, fn);
		};
		const calleeOf = (callId: number) =>
			this.meta[callId].callee ?? 'expression';

		return {
			/** plain call */
			c:
				(callId: number, fn: unknown) =>
				(...args: unknown[]) => {
					if (!isCallable(fn))
						throw new TypeError(`${calleeOf(callId)} is not a function`);
					return callFrame(callId, () => Reflect.apply(fn, undefined, args));
				},
			/** method call: receiver and property are read before the arguments */
			m: (callId: number, object: unknown, key: PropertyKey) => {
				const fn = (object as Record<PropertyKey, unknown>)[key];
				return (...args: unknown[]) => {
					if (!isCallable(fn))
						throw new TypeError(`${calleeOf(callId)} is not a function`);
					return callFrame(callId, () => Reflect.apply(fn, object, args));
				};
			},
			/** new */
			n:
				(callId: number, C: unknown) =>
				(...args: unknown[]) => {
					if (!isConstructor(C))
						throw new TypeError(`${calleeOf(callId)} is not a constructor`);
					return callFrame(callId, () =>
						Reflect.construct(C as new (...a: unknown[]) => object, args)
					);
				},
			/** tag a function with its source location */
			f: (fnId: number, fn: unknown, name: string, isAsync: number) => {
				if (typeof fn === 'function') {
					this.functionTags.set(fn, fnId);
					if (isAsync)
						Object.defineProperty(fn, ASYNC_FUNCTION, { value: true });
					if (name && !fn.name)
						Object.defineProperty(fn, 'name', {
							value: name,
							configurable: true,
						});
				}
				return fn;
			},
			/** loop iteration */
			t: () => this.tick(),
			/** finally blocks are skipped while the process goes down */
			x: () => this.aborting,
			/** the promise of an ES module with top-level await */
			u: (promise: object) => {
				this.modulePromise = promise;
			},
			/** catch clause: simulation signals are not catchable */
			k: (error: unknown) => {
				if (isFatal(error)) throw error;
			},
			/** read of a global outside the sandbox */
			g: (name: string): never => {
				throw new ReferenceError(`${name} is not defined`);
			},
			/** write to a global outside the sandbox (rhs already evaluated) */
			w: (name: string): never => {
				throw new ReferenceError(`${name} is not defined`);
			},
			/** async function body driven as a generator through Await() */
			a: (
				thisArg: unknown,
				args: ArrayLike<unknown>,
				body: (...a: unknown[]) => Generator<unknown, unknown, unknown>
			) => this.runAsync(thisArg, args, body),
		};
	}

	private runAsync(
		thisArg: unknown,
		args: ArrayLike<unknown>,
		body: (...a: unknown[]) => Generator<unknown, unknown, unknown>
	) {
		const capability = this.promises.newPromiseCapability();
		const owner = this.frames.at(-1)?.label ?? 'main.js';
		const resumeLabel = `${owner} (after await)`;
		const generator = Reflect.apply(body, thisArg, Array.from(args));

		const step = (method: 'next' | 'throw', value: unknown) => {
			let result: IteratorResult<unknown>;
			try {
				result = generator[method](value);
			} catch (error) {
				if (isFatal(error)) throw error;
				capability.reject(error);
				return;
			}
			if (result.done) {
				capability.resolve(result.value);
				return;
			}
			try {
				this.promises.awaitValue(
					result.value,
					(v) => step('next', v),
					(e) => step('throw', e),
					resumeLabel
				);
			} catch (error) {
				// PromiseResolve can throw (e.g. a throwing `constructor` getter)
				if (isFatal(error)) throw error;
				step('throw', error);
			}
		};

		step('next', undefined);
		return capability.promise;
	}
}
