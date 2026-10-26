/**
 * Node.js event loop phases, in the order libuv runs them
 * (https://nodejs.org/en/learn/asynchronous-work/event-loop-timers-and-nexttick).
 * `main` is the synchronous run of the entry script, before the loop starts.
 */
export const PHASES = [
	'timers',
	'pending',
	'idle',
	'poll',
	'check',
	'close',
] as const;

export type LoopPhase = (typeof PHASES)[number];
export type Phase = 'main' | LoopPhase;

/** Queues whose items wait for (or are inside) the JavaScript thread. */
export type ItemQueue =
	| 'callstack'
	| 'nextTick'
	| 'microtask'
	| 'timers'
	| 'pending'
	| 'poll'
	| 'check'
	| 'close';

export type ConsoleLevel = 'log' | 'info' | 'debug' | 'warn' | 'error';

/** Why an item exists. The UI uses it to explain each step. */
export type ItemOrigin =
	| 'main'
	| 'call'
	| 'setTimeout'
	| 'setInterval'
	| 'setImmediate'
	| 'nextTick'
	| 'queueMicrotask'
	| 'promise'
	| 'await'
	| 'thenable'
	| 'fs'
	/** an intermediate syscall of an fs call (e.g. open done, now fstat) */
	| 'fsInternal'
	/** a socket event reported by the kernel (connect, accept, EOF) */
	| 'net'
	| 'close'
	| 'event';

/** Work libuv tracks outside the JavaScript thread. */
export type LibuvKind = 'timer' | 'threadpool' | 'handle' | 'network';

/**
 * One atomic change of the visualised state. Every item id is unique for
 * the whole simulation, so equal labels never collide.
 */
export type SimStep =
	| { type: 'start'; time: number; moduleType: 'commonjs' | 'esm' }
	/** The loop enters a phase (`iteration` is 0 for the main module). */
	| {
			type: 'phase';
			phase: Phase;
			iteration: number;
			time: number;
			/**
			 * Active refs: timers, I/O requests, immediates and open handles that
			 * keep the process alive. The loop stops when this reaches 0.
			 */
			refs: number;
	  }
	/** nextTick + microtask queues are drained after a callback. */
	| { type: 'drain'; time: number }
	/** The poll phase blocks: nothing to run until `until`. */
	| {
			type: 'wait';
			time: number;
			until: number;
			reason: 'timer' | 'io';
	  }
	| {
			type: 'push';
			queue: ItemQueue;
			time: number;
			id: number;
			value: string;
			origin: ItemOrigin;
			range?: [number, number];
			/**
			 * The same callback keeps its flow id while it travels: libuv timer
			 * -> timers queue -> call stack frame. The UI animates it along.
			 */
			flow?: number;
	  }
	| {
			type: 'push';
			queue: 'libuv';
			time: number;
			id: number;
			value: string;
			origin: ItemOrigin;
			kind: LibuvKind;
			/** when the work started (a thread pool job may wait for a worker) */
			start: number;
			/** when it completes; undefined for handles that stay open */
			end?: number;
			range?: [number, number];
			flow?: number;
	  }
	| {
			type: 'push';
			queue: 'console';
			time: number;
			id: number;
			value: string;
			level: ConsoleLevel;
	  }
	/** `pop` removes the newest item (stack), `shift` the oldest (queue). */
	| { type: 'pop' | 'shift'; queue: ItemQueue; time: number; id: number }
	/** Removes an item wherever it is. */
	| {
			type: 'delete';
			queue: ItemQueue | 'libuv';
			time: number;
			id: number;
			reason: 'done' | 'cancelled';
	  }
	| {
			type: 'end';
			time: number;
			exitCode: number;
			/** the program never stops scheduling work and was cut short */
			truncated: boolean;
			/** the process crashed on an uncaught error */
			crashed: boolean;
	  };

export type SimPushStep = Extract<SimStep, { type: 'push' }>;
