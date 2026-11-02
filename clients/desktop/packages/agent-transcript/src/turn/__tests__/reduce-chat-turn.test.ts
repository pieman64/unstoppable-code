import type {
  BackgroundSet,
  ChatTurnLifecycleEvent,
  ProducerBase,
  SessionState,
  SpawnedBy,
  TurnBinding,
  TurnEnded,
  TurnOrigin,
  TurnStarted,
} from '@canopy/protocol/canopy-core';
import {
  chatTurnTimerId,
  hydrateChatTurnState,
  initialChatTurnState,
  reduceChatTurn,
  reduceChatTurnHostEvent,
  serializeChatTurnState,
  settleChatTurnForRestart,
  type ChatTurnEffect,
  type ChatTurnHostPauseEvent,
  type ChatTurnOutcome,
  type ChatTurnPauseOwnerKind,
  type ChatTurnState,
} from '../index';

interface ProducerOptions {
  provider?: ProducerBase['provider'];
  processEpoch?: string;
  observedAtMs?: number;
  omitProcessEpoch?: boolean;
}

interface BindingOptions {
  origin?: TurnOrigin;
  binding?: TurnBinding['binding'];
  submissionIds?: string[];
  userMessageIds?: string[];
  providerUserMessageUuids?: string[];
  providerOriginKind?: string;
  resultIndex?: number;
  spawnedBy?: SpawnedBy;
}

type StartedOptions = ProducerOptions &
  BindingOptions & {
    phase?: TurnStarted['phase'];
    startedAtMs?: number;
  };

type EndedOptions = ProducerOptions &
  BindingOptions & {
    endedAtMs?: number;
    outcome?: ChatTurnOutcome;
    durationMs?: number;
    source?: TurnEnded['source'];
    terminalReason?: string;
  };

type SessionOptions = ProducerOptions & {
  observedDuringTurnId?: string;
  source?: SessionState['source'];
};

type BackgroundOptions = ProducerOptions & {
  observedDuringTurnId?: string;
  native?: BackgroundSet['native'];
  managed?: BackgroundSet['managed'];
};

function producer(
  sequence: number,
  options: ProducerOptions = {},
): ProducerBase {
  const provider = options.provider ?? 'claude';
  const processEpoch = options.omitProcessEpoch
    ? undefined
    : (options.processEpoch ?? 'epoch-1');
  return {
    version: 1,
    provider,
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    chatId: 'chat-1',
    ...(processEpoch === undefined ? {} : { processEpoch }),
    sequence,
    eventId: `event:${provider}:${processEpoch ?? 'no-epoch'}:${sequence}`,
    observedAtMs: options.observedAtMs ?? sequence * 100,
  };
}

function turnBinding(
  turnId: string,
  options: BindingOptions = {},
): TurnBinding {
  const spawnedBy = options.spawnedBy;
  return {
    turnId,
    origin: options.origin ?? 'user',
    binding: options.binding ?? 'bound',
    submissionIds: [...(options.submissionIds ?? [])],
    userMessageIds: [...(options.userMessageIds ?? [])],
    providerUserMessageUuids: [...(options.providerUserMessageUuids ?? [])],
    ...(options.providerOriginKind === undefined
      ? {}
      : { providerOriginKind: options.providerOriginKind }),
    ...(options.resultIndex === undefined
      ? {}
      : { resultIndex: options.resultIndex }),
    ...(spawnedBy === undefined ? {} : { spawnedBy: { ...spawnedBy } }),
  };
}

function turnStarted(
  turnId: string,
  sequence: number,
  options: StartedOptions = {},
): TurnStarted {
  return {
    ...producer(sequence, options),
    ...turnBinding(turnId, options),
    type: 'TurnStarted',
    phase: options.phase ?? 'start',
    startedAtMs: options.startedAtMs ?? sequence * 100,
  };
}

function turnEnded(
  turnId: string,
  sequence: number,
  options: EndedOptions = {},
): TurnEnded {
  const durationMs = options.durationMs;
  const terminalReason = options.terminalReason;
  return {
    ...producer(sequence, options),
    ...turnBinding(turnId, options),
    type: 'TurnEnded',
    endedAtMs: options.endedAtMs ?? sequence * 100,
    outcome: options.outcome ?? 'completed',
    ...(durationMs === undefined ? {} : { durationMs }),
    source: options.source ?? 'result',
    ...(terminalReason === undefined ? {} : { terminalReason }),
  };
}

function sessionState(
  state: SessionState['state'],
  sequence: number,
  options: SessionOptions = {},
): SessionState {
  const observedDuringTurnId = options.observedDuringTurnId;
  return {
    ...producer(sequence, options),
    type: 'SessionState',
    state,
    source: options.source ?? 'provider',
    ...(observedDuringTurnId === undefined ? {} : { observedDuringTurnId }),
  };
}

function backgroundSet(
  sequence: number,
  options: BackgroundOptions = {},
): BackgroundSet {
  const observedDuringTurnId = options.observedDuringTurnId;
  const native = options.native ?? [];
  const managed = options.managed ?? { live: 0, queued: 0 };
  return {
    ...producer(sequence, options),
    type: 'BackgroundSet',
    semantics: 'replace',
    ...(observedDuringTurnId === undefined ? {} : { observedDuringTurnId }),
    native: native.map((task) => ({ ...task })),
    managed: { ...managed },
  };
}

function hostPauseEvent(
  type: ChatTurnHostPauseEvent['type'],
  turnId: string,
  ownerKind: ChatTurnPauseOwnerKind,
  ownerId: string,
  atMs: number,
  hostSequence: number,
): ChatTurnHostPauseEvent {
  return { type, turnId, ownerKind, ownerId, atMs, hostSequence };
}

function reduceWithoutMutatingInputs(
  state: ChatTurnState,
  event: ChatTurnLifecycleEvent,
): { state: ChatTurnState; effects: ChatTurnEffect[] } {
  const stateBefore = structuredClone(state);
  const eventBefore = structuredClone(event);
  const result = reduceChatTurn(state, event);
  expect(state).toEqual(stateBefore);
  expect(event).toEqual(eventBefore);
  return result;
}

describe('initial chat-turn state and timer identifiers', () => {
  it('creates independent fresh state, including nested collections', () => {
    const first = initialChatTurnState();
    const second = initialChatTurnState();

    expect(first).toEqual({
      phase: 'idle',
      decisionPending: false,
      catchingUp: false,
      endedTurnIds: [],
      background: { native: [], managed: { live: 0, queued: 0 } },
      cursors: {},
    });
    expect(first).not.toBe(second);
    expect(first.endedTurnIds).not.toBe(second.endedTurnIds);
    expect(first.background).not.toBe(second.background);
    expect(first.background.native).not.toBe(second.background.native);
    expect(first.background.managed).not.toBe(second.background.managed);
    expect(first.cursors).not.toBe(second.cursors);

    first.endedTurnIds.push('only-first');
    first.background = {
      native: [{ id: 'only-first-native' }],
      managed: { live: 1, queued: 0 },
    };
    first.cursors['claude:epoch-1'] = 1;

    expect(second).toEqual(initialChatTurnState());
  });

  it('derives a stable timer identifier from the turn id', () => {
    expect(chatTurnTimerId('turn-42')).toBe('turn-42:timer');
  });
});

