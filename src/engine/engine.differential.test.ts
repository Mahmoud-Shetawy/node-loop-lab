// @vitest-environment node
/// <reference types="node" />
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consoleOutput, simulate } from './index';
import { INITIAL_FILES } from './node-modules';
import { EXAMPLES } from '@/examples';

/**
 * Differential tests: every program runs for real in this Node.js process
 * (V8 + libuv, through `vm`) and in the simulator; the console output must
 * be identical. This checks the simulator against Node itself instead of
 * against our own expectations.
 *
 * Constraints of the native side (not of the simulator):
 *  - real timers and a real disk: only programs whose order does not depend
 *    on how fast the machine is (e.g. no setTimeout(0) vs setImmediate race
 *    from the main module, no timer racing a file read);
 *  - different delays are at least 5ms apart;
 *  - an uncaught error would crash the test runner, and `vm` scripts can't be
 *    ES modules: those cases live in engine.node.test.ts.
 */
let directory = '';

/**
 * The simulator models Node.js 22 LTS. Point NODE_REFERENCE_BIN at another
 * node binary to compare against it; the default is the node running vitest.
 */
const NODE_BIN = process.env.NODE_REFERENCE_BIN ?? process.execPath;
const NODE_MAJOR = Number(
	spawnSync(NODE_BIN, ['-p', 'process.versions.node.split(".")[0]'], {
		encoding: 'utf8',
	}).stdout.trim()
);

beforeAll(() => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), 'node-loop-lab-'));
	for (const [name, content] of Object.entries(INITIAL_FILES))
		fs.writeFileSync(path.join(directory, name), content);
});

afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

/**
 * Runs `code` as its own `node` process (in the temporary /app directory) and
 * returns what it printed. A fresh process is the only faithful reference:
 * inside the test runner we would already be in a Promise callback.
 */
const runNative = (code: string, isModule = false) => {
	const { stdout, status } = runNativeProcess(code, isModule);
	if (status !== 0) throw new Error(`node exited with ${status}`);
	return stdout;
};

/** Output (stdout only) and exit code of a real node process. */
/** every console method prints to stdout, in order */
const PLAIN_PRELUDE =
	'console.error = console.warn = console.info = console.debug = console.log;\n';

/**
 * Prefixes every console line with the async_hooks type of the resource
 * that is running: Timeout, Immediate, FSREQCALLBACK, TickObject, PROMISE,
 * Microtask, TCPWRAP, ... or "main" for the main module.
 */
const kindPrelude = (isModule: boolean) =>
	(isModule
		? "import * as __ah from 'node:async_hooks'; import * as __util from 'node:util';\n"
		: "const __ah = require('node:async_hooks'); const __util = require('node:util');\n") +
	'const __types = new Map(); __ah.createHook({ init(id, type) { __types.set(id, type); } }).enable();\n' +
	"for (const __m of ['log', 'info', 'warn', 'error', 'debug']) console[__m] = (...a) => process.stdout.write((__types.get(__ah.executionAsyncId()) ?? 'main') + '\\u241f' + __util.format(...a) + '\\n');\n";

const runNativeProcess = (
	code: string,
	isModule = false,
	prelude = PLAIN_PRELUDE
) => {
	const file = path.join(directory, isModule ? 'main.mjs' : 'main.js');
	fs.writeFileSync(file, prelude + code);
	const result = spawnSync(NODE_BIN, [file], {
		cwd: directory,
		encoding: 'utf8',
		// generous: a busy machine must not turn a slow start into a failure
		timeout: 30_000,
	});
	return {
		status: result.status,
		stdout: result.stdout
			.split('\n')
			.filter((line, i, lines) => i < lines.length - 1 || line),
	};
};

interface Case {
	name: string;
	code: string;
	/** run as an ES module (main.mjs) */
	isModule?: boolean;
	/**
	 * Behaviour that changed after Node 22 (e.g. ES modules without top-level
	 * await are evaluated synchronously in newer versions): only compared
	 * against a Node <= 22 reference.
	 */
	node22Only?: boolean;
	/**
	 * The order of two network events in one poll depends on the OS poller:
	 * on macOS (kqueue) the client's connect callback runs first, on Linux
	 * (epoll) the server's 'connection'. The simulator follows macOS.
	 */
	macOnly?: boolean;
}

const IS_MAC = process.platform === 'darwin';

