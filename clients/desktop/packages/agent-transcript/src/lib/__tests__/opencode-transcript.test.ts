import {
  applyClaudeTranscriptEvent,
  applyCodexTranscriptEvent,
  createEmptyTranscriptReducerState,
  parseAgentTranscriptLines,
} from '../transcript-parser';

const prompt = {
  type: 'canopy_user_prompt',
  provider: 'opencode',
  original_text: 'Inspect the project',
  submitted_text: 'Inspect the project',
  plan_mode: false,
};
const patch = {
  type: 'canopy_assistant_patch',
  provider: 'opencode',
  messageId: 'opencode-message',
  timestamp: 2,
  revision: 1,
  patches: [{ index: 0, block: { type: 'text', text: 'Inspected' } }],
};

const usageReport = {
  turn: {
    inputTokens: 100,
    outputTokens: 50,
    reasoningTokens: 10,
    cacheReadTokens: 30,
    cacheWriteTokens: 20,
    estimatedCostUsd: 0.75,
  },
  context: { usedTokens: 1234, maxTokens: 10000 },
};
const usageEvent = {
  type: 'canopy_opencode_usage',
  provider: 'opencode',
  usage: usageReport,
};

it('replays reported OpenCode turn usage without treating it as account spend or context totals', () => {
  const parsed = parseAgentTranscriptLines(
    [prompt, usageEvent].map((event) => JSON.stringify(event)),
    'opencode',
  );
  expect(parsed.usage).toMatchObject({
    opencodeReportedUsage: usageReport,
    contextTokens: 1234,
    contextWindow: 10000,
  });
  expect(parsed.usage?.totalCostUsd).toBe(0);
  expect(parsed.messages).toEqual(
    parseAgentTranscriptLines([JSON.stringify(prompt)], 'opencode').messages,
  );
});

it('clears a previous OpenCode report before an unsuccessful new turn', () => {
  const options = { now: 1, createMessageId: (): string => 'prompt' };
  const reported = applyClaudeTranscriptEvent(
    createEmptyTranscriptReducerState(),
    usageEvent,
    options,
  );
  const cleared = applyClaudeTranscriptEvent(
    reported,
    { ...usageEvent, usage: null },
    options,
  );
  expect(cleared.usage?.opencodeReportedUsage).toBeUndefined();
  expect(cleared.usage).toMatchObject({ contextTokens: 0, contextWindow: 0 });
});

it.each([
  { turn: { ...usageReport.turn, inputTokens: -1 } },
  { turn: { ...usageReport.turn, estimatedCostUsd: Infinity } },
  { context: { usedTokens: 1, maxTokens: 0 } },
  { context: { usedTokens: 0.5, maxTokens: 100 } },
])(
  'does not replace an authoritative report with malformed usage %#',
  (usage) => {
    const options = { now: 1, createMessageId: (): string => 'prompt' };
    const reported = applyClaudeTranscriptEvent(
      createEmptyTranscriptReducerState(),
      usageEvent,
      options,
    );
    expect(
      applyClaudeTranscriptEvent(reported, { ...usageEvent, usage }, options),
    ).toBe(reported);
  },
);

it.each([applyClaudeTranscriptEvent, applyCodexTranscriptEvent])(
  'records an OpenCode prompt when switching providers',
  (reduce) => {
    const state = reduce(createEmptyTranscriptReducerState(), prompt, {
      now: 1,
      createMessageId: () => 'prompt',
    });
    expect(state.providerType).toBe('opencode');
  },
);

it('streams OpenCode assistant patches through the live reducer', () => {
  const state = applyClaudeTranscriptEvent(
    createEmptyTranscriptReducerState(),
    patch,
    { now: 2, createMessageId: () => 'unused' },
  );
  expect(state.providerType).toBe('opencode');
  expect(state.messages).toContainEqual(
    expect.objectContaining({
      id: 'opencode-message',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Inspected' }],
    }),
  );
});

it('replays OpenCode patch deltas and tool results after a reload', () => {
  const parsed = parseAgentTranscriptLines(
    [
      prompt,
      patch,
      {
        ...patch,
        revision: 2,
        patches: [
          { index: 0, appendText: ' the project.' },
          {
            index: 1,
            block: {
              type: 'tool_use',
              toolUseId: 'read-1',
              toolName: 'Read',
              input: JSON.stringify({ file_path: 'README.md' }),
            },
          },
          {
            index: 2,
            block: {
              type: 'tool_result',
              toolUseId: 'read-1',
              toolName: 'Read',
              output: 'Hello',
              isError: false,
            },
          },
        ],
      },
    ].map((event) => JSON.stringify(event)),
  );
  expect(parsed.providerType).toBe('opencode');
  expect(
    parsed.messages.find((message) => message.id === 'opencode-message'),
  ).toMatchObject({
    blocks: [
      { type: 'text', text: 'Inspected the project.' },
      { type: 'tool_use', toolUseId: 'read-1', toolName: 'Read' },
      {
        type: 'tool_result',
        toolUseId: 'read-1',
        toolName: 'Read',
        output: 'Hello',
        isError: false,
      },
    ],
  });
});
