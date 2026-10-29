import type { FileLinkLineLocation } from './file-link-line-suffix';

/**
 * Whole-line ranges over file text for revealing a linked location
 * (CAN-4275).
 *
 * Lines are one-based and end at `\n`; a `\r` immediately before it is part
 * of that terminator, and a lone `\r` is ordinary content. A trailing newline
 * starts an empty final line, and empty content is one empty line. Offsets
 * are UTF-16 indexes into the original string, which is never normalized, so
 * slicing at them preserves the content byte-for-byte.
 */
export interface FileLineRange {
  /** Clamped one-based first line. */
  readonly line: number;
  /** Clamped one-based last line; never before {@link line}. */
  readonly lineEnd: number;
  /** Offset of the first character of {@link line}. */
  readonly start: number;
  /** Offset just past {@link lineEnd}, including its terminator when present. */
  readonly end: number;
}

export interface FileLineRangeSegments {
  /** Content before the first requested line. */
  readonly before: string;
  /** The requested lines, including the last line's terminator when present. */
  readonly range: string;
  /** Content after the requested lines. */
  readonly after: string;
}

function requestedLine(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.trunc(value)
    : fallback;
}

/**
 * Clamp `location` to the lines of `content` and return the offsets of the
 * complete requested lines. Scans only as far as the last requested line.
 */
export function resolveFileLineRange(
  content: string,
  location: FileLinkLineLocation,
): FileLineRange {
  const wantedLine = requestedLine(location.line, 1);
  let line = 1;
  let start = 0;
  while (line < wantedLine) {
    const newline = content.indexOf('\n', start);
    if (newline === -1) break;
    start = newline + 1;
    line += 1;
  }

  const wantedEnd = Math.max(requestedLine(location.lineEnd, line), line);
  let lineEnd = line;
  let cursor = start;
  let end = content.length;
  for (;;) {
    const newline = content.indexOf('\n', cursor);
    if (newline === -1) break;
    if (lineEnd >= wantedEnd) {
      end = newline + 1;
      break;
    }
    cursor = newline + 1;
    lineEnd += 1;
  }
  return { line, lineEnd, start, end };
}

/** Slice `content` around a resolved range without altering any character. */
export function splitFileLineRange(
  content: string,
  range: Pick<FileLineRange, 'start' | 'end'>,
): FileLineRangeSegments {
  return {
    before: content.slice(0, range.start),
    range: content.slice(range.start, range.end),
    after: content.slice(range.end),
  };
}
