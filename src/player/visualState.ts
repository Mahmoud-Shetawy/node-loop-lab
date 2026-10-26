import type {
	ConsoleLevel,
	ItemOrigin,
	ItemQueue,
	LibuvKind,
	Phase,
	SimStep,
} from '@/engine';
import { internalOf, type Internal } from './internals';

export interface QueueItem {
	/** unique for the whole simulation: a stable React key */
	id: number;
	value: string;
	origin: ItemOrigin;
	range?: [number, number];
	/** the same callback keeps its flow from queue to queue */
	flow?: number;
	/** what kind of callback it is: decides its color everywhere */
	category: Category;
	/**
	 * Removed by the last step but still shown for one step, so the UI can
	 * fly it to where the same flow appears next (e.g. queue -> call stack).
	 */
	leaving?: boolean;
}

/**
 * The kind of a callback. A callback keeps its category (and color) while it
 * travels, also when it reaches the call stack, so you see where it came from.
 */
export type Category =
	'timer' | 'io' | 'immediate' | 'tick' | 'promise' | 'close' | 'main' | 'call';

const CATEGORY: Record<ItemOrigin, Category> = {
	setTimeout: 'timer',
	setInterval: 'timer',
	fs: 'io',
	fsInternal: 'io',
	net: 'io',
	setImmediate: 'immediate',
	nextTick: 'tick',
	promise: 'promise',
	await: 'promise',
	thenable: 'promise',
	queueMicrotask: 'promise',
	close: 'close',
	event: 'close',
	main: 'main',
	call: 'call',
};

/** The category of a new item: inherited from its flow, else from its origin. */
const categoryFor = (
	state: VisualState,
	origin: ItemOrigin,
	flow: number | undefined,
	value: string
): Category => {
	if (flow !== undefined) {
		const all = [...state.libuv, ...Object.values(state.queues).flat()];
		const sibling = all.find((item) => item.flow === flow);
		if (sibling) return sibling.category;
	}
	if (value === 'main.js' || value === 'main.mjs') return 'main';
	return CATEGORY[origin];
};

export interface LibuvItem extends QueueItem {
	kind: LibuvKind;
	start: number;
	end?: number;
}

export interface ConsoleItem {
	id: number;
	value: string;
	level: ConsoleLevel;
}

/** A sentence explaining the last step; `key` indexes the i18n messages. */
export interface Narration {
	key: string;
	params: Record<string, string | number>;
}

export interface VisualState {
	queues: Record<ItemQueue, QueueItem[]>;
	libuv: LibuvItem[];
	console: ConsoleItem[];
	phase: Phase | null;
	iteration: number;
	/** simulated milliseconds since the process started */
	time: number;
	refs: number;
	/** nextTick + microtask queues are being drained */
	draining: boolean;
	/** the poll phase is blocked until this time */
	waiting: { until: number; reason: 'timer' | 'io' } | null;
	moduleType: 'commonjs' | 'esm';
	narration: Narration | null;
	/** what Node does internally for the last step */
	internal: Internal | null;
	end: { exitCode: number; truncated: boolean; crashed: boolean } | null;
}

const EMPTY_QUEUES: Record<ItemQueue, QueueItem[]> = {
	callstack: [],
	nextTick: [],
	microtask: [],
	timers: [],
	pending: [],
	poll: [],
	check: [],
	close: [],
};

export const initialState: VisualState = {
	queues: EMPTY_QUEUES,
	libuv: [],
	console: [],
	phase: null,
	iteration: 0,
	time: 0,
	refs: 0,
	draining: false,
	waiting: null,
	moduleType: 'commonjs',
	narration: null,
	internal: null,
	end: null,
};

const labelOf = (state: VisualState, id: number) => {
	for (const queue of Object.values(state.queues)) {
		const item = queue.find((i) => i.id === id);
		if (item) return item.value;
	}
	return state.libuv.find((i) => i.id === id)?.value ?? '';
};

const PUSH_NARRATION: Partial<
	Record<ItemQueue, Partial<Record<ItemOrigin, string>>>
> = {
	nextTick: { nextTick: 'queueNextTick' },
	microtask: {
		promise: 'queuePromise',
		await: 'queueAwait',
		thenable: 'queueThenable',
		queueMicrotask: 'queueMicrotask',
	},
	timers: { setTimeout: 'timerExpired', setInterval: 'timerExpired' },
	poll: { fs: 'ioDone', fsInternal: 'ioStageDone' },
	check: { setImmediate: 'queueImmediate' },
	close: { close: 'queueClose' },
};

const SHIFT_NARRATION: Partial<Record<ItemQueue, string>> = {
	nextTick: 'runNextTick',
	microtask: 'runMicrotask',
	timers: 'runTimer',
	poll: 'runIo',
	check: 'runImmediate',
	close: 'runClose',
};

