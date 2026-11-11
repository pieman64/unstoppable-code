import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

import { getEnhancedEnv } from '@canopy/execution-engine/pipelines/config-paths';
import type {
  DiffFileEntry,
  DiffHunk,
  FileChangeKind,
  PrDiffSnapshot,
  SplitPlanChild,
} from '../../types/github';
import { getGitExecutableCommand } from '../../lib/git-executable';

// ---------------------------------------------------------------------------
// Internal line model
// ---------------------------------------------------------------------------

const PREVIEW_MAX_CHARS = 400;
const GIT_MAX_BUFFER_BYTES = 1024 * 1024 * 64;

/**
 * Injectable git runner so the git-executing functions can be composed and
 * unit-tested with a mock. The default runner shells out via `execFile` with
 * the enhanced environment, matching the conventions in `./git.ts`. This module
 * must stay Electron-free.
 */
export interface GitRunner {
  run(args: string[], cwd: string): Promise<string>;
}

const execFileAsync = promisify(execFile);

const defaultGitRunner: GitRunner = {
  async run(args: string[], cwd: string): Promise<string> {
    const { stdout } = await execFileAsync(
      getGitExecutableCommand(process.env),
      args,
      {
        cwd,
        env: getEnhancedEnv({ environment: { runtime: 'canopy' } }),
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        windowsHide: process.platform === 'win32',
      },
    );
    return stdout;
  },
};

// ---------------------------------------------------------------------------
// @@ header parsing
// ---------------------------------------------------------------------------

