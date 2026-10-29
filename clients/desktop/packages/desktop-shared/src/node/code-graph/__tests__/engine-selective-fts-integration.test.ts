import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { isNativeError } from 'node:util/types';
import * as databaseStore from '../store/database';
import { CodeGraphEngine } from '../engine';
import {
  getMetadataValue,
  hasActiveCodeGraphWriteTransaction,
  openCodeGraphDatabase,
  requireNumber,
  requireRow,
  requireString,
  withImmediateTransaction,
  type CodeGraphDatabase,
  type CodeGraphStatement,
} from '../store/database';
import { CodeGraphStore } from '../store/graph-store';
import { repositoryRowId } from '../ids';
import * as symbolFtsStore from '../store/fts';
import { isSymbolFtsMappingTrusted } from '../store/fts';

const REPO_ID = 'w1-integration-draft';

function putSource(root: string, relativePath: string, source: string): void {
  const absolutePath = path.join(root, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, source);
}

function count(
  db: CodeGraphDatabase,
  sql: string,
  ...params: string[]
): number {
  return requireNumber(requireRow(db.prepare(sql).get(...params)), 'n');
}

type R1FaultKind = 'fragment' | 'sqlite-abort';

interface R1FaultProbe {
  attempts: number;
  failures: number;
  cause: unknown;
  atFailure: {
    ownedTransaction: boolean;
    primaryRows: number;
    fragmentRows: number;
    mappingRows: number;
    primarySymbolId: string;
    fragmentSymbolId: string | null;
    attemptedSymbolId: string;
  } | null;
  arm(): void;
  restore(): void;
}

// Wrap only the next open (the engine writer), delegating every operation to
// a real SQLite database/statement. Reader connections remain unwrapped. No
// fake DB, extractor stub, manual transaction or private engine field access.
function installR1Fault(kind: R1FaultKind): R1FaultProbe {
  let armed = false;
  const probe: R1FaultProbe = {
    attempts: 0,
    failures: 0,
    cause: undefined,
    atFailure: null,
    arm: (): void => {
      armed = true;
    },
    restore: (): void => undefined,
  };
  const realOpen = databaseStore.openCodeGraphDatabase;
  const observer = jest.spyOn(databaseStore, 'openCodeGraphDatabase');
  observer.mockImplementationOnce((dbPath) => {
    const db = realOpen(dbPath);
    const observed: CodeGraphDatabase = {
      exec: (sql): void => db.exec(sql),
      close: (): void => db.close(),
      prepare(sql): CodeGraphStatement {
        const statement = db.prepare(sql);
        return {
          all: (...params) => statement.all(...params),
          get: (...params) => statement.get(...params),
          run(...params): { changes: number | bigint } {
            const targeted =
              kind === 'fragment'
                ? /^INSERT INTO symbol_fragment_fts\b/iu.test(sql)
                : /^INSERT INTO symbol_fts_rows\b/iu.test(sql);
            if (!armed || !targeted) return statement.run(...params);
            probe.attempts += 1;
            if (probe.attempts !== 2) return statement.run(...params);
            // One shot: fallback writes must be allowed on unfixed production,
            // otherwise a repeated injected error would accidentally roll back
            // the buggy catch and make this test vacuously pass.
            armed = false;
            probe.failures += 1;
            const symbolId = kind === 'fragment' ? params[1] : params[0];
            if (typeof symbolId !== 'string') {
              throw new Error('R1 fault seam did not receive a symbol id');
            }
            const primary = requireRow(
              db
                .prepare('SELECT symbol_id FROM symbol_fts WHERE symbol_id = ?')
                .get(symbolId),
            );
            const fragment = db
              .prepare(
                'SELECT symbol_id FROM symbol_fragment_fts WHERE symbol_id = ?',
              )
              .get(symbolId);
            probe.atFailure = {
              ownedTransaction: hasActiveCodeGraphWriteTransaction(observed),
              primaryRows: count(db, 'SELECT COUNT(*) AS n FROM symbol_fts'),
              fragmentRows: count(
                db,
                'SELECT COUNT(*) AS n FROM symbol_fragment_fts',
              ),
              mappingRows: count(
                db,
                'SELECT COUNT(*) AS n FROM symbol_fts_rows',
              ),
              primarySymbolId: requireString(primary, 'symbol_id'),
              fragmentSymbolId:
                fragment === undefined
                  ? null
                  : requireString(requireRow(fragment), 'symbol_id'),
              attemptedSymbolId: symbolId,
            };
            if (kind === 'fragment') {
              const error = new Error('R1 second fragment insertion failed');
              probe.cause = error;
              throw error;
            }
            // SQLite forbids triggers on virtual FTS tables. Exercise a real
            // statement-level ABORT on the immediately following ordinary
            // mapping insert, after both second-symbol FTS rows were written.
            // Create/drop on the SAME writer, inside its existing transaction.
            db.exec(`CREATE TEMP TRIGGER r1_abort_mapping
              BEFORE INSERT ON main.symbol_fts_rows
              BEGIN SELECT RAISE(ABORT, 'R1 mapping insertion aborted'); END;`);
            try {
              return statement.run(...params);
            } catch (error) {
              probe.cause = error;
              throw error;
            } finally {
              db.exec('DROP TRIGGER temp.r1_abort_mapping;');
            }
          },
        };
      },
    };
    return observed;
  });
  probe.restore = (): void => observer.mockRestore();
  return probe;
}

