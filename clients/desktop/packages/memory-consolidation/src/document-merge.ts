import {
  MEMORY_SYNC_LIMITS,
  type MemoryConflictReason,
} from '@canopy/protocol/memory-sync';
import { diff3Merge } from 'node-diff3';

/*
 * The three-way merge of one memory document after a manual edit lost its
 * compare-and-set (cloud memory sync design §13.2, D5). Every holder that
 * edits synced memory applies the same rules, so this lives with the other
 * shared memory rules. A side is `null` when the document is absent there
 * (deleted, or never created).
 */

/**
 * Merging runs only when every side is at most this large, and a merge is
 * kept only when its result is too: the size sync carries a document.
 */
export const MEMORY_DOCUMENT_MERGE_MAX_BYTES =
  MEMORY_SYNC_LIMITS.documentMaxBytes;

/** ...and has at most this many lines. */
export const MEMORY_DOCUMENT_MERGE_MAX_LINES = 20_000;

/**
 * ...and the line diffs are estimated to take at most this many steps (see
 * {@link lineDiffWork}): about 30 to 60 ms on a recent laptop.
 */
export const MEMORY_DOCUMENT_MERGE_MAX_WORK = 100_000_000;

export type MemoryDocumentMerge =
  /** Ours is the base: take theirs. */
  | { kind: 'theirs' }
  /** Theirs is the base: keep ours, which is committed again at the head. */
  | { kind: 'ours' }
  /** Both sides made the same change. */
  | { kind: 'same' }
  /** Changes in different places: the merged text, committed at the head. */
  | { kind: 'merged'; content: string }
  /**
   * Overlapping changes or a delete against an edit (`overlap`), a line
   * diff too costly to run (`too_costly`), or a side, or the merged text,
   * larger than sync carries (`too_large`).
   */
  | { kind: 'conflict'; reason: MemoryConflictReason };

/** How a merge is decided: outright, or by a line diff of this much work. */
export type MemoryDocumentMergePlan =
  | { kind: 'decided'; merge: MemoryDocumentMerge }
  | { kind: 'diff'; work: number };

/**
 * A document as the cloud stores it: LF line endings and no NUL bytes. A
 * replica normalizes what other editors write the same way before it
 * compares or commits it.
 */
export function normalizeMemoryDocumentContent(content: string): string {
  return content.replace(/\r\n?/g, '\n').replace(/\0/g, '');
}

function normalizeSide(side: string | null): string | null {
  return side === null ? null : normalizeMemoryDocumentContent(side);
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Lossless line tokens: each keeps its own terminator, and a final
 * unterminated line is a token of its own, so joining reproduces the text.
 */
function lineTokens(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/**
 * The steps node-diff3's longest common subsequence of `base` and `side`
 * may take: it scans its candidates once for each pair of equal lines, and
 * holds at most one candidate per line of the shorter side.
 */
function lineDiffWork(
  base: readonly string[],
  side: readonly string[],
): number {
  const counts = new Map<string, number>();
  for (const line of side) counts.set(line, (counts.get(line) ?? 0) + 1);
  let pairs = 0;
  for (const line of base) pairs += counts.get(line) ?? 0;
  return (
    pairs * (Math.min(base.length, side.length) + 1) + base.length + side.length
  );
}

type Prepared =
  | { kind: 'decided'; merge: MemoryDocumentMerge }
  | { kind: 'diff'; work: number; lines: [string[], string[], string[]] };

function prepare(
  rawBase: string | null,
  rawOurs: string | null,
  rawTheirs: string | null,
): Prepared {
  const decided = (merge: MemoryDocumentMerge): Prepared => ({
    kind: 'decided',
    merge,
  });
  const conflict = (reason: MemoryConflictReason): Prepared =>
    decided({ kind: 'conflict', reason });
  const base = normalizeSide(rawBase);
  const ours = normalizeSide(rawOurs);
  const theirs = normalizeSide(rawTheirs);
  if (ours === base) return decided({ kind: 'theirs' });
  if (theirs === base) return decided({ kind: 'ours' });
  if (ours === theirs) return decided({ kind: 'same' });
  if (ours === null || theirs === null) return conflict('overlap');
  const sides = [base ?? '', ours, theirs];
  if (sides.some((side) => utf8Bytes(side) > MEMORY_DOCUMENT_MERGE_MAX_BYTES)) {
    return conflict('too_large');
  }
  const lines: [string[], string[], string[]] = [
    lineTokens(base ?? ''),
    lineTokens(ours),
    lineTokens(theirs),
  ];
  // node-diff3 spreads each unchanged run into an array push, which fails
  // past roughly 100,000 lines.
  if (lines.some((side) => side.length > MEMORY_DOCUMENT_MERGE_MAX_LINES)) {
    return conflict('too_large');
  }
  const work =
    lineDiffWork(lines[0], lines[1]) + lineDiffWork(lines[0], lines[2]);
  if (work > MEMORY_DOCUMENT_MERGE_MAX_WORK) return conflict('too_costly');
  return { kind: 'diff', work, lines };
}

/**
 * How {@link mergeMemoryDocument} decides, without running its line diff:
 * a host may run a costly diff off its main thread.
 */
export function planMemoryDocumentMerge(
  base: string | null,
  ours: string | null,
  theirs: string | null,
): MemoryDocumentMergePlan {
  const prepared = prepare(base, ours, theirs);
  return prepared.kind === 'decided'
    ? prepared
    : { kind: 'diff', work: prepared.work };
}

/**
 * Every side is compared as the cloud stores it (see
 * {@link normalizeMemoryDocumentContent}), so an edit saved with CRLF is
 * the change it stands for. A merged result is LF text, and a conflict when
 * it is larger than sync carries: two documents each within the limit can
 * merge into one past it, which no commit could send.
 */
export function mergeMemoryDocument(
  base: string | null,
  ours: string | null,
  theirs: string | null,
): MemoryDocumentMerge {
  const prepared = prepare(base, ours, theirs);
  if (prepared.kind === 'decided') return prepared.merge;
  const [baseLines, ourLines, theirLines] = prepared.lines;
  const merged: string[] = [];
  for (const region of diff3Merge(ourLines, baseLines, theirLines)) {
    if (region.conflict !== undefined) {
      return { kind: 'conflict', reason: 'overlap' };
    }
    merged.push((region.ok ?? []).join(''));
  }
  const content = merged.join('');
  if (utf8Bytes(content) > MEMORY_DOCUMENT_MERGE_MAX_BYTES) {
    return { kind: 'conflict', reason: 'too_large' };
  }
  return { kind: 'merged', content };
}
