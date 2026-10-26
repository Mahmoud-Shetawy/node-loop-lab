/**
 * Formats console arguments like Node's `util.format` / `util.inspect`,
 * on a single line (Node would break long objects over several lines).
 */

const MAX_DEPTH = 2;
const MAX_ITEMS = 100;
const MAX_LENGTH = 300;

/** Lets the formatter show simulated promises as `Promise { <pending> }`. */
export type PromiseInspector = (
	value: unknown
) => { state: 'pending' | 'fulfilled' | 'rejected'; value?: unknown } | null;

/** Set by the runtime on user async functions (they run as generators). */
export const ASYNC_FUNCTION = Symbol.for('node-loop-lab.async');

/** Objects that know how Node would print them (e.g. the simulated Buffer). */
export const INSPECT = Symbol.for('nodejs.util.inspect.custom');

const quote = (text: string) => `'${text.replace(/'/g, "\\'")}'`;

const formatKey = (key: string | symbol) => {
	if (typeof key === 'symbol') return `[${String(key)}]`;
	return /^[A-Za-z_$][\w$]*$/.test(key) ? key : quote(key);
};

const formatError = (error: Error) =>
	error.message ? `${error.name}: ${error.message}` : error.name;

const formatFunction = (fn: (...args: unknown[]) => unknown) => {
	let source = '';
	try {
		source = Function.prototype.toString.call(fn);
	} catch {
		// proxies and some host functions can't be stringified
	}
	if (source.startsWith('class'))
		return fn.name ? `[class ${fn.name}]` : '[class (anonymous)]';
	const kind = (fn as unknown as Record<symbol, unknown>)[ASYNC_FUNCTION]
		? 'AsyncFunction'
		: 'Function';
	return fn.name ? `[${kind}: ${fn.name}]` : `[${kind} (anonymous)]`;
};

const braces = (prefix: string, items: string[], open = '{', close = '}') =>
	items.length
		? `${prefix}${open} ${items.join(', ')} ${close}`
		: `${prefix}${open}${close}`;

export const inspect = (
	value: unknown,
	inspectPromise: PromiseInspector = () => null,
	depth = 0,
	seen: Set<object> = new Set()
): string => {
	switch (typeof value) {
		case 'string':
			return depth === 0 ? value : quote(value);
		case 'number':
			return Object.is(value, -0) ? '-0' : String(value);
		case 'bigint':
			return `${value}n`;
		case 'undefined':
			return 'undefined';
		case 'boolean':
			return String(value);
		case 'symbol':
			return value.toString();
		case 'function':
			return formatFunction(value as (...args: unknown[]) => unknown);
	}
	if (value === null) return 'null';

	const object = value as Record<PropertyKey, unknown>;
	if (seen.has(object)) return '[Circular *1]';

	const custom = object[INSPECT];
	if (typeof custom === 'function') return String(custom.call(object));

	const promise = inspectPromise(object);
	if (promise) {
		if (promise.state === 'pending') return 'Promise { <pending> }';
		const inner = inspect(promise.value, inspectPromise, depth + 1, seen);
		return promise.state === 'rejected'
			? `Promise { <rejected> ${inner} }`
			: `Promise { ${inner} }`;
	}
	if (object instanceof Error)
		return depth === 0 ? formatError(object) : `[${formatError(object)}]`;
	if (object instanceof Date)
		return Number.isNaN(object.getTime())
			? 'Invalid Date'
			: object.toISOString();
	if (object instanceof RegExp) return String(object);

	const proto = Object.getPrototypeOf(object) as {
		constructor?: { name?: string };
	} | null;
	const ctor = proto === null ? null : (proto.constructor?.name ?? '');

	if (depth > MAX_DEPTH) {
		if (Array.isArray(object)) return '[Array]';
		return ctor && ctor !== 'Object' ? `[${ctor}]` : '[Object]';
	}

	seen.add(object);
	const nested = (item: unknown) =>
		inspect(item, inspectPromise, depth + 1, seen);
	const truncated = (items: string[], total: number) =>
		total > MAX_ITEMS
			? [...items, `... ${total - MAX_ITEMS} more items`]
			: items;
	try {
		if (Array.isArray(object)) {
			const items: string[] = [];
			const shown = Math.min(object.length, MAX_ITEMS);
			for (let index = 0; index < shown; index++) {
				if (index in object) {
					items.push(nested(object[index]));
					continue;
				}
				// holes print like Node: <2 empty items>
				let holes = 1;
				while (index + holes < shown && !(index + holes in object)) holes++;
				items.push(`<${holes} empty item${holes > 1 ? 's' : ''}>`);
				index += holes - 1;
			}
			return braces('', truncated(items, object.length), '[', ']');
		}
		if (object instanceof Map) {
			const items = [...object]
				.slice(0, MAX_ITEMS)
				.map(([key, val]) => `${nested(key)} => ${nested(val)}`);
			return braces(`Map(${object.size}) `, truncated(items, object.size));
		}
		if (object instanceof Set) {
			const items = [...object].slice(0, MAX_ITEMS).map(nested);
			return braces(`Set(${object.size}) `, truncated(items, object.size));
		}
		const keys = Reflect.ownKeys(object).filter((key) =>
			Object.prototype.propertyIsEnumerable.call(object, key)
		);
		const items = keys
			.slice(0, MAX_ITEMS)
			.map((key) => `${formatKey(key)}: ${nested(object[key])}`);
		const prefix =
			ctor === null
				? '[Object: null prototype] '
				: ctor && ctor !== 'Object'
					? `${ctor} `
					: '';
		return braces(prefix, truncated(items, keys.length));
	} finally {
		seen.delete(object);
	}
};