function rawR1FtsState(db: CodeGraphDatabase): unknown[] {
  return [
    db.prepare('SELECT rowid, * FROM symbol_fts ORDER BY rowid').all(),
    db.prepare('SELECT rowid, * FROM symbol_fragment_fts ORDER BY rowid').all(),
    db.prepare('SELECT * FROM symbol_fts_rows ORDER BY symbol_id').all(),
    getMetadataValue(db, 'symbol_fts_mapping_version'),
  ];
}

function rawR1RollbackState(db: CodeGraphDatabase): unknown[] {
  return [
    db.prepare('SELECT * FROM files ORDER BY id').all(),
    db.prepare('SELECT * FROM symbols ORDER BY id').all(),
    db.prepare('SELECT * FROM edges ORDER BY id').all(),
    ...rawR1FtsState(db),
    // Includes build completion, trust version, summary/deferred/candidate and
    // timing markers; a failed attempt must publish none of those mutations.
    db.prepare('SELECT * FROM graph_metadata ORDER BY key').all(),
  ];
}

function expectR1FtsCoherent(db: CodeGraphDatabase): void {
  const symbols = count(db, 'SELECT COUNT(*) AS n FROM symbols');
  expect(symbols).toBeGreaterThan(0);
  for (const sql of [
    'SELECT COUNT(*) AS n FROM symbol_fts',
    'SELECT COUNT(*) AS n FROM symbol_fragment_fts',
    'SELECT COUNT(*) AS n FROM symbol_fts_rows',
  ])
    expect(count(db, sql)).toBe(symbols);
  expect(
    count(
      db,
      `SELECT COUNT(*) AS n FROM symbol_fts f
    LEFT JOIN symbol_fts_rows m
      ON m.symbol_fts_rowid = f.rowid AND m.symbol_id = f.symbol_id
    WHERE m.symbol_id IS NULL`,
    ),
  ).toBe(0);
  expect(
    count(
      db,
      `SELECT COUNT(*) AS n FROM symbol_fragment_fts f
    LEFT JOIN symbol_fts_rows m
      ON m.fragment_fts_rowid = f.rowid AND m.symbol_id = f.symbol_id
    WHERE m.symbol_id IS NULL`,
    ),
  ).toBe(0);
  expect(
    count(
      db,
      `SELECT COUNT(*) AS n FROM symbol_fts_rows m
    LEFT JOIN symbols s ON s.id = m.symbol_id
    LEFT JOIN files f ON f.id = m.file_id
    LEFT JOIN symbol_fts p ON p.rowid = m.symbol_fts_rowid AND p.symbol_id = m.symbol_id
    LEFT JOIN symbol_fragment_fts q ON q.rowid = m.fragment_fts_rowid AND q.symbol_id = m.symbol_id
    WHERE s.id IS NULL OR f.id IS NULL OR p.rowid IS NULL OR q.rowid IS NULL
      OR s.file_id <> m.file_id OR s.repository_id <> m.repository_id
      OR f.repository_id <> m.repository_id`,
    ),
  ).toBe(0);
  const rows = db
    .prepare(
      `SELECT s.name, s.qualified_name, COALESCE(s.signature, '') AS signature,
    f.relative_path, p.name AS primary_name, p.qualified_name AS primary_qualified_name,
    p.signature AS primary_signature, p.file_path, q.name_folded, q.qualified_name_folded
    FROM symbol_fts_rows m JOIN symbols s ON s.id = m.symbol_id
    JOIN files f ON f.id = m.file_id
    JOIN symbol_fts p ON p.rowid = m.symbol_fts_rowid
    JOIN symbol_fragment_fts q ON q.rowid = m.fragment_fts_rowid`,
    )
    .all();
  expect(rows).toHaveLength(symbols);
  for (const value of rows) {
    const row = requireRow(value);
    expect(row.primary_name).toBe(row.name);
    expect(row.primary_qualified_name).toBe(row.qualified_name);
    expect(row.primary_signature).toBe(row.signature);
    expect(row.file_path).toBe(row.relative_path);
    expect(row.name_folded).toBe(
      requireString(row, 'name').normalize('NFC').toLocaleLowerCase('en-US'),
    );
    expect(row.qualified_name_folded).toBe(
      requireString(row, 'qualified_name')
        .normalize('NFC')
        .toLocaleLowerCase('en-US'),
    );
  }
  // This marker check alone would miss R1; the raw bidirectional checks above
  // independently detect unmapped rows even when the version marker is trusted.
  expect(isSymbolFtsMappingTrusted(db)).toBe(true);
}

