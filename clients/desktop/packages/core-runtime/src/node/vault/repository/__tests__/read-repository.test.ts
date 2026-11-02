import type { PlatformSecretProtectionUnavailableReason } from '../../../../platform/secret-protection';
import type { FakeSecretProtectionFault } from '../../../../platform/testing/fake-secret-protection';
import type {
  VaultBlockReason,
  VaultRepository,
  VaultSecretPin,
  VaultSecretRef,
} from '../../../../vault/contracts';
import { openVaultReadRepository } from '../read-repository';
import { VAULT_UNLABELED_ENTRY } from '../read-view';
import { generateVaultKey } from '../vault-keys';
import {
  FAMILY,
  FUTURE,
  PAST,
  createVaultHarness,
  type VaultHarness,
} from './read-repository-fixtures';

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

async function states(
  repository: VaultRepository,
): Promise<Record<string, string>> {
  return Object.fromEntries(
    (await repository.list()).map((item) => [item.ref.entryId, item.state]),
  );
}

/** get, admit and list agree on one entry's state. */
async function expectBlocked(
  repository: VaultRepository,
  entryId: string,
  reason: VaultBlockReason,
): Promise<void> {
  expect(await repository.get(ref(entryId))).toEqual({
    kind: 'blocked',
    reason,
  });
  expect(repository.admit(pin(entryId))).toEqual({ kind: 'blocked', reason });
  expect((await states(repository))[entryId]).toBe(reason);
}

const secret = new TextEncoder().encode('s3cr3t');

describe('vault reads once the key is held (CAN-5388)', () => {
  it('reads, admits and lists a committed entry', async () => {
    vault.commit({ entryId: 'entry-a', label: 'GitHub', expiresAt: FUTURE });
    const { repository } = await vault.restart();

    const read = await repository.get(ref('entry-a'));
    expect(read).toEqual({
      kind: 'available',
      pin: pin('entry-a'),
      material: secret,
    });
    expect(repository.admit(pin('entry-a'))).toEqual({ kind: 'admitted' });
    expect(repository.admit(pin('entry-a', 1))).toEqual({ kind: 'stale' });
    expect(await repository.list()).toEqual([
      {
        ref: ref('entry-a'),
        family: FAMILY,
        label: 'GitHub',
        revision: 0,
        state: 'available',
        expiresAt: FUTURE,
        createdAt: '2026-10-29T12:00:00.000Z',
        updatedAt: '2026-10-29T12:00:00.000Z',
      },
    ]);
    expect(repository.status()).toEqual({
      protection: { state: 'available', backend: 'macos_keychain' },
      observedAt: '2026-10-29T12:00:00.000Z',
    });
    expect(vault.fake.prompts).toBe(0);
  });

  it('returns a fresh copy of the material on every read', async () => {
    vault.commit({ entryId: 'entry-a' });
    const { repository } = await vault.restart();

    const first = await repository.get(ref('entry-a'));
    if (first.kind !== 'available') throw new Error(first.kind);
    first.material.fill(0);

    expect(await repository.get(ref('entry-a'))).toMatchObject({
      material: secret,
    });
  });

  it('pins the latest committed revision', async () => {
    vault.commit({ entryId: 'entry-a' });
    vault.replace({ entryId: 'entry-a', label: 'Rotated' }, 0);
    const { repository } = await vault.restart();

    expect(await repository.get(ref('entry-a'))).toMatchObject({
      kind: 'available',
      pin: pin('entry-a', 1),
    });
    expect(repository.admit(pin('entry-a', 0))).toEqual({ kind: 'stale' });
    expect(repository.admit(pin('entry-a', 1))).toEqual({ kind: 'admitted' });
  });

  it('reports absent, deleted and foreign references as not found and never admits them', async () => {
    vault.commit({ entryId: 'entry-a' });
    vault.tombstone('entry-a', 0);
    const { repository } = await vault.restart();

    expect(await repository.get(ref('entry-a'))).toEqual({
      kind: 'not_found',
      reason: 'deleted',
    });
    expect(await repository.get(ref('missing'))).toEqual({
      kind: 'not_found',
      reason: 'absent',
    });
    expect(
      await repository.get({ vaultId: 'other', entryId: 'entry-a' }),
    ).toEqual({ kind: 'not_found', reason: 'foreign_vault' });
    expect(repository.admit(pin('entry-a'))).toEqual({ kind: 'revoked' });
    expect(repository.admit(pin('missing'))).toEqual({ kind: 'revoked' });
    expect(await repository.list()).toEqual([]);
  });

  it('applies precedence: corrupt, then expired, then available', async () => {
    vault.commit({ entryId: 'expired', expiresAt: PAST });
    vault.commit({ entryId: 'both', expiresAt: PAST, label: 'Both' });
    await vault.raw((db) =>
      db.exec(`UPDATE vault_entries SET label = CAST('Edited' AS BLOB)
        WHERE entry_id = CAST('both' AS BLOB)`),
    );
    const { repository } = await vault.restart();

    await expectBlocked(repository, 'expired', 'expired');
    await expectBlocked(repository, 'both', 'corrupt');
  });

  it('starts a new vault in an empty store and holds its key', async () => {
    const fresh = await vault.dir.open({ folder: `${vault.dir.root}/fresh` });
    if (fresh.kind !== 'opened') throw new Error(fresh.step);
    try {
      const opened = await openVaultReadRepository({
        store: fresh.store,
        slots: vault.fake.port,
        signal: new AbortController().signal,
      });
      if (opened.kind !== 'opened') throw new Error(opened.step);
      expect(fresh.store.header?.vaultId).toBe(opened.vault.vaultId);
      expect(opened.vault.repository.status().protection.state).toBe(
        'available',
      );
      expect(await opened.vault.repository.list()).toEqual([]);
      opened.vault.dispose();
    } finally {
      fresh.store.close();
    }
  });
});

