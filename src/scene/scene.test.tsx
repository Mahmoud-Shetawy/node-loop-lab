import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from '@testing-library/react';
import { simulate } from '@/engine';
import { usePlayerStore } from '@/player/player';
import { stateAt, type VisualState } from '@/player/visualState';
import { Narration } from '@/workbench/workbench';
import { Scene } from './scene';
import { SceneConsole } from './sceneConsole';

/** Puts the player at the first step matching `at` (or the end). */
const showStep = (code: string, at?: (view: VisualState) => boolean) => {
	const { steps } = simulate(code);
	let cursor = steps.length;
	if (at)
		for (let i = 1; i <= steps.length; i++)
			if (at(stateAt(steps, i))) {
				cursor = i;
				break;
			}
	act(() =>
		usePlayerStore.setState({
			steps,
			cursor,
			view: stateAt(steps, cursor),
			status: cursor === steps.length ? 'finished' : 'paused',
		})
	);
};

afterEach(() => act(() => usePlayerStore.getState().reset()));

describe('Scene', () => {
	it('shows the call stack, libuv, the six phases and every queue', () => {
		render(<Scene />);
		expect(screen.getByTestId('scene-callstack')).toBeInTheDocument();
		expect(screen.getByTestId('scene-libuv')).toBeInTheDocument();
		for (const phase of ['timers', 'pending', 'idle', 'poll', 'check', 'close'])
			expect(screen.getByTestId(`phase-${phase}`)).toBeInTheDocument();
		for (const queue of ['timers', 'poll', 'check', 'close'])
			expect(screen.getByTestId(`queue-${queue}`)).toBeInTheDocument();
		expect(screen.getByTestId('js-nextTick')).toBeInTheDocument();
		expect(screen.getByTestId('js-microtask')).toBeInTheDocument();
	});

	it('keeps the color of a callback when it reaches the call stack', () => {
		render(<Scene />);
		showStep(`setImmediate(function later() {})`, (v) =>
			v.queues.callstack.some((f) => f.value === 'function later() {}')
		);
		const frame = within(screen.getByTestId('js-callstack')).getByText(
			'later()'
		);
		expect(frame.closest('[data-category]')).toHaveAttribute(
			'data-category',
			'immediate'
		);
	});

	it('marks the active phase and its queue', () => {
		render(<Scene />);
		showStep(
			`setImmediate(() => {})`,
			(v) => v.phase === 'check' && v.queues.check.length === 1
		);
		expect(screen.getByTestId('phase-check')).toHaveAttribute(
			'aria-current',
			'step'
		);
		expect(screen.getByTestId('queue-check')).toHaveAttribute('data-active');
		expect(screen.getByTestId('loop-status')).toHaveTextContent('#1');
	});

	it('counts a timer down from setTimeout() and explains why it is skipped', () => {
		render(<Scene />);
		render(<Narration />);
		const code = `setTimeout(function later() {}, 5); setImmediate(() => {});`;
		showStep(code, (v) => v.phase === 'timers');
		expect(screen.getByTestId('timer-left')).toHaveTextContent('5ms left');
		expect(screen.getByTestId('loop-status')).toHaveTextContent(
			'keeping Node alive'
		);
		return waitFor(() =>
			expect(screen.getByTestId('narration')).toHaveTextContent(
				'has 5ms left, so the loop moves on'
			)
		);
	});

	it('shows the drain with nextTick first', () => {
		render(<Scene />);
		showStep(
			`setImmediate(() => { process.nextTick(() => {}); Promise.resolve().then(() => {}); })`,
			(v) => v.draining && v.queues.nextTick.length === 1
		);
		expect(screen.getByTestId('drain-badge')).toBeInTheDocument();
		expect(screen.getByTestId('js-nextTick')).toHaveAttribute('data-active');
		expect(screen.getByTestId('js-microtask')).not.toHaveAttribute(
			'data-active'
		);
	});

	it('shows busy thread pool workers and jobs waiting for one', () => {
		render(<Scene />);
		showStep(
			`const fs = require('fs'); for (let i = 0; i < 6; i++) fs.stat('file.txt', () => {});`,
			(v) => v.libuv.length === 6
		);
		expect(screen.getByTestId('libuv-threadpool')).toHaveTextContent('4/4');
		expect(
			within(screen.getByTestId('libuv-waiting')).getAllByText(/fs\.stat/)
		).toHaveLength(2);
	});

	it('shows an open handle', () => {
		render(<Scene />);
		showStep(`require('net').createServer().listen(4000, () => {})`, (v) =>
			v.libuv.some((i) => i.kind === 'handle')
		);
		expect(screen.getByTestId('libuv-handles')).toHaveTextContent(
			'TCP server :4000'
		);
	});

	it('prints the console in order with the exit code', () => {
		render(<SceneConsole />);
		showStep(`console.log('a'); setTimeout(() => console.log('b'), 1);`);
		const output = screen.getByRole('log');
		expect(output).toHaveTextContent('a');
		expect(output.textContent?.indexOf('a')).toBeLessThan(
			output.textContent?.indexOf('b') ?? -1
		);
		expect(screen.getByTestId('process-exit')).toHaveTextContent(
			'The process exited with code 0.'
		);
	});

	it('marks a crash', () => {
		render(<SceneConsole />);
		showStep(`setTimeout(() => { throw new Error('x') }, 1)`);
		expect(screen.getByText('Uncaught Error: x')).toBeInTheDocument();
		expect(screen.getByTestId('process-exit')).toHaveTextContent('crashed');
	});
});

describe('Narration', () => {
	it('names callbacks briefly and hides the internals until asked', async () => {
		render(<Narration />);
		showStep(
			`setImmediate(() => { console.log('later') })`,
			(v) => v.queues.check.length === 1
		);
		// the previous sentence fades out first
		await waitFor(() =>
			expect(screen.getByTestId('narration')).toHaveTextContent(
				"() => log('later')"
			)
		);
		expect(screen.queryByTestId('internal-calls')).toBeNull();
		fireEvent.click(screen.getByTestId('inside-toggle'));
		expect(screen.getByTestId('internal-calls')).toHaveTextContent(
			'immediateQueue.append()'
		);
	});
});
