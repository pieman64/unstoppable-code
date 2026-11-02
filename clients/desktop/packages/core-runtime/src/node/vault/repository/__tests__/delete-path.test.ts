import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  VaultDeleteOutcome,
  VaultDeleteRequest,
  VaultPutOutcome,
  VaultPutRequest,
  VaultSecretPin,
  VaultSecretRef,
} from '../../../../vault/contracts';
import type { VaultDeleteRefusalStep } from '../delete-path';
import type { VaultPutRefusalStep } from '../put-path';
import type { VaultReadRepository } from '../read-repository';
import { VAULT_STORE_FILE, type VaultStoreFaults } from '../store';
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

function deletion(
  pinned: VaultSecretPin,
  idempotencyKey = 'delete',
): VaultDeleteRequest {
  return { ref: pinned.ref, expectedRevision: pinned.revision, idempotencyKey };
}

function replace(
  pinned: VaultSecretPin,
  idempotencyKey = 'replace',
): Extract<VaultPutRequest, { expectedRevision: number }> {
  return {
    ref: pinned.ref,
    expectedRevision: pinned.revision,
    label: 'Rotated',
    material: encoder.encode('r0tated'),
    expiresAt: null,
    idempotencyKey,
  };
}

const create: Extract<VaultPutRequest, { entryId: null }> = {
  entryId: null,
  expectedRevision: null,
  family: FAMILY,
  label: 'Token',
  material: encoder.encode('s3cr3t'),
  expiresAt: null,
  idempotencyKey: 'create',
};

type WriteFault = 'not_written' | 'uncertain_landed' | 'uncertain_lost';

interface Subject {
  readonly opened: VaultReadRepository;
  readonly refusals: (VaultDeleteRefusalStep | VaultPutRefusalStep)[];
  /** Holds the next put at its hold point until the returned release. */
  holdPut(): () => void;
  /** Holds the next delete at its hold point until the returned release. */
  holdDelete(): () => void;
  failNextWrite(fault: WriteFault): void;
  /** Runs `during` as a microtask queued by the next write, before it settles. */
  duringNextWrite(during: () => void): void;
  intentCount(): number;
}

