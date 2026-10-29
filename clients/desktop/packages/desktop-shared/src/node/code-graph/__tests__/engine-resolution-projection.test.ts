import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { CodeGraphEngine } from '../engine';
import { readCodeGraphSummaryProjectionDatabase } from '../summary-projection';
import {
  isRecord,
  optionalString,
  requireNumber,
  requireRow,
  requireString,
} from '../store/database';

function put(root: string, relativePath: string, content: string): void {
  const absolutePath = path.join(root, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function remove(root: string, relativePath: string): void {
  const absolutePath = path.join(root, relativePath);
  if (existsSync(absolutePath)) unlinkSync(absolutePath);
}

function seedResolverCorpus(root: string): void {
  put(
    root,
    'tsconfig.base.json',
    JSON.stringify({
      compilerOptions: {
        baseUrl: '.',
        paths: {
          '@audit': ['src/lib.ts'],
          '@stars': ['src/cycle-a.ts'],
        },
      },
    }),
  );
  put(
    root,
    'tsconfig.other.json',
    JSON.stringify({
      compilerOptions: {
        baseUrl: '.',
        paths: {
          '@audit': ['src/alt.ts'],
          '@stars': ['src/cycle-a.ts'],
        },
      },
    }),
  );
  put(
    root,
    'tsconfig.json',
    JSON.stringify({ extends: './tsconfig.base.json' }),
  );
  put(root, 'src/lib.ts', 'export function work(): number { return 1; }\n');
  put(
    root,
    'src/noop.ts',
    'export function noop(): number { return 1; }\n// revision: 1\n',
  );
  put(root, 'src/alt.ts', 'export function work(): number { return 2; }\n');
  put(root, 'src/cycle-a.ts', "export * from './cycle-b';\n");
  put(
    root,
    'src/cycle-b.ts',
    "export * from './cycle-a';\nexport { work } from './lib';\n",
  );
  put(
    root,
    'src/main.ts',
    [
      "import { work as viaAlias } from '@audit';",
      "import { work as viaCycle } from '@stars';",
      "import { IPC_CHANNELS } from './shared/channels';",
      'export function run(): number { viaAlias(); viaCycle(); return 1; }',
      'export function register(): void { registerIpcHandler(IPC_CHANNELS.auditLoad, () => {}); }',
      'ipcRenderer.invoke(IPC_CHANNELS.auditLoad);',
      '// revision: 1',
      '',
    ].join('\n'),
  );
  put(
    root,
    'src/shared/channels.ts',
    "export const IPC_CHANNELS = { auditLoad: 'audit:load' } as const;\n",
  );
  put(
    root,
    'src/__tests__/main.test.ts',
    [
      "import { work } from '@audit';",
      'export function verifiesMain(): void { work(); }',
      '',
    ].join('\n'),
  );
  put(root, 'docs/usage.md', '[Main module](../src/main.ts)\n');
  put(
    root,
    'package.json',
    JSON.stringify({ scripts: { audit: 'node ./scripts/audit.js' } }),
  );
  put(
    root,
    '.github/workflows/ci.yml',
    [
      'name: CI',
      'on: push',
      'jobs:',
      '  check:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: ./.github/actions/local',
      '',
    ].join('\n'),
  );
  put(
    root,
    '.github/actions/local/action.yml',
    'name: Local\nruns:\n  using: node20\n  main: index.js\n',
  );
}

interface PriorCommunityHistory {
  communities: Array<{
    id: string;
    repositoryId: string;
    label: string;
    cohesion: number;
    size: number;
    fingerprint: string;
    extraJson: string;
  }>;
  memberships: Array<{ communityId: string; symbolId: string }>;
}

function readPriorCommunityHistory(dbPath: string): PriorCommunityHistory {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      communities: db
        .prepare('SELECT * FROM communities ORDER BY id')
        .all()
        .map((value) => {
          const row = requireRow(value);
          return {
            id: requireString(row, 'id'),
            repositoryId: requireString(row, 'repository_id'),
            label: requireString(row, 'label'),
            cohesion: requireNumber(row, 'cohesion'),
            size: requireNumber(row, 'size'),
            fingerprint: requireString(row, 'fingerprint'),
            extraJson: requireString(row, 'extra_json'),
          };
        }),
      memberships: db
        .prepare(
          'SELECT * FROM community_memberships ORDER BY community_id, symbol_id',
        )
        .all()
        .map((value) => {
          const row = requireRow(value);
          return {
            communityId: requireString(row, 'community_id'),
            symbolId: requireString(row, 'symbol_id'),
          };
        }),
    };
  } finally {
    db.close();
  }
}