describe('producer sequence cursors', () => {
  it('tracks sequence independently for each provider and process epoch', () => {
    let state = initialChatTurnState();
    state = reduceChatTurn(
      state,
      turnStarted('claude-epoch-one', 4, {
        provider: 'claude',
        processEpoch: 'epoch-one',
      }),
    ).state;
    state = reduceChatTurn(
      state,
      turnStarted('codex-epoch-one', 1, {
        provider: 'codex',
        processEpoch: 'epoch-one',
      }),
    ).state;
    state = reduceChatTurn(
      state,
      turnStarted('claude-epoch-two', 1, {
        provider: 'claude',
        processEpoch: 'epoch-two',
      }),
    ).state;

    expect(Object.keys(state.cursors)).toHaveLength(3);
    expect(
      Object.values(state.cursors).sort((left, right) => left - right),
    ).toEqual([1, 1, 4]);

    const stale = reduceChatTurn(
      state,
      turnStarted('stale-claude-turn', 3, {
        provider: 'claude',
        processEpoch: 'epoch-one',
      }),
    );
    expect(stale.state.current?.id).toBe('claude-epoch-two');
    expect(stale.state.cursors).toEqual(state.cursors);
    expect(stale.effects).toEqual([]);
  });

  it('uses an empty epoch segment in the cursor key when processEpoch is absent', () => {
    const base = turnStarted('epoch-free-turn', 1, {
      provider: 'claude',
      omitProcessEpoch: true,
    });
    const epochlessEvent: TurnStarted = {
      ...base,
      processEpoch: undefined,
    };
    const result = reduceChatTurn(initialChatTurnState(), epochlessEvent);

    expect(result.state.cursors).toEqual({ 'claude:': 1 });
    expect(result.state.current?.id).toBe('epoch-free-turn');
  });

  it('advances the cursor for a fresh event that is ignored semantically', () => {
    const opened = reduceChatTurn(
      initialChatTurnState(),
      turnStarted('open-turn', 1, { startedAtMs: 100 }),
    );
    const wrongTurnEnd = turnEnded('different-turn', 2, {
      endedAtMs: 200,
      outcome: 'failed',
    });
    const ignored = reduceChatTurn(opened.state, wrongTurnEnd);

    expect(ignored.state.current?.id).toBe('open-turn');
    expect(ignored.state.endedTurnIds).toEqual([]);
    expect(ignored.effects).toEqual([]);
    expect(Object.values(ignored.state.cursors)).toEqual([2]);
  });
});

describe('turn starts and binding updates', () => {
  it('merges same-id start and binding data without resetting the original start time', () => {
    const first = reduceChatTurn(
      initialChatTurnState(),
      turnStarted('turn-1', 1, {
        startedAtMs: 100,
        origin: 'autonomous',
      }),
    );
    const repeatedStart = reduceChatTurn(
      first.state,
      turnStarted('turn-1', 2, {
        phase: 'start',
        startedAtMs: 250,
        origin: 'steer',
        spawnedBy: { taskId: 'task-1', toolUseId: 'tool-1' },
        userMessageIds: ['message-1', 'message-not-selected'],
      }),
    );

    expect(repeatedStart.state.current).toEqual({
      id: 'turn-1',
      origin: 'steer',
      userMessageId: 'message-1',
      inputIds: ['message-1', 'message-not-selected'],
      spawnedBy: { taskId: 'task-1', toolUseId: 'tool-1' },
      startedAtMs: 100,
      pauses: [],
    });
    expect(repeatedStart.effects).toEqual([]);

    const bindingUpdate = reduceChatTurn(
      repeatedStart.state,
      turnStarted('turn-1', 3, {
        phase: 'binding-update',
        startedAtMs: 500,
        origin: 'restart',
        spawnedBy: { taskId: 'task-2' },
        userMessageIds: ['message-2'],
      }),
    );
    expect(bindingUpdate.state.current).toEqual({
      id: 'turn-1',
      origin: 'restart',
      userMessageId: 'message-1',
      inputIds: ['message-1', 'message-not-selected', 'message-2'],
      spawnedBy: { taskId: 'task-2', toolUseId: 'tool-1' },
      startedAtMs: 100,
      pauses: [],
    });
    expect(bindingUpdate.effects).toEqual([]);

    const omittedSpawnedBy = reduceChatTurn(
      bindingUpdate.state,
      turnStarted('turn-1', 4, {
        phase: 'binding-update',
        startedAtMs: 700,
        origin: 'steer',
        userMessageIds: ['message-3'],
      }),
    );
    expect(omittedSpawnedBy.state.current).toEqual({
      id: 'turn-1',
      origin: 'steer',
      userMessageId: 'message-1',
      inputIds: ['message-1', 'message-not-selected', 'message-2', 'message-3'],
      spawnedBy: { taskId: 'task-2', toolUseId: 'tool-1' },
      startedAtMs: 100,
      pauses: [],
    });
    expect(omittedSpawnedBy.effects).toEqual([]);
  });

  it.each<[string, SpawnedBy]>([
    ['an event wake', { taskId: 'task-1', toolUseId: 'tool-1', event: true }],
    ['a cron fire', { toolUseId: 'tool-1', scheduled: true }],
    ['a tools-loaded continuation', { toolUseId: 'tool-1', toolsLoaded: true }],
  ])(
    "keeps %s's cause from a binding update through its end and persistence",
    (_name, cause) => {
      const opened = reduceChatTurn(
        initialChatTurnState(),
        turnStarted('wake', 1, { origin: 'autonomous', binding: 'pending' }),
      );
      const updated = reduceChatTurn(
        opened.state,
        turnStarted('wake', 2, {
          phase: 'binding-update',
          origin: 'autonomous',
          binding: 'unbound',
          spawnedBy: cause,
        }),
      );
      expect(updated.state.current?.spawnedBy).toEqual(cause);
      expect(
        hydrateChatTurnState(serializeChatTurnState(updated.state))?.current
          ?.spawnedBy,
      ).toEqual(cause);

      const ended = reduceChatTurn(
        updated.state,
        turnEnded('wake', 3, { origin: 'autonomous', binding: 'unbound' }),
      );
      expect(ended.state.lastEnded?.spawnedBy).toEqual(cause);

      // Only `true` marks an event; any other stored value is dropped.
      const persisted = serializeChatTurnState(ended.state);
      expect(
        hydrateChatTurnState({
          ...persisted,
          lastEnded: {
            ...persisted.lastEnded,
            spawnedBy: { taskId: 'task-1', event: 'yes' },
          },
        })?.lastEnded?.spawnedBy,
      ).toEqual({ taskId: 'task-1' });
    },
  );

  it('ignores a binding update when there is no current turn, except for its cursor', () => {
    const update = turnStarted('unmatched-update', 1, {
      phase: 'binding-update',
      startedAtMs: 100,
      origin: 'steer',
      spawnedBy: { taskId: 'task-1' },
      userMessageIds: ['message-1'],
    });
    const result = reduceChatTurn(initialChatTurnState(), update);

    expect(result.state.current).toBeUndefined();
    expect(result.state.phase).toBe('idle');
    expect(result.state.cursors).toEqual({ 'claude:epoch-1': 1 });
    expect(result.state.lastEnded).toBeUndefined();
    expect(result.effects).toEqual([]);
  });

  it('ignores a binding update for a different current turn id, except for its cursor', () => {
    const opened = reduceChatTurn(
      initialChatTurnState(),
      turnStarted('current-turn', 1, {
        startedAtMs: 100,
        origin: 'user',
      }),
    );
    const mismatchedUpdate = turnStarted('other-turn', 2, {
      phase: 'binding-update',
      startedAtMs: 200,
      origin: 'restart',
      spawnedBy: { taskId: 'task-2' },
      userMessageIds: ['other-message'],
    });
    const result = reduceChatTurn(opened.state, mismatchedUpdate);

    expect(result.state.current).toEqual(opened.state.current);
    expect(result.state.phase).toBe('foreground');
    expect(result.state.cursors).toEqual({ 'claude:epoch-1': 2 });
    expect(result.effects).toEqual([]);
  });

  it('supersedes an open turn once and finalizes it before opening the next timer', () => {
    const first = reduceChatTurn(
      initialChatTurnState(),
      turnStarted('old-turn', 1, {
        startedAtMs: 1_000,
        observedAtMs: 1_000,
      }),
    );
    const supersedingStart = turnStarted('new-turn', 2, {
      startedAtMs: 2_000,
      observedAtMs: 2_000,
    });
    const superseded = reduceChatTurn(first.state, supersedingStart);

    const expectedEffects: ChatTurnEffect[] = [
      {
        type: 'timer.close',
        timerId: chatTurnTimerId('old-turn'),
        turnId: 'old-turn',
        atMs: 2_000,
        durationMs: 1_000,
      },
      { type: 'turn.ended', turnId: 'old-turn', outcome: 'cancelled' },
      {
        type: 'timer.open',
        timerId: chatTurnTimerId('new-turn'),
        turnId: 'new-turn',
        atMs: 2_000,
      },
    ];
    expect(superseded.effects).toEqual(expectedEffects);
    expect(superseded.state.current?.id).toBe('new-turn');
    expect(superseded.state.lastEnded).toEqual({
      id: 'old-turn',
      origin: 'user',
      startedAtMs: 1_000,
      pauses: [],
      endedAtMs: 2_000,
      outcome: 'cancelled',
      durationMs: 1_000,
    });
    expect(superseded.state.endedTurnIds).toEqual(['old-turn']);

    const lateEnd = reduceChatTurn(
      superseded.state,
      turnEnded('old-turn', 3, { endedAtMs: 2_100, outcome: 'cancelled' }),
    );
    expect(lateEnd.state.current?.id).toBe('new-turn');
    expect(lateEnd.state.endedTurnIds).toEqual(['old-turn']);
    expect(lateEnd.effects).toEqual([]);
  });

  it('ignores an end event for a different open turn id', () => {
    const opened = reduceChatTurn(
      initialChatTurnState(),
      turnStarted('current-turn', 1, { startedAtMs: 100 }),
    );
    const wrongEnd = reduceChatTurn(
      opened.state,
      turnEnded('not-current', 2, {
        endedAtMs: 200,
        outcome: 'failed',
      }),
    );

    expect(wrongEnd.state.current).toEqual(opened.state.current);
    expect(wrongEnd.state.lastEnded).toBeUndefined();
    expect(wrongEnd.state.endedTurnIds).toEqual([]);
    expect(wrongEnd.state.phase).toBe('foreground');
    expect(wrongEnd.effects).toEqual([]);
  });
});