describe('vault key-slot outcomes on the durable store (CAN-5388, plan Q4)', () => {
  type Arrange = (harness: VaultHarness) => void | Promise<void>;
  const fault =
    (injected: FakeSecretProtectionFault): Arrange =>
    (harness) =>
      harness.fake.inject(injected);
  const reasons: readonly PlatformSecretProtectionUnavailableReason[] = [
    'no_backend',
    'unsupported_session',
    'backend_failed',
    'authority_unavailable',
  ];
  const cases: readonly (readonly [
    string,
    Arrange,
    Record<string, unknown>,
    VaultBlockReason,
  ])[] = [
    [
      'slot absent',
      (harness): void =>
        harness.fake.inject({ kind: 'key_missing', slot: harness.slotName }),
      { state: 'key_missing' },
      'key_missing',
    ],
    [
      'slot corrupt',
      (harness): void =>
        harness.fake.inject({ kind: 'corrupt', slot: harness.slotName }),
      { state: 'key_missing' },
      'key_missing',
    ],
    [
      'slot holds another KEK',
      async (harness): Promise<void> => {
        harness.fake.inject({ kind: 'key_missing', slot: harness.slotName });
        await harness.fake.port.writeKeySlot(
          { name: harness.slotName },
          generateVaultKey(),
          {
            signal: new AbortController().signal,
            interaction: 'never',
            mode: 'create',
          },
        );
      },
      { state: 'key_missing' },
      'key_missing',
    ],
    [
      'locked, reported',
      fault({ kind: 'locked', evidence: 'reported' }),
      { state: 'locked', evidence: 'reported' },
      'locked',
    ],
    [
      'locked, inferred',
      fault({ kind: 'locked', evidence: 'inferred' }),
      { state: 'locked', evidence: 'inferred' },
      'locked',
    ],
    [
      'interaction required',
      fault({ kind: 'unknown' }),
      { state: 'locked', evidence: 'inferred' },
      'locked',
    ],
    ['denied', fault({ kind: 'denied' }), { state: 'denied' }, 'denied'],
    ...reasons.map(
      (reason) =>
        [
          `unavailable: ${reason}`,
          fault({ kind: 'unavailable', reason }),
          { state: 'unavailable', reason },
          'unavailable',
        ] as const,
    ),
    [
      'read timed out',
      fault({ kind: 'abort' }),
      { state: 'unavailable', reason: 'backend_failed' },
      'unavailable',
    ],
  ];

  it.each(cases)(
    '%s: metadata stays readable, nothing is usable or admitted',
    async (_name, arrange, protection, reason) => {
      vault.commit({ entryId: 'entry-a', label: 'GitHub' });
      vault.commit({ entryId: 'expired', expiresAt: PAST });
      await arrange(vault);
      const { repository } = await vault.restart();

      expect(repository.status().protection).toEqual({
        ...protection,
        backend: 'macos_keychain',
      });
      await expectBlocked(repository, 'entry-a', reason);
      // Expiry only removes access, so it needs no key.
      await expectBlocked(repository, 'expired', 'expired');
      expect(
        (await repository.list()).find(
          (item) => item.ref.entryId === 'entry-a',
        ),
      ).toMatchObject({ label: 'GitHub', revision: 0 });
      expect(vault.fake.prompts).toBe(0);
    },
  );
});

