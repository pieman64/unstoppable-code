import {
  initialChatTurnState,
  reduceChatTurn,
  reduceChatTurnHostEvent,
  serializeChatTurnState,
} from '@canopy/agent-transcript/turn';
import type { PersistedChatTurnState } from '@canopy/agent-transcript/turn';
import type { ChatTurnLifecycleEvent } from '@canopy/protocol/canopy-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PersistedPendingQuestion } from '@canopy/desktop-shared/types';
import { ChatStateService } from '../chat-state-service';
import { ChatTurnStateHandoff } from '../chat-turn-state-handoff';
import { ChatStateV2Repository } from '../chat-state-v2-repository';
import { getChatQueueService } from '../chat-queue-service';
import { projectPersistedChatTranscript } from '@canopy/desktop-shared/portal/persisted-chat-projection';
import { indexTurn } from '../../lib/chat-transcript-turn-index';
import {
  setChatTabsRequiredDurabilityObserver,
  setChatTabsWriteObserver,
} from '../../lib/chat-tabs';
import { createChatTabsAuxiliaryProjectionObserver } from '../../lib/chat-tabs-auxiliary-projection';

const SCOPE = {
  projectId: 'turn-restart-project',
  worktreeId: 'turn-restart-worktree',
};
const CHAT_ID = 'turn-restart-chat';
const mockRequestBackgroundSnapshot = jest.fn();

jest.mock('../../agents/claude-turn-lifecycle', () => ({
  requestBackgroundSnapshot: (...args: unknown[]): void => {
    mockRequestBackgroundSnapshot(...args);
  },
}));

function turnStartedEvent(
  sequence: number,
  turnId = 'turn-restart-id',
  phase: 'start' | 'binding-update' = 'start',
  userMessageIds: string[] = ['turn-restart-message'],
): ChatTurnLifecycleEvent {
  return {
    version: 1,
    provider: 'claude',
    ...SCOPE,
    chatId: CHAT_ID,
    sequence,
    eventId: `turn-restart-started-${sequence}`,
    observedAtMs: 1_000 + sequence,
    type: 'TurnStarted',
    turnId,
    origin: 'user',
    binding: 'bound',
    submissionIds: [],
    userMessageIds,
    providerUserMessageUuids: [],
    phase,
    startedAtMs: 1_000,
  };
}

function turnEndedEvent(sequence: number): ChatTurnLifecycleEvent {
  return {
    version: 1,
    provider: 'claude',
    ...SCOPE,
    chatId: CHAT_ID,
    sequence,
    eventId: `turn-restart-ended-${sequence}`,
    observedAtMs: 1_500,
    type: 'TurnEnded',
    turnId: 'turn-restart-id',
    origin: 'user',
    binding: 'bound',
    submissionIds: [],
    userMessageIds: ['turn-restart-message'],
    providerUserMessageUuids: [],
    endedAtMs: 1_500,
    outcome: 'completed',
    source: 'result',
  };
}

function pendingQuestion(
  requestId: string,
  extra: Partial<PersistedPendingQuestion> = {},
): PersistedPendingQuestion {
  return {
    requestId,
    chatId: CHAT_ID,
    questions: [{ question: 'Continue?', options: ['yes', 'no'] }],
    ...extra,
  };
}

