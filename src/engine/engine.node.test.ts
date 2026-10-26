// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { EXAMPLES } from '@/examples';
import {
	consoleOutput,
	EngineError,
	simulate,
	type Phase,
	type SimStep,
} from './index';
import { instrument } from './instrument';
import { THREADPOOL_SIZE } from './runtime';

/**
 * Node.js behaviour that engine.differential.test.ts can't compare against a
 * real process (crashes, exit codes, the loop's internals) plus structural
 * guarantees of the recorded steps.
 */

const output = (code: string) => consoleOutput(simulate(code).steps);
const endOf = (code: string) => {
	const end = simulate(code).steps.at(-1);
	if (end?.type !== 'end') throw new Error('missing end step');
	return end;
};

const engineError = (code: string) => {
	try {
		simulate(code);
	} catch (error) {
		if (error instanceof EngineError) return error;
		throw error;
	}
	throw new Error('expected an EngineError');
};

/** "timers@1" = the timers phase of loop iteration 1. */
const phases = (steps: SimStep[]) =>
	steps.flatMap((s) =>
		s.type === 'phase' ? [`${s.phase}@${s.iteration}`] : []
	);

describe('process lifecycle', () => {
	it('a synchronous program never enters the loop', () => {
		const { steps } = simulate(`console.log('only main')`);
		expect(phases(steps)).toEqual(['main@0']);
		expect(endOf(`console.log(1)`)).toMatchObject({
			exitCode: 0,
			crashed: false,
			truncated: false,
		});
	});

	it('runs the six phases in libuv order every iteration', () => {
		const { steps } = simulate(`setTimeout(() => {}, 1)`);
		expect(phases(steps)).toEqual([
			'main@0',
			'timers@1',
			'pending@1',
			'idle@1',
			'poll@1',
			'check@1',
			'close@1',
			'timers@2',
			'pending@2',
			'idle@2',
			'poll@2',
			'check@2',
			'close@2',
		]);
	});

	it('poll blocks until the next timer when nothing else is pending', () => {
		const { steps } = simulate(`setTimeout(() => console.log('t'), 50)`);
		const wait = steps.find((s) => s.type === 'wait');
		expect(wait).toMatchObject({ time: 0, until: 50, reason: 'timer' });
	});

	it('an immediate added during check runs in the next iteration', () => {
		const { steps } = simulate(`
			setImmediate(() => setImmediate(() => console.log('later')));
		`);
		let iteration = 0;
		let printedIn = -1;
		for (const step of steps) {
			if (step.type === 'phase') iteration = step.iteration;
			if (step.type === 'push' && step.queue === 'console')
				printedIn = iteration;
		}
		expect(printedIn).toBe(2);
	});

	it('poll does not block while immediates are pending', () => {
		const { steps } = simulate(
			`setTimeout(() => {}, 50); setImmediate(() => {});`
		);
		const firstWait = steps.find((s) => s.type === 'wait');
		const check = steps.findIndex(
			(s) => s.type === 'phase' && s.phase === 'check'
		);
		expect(steps.indexOf(firstWait!)).toBeGreaterThan(check);
	});

	it('counts refs and exits when they reach zero', () => {
		const { steps } = simulate(`
			setTimeout(() => {}, 5);
			setImmediate(() => {});
			require('fs').readFile('file.txt', () => {});
		`);
		const refs = steps.flatMap((s) => (s.type === 'phase' ? [s.refs] : []));
		// main: nothing scheduled yet; then timer + immediate + fs job
		expect(refs[0]).toBe(0);
		expect(refs[1]).toBe(3);
		expect(refs.at(-1)).toBe(0);
	});

	it('beforeExit can schedule more work, exit runs last', () => {
		expect(
			output(`
				let rounds = 0;
				process.on('beforeExit', (code) => {
					if (rounds++ < 2) setTimeout(() => console.log('round', rounds), 1);
				});
				process.on('exit', (code) => console.log('exit', code));
				console.log('main');
			`)
		).toEqual(['main', 'round 1', 'round 2', 'exit 0']);
	});

	it('process.exit stops everything immediately', () => {
		const code = `
			setTimeout(() => console.log('never'), 1);
			process.nextTick(() => { console.log('tick'); process.exit(3); });
			process.on('exit', (c) => console.log('exit', c));
		`;
		expect(output(code)).toEqual(['tick', 'exit 3']);
		expect(endOf(code)).toMatchObject({ exitCode: 3, crashed: false });
	});

	it('process.exitCode is used when the loop ends', () => {
		expect(endOf(`process.exitCode = 2;`).exitCode).toBe(2);
	});
});

