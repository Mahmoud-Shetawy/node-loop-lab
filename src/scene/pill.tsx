import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import type { QueueItem } from '@/player/visualState';
import { MOVE, tone } from './motion';
import { cn } from '@/ui/cn';
import { shortLabel } from '@/player/labels';

interface PillProps {
	item: QueueItem;
	className?: string;
	children?: ReactNode;
}

/**
 * One callback. Pills of the same flow share a `layoutId`: when the callback
 * moves (libuv timer -> timers queue -> call stack), the pill travels across
 * the screen instead of disappearing in one place and appearing in another.
 */
export function Pill({ item, className, children }: PillProps) {
	return (
		<motion.div
			layout
			layoutId={item.flow === undefined ? undefined : `flow-${item.flow}`}
			initial={{ opacity: 0, y: -10, scale: 0.9 }}
			animate={{ opacity: item.leaving ? 0.45 : 1, y: 0, scale: 1 }}
			// a card that travels must not leave a fading copy behind: its
			// layoutId already carries it to the next place
			exit={item.flow === undefined ? { opacity: 0, scale: 0.9 } : undefined}
			transition={MOVE}
			title={item.value}
			data-flow={item.flow}
			data-category={item.category}
			style={tone(item.category)}
			className={cn(
				'code-text flex h-8 min-w-0 max-w-[220px] shrink-0 items-center rounded-lg border px-3 text-[12.5px]',
				item.origin === 'fsInternal' && 'border-dashed',
				className
			)}
		>
			<span className="truncate">{children ?? shortLabel(item.value)}</span>
		</motion.div>
	);
}
