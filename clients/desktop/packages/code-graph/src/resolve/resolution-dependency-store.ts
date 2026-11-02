/**
 * Draft for packages/code-graph/src/resolve/resolution-dependency-store.ts
 *
 * Uses the already-open graph writer and schema-v5 tables. This class never
 * opens a database or starts a transaction: engine.ts remains the sole owner
 * of the existing build transaction and publication boundary.
 */
import { createHash } from 'node:crypto';
import {
  deleteMetadataValue,
  getMetadataValue,
  requireRow,
  requireString,
  setMetadataValue,
} from '../store/database';
import type { CodeGraphDatabase } from '../store/database';
import { repositoryRowId } from '../ids';
import {
  canonicalResolutionDependencyJson,
  resolutionDependencyCaptureMetadataKey,
  RESOLUTION_CAPTURE_ALGORITHM_VERSIONS,
  RESOLUTION_CAPTURE_FORMAT_VERSION,
  RESOLUTION_CAPTURE_MAX_SOURCE_FILE_IDS,
  RESOLUTION_CAPTURE_RESOLVERS,
  RESOLUTION_CAPTURE_SCHEMA_VERSION,
} from './resolution-dependency-capture';
import type {
  ResolutionCaptureResolver,
  ResolutionDependencyCaptureMetadata,
  ResolutionDependencyCaptureMetadataInput,
  ResolutionDependencyCoverage,
  ResolutionDependencyJson,
  ResolutionDependencyObservation,
  ResolutionDependencySource,
  ResolutionDependencyWriter,
} from './resolution-dependency-capture';

const VISITED_SOURCES_TEMP_TABLE = 'w3_resolution_dependency_visited_sources';
const SELECTED_FILES_TEMP_TABLE = 'w3_resolution_dependency_selected_files';
const MAX_SQLITE_BATCH_SIZE = 1_000;

interface ActiveResolverPass {
  repoId: string;
  resolver: ResolutionCaptureResolver;
  sourceFileIds: readonly string[] | undefined;
  selectedFileIdSet: ReadonlySet<string> | undefined;
}

