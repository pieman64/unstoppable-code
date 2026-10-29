jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
}));

const mockStartThread = jest.fn<unknown, [unknown]>();
const mockResumeThread = jest.fn<unknown, [unknown]>();
const mockUnsubscribeCodexThread = jest.fn().mockResolvedValue(undefined);
const mockSpawnClaudeCodeProcessOffMain = jest.fn();
// Local memory is opt-in (CAN-1969); default off so advisor turns keep
// provider-native memory defaults. Tests flip the mock to assert suppression.
jest.mock('../lib/preferences-store', () => ({
  ...jest.requireActual<typeof PreferencesStoreModule>(
    '../lib/preferences-store',
  ),
  readLocalMemoryEnabledPreference: jest.fn(() => Promise.resolve(false)),
}));
jest.mock('../codex/runtime-service', () => ({
  getCodexRuntimeService: jest.fn(() => ({
    startThread: mockStartThread,
    resumeThread: mockResumeThread,
  })),
}));

const mockAssertCodexSpeedAvailable = jest.fn(
  (request: { speed: string }): Promise<Record<string, unknown>> =>
    Promise.resolve({ speed: request.speed, availability: {}, generation: 3 }),
);
const mockReportCodexSpeedRejection = jest.fn(
  (report: unknown): boolean => report !== undefined,
);
jest.mock('../model-routing/codex-account-models', () => ({
  assertCodexSpeedAvailable: (request: {
    speed: string;
  }): Promise<Record<string, unknown>> =>
    mockAssertCodexSpeedAvailable(request),
  reportCodexSpeedRejection: (report: unknown): boolean =>
    mockReportCodexSpeedRejection(report),
}));

jest.mock('../pipelines/config-paths', () => ({
  getBundledClaudeBinaryPath: jest.fn(() => '/mock/claude'),
  getBundledRgBinaryPath: jest.fn(() => '/mock/rg'),
  getEnhancedEnv: jest.fn(() => ({})),
}));
jest.mock('../agents/claude-process-host-runner', () => ({
  spawnClaudeCodeProcessOffMain: mockSpawnClaudeCodeProcessOffMain,
}));

const mockAppendTranscriptRecord = jest.fn();
const mockBeginClaudeQuery = jest.fn();
const mockEndClaudeQuery = jest.fn();
const mockObserveClaudeEvent = jest.fn();
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    appendTranscriptRecord: mockAppendTranscriptRecord,
    beginClaudeQuery: mockBeginClaudeQuery,
    endClaudeQuery: mockEndClaudeQuery,
    observeClaudeEvent: mockObserveClaudeEvent,
  })),
}));

import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import { CodexSpeedUnsupportedError } from '@canopy/desktop-shared/lib/codex-speed';
import { getEnhancedEnv } from '../pipelines/config-paths';
import {
  PIPELINE_ADVISOR_SYSTEM_PROMPT,
  runPipelineAdvisorSdkTurn,
} from '../pipelines/pipeline-advisor-sdk';
import type * as PreferencesStoreModule from '../lib/preferences-store';
import { readLocalMemoryEnabledPreference } from '../lib/preferences-store';

const mockedReadLocalMemoryEnabledPreference = jest.mocked(
  readLocalMemoryEnabledPreference,
);
const mockedClaudeQuery = jest.mocked(claudeQuery);
const mockedGetEnhancedEnv = jest.mocked(getEnhancedEnv);

type RunTurnMock = jest.Mock<Promise<Record<string, unknown>>, [unknown]>;

async function* makeEvents(events: unknown[]): AsyncGenerator<unknown, void> {
  for (const event of events) {
    await Promise.resolve();
    yield event;
  }
}