describe('turn finalization', () => {
  it('keeps an explicitly supplied zero duration instead of deriving one', () => {
    const opened = reduceChatTurn(
      initialChatTurnState(),
      turnStarted('zero-duration', 1, { startedAtMs: 100 }),
    );
    const ended = reduceChatTurn(
      opened.state,
      turnEnded('zero-duration', 2, {
        endedAtMs: 500,
        durationMs: 0,
        outcome: 'completed',
        source: 'result',
      }),
    );

    expect(ended.state.lastEnded?.durationMs).toBe(0);
    expect(ended.state.lastEnded?.outcome).toBe('completed');
    expect(ended.effects).toEqual([
      {
        type: 'timer.close',
        timerId: chatTurnTimerId('zero-duration'),
        turnId: 'zero-duration',
        atMs: 500,
        durationMs: 0,
      },
      { type: 'turn.ended', turnId: 'zero-duration', outcome: 'completed' },
      { type: 'chat.idle' },
    ]);
  });

  it('derives duration from event times and clamps negative duration to zero', () => {
    const opened = reduceChatTurn(
      initialChatTurnState(),
      turnStarted('short-turn', 1, { startedAtMs: 300 }),
    );
    const ended = reduceChatTurn(
      opened.state,
      turnEnded('short-turn', 2, {
        endedAtMs: 250,
        outcome: 'failed',
        source: 'abort-fallback',
      }),
    );

    expect(ended.state.lastEnded?.durationMs).toBe(0);
    expect(ended.state.lastEnded?.endedAtMs).toBe(250);
    expect(ended.state.lastEnded?.outcome).toBe('failed');
    expect(ended.effects[0]).toEqual({
      type: 'timer.close',
      timerId: chatTurnTimerId('short-turn'),
      turnId: 'short-turn',
      atMs: 250,
      durationMs: 0,
    });
  });

  it('preserves every supported terminal outcome', () => {
    const outcomes: Array<{ index: number; outcome: ChatTurnOutcome }> = [
      { index: 0, outcome: 'completed' },
      { index: 1, outcome: 'cancelled' },
      { index: 2, outcome: 'failed' },
    ];

    for (const { index, outcome } of outcomes) {
      const turnId = `outcome-${outcome}`;
      const opened = reduceChatTurn(
        initialChatTurnState(),
        turnStarted(turnId, index * 2 + 1, { startedAtMs: 1_000 }),
      );
      const ended = reduceChatTurn(
        opened.state,
        turnEnded(turnId, index * 2 + 2, {
          endedAtMs: 1_250,
          durationMs: 900,
          outcome,
        }),
      );

      expect(ended.state.lastEnded?.outcome).toBe(outcome);
      expect(ended.state.lastEnded?.durationMs).toBe(900);
      expect(ended.state.endedTurnIds).toEqual([turnId]);
      const expectedTimerClose: ChatTurnEffect = {
        type: 'timer.close',
        timerId: chatTurnTimerId(turnId),
        turnId,
        atMs: 1_250,
        durationMs: 900,
      };
      const expectedTurnEnded: ChatTurnEffect = {
        type: 'turn.ended',
        turnId,
        outcome,
      };
      expect(ended.effects[0]).toEqual(expectedTimerClose);
      expect(ended.effects[1]).toEqual(expectedTurnEnded);
      expect(ended.effects[2]).toEqual({ type: 'chat.idle' });
    }
  });

  it('retains only the most recent 32 settled turn ids in FIFO order', () => {
    let state = initialChatTurnState();

    for (let index = 1; index <= 33; index += 1) {
      const turnId = `turn-${String(index).padStart(2, '0')}`;
      state = reduceChatTurn(
        state,
        turnStarted(turnId, index * 2 - 1, { startedAtMs: index * 1_000 }),
      ).state;
      state = reduceChatTurn(
        state,
        turnEnded(turnId, index * 2, {
          endedAtMs: index * 1_000,
          durationMs: 0,
        }),
      ).state;
    }

    const expectedIds = Array.from(
      { length: 32 },
      (_, index) => `turn-${String(index + 2).padStart(2, '0')}`,
    );
    expect(state.endedTurnIds).toHaveLength(32);
    expect(state.endedTurnIds).toEqual(expectedIds);
  });
});

