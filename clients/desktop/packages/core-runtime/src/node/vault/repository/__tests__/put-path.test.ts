import type {
  VaultPutOutcome,
  VaultPutRequest,
  VaultSecretPin,
  VaultSecretRef,
} from '../../../../vault/contracts';
import type { VaultPutRefusalStep } from '../put-path';
import type { VaultReadRepository } from '../read-repository';
import type { VaultStoreFaults } from '../store';
import {
  FAMILY,
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

const encoder = new TextEncoder();

function ref(entryId: string): VaultSecretRef {
  return { vaultId: vault.header.vaultId, entryId };
}

function pin(entryId: string, revision = 0): VaultSecretPin {
  return { ref: ref(entryId), revision };
}

function create(
  idempotencyKey = 'create',
  overrides: Partial<Extract<VaultPutRequest, { entryId: null }>> = {},
): Extract<VaultPutRequest, { entryId: null }> {
  return {
    entryId: null,
    expectedRevision: null,
    family: FAMILY,
    label: 'Token',
    material: encoder.encode('s3cr3t'),
    expiresAt: null,
    idempotencyKey,
    ...overrides,
  };
}

function replace(
  pinned: VaultSecretPin,
  idempotencyKey = 'replace',
  overrides: Partial<
    Extract<VaultPutRequest, { expectedRevision: number }>
  > = {},
): Extract<VaultPutRequest, { expectedRevision: number }> {
  return {
    ref: pinned.ref,
    expectedRevision: pinned.revision,
    label: 'Rotated',
    material: encoder.encode('r0tated'),
    expiresAt: null,
    idempotencyKey,
    ...overrides,
  };
}

type WriteFault = 'not_written' | 'uncertain_landed' | 'uncertain_lost';

/** One opened vault with a commit hold, store faults and the refusal log. */
interface Subject {
  readonly opened: VaultReadRepository;
  readonly refusals: VaultPutRefusalStep[];
  /** Holds the next put at its hold point until `release`. */
  holdNext(): () => void;
  /** Fails the next store write. */
  failNextWrite(fault: WriteFault): void;
  intentCount(): number;
}

async function open(): Promise<Subject> {
  const refusals: VaultPutRefusalStep[] = [];
  let gate: Promise<void> | null = null;
  let fault: WriteFault | null = null;
  const faults: VaultStoreFaults = {
    beforeWrite: () => {
      if (fault !== 'not_written') return;
      fault = null;
      throw new Error('injected write failure');
    },
    sync: (commit) => {
      const armed = fault;
      fault = null;
      if (armed === 'uncertain_lost') throw new Error('injected sync failure');
      commit();
      if (armed === 'uncertain_landed')
        throw new Error('injected sync failure');
    },
  };
  const opened = await vault.restart({
    faults,
    holdPut: () => {
      const held = gate;
      gate = null;
      return held ?? Promise.resolve();
    },
    onPutRefused: (refusal) => refusals.push(refusal.step),
  });
  return {
    opened,
    refusals,
    holdNext(): () => void {
      let release = (): void => undefined;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    failNextWrite(next): void {
      fault = next;
    },
    intentCount: () => vault.store().listIntents().length,
  };
}

function tracked<T>(promise: Promise<T>): { readonly settled: () => boolean } {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return { settled: () => settled };
}

async function committedPin(
  result: VaultPutOutcome | Promise<VaultPutOutcome>,
): Promise<VaultSecretPin> {
  const outcome = await result;
  if (outcome.kind !== 'committed')
    throw new Error(`Not committed: ${JSON.stringify(outcome)}`);
  expect(outcome.pin.ref.vaultId).toBe(vault.header.vaultId);
  return structuredClone(outcome.pin);
}

async function material(
  subject: Subject,
  entryId: string,
): Promise<string | null> {
  const read = await subject.opened.repository.get(ref(entryId));
  return read.kind === 'available'
    ? new TextDecoder().decode(read.material)
    : null;
}

describe('vault put commits through its intent (CAN-5427)', () => {
  it('creates an entry that is durable, readable and admitted', async () => {
    const subject = await open();
    const input = create();
    const pending = subject.opened.writer(FAMILY).put(input);
    input.material.fill(0);

    const created = await committedPin(pending);

    expect(created.revision).toBe(0);
    expect(await material(subject, created.ref.entryId)).toBe('s3cr3t');
    expect(subject.opened.repository.admit(created)).toEqual({
      kind: 'admitted',
    });
    expect(await subject.opened.repository.list()).toEqual([
      expect.objectContaining({
        ref: created.ref,
        family: FAMILY,
        label: 'Token',
        state: 'available',
      }),
    ]);
    const [intent] = vault.store().listIntents();
    expect(intent).toMatchObject({
      kind: 'put',
      family: FAMILY,
      idempotencyKey: 'create',
      entryId: created.ref.entryId,
      expectedRevision: null,
      state: 'committed',
      outcomeRevision: 0,
    });
    const [row] = vault.store().listEntries();
    expect(Buffer.from(row?.sealed.ciphertext ?? []).toString()).not.toContain(
      's3cr3t',
    );

    const restarted = await vault.restart();
    expect(await restarted.repository.get(created.ref)).toMatchObject({
      kind: 'available',
      pin: created,
    });
  });

  it('replaces by revision; the old pin turns stale', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();

    const replaced = await committedPin(
      subject.opened.writer(FAMILY).put(replace(pin('entry-a'))),
    );

    expect(replaced).toEqual(pin('entry-a', 1));
    expect(await material(subject, 'entry-a')).toBe('r0tated');
    expect(subject.opened.repository.admit(pin('entry-a'))).toEqual({
      kind: 'stale',
    });
    expect(subject.opened.repository.admit(replaced)).toEqual({
      kind: 'admitted',
    });
  });

  it('mints a new entry ID for every create', async () => {
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    const first = await committedPin(writer.put(create('one')));
    const second = await committedPin(writer.put(create('two')));

    expect(second.ref.entryId).not.toBe(first.ref.entryId);
    expect(vault.store().listEntries()).toHaveLength(2);
  });

  it('closes admission and records the intent before returning, and settles only after the hold', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    const release = subject.holdNext();

    const pending = subject.opened.writer(FAMILY).put(replace(pin('entry-a')));
    const progress = tracked(pending);

    expect(subject.opened.repository.admit(pin('entry-a'))).toEqual({
      kind: 'unconfirmed',
    });
    expect(vault.store().listIntents().at(-1)).toMatchObject({
      idempotencyKey: 'replace',
      state: 'pending',
    });
    expect(await subject.opened.repository.get(ref('entry-a'))).toEqual({
      kind: 'unconfirmed',
      state: 'unconfirmed',
    });
    expect(await subject.opened.repository.list()).toMatchObject([
      { state: 'unconfirmed', revision: 0 },
    ]);
    expect(vault.store().listEntries()[0]?.revision).toBe(0);
    expect(progress.settled()).toBe(false);

    release();
    expect(await committedPin(pending)).toEqual(pin('entry-a', 1));
  });

  it('lists a pending create as unconfirmed under the ref it commits', async () => {
    const subject = await open();
    const release = subject.holdNext();
    const pending = subject.opened.writer(FAMILY).put(create());

    const listed = await subject.opened.repository.list();
    expect(listed).toMatchObject([{ label: 'Token', state: 'unconfirmed' }]);
    release();

    expect((await committedPin(pending)).ref).toEqual(listed[0]?.ref);
  });

  it('never calls the key-slot backend', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    vault.calls.reads = 0;
    vault.calls.statuses = 0;
    vault.advance(60_000);
    const writer = subject.opened.writer(FAMILY);

    await writer.put(create());
    await writer.put(replace(pin('entry-a')));
    vault.fake.inject({ kind: 'locked', evidence: 'reported' });
    await subject.opened.refresh();
    vault.calls.reads = 0;
    vault.calls.statuses = 0;
    vault.advance(60_000);
    await writer.put(create('locked'));

    expect(vault.calls).toEqual({ reads: 0, statuses: 0 });
  });
});

