import { act } from '@testing-library/react';
import { consoleOutput, simulate } from '@/engine';
import { usePlayerStore, stepDelay } from './player';
import { initialState, narrate, reduce, stateAt } from './visualState';

const IO_PUZZLE = `const fs = require('fs');
fs.readFile('file.txt', () => {
  setTimeout(() => console.log('timeout'), 0);
  setImmediate(() => console.log('immediate'));
  process.nextTick(() => console.log('tick'));
});`;

describe('reduce', () => {
	it('ends with every queue empty and the console filled', () => {
		const { steps } = simulate(IO_PUZZLE);
		const state = stateAt(steps, steps.length);
		expect(state.console.map((c) => c.value)).toEqual(consoleOutput(steps));
		expect(Object.values(state.queues).every((q) => q.length === 0)).toBe(true);
		expect(state.libuv).toEqual([]);
		expect(state.end).toEqual({
			exitCode: 0,
			truncated: false,
			crashed: false,
		});
		expect(state.refs).toBe(0);
	});

	it('is pure: replaying gives the same state', () => {
		const { steps } = simulate(IO_PUZZLE);
		const half = Math.floor(steps.length / 2);
		expect(stateAt(steps, half)).toEqual(stateAt(steps, half));
	});

	it('tracks phase, iteration, draining and waiting', () => {
		const { steps } = simulate(`setTimeout(() => {}, 30)`);
		const states = steps.map((_, i) => stateAt(steps, i + 1));
		expect(states.some((s) => s.phase === 'timers' && s.iteration === 1)).toBe(
			true
		);
		expect(states.some((s) => s.waiting?.until === 30)).toBe(true);
		const { steps: tickSteps } = simulate(`process.nextTick(() => {})`);
		expect(
			tickSteps.map((_, i) => stateAt(tickSteps, i + 1)).some((s) => s.draining)
		).toBe(true);
	});

	it('clears draining when the next macrotask starts, waiting after the wait', () => {
		const { steps } = simulate(
			`setTimeout(() => process.nextTick(() => {}), 1); setTimeout(() => {}, 1); setTimeout(() => {}, 30);`
		);
		for (let i = 1; i <= steps.length; i++) {
			const step = steps[i - 1];
			const state = stateAt(steps, i);
			if (step.type === 'shift' && step.queue === 'timers')
				expect(state.draining).toBe(false);
			if (step.type !== 'wait') expect(state.waiting).toBeNull();
		}
	});

	it('keeps the stack of frames with their source ranges', () => {
		const { steps } = simulate(`function a() { console.log(1); } a();`);
		const deepest = steps
			.map((_, i) => stateAt(steps, i + 1).queues.callstack)
			.reduce((a, b) => (b.length > a.length ? b : a));
		expect(deepest.map((f) => f.value)).toEqual([
			'main.js',
			'a()',
			'console.log(1)',
		]);
		expect(deepest[1].range).toEqual([33, 36]);
	});
});

describe('narrate', () => {
	it('describes the important steps', () => {
		const { steps } = simulate(IO_PUZZLE);
		let state = initialState;
		const keys = new Set<string>();
		for (const step of steps) {
			const narration = narrate(state, step);
			if (narration) keys.add(narration.key);
			state = reduce(state, step);
		}
		expect([...keys]).toEqual(
			expect.arrayContaining([
				'start',
				'phase.main',
				'phase.timers',
				'phase.poll',
				'phase.check',
				'threadpoolStart',
				'ioStageDone',
				'ioDone',
				'runIo',
				'drain',
				'runNextTick',
				'queueImmediate',
				'runImmediate',
				'timerStart',
				'timerExpired',
				'runTimer',
				'log',
				'end',
			])
		);
	});

	it('names the callback that is about to run', () => {
		const { steps } = simulate(`setImmediate(function hi() {})`);
		const index = steps.findIndex(
			(s) => s.type === 'shift' && s.queue === 'check'
		);
		expect(narrate(stateAt(steps, index), steps[index])).toEqual({
			key: 'runImmediate',
			params: { value: 'function hi() {}' },
		});
	});
});

describe('usePlayerStore', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		act(() => usePlayerStore.getState().reset());
	});
	afterEach(() => vi.useRealTimers());

	it('steps forward and back exactly', async () => {
		const player = usePlayerStore.getState();
		expect(await player.load(`console.log('a'); console.log('b');`)).toBe(true);
		act(() => {
			player.next();
			player.next();
			player.next();
		});
		const after3 = usePlayerStore.getState().view;
		act(() => {
			player.next();
			player.back();
		});
		expect(usePlayerStore.getState().cursor).toBe(3);
		expect(usePlayerStore.getState().view).toEqual(after3);
	});

	it('plays to the end and stops', async () => {
		const player = usePlayerStore.getState();
		await player.load(`setTimeout(() => console.log('done'), 5)`);
		act(() => player.play());
		await act(async () => {
			await vi.runAllTimersAsync();
		});
		const state = usePlayerStore.getState();
		expect(state.status).toBe('finished');
		expect(state.cursor).toBe(state.steps.length);
		expect(state.view.console.map((c) => c.value)).toEqual(['done']);
	});

	it('restarts a finished run from the first step and plays it again', async () => {
		const player = usePlayerStore.getState();
		await player.load(`setTimeout(() => console.log('done'), 5)`);
		act(() => player.play());
		await act(async () => {
			await vi.runAllTimersAsync();
		});
		const steps = usePlayerStore.getState().steps;
		act(() => player.restart());
		// playing takes the first step at once, like play() does
		expect(usePlayerStore.getState()).toMatchObject({
			cursor: 1,
			status: 'playing',
		});
		expect(usePlayerStore.getState().view.console).toEqual([]);
		await act(async () => {
			await vi.runAllTimersAsync();
		});
		const state = usePlayerStore.getState();
		// the same simulation, not a new one
		expect(state.steps).toBe(steps);
		expect(state.status).toBe('finished');
		expect(state.view.console.map((c) => c.value)).toEqual(['done']);
	});

	it('pause stops the autoplay', async () => {
		const player = usePlayerStore.getState();
		await player.load(`console.log(1)`);
		act(() => {
			player.play();
			player.pause();
		});
		const cursor = usePlayerStore.getState().cursor;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_000);
		});
		expect(usePlayerStore.getState().cursor).toBe(cursor);
		expect(usePlayerStore.getState().status).toBe('paused');
	});

	it('reports engine errors with their position', async () => {
		expect(await usePlayerStore.getState().load('console.log(')).toBe(false);
		const { error, status } = usePlayerStore.getState();
		expect(status).toBe('idle');
		expect(error).toMatchObject({ code: 'syntax', params: { line: 1 } });
		expect(error?.range).toBeDefined();
	});

	it('ignores a slower load that a newer one replaced', async () => {
		const player = usePlayerStore.getState();
		const first = player.load(`console.log('first')`);
		const second = player.load(`console.log('second')`);
		expect(await first).toBe(false);
		expect(await second).toBe(true);
		act(() => usePlayerStore.getState().next());
		const values = usePlayerStore
			.getState()
			.steps.flatMap((s) =>
				s.type === 'push' && s.queue === 'console' ? [s.value] : []
			);
		expect(values).toEqual(['second']);
	});

	it('runs faster at higher speed', () => {
		expect(
			stepDelay({
				type: 'phase',
				phase: 'idle',
				iteration: 1,
				time: 0,
				refs: 1,
			})
		).toBeLessThan(
			stepDelay({
				type: 'phase',
				phase: 'poll',
				iteration: 1,
				time: 0,
				refs: 1,
			})
		);
	});
});