describe('vault tamper detection (CAN-5388, plan Q5 O2′)', () => {
  const tampers: readonly (readonly [string, string])[] = [
    [
      'ciphertext',
      `UPDATE vault_entries SET ciphertext = randomblob(length(ciphertext))`,
    ],
    ['tag', `UPDATE vault_entries SET tag = zeroblob(16)`],
    ['revision', `UPDATE vault_entries SET revision = revision + 1`],
    ['expiry', `UPDATE vault_entries SET expires_at = '2099-01-01T00:00:00Z'`],
    ['family', `UPDATE vault_entries SET family = 'other.family'`],
    ['label', `UPDATE vault_entries SET label = CAST('Forged' AS BLOB)`],
  ];

  it.each(tampers)(
    'a tampered %s fails closed as corrupt once the key is held',
    async (_name, sql) => {
      vault.commit({ entryId: 'entry-a', expiresAt: FUTURE });
      await vault.raw((db) => db.exec(sql));
      const { repository } = await vault.restart();
      const [listed] = await repository.list();
      if (listed === undefined) throw new Error('Entry not listed.');

      expect(listed.state).toBe('corrupt');
      expect(await repository.get(ref('entry-a'))).toEqual({
        kind: 'blocked',
        reason: 'corrupt',
      });
      expect(repository.admit(pin('entry-a', listed.revision))).toEqual({
        kind: 'blocked',
        reason: 'corrupt',
      });
    },
  );

  it('detects ciphertext swapped between entries, leaving the rest usable', async () => {
    vault.commit({ entryId: 'entry-a' });
    vault.commit({ entryId: 'entry-b' });
    vault.commit({ entryId: 'entry-c' });
    await vault.raw((db) =>
      db.exec(`UPDATE vault_entries SET
        (nonce, ciphertext, tag) = (SELECT nonce, ciphertext, tag
          FROM vault_entries WHERE entry_id = CAST('entry-b' AS BLOB))
        WHERE entry_id = CAST('entry-a' AS BLOB)`),
    );
    const { repository } = await vault.restart();

    expect(await states(repository)).toEqual({
      'entry-a': 'corrupt',
      'entry-b': 'available',
      'entry-c': 'available',
    });
  });

  it('shows a tampered entry the block reason while the key is not held', async () => {
    vault.commit({ entryId: 'entry-a' });
    await vault.raw((db) =>
      db.exec(`UPDATE vault_entries SET tag = zeroblob(16)`),
    );
    vault.fake.inject({ kind: 'locked', evidence: 'reported' });
    const opened = await vault.restart();

    await expectBlocked(opened.repository, 'entry-a', 'locked');
    vault.fake.clearFaults();
    await opened.refresh();
    await expectBlocked(opened.repository, 'entry-a', 'corrupt');
  });

  it('reads a row with an out-of-bounds family as corrupt, never absent', async () => {
    vault.commit({ entryId: 'entry-a' });
    vault.commit({ entryId: 'entry-b' });
    await vault.raw((db) =>
      db.exec(`UPDATE vault_entries SET family = 'Not A Family!'
        WHERE entry_id = CAST('entry-a' AS BLOB)`),
    );
    vault.fake.inject({ kind: 'locked', evidence: 'reported' });
    const opened = await vault.restart();
    const { repository } = opened;

    expect(await repository.get(ref('entry-a'))).toEqual({
      kind: 'blocked',
      reason: 'locked',
    });
    vault.fake.clearFaults();
    await opened.refresh();
    expect(await repository.get(ref('entry-a'))).toEqual({
      kind: 'blocked',
      reason: 'corrupt',
    });
    expect(repository.admit(pin('entry-a'))).toEqual({
      kind: 'blocked',
      reason: 'corrupt',
    });
    // The wire cannot carry its family, so only the intact entry lists.
    expect(await states(repository)).toEqual({ 'entry-b': 'available' });
  });

  it('lists a row with an out-of-bounds label under a placeholder', async () => {
    vault.commit({ entryId: 'entry-a' });
    await vault.raw((db) =>
      db.exec(`UPDATE vault_entries SET label = zeroblob(300)`),
    );
    const { repository } = await vault.restart();

    expect(await repository.list()).toMatchObject([
      { label: VAULT_UNLABELED_ENTRY, state: 'corrupt' },
    ]);
  });
});

