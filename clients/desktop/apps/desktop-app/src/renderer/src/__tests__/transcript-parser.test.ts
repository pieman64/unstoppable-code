import subagentActivityEvents from '../../../../tests/electron/fixtures/codex-subagent-activity.json';
import packageConfig from '../../../../../../package.json';
import { parseModelPackageConfig } from '@canopy/desktop-shared/model-config';
import {
  applyClaudeTranscriptEvent as applyClaudeTranscriptEventWithLiveness,
  parseAgentTranscriptLines,
  createEmptyTranscriptReducerState,
  applyCodexTranscriptEvent as applyCodexTranscriptEventWithLiveness,
  buildTranscriptDisplayMessages,
  pauseOpenTurnTimer,
  resumePausedTurnTimer,
} from '../lib/transcript-parser';
import type {
  ChildToolLiveness,
  TranscriptReducerOptions,
  TranscriptReducerState,
} from '@canopy/agent-transcript';
import type { PersistedChatBlock } from '@canopy/agent-transcript/types';
import { codexItemOutputBody } from '@canopy/agent-transcript';
import {
  initAgentModels,
  initAiGatewayModels,
  initClaudeModels,
  initModelAliases,
} from '@canopy/desktop-shared/types';
import { measureDurationMs } from '../lib/perf-test-utils';
import { workGrowth } from '../../../../../../packages/protocol/src/__tests__/helpers/work-meter';
import {
  AI_CREDITS_NO_BILLING_SOURCE_EVENT_FLAG,
  AI_CREDITS_NO_BILLING_SOURCE_MESSAGE,
  AI_CREDITS_PROXY_ERROR_MARKER,
  parseCanopyProxyError,
} from '@canopy/protocol';

jest.setTimeout(15_000);

// These cases were written for the close-everything terminal behavior, which
// `no-live-session` keeps; liveness-specific cases live in the package tests.
type ReducerOptionsWithoutLiveness = Omit<
  TranscriptReducerOptions,
  'childToolLiveness'
> & { childToolLiveness?: ChildToolLiveness };

function withLiveness(
  options: ReducerOptionsWithoutLiveness,
): TranscriptReducerOptions {
  return { childToolLiveness: { kind: 'no-live-session' }, ...options };
}

function applyClaudeTranscriptEvent(
  state: TranscriptReducerState,
  event: Parameters<typeof applyClaudeTranscriptEventWithLiveness>[1],
  options: ReducerOptionsWithoutLiveness,
): TranscriptReducerState {
  return applyClaudeTranscriptEventWithLiveness(
    state,
    event,
    withLiveness(options),
  );
}

function applyCodexTranscriptEvent(
  state: TranscriptReducerState,
  event: Parameters<typeof applyCodexTranscriptEventWithLiveness>[1],
  options: ReducerOptionsWithoutLiveness,
): TranscriptReducerState {
  return applyCodexTranscriptEventWithLiveness(
    state,
    event,
    withLiveness(options),
  );
}

describe('Claude terminal error results', () => {
  it('preserves SDK errors when a turn limit result has no result field', () => {
    const next = applyClaudeTranscriptEvent(
      createEmptyTranscriptReducerState(),
      {
        type: 'result',
        subtype: 'error_max_turns',
        terminal_reason: 'max_turns',
        is_error: true,
        num_turns: 201,
        errors: ['Reached maximum number of turns (200)'],
      },
      { now: 7000, createMessageId: () => 'limit-error' },
    );
    expect(next.status).toBe('error');
    expect(next.error).toBe('Reached maximum number of turns (200)');
    expect(next.llmProviderUsageLimitBanner).toBeUndefined();
  });

  it('preserves execution errors and ignores empty or malformed errors', () => {
    const next = applyClaudeTranscriptEvent(
      createEmptyTranscriptReducerState(),
      {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: '',
        errors: [null, '', '  Execution failed  ', 3, 'Connection closed'],
      },
      { now: 7000, createMessageId: () => 'execution-error' },
    );
    expect(next.error).toBe('Execution failed\nConnection closed');
  });
});

describe('Cursor reported usage', () => {
  it('replays reported response counters without inventing a context limit or accumulating duplicates', () => {
    const event = {
      type: 'canopy_cursor_usage',
      provider: 'cursor',
      usage: {
        inputTokens: 12000,
        outputTokens: 800,
        cacheReadTokens: 9000,
        cacheWriteTokens: 500,
      },
    };
    const parsed = parseAgentTranscriptLines(
      [
        JSON.stringify(event),
        JSON.stringify(event),
        JSON.stringify({
          type: 'result',
          provider: 'cursor',
          is_error: false,
          result: '',
        }),
      ],
      'cursor',
    );
    expect(parsed.usage).toMatchObject({
      contextWindow: 0,
      cursorReportedUsage: event.usage,
    });
  });
});

describe('Codex startup failures', () => {
  it.each([applyClaudeTranscriptEvent, applyCodexTranscriptEvent])(
    'keeps a steered audit prompt inside its original turn when replayed',
    (reduce) => {
      let id = 0;
      const options = {
        now: 1000,
        createMessageId: (): string => `audit-${++id}`,
      };
      const initial = reduce(
        createEmptyTranscriptReducerState(),
        {
          type: 'canopy_user_prompt',
          original_text: 'Check this',
          canopy_turn_user_message_id: 'root',
        },
        options,
      );
      const event = {
        type: 'canopy_user_prompt',
        original_text: 'Check this',
        user_message_id: 'steered',
        steering: { startsTurn: false, rootUserMessageId: 'root' },
      };
      const steered = reduce(initial, event, { ...options, now: 2000 });
      expect(
        steered.messages
          .filter((message) => message.role === 'user')
          .map((message) => message.id),
      ).toEqual(['root', 'steered']);
      expect(
        steered.messages
          .flatMap((message) => message.blocks)
          .filter((block) => block.type === 'turn_timer'),
      ).toEqual(
        initial.messages
          .flatMap((message) => message.blocks)
          .filter((block) => block.type === 'turn_timer'),
      );
      expect(
        steered.messages.find((message) => message.id === 'steered')?.blocks,
      ).toContainEqual({
        type: 'text',
        text: 'Check this',
        steering: event.steering,
      });
      expect(reduce(steered, event, options).messages).toEqual(
        steered.messages,
      );
    },
  );
  const failure = {
    type: 'result',
    is_error: true,
    subtype: 'codex_error',
    result: 'thread example already has an active writer',
  };
  it.each([applyClaudeTranscriptEvent, applyCodexTranscriptEvent])(
    'persists a visible startup error and settles its timer',
    (reduce) => {
      let id = 0;
      const options = {
        now: 1000,
        createMessageId: (): string => `startup-${++id}`,
      };
      const initial = reduce(
        { ...createEmptyTranscriptReducerState(), providerType: 'codex' },
        {
          type: 'canopy_user_prompt',
          original_text: 'Continue',
          provider: 'codex',
        },
        options,
      );
      const failed = reduce(initial, failure, { ...options, now: 1500 });
      expect(failed.status).toBe('error');
      expect(
        failed.messages.flatMap((message) => message.blocks),
      ).toContainEqual(
        expect.objectContaining({ type: 'turn_timer', completedAt: 1500 }),
      );
      expect(
        failed.messages.flatMap((message) => message.blocks),
      ).toContainEqual(
        expect.objectContaining({
          type: 'text',
          text: `Error: ${failure.result}`,
        }),
      );
      expect(reduce(failed, failure, options).messages).toEqual(
        failed.messages,
      );
    },
  );
  it('does not repeat an already reported native turn failure', () => {
    const options = {
      now: 1000,
      createMessageId: (): string => 'native-error',
    };
    const failed = applyCodexTranscriptEvent(
      createEmptyTranscriptReducerState(),
      { type: 'turn.failed', error: { message: failure.result } },
      options,
    );
    expect(
      applyClaudeTranscriptEvent(failed, failure, options).messages,
    ).toEqual(failed.messages);
  });

  it('replays a synthetic startup failure from persisted Codex JSONL', () => {
    const parsed = parseAgentTranscriptLines(
      [
        JSON.stringify({
          type: 'canopy_user_prompt',
          provider: 'codex',
          original_text: 'Continue',
        }),
        JSON.stringify(failure),
      ],
      'codex',
    );

    expect(parsed.skippedLineCount).toBe(0);
    expect(parsed.messages.flatMap((message) => message.blocks)).toContainEqual(
      expect.objectContaining({
        type: 'text',
        text: `Error: ${failure.result}`,
      }),
    );
  });

  it('closes an in-progress tool when reporting a synthetic failure', () => {
    const failed = applyCodexTranscriptEvent(
      {
        ...createEmptyTranscriptReducerState(),
        status: 'streaming',
        messages: [
          {
            id: 'tool-message',
            role: 'assistant',
            timestamp: 100,
            blocks: [
              {
                type: 'tool_use',
                toolUseId: 'codex-command-startup',
                toolName: 'command',
                input: 'pwd',
              },
            ],
          },
        ],
      },
      failure,
      { now: 200, createMessageId: () => 'startup-closeout' },
    );

    expect(failed.messages.flatMap((message) => message.blocks)).toContainEqual(
      expect.objectContaining({
        type: 'tool_result',
        toolUseId: 'codex-command-startup',
        output: 'Cancelled',
      }),
    );
  });

  it('closes an in-progress tool when deduplicating a native failure', () => {
    const options = {
      now: 200,
      createMessageId: (): string => 'native-closeout',
    };
    let failed = applyCodexTranscriptEvent(
      {
        ...createEmptyTranscriptReducerState(),
        status: 'streaming',
        messages: [
          {
            id: 'tool-message',
            role: 'assistant',
            timestamp: 100,
            blocks: [
              {
                type: 'tool_use',
                toolUseId: 'codex-command-native',
                toolName: 'command',
                input: 'pwd',
              },
            ],
          },
        ],
      },
      { type: 'turn.failed', error: { message: failure.result } },
      options,
    );

    failed = applyCodexTranscriptEvent(failed, failure, options);

    expect(failed.messages.flatMap((message) => message.blocks)).toContainEqual(
      expect.objectContaining({
        type: 'tool_result',
        toolUseId: 'codex-command-native',
        output: 'Cancelled',
      }),
    );
    expect(
      failed.messages
        .flatMap((message) => message.blocks)
        .filter(
          (block) =>
            block.type === 'text' && block.text === `Error: ${failure.result}`,
        ),
    ).toHaveLength(1);
  });
});

describe('Codex supported output surfaces', () => {
  const png = 'data:image/png;base64,aGVsbG8=';
  function parse(item: Record<string, unknown>): PersistedChatBlock[] {
    return applyCodexTranscriptEvent(
      createEmptyTranscriptReducerState(),
      { type: 'item.completed', item: { id: 'output', ...item } },
      { now: 1000, createMessageId: () => 'message' },
    ).messages.flatMap((message) => message.blocks);
  }

  it('retains standalone function output without fabricating a tool invocation', () => {
    const blocks = parse({
      type: 'function_call_output',
      name: 'tests',
      output: '42 passed',
    });
    expect(blocks).toContainEqual({
      type: 'text',
      text: 'Tool output (tests)\n\n42 passed',
      verbatim: true,
    });
    expect(blocks.some((block) => block.type === 'tool_use')).toBe(false);
  });

  it.each([
    {
      type: 'dynamic_tool_call',
      tool: 'preview',
      status: 'completed',
      success: true,
      content_items: [{ type: 'inputImage', imageUrl: png }],
    },
    {
      type: 'mcp_tool_call',
      server: 'preview',
      tool: 'image',
      status: 'completed',
      result: {
        content: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }],
      },
    },
    {
      type: 'function_call_output',
      name: 'preview',
      output: [{ type: 'input_image', image_url: png }],
    },
  ])('preserves bounded inline images for $type', (item) => {
    expect(parse(item)).toContainEqual({
      type: 'image',
      path: '',
      dataUrl: png,
      alt: 'Tool output image',
    });
  });

  it('shows review transitions and ignores unrouteable activity notices', () => {
    expect(
      parse({ type: 'entered_review_mode', review: 'current changes' }),
    ).toContainEqual({ type: 'text', text: 'Review started: current changes' });
    expect(
      parse({
        type: 'sub_agent_activity',
        kind: 'completed',
        agent_path: '/root/tests',
      }),
    ).toEqual([]);
  });

  it('caps image count and never exposes encrypted output or metadata', () => {
    const blocks = parse({
      type: 'function_call_output',
      name: 'preview',
      output: [
        ...Array.from({ length: 8 }, () => ({
          type: 'input_image',
          image_url: png,
        })),
        { type: 'encrypted_content', encrypted_content: 'secret-payload' },
      ],
    });
    expect(blocks.filter((block) => block.type === 'image')).toHaveLength(4);
    const text = blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    expect(text).toContain('[encrypted output omitted]');
    expect(text).not.toContain('secret-payload');
  });

  it('keeps one async question on completion replay without duplicating its fallback', () => {
    const event = {
      type: 'item.completed',
      thread_id: 'root',
      turn_id: 'turn',
      item: {
        id: 'question',
        type: 'agent_message',
        text: 'Which scope?\n- Focused\n- Full',
        delivery: 'async',
        phase: 'final_answer',
        questions: [{ title: 'Which scope?', options: ['Focused', 'Full'] }],
      },
    };
    const options = { now: 1000, createMessageId: (): string => 'message' };
    const first = applyCodexTranscriptEvent(
      createEmptyTranscriptReducerState(),
      event,
      options,
    );
    const replay = applyCodexTranscriptEvent(first, event, options);
    expect(replay.messages).toHaveLength(1);
    const block = replay.messages[0]?.blocks[0];
    expect(block).toMatchObject({
      type: 'text',
      text: event.item.text,
      asyncQuestion: { questions: event.item.questions },
    });
    if (block?.type !== 'text' || !block.asyncQuestion)
      throw new Error('Missing async question block');
    expect(block.asyncQuestion.requestId).toMatch(/^codex-async-[a-z0-9-]+$/);
  });

  it('does not reopen a finished turn when an async question is replayed', () => {
    const options = { now: 1000, createMessageId: (): string => 'message' };
    const event = {
      type: 'item.completed',
      thread_id: 'root',
      turn_id: 'turn',
      item: {
        id: 'question',
        type: 'agent_message',
        text: 'Which scope?',
        delivery: 'async',
        questions: [{ title: 'Which scope?', options: null }],
      },
    };
    const questionState = applyCodexTranscriptEvent(
      createEmptyTranscriptReducerState(),
      event,
      options,
    );
    const state = {
      ...questionState,
      status: 'idle' as const,
      messages: [
        {
          id: 'user',
          role: 'user' as const,
          blocks: [{ type: 'text' as const, text: 'Start the task' }],
          timestamp: 100,
        },
        {
          id: 'timer',
          role: 'system' as const,
          blocks: [
            { type: 'turn_timer' as const, startedAt: 100, completedAt: 200 },
          ],
          timestamp: 100,
        },
        ...questionState.messages,
      ],
    };
    const replay = applyCodexTranscriptEvent(state, event, {
      ...options,
      now: 3000,
    });
    expect(replay.status).toBe(state.status);
    expect(replay.messages).toHaveLength(state.messages.length);
    expect(
      replay.messages
        .flatMap((message) => message.blocks)
        .filter(
          (block) =>
            block.type === 'turn_timer' && block.completedAt === undefined,
        ),
    ).toHaveLength(0);
  });

  it('preserves async question text without fabricating a blocking tool request', () => {
    const blocks = parse({
      type: 'agent_message',
      text: '',
      delivery: 'async',
      questions: [{ title: 'Which scope?', options: ['Focused', 'Full'] }],
    });
    const block = blocks.find(
      (candidate) => candidate.type === 'text' && candidate.asyncQuestion,
    );
    expect(block).toMatchObject({
      type: 'text',
      text: 'Which scope?\n- Focused\n- Full',
      asyncQuestion: {
        questions: [{ title: 'Which scope?', options: ['Focused', 'Full'] }],
      },
    });
    if (block?.type !== 'text' || !block.asyncQuestion)
      throw new Error('Missing async question block');
    expect(block.asyncQuestion.requestId).toMatch(/^codex-async-[a-z0-9-]+$/);
    expect(blocks.some((block) => block.type === 'tool_use')).toBe(false);
  });

  it('marks every async-question safety bound explicitly', () => {
    const blocks = parse({
      type: 'agent_message',
      text: '',
      delivery: 'async',
      questions: [
        {
          title: 'Q'.repeat(8_193),
          options: [
            'O'.repeat(2_049),
            ...Array.from({ length: 20 }, (_, index) => `option-${index}`),
          ],
        },
        { title: 'Second?', options: [] },
        { title: 'Third?', options: [] },
        { title: 'Fourth?', options: [] },
      ],
    });
    const text = blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    expect(text).toContain('[1 title char omitted]');
    expect(text).toContain('[1 option char omitted]');
    expect(text).toContain('[1 additional option omitted]');
    expect(text).toContain('[1 additional question omitted]');
    expect(text).not.toContain('Fourth?');
  });

  it.each([
    {
      action: {
        type: 'open_page',
        url: 'https://example.com/legacy-evidence',
      },
      expected: 'https://example.com/legacy-evidence',
    },
    {
      action: {
        type: 'openPage',
        url: 'https://example.com/evidence',
      },
      expected: 'https://example.com/evidence',
    },
    {
      action: {
        type: 'find_in_page',
        url: 'https://example.com',
        pattern: 'legacy evidence',
      },
      expected: 'legacy evidence',
    },
    {
      action: {
        type: 'findInPage',
        url: 'https://example.com',
        pattern: 'evidence',
      },
      expected: 'evidence',
    },
  ])('keeps app-server v2 $action.type web actions visible', (example) => {
    const block = parse({
      type: 'web_search',
      query: '',
      action: example.action,
    })[0];
    expect(block.type === 'tool_use' ? block.input : '').toContain(
      example.expected,
    );
  });

  it('marks truncated standalone function output explicitly', () => {
    const block = parse({
      type: 'function_call_output',
      name: 'tests',
      output: 'x'.repeat(64 * 1024 + 1),
    })[0];
    expect(
      (block.type === 'text' ? block.text : '').endsWith(
        '[additional output omitted]',
      ),
    ).toBe(true);
  });

  it.each([
    'https://tracking.example/pixel.png',
    'data:image/svg+xml;base64,PHN2Zy8+',
    'data:text/html;base64,aGVsbG8=',
    'data:image/png;base64,' + 'A'.repeat(2 * 1024 * 1024 + 4),
  ])('does not expose unsafe or oversized image sources', (imageUrl) => {
    expect(
      parse({
        type: 'dynamic_tool_call',
        tool: 'preview',
        content_items: [{ type: 'inputImage', imageUrl }],
        success: true,
      }).some((block) => block.type === 'image'),
    ).toBe(false);
  });
});

describe('owned turn-timer pauses', () => {
  const openTimerMessages = [
    {
      id: 'timer-1',
      role: 'system' as const,
      blocks: [
        { type: 'turn_timer' as const, startedAt: 1_000, completedAt: null },
      ],
      timestamp: 1_000,
    },
  ];

  it('resumes only after the final overlapping prompt releases its pause', () => {
    const questionPaused = pauseOpenTurnTimer(
      openTimerMessages,
      2_000,
      'question:question-1',
    );
    const bothPaused = pauseOpenTurnTimer(
      questionPaused,
      3_000,
      'approval:approval-1',
    );
    const approvalResolved = resumePausedTurnTimer(
      bothPaused,
      4_000,
      'approval:approval-1',
    );

    expect(approvalResolved[0].blocks[0]).toMatchObject({
      pausedAt: 2_000,
      resumedAt: null,
      pauseOwnerIds: ['question:question-1'],
    });

    const allResolved = resumePausedTurnTimer(
      approvalResolved,
      5_000,
      'question:question-1',
    );
    expect(allResolved[0].blocks[0]).toMatchObject({
      pausedAt: 2_000,
      resumedAt: 5_000,
      accumulatedPausedDurationMs: 3_000,
    });
    expect(allResolved[0].blocks[0]).not.toHaveProperty('pauseOwnerIds');
  });

  it('keeps a genuine user turn as a boundary for both pause and owner release', () => {
    const paused = pauseOpenTurnTimer(openTimerMessages, 2000, 'approval:old');
    const newer = [
      ...paused,
      {
        id: 'new-user',
        role: 'user' as const,
        timestamp: 3000,
        blocks: [{ type: 'text' as const, text: 'New request' }],
      },
    ];
    expect(pauseOpenTurnTimer(newer, 4000, 'approval:new')).toBe(newer);
    expect(resumePausedTurnTimer(newer, 5000, 'approval:old')).toBe(newer);
    const withTimer = [...newer, { ...openTimerMessages[0], id: 'timer-2' }];
    const next = pauseOpenTurnTimer(withTimer, 4000, 'approval:new');
    expect(next[0]).toBe(paused[0]);
    const released = resumePausedTurnTimer(next, 5000, 'approval:new');
    expect(released[0]).toBe(paused[0]);
    expect(released[released.length - 1].blocks[0]).toMatchObject({
      resumedAt: 5000,
    });
  });

  it('preserves an existing unowned pause until its legacy owner releases', () => {
    const legacyPaused = pauseOpenTurnTimer(openTimerMessages, 2_000);
    const approvalPaused = pauseOpenTurnTimer(
      legacyPaused,
      3_000,
      'approval:approval-1',
    );
    const approvalResolved = resumePausedTurnTimer(
      approvalPaused,
      4_000,
      'approval:approval-1',
    );

    expect(approvalResolved[0].blocks[0]).toMatchObject({
      pausedAt: 2_000,
      resumedAt: null,
      pauseOwnerIds: [expect.any(String)],
    });

    const legacyResolved = resumePausedTurnTimer(approvalResolved, 5_000);
    expect(legacyResolved[0].blocks[0]).toMatchObject({
      pausedAt: 2_000,
      resumedAt: 5_000,
      accumulatedPausedDurationMs: 3_000,
    });
    expect(legacyResolved[0].blocks[0]).not.toHaveProperty('pauseOwnerIds');
  });
});

function splitTranscriptLines(text: string): string[] {
  return text.split('\n');
}

function parseJsonArray(text: string): unknown[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error('Expected JSON array');
  }
  return parsed;
}

function serializeTranscript(events: unknown[]): string {
  if (events.length === 0) {
    return '';
  }

  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

function serializeCodexTranscript(events: unknown[]): string {
  if (events.length === 0) {
    return '';
  }

  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

function buildCodexPerformanceEvents(options: {
  turns: number;
  toolsPerTurn: number;
  commandOutputChars?: number;
  mcpToolsPerTurn?: number;
  mcpStructuredContentChars?: number;
}): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [
    { type: 'thread.started', thread_id: 'thread-perf' },
  ];

  for (let turnIndex = 0; turnIndex < options.turns; turnIndex += 1) {
    events.push({ type: 'turn.started' });

    for (let toolIndex = 0; toolIndex < options.toolsPerTurn; toolIndex += 1) {
      const aggregatedOutput =
        turnIndex === 0 &&
        toolIndex === options.toolsPerTurn - 1 &&
        options.commandOutputChars !== undefined
          ? 'x'.repeat(options.commandOutputChars)
          : `output-${String(turnIndex)}-${String(toolIndex)}`;

      events.push({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          id: `cmd-${String(turnIndex)}-${String(toolIndex)}`,
          command: `echo ${String(turnIndex)}-${String(toolIndex)}`,
          aggregated_output: aggregatedOutput,
          status: 'completed',
          exit_code: 0,
        },
      });
    }

    for (
      let toolIndex = 0;
      toolIndex < (options.mcpToolsPerTurn ?? 0);
      toolIndex += 1
    ) {
      const structuredContent =
        turnIndex === 0 &&
        toolIndex === 0 &&
        options.mcpStructuredContentChars !== undefined
          ? { payload: 'x'.repeat(options.mcpStructuredContentChars) }
          : { turnIndex, toolIndex };
      events.push({
        type: 'item.completed',
        item: {
          type: 'mcp_tool_call',
          id: `mcp-${String(turnIndex)}-${String(toolIndex)}`,
          server: 'github',
          tool: 'create_issue',
          arguments: { turnIndex, toolIndex },
          status: 'completed',
          result: {
            content: [
              {
                type: 'text',
                text: `mcp-output-${String(turnIndex)}-${String(toolIndex)}`,
              },
            ],
            structuredContent,
            _meta: { ignored: true },
          },
          error: null,
        },
      });
    }

    events.push({
      type: 'item.completed',
      item: {
        type: 'agent_message',
        id: `assistant-${String(turnIndex)}`,
        text: `Answer ${String(turnIndex)}`,
      },
    });
    events.push({
      type: 'turn.completed',
      usage: {
        input_tokens: 12,
        output_tokens: 8,
        cached_input_tokens: 2,
      },
    });
  }

  return events;
}

