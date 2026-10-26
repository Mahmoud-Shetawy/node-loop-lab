/**
 * A Promise implementation that follows ECMA-262 (§27.2) step by step, but
 * schedules its jobs on the simulator's microtask queue instead of the
 * engine's hidden one. Following the spec closely matters: the number of
 * microtask "ticks" (e.g. resolving with a thenable costs two extra jobs) is
 * exactly what decides the output order of tricky event loop puzzles.
 */

export type PromiseState = 'pending' | 'fulfilled' | 'rejected';

export type JobKind = 'reaction' | 'thenable' | 'await';

export interface PromiseHost {
	/** HostEnqueuePromiseJob */
	enqueueJob(job: () => void, kind: JobKind, handler: unknown): void;
	/** HostPromiseRejectionTracker(promise, "reject" | "handle") */
	trackRejection(promise: object, operation: 'reject' | 'handle'): void;
	/** Errors that stop the simulation and must never turn into rejections. */
	isFatal(error: unknown): boolean;
}

interface Reaction {
	capability: Capability | undefined;
	type: 'fulfill' | 'reject';
	handler: ((value: unknown) => unknown) | undefined;
	/** Shown in the microtask queue; defaults to `handler`. */
	label?: unknown;
	kind: JobKind;
}

interface Capability {
	promise: object;
	resolve: (value?: unknown) => void;
	reject: (reason?: unknown) => void;
}

interface Internals {
	state: PromiseState;
	result: unknown;
	fulfillReactions: Reaction[];
	rejectReactions: Reaction[];
	isHandled: boolean;
}

const isObject = (value: unknown): value is object =>
	(typeof value === 'object' && value !== null) || typeof value === 'function';

const isCallable = (value: unknown): value is (...args: unknown[]) => unknown =>
	typeof value === 'function';

const isConstructor = (value: unknown): boolean => {
	if (typeof value !== 'function') return false;
	try {
		Reflect.construct(String, [], value);
		return true;
	} catch {
		return false;
	}
};

