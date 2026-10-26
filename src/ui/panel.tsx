import { useId, useState, type ReactNode } from 'react';
import { CircleHelp } from 'lucide-react';
import { useI18n } from '@/i18n';
import { Button } from './button';
import { cn } from './cn';

interface PanelProps {
	title: string;
	/** shown inline under the title when the help button is pressed */
	about: ReactNode;
	children: ReactNode;
	className?: string;
}

/** A titled card. Its explanation stays one click away, never in a popup. */
export function Panel({ title, about, children, className }: PanelProps) {
	const [open, setOpen] = useState(false);
	const aboutId = useId();
	const { m } = useI18n();
	return (
		<section
			aria-label={title}
			className={cn(
				'flex min-w-0 grow flex-col gap-3 rounded-2xl border bg-card p-3 shadow-[0_1px_2px_rgb(0_0_0/0.06),0_10px_30px_-12px_rgb(0_0_0/0.25)] lg:p-4',
				className
			)}
		>
			<header className="flex items-center justify-between gap-2">
				<h2 className="m-0 text-[15px] font-semibold tracking-tight">
					{title}
				</h2>
				<Button
					look="ghost"
					icon
					aria-expanded={open}
					aria-controls={aboutId}
					aria-label={m.panel.about}
					title={m.panel.about}
					onClick={() => setOpen((value) => !value)}
					data-testid="panel-about"
					className="text-muted-foreground"
				>
					<CircleHelp />
				</Button>
			</header>
			{open && (
				<div
					id={aboutId}
					className="flex flex-col gap-2 rounded-xl bg-secondary/60 px-4 py-3 text-[13px] leading-relaxed text-muted-foreground [&_li]:mb-1 [&_p]:m-0"
				>
					{about}
				</div>
			)}
			{children}
		</section>
	);
}
