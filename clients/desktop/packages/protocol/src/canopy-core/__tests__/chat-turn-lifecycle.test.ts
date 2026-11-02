import {
  BackgroundSetSchema,
  ChatTurnLifecycleEventSchema,
  ProducerBaseSchema,
  ClaudeLifecycleEventSchema,
  SessionStateSchema,
  TurnEndedSchema,
  TurnStartedSchema,
  isChatTurnLifecycleEvent,
  isClaudeLifecycleEvent,
  type ChatTurnLifecycleEvent,
  type ClaudeLifecycleEvent,
} from '..';

const base = {
  version: 1 as const,
  provider: 'claude' as const,
  projectId: 'project',
  worktreeId: 'worktree',
  chatId: 'chat',
  sequence: 1,
  eventId: 'event-1',
  observedAtMs: 100,
};

const binding = {
  turnId: 'turn-1',
  origin: 'user' as const,
  binding: 'bound' as const,
  submissionIds: ['submission-1'],
  userMessageIds: ['message-1'],
  providerUserMessageUuids: ['uuid-1'],
};

const events: ClaudeLifecycleEvent[] = [
  {
    ...base,
    ...binding,
    type: 'TurnStarted',
    phase: 'start',
    startedAtMs: 100,
  },
  {
    ...base,
    ...binding,
    type: 'TurnEnded',
    endedAtMs: 200,
    outcome: 'completed',
    source: 'result',
  },
  {
    ...base,
    type: 'SessionState',
    state: 'running',
    source: 'provider',
  },
  {
    ...base,
    type: 'BackgroundSet',
    semantics: 'replace',
    native: [{ id: 'task-1', taskType: 'agent', toolUseId: 'tool-1' }],
    managed: { live: 2, queued: 1 },
  },
];

describe('Claude turn lifecycle protocol schemas', () => {
  it.each(events)('accepts a valid $type event', (event) => {
    expect(ClaudeLifecycleEventSchema.safeParse(event).success).toBe(true);
    expect(isClaudeLifecycleEvent(event)).toBe(true);
  });

  it('exports validators for each event type', () => {
    expect(TurnStartedSchema.safeParse(events[0]).success).toBe(true);
    expect(TurnEndedSchema.safeParse(events[1]).success).toBe(true);
    expect(SessionStateSchema.safeParse(events[2]).success).toBe(true);
    expect(BackgroundSetSchema.safeParse(events[3]).success).toBe(true);
  });

  it.each([
    { ...events[0], version: 2 },
    { ...events[0], type: 'Unknown' },
    { ...events[0], turnId: undefined },
    { ...events[1], endedAtMs: undefined },
    { ...events[2], state: undefined },
    { ...events[3], managed: undefined },
  ])('rejects malformed lifecycle events', (event) => {
    expect(ClaudeLifecycleEventSchema.safeParse(event).success).toBe(false);
    expect(isClaudeLifecycleEvent(event)).toBe(false);
  });
});

describe('provider-neutral turn lifecycle protocol schemas', () => {
  it.each(['claude', 'codex', 'cursor', 'copilot', 'opencode'])(
    'accepts every event kind from %s',
    (provider) => {
      expect(ProducerBaseSchema.safeParse({ ...base, provider }).success).toBe(
        true,
      );
      for (const event of events) {
        const candidate = { ...event, provider };
        expect(ChatTurnLifecycleEventSchema.safeParse(candidate).success).toBe(
          true,
        );
        expect(isChatTurnLifecycleEvent(candidate)).toBe(true);
      }
    },
  );

  const codexEvents: ChatTurnLifecycleEvent[] = [
    {
      ...base,
      provider: 'codex',
      ...binding,
      type: 'TurnStarted',
      phase: 'start',
      startedAtMs: 100,
    },
    {
      ...base,
      provider: 'codex',
      ...binding,
      type: 'TurnEnded',
      endedAtMs: 200,
      outcome: 'completed',
      source: 'turn-completed',
    },
    {
      ...base,
      provider: 'codex',
      type: 'SessionState',
      state: 'reconnecting',
      source: 'provider',
    },
  ];

  it.each(codexEvents)('accepts a valid Codex $type event', (event) => {
    expect(ChatTurnLifecycleEventSchema.safeParse(event).success).toBe(true);
    expect(isChatTurnLifecycleEvent(event)).toBe(true);
  });

  it('rejects malformed Codex lifecycle events', () => {
    const malformed: unknown = { ...codexEvents[0], turnId: undefined };

    expect(ChatTurnLifecycleEventSchema.safeParse(malformed).success).toBe(
      false,
    );
    expect(isChatTurnLifecycleEvent(malformed)).toBe(false);
  });

  it('keeps Claude-named exports as aliases of the neutral contract', () => {
    expect(ClaudeLifecycleEventSchema).toBe(ChatTurnLifecycleEventSchema);
    expect(isClaudeLifecycleEvent).toBe(isChatTurnLifecycleEvent);
    const event: ClaudeLifecycleEvent | undefined = codexEvents[0];
    expect(event?.provider).toBe('codex');
  });
});
