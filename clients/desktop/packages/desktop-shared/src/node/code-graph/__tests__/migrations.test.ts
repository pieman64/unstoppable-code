import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  getMetadataValue,
  openCodeGraphDatabase,
  setMetadataValue,
  withImmediateTransaction,
} from '../store/database';
import {
  CODE_GRAPH_MIGRATIONS,
  runCodeGraphMigrations,
} from '../store/migrations';
import { CODE_GRAPH_SCHEMA_VERSION } from '../../../types/code-graph';
import {
  readCodeGraphFingerprintMetadata,
  requireRow,
  requireString,
  type CodeGraphDatabase,
} from '../store/database';
import { isSymbolFtsMappingTrusted, rebuildSymbolFts } from '../store/fts';
import {
  buildRealisticFixtureGraph,
  indexDefinitions,
  useSchemaV3Indexes,
} from './query-plan-fixture';

/** Every row of every table and index-independent virtual table content. */
function everyRow(db: CodeGraphDatabase): Record<string, unknown[]> {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%fts_%' ORDER BY name`,
    )
    .all()
    .map((row) => requireString(requireRow(row), 'name'));
  return Object.fromEntries(
    tables.map((table) => [
      table,
      db
        .prepare(`SELECT * FROM "${table}" ORDER BY rowid`)
        .all()
        .filter(
          (row) =>
            table !== 'graph_metadata' ||
            requireRow(row).key !== 'schema_version',
        ),
    ]),
  );
}

