import { EngineError } from './errors';
import { instrument } from './instrument';
import { DEFAULT_LIMITS, Runtime, type SimulationLimits } from './runtime';
import type { SimStep } from './types';

export { EngineError } from './errors';
export type { EngineErrorCode } from './errors';
export type * from './types';
export { PHASES } from './types';

export interface Simulation {
	steps: SimStep[];
	/** The program was cut short because it never stops scheduling work. */
	truncated: boolean;
}

/**
 * Runs `source` in a simulated Node.js process and returns the recorded steps.
 * Throws {@link EngineError} for code the simulator can't run.
 */
export const simulate = (
	source: string,
	limits: Partial<SimulationLimits> = {}
): Simulation => {
	const { code, meta, isModule } = instrument(source);
	try {
		return new Runtime(meta, source, { ...DEFAULT_LIMITS, ...limits }).run(
			code,
			isModule
		);
	} catch (error) {
		if (error instanceof EngineError) throw error;
		throw new EngineError('internal', String(error), {
			message: String(error),
		});
	}
};

/** Console lines of a run; handy for tests and for the "expected output" panel. */
export const consoleOutput = (steps: SimStep[]) =>
	steps.flatMap((step) =>
		step.type === 'push' && step.queue === 'console' ? [step.value] : []
	);
