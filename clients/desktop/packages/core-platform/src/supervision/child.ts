import path from 'node:path';
import type {
  PlatformChildEnvironmentRequest,
  PlatformChildProcessOptions,
  PlatformChildProcessRequest,
  PlatformOperatingSystem,
  PlatformSupervisionServices,
} from '@canopy/core-runtime';

type Source = PlatformChildEnvironmentRequest['source'];
type Check = (value: string) => boolean;

const WIN32_DRIVE = /^[A-Za-z]:\\/;
// Drive or UNC; rejects drive-relative, rooted-only, and `\\?\` / `\\.\` (as paths.ts).
const WIN32_QUALIFIED =
  /^(?:[A-Za-z]:[\\/]|[\\/]{2}(?![?.][\\/])[^\\/]+[\\/]+[^\\/])/;
const POSIX_SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

function invalid(key: string): Error {
  return new Error(`Invalid child environment ${key}`);
}

/** Windows names are case-insensitive; never choose between conflicting values. */
function selector(
  os: PlatformOperatingSystem,
  source: Source,
  conflict: 'reject' | 'omit' = 'reject',
): (key: string) => string | undefined {
  const name = (key: string): string =>
    os === 'win32' ? key.toUpperCase() : key;
  return (key) => {
    const found = Object.entries(source)
      .filter(
        ([candidate, value]) =>
          value !== undefined && name(candidate) === name(key),
      )
      .map(([, value]) => value);
    if (new Set(found).size > 1) {
      if (conflict === 'omit') return undefined;
      throw invalid(key);
    }
    return found[0];
  };
}

export function createChildServices(
  os: PlatformOperatingSystem,
): Pick<
  PlatformSupervisionServices,
  'childProcessOptions' | 'childEnvironment'
> {
  const win32 = os === 'win32';
  const delimiter = win32 ? ';' : ':';
  const absolute: Check = win32
    ? (value): boolean => WIN32_QUALIFIED.test(value)
    : (value): boolean => path.posix.isAbsolute(value);
  const safe = (value: string, check: Check): boolean =>
    check(value) && Array.from(value).every((c) => c >= ' ' && c !== '\x7f');
  // Values that land in PATH must not smuggle extra list entries.
  const listable = (value: string, check: Check = absolute): boolean =>
    safe(value, check) && !value.includes(delimiter);

  function childProcessOptions({
    lifetime,
  }: PlatformChildProcessRequest): PlatformChildProcessOptions {
    if (lifetime !== 'owned' && lifetime !== 'independent')
      throw new Error('Invalid child process lifetime');
    // POSIX children lead their group; Windows independent children escape libuv's parent-exit job.
    return Object.freeze({
      detached: !win32 || lifetime === 'independent',
      windowsHide: win32,
    });
  }

  function childEnvironment({
    source,
    pathEntries = [],
  }: PlatformChildEnvironmentRequest): Readonly<Record<string, string>> {
    const read = selector(os, source);
    const env: Record<string, string> = {};
    const take = (key: string, check = absolute): string | undefined => {
      const value = read(key);
      if (value === undefined || value === '') return undefined;
      if (!safe(value, check)) throw invalid(key);
      return (env[key] = value);
    };
    const required = (key: string, check = absolute): string => {
      const value = take(key, check);
      if (value === undefined) throw invalid(key);
      return value;
    };
    if (pathEntries.some((entry) => !listable(entry)))
      throw new Error('Invalid child PATH entry');
    let system = POSIX_SYSTEM_PATH;
    if (win32) {
      const root = required('SystemRoot', (value) =>
        listable(value, (root): boolean => WIN32_DRIVE.test(root)),
      );
      const system32 = path.win32.join(root, 'System32');
      system = [
        system32,
        root,
        path.win32.join(system32, 'WindowsPowerShell', 'v1.0'),
      ];
      env.WINDIR = root;
      env.ComSpec = path.win32.join(system32, 'cmd.exe');
      env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
      required('USERPROFILE');
      required('APPDATA');
      for (const key of ['LOCALAPPDATA', 'TEMP', 'TMP']) take(key);
      // Bad optional discovery hints must not prevent daemon startup.
      const readGitInput = selector(os, source, 'omit');
      for (const key of [
        'ProgramFiles',
        'ProgramFiles(x86)',
        'CANOPY_GIT_EXECUTABLE',
      ]) {
        const value = readGitInput(key);
        // Preserve rejected overrides for facts; execution validation stays with Git selection.
        const check = (candidate: string): boolean =>
          key === 'CANOPY_GIT_EXECUTABLE' || absolute(candidate);
        if (value && safe(value, check)) env[key] = value;
      }
    } else {
      required('HOME');
      take('TMPDIR');
      // XDG spec: unset, empty, or relative values are ignored, as in paths.ts.
      if (os === 'linux')
        for (const key of [
          'XDG_DATA_HOME',
          'XDG_CONFIG_HOME',
          'XDG_RUNTIME_DIR',
        ])
          if (path.posix.isAbsolute(read(key) ?? '')) take(key);
    }
    env.PATH = [...pathEntries, ...system].join(delimiter);
    return Object.freeze(env);
  }

  return { childProcessOptions, childEnvironment };
}
