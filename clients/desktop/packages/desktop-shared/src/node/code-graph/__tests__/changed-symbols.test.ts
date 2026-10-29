import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  openCodeGraphDatabase,
  type CodeGraphDatabase,
} from '../store/database';
import { runCodeGraphMigrations } from '../store/migrations';
import { CodeGraphStore } from '../store/graph-store';
import {
  fileQualifiedName,
  fileRowId,
  symbolQualifiedName,
  symbolRowId,
} from '../ids';
import type {
  CodeGraphFileFacts,
  CodeGraphSymbolRecord,
} from '../../../types/code-graph';
import type { ChangedFileRanges } from '../git/diff';
import { mapRangesToSymbols } from '../impact/changed-symbols';

const REPO = 'repo-a';

// Mirrors the fixture helper pattern in queries.test.ts: a 'file' kind symbol
// plus one or more 'function' kind child symbols per file, wired through
// replaceFileFacts so lookups go through the real store/graph-store code
// path rather than hand-rolled mocks.
function fileSymbol(relativePath: string): CodeGraphSymbolRecord {
  return {
    id: symbolRowId(REPO, fileQualifiedName(relativePath)),
    repositoryId: REPO,
    fileId: fileRowId(REPO, relativePath),
    kind: 'file',
    name: relativePath.split('/').pop() ?? relativePath,
    qualifiedName: fileQualifiedName(relativePath),
    parentSymbolId: null,
    lineStart: 1,
    lineEnd: 10,
    byteStart: 0,
    byteEnd: 100,
    signature: null,
    exported: false,
    isTest: false,
    extra: {},
  };
}

function fnSymbol(
  relativePath: string,
  name: string,
  lineStart: number,
  lineEnd: number,
): CodeGraphSymbolRecord {
  return {
    ...fileSymbol(relativePath),
    id: symbolRowId(REPO, symbolQualifiedName(relativePath, [], name)),
    kind: 'function',
    name,
    qualifiedName: symbolQualifiedName(relativePath, [], name),
    lineStart,
    lineEnd,
    byteStart: 10,
    byteEnd: 50,
    signature: `function ${name}()`,
  };
}

function facts(
  relativePath: string,
  symbols: CodeGraphSymbolRecord[],
): CodeGraphFileFacts {
  return {
    file: {
      id: fileRowId(REPO, relativePath),
      repositoryId: REPO,
      relativePath,
      absolutePath: `/abs/${relativePath}`,
      language: 'typescript',
      contentHash: 'h',
      sizeBytes: 100,
      mtimeNs: '1',
      lineCount: 10,
      grammarId: 'typescript',
      grammarAbi: 14,
      parseStatus: 'parsed',
      hasErrors: false,
      updatedAt: Date.now(),
    },
    symbols,
    edges: [],
  };
}

function modified(
  relativePath: string,
  ranges: Array<{ start: number; end: number }>,
): ChangedFileRanges {
  return { relativePath, ranges, status: 'modified' };
}

function added(relativePath: string): ChangedFileRanges {
  return { relativePath, ranges: [{ start: 1, end: 1 }], status: 'added' };
}

function deleted(relativePath: string): ChangedFileRanges {
  return { relativePath, ranges: [], status: 'deleted' };
}

function renamed(
  relativePath: string,
  previousPath: string,
  ranges: Array<{ start: number; end: number }> = [],
): ChangedFileRanges {
  return { relativePath, ranges, status: 'renamed', previousPath };
}

