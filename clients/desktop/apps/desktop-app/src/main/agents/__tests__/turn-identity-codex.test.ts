import type { ChatTurnLifecycleEvent } from '@canopy/protocol/canopy-core';
import {
  getTurnLifecycleProducer,
  releaseTurnLifecycleProducer,
  setTurnLifecycleSink,
} from '../provider-turn-lifecycle';
import {
  CodexTurnLifecycleTracker,
  type CodexTurnLifecycleObservation,
} from '../codex-turn-lifecycle';

const scope = {
  projectId: 'turn-identity-project',
  worktreeId: 'turn-identity-worktree',
  chatId: 'turn-identity-codex',
};

describe('Codex producer turn identity baseline', () => {
  let events: ChatTurnLifecycleEvent[];
  let tracker: CodexTurnLifecycleTracker;

  beforeEach(() => {
    events = [];
    tracker = new CodexTurnLifecycleTracker(
      getTurnLifecycleProducer('codex', scope),
    );
    setTurnLifecycleSink((event) => events.push(event));
  });

  afterEach(() => {
    setTurnLifecycleSink(null);
    releaseTurnLifecycleProducer('codex', scope);
  });

  function observe(observation: CodexTurnLifecycleObservation): void {
    tracker.observe(observation);
  }

  it('ordinary send uses the native turn id as T and the dispatched message id as A', () => {
    observe({
      type: 'turn-started',
      threadId: 'native-thread',
      turnId: 'native-turn-ordinary',
      origin: 'user',
      submissionId: 'submission-ordinary',
      userMessageId: 'message-ordinary',
      startedAtMs: 10,
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'TurnStarted',
        providerSessionId: 'native-thread',
        turnId: 'native-turn-ordinary',
        origin: 'user',
        binding: 'bound',
        submissionIds: ['submission-ordinary'],
        userMessageIds: ['message-ordinary'],
      }),
    );
  });

  it('autonomous wake uses its native T without inventing a bound A', () => {
    observe({
      type: 'turn-started',
      threadId: 'wake-thread',
      turnId: 'native-wake-turn',
      origin: 'autonomous',
      startedAtMs: 10,
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'TurnStarted',
        providerSessionId: 'wake-thread',
        turnId: 'native-wake-turn',
        origin: 'autonomous',
        binding: 'unbound',
        submissionIds: [],
        userMessageIds: [],
      }),
    );
  });

  it('merged start keeps native T and the first A while appending the second bound input', () => {
    const first: Extract<
      CodexTurnLifecycleObservation,
      { type: 'turn-started' }
    > = {
      type: 'turn-started',
      threadId: 'merged-thread',
      turnId: 'native-merged-turn',
      origin: 'user',
      submissionId: 'submission-first',
      userMessageId: 'message-first',
      startedAtMs: 10,
    };
    observe(first);
    observe({
      ...first,
      merged: true,
      submissionId: 'submission-second',
      userMessageId: 'message-second',
    });

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: 'TurnStarted',
      phase: 'binding-update',
      providerSessionId: 'merged-thread',
      turnId: 'native-merged-turn',
      submissionIds: ['submission-first', 'submission-second'],
      userMessageIds: ['message-first', 'message-second'],
    });
    expect(events.filter((event) => event.type === 'TurnStarted')).toHaveLength(
      2,
    );
  });

  it('restart keeps a fresh native T unbound while its retained output anchor stays outside input membership', () => {
    // Retained execution A is output placement, never a user input; the app-server suite proves its provenance survives restart.
    observe({
      type: 'turn-started',
      threadId: 'recovery-thread',
      turnId: 'native-turn-before-recovery',
      origin: 'user',
      submissionId: 'submission-original',
      userMessageId: 'message-original',
      startedAtMs: 10,
    });
    observe({
      type: 'turn-completed',
      threadId: 'recovery-thread',
      turnId: 'native-turn-before-recovery',
      status: 'interrupted',
      completedAtMs: 20,
      durationMs: 10,
    });
    observe({
      type: 'turn-started',
      threadId: 'recovery-thread',
      turnId: 'native-turn-after-recovery',
      origin: 'restart',
      startedAtMs: 30,
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'TurnEnded',
        turnId: 'native-turn-before-recovery',
        outcome: 'cancelled',
        userMessageIds: ['message-original'],
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'TurnStarted',
        turnId: 'native-turn-after-recovery',
        origin: 'restart',
        binding: 'unbound',
        submissionIds: [],
        userMessageIds: [],
      }),
    );
  });

  it('stopped resume ends the earlier native T and emits a new native T with the same A', () => {
    observe({
      type: 'turn-started',
      threadId: 'resume-thread',
      turnId: 'native-turn-stopped',
      origin: 'user',
      submissionId: 'submission-stopped',
      userMessageId: 'stopped-anchor',
      startedAtMs: 10,
    });
    observe({
      type: 'turn-completed',
      threadId: 'resume-thread',
      turnId: 'native-turn-stopped',
      status: 'interrupted',
      completedAtMs: 20,
      durationMs: 10,
    });
    observe({
      type: 'turn-started',
      threadId: 'resume-thread',
      turnId: 'native-turn-resumed',
      origin: 'user',
      submissionId: 'submission-resume',
      userMessageId: 'stopped-anchor',
      startedAtMs: 30,
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'TurnEnded',
        turnId: 'native-turn-stopped',
        outcome: 'cancelled',
        userMessageIds: ['stopped-anchor'],
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'TurnStarted',
        providerSessionId: 'resume-thread',
        turnId: 'native-turn-resumed',
        userMessageIds: ['stopped-anchor'],
      }),
    );
    expect('native-turn-resumed').not.toBe('native-turn-stopped');
  });
});
