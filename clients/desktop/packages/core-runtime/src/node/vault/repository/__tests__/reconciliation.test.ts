import { existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import type {
  VaultDeleteRequest,
  VaultPutOutcome,
  VaultPutRequest,
  VaultSecretPin,
  VaultSecretRef,
} from '../../../../vault/contracts';
import type { VaultReadRepository } from '../read-repository';
import { VAULT_TOMBSTONE_RETENTION_MS } from '../reconciliation';
import { VAULT_STORE_FILE, type VaultStoreFaults } from '../store';
import type * as StoreDatabase from '../store-database';
import { openVaultStoreDatabase } from '../store-database';
import { VAULT_STORE_SCHEMA } from '../store-schema';
import {
  FAMILY,
  createVaultHarness,
  type VaultHarness,
} from './read-repository-fixtures';
import { sealedBox } from './store-fixtures';

jest.mock('../store-database', () => {
  const actual = jest.requireActual<typeof StoreDatabase>('../store-database');
  return {
    ...actual,
    openVaultStoreDatabase: jest.fn(actual.openVaultStoreDatabase),
  };
});

const openDatabase = jest.mocked(openVaultStoreDatabase);
const actualOpenDatabase =
  jest.requireActual<typeof StoreDatabase>(
    '../store-database',
  ).openVaultStoreDatabase;

/**
 * Runs `change` once, inside the next reopen, after it closes the faulted
 * connection: Windows refuses to rename or remove a file SQLite holds open.
 * Only a reopen opens an `existing` file.
 */
function beforeNextReopen(change: () => void): void {
  openDatabase.mockImplementation((path, settings) => {
    if (settings.existing === true) {
      openDatabase.mockImplementation(actualOpenDatabase);
      change();
    }
    return actualOpenDatabase(path, settings);
  });
}

let vault: VaultHarness;

beforeEach(async () => {
  vault = await createVaultHarness();
});

afterEach(() => {
  openDatabase.mockImplementation(actualOpenDatabase);
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

function create(
  idempotencyKey = 'create',
): Extract<VaultPutRequest, { entryId: null }> {
  return {
    entryId: null,
    expectedRevision: null,
    family: FAMILY,
    label: 'Token',
    material: encoder.encode('s3cr3t'),
    expiresAt: null,
    idempotencyKey,
  };
}

type WriteFault = 'not_written' | 'uncertain_landed' | 'uncertain_lost';

interface Subject {
  readonly opened: VaultReadRepository;
  /** Holds the next put or delete at its hold point until the release. */
  hold(): () => void;
  failNextWrite(fault: WriteFault): void;
}

async function open(): Promise<Subject> {
  let held: Promise<void> | null = null;
  let fault: WriteFault | null = null;
  const take = (): Promise<void> => {
    const current = held;
    held = null;
    return current ?? Promise.resolve();
  };
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
    holdPut: take,
    holdDelete: take,
  });
  return {
    opened,
    hold(): () => void {
      let release = (): void => undefined;
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    failNextWrite(next): void {
      fault = next;
    },
  };
}

function committed(entryId: string, tombstoneRevision = 1): unknown {
  return { kind: 'committed', ref: ref(entryId), tombstoneRevision };
}

const superseded = (entryId: string): unknown => ({
  kind: 'superseded',
  ref: ref(entryId),
});

async function stateOf(
  opened: VaultReadRepository,
  entryId: string,
): Promise<unknown> {
  const listed = (await opened.repository.list()).find(
    (item) => item.ref.entryId === entryId,
  );
  return listed && { state: listed.state, revision: listed.revision };
}

async function committedPin(
  result: Promise<VaultPutOutcome>,
): Promise<VaultSecretPin> {
  const outcome = await result;
  if (outcome.kind !== 'committed')
    throw new Error(`Not committed: ${JSON.stringify(outcome)}`);
  return structuredClone(outcome.pin);
}

/** A put or delete accepted, then failed at its commit as `fault`. */
async function failedAtCommit<T>(
  subject: Subject,
  write: () => Promise<T>,
  fault: WriteFault,
): Promise<T> {
  const release = subject.hold();
  const pending = write();
  subject.failNextWrite(fault);
  release();
  return pending;
}

describe('restart reconciliation settles every pending intent (CAN-5448)', () => {
  it('a pending put stays unconfirmed until its same-key retry commits', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    await failedAtCommit(
      subject,
      () => subject.opened.writer(FAMILY).put(replace(pin('entry-a'))),
      'not_written',
    );

    const restarted = await vault.restart();
    expect(await stateOf(restarted, 'entry-a')).toEqual({
      state: 'unconfirmed',
      revision: 0,
    });
    expect(await restarted.writer(FAMILY).put(replace(pin('entry-a')))).toEqual(
      { kind: 'committed', pin: pin('entry-a', 1) },
    );
  });

  it('a pending put a committed put passed reopens the entry and conflicts on retry', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    await failedAtCommit(
      subject,
      () => writer.put(replace(pin('entry-a'))),
      'not_written',
    );
    await committedPin(writer.put(replace(pin('entry-a'), 'successor')));

    const restarted = await vault.restart();
    expect(await stateOf(restarted, 'entry-a')).toEqual({
      state: 'available',
      revision: 1,
    });
    expect(await restarted.writer(FAMILY).put(replace(pin('entry-a')))).toEqual(
      { kind: 'revision_conflict', currentRevision: 1 },
    );
  });

  it.each([false, true])(
    'a pending put a later delete superseded replays superseded (delete committed: %s)',
    async (deleteCommits) => {
      vault.commit({ entryId: 'entry-a' });
      const subject = await open();
      const writer = subject.opened.writer(FAMILY);
      await failedAtCommit(
        subject,
        () => writer.put(replace(pin('entry-a'))),
        'not_written',
      );
      if (deleteCommits)
        expect(await writer.delete(deletion(pin('entry-a')))).toEqual(
          committed('entry-a'),
        );
      else
        await failedAtCommit(
          subject,
          () => writer.delete(deletion(pin('entry-a'))),
          'not_written',
        );

      const restarted = await vault.restart();
      const again = restarted.writer(FAMILY);
      expect(await again.put(replace(pin('entry-a')))).toEqual(
        superseded('entry-a'),
      );
      expect(await stateOf(restarted, 'entry-a')).toEqual(
        deleteCommits
          ? undefined
          : { state: 'delete_unconfirmed', revision: 0 },
      );
      expect(await again.delete(deletion(pin('entry-a')))).toEqual(
        committed('entry-a'),
      );
    },
  );

  it('a committed put replays its pin', async () => {
    const subject = await open();
    const created = await committedPin(
      subject.opened.writer(FAMILY).put(create()),
    );

    const restarted = await vault.restart();
    expect(await restarted.writer(FAMILY).put(create())).toEqual({
      kind: 'committed',
      pin: created,
    });
  });

  it('a put whose uncertain commit landed under a later delete replays superseded, and the delete retries at its own revision', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    expect(
      await failedAtCommit(
        subject,
        () => writer.put(replace(pin('entry-a'))),
        'uncertain_landed',
      ),
    ).toEqual({ kind: 'outcome_unknown', ref: ref('entry-a') });
    expect(
      await failedAtCommit(
        subject,
        () => writer.delete(deletion(pin('entry-a'))),
        'not_written',
      ),
    ).toEqual({ kind: 'unavailable', ref: ref('entry-a') });
    expect(vault.store().readEntry('entry-a')?.revision).toBe(1);

    const restarted = await vault.restart();
    const again = restarted.writer(FAMILY);
    expect(await again.put(replace(pin('entry-a')))).toEqual(
      superseded('entry-a'),
    );
    expect(restarted.repository.admit(pin('entry-a', 1))).toEqual({
      kind: 'revoked',
    });
    expect(await stateOf(restarted, 'entry-a')).toEqual({
      state: 'delete_unconfirmed',
      revision: 0,
    });
    expect(await again.delete(deletion(pin('entry-a')))).toEqual(
      committed('entry-a'),
    );
    expect(vault.store().readEntry('entry-a')).toBeNull();
  });

  it('a pending delete stays delete_unconfirmed until its same-key retry commits', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    await failedAtCommit(
      subject,
      () => subject.opened.writer(FAMILY).delete(deletion(pin('entry-a'))),
      'not_written',
    );

    const restarted = await vault.restart();
    expect(await stateOf(restarted, 'entry-a')).toEqual({
      state: 'delete_unconfirmed',
      revision: 0,
    });
    expect(
      await restarted.writer(FAMILY).delete(deletion(pin('entry-a'))),
    ).toEqual(committed('entry-a'));
  });

  it('an older pending delete is superseded by a later one, committed or not', async () => {
    vault.commit({ entryId: 'entry-a' });
    vault.commit({ entryId: 'entry-b' });
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    for (const entryId of ['entry-a', 'entry-b'])
      await failedAtCommit(
        subject,
        () => writer.delete(deletion(pin(entryId), `older-${entryId}`)),
        'not_written',
      );
    await failedAtCommit(
      subject,
      () => writer.delete(deletion(pin('entry-a'), 'later-entry-a')),
      'not_written',
    );
    expect(
      await writer.delete(deletion(pin('entry-b'), 'later-entry-b')),
    ).toEqual(committed('entry-b'));

    const restarted = await vault.restart();
    const again = restarted.writer(FAMILY);
    for (const entryId of ['entry-a', 'entry-b'])
      expect(
        await again.delete(deletion(pin(entryId), `older-${entryId}`)),
      ).toEqual(superseded(entryId));
    expect(
      await again.delete(deletion(pin('entry-a'), 'later-entry-a')),
    ).toEqual(committed('entry-a'));
  });

  it('a committed delete replays its tombstone revision', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    expect(
      await subject.opened.writer(FAMILY).delete(deletion(pin('entry-a'))),
    ).toEqual(committed('entry-a'));

    const restarted = await vault.restart();
    expect(
      await restarted.writer(FAMILY).delete(deletion(pin('entry-a'))),
    ).toEqual(committed('entry-a'));
    expect(await restarted.repository.get(ref('entry-a'))).toEqual({
      kind: 'not_found',
      reason: 'deleted',
    });
  });
});

