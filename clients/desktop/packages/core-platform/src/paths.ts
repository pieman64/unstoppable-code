import path from 'node:path';
import type {
  PlatformAppDirectories,
  PlatformAppDirectoryRequest,
  PlatformOperatingSystem,
  PlatformPathServices,
} from '@canopy/core-runtime';

export class PlatformPathError extends Error {
  override readonly name = 'PlatformPathError';
  readonly code: 'invalid_app_name' | 'invalid_path';

  constructor(code: PlatformPathError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

// Drive or UNC only: rejects drive-relative (`C:x`), rooted-only (`\x`), and
// `\\?\` / `\\.\` device namespaces (including `\\.\pipe\`).
const WIN32_FULLY_QUALIFIED =
  /^(?:[A-Za-z]:[\\/]|[\\/]{2}(?![?.][\\/])[^\\/]+[\\/]+[^\\/])/;
// Win32 leaf rules: reserved characters, trailing dot/space, device basenames.
const WIN32_INVALID_LEAF =
  /[<>"|?*]|[. ]$|^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i;

function isFullyQualified(os: PlatformOperatingSystem, value: string): boolean {
  if (value.includes('\0')) return false;
  return os === 'win32'
    ? WIN32_FULLY_QUALIFIED.test(value)
    : path.posix.isAbsolute(value);
}

function qualified(
  os: PlatformOperatingSystem,
  value: string | undefined,
  label: string,
): string {
  if (value === undefined || !isFullyQualified(os, value)) {
    throw new PlatformPathError('invalid_path', `Invalid ${os} ${label}.`);
  }
  return value;
}

/** XDG base directory spec: unset, empty, or relative values are ignored. */
function xdg(value: string | undefined): string | null {
  return value !== undefined && isFullyQualified('linux', value) ? value : null;
}

/**
 * Pure path policy over injected inputs; never reads process state. These
 * defaults do not select or migrate an existing branded data root. `runtime`
 * is only a candidate: permissions unverified, and not an endpoint address.
 */
export function createPlatformPathServices(
  os: PlatformOperatingSystem,
): PlatformPathServices {
  const host = os === 'win32' ? path.win32 : path.posix;
  const join = (...parts: string[]): string => host.join(...parts);

  function appDataDir({
    appName: app,
    homeDir,
    env,
  }: PlatformAppDirectoryRequest): PlatformAppDirectories {
    const winLeaf =
      os === 'win32' &&
      (WIN32_INVALID_LEAF.test(app) ||
        Array.from(app).some((c) => c.charCodeAt(0) < 32));
    if (app === '' || /^\.\.?$|[/\\:\0]/.test(app) || winLeaf) {
      throw new PlatformPathError('invalid_app_name', 'Invalid app name.');
    }
    const home = qualified(os, homeDir, 'home directory');
    if (os === 'darwin') {
      const data = join(home, 'Library', 'Application Support', app);
      const logs = join(home, 'Library', 'Logs', app);
      return { data, config: data, logs, runtime: null };
    }
    if (os === 'win32') {
      const data = join(qualified(os, env.APPDATA, 'APPDATA'), app);
      return { data, config: data, logs: join(data, 'logs'), runtime: null };
    }
    const dataHome = xdg(env.XDG_DATA_HOME) ?? join(home, '.local', 'share');
    const config = join(xdg(env.XDG_CONFIG_HOME) ?? join(home, '.config'), app);
    const runtime = xdg(env.XDG_RUNTIME_DIR);
    return {
      data: join(dataHome, app),
      config,
      // Electron's Linux `logs` path sits under userData (config).
      logs: join(config, 'logs'),
      runtime: runtime === null ? null : join(runtime, app),
    };
  }

  return Object.freeze({
    appDataDir,
    runtimeDirectory: ({ dataRoot }: { readonly dataRoot: string }): string =>
      join(qualified(os, dataRoot, 'data root'), 'runtime'),
  });
}