describe('settled turns', () => {
  it('fences settled turn events but applies background snapshots regardless of correlation', () => {
    const opened = reduceChatTurn(
      initialChatTurnState(),
      turnStarted('settled-turn', 1, { startedAtMs: 100 }),
    );
    const settled = reduceChatTurn(
      opened.state,
      turnEnded('settled-turn', 2, {
        endedAtMs: 200,
        outcome: 'completed',
        durationMs: 100,
      }),
    );
    const replacement = reduceChatTurn(
      settled.state,
      turnStarted('current-turn', 3, { startedAtMs: 300 }),
    );
    const afterStart = reduceChatTurn(
      replacement.state,
      turnStarted('settled-turn', 4, { startedAtMs: 400 }),
    );
    const afterBinding = reduceChatTurn(
      afterStart.state,
      turnStarted('settled-turn', 5, {
        phase: 'binding-update',
        startedAtMs: 500,
        origin: 'restart',
        userMessageIds: ['late-message'],
      }),
    );
    const afterEnd = reduceChatTurn(
      afterBinding.state,
      turnEnded('settled-turn', 6, {
        endedAtMs: 600,
        outcome: 'failed',
        durationMs: 0,
      }),
    );
    const afterSessionObservation = reduceChatTurn(
      afterEnd.state,
      sessionState('requires_action', 7, {
        observedDuringTurnId: 'settled-turn',
      }),
    );
    const result = reduceChatTurn(
      afterSessionObservation.state,
      backgroundSet(8, {
        observedDuringTurnId: 'settled-turn',
        native: [{ id: 'late-native-task' }],
        managed: { live: 1, queued: 2 },
      }),
    );

    expect(result.state.current?.id).toBe('current-turn');
    expect(result.state.phase).toBe('foreground');
    expect(result.state.lastEnded).toEqual(settled.state.lastEnded);
    expect(result.state.endedTurnIds).toEqual(['settled-turn']);
    expect(result.state.background).toEqual({
      native: [{ id: 'late-native-task' }],
      managed: { live: 1, queued: 2 },
    });
    expect(result.state.decisionPending).toBe(false);
    expect(Object.values(result.state.cursors)).toEqual([8]);
    expect(afterStart.effects).toEqual([]);
    expect(afterBinding.effects).toEqual([]);
    expect(afterEnd.effects).toEqual([]);
    expect(afterSessionObservation.effects).toEqual([]);
    expect(result.effects).toEqual([]);
  });
});

