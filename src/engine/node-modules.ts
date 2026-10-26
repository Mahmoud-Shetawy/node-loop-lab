import { formatArgs, inspect, INSPECT } from './format';
import { invalidCallback } from './errors';
import type { FsStage, NodeHost, ProcessEvent } from './runtime';

/**
 * The parts of Node.js the simulator provides. They are written against
 * {@link NodeHost}, so every asynchronous API goes through the simulated
 * libuv loop: timers, the thread pool (fs), handles (net) and the
 * nextTick / microtask queues.
 */

type Callable = (...args: unknown[]) => unknown;

const isCallable = (value: unknown): value is Callable =>
	typeof value === 'function';

/**
 * The syscalls behind each fs call (as libuv runs them) and how long each
 * takes on a worker, in simulated ms. A failing call stops at its first
 * stage, e.g. readFile on a missing file fails in `open`.
 */
export const FS_STAGES = {
	readFile: [
		{ name: 'open', duration: 1 },
		{ name: 'fstat', duration: 1 },
		{ name: 'read', duration: 2 },
		{ name: 'close', duration: 1 },
	],
	writeFile: [
		{ name: 'open', duration: 1 },
		{ name: 'write', duration: 3 },
		{ name: 'close', duration: 1 },
	],
	appendFile: [
		{ name: 'open', duration: 1 },
		{ name: 'write', duration: 3 },
		{ name: 'close', duration: 1 },
	],
	stat: [{ name: 'stat', duration: 2 }],
	access: [{ name: 'access', duration: 2 }],
	readdir: [{ name: 'scandir', duration: 3 }],
	unlink: [{ name: 'unlink', duration: 3 }],
} as const satisfies Record<string, readonly FsStage[]>;

const stagesFor = (name: keyof typeof FS_STAGES, failed: boolean) =>
	failed ? FS_STAGES[name].slice(0, 1) : FS_STAGES[name];

/** The files every simulation starts with, relative to /app. */
export const INITIAL_FILES: Record<string, string> = {
	'file.txt': 'Hello from file.txt',
	'config.json': '{"name":"node-loop-lab","port":3000}',
	'notes.md': '# Notes\nThe event loop has six phases.',
};

const nodeError = (
	message: string,
	props: Record<string, unknown>,
	Base: ErrorConstructor = Error
) => {
	const error = new Base(message);
	for (const [key, value] of Object.entries(props))
		Object.defineProperty(error, key, {
			value,
			enumerable: true,
			configurable: true,
			writable: true,
		});
	return error;
};

const enoent = (syscall: string, path: string) =>
	nodeError(`ENOENT: no such file or directory, ${syscall} '${path}'`, {
		errno: -2,
		code: 'ENOENT',
		syscall,
		path,
	});

// --- Buffer ---------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class SimBuffer extends Uint8Array {
	static from(value: unknown): SimBuffer {
		if (typeof value === 'string') return new SimBuffer(encoder.encode(value));
		if (value instanceof Uint8Array || Array.isArray(value))
			return new SimBuffer(value as ArrayLike<number>);
		throw new TypeError(
			'The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object.'
		);
	}

	static alloc(size: number) {
		return new SimBuffer(size);
	}

	static isBuffer(value: unknown) {
		return value instanceof SimBuffer;
	}

	static byteLength(value: unknown) {
		return typeof value === 'string'
			? encoder.encode(value).length
			: (value as Uint8Array).length;
	}

	static concat(list: Uint8Array[]) {
		const total = list.reduce((sum, b) => sum + b.length, 0);
		const result = new SimBuffer(total);
		let offset = 0;
		for (const b of list) {
			result.set(b, offset);
			offset += b.length;
		}
		return result;
	}

	toString(encoding = 'utf8') {
		if (encoding === 'hex')
			return [...this].map((b) => b.toString(16).padStart(2, '0')).join('');
		if (encoding === 'base64') return btoa(String.fromCharCode(...this));
		return decoder.decode(this);
	}

	toJSON() {
		return { type: 'Buffer', data: [...this] };
	}

	[INSPECT]() {
		const shown = [...this.slice(0, 50)]
			.map((b) => b.toString(16).padStart(2, '0'))
			.join(' ');
		const more = this.length > 50 ? ` ... ${this.length - 50} more bytes` : '';
		return `<Buffer${shown ? ` ${shown}` : ''}${more}>`;
	}
}

