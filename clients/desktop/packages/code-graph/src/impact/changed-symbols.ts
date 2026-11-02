import type { CodeGraphSymbolRecord } from '../types/code-graph';
import { canonicalRelativePath } from '../ids';
import type { CodeGraphStore } from '../store/graph-store';
import type { ChangedFileRanges } from '../git/diff';

export interface ChangedSymbol {
  qualifiedName: string;
  kind: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  changeKind: 'modified' | 'added-file' | 'deleted-file';
}

type LineRange = ChangedFileRanges['ranges'][number];

interface MappingContext {
  store: CodeGraphStore;
  repoId: string;
  changed: ChangedSymbol[];
  unmatchedFiles: Set<string>;
}

// Inclusive interval intersection: a range whose start lands exactly on a
// symbol's lineEnd (or vice versa) still counts as an overlap, so a
// single-line diff hunk right at a symbol's closing line/brace is matched.
function overlaps(range: LineRange, symbol: CodeGraphSymbolRecord): boolean {
  return range.start <= symbol.lineEnd && range.end >= symbol.lineStart;
}

function toChangedSymbol(
  symbol: CodeGraphSymbolRecord,
  filePath: string,
  changeKind: ChangedSymbol['changeKind'],
): ChangedSymbol {
  return {
    qualifiedName: symbol.qualifiedName,
    kind: symbol.kind,
    filePath,
    lineStart: symbol.lineStart,
    lineEnd: symbol.lineEnd,
    changeKind,
  };
}

// Used by `modified` files: child symbols (anything but the file's own
// 'file'-kind row) that overlap ANY range are reported individually; if none
// overlap, the file-level symbol itself is reported as a whole-file-level
// change (e.g. an import reshuffle that touches no symbol's line range). The
// file symbol is otherwise HIDDEN once at least one child symbol matched. A
// rename's NEW path no longer routes here — it maps whole-file (added-file);
// see `handleRenamed`.
function mapOverlapping(
  symbols: readonly CodeGraphSymbolRecord[],
  ranges: readonly LineRange[],
  filePath: string,
): ChangedSymbol[] {
  const fileSymbol = symbols.find((symbol) => symbol.kind === 'file');
  const childSymbols = symbols.filter((symbol) => symbol.kind !== 'file');
  const matchedChildren = childSymbols.filter((symbol) =>
    ranges.some((range) => overlaps(range, symbol)),
  );
  if (matchedChildren.length > 0) {
    return matchedChildren.map((symbol) =>
      toChangedSymbol(symbol, filePath, 'modified'),
    );
  }
  return fileSymbol === undefined
    ? []
    : [toChangedSymbol(fileSymbol, filePath, 'modified')];
}

// Added files and stale-graph deleted/renamed-away paths report EVERY row
// for the file (file symbol included) under a single changeKind — there is
// no partial-overlap concept for a file that either didn't exist before or
// no longer exists at all.
function mapWholeFile(
  symbols: readonly CodeGraphSymbolRecord[],
  filePath: string,
  changeKind: 'added-file' | 'deleted-file',
): ChangedSymbol[] {
  return symbols.map((symbol) => toChangedSymbol(symbol, filePath, changeKind));
}

// Looks up `relativePath` in the CURRENT (post-build) graph. When found, its
// symbol rows are converted via `onFound`; when absent, the path is recorded
// as unmatched. Shared by the `added`, `modified`, rename-new-path, and
// gone-from-current-graph branches below, which differ only in how a found
// file's symbols get converted into ChangedSymbol rows.
function mapLookup(
  context: MappingContext,
  relativePath: string,
  onFound: (symbols: readonly CodeGraphSymbolRecord[]) => ChangedSymbol[],
): void {
  const file = context.store.getFileByPath(context.repoId, relativePath);
  if (file === null) {
    context.unmatchedFiles.add(relativePath);
    return;
  }
  context.changed.push(...onFound(context.store.listSymbolsForFile(file.id)));
}