describe('crashes like Node', () => {
	it('an uncaught exception kills the process', () => {
		const code = `
			setTimeout(() => { throw new Error('boom'); }, 1);
			setTimeout(() => console.log('never printed'), 5);
			process.on('exit', (c) => console.log('exit', c));
		`;
		expect(output(code)).toEqual(['Uncaught Error: boom', 'exit 1']);
		expect(endOf(code)).toMatchObject({ exitCode: 1, crashed: true });
	});

	it('an unhandled rejection kills the process (Node >= 15)', () => {
		expect(
			output(`
				Promise.reject(new Error('nobody listens'));
				setTimeout(() => console.log('never printed'), 1);
			`)
		).toEqual(['Uncaught Error: nobody listens']);
		expect(output(`Promise.reject(42)`)[0]).toMatch(
			/^Uncaught \[UnhandledPromiseRejection: .*reason "42"\.\]$/
		);
	});

	it('a rejection handled in the same drain is fine', () => {
		expect(
			output(`
				const p = Promise.reject(1);
				process.nextTick(() => p.catch(() => console.log('handled')));
			`)
		).toEqual(['handled']);
	});

	it('uncaughtException listeners keep the process alive', () => {
		expect(
			output(`
				process.on('uncaughtException', (err, origin) => console.log('caught', err.message, origin));
				setTimeout(() => { throw new Error('a'); }, 1);
				setTimeout(() => console.log('still running'), 5);
				Promise.reject(new Error('b'));
			`)
		).toEqual([
			'caught b unhandledRejection',
			'caught a uncaughtException',
			'still running',
		]);
	});

	it('unhandledRejection listeners receive the reason', () => {
		expect(
			output(`
				process.on('unhandledRejection', (reason) => console.log('reason', reason));
				Promise.reject('x');
			`)
		).toEqual(['reason x']);
	});

	it('names the callee that is not a function', () => {
		expect(output(`const o = {}; o.missing();`)).toEqual([
			'Uncaught TypeError: o.missing is not a function',
		]);
	});

	it('validates callbacks like Node', () => {
		expect(output(`setTimeout('code', 1)`)).toEqual([
			'Uncaught TypeError: The "callback" argument must be of type function. Received type string (code)',
		]);
		expect(output(`process.nextTick()`)[0]).toContain(
			'The "callback" argument must be of type function. Received undefined'
		);
	});

	it('throws a RangeError on runaway recursion', () => {
		expect(
			output(`
				function down() { return down(); }
				try { down(); } catch (e) { console.log(e.name); }
			`)
		).toEqual(['RangeError']);
	});
});

describe('timers', () => {
	it('coerces delays below 1ms to 1ms', () => {
		const delays = simulate(`
			setTimeout(() => {}, 0); setTimeout(() => {}, -5);
			setTimeout(() => {}, 'abc'); setTimeout(() => {}, 7);
		`).steps.flatMap((s) =>
			s.type === 'push' && s.queue === 'libuv' ? [s.end! - s.start] : []
		);
		expect(delays).toEqual([1, 1, 1, 7]);
	});

	it('unref() lets the process exit while an interval is active', () => {
		const code = `
			const interval = setInterval(() => console.log('tick'), 10);
			console.log(interval.hasRef());
			setTimeout(() => { interval.unref(); console.log('unref'); }, 25);
		`;
		expect(output(code)).toEqual(['true', 'tick', 'tick', 'unref']);
		expect(endOf(code).truncated).toBe(false);
	});

	it('an unref-ed timer alone does not keep the loop alive', () => {
		expect(
			output(`setTimeout(() => console.log('never'), 5).unref();`)
		).toEqual([]);
	});

	it('clearTimeout accepts the Timeout object or its id', () => {
		expect(
			output(`
				const a = setTimeout(() => console.log('a'), 1);
				const b = setTimeout(() => console.log('b'), 1);
				clearTimeout(a); clearTimeout(+b);
				setTimeout(() => console.log('c'), 1);
			`)
		).toEqual(['c']);
	});

	it('a timer cleared by an earlier timer of the same phase does not run', () => {
		expect(
			output(`
				setTimeout(() => clearTimeout(late), 1);
				const late = setTimeout(() => console.log('should not run'), 1);
				setTimeout(() => console.log('ran'), 1);
			`)
		).toEqual(['ran']);
	});
});

