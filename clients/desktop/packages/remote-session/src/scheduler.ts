/**
 * Clock and timers, injected so hosts control lifecycle (a SharedWorker, a
 * Node service) and tests drive time deterministically. Handles are opaque.
 */
export interface SchedulerPort {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
  /** Random number in [0, 1) for backoff jitter. */
  random(): number;
}

/** Timers must not hold a Node process open; browsers have no `unref`. */
function unrefIfPossible(handle: unknown): void {
  if (typeof handle !== 'object' || handle === null) return;
  const unref: unknown = Reflect.get(handle, 'unref');
  if (typeof unref === 'function') Reflect.apply(unref, handle, []);
}

export const defaultScheduler: SchedulerPort = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => {
    const handle: unknown = globalThis.setTimeout(callback, delayMs);
    unrefIfPossible(handle);
    return handle;
  },
  clearTimeout: (handle) => {
    if (typeof handle === 'number') globalThis.clearTimeout(handle);
    else if (handle !== null && handle !== undefined)
      Reflect.apply(globalThis.clearTimeout, globalThis, [handle]);
  },
  setInterval: (callback, intervalMs) => {
    const handle: unknown = globalThis.setInterval(callback, intervalMs);
    unrefIfPossible(handle);
    return handle;
  },
  clearInterval: (handle) => {
    if (typeof handle === 'number') globalThis.clearInterval(handle);
    else if (handle !== null && handle !== undefined)
      Reflect.apply(globalThis.clearInterval, globalThis, [handle]);
  },
  random: () => Math.random(),
};