/** Supply only pre-edit identity history; all graph facts are rebuilt cold. */
function seedPriorCommunityHistory(
  dbPath: string,
  history: PriorCommunityHistory,
): void {
  const db = new DatabaseSync(dbPath);
  try {
    for (const table of [
      'files',
      'symbols',
      'edges',
      'symbol_fts_rows',
      'communities',
      'community_memberships',
      'flows',
      'flow_memberships',
    ]) {
      expect(
        requireNumber(
          requireRow(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()),
          'n',
        ),
      ).toBe(0);
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const communityInsert = db.prepare(
        'INSERT INTO communities(id, repository_id, label, cohesion, size, fingerprint, extra_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      for (const community of history.communities) {
        communityInsert.run(
          community.id,
          community.repositoryId,
          community.label,
          community.cohesion,
          community.size,
          community.fingerprint,
          community.extraJson,
        );
      }
      const membershipInsert = db.prepare(
        'INSERT INTO community_memberships(community_id, symbol_id) VALUES (?, ?)',
      );
      for (const membership of history.memberships) {
        membershipInsert.run(membership.communityId, membership.symbolId);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
}

function jsonColumnRows(
  db: DatabaseSync,
  sql: string,
  column: string,
  ...parameters: string[]
): unknown[] {
  return db
    .prepare(sql)
    .all(...parameters)
    .map((row) => {
      const parsed: unknown = JSON.parse(String(row[column]));
      return { ...row, [column]: parsed };
    });
}

function canonicalGraphMetadata(db: DatabaseSync): unknown[] {
  const rows = db
    .prepare('SELECT key, value FROM graph_metadata ORDER BY key')
    .all()
    .map((value) => {
      const row = requireRow(value);
      return {
        key: requireString(row, 'key'),
        value: requireString(row, 'value'),
      };
    });
  const summaryProjection = rows.find(
    (row) => row.key === 'summary_projection_v1',
  );
  let normalizedSummaryProjection: string | null = null;
  if (summaryProjection !== undefined) {
    const parsed: unknown = JSON.parse(summaryProjection.value);
    if (isRecord(parsed) && !Array.isArray(parsed)) {
      const normalized: Record<string, unknown> = { ...parsed };
      delete normalized.projectionRevision;
      delete normalized.lastBuildAt;
      delete normalized.completedBuildAt;
      delete normalized.derivedAt;
      normalizedSummaryProjection = JSON.stringify(normalized);
    }
  }
  return rows.flatMap((row) => {
    if (
      row.key === 'last_build_at' ||
      row.key === 'completed_build_at' ||
      row.key === 'derived_at' ||
      row.key === 'time_to_first_graph_ms' ||
      row.key === 'summary_projection_revision' ||
      row.key.startsWith('build_timing:')
    ) {
      return [];
    }
    if (row.key === 'summary_projection_v1') {
      return normalizedSummaryProjection === null
        ? [{ key: row.key, value: row.value }]
        : [{ key: row.key, value: normalizedSummaryProjection }];
    }
    if (row.key === 'summary_projection_identity_v1') {
      // hashProjectionIdentity() includes projectionRevision and build-time
      // metadata in its digest. Compare its stable inputs (repository heads,
      // schema/extractor versions, and stable identity metadata) instead of
      // dropping the fingerprint or substituting the summary payload.
      return normalizedSummaryProjection === null
        ? [{ key: row.key, value: row.value }]
        : [
            {
              key: row.key,
              value: JSON.stringify({
                repositoryHeads: db
                  .prepare(
                    'SELECT repo_id, git_head FROM repositories ORDER BY repo_id',
                  )
                  .all(),
                metadataTokens: db
                  .prepare(
                    `SELECT key, value FROM graph_metadata
                   WHERE key IN (
                     'schema_version', 'extractor_version',
                     'imported_from_snapshot', 'derived_pending',
                     'custom_languages_fingerprint', 'custom_languages'
                   )
                   ORDER BY key`,
                  )
                  .all(),
              }),
            },
          ];
    }
    if (row.key === 'graph_diagnostics') {
      const parsed: unknown = JSON.parse(row.value);
      if (isRecord(parsed) && !Array.isArray(parsed)) {
        const normalized: Record<string, unknown> = { ...parsed };
        delete normalized.recordedAt;
        return [{ key: row.key, value: JSON.stringify(normalized) }];
      }
    }
    return [row];
  });
}

/** All durable facts and derived/search mappings; only timestamps are omitted. */
function canonicalGraph(dbPath: string): unknown {
  expect(readCodeGraphSummaryProjectionDatabase(dbPath).state).toBe('ready');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      repositories: db
        .prepare(
          'SELECT id, repo_id, root_path, git_head FROM repositories ORDER BY id',
        )
        .all(),
      files: db
        .prepare(
          `SELECT id, repository_id, relative_path, absolute_path, language,
             content_hash, size_bytes, line_count, grammar_id,
             grammar_abi, parse_status, has_errors
           FROM files ORDER BY id`,
        )
        .all(),
      symbols: jsonColumnRows(
        db,
        'SELECT * FROM symbols ORDER BY id',
        'extra_json',
      ),
      edges: jsonColumnRows(
        db,
        'SELECT * FROM edges ORDER BY id',
        'evidence_json',
      ),
      communities: jsonColumnRows(
        db,
        'SELECT * FROM communities ORDER BY id',
        'extra_json',
      ),
      communityMemberships: db
        .prepare(
          'SELECT * FROM community_memberships ORDER BY community_id, symbol_id',
        )
        .all(),
      flows: jsonColumnRows(
        db,
        'SELECT * FROM flows ORDER BY id',
        'extra_json',
      ),
      flowMemberships: db
        .prepare('SELECT * FROM flow_memberships ORDER BY flow_id, symbol_id')
        .all(),
      symbolFtsMappings: db
        .prepare(
          `SELECT m.symbol_id, m.file_id, m.repository_id,
             sf.symbol_id AS search_symbol_id, sf.name AS search_name,
             sf.qualified_name AS search_qualified_name,
             sf.signature AS search_signature, sf.file_path AS search_file_path,
             fragment.symbol_id AS fragment_symbol_id,
             fragment.name_folded, fragment.qualified_name_folded
           FROM symbol_fts_rows m
           LEFT JOIN symbol_fts sf ON sf.rowid = m.symbol_fts_rowid
           LEFT JOIN symbol_fragment_fts fragment
             ON fragment.rowid = m.fragment_fts_rowid
           ORDER BY m.symbol_id`,
        )
        .all(),
      symbolFts: db
        .prepare(
          'SELECT symbol_id, name, qualified_name, signature, file_path FROM symbol_fts ORDER BY symbol_id',
        )
        .all(),
      symbolFragmentFts: db
        .prepare(
          'SELECT symbol_id, name_folded, qualified_name_folded FROM symbol_fragment_fts ORDER BY symbol_id',
        )
        .all(),
      resolutionDependencies: db
        .prepare(
          `SELECT repository_id, resolver, source_file_id, source_edge_id,
             dependency_kind, dependency_key, dependency_value
           FROM resolution_dependencies
           ORDER BY repository_id, resolver, source_file_id, source_edge_id,
             dependency_kind, dependency_key`,
        )
        .all(),
      resolutionFingerprints: db
        .prepare(
          `SELECT key, value FROM graph_metadata
           WHERE key LIKE 'resolution_inputs:%' ORDER BY key`,
        )
        .all(),
      stableGraphMetadata: canonicalGraphMetadata(db),
    };
  } finally {
    db.close();
  }
}

/** Validate FTS row ownership by semantic joins, not allocated rowid values. */
function assertFtsMappingIntegrity(dbPath: string): void {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const counts = requireRow(
      db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM symbols) AS symbol_count,
             (SELECT COUNT(*) FROM symbol_fts_rows) AS mapping_count,
             (SELECT COUNT(*) FROM symbol_fts) AS search_count,
             (SELECT COUNT(*) FROM symbol_fragment_fts) AS fragment_count`,
        )
        .get(),
    );
    const symbolCount = requireNumber(counts, 'symbol_count');
    expect(requireNumber(counts, 'mapping_count')).toBe(symbolCount);
    expect(requireNumber(counts, 'search_count')).toBe(symbolCount);
    expect(requireNumber(counts, 'fragment_count')).toBe(symbolCount);
    const invalidMappings = requireNumber(
      requireRow(
        db
          .prepare(
            `SELECT COUNT(*) AS n
             FROM symbols s
             LEFT JOIN files f ON f.id = s.file_id
             LEFT JOIN symbol_fts_rows m ON m.symbol_id = s.id
             LEFT JOIN symbol_fts sf ON sf.rowid = m.symbol_fts_rowid
             LEFT JOIN symbol_fragment_fts fragment
               ON fragment.rowid = m.fragment_fts_rowid
             WHERE m.symbol_id IS NULL OR m.file_id <> s.file_id
                OR m.repository_id <> s.repository_id
                OR sf.rowid IS NULL OR sf.symbol_id <> s.id
                OR sf.name <> s.name OR sf.qualified_name <> s.qualified_name
                OR sf.signature <> COALESCE(s.signature, '')
                OR sf.file_path <> f.relative_path
                OR fragment.rowid IS NULL OR fragment.symbol_id <> s.id`,
          )
          .get(),
      ),
      'n',
    );
    expect(invalidMappings).toBe(0);
    const orphanFtsRows = requireNumber(
      requireRow(
        db
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM symbol_fts sf
                LEFT JOIN symbol_fts_rows m
                  ON m.symbol_fts_rowid = sf.rowid
                WHERE m.symbol_id IS NULL)
               +
               (SELECT COUNT(*) FROM symbol_fragment_fts fragment
                LEFT JOIN symbol_fts_rows m
                  ON m.fragment_fts_rowid = fragment.rowid
                WHERE m.symbol_id IS NULL) AS n`,
          )
          .get(),
      ),
      'n',
    );
    expect(orphanFtsRows).toBe(0);
  } finally {
    db.close();
  }
}

