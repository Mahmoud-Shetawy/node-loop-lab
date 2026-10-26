import { FC, ReactNode } from 'react';
import {
	AnimatePresence,
	LayoutGroup,
	MotionConfig,
	motion,
} from 'motion/react';
import { Panel } from '@/ui/panel';
import { RichText } from '@/ui/richText';
import { PHASES, type ItemQueue, type LoopPhase } from '@/engine';
import { THREADPOOL_SIZE } from '@/engine/runtime';
import { usePlayerStore } from '@/player/player';
import type { Category, LibuvItem } from '@/player/visualState';
import { useI18n } from '@/i18n';
import { cn } from '@/ui/cn';
import { Pill } from './pill';
import { MOVE, tone } from './motion';

const Box: FC<{
	title: string;
	children: ReactNode;
	testId: string;
	className?: string;
}> = ({ title, children, testId, className }) => (
	<section
		data-testid={testId}
		aria-label={title}
		className={cn(
			'flex min-w-0 flex-col gap-3 rounded-2xl border border-border/70 bg-secondary/30 p-4',
			className
		)}
	>
		<h4 className="m-0 text-[13px] font-semibold text-muted-foreground">
			{title}
		</h4>
		{children}
	</section>
);

const Placeholder: FC<{ text: string }> = ({ text }) => (
	<span className="self-start text-[13px] text-muted-foreground/60">
		{text}
	</span>
);

// --- call stack ---------------------------------------------------------------------

const CallStack: FC = () => {
	const frames = usePlayerStore((state) => state.view.queues.callstack);
	const { m } = useI18n();
	return (
		<Box
			title={m.scene.callstack}
			testId="scene-callstack"
			className="min-h-[240px]"
		>
			{/* newest frame on top */}
			<div
				className="flex grow flex-col-reverse justify-start gap-2"
				data-testid="js-callstack"
			>
				<AnimatePresence mode="popLayout">
					{frames.map((frame) => (
						<Pill key={frame.id} item={frame} className="max-w-full" />
					))}
				</AnimatePresence>
				{!frames.length && <Placeholder text={m.scene.empty} />}
			</div>
		</Box>
	);
};

// --- libuv ---------------------------------------------------------------------------

const Countdown: FC<{ item: LibuvItem; time: number; timer?: boolean }> = ({
	item,
	time,
	timer,
}) => {
	const { m, format } = useI18n();
	const end = item.end ?? item.start;
	const total = end - item.start;
	const done =
		total > 0 ? Math.min(1, Math.max(0, (time - item.start) / total)) : 1;
	return (
		<div
			className="flex min-w-0 flex-col gap-1"
			title={
				timer ? format(m.scene.timerAt, { start: item.start, end }) : undefined
			}
		>
			<Pill item={item} />
			<div
				className="h-1.5 w-full overflow-hidden rounded-full bg-border/50"
				aria-hidden="true"
			>
				<motion.div
					className="h-full rounded-full"
					style={{ background: `var(--cat-${item.category}-s)` }}
					initial={false}
					animate={{ width: `${done * 100}%` }}
					transition={{ duration: 0.5 }}
				/>
			</div>
			{timer && (
				<span
					className="code-text text-[11px] text-muted-foreground"
					data-testid="timer-left"
				>
					{time >= end
						? m.scene.timerDue
						: format(m.scene.timerLeft, { ms: end - time })}
				</span>
			)}
		</div>
	);
};

