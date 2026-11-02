import {
  delegationTranscriptMessages,
  delegationRootMessages,
  isDelegatedAgentCallBlock,
  overlayStreamBackedDelegationCard,
} from '../delegation-transcript';
import type {
  AgentDelegationSnapshot,
  AgentDelegationTranscript,
} from '@canopy/protocol/delegation';
import {
  applyClaudeTranscriptEvent,
  applyCodexTranscriptEvent,
  parseAgentTranscriptLines,
  pauseOpenTurnTimer,
  resumePausedTurnTimer,
  type TranscriptReducerState,
  type TranscriptReducerOptions,
} from '../transcript-parser';
import {
  persistedParts,
  persistedMessageToPortalMessage,
  portalChatMessagesToPersisted,
} from '../../portal/persisted-chat-projection';

const routeSnapshot: AgentDelegationSnapshot['routeSnapshot'] = {
  selectedModelId: 'hidden-reviewer',
  runtimeModelId: 'runtime-review-model',
  selectedModelLabel: 'Retired reviewer',
  runtimeModelLabel: 'Review model',
  harnessId: 'third-harness',
  runtimeKind: 'local',
  runnerRegistrationId: 'runner',
  runtimeVersion: '1',
  adapterVersion: '1',
  modelSource: 'agent',
  providerType: 'custom',
  assignmentRevision: '1',
  billingAuthority: 'local',
  aiCreditsRouted: false,
  requestedThinkingLevel: 'high',
  effectiveThinkingLevel: 'medium',
  capabilities: [],
  supportedThinkingLevels: ['medium'],
  capabilitySnapshotHash: 'hash',
  capabilityGeneration: 1,
  policyRevision: '1',
};

function envelope(
  sequence = 1,
  status: AgentDelegationSnapshot['status'] = 'running',
): { type: string; delegation: AgentDelegationTranscript } {
  return {
    type: 'canopy_delegation',
    delegation: {
      delegationId: 'child-1',
      runGeneration: 1,
      sequence,
      parentHarnessId: 'claude',
      parentTurnId: 'user-1',
      parentToolCallId: 'call-1',
      createdAt: 1000,
      task: {
        description: 'Independent review',
        prompt: 'Read the source.',
        executionMode: 'background',
      },
      snapshot: {
        delegationId: 'child-1',
        status,
        routeSnapshot,
        nativeSessionId: 'child-native',
        outputTruncated: false,
        usage: { inputTokens: 40, outputTokens: 12 },
      },
      transcript: [
        {
          id: 'reason',
          type: 'thinking',
          text: 'Checking error paths.',
          sequence: 1,
          occurredAt: 1100,
        },
        {
          id: 'read',
          type: 'tool',
          toolName: 'Read',
          input: '{"path":"src/index.ts"}',
          output: 'source text',
          isError: false,
          sequence: 2,
          occurredAt: 1200,
        },
        {
          id: 'answer',
          type: 'text',
          text: 'Retain the original cause.',
          sequence: 3,
          occurredAt: 1300,
        },
      ],
    },
  };
}

