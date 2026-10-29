import {
  SqliteResetSourceScope,
  sqliteResolutionResetSqlPredicates,
} from './sqlite-reset-source-scope';
import { Buffer } from 'node:buffer';
import {
  CODE_GRAPH_CONFIDENCE_TIERS,
  CODE_GRAPH_EDGE_KINDS,
  type CodeGraphConfidenceTier,
  type CodeGraphEdgeKind,
  type CodeGraphEdgeRecord,
  type CodeGraphFileRecord,
  type CodeGraphSymbolKind,
  type CodeGraphSymbolRecord,
} from '../../../types/code-graph';
import { repositoryRowId } from '../ids';
import {
  hasActiveCodeGraphWriteTransaction,
  isRecord,
  optionalNumber,
  optionalString,
  requireNumber,
  requireRow,
  requireString,
  type CodeGraphDatabase,
} from '../store/database';

const EDGE_COLUMNS =
  'id, repository_id, kind, source_symbol_id, target_symbol_id, source_file_id, target_ref, line, confidence_tier, confidence_score, resolver_id, evidence_json';

const SELECT_PROJECTED_EDGE = [
  'SELECT e.id, e.repository_id, e.kind, e.source_symbol_id, e.target_symbol_id,',
  '  e.source_file_id, e.target_ref, e.line, e.confidence_tier,',
  '  e.confidence_score, e.resolver_id, e.evidence_json',
  'FROM resolution_projection_edges e',
].join('\n');

const TEMP_SCHEMA_SQL = [
  'CREATE TEMP TABLE resolution_projection_proposals (',
  '  id TEXT PRIMARY KEY,',
  '  repository_id TEXT NOT NULL,',
  '  kind TEXT NOT NULL,',
  '  source_symbol_id TEXT,',
  '  target_symbol_id TEXT,',
  '  source_file_id TEXT NOT NULL,',
  '  target_ref TEXT,',
  '  line INTEGER,',
  '  confidence_tier TEXT NOT NULL,',
  '  confidence_score REAL NOT NULL,',
  '  resolver_id TEXT,',
  "  evidence_json TEXT NOT NULL DEFAULT '{}'",
  ');',
  'CREATE TEMP TABLE resolution_projection_generated_edges (',
  '  id TEXT PRIMARY KEY,',
  '  repository_id TEXT NOT NULL,',
  '  kind TEXT NOT NULL,',
  '  source_symbol_id TEXT,',
  '  target_symbol_id TEXT,',
  '  source_file_id TEXT NOT NULL,',
  '  target_ref TEXT,',
  '  line INTEGER,',
  '  confidence_tier TEXT NOT NULL,',
  '  confidence_score REAL NOT NULL,',
  '  resolver_id TEXT,',
  "  evidence_json TEXT NOT NULL DEFAULT '{}'",
  ');',
  'CREATE TEMP TABLE resolution_projection_candidate_ids (',
  '  id TEXT PRIMARY KEY',
  ');',
].join('\n');

function createTempBaseViewSql(
  resetSourceScope: SqliteResetSourceScope,
): string {
  const predicates = sqliteResolutionResetSqlPredicates(resetSourceScope);
  return [
    'CREATE TEMP VIEW resolution_projection_base_edges AS',
    'SELECT',
    '  e.id AS id,',
    '  r.repo_id AS repository_id,',
    '  e.kind AS kind,',
    '  e.source_symbol_id AS source_symbol_id,',
    '  CASE WHEN ' +
      predicates.resetOrDangling +
      ' THEN NULL ELSE e.target_symbol_id END AS target_symbol_id,',
    '  e.source_file_id AS source_file_id,',
    '  e.target_ref AS target_ref,',
    '  e.line AS line,',
    '  CASE WHEN ' +
      predicates.resetOrDangling +
      " THEN 'EXTRACTED' ELSE e.confidence_tier END AS confidence_tier,",
    '  CASE WHEN ' +
      predicates.resetOrDangling +
      ' THEN 1.0 ELSE e.confidence_score END AS confidence_score,',
    '  CASE WHEN ' +
      predicates.resetOrDangling +
      ' THEN NULL ELSE e.resolver_id END AS resolver_id,',
    '  CASE WHEN ' +
      predicates.resetEvidence +
      " THEN json_remove(e.evidence_json, '$.resolvedPath', '$.via', '$.candidates')",
    '       ELSE e.evidence_json END AS evidence_json',
    'FROM edges e',
    'JOIN repositories r ON r.id = e.repository_id',
    'WHERE ' + predicates.keepBaseEdge,
  ].join('\n');
}