const Libuv: FC = () => {
	const libuv = usePlayerStore((state) => state.view.libuv);
	const time = usePlayerStore((state) => state.view.time);
	const { m, format } = useI18n();
	const timers = libuv
		.filter((i) => i.kind === 'timer')
		.sort((a, b) => (a.end ?? 0) - (b.end ?? 0));
	const jobs = libuv.filter((i) => i.kind === 'threadpool');
	const running = jobs.filter((j) => j.start <= time);
	const waiting = jobs.filter((j) => j.start > time);
	const handles = libuv.filter((i) => i.kind === 'handle');

	return (
		<Box title={m.scene.libuv} testId="scene-libuv" className="min-h-[240px]">
			<div className="flex flex-col gap-1.5" data-testid="libuv-timers">
				<span className="text-xs text-muted-foreground">{m.scene.timers}</span>
				<div className="flex flex-wrap gap-2">
					<AnimatePresence mode="popLayout">
						{timers.map((timer) => (
							<Countdown key={timer.id} item={timer} time={time} timer />
						))}
					</AnimatePresence>
					{!timers.length && <Placeholder text={m.scene.empty} />}
				</div>
			</div>
			<div className="flex flex-col gap-1.5" data-testid="libuv-threadpool">
				<span className="text-xs text-muted-foreground">
					{format(m.scene.threadpool, {
						busy: running.length,
						size: THREADPOOL_SIZE,
					})}
				</span>
				<div className="grid grid-cols-2 gap-2">
					{Array.from({ length: THREADPOOL_SIZE }, (_, index) => {
						const job = running[index];
						return job ? (
							<Countdown key={job.id} item={job} time={time} />
						) : (
							<div
								key={`worker-${index}`}
								className="flex h-8 items-center justify-center rounded-lg border border-dashed border-border/70 text-xs text-muted-foreground/60"
							>
								{format(m.scene.worker, { n: index + 1 })}
							</div>
						);
					})}
				</div>
				{waiting.length > 0 && (
					<div
						className="flex flex-wrap items-center gap-2"
						data-testid="libuv-waiting"
					>
						<span className="text-xs text-warning">{m.scene.waiting}</span>
						<AnimatePresence mode="popLayout">
							{waiting.map((job) => (
								<Pill key={job.id} item={job} className="opacity-70" />
							))}
						</AnimatePresence>
					</div>
				)}
			</div>
			{handles.length > 0 && (
				<div
					className="flex flex-wrap items-center gap-2"
					data-testid="libuv-handles"
				>
					<span className="text-xs text-muted-foreground">
						{m.scene.handles}
					</span>
					{handles.map((handle) => (
						<Pill key={handle.id} item={handle} />
					))}
				</div>
			)}
		</Box>
	);
};

// --- the loop --------------------------------------------------------------------------

// the phases sit on a ring, clockwise from the top: the loop really loops
const RADIUS = 37; // % of the ring's width
const at = (index: number) => {
	const angle = (index / PHASES.length) * 2 * Math.PI - Math.PI / 2;
	return {
		left: `${50 + RADIUS * Math.cos(angle)}%`,
		top: `${50 + RADIUS * Math.sin(angle)}%`,
	};
};

const LoopCenter: FC = () => {
	const phase = usePlayerStore((state) => state.view.phase);
	const draining = usePlayerStore((state) => state.view.draining);
	const iteration = usePlayerStore((state) => state.view.iteration);
	const time = usePlayerStore((state) => state.view.time);
	const refs = usePlayerStore((state) => state.view.refs);
	const end = usePlayerStore((state) => state.view.end);
	const status = usePlayerStore((state) => state.status);
	const { m, format, dir } = useI18n();

	return (
		<div
			dir={dir}
			className="absolute inset-[26%] flex flex-col items-center justify-center gap-1 text-center"
			data-testid="loop-status"
		>
			{status === 'idle' ? (
				<span className="text-[13px] text-muted-foreground">
					{m.status.notStarted}
				</span>
			) : end ? (
				<span className="text-[13px] font-semibold">
					{format(end.crashed ? m.notices.crashed : m.notices.exited, {
						code: end.exitCode,
					})}
				</span>
			) : phase === 'main' || !phase ? (
				<>
					<span className="code-text text-[15px] font-semibold">
						{m.status.beforeLoop}
					</span>
					<span className="text-[11px] leading-snug text-muted-foreground">
						{m.status.mainHint}
					</span>
				</>
			) : (
				<>
					<span className="text-[11px] text-muted-foreground">
						{m.status.iteration}
					</span>
					<span className="code-text text-[26px] font-bold leading-none">
						#{iteration}
					</span>
					<span className="code-text text-[11px] text-muted-foreground">
						{m.status.clock} {time}ms
					</span>
					<span
						className="text-[11px] text-muted-foreground"
						title={m.status.refsHint}
					>
						{format(m.status.alive, { refs })}
					</span>
				</>
			)}
			<AnimatePresence>
				{draining && (
					<motion.span
						initial={{ opacity: 0, y: 4 }}
						animate={{ opacity: 1, y: 0 }}
						exit={{ opacity: 0 }}
						className="code-text mt-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold"
						style={tone('tick')}
						data-testid="drain-badge"
					>
						{m.scene.drain}
					</motion.span>
				)}
			</AnimatePresence>
		</div>
	);
};