describe('a delete whose intent write was uncertain (CAN-5448, D2 handoff)', () => {
  /** A held write, then a delete whose intent write is lost, then the release. */
  async function lostSupersession(
    subject: Subject,
    write: () => Promise<unknown>,
  ): Promise<unknown> {
    const release = subject.hold();
    const pending = write();
    subject.failNextWrite('uncertain_lost');
    expect(
      await subject.opened
        .writer(FAMILY)
        .delete(deletion(pin('entry-a'), 'later')),
    ).toEqual({ kind: 'outcome_unknown', ref: ref('entry-a') });
    expect(vault.store().state).toBe('faulted');
    release();
    return pending;
  }

  it.each(['put', 'delete'] as const)(
    'is written before the %s it superseded reports superseded, so a restart cannot revive it',
    async (kind) => {
      vault.commit({ entryId: 'entry-a' });
      const subject = await open();
      const write = (
        target: VaultReadRepository,
      ): Promise<{ readonly kind: string }> =>
        kind === 'put'
          ? target.writer(FAMILY).put(replace(pin('entry-a')))
          : target.writer(FAMILY).delete(deletion(pin('entry-a'), 'earlier'));

      expect(
        await lostSupersession(subject, () => write(subject.opened)),
      ).toEqual(superseded('entry-a'));
      expect(vault.store().state).toBe('open');
      expect(vault.store().findIntent(FAMILY, 'later')).toMatchObject({
        kind: 'delete',
        entryId: 'entry-a',
        state: 'pending',
      });

      const restarted = await vault.restart();
      expect(await write(restarted)).toEqual(superseded('entry-a'));
      expect(await stateOf(restarted, 'entry-a')).toEqual({
        state: 'delete_unconfirmed',
        revision: 0,
      });
      expect(
        await restarted
          .writer(FAMILY)
          .delete(deletion(pin('entry-a'), 'later')),
      ).toEqual(committed('entry-a'));
    },
  );

  it('before the superseded put settles, a restart leaves that put retryable: nothing reported superseded', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    const release = subject.hold();
    void subject.opened.writer(FAMILY).put(replace(pin('entry-a')));
    subject.failNextWrite('uncertain_lost');
    expect(
      (
        await subject.opened
          .writer(FAMILY)
          .delete(deletion(pin('entry-a'), 'later'))
      ).kind,
    ).toBe('outcome_unknown');

    const restarted = await vault.restart();
    release();
    expect(await restarted.writer(FAMILY).put(replace(pin('entry-a')))).toEqual(
      { kind: 'committed', pin: pin('entry-a', 1) },
    );
  });

  it.each(['a new write', 'reconcile'] as const)(
    'is written once %s reopens the store, before any new intent',
    async (trigger) => {
      vault.commit({ entryId: 'entry-a' });
      const subject = await open();
      const writer = subject.opened.writer(FAMILY);
      subject.failNextWrite('uncertain_lost');
      expect((await writer.delete(deletion(pin('entry-a')))).kind).toBe(
        'outcome_unknown',
      );
      expect(vault.store().state).toBe('faulted');

      if (trigger === 'reconcile') await subject.opened.reconcile();
      else await committedPin(writer.put(create('other')));
      const intents = vault.store().listIntents();
      expect(
        intents.find((intent) => intent.idempotencyKey === 'delete'),
      ).toMatchObject({
        kind: 'delete',
        entryId: 'entry-a',
        state: 'pending',
      });
      if (trigger === 'a new write')
        expect(intents.at(-1)?.idempotencyKey).toBe('other');

      const restarted = await vault.restart();
      expect(await stateOf(restarted, 'entry-a')).toEqual({
        state: 'delete_unconfirmed',
        revision: 0,
      });
      expect(
        await restarted.writer(FAMILY).delete(deletion(pin('entry-a'))),
      ).toEqual(committed('entry-a'));
    },
  );

  /** A settled write on entry-a, then a delete whose intent write is lost. */
  async function settledThenLost(
    subject: Subject,
    kind: 'put' | 'delete',
  ): Promise<void> {
    const writer = subject.opened.writer(FAMILY);
    if (kind === 'put')
      expect(
        await failedAtCommit(
          subject,
          () => writer.put(replace(pin('entry-a'))),
          'uncertain_landed',
        ),
      ).toEqual({ kind: 'outcome_unknown', ref: ref('entry-a') });
    else
      expect(
        await failedAtCommit(
          subject,
          () => writer.delete(deletion(pin('entry-a'), 'earlier')),
          'not_written',
        ),
      ).toEqual({ kind: 'unavailable', ref: ref('entry-a') });
    subject.failNextWrite('uncertain_lost');
    expect(await writer.delete(deletion(pin('entry-a'), 'later'))).toEqual({
      kind: 'outcome_unknown',
      ref: ref('entry-a'),
    });
    expect(vault.store().state).toBe('faulted');
  }

  function retry(
    target: VaultReadRepository,
    kind: 'put' | 'delete',
  ): Promise<{ readonly kind: string }> {
    return kind === 'put'
      ? target.writer(FAMILY).put(replace(pin('entry-a')))
      : target.writer(FAMILY).delete(deletion(pin('entry-a'), 'earlier'));
  }

  it.each(['put', 'delete'] as const)(
    'is written before a %s that settled earlier replays superseded',
    async (kind) => {
      vault.commit({ entryId: 'entry-a' });
      const subject = await open();
      await settledThenLost(subject, kind);

      expect(await retry(subject.opened, kind)).toEqual(superseded('entry-a'));
      expect(vault.store().state).toBe('open');
      expect(vault.store().findIntent(FAMILY, 'later')).toMatchObject({
        kind: 'delete',
        state: 'pending',
      });

      const restarted = await vault.restart();
      expect(await retry(restarted, kind)).toEqual(superseded('entry-a'));
      expect(
        await restarted
          .writer(FAMILY)
          .delete(deletion(pin('entry-a'), 'later')),
      ).toEqual(committed('entry-a'));
    },
  );

  it.each(['put', 'delete'] as const)(
    'leaves a %s that settled earlier unknown while it cannot be written, and a restart decides',
    async (kind) => {
      vault.commit({ entryId: 'entry-a' });
      const subject = await open();
      await settledThenLost(subject, kind);
      vault.store().close();

      expect(await retry(subject.opened, kind)).toEqual({
        kind: 'outcome_unknown',
        ref: ref('entry-a'),
      });

      const restarted = await vault.restart();
      expect(await retry(restarted, kind)).toEqual(
        kind === 'put'
          ? { kind: 'committed', pin: pin('entry-a', 1) }
          : committed('entry-a'),
      );
    },
  );

  it('leaves a held put unknown when it settles while the delete cannot be written', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    const release = subject.hold();
    const put = writer.put(replace(pin('entry-a')));
    subject.failNextWrite('uncertain_lost');
    expect((await writer.delete(deletion(pin('entry-a'), 'later'))).kind).toBe(
      'outcome_unknown',
    );
    vault.store().close();
    release();
    expect(await put).toEqual({ kind: 'outcome_unknown', ref: ref('entry-a') });

    const restarted = await vault.restart();
    expect(await restarted.writer(FAMILY).put(replace(pin('entry-a')))).toEqual(
      { kind: 'committed', pin: pin('entry-a', 1) },
    );
  });

  it('keeps a write superseded by a durable delete superseded when a later delete is lost', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    const releasePut = subject.hold();
    const put = writer.put(replace(pin('entry-a')));
    expect(
      await failedAtCommit(
        subject,
        () => writer.delete(deletion(pin('entry-a'), 'durable')),
        'not_written',
      ),
    ).toEqual({ kind: 'unavailable', ref: ref('entry-a') });
    releasePut();
    expect(await put).toEqual(superseded('entry-a'));
    subject.failNextWrite('uncertain_lost');
    expect((await writer.delete(deletion(pin('entry-a'), 'later'))).kind).toBe(
      'outcome_unknown',
    );
    vault.store().close();

    expect(await writer.put(replace(pin('entry-a')))).toEqual(
      superseded('entry-a'),
    );
    expect(await writer.delete(deletion(pin('entry-a'), 'durable'))).toEqual({
      kind: 'outcome_unknown',
      ref: ref('entry-a'),
    });

    const restarted = await vault.restart();
    const again = restarted.writer(FAMILY);
    expect(await again.put(replace(pin('entry-a')))).toEqual(
      superseded('entry-a'),
    );
    expect(await again.delete(deletion(pin('entry-a'), 'durable'))).toEqual(
      committed('entry-a'),
    );
  });

  it('leaves a superseded create unknown when its own intent write was lost, since a restart forgets its key', async () => {
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    subject.failNextWrite('uncertain_lost');
    const unknown = await writer.put(create());
    if (unknown.kind !== 'outcome_unknown')
      throw new Error(`Not unknown: ${JSON.stringify(unknown)}`);
    expect(
      await writer.delete(deletion({ ref: unknown.ref, revision: 0 })),
    ).toEqual(committed(unknown.ref.entryId));

    expect(await writer.put(create())).toEqual(unknown);

    const restarted = await vault.restart();
    const created = await committedPin(restarted.writer(FAMILY).put(create()));
    expect(created.ref.entryId).not.toBe(unknown.ref.entryId);
  });

  it.each([
    ['after it settled', false],
    ['after it settled', true],
    ['while it settled', true],
  ] as const)(
    'leaves a create whose commit was uncertain unknown when a delete supersedes it %s (delete commits: %s), since a restart replays it committed',
    async (when, deleteCommits) => {
      const subject = await open();
      const writer = subject.opened.writer(FAMILY);
      const release = subject.hold();
      const pending = writer.put(create());
      const listed = (await subject.opened.repository.list())[0];
      if (listed === undefined) throw new Error('The create is not listed.');
      const created = pin(listed.ref.entryId);
      const unknown = { kind: 'outcome_unknown', ref: created.ref };
      subject.failNextWrite('uncertain_landed');
      release();
      let deleted: Promise<unknown> = Promise.resolve(null);
      // Runs after the create's commit and before its outcome settles.
      if (when === 'while it settled')
        void Promise.resolve().then(() => {
          deleted = writer.delete(deletion(created));
        });
      expect(await pending).toEqual(unknown);
      if (when === 'after it settled')
        deleted = deleteCommits
          ? writer.delete(deletion(created))
          : failedAtCommit(
              subject,
              () => writer.delete(deletion(created)),
              'not_written',
            );
      expect(await deleted).toEqual(
        deleteCommits
          ? committed(created.ref.entryId)
          : { kind: 'unavailable', ref: created.ref },
      );
      expect(await writer.put(create())).toEqual(unknown);

      const restarted = await vault.restart();
      expect(await restarted.writer(FAMILY).put(create())).toEqual({
        kind: 'committed',
        pin: created,
      });
      expect(restarted.repository.admit(created)).toEqual({ kind: 'revoked' });
    },
  );

  it('holds a later delete until the earlier lost one is written, so a restart keeps their order', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    subject.failNextWrite('uncertain_lost');
    expect(await writer.delete(deletion(pin('entry-a'), 'earlier'))).toEqual({
      kind: 'outcome_unknown',
      ref: ref('entry-a'),
    });

    // The reopen's rewrite of the earlier intent fails.
    subject.failNextWrite('not_written');
    expect(await writer.delete(deletion(pin('entry-a'), 'later'))).toEqual({
      kind: 'refused',
      reason: 'closure_unrecorded',
    });
    expect(vault.store().findIntent(FAMILY, 'earlier')).toBeNull();
    expect(vault.store().findIntent(FAMILY, 'later')).toBeNull();
    expect(await writer.delete(deletion(pin('entry-a'), 'earlier'))).toEqual({
      kind: 'outcome_unknown',
      ref: ref('entry-a'),
    });

    expect(
      await failedAtCommit(
        subject,
        () => writer.delete(deletion(pin('entry-a'), 'later')),
        'not_written',
      ),
    ).toEqual({ kind: 'unavailable', ref: ref('entry-a') });
    expect(
      vault
        .store()
        .listIntents()
        .filter((intent) => intent.kind === 'delete')
        .map((intent) => intent.idempotencyKey),
    ).toEqual(['earlier', 'later']);
    expect(await writer.delete(deletion(pin('entry-a'), 'earlier'))).toEqual(
      superseded('entry-a'),
    );

    const restarted = await vault.restart();
    const again = restarted.writer(FAMILY);
    expect(await again.delete(deletion(pin('entry-a'), 'earlier'))).toEqual(
      superseded('entry-a'),
    );
    expect(await again.delete(deletion(pin('entry-a'), 'later'))).toEqual(
      committed('entry-a'),
    );
  });

  it('is not written twice when it landed', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    subject.failNextWrite('uncertain_landed');
    expect(
      (await subject.opened.writer(FAMILY).delete(deletion(pin('entry-a'))))
        .kind,
    ).toBe('outcome_unknown');

    await subject.opened.reconcile();

    expect(vault.store().state).toBe('open');
    expect(
      vault
        .store()
        .listIntents()
        .filter((intent) => intent.kind === 'delete'),
    ).toEqual([expect.objectContaining({ idempotencyKey: 'delete' })]);
  });
});