const TEMP_OVERLAY_VIEW_SQL = [
  'CREATE TEMP VIEW resolution_projection_edges AS',
  'SELECT ' + EDGE_COLUMNS + ' FROM resolution_projection_generated_edges',
  'UNION ALL',
  'SELECT ' + EDGE_COLUMNS + ' FROM resolution_projection_proposals p',
  'WHERE NOT EXISTS (SELECT 1 FROM resolution_projection_generated_edges g WHERE g.id = p.id)',
  'UNION ALL',
  'SELECT b.id, b.repository_id, b.kind, b.source_symbol_id, b.target_symbol_id,',
  '  b.source_file_id, b.target_ref, b.line, b.confidence_tier,',
  '  b.confidence_score, b.resolver_id, b.evidence_json',
  'FROM resolution_projection_base_edges b',
  'WHERE NOT EXISTS (SELECT 1 FROM resolution_projection_proposals p WHERE p.id = b.id)',
  '  AND NOT EXISTS (SELECT 1 FROM resolution_projection_generated_edges g WHERE g.id = b.id)',
].join('\n');

const DROP_TEMP_SCHEMA_SQL = [
  'DROP VIEW IF EXISTS resolution_projection_edges;',
  'DROP VIEW IF EXISTS resolution_projection_base_edges;',
  'DROP TABLE IF EXISTS resolution_projection_candidate_ids;',
  'DROP TABLE IF EXISTS resolution_projection_generated_edges;',
  'DROP TABLE IF EXISTS resolution_projection_proposals;',
].join('\n');

const PROPOSAL_UPSERT_SQL = [
  'INSERT OR REPLACE INTO resolution_projection_proposals',
  '(id, repository_id, kind, source_symbol_id, target_symbol_id, source_file_id, target_ref, line, confidence_tier, confidence_score, resolver_id, evidence_json)',
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
].join(' ');

const GENERATED_EDGE_UPSERT_SQL = [
  'INSERT OR REPLACE INTO resolution_projection_generated_edges',
  '(id, repository_id, kind, source_symbol_id, target_symbol_id, source_file_id, target_ref, line, confidence_tier, confidence_score, resolver_id, evidence_json)',
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
].join(' ');

function createSnapshotCandidateIdsSql(
  resetSourceScope: SqliteResetSourceScope,
): string {
  return [
    'INSERT OR IGNORE INTO resolution_projection_candidate_ids (id)',
    'SELECT candidate.id FROM (',
    '  SELECT e.id AS id FROM edges e',
    '  WHERE ' + resetSourceScope.predicate('e') + ' AND (',
    '    e.resolver_id IS NOT NULL',
    "    OR json_type(e.evidence_json, '$.candidates') IS NOT NULL",
    '    OR (e.target_symbol_id IS NOT NULL AND e.target_symbol_id NOT IN',
    '        (SELECT id FROM symbols))',
    '  )',
    '  UNION',
    '  SELECT p.id AS id FROM resolution_projection_proposals p',
    '  UNION',
    '  SELECT g.id AS id FROM resolution_projection_generated_edges g',
    ') candidate',
  ].join('\n');
}

const APPLY_BATCH_SIZE = 1000;

