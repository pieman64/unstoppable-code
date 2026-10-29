import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  openCodeGraphDatabase,
  requireNumber,
  requireRow,
  requireString,
  type CodeGraphDatabase,
} from '../store/database';
import { runCodeGraphMigrations } from '../store/migrations';
import { CodeGraphQueryService } from '../query/queries';
import { repositoryRowId } from '../ids';
import {
  buildRealisticFixtureGraph,
  oracleImpactRadius,
  recordingDatabase,
  useSchemaV3Indexes,
  type RealisticFixtureGraph,
} from './query-plan-fixture';

// Cycles, self-recursion and class members, so seeds are reached again at
// positive depths.
const EXTRA_FILES: Record<string, string> = {
  'cycle/a.ts': `import { b } from './b';
export function a(n: number): number {
  return n > 0 ? b(n - 1) : 0;
}
`,
  'cycle/b.ts': `import { a } from './a';
export function b(n: number): number {
  return a(n);
}
export function callsB(): number {
  return b(3);
}
`,
  'cycle/self.ts': `export function countdown(n: number): number {
  return n > 0 ? countdown(n - 1) : 0;
}
export function startCountdown(): number {
  return countdown(3);
}
`,
  'cycle/widget.ts': `export class Widget {
  render(): number {
    return this.measure() + measureWidget(this);
  }
  measure(): number {
    return 1;
  }
}
export function measureWidget(widget: Widget): number {
  return widget.measure();
}
export function makeWidget(): Widget {
  return new Widget();
}
`,
};

const MAX_NODES = [1, 2, 3, 6, 11, 201, 1000, 5000];
const MAX_DEPTHS = [1, 2, 3, 5];

describe('impact radius bounded BFS (phase 18)', () => {
  let fixture: RealisticFixtureGraph;
  let db: CodeGraphDatabase;
  let v3Db: CodeGraphDatabase;
  let targets: string[];

  beforeAll(async () => {
    fixture = await buildRealisticFixtureGraph(['fixture'], EXTRA_FILES);
    const v3DbPath = path.join(path.dirname(fixture.dbPath), 'graph-v3.db');
    copyFileSync(fixture.dbPath, v3DbPath);
    v3Db = openCodeGraphDatabase(v3DbPath);
    useSchemaV3Indexes(v3Db);
    db = openCodeGraphDatabase(fixture.dbPath);
    // The most-depended-on symbols, every symbol with children, the cycle
    // fixture, and every 15th symbol by id.
    const ranked = db
      .prepare(
        `SELECT s.qualified_name AS qualified_name,
           (SELECT COUNT(*) FROM edges e WHERE e.target_symbol_id = s.id) AS fan_in,
           (SELECT COUNT(*) FROM symbols c WHERE c.parent_symbol_id = s.id) AS children
         FROM symbols s ORDER BY s.id`,
      )
      .all()
      .map((value) => {
        const row = requireRow(value);
        return {
          qualifiedName: requireString(row, 'qualified_name'),
          fanIn: requireNumber(row, 'fan_in'),
          children: requireNumber(row, 'children'),
        };
      });
    targets = Array.from(
      new Set([
        ...[...ranked]
          .sort((left, right) => right.fanIn - left.fanIn)
          .slice(0, 25)
          .map((entry) => entry.qualifiedName),
        ...ranked
          .filter((entry) => entry.children > 0)
          .slice(0, 25)
          .map((entry) => entry.qualifiedName),
        ...ranked
          .filter((entry) => entry.qualifiedName.startsWith('cycle/'))
          .map((entry) => entry.qualifiedName),
        ...ranked
          .filter((_, index) => index % 15 === 0)
          .map((entry) => entry.qualifiedName),
        'no/such/file.ts::missing',
      ]),
    );
  }, 120_000);

  afterAll(() => {
    db.close();
    v3Db.close();
    fixture.cleanup();
  });

  it('returns exactly the recursive-CTE results, in order, at every depth and node limit', () => {
    const queries = new CodeGraphQueryService(db);
    const v3Queries = new CodeGraphQueryService(v3Db);
    let compared = 0;
    let truncatedInsideFirstLayer = 0;
    let seedsReachedAgain = 0;
    for (const target of targets) {
      const layerOne = oracleImpactRadius(v3Db, target, {
        maxDepth: 1,
        maxNodes: 1000,
      }).length;
      for (const maxDepth of MAX_DEPTHS) {
        for (const maxNodes of MAX_NODES) {
          const options = { maxDepth, maxNodes };
          const expected = oracleImpactRadius(v3Db, target, options);
          expect({
            target,
            options,
            actual: queries.getImpactRadius(target, options),
          }).toEqual({
            target,
            options,
            actual: expected,
          });
          expect(v3Queries.getImpactRadius(target, options)).toEqual(expected);
          compared += expected.length;
          if (maxNodes < layerOne) truncatedInsideFirstLayer += 1;
          if (expected.some((hit) => hit.qualifiedName === target)) {
            seedsReachedAgain += 1;
          }
        }
      }
      expect(queries.getImpactRadius(target)).toEqual(
        oracleImpactRadius(v3Db, target),
      );
    }
    // The matrix covers limits smaller than one BFS layer and seeds that a
    // cycle reaches again at a positive depth.
    expect(compared).toBeGreaterThan(10_000);
    expect(truncatedInsideFirstLayer).toBeGreaterThan(100);
    expect(seedsReachedAgain).toBeGreaterThan(0);
  });

  it('stops walking after the first depth that fills maxNodes', () => {
    const target = targets[0];
    if (target === undefined) throw new Error('no target');
    const recorder = recordingDatabase(db);
    const queries = new CodeGraphQueryService(recorder.db);
    const walks = (): number =>
      recorder.executed.filter((statement) =>
        statement.sql.includes('SELECT DISTINCT e.source_symbol_id'),
      ).length;

    queries.getImpactRadius(target, { maxDepth: 5, maxNodes: 1 });
    expect(walks()).toBe(1);

    recorder.executed.length = 0;
    const full = queries.getImpactRadius(target, {
      maxDepth: 5,
      maxNodes: 1000,
    });
    expect(full.length).toBeGreaterThan(1);
    expect(walks()).toBeGreaterThan(1);
  });
});

