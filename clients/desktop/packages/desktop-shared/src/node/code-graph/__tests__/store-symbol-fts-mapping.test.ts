import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { CodeGraphEngine } from '../engine';
import {
  getMetadataValue,
  openCodeGraphDatabase,
  requireNumber,
  requireRow,
  setMetadataValue,
  withImmediateTransaction,
  type CodeGraphDatabase,
  type CodeGraphSqlValue,
  type CodeGraphStatement,
} from '../store/database';
import { runCodeGraphMigrations } from '../store/migrations';
import {
  deleteSymbolFtsForFiles,
  isSymbolFtsMappingTrusted,
  rebuildSymbolFts,
  searchSymbolFts,
  replaceSymbolFtsForFiles,
} from '../store/fts';
import { repositoryRowId } from '../ids';
import { CodeGraphStore } from '../store/graph-store';

const REPO_ID = 'w1-store-contract';

function count(
  db: CodeGraphDatabase,
  sql: string,
  ...params: CodeGraphSqlValue[]
): number {
  return requireNumber(requireRow(db.prepare(sql).get(...params)), 'n');
}

function details(
  db: CodeGraphDatabase,
  sql: string,
  ...params: CodeGraphSqlValue[]
): string[] {
  return db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((value) => String(requireRow(value).detail));
}