describe('host pause observations', () => {
  it('tracks unique owner intervals and fences duplicate, unknown, and stale events', () => {
    const started = reduceChatTurn(
      initialChatTurnState(),
      turnStarted('paused-turn', 1, { startedAtMs: 100 }),
    );
    const waiting = reduceChatTurn(
      started.state,
      sessionState('requires_action', 2, {
        observedDuringTurnId: 'paused-turn',
      }),
    );
    const firstOpen = reduceChatTurnHostEvent(
      waiting.state,
      hostPauseEvent(
        'PauseOpened',
        'paused-turn',
        'approval',
        'same-id',
        110,
        1,
      ),
    );
    expect(firstOpen.effects).toEqual([
      {
        type: 'timer.pause',
        timerId: chatTurnTimerId('paused-turn'),
        turnId: 'paused-turn',
        atMs: 110,
      },
    ]);

    const duplicateOpen = reduceChatTurnHostEvent(
      firstOpen.state,
      hostPauseEvent(
        'PauseOpened',
        'paused-turn',
        'approval',
        'same-id',
        120,
        2,
      ),
    );
    expect(duplicateOpen.effects).toEqual([]);
    expect(duplicateOpen.state.current?.pauses).toEqual([
      {
        ownerKind: 'approval',
        ownerId: 'same-id',
        startedAtMs: 110,
      },
    ]);

    const secondOwner = reduceChatTurnHostEvent(
      duplicateOpen.state,
      hostPauseEvent(
        'PauseOpened',
        'paused-turn',
        'question',
        'same-id',
        125,
        3,
      ),
    );
    expect(secondOwner.effects).toEqual([]);
    expect(secondOwner.state.current?.pauses).toHaveLength(2);
    expect(secondOwner.state.phase).toBe('foreground');
    expect(secondOwner.state.decisionPending).toBe(true);

    const firstClose = reduceChatTurnHostEvent(
      secondOwner.state,
      hostPauseEvent(
        'PauseClosed',
        'paused-turn',
        'approval',
        'same-id',
        130,
        4,
      ),
    );
    expect(firstClose.effects).toEqual([]);
    expect(firstClose.state.current?.pauses[0]?.endedAtMs).toBe(130);

    const unknownClose = reduceChatTurnHostEvent(
      firstClose.state,
      hostPauseEvent(
        'PauseClosed',
        'paused-turn',
        'approval',
        'unknown',
        140,
        5,
      ),
    );
    expect(unknownClose.effects).toEqual([]);
    expect(unknownClose.state.current?.pauses[1]?.endedAtMs).toBeUndefined();
    expect(unknownClose.state.cursors.host).toBe(5);

    const stale = reduceChatTurnHostEvent(
      unknownClose.state,
      hostPauseEvent('PauseOpened', 'paused-turn', 'approval', 'stale', 150, 5),
    );
    expect(stale).toEqual({ state: unknownClose.state, effects: [] });

    const finalClose = reduceChatTurnHostEvent(
      unknownClose.state,
      hostPauseEvent(
        'PauseClosed',
        'paused-turn',
        'question',
        'same-id',
        160,
        6,
      ),
    );
    expect(finalClose.effects).toEqual([
      {
        type: 'timer.resume',
        timerId: chatTurnTimerId('paused-turn'),
        turnId: 'paused-turn',
        atMs: 160,
      },
    ]);
    expect(finalClose.state.current?.pauses[1]?.endedAtMs).toBe(160);
    expect(finalClose.state.phase).toBe('foreground');
    expect(finalClose.state.decisionPending).toBe(true);
  });

  it('clamps a host close to its pause start and permits a new interval for the owner', () => {
    const started = reduceChatTurn(
      initialChatTurnState(),
      turnStarted('reopen', 1),
    );
    const opened = reduceChatTurnHostEvent(
      started.state,
      hostPauseEvent('PauseOpened', 'reopen', 'question', 'owner', 200, 1),
    );
    const stateBefore = structuredClone(opened.state);
    const event = hostPauseEvent(
      'PauseClosed',
      'reopen',
      'question',
      'owner',
      150,
      2,
    );
    const eventBefore = structuredClone(event);
    const closed = reduceChatTurnHostEvent(opened.state, event);
    expect(opened.state).toEqual(stateBefore);
    expect(event).toEqual(eventBefore);
    expect(closed.state.current?.pauses[0]?.endedAtMs).toBe(200);
    expect(closed.effects).toEqual([
      {
        type: 'timer.resume',
        timerId: chatTurnTimerId('reopen'),
        turnId: 'reopen',
        atMs: 150,
      },
    ]);
    const reopened = reduceChatTurnHostEvent(
      closed.state,
      hostPauseEvent('PauseOpened', 'reopen', 'question', 'owner', 250, 3),
    );
    expect(reopened.state.current?.pauses).toHaveLength(2);
    expect(reopened.effects).toEqual([
      {
        type: 'timer.pause',
        timerId: chatTurnTimerId('reopen'),
        turnId: 'reopen',
        atMs: 250,
      },
    ]);
  });

  it('ignores a replayed open for a closed interval before the next approval', () => {
    const started = reduceChatTurn(
      initialChatTurnState(),
      turnStarted('replay', 1),
    );
    const opened = reduceChatTurnHostEvent(
      started.state,
      hostPauseEvent('PauseOpened', 'replay', 'approval', 'first', 200, 1),
    );
    const closed = reduceChatTurnHostEvent(
      opened.state,
      hostPauseEvent('PauseClosed', 'replay', 'approval', 'first', 300, 2),
    );
    const replayed = reduceChatTurnHostEvent(
      closed.state,
      hostPauseEvent('PauseOpened', 'replay', 'approval', 'first', 200, 3),
    );
    expect(replayed.state.current?.pauses).toEqual(
      closed.state.current?.pauses,
    );
    expect(replayed.effects).toEqual([]);
    expect(replayed.state.cursors.host).toBe(3);
    const next = reduceChatTurnHostEvent(
      replayed.state,
      hostPauseEvent('PauseOpened', 'replay', 'approval', 'second', 400, 4),
    );
    expect(next.effects).toEqual([
      {
        type: 'timer.pause',
        timerId: chatTurnTimerId('replay'),
        turnId: 'replay',
        atMs: 400,
      },
    ]);
  });

  it('ignores delayed opens after settled turns and supersession while advancing the host cursor', () => {
    const started = reduceChatTurn(
      initialChatTurnState(),
      turnStarted('settled-pause-turn', 1, { startedAtMs: 100 }),
    );
    const settled = reduceChatTurn(
      started.state,
      turnEnded('settled-pause-turn', 2, { endedAtMs: 200 }),
    );
    const delayedAfterEnd = reduceChatTurnHostEvent(
      settled.state,
      hostPauseEvent(
        'PauseOpened',
        'settled-pause-turn',
        'approval',
        'late-approval',
        210,
        1,
      ),
    );
    expect(delayedAfterEnd.effects).toEqual([]);
    expect(delayedAfterEnd.state.current).toBeUndefined();
    expect(delayedAfterEnd.state.lastEnded).toEqual(settled.state.lastEnded);
    expect(delayedAfterEnd.state.cursors.host).toBe(1);

    const oldTurn = reduceChatTurn(
      initialChatTurnState(),
      turnStarted('superseded-pause-turn', 1, { startedAtMs: 100 }),
    );
    const oldTurnPaused = reduceChatTurnHostEvent(
      oldTurn.state,
      hostPauseEvent(
        'PauseOpened',
        'superseded-pause-turn',
        'approval',
        'superseded-owner',
        170,
        1,
      ),
    );
    const replacement = reduceChatTurn(
      oldTurnPaused.state,
      turnStarted('replacement-turn', 2, { startedAtMs: 150 }),
    );
    const delayedAfterSupersession = reduceChatTurnHostEvent(
      replacement.state,
      hostPauseEvent(
        'PauseOpened',
        'superseded-pause-turn',
        'question',
        'late-question',
        160,
        2,
      ),
    );
    expect(delayedAfterSupersession.effects).toEqual([]);
    expect(delayedAfterSupersession.state.current?.id).toBe('replacement-turn');
    expect(delayedAfterSupersession.state.lastEnded?.id).toBe(
      'superseded-pause-turn',
    );
    expect(delayedAfterSupersession.state.lastEnded?.pauses[0]?.endedAtMs).toBe(
      170,
    );
    expect(delayedAfterSupersession.state.cursors.host).toBe(2);
    expect(replacement.effects).toEqual([
      {
        type: 'timer.close',
        timerId: chatTurnTimerId('superseded-pause-turn'),
        turnId: 'superseded-pause-turn',
        atMs: 150,
        durationMs: 50,
      },
      {
        type: 'turn.ended',
        turnId: 'superseded-pause-turn',
        outcome: 'cancelled',
      },
      {
        type: 'timer.open',
        timerId: chatTurnTimerId('replacement-turn'),
        turnId: 'replacement-turn',
        atMs: 150,
      },
    ]);
    expect(replacement.effects).not.toContainEqual(
      expect.objectContaining({ type: 'timer.resume' }),
    );
  });

  it('closes open intervals at finalization without resuming and preserves skewed timestamps', () => {
    const started = reduceChatTurn(
      initialChatTurnState(),
      turnStarted('finalized-paused-turn', 1, { startedAtMs: 100 }),
    );
    const paused = reduceChatTurnHostEvent(
      started.state,
      hostPauseEvent(
        'PauseOpened',
        'finalized-paused-turn',
        'approval',
        'open-owner',
        150,
        1,
      ),
    );
    const ended = reduceChatTurn(
      paused.state,
      turnEnded('finalized-paused-turn', 2, {
        endedAtMs: 140,
        terminalReason: 'provider-stop',
      }),
    );

    expect(ended.state.lastEnded).toEqual({
      id: 'finalized-paused-turn',
      origin: 'user',
      startedAtMs: 100,
      pauses: [
        {
          ownerKind: 'approval',
          ownerId: 'open-owner',
          startedAtMs: 150,
          endedAtMs: 150,
        },
      ],
      endedAtMs: 140,
      outcome: 'completed',
      durationMs: 40,
      terminalReason: 'provider-stop',
    });
    expect(ended.effects).toEqual([
      {
        type: 'timer.close',
        timerId: chatTurnTimerId('finalized-paused-turn'),
        turnId: 'finalized-paused-turn',
        atMs: 140,
        durationMs: 40,
      },
      {
        type: 'turn.ended',
        turnId: 'finalized-paused-turn',
        outcome: 'completed',
      },
      { type: 'chat.idle' },
    ]);
    expect(ended.effects).not.toContainEqual(
      expect.objectContaining({ type: 'timer.resume' }),
    );
  });

  it('uses the exact end time when finalizing after an open pause starts', () => {
    const started = reduceChatTurn(
      initialChatTurnState(),
      turnStarted('later-end', 1),
    );
    const paused = reduceChatTurnHostEvent(
      started.state,
      hostPauseEvent('PauseOpened', 'later-end', 'approval', 'owner', 150, 1),
    );
    const ended = reduceChatTurn(
      paused.state,
      turnEnded('later-end', 2, { endedAtMs: 200 }),
    );
    expect(ended.state.lastEnded?.pauses[0]?.endedAtMs).toBe(200);
    expect(ended.effects.some((effect) => effect.type === 'timer.resume')).toBe(
      false,
    );
  });

  it('derives duration from the union of overlapping pauses clipped to the turn', () => {
    let state = reduceChatTurn(
      initialChatTurnState(),
      turnStarted('union-pause-turn', 1, { startedAtMs: 100 }),
    ).state;
    state = reduceChatTurnHostEvent(
      state,
      hostPauseEvent(
        'PauseOpened',
        'union-pause-turn',
        'approval',
        'first',
        80,
        1,
      ),
    ).state;
    state = reduceChatTurnHostEvent(
      state,
      hostPauseEvent(
        'PauseOpened',
        'union-pause-turn',
        'question',
        'second',
        120,
        2,
      ),
    ).state;
    state = reduceChatTurnHostEvent(
      state,
      hostPauseEvent(
        'PauseClosed',
        'union-pause-turn',
        'approval',
        'first',
        130,
        3,
      ),
    ).state;
    state = reduceChatTurnHostEvent(
      state,
      hostPauseEvent(
        'PauseClosed',
        'union-pause-turn',
        'question',
        'second',
        180,
        4,
      ),
    ).state;
    state = reduceChatTurnHostEvent(
      state,
      hostPauseEvent(
        'PauseOpened',
        'union-pause-turn',
        'approval',
        'third',
        190,
        5,
      ),
    ).state;
    state = reduceChatTurnHostEvent(
      state,
      hostPauseEvent(
        'PauseClosed',
        'union-pause-turn',
        'approval',
        'third',
        250,
        6,
      ),
    ).state;
    const ended = reduceChatTurn(
      state,
      turnEnded('union-pause-turn', 2, { endedAtMs: 200 }),
    );

    expect(ended.state.lastEnded?.durationMs).toBe(10);
  });

  it('nets a provider-reported duration of the turn approval pauses', () => {
    // Providers report elapsed wall time, which includes the time a turn
    // waited for approvals; the record keeps active time only.
    let state = reduceChatTurn(
      initialChatTurnState(),
      turnStarted('approval-duration-turn', 1, { startedAtMs: 1_000 }),
    ).state;
    for (const [ownerId, openedAtMs, closedAtMs, sequence] of [
      ['first', 1_100, 1_300, 1],
      ['second', 1_400, 4_000, 3],
    ] as const) {
      state = reduceChatTurnHostEvent(
        state,
        hostPauseEvent(
          'PauseOpened',
          'approval-duration-turn',
          'approval',
          ownerId,
          openedAtMs,
          sequence,
        ),
      ).state;
      state = reduceChatTurnHostEvent(
        state,
        hostPauseEvent(
          'PauseClosed',
          'approval-duration-turn',
          'approval',
          ownerId,
          closedAtMs,
          sequence + 1,
        ),
      ).state;
    }
    const ended = reduceChatTurn(
      state,
      turnEnded('approval-duration-turn', 2, {
        endedAtMs: 4_500,
        durationMs: 3_520,
      }),
    );

    expect(ended.state.lastEnded?.durationMs).toBe(720);
    expect(ended.effects).toContainEqual(
      expect.objectContaining({ type: 'timer.close', durationMs: 720 }),
    );

    // Without pauses, the provider's own duration is kept as reported.
    const unpaused = reduceChatTurn(
      reduceChatTurn(
        initialChatTurnState(),
        turnStarted('unpaused-duration-turn', 1, { startedAtMs: 1_000 }),
      ).state,
      turnEnded('unpaused-duration-turn', 2, {
        endedAtMs: 1_500,
        durationMs: 513,
      }),
    );
    expect(unpaused.state.lastEnded?.durationMs).toBe(513);
  });

  it('uses supplied duration and terminal reason, and restart settles with cancelled outcome', () => {
    const started = reduceChatTurn(
      initialChatTurnState(),
      turnStarted('provider-duration-turn', 1, { startedAtMs: 100 }),
    );
    const paused = reduceChatTurnHostEvent(
      started.state,
      hostPauseEvent(
        'PauseOpened',
        'provider-duration-turn',
        'question',
        'question-1',
        120,
        1,
      ),
    );
    const providerEnded = reduceChatTurn(
      paused.state,
      turnEnded('provider-duration-turn', 2, {
        endedAtMs: 200,
        durationMs: 97,
        terminalReason: 'completed-by-provider',
      }),
    );
    // The supplied wall time is netted of the question still open at the end
    // (120-200), leaving the provider's 17 ms of active time.
    expect(providerEnded.state.lastEnded?.durationMs).toBe(17);
    expect(providerEnded.state.lastEnded?.terminalReason).toBe(
      'completed-by-provider',
    );

    const restartStart = reduceChatTurn(
      initialChatTurnState(),
      turnStarted('restart-paused-turn', 1, { startedAtMs: 100 }),
    );
    const restartPause = reduceChatTurnHostEvent(
      restartStart.state,
      hostPauseEvent(
        'PauseOpened',
        'restart-paused-turn',
        'approval',
        'restart-owner',
        200,
        1,
      ),
    );
    const inBackground = reduceChatTurn(
      restartPause.state,
      backgroundSet(2, {
        native: [{ id: 'native-work' }],
        managed: { live: 0, queued: 1 },
      }),
    );
    const restarted = settleChatTurnForRestart(inBackground.state, 150);

    expect(restarted.state.current).toBeUndefined();
    expect(restarted.state.phase).toBe('background');
    expect(restarted.state.lastEnded?.outcome).toBe('cancelled');
    expect(restarted.state.lastEnded?.terminalReason).toBe('restart');
    expect(restarted.state.lastEnded?.pauses[0]?.endedAtMs).toBe(200);
    expect(restarted.effects).toEqual([
      {
        type: 'timer.close',
        timerId: chatTurnTimerId('restart-paused-turn'),
        turnId: 'restart-paused-turn',
        atMs: 150,
        durationMs: 50,
      },
      {
        type: 'turn.ended',
        turnId: 'restart-paused-turn',
        outcome: 'cancelled',
      },
    ]);
    expect(restarted.effects).not.toContainEqual(
      expect.objectContaining({ type: 'timer.resume' }),
    );
    expect(settleChatTurnForRestart(restarted.state, 250)).toEqual({
      state: restarted.state,
      effects: [],
    });

    const withoutBackground = reduceChatTurn(
      restartStart.state,
      turnStarted('restart-replacement', 2, { startedAtMs: 110 }),
    );
    const restartWithoutBackground = settleChatTurnForRestart(
      withoutBackground.state,
      120,
    );
    expect(restartWithoutBackground.state.lastEnded?.terminalReason).toBe(
      'restart',
    );
    expect(restartWithoutBackground.effects).toContainEqual({
      type: 'chat.idle',
    });
  });
});

