import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { LedgerAddEntryParams } from '@canopy/protocol/canopy-core';

import { LedgerRepository } from '../repository';
import { LEDGER_SCHEMA_VERSION } from '../schema';
import {
  addInput,
  captureLedgerError,
  createTempDirectory,
  readLedgerDatabase,
  removeTempDirectory,
  setUpLedger,
  type LedgerTestContext,
} from './ledger-test-harness';

const TASK: LedgerAddEntryParams = {
  type: 'TASK',
  title: 'Reference files',
  content: 'Check the referenced files.',
};

/** The `ledger_mutations` indexes schema version 2 adds. */
const MUTATION_ACTOR_INDEXES = [
  'ledger_mutations_by_effective_actor',
  'ledger_mutations_by_recorded_by',
];

function mutationActorIndexes(raw: DatabaseSync): string[] {
  return raw
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ledger_mutations' AND name IN (?, ?) ORDER BY name",
    )
    .all(...MUTATION_ACTOR_INDEXES)
    .map((row) => String(row.name));
}

function recordedSchemaVersion(raw: DatabaseSync): string {
  const row = raw
    .prepare("SELECT value FROM ledger_meta WHERE key = 'schema_version'")
    .get();
  return String(row?.value);
}

/** Runs SQL directly on a closed test database. */
function execRaw(databasePath: string, sql: string): void {
  const raw = new DatabaseSync(databasePath);
  try {
    raw.exec(sql);
  } finally {
    raw.close();
  }
}

/** Removes only the additive v6 structures when constructing an older fixture. */
function removeOperationsSchema(databasePath: string): void {
  const raw = new DatabaseSync(databasePath);
  try {
    raw.exec('DROP TABLE IF EXISTS ledger_entry_roots');
    const indexes = raw
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('ledger_entries', 'ledger_entry_versions')",
      )
      .all();
    for (const index of indexes) {
      if (String(index.sql).includes('parent_entry_id')) {
        raw.exec(`DROP INDEX "${String(index.name).replace(/"/g, '""')}"`);
      }
    }
    for (const table of ['ledger_entries', 'ledger_entry_versions']) {
      if (
        raw
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((column) => column.name === 'parent_entry_id')
      ) {
        raw.exec(`ALTER TABLE ${table} DROP COLUMN parent_entry_id`);
      }
    }
  } finally {
    raw.close();
  }
}

/**
 * Turns a closed test database into one a version 2 build left behind: it
 * records version 2 and has no sync bookkeeping.
 */
function makeVersion2Database(databasePath: string): void {
  removeOperationsSchema(databasePath);
  execRaw(
    databasePath,
    `DROP TABLE IF EXISTS ledger_global_bindings;
    DROP TABLE IF EXISTS ledger_pending_titles;
    DROP TABLE ledger_scope_sync;
    UPDATE ledger_meta SET value = '2' WHERE key = 'schema_version';`,
  );
}

/** Turns a closed database into the version 3 schema before pending titles. */
function makeVersion3Database(databasePath: string): void {
  removeOperationsSchema(databasePath);
  execRaw(
    databasePath,
    `DROP TABLE IF EXISTS ledger_global_bindings;
    DROP TABLE IF EXISTS ledger_pending_titles;
    UPDATE ledger_meta SET value = '3' WHERE key = 'schema_version';`,
  );
}

/**
 * Turns a closed test database into one a version 1 build left behind: it
 * records version 1, has no sync bookkeeping and, unless `keepIndexes`, lacks
 * the version 2 indexes. (A build of this branch created them in version 1
 * already.)
 */
function makeVersion1Database(
  databasePath: string,
  keepIndexes: boolean,
): void {
  const drops = keepIndexes
    ? ''
    : MUTATION_ACTOR_INDEXES.map((name) => `DROP INDEX ${name};`).join('\n');
  makeVersion2Database(databasePath);
  execRaw(
    databasePath,
    `${drops}
    UPDATE ledger_meta SET value = '1' WHERE key = 'schema_version';`,
  );
}

/** Turns a closed database into the version 4 schema before global bindings. */
function makeVersion4Database(databasePath: string): void {
  removeOperationsSchema(databasePath);
  execRaw(
    databasePath,
    `DROP TABLE IF EXISTS ledger_global_bindings;
    UPDATE ledger_meta SET value = '4' WHERE key = 'schema_version';`,
  );
}

function hasPendingTitlesTable(raw: DatabaseSync): boolean {
  return (
    raw
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'ledger_pending_titles'",
      )
      .get() !== undefined
  );
}

const CURRENT_SCHEMA = { version: LEDGER_SCHEMA_VERSION, readOnly: false };

