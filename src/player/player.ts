import { create } from 'zustand';
import { EngineError, type EngineErrorCode, type SimStep } from '@/engine';
import { runSimulation } from '@/engine/client';
import { initialState, reduce, stateAt, type VisualState } from './visualState';

export type PlayerStatus =
	'idle' | 'loading' | 'playing' | 'paused' | 'finished';

export interface PlayerError {
	code: EngineErrorCode;
	params: Record<string, string | number>;
	range?: [number, number];
}

interface PlayerState {
	steps: SimStep[];
	/** number of steps applied to `view` */
	cursor: number;
	view: VisualState;
	status: PlayerStatus;
	/** 0.25 .. 4 */
	speed: number;
	error: PlayerError | null;
	/** Runs the simulation; resolves false (and sets `error`) when it can't. */
	load(code: string): Promise<boolean>;
	play(): void;
	pause(): void;
	/** One step forward / back (pauses autoplay). */
	next(): void;
	back(): void;
	/** The same run again from its first step, playing. */
	restart(): void;
	/** Back to the editor. */
	reset(): void;
	setSpeed(speed: number): void;
	clearError(): void;
}

/** Base pause after a step at speed x1, in ms. */
export const stepDelay = (step: SimStep): number => {
	switch (step.type) {
		case 'phase':
			// empty housekeeping phases go by quickly
			return step.phase === 'pending' || step.phase === 'idle' ? 350 : 700;
		case 'pop':
			return 250;
		case 'start':
			return 300;
		case 'wait':
			return 900;
		default:
			return 650;
	}
};

let timer: ReturnType<typeof setTimeout> | undefined;
/** identifies the latest load(), so a slower older one can't overwrite it */
let loadRequest = 0;
const stopTimer = () => {
	clearTimeout(timer);
	timer = undefined;
};

export const usePlayerStore = create<PlayerState>((set, get) => {
	const advance = () => {
		const { steps, cursor, view } = get();
		if (cursor >= steps.length) return false;
		const nextView = reduce(view, steps[cursor]);
		const done = cursor + 1 >= steps.length;
		set({
			cursor: cursor + 1,
			view: nextView,
			...(done && { status: 'finished' }),
		});
		return !done;
	};

	const tick = () => {
		const { status, steps, cursor, speed } = get();
		if (status !== 'playing') return;
		const more = advance();
		if (!more) return;
		timer = setTimeout(tick, stepDelay(steps[cursor]) / speed);
	};

	return {
		steps: [],
		cursor: 0,
		view: initialState,
		status: 'idle',
		speed: 1,
		error: null,

		load: async (code) => {
			stopTimer();
			const request = ++loadRequest;
			set({
				steps: [],
				cursor: 0,
				view: initialState,
				status: 'loading',
				error: null,
			});
			try {
				const { steps } = await runSimulation(code);
				// a newer RUN or a reset happened while this one was computing
				if (request !== loadRequest) return false;
				set({
					steps,
					cursor: 0,
					view: initialState,
					status: 'paused',
					error: null,
				});
				return true;
			} catch (error) {
				if (request !== loadRequest) return false;
				const engineError =
					error instanceof EngineError
						? error
						: new EngineError('internal', String(error), {
								message: String(error),
							});
				set({
					steps: [],
					cursor: 0,
					view: initialState,
					status: 'idle',
					error: {
						code: engineError.code,
						params: engineError.params,
						range: engineError.range,
					},
				});
				return false;
			}
		},

		play: () => {
			const { status } = get();
			if (status !== 'paused') return;
			set({ status: 'playing' });
			stopTimer();
			tick();
		},

		pause: () => {
			stopTimer();
			if (get().status === 'playing') set({ status: 'paused' });
		},

		next: () => {
			stopTimer();
			const { status } = get();
			if (status !== 'paused' && status !== 'playing') return;
			set({ status: 'paused' });
			advance();
		},

		back: () => {
			stopTimer();
			const { steps, cursor, status } = get();
			if (status === 'idle' || status === 'loading' || cursor === 0) return;
			set({
				cursor: cursor - 1,
				view: stateAt(steps, cursor - 1),
				status: 'paused',
			});
		},

		restart: () => {
			stopTimer();
			const { steps, status } = get();
			if (status === 'idle' || status === 'loading') return;
			set({ cursor: 0, view: stateAt(steps, 0), status: 'playing' });
			tick();
		},

		reset: () => {
			stopTimer();
			loadRequest++;
			set({ steps: [], cursor: 0, view: initialState, status: 'idle' });
		},

		setSpeed: (speed) => set({ speed }),
		clearError: () => set({ error: null }),
	};
});
