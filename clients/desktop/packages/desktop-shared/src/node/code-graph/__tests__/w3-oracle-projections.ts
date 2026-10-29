import { readCodeGraphSummaryProjectionFromDatabase } from '../summary-projection';
import { CodeGraphQueryService } from '../query/queries';
import {
  requireRow,
  requireString,
  type CodeGraphDatabase,
} from '../store/database';

/** Additive shared oracle helper: keep old full-reset implementation independent. */
export interface W3OracleTargets {
  repoId: string;
  symbols: readonly string[];
  files: readonly string[];
  searches: readonly string[];
  ipc: readonly string[];
  paths: readonly { from: string; to: string }[];
}

function jsonColumns(
  rows: readonly unknown[],
  columns: readonly string[],
): Record<string, unknown>[] {
  return rows.map((value): Record<string, unknown> => {
    const row = { ...requireRow(value) };
    for (const column of columns) {
      const raw = row[column];
      if (typeof raw !== 'string')
        throw new Error(`Missing semantic JSON ${column}`);
      const parsed: unknown = JSON.parse(raw);
      row[column] = parsed;
    }
    return row;
  });
}

/**
 * Ignores only checkout location/stat/timestamps, FTS rowids and measured build
 * timings. All fact, binding, provenance/evidence fields and test link IDs
 * remain exact. Search results retain ranked order and matchKind. Dependency
 * captures are checked separately because the independent reset/cold oracle
 * intentionally does not need W3 metadata in order to resolve correctly.
 */
export function projectW3Oracle(
  db: CodeGraphDatabase,
  targets: readonly W3OracleTargets[],
): Record<string, unknown> {
  const queries = new CodeGraphQueryService(db);
  const summary = readCodeGraphSummaryProjectionFromDatabase(db);
  // Exclude build timestamps/revision only, never counts/identity/assembly.
  const summaryProjection =
    summary.state === 'ready'
      ? {
          state: summary.state,
          formatVersion: summary.projection.formatVersion,
          schemaVersion: summary.projection.schemaVersion,
          extractorVersion: summary.projection.extractorVersion,
          completed: summary.projection.completedBuildAt !== null,
          derivedPresent: summary.projection.derivedAt !== null,
          assembly: summary.projection.assembly,
          customLanguagesFingerprint:
            summary.projection.customLanguagesFingerprint,
          repositories: summary.projection.repositories,
          totals: summary.projection.totals,
          topCommunities: summary.projection.topCommunities,
          customLanguages: summary.projection.customLanguages,
        }
      : { state: summary.state };
  return {
    summary: summaryProjection,
    repositories: db
      .prepare('SELECT id, repo_id FROM repositories ORDER BY id')
      .all(),
    files: db
      .prepare(
        `SELECT id, repository_id, relative_path, language, content_hash,
      size_bytes, line_count, grammar_id, grammar_abi, parse_status, has_errors FROM files ORDER BY id`,
      )
      .all(),
    symbols: jsonColumns(
      db.prepare('SELECT * FROM symbols ORDER BY id').all(),
      ['extra_json'],
    ),
    edges: jsonColumns(db.prepare('SELECT * FROM edges ORDER BY id').all(), [
      'evidence_json',
    ]),
    searchFacts: db
      .prepare(
        'SELECT symbol_id, name, qualified_name, signature, file_path FROM symbol_fts ORDER BY symbol_id',
      )
      .all(),
    fragmentFacts: db
      .prepare(
        'SELECT symbol_id, name_folded, qualified_name_folded FROM symbol_fragment_fts ORDER BY symbol_id',
      )
      .all(),
    searchOwnership: db
      .prepare(
        'SELECT symbol_id, file_id, repository_id FROM symbol_fts_rows ORDER BY symbol_id',
      )
      .all(),
    perRepository: targets.map(
      (target): Record<string, unknown> => ({
        repoId: target.repoId,
        symbolQueries: target.symbols.map(
          (symbol): Record<string, unknown> => ({
            symbol,
            detail: queries.getSymbolDetail(symbol, target.repoId),
            callers: queries.getCallers(symbol, target.repoId),
            callees: queries.getCallees(symbol, target.repoId),
            children: queries.getChildren(symbol, target.repoId),
            tests: queries.getTestsFor(symbol, target.repoId),
            docs: queries.getDocsFor(symbol, target.repoId),
            rationale: queries.getRationaleFor(symbol, target.repoId),
            impact: queries.getImpactRadius(
              symbol,
              { maxDepth: 4, maxNodes: 500 },
              target.repoId,
            ),
            flows: queries.listFlowsForSymbol(symbol, target.repoId),
            community: queries.getCommunityForSymbol(symbol, target.repoId),
          }),
        ),
        fileQueries: target.files.map(
          (file): Record<string, unknown> => ({
            file,
            summary: queries.getFileSummary(file, target.repoId),
            importers: queries.getImporters(file, target.repoId),
            imports: queries.getImports(file, target.repoId),
            scripts: queries.getScriptsForFile(file, target.repoId),
          }),
        ),
        searches: target.searches.map(
          (text): Record<string, unknown> => ({
            text,
            one: queries.search(text, 1, target.repoId),
            twenty: queries.search(text, 20, target.repoId),
            fifty: queries.search(text, 50, target.repoId),
          }),
        ),
        ipc: target.ipc.map(
          (key): Record<string, unknown> => ({
            key,
            result: queries.getIpcChannel(key, target.repoId),
          }),
        ),
        paths: target.paths.map(
          (pair): Record<string, unknown> => ({
            ...pair,
            call: queries.getRelationshipPath({
              target: pair.from,
              to: pair.to,
              mode: 'call-path',
              repoId: target.repoId,
            }),
            relationship: queries.getRelationshipPath({
              target: pair.from,
              to: pair.to,
              mode: 'relationship-path',
              repoId: target.repoId,
            }),
          }),
        ),
        hubs: queries.listTopDegreeSymbols(target.repoId),
        communities: queries.listCommunities(target.repoId),
        flows: queries.listFlows(target.repoId),
        derivedStats: queries.getDerivedStats(target.repoId),
      }),
    ),
  };
}

export function listW3DependencyProjection(
  db: CodeGraphDatabase,
): Record<string, unknown>[] {
  return db
    .prepare(
      `SELECT * FROM resolution_dependencies
    ORDER BY repository_id, resolver, source_file_id, source_edge_id, dependency_kind, dependency_key`,
    )
    .all()
    .map((value): Record<string, unknown> => {
      const row = requireRow(value);
      const dependencyValue: unknown = JSON.parse(
        requireString(row, 'dependency_value'),
      );
      return { ...row, dependency_value: dependencyValue };
    });
}
