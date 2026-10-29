/**
 * Pure parser for unified-diff patch text (one file or a whole-worktree diff
 * of many). Produces per-file sections with line-numbered hunk rows so the
 * renderer never has to show raw git headers (`diff --git`, `index`, `---`,
 * `+++`).
 */

export type PatchRowKind = 'context' | 'add' | 'del';

export interface PatchRow {
  readonly kind: PatchRowKind;
  readonly oldLine: number | null;
  readonly newLine: number | null;
  /** Line content without its leading marker. */
  readonly text: string;
  /** Set when the patch marks this line `\ No newline at end of file`. */
  noNewline?: boolean;
}

export interface PatchHunk {
  /** The full `@@ … @@` line. */
  readonly header: string;
  /** Text after the closing `@@` (usually the enclosing function), trimmed. */
  readonly section: string;
  readonly oldStart: number;
  readonly newStart: number;
  readonly rows: PatchRow[];
}

export interface PatchFile {
  /** The b-side path, or the a-side path for a deletion. */
  path: string | null;
  /** Header lines worth showing (rename, mode, binary, …). */
  readonly notes: string[];
  readonly hunks: PatchHunk[];
}

const NOTE_PREFIXES: readonly string[] = [
  'new file',
  'deleted file',
  'old mode',
  'new mode',
  'rename ',
  'copy ',
  'similarity ',
  'dissimilarity ',
  'Binary ',
];

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const GIT_HEADER = /^diff --git a\/(.*) b\/(.*)$/;

/** `a/x` → `x`; `/dev/null` → null. */
function headerPath(raw: string): string | null {
  // Some producers append a tab and a timestamp after the path.
  const path = raw.split('\t')[0] ?? raw;
  if (path === '/dev/null') {
    return null;
  }
  return path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path;
}

export function parseUnifiedPatch(patch: string): PatchFile[] {
  const files: PatchFile[] = [];
  let file: PatchFile | null = null;
  let hunk: PatchHunk | null = null;
  let lastRow: PatchRow | null = null;
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  // `---` path, held until `+++` decides between b-side and a-side.
  let oldPath: string | null = null;

  const startFile = (path: string | null): PatchFile => {
    const next: PatchFile = { path, notes: [], hunks: [] };
    files.push(next);
    hunk = null;
    lastRow = null;
    oldPath = null;
    return next;
  };

  const lines = patch.split(/\r?\n/);
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }

  for (const line of lines) {
    if (line.startsWith('\\')) {
      if (lastRow) {
        lastRow.noNewline = true;
      }
      continue;
    }

    if (hunk !== null && (oldLeft > 0 || newLeft > 0)) {
      // Inside a hunk body the marker alone decides: content that looks like a
      // `---`/`+++`/`diff ` header is still content.
      const marker = line.charAt(0);
      const text = line.slice(1);
      let row: PatchRow | null = null;
      if (marker === ' ' || line === '') {
        row = { kind: 'context', oldLine, newLine, text };
        oldLine += 1;
        newLine += 1;
        oldLeft -= 1;
        newLeft -= 1;
      } else if (marker === '+') {
        row = { kind: 'add', oldLine: null, newLine, text };
        newLine += 1;
        newLeft -= 1;
      } else if (marker === '-') {
        row = { kind: 'del', oldLine, newLine: null, text };
        oldLine += 1;
        oldLeft -= 1;
      }
      if (row) {
        hunk.rows.push(row);
        lastRow = row;
        continue;
      }
      // Not a body line: the counts lied; fall through to header handling.
    }
    hunk = null;

    if (line.startsWith('diff ')) {
      const git = GIT_HEADER.exec(line);
      file = startFile(git ? (git[2] ?? null) : null);
      continue;
    }
    if (line.startsWith('--- ')) {
      // A plain `diff -u` patch has no `diff ` line: `---` after a hunk opens
      // the next file.
      if (!file || file.hunks.length > 0) {
        file = startFile(null);
      }
      oldPath = headerPath(line.slice(4));
      continue;
    }
    if (line.startsWith('+++ ')) {
      file ??= startFile(null);
      file.path = headerPath(line.slice(4)) ?? oldPath ?? file.path;
      continue;
    }
    const header = HUNK_HEADER.exec(line);
    if (header) {
      file ??= startFile(null);
      if (file.path === null && oldPath !== null) {
        file.path = oldPath;
      }
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      oldLeft = header[2] === undefined ? 1 : Number(header[2]);
      newLeft = header[4] === undefined ? 1 : Number(header[4]);
      hunk = {
        header: line,
        section: (header[5] ?? '').trim(),
        oldStart: oldLine,
        newStart: newLine,
        rows: [],
      };
      file.hunks.push(hunk);
      continue;
    }
    if (file && NOTE_PREFIXES.some((prefix) => line.startsWith(prefix))) {
      file.notes.push(line);
    }
    // Anything else (`index …`, a preamble before the first header) is noise.
  }

  return files;
}

/** One split-view row: the old side and the new side (null = filler). */
export interface SplitRow {
  readonly left: PatchRow | null;
  readonly right: PatchRow | null;
}

/**
 * Pair a hunk's rows for side-by-side display: context appears on both
 * sides, and a run of deletions followed by additions is zipped row by row.
 */
export function pairSplitRows(rows: readonly PatchRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let dels: PatchRow[] = [];
  let adds: PatchRow[] = [];
  const flush = (): void => {
    for (let k = 0; k < Math.max(dels.length, adds.length); k += 1) {
      out.push({
        left: k < dels.length ? dels[k] : null,
        right: k < adds.length ? adds[k] : null,
      });
    }
    dels = [];
    adds = [];
  };
  for (const row of rows) {
    if (row.kind === 'del') {
      // A deletion after additions starts a new change run.
      if (adds.length > 0) flush();
      dels.push(row);
    } else if (row.kind === 'add') {
      adds.push(row);
    } else {
      flush();
      out.push({ left: row, right: row });
    }
  }
  flush();
  return out;
}