describe('vault intent replay on open (CAN-5388)', () => {
  it('keeps a pending create unconfirmed and closed across restarts', async () => {
    vault.recordPut('entry-new', 'create-1');
    for (let restart = 0; restart < 2; restart += 1) {
      const { repository } = await vault.restart();
      expect(await repository.get(ref('entry-new'))).toEqual({
        kind: 'unconfirmed',
        state: 'unconfirmed',
      });
      expect(repository.admit(pin('entry-new'))).toEqual({
        kind: 'unconfirmed',
      });
      expect(await repository.list()).toEqual([
        {
          ref: ref('entry-new'),
          family: FAMILY,
          label: VAULT_UNLABELED_ENTRY,
          revision: 0,
          state: 'unconfirmed',
          expiresAt: null,
          createdAt: '2026-10-29T12:00:00.000Z',
          updatedAt: '2026-10-29T12:00:00.000Z',
        },
      ]);
    }
  });

  it('keeps an entry with a pending replace unconfirmed, never falling back to its committed revision', async () => {
    vault.commit({ entryId: 'entry-a', label: 'GitHub' });
    vault.recordReplace('entry-a', 0, 'replace-1');
    const { repository } = await vault.restart();

    expect(await repository.get(ref('entry-a'))).toEqual({
      kind: 'unconfirmed',
      state: 'unconfirmed',
    });
    expect(repository.admit(pin('entry-a'))).toEqual({ kind: 'unconfirmed' });
    expect(await repository.list()).toMatchObject([
      { label: 'GitHub', revision: 0, state: 'unconfirmed' },
    ]);
  });

  it('reopens an entry whose pending replace a later committed put superseded', async () => {
    vault.commit({ entryId: 'entry-a' });
    // An unavailable replace leaves its intent pending; a new put then commits.
    vault.recordReplace('entry-a', 0, 'replace-unavailable');
    vault.replace({ entryId: 'entry-a', label: 'Rotated' }, 0);
    const { repository } = await vault.restart();

    expect(await repository.get(ref('entry-a'))).toMatchObject({
      kind: 'available',
      pin: pin('entry-a', 1),
    });
    expect(repository.admit(pin('entry-a', 1))).toEqual({ kind: 'admitted' });
    expect(await states(repository)).toEqual({ 'entry-a': 'available' });
  });

  it('keeps a superseded replace closed when the committed row does not match its successor', async () => {
    vault.commit({ entryId: 'entry-a' });
    vault.recordReplace('entry-a', 0, 'replace-unavailable');
    vault.replace({ entryId: 'entry-a', label: 'Rotated' }, 0);
    await vault.raw((db) => db.exec(`UPDATE vault_entries SET revision = 0`));
    const { repository } = await vault.restart();

    expect(repository.admit(pin('entry-a', 0))).toEqual({
      kind: 'unconfirmed',
    });
    expect(await states(repository)).toEqual({ 'entry-a': 'unconfirmed' });
  });

  it('keeps an entry with a pending delete delete_unconfirmed and revoked, with or without the key', async () => {
    vault.commit({ entryId: 'entry-a' });
    vault.commit({ entryId: 'entry-b' });
    vault.recordDelete('entry-a', 0, 'delete-1');
    // A put recorded after the delete cannot reopen the entry.
    vault.recordDelete('entry-b', 0, 'delete-b');
    vault.recordReplace('entry-b', 0, 'replace-b');
    for (const locked of [false, true]) {
      if (locked) vault.fake.inject({ kind: 'locked', evidence: 'reported' });
      const { repository } = await vault.restart();
      for (const entryId of ['entry-a', 'entry-b']) {
        expect(await repository.get(ref(entryId))).toEqual({
          kind: 'unconfirmed',
          state: 'delete_unconfirmed',
        });
        expect(repository.admit(pin(entryId))).toEqual({ kind: 'revoked' });
      }
      expect(await states(repository)).toEqual({
        'entry-a': 'delete_unconfirmed',
        'entry-b': 'delete_unconfirmed',
      });
    }
  });

  it('keeps an entry closed by a pending intent whose stored family is damaged', async () => {
    vault.commit({ entryId: 'entry-a' });
    vault.commit({ entryId: 'entry-b' });
    vault.recordDelete('entry-a', 0, 'delete-a');
    vault.recordReplace('entry-b', 0, 'replace-b');
    await vault.raw((db) =>
      db.exec(
        `UPDATE vault_intents SET family = 'Not A Family!' WHERE state = 'pending'`,
      ),
    );
    const { repository } = await vault.restart();

    expect(repository.admit(pin('entry-a'))).toEqual({ kind: 'revoked' });
    expect(repository.admit(pin('entry-b'))).toEqual({ kind: 'unconfirmed' });
    expect(await states(repository)).toEqual({
      'entry-a': 'delete_unconfirmed',
      'entry-b': 'unconfirmed',
    });
  });

  it('lets a tombstone or committed delete outrank any pending put', async () => {
    vault.commit({ entryId: 'entry-a' });
    vault.tombstone('entry-a', 0);
    vault.recordPut('entry-a', 'late-put');
    const { repository } = await vault.restart();

    expect(await repository.get(ref('entry-a'))).toEqual({
      kind: 'not_found',
      reason: 'deleted',
    });
    expect(repository.admit(pin('entry-a'))).toEqual({ kind: 'revoked' });
    expect(await repository.list()).toEqual([]);
  });

  it('keeps a committed delete in force once its tombstone is gone, reading absent', async () => {
    vault.commit({ entryId: 'entry-a' });
    vault.tombstone('entry-a', 0);
    // A row restored behind the tombstone's removal, as a partial rollback would.
    vault.commit({ entryId: 'entry-b' });
    await vault.raw((db) => {
      db.exec(`DELETE FROM vault_tombstones`);
      db.exec(`INSERT INTO vault_entries SELECT CAST('entry-a' AS BLOB), family,
        revision, expires_at, label, nonce, ciphertext, tag, created_at,
        updated_at FROM vault_entries WHERE entry_id = CAST('entry-b' AS BLOB)`);
    });
    const opened = await openVaultReadRepository({
      store: vault.store(),
      slots: vault.fake.port,
      signal: new AbortController().signal,
    });
    if (opened.kind !== 'opened') throw new Error(opened.step);
    const { repository } = opened.vault;

    expect(await repository.get(ref('entry-a'))).toEqual({
      kind: 'not_found',
      reason: 'absent',
    });
    expect(repository.admit(pin('entry-a'))).toEqual({ kind: 'revoked' });
    expect(await states(repository)).toEqual({ 'entry-b': 'available' });
    opened.vault.dispose();
  });

  it('fails the open closed when a stored row is malformed', async () => {
    vault.commit({ entryId: 'entry-a' });
    await vault.raw((db) => db.exec(`UPDATE vault_entries SET label = X'FF'`));
    const opened = await openVaultReadRepository({
      store: vault.store(),
      slots: vault.fake.port,
      signal: new AbortController().signal,
    });

    expect(opened).toEqual({ kind: 'vault_unavailable', step: 'replay' });
  });

  it('refuses to open over a closed store or a vault it cannot start', async () => {
    const store = vault.store();
    store.close();
    expect(
      await openVaultReadRepository({
        store,
        slots: vault.fake.port,
        signal: new AbortController().signal,
      }),
    ).toEqual({ kind: 'vault_unavailable', step: 'store' });

    const fresh = await vault.dir.open({ folder: `${vault.dir.root}/fresh` });
    if (fresh.kind !== 'opened') throw new Error(fresh.step);
    vault.fake.inject({ kind: 'locked', evidence: 'reported' });
    try {
      expect(
        await openVaultReadRepository({
          store: fresh.store,
          slots: vault.fake.port,
          signal: new AbortController().signal,
        }),
      ).toEqual({ kind: 'vault_unavailable', step: 'init' });
      expect(fresh.store.header).toBeNull();
    } finally {
      fresh.store.close();
    }
  });
});

