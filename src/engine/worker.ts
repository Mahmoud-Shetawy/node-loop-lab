/// <reference lib="webworker" />
import { EngineError } from './errors';
import { simulate, type Simulation } from './index';

/**
 * Runs one simulation in a dedicated worker: user code gets its own realm
 * (it can't touch the page, its DOM or the app's prototypes, even through
 * `Function('return this')()`), and the page can terminate it when a
 * single native operation (a giant array, a catastrophic regex) takes too
 * long to be stopped by the operation budget.
 */

export type WorkerRequest = { source: string };
export type WorkerResponse =
	| { ok: true; simulation: Simulation }
	| {
			ok: false;
			error: {
				code: EngineError['code'];
				params: EngineError['params'];
				range?: [number, number];
				message: string;
			};
	  };

// nothing in the simulator needs the network or storage: remove them so
// code that escapes the sandbox still can't reach anything
for (const name of [
	'fetch',
	'XMLHttpRequest',
	'WebSocket',
	'WebTransport',
	'EventSource',
	'BroadcastChannel',
	'importScripts',
	'indexedDB',
	'caches',
	'Request',
	'Response',
]) {
	try {
		Reflect.deleteProperty(self, name);
		Object.defineProperty(self, name, { value: undefined });
	} catch {
		// some host properties can't be redefined; deleting is enough then
	}
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
	let response: WorkerResponse;
	try {
		response = { ok: true, simulation: simulate(event.data.source) };
	} catch (error) {
		const engineError =
			error instanceof EngineError
				? error
				: new EngineError('internal', String(error), {
						message: String(error),
					});
		response = {
			ok: false,
			error: {
				code: engineError.code,
				params: engineError.params,
				range: engineError.range,
				message: engineError.message,
			},
		};
	}
	self.postMessage(response);
};
