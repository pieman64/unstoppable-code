import type {
  W5CommitRequest,
  W5ReceiptLookup,
  W5Resource,
} from '../commit-log/commit-log';
import {
  createW5BoundaryOperationRunner,
  createW5ExpectedRevisionCheck,
  w5ExpectedRevision,
  type W5BoundaryOperationInput,
  type W5BoundaryOperationRunner,
} from '../boundary-operation';
import { W5RevisionConflictError } from '../commit-log-file-store';
import type { W5CommitOptions } from '../commit-scope';
import {
  createW5KeyedOperationRunner,
  type W5ReceiptStore,
} from '../keyed-operation';

interface Outcome {
  id: string;
}

/** Projects the portable field, as boundary decoders strip host fields. */
function decode(outcome: unknown): Outcome {
  if (
    typeof outcome === 'object' &&
    outcome !== null &&
    'id' in outcome &&
    typeof outcome.id === 'string' &&
    outcome.id !== 'undecodable'
  )
    return { id: outcome.id };
  throw new Error('Unexpected outcome');
}

class HostRefusal extends Error {}
class BoundaryRefusal extends Error {}

const ROW: W5Resource = {
  kind: 'worktree',
  workspaceId: 'ws',
  worktreeId: 'wt',
};

interface Harness {
  events: string[];
  commits: W5CommitOptions[];
  run: W5BoundaryOperationRunner;
}

function harness(lookup: W5ReceiptLookup = { status: 'none' }): Harness {
  const events: string[] = [];
  const commits: W5CommitOptions[] = [];
  const store: W5ReceiptStore = {
    lookupReceipt: () => {
      events.push('lookup');
      return Promise.resolve(lookup);
    },
    reserve: () => {
      events.push('reserve');
      return Promise.resolve();
    },
    releaseReservation: () => {
      events.push('release');
      return Promise.resolve();
    },
    markReservationRecoveryRequired: () => {
      events.push('recovery');
      return Promise.resolve();
    },
  };
  const runKeyed = createW5KeyedOperationRunner({
    getReceiptStore: () => store,
  });
  const run = createW5BoundaryOperationRunner({
    runKeyed: (keyed, keyedDecode, work) => {
      events.push('keyed');
      return runKeyed(keyed, keyedDecode, work);
    },
    withCommit: async (options, work) => {
      events.push('commit');
      commits.push(options);
      await work();
    },
    isHostRefusal: (error) => error instanceof HostRefusal,
  });
  return { events, commits, run };
}

function input(
  overrides: Partial<W5BoundaryOperationInput> = {},
): W5BoundaryOperationInput {
  return {
    operation: 'core.test.boundary',
    caller: 'test-host:boundary',
    idempotencyKey: 'key-1',
    parameters: { value: 1 },
    isPreEffectRefusal: (error) => error instanceof BoundaryRefusal,
    ...overrides,
  };
}

const live = { id: 'fresh', hostOnly: '/Users/me/checkout' };

