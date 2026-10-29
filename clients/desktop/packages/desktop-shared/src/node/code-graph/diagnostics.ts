import { z } from 'zod';
import type {
  CodeGraphDiagnostics,
  CodeGraphRepositoryDiagnostics,
  CodeGraphDerivedRepoStats,
} from '../../types/code-graph';
import { repositoryRowId } from './ids';
import {
  getMetadataValue,
  setMetadataValue,
  requireRow,
  requireNumber,
  requireString,
  type CodeGraphDatabase,
} from './store/database';

const count = z.number().int().nonnegative();
const schema = z.object({
  freshness: z.enum(['stat', 'content', 'reparsed']),
  recordedAt: count,
  repositories: z.array(
    z.object({
      repoId: z.string(),
      symbolCount: count,
      edgeCount: count,
      communityLimits: z.object({
        symbolResolution: count,
        fileProjection: count,
        maxSymbols: count,
        maxEdges: count,
      }),
      eligibleFiles: count,
      unsupportedFiles: count,
      excludedFiles: count,
      examples: z.array(z.string()).max(10),
      filesWithErrors: count,
      oversizedFiles: count,
      communityStatus: z.enum([
        'complete',
        'coarse',
        'skipped',
        'failed',
        'not-computed',
        'stale',
      ]),
      flowStatus: z.enum([
        'complete',
        'partial',
        'failed',
        'not-computed',
        'stale',
      ]),
      warnings: z.array(z.string()),
      edges: z.array(
        z.object({
          kind: z.string(),
          language: z.string(),
          reason: z.string(),
          count,
        }),
      ),
    }),
  ),
}) satisfies z.ZodType<CodeGraphDiagnostics>;

