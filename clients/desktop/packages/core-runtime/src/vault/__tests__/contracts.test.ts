import {
  VAULT_BACKENDS,
  VaultStatusGetResultSchema,
} from '@canopy/protocol/canopy-core';
import type {
  VaultDeleteOutcome,
  VaultMutationFailure,
  VaultPutOutcome,
  VaultSecretPin,
} from '../index';
import { createMemoryVaultRepository } from '../testing';
import type { VaultRepositoryTestSubject } from '../testing';

const ref = { vaultId: 'test-vault', entryId: 'entry-1' };

type PutBlockReason = Extract<VaultPutOutcome, { kind: 'blocked' }>['reason'];
// Every block reason but expired, which only a read decides.
const PUT_BLOCK_REASONS = [
  'locked',
  'denied',
  'unavailable',
  'corrupt',
  'key_missing',
] as const satisfies readonly PutBlockReason[];
type MissingPutBlockReason = Exclude<
  PutBlockReason,
  (typeof PUT_BLOCK_REASONS)[number]
>;
const noMissingPutBlockReason: [MissingPutBlockReason] extends [never]
  ? true
  : false = true;

describe('vault mutation outcomes', () => {
  it('blocks a put for every block reason except expired, and never a delete', () => {
    expect(noMissingPutBlockReason).toBe(true);
    const blocked = PUT_BLOCK_REASONS.map(
      (reason): VaultPutOutcome => ({ kind: 'blocked', reason }),
    );
    expect(blocked.map((outcome) => outcome.kind)).toEqual(
      Array<string>(5).fill('blocked'),
    );
    const expired = { kind: 'blocked', reason: 'expired' } as const;
    const locked = { kind: 'blocked', reason: 'locked' } as const;
    // @ts-expect-error A put is never blocked as expired.
    const expiredPut: VaultPutOutcome = expired;
    // @ts-expect-error A delete needs no key, so it is never blocked.
    const blockedDelete: VaultDeleteOutcome = locked;
    // @ts-expect-error Blocked is put-only, not a shared mutation failure.
    const blockedFailure: VaultMutationFailure = locked;
    const lockedPut: VaultPutOutcome = locked;
    expect([expiredPut, blockedDelete, blockedFailure, lockedPut]).toHaveLength(
      4,
    );
  });

  it('refuses an unrecorded closure intent on put and delete without a ref', () => {
    const refused = {
      kind: 'refused',
      reason: 'closure_unrecorded',
    } as const satisfies VaultMutationFailure;
    const put: VaultPutOutcome = refused;
    const deletion: VaultDeleteOutcome = refused;
    expect([put, deletion]).toEqual([refused, refused]);
    const withRef: VaultMutationFailure = {
      kind: 'refused',
      reason: 'closure_unrecorded',
      // @ts-expect-error The intent was not recorded, so no ref was reserved.
      ref,
    };
    expect(withRef).toHaveProperty('ref');
  });
});

async function seed(
  subject: VaultRepositoryTestSubject,
  expiresAt: string | null = null,
  idempotencyKey = 'create',
): Promise<VaultSecretPin> {
  const result = await subject.writer('test.family').put({
    entryId: null,
    expectedRevision: null,
    family: 'test.family',
    label: 'Seed',
    material: new Uint8Array([1]),
    expiresAt,
    idempotencyKey,
  });
  if (result.kind !== 'committed') throw new Error('Expected seed commit.');
  return result.pin;
}

describe('memory repository status', () => {
  it('returns the last observation synchronously, under a test-only backend', async () => {
    const subject = createMemoryVaultRepository();
    const first = subject.repository.status();
    expect(first).not.toBeInstanceOf(Promise);
    expect(VaultStatusGetResultSchema.parse(first)).toEqual(first);
    expect(first.protection.state).toBe('available');
    expect(first.observedAt).not.toBeNull();
    expect(Object.values(VAULT_BACKENDS)).not.toContain(
      first.protection.backend,
    );

    const pin = await seed(subject);
    const gate = subject.holdNextCommit();
    const deletion = subject.writer('test.family').delete({
      ref: pin.ref,
      expectedRevision: pin.revision,
      idempotencyKey: 'delete',
    });
    expect(subject.repository.status()).toEqual(first);
    gate.release({ kind: 'unavailable' });
    await expect(deletion).resolves.toMatchObject({ kind: 'unavailable' });
    expect(subject.repository.status()).toEqual(first);
  });

  it('returns a fresh copy on every call', () => {
    const { repository } = createMemoryVaultRepository();
    const first = repository.status();
    const expected = structuredClone(first);
    Object.assign(first.protection, { state: 'locked', evidence: 'reported' });
    expect(repository.status()).toEqual(expected);
    expect(repository.status()).not.toBe(repository.status());
  });
});

describe('memory repository admit/get agreement', () => {
  async function agrees(
    subject: VaultRepositoryTestSubject,
    pin: VaultSecretPin,
  ): Promise<boolean> {
    const read = await subject.repository.get(pin.ref);
    const available =
      read.kind === 'available' && read.pin.revision === pin.revision;
    return (subject.repository.admit(pin).kind === 'admitted') === available;
  }

  it('admits a pin exactly when get would return it available', async () => {
    const subject = createMemoryVaultRepository();
    const writer = subject.writer('test.family');
    const pin = await seed(subject);
    const expiredPin = await seed(
      subject,
      '2000-01-01T00:00:00.000Z',
      'expired',
    );
    expect(subject.repository.admit(pin)).toEqual({ kind: 'admitted' });
    expect(await agrees(subject, pin)).toBe(true);
    expect(await agrees(subject, expiredPin)).toBe(true);

    const gate = subject.holdNextCommit();
    const replacement = writer.put({
      ref: pin.ref,
      expectedRevision: pin.revision,
      label: 'Successor',
      material: new Uint8Array([2]),
      expiresAt: null,
      idempotencyKey: 'replace',
    });
    expect(await agrees(subject, pin)).toBe(true);
    gate.release({ kind: 'committed' });
    const replaced = await replacement;
    if (replaced.kind !== 'committed') throw new Error('Expected a commit.');
    expect(await agrees(subject, pin)).toBe(true);
    expect(await agrees(subject, replaced.pin)).toBe(true);
    expect(subject.repository.admit(replaced.pin)).toEqual({
      kind: 'admitted',
    });

    const deleteGate = subject.holdNextCommit();
    const deletion = writer.delete({
      ref: replaced.pin.ref,
      expectedRevision: replaced.pin.revision,
      idempotencyKey: 'delete',
    });
    expect(await agrees(subject, replaced.pin)).toBe(true);
    deleteGate.release({ kind: 'unavailable' });
    await deletion;
    expect(await agrees(subject, replaced.pin)).toBe(true);
    expect(subject.repository.admit(replaced.pin)).toEqual({ kind: 'revoked' });
  });
});
