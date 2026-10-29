import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import { isWakeLockSupportedPlatform } from '@canopy/desktop-shared/platform-capabilities';
import type { WakeLockState } from '@canopy/desktop-shared/types';
import { getObservabilityService } from '../observability';
import type { AppDiagnosticRecord } from '../observability/service';

export interface PowerSaveBlockerLike {
  start: (type: 'prevent-app-suspension') => number;
  stop: (id: number) => void;
  isStarted: (id: number) => boolean;
}

interface WakeLockHolder {
  key: string;
  reason: string;
  acquiredAt: number;
}

interface WakeLockBroadcastHandlers {
  stateChanged: (state: WakeLockState) => void;
}

export interface WakeLockServiceOptions {
  platform?: NodeJS.Platform;
  powerSaveBlocker?: PowerSaveBlockerLike | null;
  recordDiagnostic?: (record: AppDiagnosticRecord) => void;
  now?: () => number;
}

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

export class WakeLockService {
  private readonly holders = new Map<string, WakeLockHolder>();
  /**
   * Holder keys embed session keys (`chat:<workspace>/<worktree>/<chat>`),
   * and these diagnostics land in the global app-events, which must never
   * carry worktree or chat ids. Each holder is recorded as its category and a
   * per-process ordinal instead, so acquire and release still pair up.
   */
  private readonly holderOrdinals = new Map<string, number>();
  private nextHolderOrdinal = 0;
  private readonly platform: NodeJS.Platform;
  private readonly recordDiagnostic: (record: AppDiagnosticRecord) => void;
  private readonly now: () => number;
  private powerSaveBlocker: PowerSaveBlockerLike | null | undefined;
  private blockerId: number | null = null;
  private enabled = true;
  private broadcastHandlers: WakeLockBroadcastHandlers | null = null;
  private lastEmittedState: WakeLockState | null = null;
  private unavailableWarningEmitted = false;

  constructor(options: WakeLockServiceOptions = {}) {
    this.platform = options.platform ?? hostPlatformOperatingSystem();
    this.powerSaveBlocker = options.powerSaveBlocker;
    this.recordDiagnostic = options.recordDiagnostic ?? defaultRecordDiagnostic;
    this.now = options.now ?? Date.now;
  }

  acquire(key: string, reason: string): void {
    const existing = this.holders.get(key);
    if (existing) {
      this.holders.set(key, { ...existing, reason });
      // If a previous startBlocker() failed (blockerId === null with holders
      // present), reconcile so a same-key re-acquire can retry rather than
      // having to wait for a different key or release/re-acquire cycle.
      if (this.blockerId === null) {
        this.reconcile();
      } else {
        this.emitStateIfChanged();
      }
      return;
    }

    this.holders.set(key, { key, reason, acquiredAt: this.now() });
    this.record('wake_lock_acquired', {
      holderKey: this.holderLabel(key),
      holderCount: this.holders.size,
      enabled: this.enabled,
    });
    this.reconcile();
  }

  release(key: string): void {
    if (!this.holders.delete(key)) {
      return;
    }

    const holderKey = this.holderLabel(key);
    this.holderOrdinals.delete(key);
    this.record('wake_lock_released', {
      holderKey,
      holderCount: this.holders.size,
      enabled: this.enabled,
    });
    this.reconcile();
  }

  /** `chat#3`: the key's category and this holder's ordinal, no ids. */
  private holderLabel(key: string): string {
    let ordinal = this.holderOrdinals.get(key);
    if (ordinal === undefined) {
      this.nextHolderOrdinal += 1;
      ordinal = this.nextHolderOrdinal;
      this.holderOrdinals.set(key, ordinal);
    }
    const separator = key.indexOf(':');
    const category = separator > 0 ? key.slice(0, separator) : 'holder';
    return `${category}#${ordinal}`;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) {
      this.reconcile();
      return;
    }

