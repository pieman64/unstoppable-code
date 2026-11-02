import {
  initialChatTurnState,
  reduceChatTurn,
  serializeChatTurnState,
} from '@canopy/agent-transcript/turn';
import type { PersistedChatTurnState } from '@canopy/agent-transcript/turn';
import type { ChatTurnLifecycleEvent } from '@canopy/protocol/canopy-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatStateService } from '../chat-state-service';
import { ChatTurnStateHandoff } from '../chat-turn-state-handoff';
import type {
  ChatTurnStateChange,
  ChatTurnStateHandoffScope,
  ChatTurnStateHandoffSnapshot,
} from '../chat-turn-state-handoff';
import { ChatStateV2Repository } from '../chat-state-v2-repository';

const SCOPE: ChatTurnStateHandoffScope = {
  projectId: 'chat-turn-seam-project',
  worktreeId: 'chat-turn-seam-worktree',
  chatId: 'chat-turn-seam-chat',
};
const INITIAL_TURN = serializeChatTurnState(initialChatTurnState());

function turnStartedEvent(
  sequence: number,
  options: {
    phase?: 'start' | 'binding-update';
    turnId?: string;
    userMessageIds?: string[];
  } = {},
): ChatTurnLifecycleEvent {
  return {
    version: 1,
    provider: 'claude',
    projectId: SCOPE.projectId,
    worktreeId: SCOPE.worktreeId,
    chatId: SCOPE.chatId,
    sequence,
    eventId: `chat-turn-seam-started-${sequence}`,
    observedAtMs: 1_000 + sequence,
    type: 'TurnStarted',
    turnId: options.turnId ?? 'chat-turn-seam-turn',
    origin: 'user',
    binding: 'bound',
    submissionIds: [],
    userMessageIds: options.userMessageIds ?? ['chat-turn-seam-input-1'],
    providerUserMessageUuids: [],
    phase: options.phase ?? 'start',
    startedAtMs: 1_000,
  };
}