describe('mapRangesToSymbols', () => {
  let dir: string;
  let db: CodeGraphDatabase;
  let store: CodeGraphStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'code-graph-changed-symbols-'));
    db = openCodeGraphDatabase(path.join(dir, 'graph.db'));
    runCodeGraphMigrations(db);
    store = new CodeGraphStore(db);
    store.upsertRepository({ repoId: REPO, rootPath: '/abs', gitHead: null });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('matches a child symbol whose range touches lineEnd exactly (inclusive overlap)', () => {
    const file = fileSymbol('src/lib.ts');
    const fn = fnSymbol('src/lib.ts', 'doWork', 2, 4);
    store.replaceFileFacts(facts('src/lib.ts', [file, fn]));

    const result = mapRangesToSymbols({
      store,
      repoId: REPO,
      changes: [modified('src/lib.ts', [{ start: 4, end: 4 }])],
    });

    expect(result.changed).toEqual([
      {
        qualifiedName: 'src/lib.ts::doWork',
        kind: 'function',
        filePath: 'src/lib.ts',
        lineStart: 2,
        lineEnd: 4,
        changeKind: 'modified',
      },
    ]);
    expect(result.unmatchedFiles).toEqual([]);
  });

  it('does not match a range that starts one line past lineEnd (disjoint)', () => {
    const file = fileSymbol('src/lib.ts');
    const fn = fnSymbol('src/lib.ts', 'doWork', 2, 4);
    store.replaceFileFacts(facts('src/lib.ts', [file, fn]));

    const result = mapRangesToSymbols({
      store,
      repoId: REPO,
      changes: [modified('src/lib.ts', [{ start: 5, end: 5 }])],
    });

    // No child symbol matched -> falls back to the file-level symbol.
    expect(result.changed).toEqual([
      {
        qualifiedName: 'src/lib.ts',
        kind: 'file',
        filePath: 'src/lib.ts',
        lineStart: 1,
        lineEnd: 10,
        changeKind: 'modified',
      },
    ]);
  });

  it('matches multiple disjoint ranges against different symbols in the same file', () => {
    const file = fileSymbol('src/lib.ts');
    const a = fnSymbol('src/lib.ts', 'a', 2, 3);
    const b = fnSymbol('src/lib.ts', 'b', 6, 7);
    const c = fnSymbol('src/lib.ts', 'c', 9, 9);
    store.replaceFileFacts(facts('src/lib.ts', [file, a, b, c]));

    const result = mapRangesToSymbols({
      store,
      repoId: REPO,
      changes: [
        modified('src/lib.ts', [
          { start: 2, end: 2 },
          { start: 7, end: 7 },
        ]),
      ],
    });

    expect(result.changed.map((s) => s.qualifiedName).sort()).toEqual([
      'src/lib.ts::a',
      'src/lib.ts::b',
    ]);
    expect(result.changed.every((s) => s.changeKind === 'modified')).toBe(true);
  });

  it('falls back to the file symbol only when NO child symbol matched any range', () => {
    const file = fileSymbol('src/lib.ts');
    const a = fnSymbol('src/lib.ts', 'a', 2, 3);
    store.replaceFileFacts(facts('src/lib.ts', [file, a]));

    // Range overlaps `a`, so the file symbol must NOT appear.
    const withChildMatch = mapRangesToSymbols({
      store,
      repoId: REPO,
      changes: [modified('src/lib.ts', [{ start: 2, end: 2 }])],
    });
    expect(withChildMatch.changed.map((s) => s.qualifiedName)).toEqual([
      'src/lib.ts::a',
    ]);

    // Range overlaps nothing, so the file symbol is the fallback.
    const withoutChildMatch = mapRangesToSymbols({
      store,
      repoId: REPO,
      changes: [modified('src/lib.ts', [{ start: 100, end: 100 }])],
    });
    expect(withoutChildMatch.changed.map((s) => s.qualifiedName)).toEqual([
      'src/lib.ts',
    ]);
  });

  it('marks every symbol in an added file as added-file, including the file symbol', () => {
    const file = fileSymbol('src/new.ts');
    const a = fnSymbol('src/new.ts', 'a', 2, 3);
    const b = fnSymbol('src/new.ts', 'b', 5, 6);
    store.replaceFileFacts(facts('src/new.ts', [file, a, b]));

    const result = mapRangesToSymbols({
      store,
      repoId: REPO,
      changes: [added('src/new.ts')],
    });

    expect(result.changed.map((s) => s.qualifiedName).sort()).toEqual([
      'src/new.ts',
      'src/new.ts::a',
      'src/new.ts::b',
    ]);
    expect(result.changed.every((s) => s.changeKind === 'added-file')).toBe(
      true,
    );
    expect(result.unmatchedFiles).toEqual([]);
  });

  it('routes a deleted file whose rows are already gone from the current graph to unmatchedFiles', () => {
    // No replaceFileFacts call for this path -> the post-build graph has no
    // rows for it, matching the normal (non-stale) deleted-file case.
    const result = mapRangesToSymbols({
      store,
      repoId: REPO,
      changes: [deleted('src/gone.ts')],
    });

    expect(result.changed).toEqual([]);
    expect(result.unmatchedFiles).toEqual(['src/gone.ts']);
  });

  it('maps a deleted file to deleted-file symbols when the graph is stale (rows still present)', () => {
    const file = fileSymbol('src/stale.ts');
    const a = fnSymbol('src/stale.ts', 'a', 2, 3);
    store.replaceFileFacts(facts('src/stale.ts', [file, a]));

    const result = mapRangesToSymbols({
      store,
      repoId: REPO,
      changes: [deleted('src/stale.ts')],
    });

    expect(result.changed.map((s) => s.qualifiedName).sort()).toEqual([
      'src/stale.ts',
      'src/stale.ts::a',
    ]);
    expect(result.changed.every((s) => s.changeKind === 'deleted-file')).toBe(
      true,
    );
    expect(result.unmatchedFiles).toEqual([]);
  });

  it('maps a renamed file’s new path as a whole-file added-file change', () => {
    const file = fileSymbol('src/new-name.ts');
    const a = fnSymbol('src/new-name.ts', 'a', 2, 3);
    store.replaceFileFacts(facts('src/new-name.ts', [file, a]));

    const result = mapRangesToSymbols({
      store,
      repoId: REPO,
      changes: [
        // Even with hunks present (an edit+rename), the new side maps
        // whole-file — added-file is a superset of the overlap behavior.
        renamed('src/new-name.ts', 'src/old-name.ts', [{ start: 2, end: 2 }]),
      ],
    });

    // Every symbol of the new path (the file symbol included), not just the
    // hunk-overlapping child, so the delta stays symmetric with the
    // before-graph's removed old-path symbols.
    const byQualifiedName = new Map(
      result.changed.map((symbol) => [symbol.qualifiedName, symbol]),
    );
    expect(byQualifiedName.get('src/new-name.ts')?.changeKind).toBe(
      'added-file',
    );
    expect(byQualifiedName.get('src/new-name.ts::a')?.changeKind).toBe(
      'added-file',
    );
    // previousPath has no rows in the current (post-build) graph.
    expect(result.unmatchedFiles).toEqual(['src/old-name.ts']);
  });

  it('maps a stale previousPath (still present in the graph) to deleted-file symbols alongside the new path', () => {
    const newFile = fileSymbol('src/new-name.ts');
    const newFn = fnSymbol('src/new-name.ts', 'a', 2, 3);
    store.replaceFileFacts(facts('src/new-name.ts', [newFile, newFn]));

    const oldFile = fileSymbol('src/old-name.ts');
    const oldFn = fnSymbol('src/old-name.ts', 'a', 2, 3);
    store.replaceFileFacts(facts('src/old-name.ts', [oldFile, oldFn]));

    const result = mapRangesToSymbols({
      store,
      repoId: REPO,
      changes: [
        renamed('src/new-name.ts', 'src/old-name.ts', [{ start: 2, end: 2 }]),
      ],
    });

    const byQualifiedName = new Map(
      result.changed.map((s) => [s.qualifiedName, s]),
    );
    expect(byQualifiedName.get('src/new-name.ts::a')?.changeKind).toBe(
      'added-file',
    );
    expect(byQualifiedName.get('src/old-name.ts::a')?.changeKind).toBe(
      'deleted-file',
    );
    expect(byQualifiedName.get('src/old-name.ts')?.changeKind).toBe(
      'deleted-file',
    );
    expect(result.unmatchedFiles).toEqual([]);
  });

  it('routes a renamed new path with no graph rows to unmatchedFiles (not-yet-rebuilt/ineligible)', () => {
    const result = mapRangesToSymbols({
      store,
      repoId: REPO,
      changes: [renamed('src/new-name.ts', 'src/old-name.ts')],
    });

    expect(result.changed).toEqual([]);
    expect(result.unmatchedFiles.sort()).toEqual([
      'src/new-name.ts',
      'src/old-name.ts',
    ]);
  });

  it('routes a file with no graph rows to unmatchedFiles (non-eligible extension or unbuilt graph)', () => {
    const result = mapRangesToSymbols({
      store,
      repoId: REPO,
      changes: [modified('assets/logo.png', [{ start: 1, end: 1 }])],
    });

    expect(result.changed).toEqual([]);
    expect(result.unmatchedFiles).toEqual(['assets/logo.png']);
  });

  it('dedupes by qualifiedName and orders results by (filePath, lineStart)', () => {
    const fileA = fileSymbol('src/a.ts');
    const fnA = fnSymbol('src/a.ts', 'second', 6, 7);
    const fnA2 = fnSymbol('src/a.ts', 'first', 2, 3);
    store.replaceFileFacts(facts('src/a.ts', [fileA, fnA, fnA2]));

    const fileB = fileSymbol('src/b.ts');
    const fnB = fnSymbol('src/b.ts', 'onlyOne', 2, 3);
    store.replaceFileFacts(facts('src/b.ts', [fileB, fnB]));

    const result = mapRangesToSymbols({
      store,
      repoId: REPO,
      changes: [
        // Duplicate entries for the same file/ranges should not duplicate
        // the resulting ChangedSymbol.
        modified('src/a.ts', [
          { start: 2, end: 2 },
          { start: 7, end: 7 },
        ]),
        modified('src/a.ts', [{ start: 2, end: 2 }]),
        modified('src/b.ts', [{ start: 2, end: 2 }]),
      ],
    });

    expect(result.changed.map((s) => s.qualifiedName)).toEqual([
      'src/a.ts::first',
      'src/a.ts::second',
      'src/b.ts::onlyOne',
    ]);
  });

  it('canonicalizes incoming paths before looking them up in the store', () => {
    const file = fileSymbol('src/lib.ts');
    const fn = fnSymbol('src/lib.ts', 'doWork', 2, 4);
    store.replaceFileFacts(facts('src/lib.ts', [file, fn]));

    const result = mapRangesToSymbols({
      store,
      repoId: REPO,
      changes: [modified('./src/lib.ts', [{ start: 2, end: 2 }])],
    });

    expect(result.changed.map((s) => s.qualifiedName)).toEqual([
      'src/lib.ts::doWork',
    ]);
  });
});
