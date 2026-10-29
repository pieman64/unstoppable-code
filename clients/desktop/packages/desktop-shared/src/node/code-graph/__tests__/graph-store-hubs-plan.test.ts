import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  openCodeGraphDatabase,
  type CodeGraphDatabase,
} from '../store/database';
import { CodeGraphStore } from '../store/graph-store';
import { runCodeGraphMigrations } from '../store/migrations';
import { repositoryRowId } from '../ids';
import {
  buildRealisticFixtureGraph,
  oracleTopDegreeSymbols,
  queryPlan,
  recordingDatabase,
  useSchemaV3Indexes,
  type RealisticFixtureGraph,
} from './query-plan-fixture';

describe('hubs query plan (phase 18)', () => {
  let fixture: RealisticFixtureGraph;
  let db: CodeGraphDatabase;
  let v3Db: CodeGraphDatabase;

  beforeAll(async () => {
    // Two identical repositories: every hub has an equal-degree twin.
    fixture = await buildRealisticFixtureGraph(['fixture', 'mirror']);
    const v3DbPath = path.join(path.dirname(fixture.dbPath), 'graph-v3.db');
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

  it('counts each degree on the endpoint indexes without a per-call temporary index', () => {
    for (const repoId of [undefined, 'fixture']) {
      const recorder = recordingDatabase(db);
      new CodeGraphStore(recorder.db).listTopDegreeSymbols(repoId, 1000);
      const [hubs] = recorder.executed;
      if (hubs === undefined) throw new Error('no hubs query');
      const plan = queryPlan(db, hubs.sql, hubs.params);
      expect(
        plan.filter((detail) => /AUTOMATIC|GROUP BY/.test(detail)),
      ).toEqual([]);
      const access =
        repoId === undefined ? 'USING COVERING INDEX' : 'USING INDEX';
      expect(plan).toEqual(
        expect.arrayContaining([
          `SEARCH e ${access} idx_edges_source_symbol (source_symbol_id=?)`,
          `SEARCH e ${access} idx_edges_target_symbol (target_symbol_id=?)`,
        ]),
      );
      // Only the bounded top-N sort of the computed degree remains.
      expect(plan.filter((detail) => detail.includes('TEMP B-TREE'))).toEqual([
        'USE TEMP B-TREE FOR ORDER BY',
      ]);
    }
  });

  it('returns exactly the pre-phase-18 hubs for every scope and limit', () => {
    let compared = 0;
    for (const repoId of [undefined, 'fixture', 'mirror', 'missing']) {
      for (const limit of [1, 2, 7, 20, 100, 1000, 5000]) {
        const expected = oracleTopDegreeSymbols(v3Db, repoId, limit);
        const actual = new CodeGraphStore(db).listTopDegreeSymbols(
          repoId,
          limit,
        );
        expect({ repoId, limit, actual }).toEqual({
          repoId,
          limit,
          actual: expected,
        });
        // An unmigrated (schema v3) graph answers identically too.
        expect(
          new CodeGraphStore(v3Db).listTopDegreeSymbols(repoId, limit),
        ).toEqual(expected);
        compared += expected.length;
      }
    }
    expect(compared).toBeGreaterThan(2_000);
  });
});

describe('hubs tie-break (phase 18)', () => {
  let dir: string;
  let db: CodeGraphDatabase;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'code-graph-hubs-ties-'));
    db = openCodeGraphDatabase(path.join(dir, 'graph.db'));
    runCodeGraphMigrations(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('orders equal degrees by qualified name, then symbol id', () => {
    // Two repositories each declare `a.ts::shared` (a function in one, a
    // class in the other) with the same degree; `a.ts::zeta` has the same
    // degree too. Before phase 18 the two `shared` rows had no defined order.
    const insertRepository = db.prepare(
      'INSERT INTO repositories (id, repo_id, root_path, git_head, updated_at) VALUES (?, ?, ?, NULL, 0)',
    );
    const insertFile = db.prepare(
      `INSERT INTO files (id, repository_id, relative_path, absolute_path, size_bytes, mtime_ns, parse_status, updated_at)
       VALUES (?, ?, 'a.ts', ?, 1, '1', 'parsed', 0)`,
    );
    const insertSymbol = db.prepare(
      `INSERT INTO symbols (id, repository_id, file_id, kind, name, qualified_name, line_start, line_end, byte_start, byte_end)
       VALUES (?, ?, ?, ?, ?, ?, 1, 1, 0, 1)`,
    );
    const insertEdge = db.prepare(
      `INSERT INTO edges (id, repository_id, kind, source_symbol_id, target_symbol_id, source_file_id, confidence_tier, confidence_score)
       VALUES (?, ?, 'CALLS', ?, ?, ?, 'RESOLVED', 1)`,
    );
    const symbols = [
      { id: 'sym-b', repo: 'repo-two', kind: 'class', name: 'shared' },
      { id: 'sym-a', repo: 'repo-one', kind: 'function', name: 'shared' },
      { id: 'sym-c', repo: 'repo-one', kind: 'function', name: 'zeta' },
    ];
    for (const repo of ['repo-one', 'repo-two']) {
      insertRepository.run(repositoryRowId(repo), repo, `/${repo}`);
      insertFile.run(`file-${repo}`, repositoryRowId(repo), `/${repo}/a.ts`);
    }
    for (const symbol of symbols) {
      insertSymbol.run(
        symbol.id,
        repositoryRowId(symbol.repo),
        `file-${symbol.repo}`,
        symbol.kind,
        symbol.name,
        `a.ts::${symbol.name}`,
      );
      // Two self-calls: degree 4 each.
      for (const suffix of ['1', '2']) {
        insertEdge.run(
          `${symbol.id}-${suffix}`,
          repositoryRowId(symbol.repo),
          symbol.id,
          symbol.id,
          `file-${symbol.repo}`,
        );
      }
    }

    expect(new CodeGraphStore(db).listTopDegreeSymbols(undefined, 10)).toEqual([
      {
        qualifiedName: 'a.ts::shared',
        kind: 'function',
        filePath: 'a.ts',
        degree: 4,
      },
      {
        qualifiedName: 'a.ts::shared',
        kind: 'class',
        filePath: 'a.ts',
        degree: 4,
      },
      {
        qualifiedName: 'a.ts::zeta',
        kind: 'function',
        filePath: 'a.ts',
        degree: 4,
      },
    ]);
    // The same rows the old query returned, which left the twins unordered.
    expect(
      new CodeGraphStore(db)
        .listTopDegreeSymbols(undefined, 10)
        .map((hit) => `${hit.qualifiedName}/${hit.kind}`)
        .sort(),
    ).toEqual(
      oracleTopDegreeSymbols(db, undefined, 10)
        .map((hit) => `${hit.qualifiedName}/${hit.kind}`)
        .sort(),
    );
  });
});
