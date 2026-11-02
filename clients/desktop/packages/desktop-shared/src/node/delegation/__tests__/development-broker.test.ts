import {
  AGENT_DELEGATION_INPUT_LIMITS,
  type AgentDelegationResult,
} from '@canopy/protocol/delegation';
import type { ResolvedAgentRouteSnapshot } from '../types';
import { InMemoryDelegationTranscriptPort } from '../in-memory-transcript-port';
import { DevelopmentDelegationBroker } from '../development-broker';
import { createDevelopmentDelegationProjection } from '../development-projections';
import type {
  DelegationTranscriptChange,
  DelegationTranscriptTarget,
} from '../transcript-port';
import { routeFixture } from './fixtures';

const parent = {
  harnessId: 'third-parent',
  projectId: 'project',
  worktreeId: 'worktree',
  chatId: 'chat',
  sessionKey: 'session',
  turnId: 'turn',
  toolCallId: 'tool',
  runtimeGeneration: 1,
  depth: 0,
};
const task = {
  modelId: 'logical-model',
  description: 'Read',
  prompt: 'Read the selected file',
  thinkingLevel: 'low' as const,
};

function transcriptTarget(
  chatId: string,
  delegationId: string,
  runGeneration = 1,
): DelegationTranscriptTarget {
  return { kind: 'delegation', chatId, delegationId, runGeneration };
}

function transcriptChange(): DelegationTranscriptChange {
  return {
    row: {
      id: 'retained-row',
      role: 'assistant',
      timestamp: 1,
      parentBlockId: 'agent-call',
      delegationSequence: 0,
      blocks: [],
      itemRevision: 0,
      final: false,
    },
  };
}

