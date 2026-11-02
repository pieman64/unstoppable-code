import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { realpathSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import {
  CODE_GRAPH_EXTRACTOR_VERSION,
  CODE_GRAPH_SCHEMA_VERSION,
} from './types/code-graph';
import type { CodeGraphDiagnostics } from './types/code-graph';
import {
  CODE_GRAPH_BUSY_TIMEOUT_MS,
  deleteMetadataValue,
  hasActiveCodeGraphWriteTransaction,
  setMetadataValue,
  withImmediateTransaction,
  type CodeGraphDatabase,
} from './store/database';
import { parseGraphDiagnostics } from './diagnostics';
import {
  CODE_GRAPH_CUSTOM_LANGUAGES_CONFIG_RELATIVE_PATH,
  parseCustomLanguagesReport,
} from './languages/custom-config';

const SUMMARY_PROJECTION_KEY = 'summary_projection_v1';
const SUMMARY_PROJECTION_REVISION_KEY = 'summary_projection_revision';
const SUMMARY_PROJECTION_IDENTITY_KEY = 'summary_projection_identity_v1';
const MAX_PROJECTION_BYTES = 1_048_576;
const MAX_METADATA_VALUE_BYTES = 1_048_576;
const MAX_CUSTOM_LANGUAGE_DIAGNOSTICS = 64;
const MAX_CUSTOM_LANGUAGE_INPUT_ITEMS = 4_096;
const CONTEXT_UNRESOLVED_EDGE_KINDS: readonly string[] = [
  'CALLS',
  'IMPORTS_FROM',
  'REFERENCES',
  'DOCUMENTS',
  'IPC_HANDLES',
  'IPC_INVOKES',
  'USES_PIPELINE_ACTION',
];

const safeInteger = z
  .number()
  .int()
  .refine((value) => Number.isSafeInteger(value));
const nonnegativeSafeInteger = z
  .number()
  .int()
  .nonnegative()
  .refine((value) => Number.isSafeInteger(value));
const countShapeSchema = z
  .object({
    fileCount: nonnegativeSafeInteger,
    symbolCount: nonnegativeSafeInteger,
    edgeCount: nonnegativeSafeInteger,
    contextUnresolvedEdgeCount: nonnegativeSafeInteger,
    contextFilesWithErrors: nonnegativeSafeInteger,
    legacyUnresolvedEdgeCount: nonnegativeSafeInteger,
    legacyFilesWithErrors: nonnegativeSafeInteger,
    communityCount: nonnegativeSafeInteger,
    flowCount: nonnegativeSafeInteger,
  })
  .strict();
const loadedLanguageSchema = z
  .object({
    index: nonnegativeSafeInteger,
    id: z.string().min(1).max(256).refine(isCanonicalPortableText),
    extensions: z
      .array(z.string().max(128).refine(isCanonicalPortableText))
      .max(128),
    abiVersion: nonnegativeSafeInteger,
  })
  .strict();
const languageDiagnosticSchema = z
  .object({
    entryId: z.string().max(256).refine(isCanonicalPortableText).nullable(),
    index: safeInteger,
    message: z.string().max(512).refine(isCanonicalPortableText),
  })
  .strict();
const customLanguagesSchema = z
  .object({
    configRelativePath: z
      .string()
      .min(1)
      .max(512)
      .refine(
        (value) =>
          !path.isAbsolute(value) &&
          !/^[A-Za-z]:/.test(value) &&
          !value.includes('\\') &&
          !value.split('/').includes('..'),
      ),
    loaded: z.array(loadedLanguageSchema).max(256),
    diagnostics: z
      .array(languageDiagnosticSchema)
      .max(MAX_CUSTOM_LANGUAGE_DIAGNOSTICS),
    omittedDiagnosticCount: nonnegativeSafeInteger,
  })
  .strict()
  .nullable();
const repositoryProjectionSchema = z
  .object({
    repoId: z.string().min(1).max(1_024),
    gitHead: z.string().max(512).nullable(),
    counts: countShapeSchema,
  })
  .strict();
const communityProjectionSchema = z
  .object({
    id: z.string().min(1).max(256),
    repoId: z.string().min(1).max(1_024),
    label: z.string().max(4_096),
    size: nonnegativeSafeInteger,
    cohesion: z.number().finite().min(0).max(1),
  })
  .strict();
const countKeys: readonly (keyof z.infer<typeof countShapeSchema>)[] = [
  'fileCount',
  'symbolCount',
  'edgeCount',
  'contextUnresolvedEdgeCount',
  'contextFilesWithErrors',
  'legacyUnresolvedEdgeCount',
  'legacyFilesWithErrors',
  'communityCount',
  'flowCount',
];

export const codeGraphSummaryProjectionV1Schema = z
  .object({
    formatVersion: z.literal(1),
    schemaVersion: nonnegativeSafeInteger,
    extractorVersion: nonnegativeSafeInteger,
    projectionRevision: nonnegativeSafeInteger,
    lastBuildAt: nonnegativeSafeInteger.nullable(),
    completedBuildAt: nonnegativeSafeInteger.nullable(),
    derivedAt: nonnegativeSafeInteger.nullable(),
    assembly: z.enum(['complete', 'imported', 'incomplete']),
    customLanguagesFingerprint: z.string().max(256).nullable(),
    repositories: z.array(repositoryProjectionSchema).max(10_000),
    totals: countShapeSchema,
    topCommunities: z.array(communityProjectionSchema).max(5),
    customLanguages: customLanguagesSchema,
  })
  .strict()
  .superRefine((projection, context) => {
    if (
      Buffer.byteLength(JSON.stringify(projection), 'utf8') >
      MAX_PROJECTION_BYTES
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Projection exceeds the UTF-8 payload bound.',
      });
    }
    const seenRepositories = new Set<string>();
    for (const repository of projection.repositories) {
      if (seenRepositories.has(repository.repoId)) {
        context.addIssue({
          code: 'custom',
          path: ['repositories'],
          message: 'Repository ids must be unique.',
        });
        break;
      }
      seenRepositories.add(repository.repoId);
    }
    let previousCommunity:
      | z.infer<typeof communityProjectionSchema>
      | undefined;
    const seenCommunities = new Set<string>();
    for (const community of projection.topCommunities) {
      if (
        !seenRepositories.has(community.repoId) ||
        seenCommunities.has(community.id)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['topCommunities'],
          message: 'Invalid community attribution.',
        });
      }
      if (
        previousCommunity !== undefined &&
        (community.size > previousCommunity.size ||
          (community.size === previousCommunity.size &&
            Buffer.compare(
              Buffer.from(previousCommunity.id),
              Buffer.from(community.id),
            ) > 0))
      ) {
        context.addIssue({
          code: 'custom',
          path: ['topCommunities'],
          message: 'Community order must match SQLite BINARY ranking.',
        });
      }
      seenCommunities.add(community.id);
      previousCommunity = community;
    }
    for (const key of countKeys) {
      let total = 0;
      let overflow = false;
      for (const repository of projection.repositories) {
        total += repository.counts[key];
        if (!Number.isSafeInteger(total)) {
          overflow = true;
          break;
        }
      }
      if (overflow || total !== projection.totals[key]) {
        context.addIssue({
          code: 'custom',
          path: ['totals', key],
          message: 'Totals must equal the sum of repository counts.',
        });
      }
    }
  });

