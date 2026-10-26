/**
 * Errors the engine reports to the UI. Every error carries a stable `code`
 * plus interpolation `params`, so the UI can render it in any language.
 * `message` is an English fallback used in logs and tests.
 */
export type EngineErrorCode =
	'syntax' | 'unsupportedSyntax' | 'operationLimit' | 'timeout' | 'internal';

export class EngineError extends Error {
	readonly code: EngineErrorCode;
	readonly params: Record<string, string | number>;
	/** Source offsets [start, end) the error points at, when known. */
	readonly range?: [number, number];

	constructor(
		code: EngineErrorCode,
		message: string,
		params: Record<string, string | number> = {},
		range?: [number, number]
	) {
		super(message);
		this.name = 'EngineError';
		this.code = code;
		this.params = params;
		this.range = range;
	}
}

/**
 * Signals that stop the simulation from inside user code. They must never be
 * swallowed by a user `try/catch`, so the instrumenter re-throws them from
 * every catch clause (see `__elx.k`).
 */
export class SimulationAbort extends Error {}

/** The program runs too many operations without yielding (e.g. `while (true) {}`). */
export class BudgetExceeded extends SimulationAbort {
	constructor() {
		super('Operation budget exceeded');
		this.name = 'BudgetExceeded';
	}
}

/** The program keeps scheduling work forever (e.g. `setInterval` never cleared). */
export class StepLimitReached extends SimulationAbort {
	constructor() {
		super('Step limit reached');
		this.name = 'StepLimitReached';
	}
}

/** `process.exit()` or a crash: nothing else runs. */
export class ProcessExit extends SimulationAbort {
	constructor(readonly exitCode: number) {
		super(`Process exited with code ${exitCode}`);
		this.name = 'ProcessExit';
	}
}

const describeType = (value: unknown) => {
	if (value === null) return 'null';
	if (value === undefined) return 'undefined';
	if (typeof value === 'function') return `function ${value.name || ''}`;
	if (typeof value === 'object') return 'an instance of Object';
	// only primitives are left here (string, number, boolean, bigint, symbol)
	const text =
		typeof value === 'symbol' ? value.toString() : `${value as string}`;
	return `type ${typeof value} (${text})`;
};

/** Node's ERR_INVALID_ARG_TYPE for callbacks. */
export const invalidCallback = (name: string, value: unknown) => {
	const error = new TypeError(
		`The "${name}" argument must be of type function. Received ${describeType(value)}`
	);
	Object.defineProperty(error, 'code', {
		value: 'ERR_INVALID_ARG_TYPE',
		enumerable: false,
	});
	return error;
};