export const createPromise = (host: PromiseHost) => {
	const internals = new WeakMap<object, Internals>();
	const guard = (error: unknown) => {
		if (host.isFatal(error)) throw error;
	};

	const getInternals = (value: unknown, method: string): Internals => {
		const slots = isObject(value) ? internals.get(value) : undefined;
		if (!slots)
			throw new TypeError(
				`Method Promise.prototype.${method} called on incompatible receiver`
			);
		return slots;
	};

	const triggerReactions = (reactions: Reaction[], argument: unknown) => {
		for (const reaction of reactions) enqueueReactionJob(reaction, argument);
	};

	const enqueueReactionJob = (reaction: Reaction, argument: unknown) => {
		host.enqueueJob(
			() => {
				const { capability, type, handler } = reaction;
				let result: unknown;
				let threw = false;
				if (handler === undefined) {
					result = argument;
					threw = type === 'reject';
				} else {
					try {
						result = handler(argument);
					} catch (error) {
						guard(error);
						result = error;
						threw = true;
					}
				}
				if (!capability) return;
				if (threw) capability.reject(result);
				else capability.resolve(result);
			},
			reaction.kind,
			reaction.label ?? reaction.handler
		);
	};

	const fulfill = (promise: object, value: unknown) => {
		const slots = internals.get(promise)!;
		const reactions = slots.fulfillReactions;
		Object.assign(slots, {
			state: 'fulfilled',
			result: value,
			fulfillReactions: [],
			rejectReactions: [],
		});
		triggerReactions(reactions, value);
	};

	const reject = (promise: object, reason: unknown) => {
		const slots = internals.get(promise)!;
		const reactions = slots.rejectReactions;
		Object.assign(slots, {
			state: 'rejected',
			result: reason,
			fulfillReactions: [],
			rejectReactions: [],
		});
		if (!slots.isHandled) host.trackRejection(promise, 'reject');
		triggerReactions(reactions, reason);
	};

	const createResolvingFunctions = (promise: object) => {
		let alreadyResolved = false;
		const resolve = (resolution?: unknown) => {
			if (alreadyResolved) return;
			alreadyResolved = true;
			if (resolution === promise) {
				reject(promise, new TypeError('Chaining cycle detected for promise'));
				return;
			}
			if (!isObject(resolution)) {
				fulfill(promise, resolution);
				return;
			}
			let then: unknown;
			try {
				then = (resolution as { then?: unknown }).then;
			} catch (error) {
				guard(error);
				reject(promise, error);
				return;
			}
			if (!isCallable(then)) {
				fulfill(promise, resolution);
				return;
			}
			// NewPromiseResolveThenableJob
			host.enqueueJob(
				() => {
					const fns = createResolvingFunctions(promise);
					try {
						Reflect.apply(then, resolution, [fns.resolve, fns.reject]);
					} catch (error) {
						guard(error);
						fns.reject(error);
					}
				},
				'thenable',
				then
			);
		};
		const rejectFn = (reason?: unknown) => {
			if (alreadyResolved) return;
			alreadyResolved = true;
			reject(promise, reason);
		};
		return { resolve, reject: rejectFn };
	};

	const newPromiseCapability = (C: unknown): Capability => {
		if (!isConstructor(C))
			throw new TypeError('Promise resolve or reject function is not callable');
		let resolve: unknown;
		let rejectFn: unknown;
		const promise = Reflect.construct(C as new (...a: unknown[]) => object, [
			(res: unknown, rej: unknown) => {
				if (resolve !== undefined || rejectFn !== undefined)
					throw new TypeError('Promise executor has already been invoked');
				resolve = res;
				rejectFn = rej;
			},
		]);
		if (!isCallable(resolve) || !isCallable(rejectFn))
			throw new TypeError('Promise resolve or reject function is not callable');
		return {
			promise,
			resolve: resolve,
			reject: rejectFn,
		};
	};

	const performPromiseThen = (
		promise: object,
		onFulfilled: unknown,
		onRejected: unknown,
		capability: Capability | undefined,
		kind: JobKind = 'reaction',
		label?: unknown
	) => {
		const slots = internals.get(promise)!;
		const fulfillReaction: Reaction = {
			capability,
			type: 'fulfill',
			handler: isCallable(onFulfilled) ? onFulfilled : undefined,
			label,
			kind,
		};
		const rejectReaction: Reaction = {
			capability,
			type: 'reject',
			handler: isCallable(onRejected) ? onRejected : undefined,
			label,
			kind,
		};
		if (slots.state === 'pending') {
			slots.fulfillReactions.push(fulfillReaction);
			slots.rejectReactions.push(rejectReaction);
		} else if (slots.state === 'fulfilled') {
			enqueueReactionJob(fulfillReaction, slots.result);
		} else {
			if (!slots.isHandled) host.trackRejection(promise, 'handle');
			enqueueReactionJob(rejectReaction, slots.result);
		}
		slots.isHandled = true;
		return capability?.promise;
	};

	const speciesConstructor = (object: object, fallback: unknown): unknown => {
		const C = (object as { constructor?: unknown }).constructor;
		if (C === undefined) return fallback;
		if (!isObject(C))
			throw new TypeError('object.constructor is not an object');
		const S = (C as Record<symbol, unknown>)[Symbol.species];
		if (S === undefined || S === null) return fallback;
		if (isConstructor(S)) return S;
		throw new TypeError(
			'object.constructor[Symbol.species] is not a constructor'
		);
	};

	const promiseResolve = (C: unknown, x: unknown): object => {
		if (isObject(x) && internals.has(x)) {
			if ((x as { constructor?: unknown }).constructor === C) return x;
		}
		const capability = newPromiseCapability(C);
		capability.resolve(x);
		return capability.promise;
	};

	const getPromiseResolve = (C: unknown) => {
		const resolve = (C as { resolve?: unknown }).resolve;
		if (!isCallable(resolve))
			throw new TypeError('Promise resolve is not a function');
		return resolve;
	};

	type Executor = (
		resolve: (value?: unknown) => void,
		reject: (reason?: unknown) => void
	) => void;

	class SimPromise<T = unknown> {
		constructor(executor: Executor) {
			if (new.target === undefined)
				throw new TypeError(
					"Promise constructor cannot be invoked without 'new'"
				);
			if (!isCallable(executor))
				throw new TypeError(
					`Promise resolver ${String(executor)} is not a function`
				);
			internals.set(this, {
				state: 'pending',
				result: undefined,
				fulfillReactions: [],
				rejectReactions: [],
				isHandled: false,
			});
			const { resolve, reject: rejectFn } = createResolvingFunctions(this);
			try {
				executor(resolve, rejectFn);
			} catch (error) {
				guard(error);
				rejectFn(error);
			}
		}

		then<R1 = T, R2 = never>(
			onFulfilled?: ((value: T) => R1) | null,
			onRejected?: ((reason: unknown) => R2) | null
		): SimPromise<R1 | R2> {
			getInternals(this, 'then');
			const C = speciesConstructor(this, SimPromise);
			const capability = newPromiseCapability(C);
			return performPromiseThen(
				this,
				onFulfilled,
				onRejected,
				capability
			) as SimPromise<R1 | R2>;
		}

		catch<R = never>(onRejected?: ((reason: unknown) => R) | null) {
			return (this as unknown as { then: SimPromise['then'] }).then(
				undefined,
				onRejected
			);
		}

		finally(onFinally?: (() => unknown) | null) {
			if (!isObject(this))
				throw new TypeError('Promise.prototype.finally called on a non-object');
			const C = speciesConstructor(this, SimPromise);
			let thenFinally: unknown = onFinally;
			let catchFinally: unknown = onFinally;
			if (isCallable(onFinally)) {
				thenFinally = (value: unknown) => {
					const result = onFinally();
					const promise = promiseResolve(C, result);
					return (promise as SimPromise).then(() => value);
				};
				catchFinally = (reason: unknown) => {
					const result = onFinally();
					const promise = promiseResolve(C, result);
					return (promise as SimPromise).then(() => {
						throw reason;
					});
				};
				labels.set(thenFinally as object, onFinally);
				labels.set(catchFinally as object, onFinally);
			}
			return (this as unknown as { then: SimPromise['then'] }).then(
				thenFinally as never,
				catchFinally as never
			);
		}

		static resolve(this: unknown, value?: unknown) {
			if (!isObject(this))
				throw new TypeError('PromiseResolve called on non-object');
			return promiseResolve(this, value);
		}

		static reject(this: unknown, reason?: unknown) {
			const capability = newPromiseCapability(this);
			capability.reject(reason);
			return capability.promise;
		}

		static withResolvers(this: unknown) {
			const { promise, resolve, reject: rejectFn } = newPromiseCapability(this);
			return { promise, resolve, reject: rejectFn };
		}

		static try(this: unknown, callback: unknown, ...args: unknown[]) {
			if (!isObject(this))
				throw new TypeError('Promise.try called on non-object');
			const capability = newPromiseCapability(this);
			try {
				capability.resolve((callback as (...a: unknown[]) => unknown)(...args));
			} catch (error) {
				guard(error);
				capability.reject(error);
			}
			return capability.promise;
		}

		static all(this: unknown, iterable: unknown) {
			return combinator(this, iterable, 'all');
		}

		static allSettled(this: unknown, iterable: unknown) {
			return combinator(this, iterable, 'allSettled');
		}

		static any(this: unknown, iterable: unknown) {
			return combinator(this, iterable, 'any');
		}

		static race(this: unknown, iterable: unknown) {
			const capability = newPromiseCapability(this);
			try {
				const resolve = getPromiseResolve(this);
				for (const next of iterable as Iterable<unknown>) {
					const nextPromise = Reflect.apply(resolve, this, [
						next,
					]) as SimPromise;
					nextPromise.then(capability.resolve, capability.reject);
				}
			} catch (error) {
				guard(error);
				capability.reject(error);
			}
			return capability.promise;
		}

		static get [Symbol.species]() {
			return this;
		}

		get [Symbol.toStringTag]() {
			return 'Promise';
		}
	}

	// user code sees it as the global Promise
	Object.defineProperty(SimPromise, 'name', { value: 'Promise' });

	/** Promise.all / allSettled / any share the same "remaining elements" logic. */
	const combinator = (
		C: unknown,
		iterable: unknown,
		mode: 'all' | 'allSettled' | 'any'
	) => {
		const capability = newPromiseCapability(C);
		try {
			const resolve = getPromiseResolve(C);
			const values: unknown[] = [];
			let remaining = 1;
			let index = 0;
			const finish = () => {
				if (mode === 'any') {
					const error = new AggregateError(
						values,
						'All promises were rejected'
					);
					capability.reject(error);
				} else {
					capability.resolve(values);
				}
			};
			for (const next of iterable as Iterable<unknown>) {
				const currentIndex = index++;
				values.push(undefined);
				const nextPromise = Reflect.apply(resolve, C, [next]) as SimPromise;
				let called = false;
				const settle = (record: unknown) => {
					if (called) return;
					called = true;
					values[currentIndex] = record;
					if (--remaining === 0) finish();
				};
				remaining++;
				if (mode === 'all') {
					nextPromise.then(settle, capability.reject);
				} else if (mode === 'allSettled') {
					nextPromise.then(
						(value) => settle({ status: 'fulfilled', value }),
						(reason) => settle({ status: 'rejected', reason })
					);
				} else {
					nextPromise.then(capability.resolve, settle);
				}
			}
			if (--remaining === 0) finish();
		} catch (error) {
			guard(error);
			capability.reject(error);
		}
		return capability.promise;
	};

	/** Internal handlers created on behalf of user callbacks (e.g. finally). */
	const labels = new WeakMap<object, unknown>();

	/**
	 * Await(value) from §27.7.5.3: PromiseResolve(%Promise%, value) followed by
	 * PerformPromiseThen without a result capability.
	 */
	const awaitValue = (
		value: unknown,
		onFulfilled: (value: unknown) => void,
		onRejected: (reason: unknown) => void,
		label: unknown
	) => {
		const promise = promiseResolve(SimPromise, value);
		performPromiseThen(
			promise,
			onFulfilled,
			onRejected,
			undefined,
			'await',
			label
		);
	};

	const inspect = (value: unknown) => {
		const slots = isObject(value) ? internals.get(value) : undefined;
		if (!slots) return null;
		return { state: slots.state, value: slots.result };
	};

	return {
		Promise: SimPromise,
		newPromiseCapability: () => newPromiseCapability(SimPromise),
		awaitValue,
		inspect,
		labelOf: (handler: unknown) =>
			isObject(handler) && labels.has(handler) ? labels.get(handler) : handler,
	};
};