const CASES: Case[] = [
	// --- basics -----------------------------------------------------------------
	{
		name: 'synchronous logs',
		code: `console.log(1); console.log(2); console.log(3);`,
	},
	{
		name: 'variables and expressions',
		code: `const a = 2; let b = a * 3; console.log(a + b, \`t=\${b}\`);`,
	},
	{
		name: 'multiple arguments and objects',
		code: `console.log('a', 1, true, null, undefined, [1, [2, 3]], { x: 1, y: 'z' });`,
	},
	{
		name: 'loops',
		code: `for (let i = 0; i < 3; i++) console.log(i); let j = 0; while (j < 2) console.log('w', j++); do { console.log('d'); } while (false);`,
	},
	{
		name: 'for...of / for...in',
		code: `for (const v of [1, 2]) console.log(v); for (const k in { a: 1, b: 2 }) console.log(k);`,
	},
	{
		name: 'function declarations are hoisted',
		code: `foo(); function foo() { console.log('hoisted'); }`,
	},
	{
		name: 'closures',
		code: `const make = () => { let n = 0; return () => ++n; }; const inc = make(); inc(); console.log(inc());`,
	},
	{
		name: 'classes, getters, static, private',
		code: `class A { #x = 1; static s = 's'; get x() { return this.#x; } inc() { this.#x++; return this; } #p() { return 'p'; } p() { return this.#p(); } } const a = new A(); console.log(a.inc().x, A.s, a.p());`,
	},
	{
		name: 'inheritance and super',
		code: `class A { hi() { return 'A'; } } class B extends A { hi() { return super.hi() + 'B'; } } console.log(new B().hi());`,
	},
	{
		name: 'try / catch / finally',
		code: `try { throw new Error('boom'); } catch (e) { console.log('caught', e.message); } finally { console.log('finally'); }`,
	},
	{
		name: 'destructuring catch param',
		code: `try { throw { code: 42 }; } catch ({ code }) { console.log(code); }`,
	},
	{
		name: 'optional chaining short-circuits',
		code: `const o = null; console.log(o?.a.b.c(), o?.m()); const p = { m() { return 'm'; } }; console.log(p?.m(), p.n?.());`,
	},
	{
		name: 'array callbacks run synchronously',
		code: `[3, 1, 2].sort((a, b) => a - b).forEach((n) => console.log(n)); console.log([1, 2].map((x) => x * 2));`,
	},
	{
		name: 'spread and rest',
		code: `const f = (...xs) => xs.length; console.log(f(...[1, 2, 3]), Math.max(...[4, 9, 2]));`,
	},
	{
		name: 'generators',
		code: `function* g() { yield 1; yield 2; } for (const v of g()) console.log(v); console.log([...g()]);`,
	},
	{
		name: 'recursion',
		code: `const fib = (n) => (n < 2 ? n : fib(n - 1) + fib(n - 2)); console.log(fib(10));`,
	},
	{
		name: 'labels, break, continue',
		code: `outer: for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) { if (j === 1) continue outer; if (i === 2) break outer; console.log(i, j); } }`,
	},
	{
		name: 'typeof undeclared global',
		code: `console.log(typeof notDefinedAnywhere, typeof Promise, typeof setTimeout);`,
	},
	{
		name: 'format specifiers',
		code: `console.log('%s is %d years', 'Bob', 42.7, 'extra'); console.log('%o', { a: 1 }); console.log('100%%');`,
	},

	// --- tasks --------------------------------------------------------------------
	{
		name: 'setTimeout after sync code',
		code: `console.log(1); setTimeout(() => console.log(2), 0); console.log(3);`,
	},
	{
		name: 'setTimeout ordering by delay',
		code: `setTimeout(() => console.log('20'), 20); setTimeout(() => console.log('5'), 5); setTimeout(() => console.log('10'), 10);`,
	},
	{
		name: 'same delay keeps FIFO order',
		code: `setTimeout(() => console.log('a'), 5); setTimeout(() => console.log('b'), 5); setTimeout(() => console.log('c'), 5);`,
	},
	{
		name: 'setTimeout with function reference and args',
		code: `function hi(name, n) { console.log('hi', name, n); } setTimeout(hi, 0, 'there', 7);`,
	},
	{
		name: 'setTimeout without delay',
		code: `setTimeout(() => console.log('no delay')); console.log('sync');`,
	},
	{
		name: 'clearTimeout',
		code: `const t = setTimeout(() => console.log('never'), 5); clearTimeout(t); setTimeout(() => console.log('kept'), 5);`,
	},
	{
		name: 'clearTimeout from another timer',
		code: `const late = setTimeout(() => console.log('late'), 30); setTimeout(() => { console.log('cancel'); clearTimeout(late); }, 5);`,
	},
	{
		name: 'setInterval with clearInterval',
		code: `let n = 0; const id = setInterval(() => { console.log('tick', ++n); if (n === 3) clearInterval(id); }, 5);`,
	},
	{
		name: 'nested setTimeout',
		code: `setTimeout(() => { console.log(1); setTimeout(() => console.log(3), 0); Promise.resolve().then(() => console.log(2)); }, 0);`,
	},
	{
		name: 'microtasks drain between timers',
		code: `setTimeout(() => { console.log('t1'); Promise.resolve().then(() => console.log('m1')); }, 5); setTimeout(() => { console.log('t2'); queueMicrotask(() => console.log('m2')); }, 5);`,
	},

	// --- microtasks -------------------------------------------------------------------
	{
		name: 'microtasks before tasks',
		code: `console.log(1); setTimeout(() => console.log(2), 0); queueMicrotask(() => console.log(3)); Promise.resolve().then(() => console.log(4)); console.log(5);`,
	},
	{
		name: 'then chain order',
		code: `Promise.resolve().then(() => console.log(1)).then(() => console.log(2)); Promise.resolve().then(() => console.log('a')).then(() => console.log('b'));`,
	},
	{
		name: 'microtask scheduled from microtask',
		code: `queueMicrotask(() => { console.log(1); queueMicrotask(() => console.log(3)); }); queueMicrotask(() => console.log(2));`,
	},
	{
		name: 'new Promise executor is synchronous',
		code: `new Promise((resolve) => { console.log(1); resolve(); console.log(2); }).then(() => console.log(4)); console.log(3);`,
	},
	{
		name: 'resolve only once',
		code: `new Promise((res, rej) => { res('first'); res('second'); rej('x'); }).then((v) => console.log(v));`,
	},
	{
		name: 'then values propagate',
		code: `Promise.resolve(1).then((v) => v + 1).then((v) => { console.log(v); return v * 10; }).then(console.log);`,
	},
	{
		name: 'pass-through then without handlers',
		code: `Promise.resolve('v').then().then(null, () => {}).then((v) => console.log(v)); Promise.resolve().then(() => console.log('x')).then(() => console.log('y')).then(() => console.log('z'));`,
	},
	{
		name: 'catch and recovery',
		code: `Promise.reject(new Error('e')).catch((e) => { console.log('caught', e.message); return 'ok'; }).then((v) => console.log(v));`,
	},
	{
		name: 'throw inside then becomes rejection',
		code: `Promise.resolve().then(() => { throw new TypeError('bad'); }).catch((e) => console.log(e.name, e.message));`,
	},
	{
		name: 'finally passes values through',
		code: `Promise.resolve(5).finally(() => console.log('f')).then((v) => console.log(v)); Promise.reject(1).finally(() => console.log('f2')).catch((e) => console.log('e', e));`,
	},
	{
		name: 'resolving with a promise costs two ticks',
		code: `const p = Promise.resolve(); new Promise((r) => r(p)).then(() => console.log('resolved with promise')); Promise.resolve().then(() => console.log(1)).then(() => console.log(2)).then(() => console.log(3));`,
	},
	{
		name: 'returning a promise from then costs two ticks',
		code: `Promise.resolve().then(() => { console.log(0); return Promise.resolve(4); }).then((r) => console.log(r)); Promise.resolve().then(() => console.log(1)).then(() => console.log(2)).then(() => console.log(3)).then(() => console.log(5)).then(() => console.log(6));`,
	},
	{
		name: 'custom thenable',
		code: `const thenable = { then(res) { console.log('then called'); res(42); } }; Promise.resolve(thenable).then((v) => console.log(v)); console.log('sync');`,
	},
	{
		name: 'Promise.all',
		code: `Promise.all([1, Promise.resolve(2), new Promise((r) => setTimeout(() => r(3), 5))]).then((v) => console.log(v));`,
	},
	{
		name: 'Promise.all rejects fast',
		code: `Promise.all([Promise.reject('no'), new Promise((r) => setTimeout(r, 10))]).catch((e) => console.log('rejected', e));`,
	},
	{
		name: 'Promise.allSettled',
		code: `Promise.allSettled([Promise.resolve(1), Promise.reject(2)]).then((r) => console.log(JSON.stringify(r)));`,
	},
	{
		name: 'Promise.race',
		code: `Promise.race([new Promise((r) => setTimeout(() => r('slow'), 20)), new Promise((r) => setTimeout(() => r('fast'), 5))]).then(console.log);`,
	},
	{
		name: 'Promise.any',
		code: `Promise.any([Promise.reject(1), Promise.resolve(2)]).then(console.log); Promise.any([Promise.reject(1)]).catch((e) => console.log(e.constructor.name, e.errors));`,
	},
	{
		name: 'Promise.withResolvers',
		code: `const { promise, resolve } = Promise.withResolvers(); promise.then((v) => console.log('got', v)); setTimeout(() => resolve('late'), 5);`,
	},
	{
		name: 'promise ordering across all/then',
		code: `Promise.all([Promise.resolve(1)]).then(() => console.log('all')); Promise.resolve().then(() => console.log('a')).then(() => console.log('b')).then(() => console.log('c'));`,
	},
	{
		name: 'chaining cycle is a TypeError',
		code: `const p = Promise.resolve().then(() => p); p.catch((e) => console.log(e instanceof TypeError));`,
	},

	// --- async / await -------------------------------------------------------------------
	{
		name: 'async function runs synchronously until await',
		code: `async function f() { console.log(1); await null; console.log(3); } f(); console.log(2);`,
	},
	{
		name: 'classic async puzzle',
		code: `async function a1() { console.log('a1 start'); await a2(); console.log('a1 end'); } async function a2() { console.log('a2'); } console.log('script start'); setTimeout(() => console.log('setTimeout'), 0); a1(); new Promise((resolve) => { console.log('p1'); resolve(); }).then(() => console.log('p2')); console.log('script end');`,
	},
	{
		name: 'await a non-promise takes one tick',
		code: `(async () => { await 1; console.log('after await'); })(); Promise.resolve().then(() => console.log('then 1')).then(() => console.log('then 2'));`,
	},
	{
		name: 'await a pending promise',
		code: `const wait = (ms) => new Promise((r) => setTimeout(r, ms)); (async () => { console.log('start'); await wait(10); console.log('10ms'); await wait(5); console.log('15ms'); })();`,
	},
	{
		name: 'async return value',
		code: `async function v() { return 7; } v().then((x) => console.log('value', x)); Promise.resolve().then(() => console.log('t1')).then(() => console.log('t2'));`,
	},
	{
		name: 'async returning a promise costs extra ticks',
		code: `async function v() { return Promise.resolve('p'); } v().then((x) => console.log(x)); Promise.resolve().then(() => console.log(1)).then(() => console.log(2)).then(() => console.log(3)).then(() => console.log(4));`,
	},
	{
		name: 'try/catch around await',
		code: `async function f() { try { await Promise.reject(new Error('nope')); } catch (e) { console.log('caught', e.message); } finally { console.log('finally'); } } f();`,
	},
	{
		name: 'rejections propagate out of async functions',
		code: `async function f() { throw new Error('inner'); } f().catch((e) => console.log('outer', e.message)); console.log('sync');`,
	},
	{
		name: 'await in loops',
		code: `async function f() { for (let i = 0; i < 3; i++) { await null; console.log('i', i); } } f(); Promise.resolve().then(() => console.log('x')).then(() => console.log('y'));`,
	},
	{
		name: 'async arrow and method with this',
		code: `const o = { n: 'o', async m() { await null; return this.n; } }; o.m().then(console.log); class C { constructor() { this.v = 'c'; } run = async () => { await null; console.log(this.v); }; } new C().run();`,
	},
	{
		name: 'parallel awaits with Promise.all',
		code: `const wait = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms)); (async () => { const r = await Promise.all([wait(10, 'a'), wait(5, 'b')]); console.log(r); })();`,
	},
	{
		name: 'await thenable',
		code: `(async () => { const v = await { then(r) { r('thenable value'); } }; console.log(v); })(); Promise.resolve().then(() => console.log(1)).then(() => console.log(2));`,
	},
	{
		name: 'top-level await',
		code: `console.log(1); await null; console.log(3); setTimeout(() => console.log(4), 0);`,
		isModule: true,
	},
	{
		name: 'interleaved async functions',
		code: `async function a() { console.log('a1'); await null; console.log('a2'); await null; console.log('a3'); } async function b() { console.log('b1'); await null; console.log('b2'); } a(); b();`,
	},
	{
		name: 'everything mixed',
		code: `console.log('script start'); setTimeout(() => { console.log('timeout 1'); Promise.resolve().then(() => console.log('timeout 1 micro')); }, 0); setTimeout(() => console.log('timeout 2'), 0); queueMicrotask(() => console.log('micro 1')); (async () => { console.log('async start'); await null; console.log('async after await'); setTimeout(() => console.log('timeout 3'), 0); })(); Promise.resolve().then(() => console.log('then 1')).then(() => console.log('then 2')); console.log('script end');`,
	},

	// --- Node.js: nextTick, setImmediate, I/O, the phases -----------------------
	{
		name: 'nextTick runs before Promise callbacks',
		code: `console.log(1); process.nextTick(() => console.log('nextTick')); Promise.resolve().then(() => console.log('Promise')); console.log(2);`,
	},
	{
		name: 'nested nextTick queue (FIFO)',
		code: `process.nextTick(() => { console.log('nextTick 1'); process.nextTick(() => { console.log('nextTick 2'); process.nextTick(() => console.log('nextTick 3')); process.nextTick(() => console.log('nextTick 4')); }); process.nextTick(() => { console.log('nextTick 5'); process.nextTick(() => console.log('nextTick 6')); process.nextTick(() => console.log('nextTick 7')); }); });`,
	},
	{
		name: 'microtasks drain before nextTicks they schedule',
		code: `Promise.resolve().then(() => { console.log('p1'); process.nextTick(() => console.log('tick')); }).then(() => console.log('p2'));`,
	},
	{
		name: 'Promises scheduled by a nextTick wait for the tick queue',
		code: `process.nextTick(() => { console.log('t1'); Promise.resolve().then(() => console.log('p')); }); process.nextTick(() => console.log('t2'));`,
	},
	{
		name: 'Node >= 11: microtasks between timers',
		code: `setTimeout(() => console.log('Timeout 1')); setTimeout(() => { console.log('Timeout 2'); Promise.resolve().then(() => console.log('promise resolve')); }); setTimeout(() => console.log('Timeout 3'));`,
	},
	{
		name: 'Node >= 11: nextTick between immediates',
		code: `setImmediate(() => { console.log('immediate 1'); process.nextTick(() => console.log('tick')); Promise.resolve().then(() => console.log('promise')); }); setImmediate(() => console.log('immediate 2'));`,
	},
	{
		name: 'setImmediate inside setImmediate waits for the next loop',
		code: `setImmediate(() => { console.log(1); setImmediate(() => console.log(3)); }); setImmediate(() => console.log(2));`,
	},
	{
		name: 'clearImmediate',
		code: `const i = setImmediate(() => console.log('never')); setImmediate(() => console.log('kept')); clearImmediate(i);`,
	},
	{
		name: 'setTimeout & setImmediate inside an fs callback',
		code: `const fs = require('fs'); fs.readFile('file.txt', () => { setTimeout(() => console.log('setTimeout'), 0); setImmediate(() => console.log('setImmediate')); });`,
	},
	{
		name: 'the article puzzle: nextTick, timer, immediate inside I/O',
		code: `const fs = require('fs'); fs.readFile('file.txt', () => { process.nextTick(() => console.log('nextTick in fs')); setTimeout(() => { console.log('setTimeout'); process.nextTick(() => console.log('nextTick in setTimeout')); }, 0); setImmediate(() => { console.log('setImmediate'); process.nextTick(() => { console.log('nextTick in setImmediate'); Promise.resolve().then(() => console.log('Promise in setImmediate')); }); }); });`,
	},
	{
		name: 'setImmediate before a file read (Node 22: readFile is 4 round trips)',
		// Node 23+ reads a small file in one request, which can beat the
		// immediate when the machine is busy
		node22Only: true,
		code: `const fs = require('fs'); fs.readFile('file.txt', 'utf8', (err, data) => console.log(data)); setImmediate(() => console.log('immediate'));`,
	},
	{
		name: 'fs error object',
		code: `const fs = require('fs'); fs.readFile('missing.txt', (err, data) => console.log(err.code, err.syscall, err.errno, data));`,
	},
	{
		name: 'fs callbacks chained',
		code: `const fs = require('fs'); fs.writeFile('out.txt', 'written', (err) => { console.log('write', err); fs.readFile('out.txt', 'utf8', (e, data) => console.log('read', data)); });`,
	},
	{
		name: 'fs.promises with async/await',
		code: `const fs = require('fs'); (async () => { const raw = await fs.promises.readFile('config.json', 'utf8'); console.log(JSON.parse(raw).name); })(); console.log('sync');`,
	},
	{
		name: 'readFile without encoding gives a Buffer',
		code: `const fs = require('fs'); fs.readFile('file.txt', (err, data) => console.log(data.length, data.toString()));`,
	},
	{
		name: 'readFileSync blocks and returns directly',
		code: `const fs = require('fs'); console.log(fs.readFileSync('file.txt', 'utf8')); setImmediate(() => console.log('later'));`,
	},
	{
		name: 'timers/promises',
		code: `const { setTimeout: sleep } = require('timers/promises'); (async () => { await sleep(20); console.log('after 20'); console.log(await sleep(5, 'value')); })(); setTimeout(() => console.log('10'), 10);`,
	},
	{
		name: 'timer callbacks get this = Timeout and extra arguments',
		code: `setTimeout(function (a, b) { console.log(a, b, typeof this.ref, typeof this.unref); }, 1, 'x', 'y');`,
	},
	{
		name: 'setInterval cleared from a nextTick',
		code: `let n = 0; const id = setInterval(() => { n++; console.log('tick', n); if (n === 2) process.nextTick(() => { clearInterval(id); console.log('cleared'); }); }, 5);`,
	},
	{
		name: 'nextTick passes arguments',
		code: `process.nextTick((a, b) => console.log(a + b), 2, 3);`,
	},

	{
		name: 'article: I/O polling without a blocking loop',
		// Node 23+ reads the file in one request: on a fast disk it can finish
		// before the first check phase
		node22Only: true,
		code: `const fs = require('fs'); setTimeout(() => console.log('hello'), 200); fs.readFile('file.txt', () => console.log('world')); setImmediate(() => console.log('immediate'));`,
	},
	{
		name: 'ES module: Promises before nextTick at startup (Node 22)',
		node22Only: true,
		code: `import fs from 'fs'; process.nextTick(() => console.log('nextTick')); Promise.resolve().then(() => console.log('promise resolve')); console.log('console.log');`,
		isModule: true,
	},
	{
		name: 'ES module: normal order inside a macrotask',
		code: `import { readFile } from 'node:fs'; setImmediate(() => { process.nextTick(() => console.log('nextTick')); Promise.resolve().then(() => console.log('promise resolve')); console.log('console.log'); });`,
		isModule: true,
	},
	{
		name: 'ES module: named and namespace imports',
		code: `import * as fs from 'fs'; import { setTimeout as sleep } from 'timers/promises'; await sleep(5); console.log(typeof fs.readFile, 'slept');`,
		isModule: true,
	},

	// --- review findings: fidelity -------------------------------------------------
	{
		name: 'long synchronous loops are not cut short',
		code: `const a = []; for (let i = 0; i < 12000; i++) a.push(i); console.log(a.length);`,
	},
	{
		name: 'Date follows the timers',
		code: `const start = Date.now(); setTimeout(() => console.log(Date.now() - start >= 40, new Date() instanceof Date), 50);`,
	},
	{
		name: 'CommonJS: this is module.exports, top-level return',
		code: `console.log(this === module.exports, typeof exports); return; console.log('never');`,
	},
	{
		name: 'toString shows the original source',
		code: `function add(a, b) { return Math.max(a, b) + helper(); }\nfunction helper() { return 1; }\nconsole.log(add.toString()); console.log(String(() => helper()));`,
	},
	{
		name: 'async functions and Promise print like Node',
		code: `async function load() {} const arrow = async () => {}; console.log(load, arrow, Promise.name, typeof Promise.withResolvers);`,
	},
	{
		name: 'sparse arrays',
		code: `console.log([, 1], [1, , , 2], new Array(3));`,
	},
	{
		name: 'console.group indents',
		code: `console.group('outer'); console.log('in 1'); console.group(); console.log('in 2'); console.groupEnd(); console.groupEnd(); console.log('out');`,
	},
	{
		name: 'web APIs available in Node',
		code: `console.log(new TextEncoder().encode('hi').length, new URL('https://a.b/c?x=1').searchParams.get('x'), typeof AbortController, btoa('a'));`,
	},
	{
		name: 'assert module',
		code: `const assert = require('assert'); assert.strictEqual(1, 1); assert.deepStrictEqual({ a: [1] }, { a: [1] }); try { assert.strictEqual(1, 2); } catch (e) { console.log(e.code, e.name); } try { assert(0, 'custom'); } catch (e) { console.log(e.message); }`,
	},
];

