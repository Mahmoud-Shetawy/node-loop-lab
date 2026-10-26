import type { ItemQueue, SimStep } from '@/engine';
import type { VisualState } from './visualState';

/**
 * Where a step happens inside Node.js, and which real functions do it.
 * Names follow the Node.js 22 / libuv 1.4x sources (lib/internal/timers.js,
 * lib/internal/process/task_queues.js, src/api/callback.cc, src/unix/core.c,
 * src/threadpool.c), simplified to the calls that matter for the loop.
 */
export type Layer = 'js' | 'cpp' | 'libuv' | 'os';

export interface Internal {
	/** layers involved, top (JavaScript) to bottom (kernel) */
	layers: Layer[];
	/** the call chain, e.g. "uv_run() → uv__run_timers()" */
	calls: string;
}

/** libuv function behind each fs syscall stage (see FS_STAGES). */
const UV_FS: Record<string, string> = {
	open: 'uv_fs_open',
	fstat: 'uv_fs_fstat',
	read: 'uv_fs_read',
	write: 'uv_fs_write',
	close: 'uv_fs_close',
	stat: 'uv_fs_stat',
	access: 'uv_fs_access',
	scandir: 'uv_fs_scandir',
	unlink: 'uv_fs_unlink',
};

/** `fs.readFile('a') · open` -> `open`; single-stage calls by their name. */
const syscallOf = (label: string) => {
	const stage = label.split(' · ')[1];
	if (stage) return stage;
	const method = /fs(?:\.promises)?\.(\w+)/.exec(label)?.[1] ?? '';
	return method === 'readdir' ? 'scandir' : method;
};

/** Which queue a flow currently waits in (before it is called). */
const queueOfFlow = (state: VisualState, flow: number | undefined) => {
	if (flow === undefined) return null;
	for (const [queue, items] of Object.entries(state.queues) as [
		ItemQueue,
		VisualState['queues'][ItemQueue],
	][])
		if (queue !== 'callstack' && items.some((i) => i.flow === flow))
			return queue;
	return null;
};

/** How Node calls back into JavaScript from each queue. */
const CALLBACK_FROM: Partial<Record<ItemQueue, Internal>> = {
	timers: {
		layers: ['libuv', 'cpp', 'js'],
		calls:
			'uv__run_timers() → RunTimers() → processTimers() → listOnTimeout() → timer._onTimeout()',
	},
	poll: {
		layers: ['libuv', 'cpp', 'js'],
		calls:
			'uv__work_done() → FSReqCallback::Resolve() → MakeCallback() → req.oncomplete()',
	},
	check: {
		layers: ['libuv', 'cpp', 'js'],
		calls:
			'uv__run_check() → CheckImmediate() → processImmediate() → immediate._onImmediate()',
	},
	close: {
		layers: ['libuv', 'cpp', 'js'],
		calls:
			"uv__run_closing_handles() → handle close_cb → MakeCallback() → emit('close')",
	},
	nextTick: {
		layers: ['js'],
		calls: 'processTicksAndRejections() → tock.callback()',
	},
	microtask: {
		layers: ['js'],
		calls:
			'MicrotaskQueue::PerformCheckpoint() → PromiseReactionJob → handler()',
	},
};