/** `util.format`: `%s %d %i %f %j %o %O %c %%` substitutions. */
export const formatArgs = (
	args: unknown[],
	inspectPromise?: PromiseInspector
): string => {
	const rest = [...args];
	const parts: string[] = [];
	// like Node, a lone string is printed as is: console.log('100%%') -> 100%%
	if (typeof rest[0] === 'string' && rest.length > 1 && rest[0].includes('%')) {
		const template = rest.shift() as string;
		parts.push(
			template.replace(/%([sdifjoOc%])/g, (match, specifier: string) => {
				if (specifier === '%') return '%';
				if (!rest.length) return match;
				const arg = rest.shift();
				switch (specifier) {
					case 's':
						if (typeof arg === 'string') return arg;
						if (typeof arg === 'bigint') return `${arg}n`;
						if (typeof arg === 'symbol') return arg.toString();
						return inspect(arg, inspectPromise, 1);
					case 'd':
					case 'i': {
						if (typeof arg === 'bigint') return `${arg}n`;
						if (typeof arg === 'symbol') return 'NaN';
						const number = Number(arg);
						return String(specifier === 'i' ? Math.trunc(number) : number);
					}
					case 'f':
						return typeof arg === 'symbol' ? 'NaN' : String(Number(arg));
					case 'j':
						try {
							return JSON.stringify(arg) ?? 'undefined';
						} catch {
							return '[Circular]';
						}
					case 'c':
						return '';
					default:
						return inspect(arg, inspectPromise, 1);
				}
			})
		);
	}
	parts.push(...rest.map((arg) => inspect(arg, inspectPromise)));
	const line = parts.join(' ');
	return line.length > MAX_LENGTH ? `${line.slice(0, MAX_LENGTH - 1)}…` : line;
};

/** How Node reports an error that crashes the process. */
export const formatUncaught = (
	error: unknown,
	inPromise: boolean,
	inspectPromise?: PromiseInspector
) => {
	if (error instanceof Error) return `Uncaught ${formatError(error)}`;
	if (inPromise)
		return `Uncaught [UnhandledPromiseRejection: This error originated either by throwing inside of an async function without a catch block, or by rejecting a promise which was not handled with .catch(). The promise rejected with the reason "${inspect(error, inspectPromise)}".]`;
	return `Uncaught ${inspect(error, inspectPromise, 1)}`;
};