/**
 * Where the simulator says each printed line runs from, in the words of
 * async_hooks: the kind of the callback at the bottom of the call stack.
 */
const KIND_OF_ORIGIN: Partial<Record<string, string>> = {
	setTimeout: 'Timeout',
	setInterval: 'Timeout',
	setImmediate: 'Immediate',
	fs: 'FSREQCALLBACK',
	nextTick: 'TickObject',
	promise: 'PROMISE',
	await: 'PROMISE',
	thenable: 'PROMISE',
	queueMicrotask: 'Microtask',
	close: 'TCPWRAP',
};

const simulatedKinds = (steps: ReturnType<typeof simulate>['steps']) => {
	const flows = new Map<number, { origin: string; value: string }>();
	const stack: { flow?: number; value: string }[] = [];
	const lines: string[] = [];
	for (const step of steps) {
		if (step.type === 'push' && step.queue !== 'console') {
			if (
				step.flow !== undefined &&
				step.queue !== 'callstack' &&
				!flows.has(step.flow)
			)
				flows.set(step.flow, { origin: step.origin, value: step.value });
			if (step.queue === 'callstack')
				stack.push({ flow: step.flow, value: step.value });
		}
		if (step.type === 'pop' && step.queue === 'callstack') stack.pop();
		if (step.type === 'push' && step.queue === 'console') {
			const bottom = stack[0];
			const source =
				bottom?.flow === undefined ? undefined : flows.get(bottom.flow);
			let kind = 'main';
			if (source?.origin === 'net')
				kind = source.value.startsWith('TCP: connect')
					? 'TCPCONNECTWRAP'
					: source.value.startsWith('TCP: accept')
						? 'TCPSERVERWRAP'
						: 'TCPWRAP';
			else if (source) kind = KIND_OF_ORIGIN[source.origin] ?? source.origin;
			lines.push(`${kind}\u241f${step.value}`);
		}
	}
	return lines;
};