export interface ResolutionProjectionStore {
  listEdges(filter: {
    kind?: CodeGraphEdgeKind;
    unresolvedOnly?: boolean;
    sourceFileId?: string;
    repoId?: string;
  }): CodeGraphEdgeRecord[];
  listConfigExtendsEdges(repoId: string): CodeGraphEdgeRecord[];
  listTestCallTargets(repoId: string): Array<{
    sourceFileId: string;
    targetSymbolId: string;
    testFileSymbolId: string;
  }>;
  getFileById(fileId: string): CodeGraphFileRecord | null;
  listFiles(repoId: string): CodeGraphFileRecord[];
  getSymbolByQualifiedName(
    qualifiedName: string,
    repoId: string,
  ): CodeGraphSymbolRecord | null;
  listSymbolsForFile(fileId: string): CodeGraphSymbolRecord[];
  listSymbolsByKindAndName(
    kind: CodeGraphSymbolKind,
    name: string,
    repoId: string,
  ): CodeGraphSymbolRecord[];
  updateEdgeResolution(
    edgeId: string,
    update: {
      targetSymbolId: string;
      confidenceTier: CodeGraphConfidenceTier;
      confidenceScore: number;
      resolverId: string;
      evidence: Record<string, unknown>;
    },
  ): void;
  updateEdgeEvidence(edgeId: string, evidence: Record<string, unknown>): void;
  insertEdges(edges: readonly CodeGraphEdgeRecord[]): void;
}

export interface ResolutionProjectionCounters {
  /** Rows returned from resolver-facing edge enumeration and diff reads. */
  inspectedEdges: number;
  /** Distinct edge IDs compared during the final all-field apply diff. */
  candidateEdges: number;
  /** Edge rows changed by apply inside the writer transaction. */
  finalChangedEdges: number;
  /**
   * Logical UTF-8 bytes in canonical JSON proposal payloads submitted to the
   * TEMP tables and candidate-ID snapshot. This is not measured SQLite page,
   * disk, or WAL I/O; SQLite record/index overhead is excluded.
   */
  tempIoBytes: number;
  /** No physical temporary-storage I/O measurement is available here. */
  tempIoBytesMeasured: null;
  /** Identifies tempIoBytes as a logical serialized payload counter. */
  tempIoKind: 'logical-payload';
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function narrowEnum<T extends string>(
  value: string,
  allowed: readonly T[],
  label: string,
): T {
  for (const candidate of allowed) {
    if (candidate === value) {
      return candidate;
    }
  }
  throw new Error('Unexpected ' + label + ': ' + value);
}

function edgeFromRow(value: unknown): CodeGraphEdgeRecord {
  const row = requireRow(value);
  return {
    id: requireString(row, 'id'),
    repositoryId: requireString(row, 'repository_id'),
    kind: narrowEnum(
      requireString(row, 'kind'),
      CODE_GRAPH_EDGE_KINDS,
      'edge kind',
    ),
    sourceSymbolId: optionalString(row, 'source_symbol_id'),
    targetSymbolId: optionalString(row, 'target_symbol_id'),
    sourceFileId: requireString(row, 'source_file_id'),
    targetRef: optionalString(row, 'target_ref'),
    line: optionalNumber(row, 'line'),
    confidenceTier: narrowEnum(
      requireString(row, 'confidence_tier'),
      CODE_GRAPH_CONFIDENCE_TIERS,
      'confidence tier',
    ),
    confidenceScore: requireNumber(row, 'confidence_score'),
    resolverId: optionalString(row, 'resolver_id'),
    evidence: parseJsonObject(requireString(row, 'evidence_json')),
  };
}

function normalizedJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizedJsonValue);
  }
  if (!isRecord(value)) {
    return value;
  }
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    Object.defineProperty(normalized, key, {
      value: normalizedJsonValue(value[key]),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return normalized;
}

/** Preserve the resolver's evidence ordering in stored and public payloads. */
function serializedJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('Cannot serialize a resolution projection payload');
  }
  return serialized;
}

/** Stable object-key ordering for comparisons; arrays retain semantic order. */
function stableJson(value: unknown): string {
  return serializedJson(normalizedJsonValue(value));
}

function resultChanges(result: { changes: number | bigint }): number {
  return Number(result.changes);
}

function recordParameters(
  edge: CodeGraphEdgeRecord,
): Array<string | number | null> {
  return [
    edge.id,
    edge.repositoryId,
    edge.kind,
    edge.sourceSymbolId,
    edge.targetSymbolId,
    edge.sourceFileId,
    edge.targetRef,
    edge.line,
    edge.confidenceTier,
    edge.confidenceScore,
    edge.resolverId,
    serializedJson(edge.evidence),
  ];
}

