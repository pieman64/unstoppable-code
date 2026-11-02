import type {
  W5CommitRequest,
  W5ReceiptLookup,
  W5ReservationFailureDiagnostics,
} from '../commit-log/commit-log';
import {
  W5FileWriteRefusedError,
  W5RevisionConflictError,
  type W5ReservationInput,
} from '../commit-log-file-store';
import { runW5Commit, type W5CommitOptions } from '../commit-scope';
import {
  createW5KeyedOperationRunner,
  type W5ReceiptStore,
} from '../keyed-operation';
import {
  createW5SingleDecisionOperation,
  type W5SingleDecisionBindings,
  type W5SingleDecisionInput,
  type W5SingleDecisionOperation,
} from '../single-decision-operation';
import type { W5StorageTarget } from '../storage-target';

interface Outcome {
  id: string;
}

function decode(outcome: unknown): Outcome {
  if (
    typeof outcome === 'object' &&
    outcome !== null &&
    'id' in outcome &&
    typeof outcome.id === 'string' &&
    outcome.id !== 'unsaveable'
  )
    return { id: outcome.id };
  throw new Error('Unexpected outcome');
}

type Receipt = NonNullable<W5CommitRequest['receipt']>;

class HostRefusal extends Error {}
class BoundaryRefusal extends Error {}

const INDEX: W5StorageTarget = {
  namespace: 'workspace_index',
  writer: 'electron_main',
};

interface Harness {
  events: string[];
  store: W5ReceiptStore & {
    lookupReceipt: jest.Mock<Promise<W5ReceiptLookup>, [Receipt]>;
    reserve: jest.Mock<Promise<void>, [W5ReservationInput]>;
    markReservationRecoveryRequired: jest.Mock<
      Promise<void>,
      [string, W5ReservationFailureDiagnostics]
    >;
  };
  runOperation: W5SingleDecisionOperation<'settings'>;
}

/** One fake receipt store and ordered event log per test. */
function harness(lookup: W5ReceiptLookup = { status: 'none' }): Harness {
  const events: string[] = [];
  let admitted = 0;
  const store = {
    lookupReceipt: jest.fn<Promise<W5ReceiptLookup>, [Receipt]>(() => {
      events.push(admitted > 0 ? 'lookup:admitted' : 'lookup');
      return Promise.resolve(lookup);
    }),
    reserve: jest.fn<Promise<void>, [W5ReservationInput]>(() => {
      events.push('reserve');
      return Promise.resolve();
    }),
    releaseReservation: jest.fn<Promise<void>, [string]>(() => {
      events.push('release');
      return Promise.resolve();
    }),
    markReservationRecoveryRequired: jest.fn<
      Promise<void>,
      [string, W5ReservationFailureDiagnostics]
    >(() => {
      events.push('recovery');
      return Promise.resolve();
    }),
  } satisfies W5ReceiptStore;
  const runKeyed = createW5KeyedOperationRunner({
    getReceiptStore: () => store,
  });
  const bindings: W5SingleDecisionBindings<'settings'> = {
    runKeyed: (keyedInput, keyedDecode, work) => {
      events.push('keyed');
      return runKeyed(keyedInput, keyedDecode, work);
    },
    admitStorage: async (_targets, operation) => {
      events.push('storage:enter');
      admitted += 1;
      try {
        return await operation();
      } finally {
        admitted -= 1;
        events.push('storage:exit');
      }
    },
    caller: (source) => `test-host:${source}`,
    isHostRefusal: (error) => error instanceof HostRefusal,
  };
  const runOperation = createW5SingleDecisionOperation(
    bindings,
    (error) => error instanceof BoundaryRefusal,
  );
  return { events, store, runOperation };
}

function input(
  overrides: Partial<W5SingleDecisionInput<'settings'>> = {},
): W5SingleDecisionInput<'settings'> {
  return {
    operation: 'core.test.settings.update',
    source: 'settings',
    idempotencyKey: 'key-1',
    parameters: () => ({ value: 1 }),
    storage: [INDEX],
    ...overrides,
  };
}

/** Stages the outcome in a real commit scope, as `withW5Commit` would. */
function commitWith(
  outcomes: unknown[],
  options: W5CommitOptions,
  work: () => Promise<Outcome>,
): Promise<Outcome> {
  return runW5Commit({}, options, work, (scope) => {
    outcomes.push(scope.options.outcome);
    return Promise.resolve();
  });
}

