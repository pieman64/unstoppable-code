import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import * as path from 'node:path';
import { CodeGraphEngine } from '../engine';
import { fileRowId } from '../ids';
import * as symbolFtsStore from '../store/fts';
import {
  requireNumber,
  requireRow,
  requireString,
  openCodeGraphDatabase,
  setMetadataValue,
} from '../store/database';

const REPO_ID = 'selective-fts';

interface IndexCounts {
  symbols: number;
  symbolFts: number;
  fragmentFts: number;
}

interface IndexedSymbolRows {
  symbolFts: number;
  fragmentFts: number;
}

interface SearchCase {
  query: string;
  expectedName: string;
  expectedKind: 'exact' | 'prefix' | 'token-prefix' | 'fragment';
}

function putSource(root: string, relativePath: string, source: string): void {
  const absolutePath = path.join(root, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, source);
}

function countRows(db: DatabaseSync, table: string): number {
  return requireNumber(
    requireRow(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()),
    'count',
  );
}

function indexCounts(dbPath: string): IndexCounts {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      symbols: countRows(db, 'symbols'),
      symbolFts: countRows(db, 'symbol_fts'),
      fragmentFts: countRows(db, 'symbol_fragment_fts'),
    };
  } finally {
    db.close();
  }
}

function symbolIdFor(dbPath: string, qualifiedName: string): string {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare('SELECT id FROM symbols WHERE qualified_name = ?')
      .get(qualifiedName);
    return requireString(requireRow(row), 'id');
  } finally {
    db.close();
  }
}

