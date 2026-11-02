import {
  createMemoryVaultRepository,
  runVaultRepositoryConformance,
} from '../index';

runVaultRepositoryConformance({ describe, it }, () =>
  createMemoryVaultRepository(),
);

import type {
  VaultAdmission,
  VaultFamilyWriter,
  VaultPutOutcome,
  VaultPutRequest,
  VaultReadOutcome,
  VaultSecretPin,
} from '../../contracts';
import type { VaultRepositoryTestSubject } from '../index';
import { VaultConformanceFailure } from '../index';

async function seededMemoryRepository(): Promise<{
  subject: VaultRepositoryTestSubject;
  writer: VaultFamilyWriter;
  pin: VaultSecretPin;
}> {
  const subject = createMemoryVaultRepository();
  const writer = subject.writer('test.family');
  const result = await writer.put({
    entryId: null,
    expectedRevision: null,
    family: writer.family,
    label: 'Snapshot',
    material: new Uint8Array([1]),
    expiresAt: '9999-01-01T00:00:00.000Z',
    idempotencyKey: 'create',
  });
  if (result.kind !== 'committed') throw new Error('Expected seed commit.');
  return { subject, writer, pin: result.pin };
}

it('memory reads snapshot at call time while deletion closes admission immediately', async () => {
  const { subject, writer, pin } = await seededMemoryRepository();
  const read = subject.repository.get(pin.ref);
  const listed = subject.repository.list();
  const deletion = writer.delete({
    ref: pin.ref,
    expectedRevision: pin.revision,
    idempotencyKey: 'delete',
  });
  expect(subject.repository.admit(pin)).toEqual({ kind: 'revoked' });
  await expect(read).resolves.toEqual({
    kind: 'available',
    pin,
    material: new Uint8Array([1]),
  });
  await expect(listed).resolves.toEqual([
    expect.objectContaining({ ref: pin.ref, state: 'available' }),
  ]);
  await expect(deletion).resolves.toMatchObject({ kind: 'committed' });
  await expect(subject.repository.get(pin.ref)).resolves.toEqual({
    kind: 'not_found',
    reason: 'deleted',
  });
  await expect(subject.repository.list()).resolves.toEqual([]);
});

it.each(['get', 'list'] as const)(
  'memory %s returns a rejected promise rather than throwing synchronously',
  async (method) => {
    const { subject, pin } = await seededMemoryRepository();
    const failure = new Error('Clock unavailable');
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => {
      throw failure;
    });
    try {
      const result =
        method === 'get'
          ? subject.repository.get(pin.ref)
          : subject.repository.list();
      await expect(result).rejects.toBe(failure);
    } finally {
      clock.mockRestore();
    }
  },
);

it('memory reconciliation rejects exceptions and promotes applied outcomes before returning', async () => {
  const { subject, writer, pin } = await seededMemoryRepository();
  const gate = subject.holdNextCommit();
  const pending = writer.put({
    ref: pin.ref,
    expectedRevision: pin.revision,
    label: 'Successor',
    material: new Uint8Array([2]),
    expiresAt: null,
    idempotencyKey: 'replace',
  });
  gate.release({ kind: 'outcome_unknown', applied: true });
  await expect(pending).resolves.toEqual({
    kind: 'outcome_unknown',
    ref: pin.ref,
  });
  const failure = new Error('Reference unavailable');
  await expect(
    subject.reconcile({
      vaultId: pin.ref.vaultId,
      get entryId(): string {
        throw failure;
      },
    }),
  ).rejects.toBe(failure);
  expect(subject.repository.admit(pin)).toEqual({ kind: 'unconfirmed' });
  const reconciled = subject.reconcile(pin.ref);
  expect(subject.repository.admit(pin)).toEqual({ kind: 'stale' });
  expect(
    subject.repository.admit({ ...pin, revision: pin.revision + 1 }),
  ).toEqual({ kind: 'admitted' });
  await expect(reconciled).resolves.toBeUndefined();
  await expect(subject.repository.get(pin.ref)).resolves.toEqual({
    kind: 'available',
    pin: { ...pin, revision: pin.revision + 1 },
    material: new Uint8Array([2]),
  });
});

async function runCase(
  name: string,
  wrap: (subject: VaultRepositoryTestSubject) => VaultRepositoryTestSubject,
): Promise<void> {
  const cases: { name: string; run: () => Promise<void> }[] = [];
  runVaultRepositoryConformance(
    {
      describe: (_name, body) => body(),
      it: (caseName, run) => {
        cases.push({ name: caseName, run });
      },
    },
    () => wrap(createMemoryVaultRepository()),
  );
  const selected = cases.find((candidate) => candidate.name === name);
  if (!selected) throw new Error('Missing conformance case.');
  await selected.run();
}

it('the kit catches admission that fails to close', async () => {
  await expect(
    runCase(
      'replace: synchronous narrowing and {"kind":"unavailable"}',
      (subject) => ({
        ...subject,
        repository: {
          ...subject.repository,
          admit: (): VaultAdmission => ({ kind: 'admitted' }),
        },
      }),
    ),
  ).rejects.toThrow(VaultConformanceFailure);
});