// --- EventEmitter -----------------------------------------------------------------

export const createEventEmitter = (host: NodeHost) => {
	const listenersOf = new WeakMap<object, Map<PropertyKey, Callable[]>>();
	const ONCE = Symbol('once');

	const table = (emitter: object) => {
		let map = listenersOf.get(emitter);
		if (!map) {
			map = new Map();
			listenersOf.set(emitter, map);
		}
		return map;
	};

	class EventEmitter {
		on(event: PropertyKey, listener: unknown) {
			if (!isCallable(listener)) throw invalidCallback('listener', listener);
			const map = table(this);
			map.set(event, [...(map.get(event) ?? []), listener]);
			return this;
		}

		addListener(event: PropertyKey, listener: unknown) {
			return this.on(event, listener);
		}

		prependListener(event: PropertyKey, listener: unknown) {
			if (!isCallable(listener)) throw invalidCallback('listener', listener);
			const map = table(this);
			map.set(event, [listener, ...(map.get(event) ?? [])]);
			return this;
		}

		once(event: PropertyKey, listener: unknown) {
			if (!isCallable(listener)) throw invalidCallback('listener', listener);
			const wrapper = (...args: unknown[]) => {
				this.off(event, wrapper);
				return host.callWithFrame(listener, this, args);
			};
			(wrapper as unknown as Record<symbol, unknown>)[ONCE] = listener;
			Object.defineProperty(wrapper, 'name', { value: listener.name });
			return this.on(event, wrapper);
		}

		off(event: PropertyKey, listener: unknown) {
			const map = table(this);
			const list = map.get(event) ?? [];
			const index = list.findIndex(
				(l) =>
					l === listener ||
					(l as unknown as Record<symbol, unknown>)[ONCE] === listener
			);
			if (index !== -1)
				map.set(event, [...list.slice(0, index), ...list.slice(index + 1)]);
			return this;
		}

		removeListener(event: PropertyKey, listener: unknown) {
			return this.off(event, listener);
		}

		removeAllListeners(event?: PropertyKey) {
			if (event === undefined) listenersOf.delete(this);
			else table(this).delete(event);
			return this;
		}

		/** Listeners run synchronously, in registration order. */
		emit(event: PropertyKey, ...args: unknown[]) {
			const list = table(this).get(event) ?? [];
			if (event === 'error' && !list.length)
				throw args[0] instanceof Error
					? args[0]
					: new Error(`Unhandled error. (${inspect(args[0])})`);
			for (const listener of [...list]) {
				if ((listener as unknown as Record<symbol, unknown>)[ONCE])
					Reflect.apply(listener, this, args);
				else host.callWithFrame(listener, this, args);
			}
			return list.length > 0;
		}

		listenerCount(event: PropertyKey) {
			return (table(this).get(event) ?? []).length;
		}

		listeners(event: PropertyKey) {
			return (table(this).get(event) ?? []).map(
				(l) =>
					((l as unknown as Record<symbol, unknown>)[ONCE] as Callable) ?? l
			);
		}

		eventNames() {
			return [...table(this).keys()];
		}
	}

	return EventEmitter;
};

// --- everything together ------------------------------------------------------------

