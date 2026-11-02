// CAN-4544: the keyed W5 operation reports a replayed outcome to its caller at
// both replay returns, and only there, against an in-memory receipt store.
const mockReceiptStore = {
  lookupReceipt: jest.fn<Promise<W5ReceiptLookup>, [unknown]>(),
  reserve: jest.fn<Promise<void>, [unknown]>(),
  releaseReservation: jest.fn<Promise<void>, [string]>(),
  markReservationRecoveryRequired: jest.fn<Promise<void>, [string, unknown]>(),
};
jest.mock('../w5-commit-log-file-store', () => ({
  getW5ReceiptStore: (): typeof mockReceiptStore => mockReceiptStore,
}));

import type { W5ReceiptLookup } from '@canopy/desktop-shared/node/w5-commit-log';
import { W5CommitRefusedError } from '@canopy/desktop-shared/node/w5-commit-log/errors';
import {
  admitLifecycleJournals,
  runKeyedW5Operation,
} from '../w5-keyed-operation';

interface Outcome {
  id: string;
}

function decode(outcome: unknown): Outcome {
  if (
    typeof outcome === 'object' &&
    outcome !== null &&
    'id' in outcome &&
    typeof outcome.id === 'string'
  )
    return { id: outcome.id };
  throw new Error('Unexpected outcome');
}

function run(
  onReplay: (() => void) | undefined,
  work: () => Promise<Outcome> = () => Promise.resolve({ id: 'fresh' }),
): Promise<Outcome> {
  return runKeyedW5Operation(
    {
      caller: 'desktop-host:test',
      operation: 'core.test.create',
      idempotencyKey: 'key-1',
      parameters: { name: 'value' },
      isPreEffectRefusal: () => false,
      ...(onReplay ? { onReplay } : {}),
    },
    decode,
    work,
  );
}

describe('runKeyedW5Operation onReplay', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReceiptStore.lookupReceipt.mockResolvedValue({ status: 'none' });
    mockReceiptStore.reserve.mockResolvedValue();
    mockReceiptStore.releaseReservation.mockResolvedValue();
    mockReceiptStore.markReservationRecoveryRequired.mockResolvedValue();
  });

  it('reports a replay found at admission without running the work', async () => {
    mockReceiptStore.lookupReceipt.mockResolvedValue({
      status: 'replay',
      commitId: 1,
      outcome: { id: 'stored' },
    });
    const onReplay = jest.fn();
    const work = jest.fn(() => Promise.resolve({ id: 'fresh' }));

    await expect(run(onReplay, work)).resolves.toEqual({ id: 'stored' });

    expect(onReplay).toHaveBeenCalledTimes(1);
    expect(work).not.toHaveBeenCalled();
    expect(mockReceiptStore.reserve).not.toHaveBeenCalled();
  });

  it('reports a racing winner replayed after a reserve refusal', async () => {
    mockReceiptStore.lookupReceipt
      .mockResolvedValueOnce({ status: 'none' })
      .mockResolvedValueOnce({
        status: 'replay',
        commitId: 2,
        outcome: { id: 'winner' },
      });
    mockReceiptStore.reserve.mockRejectedValueOnce(
      new W5CommitRefusedError('in-progress', 'Already reserved.'),
    );
    const onReplay = jest.fn();
    const work = jest.fn(() => Promise.resolve({ id: 'fresh' }));

    await expect(run(onReplay, work)).resolves.toEqual({ id: 'winner' });

    expect(onReplay).toHaveBeenCalledTimes(1);
    expect(work).not.toHaveBeenCalled();
  });

  it('does not report a fresh attempt', async () => {
    const onReplay = jest.fn();

    await expect(run(onReplay)).resolves.toEqual({ id: 'fresh' });

    expect(onReplay).not.toHaveBeenCalled();
  });

  it('does not report a refused or failed attempt', async () => {
    const onReplay = jest.fn();
    mockReceiptStore.lookupReceipt.mockResolvedValueOnce({
      status: 'key-reused',
    });
    await expect(run(onReplay)).rejects.toMatchObject({ reason: 'key-reused' });

    await expect(
      run(onReplay, () => Promise.reject(new Error('work failed'))),
    ).rejects.toThrow('work failed');

    expect(onReplay).not.toHaveBeenCalled();
  });

  it('still returns the replayed outcome when the callback throws', async () => {
    const onReplay = jest.fn(() => {
      throw new Error('observer failed');
    });
    mockReceiptStore.lookupReceipt.mockResolvedValueOnce({
      status: 'replay',
      commitId: 1,
      outcome: { id: 'stored' },
    });
    await expect(run(onReplay)).resolves.toEqual({ id: 'stored' });

    mockReceiptStore.lookupReceipt
      .mockResolvedValueOnce({ status: 'none' })
      .mockResolvedValueOnce({
        status: 'replay',
        commitId: 2,
        outcome: { id: 'winner' },
      });
    mockReceiptStore.reserve.mockRejectedValueOnce(
      new W5CommitRefusedError('in-progress', 'Already reserved.'),
    );
    await expect(run(onReplay)).resolves.toEqual({ id: 'winner' });

    expect(onReplay).toHaveBeenCalledTimes(2);
    expect(mockReceiptStore.releaseReservation).not.toHaveBeenCalled();
    expect(
      mockReceiptStore.markReservationRecoveryRequired,
    ).not.toHaveBeenCalled();
  });

  it('replays unchanged without a callback', async () => {
    mockReceiptStore.lookupReceipt.mockResolvedValue({
      status: 'replay',
      commitId: 1,
      outcome: { id: 'stored' },
    });

    await expect(run(undefined)).resolves.toEqual({ id: 'stored' });
  });
});