describe('every printed line runs from the same kind of callback as in real Node.js', () => {
	it.each(CASES)('$name', ({ code, isModule, node22Only }) => {
		if (node22Only && NODE_MAJOR > 22) return;
		const native = runNativeProcess(code, isModule, kindPrelude(!!isModule));
		expect(native.status).toBe(0);
		// console.group indentation is the prelude's business, not the kind's
		const trim = (lines: string[]) =>
			lines.map((line) => line.replace(/\u241f\s+/, '\u241f'));
		expect(trim(simulatedKinds(simulate(code).steps))).toEqual(
			trim(native.stdout)
		);
	});
});

describe('simulator matches real Node.js', () => {
	it.each(CASES)('$name', ({ code, isModule, node22Only }) => {
		if (node22Only && NODE_MAJOR > 22) return;
		const expected = runNative(code, isModule);
		const actual = consoleOutput(simulate(code).steps);
		expect(actual).toEqual(expected);
		expect(expected.length).toBeGreaterThan(0);
	});
});

/**
 * Programs that crash or exit early. Node writes the crash report to stderr,
 * the simulator to its console as one "Uncaught ..." / "Warning: ..." line:
 * stdout must match the console without those lines, and the exit codes must
 * be equal. Node's crash report is not console output, so the prelude
 * leaves it on stderr.
 */
