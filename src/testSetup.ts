import '@testing-library/jest-dom/vitest';

// Node 22+ defines its own (experimental) localStorage global, unusable
// without --localstorage-file. In Vitest's jsdom environment `window` is
// that same global, so take the storage from the jsdom instance itself.
declare global {
	var jsdom: { window: { localStorage: Storage } } | undefined;
}

if (globalThis.jsdom)
	Object.defineProperty(globalThis, 'localStorage', {
		configurable: true,
		value: globalThis.jsdom.window.localStorage,
	});