/** Parses stored `graph_diagnostics`; anything unreadable is null. */
export function parseGraphDiagnostics(
  raw: string | null,
): CodeGraphDiagnostics | null {
  if (raw === null) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function readGraphDiagnostics(
  db: CodeGraphDatabase,
): CodeGraphDiagnostics | null {
  try {
    return parseGraphDiagnostics(getMetadataValue(db, 'graph_diagnostics'));
  } catch {
    return null;
  }
}

export interface ScanDiagnostics {
  eligibleFiles: number;
  unsupportedFiles: number;
  excludedFiles: number;
  examples: string[];
}

export interface GraphDiagnosticsInput {
  db: CodeGraphDatabase;
  scans: Map<string, ScanDiagnostics>;
  derived: CodeGraphDerivedRepoStats[];
  derivedRefreshed: boolean;
  computeDerived: boolean;
  factsChanged: boolean;
  freshness: CodeGraphDiagnostics['freshness'];
}

export function recordGraphDiagnostics(input: GraphDiagnosticsInput): void {
  setMetadataValue(
    input.db,
    'graph_diagnostics',
    JSON.stringify(computeGraphDiagnostics(input)),
  );
}

/** Reads only: the diagnostics `recordGraphDiagnostics` would store. */
export function computeGraphDiagnostics(
  input: GraphDiagnosticsInput,
): CodeGraphDiagnostics {
  const { db } = input;
  const previous = readGraphDiagnostics(db);
  const repositories: CodeGraphRepositoryDiagnostics[] = [];
  for (const [repoId, scan] of Array.from(input.scans)) {
    const prior = previous?.repositories.find(
      (entry) => entry.repoId === repoId,
    );
    if (!input.factsChanged && !input.derivedRefreshed && prior !== undefined) {
      repositories.push({ ...prior, ...scan });
      continue;
    }
    const id = repositoryRowId(repoId);
    const parse = requireRow(
      db
        .prepare(
          `SELECT SUM(has_errors) AS errors,
      SUM(CASE WHEN parse_status = 'skipped_too_large' THEN 1 ELSE 0 END) AS oversized FROM files WHERE repository_id = ?`,
        )
        .get(id),
    );
    const derived = input.derived.find((entry) => entry.repoId === repoId);
    const coarse =
      Number(
        requireRow(
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM communities
      WHERE repository_id = ? AND json_extract(extra_json, '$.resolution') = 'file'`,
            )
            .get(id),
        ).n,
      ) > 0;
    const partialFlows =
      Number(
        requireRow(
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM flows WHERE repository_id = ? AND json_extract(extra_json, '$.truncated') = 1",
            )
            .get(id),
        ).n,
      ) > 0;
    let communityStatus = prior?.communityStatus ?? 'not-computed';
    let flowStatus = prior?.flowStatus ?? 'not-computed';
    let warnings = prior?.warnings ?? [];
    if (!input.computeDerived && input.factsChanged) {
      communityStatus = 'not-computed';
      flowStatus = 'not-computed';
      warnings = [];
    } else if (input.derivedRefreshed) {
      communityStatus = !derived?.computed
        ? 'failed'
        : derived.communitiesSkipped
          ? 'skipped'
          : coarse
            ? 'coarse'
            : 'complete';
      flowStatus = !derived?.computed
        ? 'failed'
        : derived.flowsGlobalCapReached || partialFlows
          ? 'partial'
          : 'complete';
      warnings = derived?.warnings ?? [];
    }
    const edges = db
      .prepare(
        `SELECT e.kind AS kind, COALESCE(f.language, 'unknown') AS language,
      CASE WHEN e.target_symbol_id IS NOT NULL THEN 'resolved'
      WHEN json_extract(e.evidence_json, '$.candidates') > 1 THEN 'ambiguous'
      WHEN f.has_errors = 1 THEN 'parser-degraded'
      WHEN json_extract(e.evidence_json, '$.external') = 1 OR e.target_ref LIKE 'node:%' OR (e.kind = 'USES_PIPELINE_ACTION' AND e.target_ref NOT LIKE './%') THEN 'external'
      WHEN json_extract(e.evidence_json, '$.unsupportedLanguageResolution') = 1 THEN 'unsupported-binding'
      WHEN json_extract(e.evidence_json, '$.shadowed') = 1 OR json_extract(e.evidence_json, '$.memberCall') = 1 THEN 'unsupported-binding'
      WHEN e.target_ref LIKE './%' OR e.target_ref LIKE '../%' THEN 'missing-local-target'
      ELSE 'unknown' END AS reason, COUNT(*) AS n
      FROM edges e JOIN files f ON f.id = e.source_file_id
      WHERE e.repository_id = ? AND e.kind IN ('CALLS','IMPORTS_FROM','REFERENCES','DOCUMENTS','IPC_HANDLES','IPC_INVOKES','USES_PIPELINE_ACTION')
      GROUP BY e.kind, COALESCE(f.language, 'unknown'), reason ORDER BY e.kind, language, reason`,
      )
      .all(id)
      .map((value) => {
        const row = requireRow(value);
        return {
          kind: requireString(row, 'kind'),
          language: requireString(row, 'language'),
          reason: requireString(row, 'reason'),
          count: requireNumber(row, 'n'),
        };
      });
    const sizes = requireRow(
      db
        .prepare(
          `SELECT
      (SELECT COUNT(*) FROM symbols WHERE repository_id = ?) AS symbols,
      (SELECT COUNT(*) FROM edges WHERE repository_id = ?) AS edges`,
        )
        .get(id, id),
    );
    repositories.push({
      repoId,
      symbolCount: requireNumber(sizes, 'symbols'),
      edgeCount: requireNumber(sizes, 'edges'),
      communityLimits: {
        symbolResolution: 50_000,
        fileProjection: 50_000,
        maxSymbols: 1_000_000,
        maxEdges: 5_000_000,
      },
      ...scan,
      filesWithErrors: Number(parse.errors ?? 0),
      oversizedFiles: Number(parse.oversized ?? 0),
      communityStatus,
      flowStatus,
      warnings,
      edges,
    });
  }
  return {
    freshness: input.freshness,
    recordedAt: Date.now(),
    repositories,
  };
}

/**
 * Published without derived analysis: every repository whose analysis was
 * ever recorded now describes an earlier build, so its community and flow
 * statuses read `stale` (never-computed ones stay `not-computed`) until the
 * deferred analysis records fresh diagnostics. Scan coverage is this build's.
 * Cheap: no graph-wide query runs.
 */
export function markGraphDiagnosticsStale(input: {
  db: CodeGraphDatabase;
  scans: Map<string, ScanDiagnostics>;
  freshness: CodeGraphDiagnostics['freshness'];
}): void {
  const previous = readGraphDiagnostics(input.db);
  if (previous === null) return;
  const repositories: CodeGraphRepositoryDiagnostics[] = [];
  for (const [repoId, scan] of Array.from(input.scans)) {
    const prior = previous.repositories.find(
      (entry) => entry.repoId === repoId,
    );
    if (prior === undefined) continue;
    repositories.push({
      ...prior,
      ...scan,
      communityStatus:
        prior.communityStatus === 'not-computed' ? 'not-computed' : 'stale',
      flowStatus:
        prior.flowStatus === 'not-computed' ? 'not-computed' : 'stale',
    });
  }
  setMetadataValue(
    input.db,
    'graph_diagnostics',
    JSON.stringify({
      freshness: input.freshness,
      recordedAt: Date.now(),
      repositories,
    } satisfies CodeGraphDiagnostics),
  );
}
