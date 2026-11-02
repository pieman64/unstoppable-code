import type { ChatTurnLifecycleEvent } from '@canopy/protocol/canopy-core';
import { logMainProcessWarn } from '../../lib/main-process-logging';
import {
  armTurnLifecycleContinuation,
  getTurnLifecycleProducer,
  hasTurnLifecycleEnded,
  onTurnLifecycleSinkChange,
  releaseTurnLifecycleProducer,
  setTurnLifecycleClockForTests,
  setTurnLifecycleEndedLookup,
  setTurnLifecycleHostRestartLookup,
  setTurnLifecycleSink,
  type TurnEndedFields,
  type TurnLifecycleScope,
  type TurnStartedFields,
} from '../provider-turn-lifecycle';

jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

const scope: TurnLifecycleScope = {
  projectId: 'project',
  worktreeId: 'worktree',
  chatId: 'chat',
};

function startedFields(turnId: string): TurnStartedFields {
  return {
    turnId,
    origin: 'autonomous',
    binding: 'pending',
    submissionIds: [],
    userMessageIds: [],
    providerUserMessageUuids: [],
    phase: 'start',
    startedAtMs: 10,
  };
}

describe('provider-neutral turn lifecycle producer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setTurnLifecycleSink(null);
    setTurnLifecycleClockForTests(() => 1234);
  });

  afterEach(() => {
    setTurnLifecycleSink(null);
    setTurnLifecycleClockForTests(null);
    releaseTurnLifecycleProducer('claude', scope);
    releaseTurnLifecycleProducer('codex', scope);
  });

  it('stamps ordered events with provider-specific sequences that survive release', () => {
    const events: ChatTurnLifecycleEvent[] = [];
    setTurnLifecycleSink((event) => events.push(event));
    const claude = getTurnLifecycleProducer('claude', scope);
    const codex = getTurnLifecycleProducer('codex', scope);

    expect(getTurnLifecycleProducer('codex', { ...scope })).toBe(codex);
    claude.turnStarted(startedFields('claude-turn'));
    codex.turnStarted(startedFields('codex-turn'));
    codex.turnEnded({
      turnId: 'codex-turn',
      origin: 'autonomous',
      binding: 'pending',
      submissionIds: [],
      userMessageIds: [],
      providerUserMessageUuids: [],
      endedAtMs: 20,
      outcome: 'completed',
      source: 'turn-completed',
    });
    releaseTurnLifecycleProducer('codex', scope);
    getTurnLifecycleProducer('codex', scope).sessionState({
      state: 'reconnecting',
      source: 'provider',
    });

    expect(
      events.map(({ provider, sequence }) => [provider, sequence]),
    ).toEqual([
      ['claude', 1],
      ['codex', 1],
      ['codex', 2],
      ['codex', 3],
    ]);
    expect(events.map(({ eventId }) => eventId)).toHaveLength(4);
    expect(events[0]).toMatchObject({
      version: 1,
      provider: 'claude',
      ...scope,
      observedAtMs: 1234,
    });
  });

  it('uses a collision-free scope key', () => {
    const events: ChatTurnLifecycleEvent[] = [];
    setTurnLifecycleSink((event) => events.push(event));
    const first = { projectId: 'a|b', worktreeId: 'c', chatId: 'd' };
    const second = { projectId: 'a', worktreeId: 'b|c', chatId: 'd' };

    getTurnLifecycleProducer('codex', first).turnStarted(
      startedFields('first'),
    );
    getTurnLifecycleProducer('codex', second).turnStarted(
      startedFields('second'),
    );

    expect(events.map((event) => event.sequence)).toEqual([1, 1]);
  });

  it.each(['cursor', 'copilot'] as const)(
    'isolates %s producer scopes and preserves sequence after release',
    (provider) => {
      const events: ChatTurnLifecycleEvent[] = [];
      setTurnLifecycleSink((event) => events.push(event));
      const first = { ...scope, chatId: `${provider}-first` };
      const second = { ...scope, chatId: `${provider}-second` };
      const producer = getTurnLifecycleProducer(provider, first);
      producer.turnStarted(startedFields('turn'));
      getTurnLifecycleProducer(provider, second).turnStarted(
        startedFields('other-turn'),
      );
      releaseTurnLifecycleProducer(provider, first);
      const replacement = getTurnLifecycleProducer(provider, first);
      expect(replacement).not.toBe(producer);
      replacement.sessionState({ state: 'idle', source: 'provider' });
      expect(
        events.map(({ provider, chatId, sequence }) => [
          provider,
          chatId,
          sequence,
        ]),
      ).toEqual([
        [provider, first.chatId, 1],
        [provider, second.chatId, 1],
        [provider, first.chatId, 2],
      ]);
      releaseTurnLifecycleProducer(provider, first);
      releaseTurnLifecycleProducer(provider, second);
    },
  );

  it('drops events without a sink and does not buffer them', () => {
    const producer = getTurnLifecycleProducer('codex', {
      ...scope,
      chatId: 'no-sink-chat',
    });
    producer.turnStarted(startedFields('dropped'));
    const events: ChatTurnLifecycleEvent[] = [];
    setTurnLifecycleSink((event) => events.push(event));
    producer.turnStarted(startedFields('published'));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ turnId: 'published', sequence: 2 });
    releaseTurnLifecycleProducer('codex', { ...scope, chatId: 'no-sink-chat' });
  });

  it('catches and reports a throwing sink without throwing to its caller', () => {
    setTurnLifecycleSink(() => {
      throw new Error('sink failed');
    });

    expect(() =>
      getTurnLifecycleProducer('codex', scope).turnStarted(
        startedFields('turn'),
      ),
    ).not.toThrow();
    expect(logMainProcessWarn).toHaveBeenCalledWith(
      expect.stringContaining('Lifecycle sink failed'),
      expect.any(Error),
    );
  });

  it('rejects invalid events before the sink and reports validation once', () => {
    const events: ChatTurnLifecycleEvent[] = [];
    setTurnLifecycleSink((event) => events.push(event));
    const producer = getTurnLifecycleProducer('codex', scope);
    setTurnLifecycleClockForTests(() => Number.NaN);

    producer.turnStarted(startedFields('invalid'));
    producer.turnStarted(startedFields('also-invalid'));

    expect(events).toEqual([]);
    expect(logMainProcessWarn).toHaveBeenCalledTimes(1);
    expect(logMainProcessWarn).toHaveBeenCalledWith(
      expect.stringContaining('Invalid provider-neutral lifecycle event'),
      expect.anything(),
    );
  });

  it('notifies only when a sink is registered or cleared', () => {
    const changes: boolean[] = [];
    const unsubscribe = onTurnLifecycleSinkChange((registered) =>
      changes.push(registered),
    );
    setTurnLifecycleSink(() => undefined);
    setTurnLifecycleSink(() => undefined);
    setTurnLifecycleSink(null);
    setTurnLifecycleSink(null);
    unsubscribe();
    setTurnLifecycleSink(() => undefined);

    expect(changes).toEqual([true, false]);
  });

  it('tells a listener that registers after the sink that one is installed', () => {
    setTurnLifecycleSink(() => undefined);
    const changes: boolean[] = [];
    const unsubscribe = onTurnLifecycleSinkChange((registered) =>
      changes.push(registered),
    );
    setTurnLifecycleSink(null);
    unsubscribe();

    expect(changes).toEqual([true, false]);
  });
});

