import { useEffect } from 'react';
import {
	Pause,
	Pencil,
	Play,
	RotateCcw,
	StepBack,
	StepForward,
} from 'lucide-react';
import { marks } from '@/editor/marks';
import { EXAMPLE_KEYS, type ExampleKey } from '@/examples';
import { useI18n } from '@/i18n';
import { usePlayerStore } from '@/player/player';
import { Button } from '@/ui/button';

/** Playback speeds offered by the slider, slowest first. */
const SPEEDS = [0.25, 0.5, 1, 2, 4];

/** Keyboard shortcuts while a simulation is loaded (not while typing). */
function useShortcuts() {
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			const player = usePlayerStore.getState();
			if (
				player.status === 'idle' ||
				player.status === 'loading' ||
				event.metaKey ||
				event.ctrlKey ||
				event.altKey
			)
				return;
			const target = event.target instanceof Element ? event.target : null;
			if (target?.closest('input, select, textarea, [contenteditable]')) return;
			// "forward" follows the reading direction
			const rtl = document.documentElement.dir === 'rtl';
			const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
			const backward = rtl ? 'ArrowRight' : 'ArrowLeft';
			if (event.key === forward) player.next();
			else if (event.key === backward) player.back();
			else if (event.key === 'Home') player.restart();
			else if (event.key === ' ' && !target?.closest('button')) {
				if (player.status === 'playing') player.pause();
				else player.play();
			} else return;
			event.preventDefault();
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, []);
}

interface PlayerControlsProps {
	code: string;
	example: ExampleKey;
	onExample(key: ExampleKey): void;
}

export function PlayerControls({
	code,
	example,
	onExample,
}: PlayerControlsProps) {
	const status = usePlayerStore((state) => state.status);
	const speed = usePlayerStore((state) => state.speed);
	const cursor = usePlayerStore((state) => state.cursor);
	const total = usePlayerStore((state) => state.steps.length);
	const player = usePlayerStore.getState();
	const { m, format, dir } = useI18n();
	useShortcuts();

	const run = async () => {
		marks.setSource(code);
		marks.clear();
		// the editor locks while playing: give the arrow keys to the player
		if (document.activeElement instanceof HTMLElement)
			document.activeElement.blur();
		const store = usePlayerStore.getState();
		if (await store.load(code)) usePlayerStore.getState().play();
		else {
			const range = usePlayerStore.getState().error?.range;
			if (range) marks.error(range);
		}
	};

	const counter = (
		<span
			className="code-text ms-auto text-xs text-muted-foreground"
			data-testid="step-counter"
		>
			{format(m.controls.step, { current: cursor, total })}
		</span>
	);

	if (status === 'idle' || status === 'loading')
		return (
			<div className="flex flex-wrap items-center gap-2">
				<select
					value={example}
					onChange={(event) => {
						onExample(event.target.value as ExampleKey);
						player.clearError();
						marks.clear();
					}}
					aria-label={m.controls.selectExample}
					data-testid="example-select"
					className="h-8 w-[270px] max-w-full rounded-lg border bg-card px-2 text-[13px]"
				>
					{EXAMPLE_KEYS.map((key) => (
						<option key={key} value={key}>
							{m.examples[key]}
						</option>
					))}
				</select>
				<Button
					look="solid"
					onClick={() => void run()}
					disabled={status === 'loading'}
					aria-busy={status === 'loading'}
					data-testid="run-button"
				>
					<Play />
					{m.controls.run}
				</Button>
			</div>
		);

	const playing = status === 'playing';
	const finished = status === 'finished';
	const BackIcon = dir === 'rtl' ? StepForward : StepBack;
	const NextIcon = dir === 'rtl' ? StepBack : StepForward;
	const speedIndex = Math.max(0, SPEEDS.indexOf(speed));

	return (
		<div className="flex flex-col gap-2" data-testid="player">
			<div className="flex flex-wrap items-center gap-1.5">
				<Button
					icon
					onClick={() => {
						player.reset();
						marks.clear();
					}}
					aria-label={m.controls.stop}
					title={m.controls.stop}
					data-testid="stop-button"
				>
					<Pencil />
				</Button>
				<Button
					icon
					onClick={player.restart}
					disabled={cursor === 0}
					aria-label={m.controls.restart}
					title={m.controls.restart}
					data-testid="restart-button"
				>
					<RotateCcw />
				</Button>
				<Button
					icon
					onClick={player.back}
					disabled={cursor === 0}
					aria-label={m.controls.back}
					title={m.controls.back}
					data-testid="back-button"
				>
					<BackIcon />
				</Button>
				{playing ? (
					<Button
						look="solid"
						onClick={player.pause}
						data-testid="pause-button"
						className="min-w-24"
					>
						<Pause />
						{m.controls.pause}
					</Button>
				) : (
					<Button
						look="solid"
						onClick={player.play}
						disabled={finished}
						data-testid="play-button"
						className="min-w-24"
					>
						<Play />
						{m.controls.play}
					</Button>
				)}
				<Button
					icon
					onClick={player.next}
					disabled={finished}
					aria-label={m.controls.next}
					title={m.controls.next}
					data-testid="next-button"
				>
					<NextIcon />
				</Button>
				{counter}
			</div>
			<div className="flex items-center gap-3 text-xs text-muted-foreground">
				<label className="flex items-center gap-2">
					<span>{m.controls.speedLabel}</span>
					<input
						type="range"
						min={0}
						max={SPEEDS.length - 1}
						step={1}
						value={speedIndex}
						onChange={(event) =>
							player.setSpeed(SPEEDS[Number(event.target.value)])
						}
						aria-valuetext={format(m.controls.speed, { speed })}
						data-testid="speed"
						className="w-32 accent-[var(--brand)]"
					/>
				</label>
				<span className="code-text" aria-hidden="true">
					x{speed}
				</span>
				<span className="ms-auto hidden text-[11px] xl:inline">
					{m.controls.shortcuts}
				</span>
			</div>
		</div>
	);
}