describe('bounded reducer collections', () => {
  it('accepts the last pause slot and fences cap + 1 without changing the turn', () => {
    const started = reduceChatTurn(
      initialChatTurnState(),
      turnStarted('bounded', 1),
    );
    const current = started.state.current;
    if (current === undefined) throw new Error('Expected current turn');
    const state: ChatTurnState = {
      ...started.state,
      current: {
        ...current,
        pauses: Array.from({ length: 4_095 }, (_, index) => ({
          ownerKind: 'approval',
          ownerId: `prior-${index}`,
          startedAtMs: 100,
          endedAtMs: 100,
        })),
      },
    };
    const atCap = reduceChatTurnHostEvent(
      state,
      hostPauseEvent('PauseOpened', 'bounded', 'question', 'last-slot', 200, 1),
    );
    expect(atCap.state.current?.pauses).toHaveLength(4_096);
    expect(atCap.effects[0]?.type).toBe('timer.pause');
    expect(hydrateChatTurnState(serializeChatTurnState(atCap.state))).toEqual({
      ...atCap.state,
      cursors: {},
    });
    const overflow = reduceChatTurnHostEvent(
      atCap.state,
      hostPauseEvent('PauseOpened', 'bounded', 'approval', 'overflow', 210, 2),
    );
    expect(overflow.state).toEqual({
      ...atCap.state,
      cursors: { ...atCap.state.cursors, host: 2 },
    });
    expect(overflow.effects).toEqual([]);
    const closed = reduceChatTurnHostEvent(
      overflow.state,
      hostPauseEvent('PauseClosed', 'bounded', 'question', 'last-slot', 220, 3),
    );
    expect(closed.effects[0]?.type).toBe('timer.resume');
    const stillFull = reduceChatTurnHostEvent(
      closed.state,
      hostPauseEvent('PauseOpened', 'bounded', 'question', 'last-slot', 230, 4),
    );
    expect(stillFull.state.current?.pauses).toEqual(
      closed.state.current?.pauses,
    );
    expect(stillFull.effects).toEqual([]);
  });

  it.each([4_096, 4_097])(
    'retains the first capped native tasks from a %i-item replace-set',
    (count) => {
      const native = Array.from({ length: count }, (_, index) => ({
        id: `native-${index}`,
      }));
      const result = reduceChatTurn(
        initialChatTurnState(),
        backgroundSet(1, { native }),
      );
      expect(result.state.background.native).toEqual(native.slice(0, 4_096));
      expect(result.state.phase).toBe('background');
      expect(
        hydrateChatTurnState(serializeChatTurnState(result.state)),
      ).toEqual({ ...result.state, cursors: {} });
      expect(native).toHaveLength(count);
    },
  );
});

