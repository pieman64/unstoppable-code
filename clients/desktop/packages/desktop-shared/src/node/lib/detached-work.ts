// Tracked detached work for W5 writer modules (CAN-3966). The lint in
// eslint.w5-detached-work.mjs requires these helpers there instead of raw
// Promise combinators, dropped promise chains, and timer callbacks, so no work
// started inside a W5 operation silently outlives it.
//
// Storage admission (C3c, CAN-3944) is wired here; call sites never take it.
// - settleAll / settleEach: branches start inside the caller and inherit its
//   admission; both keep the caller from settling before every branch does.
// - trackDetachedWork: `start` runs synchronously under a nested admission of
//   the caller's targets, held before the caller can settle (inherit).
// - detachedWorkCallback: `start` runs when the callback fires, outside the
//   scheduler's possibly settled admission, so its writes admit at their
//   sinks (re-take). Called at once, `detachedWorkCallback(start)()`, it
//   starts a separate operation (a queued phase, setup, discovery) that must
//   not hold the starting operation's admission until it settles.
// Process-local and static, like the Phase 1 writer itself.

import {
  inheritStorageAdmission,
  outsideStorageAdmission,
} from './storage-admission';

type Settled<T extends readonly unknown[]> = {
  -readonly [K in keyof T]: Awaited<T[K]>;
};

type SettledEach<T extends readonly unknown[]> = {
  -readonly [K in keyof T]: PromiseSettledResult<Awaited<T[K]>>;
};

// Started work → the promise that settles once its admission is released.
const pending = new Map<Promise<unknown>, Promise<unknown>>();

/**
 * `Promise.all` that settles only after every branch has: it resolves with
 * the same values, and rejects with the same (first) reason once the other
 * branches have settled, so no started mutation outlives the caller.
 */
export function settleAll<T extends readonly unknown[] | []>(
  values: T,
): Promise<Settled<T>>;
export function settleAll<T>(
  values: Iterable<T | PromiseLike<T>>,
): Promise<Awaited<T>[]>;
export async function settleAll(values: Iterable<unknown>): Promise<unknown[]> {
  let failure: { reason: unknown } | undefined;
  let iteration: { error: unknown } | undefined;
  const branches: Promise<unknown>[] = [];
  // An iterator that throws after yielding work still waits for that work.
  try {
    Array.from(values, (value) =>
      branches.push(
        Promise.resolve(value).catch((reason: unknown) => {
          failure ??= { reason };
          return undefined;
        }),
      ),
    );
  } catch (error) {
    iteration = { error };
  }
  const results = await Promise.all(branches);
  if (iteration) throw iteration.error;
  if (failure) throw failure.reason;
  return results;
}

/**
 * `Promise.allSettled`, except that an iterable throwing after it yielded
 * work rethrows only once that work has settled.
 */
export function settleEach<T extends readonly unknown[] | []>(
  values: T,
): Promise<SettledEach<T>>;
export function settleEach<T>(
  values: Iterable<T | PromiseLike<T>>,
): Promise<PromiseSettledResult<Awaited<T>>[]>;
export async function settleEach(
  values: Iterable<unknown>,
): Promise<PromiseSettledResult<unknown>[]> {
  const branches: Promise<PromiseSettledResult<unknown>>[] = [];
  // Each value is resolved as it is yielded, as Promise.allSettled does.
  try {
    Array.from(values, (value) =>
      branches.push(
        Promise.resolve(value).then(
          (fulfilled): PromiseFulfilledResult<unknown> => ({
            status: 'fulfilled',
            value: fulfilled,
          }),
          (reason: unknown): PromiseRejectedResult => ({
            status: 'rejected',
            reason,
          }),
        ),
      ),
    );
  } catch (error) {
    await Promise.all(branches);
    throw error;
  }
  return Promise.all(branches);
}

/**
 * Starts work that may outlive its caller. `start` runs synchronously; a
 * rejection still reaches the process unhandled-rejection handler, exactly as
 * a `void` discard did.
 */
export function trackDetachedWork(start: () => PromiseLike<unknown>): void {
  const begun: { work?: Promise<unknown> } = {};
  const admitted = inheritStorageAdmission(() => {
    begun.work = Promise.resolve(start());
    return begun.work;
  });
  // `start` ran synchronously; if it threw, only `admitted` carries that.
  const started = begun.work ?? admitted;
  // Tracking a shared in-flight promise again must not report it twice.
  if (pending.has(started)) {
    if (admitted !== started) void admitted.catch(() => undefined);
    return;
  }
  pending.set(started, admitted);
  void admitted.finally(() => pending.delete(started));
}

/**
 * A timer or microtask callback that starts tracked work each time it fires.
 * The callback returns `undefined` when it decides not to start work; a
 * `void` starter is rejected so one cannot hide the work it launches.
 */
export function detachedWorkCallback(
  start: () => PromiseLike<unknown> | undefined,
): () => void {
  return (): void =>
    outsideStorageAdmission(() => {
      const work = start();
      if (work) trackDetachedWork(() => work);
    });
}

/** Resolves once every tracked detached work item has settled. */
export async function settleDetachedWork(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled(pending.values());
}