export type CodeGraphSummaryProjectionV1 = z.infer<
  typeof codeGraphSummaryProjectionV1Schema
>;

export interface CodeGraphSummaryObservedMetadata {
  schemaVersion: number | null;
  extractorVersion: number | null;
  projectionRevision: number | null;
  lastBuildAt: number | null;
  completedBuildAt: number | null;
  derivedAt: number | null;
}

export type CodeGraphSummaryProjectionErrorClassification =
  | 'permission-denied'
  | 'busy'
  | 'corrupt'
  | 'unsupported-schema'
  | 'io';

export type ReadCodeGraphSummaryProjectionResult =
  | { state: 'missing' }
  | {
      state: 'pending';
      reason:
        | 'projection-missing'
        | 'projection-invalid'
        | 'projection-mismatch'
        | 'build-incomplete';
      observed: CodeGraphSummaryObservedMetadata;
      diagnostics: CodeGraphDiagnostics | null;
    }
  | {
      state: 'ready';
      projection: CodeGraphSummaryProjectionV1;
      diagnostics: CodeGraphDiagnostics | null;
    }
  | {
      state: 'error';
      classification: CodeGraphSummaryProjectionErrorClassification;
    };

export type BackfillCodeGraphSummaryProjectionResult =
  | { state: 'ready'; projection: CodeGraphSummaryProjectionV1 }
  | { state: 'superseded' }
  | {
      state: 'error';
      classification: CodeGraphSummaryProjectionErrorClassification;
      reason?: 'immutable-published-base' | 'projection-invalid';
    };

export interface BackfillCodeGraphSummaryProjectionOptions {
  worktreeRootPath?: string;
  /**
   * Required existing, idle writer connection owned by the trusted host. The backfill opens
   * and closes its own readonly count connection, but never closes this handle.
   */
  db: CodeGraphDatabase;
}

interface MetadataEntry {
  raw: string | null;
  oversized: boolean;
}

interface MetadataEntries {
  entries: Map<string, MetadataEntry>;
}

interface ParsedMetadata {
  observed: CodeGraphSummaryObservedMetadata;
  assembly: CodeGraphSummaryProjectionV1['assembly'] | null;
  customLanguagesFingerprint: string | null;
  identityFingerprint: string | null;
  projectionRaw: string | null;
  projectionOversized: boolean;
  diagnostics: CodeGraphDiagnostics | null;
  unsupportedSchema: boolean;
  /** Migrated, but no build or seed has committed an extractor version. */
  buildIncomplete: boolean;
  invalidIdentity: boolean;
  invalidMarkers: boolean;
  projectionRevisionRaw: string | null;
}

interface RepositoryHead {
  repoId: string;
  gitHead: string | null;
}

interface RepositoryCounts extends RepositoryHead {
  counts: z.infer<typeof countShapeSchema>;
}

interface PreparedProjection {
  projection: CodeGraphSummaryProjectionV1;
  serialized: string;
  identityFingerprint: string;
}

const whitelistedMetadataKeys: readonly string[] = [
  'schema_version',
  'extractor_version',
  SUMMARY_PROJECTION_REVISION_KEY,
  'last_build_at',
  'completed_build_at',
  'derived_at',
  'custom_languages_fingerprint',
  'imported_from_snapshot',
  'derived_pending',
  SUMMARY_PROJECTION_IDENTITY_KEY,
  SUMMARY_PROJECTION_KEY,
  'custom_languages',
  'graph_diagnostics',
];

class ProjectionProblem extends Error {
  public constructor(
    public readonly classification: CodeGraphSummaryProjectionErrorClassification,
  ) {
    super(classification);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : null;
  }
  if (typeof value === 'bigint') {
    const maximum = BigInt(Number.MAX_SAFE_INTEGER);
    const minimum = BigInt(Number.MIN_SAFE_INTEGER);
    if (value > maximum || value < minimum) return null;
    return Number(value);
  }
  return null;
}

function metadataEntry(entries: MetadataEntries, key: string): MetadataEntry {
  return entries.entries.get(key) ?? { raw: null, oversized: false };
}