describe('persisted chat-turn state', () => {
  function persistedFixture(): ChatTurnState {
    const ended = reduceChatTurn(
      initialChatTurnState(),
      turnStarted('prior-turn', 1, { startedAtMs: 100 }),
    );
    const priorPause = reduceChatTurnHostEvent(
      ended.state,
      hostPauseEvent(
        'PauseOpened',
        'prior-turn',
        'question',
        'late-owner',
        500,
        1,
      ),
    );
    const settled = reduceChatTurn(
      priorPause.state,
      turnEnded('prior-turn', 2, {
        endedAtMs: 400,
        terminalReason: 'prior-stop',
      }),
    );
    const current = reduceChatTurn(
      settled.state,
      turnStarted('current-persisted-turn', 3, { startedAtMs: 500 }),
    );
    const paused = reduceChatTurnHostEvent(
      current.state,
      hostPauseEvent(
        'PauseOpened',
        'current-persisted-turn',
        'approval',
        'persisted-owner',
        700,
        2,
      ),
    );
    return reduceChatTurn(
      paused.state,
      backgroundSet(4, {
        native: [{ id: 'persisted-native', taskType: 'worker' }],
        managed: { live: 2, queued: 1 },
      }),
    ).state;
  }

  it('round-trips detached known shapes while dropping host and provider cursors', () => {
    const state = persistedFixture();
    const persisted = serializeChatTurnState(state);
    expect(persisted).not.toHaveProperty('cursors');
    expect(persisted.current?.pauses[0]).toEqual({
      ownerKind: 'approval',
      ownerId: 'persisted-owner',
      startedAtMs: 700,
    });
    expect(persisted.current?.pauses).not.toBe(state.current?.pauses);
    expect(persisted.endedTurnIds).not.toBe(state.endedTurnIds);
    expect(persisted.background.native).not.toBe(state.background.native);

    const parsed: unknown = JSON.parse(JSON.stringify(persisted));
    const hydrated = hydrateChatTurnState(parsed);
    expect(hydrated).toEqual({ ...state, cursors: {} });
    expect(hydrated?.cursors).toEqual({});

    const withUnknownFields: unknown = {
      ...persisted,
      unknownStateField: { secret: 'do not retain' },
      background: {
        ...persisted.background,
        unknownBackgroundField: { secret: 'do not retain' },
        native: persisted.background.native.map((task) => ({
          ...task,
          unknownTaskField: 'do not retain',
        })),
      },
      current: {
        ...persisted.current,
        unknownRecordField: { secret: 'do not retain' },
        pauses: persisted.current?.pauses.map((pause) => ({
          ...pause,
          unknownPauseField: 'do not retain',
        })),
      },
    };
    const sanitized = hydrateChatTurnState(withUnknownFields);
    expect(sanitized).toEqual(hydrated);
    expect(sanitized).not.toHaveProperty('unknownStateField');
    expect(sanitized?.background).not.toHaveProperty('unknownBackgroundField');
    expect(sanitized?.background.native[0]).not.toHaveProperty(
      'unknownTaskField',
    );
    expect(sanitized?.current).not.toHaveProperty('unknownRecordField');
    expect(sanitized?.current?.pauses[0]).not.toHaveProperty(
      'unknownPauseField',
    );
  });

  it('rejects inconsistent records and duplicate open pause owners', () => {
    const persisted = serializeChatTurnState(persistedFixture());
    const current = persisted.current;
    const lastEnded = persisted.lastEnded;
    if (current === undefined || lastEnded === undefined) {
      throw new Error('Expected both turn records in persistence fixture');
    }
    const openPause = {
      ownerKind: 'approval',
      ownerId: 'duplicate',
      startedAtMs: 600,
    };
    const invalidInputs: unknown[] = [
      { ...persisted, phase: 'idle' },
      {
        ...serializeChatTurnState(initialChatTurnState()),
        phase: 'foreground',
      },
      { ...persisted, current: { ...current, endedAtMs: 900 } },
      { ...persisted, current: { ...current, outcome: 'completed' } },
      { ...persisted, current: { ...current, durationMs: 100 } },
      {
        ...persisted,
        current: { ...current, terminalReason: 'already-ended' },
      },
      { ...persisted, current: { ...current, id: lastEnded.id } },
      { ...persisted, current: { ...current, pauses: [openPause, openPause] } },
      {
        ...persisted,
        current: { ...current, pauses: [{ ...openPause, endedAtMs: 500 }] },
      },
      { ...persisted, lastEnded: { ...lastEnded, endedAtMs: undefined } },
      { ...persisted, lastEnded: { ...lastEnded, outcome: undefined } },
      { ...persisted, lastEnded: { ...lastEnded, durationMs: undefined } },
      { ...persisted, lastEnded: { ...lastEnded, pauses: [openPause] } },
      { ...persisted, endedTurnIds: [...persisted.endedTurnIds, lastEnded.id] },
    ];
    for (const invalid of invalidInputs) {
      expect(hydrateChatTurnState(invalid)).toBeUndefined();
    }
  });

  it('rejects invalid structures, enum values, nonfinite numbers, and oversized collections', () => {
    const persisted = serializeChatTurnState(persistedFixture());
    const current = persisted.current;
    const lastEnded = persisted.lastEnded;
    if (current === undefined || lastEnded === undefined) {
      throw new Error(
        'Expected persisted fixture to include current and last-ended turns',
      );
    }
    const oversizedPause = {
      ownerKind: 'approval',
      ownerId: 'owner',
      startedAtMs: 1,
    };
    const invalidInputs: unknown[] = [
      null,
      'not-an-object',
      { ...persisted, phase: 'paused' },
      { ...persisted, decisionPending: 'false' },
      { ...persisted, catchingUp: 1 },
      { ...persisted, current: { ...current, id: 42 } },
      { ...persisted, current: { ...current, origin: 'provider' } },
      { ...persisted, current: { ...current, pauses: 'not-an-array' } },
      {
        ...persisted,
        current: {
          ...current,
          pauses: [{ ...oversizedPause, ownerKind: 'tool' }],
        },
      },
      {
        ...persisted,
        current: {
          ...current,
          pauses: [{ ...oversizedPause, ownerId: 8 }],
        },
      },
      { ...persisted, current: { ...current, startedAtMs: Number.NaN } },
      {
        ...persisted,
        current: {
          ...current,
          pauses: [
            { ...oversizedPause, startedAtMs: Number.POSITIVE_INFINITY },
          ],
        },
      },
      { ...persisted, lastEnded: { ...lastEnded, outcome: 'suspended' } },
      {
        ...persisted,
        background: {
          ...persisted.background,
          managed: { live: 0, queued: Number.NaN },
        },
      },
      {
        ...persisted,
        background: { ...persisted.background, native: [{ id: 8 }] },
      },
      {
        ...persisted,
        endedTurnIds: Array.from({ length: 33 }, (_, index) => `${index}`),
      },
      {
        ...persisted,
        current: {
          ...current,
          pauses: Array.from({ length: 4_097 }, () => ({ ...oversizedPause })),
        },
      },
      {
        ...persisted,
        background: {
          ...persisted.background,
          native: Array.from({ length: 4_097 }, (_, index) => ({
            id: `${index}`,
          })),
        },
      },
    ];

    for (const invalid of invalidInputs) {
      expect(hydrateChatTurnState(invalid)).toBeUndefined();
    }
  });
});

