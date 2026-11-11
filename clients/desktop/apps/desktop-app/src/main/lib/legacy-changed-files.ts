// The `activity:changed-files` compatibility projection (CAN-4103). The
// canonical engine reads `-z` output once; these rebuild, from the same
// records, the text the legacy commands printed (`core.quotePath=false`,
// newline-separated, trimmed by runGit, empty on failure or past its 8 MiB
// limit). CAN-3224 intentionally supersedes CAN-4103's C-quoted filename
// parity: the builders now decode those fields to real filename identity,
// including before untracked estimation. Edge trimming, dropped rename/copy
// counts, the silent 200-file untracked cut and desktop status names remain.
import type { ChangedFileInfo } from '@canopy/desktop-shared/types';
import {
  parseGitNameStatusZ,
  parseGitNumstatZ,
  parseGitPathListZ,
  parseGitUnmergedZ,
  type GitChangeSetSample,
  type GitReadOutcome,
} from '@canopy/core-runtime/node/git';
import { buildChangedFilesList, buildCommittedFilesList } from './git';
import {
  estimateUntrackedChanges,
  type UntrackedChange,
} from './untracked-line-estimate';

/** runGit's default `maxBuffer`: a longer legacy output failed as empty. */
const LEGACY_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

const C_ESCAPES: Readonly<Record<number, string>> = {
  0x07: '\\a',
  0x08: '\\b',
  0x09: '\\t',
  0x0a: '\\n',
  0x0b: '\\v',
  0x0c: '\\f',
  0x0d: '\\r',
  0x22: '\\"',
  0x5c: '\\\\',
};

const octal = (byte: number): string =>
  `\\${byte.toString(8).padStart(3, '0')}`;

/**
 * Git's `quote_c_style`: control characters, DEL, `"` and `\` are escaped and
 * the name quoted. With `core.quotePath=true`, Git's default, each UTF-8 byte
 * of other non-ASCII text is octal-escaped too; with `false` it is kept.
 */
export function quoteGitPath(path: string, quotePath = false): string {
  let quoted = '';
  let needsQuotes = false;
  for (const character of path) {
    const unit = character.charCodeAt(0);
    const escape = C_ESCAPES[unit];
    if (escape !== undefined) {
      quoted += escape;
      needsQuotes = true;
    } else if (unit < 0x20 || unit === 0x7f) {
      quoted += octal(unit);
      needsQuotes = true;
    } else if (quotePath && unit >= 0x80) {
      for (const byte of Buffer.from(character, 'utf8')) quoted += octal(byte);
      needsQuotes = true;
    } else quoted += character;
  }
  return needsQuotes ? `"${quoted}"` : path;
}

/** Git's `pprint_rename`: the name a non-`-z` numstat prints for a pair. */
export function gitRenameDisplayName(from: string, to: string): string {
  const quotedFrom = quoteGitPath(from);
  const quotedTo = quoteGitPath(to);
  if (quotedFrom !== from || quotedTo !== to)
    return `${quotedFrom} => ${quotedTo}`;
  let prefix = 0;
  for (
    let index = 0;
    index < from.length && index < to.length && from[index] === to[index];
    index += 1
  )
    if (from[index] === '/') prefix = index + 1;
  // Both scans start at the strings' ends, as Git's start at the terminator.
  let suffix = 0;
  const floor = prefix - (prefix > 0 ? 1 : 0);
  for (
    let fromIndex = from.length, toIndex = to.length;
    floor <= fromIndex &&
    floor <= toIndex &&
    from.charAt(fromIndex) === to.charAt(toIndex);
    fromIndex -= 1, toIndex -= 1
  )
    if (from[fromIndex] === '/') suffix = from.length - fromIndex;
  const fromMiddle = Math.max(from.length - prefix - suffix, 0);
  const toMiddle = Math.max(to.length - prefix - suffix, 0);
  const middle = `${from.slice(prefix, prefix + fromMiddle)} => ${to.slice(prefix, prefix + toMiddle)}`;
  return prefix + suffix === 0
    ? middle
    : `${from.slice(0, prefix)}{${middle}}${from.slice(from.length - suffix)}`;
}

/** What runGit returned for one legacy command with these records. */
export function legacyOutput(
  outcome: GitReadOutcome | null,
  lines: (stdout: string) => string[],
): string {
  if (!outcome?.ok) return '';
  const rows = lines(outcome.stdout);
  const text = rows.length === 0 ? '' : `${rows.join('\n')}\n`;
  if (Buffer.byteLength(text) > LEGACY_MAX_OUTPUT_BYTES) return '';
  return text.trim();
}

function nameStatusLines(stdout: string): string[] {
  return parseGitNameStatusZ(stdout).map((record) =>
    record.previousPath === undefined
      ? `${record.code}\t${quoteGitPath(record.path)}`
      : `${record.code}\t${quoteGitPath(record.previousPath)}\t${quoteGitPath(record.path)}`,
  );
}

function numstatLines(stdout: string): string[] {
  return parseGitNumstatZ(stdout).map(
    (record) =>
      `${record.added}\t${record.deleted}\t${
        record.previousPath === undefined
          ? quoteGitPath(record.path)
          : gitRenameDisplayName(record.previousPath, record.path)
      }`,
  );
}

/**
 * Estimates for the legacy untracked list: the engine's when the list is the
 * one it estimated, else the legacy estimate of the legacy names.
 */
export function legacyEstimate(
  sample: GitChangeSetSample,
): typeof estimateUntrackedChanges {
  const estimated =
    sample.untracked?.ok === true
      ? parseGitPathListZ(sample.untracked.stdout).slice(
          0,
          sample.untrackedEstimates.length,
        )
      : [];
  return (root, files): Promise<UntrackedChange[]> =>
    files.length === estimated.length &&
    files.every((file, index) => file === estimated[index])
      ? Promise.resolve(
          sample.untrackedEstimates.map((estimate) => ({ ...estimate })),
        )
      : estimateUntrackedChanges(root, files);
}

/** `getChangedFilesList(repoPath)` from a `HEAD..WORKTREE` sample. */
export function legacyUncommittedFiles(
  repoPath: string,
  sample: GitChangeSetSample,
): Promise<ChangedFileInfo[]> {
  return buildChangedFilesList(
    repoPath,
    {
      statusOutput: legacyOutput(sample.nameStatus, nameStatusLines),
      numstatOutput: legacyOutput(sample.numstat, numstatLines),
      untrackedOutput: legacyOutput(sample.untracked, (stdout) =>
        parseGitPathListZ(stdout).map((path) => quoteGitPath(path)),
      ),
      unmergedOutput: legacyOutput(sample.unmerged, (stdout) =>
        parseGitUnmergedZ(stdout).map(
          (record) => `${record.entry}\t${quoteGitPath(record.path)}`,
        ),
      ),
    },
    legacyEstimate(sample),
  );
}

/** `getCommittedFilesBetween(…, mergeBase, 'HEAD')` from that sample. */
export function legacyCommittedFiles(
  sample: GitChangeSetSample,
): ChangedFileInfo[] {
  return buildCommittedFilesList(
    legacyOutput(sample.nameStatus, nameStatusLines),
    legacyOutput(sample.numstat, numstatLines),
  );
}
