import type { PlatformExecutionProcessServices } from '@canopy/core-runtime';
import { runTrashHelper, type TrashHelperLimits } from './helper';
import type { TrashAttempt, TrashAttempter } from './trash';

const GIO = ['/usr/bin/gio', '/bin/gio'];
/** The host variables `gio` reads to find the home trash; nothing else is passed. */
const HOST_VARIABLES = ['HOME', 'XDG_DATA_HOME'] as const;

const MISSING = 'Trash needs gio, which is missing.';
const NO_TRASH = 'This location has no trash.';
const REFUSED = 'gio refused to move the entry to the trash.';
const UNREPORTED = 'The trash helper ended without a report.';

// GLib's messages for a location without a usable trash (no home or
// per-volume trash directory, a system-internal mount, or a cross-device
// home trash), in the C locale the helper runs under.
const NO_TRASH_MESSAGE =
  /trash directory|not supported|across filesystem boundaries/i;

/**
 * `gio trash` with the local VFS only, so no D-Bus or gvfs daemon is
 * involved: GLib moves the entry by rename into the home trash, or into the
 * volume's `.Trash-$UID`, and never copies across devices. The path is
 * absolute, so it cannot be read as an option.
 */
export function linuxTrashCommand(
  executable: string,
  entry: string,
  host: Readonly<Record<string, string | undefined>>,
): {
  readonly executable: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
} {
  const environment: Record<string, string> = {
    PATH: '/usr/bin:/bin',
    LC_ALL: 'C',
    GIO_USE_VFS: 'local',
  };
  for (const name of HOST_VARIABLES) {
    const value = host[name];
    if (value !== undefined && value !== '' && !value.includes('\0'))
      environment[name] = value;
  }
  return { executable, args: ['trash', entry], environment };
}

export function parseLinuxTrashReport(
  code: number | null,
  stderr: string,
  entry: string,
): TrashAttempt {
  if (code === 0) return { kind: 'moved' };
  if (code === null) return { kind: 'unfinished', reason: UNREPORTED };
  // gio prints the path itself, which may contain the message text; its
  // file:// URI is percent-encoded, so the words cannot match there.
  return NO_TRASH_MESSAGE.test(stderr.split(entry).join(''))
    ? { kind: 'refused', code: 'unavailable', reason: NO_TRASH }
    : { kind: 'refused', code: 'failed', reason: REFUSED };
}

/**
 * The first of `/usr/bin/gio` and `/bin/gio`, under process custody. A host
 * without either has no trash; the lookup repeats until one is found.
 */
export function linuxTrashBackend(options: {
  readonly exists: (path: string) => boolean;
  readonly processes: () => PlatformExecutionProcessServices;
  readonly environment: () => Readonly<Record<string, string | undefined>>;
  readonly limits?: TrashHelperLimits;
}): () => TrashAttempter | string {
  let executable: string | undefined;
  return () => {
    executable ??= GIO.find(options.exists);
    const gio = executable;
    if (gio === undefined) return MISSING;
    return async (entry) => {
      const report = await runTrashHelper(
        options.processes(),
        linuxTrashCommand(gio, entry, options.environment()),
        options.limits,
      );
      if (report.kind !== 'exited')
        return { kind: 'unfinished', reason: UNREPORTED };
      return parseLinuxTrashReport(report.code, report.stderr, entry);
    };
  };
}