describe('createW5BoundaryOperationRunner', () => {
  it('runs an unkeyed boundary directly, with no decode, receipt or commit', async () => {
    const { events, run } = harness();
    let staged: W5CommitOptions | undefined;
    const result = await run(
      input({ idempotencyKey: undefined }),
      decode,
      async (options, attempt, complete) => {
        staged = options;
        expect(attempt).toBeUndefined();
        await expect(complete(live)).resolves.toBe(live);
        return live;
      },
    );
    expect(result).toBe(live);
    expect(staged).toEqual({ operation: 'core.test.boundary' });
    expect(events).toEqual([]);
  });

  it.each([true, false])(
    'rechecks an unkeyed foreground outcome once with a receipt-only commit (completed by execute: %s)',
    async (completedByExecute) => {
      const { events, commits, run } = harness();
      let staged: W5CommitOptions | undefined;
      const result = await run(
        input({ idempotencyKey: undefined, recheckAtOutcome: true }),
        decode,
        async (options, attempt, complete) => {
          staged = options;
          expect(attempt).toBeUndefined();
          options.expectedRevisions = w5ExpectedRevision(ROW, 3);
          return completedByExecute ? complete(live) : live;
        },
      );
      expect(result).toBe(live);
      expect(events).toEqual(['commit']);
      // The boundary's own options, so revisions advanced by its steps count.
      expect(commits[0]).toBe(staged);
      expect(commits[0]).toEqual({
        operation: 'core.test.boundary',
        expectedRevisions: [{ resource: ROW, revision: 3 }],
      });
    },
  );

  it('skips the unkeyed recheck when the boundary staged no revisions', async () => {
    const { events, run } = harness();
    await expect(
      run(
        input({ idempotencyKey: undefined, recheckAtOutcome: true }),
        decode,
        (options) => {
          options.expectedRevisions = [];
          return Promise.resolve(live);
        },
      ),
    ).resolves.toBe(live);
    expect(events).toEqual([]);
  });

  it.each([
    [false, undefined],
    [true, [{ resource: ROW, revision: 4 }]],
  ])(
    'saves a keyed outcome in one receipt-only decision (recheck: %s)',
    async (recheckAtOutcome, expectedRevisions) => {
      const { events, commits, run } = harness();
      let staged: W5CommitOptions | undefined;
      const result = await run(
        input({ recheckAtOutcome }),
        decode,
        (options, attempt) => {
          staged = options;
          expect(attempt).toBeDefined();
          expect(Object.keys(options).sort()).toEqual([
            'beforeDecision',
            'operation',
          ]);
          options.expectedRevisions = w5ExpectedRevision(ROW, 4);
          return Promise.resolve(live);
        },
      );
      expect(result).toEqual({ id: 'fresh' });
      expect(events).toEqual(['keyed', 'lookup', 'reserve', 'commit']);
      const [commit] = commits;
      expect(commit).toMatchObject({
        operation: 'core.test.boundary',
        receipt: {
          caller: 'test-host:boundary',
          operation: 'core.test.boundary',
          idempotencyKey: 'key-1',
        },
        outcome: { id: 'fresh' },
      });
      expect(typeof commit?.reservationId).toBe('string');
      expect(commit?.expectedRevisions).toEqual(expectedRevisions);
      expect(commit?.beforeDecision).toBe(staged?.beforeDecision);
    },
  );

  it('returns the decoded outcome when execute completes before publication work', async () => {
    const { events, commits, run } = harness();
    const result = await run(
      input(),
      decode,
      async (_options, _attempt, complete) => {
        const outcome = await complete(live);
        expect(outcome).toEqual({ id: 'fresh' });
        events.push('after-complete');
        return outcome;
      },
    );
    expect(result).toEqual({ id: 'fresh' });
    expect(events).toEqual([
      'keyed',
      'lookup',
      'reserve',
      'commit',
      'after-complete',
    ]);
    expect(commits).toHaveLength(1);
  });

  it('replays a saved outcome without execute or a commit', async () => {
    const { events, run } = harness({
      status: 'replay',
      commitId: 1,
      outcome: { id: 'saved', hostOnly: 'x' },
    });
    const execute = jest.fn(() => Promise.resolve(live));
    await expect(run(input(), decode, execute)).resolves.toEqual({
      id: 'saved',
    });
    expect(execute).not.toHaveBeenCalled();
    expect(events).toEqual(['keyed', 'lookup']);
  });

  it.each([
    ['host', new HostRefusal('invalid id')],
    ['boundary', new BoundaryRefusal('refused')],
  ])('releases the key for a pre-effect %s refusal', async (_name, refusal) => {
    const { events, run } = harness();
    await expect(
      run(input(), decode, () => Promise.reject(refusal)),
    ).rejects.toBe(refusal);
    expect(events).toEqual(['keyed', 'lookup', 'reserve', 'release']);
  });

  it('marks recovery for a refusal after effects and for an undecodable result', async () => {
    const refused = harness();
    const refusal = new HostRefusal('late');
    await expect(
      refused.run(input(), decode, (options) => {
        options.beforeDecision?.();
        return Promise.reject(refusal);
      }),
    ).rejects.toBe(refusal);
    expect(refused.events.at(-1)).toBe('recovery');

    const undecodable = harness();
    await expect(
      undecodable.run(input(), decode, () =>
        Promise.resolve({ id: 'undecodable' }),
      ),
    ).rejects.toThrow('Unexpected outcome');
    expect(undecodable.events).toEqual([
      'keyed',
      'lookup',
      'reserve',
      'recovery',
    ]);
    expect(undecodable.commits).toEqual([]);
  });
});

describe('createW5ExpectedRevisionCheck', () => {
  function check(
    revisions: NonNullable<W5CommitRequest['expectedRevisions']>,
  ): {
    read: jest.Mock;
    run: ReturnType<typeof createW5ExpectedRevisionCheck>;
  } {
    const read = jest.fn(
      (): Promise<NonNullable<W5CommitRequest['expectedRevisions']>> =>
        Promise.resolve(revisions),
    );
    return { read, run: createW5ExpectedRevisionCheck(read) };
  }

  it('reads nothing without an expected revision', async () => {
    const { read, run } = check([]);
    await expect(run(ROW)).resolves.toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it('passes a current revision and refuses a stale one', async () => {
    const { read, run } = check([{ resource: ROW, revision: 2 }]);
    await expect(run(ROW, 2)).resolves.toBeUndefined();
    expect(read).toHaveBeenCalledWith([ROW]);
    const stale = run(ROW, 1);
    await expect(stale).rejects.toBeInstanceOf(W5RevisionConflictError);
    await expect(stale).rejects.toMatchObject({
      resource: 'worktree:ws/wt',
      expected: 1,
      actual: 2,
    });
  });

  it('fails when the revision is unavailable', async () => {
    await expect(check([]).run(ROW, 0)).rejects.toThrow(
      'W5 revision unavailable',
    );
  });

  it('builds expected revisions only for a given revision', () => {
    expect(w5ExpectedRevision(ROW)).toBeUndefined();
    expect(w5ExpectedRevision(ROW, 0)).toEqual([
      { resource: ROW, revision: 0 },
    ]);
  });
});

it('loads its entrypoints without node:sqlite', () => {
  jest.isolateModules(() => {
    jest.doMock('node:sqlite', () => {
      throw new Error('node:sqlite was loaded');
    });
    expect((): void => {
      jest.requireActual<object>('../boundary-operation');
      jest.requireActual<object>('../worktree-outcome');
    }).not.toThrow();
  });
});
