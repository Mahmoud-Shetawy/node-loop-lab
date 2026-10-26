import { create } from 'zustand';
import { ar } from './ar';
import { en, type Messages } from './en';

export type { Messages, RichText } from './en';

export type Language = 'en' | 'ar';

export const LANGUAGES: Record<
	Language,
	{ messages: Messages; dir: 'ltr' | 'rtl' }
> = {
	en: { messages: en, dir: 'ltr' },
	ar: { messages: ar, dir: 'rtl' },
};

const STORAGE_KEY = 'node-loop-lab:language';

const isLanguage = (value: unknown): value is Language =>
	value === 'en' || value === 'ar';

const detectLanguage = (): Language => {
	try {
		const saved = localStorage.getItem(STORAGE_KEY);
		if (isLanguage(saved)) return saved;
	} catch {
		// storage can be unavailable (private mode, blocked cookies)
	}
	if (typeof navigator !== 'undefined' && navigator.language?.startsWith('ar'))
		return 'ar';
	return 'en';
};

const applyToDocument = (language: Language) => {
	if (typeof document === 'undefined') return;
	document.documentElement.lang = language;
	document.documentElement.dir = LANGUAGES[language].dir;
	document.title = LANGUAGES[language].messages.app.title;
};

interface LanguageState {
	language: Language;
	setLanguage(language: Language): void;
}

export const useLanguageStore = create<LanguageState>((set) => {
	const language = detectLanguage();
	applyToDocument(language);
	return {
		language,
		setLanguage: (next) => {
			try {
				localStorage.setItem(STORAGE_KEY, next);
			} catch {
				// keep working without persistence
			}
			applyToDocument(next);
			set({ language: next });
		},
	};
});

/** Replaces `{name}` placeholders; unknown placeholders are left untouched. */
export const format = (
	template: string,
	params: Record<string, string | number> = {}
) =>
	template.replace(/\{(\w+)\}/g, (match, key: string) => {
		if (!(key in params)) return match;
		const value = params[key];
		// group digits the same way in every language: 1,000,000
		return typeof value === 'number' && Math.abs(value) >= 10_000
			? value.toLocaleString('en-US')
			: String(value);
	});

export const useI18n = () => {
	const language = useLanguageStore((state) => state.language);
	const setLanguage = useLanguageStore((state) => state.setLanguage);
	const { messages, dir } = LANGUAGES[language];
	return { language, setLanguage, dir, m: messages, format };
};

/** For code outside React (the playback loop). */
export const getMessages = () =>
	LANGUAGES[useLanguageStore.getState().language].messages;
