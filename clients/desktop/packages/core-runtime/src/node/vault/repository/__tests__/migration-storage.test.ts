import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
import {
  type MigrationAttempt,
  decodeMigrationJournal,
  encodeMigrationJournal,
} from '../migration-codec';
import { withVaultSubkey, disposeVaultSubkeys } from '../vault-keys';
import {
  VAULT_STORE_SCHEMA,
  VAULT_STORE_SCHEMA_VERSION,
} from '../store-schema';
import { VAULT_STORE_FILE } from '../store';
import { sealVaultSecret } from '../sealed-secret';
import {
  pruneExpiredTombstones,
  VAULT_TOMBSTONE_RETENTION_MS,
} from '../reconciliation';
import type { VaultStore, VaultStoreFaults } from '../store';
import {
  storeFolder,
  writeTestHeader,
  type StoreFolder,
} from './store-fixtures';
import {
  importRequest,
  migrationFixture,
  type MigrationFixture,
  migrationIdentity,
} from './migration-fixtures';

let dir: StoreFolder;
let store: VaultStore;
beforeEach(async () => {
  dir = storeFolder();
  store = await dir.opened();
  writeTestHeader(store);
});
afterEach(() => {
  store.close();
  dir.remove();
});
async function reopened(faults?: VaultStoreFaults): Promise<MigrationFixture> {
  store.close();
  store = await dir.opened(faults);
  return migrationFixture(store);
}
async function imported(): Promise<
  MigrationFixture & {
    readonly attempt: MigrationAttempt;
    readonly resolved: Extract<
      ReturnType<MigrationFixture['migration']['resolve']>,
      { kind: 'committed' }
    >;
  }
> {
  const fixture = migrationFixture(store);
  const attempt = fixture.migration.prepare(migrationIdentity, 1);
  const put = await fixture.writer.put(
    importRequest(fixture.migration.importKey(attempt.id)),
  );
  expect(put.kind).toBe('committed');
  const resolved = fixture.migration.reconcile(attempt.id, 1);
  if (resolved.kind !== 'committed') throw new Error('Import not resolved.');
  return { ...fixture, attempt, resolved };
}
function editDatabase(edit: (db: DatabaseSync) => void): void {
  store.close();
  const db = new DatabaseSync(join(dir.folder, VAULT_STORE_FILE));
  try {
    edit(db);
  } finally {
    db.close();
  }
}

