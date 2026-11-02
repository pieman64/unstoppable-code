// Display rows for an Edit or Write approval request (CAN-5165). The input is
// structurally compatible with `ApprovalFileChange` in `@canopy/desktop-shared`
// without importing it, so this stays a browser-safe display helper. The rows
// describe the supplied request text, not a patch verified against the file.

/** The proposed change carried on a file-write approval request. */
export type ApprovalFileChangeInput =
  | {
      kind: 'edit';
      oldText: string;
      newText: string;
      replaceAll?: boolean;
      truncated?: boolean;
    }
  | {
      kind: 'write';
      content: string;
      truncated?: boolean;
    };

/** How a line ended in the supplied text. */
export type ApprovalFileChangeLineEnding = 'lf' | 'crlf' | 'none';

/**
 * A line-ending note for a row whose difference would otherwise be invisible:
 * `crlf` when one side uses CRLF and the other a bare LF, `no-final-newline`
 * when only one side ends with a newline.
 */
export type ApprovalFileChangeEndingMarker = 'crlf' | 'no-final-newline';

export type ApprovalFileChangeRow =
  | {
      kind: 'context' | 'deleted' | 'added' | 'content';
      text: string;
      /** The text was cut to the row character limit. */
      shortened: boolean;
      endingMarker?: ApprovalFileChangeEndingMarker;
    }
  | {
      kind: 'omitted';
      /** Which block the hidden lines belong to. */
      block: 'deleted' | 'added' | 'content';
      count: number;
    };

/**
 * `changes`: rows to show. `empty`: a Write with no content. `unchanged`: an
 * Edit whose complete old and new text are equal. `indeterminate`: the
 * available text is equal, but it was capped upstream, so the full change may
 * still differ.
 */
export type ApprovalFileChangeRowsState =
  | 'changes'
  | 'empty'
  | 'unchanged'
  | 'indeterminate';

export interface ApprovalFileChangeRows {
  state: ApprovalFileChangeRowsState;
  rows: ApprovalFileChangeRow[];
  /** The display limits hid lines or shortened a line of the supplied text. */
  previewTruncated: boolean;
  /** The request text was capped before it reached the UI. */
  sourceTruncated: boolean;
}

export interface ApprovalFileChangeRowLimits {
  /** Line rows to show; omission rows do not count. */
  maxRows: number;
  /** UTF-16 units per row before it is shortened. */
  maxRowChars: number;
}

/** Limits for the inline card preview. */
export const APPROVAL_FILE_CHANGE_COMPACT_LIMITS: ApprovalFileChangeRowLimits =
  { maxRows: 8, maxRowChars: 200 };

/** No display limits: the expanded view, bounded by the upstream cap. */
export const APPROVAL_FILE_CHANGE_EXPANDED_LIMITS: ApprovalFileChangeRowLimits =
  { maxRows: Number.POSITIVE_INFINITY, maxRowChars: Number.POSITIVE_INFINITY };

interface SourceLine {
  text: string;
  ending: ApprovalFileChangeLineEnding;
}

/** Splits losslessly: joining each line's text and ending restores the input. */
function splitLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', start)) {
    const crlf = i > start && text.charCodeAt(i - 1) === 13;
    lines.push({
      text: text.slice(start, crlf ? i - 1 : i),
      ending: crlf ? 'crlf' : 'lf',
    });
    start = i + 1;
  }
  if (start < text.length) {
    lines.push({ text: text.slice(start), ending: 'none' });
  }
  return lines;
}

function sameLine(
  a: SourceLine | undefined,
  b: SourceLine | undefined,
): boolean {
  return (
    a !== undefined &&
    b !== undefined &&
    a.text === b.text &&
    a.ending === b.ending
  );
}

/** Cuts to `max` units without splitting a surrogate pair. */
function shorten(
  text: string,
  max: number,
): { text: string; shortened: boolean } {
  if (text.length <= max) return { text, shortened: false };
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), shortened: true };
}

function endsWithNewline(lines: readonly SourceLine[]): boolean {
  const last = lines[lines.length - 1];
  return last !== undefined && last.ending !== 'none';
}

interface RowBuilder {
  rows: ApprovalFileChangeRow[];
  previewTruncated: boolean;
}

function pushLine(
  builder: RowBuilder,
  kind: 'context' | 'deleted' | 'added' | 'content',
  line: SourceLine,
  limits: ApprovalFileChangeRowLimits,
  endingMarker: ApprovalFileChangeEndingMarker | undefined,
): void {
  const cut = shorten(line.text, limits.maxRowChars);
  if (cut.shortened) builder.previewTruncated = true;
  builder.rows.push({
    kind,
    text: cut.text,
    shortened: cut.shortened,
    ...(endingMarker ? { endingMarker } : {}),
  });
}

function pushBlock(
  builder: RowBuilder,
  kind: 'deleted' | 'added' | 'content',
  lines: readonly SourceLine[],
  shown: number,
  limits: ApprovalFileChangeRowLimits,
  markerFor: (
    line: SourceLine,
    index: number,
  ) => ApprovalFileChangeEndingMarker | undefined,
): void {
  for (let i = 0; i < shown; i += 1) {
    const line = lines[i];
    if (line) pushLine(builder, kind, line, limits, markerFor(line, i));
  }
  if (lines.length > shown) {
    builder.previewTruncated = true;
    builder.rows.push({
      kind: 'omitted',
      block: kind,
      count: lines.length - shown,
    });
  }
}

