import { EngineError } from './errors';
import { simulate, type Simulation } from './index';
import type { WorkerRequest, WorkerResponse } from './worker';

/** A simulation that takes longer than this is killed. */
export const SIMULATION_TIMEOUT_MS = 5_000;

/**
 * Runs the simulation in a fresh, isolated Web Worker (see worker.ts) and
 * terminates it after {@link SIMULATION_TIMEOUT_MS}. Environments without
 * workers (unit tests) run it in place.
 */
export const runSimulation = (source: string): Promise<Simulation> => {
	if (typeof Worker === 'undefined')
		return new Promise((resolve) => resolve(simulate(source)));

	return new Promise((resolve, reject) => {
		const worker = new Worker(new URL('./worker.ts', import.meta.url), {
			type: 'module',
		});
		const timeout = setTimeout(() => {
			worker.terminate();
			reject(
				new EngineError('timeout', 'The simulation took too long', {
					seconds: SIMULATION_TIMEOUT_MS / 1000,
				})
			);
		}, SIMULATION_TIMEOUT_MS);

		worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
			clearTimeout(timeout);
			worker.terminate();
			const response = event.data;
			if (response.ok) resolve(response.simulation);
			else {
				const { code, message, params, range } = response.error;
				reject(new EngineError(code, message, params, range));
			}
		};
		worker.onerror = (event) => {
			clearTimeout(timeout);
			worker.terminate();
			reject(
				new EngineError('internal', event.message, { message: event.message })
			);
		};
		worker.postMessage({ source } satisfies WorkerRequest);
	});
};