describe('a put that is not accepted leaves no record (CAN-5427)', () => {
  /** Every not-accepted put: one reported step, no intent, admission unchanged. */
  async function expectNotAccepted(
    subject: Subject,
    put: () => Promise<unknown>,
    expected: unknown,
    step: VaultPutRefusalStep,
  ): Promise<void> {
    const before = subject.intentCount();
    const listed = await subject.opened.repository.list();
    const admitted = subject.opened.repository.admit(pin('entry-a'));
    subject.refusals.length = 0;

    if (expected === TypeError) await expect(put()).rejects.toThrow(TypeError);
    else expect(await put()).toEqual(expected);

    expect(subject.refusals).toEqual([step]);
    expect(subject.intentCount()).toBe(before);
    expect(await subject.opened.repository.list()).toEqual(listed);
    expect(subject.opened.repository.admit(pin('entry-a'))).toEqual(admitted);
  }

  const invalid: readonly (readonly [string, Record<string, unknown>])[] = [
    ['empty material', { material: new Uint8Array() }],
    ['oversized material', { material: new Uint8Array(1_000_001) }],
    ['string material', { material: 's3cr3t' }],
    ['negative revision', { expectedRevision: -1 }],
    ['fractional revision', { expectedRevision: 0.5 }],
    ['empty label', { label: '' }],
    ['lone surrogate label', { label: 'bad \uD800' }],
    ['empty key', { idempotencyKey: '' }],
    ['long key', { idempotencyKey: 'x'.repeat(513) }],
    ['lone surrogate key', { idempotencyKey: '\uDC00' }],
    ['bad expiry', { expiresAt: 'not-a-timestamp' }],
    ['wire-only secret', { secret: 'unexpected' }],
    ['unknown field', { extra: true }],
  ];

  it.each(invalid)('rejects %s with a TypeError', async (_name, change) => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    const request = { ...replace(pin('entry-a')), ...change };

    await expectNotAccepted(
      subject,
      // Malformed input, as an untyped caller would send it.
      async () => Reflect.apply(writer.put.bind(writer), writer, [request]),
      TypeError,
      'validation',
    );
  });

  it('refuses another family before anything else', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    const other = subject.opened.writer('other.family');
    const refused = { kind: 'refused', reason: 'managed_family' };

    await expectNotAccepted(
      subject,
      () => other.put(create('a', { family: FAMILY })),
      refused,
      'managed_family',
    );
    await expectNotAccepted(
      subject,
      () => other.put(replace(pin('entry-a'))),
      refused,
      'managed_family',
    );
    // A family property copied onto another writer widens nothing.
    const stolen = { ...other, family: FAMILY };
    await expectNotAccepted(
      subject,
      () => stolen.put(create()),
      refused,
      'managed_family',
    );
    // A caller that edits a refusal cannot change the next one.
    const first = await other.put(create());
    Object.assign(first, { kind: 'committed' });
    expect(await other.put(create())).toEqual(refused);
  });

  it.each([
    ['absent', (): VaultSecretRef => ref('missing'), 'absent'],
    [
      'foreign',
      (): VaultSecretRef => ({ vaultId: 'other', entryId: 'entry-a' }),
      'foreign_vault',
    ],
  ] as const)(
    'reports a %s ref as not found',
    async (_name, target, reason) => {
      vault.commit({ entryId: 'entry-a' });
      const subject = await open();

      await expectNotAccepted(
        subject,
        () =>
          subject.opened
            .writer(FAMILY)
            .put({ ...replace(pin('entry-a')), ref: target() }),
        { kind: 'not_found', reason },
        'not_found',
      );
    },
  );

  it('reports a deleted ref as not found', async () => {
    vault.commit({ entryId: 'entry-a' });
    vault.commit({ entryId: 'entry-b' });
    vault.tombstone('entry-b', 0);
    const subject = await open();

    await expectNotAccepted(
      subject,
      () => subject.opened.writer(FAMILY).put(replace(pin('entry-b'))),
      { kind: 'not_found', reason: 'deleted' },
      'not_found',
    );
  });

  it('refuses changed input under an accepted key', async () => {
    vault.commit({ entryId: 'entry-a' });
    vault.commit({ entryId: 'entry-b' });
    vault.recordDelete('entry-b', 0, 'delete-b');
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    await committedPin(writer.put(create('accepted')));
    const conflict = { kind: 'idempotency_conflict' };

    for (const changed of [
      create('accepted', { label: 'Changed' }),
      create('accepted', { material: encoder.encode('other') }),
      create('accepted', { expiresAt: '2027-01-01T00:00:00.000Z' }),
      replace(pin('entry-a'), 'accepted'),
      // Put and delete share keys.
      replace(pin('entry-a'), 'delete-b'),
    ])
      await expectNotAccepted(
        subject,
        () => writer.put(changed),
        conflict,
        'idempotency',
      );
  });

  it('refuses a put against an entry another mutation holds closed', async () => {
    vault.commit({ entryId: 'entry-a' });
    vault.commit({ entryId: 'entry-b' });
    vault.recordDelete('entry-b', 0, 'delete-b');
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    const closed = { kind: 'refused', reason: 'entry_closed' };

    // A pending delete holds entry-b closed.
    await expectNotAccepted(
      subject,
      () => writer.put(replace(pin('entry-b'))),
      closed,
      'entry_closed',
    );

    const release = subject.holdNext();
    const pending = writer.put(replace(pin('entry-a')));
    subject.refusals.length = 0;
    const before = subject.intentCount();
    for (const competing of [
      replace(pin('entry-a'), 'competing'),
      // entry_closed is reported before revision_conflict.
      replace(pin('entry-a', 5), 'competing'),
    ])
      expect(await writer.put(competing)).toEqual(closed);
    expect(subject.refusals).toEqual(['entry_closed', 'entry_closed']);
    expect(subject.intentCount()).toBe(before);
    release();
    await committedPin(pending);

    // The refused key was never reserved.
    await committedPin(writer.put(replace(pin('entry-a', 1), 'competing')));
  });

  it('refuses a stale expected revision', async () => {
    vault.commit({ entryId: 'entry-a' });
    vault.replace({ entryId: 'entry-a' }, 0);
    const subject = await open();

    await expectNotAccepted(
      subject,
      () => subject.opened.writer(FAMILY).put(replace(pin('entry-a', 0))),
      { kind: 'revision_conflict', currentRevision: 1 },
      'revision',
    );
  });

  it.each([
    ['locked', { kind: 'locked', evidence: 'reported' }, 'locked'],
    ['denied', { kind: 'denied' }, 'denied'],
    [
      'unavailable',
      { kind: 'unavailable', reason: 'no_backend' },
      'unavailable',
    ],
  ] as const)(
    'blocks a put while the slot reads %s',
    async (_name, fault, reason) => {
      vault.commit({ entryId: 'entry-a' });
      const subject = await open();
      vault.fake.inject(fault);
      await subject.opened.refresh();
      const writer = subject.opened.writer(FAMILY);
      const blocked = { kind: 'blocked', reason };

      await expectNotAccepted(
        subject,
        () => writer.put(create()),
        blocked,
        'key',
      );
      await expectNotAccepted(
        subject,
        () => writer.put(replace(pin('entry-a'))),
        blocked,
        'key',
      );
      // revision_conflict is reported before blocked.
      expect(await writer.put(replace(pin('entry-a', 3)))).toEqual({
        kind: 'revision_conflict',
        currentRevision: 0,
      });
    },
  );

  it('blocks a put while the slot is missing', async () => {
    vault.fake.inject({ kind: 'key_missing', slot: vault.slotName });
    const subject = await open();

    await expectNotAccepted(
      subject,
      () => subject.opened.writer(FAMILY).put(create()),
      { kind: 'blocked', reason: 'key_missing' },
      'key',
    );
  });

  it('blocks a put as unavailable once the key holder has no observation', async () => {
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    subject.opened.dispose();

    await expectNotAccepted(
      subject,
      () => writer.put(create()),
      { kind: 'blocked', reason: 'unavailable' },
      'key',
    );
  });

  it('blocks a replace of a corrupt entry', async () => {
    vault.commit({ entryId: 'entry-a' });
    await vault.raw((db) =>
      db.exec(`UPDATE vault_entries SET tag = zeroblob(16)`),
    );
    const subject = await open();

    await expectNotAccepted(
      subject,
      () => subject.opened.writer(FAMILY).put(replace(pin('entry-a'))),
      { kind: 'blocked', reason: 'corrupt' },
      'corrupt',
    );
  });

  it('refuses closure_unrecorded when the intent is not written, reserving nothing', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    const unrecorded = { kind: 'refused', reason: 'closure_unrecorded' };

    subject.failNextWrite('not_written');
    await expectNotAccepted(
      subject,
      () => writer.put(create()),
      unrecorded,
      'intent',
    );
    expect(await subject.opened.repository.list()).toHaveLength(1);
    subject.failNextWrite('not_written');
    await expectNotAccepted(
      subject,
      () => writer.put(replace(pin('entry-a'))),
      unrecorded,
      'intent',
    );

    // Neither key was reserved.
    await committedPin(writer.put(create()));
    await committedPin(writer.put(replace(pin('entry-a'))));
  });

  it('reports blocked before closure_unrecorded', async () => {
    const subject = await open();
    vault.fake.inject({ kind: 'locked', evidence: 'reported' });
    await subject.opened.refresh();
    subject.failNextWrite('not_written');

    expect(await subject.opened.writer(FAMILY).put(create())).toEqual({
      kind: 'blocked',
      reason: 'locked',
    });
    expect(subject.refusals).toEqual(['key']);
  });

  it('rejects a replace past the last safe revision with a TypeError', async () => {
    vault.commit({ entryId: 'entry-a' });
    vault.replace({ entryId: 'entry-a' }, Number.MAX_SAFE_INTEGER - 1);
    const subject = await open();
    const last = pin('entry-a', Number.MAX_SAFE_INTEGER);

    await expectNotAccepted(
      subject,
      () => subject.opened.writer(FAMILY).put(replace(last)),
      TypeError,
      'revision',
    );
    expect(subject.opened.repository.admit(last)).toEqual({
      kind: 'admitted',
    });
  });

  it('refuses closure_unrecorded once the store is closed', async () => {
    const subject = await open();
    vault.store().close();

    expect(await subject.opened.writer(FAMILY).put(create())).toEqual({
      kind: 'refused',
      reason: 'closure_unrecorded',
    });
    expect(subject.refusals).toEqual(['intent']);
    expect(await subject.opened.repository.list()).toEqual([]);
  });
});

