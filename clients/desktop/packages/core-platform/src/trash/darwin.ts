import type { PlatformExecutionProcessServices } from '@canopy/core-runtime';
import { runTrashHelper, type TrashHelperLimits } from './helper';
import type { TrashAttempt } from './trash';

// NSFileManager trashItemAtURL, as Electron's shell.trashItem calls it. The
// path arrives URI-encoded through argv, never in the script, so neither
// quoting nor osascript's locale can change it. The URL is built without
// a directory check, so a link to a directory is trashed as the link.
// Out-parameters are `$()`: `Ref()` crashes osascript after the move.
const SCRIPT = String.raw`
ObjC.import('Foundation');
function run(argv) {
  if (argv.length !== 1) return 'usage';
  const url = $.NSURL.fileURLWithPathIsDirectory(decodeURIComponent(argv[0]), false);
  const moved = $(), error = $();
  if ($.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError(url, moved, error)) {
    let location = '';
    try { location = moved.path.js; } catch (e) {}
    return 'moved ' + encodeURIComponent(location);
  }
  return 'refused ' + error.code + ' ' + encodeURIComponent(error.domain.js);
}
`;

const OSASCRIPT = '/usr/bin/osascript';
const ENVIRONMENT: Readonly<Record<string, string>> = { LC_ALL: 'C' };
const COCOA = 'NSCocoaErrorDomain';
/** NSFeatureUnsupportedError: the volume has no trash. */
const FEATURE_UNSUPPORTED = 3328;

const NO_TRASH = 'This volume has no trash.';
const REFUSED = 'macOS refused to move the entry to the trash.';
const UNREPORTED = 'The trash helper ended without a report.';

/** A darwin attempt, with where the entry went when macOS names it. */
export type DarwinTrashAttempt =
  | Exclude<TrashAttempt, { readonly kind: 'moved' }>
  | { readonly kind: 'moved'; readonly location?: string };

/** The osascript argv for one entry; exported for the adapter tests. */
export function darwinTrashCommand(entry: string): readonly string[] {
  return ['-l', 'JavaScript', '-e', SCRIPT, encodeURIComponent(entry)];
}

function decoded(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/** Reads the script's one-line report; anything else is no report. */
export function parseDarwinTrashReport(stdout: string): DarwinTrashAttempt {
  // A move macOS reported counts even when it names no resulting URL.
  const moved = /^moved (\S*)\n?$/.exec(stdout);
  const location = moved?.[1] === undefined ? null : decoded(moved[1]);
  if (location === '') return { kind: 'moved' };
  if (location !== null && location.startsWith('/'))
    return { kind: 'moved', location };
  const refused = /^refused (-?\d+) (\S+)\n?$/.exec(stdout);
  if (refused?.[1] !== undefined && refused[2] !== undefined) {
    const unsupported =
      Number(refused[1]) === FEATURE_UNSUPPORTED &&
      decoded(refused[2]) === COCOA;
    return unsupported
      ? { kind: 'refused', code: 'unavailable', reason: NO_TRASH }
      : { kind: 'refused', code: 'failed', reason: REFUSED };
  }
  return { kind: 'unfinished', reason: UNREPORTED };
}

/** One `trashItemAtURL` through `/usr/bin/osascript`, under process custody. */
export async function darwinTrashAttempt(
  processes: PlatformExecutionProcessServices,
  entry: string,
  limits?: TrashHelperLimits,
): Promise<DarwinTrashAttempt> {
  const report = await runTrashHelper(
    processes,
    {
      executable: OSASCRIPT,
      args: darwinTrashCommand(entry),
      environment: ENVIRONMENT,
    },
    limits,
  );
  if (report.kind !== 'exited' || report.code !== 0)
    return { kind: 'unfinished', reason: UNREPORTED };
  return parseDarwinTrashReport(report.stdout);
}
