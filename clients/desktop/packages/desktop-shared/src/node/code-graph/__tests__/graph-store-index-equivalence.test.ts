import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CodeGraphEngine } from '../engine';
import {
  getMetadataValue,
  openCodeGraphDatabase,
  requireRow,
  requireString,
  type CodeGraphDatabase,
} from '../store/database';
import { CodeGraphStore } from '../store/graph-store';
import {
  CODE_GRAPH_MIGRATIONS,
  runCodeGraphMigrations,
} from '../store/migrations';
import { CodeGraphQueryService } from '../query/queries';
import {
  buildRealisticFixtureGraph,
  indexDefinitions,
  queryPlan,
  recordingDatabase,
  useSchemaV3Indexes,
  type RealisticFixtureGraph,
} from './query-plan-fixture';

/**
 * Every index of a schema-v4 graph and why it stays (phase 18 review). The
 * test pins the set so a new or dropped index is a deliberate change.
 */
const V4_INDEXES: Record<string, string> = {
  // Derived-analysis reads by repository and by member symbol.
  idx_communities_repo:
    'CREATE INDEX idx_communities_repo ON communities(repository_id)',
  idx_community_memberships_symbol:
    'CREATE INDEX idx_community_memberships_symbol ON community_memberships(symbol_id)',
  // Repository-wide edge passes (resolvers, diagnostics by kind, base summaries).
  idx_edges_repo_kind:
    'CREATE INDEX idx_edges_repo_kind ON edges(repository_id, kind)',
  // Per-file edge replacement and `imports`.
  idx_edges_source_file:
    'CREATE INDEX idx_edges_source_file ON edges(source_file_id)',
  // `callees`, relationship-path's forward walk (INDEXED BY), hubs.
  idx_edges_source_symbol:
    'CREATE INDEX idx_edges_source_symbol ON edges(source_symbol_id)',
  // `callers`, importers, docs, tests, rationale, ipc-channel handlers and
  // invokers, impact radius, relationship-path's reverse walk (INDEXED BY),
  // hubs. Partial: no query looks up a NULL target.
  idx_edges_target_symbol:
    'CREATE INDEX idx_edges_target_symbol ON edges(target_symbol_id) WHERE target_symbol_id IS NOT NULL',
  // Resolver work lists and ipc-channel's unresolved call-site count.
  idx_edges_unresolved:
    'CREATE INDEX idx_edges_unresolved ON edges(repository_id, kind) WHERE target_symbol_id IS NULL',
  // Per-repository file listing and counts.
  idx_files_repo: 'CREATE INDEX idx_files_repo ON files(repository_id)',
  idx_flow_memberships_symbol:
    'CREATE INDEX idx_flow_memberships_symbol ON flow_memberships(symbol_id)',
  idx_flows_repo: 'CREATE INDEX idx_flows_repo ON flows(repository_id)',
  // Per-file symbol replacement and file summaries.
  idx_symbols_file: 'CREATE INDEX idx_symbols_file ON symbols(file_id)',
  // Symbol search's case-insensitive exact and prefix match.
  idx_symbols_name_nocase:
    'CREATE INDEX idx_symbols_name_nocase ON symbols(name COLLATE NOCASE)',
  // Resolver lookups by repository and exact (binary) name.
  idx_symbols_repo_name:
    'CREATE INDEX idx_symbols_repo_name ON symbols(repository_id, name)',
};

const V5_INDEXES: Record<string, string> = {
  ...V4_INDEXES,
  idx_symbol_fts_rows_file:
    'CREATE INDEX idx_symbol_fts_rows_file ON symbol_fts_rows(file_id)',
  idx_symbol_fts_rows_repository:
    'CREATE INDEX idx_symbol_fts_rows_repository ON symbol_fts_rows(repository_id)',
  idx_resolution_dependencies_reverse:
    'CREATE INDEX idx_resolution_dependencies_reverse\n    ON resolution_dependencies(repository_id, dependency_kind, dependency_key, resolver)',
  idx_resolution_dependencies_source:
    'CREATE INDEX idx_resolution_dependencies_source\n    ON resolution_dependencies(repository_id, source_file_id, resolver)',
};

