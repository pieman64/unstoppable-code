import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositoryTranscriptPortFixture } from '../../__tests__/helpers/repository-transcript-port-fixture';
import {
  subscribePortalDelegationCardEvents,
  type PortalDelegationCardPort,
  type PortalCardEventAdapter,
} from '../portal-delegation-card-events';
import type {
  ChatStateChangedEvent,
  ChatStateChange,
  PortalEventEnvelope,
} from '@canopy/desktop-shared/types';
import type {
  PersistedChatMessage,
  DelegatedAgentCallBlock,
} from '@canopy/agent-transcript';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function settle(): Promise<void> {
  for (let i = 0; i < 16; i++) await Promise.resolve();
}
function card(id = 'd', generation = 1): DelegatedAgentCallBlock {
  return {
    type: 'delegated_agent_call',
    delegationId: id,
    agentBlockId: `delegated-agent-${id}`,
    runGeneration: generation,
    sequence: 1,
    parentHarnessId: 'claude',
    parentTurnId: 'turn',
    parentToolCallId: 'tool',
    createdAt: 10,
    requestedModelId: 'model',
    selectedModelId: 'model',
    runtimeModelId: 'model',
    targetHarnessId: 'claude',
    description: 'Inspect',
    prompt: 'Inspect',
    executionMode: 'background',
    status: 'pending',
    outputTruncated: false,
    transcriptStore: 'chat-stream-v2',
  };
}
function row(id = 'd', generation = 1): PersistedChatMessage {
  return {
    id: `delegated-agent-${id}${generation > 1 ? `-run-${generation}` : ''}`,
    role: 'assistant',
    timestamp: 10,
    blocks: [
      { type: 'text', text: 'unrelated' },
      card(id, generation),
      card('other'),
    ],
  };
}
function change(
  id = 'd',
  runGeneration = 1,
  cardRevision = 1,
  streamRevision = 7,
): ChatStateChange {
  return {
    type: 'delegation.card_state_updated',
    chatId: 'chat',
    delegationId: id,
    runGeneration,
    cardRevision,
    streamRevision,
    cardState: {
      version: 2,
      cardRevision,
      requestedModelId: 'model',
      status: 'pending',
      outputTruncated: false,
    },
  };
}
interface Harness {
  port: PortalDelegationCardPort;
  emitted: PortalEventEnvelope[];
  adapter: PortalCardEventAdapter;
  publish(changes: ChatStateChange[], revision?: number): void;
  listeners: Set<unknown>;
  invalidate(): void;
}
function setup(): Harness {
  let listener: ((event: ChatStateChangedEvent) => void) | undefined;
  const listeners = new Set<unknown>();
  const port: PortalDelegationCardPort = {
    subscribe: jest.fn((next) => {
      listener = next;
      listeners.add(next);
      return (): void => {
        listeners.delete(next);
      };
    }),
    resolveOwner: jest.fn((scope) =>
      Promise.resolve({
        scope,
        source: {
          scope: 'worktree',
          workspaceLocalId: scope.projectId,
          worktreeLocalId: scope.worktreeId,
        },
      }),
    ),
    generation: jest.fn((_scope, target) =>
      Promise.resolve({
        entry: {
          ...target,
          version: 1,
          kind: 'generation',
          createdAt: 10,
          store: 'stream',
          executionMode: 'background',
          origin: { kind: 'launch' },
        },
        stream: null,
        result: null,
      }),
    ),
    readStoredParentMessage: jest.fn((_scope, _chat, messageId) =>
      Promise.resolve({ ...row(), id: messageId }),
    ),
  };
  const emitted: PortalEventEnvelope[] = [];
  let current = true;
  const adapter = subscribePortalDelegationCardEvents(
    port,
    (event) => emitted.push(event),
    () => current,
  );
  function publish(changes: ChatStateChange[], revision = 10): void {
    listener?.({
      schemaVersion: 1,
      eventId: `event-${revision}`,
      occurredAt: '2026-10-21T00:00:00.000Z',
      projectId: 'owner',
      worktreeId: 'worktree',
      baseRevision: revision - 1,
      revision,
      changes,
    });
  }
  return {
    port,
    emitted,
    adapter,
    publish,
    listeners,
    invalidate: (): void => {
      current = false;
    },
  };
}
type HeldStage = 'resolveOwner' | 'generation' | 'readStoredParentMessage';
function holdStage(h: Harness, stage: HeldStage): () => void {
  if (stage === 'resolveOwner') {
    const held =
      deferred<Awaited<ReturnType<PortalDelegationCardPort['resolveOwner']>>>();
    jest.spyOn(h.port, stage).mockReturnValueOnce(held.promise);
    return () =>
      held.resolve({
        scope: { projectId: 'owner', worktreeId: 'worktree' },
        source: {
          scope: 'worktree',
          workspaceLocalId: 'owner',
          worktreeLocalId: 'worktree',
        },
      });
  }
  if (stage === 'generation') {
    const held =
      deferred<Awaited<ReturnType<PortalDelegationCardPort['generation']>>>();
    jest.spyOn(h.port, stage).mockReturnValueOnce(held.promise);
    return () =>
      held.resolve({
        entry: {
          chatId: 'chat',
          delegationId: 'd',
          runGeneration: 1,
          version: 1,
          kind: 'generation',
          createdAt: 10,
          store: 'stream',
          executionMode: 'background',
          origin: { kind: 'launch' },
        },
        stream: null,
        result: null,
      });
  }
  const held = deferred<PersistedChatMessage | undefined>();
  jest.spyOn(h.port, stage).mockReturnValueOnce(held.promise);
  return () => held.resolve(row());
}
function payload(
  event: PortalEventEnvelope | undefined,
): Record<string, unknown> {
  return event?.payload as Record<string, unknown>;
}