describe('owned delegation transcript', () => {
  it('overlays only stream-backed cards without changing creation identity', () => {
    const block = delegationTranscriptMessages(envelope().delegation)[0]
      ?.blocks[0];
    if (!isDelegatedAgentCallBlock(block))
      throw new Error('Expected delegation card');
    const state = {
      version: 1 as const,
      status: 'completed' as const,
      resultIndex: 3,
      error: null,
      usage: null,
      workspaceRevision: null,
      workspaceDiscarded: false,
      stopOutcome: null,
      controlOutcome: null,
      attribution: null,
      capabilitySummary: null,
      nestedChildSummary: null,
      partialPreview: null,
      finalPreview: 'done',
    };
    expect(overlayStreamBackedDelegationCard(block, state)).toBe(block);
    const streamed = { ...block, transcriptStore: 'chat-stream-v2' as const };
    expect(overlayStreamBackedDelegationCard(streamed, state)).toMatchObject({
      agentBlockId: block.agentBlockId,
      status: 'completed',
      resultIndex: 3,
      finalText: 'done',
    });
  });
  it('drops an answer reference whose preview the descriptor state replaces', () => {
    const block = delegationTranscriptMessages(envelope().delegation)[0]
      ?.blocks[0];
    if (!isDelegatedAgentCallBlock(block))
      throw new Error('Expected delegation card');
    const card = {
      ...block,
      transcriptStore: 'chat-stream-v2' as const,
      partialText: 'stored partial preview',
      partialTextRef: answerRef('1'),
      finalText: 'stored final preview',
      finalTextRef: answerRef('2'),
    };
    const state = {
      version: 1 as const,
      status: 'completed' as const,
      resultIndex: 3,
      error: null,
      usage: null,
      workspaceRevision: null,
      workspaceDiscarded: false,
      stopOutcome: null,
      controlOutcome: null,
      attribution: null,
      capabilitySummary: null,
      nestedChildSummary: null,
      partialPreview: null,
      finalPreview: 'descriptor final preview',
    };
    const overlaid = overlayStreamBackedDelegationCard(card, state);
    expect(overlaid).toMatchObject({
      partialText: 'stored partial preview',
      partialTextRef: answerRef('1'),
      finalText: 'descriptor final preview',
    });
    expect(overlaid).not.toHaveProperty('finalTextRef');
    expect(
      overlayStreamBackedDelegationCard(card, {
        ...state,
        partialPreview: 'descriptor partial preview',
      }),
    ).not.toHaveProperty('partialTextRef');
  });
  it('accepts well-formed answer references and rejects malformed ones', () => {
    const card = delegationTranscriptMessages(envelope().delegation)[0]
      ?.blocks[0];
    expect(
      isDelegatedAgentCallBlock({
        ...card,
        partialText: 'preview',
        partialTextRef: answerRef('1'),
        finalText: 'preview',
        finalTextRef: answerRef('2'),
      }),
    ).toBe(true);
    for (const malformed of [
      { ...answerRef('1'), artifactId: '../escape' },
      { ...answerRef('1'), sha256: 'not-a-digest' },
      { ...answerRef('1'), byteLength: -1 },
      { ...answerRef('1'), encoding: 'latin1' },
      { ...answerRef('1'), extra: true },
      'sha256-v1-1',
    ]) {
      expect(
        isDelegatedAgentCallBlock({ ...card, partialTextRef: malformed }),
      ).toBe(false);
      expect(
        isDelegatedAgentCallBlock({ ...card, finalTextRef: malformed }),
      ).toBe(false);
    }
  });
  it('accepts a stream-backed card but rejects unknown stores', () => {
    const card = delegationTranscriptMessages(envelope().delegation)[0]
      ?.blocks[0];
    expect(card).toBeDefined();
    expect(isDelegatedAgentCallBlock(card)).toBe(true);
    expect(
      isDelegatedAgentCallBlock({ ...card, transcriptStore: 'chat-log-v1' }),
    ).toBe(true);
    expect(
      isDelegatedAgentCallBlock({ ...card, transcriptStore: 'chat-stream-v2' }),
    ).toBe(true);
    expect(
      isDelegatedAgentCallBlock({ ...card, transcriptStore: 'future-store' }),
    ).toBe(false);
  });
  it('projects authored text to user messages without losing author or delivery', () => {
    const authored = envelope().delegation;
    const user = { kind: 'user' as const };
    const agent = {
      kind: 'agent' as const,
      depth: 1,
      delegationId: 'parent',
      description: 'Review',
    };
    const messages = delegationTranscriptMessages({
      ...authored,
      transcript: [
        {
          id: 'u',
          type: 'text',
          sequence: 1,
          occurredAt: 2,
          text: 'User instruction',
          author: user,
          delivery: 'follow_up',
        },
        {
          id: 'a',
          type: 'text',
          sequence: 2,
          occurredAt: 3,
          text: 'Agent instruction',
          author: agent,
          delivery: 'steer',
        },
      ],
    });
    expect(messages[1]).toMatchObject({
      role: 'user',
      delegationAuthor: user,
      delegationDelivery: 'follow_up',
      blocks: [{ type: 'text', text: 'User instruction' }],
    });
    expect(messages[2]).toMatchObject({
      role: 'user',
      delegationAuthor: agent,
      delegationDelivery: 'steer',
    });
  });
  it('round-trips nested content and child timestamps through Portal import', () => {
    const original = envelope(2, 'completed');
    const nested = {
      ...original,
      delegation: {
        ...original.delegation,
        snapshot: {
          ...original.delegation.snapshot,
          depth: 2,
          parentDelegationId: 'parent-agent',
          parentDescription: 'Review API',
        },
      },
    };
    const state = parseAgentTranscriptLines([JSON.stringify(nested)], 'codex');
    const message = persistedMessageToPortalMessage({
      scope: 'worktree',
      chatId: 'chat',
      message: state.messages[0],
      relatedMessages: state.messages,
    });
    const restored = portalChatMessagesToPersisted([message]).messages;
    expect(restored).toEqual(state.messages);
    expect(JSON.stringify(restored)).toContain('"depth":2');
    expect(JSON.stringify(restored)).toContain(
      '"parentDelegationId":"parent-agent"',
    );
  });

  it('keeps who stopped a delegation on its card and through Portal import', () => {
    const cancelled = envelope(3, 'cancelled');
    const stoppedBy = {
      kind: 'agent' as const,
      depth: 1,
      delegationId: 'parent-agent',
      description: 'Review API',
    };
    const stopped = {
      ...cancelled,
      delegation: {
        ...cancelled.delegation,
        snapshot: {
          ...cancelled.delegation.snapshot,
          stopReason: 'stopped_by_parent' as const,
          cancelledByUser: false,
          stoppedBy,
          error: {
            code: 'terminated_by_parent' as const,
            message: "Stopped by its parent delegate 'Review API' (depth 1).",
            retryable: false,
          },
        },
      },
    };
    const state = parseAgentTranscriptLines(
      [JSON.stringify(stopped)],
      'claude',
    );
    const card = state.messages[0]?.blocks[0];
    expect(card).toMatchObject({
      type: 'delegated_agent_call',
      stopReason: 'stopped_by_parent',
      stoppedBy,
      error: { code: 'terminated_by_parent' },
    });
    const message = persistedMessageToPortalMessage({
      scope: 'worktree',
      chatId: 'chat',
      message: state.messages[0],
      relatedMessages: state.messages,
    });
    expect(portalChatMessagesToPersisted([message]).messages).toEqual(
      state.messages,
    );
  });

  it('merges compact sidecar patches without dropping earlier child activity', () => {
    const initial = envelope();
    const patch = envelope(2);
    const changed = {
      ...patch.delegation.transcript[2],
      text: 'Updated finding',
    };
    const event = {
      ...patch,
      delegation: {
        ...patch.delegation,
        transcriptMode: 'patch',
        transcript: [changed],
      },
    };
    const state = parseAgentTranscriptLines(
      [initial, event].map((value) => JSON.stringify(value)),
      'claude',
    );
    expect(state.messages).toHaveLength(4);
    expect(state.messages[1].blocks[0]).toMatchObject({ type: 'thinking' });
    expect(state.messages[3].blocks[0]).toMatchObject({
      text: 'Updated finding',
    });
  });

  for (const reduce of [
    applyClaudeTranscriptEvent,
    applyCodexTranscriptEvent,
  ]) {
    it('keeps child text, tools, thinking and usage separate from root identity', () => {
      const root: TranscriptReducerState = {
        messages: [
          {
            id: 'user-1',
            role: 'user',
            timestamp: 900,
            blocks: [{ type: 'text', text: 'Start the review.' }],
          },
        ],
        status: 'idle',
        error: null,
        planMode: false,
        sdkSessionId: 'parent-native',
      };
      const options: TranscriptReducerOptions = {
        childToolLiveness: { kind: 'unknown' },
        now: 9999,
        createMessageId: (): string => 'unused',
      };
      const state = reduce(root, envelope(), options);
      expect(state.sdkSessionId).toBe('parent-native');
      expect(state.status).toBe('idle');
      expect(state.usage).toBeUndefined();
      expect(state.messages[1]?.blocks[0]).toMatchObject({
        type: 'delegated_agent_call',
        targetHarnessId: 'third-harness',
        selectedModelId: 'hidden-reviewer',
        effectiveThinkingLevel: 'medium',
      });
      expect(state.messages.slice(2)).toMatchObject([
        {
          parentBlockId: 'delegated-agent-child-1',
          timestamp: 1100,
          blocks: [{ type: 'thinking' }],
        },
        {
          parentBlockId: 'delegated-agent-child-1',
          timestamp: 1200,
          blocks: [
            { type: 'tool_use' },
            { type: 'tool_result', output: 'source text' },
          ],
        },
        {
          parentBlockId: 'delegated-agent-child-1',
          timestamp: 1300,
          blocks: [{ type: 'text', text: 'Retain the original cause.' }],
        },
      ]);
      const completed = reduce(state, envelope(2, 'completed'), options);
      expect(reduce(completed, envelope(), options)).toBe(completed);
      expect(reduce(completed, envelope(2, 'completed'), options)).toBe(
        completed,
      );
      expect(completed.messages).toHaveLength(5);
    });

    it("keeps a user follow-up's run, which has no root turn, after the earlier run", () => {
      const options: TranscriptReducerOptions = {
        now: 9999,
        createMessageId: (): string => 'unused',
        childToolLiveness: { kind: 'unknown' },
      };
      const root: TranscriptReducerState = {
        messages: [
          {
            id: 'user-1',
            role: 'user',
            timestamp: 900,
            blocks: [{ type: 'text', text: 'Start the review.' }],
          },
        ],
        status: 'idle',
        error: null,
        planMode: false,
      };
      const firstRun = reduce(root, envelope(2, 'completed'), options);
      const later = {
        id: 'user-2',
        role: 'user' as const,
        timestamp: 3000,
        blocks: [{ type: 'text' as const, text: 'Another turn.' }],
      };
      const followUp = envelope(1, 'running');
      const state = reduce(
        { ...firstRun, messages: [...firstRun.messages, later] },
        {
          ...followUp,
          delegation: {
            ...followUp.delegation,
            runGeneration: 2,
            // A user follow-up has no root turn or tool call of its own.
            parentTurnId: 'user-stop',
            parentToolCallId: 'user-stop:operation',
            task: { ...followUp.delegation.task, prompt: 'Write two more.' },
          },
        },
        options,
      );
      expect(state.messages.map((message) => message.id)).toEqual([
        'user-1',
        'delegated-agent-child-1',
        ...firstRun.messages.slice(2).map((message) => message.id),
        'user-2',
        'delegated-agent-child-1-run-2',
        ...state.messages
          .filter(
            (message) =>
              message.parentBlockId === 'delegated-agent-child-1-run-2',
          )
          .map((message) => message.id),
      ]);
      expect(state.messages).not.toBe(firstRun.messages);
    });

    it('ignores a late delegation event after its originating turn was cleared', () => {
      const cleared: TranscriptReducerState = {
        messages: [
          {
            id: 'newer-user',
            role: 'user',
            timestamp: 2000,
            blocks: [{ type: 'text', text: 'A later retained turn.' }],
          },
        ],
        status: 'idle',
        error: null,
        planMode: false,
      };

      expect(
        reduce(cleared, envelope(2, 'completed'), {
          childToolLiveness: { kind: 'unknown' },
          now: 9999,
          createMessageId: (): string => 'unused',
        }),
      ).toBe(cleared);
    });
  }

  it.each([
    'completed',
    'failed',
    'cancelled',
    'interrupted',
    'deadline_exceeded',
  ] as const)('replays %s idempotently in either parent harness', (status) => {
    const lines = [envelope(), envelope(2, status), envelope(2, status)].map(
      (value) => JSON.stringify(value),
    );
    const claude = parseAgentTranscriptLines(lines, 'claude');
    const codex = parseAgentTranscriptLines(lines, 'codex');
    expect(claude.messages).toEqual(codex.messages);
    expect(claude.messages[0]?.blocks[0]).toMatchObject({
      type: 'delegated_agent_call',
      status,
    });
    expect(claude.skippedLineCount).toBe(0);
  });

  it('projects a retained delegation as a Portal agent part with route metadata', () => {
    const parsed = parseAgentTranscriptLines(
      [JSON.stringify(envelope(2, 'completed'))],
      'codex',
    );
    expect(parsed.messages.length).toBeGreaterThan(0);
    if (!parsed.messages[0]) return;
    expect(persistedParts(parsed.messages[0])[0]).toMatchObject({
      kind: 'agent',
      data: { delegation: { status: 'completed', routeSnapshot } },
    });
  });
});

