import type { ClaudeLifecycleEvent } from '@canopy/protocol/canopy-core';
import {
  ClaudeTurnBindingTracker,
  getClaudeTurnLifecycleProducer,
  releaseClaudeTurnLifecycleProducer,
  setClaudeTurnLifecycleSink,
} from '../claude-turn-lifecycle';

const scope = {
  projectId: 'turn-identity-project',
  worktreeId: 'turn-identity-worktree',
  chatId: 'turn-identity-claude',
};

describe('Claude producer turn identity baseline', () => {
  let events: ClaudeLifecycleEvent[];
  const producer = getClaudeTurnLifecycleProducer(scope);

  beforeEach(() => {
    events = [];
    setClaudeTurnLifecycleSink((event) => events.push(event));
  });

  afterEach(() => {
    setClaudeTurnLifecycleSink(null);
    releaseClaudeTurnLifecycleProducer(scope);
  });

  function publishStart(
    binding: ReturnType<ClaudeTurnBindingTracker['openTurn']>,
    phase: 'start' | 'binding-update',
  ): void {
    producer.turnStarted({ ...binding, phase, startedAtMs: 10 });
  }

  it('ordinary send keeps the root-window UUID as T and binds the original A later by provider UUID', () => {
    const tracker = new ClaudeTurnBindingTracker();
    const rootWindowTurnId = '11111111-1111-4111-8111-111111111111';
    tracker.registerYielded('provider-wire-uuid', {
      submissionId: 'submission-1',
      userMessageId: 'message-1',
      kind: 'ordinary',
    });

    publishStart(tracker.openTurn(rootWindowTurnId), 'start');
    const binding = tracker.observeCommandStarted('provider-wire-uuid');
    if (binding) publishStart(binding, 'binding-update');

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'TurnStarted',
        turnId: rootWindowTurnId,
        phase: 'start',
        binding: 'pending',
        userMessageIds: [],
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'TurnStarted',
        turnId: rootWindowTurnId,
        phase: 'binding-update',
        binding: 'bound',
        submissionIds: ['submission-1'],
        userMessageIds: ['message-1'],
        providerUserMessageUuids: ['provider-wire-uuid'],
      }),
    );
    expect(rootWindowTurnId).not.toBe('message-1');
  });

  it('autonomous wake starts with its own root-window UUID and no bound message anchor', () => {
    const tracker = new ClaudeTurnBindingTracker();
    const rootWindowTurnId = '22222222-2222-4222-8222-222222222222';
    publishStart(tracker.openTurn(rootWindowTurnId), 'start');

    const binding = tracker.observeUserMessageUuids([
      'unmatched-provider-uuid',
    ]);
    if (binding) publishStart(binding, 'binding-update');
    const ended = tracker.sealAtResult({ originKind: 'autonomous' });
    if (!ended) throw new Error('Expected the autonomous turn to seal');
    producer.turnEnded({
      ...ended,
      source: 'result',
      outcome: 'completed',
      endedAtMs: 20,
      durationMs: 10,
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'TurnStarted',
        turnId: rootWindowTurnId,
        origin: 'autonomous',
        binding: 'pending',
        userMessageIds: [],
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'TurnEnded',
        turnId: rootWindowTurnId,
        origin: 'autonomous',
        binding: 'unbound',
        userMessageIds: [],
        providerUserMessageUuids: ['unmatched-provider-uuid'],
      }),
    );
  });

  it('merged steering keeps the live T and first A while appending the second input and its wire UUID', () => {
    const tracker = new ClaudeTurnBindingTracker();
    const rootWindowTurnId = '33333333-3333-4333-8333-333333333333';
    tracker.registerYielded('ordinary-wire-uuid', {
      submissionId: 'submission-1',
      userMessageId: 'message-1',
      kind: 'ordinary',
    });
    tracker.registerYielded('steer-wire-uuid', {
      submissionId: 'submission-2',
      userMessageId: 'message-2',
      kind: 'steer',
    });
    publishStart(tracker.openTurn(rootWindowTurnId), 'start');
    const ordinary = tracker.observeCommandStarted('ordinary-wire-uuid');
    if (ordinary) publishStart(ordinary, 'binding-update');
    const steering = tracker.observeCommandStarted('steer-wire-uuid');
    if (steering) publishStart(steering, 'binding-update');

    expect(events.filter((event) => event.type === 'TurnStarted')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          turnId: rootWindowTurnId,
          phase: 'binding-update',
          userMessageIds: ['message-1', 'message-2'],
          submissionIds: ['submission-1', 'submission-2'],
          providerUserMessageUuids: ['ordinary-wire-uuid', 'steer-wire-uuid'],
        }),
      ]),
    );
    expect(events.filter((event) => event.type === 'TurnStarted')).toHaveLength(
      3,
    );
  });

  it('internal query retry replay of the same wire UUID does not reopen or rebind the current T', () => {
    const tracker = new ClaudeTurnBindingTracker();
    const rootWindowTurnId = '44444444-4444-4444-8444-444444444444';
    tracker.registerYielded('replayed-wire-uuid', {
      submissionId: 'submission-1',
      userMessageId: 'message-1',
      kind: 'ordinary',
    });
    publishStart(tracker.openTurn(rootWindowTurnId), 'start');
    const firstEvidence = tracker.observeUserMessageUuids([
      'replayed-wire-uuid',
    ]);
    if (firstEvidence) publishStart(firstEvidence, 'binding-update');
    const replayEvidence = tracker.observeUserMessageUuids([
      'replayed-wire-uuid',
    ]);
    if (replayEvidence) publishStart(replayEvidence, 'binding-update');

    expect(replayEvidence).toBeUndefined();
    expect(events.filter((event) => event.type === 'TurnStarted')).toHaveLength(
      2,
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'TurnStarted',
        turnId: rootWindowTurnId,
        phase: 'binding-update',
        userMessageIds: ['message-1'],
        providerUserMessageUuids: ['replayed-wire-uuid'],
      }),
    );
  });

  it('stopped resume ends the old T, opens a fresh root-window T, and reuses the stopped A', () => {
    const stoppedTracker = new ClaudeTurnBindingTracker();
    const stoppedTurnId = '55555555-5555-4555-8555-555555555555';
    stoppedTracker.registerYielded('stopped-wire-uuid', {
      submissionId: 'stopped-submission',
      userMessageId: 'stopped-anchor',
      kind: 'ordinary',
    });
    publishStart(stoppedTracker.openTurn(stoppedTurnId), 'start');
    const stoppedBinding =
      stoppedTracker.observeCommandStarted('stopped-wire-uuid');
    if (stoppedBinding) publishStart(stoppedBinding, 'binding-update');
    const stopped = stoppedTracker.sealAtResult({});
    if (!stopped) throw new Error('Expected Stop to seal the prior turn');
    producer.turnEnded({
      ...stopped,
      source: 'abort-fallback',
      outcome: 'cancelled',
      endedAtMs: 20,
      durationMs: 10,
    });

    const resumedTracker = new ClaudeTurnBindingTracker();
    const resumedTurnId = '66666666-6666-4666-8666-666666666666';
    resumedTracker.registerYielded('resume-wire-uuid', {
      submissionId: 'resume-submission',
      userMessageId: 'stopped-anchor',
      kind: 'ordinary',
    });
    publishStart(resumedTracker.openTurn(resumedTurnId), 'start');
    const resumedBinding =
      resumedTracker.observeCommandStarted('resume-wire-uuid');
    if (resumedBinding) publishStart(resumedBinding, 'binding-update');

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'TurnEnded',
        turnId: stoppedTurnId,
        outcome: 'cancelled',
        userMessageIds: ['stopped-anchor'],
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'TurnStarted',
        turnId: resumedTurnId,
        phase: 'start',
        userMessageIds: [],
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'TurnStarted',
        turnId: resumedTurnId,
        phase: 'binding-update',
        userMessageIds: ['stopped-anchor'],
        providerUserMessageUuids: ['resume-wire-uuid'],
      }),
    );
    expect(resumedTurnId).not.toBe(stoppedTurnId);
  });

  it('preflights a UUID evidence frame at 64 and fails closed for the rest of T', () => {
    const tracker = new ClaudeTurnBindingTracker();
    tracker.openTurn('bounded-turn');
    for (let index = 0; index < 63; index += 1) {
      const uuid = `wire-${index}`;
      tracker.registerYielded(uuid, {
        submissionId: `submission-${index}`,
        userMessageId: `message-${index}`,
        kind: 'ordinary',
      });
      tracker.observeUserMessageUuids([uuid]);
    }
    const beforeOverflow = tracker.current();
    tracker.registerYielded('wire-63', {
      submissionId: 'submission-63',
      userMessageId: 'message-63',
      kind: 'ordinary',
    });
    tracker.registerYielded('wire-64', {
      submissionId: 'submission-64',
      userMessageId: 'message-64',
      kind: 'ordinary',
    });

    expect(
      tracker.observeUserMessageUuids(['wire-63', 'wire-64']),
    ).toBeUndefined();
    expect(tracker.current()).toEqual(beforeOverflow);
    expect(tracker.consumeBindingLimitExceeded()).toBe(2);

    expect(tracker.observeUserMessageUuids(['wire-63'])).toBeUndefined();
    expect(tracker.current()).toEqual(beforeOverflow);
    expect(tracker.consumeBindingLimitExceeded()).toBe(0);
  });

  it('preserves bounded offending UUID and input identifiers in the cap diagnostic', () => {
    const tracker = new ClaudeTurnBindingTracker();
    tracker.openTurn('diagnostic-turn');
    for (let index = 0; index < 63; index += 1) {
      const uuid = `wire-${index}`;
      tracker.registerYielded(uuid, {
        submissionId: `submission-${index}`,
        userMessageId: `message-${index}`,
        kind: 'ordinary',
      });
      tracker.observeUserMessageUuids([uuid]);
    }

    const offendingUuids: string[] = [];
    for (let index = 63; index < 73; index += 1) {
      const uuid = `wire-${index}`;
      offendingUuids.push(uuid);
      tracker.registerYielded(uuid, {
        submissionId: `submission-${index}`,
        userMessageId: `message-${index}`,
        kind: 'ordinary',
      });
    }

    expect(tracker.observeUserMessageUuids(offendingUuids)).toBeUndefined();
    expect(tracker.consumeBindingLimitDiagnostic()).toEqual({
      rejectedInputCount: 10,
      providerUserMessageUuids: [
        'wire-63',
        'wire-64',
        'wire-65',
        'wire-66',
        'wire-67',
        'wire-68',
        'wire-69',
        'wire-70',
      ],
      userMessageIds: [
        'message-63',
        'message-64',
        'message-65',
        'message-66',
        'message-67',
        'message-68',
        'message-69',
        'message-70',
      ],
      submissionIds: [
        'submission-63',
        'submission-64',
        'submission-65',
        'submission-66',
        'submission-67',
        'submission-68',
        'submission-69',
        'submission-70',
      ],
      truncated: true,
    });
    // Consuming the diagnostic is independent from the fail-closed latch.
    expect(tracker.observeUserMessageUuids(['wire-63'])).toBeUndefined();
    expect(tracker.consumeBindingLimitDiagnostic()).toBeUndefined();
  });
});