describe('createW5SingleDecisionOperation', () => {
  it('runs an unkeyed change without a receipt, its parameters or a saved outcome', async () => {
    const { events, store, runOperation } = harness();
    const parameters = jest.fn(() => ({ value: 1 }));
    const execute = jest.fn(
      (
        admitted: string,
        options: W5CommitOptions,
        save: (r: Outcome) => Outcome,
      ) => {
        events.push(`execute:${admitted}`);
        expect(options).toEqual({ operation: 'core.test.settings.update' });
        const result = { id: 'fresh' };
        expect(save(result)).toBe(result);
        return Promise.resolve(result);
      },
    );
    await expect(
      runOperation(
        input({ idempotencyKey: undefined, parameters }),
        () => Promise.resolve('admitted'),
        decode,
        execute,
      ),
    ).resolves.toEqual({ id: 'fresh' });
    expect(events).toEqual([
      'storage:enter',
      'execute:admitted',
      'storage:exit',
    ]);
    expect(parameters).not.toHaveBeenCalled();
    expect(store.lookupReceipt).not.toHaveBeenCalled();
  });

  it('skips storage admission when the change names no storage', async () => {
    const { events, runOperation } = harness();
    await runOperation(
      input({ storage: undefined }),
      () => Promise.resolve('admitted'),
      decode,
      () => Promise.resolve({ id: 'fresh' }),
    );
    expect(events).toEqual(['keyed', 'lookup', 'reserve']);
  });

  it('names the host caller and stages one decision without the effect marker', async () => {
    const { events, store, runOperation } = harness();
    const outcomes: unknown[] = [];
    let staged: W5CommitOptions | undefined;
    await expect(
      runOperation(
        input(),
        () => {
          events.push('admit');
          return Promise.resolve('admitted');
        },
        decode,
        (admitted, options, save) => {
          staged = options;
          events.push(`execute:${admitted}`);
          const result: Outcome & { extra: boolean } = {
            id: 'fresh',
            extra: true,
          };
          return commitWith(outcomes, options, () =>
            Promise.resolve(save(result)),
          );
        },
      ),
    ).resolves.toEqual({ id: 'fresh' });
    const receipt = store.lookupReceipt.mock.calls[0]?.[0];
    expect(receipt).toMatchObject({
      caller: 'test-host:settings',
      operation: 'core.test.settings.update',
      idempotencyKey: 'key-1',
    });
    // The decision is the only effect, so `beforeDecision` is never passed on.
    expect(staged).toEqual({
      operation: 'core.test.settings.update',
      receipt,
      reservationId: store.reserve.mock.calls[0]?.[0]?.reservationId,
    });
    expect(outcomes).toEqual([{ id: 'fresh' }]);
    expect(events).toEqual([
      'storage:enter',
      'keyed',
      'lookup:admitted',
      'admit',
      'reserve',
      'execute:admitted',
      'storage:exit',
    ]);
  });

  it('replays inside storage admission without business admission or a new decision', async () => {
    const { events, store, runOperation } = harness({
      status: 'replay',
      commitId: 1,
      outcome: { id: 'stored' },
    });
    const admit = jest.fn(() => Promise.resolve('admitted'));
    const execute = jest.fn(() => Promise.resolve({ id: 'fresh' }));
    await expect(
      runOperation(input(), admit, decode, execute),
    ).resolves.toEqual({ id: 'stored' });
    expect(admit).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(store.reserve).not.toHaveBeenCalled();
    expect(events).toEqual([
      'storage:enter',
      'keyed',
      'lookup:admitted',
      'storage:exit',
    ]);
  });

  it('never executes a saved outcome that fails to decode', async () => {
    const { events, store, runOperation } = harness({
      status: 'replay',
      commitId: 1,
      outcome: { unexpected: true },
    });
    const admit = jest.fn(() => Promise.resolve('admitted'));
    const execute = jest.fn(() => Promise.resolve({ id: 'fresh' }));
    await expect(runOperation(input(), admit, decode, execute)).rejects.toThrow(
      'Unexpected outcome',
    );
    expect(admit).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(store.reserve).not.toHaveBeenCalled();
    expect(events).toEqual([
      'storage:enter',
      'keyed',
      'lookup:admitted',
      'storage:exit',
    ]);
  });

  it('consumes no key when business admission refuses', async () => {
    const { events, runOperation } = harness();
    const refusal = new Error('stale workspace');
    await expect(
      runOperation(
        input(),
        () => Promise.reject(refusal),
        decode,
        () => Promise.resolve({ id: 'fresh' }),
      ),
    ).rejects.toBe(refusal);
    expect(events).toEqual([
      'storage:enter',
      'keyed',
      'lookup:admitted',
      'storage:exit',
    ]);
  });

  it.each([
    ['boundary', new BoundaryRefusal('refused')],
    ['revision conflict', new W5RevisionConflictError('workspace:a', 1, 2)],
    ['file conflict', new W5FileWriteRefusedError('/w5/index.json')],
    ['host', new HostRefusal('invalid id')],
  ])(
    'releases the key for a %s refusal at the decision',
    async (_name, refusal) => {
      const { events, runOperation } = harness();
      await expect(
        runOperation(
          input(),
          () => Promise.resolve('admitted'),
          decode,
          () => Promise.reject(refusal),
        ),
      ).rejects.toBe(refusal);
      expect(events).toContain('release');
      expect(events).not.toContain('recovery');
    },
  );

  it('keeps the key recovery-required for any other failure', async () => {
    const { events, store, runOperation } = harness();
    const failure = new Error('worker unavailable');
    await expect(
      runOperation(
        input(),
        () => Promise.resolve('admitted'),
        decode,
        () => Promise.reject(failure),
      ),
    ).rejects.toBe(failure);
    expect(events).toContain('recovery');
    expect(events).not.toContain('release');
    expect(store.markReservationRecoveryRequired).toHaveBeenCalledWith(
      expect.any(String),
      { operation: 'core.test.settings.update', errorName: 'Error' },
    );
  });

  it('keeps the key recovery-required when a result fails to decode at save', async () => {
    const { events, runOperation } = harness();
    await expect(
      runOperation(
        input(),
        () => Promise.resolve('admitted'),
        decode,
        (_admitted, options, save) =>
          commitWith([], options, () =>
            Promise.resolve(save({ id: 'unsaveable' })),
          ),
      ),
    ).rejects.toThrow('Unexpected outcome');
    expect(events).toContain('recovery');
  });
});

it('loads its entrypoint without node:sqlite', () => {
  jest.isolateModules(() => {
    jest.doMock('node:sqlite', () => {
      throw new Error('node:sqlite was loaded');
    });
    expect((): void => {
      jest.requireActual<object>('../single-decision-operation');
    }).not.toThrow();
  });
});
