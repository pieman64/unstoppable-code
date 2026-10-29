jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => '/mock/user-data'),
  },
}));

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
}));

jest.mock('../agents/claude-process-host-runner', () => ({
  spawnClaudeCodeProcessOffMain: jest.fn(),
}));

const mockRunEphemeralTurn = jest.fn<unknown, [unknown]>();
const mockDeleteThread = jest.fn(() => Promise.resolve());
const mockStartThread = jest.fn((request: Record<string, unknown>) =>
  Promise.resolve({
    threadId: 'thread-1',
    runTurn: (turn: unknown) => mockRunEphemeralTurn({ ...request, turn }),
    delete: mockDeleteThread,
  }),
);
jest.mock('../codex/runtime-service', () => ({
  getCodexRuntimeService: jest.fn(() => ({
    startThread: mockStartThread,
  })),
}));

jest.mock('../pipelines/config-paths', () => ({
  getBundledClaudeBinaryPath: jest.fn(() => '/mock/bin/claude'),
  getBundledRgBinaryPath: jest.fn(() => '/mock/bin/rg'),
  getEnhancedEnv: jest.fn(() => ({ PATH: '/mock/bin' })),
}));

jest.mock('../lib/preferences-store', () => ({
  readLocalMemoryEnabledPreference: jest.fn(() => Promise.resolve(false)),
}));

interface MockTranscriptSeed {
  provider: string;
  originalText: string;
  submittedText: string;
  injectedPrompts: Array<{
    applicationCondition: string;
    text: string;
  }>;
}

const mockStartObservedTask = jest.fn<void, [string, unknown]>();
const mockFinalizeObservedTask = jest.fn<
  void,
  [string, string, string | undefined, unknown]
>();
const mockSeedTranscript = jest.fn<void, [string, MockTranscriptSeed]>();
const mockAppendTranscriptRecord = jest.fn<void, [string, unknown]>();
const mockUpdateObservedTask = jest.fn<void, [string, unknown]>();

const mockObservabilityService = {
  startObservedTask: mockStartObservedTask,
  finalizeObservedTask: mockFinalizeObservedTask,
  seedTranscript: mockSeedTranscript,
  appendTranscriptRecord: mockAppendTranscriptRecord,
  updateObservedTask: mockUpdateObservedTask,
};

jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => mockObservabilityService),
}));

import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import {
  initClaudeModels,
  initCodexModels,
} from '@canopy/desktop-shared/types';
import { generateCronExpression } from '../automations/cron-generator';
import { spawnClaudeCodeProcessOffMain } from '../agents/claude-process-host-runner';

initClaudeModels([{ id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }]);
initCodexModels([{ id: 'gpt-5.6-luna', label: 'GPT 5.6 Luna' }]);

const mockedClaudeQuery = jest.mocked(claudeQuery);

function startedTaskKey(): string {
  const call = mockStartObservedTask.mock.calls[0];
  if (!call) throw new Error('Expected observed task to start');
  return call[0];
}

function makeClaudeQuery(
  events: Array<Record<string, unknown>>,
): AsyncGenerator<Record<string, unknown>, void, void> {
  async function* generate(): AsyncGenerator<
    Record<string, unknown>,
    void,
    void
  > {
    for (const event of events) {
      await Promise.resolve();
      yield event;
    }
  }

  return generate();
}