/** Byte-exact snapshot of the database file and its WAL. */
function snapshotFiles(databasePath: string): Record<string, string | null> {
  const snapshot: Record<string, string | null> = {};
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const path = `${databasePath}${suffix}`;
    snapshot[suffix || 'db'] = existsSync(path)
      ? readFileSync(path).toString('base64')
      : null;
  }
  return snapshot;
}

describe('T15 single writer', () => {
  let context: LedgerTestContext;

  beforeEach(() => {
    context = setUpLedger();
  });

  afterEach(() => {
    context.dispose();
  });

  it('fails a second open with WRITER_UNAVAILABLE, writes nothing, and keeps the first working', () => {
    context.repository.addEntry(
      addInput(context, context.chat, TASK, 'before-contention'),
    );
    const before = snapshotFiles(context.databasePath);
    expect(before['-shm']).toBeNull();

    const error = captureLedgerError(() =>
      context.reopen({ openBusyTimeoutMs: 50 }),
    );
    expect(error.reason).toBe('WRITER_UNAVAILABLE');
    expect(snapshotFiles(context.databasePath)).toEqual(before);

    const after = context.repository.addEntry(
      addInput(context, context.chat, TASK, 'after-contention'),
    );
    expect(after.entry.revision).toBe(1);
    context.repository.close();

    const reopened = context.reopen({ openBusyTimeoutMs: 50 });
    expect(reopened.getStorageCounts().entries).toBe(2);
  });
});

