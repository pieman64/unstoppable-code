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

describe('a v2 commit log written by the base library (CAN-4408)', () => {
  it('opens without changing its schema, rows or stored diagnostics bytes', () => {
    const before = contents();
    const bytes = diagnosticsBytes();
    expect(
      withRaw((db) => db.prepare('SELECT key, value FROM w5_meta').all()),
    ).toEqual([
      { key: 'schema_version', value: String(W5_COMMIT_LOG_SCHEMA_VERSION) },
    ]);

    open().close();

    expect(contents()).toEqual(before);
    expect(diagnosticsBytes()).toEqual(bytes);
  });

  it('refuses a second writer while one holds it, writing nothing', () => {
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
