import { SqliteResolutionDependencyWriter } from '../resolve/resolution-dependency-store';
import type {
  CodeGraphCommunityMembershipRecord,
  CodeGraphCommunityRecord,
  CodeGraphConfidenceTier,
  CodeGraphEdgeKind,
  CodeGraphEdgeRecord,
  CodeGraphFileFacts,
  CodeGraphFileRecord,
  CodeGraphFlowMembershipRecord,
  CodeGraphFlowRecord,
  CodeGraphSymbolKind,
  CodeGraphSymbolRecord,
} from '../../../types/code-graph';
import {
  CODE_GRAPH_CONFIDENCE_TIERS,
  CODE_GRAPH_EDGE_KINDS,
  CODE_GRAPH_PARSE_STATUSES,
  CODE_GRAPH_SYMBOL_KINDS,
} from '../../../types/code-graph';
import { repositoryRowId } from '../ids';
import {
  deleteSymbolFtsForFiles,
  deleteSymbolFtsForRepository,
  replaceSymbolFtsForFiles,
} from './fts';
import {
  getMetadataValue,
  isRecord,
  optionalNumber,
  optionalString,
  requireNumber,
  requireRow,
  requireString,
  withImmediateTransaction,
  type CodeGraphDatabase,
  type CodeGraphStatement,
} from './database';

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
  throw new Error(`Unexpected ${label}: ${value}`);
}

export function symbolFromRow(value: unknown): CodeGraphSymbolRecord {
  const row = requireRow(value);
  return {
    id: requireString(row, 'id'),
    repositoryId: requireString(row, 'repository_id'),
    fileId: requireString(row, 'file_id'),
    kind: narrowEnum(
      requireString(row, 'kind'),
      CODE_GRAPH_SYMBOL_KINDS,
      'symbol kind',
    ),
    name: requireString(row, 'name'),
    qualifiedName: requireString(row, 'qualified_name'),
    parentSymbolId: optionalString(row, 'parent_symbol_id'),
    lineStart: requireNumber(row, 'line_start'),
    lineEnd: requireNumber(row, 'line_end'),
    byteStart: requireNumber(row, 'byte_start'),
    byteEnd: requireNumber(row, 'byte_end'),
    signature: optionalString(row, 'signature'),
    exported: requireNumber(row, 'exported') === 1,
    isTest: requireNumber(row, 'is_test') === 1,
    extra: parseJsonObject(requireString(row, 'extra_json')),
  };
}

