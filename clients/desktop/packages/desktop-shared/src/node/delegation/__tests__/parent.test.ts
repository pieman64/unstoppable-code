import { AgentDelegationBroker, type StoredDelegation } from '../broker';
import { AgentRunnerRegistry } from '../runner-registry';
import { DelegationHostMessages, DelegationParent } from '../parent';
import { projectAgentRoute } from '../route';
import { FakeRunner, routeFixture } from './fixtures';
import type {
  AgentDelegationResult,
  AgentDelegationSnapshot,
  AgentDelegationSpawnRequest,
} from '@canopy/protocol/delegation';
import type { DelegationParentContext } from '../types';

const names = {
  spawn: 'Spawn',
  output: 'Output',
  inspect: 'Inspect',
  list: 'List',
  stop: 'Stop',
};
const owner = {
  harnessId: 'claude',
  projectId: 'project',
  worktreeId: 'worktree',
  chatId: 'chat',
  sessionKey: 'project/worktree/chat',
  runtimeGeneration: 1,
  depth: 0,
};
const input = {
  model: 'logical-review-model',
  description: 'Review code',
  prompt: 'Review src/index.ts',
  run_in_background: true,
};

async function setup(
  harness: 'claude' | 'codex' | 'cursor' | 'copilot' = 'claude',
  routeOverrides: Parameters<typeof routeFixture>[0] = {},
  namespace = 'test',
  currentMessage?: () => string | undefined,
): Promise<{
  parent: DelegationParent;
  runner: FakeRunner;
  broker: AgentDelegationBroker;
  records: Map<string, StoredDelegation>;
  enqueue: jest.Mock<Promise<void>, [string]>;
  removeQueued: jest.Mock<Promise<void>, [readonly string[]]>;
  failDeliveryCommit: (status: string | undefined) => void;
  setTurn: (turn: string) => void;
}> {
  const records = new Map<string, StoredDelegation>();
  let rejectedDeliveryStatus: string | undefined;
  const runner = new FakeRunner('local-sdk');
  const registry = new AgentRunnerRegistry();
  registry.register({
    apiVersion: 1,
    registrationId: 'third-local',
    adapter: runner,
  });
  let parent: DelegationParent | undefined = undefined;
  const broker = new AgentDelegationBroker({
    storage: {
      load: (): Promise<readonly StoredDelegation[]> => Promise.resolve([]),
      commit: (value): Promise<void> => {
        if (value.delivery.status === rejectedDeliveryStatus)
          return Promise.reject(new Error('Persistence unavailable'));
        records.set(value.state.delegationId, structuredClone(value));
        return Promise.resolve();
      },
    },
    registry,
    cwd: '/worktree',
    resolveRoute: (): Promise<{
      ok: true;
      value: ReturnType<typeof routeFixture>;
    }> => Promise.resolve({ ok: true, value: routeFixture(routeOverrides) }),
    authorize: (): Promise<{ ok: true; value: undefined }> =>
      Promise.resolve({ ok: true, value: undefined }),
  });
  await broker.initialize();
  const enqueue = jest.fn<Promise<void>, [string]>(() => Promise.resolve());
  const removeQueued = jest.fn<Promise<void>, [readonly string[]]>(() =>
    Promise.resolve(),
  );
  let turn = 'turn';
  parent = new DelegationParent({
    owner: { ...owner, harnessId: harness },
    harness,
    namespace,
    names,
    broker,
    currentTurn: (): string => turn,
    ...(currentMessage === undefined ? {} : { currentMessage }),
    removeQueued,
    reportError: (): void => undefined,
  });
  return {
    parent,
    runner,
    broker,
    records,
    enqueue,
    removeQueued,
    failDeliveryCommit: (status): void => {
      rejectedDeliveryStatus = status;
    },
    setTurn: (next): void => {
      turn = next;
    },
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('managed native parent boundary', () => {
  it.each(['cursor', 'copilot'] as const)(
    'binds %s admission to the host turn and MCP request identity',
    async (harness) => {
      const { parent, runner, setTurn } = await setup(harness);
      try {
        const native = { turnId: 'turn', callId: 'mcp-request-1' };
        const first = await parent.invokeCursor(names.spawn, input, native);
        expect(first.ok).toBe(true);
        expect(await parent.invokeCursor(names.spawn, input, native)).toEqual(
          first,
        );
        await flush();
        expect(runner.starts).toHaveLength(1);
        expect(runner.starts[0]?.parent).toMatchObject({
          harnessId: harness,
          turnId: 'turn',
          userMessageId: 'turn',
          toolCallId: 'mcp-request-1',
        });
        expect(
          (
            await parent.invokeCursor(
              names.spawn,
              { ...input, _hostCorrelation: 'forged' },
              { ...native, callId: 'forged' },
            )
          ).ok,
        ).toBe(false);
        setTurn('next-turn');
        expect((await parent.invokeCursor(names.spawn, input, native)).ok).toBe(
          false,
        );
        expect(runner.starts).toHaveLength(1);
      } finally {
        await parent.close('parent_cancelled');
      }
    },
  );

  it('accepts a lower-kebab brand tool namespace', async () => {
    // Brand manifests require lower-kebab namespaces, such as
    // `unstoppable-code`; the parent must start for every valid brand.
    const { parent } = await setup('claude', {}, 'unstoppable-code');
    try {
      expect(parent.projection.tools.map((tool) => tool.name)).toContain(
        names.spawn,
      );
    } finally {
      await parent.close('parent_cancelled');
    }
  });

  it('keeps the host message identity separate from the native provider turn', async () => {
    const { parent } = await setup('codex');
    try {
      expect(parent.context('native-turn', 'call')).toMatchObject({
        turnId: 'native-turn',
        userMessageId: 'turn',
        toolCallId: 'call',
      });
    } finally {
      await parent.close('parent_cancelled');
    }
  });

  it('uses the message anchor only for cards while Claude authority and bindings use the turn', async () => {
    const messageId = 'card-message';
    const { parent, runner } = await setup(
      'claude',
      {},
      'test',
      (): string => messageId,
    );
    try {
      expect(parent.context()).toMatchObject({
        turnId: 'turn',
        userMessageId: messageId,
      });
      const bound = parent.bindClaude(names.spawn, input, 'call');
      if (!bound.ok) throw new Error('Expected turn-bound Claude call');

      await expect(
        parent.invokeClaude(names.spawn, bound.value),
      ).resolves.toMatchObject({
        ok: true,
      });
      await flush();
      expect(runner.starts).toHaveLength(1);
      expect(runner.starts[0]?.parent).toMatchObject({
        turnId: 'turn',
        userMessageId: messageId,
        toolCallId: 'call',
      });
    } finally {
      await parent.close('parent_cancelled');
    }
  });

  it('anchors each Claude call in one turn to the message current when it was bound', async () => {
    let messageId = 'first-card-message';
    const { parent, runner } = await setup(
      'claude',
      {},
      'test',
      (): string => messageId,
    );
    try {
      const first = parent.bindClaude(names.spawn, input, 'call-1');
      if (!first.ok) throw new Error('Expected the first turn-bound call');
      // An autonomous turn anchors to the latest dispatched message, which
      // can change between two calls without starting a new turn.
      messageId = 'second-card-message';
      const second = parent.bindClaude(names.spawn, input, 'call-2');
      if (!second.ok) throw new Error('Expected the second turn-bound call');

      await expect(
        parent.invokeClaude(names.spawn, first.value),
      ).resolves.toMatchObject({ ok: true });
      await expect(
        parent.invokeClaude(names.spawn, second.value),
      ).resolves.toMatchObject({ ok: true });
      await flush();
      expect(runner.starts.map((start) => start.parent)).toEqual([
        expect.objectContaining({
          turnId: 'turn',
          userMessageId: 'first-card-message',
          toolCallId: 'call-1',
        }),
        expect.objectContaining({
          turnId: 'turn',
          userMessageId: 'second-card-message',
          toolCallId: 'call-2',
        }),
      ]);
    } finally {
      await parent.close('parent_cancelled');
    }
  });

  it('keeps Claude authority when an explicit message anchor is unavailable', async () => {
    const { parent, runner } = await setup(
      'claude',
      {},
      'test',
      (): undefined => undefined,
    );
    try {
      expect(parent.context()).toMatchObject({
        turnId: 'turn',
        userMessageId: undefined,
      });
      const bound = parent.bindClaude(names.spawn, input, 'call');
      if (!bound.ok) throw new Error('Expected turn-bound Claude call');

      await expect(
        parent.invokeClaude(names.spawn, bound.value),
      ).resolves.toMatchObject({
        ok: true,
      });
      await flush();
      expect(runner.starts).toHaveLength(1);
      expect(runner.starts[0]?.parent).toMatchObject({
        turnId: 'turn',
        userMessageId: undefined,
      });
    } finally {
      await parent.close('parent_cancelled');
    }
  });

  it('limits call bindings per turn and rejects a prior turn binding with the same card anchor', async () => {
    const messageId = 'same-card-message';
    const { parent, runner, setTurn } = await setup(
      'claude',
      {},
      'test',
      (): string => messageId,
    );
    try {
      const first = parent.bindClaude(names.spawn, input, 'call-0');
      if (!first.ok) throw new Error('Expected first turn binding');
      const overflow = Array.from({ length: 63 }, (_, index) =>
        parent.bindClaude(names.spawn, input, `call-${String(index + 1)}`),
      );
      expect(overflow.every((result) => result.ok)).toBe(true);
      expect(
        parent.bindClaude(names.spawn, input, 'call-overflow'),
      ).toMatchObject({
        ok: false,
        error: { code: 'capacity_exceeded' },
      });

      setTurn('next-turn');
      expect(parent.context()).toMatchObject({
        turnId: 'next-turn',
        userMessageId: messageId,
      });
      await expect(
        parent.invokeClaude(names.spawn, first.value),
      ).resolves.toMatchObject({
        ok: false,
      });
      const next = parent.bindClaude(names.spawn, input, 'next-call');
      if (!next.ok) throw new Error('Expected next turn to have a fresh limit');
      await expect(
        parent.invokeClaude(names.spawn, next.value),
      ).resolves.toMatchObject({
        ok: true,
      });
      await flush();
      expect(runner.starts).toHaveLength(1);
      expect(runner.starts[0]?.parent).toMatchObject({
        turnId: 'next-turn',
        userMessageId: messageId,
        toolCallId: 'next-call',
      });
    } finally {
      await parent.close('parent_cancelled');
    }
  });

  it('passes the root message anchor through child owner contexts', async () => {
    const messageId = 'root-card-message';
    const { parent, runner, broker } = await setup(
      'claude',
      {},
      'test',
      (): string => messageId,
    );
    try {
      const bound = parent.bindClaude(names.spawn, input, 'call');
      if (!bound.ok) throw new Error('Expected native hook binding');
      await parent.invokeClaude(names.spawn, bound.value);
      await flush();
      const request = runner.starts[0];
      if (!request) throw new Error('Expected child execution request');

      const child = broker.childContext(
        request,
        'child-call',
        'child-communication',
      );
      expect(child).toMatchObject({
        userMessageId: messageId,
        parentDelegationId: request.delegationId,
      });
    } finally {
      await parent.close('parent_cancelled');
    }
  });

  it('retains completion until output is explicitly read', async () => {
    const { parent, runner, broker, records, enqueue } = await setup();
    const bound = parent.bindClaude(names.spawn, input, 'call');
    if (!bound.ok) throw new Error('Expected hook binding');
    await parent.invokeClaude(names.spawn, bound.value);
    await flush();
    const launched = runner.starts[0];
    if (!launched || !runner.sink) throw new Error('Expected child');
    await runner.sink({
      delegationId: launched.delegationId,
      runGeneration: 1,
      sequence: 1,
      occurredAt: Date.now(),
      event: { type: 'terminal', status: 'completed', finalText: 'Finding' },
    });
    await flush();
    expect(records.get(launched.delegationId)?.delivery).toEqual({
      status: 'suppressed',
      reason: 'automatic_delivery_removed',
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(parent.active).toBe(true);
    await parent.close('parent_cancelled');
    await broker.close();
  });

  it('requires a private exact-payload Claude hook binding and rejects recursive, changed and stale callers', async () => {
    const { parent, runner, broker, setTurn } = await setup();
    expect(await parent.invokeClaude(names.spawn, input)).toMatchObject({
      ok: false,
    });
    expect(
      parent.bindClaude(names.spawn, input, 'call', 'nested-agent'),
    ).toMatchObject({ ok: false });
    const bound = parent.bindClaude(names.spawn, input, 'call');
    if (!bound.ok) throw new Error('Expected native hook binding');
    expect(
      await parent.invokeClaude(names.spawn, {
        ...bound.value,
        prompt: 'Changed request',
      }),
    ).toMatchObject({ ok: false });
    const result = await parent.invokeClaude(names.spawn, bound.value);
    expect(result.ok).toBe(true);
    await parent.invokeClaude(names.spawn, bound.value);
    await flush();
    expect(runner.starts).toHaveLength(1);
    setTurn('next-turn');
    expect(await parent.invokeClaude(names.spawn, bound.value)).toMatchObject({
      ok: false,
    });
    await parent.close('parent_cancelled');
    await broker.close();
  });

  it.each(['claude', 'codex'] as const)(
    'returns a %s admission immediately without automatic completion delivery',
    async (harness) => {
      const { parent, runner, broker, records, enqueue } = await setup(harness);
      let result: Promise<unknown>;
      if (harness === 'claude') {
        const bound = parent.bindClaude(
          names.spawn,
          { ...input, run_in_background: false },
          'call',
        );
        if (!bound.ok) throw new Error('Expected hook binding');
        result = parent.invokeClaude(names.spawn, bound.value);
      } else {
        result = parent.invokeCodex(
          names.spawn,
          {
            model: input.model,
            task_name: 'review',
            message: input.prompt,
            execution_mode: 'foreground',
          },
          { callId: 'call', threadId: 'root', turnId: 'turn' },
          'root',
          'turn',
        );
      }
      await flush();
      const launched = runner.starts[0];
      if (!launched || !runner.sink) throw new Error('Expected native child');
      await runner.sink({
        delegationId: launched.delegationId,
        runGeneration: 1,
        sequence: 1,
        occurredAt: Date.now(),
        event: {
          type: 'terminal',
          status: 'completed',
          finalText: 'Review finding',
        },
      });
      expect(await result).toMatchObject({
        ok: true,
        value: { status: 'pending' },
      });
      await flush();
      expect(records.get(launched.delegationId)?.delivery).toEqual({
        status: 'suppressed',
        reason: 'automatic_delivery_removed',
      });
      expect(enqueue).not.toHaveBeenCalled();
      parent.acknowledgeTool('foreign-call', 'wrong-receipt');
      parent.acknowledgeTool('call', 'wrong-turn', 'other-turn');
      await flush();
      parent.acknowledgeMessage(launched.delegationId, 'native-receipt');
      await flush();
      expect(records.get(launched.delegationId)?.delivery.status).toBe(
        'suppressed',
      );
      await parent.close('parent_cancelled');
      await broker.close();
    },
  );

  it('returns an interrupted foreground snapshot without terminal delivery', async () => {
    const { parent, broker } = await setup();
    const interrupted = {
      delegationId: 'interrupted-child',
      status: 'interrupted' as const,
      routeSnapshot: projectAgentRoute(routeFixture()),
      outputTruncated: false,
      error: {
        code: 'launch_uncertain' as const,
        message: 'Child execution could not be confirmed.',
        retryable: false,
      },
    };
    jest
      .spyOn(broker, 'spawn')
      .mockResolvedValue({ ok: true, value: interrupted });
    const bound = parent.bindClaude(
      names.spawn,
      { ...input, run_in_background: false },
      'call',
    );
    if (!bound.ok) throw new Error('Expected hook binding');

    await expect(
      parent.invokeClaude(names.spawn, bound.value),
    ).resolves.toEqual({
      ok: true,
      value: interrupted,
    });
    await parent.close('parent_cancelled');
    await broker.close();
  });

  it('retains completed output without inventing native receipt when notification persistence fails', async () => {
    const { parent, runner, broker, failDeliveryCommit } = await setup();
    const bound = parent.bindClaude(
      names.spawn,
      { ...input, run_in_background: false },
      'call',
    );
    if (!bound.ok) throw new Error('Expected hook binding');
    const result = parent.invokeClaude(names.spawn, bound.value);
    await flush();
    const launched = runner.starts[0];
    if (!launched || !runner.sink) throw new Error('Expected child');
    failDeliveryCommit('queued');
    await runner.sink({
      delegationId: launched.delegationId,
      runGeneration: 1,
      sequence: 1,
      occurredAt: Date.now(),
      event: { type: 'terminal', status: 'completed', finalText: 'Finding' },
    });
    await expect(result).resolves.toMatchObject({
      ok: true,
      value: { status: 'pending' },
    });
    await flush();
    const context = parent.context();
    if (!context) throw new Error('Missing parent context');
    expect(broker.list(context)[0]?.finalText).toBe('Finding');
    await parent.close('parent_cancelled');
    await broker.close();
  });

  it('does not turn a late native receipt into an automatic delivery', async () => {
    const { parent, runner, broker, records } = await setup('claude');
    const bound = parent.bindClaude(names.spawn, input, 'call');
    if (!bound.ok) throw new Error('Expected hook binding');
    await parent.invokeClaude(names.spawn, bound.value);
    await flush();
    const launched = runner.starts[0];
    if (!launched || !runner.sink) throw new Error('Expected child');
    await runner.sink({
      delegationId: launched.delegationId,
      runGeneration: 1,
      sequence: 1,
      occurredAt: Date.now(),
      event: { type: 'terminal', status: 'completed', finalText: 'Finding' },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    await flush();
    expect(records.get(launched.delegationId)?.delivery.status).toBe(
      'suppressed',
    );

    parent.acknowledgeMessage(launched.delegationId, 'late-native-receipt');
    await flush();
    expect(records.get(launched.delegationId)?.delivery.status).toBe(
      'suppressed',
    );
    await parent.close('parent_cancelled');
    await broker.close();
  });

  it('keeps both follow-up generations silent and explicitly readable', async () => {
    const { parent, runner, broker, records, enqueue } = await setup('claude', {
      capabilities: ['read', 'resume'],
    });
    const bound = parent.bindClaude(names.spawn, input, 'call');
    if (!bound.ok) throw new Error('Expected hook binding');
    await parent.invokeClaude(names.spawn, bound.value);
    await flush();
    const launched = runner.starts[0];
    if (!launched || !runner.sink) throw new Error('Expected child');
    await runner.sink({
      delegationId: launched.delegationId,
      runGeneration: 1,
      sequence: 1,
      occurredAt: 1,
      event: { type: 'started', nativeSessionId: 'native-child' },
    });
    await runner.sink({
      delegationId: launched.delegationId,
      runGeneration: 1,
      sequence: 2,
      occurredAt: 2,
      event: { type: 'terminal', status: 'completed', finalText: 'First' },
    });
    await flush();
    expect(enqueue).not.toHaveBeenCalled();

    const context = parent.context('resume-turn', 'resume-call');
    if (!context) throw new Error('Missing parent context');
    await broker.message(context, {
      delegationId: launched.delegationId,
      operation: 'follow_up',
      message: 'Continue',
    });
    await flush();
    await flush();
    expect(records.get(launched.delegationId)?.delivery.status).toBe(
      'suppressed',
    );
    await runner.sink({
      delegationId: launched.delegationId,
      runGeneration: 2,
      sequence: 1,
      occurredAt: 3,
      event: { type: 'terminal', status: 'completed', finalText: 'Second' },
    });
    await flush();
    expect(enqueue).not.toHaveBeenCalled();
    expect(records.get(launched.delegationId)?.delivery.status).toBe(
      'suppressed',
    );
    expect(
      await broker.getOutput(context, { delegationId: launched.delegationId }),
    ).toMatchObject({
      ok: true,
      value: {
        latestResultIndex: 2,
        result: { resultIndex: 2, finalText: 'Second' },
      },
    });
    await parent.close('parent_cancelled');
    await broker.close();
  });

  it('rejects Codex calls from a child thread or stale native turn before reservation', async () => {
    const { parent, runner, broker } = await setup('codex');
    for (const native of [
      { callId: 'call', threadId: 'child', turnId: 'turn' },
      { callId: 'call', threadId: 'root', turnId: 'old-turn' },
    ]) {
      expect(
        await parent.invokeCodex(
          names.spawn,
          { model: input.model, task_name: 'review', message: input.prompt },
          native,
          'root',
          'turn',
        ),
      ).toMatchObject({ ok: false, error: { code: 'parent_unavailable' } });
    }
    expect(runner.starts).toHaveLength(0);
    await parent.close('parent_cancelled');
    await broker.close();
  });

  it('does not create a background message when a child completes', async () => {
    const { parent, runner, broker, records, enqueue } = await setup();
    const bound = parent.bindClaude(names.spawn, input, 'call');
    if (!bound.ok) throw new Error('Expected binding');
    await parent.invokeClaude(names.spawn, bound.value);
    await flush();
    const launched = runner.starts[0];
    if (!launched || !runner.sink) throw new Error('Expected child');
    await runner.sink({
      delegationId: launched.delegationId,
      runGeneration: 1,
      sequence: 1,
      occurredAt: Date.now(),
      event: {
        type: 'terminal',
        status: 'completed',
        finalText: 'Background finding',
      },
    });
    await flush();
    expect(enqueue).not.toHaveBeenCalled();
    expect(parent.nativeMessageUuid(launched.delegationId)).toBeUndefined();
    expect(parent.canDispatchMessage(launched.delegationId)).toBe(false);
    expect(parent.claimMessageDispatch('foreign')).toBe(false);
    expect(parent.claimMessageDispatch(launched.delegationId)).toBe(false);
    expect(records.get(launched.delegationId)?.delivery).toEqual({
      status: 'suppressed',
      reason: 'automatic_delivery_removed',
    });
    await parent.close('parent_cancelled');
    await broker.close();
  });

  it('cancels its child without a queued completion notification', async () => {
    const { parent, runner, broker, removeQueued } = await setup();
    const bound = parent.bindClaude(names.spawn, input, 'call');
    if (!bound.ok) throw new Error('Expected binding');
    await parent.invokeClaude(names.spawn, bound.value);
    await flush();
    await expect(parent.close('parent_cancelled')).resolves.toBeUndefined();
    expect(removeQueued).toHaveBeenCalledWith([]);
    expect(runner.stopped).toHaveLength(1);
    expect(
      broker.activeCount({ ...owner, turnId: 'turn', toolCallId: 'host' }),
    ).toBe(0);
    await broker.close();
  });
});

it.each(['claude', 'codex'] as const)(
  '%s discovers models through native call binding and refuses launches after revocation',
  async (harness) => {
    const { parent, broker, runner } = await setup(harness);
    const discoverModels = jest.fn(() =>
      Promise.resolve({
        models: [],
        truncated: false,
      }),
    );
    const onInvocation = jest.fn<
      void,
      [
        DelegationParentContext,
        AgentDelegationSpawnRequest,
        AgentDelegationResult<AgentDelegationSnapshot>,
      ]
    >();
    const gated = new DelegationParent({
      ...parent.options,
      discoverModels,
      authorizeSpawn: (): boolean => false,
      onInvocation,
    });
    try {
      const invoke = (
        name: string,
        args: unknown,
      ): ReturnType<DelegationParent['invokeClaude']> => {
        if (harness === 'codex')
          return gated.invokeCodex(
            name,
            args,
            { callId: name, turnId: 'turn', threadId: 'root' },
            'root',
            'turn',
          );
        const bound = gated.bindClaude(name, args, name);
        if (!bound.ok) throw new Error(bound.error.message);
        return gated.invokeClaude(name, bound.value);
      };
      expect(await invoke(names.list, { includeModels: true })).toEqual({
        ok: true,
        value: { delegations: [], models: [], truncated: false },
      });
      expect(discoverModels).toHaveBeenCalledTimes(1);
      expect(
        await invoke(
          names.spawn,
          harness === 'claude'
            ? input
            : {
                model: input.model,
                task_name: 'review',
                message: input.prompt,
              },
        ),
      ).toMatchObject({ ok: false, error: { code: 'policy_blocked' } });
      expect(onInvocation).toHaveBeenCalledTimes(1);
      expect(onInvocation.mock.calls[0]?.[0].toolCallId).toBe(names.spawn);
      expect(onInvocation.mock.calls[0]?.[1].prompt).toBe(input.prompt);
      expect(onInvocation.mock.calls[0]?.[2]).toMatchObject({
        ok: false,
        error: { code: 'policy_blocked' },
      });
      expect(runner.starts).toHaveLength(0);
    } finally {
      await gated.close('parent_cancelled');
      await parent.close('parent_cancelled');
      await broker.close();
    }
  },
);

it('returns a foreground-shaped Claude MCP call before the child completes', async () => {
  const { parent, runner } = await setup();
  try {
    const bound = parent.bindClaude(
      names.spawn,
      { ...input, run_in_background: false },
      'async-call',
    );
    if (!bound.ok) throw new Error('fixture binding failed');
    let returned = false;
    const response = parent
      .invokeClaude(names.spawn, bound.value)
      .then((result) => {
        returned = true;
        return result;
      });
    await flush();
    expect(runner.starts).toHaveLength(1);
    expect(returned).toBe(true);
    expect((await response).ok).toBe(true);
  } finally {
    await parent.close('parent_cancelled');
  }
});

it('gives an apply its outcome wait while other commands keep the short budget', async () => {
  const { broker } = await setup();
  const manageName = 'Manage';
  const manage = new DelegationParent({
    owner,
    harness: 'claude',
    namespace: 'test',
    names: { ...names, manageWorktree: manageName },
    broker,
    currentTurn: (): string => 'turn',
    removeQueued: (): Promise<void> => Promise.resolve(),
    reportError: (): void => undefined,
    responseBudgetMs: 10,
    applyResponseBudgetMs: 1_000,
  });
  const outcome: AgentDelegationResult<unknown> = {
    ok: false,
    error: {
      code: 'apply_failed',
      message: 'Nothing was applied.',
      retryable: false,
    },
  };
  const slow = jest
    .spyOn(broker, 'manageWorktree')
    .mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(outcome), 100)),
    );
  try {
    const results = [];
    for (const operation of ['apply', 'discard'] as const) {
      const call = {
        delegationId: '00000000-0000-4000-8000-000000000001',
        operation,
      };
      const bound = manage.bindClaude(manageName, call, `call-${operation}`);
      if (!bound.ok) throw new Error('Expected owned call');
      results.push(await manage.invokeClaude(manageName, bound.value));
    }
    expect(results[0]).toEqual(outcome);
    expect(results[1]).toMatchObject({
      ok: false,
      error: { code: 'runtime_error', retryable: true },
    });
  } finally {
    slow.mockRestore();
    await manage.close('shutdown');
    await broker.close();
  }
});

it('returns within the response budget without cancelling an ambiguous durable admission', async () => {
  const { parent, broker } = await setup();
  parent.options.responseBudgetMs = 10;
  let complete:
    | ((result: AgentDelegationResult<AgentDelegationSnapshot>) => void)
    | undefined;
  const spawn = jest.spyOn(broker, 'spawn').mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const bound = parent.bindClaude(names.spawn, input, 'slow-store');
  if (!bound.ok) throw new Error('Expected owned call');
  expect(await parent.invokeClaude(names.spawn, bound.value)).toMatchObject({
    ok: false,
    error: { retryable: true },
  });
  expect(parent.active).toBe(true);
  if (!complete) throw new Error('Expected pending admission');
  complete({
    ok: false,
    error: {
      code: 'runtime_error',
      retryable: true,
      message: 'Storage failed',
    },
  });
  await flush();
  expect(spawn).toHaveBeenCalledTimes(1);
  spawn.mockRestore();
  await parent.close('shutdown');
  await broker.close();
});

it('keeps an admitted upward message across tool generations of one root chat', async () => {
  const { broker } = await setup();
  const hostMessages = new DelegationHostMessages();
  const generation = (): DelegationParent =>
    new DelegationParent({
      owner,
      harness: 'claude',
      namespace: 'test',
      names,
      broker,
      currentTurn: (): string => 'turn',
      removeQueued: (): Promise<void> => Promise.resolve(),
      reportError: (): void => undefined,
      hostMessages,
    });
  const first = generation();
  const id = '658d815f-52b4-4e76-b030-ab8b80162e68';
  try {
    expect(first.authorizeHostMessage(id)).toBe(true);
    // The session that admitted the message is replaced before dispatch.
    first.detach();
    expect(first.canDispatchMessage(id)).toBe(false);
    expect(hostMessages.canDispatch(id)).toBe(true);

    const next = generation();
    expect(next.claimMessageDispatch(id)).toBe(true);
    expect(next.nativeMessageUuid(id)).toBe(id);
    next.acknowledgeMessage(id, 'native-receipt');
    expect(hostMessages.ids).toEqual([]);
    next.detach();
  } finally {
    await broker.close();
  }
});