function mockCodexEventAttempts(attempts: unknown[][]): RunTurnMock {
  const runTurn = jest.fn<Promise<Record<string, unknown>>, [unknown]>();
  for (const events of attempts) {
    const records = events.filter(
      (event): event is Record<string, unknown> =>
        typeof event === 'object' && event !== null,
    );
    const failure = records.find(
      (event) => event.type === 'turn.failed' || event.type === 'error',
    );
    const message = records.find((event) => event.type === 'item.completed')
      ?.item as { text?: string } | undefined;
    const completed = records.find((event) => event.type === 'turn.completed');
    const rawUsage = completed?.usage as Record<string, number> | undefined;
    runTurn.mockImplementationOnce((request: unknown) => {
      const onEvent = (request as { onEvent?: (event: unknown) => void })
        .onEvent;
      for (const event of records) onEvent?.(event);
      return Promise.resolve(
        failure
          ? {
              status: 'failed',
              errorInfo: (
                failure.error as { codexErrorInfo?: string } | undefined
              )?.codexErrorInfo,
              threadId: 'thread-1',
              finalText: '',
              usage: {},
              error:
                failure.type === 'turn.failed'
                  ? ((failure.error as { message?: string })?.message ?? '')
                  : ((failure.message as string | undefined) ?? ''),
            }
          : {
              status: 'completed',
              threadId: 'thread-1',
              finalText: message?.text ?? '',
              usage: {
                inputTokens: rawUsage?.input_tokens,
                cacheReadInputTokens: rawUsage?.cached_input_tokens,
                outputTokens: rawUsage?.output_tokens,
              },
            },
      );
    });
  }
  mockStartThread.mockResolvedValue({
    threadId: 'thread-1',
    runTurn,
    unsubscribe: mockUnsubscribeCodexThread,
  });
  return runTurn;
}

function mockCodexEvents(events: unknown[]): RunTurnMock {
  return mockCodexEventAttempts([events]);
}

function createInput(
  overrides: Partial<Parameters<typeof runPipelineAdvisorSdkTurn>[0]> = {},
): Parameters<typeof runPipelineAdvisorSdkTurn>[0] {
  return {
    provider: 'codex',
    model: 'gpt-6-luna',
    thinkingLevel: 'high',
    executionDataDir: '/tmp/execution-1',
    systemPrompt: 'system prompt',
    userPrompt: 'user prompt',
    schema: { type: 'object' },
    observabilityTaskKey: 'advisor-task',
    workspaceId: 'workspace-1',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

it('pushes the advisor to provide a best-effort ETA before using unknown', () => {
  expect(PIPELINE_ADVISOR_SYSTEM_PROMPT).toContain(
    'always provide a best-effort ETA',
  );
  expect(PIPELINE_ADVISOR_SYSTEM_PROMPT).toContain(
    'Reserve eta.status unknown only',
  );
  expect(PIPELINE_ADVISOR_SYSTEM_PROMPT).toContain(
    'For terminal pipelines, report eta.status complete',
  );
  expect(PIPELINE_ADVISOR_SYSTEM_PROMPT).not.toContain(
    'If ETA cannot be estimated',
  );
});

it('retries Codex structured-output turn failures in the same thread', async () => {
  const runStreamed = mockCodexEventAttempts([
    [
      { type: 'thread.started', thread_id: 'thread-1' },
      {
        type: 'turn.failed',
        error: { message: 'Response does not match output schema' },
      },
    ],
    [
      {
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: '{"summary":"done"}',
        },
      },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 2,
          cached_input_tokens: 1,
          output_tokens: 3,
        },
      },
    ],
  ]);

  await expect(runPipelineAdvisorSdkTurn(createInput())).resolves.toMatchObject(
    {
      report: { summary: 'done' },
      sdkSessionId: 'thread-1',
      usage: {
        inputTokens: 2,
        cacheReadInputTokens: 1,
        outputTokens: 3,
      },
    },
  );
  expect(runStreamed).toHaveBeenCalledTimes(2);
  const retryInput = (
    runStreamed.mock.calls[1][0] as {
      input: Array<{ text: string }>;
    }
  ).input[0]?.text;
  expect(retryInput).toContain(
    'Your previous response failed JSON Schema validation.',
  );
  expect(retryInput).toContain('Response does not match output schema');
  expect(mockAppendTranscriptRecord).toHaveBeenCalledWith(
    'advisor-task',
    expect.objectContaining({ type: 'turn.failed' }),
  );
  expect(mockUnsubscribeCodexThread).toHaveBeenCalledTimes(1);
  const request = mockStartThread.mock.calls[0]?.[0] as
    | {
        params?: { config?: unknown };
        profile?: { logicalWorkspaceEnvironmentId?: unknown };
      }
    | undefined;
  expect(request?.params?.config).toEqual({
    service_tier: 'default',
  });
  expect(request?.profile?.logicalWorkspaceEnvironmentId).toEqual(
    expect.any(String),
  );
});