export function edgeFromRow(value: unknown): CodeGraphEdgeRecord {
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

export function fileFromRow(value: unknown): CodeGraphFileRecord {
  const row = requireRow(value);
  return {
    id: requireString(row, 'id'),
    repositoryId: requireString(row, 'repository_id'),
    relativePath: requireString(row, 'relative_path'),
    absolutePath: requireString(row, 'absolute_path'),
    language: optionalString(row, 'language'),
    contentHash: optionalString(row, 'content_hash'),
    sizeBytes: requireNumber(row, 'size_bytes'),
    mtimeNs: requireString(row, 'mtime_ns'),
    lineCount: optionalNumber(row, 'line_count'),
    grammarId: optionalString(row, 'grammar_id'),
    grammarAbi: optionalNumber(row, 'grammar_abi'),
    parseStatus: narrowEnum(
      requireString(row, 'parse_status'),
      CODE_GRAPH_PARSE_STATUSES,
      'parse status',
    ),
    hasErrors: requireNumber(row, 'has_errors') === 1,
    updatedAt: requireNumber(row, 'updated_at'),
  };
}

// Write-side column lists: `repository_id` here is the hashed repository row id
// (`repositoryRowId(repoId)`), which is what the tables physically store.
const SYMBOL_COLUMNS =
  'id, repository_id, file_id, kind, name, qualified_name, parent_symbol_id, line_start, line_end, byte_start, byte_end, signature, exported, is_test, extra_json';
const EDGE_COLUMNS =
  'id, repository_id, kind, source_symbol_id, target_symbol_id, source_file_id, target_ref, line, confidence_tier, confidence_score, resolver_id, evidence_json';

// Read-side selects join through `repositories` so the mapped record's
// `repositoryId` carries the RAW repo id (`repositories.repo_id`), not the
// hashed row id. This lets a read record round-trip back into `insertEdges`
// (which re-hashes `edge.repositoryId`) without double-hashing into a phantom
// repository row.
const SYMBOL_SELECT = `SELECT s.id, r.repo_id AS repository_id, s.file_id, s.kind, s.name, s.qualified_name, s.parent_symbol_id, s.line_start, s.line_end, s.byte_start, s.byte_end, s.signature, s.exported, s.is_test, s.extra_json
   FROM symbols s JOIN repositories r ON r.id = s.repository_id`;
const EDGE_SELECT = `SELECT e.id, r.repo_id AS repository_id, e.kind, e.source_symbol_id, e.target_symbol_id, e.source_file_id, e.target_ref, e.line, e.confidence_tier, e.confidence_score, e.resolver_id, e.evidence_json
   FROM edges e JOIN repositories r ON r.id = e.repository_id`;
const FILE_SELECT = `SELECT f.id, r.repo_id AS repository_id, f.relative_path, f.absolute_path, f.language, f.content_hash, f.size_bytes, f.mtime_ns, f.line_count, f.grammar_id, f.grammar_abi, f.parse_status, f.has_errors, f.updated_at
   FROM files f JOIN repositories r ON r.id = f.repository_id`;

// Row shape returned by `CodeGraphStore.listSymbols` — see that method's
// comment for why this is a narrower projection than `CodeGraphSymbolRecord`.
export interface CodeGraphSymbolSummary {
  qualifiedName: string;
  kind: CodeGraphSymbolKind;
  signature: string | null;
  filePath: string;
}

// --- Derived analyses (Phase 6): communities + flows ------------------------
// Write-side column lists mirror SYMBOL_COLUMNS/EDGE_COLUMNS above:
// `repository_id` is the hashed row id, physically stored.
const COMMUNITY_COLUMNS =
  'id, repository_id, label, cohesion, size, fingerprint, extra_json';
const FLOW_COLUMNS =
  'id, repository_id, entry_symbol_id, name, criticality, symbol_count, file_spread, max_depth, extra_json';

// Read-side selects join through `repositories`, same as SYMBOL_SELECT/
// EDGE_SELECT/FILE_SELECT above, so the mapped record's `repositoryId`
// carries the RAW repo id.
const COMMUNITY_SELECT = `SELECT c.id, r.repo_id AS repository_id, c.label, c.cohesion, c.size, c.fingerprint, c.extra_json
   FROM communities c JOIN repositories r ON r.id = c.repository_id`;
const FLOW_SELECT = `SELECT f.id, r.repo_id AS repository_id, f.entry_symbol_id, f.name, f.criticality, f.symbol_count, f.file_spread, f.max_depth, f.extra_json
   FROM flows f JOIN repositories r ON r.id = f.repository_id`;

function communityFromRow(value: unknown): CodeGraphCommunityRecord {
  const row = requireRow(value);
  return {
    id: requireString(row, 'id'),
    repositoryId: requireString(row, 'repository_id'),
    label: requireString(row, 'label'),
    cohesion: requireNumber(row, 'cohesion'),
    size: requireNumber(row, 'size'),
    fingerprint: requireString(row, 'fingerprint'),
    extra: parseJsonObject(requireString(row, 'extra_json')),
  };
}

function flowFromRow(value: unknown): CodeGraphFlowRecord {
  const row = requireRow(value);
  return {
    id: requireString(row, 'id'),
    repositoryId: requireString(row, 'repository_id'),
    entrySymbolId: requireString(row, 'entry_symbol_id'),
    name: requireString(row, 'name'),
    criticality: requireNumber(row, 'criticality'),
    symbolCount: requireNumber(row, 'symbol_count'),
    fileSpread: requireNumber(row, 'file_spread'),
    maxDepth: requireNumber(row, 'max_depth'),
    extra: parseJsonObject(requireString(row, 'extra_json')),
  };
}

// Clamps a caller-supplied list limit into a sane, always-positive, bounded
// range -- mirrors getImpactRadius's own `Math.max(1, Math.min(...))` clamp
// so a careless 0/negative/huge value from a caller can't produce an
// unbounded or nonsensical query.
function boundedListLimit(limit: number): number {
  return Math.max(1, Math.min(limit, 1000));
}

// Read shape for `CodeGraphStore.listTopDegreeSymbols` — total in+out edge
// degree computed directly from the `edges` table (no dedicated "degree"
// column/table — see that method's own comment). Narrower than a full
// symbol record for the same reason `CodeGraphSymbolSummary` is: callers
// only need enough to identify and display the hub, not its full row.
export interface CodeGraphSymbolDegreeSummary {
  qualifiedName: string;
  kind: CodeGraphSymbolKind;
  filePath: string;
  degree: number;
}

// Read shape for `CodeGraphStore.getDerivedStats` — status-surface-facing
// counts only. These tables carry no computed-at column, so `derivedAt`
// lives one level up as a `graph_metadata` value the derived-analysis
// orchestrator writes (Phase 6 Task 6; see `engine.ts`'s `getStatus()`),
// mirroring how `last_build_at` is already stored -- it is intentionally not
// part of this per-table-count shape.
export interface CodeGraphDerivedStats {
  communityCount: number;
  flowCount: number;
  /**
   * Set only by `CodeGraphQueryService.getDerivedStats`, and only when these
   * rows were computed for an earlier build than the latest published one
   * (see `codeGraphDerivedState`).
   */
  stale?: true;
}

// Only this finite set of parameterized hot-path statements is retained. No
// query results or caller-supplied SQL are cached; statements share the store's
// database lifetime and always see current transaction state.
const HOT_STATEMENTS = {
  fileById: `${FILE_SELECT} WHERE f.id = ?`,
  symbolById: `${SYMBOL_SELECT} WHERE s.id = ?`,
  symbolByQualifiedName: `${SYMBOL_SELECT} WHERE s.qualified_name = ? AND s.repository_id = ?`,
  symbolsForFile: `${SYMBOL_SELECT} WHERE s.file_id = ? ORDER BY s.byte_start`,
  updateResolution:
    'UPDATE edges SET target_symbol_id = ?, confidence_tier = ?, confidence_score = ?, resolver_id = ?, evidence_json = ? WHERE id = ?',
  updateEvidence: 'UPDATE edges SET evidence_json = ? WHERE id = ?',
  touchFileStat:
    'UPDATE files SET absolute_path = ?, size_bytes = ?, mtime_ns = ?, updated_at = ? WHERE id = ?',
};

export class CodeGraphStore {
  private readonly hotStatements = new Map<
    keyof typeof HOT_STATEMENTS,
    CodeGraphStatement
  >();

  private prepareHot(key: keyof typeof HOT_STATEMENTS): CodeGraphStatement {
    const existing = this.hotStatements.get(key);
    if (existing !== undefined) return existing;
    const statement = this.db.prepare(HOT_STATEMENTS[key]);
    this.hotStatements.set(key, statement);
    return statement;
  }

  public constructor(
    private readonly db: CodeGraphDatabase,
    // The engine measures only index work, within the existing fact transaction.
    // Standalone writers execute the same operations without timing instrumentation.
    private readonly measureSymbolFts: (work: () => void) => void = (work) =>
      work(),
  ) {}

  public upsertRepository(input: {
    repoId: string;
    rootPath: string;
    gitHead: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO repositories (id, repo_id, root_path, git_head, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET root_path = excluded.root_path, git_head = excluded.git_head, updated_at = excluded.updated_at`,
      )
      .run(
        repositoryRowId(input.repoId),
        input.repoId,
        input.rootPath,
        input.gitHead,
        Date.now(),
      );
  }

  /**
   * Reconciles the database's repository membership and metadata atomically.
   * Removing a repository also removes every core, FTS, and derived row that
   * belongs to it, so a descriptor removal or re-id cannot leave stale facts.
   */
  public reconcileRepositories(
    repositories: readonly {
      repoId: string;
      rootPath: string;
      gitHead: string | null;
    }[],
  ): boolean {
    const existingIds = new Set(
      this.listRepositories().map((repository) => repository.repoId),
    );
    const desiredIds = new Set(
      repositories.map((repository) => repository.repoId),
    );
    const membershipChanged =
      existingIds.size !== desiredIds.size ||
      Array.from(existingIds).some((repoId) => !desiredIds.has(repoId));

    withImmediateTransaction(this.db, () => {
      for (const repoId of Array.from(existingIds)) {
        if (desiredIds.has(repoId)) {
          continue;
        }
        new SqliteResolutionDependencyWriter(this.db).clearRepository(repoId);
        const repositoryRow = repositoryRowId(repoId);
        this.measureSymbolFts(() =>
          deleteSymbolFtsForRepository(this.db, repositoryRow),
        );
        this.db
          .prepare(
            'DELETE FROM community_memberships WHERE community_id IN (SELECT id FROM communities WHERE repository_id = ?)',
          )
          .run(repositoryRow);
        this.db
          .prepare(
            'DELETE FROM flow_memberships WHERE flow_id IN (SELECT id FROM flows WHERE repository_id = ?)',
          )
          .run(repositoryRow);
        this.db
          .prepare('DELETE FROM communities WHERE repository_id = ?')
          .run(repositoryRow);
        this.db
          .prepare('DELETE FROM flows WHERE repository_id = ?')
          .run(repositoryRow);
        this.db
          .prepare('DELETE FROM edges WHERE repository_id = ?')
          .run(repositoryRow);
        this.db
          .prepare('DELETE FROM symbols WHERE repository_id = ?')
          .run(repositoryRow);
        this.db
          .prepare('DELETE FROM files WHERE repository_id = ?')
          .run(repositoryRow);
        this.db
          .prepare('DELETE FROM repositories WHERE id = ?')
          .run(repositoryRow);
      }

      const upsert = this.db.prepare(
        `INSERT INTO repositories (id, repo_id, root_path, git_head, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET repo_id = excluded.repo_id, root_path = excluded.root_path, git_head = excluded.git_head, updated_at = excluded.updated_at`,
      );
      for (const repository of repositories) {
        upsert.run(
          repositoryRowId(repository.repoId),
          repository.repoId,
          repository.rootPath,
          repository.gitHead,
          Date.now(),
        );
      }
    });
    return membershipChanged;
  }

  public repositoryMembershipDiffers(
    repositories: readonly { repoId: string }[],
  ): boolean {
    const existingIds = new Set(
      this.listRepositories().map((repository) => repository.repoId),
    );
    const desiredIds = new Set(
      repositories.map((repository) => repository.repoId),
    );
    return (
      existingIds.size !== desiredIds.size ||
      Array.from(existingIds).some((repoId) => !desiredIds.has(repoId))
    );
  }

  public listRepositories(): Array<{
    repoId: string;
    rootPath: string;
    gitHead: string | null;
  }> {
    return this.db
      .prepare(
        'SELECT repo_id, root_path, git_head FROM repositories ORDER BY repo_id',
      )
      .all()
      .map((value) => {
        const row = requireRow(value);
        return {
          repoId: requireString(row, 'repo_id'),
          rootPath: requireString(row, 'root_path'),
          gitHead: optionalString(row, 'git_head'),
        };
      });
  }

  // Full per-file rows for a repository, ordered by relative_path — unlike
  // `listFileIndex` (a stat-fastpath-only projection) this returns every
  // column `CodeGraphFileRecord` carries. Added for snapshot export
  // (`node/code-graph/snapshot/export.ts`), which needs `language`/`grammarId`/
  // `grammarAbi`/`parseStatus`/`hasErrors`/`lineCount` alongside the stat
  // fields `listFileIndex` already exposes. This method still returns `id`
  // and `absolutePath` like every other full-record read below — it is the
  // EXPORT module's job to drop `absolutePath` (never portable) before
  // writing a snapshot, not this store method's.
  public listFiles(repoId: string): CodeGraphFileRecord[] {
    return this.db
      .prepare(
        `${FILE_SELECT} WHERE f.repository_id = ? ORDER BY f.relative_path`,
      )
      .all(repositoryRowId(repoId))
      .map(fileFromRow);
  }

  public listFileIndex(repoId: string): Array<{
    relativePath: string;
    sizeBytes: number;
    mtimeNs: string;
    contentHash: string | null;
    parseStatus: CodeGraphFileRecord['parseStatus'];
  }> {
    return this.db
      .prepare(
        `SELECT f.relative_path, f.size_bytes, f.mtime_ns, f.content_hash, f.parse_status FROM files f
         JOIN repositories r ON r.id = f.repository_id WHERE r.repo_id = ? ORDER BY f.relative_path`,
      )
      .all(repoId)
      .map((value) => {
        const row = requireRow(value);
        return {
          relativePath: requireString(row, 'relative_path'),
          sizeBytes: requireNumber(row, 'size_bytes'),
          mtimeNs: requireString(row, 'mtime_ns'),
          contentHash: optionalString(row, 'content_hash'),
          parseStatus: narrowEnum(
            requireString(row, 'parse_status'),
            CODE_GRAPH_PARSE_STATUSES,
            'parse status',
          ),
        };
      });
  }

  public replaceFileFacts(facts: CodeGraphFileFacts): void {
    withImmediateTransaction(this.db, () => {
      new SqliteResolutionDependencyWriter(this.db).invalidateMetadata(
        facts.file.repositoryId,
      );
      // Capture and remove mapped old rowids before replacing file/symbol facts.
      this.measureSymbolFts(() =>
        deleteSymbolFtsForFiles(this.db, [facts.file.id]),
      );
      const repositoryRow = repositoryRowId(facts.file.repositoryId);
      this.db
        .prepare(
          `INSERT OR REPLACE INTO files (id, repository_id, relative_path, absolute_path, language, content_hash, size_bytes, mtime_ns, line_count, grammar_id, grammar_abi, parse_status, has_errors, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          facts.file.id,
          repositoryRow,
          facts.file.relativePath,
          facts.file.absolutePath,
          facts.file.language,
          facts.file.contentHash,
          facts.file.sizeBytes,
          facts.file.mtimeNs,
          facts.file.lineCount,
          facts.file.grammarId,
          facts.file.grammarAbi,
          facts.file.parseStatus,
          facts.file.hasErrors ? 1 : 0,
          facts.file.updatedAt,
        );
      this.db
        .prepare('DELETE FROM symbols WHERE file_id = ?')
        .run(facts.file.id);
      this.db
        .prepare('DELETE FROM edges WHERE source_file_id = ?')
        .run(facts.file.id);
      const insertSymbol = this.db.prepare(
        `INSERT OR REPLACE INTO symbols (${SYMBOL_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const symbol of facts.symbols) {
        insertSymbol.run(
          symbol.id,
          repositoryRow,
          symbol.fileId,
          symbol.kind,
          symbol.name,
          symbol.qualifiedName,
          symbol.parentSymbolId,
          symbol.lineStart,
          symbol.lineEnd,
          symbol.byteStart,
          symbol.byteEnd,
          symbol.signature,
          symbol.exported ? 1 : 0,
          symbol.isTest ? 1 : 0,
          JSON.stringify(symbol.extra),
        );
      }
      this.insertEdgeRows(facts.edges, repositoryRow);
      this.measureSymbolFts(() =>
        replaceSymbolFtsForFiles(this.db, [facts.file.id]),
      );
    });
  }

  public listConfigExtendsEdges(repoId: string): CodeGraphEdgeRecord[] {
    return this.db
      .prepare(
        `${EDGE_SELECT}
      JOIN files f ON f.id = e.source_file_id
      WHERE r.repo_id = ? AND f.language = 'tsconfig' AND e.kind = 'REFERENCES'
        AND e.target_symbol_id IS NULL AND json_extract(e.evidence_json, '$.configExtends') = 1`,
      )
      .all(repoId)
      .map(edgeFromRow);
  }

  public insertEdges(edges: readonly CodeGraphEdgeRecord[]): void {
    withImmediateTransaction(this.db, () => {
      for (const edge of edges) {
        this.insertEdgeRows([edge], repositoryRowId(edge.repositoryId));
      }
    });
  }

  private insertEdgeRows(
    edges: readonly CodeGraphEdgeRecord[],
    repositoryRow: string,
  ): void {
    const insertEdge = this.db.prepare(
      `INSERT OR REPLACE INTO edges (${EDGE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const edge of edges) {
      insertEdge.run(
        edge.id,
        repositoryRow,
        edge.kind,
        edge.sourceSymbolId,
        edge.targetSymbolId,
        edge.sourceFileId,
        edge.targetRef,
        edge.line,
        edge.confidenceTier,
        edge.confidenceScore,
        edge.resolverId,
        JSON.stringify(edge.evidence),
      );
    }
  }

  public touchFileStat(
    fileId: string,
    absolutePath: string,
    sizeBytes: number,
    mtimeNs: string,
  ): void {
    this.prepareHot('touchFileStat').run(
      absolutePath,
      sizeBytes,
      mtimeNs,
      Date.now(),
      fileId,
    );
  }

  public removeFiles(repoId: string, relativePaths: readonly string[]): void {
    if (relativePaths.length === 0) {
      return;
    }
    withImmediateTransaction(this.db, () => {
      new SqliteResolutionDependencyWriter(this.db).invalidateMetadata(repoId);
      const repositoryRow = repositoryRowId(repoId);
      const selectFile = this.db.prepare(
        'SELECT id FROM files WHERE repository_id = ? AND relative_path = ?',
      );
      for (const relativePath of relativePaths) {
        const found = selectFile.get(repositoryRow, relativePath);
        if (found === undefined) {
          continue;
        }
        const fileId = requireString(requireRow(found), 'id');
        // Mapping rows retain old ids while the facts are removed below.
        this.measureSymbolFts(() => deleteSymbolFtsForFiles(this.db, [fileId]));
        this.db.prepare('DELETE FROM symbols WHERE file_id = ?').run(fileId);
        this.db
          .prepare('DELETE FROM edges WHERE source_file_id = ?')
          .run(fileId);
        this.db.prepare('DELETE FROM files WHERE id = ?').run(fileId);
      }
    });
  }

  /** Discard derived bindings before resolving changed repository facts again.
   * Raw refs and extraction evidence survive; existing targets can be stale too.
   */
  public resetResolutions(): void {
    this.db.exec(`DELETE FROM edges WHERE resolver_id = 'test-linker';
      UPDATE edges SET target_symbol_id = NULL, confidence_tier = 'EXTRACTED',
        confidence_score = 1.0, resolver_id = NULL,
        evidence_json = json_remove(evidence_json, '$.resolvedPath', '$.via', '$.candidates')
      WHERE resolver_id IS NOT NULL OR json_type(evidence_json, '$.candidates') IS NOT NULL`);
  }

  public nullDanglingEdgeTargets(): number {
    const result = this.db
      .prepare(
        `UPDATE edges SET target_symbol_id = NULL, confidence_tier = 'EXTRACTED', confidence_score = 1.0, resolver_id = NULL
         WHERE target_symbol_id IS NOT NULL AND target_symbol_id NOT IN (SELECT id FROM symbols)`,
      )
      .run();
    return Number(result.changes);
  }

  public countSymbols(): number {
    return this.countQuery('SELECT COUNT(*) AS n FROM symbols');
  }

  public countEdges(): number {
    return this.countQuery('SELECT COUNT(*) AS n FROM edges');
  }

  // Kinds counted here are exactly the "resolvable fact" edge kinds — see
  // each phase's kind-exhaustive sweep (structural kinds like
  // DECLARES_MCP_TOOL/CONFIGURES/RATIONALE_FOR are always bound at
  // extraction time and are deliberately excluded).
  // USES_PIPELINE_ACTION deserves a specific note as of Phase 6:
  // resolve/workflow-action-resolver.ts now binds LOCAL `uses: ./path` refs
  // to a real action.yml/action.yaml file symbol, so those no longer count
  // here once resolved — but EXTERNAL refs (`owner/repo@ref`,
  // `docker://...`) never bind (there is no local symbol they could ever
  // resolve to), so a repo with GitHub Actions workflows keeps a PERMANENT
  // FLOOR on this count contributed by external refs alone, even once every
  // local ref resolves. See docs/code-graph.md's "Unresolved edges are kept,
  // never dropped" for the full write-up.
  public countUnresolvedEdges(): number {
    return this.countQuery(
      `SELECT COUNT(*) AS n FROM edges WHERE target_symbol_id IS NULL AND kind IN ('CALLS','IMPORTS_FROM','REFERENCES','DOCUMENTS','IPC_HANDLES','IPC_INVOKES','USES_PIPELINE_ACTION')`,
    );
  }

  public countFilesWithErrors(): number {
    return this.countQuery(
      'SELECT COUNT(*) AS n FROM files WHERE has_errors = 1',
    );
  }

  public countFiles(repoId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM files WHERE repository_id = ?')
      .get(repositoryRowId(repoId));
    return requireNumber(requireRow(row), 'n');
  }

  private countQuery(sql: string): number {
    return requireNumber(requireRow(this.db.prepare(sql).get()), 'n');
  }

  public getSymbolByQualifiedName(
    qualifiedName: string,
    repoId: string,
  ): CodeGraphSymbolRecord | null {
    const row = this.prepareHot('symbolByQualifiedName').get(
      qualifiedName,
      repositoryRowId(repoId),
    );
    return row === undefined ? null : symbolFromRow(row);
  }

  // Every symbol matching an exact (kind, name) pair within one repository.
  // Added for resolve/ipc-resolver.ts: an `ipc_channel` symbol's `name` is
  // always the bare channel key and its `kind` is always `ipc_channel` (see
  // extract/canopy-patterns.ts's `extractChannelDeclarations`), so binding an
  // `ipc:<key>` edge target means finding every `ipc_channel` symbol named
  // `<key>` in the same repo -- zero, one, or (ambiguously) more than one.
  // Unlike `getSymbolByQualifiedName` (assumes at most one match, since
  // qualified names are unique per repo), this returns every match so the
  // caller can decide what "more than one" means.
  public listSymbolsByKindAndName(
    kind: CodeGraphSymbolKind,
    name: string,
    repoId: string,
  ): CodeGraphSymbolRecord[] {
    return this.db
      .prepare(
        `${SYMBOL_SELECT} WHERE s.kind = ? AND s.name = ? AND s.repository_id = ? ORDER BY s.id`,
      )
      .all(kind, name, repositoryRowId(repoId))
      .map(symbolFromRow);
  }

  public getSymbolById(symbolId: string): CodeGraphSymbolRecord | null {
    const row = this.prepareHot('symbolById').get(symbolId);
    return row === undefined ? null : symbolFromRow(row);
  }

  // Full symbol records for a repo's ENTIRE built graph -- unlike
  // `listSymbols` (a narrow qualifiedName/kind/signature/filePath projection
  // built for the before-graph diff), this returns every column
  // `CodeGraphSymbolRecord` carries. Added for the derived-analysis
  // orchestrator (`analysis/derived.ts`), which feeds `detectCommunities`/
  // `traceFlows` -- both pure modules that need `.id`/`.fileId`/`.kind`/
  // `.qualifiedName`, not just the display-oriented summary shape.
  public listSymbolsForRepo(repoId: string): CodeGraphSymbolRecord[] {
    return this.db
      .prepare(`${SYMBOL_SELECT} WHERE s.repository_id = ? ORDER BY s.id`)
      .all(repositoryRowId(repoId))
      .map(symbolFromRow);
  }

  public listSymbolsForFile(fileId: string): CodeGraphSymbolRecord[] {
    return this.prepareHot('symbolsForFile').all(fileId).map(symbolFromRow);
  }

  // Minimal cross-file projection: every symbol in a repo's ENTIRE built
  // graph, joined through `files` for `filePath`. Unlike `listSymbolsForFile`
  // (one file, full CodeGraphSymbolRecord) this is scoped to a whole repo and
  // only carries the fields a caller needs to diff two graphs' symbol sets
  // against each other by qualifiedName — today's only consumer is the
  // before-graph builder (`impact/before-graph.ts`), which snapshots an
  // entire ephemeral base-ref graph this way.
  public listSymbols(repoId: string): CodeGraphSymbolSummary[] {
    return this.db
      .prepare(
        `SELECT s.qualified_name, s.kind, s.signature, f.relative_path
         FROM symbols s
         JOIN repositories r ON r.id = s.repository_id
         JOIN files f ON f.id = s.file_id
         WHERE r.repo_id = ?
         ORDER BY s.qualified_name`,
      )
      .all(repoId)
      .map((value) => {
        const row = requireRow(value);
        return {
          qualifiedName: requireString(row, 'qualified_name'),
          kind: narrowEnum(
            requireString(row, 'kind'),
            CODE_GRAPH_SYMBOL_KINDS,
            'symbol kind',
          ),
          signature: optionalString(row, 'signature'),
          filePath: requireString(row, 'relative_path'),
        };
      });
  }

  public listEdges(filter: {
    kind?: CodeGraphEdgeKind;
    unresolvedOnly?: boolean;
    sourceFileId?: string;
    repoId?: string;
  }): CodeGraphEdgeRecord[] {
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
      params.push(repositoryRowId(filter.repoId));
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .prepare(`${EDGE_SELECT} ${where} ORDER BY e.id`)
      .all(...params)
      .map(edgeFromRow);
  }

  /** Minimal test-call projection: reject production/self-test calls in SQLite
   * before hydrating facts in JavaScript. Keep one row per CALLS edge, matching
   * the linker's historical count and deterministic insert IDs.
   */
  public listTestCallTargets(repoId: string): Array<{
    sourceFileId: string;
    targetSymbolId: string;
    testFileSymbolId: string;
  }> {
    return this.db
      .prepare(
        `
      SELECT e.source_file_id, e.target_symbol_id,
        (SELECT file_symbol.id FROM symbols file_symbol
         WHERE file_symbol.file_id = e.source_file_id AND file_symbol.kind = 'file'
         ORDER BY file_symbol.byte_start LIMIT 1) AS test_file_symbol_id
      FROM edges e
      JOIN symbols source ON source.id = e.source_symbol_id
        AND source.file_id = e.source_file_id AND source.is_test = 1
      JOIN symbols target ON target.id = e.target_symbol_id AND target.is_test = 0
      JOIN files f ON f.id = e.source_file_id
      WHERE e.repository_id = ? AND e.kind = 'CALLS'
      ORDER BY e.id
    `,
      )
      .all(repositoryRowId(repoId))
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
    this.prepareHot('updateResolution').run(
      update.targetSymbolId,
      update.confidenceTier,
      update.confidenceScore,
      update.resolverId,
      JSON.stringify(update.evidence),
      edgeId,
    );
  }

  // Narrower than `updateEdgeResolution`: writes ONLY the evidence blob,
  // leaving target_symbol_id / confidence_tier / confidence_score /
  // resolver_id untouched. Used by resolvers that need to record ambiguity
  // (e.g. "N candidates matched, none chosen") on an edge that is
  // intentionally staying unresolved -- `updateEdgeResolution` always writes
  // a resolution, which would be dishonest here (see
  // resolve/ipc-resolver.ts's ambiguous-match branch).
  public updateEdgeEvidence(
    edgeId: string,
    evidence: Record<string, unknown>,
  ): void {
    this.prepareHot('updateEvidence').run(JSON.stringify(evidence), edgeId);
  }

  public getFileByPath(
    repoId: string,
    relativePath: string,
  ): CodeGraphFileRecord | null {
    const row = this.db
      .prepare(
        `${FILE_SELECT} WHERE f.repository_id = ? AND f.relative_path = ?`,
      )
      .get(repositoryRowId(repoId), relativePath);
    return row === undefined ? null : fileFromRow(row);
  }

  public getFileById(fileId: string): CodeGraphFileRecord | null {
    const row = this.prepareHot('fileById').get(fileId);
    return row === undefined ? null : fileFromRow(row);
  }

  // --- Derived analyses (communities + flows) -------------------------------
  //
  // This class only owns storage + CRUD for these tables. The pure
  // computation modules (analysis/communities.ts, analysis/flows.ts) and the
  // orchestrator that calls `replaceDerivedForRepo` during a build
  // (analysis/derived.ts, invoked from `engine.ts`'s `buildOrUpdate`) live
  // elsewhere. These four tables are intentionally excluded from the
  // snapshot export/import contract -- see snapshot/export.ts's comment on
  // `buildCodeGraphSnapshot`.

  // Single-transaction delete-then-insert scoped to ONE repository per call
  // (like `removeFiles`). The OUTER `repoId` argument is the sole source of
  // truth for both the delete scope and every inserted row's
  // `repository_id`; each record's own `repositoryId` field (present for
  // read-side symmetry with every other *Record type) is intentionally NOT
  // consulted here, the same way `replaceFileFacts` hashes
  // `facts.file.repositoryId` once and applies it to every symbol row
  // rather than trusting each symbol's own field. Deletes walk children
  // (memberships, via a subquery over their owning community/flow ids)
  // before parents (communities/flows themselves) -- reversing that order
  // would leave the membership subquery with nothing left to match, since
  // the parent rows would already be gone.
  public replaceDerivedForRepo(
    repoId: string,
    communities: readonly CodeGraphCommunityRecord[],
    communityMemberships: readonly CodeGraphCommunityMembershipRecord[],
    flows: readonly CodeGraphFlowRecord[],
    flowMemberships: readonly CodeGraphFlowMembershipRecord[],
  ): void {
    withImmediateTransaction(this.db, () => {
      const repositoryRow = repositoryRowId(repoId);

      this.db
        .prepare(
          'DELETE FROM community_memberships WHERE community_id IN (SELECT id FROM communities WHERE repository_id = ?)',
        )
        .run(repositoryRow);
      this.db
        .prepare('DELETE FROM communities WHERE repository_id = ?')
        .run(repositoryRow);
      this.db
        .prepare(
          'DELETE FROM flow_memberships WHERE flow_id IN (SELECT id FROM flows WHERE repository_id = ?)',
        )
        .run(repositoryRow);
      this.db
        .prepare('DELETE FROM flows WHERE repository_id = ?')
        .run(repositoryRow);

      const insertCommunity = this.db.prepare(
        `INSERT OR REPLACE INTO communities (${COMMUNITY_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const community of communities) {
        insertCommunity.run(
          community.id,
          repositoryRow,
          community.label,
          community.cohesion,
          community.size,
          community.fingerprint,
          JSON.stringify(community.extra),
        );
      }

      const insertCommunityMembership = this.db.prepare(
        'INSERT OR REPLACE INTO community_memberships (community_id, symbol_id) VALUES (?, ?)',
      );
      for (const membership of communityMemberships) {
        insertCommunityMembership.run(
          membership.communityId,
          membership.symbolId,
        );
      }

      const insertFlow = this.db.prepare(
        `INSERT OR REPLACE INTO flows (${FLOW_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const flow of flows) {
        insertFlow.run(
          flow.id,
          repositoryRow,
          flow.entrySymbolId,
          flow.name,
          flow.criticality,
          flow.symbolCount,
          flow.fileSpread,
          flow.maxDepth,
          JSON.stringify(flow.extra),
        );
      }

      const insertFlowMembership = this.db.prepare(
        'INSERT OR REPLACE INTO flow_memberships (flow_id, symbol_id, depth) VALUES (?, ?, ?)',
      );
      for (const membership of flowMemberships) {
        insertFlowMembership.run(
          membership.flowId,
          membership.symbolId,
          membership.depth,
        );
      }
    });
  }

  // Repo-scoped list of communities, largest first (ties broken by id for
  // determinism) -- mirrors `listFiles`'s repositories join so the returned
  // `repositoryId` is the RAW repo id, not the hashed row id. `repoId`
  // omitted lists across every repository this graph has built (community
  // ids never collide cross-repo in practice -- see `getCommunityForSymbol`).
  public listCommunities(
    repoId?: string,
    limit = 100,
  ): CodeGraphCommunityRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (repoId !== undefined) {
      clauses.push('r.repo_id = ?');
      params.push(repoId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(boundedListLimit(limit));
    return this.db
      .prepare(
        `${COMMUNITY_SELECT} ${where} ORDER BY c.size DESC, c.id LIMIT ?`,
      )
      .all(...params)
      .map(communityFromRow);
  }

  // Every (communityId, symbolId) pair for a repo's CURRENT community
  // partition -- read by the derived-analysis orchestrator
  // (`analysis/derived.ts`) BEFORE `replaceDerivedForRepo` overwrites the
  // tables, so `detectCommunities` can consult the prior run's memberships
  // for stable-id retention (see that module's `previousMemberships` input
  // and `STABLE_ID_MIN_JACCARD`). Ordered by community id then symbol id
  // purely for determinism; the orchestrator does not depend on ordering
  // beyond that. Empty on a repo's first-ever derived computation.
  public listCommunityMemberships(
    repoId: string,
  ): CodeGraphCommunityMembershipRecord[] {
    return this.db
      .prepare(
        `SELECT m.community_id, m.symbol_id
         FROM community_memberships m
         JOIN communities c ON c.id = m.community_id
         JOIN repositories r ON r.id = c.repository_id
         WHERE r.repo_id = ?
         ORDER BY m.community_id, m.symbol_id`,
      )
      .all(repoId)
      .map((value) => {
        const row = requireRow(value);
        return {
          communityId: requireString(row, 'community_id'),
          symbolId: requireString(row, 'symbol_id'),
        };
      });
  }

  // A symbol belongs to at most one community by construction (a later
  // Phase 6 task's Louvain partition assigns each symbol exactly once), so
  // `ORDER BY c.id LIMIT 1` is a determinism safety net rather than an
  // expected-ambiguity handler -- unlike e.g. `getIpcChannel`'s genuinely
  // ambiguous bare-key lookup.
  public getCommunityForSymbol(
    symbolId: string,
  ): CodeGraphCommunityRecord | null {
    const row = this.db
      .prepare(
        `SELECT c.id, r.repo_id AS repository_id, c.label, c.cohesion, c.size, c.fingerprint, c.extra_json
         FROM community_memberships m
         JOIN communities c ON c.id = m.community_id
         JOIN repositories r ON r.id = c.repository_id
         WHERE m.symbol_id = ?
         ORDER BY c.id
         LIMIT 1`,
      )
      .get(symbolId);
    return row === undefined ? null : communityFromRow(row);
  }

  // Repo-scoped list of flows, most critical first (ties broken by id) --
  // same repositories-join/optional-repoId shape as `listCommunities`.
  public listFlows(repoId?: string, limit = 100): CodeGraphFlowRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (repoId !== undefined) {
      clauses.push('r.repo_id = ?');
      params.push(repoId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(boundedListLimit(limit));
    return this.db
      .prepare(
        `${FLOW_SELECT} ${where} ORDER BY f.criticality DESC, f.id LIMIT ?`,
      )
      .all(...params)
      .map(flowFromRow);
  }

  // Every flow a symbol participates in (any depth), most critical first --
  // a symbol CAN appear in multiple flows (unlike community membership,
  // flow membership is not a partition), so this returns a list rather than
  // `getCommunityForSymbol`'s single-or-null shape.
  public listFlowsForSymbol(
    symbolId: string,
    limit = 10,
  ): CodeGraphFlowRecord[] {
    return this.db
      .prepare(
        `SELECT f.id, r.repo_id AS repository_id, f.entry_symbol_id, f.name, f.criticality, f.symbol_count, f.file_spread, f.max_depth, f.extra_json
         FROM flow_memberships m
         JOIN flows f ON f.id = m.flow_id
         JOIN repositories r ON r.id = f.repository_id
         WHERE m.symbol_id = ?
         ORDER BY f.criticality DESC, f.id
         LIMIT ?`,
      )
      .all(symbolId, boundedListLimit(limit))
      .map(flowFromRow);
  }

  // Full symbol records for a community's members, ordered by qualified
  // name -- reuses `symbolFromRow`/`SYMBOL_SELECT` rather than inventing a
  // parallel projection, since a community member IS just a symbol.
  public listCommunityMembers(
    communityId: string,
    limit = 100,
  ): CodeGraphSymbolRecord[] {
    return this.db
      .prepare(
        `${SYMBOL_SELECT}
         JOIN community_memberships m ON m.symbol_id = s.id
         WHERE m.community_id = ?
         ORDER BY s.qualified_name
         LIMIT ?`,
      )
      .all(communityId, boundedListLimit(limit))
      .map(symbolFromRow);
  }

  // Distinct CALLER symbols of `symbolId` whose community differs from
  // `symbolId`'s own community -- the risk formula's community-spanning-call
  // signal (a later Phase 6 task wires this into
  // impact/change-impact.ts's risk formula). Both sides require a community
  // assignment via INNER JOIN: a symbol with no community (derived data
  // never computed, or an isolated symbol the partition never placed)
  // honestly reports 0 rather than guessing. `COUNT(DISTINCT ...)` counts
  // CALLER SYMBOLS, not call-edge instances -- two edges from the same
  // cross-community caller (e.g. called on two different lines) count
  // once, matching "N callers" phrasing.
  public countCrossCommunityCallers(symbolId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT e.source_symbol_id) AS n
         FROM edges e
         JOIN community_memberships target_m ON target_m.symbol_id = e.target_symbol_id
         JOIN community_memberships source_m ON source_m.symbol_id = e.source_symbol_id
         WHERE e.kind = 'CALLS' AND e.target_symbol_id = ? AND source_m.community_id != target_m.community_id`,
      )
      .get(symbolId);
    return requireNumber(requireRow(row), 'n');
  }

  // "Hubs": top symbols by total edge degree (in-degree + out-degree across
  // EVERY edge kind, not just CALLS), computed directly from `edges` -- there
  // is no dedicated degree column/table. A symbol's degree counts the edges
  // whose source is the symbol plus the edges whose target is the symbol
  // (a self-edge counts twice), both scoped to the SAME optional repository
  // filter on the edge, so degrees are comparable across the whole result
  // set; symbols with no counted edge are omitted. `repoId` omitted ranks
  // hubs across every repository this graph has built (symbol ids are
  // already repo-scoped hashes -- see ids.ts -- so they never collide across
  // repos).
  //
  // Each degree is two index counts on the endpoint indexes, so no call
  // materializes a temporary index over every edge endpoint; only the
  // bounded top-N sort remains. `LIMIT -1` keeps SQLite from flattening the
  // inner select, which would evaluate both counts once for the filter and
  // again for the sort. Ties are ordered by qualified name, then symbol id
  // (equal qualified names can only come from different repositories).
  public listTopDegreeSymbols(
    repoId?: string,
    limit = 20,
  ): CodeGraphSymbolDegreeSummary[] {
    const params: Array<string | number> = [];
    let repositoryClause = '';
    if (repoId !== undefined) {
      const repositoryRow = repositoryRowId(repoId);
      repositoryClause = ' AND e.repository_id = ?';
      params.push(repositoryRow, repositoryRow);
    }
    params.push(boundedListLimit(limit));
    return this.db
      .prepare(
        `SELECT qualified_name, kind, relative_path, degree
         FROM (
           SELECT s.id AS id, s.qualified_name AS qualified_name, s.kind AS kind,
             f.relative_path AS relative_path,
             (SELECT COUNT(*) FROM edges e INDEXED BY idx_edges_source_symbol
               WHERE e.source_symbol_id = s.id${repositoryClause})
             + (SELECT COUNT(*) FROM edges e INDEXED BY idx_edges_target_symbol
               WHERE e.target_symbol_id = s.id${repositoryClause}) AS degree
           FROM symbols s
           JOIN files f ON f.id = s.file_id
           LIMIT -1
         )
         WHERE degree > 0
         ORDER BY degree DESC, qualified_name, id
         LIMIT ?`,
      )
      .all(...params)
      .map((value) => {
        const row = requireRow(value);
        return {
          qualifiedName: requireString(row, 'qualified_name'),
          kind: narrowEnum(
            requireString(row, 'kind'),
            CODE_GRAPH_SYMBOL_KINDS,
            'symbol kind',
          ),
          filePath: requireString(row, 'relative_path'),
          degree: requireNumber(row, 'degree'),
        };
      });
  }

  // Status-surface counts only -- `derivedAt` is a DB-level `graph_metadata`
  // value the derived-analysis orchestrator writes (mirroring how
  // `last_build_at` is stored), not a per-repo column here, so it is not part
  // of this shape; see `engine.ts`'s `getStatus()`. `repoId` omitted
  // aggregates across every repository this graph has built -- same
  // optional-repoId convention as `listCommunities`/`listFlows` above, used
  // by `CodeGraphEngine.getStatus()` to report a graph-wide total the same
  // way `symbolCount`/`edgeCount` already do.
  /**
   * The graph-wide freshness markers derived-analysis staleness is read from
   * (see `codeGraphDerivedState`): the last build, and the last derived
   * analysis that still matches it.
   */
  public getDerivedFreshness(): {
    lastBuildAt: number | null;
    derivedAt: number | null;
  } {
    const read = (key: string): number | null => {
      const raw = getMetadataValue(this.db, key);
      if (raw === null) return null;
      const value = Number(raw);
      return Number.isFinite(value) ? value : null;
    };
    return {
      lastBuildAt: read('last_build_at'),
      derivedAt: read('derived_at'),
    };
  }

  public getDerivedStats(repoId?: string): CodeGraphDerivedStats {
    const where = repoId !== undefined ? 'WHERE repository_id = ?' : '';
    const params: string[] =
      repoId !== undefined ? [repositoryRowId(repoId)] : [];
    const communityCount = requireNumber(
      requireRow(
        this.db
          .prepare(`SELECT COUNT(*) AS n FROM communities ${where}`)
          .get(...params),
      ),
      'n',
    );
    const flowCount = requireNumber(
      requireRow(
        this.db
          .prepare(`SELECT COUNT(*) AS n FROM flows ${where}`)
          .get(...params),
      ),
      'n',
    );
    return { communityCount, flowCount };
  }
}