const PhaseLoop: FC = () => {
	const phase = usePlayerStore((state) => state.view.phase);
	const iteration = usePlayerStore((state) => state.view.iteration);
	const { m } = useI18n();
	const index = PHASES.indexOf(phase as LoopPhase);
	const looping = index !== -1;
	// always forward: every iteration adds a full turn
	const turn = looping
		? Math.max(0, iteration - 1) * 360 + (index / PHASES.length) * 360
		: 0;

	return (
		<section
			className="flex flex-col items-center gap-2"
			aria-label={m.scene.loop}
			data-testid="phase-track"
			dir="ltr"
		>
			<h4
				dir="auto"
				className="m-0 self-start text-[13px] font-semibold text-muted-foreground"
			>
				{m.scene.loop}
			</h4>
			<div className="relative aspect-square w-full max-w-[400px]">
				<svg
					viewBox="0 0 100 100"
					className="absolute inset-0 size-full"
					aria-hidden="true"
				>
					<defs>
						<marker
							id="loop-arrow"
							viewBox="0 0 10 10"
							refX="5"
							refY="5"
							markerWidth="4"
							markerHeight="4"
							orient="auto"
						>
							<path d="M0,0 L10,5 L0,10 z" fill="var(--line)" />
						</marker>
					</defs>
					<circle
						cx="50"
						cy="50"
						r={RADIUS}
						fill="none"
						stroke="var(--line)"
						strokeWidth="0.8"
						strokeDasharray="2 1.6"
					/>
					{/* arrows between the phases, clockwise */}
					{PHASES.map((name, i) => {
						const a = ((i + 0.5) / PHASES.length) * 2 * Math.PI - Math.PI / 2;
						const x = 50 + RADIUS * Math.cos(a);
						const y = 50 + RADIUS * Math.sin(a);
						return (
							<line
								key={name}
								// along the tangent: clockwise is (-sin, cos)
								x1={x + Math.sin(a) * 1.2}
								y1={y - Math.cos(a) * 1.2}
								x2={x - Math.sin(a) * 1.2}
								y2={y + Math.cos(a) * 1.2}
								stroke="var(--line)"
								strokeWidth="0.8"
								markerEnd="url(#loop-arrow)"
							/>
						);
					})}
				</svg>
				{/* the cursor travels along the ring to the current phase */}
				<motion.div
					className="pointer-events-none absolute inset-0"
					initial={false}
					animate={{ rotate: turn, opacity: looping ? 1 : 0 }}
					transition={MOVE}
					aria-hidden="true"
				>
					<span
						className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground shadow-[0_0_0_4px_color-mix(in_oklab,var(--ink)_20%,transparent)]"
						style={{ left: '50%', top: `${50 - RADIUS}%` }}
					/>
				</motion.div>
				<span
					className="absolute -translate-x-1/2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
					style={{ left: '50%', top: '0%' }}
				>
					↓ {m.scene.loopStart}
				</span>
				<ol className="m-0 list-none p-0">
					{PHASES.map((name, i) => {
						const active = phase === name;
						return (
							<li
								key={name}
								data-testid={`phase-${name}`}
								data-active={active || undefined}
								aria-current={active ? 'step' : undefined}
								title={m.phases[name].hint}
								style={at(i)}
								className={cn(
									'absolute flex w-[30%] -translate-x-1/2 -translate-y-1/2 flex-col items-center rounded-xl border px-1.5 py-1.5 text-center transition-colors duration-300',
									active
										? 'border-foreground bg-foreground text-background shadow-lg'
										: 'border-border/70 bg-background text-foreground'
								)}
							>
								<span className="code-text text-[12px] font-semibold leading-tight">
									{m.phases[name].name}
								</span>
								<span
									dir="auto"
									className={cn(
										'text-[10px] leading-tight',
										active ? 'text-background/80' : 'text-muted-foreground'
									)}
								>
									{m.phases[name].runs}
								</span>
							</li>
						);
					})}
				</ol>
				<LoopCenter />
			</div>
		</section>
	);
};

