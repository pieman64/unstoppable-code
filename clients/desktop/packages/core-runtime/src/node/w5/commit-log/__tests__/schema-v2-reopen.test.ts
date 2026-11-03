import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { W5CommitLog, W5_COMMIT_LOG_SCHEMA_VERSION } from '..';
import {
  LATER,
  OTHER_FINGERPRINT,
  fingerprintOf,
  keys,
  liveDiagnosticsUpdate,
  observeW5CommitLog,
  requests,
  reservations,
} from './fixtures/schema-v2-base-scenario';
import { schemaV2Chains } from './fixtures/schema-v2-capture-oracle';

// A v2 log the base library wrote before CAN-4408 moved it (see
// fixtures/generate-schema-v2-base.mjs) opens unchanged and reads, retries
// and recovers as the base library did.

const fixtures = join(__dirname, 'fixtures');
// Compared as JSON text, so key order and omitted optionals count too.
const baseObservations = JSON.stringify(
  Reflect.get(
    JSON.parse(
      readFileSync(join(fixtures, 'schema-v2-base.observations.json'), 'utf8'),
    ),
    'observations',
  ),
);

let dir: string;
let dbPath: string;

function withRaw<T>(run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

/** The schema and every row, sqlite_sequence included. */
function contents(): Record<string, unknown> {
  return withRaw((db) => {
    const tables: Record<string, unknown> = {
      schema: db
        .prepare(
          'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name',
        )
        .all(),
    };
    for (const row of db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()) {
      const name = String(row.name);
      tables[name] = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
    }
    return tables;
  });
}

/** Stored diagnostics as the bytes on disk, not as decoded strings. */
function diagnosticsBytes(): Record<string, unknown> {
  return withRaw((db) => ({
    commits: db
      .prepare(
        'SELECT commit_id, CAST(diagnostics_json AS BLOB) AS bytes FROM w5_commits ORDER BY commit_id',
      )
      .all(),
    reservations: db
      .prepare(
        'SELECT reservation_id, CAST(diagnostics_json AS BLOB) AS bytes FROM w5_reservations ORDER BY reservation_id',
      )
      .all(),
  }));
}

function open(): W5CommitLog {
  return W5CommitLog.open(dbPath, { clock: () => LATER });
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected an error');
}

beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'w5-v2-reopen-'));
  dbPath = join(dir, 'commit-log.sqlite');
  withRaw((db) => {
    // The base library leaves its file in WAL mode.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(readFileSync(join(fixtures, 'schema-v2-base.sql'), 'utf8'));
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Schema 3's additions (CAN-5563); everything else is the base library's. */
const SCHEMA_V3_OBJECTS = new Set([
  'w5_file_chains',
  'sqlite_autoindex_w5_file_chains_1',
  'w5_commit_totals',
  'w5_file_chains_insert',
  'w5_file_chains_delete',
  'w5_file_chains_update',
  'w5_commit_totals_insert',
  'w5_commit_totals_delete',
]);

/** The base library's objects and rows, less the schema version it bumps. */
function withoutSchemaV3(
  tables: Record<string, unknown>,
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(tables)) {
    if (name === 'w5_meta' || SCHEMA_V3_OBJECTS.has(name)) continue;
    kept[name] =
      name === 'schema' && Array.isArray(value)
        ? value.filter(
            (entry: unknown) =>
              !SCHEMA_V3_OBJECTS.has(
                String(Reflect.get(Object(entry), 'name')),
              ),
          )
        : value;
  }
  return kept;
}

describe('a v2 commit log written by the base library (CAN-4408)', () => {
  it('upgrades to schema 3 keeping every v2 row and stored diagnostics byte', () => {
    const before = contents();
    const bytes = diagnosticsBytes();
    const chains = withRaw(schemaV2Chains);
    expect(before.w5_meta).toEqual([{ key: 'schema_version', value: '2' }]);

    open().close();

    const after = contents();
    expect(withoutSchemaV3(after)).toEqual(withoutSchemaV3(before));
    expect(after.w5_meta).toEqual([
      { key: 'schema_version', value: String(W5_COMMIT_LOG_SCHEMA_VERSION) },
    ]);
    expect(W5_COMMIT_LOG_SCHEMA_VERSION).toBe(3);
    expect(after.w5_commit_totals).toEqual([{ singleton: 1, retained: 4 }]);
    expect(after.w5_file_chains).toEqual(
      Array.from(chains, ([path, chain]) => ({
        path,
        decisions: chain.decisions,
        starts_absent: chain.startsAbsent ? 1 : 0,
        discontinuities: chain.discontinuities,
      })),
    );
    expect(chains.size).toBe(5);
    expect(diagnosticsBytes()).toEqual(bytes);

    open().close();
    expect(contents()).toEqual(after);
  });

  it('refuses a second writer while one holds it, writing nothing', () => {
    open().close();
    const before = contents();
    const log = open();
    try {
      expect(thrown(() => W5CommitLog.open(dbPath, 0))).toMatchObject({
        name: 'W5CommitLogError',
        code: 'WRITER_UNAVAILABLE',
      });
    } finally {
      log.close();
    }
    expect(contents()).toEqual(before);
  });

  it('replays a keyed retry and refuses reused keys from its receipts', () => {
    const log = open();
    try {
      expect(log.lookupReceipt(keys.applied, fingerprintOf('applied'))).toEqual(
        { status: 'replay', commitId: 2, outcome: requests.applied.outcome },
      );
      expect(log.lookupReceipt(keys.applied, OTHER_FINGERPRINT)).toEqual({
        status: 'key-reused',
      });
      expect(log.lookupReceipt(keys.unknown, fingerprintOf('unknown'))).toEqual(
        { status: 'none' },
      );
      expect(log.commit(requests.applied)).toEqual({
        status: 'replayed',
        commitId: 2,
        outcome: requests.applied.outcome,
      });
      expect(log.revision({ kind: 'workspaces' })).toBe(2);
    } finally {
      log.close();
    }
  });

  it('reads, retries and recovers it as the base library did', () => {
    const log = open();
    try {
      expect(
        JSON.stringify(
          observeW5CommitLog(log, () => W5CommitLog.open(dbPath, 0)),
        ),
      ).toBe(baseObservations);
    } finally {
      log.close();
    }
  });

  it('stores the base library bytes when the same diagnostics update repeats', () => {
    open().close();
    const before = contents();
    const bytes = diagnosticsBytes();
    const log = open();
    try {
      log.updateReservationDiagnostics(
        reservations.live.reservationId,
        liveDiagnosticsUpdate,
      );
    } finally {
      log.close();
    }
    expect(diagnosticsBytes()).toEqual(bytes);
    expect(contents()).toEqual(before);
  });
});