function persistentRecordParameters(
  edge: CodeGraphEdgeRecord,
): Array<string | number | null> {
  return [
    edge.id,
    repositoryRowId(edge.repositoryId),
    edge.kind,
    edge.sourceSymbolId,
    edge.targetSymbolId,
    edge.sourceFileId,
    edge.targetRef,
    edge.line,
    edge.confidenceTier,
    edge.confidenceScore,
    edge.resolverId,
    serializedJson(edge.evidence),
  ];
}

function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}

/**
 * A TEMP-backed logical extracted view for full resolver recomputation.
 *
 * The committed graph is never reset by this class. Its view applies the exact
 * resetResolutions predicate/evidence removal and nullDanglingEdgeTargets
 * target guard, while overlaying proposal rows from every earlier pass and
 * inferred test-link rows. Call apply inside the graph writer's existing
 * transaction after all resolver passes succeed; always call close from the
 * owning build finally block.
 */
export class SqliteResolutionProjection implements ResolutionProjectionStore {
  private readonly counters: ResolutionProjectionCounters = {
    inspectedEdges: 0,
    candidateEdges: 0,
    finalChangedEdges: 0,
    tempIoBytes: 0,
    tempIoBytesMeasured: null,
    tempIoKind: 'logical-payload',
  };
  private closed = false;
  private applied = false;
  private failed = false;
  private readonly resetSourceScope: SqliteResetSourceScope;

  public constructor(
    private readonly db: CodeGraphDatabase,
    private readonly store: ResolutionProjectionStore,
    options: { resetSourceFileIds?: readonly string[] } = {},
  ) {
    this.resetSourceScope = new SqliteResetSourceScope(this.db, options);
    try {
      this.resetSourceScope.install();
      this.db.exec(TEMP_SCHEMA_SQL);
      this.db.exec(createTempBaseViewSql(this.resetSourceScope));
      this.db.exec(TEMP_OVERLAY_VIEW_SQL);
    } catch (error) {
      try {
        this.close();
      } catch {
        // Preserve the setup failure that caused construction to abort.
      }
      throw error;
    }
  }