it('passes resolved service-tier and provider config into Codex advisor turns', async () => {
  mockCodexEvents([
    { type: 'thread.started', thread_id: 'thread-1' },
    {
      type: 'item.completed',
      item: {
        type: 'agent_message',
        text: '{"summary":"done"}',
      },
    },
    {
      type: 'turn.completed',
      usage: {
        input_tokens: 2,
        cached_input_tokens: 1,
        output_tokens: 3,
      },
    },
  ]);

  await runPipelineAdvisorSdkTurn(
    createInput({
      model: 'qwen3-coder',
      modelConfig: { fastMode: true },
      codexConfig: {
        model_provider: 'canopy_ollama',
        model_providers: {
          canopy_ollama: {
            name: 'Ollama',
            base_url: 'http://127.0.0.1:11434/v1',
            wire_api: 'responses',
          },
        },
      },
    }),
  );

  const request = mockStartThread.mock.calls[0]?.[0] as
    | { params?: { config?: unknown } }
    | undefined;
  expect(request?.params?.config).toEqual({
    model_provider: 'canopy_ollama',
    model_providers: {
      canopy_ollama: {
        name: 'Ollama',
        base_url: 'http://127.0.0.1:11434/v1',
        wire_api: 'responses',
      },
    },
    service_tier: 'priority',
  });
});

