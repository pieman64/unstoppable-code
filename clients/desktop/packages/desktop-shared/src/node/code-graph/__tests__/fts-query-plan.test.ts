import { copyFileSync } from 'node:fs';
import * as path from 'node:path';
import type { CodeGraphFileFacts } from '../../../types/code-graph';
import {
  fileRowId,
  repositoryRowId,
  symbolQualifiedName,
  symbolRowId,
} from '../ids';
import {
  openCodeGraphDatabase,
  requireRow,
  withImmediateTransaction,
  type CodeGraphDatabase,
} from '../store/database';
import { rebuildSymbolFts, searchSymbolFts } from '../store/fts';
import { CodeGraphStore } from '../store/graph-store';
import {
  buildRealisticFixtureGraph,
  oracleSearchSymbolFts,
  queryPlan,
  recordingDatabase,
  useSchemaV3Indexes,
  type RealisticFixtureGraph,
} from './query-plan-fixture';

// Names that stress case folding, Unicode and LIKE metacharacters. Code
// never declares most of these, but the store accepts any name.
const EXTRA_NAMES = [
  'MixedCase',
  'mixedcase',
  'MIXEDCASE',
  'mixedCaseLonger',
  'Ünïcode',
  'ünïcodeLower',
  'ÉCLAIR',
  'éclair',
  'straße',
  'STRASSE',
  'my_var',
  'myXvar',
  'my%var',
  'myvar',
  'back\\slash',
  'backXslash',
  '_leading',
  'trailing_',
];

function extraFacts(
  repoId: string,
  name: string,
  index: number,
): CodeGraphFileFacts {
  const relativePath = `extra/name-${index}.ts`;
  const fileId = fileRowId(repoId, relativePath);
  return {
    file: {
      id: fileId,
      repositoryId: repoId,
      relativePath,
      absolutePath: `/abs/${relativePath}`,
      language: 'typescript',
      contentHash: 'h',
      sizeBytes: 1,
      mtimeNs: '1',
      lineCount: 1,
      grammarId: 'typescript',
      grammarAbi: 14,
      parseStatus: 'parsed',
      hasErrors: false,
      updatedAt: 1,
    },
    symbols: [
      {
        id: symbolRowId(repoId, symbolQualifiedName(relativePath, [], name)),
        repositoryId: repoId,
        fileId,
        kind: 'function',
        name,
        qualifiedName: symbolQualifiedName(relativePath, [], name),
        parentSymbolId: null,
        lineStart: 1,
        lineEnd: 1,
        byteStart: 0,
        byteEnd: 1,
        signature: null,
        exported: true,
        isTest: false,
        extra: {},
      },
    ],
    edges: [],
  };
}

const QUERIES = [
  'CodeGraphStore',
  'codegraphstore',
  'CODEGRAPH',
  'requireRow',
  'require',
  'run',
  'Run',
  'build or',
  'graph-store',
  'MixedCase',
  'mixed',
  'Ünï',
  'ünï',
  'ÜNÏ',
  'éclair',
  'ÉCL',
  'éCL',
  'straß',
  'STRASSE',
  'my_',
  'my_var',
  'my%',
  'myX',
  'back\\',
  'back\\slash',
  '_',
  '__',
  'trailing_',
  'x',
  'zzzNoSuchSymbol',
];