function canonicalRepoGraph(dbPath: string, repoId: string): unknown {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const repositoryRowId = requireString(
      requireRow(
        db.prepare('SELECT id FROM repositories WHERE repo_id = ?').get(repoId),
      ),
      'id',
    );
    return {
      repository: db
        .prepare(
          'SELECT id, repo_id, root_path, git_head FROM repositories WHERE id = ?',
        )
        .get(repositoryRowId),
      files: db
        .prepare(
          `SELECT id, repository_id, relative_path, absolute_path, language,
             content_hash, size_bytes, line_count, grammar_id,
             grammar_abi, parse_status, has_errors
           FROM files WHERE repository_id = ? ORDER BY id`,
        )
        .all(repositoryRowId),
      symbols: jsonColumnRows(
        db,
        'SELECT * FROM symbols WHERE repository_id = ? ORDER BY id',
        'extra_json',
      ),
      edges: jsonColumnRows(
        db,
        'SELECT * FROM edges WHERE repository_id = ? ORDER BY id',
        'evidence_json',
      ),
      communities: jsonColumnRows(
        db,
        'SELECT * FROM communities WHERE repository_id = ? ORDER BY id',
        'extra_json',
      ),
      flows: jsonColumnRows(
        db,
        'SELECT * FROM flows WHERE repository_id = ? ORDER BY id',
        'extra_json',
      ),
      communityMemberships: db
        .prepare(
          `SELECT membership.community_id, membership.symbol_id
           FROM community_memberships membership
           JOIN communities community ON community.id = membership.community_id
           WHERE community.repository_id = ?
           ORDER BY membership.community_id, membership.symbol_id`,
        )
        .all(repositoryRowId),
      flowMemberships: db
        .prepare(
          `SELECT membership.flow_id, membership.symbol_id, membership.depth
           FROM flow_memberships membership
           JOIN flows flow ON flow.id = membership.flow_id
           WHERE flow.repository_id = ?
           ORDER BY membership.flow_id, membership.symbol_id`,
        )
        .all(repositoryRowId),
      symbolFtsMappings: db
        .prepare(
          `SELECT m.symbol_id, m.file_id, m.repository_id,
             sf.symbol_id AS search_symbol_id, sf.name AS search_name,
             sf.qualified_name AS search_qualified_name,
             sf.signature AS search_signature, sf.file_path AS search_file_path,
             fragment.symbol_id AS fragment_symbol_id,
             fragment.name_folded, fragment.qualified_name_folded
           FROM symbol_fts_rows m
           LEFT JOIN symbol_fts sf ON sf.rowid = m.symbol_fts_rowid
           LEFT JOIN symbol_fragment_fts fragment
             ON fragment.rowid = m.fragment_fts_rowid
           WHERE m.repository_id = ? ORDER BY m.symbol_id`,
        )
        .all(repositoryRowId),
      symbolFts: db
        .prepare(
          `SELECT sf.symbol_id, sf.name, sf.qualified_name, sf.signature, sf.file_path
           FROM symbol_fts sf
           JOIN symbol_fts_rows m ON m.symbol_fts_rowid = sf.rowid
           WHERE m.repository_id = ? ORDER BY sf.symbol_id`,
        )
        .all(repositoryRowId),
      symbolFragmentFts: db
        .prepare(
          `SELECT fragment.symbol_id, fragment.name_folded,
             fragment.qualified_name_folded
           FROM symbol_fragment_fts fragment
           JOIN symbol_fts_rows m ON m.fragment_fts_rowid = fragment.rowid
           WHERE m.repository_id = ? ORDER BY fragment.symbol_id`,
        )
        .all(repositoryRowId),
      resolutionDependencies: db
        .prepare(
          `SELECT repository_id, resolver, source_file_id, source_edge_id,
             dependency_kind, dependency_key, dependency_value
           FROM resolution_dependencies WHERE repository_id = ?
           ORDER BY repository_id, resolver, source_file_id, source_edge_id,
             dependency_kind, dependency_key`,
        )
        .all(repositoryRowId),
      resolutionFingerprints: db
        .prepare(
          `SELECT key, value FROM graph_metadata WHERE key = ? ORDER BY key`,
        )
        .all(`resolution_inputs:${repoId}`),
    };
  } finally {
    db.close();
  }
}

interface EdgeResolutionState {
  targetSymbolId: string | null;
  resolverId: string | null;
  evidence: Record<string, unknown>;
}

function edgeResolutionStates(
  dbPath: string,
  repoId: string,
  kind: string,
  targetRef: string,
): EdgeResolutionState[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT e.target_symbol_id, e.resolver_id, e.evidence_json
         FROM edges e JOIN repositories r ON r.id = e.repository_id
         WHERE r.repo_id = ? AND e.kind = ? AND e.target_ref = ?
         ORDER BY e.id`,
      )
      .all(repoId, kind, targetRef)
      .map((value) => {
        const row = requireRow(value);
        const evidence: unknown = JSON.parse(
          requireString(row, 'evidence_json'),
        );
        if (!isRecord(evidence) || Array.isArray(evidence)) {
          throw new Error('Edge evidence is not an object');
        }
        return {
          targetSymbolId: optionalString(row, 'target_symbol_id'),
          resolverId: optionalString(row, 'resolver_id'),
          evidence,
        };
      });
  } finally {
    db.close();
  }
}

function edgeTargetPaths(
  dbPath: string,
  repoId: string,
  kind: string,
  targetRef: string,
): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT f.relative_path FROM edges e
         JOIN repositories r ON r.id = e.repository_id
         JOIN symbols s ON s.id = e.target_symbol_id
         JOIN files f ON f.id = s.file_id
         WHERE r.repo_id = ? AND e.kind = ? AND e.target_ref = ?
         ORDER BY e.id`,
      )
      .all(repoId, kind, targetRef)
      .map((value) => requireString(requireRow(value), 'relative_path'));
  } finally {
    db.close();
  }
}

function testLinkCount(dbPath: string, repoId: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return requireNumber(
      requireRow(
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM edges e
             JOIN repositories r ON r.id = e.repository_id
             WHERE r.repo_id = ? AND e.kind = 'TESTED_BY'
               AND e.resolver_id = 'test-linker'`,
          )
          .get(repoId),
      ),
      'n',
    );
  } finally {
    db.close();
  }
}

function testLinkIds(dbPath: string, repoId: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT e.id FROM edges e
         JOIN repositories r ON r.id = e.repository_id
         WHERE r.repo_id = ? AND e.kind = 'TESTED_BY'
           AND e.resolver_id = 'test-linker'
         ORDER BY e.id`,
      )
      .all(repoId)
      .map((value) => requireString(requireRow(value), 'id'));
  } finally {
    db.close();
  }
}

