import { create } from 'zustand';

export type Scheme = 'light' | 'dark';

const STORAGE_KEY = 'node-loop-lab:scheme';

/** The saved choice, else the system preference (index.html does the same). */
const initialScheme = (): Scheme => {
	if (typeof document !== 'undefined')
		return document.documentElement.classList.contains('dark')
			? 'dark'
			: 'light';
	return 'dark';
};

interface SchemeState {
	scheme: Scheme;
	setScheme(scheme: Scheme): void;
}

export const useScheme = create<SchemeState>((set) => ({
	scheme: initialScheme(),
	setScheme: (scheme) => {
		document.documentElement.classList.toggle('dark', scheme === 'dark');
		try {
			localStorage.setItem(STORAGE_KEY, scheme);
		} catch {
			// private mode: the choice lasts for this visit only
		}
		set({ scheme });
	},
}));

/** Ace's own themes, one per scheme. */
export const ACE_THEME: Record<Scheme, string> = {
	light: 'github',
	dark: 'one_dark',
};