describe('committed Portal delegation card events', () => {
  it('projects only the matching part under the exact anchor, retaining row metadata and hint; duplicate/regressing tokens do nothing', async () => {
    const h = setup();
    h.publish([change()]);
    await settle();
    expect(h.emitted).toHaveLength(1);
    expect(payload(h.emitted[0])).toMatchObject({
      scope: 'worktree',
      workspaceLocalId: 'owner',
      worktreeLocalId: 'worktree',
      chatId: 'chat',
      message: {
        messageId: 'delegated-agent-d',
        role: 'assistant',
        status: 'complete',
        createdAtMs: 10,
        parts: [
          {
            kind: 'agent',
            data: {
              delegation: {
                delegationId: 'd',
                runGeneration: 1,
                sequence: 1,
                streamRevision: 7,
              },
            },
          },
        ],
      },
    });
    expect(
      (payload(h.emitted[0]).message as { parts: unknown[] }).parts,
    ).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(h.emitted[0]))).toBeLessThanOrEqual(
      256 * 1024,
    );
    h.publish([change()], 10);
    h.publish([change('d', 1, 0, 6)], 9);
    await settle();
    expect(h.emitted).toHaveLength(1);
  });
  it.each(['resolveOwner', 'generation', 'readStoredParentMessage'] as const)(
    'dispose and sink invalidation fence held %s work',
    async (method) => {
      for (const dispose of [true, false]) {
        const h = setup();
        const release = holdStage(h, method);
        h.publish([change()]);
        await settle();
        expect(h.port[method]).toHaveBeenCalledTimes(1);
        if (dispose) h.adapter.dispose();
        else h.invalidate();
        release();
        await settle();
        expect(h.emitted).toEqual([]);
        expect(h.adapter.stats().active).toBe(0);
      }
    },
  );
  it('refreshes for a stream advance that keeps the card revision, such as settled rows', async () => {
    const h = setup();
    h.publish([change('d', 1, 1, 7)], 5);
    await settle();
    h.publish([change('d', 1, 1, 8)], 6);
    await settle();
    expect(h.emitted).toHaveLength(2);
    expect(payload(h.emitted[1])).toMatchObject({
      message: {
        parts: [{ data: { delegation: { streamRevision: 8 } } }],
      },
    });
  });
  it('a newer generation overtakes held work and rejects a delayed old generation', async () => {
    const h = setup();
    const held = deferred<PersistedChatMessage | undefined>();
    jest
      .spyOn(h.port, 'readStoredParentMessage')
      .mockReturnValueOnce(held.promise)
      .mockResolvedValue(row('d', 2));
    h.publish([change()]);
    await settle();
    h.publish([change('d', 2, 1, 2)], 11);
    await settle();
    held.resolve(row());
    await settle();
    h.publish([change('d', 1, 99, 99)], 12);
    await settle();
    expect(h.emitted).toHaveLength(1);
    expect(payload(h.emitted[0])).toMatchObject({
      message: { messageId: 'delegated-agent-d-run-2' },
    });
  });
  it.each(['resolveOwner', 'generation', 'readStoredParentMessage'] as const)(
    'a newer run fences the old valid result held at %s',
    async (method) => {
      const h = setup();
      const release = holdStage(h, method);
      if (method === 'readStoredParentMessage')
        jest
          .mocked(h.port.readStoredParentMessage)
          .mockResolvedValue(row('d', 2));
      else
        jest
          .spyOn(h.port, 'readStoredParentMessage')
          .mockResolvedValue(row('d', 2));
      h.publish([change()]);
      await settle();
      expect(h.port[method]).toHaveBeenCalledTimes(1);
      h.publish([change('d', 2, 1, 2)], 11);
      await settle();
      release();
      await settle();
      h.publish([change('d', 1, 99, 99)], 12);
      await settle();
      expect(h.emitted).toHaveLength(1);
      expect(payload(h.emitted[0])).toMatchObject({
        message: { messageId: 'delegated-agent-d-run-2' },
      });
    },
  );
  it('drops an event whose card token is already superseded in the canonical registered descriptor', async () => {
    const h = setup();
    jest.spyOn(h.port, 'generation').mockResolvedValue({
      entry: {
        chatId: 'chat',
        delegationId: 'd',
        runGeneration: 1,
        version: 1,
        kind: 'generation',
        createdAt: 10,
        store: 'stream',
        executionMode: 'background',
        origin: { kind: 'launch' },
      },
      stream: {
        target: {
          kind: 'delegation',
          chatId: 'chat',
          delegationId: 'd',
          runGeneration: 1,
        },
        status: 'open',
        streamRevision: 8,
        openedAt: 10,
        latestRowTimestamp: null,
        contentRevision: null,
        cardState: {
          version: 2,
          cardRevision: 2,
          requestedModelId: 'model',
          status: 'pending',
          outputTruncated: false,
        },
      },
      result: null,
    });
    h.publish([change()]);
    await settle();
    expect(h.emitted).toEqual([]);
    expect(h.port.readStoredParentMessage).not.toHaveBeenCalled();
  });
  it('coalesces a newer card token while a read is held', async () => {
    const h = setup();
    const held = deferred<PersistedChatMessage | undefined>();
    jest
      .spyOn(h.port, 'readStoredParentMessage')
      .mockReturnValueOnce(held.promise);
    h.publish([change()]);
    await settle();
    h.publish([change('d', 1, 2, 8)], 11);
    held.resolve(row());
    await settle();
    expect(h.emitted).toHaveLength(1);
    expect(payload(h.emitted[0])).toMatchObject({
      message: { parts: [{ data: { delegation: { streamRevision: 8 } } }] },
    });
  });
  it('keeps a missing anchor and wakes exactly once on its committed admission, not unrelated rows', async () => {
    const h = setup();
    jest
      .spyOn(h.port, 'readStoredParentMessage')
      .mockResolvedValueOnce(undefined);
    h.publish([change()]);
    await settle();
    expect(h.adapter.stats().pending).toBe(1);
    h.publish(
      [
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: { ...row(), id: 'wrong' },
        },
      ],
      11,
    );
    await settle();
    expect(h.port.readStoredParentMessage).toHaveBeenCalledTimes(1);
    h.publish(
      [{ type: 'message.upserted', chatId: 'chat', message: row() }],
      12,
    );
    await settle();
    expect(h.emitted).toHaveLength(1);
    expect(h.adapter.stats().pending).toBe(0);
  });
  it('bounds pending targets at 64 and active lookups at two, counting oldest overflow', async () => {
    const h = setup();
    const held = deferred<PersistedChatMessage | undefined>();
    jest.spyOn(h.port, 'readStoredParentMessage').mockReturnValue(held.promise);
    for (let i = 0; i < 70; i++) h.publish([change(`d${i}`)], i + 1);
    await settle();
    expect(h.adapter.stats()).toMatchObject({
      pending: 64,
      active: 2,
      dropped: 6,
    });
    expect(h.port.readStoredParentMessage).toHaveBeenCalledTimes(2);
    h.adapter.dispose();
    held.resolve(undefined);
    await settle();
  });
  it('the synchronous listener never waits for anchor I/O to acknowledge a commit', async () => {
    const h = setup();
    const held = deferred<PersistedChatMessage | undefined>();
    jest.spyOn(h.port, 'readStoredParentMessage').mockReturnValue(held.promise);
    let acknowledged = false;
    h.publish([change()]);
    acknowledged = true;
    await settle();
    expect(acknowledged).toBe(true);
    expect(h.port.readStoredParentMessage).toHaveBeenCalledTimes(1);
    expect(h.emitted).toEqual([]);
    h.adapter.dispose();
    held.resolve(undefined);
    await settle();
  });
  it('uses a registered custom anchor, leaves the stored row untouched, and projects standalone ownership', async () => {
    const h = setup();
    const stored = {
      ...row(),
      id: 'registered-anchor',
      role: 'system' as const,
    };
    const before = JSON.stringify(stored);
    jest.spyOn(h.port, 'resolveOwner').mockResolvedValue({
      scope: { projectId: 'canonical', worktreeId: 'entry' },
      source: {
        scope: 'standalone',
        projectLocalId: 'canonical',
        projectId: 'canonical',
        workEntryId: 'entry',
      },
    });
    jest.spyOn(h.port, 'generation').mockResolvedValue({
      entry: {
        chatId: 'chat',
        delegationId: 'd',
        runGeneration: 1,
        version: 1,
        kind: 'generation',
        createdAt: 10,
        store: 'stream',
        executionMode: 'background',
        origin: { kind: 'launch', anchorMessageId: 'registered-anchor' },
      },
      stream: null,
      result: null,
    });
    jest.spyOn(h.port, 'readStoredParentMessage').mockResolvedValue(stored);
    h.publish([change()]);
    await settle();
    expect(h.port.readStoredParentMessage).toHaveBeenCalledWith(
      { projectId: 'canonical', worktreeId: 'entry' },
      'chat',
      'registered-anchor',
    );
    expect(payload(h.emitted[0])).toMatchObject({
      scope: 'standalone',
      projectLocalId: 'canonical',
      workEntryId: 'entry',
      message: {
        messageId: 'registered-anchor',
        role: 'system',
        status: 'complete',
        createdAtMs: 10,
        text: 'unrelated',
      },
    });
    expect(JSON.stringify(stored)).toBe(before);
  });
  it('retains an exact-anchor wake received while the absent read is held', async () => {
    const h = setup();
    const held = deferred<PersistedChatMessage | undefined>();
    jest
      .spyOn(h.port, 'readStoredParentMessage')
      .mockReturnValueOnce(held.promise);
    h.publish([change()]);
    await settle();
    h.publish(
      [{ type: 'message.upserted', chatId: 'chat', message: row() }],
      11,
    );
    held.resolve(undefined);
    await settle();
    expect(h.emitted).toHaveLength(1);
    expect(h.port.readStoredParentMessage).toHaveBeenCalledTimes(2);
  });
  it.each(['message.removed', 'messages.replaced', 'tab.removed'] as const)(
    'drops held targets on %s without a late enqueue',
    async (type) => {
      const h = setup();
      const held = deferred<PersistedChatMessage | undefined>();
      jest
        .spyOn(h.port, 'readStoredParentMessage')
        .mockReturnValueOnce(held.promise);
      h.publish([change()]);
      await settle();
      h.publish(
        [
          type === 'tab.removed'
            ? { type, tabId: 'chat' }
            : type === 'message.removed'
              ? { type, chatId: 'chat', messageId: 'delegated-agent-d' }
              : {
                  type,
                  chatId: 'chat',
                  messages: [],
                  removedMessageIds: ['delegated-agent-d'],
                },
        ],
        11,
      );
      held.resolve(row());
      await settle();
      expect(h.emitted).toEqual([]);
      expect(h.adapter.stats().pending).toBe(0);
    },
  );
  it('replacement admission wakes a missing anchor without another card event', async () => {
    const h = setup();
    jest
      .spyOn(h.port, 'readStoredParentMessage')
      .mockResolvedValueOnce(undefined);
    h.publish([change()]);
    await settle();
    h.publish(
      [
        {
          type: 'messages.replaced',
          chatId: 'chat',
          messages: [row()],
          removedMessageIds: [],
        },
      ],
      11,
    );
    await settle();
    expect(h.emitted).toHaveLength(1);
  });
  it('applies the final envelope cap and counts a drop even after bounded card projection', async () => {
    const h = setup();
    jest.spyOn(h.port, 'resolveOwner').mockResolvedValue({
      scope: { projectId: 'owner', worktreeId: 'worktree' },
      source: {
        scope: 'worktree',
        workspaceLocalId: 'x'.repeat(300000),
        worktreeLocalId: 'worktree',
      },
    });
    h.publish([change()]);
    await settle();
    expect(h.emitted).toEqual([]);
    expect(h.adapter.stats().dropped).toBe(1);
  });
  it('bounds retired-generation tombstones and clears them on dispose', async () => {
    const h = setup();
    jest
      .spyOn(h.port, 'readStoredParentMessage')
      .mockImplementation((_scope, _chat, messageId) => {
        const id = messageId.slice('delegated-agent-'.length);
        return Promise.resolve(row(id));
      });
    for (let i = 0; i < 300; i++) {
      h.publish([change(`retired${i}`)], i + 1);
      await settle();
    }
    expect(h.emitted).toHaveLength(300);
    expect(h.adapter.stats().retired).toBe(256);
    h.adapter.dispose();
    expect(h.adapter.stats()).toMatchObject({
      pending: 0,
      active: 0,
      retired: 0,
    });
  });
  it('isolates a failed anchor read from publication and retries on admission', async () => {
    const h = setup();
    jest
      .spyOn(h.port, 'readStoredParentMessage')
      .mockRejectedValueOnce(new Error('unavailable'));
    expect(() => h.publish([change()])).not.toThrow();
    await settle();
    expect(h.adapter.stats().pending).toBe(1);
    h.publish(
      [{ type: 'message.upserted', chatId: 'chat', message: row() }],
      11,
    );
    await settle();
    expect(h.emitted).toHaveLength(1);
  });
  it('drops an anchor row without the matching stream-backed card', async () => {
    const h = setup();
    jest
      .spyOn(h.port, 'readStoredParentMessage')
      .mockResolvedValue({ ...row(), blocks: [card('wrong')] });
    h.publish([change()]);
    await settle();
    expect(h.emitted).toEqual([]);
    expect(h.adapter.stats().pending).toBe(0);
  });
});

