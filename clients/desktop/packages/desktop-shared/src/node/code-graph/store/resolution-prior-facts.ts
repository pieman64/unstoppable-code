import {
  hasActiveCodeGraphWriteTransaction,
  requireRow,
  requireString,
  type CodeGraphDatabase,
} from './database';

/** Private W3 source draft. Adopt beside store/database.ts only after review. */
export interface PriorResolutionSourceFacts {
  fileId: string;
  previousFile: Record<string, unknown> | null;
  previousSymbols: readonly Record<string, unknown>[];
  previousEdges: readonly Record<string, unknown>[];
  previousDependencies: readonly Record<string, unknown>[];
}

/**
 * A build-owned TEMP preimage, populated before any replacement/deletion.
 * It never publishes, opens another DB, or owns a transaction. Only planned
 * files are copied; neither the whole graph nor an all-edge JavaScript map is
 * duplicated. Rows persist through resolver execution and rollback ownership
 * remains with the enclosing engine build.
 */
export class ResolutionPriorFacts {
  public constructor(private readonly db: CodeGraphDatabase) {
    this.requireOwner();
    db.exec(`
      CREATE TEMP TABLE w3_prior_sources (file_id TEXT PRIMARY KEY);
      CREATE TEMP TABLE w3_prior_files AS SELECT * FROM main.files WHERE 0;
      CREATE UNIQUE INDEX w3_prior_files_id ON w3_prior_files(id);
      CREATE TEMP TABLE w3_prior_symbols AS SELECT * FROM main.symbols WHERE 0;
      CREATE UNIQUE INDEX w3_prior_symbols_id ON w3_prior_symbols(id);
      CREATE INDEX w3_prior_symbols_file ON w3_prior_symbols(file_id);
      CREATE TEMP TABLE w3_prior_edges AS SELECT * FROM main.edges WHERE 0;
      CREATE UNIQUE INDEX w3_prior_edges_id ON w3_prior_edges(id);
      CREATE INDEX w3_prior_edges_file ON w3_prior_edges(source_file_id);
      CREATE TEMP TABLE w3_prior_dependencies AS
        SELECT * FROM main.resolution_dependencies WHERE 0;
      CREATE INDEX w3_prior_dependencies_source ON
        w3_prior_dependencies(repository_id, source_file_id, resolver);
      CREATE INDEX w3_prior_dependencies_reverse ON
        w3_prior_dependencies(repository_id, dependency_kind, dependency_key, resolver);
    `);
  }

  private requireOwner(): void {
    if (!hasActiveCodeGraphWriteTransaction(this.db)) {
      throw new Error(
        'Resolution preimages require the owned graph build transaction',
      );
    }
  }

  /** Include new, removed, retried, oversized and renamed files BEFORE writer calls. */
  public preserve(fileId: string): void {
    this.requireOwner();
    const added = this.db
      .prepare(
        'INSERT OR IGNORE INTO temp.w3_prior_sources(file_id) VALUES (?)',
      )
      .run(fileId);
    if (Number(added.changes) === 0) return;
    this.db
      .prepare(
        'INSERT INTO temp.w3_prior_files SELECT * FROM main.files WHERE id = ?',
      )
      .run(fileId);
    this.db
      .prepare(
        'INSERT INTO temp.w3_prior_symbols SELECT * FROM main.symbols WHERE file_id = ?',
      )
      .run(fileId);
    this.db
      .prepare(
        'INSERT INTO temp.w3_prior_edges SELECT * FROM main.edges WHERE source_file_id = ?',
      )
      .run(fileId);
    this.db
      .prepare(
        'INSERT INTO temp.w3_prior_dependencies SELECT * FROM main.resolution_dependencies WHERE source_file_id = ?',
      )
      .run(fileId);
  }

  public listPreservedFileIds(): string[] {
    return this.db
      .prepare('SELECT file_id FROM temp.w3_prior_sources ORDER BY file_id')
      .all()
      .map((row): string => requireString(requireRow(row), 'file_id'));
  }

  public read(fileId: string): PriorResolutionSourceFacts {
    const row = this.db
      .prepare('SELECT * FROM temp.w3_prior_files WHERE id = ?')
      .get(fileId);
    return {
      fileId,
      previousFile: row === undefined ? null : requireRow(row),
      previousSymbols: this.db
        .prepare(
          'SELECT * FROM temp.w3_prior_symbols WHERE file_id = ? ORDER BY id',
        )
        .all(fileId)
        .map(requireRow),
      previousEdges: this.db
        .prepare(
          'SELECT * FROM temp.w3_prior_edges WHERE source_file_id = ? ORDER BY id',
        )
        .all(fileId)
        .map(requireRow),
      previousDependencies: this.db
        .prepare(
          'SELECT * FROM temp.w3_prior_dependencies WHERE source_file_id = ? ORDER BY resolver, source_edge_id, dependency_kind, dependency_key',
        )
        .all(fileId)
        .map(requireRow),
    };
  }

  /** Deleted destinations seed consumers independently of source deletion. */
  public listDeletedSymbolIds(): string[] {
    return this.db
      .prepare(
        `SELECT old.id FROM temp.w3_prior_symbols old
      LEFT JOIN main.symbols current ON current.id = old.id
      WHERE current.id IS NULL ORDER BY old.id`,
      )
      .all()
      .map((row): string => requireString(requireRow(row), 'id'));
  }

  /**
   * Must be used for reverse lookup until dependency replacement commits.
   * UNION restores old records even when another build stage replaced them.
   * Repository IDs here are opaque storage IDs, never public repo names.
   */
  public reverseDependencies(
    repositoryId: string,
    kind: string,
    key: string,
  ): Record<string, unknown>[] {
    return this.db
      .prepare(
        `SELECT * FROM main.resolution_dependencies
      WHERE repository_id = ? AND dependency_kind = ? AND dependency_key = ?
      UNION SELECT * FROM temp.w3_prior_dependencies
      WHERE repository_id = ? AND dependency_kind = ? AND dependency_key = ?
      ORDER BY resolver, source_file_id, source_edge_id`,
      )
      .all(repositoryId, kind, key, repositoryId, kind, key)
      .map(requireRow);
  }

  /** Bounded DISTINCT file owners; multiple edges/resolvers never consume file cap. */
  public reverseDependencyOwners(
    repositoryId: string,
    kind: string,
    key: string,
  ): Record<string, unknown>[] {
    return this.db
      .prepare(
        `SELECT MIN(resolver) AS resolver, source_file_id
      FROM (
        SELECT resolver, source_file_id FROM main.resolution_dependencies
          WHERE repository_id = ? AND dependency_kind = ? AND dependency_key = ?
        UNION ALL
        SELECT resolver, source_file_id FROM temp.w3_prior_dependencies
          WHERE repository_id = ? AND dependency_kind = ? AND dependency_key = ?
      ) GROUP BY source_file_id ORDER BY source_file_id LIMIT 10001`,
      )
      .all(repositoryId, kind, key, repositoryId, kind, key)
      .map(requireRow);
  }

  public close(): void {
    this.db.exec(`DROP TABLE IF EXISTS temp.w3_prior_dependencies;
      DROP TABLE IF EXISTS temp.w3_prior_edges;
      DROP TABLE IF EXISTS temp.w3_prior_symbols;
      DROP TABLE IF EXISTS temp.w3_prior_files;
      DROP TABLE IF EXISTS temp.w3_prior_sources;`);
  }
}
