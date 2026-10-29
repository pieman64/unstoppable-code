import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  LaunchAtLoginSetResult,
  LaunchAtLoginStatus,
} from '@canopy/desktop-shared/types';
import { isE2eBuild } from '../lib/e2e-gate';

/**
 * Launch at sign-in (CAN-3449): whether the OS opens the app when the user
 * signs in to their computer.
 *
 * The OS is the only source of truth. Nothing is persisted: every status is
 * read back from `app.getLoginItemSettings()`, and a write is judged by the
 * read-back that follows it, because `setLoginItemSettings` returns nothing
 * and the OS may keep a different state (a policy, the Windows Startup apps
 * switch, a macOS registration waiting in System Settings).
 *
 * - macOS 13+ goes through `SMAppService` for the main app. `requires-approval`
 *   is registered but not yet allowed; `not-found` is a registration for a
 *   bundle that is no longer where the OS recorded it. Both read as off, and
 *   turning it on again re-registers.
 * - Windows reads `executableWillLaunchAtLogin`, which also honors the Task
 *   Manager / Settings "Startup apps" disable switch, and writes that switch
 *   together with the run key.
 * - Linux and every unpackaged build are unsupported and never touch the OS.
 *   A dev build would register the bare Electron binary.
 *
 * Construction does no work: the OS is only queried on request, so startup
 * is unchanged.
 */

export type LaunchAtLoginPlatform = LaunchAtLoginStatus['platform'];

/** `SMAppService` status for the main app, as Electron reports it. */
export type MacLoginItemStatus =
  | 'not-registered'
  | 'enabled'
  | 'requires-approval'
  | 'not-found';

/** The subset of `app.getLoginItemSettings()` this service reads. */
export interface LoginItemSnapshot {
  openAtLogin: boolean;
  /** macOS 13+. */
  status?: MacLoginItemStatus;
  /** Windows. */
  executableWillLaunchAtLogin?: boolean;
}

/** The subset of `app.setLoginItemSettings()` settings this service writes. */
export interface LoginItemWrite {
  openAtLogin: boolean;
  /** Windows only: the Startup apps switch. */
  enabled?: boolean;
}

/**
 * The OS seam. Electron's `app` satisfies it structurally; the E2E build
 * substitutes a file-backed fake, which is why both calls may be async.
 */
export interface LoginItemRegistrar {
  getLoginItemSettings(): LoginItemSnapshot | Promise<LoginItemSnapshot>;
  setLoginItemSettings(settings: LoginItemWrite): void | Promise<void>;
}

export interface LaunchAtLoginHost {
  platform: LaunchAtLoginPlatform;
  isPackaged: boolean;
}

export interface LaunchAtLoginServiceOptions {
  registrar: LoginItemRegistrar;
  platform: NodeJS.Platform;
  isPackaged: boolean;
  /**
   * E2E only: the fake OS decides which platform it impersonates and that
   * the build counts as installed. Production uses `platform`/`isPackaged`.
   */
  resolveHost?: () => Promise<LaunchAtLoginHost>;
  openExternal: (url: string) => Promise<void>;
  onStatusChanged?: (status: LaunchAtLoginStatus) => void;
}

const MAC_LOGIN_ITEMS_SETTINGS =
  'x-apple.systempreferences:com.apple.LoginItems-Settings.extension';
const WINDOWS_STARTUP_APPS_SETTINGS = 'ms-settings:startupapps';

export function toLaunchAtLoginPlatform(
  platform: string,
): LaunchAtLoginPlatform {
  return platform === 'darwin' || platform === 'win32' ? platform : 'linux';
}

function unsupportedStatus(
  host: LaunchAtLoginHost,
): LaunchAtLoginStatus | null {
  if (host.platform === 'linux') {
    return {
      platform: host.platform,
      supported: false,
      unsupportedReason: 'platform',
      enabled: false,
      pendingApproval: false,
    };
  }
  if (!host.isPackaged) {
    return {
      platform: host.platform,
      supported: false,
      unsupportedReason: 'development-build',
      enabled: false,
      pendingApproval: false,
    };
  }
  return null;
}

function statusFromSnapshot(
  platform: LaunchAtLoginPlatform,
  snapshot: LoginItemSnapshot,
): LaunchAtLoginStatus {
  if (platform === 'win32') {
    return {
      platform,
      supported: true,
      enabled: snapshot.executableWillLaunchAtLogin ?? snapshot.openAtLogin,
      pendingApproval: false,
    };
  }
  // `status` is always present on the macOS versions Electron 42 supports;
  // the fallback only guards an older Electron or a partial fake.
  if (snapshot.status === undefined) {
    return {
      platform,
      supported: true,
      enabled: snapshot.openAtLogin,
      pendingApproval: false,
    };
  }
  return {
    platform,
    supported: true,
    enabled: snapshot.status === 'enabled',
    pendingApproval: snapshot.status === 'requires-approval',
  };
}