describe('in-process reconciliation (CAN-5448)', () => {
  it('promotes an uncertain put that landed, and leaves one that did not unknown and closed', async () => {
    vault.commit({ entryId: 'entry-a' });
    vault.commit({ entryId: 'entry-b' });
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    await failedAtCommit(
      subject,
      () => writer.put(replace(pin('entry-a'))),
      'uncertain_landed',
    );
    await subject.opened.reconcile();
    await failedAtCommit(
      subject,
      () => writer.put(replace(pin('entry-b'), 'replace-b')),
      'uncertain_lost',
    );
    await subject.opened.reconcile();

    expect(await subject.opened.repository.get(ref('entry-a'))).toMatchObject({
      kind: 'available',
      pin: pin('entry-a', 1),
    });
    expect(await writer.put(replace(pin('entry-a')))).toEqual({
      kind: 'committed',
      pin: pin('entry-a', 1),
    });
    const unknown = { kind: 'outcome_unknown', ref: ref('entry-b') };
    expect(await writer.put(replace(pin('entry-b'), 'replace-b'))).toEqual(
      unknown,
    );
    expect(await writer.put(replace(pin('entry-b'), 'competing'))).toEqual({
      kind: 'refused',
      reason: 'entry_closed',
    });
    expect(subject.opened.repository.admit(pin('entry-b'))).toEqual({
      kind: 'unconfirmed',
    });
  });

  it('applies an uncertain tombstone that landed', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    expect(
      (
        await failedAtCommit(
          subject,
          () => writer.delete(deletion(pin('entry-a'))),
          'uncertain_landed',
        )
      ).kind,
    ).toBe('outcome_unknown');

    await subject.opened.reconcile();

    expect(await subject.opened.repository.get(ref('entry-a'))).toEqual({
      kind: 'not_found',
      reason: 'deleted',
    });
    expect(await writer.delete(deletion(pin('entry-a')))).toEqual(
      committed('entry-a'),
    );
  });

  it.each([
    ['landed', 'after it settled'],
    ['landed', 'while it settled'],
    ['lost', 'after it settled'],
    ['lost', 'while it settled'],
  ] as const)(
    'keeps a delete whose uncertain tombstone %s unknown when a later delete supersedes it %s, until reconcile settles it as a restart does',
    async (tombstone, when) => {
      vault.commit({ entryId: 'entry-a' });
      const subject = await open();
      const writer = subject.opened.writer(FAMILY);
      const unknown = { kind: 'outcome_unknown', ref: ref('entry-a') };
      const release = subject.hold();
      const earlier = writer.delete(deletion(pin('entry-a')));
      subject.failNextWrite(
        tombstone === 'landed' ? 'uncertain_landed' : 'uncertain_lost',
      );
      release();
      let later: Promise<unknown> = Promise.resolve(null);
      // Runs after the earlier tombstone and before its outcome settles.
      if (when === 'while it settled')
        void Promise.resolve().then(() => {
          later = writer.delete(deletion(pin('entry-a'), 'later'));
        });
      expect(await earlier).toEqual(unknown);
      if (when === 'after it settled')
        later = writer.delete(deletion(pin('entry-a'), 'later'));
      // A later tombstone conflicts with one that landed.
      expect(await later).toEqual(
        tombstone === 'landed'
          ? { kind: 'unavailable', ref: ref('entry-a') }
          : committed('entry-a'),
      );
      expect(await writer.delete(deletion(pin('entry-a')))).toEqual(unknown);

      await subject.opened.reconcile();

      const expectSettled = async (
        opened: VaultReadRepository,
      ): Promise<void> => {
        expect(await opened.repository.get(ref('entry-a'))).toEqual({
          kind: 'not_found',
          reason: 'deleted',
        });
        const again = opened.writer(FAMILY);
        expect(await again.delete(deletion(pin('entry-a')))).toEqual(
          tombstone === 'landed' ? committed('entry-a') : superseded('entry-a'),
        );
        expect(await again.delete(deletion(pin('entry-a'), 'later'))).toEqual(
          tombstone === 'landed' ? superseded('entry-a') : committed('entry-a'),
        );
      };
      await expectSettled(subject.opened);
      await expectSettled(await vault.restart());
    },
  );

  it.each(['landed', 'lost'] as const)(
    'settles a delete whose uncertain tombstone %s only once reconcile writes the later delete whose intent was lost',
    async (tombstone) => {
      vault.commit({ entryId: 'entry-a' });
      const subject = await open();
      const writer = subject.opened.writer(FAMILY);
      const unknown = { kind: 'outcome_unknown', ref: ref('entry-a') };
      await failedAtCommit(
        subject,
        () => writer.delete(deletion(pin('entry-a'))),
        tombstone === 'landed' ? 'uncertain_landed' : 'uncertain_lost',
      );
      subject.failNextWrite('uncertain_lost');
      expect(await writer.delete(deletion(pin('entry-a'), 'later'))).toEqual(
        unknown,
      );
      expect(vault.store().state).toBe('faulted');
      expect(await writer.delete(deletion(pin('entry-a')))).toEqual(unknown);

      await subject.opened.reconcile();

      expect(vault.store().findIntent(FAMILY, 'later')).toMatchObject({
        state: 'pending',
      });
      const expectSettled = async (
        opened: VaultReadRepository,
      ): Promise<void> => {
        const again = opened.writer(FAMILY);
        expect(await again.delete(deletion(pin('entry-a')))).toEqual(
          tombstone === 'landed' ? committed('entry-a') : superseded('entry-a'),
        );
        if (tombstone === 'landed')
          expect(await again.delete(deletion(pin('entry-a'), 'later'))).toEqual(
            superseded('entry-a'),
          );
      };
      await expectSettled(subject.opened);
      const restarted = await vault.restart();
      await expectSettled(restarted);
      if (tombstone === 'lost')
        expect(
          await restarted
            .writer(FAMILY)
            .delete(deletion(pin('entry-a'), 'later')),
        ).toEqual(committed('entry-a'));
    },
  );

  it.each(['landed', 'lost'] as const)(
    'settles two superseding deletes whose tombstone writes were both uncertain (the later one %s) as a restart does',
    async (later) => {
      vault.commit({ entryId: 'entry-a' });
      const subject = await open();
      const writer = subject.opened.writer(FAMILY);
      const unknown = { kind: 'outcome_unknown', ref: ref('entry-a') };
      await failedAtCommit(
        subject,
        () => writer.delete(deletion(pin('entry-a'))),
        'uncertain_lost',
      );
      expect(
        await failedAtCommit(
          subject,
          () => writer.delete(deletion(pin('entry-a'), 'later')),
          later === 'landed' ? 'uncertain_landed' : 'uncertain_lost',
        ),
      ).toEqual(unknown);
      expect(await writer.delete(deletion(pin('entry-a')))).toEqual(unknown);

      await subject.opened.reconcile();

      expect(await writer.delete(deletion(pin('entry-a')))).toEqual(
        superseded('entry-a'),
      );
      expect(await writer.delete(deletion(pin('entry-a'), 'later'))).toEqual(
        later === 'landed' ? committed('entry-a') : unknown,
      );
      const again = (await vault.restart()).writer(FAMILY);
      expect(await again.delete(deletion(pin('entry-a')))).toEqual(
        superseded('entry-a'),
      );
      // A lost later tombstone leaves its delete pending: the retry commits it.
      expect(await again.delete(deletion(pin('entry-a'), 'later'))).toEqual(
        committed('entry-a'),
      );
    },
  );

  it('applies a landed uncertain tombstone that reconcile finds while its delete settles, and settles that delete committed on the next reconcile', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    const unknown = { kind: 'outcome_unknown', ref: ref('entry-a') };
    const release = subject.hold();
    const pending = writer.delete(deletion(pin('entry-a')));
    subject.failNextWrite('uncertain_landed');
    release();
    let reconciled: Promise<void> = Promise.resolve();
    // Runs after the tombstone and before its delete settles.
    void Promise.resolve().then(() => {
      reconciled = subject.opened.reconcile();
    });
    expect(await pending).toEqual(unknown);
    await reconciled;

    expect(await subject.opened.repository.get(ref('entry-a'))).toEqual({
      kind: 'not_found',
      reason: 'deleted',
    });
    expect(await writer.delete(deletion(pin('entry-a')))).toEqual(unknown);
    await subject.opened.reconcile();
    expect(await writer.delete(deletion(pin('entry-a')))).toEqual(
      committed('entry-a'),
    );
    const restarted = await vault.restart();
    expect(
      await restarted.writer(FAMILY).delete(deletion(pin('entry-a'))),
    ).toEqual(committed('entry-a'));
  });

  it('settles a delete committed on the next reconcile when the reconcile that found its landed tombstone while it settled also pruned that tombstone', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    const unknown = { kind: 'outcome_unknown', ref: ref('entry-a') };
    const release = subject.hold();
    const pending = writer.delete(deletion(pin('entry-a')));
    subject.failNextWrite('uncertain_landed');
    release();
    let reconciled: Promise<void> = Promise.resolve();
    // Runs after the tombstone and before its delete settles.
    void Promise.resolve().then(() => {
      vault.advance(VAULT_TOMBSTONE_RETENTION_MS);
      reconciled = subject.opened.reconcile();
    });
    expect(await pending).toEqual(unknown);
    await reconciled;
    expect(vault.store().readTombstone('entry-a')).toBeNull();
    expect(await writer.delete(deletion(pin('entry-a')))).toEqual(unknown);

    await subject.opened.reconcile();

    const expectSettled = async (
      opened: VaultReadRepository,
    ): Promise<void> => {
      expect(await opened.repository.get(ref('entry-a'))).toEqual({
        kind: 'not_found',
        reason: 'absent',
      });
      expect(
        await opened.writer(FAMILY).delete(deletion(pin('entry-a'))),
      ).toEqual(committed('entry-a'));
    };
    await expectSettled(subject.opened);
    await expectSettled(await vault.restart());
  });

  it('keeps a delete whose uncertain tombstone landed unknown while the store cannot reopen, and a restart replays it committed', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    await failedAtCommit(
      subject,
      () => writer.delete(deletion(pin('entry-a'))),
      'uncertain_landed',
    );
    expect(await writer.delete(deletion(pin('entry-a'), 'later'))).toEqual({
      kind: 'unavailable',
      ref: ref('entry-a'),
    });
    vault.store().close();

    await subject.opened.reconcile();

    expect(await writer.delete(deletion(pin('entry-a')))).toEqual({
      kind: 'outcome_unknown',
      ref: ref('entry-a'),
    });
    const restarted = await vault.restart();
    expect(
      await restarted.writer(FAMILY).delete(deletion(pin('entry-a'))),
    ).toEqual(committed('entry-a'));
  });

  it('changes nothing when the store cannot reopen', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    await failedAtCommit(
      subject,
      () => writer.put(replace(pin('entry-a'))),
      'uncertain_landed',
    );
    vault.store().close();

    await subject.opened.reconcile();

    expect(vault.store().state).toBe('closed');
    expect(subject.opened.repository.admit(pin('entry-a'))).toEqual({
      kind: 'unconfirmed',
    });
    expect(await writer.put(replace(pin('entry-a')))).toEqual({
      kind: 'outcome_unknown',
      ref: ref('entry-a'),
    });
  });
});