describe('admitLifecycleJournals (CAN-5377)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReceiptStore.lookupReceipt.mockResolvedValue({ status: 'none' });
    mockReceiptStore.reserve.mockResolvedValue();
    mockReceiptStore.releaseReservation.mockResolvedValue();
    mockReceiptStore.markReservationRecoveryRequired.mockResolvedValue();
  });

  const journalRefusal = (): W5CommitRefusedError =>
    new W5CommitRefusedError('recovery-required', 'Inspect the journal.');

  function runAdmission(
    failure: Error,
    afterEffects = false,
  ): Promise<Outcome> {
    return runKeyedW5Operation(
      {
        caller: 'desktop-host:test',
        operation: 'core.test.delete',
        idempotencyKey: 'key-1',
        parameters: {},
        isPreEffectRefusal: () => false,
      },
      decode,
      async (_binding, attempt) => {
        if (afterEffects) attempt.beforeEffects();
        return admitLifecycleJournals(attempt, () => Promise.reject(failure));
      },
    );
  }

  it('releases a new reservation for a refusal before any effect', async () => {
    const refusal = journalRefusal();
    await expect(runAdmission(refusal)).rejects.toBe(refusal);
    expect(mockReceiptStore.releaseReservation).toHaveBeenCalledTimes(1);
    expect(
      mockReceiptStore.markReservationRecoveryRequired,
    ).not.toHaveBeenCalled();
  });

  it.each([
    ['the same refusal after an effect', journalRefusal(), true],
    [
      'another refusal',
      new W5CommitRefusedError('in-progress', 'Still running.'),
      false,
    ],
    ['a read failure', new Error('EIO'), false],
  ])('keeps the reservation for %s', async (_label, failure, afterEffects) => {
    await expect(runAdmission(failure, afterEffects)).rejects.toBe(failure);
    expect(mockReceiptStore.releaseReservation).not.toHaveBeenCalled();
    expect(
      mockReceiptStore.markReservationRecoveryRequired,
    ).toHaveBeenCalledTimes(1);
  });

  it('rethrows the same refusal outside a keyed attempt', async () => {
    const refusal = journalRefusal();
    await expect(
      admitLifecycleJournals(undefined, () => Promise.reject(refusal)),
    ).rejects.toBe(refusal);
  });
});