describe('transcript-parser', () => {
  beforeEach(() => {
    initClaudeModels([
      {
        id: 'fable[1m]',
        label: 'Fable 5 1M',
        contextWindow: 1_000_000,
      },
      {
        id: 'opus[1m]',
        label: 'Opus 4.8 1M',
        contextWindow: 1_000_000,
      },
    ]);
    initAiGatewayModels(
      [],
      [
        {
          modelId: 'opus[1m]',
          gatewayId: 'anthropic/claude-opus-5',
          family: 'anthropic',
          recommendedHarness: 'claude',
          gatewayOnly: false,
          contextWindow: 400_000,
          supportsPromptCaching: true,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'standard',
        },
      ],
    );
    initModelAliases({
      'claude-opus-4-7': 'opus[1m]',
      'claude-opus-4-8': 'opus[1m]',
    });
    initAgentModels([]);
  });

  afterEach(() => {
    initAgentModels([]);
  });

  it('parses Claude SDK transcript JSONL into display messages', () => {
    const transcript = serializeTranscript(
      parseJsonArray(`[
        {
          "type": "assistant",
          "message": {
            "content": [
              {
                "type": "tool_use",
                "id": "tool-1",
                "name": "Bash",
                "input": { "command": "pwd" }
              }
            ]
          }
        },
        {
          "type": "user",
          "message": {
            "content": [
              {
                "type": "tool_result",
                "tool_use_id": "tool-1",
                "content": "ok",
                "is_error": false
              }
            ]
          }
        },
        {
          "type": "assistant",
          "message": {
            "content": [
              {
                "type": "text",
                "text": "Finished successfully"
              }
            ]
          }
        },
        {
          "type": "result",
          "is_error": false,
          "result": "Finished successfully",
          "usage": {
            "input_tokens": 12,
            "output_tokens": 8,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0
          }
        }
      ]`),
    );

    const parsed = parseAgentTranscriptLines(splitTranscriptLines(transcript));

    expect(parsed.messages).toHaveLength(3);
    expect(parsed.displayMessages).toHaveLength(2);
    expect(parsed.displayMessages[0].blocks[0]).toMatchObject({
      type: 'tool_use',
      toolName: 'Bash',
      result: {
        output: 'ok',
        isError: false,
      },
    });
    expect(parsed.displayMessages[1].blocks[0]).toMatchObject({
      type: 'text',
      text: 'Finished successfully',
    });
  });

  it('keeps Claude result events streaming when the session continues', () => {
    const state = createEmptyTranscriptReducerState();
    const next = applyClaudeTranscriptEvent(
      state,
      {
        type: 'result',
        is_error: false,
        result: 'Waiting for monitor.',
        canopy_session_continues: true,
        usage: {
          input_tokens: 1,
          output_tokens: 2,
        },
      },
      {
        now: 123,
        createMessageId: () => 'msg-1',
      },
    );

    expect(next.status).toBe('streaming');
    expect(next.usage).toMatchObject({
      inputTokens: 1,
      outputTokens: 2,
    });
  });

  it('restarts a completed turn timer when managed Claude background work resumes the turn', () => {
    const initial = {
      ...createEmptyTranscriptReducerState(),
      status: 'idle' as const,
      messages: [
        {
          id: 'user-1',
          role: 'user' as const,
          timestamp: 1_000,
          blocks: [{ type: 'text' as const, text: 'Keep monitoring' }],
        },
        {
          id: 'timer-1',
          role: 'system' as const,
          timestamp: 1_000,
          blocks: [
            {
              type: 'turn_timer' as const,
              startedAt: 1_000,
              completedAt: 2_000,
            },
          ],
        },
        {
          id: 'assistant-1',
          role: 'assistant' as const,
          timestamp: 1_500,
          blocks: [{ type: 'text' as const, text: 'Waiting for the task.' }],
        },
      ],
    };

    const resumed = applyClaudeTranscriptEvent(
      initial,
      {
        type: 'result',
        is_error: false,
        num_turns: 0,
        result: '',
        origin: { kind: 'task-notification' },
        canopy_session_continues: true,
        canopy_turn_user_message_id: 'user-1',
      },
      { now: 3_000, createMessageId: () => 'generated-timer' },
    );

    expect(resumed.status).toBe('streaming');
    expect(resumed.messages).toHaveLength(initial.messages.length);
    expect(resumed.messages[1]?.blocks[0]).toMatchObject({
      type: 'turn_timer',
      startedAt: 1_000,
      completedAt: null,
    });

    const withLaterOutput = applyClaudeTranscriptEvent(
      resumed,
      {
        type: 'assistant',
        canopy_turn_user_message_id: 'user-1',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'The task woke up.' }],
        },
      },
      { now: 4_000, createMessageId: () => 'thinking-1' },
    );
    expect(withLaterOutput.messages[1]?.blocks[0]).toMatchObject({
      type: 'turn_timer',
      completedAt: null,
    });

    const completed = applyClaudeTranscriptEvent(
      withLaterOutput,
      {
        type: 'result',
        is_error: false,
        num_turns: 1,
        result: 'Background work finished.',
        canopy_turn_user_message_id: 'user-1',
      },
      { now: 5_000, createMessageId: () => 'terminal-1' },
    );
    expect(completed.messages[1]?.blocks[0]).toMatchObject({
      type: 'turn_timer',
      completedAt: 5_000,
    });
  });

  it('keeps timers and tools open across a marked prelude until the actual Claude terminal', () => {
    let nextId = 0;
    const options = {
      now: 2_000,
      createMessageId: (): string => `generated-${++nextId}`,
    };
    const initial = {
      ...createEmptyTranscriptReducerState(),
      status: 'streaming' as const,
      messages: [
        {
          id: 'timer',
          role: 'system' as const,
          timestamp: 1_000,
          blocks: [
            {
              type: 'turn_timer' as const,
              startedAt: 1_000,
              completedAt: null,
            },
          ],
        },
        {
          id: 'tool-message',
          role: 'assistant' as const,
          timestamp: 1_500,
          blocks: [
            {
              type: 'tool_use' as const,
              toolUseId: 'tool-1',
              toolName: 'Read',
              input: JSON.stringify({ file_path: '/tmp/fixture.txt' }),
            },
          ],
        },
      ],
    };

    const afterPrelude = applyClaudeTranscriptEvent(
      initial,
      {
        type: 'result',
        is_error: false,
        num_turns: 0,
        result: '',
        origin: { kind: 'task-notification' },
        canopy_session_continues: true,
      },
      options,
    );
    expect(afterPrelude.status).toBe('streaming');
    expect(afterPrelude.messages).toEqual(initial.messages);
    expect(afterPrelude.messages[0]?.blocks[0]).toMatchObject({
      type: 'turn_timer',
      completedAt: null,
    });
    expect(afterPrelude.messages[1]?.blocks[0]).not.toHaveProperty('result');

    const afterToolResult = applyClaudeTranscriptEvent(
      afterPrelude,
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              content: 'fixture contents',
              is_error: false,
            },
          ],
        },
      },
      { ...options, now: 2_500 },
    );
    expect(afterToolResult.status).toBe('streaming');
    expect(
      afterToolResult.messages.flatMap((message) => message.blocks),
    ).toContainEqual(
      expect.objectContaining({
        type: 'tool_result',
        toolUseId: 'tool-1',
        output: 'fixture contents',
        isError: false,
      }),
    );

    const afterFinalText = applyClaudeTranscriptEvent(
      afterToolResult,
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'Follow-up finished after interruption.',
            },
          ],
        },
      },
      { ...options, now: 2_750 },
    );
    const completed = applyClaudeTranscriptEvent(
      afterFinalText,
      {
        type: 'result',
        is_error: false,
        num_turns: 1,
        result: 'Follow-up finished after interruption.',
      },
      { ...options, now: 3_000 },
    );
    expect(completed.status).toBe('idle');
    expect(completed.messages[0]?.blocks[0]).toMatchObject({
      type: 'turn_timer',
      completedAt: 3_000,
    });
    expect(
      completed.messages
        .flatMap((message) => message.blocks)
        .filter((block) => block.type === 'tool_result'),
    ).toEqual([
      expect.objectContaining({
        toolUseId: 'tool-1',
        output: 'fixture contents',
        isError: false,
      }),
    ]);
    expect(JSON.stringify(completed.messages)).toContain(
      'Follow-up finished after interruption.',
    );
  });

  it('settles the open timer on a Codex root turn completion', () => {
    const next = applyCodexTranscriptEvent(
      {
        ...createEmptyTranscriptReducerState(),
        providerType: 'codex',
        sdkSessionId: 'thread-root',
        status: 'streaming',
        messages: [
          {
            id: 'timer-1',
            role: 'system',
            timestamp: 1_000,
            blocks: [
              {
                type: 'turn_timer',
                startedAt: 1_000,
                completedAt: null,
              },
            ],
          },
        ],
      },
      {
        type: 'turn.completed',
        thread_id: 'thread-root',
        turn_id: 'turn-1',
      },
      { now: 2_000, createMessageId: () => 'unused' },
    );

    expect(next.status).toBe('idle');
    expect(next.error).toBeNull();
    expect(next.messages[0]?.blocks[0]).toEqual({
      type: 'turn_timer',
      startedAt: 1_000,
      completedAt: 2_000,
    });
  });

  it('keeps the root timer open when a Codex subagent turn completes', () => {
    const next = applyCodexTranscriptEvent(
      {
        ...createEmptyTranscriptReducerState(),
        providerType: 'codex',
        sdkSessionId: 'thread-root',
        status: 'streaming',
        messages: [
          {
            id: 'timer-1',
            role: 'system',
            timestamp: 1_000,
            blocks: [
              {
                type: 'turn_timer',
                startedAt: 1_000,
                completedAt: null,
              },
            ],
          },
        ],
      },
      {
        type: 'turn.completed',
        thread_id: 'thread-child',
        turn_id: 'turn-child',
      },
      { now: 2_000, createMessageId: () => 'unused' },
    );

    expect(next.status).toBe('streaming');
    expect(next.messages[0]?.blocks[0]).toEqual({
      type: 'turn_timer',
      startedAt: 1_000,
      completedAt: null,
    });
  });

  it('reopens the current Claude turn when activity arrives after an abort result', () => {
    const withClosedTimer = applyClaudeTranscriptEvent(
      {
        ...createEmptyTranscriptReducerState(),
        status: 'streaming',
        messages: [
          {
            id: 'user-1',
            role: 'user',
            timestamp: 1000,
            blocks: [{ type: 'text', text: 'Keep working' }],
          },
          {
            id: 'timer-1',
            role: 'system',
            timestamp: 1000,
            blocks: [
              {
                type: 'turn_timer',
                startedAt: 1000,
                completedAt: null,
              },
            ],
          },
        ],
      },
      {
        type: 'result',
        is_error: false,
        result: 'Session aborted',
      },
      {
        now: 2000,
        createMessageId: () => 'unused-result',
      },
    );

    expect(
      withClosedTimer.messages
        .flatMap((message) => message.blocks)
        .filter((block) => block.type === 'turn_timer'),
    ).toEqual([
      {
        type: 'turn_timer',
        startedAt: 1000,
        completedAt: 2000,
      },
    ]);

    const withToolResultAfterFalseClose = {
      ...withClosedTimer,
      messages: [
        ...withClosedTimer.messages,
        {
          id: 'tool-result-1',
          role: 'user' as const,
          timestamp: 2500,
          blocks: [
            {
              type: 'tool_result' as const,
              toolUseId: 'toolu-1',
              toolName: 'Bash',
              output: 'command output',
              isError: false,
            },
          ],
        },
      ],
    };

    const continued = applyClaudeTranscriptEvent(
      withToolResultAfterFalseClose,
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Continuing after interrupt.' }],
        },
      },
      {
        now: 3000,
        createMessageId: () => 'assistant-1',
      },
    );

    const timers = continued.messages
      .flatMap((message) => message.blocks)
      .filter((block) => block.type === 'turn_timer');

    expect(continued.status).toBe('streaming');
    expect(timers).toHaveLength(1);
    expect(timers[0]).toEqual({
      type: 'turn_timer',
      startedAt: 1000,
      completedAt: null,
    });
    // The assistant event carries no SDK id, so the reducer converges on the
    // wire projector's per-turn fallback (`${userMessageId}:assistant`) instead
    // of minting a local id.
    expect(continued.messages.map((message) => message.id)).toContain(
      'user-1:assistant',
    );
  });

  it.each([
    {
      label: 'session init',
      event: {
        type: 'system',
        subtype: 'init',
        session_id: 'session-1',
        canopy_turn_user_message_id: 'user-1',
      },
    },
    {
      label: 'thinking-token activity',
      event: {
        type: 'system',
        subtype: 'thinking_tokens',
        estimated_tokens: 42,
        canopy_turn_user_message_id: 'user-1',
      },
    },
  ])('reopens the matching Claude turn on $label', ({ event }) => {
    const resumed = applyClaudeTranscriptEvent(
      {
        ...createEmptyTranscriptReducerState(),
        status: 'idle',
        messages: [
          {
            id: 'user-1',
            role: 'user',
            timestamp: 1000,
            blocks: [{ type: 'text', text: 'Keep working' }],
          },
          {
            id: 'timer-1',
            role: 'system',
            timestamp: 1000,
            blocks: [
              {
                type: 'turn_timer',
                startedAt: 1000,
                completedAt: 1001,
              },
            ],
          },
        ],
      },
      event,
      {
        now: 2000,
        createMessageId: () => 'unused',
      },
    );

    const timers = resumed.messages
      .flatMap((message) => message.blocks)
      .filter((block) => block.type === 'turn_timer');
    expect(resumed.status).toBe('streaming');
    expect(timers).toEqual([
      {
        type: 'turn_timer',
        startedAt: 1000,
        completedAt: null,
      },
    ]);
  });

  it("does not reopen a Claude turn for another turn's liveness event", () => {
    const state = applyClaudeTranscriptEvent(
      {
        ...createEmptyTranscriptReducerState(),
        status: 'idle',
        messages: [
          {
            id: 'user-1',
            role: 'user',
            timestamp: 1000,
            blocks: [{ type: 'text', text: 'Keep working' }],
          },
          {
            id: 'timer-1',
            role: 'system',
            timestamp: 1000,
            blocks: [
              {
                type: 'turn_timer',
                startedAt: 1000,
                completedAt: 1001,
              },
            ],
          },
        ],
      },
      {
        type: 'system',
        subtype: 'thinking_tokens',
        estimated_tokens: 42,
        canopy_turn_user_message_id: 'older-user',
      },
      {
        now: 2000,
        createMessageId: () => 'unused',
      },
    );

    expect(state.status).toBe('idle');
    expect(
      state.messages
        .flatMap((message) => message.blocks)
        .filter((block) => block.type === 'turn_timer'),
    ).toEqual([
      {
        type: 'turn_timer',
        startedAt: 1000,
        completedAt: 1001,
      },
    ]);
  });

  it('does not duplicate an already-persisted user message when a prompt event starts the turn', () => {
    const next = applyClaudeTranscriptEvent(
      {
        ...createEmptyTranscriptReducerState(),
        messages: [
          {
            id: 'automation-marker',
            role: 'system',
            blocks: [
              {
                type: 'automation_info',
                activityName: 'Nightly Review',
                timestamp: 100,
              },
            ],
            timestamp: 100,
          },
          {
            id: 'user-1',
            role: 'user',
            blocks: [{ type: 'text', text: 'Review this worktree' }],
            timestamp: 101,
          },
        ],
      },
      {
        type: 'canopy_user_prompt',
        provider: 'codex',
        original_text: 'Review this worktree',
      },
      {
        now: 123,
        createMessageId: () => 'msg-new',
      },
    );

    expect(next.status).toBe('streaming');
    expect(
      next.messages.filter((message) => message.role === 'user'),
    ).toHaveLength(1);
    const lastMessage = next.messages[next.messages.length - 1];
    expect(lastMessage?.blocks[0]).toMatchObject({
      type: 'turn_timer',
      completedAt: null,
    });
  });

  it('uses the turn user message id for synthetic prompt events', () => {
    const next = applyClaudeTranscriptEvent(
      createEmptyTranscriptReducerState(),
      {
        type: 'canopy_user_prompt',
        provider: 'claude',
        original_text: 'Started from portal',
        canopy_turn_user_message_id: 'portal-user-message',
      },
      {
        now: 123,
        createMessageId: () => 'local-user-message',
      },
    );

    expect(next.messages[0]).toMatchObject({
      id: 'portal-user-message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Started from portal' }],
    });
  });

  it('closes open turn timers at the end of static transcripts', () => {
    const parsed = parseAgentTranscriptLines(
      [
        JSON.stringify({
          type: 'canopy_user_prompt',
          provider: 'codex',
          original_text: 'Summarize the build failure',
        }),
        JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'agent_message',
            id: 'answer-1',
            text: 'The build failed because tsc found one type error.',
          },
        }),
      ],
      'codex',
      { closeOpenTurnAtEnd: true },
    );

    const timer = parsed.messages
      .flatMap((message) => message.blocks)
      .find((block) => block.type === 'turn_timer');

    expect(timer).toMatchObject({
      type: 'turn_timer',
      completedAt: 2,
    });
  });

  it('leaves open turn timers live while parsing running transcripts', () => {
    const parsed = parseAgentTranscriptLines(
      [
        JSON.stringify({
          type: 'canopy_user_prompt',
          provider: 'codex',
          original_text: 'Summarize the build failure',
        }),
      ],
      'codex',
      { closeOpenTurnAtEnd: false },
    );

    const timer = parsed.messages
      .flatMap((message) => message.blocks)
      .find((block) => block.type === 'turn_timer');

    expect(timer).toMatchObject({
      type: 'turn_timer',
      completedAt: null,
    });
  });

  it('uses selected Claude model metadata for live assistant usage context', () => {
    const state = applyClaudeTranscriptEvent(
      {
        ...createEmptyTranscriptReducerState(),
        model: 'opus[1m]',
      },
      {
        type: 'assistant',
        message: {
          model: 'claude-opus-4-7',
          usage: {
            input_tokens: 120_000,
            cache_read_input_tokens: 10_000,
            cache_creation_input_tokens: 5_000,
          },
          content: [{ type: 'text', text: 'Working.' }],
        },
      },
      {
        now: 1,
        createMessageId: () => 'msg-1',
      },
    );

    expect(state.usage?.contextTokens).toBe(135_000);
    expect(state.usage?.contextWindow).toBe(1_000_000);
    expect(state.usage?.model).toBe('claude-opus-4-7');
  });

  it('uses gateway context metadata for AI-Credits-routed usage', () => {
    const state = applyClaudeTranscriptEvent(
      {
        ...createEmptyTranscriptReducerState(),
        model: 'opus[1m]',
      },
      {
        type: 'assistant',
        message: {
          model: 'claude-opus-4-7',
          usage: { input_tokens: 120_000 },
          content: [{ type: 'text', text: 'Working.' }],
        },
      },
      {
        now: 1,
        createMessageId: () => 'msg-1',
        aiCreditsRouted: true,
      },
    );

    expect(state.usage?.contextWindow).toBe(400_000);
  });

  it('reopens a completed Claude turn timer when the same turn continues', () => {
    let nextId = 1;
    const state = applyClaudeTranscriptEvent(
      {
        ...createEmptyTranscriptReducerState(),
        messages: [
          {
            id: 'timer-1',
            role: 'system',
            blocks: [{ type: 'turn_timer', startedAt: 10, completedAt: 20 }],
            timestamp: 10,
          },
        ],
        status: 'idle',
      },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Completed (exit 0).' }],
        },
      },
      {
        now: 30,
        createMessageId: () => `msg-${nextId++}`,
      },
    );

    expect(state.status).toBe('streaming');
    const timerMessage = state.messages[state.messages.length - 2];
    const assistantMessage = state.messages[state.messages.length - 1];

    expect(timerMessage?.blocks[0]).toMatchObject({
      type: 'turn_timer',
      startedAt: 10,
      completedAt: null,
    });
    expect(assistantMessage?.blocks[0]).toMatchObject({
      type: 'text',
      text: 'Completed (exit 0).',
    });
  });

  it('uses the selected Claude model usage entry instead of the first modelUsage entry', () => {
    const state = applyClaudeTranscriptEvent(
      {
        ...createEmptyTranscriptReducerState(),
        model: 'opus[1m]',
      },
      {
        type: 'result',
        is_error: false,
        usage: {
          input_tokens: 12,
          output_tokens: 8,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        modelUsage: {
          'claude-opus-4-7': {
            contextWindow: 200_000,
            maxOutputTokens: 32_000,
          },
          'opus[1m]': {
            contextWindow: 1_000_000,
            maxOutputTokens: 64_000,
          },
        },
      },
      {
        now: 1,
        createMessageId: () => 'msg-1',
      },
    );

    expect(state.usage?.contextWindow).toBe(1_000_000);
    expect(state.usage?.maxOutputTokens).toBe(64_000);
  });

  it('updates the selected Claude model from exact assistant model usage at turn completion', () => {
    let nextId = 1;
    let state = applyClaudeTranscriptEvent(
      {
        ...createEmptyTranscriptReducerState(),
        model: 'fable[1m]',
      },
      {
        type: 'assistant',
        message: {
          model: 'claude-opus-4-8',
          usage: {
            input_tokens: 12,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          content: [{ type: 'text', text: 'Using Opus now.' }],
        },
      },
      {
        now: 1,
        createMessageId: () => `msg-${nextId++}`,
      },
    );

    const liveModelChangeBlock = buildTranscriptDisplayMessages(state.messages)
      .flatMap((message) => message.blocks)
      .find(
        (block) =>
          block.type === 'tool_use' && block.toolName === 'ClaudeModelChange',
      );
    expect(liveModelChangeBlock).toMatchObject({
      type: 'tool_use',
      toolName: 'ClaudeModelChange',
      result: {
        output:
          'Previous model: fable[1m]\nDetected model: opus[1m]\nReported model: claude-opus-4-8',
        isError: false,
      },
    });
    expect(state.model).toBe('fable[1m]');

    state = applyClaudeTranscriptEvent(
      state,
      {
        type: 'result',
        is_error: false,
        usage: {
          input_tokens: 12,
          output_tokens: 8,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        modelUsage: {
          'claude-fable-5': {
            contextWindow: 1_000_000,
            maxOutputTokens: 32_000,
          },
          'claude-opus-4-8': {
            contextWindow: 1_000_000,
            maxOutputTokens: 64_000,
          },
        },
      },
      {
        now: 2,
        createMessageId: () => `msg-${nextId++}`,
      },
    );

    expect(state.model).toBe('opus[1m]');
    expect(state.usage?.model).toBe('claude-opus-4-8');
    expect(state.usage?.contextWindow).toBe(1_000_000);
    expect(state.usage?.maxOutputTokens).toBe(64_000);
    expect(state.messages[state.messages.length - 1]).toMatchObject({
      role: 'system',
      blocks: [
        {
          type: 'tool_use',
          toolName: 'ClaudeModelChange',
          input: JSON.stringify({
            previous_model: 'fable[1m]',
            detected_model: 'opus[1m]',
            previous_model_display: 'Fable 5 1M',
            detected_model_display: 'Opus 4.8 1M',
            reported_model: 'claude-opus-4-8',
          }),
        },
        {
          type: 'tool_result',
          toolName: 'ClaudeModelChange',
          output:
            'Previous model: fable[1m]\nDetected model: opus[1m]\nReported model: claude-opus-4-8',
          isError: false,
        },
      ],
    });

    expect(
      state.messages
        .flatMap((message) => message.blocks)
        .filter(
          (block) =>
            block.type === 'tool_use' && block.toolName === 'ClaudeModelChange',
        ),
    ).toHaveLength(1);
  });

  it('does not append a Claude model-change marker when the selected model matches', () => {
    let state = applyClaudeTranscriptEvent(
      {
        ...createEmptyTranscriptReducerState(),
        model: 'opus[1m]',
      },
      {
        type: 'assistant',
        message: {
          model: 'claude-opus-4-8',
          usage: {
            input_tokens: 12,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          content: [{ type: 'text', text: 'Still Opus.' }],
        },
      },
      {
        now: 1,
        createMessageId: () => 'msg-1',
      },
    );

    state = applyClaudeTranscriptEvent(
      state,
      {
        type: 'result',
        is_error: false,
        usage: {
          input_tokens: 12,
          output_tokens: 8,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        modelUsage: {
          'claude-opus-4-8': {
            contextWindow: 1_000_000,
            maxOutputTokens: 64_000,
          },
        },
      },
      {
        now: 2,
        createMessageId: () => 'msg-2',
      },
    );

    expect(state.model).toBe('opus[1m]');
    expect(
      state.messages.some((message) =>
        message.blocks.some(
          (block) =>
            block.type === 'tool_use' && block.toolName === 'ClaudeModelChange',
        ),
      ),
    ).toBe(false);
  });

  it('keeps Sonnet selected when Claude reports its current fully qualified ID', () => {
    const config = parseModelPackageConfig(packageConfig);
    initClaudeModels(config.claudeModels);
    initModelAliases(config.modelAliases);
    // A cached gateway catalog can also expose the resolved ID as its own row.
    // It must compare equal to the native selection, even in that state.
    initAiGatewayModels(
      [
        {
          id: 'claude-sonnet-5-5',
          label: 'Sonnet 5.5',
          recommendedHarness: 'claude',
          contextWindow: 1_000_000,
          supportsPromptCaching: true,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'standard',
        },
      ],
      [],
    );
    let state = applyClaudeTranscriptEvent(
      { ...createEmptyTranscriptReducerState(), model: 'sonnet' },
      {
        type: 'assistant',
        message: {
          model: 'claude-sonnet-5-5',
          usage: { input_tokens: 12, output_tokens: 8 },
          content: [{ type: 'text', text: 'Still Sonnet.' }],
        },
      },
      { now: 1, createMessageId: () => 'sonnet-reply' },
    );
    expect(state.model).toBe('sonnet');
    state = applyClaudeTranscriptEvent(
      state,
      {
        type: 'result',
        is_error: false,
        usage: { input_tokens: 12, output_tokens: 8 },
        modelUsage: { 'claude-sonnet-5-5': { contextWindow: 1_000_000 } },
      },
      { now: 2, createMessageId: () => 'sonnet-result' },
    );
    expect(state.model).toBe('sonnet');
    expect(
      state.messages
        .flatMap((message) => message.blocks)
        .some(
          (block) =>
            block.type === 'tool_use' && block.toolName === 'ClaudeModelChange',
        ),
    ).toBe(false);
  });

  it('compares a custom Agent using its underlying base model', () => {
    initAgentModels([
      {
        id: 'agent_model_rigorous',
        name: 'Rigorous',
        baseModel: 'opus[1m]',
        instructions: 'Be rigorous.',
        pluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
        },
        createdAt: '2026-07-14T00:00:00.000Z',
        updatedAt: '2026-07-14T00:00:00.000Z',
        available: true,
      },
    ]);

    let state = applyClaudeTranscriptEvent(
      {
        ...createEmptyTranscriptReducerState(),
        model: 'agent_model_rigorous',
      },
      {
        type: 'assistant',
        message: {
          model: 'claude-opus-4-8',
          usage: {
            input_tokens: 12,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          content: [
            { type: 'text', text: 'Still using the Agent base model.' },
          ],
        },
      },
      {
        now: 1,
        createMessageId: () => 'msg-1',
      },
    );

    state = applyClaudeTranscriptEvent(
      state,
      {
        type: 'result',
        is_error: false,
        usage: {
          input_tokens: 12,
          output_tokens: 8,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        modelUsage: {
          'claude-opus-4-8': {
            contextWindow: 1_000_000,
            maxOutputTokens: 64_000,
          },
        },
      },
      {
        now: 2,
        createMessageId: () => 'msg-2',
      },
    );

    expect(
      state.messages.some((message) =>
        message.blocks.some(
          (block) =>
            block.type === 'tool_use' && block.toolName === 'ClaudeModelChange',
        ),
      ),
    ).toBe(false);
    expect(state.model).toBe('agent_model_rigorous');
  });

  it('skips model usage entries without supported fields when finding a match', () => {
    const state = applyClaudeTranscriptEvent(
      {
        ...createEmptyTranscriptReducerState(),
        model: 'opus[1m]',
      },
      {
        type: 'result',
        is_error: false,
        usage: {
          input_tokens: 12,
          output_tokens: 8,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        modelUsage: {
          'opus[1m]': {
            unsupported: 123,
          },
          'claude-opus-4-7': {
            contextWindow: 200_000,
            maxOutputTokens: 32_000,
          },
        },
      },
      {
        now: 1,
        createMessageId: () => 'msg-1',
      },
    );

    expect(state.usage?.contextWindow).toBe(1_000_000);
    expect(state.usage?.maxOutputTokens).toBe(32_000);
  });

  it('keeps configured 1M context for Opus 1M when SDK reports canonical Opus usage', () => {
    const state = applyClaudeTranscriptEvent(
      {
        ...createEmptyTranscriptReducerState(),
        model: 'opus[1m]',
        usage: {
          contextTokens: 120_000,
          contextWindow: 1_000_000,
          maxOutputTokens: 64_000,
          totalCostUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          durationMs: 0,
          durationApiMs: 0,
          numTurns: 0,
          model: 'claude-opus-4-7',
        },
      },
      {
        type: 'result',
        is_error: false,
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        modelUsage: {
          'claude-opus-4-7': {
            contextWindow: 200_000,
            maxOutputTokens: 32_000,
          },
        },
      },
      {
        now: 1,
        createMessageId: () => 'msg-1',
      },
    );

    expect(state.usage?.contextWindow).toBe(1_000_000);
    expect(state.usage?.maxOutputTokens).toBe(32_000);
  });

  it('parses Codex thread transcript JSONL into display messages', () => {
    const transcript = serializeCodexTranscript(
      parseJsonArray(`[
        {
          "type": "thread.started",
          "thread_id": "thread-1"
        },
        {
          "type": "item.completed",
          "item": {
            "type": "command_execution",
            "id": "cmd-1",
            "command": "ls",
            "aggregated_output": "file.txt",
            "status": "completed",
            "exit_code": 0
          }
        },
        {
          "type": "item.completed",
          "item": {
            "type": "agent_message",
            "id": "msg-1",
            "text": "Done"
          }
        }
      ]`),
    );

    const parsed = parseAgentTranscriptLines(splitTranscriptLines(transcript));

    expect(parsed.providerType).toBe('codex');
    expect(parsed.displayMessages).toHaveLength(2);
    expect(parsed.displayMessages[0].blocks[0]).toMatchObject({
      type: 'tool_use',
      toolName: 'command',
      result: {
        output: 'file.txt',
        isError: false,
      },
    });
    expect(parsed.displayMessages[1].blocks[0]).toMatchObject({
      type: 'text',
      text: 'Done',
    });
  });

  it('maps Codex cat SKILL.md command executions to skill display blocks', () => {
    const transcript = serializeCodexTranscript(
      parseJsonArray(`[
        {
          "type": "thread.started",
          "thread_id": "thread-1"
        },
        {
          "type": "item.completed",
          "item": {
            "type": "command_execution",
            "id": "cmd-1",
            "command": "/bin/zsh -lc 'cat /Users/me/.codex/skills/.system/imagegen/SKILL.md'",
            "aggregated_output": "# imagegen",
            "status": "completed",
            "exit_code": 0
          }
        }
      ]`),
    );

    const parsed = parseAgentTranscriptLines(splitTranscriptLines(transcript));

    expect(parsed.displayMessages).toHaveLength(1);
    expect(parsed.displayMessages[0].blocks[0]).toMatchObject({
      type: 'tool_use',
      toolName: 'Skill',
      result: {
        output: '# imagegen',
        isError: false,
      },
    });
    expect(
      JSON.parse(
        parsed.displayMessages[0].blocks[0].type === 'tool_use'
          ? parsed.displayMessages[0].blocks[0].input
          : '{}',
      ),
    ).toEqual({
      skill: 'imagegen',
      raw_command:
        "/bin/zsh -lc 'cat /Users/me/.codex/skills/.system/imagegen/SKILL.md'",
    });
  });

  it('maps non-skill Codex cat command executions to read display blocks', () => {
    const transcript = serializeCodexTranscript(
      parseJsonArray(`[
        {
          "type": "thread.started",
          "thread_id": "thread-1"
        },
        {
          "type": "item.completed",
          "item": {
            "type": "command_execution",
            "id": "cmd-1",
            "command": "/bin/zsh -lc 'cat apps/desktop-app/package.json'",
            "aggregated_output": "{\\"name\\": \\"desktop-app\\"}",
            "status": "completed",
            "exit_code": 0
          }
        }
      ]`),
    );

    const parsed = parseAgentTranscriptLines(splitTranscriptLines(transcript));

    expect(parsed.displayMessages).toHaveLength(1);
    expect(parsed.displayMessages[0].blocks[0]).toMatchObject({
      type: 'tool_use',
      toolName: 'Read',
      result: {
        output: '{"name": "desktop-app"}',
        isError: false,
      },
    });
    expect(
      JSON.parse(
        parsed.displayMessages[0].blocks[0].type === 'tool_use'
          ? parsed.displayMessages[0].blocks[0].input
          : '{}',
      ),
    ).toEqual({
      file_path: 'apps/desktop-app/package.json',
      raw_command: "/bin/zsh -lc 'cat apps/desktop-app/package.json'",
    });
  });

  it('maps Codex sed range command executions to read-lines display blocks', () => {
    const transcript = serializeCodexTranscript(
      parseJsonArray(`[
        {
          "type": "thread.started",
          "thread_id": "thread-1"
        },
        {
          "type": "item.completed",
          "item": {
            "type": "command_execution",
            "id": "cmd-1",
            "command": "/bin/zsh -lc \\"cat src/app.ts | sed -n '9,14p'\\"",
            "aggregated_output": "selected lines",
            "status": "completed",
            "exit_code": 0
          }
        }
      ]`),
    );

    const parsed = parseAgentTranscriptLines(splitTranscriptLines(transcript));

    expect(parsed.displayMessages).toHaveLength(1);
    expect(parsed.displayMessages[0].blocks[0]).toMatchObject({
      type: 'tool_use',
      toolName: 'ReadLines',
      result: {
        output: 'selected lines',
        isError: false,
      },
    });
    expect(
      JSON.parse(
        parsed.displayMessages[0].blocks[0].type === 'tool_use'
          ? parsed.displayMessages[0].blocks[0].input
          : '{}',
      ),
    ).toEqual({
      file_path: 'src/app.ts',
      start: '9',
      end: '14',
      raw_command: `/bin/zsh -lc "cat src/app.ts | sed -n '9,14p'"`,
    });
  });

  it('maps Codex sed range command executions on SKILL.md to skill display blocks', () => {
    const transcript = serializeCodexTranscript(
      parseJsonArray(`[
        {
          "type": "thread.started",
          "thread_id": "thread-1"
        },
        {
          "type": "item.completed",
          "item": {
            "type": "command_execution",
            "id": "cmd-1",
            "command": "/bin/zsh -lc \\"cat /Users/me/.codex/skills/.system/imagegen/SKILL.md | sed -n '2,8p'\\"",
            "aggregated_output": "skill excerpt",
            "status": "completed",
            "exit_code": 0
          }
        }
      ]`),
    );

    const parsed = parseAgentTranscriptLines(splitTranscriptLines(transcript));

    expect(parsed.displayMessages).toHaveLength(1);
    expect(parsed.displayMessages[0].blocks[0]).toMatchObject({
      type: 'tool_use',
      toolName: 'Skill',
      result: {
        output: 'skill excerpt',
        isError: false,
      },
    });
    expect(
      JSON.parse(
        parsed.displayMessages[0].blocks[0].type === 'tool_use'
          ? parsed.displayMessages[0].blocks[0].input
          : '{}',
      ),
    ).toEqual({
      skill: 'imagegen',
      file_path: '/Users/me/.codex/skills/.system/imagegen/SKILL.md',
      start: '2',
      end: '8',
      raw_command: `/bin/zsh -lc "cat /Users/me/.codex/skills/.system/imagegen/SKILL.md | sed -n '2,8p'"`,
    });
  });

  it('ignores empty Codex assistant and reasoning completions', () => {
    const transcript = serializeCodexTranscript(
      parseJsonArray(`[
        {
          "type": "thread.started",
          "thread_id": "thread-1"
        },
        {
          "type": "item.completed",
          "item": {
            "type": "reasoning",
            "id": "reason-empty",
            "text": ""
          }
        },
        {
          "type": "item.completed",
          "item": {
            "type": "agent_message",
            "id": "msg-empty",
            "text": "   "
          }
        },
        {
          "type": "item.completed",
          "item": {
            "type": "agent_message",
            "id": "msg-visible",
            "text": "Visible"
          }
        }
      ]`),
    );

    const parsed = parseAgentTranscriptLines(splitTranscriptLines(transcript));

    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]).toMatchObject({
      id: 'codex-msg-visible',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Visible' }],
    });
    expect(parsed.displayMessages).toHaveLength(1);
  });

  describe('compaction events', () => {
    it('appends a compaction_info block when the Claude SDK emits compact_boundary', () => {
      let nextId = 1;
      const state = applyClaudeTranscriptEvent(
        createEmptyTranscriptReducerState(),
        {
          type: 'system',
          subtype: 'compact_boundary',
          session_id: 'sdk-1',
          compact_metadata: {
            trigger: 'auto',
            summary: 'Older turns folded into context.',
          },
        },
        { now: 1234, createMessageId: () => `msg-${nextId++}` },
      );

      const lastMessage = state.messages[state.messages.length - 1];
      expect(lastMessage?.blocks).toHaveLength(1);
      expect(lastMessage?.blocks[0]).toMatchObject({
        type: 'compaction_info',
        provider: 'claude',
        interfaceMode: 'canopy',
        reason: 'auto',
        sessionId: 'sdk-1',
        summary: 'Older turns folded into context.',
      });
    });

    it('does not rewrite earlier transcript messages when a compaction event arrives', () => {
      let nextId = 1;
      let state = applyClaudeTranscriptEvent(
        createEmptyTranscriptReducerState(),
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'first reply' }],
          },
        },
        { now: 1000, createMessageId: () => `msg-${nextId++}` },
      );
      const previousMessage = state.messages[state.messages.length - 1];

      state = applyClaudeTranscriptEvent(
        state,
        {
          type: 'system',
          subtype: 'compact_boundary',
          session_id: 'sdk-1',
        },
        { now: 1100, createMessageId: () => `msg-${nextId++}` },
      );

      // Earlier message is preserved (append-only semantics).
      expect(state.messages[0]).toBe(previousMessage);
      // New compaction block lives on its own appended system message.
      const tail = state.messages[state.messages.length - 1];
      expect(tail.role).toBe('system');
      expect(tail.blocks[0]).toMatchObject({ type: 'compaction_info' });
    });

    it('uses the Claude SDK compact boundary uuid to deduplicate repeated events', () => {
      let nextId = 1;
      const compactBoundary = {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'compact-uuid',
        session_id: 'sdk-1',
        compact_metadata: {
          trigger: 'auto',
          pre_tokens: 100_000,
        },
      };
      let state = applyClaudeTranscriptEvent(
        createEmptyTranscriptReducerState(),
        compactBoundary,
        { now: 1000, createMessageId: () => `msg-${nextId++}` },
      );
      state = applyClaudeTranscriptEvent(state, compactBoundary, {
        now: 1100,
        createMessageId: () => `msg-${nextId++}`,
      });

      const compactionBlocks = state.messages.flatMap((message) =>
        message.blocks.filter((block) => block.type === 'compaction_info'),
      );
      expect(compactionBlocks).toHaveLength(1);
      expect(compactionBlocks[0]).toMatchObject({
        provider: 'claude',
        sourceEventId: 'compact-uuid',
      });
    });

    it('shows an account proxy switch once, in Claude and Codex chats', () => {
      let nextId = 1;
      const options = {
        now: 999,
        createMessageId: (): string => `msg-${nextId++}`,
      };
      const event = {
        type: 'canopy_account_proxy_switch',
        sourceEventId: 'account-proxy-switch:42:1',
        timestamp: 42,
        account: 'sam@example.com',
        previousAccount: 'ops@example.com',
        previousAtLimit: true,
        provider: 'claude',
      };
      let claude = applyClaudeTranscriptEvent(
        createEmptyTranscriptReducerState(),
        event,
        options,
      );
      // A replayed event is shown once.
      claude = applyClaudeTranscriptEvent(claude, event, options);
      const lines = claude.messages.filter((message) =>
        message.blocks.some((block) => block.type === 'account_proxy_switch'),
      );
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ role: 'system', timestamp: 42 });
      expect(lines[0]?.blocks[0]).toEqual({
        type: 'account_proxy_switch',
        timestamp: 42,
        account: 'sam@example.com',
        previousAccount: 'ops@example.com',
        previousAtLimit: true,
        provider: 'claude',
        sourceEventId: 'account-proxy-switch:42:1',
      });

      const codex = applyCodexTranscriptEvent(
        createEmptyTranscriptReducerState(),
        { ...event, previousAccount: undefined, provider: 'codex' },
        options,
      );
      // Without the account it left, nothing reached a limit.
      expect(codex.messages[0]?.blocks[0]).toEqual({
        type: 'account_proxy_switch',
        timestamp: 42,
        account: 'sam@example.com',
        provider: 'codex',
        sourceEventId: 'account-proxy-switch:42:1',
      });
    });

    it('ignores an account proxy switch with no account', () => {
      const state = applyClaudeTranscriptEvent(
        createEmptyTranscriptReducerState(),
        { type: 'canopy_account_proxy_switch', account: '  ' },
        { now: 1, createMessageId: () => 'msg-1' },
      );
      expect(state.messages).toEqual([]);
    });

    it('replays an account proxy switch from a saved transcript', () => {
      const parsed = parseAgentTranscriptLines(
        [
          JSON.stringify({
            type: 'canopy_account_proxy_switch',
            sourceEventId: 'switch-1',
            timestamp: 7,
            account: 'sam@example.com',
          }),
        ],
        'claude',
      );
      expect(
        parsed.messages.flatMap((message) => message.blocks),
      ).toContainEqual(
        expect.objectContaining({
          type: 'account_proxy_switch',
          account: 'sam@example.com',
        }),
      );
    });

    it('accepts canopy_compaction envelopes from terminal-imported transcripts', () => {
      let nextId = 1;
      const state = applyClaudeTranscriptEvent(
        createEmptyTranscriptReducerState(),
        {
          type: 'canopy_compaction',
          provider: 'claude',
          interfaceMode: 'claude-code',
          timestamp: 42,
          sessionId: 'sdk-terminal',
          reason: 'manual',
          summary: 'User invoked /compact in the terminal.',
          transcriptPath: '/tmp/transcript.jsonl',
          sourceEventId: 'evt-42',
        },
        { now: 999, createMessageId: () => `msg-${nextId++}` },
      );

      const lastMessage = state.messages[state.messages.length - 1];
      expect(lastMessage?.blocks[0]).toEqual({
        type: 'compaction_info',
        timestamp: 42,
        provider: 'claude',
        interfaceMode: 'claude-code',
        sessionId: 'sdk-terminal',
        reason: 'manual',
        summary: 'User invoked /compact in the terminal.',
        transcriptPath: '/tmp/transcript.jsonl',
        sourceEventId: 'evt-42',
      });
    });

    it('deduplicates repeated compaction events that carry the same sourceEventId', () => {
      let nextId = 1;
      const baseEvent = {
        type: 'canopy_compaction',
        provider: 'claude',
        interfaceMode: 'claude-code',
        timestamp: 100,
        sourceEventId: 'evt-42',
      } as const;

      let state = applyClaudeTranscriptEvent(
        createEmptyTranscriptReducerState(),
        { ...baseEvent },
        { now: 100, createMessageId: () => `msg-${nextId++}` },
      );
      state = applyClaudeTranscriptEvent(
        state,
        { ...baseEvent },
        {
          now: 200,
          createMessageId: () => `msg-${nextId++}`,
        },
      );

      const compactionMessages = state.messages.filter((message) =>
        message.blocks.some((block) => block.type === 'compaction_info'),
      );
      expect(compactionMessages).toHaveLength(1);
    });

    it('surfaces native Codex context compaction without removing visible history', () => {
      const transcript = serializeCodexTranscript([
        { type: 'thread.started', thread_id: 'codex-thread' },
        {
          type: 'item.completed',
          thread_id: 'codex-thread',
          turn_id: 'turn-1',
          item: {
            type: 'agent_message',
            id: 'before-compaction',
            text: 'Visible before compaction',
          },
        },
        {
          type: 'item.completed',
          thread_id: 'codex-thread',
          turn_id: 'turn-1',
          item: {
            type: 'context_compaction',
            id: 'compact-1',
          },
        },
        {
          type: 'item.completed',
          thread_id: 'codex-thread',
          turn_id: 'turn-1',
          item: {
            type: 'context_compaction',
            id: 'compact-1',
          },
        },
        {
          type: 'item.completed',
          thread_id: 'codex-thread',
          turn_id: 'turn-1',
          item: {
            type: 'agent_message',
            id: 'after-compaction',
            text: 'Visible after compaction',
          },
        },
      ]);

      const parsed = parseAgentTranscriptLines(
        splitTranscriptLines(transcript),
      );
      const text = parsed.messages.flatMap((message) =>
        message.blocks.flatMap((block) =>
          block.type === 'text' ? [block.text] : [],
        ),
      );
      const compactionBlocks = parsed.messages.flatMap((message) =>
        message.blocks.filter((block) => block.type === 'compaction_info'),
      );

      expect(text).toEqual([
        'Visible before compaction',
        'Visible after compaction',
      ]);
      expect(compactionBlocks).toHaveLength(1);
      expect(compactionBlocks[0]).toMatchObject({
        provider: 'codex',
        interfaceMode: 'canopy',
        sessionId: 'codex-thread',
        sourceEventId: 'codex-context-compaction:codex-thread:compact-1',
      });
    });
  });

  describe('Codex multi-agent (collab_agent_tool_call)', () => {
    it('groups activity-only agents and nested reports in live reduction and replay', () => {
      const replay = parseAgentTranscriptLines(
        subagentActivityEvents.map((event) => JSON.stringify(event)),
        'codex',
      );
      const live = subagentActivityEvents.reduce(
        (state, event, index) =>
          applyCodexTranscriptEvent(state, event, {
            now: index + 1,
            createMessageId: () => `event-${index}`,
          }),
        createEmptyTranscriptReducerState(),
      );
      // Main persists messages but intentionally drops reducer-only codexThreads.
      const persisted = subagentActivityEvents.reduce((state, event, index) => {
        const next = applyCodexTranscriptEvent(state, event, {
          now: index + 1,
          createMessageId: () => `event-${index}`,
        });
        return { ...next, codexThreads: undefined };
      }, createEmptyTranscriptReducerState());
      for (const messages of [
        replay.messages,
        live.messages,
        persisted.messages,
      ]) {
        const agents = messages
          .flatMap((message) => message.blocks)
          .filter((block) => block.type === 'codex_agent_call');
        expect(agents).toHaveLength(2);
        expect(agents[0]).toMatchObject({
          receiverThreadIds: ['research'],
          receiverAgents: {
            research: {
              nickname: 'Tesla',
              agentPath: '/root/readme_review',
              model: 'gpt-6-astra',
              reasoningEffort: 'high',
            },
          },
          agentsStates: { research: { status: 'completed' } },
        });
        expect(agents[1]).toMatchObject({
          receiverThreadIds: ['desktop'],
          receiverAgents: {
            desktop: {
              nickname: 'Raman',
              agentPath: '/root/readme_review/desktop-install',
            },
          },
          agentsStates: { desktop: { status: 'completed' } },
        });
        expect(
          messages.find((message) => message.id === 'codex-research-report')
            ?.parentBlockId,
        ).toBe(agents[0].agentBlockId);
        expect(
          messages.find((message) => message.id === agents[1].agentBlockId)
            ?.parentBlockId,
        ).toBe(agents[0].agentBlockId);
        expect(
          messages.find((message) => message.id === 'codex-desktop-report')
            ?.parentBlockId,
        ).toBe(agents[1].agentBlockId);
        expect(
          messages.find((message) => message.id === 'codex-desktop-command')
            ?.parentBlockId,
        ).toBe(agents[1].agentBlockId);
        expect(
          messages.find((message) => message.id === 'codex-root-report')
            ?.parentBlockId,
        ).toBeUndefined();
        expect(
          messages.some((message) =>
            message.blocks.some(
              (block) =>
                block.type === 'text' && block.text.startsWith('Agent /root'),
            ),
          ),
        ).toBe(false);
      }
    });

    it('deduplicates activity starts, handles late children, and preserves interrupted/error states', () => {
      let state = createEmptyTranscriptReducerState();
      const apply = (event: Record<string, unknown>): void => {
        state = applyCodexTranscriptEvent(state, event, {
          now: 1000,
          createMessageId: () => 'timer',
        });
      };
      apply({ type: 'thread.started', thread_id: 'root' });
      apply({
        type: 'item.completed',
        thread_id: 'child',
        item: {
          id: 'early',
          type: 'agent_message',
          text: 'Early child output',
        },
      });
      const activity = (kind: string, id = kind, agent = 'child'): void =>
        apply({
          type: 'item.completed',
          thread_id: 'root',
          item: {
            id,
            type: 'subagent_activity',
            kind,
            agent_thread_id: agent,
            agent_path: '/root/check',
          },
        });
      activity('started');
      activity('started');
      const block = state.messages
        .flatMap((message) => message.blocks)
        .find((value) => value.type === 'codex_agent_call');
      expect(block).toMatchObject({
        agentsStates: { child: { status: 'running' } },
      });
      expect(
        state.messages.find((message) => message.id === 'codex-early')
          ?.parentBlockId,
      ).toBe(block?.agentBlockId);
      activity('interrupted');
      activity('started'); // duplicate spawn notification must not reopen it
      activity('interacted', 'send-to-root', 'root');
      let agents = state.messages
        .flatMap((message) => message.blocks)
        .filter((value) => value.type === 'codex_agent_call');
      expect(agents).toHaveLength(1);
      expect(agents[0]).toMatchObject({
        status: 'completed',
        agentsStates: { child: { status: 'cancelled' } },
      });
      apply({
        type: 'turn.failed',
        thread_id: 'child',
        error: { message: 'Child failed' },
      });
      activity('completed');
      agents = state.messages
        .flatMap((message) => message.blocks)
        .filter((value) => value.type === 'codex_agent_call');
      expect(agents[0].agentsStates.child).toMatchObject({
        status: 'errored',
        message: 'Child failed',
      });
    });

    it('updates an existing activity card when its child starts and finishes a follow-up turn', () => {
      let state = subagentActivityEvents.reduce(
        (previous, event, index) =>
          applyCodexTranscriptEvent(previous, event, {
            now: index + 1,
            createMessageId: () => `event-${index}`,
          }),
        createEmptyTranscriptReducerState(),
      );
      const research = (): PersistedChatBlock | undefined =>
        state.messages
          .flatMap((message) => message.blocks)
          .find(
            (block) =>
              block.type === 'codex_agent_call' &&
              block.receiverThreadIds.includes('research'),
          );
      state = applyCodexTranscriptEvent(
        state,
        { type: 'turn.started', thread_id: 'research', turn_id: 'follow-up' },
        { now: 100, createMessageId: () => 'follow-up-timer' },
      );
      expect(research()).toMatchObject({
        status: 'inProgress',
        agentsStates: { research: { status: 'running' } },
      });
      state = applyCodexTranscriptEvent(
        state,
        { type: 'turn.completed', thread_id: 'research', turn_id: 'follow-up' },
        { now: 110, createMessageId: () => 'follow-up-timer' },
      );
      expect(research()).toMatchObject({
        status: 'completed',
        agentsStates: { research: { status: 'completed' } },
      });
    });

    it('marks an interrupted child turn as cancelled', () => {
      const state = applyCodexTranscriptEvent(
        subagentActivityEvents.reduce(
          (previous, event, index) =>
            applyCodexTranscriptEvent(previous, event, {
              now: index + 1,
              createMessageId: () => `event-${index}`,
            }),
          createEmptyTranscriptReducerState(),
        ),
        {
          type: 'turn.completed',
          thread_id: 'research',
          turn_id: 'follow-up',
          status: 'interrupted',
        },
        { now: 100, createMessageId: () => 'follow-up-timer' },
      );
      const research = state.messages
        .flatMap((message) => message.blocks)
        .find(
          (block) =>
            block.type === 'codex_agent_call' &&
            block.receiverThreadIds.includes('research'),
        );
      expect(research).toMatchObject({
        status: 'completed',
        agentsStates: { research: { status: 'cancelled' } },
      });
    });

    it('coalesces new activity and old collab spawn notifications for the same receiver', () => {
      const events: Record<string, unknown>[] = [
        { type: 'thread.started', thread_id: 'root' },
        {
          type: 'item.completed',
          thread_id: 'root',
          item: {
            id: 'activity',
            type: 'sub_agent_activity',
            kind: 'started',
            agent_thread_id: 'child',
            agent_path: '/root/research',
          },
        },
        {
          type: 'item.completed',
          thread_id: 'root',
          item: {
            id: 'collab',
            type: 'collab_agent_tool_call',
            tool: 'spawnAgent',
            status: 'completed',
            sender_thread_id: 'root',
            receiver_thread_ids: ['child'],
            prompt: 'Research the catalog',
            agents_states: { child: { status: 'running' } },
          },
        },
      ];
      for (const ordered of [events, [events[0], events[2], events[1]]]) {
        const result = parseAgentTranscriptLines(
          ordered.map((event) => JSON.stringify(event)),
          'codex',
        );
        const agents = result.messages
          .flatMap((message) => message.blocks)
          .filter((block) => block.type === 'codex_agent_call');
        expect(agents).toHaveLength(1);
        expect(agents[0]).toMatchObject({
          prompt: 'Research the catalog',
          receiverThreadIds: ['child'],
        });
      }
    });

    it('defers receiver-less spawnAgent starts so failed attempts do not render as empty agent blocks', () => {
      const transcript = serializeCodexTranscript([
        { type: 'thread.started', thread_id: 'root-thread' },
        { type: 'turn.started', thread_id: 'root-thread', turn_id: 'turn-1' },
        {
          type: 'item.started',
          thread_id: 'root-thread',
          turn_id: 'turn-1',
          item: {
            type: 'collab_agent_tool_call',
            id: 'call-transient',
            tool: 'spawnAgent',
            status: 'inProgress',
            sender_thread_id: 'root-thread',
            receiver_thread_ids: [],
            prompt: 'Attempt that never gets a receiver',
            agents_states: {},
          },
        },
        {
          type: 'item.completed',
          thread_id: 'root-thread',
          turn_id: 'turn-1',
          item: {
            type: 'agent_message',
            id: 'retry-note',
            text: 'Retrying without forked context.',
          },
        },
        {
          type: 'item.started',
          thread_id: 'root-thread',
          turn_id: 'turn-1',
          item: {
            type: 'collab_agent_tool_call',
            id: 'call-real',
            tool: 'spawnAgent',
            status: 'inProgress',
            sender_thread_id: 'root-thread',
            receiver_thread_ids: [],
            prompt: 'Real attempt',
            agents_states: {},
          },
        },
        {
          type: 'item.completed',
          thread_id: 'root-thread',
          turn_id: 'turn-1',
          item: {
            type: 'collab_agent_tool_call',
            id: 'call-real',
            tool: 'spawnAgent',
            status: 'completed',
            sender_thread_id: 'root-thread',
            receiver_thread_ids: ['subthread-1'],
            prompt: 'Real attempt',
            agents_states: {
              'subthread-1': { status: 'pendingInit', message: null },
            },
          },
        },
        {
          type: 'item.completed',
          thread_id: 'subthread-1',
          turn_id: 'sub-turn-1',
          item: {
            type: 'agent_message',
            id: 'sub-msg-1',
            text: 'Nested output',
          },
        },
      ]);

      const parsed = parseAgentTranscriptLines(
        splitTranscriptLines(transcript),
      );

      const rawAgentBlocks = parsed.messages
        .flatMap((message) => message.blocks)
        .filter((block) => block.type === 'codex_agent_call');
      expect(rawAgentBlocks).toHaveLength(1);
      expect(rawAgentBlocks[0]).toMatchObject({
        type: 'codex_agent_call',
        callId: 'call-real',
        receiverThreadIds: ['subthread-1'],
      });

      const displayAgentBlocks = parsed.displayMessages
        .flatMap((message) => message.blocks)
        .filter((block) => block.type === 'codex_agent');
      expect(displayAgentBlocks).toHaveLength(1);
      const block = displayAgentBlocks[0];
      if (block.type !== 'codex_agent') {
        throw new Error('Expected codex_agent display block');
      }
      expect(block.callId).toBe('call-real');
      expect(block.subBlocks.some((subBlock) => subBlock.type === 'text')).toBe(
        true,
      );
    });

    it('groups subagent items under their parent codex_agent block via parentBlockId', () => {
      const transcript = serializeCodexTranscript([
        { type: 'thread.started', thread_id: 'root-thread' },
        { type: 'turn.started', thread_id: 'root-thread' },
        {
          type: 'item.completed',
          thread_id: 'root-thread',
          turn_id: 'turn-1',
          item: {
            type: 'collab_agent_tool_call',
            id: 'call-1',
            tool: 'spawnAgent',
            status: 'inProgress',
            sender_thread_id: 'root-thread',
            receiver_thread_ids: ['subthread-1'],
            prompt: 'Explore the auth module',
            agents_states: {
              'subthread-1': { status: 'pendingInit', message: null },
            },
          },
        },
        {
          type: 'item.completed',
          thread_id: 'subthread-1',
          turn_id: 'sub-turn-1',
          item: {
            type: 'agent_message',
            id: 'sub-msg-1',
            text: 'Found three handlers in auth/handlers.ts',
          },
        },
        {
          type: 'item.completed',
          thread_id: 'subthread-1',
          turn_id: 'sub-turn-1',
          item: { type: 'reasoning', id: 'sub-thought-1', text: 'Inspecting…' },
        },
        {
          type: 'item.completed',
          thread_id: 'subthread-1',
          turn_id: 'sub-turn-1',
          item: {
            type: 'command_execution',
            id: 'sub-cmd-1',
            command: 'rg -n handler auth/handlers.ts',
            aggregated_output: 'auth/handlers.ts:12: handler-A',
            status: 'completed',
            exit_code: 0,
          },
        },
        {
          type: 'item.completed',
          thread_id: 'root-thread',
          turn_id: 'turn-1',
          item: {
            type: 'agent_message',
            id: 'final-msg',
            text: 'Done — see subagent output.',
          },
        },
      ]);

      const parsed = parseAgentTranscriptLines(
        splitTranscriptLines(transcript),
      );

      // Raw subagent messages must carry parentBlockId so persistence /
      // reload can re-group them without help from the live reducer state.
      const rawSubMessages = parsed.messages.filter(
        (msg) => msg.codexThreadId === 'subthread-1',
      );
      expect(rawSubMessages.length).toBeGreaterThan(0);
      for (const msg of rawSubMessages) {
        expect(msg.parentBlockId).toBe('codex-agent-call-1');
      }

      // Display side: exactly one codex_agent block, no Claude `agent`.
      const displayBlocks = parsed.displayMessages.flatMap((m) => m.blocks);
      const codexAgentBlocks = displayBlocks.filter(
        (b) => b.type === 'codex_agent',
      );
      expect(codexAgentBlocks).toHaveLength(1);
      expect(displayBlocks.some((b) => b.type === 'agent')).toBe(false);

      const block = codexAgentBlocks[0];
      if (block.type !== 'codex_agent') {
        throw new Error('Expected codex_agent display block');
      }
      expect(block.agentBlockId).toBe('codex-agent-call-1');
      expect(block.prompt).toBe('Explore the auth module');
      expect(block.description).toBe('Explore the auth module');
      // Sub-blocks include the agent_message text, the reasoning, and the
      // command_execution (folded to a single tool_use+result row).
      expect(block.subBlocks.length).toBeGreaterThanOrEqual(3);
      const subTextBlock = block.subBlocks.find((b) => b.type === 'text');
      expect(subTextBlock).toBeDefined();
      const subToolBlock = block.subBlocks.find(
        (b) => b.type === 'tool_use' && b.toolName === 'command',
      );
      expect(subToolBlock).toBeDefined();
    });

    it('keeps sdkSessionId pinned to the root thread when subagent thread.started arrives', () => {
      let state = createEmptyTranscriptReducerState();
      state = applyCodexTranscriptEvent(
        state,
        { type: 'thread.started', thread_id: 'root-thread' },
        { now: 1, createMessageId: () => 'msg-1' },
      );
      expect(state.sdkSessionId).toBe('root-thread');

      // Spawn the parent collab call so codex_agent_call.receiverAgents
      // exists for the patch to land on.
      state = applyCodexTranscriptEvent(
        state,
        {
          type: 'item.completed',
          thread_id: 'root-thread',
          turn_id: 'turn-1',
          item: {
            type: 'collab_agent_tool_call',
            id: 'call-2',
            tool: 'spawnAgent',
            status: 'inProgress',
            sender_thread_id: 'root-thread',
            receiver_thread_ids: ['sub-7'],
            prompt: 'help',
            agents_states: {
              'sub-7': { status: 'pendingInit', message: null },
            },
          },
        },
        { now: 2, createMessageId: () => 'msg-2' },
      );

      // Subagent thread.started arrives later. sdkSessionId must stay pinned
      // to the original root thread.
      state = applyCodexTranscriptEvent(
        state,
        {
          type: 'thread.started',
          thread_id: 'sub-7',
          agent_nickname: 'Explorer',
          agent_role: 'subagent',
        },
        { now: 3, createMessageId: () => 'msg-3' },
      );

      expect(state.sdkSessionId).toBe('root-thread');
      expect(state.codexThreads?.['sub-7']).toEqual({
        nickname: 'Explorer',
        role: 'subagent',
      });

      // The patch should have updated receiverAgents on the spawn block.
      const block = state.messages
        .flatMap((m) => m.blocks)
        .find((b) => b.type === 'codex_agent_call' && b.callId === 'call-2');
      if (!block || block.type !== 'codex_agent_call') {
        throw new Error('Expected the spawn block in state.messages');
      }
      expect(block.receiverAgents).toEqual({
        'sub-7': { nickname: 'Explorer', role: 'subagent' },
      });
    });

    it('extracts subagent display names from nested thread source metadata', () => {
      let state = createEmptyTranscriptReducerState();
      state = applyCodexTranscriptEvent(
        state,
        { type: 'thread.started', thread_id: 'root-thread' },
        { now: 1, createMessageId: () => 'msg-1' },
      );
      state = applyCodexTranscriptEvent(
        state,
        {
          type: 'item.completed',
          thread_id: 'root-thread',
          turn_id: 'turn-1',
          item: {
            type: 'collab_agent_tool_call',
            id: 'named-agent',
            tool: 'spawnAgent',
            status: 'completed',
            sender_thread_id: 'root-thread',
            receiver_thread_ids: ['sub-named'],
            prompt: 'inspect',
            agents_states: {
              'sub-named': { status: 'completed', message: 'OK' },
            },
          },
        },
        { now: 2, createMessageId: () => 'msg-2' },
      );

      state = applyCodexTranscriptEvent(
        state,
        {
          type: 'thread.started',
          thread_id: 'sub-named',
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: 'root-thread',
                depth: 1,
                agent_path: null,
                agent_nickname: 'Scout',
                agent_role: 'explorer',
              },
            },
          },
        },
        { now: 3, createMessageId: () => 'msg-3' },
      );

      const displayBlocks = buildTranscriptDisplayMessages(state.messages)
        .flatMap((message) => message.blocks)
        .filter((block) => block.type === 'codex_agent');
      expect(displayBlocks).toHaveLength(1);
      const block = displayBlocks[0];
      if (block.type !== 'codex_agent') {
        throw new Error('Expected codex_agent display block');
      }
      expect(block.displayName).toBe('Scout (explorer)');
      expect(block.agentsStates['sub-named']).toEqual({
        status: 'completed',
        message: 'OK',
      });
    });

    it('reparents subagent messages that arrive before the spawn collab call', () => {
      let state = createEmptyTranscriptReducerState();
      state = applyCodexTranscriptEvent(
        state,
        { type: 'thread.started', thread_id: 'root-thread' },
        { now: 1, createMessageId: () => 'msg-1' },
      );

      // Subagent message arrives FIRST (race) — no parent yet so
      // parentBlockId stays undefined.
      state = applyCodexTranscriptEvent(
        state,
        {
          type: 'item.completed',
          thread_id: 'sub-9',
          turn_id: 'sub-turn',
          item: {
            type: 'agent_message',
            id: 'orphan-1',
            text: 'Early subagent reply',
          },
        },
        { now: 2, createMessageId: () => 'msg-2' },
      );
      const orphanBefore = state.messages.find(
        (m) => m.id === 'codex-orphan-1',
      );
      expect(orphanBefore?.parentBlockId).toBeUndefined();

      // Now the spawn collab call lands.
      state = applyCodexTranscriptEvent(
        state,
        {
          type: 'item.completed',
          thread_id: 'root-thread',
          turn_id: 'turn-1',
          item: {
            type: 'collab_agent_tool_call',
            id: 'race',
            tool: 'spawnAgent',
            status: 'inProgress',
            sender_thread_id: 'root-thread',
            receiver_thread_ids: ['sub-9'],
            prompt: 'whatever',
            agents_states: {
              'sub-9': { status: 'running', message: null },
            },
          },
        },
        { now: 3, createMessageId: () => 'msg-3' },
      );

      const orphanAfter = state.messages.find((m) => m.id === 'codex-orphan-1');
      expect(orphanAfter?.parentBlockId).toBe('codex-agent-race');
    });

    it('keeps late subagent item updates attached to the original message after a newer turn timer', () => {
      let state = createEmptyTranscriptReducerState();
      state = applyCodexTranscriptEvent(
        state,
        { type: 'thread.started', thread_id: 'root-thread' },
        { now: 1, createMessageId: () => 'msg-1' },
      );
      state = applyCodexTranscriptEvent(
        state,
        {
          type: 'item.completed',
          thread_id: 'root-thread',
          turn_id: 'turn-1',
          item: {
            type: 'collab_agent_tool_call',
            id: 'late-parent',
            tool: 'spawnAgent',
            status: 'inProgress',
            sender_thread_id: 'root-thread',
            receiver_thread_ids: ['late-sub'],
            prompt: 'inspect',
            agents_states: {
              'late-sub': { status: 'running', message: null },
            },
          },
        },
        { now: 2, createMessageId: () => 'msg-2' },
      );
      state = applyCodexTranscriptEvent(
        state,
        {
          type: 'item.completed',
          thread_id: 'late-sub',
          turn_id: 'sub-turn-1',
          item: {
            type: 'agent_message',
            id: 'late-message',
            text: 'first text',
          },
        },
        { now: 3, createMessageId: () => 'msg-3' },
      );
      state = {
        ...state,
        messages: [
          ...state.messages,
          {
            id: 'newer-root-turn',
            role: 'system',
            blocks: [{ type: 'turn_timer', startedAt: 4, completedAt: null }],
            timestamp: 4,
          },
        ],
      };

      state = applyCodexTranscriptEvent(
        state,
        {
          type: 'item.updated',
          thread_id: 'late-sub',
          turn_id: 'sub-turn-1',
          item: {
            type: 'agent_message',
            id: 'late-message',
            text: 'updated text',
          },
        },
        { now: 5, createMessageId: () => 'msg-5' },
      );

      const lateMessages = state.messages.filter(
        (message) => message.id === 'codex-late-message',
      );
      expect(lateMessages).toHaveLength(1);
      expect(lateMessages[0].blocks[0]).toEqual({
        type: 'text',
        text: 'updated text',
      });
      expect(lateMessages[0].parentBlockId).toBe('codex-agent-late-parent');
    });

    it('keeps late subagent reasoning updates attached to the original thinking message after a newer turn timer', () => {
      let state = createEmptyTranscriptReducerState();
      state = applyCodexTranscriptEvent(
        state,
        { type: 'thread.started', thread_id: 'root-thread' },
        { now: 1, createMessageId: () => 'msg-1' },
      );
      state = applyCodexTranscriptEvent(
        state,
        {
          type: 'item.completed',
          thread_id: 'root-thread',
          turn_id: 'turn-1',
          item: {
            type: 'collab_agent_tool_call',
            id: 'late-reasoning-parent',
            tool: 'spawnAgent',
            status: 'inProgress',
            sender_thread_id: 'root-thread',
            receiver_thread_ids: ['late-reasoning-sub'],
            prompt: 'inspect',
            agents_states: {
              'late-reasoning-sub': { status: 'running', message: null },
            },
          },
        },
        { now: 2, createMessageId: () => 'msg-2' },
      );
      state = applyCodexTranscriptEvent(
        state,
        {
          type: 'item.completed',
          thread_id: 'late-reasoning-sub',
          turn_id: 'sub-turn-1',
          item: {
            type: 'reasoning',
            id: 'late-reasoning',
            text: 'first thought',
          },
        },
        { now: 3, createMessageId: () => 'msg-3' },
      );
      state = {
        ...state,
        messages: [
          ...state.messages,
          {
            id: 'newer-root-turn',
            role: 'system',
            blocks: [{ type: 'turn_timer', startedAt: 4, completedAt: null }],
            timestamp: 4,
          },
        ],
      };

      state = applyCodexTranscriptEvent(
        state,
        {
          type: 'item.updated',
          thread_id: 'late-reasoning-sub',
          turn_id: 'sub-turn-1',
          item: {
            type: 'reasoning',
            id: 'late-reasoning',
            text: 'updated thought',
          },
        },
        { now: 5, createMessageId: () => 'msg-5' },
      );

      const lateMessages = state.messages.filter(
        (message) => message.id === 'codex-late-reasoning',
      );
      expect(lateMessages).toHaveLength(1);
      expect(lateMessages[0].blocks[0]).toEqual({
        type: 'thinking',
        text: 'updated thought',
      });
      expect(lateMessages[0].parentBlockId).toBe(
        'codex-agent-late-reasoning-parent',
      );
    });

    it('routes subagent-scoped Codex errors under the owning codex_agent block', () => {
      let state = createEmptyTranscriptReducerState();
      state = applyCodexTranscriptEvent(
        state,
        { type: 'thread.started', thread_id: 'root-thread' },
        { now: 1, createMessageId: () => 'msg-1' },
      );
      state = applyCodexTranscriptEvent(
        state,
        {
          type: 'item.completed',
          thread_id: 'root-thread',
          turn_id: 'turn-1',
          item: {
            type: 'collab_agent_tool_call',
            id: 'error-parent',
            tool: 'spawnAgent',
            status: 'inProgress',
            sender_thread_id: 'root-thread',
            receiver_thread_ids: ['error-sub'],
            prompt: 'inspect',
            agents_states: {
              'error-sub': { status: 'running', message: null },
            },
          },
        },
        { now: 2, createMessageId: () => 'msg-2' },
      );

      state = applyCodexTranscriptEvent(
        state,
        {
          type: 'error',
          thread_id: 'error-sub',
          turn_id: 'sub-turn-1',
          message: 'Subagent failed',
        },
        { now: 3, createMessageId: () => 'msg-3' },
      );

      const errorMessage = state.messages.find(
        (message) => message.id === 'msg-3',
      );
      expect(errorMessage?.parentBlockId).toBe('codex-agent-error-parent');
      expect(errorMessage?.codexThreadId).toBe('error-sub');

      const displayBlocks = buildTranscriptDisplayMessages(state.messages)
        .flatMap((message) => message.blocks)
        .filter((block) => block.type === 'codex_agent');
      expect(displayBlocks).toHaveLength(1);
      const block = displayBlocks[0];
      if (block.type !== 'codex_agent') {
        throw new Error('Expected codex_agent display block');
      }
      expect(block.subBlocks).toContainEqual(
        expect.objectContaining({
          type: 'text',
          text: 'Error: Subagent failed',
        }),
      );
      expect(block.agentsStates['error-sub']).toEqual({
        status: 'errored',
        message: 'Subagent failed',
      });
    });

    it('marks routed subagent turn.failed events as errored on the owning codex_agent block', () => {
      let state = createEmptyTranscriptReducerState();
      state = applyCodexTranscriptEvent(
        state,
        { type: 'thread.started', thread_id: 'root-thread' },
        { now: 1, createMessageId: () => 'msg-1' },
      );
      state = applyCodexTranscriptEvent(
        state,
        {
          type: 'item.completed',
          thread_id: 'root-thread',
          turn_id: 'turn-1',
          item: {
            type: 'collab_agent_tool_call',
            id: 'turn-failed-parent',
            tool: 'spawnAgent',
            status: 'inProgress',
            sender_thread_id: 'root-thread',
            receiver_thread_ids: ['failed-sub'],
            prompt: 'inspect',
            agents_states: {
              'failed-sub': { status: 'running', message: null },
            },
          },
        },
        { now: 2, createMessageId: () => 'msg-2' },
      );

      state = applyCodexTranscriptEvent(
        state,
        {
          type: 'turn.failed',
          thread_id: 'failed-sub',
          turn_id: 'failed-turn',
          error: { message: 'Turn failed in subagent' },
        },
        { now: 3, createMessageId: () => 'msg-3' },
      );

      const displayBlocks = buildTranscriptDisplayMessages(state.messages)
        .flatMap((message) => message.blocks)
        .filter((block) => block.type === 'codex_agent');
      expect(displayBlocks).toHaveLength(1);
      const block = displayBlocks[0];
      if (block.type !== 'codex_agent') {
        throw new Error('Expected codex_agent display block');
      }
      expect(block.agentsStates['failed-sub']).toEqual({
        status: 'errored',
        message: 'Turn failed in subagent',
      });
      expect(block.subBlocks).toContainEqual(
        expect.objectContaining({
          type: 'text',
          text: 'Error: Turn failed in subagent',
        }),
      );
    });

    it('preserves parentBlockId on synthetic cancelled tool results during transcript close-out', () => {
      const state = createEmptyTranscriptReducerState();
      const next = applyClaudeTranscriptEvent(
        {
          ...state,
          messages: [
            {
              id: 'parent',
              role: 'assistant',
              timestamp: 1,
              blocks: [
                {
                  type: 'codex_agent_call',
                  agentBlockId: 'codex-agent-cancel',
                  callId: 'cancel',
                  tool: 'spawnAgent',
                  status: 'inProgress',
                  senderThreadId: 'root-thread',
                  receiverThreadIds: ['cancel-sub'],
                  prompt: 'inspect',
                  agentsStates: {
                    'cancel-sub': { status: 'running', message: null },
                  },
                },
              ],
            },
            {
              id: 'sub-tool',
              role: 'system',
              timestamp: 2,
              parentBlockId: 'codex-agent-cancel',
              blocks: [
                {
                  type: 'tool_use',
                  toolUseId: 'codex-command-1',
                  toolName: 'command',
                  input: 'pwd',
                },
              ],
            },
          ],
        },
        { type: 'result', is_error: false },
        { now: 3, createMessageId: () => 'synthetic-cancel' },
      );

      const synthetic = next.messages.find(
        (message) => message.id === 'synthetic-cancel',
      );
      expect(synthetic?.parentBlockId).toBe('codex-agent-cancel');
      expect(synthetic?.blocks[0]).toMatchObject({
        type: 'tool_result',
        toolUseId: 'codex-command-1',
        output: 'Cancelled',
      });
    });

    it('merges agents_states updates from non-spawn collab calls into the parent block', () => {
      let state = createEmptyTranscriptReducerState();
      state = applyCodexTranscriptEvent(
        state,
        { type: 'thread.started', thread_id: 'root-thread' },
        { now: 1, createMessageId: () => 'msg-1' },
      );
      state = applyCodexTranscriptEvent(
        state,
        {
          type: 'item.completed',
          thread_id: 'root-thread',
          turn_id: 'turn-1',
          item: {
            type: 'collab_agent_tool_call',
            id: 'call-3',
            tool: 'spawnAgent',
            status: 'inProgress',
            sender_thread_id: 'root-thread',
            receiver_thread_ids: ['sub-3'],
            prompt: 'inspect',
            agents_states: {
              'sub-3': { status: 'pendingInit', message: null },
            },
          },
        },
        { now: 2, createMessageId: () => 'msg-2' },
      );
      // A `wait` call should NOT introduce a new visible message — it must
      // fold its agents_states into the existing parent block.
      const messageCountBeforeWait = state.messages.length;
      state = applyCodexTranscriptEvent(
        state,
        {
          type: 'item.completed',
          thread_id: 'root-thread',
          turn_id: 'turn-1',
          item: {
            type: 'collab_agent_tool_call',
            id: 'call-4',
            tool: 'wait',
            status: 'completed',
            sender_thread_id: 'root-thread',
            receiver_thread_ids: ['sub-3'],
            prompt: '',
            agents_states: {
              'sub-3': { status: 'completed', message: 'OK' },
            },
          },
        },
        { now: 3, createMessageId: () => 'msg-3' },
      );
      expect(state.messages.length).toBe(messageCountBeforeWait);

      const block = state.messages
        .flatMap((m) => m.blocks)
        .find((b) => b.type === 'codex_agent_call' && b.callId === 'call-3');
      if (!block || block.type !== 'codex_agent_call') {
        throw new Error('Expected the spawn block in state.messages');
      }
      expect(block.status).toBe('completed');
      expect(block.agentsStates['sub-3']).toEqual({
        status: 'completed',
        message: 'OK',
      });
    });
  });

  it('skips mixed plaintext log lines while preserving renderable transcript entries', () => {
    const transcript = serializeTranscript(
      parseJsonArray(`[
        {
          "type": "assistant",
          "message": {
            "content": [
              {
                "type": "text",
                "text": "Working"
              }
            ]
          }
        }
      ]`),
    );

    const parsed = parseAgentTranscriptLines([
      'agent-prompt: setting_sources ignored for Codex models',
      ...splitTranscriptLines(transcript),
      'Claude session finished',
      '',
    ]);

    expect(parsed.displayMessages).toHaveLength(1);
    expect(parsed.displayMessages[0].blocks[0]).toMatchObject({
      type: 'text',
      text: 'Working',
    });
    expect(parsed.skippedLineCount).toBeGreaterThan(0);
  });

  it('parses wrapped agent-loop events as Claude transcript content', () => {
    const state = applyCodexTranscriptEvent(
      createEmptyTranscriptReducerState(),
      {
        type: 'thread.started',
        thread_id: 'thread-1',
      },
      {
        now: 1,
        createMessageId: (): string => 'msg-1',
      },
    );

    expect(state.providerType).toBe('codex');

    const parsed = parseAgentTranscriptLines([
      JSON.stringify({
        type: 'agent_loop_iteration',
        iteration: 1,
        check: {
          passed: false,
          stdout: 'stdout text',
          stderr: 'stderr text',
          exitCode: 1,
        },
      }),
      JSON.stringify({
        type: 'agent_loop_event',
        iteration: 1,
        event: {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'text',
                text: 'Retrying',
              },
            ],
          },
        },
      }),
    ]);

    expect(parsed.messages).toHaveLength(2);
    const firstBlock = parsed.displayMessages[0].blocks[0];
    expect(firstBlock).toMatchObject({
      type: 'text',
    });
    if (firstBlock.type !== 'text') {
      throw new Error('Expected a text block');
    }
    expect(firstBlock.text).toContain('Iteration 1 check failed');
    expect(parsed.displayMessages[1].blocks[0]).toMatchObject({
      type: 'text',
      text: 'Retrying',
    });
  });

  it('renders providerless Claude error events before later responses', () => {
    const parsed = parseAgentTranscriptLines([
      JSON.stringify({
        type: 'error',
        error: 'Claude failed',
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: 'Recovered response',
            },
          ],
        },
      }),
    ]);

    expect(parsed.displayMessages).toHaveLength(2);
    expect(parsed.displayMessages[0].blocks[0]).toMatchObject({
      type: 'text',
      text: 'Error: Claude failed',
    });
    expect(parsed.displayMessages[1].blocks[0]).toMatchObject({
      type: 'text',
      text: 'Recovered response',
    });
    expect(parsed.skippedLineCount).toBe(0);
  });

  it('renders a generic harness startup error in the transcript', () => {
    let messageIndex = 0;
    const createMessageId = (): string => {
      messageIndex += 1;
      return `msg-${String(messageIndex)}`;
    };
    let state = applyClaudeTranscriptEvent(
      createEmptyTranscriptReducerState(),
      {
        type: 'canopy_user_prompt',
        provider: 'codex',
        original_text: 'Start the session',
      },
      { now: 100, createMessageId },
    );

    state = applyClaudeTranscriptEvent(
      state,
      {
        type: 'error',
        error: 'Agent harness failed during startup',
      },
      { now: 200, createMessageId },
    );

    expect(state.status).toBe('error');
    expect(state.error).toBe('Agent harness failed during startup');
    expect(state.messages).toContainEqual(
      expect.objectContaining({
        role: 'system',
        blocks: [
          {
            type: 'text',
            text: 'Error: Agent harness failed during startup',
          },
        ],
      }),
    );
  });

  it('renders a generic Codex harness startup error when replaying a transcript', () => {
    const parsed = parseAgentTranscriptLines(
      [
        JSON.stringify({
          type: 'canopy_user_prompt',
          provider: 'codex',
          original_text: 'Start the session',
        }),
        JSON.stringify({
          type: 'error',
          error: 'Agent harness failed during startup',
        }),
      ],
      'codex',
    );

    expect(parsed.messages).toContainEqual(
      expect.objectContaining({
        role: 'system',
        blocks: [
          {
            type: 'text',
            text: 'Error: Agent harness failed during startup',
          },
        ],
      }),
    );
  });

  it('does not render user cancellation errors in the transcript', () => {
    const state = applyClaudeTranscriptEvent(
      createEmptyTranscriptReducerState(),
      {
        type: 'error',
        error: 'Claude Code process aborted by user',
      },
      { now: 200, createMessageId: () => 'msg-1' },
    );

    expect(state.status).toBe('error');
    expect(state.error).toBe('Claude Code process aborted by user');
    expect(state.messages).toHaveLength(0);
  });

  it('renders structured error details instead of the provider error code', () => {
    const state = applyClaudeTranscriptEvent(
      createEmptyTranscriptReducerState(),
      {
        type: 'error',
        error: 'billing_error',
        message: {
          content: [{ type: 'text', text: 'Detailed explanation.' }],
        },
      },
      { now: 200, createMessageId: () => 'msg-1' },
    );

    expect(state.status).toBe('error');
    expect(state.error).toBe('billing_error');
    expect(state.messages).toContainEqual(
      expect.objectContaining({
        role: 'system',
        blocks: [{ type: 'text', text: 'Error: Detailed explanation.' }],
      }),
    );
  });

  describe('Codex dynamic_tool_call items', () => {
    it('emits a tool_use block on item.started with raw provider tool name and JSON arguments', () => {
      const transcript = serializeCodexTranscript(
        parseJsonArray(`[
          { "type": "thread.started", "thread_id": "thread-1" },
          {
            "type": "item.started",
            "item": {
              "type": "dynamic_tool_call",
              "id": "call-7",
              "tool": "canopy_get_script_output",
              "arguments": { "scriptId": "build" },
              "status": "in_progress",
              "content_items": null,
              "success": null
            }
          }
        ]`),
      );

      const parsed = parseAgentTranscriptLines(
        splitTranscriptLines(transcript),
      );
      expect(parsed.providerType).toBe('codex');
      expect(parsed.displayMessages).toHaveLength(1);
      const block = parsed.displayMessages[0].blocks[0];
      expect(block).toMatchObject({
        type: 'tool_use',
        toolUseId: 'codex-call-7',
        toolName: 'canopy_get_script_output',
        input: '{"scriptId":"build"}',
      });
      // No tool_result yet because the call is still in progress.
      expect(block.type === 'tool_use' ? block.result : null).toBeUndefined();
    });

    it('emits paired tool_use + tool_result on item.completed and flattens inputText content', () => {
      const transcript = serializeCodexTranscript(
        parseJsonArray(`[
          { "type": "thread.started", "thread_id": "thread-1" },
          {
            "type": "item.completed",
            "item": {
              "type": "dynamic_tool_call",
              "id": "call-9",
              "tool": "canopy_get_script_output",
              "arguments": { "scriptId": "lint" },
              "status": "completed",
              "content_items": [
                { "type": "inputText", "text": "first chunk" },
                { "type": "inputText", "text": "second chunk" }
              ],
              "success": true
            }
          }
        ]`),
      );

      const parsed = parseAgentTranscriptLines(
        splitTranscriptLines(transcript),
      );
      const block = parsed.displayMessages[0].blocks[0];
      expect(block).toMatchObject({
        type: 'tool_use',
        toolName: 'canopy_get_script_output',
        toolUseId: 'codex-call-9',
        result: {
          output: 'first chunk\n\nsecond chunk',
          isError: false,
        },
      });
    });

    it('flattens inputImage to a placeholder and treats success=false as an error', () => {
      const transcript = serializeCodexTranscript(
        parseJsonArray(`[
          { "type": "thread.started", "thread_id": "thread-1" },
          {
            "type": "item.completed",
            "item": {
              "type": "dynamic_tool_call",
              "id": "call-10",
              "tool": "canopy_get_script_output",
              "arguments": {},
              "status": "failed",
              "content_items": [
                { "type": "inputText", "text": "before" },
                { "type": "inputImage", "url": "data:image/png;base64,Z" }
              ],
              "success": false
            }
          }
        ]`),
      );

      const parsed = parseAgentTranscriptLines(
        splitTranscriptLines(transcript),
      );
      const block = parsed.displayMessages[0].blocks[0];
      expect(block).toMatchObject({
        type: 'tool_use',
        toolName: 'canopy_get_script_output',
        result: {
          output: 'before\n\n[image output omitted]',
          isError: true,
        },
      });
    });

    it('falls back to "Done"/"Failed" when content_items is empty', () => {
      const transcript = serializeCodexTranscript(
        parseJsonArray(`[
          { "type": "thread.started", "thread_id": "thread-1" },
          {
            "type": "item.completed",
            "item": {
              "type": "dynamic_tool_call",
              "id": "call-11",
              "tool": "canopy_ask_user_question",
              "arguments": { "questions": [] },
              "status": "completed",
              "content_items": [],
              "success": true
            }
          },
          {
            "type": "item.completed",
            "item": {
              "type": "dynamic_tool_call",
              "id": "call-12",
              "tool": "canopy_ask_user_question",
              "arguments": {},
              "status": "failed",
              "content_items": [],
              "success": false
            }
          }
        ]`),
      );

      const parsed = parseAgentTranscriptLines(
        splitTranscriptLines(transcript),
      );
      const [okBlock, failBlock] = parsed.displayMessages.map(
        (msg) => msg.blocks[0],
      );
      expect(okBlock).toMatchObject({
        type: 'tool_use',
        result: { output: 'Done', isError: false },
      });
      expect(failBlock).toMatchObject({
        type: 'tool_use',
        result: { output: 'Failed', isError: true },
      });
    });

    it('renders the synthetic Codex built-in request_user_input item with raw tool name preserved', () => {
      // Backend emits the built-in `item/tool/requestUserInput` as a
      // synthetic dynamic_tool_call item with `tool: 'request_user_input'`.
      // The renderer should still produce a tool_use block keyed by the
      // synthetic codex-<itemId> id so the ChatBlockRenderer can fold it
      // into the same ask-user UX.
      const transcript = serializeCodexTranscript(
        parseJsonArray(`[
          { "type": "thread.started", "thread_id": "thread-1" },
          {
            "type": "item.completed",
            "item": {
              "type": "dynamic_tool_call",
              "id": "item-42",
              "tool": "request_user_input",
              "arguments": { "questions": [{ "question": "Pick one" }] },
              "status": "completed",
              "content_items": [
                { "type": "inputText", "text": "Q: Pick one\\nA: yes" }
              ],
              "success": true
            }
          }
        ]`),
      );

      const parsed = parseAgentTranscriptLines(
        splitTranscriptLines(transcript),
      );
      const block = parsed.displayMessages[0].blocks[0];
      expect(block).toMatchObject({
        type: 'tool_use',
        toolUseId: 'codex-item-42',
        toolName: 'request_user_input',
        result: {
          output: 'Q: Pick one\nA: yes',
          isError: false,
        },
      });
    });

    it('updates a paused ask-user tool call instead of appending a duplicate after answer', () => {
      const state = applyCodexTranscriptEvent(
        {
          ...createEmptyTranscriptReducerState(),
          status: 'idle',
          sdkSessionId: 'thread-1',
          messages: [
            {
              id: 'user-1',
              role: 'user',
              timestamp: 1000,
              blocks: [{ type: 'text', text: 'Ask me' }],
            },
            {
              id: 'timer-paused',
              role: 'system',
              timestamp: 1000,
              blocks: [
                {
                  type: 'turn_timer',
                  startedAt: 1000,
                  pausedAt: 5000,
                  completedAt: null,
                },
              ],
            },
            {
              id: 'codex-call-1',
              role: 'system',
              timestamp: 4000,
              codexThreadId: 'thread-1',
              codexTurnId: 'turn-1',
              blocks: [
                {
                  type: 'tool_use',
                  toolUseId: 'codex-call-1',
                  toolName: 'canopy_ask_user_question',
                  input: '{"questions":[{"question":"Pick one"}]}',
                },
              ],
            },
          ],
        },
        {
          type: 'item.completed',
          thread_id: 'thread-1',
          turn_id: 'turn-1',
          item: {
            type: 'dynamic_tool_call',
            id: 'call-1',
            tool: 'canopy_ask_user_question',
            arguments: { questions: [{ question: 'Pick one' }] },
            status: 'completed',
            content_items: [{ type: 'inputText', text: 'Q: Pick one\nA: yes' }],
            success: true,
          },
        },
        {
          now: 7000,
          createMessageId: () => 'timer-resumed',
        },
      );

      const askUserMessages = state.messages.filter(
        (message) => message.id === 'codex-call-1',
      );
      expect(askUserMessages).toHaveLength(1);
      expect(askUserMessages[0].blocks).toEqual([
        expect.objectContaining({
          type: 'tool_use',
          toolUseId: 'codex-call-1',
        }),
        expect.objectContaining({
          type: 'tool_result',
          toolUseId: 'codex-call-1',
          output: 'Q: Pick one\nA: yes',
        }),
      ]);
      expect(
        state.messages.filter((message) => message.id === 'timer-resumed'),
      ).toHaveLength(0);
      expect(
        state.messages
          .flatMap((message) => message.blocks)
          .filter((block) => block.type === 'turn_timer'),
      ).toEqual([
        {
          type: 'turn_timer',
          startedAt: 1000,
          pausedAt: 5000,
          resumedAt: 7000,
          accumulatedPausedDurationMs: 2000,
          completedAt: null,
        },
      ]);
    });
  });

  describe('Codex image items', () => {
    it('projects generated output but not project image-view input', () => {
      const transcript = serializeCodexTranscript(
        parseJsonArray(`[
          { "type": "thread.started", "thread_id": "thread-1" },
          {
            "type": "item.completed",
            "item": {
              "type": "image_generation",
              "id": "generated-1",
              "status": "completed",
              "revised_prompt": "A luminous tree above a midnight ocean",
              "saved_path": "/Users/example/.codex/generated_images/generated-1.png"
            }
          },
          {
            "type": "item.completed",
            "item": {
              "type": "image_view",
              "id": "viewed-1",
              "path": "/Users/example/.codex/generated_images/generated-1.png"
            }
          }
        ]`),
      );

      const parsed = parseAgentTranscriptLines(
        splitTranscriptLines(transcript),
      );
      expect(parsed.messages).toHaveLength(1);
      expect(parsed.messages[0]).toMatchObject({
        role: 'assistant',
        blocks: [
          {
            type: 'image',
            path: '/Users/example/.codex/generated_images/generated-1.png',
            alt: 'A luminous tree above a midnight ocean',
          },
        ],
      });
    });

    it('reports failed image generation without presenting the image as successful output', () => {
      const transcript = serializeCodexTranscript(
        parseJsonArray(`[
          { "type": "thread.started", "thread_id": "thread-1" },
          {
            "type": "item.completed",
            "item": {
              "type": "image_generation",
              "id": "generated-1",
              "status": "failed",
              "saved_path": "/Users/example/.codex/generated_images/generated-1.png"
            }
          }
        ]`),
      );

      const parsed = parseAgentTranscriptLines(
        splitTranscriptLines(transcript),
      );
      expect(parsed.messages.flatMap((message) => message.blocks)).toEqual([
        { type: 'text', text: 'Image generation failed.' },
      ]);
    });
  });

  describe('Codex command_execution / file_change approval gating', () => {
    it('does not attach a tool_result while a command_execution item is still in progress', () => {
      const transcript = serializeCodexTranscript(
        parseJsonArray(`[
          { "type": "thread.started", "thread_id": "thread-1" },
          {
            "type": "item.started",
            "item": {
              "type": "command_execution",
              "id": "cmd-1",
              "command": "rm -rf /tmp/x",
              "aggregated_output": "",
              "status": "inProgress"
            }
          }
        ]`),
      );

      const parsed = parseAgentTranscriptLines(
        splitTranscriptLines(transcript),
      );
      expect(parsed.displayMessages).toHaveLength(1);
      const block = parsed.displayMessages[0].blocks[0];
      expect(block).toMatchObject({
        type: 'tool_use',
        toolUseId: 'codex-cmd-1',
        toolName: 'command',
      });
      expect(block.type === 'tool_use' ? block.result : null).toBeUndefined();
    });

    it('attaches the tool_result once the command_execution item completes', () => {
      const state1 = applyCodexTranscriptEvent(
        createEmptyTranscriptReducerState(),
        {
          type: 'item.started',
          thread_id: 'thread-1',
          item: {
            type: 'command_execution',
            id: 'cmd-2',
            command: 'ls',
            aggregated_output: '',
            status: 'inProgress',
          },
        },
        { now: 1000, createMessageId: () => 'unused-1' },
      );

      const messageBefore = state1.messages.find((message) =>
        message.blocks.some(
          (block) =>
            block.type === 'tool_use' && block.toolUseId === 'codex-cmd-2',
        ),
      );
      const blockBefore = messageBefore?.blocks[0];
      expect(blockBefore).not.toHaveProperty('result');
      expect(messageBefore?.blocks).toHaveLength(1);

      const state2 = applyCodexTranscriptEvent(
        state1,
        {
          type: 'item.completed',
          thread_id: 'thread-1',
          item: {
            type: 'command_execution',
            id: 'cmd-2',
            command: 'ls',
            aggregated_output: 'file.txt',
            status: 'completed',
            exit_code: 0,
          },
        },
        { now: 2000, createMessageId: () => 'unused-2' },
      );

      const messageAfter = state2.messages.find((message) =>
        message.blocks.some(
          (block) =>
            block.type === 'tool_use' && block.toolUseId === 'codex-cmd-2',
        ),
      );
      expect(messageAfter?.blocks).toEqual([
        expect.objectContaining({
          type: 'tool_use',
          toolUseId: 'codex-cmd-2',
        }),
        expect.objectContaining({
          type: 'tool_result',
          toolUseId: 'codex-cmd-2',
          output: 'file.txt',
          isError: false,
        }),
      ]);
    });

    it.each(['failed', 'declined'])(
      'attaches a tool_result for a %s command_execution item without waiting for item.completed',
      (status) => {
        const transcript = serializeCodexTranscript(
          parseJsonArray(`[
            { "type": "thread.started", "thread_id": "thread-1" },
            {
              "type": "item.started",
              "item": {
                "type": "command_execution",
                "id": "cmd-3",
                "command": "rm -rf /",
                "aggregated_output": "",
                "status": "${status}"
              }
            }
          ]`),
        );

        const parsed = parseAgentTranscriptLines(
          splitTranscriptLines(transcript),
        );
        const block = parsed.displayMessages[0].blocks[0];
        expect(block.type === 'tool_use' ? block.result : null).toMatchObject({
          isError: true,
        });
      },
    );

    it('does not attach a tool_result while a file_change item is still in progress', () => {
      const transcript = serializeCodexTranscript(
        parseJsonArray(`[
          { "type": "thread.started", "thread_id": "thread-1" },
          {
            "type": "item.started",
            "item": {
              "type": "file_change",
              "id": "patch-1",
              "changes": [{ "kind": "update", "path": "src/app.ts" }],
              "status": "inProgress"
            }
          }
        ]`),
      );

      const parsed = parseAgentTranscriptLines(
        splitTranscriptLines(transcript),
      );
      expect(parsed.displayMessages).toHaveLength(1);
      const block = parsed.displayMessages[0].blocks[0];
      expect(block).toMatchObject({
        type: 'tool_use',
        toolUseId: 'codex-patch-1',
        toolName: 'file_change',
      });
      expect(block.type === 'tool_use' ? block.result : null).toBeUndefined();
    });

    it('attaches the tool_result once the file_change item completes', () => {
      const state1 = applyCodexTranscriptEvent(
        createEmptyTranscriptReducerState(),
        {
          type: 'item.started',
          thread_id: 'thread-1',
          item: {
            type: 'file_change',
            id: 'patch-2',
            changes: [{ kind: 'update', path: 'src/app.ts' }],
            status: 'inProgress',
          },
        },
        { now: 1000, createMessageId: () => 'unused-3' },
      );

      const messageBefore = state1.messages.find((message) =>
        message.blocks.some(
          (block) =>
            block.type === 'tool_use' && block.toolUseId === 'codex-patch-2',
        ),
      );
      expect(messageBefore?.blocks).toHaveLength(1);

      const state2 = applyCodexTranscriptEvent(
        state1,
        {
          type: 'item.completed',
          thread_id: 'thread-1',
          item: {
            type: 'file_change',
            id: 'patch-2',
            changes: [{ kind: 'update', path: 'src/app.ts' }],
            status: 'completed',
          },
        },
        { now: 2000, createMessageId: () => 'unused-4' },
      );

      const messageAfter = state2.messages.find((message) =>
        message.blocks.some(
          (block) =>
            block.type === 'tool_use' && block.toolUseId === 'codex-patch-2',
        ),
      );
      expect(messageAfter?.blocks).toEqual([
        expect.objectContaining({
          type: 'tool_use',
          toolUseId: 'codex-patch-2',
        }),
        expect.objectContaining({
          type: 'tool_result',
          toolUseId: 'codex-patch-2',
          output: 'completed',
          isError: false,
        }),
      ]);
    });

    it.each(['failed', 'declined'])(
      'attaches a tool_result for a %s file_change item without waiting for item.completed',
      (status) => {
        const transcript = serializeCodexTranscript(
          parseJsonArray(`[
            { "type": "thread.started", "thread_id": "thread-1" },
            {
              "type": "item.started",
              "item": {
                "type": "file_change",
                "id": "patch-3",
                "changes": [{ "kind": "update", "path": "src/app.ts" }],
                "status": "${status}"
              }
            }
          ]`),
        );

        const parsed = parseAgentTranscriptLines(
          splitTranscriptLines(transcript),
        );
        const block = parsed.displayMessages[0].blocks[0];
        expect(block.type === 'tool_use' ? block.result : null).toMatchObject({
          isError: true,
        });
      },
    );
  });

  describe('Codex mcp_tool_call items', () => {
    const pendingItem = {
      type: 'mcp_tool_call',
      id: 'mcp-call-1',
      server: 'github',
      tool: 'create_issue',
      arguments: { title: 'Retry safety' },
      status: 'inProgress',
      result: null,
      error: null,
    };

    it('creates one pending system message containing only tool_use on start', () => {
      const state = applyCodexTranscriptEvent(
        createEmptyTranscriptReducerState(),
        {
          type: 'item.started',
          thread_id: 'thread-1',
          turn_id: 'turn-1',
          item: pendingItem,
        },
        { now: 1, createMessageId: () => 'unused' },
      );

      expect(state.messages).toEqual([
        {
          id: 'codex-mcp-call-1',
          role: 'system',
          blocks: [
            {
              type: 'tool_use',
              toolUseId: 'codex-mcp-call-1',
              toolName: 'mcp__github__create_issue',
              input: '{"title":"Retry safety"}',
            },
          ],
          timestamp: 1,
          codexThreadId: 'thread-1',
          codexTurnId: 'turn-1',
        },
      ]);
    });

    it('updates the pending representation without appending a message', () => {
      let state = applyCodexTranscriptEvent(
        createEmptyTranscriptReducerState(),
        {
          type: 'item.started',
          thread_id: 'thread-1',
          turn_id: 'turn-1',
          item: pendingItem,
        },
        { now: 1, createMessageId: () => 'unused-1' },
      );
      state = applyCodexTranscriptEvent(
        state,
        {
          type: 'item.updated',
          thread_id: 'thread-1',
          turn_id: 'turn-1',
          item: { ...pendingItem, progress: 'Creating issue' },
        },
        { now: 2, createMessageId: () => 'unused-2' },
      );

      expect(state.messages).toHaveLength(1);
      expect(state.messages[0].blocks).toEqual([
        expect.objectContaining({
          type: 'tool_use',
          toolUseId: 'codex-mcp-call-1',
        }),
      ]);
    });

    it('keeps terminal-looking start and update events pending', () => {
      let state = createEmptyTranscriptReducerState();
      let now = 0;
      const events = [
        { type: 'item.started' as const, status: 'completed' },
        { type: 'item.updated' as const, status: 'failed' },
      ];
      for (const event of events) {
        now += 1;
        state = applyCodexTranscriptEvent(
          state,
          {
            type: event.type,
            thread_id: 'thread-1',
            turn_id: 'turn-1',
            item: {
              ...pendingItem,
              status: event.status,
              result: {
                content: [{ type: 'text', text: 'not terminal yet' }],
              },
              error:
                event.type === 'item.started'
                  ? null
                  : { message: 'not terminal yet' },
            },
          },
          { now, createMessageId: () => 'unused' },
        );

        expect(state.messages).toHaveLength(1);
        expect(state.messages[0].blocks).toEqual([
          expect.objectContaining({
            type: 'tool_use',
            toolUseId: 'codex-mcp-call-1',
          }),
        ]);
      }
    });

    it('replaces the pending representation with paired blocks on completion', () => {
      let state = applyCodexTranscriptEvent(
        createEmptyTranscriptReducerState(),
        {
          type: 'item.started',
          thread_id: 'thread-1',
          turn_id: 'turn-1',
          item: pendingItem,
        },
        { now: 1, createMessageId: () => 'unused-1' },
      );
      state = applyCodexTranscriptEvent(
        state,
        {
          type: 'item.completed',
          thread_id: 'thread-1',
          turn_id: 'turn-1',
          item: {
            ...pendingItem,
            status: 'completed',
            result: {
              content: [{ type: 'text', text: 'Created issue #42' }],
            },
          },
        },
        { now: 2, createMessageId: () => 'unused-2' },
      );

      expect(state.messages).toHaveLength(1);
      expect(state.messages[0].blocks).toEqual([
        {
          type: 'tool_use',
          toolUseId: 'codex-mcp-call-1',
          toolName: 'mcp__github__create_issue',
          input: '{"title":"Retry safety"}',
        },
        {
          type: 'tool_result',
          toolUseId: 'codex-mcp-call-1',
          toolName: 'mcp__github__create_issue',
          output: 'Created issue #42',
          isError: false,
        },
      ]);
    });

    it('retains all MCP content items after image-preview preprocessing', () => {
      const state = applyCodexTranscriptEvent(
        createEmptyTranscriptReducerState(),
        {
          type: 'item.completed',
          thread_id: 'thread-1',
          turn_id: 'turn-1',
          item: {
            ...pendingItem,
            status: 'completed',
            result: {
              content: Array.from({ length: 250 }, (_, index) => ({
                type: 'text',
                text: `item-${String(index)}`,
              })),
            },
          },
        },
        { now: 1, createMessageId: () => 'unused' },
      );

      const resultBlock = state.messages[0].blocks.find(
        (block) => block.type === 'tool_result',
      );
      expect(
        resultBlock?.type === 'tool_result' ? resultBlock.output : '',
      ).toContain('item-249');
      expect(
        resultBlock?.type === 'tool_result' ? resultBlock.output : '',
      ).not.toContain('additional content items omitted');
    });

    it('replaces duplicate completion idempotently without appending', () => {
      const completedEvent = {
        type: 'item.completed',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        item: {
          ...pendingItem,
          status: 'completed',
          result: {
            content: [{ type: 'text', text: 'Created issue #42' }],
          },
        },
      };
      let state = applyCodexTranscriptEvent(
        createEmptyTranscriptReducerState(),
        completedEvent,
        { now: 1, createMessageId: () => 'unused-1' },
      );
      state = applyCodexTranscriptEvent(state, completedEvent, {
        now: 2,
        createMessageId: () => 'unused-2',
      });

      expect(state.messages).toHaveLength(1);
      expect(
        state.messages[0].blocks.filter(
          (block) => block.type === 'tool_result',
        ),
      ).toHaveLength(1);
    });

    it('does not regress a completion-first item after stale start and update events', () => {
      let state = applyCodexTranscriptEvent(
        createEmptyTranscriptReducerState(),
        {
          type: 'item.completed',
          thread_id: 'thread-1',
          turn_id: 'turn-1',
          item: {
            ...pendingItem,
            status: 'completed',
            result: {
              content: [{ type: 'text', text: 'Created issue #42' }],
            },
          },
        },
        { now: 1, createMessageId: () => 'unused-1' },
      );
      const terminalMessage = state.messages[0];

      for (const type of ['item.started', 'item.updated'] as const) {
        state = applyCodexTranscriptEvent(
          state,
          {
            type,
            thread_id: 'thread-1',
            turn_id: 'turn-1',
            item: {
              ...pendingItem,
              status: 'completed',
              result: {
                content: [{ type: 'text', text: 'stale replacement' }],
              },
            },
          },
          { now: 2, createMessageId: () => 'unused-2' },
        );
      }

      expect(state.messages).toEqual([terminalMessage]);
      expect(
        state.messages[0].blocks.filter(
          (block) => block.type === 'tool_result',
        ),
      ).toHaveLength(1);
    });

    it('marks content-level and transport-level failures as errors', () => {
      const parsed = parseAgentTranscriptLines([
        JSON.stringify({
          type: 'item.completed',
          item: {
            ...pendingItem,
            id: 'content-failure',
            status: 'failed',
            result: {
              content: [{ type: 'text', text: 'permission denied' }],
            },
          },
        }),
        JSON.stringify({
          type: 'item.completed',
          item: {
            ...pendingItem,
            id: 'transport-failure',
            status: 'failed',
            result: null,
            error: { message: 'connection reset' },
          },
        }),
      ]);

      const results = parsed.messages.flatMap((message) =>
        message.blocks.filter((block) => block.type === 'tool_result'),
      );
      expect(results).toEqual([
        expect.objectContaining({
          output: 'permission denied',
          isError: true,
        }),
        expect.objectContaining({
          output: 'connection reset',
          isError: true,
        }),
      ]);
    });

    it('keeps concurrent item IDs independent and in first-appearance order', () => {
      const parsed = parseAgentTranscriptLines([
        JSON.stringify({
          type: 'item.started',
          item: { ...pendingItem, id: 'first' },
        }),
        JSON.stringify({
          type: 'item.started',
          item: { ...pendingItem, id: 'second' },
        }),
        JSON.stringify({
          type: 'item.completed',
          item: {
            ...pendingItem,
            id: 'second',
            status: 'completed',
            result: { content: [{ type: 'text', text: 'second done' }] },
          },
        }),
        JSON.stringify({
          type: 'item.completed',
          item: {
            ...pendingItem,
            id: 'first',
            status: 'completed',
            result: { content: [{ type: 'text', text: 'first done' }] },
          },
        }),
      ]);

      expect(parsed.messages.map((message) => message.id)).toEqual([
        'codex-first',
        'codex-second',
      ]);
      expect(
        parsed.messages.map(
          (message) =>
            message.blocks.find((block) => block.type === 'tool_result')
              ?.output,
        ),
      ).toEqual(['first done', 'second done']);
    });

    it('preserves thread, turn, and parent routing metadata through completion', () => {
      const parsed = parseAgentTranscriptLines([
        JSON.stringify({
          type: 'thread.started',
          thread_id: 'root-thread',
        }),
        JSON.stringify({
          type: 'item.completed',
          thread_id: 'root-thread',
          turn_id: 'root-turn',
          item: {
            type: 'collab_agent_tool_call',
            id: 'parent-call',
            tool: 'spawnAgent',
            status: 'completed',
            sender_thread_id: 'root-thread',
            receiver_thread_ids: ['sub-thread'],
            prompt: 'Inspect logs',
            agents_states: {
              'sub-thread': { status: 'running', message: null },
            },
          },
        }),
        JSON.stringify({
          type: 'item.started',
          thread_id: 'sub-thread',
          turn_id: 'sub-turn',
          item: pendingItem,
        }),
        JSON.stringify({
          type: 'item.completed',
          item: {
            ...pendingItem,
            status: 'completed',
            result: { content: [{ type: 'text', text: 'done' }] },
          },
        }),
      ]);

      expect(
        parsed.messages.find((message) => message.id === 'codex-mcp-call-1'),
      ).toMatchObject({
        codexThreadId: 'sub-thread',
        codexTurnId: 'sub-turn',
        parentBlockId: 'codex-agent-parent-call',
      });
    });

    it('replays multiple sanitized MCP calls alongside assistant messages', () => {
      const parsed = parseAgentTranscriptLines([
        JSON.stringify({
          type: 'thread.started',
          thread_id: 'thread-1',
        }),
        JSON.stringify({
          type: 'item.completed',
          item: {
            ...pendingItem,
            id: 'logs',
            server: 'appproxy-internal-hub-prod--opaque',
            tool: 'query-gcp-logs',
            status: 'completed',
            result: { content: [{ type: 'text', text: 'No errors' }] },
          },
        }),
        JSON.stringify({
          type: 'item.completed',
          item: {
            ...pendingItem,
            id: 'issue',
            status: 'completed',
            result: { content: [{ type: 'text', text: 'Issue created' }] },
          },
        }),
        JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'agent_message',
            id: 'answer',
            text: 'The service is healthy.',
          },
        }),
      ]);

      expect(parsed.messages.map((message) => message.id)).toEqual([
        'codex-logs',
        'codex-issue',
        'codex-answer',
      ]);
      expect(parsed.messages[0].blocks[0]).toMatchObject({
        type: 'tool_use',
        toolName: 'mcp__appproxy-internal-hub-prod--opaque__query-gcp-logs',
      });
      expect(parsed.messages[2]).toMatchObject({
        role: 'assistant',
        blocks: [{ type: 'text', text: 'The service is healthy.' }],
      });
    });
  });

  it('renders audit-sidecar synthetic user prompts without rendering injected prompt metadata lines', () => {
    const parsed = parseAgentTranscriptLines([
      JSON.stringify({
        type: 'canopy_user_prompt',
        provider: 'codex',
        original_text: 'Implement the approved plan',
        submitted_text: 'Implement the approved plan',
        plan_mode: true,
      }),
      JSON.stringify({
        type: 'canopy_injected_prompt',
        kind: 'plan_mode_developer_instructions',
        provider: 'codex',
        application_condition: 'plan_mode_enabled',
        text: 'Plan mode instructions',
      }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          id: 'msg-1',
          text: 'Working through the steps',
        },
      }),
    ]);

    expect(parsed.providerType).toBe('codex');
    expect(parsed.messages[1].blocks[0]).toMatchObject({
      type: 'turn_timer',
      completedAt: null,
    });
    expect(parsed.displayMessages).toHaveLength(3);
    expect(parsed.displayMessages[0].role).toBe('user');
    expect(parsed.displayMessages[0].blocks[0]).toMatchObject({
      type: 'text',
      text: 'Implement the approved plan',
    });
    expect(parsed.displayMessages[1].blocks[0]).toMatchObject({
      type: 'text',
      text: 'Working through the steps',
    });
    expect(parsed.displayMessages[2].blocks[0]).toMatchObject({
      type: 'turn_timer',
      completedAt: null,
    });
  });

  it('excludes the deferred-tools reload continuation and keeps the resumed segment on one turn', () => {
    const parsed = parseAgentTranscriptLines([
      JSON.stringify({
        type: 'canopy_user_prompt',
        provider: 'codex',
        original_text: 'Use the deferred skill',
        submitted_text: 'Use the deferred skill',
        canopy_turn_user_message_id: 'user-turn-1',
      }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          id: 'seg-1',
          text: 'Let me enable that first',
        },
      }),
      // The hidden reload continuation must never render as a visible message.
      JSON.stringify({
        type: 'canopy_injected_prompt',
        kind: 'system_prompt_append',
        provider: 'codex',
        application_condition: 'deferred_tools_reload_continuation',
        text: '<system_instruction>Requested items now enabled, continue the interrupted request.</system_instruction>',
        deferred_tools_reload: {
          enabled_resources: [{ ref: 'r1', kind: 'skill', name: 'My Skill' }],
        },
      }),
      // The resumed provider segment stays attached to the original turn.
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          id: 'seg-2',
          text: 'Done using the newly enabled skill',
        },
      }),
    ]);

    // The injected continuation is not visible; only the two assistant
    // segments, the single user bubble, and the single (still-open) turn timer.
    const injectedText = parsed.displayMessages.flatMap((message) =>
      message.blocks.flatMap((block) =>
        block.type === 'text' ? [block.text] : [],
      ),
    );
    expect(injectedText).not.toContain(
      '<system_instruction>Requested items now enabled, continue the interrupted request.</system_instruction>',
    );

    const userMessages = parsed.displayMessages.filter(
      (message) => message.role === 'user',
    );
    expect(userMessages).toHaveLength(1);

    const timerBlocks = parsed.displayMessages.flatMap((message) =>
      message.blocks.filter((block) => block.type === 'turn_timer'),
    );
    expect(timerBlocks).toHaveLength(1);
    expect(timerBlocks[0]).toMatchObject({ completedAt: null });

    // Both assistant segments remain and read as one continuous turn.
    expect(injectedText).toContain('Let me enable that first');
    expect(injectedText).toContain('Done using the newly enabled skill');
  });

  it('drops the deferred-tools reload continuation on the Claude reducer (only bumps lastEventAt)', () => {
    const base = {
      ...createEmptyTranscriptReducerState(),
      status: 'streaming' as const,
      providerType: 'claude' as const,
    };
    const next = applyClaudeTranscriptEvent(
      base,
      {
        type: 'canopy_injected_prompt',
        kind: 'system_prompt_append',
        provider: 'claude',
        application_condition: 'deferred_tools_reload_continuation',
        text: '<system_instruction>Requested items now enabled, continue the interrupted request.</system_instruction>',
      },
      { now: 4242, createMessageId: () => 'should-not-be-used' },
    );

    // No new message is materialized; only lastEventAt advances.
    expect(next.messages).toEqual(base.messages);
    expect(next.lastEventAt).toBe(4242);
  });

  it('reopens an idle Codex turn when a late agent response arrives after completion', () => {
    const state = applyCodexTranscriptEvent(
      {
        ...createEmptyTranscriptReducerState(),
        status: 'idle',
        providerType: 'codex',
        messages: [
          {
            id: 'user-1',
            role: 'user',
            blocks: [{ type: 'text', text: 'Keep working' }],
            timestamp: 1,
          },
          {
            id: 'timer-1',
            role: 'system',
            blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 2 }],
            timestamp: 1,
          },
        ],
      },
      {
        type: 'item.completed',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        item: {
          type: 'agent_message',
          id: 'late-message',
          text: 'Still working.',
        },
      },
      {
        now: 3,
        createMessageId: (): string => 'message-3',
      },
    );

    expect(state.status).toBe('streaming');
    expect(state.messages[1].blocks[0]).toMatchObject({
      type: 'turn_timer',
      completedAt: null,
    });
    expect(state.messages[2].blocks[0]).toMatchObject({
      type: 'text',
      text: 'Still working.',
    });
  });

  it('does not reopen an idle Codex turn for a late dynamic tool result', () => {
    const state = applyCodexTranscriptEvent(
      {
        ...createEmptyTranscriptReducerState(),
        status: 'idle',
        providerType: 'codex',
        messages: [
          {
            id: 'user-1',
            role: 'user',
            blocks: [{ type: 'text', text: 'Check logs' }],
            timestamp: 1,
          },
          {
            id: 'timer-1',
            role: 'system',
            blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 2 }],
            timestamp: 1,
          },
        ],
      },
      {
        type: 'item.completed',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        item: {
          type: 'dynamic_tool_call',
          id: 'late-tool',
          tool: 'canopy_get_script_output',
          arguments: {},
          status: 'completed',
          content_items: [{ type: 'inputText', text: 'Output' }],
          success: true,
        },
      },
      {
        now: 3,
        createMessageId: (): string => 'message-3',
      },
    );

    expect(state.status).toBe('idle');
    expect(state.messages[1].blocks[0]).toMatchObject({
      type: 'turn_timer',
      completedAt: 2,
    });
    expect(state.messages[2].blocks[0]).toMatchObject({
      type: 'tool_use',
      toolName: 'canopy_get_script_output',
    });
  });

  it('renders helper diagnostics from audit-sidecar transcripts', () => {
    const parsed = parseAgentTranscriptLines([
      JSON.stringify({
        type: 'canopy_helper_diagnostic',
        helper: 'branch_naming',
        timestamp: '2026-06-19T12:00:00.000Z',
        level: 'error',
        attempt: 2,
        message: 'Codex branch naming turn failed',
      }),
    ]);

    expect(parsed.skippedLineCount).toBe(0);
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.displayMessages[0].role).toBe('system');
    expect(parsed.displayMessages[0].blocks[0]).toMatchObject({
      type: 'text',
      text:
        'Branch naming diagnostic\n' +
        'level: error\n' +
        'attempt: 2\n' +
        'message: Codex branch naming turn failed',
    });
  });

  it('uses provided transcript turn timestamps for synthetic turn timers', () => {
    const startedAt = Date.parse('2026-05-27T15:56:14.949Z');
    const completedAt = Date.parse('2026-05-27T16:02:14.949Z');
    const parsed = parseAgentTranscriptLines(
      [
        JSON.stringify({
          type: 'canopy_user_prompt',
          provider: 'claude',
          original_text: 'Implement the transport layer plan',
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Working' }],
          },
        }),
        JSON.stringify({
          type: 'result',
          is_error: false,
        }),
      ],
      undefined,
      {
        turnStartedAt: startedAt,
        turnCompletedAt: completedAt,
      },
    );

    const timerBlock = parsed.messages
      .flatMap((message) => message.blocks)
      .find((block) => block.type === 'turn_timer');
    expect(timerBlock).toEqual({
      type: 'turn_timer',
      startedAt,
      completedAt,
    });
  });

  it('does not synthesize line-number turn times for transcript turn timers', () => {
    const parsed = parseAgentTranscriptLines([
      JSON.stringify({
        type: 'canopy_user_prompt',
        provider: 'claude',
        original_text: 'Implement the transport layer plan',
      }),
      JSON.stringify({
        type: 'result',
        is_error: false,
      }),
    ]);

    const timerBlock = parsed.messages
      .flatMap((message) => message.blocks)
      .find((block) => block.type === 'turn_timer');
    expect(timerBlock).toEqual({
      type: 'turn_timer',
      completedAt: null,
    });
  });

  it('coalesces duplicate Codex commentary and final answer text in the same turn', () => {
    const text =
      'I need the exact message to send to your current worktree chat.';
    const parsed = parseAgentTranscriptLines([
      JSON.stringify({
        type: 'canopy_user_prompt',
        provider: 'codex',
        original_text: 'send a chat message to my current worktree chat',
        submitted_text: 'send a chat message to my current worktree chat',
        plan_mode: false,
      }),
      JSON.stringify({
        type: 'turn.started',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
      }),
      JSON.stringify({
        type: 'item.completed',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        item: {
          type: 'agent_message',
          id: 'msg-commentary',
          text,
          phase: 'commentary',
        },
      }),
      JSON.stringify({
        type: 'item.completed',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        item: {
          type: 'agent_message',
          id: 'msg-final',
          text,
          phase: 'final_answer',
        },
      }),
      JSON.stringify({
        type: 'turn.completed',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
      }),
    ]);

    const assistantTextMessages = parsed.messages.filter(
      (message) =>
        message.role === 'assistant' &&
        message.blocks.length === 1 &&
        message.blocks[0]?.type === 'text',
    );

    expect(assistantTextMessages).toHaveLength(1);
    expect(assistantTextMessages[0]).toMatchObject({
      id: 'codex-msg-final',
      blocks: [{ type: 'text', text }],
    });
    expect(
      parsed.displayMessages.filter(
        (message) =>
          message.role === 'assistant' &&
          message.blocks.some(
            (block) => block.type === 'text' && block.text === text,
          ),
      ),
    ).toHaveLength(1);
  });

  it('keeps per-event Codex transcript work linear in transcript length', () => {
    const applyAll = (events: Record<string, unknown>[]): number => {
      let messageIndex = 0;
      let state = createEmptyTranscriptReducerState();
      for (const event of events) {
        messageIndex += 1;
        state = applyCodexTranscriptEvent(state, event, {
          now: messageIndex,
          createMessageId: () => `msg-${String(messageIndex)}`,
        });
      }
      expect(state.usage?.numTurns).toBe(
        events.filter((event) => event.type === 'turn.started').length,
      );
      return state.messages.length;
    };

    // Counted scans, not wall-clock time: a loaded CI shard cannot fail this.
    // Each event appends to an immutable message list and scans it a bounded
    // number of times, so total work grows quadratically (about 4x when the
    // transcript doubles). A per-event scan nested inside another would push
    // the growth towards 8x.
    const growth = workGrowth(
      (turns) => buildCodexPerformanceEvents({ turns, toolsPerTurn: 5 }),
      applyAll,
      125,
    );
    expect(growth).toBeLessThan(4.5);
  });

  it('keeps a single large command output manageable on the Codex path', () => {
    const events = buildCodexPerformanceEvents({
      turns: 500,
      toolsPerTurn: 3,
      commandOutputChars: 500_000,
    });

    let messageIndex = 0;
    const durationMs = measureDurationMs(() => {
      let state = createEmptyTranscriptReducerState();
      for (const event of events) {
        messageIndex += 1;
        state = applyCodexTranscriptEvent(state, event, {
          now: messageIndex,
          createMessageId: () => `large-output-msg-${String(messageIndex)}`,
        });
      }
      expect(state.messages.length).toBeGreaterThan(0);
    });

    expect(durationMs).toBeLessThan(5_000);
  });

  it('keeps MCP-heavy transcripts within budget without duplicating structured content', () => {
    const largeStructuredContent = 'x'.repeat(500_000);
    const events = buildCodexPerformanceEvents({
      turns: 400,
      toolsPerTurn: 0,
      mcpToolsPerTurn: 3,
      mcpStructuredContentChars: largeStructuredContent.length,
    });

    let messageIndex = 0;
    let state = createEmptyTranscriptReducerState();
    const durationMs = measureDurationMs(() => {
      for (const event of events) {
        messageIndex += 1;
        state = applyCodexTranscriptEvent(state, event, {
          now: messageIndex,
          createMessageId: () => `mcp-heavy-msg-${String(messageIndex)}`,
        });
      }
    });

    const firstMcpMessage = state.messages.find(
      (message) => message.id === 'codex-mcp-0-0',
    );
    expect(firstMcpMessage?.blocks).toEqual([
      expect.objectContaining({
        type: 'tool_use',
        toolUseId: 'codex-mcp-0-0',
      }),
      expect.objectContaining({
        type: 'tool_result',
        output: 'mcp-output-0-0',
        isError: false,
      }),
    ]);
    const persistedOutput = firstMcpMessage?.blocks.find(
      (block) => block.type === 'tool_result',
    )?.output;
    expect(persistedOutput).not.toContain(largeStructuredContent);
    expect(state.usage?.numTurns).toBe(400);
    expect(durationMs).toBeLessThan(5_000);
  });
});

