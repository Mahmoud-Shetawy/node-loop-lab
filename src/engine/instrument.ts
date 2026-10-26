import { parse, type Node } from 'acorn';
import { generate } from 'astring';
import { analyze } from 'eslint-scope';
import type { Program as EstreeProgram } from 'estree';
import { EngineError } from './errors';

/**
 * Source-to-source instrumentation.
 *
 * The user program is executed for real, so the console output and the
 * order of callbacks follow JavaScript semantics instead of a hand-written
 * approximation. To *observe* the execution we rewrite the program:
 *
 *  - `f(a)`        -> `__elx.c(id, f)(a)`        (call stack frame)
 *  - `o.m(a)`      -> `__elx.m(id, o, "m")(a)`   (frame, keeps `this`)
 *  - `new C(a)`    -> `__elx.n(id, C)(a)`        (frame)
 *  - functions     -> `__elx.f(id, fn, name)`    (label for queued callbacks)
 *  - `async` fns   -> generators driven by `__elx.a` so `await` goes through
 *                     the simulated microtask queue instead of the native one
 *  - loop bodies   -> `__elx.t()` first, enforcing an operation budget
 *  - `catch (e)`   -> `__elx.k(e)` first, so the budget can't be swallowed
 *
 * The curried call form keeps the evaluation order of the language: callee
 * (and receiver) first, then arguments, then the call itself.
 */

export const RUNTIME_ID = '__elx';

export interface SourceMeta {
	/** [start, end) offsets in the original source. */
	range: [number, number];
	/** Short human readable label (normalised source excerpt). */
	label: string;
	/** For calls: the callee source, used in "x is not a function" errors. */
	callee?: string;
}

export interface InstrumentResult {
	code: string;
	meta: SourceMeta[];
	/**
	 * `import` or top-level `await` make Node load the file as an ES module,
	 * which changes the startup order of nextTick vs Promise callbacks.
	 */
	isModule: boolean;
}

type AnyNode = Node & Record<string, unknown>;

const LABEL_MAX = 48;
const SKIPPED_KEYS = new Set(['type', 'start', 'end', 'range']);

/** Globals the simulated environment provides (see runtime.ts). */
export const PROVIDED_GLOBALS = [
	'console',
	'setTimeout',
	'clearTimeout',
	'setInterval',
	'clearInterval',
	'setImmediate',
	'clearImmediate',
	'queueMicrotask',
	'Promise',
	'process',
	'require',
	'module',
	'exports',
	'__filename',
	'__dirname',
	'Buffer',
	'Date',
	'performance',
	'globalThis',
	'global',
] as const;

/**
 * ECMAScript built-ins are safe and deterministic enough to use natively.
 * Any other free identifier (`document`, `fetch`, `process`, ...) is not part
 * of the simulated environment and throws a `ReferenceError` when touched,
 * so user code can never reach the real page.
 */
const ECMASCRIPT_GLOBALS = new Set([
	'undefined',
	'NaN',
	'Infinity',
	'Object',
	'Function',
	'Array',
	'String',
	'Number',
	'Boolean',
	'Symbol',
	'BigInt',
	'Math',
	'JSON',
	'Date',
	'RegExp',
	'Map',
	'Set',
	'WeakMap',
	'WeakSet',
	'WeakRef',
	'FinalizationRegistry',
	'Reflect',
	'Proxy',
	'Intl',
	'Iterator',
	'ArrayBuffer',
	'SharedArrayBuffer',
	'DataView',
	'Int8Array',
	'Uint8Array',
	'Uint8ClampedArray',
	'Int16Array',
	'Uint16Array',
	'Int32Array',
	'Uint32Array',
	'Float32Array',
	'Float64Array',
	'BigInt64Array',
	'BigUint64Array',
	'Error',
	'AggregateError',
	'EvalError',
	'RangeError',
	'ReferenceError',
	'SyntaxError',
	'TypeError',
	'URIError',
	'parseInt',
	'parseFloat',
	'isNaN',
	'isFinite',
	'encodeURI',
	'encodeURIComponent',
	'decodeURI',
	'decodeURIComponent',
	'structuredClone',
	// Web platform APIs Node also has; harmless inside the worker
	'TextEncoder',
	'TextDecoder',
	'URL',
	'URLSearchParams',
	'AbortController',
	'AbortSignal',
	'atob',
	'btoa',
	...PROVIDED_GLOBALS,
]);

