import type { ButtonHTMLAttributes } from 'react';
import { cn } from './cn';

type Look = 'solid' | 'outline' | 'ghost';

const LOOKS: Record<Look, string> = {
	solid:
		'bg-accent text-white shadow-sm hover:brightness-110 dark:text-background',
	outline: 'border bg-card hover:bg-secondary',
	ghost: 'hover:bg-secondary',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	look?: Look;
	/** square, for a single icon */
	icon?: boolean;
}

export function Button({
	look = 'outline',
	icon,
	className,
	type = 'button',
	...props
}: ButtonProps) {
	return (
		<button
			type={type}
			className={cn(
				'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg text-[13px] font-medium transition disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4',
				icon ? 'w-8' : 'px-3',
				LOOKS[look],
				className
			)}
			{...props}
		/>
	);
}