describe('Claude usage-limit detection', () => {
  it('sets banner metadata on an assistant rate_limit event without mutating messages', () => {
    const state = {
      ...createEmptyTranscriptReducerState(),
      messages: [
        {
          id: 'existing',
          role: 'assistant' as const,
          blocks: [{ type: 'text' as const, text: 'Earlier reply' }],
          timestamp: 1,
        },
      ],
    };

    const next = applyClaudeTranscriptEvent(
      state,
      {
        type: 'assistant',
        error: 'rate_limit',
        request_id: 'req-123',
        message: { content: [] },
      },
      { now: 5000, createMessageId: () => 'msg-1' },
    );

    expect(next.llmProviderUsageLimitBanner).toMatchObject({
      provider: 'claude',
      message: 'Claude usage limit reached.',
      detectedAt: 5000,
      requestId: 'req-123',
      dismissKey: 'req-123',
    });
    // Transcript is untouched.
    expect(next.messages).toEqual(state.messages);
  });

  it('sets banner metadata on a result 429 event, preferring the result string', () => {
    const next = applyClaudeTranscriptEvent(
      createEmptyTranscriptReducerState(),
      {
        type: 'result',
        is_error: true,
        api_error_status: 429,
        result: 'Claude usage limit reached for your plan.',
        usage: { input_tokens: 1, output_tokens: 2 },
      },
      { now: 7000, createMessageId: () => 'msg-1' },
    );

    expect(next.llmProviderUsageLimitBanner).toMatchObject({
      provider: 'claude',
      message: 'Claude usage limit reached for your plan.',
      detectedAt: 7000,
    });
    // No request id on result events => fallback dismissKey derived from
    // stable transcript identity rather than wall-clock parse time.
    expect(next.llmProviderUsageLimitBanner?.requestId).toBeUndefined();
    expect(next.llmProviderUsageLimitBanner?.dismissKey).toContain(
      'usage-limit:',
    );
  });

  it('does not set banner metadata on a non-rate-limit error result', () => {
    const next = applyClaudeTranscriptEvent(
      createEmptyTranscriptReducerState(),
      {
        type: 'result',
        is_error: true,
        api_error_status: 500,
        result: 'Internal error',
      },
      { now: 8000, createMessageId: () => 'msg-1' },
    );

    expect(next.llmProviderUsageLimitBanner).toBeUndefined();
  });

  it('does not set usage banner metadata for an expired OAuth 429', () => {
    const next = applyClaudeTranscriptEvent(
      createEmptyTranscriptReducerState(),
      {
        type: 'result',
        is_error: true,
        api_error_status: 429,
        result:
          'Failed to authenticate: OAuth session expired and could not be refreshed',
      },
      { now: 8000, createMessageId: () => 'msg-1' },
    );

    expect(next.llmProviderUsageLimitBanner).toBeUndefined();
  });

  it('projects an expired Claude OAuth result into a trusted recovery message', () => {
    const result =
      'Failed to authenticate: OAuth session expired and could not be refreshed';
    const next = applyClaudeTranscriptEvent(
      createEmptyTranscriptReducerState(),
      {
        type: 'result',
        is_error: true,
        api_error_status: 429,
        result,
      },
      { now: 8000, createMessageId: () => 'claude-auth-recovery' },
    );

    expect(next.messages).toContainEqual({
      id: 'claude-auth-recovery',
      role: 'system',
      blocks: [{ type: 'text', text: result }],
      timestamp: 8000,
    });
  });

  it('promotes a repeated Claude OAuth assistant error into one recovery message', () => {
    const result =
      'Failed to authenticate: OAuth session expired and could not be refreshed';
    let nextId = 1;
    let state = applyClaudeTranscriptEvent(
      createEmptyTranscriptReducerState(),
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: result }],
        },
      },
      { now: 8000, createMessageId: () => `message-${nextId++}` },
    );

    state = applyClaudeTranscriptEvent(
      state,
      {
        type: 'result',
        is_error: true,
        api_error_status: 429,
        result,
      },
      { now: 8050, createMessageId: () => `message-${nextId++}` },
    );

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      role: 'system',
      blocks: [{ type: 'text', text: result }],
    });
  });

  it('upserts a hydrated Claude OAuth recovery by its wire-converged id', () => {
    const result =
      'Failed to authenticate: OAuth session expired and could not be refreshed';
    const createMessageId = jest.fn(() => 'unexpected-minted-id');
    const hydratedState = {
      ...createEmptyTranscriptReducerState(),
      messages: [
        {
          id: 'user-wire-auth',
          role: 'user' as const,
          blocks: [{ type: 'text' as const, text: 'Continue the task' }],
          timestamp: 8000,
        },
        {
          id: 'user-wire-auth:assistant',
          role: 'system' as const,
          blocks: [{ type: 'text' as const, text: result }],
          timestamp: 8050,
        },
      ],
    };

    const next = applyClaudeTranscriptEvent(
      hydratedState,
      {
        type: 'result',
        is_error: true,
        api_error_status: 429,
        result,
        canopy_turn_user_message_id: 'user-wire-auth',
      },
      { now: 8100, createMessageId },
    );

    expect(next.messages).toHaveLength(2);
    expect(
      next.messages.filter(
        (message) => message.id === 'user-wire-auth:assistant',
      ),
    ).toEqual([
      expect.objectContaining({
        role: 'system',
        blocks: [{ type: 'text', text: result }],
      }),
    ]);
    expect(createMessageId).not.toHaveBeenCalled();
  });

  it('does not project auth-like text from a successful Claude result', () => {
    const next = applyClaudeTranscriptEvent(
      createEmptyTranscriptReducerState(),
      {
        type: 'result',
        is_error: false,
        result:
          'Failed to authenticate: this is quoted documentation, not a provider failure',
      },
      { now: 8050, createMessageId: () => 'unexpected-auth-recovery' },
    );

    expect(next.messages).not.toContainEqual(
      expect.objectContaining({
        id: 'unexpected-auth-recovery',
        role: 'system',
      }),
    );
  });

  it('preserves the trusted Codex unauthorized projection from turn.failed', () => {
    const next = applyCodexTranscriptEvent(
      createEmptyTranscriptReducerState(),
      {
        type: 'turn.failed',
        thread_id: 'thread-auth',
        turn_id: 'turn-auth',
        error: {
          message: 'Unauthorized',
          codexErrorInfo: 'unauthorized',
        },
      },
      { now: 8100, createMessageId: () => 'codex-auth-recovery' },
    );

    expect(next.messages).toContainEqual(
      expect.objectContaining({
        role: 'system',
        blocks: [{ type: 'text', text: 'Error: Unauthorized' }],
      }),
    );
  });

  it('keeps result 429 fallback dismissKey stable across transcript replay', () => {
    const first = applyClaudeTranscriptEvent(
      createEmptyTranscriptReducerState(),
      {
        type: 'result',
        is_error: true,
        api_error_status: 429,
        result: 'Claude usage limit reached for your plan.',
      },
      { now: 1000, createMessageId: () => 'msg-1' },
    );
    const second = applyClaudeTranscriptEvent(
      createEmptyTranscriptReducerState(),
      {
        type: 'result',
        is_error: true,
        api_error_status: 429,
        result: 'Claude usage limit reached for your plan.',
      },
      { now: 2000, createMessageId: () => 'msg-2' },
    );

    expect(first.llmProviderUsageLimitBanner?.detectedAt).toBe(1000);
    expect(second.llmProviderUsageLimitBanner?.detectedAt).toBe(2000);
    expect(first.llmProviderUsageLimitBanner?.dismissKey).toBe(
      second.llmProviderUsageLimitBanner?.dismissKey,
    );
  });

  it('produces distinct fallback dismissKeys for distinct transcript positions', () => {
    const stateWithPriorMessage = {
      ...createEmptyTranscriptReducerState(),
      messages: [
        {
          id: 'existing',
          role: 'assistant' as const,
          blocks: [{ type: 'text' as const, text: 'Earlier reply' }],
          timestamp: 1,
        },
      ],
    };
    const first = applyClaudeTranscriptEvent(
      createEmptyTranscriptReducerState(),
      { type: 'result', is_error: true, api_error_status: 429 },
      { now: 1000, createMessageId: () => 'msg-1' },
    );
    const second = applyClaudeTranscriptEvent(
      stateWithPriorMessage,
      { type: 'result', is_error: true, api_error_status: 429 },
      { now: 1000, createMessageId: () => 'msg-2' },
    );

    expect(first.llmProviderUsageLimitBanner?.dismissKey).not.toBe(
      second.llmProviderUsageLimitBanner?.dismissKey,
    );
  });
});