function gate(): { next(): () => void; take(): Promise<void> } {
  let held: Promise<void> | null = null;
  return {
    next(): () => void {
      let release = (): void => undefined;
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    take(): Promise<void> {
      const current = held;
      held = null;
      return current ?? Promise.resolve();
    },
  };
}

async function open(
  options: { readonly holdDelete?: () => Promise<void> } = {},
): Promise<Subject> {
  const refusals: Subject['refusals'] = [];
  const puts = gate();
  const deletes = gate();
  let fault: WriteFault | null = null;
  let during: (() => void) | null = null;
  const faults: VaultStoreFaults = {
    beforeWrite: () => {
      if (during !== null) queueMicrotask(during);
      during = null;
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
    holdPut: () => puts.take(),
    holdDelete: options.holdDelete ?? ((): Promise<void> => deletes.take()),
    onPutRefused: (refusal) => refusals.push(refusal.step),
    onDeleteRefused: (refusal) => refusals.push(refusal.step),
  });
  return {
    opened,
    refusals,
    holdPut: () => puts.next(),
    holdDelete: () => deletes.next(),
    failNextWrite(next): void {
      fault = next;
    },
    duringNextWrite(next): void {
      during = next;
    },
    intentCount: () => vault.store().listIntents().length,
  };
}

function tracked<T>(promise: Promise<T>): () => boolean {
  let settled = false;
  const settle = (): void => {
    settled = true;
  };
  void promise.then(settle, settle);
  return () => settled;
}

async function committedPin(
  result: Promise<VaultPutOutcome>,
): Promise<VaultSecretPin> {
  const outcome = await result;
  if (outcome.kind !== 'committed')
    throw new Error(`Not committed: ${JSON.stringify(outcome)}`);
  return structuredClone(outcome.pin);
}

function committed(entryId: string, tombstoneRevision = 1): unknown {
  return { kind: 'committed', ref: ref(entryId), tombstoneRevision };
}

async function expectDeleted(
  opened: VaultReadRepository,
  entryId: string,
): Promise<void> {
  expect(await opened.repository.get(ref(entryId))).toEqual({
    kind: 'not_found',
    reason: 'deleted',
  });
  expect(opened.repository.admit(pin(entryId))).toEqual({ kind: 'revoked' });
  const listed = await opened.repository.list();
  expect(listed.map((entry) => entry.ref.entryId)).not.toContain(entryId);
}

async function expectClosed(
  opened: VaultReadRepository,
  entryId: string,
): Promise<void> {
  expect(opened.repository.admit(pin(entryId))).toEqual({ kind: 'revoked' });
  expect(await opened.repository.get(ref(entryId))).toEqual({
    kind: 'unconfirmed',
    state: 'delete_unconfirmed',
  });
  expect(await opened.repository.list()).toContainEqual(
    expect.objectContaining({
      ref: ref(entryId),
      state: 'delete_unconfirmed',
    }),
  );
}

describe('vault delete commits a tombstone without the key (CAN-5441)', () => {
  it('closes admission and records the intent before returning, then tombstones after the hold', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    const release = subject.holdDelete();

    const pending = subject.opened
      .writer(FAMILY)
      .delete(deletion(pin('entry-a')));
    const settled = tracked(pending);

    await expectClosed(subject.opened, 'entry-a');
    expect(vault.store().listIntents().at(-1)).toMatchObject({
      kind: 'delete',
      family: FAMILY,
      idempotencyKey: 'delete',
      entryId: 'entry-a',
      expectedRevision: 0,
      state: 'pending',
    });
    expect(vault.store().readEntry('entry-a')).not.toBeNull();
    expect(settled()).toBe(false);

    release();
    expect(await pending).toEqual(committed('entry-a'));
    await expectDeleted(subject.opened, 'entry-a');
    expect(vault.store().readEntry('entry-a')).toBeNull();
    expect(vault.store().readTombstone('entry-a')).toMatchObject({
      revision: 1,
    });
    expect(vault.store().listIntents().at(-1)).toMatchObject({
      state: 'committed',
      outcomeRevision: 1,
    });
    await expectDeleted(await vault.restart(), 'entry-a');
  });

  it('runs while the slot is locked and never calls the key-slot backend', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    vault.fake.inject({ kind: 'locked', evidence: 'reported' });
    await subject.opened.refresh();
    expect(subject.opened.repository.status().protection.state).toBe('locked');
    vault.calls.reads = 0;
    vault.calls.statuses = 0;
    vault.advance(60_000);

    expect(
      await subject.opened.writer(FAMILY).delete(deletion(pin('entry-a'))),
    ).toEqual(committed('entry-a'));
    expect(vault.calls).toEqual({ reads: 0, statuses: 0 });
    expect(vault.store().readEntry('entry-a')).toBeNull();
  });

  /** True when either file on disk holds these bytes; nothing is closed first. */
  function onDisk(bytes: Buffer): boolean {
    const database = join(vault.dir.folder, VAULT_STORE_FILE);
    return [database, `${database}-wal`].some(
      (path) => existsSync(path) && readFileSync(path).includes(bytes),
    );
  }

  it('erases the ciphertext from the database file and the WAL when the tombstone commits', async () => {
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    // Written by this process, so the WAL also holds the frames that wrote it.
    const written = await committedPin(
      writer.put({ ...create, material: new Uint8Array(256) }),
    );
    const { entryId } = written.ref;
    const ciphertext = Buffer.from(
      vault.store().readEntry(entryId)?.sealed.ciphertext ?? [],
    );
    expect(ciphertext.byteLength).toBe(256);
    expect(onDisk(ciphertext)).toBe(true);

    expect(await writer.delete(deletion(written))).toEqual(committed(entryId));
    expect(onDisk(ciphertext)).toBe(false);
  });

  it('commits when the checkpoint after the tombstone fails, and the next open erases', async () => {
    vault.commit({ entryId: 'entry-a', material: new Uint8Array(256) });
    const ciphertext = Buffer.from(
      vault.store().readEntry('entry-a')?.sealed.ciphertext ?? [],
    );
    let failCheckpoint = false;
    const opened = await vault.restart({
      faults: {
        checkpoint: (checkpoint) => {
          if (failCheckpoint) throw new Error('injected checkpoint failure');
          return checkpoint();
        },
      },
    });
    failCheckpoint = true;

    expect(
      await opened.writer(FAMILY).delete(deletion(pin('entry-a'))),
    ).toEqual(committed('entry-a'));
    expect(vault.store().state).toBe('open');
    expect(onDisk(ciphertext)).toBe(true);

    await expectDeleted(await vault.restart(), 'entry-a');
    expect(onDisk(ciphertext)).toBe(false);
  });
});