it.each(['claude', 'codex'] as const)(
  'retains explicit hook provenance in %s prompt events',
  (harness) => {
    const parsed = parseAgentTranscriptLines(
      [
        JSON.stringify({
          type: 'canopy_user_prompt',
          canopy_turn_user_message_id: 'hook-prompt',
          canopy_user_message_source: 'hook',
          original_text: 'Run the build',
        }),
      ],
      harness,
    );
    expect(parsed.messages[0]).toMatchObject({ userMessageSource: 'hook' });
  },
);

it.each(['claude', 'codex'] as const)(
  'retains hidden delivery evidence without projecting it to %s UI history',
  (harness) => {
    const parsed = parseAgentTranscriptLines(
      [
        JSON.stringify({
          type: 'canopy_user_prompt',
          canopy_hidden: true,
          canopy_turn_user_message_id: 'hidden',
          original_text:
            '<system_instruction>A delegated task has finished</system_instruction>',
        }),
        JSON.stringify({
          type: 'canopy_injected_prompt',
          source: 'delegation',
          deliveryId: 'steered',
          original_text: 'steer evidence',
        }),
      ],
      harness,
    );
    expect(
      parsed.messages.filter((message) => message.role === 'user'),
    ).toHaveLength(1);
    expect(parsed.messages[0]).toMatchObject({ id: 'hidden', hidden: true });
    expect(
      delegationRootMessages(parsed.messages)
        .flatMap((message) => message.blocks)
        .filter((block) => block.type === 'text'),
    ).toEqual([]);
  },
);

