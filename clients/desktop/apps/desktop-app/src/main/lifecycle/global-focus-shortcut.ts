import { app, globalShortcut, ipcMain } from 'electron';
import type {
  GlobalFocusShortcutFailureReason,
  GlobalFocusShortcutStatus,
  GlobalFocusShortcutUpdateResponse,
} from '@canopy/desktop-shared/types';
import {
  GLOBAL_FOCUS_SHORTCUT_DEFAULT_ACCELERATOR,
  normalizeAccelerator,
  toShortcutPlatform,
  validateGlobalShortcut,
  type ShortcutPlatform,
} from '@canopy/desktop-shared/lib/global-shortcut-accelerator';
import { isE2eBuild } from '../lib/e2e-gate';

/**
 * OS-level focus shortcut (CAN-1963): one system-wide chord that brings the
 * main window to the front from any application.
 *
 * Electron's `globalShortcut` is wrapped behind {@link GlobalShortcutRegistrar}
 * for two reasons. Unit tests drive the service with an in-memory registrar,
 * and the E2E build MUST NOT claim a real chord on the developer machine
 * (the suite would steal ⌘⇧O system-wide, and collide with a running dev
 * app), so it swaps in {@link createE2eGlobalShortcutRegistrar}.
 *
 * Invariants:
 * - `apply()` never leaves the user without a working binding: when the OS
 *   refuses a new chord the previous registration is put back.
 * - Registration is idempotent per process; re-applying the same config is a
 *   no-op. `dispose()` runs from runtime cleanup so nothing outlives the app.
 * - Success is not proof. Electron reports a chord held by another app as
 *   registered, so `lastTriggeredAt` is the only honest "it works" signal.
 */

export interface GlobalShortcutRegistrar {
  /** Mirrors `globalShortcut.register`: `false` when the OS refused. */
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

export interface GlobalFocusShortcutConfig {
  enabled: boolean;
  accelerator: string;
}

export interface GlobalFocusShortcutServiceOptions {
  registrar: GlobalShortcutRegistrar;
  platform: NodeJS.Platform;
  /** Runs when the OS delivers the chord. */
  onTrigger: () => void;
  onStatusChanged?: (status: GlobalFocusShortcutStatus) => void;
  now?: () => Date;
}

type StatusFields = Omit<
  GlobalFocusShortcutStatus,
  'platform' | 'lastTriggeredAt'
>;

function sameStatus(
  left: GlobalFocusShortcutStatus,
  right: GlobalFocusShortcutStatus,
): boolean {
  return (
    left.enabled === right.enabled &&
    left.accelerator === right.accelerator &&
    left.registered === right.registered &&
    left.failure === right.failure &&
    left.lastTriggeredAt === right.lastTriggeredAt &&
    left.platform === right.platform
  );
}

export class GlobalFocusShortcutService {
  private readonly registrar: GlobalShortcutRegistrar;
  private readonly platform: ShortcutPlatform;
  private readonly onTrigger: () => void;
  private readonly onStatusChanged?: (
    status: GlobalFocusShortcutStatus,
  ) => void;
  private readonly now: () => Date;
  private activeAccelerator: string | null = null;
  private lastTriggeredAt: string | undefined;
  private status: GlobalFocusShortcutStatus;

  constructor(options: GlobalFocusShortcutServiceOptions) {
    this.registrar = options.registrar;
    this.platform = toShortcutPlatform(options.platform);
    this.onTrigger = options.onTrigger;
    this.onStatusChanged = options.onStatusChanged;
    this.now = options.now ?? ((): Date => new Date());
    this.status = {
      enabled: false,
      accelerator: GLOBAL_FOCUS_SHORTCUT_DEFAULT_ACCELERATOR,
      registered: false,
      platform: this.platform,
    };
  }

  getStatus(): GlobalFocusShortcutStatus {
    return { ...this.status };
  }

  /** The chord currently registered with the OS, if any. */
  getActiveAccelerator(): string | null {
    return this.activeAccelerator;
  }