describe('libuv thread pool', () => {
	it(`runs ${THREADPOOL_SIZE} fs jobs at once; the rest wait for a worker`, () => {
		const { steps } = simulate(`
			const fs = require('fs');
			for (let i = 0; i < 6; i++) fs.stat('file.txt', () => {});
		`);
		const starts = steps.flatMap((s) =>
			s.type === 'push' && s.queue === 'libuv' ? [s.start] : []
		);
		expect(starts).toEqual([0, 0, 0, 0, 2, 2]);
	});

	it('readFile is open -> fstat -> read -> close, each through poll', () => {
		const { steps } = simulate(
			`require('fs').readFile('file.txt', () => console.log('done'))`
		);
		const jobs = steps.flatMap((s) =>
			s.type === 'push' && s.queue === 'libuv' ? [s.value] : []
		);
		expect(jobs).toEqual([
			"fs.readFile('file.txt') · open",
			"fs.readFile('file.txt') · fstat",
			"fs.readFile('file.txt') · read",
			"fs.readFile('file.txt') · close",
		]);
		const pollItems = steps.flatMap((s) =>
			s.type === 'push' && s.queue === 'poll' ? [s.origin] : []
		);
		expect(pollItems).toEqual(['fsInternal', 'fsInternal', 'fsInternal', 'fs']);
	});

	it('a missing file fails at open', () => {
		const { steps } = simulate(
			`require('fs').readFile('nope.txt', (err) => console.log(err.message))`
		);
		expect(consoleOutput(steps)).toEqual([
			"ENOENT: no such file or directory, open 'nope.txt'",
		]);
		expect(
			steps.filter((s) => s.type === 'push' && s.queue === 'libuv')
		).toHaveLength(1);
	});

	it('supports fs.promises and util.promisify', () => {
		expect(
			output(`
				const fs = require('fs');
				const { promisify } = require('util');
				const stat = promisify(fs.stat);
				(async () => {
					await fs.promises.writeFile('a.txt', 'abc');
					const info = await stat('a.txt');
					console.log(info.size, fs.existsSync('a.txt'));
					await promisify(setTimeout)(5);
					console.log(await fs.promises.readdir('.'));
				})();
			`)
		).toEqual(['3 true', "[ 'a.txt', 'config.json', 'file.txt', 'notes.md' ]"]);
	});
});