it.each([applyClaudeTranscriptEvent, applyCodexTranscriptEvent])(
  'appends a continuation for hidden completion prompts without changing the settled timer',
  (reduce) => {
    const state: TranscriptReducerState = {
      status: 'idle',
      error: null,
      planMode: false,
      messages: [
        {
          id: 'user',
          role: 'user',
          timestamp: 1000,
          blocks: [{ type: 'text', text: 'Review' }],
        },
        {
          id: 'timer',
          role: 'system',
          timestamp: 1000,
          blocks: [
            {
              type: 'turn_timer',
              startedAt: 1000,
              completedAt: 4000,
              accumulatedPausedDurationMs: 500,
            },
          ],
        },
      ],
    };
    let id = 0;
    const options: TranscriptReducerOptions = {
      childToolLiveness: { kind: 'unknown' },
      now: 9000,
      createMessageId: (): string => `new-${++id}`,
    };
    const event = {
      type: 'canopy_user_prompt',
      canopy_hidden: true,
      canopy_turn_user_message_id: 'delivery',
      original_text: 'Task finished',
    };
    const result = reduce(state, event, options);
    const timers = result.messages
      .flatMap((message) => message.blocks)
      .filter((block) => block.type === 'turn_timer');
    expect(timers).toEqual([
      state.messages[1].blocks[0],
      {
        type: 'turn_timer',
        startedAt: 1000,
        completedAt: null,
        pausedAt: 4000,
        accumulatedPausedDurationMs: 5500,
        resumedAt: 9000,
      },
    ]);
    expect(result.messages.find((message) => message.id === 'timer')).toBe(
      state.messages[1],
    );
    expect(reduce(result, event, options).messages).toEqual(result.messages);
    id = 0;
    const premerged = reduce(
      {
        ...state,
        messages: [
          ...state.messages,
          {
            id: 'delivery',
            role: 'user',
            hidden: true,
            timestamp: options.now,
            blocks: [{ type: 'text', text: 'Task finished' }],
          },
        ],
      },
      event,
      options,
    );
    expect(premerged.messages).toEqual(result.messages);
    const fallback = reduce({ ...state, messages: [] }, event, options);
    expect(
      fallback.messages
        .flatMap((message) => message.blocks)
        .filter((block) => block.type === 'turn_timer'),
    ).toHaveLength(1);
    const newer = reduce(
      {
        ...state,
        messages: [
          ...state.messages,
          {
            id: 'new-user',
            role: 'user',
            timestamp: 8000,
            blocks: [{ type: 'text', text: 'A new request' }],
          },
        ],
      },
      event,
      options,
    );
    expect(newer.messages[1]).toEqual(state.messages[1]);
    expect(
      newer.messages
        .flatMap((message) => message.blocks)
        .filter((block) => block.type === 'turn_timer'),
    ).toHaveLength(2);

    const visible = reduce(state, { ...event, canopy_hidden: false }, options);
    expect(
      visible.messages
        .flatMap((message) => message.blocks)
        .filter((block) => block.type === 'turn_timer'),
    ).toHaveLength(2);
    const steered = reduce(
      state,
      {
        type: 'canopy_injected_prompt',
        source: 'delegation',
        original_text: 'Task finished',
      },
      options,
    );
    expect(steered.messages[1]).toEqual(state.messages[1]);
  },
);