describe('a delete that is not accepted (CAN-5441)', () => {
  /** One reported step, no intent, admission and listing unchanged. */
  async function expectNotAccepted(
    subject: Subject,
    remove: () => Promise<unknown>,
    expected: unknown,
    step: VaultDeleteRefusalStep,
  ): Promise<void> {
    const before = subject.intentCount();
    const listed = await subject.opened.repository.list();
    const admitted = subject.opened.repository.admit(pin('entry-a'));
    subject.refusals.length = 0;

    if (expected === TypeError)
      await expect(remove()).rejects.toThrow(TypeError);
    else expect(await remove()).toEqual(expected);

    expect(subject.refusals).toEqual([step]);
    expect(subject.intentCount()).toBe(before);
    expect(await subject.opened.repository.list()).toEqual(listed);
    expect(subject.opened.repository.admit(pin('entry-a'))).toEqual(admitted);
  }

  it.each<readonly [string, unknown]>([
    ['a null request', null],
    ['an empty key', { idempotencyKey: '' }],
    ['a long key', { idempotencyKey: 'x'.repeat(513) }],
    ['a lone surrogate key', { idempotencyKey: '\uD800' }],
    ['a negative revision', { expectedRevision: -1 }],
    ['a fractional revision', { expectedRevision: 0.5 }],
    ['a missing ref', { ref: undefined }],
    ['a lone surrogate entry ID', { ref: { vaultId: 'v', entryId: '\uDC00' } }],
    ['an unknown field', { extra: true }],
  ])('rejects %s with a TypeError', async (_name, change) => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    const remove = (input: VaultDeleteRequest): Promise<unknown> =>
      writer.delete(input);
    const request =
      change === null ? null : { ...deletion(pin('entry-a')), ...change };

    await expectNotAccepted(
      subject,
      // Malformed input, as an untyped caller would send it.
      async (): Promise<void> => {
        await Reflect.apply(remove, undefined, [request]);
      },
      TypeError,
      'validation',
    );
  });

  it('refuses another family, and a copied family property widens nothing', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    const other = subject.opened.writer('other.family');
    const refused = { kind: 'refused', reason: 'managed_family' };

    for (const writer of [other, { ...other, family: FAMILY }])
      await expectNotAccepted(
        subject,
        () => writer.delete(deletion(pin('entry-a'))),
        refused,
        'managed_family',
      );
  });

  it.each([
    ['absent', (): VaultSecretRef => ref('missing'), 'absent'],
    [
      'foreign',
      (): VaultSecretRef => ({ vaultId: 'other', entryId: 'entry-a' }),
      'foreign_vault',
    ],
    ['deleted', (): VaultSecretRef => ref('entry-b'), 'deleted'],
  ] as const)(
    'reports a %s ref as not found',
    async (_name, target, reason) => {
      vault.commit({ entryId: 'entry-a' });
      vault.commit({ entryId: 'entry-b' });
      vault.tombstone('entry-b', 0);
      const subject = await open();

      await expectNotAccepted(
        subject,
        () =>
          subject.opened
            .writer(FAMILY)
            .delete({ ...deletion(pin('entry-a')), ref: target() }),
        { kind: 'not_found', reason },
        'not_found',
      );
    },
  );

  it('refuses changed input under an accepted key, and a key a put accepted', async () => {
    vault.commit({ entryId: 'entry-a' });
    vault.commit({ entryId: 'entry-b' });
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    expect(await writer.delete(deletion(pin('entry-b')))).toEqual(
      committed('entry-b'),
    );
    await committedPin(writer.put(replace(pin('entry-a'))));
    const conflict = { kind: 'idempotency_conflict' };

    for (const changed of [
      deletion(pin('entry-a')),
      deletion(pin('entry-b', 3)),
      {
        ...deletion(pin('entry-b')),
        ref: { vaultId: 'other', entryId: 'entry-b' },
      },
      // Put and delete share keys.
      deletion(pin('entry-a', 1), 'replace'),
    ])
      await expectNotAccepted(
        subject,
        () => writer.delete(changed),
        conflict,
        'idempotency',
      );
    expect(await writer.put(replace(pin('entry-a', 1), 'delete'))).toEqual(
      conflict,
    );
  });

  it('refuses a stale expected revision, and a revision past the last safe one', async () => {
    vault.commit({ entryId: 'entry-a' });
    vault.replace({ entryId: 'entry-a' }, Number.MAX_SAFE_INTEGER - 1);
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);

    await expectNotAccepted(
      subject,
      () => writer.delete(deletion(pin('entry-a', 0))),
      { kind: 'revision_conflict', currentRevision: Number.MAX_SAFE_INTEGER },
      'revision',
    );
    await expectNotAccepted(
      subject,
      () => writer.delete(deletion(pin('entry-a', Number.MAX_SAFE_INTEGER))),
      TypeError,
      'revision',
    );
  });

  it('refuses closure_unrecorded when the intent is not written, failing closed in-process only', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    const before = subject.intentCount();
    subject.failNextWrite('not_written');

    expect(await writer.delete(deletion(pin('entry-a')))).toEqual({
      kind: 'refused',
      reason: 'closure_unrecorded',
    });
    expect(subject.refusals).toEqual(['intent']);
    expect(subject.intentCount()).toBe(before);
    await expectClosed(subject.opened, 'entry-a');
    expect(await writer.put(replace(pin('entry-a')))).toEqual({
      kind: 'refused',
      reason: 'entry_closed',
    });

    // No durable effect: a restart reopens it.
    const restarted = await vault.restart();
    expect(restarted.repository.admit(pin('entry-a'))).toEqual({
      kind: 'admitted',
    });
    // The key was never reserved.
    expect(
      await restarted.writer(FAMILY).delete(deletion(pin('entry-a'))),
    ).toEqual(committed('entry-a'));
  });

  it('refuses closure_unrecorded once the store is closed', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    vault.store().close();

    expect(
      await subject.opened.writer(FAMILY).delete(deletion(pin('entry-a'))),
    ).toEqual({ kind: 'refused', reason: 'closure_unrecorded' });
    expect(subject.refusals).toEqual(['intent']);
    expect(subject.opened.repository.admit(pin('entry-a'))).toEqual({
      kind: 'revoked',
    });
  });

  it('keeps an entry closed when a put in flight commits past an unrecorded delete', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    const release = subject.holdPut();
    const pending = writer.put(replace(pin('entry-a')));
    subject.failNextWrite('not_written');
    expect(await writer.delete(deletion(pin('entry-a')))).toEqual({
      kind: 'refused',
      reason: 'closure_unrecorded',
    });
    release();

    // The refused delete superseded nothing.
    const replaced = await committedPin(pending);
    expect(replaced).toEqual(pin('entry-a', 1));
    expect(subject.opened.repository.admit(replaced)).toEqual({
      kind: 'revoked',
    });
    expect(await subject.opened.repository.get(ref('entry-a'))).toEqual({
      kind: 'unconfirmed',
      state: 'delete_unconfirmed',
    });
    const restarted = await vault.restart();
    expect(restarted.repository.admit(replaced)).toEqual({ kind: 'admitted' });
  });
});