/** Explains a step in words; null for steps that need no sentence. */
export const narrate = (
	state: VisualState,
	step: SimStep
): Narration | null => {
	switch (step.type) {
		case 'start':
			return {
				key: step.moduleType === 'esm' ? 'startEsm' : 'start',
				params: {},
			};
		case 'phase': {
			if (step.phase === 'main') return { key: 'phase.main', params: {} };
			const params = { iteration: step.iteration, refs: step.refs };
			if (step.phase !== 'timers')
				return { key: `phase.${step.phase}`, params };
			// a timer counts from setTimeout(), but runs only once it has expired
			const next = state.libuv
				.filter((item) => item.kind === 'timer' && item.end !== undefined)
				.sort((a, b) => (a.end ?? 0) - (b.end ?? 0))[0];
			if (!next) return { key: 'phase.timersNone', params };
			if ((next.end ?? 0) > step.time)
				return {
					key: 'phase.timersNotYet',
					params: {
						...params,
						value: next.value,
						ms: (next.end ?? 0) - step.time,
					},
				};
			return { key: 'phase.timers', params };
		}
		case 'drain':
			return { key: 'drain', params: {} };
		case 'wait':
			return {
				key: step.reason === 'io' ? 'waitIo' : 'waitTimer',
				params: { ms: step.until - step.time, until: step.until },
			};
		case 'end':
			return {
				key: step.truncated
					? 'endTruncated'
					: step.crashed
						? 'endCrashed'
						: 'end',
				params: { code: step.exitCode },
			};
		case 'push': {
			const params = { value: step.value };
			if (step.queue === 'console') return { key: 'log', params };
			if (step.queue === 'callstack') return { key: 'call', params };
			if (step.queue === 'libuv') {
				if (step.kind === 'timer')
					return {
						key: 'timerStart',
						params: { ...params, delay: (step.end ?? 0) - step.start },
					};
				if (step.kind === 'handle') return { key: 'handleOpen', params };
				return step.start > step.time
					? {
							key: 'threadpoolQueued',
							params: { ...params, start: step.start },
						}
					: { key: 'threadpoolStart', params };
			}
			const key = PUSH_NARRATION[step.queue]?.[step.origin];
			return key ? { key, params } : null;
		}
		case 'shift': {
			const key = SHIFT_NARRATION[step.queue];
			return key ? { key, params: { value: labelOf(state, step.id) } } : null;
		}
		case 'delete':
			if (step.reason !== 'cancelled') return null;
			return {
				key: step.queue === 'check' ? 'immediateCancelled' : 'timerCancelled',
				params: { value: labelOf(state, step.id) },
			};
		default:
			return null;
	}
};

const MACROTASK_QUEUES = new Set<ItemQueue>([
	'timers',
	'pending',
	'poll',
	'check',
	'close',
]);

/** Items still waiting or running (not the ones flying out). */
export const present = <T extends { leaving?: boolean }>(items: T[]) =>
	items.filter((item) => !item.leaving);

const markLeaving = <T extends { id: number; leaving?: boolean }>(
	items: T[],
	id: number
) => items.map((item) => (item.id === id ? { ...item, leaving: true } : item));

/** Items marked as leaving by the previous step are gone now. */
const settle = (state: VisualState): VisualState => {
	const hasLeaving =
		state.libuv.some((i) => i.leaving) ||
		Object.values(state.queues).some((q) => q.some((i) => i.leaving));
	if (!hasLeaving) return state;
	return {
		...state,
		libuv: present(state.libuv),
		queues: Object.fromEntries(
			Object.entries(state.queues).map(([name, items]) => [
				name,
				present(items),
			])
		) as VisualState['queues'],
	};
};

/** Applies one step. Pure: replaying the same steps gives the same state. */
export const reduce = (previous: VisualState, step: SimStep): VisualState => {
	const narration = narrate(previous, step) ?? previous.narration;
	const internal = internalOf(previous, step) ?? previous.internal;
	const state = settle(previous);
	const next: VisualState = {
		...state,
		time: step.time,
		narration,
		internal,
		// "poll is waiting" describes only the wait step itself
		waiting: null,
		// the drain ends when the loop takes the next macrotask
		draining:
			state.draining &&
			!(step.type === 'shift' && MACROTASK_QUEUES.has(step.queue)),
	};

	switch (step.type) {
		case 'start':
			return { ...next, moduleType: step.moduleType };
		case 'phase':
			return {
				...next,
				phase: step.phase,
				iteration: step.iteration,
				refs: step.refs,
				draining: false,
				waiting: null,
			};
		case 'drain':
			return { ...next, draining: true };
		case 'wait':
			return { ...next, waiting: { until: step.until, reason: step.reason } };
		case 'end':
			return {
				...next,
				phase: null,
				draining: false,
				waiting: null,
				refs: step.truncated ? state.refs : 0,
				end: {
					exitCode: step.exitCode,
					truncated: step.truncated,
					crashed: step.crashed,
				},
			};
		case 'push': {
			if (step.queue === 'console')
				return {
					...next,
					console: [
						...state.console,
						{ id: step.id, value: step.value, level: step.level },
					],
				};
			if (step.queue === 'libuv')
				return {
					...next,
					libuv: [
						...state.libuv,
						{
							id: step.id,
							value: step.value,
							origin: step.origin,
							range: step.range,
							kind: step.kind,
							start: step.start,
							end: step.end,
							flow: step.flow,
							category: categoryFor(
								previous,
								step.origin,
								step.flow,
								step.value
							),
						},
					],
				};
			const item: QueueItem = {
				id: step.id,
				value: step.value,
				origin: step.origin,
				range: step.range,
				flow: step.flow,
				// read before settle() dropped the leaving sibling
				category: categoryFor(previous, step.origin, step.flow, step.value),
			};
			return {
				...next,
				queues: {
					...state.queues,
					[step.queue]: [...state.queues[step.queue], item],
				},
			};
		}
		case 'pop':
		case 'shift':
		case 'delete': {
			if (step.queue === 'libuv')
				return { ...next, libuv: markLeaving(state.libuv, step.id) };
			return {
				...next,
				queues: {
					...state.queues,
					[step.queue]: markLeaving(state.queues[step.queue], step.id),
				},
			};
		}
	}
};

/** State after the first `count` steps. */
export const stateAt = (steps: SimStep[], count: number) =>
	steps.slice(0, count).reduce(reduce, initialState);

/** The state with nothing in flight: what the program state really is. */
export const settled = settle;
