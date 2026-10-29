import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonicalRelativePath } from '../ids';

const execFileAsync = promisify(execFile);

// Bounded per the Global Constraints: execFile only (no shell), explicit
// cwd via `-C`, a hard timeout, and a bounded maxBuffer so a pathological
// diff/tree cannot hang or OOM the caller.
const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

const GIT_EXEC_OPTIONS = {
  maxBuffer: GIT_MAX_BUFFER_BYTES,
  timeout: GIT_TIMEOUT_MS,
};

// Refs (branch names, tags, SHAs, `HEAD~1`, `origin/main`, etc.) are passed
// straight into `execFile` argv slots, so there is no shell to inject
// through — but a ref value shaped like a git option (leading `-`) can still
// steer the invoked git subcommand (e.g. `--upload-pack=...`). This pattern
// restricts refs to the character set git itself accepts in practice and
// caps length; the leading-`-` check below is required in addition because
// `-` is a valid *interior* ref character (e.g. `feature/foo-bar`).
const SAFE_GIT_REF_PATTERN = /^[A-Za-z0-9_./@^~-]{1,128}$/;

export function isSafeGitRef(ref: string): boolean {
  return SAFE_GIT_REF_PATTERN.test(ref) && !ref.startsWith('-');
}

export interface ChangedFileRanges {
  relativePath: string;
  ranges: Array<{ start: number; end: number }>;
  status: 'modified' | 'added' | 'deleted' | 'renamed';
  previousPath?: string;
}

interface HunkRange {
  start: number;
  end: number;
}

const HUNK_HEADER_PATTERN = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

// `@@ -a[,b] +c[,d] @@` — the after-side (`+c[,d]`) describes where the hunk
// lands in the new file: `c` is the starting line and `d` is the line count
// (omitted `d` means a single line, i.e. `d = 1`). When `d` is explicitly 0
// the hunk is a pure deletion — no lines were added, so there is no real
// after-side range, only the insertion point `c` where the removed content
// used to sit. `Math.max(d, 1)` collapses both that case and the implicit
// single-line case to the same single-line range `[c, c]`, so one formula
// covers every shape of hunk header.
function parseHunkHeader(line: string): HunkRange | null {
  const match = HUNK_HEADER_PATTERN.exec(line);
  if (match === null) {
    return null;
  }
  const afterStart = Number(match[1]);
  const afterCount = match[2] !== undefined ? Number(match[2]) : 1;
  const effectiveCount = Math.max(afterCount, 1);
  return { start: afterStart, end: afterStart + effectiveCount - 1 };
}

const DIFF_GIT_HEADER_PATTERN = /^diff --git a\/(.+) b\/(.+)$/;

// Starts a new diff section on a `diff --git a/X b/Y` header line, keyed by
// the file's current path (the `b/` side). For a rename this is the new
// path, which is also how the `--name-status` pass (see below) keys renamed
// entries, so the two passes merge cleanly. For a plain deletion the `a/`
// and `b/` sides are the same (deleted) path. Returns `null` when the line
// doesn't parse as a diff header, closing out the current section.
function beginDiffSection(
  line: string,
  hunksByPath: Map<string, HunkRange[]>,
): string | null {
  const headerMatch = DIFF_GIT_HEADER_PATTERN.exec(line);
  if (headerMatch === null) {
    return null;
  }
  const newPath = canonicalRelativePath(headerMatch[2]);
  if (!hunksByPath.has(newPath)) {
    hunksByPath.set(newPath, []);
  }
  return newPath;
}

// Binary file sections (`Binary files ... differ`) never emit `@@` hunk
// headers, so they naturally end up with an empty range list once grouped.
function parseUnifiedDiffHunks(diffText: string): Map<string, HunkRange[]> {
  const hunksByPath = new Map<string, HunkRange[]>();
  let currentPath: string | null = null;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      currentPath = beginDiffSection(line, hunksByPath);
      continue;
    }
    if (currentPath === null || !line.startsWith('@@ ')) {
      continue;
    }
    const range = parseHunkHeader(line);
    if (range === null) {
      continue;
    }
    const existing = hunksByPath.get(currentPath);
    if (existing !== undefined) {
      existing.push(range);
    }
  }
  return hunksByPath;
}

interface NameStatusEntry {
  status: ChangedFileRanges['status'];
  relativePath: string;
  previousPath?: string;
}

// `git diff --name-status -z` NUL-separates fields instead of using
// tab/newline. Single-path statuses (M/A/D/T/...) emit `<code>\0<path>\0`;
// rename/copy statuses emit `<code><score>\0<oldPath>\0<newPath>\0`.
function parseNameStatus(output: string): NameStatusEntry[] {
  const tokens = output.split('\0').filter((token) => token.length > 0);
  const entries: NameStatusEntry[] = [];
  let index = 0;
  while (index < tokens.length) {
    const code = tokens[index];
    index += 1;
    if (code.startsWith('R') || code.startsWith('C')) {
      const oldPath = tokens[index];
      const newPath = tokens[index + 1];
      index += 2;
      if (oldPath === undefined || newPath === undefined) {
        continue;
      }
      entries.push({
        status: 'renamed',
        relativePath: canonicalRelativePath(newPath),
        previousPath: canonicalRelativePath(oldPath),
      });
      continue;
    }
    const filePath = tokens[index];
    index += 1;
    if (filePath === undefined) {
      continue;
    }
    const status: ChangedFileRanges['status'] = code.startsWith('A')
      ? 'added'
      : code.startsWith('D')
        ? 'deleted'
        : 'modified';
    entries.push({ status, relativePath: canonicalRelativePath(filePath) });
  }
  return entries;
}