function readWhitelistedMetadata(db: CodeGraphDatabase): MetadataEntries {
  const placeholders = whitelistedMetadataKeys.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT key,
       CASE WHEN length(CAST(value AS BLOB)) <= ? THEN value ELSE NULL END AS bounded_value,
       length(CAST(value AS BLOB)) AS byte_length
     FROM graph_metadata
     WHERE key IN (${placeholders})`,
    )
    .all(MAX_METADATA_VALUE_BYTES, ...whitelistedMetadataKeys);
  const entries = new Map<string, MetadataEntry>();
  for (const value of rows) {
    if (!isRecord(value) || typeof value.key !== 'string') {
      throw new ProjectionProblem('corrupt');
    }
    const row = value;
    const byteLength = boundedInteger(row.byte_length);
    if (byteLength === null || byteLength < 0) {
      throw new ProjectionProblem('corrupt');
    }
    if (row.bounded_value !== null && typeof row.bounded_value !== 'string') {
      throw new ProjectionProblem('corrupt');
    }
    entries.set(value.key, {
      raw: typeof row.bounded_value === 'string' ? row.bounded_value : null,
      oversized: byteLength > MAX_METADATA_VALUE_BYTES,
    });
  }
  return { entries };
}

function parseRawNonnegativeInteger(entry: MetadataEntry): number | null {
  if (
    entry.oversized ||
    entry.raw === null ||
    !/^(0|[1-9][0-9]*)$/.test(entry.raw)
  ) {
    return null;
  }
  const parsed = Number(entry.raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** Narrow marker parser shared by assembly and attached-source evidence. */
export function parseCodeGraphImportedTimestamp(raw: string): number | null {
  if (raw.length > 128) return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(
    raw,
  );
  if (match === null) return null;
  const timestamp = Date.parse(raw);
  const base = match[1];
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || base === undefined)
    return null;
  const fraction = (match[2] ?? '').padEnd(3, '0');
  return new Date(timestamp).toISOString() === `${base}.${fraction}Z`
    ? timestamp
    : null;
}

function markerAssembly(
  schemaVersion: number | null,
  extractorVersion: number | null,
  completedBuildAt: number | null,
  lastBuildAt: number | null,
  imported: MetadataEntry,
  derivedPending: MetadataEntry,
): CodeGraphSummaryProjectionV1['assembly'] {
  if (imported.raw !== null) {
    const importedAt =
      parseCodeGraphImportedTimestamp(imported.raw) ?? Number.NaN;
    const completedAt =
      completedBuildAt ?? (derivedPending.raw === null ? lastBuildAt : null);
    if (
      Number.isFinite(importedAt) &&
      completedAt !== null &&
      completedAt >= importedAt
    ) {
      return 'complete';
    }
    return 'imported';
  }
  if (completedBuildAt !== null) return 'complete';
  if (derivedPending.raw !== null) return 'incomplete';
  if (
    lastBuildAt !== null &&
    schemaVersion === CODE_GRAPH_SCHEMA_VERSION &&
    extractorVersion === CODE_GRAPH_EXTRACTOR_VERSION
  ) {
    return 'complete';
  }
  return 'incomplete';
}

function diagnosticsFromMetadata(
  entries: MetadataEntries,
): CodeGraphDiagnostics | null {
  const diagnostics = metadataEntry(entries, 'graph_diagnostics');
  if (diagnostics.oversized || diagnostics.raw === null) return null;
  return parseGraphDiagnostics(diagnostics.raw);
}

function parsedMetadata(entries: MetadataEntries): ParsedMetadata {
  const schemaEntry = metadataEntry(entries, 'schema_version');
  const extractorEntry = metadataEntry(entries, 'extractor_version');
  const revisionEntry = metadataEntry(entries, SUMMARY_PROJECTION_REVISION_KEY);
  const lastBuildEntry = metadataEntry(entries, 'last_build_at');
  const completedBuildEntry = metadataEntry(entries, 'completed_build_at');
  const derivedEntry = metadataEntry(entries, 'derived_at');
  const fingerprintEntry = metadataEntry(
    entries,
    'custom_languages_fingerprint',
  );
  const importedEntry = metadataEntry(entries, 'imported_from_snapshot');
  const derivedPendingEntry = metadataEntry(entries, 'derived_pending');
  const identityEntry = metadataEntry(entries, SUMMARY_PROJECTION_IDENTITY_KEY);
  const projectionEntry = metadataEntry(entries, SUMMARY_PROJECTION_KEY);
  const schemaVersion = parseRawNonnegativeInteger(schemaEntry);
  const extractorVersion = parseRawNonnegativeInteger(extractorEntry);
  const projectionRevision = parseRawNonnegativeInteger(revisionEntry);
  const lastBuildAt = parseRawNonnegativeInteger(lastBuildEntry);
  const completedBuildAt = parseRawNonnegativeInteger(completedBuildEntry);
  const derivedAt = parseRawNonnegativeInteger(derivedEntry);
  const observed: CodeGraphSummaryObservedMetadata = {
    schemaVersion,
    extractorVersion,
    projectionRevision,
    lastBuildAt,
    completedBuildAt,
    derivedAt,
  };
  const versionEntries = [schemaEntry, extractorEntry];
  const markerEntries = [lastBuildEntry, completedBuildEntry, derivedEntry];
  const invalidMarkers =
    [...versionEntries, ...markerEntries, revisionEntry].some(
      (entry) =>
        entry.oversized ||
        (entry.raw !== null && parseRawNonnegativeInteger(entry) === null),
    ) ||
    importedEntry.oversized ||
    derivedPendingEntry.oversized;
  const customLanguagesFingerprint = fingerprintEntry.oversized
    ? null
    : fingerprintEntry.raw;
  const customLanguagesEntry = metadataEntry(entries, 'custom_languages');
  const invalidIdentity =
    identityEntry.oversized ||
    (identityEntry.raw !== null && !/^[0-9a-f]{64}$/.test(identityEntry.raw)) ||
    fingerprintEntry.oversized ||
    customLanguagesEntry.oversized ||
    (fingerprintEntry.raw !== null && fingerprintEntry.raw.length > 256);
  // Opening a graph commits its schema version; only a build or seed commits
  // the extractor version. Its absence is an incomplete build. A value that is
  // present but malformed or out of range is an unsupported schema.
  const extractorVersionAbsent =
    extractorEntry.raw === null && !extractorEntry.oversized;
  const unsupportedSchema =
    schemaVersion === null ||
    schemaVersion < 1 ||
    schemaVersion > CODE_GRAPH_SCHEMA_VERSION ||
    (!extractorVersionAbsent &&
      (extractorVersion === null ||
        extractorVersion < 1 ||
        extractorVersion > CODE_GRAPH_EXTRACTOR_VERSION));
  const assembly = invalidMarkers
    ? null
    : markerAssembly(
        schemaVersion,
        extractorVersion,
        completedBuildAt,
        lastBuildAt,
        importedEntry,
        derivedPendingEntry,
      );
  return {
    observed,
    assembly,
    customLanguagesFingerprint,
    identityFingerprint: identityEntry.oversized ? null : identityEntry.raw,
    projectionRaw: projectionEntry.oversized ? null : projectionEntry.raw,
    projectionOversized: projectionEntry.oversized,
    diagnostics: diagnosticsFromMetadata(entries),
    unsupportedSchema,
    buildIncomplete: !unsupportedSchema && extractorVersionAbsent,
    invalidIdentity,
    invalidMarkers,
    projectionRevisionRaw: revisionEntry.raw,
  };
}

function parseCounter(raw: string | null): number | null {
  if (raw === null) return 0;
  const entry = { raw, oversized: false };
  const parsed = parseRawNonnegativeInteger(entry);
  return parsed === null || parsed === Number.MAX_SAFE_INTEGER ? null : parsed;
}

function hashProjectionIdentity(
  repositories: readonly RepositoryHead[],
  entries: MetadataEntries,
  projectionRevision: number,
): string {
  const identityMetadataKeys = [
    'schema_version',
    'extractor_version',
    'last_build_at',
    'completed_build_at',
    'derived_at',
    'imported_from_snapshot',
    'derived_pending',
    'custom_languages_fingerprint',
    'custom_languages',
  ];
  const metadataTokens = identityMetadataKeys.map((key) => {
    const entry = metadataEntry(entries, key);
    return [key, entry.raw, entry.oversized];
  });
  return createHash('sha256')
    .update(
      JSON.stringify({
        repositories: repositories.map((repository) => [
          repository.repoId,
          repository.gitHead,
        ]),
        projectionRevision,
        metadataTokens,
      }),
    )
    .digest('hex');
}

function safeCount(value: unknown): number {
  const count = boundedInteger(value);
  if (count === null || count < 0) throw new ProjectionProblem('corrupt');
  return count;
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string') throw new ProjectionProblem('corrupt');
  return value;
}

function repositoryHeadRows(db: CodeGraphDatabase): RepositoryHead[] {
  const rows = db
    .prepare(
      'SELECT repo_id AS repoId, git_head AS gitHead FROM repositories ORDER BY repo_id',
    )
    .all();
  return rows.map((value) => {
    if (
      !isRecord(value) ||
      (value.gitHead !== null && typeof value.gitHead !== 'string')
    ) {
      throw new ProjectionProblem('corrupt');
    }
    return { repoId: requiredString(value.repoId), gitHead: value.gitHead };
  });
}

function hasTable(db: CodeGraphDatabase, tableName: string): boolean {
  return isRecord(
    db
      .prepare(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
      )
      .get(tableName),
  );
}

function ensureCoreTables(db: CodeGraphDatabase): void {
  for (const tableName of ['repositories', 'files', 'symbols', 'edges']) {
    if (!hasTable(db, tableName))
      throw new ProjectionProblem('unsupported-schema');
  }
}

function zeroCounts(): z.infer<typeof countShapeSchema> {
  return {
    fileCount: 0,
    symbolCount: 0,
    edgeCount: 0,
    contextUnresolvedEdgeCount: 0,
    contextFilesWithErrors: 0,
    legacyUnresolvedEdgeCount: 0,
    legacyFilesWithErrors: 0,
    communityCount: 0,
    flowCount: 0,
  };
}

function sumCounts(
  repositories: readonly RepositoryCounts[],
): z.infer<typeof countShapeSchema> {
  const totals = zeroCounts();
  for (const repository of repositories) {
    for (const key of countKeys) {
      const next = totals[key] + repository.counts[key];
      if (!Number.isSafeInteger(next)) throw new ProjectionProblem('corrupt');
      totals[key] = next;
    }
  }
  return totals;
}

function readAggregatedCounts(db: CodeGraphDatabase): RepositoryCounts[] {
  ensureCoreTables(db);
  const hasCommunities = hasTable(db, 'communities');
  const hasFlows = hasTable(db, 'flows');
  const communityCounts = hasCommunities
    ? 'community_counts AS (SELECT repository_id, COUNT(*) AS community_count FROM communities GROUP BY repository_id)'
    : 'community_counts AS (SELECT id AS repository_id, 0 AS community_count FROM repositories WHERE 0)';
  const flowCounts = hasFlows
    ? 'flow_counts AS (SELECT repository_id, COUNT(*) AS flow_count FROM flows GROUP BY repository_id)'
    : 'flow_counts AS (SELECT id AS repository_id, 0 AS flow_count FROM repositories WHERE 0)';
  const contextKinds = CONTEXT_UNRESOLVED_EDGE_KINDS.map(
    (kind) => `'${kind}'`,
  ).join(', ');
  const rows = db
    .prepare(
      `WITH file_counts AS (
       SELECT repository_id,
         COUNT(*) AS file_count,
         SUM(CASE WHEN has_errors = 1 THEN 1 ELSE 0 END) AS context_files_with_errors,
         SUM(CASE WHEN has_errors != 0 THEN 1 ELSE 0 END) AS legacy_files_with_errors
       FROM files GROUP BY repository_id
     ),
     symbol_counts AS (
       SELECT repository_id, COUNT(*) AS symbol_count
       FROM symbols GROUP BY repository_id
     ),
     edge_counts AS (
       SELECT repository_id,
         COUNT(*) AS edge_count,
         SUM(CASE WHEN target_symbol_id IS NULL AND kind IN (${contextKinds}) THEN 1 ELSE 0 END) AS context_unresolved_edge_count,
         SUM(CASE WHEN target_symbol_id IS NULL THEN 1 ELSE 0 END) AS legacy_unresolved_edge_count
       FROM edges GROUP BY repository_id
     ),
     ${communityCounts},
     ${flowCounts}
     SELECT r.repo_id AS repoId, r.git_head AS gitHead,
       COALESCE(f.file_count, 0) AS fileCount,
       COALESCE(s.symbol_count, 0) AS symbolCount,
       COALESCE(e.edge_count, 0) AS edgeCount,
       COALESCE(e.context_unresolved_edge_count, 0) AS contextUnresolvedEdgeCount,
       COALESCE(f.context_files_with_errors, 0) AS contextFilesWithErrors,
       COALESCE(e.legacy_unresolved_edge_count, 0) AS legacyUnresolvedEdgeCount,
       COALESCE(f.legacy_files_with_errors, 0) AS legacyFilesWithErrors,
       COALESCE(c.community_count, 0) AS communityCount,
       COALESCE(fl.flow_count, 0) AS flowCount
     FROM repositories r
     LEFT JOIN file_counts f ON f.repository_id = r.id
     LEFT JOIN symbol_counts s ON s.repository_id = r.id
     LEFT JOIN edge_counts e ON e.repository_id = r.id
     LEFT JOIN community_counts c ON c.repository_id = r.id
     LEFT JOIN flow_counts fl ON fl.repository_id = r.id
     ORDER BY r.repo_id`,
    )
    .all();
  return rows.map((value) => {
    if (
      !isRecord(value) ||
      (value.gitHead !== null && typeof value.gitHead !== 'string')
    ) {
      throw new ProjectionProblem('corrupt');
    }
    const row = value;
    const counts = {
      fileCount: safeCount(row.fileCount),
      symbolCount: safeCount(row.symbolCount),
      edgeCount: safeCount(row.edgeCount),
      contextUnresolvedEdgeCount: safeCount(row.contextUnresolvedEdgeCount),
      contextFilesWithErrors: safeCount(row.contextFilesWithErrors),
      legacyUnresolvedEdgeCount: safeCount(row.legacyUnresolvedEdgeCount),
      legacyFilesWithErrors: safeCount(row.legacyFilesWithErrors),
      communityCount: safeCount(row.communityCount),
      flowCount: safeCount(row.flowCount),
    };
    return {
      repoId: requiredString(row.repoId),
      gitHead: value.gitHead,
      counts,
    };
  });
}

function readTopCommunities(
  db: CodeGraphDatabase,
): CodeGraphSummaryProjectionV1['topCommunities'] {
  if (!hasTable(db, 'communities')) return [];
  const rows = db
    .prepare(
      `SELECT c.id AS id, r.repo_id AS repoId, c.label AS label,
       c.size AS size, c.cohesion AS cohesion
     FROM communities c
     JOIN repositories r ON r.id = c.repository_id
     ORDER BY c.size DESC, c.id
     LIMIT 5`,
    )
    .all();
  return rows.map((value) => {
    if (!isRecord(value)) throw new ProjectionProblem('corrupt');
    const row = value;
    const cohesion = row.cohesion;
    if (typeof cohesion !== 'number' || !Number.isFinite(cohesion)) {
      throw new ProjectionProblem('corrupt');
    }
    return {
      id: requiredString(row.id),
      repoId: requiredString(row.repoId),
      label: requiredString(row.label),
      size: safeCount(row.size),
      cohesion,
    };
  });
}

function safeRelativeConfigPath(
  configPath: string,
  worktreeRootPath: string | undefined,
): string | null {
  const pathLooksAbsolute =
    path.isAbsolute(configPath) ||
    /^[A-Za-z]:[\\/]/.test(configPath) ||
    configPath.startsWith('\\\\');
  if (worktreeRootPath === undefined) {
    if (pathLooksAbsolute) {
      // Existing producers record the canonical config path with a host root.
      // Strip only that known suffix; do not invent a path for arbitrary input.
      const normalized = configPath.replace(/\\/g, '/');
      return normalized.endsWith(
        `/${CODE_GRAPH_CUSTOM_LANGUAGES_CONFIG_RELATIVE_PATH}`,
      )
        ? CODE_GRAPH_CUSTOM_LANGUAGES_CONFIG_RELATIVE_PATH
        : null;
    }
    const relative = path.normalize(configPath).replace(/\\/g, '/');
    if (
      relative === '' ||
      relative === '.' ||
      relative === '..' ||
      relative.startsWith('../') ||
      relative.startsWith('/')
    ) {
      return null;
    }
    return relative.length <= 512 ? relative : null;
  }
  const root = path.resolve(worktreeRootPath);
  const target = pathLooksAbsolute
    ? path.resolve(configPath)
    : path.resolve(root, configPath);
  const relative = path.relative(root, target).replace(/\\/g, '/');
  if (
    relative === '' ||
    relative === '.' ||
    relative === '..' ||
    relative.startsWith('../') ||
    relative.startsWith('/') ||
    /^[A-Za-z]:/.test(relative)
  ) {
    return null;
  }
  return relative.length <= 512 ? relative : null;
}

function replaceAsciiDiagnosticControls(value: string): string {
  let sanitized = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    sanitized += code <= 0x1f || code === 0x7f ? ' ' : value[index];
  }
  return sanitized;
}

function sanitizeDiagnosticMessage(
  message: string,
  worktreeRootPath: string | undefined,
): string {
  let sanitized = replaceAsciiDiagnosticControls(message).replace(
    /\\\\[^"'<>]*/g,
    '[path]',
  );
  if (worktreeRootPath !== undefined) {
    const root = path.resolve(worktreeRootPath);
    for (const candidate of Array.from(new Set([worktreeRootPath, root]))) {
      if (candidate.length > 0)
        sanitized = sanitized.split(candidate).join('[worktree]');
    }
  }
  sanitized = sanitized
    .replace(/([\"'`])((?:\/|[A-Za-z]:[\\/])[^\"'`]*?)\1/g, '$1[path]$1')
    .replace(/\b[A-Za-z]:\\(?:[^\\\s"'<>]+\\)*[^\\\s"'<>]*/g, '[path]')
    .replace(/\/(?:[^/\s"'<>]+\/)*[^/\s"'<>]*/g, '[path]')
    .replace(
      /(?:^|\s)(\/(?:Users|home|private|tmp|var|opt|Volumes|mnt|workspace|workspaces)\/[^"'<>;,)}\]]*)/g,
      ' [path]',
    );
  return sanitized.slice(0, 512);
}

/**
 * Final reader boundary: stored text must already be a fixed point of the
 * portable sanitizer. Identity metadata does not attest diagnostic text, so
 * writer sanitization alone is insufficient. Reject unsafe stored projections;
 * never silently rewrite language IDs/extensions or stored diagnostic entries.
 */
function isCanonicalPortableText(value: string): boolean {
  return value === sanitizeDiagnosticMessage(value, undefined);
}

const parsedCustomLanguagesReportSchema = z
  .object({
    configPath: z.string().max(4_096),
    loaded: z
      .array(
        z
          .object({
            index: safeInteger,
            id: z.string().max(256),
            extensions: z.array(z.string().max(128)).max(128),
            abiVersion: safeInteger,
          })
          .strict(),
      )
      .max(256),
    diagnostics: z
      .array(
        z
          .object({
            entryId: z.string().max(256).nullable(),
            index: safeInteger,
            message: z.string().max(8_192),
          })
          .strict(),
      )
      .max(MAX_CUSTOM_LANGUAGE_INPUT_ITEMS),
  })
  .strict();

function portableCustomLanguages(
  entries: MetadataEntries,
  worktreeRootPath: string | undefined,
): CodeGraphSummaryProjectionV1['customLanguages'] {
  const raw = metadataEntry(entries, 'custom_languages');
  if (raw.oversized || raw.raw === null || raw.raw === '') return null;
  const report = parseCustomLanguagesReport(raw.raw);
  if (report === null) return null;
  const boundedReport = parsedCustomLanguagesReportSchema.safeParse(report);
  if (!boundedReport.success) return null;
  const configRelativePath = safeRelativeConfigPath(
    boundedReport.data.configPath,
    worktreeRootPath,
  );
  if (configRelativePath === null) return null;
  const loaded = boundedReport.data.loaded.map((language) => ({
    index: language.index,
    // Identity is never rewritten: nonportable identity values reject the report.
    id: language.id,
    extensions: language.extensions,
    abiVersion: language.abiVersion,
  }));
  const keptDiagnostics = boundedReport.data.diagnostics.slice(
    0,
    MAX_CUSTOM_LANGUAGE_DIAGNOSTICS,
  );
  const diagnostics = keptDiagnostics.map((diagnostic) => ({
    entryId: diagnostic.entryId,
    index: diagnostic.index,
    message: sanitizeDiagnosticMessage(diagnostic.message, worktreeRootPath),
  }));
  const value = {
    configRelativePath,
    loaded,
    diagnostics,
    omittedDiagnosticCount:
      boundedReport.data.diagnostics.length - diagnostics.length,
  };
  const parsed = customLanguagesSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function createProjection(
  metadata: ParsedMetadata,
  repositories: readonly RepositoryCounts[],
  totals: z.infer<typeof countShapeSchema>,
  topCommunities: CodeGraphSummaryProjectionV1['topCommunities'],
  customLanguages: CodeGraphSummaryProjectionV1['customLanguages'],
  projectionRevision: number,
): CodeGraphSummaryProjectionV1 | null {
  const schemaVersion = metadata.observed.schemaVersion;
  const extractorVersion = metadata.observed.extractorVersion;
  if (
    schemaVersion === null ||
    extractorVersion === null ||
    metadata.assembly === null
  ) {
    return null;
  }
  const candidate = {
    formatVersion: 1,
    schemaVersion,
    extractorVersion,
    projectionRevision,
    lastBuildAt: metadata.observed.lastBuildAt,
    completedBuildAt: metadata.observed.completedBuildAt,
    derivedAt: metadata.observed.derivedAt,
    assembly: metadata.assembly,
    customLanguagesFingerprint: metadata.customLanguagesFingerprint,
    repositories: repositories.map((repository) => ({
      repoId: repository.repoId,
      gitHead: repository.gitHead,
      counts: repository.counts,
    })),
    totals,
    topCommunities,
    customLanguages,
  };
  const parsed = codeGraphSummaryProjectionV1Schema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function serializeProjection(
  projection: CodeGraphSummaryProjectionV1,
): string | null {
  const serialized = JSON.stringify(projection);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PROJECTION_BYTES) return null;
  return serialized;
}

function prepareProjection(
  db: CodeGraphDatabase,
  options: {
    reuseProjection?: CodeGraphSummaryProjectionV1;
    worktreeRootPath?: string;
  } = {},
): PreparedProjection | null {
  const entries = readWhitelistedMetadata(db);
  const metadata = parsedMetadata(entries);
  if (
    metadata.unsupportedSchema ||
    metadata.invalidMarkers ||
    metadataEntry(entries, 'custom_languages_fingerprint').oversized ||
    metadataEntry(entries, 'custom_languages').oversized ||
    metadata.observed.schemaVersion === null ||
    metadata.observed.extractorVersion === null
  ) {
    return null;
  }
  const projectionCounter = parseCounter(metadata.projectionRevisionRaw);
  if (projectionCounter === null) return null;
  const nextRevision = projectionCounter + 1;
  if (!Number.isSafeInteger(nextRevision)) return null;

  let repositories: RepositoryCounts[];
  let totals: z.infer<typeof countShapeSchema>;
  let topCommunities: CodeGraphSummaryProjectionV1['topCommunities'];
  if (options.reuseProjection !== undefined) {
    const reused = codeGraphSummaryProjectionV1Schema.safeParse(
      options.reuseProjection,
    );
    if (!reused.success) return null;
    const heads = repositoryHeadRows(db);
    if (heads.length !== reused.data.repositories.length) return null;
    repositories = [];
    for (let index = 0; index < heads.length; index += 1) {
      const head = heads[index];
      const previous = reused.data.repositories[index];
      if (
        head === undefined ||
        previous === undefined ||
        head.repoId !== previous.repoId
      ) {
        return null;
      }
      repositories.push({
        ...head,
        counts: previous.counts,
      });
    }
    totals = reused.data.totals;
    topCommunities = reused.data.topCommunities;
  } else {
    repositories = readAggregatedCounts(db);
    totals = sumCounts(repositories);
    topCommunities = readTopCommunities(db);
  }
  const customLanguages = portableCustomLanguages(
    entries,
    options.worktreeRootPath,
  );
  const projection = createProjection(
    metadata,
    repositories,
    totals,
    topCommunities,
    customLanguages,
    nextRevision,
  );
  if (projection === null) return null;
  const serialized = serializeProjection(projection);
  if (serialized === null) return null;
  return {
    projection,
    serialized,
    identityFingerprint: hashProjectionIdentity(
      projection.repositories,
      entries,
      projection.projectionRevision,
    ),
  };
}

function storePreparedProjection(
  db: CodeGraphDatabase,
  prepared: PreparedProjection,
): void {
  setMetadataValue(
    db,
    SUMMARY_PROJECTION_REVISION_KEY,
    String(prepared.projection.projectionRevision),
  );
  setMetadataValue(
    db,
    SUMMARY_PROJECTION_IDENTITY_KEY,
    prepared.identityFingerprint,
  );
  setMetadataValue(db, SUMMARY_PROJECTION_KEY, prepared.serialized);
}

/**
 * Publishes inside the caller-owned writer transaction. Reuse is valid only
 * when the caller certifies facts and derived membership did not change;
 * repository heads and marker metadata are refreshed regardless. Do not call
 * this for immutable `generations/<id>/graph.db` published bases: trusted
 * callers must use a mutable worktree or staging database.
 */
export function publishCodeGraphSummaryProjection(
  db: CodeGraphDatabase,
  options: {
    reuseProjection?: CodeGraphSummaryProjectionV1;
    worktreeRootPath?: string;
  } = {},
): CodeGraphSummaryProjectionV1 | null {
  let prepared: PreparedProjection | null;
  try {
    prepared = prepareProjection(db, options);
  } catch (error) {
    if (!(error instanceof ProjectionProblem)) throw error;
    clearCodeGraphSummaryProjection(db);
    return null;
  }
  if (prepared === null) {
    clearCodeGraphSummaryProjection(db);
    return null;
  }
  storePreparedProjection(db, prepared);
  return prepared.projection;
}

/** Removes the projection and its repo/head identity, but never resets its revision counter. */
export function clearCodeGraphSummaryProjection(db: CodeGraphDatabase): void {
  deleteMetadataValue(db, SUMMARY_PROJECTION_KEY);
  deleteMetadataValue(db, SUMMARY_PROJECTION_IDENTITY_KEY);
}

function projectionPending(
  reason: Extract<
    ReadCodeGraphSummaryProjectionResult,
    { state: 'pending' }
  >['reason'],
  metadata: ParsedMetadata,
): ReadCodeGraphSummaryProjectionResult {
  return {
    state: 'pending',
    reason,
    observed: metadata.observed,
    diagnostics: metadata.diagnostics,
  };
}

function readProjectionFromOpenDatabase(
  db: CodeGraphDatabase,
): ReadCodeGraphSummaryProjectionResult {
  let entries: MetadataEntries;
  let metadata: ParsedMetadata;
  try {
    entries = readWhitelistedMetadata(db);
    metadata = parsedMetadata(entries);
  } catch (error) {
    return { state: 'error', classification: classifyDatabaseError(error) };
  }
  if (metadata.unsupportedSchema) {
    return { state: 'error', classification: 'unsupported-schema' };
  }
  if (metadata.buildIncomplete) {
    return projectionPending('build-incomplete', metadata);
  }
  if (metadata.projectionRaw === null && !metadata.projectionOversized) {
    return projectionPending('projection-missing', metadata);
  }
  if (metadata.projectionOversized) {
    return projectionPending('projection-invalid', metadata);
  }
  if (metadata.invalidMarkers || metadata.invalidIdentity) {
    return projectionPending('projection-mismatch', metadata);
  }
  const projectionBytes = Buffer.byteLength(
    metadata.projectionRaw ?? '',
    'utf8',
  );
  if (projectionBytes > MAX_PROJECTION_BYTES) {
    return projectionPending('projection-invalid', metadata);
  }
  let rawProjection: unknown;
  try {
    rawProjection = JSON.parse(metadata.projectionRaw ?? '');
  } catch {
    return projectionPending('projection-invalid', metadata);
  }
  const parsedProjection =
    codeGraphSummaryProjectionV1Schema.safeParse(rawProjection);
  if (!parsedProjection.success) {
    return projectionPending('projection-invalid', metadata);
  }
  const projection = parsedProjection.data;
  const expectedIdentity = hashProjectionIdentity(
    projection.repositories,
    entries,
    projection.projectionRevision,
  );
  const markerAssemblyValue = metadata.assembly;
  const metadataMatches =
    metadata.observed.schemaVersion !== null &&
    metadata.observed.extractorVersion !== null &&
    metadata.observed.projectionRevision !== null &&
    metadata.observed.projectionRevision > 0 &&
    metadata.identityFingerprint !== null &&
    markerAssemblyValue !== null &&
    projection.schemaVersion === metadata.observed.schemaVersion &&
    projection.extractorVersion === metadata.observed.extractorVersion &&
    projection.projectionRevision === metadata.observed.projectionRevision &&
    metadata.projectionRevisionRaw === String(projection.projectionRevision) &&
    projection.lastBuildAt === metadata.observed.lastBuildAt &&
    projection.completedBuildAt === metadata.observed.completedBuildAt &&
    projection.derivedAt === metadata.observed.derivedAt &&
    projection.assembly === markerAssemblyValue &&
    projection.customLanguagesFingerprint ===
      metadata.customLanguagesFingerprint &&
    expectedIdentity === metadata.identityFingerprint;
  if (!metadataMatches) {
    return projectionPending('projection-mismatch', metadata);
  }
  return {
    state: 'ready',
    projection,
    diagnostics: metadata.diagnostics,
  };
}

/**
 * Reads only the whitelisted projection metadata from a caller-owned, already
 * consistent database view. It never reads repositories or fact tables.
 */
export function readCodeGraphSummaryProjectionFromDatabase(
  db: CodeGraphDatabase,
): ReadCodeGraphSummaryProjectionResult {
  return readProjectionFromOpenDatabase(db);
}

function codeFromError(error: unknown): string | null {
  if (!isRecord(error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}

function messageFromError(error: unknown): string {
  if (error instanceof Error) return error.message.toLowerCase();
  return isRecord(error) && typeof error.message === 'string'
    ? error.message.toLowerCase()
    : '';
}

function classifyDatabaseError(
  error: unknown,
): CodeGraphSummaryProjectionErrorClassification {
  if (error instanceof ProjectionProblem) return error.classification;
  const code = codeFromError(error) ?? '';
  const message = messageFromError(error);
  if (code === 'EACCES' || code === 'EPERM' || code.includes('READONLY')) {
    return 'permission-denied';
  }
  if (
    code.includes('BUSY') ||
    code.includes('LOCKED') ||
    /database is (?:busy|locked)/.test(message)
  ) {
    return 'busy';
  }
  if (
    code.includes('CORRUPT') ||
    code.includes('NOTADB') ||
    /not a database|database disk image is malformed/.test(message)
  ) {
    return 'corrupt';
  }
  if (
    /no such table|no such column|unsupported schema|schema version/.test(
      message,
    )
  ) {
    return 'unsupported-schema';
  }
  return 'io';
}

/**
 * Standalone metadata-only readonly reader. Missing is returned only for an
 * absent database file; every opened handle and read transaction is closed.
 */
export function readCodeGraphSummaryProjectionDatabase(
  dbPath: string,
): ReadCodeGraphSummaryProjectionResult {
  let db: CodeGraphDatabase | undefined;
  let transactionStarted = false;
  try {
    // node:sqlite can report a missing file as ERR_SQLITE_ERROR, not ENOENT.
    // A stat distinguishes only genuinely missing files from permission/I/O errors.
    statSync(dbPath);
    db = new DatabaseSync(dbPath, {
      readOnly: true,
      timeout: CODE_GRAPH_BUSY_TIMEOUT_MS,
    });
    db.exec('BEGIN;');
    transactionStarted = true;
    const result = readProjectionFromOpenDatabase(db);
    db.exec('COMMIT;');
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) {
      try {
        db?.exec('ROLLBACK;');
      } catch {
        // Preserve the original readonly failure classification.
      }
    }
    if (codeFromError(error) === 'ENOENT') return { state: 'missing' };
    return { state: 'error', classification: classifyDatabaseError(error) };
  } finally {
    try {
      db?.close();
    } catch {
      // Closing a readonly handle does not alter the classification.
    }
  }
}

function readMetadataTokens(db: CodeGraphDatabase): Array<[string, string]> {
  const rows = db
    .prepare('SELECT key, value FROM graph_metadata ORDER BY key')
    .all();
  const tokens: Array<[string, string]> = [];
  for (const value of rows) {
    if (
      !isRecord(value) ||
      typeof value.key !== 'string' ||
      typeof value.value !== 'string'
    ) {
      throw new ProjectionProblem('corrupt');
    }
    tokens.push([value.key, value.value]);
  }
  return tokens;
}

function repositoryHeadsEqual(
  left: readonly RepositoryHead[],
  right: readonly RepositoryHead[],
): boolean {
  return (
    left.length === right.length &&
    left.every((repository, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        repository.repoId === other.repoId &&
        repository.gitHead === other.gitHead
      );
    })
  );
}

function metadataTokensEqual(
  left: readonly [string, string][],
  right: readonly [string, string][],
): boolean {
  return (
    left.length === right.length &&
    left.every((token, index) => {
      const other = right[index];
      return (
        other !== undefined && token[0] === other[0] && token[1] === other[1]
      );
    })
  );
}

function isImmutablePublishedGenerationPath(dbPath: string): boolean {
  const segments = dbPath
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0);
  return segments.some(
    (segment, index) =>
      segment === 'generations' &&
      segments[index + 1] !== undefined &&
      segments[index + 2] === 'graph.db',
  );
}

function backfillErrorResult(
  error: unknown,
): BackfillCodeGraphSummaryProjectionResult {
  const classification = classifyDatabaseError(error);
  if (
    error instanceof ProjectionProblem &&
    error.classification === 'corrupt'
  ) {
    return { state: 'error', classification, reason: 'projection-invalid' };
  }
  return { state: 'error', classification };
}

/**
 * CLI-only readonly exception: performs one grouped committed fact-count read
 * and can return an ephemeral measured legacy assembly. It never persists a
 * revision (the effective revision is zero when no counter exists), runs
 * migrations, quick_check, grammar loading, or writes. Unlike the interactive
 * reader it may read fact/repository tables within this short transaction.
 */
export function readCodeGraphSummaryProjectionAssemblyDatabase(
  dbPath: string,
  options: { worktreeRootPath?: string } = {},
): ReadCodeGraphSummaryProjectionResult {
  let db: CodeGraphDatabase | undefined;
  let transactionStarted = false;
  try {
    // node:sqlite can report a missing file as ERR_SQLITE_ERROR, not ENOENT.
    // A stat distinguishes only genuinely missing files from permission/I/O errors.
    statSync(dbPath);
    db = new DatabaseSync(dbPath, {
      readOnly: true,
      timeout: CODE_GRAPH_BUSY_TIMEOUT_MS,
    });
    db.exec('BEGIN;');
    transactionStarted = true;
    const entries = readWhitelistedMetadata(db);
    const metadata = parsedMetadata(entries);
    if (metadata.unsupportedSchema) {
      db.exec('COMMIT;');
      transactionStarted = false;
      return { state: 'error', classification: 'unsupported-schema' };
    }
    if (metadata.buildIncomplete) {
      // A projection records its extractor version, so there is nothing to
      // assemble yet and no reason to count facts.
      db.exec('COMMIT;');
      transactionStarted = false;
      return projectionPending('build-incomplete', metadata);
    }
    if (metadata.invalidMarkers) {
      db.exec('COMMIT;');
      transactionStarted = false;
      return projectionPending('projection-mismatch', metadata);
    }
    const revision = parseCounter(metadata.projectionRevisionRaw);
    if (revision === null) {
      db.exec('COMMIT;');
      transactionStarted = false;
      return projectionPending('projection-mismatch', metadata);
    }
    const repositories = readAggregatedCounts(db);
    const projection = createProjection(
      metadata,
      repositories,
      sumCounts(repositories),
      readTopCommunities(db),
      portableCustomLanguages(entries, options.worktreeRootPath),
      revision,
    );
    db.exec('COMMIT;');
    transactionStarted = false;
    if (projection === null || serializeProjection(projection) === null) {
      return projectionPending('projection-invalid', metadata);
    }
    return {
      state: 'ready',
      projection,
      diagnostics: metadata.diagnostics,
    };
  } catch (error) {
    if (transactionStarted) {
      try {
        db?.exec('ROLLBACK;');
      } catch {
        // Preserve the original readonly failure classification.
      }
    }
    if (codeFromError(error) === 'ENOENT') return { state: 'missing' };
    return { state: 'error', classification: classifyDatabaseError(error) };
  } finally {
    try {
      db?.close();
    } catch {
      // Closing a readonly handle does not alter the classification.
    }
  }
}

/**
 * Reads committed counts, ends that read transaction, then uses a short
 * guarded writer transaction to publish. The required existing writer handle is
 * caller-owned and must be idle; it is never opened or closed here. CAS compares every raw
 * graph_metadata token and the repository/head set. The operation does not
 * scan source files or advance build freshness markers.
 */
export function backfillCodeGraphSummaryProjection(
  dbPath: string,
  options: BackfillCodeGraphSummaryProjectionOptions,
): BackfillCodeGraphSummaryProjectionResult {
  // Refuse before any readonly count view or nested CAS: uncommitted caller
  // facts must never be paired with a projection measured from the old commit.
  if (hasActiveCodeGraphWriteTransaction(options.db)) {
    return { state: 'error', classification: 'busy' };
  }
  let canonicalDbPath: string;
  try {
    canonicalDbPath = realpathSync(dbPath);
  } catch (error) {
    return backfillErrorResult(error);
  }
  if (
    isImmutablePublishedGenerationPath(dbPath) ||
    isImmutablePublishedGenerationPath(canonicalDbPath)
  ) {
    return {
      state: 'error',
      classification: 'unsupported-schema',
      reason: 'immutable-published-base',
    };
  }
  let reader: CodeGraphDatabase | undefined;
  let readTransactionStarted = false;
  let metadataTokens: Array<[string, string]> = [];
  let repositoryHeads: RepositoryHead[] = [];
  let measuredProjection: CodeGraphSummaryProjectionV1 | null = null;
  try {
    reader = new DatabaseSync(dbPath, {
      readOnly: true,
      timeout: CODE_GRAPH_BUSY_TIMEOUT_MS,
    });
    reader.exec('BEGIN;');
    readTransactionStarted = true;
    const entries = readWhitelistedMetadata(reader);
    const metadata = parsedMetadata(entries);
    // An incomplete build has no extractor version to record; the next build
    // or seed publishes its projection.
    if (metadata.unsupportedSchema || metadata.buildIncomplete)
      throw new ProjectionProblem('unsupported-schema');
    if (metadata.invalidMarkers) throw new ProjectionProblem('corrupt');
    const revision = parseCounter(metadata.projectionRevisionRaw);
    if (revision === null) throw new ProjectionProblem('corrupt');
    metadataTokens = readMetadataTokens(reader);
    const repositories = readAggregatedCounts(reader);
    repositoryHeads = repositories.map(({ repoId, gitHead }) => ({
      repoId,
      gitHead,
    }));
    measuredProjection = createProjection(
      metadata,
      repositories,
      sumCounts(repositories),
      readTopCommunities(reader),
      portableCustomLanguages(entries, options.worktreeRootPath),
      revision,
    );
    if (
      measuredProjection === null ||
      serializeProjection(measuredProjection) === null
    ) {
      throw new ProjectionProblem('corrupt');
    }
    reader.exec('COMMIT;');
    readTransactionStarted = false;
  } catch (error) {
    if (readTransactionStarted) {
      try {
        reader?.exec('ROLLBACK;');
      } catch {
        // Keep the original failure.
      }
    }
    return backfillErrorResult(error);
  } finally {
    try {
      reader?.close();
    } catch {
      // Reader closure is best-effort after its transaction has ended.
    }
  }

  try {
    const activeWriter = options.db;
    // Require the supplied trusted writer to actually address the measured DB.
    // No writable connection is opened by the summary-maintenance helper.
    const writerTargets = activeWriter.prepare('PRAGMA database_list').all();
    const mainTarget = writerTargets.find(
      (value) => isRecord(value) && value.name === 'main',
    );
    if (
      !isRecord(mainTarget) ||
      typeof mainTarget.file !== 'string' ||
      realpathSync(mainTarget.file) !== canonicalDbPath
    ) {
      return { state: 'error', classification: 'io' };
    }
    const result =
      withImmediateTransaction<BackfillCodeGraphSummaryProjectionResult>(
        activeWriter,
        () => {
          if (
            !metadataTokensEqual(
              metadataTokens,
              readMetadataTokens(activeWriter),
            ) ||
            !repositoryHeadsEqual(
              repositoryHeads,
              repositoryHeadRows(activeWriter),
            )
          ) {
            return { state: 'superseded' };
          }
          const prepared = prepareProjection(activeWriter, {
            reuseProjection: measuredProjection ?? undefined,
            worktreeRootPath: options.worktreeRootPath,
          });
          if (prepared === null) throw new ProjectionProblem('corrupt');
          storePreparedProjection(activeWriter, prepared);
          return { state: 'ready', projection: prepared.projection };
        },
      );
    return result;
  } catch (error) {
    return backfillErrorResult(error);
  }
}

/** Explicit CLI-only readonly count exception; never used by interactive hosts. */
export const readReadonlyCodeGraphSummaryProjectionAssembly =
  readCodeGraphSummaryProjectionAssemblyDatabase;