describe('code-graph database and migrations', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'code-graph-db-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the schema idempotently and records the version', () => {
    const db = openCodeGraphDatabase(path.join(dir, 'nested', 'graph.db'));
    runCodeGraphMigrations(db);
    runCodeGraphMigrations(db); // idempotent second run
    expect(getMetadataValue(db, 'schema_version')).toBe(
      String(CODE_GRAPH_SCHEMA_VERSION),
    );
    expect(CODE_GRAPH_SCHEMA_VERSION).toBe(5);
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type IN ('table','virtual table') ORDER BY name`,
      )
      .all()
      .map((row) => JSON.stringify(row));
    const joined = tables.join(' ');
    for (const t of [
      'graph_metadata',
      'repositories',
      'files',
      'symbols',
      'edges',
      'symbol_fts',
      'symbol_fragment_fts',
      'symbol_fts_rows',
      'communities',
      'community_memberships',
      'flows',
      'flow_memberships',
    ]) {
      expect(joined).toContain(t);
    }
    db.close();
  });

  it('keeps CODE_GRAPH_MIGRATIONS in lockstep with CODE_GRAPH_SCHEMA_VERSION (the out-of-sync guard never fires on a normal build)', () => {
    const lastMigration =
      CODE_GRAPH_MIGRATIONS[CODE_GRAPH_MIGRATIONS.length - 1];
    expect(lastMigration?.version).toBe(CODE_GRAPH_SCHEMA_VERSION);
  });

  it('migrates an existing v1 database to the current schema without data loss', () => {
    const db = openCodeGraphDatabase(path.join(dir, 'v1-upgrade.db'));
    // Build a v1-only fixture DB by hand: the metadata table plus exactly the
    // v1 migration's statements, with schema_version pinned at '1' -- this is
    // what a database created before the later migrations existed would
    // look like on disk.
    db.exec(
      'CREATE TABLE IF NOT EXISTS graph_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    );
    const v1Migration = CODE_GRAPH_MIGRATIONS.find(
      (migration) => migration.version === 1,
    );
    if (v1Migration === undefined) {
      throw new Error('v1 migration missing from CODE_GRAPH_MIGRATIONS');
    }
    v1Migration.up(db);
    setMetadataValue(db, 'schema_version', '1');
    db.prepare(
      'INSERT INTO repositories (id, repo_id, root_path, git_head, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('repo-row-1', 'repo-a', '/abs/root', null, Date.now());

    runCodeGraphMigrations(db);

    expect(getMetadataValue(db, 'schema_version')).toBe(
      String(CODE_GRAPH_SCHEMA_VERSION),
    );
    const repoRow = db
      .prepare('SELECT repo_id FROM repositories WHERE id = ?')
      .get('repo-row-1');
    expect(JSON.stringify(repoRow)).toContain('repo-a');
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
      )
      .all()
      .map((row) => JSON.stringify(row));
    const joined = tables.join(' ');
    for (const t of [
      'communities',
      'community_memberships',
      'flows',
      'flow_memberships',
    ]) {
      expect(joined).toContain(t);
    }
    db.close();
  });

  it('migrates an existing v2 database in place to the current schema with the fragment index', () => {
    const db = openCodeGraphDatabase(path.join(dir, 'v2-upgrade.db'));
    db.exec(
      'CREATE TABLE IF NOT EXISTS graph_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    );
    for (const migration of CODE_GRAPH_MIGRATIONS.filter(
      (candidate) => candidate.version <= 2,
    )) {
      migration.up(db);
    }
    setMetadataValue(db, 'schema_version', '2');

    runCodeGraphMigrations(db);

    expect(getMetadataValue(db, 'schema_version')).toBe(
      String(CODE_GRAPH_SCHEMA_VERSION),
    );
    const fragmentTable = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'symbol_fragment_fts'`,
      )
      .get();
    expect(JSON.stringify(fragmentTable)).toContain('symbol_fragment_fts');
    db.close();
  });

  it('lands a fresh database at v5 straight through (no intermediate state observable)', () => {
    const db = openCodeGraphDatabase(path.join(dir, 'fresh-v5.db'));
    runCodeGraphMigrations(db);
    expect(getMetadataValue(db, 'schema_version')).toBe('5');
    expect(isSymbolFtsMappingTrusted(db)).toBe(false);
    db.close();
  });

  it('upgrades a built v3 graph to v5 by replacing indexes only, leaving every fact and the staleness signal intact', async () => {
    // A real v3 graph: built, then given the v3 index set and version.
    const fixture = await buildRealisticFixtureGraph(['fixture']);
    try {
      const db = openCodeGraphDatabase(fixture.dbPath);
      try {
        useSchemaV3Indexes(db);
        setMetadataValue(db, 'schema_version', '3');
        // A real v3 source has no schema-v5 completion marker.
        db.prepare(
          "DELETE FROM graph_metadata WHERE key = 'symbol_fts_mapping_version'",
        ).run();
        db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        // The scheduler compares this with CODE_GRAPH_SCHEMA_VERSION and
        // refreshes the worktree, so the next build migrates it.
        expect(readCodeGraphFingerprintMetadata(db).schemaVersion).toBe(3);
        expect(CODE_GRAPH_SCHEMA_VERSION).not.toBe(3);
        const before = everyRow(db);

        runCodeGraphMigrations(db);

        expect(getMetadataValue(db, 'schema_version')).toBe('5');
        expect(isSymbolFtsMappingTrusted(db)).toBe(false);
        // Facts, FTS rows, derived data and other metadata are untouched:
        // nothing to reparse or re-resolve.
        expect(everyRow(db)).toEqual(before);
        const fresh = openCodeGraphDatabase(path.join(dir, 'fresh.db'));
        try {
          runCodeGraphMigrations(fresh);
          expect(indexDefinitions(db)).toEqual(indexDefinitions(fresh));
        } finally {
          fresh.close();
        }
      } finally {
        db.close();
      }
    } finally {
      fixture.cleanup();
    }
  }, 120_000);

  it('upgrades a v4 database with facts intact and trusts mapping only after full repair', async () => {
    const fixture = await buildRealisticFixtureGraph(['fixture']);
    try {
      const db = openCodeGraphDatabase(fixture.dbPath);
      try {
        db.exec('DROP TABLE symbol_fts_rows');
        db.prepare(
          "DELETE FROM graph_metadata WHERE key = 'symbol_fts_mapping_version'",
        ).run();
        setMetadataValue(db, 'schema_version', '4');
        const factsBefore = everyRow(db);
        runCodeGraphMigrations(db);

        expect(getMetadataValue(db, 'schema_version')).toBe('5');
        expect(everyRow(db)).toEqual(factsBefore);
        expect(isSymbolFtsMappingTrusted(db)).toBe(false);
        rebuildSymbolFts(db);
        expect(getMetadataValue(db, 'symbol_fts_mapping_version')).toBe(
          '5:rowid-v1',
        );
        expect(isSymbolFtsMappingTrusted(db)).toBe(true);

        const dependencyRepositoryColumn = db
          .prepare('PRAGMA table_info(resolution_dependencies)')
          .all()
          .map((value) => requireRow(value))
          .find((row) => row.name === 'repository_id');
        expect(dependencyRepositoryColumn).toMatchObject({
          type: 'TEXT',
          notnull: 1,
        });
      } finally {
        db.close();
      }
    } finally {
      fixture.cleanup();
    }
  }, 120_000);

  it('uses WAL mode and rolls back failed immediate transactions', () => {
    const db = openCodeGraphDatabase(path.join(dir, 'graph.db'));
    runCodeGraphMigrations(db);
    const mode = db.prepare('PRAGMA journal_mode').get();
    expect(JSON.stringify(mode)).toContain('wal');
    expect(() =>
      withImmediateTransaction(db, () => {
        setMetadataValue(db, 'probe', 'value');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(getMetadataValue(db, 'probe')).toBeNull();
    setMetadataValue(db, 'probe', 'kept');
    expect(getMetadataValue(db, 'probe')).toBe('kept');
    db.close();
  });
});