it('a real repository card commit acknowledges while the subscribed adapter holds its anchor lookup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'portal-card-commit-'));
  const fixture = await createRepositoryTranscriptPortFixture(root)();
  const held = deferred<PersistedChatMessage | undefined>();
  const started = deferred<void>();
  let acknowledged = false;
  let commit: Promise<unknown> | undefined;
  const adapter = subscribePortalDelegationCardEvents(
    {
      subscribe: (listener) => fixture.service.subscribe(listener),
      generation: (scope, target) => fixture.service.generation(scope, target),
      readStoredParentMessage: () => {
        started.resolve();
        return held.promise;
      },
      resolveOwner: (scope) =>
        Promise.resolve({
          scope,
          source: {
            scope: 'worktree',
            workspaceLocalId: scope.projectId,
            worktreeLocalId: scope.worktreeId,
          },
        }),
    },
    () => undefined,
    () => true,
  );
  try {
    const target = fixture.ownedTarget('chat', 'd', 1);
    const opened = await fixture.port.open({ target });
    expect(opened.ok).toBe(true);
    const registered = await fixture.port.registerGeneration({
      chatId: 'chat',
      delegationId: 'd',
      runGeneration: 1,
      createdAt: 10,
      store: 'stream',
      origin: { kind: 'launch', anchorMessageId: 'delegated-agent-d' },
      executionMode: 'background',
    });
    expect(registered.ok).toBe(true);
    commit = fixture.port
      .updateCardState({
        target,
        cardRevision: 1,
        cardDraft: {
          version: 2,
          requestedModelId: 'model',
          status: 'pending',
          outputTruncated: false,
        },
      })
      .then((result) => {
        acknowledged = true;
        return result;
      });
    await started.promise;
    await settle();
    expect(acknowledged).toBe(true);
    expect(adapter.stats().active).toBe(1);
  } finally {
    adapter.dispose();
    held.resolve(undefined);
    await commit;
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120000);