const EXIT_CASES: Case[] = [
	{
		name: 'uncaught exception stops the loop (exit 1)',
		code: `setTimeout(() => console.log('first'), 1); setTimeout(() => { throw new Error('boom'); }, 5); setTimeout(() => console.log('never'), 10);`,
	},
	{
		name: 'unhandled rejection: ticks queued by microtasks still run first',
		code: `Promise.reject(new Error('x')); Promise.resolve().then(() => process.nextTick(() => console.log('tick')));`,
	},
	{
		name: 'throwing uncaughtException handler (exit 7)',
		code: `process.on('uncaughtException', () => { throw new Error('again'); }); setTimeout(() => console.log('never'), 1); throw new Error('x');`,
	},
	{
		name: 'process.exit skips finally blocks and later work',
		code: `process.on('exit', (c) => console.log('exit', c)); try { console.log('try'); process.exit(3); } finally { console.log('finally'); }`,
	},
	{
		name: 'process.exitCode is undefined until set',
		code: `console.log(process.exitCode); process.exitCode = 4; console.log(process.exitCode);`,
	},
	{
		name: 'unsettled top-level await (exit 13)',
		code: `console.log('before'); await new Promise(() => {}); console.log('never');`,
		isModule: true,
	},
	{
		name: 'immediates added during check run in the next iteration',
		code: `let b; setImmediate(() => { console.log('A'); clearImmediate(b); setImmediate(() => console.log('D')); }); b = setImmediate(() => console.log('B')); setImmediate(() => console.log('C'));`,
	},
	{
		name: 'fractional delays are truncated',
		code: `setTimeout(() => console.log('c2.5'), 2.5); setTimeout(() => console.log('d2'), 2); setTimeout(() => console.log('a1.9'), 1.9); setTimeout(() => console.log('b1'), 1);`,
	},
	{
		name: 'refresh() re-arms a timer that already fired',
		code: `const t = setTimeout(() => console.log('x'), 1); setTimeout(() => t.refresh(), 5);`,
	},
	{
		name: 'hasRef() follows ref() / unref()',
		code: `const t = setTimeout(() => {}, 1); t.unref(); const i = setImmediate(() => {}); i.unref(); console.log(t.hasRef(), i.hasRef()); t.ref(); i.ref(); console.log(t.hasRef(), i.hasRef());`,
	},
	{
		name: 'process.once + off, removeListener, emit',
		code: `const f = () => console.log('once'); process.once('exit', f); process.off('exit', f); const g = () => console.log('g'); process.on('exit', g); process.removeListener('exit', g); process.on('beforeExit', (c) => console.log('beforeExit', c)); process.emit('beforeExit', 9);`,
	},

	{
		name: 'TCP: connect, accept, destroy, EOF, close (close callbacks phase)',
		macOnly: true,
		code: `const net = require('net'); const server = net.createServer((conn) => { console.log('server connection'); conn.on('close', () => console.log('server-side close')); conn.destroy(); }); server.listen(0, () => { console.log('listening'); const client = net.connect(server.address().port, () => console.log('client connect')); client.on('close', () => { console.log('client close'); server.close(() => console.log('server close')); }); });`,
	},
	{
		name: 'TCP: a socket closes in the close phase, after setImmediate',
		code: `const net = require('net'); const server = net.createServer(); server.listen(0, () => { const client = net.connect(server.address().port, () => { console.log('connected'); client.destroy(); setImmediate(() => console.log('immediate')); process.nextTick(() => console.log('tick')); }); client.on('close', () => { console.log('client close'); server.close(() => console.log('server closed')); }); });`,
	},
	{
		name: 'TCP: server.close() emits close on the next tick',
		code: `const s = require('net').createServer(); s.listen(0, () => { s.close(() => console.log('closed')); setImmediate(() => console.log('immediate')); Promise.resolve().then(() => console.log('promise')); });`,
	},
];