it('applies the native-memory suppression to started and resumed Codex advisor threads while local memory is enabled', async () => {
  const original = process.env.CANOPY_HARNESS_NATIVE_MEMORY;
  delete process.env.CANOPY_HARNESS_NATIVE_MEMORY;
  mockedReadLocalMemoryEnabledPreference.mockResolvedValue(true);
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const readThreadRequestConfig = (request: unknown): unknown => {
    const params = isRecord(request) ? request.params : undefined;
    return isRecord(params) ? params.config : undefined;
  };
  const codexAdvisorEvents = (): unknown[] => [
    { type: 'thread.started', thread_id: 'thread-1' },
    {
      type: 'item.completed',
      item: { type: 'agent_message', text: '{"summary":"done"}' },
    },
    { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
  ];
  try {
    const runTurn = mockCodexEventAttempts([
      codexAdvisorEvents(),
      codexAdvisorEvents(),
    ]);
    mockResumeThread.mockResolvedValue({
      threadId: 'thread-1',
      runTurn,
      unsubscribe: mockUnsubscribeCodexThread,
    });

    await runPipelineAdvisorSdkTurn(createInput({ sdkSessionId: 'thread-1' }));
    expect(mockStartThread).not.toHaveBeenCalled();
    expect(
      readThreadRequestConfig(mockResumeThread.mock.calls[0]?.[0]),
    ).toEqual({
      service_tier: 'default',
      'features.memories': false,
    });

    process.env.CANOPY_HARNESS_NATIVE_MEMORY = '1';
    await runPipelineAdvisorSdkTurn(createInput());
    expect(readThreadRequestConfig(mockStartThread.mock.calls[0]?.[0])).toEqual(
      { service_tier: 'default' },
    );
  } finally {
    mockedReadLocalMemoryEnabledPreference.mockImplementation(() =>
      Promise.resolve(false),
    );
    if (original === undefined) {
      delete process.env.CANOPY_HARNESS_NATIVE_MEMORY;
    } else {
      process.env.CANOPY_HARNESS_NATIVE_MEMORY = original;
    }
  }
});

it('observes an Ollama advisor turn as ollama without a Claude cost query', async () => {
  mockedClaudeQuery.mockReturnValueOnce(
    makeEvents([
      { type: 'system', session_id: 'ollama-session' },
      {
        type: 'result',
        session_id: 'ollama-session',
        total_cost_usd: 0.5,
        structured_output: { summary: 'done' },
        result: '{"summary":"done"}',
      },
    ]) as never,
  );

  await expect(
    runPipelineAdvisorSdkTurn(
      createInput({ provider: 'claude', providerType: 'ollama' }),
    ),
  ).resolves.toMatchObject({ report: { summary: 'done' } });

  expect(mockObserveClaudeEvent).toHaveBeenCalledWith(
    'advisor-task',
    expect.objectContaining({ type: 'result' }),
    'ollama',
  );
  expect(mockBeginClaudeQuery).not.toHaveBeenCalled();
  expect(mockEndClaudeQuery).not.toHaveBeenCalled();
});

it('resolves Claude advisor turns with the workspace-scoped Agent Runtime', async () => {
  delete process.env.CANOPY_HARNESS_NATIVE_MEMORY;
  mockedReadLocalMemoryEnabledPreference.mockResolvedValueOnce(true);
  mockedGetEnhancedEnv.mockReturnValueOnce({ BASE_ENV: 'base' });
  mockedClaudeQuery.mockReturnValue(
    makeEvents([
      { type: 'system', session_id: 'claude-session-1' },
      {
        type: 'result',
        structured_output: { summary: 'done' },
        result: '{"summary":"done"}',
      },
    ]) as never,
  );

  await expect(
    runPipelineAdvisorSdkTurn(
      createInput({
        provider: 'claude',
        envOverride: {
          ANTHROPIC_BASE_URL: 'https://credits.example.test',
          ANTHROPIC_API_KEY: 'test-key',
        },
      }),
    ),
  ).resolves.toMatchObject({
    report: { summary: 'done' },
    sdkSessionId: 'claude-session-1',
  });

  expect(mockedGetEnhancedEnv).toHaveBeenCalledWith({
    environment: { runtime: 'agent', workspaceId: 'workspace-1' },
  });
  expect(mockedClaudeQuery.mock.calls[0]?.[0]?.options?.env).toEqual({
    BASE_ENV: 'base',
    ANTHROPIC_BASE_URL: 'https://credits.example.test',
    ANTHROPIC_API_KEY: 'test-key',
  });
  expect(
    mockedClaudeQuery.mock.calls[0]?.[0]?.options?.spawnClaudeCodeProcess,
  ).toBe(mockSpawnClaudeCodeProcessOffMain);
  // Native-memory suppression applies to advisor turns too while local
  // memory is enabled (CAN-1969).
  expect(mockedClaudeQuery.mock.calls[0]?.[0]?.options?.settings).toEqual({
    autoMemoryEnabled: false,
  });
});

it('stops retrying Codex structured-output failures after two retries', async () => {
  const failure = (attempt: number): unknown[] => [
    ...(attempt === 1
      ? [{ type: 'thread.started', thread_id: 'thread-1' }]
      : []),
    {
      type: 'turn.failed',
      error: {
        message: `Response does not match output schema on attempt ${attempt}`,
      },
    },
  ];
  const runStreamed = mockCodexEventAttempts([
    failure(1),
    failure(2),
    failure(3),
  ]);

  await expect(runPipelineAdvisorSdkTurn(createInput())).rejects.toThrow(
    'Pipeline Advisor Codex turn failed: Response does not match output schema on attempt 3',
  );
  expect(runStreamed).toHaveBeenCalledTimes(3);
  expect(mockUnsubscribeCodexThread).toHaveBeenCalledTimes(1);
});

it('fails non-schema Codex turn failures without retrying', async () => {
  const runStreamed = mockCodexEvents([
    { type: 'thread.started', thread_id: 'thread-1' },
    {
      type: 'turn.failed',
      error: { message: 'model overloaded' },
    },
  ]);

  await expect(runPipelineAdvisorSdkTurn(createInput())).rejects.toThrow(
    'Pipeline Advisor Codex turn failed: model overloaded',
  );
  expect(runStreamed).toHaveBeenCalledTimes(1);
});

it('does not return stale agent JSON after a Codex stream error', async () => {
  mockCodexEvents([
    { type: 'thread.started', thread_id: 'thread-1' },
    {
      type: 'item.completed',
      item: {
        type: 'agent_message',
        text: '{"summary":"stale"}',
      },
    },
    { type: 'error', message: 'stream disconnected' },
  ]);

  await expect(runPipelineAdvisorSdkTurn(createInput())).rejects.toThrow(
    'Pipeline Advisor Codex turn failed: stream disconnected',
  );
});

describe('Codex advisor speed admission', () => {
  const completedAdvisorEvents = (): unknown[] => [
    { type: 'thread.started', thread_id: 'thread-1' },
    {
      type: 'item.completed',
      item: { type: 'agent_message', text: '{"summary":"done"}' },
    },
    { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
  ];

  function startedThreadConfig(): unknown {
    const request = mockStartThread.mock.calls[0]?.[0] as
      | { params?: { config?: unknown } }
      | undefined;
    return request?.params?.config;
  }

  it('admits the exact Ultra fast speed with trusted route facts before starting the thread', async () => {
    mockCodexEvents(completedAdvisorEvents());

    await runPipelineAdvisorSdkTurn(
      createInput({
        model: 'gpt-5.5',
        modelConfig: { speed: 'ultrafast' },
        codexSpeedRoute: {
          selectedModel: 'gpt-5.5',
          modelSource: 'codex-managed',
          providerType: 'codex',
          gateway: null,
        },
      }),
    );

    const admissionRequest: unknown =
      mockAssertCodexSpeedAvailable.mock.calls[0]?.[0];
    expect(admissionRequest).toMatchObject({
      speed: 'ultrafast',
      route: {
        runtimeModel: 'gpt-5.5',
        modelSource: 'codex-managed',
        harness: 'codex',
        routeProfile: 'codex-native',
      },
    });
    expect(
      mockAssertCodexSpeedAvailable.mock.invocationCallOrder[0],
    ).toBeLessThan(mockStartThread.mock.invocationCallOrder[0] ?? 0);
    expect(startedThreadConfig()).toMatchObject({ service_tier: 'ultrafast' });
  });

  it('classifies an AI Credits routed advisor as the gateway route', async () => {
    mockCodexEvents(completedAdvisorEvents());

    await runPipelineAdvisorSdkTurn(
      createInput({
        model: 'openai/gpt-5.5',
        modelConfig: { speed: 'fast' },
        codexConfig: {
          model_provider: 'canopy_gateway',
          model_providers: { canopy_gateway: { name: 'Gateway' } },
        },
        codexSpeedRoute: {
          selectedModel: 'gpt-5.5',
          modelSource: 'codex-managed',
          providerType: 'codex',
          gateway: 'ai-credits',
        },
      }),
    );

    const admissionRequest: unknown =
      mockAssertCodexSpeedAvailable.mock.calls[0]?.[0];
    expect(admissionRequest).toMatchObject({
      speed: 'fast',
      route: {
        runtimeModel: 'openai/gpt-5.5',
        routeProfile: 'ai-credits',
      },
    });
  });

  it('rejects an unavailable Ultra fast speed before starting or resuming a thread', async () => {
    mockAssertCodexSpeedAvailable.mockRejectedValueOnce(
      new CodexSpeedUnsupportedError(
        'ultrafast',
        'Ultra fast is not available for this model.',
      ),
    );

    await expect(
      runPipelineAdvisorSdkTurn(
        createInput({
          model: 'gpt-5.5',
          modelConfig: { speed: 'ultrafast' },
          sdkSessionId: 'thread-1',
        }),
      ),
    ).rejects.toThrow('Ultra fast is not available for this model.');

    expect(mockStartThread).not.toHaveBeenCalled();
    expect(mockResumeThread).not.toHaveBeenCalled();
  });

  it('reports a failed Ultra fast advisor turn once against its admission', async () => {
    const runTurn = jest.fn(() =>
      Promise.resolve({
        status: 'failed',
        threadId: 'thread-1',
        finalText: '',
        usage: {},
        error: 'The requested service tier is not available for this model.',
        errorInfo: 'badRequest',
      }),
    );
    mockStartThread.mockResolvedValue({
      threadId: 'thread-1',
      runTurn,
      unsubscribe: mockUnsubscribeCodexThread,
    });

    await expect(
      runPipelineAdvisorSdkTurn(
        createInput({ model: 'gpt-5.5', modelConfig: { speed: 'ultrafast' } }),
      ),
    ).rejects.toThrow('service tier');

    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(mockReportCodexSpeedRejection).toHaveBeenCalledTimes(1);
    expect(mockReportCodexSpeedRejection).toHaveBeenCalledWith({
      speed: 'ultrafast',
      runtimeModel: 'gpt-5.5',
      kind: 'tier',
      generation: 3,
    });
  });
});

it.each(['claude', 'codex'] as const)(
  'resumes a %s advisor terminal quota failure in its retained session',
  async (provider) => {
    const waitForQuotaRecovery = jest.fn(() => Promise.resolve());
    const controller = new AbortController();
    if (provider === 'claude') {
      mockedClaudeQuery.mockReturnValueOnce(
        makeEvents([
          { type: 'system', session_id: 'quota-session' },
          {
            type: 'result',
            is_error: true,
            subtype: 'error_during_execution',
            api_error_status: 429,
            errors: ['Usage limit exceeded'],
            usage: { input_tokens: 7 },
          },
        ]) as never,
      );
      mockedClaudeQuery.mockReturnValueOnce(
        makeEvents([
          { type: 'system', session_id: 'quota-session' },
          {
            type: 'result',
            is_error: false,
            structured_output: { summary: 'done' },
            usage: { input_tokens: 3 },
          },
        ]) as never,
      );
    } else {
      const runTurn = mockCodexEventAttempts([
        [
          {
            type: 'turn.failed',
            error: {
              message: 'Usage limit exceeded',
              codexErrorInfo: 'usageLimitExceeded',
            },
          },
        ],
        [
          {
            type: 'item.completed',
            item: { type: 'agent_message', text: '{"summary":"done"}' },
          },
          { type: 'turn.completed', usage: { input_tokens: 3 } },
        ],
      ]);
      mockResumeThread.mockResolvedValue({
        threadId: 'thread-1',
        runTurn,
        unsubscribe: mockUnsubscribeCodexThread,
      });
    }
    const result = await runPipelineAdvisorSdkTurn(
      createInput({
        provider,
        waitForQuotaRecovery,
        abortController: controller,
      }),
    );
    expect(result.report).toEqual({ summary: 'done' });
    expect(result.usage.inputTokens).toBe(provider === 'claude' ? 10 : 3);
    expect(waitForQuotaRecovery).toHaveBeenCalledTimes(1);
    expect(waitForQuotaRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'provider_usage_limit' }),
      controller.signal,
    );
    if (provider === 'claude') {
      expect(mockedClaudeQuery.mock.calls[1]?.[0]?.options?.resume).toBe(
        'quota-session',
      );
      expect(
        mockedClaudeQuery.mock.calls[1]?.[0]?.options?.abortController,
      ).toBe(controller);
    } else {
      const resumed: unknown = mockResumeThread.mock.calls[0]?.[0];
      expect(resumed).toMatchObject({ params: { threadId: 'thread-1' } });
    }
  },
);

