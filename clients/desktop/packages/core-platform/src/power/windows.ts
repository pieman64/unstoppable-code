import type {
  PlatformPowerAcquireResult,
  PlatformPowerAssertionEnd,
  PlatformPowerServices,
} from '@canopy/core-runtime';

const UNAVAILABLE = 'Power execution state is unavailable on this host.';
const REFUSED = 'Windows refused the power execution state.';
const NOT_CLEARED = 'Windows did not clear the power execution state.';

/**
 * `SetThreadExecutionState` through the owned-child addon. Assertions share
 * one thread state: it is set for the first and cleared after the last.
 * Windows drops it when the host's main thread ends.
 */
export function createWindowsPowerServices(
  load: () => (systemRequired: boolean) => boolean,
): PlatformPowerServices {
  let setState: ((systemRequired: boolean) => boolean) | null | undefined;
  let holders = 0;
  let nextId = 1;

  return {
    mechanism: 'thread-execution-state',
    preventSystemSleep: (): PlatformPowerAcquireResult => {
      if (setState === undefined) {
        try {
          setState = load();
        } catch {
          setState = null;
        }
      }
      const set = setState;
      if (set === null) return { kind: 'unavailable', reason: UNAVAILABLE };
      if (holders === 0 && !set(true))
        return { kind: 'failed', reason: REFUSED };
      holders += 1;

      let released = false;
      let end: (value: PlatformPowerAssertionEnd) => void = () => undefined;
      const ended = new Promise<PlatformPowerAssertionEnd>((resolve) => {
        end = resolve;
      });
      return {
        kind: 'acquired',
        assertion: {
          id: nextId++,
          isHeld: () => !released,
          held: Promise.resolve(true),
          ended,
          release: (): Promise<void> => {
            if (released) return Promise.resolve();
            // The last holder clears the state; a refusal keeps it held.
            if (holders === 1 && !set(false)) throw new Error(NOT_CLEARED);
            holders -= 1;
            released = true;
            end({ kind: 'released' });
            return Promise.resolve();
          },
        },
      };
    },
  };
}
