import type { Category } from '@/player/visualState';

/** Spring shared by every moving card: quick and smooth, no bounce. */
export const MOVE = { type: 'spring', stiffness: 260, damping: 30 } as const;

/** The CSS variables of a category (see globals.css). */
export const tone = (category: Category) => ({
	background: `var(--cat-${category}-f)`,
	borderColor: `var(--cat-${category}-s)`,
	color: `var(--cat-${category}-t)`,
});