describe('vault store reopen (CAN-5448)', () => {
  async function faultedStore(): Promise<void> {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    subject.failNextWrite('uncertain_landed');
    await subject.opened.writer(FAMILY).put(replace(pin('entry-a')));
    expect(vault.store().state).toBe('faulted');
  }

  it('reconnects to the file and shows what the uncertain write left', async () => {
    await faultedStore();

    expect(vault.store().reopen()).toBe(true);
    expect(vault.store().state).toBe('open');
    expect(vault.store().findIntent(FAMILY, 'replace')?.state).toBe('pending');
    expect(vault.store().durability()).toMatchObject({
      journalMode: 'wal',
      lockingMode: 'exclusive',
      synchronous: 2,
      fullfsync: true,
      secureDelete: true,
    });
  });

  it('never creates a missing database file', async () => {
    await faultedStore();
    const database = join(vault.dir.folder, VAULT_STORE_FILE);
    beforeNextReopen(() => {
      rmSync(database);
      rmSync(`${database}-wal`, { force: true });
    });

    expect(vault.store().reopen()).toBe(false);
    expect(vault.store().state).toBe('closed');
    expect(existsSync(database)).toBe(false);
    expect(() => vault.store().listEntries()).toThrow();
  });

  it('refuses a file that holds another header', async () => {
    await faultedStore();
    const other = await vault.dir.open({ folder: `${vault.dir.root}/other` });
    if (other.kind !== 'opened') throw new Error(other.step);
    other.store.writeHeader({
      vaultId: 'v0other1',
      wrappedDataKey: sealedBox(2),
    });
    other.store.close();
    beforeNextReopen(() =>
      renameSync(
        join(vault.dir.root, 'other', VAULT_STORE_FILE),
        join(vault.dir.folder, VAULT_STORE_FILE),
      ),
    );

    expect(vault.store().reopen()).toBe(false);
    expect(vault.store().state).toBe('closed');
  });

  it('is attempted once: the lock went with the old connection, so a file that comes back is not reconnected', async () => {
    vault.commit({ entryId: 'entry-b' });
    await faultedStore();
    const database = join(vault.dir.folder, VAULT_STORE_FILE);
    const aside = join(vault.dir.root, 'aside.sqlite');
    beforeNextReopen(() => renameSync(database, aside));

    expect(vault.store().reopen()).toBe(false);
    renameSync(aside, database);
    expect(vault.store().reopen()).toBe(false);
    expect(vault.store().state).toBe('closed');
    expect(
      vault.store().recordIntent({
        kind: 'delete',
        family: FAMILY,
        idempotencyKey: 'late',
        entryId: 'entry-b',
        expectedRevision: 0,
        receipt: new Uint8Array(32),
      }),
    ).toEqual({ kind: 'not_written', step: 'store' });
  });

  it('never reopens a closed store', async () => {
    await faultedStore();
    vault.store().close();

    expect(vault.store().reopen()).toBe(false);
    expect(vault.store().state).toBe('closed');
  });
});

