import { shortLabel } from './labels';

describe('shortLabel', () => {
	it.each([
		[
			"() => { console.log('setImmediate'); process.nextTick(() => {…",
			"() => log('setImmediate')",
		],
		["() => console.log('timeout')", "() => log('timeout')"],
		['function greet(name) { console.log(name) }', 'greet()'],
		['async function load() {…}', 'load()'],
		[
			'(err, data) => { console.log(err.code, err.syscall, err.errno, data) }',
			'(…) => log(…)',
		],
		['() => {}', '() => {…}'],
		[
			"() => { process.nextTick(() => { console.log('nextTick in fs'); }); …",
			'() => process.nextTick(…)',
		],
		[
			"setImmediate(() => { console.log('a'); console.log('b') })",
			'setImmediate(…)',
		],
		["console.log('x')", "console.log('x')"],
		['main.js', 'main.js'],
		["fs.readFile('file.txt') · open", 'readFile · open'],
		["fs.readFile('file.txt'): open ✓ → fstat", 'open ✓ → fstat'],
		["fs.stat('file.txt')", "fs.stat('file.txt')"],
	])('%s -> %s', (label, expected) => {
		expect(shortLabel(label)).toBe(expected);
	});
});
