import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { CodeGraphEngine, type CodeGraphInternalBuildOptions } from '../engine';
import {
  getMetadataValue,
  openCodeGraphDatabase,
  requireNumber,
  requireRow,
  type CodeGraphDatabase,
} from '../store/database';
import { CodeGraphStore } from '../store/graph-store';
import { symbolRowId } from '../ids';
import { repositoryRowId } from '../ids';
import { SqliteResolutionDependencyWriter } from '../resolve/resolution-dependency-store';
import { resolutionDependencyCaptureMetadataKey } from '../resolve/resolution-dependency-capture';

const LIB = `export function doWork(): number {
  return 42;
}
`;
const MAIN = `import { doWork } from './lib';

export function run(): number {
  return doWork();
}
`;
const TEST = `import { doWork } from '../lib';

doWork();
`;

function seedRepo(root: string): void {
  mkdirSync(path.join(root, 'src', '__tests__'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'lib.ts'), LIB);
  writeFileSync(path.join(root, 'src', 'main.ts'), MAIN);
  writeFileSync(path.join(root, 'src', '__tests__', 'lib.test.ts'), TEST);
}

function dependencyCount(db: CodeGraphDatabase, repoId: string): number {
  return requireNumber(
    requireRow(
      db
        .prepare(
          'SELECT COUNT(*) AS n FROM resolution_dependencies WHERE repository_id = ?',
        )
        .get(repositoryRowId(repoId)),
    ),
    'n',
  );
}

function dependencyPartition(db: CodeGraphDatabase, repoId: string): string {
  return JSON.stringify(
    db
      .prepare(
        `SELECT * FROM resolution_dependencies WHERE repository_id = ?
     ORDER BY resolver, source_file_id, source_edge_id, dependency_kind, dependency_key`,
      )
      .all(repositoryRowId(repoId)),
  );
}