export const normaliseLabel = (text: string): string => {
	const compact = text
		.replace(/\s+/g, ' ')
		.replace(/\(\s/g, '(')
		.replace(/\s\)/g, ')')
		.replace(/\{\s/g, '{ ')
		.trim();
	return compact.length > LABEL_MAX
		? `${compact.slice(0, LABEL_MAX - 1)}…`
		: compact;
};

const isNode = (value: unknown): value is AnyNode =>
	!!value &&
	typeof value === 'object' &&
	typeof (value as { type?: unknown }).type === 'string';

const FUNCTION_TYPES = new Set([
	'FunctionDeclaration',
	'FunctionExpression',
	'ArrowFunctionExpression',
]);

const LOOP_TYPES = new Set([
	'ForStatement',
	'ForInStatement',
	'ForOfStatement',
	'WhileStatement',
	'DoWhileStatement',
]);

// --- tiny AST builders -------------------------------------------------------

const id = (name: string): AnyNode =>
	({ type: 'Identifier', name }) as unknown as AnyNode;
const lit = (value: string | number): AnyNode =>
	({
		type: 'Literal',
		value,
		raw: JSON.stringify(value),
	}) as unknown as AnyNode;
const member = (object: AnyNode, property: string): AnyNode =>
	({
		type: 'MemberExpression',
		object,
		property: id(property),
		computed: false,
		optional: false,
	}) as unknown as AnyNode;
const call = (callee: AnyNode, args: AnyNode[]): AnyNode =>
	({
		type: 'CallExpression',
		callee,
		arguments: args,
		optional: false,
	}) as unknown as AnyNode;
const rt = (method: string, args: AnyNode[]) =>
	call(member(id(RUNTIME_ID), method), args);
const exprStatement = (expression: AnyNode): AnyNode =>
	({ type: 'ExpressionStatement', expression }) as unknown as AnyNode;
const block = (body: AnyNode[]): AnyNode =>
	({ type: 'BlockStatement', body }) as unknown as AnyNode;
const generatorExpression = (body: AnyNode): AnyNode =>
	({
		type: 'FunctionExpression',
		id: null,
		params: [],
		body,
		generator: true,
		async: false,
		expression: false,
	}) as unknown as AnyNode;

/**
 * Walks `node` without entering nested non-arrow functions (their `this`,
 * `arguments`, `super` are their own) and reports whether `predicate` holds.
 */
const someInFunctionScope = (
	node: unknown,
	predicate: (n: AnyNode) => boolean,
	enterArrows: boolean
): boolean => {
	if (Array.isArray(node))
		return node.some((n) => someInFunctionScope(n, predicate, enterArrows));
	if (!isNode(node)) return false;
	if (predicate(node)) return true;
	if (
		node.type === 'FunctionDeclaration' ||
		node.type === 'FunctionExpression' ||
		(node.type === 'ArrowFunctionExpression' && !enterArrows)
	)
		return false;
	for (const key of Object.keys(node)) {
		if (SKIPPED_KEYS.has(key)) continue;
		if (someInFunctionScope(node[key], predicate, enterArrows)) return true;
	}
	return false;
};

class Instrumenter {
	private meta: SourceMeta[] = [];
	/** Calls on an optional-chain spine must stay native to short-circuit. */
	private chainSpine = new WeakSet<AnyNode>();

	/** Identifier nodes that reference a global outside the sandbox. */
	private foreign = new WeakSet<object>();
	/** Assignments / updates whose target is such a global. */
	private foreignWrites = new WeakSet<object>();

	constructor(
		private source: string,
		program: AnyNode
	) {
		const scopeManager = analyze(program as unknown as EstreeProgram, {
			ecmaVersion: 2022,
			sourceType: 'module',
		});
		for (const reference of scopeManager.globalScope?.through ?? []) {
			if (!ECMASCRIPT_GLOBALS.has(reference.identifier.name))
				this.foreign.add(reference.identifier);
		}
	}

	private register(node: Node, callee?: Node): number {
		this.meta.push({
			range: [node.start, node.end],
			label: normaliseLabel(this.source.slice(node.start, node.end)),
			callee:
				callee && normaliseLabel(this.source.slice(callee.start, callee.end)),
		});
		return this.meta.length - 1;
	}

	private unsupported(node: Node, feature: string): never {
		throw new EngineError(
			'unsupportedSyntax',
			`"${feature}" is not supported by the simulator`,
			{ feature },
			[node.start, node.end]
		);
	}

	run(program: AnyNode): InstrumentResult {
		// read before visiting: the visit rewrites imports into require() calls
		const hasImports = (program.body as AnyNode[]).some(
			(n) => n.type === 'ImportDeclaration'
		);
		const transformed = this.visit(program, null);
		const visited = transformed.body as AnyNode[];
		// imports are evaluated before the rest of the module
		const body = [
			...visited.filter((statement) => statement.isImport),
			...visited.filter((statement) => !statement.isImport),
		];

		// top-level await: the whole script becomes one async body
		const hasTopLevelAwait = someInFunctionScope(
			program.body,
			(n) => n.type === 'AwaitExpression' || n.type === 'YieldExpression',
			false
		);
		const statements = hasTopLevelAwait
			? [
					// the module's promise is registered: Node exits with code 13
					// when a top-level await never settles
					exprStatement(
						rt('u', [
							rt('a', [
								id('undefined'),
								{ type: 'ArrayExpression', elements: [] } as unknown as AnyNode,
								generatorExpression(block(body)),
							]),
						])
					),
				]
			: body;

		const code = generate({
			...transformed,
			body: statements,
		} as unknown as Node);
		const isModule = hasTopLevelAwait || hasImports;
		return { code, meta: this.meta, isModule };
	}

	private visit(node: AnyNode, parent: AnyNode | null): AnyNode {
		this.check(node);
		if (node.type === 'ChainExpression') this.markChainSpine(node.expression);
		if (
			node.type === 'UnaryExpression' &&
			node.operator === 'typeof' &&
			this.foreign.has(node.argument as object)
		)
			return lit('undefined');
		if (
			(node.type === 'AssignmentExpression' &&
				this.foreign.has(node.left as object)) ||
			(node.type === 'UpdateExpression' &&
				this.foreign.has(node.argument as object))
		)
			this.foreignWrites.add(node);

		for (const key of Object.keys(node)) {
			if (SKIPPED_KEYS.has(key)) continue;
			const child = node[key];
			if (Array.isArray(child)) {
				node[key] = child.map((c: unknown) =>
					isNode(c) ? this.visit(c, node) : c
				);
			} else if (isNode(child)) {
				node[key] = this.visit(child, node);
			}
		}

		return this.transform(node, parent);
	}

	/** The (already rewritten) target of a foreign write: `__elx.g("name")`. */
	private foreignName(node: AnyNode): string {
		const args = node.arguments as AnyNode[] | undefined;
		return args ? String(args[0].value) : String(node.name);
	}

	private markChainSpine(node: unknown) {
		let current = node;
		while (isNode(current)) {
			this.chainSpine.add(current);
			if (current.type === 'CallExpression') current = current.callee;
			else if (current.type === 'MemberExpression') current = current.object;
			else break;
		}
	}

	/** Rejects syntax the simulator can't model faithfully. */
	private check(node: AnyNode) {
		switch (node.type) {
			case 'ImportExpression':
			case 'ExportNamedDeclaration':
			case 'ExportDefaultDeclaration':
			case 'ExportAllDeclaration':
				this.unsupported(node, 'export / import()');
				break;
			case 'ForOfStatement':
				if (node.await) this.unsupported(node, 'for await...of');
				break;
			case 'Identifier':
				if ((node.name as string).startsWith(RUNTIME_ID))
					this.unsupported(node, node.name as string);
				break;
			case 'FunctionDeclaration':
			case 'FunctionExpression':
			case 'ArrowFunctionExpression':
				if (node.async && node.generator)
					this.unsupported(node, 'async generator');
				break;
			case 'CallExpression':
				if (
					isNode(node.callee) &&
					node.callee.type === 'Identifier' &&
					node.callee.name === 'eval'
				)
					this.unsupported(node, 'eval');
				break;
		}
	}

	private transform(node: AnyNode, parent: AnyNode | null): AnyNode {
		if (node.type === 'ImportDeclaration') return this.transformImport(node);
		if (node.type === 'Identifier' && this.foreign.has(node))
			return rt('g', [lit(node.name as string)]);
		if (this.foreignWrites.has(node)) {
			// strict mode: a plain `=` still evaluates the right side first
			const isPlainAssignment =
				node.type === 'AssignmentExpression' && node.operator === '=';
			const name = (
				node.type === 'UpdateExpression' ? node.argument : node.left
			) as AnyNode;
			return isPlainAssignment
				? rt('w', [lit(this.foreignName(name)), node.right as AnyNode])
				: rt('g', [lit(this.foreignName(name))]);
		}
		if (node.type === 'CallExpression') return this.transformCall(node);
		if (node.type === 'NewExpression') return this.transformNew(node);
		if (node.type === 'AwaitExpression')
			return {
				type: 'YieldExpression',
				argument: node.argument,
				delegate: false,
			} as unknown as AnyNode;
		if (node.type === 'DebuggerStatement')
			return { type: 'EmptyStatement' } as unknown as AnyNode;
		if (LOOP_TYPES.has(node.type)) return this.transformLoop(node);
		if (node.type === 'CatchClause') return this.transformCatch(node);
		if (node.type === 'TryStatement' && node.finalizer) {
			// process.exit() runs no more JavaScript, finally blocks included
			node.finalizer = block([
				{
					type: 'IfStatement',
					test: {
						type: 'UnaryExpression',
						operator: '!',
						prefix: true,
						argument: rt('x', []),
					},
					consequent: node.finalizer,
					alternate: null,
				} as unknown as AnyNode,
			]);
			return node;
		}
		if (FUNCTION_TYPES.has(node.type))
			return this.transformFunction(node, parent);
		if (
			node.type === 'Program' ||
			node.type === 'BlockStatement' ||
			node.type === 'StaticBlock'
		)
			return this.tagDeclarations(node);
		return node;
	}

	private transformCall(node: AnyNode): AnyNode {
		const callee = node.callee as AnyNode;
		if (node.optional || callee.type === 'Super' || this.chainSpine.has(node))
			return node;

		const callId = this.register(node, callee);
		if (callee.type === 'MemberExpression') {
			const object = callee.object as AnyNode;
			const property = callee.property as AnyNode;
			// optional chains, `super.x()` and `#private()` keep native calls
			if (
				callee.optional ||
				object.type === 'Super' ||
				property.type === 'PrivateIdentifier'
			)
				return node;
			const key = callee.computed ? property : lit(property.name as string);
			return call(rt('m', [lit(callId), object, key]), node.arguments as never);
		}
		return call(rt('c', [lit(callId), callee]), node.arguments as never);
	}

	private transformNew(node: AnyNode): AnyNode {
		const callId = this.register(node, node.callee as AnyNode);
		return call(
			rt('n', [lit(callId), node.callee as AnyNode]),
			node.arguments as never
		);
	}

	/**
	 * `import fs, { readFile as rf } from 'node:fs'` ->
	 * `const fs = require("node:fs"), { readFile: rf } = require("node:fs")`.
	 * Imports are hoisted by run(), like the language does.
	 */
	private transformImport(node: AnyNode): AnyNode {
		const source = node.source as AnyNode;
		const required = () => call(id('require'), [lit(String(source.value))]);
		const declarators: AnyNode[] = [];
		const named: AnyNode[] = [];
		for (const specifier of node.specifiers as AnyNode[]) {
			const local = specifier.local as AnyNode;
			if (
				specifier.type === 'ImportDefaultSpecifier' ||
				specifier.type === 'ImportNamespaceSpecifier'
			) {
				declarators.push({
					type: 'VariableDeclarator',
					id: id(local.name as string),
					init: required(),
				} as unknown as AnyNode);
			} else {
				const imported = specifier.imported as AnyNode;
				named.push({
					type: 'Property',
					kind: 'init',
					method: false,
					computed: false,
					shorthand: false,
					key:
						imported.type === 'Identifier'
							? id(imported.name as string)
							: lit(String(imported.value)),
					value: id(local.name as string),
				} as unknown as AnyNode);
			}
		}
		if (named.length)
			declarators.push({
				type: 'VariableDeclarator',
				id: { type: 'ObjectPattern', properties: named },
				init: required(),
			} as unknown as AnyNode);
		if (!declarators.length) return exprStatement(required());
		return {
			type: 'VariableDeclaration',
			kind: 'const',
			declarations: declarators,
			isImport: true,
		} as unknown as AnyNode;
	}

	private transformLoop(node: AnyNode): AnyNode {
		const body = node.body as AnyNode;
		const statements = body.type === 'BlockStatement' ? body.body : [body];
		node.body = block([exprStatement(rt('t', [])), ...(statements as never)]);
		return node;
	}

	private transformCatch(node: AnyNode): AnyNode {
		const body = node.body as AnyNode;
		const param = node.param as AnyNode | null;
		const prologue: AnyNode[] = [];
		if (param && param.type === 'Identifier') {
			prologue.push(exprStatement(rt('k', [id(param.name as string)])));
		} else {
			const tmp = id(`${RUNTIME_ID}_err`);
			prologue.push(exprStatement(rt('k', [tmp])));
			if (param) {
				prologue.push({
					type: 'VariableDeclaration',
					kind: 'let',
					declarations: [
						{
							type: 'VariableDeclarator',
							id: param,
							init: tmp,
						} as unknown as AnyNode,
					],
				} as unknown as AnyNode);
			}
			node.param = tmp;
		}
		node.body = block([...prologue, ...(body.body as AnyNode[])]);
		return node;
	}

	private transformFunction(node: AnyNode, parent: AnyNode | null): AnyNode {
		if (node.async) this.toGenerator(node);

		// declarations are tagged at the top of their scope (see tagDeclarations),
		// methods / accessors must stay plain function nodes
		if (node.type === 'FunctionDeclaration') return node;
		if (
			parent &&
			((parent.type === 'MethodDefinition' && parent.value === node) ||
				(parent.type === 'Property' &&
					parent.value === node &&
					(parent.method || parent.kind !== 'init')))
		)
			return node;

		const fnId = this.register(node);
		const name =
			(isNode(node.id) && (node.id.name as string)) ||
			this.inferName(parent, node);
		return rt('f', [lit(fnId), node, lit(name), lit(node.wasAsync ? 1 : 0)]);
	}

	/** Name inference the language would do if we didn't wrap the function. */
	private inferName(parent: AnyNode | null, node: AnyNode): string {
		if (!parent) return '';
		const keyName = (key: unknown) =>
			isNode(key) && key.type === 'Identifier'
				? (key.name as string)
				: isNode(key) && key.type === 'Literal'
					? String(key.value)
					: '';
		switch (parent.type) {
			case 'VariableDeclarator':
				return parent.init === node ? keyName(parent.id) : '';
			case 'AssignmentExpression':
				return parent.right === node && parent.operator === '='
					? keyName(parent.left)
					: '';
			case 'AssignmentPattern':
				return parent.right === node ? keyName(parent.left) : '';
			case 'Property':
			case 'PropertyDefinition':
				return parent.value === node && !parent.computed
					? keyName(parent.key)
					: '';
			default:
				return '';
		}
	}

	/** `async function () { body }` -> `function () { return __elx.a(this, arguments, function* () { body }) }` */
	private toGenerator(node: AnyNode) {
		const isArrow = node.type === 'ArrowFunctionExpression';
		// remembered so the runtime can print it as [AsyncFunction: name]
		node.wasAsync = true;
		const body = node.body as AnyNode;
		if (
			someInFunctionScope(
				body,
				(n) =>
					n.type === 'Super' ||
					(n.type === 'MetaProperty' &&
						isNode(n.meta) &&
						n.meta.name === 'new') ||
					(isArrow && n.type === 'Identifier' && n.name === 'arguments'),
				true
			)
		) {
			this.unsupported(
				node,
				isArrow
					? '`arguments` inside an async arrow function'
					: '`super` / `new.target` inside an async function'
			);
		}

		const generatorBody =
			body.type === 'BlockStatement'
				? body
				: block([
						{ type: 'ReturnStatement', argument: body } as unknown as AnyNode,
					]);

		node.async = false;
		node.expression = false;
		node.body = block([
			{
				type: 'ReturnStatement',
				argument: rt('a', [
					{ type: 'ThisExpression' } as unknown as AnyNode,
					isArrow
						? ({ type: 'ArrayExpression', elements: [] } as unknown as AnyNode)
						: id('arguments'),
					generatorExpression(generatorBody),
				]),
			} as unknown as AnyNode,
		]);
	}

	/** Hoisted function declarations get their label right at scope entry. */
	private tagDeclarations(node: AnyNode): AnyNode {
		const body = node.body as AnyNode[];
		const tags: AnyNode[] = [];
		for (const statement of body) {
			if (statement.type === 'FunctionDeclaration' && isNode(statement.id)) {
				const fnId = this.register(statement);
				const name = statement.id.name as string;
				tags.push(
					exprStatement(
						rt('f', [
							lit(fnId),
							id(name),
							lit(name),
							lit(statement.wasAsync ? 1 : 0),
						])
					)
				);
			}
		}
		if (tags.length) node.body = [...tags, ...body];
		return node;
	}
}

export const parseSource = (source: string): AnyNode => {
	try {
		return parse(source, {
			ecmaVersion: 'latest',
			sourceType: 'module',
			// CommonJS allows `return` at the top of a file
			allowReturnOutsideFunction: true,
			// eslint-scope relies on `range`
			ranges: true,
		}) as unknown as AnyNode;
	} catch (error) {
		const err = error as SyntaxError & {
			pos?: number;
			loc?: { line: number; column: number };
		};
		const pos = typeof err.pos === 'number' ? err.pos : 0;
		throw new EngineError(
			'syntax',
			err.message,
			{
				message: err.message.replace(/\s*\(\d+:\d+\)$/, ''),
				line: err.loc?.line ?? 1,
				column: (err.loc?.column ?? 0) + 1,
			},
			[pos, pos + 1]
		);
	}
};

export const instrument = (source: string): InstrumentResult => {
	const program = parseSource(source);
	return new Instrumenter(source, program).run(program);
};