describe('AI Credits no-billing-source transcript detection', () => {
  const marked402 =
    'unexpected status 402: {"error":{"canopy_proxy":"CANOPY_AI_CREDITS_PROXY","code":"no_billing_source"}}';

  it('persists Claude no-billing-source metadata without relying on HTTP status alone', () => {
    const next = applyClaudeTranscriptEvent(
      createEmptyTranscriptReducerState(),
      {
        type: 'result',
        is_error: true,
        api_error_status: 402,
        result: marked402,
      },
      { now: 9000, createMessageId: () => 'claude-402' },
    );

    expect(next.aiCreditsNoBillingSource).toEqual({
      provider: 'claude',
      detectedAt: 9000,
    });
  });

  it('persists Codex no-billing-source metadata from a marked turn failure', () => {
    const next = applyCodexTranscriptEvent(
      createEmptyTranscriptReducerState(),
      {
        type: 'turn.failed',
        error: { message: marked402 },
      },
      { now: 9100, createMessageId: () => 'codex-402' },
    );

    expect(next.aiCreditsNoBillingSource).toEqual({
      provider: 'codex',
      detectedAt: 9100,
    });
  });

  // CAN-3732: the event `claude-session.ts` delivers after normalizing an
  // AI-Credits-routed Claude refusal whose body the harness stripped. The
  // restored body carries no correlation id because none survived.
  const restoredClaudeNoBillingBody = JSON.stringify({
    error: {
      canopy_proxy: AI_CREDITS_PROXY_ERROR_MARKER,
      code: 'no_billing_source',
      message: AI_CREDITS_NO_BILLING_SOURCE_MESSAGE,
    },
  });

  const stampedClaudeResult = {
    type: 'result',
    subtype: 'success',
    is_error: true,
    api_error_status: 402,
    result: restoredClaudeNoBillingBody,
    [AI_CREDITS_NO_BILLING_SOURCE_EVENT_FLAG]: true,
  };
  const stampedClaudeAssistantFrame = {
    type: 'assistant',
    error: 'unknown',
    canopy_turn_user_message_id: 'user-1',
    message: {
      id: 'claude-error-frame',
      role: 'assistant',
      model: '<synthetic>',
      content: [{ type: 'text', text: restoredClaudeNoBillingBody }],
    },
    [AI_CREDITS_NO_BILLING_SOURCE_EVENT_FLAG]: true,
  };
  const systemRows = (
    state: ReturnType<typeof createEmptyTranscriptReducerState>,
  ): string[] =>
    state.messages
      .filter((message) => message.role === 'system')
      .flatMap((message) => message.blocks)
      .map((block) => (block.type === 'text' ? block.text : ''));

  it('persists a normalized Claude refusal with a parseable marked error', () => {
    const next = applyClaudeTranscriptEvent(
      createEmptyTranscriptReducerState(),
      stampedClaudeResult,
      { now: 9300, createMessageId: () => 'claude-restored-402' },
    );

    expect(next.aiCreditsNoBillingSource).toEqual({
      provider: 'claude',
      detectedAt: 9300,
    });
    expect(next.status).toBe('error');
    expect(next.error).not.toContain('API Error: 402');
    expect(parseCanopyProxyError(next.error ?? '')).toEqual({
      code: 'no_billing_source',
      message: AI_CREDITS_NO_BILLING_SOURCE_MESSAGE,
      correlationId: null,
    });
    // A result-only failure still leaves one row the notice can render from.
    expect(systemRows(next)).toEqual([restoredClaudeNoBillingBody]);
    expect(parseCanopyProxyError(systemRows(next)[0] ?? '')?.code).toBe(
      'no_billing_source',
    );
  });

  it('renders the stamped Claude error frame and its result as one system row', () => {
    let id = 0;
    const options = {
      now: 9500,
      createMessageId: (): string => `claude-frame-${++id}`,
    };
    const afterFrame = applyClaudeTranscriptEvent(
      createEmptyTranscriptReducerState(),
      stampedClaudeAssistantFrame,
      options,
    );
    expect(
      afterFrame.messages.filter((message) => message.role === 'assistant'),
    ).toEqual([]);
    expect(systemRows(afterFrame)).toEqual([restoredClaudeNoBillingBody]);

    const afterResult = applyClaudeTranscriptEvent(
      afterFrame,
      stampedClaudeResult,
      options,
    );
    expect(systemRows(afterResult)).toEqual([restoredClaudeNoBillingBody]);
    expect(afterResult.aiCreditsNoBillingSource?.provider).toBe('claude');
    // Replaying the same frame (assistant + terminal duplicates) adds nothing.
    expect(
      systemRows(
        applyClaudeTranscriptEvent(afterResult, stampedClaudeResult, options),
      ),
    ).toEqual([restoredClaudeNoBillingBody]);
  });

  it('promotes an earlier assistant row carrying the same stamped body', () => {
    const options = { now: 9600, createMessageId: (): string => 'unused' };
    const withAssistantRow = {
      ...createEmptyTranscriptReducerState(),
      messages: [
        {
          id: 'claude-error-frame',
          role: 'assistant' as const,
          blocks: [
            { type: 'text' as const, text: restoredClaudeNoBillingBody },
          ],
          timestamp: 1,
        },
      ],
    };
    const next = applyClaudeTranscriptEvent(
      withAssistantRow,
      stampedClaudeResult,
      options,
    );
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0]).toMatchObject({
      id: 'claude-error-frame',
      role: 'system',
    });
  });

  it.each(['streaming', 'idle'] as const)(
    'ignores a repeated normalized refusal after a later turn is %s',
    (status) => {
      let id = 0;
      const options = {
        now: 9650,
        createMessageId: (): string => `historical-refusal-${++id}`,
      };
      const failedTurn = applyClaudeTranscriptEvent(
        {
          ...createEmptyTranscriptReducerState(),
          providerType: 'claude',
          messages: [
            {
              id: 'user-1',
              role: 'user',
              blocks: [{ type: 'text', text: 'First prompt' }],
              timestamp: 1,
            },
          ],
        },
        stampedClaudeAssistantFrame,
        options,
      );
      const laterTurn: ReturnType<typeof createEmptyTranscriptReducerState> = {
        ...failedTurn,
        status,
        error: null,
        aiCreditsNoBillingSource: undefined,
        messages: [
          ...failedTurn.messages,
          {
            id: 'user-2',
            role: 'user',
            blocks: [{ type: 'text', text: 'Next prompt' }],
            timestamp: 2,
          },
        ],
      };
      const duplicateResult = {
        ...stampedClaudeResult,
        canopy_turn_user_message_id: 'user-1',
      };
      for (const duplicate of [stampedClaudeAssistantFrame, duplicateResult]) {
        const next = applyClaudeTranscriptEvent(laterTurn, duplicate, options);
        expect(systemRows(next)).toEqual([restoredClaudeNoBillingBody]);
        expect(next).toEqual(laterTurn);
      }
      // A real refusal of the next turn remains independently visible.
      const newFailure = applyClaudeTranscriptEvent(
        laterTurn,
        { ...duplicateResult, canopy_turn_user_message_id: 'user-2' },
        options,
      );
      expect(systemRows(newFailure)).toHaveLength(2);
      expect(newFailure.aiCreditsNoBillingSource?.provider).toBe('claude');
    },
  );

  it('does not add a second notice for a Codex chat re-reporting its failure', () => {
    const codexFailed = applyCodexTranscriptEvent(
      { ...createEmptyTranscriptReducerState(), providerType: 'codex' },
      {
        type: 'turn.failed',
        error: { message: restoredClaudeNoBillingBody },
        [AI_CREDITS_NO_BILLING_SOURCE_EVENT_FLAG]: true,
      },
      { now: 9800, createMessageId: () => 'codex-failed' },
    );
    const rows = systemRows(codexFailed);
    const next = applyClaudeTranscriptEvent(
      codexFailed,
      {
        type: 'result',
        is_error: true,
        subtype: 'codex_error',
        result: restoredClaudeNoBillingBody,
        [AI_CREDITS_NO_BILLING_SOURCE_EVENT_FLAG]: true,
      },
      { now: 9900, createMessageId: () => 'codex-result' },
    );
    expect(systemRows(next)).toEqual(rows);
  });

  it('keeps marker text as assistant prose without the main stamp', () => {
    // An ordinary answer that quotes the restored body: no failure, no stamp.
    const quoting = {
      type: 'assistant',
      canopy_turn_user_message_id: 'user-1',
      message: stampedClaudeAssistantFrame.message,
    };
    const next = applyClaudeTranscriptEvent(
      createEmptyTranscriptReducerState(),
      quoting,
      { now: 9700, createMessageId: () => 'claude-quote' },
    );
    expect(systemRows(next)).toEqual([]);
    expect(next.messages.map((message) => message.role)).toEqual(['assistant']);
  });

  it('does not treat the raw Claude 402 wording without main normalization as a refusal', () => {
    const next = applyClaudeTranscriptEvent(
      createEmptyTranscriptReducerState(),
      {
        type: 'result',
        subtype: 'success',
        is_error: true,
        api_error_status: 402,
        result: `API Error: 402 ${AI_CREDITS_NO_BILLING_SOURCE_MESSAGE}`,
      },
      { now: 9400, createMessageId: () => 'claude-raw-402' },
    );

    expect(next.aiCreditsNoBillingSource).toBeUndefined();
  });

  // `codex-session.ts` re-reports a failed turn as the Claude-shaped
  // `{type:'result', is_error:true}` event, which the renderer routes through
  // the Claude reducer. Labelling by reducer shape would persist
  // `provider: 'claude'` for a Codex chat and disagree with the `provider` the
  // main process puts on the live `canopy_ai_credits_no_billing_source` event.
  it('labels a Codex session by its providerType, not the reducer shape', () => {
    const next = applyClaudeTranscriptEvent(
      { ...createEmptyTranscriptReducerState(), providerType: 'codex' },
      {
        type: 'result',
        is_error: true,
        subtype: 'codex_error',
        result: marked402,
      },
      { now: 9200, createMessageId: () => 'codex-result-402' },
    );

    expect(next.aiCreditsNoBillingSource).toEqual({
      provider: 'codex',
      detectedAt: 9200,
    });
  });
});