it('keeps a successful advisor result after a nonterminal quota notice', async () => {
  const waitForQuotaRecovery = jest.fn(() => Promise.resolve());
  mockedClaudeQuery.mockReturnValueOnce(
    makeEvents([
      { type: 'system', session_id: 'quota-session' },
      { type: 'assistant', error: 'rate_limit' },
      {
        type: 'result',
        is_error: false,
        structured_output: { summary: 'done' },
      },
    ]) as never,
  );
  await expect(
    runPipelineAdvisorSdkTurn(
      createInput({ provider: 'claude', waitForQuotaRecovery }),
    ),
  ).resolves.toMatchObject({ report: { summary: 'done' } });
  expect(waitForQuotaRecovery).not.toHaveBeenCalled();
  expect(mockedClaudeQuery).toHaveBeenCalledTimes(1);
});

it('does not start another advisor turn after cancellation during quota recovery', async () => {
  const controller = new AbortController();
  const waitForQuotaRecovery = jest.fn(() => {
    controller.abort(new Error('Advisor stopped'));
    return Promise.resolve();
  });
  mockedClaudeQuery.mockReturnValueOnce(
    makeEvents([
      { type: 'system', session_id: 'quota-session' },
      {
        type: 'result',
        is_error: true,
        api_error_status: 429,
        errors: ['Quota reached'],
      },
    ]) as never,
  );
  await expect(
    runPipelineAdvisorSdkTurn(
      createInput({
        provider: 'claude',
        waitForQuotaRecovery,
        abortController: controller,
      }),
    ),
  ).rejects.toThrow('Advisor stopped');
  expect(mockedClaudeQuery).toHaveBeenCalledTimes(1);
});