describe('exit codes and crashes match real Node.js', () => {
	it.each(EXIT_CASES)('$name', ({ code, isModule, macOnly }) => {
		if (macOnly && !IS_MAC) return;
		const native = runNativeProcess(code, isModule);
		const { steps } = simulate(code);
		const end = steps.at(-1);
		const printed = consoleOutput(steps).filter(
			(line) => !/^(Uncaught |Warning: )/.test(line)
		);
		expect(printed).toEqual(native.stdout);
		expect(end?.type === 'end' && end.exitCode).toBe(native.status);
	});
});

/**
 * The examples people learn from must show what real Node does. The few
 * that real Node can't run deterministically say so in their own note.
 */
const NOT_DETERMINISTIC: Partial<Record<keyof typeof EXAMPLES, string>> = {
	micVsMacro:
		'setTimeout(0) vs setImmediate from the main module is a race in real Node',
	starvation: 'never ends: the simulator stops it at its step limit',
	threadpool: 'four real threads finish in any order (the example says so)',
	...(!IS_MAC && {
		closePhase:
			"on Linux, epoll delivers the server's 'connection' before the client's connect callback",
	}),
	ioPolling:
		"a 50ms timer racing a real disk read depends on the machine's load; the same logic is checked with a 200ms timer above",
};

describe('every example matches real Node.js', () => {
	it.each(Object.entries(EXAMPLES))('%s', (key, { code }) => {
		if (NOT_DETERMINISTIC[key as keyof typeof EXAMPLES]) return;
		const isModule = /^\s*import\s/m.test(code);
		if (isModule && NODE_MAJOR > 22) return;
		const { steps } = simulate(code);
		const end = steps.at(-1);
		const native = runNativeProcess(code, isModule);
		const printed = consoleOutput(steps).filter(
			(line) => !/^(Uncaught |Warning: )/.test(line)
		);
		expect(printed).toEqual(native.stdout);
		expect(end?.type === 'end' && end.exitCode).toBe(native.status);
		const kinds = runNativeProcess(code, isModule, kindPrelude(isModule));
		const trim = (lines: string[]) =>
			lines.map((line) => line.replace(/\u241f\s+/, '\u241f'));
		expect(
			trim(simulatedKinds(steps)).filter(
				(line) => !/\u241f(Uncaught |Warning: )/.test(line)
			)
		).toEqual(trim(kinds.stdout));
	});
});