describe('session-state observations', () => {
  it('changes decisionPending only for matching or unscoped running and requires_action observations', () => {
    const noTurnAction = reduceChatTurn(
      initialChatTurnState(),
      sessionState('requires_action', 1),
    );
    expect(noTurnAction.state.decisionPending).toBe(false);
    expect(noTurnAction.state.current).toBeUndefined();
    expect(noTurnAction.state.cursors).toEqual({ 'claude:epoch-1': 1 });
    const noTurnRunning = reduceChatTurn(
      noTurnAction.state,
      sessionState('running', 2),
    );
    expect(noTurnRunning.state.decisionPending).toBe(false);

    const opened = reduceChatTurn(
      noTurnRunning.state,
      turnStarted('observed-turn', 3, { startedAtMs: 300 }),
    );
    const mismatched = reduceChatTurn(
      opened.state,
      sessionState('requires_action', 4, {
        observedDuringTurnId: 'another-turn',
      }),
    );
    expect(mismatched.state.decisionPending).toBe(false);
    expect(mismatched.state.current).toEqual(opened.state.current);

    const unscopedAction = reduceChatTurn(
      mismatched.state,
      sessionState('requires_action', 5),
    );
    expect(unscopedAction.state.decisionPending).toBe(true);
    const repeatedAction = reduceChatTurn(
      unscopedAction.state,
      sessionState('requires_action', 6, {
        observedDuringTurnId: 'observed-turn',
      }),
    );
    expect(repeatedAction.state.decisionPending).toBe(true);
    expect(repeatedAction.state).toEqual({
      ...unscopedAction.state,
      cursors: { 'claude:epoch-1': 6 },
    });
    expect(repeatedAction.effects).toEqual([]);

    const matchingRunning = reduceChatTurn(
      repeatedAction.state,
      sessionState('running', 7, {
        observedDuringTurnId: 'observed-turn',
      }),
    );
    expect(matchingRunning.state.decisionPending).toBe(false);
    const repeatedRunning = reduceChatTurn(
      matchingRunning.state,
      sessionState('running', 8),
    );
    expect(repeatedRunning.state.decisionPending).toBe(false);
    expect(repeatedRunning.state).toEqual({
      ...matchingRunning.state,
      cursors: { 'claude:epoch-1': 8 },
    });
    expect(repeatedRunning.effects).toEqual([]);
  });

  it('ignores idle and reconnecting observations without changing decisionPending or the open turn', () => {
    const opened = reduceChatTurn(
      initialChatTurnState(),
      turnStarted('waiting-turn', 1, { startedAtMs: 100 }),
    );
    const waiting = reduceChatTurn(
      opened.state,
      sessionState('requires_action', 2, {
        observedDuringTurnId: 'waiting-turn',
      }),
    );
    const idle = reduceChatTurn(
      waiting.state,
      sessionState('idle', 3, { observedDuringTurnId: 'waiting-turn' }),
    );
    const reconnecting = reduceChatTurn(
      idle.state,
      sessionState('reconnecting', 4, {
        observedDuringTurnId: 'waiting-turn',
      }),
    );

    expect(idle.state.decisionPending).toBe(true);
    expect(reconnecting.state.decisionPending).toBe(true);
    expect(reconnecting.state.current).toEqual(waiting.state.current);
    expect(idle.effects).toEqual([]);
    expect(reconnecting.effects).toEqual([]);
  });
});

describe('background work and phase projection', () => {
  it('replaces native and managed background state and emits idle on background-to-idle', () => {
    const firstNative: BackgroundSet['native'] = [
      {
        id: 'native-one',
        taskType: 'agent',
        toolUseId: 'tool-one',
        spawnedByTurnId: 'parent-turn',
      },
    ];
    const first = reduceChatTurn(
      initialChatTurnState(),
      backgroundSet(1, {
        native: firstNative,
        managed: { live: 2, queued: 3 },
      }),
    );
    expect(first.state.background).toEqual({
      native: firstNative,
      managed: { live: 2, queued: 3 },
    });
    expect(first.state.phase).toBe('background');
    expect(first.effects).toEqual([]);

    const replacementNative: BackgroundSet['native'] = [
      { id: 'native-two', taskType: 'worker' },
    ];
    const replacement = reduceChatTurn(
      first.state,
      backgroundSet(2, {
        native: replacementNative,
        managed: { live: 0, queued: 1 },
      }),
    );
    expect(replacement.state.background).toEqual({
      native: replacementNative,
      managed: { live: 0, queued: 1 },
    });
    expect(replacement.state.phase).toBe('background');
    expect(replacement.effects).toEqual([]);

    const cleared = reduceChatTurn(
      replacement.state,
      backgroundSet(3, { native: [], managed: { live: 0, queued: 0 } }),
    );
    expect(cleared.state.background).toEqual({
      native: [],
      managed: { live: 0, queued: 0 },
    });
    expect(cleared.state.phase).toBe('idle');
    expect(cleared.effects).toEqual([{ type: 'chat.idle' }]);
  });

  it('is foreground exactly while a turn is current and otherwise reflects background work', () => {
    const opened = reduceChatTurn(
      initialChatTurnState(),
      turnStarted('foreground-turn', 1, { startedAtMs: 100 }),
    );
    const workWhileForeground = reduceChatTurn(
      opened.state,
      backgroundSet(2, {
        native: [{ id: 'native-task' }],
        managed: { live: 1, queued: 0 },
      }),
    );
    expect(workWhileForeground.state.phase).toBe('foreground');

    const ended = reduceChatTurn(
      workWhileForeground.state,
      turnEnded('foreground-turn', 3, {
        endedAtMs: 300,
        durationMs: 200,
      }),
    );
    expect(ended.state.current).toBeUndefined();
    expect(ended.state.phase).toBe('background');
    expect(ended.effects).not.toContainEqual({ type: 'chat.idle' });

    const idle = reduceChatTurn(
      ended.state,
      backgroundSet(4, { native: [], managed: { live: 0, queued: 0 } }),
    );
    expect(idle.state.phase).toBe('idle');
    expect(idle.effects).toEqual([{ type: 'chat.idle' }]);

    const background = reduceChatTurn(
      idle.state,
      backgroundSet(5, { managed: { live: 0, queued: 1 } }),
    );
    expect(background.state.phase).toBe('background');
    const foregroundAgain = reduceChatTurn(
      background.state,
      turnStarted('next-foreground', 6, { startedAtMs: 600 }),
    );
    expect(foregroundAgain.state.current?.id).toBe('next-foreground');
    expect(foregroundAgain.state.phase).toBe('foreground');
  });
});

describe('state ownership', () => {
  it('preserves catchingUp and never mutates supplied state or event objects', () => {
    const catchingUp: ChatTurnState = {
      ...initialChatTurnState(),
      catchingUp: true,
    };
    const startedEvent = turnStarted('immutable-turn', 1, {
      startedAtMs: 100,
      userMessageIds: ['message-1'],
      spawnedBy: { taskId: 'task-1' },
    });
    const opened = reduceWithoutMutatingInputs(catchingUp, startedEvent);
    expect(opened.state.catchingUp).toBe(true);

    const native: BackgroundSet['native'] = [
      { id: 'native-one', taskType: 'agent' },
    ];
    const backgroundEvent = backgroundSet(2, {
      native,
      managed: { live: 1, queued: 2 },
    });
    const withBackground = reduceWithoutMutatingInputs(
      opened.state,
      backgroundEvent,
    );
    expect(withBackground.state.catchingUp).toBe(true);

    const endedEvent = turnEnded('immutable-turn', 3, {
      endedAtMs: 300,
      outcome: 'completed',
      durationMs: 200,
    });
    const ended = reduceWithoutMutatingInputs(withBackground.state, endedEvent);
    expect(ended.state.catchingUp).toBe(true);
  });
});