  /**
   * Bring the OS registration in line with `config`. Never throws. On
   * failure the previous working registration (if any) is restored and the
   * returned status reports the refused chord with its reason.
   */
  apply(config: GlobalFocusShortcutConfig): GlobalFocusShortcutUpdateResponse {
    // Callers pass persisted data; a file written before this preference
    // existed arrives without an accelerator and must not crash startup.
    const requested =
      typeof config.accelerator === 'string'
        ? config.accelerator
        : GLOBAL_FOCUS_SHORTCUT_DEFAULT_ACCELERATOR;
    const validation = validateGlobalShortcut(requested, this.platform);
    if (config.enabled !== true) {
      this.releaseActive();
      // Mirror what the preference writer will keep: a chord the validator
      // rejects falls back to the default there, so the live status must not
      // show a value that will never be persisted.
      this.setStatus({
        enabled: false,
        accelerator: validation.ok
          ? validation.accelerator
          : GLOBAL_FOCUS_SHORTCUT_DEFAULT_ACCELERATOR,
        registered: false,
      });
      return { ok: true, status: this.getStatus() };
    }

    if (!validation.ok) {
      // Refused before reaching the OS; whatever was registered stays put.
      return this.refuse(requested, validation.reason);
    }

    const accelerator = validation.accelerator;
    if (this.activeAccelerator === accelerator) {
      this.setStatus({ enabled: true, accelerator, registered: true });
      return { ok: true, status: this.getStatus() };
    }

    const previous = this.activeAccelerator;
    // The proof belongs to `previous`; release clears it (a real remap must
    // be proven again), but a refused remap puts the same registration
    // straight back, and that chord is as proven as it was a moment ago.
    const previousProof = this.lastTriggeredAt;
    this.releaseActive();
    const outcome = this.tryRegister(accelerator);
    if (outcome === 'registered') {
      this.activeAccelerator = accelerator;
      this.setStatus({ enabled: true, accelerator, registered: true });
      return { ok: true, status: this.getStatus() };
    }

    if (previous !== null && this.tryRegister(previous) === 'registered') {
      this.activeAccelerator = previous;
      this.lastTriggeredAt = previousProof;
    }
    return this.refuse(accelerator, outcome === 'threw' ? 'invalid' : 'in-use');
  }

  dispose(): void {
    this.releaseActive();
    this.setStatus({
      enabled: this.status.enabled,
      accelerator: this.status.accelerator,
      registered: false,
    });
  }

  private refuse(
    accelerator: string,
    reason: GlobalFocusShortcutFailureReason,
  ): GlobalFocusShortcutUpdateResponse {
    this.setStatus({
      enabled: true,
      accelerator,
      registered: false,
      failure: reason,
    });
    return { ok: false, reason, accelerator, status: this.getStatus() };
  }

  private tryRegister(accelerator: string): 'registered' | 'refused' | 'threw' {
    try {
      return this.registrar.register(accelerator, () => this.handleTrigger())
        ? 'registered'
        : 'refused';
    } catch {
      return 'threw';
    }
  }

  private releaseActive(): void {
    if (this.activeAccelerator === null) return;
    try {
      this.registrar.unregister(this.activeAccelerator);
    } catch {
      // Best-effort: an unregister that throws leaves nothing to recover.
    }
    this.activeAccelerator = null;
    // The proof belonged to the binding just released. A remapped or
    // re-enabled chord must be delivered by the OS again before Settings
    // may call it "Working".
    this.lastTriggeredAt = undefined;
  }

  private handleTrigger(): void {
    // macOS auto-repeats a held hot key. Every delivery reaches the trigger
    // handler, but the proof transitions once per registration so the status
    // is not rebroadcast to every window at key-repeat rate.
    if (this.lastTriggeredAt === undefined) {
      this.lastTriggeredAt = this.now().toISOString();
      this.setStatus({
        enabled: this.status.enabled,
        accelerator: this.status.accelerator,
        registered: this.status.registered,
        ...(this.status.failure !== undefined
          ? { failure: this.status.failure }
          : {}),
      });
    }
    this.onTrigger();
  }