describe('vault delete after acceptance (CAN-5441)', () => {
  it('reports unavailable when the tombstone is not written; a same-key retry while locked commits through the same intent', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    const release = subject.holdDelete();
    const pending = writer.delete(deletion(pin('entry-a')));
    subject.failNextWrite('not_written');
    release();

    expect(await pending).toEqual({ kind: 'unavailable', ref: ref('entry-a') });
    await expectClosed(subject.opened, 'entry-a');
    expect(vault.store().readEntry('entry-a')).not.toBeNull();
    const intents = subject.intentCount();
    vault.fake.inject({ kind: 'locked', evidence: 'reported' });
    await subject.opened.refresh();

    expect(await writer.delete(deletion(pin('entry-a')))).toEqual(
      committed('entry-a'),
    );
    expect(subject.intentCount()).toBe(intents);
    expect(subject.refusals).toEqual([]);
    await expectDeleted(subject.opened, 'entry-a');
  });

  it('reports unavailable when the hold point fails, then a same-key retry commits', async () => {
    vault.commit({ entryId: 'entry-a' });
    let failHold = true;
    const subject = await open({
      holdDelete: () =>
        failHold ? Promise.reject(new Error('hold failed')) : Promise.resolve(),
    });
    const writer = subject.opened.writer(FAMILY);

    expect(await writer.delete(deletion(pin('entry-a')))).toEqual({
      kind: 'unavailable',
      ref: ref('entry-a'),
    });
    await expectClosed(subject.opened, 'entry-a');
    failHold = false;
    expect(await writer.delete(deletion(pin('entry-a')))).toEqual(
      committed('entry-a'),
    );
  });

  it('retries an unavailable delete after a restart', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    const release = subject.holdDelete();
    const pending = subject.opened
      .writer(FAMILY)
      .delete(deletion(pin('entry-a')));
    subject.failNextWrite('not_written');
    release();
    expect((await pending).kind).toBe('unavailable');

    const restarted = await vault.restart();
    await expectClosed(restarted, 'entry-a');
    const writer = restarted.writer(FAMILY);
    expect(await writer.delete(deletion(pin('entry-a', 1)))).toEqual({
      kind: 'idempotency_conflict',
    });
    expect(await writer.delete(deletion(pin('entry-a')))).toEqual(
      committed('entry-a'),
    );
    expect(await writer.delete(deletion(pin('entry-a')))).toEqual(
      committed('entry-a'),
    );
  });

  it.each(['uncertain_landed', 'uncertain_lost'] as const)(
    'reports outcome_unknown on an uncertain tombstone (%s) and keeps the entry closed',
    async (fault) => {
      vault.commit({ entryId: 'entry-a' });
      const subject = await open();
      const writer = subject.opened.writer(FAMILY);
      const release = subject.holdDelete();
      const pending = writer.delete(deletion(pin('entry-a')));
      subject.failNextWrite(fault);
      release();

      const unknown = { kind: 'outcome_unknown', ref: ref('entry-a') };
      expect(await pending).toEqual(unknown);
      expect(await writer.delete(deletion(pin('entry-a')))).toEqual(unknown);
      await expectClosed(subject.opened, 'entry-a');

      // The reopened store shows what landed.
      const restarted = await vault.restart();
      if (fault === 'uncertain_landed')
        await expectDeleted(restarted, 'entry-a');
      else await expectClosed(restarted, 'entry-a');
      expect(
        await restarted.writer(FAMILY).delete(deletion(pin('entry-a'))),
      ).toEqual(committed('entry-a'));
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
      expect(await writer.delete(deletion(pin('entry-a')))).toEqual(unknown);
      expect(subject.refusals).toEqual([]);
      await expectClosed(subject.opened, 'entry-a');
      expect(await writer.delete(deletion(pin('entry-a')))).toEqual(unknown);

      const restarted = await vault.restart();
      if (fault === 'uncertain_landed')
        await expectClosed(restarted, 'entry-a');
      else
        expect(restarted.repository.admit(pin('entry-a'))).toEqual({
          kind: 'admitted',
        });
      expect(
        await restarted.writer(FAMILY).delete(deletion(pin('entry-a'))),
      ).toEqual(committed('entry-a'));
    },
  );

  it('re-attempts an unavailable delete on a faulted or closed store as unavailable, never closure_unrecorded', async () => {
    vault.commit({ entryId: 'entry-a' });
    vault.commit({ entryId: 'entry-b' });
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    const release = subject.holdDelete();
    const pending = writer.delete(deletion(pin('entry-a')));
    subject.failNextWrite('not_written');
    release();
    const unavailable = { kind: 'unavailable', ref: ref('entry-a') };
    expect(await pending).toEqual(unavailable);
    subject.failNextWrite('uncertain_lost');
    expect((await writer.put(replace(pin('entry-b')))).kind).toBe(
      'outcome_unknown',
    );
    expect(vault.store().state).toBe('faulted');
    subject.refusals.length = 0;

    expect(await writer.delete(deletion(pin('entry-a')))).toEqual(unavailable);
    vault.store().close();
    expect(await writer.delete(deletion(pin('entry-a')))).toEqual(unavailable);
    expect(subject.refusals).toEqual([]);
    await expectClosed(subject.opened, 'entry-a');
  });

  it('replays a committed delete as a fresh copy, across a restart, with no second write', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    const first = await writer.delete(deletion(pin('entry-a')));
    expect(first).toEqual(committed('entry-a'));
    Object.assign(first, { tombstoneRevision: 9 });

    expect(await writer.delete(deletion(pin('entry-a')))).toEqual(
      committed('entry-a'),
    );
    const restarted = await vault.restart();
    expect(
      await restarted.writer(FAMILY).delete(deletion(pin('entry-a'))),
    ).toEqual(committed('entry-a'));
    expect(subject.intentCount()).toBe(2);
  });

  it('joins a same-key delete while the first is held', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    const release = subject.holdDelete();
    const first = writer.delete(deletion(pin('entry-a')));
    const joined = writer.delete(deletion(pin('entry-a')));
    release();

    expect(await joined).toEqual(await first);
    expect(subject.intentCount()).toBe(2);
  });
});

