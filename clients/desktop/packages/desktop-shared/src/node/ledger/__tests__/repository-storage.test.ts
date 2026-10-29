import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type {
  LedgerAddEntryParams,
  LedgerFileRef,
} from '@canopy/protocol/canopy-core';

import { LedgerRepository } from '../repository';
import { LEDGER_SCHEMA_VERSION } from '../schema';
import {
  addInput,
  captureLedgerError,
  createTempDirectory,
  readLedgerDatabase,
  removeTempDirectory,
  setUpLedger,
  unindexedPurgeSteps,
  updateInput,
  withUncheckedFields,
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

/**
 * Turns a closed test database into one a version 2 build left behind: it
 * records version 2 and has no sync bookkeeping.
 */
function makeVersion2Database(databasePath: string): void {
  execRaw(
    databasePath,
    `DROP TABLE IF EXISTS ledger_pending_titles;
    DROP TABLE ledger_scope_sync;
    UPDATE ledger_meta SET value = '2' WHERE key = 'schema_version';`,
  );
}

/** Turns a closed database into the version 3 schema before pending titles. */
function makeVersion3Database(databasePath: string): void {
  execRaw(
    databasePath,
    `DROP TABLE IF EXISTS ledger_pending_titles;
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

function hasScopeSyncTable(raw: DatabaseSync): boolean {
  return (
    raw
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'ledger_scope_sync'",
      )
      .get() !== undefined
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

/**
 * A second process that opens the database the way the storage worker does
 * and holds its exclusive lock for `holdMs` before closing.
 */
const LOCK_HOLDER_SCRIPT = `
const { DatabaseSync } = require('node:sqlite');
const [databasePath, holdMs] = process.argv.slice(1);
const db = new DatabaseSync(databasePath);
db.exec('PRAGMA locking_mode = EXCLUSIVE');
db.exec('PRAGMA journal_mode = WAL');
db.exec('BEGIN IMMEDIATE');
db.exec('COMMIT');
process.stdout.write('locked\\n');
setTimeout(() => { db.close(); process.exit(0); }, Number(holdMs));
`;

function holdLockInChildProcess(
  databasePath: string,
  holdMs: number,
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['-e', LOCK_HOLDER_SCRIPT, databasePath, String(holdMs)],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    child.once('error', reject);
    child.once('exit', (code) => {
      reject(new Error(`Lock holder exited early with ${String(code)}`));
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString('utf8').includes('locked')) resolve(child);
    });
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
  });
}

describe('LedgerRepository storage', () => {
  describe('T08 reference files and validation', () => {
    let context: LedgerTestContext;
    let keyCounter = 0;

    beforeEach(() => {
      context = setUpLedger();
    });

    afterEach(() => {
      context.dispose();
    });

    function addWith(
      params: LedgerAddEntryParams,
    ): ReturnType<LedgerRepository['addEntry']> {
      keyCounter += 1;
      return context.repository.addEntry(
        addInput(context, context.chat, params, `storage-${keyCounter}`),
      );
    }

    it('stores each distinct reference once', () => {
      const referenceFiles: LedgerFileRef[] = [
        { rootId: 'repo', path: 'src/ledger.ts' },
        { rootId: 'repo', path: 'src/ledger.ts' },
        { rootId: 'repo', path: 'src/ledger.ts', startLine: 3 },
        { rootId: 'repo', path: 'src/ledger.ts', startLine: 3 },
        { rootId: 'docs', path: 'src/ledger.ts' },
      ];
      const receipt = addWith({ ...TASK, referenceFiles });
      expect(receipt.entry.referenceFiles).toEqual([
        { rootId: 'repo', path: 'src/ledger.ts' },
        { rootId: 'repo', path: 'src/ledger.ts', startLine: 3 },
        { rootId: 'docs', path: 'src/ledger.ts' },
      ]);
      expect(
        context.repository.getEntry({
          ledgerId: context.ledgerId,
          entryId: receipt.entry.entryId,
        }).entry.referenceFiles,
      ).toEqual(receipt.entry.referenceFiles);
    });

    // Path validation belongs to the protocol schemas, which every caller
    // applies before calling the store; the store re-applies them so an
    // invalid request can never persist, whoever sends it.
    it('rejects absolute, drive, UNC and escaping paths without writing', () => {
      const counts = context.repository.getStorageCounts();
      for (const path of [
        '/etc/passwd',
        'C:/Windows/system.ini',
        'C:\\Windows\\system.ini',
        '\\\\server\\share\\file.txt',
        '//server/share/file.txt',
        '../outside.ts',
        'src/../../outside.ts',
        './src/ledger.ts',
        'src//ledger.ts',
        'src/ledger.ts\u0000',
        '',
      ]) {
        expect(
          captureLedgerError(() =>
            addWith({ ...TASK, referenceFiles: [{ rootId: 'repo', path }] }),
          ),
        ).toMatchObject({
          reason: 'INVALID_INPUT',
          field: 'referenceFiles.0.path',
        });
      }
      expect(context.repository.getStorageCounts()).toEqual(counts);
    });

    it('rejects over-limit, multi-line and unknown fields without writing', () => {
      const counts = context.repository.getStorageCounts();
      const invalid: [LedgerAddEntryParams, string][] = [
        [{ ...TASK, title: 't'.repeat(101) }, 'title'],
        [{ ...TASK, title: 'Line one\nline two' }, 'title'],
        [{ ...TASK, content: 'c'.repeat(1_001) }, 'content'],
        [{ ...TASK, highlights: ['a', 'b', 'c', 'd', 'e', 'f'] }, 'highlights'],
        [withUncheckedFields(TASK, { author: 'someone-else' }), ''],
        [withUncheckedFields(TASK, { createdAt: '2020-01-01T00:00:00Z' }), ''],
      ];
      for (const [params, field] of invalid) {
        const error = captureLedgerError(() => addWith(params));
        expect(error.reason).toBe('INVALID_INPUT');
        if (field !== '') expect(error.field).toBe(field);
      }
      expect(context.repository.getStorageCounts()).toEqual(counts);
    });

    it('rejects inconsistent host context without writing', () => {
      const counts = context.repository.getStorageCounts();
      const base = addInput(context, context.chat, TASK, 'host-context');
      expect(
        captureLedgerError(() =>
          context.repository.addEntry({
            ...base,
            attribution: {
              ...base.attribution,
              effectiveActor: context.otherChat,
            },
          }),
        ),
      ).toMatchObject({
        reason: 'INVALID_INPUT',
        field: 'attribution.effectiveActor',
      });
      expect(
        captureLedgerError(() =>
          context.repository.addEntry({
            ...base,
            origin: {
              kind: 'chat',
              ledgerId: '00000000-0000-4000-8000-00000000ffff',
              chatId: 'chat-1',
            },
          }),
        ),
      ).toMatchObject({ reason: 'INVALID_INPUT', field: 'origin.ledgerId' });
      expect(
        captureLedgerError(() =>
          context.repository.addEntry({ ...base, idempotencyKey: '' }),
        ),
      ).toMatchObject({ reason: 'INVALID_INPUT', field: 'idempotencyKey' });
      expect(context.repository.getStorageCounts()).toEqual(counts);
    });
  });

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

    it('fails with WRITER_UNAVAILABLE while another process holds the database', async () => {
      context.repository.close();
      const before = snapshotFiles(context.databasePath);
      const child = await holdLockInChildProcess(context.databasePath, 10_000);
      try {
        const error = captureLedgerError(() =>
          context.reopen({ openBusyTimeoutMs: 100 }),
        );
        expect(error.reason).toBe('WRITER_UNAVAILABLE');
      } finally {
        child.kill();
        await waitForExit(child);
      }
      expect(snapshotFiles(context.databasePath).db).toEqual(before.db);
      expect(context.reopen().getScope(context.ledgerId)).not.toBeNull();
    }, 30_000);

    it('waits for a quitting process to release the database at open', async () => {
      context.repository.close();
      const child = await holdLockInChildProcess(context.databasePath, 1_000);
      try {
        // The lock is still held: an open that cannot wait fails...
        expect(
          captureLedgerError(() => context.reopen({ openBusyTimeoutMs: 0 }))
            .reason,
        ).toBe('WRITER_UNAVAILABLE');
        // ...and one that can wait succeeds once the holder quits.
        const reopened = context.reopen({ openBusyTimeoutMs: 10_000 });
        expect(reopened.getScope(context.ledgerId)).not.toBeNull();
      } finally {
        child.kill();
        await waitForExit(child);
      }
    }, 30_000);
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
        expect(
          newer.listScopes().map((record) => record.scope.ledgerId),
        ).toEqual([context.ledgerId]);
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
        captureLedgerError(() => LedgerRepository.open({ databasePath }))
          .reason,
      ).toBe('STORAGE_UNAVAILABLE');
      expect(readFileSync(databasePath)).toEqual(garbage);
    });

    it('creates the parent directory and schema on first open', () => {
      const databasePath = join(directory, 'nested', 'ledger', 'ledger.sqlite');
      const repository = LedgerRepository.open({ databasePath });
      try {
        expect(repository.schema).toEqual({ version: 4, readOnly: false });
        expect(repository.schema).toEqual(CURRENT_SCHEMA);
        expect(repository.getStorageCounts()).toEqual({
          scopes: 0,
          actors: 0,
          entries: 0,
          entryVersions: 0,
          mutations: 0,
          receipts: 0,
          outbox: 0,
          searchRows: 0,
        });
      } finally {
        repository.close();
      }
      readLedgerDatabase(databasePath, (raw) => {
        expect(raw.prepare('PRAGMA journal_mode').get()).toEqual({
          journal_mode: 'wal',
        });
        expect(recordedSchemaVersion(raw)).toBe('4');
        expect(mutationActorIndexes(raw)).toEqual(MUTATION_ACTOR_INDEXES);
        expect(hasScopeSyncTable(raw)).toBe(true);
        expect(hasPendingTitlesTable(raw)).toBe(true);
      });
    });

    it.each<[string, boolean]>([
      ['without the mutation indexes', false],
      ['that already has the mutation indexes', true],
    ])(
      'upgrades a version 1 database %s to the current version, keeping its data',
      (_label, keepIndexes) => {
        const context = setUpLedger();
        try {
          const created = context.repository.addEntry(
            addInput(context, context.chat, TASK, 'before-upgrade'),
          );
          const started = context.repository.updateEntry(
            updateInput(
              context,
              context.chat,
              {
                entryId: created.entry.entryId,
                expectedRevision: 1,
                status: 'IN_PROGRESS',
              },
              'start',
            ),
          );
          const counts = context.repository.getStorageCounts();
          const scopes = context.repository.listScopes();
          const authorityId = context.repository.authorityId;
          context.repository.close();
          makeVersion1Database(context.databasePath, keepIndexes);
          readLedgerDatabase(context.databasePath, (raw) => {
            expect(recordedSchemaVersion(raw)).toBe('1');
            expect(mutationActorIndexes(raw)).toEqual(
              keepIndexes ? MUTATION_ACTOR_INDEXES : [],
            );
          });
          if (!keepIndexes) {
            // Without them, a purge scans every scope's mutations.
            expect(
              unindexedPurgeSteps(context.databasePath, context.ledgerId),
            ).toContainEqual(expect.stringContaining('SCAN ledger_mutations'));
          }

          const upgraded = context.reopen();
          expect(upgraded.schema).toEqual(CURRENT_SCHEMA);
          expect(upgraded.authorityId).toBe(authorityId);
          expect(upgraded.getStorageCounts()).toEqual(counts);
          expect(upgraded.listScopes()).toEqual(scopes);
          expect(
            upgraded.getEntry({
              ledgerId: context.ledgerId,
              entryId: created.entry.entryId,
              includeHistory: true,
            }),
          ).toMatchObject({
            entry: started.entry,
            history: { mutations: [{ revision: 1 }, { revision: 2 }] },
          });
          expect(
            upgraded.searchEntries({
              ledgerId: context.ledgerId,
              query: 'referenced',
            }).entries,
          ).toHaveLength(1);
          // Replays still return their receipts, and new writes commit.
          expect(
            upgraded.addEntry(
              addInput(context, context.chat, TASK, 'before-upgrade'),
            ),
          ).toEqual(created);
          expect(
            upgraded.addEntry(
              addInput(context, context.chat, TASK, 'after-upgrade'),
            ).changed,
          ).toBe(true);
          upgraded.close();

          readLedgerDatabase(context.databasePath, (raw) => {
            expect(recordedSchemaVersion(raw)).toBe(
              String(LEDGER_SCHEMA_VERSION),
            );
            expect(mutationActorIndexes(raw)).toEqual(MUTATION_ACTOR_INDEXES);
            expect(hasScopeSyncTable(raw)).toBe(true);
            expect(hasPendingTitlesTable(raw)).toBe(true);
          });
          expect(
            unindexedPurgeSteps(context.databasePath, context.ledgerId),
          ).toEqual([]);
        } finally {
          context.dispose();
        }
      },
    );

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

    it('upgrades a version 2 database to the current schema, with nothing acknowledged yet', () => {
      const context = setUpLedger();
      try {
        const created = context.repository.addEntry(
          addInput(context, context.chat, TASK, 'before-upgrade'),
        );
        const counts = context.repository.getStorageCounts();
        const scopes = context.repository.listScopes();
        context.repository.close();
        makeVersion2Database(context.databasePath);
        readLedgerDatabase(context.databasePath, (raw) => {
          expect(recordedSchemaVersion(raw)).toBe('2');
          expect(hasScopeSyncTable(raw)).toBe(false);
        });

        const upgraded = context.reopen();

        expect(upgraded.schema).toEqual({ version: 4, readOnly: false });
        expect(upgraded.getStorageCounts()).toEqual(counts);
        expect(upgraded.listScopes()).toEqual(scopes);
        // Every event written before the upgrade is still to send.
        expect(upgraded.listSyncScopes()).toEqual([
          {
            scope: scopes[0],
            acknowledgedSequence: '0',
            mirrorAudience: null,
            audienceConfirmedAt: null,
            repairReason: null,
          },
        ]);
        expect(
          upgraded.readOutbox({
            ledgerId: context.ledgerId,
            afterSequence: '0',
            limit: 100,
          }),
        ).toHaveLength(counts.outbox);
        expect(
          upgraded.getEntry({
            ledgerId: context.ledgerId,
            entryId: created.entry.entryId,
          }).syncState,
        ).toBe('pending');
        upgraded.acknowledgeOutbox({
          ledgerId: context.ledgerId,
          sequence: created.localSequence,
        });
        upgraded.close();
        readLedgerDatabase(context.databasePath, (raw) => {
          expect(recordedSchemaVersion(raw)).toBe('4');
          expect(hasScopeSyncTable(raw)).toBe(true);
          expect(hasPendingTitlesTable(raw)).toBe(true);
        });
      } finally {
        context.dispose();
      }
    });

    it('upgrades a version 3 database without changing its entries or receipts', () => {
      const context = setUpLedger();
      try {
        const created = context.repository.addEntry(
          addInput(context, context.chat, TASK, 'version-three-add'),
        );
        const counts = context.repository.getStorageCounts();
        context.repository.close();
        makeVersion3Database(context.databasePath);
        readLedgerDatabase(context.databasePath, (raw) => {
          expect(recordedSchemaVersion(raw)).toBe('3');
          expect(hasPendingTitlesTable(raw)).toBe(false);
        });

        const upgraded = context.reopen();
        expect(upgraded.schema).toEqual({ version: 4, readOnly: false });
        expect(upgraded.getStorageCounts()).toEqual(counts);
        expect(upgraded.listPendingTitles()).toEqual([]);
        expect(
          upgraded.addEntry(
            addInput(context, context.chat, TASK, 'version-three-add'),
          ),
        ).toEqual(created);
        upgraded.close();
        readLedgerDatabase(context.databasePath, (raw) => {
          expect(recordedSchemaVersion(raw)).toBe('4');
          expect(hasPendingTitlesTable(raw)).toBe(true);
        });
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
        expect(upgraded.schema).toEqual({ version: 4, readOnly: false });
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

    it('fails closed when the writer authority is missing', () => {
      const databasePath = join(directory, 'ledger.sqlite');
      LedgerRepository.open({ databasePath }).close();
      const raw = new DatabaseSync(databasePath);
      try {
        raw.prepare("DELETE FROM ledger_meta WHERE key = 'authority_id'").run();
      } finally {
        raw.close();
      }
      expect(
        captureLedgerError(() => LedgerRepository.open({ databasePath })),
      ).toMatchObject({
        reason: 'STORAGE_UNAVAILABLE',
        diagnosticCode: 'authority_id',
      });
    });

    it('rejects an invalid open busy timeout', () => {
      expect(
        captureLedgerError(() =>
          LedgerRepository.open({
            databasePath: join(directory, 'ledger.sqlite'),
            openBusyTimeoutMs: -1,
          }),
        ),
      ).toMatchObject({ reason: 'INVALID_INPUT', field: 'openBusyTimeoutMs' });
      expect(existsSync(join(directory, 'ledger.sqlite'))).toBe(false);
    });
  });
});