describe('close callbacks', () => {
	/** The phase each console line was printed in. */
	const printedIn = (steps: SimStep[]) => {
		let phase: Phase = 'main';
		const result: Record<string, Phase> = {};
		for (const step of steps) {
			if (step.type === 'phase') phase = step.phase;
			if (step.type === 'push' && step.queue === 'console')
				result[step.value] = phase;
		}
		return result;
	};

	it('socket.destroy(): the close event runs in the close callbacks phase', () => {
		const { steps } = simulate(`
			const net = require('net');
			const server = net.createServer();
			server.listen(0, () => {
				const client = net.connect(server.address().port, () => {
					console.log('connected');
					client.destroy();
				});
				client.on('close', () => { console.log('client close'); server.close(); });
			});
		`);
		expect(printedIn(steps)).toEqual({
			connected: 'poll',
			'client close': 'close',
		});
	});

	it('server.close(): libuv closes the handle in the close phase, the callback runs on the next tick', () => {
		const { steps } = simulate(`
			const server = require('net').createServer();
			server.listen(8080, () => {
				console.log('listening on', server.address().port);
				setImmediate(() => server.close(() => console.log('closed')));
			});
		`);
		expect(consoleOutput(steps)).toEqual(['listening on 8080', 'closed']);
		// printed while draining the nextTick queue after the immediate
		expect(printedIn(steps).closed).toBe('check');
		// libuv's own close work still shows up in the close phase, without a frame
		expect(
			steps.some(
				(s) =>
					s.type === 'push' &&
					s.queue === 'close' &&
					s.value.startsWith('uv_close(')
			)
		).toBe(true);
	});

	it('connecting to a port nobody listens on fails in poll', () => {
		expect(
			output(`
				const s = require('net').connect(1);
				s.on('error', (e) => console.log(e.code, e.syscall));
				s.on('close', (hadError) => console.log('close', hadError));
			`)
		).toEqual(['ECONNREFUSED connect', 'close true']);
	});

	it('a server that is never closed keeps the process alive', () => {
		expect(
			simulate(`require('net').createServer().listen(3000)`).truncated
		).toBe(true);
	});
});

describe('EventEmitter', () => {
	it('emits synchronously, in order, with once()', () => {
		expect(
			output(`
				const EventEmitter = require('events');
				const e = new EventEmitter();
				e.on('x', (v) => console.log('on', v));
				e.once('x', (v) => console.log('once', v));
				console.log('before');
				e.emit('x', 1); e.emit('x', 2);
				console.log('after', e.listenerCount('x'));
			`)
		).toEqual(['before', 'on 1', 'once 1', 'on 2', 'after 1']);
	});
});

describe('sandbox', () => {
	it('never reaches the real page or machine', () => {
		expect(
			output(`
				console.log(typeof window, typeof document, typeof fetch);
				try { document.title = 'x'; } catch (e) { console.log(e.message); }
				console.log(require('fs').readdirSync('/app'));
				require('child_process');
			`)
		).toEqual([
			'undefined undefined undefined',
			'document is not defined',
			"[ 'config.json', 'file.txt', 'notes.md' ]",
			expect.stringMatching(
				/^Uncaught Error: Cannot find module 'child_process'/
			),
		]);
	});

	it('provides the Node globals', () => {
		expect(
			output(`
				console.log(__filename, __dirname, typeof module.exports, global === globalThis);
				console.log(Buffer.from('hi'), Buffer.from('hi').toString('hex'));
				console.log(process.platform, process.argv.length);
			`)
		).toEqual([
			'/app/main.js /app object true',
			'<Buffer 68 69> 6869',
			'linux 2',
		]);
	});
});

describe('limits', () => {
	it('stops an infinite synchronous loop with an error', () => {
		expect(engineError(`while (true) {}`).code).toBe('operationLimit');
	});

	it('cannot be fooled by catching the stop signal', () => {
		expect(
			engineError(`while (true) { try { for (;;) {} } catch (e) {} }`).code
		).toBe('operationLimit');
	});

	it('truncates programs that never stop (and starving nextTick loops)', () => {
		expect(simulate(`setInterval(() => {}, 100)`).truncated).toBe(true);
		const starving = simulate(`
			const again = () => process.nextTick(again); again();
			setTimeout(() => console.log('never'), 0);
		`);
		expect(starving.truncated).toBe(true);
		expect(consoleOutput(starving.steps)).toEqual([]);
	});
});

describe('unsupported code fails loudly instead of lying', () => {
	it.each([
		['export const a = 1;', 'export / import()'],
		['import("fs")', 'export / import()'],
		['eval("1")', 'eval'],
		['async function* g() {}', 'async generator'],
		['(async () => { for await (const x of []) {} })()', 'for await...of'],
		['const __elx = 1;', '__elx'],
	])('%s', (code, feature) => {
		const error = engineError(code);
		expect(error.code).toBe('unsupportedSyntax');
		expect(error.params.feature).toBe(feature);
		expect(error.range).toBeDefined();
	});

	it('reports syntax errors with a position', () => {
		const error = engineError(`console.log(1);\nconsole.log(`);
		expect(error.code).toBe('syntax');
		expect(error.params).toMatchObject({ line: 2, column: 13 });
	});
});