  private setStatus(fields: StatusFields): void {
    const next: GlobalFocusShortcutStatus = {
      ...fields,
      platform: this.platform,
      ...(this.lastTriggeredAt !== undefined
        ? { lastTriggeredAt: this.lastTriggeredAt }
        : {}),
    };
    if (sameStatus(this.status, next)) return;
    this.status = next;
    this.onStatusChanged?.(this.getStatus());
  }
}

export function createElectronGlobalShortcutRegistrar(): GlobalShortcutRegistrar {
  return {
    register: (accelerator, callback): boolean =>
      globalShortcut.register(accelerator, callback),
    unregister: (accelerator): void => {
      globalShortcut.unregister(accelerator);
    },
  };
}

/**
 * E2E-only substitute for the OS. `CANOPY_E2E_GLOBAL_SHORTCUT_FLOW=in-use:<accelerator>[,<accelerator>]`
 * makes those chords register as refused (another app holds them); every
 * other chord registers. Specs fire the registered chord by emitting
 * {@link E2E_GLOBAL_FOCUS_SHORTCUT_TRIGGER_CHANNEL} on `ipcMain`.
 */
export interface E2eGlobalShortcutFlow {
  inUse: string[];
}

export interface E2eGlobalShortcutRegistrar extends GlobalShortcutRegistrar {
  trigger(): void;
}

export const E2E_GLOBAL_FOCUS_SHORTCUT_TRIGGER_CHANNEL =
  'e2e:global-focus-shortcut-trigger';

export function parseE2eGlobalShortcutFlow(
  value: string | undefined,
): E2eGlobalShortcutFlow {
  const prefix = 'in-use:';
  if (value === undefined || !value.startsWith(prefix)) return { inUse: [] };
  const inUse = value
    .slice(prefix.length)
    .split(',')
    .map((entry) => normalizeAccelerator(entry.trim()))
    .filter((entry): entry is string => entry !== null);
  return { inUse };
}

export function createE2eGlobalShortcutRegistrar(
  flow: E2eGlobalShortcutFlow,
): E2eGlobalShortcutRegistrar {
  const registered = new Map<string, () => void>();
  const canonical = (accelerator: string): string =>
    normalizeAccelerator(accelerator) ?? accelerator;
  return {
    register(accelerator, callback): boolean {
      const key = canonical(accelerator);
      if (flow.inUse.includes(key) || registered.has(key)) return false;
      registered.set(key, callback);
      return true;
    },
    unregister(accelerator): void {
      registered.delete(canonical(accelerator));
    },
    trigger(): void {
      for (const callback of Array.from(registered.values())) callback();
    },
  };
}

/**
 * Local QA override for unpackaged builds only. The listed chords register as
 * refused (as if another application held them) while every other chord still
 * reaches the real OS, so the conflict states in Settings and the checklist can
 * be exercised from `npm run dev` without a second app:
 *
 *   CANOPY_DEV_GLOBAL_SHORTCUT_FLOW=in-use:CommandOrControl+Shift+O npm run dev
 *
 * Packaged builds never read it.
 */
export function withRefusedAccelerators(
  registrar: GlobalShortcutRegistrar,
  flow: E2eGlobalShortcutFlow,
): GlobalShortcutRegistrar {
  if (flow.inUse.length === 0) return registrar;
  return {
    register(accelerator, callback): boolean {
      const key = normalizeAccelerator(accelerator) ?? accelerator;
      if (flow.inUse.includes(key)) return false;
      return registrar.register(accelerator, callback);
    },
    unregister(accelerator): void {
      registrar.unregister(accelerator);
    },
  };
}

let service: GlobalFocusShortcutService | null = null;

export type InitializeGlobalFocusShortcutOptions = Omit<
  GlobalFocusShortcutServiceOptions,
  'registrar' | 'platform'
> & { registrar?: GlobalShortcutRegistrar };

/**
 * Create the process-lifetime service. Production wraps Electron's
 * `globalShortcut`; the E2E build wraps the in-memory fake and exposes the
 * trigger seam. Idempotent, and first caller wins: a second call returns the
 * live instance and its options (`onTrigger`, `onStatusChanged`, `now`) are
 * ignored, so there must be exactly one initializing call site.
 */
export function initializeGlobalFocusShortcutService(
  options: InitializeGlobalFocusShortcutOptions,
): GlobalFocusShortcutService {
  if (service !== null) return service;
  let registrar = options.registrar;
  if (registrar === undefined) {
    if (isE2eBuild()) {
      const fake = createE2eGlobalShortcutRegistrar(
        parseE2eGlobalShortcutFlow(process.env.CANOPY_E2E_GLOBAL_SHORTCUT_FLOW),
      );
      ipcMain.on(E2E_GLOBAL_FOCUS_SHORTCUT_TRIGGER_CHANNEL, () => {
        fake.trigger();
      });
      registrar = fake;
    } else {
      registrar = createElectronGlobalShortcutRegistrar();
      if (!app.isPackaged) {
        registrar = withRefusedAccelerators(
          registrar,
          parseE2eGlobalShortcutFlow(
            process.env.CANOPY_DEV_GLOBAL_SHORTCUT_FLOW,
          ),
        );
      }
    }
  }
  service = new GlobalFocusShortcutService({
    registrar,
    platform: process.platform,
    onTrigger: options.onTrigger,
    onStatusChanged: options.onStatusChanged,
    now: options.now,
  });
  return service;
}

export function getGlobalFocusShortcutService(): GlobalFocusShortcutService {
  if (service === null) {
    throw new Error('Global focus shortcut service is not initialized.');
  }
  return service;
}

/** Runtime cleanup seam: safe to call before initialization. */
export function disposeGlobalFocusShortcutService(): void {
  service?.dispose();
}

/**
 * Preference side effects run in unit suites that never start the app, so
 * they read the service through this tolerant getter rather than the
 * throwing one the IPC handlers use.
 */
export function tryGetGlobalFocusShortcutService(): GlobalFocusShortcutService | null {
  return service;
}

export function resetGlobalFocusShortcutServiceForTests(): void {
  service?.dispose();
  service = null;
}
