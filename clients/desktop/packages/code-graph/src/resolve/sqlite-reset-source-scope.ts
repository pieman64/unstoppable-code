// Proposed target: packages/code-graph/src/resolve/
// sqlite-reset-source-scope.ts
//
// W2 constructor supplement. This is only the reset membership control; the
// TEMP extracted/proposal/generated-link overlay and its single transaction
// remain owned by W2 and are not duplicated here.

import type { CodeGraphDatabase } from '../store/database';
import { MAX_AFFECTED_SOURCE_FILES } from './resolution-dependency-index';
import type { SqliteResolutionProjectionOptions } from './scoped-resolution-projection';

export const RESET_SOURCE_SCOPE_INSERT_BATCH_SIZE = 1_000;
const RESET_SCOPE_TABLE = 'temp.__codegraph_resolution_reset_sources';

/** Only these audited SQL aliases may be used to form a predicate. */
export type ResolutionResetSourceAlias = 'e';

const SOURCE_FILE_COLUMN_BY_ALIAS: Readonly<
  Record<ResolutionResetSourceAlias, string>
> = {
  e: 'e.source_file_id',
};

const RESET_EVIDENCE_LOGIC =
  "(e.resolver_id IS NOT NULL OR json_type(e.evidence_json, '$.candidates') IS NOT NULL)";
const DANGLING_TARGET_LOGIC =
  '(e.target_symbol_id IS NOT NULL AND e.target_symbol_id NOT IN (SELECT id FROM symbols))';

export interface SqliteResolutionResetSqlPredicates {
  /** Applied both to resolution columns and the evidence JSON cleanup CASE. */
  resetEvidence: string;
  /** The same scoped reset plus scoped dangling-target retirement. */
  resetOrDangling: string;
  /** Keep all rows except test links owned by a selected test source file. */
  keepBaseEdge: string;
}

/**
 * Fixed SQL expressions shared by W2's reset CASE clauses, base-view test-link
 * hiding, and candidate-ID snapshot. The source scope is deliberately included
 * in both reset predicates: evidence JSON must not be stripped from unaffected
 * rows merely because they contain resolver metadata.
 */
export function sqliteResolutionResetSqlPredicates(
  scope: SqliteResetSourceScope,
): SqliteResolutionResetSqlPredicates {
  const sourceScope = scope.predicate('e');
  const resetEvidence = `(${sourceScope} AND ${RESET_EVIDENCE_LOGIC})`;
  const danglingTarget = `(${sourceScope} AND ${DANGLING_TARGET_LOGIC})`;
  return {
    resetEvidence,
    resetOrDangling: `(${resetEvidence} OR ${danglingTarget})`,
    keepBaseEdge: `(e.resolver_id IS NULL OR e.resolver_id <> 'test-linker' OR NOT (${sourceScope}))`,
  };
}

