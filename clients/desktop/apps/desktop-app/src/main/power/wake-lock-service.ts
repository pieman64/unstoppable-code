import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import {
  type PlatformPowerServices,
  type WakeLockHolder,
  WakeLockPolicy,
} from '@canopy/core-runtime';
import { isWakeLockSupportedPlatform } from '@canopy/desktop-shared/platform-capabilities';
import type { WakeLockState } from '@canopy/desktop-shared/types';
import { getObservabilityService } from '../observability';
import type { AppDiagnosticRecord } from '../observability/service';
import {
  createElectronPowerServices,
  type PowerSaveBlockerLike,
} from './electron-power-services';

export type { PowerSaveBlockerLike } from './electron-power-services';

interface WakeLockBroadcastHandlers {
  stateChanged: (state: WakeLockState) => void;
}

export interface WakeLockServiceOptions {
  platform?: NodeJS.Platform;
  powerSaveBlocker?: PowerSaveBlockerLike | null;
  recordDiagnostic?: (record: AppDiagnosticRecord) => void;
  now?: () => number;
}

const NO_POWER: PlatformPowerServices = {
  mechanism: 'unavailable',
  preventSystemSleep: () => ({
    kind: 'unavailable',
    reason: 'Wake lock is unsupported on this platform.',
  }),
};

let diagWarningEmitted = false;

function defaultRecordDiagnostic(record: AppDiagnosticRecord): void {
  try {
    getObservabilityService().recordAppDiagnostic(record);
  } catch (error) {
    // Diagnostics are best-effort and must not affect wake-lock cleanup, but
    // emit a one-shot warning so a broken telemetry pipeline is not invisible.
    if (!diagWarningEmitted) {
      diagWarningEmitted = true;
      process.emitWarning(
        `Wake-lock diagnostics dropped: ${getErrorMessage(error)}`,
        {
          type: 'CanopyWarning',
          code: 'CANOPY_WAKE_LOCK_DIAG_DROP',
        },
      );
    }
  }
}

export function resetWakeLockDiagWarningForTests(): void {
  diagWarningEmitted = false;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The in-process composition: the core holder policy over Electron's
 * `powerSaveBlocker`, with desktop diagnostics and the renderer broadcast.
 */
export class WakeLockService {
  private readonly policy: WakeLockPolicy;

  constructor(options: WakeLockServiceOptions = {}) {
    const platform = options.platform ?? hostPlatformOperatingSystem();
    const recordDiagnostic =
      options.recordDiagnostic ?? defaultRecordDiagnostic;
    this.policy = new WakeLockPolicy(
      isWakeLockSupportedPlatform(platform)
        ? createElectronPowerServices(options.powerSaveBlocker)
        : NO_POWER,
      {
        record: (record): void =>
          recordDiagnostic({
            version: 1,
            timestamp: new Date().toISOString(),
            ...record,
          }),
        warn: (reason): void => {
          process.emitWarning(reason, {
            type: 'CanopyWarning',
            code: 'CANOPY_WAKE_LOCK_ERROR',
          });
        },
        ...(options.now && { now: options.now }),
      },
    );
  }

  acquire(key: string, reason: string): void {
    this.policy.acquire(key, reason);
  }

  release(key: string): void {
    this.policy.release(key);
  }

  setEnabled(enabled: boolean): void {
    this.policy.setEnabled(enabled);
  }

  getState(): WakeLockState {
    return this.policy.getState();
  }

  getHolders(): WakeLockHolder[] {
    return this.policy.getHolders();
  }

  setBroadcastHandlers(handlers: WakeLockBroadcastHandlers): void {
    this.policy.onStateChanged(handlers.stateChanged);
  }

  shutdown(): void {
    void this.policy.shutdown();
  }
}

let wakeLockService: WakeLockService | null = null;

export function getWakeLockService(): WakeLockService {
  if (!wakeLockService) {
    wakeLockService = new WakeLockService();
  }
  return wakeLockService;
}

export function resetWakeLockServiceForTests(): void {
  wakeLockService?.shutdown();
  wakeLockService = null;
  resetWakeLockDiagWarningForTests();
}