describe('Copilot P1 durable migration persistence contract (inert)', () => {
  it('fresh and reopened recovery advances only committed lineage/use/delete receipts, preserving GitHub', async () => {
    const github = await migrationFixture(store).github.put({
      ...importRequest('copilot-migration:unrelated-github-key'),
      family: 'github-pat',
    });
    expect(github.kind).toBe('committed');
    const before = store
      .listEntries()
      .filter((entry) => entry.family === 'github-pat');
    const { attempt, resolved } = await imported();
    expect(store.readMigrationJournal()).not.toContain('credential-sentinel');
    let { migration } = await reopened();
    expect(migration.read().attempts[0]?.state).toBe('imported_unverified');
    migration.select(attempt.id, 1);
    migration.recordUse(attempt.id, 1, {
      id: 'use',
      pin: resolved.pin,
      successorKeys: [],
    });
    migration = (await reopened()).migration;
    expect(migration.read().attempts[0]?.state).toBe('verified');
    migration.authorizeDeletion(attempt.id, 1, 'delete');
    migration.deletionReceipt(
      attempt.id,
      1,
      'delete',
      migrationIdentity.generation,
      null,
    );
    migration = (await reopened()).migration;
    expect(migration.read().attempts[0]?.deletion?.phase).toBe('submitted');
    migration.deletionReceipt(
      attempt.id,
      1,
      'delete',
      migrationIdentity.generation,
      'durable-source-completion',
    );
    migration = (await reopened()).migration;
    expect(migration.read().attempts[0]?.state).toBe('legacy_deleted');
    expect(migration.resolve(attempt.id)).toEqual(resolved);
    expect(
      store.listEntries().filter((entry) => entry.family === 'github-pat'),
    ).toEqual(before);
    migration.supersede(2, 'sign-out');
    expect(() => migration.prepare(migrationIdentity, 2)).toThrow();
    expect(() => migration.select(attempt.id, 1)).toThrow();
  });

  it.each([
    'prepare',
    'intent',
    'entry',
    'progress',
    'selection',
    'use',
    'authorization',
    'submission',
    'completion',
  ])(
    'recovers an actual process death after %s COMMIT without a close/checkpoint or caller result',
    async (boundary) => {
      store.close();
      const child = spawnSync(
        process.execPath,
        [
          '--disable-warning=ExperimentalWarning',
          '--import',
          'tsx',
          join(__dirname, 'migration-crash.fixture.ts'),
          dir.folder,
          boundary,
        ],
        { encoding: 'utf8', timeout: 60_000 },
      );
      expect(child.stderr).toBe('');
      expect(child.signal).toBe('SIGKILL');
      store = await dir.opened();
      const { migration } = migrationFixture(store);
      const attempt = migration.read().attempts[0];
      if (!attempt) throw new Error('Attempt was lost.');
      const result = migration.resolve(attempt.id);
      expect(result.kind).toBe(
        boundary === 'prepare'
          ? 'not_accepted'
          : boundary === 'intent'
            ? 'not_committed'
            : 'committed',
      );
      expect(migration.read().head.authority).toBe(
        ['prepare', 'intent', 'entry', 'progress'].includes(boundary)
          ? 'fenced'
          : 'vault',
      );
      expect(attempt.state).toBe(
        ['prepare', 'intent', 'entry'].includes(boundary)
          ? 'not_started'
          : ['progress', 'selection'].includes(boundary)
            ? 'imported_unverified'
            : boundary === 'completion'
              ? 'legacy_deleted'
              : 'verified',
      );
      migration.reconcile(attempt.id, 1);
      if (!['prepare', 'intent'].includes(boundary))
        expect(migration.read().attempts[0]?.destination?.entryId).toBe(
          store.listEntries()[0]?.entryId,
        );
    },
    70_000,
  );

  it.each(['beforeWrite', 'beforeSync', 'sync-before', 'sync-after'])(
    'never falsely advances at every write under %s faults',
    async (fault) => {
      for (let boundary = 1; boundary <= 9; boundary += 1) {
        // Each case uses its own generation/store, including intent and receipt uncertainty.
        store.close();
        dir.remove();
        dir = storeFolder();
        store = await dir.opened();
        writeTestHeader(store);
        let writes = 0;
        const fail = (): never => {
          throw new Error('injected crash');
        };
        const faults: VaultStoreFaults =
          fault === 'beforeWrite'
            ? {
                beforeWrite() {
                  if (++writes === boundary) fail();
                },
              }
            : fault === 'beforeSync'
              ? {
                  beforeSync() {
                    if (++writes === boundary) fail();
                  },
                }
              : {
                  sync(commit) {
                    const target = ++writes === boundary;
                    if (target && fault === 'sync-before') fail();
                    commit();
                    if (target) fail();
                  },
                };
        const fixture = await reopened(faults);
        let id: string | undefined;
        try {
          id = fixture.migration.prepare(migrationIdentity, 1).id;
          await fixture.writer.put(
            importRequest(fixture.migration.importKey(id)),
          );
          const result = fixture.migration.reconcile(id, 1);
          if (result.kind !== 'committed') throw new Error('No commit.');
          fixture.migration.select(id, 1);
          fixture.migration.recordUse(id, 1, {
            id: 'use',
            pin: result.pin,
            successorKeys: [],
          });
          fixture.migration.authorizeDeletion(id, 1, 'delete');
          fixture.migration.deletionReceipt(
            id,
            1,
            'delete',
            migrationIdentity.generation,
            null,
          );
          fixture.migration.deletionReceipt(
            id,
            1,
            'delete',
            migrationIdentity.generation,
            'completion',
          );
        } catch {
          /* The reopened records, not the lost result, decide recovery. */
        }
        const recovered = await reopened();
        const record = recovered.migration.read().attempts[0];
        if (!record) {
          expect(boundary).toBe(1);
          expect(store.listIntents()).toHaveLength(0);
          continue;
        }
        const result = recovered.migration.resolve(record.id);
        const landed = fault === 'sync-after' ? boundary : boundary - 1;
        expect(record.state).toBe(
          landed < 4
            ? 'not_started'
            : landed < 6
              ? 'imported_unverified'
              : landed < 9
                ? 'verified'
                : 'legacy_deleted',
        );
        expect(result.kind).toBe(
          landed < 2
            ? 'not_accepted'
            : landed < 3
              ? 'not_committed'
              : 'committed',
        );
      }
    },
  );

  it('retries only the accepted intent and recovers the minted ref without another create', async () => {
    let hold = true;
    const fixture = migrationFixture(store, {
      holdPut: () =>
        hold
          ? Promise.reject(new Error('crash after intent'))
          : Promise.resolve(),
    });
    const attempt = fixture.migration.prepare(migrationIdentity, 1);
    await fixture.writer.put(
      importRequest(fixture.migration.importKey(attempt.id)),
    );
    const pending = fixture.migration.resolve(attempt.id);
    expect(pending.kind).toBe('not_committed');
    const recovered = await reopened();
    hold = false;
    const put = await recovered.writer.put(
      importRequest(recovered.migration.importKey(attempt.id)),
    );
    expect(put.kind).toBe('committed');
    const resolved = recovered.migration.reconcile(attempt.id, 1);
    if (resolved.kind !== 'committed' || pending.kind !== 'not_committed')
      throw new Error('Wrong outcome.');
    expect(resolved.pin.ref.entryId).toBe(pending.entryId);
    expect(store.listIntents()).toHaveLength(1);
  });

  it('keeps a reopened pending-intent retry unresolved until that retry settles', async () => {
    const fixture = migrationFixture(store, {
      holdPut: () => Promise.reject(new Error('interrupted')),
    });
    const attempt = fixture.migration.prepare(migrationIdentity, 1);
    await fixture.writer.put(
      importRequest(fixture.migration.importKey(attempt.id)),
    );
    await reopened();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const retry = migrationFixture(store, { holdPut: () => held });
    expect(retry.migration.resolve(attempt.id).kind).toBe('not_committed');
    const pending = retry.writer.put(
      importRequest(retry.migration.importKey(attempt.id)),
    );
    expect(retry.migration.resolve(attempt.id)).toEqual({ kind: 'unresolved' });
    release();
    await pending;
    expect(retry.migration.reconcile(attempt.id, 1).kind).toBe('committed');
    expect(store.listIntents()).toHaveLength(1);
  });

  it.each(
    ['original', 'fresh', 'reopened', 'pruned-reopened'].flatMap((reader) =>
      ['create', 'replace'].flatMap((operation) => [
        { reader, operation, interruptedDelete: false },
        { reader, operation, interruptedDelete: true },
      ]),
    ),
  )(
    'admits a new generation after committed retirement ($reader, $operation, interruptedDelete=$interruptedDelete)',
    async ({ reader, operation, interruptedDelete }) => {
      let interruptPut = operation === 'create';
      let interruptDelete = interruptedDelete;
      const fixture = migrationFixture(store, {
        holdPut: () =>
          interruptPut
            ? Promise.reject(new Error('interrupted import'))
            : Promise.resolve(),
        holdDelete: () =>
          interruptDelete
            ? Promise.reject(new Error('interrupted delete'))
            : Promise.resolve(),
      });
      const attempt = fixture.migration.prepare(migrationIdentity, 1);
      const create = importRequest(fixture.migration.importKey(attempt.id));
      const imported = await fixture.writer.put(create);
      const ref =
        imported.kind === 'committed'
          ? imported.pin.ref
          : imported.kind === 'unavailable'
            ? imported.ref
            : null;
      if (ref === null) throw new Error('No accepted import.');
      const request =
        operation === 'create'
          ? create
          : {
              ref,
              expectedRevision: 0,
              idempotencyKey: 'interrupted-replacement',
              label: 'Copilot replacement',
              expiresAt: null,
              material: new TextEncoder().encode('replacement-sentinel'),
            };
      if (operation === 'replace') {
        expect(fixture.migration.reconcile(attempt.id, 1).kind).toBe(
          'committed',
        );
        interruptPut = true;
        expect((await fixture.writer.put(request)).kind).toBe('unavailable');
      } else expect(imported.kind).toBe('unavailable');
      const pendingIntent = store.findIntent(
        'copilot-account',
        request.idempotencyKey,
      );
      if (pendingIntent?.state !== 'pending')
        throw new Error('No stopped put.');
      const fields = {
        entryId: ref.entryId,
        family: 'copilot-account',
        revision: operation === 'create' ? 0 : 1,
        label: request.label,
        expiresAt: request.expiresAt,
      };
      const draft = {
        ...fields,
        sealed: sealVaultSecret(
          fixture.keys,
          { vaultId: ref.vaultId, ...fields },
          request.material,
        ),
      };
      const deletion = {
        ref,
        expectedRevision: 0,
        idempotencyKey: 'retire-import',
      };
      if (interruptedDelete) {
        expect((await fixture.writer.delete(deletion)).kind).toBe(
          'unavailable',
        );
        interruptDelete = false;
      }
      expect(
        (
          await fixture.writer.delete({
            ...deletion,
            idempotencyKey: 'committed-delete',
          })
        ).kind,
      ).toBe('committed');
      fixture.migration.supersede(2, 'user-clear');
      const retiredIntents = store.listIntents();
      expect(
        retiredIntents.filter((item) => item.state === 'pending'),
      ).toHaveLength(interruptedDelete ? 2 : 1);
      if (reader === 'pruned-reopened') {
        const tombstone = store.readTombstone(ref.entryId);
        if (!tombstone) throw new Error('No committed tombstone.');
        const expiry =
          Date.parse(tombstone.committedAt) + VAULT_TOMBSTONE_RETENTION_MS;
        expect(pruneExpiredTombstones(store, new Date(expiry - 1))).toEqual([]);
        expect(store.readTombstone(ref.entryId)).toEqual(tombstone);
        expect(store.commitEntry(pendingIntent.sequence, draft).kind).toBe(
          'not_written',
        );
        expect(pruneExpiredTombstones(store, new Date(expiry))).toEqual([
          ref.entryId,
        ]);
        expect(store.listTombstones()).toHaveLength(0);
        expect(store.listIntents()).toEqual(retiredIntents);
      }
      interruptPut = false;
      const recovered = reader.includes('reopened')
        ? await reopened()
        : reader === 'fresh'
          ? migrationFixture(store)
          : fixture;
      expect(store.listEntries()).toHaveLength(0);
      // Exercise the store guard too: keyed replay must not be the only fence.
      expect(store.commitEntry(pendingIntent.sequence, draft).kind).toBe(
        'not_written',
      );
      expect(await recovered.writer.put(request)).toEqual({
        kind: 'superseded',
        ref,
      });
      expect(
        (
          await recovered.writer.delete({
            ...deletion,
            idempotencyKey: 'committed-delete',
          })
        ).kind,
      ).toBe('committed');
      if (interruptedDelete) {
        expect((await recovered.writer.delete(deletion)).kind).toBe(
          'superseded',
        );
        const pendingDelete = store.findIntent(
          'copilot-account',
          deletion.idempotencyKey,
        );
        if (pendingDelete?.state !== 'pending')
          throw new Error('No stopped delete.');
        expect(store.commitTombstone(pendingDelete.sequence, 1).kind).toBe(
          'not_written',
        );
      }
      expect(store.listEntries()).toHaveLength(0);
      const next = recovered.migration.prepare(
        { ...migrationIdentity, generation: 'generation-2' },
        2,
      );
      const put = await recovered.writer.put(
        importRequest(recovered.migration.importKey(next.id)),
      );
      expect(put.kind).toBe('committed');
      expect(recovered.migration.reconcile(next.id, 2).kind).toBe('committed');
      expect(recovered.migration.resolve(attempt.id)).toEqual({
        kind: 'retired',
      });
      expect(await recovered.writer.put(request)).toEqual({
        kind: 'superseded',
        ref: deletion.ref,
      });
      expect(store.listIntents().slice(0, retiredIntents.length)).toEqual(
        retiredIntents,
      );
      expect((await reopened()).migration.reconcile(next.id, 2).kind).toBe(
        'committed',
      );
    },
  );

  it.each(['create', 'replace'] as const)(
    'cannot revive a retired %s through a stopped stale writer after retention',
    async (operation) => {
      let interrupted = operation === 'create';
      const cached = migrationFixture(store, {
        holdPut: () =>
          interrupted
            ? Promise.reject(new Error('interrupted put'))
            : Promise.resolve(),
      });
      const attempt = cached.migration.prepare(migrationIdentity, 1);
      const create = importRequest(cached.migration.importKey(attempt.id));
      const imported = await cached.writer.put(create);
      const ref =
        imported.kind === 'committed'
          ? imported.pin.ref
          : imported.kind === 'unavailable'
            ? imported.ref
            : null;
      if (ref === null) throw new Error('No accepted import.');
      const request =
        operation === 'create'
          ? create
          : {
              ref,
              expectedRevision: 0,
              idempotencyKey: 'stopped-replacement',
              label: 'Copilot',
              expiresAt: null,
              material: new TextEncoder().encode('replacement-sentinel'),
            };
      if (operation === 'replace') {
        interrupted = true;
        expect((await cached.writer.put(request)).kind).toBe('unavailable');
      } else expect(imported.kind).toBe('unavailable');
      const fresh = migrationFixture(store);
      expect(
        (
          await fresh.writer.delete({
            ref,
            expectedRevision: 0,
            idempotencyKey: 'retire-stale-writer',
          })
        ).kind,
      ).toBe('committed');
      const tombstone = store.readTombstone(ref.entryId);
      if (!tombstone) throw new Error('No tombstone.');
      const retiredIntents = store.listIntents();
      const expiry =
        Date.parse(tombstone.committedAt) + VAULT_TOMBSTONE_RETENTION_MS;
      expect(pruneExpiredTombstones(store, new Date(expiry))).toEqual([
        ref.entryId,
      ]);
      cached.migration.supersede(2, 'user-clear');
      interrupted = false;
      // This writer never observed the delete; retry reaches commitEntry.
      expect(await cached.writer.put(request)).toEqual({
        kind: 'unavailable',
        ref,
      });
      expect(store.listEntries()).toHaveLength(0);
      const next = fresh.migration.prepare(
        { ...migrationIdentity, generation: 'generation-2' },
        2,
      );
      expect(
        (
          await fresh.writer.put(
            importRequest(fresh.migration.importKey(next.id)),
          )
        ).kind,
      ).toBe('committed');
      expect(await cached.writer.put(request)).toEqual({
        kind: 'unavailable',
        ref,
      });
      expect(store.readEntry(ref.entryId)).toBeNull();
      expect(store.listIntents().slice(0, retiredIntents.length)).toEqual(
        retiredIntents,
      );
      const recovered = await reopened();
      expect(await recovered.writer.put(request)).toEqual({
        kind: 'superseded',
        ref,
      });
      expect(recovered.migration.reconcile(next.id, 2).kind).toBe('committed');
    },
  );

  it('keeps a retired import fenced until its running writer stops', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = migrationFixture(store, { holdPut: () => held });
    const attempt = fixture.migration.prepare(migrationIdentity, 1);
    const pending = fixture.writer.put(
      importRequest(fixture.migration.importKey(attempt.id)),
    );
    const intent = store.listIntents()[0];
    if (!intent) throw new Error('No intent.');
    try {
      expect(
        (
          await fixture.writer.delete({
            ref: { vaultId: fixture.keys.vaultId, entryId: intent.entryId },
            expectedRevision: 0,
            idempotencyKey: 'retire-running-import',
          })
        ).kind,
      ).toBe('committed');
      fixture.migration.supersede(2, 'user-clear');
      expect(store.listEntries()).toHaveLength(0);
      for (const migration of [
        fixture.migration,
        migrationFixture(store).migration,
      ]) {
        expect(() =>
          migration.prepare(
            { ...migrationIdentity, generation: 'generation-2' },
            2,
          ),
        ).toThrow('Migration destination is not empty.');
      }
    } finally {
      release();
      expect((await pending).kind).toBe('superseded');
    }
    const recovered = migrationFixture(store);
    const next = recovered.migration.prepare(
      { ...migrationIdentity, generation: 'generation-2' },
      2,
    );
    expect(
      (
        await recovered.writer.put(
          importRequest(recovered.migration.importKey(next.id)),
        )
      ).kind,
    ).toBe('committed');
  });

  it.each(
    (['put', 'delete'] as const).flatMap((kind) => [
      { kind, retiredEntry: false },
      { kind, retiredEntry: true },
    ]),
  )(
    'keeps a stopped pending $kind fenced at both admission seams (retiredEntry=$retiredEntry)',
    async ({ kind, retiredEntry }) => {
      if (retiredEntry) {
        const previous = migrationFixture(store, {
          holdPut: () => Promise.reject(new Error('interrupted import')),
        });
        const attempt = previous.migration.prepare(migrationIdentity, 1);
        const pending = await previous.writer.put(
          importRequest(previous.migration.importKey(attempt.id)),
        );
        if (pending.kind !== 'unavailable')
          throw new Error('No stopped import.');
        expect(
          (
            await previous.writer.delete({
              ref: pending.ref,
              expectedRevision: 0,
              idempotencyKey: 'retire-other-entry',
            })
          ).kind,
        ).toBe('committed');
        previous.migration.supersede(2, 'user-clear');
      }
      const fixture = migrationFixture(store);
      const epoch = retiredEntry ? 2 : 1;
      const attempt = fixture.migration.prepare(
        { ...migrationIdentity, generation: 'admission-generation' },
        epoch,
      );
      // Retirement of one entry must never clear another entry's live fence.
      const before = store.listIntents();
      // A durable intent accepted between prepare and import, with no committed row.
      const pending = store.recordIntent({
        kind,
        family: 'copilot-account',
        entryId: 'unresolved-entry',
        idempotencyKey: 'unresolved-key',
        expectedRevision: kind === 'put' ? null : 0,
        receipt: new Uint8Array(32),
      });
      expect(pending.kind).toBe('written');
      const journal = store.readMigrationJournal();
      const put = await fixture.writer.put(
        importRequest(fixture.migration.importKey(attempt.id)),
      );
      expect(put.kind).toBe('refused');
      expect(store.readMigrationJournal()).toBe(journal);
      expect(store.listIntents()).toHaveLength(before.length + 1);
      fixture.migration.supersede(epoch + 1, 'user-clear');
      for (const migration of [
        fixture.migration,
        migrationFixture(store).migration,
      ]) {
        expect(() =>
          migration.prepare(
            { ...migrationIdentity, generation: 'blocked-generation' },
            epoch + 1,
          ),
        ).toThrow('Migration destination is not empty.');
      }
      const recovered = await reopened();
      expect(() =>
        recovered.migration.prepare(
          { ...migrationIdentity, generation: 'blocked-generation' },
          epoch + 1,
        ),
      ).toThrow('Migration destination is not empty.');
    },
  );

  it('atomically refuses import while a retired put is still running', async () => {
    const fixture = migrationFixture(store);
    const attempt = fixture.migration.prepare(migrationIdentity, 1);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const other = migrationFixture(store, { holdPut: () => held });
    const pending = other.writer.put(importRequest('concurrent-create'));
    const intent = store.listIntents()[0];
    if (!intent) throw new Error('No concurrent intent.');
    try {
      expect(
        (
          await other.writer.delete({
            ref: { vaultId: fixture.keys.vaultId, entryId: intent.entryId },
            expectedRevision: 0,
            idempotencyKey: 'retire-concurrent-create',
          })
        ).kind,
      ).toBe('committed');
      const journal = store.readMigrationJournal();
      expect(
        (
          await fixture.writer.put(
            importRequest(fixture.migration.importKey(attempt.id)),
          )
        ).kind,
      ).toBe('refused');
      expect(store.readMigrationJournal()).toBe(journal);
      expect(store.listIntents()).toHaveLength(2);
    } finally {
      release();
      expect((await pending).kind).toBe('superseded');
    }
    expect(
      (
        await fixture.writer.put(
          importRequest(fixture.migration.importKey(attempt.id)),
        )
      ).kind,
    ).toBe('committed');
  });

  it('keeps concurrent retries fenced until every runner of the same intent stops', async () => {
    let interrupt: () => void = () => undefined;
    let release: () => void = () => undefined;
    const interrupted = new Promise<void>((_resolve, reject) => {
      interrupt = (): void => reject(new Error('interrupted runner'));
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = migrationFixture(store, { holdPut: () => interrupted });
    const attempt = first.migration.prepare(migrationIdentity, 1);
    const key = first.migration.importKey(attempt.id);
    const pending1 = first.writer.put(importRequest(key));
    const second = migrationFixture(store, { holdPut: () => held });
    const pending2 = second.writer.put(importRequest(key));
    try {
      interrupt();
      await pending1;
      expect(first.migration.resolve(attempt.id)).toEqual({
        kind: 'unresolved',
      });
      expect(first.migration.reconcile(attempt.id, 1)).toEqual({
        kind: 'unresolved',
      });
    } finally {
      release();
      await pending2;
    }
    expect(first.migration.reconcile(attempt.id, 1).kind).toBe('committed');
    expect(store.listIntents()).toHaveLength(1);
    expect((await reopened()).migration.resolve(attempt.id).kind).toBe(
      'committed',
    );
  });

  it.each([0, 1])(
    'recovers a committed replacement past an unavailable intent at revision %s, fresh and reopened',
    async (baseRevision) => {
      const { migration, writer, attempt, resolved } = await imported();
      const successorKeys: string[] = [];
      const request = {
        ref: resolved.pin.ref,
        expectedRevision: baseRevision,
        idempotencyKey: 'unavailable-A',
        material: new Uint8Array([8]),
        label: 'Copilot',
        expiresAt: null,
      };
      if (baseRevision === 1) {
        expect(
          (
            await writer.put({
              ...request,
              expectedRevision: 0,
              idempotencyKey: 'first-rotation',
            })
          ).kind,
        ).toBe('committed');
        successorKeys.push('first-rotation');
      }
      let interrupt = true;
      const replacements = migrationFixture(store, {
        holdPut: () => {
          if (!interrupt) return Promise.resolve();
          interrupt = false;
          return Promise.reject(new Error('interrupted replacement'));
        },
      });
      expect((await replacements.writer.put(request)).kind).toBe('unavailable');
      expect(migration.resolve(attempt.id)).toEqual({ kind: 'unresolved' });
      const replacement = await replacements.writer.put({
        ...request,
        idempotencyKey: 'committed-B',
      });
      if (replacement.kind !== 'committed')
        throw new Error('Replacement not committed.');
      successorKeys.push('committed-B');
      const expected = {
        kind: 'committed',
        pin: replacement.pin,
        successorKeys,
      };
      expect(migration.resolve(attempt.id)).toEqual(expected);
      expect(migrationFixture(store).migration.resolve(attempt.id)).toEqual(
        expected,
      );
      expect(await replacements.writer.put(request)).toEqual({
        kind: 'revision_conflict',
        currentRevision: baseRevision + 1,
      });
      const recovered = await reopened();
      expect(recovered.migration.resolve(attempt.id)).toEqual(expected);
      expect(await recovered.writer.put(request)).toEqual({
        kind: 'revision_conflict',
        currentRevision: baseRevision + 1,
      });
      expect(recovered.migration.reconcile(attempt.id, 1)).toEqual(expected);
      recovered.migration.select(attempt.id, 1);
      recovered.migration.recordUse(attempt.id, 1, {
        id: 'replacement-use',
        pin: replacement.pin,
        successorKeys,
      });
      recovered.migration.authorizeDeletion(attempt.id, 1, 'delete');
      expect(
        (await reopened()).migration.read().attempts[0]?.deletion?.phase,
      ).toBe('authorized');
    },
  );

  it('does not let a superseded intent hide a newer pending replacement', async () => {
    const { migration, attempt, resolved } = await imported();
    migration.select(attempt.id, 1);
    let interrupt = true;
    const replacements = migrationFixture(store, {
      holdPut: () =>
        interrupt
          ? Promise.reject(new Error('interrupted replacement'))
          : Promise.resolve(),
    });
    const request = {
      ref: resolved.pin.ref,
      expectedRevision: 0,
      idempotencyKey: 'unavailable-A',
      material: new Uint8Array([8]),
      label: 'Copilot',
      expiresAt: null,
    };
    expect((await replacements.writer.put(request)).kind).toBe('unavailable');
    interrupt = false;
    const committed = await replacements.writer.put({
      ...request,
      idempotencyKey: 'committed-B',
    });
    if (committed.kind !== 'committed') throw new Error('No replacement.');
    interrupt = true;
    const pending = {
      ...request,
      expectedRevision: 1,
      idempotencyKey: 'unavailable-C',
    };
    expect((await replacements.writer.put(pending)).kind).toBe('unavailable');
    expect(migration.resolve(attempt.id)).toEqual({ kind: 'unresolved' });
    expect(migrationFixture(store).migration.resolve(attempt.id)).toEqual({
      kind: 'unresolved',
    });
    const recovered = await reopened();
    expect(recovered.migration.resolve(attempt.id)).toEqual({
      kind: 'unresolved',
    });
    expect(() =>
      recovered.migration.recordUse(attempt.id, 1, {
        id: 'premature-use',
        pin: committed.pin,
        successorKeys: ['committed-B'],
      }),
    ).toThrow();
    const retry = await recovered.writer.put(pending);
    if (retry.kind !== 'committed') throw new Error('Retry not committed.');
    expect((await reopened()).migration.resolve(attempt.id)).toEqual({
      kind: 'committed',
      pin: retry.pin,
      successorKeys: ['committed-B', 'unavailable-C'],
    });
  });

  it.each(
    [
      'missing-edge',
      'wrong-base',
      'wrong-outcome',
      'wrong-family',
      'bad-ciphertext',
    ].flatMap((damage) => [
      { damage, verified: false },
      { damage, verified: true },
    ]),
  )(
    'refuses supersession with $damage (verified=$verified)',
    async ({ damage, verified }) => {
      const { migration, attempt, resolved, writer } = await imported();
      migration.select(attempt.id, 1);
      const request = {
        ref: resolved.pin.ref,
        expectedRevision: 0,
        idempotencyKey: 'unavailable-A',
        material: new Uint8Array([8]),
        label: 'Copilot',
        expiresAt: null,
      };
      expect(
        (
          await migrationFixture(store, {
            holdPut: () => Promise.reject(new Error('interrupted')),
          }).writer.put(request)
        ).kind,
      ).toBe('unavailable');
      const committed = await writer.put({
        ...request,
        idempotencyKey: 'committed-B',
      });
      if (committed.kind !== 'committed') throw new Error('No replacement.');
      const use = {
        id: 'committed-use',
        pin: committed.pin,
        successorKeys: ['committed-B'],
      };
      if (verified) migration.recordUse(attempt.id, 1, use);
      editDatabase((db) => {
        const key = Buffer.from('committed-B');
        if (damage === 'missing-edge')
          db.prepare('DELETE FROM vault_intents WHERE idempotency_key = ?').run(
            key,
          );
        if (damage === 'wrong-base')
          db.prepare(
            'UPDATE vault_intents SET expected_revision = 1 WHERE idempotency_key = ?',
          ).run(key);
        if (damage === 'wrong-outcome')
          db.prepare(
            'UPDATE vault_intents SET outcome_revision = 2 WHERE idempotency_key = ?',
          ).run(key);
        if (damage === 'wrong-family')
          db.prepare(
            "UPDATE vault_intents SET family = 'github-pat' WHERE idempotency_key = ?",
          ).run(key);
        if (damage === 'bad-ciphertext')
          db.exec('UPDATE vault_entries SET tag = zeroblob(16)');
      });
      const recovered = await reopened();
      expect(() => recovered.migration.resolve(attempt.id)).toThrow();
      if (verified) {
        expect(() =>
          recovered.migration.authorizeDeletion(attempt.id, 1, 'delete'),
        ).toThrow();
      } else {
        expect(() =>
          recovered.migration.recordUse(attempt.id, 1, use),
        ).toThrow();
      }
      expect(recovered.migration.read().attempts[0]?.deletion).toBeNull();
      expect(recovered.migration.read().attempts[0]?.state).toBe(
        verified ? 'verified' : 'imported_unverified',
      );
    },
  );

  it('keeps a superseded replacement fenced while its runner can still settle', async () => {
    const { migration, writer, attempt, resolved } = await imported();
    let interrupt: () => void = () => undefined;
    const held = new Promise<void>((_resolve, reject) => {
      interrupt = (): void => reject(new Error('interrupted replacement'));
    });
    const request = {
      ref: resolved.pin.ref,
      expectedRevision: 0,
      idempotencyKey: 'running-A',
      material: new Uint8Array([8]),
      label: 'Copilot',
      expiresAt: null,
    };
    const running = migrationFixture(store, { holdPut: () => held }).writer.put(
      request,
    );
    try {
      expect(
        (await writer.put({ ...request, idempotencyKey: 'committed-B' })).kind,
      ).toBe('committed');
      expect(migration.resolve(attempt.id)).toEqual({ kind: 'unresolved' });
      expect(migrationFixture(store).migration.resolve(attempt.id)).toEqual({
        kind: 'unresolved',
      });
    } finally {
      interrupt();
      expect((await running).kind).toBe('unavailable');
    }
    const expected = {
      kind: 'committed',
      pin: { ref: resolved.pin.ref, revision: 1 },
      successorKeys: ['committed-B'],
    };
    expect(migration.resolve(attempt.id)).toEqual(expected);
    expect((await reopened()).migration.resolve(attempt.id)).toEqual(expected);
  });

  it('requires successor provenance, rejects unsaved successors and never treats receipt failure as verification', async () => {
    const { migration, writer, attempt, resolved } = await imported();
    migration.select(attempt.id, 1);
    const put = await writer.put({
      ref: resolved.pin.ref,
      expectedRevision: 0,
      idempotencyKey: 'rotation',
      material: new TextEncoder().encode('successor-sentinel'),
      label: 'Copilot',
      expiresAt: null,
    });
    expect(put.kind).toBe('committed');
    const current = migration.resolve(attempt.id);
    if (current.kind !== 'committed') throw new Error('Missing successor.');
    expect(() =>
      migration.recordUse(attempt.id, 1, {
        id: 'old-use',
        pin: resolved.pin,
        successorKeys: [],
      }),
    ).toThrow();
    expect(() =>
      migration.recordUse(attempt.id, 1, {
        id: 'bad-use',
        pin: current.pin,
        successorKeys: [],
      }),
    ).toThrow();
    migration.recordUse(attempt.id, 1, {
      id: 'new-use',
      pin: current.pin,
      successorKeys: ['rotation'],
    });
    expect(migration.read().attempts[0]?.state).toBe('verified');
  });

  it('keeps cancelled late import/use/delete results from a newer account epoch', async () => {
    const { migration, attempt, resolved } = await imported();
    migration.select(attempt.id, 1);
    migration.recordUse(attempt.id, 1, {
      id: 'use',
      pin: resolved.pin,
      successorKeys: [],
    });
    migration.authorizeDeletion(attempt.id, 1, 'delete');
    migration.deletionReceipt(
      attempt.id,
      1,
      'delete',
      migrationIdentity.generation,
      null,
    );
    migration.supersede(2, 'user-clear');
    const recovered = (await reopened()).migration;
    expect(recovered.resolve(attempt.id)).toEqual({ kind: 'retired' });
    expect(() => recovered.select(attempt.id, 1)).toThrow();
    expect(() =>
      recovered.deletionReceipt(
        attempt.id,
        1,
        'delete',
        migrationIdentity.generation,
        'late',
      ),
    ).toThrow();
    expect(recovered.read().head).toEqual({
      epoch: 2,
      attemptId: null,
      authority: 'cleared',
    });
  });

  it.each([
    'missing-journal',
    'missing-marker',
    'missing-both',
    'bad-mac',
    'wrong-format',
    'wrong-vault',
    'extra-field',
    'bad-state',
  ])(
    'refuses %s rather than resetting or adopting an entry',
    async (damage) => {
      const { keys } = await imported();
      editDatabase((db) => {
        if (damage.startsWith('missing')) {
          const keys =
            damage === 'missing-journal'
              ? ['copilot_migration_v1']
              : damage === 'missing-marker'
                ? ['copilot_migration_format']
                : ['copilot_migration_v1', 'copilot_migration_format'];
          for (const key of keys)
            db.prepare('DELETE FROM vault_meta WHERE key = ?').run(key);
        } else {
          const row = db
            .prepare(
              "SELECT value FROM vault_meta WHERE key = 'copilot_migration_v1'",
            )
            .get();
          if (typeof row?.value !== 'string')
            throw new Error('Missing journal.');
          const journal = decodeMigrationJournal(keys, row.value);
          const payload = JSON.stringify({
            ...journal,
            ...(damage === 'wrong-format' ? { version: 2 } : {}),
            ...(damage === 'wrong-vault' ? { vaultId: 'foreign-vault' } : {}),
            ...(damage === 'extra-field' ? { secret: 'must-be-refused' } : {}),
            ...(damage === 'bad-state'
              ? {
                  attempts: journal.attempts.map((item) => ({
                    ...item,
                    state: 'verified',
                  })),
                }
              : {}),
          });
          const mac =
            damage === 'bad-mac'
              ? '0'.repeat(64)
              : withVaultSubkey(keys, 'receipt', (key) =>
                  createHmac('sha256', key)
                    .update('canopy/vault/copilot-migration/v1\0')
                    .update(payload)
                    .digest('hex'),
                );
          const envelope = { payload, mac };
          db.prepare(
            "UPDATE vault_meta SET value = ? WHERE key = 'copilot_migration_v1'",
          ).run(JSON.stringify(envelope));
        }
      });
      store = await dir.opened();
      expect(() => migrationFixture(store).migration.read()).toThrow();
      expect(store.listEntries()).toHaveLength(1);
    },
  );

  it('rejects duplicate/unrelated family entries and cannot adopt them by account label', async () => {
    const fixture = migrationFixture(store);
    await fixture.writer.put(importRequest('unrelated'));
    expect(() => fixture.migration.prepare(migrationIdentity, 1)).toThrow();
    expect(store.listEntries()).toHaveLength(1);
  });

  it('atomically refuses import when an unrelated family entry wins after prepare', async () => {
    const fixture = migrationFixture(store);
    const attempt = fixture.migration.prepare(migrationIdentity, 1);
    const unrelated = await fixture.writer.put(importRequest('later-connect'));
    expect(unrelated.kind).toBe('committed');
    const before = store.listEntries();
    const denied = await fixture.writer.put(
      importRequest(fixture.migration.importKey(attempt.id)),
    );
    expect(denied.kind).toBe('refused');
    expect(fixture.migration.resolve(attempt.id)).toEqual({
      kind: 'not_accepted',
    });
    expect(fixture.migration.read().attempts[0]?.destination).toBeNull();
    expect(store.listEntries()).toEqual(before);
  });

  it('refuses migration metadata without a vault header instead of initializing over it', async () => {
    editDatabase((db) => db.exec('DELETE FROM vault_header'));
    store = await dir.opened();
    // An empty former header alone is not migration state; persist the marker out of band.
    editDatabase((db) =>
      db.exec(
        "INSERT INTO vault_meta (key,value) VALUES ('copilot_migration_format','1')",
      ),
    );
    expect(await dir.open()).toEqual({
      kind: 'store_unavailable',
      step: 'init_state',
    });
  });

  it('refuses contradictory pending-intent metadata rather than claiming definite non-commit', async () => {
    const fixture = migrationFixture(store);
    const attempt = fixture.migration.prepare(migrationIdentity, 1);
    await fixture.writer.put(
      importRequest(fixture.migration.importKey(attempt.id)),
    );
    editDatabase((db) =>
      db.exec(
        "UPDATE vault_intents SET state = 'pending', outcome_revision = NULL",
      ),
    );
    store = await dir.opened();
    expect(() =>
      migrationFixture(store).migration.resolve(attempt.id),
    ).toThrow();
    expect(store.listEntries()).toHaveLength(1);
  });

  it('does not report a pending import or retry as definitely absent while it can still commit', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = migrationFixture(store, { holdPut: () => held });
    const attempt = fixture.migration.prepare(migrationIdentity, 1);
    const pending = fixture.writer.put(
      importRequest(fixture.migration.importKey(attempt.id)),
    );
    expect(fixture.migration.resolve(attempt.id)).toEqual({
      kind: 'unresolved',
    });
    expect(fixture.migration.reconcile(attempt.id, 1)).toEqual({
      kind: 'unresolved',
    });
    release();
    await pending;
    expect(fixture.migration.reconcile(attempt.id, 1).kind).toBe('committed');
  });

  it('rejects duplicate families, stale journal CAS and a late source-generation deletion receipt', async () => {
    const { migration, attempt, resolved, writer } = await imported();
    const old = store.readMigrationJournal();
    migration.select(attempt.id, 1);
    expect(
      store.writeMigrationJournal({ expected: old, next: old ?? '' }).kind,
    ).toBe('not_written');
    expect(() =>
      migration.recordUse(attempt.id, 1, {
        id: '',
        pin: resolved.pin,
        successorKeys: [],
      }),
    ).toThrow();
    expect(() =>
      migration.authorizeDeletion(attempt.id, 1, 'delete'),
    ).toThrow();
    migration.recordUse(attempt.id, 1, {
      id: 'use',
      pin: resolved.pin,
      successorKeys: [],
    });
    migration.authorizeDeletion(attempt.id, 1, 'delete');
    expect(() =>
      migration.deletionReceipt(
        attempt.id,
        1,
        'delete',
        'replacement-generation',
        'completion',
      ),
    ).toThrow();
    expect(() =>
      migration.deletionReceipt(
        attempt.id,
        1,
        'delete',
        migrationIdentity.generation,
        'completion-without-submission',
      ),
    ).toThrow();
    await writer.put(importRequest('duplicate-family'));
    expect(() => migration.resolve(attempt.id)).toThrow();
    expect(store.listEntries()).toHaveLength(2);
  });

  it('retains the fence when a successor is owned but not saved (D27 storage edge)', async () => {
    const { migration, attempt, resolved } = await imported();
    migration.select(attempt.id, 1);
    const fixture = migrationFixture(store, {
      holdPut: () => Promise.reject(new Error('unsaved successor')),
    });
    const put = await fixture.writer.put({
      ref: resolved.pin.ref,
      expectedRevision: 0,
      idempotencyKey: 'unsaved-successor',
      material: new Uint8Array([8]),
      label: 'Copilot',
      expiresAt: null,
    });
    expect(put.kind).toBe('unavailable');
    expect(migration.resolve(attempt.id)).toEqual({ kind: 'unresolved' });
    expect(migrationFixture(store).migration.resolve(attempt.id)).toEqual({
      kind: 'unresolved',
    });
    expect(() =>
      migration.recordUse(attempt.id, 1, {
        id: 'stale-use',
        pin: resolved.pin,
        successorKeys: [],
      }),
    ).toThrow();
    expect((await reopened()).migration.resolve(attempt.id)).toEqual({
      kind: 'unresolved',
    });
  });

  it.each(['version', 'trigger', 'table', 'constraint'])(
    'refuses foreign %s without upgrading or recreating the vault',
    async (damage) => {
      await imported();
      editDatabase((db) => {
        if (damage === 'version')
          db.exec(
            "UPDATE vault_meta SET value = '2' WHERE key = 'schema_version'",
          );
        if (damage === 'trigger')
          db.exec(
            'CREATE TRIGGER foreign_trigger AFTER INSERT ON vault_meta BEGIN SELECT 1; END',
          );
        if (damage === 'table') db.exec('CREATE TABLE foreign_table (id TEXT)');
        if (damage === 'constraint')
          db.exec('ALTER TABLE vault_entries ADD COLUMN extra TEXT');
      });
      expect(await dir.open()).toEqual({
        kind: 'store_unavailable',
        step: 'schema',
      });
    },
  );

  it('pins exact v1 SQL schema without DDL', async () => {
    const { keys, migration } = await imported();
    const encoded = encodeMigrationJournal(keys, migration.read());
    expect(decodeMigrationJournal(keys, encoded)).toEqual(migration.read());
    disposeVaultSubkeys(keys);
    expect(() => decodeMigrationJournal(keys, encoded)).toThrow();
    editDatabase((db) => {
      const reference = new DatabaseSync(':memory:');
      try {
        VAULT_STORE_SCHEMA.forEach((statement) => reference.exec(statement));
        const sql =
          'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name';
        expect(db.prepare(sql).all()).toEqual(reference.prepare(sql).all());
        expect(
          db
            .prepare(
              "SELECT value FROM vault_meta WHERE key = 'schema_version'",
            )
            .get()?.value,
        ).toBe(String(VAULT_STORE_SCHEMA_VERSION));
      } finally {
        reference.close();
      }
      db.exec('CREATE TABLE forbidden_migration_table (id TEXT)');
    });
    expect(await dir.open()).toEqual({
      kind: 'store_unavailable',
      step: 'schema',
    });
  });
});