function buildChangedFileRanges(
  entry: NameStatusEntry,
  hunksByPath: Map<string, HunkRange[]>,
): ChangedFileRanges {
  const changed: ChangedFileRanges = {
    relativePath: entry.relativePath,
    ranges: hunksByPath.get(entry.relativePath) ?? [],
    status: entry.status,
  };
  if (entry.previousPath !== undefined) {
    changed.previousPath = entry.previousPath;
  }
  return changed;
}

// `git diff <ref>` only reports paths git already tracks — a wholly untracked
// new file (never `git add`ed) is the NORMAL working state for an agent mid-
// task, yet it appears in neither the unified diff nor `--name-status`. Fold
// each such path in as an `added` entry (empty ranges: `added` maps to every
// symbol of the file regardless of ranges — see impact/changed-symbols.ts's
// whole-file handling), deduped against the tracked-diff entries.
function parseUntrackedAddedFiles(
  output: string,
  alreadyReported: ReadonlySet<string>,
): ChangedFileRanges[] {
  const added: ChangedFileRanges[] = [];
  const seen = new Set<string>();
  for (const token of output.split('\0')) {
    if (token.length === 0) {
      continue;
    }
    const relativePath = canonicalRelativePath(token);
    if (alreadyReported.has(relativePath) || seen.has(relativePath)) {
      continue;
    }
    seen.add(relativePath);
    added.push({ relativePath, ranges: [], status: 'added' });
  }
  return added;
}

export async function getDiffRanges(
  rootPath: string,
  baseRef: string,
): Promise<ChangedFileRanges[]> {
  if (!isSafeGitRef(baseRef)) {
    throw new Error(`Unsafe git ref for diff: ${baseRef}`);
  }
  const [unifiedDiff, nameStatus, untracked] = await Promise.all([
    execFileAsync(
      'git',
      [
        '-C',
        rootPath,
        // Disable path quoting so non-ASCII filenames appear literally in the
        // `diff --git a/… b/…` header. Quoted (default) headers like
        // `diff --git "a/\303\251.ts" …` do not match DIFF_GIT_HEADER_PATTERN,
        // which silently drops that file's hunk ranges. `--name-status -z`
        // below is unaffected (NUL-delimited, never quoted).
        '-c',
        'core.quotePath=false',
        'diff',
        '--unified=0',
        '--no-color',
        '--find-renames',
        baseRef,
        '--',
      ],
      GIT_EXEC_OPTIONS,
    ),
    execFileAsync(
      'git',
      [
        '-C',
        rootPath,
        'diff',
        '--name-status',
        '-z',
        '--find-renames',
        baseRef,
        '--',
      ],
      GIT_EXEC_OPTIONS,
    ),
    execFileAsync(
      'git',
      ['-C', rootPath, 'ls-files', '--others', '--exclude-standard', '-z'],
      GIT_EXEC_OPTIONS,
    ),
  ]);
  const hunksByPath = parseUnifiedDiffHunks(unifiedDiff.stdout);
  const entries = parseNameStatus(nameStatus.stdout);
  const tracked = entries.map((entry) =>
    buildChangedFileRanges(entry, hunksByPath),
  );
  const trackedPaths = new Set(tracked.map((entry) => entry.relativePath));
  return [
    ...tracked,
    ...parseUntrackedAddedFiles(untracked.stdout, trackedPaths),
  ];
}

export async function getMergeBase(
  rootPath: string,
  baseRef: string,
): Promise<string | null> {
  if (!isSafeGitRef(baseRef)) {
    return null;
  }
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', rootPath, 'merge-base', 'HEAD', baseRef],
      GIT_EXEC_OPTIONS,
    );
    const mergeBase = stdout.trim();
    return mergeBase.length > 0 ? mergeBase : null;
  } catch {
    return null;
  }
}

export async function readFileAtRef(
  rootPath: string,
  ref: string,
  relativePath: string,
): Promise<string | null> {
  if (!isSafeGitRef(ref)) {
    throw new Error(`Unsafe git ref for file read: ${ref}`);
  }
  const canonicalPath = canonicalRelativePath(relativePath);
  if (canonicalPath.startsWith('-')) {
    throw new Error(`Unsafe path for file read: ${relativePath}`);
  }
  // `ref` and `canonicalPath` are validated above, and `ref` cannot start
  // with `-` (checked by `isSafeGitRef`), so the combined `ref:path` object
  // spec below can never itself be interpreted as a git option.
  const objectSpec = `${ref}:${canonicalPath}`;
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', rootPath, 'show', objectSpec],
      GIT_EXEC_OPTIONS,
    );
    return stdout;
  } catch {
    return null;
  }
}