describe('Codex context-window usage', () => {
  it('updates current context without changing cumulative turn totals', () => {
    let state = applyCodexTranscriptEvent(
      createEmptyTranscriptReducerState(),
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 100,
          cached_input_tokens: 20,
          output_tokens: 10,
        },
      },
      { now: 1, createMessageId: () => 'message-1' },
    );

    state = applyCodexTranscriptEvent(
      state,
      {
        type: 'thread.token_usage.updated',
        thread_id: 'thread-1',
        usage: {
          context_tokens: 81_659,
          context_window: 258_400,
        },
      },
      { now: 2, createMessageId: () => 'message-2' },
    );

    expect(state.usage).toMatchObject({
      contextTokens: 81_659,
      contextWindow: 258_400,
      inputTokens: 100,
      cacheReadInputTokens: 20,
      outputTokens: 10,
      numTurns: 1,
    });

    state = applyCodexTranscriptEvent(
      state,
      {
        type: 'thread.token_usage.updated',
        thread_id: 'thread-1',
        usage: {
          context_tokens: 12_000,
          context_window: 258_400,
        },
      },
      { now: 3, createMessageId: () => 'message-3' },
    );

    expect(state.usage?.contextTokens).toBe(12_000);
    expect(state.usage?.inputTokens).toBe(100);
    expect(state.usage?.numTurns).toBe(1);
  });

  it('restores context usage from a persisted standalone event', () => {
    const parsed = parseAgentTranscriptLines([
      JSON.stringify({
        type: 'thread.token_usage.updated',
        thread_id: 'thread-1',
        usage: {
          context_tokens: 64_000,
          context_window: 200_000,
        },
      }),
    ]);

    expect(parsed.providerType).toBe('codex');
    expect(parsed.usage).toMatchObject({
      contextTokens: 64_000,
      contextWindow: 200_000,
    });
  });

  it('ignores malformed or zero-valued context snapshots', () => {
    const initial = createEmptyTranscriptReducerState();
    const next = applyCodexTranscriptEvent(
      initial,
      {
        type: 'thread.token_usage.updated',
        usage: { context_tokens: 0, context_window: 200_000 },
      },
      { now: 1, createMessageId: () => 'message-1' },
    );

    expect(next).toBe(initial);
  });
});