// Handles a single `deleted` entry or a rename's `previousPath`: both
// describe a path that the CURRENT (post-build) graph is expected to have
// already dropped. The normal case (no rows found) records the path in
// `unmatchedFiles` — Task 3's before-graph is what recovers its symbols.
// The dishonest shortcut would be to always assume absence; instead, when
// the graph is stale (the build hasn't run since the delete/rename yet) and
// rows are still physically present, they are reported as `deleted-file`
// rather than silently dropped or misreported as still-live.
function mapGoneFromCurrentGraph(
  context: MappingContext,
  relativePath: string,
): void {
  mapLookup(context, relativePath, (symbols) =>
    mapWholeFile(symbols, relativePath, 'deleted-file'),
  );
}

function handleAdded(context: MappingContext, relativePath: string): void {
  mapLookup(context, relativePath, (symbols) =>
    mapWholeFile(symbols, relativePath, 'added-file'),
  );
}

function handleModifiedLikePath(
  context: MappingContext,
  relativePath: string,
  ranges: readonly LineRange[],
): void {
  mapLookup(context, relativePath, (symbols) =>
    mapOverlapping(symbols, ranges, relativePath),
  );
}

// Renames: the NEW path is mapped as a WHOLE-FILE `added-file` change — every
// symbol, not just the ones a hunk range overlaps. A pure `git mv` carries no
// hunks, so the old overlap-based mapping surfaced only the file-level symbol
// on the new side (no child range overlapped) while the before-graph reports
// ALL N of the old file's symbols as removed — an asymmetric removed:N /
// added:1 that contradicts the documented "a renamed symbol shows up as BOTH
// removed (old name) and added (new name)" invariant (see change-impact.ts).
// Whole-file added makes that invariant hold, and it is a SUPERSET of the old
// overlap behavior, so an edit+rename (a rename that ALSO carries hunks) stays
// fully covered. The OLD path (`previousPath`) is only recorded in
// `unmatchedFiles` when actually absent from the graph; a still-present
// (stale) old path is honestly reported like a stale `deleted` entry (see
// `mapGoneFromCurrentGraph`).
function handleRenamed(
  context: MappingContext,
  change: ChangedFileRanges,
  relativePath: string,
): void {
  handleAdded(context, relativePath);
  if (change.previousPath !== undefined) {
    mapGoneFromCurrentGraph(
      context,
      canonicalRelativePath(change.previousPath),
    );
  }
}

function dedupeAndSort(symbols: readonly ChangedSymbol[]): ChangedSymbol[] {
  const byQualifiedName = new Map<string, ChangedSymbol>();
  for (const symbol of symbols) {
    if (!byQualifiedName.has(symbol.qualifiedName)) {
      byQualifiedName.set(symbol.qualifiedName, symbol);
    }
  }
  return Array.from(byQualifiedName.values()).sort((a, b) => {
    if (a.filePath !== b.filePath) {
      return a.filePath < b.filePath ? -1 : 1;
    }
    if (a.lineStart !== b.lineStart) {
      return a.lineStart - b.lineStart;
    }
    if (a.qualifiedName === b.qualifiedName) {
      return 0;
    }
    return a.qualifiedName < b.qualifiedName ? -1 : 1;
  });
}

export function mapRangesToSymbols(input: {
  store: CodeGraphStore;
  repoId: string;
  changes: readonly ChangedFileRanges[];
}): { changed: ChangedSymbol[]; unmatchedFiles: string[] } {
  const context: MappingContext = {
    store: input.store,
    repoId: input.repoId,
    changed: [],
    unmatchedFiles: new Set<string>(),
  };

  for (const change of input.changes) {
    const relativePath = canonicalRelativePath(change.relativePath);
    switch (change.status) {
      case 'deleted':
        mapGoneFromCurrentGraph(context, relativePath);
        break;
      case 'added':
        handleAdded(context, relativePath);
        break;
      case 'renamed':
        handleRenamed(context, change, relativePath);
        break;
      case 'modified':
        handleModifiedLikePath(context, relativePath, change.ranges);
        break;
    }
  }

  return {
    changed: dedupeAndSort(context.changed),
    unmatchedFiles: Array.from(context.unmatchedFiles).sort(),
  };
}