/** Every read the query tools issue, over a spread of targets. */
function runEveryQueryMode(db: CodeGraphDatabase): unknown[] {
  const queries = new CodeGraphQueryService(db);
  const store = new CodeGraphStore(db);
  const symbols = db
    .prepare('SELECT qualified_name FROM symbols ORDER BY id')
    .all()
    .map((value) => requireString(requireRow(value), 'qualified_name'));
  const files = db
    .prepare('SELECT relative_path FROM files ORDER BY id')
    .all()
    .map((value) => requireString(requireRow(value), 'relative_path'));
  const results: unknown[] = [];
  symbols.forEach((qualifiedName, index) => {
    if (index % 7 !== 0) return;
    results.push(
      queries.getCallers(qualifiedName),
      queries.getCallees(qualifiedName),
      queries.getChildren(qualifiedName),
      queries.getSymbolDetail(qualifiedName),
      queries.getTestsFor(qualifiedName),
      queries.getDocsFor(qualifiedName),
      queries.getRationaleFor(qualifiedName),
      queries.getIpcChannel(qualifiedName),
      queries.getImpactRadius(qualifiedName, { maxDepth: 3, maxNodes: 50 }),
      queries.listFlowsForSymbol(qualifiedName),
      queries.getCommunityForSymbol(qualifiedName),
      queries.countCrossCommunityCallers(qualifiedName),
    );
    const next = symbols[(index * 31) % symbols.length];
    if (next !== undefined) {
      for (const mode of ['call-path', 'relationship-path'] as const) {
        results.push(
          queries.getRelationshipPath({
            target: qualifiedName,
            to: next,
            mode,
          }),
        );
      }
    }
  });
  files.forEach((relativePath, index) => {
    if (index % 3 !== 0) return;
    results.push(
      queries.getImporters(relativePath),
      queries.getImports(relativePath),
      queries.getFileSummary(relativePath),
      queries.getScriptsForFile(relativePath),
    );
  });
  for (const text of ['store', 'Graph', 'requireRow', 'resolve call', 'fts']) {
    results.push(queries.search(text, 20));
  }
  results.push(
    queries.listCommunities(),
    queries.listFlows(),
    queries.listTopDegreeSymbols(undefined, 200),
    queries.getDerivedStats(),
    store.countSymbols(),
    store.countEdges(),
    store.countUnresolvedEdges(),
    store.listEdges({ unresolvedOnly: true, kind: 'CALLS', repoId: 'fixture' }),
    store.listEdges({ kind: 'IMPORTS_FROM', repoId: 'fixture' }),
  );
  return results;
}

function canonicalGraph(dbPath: string): unknown {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const all = (sql: string): unknown[] => db.prepare(sql).all();
    return {
      repositories: all(
        'SELECT id, repo_id, git_head FROM repositories ORDER BY id',
      ),
      files: all(
        'SELECT id, repository_id, relative_path, language, content_hash, size_bytes, line_count, grammar_id, grammar_abi, parse_status, has_errors FROM files ORDER BY id',
      ),
      symbols: all('SELECT * FROM symbols ORDER BY id'),
      edges: all('SELECT * FROM edges ORDER BY id'),
      communities: all('SELECT * FROM communities ORDER BY id'),
      communityMemberships: all(
        'SELECT * FROM community_memberships ORDER BY community_id, symbol_id',
      ),
      flows: all('SELECT * FROM flows ORDER BY id'),
      flowMemberships: all(
        'SELECT * FROM flow_memberships ORDER BY flow_id, symbol_id',
      ),
      fts: all(
        'SELECT symbol_id, name, qualified_name, signature, file_path FROM symbol_fts ORDER BY symbol_id',
      ),
      // Everything but the wall-clock time the diagnostics were recorded.
      diagnostics: all(
        "SELECT json_remove(value, '$.recordedAt') AS value FROM graph_metadata WHERE key = 'graph_diagnostics'",
      ),
    };
  } finally {
    db.close();
  }
}