describe('Codex usage-limit detection', () => {
  function interruptedTurn(): ReturnType<
    typeof createEmptyTranscriptReducerState
  > {
    return {
      ...createEmptyTranscriptReducerState(),
      providerType: 'codex',
      sdkSessionId: 'root-thread',
      status: 'streaming',
      messages: [
        {
          id: 'previous-user',
          role: 'user',
          timestamp: 1000,
          blocks: [{ type: 'text', text: 'Investigate the failure' }],
        },
        {
          id: 'previous-timer',
          role: 'system',
          timestamp: 1000,
          blocks: [{ type: 'turn_timer', startedAt: 1000, completedAt: null }],
        },
        {
          id: 'previous-output',
          role: 'assistant',
          timestamp: 2000,
          blocks: [{ type: 'text', text: 'Checking the failing run.' }],
        },
      ],
    };
  }

  it.each(['error', 'turn.failed'])(
    'settles the root timer on terminal Codex %s without a renderer',
    (type) => {
      const next = applyCodexTranscriptEvent(
        interruptedTurn(),
        {
          type,
          thread_id: 'root-thread',
          turn_id: 'failed-turn',
          message: 'Usage limit exceeded.',
          codexErrorInfo: 'usageLimitExceeded',
          error: {
            message: 'Usage limit exceeded.',
            codexErrorInfo: 'usageLimitExceeded',
          },
        },
        { now: 3000, createMessageId: () => 'failure' },
      );
      expect(next.messages[1].blocks[0]).toMatchObject({ completedAt: 3000 });
      expect(next.status).toBe('error');
      expect(next.error).toBe('Codex usage limit reached.');
    },
  );

  it.each(['error', 'turn.failed'])(
    'keeps the root timer running on a subagent %s',
    (type) => {
      const next = applyCodexTranscriptEvent(
        interruptedTurn(),
        {
          type,
          thread_id: 'child-thread',
          turn_id: 'child-turn',
          message: 'Child failed.',
          error: { message: 'Child failed.' },
        },
        { now: 3000, createMessageId: () => 'child-failure' },
      );
      expect(next.messages[1].blocks[0]).toMatchObject({ completedAt: null });
      expect(next.status).toBe('streaming');
    },
  );

  it.each([
    { type: 'turn.started' },
    {
      type: 'item.completed',
      item: {
        type: 'agent_message',
        id: 'child-output',
        text: 'Child finished.',
      },
    },
    {
      type: 'item.completed',
      item: {
        type: 'reasoning',
        id: 'child-reasoning',
        text: 'Child thinking.',
      },
    },
  ])(
    'does not reopen a failed root turn for late child $type/$item.type',
    (childEvent) => {
      const failed = applyCodexTranscriptEvent(
        interruptedTurn(),
        {
          type: 'turn.failed',
          thread_id: 'root-thread',
          turn_id: 'failed-turn',
          error: {
            message:
              'Selected model is at capacity. Please try a different model.',
            codexErrorInfo: 'serverOverloaded',
          },
        },
        { now: 3000, createMessageId: () => 'capacity-failure' },
      );
      const next = applyCodexTranscriptEvent(
        failed,
        {
          ...childEvent,
          thread_id: 'child-thread',
          turn_id: 'child-turn',
        },
        { now: 4000, createMessageId: () => 'child-event' },
      );
      expect(next.messages[1].blocks[0]).toMatchObject({ completedAt: 3000 });
      expect(next.status).toBe('error');
      expect(next.error).toBe(failed.error);
    },
  );

  it('keeps the root timer running for a retryable error', () => {
    const next = applyCodexTranscriptEvent(
      interruptedTurn(),
      {
        type: 'error',
        thread_id: 'root-thread',
        willRetry: true,
        message: 'Reconnecting.',
      },
      { now: 3000, createMessageId: () => 'retry' },
    );
    expect(next.messages[1].blocks[0]).toMatchObject({ completedAt: null });
    expect(next.status).toBe('streaming');
  });

  it.each([false, true])(
    'creates the resumed timer despite a historical open timer (persisted prompt: %s)',
    (persistedPrompt) => {
      const initial = interruptedTurn();
      initial.status = 'idle';
      initial.messages.push(
        {
          id: 'usage-error',
          role: 'system',
          timestamp: 3000,
          blocks: [{ type: 'text', text: 'Error: Usage limit exceeded.' }],
        },
        {
          id: 'automation-banner',
          role: 'system',
          timestamp: 30000,
          blocks: [{ type: 'automation_info', timestamp: 30000 }],
        },
      );
      if (persistedPrompt)
        initial.messages.push({
          id: 'resume-user',
          role: 'user',
          timestamp: 30000,
          blocks: [{ type: 'text', text: 'Continue' }],
        });
      const event = {
        type: 'canopy_user_prompt',
        provider: 'codex',
        original_text: 'Continue',
        canopy_turn_user_message_id: 'resume-user',
      };
      const options = {
        now: 30000,
        createMessageId: (): string => 'resume-timer',
      };
      const next = applyClaudeTranscriptEvent(initial, event, options);
      expect(next.messages[1].blocks[0]).toMatchObject({ completedAt: 3000 });
      expect(next.messages[next.messages.length - 1]).toMatchObject({
        id: 'resume-timer',
        blocks: [{ type: 'turn_timer', startedAt: 30000, completedAt: null }],
      });
      expect(
        next.messages.filter((message) => message.id === 'resume-user'),
      ).toHaveLength(1);
      expect(applyClaudeTranscriptEvent(next, event, options).messages).toEqual(
        next.messages,
      );
    },
  );

  it('settles a historical timer stored after the failure at that turn’s last activity', () => {
    const initial = interruptedTurn();
    const [timer] = initial.messages.splice(1, 1);
    initial.messages.push(
      {
        id: 'usage-error',
        role: 'system',
        timestamp: 3000,
        blocks: [{ type: 'text', text: 'Error: Usage limit exceeded.' }],
      },
      timer,
    );
    const next = applyClaudeTranscriptEvent(
      initial,
      {
        type: 'canopy_user_prompt',
        original_text: 'Continue',
        provider: 'codex',
        canopy_turn_user_message_id: 'resume-user',
      },
      { now: 30000, createMessageId: () => 'resume-timer' },
    );
    expect(
      next.messages.find((message) => message.id === 'previous-timer')
        ?.blocks[0],
    ).toMatchObject({ completedAt: 3000 });
  });

  it('does not mistake static JSONL line numbers for historical completion timestamps', () => {
    const parsed = parseAgentTranscriptLines(
      [
        JSON.stringify({
          type: 'canopy_user_prompt',
          provider: 'codex',
          original_text: 'Investigate',
        }),
        JSON.stringify({ type: 'error', message: 'Usage limit exceeded.' }),
        JSON.stringify({
          type: 'canopy_user_prompt',
          provider: 'codex',
          original_text: 'Continue',
        }),
      ],
      'codex',
    );
    expect(
      parsed.messages
        .flatMap((message) => message.blocks)
        .filter((block) => block.type === 'turn_timer'),
    ).toEqual([
      { type: 'turn_timer', completedAt: null },
      { type: 'turn_timer', completedAt: null },
    ]);
  });

  it('sets banner metadata on a turn.failed usageLimitExceeded error', () => {
    const next = applyCodexTranscriptEvent(
      {
        ...createEmptyTranscriptReducerState(),
        sdkSessionId: 'root-thread',
      },
      {
        type: 'turn.failed',
        thread_id: 'root-thread',
        turn_id: 'turn-1',
        error: {
          message: 'Session limit reached. Try again later.',
          codexErrorInfo: 'usageLimitExceeded',
        },
      },
      { now: 9000, createMessageId: () => 'msg-1' },
    );

    expect(next.llmProviderUsageLimitBanner).toMatchObject({
      provider: 'codex',
      message: 'Codex usage limit reached.',
      detectedAt: 9000,
    });
    expect(next.llmProviderUsageLimitBanner?.dismissKey).toContain(
      'usage-limit:',
    );
  });

  it('sets banner metadata on an app-server error usageLimitExceeded notification', () => {
    const next = applyCodexTranscriptEvent(
      {
        ...createEmptyTranscriptReducerState(),
        sdkSessionId: 'root-thread',
      },
      {
        type: 'error',
        thread_id: 'root-thread',
        turn_id: 'turn-2',
        message: 'Usage limit exceeded.',
        codexErrorInfo: 'usageLimitExceeded',
      },
      { now: 9100, createMessageId: () => 'msg-1' },
    );

    expect(next.llmProviderUsageLimitBanner).toMatchObject({
      provider: 'codex',
      message: 'Codex usage limit reached.',
      detectedAt: 9100,
    });
    expect(next.llmProviderUsageLimitBanner?.dismissKey).toContain(
      'usage-limit:',
    );
  });

  it('does not set banner metadata on non-limit Codex failures', () => {
    const next = applyCodexTranscriptEvent(
      createEmptyTranscriptReducerState(),
      {
        type: 'turn.failed',
        error: { message: 'Internal server error', codexErrorInfo: 'other' },
      },
      { now: 9200, createMessageId: () => 'msg-1' },
    );

    expect(next.llmProviderUsageLimitBanner).toBeUndefined();
  });

  it('threads resetsAt from a turn.failed usageLimitExceeded error onto the banner', () => {
    const next = applyCodexTranscriptEvent(
      createEmptyTranscriptReducerState(),
      {
        type: 'turn.failed',
        thread_id: 'root-thread',
        error: {
          message: 'Session limit reached.',
          codexErrorInfo: 'usageLimitExceeded',
          resetsAt: 1_710_000_300,
        },
      },
      { now: 9300, createMessageId: () => 'msg-1' },
    );

    expect(next.llmProviderUsageLimitBanner).toMatchObject({
      provider: 'codex',
      resetsAt: 1_710_000_300_000,
    });
  });

  it('raises a banner-only prompt on a proactive rate_limit.reached event', () => {
    const base = {
      ...createEmptyTranscriptReducerState(),
      sdkSessionId: 'root-thread',
    };
    const next = applyCodexTranscriptEvent(
      base,
      {
        type: 'rate_limit.reached',
        thread_id: 'root-thread',
        reachedType: 'rate_limit_reached',
        resetsAt: 1_710_000_300,
      },
      { now: 9400, createMessageId: () => 'msg-1' },
    );

    expect(next.llmProviderUsageLimitBanner).toMatchObject({
      provider: 'codex',
      detectedAt: 9400,
      resetsAt: 1_710_000_300_000,
    });
    // Proactive detection must not append an error message to the transcript.
    expect(next.messages).toEqual(base.messages);
  });

  const CODEX_UPSELL_MESSAGE =
    "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more.";

  function usageLimitFailure(
    type: 'error' | 'turn.failed',
    overrides: { turnId?: string; resetsAt?: number } = {},
  ): Record<string, unknown> {
    const resetsAt =
      overrides.resetsAt === undefined ? {} : { resetsAt: overrides.resetsAt };
    const routing = {
      thread_id: 'root-thread',
      turn_id: overrides.turnId ?? 'failed-turn',
    };
    return type === 'error'
      ? {
          type,
          ...routing,
          message: CODEX_UPSELL_MESSAGE,
          codexErrorInfo: 'usageLimitExceeded',
          ...resetsAt,
        }
      : {
          type,
          ...routing,
          error: {
            message: CODEX_UPSELL_MESSAGE,
            codexErrorInfo: 'usageLimitExceeded',
            ...resetsAt,
          },
        };
  }

  const codexUsageLimitResult = {
    type: 'result',
    is_error: true,
    subtype: 'codex_error',
    codexErrorInfo: 'usageLimitExceeded',
    result: CODEX_UPSELL_MESSAGE,
    errors: [CODEX_UPSELL_MESSAGE],
  };

  function transcriptText(messages: readonly unknown[]): string {
    return JSON.stringify(messages);
  }

  it.each(['error', 'turn.failed'] as const)(
    'keeps a Codex usage-limit %s banner-only with no upsell text',
    (type) => {
      const initial = interruptedTurn();
      const next = applyCodexTranscriptEvent(initial, usageLimitFailure(type), {
        now: 3000,
        createMessageId: () => 'failure',
      });
      expect(next.messages).toHaveLength(initial.messages.length);
      expect(next.messages.map((message) => message.id)).toEqual(
        initial.messages.map((message) => message.id),
      );
      expect(transcriptText(next.messages)).not.toContain('chatgpt.com');
      expect(transcriptText(next.messages)).not.toContain('Upgrade to Pro');
      expect(next.messages[1].blocks[0]).toMatchObject({ completedAt: 3000 });
      expect(next.status).toBe('error');
      expect(next.error).toBe('Codex usage limit reached.');
      expect(next.llmProviderUsageLimitBanner).toMatchObject({
        provider: 'codex',
        message: 'Codex usage limit reached.',
      });
    },
  );

  it('ignores the synthetic codex_error result after a native usage-limit turn.failed', () => {
    const failed = applyCodexTranscriptEvent(
      interruptedTurn(),
      usageLimitFailure('turn.failed'),
      { now: 3000, createMessageId: () => 'failure' },
    );
    const next = applyCodexTranscriptEvent(failed, codexUsageLimitResult, {
      now: 3100,
      createMessageId: () => 'result',
    });
    expect(next.messages).toEqual(failed.messages);
    expect(next.llmProviderUsageLimitBanner).toEqual(
      failed.llmProviderUsageLimitBanner,
    );
    expect(next.error).toBe('Codex usage limit reached.');
  });

  it('writes the banner for a usage-limit result after an unrelated earlier failure', () => {
    const initial = {
      ...interruptedTurn(),
      status: 'error' as const,
      error: 'Internal server error',
    };
    const next = applyCodexTranscriptEvent(initial, codexUsageLimitResult, {
      now: 3100,
      createMessageId: () => 'result',
    });
    expect(next.messages).toHaveLength(initial.messages.length);
    expect(transcriptText(next.messages)).not.toContain('chatgpt.com');
    expect(next.llmProviderUsageLimitBanner).toMatchObject({
      provider: 'codex',
      message: 'Codex usage limit reached.',
    });
  });

  it('writes the banner for a usage-limit result with no preceding native event', () => {
    const initial = {
      ...interruptedTurn(),
      status: 'idle' as const,
    };
    const next = applyCodexTranscriptEvent(initial, codexUsageLimitResult, {
      now: 3100,
      createMessageId: () => 'result',
    });
    expect(next.messages).toHaveLength(initial.messages.length);
    expect(transcriptText(next.messages)).not.toContain('chatgpt.com');
    expect(next.status).toBe('error');
    expect(next.error).toBe('Codex usage limit reached.');
    expect(next.llmProviderUsageLimitBanner).toMatchObject({
      provider: 'codex',
      message: 'Codex usage limit reached.',
    });
  });

  it('gives usage-limit failures in separate turns distinct dismiss keys', () => {
    const options = { now: 3000, createMessageId: (): string => 'failure' };
    const first = applyCodexTranscriptEvent(
      interruptedTurn(),
      {
        type: 'error',
        message: CODEX_UPSELL_MESSAGE,
        codexErrorInfo: 'usageLimitExceeded',
      },
      options,
    );
    const secondTurn = {
      ...first,
      status: 'streaming' as const,
      messages: [
        ...first.messages,
        {
          id: 'next-user',
          role: 'user' as const,
          timestamp: 4000,
          blocks: [{ type: 'text' as const, text: 'Try again' }],
        },
      ],
    };
    const second = applyCodexTranscriptEvent(
      secondTurn,
      {
        type: 'error',
        message: CODEX_UPSELL_MESSAGE,
        codexErrorInfo: 'usageLimitExceeded',
      },
      { ...options, now: 5000 },
    );
    expect(first.llmProviderUsageLimitBanner?.dismissKey).toBeDefined();
    expect(second.llmProviderUsageLimitBanner?.dismissKey).toBeDefined();
    expect(second.llmProviderUsageLimitBanner?.dismissKey).not.toBe(
      first.llmProviderUsageLimitBanner?.dismissKey,
    );

    const otherTurn = applyCodexTranscriptEvent(
      { ...first, status: 'streaming' },
      usageLimitFailure('turn.failed', { turnId: 'later-turn' }),
      options,
    );
    const firstTurn = applyCodexTranscriptEvent(
      interruptedTurn(),
      usageLimitFailure('turn.failed'),
      options,
    );
    expect(otherTurn.llmProviderUsageLimitBanner?.dismissKey).not.toBe(
      firstTurn.llmProviderUsageLimitBanner?.dismissKey,
    );
  });

  it('keeps the first banner when error and turn.failed report one turn', () => {
    const options = { now: 3000, createMessageId: (): string => 'failure' };
    const afterError = applyCodexTranscriptEvent(
      interruptedTurn(),
      usageLimitFailure('error'),
      options,
    );
    const next = applyCodexTranscriptEvent(
      afterError,
      usageLimitFailure('turn.failed', { resetsAt: 1_710_000_300 }),
      { ...options, now: 3100 },
    );
    expect(next.llmProviderUsageLimitBanner).toEqual(
      afterError.llmProviderUsageLimitBanner,
    );
    expect(next.messages).toHaveLength(afterError.messages.length);
  });

  it.each(['error', 'turn.failed'] as const)(
    'normalizes a seconds resetsAt on a usage-limit %s to ms',
    (type) => {
      const options = { now: 3000, createMessageId: (): string => 'failure' };
      const seconds = applyCodexTranscriptEvent(
        interruptedTurn(),
        usageLimitFailure(type, { resetsAt: 1_710_000_300 }),
        options,
      );
      expect(seconds.llmProviderUsageLimitBanner?.resetsAt).toBe(
        1_710_000_300_000,
      );
      const ms = applyCodexTranscriptEvent(
        interruptedTurn(),
        usageLimitFailure(type, { resetsAt: 1_710_000_300_000 }),
        options,
      );
      expect(ms.llmProviderUsageLimitBanner?.resetsAt).toBe(1_710_000_300_000);
      const zero = applyCodexTranscriptEvent(
        interruptedTurn(),
        usageLimitFailure(type, { resetsAt: 0 }),
        options,
      );
      expect(zero.llmProviderUsageLimitBanner).toBeDefined();
      expect(zero.llmProviderUsageLimitBanner?.resetsAt).toBeUndefined();
    },
  );

  it('drops a zero resetsAt on a proactive rate_limit.reached event', () => {
    const next = applyCodexTranscriptEvent(
      createEmptyTranscriptReducerState(),
      {
        type: 'rate_limit.reached',
        thread_id: 'root-thread',
        reachedType: 'rate_limit_reached',
        resetsAt: 0,
      },
      { now: 9400, createMessageId: () => 'msg-1' },
    );
    expect(next.llmProviderUsageLimitBanner).toBeDefined();
    expect(next.llmProviderUsageLimitBanner?.resetsAt).toBeUndefined();
  });

  it('marks a subagent usage-limit failure with the fixed message', () => {
    const initial = interruptedTurn();
    initial.messages.push({
      id: 'spawn',
      role: 'assistant',
      timestamp: 2500,
      blocks: [
        {
          type: 'codex_agent_call',
          agentBlockId: 'codex-agent-spawn-call',
          callId: 'spawn-call',
          tool: 'spawnAgent',
          status: 'completed',
          senderThreadId: 'root-thread',
          receiverThreadIds: ['child-thread'],
          prompt: 'Investigate',
          agentsStates: {},
        },
      ],
    });
    const next = applyCodexTranscriptEvent(
      initial,
      {
        type: 'turn.failed',
        thread_id: 'child-thread',
        turn_id: 'child-turn',
        error: {
          message: CODEX_UPSELL_MESSAGE,
          codexErrorInfo: 'usageLimitExceeded',
        },
      },
      { now: 3000, createMessageId: () => 'child-failure' },
    );
    const block = next.messages
      .flatMap((message) => message.blocks)
      .find((candidate) => candidate.type === 'codex_agent_call');
    expect(block).toMatchObject({
      agentsStates: {
        'child-thread': {
          status: 'errored',
          message: 'Codex usage limit reached.',
        },
      },
    });
    expect(transcriptText(next.messages)).not.toContain('chatgpt.com');
  });

  it.each(['other', 'unauthorized'])(
    'keeps the Error row and no banner for a %s Codex failure',
    (codexErrorInfo) => {
      const initial = interruptedTurn();
      const next = applyCodexTranscriptEvent(
        initial,
        {
          type: 'turn.failed',
          thread_id: 'root-thread',
          turn_id: 'failed-turn',
          error: { message: 'Internal server error', codexErrorInfo },
        },
        { now: 3000, createMessageId: () => 'failure' },
      );
      expect(next.messages).toHaveLength(initial.messages.length + 1);
      expect(next.messages[next.messages.length - 1].blocks[0]).toEqual({
        type: 'text',
        text: 'Error: Internal server error',
      });
      expect(next.llmProviderUsageLimitBanner).toBeUndefined();
      expect(next.error).toBe('Internal server error');
    },
  );
});