export class LaunchAtLoginService {
  private readonly registrar: LoginItemRegistrar;
  private readonly host: () => Promise<LaunchAtLoginHost>;
  private readonly openExternal: (url: string) => Promise<void>;
  private readonly onStatusChanged?: (status: LaunchAtLoginStatus) => void;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(options: LaunchAtLoginServiceOptions) {
    this.registrar = options.registrar;
    const fixedHost: LaunchAtLoginHost = {
      platform: toLaunchAtLoginPlatform(options.platform),
      isPackaged: options.isPackaged,
    };
    this.host =
      options.resolveHost ??
      ((): Promise<LaunchAtLoginHost> => Promise.resolve(fixedHost));
    this.openExternal = options.openExternal;
    this.onStatusChanged = options.onStatusChanged;
  }

  async getStatus(): Promise<LaunchAtLoginStatus> {
    return this.readStatus(await this.host());
  }

  /**
   * Ask the OS to add or remove the app, then read back what it kept.
   * Overlapping calls run one after another, so a quick on/off pair cannot
   * interleave its write and read-back.
   */
  setEnabled(enabled: boolean): Promise<LaunchAtLoginSetResult> {
    const run = this.writes.then(() => this.applyEnabled(enabled));
    this.writes = run.catch(() => undefined);
    return run;
  }

  /** Login Items on macOS, Startup apps on Windows. Best-effort. */
  async openSystemSettings(): Promise<void> {
    const { platform } = await this.host();
    const target =
      platform === 'darwin'
        ? MAC_LOGIN_ITEMS_SETTINGS
        : platform === 'win32'
          ? WINDOWS_STARTUP_APPS_SETTINGS
          : null;
    if (target === null) return;
    try {
      await this.openExternal(target);
    } catch {
      // A deep link the OS refuses to open must not turn a recovery hint
      // into an error.
    }
  }

  private async applyEnabled(
    enabled: boolean,
  ): Promise<LaunchAtLoginSetResult> {
    const host = await this.host();
    const unsupported = unsupportedStatus(host);
    if (unsupported !== null) {
      return { ok: false, reason: 'unsupported', status: unsupported };
    }
    try {
      await this.registrar.setLoginItemSettings(
        host.platform === 'win32'
          ? { openAtLogin: enabled, enabled }
          : { openAtLogin: enabled },
      );
    } catch {
      // The read-back below reports whatever the OS kept.
    }
    const status = await this.readStatus(host);
    this.onStatusChanged?.(status);
    const honored = enabled
      ? status.enabled || status.pendingApproval
      : !status.enabled && !status.pendingApproval;
    return honored
      ? { ok: true, status }
      : { ok: false, reason: 'refused', status };
  }

  private async readStatus(
    host: LaunchAtLoginHost,
  ): Promise<LaunchAtLoginStatus> {
    const unsupported = unsupportedStatus(host);
    if (unsupported !== null) return unsupported;
    return statusFromSnapshot(
      host.platform,
      await this.registrar.getLoginItemSettings(),
    );
  }
}

/**
 * E2E-only substitute for the OS, backed by the JSON file named in
 * `CANOPY_E2E_LAUNCH_AT_LOGIN_STATE`:
 *
 *   { platform, openAtLogin, status?, executableWillLaunchAtLogin?, refuseWrites? }
 *
 * The file survives a relaunch, and a spec rewrites it to simulate a change
 * made in System Settings or Task Manager. While it is in use the build
 * counts as installed and the platform comes from the file, so Windows copy
 * and the Startup apps case run on macOS CI. `refuseWrites` drops every write,
 * which the service's read-back reports as `refused`.
 */
interface E2eLoginItemState {
  platform: LaunchAtLoginPlatform;
  openAtLogin: boolean;
  status?: MacLoginItemStatus;
  executableWillLaunchAtLogin?: boolean;
  refuseWrites?: boolean;
}