describe('tombstone retention (CAN-5448)', () => {
  const DAY = 24 * 60 * 60 * 1_000;

  it('is 30 days', () => {
    expect(VAULT_TOMBSTONE_RETENTION_MS).toBe(30 * DAY);
  });

  /** Replaces entry-a to revision 1, then deletes it: both keys accepted. */
  async function replacedThenDeleted(): Promise<void> {
    vault.commit({ entryId: 'entry-a' });
    vault.commit({ entryId: 'entry-b' });
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    await committedPin(writer.put(replace(pin('entry-a'))));
    expect(await writer.delete(deletion(pin('entry-a', 1)))).toEqual(
      committed('entry-a', 2),
    );
  }

  async function expectReceiptsReplay(
    opened: VaultReadRepository,
  ): Promise<void> {
    const writer = opened.writer(FAMILY);
    expect(await writer.put(replace(pin('entry-a')))).toEqual({
      kind: 'committed',
      pin: pin('entry-a', 1),
    });
    expect(await writer.delete(deletion(pin('entry-a', 1)))).toEqual(
      committed('entry-a', 2),
    );
    const conflict = { kind: 'idempotency_conflict' };
    expect(await writer.put(replace(pin('entry-a', 1)))).toEqual(conflict);
    expect(await writer.delete(deletion(pin('entry-a', 0)))).toEqual(conflict);
    expect(await writer.put(replace(pin('entry-a', 2), 'replace-new'))).toEqual(
      { kind: 'not_found', reason: 'absent' },
    );
  }

  it('keeps a tombstone until 30 days after the delete committed, then removes only the tombstone', async () => {
    await replacedThenDeleted();

    vault.advance(VAULT_TOMBSTONE_RETENTION_MS - 1);
    const kept = await vault.restart();
    expect(await kept.repository.get(ref('entry-a'))).toEqual({
      kind: 'not_found',
      reason: 'deleted',
    });
    expect(
      await kept.writer(FAMILY).delete(deletion(pin('entry-a', 1))),
    ).toEqual(committed('entry-a', 2));

    const intents = vault.store().listIntents();
    vault.advance(1);
    const pruned = await vault.restart();
    expect(vault.store().readTombstone('entry-a')).toBeNull();
    expect(vault.store().listIntents()).toEqual(intents);
    expect(await pruned.repository.get(ref('entry-a'))).toEqual({
      kind: 'not_found',
      reason: 'absent',
    });
    expect(pruned.repository.admit(pin('entry-a', 1))).toEqual({
      kind: 'revoked',
    });
    expect(await stateOf(pruned, 'entry-a')).toBeUndefined();
    expect(await stateOf(pruned, 'entry-b')).toEqual({
      state: 'available',
      revision: 0,
    });
  });

  it('keeps every accepted receipt on a pruned entry replaying its outcome', async () => {
    await replacedThenDeleted();
    vault.advance(VAULT_TOMBSTONE_RETENTION_MS);
    const pruned = await vault.restart();
    expect(vault.store().readTombstone('entry-a')).toBeNull();

    await expectReceiptsReplay(pruned);
    expect(vault.store().readEntry('entry-a')).toBeNull();
    await expectReceiptsReplay(await vault.restart());
  });

  it('replays a same-key create after its entry was pruned, and never creates another entry', async () => {
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    const created = await committedPin(writer.put(create()));
    expect(await writer.delete(deletion(created))).toEqual(
      committed(created.ref.entryId),
    );
    vault.advance(VAULT_TOMBSTONE_RETENTION_MS);
    const pruned = await vault.restart();
    expect(vault.store().readTombstone(created.ref.entryId)).toBeNull();

    const again = pruned.writer(FAMILY);
    expect(await again.put(create())).toEqual({
      kind: 'committed',
      pin: created,
    });
    expect(
      await again.put({ ...create(), material: encoder.encode('other') }),
    ).toEqual({ kind: 'idempotency_conflict' });
    expect(vault.store().listEntries()).toEqual([]);
    expect(await pruned.repository.list()).toEqual([]);
    expect(await pruned.repository.get(created.ref)).toEqual({
      kind: 'not_found',
      reason: 'absent',
    });
    const fresh = await committedPin(again.put(create('fresh')));
    expect(fresh.ref.entryId).not.toBe(created.ref.entryId);
  });

  it('replays the superseded intents of a pruned entry as absent, never unconfirmed', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    await failedAtCommit(
      subject,
      () => writer.put(replace(pin('entry-a'))),
      'not_written',
    );
    await failedAtCommit(
      subject,
      () => writer.delete(deletion(pin('entry-a'), 'older')),
      'not_written',
    );
    expect(await writer.delete(deletion(pin('entry-a')))).toEqual(
      committed('entry-a'),
    );
    vault.advance(VAULT_TOMBSTONE_RETENTION_MS);
    const pruned = await vault.restart();
    expect(vault.store().readTombstone('entry-a')).toBeNull();
    expect(
      vault
        .store()
        .listIntents()
        .filter((intent) => intent.state === 'pending'),
    ).toHaveLength(2);

    expect(await stateOf(pruned, 'entry-a')).toBeUndefined();
    expect(await pruned.repository.get(ref('entry-a'))).toEqual({
      kind: 'not_found',
      reason: 'absent',
    });
    const again = pruned.writer(FAMILY);
    expect(await again.put(replace(pin('entry-a')))).toEqual(
      superseded('entry-a'),
    );
    expect(await again.delete(deletion(pin('entry-a'), 'older'))).toEqual(
      superseded('entry-a'),
    );
    expect(vault.store().readEntry('entry-a')).toBeNull();
    expect(vault.store().readTombstone('entry-a')).toBeNull();
  });

  it('refuses a retained intent that would write a pruned entry', async () => {
    vault.commit({ entryId: 'entry-a' });
    vault.recordReplace('entry-a', 0, 'held-put');
    const heldDelete = vault.recordDelete('entry-a', 0, 'held-delete');
    vault.tombstone('entry-a', 0);
    vault.advance(VAULT_TOMBSTONE_RETENTION_MS);
    await vault.restart();
    const store = vault.store();
    expect(store.readTombstone('entry-a')).toBeNull();
    const heldPut = store.findIntent(FAMILY, 'held-put');
    if (heldPut === null) throw new Error('The held put was pruned.');

    expect(
      store.commitEntry(heldPut.sequence, {
        entryId: 'entry-a',
        family: FAMILY,
        revision: 1,
        expiresAt: null,
        label: 'Revived',
        sealed: sealedBox(3),
      }),
    ).toEqual({ kind: 'not_written', step: 'precondition' });
    expect(store.commitTombstone(heldDelete, 1)).toEqual({
      kind: 'not_written',
      step: 'precondition',
    });
    expect(store.readEntry('entry-a')).toBeNull();
    expect(store.readTombstone('entry-a')).toBeNull();
  });

  it('keeps a row restored after the prune closed: the committed delete outlives its tombstone', async () => {
    vault.commit({ entryId: 'entry-a' });
    vault.commit({ entryId: 'entry-b' });
    vault.tombstone('entry-a', 0);
    vault.advance(VAULT_TOMBSTONE_RETENTION_MS);
    await vault.restart();
    expect(vault.store().readTombstone('entry-a')).toBeNull();
    await vault.raw((db) =>
      db.exec(`INSERT INTO vault_entries SELECT CAST('entry-a' AS BLOB), family,
        revision, expires_at, label, nonce, ciphertext, tag, created_at,
        updated_at FROM vault_entries WHERE entry_id = CAST('entry-b' AS BLOB)`),
    );
    const opened = await vault.restart();

    expect(opened.repository.admit(pin('entry-a'))).toEqual({
      kind: 'revoked',
    });
    expect(await opened.repository.get(ref('entry-a'))).toEqual({
      kind: 'not_found',
      reason: 'absent',
    });
    expect(await stateOf(opened, 'entry-a')).toBeUndefined();
  });

  it('prunes on a trusted reconcile after the boundary, without a restart, and not before it', async () => {
    await replacedThenDeleted();
    const opened = await vault.restart();

    vault.advance(VAULT_TOMBSTONE_RETENTION_MS - 1);
    await opened.reconcile();
    expect(vault.store().readTombstone('entry-a')).not.toBeNull();
    expect(await opened.repository.get(ref('entry-a'))).toEqual({
      kind: 'not_found',
      reason: 'deleted',
    });

    vault.advance(1);
    await opened.reconcile();
    expect(vault.store().state).toBe('open');
    expect(vault.store().readTombstone('entry-a')).toBeNull();
    expect(await opened.repository.get(ref('entry-a'))).toEqual({
      kind: 'not_found',
      reason: 'absent',
    });
    await expectReceiptsReplay(opened);
    expect(await stateOf(opened, 'entry-b')).toEqual({
      state: 'available',
      revision: 0,
    });
  });

  it.each(['not_written', 'uncertain_lost', 'uncertain_landed'] as const)(
    'keeps the store open when a reconcile prune fails (%s), and a later reconcile prunes',
    async (failure) => {
      vault.commit({ entryId: 'entry-a' });
      vault.commit({ entryId: 'entry-b' });
      vault.tombstone('entry-a', 0);
      const subject = await open();
      vault.advance(VAULT_TOMBSTONE_RETENTION_MS);

      subject.failNextWrite(failure);
      await subject.opened.reconcile();

      expect(vault.store().state).toBe('open');
      expect(await subject.opened.repository.get(ref('entry-a'))).toEqual({
        kind: 'not_found',
        reason: failure === 'uncertain_landed' ? 'absent' : 'deleted',
      });
      expect(
        await subject.opened
          .writer(FAMILY)
          .delete(deletion(pin('entry-b'), 'delete-b')),
      ).toEqual(committed('entry-b'));
      await subject.opened.reconcile();
      expect(await subject.opened.repository.get(ref('entry-a'))).toEqual({
        kind: 'not_found',
        reason: 'absent',
      });
    },
  );

  it('promotes and prunes in one reconcile a landed uncertain tombstone past retention', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    await failedAtCommit(
      subject,
      () => writer.delete(deletion(pin('entry-a'))),
      'uncertain_landed',
    );
    vault.advance(VAULT_TOMBSTONE_RETENTION_MS);
    await subject.opened.reconcile();
    expect(vault.store().state).toBe('open');
    expect(vault.store().readTombstone('entry-a')).toBeNull();
    expect(await subject.opened.repository.get(ref('entry-a'))).toEqual({
      kind: 'not_found',
      reason: 'absent',
    });
    expect(await writer.delete(deletion(pin('entry-a')))).toEqual(
      committed('entry-a'),
    );
    const restarted = await vault.restart();
    expect(
      await restarted.writer(FAMILY).delete(deletion(pin('entry-a'))),
    ).toEqual(committed('entry-a'));
  });

  it('keeps a held put and a held older delete superseded when they settle after the prune', async () => {
    vault.commit({ entryId: 'entry-a' });
    const subject = await open();
    const writer = subject.opened.writer(FAMILY);
    const releasePut = subject.hold();
    const put = writer.put(replace(pin('entry-a')));
    const releaseDelete = subject.hold();
    const older = writer.delete(deletion(pin('entry-a'), 'older'));
    expect(await writer.delete(deletion(pin('entry-a')))).toEqual(
      committed('entry-a'),
    );
    vault.advance(VAULT_TOMBSTONE_RETENTION_MS);
    await subject.opened.reconcile();
    expect(vault.store().readTombstone('entry-a')).toBeNull();
    releasePut();
    releaseDelete();
    expect(await put).toEqual(superseded('entry-a'));
    expect(await older).toEqual(superseded('entry-a'));
    expect(vault.store().readEntry('entry-a')).toBeNull();
    const restarted = await vault.restart();
    expect(await restarted.writer(FAMILY).put(replace(pin('entry-a')))).toEqual(
      superseded('entry-a'),
    );
    expect(await restarted.repository.get(ref('entry-a'))).toEqual({
      kind: 'not_found',
      reason: 'absent',
    });
  });

  it('keeps the ref deleted and every receipt when the store cannot reopen after an uncertain reconcile prune', async () => {
    vault.commit({ entryId: 'entry-a' });
    vault.commit({ entryId: 'entry-b' });
    const database = join(vault.dir.folder, VAULT_STORE_FILE);
    const aside = join(vault.dir.root, 'aside.sqlite');
    let armed = false;
    const opened = await vault.restart({
      faults: {
        sync: (commit) => {
          commit();
          if (!armed) return;
          armed = false;
          throw new Error('injected sync failure');
        },
      },
    });
    const writer = opened.writer(FAMILY);
    expect(await writer.delete(deletion(pin('entry-a')))).toEqual(
      committed('entry-a'),
    );
    vault.advance(VAULT_TOMBSTONE_RETENTION_MS);
    armed = true;
    // The reopen then finds no file.
    beforeNextReopen(() => renameSync(database, aside));

    await opened.reconcile();

    expect(vault.store().state).toBe('closed');
    expect(await opened.repository.get(ref('entry-a'))).toEqual({
      kind: 'not_found',
      reason: 'deleted',
    });
    expect(await writer.delete(deletion(pin('entry-a')))).toEqual(
      committed('entry-a'),
    );
    expect(await writer.delete(deletion(pin('entry-b'), 'delete-b'))).toEqual({
      kind: 'refused',
      reason: 'closure_unrecorded',
    });
    renameSync(aside, database);
    const restarted = await vault.restart();
    expect(await restarted.repository.get(ref('entry-a'))).toEqual({
      kind: 'not_found',
      reason: 'absent',
    });
    expect(
      await restarted.writer(FAMILY).delete(deletion(pin('entry-a'))),
    ).toEqual(committed('entry-a'));
  });

  it('counts from the commit, not from when the delete was accepted', async () => {
    vault.commit({ entryId: 'entry-a' });
    vault.tombstone('entry-a', 0);
    const accepted = '2026-10-29T12:00:00.000Z';
    const committedAt = '2026-11-08T12:00:00.000Z';
    await vault.raw((db) =>
      db.exec(`UPDATE vault_tombstones SET committed_at = '${committedAt}'`),
    );
    expect(vault.store().listIntents().at(-1)?.recordedAt).toBe(accepted);

    vault.advance(VAULT_TOMBSTONE_RETENTION_MS + 9 * DAY);
    const kept = await vault.restart();
    expect(await kept.repository.get(ref('entry-a'))).toEqual({
      kind: 'not_found',
      reason: 'deleted',
    });
    vault.advance(DAY);
    const pruned = await vault.restart();
    expect(await pruned.repository.get(ref('entry-a'))).toEqual({
      kind: 'not_found',
      reason: 'absent',
    });
  });

  it.each(['not a time', '2099-01-01T00:00:00.000Z'])(
    'keeps a tombstone whose commit time is %s',
    async (committedAt) => {
      vault.commit({ entryId: 'entry-a' });
      vault.tombstone('entry-a', 0);
      await vault.raw((db) =>
        db.exec(`UPDATE vault_tombstones SET committed_at = '${committedAt}'`),
      );

      vault.advance(10 * VAULT_TOMBSTONE_RETENTION_MS);
      const opened = await vault.restart();

      expect(await opened.repository.get(ref('entry-a'))).toEqual({
        kind: 'not_found',
        reason: 'deleted',
      });
    },
  );

  it('erases a row restored behind the tombstone rather than bringing it back', async () => {
    vault.commit({ entryId: 'entry-a' });
    vault.commit({ entryId: 'entry-b' });
    vault.tombstone('entry-a', 0);
    await vault.raw((db) => {
      db.exec('DROP TRIGGER vault_entries_not_tombstoned');
      db.exec(`INSERT INTO vault_entries SELECT CAST('entry-a' AS BLOB), family,
        revision, expires_at, label, nonce, ciphertext, tag, created_at,
        updated_at FROM vault_entries WHERE entry_id = CAST('entry-b' AS BLOB)`);
      for (const statement of VAULT_STORE_SCHEMA)
        if (statement.startsWith('CREATE TRIGGER')) db.exec(statement);
    });

    vault.advance(VAULT_TOMBSTONE_RETENTION_MS);
    const opened = await vault.restart();

    expect(vault.store().readEntry('entry-a')).toBeNull();
    expect(await opened.repository.get(ref('entry-a'))).toEqual({
      kind: 'not_found',
      reason: 'absent',
    });
  });

  it.each(['not_written', 'uncertain_lost', 'uncertain_landed'] as const)(
    'opens when the prune fails (%s), and the next open prunes',
    async (failure) => {
      vault.commit({ entryId: 'entry-a' });
      vault.tombstone('entry-a', 0);
      vault.advance(VAULT_TOMBSTONE_RETENTION_MS);
      let armed = true;
      const faults: VaultStoreFaults = {
        beforeWrite: () => {
          if (armed && failure === 'not_written') {
            armed = false;
            throw new Error('injected write failure');
          }
        },
        sync: (commit) => {
          if (!armed || failure === 'not_written') return commit();
          armed = false;
          if (failure === 'uncertain_landed') commit();
          throw new Error('injected sync failure');
        },
      };

      const opened = await vault.restart({ faults });

      expect(vault.store().state).toBe('open');
      expect(await opened.repository.get(ref('entry-a'))).toEqual({
        kind: 'not_found',
        reason: failure === 'uncertain_landed' ? 'absent' : 'deleted',
      });
      const next = await vault.restart();
      expect(await next.repository.get(ref('entry-a'))).toEqual({
        kind: 'not_found',
        reason: 'absent',
      });
    },
  );
});