function buildWriteRows(
  content: string,
  sourceTruncated: boolean,
  limits: ApprovalFileChangeRowLimits,
): ApprovalFileChangeRows {
  if (content.length === 0) {
    return {
      state: 'empty',
      rows: [],
      previewTruncated: false,
      sourceTruncated,
    };
  }
  const lines = splitLines(content);
  const builder: RowBuilder = { rows: [], previewTruncated: false };
  pushBlock(
    builder,
    'content',
    lines,
    Math.min(lines.length, limits.maxRows),
    limits,
    (line) =>
      line.ending === 'crlf'
        ? 'crlf'
        : line.ending === 'none'
          ? 'no-final-newline'
          : undefined,
  );
  return {
    state: 'changes',
    rows: builder.rows,
    previewTruncated: builder.previewTruncated,
    sourceTruncated,
  };
}

/**
 * Splits the row budget so neither side of a replacement can hide the other:
 * when both have lines, each gets at least half before the other takes the
 * remainder.
 */
function allocate(
  deleted: number,
  added: number,
  budget: number,
): { deleted: number; added: number } {
  if (deleted === 0) return { deleted: 0, added: Math.min(added, budget) };
  if (added === 0) return { deleted: Math.min(deleted, budget), added: 0 };
  const half = Math.max(1, Math.floor(budget / 2));
  let shownDeleted = Math.min(deleted, half);
  const shownAdded = Math.min(added, Math.max(1, budget - shownDeleted));
  shownDeleted = Math.min(deleted, Math.max(1, budget - shownAdded));
  return { deleted: shownDeleted, added: shownAdded };
}

function buildEditRows(
  oldText: string,
  newText: string,
  sourceTruncated: boolean,
  limits: ApprovalFileChangeRowLimits,
): ApprovalFileChangeRows {
  if (oldText === newText) {
    return {
      state: sourceTruncated ? 'indeterminate' : 'unchanged',
      rows: [],
      previewTruncated: false,
      sourceTruncated,
    };
  }

  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const shared = Math.min(oldLines.length, newLines.length);
  let prefix = 0;
  while (prefix < shared && sameLine(oldLines[prefix], newLines[prefix])) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < shared - prefix &&
    sameLine(
      oldLines[oldLines.length - 1 - suffix],
      newLines[newLines.length - 1 - suffix],
    )
  ) {
    suffix += 1;
  }

  const deleted = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  const before = prefix > 0 ? oldLines[prefix - 1] : undefined;
  const after = suffix > 0 ? oldLines[oldLines.length - suffix] : undefined;

  // Mark endings only where the two sides disagree, so an ordinary CRLF file
  // or a snippet without a trailing newline does not add noise to every row.
  const crlfDiffers =
    deleted.some(
      (line, index) =>
        line.ending === 'crlf' && added[index]?.ending !== 'crlf',
    ) ||
    added.some(
      (line, index) =>
        line.ending === 'crlf' && deleted[index]?.ending !== 'crlf',
    );
  const finalNewlineDiffers =
    endsWithNewline(oldLines) !== endsWithNewline(newLines);
  const markerFor =
    (side: readonly SourceLine[], offset: number) =>
    (
      line: SourceLine,
      index: number,
    ): ApprovalFileChangeEndingMarker | undefined => {
      if (
        finalNewlineDiffers &&
        line.ending === 'none' &&
        offset + index === side.length - 1
      ) {
        return 'no-final-newline';
      }
      return crlfDiffers && line.ending === 'crlf' ? 'crlf' : undefined;
    };

  const shown = allocate(deleted.length, added.length, limits.maxRows);
  let spare = limits.maxRows - shown.deleted - shown.added;
  const builder: RowBuilder = { rows: [], previewTruncated: false };
  if (before && spare > 0) {
    spare -= 1;
    pushLine(builder, 'context', before, limits, undefined);
  }
  pushBlock(
    builder,
    'deleted',
    deleted,
    shown.deleted,
    limits,
    markerFor(oldLines, prefix),
  );
  pushBlock(
    builder,
    'added',
    added,
    shown.added,
    limits,
    markerFor(newLines, prefix),
  );
  if (after && spare > 0) {
    pushLine(builder, 'context', after, limits, undefined);
  }
  return {
    state: 'changes',
    rows: builder.rows,
    previewTruncated: builder.previewTruncated,
    sourceTruncated,
  };
}

/**
 * Builds display rows for a proposed change. An Edit drops the common leading
 * and trailing lines, keeps one context line on each side, and lists the
 * deleted then added lines: a compact replacement view, not a minimal diff.
 * Runs in linear time in the supplied text.
 */
export function buildApprovalFileChangeRows(
  change: ApprovalFileChangeInput,
  limits: ApprovalFileChangeRowLimits = APPROVAL_FILE_CHANGE_COMPACT_LIMITS,
): ApprovalFileChangeRows {
  const sourceTruncated = change.truncated === true;
  return change.kind === 'write'
    ? buildWriteRows(change.content, sourceTruncated, limits)
    : buildEditRows(change.oldText, change.newText, sourceTruncated, limits);
}

/** Copy for opening the expanded view, by whether the source was capped. */
export function approvalFileChangeExpansionCopy(sourceTruncated: boolean): {
  action: string;
  title: string;
} {
  return sourceTruncated
    ? { action: 'View available change', title: 'Available change' }
    : { action: 'View full change', title: 'Full change' };
}