interface HunkHeaderRange {
  oldStart: number;
  oldCount: number;
  oldCountExplicit: boolean;
  newStart: number;
  newCount: number;
  newCountExplicit: boolean;
  context: string;
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function parseHunkHeader(header: string): HunkHeaderRange | null {
  const match = HUNK_HEADER_RE.exec(header);
  if (!match) {
    return null;
  }
  const [, oldStartStr, oldCountStr, newStartStr, newCountStr, context] = match;
  return {
    oldStart: Number.parseInt(oldStartStr, 10),
    oldCount: oldCountStr === undefined ? 1 : Number.parseInt(oldCountStr, 10),
    oldCountExplicit: oldCountStr !== undefined,
    newStart: Number.parseInt(newStartStr, 10),
    newCount: newCountStr === undefined ? 1 : Number.parseInt(newCountStr, 10),
    newCountExplicit: newCountStr !== undefined,
    context: context ?? '',
  };
}

// ---------------------------------------------------------------------------
// contentHash / hunk identity
// ---------------------------------------------------------------------------

/** True for a body line that is a `+`/`-` core change line (not a "\ No newline" marker). */
function isCoreChangeLine(line: string): boolean {
  if (line.startsWith('\\')) {
    return false;
  }
  return line.startsWith('+') || line.startsWith('-');
}

/**
 * sha256 over the ordered `+`/`-` core lines only. Prefix characters are kept;
 * context lines, `@@` headers, and `\ No newline at end of file` markers are
 * excluded. This makes identity invariant under line-number drift.
 */
export function computeHunkIdentity(bodyLines: string[]): string {
  const coreLines = bodyLines.filter(isCoreChangeLine);
  return createHash('sha256').update(coreLines.join('\n')).digest('hex');
}

/**
 * Extract the serialized `DiffHunk.coreLines` from a hunk body: the ordered
 * `+`/`-` core lines with prefixes, plus any `\ No newline at end of file`
 * marker that annotates a core line (a marker following a context line is
 * dropped along with the context). Because `computeHunkIdentity` ignores
 * markers, `computeHunkIdentity(coreLines) === contentHash` always holds.
 */
function extractCoreLines(bodyLines: string[]): string[] {
  const core: string[] = [];
  let lastWasCore = false;
  for (const line of bodyLines) {
    if (isCoreChangeLine(line)) {
      core.push(line);
      lastWasCore = true;
    } else if (line.startsWith('\\') && lastWasCore) {
      core.push(line);
      lastWasCore = false;
    } else {
      lastWasCore = false;
    }
  }
  return core;
}

function buildPreview(header: string, bodyLines: string[]): string {
  const text = [header, ...bodyLines].join('\n');
  return text.length > PREVIEW_MAX_CHARS
    ? text.slice(0, PREVIEW_MAX_CHARS)
    : text;
}

// ---------------------------------------------------------------------------
// Raw hunk accumulation while parsing a file section
// ---------------------------------------------------------------------------

interface RawHunk {
  header: string;
  bodyLines: string[];
}

function additionsAndDeletions(bodyLines: string[]): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const line of bodyLines) {
    if (line.startsWith('\\')) {
      continue;
    }
    if (line.startsWith('+')) {
      additions += 1;
    } else if (line.startsWith('-')) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

function finalizeHunks(rawHunks: RawHunk[], file: string): DiffHunk[] {
  const occurrenceCounts = new Map<string, number>();
  return rawHunks.map((raw, hunkIndex) => {
    const contentHash = computeHunkIdentity(raw.bodyLines);
    const occurrenceIndex = occurrenceCounts.get(contentHash) ?? 0;
    occurrenceCounts.set(contentHash, occurrenceIndex + 1);
    const { additions, deletions } = additionsAndDeletions(raw.bodyLines);
    const hunk: DiffHunk = {
      file,
      hunkIndex,
      header: raw.header,
      contentHash,
      coreLines: extractCoreLines(raw.bodyLines),
      occurrenceIndex,
      additions,
      deletions,
      preview: buildPreview(raw.header, raw.bodyLines),
    };
    return hunk;
  });
}

// ---------------------------------------------------------------------------
// parseUnifiedDiff
// ---------------------------------------------------------------------------

interface FileSection {
  headerLine: string;
  lines: string[];
}

function splitIntoFileSections(diffText: string): FileSection[] {
  const lines = diffText.split('\n');
  const sections: FileSection[] = [];
  let current: FileSection | null = null;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (current) {
        sections.push(current);
      }
      current = { headerLine: line, lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) {
    sections.push(current);
  }
  return sections;
}

const DIFF_GIT_RE = /^diff --git a\/(.+) b\/(.+)$/;

function pathsFromDiffGit(headerLine: string): {
  aPath: string;
  bPath: string;
} {
  const match = DIFF_GIT_RE.exec(headerLine);
  if (match) {
    return { aPath: match[1], bPath: match[2] };
  }
  return { aPath: '', bPath: '' };
}

function parseFileSection(section: FileSection): DiffFileEntry {
  const { aPath, bPath } = pathsFromDiffGit(section.headerLine);

  let kind: FileChangeKind = 'modified';
  let isBinary = false;
  let renameFrom: string | undefined;
  let renameTo: string | undefined;
  let path = bPath;
  let oldPath: string | undefined;

  const rawHunks: RawHunk[] = [];
  let currentHunk: RawHunk | null = null;

  for (const line of section.lines) {
    if (line.startsWith('@@')) {
      // A hunk header. Only treat lines that actually parse as a hunk header;
      // otherwise it is body content (a context line can begin with @@ only if
      // prefixed by a space, so this is safe against false positives).
      const parsed = parseHunkHeader(line);
      if (parsed) {
        if (currentHunk) {
          rawHunks.push(currentHunk);
        }
        currentHunk = { header: line, bodyLines: [] };
        continue;
      }
    }

    if (currentHunk) {
      // Inside a hunk body: content lines start with ' ', '+', '-', or '\'.
      if (
        line.startsWith(' ') ||
        line.startsWith('+') ||
        line.startsWith('-') ||
        line.startsWith('\\')
      ) {
        currentHunk.bodyLines.push(line);
        continue;
      }
      // Any other line ends the current hunk (should not normally happen inside
      // a single file section).
      rawHunks.push(currentHunk);
      currentHunk = null;
    }

    if (line.startsWith('new file mode ')) {
      kind = 'added';
    } else if (line.startsWith('deleted file mode ')) {
      kind = 'deleted';
    } else if (line.startsWith('rename from ')) {
      kind = 'renamed';
      renameFrom = line.slice('rename from '.length);
    } else if (line.startsWith('rename to ')) {
      kind = 'renamed';
      renameTo = line.slice('rename to '.length);
    } else if (line.startsWith('copy from ')) {
      renameFrom = line.slice('copy from '.length);
    } else if (line.startsWith('copy to ')) {
      renameTo = line.slice('copy to '.length);
    } else if (
      line.startsWith('Binary files ') ||
      line === 'GIT binary patch'
    ) {
      isBinary = true;
    } else if (line.startsWith('--- ')) {
      const value = line.slice('--- '.length);
      if (value !== '/dev/null' && value.startsWith('a/')) {
        oldPath = value.slice('a/'.length);
      }
    } else if (line.startsWith('+++ ')) {
      const value = line.slice('+++ '.length);
      if (value !== '/dev/null' && value.startsWith('b/')) {
        path = value.slice('b/'.length);
      }
    }
  }

  if (currentHunk) {
    rawHunks.push(currentHunk);
  }

  if (kind === 'renamed') {
    // Prefer explicit rename headers; fall back to the diff --git a/ token when
    // a binary or mode-shaped rename omits `--- ` / `rename from` lines.
    oldPath = renameFrom ?? oldPath ?? (aPath || undefined);
    if (renameTo) {
      path = renameTo;
    }
  } else if (oldPath === path) {
    // A modified file's --- header path equals the +++ path; don't surface it
    // as a rename oldPath.
    oldPath = undefined;
  }

  if (isBinary) {
    return {
      path,
      oldPath: kind === 'renamed' ? oldPath : undefined,
      kind,
      isBinary: true,
      additions: 0,
      deletions: 0,
      hunks: [],
    };
  }

  const hunks = finalizeHunks(rawHunks, path);
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    additions += hunk.additions;
    deletions += hunk.deletions;
  }

  return {
    path,
    oldPath: kind === 'renamed' ? oldPath : undefined,
    kind,
    isBinary: false,
    additions,
    deletions,
    hunks,
  };
}