  public listEdges(filter: {
    kind?: CodeGraphEdgeKind;
    unresolvedOnly?: boolean;
    sourceFileId?: string;
    repoId?: string;
  }): CodeGraphEdgeRecord[] {
    this.ensureOpen();
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.kind !== undefined) {
      clauses.push('e.kind = ?');
      params.push(filter.kind);
    }
    if (filter.unresolvedOnly === true) {
      clauses.push('e.target_symbol_id IS NULL');
    }
    if (filter.sourceFileId !== undefined) {
      clauses.push('e.source_file_id = ?');
      params.push(filter.sourceFileId);
    }
    if (filter.repoId !== undefined) {
      clauses.push('e.repository_id = ?');
      params.push(filter.repoId);
    }
    const where = clauses.length > 0 ? 'WHERE ' + clauses.join(' AND ') : '';
    const rows = this.db
      .prepare(SELECT_PROJECTED_EDGE + '\n' + where + '\nORDER BY e.id')
      .all(...params);
    const edges = rows.map(edgeFromRow);
    this.counters.inspectedEdges += edges.length;
    return edges;
  }

  public listConfigExtendsEdges(repoId: string): CodeGraphEdgeRecord[] {
    this.ensureOpen();
    const rows = this.db
      .prepare(
        [
          'SELECT e.id, e.repository_id, e.kind, e.source_symbol_id, e.target_symbol_id,',
          '  e.source_file_id, e.target_ref, e.line, e.confidence_tier,',
          '  e.confidence_score, e.resolver_id, e.evidence_json',
          'FROM resolution_projection_edges e',
          'JOIN files f ON f.id = e.source_file_id',
          "WHERE e.repository_id = ? AND f.language = 'tsconfig'",
          "  AND e.kind = 'REFERENCES' AND e.target_symbol_id IS NULL",
          "  AND json_extract(e.evidence_json, '$.configExtends') = 1",
        ].join('\n'),
      )
      .all(repoId)
      .map(edgeFromRow);
    this.counters.inspectedEdges += rows.length;
    return rows;
  }

  public listTestCallTargets(repoId: string): Array<{
    sourceFileId: string;
    targetSymbolId: string;
    testFileSymbolId: string;
  }> {
    this.ensureOpen();
    const rows = this.db
      .prepare(
        [
          'SELECT e.source_file_id, e.target_symbol_id,',
          '  (SELECT file_symbol.id FROM symbols file_symbol',
          "   WHERE file_symbol.file_id = e.source_file_id AND file_symbol.kind = 'file'",
          '   ORDER BY file_symbol.byte_start LIMIT 1) AS test_file_symbol_id',
          'FROM resolution_projection_edges e',
          'JOIN symbols source ON source.id = e.source_symbol_id',
          '  AND source.file_id = e.source_file_id AND source.is_test = 1',
          'JOIN symbols target ON target.id = e.target_symbol_id AND target.is_test = 0',
          'JOIN files f ON f.id = e.source_file_id',
          "WHERE e.repository_id = ? AND e.kind = 'CALLS'",
          'ORDER BY e.id',
        ].join('\n'),
      )
      .all(repoId)
      .flatMap((value) => {
        const row = requireRow(value);
        const testFileSymbolId = optionalString(row, 'test_file_symbol_id');
        return testFileSymbolId === null
          ? []
          : [
              {
                sourceFileId: requireString(row, 'source_file_id'),
                targetSymbolId: requireString(row, 'target_symbol_id'),
                testFileSymbolId,
              },
            ];
      });
    this.counters.inspectedEdges += rows.length;
    return rows;
  }

  public getFileById(fileId: string): CodeGraphFileRecord | null {
    this.ensureOpen();
    return this.store.getFileById(fileId);
  }

  public listFiles(repoId: string): CodeGraphFileRecord[] {
    this.ensureOpen();
    return this.store.listFiles(repoId);
  }

  public getSymbolByQualifiedName(
    qualifiedName: string,
    repoId: string,
  ): CodeGraphSymbolRecord | null {
    this.ensureOpen();
    return this.store.getSymbolByQualifiedName(qualifiedName, repoId);
  }

  public listSymbolsForFile(fileId: string): CodeGraphSymbolRecord[] {
    this.ensureOpen();
    return this.store.listSymbolsForFile(fileId);
  }

  public listSymbolsByKindAndName(
    kind: CodeGraphSymbolKind,
    name: string,
    repoId: string,
  ): CodeGraphSymbolRecord[] {
    this.ensureOpen();
    return this.store.listSymbolsByKindAndName(kind, name, repoId);
  }

  public updateEdgeResolution(
    edgeId: string,
    update: {
      targetSymbolId: string;
      confidenceTier: CodeGraphConfidenceTier;
      confidenceScore: number;
      resolverId: string;
      evidence: Record<string, unknown>;
    },
  ): void {
    this.ensureCanPropose();
    this.assertCommittedEdgeExists(edgeId);
    const edge = this.readProjectedEdge(edgeId);
    this.writeProposal({
      ...edge,
      targetSymbolId: update.targetSymbolId,
      confidenceTier: update.confidenceTier,
      confidenceScore: update.confidenceScore,
      resolverId: update.resolverId,
      evidence: update.evidence,
    });
  }

  public updateEdgeEvidence(
    edgeId: string,
    evidence: Record<string, unknown>,
  ): void {
    this.ensureCanPropose();
    this.assertCommittedEdgeExists(edgeId);
    const edge = this.readProjectedEdge(edgeId);
    this.writeProposal({ ...edge, evidence });
  }

  public insertEdges(edges: readonly CodeGraphEdgeRecord[]): void {
    this.ensureCanPropose();
    if (edges.length === 0) {
      return;
    }
    const statement = this.db.prepare(GENERATED_EDGE_UPSERT_SQL);
    for (const edge of edges) {
      this.counters.tempIoBytes += Buffer.byteLength(stableJson(edge), 'utf8');
      statement.run(...recordParameters(edge));
    }
  }

  public apply(): ResolutionProjectionCounters {
    this.ensureOpen();
    if (this.applied) {
      throw new Error('Resolution projection apply may run only once');
    }
    if (this.failed) {
      throw new Error('A failed resolution projection cannot be retried');
    }
    if (!hasActiveCodeGraphWriteTransaction(this.db)) {
      throw new Error(
        'Resolution projection apply requires the active graph build transaction',
      );
    }
    try {
      this.snapshotCandidateIds();
      let cursor: string | null = null;
      while (true) {
        const ids = this.nextCandidateIds(cursor);
        if (ids.length === 0) {
          break;
        }
        cursor = ids[ids.length - 1];
        this.counters.candidateEdges += ids.length;

        const originals = this.loadOriginalEdges(ids);
        const projected = this.loadProjectedEdges(ids);
        this.counters.inspectedEdges += originals.length + projected.length;

        const originalById = new Map<string, CodeGraphEdgeRecord>();
        for (const edge of originals) {
          originalById.set(edge.id, edge);
        }
        const projectedById = new Map<string, CodeGraphEdgeRecord>();
        for (const edge of projected) {
          projectedById.set(edge.id, edge);
        }

        for (const id of ids) {
          const original = originalById.get(id);
          const next = projectedById.get(id);
          if (original === undefined) {
            if (next === undefined) {
              throw new Error(
                'Resolution projection candidate disappeared: ' + id,
              );
            }
            if (!this.isGeneratedEdge(id)) {
              throw new Error(
                'Resolution proposal source edge disappeared: ' + id,
              );
            }
            this.insertFinalEdge(next);
            this.counters.finalChangedEdges += 1;
            continue;
          }
          if (next === undefined) {
            if (original.resolverId !== 'test-linker') {
              throw new Error(
                'Only inferred test links may be removed by projection: ' + id,
              );
            }
            this.deleteOldTestLink(id);
            this.counters.finalChangedEdges += 1;
            continue;
          }
          if (stableJson(original) === stableJson(next)) {
            continue;
          }
          this.updateFinalEdge(next);
          this.counters.finalChangedEdges += 1;
        }
      }
      this.applied = true;
      return this.getCounters();
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }

  public getCounters(): ResolutionProjectionCounters {
    return { ...this.counters };
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    try {
      this.db.exec(DROP_TEMP_SCHEMA_SQL);
    } finally {
      this.resetSourceScope.close();
    }
    this.closed = true;
  }

  private nextCandidateIds(cursor: string | null): string[] {
    const rows =
      cursor === null
        ? this.db
            .prepare(
              'SELECT id FROM resolution_projection_candidate_ids ORDER BY id LIMIT ' +
                String(APPLY_BATCH_SIZE),
            )
            .all()
        : this.db
            .prepare(
              'SELECT id FROM resolution_projection_candidate_ids WHERE id > ? ORDER BY id LIMIT ' +
                String(APPLY_BATCH_SIZE),
            )
            .all(cursor);
    return rows.map((value) => requireString(requireRow(value), 'id'));
  }

  private snapshotCandidateIds(): void {
    this.db.exec(createSnapshotCandidateIdsSql(this.resetSourceScope));
    const row = this.db
      .prepare(
        'SELECT COALESCE(SUM(length(CAST(id AS BLOB))), 0) AS bytes FROM resolution_projection_candidate_ids',
      )
      .get();
    this.counters.tempIoBytes += requireNumber(requireRow(row), 'bytes');
  }

  private loadOriginalEdges(ids: readonly string[]): CodeGraphEdgeRecord[] {
    if (ids.length === 0) {
      return [];
    }
    const rows = this.db
      .prepare(
        [
          'SELECT e.id, r.repo_id AS repository_id, e.kind, e.source_symbol_id,',
          '  e.target_symbol_id, e.source_file_id, e.target_ref, e.line,',
          '  e.confidence_tier, e.confidence_score, e.resolver_id, e.evidence_json',
          'FROM edges e JOIN repositories r ON r.id = e.repository_id',
          'WHERE e.id IN (' + placeholders(ids.length) + ')',
          'ORDER BY e.id',
        ].join('\n'),
      )
      .all(...ids);
    return rows.map(edgeFromRow);
  }

  private loadProjectedEdges(ids: readonly string[]): CodeGraphEdgeRecord[] {
    if (ids.length === 0) {
      return [];
    }
    const rows = this.db
      .prepare(
        [
          'SELECT e.id, e.repository_id, e.kind, e.source_symbol_id,',
          '  e.target_symbol_id, e.source_file_id, e.target_ref, e.line,',
          '  e.confidence_tier, e.confidence_score, e.resolver_id, e.evidence_json',
          'FROM resolution_projection_edges e',
          'WHERE e.id IN (' + placeholders(ids.length) + ')',
          'ORDER BY e.id',
        ].join('\n'),
      )
      .all(...ids);
    return rows.map(edgeFromRow);
  }

  private writeProposal(edge: CodeGraphEdgeRecord): void {
    this.counters.tempIoBytes += Buffer.byteLength(stableJson(edge), 'utf8');
    this.db.prepare(PROPOSAL_UPSERT_SQL).run(...recordParameters(edge));
  }

  private readProjectedEdge(edgeId: string): CodeGraphEdgeRecord {
    const row = this.db
      .prepare(SELECT_PROJECTED_EDGE + '\nWHERE e.id = ?')
      .get(edgeId);
    if (row === undefined) {
      throw new Error(
        'Resolution proposal edge is missing from the logical view: ' + edgeId,
      );
    }
    this.counters.inspectedEdges += 1;
    return edgeFromRow(row);
  }

  private assertCommittedEdgeExists(edgeId: string): void {
    const row = this.db
      .prepare('SELECT 1 AS present FROM edges WHERE id = ?')
      .get(edgeId);
    if (row === undefined) {
      throw new Error(
        'Cannot propose a resolution for a removed edge: ' + edgeId,
      );
    }
  }

  private isGeneratedEdge(edgeId: string): boolean {
    return (
      this.db
        .prepare(
          'SELECT 1 AS present FROM resolution_projection_generated_edges WHERE id = ?',
        )
        .get(edgeId) !== undefined
    );
  }

  private insertFinalEdge(edge: CodeGraphEdgeRecord): void {
    const result = this.db
      .prepare(
        [
          'INSERT INTO edges',
          '(id, repository_id, kind, source_symbol_id, target_symbol_id, source_file_id, target_ref, line, confidence_tier, confidence_score, resolver_id, evidence_json)',
          'SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?',
          'WHERE EXISTS (SELECT 1 FROM files WHERE id = ?)',
          '  AND (? IS NULL OR EXISTS (SELECT 1 FROM symbols WHERE id = ?))',
          '  AND (? IS NULL OR EXISTS (SELECT 1 FROM symbols WHERE id = ?))',
          '  AND NOT EXISTS (SELECT 1 FROM edges WHERE id = ?)',
        ].join('\n'),
      )
      .run(
        ...persistentRecordParameters(edge),
        edge.sourceFileId,
        edge.sourceSymbolId,
        edge.sourceSymbolId,
        edge.targetSymbolId,
        edge.targetSymbolId,
        edge.id,
      );
    if (resultChanges(result) !== 1) {
      throw new Error(
        'Could not insert projected edge after source/target guard: ' + edge.id,
      );
    }
  }

  private updateFinalEdge(edge: CodeGraphEdgeRecord): void {
    const result = this.db
      .prepare(
        [
          'UPDATE edges SET target_symbol_id = ?, confidence_tier = ?,',
          '  confidence_score = ?, resolver_id = ?, evidence_json = ?',
          'WHERE id = ?',
          '  AND (? IS NULL OR EXISTS (SELECT 1 FROM symbols WHERE id = ?))',
        ].join('\n'),
      )
      .run(
        edge.targetSymbolId,
        edge.confidenceTier,
        edge.confidenceScore,
        edge.resolverId,
        serializedJson(edge.evidence),
        edge.id,
        edge.targetSymbolId,
        edge.targetSymbolId,
      );
    if (resultChanges(result) !== 1) {
      throw new Error(
        'Could not update projected edge after source/target guard: ' + edge.id,
      );
    }
  }

  private deleteOldTestLink(edgeId: string): void {
    const result = this.db
      .prepare("DELETE FROM edges WHERE id = ? AND resolver_id = 'test-linker'")
      .run(edgeId);
    if (resultChanges(result) !== 1) {
      throw new Error('Could not delete removed inferred test link: ' + edgeId);
    }
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error('Resolution projection is closed');
    }
  }

  private ensureCanPropose(): void {
    this.ensureOpen();
    if (this.applied) {
      throw new Error('Resolution projection cannot be changed after apply');
    }
    if (this.failed) {
      throw new Error('A failed resolution projection cannot be reused');
    }
  }
}
