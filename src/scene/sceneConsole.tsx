import { FC, useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { ConsoleLevel } from '@/engine';
import { usePlayerStore } from '@/player/player';
import { useI18n } from '@/i18n';
import { cn } from '@/ui/cn';

const LEVEL_CLASSES: Partial<Record<ConsoleLevel, string>> = {
	warn: 'text-warning',
	error: 'text-destructive',
};

/** What the program printed, like a terminal running `node main.js`. */
export const SceneConsole: FC = () => {
	const logs = usePlayerStore((state) => state.view.console);
	const end = usePlayerStore((state) => state.view.end);
	const { m, format } = useI18n();
	const output = useRef<HTMLDivElement>(null);
	// the newest line stays in sight, like a terminal
	useEffect(() => {
		const node = output.current;
		if (node) node.scrollTop = node.scrollHeight;
	}, [logs.length]);

	return (
		<section
			className="flex shrink-0 flex-col gap-1.5 rounded-xl border border-border/70 bg-background/60 px-4 py-3"
			aria-label={m.sections.console.title}
			data-testid="scene-console"
		>
			<h4 className="m-0 text-[13px] font-semibold text-muted-foreground">
				{m.sections.console.title}
			</h4>
			<div
				ref={output}
				role="log"
				aria-live="polite"
				dir="ltr"
				className="code-text flex h-[180px] flex-col overflow-y-auto text-[14px] leading-6"
			>
				<AnimatePresence initial={false}>
					{logs.map((log) => (
						<motion.div
							key={log.id}
							initial={{ opacity: 0, x: -6 }}
							animate={{ opacity: 1, x: 0 }}
							transition={{ duration: 0.25 }}
							className={cn(
								'whitespace-pre-wrap break-words',
								LEVEL_CLASSES[log.level]
							)}
						>
							<span className="text-muted-foreground/60 select-none">
								{'> '}
							</span>
							{log.value}
						</motion.div>
					))}
				</AnimatePresence>
				{!logs.length && (
					<span className="text-muted-foreground/60">
						{m.sections.console.empty}
					</span>
				)}
			</div>
			{end && !end.truncated && (
				<p
					data-testid="process-exit"
					className={cn(
						'm-0 mt-auto text-xs',
						end.crashed ? 'text-destructive' : 'text-muted-foreground'
					)}
				>
					{format(end.crashed ? m.notices.crashed : m.notices.exited, {
						code: end.exitCode,
					})}
				</p>
			)}
		</section>
	);
};