describe('when vault reads reach the backend (CAN-5388, plan Q4c item 8)', () => {
  it('never calls the backend from list, admit or status, or from get while the key is held', async () => {
    vault.commit({ entryId: 'entry-a' });
    const { repository } = await vault.restart();
    vault.calls.reads = 0;
    vault.calls.statuses = 0;
    vault.advance(60_000);

    await repository.list();
    repository.admit(pin('entry-a'));
    repository.status();
    await repository.get(ref('entry-a'));

    expect(vault.calls).toEqual({ reads: 0, statuses: 0 });
  });

  it('probes once from concurrent gets while locked, throttled, and reads once unlocked', async () => {
    vault.commit({ entryId: 'entry-a' });
    vault.fake.inject({ kind: 'locked', evidence: 'reported' });
    const { repository } = await vault.restart();
    expect(vault.calls).toEqual({ reads: 1, statuses: 1 });

    await repository.get(ref('entry-a'));
    expect(vault.calls.reads).toBe(1);

    vault.advance(1_000);
    await Promise.all([
      repository.get(ref('entry-a')),
      repository.get(ref('entry-a')),
    ]);
    expect(vault.calls.reads).toBe(2);

    vault.fake.clearFaults();
    // admit, list and status keep the last observation until a probe.
    expect(repository.admit(pin('entry-a'))).toEqual({
      kind: 'blocked',
      reason: 'locked',
    });
    vault.advance(1_000);
    expect(await repository.get(ref('entry-a'))).toMatchObject({
      kind: 'available',
    });
    expect(repository.admit(pin('entry-a'))).toEqual({ kind: 'admitted' });
    expect(repository.status().protection.state).toBe('available');
  });

  it('never probes for a closed or missing entry', async () => {
    vault.recordPut('entry-new', 'create-1');
    vault.fake.inject({ kind: 'locked', evidence: 'reported' });
    const { repository } = await vault.restart();
    vault.advance(60_000);

    await repository.get(ref('entry-new'));
    await repository.get(ref('missing'));

    expect(vault.calls.reads).toBe(1);
  });

  it('never re-creates a missing or corrupt slot (plan Q4c item 7)', async () => {
    vault.commit({ entryId: 'entry-a' });
    for (const fault of ['key_missing', 'corrupt'] as const) {
      vault.fake.inject({ kind: fault, slot: vault.slotName });
      const opened = await vault.restart();
      vault.advance(60_000);
      await opened.repository.get(ref('entry-a'));
      await opened.refresh();

      expect(vault.fake.peek(vault.slotName)).toBe(
        fault === 'corrupt' ? 'corrupt' : null,
      );
    }
  });

  it('drops the key when a trusted refresh observes a lock', async () => {
    vault.commit({ entryId: 'entry-a' });
    const opened = await vault.restart();
    expect(opened.repository.admit(pin('entry-a'))).toEqual({
      kind: 'admitted',
    });

    vault.fake.inject({ kind: 'locked', evidence: 'reported' });
    await opened.refresh();

    await expectBlocked(opened.repository, 'entry-a', 'locked');
  });

  it.each([
    {
      fault: { kind: 'locked', evidence: 'reported' },
      reason: 'locked',
      refined: { state: 'locked', evidence: 'reported' },
    },
    {
      fault: { kind: 'unavailable', reason: 'no_backend' },
      reason: 'unavailable',
      refined: { state: 'unavailable', reason: 'no_backend' },
    },
  ] as const)(
    'blocks get and admit as soon as the slot reads $fault.kind, before status() refines it',
    async ({ fault, reason, refined }) => {
      vault.commit({ entryId: 'entry-a' });
      const opened = await vault.restart();
      const { repository } = opened;
      const status = vault.holdNextStatus();

      vault.fake.inject(fault);
      const refreshing = opened.refresh();
      await status.started;

      expect(repository.admit(pin('entry-a'))).toEqual({
        kind: 'blocked',
        reason,
      });
      expect(repository.status().protection).toMatchObject({ state: reason });
      const read = repository.get(ref('entry-a'));
      status.release();

      expect(await read).toEqual({ kind: 'blocked', reason });
      await refreshing;
      expect(repository.status().protection).toMatchObject(refined);
      // The open's read and the refresh's; get joined the refresh.
      expect(vault.calls.reads).toBe(2);
    },
  );
});