describe('wire message-id convergence (portal dedupe)', () => {
  // The renderer's persisted transcript is re-pushed to the portal keyed by
  // `ChatMessage.id` verbatim (`projectPersistedChatTranscript`). These tests
  // pin the parsed ids to the exact ids the live wire projector emits
  // (`runtimeMessageId` in chat-transcript-projector.ts, backed by the shared
  // `deriveRuntimeChatMessageId`) so a hydrate + SSE replay upserts onto one
  // row instead of duplicating it.
  function mintedIdFactory(): () => string {
    let nextId = 0;
    return () => `minted-${++nextId}`;
  }

  it('reuses the SDK message id for assistant messages (Claude path)', () => {
    const next = applyClaudeTranscriptEvent(
      createEmptyTranscriptReducerState(),
      {
        type: 'assistant',
        uuid: 'evt-uuid-1',
        message: {
          id: 'msg_01AbCdEf',
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello from Claude.' }],
        },
      },
      { now: 10, createMessageId: mintedIdFactory() },
    );

    expect(next.messages.map((message) => message.id)).toEqual([
      'msg_01AbCdEf',
    ]);
  });

  it('falls back to the per-event uuid when the SDK message id is missing', () => {
    const next = applyClaudeTranscriptEvent(
      createEmptyTranscriptReducerState(),
      {
        type: 'assistant',
        uuid: 'evt-uuid-2',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'No message id.' }],
        },
      },
      { now: 10, createMessageId: mintedIdFactory() },
    );

    expect(next.messages.map((message) => message.id)).toEqual(['evt-uuid-2']);
  });

  it('suffixes repeated SDK message ids deterministically (split-message mapping)', () => {
    // The Claude CLI stream-json path can emit one assistant event per content
    // block, all sharing one `message.id`. The wire collapses them onto ONE
    // portal row (upsert by id); the renderer keeps the FIRST on the wire base
    // id (so the re-push upserts onto that row) and every later sibling on a
    // deterministic `:2`, `:3`, … suffix.
    const createMessageId = mintedIdFactory();
    let state = createEmptyTranscriptReducerState();
    const eventFor = (text: string): Record<string, unknown> => ({
      type: 'assistant',
      message: {
        id: 'msg_dup',
        role: 'assistant',
        content: [{ type: 'text', text }],
      },
    });
    state = applyClaudeTranscriptEvent(state, eventFor('thinking part'), {
      now: 1,
      createMessageId,
    });
    state = applyClaudeTranscriptEvent(state, eventFor('text part'), {
      now: 2,
      createMessageId,
    });
    state = applyClaudeTranscriptEvent(state, eventFor('tool part'), {
      now: 3,
      createMessageId,
    });

    expect(state.messages.map((message) => message.id)).toEqual([
      'msg_dup',
      'msg_dup:2',
      'msg_dup:3',
    ]);
  });

  it('keys tool_result user events by tool:<tool_use_id> like the wire', () => {
    const next = applyClaudeTranscriptEvent(
      createEmptyTranscriptReducerState(),
      {
        type: 'user',
        uuid: 'evt-uuid-3',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu-42',
              content: 'ok',
              is_error: false,
            },
            {
              type: 'tool_result',
              tool_use_id: 'toolu-43',
              content: 'also ok',
              is_error: false,
            },
          ],
        },
      },
      { now: 10, createMessageId: mintedIdFactory() },
    );

    // The FIRST tool_result keys the whole event, matching runtimeMessageId.
    expect(next.messages.map((message) => message.id)).toEqual([
      'tool:toolu-42',
    ]);
  });

  it('falls through an empty tool_use_id to the event uuid like the wire', () => {
    const next = applyClaudeTranscriptEvent(
      createEmptyTranscriptReducerState(),
      {
        type: 'user',
        uuid: 'evt-uuid-4',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', content: 'orphan result' }],
        },
      },
      { now: 10, createMessageId: mintedIdFactory() },
    );

    expect(next.messages.map((message) => message.id)).toEqual(['evt-uuid-4']);
  });

  it('uses the wire per-turn fallback `${userMessageId}:assistant` for id-less assistant events', () => {
    const createMessageId = mintedIdFactory();
    let state = applyClaudeTranscriptEvent(
      createEmptyTranscriptReducerState(),
      {
        type: 'canopy_user_prompt',
        provider: 'claude',
        original_text: 'Do the thing',
        canopy_turn_user_message_id: 'user-wire-1',
      },
      { now: 1, createMessageId },
    );
    state = applyClaudeTranscriptEvent(
      state,
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'No ids on this event.' }],
        },
      },
      { now: 2, createMessageId },
    );

    // The user prompt id round-trips the renderer-minted send id, which is
    // exactly the `userMessageId` the wire builds its fallback from.
    expect(state.messages.map((message) => message.id)).toContain(
      'user-wire-1:assistant',
    );
  });

  it('mints a local id when the event has no id and no turn user prompt exists', () => {
    const next = applyClaudeTranscriptEvent(
      createEmptyTranscriptReducerState(),
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Orphan replay.' }],
        },
      },
      { now: 10, createMessageId: mintedIdFactory() },
    );

    expect(next.messages.map((message) => message.id)).toEqual(['minted-1']);
  });

  it('keeps Codex item ids on the wire `codex-<itemId>` shape (parity guard)', () => {
    const createMessageId = mintedIdFactory();
    let state = applyCodexTranscriptEvent(
      createEmptyTranscriptReducerState(),
      {
        type: 'item.completed',
        thread_id: 'thread-1',
        item: { id: 'item-7', type: 'reasoning', text: 'thinking…' },
      },
      { now: 1, createMessageId },
    );
    state = applyCodexTranscriptEvent(
      state,
      {
        type: 'item.completed',
        thread_id: 'thread-1',
        item: { id: 'item-8', type: 'agent_message', text: 'Final answer.' },
      },
      { now: 2, createMessageId },
    );

    // Matches runtimeCodexMessage in chat-transcript-projector.ts, which emits
    // `codex-${itemId}` for reasoning/agent_message/plan items.
    expect(state.messages.map((message) => message.id)).toEqual([
      'codex-item-7',
      'codex-item-8',
    ]);
  });
});