/** Explains a step in terms of Node's internals; null keeps the previous one. */
export const internalOf = (
	state: VisualState,
	step: SimStep
): Internal | null => {
	switch (step.type) {
		case 'start':
			return {
				layers: ['cpp', 'libuv', 'js'],
				calls:
					step.moduleType === 'esm'
						? 'node::Start() → uv_default_loop() → ModuleWrap::Evaluate(main.mjs)'
						: "node::Start() → uv_default_loop() → Module._load('main.js')",
			};
		case 'phase':
			switch (step.phase) {
				case 'main':
					return {
						layers: ['js'],
						calls: 'V8 runs the module code, top to bottom',
					};
				case 'timers':
					return {
						layers: ['libuv'],
						calls: 'uv_run() → uv__update_time() → uv__run_timers()',
					};
				case 'pending':
					return { layers: ['libuv'], calls: 'uv__run_pending()' };
				case 'idle':
					return {
						layers: ['libuv'],
						calls: 'uv__run_idle() → uv__run_prepare()',
					};
				case 'poll':
					return {
						layers: ['libuv', 'os'],
						calls:
							'uv_backend_timeout() → uv__io_poll() → epoll_wait() / kevent()',
					};
				case 'check':
					return { layers: ['libuv'], calls: 'uv__run_check()' };
				case 'close':
					return { layers: ['libuv'], calls: 'uv__run_closing_handles()' };
			}
			break;
		case 'drain':
			return {
				layers: ['cpp', 'js'],
				calls:
					'InternalCallbackScope::Close() → processTicksAndRejections() → runMicrotasks()',
			};
		case 'wait':
			return {
				layers: ['libuv', 'os'],
				calls: `uv__io_poll() → epoll_wait(epfd, events, timeout = ${step.until - step.time}ms)  // the thread sleeps`,
			};
		case 'end':
			return step.crashed
				? {
						layers: ['cpp', 'js'],
						calls: `process._fatalException() → exit(${step.exitCode})`,
					}
				: {
						layers: ['libuv', 'cpp', 'js'],
						calls: `uv_run() returns (no active handles) → process.emit('exit') → exit(${step.exitCode})`,
					};
		case 'push': {
			if (step.queue === 'console')
				return {
					layers: ['js', 'os'],
					calls: 'console.log() → process.stdout.write() → write(1, …)',
				};
			if (step.queue === 'callstack') {
				// a callback the loop calls (it has a flow) vs a plain call
				const from = queueOfFlow(state, step.flow);
				const callback = from ? CALLBACK_FROM[from] : undefined;
				if (callback) return callback;
				if (step.value === 'main.js' || step.value === 'main.mjs')
					return { layers: ['js'], calls: 'V8: Script::Run()' };
				return { layers: ['js'], calls: `V8: call ${step.value}` };
			}
			if (step.queue === 'libuv') {
				if (step.kind === 'timer')
					return {
						layers: ['js', 'cpp', 'libuv'],
						calls: `timers.js insert() → binding.scheduleTimer() → uv_timer_start(${(step.end ?? 0) - step.start}ms)`,
					};
				if (step.kind === 'handle')
					return {
						layers: ['cpp', 'libuv', 'os'],
						calls: 'TCPWrap::Listen() → uv_listen() → listen(fd)',
					};
				const syscall = syscallOf(step.value);
				const uv = UV_FS[syscall] ?? 'uv_fs_*';
				return {
					layers: ['cpp', 'libuv', 'os'],
					calls:
						step.start > step.time
							? `${uv}() → uv__work_submit() // all 4 workers busy: waits in the work queue`
							: `${uv}() → uv__work_submit() → worker thread: ${syscall}()`,
				};
			}
			switch (step.queue) {
				case 'nextTick':
					return {
						layers: ['js'],
						calls:
							'process.nextTick() → queue.push(tock) → setHasTickScheduled(true)',
					};
				case 'microtask':
					return {
						layers: ['js'],
						calls:
							step.origin === 'queueMicrotask'
								? 'queueMicrotask() → V8 EnqueueMicrotask(callback)'
								: step.origin === 'await'
									? 'V8 Await() → PerformPromiseThen() → EnqueueMicrotask(job)'
									: 'V8 TriggerPromiseReactions() → EnqueueMicrotask(PromiseReactionJob)',
					};
				case 'timers':
					return {
						layers: ['libuv'],
						calls: 'uv__run_timers(): expiry <= loop->time → the timer is due',
					};
				case 'poll':
					return {
						layers: ['os', 'libuv'],
						calls:
							step.origin === 'fsInternal'
								? `worker: ${syscallOf(step.value.split(':')[1] ?? '')}() done → uv_async_send() → uv__io_poll() wakes up`
								: 'worker done → uv_async_send() → uv__io_poll() → uv__work_done()',
					};
				case 'check':
					return {
						layers: ['js', 'cpp', 'libuv'],
						calls:
							'setImmediate() → immediateQueue.append() → uv_idle_start() // poll must not block',
					};
				case 'close':
					return {
						layers: ['cpp', 'libuv'],
						calls: 'HandleWrap::Close() → uv_close() → loop->closing_handles',
					};
			}
			return null;
		}
		case 'shift':
			return CALLBACK_FROM[step.queue] ?? null;
		case 'delete':
			if (step.reason !== 'cancelled') return null;
			return step.queue === 'check'
				? {
						layers: ['js'],
						calls: 'clearImmediate() → immediateQueue.remove()',
					}
				: {
						layers: ['js', 'cpp', 'libuv'],
						calls:
							'clearTimeout() → unenroll() → binding.scheduleTimer() / uv_timer_stop()',
					};
		default:
			return null;
	}
	return null;
};