describe('developer-only projections over one fake broker', () => {
  let broker: DevelopmentDelegationBroker;
  beforeEach(() => {
    broker = new DevelopmentDelegationBroker({
      mode: 'development-probe',
      resolveRoute: (
        request,
      ): Promise<AgentDelegationResult<ResolvedAgentRouteSnapshot>> =>
        Promise.resolve({
          ok: true,
          value: routeFixture({ selectedModelId: request.modelId }),
        }),
    });
  });
  afterEach(() => broker.close());

  it('scopes its default port to known parent chats and retains completed streams', async () => {
    const unknown = await broker.transcriptPort.open({
      target: transcriptTarget(parent.chatId, 'unknown-child'),
    });
    expect(unknown).toMatchObject({
      ok: false,
      error: { code: 'unauthorized' },
    });

    const first = await broker.spawn(parent, task);
    if (!first.ok) throw new Error(first.error.message);
    const firstTarget = transcriptTarget(
      parent.chatId,
      first.value.delegationId,
    );

    const otherParent = {
      ...parent,
      chatId: 'second-chat',
      sessionKey: 'second-session',
      turnId: 'second-turn',
      toolCallId: 'second-tool',
    };
    const second = await broker.spawn(otherParent, task);
    if (!second.ok) throw new Error(second.error.message);
    const secondTarget = transcriptTarget(
      otherParent.chatId,
      second.value.delegationId,
    );

    const foreign = await broker.transcriptPort.open({
      target: transcriptTarget('foreign-chat', first.value.delegationId),
    });
    expect(foreign).toMatchObject({
      ok: false,
      error: { code: 'unauthorized' },
    });
    const firstOpen = await broker.transcriptPort.open({ target: firstTarget });
    const secondOpen = await broker.transcriptPort.open({
      target: secondTarget,
    });
    expect(firstOpen).toMatchObject({ ok: true });
    expect(secondOpen).toMatchObject({ ok: true });

    const append = await broker.transcriptPort.appendChanges({
      target: firstTarget,
      mutationKey: 'retained-row-0',
      changes: [transcriptChange()],
    });
    if (!append.ok) throw new Error(append.error.message);
    broker.finish(first.value.delegationId, 'completed', 'Retained report');
    const read = await broker.transcriptPort.message({
      target: firstTarget,
      streamRevision: append.value.streamRevision,
      messageId: 'retained-row',
    });
    expect(read).toMatchObject({
      ok: true,
      value: { id: 'retained-row', itemRevision: 0 },
    });
  });

  it('exposes an explicitly injected transcript port unchanged', () => {
    const injectedPort = new InMemoryDelegationTranscriptPort({
      owns: (target: DelegationTranscriptTarget): boolean =>
        target.chatId === parent.chatId,
    });
    broker = new DevelopmentDelegationBroker({
      mode: 'development-probe',
      resolveRoute: (
        request,
      ): Promise<AgentDelegationResult<ResolvedAgentRouteSnapshot>> =>
        Promise.resolve({
          ok: true,
          value: routeFixture({ selectedModelId: request.modelId }),
        }),
      transcriptPort: injectedPort,
    });

    expect(broker.transcriptPort).toBe(injectedPort);
  });

  it.each(['claude', 'codex'] as const)(
    'runs the %s shaped schema through the same lifecycle with no child recursion',
    async (harness) => {
      const projection = createDevelopmentDelegationProjection(
        harness,
        'probe',
        broker,
      );
      const spawn = projection.tools[0];
      if (!spawn) throw new Error('Missing spawn tool');
      const input =
        harness === 'claude'
          ? {
              model: task.modelId,
              description: task.description,
              prompt: task.prompt,
              thinking_level: 'low',
            }
          : {
              model: task.modelId,
              task_name: task.description,
              message: task.prompt,
              reasoning_effort: 'low',
            };
      const result = await projection.invoke(parent, spawn.name, input);
      expect(result.ok).toBe(true);
      const child = broker.list(parent)[0];
      if (!child) throw new Error('Missing child');
      const routeSnapshot = child.routeSnapshot;
      if (!routeSnapshot) throw new Error('Missing child route snapshot');
      expect(routeSnapshot.effectiveThinkingLevel).toBe('low');
      expect(projection.tools.map((tool) => tool.name)).not.toContain(
        'probe_watch_delegates',
      );
      expect(broker.activeCount(parent)).toBe(1);
      expect(
        await projection.invoke({ ...parent, depth: 1 }, spawn.name, input),
      ).toMatchObject({ ok: false, error: { code: 'parent_unavailable' } });
      expect(
        await projection.invoke(parent, spawn.name, {
          ...input,
          harnessId: 'raw-harness',
        }),
      ).toMatchObject({ ok: false });
      broker.finish(child.delegationId, 'completed', 'Retained report');
      const complete = await projection.invoke(
        parent,
        'probe_inspect_delegate',
        { delegationId: child.delegationId },
      );
      expect(complete).toMatchObject({
        ok: true,
        value: { status: 'completed', finalText: 'Retained report' },
      });
      expect(
        await projection.invoke(parent, 'probe_inspect_delegate', {
          delegationId: child.delegationId,
        }),
      ).toEqual(complete);
      expect(broker.activeCount(parent)).toBe(0);
      expect(projection.tools.map((tool) => tool.name)).not.toEqual(
        expect.arrayContaining(['Agent', 'spawn_agent', 'followup_task']),
      );
      const legacyWait = await projection.invoke(
        parent,
        'probe_wait_delegates',
        {},
      );
      expect(legacyWait.ok).toBe(false);
      if (legacyWait.ok) throw new Error('Legacy wait unexpectedly succeeded');
      expect(legacyWait.error.message).toContain(
        'Completion notices arrive automatically',
      );
      const legacyManage = await projection.invoke(
        parent,
        'probe_manage_delegate',
        {},
      );
      expect(legacyManage.ok).toBe(false);
      if (legacyManage.ok)
        throw new Error('Legacy manage unexpectedly succeeded');
      expect(legacyManage.error.message).toContain('Message Delegate');
    },
  );

  it.each(['claude', 'codex'] as const)(
    'does not list or dispatch the retired %s watch tool',
    async (harness) => {
      const projection = createDevelopmentDelegationProjection(
        harness,
        'probe',
        broker,
      );
      const watch = projection.tools.find(
        (tool) => tool.name === 'probe_watch_delegates',
      );
      expect(watch).toBeUndefined();
      expect(
        await projection.invoke(parent, 'probe_watch_delegates', {
          delegationIds: ['missing-child'],
          mode: 'any',
          timeoutMs: AGENT_DELEGATION_INPUT_LIMITS.waitTimeoutMs + 1,
        }),
      ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    },
  );

  it('reserves duplicate native calls before asynchronous routing and rejects changed arguments', async () => {
    let release: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let resolutions = 0;
    broker = new DevelopmentDelegationBroker({
      mode: 'development-probe',
      resolveRoute: async (): Promise<
        AgentDelegationResult<ResolvedAgentRouteSnapshot>
      > => {
        resolutions += 1;
        await barrier;
        return {
          ok: true,
          value: routeFixture({ selectedModelId: task.modelId }),
        };
      },
    });
    const first = broker.spawn(parent, task);
    const duplicate = broker.spawn(parent, task);
    expect(broker.activeCount(parent)).toBe(1);
    expect(
      await broker.spawn(parent, { ...task, prompt: 'Different task' }),
    ).toMatchObject({ ok: false });
    release?.();
    expect(await first).toEqual(await duplicate);
    expect(resolutions).toBe(1);
    expect(broker.list(parent)).toHaveLength(1);
  });

  it('keeps a child active after ordinary root completion and cancels it only on explicit owner teardown', async () => {
    const result = await broker.spawn(parent, task);
    if (!result.ok) throw new Error(result.error.message);
    const nextTurn = {
      ...parent,
      turnId: 'next-turn',
      toolCallId: 'next-call',
    };
    expect(broker.activeCount(nextTurn)).toBe(1);
    expect(
      broker.inspect(
        { ...parent, chatId: 'foreign-chat' },
        result.value.delegationId,
      ),
    ).toBeUndefined();
    expect(
      broker.inspect(
        { ...parent, runtimeGeneration: 2 },
        result.value.delegationId,
      ),
    ).toBeUndefined();
    broker.closeOwner(nextTurn);
    broker.closeOwner(nextTurn);
    expect(broker.activeCount(parent)).toBe(0);
    expect(broker.inspect(parent, result.value.delegationId)?.status).toBe(
      'cancelled',
    );
    expect(await broker.spawn(nextTurn, task)).toMatchObject({ ok: false });
  });

  it('settles event-driven waits and enforces capacity without cancelling unrelated children', async () => {
    broker = new DevelopmentDelegationBroker({
      mode: 'development-probe',
      capacity: 1,
      resolveRoute: (): Promise<
        AgentDelegationResult<ResolvedAgentRouteSnapshot>
      > =>
        Promise.resolve({
          ok: true,
          value: routeFixture({ selectedModelId: task.modelId }),
        }),
    });
    const first = await broker.spawn(parent, task);
    if (!first.ok) throw new Error(first.error.message);
    expect(
      await broker.spawn({ ...parent, toolCallId: 'second' }, task),
    ).toMatchObject({ ok: false, error: { code: 'capacity_exceeded' } });
    const waiting = broker.wait(parent, {
      delegationIds: [first.value.delegationId],
      timeoutMs: 1000,
    });
    broker.stop(parent, first.value.delegationId);
    expect(await waiting).toMatchObject({
      ok: true,
      value: { timedOut: false, snapshots: [{ status: 'cancelled' }] },
    });
    expect(
      (await broker.spawn({ ...parent, toolCallId: 'third' }, task)).ok,
    ).toBe(true);
  });

  it('does not launch after owner cancellation while model resolution is pending', async () => {
    let release: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    broker = new DevelopmentDelegationBroker({
      mode: 'development-probe',
      resolveRoute: async (): Promise<
        AgentDelegationResult<ResolvedAgentRouteSnapshot>
      > => {
        await barrier;
        return {
          ok: true,
          value: routeFixture({ selectedModelId: task.modelId }),
        };
      },
    });
    const pending = broker.spawn(parent, task);
    broker.closeOwner(parent);
    release?.();
    expect(await pending).toMatchObject({ ok: false });
    expect(broker.list(parent)).toEqual([]);
    expect(broker.activeCount(parent)).toBe(0);
  });
});