describe('schema v4 index review (phase 18)', () => {
  it('pins the reviewed index set: a partial edge target index and a NOCASE name index', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'code-graph-index-set-'));
    const db = openCodeGraphDatabase(path.join(dir, 'graph.db'));
    try {
      for (const migration of CODE_GRAPH_MIGRATIONS) {
        if (migration.version <= 4) migration.up(db);
      }
      expect(
        Object.fromEntries(
          indexDefinitions(db).map((index) => [index.name, index.sql]),
        ),
      ).toEqual(V4_INDEXES);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pins the additive v5 mapping and dependency index set', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'code-graph-v5-index-set-'));
    const db = openCodeGraphDatabase(path.join(dir, 'graph.db'));
    try {
      runCodeGraphMigrations(db);
      expect(
        Object.fromEntries(
          indexDefinitions(db).map((index) => [index.name, index.sql]),
        ),
      ).toEqual(V5_INDEXES);
      expect(getMetadataValue(db, 'schema_version')).toBe('5');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('on a realistic graph', () => {
    let fixture: RealisticFixtureGraph;
    let db: CodeGraphDatabase;
    let v3Db: CodeGraphDatabase;

    beforeAll(async () => {
      fixture = await buildRealisticFixtureGraph(['fixture']);
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

    it('answers every query mode identically with the v3 and v4 index sets', () => {
      const v4Results = runEveryQueryMode(db);
      expect(v4Results.length).toBeGreaterThan(1_000);
      expect(v4Results).toEqual(runEveryQueryMode(v3Db));
    });

    it('changes no row-returning plan except symbol search seeking the new name index', () => {
      const recorder = recordingDatabase(db);
      runEveryQueryMode(recorder.db);
      const changed = new Set<string>();
      const seen = new Set<string>();
      let targetLookups = 0;
      for (const statement of recorder.executed) {
        const key = `${statement.sql}\0${JSON.stringify(statement.params)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const v4Plan = queryPlan(db, statement.sql, statement.params);
        if (
          v4Plan.some((detail) => detail.includes('idx_edges_target_symbol'))
        ) {
          targetLookups += 1;
        }
        if (
          JSON.stringify(v4Plan) !==
          JSON.stringify(queryPlan(v3Db, statement.sql, statement.params))
        ) {
          changed.add(statement.sql);
        }
      }
      // Target lookups still seek the (now partial) target index.
      expect(targetLookups).toBeGreaterThan(100);
      // A bare COUNT may pick a different (smaller) index; its value cannot
      // depend on the index, and the test above asserts it is unchanged.
      const rowReturning = Array.from(changed).filter(
        (sql) =>
          !/^SELECT COUNT\(\*\) AS n FROM \w+( WHERE [^()]*(\([^()]*\))?)?$/.test(
            sql,
          ),
      );
      expect(rowReturning).toEqual([
        expect.stringContaining('s.name LIKE ? ESCAPE'),
      ]);
    });
  });

  it('writes identical facts on a cold build and a refresh with the v3 and v4 index sets', async () => {
    const graphs: unknown[] = [];
    const roots: string[] = [];
    try {
      for (const indexSet of ['v3', 'v4'] as const) {
        const fixture = await buildRealisticFixtureGraph(
          ['fixture'],
          {},
          (db) => {
            if (indexSet === 'v3') useSchemaV3Indexes(db);
          },
        );
        roots.push(fixture.root);
        const engine = await CodeGraphEngine.open({
          dbPath: fixture.dbPath,
          repositories: [
            { repoId: 'fixture', rootPath: path.join(fixture.root, 'fixture') },
          ],
        });
        try {
          const check = openCodeGraphDatabase(fixture.dbPath);
          try {
            expect(getMetadataValue(check, 'schema_version')).toBe('5');
            expect(
              indexDefinitions(check).find(
                (index) => index.name === 'idx_edges_target_symbol',
              )?.sql,
            ).toBe(
              indexSet === 'v3'
                ? 'CREATE INDEX idx_edges_target_symbol ON edges(target_symbol_id)'
                : V4_INDEXES.idx_edges_target_symbol,
            );
          } finally {
            check.close();
          }
          const cold = canonicalGraph(fixture.dbPath);
          writeFileSync(
            path.join(fixture.root, 'fixture', 'store', 'database.ts'),
            'export function replaced(): number {\n  return 1;\n}\n',
          );
          await engine.buildOrUpdate();
          graphs.push({ cold, refreshed: canonicalGraph(fixture.dbPath) });
        } finally {
          engine.close();
        }
      }
      expect(graphs[1]).toEqual(graphs[0]);
    } finally {
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});