describe('chat state turn durability', () => {
  let directory: string;
  let repository: ChatStateV2Repository;
  let service: ChatStateService;

  beforeEach(() => {
    jest.useRealTimers();
    mockRequestBackgroundSnapshot.mockReset();
    directory = mkdtempSync(join(tmpdir(), 'canopy-chat-turn-durability-'));
    repository = new ChatStateV2Repository({
      resolvePaths: (): {
        tabs: string;
        archives: string;
        journal: string;
      } => ({
        tabs: join(directory, 'chats.json'),
        archives: join(directory, 'archives.json'),
        journal: join(directory, 'journal.jsonl'),
      }),
    });
    service = new ChatStateService({
      repository,
      inputSession: (): Promise<undefined> => Promise.resolve(undefined),
      now: (): number => 2_000,
      recordDiagnostic: (): void => undefined,
    });
    // Exercise the startup recovery path while keeping the repository itself
    // real, as production does when loading persisted host runtime.
    Object.defineProperty(service, 'reconcileHostRuntime', { value: true });
    getChatQueueService().resetForTests();
  });

  afterEach(async () => {
    setChatTabsWriteObserver(null);
    setChatTabsRequiredDurabilityObserver(null);
    jest.useRealTimers();
    getChatQueueService().resetForTests();
    await repository.drainAll();
    rmSync(directory, { recursive: true, force: true });
  });

  async function createChat(): Promise<void> {
    await service.command({
      schemaVersion: 1,
      commandId: 'create-turn-restart-chat',
      ...SCOPE,
      command: {
        type: 'chat.create_tab',
        tabId: CHAT_ID,
        title: 'Persisted paused turn',
        providerType: 'claude',
        model: 'claude-opus-4-6',
      },
    });
  }

  it('publishes durable provider output while an auxiliary observer is held', async () => {
    await createChat();
    service.observeTurnLifecycle(turnStartedEvent(1));
    await waitForHandoffReduction();

    let observerEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      observerEntered = resolve;
    });
    let releaseObserver: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      releaseObserver = resolve;
    });
    setChatTabsWriteObserver(async () => {
      observerEntered?.();
      await held;
    });
    const published: number[] = [];
    const unsubscribe = service.subscribe((event) => {
      published.push(event.revision);
    });
    let ingestionSettled = false;
    const ingestion = service
      .ingestProviderEvent({
        ...SCOPE,
        chatId: CHAT_ID,
        mutationId: 'held-summary-output',
        data: {
          type: 'assistant',
          message: {
            id: 'held-summary-message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Durable but invisible' }],
          },
        },
      })
      .then((value) => {
        ingestionSettled = true;
        return value;
      });

    try {
      await entered;
      const state = await repository.getState(SCOPE, {
        chatIds: [CHAT_ID],
        fullTranscript: true,
      });
      expect(
        state.tabsFile.tabs[0]?.messages.some((message) =>
          message.blocks.some(
            (block) =>
              block.type === 'text' && block.text === 'Durable but invisible',
          ),
        ),
      ).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(published).toContain(state.tabsFile.revision ?? 0);
      expect(ingestionSettled).toBe(true);
      await expect(
        service.command({
          schemaVersion: 1,
          commandId: 'create-another-chat-while-summary-held',
          ...SCOPE,
          command: {
            type: 'chat.create_tab',
            tabId: 'another-chat',
            title: 'Another chat',
          },
        }),
      ).resolves.toMatchObject({ outcome: 'applied' });
    } finally {
      releaseObserver?.();
      await ingestion;
      unsubscribe();
    }
  });

  it('holds publication and ingestion until the required activity watermark settles', async () => {
    await createChat();
    service.observeTurnLifecycle(turnStartedEvent(1));
    await waitForHandoffReduction();
    let observerEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      observerEntered = resolve;
    });
    let releaseObserver: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      releaseObserver = resolve;
    });
    setChatTabsRequiredDurabilityObserver(async () => {
      observerEntered?.();
      await held;
    });
    const published: number[] = [];
    const unsubscribe = service.subscribe((event) => {
      published.push(event.revision);
    });
    let ingestionSettled = false;
    const ingestion = service
      .ingestProviderEvent({
        ...SCOPE,
        chatId: CHAT_ID,
        mutationId: 'held-watermark-output',
        data: {
          type: 'assistant',
          message: {
            id: 'held-watermark-message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Durable before activity' }],
          },
        },
      })
      .then((value) => {
        ingestionSettled = true;
        return value;
      });
    try {
      await entered;
      const state = await repository.getState(SCOPE, {
        chatIds: [CHAT_ID],
        fullTranscript: true,
      });
      expect(
        state.tabsFile.tabs[0]?.messages.some((message) =>
          message.blocks.some(
            (block) =>
              block.type === 'text' && block.text === 'Durable before activity',
          ),
        ),
      ).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(published).toEqual([]);
      expect(ingestionSettled).toBe(false);
    } finally {
      releaseObserver?.();
      await ingestion;
      unsubscribe();
    }
    expect(published).toHaveLength(1);
    expect(ingestionSettled).toBe(true);
  });

  it('coalesces changes from two chats while an older projection is held', async () => {
    let projectionEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      projectionEntered = resolve;
    });
    let releaseProjection: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      releaseProjection = resolve;
    });
    let nextProjection: (() => void) | undefined;
    const projected = new Promise<void>((resolve) => {
      nextProjection = resolve;
    });
    const snapshots: Array<{
      revision: number;
      tabIds: string[];
      changed: readonly string[];
      removed: readonly string[];
    }> = [];
    setChatTabsWriteObserver(
      async (_projectId, _worktreeId, data, delta, revision) => {
        snapshots.push({
          revision,
          tabIds: data.tabs.map((tab) => tab.id),
          changed: delta?.changedTabIds ?? [],
          removed: delta?.removedTabIds ?? [],
        });
        if (snapshots.length === 1) {
          projectionEntered?.();
          await held;
        } else {
          nextProjection?.();
        }
      },
    );
    const create = (tabId: string): ReturnType<ChatStateService['command']> =>
      service.command({
        schemaVersion: 1,
        commandId: `create-${tabId}`,
        ...SCOPE,
        command: { type: 'chat.create_tab', tabId, title: tabId },
      });

    try {
      const first = create('first-chat');
      await entered;
      await first;
      await create('second-chat');
      await create('third-chat');
      expect(snapshots).toHaveLength(1);
      releaseProjection?.();
      await projected;
      expect(snapshots).toHaveLength(2);
      expect(snapshots[1]?.revision).toBe(3);
      expect(snapshots[1]?.tabIds).toEqual([
        'first-chat',
        'second-chat',
        'third-chat',
      ]);
      expect(new Set(snapshots[1]?.changed)).toEqual(
        new Set(['first-chat', 'second-chat', 'third-chat']),
      );
      expect(snapshots[1]?.removed).toEqual([]);
    } finally {
      releaseProjection?.();
    }
  });

  it('carries a skipped chat removal into the newer Portal projection', async () => {
    const create = (tabId: string): ReturnType<ChatStateService['command']> =>
      service.command({
        schemaVersion: 1,
        commandId: `create-${tabId}`,
        ...SCOPE,
        command: { type: 'chat.create_tab', tabId, title: tabId },
      });
    await create('first-chat');
    await create('second-chat');
    await new Promise<void>((resolve) => setImmediate(resolve));

    let projectionEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      projectionEntered = resolve;
    });
    let releaseProjection: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      releaseProjection = resolve;
    });
    let nextProjection: (() => void) | undefined;
    const projected = new Promise<void>((resolve) => {
      nextProjection = resolve;
    });
    let holdFirst = true;
    const delivered: Array<{
      changed: readonly string[];
      removed: readonly string[];
    }> = [];
    setChatTabsWriteObserver(
      async (_projectId, _worktreeId, _data, delta, _revision, isCurrent) => {
        if (holdFirst) {
          holdFirst = false;
          projectionEntered?.();
          await held;
        }
        if (isCurrent?.() === false) return;
        delivered.push({
          changed: delta?.changedTabIds ?? [],
          removed: delta?.removedTabIds ?? [],
        });
        nextProjection?.();
      },
    );

    try {
      await service.command({
        schemaVersion: 1,
        commandId: 'close-first-chat',
        ...SCOPE,
        command: {
          type: 'chat.close_tab',
          tabId: 'first-chat',
          mode: 'discard_empty',
        },
      });
      await entered;
      await create('third-chat');
      releaseProjection?.();
      await projected;
      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.changed).toContain('third-chat');
      expect(delivered[0]?.removed).toContain('first-chat');
    } finally {
      releaseProjection?.();
    }
  });

  it('retries a failed projection with the other chat changes retained', async () => {
    const retryTimers: Array<ReturnType<typeof setTimeout>> = [];
    service = new ChatStateService({
      repository,
      inputSession: (): Promise<undefined> => Promise.resolve(undefined),
      now: (): number => 2_000,
      recordDiagnostic: (): void => undefined,
      schedule: (callback): ReturnType<typeof setTimeout> => {
        const timer = setTimeout(callback, 10_000);
        retryTimers.push(timer);
        return timer;
      },
    });
    const snapshots: Array<{
      revision: number;
      changed: readonly string[];
    }> = [];
    let projectionAttempt = 0;
    setChatTabsWriteObserver(
      (_projectId, _worktreeId, _data, delta, revision): void => {
        snapshots.push({ revision, changed: delta?.changedTabIds ?? [] });
        projectionAttempt += 1;
        if (projectionAttempt === 1)
          throw new Error('registry temporarily busy');
      },
    );
    const create = (tabId: string): ReturnType<ChatStateService['command']> =>
      service.command({
        schemaVersion: 1,
        commandId: `create-${tabId}`,
        ...SCOPE,
        command: { type: 'chat.create_tab', tabId, title: tabId },
      });

    try {
      await create('first-chat');
      await new Promise<void>((resolve) => setImmediate(resolve));
      await create('second-chat');
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(snapshots[0]).toEqual({ revision: 1, changed: ['first-chat'] });
      expect(snapshots[1]).toEqual({
        revision: 2,
        changed: ['first-chat', 'second-chat'],
      });
    } finally {
      for (const timer of retryTimers) clearTimeout(timer);
    }
  });

  it('keeps scope projections running once per commit while a Work Entry summary keeps failing', async () => {
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const trackedTimer = (): ReturnType<typeof setTimeout> => {
      const timer = setTimeout(() => undefined, 10_000);
      timers.push(timer);
      return timer;
    };
    const projectionRetries: Array<() => void> = [];
    service = new ChatStateService({
      repository,
      inputSession: (): Promise<undefined> => Promise.resolve(undefined),
      now: (): number => 2_000,
      recordDiagnostic: (): void => undefined,
      schedule: (callback): ReturnType<typeof setTimeout> => {
        projectionRetries.push(callback);
        return trackedTimer();
      },
    });
    let registryReadable = false;
    const summaryAttempts: Array<readonly string[]> = [];
    const summaryRetries: Array<() => void> = [];
    const published: Array<readonly string[]> = [];
    let summaryNudges = 0;
    setChatTabsWriteObserver(
      createChatTabsAuxiliaryProjectionObserver({
        indexSearch: (): void => undefined,
        syncBadges: (): void => undefined,
        syncWorkEntrySummary: (
          _projectId,
          _worktreeId,
          data,
        ): Promise<void> => {
          summaryAttempts.push(data.tabs.map((tab) => tab.id));
          return registryReadable
            ? Promise.resolve()
            : Promise.reject(new Error('Work Entry registry unreadable'));
        },
        publishRuntimeStatus: (): void => undefined,
        publishScope: (_projectId, _worktreeId, _data, delta): void => {
          published.push(delta?.changedTabIds ?? []);
        },
        nudgeSummary: (): void => {
          summaryNudges += 1;
        },
        logRetry: (): void => undefined,
        schedule: (callback): ReturnType<typeof setTimeout> => {
          summaryRetries.push(callback);
          return trackedTimer();
        },
      }),
    );
    const createChat = (tabId: string): Promise<unknown> =>
      service.command({
        schemaVersion: 1,
        commandId: `create-${tabId}`,
        ...SCOPE,
        command: { type: 'chat.create_tab', tabId, title: tabId },
      });
    const settle = (): Promise<void> =>
      new Promise<void>((resolve) => setImmediate(resolve));

    try {
      await createChat('first-chat');
      await settle();
      expect(published).toEqual([['first-chat']]);
      expect(summaryRetries).toHaveLength(1);

      summaryRetries[0]?.();
      await settle();
      expect(summaryAttempts).toEqual([['first-chat'], ['first-chat']]);
      expect(summaryRetries).toHaveLength(2);

      await createChat('second-chat');
      await settle();
      expect(published).toEqual([['first-chat'], ['second-chat']]);
      expect(summaryRetries).toHaveLength(3);

      registryReadable = true;
      summaryRetries[2]?.();
      await settle();
      expect(summaryAttempts.at(-1)).toEqual(['first-chat', 'second-chat']);
      expect(summaryRetries).toHaveLength(3);
      // Only the summary retried; the projection queue never had to.
      expect(projectionRetries).toHaveLength(0);
      expect(published).toHaveLength(2);
      expect(summaryNudges).toBe(1);
    } finally {
      for (const timer of timers) clearTimeout(timer);
    }
  });

  it('retains a search projection that fails after the drain finished and folds it into the next commit', async () => {
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const trackedTimer = (): ReturnType<typeof setTimeout> => {
      const timer = setTimeout(() => undefined, 10_000);
      timers.push(timer);
      return timer;
    };
    const projectionRetries: Array<() => void> = [];
    service = new ChatStateService({
      repository,
      inputSession: (): Promise<undefined> => Promise.resolve(undefined),
      now: (): number => 2_000,
      recordDiagnostic: (): void => undefined,
      schedule: (callback): ReturnType<typeof setTimeout> => {
        projectionRetries.push(callback);
        return trackedTimer();
      },
    });
    let failFirstIndex: (error: Error) => void = () => undefined;
    const indexed: Array<{
      changed: readonly string[];
      removed: readonly string[];
    }> = [];
    const stepRetries: Array<() => void> = [];
    let runtimeStamps = 0;
    let published = 0;
    setChatTabsWriteObserver(
      createChatTabsAuxiliaryProjectionObserver({
        indexSearch: (_projectId, _worktreeId, _data, delta): Promise<void> => {
          indexed.push({
            changed: delta?.changedTabIds ?? [],
            removed: delta?.removedTabIds ?? [],
          });
          return indexed.length === 1
            ? new Promise<void>((_resolve, reject) => {
                failFirstIndex = reject;
              })
            : Promise.resolve();
        },
        syncBadges: (): void => undefined,
        syncWorkEntrySummary: (): Promise<void> => Promise.resolve(),
        publishRuntimeStatus: (): void => {
          runtimeStamps += 1;
        },
        publishScope: (): void => {
          published += 1;
        },
        nudgeSummary: (): void => undefined,
        logRetry: (): void => undefined,
        schedule: (callback): ReturnType<typeof setTimeout> => {
          stepRetries.push(callback);
          return trackedTimer();
        },
      }),
    );
    const createChat = (tabId: string): Promise<unknown> =>
      service.command({
        schemaVersion: 1,
        commandId: `create-${tabId}`,
        ...SCOPE,
        command: { type: 'chat.create_tab', tabId, title: tabId },
      });
    const settle = (): Promise<void> =>
      new Promise<void>((resolve) => setImmediate(resolve));

    try {
      await createChat('first-chat');
      await settle();
      // The drain already published and released the commit.
      expect(published).toBe(1);

      failFirstIndex(new Error('search index worker timed out'));
      await settle();
      expect(stepRetries).toHaveLength(1);

      await createChat('second-chat');
      await settle();
      expect(indexed).toEqual([
        { changed: ['first-chat'], removed: [] },
        { changed: ['second-chat', 'first-chat'], removed: [] },
      ]);
      // The superseded retry does not index again.
      stepRetries[0]?.();
      await settle();
      expect(indexed).toHaveLength(2);
      expect(projectionRetries).toHaveLength(0);
      expect(runtimeStamps).toBe(2);
      expect(published).toBe(2);
    } finally {
      for (const timer of timers) clearTimeout(timer);
    }
  });

  async function persistReducerTurn(): Promise<void> {
    const started = reduceChatTurn(initialChatTurnState(), turnStartedEvent(1));
    await repository.transact(
      SCOPE,
      [
        // The rows a canonical start commits: the prompt and its open timer.
        {
          type: 'message.upserted',
          chatId: CHAT_ID,
          message: {
            id: 'turn-restart-message',
            role: 'user',
            timestamp: 1_000,
            blocks: [{ type: 'text', text: 'Work' }],
          },
        },
        {
          type: 'message.upserted',
          chatId: CHAT_ID,
          message: {
            id: 'turn-restart-id:timer',
            role: 'system',
            timestamp: 1_000,
            blocks: [
              {
                type: 'turn_timer',
                turnId: 'turn-restart-id',
                userMessageId: 'turn-restart-message',
                startedAt: 1_000,
                completedAt: null,
              },
            ],
          },
        },
        {
          type: 'runtime.patched',
          chatId: CHAT_ID,
          runtime: {
            status: 'streaming',
            activeTurn: {
              userMessageId: 'turn-restart-message',
              startedAt: 1_000,
            },
            queuedMessageIds: [],
            turn: serializeChatTurnState(started.state),
          },
        },
      ],
      { source: 'provider', mutationId: 'persist-open-reducer-turn' },
    );
  }

  async function waitForHandoffReduction(): Promise<void> {
    const handoff: unknown = Reflect.get(service, 'turnHandoff');
    if (!(handoff instanceof ChatTurnStateHandoff)) {
      throw new Error('Chat state service did not create its turn handoff');
    }
    const snapshot = await handoff.prepare({ ...SCOPE, chatId: CHAT_ID });
    if (!snapshot) throw new Error('Expected a pending durable turn snapshot');
  }

  it('persists and reprojects tool-free restart evidence through V2 recovery and another reload', async () => {
    await createChat();
    await persistReducerTurn();
    await repository.transact(
      SCOPE,
      [
        {
          type: 'message.upserted',
          chatId: CHAT_ID,
          message: {
            id: 'partial',
            role: 'assistant',
            timestamp: 1_100,
            blocks: [{ type: 'text', text: 'Working on it' }],
          },
        },
      ],
      { source: 'provider', mutationId: 'partial-before-restart' },
    );
    const recovered = await service.getState(SCOPE);
    const original = recovered.tabsFile.tabs.find((tab) => tab.id === CHAT_ID);
    expect(original?.interruptedTurns).toEqual({ 'turn-restart-message': {} });
    await repository.drainAll();
    const reopened = new ChatStateV2Repository({
      resolvePaths: (): {
        tabs: string;
        archives: string;
        journal: string;
      } => ({
        tabs: join(directory, 'chats.json'),
        archives: join(directory, 'archives.json'),
        journal: join(directory, 'journal.jsonl'),
      }),
    });
    try {
      const restored = (await reopened.getState(SCOPE)).tabsFile.tabs.find(
        (tab) => tab.id === CHAT_ID,
      );
      if (!restored) throw new Error('Missing restored chat');
      expect(restored.interruptedTurns).toEqual(original?.interruptedTurns);
      const { messages } = await reopened.page(SCOPE, CHAT_ID);
      const projected = projectPersistedChatTranscript({
        scope: 'worktree',
        chatId: CHAT_ID,
        messages,
        interruptedTurns: restored.interruptedTurns,
        turnEnds: restored.turnEnds,
        unacceptedTurnEnds: restored.unacceptedTurnEnds,
      });
      expect(
        projected.find((row) =>
          row.parts?.some((part) => part.kind === 'turn_timer'),
        )?.parts?.[0],
      ).toHaveProperty('data.endReason', 'interrupted');
      expect(indexTurn(messages, 0).outcomes).toEqual({
        blocked: 0,
        failed: 0,
        interrupted: 0,
      });
    } finally {
      await reopened.drainAll();
    }
  });

  it('settles an idle liveness-free runtime with a reducer-only open paused turn on restart', async () => {
    await createChat();

    const started = reduceChatTurn(initialChatTurnState(), turnStartedEvent(1));
    const paused = reduceChatTurnHostEvent(started.state, {
      type: 'PauseOpened',
      turnId: 'turn-restart-id',
      ownerKind: 'question',
      ownerId: 'turn-restart-question',
      atMs: 1_100,
      hostSequence: 1,
    });
    // The legacy runtime is idle with no activeTurn, but the serialized
    // reducer phase stays foreground to preserve its valid open-current shape.
    const serializedTurn = serializeChatTurnState(paused.state);

    await repository.transact(
      SCOPE,
      [
        {
          type: 'runtime.patched',
          chatId: CHAT_ID,
          runtime: {
            status: 'idle',
            queuedMessageIds: [],
            turn: serializedTurn,
          },
        },
      ],
      { source: 'provider', mutationId: 'persist-reducer-only-turn' },
    );

    const recovered = await service.getState(SCOPE);
    const recoveredTurn = recovered.runtimeByChatId[CHAT_ID]?.turn;

    expect(recoveredTurn?.current).toBeUndefined();
    expect(recoveredTurn?.lastEnded).toMatchObject({
      id: 'turn-restart-id',
      outcome: 'cancelled',
      terminalReason: 'restart',
    });
    expect(recoveredTurn?.lastEnded?.pauses).toEqual([
      expect.objectContaining({
        ownerKind: 'question',
        ownerId: 'turn-restart-question',
        startedAtMs: 1_100,
        // Preserve the historical pause boundary instead of relaunch time.
        endedAtMs: 1_100,
      }),
    ]);
  });

  it('publishes the durable restart settlement and discards a stale fallback turn snapshot', async () => {
    jest.useFakeTimers();
    await createChat();
    await persistReducerTurn();
    const changes: Array<{
      cause: string;
      generation: number;
      state: PersistedChatTurnState;
    }> = [];
    const statesReadDuringRestart: Array<PersistedChatTurnState | undefined> =
      [];
    service.onTurnStateChange((change) => {
      changes.push(change);
      if (change.cause === 'restart')
        statesReadDuringRestart.push(service.getTurnState(change.scope));
    });

    service.observeTurnLifecycle(
      turnStartedEvent(2, 'turn-restart-id', 'binding-update', [
        'turn-restart-message',
        'turn-restart-follow-up',
      ]),
    );
    await waitForHandoffReduction();
    expect(
      service.getTurnState({ ...SCOPE, chatId: CHAT_ID })?.current?.inputIds,
    ).toEqual(['turn-restart-message', 'turn-restart-follow-up']);

    const recovered = await service.getState(SCOPE);
    const recoveredTurn = recovered.runtimeByChatId[CHAT_ID]?.turn;
    expect(recoveredTurn?.current).toBeUndefined();
    expect(recoveredTurn?.lastEnded).toMatchObject({
      id: 'turn-restart-id',
      inputIds: ['turn-restart-message'],
      outcome: 'cancelled',
      terminalReason: 'restart',
    });
    expect(changes.map((change) => change.cause)).toContain('restart');
    expect(statesReadDuringRestart).toEqual([recoveredTurn]);

    // The fallback registered by the stale binding update must not write its
    // still-open snapshot over the already-committed restart settlement.
    await jest.advanceTimersByTimeAsync(2_000);
    const durableTurn = (await repository.getState(SCOPE)).runtimeByChatId[
      CHAT_ID
    ]?.turn;
    expect(durableTurn?.current).toBeUndefined();
    expect(durableTurn?.lastEnded).toMatchObject({
      id: 'turn-restart-id',
      outcome: 'cancelled',
      terminalReason: 'restart',
    });
  });

  it('coalesces lifecycle observations into a delayed durable runtime turn without cursors', async () => {
    jest.useFakeTimers();
    await createChat();
    const revision = await repository.getRevision(SCOPE);
    const pendingFallbackCommits: Promise<unknown>[] = [];
    const transactWith = repository.transactWith.bind(repository);
    jest
      .spyOn(repository, 'transactWith')
      .mockImplementation((scope, build, options) => {
        const commit = transactWith(scope, build, options);
        if (options.source === 'automation')
          pendingFallbackCommits.push(commit);
        return commit;
      });

    service.observeTurnLifecycle(turnStartedEvent(1));
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    await waitForHandoffReduction();
    expect(jest.getTimerCount()).toBeGreaterThan(0);

    // Lifecycle traffic itself does not create a repository transaction.
    await expect(repository.getRevision(SCOPE)).resolves.toBe(revision);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(pendingFallbackCommits).toHaveLength(1);
    await Promise.all(pendingFallbackCommits);

    const runtime = (await repository.getState(SCOPE)).runtimeByChatId[CHAT_ID];
    expect(runtime?.turn?.current).toMatchObject({
      id: 'turn-restart-id',
      userMessageId: 'turn-restart-message',
    });
    expect(runtime?.turn).not.toHaveProperty('cursors');
  });

  it('retains an event that arrives while the coalesced fallback commit is in flight', async () => {
    jest.useFakeTimers();
    await createChat();
    const transactWith = repository.transactWith.bind(repository);
    const pendingFallbackCommits: Promise<unknown>[] = [];
    let observedEnd = false;
    jest
      .spyOn(repository, 'transactWith')
      .mockImplementation((scope, build, options) => {
        const commit = transactWith(
          scope,
          async (current, revision, context) => {
            const mutations = await build(current, revision, context);
            if (!observedEnd) {
              observedEnd = true;
              service.observeTurnLifecycle(turnEndedEvent(2));
            }
            return mutations;
          },
          options,
        );
        if (options.source === 'automation')
          pendingFallbackCommits.push(commit);
        return commit;
      });

    service.observeTurnLifecycle(turnStartedEvent(1));
    await waitForHandoffReduction();
    await jest.advanceTimersByTimeAsync(2_000);
    await Promise.all(pendingFallbackCommits);
    await jest.advanceTimersByTimeAsync(2_000);
    await Promise.all(pendingFallbackCommits);

    const turn = (await repository.getState(SCOPE)).runtimeByChatId[CHAT_ID]
      ?.turn;
    expect(turn?.current).toBeUndefined();
    expect(turn?.lastEnded).toMatchObject({
      id: 'turn-restart-id',
      outcome: 'completed',
    });
  });

  it('opens and closes a synchronous question pause in the question transactions', async () => {
    await createChat();
    await persistReducerTurn();

    const question = pendingQuestion('sync-question');
    await service.upsertPendingQuestion(SCOPE, question);

    let turn = (await repository.getState(SCOPE)).runtimeByChatId[CHAT_ID]
      ?.turn;
    expect(turn?.current?.pauses).toEqual([
      expect.objectContaining({
        ownerKind: 'question',
        ownerId: 'sync-question',
      }),
    ]);

    await service.consumePendingQuestion(SCOPE, CHAT_ID, question.requestId);
    turn = (await repository.getState(SCOPE)).runtimeByChatId[CHAT_ID]?.turn;
    expect(turn?.current?.pauses).toEqual([
      expect.objectContaining({
        ownerKind: 'question',
        ownerId: 'sync-question',
        endedAtMs: 2_000,
      }),
    ]);
  });

  it('keeps queued ids and the active turn when a question pauses the turn', async () => {
    await createChat();
    await persistReducerTurn();
    const runtime = (await repository.getState(SCOPE)).runtimeByChatId[CHAT_ID];
    if (!runtime) throw new Error('Expected a persisted runtime');
    await repository.transact(
      SCOPE,
      [
        {
          type: 'runtime.patched',
          chatId: CHAT_ID,
          runtime: { ...runtime, queuedMessageIds: ['queued-message'] },
        },
      ],
      { source: 'provider', mutationId: 'queue-behind-the-turn' },
    );

    await service.upsertPendingQuestion(SCOPE, pendingQuestion('ask-user'));

    const after = (await repository.getState(SCOPE)).runtimeByChatId[CHAT_ID];
    expect(after).toMatchObject({
      status: 'awaiting_input',
      queuedMessageIds: ['queued-message'],
      activeTurn: { userMessageId: 'turn-restart-message' },
    });
  });

  // Questions carry no trackChatTurn flag; only async delivery leaves a turn running.
  it('does not pause a turn for asynchronous questions', async () => {
    await createChat();
    await persistReducerTurn();

    await service.upsertPendingQuestion(
      SCOPE,
      pendingQuestion('async-question', { delivery: 'async' }),
    );

    expect(
      (await repository.getState(SCOPE)).runtimeByChatId[CHAT_ID]?.turn?.current
        ?.pauses,
    ).toEqual([]);
  });

  it('closes a remembered question pause even after its persisted question row is gone', async () => {
    await createChat();
    await persistReducerTurn();
    await service.upsertPendingQuestion(
      SCOPE,
      pendingQuestion('removed-question'),
    );
    await repository.transact(
      SCOPE,
      [
        {
          type: 'pending_question.removed',
          chatId: CHAT_ID,
          requestId: 'removed-question',
        },
      ],
      { source: 'provider', mutationId: 'remove-question-before-consume' },
    );

    await service.consumePendingQuestion(SCOPE, CHAT_ID, 'removed-question');

    expect(
      (await repository.getState(SCOPE)).runtimeByChatId[CHAT_ID]?.turn?.current
        ?.pauses,
    ).toEqual([
      expect.objectContaining({
        ownerKind: 'question',
        ownerId: 'removed-question',
        endedAtMs: 2_000,
      }),
    ]);
  });

  async function persistBackgroundTurn(): Promise<void> {
    const turnWithBackground = {
      ...initialChatTurnState(),
      phase: 'background' as const,
      background: {
        native: [{ id: 'persisted-background-task' }],
        managed: { live: 0, queued: 0 },
      },
    };
    await repository.transact(
      SCOPE,
      [
        {
          type: 'runtime.patched',
          chatId: CHAT_ID,
          runtime: {
            status: 'idle',
            queuedMessageIds: [],
            turn: serializeChatTurnState(turnWithBackground),
          },
        },
      ],
      { source: 'provider', mutationId: 'persist-background-turn' },
    );
  }

  it('requests an Ollama chat snapshot through its execution harness', async () => {
    await service.command({
      schemaVersion: 1,
      commandId: 'create-turn-restart-ollama-chat',
      ...SCOPE,
      command: {
        type: 'chat.create_tab',
        tabId: CHAT_ID,
        title: 'Ollama chat with background work',
        providerType: 'ollama',
        model: 'qwen3:8b',
      },
    });
    // The chat runs its Ollama model on Codex, as a model-change command
    // records it.
    const created = (await repository.getState(SCOPE)).tabsFile.tabs.find(
      (tab) => tab.id === CHAT_ID,
    );
    if (!created || created.kind === 'file')
      throw new Error('Expected the Ollama chat tab');
    await repository.transact(
      SCOPE,
      [{ type: 'tab.created', tab: { ...created, executionHarness: 'codex' } }],
      { source: 'provider', mutationId: 'choose-ollama-harness' },
    );
    await persistBackgroundTurn();

    await service.getState(SCOPE);
    await Promise.resolve();

    expect(mockRequestBackgroundSnapshot).toHaveBeenCalledWith({
      provider: 'codex',
      ...SCOPE,
      chatId: CHAT_ID,
    });
  });

  it('requests a fresh background snapshot even when the shadow is disabled', async () => {
    await createChat();
    const turnWithBackground = {
      ...initialChatTurnState(),
      phase: 'background' as const,
      background: {
        native: [{ id: 'persisted-background-task' }],
        managed: { live: 0, queued: 0 },
      },
    };
    await repository.transact(
      SCOPE,
      [
        {
          type: 'runtime.patched',
          chatId: CHAT_ID,
          runtime: {
            status: 'idle',
            queuedMessageIds: [],
            turn: serializeChatTurnState(turnWithBackground),
          },
        },
      ],
      { source: 'provider', mutationId: 'persist-background-turn' },
    );

    await service.getState(SCOPE);
    await Promise.resolve();

    expect(mockRequestBackgroundSnapshot).toHaveBeenCalledWith({
      provider: 'claude',
      ...SCOPE,
      chatId: CHAT_ID,
    });
  });

  it('retains a failed fallback lifecycle generation for the next provider transaction', async () => {
    jest.useFakeTimers();
    await createChat();
    const committedTurns: PersistedChatTurnState[] = [];
    service.onTurnStateCommitted((commit) => {
      committedTurns.push(commit.state);
    });
    const transactWith = repository.transactWith.bind(repository);
    jest
      .spyOn(repository, 'transactWith')
      .mockImplementation(async (...args) => {
        if (args[2].source === 'automation') {
          throw new Error('simulated fallback write failure');
        }
        return transactWith(...args);
      });

    service.observeTurnLifecycle(turnStartedEvent(1));
    await jest.advanceTimersByTimeAsync(2_000);
    expect(committedTurns).toEqual([]);

    await service.ingestProviderEvent({
      ...SCOPE,
      chatId: CHAT_ID,
      mutationId: 'provider-event-after-fallback-failure',
      data: {
        type: 'assistant',
        message: {
          id: 'provider-message-after-fallback-failure',
          role: 'assistant',
          content: [{ type: 'text', text: 'Committed after retry' }],
        },
      },
    });

    expect(committedTurns).toHaveLength(1);
    expect(committedTurns[0]?.current).toMatchObject({
      id: 'turn-restart-id',
      inputIds: ['turn-restart-message'],
    });
    expect(
      (await repository.getState(SCOPE)).runtimeByChatId[CHAT_ID]?.turn
        ?.current,
    ).toMatchObject({ id: 'turn-restart-id' });
  });

  it('exposes a nonthrowing host pause observer that can infer the current turn id', async () => {
    jest.useFakeTimers();
    await createChat();
    await persistReducerTurn();
    const pendingFallbackCommits: Promise<unknown>[] = [];
    const transactWith = repository.transactWith.bind(repository);
    jest
      .spyOn(repository, 'transactWith')
      .mockImplementation((scope, build, options) => {
        const commit = transactWith(scope, build, options);
        if (options.source === 'automation')
          pendingFallbackCommits.push(commit);
        return commit;
      });
    const observeTurnPause = Reflect.get(service, 'observeTurnPause');
    expect(typeof observeTurnPause).toBe('function');
    if (typeof observeTurnPause !== 'function') return;

    expect(() =>
      Reflect.apply(observeTurnPause, service, [
        {
          ...SCOPE,
          chatId: CHAT_ID,
          type: 'PauseOpened',
          ownerKind: 'approval',
          ownerId: 'approval-1',
          atMs: 1_100,
        },
      ]),
    ).not.toThrow();
    await waitForHandoffReduction();
    await jest.advanceTimersByTimeAsync(2_000);
    await Promise.all(pendingFallbackCommits);

    expect(
      (await repository.getState(SCOPE)).runtimeByChatId[CHAT_ID]?.turn?.current
        ?.pauses,
    ).toEqual([
      expect.objectContaining({
        ownerKind: 'approval',
        ownerId: 'approval-1',
        startedAtMs: 1_100,
      }),
    ]);
  });

  it('never overwrites a newer committed turn with the fallback flush captured earlier', async () => {
    jest.useFakeTimers();
    await createChat();
    service.observeTurnLifecycle(turnStartedEvent(1));
    await waitForHandoffReduction();

    // Hold the scope so a carrier transaction and the fallback queue in order.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = repository.transactWith(
      SCOPE,
      async () => {
        await gate;
        return [];
      },
      { source: 'automation', mutationId: 'hold-scope', chatIds: [] },
    );
    const transactWithTurnHandoff: unknown = Reflect.get(
      service,
      'transactWithTurnHandoff',
    );
    if (typeof transactWithTurnHandoff !== 'function')
      throw new Error('Expected the service transaction wrapper');
    const carrier: unknown = Reflect.apply(transactWithTurnHandoff, service, [
      SCOPE,
      (): never[] => [],
      {
        source: 'provider',
        mutationId: 'carry-newer-turn',
        chatIds: [CHAT_ID],
      },
    ]);
    await jest.advanceTimersByTimeAsync(2_000);
    service.observeTurnLifecycle(turnEndedEvent(2));
    release();
    await blocker;
    await carrier;
    await jest.advanceTimersByTimeAsync(2_000);

    const turn = (await repository.getState(SCOPE)).runtimeByChatId[CHAT_ID]
      ?.turn;
    expect(turn?.current).toBeUndefined();
    expect(turn?.lastEnded).toMatchObject({
      id: 'turn-restart-id',
      outcome: 'completed',
    });
  });

  it('saves a recreated handoff entry whose generation restarts', async () => {
    jest.useFakeTimers();
    await createChat();
    service.observeTurnLifecycle(turnStartedEvent(1));
    await waitForHandoffReduction();
    await jest.advanceTimersByTimeAsync(2_000);
    expect(
      (await repository.getState(SCOPE)).runtimeByChatId[CHAT_ID]?.turn
        ?.current,
    ).toMatchObject({ id: 'turn-restart-id' });

    const handoff: unknown = Reflect.get(service, 'turnHandoff');
    if (!(handoff instanceof ChatTurnStateHandoff))
      throw new Error('Chat state service did not create its turn handoff');
    handoff.invalidate({ ...SCOPE, chatId: CHAT_ID });
    service.observeTurnLifecycle(turnEndedEvent(2));
    await waitForHandoffReduction();
    await jest.advanceTimersByTimeAsync(2_000);

    expect(
      (await repository.getState(SCOPE)).runtimeByChatId[CHAT_ID]?.turn
        ?.lastEnded,
    ).toMatchObject({ id: 'turn-restart-id', outcome: 'completed' });
  });

  it('loads a scope whose persisted turn is malformed', async () => {
    await createChat();
    await repository.transact(
      SCOPE,
      [
        {
          type: 'runtime.patched',
          chatId: CHAT_ID,
          runtime: {
            status: 'idle',
            queuedMessageIds: [],
            turn: JSON.parse('{}') as PersistedChatTurnState,
          },
        },
      ],
      { source: 'provider', mutationId: 'persist-malformed-turn' },
    );

    await expect(service.getState(SCOPE)).resolves.toMatchObject({
      runtimeByChatId: { [CHAT_ID]: { status: 'idle' } },
    });
    expect(mockRequestBackgroundSnapshot).not.toHaveBeenCalled();
  });
});