describe('vault put keyed receipts (CAN-5427)', () => {
  it('replays a committed put without a second write, as a fresh copy', async () => {
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    const first = await writer.put(create());
    if (first.kind !== 'committed') throw new Error(first.kind);
    const original = structuredClone(first.pin);
    first.pin.ref.entryId = 'mutated';

    const again = await writer.put(create());

    expect(again).toEqual({ kind: 'committed', pin: original });
    expect(await writer.put(create())).toEqual(again);
    expect(subject.intentCount()).toBe(1);
    expect(vault.store().listEntries()).toHaveLength(1);
    expect(subject.refusals).toEqual([]);
  });

  it('replays across a restart and after the entry is deleted', async () => {
    const subject = await open();
    const created = await committedPin(
      subject.opened.writer(FAMILY).put(create()),
    );

    const restarted = await vault.restart();
    expect(await restarted.writer(FAMILY).put(create())).toEqual({
      kind: 'committed',
      pin: created,
    });
    expect(
      await restarted.writer(FAMILY).put(create('create', { label: 'Other' })),
    ).toEqual({ kind: 'idempotency_conflict' });

    vault.tombstone(created.ref.entryId, 0);
    const afterDelete = await vault.restart();
    expect(await afterDelete.writer(FAMILY).put(create())).toEqual({
      kind: 'committed',
      pin: created,
    });
    expect(await afterDelete.repository.get(created.ref)).toEqual({
      kind: 'not_found',
      reason: 'deleted',
    });
  });

  it('replays a replace whose ref now reads deleted, rather than not_found', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    const replaced = await committedPin(
      subject.opened.writer(FAMILY).put(replace(pin('entry-a'))),
    );
    vault.tombstone('entry-a', 1);
    const restarted = await vault.restart();

    expect(await restarted.writer(FAMILY).put(replace(pin('entry-a')))).toEqual(
      { kind: 'committed', pin: replaced },
    );
    expect(
      await restarted.writer(FAMILY).put(replace(pin('entry-a'), 'never-used')),
    ).toEqual({ kind: 'not_found', reason: 'deleted' });
  });

  it('refuses another target under an accepted key, with or without the key', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    const release = subject.holdNext();
    const pending = writer.put(replace(pin('entry-a')));
    vault.fake.inject({ kind: 'locked', evidence: 'reported' });
    await subject.opened.refresh();
    release();
    expect((await pending).kind).toBe('unavailable');
    const conflict = { kind: 'idempotency_conflict' };

    for (const locked of [true, false]) {
      if (!locked) {
        vault.fake.clearFaults();
        await subject.opened.refresh();
      }
      // The receipt MAC binds this vault's ID, so only the stored target
      // tells a foreign ref with the same entry ID apart.
      expect(
        await writer.put({
          ...replace(pin('entry-a')),
          ref: { vaultId: 'other', entryId: 'entry-a' },
        }),
      ).toEqual(conflict);
      expect(await writer.put(replace(pin('entry-a', 1)))).toEqual(conflict);
      expect(await writer.put(create('replace'))).toEqual(conflict);
    }
    expect(await writer.put(replace(pin('entry-a')))).toEqual({
      kind: 'committed',
      pin: pin('entry-a', 1),
    });
  });

  it('replays superseded for a pending put that a later delete closed', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    const release = subject.holdNext();
    const pending = writer.put(replace(pin('entry-a')));
    subject.failNextWrite('not_written');
    release();
    expect((await pending).kind).toBe('unavailable');
    vault.recordDelete('entry-a', 0, 'delete-a');

    const restarted = await vault.restart();
    expect(await restarted.writer(FAMILY).put(replace(pin('entry-a')))).toEqual(
      { kind: 'superseded', ref: ref('entry-a') },
    );
    expect(restarted.repository.admit(pin('entry-a'))).toEqual({
      kind: 'revoked',
    });
  });

  it('joins a same-key retry while the first put is held', async () => {
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    const release = subject.holdNext();
    const first = writer.put(create());
    const joined = writer.put(create());

    expect(await writer.put(create('create', { label: 'Changed' }))).toEqual({
      kind: 'idempotency_conflict',
    });
    release();

    expect(await joined).toEqual(await first);
    expect(subject.intentCount()).toBe(1);
  });

  it('blocks a committed replay while the key is not held, since no receipt can be checked', async () => {
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    const created = await committedPin(writer.put(create()));
    vault.fake.inject({ kind: 'locked', evidence: 'reported' });
    await subject.opened.refresh();

    expect(await writer.put(create())).toEqual({
      kind: 'blocked',
      reason: 'locked',
    });
    expect(subject.refusals).toEqual(['key']);

    vault.fake.clearFaults();
    await subject.opened.refresh();
    expect(await writer.put(create())).toEqual({
      kind: 'committed',
      pin: created,
    });
  });
});

