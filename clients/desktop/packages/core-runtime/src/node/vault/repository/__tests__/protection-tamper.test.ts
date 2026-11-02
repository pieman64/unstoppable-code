import { copyFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  PlatformKeySlotWriteOptions,
  PlatformSecretProtectionServices,
} from '../../../../platform/secret-protection';
import { createFakeSecretProtection } from '../../../../platform/testing/fake-secret-protection';
import type {
  VaultPutRequest,
  VaultRepository,
  VaultSecretPin,
  VaultSecretRef,
} from '../../../../vault/contracts';
import {
  openVaultReadRepository,
  type VaultReadRepository,
} from '../read-repository';
import { VAULT_STORE_FILE } from '../store';
import {
  FAMILY,
  FUTURE,
  PAST,
  createVaultHarness,
  type VaultHarness,
} from './read-repository-fixtures';
import { storeFolder } from './store-fixtures';

/*
 * The V1 protection and tamper suite (CAN-5448, plan r4 Q5 O2′ and Q4c
 * item 7): nothing grants access while the key is not held, records that only
 * remove access are honoured without it, every tamper that would grant access
 * is caught, and the accepted residual risks are pinned so a change to them
 * is deliberate.
 */

let vault: VaultHarness;

beforeEach(async () => {
  vault = await createVaultHarness();
});

afterEach(() => {
  vault.dispose();
});

function ref(entryId: string): VaultSecretRef {
  return { vaultId: vault.header.vaultId, entryId };
}

function pin(entryId: string, revision = 0): VaultSecretPin {
  return { ref: ref(entryId), revision };
}

const blob = (text: string): string => `CAST('${text}' AS BLOB)`;

async function states(
  repository: VaultRepository,
): Promise<Record<string, string>> {
  return Object.fromEntries(
    (await repository.list()).map((item) => [item.ref.entryId, item.state]),
  );
}

/** No read, admission or listing serves the entry. */
async function expectNoAccess(
  repository: VaultRepository,
  entryId: string,
  revisions: readonly number[] = [0, 1],
): Promise<void> {
  expect((await repository.get(ref(entryId))).kind).not.toBe('available');
  for (const revision of revisions)
    expect(repository.admit(pin(entryId, revision)).kind).not.toBe('admitted');
  expect((await states(repository))[entryId]).not.toBe('available');
}

const create = {
  entryId: null,
  expectedRevision: null,
  family: FAMILY,
  label: 'Token',
  material: new TextEncoder().encode('n3w'),
  expiresAt: null,
  idempotencyKey: 'create',
} as const;

const RETENTION = 30 * 24 * 60 * 60 * 1_000;

/**
 * Through the write path: a replace of entry-a that retains `unavailable`,
 * then a committed delete. `retry` is that replace's same-key request.
 */
async function retainedPutThenDeleted(): Promise<{
  readonly retry: () => VaultPutRequest;
}> {
  vault.commit({ entryId: 'entry-a' });
  let failCommit = false;
  const opened = await vault.restart({
    faults: {
      beforeWrite: () => {
        if (!failCommit) return;
        failCommit = false;
        throw new Error('injected write failure');
      },
    },
    holdPut: () => {
      failCommit = true;
      return Promise.resolve();
    },
  });
  const retry = (): VaultPutRequest => ({
    ref: ref('entry-a'),
    expectedRevision: 0,
    label: 'Rotated',
    material: new TextEncoder().encode('r0tated'),
    expiresAt: null,
    idempotencyKey: 'replace',
  });
  const writer = opened.writer(FAMILY);
  expect(await writer.put(retry())).toEqual({
    kind: 'unavailable',
    ref: ref('entry-a'),
  });
  expect(
    await writer.delete({
      ref: ref('entry-a'),
      expectedRevision: 0,
      idempotencyKey: 'delete',
    }),
  ).toMatchObject({ kind: 'committed' });
  return { retry };
}