export const createNodeModules = (
	host: NodeHost,
	objects: {
		timeoutObjects: Map<number, unknown>;
		immediateObjects: Map<number, unknown>;
	}
) => {
	const { Promise: SimPromise } = host;
	const EventEmitter = createEventEmitter(host);

	// --- timers ---------------------------------------------------------------------

	class Timeout {
		#handle: number;
		constructor(handle: number) {
			this.#handle = handle;
		}
		ref() {
			host.setTimerRef(this.#handle, true);
			return this;
		}
		unref() {
			host.setTimerRef(this.#handle, false);
			return this;
		}
		hasRef() {
			return host.timerHasRef(this.#handle);
		}
		refresh() {
			host.refreshTimer(this.#handle);
			return this;
		}
		close() {
			host.clearTimer(this.#handle);
			return this;
		}
		[Symbol.toPrimitive]() {
			return this.#handle;
		}
	}

	class Immediate {
		#handle: number;
		constructor(handle: number) {
			this.#handle = handle;
		}
		#ref = true;
		ref() {
			this.#ref = true;
			host.setImmediateRef(this.#handle, true);
			return this;
		}
		unref() {
			this.#ref = false;
			host.setImmediateRef(this.#handle, false);
			return this;
		}
		hasRef() {
			return this.#ref;
		}
		[Symbol.toPrimitive]() {
			return this.#handle;
		}
	}

	const handleOf = (value: unknown) => {
		if (value instanceof Timeout || value instanceof Immediate)
			return Number(value);
		return typeof value === 'number' || typeof value === 'string'
			? Number(value)
			: NaN;
	};

	const timer =
		(name: 'setTimeout' | 'setInterval') =>
		(callback: unknown, delay?: unknown, ...args: unknown[]) => {
			if (!isCallable(callback)) throw invalidCallback('callback', callback);
			const handle = host.addTimer(
				name,
				callback,
				host.describe(callback),
				delay,
				args
			);
			const timeout = new Timeout(handle);
			objects.timeoutObjects.set(handle, timeout);
			return timeout;
		};

	const setTimeout = timer('setTimeout');
	const setInterval = timer('setInterval');
	const clearTimeout = (value?: unknown) => {
		const handle = handleOf(value);
		if (!Number.isNaN(handle)) host.clearTimer(handle);
	};

	const setImmediate = (callback: unknown, ...args: unknown[]) => {
		if (!isCallable(callback)) throw invalidCallback('callback', callback);
		const handle = host.addImmediate(callback, host.describe(callback), args);
		const immediate = new Immediate(handle);
		objects.immediateObjects.set(handle, immediate);
		return immediate;
	};
	const clearImmediate = (value?: unknown) => {
		const handle = handleOf(value);
		if (!Number.isNaN(handle)) host.clearImmediate(handle);
	};

	/** Resolves `capability` from a timer / immediate callback. */
	const timersPromises = {
		setTimeout: (delay?: unknown, value?: unknown) => {
			const { promise, resolve } = host.newPromiseCapability();
			const settle = () => resolve(value);
			host.addTimer(
				'setTimeout',
				settle,
				{ label: `timers/promises.setTimeout(${inspect(delay ?? 1)})` },
				delay,
				[]
			);
			return promise;
		},
		setImmediate: (value?: unknown) => {
			const { promise, resolve } = host.newPromiseCapability();
			host.addImmediate(
				() => resolve(value),
				{ label: 'timers/promises.setImmediate()' },
				[]
			);
			return promise;
		},
	};

	const PROMISIFY = Symbol.for('nodejs.util.promisify.custom');
	Object.defineProperty(setTimeout, PROMISIFY, {
		value: timersPromises.setTimeout,
	});
	Object.defineProperty(setImmediate, PROMISIFY, {
		value: timersPromises.setImmediate,
	});

	// --- process ----------------------------------------------------------------------

	const PROCESS_EVENTS = new Set<ProcessEvent>([
		'exit',
		'beforeExit',
		'uncaughtException',
		'unhandledRejection',
	]);

	/** once() wrappers -> the listener they wrap, so off() can find them */
	const onceOriginal = new WeakMap<Callable, unknown>();
	/** process.exitCode is undefined until the program sets it */
	let exitCode: number | undefined;

	const listenersFor = (event: string) =>
		PROCESS_EVENTS.has(event as ProcessEvent)
			? host.processListeners[event as ProcessEvent]
			: null;

	const process = {
		nextTick: (callback: unknown, ...args: unknown[]) => {
			if (!isCallable(callback)) throw invalidCallback('callback', callback);
			host.nextTick(callback, host.describe(callback), args);
		},
		exit: (code?: unknown) => {
			host.exit(code === undefined ? host.exitCode : Number(code) || 0);
		},
		get exitCode() {
			return exitCode;
		},
		set exitCode(code: number | undefined) {
			exitCode = code === undefined ? undefined : Number(code) || 0;
			host.exitCode = exitCode ?? 0;
		},
		on(event: string, listener: unknown) {
			if (!isCallable(listener)) throw invalidCallback('listener', listener);
			listenersFor(event)?.push(listener);
			return process;
		},
		addListener(event: string, listener: unknown) {
			return process.on(event, listener);
		},
		once(event: string, listener: unknown) {
			if (!isCallable(listener)) throw invalidCallback('listener', listener);
			const list = listenersFor(event);
			if (!list) return process;
			const wrapper = (...args: unknown[]) => {
				const index = list.indexOf(wrapper);
				if (index !== -1) list.splice(index, 1);
				return Reflect.apply(listener, process, args);
			};
			Object.defineProperty(wrapper, 'name', { value: listener.name });
			onceOriginal.set(wrapper, listener);
			list.push(wrapper);
			return process;
		},
		off(event: string, listener: unknown) {
			const list = listenersFor(event);
			const index =
				list?.findIndex(
					(l) => l === listener || onceOriginal.get(l) === listener
				) ?? -1;
			if (list && index !== -1) list.splice(index, 1);
			return process;
		},
		removeListener(event: string, listener: unknown) {
			return process.off(event, listener);
		},
		removeAllListeners(event?: string) {
			for (const name of event === undefined ? PROCESS_EVENTS : [event])
				listenersFor(name)?.splice(0);
			return process;
		},
		/** Listeners run synchronously, like any EventEmitter. */
		emit(event: string, ...args: unknown[]) {
			const list = listenersFor(event) ?? [];
			for (const listener of [...list])
				host.callWithFrame(listener, process, args);
			return list.length > 0;
		},
		listenerCount(event: string) {
			return listenersFor(event)?.length ?? 0;
		},
		argv: ['/usr/local/bin/node', '/app/main.js'],
		env: { NODE_ENV: 'development' },
		platform: 'linux',
		pid: 4242,
		version: 'v22.0.0',
		versions: { node: '22.0.0', v8: '12.4', uv: '1.48.0' },
		cwd: () => '/app',
		uptime: () => host.time / 1000,
		hrtime: Object.assign(
			(previous?: [number, number]) => {
				const ns = Math.round(host.time * 1e6);
				const now: [number, number] = [Math.floor(ns / 1e9), ns % 1e9];
				if (!previous) return now;
				const diff = ns - (previous[0] * 1e9 + previous[1]);
				return [Math.floor(diff / 1e9), diff % 1e9];
			},
			{ bigint: () => BigInt(Math.round(host.time * 1e6)) }
		),
		memoryUsage: () => ({ rss: 30_000_000, heapUsed: 4_000_000 }),
		stdout: {
			write: (chunk: unknown) => {
				host.print('log', String(chunk).replace(/\n$/, ''));
				return true;
			},
		},
		stderr: {
			write: (chunk: unknown) => {
				host.print('error', String(chunk).replace(/\n$/, ''));
				return true;
			},
		},
	};

	// --- fs -----------------------------------------------------------------------------

	const files = new Map(Object.entries(INITIAL_FILES));

	const normalise = (path: unknown) => {
		if (typeof path !== 'string')
			throw nodeError(
				`The "path" argument must be of type string. Received ${inspect(path)}`,
				{ code: 'ERR_INVALID_ARG_TYPE' },
				TypeError
			);
		return path.replace(/^(\/app\/|\.\/)/, '');
	};

	const encodingOf = (options: unknown) =>
		typeof options === 'string'
			? options
			: ((options as { encoding?: string } | undefined)?.encoding ?? null);

	const decode = (content: string, options: unknown) =>
		encodingOf(options) ? content : SimBuffer.from(content);

	const toText = (data: unknown) =>
		data instanceof Uint8Array ? decoder.decode(data) : String(data);

	const stats = (content: string) => ({
		size: encoder.encode(content).length,
		isFile: () => true,
		isDirectory: () => false,
		mtimeMs: host.time,
	});

	/** Every fs operation, run synchronously; async APIs wrap it in the pool. */
	const operations = {
		readFile: (path: unknown, options?: unknown) => {
			const name = normalise(path);
			const content = files.get(name);
			if (content === undefined) throw enoent('open', String(path));
			return decode(content, options);
		},
		writeFile: (path: unknown, data: unknown) => {
			files.set(normalise(path), toText(data));
		},
		appendFile: (path: unknown, data: unknown) => {
			const name = normalise(path);
			files.set(name, (files.get(name) ?? '') + toText(data));
		},
		readdir: (path: unknown) => {
			normalise(path);
			return [...files.keys()].sort();
		},
		stat: (path: unknown) => {
			const content = files.get(normalise(path));
			if (content === undefined) throw enoent('stat', String(path));
			return stats(content);
		},
		access: (path: unknown) => {
			if (!files.has(normalise(path))) throw enoent('access', String(path));
		},
		unlink: (path: unknown) => {
			const name = normalise(path);
			if (!files.delete(name)) throw enoent('unlink', String(path));
		},
	};

	type Operation = keyof typeof operations;

	/** `fs.readFile(path, [options], callback)` style: callback is the last argument. */
	const callbackApi =
		(name: Operation, arity: number) =>
		(...args: unknown[]) => {
			// the callback is always the last argument: fs.readFile(path, [options], cb)
			const callback = args.at(-1);
			if (!isCallable(callback)) throw invalidCallback('cb', callback);
			const params = args.slice(0, Math.min(args.length - 1, arity));
			let result: unknown;
			let error: unknown = null;
			try {
				result = Reflect.apply(operations[name], undefined, params);
			} catch (e) {
				error = e;
			}
			host.threadpool(
				`fs.${name}(${typeof params[0] === 'string' ? `'${params[0]}'` : ''})`,
				stagesFor(name, error !== null),
				callback,
				() =>
					Reflect.apply(
						callback,
						undefined,
						error ? [error] : result === undefined ? [null] : [null, result]
					)
			);
		};

	const promiseApi =
		(name: Operation) =>
		(...params: unknown[]) => {
			const { promise, resolve, reject } = host.newPromiseCapability();
			let result: unknown;
			let error: unknown;
			let failed = false;
			try {
				result = Reflect.apply(operations[name], undefined, params);
			} catch (e) {
				failed = true;
				error = e;
			}
			const settle = () => (failed ? reject(error) : resolve(result));
			Object.defineProperty(settle, 'name', { value: `fs.promises.${name}` });
			host.threadpool(
				`fs.promises.${name}(${typeof params[0] === 'string' ? `'${params[0]}'` : ''})`,
				stagesFor(name, failed),
				settle,
				settle
			);
			return promise;
		};

	const fsPromises = {
		readFile: promiseApi('readFile'),
		writeFile: promiseApi('writeFile'),
		appendFile: promiseApi('appendFile'),
		readdir: promiseApi('readdir'),
		stat: promiseApi('stat'),
		access: promiseApi('access'),
		unlink: promiseApi('unlink'),
	};

	/** The *Sync variants block the only JavaScript thread: no loop involved. */
	const fs = {
		readFile: callbackApi('readFile', 2),
		writeFile: callbackApi('writeFile', 3),
		appendFile: callbackApi('appendFile', 3),
		readdir: callbackApi('readdir', 2),
		stat: callbackApi('stat', 2),
		access: callbackApi('access', 2),
		unlink: callbackApi('unlink', 1),
		readFileSync: (path: unknown, options?: unknown) =>
			operations.readFile(path, options),
		writeFileSync: (path: unknown, data: unknown) =>
			operations.writeFile(path, data),
		appendFileSync: (path: unknown, data: unknown) =>
			operations.appendFile(path, data),
		readdirSync: (path: unknown) => operations.readdir(path),
		statSync: (path: unknown) => operations.stat(path),
		unlinkSync: (path: unknown) => operations.unlink(path),
		existsSync: (path: unknown) => {
			try {
				return files.has(normalise(path));
			} catch {
				return false;
			}
		},
		promises: fsPromises,
	};

	// --- net: a loopback TCP network --------------------------------------------------------
	//
	// Measured against Node 22 and 26 (async_hooks resource types):
	//   listen()          -> 'listening' on the next tick (TickObject)
	//   connect()         -> poll: client 'connect' (TCPCONNECTWRAP), then the
	//                        server 'connection' (TCPSERVERWRAP)
	//   socket.destroy()  -> close callbacks phase: 'close' (TCPWRAP); the peer
	//                        reads EOF in a later poll, ends and closes too
	//   server.close(cb)  -> 'close' on the next tick (TickObject) once no
	//                        connection is open; libuv closes the handle in the
	//                        close phase without running JavaScript

	const servers = new Map<number, Server>();
	let nextPort = 40_000;

	const socketError = (
		syscall: string,
		code: string,
		errno: number,
		port: number
	) =>
		nodeError(`${syscall} ${code} 127.0.0.1:${port}`, {
			errno,
			code,
			syscall,
			address: '127.0.0.1',
			port,
		});

	class Socket extends EventEmitter {
		#handle: number | null = null;
		#peer: Socket | null = null;
		#onClose: (() => void) | null = null;
		destroyed = false;
		remotePort?: number;

		/** @internal opens the TCP handle of an accepted or connecting socket */
		_open(label: string, onClose?: () => void) {
			this.#handle = host.openHandle(label);
			this.#onClose = onClose ?? null;
		}

		/** @internal the other end of the connection */
		_pair(peer: Socket) {
			this.#peer = peer;
		}

		/** @internal the peer is gone: the kernel reports EOF in a later poll */
		_peerClosed() {
			const readEof = () => this._eof();
			Object.defineProperty(readEof, 'name', { value: 'onStreamRead (EOF)' });
			host.networkEvent('TCP: EOF from peer', readEof, readEof);
		}

		/** @internal the peer closed: read EOF, end, then close (allowHalfOpen: false) */
		_eof() {
			if (this.destroyed) return;
			this.emit('end');
			this.destroy();
		}

		destroy(error?: unknown) {
			if (this.destroyed) return this;
			this.destroyed = true;
			const peer = this.#peer;
			if (peer && !peer.destroyed) peer._peerClosed();
			if (this.#handle === null) {
				host.nextTick(
					() => this.emit('close', false),
					{ label: "emit('close')" },
					[]
				);
				return this;
			}
			const handle = this.#handle;
			this.#handle = null;
			const emitClose = () => {
				if (error !== undefined) this.emit('error', error);
				this.emit('close', error !== undefined);
				this.#onClose?.();
			};
			Object.defineProperty(emitClose, 'name', { value: "socket.on('close')" });
			host.closeHandle(handle, "socket.on('close')", emitClose);
			return this;
		}

		end(): never {
			throw nodeError(
				'socket.end() is not simulated yet: use socket.destroy() to close the connection',
				{ code: 'ERR_SIMULATOR_UNSUPPORTED' }
			);
		}

		write(): never {
			throw nodeError('socket.write() is not simulated yet', {
				code: 'ERR_SIMULATOR_UNSUPPORTED',
			});
		}

		address() {
			return { address: '127.0.0.1', family: 'IPv4', port: this.remotePort };
		}
	}

	class Server extends EventEmitter {
		#handle: number | null = null;
		#port = 0;
		#connections = 0;
		#closing = false;

		listen(...args: unknown[]) {
			const callback = args.find(isCallable);
			const port = args.find((a) => typeof a === 'number');
			this.#port = typeof port === 'number' && port > 0 ? port : nextPort++;
			if (callback) this.once('listening', callback);
			this.#handle = host.openHandle(`TCP server :${this.#port}`);
			servers.set(this.#port, this);
			// Node emits 'listening' on the next tick
			const emitListening = () => this.emit('listening');
			Object.defineProperty(emitListening, 'name', {
				value: 'emitListeningNT',
			});
			host.nextTick(emitListening, { label: "emit('listening')" }, []);
			return this;
		}

		address() {
			return this.#handle === null
				? null
				: { address: '::', family: 'IPv6', port: this.#port };
		}

		get listening() {
			return this.#handle !== null;
		}

		/** @internal the kernel accepted a connection on this server */
		_accept(client: Socket) {
			const conn = new Socket();
			conn.remotePort = this.#port;
			this.#connections++;
			conn._open(`TCP socket (server side) :${this.#port}`, () => {
				this.#connections--;
				this._emitCloseIfDrained();
			});
			conn._pair(client);
			client._pair(conn);
			// the kernel had connected them already: a client that closed before
			// the accept still sends its EOF to the server side
			if (client.destroyed) conn._peerClosed();
			this.emit('connection', conn);
		}

		/** @internal 'close' is emitted on the next tick once no connection is left */
		_emitCloseIfDrained() {
			if (!this.#closing || this.#connections > 0) return;
			this.#closing = false;
			const emitClose = () => this.emit('close');
			Object.defineProperty(emitClose, 'name', { value: 'emitCloseNT' });
			host.nextTick(emitClose, { label: "emit('close')" }, []);
		}

		close(callback?: unknown) {
			if (isCallable(callback)) this.once('close', callback);
			if (this.#handle === null) {
				const error = nodeError('Server is not running.', {
					code: 'ERR_SERVER_NOT_RUNNING',
				});
				host.nextTick(
					() => this.emit('close', error),
					{ label: "emit('close')" },
					[]
				);
				return this;
			}
			const handle = this.#handle;
			this.#handle = null;
			servers.delete(this.#port);
			// libuv closes the listening handle in the close phase (no JavaScript)
			host.closeHandle(handle, `uv_close(TCP server :${this.#port})`);
			this.#closing = true;
			this._emitCloseIfDrained();
			return this;
		}
	}

	const connect = (...args: unknown[]) => {
		const options = args[0];
		const port = Number(
			typeof options === 'object' && options !== null
				? (options as { port?: unknown }).port
				: options
		);
		const callback = args.find(isCallable);
		const socket = new Socket();
		socket.remotePort = port;
		if (callback) socket.once('connect', callback);
		const server = servers.get(port);
		if (!server) {
			const refused = () =>
				socket.destroy(socketError('connect', 'ECONNREFUSED', -61, port));
			Object.defineProperty(refused, 'name', {
				value: 'afterConnect (ECONNREFUSED)',
			});
			socket._open(`TCP socket → :${port}`);
			host.networkEvent(`TCP: connect(:${port})`, refused, refused);
			return socket;
		}
		socket._open(`TCP socket → :${port}`);
		// both ends become ready in the same poll: the client first, then the server
		const afterConnect = () => socket.emit('connect');
		Object.defineProperty(afterConnect, 'name', {
			value: callback ? callback.name || 'afterConnect' : 'afterConnect',
		});
		host.networkEvent(
			`TCP: connect(:${port})`,
			callback ?? afterConnect,
			afterConnect
		);
		const onConnection = () => server._accept(socket);
		const listener = server.listeners('connection')[0];
		host.networkEvent(
			`TCP: accept on :${port}`,
			listener ?? onConnection,
			onConnection
		);
		return socket;
	};

	const net = {
		createServer: (...args: unknown[]) => {
			const server = new Server();
			const listener = args.find(isCallable);
			if (listener) server.on('connection', listener);
			return server;
		},
		connect,
		createConnection: connect,
		Server,
		Socket,
	};

	// --- util ---------------------------------------------------------------------------

	const promisify = (original: unknown) => {
		if (!isCallable(original)) throw invalidCallback('original', original);
		const custom = (original as unknown as Record<symbol, unknown>)[PROMISIFY];
		if (isCallable(custom)) return custom;
		const promisified = (...args: unknown[]) =>
			new SimPromise((resolve, reject) => {
				const done = (error: unknown, value: unknown) =>
					error ? reject(error) : resolve(value);
				Object.defineProperty(done, 'name', {
					value: `${original.name || 'promisified'} callback`,
				});
				Reflect.apply(original, undefined, [...args, done]);
			});
		Object.defineProperty(promisified, 'name', { value: original.name });
		return promisified;
	};
	Object.defineProperty(promisify, 'custom', { value: PROMISIFY });

	const util = {
		promisify,
		inspect: (value: unknown) => inspect(value, host.inspectPromise),
		format: (...args: unknown[]) => formatArgs(args, host.inspectPromise),
		types: {
			isPromise: (value: unknown) => host.inspectPromise(value) !== null,
		},
	};

	// --- Date on the simulated clock ---------------------------------------------------------

	/**
	 * `Date.now()` and `new Date()` follow simulated time, so measuring a
	 * timer works like in Node. (A busy-wait on Date.now() never ends in
	 * simulated time: the operation budget stops it.)
	 */
	const NativeDate = Date;
	const epoch = NativeDate.now();
	class SimDate extends NativeDate {
		constructor(...args: unknown[]) {
			if (args.length) super(...(args as [string]));
			else super(epoch + host.time);
		}
		static now() {
			return epoch + host.time;
		}
	}
	Object.defineProperty(SimDate, 'name', { value: 'Date' });

	// --- assert ---------------------------------------------------------------------------------

	class AssertionError extends Error {
		code = 'ERR_ASSERTION';
		constructor(message: string) {
			super(message);
			this.name = 'AssertionError';
		}
	}
	const fail = (message: unknown, fallback: string): never => {
		if (message instanceof Error) throw message;
		throw new AssertionError(
			message === undefined ? fallback : inspect(message, host.inspectPromise)
		);
	};
	const show = (value: unknown) => inspect(value, host.inspectPromise, 1);
	const deepEqual = (a: unknown, b: unknown): boolean => {
		if (Object.is(a, b)) return true;
		if (typeof a !== 'object' || typeof b !== 'object' || !a || !b)
			return false;
		if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
		const keysA = Reflect.ownKeys(a);
		const keysB = Reflect.ownKeys(b);
		return (
			keysA.length === keysB.length &&
			keysA.every((key) =>
				deepEqual(
					(a as Record<PropertyKey, unknown>)[key],
					(b as Record<PropertyKey, unknown>)[key]
				)
			)
		);
	};
	const ok = (value: unknown, message?: unknown) => {
		if (!value)
			fail(
				message,
				`The expression evaluated to a falsy value:\n\n  assert.ok(${show(value)})\n`
			);
	};
	const assert = Object.assign(ok, {
		ok,
		AssertionError,
		equal: (actual: unknown, expected: unknown, message?: unknown) => {
			if (!(actual == expected))
				fail(message, `${show(actual)} == ${show(expected)}`);
		},
		strictEqual: (actual: unknown, expected: unknown, message?: unknown) => {
			if (!Object.is(actual, expected))
				fail(
					message,
					`Expected values to be strictly equal:\n\n${show(actual)} !== ${show(expected)}\n`
				);
		},
		notStrictEqual: (actual: unknown, expected: unknown, message?: unknown) => {
			if (Object.is(actual, expected))
				fail(
					message,
					`Expected "actual" to be strictly unequal to: ${show(expected)}`
				);
		},
		deepStrictEqual: (
			actual: unknown,
			expected: unknown,
			message?: unknown
		) => {
			if (!deepEqual(actual, expected))
				fail(message, 'Expected values to be strictly deep-equal');
		},
		fail: (message?: unknown) => fail(message, 'Failed'),
	});

	// --- require ----------------------------------------------------------------------------

	const timers = {
		setTimeout,
		setInterval,
		setImmediate,
		clearTimeout,
		clearInterval: clearTimeout,
		clearImmediate,
	};

	const MODULES: Record<string, unknown> = {
		fs,
		'fs/promises': fsPromises,
		events: Object.assign(EventEmitter, { EventEmitter }),
		net,
		util,
		timers,
		'timers/promises': timersPromises,
		process,
		buffer: { Buffer: SimBuffer },
		assert,
		'assert/strict': assert,
	};

	const require = (id: unknown) => {
		const name = String(id).replace(/^node:/, '');
		if (name in MODULES) return MODULES[name];
		throw nodeError(
			`Cannot find module '${String(id)}' (the simulator provides: ${Object.keys(MODULES).join(', ')})`,
			{ code: 'MODULE_NOT_FOUND' }
		);
	};

	return {
		globals: {
			...timers,
			process,
			require,
			Buffer: SimBuffer,
			Date: SimDate,
		},
	};
};
