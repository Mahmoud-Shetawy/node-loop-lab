import { simulate } from '@/engine';
import { initialState, reduce } from './visualState';
import { internalOf } from './internals';

/** Every internal call chain of a program, in order. */
const chains = (code: string) => {
	let state = initialState;
	const result: string[] = [];
	for (const step of simulate(code).steps) {
		const internal = internalOf(state, step);
		if (internal) result.push(internal.calls);
		state = reduce(state, step);
	}
	return result;
};

describe('internalOf', () => {
	it('follows a timer from setTimeout to its callback', () => {
		const calls = chains(`setTimeout(function done() {}, 5)`);
		expect(calls).toEqual(
			expect.arrayContaining([
				expect.stringContaining('uv_timer_start(5ms)'),
				expect.stringContaining('epoll_wait(epfd, events, timeout = 5ms)'),
				expect.stringContaining('uv__run_timers(): expiry <= loop->time'),
				expect.stringContaining('listOnTimeout() → timer._onTimeout()'),
			])
		);
	});

	it('names every libuv fs function of a file read', () => {
		const calls = chains(`require('fs').readFile('file.txt', () => {})`).join(
			'\n'
		);
		for (const fn of ['uv_fs_open', 'uv_fs_fstat', 'uv_fs_read', 'uv_fs_close'])
			expect(calls).toContain(fn);
		expect(calls).toContain('uv_async_send()');
		expect(calls).toContain(
			'FSReqCallback::Resolve() → MakeCallback() → req.oncomplete()'
		);
	});

	it('explains nextTick, Promises and the drain', () => {
		const calls = chains(
			`process.nextTick(() => {}); Promise.resolve().then(() => {}); queueMicrotask(() => {});`
		).join('\n');
		expect(calls).toContain('process.nextTick() → queue.push(tock)');
		expect(calls).toContain('EnqueueMicrotask(PromiseReactionJob)');
		expect(calls).toContain('queueMicrotask() → V8 EnqueueMicrotask(callback)');
		expect(calls).toContain(
			'InternalCallbackScope::Close() → processTicksAndRejections()'
		);
		expect(calls).toContain('MicrotaskQueue::PerformCheckpoint()');
	});

	it('explains the end of the process and a crash', () => {
		expect(chains(`console.log(1)`).at(-1)).toContain('uv_run() returns');
		expect(chains(`setTimeout(() => { throw 1 }, 1)`).at(-1)).toContain(
			'process._fatalException() → exit(1)'
		);
	});

	it('says when a thread pool job waits for a worker', () => {
		const calls = chains(
			`const fs = require('fs'); for (let i = 0; i < 5; i++) fs.stat('file.txt', () => {});`
		).join('\n');
		expect(calls).toContain('all 4 workers busy');
	});
});

describe('flows', () => {
	it('a timer keeps one flow from libuv to the timers queue to the call stack', () => {
		const { steps } = simulate(`setTimeout(function done() {}, 5)`);
		const places = steps.flatMap((s) =>
			s.type === 'push' &&
			s.queue !== 'console' &&
			s.value === 'function done() {}'
				? [{ queue: s.queue, flow: s.flow }]
				: []
		);
		expect(places.map((p) => p.queue)).toEqual([
			'libuv',
			'timers',
			'callstack',
		]);
		expect(new Set(places.map((p) => p.flow)).size).toBe(1);
		expect(places[0].flow).toBeDefined();
	});

	it('keeps a leaving card for exactly one step', () => {
		const { steps } = simulate(`setImmediate(function later() {})`);
		let state = initialState;
		for (const step of steps) {
			state = reduce(state, step);
			if (step.type === 'shift' && step.queue === 'check') {
				expect(state.queues.check[0]?.leaving).toBe(true);
			}
			if (
				step.type === 'push' &&
				step.queue === 'callstack' &&
				step.value.includes('later')
			)
				expect(state.queues.check).toEqual([]);
		}
	});
});
