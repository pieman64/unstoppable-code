jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
}));

jest.mock('../../pipelines/config-paths', () => ({
  getBundledClaudeBinaryPath: jest.fn(() => '/mock/bin/claude'),
  getBundledRgBinaryPath: jest.fn(() => '/mock/bin/rg'),
  getEnhancedEnv: jest.fn(() => ({ PATH: '/mock/bin' })),
}));

import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import {
  getExecutionHarnessForModel,
  initClaudeModels,
  initCodexModels,
} from '../../types';
import {
  getStructuredHelperQueryErrorUsage,
  resolveHelperTranscriptProvider,
  runClaudeStructuredHelperQuery,
} from '../structured-helper-query';

interface ClaudeQueryTestDouble extends AsyncIterable<unknown> {
  close(): void;
}

type ClaudeQueryMock = (
  ...args: Parameters<typeof claudeQuery>
) => ClaudeQueryTestDouble;

const mockedClaudeQuery: jest.MockedFunction<ClaudeQueryMock> =
  jest.mocked(claudeQuery);

function makeQuery(): ClaudeQueryTestDouble {
  async function* generate(): AsyncGenerator<Record<string, unknown>, void> {
    await Promise.resolve();
    yield {
      type: 'assistant',
      error: 'server_error',
      message: 'Provider overloaded',
    };
    yield {
      type: 'result',
      is_error: true,
      result: 'Provider overloaded',
      usage: {
        input_tokens: 5,
        output_tokens: 2,
      },
      total_cost_usd: 0.05,
    };
  }

  return Object.assign(generate(), { close: () => undefined });
}

function makeSuccessQuery(): ClaudeQueryTestDouble {
  async function* generate(): AsyncGenerator<Record<string, unknown>, void> {
    await Promise.resolve();
    yield {
      type: 'result',
      is_error: false,
      structured_output: { value: 'ok' },
      usage: {
        input_tokens: 1,
        output_tokens: 1,
      },
    };
  }

  return Object.assign(generate(), { close: () => undefined });
}

function runValueQuery(
  localMemoryEnabled = false,
): Promise<{ value: { value: string } | null }> {
  return runClaudeStructuredHelperQuery({
    repoPath: '/repo',
    model: 'claude-sonnet-4-6',
    provider: 'claude',
    maxTurns: 1,
    systemPrompt: 'Return JSON.',
    userMessage: 'Summarize.',
    localMemoryEnabled,
    schema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
    },
    isResult: (value): value is { value: string } =>
      typeof value === 'object' &&
      value !== null &&
      'value' in value &&
      typeof value.value === 'string',
  });
}

describe('runClaudeStructuredHelperQuery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('leaves native memory unspecified when local memory is disabled (opt-in default)', async () => {
    delete process.env.CANOPY_HARNESS_NATIVE_MEMORY;
    mockedClaudeQuery.mockImplementation(() => makeSuccessQuery());

    const result = await runValueQuery(false);

    expect(result.value).toEqual({ value: 'ok' });
    expect(
      mockedClaudeQuery.mock.calls[0]?.[0]?.options?.settings,
    ).toBeUndefined();
  });

  it('applies the native-memory suppression when local memory is enabled', async () => {
    delete process.env.CANOPY_HARNESS_NATIVE_MEMORY;
    mockedClaudeQuery.mockImplementation(() => makeSuccessQuery());

    const result = await runValueQuery(true);

    expect(result.value).toEqual({ value: 'ok' });
    expect(mockedClaudeQuery.mock.calls[0]?.[0]?.options?.settings).toEqual({
      autoMemoryEnabled: false,
    });
  });

  it('leaves native memory unspecified when the branded env override allows it', async () => {
    process.env.CANOPY_HARNESS_NATIVE_MEMORY = '1';
    try {
      mockedClaudeQuery.mockImplementation(() => makeSuccessQuery());

      await runValueQuery(true);

      expect(
        mockedClaudeQuery.mock.calls[0]?.[0]?.options?.settings,
      ).toBeUndefined();
    } finally {
      delete process.env.CANOPY_HARNESS_NATIVE_MEMORY;
    }
  });

  it('drains the terminal result and preserves usage after an assistant error', async () => {
    jest.useFakeTimers();
    try {
      mockedClaudeQuery.mockImplementation(() => makeQuery());

      const resultPromise = runClaudeStructuredHelperQuery({
        repoPath: '/repo',
        model: 'claude-sonnet-4-6',
        provider: 'claude',
        maxTurns: 1,
        systemPrompt: 'Return JSON.',
        userMessage: 'Summarize.',
        localMemoryEnabled: false,
        schema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
        isResult: (value): value is { value: string } =>
          typeof value === 'object' &&
          value !== null &&
          'value' in value &&
          typeof value.value === 'string',
      }).catch((caught: unknown) => caught);

      await jest.runAllTimersAsync();
      const error = await resultPromise;

      expect(getStructuredHelperQueryErrorUsage(error)).toMatchObject({
        inputTokens: 30,
        outputTokens: 12,
        totalCostUsd: 0.3,
        messageCount: 6,
        assistantMessageCount: 6,
      });
      expect(mockedClaudeQuery).toHaveBeenCalledTimes(6);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not apply Claude retries to a prefix-stripped Ollama model', async () => {
    mockedClaudeQuery.mockImplementation(() => makeQuery());

    const error = await runClaudeStructuredHelperQuery({
      repoPath: '/repo',
      model: 'qwen3-coder',
      provider: 'ollama',
      maxTurns: 1,
      systemPrompt: 'Return JSON.',
      userMessage: 'Summarize.',
      localMemoryEnabled: false,
      schema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
      isResult: (value): value is { value: string } =>
        typeof value === 'object' &&
        value !== null &&
        'value' in value &&
        typeof value.value === 'string',
    }).catch((caught: unknown) => caught);

    expect(getStructuredHelperQueryErrorUsage(error)).toMatchObject({
      inputTokens: 5,
      outputTokens: 2,
      totalCostUsd: 0.05,
      messageCount: 1,
      assistantMessageCount: 1,
    });
    expect(mockedClaudeQuery).toHaveBeenCalledTimes(1);
  });
});

describe('resolveHelperTranscriptProvider', () => {
  beforeAll(() => {
    initClaudeModels([{ id: 'claude-sonnet-4-6', label: 'Sonnet' }]);
    initCodexModels([{ id: 'gpt-5.5', label: 'GPT' }]);
  });

  afterAll(() => {
    initClaudeModels([]);
    initCodexModels([]);
  });

  it('returns the registry provider for known models', () => {
    expect(resolveHelperTranscriptProvider('claude-sonnet-4-6')).toBe('claude');
    expect(resolveHelperTranscriptProvider('gpt-5.5')).toBe('codex');
    expect(resolveHelperTranscriptProvider('ollama-llama3')).toBe('ollama');
  });

  it('follows the execution harness for routed gateway ids', () => {
    expect(
      resolveHelperTranscriptProvider('anthropic/claude-sonnet-5.5', 'codex'),
    ).toBe('codex');
    expect(
      resolveHelperTranscriptProvider('anthropic/claude-sonnet-5.5', 'claude'),
    ).toBe('claude');
  });

  it('never throws for an unknown id without a harness', () => {
    const model = 'anthropic/claude-sonnet-5.5';
    const expected =
      getExecutionHarnessForModel(model) === 'codex' ? 'codex' : 'claude';
    expect(resolveHelperTranscriptProvider(model)).toBe(expected);
  });
});