describe('impact radius tie-break (phase 18)', () => {
  let dir: string;
  let db: CodeGraphDatabase;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'code-graph-impact-ties-'));
    db = openCodeGraphDatabase(path.join(dir, 'graph.db'));
    runCodeGraphMigrations(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('orders equal depth and qualified name by kind, then file path, and reports identical rows once', () => {
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
    const insertCall = db.prepare(
      `INSERT INTO edges (id, repository_id, kind, source_symbol_id, target_symbol_id, source_file_id, confidence_tier, confidence_score)
       VALUES (?, ?, 'CALLS', ?, 'target', ?, 'RESOLVED', 1)`,
    );
    for (const repo of ['one', 'two', 'three']) {
      insertRepository.run(repositoryRowId(repo), repo, `/${repo}`);
      insertFile.run(`file-${repo}`, repositoryRowId(repo), `/${repo}/a.ts`);
    }
    insertSymbol.run(
      'target',
      repositoryRowId('one'),
      'file-one',
      'function',
      'target',
      'a.ts::target',
    );
    // `a.ts::caller` three times: a class in `two`, functions in `one` and
    // `three`. The two function rows are identical once projected.
    for (const [id, repo, kind] of [
      ['caller-two', 'two', 'class'],
      ['caller-three', 'three', 'function'],
      ['caller-one', 'one', 'function'],
    ]) {
      insertSymbol.run(
        id,
        repositoryRowId(repo),
        `file-${repo}`,
        kind,
        'caller',
        'a.ts::caller',
      );
      insertCall.run(`call-${id}`, repositoryRowId(repo), id, `file-${repo}`);
    }

    const queries = new CodeGraphQueryService(db);
    const expected = [
      {
        qualifiedName: 'a.ts::caller',
        kind: 'class',
        filePath: 'a.ts',
        depth: 1,
      },
      {
        qualifiedName: 'a.ts::caller',
        kind: 'function',
        filePath: 'a.ts',
        depth: 1,
      },
    ];
    expect(queries.getImpactRadius('a.ts::target')).toEqual(expected);
    expect(queries.getImpactRadius('a.ts::target', { maxNodes: 1 })).toEqual([
      expected[0],
    ]);
    // The old query returned the same rows without a defined order.
    expect(
      oracleImpactRadius(db, 'a.ts::target')
        .map((hit) => hit.kind)
        .sort(),
    ).toEqual(['class', 'function']);
  });
});