function turnEndedEvent(
  sequence: number,
  turnId = 'chat-turn-seam-turn',
): ChatTurnLifecycleEvent {
  return {
    version: 1,
    provider: 'claude',
    projectId: SCOPE.projectId,
    worktreeId: SCOPE.worktreeId,
    chatId: SCOPE.chatId,
    sequence,
    eventId: `chat-turn-seam-ended-${sequence}`,
    observedAtMs: 1_500,
    type: 'TurnEnded',
    turnId,
    origin: 'user',
    binding: 'bound',
    submissionIds: [],
    userMessageIds: ['chat-turn-seam-input-1'],
    providerUserMessageUuids: [],
    endedAtMs: 1_500,
    outcome: 'completed',
    source: 'result',
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function waitForHandoffLoad(repository: ChatStateV2Repository): Promise<void> {
  const getState = repository.getState.bind(repository);
  let loadObserved = false;
  let resolveLoaded: () => void = () => undefined;
  let rejectLoaded: (error: unknown) => void = () => undefined;
  const loaded = new Promise<void>((resolve, reject) => {
    resolveLoaded = resolve;
    rejectLoaded = reject;
  });
  jest.spyOn(repository, 'getState').mockImplementation((scope, selection) => {
    const result = getState(scope, selection);
    if (!loadObserved && selection?.chatIds?.length === 0) {
      loadObserved = true;
      void result.then(resolveLoaded, rejectLoaded);
    }
    return result;
  });
  return loaded;
}

describe('chat turn state handoff seam', () => {
  let directory: string;
  let repository: ChatStateV2Repository;
  let service: ChatStateService;

  beforeEach(() => {
    jest.useRealTimers();
    directory = mkdtempSync(join(tmpdir(), 'canopy-chat-turn-seam-'));
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
      now: (): number => 2_000,
      recordDiagnostic: (): void => undefined,
      cleanupSession: (): Promise<void> => Promise.resolve(),
      chatCloseBlockReason: (): null => null,
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    service.disposeTurnHandoff();
    await repository.drainAll();
    rmSync(directory, { recursive: true, force: true });
  });

  async function createChat(): Promise<void> {
    await service.command({
      schemaVersion: 1,
      commandId: 'create-chat-turn-seam-chat',
      projectId: SCOPE.projectId,
      worktreeId: SCOPE.worktreeId,
      command: {
        type: 'chat.create_tab',
        tabId: SCOPE.chatId,
        title: 'Turn-state seam',
        providerType: 'claude',
        model: 'claude-opus-4-6',
      },
    });
  }

  it('hydrates lazily and publishes lifecycle and pause receipts after installing each state', async () => {
    await createChat();
    expect(service.getTurnState(SCOPE)).toBeUndefined();

    await service.getState({
      projectId: SCOPE.projectId,
      worktreeId: SCOPE.worktreeId,
    });
    expect(service.getTurnState(SCOPE)).toBeUndefined();

    const changes: ChatTurnStateChange[] = [];
    const statesReadDuringNotification: Array<
      PersistedChatTurnState | undefined
    > = [];
    let throwingChangeListenerCalls = 0;
    service.onTurnStateChange(() => {
      throwingChangeListenerCalls += 1;
      throw new Error('listener failure must be isolated');
    });
    let mutatedPauseEffect = false;
    service.onTurnStateChange((change) => {
      if (change.cause !== 'pause' || mutatedPauseEffect) return;
      const effect = change.effects[0];
      if (effect?.type !== 'timer.pause') return;
      effect.timerId = 'mutated-by-listener';
      if (change.state.current) change.state.current.id = 'mutated-by-listener';
      change.scope.chatId = 'mutated-by-listener';
      mutatedPauseEffect = true;
    });
    const unsubscriber = service.onTurnStateChange((change) => {
      changes.push(change);
      statesReadDuringNotification.push(service.getTurnState(change.scope));
    });
    let unsubscribedListenerCalls = 0;
    const unsubscribeSecond = service.onTurnStateChange(() => {
      unsubscribedListenerCalls += 1;
    });
    unsubscribeSecond();

    const handoffLoad = waitForHandoffLoad(repository);
    expect(() =>
      service.observeTurnLifecycle(turnStartedEvent(1)),
    ).not.toThrow();
    await handoffLoad;
    await flushMicrotasks();
    expect(service.getTurnState(SCOPE)?.phase).toBe('foreground');
    service.observeTurnLifecycle(
      turnStartedEvent(2, {
        phase: 'binding-update',
        userMessageIds: [
          'chat-turn-seam-input-2',
          'chat-turn-seam-input-1',
          'chat-turn-seam-input-3',
        ],
      }),
    );
    service.observeTurnPause({
      projectId: SCOPE.projectId,
      worktreeId: SCOPE.worktreeId,
      chatId: SCOPE.chatId,
      type: 'PauseOpened',
      ownerKind: 'approval',
      ownerId: 'chat-turn-seam-approval',
      atMs: 1_100,
    });
    service.observeTurnPause({
      projectId: SCOPE.projectId,
      worktreeId: SCOPE.worktreeId,
      chatId: SCOPE.chatId,
      type: 'PauseClosed',
      ownerKind: 'approval',
      ownerId: 'chat-turn-seam-approval',
      atMs: 1_200,
    });
    service.observeTurnLifecycle(turnEndedEvent(3));
    unsubscriber();
    service.observeTurnLifecycle(
      turnStartedEvent(4, {
        phase: 'binding-update',
        userMessageIds: [
          'chat-turn-seam-input-1',
          'chat-turn-seam-input-2',
          'chat-turn-seam-input-3',
        ],
      }),
    );

    expect(changes.map((change) => change.cause)).toEqual([
      'hydrate',
      'lifecycle',
      'lifecycle',
      'pause',
      'pause',
      'lifecycle',
    ]);
    expect(changes[2]?.effects).toEqual([]);
    expect(changes[2]?.state.current?.inputIds).toEqual([
      'chat-turn-seam-input-1',
      'chat-turn-seam-input-2',
      'chat-turn-seam-input-3',
    ]);
    expect(changes[3]?.effects).toEqual([
      expect.objectContaining({ type: 'timer.pause' }),
    ]);
    expect(changes[3]?.effects[0]).toMatchObject({
      type: 'timer.pause',
      timerId: 'chat-turn-seam-turn:timer',
    });
    expect(changes[3]?.state.current?.id).toBe('chat-turn-seam-turn');
    expect(changes[3]?.scope.chatId).toBe(SCOPE.chatId);
    expect(changes[4]?.effects).toEqual([
      expect.objectContaining({ type: 'timer.resume' }),
    ]);
    expect(statesReadDuringNotification).toEqual(
      changes.map((change) => change.state),
    );
    expect(unsubscribedListenerCalls).toBe(0);
    expect(throwingChangeListenerCalls).toBeGreaterThan(0);
    expect(mutatedPauseEffect).toBe(true);
  });

  it('publishes one reset with initial state when an archived chat invalidates its handoff', async () => {
    await createChat();
    const handoffLoad = waitForHandoffLoad(repository);
    service.observeTurnLifecycle(turnStartedEvent(1));
    await handoffLoad;

    const resets: PersistedChatTurnState[] = [];
    const statesReadDuringReset: Array<PersistedChatTurnState | undefined> = [];
    service.onTurnStateChange((change) => {
      if (change.cause !== 'reset') return;
      resets.push(change.state);
      statesReadDuringReset.push(service.getTurnState(change.scope));
    });

    const archive = await service.command({
      schemaVersion: 1,
      commandId: 'archive-chat-turn-seam-chat',
      projectId: SCOPE.projectId,
      worktreeId: SCOPE.worktreeId,
      command: { type: 'chat.archive_tab', tabId: SCOPE.chatId },
    });

    expect(archive.outcome).toBe('applied');
    expect(resets).toEqual([INITIAL_TURN]);
    expect(statesReadDuringReset).toEqual([INITIAL_TURN]);
  });

  it('publishes exactly one initial reset for chat.reset_to_point with the getter aligned in the listener', async () => {
    await createChat();
    await repository.transact(
      {
        projectId: SCOPE.projectId,
        worktreeId: SCOPE.worktreeId,
      },
      [
        {
          type: 'message.upserted',
          chatId: SCOPE.chatId,
          message: {
            id: 'chat-turn-seam-reset-anchor',
            role: 'user',
            timestamp: 1,
            blocks: [{ type: 'text', text: 'Reset here' }],
          },
        },
      ],
      { source: 'provider', mutationId: 'chat-turn-seam-reset-seed' },
    );
    const handoffLoad = waitForHandoffLoad(repository);
    service.observeTurnLifecycle(turnStartedEvent(1));
    await handoffLoad;
    await flushMicrotasks();

    const resets: PersistedChatTurnState[] = [];
    const statesReadDuringReset: Array<PersistedChatTurnState | undefined> = [];
    service.onTurnStateChange((change) => {
      if (change.cause !== 'reset') return;
      resets.push(change.state);
      statesReadDuringReset.push(service.getTurnState(change.scope));
    });

    await expect(
      service.command({
        schemaVersion: 1,
        commandId: 'chat-turn-seam-reset-command',
        projectId: SCOPE.projectId,
        worktreeId: SCOPE.worktreeId,
        command: {
          type: 'chat.reset_to_point',
          chatId: SCOPE.chatId,
          userMessageId: 'chat-turn-seam-reset-anchor',
        },
      }),
    ).resolves.toMatchObject({ outcome: 'applied' });

    expect(resets).toEqual([INITIAL_TURN]);
    expect(statesReadDuringReset).toEqual([INITIAL_TURN]);
    expect(service.getTurnState(SCOPE)).toBeUndefined();
  });

  it('does not let an older getState snapshot replace an acknowledged handoff reduction', async () => {
    jest.useFakeTimers();
    await createChat();
    const staleSnapshot = await repository.getState({
      projectId: SCOPE.projectId,
      worktreeId: SCOPE.worktreeId,
    });
    const changes: Array<{ cause: string }> = [];
    service.onTurnStateChange((change) => {
      changes.push({ cause: change.cause });
    });
    const getState = repository.getState.bind(repository);
    const handoffLoad = waitForHandoffLoad(repository);
    service.observeTurnLifecycle(turnStartedEvent(1));
    await handoffLoad;
    await flushMicrotasks();
    expect(service.getTurnState(SCOPE)?.current?.id).toBe(
      'chat-turn-seam-turn',
    );

    let releaseStaleRead: (
      state: Awaited<ReturnType<ChatStateV2Repository['getState']>>,
    ) => void = () => undefined;
    let signalStaleReadStarted: () => void = () => undefined;
    const staleReadStarted = new Promise<void>((resolve) => {
      signalStaleReadStarted = resolve;
    });
    let interceptNextRead = true;
    jest
      .spyOn(repository, 'getState')
      .mockImplementation((request, options) => {
        if (interceptNextRead && options === undefined) {
          interceptNextRead = false;
          signalStaleReadStarted();
          return new Promise((resolve) => {
            releaseStaleRead = resolve;
          });
        }
        return getState(request, options);
      });

    const olderServiceRead = service.getState({
      projectId: SCOPE.projectId,
      worktreeId: SCOPE.worktreeId,
    });
    await staleReadStarted;
    await jest.advanceTimersByTimeAsync(2_000);
    const acknowledgedState = service.getTurnState(SCOPE);
    expect(acknowledgedState?.current?.id).toBe('chat-turn-seam-turn');
    expect(
      (
        await getState({
          projectId: SCOPE.projectId,
          worktreeId: SCOPE.worktreeId,
        })
      ).runtimeByChatId[SCOPE.chatId]?.turn?.current?.id,
    ).toBe('chat-turn-seam-turn');

    const changeCountBeforeOlderReadReturns = changes.length;
    releaseStaleRead(staleSnapshot);
    await olderServiceRead;

    expect(service.getTurnState(SCOPE)).toEqual(acknowledgedState);
    expect(changes).toHaveLength(changeCountBeforeOlderReadReturns);
    expect(changes.map(({ cause }) => cause)).toEqual(['hydrate', 'lifecycle']);
  });

  it('publishes a committed service snapshot only after the fallback transaction is durable', async () => {
    jest.useFakeTimers();
    await createChat();
    const handoffLoad = waitForHandoffLoad(repository);
    const commits: Array<{
      generation: number;
      state: PersistedChatTurnState;
    }> = [];
    const readBacks: Array<PersistedChatTurnState | undefined> = [];
    let throwingCommittedListenerCalls = 0;
    service.onTurnStateCommitted(() => {
      throwingCommittedListenerCalls += 1;
      throw new Error('committed listener failure must be isolated');
    });
    service.onTurnStateCommitted((commit) => {
      if (commit.state.current)
        commit.state.current.id = 'mutated-by-committed-listener';
    });
    service.onTurnStateCommitted((commit) => {
      commits.push(commit);
      readBacks.push(service.getTurnState(commit.scope));
    });
    const fallbackCommits: Promise<unknown>[] = [];
    const transactWith = repository.transactWith.bind(repository);
    jest
      .spyOn(repository, 'transactWith')
      .mockImplementation((scope, build, options) => {
        const commit = transactWith(scope, build, options);
        if (options.source === 'automation') fallbackCommits.push(commit);
        return commit;
      });

    service.observeTurnLifecycle(turnStartedEvent(1));
    await handoffLoad;
    await flushMicrotasks();
    expect(commits).toEqual([]);
    await jest.advanceTimersByTimeAsync(2_000);
    await Promise.all(fallbackCommits);

    expect(commits).toHaveLength(1);
    expect(throwingCommittedListenerCalls).toBe(1);
    expect(commits[0]?.state.current?.id).toBe('chat-turn-seam-turn');
    expect(readBacks).toEqual(commits.map((commit) => commit.state));
    expect(
      (
        await repository.getState({
          projectId: SCOPE.projectId,
          worktreeId: SCOPE.worktreeId,
        })
      ).runtimeByChatId[SCOPE.chatId]?.turn,
    ).toEqual(commits[0]?.state);
  });
});

describe('chat turn state handoff commit acknowledgements', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('reports every lifecycle receipt and commits four coalesced turns once', async () => {
    jest.useFakeTimers();
    const lifecycleChanges: PersistedChatTurnState[] = [];
    const commits: Array<{
      generation: number;
      state: PersistedChatTurnState;
    }> = [];
    const handoff = new ChatTurnStateHandoff({
      load: (): Promise<unknown> => Promise.resolve(undefined),
      commit: (
        snapshot: ChatTurnStateHandoffSnapshot,
      ): Promise<{
        applied: boolean;
        written?: ChatTurnStateHandoffSnapshot;
      }> => Promise.resolve({ applied: true, written: snapshot }),
      onChange: (change): void => {
        if (change.cause === 'lifecycle') lifecycleChanges.push(change.state);
      },
      onCommitted: (commit): void => {
        commits.push(commit);
      },
      fallbackDelayMs: 10,
    });

    try {
      handoff.observeLifecycle(
        turnStartedEvent(1, { turnId: 'chat-turn-seam-first-turn' }),
      );
      handoff.observeLifecycle(turnEndedEvent(2, 'chat-turn-seam-first-turn'));
      handoff.observeLifecycle(
        turnStartedEvent(3, { turnId: 'chat-turn-seam-second-turn' }),
      );
      handoff.observeLifecycle(turnEndedEvent(4, 'chat-turn-seam-second-turn'));
      const finalSnapshot = await handoff.prepare(SCOPE);
      expect(finalSnapshot?.turn.lastEnded?.id).toBe(
        'chat-turn-seam-second-turn',
      );

      expect(lifecycleChanges).toHaveLength(4);
      expect(lifecycleChanges[0]?.current?.id).toBe(
        'chat-turn-seam-first-turn',
      );
      expect(lifecycleChanges[1]?.lastEnded?.id).toBe(
        'chat-turn-seam-first-turn',
      );
      expect(lifecycleChanges[2]?.current?.id).toBe(
        'chat-turn-seam-second-turn',
      );
      expect(lifecycleChanges[3]?.lastEnded?.id).toBe(
        'chat-turn-seam-second-turn',
      );

      await jest.advanceTimersByTimeAsync(10);

      expect(commits).toHaveLength(1);
      expect(commits[0]?.state.current).toBeUndefined();
      expect(commits[0]?.state.lastEnded).toMatchObject({
        id: 'chat-turn-seam-second-turn',
        outcome: 'completed',
      });
    } finally {
      handoff.dispose();
    }
  });

  it('retains queued lifecycle and pause receipts when restart settlement replaces state', async () => {
    let finishLoad: (value: unknown) => void = () => undefined;
    const load = new Promise<unknown>((resolve) => {
      finishLoad = resolve;
    });
    const changes: Array<{
      cause: string;
      effects: readonly { type: string }[];
      state: PersistedChatTurnState;
    }> = [];
    const handoff = new ChatTurnStateHandoff({
      load: (): Promise<unknown> => load,
      commit: (): Promise<{ applied: boolean }> =>
        Promise.resolve({ applied: false }),
      onChange: (change): void => {
        changes.push(change);
      },
    });
    const priorStart = reduceChatTurn(
      initialChatTurnState(),
      turnStartedEvent(1, { turnId: 'chat-turn-seam-prior-turn' }),
    );
    const priorEnd = reduceChatTurn(
      priorStart.state,
      turnEndedEvent(2, 'chat-turn-seam-prior-turn'),
    );
    const settledState = serializeChatTurnState(priorEnd.state);

    try {
      handoff.observeLifecycle(
        turnStartedEvent(3, { turnId: 'chat-turn-seam-after-restart' }),
      );
      handoff.observePause(SCOPE, {
        type: 'PauseOpened',
        ownerKind: 'approval',
        ownerId: 'chat-turn-seam-restart-approval',
        atMs: 1_600,
      });
      handoff.prepareRestart(SCOPE);
      handoff.restartFromState(SCOPE, settledState);
      finishLoad(INITIAL_TURN);
      await flushMicrotasks();

      expect(changes.map(({ cause }) => cause)).toEqual([
        'restart',
        'lifecycle',
        'pause',
      ]);
      expect(changes[0]?.state).toEqual(settledState);
      expect(changes[1]?.state.current?.id).toBe(
        'chat-turn-seam-after-restart',
      );
      expect(changes[2]?.state.current?.pauses).toHaveLength(1);
      expect(changes[2]?.effects).toEqual([
        expect.objectContaining({ type: 'timer.pause' }),
      ]);
    } finally {
      handoff.dispose();
    }
  });

  it('resumes queued lifecycle receipts when restart settlement fails', async () => {
    let finishLoad: (value: unknown) => void = () => undefined;
    const load = new Promise<unknown>((resolve) => {
      finishLoad = resolve;
    });
    const changes: Array<{ cause: string }> = [];
    const handoff = new ChatTurnStateHandoff({
      load: (): Promise<unknown> => load,
      commit: (): Promise<{ applied: boolean }> =>
        Promise.resolve({ applied: false }),
      onChange: (change): void => {
        changes.push({ cause: change.cause });
      },
    });

    try {
      handoff.observeLifecycle(turnStartedEvent(1));
      handoff.prepareRestart(SCOPE);
      finishLoad(INITIAL_TURN);
      handoff.cancelRestart(SCOPE);
      await handoff.prepare(SCOPE);

      expect(changes.map(({ cause }) => cause)).toEqual([
        'hydrate',
        'lifecycle',
      ]);
      expect(handoff.getState(SCOPE)?.current?.id).toBe('chat-turn-seam-turn');
    } finally {
      handoff.dispose();
    }
  });

  it('fences a restart for a chat without an entry and commits receipts that arrive during it', async () => {
    jest.useFakeTimers();
    const priorStart = reduceChatTurn(
      initialChatTurnState(),
      turnStartedEvent(1, { turnId: 'chat-turn-seam-prior-turn' }),
    );
    const openPrior = serializeChatTurnState(priorStart.state);
    const settledState = serializeChatTurnState(
      reduceChatTurn(
        priorStart.state,
        turnEndedEvent(2, 'chat-turn-seam-prior-turn'),
      ).state,
    );
    const changes: string[] = [];
    const commits: PersistedChatTurnState[] = [];
    const handoff = new ChatTurnStateHandoff({
      load: (): Promise<unknown> => Promise.resolve(openPrior),
      commit: (
        snapshot: ChatTurnStateHandoffSnapshot,
      ): Promise<{
        applied: boolean;
        written?: ChatTurnStateHandoffSnapshot;
      }> => Promise.resolve({ applied: true, written: snapshot }),
      onChange: (change): void => {
        changes.push(change.cause);
      },
      onCommitted: (commit): void => {
        commits.push(commit.state);
      },
      fallbackDelayMs: 10,
    });

    try {
      handoff.prepareRestart(SCOPE);
      handoff.observeLifecycle(
        turnStartedEvent(3, { turnId: 'chat-turn-seam-after-restart' }),
      );
      await flushMicrotasks();
      expect(handoff.getState(SCOPE)).toBeUndefined();

      handoff.restartFromState(SCOPE, settledState);
      expect(handoff.getState(SCOPE)?.current?.id).toBe(
        'chat-turn-seam-after-restart',
      );
      expect(changes).toEqual(['restart', 'lifecycle']);

      await jest.advanceTimersByTimeAsync(10);
      expect(commits).toHaveLength(1);
      expect(commits[0]?.current?.id).toBe('chat-turn-seam-after-restart');
      expect(commits[0]?.lastEnded?.id).toBe('chat-turn-seam-prior-turn');
    } finally {
      handoff.dispose();
    }
  });

  it('loads persisted state for a fenced chat without an entry when its restart fails', async () => {
    const changes: string[] = [];
    const handoff = new ChatTurnStateHandoff({
      load: (): Promise<unknown> => Promise.resolve(INITIAL_TURN),
      commit: (): Promise<{ applied: boolean }> =>
        Promise.resolve({ applied: false }),
      onChange: (change): void => {
        changes.push(change.cause);
      },
    });

    try {
      handoff.prepareRestart(SCOPE);
      handoff.observeLifecycle(turnStartedEvent(1));
      handoff.cancelRestart(SCOPE);
      await handoff.prepare(SCOPE);

      expect(changes).toEqual(['hydrate', 'lifecycle']);
      expect(handoff.getState(SCOPE)?.current?.id).toBe('chat-turn-seam-turn');
    } finally {
      handoff.dispose();
    }
  });

  it('treats capacity eviction as forgetting an entry, not as a reset', () => {
    const resetChats: string[] = [];
    const handoff = new ChatTurnStateHandoff({
      load: (): Promise<unknown> => Promise.resolve(undefined),
      commit: (): Promise<{ applied: boolean }> =>
        Promise.resolve({ applied: false }),
      onChange: (change): void => {
        if (change.cause === 'reset') resetChats.push(change.scope.chatId);
      },
    });

    try {
      for (let index = 0; index < 513; index += 1) {
        handoff.observePauseFromState(
          { ...SCOPE, chatId: `chat-turn-seam-lru-${index}` },
          {
            type: 'PauseClosed',
            ownerKind: 'approval',
            ownerId: 'chat-turn-seam-lru-owner',
          },
          INITIAL_TURN,
        );
      }

      expect(
        handoff.getState({
          ...SCOPE,
          chatId: 'chat-turn-seam-lru-0',
        }),
      ).toBeUndefined();
      expect(resetChats).toEqual([]);
    } finally {
      handoff.dispose();
    }
  });

  it('reports the exact committed generation when another lifecycle receipt arrives during the write', async () => {
    jest.useFakeTimers();
    const attempts: ChatTurnStateHandoffSnapshot[] = [];
    const commits: Array<{
      generation: number;
      state: PersistedChatTurnState;
    }> = [];
    let releaseFirstCommit: () => void = () => undefined;
    let signalFirstCommitStarted: () => void = () => undefined;
    const firstCommitStarted = new Promise<void>((resolve) => {
      signalFirstCommitStarted = resolve;
    });
    const handoff = new ChatTurnStateHandoff({
      load: (): Promise<unknown> => Promise.resolve(undefined),
      commit: (
        snapshot: ChatTurnStateHandoffSnapshot,
      ): Promise<{
        applied: boolean;
        written?: ChatTurnStateHandoffSnapshot;
      }> => {
        attempts.push(snapshot);
        if (attempts.length === 1) {
          signalFirstCommitStarted();
          return new Promise((resolve) => {
            releaseFirstCommit = (): void => {
              resolve({ applied: true, written: snapshot });
            };
          });
        }
        return Promise.resolve({ applied: true, written: snapshot });
      },
      onCommitted: (commit): void => {
        commits.push(commit);
      },
      fallbackDelayMs: 10,
    });

    try {
      handoff.observeLifecycle(turnStartedEvent(1));
      const firstSnapshot = await handoff.prepare(SCOPE);
      if (!firstSnapshot) throw new Error('Expected the first turn snapshot');
      jest.advanceTimersByTime(10);
      await firstCommitStarted;
      expect(commits).toEqual([]);

      handoff.observeLifecycle(turnEndedEvent(2));
      releaseFirstCommit();
      await flushMicrotasks();

      expect(commits).toHaveLength(1);
      expect(commits[0]).toEqual({
        scope: SCOPE,
        state: firstSnapshot.turn,
        generation: firstSnapshot.generation,
        incarnation: firstSnapshot.identity,
        effects: firstSnapshot.effects,
        lifecycle: firstSnapshot.lifecycle,
      });
      expect(commits[0]?.state.current?.id).toBe('chat-turn-seam-turn');
      expect(commits[0]?.state.lastEnded).toBeUndefined();

      handoff.acknowledge(firstSnapshot, true);
      handoff.acknowledge(firstSnapshot, true);
      expect(commits).toHaveLength(1);

      await handoff.flushAll();
      expect(attempts).toHaveLength(2);
      expect(commits).toHaveLength(2);
      expect(commits[1]?.state.current).toBeUndefined();
      expect(commits[1]?.state.lastEnded).toMatchObject({
        id: 'chat-turn-seam-turn',
        outcome: 'completed',
      });
      handoff.acknowledge(firstSnapshot, true);
      expect(commits).toHaveLength(2);
    } finally {
      handoff.dispose();
    }
  });

  it('does not report failed commits and publishes once after a retry succeeds', async () => {
    jest.useFakeTimers();
    let attempts = 0;
    const commits: Array<{
      generation: number;
      state: PersistedChatTurnState;
    }> = [];
    const errors: unknown[] = [];
    const handoff = new ChatTurnStateHandoff({
      load: (): Promise<unknown> => Promise.resolve(undefined),
      commit: (
        snapshot: ChatTurnStateHandoffSnapshot,
      ): Promise<{
        applied: boolean;
        written?: ChatTurnStateHandoffSnapshot;
      }> => {
        attempts += 1;
        if (attempts === 1) return Promise.reject(new Error('write failed'));
        return Promise.resolve({ applied: true, written: snapshot });
      },
      onCommitted: (commit): void => {
        commits.push(commit);
      },
      onError: (error): void => {
        errors.push(error);
      },
      fallbackDelayMs: 10,
    });

    try {
      handoff.observeLifecycle(turnStartedEvent(1));
      const snapshot = await handoff.prepare(SCOPE);
      if (!snapshot) throw new Error('Expected a turn snapshot');
      jest.advanceTimersByTime(10);
      await flushMicrotasks();
      expect(attempts).toBe(1);
      expect(errors).toHaveLength(1);
      expect(commits).toEqual([]);

      jest.advanceTimersByTime(10);
      await flushMicrotasks();
      expect(attempts).toBe(2);
      expect(commits).toEqual([
        {
          scope: SCOPE,
          state: snapshot.turn,
          generation: snapshot.generation,
          incarnation: snapshot.identity,
          effects: snapshot.effects,
          lifecycle: snapshot.lifecycle,
        },
      ]);

      handoff.acknowledge(snapshot, true);
      expect(commits).toHaveLength(1);
    } finally {
      handoff.dispose();
    }
  });

  it('keeps receipt-time reads undefined until an asynchronous load installs state', async () => {
    let finishLoad: (value: unknown) => void = () => undefined;
    const load = new Promise<unknown>((resolve) => {
      finishLoad = resolve;
    });
    const changes: Array<{
      cause: string;
      state: PersistedChatTurnState;
    }> = [];
    const handoff = new ChatTurnStateHandoff({
      load: (): Promise<unknown> => load,
      commit: (): Promise<{ applied: boolean }> =>
        Promise.resolve({ applied: false }),
      onChange: (change): void => {
        changes.push(change);
      },
    });

    try {
      handoff.observeLifecycle(turnStartedEvent(1));
      expect(handoff.getState(SCOPE)).toBeUndefined();
      finishLoad(undefined);
      await handoff.prepare(SCOPE);

      expect(changes.map((change) => change.cause)).toEqual([
        'hydrate',
        'lifecycle',
      ]);
      expect(handoff.getState(SCOPE)).toEqual(changes[1]?.state);
    } finally {
      handoff.dispose();
    }
  });

  it('seeds a loading handoff from its transaction snapshot before reducing queued receipts', async () => {
    let finishLoad: (value: unknown) => void = () => undefined;
    const load = new Promise<unknown>((resolve) => {
      finishLoad = resolve;
    });
    const changes: Array<{
      cause: string;
      state: PersistedChatTurnState;
    }> = [];
    const handoff = new ChatTurnStateHandoff({
      load: (): Promise<unknown> => load,
      commit: (): Promise<{ applied: boolean }> =>
        Promise.resolve({ applied: false }),
      onChange: (change): void => {
        changes.push(change);
      },
    });
    const start = reduceChatTurn(initialChatTurnState(), turnStartedEvent(1));
    const persisted = serializeChatTurnState(start.state);

    try {
      handoff.observeLifecycle(
        turnStartedEvent(2, {
          phase: 'binding-update',
          userMessageIds: ['chat-turn-seam-input-2'],
        }),
      );
      expect(handoff.getState(SCOPE)).toBeUndefined();
      handoff.seedFromState(SCOPE, persisted);
      finishLoad(initialChatTurnState());
      await handoff.prepare(SCOPE);

      expect(changes.map((change) => change.cause)).toEqual([
        'hydrate',
        'lifecycle',
      ]);
      expect(changes[1]?.state.current?.inputIds).toEqual([
        'chat-turn-seam-input-1',
        'chat-turn-seam-input-2',
      ]);
      expect(handoff.getState(SCOPE)).toEqual(changes[1]?.state);
    } finally {
      handoff.dispose();
    }
  });
});

describe('handoff effect journal', () => {
  it('retains receipt-ordered effects and intermediate bindings across unapplied and failed commits', async () => {
    const attempts: ChatTurnStateHandoffSnapshot[] = [];
    const handoff = new ChatTurnStateHandoff({
      load: (): Promise<unknown> => Promise.resolve(undefined),
      commit: (snapshot): Promise<{ applied: boolean }> => {
        attempts.push(snapshot);
        if (attempts.length === 1)
          return Promise.reject(new Error('write failed'));
        return Promise.resolve({ applied: attempts.length > 2 });
      },
    });
    const expectedRecords: unknown = expect.arrayContaining([
      expect.objectContaining({
        id: 'chat-turn-seam-turn',
        inputIds: ['chat-turn-seam-input-1', 'second-input'],
      }),
      expect.objectContaining({ id: 'second-turn' }),
    ]);
    try {
      handoff.observeLifecycle(turnStartedEvent(1));
      handoff.observeLifecycle(
        turnStartedEvent(2, {
          phase: 'binding-update',
          userMessageIds: ['second-input'],
        }),
      );
      handoff.observeLifecycle(turnEndedEvent(3));
      handoff.observeLifecycle(
        turnStartedEvent(4, {
          turnId: 'second-turn',
          userMessageIds: ['third-input'],
        }),
      );
      handoff.observeLifecycle(turnEndedEvent(5, 'second-turn'));
      const snapshot = await handoff.prepare(SCOPE);
      expect(snapshot).toMatchObject({
        effects: [
          { type: 'timer.open', turnId: 'chat-turn-seam-turn' },
          { type: 'timer.close', turnId: 'chat-turn-seam-turn' },
          { type: 'turn.ended', turnId: 'chat-turn-seam-turn' },
          { type: 'chat.idle' },
          { type: 'timer.open', turnId: 'second-turn' },
          { type: 'timer.close', turnId: 'second-turn' },
          { type: 'turn.ended', turnId: 'second-turn' },
          { type: 'chat.idle' },
        ],
        turnRecords: expectedRecords,
        lifecycle: [
          expect.objectContaining({
            transition: 'start',
            turnId: 'chat-turn-seam-turn',
          }),
          expect.objectContaining({
            transition: 'binding',
            inputIds: ['chat-turn-seam-input-1', 'second-input'],
          }),
          expect.objectContaining({
            transition: 'end',
            turnId: 'chat-turn-seam-turn',
          }),
          expect.objectContaining({
            transition: 'start',
            turnId: 'second-turn',
          }),
          expect.objectContaining({ transition: 'end', turnId: 'second-turn' }),
        ],
      });
      await handoff.flushAll();
      expect(await handoff.prepare(SCOPE)).toEqual(snapshot);
      await handoff.flushAll();
      expect(await handoff.prepare(SCOPE)).toEqual(snapshot);
      await handoff.flushAll();
      expect(attempts).toEqual([snapshot, snapshot, snapshot]);
      expect(handoff.snapshotNow(SCOPE)).toBeUndefined();
    } finally {
      handoff.dispose();
    }
  });
});

describe('durable journal prefix acknowledgement', () => {
  it('prunes before reentrant reads, retains the later prefix and never offers effects twice', async () => {
    const observed: Array<ChatTurnStateHandoffSnapshot | undefined> = [];
    const handoff = new ChatTurnStateHandoff({
      load: (): Promise<unknown> => Promise.resolve(undefined),
      commit: (): Promise<{ applied: boolean }> =>
        Promise.resolve({ applied: true }),
      onCommitted: (): void => {
        observed.push(handoff.snapshotNow(SCOPE));
      },
    });
    try {
      handoff.observeLifecycle(turnStartedEvent(1));
      const first = await handoff.prepare(SCOPE);
      if (!first) throw new Error('Missing first snapshot');
      handoff.observeLifecycle(turnEndedEvent(2));
      handoff.acknowledge(first, true);
      expect(observed[0]?.effects).toEqual([
        expect.objectContaining({ type: 'timer.close' }),
        expect.objectContaining({ type: 'turn.ended' }),
        { type: 'chat.idle' },
      ]);
      const second = handoff.snapshotNow(SCOPE);
      if (!second) throw new Error('Missing second snapshot');
      handoff.acknowledge(second, true);
      expect(observed).toHaveLength(2);
      expect(observed[1]).toBeUndefined();
      handoff.acknowledge(first, true);
      expect(observed).toHaveLength(2);
    } finally {
      handoff.dispose();
    }
  });
});

describe('overlapping journal captures', () => {
  it('filters effects already acknowledged from an older capture', async () => {
    const effects: unknown[] = [];
    const handoff = new ChatTurnStateHandoff({
      load: (): Promise<unknown> => Promise.resolve(undefined),
      commit: (): Promise<{ applied: boolean }> =>
        Promise.resolve({ applied: true }),
      onCommitted: (commit): void => {
        effects.push(...(commit.effects ?? []));
      },
    });
    try {
      handoff.observeLifecycle(turnStartedEvent(1));
      const first = await handoff.prepare(SCOPE);
      handoff.observeLifecycle(turnEndedEvent(2));
      const second = await handoff.prepare(SCOPE);
      if (!first || !second) throw new Error('Missing snapshots');
      handoff.acknowledge(first, true);
      handoff.acknowledge(second, true);
      expect(effects).toHaveLength(4);
      expect(
        effects.filter(
          (effect) =>
            typeof effect === 'object' &&
            effect !== null &&
            'type' in effect &&
            effect.type === 'timer.open',
        ),
      ).toHaveLength(1);
    } finally {
      handoff.dispose();
    }
  });
});
