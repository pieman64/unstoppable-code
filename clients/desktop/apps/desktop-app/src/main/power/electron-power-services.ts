import type {
  PlatformPowerAcquireResult,
  PlatformPowerAssertionEnd,
  PlatformPowerServices,
} from '@canopy/core-runtime';

export interface PowerSaveBlockerLike {
  start: (type: 'prevent-app-suspension') => number;
  stop: (id: number) => void;
  isStarted: (id: number) => boolean;
}

const UNAVAILABLE = 'Electron powerSaveBlocker is unavailable.';
const NOT_STARTED = 'Electron powerSaveBlocker did not start.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPowerSaveBlockerLike(value: unknown): value is PowerSaveBlockerLike {
  return (
    isRecord(value) &&
    typeof value.start === 'function' &&
    typeof value.stop === 'function' &&
    typeof value.isStarted === 'function'
  );
}

function resolveElectronPowerSaveBlocker(): PowerSaveBlockerLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electronModule: unknown = require('electron');
    if (!isRecord(electronModule)) {
      return null;
    }
    const candidate = electronModule.powerSaveBlocker;
    return isPowerSaveBlockerLike(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/** The in-process desktop composition's power port, over `powerSaveBlocker`. */
export function createElectronPowerServices(
  injected?: PowerSaveBlockerLike | null,
): PlatformPowerServices {
  // Resolved on first use, so composition never loads Electron; `null`
  // means there is none.
  let blocker = injected;
  const getBlocker = (): PowerSaveBlockerLike | null => {
    if (blocker === undefined) blocker = resolveElectronPowerSaveBlocker();
    return blocker;
  };

  return {
    mechanism: 'electron',
    preventSystemSleep: (): PlatformPowerAcquireResult => {
      // Named for the census, which matches the Electron receiver.
      const powerSaveBlocker = getBlocker();
      if (!powerSaveBlocker)
        return { kind: 'unavailable', reason: UNAVAILABLE };
      const id = powerSaveBlocker.start('prevent-app-suspension');
      if (!Number.isFinite(id) || !powerSaveBlocker.isStarted(id)) {
        return {
          kind: 'failed',
          reason: NOT_STARTED,
          ...(Number.isFinite(id) && { id }),
        };
      }

      let released = false;
      let end: (value: PlatformPowerAssertionEnd) => void = () => undefined;
      const ended = new Promise<PlatformPowerAssertionEnd>((resolve) => {
        end = resolve;
      });
      return {
        kind: 'acquired',
        assertion: {
          id,
          isHeld: () => powerSaveBlocker.isStarted(id),
          held: Promise.resolve(true),
          ended,
          release: (): Promise<void> => {
            if (released) return Promise.resolve();
            // A throw keeps the blocker, so a later release retries stop.
            if (powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id);
            released = true;
            end({ kind: 'released' });
            return Promise.resolve();
          },
        },
      };
    },
  };
}