async function exerciseR1OwnedRollback(
  kind: R1FaultKind,
  relativePath: string,
  originalSource: string,
  changedSource: string,
): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'code-graph-r1-owned-'));
  const dbPath = path.join(root, '.graph', 'graph.db');
  let engine: CodeGraphEngine | null = null;
  const probe = installR1Fault(kind);
  const rebuildObserver = jest.spyOn(symbolFtsStore, 'rebuildSymbolFts');
  const replaceObserver = jest.spyOn(
    symbolFtsStore,
    'replaceSymbolFtsForFiles',
  );
  try {
    putSource(root, relativePath, originalSource);
    engine = await CodeGraphEngine.open({
      dbPath,
      repositories: [{ repoId: REPO_ID, rootPath: root }],
    });
    // Real default full-reset build; no W2/W3 option, injected extractor,
    // custom transaction, disabled analysis, or fake parser runtime.
    const baseline = await engine.buildOrUpdate();
    expect(baseline.filesScanned).toBe(1);
    expect(baseline.parseFailures).toBe(0);
    expect(baseline.symbolCount).toBe(2); // file + script/function
    let before: unknown[];
    let beforeFts: unknown[];
    const baselineDb = openCodeGraphDatabase(dbPath);
    try {
      expectR1FtsCoherent(baselineDb);
      before = rawR1RollbackState(baselineDb);
      beforeFts = rawR1FtsState(baselineDb);
    } finally {
      baselineDb.close();
    }
    rebuildObserver.mockClear();
    replaceObserver.mockClear();
    putSource(root, relativePath, changedSource);
    probe.arm();
    let buildError: unknown;
    try {
      await engine.buildOrUpdate({ verifyContent: true });
    } catch (error) {
      buildError = error;
    }
    expect(probe.attempts).toBe(2);
    expect(probe.failures).toBe(1);
    expect(isNativeError(probe.cause)).toBe(true);
    expect(probe.atFailure).not.toBeNull();
    if (probe.atFailure === null) throw new Error('R1 fault was not exercised');
    expect(probe.atFailure.ownedTransaction).toBe(true);
    expect(probe.atFailure.primaryRows).toBe(2);
    expect(probe.atFailure.fragmentRows).toBe(kind === 'fragment' ? 1 : 2);
    expect(probe.atFailure.mappingRows).toBe(1); // first full insertion reached SQLite
    expect(probe.atFailure.primarySymbolId).toBe(
      probe.atFailure.attemptedSymbolId,
    );
    expect(probe.atFailure.fragmentSymbolId).toBe(
      kind === 'fragment' ? null : probe.atFailure.attemptedSymbolId,
    );
    expect(probe.cause).toEqual(
      expect.objectContaining({
        message:
          kind === 'fragment'
            ? 'R1 second fragment insertion failed'
            : 'R1 mapping insertion aborted',
      }),
    );
    // Intended RED on unfixed non-code production: it resolves instead of
    // rejecting, after downgrading valid extracted facts to a failed file.
    expect(buildError).toBe(probe.cause);
    expect(replaceObserver).toHaveBeenCalledTimes(1);
    expect(rebuildObserver).not.toHaveBeenCalled();
    const failedDb = openCodeGraphDatabase(dbPath);
    try {
      expect(rawR1RollbackState(failedDb)).toEqual(before);
      expectR1FtsCoherent(failedDb);
    } finally {
      failedDb.close();
    }

    // Restore source and force hash verification: an unchanged build must not
    // silently depend on a full FTS repair to recover the failed attempt.
    replaceObserver.mockClear();
    putSource(root, relativePath, originalSource);
    const unchanged = await engine.buildOrUpdate({ verifyContent: true });
    expect(unchanged.factsChanged).toBe(false);
    expect(unchanged.filesUnchanged).toBe(1);
    expect(unchanged.parseFailures).toBe(0);
    expect(replaceObserver).not.toHaveBeenCalled();
    expect(rebuildObserver).not.toHaveBeenCalled();
    const unchangedDb = openCodeGraphDatabase(dbPath);
    try {
      expect(rawR1FtsState(unchangedDb)).toEqual(beforeFts);
      expectR1FtsCoherent(unchangedDb);
    } finally {
      unchangedDb.close();
    }
    expect(probe.attempts).toBe(2);
    probe.restore();
    engine.close();
    engine = null;
    engine = await CodeGraphEngine.open({
      dbPath,
      repositories: [{ repoId: REPO_ID, rootPath: root }],
    });
    const reopenedDb = openCodeGraphDatabase(dbPath);
    try {
      expect(rawR1FtsState(reopenedDb)).toEqual(beforeFts);
      expectR1FtsCoherent(reopenedDb);
    } finally {
      reopenedDb.close();
    }
    // A subsequent multi-symbol file exercises nextMappedRowid; no orphan
    // row from the failed attempt may collide with the next allocation.
    putSource(root, relativePath, changedSource);
    putSource(
      root,
      'src/later.ts',
      'export function r1LaterAllocation(): string { return "later"; }\n',
    );
    const recovery = await engine.buildOrUpdate({ verifyContent: true });
    expect(recovery.parseFailures).toBe(0);
    expect(recovery.filesParsed).toBe(2);
    expect(recovery.symbolCount).toBe(4);
    expect(
      engine.queries().search('r1LaterAllocation', 10, REPO_ID),
    ).toHaveLength(1);
    const recoveredDb = openCodeGraphDatabase(dbPath);
    try {
      expectR1FtsCoherent(recoveredDb);
      expect(
        count(
          recoveredDb,
          'SELECT COUNT(DISTINCT symbol_fts_rowid) AS n FROM symbol_fts_rows',
        ),
      ).toBe(4);
      expect(
        count(
          recoveredDb,
          'SELECT COUNT(DISTINCT fragment_fts_rowid) AS n FROM symbol_fts_rows',
        ),
      ).toBe(4);
    } finally {
      recoveredDb.close();
    }
  } finally {
    replaceObserver.mockRestore();
    rebuildObserver.mockRestore();
    probe.restore();
    engine?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe('W1 selective FTS engine integration (draft against real exports)', () => {
  it('keeps stable symbol identity and equals a fresh full-index build across ranking cases', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'code-graph-w1-engine-'));
    const incrementalPath = path.join(root, '.incremental', 'graph.db');
    const coldPath = path.join(root, '.cold', 'graph.db');
    let incremental: CodeGraphEngine | null = null;
    let cold: CodeGraphEngine | null = null;
    try {
      putSource(
        root,
        'src/index.ts',
        `export function stableLookup(value: string): string { return value; }
export function getWorkspaceCard(): string { return 'a'; }
export function getWorkspaceBoard(): string { return 'b'; }
export function getWorkspaceBoardCard(): string { return 'c'; }
export function créerFacture(): string { return 'd'; }
export function 处理订单(): string { return 'e'; }
`,
      );
      incremental = await CodeGraphEngine.open({
        dbPath: incrementalPath,
        repositories: [{ repoId: REPO_ID, rootPath: root }],
      });
      await incremental.buildOrUpdate();
      const before = openCodeGraphDatabase(incrementalPath);
      let oldStableId: string;
      try {
        const row = requireRow(
          before
            .prepare(
              `SELECT id FROM symbols
               WHERE repository_id = ? AND qualified_name = ?`,
            )
            .get(repositoryRowId(REPO_ID), 'src/index.ts::stableLookup'),
        );
        oldStableId = String(row.id);
      } finally {
        before.close();
      }

      // Same qualified name (therefore same symbol ID), changed parsed signature.
      putSource(
        root,
        'src/index.ts',
        `export function stableLookup(value: number): number { return value + 1; }
export function getWorkspaceCard(): string { return 'a'; }
export function getWorkspaceBoard(): string { return 'b'; }
export function getWorkspaceBoardCard(): string { return 'c'; }
export function créerFacture(): string { return 'd'; }
export function 处理订单(): string { return 'e'; }
`,
      );
      await incremental.buildOrUpdate();

      const after = openCodeGraphDatabase(incrementalPath);
      try {
        const row = requireRow(
          after
            .prepare(
              `SELECT id, signature FROM symbols
               WHERE repository_id = ? AND qualified_name = ?`,
            )
            .get(repositoryRowId(REPO_ID), 'src/index.ts::stableLookup'),
        );
        expect(String(row.id)).toBe(oldStableId);
        expect(String(row.signature)).toContain('number');
        expect(isSymbolFtsMappingTrusted(after)).toBe(true);
        expect(
          count(
            after,
            `SELECT COUNT(*) AS n FROM symbol_fts_rows
             WHERE symbol_id = ?`,
            oldStableId,
          ),
        ).toBe(1);
      } finally {
        after.close();
      }

      cold = await CodeGraphEngine.open({
        dbPath: coldPath,
        repositories: [{ repoId: REPO_ID, rootPath: root }],
      });
      await cold.buildOrUpdate();
      // Exact, prefix, token-prefix, long/short fragment, Unicode, ties, and
      // caps are compared as ordered results to a fresh full-index graph.
      const cases = [
        { query: 'stableLookup', matchKind: 'exact' },
        { query: 'stableLook', matchKind: 'prefix' },
        { query: 'str', matchKind: 'token-prefix' },
        { query: 'boardcard', matchKind: 'fragment' },
        { query: 'rdC', matchKind: 'fragment' },
        { query: 'ar Card', matchKind: 'fragment' },
        { query: 'ÉER', matchKind: 'fragment' },
        { query: '处理订单', matchKind: 'exact' },
      ];
      for (const searchCase of cases) {
        for (const limit of [1, 5, 20, 500]) {
          const incrementalHits = incremental
            .queries()
            .search(searchCase.query, limit, REPO_ID);
          const coldHits = cold
            .queries()
            .search(searchCase.query, limit, REPO_ID);
          expect(incrementalHits).toEqual(coldHits);
          expect(incrementalHits[0]?.matchKind).toBe(searchCase.matchKind);
        }
      }
      // Equal-ranked prefix hits retain a stable, explicit order under ties.
      expect(
        incremental
          .queries()
          .search('getWorkspace', 20, REPO_ID)
          .map((hit) => hit.qualifiedName),
      ).toEqual([
        'src/index.ts::getWorkspaceBoard',
        'src/index.ts::getWorkspaceBoardCard',
        'src/index.ts::getWorkspaceCard',
      ]);
      expect(
        incremental.queries().search('stableLookup', 1, REPO_ID)[0]?.matchKind,
      ).toBe('exact');
    } finally {
      cold?.close();
      incremental?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not make resolver-input-only changes look like symbol changes or duplicate FTS writes', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'code-graph-w1-input-only-'));
    const dbPath = path.join(root, '.graph', 'graph.db');
    let engine: CodeGraphEngine | null = null;
    const replaceObserver = jest.spyOn(
      symbolFtsStore,
      'replaceSymbolFtsForFiles',
    );
    const rebuildObserver = jest.spyOn(symbolFtsStore, 'rebuildSymbolFts');
    try {
      putSource(
        root,
        'src/input-only.ts',
        'export function inputOnlyFact(): string { return "unchanged"; }\n',
      );
      writeFileSync(
        path.join(root, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            baseUrl: '.',
            paths: { '@alias': ['src/input-only.ts'] },
          },
        }),
      );
      engine = await CodeGraphEngine.open({
        dbPath,
        repositories: [{ repoId: REPO_ID, rootPath: root }],
      });
      await engine.buildOrUpdate();
      const before = openCodeGraphDatabase(dbPath);
      let symbolIds: string[];
      try {
        symbolIds = before
          .prepare('SELECT id FROM symbols ORDER BY id')
          .all()
          .map((value) => String(requireRow(value).id));
      } finally {
        before.close();
      }

      // Retargeting resolver inputs alters link resolution but preserves the
      // indexed config/source symbol identities. Store facts own any one-file
      // projection; the engine must not perform another FTS pass afterward.
      writeFileSync(
        path.join(root, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            baseUrl: '.',
            paths: { '@alias': ['src/elsewhere.ts'] },
          },
        }),
      );
      replaceObserver.mockClear();
      rebuildObserver.mockClear();
      const changed = await engine.buildOrUpdate();
      expect(changed.factsChanged).toBe(true);
      expect(replaceObserver).toHaveBeenCalledTimes(1);
      expect(rebuildObserver).not.toHaveBeenCalled();
      expect(changed.timings?.ftsMs).toBeGreaterThanOrEqual(0);

      const after = openCodeGraphDatabase(dbPath);
      try {
        expect(
          after
            .prepare('SELECT id FROM symbols ORDER BY id')
            .all()
            .map((value) => String(requireRow(value).id)),
        ).toEqual(symbolIds);
      } finally {
        after.close();
      }
      const cold = await CodeGraphEngine.open({
        dbPath: path.join(root, '.cold', 'graph.db'),
        repositories: [{ repoId: REPO_ID, rootPath: root }],
      });
      try {
        await cold.buildOrUpdate();
        for (const query of ['inputOnlyFact', 'inputOnly', 'onlyFa']) {
          expect(engine.queries().search(query, 20, REPO_ID)).toEqual(
            cold.queries().search(query, 20, REPO_ID),
          );
        }
      } finally {
        cold.close();
      }
    } finally {
      replaceObserver.mockRestore();
      rebuildObserver.mockRestore();
      engine?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rolls facts, both FTS tables, and rowid mapping back together on failure', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'code-graph-w1-rollback-'));
    const dbPath = path.join(root, '.graph', 'graph.db');
    let engine: CodeGraphEngine | null = null;
    try {
      putSource(
        root,
        'src/rollback.ts',
        'export function rollbackProbe(): string { return "kept"; }\n',
      );
      engine = await CodeGraphEngine.open({
        dbPath,
        repositories: [{ repoId: REPO_ID, rootPath: root }],
      });
      await engine.buildOrUpdate();
      const db = openCodeGraphDatabase(dbPath);
      try {
        const before = [
          db.prepare('SELECT * FROM symbols ORDER BY id').all(),
          db.prepare('SELECT rowid, * FROM symbol_fts ORDER BY rowid').all(),
          db
            .prepare('SELECT rowid, * FROM symbol_fragment_fts ORDER BY rowid')
            .all(),
          db.prepare('SELECT * FROM symbol_fts_rows ORDER BY symbol_id').all(),
          getMetadataValue(db, 'symbol_fts_mapping_version'),
        ];
        const store = new CodeGraphStore(db);
        expect(() =>
          withImmediateTransaction(db, () => {
            store.removeFiles(REPO_ID, ['src/rollback.ts']);
            throw new Error('rollback after mapped FTS write');
          }),
        ).toThrow('rollback after mapped FTS write');
        const after = [
          db.prepare('SELECT * FROM symbols ORDER BY id').all(),
          db.prepare('SELECT rowid, * FROM symbol_fts ORDER BY rowid').all(),
          db
            .prepare('SELECT rowid, * FROM symbol_fragment_fts ORDER BY rowid')
            .all(),
          db.prepare('SELECT * FROM symbol_fts_rows ORDER BY symbol_id').all(),
          getMetadataValue(db, 'symbol_fts_mapping_version'),
        ];
        expect(after).toEqual(before);
        expect(isSymbolFtsMappingTrusted(db)).toBe(true);
      } finally {
        db.close();
      }
      expect(
        engine.queries().search('rollbackProbe', 10, REPO_ID),
      ).toHaveLength(1);
    } finally {
      engine?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  const r1FaultKinds: R1FaultKind[] = ['fragment', 'sqlite-abort'];

  it.each(r1FaultKinds)(
    'R1 non-code owned transaction rolls back a one-shot second-symbol %s failure',
    async (kind) => {
      await exerciseR1OwnedRollback(
        kind,
        'package.json',
        '{"scripts":{"r1Script":"echo before"}}\n',
        '{"scripts":{"r1Script":"echo after changed"}}\n',
      );
    },
  );

  it.each(r1FaultKinds)(
    'R1 grammar control already rolls back a second-symbol %s storage failure',
    async (kind) => {
      await exerciseR1OwnedRollback(
        kind,
        'src/control.ts',
        'export function r1GrammarControl(): string { return "before"; }\n',
        'export function r1GrammarControl(): number { return 42; }\n',
      );
    },
  );

  it.each([
    {
      relativePath: 'package.json',
      valid: '{"scripts":{"r1Script":"echo valid"}}\n',
      malformed: '{"scripts": invalid JSON\n',
      language: 'package-json',
    },
    {
      relativePath: '.github/workflows/r1.yml',
      valid:
        'name: R1 workflow\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo valid\n',
      malformed: 'name: [unterminated\n',
      language: 'github-workflow',
    },
  ])(
    'R1 malformed $language remains a durable failed file beside healthy grammar facts',
    async (fixture) => {
      const root = mkdtempSync(
        path.join(tmpdir(), 'code-graph-r1-extraction-'),
      );
      const dbPath = path.join(root, '.graph', 'graph.db');
      let engine: CodeGraphEngine | null = null;
      try {
        putSource(root, fixture.relativePath, fixture.valid);
        putSource(
          root,
          'src/healthy.ts',
          'export function r1HealthyControl(): string { return "healthy"; }\n',
        );
        engine = await CodeGraphEngine.open({
          dbPath,
          repositories: [{ repoId: REPO_ID, rootPath: root }],
        });
        const healthy = await engine.buildOrUpdate();
        expect(healthy.filesScanned).toBe(2);
        expect(healthy.parseFailures).toBe(0);
        const healthyDb = openCodeGraphDatabase(dbPath);
        try {
          expectR1FtsCoherent(healthyDb);
          const store = new CodeGraphStore(healthyDb);
          const file = store.getFileByPath(REPO_ID, fixture.relativePath);
          if (file === null)
            throw new Error('R1 valid extraction fixture missing');
          expect(file.parseStatus).toBe('parsed');
          expect(store.listSymbolsForFile(file.id).length).toBeGreaterThan(1);
        } finally {
          healthyDb.close();
        }
        putSource(root, fixture.relativePath, fixture.malformed);
        const failed = await engine.buildOrUpdate({ verifyContent: true });
        expect(failed.factsChanged).toBe(true);
        expect(failed.filesParsed).toBe(1);
        expect(failed.filesUnchanged).toBe(1);
        expect(failed.parseFailures).toBe(1);
        expect(
          engine.queries().search('r1HealthyControl', 10, REPO_ID),
        ).toHaveLength(1);
        let failedFts: unknown[];
        const failedDb = openCodeGraphDatabase(dbPath);
        try {
          const store = new CodeGraphStore(failedDb);
          const file = store.getFileByPath(REPO_ID, fixture.relativePath);
          if (file === null)
            throw new Error('R1 failed extraction fixture missing');
          expect(file.language).toBe(fixture.language);
          expect(file.parseStatus).toBe('failed');
          expect(file.hasErrors).toBe(true);
          expect(file.contentHash).not.toBeNull();
          const symbols = store.listSymbolsForFile(file.id);
          expect(symbols).toHaveLength(1);
          expect(symbols[0]?.kind).toBe('file');
          expect(
            count(
              failedDb,
              'SELECT COUNT(*) AS n FROM symbol_fts_rows WHERE file_id = ?',
              file.id,
            ),
          ).toBe(1);
          expectR1FtsCoherent(failedDb);
          failedFts = rawR1FtsState(failedDb);
        } finally {
          failedDb.close();
        }
        // Do not request verifyContent here: existing failed-file semantics
        // intentionally treat unchanged content as unchanged until asked to retry.
        const unchanged = await engine.buildOrUpdate();
        expect(unchanged.factsChanged).toBe(false);
        expect(unchanged.filesUnchanged).toBe(2);
        expect(unchanged.parseFailures).toBe(0);
        expect(engine.getStatus().filesWithErrors).toBe(1);
        const unchangedDb = openCodeGraphDatabase(dbPath);
        try {
          expect(rawR1FtsState(unchangedDb)).toEqual(failedFts);
          expectR1FtsCoherent(unchangedDb);
        } finally {
          unchangedDb.close();
        }
        putSource(root, fixture.relativePath, fixture.valid);
        const fixed = await engine.buildOrUpdate({ verifyContent: true });
        expect(fixed.parseFailures).toBe(0);
        expect(engine.getStatus().filesWithErrors).toBe(0);
        expect(
          engine.queries().search('r1HealthyControl', 10, REPO_ID),
        ).toHaveLength(1);
        const fixedDb = openCodeGraphDatabase(dbPath);
        try {
          expectR1FtsCoherent(fixedDb);
          const store = new CodeGraphStore(fixedDb);
          const file = store.getFileByPath(REPO_ID, fixture.relativePath);
          if (file === null)
            throw new Error('R1 recovered extraction fixture missing');
          expect(file.parseStatus).toBe('parsed');
          expect(file.hasErrors).toBe(false);
          expect(store.listSymbolsForFile(file.id).length).toBeGreaterThan(1);
        } finally {
          fixedDb.close();
        }
      } finally {
        engine?.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