    this.enabled = enabled;
    this.reconcile();
  }

  getState(): WakeLockState {
    return {
      active: this.blockerId !== null && this.isBlockerStarted(this.blockerId),
      enabled: this.enabled,
      holderCount: this.holders.size,
    };
  }

  getHolders(): WakeLockHolder[] {
    return Array.from(this.holders.values()).map((holder) => ({ ...holder }));
  }

  setBroadcastHandlers(handlers: WakeLockBroadcastHandlers): void {
    this.broadcastHandlers = handlers;
    this.emitStateIfChanged();
  }

  shutdown(): void {
    this.stopBlocker();
    this.holders.clear();
    this.holderOrdinals.clear();
    this.emitStateIfChanged();
  }

  private reconcile(): void {
    const shouldRun =
      isWakeLockSupportedPlatform(this.platform) &&
      this.enabled &&
      this.holders.size > 0;
    if (this.blockerId !== null && !this.isBlockerStarted(this.blockerId)) {
      this.record('wake_lock_stopped', {
        blockerId: this.blockerId,
        holderCount: this.holders.size,
        enabled: this.enabled,
      });
      this.blockerId = null;
    }
    if (shouldRun && this.blockerId === null) {
      this.startBlocker();
    } else if (!shouldRun && this.blockerId !== null) {
      this.stopBlocker();
    }
    this.emitStateIfChanged();
  }

  private startBlocker(): void {
    const powerSaveBlocker = this.getPowerSaveBlocker();
    if (!powerSaveBlocker) {
      this.recordError('Electron powerSaveBlocker is unavailable.');
      return;
    }

    try {
      const id = powerSaveBlocker.start('prevent-app-suspension');
      if (!Number.isFinite(id) || !powerSaveBlocker.isStarted(id)) {
        this.recordError('Electron powerSaveBlocker did not start.', {
          blockerId: Number.isFinite(id) ? id : undefined,
        });
        return;
      }

      this.blockerId = id;
      this.record('wake_lock_started', {
        blockerId: id,
        holderCount: this.holders.size,
        enabled: this.enabled,
      });
    } catch (error) {
      this.recordError(getErrorMessage(error));
    }
  }

  private stopBlocker(): void {
    const id = this.blockerId;
    if (id === null) {
      return;
    }

    const powerSaveBlocker = this.getPowerSaveBlocker();
    try {
      if (powerSaveBlocker?.isStarted(id)) {
        powerSaveBlocker.stop(id);
      }
      // Clear blockerId only after stop succeeds so a future
      // reconcile()/shutdown() can retry cleanup if Electron throws.
      this.blockerId = null;
      this.record('wake_lock_stopped', {
        blockerId: id,
        holderCount: this.holders.size,
        enabled: this.enabled,
      });
    } catch (error) {
      // Keep blockerId so a later reconcile()/shutdown() can retry stop.
      this.recordError(getErrorMessage(error), { blockerId: id });
    }
  }

  private isBlockerStarted(id: number): boolean {
    try {
      return this.getPowerSaveBlocker()?.isStarted(id) ?? false;
    } catch (error) {
      this.recordError(getErrorMessage(error), { blockerId: id });
      return false;
    }
  }

  private getPowerSaveBlocker(): PowerSaveBlockerLike | null {
    if (!isWakeLockSupportedPlatform(this.platform)) {
      return null;
    }

    if (this.powerSaveBlocker !== undefined) {
      return this.powerSaveBlocker;
    }

    this.powerSaveBlocker = resolveElectronPowerSaveBlocker();
    return this.powerSaveBlocker;
  }

  private emitStateIfChanged(): void {
    const state = this.getState();
    if (
      this.lastEmittedState &&
      this.lastEmittedState.active === state.active &&
      this.lastEmittedState.enabled === state.enabled &&
      this.lastEmittedState.holderCount === state.holderCount
    ) {
      return;
    }

    this.lastEmittedState = state;
    this.broadcastHandlers?.stateChanged(state);
  }

  private record(
    kind: AppDiagnosticRecord['kind'],
    extra: Omit<AppDiagnosticRecord, 'version' | 'timestamp' | 'kind'> = {},
  ): void {
    this.recordDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind,
      ...extra,
    });
  }

  private recordError(
    reason: string,
    extra: Omit<AppDiagnosticRecord, 'version' | 'timestamp' | 'kind'> = {},
  ): void {
    if (
      reason === 'Electron powerSaveBlocker is unavailable.' &&
      this.unavailableWarningEmitted
    ) {
      return;
    }
    if (reason === 'Electron powerSaveBlocker is unavailable.') {
      this.unavailableWarningEmitted = true;
    }
    this.record('wake_lock_error', {
      reason,
      holderCount: this.holders.size,
      enabled: this.enabled,
      ...extra,
    });
    process.emitWarning(reason, {
      type: 'CanopyWarning',
      code: 'CANOPY_WAKE_LOCK_ERROR',
    });
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