it('the kit catches an uncertain delete disguised as not_found', async () => {
  await expect(
    runCase(
      'delete: synchronous narrowing and {"kind":"outcome_unknown","applied":true}',
      (subject) => ({
        ...subject,
        repository: {
          ...subject.repository,
          get: async (ref): Promise<VaultReadOutcome> => {
            const result = await subject.repository.get(ref);
            return result.kind === 'unconfirmed'
              ? { kind: 'not_found', reason: 'absent' }
              : result;
          },
        },
      }),
    ),
  ).rejects.toThrow(VaultConformanceFailure);
});

it('the kit rejects an uncertain receipt for a put refused on a revoked entry', async () => {
  await expect(
    runCase('unavailable delete cannot be reopened by put', (subject) => ({
      ...subject,
      writer: (family): VaultFamilyWriter => {
        const writer = subject.writer(family);
        return {
          ...writer,
          put: async (request: VaultPutRequest): Promise<VaultPutOutcome> => {
            const result = await writer.put(request);
            return result.kind === 'refused' &&
              result.reason === 'entry_closed' &&
              'ref' in request
              ? { kind: 'outcome_unknown', ref: request.ref }
              : result;
          },
        };
      },
    })),
  ).rejects.toThrow(VaultConformanceFailure);
});

it('the kit catches writers that trust a public family property', async () => {
  await expect(
    runCase(
      'foreign refs, CAS conflicts and non-designated writers have no effects',
      (subject) => ({
        ...subject,
        writer: (): VaultFamilyWriter => subject.writer('test.family'),
      }),
    ),
  ).rejects.toThrow(VaultConformanceFailure);
});

it('the kit accepts equivalent DTOs with different property insertion order', async () => {
  await expect(
    runCase('empty repository and absent/foreign references', (subject) => ({
      ...subject,
      repository: {
        ...subject.repository,
        get: async (ref): Promise<VaultReadOutcome> => {
          const result = await subject.repository.get(ref);
          return result.kind === 'not_found'
            ? { reason: result.reason, kind: result.kind }
            : result;
        },
      },
    })),
  ).resolves.toBeUndefined();
});

it('the kit accepts cloned DTOs from another realm', async () => {
  await expect(
    runCase('empty repository and absent/foreign references', (subject) => ({
      ...subject,
      repository: {
        ...subject.repository,
        get: async (ref): Promise<VaultReadOutcome> =>
          structuredClone(await subject.repository.get(ref)),
      },
    })),
  ).resolves.toBeUndefined();
});

it.each([
  { kind: 'not_found', reason: 'absent' },
  { kind: 'not_found', reason: 'foreign_vault', pin: null },
  { kind: 'not_found', reason: 'foreign_vault', material: new Uint8Array([1]) },
] as const)(
  'the kit still rejects incorrect or extra DTO fields: %j',
  async (result) => {
    await expect(
      runCase('empty repository and absent/foreign references', (subject) => ({
        ...subject,
        repository: {
          ...subject.repository,
          get: (): Promise<VaultReadOutcome> => Promise.resolve(result),
        },
      })),
    ).rejects.toThrow(VaultConformanceFailure);
  },
);

it('the kit releases held durability before disposing a failed scenario', async () => {
  let held = false;
  let disposedWhileHeld = false;
  await expect(
    runCase(
      'replace: synchronous narrowing and {"kind":"unavailable"}',
      (subject) => ({
        ...subject,
        holdNextCommit: (): ReturnType<
          VaultRepositoryTestSubject['holdNextCommit']
        > => {
          const gate = subject.holdNextCommit();
          held = true;
          return {
            release: (outcome): void => {
              held = false;
              gate.release(outcome);
            },
          };
        },
        repository: {
          ...subject.repository,
          admit: (): VaultAdmission => ({ kind: 'admitted' }),
        },
        dispose: (): Promise<void> => {
          disposedWhileHeld = held;
          return Promise.resolve();
        },
      }),
    ),
  ).rejects.toThrow(VaultConformanceFailure);
  expect(disposedWhileHeld).toBe(false);
});

it('an outcome_unknown delete cannot become usable when an earlier replace commits', async () => {
  const subject = createMemoryVaultRepository();
  const writer = subject.writer('test.family');
  const first = await writer.put({
    entryId: null,
    expectedRevision: null,
    family: 'test.family',
    label: 'First',
    material: new Uint8Array([1]),
    expiresAt: null,
    idempotencyKey: 'create',
  });
  if (first.kind !== 'committed') throw new Error('Expected seed commit.');
  const gate = subject.holdNextCommit();
  const replacement = writer.put({
    ref: first.pin.ref,
    expectedRevision: first.pin.revision,
    label: 'Successor',
    material: new Uint8Array([2]),
    expiresAt: null,
    idempotencyKey: 'replace',
  });
  const deleteGate = subject.holdNextCommit();
  const pendingDelete = writer.delete({
    ref: first.pin.ref,
    expectedRevision: first.pin.revision,
    idempotencyKey: 'delete',
  });
  deleteGate.release({ kind: 'outcome_unknown', applied: false });
  const deletion = await pendingDelete;
  expect(deletion.kind).toBe('outcome_unknown');
  gate.release({ kind: 'committed' });
  const replaced = await replacement;
  expect(replaced).toEqual({ kind: 'superseded', ref: first.pin.ref });
  expect(subject.repository.admit(first.pin).kind).not.toBe('admitted');
  expect(await subject.repository.get(first.pin.ref)).toEqual({
    kind: 'unconfirmed',
    state: 'delete_unconfirmed',
  });
});