describe('symbol search exact/prefix query plan (phase 18)', () => {
  let fixture: RealisticFixtureGraph;
  let v3DbPath: string;
  let db: CodeGraphDatabase;
  let v3Db: CodeGraphDatabase;

  beforeAll(async () => {
    fixture = await buildRealisticFixtureGraph(['fixture', 'mirror']);
    const writer = openCodeGraphDatabase(fixture.dbPath);
    try {
      const store = new CodeGraphStore(writer);
      for (const repoId of ['fixture', 'mirror']) {
        EXTRA_NAMES.forEach((name, index) => {
          store.replaceFileFacts(extraFacts(repoId, name, index));
        });
      }
      rebuildSymbolFts(writer);
      writer.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } finally {
      writer.close();
    }
    v3DbPath = path.join(path.dirname(fixture.dbPath), 'graph-v3.db');
    copyFileSync(fixture.dbPath, v3DbPath);
    v3Db = openCodeGraphDatabase(v3DbPath);
    useSchemaV3Indexes(v3Db);
    db = openCodeGraphDatabase(fixture.dbPath);
  }, 120_000);

  afterAll(() => {
    db.close();
    v3Db.close();
    fixture.cleanup();
  });

  it('seeks the NOCASE name index for exact and prefix matches instead of scanning symbols', () => {
    for (const query of ['CodeGraphStore', 'codegraphstore', 'runCodeGraph']) {
      for (const repoId of [undefined, 'fixture']) {
        const recorder = recordingDatabase(db);
        searchSymbolFts(recorder.db, query, 20, repoId);
        const priority = recorder.executed.find((statement) =>
          statement.sql.includes('COLLATE NOCASE OR'),
        );
        if (priority === undefined) throw new Error('no exact/prefix query');
        const plan = queryPlan(db, priority.sql, priority.params);
        expect(plan).toEqual(
          expect.arrayContaining([
            expect.stringMatching(
              /^SEARCH s USING INDEX idx_symbols_name_nocase \(name>\? AND name<\?\)$/,
            ),
          ]),
        );
        expect(plan.filter((detail) => /^SCAN s\b/.test(detail))).toEqual([]);
      }
    }
  });

  it('uses both mapping indexes and mapped rowid SELECT/DELETE plans for both FTS tables', () => {
    const fileId = fileRowId('fixture', 'store/graph-store.ts');
    const repositoryId = repositoryRowId('fixture');
    const filePlan = queryPlan(
      db,
      'SELECT symbol_id FROM symbol_fts_rows WHERE file_id = ?',
      [fileId],
    );
    const repositoryPlan = queryPlan(
      db,
      'SELECT symbol_id FROM symbol_fts_rows WHERE repository_id = ?',
      [repositoryId],
    );
    expect(filePlan.join(' ')).toContain('idx_symbol_fts_rows_file');
    expect(repositoryPlan.join(' ')).toContain(
      'idx_symbol_fts_rows_repository',
    );

    const mapping = requireRow(
      db
        .prepare(
          `SELECT symbol_fts_rowid, fragment_fts_rowid
           FROM symbol_fts_rows WHERE file_id = ? ORDER BY symbol_id LIMIT 1`,
        )
        .get(fileId),
    );
    const mappedRowids: Array<[string, number]> = [
      ['symbol_fts', Number(mapping.symbol_fts_rowid)],
      ['symbol_fragment_fts', Number(mapping.fragment_fts_rowid)],
    ];
    for (const [table, rowid] of mappedRowids) {
      const selectSql = `SELECT rowid FROM ${table} WHERE rowid = ?`;
      const deleteSql = `DELETE FROM ${table} WHERE rowid = ?`;
      const selectPlan = queryPlan(db, selectSql, [rowid]);
      const deletePlan = queryPlan(db, deleteSql, [rowid]);
      // SQLite reports constrained FTS5 rowid access with a SCAN label too;
      // require its virtual-table rowid constraint instead of banning SCAN.
      expect(selectPlan.join(' ')).toMatch(
        new RegExp('VIRTUAL TABLE INDEX\\s+\\d+:[^\\s]*=', 'iu'),
      );
      expect(deletePlan.join(' ')).toMatch(
        new RegExp('VIRTUAL TABLE INDEX\\s+\\d+:[^\\s]*=', 'iu'),
      );
      expect(Number(requireRow(db.prepare(selectSql).get(rowid)).rowid)).toBe(
        rowid,
      );
      // Execute the actual prepared DELETE under a rollback so the plan check
      // proves both primary and fragment rowid deletes are valid and bounded.
      expect(() =>
        withImmediateTransaction(db, () => {
          db.prepare(deleteSql).run(rowid);
          throw new Error('rollback mapped rowid delete');
        }),
      ).toThrow('rollback mapped rowid delete');
      expect(Number(requireRow(db.prepare(selectSql).get(rowid)).rowid)).toBe(
        rowid,
      );
    }
  });

  it('returns exactly the pre-phase-18 results, in order, for every query, scope and limit', () => {
    let compared = 0;
    for (const query of QUERIES) {
      for (const repoId of [undefined, 'fixture', 'mirror']) {
        for (const limit of [1, 5, 20, 500]) {
          const expected = oracleSearchSymbolFts(v3Db, query, limit, repoId);
          expect({
            query,
            repoId,
            limit,
            results: searchSymbolFts(db, query, limit, repoId),
          }).toEqual({
            query,
            repoId,
            limit,
            results: expected,
          });
          // An unmigrated (schema v3) graph answers identically too.
          expect(searchSymbolFts(v3Db, query, limit, repoId)).toEqual(expected);
          compared += expected.length;
        }
      }
    }
    // The matrix is not vacuous.
    expect(compared).toBeGreaterThan(1_000);
    expect(searchSymbolFts(db, 'mixedcase', 20).map((hit) => hit.name)).toEqual(
      expect.arrayContaining(['MixedCase', 'mixedcase', 'MIXEDCASE']),
    );
  });
});