describe('cron generator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('records cron generation as its own audit event with transcript data', async () => {
    mockedClaudeQuery.mockReturnValue(
      makeClaudeQuery([
        { type: 'assistant', message: { content: 'Working' } },
        {
          type: 'result',
          structured_output: { expression: '0 9 * * 1-5' },
          usage: {
            input_tokens: 11,
            output_tokens: 7,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 2,
          },
          total_cost_usd: 0.0123,
        },
      ]) as ReturnType<typeof claudeQuery>,
    );

    await expect(
      generateCronExpression({
        description: 'Every weekday at 9am',
        model: 'claude-sonnet-4-6',
        thinkingLevel: 'off',
      }),
    ).resolves.toEqual({ expression: '0 9 * * 1-5' });

    expect(mockedClaudeQuery.mock.calls[0]?.[0]?.options).toEqual(
      expect.objectContaining({
        spawnClaudeCodeProcess: spawnClaudeCodeProcessOffMain,
      }),
    );

    const taskKey = startedTaskKey();
    expect(taskKey).toMatch(/^helper:cron-generation:/);
    expect(mockStartObservedTask).toHaveBeenCalledWith(
      taskKey,
      expect.objectContaining({
        id: taskKey,
        eventType: 'cron_generation',
        label: 'Cron Generation',
        status: 'running',
        provider: 'claude',
        model: 'claude-sonnet-4-6',
      }),
    );
    const seedCall = mockSeedTranscript.mock.calls[0];
    if (!seedCall) throw new Error('Expected transcript to be seeded');
    expect(seedCall[0]).toBe(taskKey);
    expect(seedCall[1].provider).toBe('claude');
    expect(seedCall[1].originalText).toBe('Every weekday at 9am');
    expect(seedCall[1].submittedText).toContain('Every weekday at 9am');
    expect(seedCall[1].injectedPrompts).toHaveLength(1);
    expect(seedCall[1].injectedPrompts[0]?.applicationCondition).toBe(
      'helper_task_system_prompt',
    );
    expect(seedCall[1].injectedPrompts[0]?.text).toContain(
      'five-field cron expressions',
    );
    expect(mockAppendTranscriptRecord).toHaveBeenCalledWith(
      taskKey,
      expect.objectContaining({ type: 'result' }),
    );
    expect(mockFinalizeObservedTask).toHaveBeenCalledWith(
      taskKey,
      'success',
      undefined,
      expect.objectContaining({
        inputTokens: 11,
        outputTokens: 7,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 2,
        totalCostUsd: 0.0123,
        messageCount: 1,
        assistantMessageCount: 1,
      }),
    );
  });

  it('finalizes the cron generation audit event as failed when validation rejects the expression', async () => {
    mockedClaudeQuery.mockReturnValue(
      makeClaudeQuery([
        {
          type: 'result',
          structured_output: { expression: 'bad schedule' },
        },
      ]) as ReturnType<typeof claudeQuery>,
    );

    await expect(
      generateCronExpression({
        description: 'Every minute-ish',
        model: 'claude-sonnet-4-6',
        thinkingLevel: 'off',
      }),
    ).rejects.toThrow('Generated cron expression is invalid');

    const taskKey = startedTaskKey();
    expect(mockFinalizeObservedTask).toHaveBeenCalledWith(
      taskKey,
      'failure',
      expect.stringContaining('Generated cron expression is invalid'),
      undefined,
    );
  });

  it('finalizes failed cron generation with usage from the helper error', async () => {
    mockRunEphemeralTurn.mockRejectedValueOnce(
      Object.assign(new Error('Codex helper failed'), {
        usage: {
          inputTokens: 19,
          outputTokens: 6,
          totalCostUsd: 0.19,
        },
      }),
    );

    await expect(
      generateCronExpression({
        description: 'Every weekday at noon',
        model: 'gpt-5.6-luna',
        thinkingLevel: 'medium',
      }),
    ).rejects.toThrow('Codex helper failed');

    expect(mockFinalizeObservedTask).toHaveBeenCalledWith(
      startedTaskKey(),
      'failure',
      'Codex helper failed',
      {
        inputTokens: 19,
        outputTokens: 6,
        totalCostUsd: 0.19,
      },
    );
  });

  it('rejects generated cron expressions with no possible future run', async () => {
    mockedClaudeQuery.mockReturnValue(
      makeClaudeQuery([
        {
          type: 'result',
          structured_output: { expression: '0 0 31 2 *' },
        },
      ]) as ReturnType<typeof claudeQuery>,
    );

    await expect(
      generateCronExpression({
        description: 'Every February 31st',
        model: 'claude-sonnet-4-6',
        thinkingLevel: 'off',
      }),
    ).rejects.toThrow('Scheduled trigger has no future runs.');
  });

  it('uses prompt-only JSON instructions for Codex cron generation', async () => {
    mockRunEphemeralTurn.mockResolvedValue({
      status: 'completed',
      threadId: 'thread-1',
      finalText: JSON.stringify({ expression: '30 14 * * 2' }),
      structured: { expression: '30 14 * * 2' },
      usage: {
        inputTokens: 21,
        outputTokens: 9,
        cacheReadInputTokens: 4,
      },
    });

    await expect(
      generateCronExpression({
        description: 'Tuesdays at 2:30pm',
        model: 'gpt-5.6-luna',
        thinkingLevel: 'medium',
        modelConfig: { thinkingLevel: 'medium', fastMode: true },
      }),
    ).resolves.toEqual({ expression: '30 14 * * 2' });

    expect(mockStartObservedTask).toHaveBeenCalledWith(
      startedTaskKey(),
      expect.objectContaining({
        provider: 'codex',
        serviceTier: 'priority',
      }),
    );
    const request = mockRunEphemeralTurn.mock.calls[0]?.[0] as
      | {
          params?: { config?: unknown; developerInstructions?: string };
          turn?: { outputSchema?: { type?: string } };
        }
      | undefined;
    expect(request?.params?.config).toEqual({
      mcp_servers: {},
      service_tier: 'priority',
    });
    expect(request?.params?.developerInstructions).toContain(
      'five-field cron expressions',
    );
    expect(request?.turn?.outputSchema?.type).toBe('object');
    expect(mockFinalizeObservedTask).toHaveBeenCalledWith(
      startedTaskKey(),
      'success',
      undefined,
      expect.objectContaining({
        inputTokens: 21,
        outputTokens: 9,
        cacheReadInputTokens: 4,
        messageCount: 1,
        assistantMessageCount: 1,
      }),
    );
  });

  it('requests the default Codex service tier when fast mode is not enabled', async () => {
    mockRunEphemeralTurn.mockResolvedValue({
      status: 'completed',
      threadId: 'thread-1',
      finalText: JSON.stringify({ expression: '0 8 * * 1' }),
      structured: { expression: '0 8 * * 1' },
      usage: {},
    });

    await expect(
      generateCronExpression({
        description: 'Mondays at 8am',
        model: 'gpt-5.6-luna',
        thinkingLevel: 'low',
      }),
    ).resolves.toEqual({ expression: '0 8 * * 1' });

    const request = mockRunEphemeralTurn.mock.calls[0]?.[0] as
      | { params?: { config?: unknown } }
      | undefined;
    expect(request?.params?.config).toEqual({
      mcp_servers: {},
      service_tier: 'default',
    });
  });
});
