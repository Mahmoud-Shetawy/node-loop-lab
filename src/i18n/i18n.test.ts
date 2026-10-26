import { act } from '@testing-library/react';
import { ar } from './ar';
import { en } from './en';
import { format, getMessages, useLanguageStore } from './index';

/** Every leaf path of a messages object, e.g. "controls.run". */
const paths = (value: unknown, prefix = ''): string[] => {
	if (typeof value === 'string') return [prefix];
	if (Array.isArray(value)) return [`${prefix}[${value.length}]`];
	return Object.entries(value as Record<string, unknown>).flatMap(([key, v]) =>
		paths(v, prefix ? `${prefix}.${key}` : key)
	);
};

const placeholders = (text: string) =>
	[...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

const leaves = (value: unknown, prefix = ''): [string, string][] => {
	if (typeof value === 'string') return [[prefix, value]];
	if (Array.isArray(value))
		return value.flatMap((v, i) => leaves(v, `${prefix}[${i}]`));
	return Object.entries(value as Record<string, unknown>).flatMap(([key, v]) =>
		leaves(v, prefix ? `${prefix}.${key}` : key)
	);
};

describe('messages', () => {
	it('arabic has exactly the same keys and list lengths as english', () => {
		expect(paths(ar)).toEqual(paths(en));
	});

	it('arabic keeps every placeholder of the english text', () => {
		const arabic = new Map(leaves(ar));
		for (const [path, text] of leaves(en)) {
			expect({
				path,
				placeholders: placeholders(arabic.get(path) ?? ''),
			}).toEqual({
				path,
				placeholders: placeholders(text),
			});
		}
	});

	it('has no empty translation', () => {
		for (const [path, text] of leaves(ar))
			expect({ path, empty: !text.trim() }).toEqual({ path, empty: false });
	});
});

describe('format', () => {
	it('replaces placeholders and keeps unknown ones', () => {
		expect(format('{a} and {b}', { a: 1 })).toBe('1 and {b}');
	});

	it('groups large numbers the same way in every language', () => {
		expect(format('{n}', { n: 1_000_000 })).toBe('1,000,000');
		expect(format('{n}', { n: 4 })).toBe('4');
	});
});

describe('useLanguageStore', () => {
	// jsdom on this Node version has no usable localStorage: use an in-memory one
	const memory = new Map<string, string>();
	const storage = {
		getItem: (key: string) => memory.get(key) ?? null,
		setItem: (key: string, value: string) => void memory.set(key, value),
	};
	beforeEach(() => vi.stubGlobal('localStorage', storage));
	afterEach(() => {
		act(() => useLanguageStore.getState().setLanguage('en'));
		vi.unstubAllGlobals();
	});

	it('switches direction, lang, title and persists the choice', () => {
		act(() => useLanguageStore.getState().setLanguage('ar'));
		expect(document.documentElement.dir).toBe('rtl');
		expect(document.documentElement.lang).toBe('ar');
		expect(document.title).toBe(ar.app.title);
		expect(localStorage.getItem('node-loop-lab:language')).toBe('ar');
		expect(getMessages()).toBe(ar);

		act(() => useLanguageStore.getState().setLanguage('en'));
		expect(document.documentElement.dir).toBe('ltr');
		expect(getMessages()).toBe(en);
	});

	it('keeps working when storage is unavailable', () => {
		const setItem = vi.spyOn(storage, 'setItem').mockImplementation(() => {
			throw new Error('blocked');
		});
		expect(() =>
			act(() => useLanguageStore.getState().setLanguage('ar'))
		).not.toThrow();
		expect(useLanguageStore.getState().language).toBe('ar');
		setItem.mockRestore();
	});
});