describe('CodeGraphEngine multi-repo isolation', () => {
  let root: string;
  let repoARoot: string;
  let repoBRoot: string;
  let dbPath: string;
  let engine: CodeGraphEngine;

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'code-graph-multi-'));
    repoARoot = path.join(root, 'repo-a');
    repoBRoot = path.join(root, 'repo-b');
    seedRepo(repoARoot);
    seedRepo(repoBRoot);
    dbPath = path.join(root, '.graph', 'graph.db');
    engine = await CodeGraphEngine.open({
      dbPath,
      repositories: [
        { repoId: 'repo-a', rootPath: repoARoot },
        { repoId: 'repo-b', rootPath: repoBRoot },
      ],
    });
  });
  afterEach(() => {
    engine.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('binds edges within each repo only — no cross-repo corruption', async () => {
    await engine.buildOrUpdate();

    // getCallers is repo-unscoped for Phase 1; both repos share the qualified
    // name, so it resolves into one repo. Pre-fix cross-repo binding would have
    // duplicated its callers (4 instead of 2).
    const callers = engine.queries().getCallers('src/lib.ts::doWork');
    expect(callers).toHaveLength(2);
    expect(new Set(callers.map((c) => c.qualifiedName)).size).toBe(2);

    // A second read connection (WAL) for repo-scoped and raw assertions while
    // the engine keeps its write connection open.
    const db: CodeGraphDatabase = openCodeGraphDatabase(dbPath);
    const store = new CodeGraphStore(db);
    try {
      // Exactly one TESTED_BY edge per repo, two total (not 7).
      expect(
        store.listEdges({ kind: 'TESTED_BY', repoId: 'repo-a' }),
      ).toHaveLength(1);
      expect(
        store.listEdges({ kind: 'TESTED_BY', repoId: 'repo-b' }),
      ).toHaveLength(1);
      expect(store.listEdges({ kind: 'TESTED_BY' })).toHaveLength(2);

      // Each repo's doWork is called by exactly that repo's run + test fn.
      for (const repoId of ['repo-a', 'repo-b']) {
        const doWorkId = symbolRowId(repoId, 'src/lib.ts::doWork');
        const callers = store
          .listEdges({ kind: 'CALLS', repoId })
          .filter((edge) => edge.targetSymbolId === doWorkId);
        expect(callers).toHaveLength(2);
        // Every caller edge originates from the same repo it resolved into.
        for (const edge of callers) {
          expect(edge.repositoryId).toBe(repoId);
        }
        // The TESTED_BY edge for this repo points at this repo's doWork.
        const testedBy = store.listEdges({ kind: 'TESTED_BY', repoId });
        expect(testedBy[0].sourceSymbolId).toBe(doWorkId);
      }

      // No edge points at a target_symbol_id that is absent from symbols.
      const orphanRow = requireRow(
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM edges
             WHERE target_symbol_id IS NOT NULL
               AND target_symbol_id NOT IN (SELECT id FROM symbols)`,
          )
          .get(),
      );
      expect(requireNumber(orphanRow, 'n')).toBe(0);
    } finally {
      db.close();
    }
  });

  it('matches cold ordered FTS results for repository scopes, ranks, ties and caps', async () => {
    await engine.buildOrUpdate();
    const coldEngine = await CodeGraphEngine.open({
      dbPath: path.join(root, '.cold', 'graph.db'),
      repositories: [
        { repoId: 'repo-a', rootPath: repoARoot },
        { repoId: 'repo-b', rootPath: repoBRoot },
      ],
    });
    try {
      await coldEngine.buildOrUpdate();
      const cases = [
        { query: 'doWork', matchKind: 'exact' },
        { query: 'doW', matchKind: 'prefix' },
        { query: 'number', matchKind: 'token-prefix' },
        { query: 'wor', matchKind: 'fragment' },
      ];
      for (const searchCase of cases) {
        for (const repoId of [undefined, 'repo-a', 'repo-b']) {
          for (const limit of [1, 5, 20, 500]) {
            const incrementalHits = engine
              .queries()
              .search(searchCase.query, limit, repoId);
            const coldHits = coldEngine
              .queries()
              .search(searchCase.query, limit, repoId);
            expect(incrementalHits).toEqual(coldHits);
            if (limit === 500 && incrementalHits.length > 0) {
              expect(incrementalHits[0]?.matchKind).toBe(searchCase.matchKind);
            }
          }
        }
      }
      // Same qualified name in both repositories gives equal priority; the
      // complete ordered rows protect the deterministic symbol-id tie break.
      expect(engine.queries().search('doWork', 20)).toEqual(
        coldEngine.queries().search('doWork', 20),
      );
    } finally {
      coldEngine.close();
    }
  });

  it('removes every old repository row on descriptor removal and re-ID', async () => {
    await engine.buildOrUpdate();

    const before = openCodeGraphDatabase(dbPath);
    const oldSymbolsByRepo = new Map<string, string[]>();
    try {
      for (const repoId of ['repo-a', 'repo-b']) {
        const rows = before
          .prepare('SELECT id FROM symbols WHERE repository_id = ?')
          .all(repositoryRowId(repoId));
        oldSymbolsByRepo.set(
          repoId,
          rows.map((row) => String(requireRow(row).id)),
        );
      }
    } finally {
      before.close();
    }

    const expectRepositoryAbsent = (
      db: CodeGraphDatabase,
      repoId: string,
      symbolIds: string[],
    ): void => {
      const repositoryId = repositoryRowId(repoId);
      for (const [table, column] of [
        ['repositories', 'id'],
        ['files', 'repository_id'],
        ['symbols', 'repository_id'],
        ['edges', 'repository_id'],
        ['communities', 'repository_id'],
        ['flows', 'repository_id'],
        ['symbol_fts_rows', 'repository_id'],
        ['resolution_dependencies', 'repository_id'],
      ] as const) {
        const row = requireRow(
          db
            .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`)
            .get(repositoryId),
        );
        expect(requireNumber(row, 'n')).toBe(0);
      }
      expect(
        getMetadataValue(db, resolutionDependencyCaptureMetadataKey(repoId)),
      ).toBeNull();
      for (const symbolId of symbolIds) {
        const fts = requireRow(
          db
            .prepare('SELECT COUNT(*) AS n FROM symbol_fts WHERE symbol_id = ?')
            .get(symbolId),
        );
        expect(requireNumber(fts, 'n')).toBe(0);
        const fragment = requireRow(
          db
            .prepare(
              'SELECT COUNT(*) AS n FROM symbol_fragment_fts WHERE symbol_id = ?',
            )
            .get(symbolId),
        );
        expect(requireNumber(fragment, 'n')).toBe(0);
        const mapping = requireRow(
          db
            .prepare(
              'SELECT COUNT(*) AS n FROM symbol_fts_rows WHERE symbol_id = ?',
            )
            .get(symbolId),
        );
        expect(requireNumber(mapping, 'n')).toBe(0);
        const communityMembership = requireRow(
          db
            .prepare(
              'SELECT COUNT(*) AS n FROM community_memberships WHERE symbol_id = ?',
            )
            .get(symbolId),
        );
        expect(requireNumber(communityMembership, 'n')).toBe(0);
        const flowMembership = requireRow(
          db
            .prepare(
              'SELECT COUNT(*) AS n FROM flow_memberships WHERE symbol_id = ?',
            )
            .get(symbolId),
        );
        expect(requireNumber(flowMembership, 'n')).toBe(0);
      }
    };

    engine.close();
    engine = await CodeGraphEngine.open({
      dbPath,
      repositories: [{ repoId: 'repo-a', rootPath: repoARoot }],
    });
    await engine.buildOrUpdate();

    let db = openCodeGraphDatabase(dbPath);
    try {
      expectRepositoryAbsent(
        db,
        'repo-b',
        oldSymbolsByRepo.get('repo-b') ?? [],
      );
    } finally {
      db.close();
    }

    engine.close();
    engine = await CodeGraphEngine.open({
      dbPath,
      repositories: [{ repoId: 'repo-renamed', rootPath: repoARoot }],
    });
    await engine.buildOrUpdate();

    db = openCodeGraphDatabase(dbPath);
    try {
      expectRepositoryAbsent(
        db,
        'repo-a',
        oldSymbolsByRepo.get('repo-a') ?? [],
      );
      expect(
        requireNumber(
          requireRow(
            db
              .prepare(
                'SELECT COUNT(*) AS n FROM repositories WHERE repo_id = ?',
              )
              .get('repo-renamed'),
          ),
          'n',
        ),
      ).toBe(1);
    } finally {
      db.close();
    }
  });

  const retirementCases: readonly {
    mode: 'default' | 'incremental';
    action: 'remove' | 're-id';
  }[] = [
    { mode: 'default', action: 'remove' },
    { mode: 'default', action: 're-id' },
    { mode: 'incremental', action: 'remove' },
    { mode: 'incremental', action: 're-id' },
  ];

  for (const retirement of retirementCases) {
    it(`clears real captured B on ${retirement.action} in ${retirement.mode} and unchanged builds`, async () => {
      const repoCRoot = path.join(root, 'repo-c');
      seedRepo(repoCRoot);
      engine.close();
      engine = await CodeGraphEngine.open({
        dbPath,
        repositories: [
          { repoId: 'repo-a', rootPath: repoARoot },
          { repoId: 'repo-b', rootPath: repoBRoot },
          { repoId: 'repo-c', rootPath: repoCRoot },
        ],
      });
      // Real extractor/resolver capture, never manually inserted dependency rows.
      await engine.buildOrUpdate({
        resolutionMode: 'full-reset',
        captureResolutionDependencies: true,
      });
      const before = openCodeGraphDatabase(dbPath);
      const survivingPartitions = new Map<string, string>();
      try {
        const writer = new SqliteResolutionDependencyWriter(before);
        for (const { repoId, rootPath } of [
          { repoId: 'repo-a', rootPath: repoARoot },
          { repoId: 'repo-b', rootPath: repoBRoot },
          { repoId: 'repo-c', rootPath: repoCRoot },
        ]) {
          expect(dependencyCount(before, repoId)).toBeGreaterThan(0);
          expect(
            getMetadataValue(
              before,
              resolutionDependencyCaptureMetadataKey(repoId),
            ),
          ).not.toBeNull();
          expect(writer.isCompatible({ repoId, rootPath })).toBe(true);
        }
        for (const repoId of ['repo-a', 'repo-c']) {
          survivingPartitions.set(repoId, dependencyPartition(before, repoId));
        }
      } finally {
        before.close();
      }

      engine.close();
      engine = await CodeGraphEngine.open({
        dbPath,
        repositories: [
          { repoId: 'repo-a', rootPath: repoARoot },
          { repoId: 'repo-c', rootPath: repoCRoot },
          ...(retirement.action === 're-id'
            ? [{ repoId: 'repo-renamed', rootPath: repoBRoot }]
            : []),
        ],
      });
      const options: CodeGraphInternalBuildOptions | undefined =
        retirement.mode === 'incremental'
          ? { resolutionMode: 'incremental' }
          : undefined;
      for (let build = 0; build < 2; build += 1) {
        // First crosses membership retirement; second has no filesystem edits.
        const result = await engine.buildOrUpdate(options);
        expect(result.parseFailures).toBe(0);
        if (build === 1) expect(result.filesParsed).toBe(0);
        const db = openCodeGraphDatabase(dbPath);
        try {
          expect(dependencyCount(db, 'repo-b')).toBe(0);
          expect(
            getMetadataValue(
              db,
              resolutionDependencyCaptureMetadataKey('repo-b'),
            ),
          ).toBeNull();
          for (const [table, column] of [
            ['repositories', 'id'],
            ['files', 'repository_id'],
            ['symbols', 'repository_id'],
            ['edges', 'repository_id'],
            ['symbol_fts_rows', 'repository_id'],
          ]) {
            expect(
              requireNumber(
                requireRow(
                  db
                    .prepare(
                      `SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`,
                    )
                    .get(repositoryRowId('repo-b')),
                ),
                'n',
              ),
            ).toBe(0);
          }
          const writer = new SqliteResolutionDependencyWriter(db);
          for (const { repoId, rootPath } of [
            { repoId: 'repo-a', rootPath: repoARoot },
            { repoId: 'repo-c', rootPath: repoCRoot },
          ]) {
            expect(dependencyCount(db, repoId)).toBeGreaterThan(0);
            if (retirement.mode === 'default') {
              expect(dependencyPartition(db, repoId)).toBe(
                survivingPartitions.get(repoId),
              );
              // Facts-only full reset invalidates configured capture markers.
              expect(
                getMetadataValue(
                  db,
                  resolutionDependencyCaptureMetadataKey(repoId),
                ),
              ).toBeNull();
            } else {
              // Membership may legitimately force recapture; it must remain valid.
              expect(writer.isCompatible({ repoId, rootPath })).toBe(true);
            }
          }
          if (retirement.action === 're-id') {
            expect(
              requireNumber(
                requireRow(
                  db
                    .prepare(
                      'SELECT COUNT(*) AS n FROM repositories WHERE repo_id = ?',
                    )
                    .get('repo-renamed'),
                ),
                'n',
              ),
            ).toBe(1);
            if (retirement.mode === 'incremental') {
              expect(dependencyCount(db, 'repo-renamed')).toBeGreaterThan(0);
              expect(
                writer.isCompatible({
                  repoId: 'repo-renamed',
                  rootPath: repoBRoot,
                }),
              ).toBe(true);
            }
          }
        } finally {
          db.close();
        }
      }
    });
  }

  it('retirement reconciliation preserves unrelated real captured A/C rows and markers exactly', async () => {
    const repoCRoot = path.join(root, 'repo-c');
    seedRepo(repoCRoot);
    engine.close();
    engine = await CodeGraphEngine.open({
      dbPath,
      repositories: [
        { repoId: 'repo-a', rootPath: repoARoot },
        { repoId: 'repo-b', rootPath: repoBRoot },
        { repoId: 'repo-c', rootPath: repoCRoot },
      ],
    });
    await engine.buildOrUpdate({
      resolutionMode: 'full-reset',
      captureResolutionDependencies: true,
    });
    // Close the engine before using the same database's existing store writer.
    engine.close();
    const db = openCodeGraphDatabase(dbPath);
    try {
      const preserved = new Map<
        string,
        { rows: string; marker: string | null }
      >();
      for (const repoId of ['repo-a', 'repo-b', 'repo-c']) {
        expect(dependencyCount(db, repoId)).toBeGreaterThan(0);
        const marker = getMetadataValue(
          db,
          resolutionDependencyCaptureMetadataKey(repoId),
        );
        expect(marker).not.toBeNull();
        preserved.set(repoId, {
          rows: dependencyPartition(db, repoId),
          marker,
        });
      }
      const store = new CodeGraphStore(db);
      expect(
        store.reconcileRepositories([
          { repoId: 'repo-a', rootPath: repoARoot, gitHead: null },
          { repoId: 'repo-c', rootPath: repoCRoot, gitHead: null },
        ]),
      ).toBe(true);
      expect(dependencyCount(db, 'repo-b')).toBe(0);
      expect(
        getMetadataValue(db, resolutionDependencyCaptureMetadataKey('repo-b')),
      ).toBeNull();
      for (const repoId of ['repo-a', 'repo-c']) {
        expect({
          rows: dependencyPartition(db, repoId),
          marker: getMetadataValue(
            db,
            resolutionDependencyCaptureMetadataKey(repoId),
          ),
        }).toEqual(preserved.get(repoId));
      }
    } finally {
      db.close();
      // Keep afterEach's existing single-close ownership intact, even on failure.
      engine = await CodeGraphEngine.open({
        dbPath,
        repositories: [
          { repoId: 'repo-a', rootPath: repoARoot },
          { repoId: 'repo-c', rootPath: repoCRoot },
        ],
      });
    }
  });
});