describe('call stack', () => {
	const snapshots = (steps: SimStep[]) => {
		const stack: string[] = [];
		const result: string[] = [];
		for (const step of steps) {
			if (step.type === 'push' && step.queue === 'callstack') {
				stack.push(step.value);
				result.push(stack.join(' > '));
			}
			if (step.type === 'pop' && step.queue === 'callstack') stack.pop();
		}
		return result;
	};

	it('nests calls under the main module', () => {
		expect(
			snapshots(
				simulate(
					`function a() { b(); } function b() { console.log('x'); } a();`
				).steps
			)
		).toEqual([
			'main.js',
			'main.js > a()',
			'main.js > a() > b()',
			"main.js > a() > b() > console.log('x')",
		]);
	});

	it('labels queued callbacks with their source', () => {
		const labels = simulate(`
			function named() {}
			setTimeout(named, 1);
			setImmediate(() => {});
			process.nextTick(function tick() {});
		`).steps.flatMap((s) =>
			s.type === 'push' && s.queue !== 'callstack' && s.queue !== 'console'
				? [`${s.queue}: ${s.value}`]
				: []
		);
		expect(labels).toEqual([
			'libuv: function named() {}',
			'check: () => {}',
			'nextTick: function tick() {}',
			'timers: function named() {}',
		]);
	});
});

/** Structural invariants every simulation must satisfy, checked on many programs. */
const PROGRAMS = [
	...Object.values(EXAMPLES).map((e) => e.code),
	`setTimeout(() => console.log(1), 1); setTimeout(() => console.log(1), 1);`,
	`const id = setInterval(() => {}, 10); setTimeout(() => clearInterval(id), 100);`,
	`async function f() { await null; await new Promise(r => setTimeout(r, 30)); } f(); f();`,
	`const fs = require('fs'); for (let i = 0; i < 9; i++) fs.readFile('file.txt', () => {});`,
	`setImmediate(() => { throw 1; });`,
	`const s = require('net').createServer().listen(1, () => s.close());`,
	`setInterval(() => console.log('forever'), 50);`,
];

describe('step invariants', () => {
	it.each(PROGRAMS)('%s', (code) => {
		const { steps, truncated } = simulate(code);
		expect(steps[0].type).toBe('start');
		expect(steps.at(-1)?.type).toBe('end');

		const live = new Map<number, string>();
		const seen = new Set<number>();
		const stack: number[] = [];
		let time = -Infinity;

		for (const step of steps) {
			expect(step.time).toBeGreaterThanOrEqual(time);
			time = step.time;
			if (step.type === 'push') {
				expect(seen.has(step.id)).toBe(false);
				seen.add(step.id);
				if (step.queue !== 'console') live.set(step.id, step.queue);
				if (step.queue === 'callstack') stack.push(step.id);
			}
			if (
				step.type === 'pop' ||
				step.type === 'shift' ||
				step.type === 'delete'
			) {
				expect(live.get(step.id)).toBe(step.queue);
				live.delete(step.id);
				if (step.type === 'pop') expect(stack.pop()).toBe(step.id);
			}
		}
		const end = steps.at(-1);
		// a crash or a cut-short run leaves work behind, like a killed process
		if (!truncated && end?.type === 'end' && !end.crashed) {
			expect(stack).toEqual([]);
			expect([...live.values()]).toEqual([]);
		}
	});
});

describe('instrumentation', () => {
	it('produces code without any reference to the real globals', () => {
		const { code } = instrument(
			`document.body; fetch(); setTimeout(() => {}, 0)`
		);
		expect(code).toContain('__elx.g("document")');
		expect(code).toContain('__elx.g("fetch")');
	});

	it('turns imports into require() and hoists them', () => {
		const { code, isModule } = instrument(
			`console.log(1);\nimport fs, { readFile as rf } from 'node:fs';`
		);
		expect(isModule).toBe(true);
		expect(code.indexOf('require')).toBeLessThan(code.indexOf('console'));
		expect(code).toContain('readFile: rf');
	});
});