function identity(kind: string, key: string): string {
  return `${kind}\u0000${key}`;
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizeSourceFileIds(
  sourceFileIds: readonly string[] | undefined,
): readonly string[] | undefined {
  if (sourceFileIds === undefined) return undefined;
  if (new Set(sourceFileIds).size > RESOLUTION_CAPTURE_MAX_SOURCE_FILE_IDS) {
    throw new Error(
      `Capture selection exceeds ${RESOLUTION_CAPTURE_MAX_SOURCE_FILE_IDS} source files`,
    );
  }
  return Array.from(new Set(sourceFileIds)).sort(compareCodeUnits);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isCaptureResolver(value: unknown): value is ResolutionCaptureResolver {
  return (
    typeof value === 'string' &&
    RESOLUTION_CAPTURE_RESOLVERS.some((resolver) => resolver === value)
  );
}

function parseStringArray(value: unknown): readonly string[] | null {
  if (!isUnknownArray(value)) return null;
  const output: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    output.push(item);
  }
  return output;
}

function parseResolverArray(
  value: unknown,
): readonly ResolutionCaptureResolver[] | null {
  if (!isUnknownArray(value)) return null;
  const output: ResolutionCaptureResolver[] = [];
  for (const item of value) {
    if (!isCaptureResolver(item)) return null;
    output.push(item);
  }
  return output;
}

function parseAlgorithmVersions(
  value: unknown,
): Readonly<Record<ResolutionCaptureResolver, number>> | null {
  if (!isRecord(value)) return null;
  const output: Record<ResolutionCaptureResolver, number> = {
    'ts-module-resolution': 0,
    'config-extends': 0,
    'doc-link': 0,
    'ipc-channel': 0,
    'workflow-action': 0,
    'call-resolution': 0,
    'test-linker': 0,
  };
  for (const resolver of RESOLUTION_CAPTURE_RESOLVERS) {
    const version = value[resolver];
    if (typeof version !== 'number' || !Number.isInteger(version)) return null;
    output[resolver] = version;
  }
  return output;
}

function parseReasonsByResolver(
  value: unknown,
): Readonly<
  Partial<Record<ResolutionCaptureResolver, readonly string[]>>
> | null {
  if (!isRecord(value)) return null;
  const output: Partial<Record<ResolutionCaptureResolver, readonly string[]>> =
    {};
  for (const resolver of RESOLUTION_CAPTURE_RESOLVERS) {
    const reasons = value[resolver];
    if (reasons === undefined) continue;
    const parsed = parseStringArray(reasons);
    if (parsed === null) return null;
    output[resolver] = parsed;
  }
  return output;
}

function parseDependencyCoverage(
  value: unknown,
): Readonly<
  Record<ResolutionCaptureResolver, ResolutionDependencyCoverage>
> | null {
  if (!isRecord(value)) return null;
  const output: Record<
    ResolutionCaptureResolver,
    ResolutionDependencyCoverage
  > = {
    'ts-module-resolution': { rowCount: 0, sourceCount: 0, sha256: '' },
    'config-extends': { rowCount: 0, sourceCount: 0, sha256: '' },
    'doc-link': { rowCount: 0, sourceCount: 0, sha256: '' },
    'ipc-channel': { rowCount: 0, sourceCount: 0, sha256: '' },
    'workflow-action': { rowCount: 0, sourceCount: 0, sha256: '' },
    'call-resolution': { rowCount: 0, sourceCount: 0, sha256: '' },
    'test-linker': { rowCount: 0, sourceCount: 0, sha256: '' },
  };
  for (const resolver of RESOLUTION_CAPTURE_RESOLVERS) {
    const entry = value[resolver];
    if (!isRecord(entry)) return null;
    const rowCount = entry.rowCount;
    const sourceCount = entry.sourceCount;
    const sha256 = entry.sha256;
    if (
      typeof rowCount !== 'number' ||
      !Number.isInteger(rowCount) ||
      rowCount < 0 ||
      typeof sourceCount !== 'number' ||
      !Number.isInteger(sourceCount) ||
      sourceCount < 0 ||
      typeof sha256 !== 'string'
    ) {
      return null;
    }
    output[resolver] = { rowCount, sourceCount, sha256 };
  }
  return output;
}

function parseMetadata(
  value: string | null,
): ResolutionDependencyCaptureMetadata | null {
  if (value === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const schemaVersion = parsed.schemaVersion;
  const captureVersion = parsed.captureVersion;
  const rootPath = parsed.rootPath;
  const complete = parsed.complete;
  const algorithmVersions = parseAlgorithmVersions(parsed.algorithmVersions);
  const incompleteResolvers = parseResolverArray(parsed.incompleteResolvers);
  const reasonsByResolver = parseReasonsByResolver(parsed.reasonsByResolver);
  const dependencyCoverage = parseDependencyCoverage(parsed.dependencyCoverage);
  if (
    schemaVersion !== RESOLUTION_CAPTURE_SCHEMA_VERSION ||
    captureVersion !== RESOLUTION_CAPTURE_FORMAT_VERSION ||
    typeof rootPath !== 'string' ||
    typeof complete !== 'boolean' ||
    algorithmVersions === null ||
    incompleteResolvers === null ||
    reasonsByResolver === null ||
    dependencyCoverage === null
  ) {
    return null;
  }
  return {
    schemaVersion: RESOLUTION_CAPTURE_SCHEMA_VERSION,
    captureVersion: RESOLUTION_CAPTURE_FORMAT_VERSION,
    rootPath,
    complete,
    algorithmVersions,
    incompleteResolvers,
    reasonsByResolver,
    dependencyCoverage,
  };
}

function metadataJson(
  metadata: ResolutionDependencyCaptureMetadata,
): ResolutionDependencyJson {
  const algorithmVersions: Record<string, ResolutionDependencyJson> = {};
  const reasonsByResolver: Record<string, ResolutionDependencyJson> = {};
  const dependencyCoverage: Record<string, ResolutionDependencyJson> = {};
  for (const resolver of RESOLUTION_CAPTURE_RESOLVERS) {
    algorithmVersions[resolver] = metadata.algorithmVersions[resolver];
    const reasons = metadata.reasonsByResolver[resolver];
    if (reasons !== undefined) reasonsByResolver[resolver] = [...reasons];
    const coverage = metadata.dependencyCoverage[resolver];
    dependencyCoverage[resolver] = {
      rowCount: coverage.rowCount,
      sourceCount: coverage.sourceCount,
      sha256: coverage.sha256,
    };
  }
  return {
    schemaVersion: metadata.schemaVersion,
    captureVersion: metadata.captureVersion,
    rootPath: metadata.rootPath,
    complete: metadata.complete,
    algorithmVersions,
    incompleteResolvers: [...metadata.incompleteResolvers],
    reasonsByResolver,
    dependencyCoverage,
  };
}

function versionsMatch(
  versions: Readonly<Record<ResolutionCaptureResolver, number>>,
): boolean {
  return RESOLUTION_CAPTURE_RESOLVERS.every(
    (resolver) =>
      versions[resolver] === RESOLUTION_CAPTURE_ALGORITHM_VERSIONS[resolver],
  );
}

function dependencyCoverageFor(
  db: CodeGraphDatabase,
  repoId: string,
): Readonly<Record<ResolutionCaptureResolver, ResolutionDependencyCoverage>> {
  const repositoryId = repositoryRowId(repoId);
  const hashers = new Map<
    ResolutionCaptureResolver,
    ReturnType<typeof createHash>
  >();
  for (const resolver of RESOLUTION_CAPTURE_RESOLVERS) {
    hashers.set(resolver, createHash('sha256'));
  }
  const counts: Record<
    ResolutionCaptureResolver,
    { rows: number; sources: number }
  > = {
    'ts-module-resolution': { rows: 0, sources: 0 },
    'config-extends': { rows: 0, sources: 0 },
    'doc-link': { rows: 0, sources: 0 },
    'ipc-channel': { rows: 0, sources: 0 },
    'workflow-action': { rows: 0, sources: 0 },
    'call-resolution': { rows: 0, sources: 0 },
    'test-linker': { rows: 0, sources: 0 },
  };
  const countRows = db
    .prepare(
      `SELECT resolver, COUNT(*) AS row_count,
         COUNT(DISTINCT source_file_id || char(0) || source_edge_id) AS source_count
       FROM resolution_dependencies WHERE repository_id = ? GROUP BY resolver`,
    )
    .all(repositoryId);
  for (const row of countRows) {
    const columns = requireRow(row);
    const resolver = requireString(columns, 'resolver');
    if (!isCaptureResolver(resolver)) {
      throw new Error(`Unknown resolution dependency resolver: ${resolver}`);
    }
    const rowCount = columns.row_count;
    const sourceCount = columns.source_count;
    if (
      typeof rowCount !== 'number' ||
      typeof sourceCount !== 'number' ||
      !Number.isInteger(rowCount) ||
      !Number.isInteger(sourceCount)
    ) {
      throw new Error('Invalid resolution dependency coverage counts');
    }
    counts[resolver] = { rows: rowCount, sources: sourceCount };
  }
  // Preserve the complete primary-key order while retaining only one batch.
  // Dependency coverage can exceed the source-file closure cap by many rows.
  const firstBatch = db.prepare(`
    SELECT resolver, source_file_id, source_edge_id, dependency_kind,
      dependency_key, dependency_value
    FROM resolution_dependencies WHERE repository_id = ?
    ORDER BY resolver, source_file_id, source_edge_id, dependency_kind, dependency_key
    LIMIT 1000
  `);
  const nextBatch = db.prepare(`
    SELECT resolver, source_file_id, source_edge_id, dependency_kind,
      dependency_key, dependency_value
    FROM resolution_dependencies
    WHERE repository_id = ?
      AND (resolver, source_file_id, source_edge_id, dependency_kind, dependency_key)
        > (?, ?, ?, ?, ?)
    ORDER BY resolver, source_file_id, source_edge_id, dependency_kind, dependency_key
    LIMIT 1000
  `);
  let cursor: readonly [string, string, string, string, string] | null = null;
  for (;;) {
    const rows: unknown[] =
      cursor === null
        ? firstBatch.all(repositoryId)
        : nextBatch.all(repositoryId, ...cursor);
    for (const row of rows) {
      const columns = requireRow(row);
      const resolverValue = requireString(columns, 'resolver');
      if (!isCaptureResolver(resolverValue)) {
        throw new Error(
          `Unknown resolution dependency resolver: ${resolverValue}`,
        );
      }
      const hasher = hashers.get(resolverValue);
      if (hasher === undefined) {
        throw new Error(`Missing coverage hasher for ${resolverValue}`);
      }
      hasher.update(
        canonicalResolutionDependencyJson([
          requireString(columns, 'source_file_id'),
          requireString(columns, 'source_edge_id'),
          requireString(columns, 'dependency_kind'),
          requireString(columns, 'dependency_key'),
          requireString(columns, 'dependency_value'),
        ]),
      );
      hasher.update('\n');
    }
    if (rows.length < 1_000) break;
    const last = requireRow(rows[rows.length - 1]);
    cursor = [
      requireString(last, 'resolver'),
      requireString(last, 'source_file_id'),
      requireString(last, 'source_edge_id'),
      requireString(last, 'dependency_kind'),
      requireString(last, 'dependency_key'),
    ];
  }
  const output: Record<
    ResolutionCaptureResolver,
    ResolutionDependencyCoverage
  > = {
    'ts-module-resolution': { rowCount: 0, sourceCount: 0, sha256: '' },
    'config-extends': { rowCount: 0, sourceCount: 0, sha256: '' },
    'doc-link': { rowCount: 0, sourceCount: 0, sha256: '' },
    'ipc-channel': { rowCount: 0, sourceCount: 0, sha256: '' },
    'workflow-action': { rowCount: 0, sourceCount: 0, sha256: '' },
    'call-resolution': { rowCount: 0, sourceCount: 0, sha256: '' },
    'test-linker': { rowCount: 0, sourceCount: 0, sha256: '' },
  };
  for (const resolver of RESOLUTION_CAPTURE_RESOLVERS) {
    const hasher = hashers.get(resolver);
    if (hasher === undefined) throw new Error(`Missing hasher for ${resolver}`);
    output[resolver] = {
      rowCount: counts[resolver].rows,
      sourceCount: counts[resolver].sources,
      sha256: hasher.digest('hex'),
    };
  }
  return output;
}

function coverageMatches(
  expected: Readonly<
    Record<ResolutionCaptureResolver, ResolutionDependencyCoverage>
  >,
  actual: Readonly<
    Record<ResolutionCaptureResolver, ResolutionDependencyCoverage>
  >,
): boolean {
  return RESOLUTION_CAPTURE_RESOLVERS.every((resolver) => {
    const left = expected[resolver];
    const right = actual[resolver];
    return (
      left.rowCount === right.rowCount &&
      left.sourceCount === right.sourceCount &&
      left.sha256 === right.sha256
    );
  });
}

function inputOwnerGapSql(resolver: ResolutionCaptureResolver): string {
  if (resolver === 'test-linker') {
    return `
        SELECT 1
        FROM (
          SELECT DISTINCT source_file_id
          FROM edges
          WHERE repository_id = ? AND kind = 'CALLS'
        ) AS owners
        WHERE NOT EXISTS (
          SELECT 1 FROM resolution_dependencies d
          WHERE d.repository_id = ? AND d.resolver = 'test-linker'
            AND d.source_file_id = owners.source_file_id
            AND d.source_edge_id = ''
            AND d.dependency_kind = 'capture-source-coverage'
        )
        LIMIT 1`;
  }

  let predicate: string;
  switch (resolver) {
    case 'ts-module-resolution':
      predicate = "e.kind = 'IMPORTS_FROM'";
      break;
    case 'config-extends':
      predicate = `f.language = 'tsconfig' AND e.kind = 'REFERENCES'
        AND json_extract(e.evidence_json, '$.configExtends') = 1`;
      break;
    case 'doc-link':
      predicate = "e.kind = 'DOCUMENTS'";
      break;
    case 'ipc-channel':
      predicate = "e.kind IN ('IPC_HANDLES', 'IPC_INVOKES')";
      break;
    case 'workflow-action':
      predicate = "e.kind = 'USES_PIPELINE_ACTION'";
      break;
    case 'call-resolution':
      predicate = `(e.kind = 'CALLS' OR e.kind = 'REFERENCES')
        AND NOT (e.kind = 'REFERENCES'
          AND COALESCE(json_extract(e.evidence_json, '$.configExtends'), 0) = 1)`;
      break;
    default:
      throw new Error(
        `Unsupported resolution dependency owner: ${String(resolver)}`,
      );
  }
  return `
      SELECT 1
      FROM edges e
      JOIN files f ON f.id = e.source_file_id
      WHERE e.repository_id = ? AND ${predicate}
        AND NOT EXISTS (
          SELECT 1 FROM resolution_dependencies d
          WHERE d.repository_id = ? AND d.resolver = ?
            AND d.source_file_id = e.source_file_id
            AND d.source_edge_id = e.id
            AND d.dependency_kind = 'capture-source-coverage'
        )
      LIMIT 1`;
}

function resolverHasUncoveredDependencyOwner(
  db: CodeGraphDatabase,
  repositoryId: string,
  resolver: ResolutionCaptureResolver,
): boolean {
  const result = db
    .prepare(
      `SELECT 1 FROM resolution_dependencies d
       WHERE d.repository_id = ? AND d.resolver = ?
         AND NOT EXISTS (
           SELECT 1 FROM resolution_dependencies sentinel
           WHERE sentinel.repository_id = d.repository_id
             AND sentinel.resolver = d.resolver
             AND sentinel.source_file_id = d.source_file_id
             AND sentinel.source_edge_id = d.source_edge_id
             AND sentinel.dependency_kind = 'capture-source-coverage'
         )
       LIMIT 1`,
    )
    .all(repositoryId, resolver);
  return result.length > 0;
}

function resolverHasUncoveredCurrentInput(
  db: CodeGraphDatabase,
  repositoryId: string,
  resolver: ResolutionCaptureResolver,
): boolean {
  const sql = inputOwnerGapSql(resolver);
  const parameters =
    resolver === 'test-linker'
      ? [repositoryId, repositoryId]
      : [repositoryId, repositoryId, resolver];
  const result = db.prepare(sql).all(...parameters);
  return result.length > 0;
}

function incompleteCoverageResolvers(
  db: CodeGraphDatabase,
  repositoryId: string,
): ResolutionCaptureResolver[] {
  return RESOLUTION_CAPTURE_RESOLVERS.filter(
    (resolver) =>
      resolverHasUncoveredDependencyOwner(db, repositoryId, resolver) ||
      resolverHasUncoveredCurrentInput(db, repositoryId, resolver),
  );
}

/**
 * Writes dependency rows into the existing v5 table. Each source is reconciled
 * independently, so only changed dependency values and removed keys are
 * written. The only retained JS map is one source's old/new observation set.
 */
export class SqliteResolutionDependencyWriter implements ResolutionDependencyWriter {
  private activePass: ActiveResolverPass | null = null;

  public constructor(private readonly db: CodeGraphDatabase) {}

  public beginResolver(
    repoId: string,
    resolver: ResolutionCaptureResolver,
    sourceFileIds: readonly string[] | undefined,
  ): void {
    const selected = normalizeSourceFileIds(sourceFileIds);
    if (this.activePass !== null) {
      throw new Error('Previous dependency resolver pass was not finished');
    }
    const repositoryId = repositoryRowId(repoId);
    this.db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS ${VISITED_SOURCES_TEMP_TABLE} (
        repository_id TEXT NOT NULL,
        resolver TEXT NOT NULL,
        source_file_id TEXT NOT NULL,
        source_edge_id TEXT NOT NULL,
        PRIMARY KEY (repository_id, resolver, source_file_id, source_edge_id)
      ) WITHOUT ROWID;
      CREATE TEMP TABLE IF NOT EXISTS ${SELECTED_FILES_TEMP_TABLE} (
        repository_id TEXT NOT NULL,
        resolver TEXT NOT NULL,
        source_file_id TEXT NOT NULL,
        PRIMARY KEY (repository_id, resolver, source_file_id)
      ) WITHOUT ROWID;
    `);
    this.db
      .prepare(
        `DELETE FROM temp.${VISITED_SOURCES_TEMP_TABLE}
         WHERE repository_id = ? AND resolver = ?`,
      )
      .run(repositoryId, resolver);
    this.db
      .prepare(
        `DELETE FROM temp.${SELECTED_FILES_TEMP_TABLE}
         WHERE repository_id = ? AND resolver = ?`,
      )
      .run(repositoryId, resolver);
    if (selected !== undefined && selected.length > 0) {
      const insertSelected = this.db.prepare(
        `INSERT INTO temp.${SELECTED_FILES_TEMP_TABLE}
         (repository_id, resolver, source_file_id) VALUES (?, ?, ?)`,
      );
      for (
        let start = 0;
        start < selected.length;
        start += MAX_SQLITE_BATCH_SIZE
      ) {
        const batch = selected.slice(start, start + MAX_SQLITE_BATCH_SIZE);
        for (const sourceFileId of batch) {
          insertSelected.run(repositoryId, resolver, sourceFileId);
        }
      }
    }
    this.activePass = {
      repoId,
      resolver,
      sourceFileIds: selected,
      selectedFileIdSet: selected === undefined ? undefined : new Set(selected),
    };
  }

  public replaceSource(
    repoId: string,
    source: ResolutionDependencySource,
    observations: readonly ResolutionDependencyObservation[],
  ): void {
    const pass = this.activePass;
    if (
      pass === null ||
      pass.repoId !== repoId ||
      pass.resolver !== source.resolver
    ) {
      throw new Error(
        'Dependency source does not belong to an active resolver pass',
      );
    }
    if (
      pass.selectedFileIdSet !== undefined &&
      !pass.selectedFileIdSet.has(source.sourceFileId)
    ) {
      throw new Error(
        'Dependency source is outside the active resolver selection',
      );
    }
    const repositoryId = repositoryRowId(repoId);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO temp.${VISITED_SOURCES_TEMP_TABLE}
         (repository_id, resolver, source_file_id, source_edge_id)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        repositoryId,
        source.resolver,
        source.sourceFileId,
        source.sourceEdgeId,
      );
    const existingRows = this.db
      .prepare(
        `SELECT dependency_kind, dependency_key, dependency_value
         FROM resolution_dependencies
         WHERE repository_id = ? AND resolver = ?
           AND source_file_id = ? AND source_edge_id = ?`,
      )
      .all(
        repositoryId,
        source.resolver,
        source.sourceFileId,
        source.sourceEdgeId,
      );
    const existing = new Map<string, string>();
    for (const row of existingRows) {
      const columns = requireRow(row);
      existing.set(
        identity(
          requireString(columns, 'dependency_kind'),
          requireString(columns, 'dependency_key'),
        ),
        requireString(columns, 'dependency_value'),
      );
    }

    const incoming = new Map<string, ResolutionDependencyObservation>();
    for (const observation of observations) {
      incoming.set(
        identity(observation.dependencyKind, observation.dependencyKey),
        observation,
      );
    }

    const deleteKey = this.db.prepare(
      `DELETE FROM resolution_dependencies
       WHERE repository_id = ? AND resolver = ? AND source_file_id = ?
         AND source_edge_id = ? AND dependency_kind = ? AND dependency_key = ?`,
    );
    for (const [priorIdentity] of Array.from(existing)) {
      if (incoming.has(priorIdentity)) continue;
      const separator = priorIdentity.indexOf('\u0000');
      if (separator < 0) throw new Error('Malformed dependency identity');
      deleteKey.run(
        repositoryId,
        source.resolver,
        source.sourceFileId,
        source.sourceEdgeId,
        priorIdentity.slice(0, separator),
        priorIdentity.slice(separator + 1),
      );
    }

    const upsert = this.db.prepare(
      `INSERT INTO resolution_dependencies (
         repository_id, resolver, source_file_id, source_edge_id,
         dependency_kind, dependency_key, dependency_value
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (
         repository_id, resolver, source_file_id, source_edge_id,
         dependency_kind, dependency_key
       ) DO UPDATE SET dependency_value = excluded.dependency_value
       WHERE resolution_dependencies.dependency_value <> excluded.dependency_value`,
    );
    for (const [observationIdentity, observation] of Array.from(incoming)) {
      const dependencyValue = canonicalResolutionDependencyJson(
        observation.dependencyValue,
      );
      if (existing.get(observationIdentity) === dependencyValue) continue;
      upsert.run(
        repositoryId,
        source.resolver,
        source.sourceFileId,
        source.sourceEdgeId,
        observation.dependencyKind,
        observation.dependencyKey,
        dependencyValue,
      );
    }
  }

  public finishResolver(
    repoId: string,
    resolver: ResolutionCaptureResolver,
    sourceFileIds: readonly string[] | undefined,
  ): void {
    const selected = normalizeSourceFileIds(sourceFileIds);
    const pass = this.activePass;
    if (pass === null || pass.repoId !== repoId || pass.resolver !== resolver) {
      throw new Error('Dependency resolver finish does not match active pass');
    }
    const selectionChanged =
      selected === undefined
        ? pass.sourceFileIds !== undefined
        : pass.sourceFileIds === undefined ||
          selected.length !== pass.sourceFileIds.length ||
          selected.some(
            (sourceFileId, index) =>
              sourceFileId !== pass.sourceFileIds?.[index],
          );
    if (selectionChanged) {
      throw new Error(
        'Dependency resolver finish selection changed during pass',
      );
    }
    const repositoryId = repositoryRowId(repoId);
    try {
      if (pass.sourceFileIds?.length === 0) return;
      const selectedClause =
        pass.sourceFileIds === undefined
          ? ''
          : `AND EXISTS (
               SELECT 1 FROM temp.${SELECTED_FILES_TEMP_TABLE} selected
               WHERE selected.repository_id = dependency.repository_id
                 AND selected.resolver = dependency.resolver
                 AND selected.source_file_id = dependency.source_file_id
             )`;
      this.db
        .prepare(
          `DELETE FROM resolution_dependencies AS dependency
           WHERE dependency.repository_id = ? AND dependency.resolver = ?
             ${selectedClause}
             AND NOT EXISTS (
               SELECT 1 FROM temp.${VISITED_SOURCES_TEMP_TABLE} visited
               WHERE visited.repository_id = dependency.repository_id
                 AND visited.resolver = dependency.resolver
                 AND visited.source_file_id = dependency.source_file_id
                 AND visited.source_edge_id = dependency.source_edge_id
             )`,
        )
        .run(repositoryId, resolver);
    } finally {
      this.db
        .prepare(
          `DELETE FROM temp.${VISITED_SOURCES_TEMP_TABLE}
           WHERE repository_id = ? AND resolver = ?`,
        )
        .run(repositoryId, resolver);
      this.db
        .prepare(
          `DELETE FROM temp.${SELECTED_FILES_TEMP_TABLE}
           WHERE repository_id = ? AND resolver = ?`,
        )
        .run(repositoryId, resolver);
      this.activePass = null;
    }
  }

  public writeMetadata(
    repoId: string,
    metadata: ResolutionDependencyCaptureMetadataInput,
  ): ResolutionDependencyCaptureMetadata {
    const repositoryId = repositoryRowId(repoId);
    const missingResolvers = incompleteCoverageResolvers(this.db, repositoryId);
    const incompleteResolvers = Array.from(
      new Set([...metadata.incompleteResolvers, ...missingResolvers]),
    ).sort(compareCodeUnits);
    const reasonsByResolver: Partial<
      Record<ResolutionCaptureResolver, readonly string[]>
    > = { ...metadata.reasonsByResolver };
    for (const resolver of missingResolvers) {
      const reasons = new Set(reasonsByResolver[resolver] ?? []);
      reasons.add('missing-current-input-owner-or-source-sentinel');
      reasonsByResolver[resolver] = Array.from(reasons).sort(compareCodeUnits);
    }
    const persistedMetadata: ResolutionDependencyCaptureMetadata = {
      ...metadata,
      complete: metadata.complete && missingResolvers.length === 0,
      incompleteResolvers,
      reasonsByResolver,
      dependencyCoverage: dependencyCoverageFor(this.db, repoId),
    };
    setMetadataValue(
      this.db,
      resolutionDependencyCaptureMetadataKey(repoId),
      canonicalResolutionDependencyJson(metadataJson(persistedMetadata)),
    );
    return persistedMetadata;
  }

  public readMetadata(
    repoId: string,
  ): ResolutionDependencyCaptureMetadata | null {
    return parseMetadata(
      getMetadataValue(this.db, resolutionDependencyCaptureMetadataKey(repoId)),
    );
  }

  public isCompatible(input: { repoId: string; rootPath: string }): boolean {
    const schemaVersionText = getMetadataValue(this.db, 'schema_version');
    const schemaVersion =
      schemaVersionText === null ? null : Number(schemaVersionText);
    const metadata = this.readMetadata(input.repoId);
    if (
      schemaVersion !== RESOLUTION_CAPTURE_SCHEMA_VERSION ||
      metadata === null ||
      metadata.schemaVersion !== RESOLUTION_CAPTURE_SCHEMA_VERSION ||
      metadata.captureVersion !== RESOLUTION_CAPTURE_FORMAT_VERSION ||
      metadata.rootPath !== input.rootPath ||
      !metadata.complete ||
      metadata.incompleteResolvers.length !== 0 ||
      !versionsMatch(metadata.algorithmVersions)
    ) {
      return false;
    }
    try {
      return (
        coverageMatches(
          metadata.dependencyCoverage,
          dependencyCoverageFor(this.db, input.repoId),
        ) &&
        incompleteCoverageResolvers(this.db, repositoryRowId(input.repoId))
          .length === 0
      );
    } catch {
      // Malformed, truncated, or unknown resolver rows invalidate the marker.
      // Compatibility is fail-closed and must never turn corruption into a
      // trusted incremental graph.
      return false;
    }
  }

  /** Snapshot/import/repository removal must call this in its writer transaction. */
  public clearRepository(repoId: string): void {
    this.db
      .prepare('DELETE FROM resolution_dependencies WHERE repository_id = ?')
      .run(repositoryRowId(repoId));
    deleteMetadataValue(
      this.db,
      resolutionDependencyCaptureMetadataKey(repoId),
    );
  }

  /** Any ordinary facts-only full reset invalidates capture until recaptured. */
  public invalidateMetadata(repoId: string): void {
    deleteMetadataValue(
      this.db,
      resolutionDependencyCaptureMetadataKey(repoId),
    );
  }

  /**
   * Engine integration must call this from its transaction `finally` block,
   * including on rollback, so connection-local temp scopes never leak.
   */
  public close(): void {
    this.db.exec(`
      DROP TABLE IF EXISTS temp.${VISITED_SOURCES_TEMP_TABLE};
      DROP TABLE IF EXISTS temp.${SELECTED_FILES_TEMP_TABLE};
    `);
    this.activePass = null;
  }
}
