import { CODE_GRAPH_SCHEMA_VERSION } from '../types/code-graph';
import {
  deleteMetadataValue,
  getMetadataValue,
  setMetadataValue,
  withImmediateTransaction,
  type CodeGraphDatabase,
} from './database';

export interface CodeGraphMigration {
  version: number;
  up(db: CodeGraphDatabase): void;
}

const V1_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS repositories (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL UNIQUE,
    root_path TEXT NOT NULL,
    git_head TEXT,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    absolute_path TEXT NOT NULL,
    language TEXT,
    content_hash TEXT,
    size_bytes INTEGER NOT NULL,
    mtime_ns TEXT NOT NULL,
    line_count INTEGER,
    grammar_id TEXT,
    grammar_abi INTEGER,
    parse_status TEXT NOT NULL,
    has_errors INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    UNIQUE(repository_id, relative_path)
  )`,
  `CREATE TABLE IF NOT EXISTS symbols (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    qualified_name TEXT NOT NULL,
    parent_symbol_id TEXT,
    line_start INTEGER NOT NULL,
    line_end INTEGER NOT NULL,
    byte_start INTEGER NOT NULL,
    byte_end INTEGER NOT NULL,
    signature TEXT,
    exported INTEGER NOT NULL DEFAULT 0,
    is_test INTEGER NOT NULL DEFAULT 0,
    extra_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE(repository_id, qualified_name)
  )`,
  `CREATE TABLE IF NOT EXISTS edges (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    source_symbol_id TEXT,
    target_symbol_id TEXT,
    source_file_id TEXT NOT NULL,
    target_ref TEXT,
    line INTEGER,
    confidence_tier TEXT NOT NULL,
    confidence_score REAL NOT NULL,
    resolver_id TEXT,
    evidence_json TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_files_repo ON files(repository_id)`,
  `CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id)`,
  `CREATE INDEX IF NOT EXISTS idx_symbols_repo_name ON symbols(repository_id, name)`,
  `CREATE INDEX IF NOT EXISTS idx_edges_source_symbol ON edges(source_symbol_id)`,
  `CREATE INDEX IF NOT EXISTS idx_edges_target_symbol ON edges(target_symbol_id)`,
  `CREATE INDEX IF NOT EXISTS idx_edges_source_file ON edges(source_file_id)`,
  `CREATE INDEX IF NOT EXISTS idx_edges_repo_kind ON edges(repository_id, kind)`,
  `CREATE INDEX IF NOT EXISTS idx_edges_unresolved ON edges(repository_id, kind) WHERE target_symbol_id IS NULL`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS symbol_fts USING fts5(
    symbol_id UNINDEXED,
    name,
    qualified_name,
    signature,
    file_path,
    tokenize = 'porter unicode61'
  )`,
];