// --- queues --------------------------------------------------------------------------

const Tube: FC<{
	label: string;
	hint: string;
	queue: ItemQueue;
	category: Category;
	active: boolean;
	testId: string;
}> = ({ label, hint, queue, category, active, testId }) => {
	const items = usePlayerStore((state) => state.view.queues[queue]);
	return (
		<div
			data-testid={testId}
			data-active={active || undefined}
			className="flex min-h-12 min-w-0 items-center gap-3 rounded-xl border px-3 py-2 transition-[box-shadow] duration-300"
			style={{
				background: `color-mix(in oklab, var(--cat-${category}-f) 70%, transparent)`,
				borderColor: `var(--cat-${category}-s)`,
				boxShadow: active ? `0 0 0 2px var(--cat-${category}-s)` : undefined,
			}}
		>
			<span className="flex w-[118px] shrink-0 flex-col">
				<span
					className="code-text text-[13px] font-semibold"
					style={{ color: `var(--cat-${category}-t)` }}
				>
					{label}
				</span>
				<span
					dir="auto"
					className="code-text text-[10.5px] leading-tight text-muted-foreground"
				>
					{hint}
				</span>
			</span>
			<div className="flex min-w-0 flex-wrap gap-2">
				<AnimatePresence mode="popLayout">
					{items.map((item) => (
						<Pill key={item.id} item={item} />
					))}
				</AnimatePresence>
			</div>
		</div>
	);
};

const MACROTASKS: {
	phase: LoopPhase;
	queue: ItemQueue;
	category: Category;
}[] = [
	{ phase: 'timers', queue: 'timers', category: 'timer' },
	{ phase: 'poll', queue: 'poll', category: 'io' },
	{ phase: 'check', queue: 'check', category: 'immediate' },
	{ phase: 'close', queue: 'close', category: 'close' },
];

const Queues: FC = () => {
	const phase = usePlayerStore((state) => state.view.phase);
	const draining = usePlayerStore((state) => state.view.draining);
	// a card leaving the nextTick queue still belongs to it until it is gone
	const ticks = usePlayerStore((state) => state.view.queues.nextTick.length);
	const promises = usePlayerStore(
		(state) => state.view.queues.microtask.length
	);
	const { m } = useI18n();
	return (
		<div className="flex min-w-0 flex-col gap-4" dir="ltr">
			<div className="flex flex-col gap-2">
				<span
					dir="auto"
					className="text-[13px] font-semibold text-muted-foreground"
				>
					{m.scene.macrotasks}
				</span>
				{MACROTASKS.map((tube) => (
					<Tube
						key={tube.queue}
						label={m.phases[tube.phase].name}
						hint={m.phases[tube.phase].runs}
						queue={tube.queue}
						category={tube.category}
						active={phase === tube.phase && !draining}
						testId={`queue-${tube.queue}`}
					/>
				))}
			</div>
			<div className="flex flex-col gap-2">
				<span
					dir="auto"
					className="text-[13px] font-semibold text-muted-foreground"
				>
					{m.scene.microtasks}
				</span>
				<Tube
					label="1 · nextTick"
					hint={m.scene.tickQueue}
					queue="nextTick"
					category="tick"
					active={draining && ticks > 0}
					testId="js-nextTick"
				/>
				<Tube
					label="2 · Promises"
					hint={m.scene.promiseQueue}
					queue="microtask"
					category="promise"
					active={draining && ticks === 0 && promises > 0}
					testId="js-microtask"
				/>
			</div>
		</div>
	);
};

export const Scene: FC = () => {
	const { m } = useI18n();
	return (
		<Panel
			title={m.scene.title}
			about={<RichText content={m.scene.description} />}
		>
			{/* people who asked their OS for less motion get fades, not flights */}
			<MotionConfig reducedMotion="user">
				<LayoutGroup>
					<div className="flex flex-col gap-5" data-testid="scene">
						<div className="grid grid-cols-1 gap-4 md:grid-cols-2" dir="ltr">
							<CallStack />
							<Libuv />
						</div>
						<div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-2">
							<PhaseLoop />
							<Queues />
						</div>
					</div>
				</LayoutGroup>
			</MotionConfig>
		</Panel>
	);
};