describe('vault put after acceptance (CAN-5427)', () => {
  function unavailableRef(outcome: VaultPutOutcome): VaultSecretRef {
    if (outcome.kind !== 'unavailable')
      throw new Error(`Not unavailable: ${JSON.stringify(outcome)}`);
    return structuredClone(outcome.ref);
  }

  it('reports unavailable when the commit is not written, then a same-key retry commits through the same intent', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    const release = subject.holdNext();
    const pending = writer.put(replace(pin('entry-a')));
    // The intent is already written: this fails the commit.
    subject.failNextWrite('not_written');
    release();

    expect(await pending).toEqual({ kind: 'unavailable', ref: ref('entry-a') });
    expect(subject.opened.repository.admit(pin('entry-a'))).toEqual({
      kind: 'unconfirmed',
    });
    expect(await writer.put(replace(pin('entry-a')))).toEqual({
      kind: 'committed',
      pin: pin('entry-a', 1),
    });
    expect(subject.intentCount()).toBe(2);
    expect(vault.store().listIntents().at(-1)).toMatchObject({
      idempotencyKey: 'replace',
      state: 'committed',
    });
  });

  it('reports unavailable when the key drops during the hold; a locked retry replays it, an unlocked one commits', async () => {
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    const release = subject.holdNext();
    const pending = writer.put(create());
    vault.fake.inject({ kind: 'locked', evidence: 'reported' });
    await subject.opened.refresh();
    release();

    const created = unavailableRef(await pending);
    expect(await writer.put(create())).toEqual({
      kind: 'unavailable',
      ref: created,
    });
    // Unverifiable while locked, so changed input replays the same outcome.
    expect(
      await writer.put(create('create', { material: encoder.encode('x') })),
    ).toEqual({ kind: 'unavailable', ref: created });
    expect(subject.refusals).toEqual([]);

    vault.fake.clearFaults();
    await subject.opened.refresh();
    expect(
      await writer.put(create('create', { material: encoder.encode('x') })),
    ).toEqual({ kind: 'idempotency_conflict' });
    expect(await writer.put(create())).toEqual({
      kind: 'committed',
      pin: { ref: created, revision: 0 },
    });
    expect(await material(subject, created.entryId)).toBe('s3cr3t');
    expect(subject.intentCount()).toBe(1);
  });

  it('joins a same-key retry made while locked, returning the unavailable it settles with', async () => {
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    const release = subject.holdNext();
    const first = writer.put(create());
    vault.fake.inject({ kind: 'locked', evidence: 'reported' });
    await subject.opened.refresh();
    const retry = writer.put(create());
    release();

    const created = unavailableRef(await first);
    expect(await retry).toEqual({ kind: 'unavailable', ref: created });
    expect(subject.refusals).toEqual([]);
  });

  it('reports unavailable when the hold point fails, then a same-key retry commits', async () => {
    vault.commit({ entryId: 'entry-a' });
    let failHold = true;
    const opened = await vault.restart({
      holdPut: () =>
        failHold ? Promise.reject(new Error('hold failed')) : Promise.resolve(),
    });
    const writer = opened.writer(FAMILY);

    expect(await writer.put(replace(pin('entry-a')))).toEqual({
      kind: 'unavailable',
      ref: ref('entry-a'),
    });
    expect(opened.repository.admit(pin('entry-a'))).toEqual({
      kind: 'unconfirmed',
    });
    failHold = false;
    expect(await writer.put(replace(pin('entry-a')))).toEqual({
      kind: 'committed',
      pin: pin('entry-a', 1),
    });
  });

  it('reopens an entry after restart once a same-key retry commits past a newer unavailable put', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    for (const key of ['older', 'newer']) {
      const release = subject.holdNext();
      const pending = writer.put(replace(pin('entry-a'), key));
      subject.failNextWrite('not_written');
      release();
      unavailableRef(await pending);
    }
    const committed = await committedPin(
      writer.put(replace(pin('entry-a'), 'older')),
    );

    const restarted = await vault.restart();
    expect(await restarted.repository.get(ref('entry-a'))).toMatchObject({
      kind: 'available',
      pin: committed,
    });
    expect(
      await restarted.writer(FAMILY).put(replace(pin('entry-a'), 'newer')),
    ).toEqual({ kind: 'revision_conflict', currentRevision: 1 });
  });

  it('lets a new put confirm a successor to an unavailable replace; the old key then conflicts on revision', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    const release = subject.holdNext();
    const pending = writer.put(replace(pin('entry-a')));
    subject.failNextWrite('not_written');
    release();
    unavailableRef(await pending);

    const successor = await committedPin(
      writer.put(
        replace(pin('entry-a'), 'new-put', {
          material: encoder.encode('n3w'),
        }),
      ),
    );

    expect(successor).toEqual(pin('entry-a', 1));
    expect(await writer.put(replace(pin('entry-a')))).toEqual({
      kind: 'revision_conflict',
      currentRevision: 1,
    });
    expect(await material(subject, 'entry-a')).toBe('n3w');
  });

  it('keeps an unavailable create closed across a restart, until a same-key retry commits it under its ID', async () => {
    const subject = await open();
    const release = subject.holdNext();
    const pending = subject.opened.writer(FAMILY).put(create());
    subject.failNextWrite('not_written');
    release();
    const created = unavailableRef(await pending);

    const restarted = await vault.restart();
    expect(restarted.repository.admit({ ref: created, revision: 0 })).toEqual({
      kind: 'unconfirmed',
    });
    expect(await restarted.writer(FAMILY).put(create())).toEqual({
      kind: 'committed',
      pin: { ref: created, revision: 0 },
    });
    expect(await restarted.repository.list()).toHaveLength(1);
  });

  it.each(['uncertain_landed', 'uncertain_lost'] as const)(
    'reports outcome_unknown on an uncertain commit (%s) and keeps the entry closed',
    async (fault) => {
      vault.commit({ entryId: 'entry-a' });
      const subject = await open();
      const writer = subject.opened.writer(FAMILY);
      const release = subject.holdNext();
      const pending = writer.put(replace(pin('entry-a')));
      subject.failNextWrite(fault);
      release();

      const unknown = { kind: 'outcome_unknown', ref: ref('entry-a') };
      expect(await pending).toEqual(unknown);
      expect(await writer.put(replace(pin('entry-a')))).toEqual(unknown);
      expect(await writer.put(replace(pin('entry-a'), 'competing'))).toEqual({
        kind: 'refused',
        reason: 'entry_closed',
      });
      expect(subject.opened.repository.admit(pin('entry-a'))).toEqual({
        kind: 'unconfirmed',
      });

      // The reopened store shows what landed.
      const restarted = await vault.restart();
      expect(
        await restarted.writer(FAMILY).put(replace(pin('entry-a'))),
      ).toEqual({ kind: 'committed', pin: pin('entry-a', 1) });
    },
  );

  it.each(['uncertain_landed', 'uncertain_lost'] as const)(
    'reports outcome_unknown when the intent write is uncertain (%s)',
    async (fault) => {
      vault.commit({ entryId: 'entry-a' });
      const subject = await open();
      const writer = subject.opened.writer(FAMILY);
      subject.failNextWrite(fault);

      const unknown = { kind: 'outcome_unknown', ref: ref('entry-a') };
      expect(await writer.put(replace(pin('entry-a')))).toEqual(unknown);
      expect(subject.refusals).toEqual([]);
      expect(subject.opened.repository.admit(pin('entry-a'))).toEqual({
        kind: 'unconfirmed',
      });
      expect(await writer.put(replace(pin('entry-a')))).toEqual(unknown);

      const restarted = await vault.restart();
      expect(restarted.repository.admit(pin('entry-a'))).toEqual(
        fault === 'uncertain_landed'
          ? { kind: 'unconfirmed' }
          : { kind: 'admitted' },
      );
      expect(
        await restarted.writer(FAMILY).put(replace(pin('entry-a'))),
      ).toEqual({ kind: 'committed', pin: pin('entry-a', 1) });
    },
  );
});