export class ResolutionResetSourceScopeOverflowError extends Error {
  public constructor(public readonly requestedDistinctSourceFiles: number) {
    super(
      `Scoped resolution reset exceeded ${MAX_AFFECTED_SOURCE_FILES} files`,
    );
    this.name = 'ResolutionResetSourceScopeOverflowError';
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function collectSortedSourceIds(
  sourceFileIds: readonly string[],
): readonly string[] {
  const selected = new Set<string>();
  for (const sourceFileId of sourceFileIds) {
    selected.add(sourceFileId);
    if (selected.size > MAX_AFFECTED_SOURCE_FILES) {
      // Throw before TEMP DDL, deletes, inserts, or any edge-view mutation.
      throw new ResolutionResetSourceScopeOverflowError(selected.size);
    }
  }
  return Array.from(selected).sort(compareText);
}

/**
 * Owns the real SQLite TEMP table that scopes W2 reset/delete/update clauses.
 * Construct it from the exact third-argument options passed to one shared W2
 * projection per engine build; do not instantiate a projection per repo.
 */
export class SqliteResetSourceScope {
  private readonly selectedSourceFileIds: readonly string[] | undefined;
  private readonly selectedSourceFileIdSet: ReadonlySet<string> | undefined;
  private installed = false;

  public constructor(
    private readonly db: CodeGraphDatabase,
    options: SqliteResolutionProjectionOptions,
  ) {
    const requested = options.resetSourceFileIds;
    if (requested === undefined) {
      this.selectedSourceFileIds = undefined;
      this.selectedSourceFileIdSet = undefined;
      return;
    }
    const selected = collectSortedSourceIds(requested);
    this.selectedSourceFileIds = selected;
    this.selectedSourceFileIdSet = new Set(selected);
  }

  public get isWholeGraph(): boolean {
    return this.selectedSourceFileIds === undefined;
  }

  public get sourceFileIds(): readonly string[] | undefined {
    return this.selectedSourceFileIds;
  }

  public get selectedCount(): number | null {
    return this.selectedSourceFileIds?.length ?? null;
  }

  /**
   * Materialize only validated/sorted IDs, in <=1000 stable-ID slices. The
   * fixed SQL statement inserts one row at a time (never constructs a variable
   * IN list), and every diff/reset query joins this table through a fixed alias.
   */
  public install(): void {
    if (this.isWholeGraph) return;
    try {
      this.db.exec(`
        CREATE TEMP TABLE IF NOT EXISTS __codegraph_resolution_reset_sources (
          source_file_id TEXT PRIMARY KEY
        ) WITHOUT ROWID;
      `);
      this.db.exec('DELETE FROM temp.__codegraph_resolution_reset_sources');
      const insertSource = this.db.prepare(`
        INSERT INTO ${RESET_SCOPE_TABLE} (source_file_id)
        VALUES (?)
        ON CONFLICT(source_file_id) DO NOTHING
      `);
      const sourceFileIds = this.selectedSourceFileIds ?? [];
      for (
        let offset = 0;
        offset < sourceFileIds.length;
        offset += RESET_SOURCE_SCOPE_INSERT_BATCH_SIZE
      ) {
        const batch = sourceFileIds.slice(
          offset,
          offset + RESET_SOURCE_SCOPE_INSERT_BATCH_SIZE,
        );
        for (const sourceFileId of batch) insertSource.run(sourceFileId);
      }
      this.installed = true;
    } catch (error) {
      try {
        this.db.exec(
          'DROP TABLE IF EXISTS temp.__codegraph_resolution_reset_sources',
        );
      } catch {
        // Preserve the setup failure that caused installation to abort.
      }
      throw error;
    }
  }

  /**
   * SQL boolean expression for an audited W2 table alias. Whole mode is the
   * original unfiltered reset. Scoped [] uses the empty TEMP table and therefore
   * matches no rows. No user string is interpolated into this predicate.
   */
  public predicate(alias: ResolutionResetSourceAlias): string {
    if (this.isWholeGraph) return '1 = 1';
    if (!this.installed) {
      throw new Error('Scoped reset TEMP source table must be installed first');
    }
    const sourceColumn = SOURCE_FILE_COLUMN_BY_ALIAS[alias];
    if (sourceColumn === undefined) {
      throw new Error('Unsupported SQL alias for resolution reset scope');
    }
    return `EXISTS (
      SELECT 1
      FROM ${RESET_SCOPE_TABLE} AS reset_scope
      WHERE reset_scope.source_file_id = ${sourceColumn}
    )`;
  }

  /** In-memory predicate for projection filters; no SQL row/edge map retained. */
  public includes(sourceFileId: string): boolean {
    if (this.isWholeGraph) return true;
    return this.selectedSourceFileIdSet?.has(sourceFileId) ?? false;
  }

  /** Remove only our temp scope table after W2 has applied and closed its view. */
  public close(): void {
    if (!this.installed) return;
    this.db.exec(
      'DROP TABLE IF EXISTS temp.__codegraph_resolution_reset_sources',
    );
    this.installed = false;
  }
}
