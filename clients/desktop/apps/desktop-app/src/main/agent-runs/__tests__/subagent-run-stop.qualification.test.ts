import type { DelegationParentContext } from '@canopy/desktop-shared/node/delegation';
import type { AgentDelegationSnapshot } from '@canopy/protocol/delegation';
import {
  stopDelegationForUser,
  type UserStopBroker,
} from '../../agents/delegation/user-stop';
import {
  SubagentNativeStopRefusedError,
  stopSubagentNatively,
} from '../subagent-native-stop';

const mockStop = jest.fn<
  Promise<{ ok: boolean }>,
  [
    { projectId: string; worktreeId: string; chatId: string },
    string,
    number | undefined,
  ]
>();
jest.mock('../../agents/delegation/service', () => ({
  stopManagedDelegationForUser: (
    target: { projectId: string; worktreeId: string; chatId: string },
    delegationId: string,
    expectedRunGeneration?: number,
  ): Promise<{ ok: boolean }> =>
    mockStop(target, delegationId, expectedRunGeneration),
}));

const target = {
  subagentRunId: 'sub-1',
  delegationId: 'del-1',
  runGeneration: 1,
  scope: { workspaceId: 'ws-1', worktreeId: 'wt-1', chatId: 'chat-1' },
};

describe('subagent run stop (CAN-4112)', () => {
  afterEach(() => mockStop.mockReset());

  it("maps the run to the broker's user stop for its generation", async () => {
    mockStop.mockResolvedValue({ ok: true });

    await expect(stopSubagentNatively(target)).resolves.toBeUndefined();

    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(mockStop).toHaveBeenCalledWith(
      { projectId: 'ws-1', worktreeId: 'wt-1', chatId: 'chat-1' },
      'del-1',
      1,
    );
  });

  it('a refused stop throws', async () => {
    mockStop.mockResolvedValue({ ok: false });

    await expect(stopSubagentNatively(target)).rejects.toBeInstanceOf(
      SubagentNativeStopRefusedError,
    );
  });
});