function symbolsInFile(dbPath: string, relativePath: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return requireNumber(
      requireRow(
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM symbols s
             JOIN files f ON f.id = s.file_id WHERE f.relative_path = ?`,
          )
          .get(relativePath),
      ),
      'count',
    );
  } finally {
    db.close();
  }
}

function indexedRowsFor(dbPath: string, symbolId: string): IndexedSymbolRows {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const countFor = (table: string): number =>
      requireNumber(
        requireRow(
          db
            .prepare(
              `SELECT COUNT(*) AS count FROM ${table} WHERE symbol_id = ?`,
            )
            .get(symbolId),
        ),
        'count',
      );
    return {
      symbolFts: countFor('symbol_fts'),
      fragmentFts: countFor('symbol_fragment_fts'),
    };
  } finally {
    db.close();
  }
}

function expectIndexCountsToMatchSymbols(dbPath: string): IndexCounts {
  const counts = indexCounts(dbPath);
  expect(counts.symbolFts).toBe(counts.symbols);
  expect(counts.fragmentFts).toBe(counts.symbols);
  return counts;
}

function isUnqualifiedFullFtsRefresh(sql: string): boolean {
  const statement = sql.replace(new RegExp('\\s+', 'gu'), ' ').trim();
  const unqualifiedDelete = new RegExp(
    '^DELETE\\s+FROM\\s+(?:MAIN\\.)?SYMBOL_(?:FRAGMENT_)?FTS\\s*;?$',
    'iu',
  ).test(statement);
  const unfilteredInsert =
    new RegExp(
      '^INSERT\\s+INTO\\s+(?:MAIN\\.)?SYMBOL_(?:FRAGMENT_)?FTS\\b.*\\bSELECT\\b.*\\bFROM\\s+SYMBOLS\\b',
      'iu',
    ).test(statement) && !new RegExp('\\bWHERE\\b', 'iu').test(statement);
  const fts5Rebuild = new RegExp(
    '^INSERT\\s+INTO\\s+(?:MAIN\\.)?SYMBOL_(?:FRAGMENT_)?FTS\\s*\\(\\s*SYMBOL_(?:FRAGMENT_)?FTS\\s*\\)\\s*VALUES\\s*\\(\\s*[\'"]REBUILD[\'"]\\s*\\)',
    'iu',
  ).test(statement);
  return unqualifiedDelete || unfilteredInsert || fts5Rebuild;
}

describe('CodeGraphEngine selective FTS maintenance', () => {
  it('updates changed symbol indexes without a full rebuild and matches a cold search', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'code-graph-selective-fts-'));
    const dbPath = path.join(root, '.graph', 'graph.db');
    let engine: CodeGraphEngine | null = null;
    let coldEngine: CodeGraphEngine | null = null;

    try {
      putSource(
        root,
        'src/edited.ts',
        `export function beforeEdit(): string { return 'before'; }\n`,
      );
      putSource(
        root,
        'src/renamed-before.ts',
        `export function loadRetainedPanel(): string { return 'kept'; }\n`,
      );
      putSource(
        root,
        'src/deleted.ts',
        `export function retiredPreview(): string { return 'retired'; }\n`,
      );
      putSource(
        root,
        'src/search-index.ts',
        `export function rebuildDashboard(): string { return 'exact'; }
export function rebuildDashboardPanel(): string { return 'prefix'; }
export function getWorkspaceCard(): string { return 'token'; }
export function getDashboardBoardCard(): string { return 'fragment'; }
export function créerFacture(): string { return 'accent'; }
export function 处理订单(): string { return 'unicode'; }
`,
      );

      const activeEngine = await CodeGraphEngine.open({
        dbPath,
        repositories: [{ repoId: REPO_ID, rootPath: root }],
      });
      engine = activeEngine;
      await activeEngine.buildOrUpdate();
      const initialCounts = expectIndexCountsToMatchSymbols(dbPath);
      const editedId = symbolIdFor(dbPath, 'src/edited.ts::beforeEdit');
      const renamedId = symbolIdFor(
        dbPath,
        'src/renamed-before.ts::loadRetainedPanel',
      );
      const deletedId = symbolIdFor(dbPath, 'src/deleted.ts::retiredPreview');
      for (const symbolId of [editedId, renamedId, deletedId]) {
        expect(indexedRowsFor(dbPath, symbolId)).toEqual({
          symbolFts: 1,
          fragmentFts: 1,
        });
      }

      // Jest's SQLite spies retain their default call-through behavior. They
      // observe the real incremental builds and flag whole-table FTS refreshes.
      const replaceObserver = jest.spyOn(
        symbolFtsStore,
        'replaceSymbolFtsForFiles',
      );
      const execObserver = jest.spyOn(DatabaseSync.prototype, 'exec');
      const prepareObserver = jest.spyOn(DatabaseSync.prototype, 'prepare');
      let fullRefreshStatements: string[] = [];
      try {
        replaceObserver.mockClear();
        putSource(
          root,
          'src/edited.ts',
          `export function afterEdit(): string { return 'after'; }\n`,
        );
        await activeEngine.buildOrUpdate();
        // The file-fact writer owns one final projection. A trusted engine
        // must not issue a duplicate selective replacement after that write.
        expect(replaceObserver).toHaveBeenCalledTimes(1);
        expect(replaceObserver).toHaveBeenCalledWith(expect.anything(), [
          fileRowId(REPO_ID, 'src/edited.ts'),
        ]);
        const afterEdit = expectIndexCountsToMatchSymbols(dbPath);
        expect(afterEdit.symbols).toBe(initialCounts.symbols);
        expect(indexedRowsFor(dbPath, editedId)).toEqual({
          symbolFts: 0,
          fragmentFts: 0,
        });
        expect(
          indexedRowsFor(
            dbPath,
            symbolIdFor(dbPath, 'src/edited.ts::afterEdit'),
          ),
        ).toEqual({ symbolFts: 1, fragmentFts: 1 });

        renameSync(
          path.join(root, 'src/renamed-before.ts'),
          path.join(root, 'src/renamed-after.ts'),
        );
        await activeEngine.buildOrUpdate();
        const afterRename = expectIndexCountsToMatchSymbols(dbPath);
        expect(afterRename.symbols).toBe(afterEdit.symbols);
        expect(indexedRowsFor(dbPath, renamedId)).toEqual({
          symbolFts: 0,
          fragmentFts: 0,
        });
        expect(
          indexedRowsFor(
            dbPath,
            symbolIdFor(dbPath, 'src/renamed-after.ts::loadRetainedPanel'),
          ),
        ).toEqual({ symbolFts: 1, fragmentFts: 1 });

        const removedFileSymbolCount = symbolsInFile(dbPath, 'src/deleted.ts');
        expect(removedFileSymbolCount).toBeGreaterThan(0);
        unlinkSync(path.join(root, 'src/deleted.ts'));
        await activeEngine.buildOrUpdate();
        const afterDeletion = expectIndexCountsToMatchSymbols(dbPath);
        expect(afterDeletion.symbols).toBe(
          afterRename.symbols - removedFileSymbolCount,
        );
        expect(indexedRowsFor(dbPath, deletedId)).toEqual({
          symbolFts: 0,
          fragmentFts: 0,
        });
        expect(
          activeEngine.queries().search('retiredPreview', 10, REPO_ID),
        ).toEqual([]);

        fullRefreshStatements = [
          ...execObserver.mock.calls.map(([sql]): string => sql),
          ...prepareObserver.mock.calls.map(([sql]): string => sql),
        ].filter(isUnqualifiedFullFtsRefresh);
      } finally {
        execObserver.mockRestore();
        prepareObserver.mockRestore();
        replaceObserver.mockRestore();
      }
      expect(fullRefreshStatements).toEqual([]);

      const independentColdEngine = await CodeGraphEngine.open({
        dbPath: path.join(root, '.cold', 'graph.db'),
        repositories: [{ repoId: REPO_ID, rootPath: root }],
      });
      coldEngine = independentColdEngine;
      await independentColdEngine.buildOrUpdate();
      expectIndexCountsToMatchSymbols(path.join(root, '.cold', 'graph.db'));

      const searchCases: SearchCase[] = [
        {
          query: 'rebuildDashboard',
          expectedName: 'rebuildDashboard',
          expectedKind: 'exact',
        },
        {
          query: 'rebuildDash',
          expectedName: 'rebuildDashboard',
          expectedKind: 'prefix',
        },
        {
          query: 'search',
          expectedName: 'getWorkspaceCard',
          expectedKind: 'token-prefix',
        },
        {
          query: 'boardcard',
          expectedName: 'getDashboardBoardCard',
          expectedKind: 'fragment',
        },
        {
          query: 'ÉER',
          expectedName: 'créerFacture',
          expectedKind: 'fragment',
        },
        {
          query: '处理订单',
          expectedName: '处理订单',
          expectedKind: 'exact',
        },
      ];
      for (const searchCase of searchCases) {
        const incrementalHits = activeEngine
          .queries()
          .search(searchCase.query, 10, REPO_ID);
        const coldHits = independentColdEngine
          .queries()
          .search(searchCase.query, 10, REPO_ID);
        expect(incrementalHits).toEqual(coldHits);
        expect(
          incrementalHits.find((hit) => hit.name === searchCase.expectedName),
        ).toMatchObject({
          name: searchCase.expectedName,
          matchKind: searchCase.expectedKind,
        });
      }
      expect(
        activeEngine.queries().search('rebuildDashboard', 1, REPO_ID),
      ).toEqual(
        independentColdEngine.queries().search('rebuildDashboard', 1, REPO_ID),
      );
      expect(
        activeEngine.queries().search('rebuildDashboard', 1, REPO_ID)[0]?.name,
      ).toBe('rebuildDashboard');
    } finally {
      coldEngine?.close();
      engine?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('repairs a still-untrusted mapping once on an otherwise unchanged build', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'code-graph-untrusted-fts-'));
    const dbPath = path.join(root, '.graph', 'graph.db');
    let engine: CodeGraphEngine | null = null;
    const rebuildObserver = jest.spyOn(symbolFtsStore, 'rebuildSymbolFts');
    try {
      putSource(
        root,
        'src/unchanged.ts',
        'export function unchangedFact(): string { return "same"; }\n',
      );
      engine = await CodeGraphEngine.open({
        dbPath,
        repositories: [{ repoId: REPO_ID, rootPath: root }],
      });
      await engine.buildOrUpdate();
      const db = openCodeGraphDatabase(dbPath);
      try {
        const factsBefore = db
          .prepare('SELECT id, signature FROM symbols ORDER BY id')
          .all();
        setMetadataValue(
          db,
          'symbol_fts_mapping_version',
          'deliberately-stale',
        );
        rebuildObserver.mockClear();
        const result = await engine.buildOrUpdate();
        expect(result.factsChanged).toBe(false);
        expect(result.filesParsed).toBe(0);
        expect(rebuildObserver).toHaveBeenCalledTimes(1);
        expect(
          db.prepare('SELECT id, signature FROM symbols ORDER BY id').all(),
        ).toEqual(factsBefore);
        expect(
          requireString(
            requireRow(
              db
                .prepare(
                  "SELECT value FROM graph_metadata WHERE key = 'symbol_fts_mapping_version'",
                )
                .get(),
            ),
            'value',
          ),
        ).toBe('5:rowid-v1');
      } finally {
        db.close();
      }
    } finally {
      rebuildObserver.mockRestore();
      engine?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