function resolutionDependencyRows(dbPath: string): unknown[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT repository_id, resolver, source_file_id, source_edge_id,
           dependency_kind, dependency_key, dependency_value
         FROM resolution_dependencies
         ORDER BY repository_id, resolver, source_file_id, source_edge_id,
           dependency_kind, dependency_key`,
      )
      .all();
  } finally {
    db.close();
  }
}

/** Exercise every public CodeGraphQueryService surface, including search. */
function publicQueryOutputs(
  engine: CodeGraphEngine,
  repoId: string,
): Record<string, unknown> {
  const queries = engine.queries();
  const status = engine.getStatus();
  const diagnostics = status.diagnostics;
  const stableDiagnostics =
    diagnostics === null || diagnostics === undefined
      ? diagnostics
      : Object.fromEntries(
          Object.entries(diagnostics).filter(([key]) => key !== 'recordedAt'),
        );
  return {
    status: {
      ...status,
      lastBuildAt: null,
      derivedAt: null,
      diagnostics: stableDiagnostics,
    },
    callPath: queries.getRelationshipPath({
      target: 'src/main.ts::run',
      to: 'src/lib.ts::work',
      mode: 'call-path',
      repoId,
    }),
    relationshipPath: queries.getRelationshipPath({
      target: 'src/lib.ts::work',
      to: 'src/main.ts::run',
      mode: 'relationship-path',
      repoId,
    }),
    callers: queries.getCallers('src/lib.ts::work', repoId),
    callees: queries.getCallees('src/main.ts::run', repoId),
    importers: queries.getImporters('src/lib.ts', repoId),
    imports: queries.getImports('src/main.ts', repoId),
    children: queries.getChildren('src/main.ts::run', repoId),
    symbolDetail: queries.getSymbolDetail('src/main.ts::run', repoId),
    testsFor: queries.getTestsFor('src/lib.ts::work', repoId),
    fileSummary: queries.getFileSummary('src/main.ts', repoId),
    searchExactAndRanked: queries.search('work', 20, repoId),
    searchPrefixRanked: queries.search('wor', 20, repoId),
    searchFragmentRanked: queries.search('ork', 20, repoId),
    docsFor: queries.getDocsFor('src/main.ts', repoId),
    rationaleFor: queries.getRationaleFor('src/lib.ts::work', repoId),
    scriptsFor: queries.getScriptsForFile('package.json', repoId),
    ipcChannel: queries.getIpcChannel('auditLoad', repoId),
    impactRadius: queries.getImpactRadius(
      'src/lib.ts::work',
      { maxDepth: 4, maxNodes: 100 },
      repoId,
    ),
    communities: queries.listCommunities(repoId, 20),
    flows: queries.listFlows(repoId, 20),
    flowsForSymbol: queries.listFlowsForSymbol('src/lib.ts::work', repoId, 20),
    topDegree: queries.listTopDegreeSymbols(repoId, 20),
    communityForSymbol: queries.getCommunityForSymbol(
      'src/lib.ts::work',
      repoId,
    ),
    crossCommunityCallers: queries.countCrossCommunityCallers(
      'src/lib.ts::work',
      repoId,
    ),
    derivedStats: queries.getDerivedStats(repoId),
    symbolSummaries: engine.listSymbols(repoId),
  };
}

function resolutionRepositories(
  repoARoot: string,
  repoBRoot: string,
): Array<{ repoId: string; rootPath: string }> {
  return [
    { repoId: 'repo-a', rootPath: repoARoot },
    { repoId: 'repo-b', rootPath: repoBRoot },
  ];
}

describe('W2 full-resolution diff oracle', () => {
  it('matches full-reset and cold facts plus every query after each adversarial edit', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'code-graph-w2-oracle-'));
    const repoARoot = path.join(root, 'repo-a');
    const repoBRoot = path.join(root, 'repo-b');
    const repositories = resolutionRepositories(repoARoot, repoBRoot);
    seedResolverCorpus(repoARoot);
    seedResolverCorpus(repoBRoot);
    const resetPath = path.join(root, '.reset', 'graph.db');
    const diffPath = path.join(root, '.diff', 'graph.db');
    const reset = await CodeGraphEngine.open({
      dbPath: resetPath,
      repositories,
    });
    const diff = await CodeGraphEngine.open({ dbPath: diffPath, repositories });
    let cold: CodeGraphEngine | undefined;
    let coldPath = '';
    let coldIndex = 0;
    let priorHistory: PriorCommunityHistory = {
      communities: [],
      memberships: [],
    };

    const compareWithCold = async (): Promise<void> => {
      coldIndex += 1;
      coldPath = path.join(root, `.cold-${coldIndex}`, 'graph.db');
      cold = await CodeGraphEngine.open({ dbPath: coldPath, repositories });
      try {
        seedPriorCommunityHistory(coldPath, priorHistory);
        // The fresh store has no extractor fingerprint, so its first pass
        // takes the engine's full-reparse path and records `reparsed`
        // freshness. Verify the same content on a second pass so reset, diff,
        // and cold outputs are compared at explicit content-verification.
        await cold.buildOrUpdate();
        await cold.buildOrUpdate({ verifyContent: true });
        for (const databasePath of [resetPath, diffPath, coldPath]) {
          assertFtsMappingIntegrity(databasePath);
          // W3's schema-5 placeholder stays empty in the W2 implementation.
          expect(resolutionDependencyRows(databasePath)).toEqual([]);
        }
        expect(canonicalGraph(resetPath)).toEqual(canonicalGraph(diffPath));
        expect(canonicalGraph(diffPath)).toEqual(canonicalGraph(coldPath));
        for (const repoId of ['repo-a', 'repo-b']) {
          expect(publicQueryOutputs(reset, repoId)).toEqual(
            publicQueryOutputs(diff, repoId),
          );
          expect(publicQueryOutputs(diff, repoId)).toEqual(
            publicQueryOutputs(cold, repoId),
          );
        }
      } finally {
        cold.close();
        cold = undefined;
      }
    };

    const buildAfterEdit = async (): Promise<void> => {
      priorHistory = readPriorCommunityHistory(resetPath);
      await reset.buildOrUpdate({ verifyContent: true });
      await diff.buildOrUpdate({
        resolutionMode: 'full-diff',
        verifyContent: true,
      });
      await compareWithCold();
    };

    try {
      await reset.buildOrUpdate();
      await diff.buildOrUpdate({ resolutionMode: 'full-diff' });
      await reset.buildOrUpdate({ verifyContent: true });
      await diff.buildOrUpdate({
        resolutionMode: 'full-diff',
        verifyContent: true,
      });
      await compareWithCold();
      const viaCycleBefore = edgeResolutionStates(
        diffPath,
        'repo-a',
        'CALLS',
        'viaCycle',
      );
      expect(viaCycleBefore.length).toBeGreaterThan(0);
      expect(viaCycleBefore.some((edge) => edge.targetSymbolId !== null)).toBe(
        true,
      );
      const viaCycleTargetBefore = viaCycleBefore.find(
        (edge) => edge.targetSymbolId !== null,
      )?.targetSymbolId;
      expect(viaCycleTargetBefore).toBeDefined();
      expect(edgeTargetPaths(diffPath, 'repo-a', 'CALLS', 'viaCycle')).toEqual([
        'src/lib.ts',
      ]);
      const ipcBefore = diff.queries().getIpcChannel('auditLoad', 'repo-a');
      expect(ipcBefore.channel).not.toBeNull();
      expect(ipcBefore.ambiguousCount).toBe(0);
      expect(ipcBefore.handlers.length).toBeGreaterThan(0);
      expect(ipcBefore.invokers.length).toBeGreaterThan(0);
      const ipcQualifiedNameBefore = ipcBefore.channel?.qualifiedName;
      const ipcInvokerBefore = edgeResolutionStates(
        diffPath,
        'repo-a',
        'IPC_INVOKES',
        'ipc:auditLoad',
      );
      const ipcHandlerBefore = edgeResolutionStates(
        diffPath,
        'repo-a',
        'IPC_HANDLES',
        'ipc:auditLoad',
      );
      expect(
        ipcInvokerBefore.some((edge) => edge.targetSymbolId !== null),
      ).toBe(true);
      expect(
        ipcHandlerBefore.some((edge) => edge.targetSymbolId !== null),
      ).toBe(true);
      const workflowBefore = edgeResolutionStates(
        diffPath,
        'repo-a',
        'USES_PIPELINE_ACTION',
        './.github/actions/local',
      );
      expect(workflowBefore.length).toBeGreaterThan(0);
      expect(workflowBefore.some((edge) => edge.targetSymbolId !== null)).toBe(
        true,
      );
      const workflowTargetBefore = workflowBefore.find(
        (edge) => edge.targetSymbolId !== null,
      )?.targetSymbolId;
      expect(workflowTargetBefore).toBeDefined();
      expect(
        edgeTargetPaths(
          diffPath,
          'repo-a',
          'USES_PIPELINE_ACTION',
          './.github/actions/local',
        ),
      ).toEqual(['.github/actions/local/action.yml']);
      const repoBBefore = {
        facts: canonicalRepoGraph(diffPath, 'repo-b'),
        queries: publicQueryOutputs(diff, 'repo-b'),
        repositoryStatus: diff
          .getStatus()
          .repositories.find((repository) => repository.repoId === 'repo-b'),
        repositoryDiagnostics: diff
          .getStatus()
          .diagnostics?.repositories.find(
            (repository) => repository.repoId === 'repo-b',
          ),
      };
      expect(repoBBefore.repositoryStatus).toBeDefined();
      expect(repoBBefore.repositoryDiagnostics).toBeDefined();

      // Add a second star-export candidate through a cyclic alias chain.
      put(
        repoARoot,
        'src/conflict.ts',
        'export function work(): number { return 3; }\n',
      );
      put(
        repoARoot,
        'src/cycle-b.ts',
        "export * from './cycle-a';\nexport * from './lib';\nexport * from './conflict';\n",
      );
      await buildAfterEdit();
      expect(
        edgeResolutionStates(diffPath, 'repo-a', 'CALLS', 'viaCycle').some(
          (edge) =>
            edge.targetSymbolId === null && edge.evidence.candidates === 2,
        ),
      ).toBe(true);

      // Removing the competing star restores the unique binding.
      put(
        repoARoot,
        'src/cycle-b.ts',
        "export * from './cycle-a';\nexport { work } from './lib';\n",
      );
      remove(repoARoot, 'src/conflict.ts');
      await buildAfterEdit();
      expect(
        edgeResolutionStates(diffPath, 'repo-a', 'CALLS', 'viaCycle').some(
          (edge) => edge.targetSymbolId !== null,
        ),
      ).toBe(true);
      expect(
        edgeResolutionStates(diffPath, 'repo-a', 'CALLS', 'viaCycle').every(
          (edge) => edge.evidence.candidates === undefined,
        ),
      ).toBe(true);
      expect(
        edgeResolutionStates(diffPath, 'repo-a', 'CALLS', 'viaCycle').map(
          (edge) => edge.targetSymbolId,
        ),
      ).toEqual(viaCycleBefore.map((edge) => edge.targetSymbolId));
      expect(edgeTargetPaths(diffPath, 'repo-a', 'CALLS', 'viaCycle')).toEqual([
        'src/lib.ts',
      ]);

      // A config inheritance change retargets the untouched @audit consumer.
      const auditTargetsBeforeRetarget = edgeResolutionStates(
        diffPath,
        'repo-a',
        'IMPORTS_FROM',
        '@audit',
      )
        .map((edge) => edge.targetSymbolId)
        .filter((target): target is string => target !== null);
      expect(auditTargetsBeforeRetarget.length).toBeGreaterThan(0);
      expect(
        edgeTargetPaths(diffPath, 'repo-a', 'IMPORTS_FROM', '@audit'),
      ).toEqual(['src/lib.ts', 'src/lib.ts']);
      put(
        repoARoot,
        'tsconfig.json',
        JSON.stringify({ extends: './tsconfig.other.json' }),
      );
      await buildAfterEdit();
      const auditTargetsAfterRetarget = edgeResolutionStates(
        diffPath,
        'repo-a',
        'IMPORTS_FROM',
        '@audit',
      )
        .map((edge) => edge.targetSymbolId)
        .filter((target): target is string => target !== null);
      expect(auditTargetsAfterRetarget.length).toBeGreaterThan(0);
      expect(auditTargetsAfterRetarget).not.toEqual(auditTargetsBeforeRetarget);
      expect(
        auditTargetsAfterRetarget.some(
          (target) => !auditTargetsBeforeRetarget.includes(target),
        ),
      ).toBe(true);
      expect(
        edgeTargetPaths(diffPath, 'repo-a', 'IMPORTS_FROM', '@audit'),
      ).toEqual(['src/alt.ts', 'src/alt.ts']);
      expect(testLinkCount(diffPath, 'repo-a')).toBeGreaterThan(0);
      const testLinkIdsAfterRetarget = testLinkIds(diffPath, 'repo-a');
      expect(testLinkIdsAfterRetarget.length).toBeGreaterThan(0);

      // The stable inferred TESTED_BY row is deleted when the edited test no
      // longer calls its production target, then re-added when restored.
      put(
        repoARoot,
        'src/__tests__/main.test.ts',
        "import { work } from '@audit';\nexport function verifiesMain(): void {}\n",
      );
      await buildAfterEdit();
      expect(testLinkIds(diffPath, 'repo-a')).toEqual([]);
      put(
        repoARoot,
        'src/__tests__/main.test.ts',
        "import { work } from '@audit';\nexport function verifiesMain(): void { work(); }\n",
      );
      await buildAfterEdit();
      expect(testLinkCount(diffPath, 'repo-a')).toBeGreaterThan(0);
      expect(testLinkIds(diffPath, 'repo-a')).toEqual(testLinkIdsAfterRetarget);

      // Removing the target turns old imports/calls unresolved and removes its
      // inferred TESTED_BY row; no stale destination may survive.
      const testLinksBeforeTargetDelete = testLinkCount(diffPath, 'repo-a');
      const auditTargetsBeforeDelete = edgeResolutionStates(
        diffPath,
        'repo-a',
        'IMPORTS_FROM',
        '@audit',
      ).filter((edge) => edge.targetSymbolId !== null);
      expect(testLinksBeforeTargetDelete).toBeGreaterThan(0);
      expect(auditTargetsBeforeDelete.length).toBeGreaterThan(0);
      remove(repoARoot, 'src/alt.ts');
      await buildAfterEdit();
      const auditTargetsAfterDelete = edgeResolutionStates(
        diffPath,
        'repo-a',
        'IMPORTS_FROM',
        '@audit',
      );
      expect(auditTargetsAfterDelete.length).toBeGreaterThan(0);
      expect(
        auditTargetsAfterDelete.every((edge) => edge.targetSymbolId === null),
      ).toBe(true);
      expect(testLinkCount(diffPath, 'repo-a')).toBe(0);
      expect(testLinkIds(diffPath, 'repo-a')).toEqual([]);

      // A second IPC declaration adds and then removes ambiguity evidence.
      put(
        repoARoot,
        'src/shared/duplicate.ts',
        "export const IPC_CHANNELS = { auditLoad: 'audit:load' } as const;\n",
      );
      await buildAfterEdit();
      const ipcAmbiguous = diff.queries().getIpcChannel('auditLoad', 'repo-a');
      expect(ipcAmbiguous).toMatchObject({ ambiguousCount: 2, channel: null });
      expect(ipcAmbiguous.handlers).toHaveLength(0);
      expect(ipcAmbiguous.invokers).toHaveLength(0);
      for (const kind of ['IPC_INVOKES', 'IPC_HANDLES']) {
        expect(
          edgeResolutionStates(diffPath, 'repo-a', kind, 'ipc:auditLoad').some(
            (edge) =>
              edge.targetSymbolId === null && edge.evidence.candidates === 2,
          ),
        ).toBe(true);
      }
      expect(publicQueryOutputs(diff, 'repo-a').ipcChannel).toEqual(
        publicQueryOutputs(reset, 'repo-a').ipcChannel,
      );
      remove(repoARoot, 'src/shared/duplicate.ts');
      await buildAfterEdit();
      const ipcAfterRemoval = diff
        .queries()
        .getIpcChannel('auditLoad', 'repo-a');
      expect(ipcAfterRemoval).toMatchObject({
        ambiguousCount: 0,
      });
      expect(ipcAfterRemoval.channel).not.toBeNull();
      expect(ipcAfterRemoval.channel?.qualifiedName).toBe(
        ipcQualifiedNameBefore,
      );
      expect(ipcAfterRemoval.channel?.filePath).toBe('src/shared/channels.ts');
      expect(ipcAfterRemoval.handlers.length).toBeGreaterThan(0);
      expect(ipcAfterRemoval.invokers.length).toBeGreaterThan(0);
      expect(ipcAfterRemoval.handlers).toEqual(ipcBefore.handlers);
      expect(ipcAfterRemoval.invokers).toEqual(ipcBefore.invokers);
      expect(
        ipcAfterRemoval.handlers.map((handler) => handler.filePath),
      ).toEqual(['src/main.ts']);
      expect(
        ipcAfterRemoval.invokers.map((invoker) => invoker.filePath),
      ).toEqual(['src/main.ts']);
      expect(
        edgeResolutionStates(
          diffPath,
          'repo-a',
          'IPC_INVOKES',
          'ipc:auditLoad',
        ).map((edge) => edge.targetSymbolId),
      ).toEqual(ipcInvokerBefore.map((edge) => edge.targetSymbolId));
      expect(
        edgeTargetPaths(diffPath, 'repo-a', 'IPC_INVOKES', 'ipc:auditLoad'),
      ).toEqual(['src/shared/channels.ts']);
      expect(
        edgeResolutionStates(
          diffPath,
          'repo-a',
          'IPC_HANDLES',
          'ipc:auditLoad',
        ).map((edge) => edge.targetSymbolId),
      ).toEqual(ipcHandlerBefore.map((edge) => edge.targetSymbolId));
      expect(
        edgeTargetPaths(diffPath, 'repo-a', 'IPC_HANDLES', 'ipc:auditLoad'),
      ).toEqual(['src/shared/channels.ts']);
      for (const kind of ['IPC_INVOKES', 'IPC_HANDLES']) {
        const restoredEdges = edgeResolutionStates(
          diffPath,
          'repo-a',
          kind,
          'ipc:auditLoad',
        );
        expect(restoredEdges.length).toBeGreaterThan(0);
        expect(
          restoredEdges.every((edge) => edge.targetSymbolId !== null),
        ).toBe(true);
        expect(
          restoredEdges.every((edge) => edge.evidence.candidates === undefined),
        ).toBe(true);
      }

      // The same workflow action target moves unresolved -> ambiguous -> unique
      // -> unresolved as manifests are added and removed.
      put(
        repoARoot,
        '.github/actions/local/action.yaml',
        'name: Duplicate\nruns:\n  using: node20\n  main: index.js\n',
      );
      await buildAfterEdit();
      const workflowAmbiguous = edgeResolutionStates(
        diffPath,
        'repo-a',
        'USES_PIPELINE_ACTION',
        './.github/actions/local',
      );
      expect(
        workflowAmbiguous.some(
          (edge) =>
            edge.targetSymbolId === null && edge.evidence.candidates === 2,
        ),
      ).toBe(true);
      expect(
        workflowAmbiguous.every((edge) => edge.targetSymbolId === null),
      ).toBe(true);
      remove(repoARoot, '.github/actions/local/action.yaml');
      await buildAfterEdit();
      const workflowAfterAmbiguityRemoval = edgeResolutionStates(
        diffPath,
        'repo-a',
        'USES_PIPELINE_ACTION',
        './.github/actions/local',
      );
      expect(
        workflowAfterAmbiguityRemoval.some(
          (edge) => edge.targetSymbolId !== null,
        ),
      ).toBe(true);
      expect(
        workflowAfterAmbiguityRemoval.every(
          (edge) => edge.evidence.candidates === undefined,
        ),
      ).toBe(true);
      const workflowTargetBeforeDelete = workflowAfterAmbiguityRemoval.find(
        (edge) => edge.targetSymbolId !== null,
      )?.targetSymbolId;
      expect(workflowTargetBeforeDelete).toBe(workflowTargetBefore);
      expect(
        edgeTargetPaths(
          diffPath,
          'repo-a',
          'USES_PIPELINE_ACTION',
          './.github/actions/local',
        ),
      ).toEqual(['.github/actions/local/action.yml']);
      remove(repoARoot, '.github/actions/local/action.yml');
      await buildAfterEdit();
      const workflowAfterDelete = edgeResolutionStates(
        diffPath,
        'repo-a',
        'USES_PIPELINE_ACTION',
        './.github/actions/local',
      );
      expect(workflowAfterDelete.length).toBeGreaterThan(0);
      expect(
        workflowAfterDelete.every((edge) => edge.targetSymbolId === null),
      ).toBe(true);
      expect(testLinkIds(diffPath, 'repo-a')).toEqual([]);

      expect(publicQueryOutputs(diff, 'repo-b')).toEqual(
        publicQueryOutputs(reset, 'repo-b'),
      );
      expect(canonicalRepoGraph(diffPath, 'repo-b')).toEqual(repoBBefore.facts);
      // Status covers the whole graph, so repo-a edits legitimately change its
      // totals. Compare every current global field to the independent reset
      // oracle, while pinning repo-b's own header and diagnostics to history.
      expect(publicQueryOutputs(diff, 'repo-b')).toEqual({
        ...repoBBefore.queries,
        status: publicQueryOutputs(reset, 'repo-b').status,
      });
      expect(
        diff
          .getStatus()
          .repositories.find((repository) => repository.repoId === 'repo-b'),
      ).toEqual(repoBBefore.repositoryStatus);
      expect(
        diff
          .getStatus()
          .diagnostics?.repositories.find(
            (repository) => repository.repoId === 'repo-b',
          ),
      ).toEqual(repoBBefore.repositoryDiagnostics);
    } finally {
      cold?.close();
      reset.close();
      diff.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('writes zero relationship rows for a resolver-free same-width edit', async () => {
    const fixtureRoot = mkdtempSync(
      path.join(tmpdir(), 'code-graph-w2-no-op-'),
    );
    const root = path.join(fixtureRoot, 'repo');
    seedResolverCorpus(root);
    // A comment-only file has no extracted containment/import/call edges.
    put(root, 'src/noop.ts', '// revision: 1\n');
    const repositories = [{ repoId: 'fixture', rootPath: root }];
    const diffPath = path.join(fixtureRoot, '.diff', 'graph.db');
    const resetPath = path.join(fixtureRoot, '.reset', 'graph.db');
    const diff = await CodeGraphEngine.open({ dbPath: diffPath, repositories });
    const reset = await CodeGraphEngine.open({
      dbPath: resetPath,
      repositories,
    });
    const audit = new DatabaseSync(diffPath);
    let cold: CodeGraphEngine | undefined;
    try {
      await diff.buildOrUpdate({ resolutionMode: 'full-diff' });
      await reset.buildOrUpdate();
      await diff.buildOrUpdate({
        resolutionMode: 'full-diff',
        verifyContent: true,
      });
      await reset.buildOrUpdate({ verifyContent: true });
      const edgeCount = requireNumber(
        requireRow(audit.prepare('SELECT COUNT(*) AS n FROM edges').get()),
        'n',
      );
      expect(edgeCount).toBeGreaterThan(0);
      expect(
        requireNumber(
          requireRow(
            audit
              .prepare(
                "SELECT COUNT(*) AS n FROM edges e JOIN files f ON f.id = e.source_file_id WHERE f.relative_path = 'src/noop.ts'",
              )
              .get(),
          ),
          'n',
        ),
      ).toBe(0);
      audit.exec(`
        CREATE TABLE w2_edge_write_audit (
          sequence INTEGER PRIMARY KEY,
          operation TEXT NOT NULL,
          edge_id TEXT NOT NULL,
          source_file_id TEXT NOT NULL,
          resolver_id TEXT
        );
        CREATE TRIGGER w2_audit_edge_insert AFTER INSERT ON edges BEGIN
          INSERT INTO w2_edge_write_audit(operation, edge_id, source_file_id, resolver_id)
          VALUES ('insert', NEW.id, NEW.source_file_id, NEW.resolver_id);
        END;
        CREATE TRIGGER w2_audit_edge_update AFTER UPDATE ON edges BEGIN
          INSERT INTO w2_edge_write_audit(operation, edge_id, source_file_id, resolver_id)
          VALUES ('update', NEW.id, NEW.source_file_id, NEW.resolver_id);
        END;
        CREATE TRIGGER w2_audit_edge_delete AFTER DELETE ON edges BEGIN
          INSERT INTO w2_edge_write_audit(operation, edge_id, source_file_id, resolver_id)
          VALUES ('delete', OLD.id, OLD.source_file_id, OLD.resolver_id);
        END;
      `);
      const before = publicQueryOutputs(diff, 'fixture');
      const priorHistory = readPriorCommunityHistory(resetPath);
      put(root, 'src/noop.ts', '// revision: 2\n');
      await diff.buildOrUpdate({
        resolutionMode: 'full-diff',
        verifyContent: true,
      });
      await reset.buildOrUpdate({ verifyContent: true });
      cold = await CodeGraphEngine.open({
        dbPath: path.join(fixtureRoot, '.cold', 'graph.db'),
        repositories,
      });
      seedPriorCommunityHistory(
        path.join(fixtureRoot, '.cold', 'graph.db'),
        priorHistory,
      );
      await cold.buildOrUpdate();
      await cold.buildOrUpdate({ verifyContent: true });
      expect(canonicalGraph(resetPath)).toEqual(canonicalGraph(diffPath));
      expect(canonicalGraph(diffPath)).toEqual(
        canonicalGraph(path.join(fixtureRoot, '.cold', 'graph.db')),
      );
      expect(publicQueryOutputs(diff, 'fixture')).toEqual(before);
      expect(publicQueryOutputs(reset, 'fixture')).toEqual(before);
      expect(publicQueryOutputs(cold, 'fixture')).toEqual(before);
      expect(
        audit
          .prepare('SELECT * FROM w2_edge_write_audit ORDER BY sequence')
          .all(),
      ).toEqual([]);
      const counters = diff.getLastResolutionProjectionCounters();
      expect(counters).not.toBeNull();
      expect(counters?.inspectedEdges).toBeGreaterThan(0);
      expect(counters?.candidateEdges).toBeGreaterThan(0);
      expect(counters?.finalChangedEdges).toBe(0);
      expect(counters?.tempIoBytes).toBeGreaterThan(0);
      expect(counters?.tempIoBytesMeasured).toBeNull();
      expect(counters?.tempIoKind).toBe('logical-payload');
    } finally {
      cold?.close();
      audit.close();
      diff.close();
      reset.close();
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('limits changed-main fact writes and never rewrites retained test-link IDs', async () => {
    const fixtureRoot = mkdtempSync(
      path.join(tmpdir(), 'code-graph-w2-main-edit-'),
    );
    const root = path.join(fixtureRoot, 'repo');
    seedResolverCorpus(root);
    const repositories = [{ repoId: 'fixture', rootPath: root }];
    const diffPath = path.join(fixtureRoot, '.diff', 'graph.db');
    const resetPath = path.join(fixtureRoot, '.reset', 'graph.db');
    const diff = await CodeGraphEngine.open({ dbPath: diffPath, repositories });
    const reset = await CodeGraphEngine.open({
      dbPath: resetPath,
      repositories,
    });
    const audit = new DatabaseSync(diffPath);
    let cold: CodeGraphEngine | undefined;
    try {
      await diff.buildOrUpdate({ resolutionMode: 'full-diff' });
      await reset.buildOrUpdate();
      await diff.buildOrUpdate({
        resolutionMode: 'full-diff',
        verifyContent: true,
      });
      await reset.buildOrUpdate({ verifyContent: true });
      audit.exec(`
        CREATE TABLE w2_edge_write_audit (
          sequence INTEGER PRIMARY KEY,
          operation TEXT NOT NULL,
          edge_id TEXT NOT NULL,
          source_file_id TEXT NOT NULL,
          resolver_id TEXT
        );
        CREATE TRIGGER w2_audit_edge_insert AFTER INSERT ON edges BEGIN
          INSERT INTO w2_edge_write_audit(operation, edge_id, source_file_id, resolver_id)
          VALUES ('insert', NEW.id, NEW.source_file_id, NEW.resolver_id);
        END;
        CREATE TRIGGER w2_audit_edge_update AFTER UPDATE ON edges BEGIN
          INSERT INTO w2_edge_write_audit(operation, edge_id, source_file_id, resolver_id)
          VALUES ('update', NEW.id, NEW.source_file_id, NEW.resolver_id);
        END;
        CREATE TRIGGER w2_audit_edge_delete AFTER DELETE ON edges BEGIN
          INSERT INTO w2_edge_write_audit(operation, edge_id, source_file_id, resolver_id)
          VALUES ('delete', OLD.id, OLD.source_file_id, OLD.resolver_id);
        END;
      `);
      const mainFileId = requireString(
        requireRow(
          audit
            .prepare("SELECT id FROM files WHERE relative_path = 'src/main.ts'")
            .get(),
        ),
        'id',
      );
      const retainedTestLinkIds = testLinkIds(diffPath, 'fixture');
      expect(retainedTestLinkIds.length).toBeGreaterThan(0);
      const beforeFacts = canonicalGraph(diffPath);
      const beforeQueries = publicQueryOutputs(diff, 'fixture');
      const priorHistory = readPriorCommunityHistory(resetPath);
      const mainSource = readFileSync(path.join(root, 'src/main.ts'), 'utf8');
      put(
        root,
        'src/main.ts',
        mainSource.replace('// revision: 1', '// revision: 2'),
      );
      await diff.buildOrUpdate({
        resolutionMode: 'full-diff',
        verifyContent: true,
      });
      await reset.buildOrUpdate({ verifyContent: true });
      cold = await CodeGraphEngine.open({
        dbPath: path.join(fixtureRoot, '.cold', 'graph.db'),
        repositories,
      });
      seedPriorCommunityHistory(
        path.join(fixtureRoot, '.cold', 'graph.db'),
        priorHistory,
      );
      await cold.buildOrUpdate();
      await cold.buildOrUpdate({ verifyContent: true });
      expect(canonicalGraph(diffPath)).not.toEqual(beforeFacts);
      expect(canonicalGraph(resetPath)).toEqual(canonicalGraph(diffPath));
      expect(canonicalGraph(diffPath)).toEqual(
        canonicalGraph(path.join(fixtureRoot, '.cold', 'graph.db')),
      );
      expect(publicQueryOutputs(diff, 'fixture')).toEqual(beforeQueries);
      expect(publicQueryOutputs(reset, 'fixture')).toEqual(beforeQueries);
      expect(publicQueryOutputs(cold, 'fixture')).toEqual(beforeQueries);
      expect(testLinkIds(diffPath, 'fixture')).toEqual(retainedTestLinkIds);
      const writes = audit
        .prepare('SELECT * FROM w2_edge_write_audit ORDER BY sequence')
        .all();
      expect(writes.length).toBeGreaterThan(0);
      for (const value of writes) {
        const row = requireRow(value);
        // Do not whitelist test-linker rows: retained inferred IDs are outside
        // the changed main file and must remain completely untouched.
        expect(requireString(row, 'source_file_id')).toBe(mainFileId);
      }
    } finally {
      cold?.close();
      audit.close();
      diff.close();
      reset.close();
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('rolls back a later diff apply and late summary failure, then retries cleanly', async () => {
    const fixtureRoot = mkdtempSync(
      path.join(tmpdir(), 'code-graph-w2-rollback-'),
    );
    const root = path.join(fixtureRoot, 'repo');
    seedResolverCorpus(root);
    const dbPath = path.join(fixtureRoot, '.graph', 'graph.db');
    const engine = await CodeGraphEngine.open({
      dbPath,
      repositories: [{ repoId: 'fixture', rootPath: root }],
    });
    const ddl = new DatabaseSync(dbPath);
    try {
      await engine.buildOrUpdate();
      await engine.buildOrUpdate({ verifyContent: true });
      const factsBefore = canonicalGraph(dbPath);
      const priorHistory = readPriorCommunityHistory(dbPath);
      const markersBefore = ddl
        .prepare('SELECT key, value FROM graph_metadata ORDER BY key')
        .all();
      put(
        root,
        'tsconfig.json',
        JSON.stringify({ extends: './tsconfig.other.json' }),
      );
      put(
        root,
        'src/new-symbol.ts',
        'export function addedBeforeApplyFailure(): number { return 2; }\n',
      );
      ddl.exec(`
        CREATE TABLE w2_apply_update_audit (
          sequence INTEGER PRIMARY KEY,
          edge_id TEXT NOT NULL
        );
        CREATE TRIGGER w2_audit_resolution_update AFTER UPDATE ON edges
        WHEN OLD.target_symbol_id IS NOT NEW.target_symbol_id
          OR OLD.resolver_id IS NOT NEW.resolver_id
          OR OLD.evidence_json IS NOT NEW.evidence_json
        BEGIN
          INSERT INTO w2_apply_update_audit(edge_id) VALUES (NEW.id);
        END;
        CREATE TRIGGER w2_fail_later_resolution_apply BEFORE UPDATE ON edges
        WHEN (SELECT COUNT(*) FROM w2_apply_update_audit) > 0
          AND (OLD.target_symbol_id IS NOT NEW.target_symbol_id
            OR OLD.resolver_id IS NOT NEW.resolver_id
            OR OLD.evidence_json IS NOT NEW.evidence_json)
        BEGIN SELECT RAISE(ABORT, 'forced later W2 apply failure'); END;
      `);
      await expect(
        engine.buildOrUpdate({
          resolutionMode: 'full-diff',
          verifyContent: true,
        }),
      ).rejects.toThrow('forced later W2 apply failure');
      expect(canonicalGraph(dbPath)).toEqual(factsBefore);
      expect(
        ddl.prepare('SELECT key, value FROM graph_metadata ORDER BY key').all(),
      ).toEqual(markersBefore);
      // The failure guard can fire only after an earlier binding update in
      // this same transaction. Its audit row must be rolled back as well.
      expect(
        requireNumber(
          requireRow(
            ddl
              .prepare('SELECT COUNT(*) AS n FROM w2_apply_update_audit')
              .get(),
          ),
          'n',
        ),
      ).toBe(0);
      ddl.exec(`
        DROP TRIGGER w2_fail_later_resolution_apply;
        DROP TRIGGER w2_audit_resolution_update;
      `);
      await engine.buildOrUpdate({
        resolutionMode: 'full-diff',
        verifyContent: true,
      });
      const cold = await CodeGraphEngine.open({
        dbPath: path.join(fixtureRoot, '.cold', 'graph.db'),
        repositories: [{ repoId: 'fixture', rootPath: root }],
      });
      try {
        seedPriorCommunityHistory(
          path.join(fixtureRoot, '.cold', 'graph.db'),
          priorHistory,
        );
        await cold.buildOrUpdate();
        await cold.buildOrUpdate({ verifyContent: true });
        expect(canonicalGraph(dbPath)).toEqual(
          canonicalGraph(path.join(fixtureRoot, '.cold', 'graph.db')),
        );
        expect(publicQueryOutputs(engine, 'fixture')).toEqual(
          publicQueryOutputs(cold, 'fixture'),
        );
      } finally {
        cold.close();
      }

      const factsBeforeSummaryFailure = canonicalGraph(dbPath);
      const priorHistoryBeforeSummaryFailure =
        readPriorCommunityHistory(dbPath);
      const markersBeforeSummaryFailure = ddl
        .prepare('SELECT key, value FROM graph_metadata ORDER BY key')
        .all();
      put(
        root,
        'src/new-symbol.ts',
        'export function addedBeforeApplyFailure(): number { return 2; }\n' +
          'export function addedBeforeSummaryFailure(): number { return 3; }\n',
      );
      ddl.exec(`
        CREATE TRIGGER w2_fail_summary_publication BEFORE UPDATE ON graph_metadata
        WHEN OLD.key = 'summary_projection_v1'
        BEGIN SELECT RAISE(ABORT, 'forced W2 summary publication failure'); END;
      `);
      await expect(
        engine.buildOrUpdate({
          resolutionMode: 'full-diff',
          verifyContent: true,
        }),
      ).rejects.toThrow('forced W2 summary publication failure');
      // This later failure occurs after resolver apply, FTS maintenance and
      // derived writes, but before the summary update can commit. The full
      // semantic graph and every persisted marker return to their pre-build
      // values, including FTS mappings and the summary projection identity.
      expect(canonicalGraph(dbPath)).toEqual(factsBeforeSummaryFailure);
      expect(
        ddl.prepare('SELECT key, value FROM graph_metadata ORDER BY key').all(),
      ).toEqual(markersBeforeSummaryFailure);
      ddl.exec('DROP TRIGGER w2_fail_summary_publication');
      await engine.buildOrUpdate({
        resolutionMode: 'full-diff',
        verifyContent: true,
      });
      const finalCold = await CodeGraphEngine.open({
        dbPath: path.join(fixtureRoot, '.cold-final', 'graph.db'),
        repositories: [{ repoId: 'fixture', rootPath: root }],
      });
      try {
        seedPriorCommunityHistory(
          path.join(fixtureRoot, '.cold-final', 'graph.db'),
          priorHistoryBeforeSummaryFailure,
        );
        await finalCold.buildOrUpdate();
        await finalCold.buildOrUpdate({ verifyContent: true });
        expect(canonicalGraph(dbPath)).toEqual(
          canonicalGraph(path.join(fixtureRoot, '.cold-final', 'graph.db')),
        );
        expect(publicQueryOutputs(engine, 'fixture')).toEqual(
          publicQueryOutputs(finalCold, 'fixture'),
        );
      } finally {
        finalCold.close();
      }
    } finally {
      ddl.close();
      engine.close();
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