export interface E2eLoginItemRegistrar {
  registrar: LoginItemRegistrar;
  resolveHost: () => Promise<LaunchAtLoginHost>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMacStatus(value: unknown): value is MacLoginItemStatus {
  return (
    value === 'not-registered' ||
    value === 'enabled' ||
    value === 'requires-approval' ||
    value === 'not-found'
  );
}

function parseE2eState(
  raw: unknown,
  hostPlatform: LaunchAtLoginPlatform,
): E2eLoginItemState {
  const record = isRecord(raw) ? raw : {};
  const platform =
    typeof record.platform === 'string'
      ? toLaunchAtLoginPlatform(record.platform)
      : hostPlatform;
  const openAtLogin = record.openAtLogin === true;
  return {
    platform,
    openAtLogin,
    ...(isMacStatus(record.status) ? { status: record.status } : {}),
    ...(typeof record.executableWillLaunchAtLogin === 'boolean'
      ? { executableWillLaunchAtLogin: record.executableWillLaunchAtLogin }
      : {}),
    ...(record.refuseWrites === true ? { refuseWrites: true } : {}),
  };
}

function snapshotFromE2eState(state: E2eLoginItemState): LoginItemSnapshot {
  if (state.platform === 'win32') {
    return {
      openAtLogin: state.openAtLogin,
      executableWillLaunchAtLogin:
        state.executableWillLaunchAtLogin ?? state.openAtLogin,
    };
  }
  return {
    openAtLogin: state.openAtLogin,
    status: state.status ?? (state.openAtLogin ? 'enabled' : 'not-registered'),
  };
}

export function createE2eLoginItemRegistrar(
  filePath: string,
  hostPlatform: NodeJS.Platform,
): E2eLoginItemRegistrar {
  const fallbackPlatform = toLaunchAtLoginPlatform(hostPlatform);
  const read = async (): Promise<E2eLoginItemState> => {
    let raw: unknown = null;
    try {
      raw = JSON.parse(await readFile(filePath, 'utf8'));
    } catch {
      // Missing or unreadable: a machine where nothing was ever registered.
    }
    return parseE2eState(raw, fallbackPlatform);
  };
  return {
    resolveHost: async (): Promise<LaunchAtLoginHost> => ({
      platform: (await read()).platform,
      isPackaged: true,
    }),
    registrar: {
      getLoginItemSettings: async (): Promise<LoginItemSnapshot> =>
        snapshotFromE2eState(await read()),
      setLoginItemSettings: async (settings): Promise<void> => {
        const state = await read();
        if (state.refuseWrites === true) return;
        const next: E2eLoginItemState =
          state.platform === 'win32'
            ? {
                ...state,
                openAtLogin: settings.openAtLogin,
                executableWillLaunchAtLogin:
                  settings.openAtLogin && settings.enabled !== false,
              }
            : {
                ...state,
                openAtLogin: settings.openAtLogin,
                status: settings.openAtLogin ? 'enabled' : 'not-registered',
              };
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`);
      },
    },
  };
}

let service: LaunchAtLoginService | null = null;

export type InitializeLaunchAtLoginOptions = Omit<
  LaunchAtLoginServiceOptions,
  'registrar' | 'resolveHost'
> & {
  /** The real OS seam (Electron's `app`); ignored when the E2E fake is on. */
  electronRegistrar: LoginItemRegistrar;
  /** Test seam; production leaves it unset. */
  registrar?: LoginItemRegistrar;
};

/**
 * Create the process-lifetime service. Production wraps Electron's `app`;
 * the E2E build wraps the file-backed fake when
 * `CANOPY_E2E_LAUNCH_AT_LOGIN_STATE` is set, and otherwise keeps the real
 * seam, which its unpackaged build reports as unsupported without touching
 * the OS. Idempotent: a second call returns the live instance.
 */
export function initializeLaunchAtLoginService(
  options: InitializeLaunchAtLoginOptions,
): LaunchAtLoginService {
  if (service !== null) return service;
  let registrar = options.registrar ?? options.electronRegistrar;
  let resolveHost: (() => Promise<LaunchAtLoginHost>) | undefined;
  const e2eStateFile = process.env.CANOPY_E2E_LAUNCH_AT_LOGIN_STATE;
  if (
    options.registrar === undefined &&
    isE2eBuild() &&
    e2eStateFile !== undefined &&
    e2eStateFile !== ''
  ) {
    const fake = createE2eLoginItemRegistrar(e2eStateFile, options.platform);
    registrar = fake.registrar;
    resolveHost = fake.resolveHost;
  }
  service = new LaunchAtLoginService({
    registrar,
    platform: options.platform,
    isPackaged: options.isPackaged,
    ...(resolveHost !== undefined ? { resolveHost } : {}),
    openExternal: options.openExternal,
    onStatusChanged: options.onStatusChanged,
  });
  return service;
}

export function getLaunchAtLoginService(): LaunchAtLoginService {
  if (service === null) {
    throw new Error('Launch at sign-in service is not initialized.');
  }
  return service;
}

export function resetLaunchAtLoginServiceForTests(): void {
  service = null;
}