export function parseUnifiedDiff(diffText: string): DiffFileEntry[] {
  if (!diffText.trim()) {
    return [];
  }
  return splitIntoFileSections(diffText).map(parseFileSection);
}

// ---------------------------------------------------------------------------
// Run matching
// ---------------------------------------------------------------------------

export interface HunkRun {
  header: string;
  bodyLines: string[];
  ownerHunkIndex: number;
}

export type RunMatchResult =
  | { ok: true; runs: HunkRun[] }
  | {
      ok: false;
      reason: 'unmatched-run' | 'ambiguous-run';
      detail: string;
      file: string;
      runHeader: string;
    };

/** The ordered core (`+`/`-`) line sequence of a hunk body. */
function coreSequence(bodyLines: string[]): string[] {
  return bodyLines.filter(isCoreChangeLine);
}

/**
 * Return the offset within `haystack` at which `needle` appears as a contiguous
 * subsequence starting at or after `fromOffset`, or -1 if not present.
 */
function findContiguous(
  haystack: string[],
  needle: string[],
  fromOffset: number,
): number {
  if (needle.length === 0) {
    return fromOffset <= haystack.length ? fromOffset : -1;
  }
  const lastStart = haystack.length - needle.length;
  for (let start = fromOffset; start <= lastStart; start += 1) {
    let matched = true;
    for (let i = 0; i < needle.length; i += 1) {
      if (haystack[start + i] !== needle[i]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return start;
    }
  }
  return -1;
}

/**
 * Match each recomputed U0 run to exactly one original U3 hunk. Original hunks
 * are walked greedily in file order with a cursor: once a run matches inside
 * original hunk `k` at core-line offset `o`, the next run's search starts from
 * that position, deterministically disambiguating identical content.
 *
 * A run whose core lines match no original hunk fails with `unmatched-run`. A
 * run whose core-line sequence would have to span two original hunks fails with
 * `ambiguous-run` (one U0 run must be owned by exactly one U3 hunk). One U3
 * hunk decomposing into several U0 runs is normal and not an error.
 */
export function matchRunsToOriginalHunks(
  recomputedFileDiffU0: DiffFileEntry,
  originalFile: DiffFileEntry,
): RunMatchResult {
  const file = originalFile.path;
  // `DiffHunk.coreLines` is the serialized matching source of truth and
  // survives IPC/JSON round-trips (the snapshot goes renderer-side and back
  // before carve time). Markers are stripped for sequence comparison.
  const originalCoreSequences = originalFile.hunks.map((h) =>
    coreSequence(h.coreLines),
  );

  // Cursor state: which original hunk we are currently inside, and the offset
  // within that hunk's core sequence to resume searching from.
  let cursorHunk = 0;
  let cursorOffset = 0;

  const runs: HunkRun[] = [];

  for (const runHunk of recomputedFileDiffU0.hunks) {
    // A U0 hunk body has no context lines, so coreLines (which keeps attached
    // `\ No newline` markers) IS the full run body for patch assembly.
    const runBody = runHunk.coreLines;
    const runCore = coreSequence(runBody);

    let matched = false;
    for (
      let hunkIdx = cursorHunk;
      hunkIdx < originalCoreSequences.length;
      hunkIdx += 1
    ) {
      const startOffset = hunkIdx === cursorHunk ? cursorOffset : 0;
      const original = originalCoreSequences[hunkIdx];
      const at = findContiguous(original, runCore, startOffset);
      if (at !== -1) {
        runs.push({
          header: runHunk.header,
          bodyLines: runBody,
          ownerHunkIndex: hunkIdx,
        });
        cursorHunk = hunkIdx;
        cursorOffset = at + runCore.length;
        matched = true;
        break;
      }
    }

    if (!matched) {
      // Determine whether the failure is a genuine no-match or a run that spans
      // two original hunks. If the run's core lines can be found as a
      // concatenation across consecutive original hunks (a prefix in one hunk
      // and the remainder at the start of the next), it is ambiguous.
      if (spansTwoOriginalHunks(originalCoreSequences, runCore, cursorHunk)) {
        return {
          ok: false,
          reason: 'ambiguous-run',
          detail: `Recomputed run ${runHunk.header} spans two original hunks in ${file}`,
          file,
          runHeader: runHunk.header,
        };
      }
      return {
        ok: false,
        reason: 'unmatched-run',
        detail: `Recomputed run ${runHunk.header} matched no original hunk in ${file}`,
        file,
        runHeader: runHunk.header,
      };
    }
  }

  return { ok: true, runs };
}

/**
 * Detect the ambiguous case: the run's core lines are not contained in a single
 * original hunk, but they split cleanly across the boundary of two consecutive
 * original hunks (some suffix of one hunk's cores followed by some prefix of the
 * next). That means the recomputed run corresponds to two distinct original
 * edit regions and cannot be owned by a single hunk.
 */
function spansTwoOriginalHunks(
  originalCoreSequences: string[][],
  runCore: string[],
  fromHunk: number,
): boolean {
  if (runCore.length < 2) {
    return false;
  }
  for (
    let hunkIdx = fromHunk;
    hunkIdx < originalCoreSequences.length - 1;
    hunkIdx += 1
  ) {
    const first = originalCoreSequences[hunkIdx];
    const second = originalCoreSequences[hunkIdx + 1];
    // Try every split point of runCore into (prefix, suffix).
    for (let split = 1; split < runCore.length; split += 1) {
      const prefix = runCore.slice(0, split);
      const suffix = runCore.slice(split);
      // prefix must be a suffix of `first`, suffix must be a prefix of `second`.
      if (
        endsWithSequence(first, prefix) &&
        startsWithSequence(second, suffix)
      ) {
        return true;
      }
    }
  }
  return false;
}

function endsWithSequence(haystack: string[], suffix: string[]): boolean {
  if (suffix.length > haystack.length) {
    return false;
  }
  const offset = haystack.length - suffix.length;
  for (let i = 0; i < suffix.length; i += 1) {
    if (haystack[offset + i] !== suffix[i]) {
      return false;
    }
  }
  return true;
}

function startsWithSequence(haystack: string[], prefix: string[]): boolean {
  if (prefix.length > haystack.length) {
    return false;
  }
  for (let i = 0; i < prefix.length; i += 1) {
    if (haystack[i] !== prefix[i]) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// buildPatchFromRuns
// ---------------------------------------------------------------------------

/**
 * Assemble an applyable `--unified=0` patch containing only the selected runs.
 * The old-side numbers are already correct against the child base (the U0 diff
 * was recomputed against it). New-side start lines are re-offset by the
 * cumulative (additions - deletions) delta of PREVIOUSLY SELECTED runs only, so
 * skipped runs do not contribute their delta.
 */
export function buildPatchFromRuns(
  path: string,
  oldPath: string | undefined,
  selected: HunkRun[],
): string {
  const lines: string[] = [];
  lines.push(`--- a/${oldPath ?? path}`);
  lines.push(`+++ b/${path}`);

  let cumulativeDelta = 0;
  for (const run of selected) {
    const parsed = parseHunkHeader(run.header);
    if (!parsed) {
      // Should not happen — runs originate from parsed U0 diffs. Emit as-is to
      // avoid silently dropping content.
      lines.push(run.header);
      for (const body of run.bodyLines) {
        lines.push(body);
      }
      continue;
    }

    const { additions, deletions } = additionsAndDeletions(run.bodyLines);

    let newStart: number;
    if (parsed.newCount === 0) {
      // Pure deletion: new-side anchors after (oldStart + delta - 1).
      newStart = parsed.oldStart + cumulativeDelta - 1;
    } else if (parsed.oldCount === 0) {
      // Pure insertion: new-side anchors after old line oldStart.
      newStart = parsed.oldStart + cumulativeDelta + 1;
    } else {
      // Modification: new-side aligns with old-side plus prior delta.
      newStart = parsed.oldStart + cumulativeDelta;
    }

    const oldRange = formatRange(
      parsed.oldStart,
      parsed.oldCount,
      parsed.oldCountExplicit,
    );
    const newRange = formatRange(
      newStart,
      parsed.newCount,
      parsed.newCountExplicit,
    );
    const context = parsed.context;
    lines.push(`@@ -${oldRange} +${newRange} @@${context}`);
    for (const body of run.bodyLines) {
      lines.push(body);
    }

    cumulativeDelta += additions - deletions;
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Format a hunk range. The `,count` suffix is preserved when it was explicit in
 * the source header (so a re-offset patch is byte-faithful to the recomputed U0
 * diff git produced), and always emitted for zero-length ranges since `-N,0` /
 * `+N,0` cannot be expressed without the explicit count.
 */
function formatRange(start: number, count: number, explicit: boolean): string {
  if (count === 1 && !explicit) {
    return `${start}`;
  }
  return `${start},${count}`;
}

// ---------------------------------------------------------------------------
// planChildCarve
// ---------------------------------------------------------------------------

export interface CarveFilePlan {
  wholeFiles: { path: string; kind: FileChangeKind; oldPath?: string }[];
  hunkFiles: { path: string; ownedHunkIndices: number[] }[];
}

/**
 * Split a child's `changes` into whole files (`hunks: 'all'`) versus hunk-split
 * files, carrying `kind`/`oldPath` from the snapshot. Binary files are always
 * whole-owned regardless of what the plan requested.
 */
export function planChildCarve(
  child: SplitPlanChild,
  snapshot: PrDiffSnapshot,
): CarveFilePlan {
  const byPath = new Map<string, DiffFileEntry>();
  for (const file of snapshot.files) {
    byPath.set(file.path, file);
  }

  const wholeFiles: CarveFilePlan['wholeFiles'] = [];
  const hunkFiles: CarveFilePlan['hunkFiles'] = [];

  for (const change of child.changes) {
    const entry = byPath.get(change.file);
    const kind: FileChangeKind = entry?.kind ?? 'modified';
    const oldPath = entry?.oldPath;
    const isBinary = entry?.isBinary ?? false;

    if (change.hunks === 'all' || isBinary || kind !== 'modified') {
      wholeFiles.push({ path: change.file, kind, oldPath });
      continue;
    }

    hunkFiles.push({
      path: change.file,
      ownedHunkIndices: [...change.hunks],
    });
  }

  return { wholeFiles, hunkFiles };
}

// ---------------------------------------------------------------------------
// Git-running gatherers
// ---------------------------------------------------------------------------

interface GitRunnerOption {
  run: (args: string[], cwd?: string) => Promise<string>;
}

function resolveRunner(options?: {
  run?: GitRunnerOption['run'];
}): (args: string[], cwd: string) => Promise<string> {
  if (options?.run) {
    const provided = options.run;
    return (args: string[], cwd: string): Promise<string> =>
      provided(args, cwd);
  }
  return (args: string[], cwd: string): Promise<string> =>
    defaultGitRunner.run(args, cwd);
}

interface NumstatEntry {
  additions: number;
  deletions: number;
  isBinary: boolean;
  path: string;
}

function parseNumstat(output: string): NumstatEntry[] {
  const entries: NumstatEntry[] = [];
  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) {
      continue;
    }
    const parts = line.split('\t');
    if (parts.length < 3) {
      continue;
    }
    const [addStr, delStr, ...rest] = parts;
    const isBinary = addStr === '-' && delStr === '-';
    // For renames numstat may render `old => new`; keep the raw path token. The
    // authoritative post-image path comes from name-status / per-file diff.
    const path = rest.join('\t');
    entries.push({
      additions: isBinary ? 0 : Number.parseInt(addStr, 10) || 0,
      deletions: isBinary ? 0 : Number.parseInt(delStr, 10) || 0,
      isBinary,
      path,
    });
  }
  return entries;
}

interface NameStatusEntry {
  status: string;
  oldPath?: string;
  path: string;
}

function parseNameStatus(output: string): NameStatusEntry[] {
  const entries: NameStatusEntry[] = [];
  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) {
      continue;
    }
    const parts = line.split('\t');
    const status = parts[0] ?? '';
    if (status.startsWith('R') || status.startsWith('C')) {
      // Rename/copy: status, oldPath, newPath
      entries.push({
        status,
        oldPath: parts[1],
        path: parts[2] ?? parts[1] ?? '',
      });
    } else {
      entries.push({ status, path: parts[1] ?? '' });
    }
  }
  return entries;
}

/**
 * Gather the planner-facing default-context (U3) diff snapshot. Composes
 * `git diff --numstat -M` and `git diff --name-status -M` for entries, kinds,
 * and binary detection, then a per-file U3 diff parsed by `parseUnifiedDiff`.
 * No truncation anywhere. Totals are summed from numstat.
 */
export async function gatherPrDiffSnapshot(
  repoPath: string,
  baseRefSha: string,
  headSha: string,
  options?: { run?: GitRunnerOption['run'] },
): Promise<PrDiffSnapshot> {
  const run = resolveRunner(options);

  const [numstatOut, nameStatusOut] = await Promise.all([
    run(['diff', '--numstat', '-M', baseRefSha, headSha], repoPath),
    run(['diff', '--name-status', '-M', baseRefSha, headSha], repoPath),
  ]);

  const numstat = parseNumstat(numstatOut);
  const nameStatus = parseNameStatus(nameStatusOut);

  // Post-image path list, ordered by name-status (authoritative kinds).
  const files: DiffFileEntry[] = [];
  let totalAdditions = 0;
  let totalDeletions = 0;

  // Build a numstat lookup keyed by post-image path for totals aggregation.
  // Numstat totals are summed unconditionally below.
  for (const entry of numstat) {
    totalAdditions += entry.additions;
    totalDeletions += entry.deletions;
  }

  for (const status of nameStatus) {
    // Rename detection needs BOTH the pre-image and post-image paths in the
    // pathspec; scoping to just the new path makes git report a spurious
    // add/delete pair instead of a rename.
    const pathspec =
      status.oldPath && status.oldPath !== status.path
        ? [status.oldPath, status.path]
        : [status.path];
    const perFile = await run(
      ['diff', '-M', baseRefSha, headSha, '--', ...pathspec],
      repoPath,
    );
    const parsed = parseUnifiedDiff(perFile);
    const match = parsed.find((f) => f.path === status.path) ?? parsed[0];
    if (match) {
      files.push(match);
    }
  }

  return {
    baseRef: baseRefSha,
    headRef: headSha,
    files,
    totalAdditions,
    totalDeletions,
  };
}

/**
 * Recompute the carve-time zero-context diff of the given paths against a child
 * base. Zero-context runs never merge from context proximity and are invariant
 * under ancestor commits.
 */
export async function computeChildBaseDiffU0(
  repoPath: string,
  childBaseRef: string,
  headSha: string,
  paths: string[],
  options?: { run?: GitRunnerOption['run'] },
): Promise<DiffFileEntry[]> {
  const run = resolveRunner(options);
  const output = await run(
    [
      'diff',
      '--no-renames',
      '--unified=0',
      childBaseRef,
      headSha,
      '--',
      ...paths,
    ],
    repoPath,
  );
  return parseUnifiedDiff(output);
}