describe('while the vault key is not held (CAN-5448, Q5)', () => {
  it('grants nothing, shows stored metadata by precedence, and honours every record that only removes access', async () => {
    vault.commit({ entryId: 'available', label: 'GitHub', expiresAt: FUTURE });
    vault.commit({ entryId: 'expired', expiresAt: PAST });
    vault.commit({ entryId: 'shortened', expiresAt: FUTURE });
    vault.commit({ entryId: 'replacing' });
    vault.recordReplace('replacing', 0, 'replace-1');
    vault.commit({ entryId: 'deleting' });
    vault.recordDelete('deleting', 0, 'delete-1');
    vault.commit({ entryId: 'deleted' });
    vault.tombstone('deleted', 0);
    vault.recordPut('creating', 'create-1');
    // An earlier expiry only removes access, so it is honoured unverified.
    await vault.raw((db) =>
      db.exec(`UPDATE vault_entries SET expires_at = '${PAST}'
        WHERE entry_id = ${blob('shortened')}`),
    );
    vault.fake.inject({ kind: 'locked', evidence: 'reported' });
    const opened = await vault.restart();
    const { repository } = opened;

    expect(await states(repository)).toEqual({
      available: 'locked',
      expired: 'expired',
      shortened: 'expired',
      replacing: 'unconfirmed',
      deleting: 'delete_unconfirmed',
      creating: 'unconfirmed',
    });
    for (const entryId of [
      'available',
      'expired',
      'shortened',
      'replacing',
      'deleting',
      'creating',
      'deleted',
    ])
      expect(repository.admit(pin(entryId)).kind).not.toBe('admitted');
    expect(await repository.get(ref('available'))).toEqual({
      kind: 'blocked',
      reason: 'locked',
    });
    expect(await repository.get(ref('deleted'))).toEqual({
      kind: 'not_found',
      reason: 'deleted',
    });
    expect(
      (await repository.list()).find(
        (item) => item.ref.entryId === 'available',
      ),
    ).toMatchObject({ label: 'GitHub', revision: 0, expiresAt: FUTURE });

    const writer = opened.writer(FAMILY);
    expect(await writer.put(create)).toEqual({
      kind: 'blocked',
      reason: 'locked',
    });
    expect(
      await writer.put({
        ref: ref('available'),
        expectedRevision: 0,
        label: 'Rotated',
        material: new Uint8Array([1]),
        expiresAt: null,
        idempotencyKey: 'replace',
      }),
    ).toEqual({ kind: 'blocked', reason: 'locked' });
    // A delete needs no key.
    expect(
      await writer.delete({
        ref: ref('available'),
        expectedRevision: 0,
        idempotencyKey: 'delete',
      }),
    ).toEqual({
      kind: 'committed',
      ref: ref('available'),
      tombstoneRevision: 1,
    });

    vault.fake.clearFaults();
    await opened.refresh();
    expect(await states(repository)).toMatchObject({
      expired: 'expired',
      // The tag binds the stored expiry, so the edit fails it once verified.
      shortened: 'corrupt',
    });
    expect(await repository.get(ref('available'))).toEqual({
      kind: 'not_found',
      reason: 'deleted',
    });
  });
});