describe('schema versions and damaged files', () => {
  let directory: string;

  beforeEach(() => {
    directory = createTempDirectory();
  });

  afterEach(() => {
    removeTempDirectory(directory);
  });

  it('opens a newer schema read-only and rejects every write', () => {
    const newerVersion = LEDGER_SCHEMA_VERSION + 1;
    const context = setUpLedger();
    try {
      const created = context.repository.addEntry(
        addInput(context, context.chat, TASK, 'before-upgrade'),
      );
      context.repository.close();
      execRaw(
        context.databasePath,
        `UPDATE ledger_meta SET value = '${newerVersion}' WHERE key = 'schema_version'`,
      );
      const before = snapshotFiles(context.databasePath);

      const newer = context.reopen();
      expect(newer.schema).toEqual({ version: newerVersion, readOnly: true });
      expect(
        newer.getEntry({
          ledgerId: context.ledgerId,
          entryId: created.entry.entryId,
        }).entry,
      ).toEqual(created.entry);
      expect(
        newer.searchEntries({ ledgerId: context.ledgerId }).entries,
      ).toHaveLength(1);
      expect(newer.listScopes().map((record) => record.scope.ledgerId)).toEqual(
        [context.ledgerId],
      );
      expect(
        newer.findContainerScopes(created.entry.scope.container),
      ).toHaveLength(1);

      const writes: (() => unknown)[] = [
        (): unknown =>
          newer.setScopeLifecycle({
            ledgerId: context.ledgerId,
            state: 'archived',
          }),
        (): unknown =>
          newer.rebindScope({
            ledgerId: context.ledgerId,
            container: created.entry.scope.container,
            containerCreatedAt: '2026-09-02T00:00:00Z',
          }),
        (): unknown => newer.purgeScope(context.ledgerId),
        (): unknown =>
          newer.addEntry(
            addInput(context, context.chat, TASK, 'after-upgrade'),
          ),
        (): unknown =>
          newer.registerActor({
            ledgerId: context.ledgerId,
            kind: 'chat',
            authorityId: context.chat.authorityId,
            originKey: 'chat:1',
            displayName: 'Chat 1',
          }),
        (): unknown =>
          newer.bindScope({
            authorityId: context.chat.authorityId,
            container: {
              kind: 'code_worktree',
              workspaceId: 'workspace-9',
              worktreeId: 'worktree-9',
            },
            containerCreatedAt: '2026-09-01T00:00:00Z',
            accountId: null,
          }),
        (): unknown =>
          newer.bindGlobalScope({
            authorityId: context.chat.authorityId,
            owner: { kind: 'personal' },
            accountId: null,
          }),
      ];
      for (const write of writes) {
        expect(captureLedgerError(write).reason).toBe('UNSUPPORTED_SCHEMA');
      }
      newer.close();
      expect(snapshotFiles(context.databasePath)).toEqual(before);
    } finally {
      context.dispose();
    }
  });

  it('preserves a damaged database file instead of recreating it', () => {
    const databasePath = join(directory, 'ledger.sqlite');
    const garbage = Buffer.from('this is not a sqlite database'.repeat(200));
    writeFileSync(databasePath, garbage);
    expect(
      captureLedgerError(() => LedgerRepository.open({ databasePath })).reason,
    ).toBe('STORAGE_UNAVAILABLE');
    expect(readFileSync(databasePath)).toEqual(garbage);
  });

  it('leaves a version 1 database as it was when its upgrade fails', () => {
    const context = setUpLedger();
    try {
      context.repository.addEntry(
        addInput(context, context.chat, TASK, 'before-upgrade'),
      );
      const counts = context.repository.getStorageCounts();
      context.repository.close();
      makeVersion1Database(context.databasePath, false);
      // A table named like the second index fails the step after it has
      // created the first one.
      execRaw(
        context.databasePath,
        'CREATE TABLE ledger_mutations_by_recorded_by (blocker INTEGER)',
      );

      expect(captureLedgerError(() => context.reopen())).toMatchObject({
        reason: 'STORAGE_UNAVAILABLE',
        diagnosticCode: 'sqlite_1',
      });
      readLedgerDatabase(context.databasePath, (raw) => {
        expect(recordedSchemaVersion(raw)).toBe('1');
        expect(mutationActorIndexes(raw)).toEqual([]);
      });

      execRaw(
        context.databasePath,
        'DROP TABLE ledger_mutations_by_recorded_by',
      );
      const upgraded = context.reopen();
      expect(upgraded.schema).toEqual(CURRENT_SCHEMA);
      expect(upgraded.getStorageCounts()).toEqual(counts);
    } finally {
      context.dispose();
    }
  });

  it('leaves a version 3 database unchanged when pending-title migration fails', () => {
    const context = setUpLedger();
    try {
      context.repository.addEntry(
        addInput(context, context.chat, TASK, 'migration-blocker'),
      );
      const counts = context.repository.getStorageCounts();
      context.repository.close();
      makeVersion3Database(context.databasePath);
      execRaw(
        context.databasePath,
        'CREATE TABLE ledger_pending_titles (blocker INTEGER)',
      );

      expect(captureLedgerError(() => context.reopen())).toMatchObject({
        reason: 'STORAGE_UNAVAILABLE',
        diagnosticCode: 'sqlite_1',
      });
      readLedgerDatabase(context.databasePath, (raw) => {
        expect(recordedSchemaVersion(raw)).toBe('3');
        expect(hasPendingTitlesTable(raw)).toBe(true);
        expect(
          raw
            .prepare(
              "SELECT type FROM sqlite_master WHERE name = 'ledger_pending_titles'",
            )
            .get(),
        ).toEqual({ type: 'table' });
      });

      execRaw(context.databasePath, 'DROP TABLE ledger_pending_titles');
      const upgraded = context.reopen();
      expect(upgraded.schema).toEqual(CURRENT_SCHEMA);
      expect(upgraded.getStorageCounts()).toEqual(counts);
    } finally {
      context.dispose();
    }
  });

  it('leaves a version 4 database unchanged when the global binding migration fails', () => {
    const context = setUpLedger();
    try {
      context.repository.addEntry(
        addInput(context, context.chat, TASK, 'migration-blocker'),
      );
      const counts = context.repository.getStorageCounts();
      context.repository.close();
      makeVersion4Database(context.databasePath);
      execRaw(
        context.databasePath,
        'CREATE TABLE ledger_global_bindings (blocker INTEGER)',
      );

      expect(captureLedgerError(() => context.reopen())).toMatchObject({
        reason: 'STORAGE_UNAVAILABLE',
        diagnosticCode: 'sqlite_1',
      });
      readLedgerDatabase(context.databasePath, (raw) => {
        expect(recordedSchemaVersion(raw)).toBe('4');
      });

      execRaw(context.databasePath, 'DROP TABLE ledger_global_bindings');
      const upgraded = context.reopen();
      expect(upgraded.schema).toEqual(CURRENT_SCHEMA);
      expect(upgraded.getStorageCounts()).toEqual(counts);
    } finally {
      context.dispose();
    }
  });

  it('mints a writer authority with the database and keeps it across reopen', () => {
    const firstPath = join(directory, 'first', 'ledger.sqlite');
    const first = LedgerRepository.open({ databasePath: firstPath });
    const authorityId = first.authorityId;
    first.close();
    expect(authorityId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const reopened = LedgerRepository.open({ databasePath: firstPath });
    const other = LedgerRepository.open({
      databasePath: join(directory, 'second', 'ledger.sqlite'),
    });
    try {
      expect(reopened.authorityId).toBe(authorityId);
      expect(other.authorityId).not.toBe(authorityId);
    } finally {
      reopened.close();
      other.close();
    }
  });
});