// Schema v2 (Phase 6 Task 3): derived-analysis tables for community
// detection and flow tracing (computed by later Phase 6 tasks -- this
// migration only lays the storage foundation). Purely additive relative to
// V1_STATEMENTS: no existing table/column changes. No FOREIGN KEY
// declarations here either, matching V1_STATEMENTS's own discipline --
// repo/symbol/community/flow linkage is enforced at the application layer
// (see store/graph-store.ts's delete-then-insert `replaceDerivedForRepo`),
// not by sqlite FK constraints, the same way files/symbols/edges above
// never declare one back to `repositories`.
const V2_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS communities (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL,
    label TEXT NOT NULL,
    cohesion REAL NOT NULL,
    size INTEGER NOT NULL,
    fingerprint TEXT NOT NULL,
    extra_json TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE TABLE IF NOT EXISTS community_memberships (
    community_id TEXT NOT NULL,
    symbol_id TEXT NOT NULL,
    PRIMARY KEY (community_id, symbol_id)
  )`,
  `CREATE TABLE IF NOT EXISTS flows (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL,
    entry_symbol_id TEXT NOT NULL,
    name TEXT NOT NULL,
    criticality REAL NOT NULL,
    symbol_count INTEGER NOT NULL,
    file_spread INTEGER NOT NULL,
    max_depth INTEGER NOT NULL,
    extra_json TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE TABLE IF NOT EXISTS flow_memberships (
    flow_id TEXT NOT NULL,
    symbol_id TEXT NOT NULL,
    depth INTEGER NOT NULL,
    PRIMARY KEY (flow_id, symbol_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_community_memberships_symbol ON community_memberships(symbol_id)`,
  `CREATE INDEX IF NOT EXISTS idx_flow_memberships_symbol ON flow_memberships(symbol_id)`,
  `CREATE INDEX IF NOT EXISTS idx_communities_repo ON communities(repository_id)`,
  `CREATE INDEX IF NOT EXISTS idx_flows_repo ON flows(repository_id)`,
];

const V3_STATEMENTS: readonly string[] = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS symbol_fragment_fts USING fts5(
    symbol_id UNINDEXED,
    name_folded,
    qualified_name_folded,
    tokenize = 'trigram'
  )`,
];

// Schema v4: index-only. Facts and every other table are unchanged.
// - The edge target index becomes partial: about two thirds of edges are
//   unresolved, and nothing looks up a NULL target (unresolved edges are
//   found through `idx_edges_unresolved`). Every lookup by target compares
//   it with `=` or `IN`, which implies `IS NOT NULL`, so the partial index
//   still serves it, including relationship-path's `INDEXED BY`.
// - A NOCASE name index serves symbol search's case-insensitive exact and
//   prefix match, which the binary `idx_symbols_repo_name` cannot.
const V4_STATEMENTS: readonly string[] = [
  `DROP INDEX IF EXISTS idx_edges_target_symbol`,
  `CREATE INDEX IF NOT EXISTS idx_edges_target_symbol ON edges(target_symbol_id) WHERE target_symbol_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_symbols_name_nocase ON symbols(name COLLATE NOCASE)`,
];

// Schema v5: additive FTS rowid ownership and an empty W3 dependency table.
// `repository_id` in both tables is the opaque repositories.id identity, not
// the public repositories.repo_id. `source_edge_id` is empty for file-owned
// dependency records; `dependency_value` is canonical JSON for a positive or
// negative observed value. Migration does not populate either table.
const V5_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS symbol_fts_rows (
    symbol_id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    symbol_fts_rowid INTEGER NOT NULL UNIQUE,
    fragment_fts_rowid INTEGER NOT NULL UNIQUE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_symbol_fts_rows_file ON symbol_fts_rows(file_id)`,
  `CREATE INDEX IF NOT EXISTS idx_symbol_fts_rows_repository ON symbol_fts_rows(repository_id)`,
  `CREATE TABLE IF NOT EXISTS resolution_dependencies (
    repository_id TEXT NOT NULL,
    resolver TEXT NOT NULL,
    source_file_id TEXT NOT NULL,
    source_edge_id TEXT NOT NULL,
    dependency_kind TEXT NOT NULL,
    dependency_key TEXT NOT NULL,
    dependency_value TEXT NOT NULL,
    PRIMARY KEY (repository_id, resolver, source_file_id, source_edge_id, dependency_kind, dependency_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_resolution_dependencies_reverse
    ON resolution_dependencies(repository_id, dependency_kind, dependency_key, resolver)`,
  `CREATE INDEX IF NOT EXISTS idx_resolution_dependencies_source
    ON resolution_dependencies(repository_id, source_file_id, resolver)`,
];

// Exported (not just internal) so tests can build a v1-only fixture
// database by hand (e.g. `CODE_GRAPH_MIGRATIONS.find(m => m.version ===
// 1).up(db)`) to exercise the real in-place v1 -> v2 upgrade path, rather
// than duplicating V1_STATEMENTS in a test file.
export const CODE_GRAPH_MIGRATIONS: readonly CodeGraphMigration[] = [
  {
    version: 1,
    up(db: CodeGraphDatabase): void {
      for (const statement of V1_STATEMENTS) {
        db.exec(statement);
      }
    },
  },
  {
    version: 2,
    up(db: CodeGraphDatabase): void {
      for (const statement of V2_STATEMENTS) {
        db.exec(statement);
      }
    },
  },
  {
    version: 3,
    up(db: CodeGraphDatabase): void {
      for (const statement of V3_STATEMENTS) {
        db.exec(statement);
      }
    },
  },
  {
    version: 4,
    up(db: CodeGraphDatabase): void {
      for (const statement of V4_STATEMENTS) {
        db.exec(statement);
      }
    },
  },
  {
    version: 5,
    up(db: CodeGraphDatabase): void {
      for (const statement of V5_STATEMENTS) {
        db.exec(statement);
      }
      // Schema and row-writer changed. The first normal engine build performs
      // the full atomic FTS/mapping repair and writes the completion marker.
      deleteMetadataValue(db, 'symbol_fts_mapping_version');
    },
  },
];

/**
 * The database was written by a newer schema than this build supports. It is
 * refused before anything is written, and must not be rebuilt over.
 */
export class CodeGraphSchemaNewerError extends Error {
  readonly storedVersion: number;
  readonly supportedVersion: number;

  constructor(storedVersion: number) {
    super(
      `Code graph schema version ${storedVersion} is newer than supported version ${CODE_GRAPH_SCHEMA_VERSION}`,
    );
    this.name = 'CodeGraphSchemaNewerError';
    this.storedVersion = storedVersion;
    this.supportedVersion = CODE_GRAPH_SCHEMA_VERSION;
  }
}

function hasMetadataTable(db: CodeGraphDatabase): boolean {
  return (
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'graph_metadata'",
      )
      .get() !== undefined
  );
}

export function runCodeGraphMigrations(db: CodeGraphDatabase): void {
  const raw = hasMetadataTable(db)
    ? getMetadataValue(db, 'schema_version')
    : null;
  const current = raw === null ? 0 : Number(raw);
  if (current > CODE_GRAPH_SCHEMA_VERSION) {
    throw new CodeGraphSchemaNewerError(current);
  }
  db.exec(
    'CREATE TABLE IF NOT EXISTS graph_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  );
  for (const migration of CODE_GRAPH_MIGRATIONS) {
    if (migration.version <= current) {
      continue;
    }
    withImmediateTransaction(db, () => {
      migration.up(db);
      setMetadataValue(db, 'schema_version', String(migration.version));
    });
  }
  const lastMigration = CODE_GRAPH_MIGRATIONS[CODE_GRAPH_MIGRATIONS.length - 1];
  if (
    lastMigration === undefined ||
    lastMigration.version !== CODE_GRAPH_SCHEMA_VERSION
  ) {
    throw new Error(
      'CODE_GRAPH_SCHEMA_VERSION and migrations list are out of sync',
    );
  }
}