describe('tamper that would grant access if undetected (CAN-5448, Q5)', () => {
  const rowTampers: readonly (readonly [string, string, string])[] = [
    ['a later revision', 'revision = revision + 1', 'corrupt'],
    ['an earlier revision', 'revision = revision - 1', 'unconfirmed'],
    ['a later expiry', `expires_at = '2099-01-01T00:00:00.000Z'`, 'corrupt'],
    ['another family', `family = 'other.family'`, 'corrupt'],
    ['another label', `label = ${blob('Forged')}`, 'corrupt'],
  ];

  it.each(rowTampers)(
    '%s on the row is caught, locked or not',
    async (_name, set, state) => {
      vault.commit({ entryId: 'entry-a', expiresAt: FUTURE });
      vault.replace({ entryId: 'entry-a', expiresAt: FUTURE }, 0);
      await vault.raw((db) => db.exec(`UPDATE vault_entries SET ${set}`));

      vault.fake.inject({ kind: 'locked', evidence: 'reported' });
      const opened = await vault.restart();
      await expectNoAccess(opened.repository, 'entry-a', [0, 1, 2]);
      vault.fake.clearFaults();
      await opened.refresh();

      await expectNoAccess(opened.repository, 'entry-a', [0, 1, 2]);
      expect((await states(opened.repository))['entry-a']).toBe(state);
    },
  );

  it('ciphertext swapped between entries is caught, and the rest stays usable', async () => {
    vault.commit({ entryId: 'entry-a' });
    vault.commit({ entryId: 'entry-b' });
    await vault.raw((db) =>
      db.exec(`UPDATE vault_entries SET
        (nonce, ciphertext, tag) = (SELECT nonce, ciphertext, tag
          FROM vault_entries WHERE entry_id = ${blob('entry-b')})
        WHERE entry_id = ${blob('entry-a')}`),
    );
    const { repository } = await vault.restart();

    await expectNoAccess(repository, 'entry-a');
    expect(await states(repository)).toEqual({
      'entry-a': 'corrupt',
      'entry-b': 'available',
    });
  });

  const clearings: readonly (readonly [string, string])[] = [
    ['to its successor', 'outcome_revision = 1'],
    ['to the stored revision', 'outcome_revision = 0'],
    ['as a second create', 'expected_revision = NULL, outcome_revision = 0'],
  ];

  it.each(clearings)(
    'clearing "unconfirmed" by settling a pending replace %s keeps the entry closed',
    async (_name, set) => {
      vault.commit({ entryId: 'entry-a' });
      vault.recordReplace('entry-a', 0, 'replace-1');
      await vault.raw((db) =>
        db.exec(`UPDATE vault_intents SET state = 'committed', ${set}
          WHERE idempotency_key = ${blob('replace-1')}`),
      );

      for (const locked of [true, false]) {
        if (locked) vault.fake.inject({ kind: 'locked', evidence: 'reported' });
        else vault.fake.clearFaults();
        const { repository } = await vault.restart();
        await expectNoAccess(repository, 'entry-a');
        expect(await states(repository)).toEqual({ 'entry-a': 'unconfirmed' });
      }
    },
  );

  it('a row rolled back to its own older, validly sealed copy stays closed while its intents vouch for the later revision', async () => {
    vault.commit({ entryId: 'entry-a' });
    const older = join(vault.dir.root, 'older.sqlite');
    await vault.raw(() =>
      copyFileSync(join(vault.dir.folder, VAULT_STORE_FILE), older),
    );
    vault.replace({ entryId: 'entry-a' }, 0);
    await vault.raw((db) => {
      db.exec(`ATTACH DATABASE '${older}' AS old`);
      db.exec('DELETE FROM vault_entries');
      db.exec('INSERT INTO vault_entries SELECT * FROM old.vault_entries');
    });

    const { repository } = await vault.restart();
    await expectNoAccess(repository, 'entry-a');
    expect(await states(repository)).toEqual({ 'entry-a': 'unconfirmed' });
  });

  it('settling a pending delete by editing its intent only removes the entry', async () => {
    vault.commit({ entryId: 'entry-a' });
    vault.recordDelete('entry-a', 0, 'delete-1');
    await vault.raw((db) =>
      db.exec(`UPDATE vault_intents SET state = 'committed', outcome_revision = 1
        WHERE idempotency_key = ${blob('delete-1')}`),
    );
    const { repository } = await vault.restart();

    await expectNoAccess(repository, 'entry-a');
    expect(await states(repository)).toEqual({});
  });

  it('removing a committed delete record brings nothing back: its tombstone erased the row', async () => {
    vault.commit({ entryId: 'entry-a' });
    vault.tombstone('entry-a', 0);
    await vault.raw((db) => {
      db.exec('DELETE FROM vault_tombstones');
      db.exec(`DELETE FROM vault_intents WHERE kind = 'delete'`);
    });
    const { repository } = await vault.restart();

    await expectNoAccess(repository, 'entry-a');
    expect(await repository.get(ref('entry-a'))).toEqual({
      kind: 'not_found',
      reason: 'absent',
    });
    expect(vault.store().listEntries()).toEqual([]);
  });
  it('a tombstone whose committed delete intent was removed outlives retention: a retained put stays superseded', async () => {
    const { retry } = await retainedPutThenDeleted();
    await vault.raw((db) =>
      db.exec(`DELETE FROM vault_intents WHERE kind = 'delete'`),
    );
    vault.advance(RETENTION);
    const opened = await vault.restart();

    expect(vault.store().readTombstone('entry-a')).not.toBeNull();
    expect(await opened.repository.get(ref('entry-a'))).toEqual({
      kind: 'not_found',
      reason: 'deleted',
    });
    expect(await opened.writer(FAMILY).put(retry())).toEqual({
      kind: 'superseded',
      ref: ref('entry-a'),
    });
    expect(vault.store().readEntry('entry-a')).toBeNull();
  });
});

describe('accepted residual risks (2026-10-29 checkpoint)', () => {
  it('removing a pending delete intent reopens its entry: a MAC cannot show a missing record', async () => {
    vault.commit({ entryId: 'entry-a' });
    vault.recordDelete('entry-a', 0, 'delete-1');
    await vault.raw((db) =>
      db.exec(`DELETE FROM vault_intents WHERE kind = 'delete'`),
    );
    const { repository } = await vault.restart();

    expect(repository.admit(pin('entry-a'))).toEqual({ kind: 'admitted' });
  });

  it('rolling back to an older copy brings a deleted entry back', async () => {
    vault.commit({ entryId: 'entry-a' });
    const backup = join(vault.dir.root, 'backup.sqlite');
    await vault.raw(() =>
      copyFileSync(join(vault.dir.folder, VAULT_STORE_FILE), backup),
    );
    vault.tombstone('entry-a', 0);
    await vault.raw((db) => {
      db.exec(`ATTACH DATABASE '${backup}' AS old`);
      for (const table of [
        'vault_tombstones',
        'vault_intents',
        'vault_entries',
      ])
        db.exec(`DELETE FROM ${table}`);
      db.exec('INSERT INTO vault_entries SELECT * FROM old.vault_entries');
      db.exec('INSERT INTO vault_intents SELECT * FROM old.vault_intents');
    });
    const { repository } = await vault.restart();

    expect(repository.admit(pin('entry-a'))).toEqual({ kind: 'admitted' });
  });

  it('after retention, removing the committed delete intent lets a retained put write its entry again', async () => {
    const { retry } = await retainedPutThenDeleted();
    vault.advance(RETENTION);
    await vault.restart();
    expect(vault.store().readTombstone('entry-a')).toBeNull();
    await vault.raw((db) =>
      db.exec(`DELETE FROM vault_intents WHERE kind = 'delete'`),
    );
    const opened = await vault.restart();

    expect(await opened.writer(FAMILY).put(retry())).toEqual({
      kind: 'committed',
      pin: pin('entry-a', 1),
    });
  });

  it('labels are unverified while the key is not held', async () => {
    vault.commit({ entryId: 'entry-a', label: 'GitHub' });
    await vault.raw((db) =>
      db.exec(`UPDATE vault_entries SET label = ${blob('Forged')}`),
    );
    vault.fake.inject({ kind: 'locked', evidence: 'reported' });
    const opened = await vault.restart();

    expect(await opened.repository.list()).toMatchObject([
      { label: 'Forged', state: 'locked' },
    ]);
    vault.fake.clearFaults();
    await opened.refresh();
    expect(await states(opened.repository)).toEqual({ 'entry-a': 'corrupt' });
  });
});

