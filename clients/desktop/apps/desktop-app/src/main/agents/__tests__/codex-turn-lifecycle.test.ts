import { logMainProcessWarn } from '../../lib/main-process-logging';
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

import {
  ChatTurnLifecycleEventSchema,
  type ChatTurnLifecycleEvent,
} from '@canopy/protocol/canopy-core';
import {
  getTurnLifecycleProducer,
  releaseTurnLifecycleProducer,
  setTurnLifecycleSink,
  type TurnLifecycleProducer,
} from '../provider-turn-lifecycle';

import {
  CodexTurnLifecycleTracker,
  type CodexTurnLifecycleObservation,
} from '../codex-turn-lifecycle';

type Observation = CodexTurnLifecycleObservation;

function createTracker(
  producer: TurnLifecycleProducer,
): CodexTurnLifecycleTracker {
  return new CodexTurnLifecycleTracker(producer);
}

const scope = {
  projectId: 'project',
  worktreeId: 'worktree',
  chatId: 'tracker',
};
const start: Extract<Observation, { type: 'turn-started' }> = {
  type: 'turn-started',
  threadId: 'root',
  turnId: 'turn',
  origin: 'user',
  submissionId: 'submission-1',
  userMessageId: 'message-1',
};

describe('Codex source turn lifecycle tracker', () => {
  let events: ChatTurnLifecycleEvent[];
  let producer: TurnLifecycleProducer;

  beforeEach(() => {
    events = [];
    producer = getTurnLifecycleProducer('codex', scope);
    setTurnLifecycleSink((event) => events.push(event));
  });

  afterEach(() => {
    setTurnLifecycleSink(null);
    releaseTurnLifecycleProducer('codex', scope);
  });

  it('backstops 64 distinct bound inputs and diagnoses a 65th without emitting or accepting further bindings', () => {
    const tracker = createTracker(producer);
    expect(tracker.observeWithPublishedBinding(start)).toMatchObject({
      turnId: 'turn',
      userMessageIds: ['message-1'],
    });
    for (let index = 2; index <= 64; index += 1) {
      tracker.observe({
        ...start,
        type: 'input-bound',
        userMessageId: `message-${index}`,
        submissionId: `submission-${index}`,
      });
    }
    expect(events).toHaveLength(64);
    tracker.observe({
      ...start,
      type: 'input-bound',
      userMessageId: 'message-64',
      submissionId: 'submission-64',
    });
    expect(events).toHaveLength(64);
    const overflowPublication = tracker.observeWithPublishedBinding({
      ...start,
      type: 'input-bound',
      userMessageId: 'message-65',
      submissionId: 'submission-65',
    });
    expect(overflowPublication).toBeUndefined();
    expect(events).toHaveLength(64);
    expect(logMainProcessWarn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        code: 'turn_binding_capacity_exceeded',
        turnId: 'turn',
        userMessageId: 'message-65',
      }),
    );
    tracker.observe({
      ...start,
      type: 'input-bound',
      userMessageId: 'message-1',
      submissionId: 'new-alias',
    });
    expect(events).toHaveLength(64);
    tracker.observe({
      type: 'turn-completed',
      threadId: 'root',
      turnId: 'turn',
      status: 'interrupted',
    });
    expect(events[64]).toMatchObject({
      type: 'TurnEnded',
      outcome: 'cancelled',
      userMessageIds: Array.from({ length: 64 }, (_, i) => `message-${i + 1}`),
    });
  });

  it('emits one validated bound start per native root tuple', () => {
    const tracker = createTracker(producer);
    tracker.observe(start);
    tracker.observe(start);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: 'codex',
      ...scope,
      providerSessionId: 'root',
      type: 'TurnStarted',
      phase: 'start',
      turnId: 'turn',
      origin: 'user',
      binding: 'bound',
      submissionIds: ['submission-1'],
      userMessageIds: ['message-1'],
      providerUserMessageUuids: [],
    });
    expect(ChatTurnLifecycleEventSchema.safeParse(events[0]).success).toBe(
      true,
    );
  });

  it('preserves zero-valued native lifecycle timings instead of falling back', () => {
    const tracker = createTracker(producer);
    const startWithZero: Extract<Observation, { type: 'turn-started' }> & {
      startedAtMs: number;
    } = { ...start, startedAtMs: 0 };
    const completionWithZero: Extract<
      Observation,
      { type: 'turn-completed' }
    > & {
      completedAtMs: number;
      durationMs: number;
    } = {
      type: 'turn-completed',
      threadId: 'root',
      turnId: 'turn',
      status: 'completed',
      completedAtMs: 0,
      durationMs: 0,
    };

    tracker.observe(startWithZero);
    tracker.observe(completionWithZero);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'TurnStarted', startedAtMs: 0 });
    expect(events[1]).toMatchObject({
      type: 'TurnEnded',
      endedAtMs: 0,
      durationMs: 0,
    });
  });

  it('leaves a completion without a native duration to the reducer', () => {
    const tracker = createTracker(producer);
    tracker.observe(start);
    tracker.observe({
      type: 'turn-completed',
      threadId: 'root',
      turnId: 'turn',
      status: 'completed',
    });
    expect(events[1]).toMatchObject({ type: 'TurnEnded', turnId: 'turn' });
    expect(events[1]).not.toHaveProperty('durationMs');
  });

  it('does not collapse equal turn ids from different root threads', () => {
    const tracker = createTracker(producer);
    tracker.observe(start);
    tracker.observe({ ...start, threadId: 'replacement' });
    expect(events).toHaveLength(2);
  });

  it('adds a merged input with one binding update and no second start', () => {
    const tracker = createTracker(producer);
    tracker.observe(start);
    const merged = {
      ...start,
      merged: true,
      submissionId: 'submission-2',
      userMessageId: 'message-2',
    };
    tracker.observe(merged);
    tracker.observe(merged);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: 'TurnStarted',
      phase: 'binding-update',
      submissionIds: ['submission-1', 'submission-2'],
      userMessageIds: ['message-1', 'message-2'],
      providerUserMessageUuids: [],
    });
  });

  it('publishes only a binding update when a recreated session joins a known-live turn', () => {
    const tracker = createTracker(producer);
    tracker.observe({ ...start, merged: true });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'TurnStarted',
      phase: 'binding-update',
      origin: 'user',
      binding: 'bound',
      submissionIds: ['submission-1'],
      userMessageIds: ['message-1'],
    });
    tracker.observe({
      type: 'turn-completed',
      threadId: 'root',
      turnId: 'turn',
      status: 'completed',
    });
    expect(events.filter((event) => event.type === 'TurnEnded')).toHaveLength(
      1,
    );
  });

  it('binds a picked-up input to an autonomous unbound wake', () => {
    const tracker = createTracker(producer);
    tracker.observe({
      type: 'turn-started',
      threadId: 'root',
      turnId: 'turn',
      origin: 'autonomous',
    });
    tracker.observe({ ...start, type: 'input-bound' });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      origin: 'autonomous',
      binding: 'unbound',
      submissionIds: [],
      userMessageIds: [],
      // A provider-started turn: Codex doesn't name the task that woke it.
      spawnedBy: {},
    });
    expect(events[1]).toMatchObject({
      phase: 'binding-update',
      binding: 'bound',
      submissionIds: ['submission-1'],
      userMessageIds: ['message-1'],
    });
  });

  it('publishes states without ending or closing a native turn', () => {
    const tracker = createTracker(producer);
    tracker.observe(start);
    for (const state of [
      'running',
      'requires_action',
      'idle',
      'reconnecting',
    ] as const) {
      tracker.observe({
        type: 'session-state',
        threadId: 'root',
        turnId: 'turn',
        state,
      });
    }
    expect(events.filter((event) => event.type === 'TurnEnded')).toEqual([]);
    const states = events.filter((event) => event.type === 'SessionState');
    expect(states.map((event) => event.state)).toEqual([
      'running',
      'requires_action',
      'idle',
      'reconnecting',
    ]);
    expect(
      states.every(
        (event) =>
          event.source === 'provider' && event.observedDuringTurnId === 'turn',
      ),
    ).toBe(true);
  });

  it.each([
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['interrupted', 'cancelled'],
  ] as const)(
    'maps %s to one %s terminal with final bindings',
    (status, outcome) => {
      const tracker = createTracker(producer);
      tracker.observe(start);
      tracker.observe({
        ...start,
        type: 'input-bound',
        submissionId: 'submission-2',
        userMessageId: 'message-2',
      });
      const terminal: Observation = {
        type: 'turn-completed',
        threadId: 'root',
        turnId: 'turn',
        status,
        ...(status === 'failed' ? { error: 'held detail' } : {}),
      };
      tracker.observe(terminal);
      tracker.observe(terminal);
      const terminals = events.filter((event) => event.type === 'TurnEnded');
      expect(terminals).toHaveLength(1);
      expect(terminals[0]).toMatchObject({
        source: 'turn-completed',
        outcome,
        submissionIds: ['submission-1', 'submission-2'],
        userMessageIds: ['message-1', 'message-2'],
        providerUserMessageUuids: [],
        ...(status === 'failed' ? { terminalReason: 'held detail' } : {}),
      });
      expect(ChatTurnLifecycleEventSchema.safeParse(terminals[0]).success).toBe(
        true,
      );
    },
  );

  it('ignores unknown terminals, completed-id merges and late pickup', () => {
    const tracker = createTracker(producer);
    tracker.observe(start);
    tracker.observe({
      type: 'turn-completed',
      threadId: 'child',
      turnId: 'turn',
      status: 'completed',
    });
    expect(events).toHaveLength(1);
    tracker.observe({
      type: 'turn-completed',
      threadId: 'root',
      turnId: 'turn',
      status: 'completed',
    });
    tracker.observe({ ...start, merged: true, submissionId: 'late' });
    tracker.observe({ ...start, type: 'input-bound', submissionId: 'late' });
    expect(events).toHaveLength(2);
  });

  it("ends an execution's open turn on its session terminal when turn/completed never arrived", () => {
    const tracker = createTracker(producer);
    tracker.observe(start);
    tracker.observe({
      type: 'execution-ended',
      userMessageId: 'other-message',
      status: 'failed',
    });
    expect(events).toHaveLength(1);
    tracker.observe({
      type: 'execution-ended',
      userMessageId: 'message-1',
      status: 'failed',
    });
    expect(events[1]).toMatchObject({
      type: 'TurnEnded',
      turnId: 'turn',
      providerSessionId: 'root',
      outcome: 'failed',
      source: 'result',
    });
    // A late native completion of the same turn is a no-op.
    tracker.observe({
      type: 'turn-completed',
      threadId: 'root',
      turnId: 'turn',
      status: 'completed',
    });
    expect(events).toHaveLength(2);
  });

  it('cancels every open turn, an unbound wake included, when its transport ends', () => {
    const tracker = createTracker(producer);
    tracker.observe({
      type: 'turn-started',
      threadId: 'root',
      turnId: 'wake',
      origin: 'autonomous',
    });
    tracker.closeOpenTurns();
    expect(events[1]).toMatchObject({
      type: 'TurnEnded',
      turnId: 'wake',
      outcome: 'cancelled',
      source: 'abort-fallback',
    });
    // The reducer derives the duration net of the turn's approval pauses.
    expect(events[1]).not.toHaveProperty('durationMs');
    tracker.closeOpenTurns();
    expect(events).toHaveLength(2);
  });

  it('starts a fresh restart execution when a native start reuses a turn this session ended', () => {
    const tracker = createTracker(producer);
    tracker.observe(start);
    tracker.observe({
      type: 'turn-completed',
      threadId: 'root',
      turnId: 'turn',
      status: 'completed',
    });
    tracker.observe({
      ...start,
      submissionId: 'submission-2',
      userMessageId: 'message-2',
    });
    expect(events[2]).toMatchObject({
      type: 'TurnStarted',
      phase: 'start',
      turnId: 'turn:restart-1',
      userMessageIds: ['message-2'],
    });
    tracker.observe({
      type: 'turn-completed',
      threadId: 'root',
      turnId: 'turn',
      status: 'completed',
    });
    expect(events[3]).toMatchObject({
      type: 'TurnEnded',
      turnId: 'turn:restart-1',
    });
  });

  it('starts a fresh restart execution for a merged start into a canonically ended turn', () => {
    const tracker = new CodexTurnLifecycleTracker(
      producer,
      (turnId) => turnId === 'turn' || turnId === 'turn:restart-1',
    );
    tracker.observe({
      ...start,
      merged: true,
      submissionId: 'submission-2',
      userMessageId: 'message-2',
    });
    expect(events[0]).toMatchObject({
      type: 'TurnStarted',
      phase: 'start',
      turnId: 'turn:restart-2',
      userMessageIds: ['message-2'],
    });
    tracker.observe({
      type: 'session-state',
      threadId: 'root',
      turnId: 'turn',
      state: 'requires_action',
    });
    expect(events[1]).toMatchObject({
      type: 'SessionState',
      observedDuringTurnId: 'turn:restart-2',
    });
  });

  it('times a restart execution from its own start, not the ended native turn', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(61_000);
    try {
      const tracker = new CodexTurnLifecycleTracker(
        producer,
        (turnId) => turnId === 'turn',
      );
      tracker.observe({
        ...start,
        merged: true,
        startedAtMs: 1_000,
        submissionId: 'submission-2',
        userMessageId: 'message-2',
      });
      expect(events[0]).toMatchObject({
        type: 'TurnStarted',
        turnId: 'turn:restart-1',
        startedAtMs: 61_000,
      });
      tracker.observe({
        type: 'turn-completed',
        threadId: 'root',
        turnId: 'turn',
        status: 'completed',
        completedAtMs: 62_000,
        durationMs: 61_000,
      });
      expect(events[1]).toMatchObject({
        type: 'TurnEnded',
        turnId: 'turn:restart-1',
        endedAtMs: 62_000,
      });
      // The native duration covers the ended native turn. The reducer times
      // the restart from its own start, net of its pauses.
      expect(events[1]).not.toHaveProperty('durationMs');
    } finally {
      now.mockRestore();
    }
  });

  it('names the execution of a native turn and the newest execution bound to an input', () => {
    const tracker = createTracker(producer);
    tracker.observe(start);
    tracker.observe({
      type: 'turn-completed',
      threadId: 'root',
      turnId: 'turn',
      status: 'interrupted',
    });
    tracker.observe({ ...start, turnId: 'resumed', submissionId: 'resume' });
    expect(tracker.executionTurnId('root', 'turn')).toBe('turn');
    expect(tracker.executionTurnId('root', 'resumed')).toBe('resumed');
    expect(tracker.executionTurnId('other-root', 'turn')).toBeUndefined();
    expect(tracker.latestExecutionTurnIdFor('message-1')).toBe('resumed');
    expect(tracker.latestExecutionTurnIdFor('unbound-message')).toBeUndefined();

    // A reused native id is a fresh execution under its restart id.
    tracker.observe({
      type: 'turn-completed',
      threadId: 'root',
      turnId: 'resumed',
      status: 'completed',
    });
    tracker.observe({
      ...start,
      turnId: 'turn',
      submissionId: 'submission-2',
      userMessageId: 'message-2',
    });
    expect(tracker.executionTurnId('root', 'turn')).toBe('turn:restart-1');
    expect(tracker.latestExecutionTurnIdFor('message-2')).toBe(
      'turn:restart-1',
    );
    expect(tracker.latestExecutionTurnIdFor('message-1')).toBe('resumed');
  });

  it('does not buffer while the shared sink is absent', () => {
    const tracker = createTracker(producer);
    setTurnLifecycleSink(null);
    tracker.observe(start);
    setTurnLifecycleSink((event) => events.push(event));
    tracker.observe({
      type: 'session-state',
      threadId: 'root',
      turnId: 'turn',
      state: 'running',
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'SessionState' });
  });
});