describe('the user stop generation guard (CAN-4112)', () => {
  const parent: DelegationParentContext = {
    harnessId: 'harness',
    projectId: 'ws-1',
    worktreeId: 'wt-1',
    chatId: 'chat-1',
    sessionKey: 'session',
    turnId: 'turn',
    toolCallId: 'tool',
    runtimeGeneration: 1,
    depth: 0,
  };

  function fakeBroker(
    initialGeneration: number,
    {
      advanceOnStop,
      withChild = false,
      grandchildOnStop = false,
    }: {
      advanceOnStop?: 'target' | 'child';
      withChild?: boolean;
      grandchildOnStop?: boolean;
    } = {},
  ): {
    broker: UserStopBroker;
    stops: string[];
    stopOptions: Array<{ readonly expectedRunGeneration?: number } | undefined>;
    advance(): void;
  } {
    let runGeneration = initialGeneration;
    let childGeneration = 1;
    let grandchild = false;
    const stops: string[] = [];
    const stopOptions: Array<
      { readonly expectedRunGeneration?: number } | undefined
    > = [];
    const snapshot = (): AgentDelegationSnapshot => ({
      delegationId: 'del-1',
      status: 'running',
      outputTruncated: false,
      runGeneration,
    });
    return {
      stops,
      stopOptions,
      advance: () => {
        runGeneration += 1;
      },
      broker: {
        inspect: () => snapshot(),
        list: (): AgentDelegationSnapshot[] => [
          ...(withChild
            ? [
                {
                  delegationId: 'child-1',
                  status: 'running' as const,
                  outputTruncated: false,
                  runGeneration: childGeneration,
                  parentDelegationId: 'del-1',
                },
              ]
            : []),
          ...(grandchild
            ? [
                {
                  delegationId: 'grandchild-1',
                  status: 'running' as const,
                  outputTruncated: false,
                  runGeneration: 1,
                  parentDelegationId: 'child-1',
                },
              ]
            : []),
        ],
        stop: (_parent, id, _reason, options) => {
          stops.push(id);
          // A follow-up starts the next generation while the broker stop waits.
          if (advanceOnStop === 'target') runGeneration += 1;
          if (advanceOnStop === 'child') childGeneration += 1;
          // The child spawns a delegate while the broker stop waits.
          if (grandchildOnStop) grandchild = true;
          stopOptions.push(options);
          return Promise.resolve({ ok: true, value: snapshot() });
        },
      },
    };
  }

  it('stops the delegation when its generation still matches', async () => {
    const fake = fakeBroker(1);
    const retired: Array<ReadonlySet<string>> = [];

    await expect(
      stopDelegationForUser({
        broker: fake.broker,
        parent,
        delegationId: 'del-1',
        expectedRunGeneration: 1,
        retireWatchers: (ids) => {
          retired.push(ids);
          return Promise.resolve();
        },
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(fake.stops).toEqual(['del-1']);
    // The broker stop is bound to the generation too (CAN-5867).
    expect(fake.stopOptions).toEqual([{ expectedRunGeneration: 1 }]);
    expect(retired).toHaveLength(2);
  });

  it('leaves a delegation that already moved to another generation running', async () => {
    const fake = fakeBroker(2);
    const retireWatchers = jest.fn(() => Promise.resolve());

    await expect(
      stopDelegationForUser({
        broker: fake.broker,
        parent,
        delegationId: 'del-1',
        expectedRunGeneration: 1,
        retireWatchers,
      }),
    ).resolves.toMatchObject({ ok: true, value: { runGeneration: 2 } });

    expect(fake.stops).toEqual([]);
    expect(retireWatchers).not.toHaveBeenCalled();
  });

  it('does not stop a generation that started while watchers were retired', async () => {
    const fake = fakeBroker(1);

    await expect(
      stopDelegationForUser({
        broker: fake.broker,
        parent,
        delegationId: 'del-1',
        expectedRunGeneration: 1,
        retireWatchers: () => {
          fake.advance();
          return Promise.resolve();
        },
      }),
    ).resolves.toMatchObject({ ok: true, value: { runGeneration: 2 } });

    expect(fake.stops).toEqual([]);
  });

  it('keeps the watchers of a generation that started during the broker stop', async () => {
    const fake = fakeBroker(1, { advanceOnStop: 'target' });
    const retireWatchers = jest.fn(() => Promise.resolve());

    await expect(
      stopDelegationForUser({
        broker: fake.broker,
        parent,
        delegationId: 'del-1',
        expectedRunGeneration: 1,
        retireWatchers,
      }),
    ).resolves.toMatchObject({ ok: true, value: { runGeneration: 2 } });

    expect(fake.stops).toEqual(['del-1']);
    // Only the retirement before the stop; generation 2's watchers stay (CAN-5867).
    expect(retireWatchers).toHaveBeenCalledTimes(1);
  });

  it('keeps the watchers of a descendant that moved during the broker stop', async () => {
    const fake = fakeBroker(1, { advanceOnStop: 'child', withChild: true });
    const retired: Array<ReadonlySet<string>> = [];

    await expect(
      stopDelegationForUser({
        broker: fake.broker,
        parent,
        delegationId: 'del-1',
        expectedRunGeneration: 1,
        retireWatchers: (ids) => {
          retired.push(ids);
          return Promise.resolve();
        },
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(retired.map((ids) => [...ids].sort())).toEqual([
      ['child-1', 'del-1'],
      ['del-1'],
    ]);
  });

  it.each([
    ['moved', 'child', [['del-1']]],
    ['stayed', undefined, [['child-1', 'del-1', 'grandchild-1']]],
  ] as const)(
    'a delegate spawned during the broker stop follows its parent, whose generation %s',
    async (_label, advanceOnStop, after) => {
      const fake = fakeBroker(1, {
        withChild: true,
        grandchildOnStop: true,
        ...(advanceOnStop ? { advanceOnStop } : {}),
      });
      const retired: Array<ReadonlySet<string>> = [];

      await stopDelegationForUser({
        broker: fake.broker,
        parent,
        delegationId: 'del-1',
        expectedRunGeneration: 1,
        retireWatchers: (ids) => {
          retired.push(ids);
          return Promise.resolve();
        },
      });

      expect(retired.slice(1).map((ids) => [...ids].sort())).toEqual(after);
    },
  );

  it('without an expected generation stops whatever generation is current', async () => {
    const fake = fakeBroker(3);

    await expect(
      stopDelegationForUser({
        broker: fake.broker,
        parent,
        delegationId: 'del-1',
        retireWatchers: () => Promise.resolve(),
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(fake.stops).toEqual(['del-1']);
    expect(fake.stopOptions).toEqual([{}]);
  });
});