it.each([applyClaudeTranscriptEvent, applyCodexTranscriptEvent])(
  'releases owned pauses across repeated hidden deliveries and completes only the continuation',
  (reduce) => {
    let state: TranscriptReducerState = {
      status: 'idle',
      error: null,
      planMode: false,
      messages: [
        {
          id: 'user',
          role: 'user',
          timestamp: 1000,
          blocks: [{ type: 'text', text: 'Review' }],
        },
        {
          id: 'timer',
          role: 'system',
          timestamp: 1000,
          blocks: [
            {
              type: 'turn_timer',
              startedAt: 1000,
              completedAt: 4000,
              accumulatedPausedDurationMs: 500,
            },
          ],
        },
      ],
    };
    const original = state.messages[1];
    let nextId = 0;
    const options = (now: number): TranscriptReducerOptions => ({
      childToolLiveness: { kind: 'unknown' },
      now,
      createMessageId: () => `next-${++nextId}`,
    });
    const hidden = (now: number): void => {
      state = reduce(
        state,
        {
          type: 'canopy_user_prompt',
          canopy_hidden: true,
          canopy_turn_user_message_id: `hidden-${now}`,
          original_text: 'Delegate finished',
        },
        options(now),
      );
    };
    const finish = (now: number): void => {
      state = reduce(
        state,
        reduce === applyClaudeTranscriptEvent
          ? { type: 'result', subtype: 'success', is_error: false }
          : { type: 'turn.completed' },
        options(now),
      );
    };
    const timer = (): unknown =>
      state.messages
        .filter((m) => m.blocks.some((b) => b.type === 'turn_timer'))
        .at(-1)?.blocks[0];
    hidden(9000);
    for (const [pause, release] of [
      [10000, 11000],
      [12000, 13000],
    ]) {
      const owner = `approval:${pause}`;
      state.messages = pauseOpenTurnTimer(state.messages, pause, owner);
      state.messages = resumePausedTurnTimer(state.messages, release, owner);
      expect(timer()).toMatchObject({ resumedAt: release });
      expect(timer()).not.toHaveProperty('pauseOwnerIds');
    }
    finish(14000);
    hidden(16000);
    state.messages = pauseOpenTurnTimer(
      state.messages,
      17000,
      'approval:first',
    );
    state.messages = pauseOpenTurnTimer(
      state.messages,
      17500,
      'question:pending',
    );
    state.messages = pauseOpenTurnTimer(
      state.messages,
      18000,
      'approval:second',
    );
    const paused = timer();
    hidden(18500);
    expect(timer()).toBe(paused);
    state.messages = resumePausedTurnTimer(
      state.messages,
      19000,
      'approval:first',
    );
    expect(timer()).toMatchObject({
      resumedAt: null,
      pauseOwnerIds: ['question:pending', 'approval:second'],
    });
    state.messages = resumePausedTurnTimer(
      state.messages,
      20000,
      'approval:second',
    );
    finish(21000);
    expect(timer()).toMatchObject({
      completedAt: null,
      resumedAt: null,
      pauseOwnerIds: ['question:pending'],
    });
    // Model completion must not clear the independent question owner.
    state.messages = resumePausedTurnTimer(
      state.messages,
      22000,
      'question:pending',
    );
    finish(23000);
    expect(timer()).toEqual({
      type: 'turn_timer',
      startedAt: 1000,
      completedAt: 23000,
      pausedAt: 17000,
      resumedAt: 22000,
      accumulatedPausedDurationMs: 14500,
    });
    expect(
      state.messages
        .flatMap((m) => m.blocks)
        .filter((b) => b.type === 'turn_timer'),
    ).toHaveLength(3);
    expect(state.messages.find((m) => m.id === 'timer')).toBe(original);
    expect(state.messages.filter((m) => m.hidden)).toHaveLength(3);
    const restored = JSON.parse(
      JSON.stringify(state.messages),
    ) as typeof state.messages;
    expect(
      restored
        .filter((m) => m.blocks.some((b) => b.type === 'turn_timer'))
        .at(-1)?.blocks[0],
    ).toEqual(timer());
  },
);