describe('the key slot (CAN-5448, Q4c item 7)', () => {
  interface SlotCalls {
    writes: PlatformKeySlotWriteOptions['mode'][];
    deletes: number;
  }

  function recording(port: PlatformSecretProtectionServices): {
    readonly slots: PlatformSecretProtectionServices;
    readonly calls: SlotCalls;
  } {
    const calls: SlotCalls = { writes: [], deletes: 0 };
    return {
      calls,
      slots: {
        ...port,
        writeKeySlot: (
          slot,
          material,
          options,
        ): ReturnType<PlatformSecretProtectionServices['writeKeySlot']> => {
          calls.writes.push(options.mode);
          return port.writeKeySlot(slot, material, options);
        },
        deleteKeySlot: (
          slot,
          options,
        ): ReturnType<PlatformSecretProtectionServices['deleteKeySlot']> => {
          calls.deletes += 1;
          return port.deleteKeySlot(slot, options);
        },
      },
    };
  }

  it('is created once with a new vault and never replaced or deleted', async () => {
    const dir = storeFolder();
    const fake = createFakeSecretProtection({ backend: 'macos_keychain' });
    const { slots, calls } = recording(fake.port);
    const signal = new AbortController().signal;
    const restart = async (): Promise<{
      readonly vault: VaultReadRepository;
      readonly close: () => void;
    }> => {
      const store = await dir.opened();
      const opened = await openVaultReadRepository({ store, slots, signal });
      if (opened.kind !== 'opened') throw new Error(opened.step);
      return {
        vault: opened.vault,
        close: (): void => {
          opened.vault.dispose();
          store.close();
        },
      };
    };
    try {
      let current = await restart();
      const slotName = `vault-${current.vault.vaultId}`;
      const writer = current.vault.writer(FAMILY);
      const created = await writer.put(create);
      if (created.kind !== 'committed') throw new Error(created.kind);
      await writer.delete({
        ref: created.pin.ref,
        expectedRevision: 0,
        idempotencyKey: 'delete',
      });
      fake.inject({ kind: 'locked', evidence: 'reported' });
      await current.vault.refresh();
      fake.clearFaults();
      await current.vault.refresh();
      await current.vault.reconcile();
      current.close();

      for (const fault of ['key_missing', 'corrupt'] as const) {
        fake.inject({ kind: fault, slot: slotName });
        current = await restart();
        expect(current.vault.repository.status().protection.state).toBe(
          'key_missing',
        );
        expect(
          await current.vault.writer(FAMILY).put({
            ...create,
            idempotencyKey: `after-${fault}`,
          }),
        ).toEqual({ kind: 'blocked', reason: 'key_missing' });
        await current.vault.refresh();
        await current.vault.reconcile();
        current.close();
        expect(fake.peek(slotName)).toBe(
          fault === 'corrupt' ? 'corrupt' : null,
        );
      }

      expect(calls).toEqual({ writes: ['create'], deletes: 0 });
    } finally {
      dir.remove();
    }
  });

  it('a store whose header is gone but whose records remain fails closed, and nothing is re-created', async () => {
    vault.commit({ entryId: 'entry-a' });
    const slot = vault.fake.peek(vault.slotName);
    await expect(
      vault.raw((db) => db.exec('DELETE FROM vault_header')),
    ).rejects.toThrow('init_state');

    expect(await vault.dir.open()).toEqual({
      kind: 'store_unavailable',
      step: 'init_state',
    });
    expect(vault.fake.peek(vault.slotName)).toEqual(slot);
  });
});