describe('W1 mapped FTS store integration contract', () => {
  it('uses the exact v5 mapping schema and trusts only the exact marker/version pair', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'code-graph-w1-map-schema-'));
    const db = openCodeGraphDatabase(path.join(root, 'graph.db'));
    try {
      runCodeGraphMigrations(db);
      expect(getMetadataValue(db, 'schema_version')).toBe('5');
      expect(isSymbolFtsMappingTrusted(db)).toBe(false);
      expect(getMetadataValue(db, 'symbol_fts_mapping_version')).toBeNull();
      const columns = db
        .prepare('PRAGMA table_info(symbol_fts_rows)')
        .all()
        .map((value) => {
          const row = requireRow(value);
          return [
            String(row.name),
            String(row.type).toUpperCase(),
            Number(row.notnull),
            Number(row.pk),
          ];
        });
      expect(columns).toEqual([
        ['symbol_id', 'TEXT', 0, 1],
        ['file_id', 'TEXT', 1, 0],
        ['repository_id', 'TEXT', 1, 0],
        ['symbol_fts_rowid', 'INTEGER', 1, 0],
        ['fragment_fts_rowid', 'INTEGER', 1, 0],
      ]);
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all()
        .map((value) => String(requireRow(value).name));
      expect(indexes).toEqual(
        expect.arrayContaining([
          'idx_symbol_fts_rows_file',
          'idx_symbol_fts_rows_repository',
        ]),
      );

      setMetadataValue(db, 'symbol_fts_mapping_version', 'wrong');
      expect(isSymbolFtsMappingTrusted(db)).toBe(false);
      setMetadataValue(db, 'symbol_fts_mapping_version', '5:rowid-v1');
      setMetadataValue(db, 'schema_version', '4');
      expect(isSymbolFtsMappingTrusted(db)).toBe(false);
      setMetadataValue(db, 'schema_version', '5');
      expect(isSymbolFtsMappingTrusted(db)).toBe(true);
      rebuildSymbolFts(db);
      expect(getMetadataValue(db, 'symbol_fts_mapping_version')).toBe(
        '5:rowid-v1',
      );
      expect(isSymbolFtsMappingTrusted(db)).toBe(true);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('upgrades v4 facts without trusting a missing mapping until full repair', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'code-graph-w1-map-upgrade-'));
    const dbPath = path.join(root, '.graph', 'graph.db');
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(
      path.join(root, 'src', 'legacy.ts'),
      'export function legacyIndex(): string { return "fact"; }\n',
    );
    let engine: CodeGraphEngine | null = null;
    try {
      engine = await CodeGraphEngine.open({
        dbPath,
        repositories: [{ repoId: REPO_ID, rootPath: root }],
      });
      await engine.buildOrUpdate();
      engine.close();
      engine = null;
      const db = openCodeGraphDatabase(dbPath);
      try {
        const factsBefore = count(db, 'SELECT COUNT(*) AS n FROM symbols');
        db.exec('DROP TABLE symbol_fts_rows');
        db.prepare(
          "DELETE FROM graph_metadata WHERE key = 'symbol_fts_mapping_version'",
        ).run();
        setMetadataValue(db, 'schema_version', '4');
        runCodeGraphMigrations(db);
        expect(getMetadataValue(db, 'schema_version')).toBe('5');
        expect(count(db, 'SELECT COUNT(*) AS n FROM symbols')).toBe(
          factsBefore,
        );
        expect(isSymbolFtsMappingTrusted(db)).toBe(false);
        rebuildSymbolFts(db);
        expect(isSymbolFtsMappingTrusted(db)).toBe(true);
      } finally {
        db.close();
      }
    } finally {
      engine?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('repairs a mapping spanning multiple 256-symbol keyset pages', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'code-graph-w1-map-pages-'));
    const dbPath = path.join(root, '.graph', 'graph.db');
    mkdirSync(path.join(root, 'src'), { recursive: true });
    const declarations = Array.from(
      { length: 600 },
      (_value, index) =>
        `export function pageSymbol${index}(): number { return ${index}; }`,
    ).join('\n');
    writeFileSync(path.join(root, 'src', 'pages.ts'), declarations);
    let engine: CodeGraphEngine | null = null;
    try {
      engine = await CodeGraphEngine.open({
        dbPath,
        repositories: [{ repoId: REPO_ID, rootPath: root }],
      });
      await engine.buildOrUpdate();
      const db = openCodeGraphDatabase(dbPath);
      try {
        const selectiveResults = [1, 5, 20, 500, 900].map((limit) =>
          searchSymbolFts(db, 'pageSymbol', limit, REPO_ID),
        );
        expect(selectiveResults.map((hits) => hits.length)).toEqual([
          1, 5, 20, 500, 500,
        ]);
        // Force the full helper path rather than counting the initial
        // file-scoped store projection as coverage for keyset rebuild pages.
        setMetadataValue(db, 'symbol_fts_mapping_version', 'stale');
        expect(isSymbolFtsMappingTrusted(db)).toBe(false);
        rebuildSymbolFts(db);
        expect(
          [1, 5, 20, 500, 900].map((limit) =>
            searchSymbolFts(db, 'pageSymbol', limit, REPO_ID),
          ),
        ).toEqual(selectiveResults);
        const symbolCount = count(db, 'SELECT COUNT(*) AS n FROM symbols');
        expect(symbolCount).toBeGreaterThan(256);
        expect(count(db, 'SELECT COUNT(*) AS n FROM symbol_fts_rows')).toBe(
          symbolCount,
        );
        expect(
          count(
            db,
            `SELECT COUNT(*) AS n FROM symbols s
             JOIN symbol_fts_rows m ON m.symbol_id = s.id
             JOIN symbol_fts f ON f.rowid = m.symbol_fts_rowid
             JOIN symbol_fragment_fts x ON x.rowid = m.fragment_fts_rowid`,
          ),
        ).toBe(symbolCount);
        expect(isSymbolFtsMappingTrusted(db)).toBe(true);
      } finally {
        db.close();
      }
    } finally {
      engine?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses both mapping indexes and bounded mapped rowid lookups, not an unindexed FTS scan', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'code-graph-w1-map-plan-'));
    const dbPath = path.join(root, '.graph', 'graph.db');
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(
      path.join(root, 'src', 'plan.ts'),
      'export function indexedMappingProbe(): string { return "probe"; }\n',
    );
    let engine: CodeGraphEngine | null = null;
    try {
      engine = await CodeGraphEngine.open({
        dbPath,
        repositories: [{ repoId: REPO_ID, rootPath: root }],
      });
      await engine.buildOrUpdate();
      const db = openCodeGraphDatabase(dbPath);
      try {
        const fileId = String(
          requireRow(
            db
              .prepare('SELECT id FROM files WHERE relative_path = ?')
              .get('src/plan.ts'),
          ).id,
        );
        const repositoryId = repositoryRowId(REPO_ID);
        const filePlan = details(
          db,
          'SELECT symbol_id FROM symbol_fts_rows WHERE file_id = ?',
          fileId,
        );
        const repoPlan = details(
          db,
          'SELECT symbol_id FROM symbol_fts_rows WHERE repository_id = ?',
          repositoryId,
        );
        expect(filePlan.join(' ')).toContain('idx_symbol_fts_rows_file');
        expect(repoPlan.join(' ')).toContain('idx_symbol_fts_rows_repository');
        for (const deleteSql of [
          `DELETE FROM symbol_fts WHERE rowid IN (
             SELECT symbol_fts_rowid FROM symbol_fts_rows WHERE repository_id = ?
           )`,
          `DELETE FROM symbol_fragment_fts WHERE rowid IN (
             SELECT fragment_fts_rowid FROM symbol_fts_rows WHERE repository_id = ?
           )`,
        ]) {
          const plan = details(db, deleteSql, repositoryId).join(' ');
          expect(plan).toContain('idx_symbol_fts_rows_repository');
          expect(plan).toMatch(
            new RegExp('VIRTUAL TABLE INDEX\\s+\\d+:[^\\s]*=', 'iu'),
          );
        }

        for (const column of ['symbol_fts_rowid', 'fragment_fts_rowid']) {
          const allocationPlan = details(
            db,
            `SELECT COALESCE(MAX(${column}), 0) + 1 FROM symbol_fts_rows`,
          ).join(' ');
          expect(allocationPlan).toMatch(
            new RegExp('SEARCH symbol_fts_rows USING COVERING INDEX', 'iu'),
          );
          expect(allocationPlan).not.toMatch(
            new RegExp('SCAN symbol_fts_rows', 'iu'),
          );
        }
        const row = requireRow(
          db
            .prepare(
              `SELECT symbol_fts_rowid, fragment_fts_rowid
               FROM symbol_fts_rows WHERE file_id = ? ORDER BY symbol_id LIMIT 1`,
            )
            .get(fileId),
        );
        const mappedRowids: Array<[string, number]> = [
          ['symbol_fts', Number(row.symbol_fts_rowid)],
          ['symbol_fragment_fts', Number(row.fragment_fts_rowid)],
        ];
        for (const [table, rowid] of mappedRowids) {
          const selectSql = `SELECT rowid FROM ${table} WHERE rowid = ?`;
          const deleteSql = `DELETE FROM ${table} WHERE rowid = ?`;
          const selectPlan = details(db, selectSql, rowid);
          const deletePlan = details(db, deleteSql, rowid);
          // FTS5 may label a rowid-constrained virtual-table access as SCAN;
          // require the rowid constraint rather than rejecting that word.
          expect(selectPlan.join(' ')).toMatch(
            new RegExp('VIRTUAL TABLE INDEX\\s+\\d+:[^\\s]*=', 'iu'),
          );
          expect(deletePlan.join(' ')).toMatch(
            new RegExp('VIRTUAL TABLE INDEX\\s+\\d+:[^\\s]*=', 'iu'),
          );
          expect(
            Number(requireRow(db.prepare(selectSql).get(rowid)).rowid),
          ).toBe(rowid);
          expect(() =>
            withImmediateTransaction(db, () => {
              db.prepare(deleteSql).run(rowid);
              throw new Error('rollback mapped rowid delete');
            }),
          ).toThrow('rollback mapped rowid delete');
          expect(
            Number(requireRow(db.prepare(selectSql).get(rowid)).rowid),
          ).toBe(rowid);
        }

        expect(isSymbolFtsMappingTrusted(db)).toBe(true);
        expect(count(db, 'SELECT COUNT(*) AS n FROM symbol_fts_rows')).toBe(
          count(
            db,
            `SELECT COUNT(*) AS n FROM symbols s
             JOIN symbol_fts f ON f.symbol_id = s.id
             JOIN symbol_fragment_fts x ON x.symbol_id = s.id`,
          ),
        );
        replaceSymbolFtsForFiles(db, [fileId]);
        expect(
          count(
            db,
            'SELECT COUNT(*) AS n FROM symbol_fts_rows WHERE file_id = ?',
            fileId,
          ),
        ).toBeGreaterThan(0);
        replaceSymbolFtsForFiles(db, [fileId]);
        expect(
          count(
            db,
            'SELECT COUNT(*) AS n FROM symbol_fts_rows WHERE file_id = ?',
            fileId,
          ),
        ).toBeGreaterThan(0);

        const oldSymbolId = String(
          requireRow(
            db
              .prepare('SELECT id FROM symbols WHERE file_id = ? LIMIT 1')
              .get(fileId),
          ).id,
        );
        // Exercise the direct store delete: it must capture old symbol IDs and
        // mapped rowids before facts disappear, within the caller's transaction.
        const store = new CodeGraphStore(db);
        withImmediateTransaction(db, () => {
          store.removeFiles(REPO_ID, ['src/plan.ts']);
        });
        expect(
          count(
            db,
            'SELECT COUNT(*) AS n FROM symbol_fts_rows WHERE file_id = ?',
            fileId,
          ),
        ).toBe(0);
        for (const table of ['symbol_fts', 'symbol_fragment_fts']) {
          expect(
            count(
              db,
              `SELECT COUNT(*) AS n FROM ${table} WHERE symbol_id = ?`,
              oldSymbolId,
            ),
          ).toBe(0);
        }
        // The exact two-argument delete helper is idempotent after the store
        // writer's atomic removal; it takes file IDs, not a symbols payload.
        deleteSymbolFtsForFiles(db, [fileId]);
        expect(
          count(
            db,
            'SELECT COUNT(*) AS n FROM symbols WHERE file_id = ?',
            fileId,
          ),
        ).toBe(0);
        store.reconcileRepositories([]);
        expect(
          count(
            db,
            'SELECT COUNT(*) AS n FROM symbol_fts_rows WHERE repository_id = ?',
            repositoryRowId(REPO_ID),
          ),
        ).toBe(0);
        expect(count(db, 'SELECT COUNT(*) AS n FROM symbols')).toBe(0);
        expect(isSymbolFtsMappingTrusted(db)).toBe(true);
      } finally {
        db.close();
      }
    } finally {
      engine?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('repairs once before an untrusted standalone replacement and rolls back a failed FTS insertion', async () => {
    const root = mkdtempSync(
      path.join(tmpdir(), 'code-graph-w1-store-atomic-'),
    );
    const dbPath = path.join(root, '.graph', 'graph.db');
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(
      path.join(root, 'src', 'atomic.ts'),
      'export function atomicProbe(value: string): string { return value; }\n',
    );
    let engine: CodeGraphEngine | null = null;
    try {
      engine = await CodeGraphEngine.open({
        dbPath,
        repositories: [{ repoId: REPO_ID, rootPath: root }],
      });
      await engine.buildOrUpdate();
      const db = openCodeGraphDatabase(dbPath);
      try {
        let fullResets = 0;
        let failFragmentInsert = false;
        const observed: CodeGraphDatabase = {
          exec(sql): void {
            if (new RegExp('^DELETE FROM symbol_fts\\s*;?$', 'iu').test(sql))
              fullResets += 1;
            db.exec(sql);
          },
          prepare(sql): CodeGraphStatement {
            const statement = db.prepare(sql);
            return {
              all: (...params) => statement.all(...params),
              get: (...params) => statement.get(...params),
              run(...params): { changes: number | bigint } {
                if (
                  failFragmentInsert &&
                  new RegExp('^INSERT INTO symbol_fragment_fts\\b', 'iu').test(
                    sql,
                  )
                ) {
                  throw new Error('injected fragment insertion failure');
                }
                return statement.run(...params);
              },
            };
          },
          close: () => undefined,
        };
        const store = new CodeGraphStore(observed);
        const file = store.getFileByPath(REPO_ID, 'src/atomic.ts');
        if (file === null) throw new Error('atomic fixture file missing');
        const symbols = store.listSymbolsForFile(file.id);
        const replacement = {
          file: { ...file, contentHash: 'changed-signature' },
          symbols: symbols.map((symbol) => ({
            ...symbol,
            signature:
              symbol.signature === null
                ? null
                : symbol.signature.replace(/string/g, 'number'),
          })),
          edges: [],
        };
        setMetadataValue(db, 'symbol_fts_mapping_version', 'stale');
        store.replaceFileFacts(replacement);
        expect(fullResets).toBe(1);
        expect(isSymbolFtsMappingTrusted(db)).toBe(true);
        expect(
          store.listSymbolsForFile(file.id).map((symbol) => symbol.id),
        ).toEqual(symbols.map((symbol) => symbol.id));
        fullResets = 0;
        store.replaceFileFacts(replacement);
        expect(fullResets).toBe(0);

        const state = (): unknown[] => [
          db.prepare('SELECT * FROM files ORDER BY id').all(),
          db.prepare('SELECT * FROM symbols ORDER BY id').all(),
          db.prepare('SELECT * FROM edges ORDER BY id').all(),
          db.prepare('SELECT rowid, * FROM symbol_fts ORDER BY rowid').all(),
          db
            .prepare('SELECT rowid, * FROM symbol_fragment_fts ORDER BY rowid')
            .all(),
          db.prepare('SELECT * FROM symbol_fts_rows ORDER BY symbol_id').all(),
          getMetadataValue(db, 'symbol_fts_mapping_version'),
        ];
        const beforeFailure = state();
        failFragmentInsert = true;
        expect(() =>
          store.replaceFileFacts({
            ...replacement,
            file: { ...replacement.file, contentHash: 'must-rollback' },
          }),
        ).toThrow('injected fragment insertion failure');
        failFragmentInsert = false;
        expect(state()).toEqual(beforeFailure);

        setMetadataValue(db, 'symbol_fts_mapping_version', 'stale');
        const beforeFullFailure = state();
        failFragmentInsert = true;
        expect(() => rebuildSymbolFts(observed)).toThrow(
          'injected fragment insertion failure',
        );
        failFragmentInsert = false;
        expect(state()).toEqual(beforeFullFailure);
        expect(isSymbolFtsMappingTrusted(db)).toBe(false);
      } finally {
        db.close();
      }
    } finally {
      engine?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