it.each([applyClaudeTranscriptEvent, applyCodexTranscriptEvent])(
  'uses collision-safe continuation ids and keeps replay timestamps out of timer accounting',
  (reduce) => {
    const state: TranscriptReducerState = {
      status: 'idle',
      error: null,
      planMode: false,
      messages: [
        {
          id: 'user',
          role: 'user',
          timestamp: 1000,
          blocks: [{ type: 'text', text: 'Review' }],
        },
        {
          id: 'timer',
          role: 'system',
          timestamp: 1000,
          blocks: [
            {
              type: 'turn_timer',
              startedAt: 1000,
              completedAt: 4000,
              accumulatedPausedDurationMs: 500,
            },
          ],
        },
        {
          id: 'timer:1',
          role: 'assistant',
          timestamp: 4000,
          blocks: [{ type: 'text', text: 'Done' }],
        },
      ],
    };
    const event = {
      type: 'canopy_user_prompt',
      canopy_hidden: true,
      user_message_id: 'timer:2',
      original_text: 'Watcher fired',
    };
    const options: TranscriptReducerOptions = {
      childToolLiveness: { kind: 'unknown' },
      now: 9000,
      createMessageId: (): string => 'timer',
    };
    const next = reduce(state, event, options);
    expect(next.messages.map((m) => m.id)).toEqual([
      'user',
      'timer',
      'timer:1',
      'timer:2',
      'timer:3',
    ]);
    expect(next.messages[1]).toBe(state.messages[1]);
    const repeated = reduce(
      next,
      { ...event, user_message_id: 'another' },
      { ...options, now: 11000 },
    );
    expect(
      repeated.messages.filter((m) =>
        m.blocks.some((b) => b.type === 'turn_timer'),
      ),
    ).toHaveLength(2);
    expect(repeated.messages.find((m) => m.id === 'timer:3')).toBe(
      next.messages[4],
    );
    const replay = reduce(state, event, {
      ...options,
      now: 7,
      useNowAsTurnTimestamp: false,
    });
    expect(replay.messages[1]).toBe(state.messages[1]);
    expect(replay.messages.at(-1)?.blocks).toEqual([
      {
        type: 'turn_timer',
        startedAt: 1000,
        completedAt: null,
        accumulatedPausedDurationMs: 500,
      },
    ]);
    expect(
      reduce(state, event, { ...options, now: 7, useNowAsTurnTimestamp: false })
        .messages,
    ).toEqual(replay.messages);
    const completed = reduce(
      replay,
      reduce === applyClaudeTranscriptEvent
        ? { type: 'result', subtype: 'success', completed_at: 12000 }
        : { type: 'turn.completed', completed_at: 12000 },
      { ...options, now: 8, useNowAsTurnTimestamp: false },
    );
    expect(completed.messages[1]).toBe(state.messages[1]);
    expect(completed.messages.at(-1)?.blocks[0]).toMatchObject({
      completedAt: 12000,
    });
  },
);

function answerRef(digit: string): {
  version: 1;
  artifactId: string;
  byteLength: number;
  sha256: string;
  encoding: 'utf-8';
  mediaType: 'text/plain';
} {
  return {
    version: 1,
    artifactId: `sha256-v1-${digit.repeat(64)}`,
    byteLength: 70_000,
    sha256: digit.repeat(64),
    encoding: 'utf-8',
    mediaType: 'text/plain',
  };
}