describe('CAN-2835 native Codex completion without a synthetic result', () => {
  it('settles the root timer on turn.completed and leaves it open for subagent completion', () => {
    let state = createEmptyTranscriptReducerState();
    state = {
      ...state,
      sdkSessionId: 'root',
      messages: [
        {
          id: 'timer',
          role: 'system',
          timestamp: 1000,
          blocks: [{ type: 'turn_timer', startedAt: 1000, completedAt: null }],
        },
      ],
    };
    const options = { now: 2000, createMessageId: (): string => 'unused' };
    state = applyCodexTranscriptEvent(
      state,
      { type: 'turn.completed', thread_id: 'child' },
      options,
    );
    expect(state.messages[0]?.blocks[0]).toMatchObject({ completedAt: null });
    state = applyCodexTranscriptEvent(
      state,
      { type: 'turn.completed', thread_id: 'root' },
      { ...options, now: 3000 },
    );
    expect(state.messages[0]?.blocks[0]).toMatchObject({ completedAt: 3000 });
    state = applyCodexTranscriptEvent(
      state,
      { type: 'turn.completed', thread_id: 'root' },
      { ...options, now: 4000 },
    );
    expect(state.messages[0]?.blocks[0]).toMatchObject({ completedAt: 3000 });
  });
});

describe('Codex canonical tool result output', () => {
  const complete = (
    item: Record<string, unknown>,
  ): ReturnType<typeof applyCodexTranscriptEvent> =>
    applyCodexTranscriptEvent(
      createEmptyTranscriptReducerState(),
      {
        type: 'item.completed',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        item,
      },
      { now: 1, createMessageId: () => 'unused' },
    );

  it('retains dynamic content after item 100 and beyond 65,536 chars', () => {
    const content_items = Array.from({ length: 100 }, () => ({
      type: 'inputText',
      text: 'x'.repeat(1310),
    }));
    content_items.push({ type: 'inputText', text: 'last-marker' });
    const state = complete({
      type: 'dynamic_tool_call',
      id: 'dynamic-full',
      tool: 'tool',
      status: 'completed',
      arguments: {},
      content_items,
      success: true,
    });
    const result = state.messages[0].blocks.find(
      (block) => block.type === 'tool_result',
    );
    if (result?.type !== 'tool_result') throw new Error('missing result');
    expect(result.output).toContain('last-marker');
    expect(result.output.length).toBeGreaterThan(131_082);
  });

  it('retains MCP text, resource, and structured fallback in full', () => {
    const content: Array<
      | { type: 'text'; text: string }
      | { type: 'resource'; resource: { text: string } }
    > = Array.from({ length: 101 }, (): { type: 'text'; text: string } => ({
      type: 'text',
      text: 'x'.repeat(1300),
    }));
    content.push({ type: 'resource', resource: { text: 'resource-marker' } });
    const state = complete({
      type: 'mcp_tool_call',
      id: 'mcp-full',
      server: 's',
      tool: 't',
      arguments: {},
      status: 'completed',
      result: { content },
      error: null,
    });
    const result = state.messages[0].blocks.find(
      (block) => block.type === 'tool_result',
    );
    if (result?.type !== 'tool_result') throw new Error('missing result');
    expect(result.output).toContain('resource-marker');
    const structured = complete({
      type: 'mcp_tool_call',
      id: 'mcp-structured',
      server: 's',
      tool: 't',
      arguments: {},
      status: 'completed',
      result: {
        structuredContent: {
          nested: { _meta: 'secret', marker: 'structured-marker' },
        },
      },
      error: null,
    });
    const structuredResult = structured.messages[0].blocks.find(
      (block) => block.type === 'tool_result',
    );
    if (structuredResult?.type !== 'tool_result')
      throw new Error('missing result');
    expect(structuredResult.output).toContain('structured-marker');
    expect(structuredResult.output).not.toContain('_meta');
  });

  it('keeps function_call_output bounded', () => {
    const state = complete({
      type: 'function_call_output',
      id: 'function-bounded',
      name: 'tool',
      output: 'x'.repeat(131_082),
    });
    const text = state.messages[0].blocks.find(
      (block) => block.type === 'text',
    );
    if (text?.type !== 'text') throw new Error('missing text');
    expect(text.text.length).toBeLessThan(65_600);
    expect(text.text).toContain('[additional output omitted]');
  });

  it('does not announce images outside first 100 items or after four safe images', () => {
    const image = {
      type: 'inputImage',
      imageUrl: 'data:image/png;base64,AAAA',
    };
    const afterLimit = complete({
      type: 'dynamic_tool_call',
      id: 'image-late',
      tool: 'tool',
      arguments: {},
      status: 'completed',
      content_items: [
        ...Array.from({ length: 100 }, () => ({
          type: 'inputText',
          text: 'x',
        })),
        image,
      ],
      success: true,
    });
    const lateBlocks = afterLimit.messages[0].blocks;
    expect(lateBlocks.filter((block) => block.type === 'image')).toHaveLength(
      0,
    );
    const lateResult = lateBlocks.find((block) => block.type === 'tool_result');
    if (lateResult?.type !== 'tool_result') throw new Error('missing result');
    expect(lateResult.output).not.toContain('[Image displayed below]');
    const ceiling = complete({
      type: 'dynamic_tool_call',
      id: 'image-four',
      tool: 'tool',
      arguments: {},
      status: 'completed',
      content_items: Array.from({ length: 5 }, () => image),
      success: true,
    });
    expect(
      ceiling.messages[0].blocks.filter((block) => block.type === 'image'),
    ).toHaveLength(4);
    const result = ceiling.messages[0].blocks.find(
      (block) => block.type === 'tool_result',
    );
    if (result?.type !== 'tool_result') throw new Error('missing result');
    expect(result.output.match(/\[Image displayed below\]/g)).toHaveLength(4);
  });
});

describe('Codex function_call_output transcript storage format', () => {
  const sentinel = 'middle-sentinel-7f3c';
  const bigOutput = `${'a'.repeat(80_000)}${sentinel}${'b'.repeat(80_000)}`;
  const png = 'data:image/png;base64,aGVsbG8=';
  const pair = '\u{1F600}';
  const ref = {
    version: 1 as const,
    artifactId: `sha256-v1-${'a'.repeat(64)}`,
    byteLength: 200_000,
    sha256: 'a'.repeat(64),
    encoding: 'utf-8' as const,
    mediaType: 'text/plain' as const,
  };
  const reduce = (
    item: Record<string, unknown>,
    options: Partial<
      Pick<
        Parameters<typeof applyCodexTranscriptEvent>[2],
        'transcriptStorageFormat' | 'preparedCodexItem'
      >
    > = {},
    eventType = 'item.completed',
  ): PersistedChatBlock[] =>
    applyCodexTranscriptEvent(
      createEmptyTranscriptReducerState(),
      { type: eventType, thread_id: 'thread-1', turn_id: 'turn-1', item },
      { now: 1, createMessageId: () => 'unused', ...options },
    ).messages.flatMap((message) => message.blocks);

  it('keeps a >64 KiB function_call_output lossless in format 4', () => {
    const blocks = reduce(
      {
        type: 'function_call_output',
        id: 'fco-big',
        name: 'tool',
        output: bigOutput,
      },
      { transcriptStorageFormat: 4 },
    );
    const [text] = blocks;
    if (text?.type !== 'text') throw new Error('missing text block');
    expect(text.text.includes(sentinel)).toBe(true);
    expect(text.text === `Tool output (tool)\n\n${bigOutput}`).toBe(true);
    expect(blocks).toHaveLength(1);
    expect(text.verbatim).toBe(true);
    expect(text.textRef).toBeUndefined();
  });

  const legacyFixtures: Array<[string, Record<string, unknown>, string?]> = [
    ['small string', { type: 'function_call_output', output: '42 passed' }],
    ['large string', { type: 'function_call_output', output: bigOutput }],
    [
      'multibyte at the preview edge',
      {
        type: 'function_call_output',
        namespace: 'ns',
        name: 'tool',
        output: `${'x'.repeat(65_500)}${pair.repeat(100)}\uD800`,
      },
    ],
    ['empty string', { type: 'function_call_output', output: '' }],
    ['missing output', { type: 'function_call_output' }],
    [
      'content items with images',
      {
        type: 'function_call_output',
        name: 'preview',
        output: [
          { type: 'input_text', text: 'y'.repeat(70_000) },
          { type: 'input_image', image_url: png },
          { type: 'encrypted_content', encrypted_content: 'secret' },
        ],
      },
    ],
    [
      'mcp structured',
      {
        type: 'mcp_tool_call',
        server: 's',
        tool: 't',
        status: 'completed',
        result: {
          structuredContent: { big: 'z'.repeat(70_000), _meta: 'x' },
        },
        error: null,
      },
    ],
    [
      'mcp error',
      {
        type: 'mcp_tool_call',
        server: 's',
        tool: 't',
        status: 'failed',
        result: null,
        error: { message: 'failed hard' },
      },
    ],
    [
      'dynamic failure',
      {
        type: 'dynamic_tool_call',
        tool: 'tool',
        status: 'failed',
        success: false,
        content_items: [],
      },
    ],
    [
      'function output update',
      { type: 'function_call_output', output: bigOutput },
      'item.updated',
    ],
  ];

  it.each(
    legacyFixtures.map(([name, fixture, eventType]) => ({
      name,
      fixture,
      eventType: eventType ?? 'item.completed',
    })),
  )(
    'keeps formats 2 and 3 identical to the default rows: $name',
    ({ fixture, eventType }) => {
      const item = { id: 'legacy-item', ...fixture };
      const legacy = JSON.stringify(reduce(item, {}, eventType));
      for (const transcriptStorageFormat of [2, 3] as const) {
        expect(
          JSON.stringify(
            reduce(
              item,
              { transcriptStorageFormat, preparedCodexItem: undefined },
              eventType,
            ),
          ) === legacy,
        ).toBe(true);
      }
    },
  );

  it('keeps the default function_call_output on the bounded helpers', () => {
    const item = {
      id: 'legacy-item',
      type: 'function_call_output',
      name: 'tool',
      output: bigOutput,
    };
    expect(reduce(item)).toEqual([
      {
        type: 'text',
        text: `Tool output (tool)\n\n${bigOutput.slice(0, 65_536 - '\n\n[additional output omitted]'.length)}\n\n[additional output omitted]`,
        verbatim: true,
      },
    ]);
  });

  it('keeps non-string function output lossless with images in format 4', () => {
    const output = [
      { type: 'input_text', text: `${'y'.repeat(70_000)}${sentinel}` },
      { type: 'input_image', image_url: png },
      { type: 'encrypted_content', encrypted_content: 'secret' },
    ];
    const blocks = reduce(
      { type: 'function_call_output', id: 'fco-items', name: 'n', output },
      { transcriptStorageFormat: 4 },
    );
    expect(blocks[0]).toEqual({
      type: 'text',
      text: `Tool output (n)\n\n${'y'.repeat(70_000)}${sentinel}\n\n[Image displayed below]\n\n[encrypted output omitted]`,
      verbatim: true,
    });
    expect(blocks[1]).toEqual({
      type: 'image',
      path: '',
      dataUrl: png,
      alt: 'Tool output image',
    });
    expect(JSON.stringify(blocks)).not.toContain('secret');
  });

  it('keeps format 4 lossless when parsing transcript lines', () => {
    const parsed = parseAgentTranscriptLines(
      [
        JSON.stringify({
          type: 'item.completed',
          item: {
            id: 'fco-lines',
            type: 'function_call_output',
            name: 'tool',
            output: bigOutput,
          },
        }),
      ],
      'codex',
      { transcriptStorageFormat: 4 },
    );
    const text = parsed.messages
      .flatMap((message) => message.blocks)
      .find((block) => block.type === 'text');
    if (text?.type !== 'text') throw new Error('missing text block');
    expect(text.text.includes(sentinel)).toBe(true);
  });

  it('describes the final body that format 4 stores', () => {
    const cases: Array<Record<string, unknown>> = [
      {
        type: 'function_call_output',
        id: 'a',
        name: 'tool',
        output: bigOutput,
      },
      {
        type: 'function_call_output',
        id: 'b',
        output: [
          { type: 'input_text', text: bigOutput },
          { type: 'input_image', image_url: png },
        ],
      },
      {
        type: 'mcp_tool_call',
        id: 'c',
        server: 's',
        tool: 't',
        status: 'completed',
        result: {
          content: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }],
          structuredContent: { big: bigOutput },
        },
        error: null,
      },
      {
        type: 'dynamic_tool_call',
        id: 'd',
        tool: 'tool',
        status: 'completed',
        success: true,
        content_items: [{ type: 'inputText', text: bigOutput }],
      },
    ];
    for (const item of cases) {
      const body = codexItemOutputBody({ type: 'item.completed', item });
      if (!body) throw new Error('missing body');
      expect(body.itemId).toBe(item.id);
      const joined = Array.from(body.chunks).join('');
      expect(joined === body.whole()).toBe(true);
      const blocks = reduce(item, { transcriptStorageFormat: 4 });
      const stored = blocks.find(
        (block) =>
          (body.field === 'text' && block.type === 'text') ||
          (body.field === 'output' && block.type === 'tool_result'),
      );
      const storedText =
        stored?.type === 'text'
          ? stored.text
          : stored?.type === 'tool_result'
            ? stored.output
            : undefined;
      expect(storedText === joined).toBe(true);
    }
    expect(
      codexItemOutputBody({
        type: 'item.updated',
        item: cases[0],
      }),
    ).toBeUndefined();
    expect(
      codexItemOutputBody({
        type: 'item.completed',
        item: { id: 'e', type: 'agent_message', text: 'hi' },
      }),
    ).toBeUndefined();
  });

  it('uses a trusted prepared body only for format 4 and the matching completed item', () => {
    const item = {
      type: 'function_call_output',
      id: 'fco-prepared',
      name: 'tool',
      output: [
        { type: 'input_text', text: bigOutput },
        { type: 'input_image', image_url: png },
      ],
      // Provider fields can never mint a reference.
      textRef: ref,
    };
    const preparedCodexItem = {
      itemId: 'fco-prepared',
      output: { field: 'text' as const, text: 'preview text', textRef: ref },
    };
    const prepared = reduce(item, {
      transcriptStorageFormat: 4,
      preparedCodexItem,
    });
    expect(prepared).toEqual([
      { type: 'text', text: 'preview text', verbatim: true, textRef: ref },
      { type: 'image', path: '', dataUrl: png, alt: 'Tool output image' },
    ]);
    expect(Object.keys(prepared[0])).toEqual([
      'type',
      'text',
      'verbatim',
      'textRef',
    ]);
    const ignored: Array<[Parameters<typeof reduce>[1], string | undefined]> = [
      [{ transcriptStorageFormat: 3, preparedCodexItem }, undefined],
      [{ preparedCodexItem }, undefined],
      [
        {
          transcriptStorageFormat: 4,
          preparedCodexItem: { ...preparedCodexItem, itemId: 'other' },
        },
        undefined,
      ],
      [{ transcriptStorageFormat: 4, preparedCodexItem }, 'item.updated'],
      [
        {
          transcriptStorageFormat: 4,
          preparedCodexItem: {
            itemId: 'fco-prepared',
            output: { field: 'output', output: 'x', fullOutputRef: ref },
          },
        },
        undefined,
      ],
    ];
    for (const [options, eventType] of ignored) {
      const [text] = reduce(item, options, eventType);
      if (text?.type !== 'text') throw new Error('missing text block');
      expect(text.text).not.toBe('preview text');
      expect(text.textRef).toBeUndefined();
    }
    const [unprepared] = reduce(item, { transcriptStorageFormat: 4 });
    if (unprepared?.type !== 'text') throw new Error('missing text block');
    expect(unprepared.textRef).toBeUndefined();
  });

  it('uses a prepared tool result without reading the result body', () => {
    let bodyReads = 0;
    const result = {
      isError: false,
      content: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }],
      get structuredContent(): unknown {
        bodyReads += 1;
        return { big: bigOutput };
      },
    };
    const blocks = reduce(
      {
        type: 'mcp_tool_call',
        id: 'mcp-prepared',
        server: 's',
        tool: 't',
        arguments: { q: 1 },
        status: 'completed',
        result,
        error: null,
      },
      {
        transcriptStorageFormat: 4,
        preparedCodexItem: {
          itemId: 'mcp-prepared',
          output: { field: 'output', output: 'preview', fullOutputRef: ref },
        },
      },
    );
    expect(bodyReads).toBe(0);
    expect(blocks).toEqual([
      {
        type: 'tool_use',
        toolUseId: 'codex-mcp-prepared',
        toolName: 'mcp__s__t',
        input: '{"q":1}',
      },
      {
        type: 'tool_result',
        toolUseId: 'codex-mcp-prepared',
        toolName: 'mcp__s__t',
        output: 'preview',
        isError: false,
        outputTruncated: true,
        fullOutputRef: ref,
      },
      { type: 'image', path: '', dataUrl: png, alt: 'Tool output image' },
    ]);
    const dynamic = reduce(
      {
        type: 'dynamic_tool_call',
        id: 'dyn-prepared',
        tool: 'tool',
        status: 'failed',
        success: false,
        content_items: [{ type: 'inputText', text: 'whole' }],
      },
      {
        transcriptStorageFormat: 4,
        preparedCodexItem: {
          itemId: 'dyn-prepared',
          output: { field: 'output', output: 'whole' },
        },
      },
    );
    expect(dynamic[1]).toEqual({
      type: 'tool_result',
      toolUseId: 'codex-dyn-prepared',
      toolName: 'tool',
      output: 'whole',
      isError: true,
    });
  });
});