describe('a delete supersedes pending writes on its entry (CAN-5441)', () => {
  it.each([false, true])(
    'settles a held replace superseded without committing it (delete settles first: %s)',
    async (deleteFirst) => {
      vault.commit({ entryId: 'entry-a' });
      const subject = await open();
      const writer = subject.opened.writer(FAMILY);
      const releasePut = subject.holdPut();
      const put = writer.put(replace(pin('entry-a')));
      const joinedPut = writer.put(replace(pin('entry-a')));
      const releaseDelete = subject.holdDelete();
      const removal = writer.delete(deletion(pin('entry-a')));
      await expectClosed(subject.opened, 'entry-a');

      if (deleteFirst) {
        releaseDelete();
        expect(await removal).toEqual(committed('entry-a'));
      }
      releasePut();
      const superseded = { kind: 'superseded', ref: ref('entry-a') };
      expect(await put).toEqual(superseded);
      expect(await joinedPut).toEqual(superseded);
      // The superseded put wrote no revision.
      expect(vault.store().findIntent(FAMILY, 'replace')?.state).toBe(
        'pending',
      );
      expect(await writer.put(replace(pin('entry-a')))).toEqual(superseded);
      if (!deleteFirst) {
        await expectClosed(subject.opened, 'entry-a');
        releaseDelete();
        expect(await removal).toEqual(committed('entry-a'));
      }
      await expectDeleted(subject.opened, 'entry-a');

      const restarted = await vault.restart();
      expect(
        await restarted.writer(FAMILY).put(replace(pin('entry-a'))),
      ).toEqual(superseded);
    },
  );

  it('supersedes a pending create, which stays deleted', async () => {
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    const releasePut = subject.holdPut();
    const pending = writer.put(create);
    const [listed] = await subject.opened.repository.list();
    if (listed === undefined) throw new Error('Pending create not listed.');
    const { entryId } = listed.ref;

    expect(await writer.delete(deletion(pin(entryId)))).toEqual(
      committed(entryId),
    );
    releasePut();

    const superseded = { kind: 'superseded', ref: ref(entryId) };
    expect(await pending).toEqual(superseded);
    expect(await writer.put(create)).toEqual(superseded);
    await expectDeleted(subject.opened, entryId);
    expect(vault.store().listEntries()).toEqual([]);
  });

  it('supersedes a retained unavailable put, which a same-key retry cannot re-attempt', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    const releasePut = subject.holdPut();
    const put = writer.put(replace(pin('entry-a')));
    subject.failNextWrite('not_written');
    releasePut();
    expect((await put).kind).toBe('unavailable');

    const releaseDelete = subject.holdDelete();
    const removal = writer.delete(deletion(pin('entry-a')));
    subject.failNextWrite('not_written');
    releaseDelete();
    expect(await removal).toEqual({ kind: 'unavailable', ref: ref('entry-a') });

    const superseded = { kind: 'superseded', ref: ref('entry-a') };
    expect(await writer.put(replace(pin('entry-a')))).toEqual(superseded);
    await expectClosed(subject.opened, 'entry-a');
    expect(await writer.delete(deletion(pin('entry-a')))).toEqual(
      committed('entry-a'),
    );
  });

  it.each([false, true])(
    'fences an older delete behind a later one (later settles first: %s)',
    async (latestFirst) => {
      vault.commit({ entryId: 'entry-a' });
      const subject = await open();
      const writer = subject.opened.writer(FAMILY);
      const releaseOlder = subject.holdDelete();
      const older = writer.delete(deletion(pin('entry-a'), 'older'));
      const releaseLatest = subject.holdDelete();
      const latest = writer.delete(deletion(pin('entry-a'), 'latest'));

      if (latestFirst) {
        subject.failNextWrite('not_written');
        releaseLatest();
        expect((await latest).kind).toBe('unavailable');
      }
      releaseOlder();
      const superseded = { kind: 'superseded', ref: ref('entry-a') };
      expect(await older).toEqual(superseded);
      await expectClosed(subject.opened, 'entry-a');
      if (!latestFirst) {
        subject.failNextWrite('not_written');
        releaseLatest();
        expect((await latest).kind).toBe('unavailable');
      }

      // Both stay fenced across a restart; the later key still recovers.
      const restarted = await vault.restart();
      const again = restarted.writer(FAMILY);
      expect(await again.delete(deletion(pin('entry-a'), 'older'))).toEqual(
        superseded,
      );
      expect(await again.delete(deletion(pin('entry-a'), 'latest'))).toEqual(
        committed('entry-a'),
      );
      expect(vault.store().readTombstone('entry-a')?.sequence).toBe(
        vault.store().findIntent(FAMILY, 'latest')?.sequence,
      );
    },
  );

  it('keeps an older delete superseded when a later one is accepted while its failed tombstone settles', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    const releaseOlder = subject.holdDelete();
    const older = writer.delete(deletion(pin('entry-a'), 'older'));
    const later: Promise<VaultDeleteOutcome>[] = [];
    let releaseLatest = (): void => undefined;
    subject.failNextWrite('not_written');
    subject.duringNextWrite(() => {
      releaseLatest = subject.holdDelete();
      later.push(writer.delete(deletion(pin('entry-a'), 'latest')));
    });
    releaseOlder();

    const superseded = { kind: 'superseded', ref: ref('entry-a') };
    expect(await older).toEqual(superseded);
    const [latest] = later;
    if (latest === undefined) throw new Error('Later delete not issued.');
    expect(await writer.delete(deletion(pin('entry-a'), 'older'))).toEqual(
      superseded,
    );
    releaseLatest();
    expect(await latest).toEqual(committed('entry-a'));
    expect(await writer.delete(deletion(pin('entry-a'), 'older'))).toEqual(
      superseded,
    );
    const restarted = await vault.restart();
    expect(
      await restarted.writer(FAMILY).delete(deletion(pin('entry-a'), 'older')),
    ).toEqual(superseded);
  });

  it('keeps a put superseded when a delete is accepted while its failed write settles', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    const releasePut = subject.holdPut();
    const put = writer.put(replace(pin('entry-a')));
    const later: Promise<VaultDeleteOutcome>[] = [];
    let releaseDelete = (): void => undefined;
    subject.failNextWrite('not_written');
    subject.duringNextWrite(() => {
      releaseDelete = subject.holdDelete();
      later.push(writer.delete(deletion(pin('entry-a'))));
    });
    releasePut();

    const superseded = { kind: 'superseded', ref: ref('entry-a') };
    expect(await put).toEqual(superseded);
    const [removal] = later;
    if (removal === undefined) throw new Error('Delete not issued.');
    expect(await writer.put(replace(pin('entry-a')))).toEqual(superseded);
    releaseDelete();
    expect(await removal).toEqual(committed('entry-a'));
    expect(await writer.put(replace(pin('entry-a')))).toEqual(superseded);
    const restarted = await vault.restart();
    expect(await restarted.writer(FAMILY).put(replace(pin('entry-a')))).toEqual(
      superseded,
    );
  });

  it('keeps a put committed when a delete of its revision is accepted while it settles', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    const releasePut = subject.holdPut();
    const put = writer.put(replace(pin('entry-a')));
    const later: Promise<VaultDeleteOutcome>[] = [];
    let releaseDelete = (): void => undefined;
    subject.duringNextWrite(() => {
      releaseDelete = subject.holdDelete();
      later.push(writer.delete(deletion(pin('entry-a', 1))));
    });
    releasePut();

    const replaced = { kind: 'committed', pin: pin('entry-a', 1) };
    expect(await put).toEqual(replaced);
    const [removal] = later;
    if (removal === undefined) throw new Error('Delete not issued.');
    expect(await writer.put(replace(pin('entry-a')))).toEqual(replaced);
    releaseDelete();
    expect(await removal).toEqual(committed('entry-a', 2));
    expect(await writer.put(replace(pin('entry-a')))).toEqual(replaced);
  });

  it('reports an older delete superseded when its hold point fails after a later one was accepted', async () => {
    vault.commit({ entryId: 'entry-a' });
    let failOlder = (): void => undefined;
    let holds = 0;
    const subject = await open({
      holdDelete: () => {
        holds += 1;
        if (holds > 1) return Promise.resolve();
        return new Promise<void>((_resolve, reject) => {
          failOlder = (): void => reject(new Error('hold failed'));
        });
      },
    });
    const writer = subject.opened.writer(FAMILY);
    const older = writer.delete(deletion(pin('entry-a'), 'older'));
    const latest = writer.delete(deletion(pin('entry-a'), 'latest'));
    failOlder();

    const superseded = { kind: 'superseded', ref: ref('entry-a') };
    expect(await older).toEqual(superseded);
    expect(await latest).toEqual(committed('entry-a'));
    expect(await writer.delete(deletion(pin('entry-a'), 'older'))).toEqual(
      superseded,
    );
  });

  it('reports a put superseded when its hold point fails after a delete was accepted', async () => {
    vault.commit({ entryId: 'entry-a' });
    let failHold = (): void => undefined;
    const opened = await vault.restart({
      holdPut: () =>
        new Promise<void>((_resolve, reject) => {
          failHold = (): void => reject(new Error('hold failed'));
        }),
    });
    const writer = opened.writer(FAMILY);
    const put = writer.put(replace(pin('entry-a')));
    const removal = writer.delete(deletion(pin('entry-a')));
    failHold();

    const superseded = { kind: 'superseded', ref: ref('entry-a') };
    expect(await put).toEqual(superseded);
    expect(await removal).toEqual(committed('entry-a'));
    expect(await writer.put(replace(pin('entry-a')))).toEqual(superseded);
  });

  it('lets a refused delete supersede nothing', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    const release = subject.holdPut();
    const pending = writer.put(replace(pin('entry-a')));

    expect(
      await subject.opened
        .writer('other.family')
        .delete(deletion(pin('entry-a'))),
    ).toEqual({ kind: 'refused', reason: 'managed_family' });
    expect(await writer.delete(deletion(pin('entry-a', 1)))).toEqual({
      kind: 'revision_conflict',
      currentRevision: 0,
    });
    expect(await writer.delete(deletion(pin('entry-a'), 'replace'))).toEqual({
      kind: 'idempotency_conflict',
    });
    release();

    const replaced = await committedPin(pending);
    expect(subject.opened.repository.admit(replaced)).toEqual({
      kind: 'admitted',
    });
  });
});