describe('ended-turn lookup', () => {
  afterEach(() => setTurnLifecycleEndedLookup(null));

  it("answers from the host's canonical state, and false without a usable host", () => {
    expect(hasTurnLifecycleEnded(scope, 'turn')).toBe(false);
    setTurnLifecycleEndedLookup(
      (lookupScope, turnId) =>
        lookupScope.chatId === scope.chatId && turnId === 'turn',
    );
    expect(hasTurnLifecycleEnded(scope, 'turn')).toBe(true);
    expect(hasTurnLifecycleEnded(scope, 'other')).toBe(false);
    setTurnLifecycleEndedLookup(() => {
      throw new Error('state unavailable');
    });
    expect(hasTurnLifecycleEnded(scope, 'turn')).toBe(false);
  });
});

describe('host restart continuations', () => {
  const ended = (
    turnId: string,
    outcome: 'completed' | 'cancelled',
  ): TurnEndedFields => ({
    turnId,
    origin: 'user',
    binding: 'bound',
    submissionIds: [],
    userMessageIds: ['prompt'],
    providerUserMessageUuids: [],
    endedAtMs: 20,
    outcome,
    terminalReason: 'Session aborted',
    source: 'abort-fallback',
  });
  let events: ChatTurnLifecycleEvent[];

  beforeEach(() => {
    events = [];
    setTurnLifecycleSink((event) => events.push(event));
  });

  afterEach(() => {
    setTurnLifecycleSink(null);
    armTurnLifecycleContinuation(scope, null);
    setTurnLifecycleHostRestartLookup(null);
    releaseTurnLifecycleProducer('claude', scope);
  });

  it('gives the armed cause to the next turn, through its binding, until it ends', () => {
    armTurnLifecycleContinuation(scope, {
      userMessageId: 'prompt',
      spawnedBy: { toolUseId: 'tool-load', toolsLoaded: true },
    });
    const producer = getTurnLifecycleProducer('claude', scope);
    producer.turnStarted(startedFields('continuation'));
    producer.turnStarted({
      ...startedFields('continuation'),
      origin: 'user',
      userMessageIds: ['prompt'],
      phase: 'binding-update',
    });
    producer.turnEnded(ended('continuation', 'completed'));
    producer.turnStarted(startedFields('later'));

    expect(
      events.flatMap((event) =>
        event.type === 'TurnStarted' ? [[event.turnId, event.spawnedBy]] : [],
      ),
    ).toEqual([
      ['continuation', { toolUseId: 'tool-load', toolsLoaded: true }],
      ['continuation', { toolUseId: 'tool-load', toolsLoaded: true }],
      ['later', undefined],
    ]);
  });

  it('gives no cause to a turn bound to another prompt, and disarms', () => {
    armTurnLifecycleContinuation(scope, {
      userMessageId: 'prompt',
      spawnedBy: { toolUseId: 'tool-load', toolsLoaded: true },
    });
    const producer = getTurnLifecycleProducer('claude', scope);
    producer.turnStarted({
      ...startedFields('other'),
      origin: 'user',
      userMessageIds: ['other-prompt'],
    });
    producer.turnStarted(startedFields('later'));

    expect(
      events.flatMap((event) =>
        event.type === 'TurnStarted' ? [event.spawnedBy] : [],
      ),
    ).toEqual([undefined, undefined]);
  });

  it("records the host's own session restart as a completed end, not a cancellation", () => {
    let restarting = true;
    setTurnLifecycleHostRestartLookup(() => restarting);
    const producer = getTurnLifecycleProducer('claude', scope);
    producer.turnEnded(ended('restarted', 'cancelled'));
    restarting = false;
    producer.turnEnded(ended('stopped', 'cancelled'));

    expect(
      events.flatMap((event) =>
        event.type === 'TurnEnded' ? [[event.turnId, event.outcome]] : [],
      ),
    ).toEqual([
      ['restarted', 'completed'],
      ['stopped', 'cancelled'],
    ]);
  });
});
