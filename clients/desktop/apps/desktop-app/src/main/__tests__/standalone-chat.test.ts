interface ClaudeQueryOptionsForTest {
  cwd?: string;
  pathToClaudeCodeExecutable?: string;
  sandbox?: { ripgrep?: { command?: string } };
  spawnClaudeCodeProcess?: unknown;
  env?: Record<string, string>;
  model?: string;
  settings?: unknown;
}
const mockQuery = jest.fn<unknown, [{ options?: ClaudeQueryOptionsForTest }]>();
interface CodexEphemeralRequestForTest {
  params: {
    model: string;
    config: unknown;
  };
  profile: {
    environment: Record<string, string>;
    logicalWorkspaceEnvironmentId?: string;
    secretVersionFingerprint?: string;
  };
  turn: {
    input: unknown[];
  };
}

interface WorkerRequestForTest {
  prompt: string;
  resumeSessionId?: string;
}

const mockCodexRunEphemeralTurn = jest.fn<
  Promise<unknown>,
  [CodexEphemeralRequestForTest]
>();
const mockCodexDeleteThread = jest.fn(() => Promise.resolve());
const mockCodexStartThread = jest.fn(
  (request: Omit<CodexEphemeralRequestForTest, 'turn'>) =>
    Promise.resolve({
      threadId: 'summary-thread',
      runTurn: (turn: CodexEphemeralRequestForTest['turn']) =>
        mockCodexRunEphemeralTurn({ ...request, turn }),
      get delete() {
        return mockCodexDeleteThread;
      },
    }),
);
const mockResolveCodexRuntimeEnvironmentProfile = jest.fn(() => ({
  environment: { WORKSPACE_AGENT_ENV: 'enabled' },
  logicalWorkspaceEnvironmentId: 'agent:project-1',
  secretVersionFingerprint: 'workspace-secret-v1',
}));
const resolveClaudeCompatibleInvocationMock = jest.fn();
const mockRunWorker = jest.fn<Promise<unknown>, [WorkerRequestForTest]>();
const mockSpawnClaudeCodeProcessOffMain = jest.fn();
import type { ObservabilityService } from '../observability/service';
const mockSeedTranscript = jest.fn<
  ReturnType<ObservabilityService['seedTranscript']>,
  Parameters<ObservabilityService['seedTranscript']>
>();
const mockAppendTranscriptRecord = jest.fn<
  ReturnType<ObservabilityService['appendTranscriptRecord']>,
  Parameters<ObservabilityService['appendTranscriptRecord']>
>();
const mockUpdateObservedTask = jest.fn<
  ReturnType<ObservabilityService['updateObservedTask']>,
  Parameters<ObservabilityService['updateObservedTask']>
>();
const mockFinalizeObservedTask = jest.fn<
  ReturnType<ObservabilityService['finalizeObservedTask']>,
  Parameters<ObservabilityService['finalizeObservedTask']>
>();
const mockIsModelBlockedByStoredPolicy = jest.fn(() => Promise.resolve(false));

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  get query(): typeof mockQuery {
    return mockQuery;
  },
}));
jest.mock('@canopy/desktop-shared/lib/codex-model-config', () => ({
  codexServiceTierForModelConfig: jest.fn((config?: { fastMode?: boolean }) =>
    config?.fastMode === true ? 'priority' : 'default',
  ),
  mapThinkingToReasoningEffort: jest.fn((level: string) => level),
}));
jest.mock('../codex/runtime-service', () => ({
  getCodexRuntimeService: jest.fn(() => ({
    get startThread(): typeof mockCodexStartThread {
      return mockCodexStartThread;
    },
  })),
}));
jest.mock('../lib/user-environment-runtime', () => ({
  get resolveCodexRuntimeEnvironmentProfile(): typeof mockResolveCodexRuntimeEnvironmentProfile {
    return mockResolveCodexRuntimeEnvironmentProfile;
  },
}));
jest.mock('../pipelines/config-paths', () => ({
  getBundledClaudeBinaryPath: jest.fn(() => '/mock/claude'),
  getBundledRgBinaryPath: jest.fn(() => '/mock/rg'),
  getEnhancedEnv: jest.fn(() => ({ ...process.env })),
}));
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    get seedTranscript(): typeof mockSeedTranscript {
      return mockSeedTranscript;
    },
    get appendTranscriptRecord(): typeof mockAppendTranscriptRecord {
      return mockAppendTranscriptRecord;
    },
    get updateObservedTask(): typeof mockUpdateObservedTask {
      return mockUpdateObservedTask;
    },
    get finalizeObservedTask(): typeof mockFinalizeObservedTask {
      return mockFinalizeObservedTask;
    },
    beginClaudeQuery: jest.fn(),
    endClaudeQuery: jest.fn(),
    observeClaudeEvent: jest.fn(),
  })),
}));
jest.mock('../lib/model-policy-state', () => ({
  get isModelBlockedByStoredPolicy(): typeof mockIsModelBlockedByStoredPolicy {
    return mockIsModelBlockedByStoredPolicy;
  },
}));
jest.mock('../ollama/claude-compatible', () => ({
  get resolveClaudeCompatibleInvocation(): typeof resolveClaudeCompatibleInvocationMock {
    return resolveClaudeCompatibleInvocationMock;
  },
}));
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(() =>
    Promise.resolve({ canopyBackgroundProcessesMode: 'canopy' }),
  ),
  // Local memory is opt-in (CAN-1969); default off in tests.
  readLocalMemoryEnabledPreference: jest.fn(() => Promise.resolve(false)),
}));
jest.mock('../integration/claude-worker-session-service', () => ({
  getClaudeWorkerSessionService: jest.fn(() => ({
    get runWorker(): typeof mockRunWorker {
      return mockRunWorker;
    },
  })),
}));
jest.mock('../agents/claude-process-host-runner', () => ({
  get spawnClaudeCodeProcessOffMain(): typeof mockSpawnClaudeCodeProcessOffMain {
    return mockSpawnClaudeCodeProcessOffMain;
  },
}));

import {
  initClaudeModels,
  initCodexModels,
  initModelHarnessAssignments,
  initOllamaModels,
} from '@canopy/desktop-shared/types';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import { getEnhancedEnv } from '../pipelines/config-paths';
import {
  readLocalMemoryEnabledPreference,
  readPreferencesFile,
} from '../lib/preferences-store';

const mockedReadLocalMemoryEnabledPreference = jest.mocked(
  readLocalMemoryEnabledPreference,
);
import {
  generateArchiveSummary,
  generateChatSummary,
  generateHandoffSummary,
} from '../agents/utils';
import { SHORT_CHAT_TITLE_SYSTEM_PROMPT } from '@canopy/protocol/generated-names';
import { getCodexGatewayProxyService } from '../agents/codex-gateway-proxy-service';

const mockedGetEnhancedEnv = jest.mocked(getEnhancedEnv);
const mockedReadPreferencesFile = jest.mocked(readPreferencesFile);

function preferencesForBackgroundProcessMode(
  mode: PreferencesData['canopyBackgroundProcessesMode'],
): PreferencesData {
  const preferences: Partial<PreferencesData> = {
    canopyBackgroundProcessesMode: mode,
  };
  // A partial fixture: these tests rely on unset preferences staying undefined.
  return preferences as PreferencesData;
}

initClaudeModels([{ id: 'haiku', label: 'Haiku 5.5' }]);
initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);

async function* makeMessages(
  messages: unknown[],
): AsyncGenerator<unknown, void> {
  for (const message of messages) {
    await Promise.resolve();
    yield message;
  }
}

describe('standalone-chat Claude integration', () => {
  beforeEach(() => {
    initOllamaModels([
      {
        id: 'ollama-qwen3-coder',
        rawModelId: 'qwen3-coder',
        label: 'qwen3-coder',
        show: { capabilities: ['completion', 'tools'] },
      },
    ]);
    initModelHarnessAssignments({
      revision: 1,
      assignments: [
        {
          modelId: 'ollama-qwen3-coder',
          source: 'ollama',
          harness: 'claude',
          defaultHarness: 'codex',
          configurable: true,
          overridden: true,
        },
      ],
    });
    mockQuery.mockReset();
    mockCodexRunEphemeralTurn.mockReset();
    mockCodexStartThread.mockClear();
    mockCodexDeleteThread.mockClear();
    mockResolveCodexRuntimeEnvironmentProfile.mockClear();
    mockRunWorker.mockReset();
    mockFinalizeObservedTask.mockReset();
    mockIsModelBlockedByStoredPolicy.mockReset();
    mockIsModelBlockedByStoredPolicy.mockResolvedValue(false);
    mockedGetEnhancedEnv.mockClear();
    mockedReadPreferencesFile.mockResolvedValue(
      preferencesForBackgroundProcessMode('canopy'),
    );
    resolveClaudeCompatibleInvocationMock.mockReset();
    resolveClaudeCompatibleInvocationMock.mockResolvedValue({
      providerType: 'claude',
      sdkModel: 'haiku',
    });
  });

  afterAll(() => {
    initModelHarnessAssignments({ revision: 0, assignments: [] });
    initOllamaModels([]);
  });

  it('uses the bundled Claude binary for summary generation', async () => {
    mockQuery.mockReturnValue(
      makeMessages([
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Topic Summary' }],
          },
        },
      ]),
    );

    const result = await generateChatSummary('Summarize this topic', {
      purpose: 'chat-title',
    });
    const calls = mockQuery.mock.calls as Array<
      [
        {
          options?: {
            systemPrompt?: string;
            cwd?: string;
            pathToClaudeCodeExecutable?: string;
            sandbox?: { ripgrep?: { command?: string } };
            spawnClaudeCodeProcess?: unknown;
          };
        },
      ]
    >;
    const firstCall = calls[0]?.[0];

    expect(result.text).toBe('Topic Summary');
    expect(firstCall?.options?.systemPrompt).toBe(
      SHORT_CHAT_TITLE_SYSTEM_PROMPT,
    );
    expect(firstCall?.options?.pathToClaudeCodeExecutable).toBe('/mock/claude');
    expect(firstCall?.options?.spawnClaudeCodeProcess).toBe(
      mockSpawnClaudeCodeProcessOffMain,
    );
    expect(firstCall?.options?.cwd).toBeDefined();
    expect(firstCall?.options?.sandbox?.ripgrep?.command).toBe('/mock/rg');
  });

  it('uses project Agent Runtime env for Claude summary generation', async () => {
    mockQuery.mockReturnValue(
      makeMessages([
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Project Summary' }],
          },
        },
      ]),
    );

    await generateChatSummary('Summarize this topic', {
      workspaceId: 'project-1',
    });

    expect(mockedGetEnhancedEnv).toHaveBeenCalledWith({
      environment: { runtime: 'agent', workspaceId: 'project-1' },
    });
    expect(mockQuery.mock.calls[0]?.[0]?.options?.spawnClaudeCodeProcess).toBe(
      mockSpawnClaudeCodeProcessOffMain,
    );
  });

  it('uses the Claude terminal result text when no assistant text event is emitted', async () => {
    mockQuery.mockReturnValue(
      makeMessages([
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'Result Summary',
          usage: {
            input_tokens: 3,
            output_tokens: 5,
          },
        },
      ]),
    );

    const result = await generateChatSummary('Summarize this topic');

    expect(result.text).toBe('Result Summary');
    expect(result.usage.messageCount).toBe(1);
    expect(result.usage.assistantMessageCount).toBe(1);
  });

  it('marks fully sanitized Claude output as a fallback', async () => {
    mockQuery.mockReturnValue(
      makeMessages([
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: '---' }] },
        },
      ]),
    );

    await expect(generateChatSummary('Summarize this topic')).resolves.toEqual(
      expect.objectContaining({
        text: 'Summarize this topic',
        fallback: { reason: 'Summary generation returned no usable text.' },
      }),
    );
  });

  it('retries transient Claude summary failures with the chat backoff', async () => {
    jest.useFakeTimers();
    try {
      let signalFirstQueryStarted: (() => void) | undefined;
      const firstQueryStarted = new Promise<void>((resolve) => {
        signalFirstQueryStarted = resolve;
      });
      mockQuery
        .mockImplementationOnce(() => {
          signalFirstQueryStarted?.();
          return makeMessages([
            {
              type: 'assistant',
              error: 'server_error',
              message: 'Provider overloaded',
            },
            {
              type: 'result',
              subtype: 'error_during_execution',
              is_error: true,
              error: 'overloaded_error',
              result: 'Claude SDK error: server_error',
              usage: {
                input_tokens: 9,
                output_tokens: 2,
              },
              total_cost_usd: 0.09,
            },
          ]);
        })
        .mockReturnValueOnce(
          makeMessages([
            {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: 'Recovered Summary' }],
              },
            },
          ]),
        );

      const resultPromise = generateChatSummary('Summarize this topic');
      await firstQueryStarted;
      await jest.advanceTimersByTimeAsync(29_999);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);

      await expect(resultPromise).resolves.toMatchObject({
        text: 'Recovered Summary',
        usage: {
          inputTokens: 9,
          outputTokens: 2,
          totalCostUsd: 0.09,
          messageCount: 2,
          assistantMessageCount: 2,
        },
      });
      expect(mockQuery).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('uses project Agent Runtime env and service tier for Codex summary generation', async () => {
    mockCodexRunEphemeralTurn.mockResolvedValue({
      status: 'completed',
      finalText: 'Codex Project Summary',
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadInputTokens: 0,
      },
    });

    const result = await generateChatSummary('Summarize this topic', {
      model: 'gpt-5.5',
      modelConfig: { fastMode: true },
      workspaceId: 'project-1',
    });

    expect(result.text).toBe('Codex Project Summary');
    expect(mockResolveCodexRuntimeEnvironmentProfile).toHaveBeenCalledWith({
      runtime: 'agent',
      workspaceId: 'project-1',
    });
    const request = mockCodexRunEphemeralTurn.mock.calls[0]?.[0];
    expect(request?.params).toMatchObject({
      model: 'gpt-5.5',
      config: { service_tier: 'priority' },
    });
    expect(request?.profile).toMatchObject({
      environment: { WORKSPACE_AGENT_ENV: 'enabled' },
      logicalWorkspaceEnvironmentId: 'agent:project-1',
      secretVersionFingerprint: 'workspace-secret-v1',
    });
    expect(request?.turn.input).toEqual([
      {
        type: 'text',
        text: '<user_message_to_summarize>Summarize this topic</user_message_to_summarize>',
        text_elements: [],
      },
    ]);
  });

  it('releases the Codex helper route when preflight fails before thread start', async () => {
    const unregisterSpy = jest.spyOn(
      getCodexGatewayProxyService(),
      'unregisterRoutesForSession',
    );
    mockResolveCodexRuntimeEnvironmentProfile.mockImplementationOnce(() => {
      throw new Error('Codex preflight failed');
    });

    try {
      await expect(
        generateChatSummary('Summarize this topic', { model: 'gpt-5.5' }),
      ).resolves.toMatchObject({
        fallback: { reason: 'Codex preflight failed' },
      });
      expect(mockCodexStartThread).not.toHaveBeenCalled();
      expect(unregisterSpy).toHaveBeenCalledWith(
        expect.stringMatching(/^ephemeral:helper:/),
      );
      expect(unregisterSpy).toHaveBeenCalledTimes(1);
    } finally {
      unregisterSpy.mockRestore();
    }
  });

  it('marks empty Codex output as a fallback', async () => {
    mockCodexRunEphemeralTurn.mockResolvedValue({
      status: 'completed',
      finalText: '',
      usage: { inputTokens: 1, outputTokens: 0 },
    });

    await expect(
      generateChatSummary('Summarize this topic', { model: 'gpt-5.5' }),
    ).resolves.toEqual(
      expect.objectContaining({
        text: 'Summarize this topic',
        fallback: { reason: 'Summary generation returned no usable text.' },
      }),
    );
  });

  it('preserves usage when a Codex summary outcome is not completed', async () => {
    mockCodexRunEphemeralTurn.mockResolvedValue({
      status: 'failed',
      threadId: 'summary-thread',
      finalText: '',
      error: 'Invalid request',
      usage: {
        inputTokens: 13,
        outputTokens: 5,
        totalCostUsd: 0.2,
      },
    });

    const result = await generateChatSummary('Summarize this topic', {
      model: 'gpt-5.5',
    });

    expect(result).toMatchObject({
      text: 'Summarize this topic',
      usage: {
        inputTokens: 13,
        outputTokens: 5,
        totalCostUsd: 0.2,
      },
    });
  });

  it('omits the native-memory suppression from summaries by default (local memory opt-in)', async () => {
    const original = process.env.CANOPY_HARNESS_NATIVE_MEMORY;
    delete process.env.CANOPY_HARNESS_NATIVE_MEMORY;
    try {
      mockQuery.mockReturnValue(
        makeMessages([
          {
            type: 'assistant',
            message: {
              content: [{ type: 'text', text: 'Summary text' }],
            },
          },
        ]),
      );

      await generateChatSummary('Summarize this topic');
      expect(mockQuery.mock.calls[0]?.[0]?.options?.settings).toBeUndefined();
    } finally {
      if (original === undefined) {
        delete process.env.CANOPY_HARNESS_NATIVE_MEMORY;
      } else {
        process.env.CANOPY_HARNESS_NATIVE_MEMORY = original;
      }
    }
  });

  it('applies the native-memory suppression to chat, archive, and handoff summaries while local memory is enabled', async () => {
    const original = process.env.CANOPY_HARNESS_NATIVE_MEMORY;
    delete process.env.CANOPY_HARNESS_NATIVE_MEMORY;
    mockedReadLocalMemoryEnabledPreference.mockResolvedValue(true);
    try {
      mockQuery.mockReturnValue(
        makeMessages([
          {
            type: 'assistant',
            message: {
              content: [{ type: 'text', text: 'Summary text' }],
            },
          },
        ]),
      );

      await generateChatSummary('Summarize this topic');
      expect(mockQuery.mock.calls[0]?.[0]?.options?.settings).toEqual({
        autoMemoryEnabled: false,
      });

      mockQuery.mockClear();
      mockQuery.mockReturnValue(
        makeMessages([
          {
            type: 'assistant',
            message: {
              content: [{ type: 'text', text: 'Summary text' }],
            },
          },
        ]),
      );
      await generateArchiveSummary('Archived conversation', {
        workspaceId: 'project-1',
      });
      expect(mockQuery.mock.calls[0]?.[0]?.options?.settings).toEqual({
        autoMemoryEnabled: false,
      });

      mockQuery.mockClear();
      mockQuery.mockReturnValue(
        makeMessages([
          {
            type: 'assistant',
            message: {
              content: [{ type: 'text', text: 'Summary text' }],
            },
          },
        ]),
      );
      await generateHandoffSummary('User: continue this task', {
        cwd: '/tmp/repo',
        workspaceId: 'project-1',
      });
      expect(mockQuery.mock.calls[0]?.[0]?.options?.settings).toEqual({
        autoMemoryEnabled: false,
      });
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

  it('applies the native-memory suppression to Codex summary thread config while local memory is enabled', async () => {
    const original = process.env.CANOPY_HARNESS_NATIVE_MEMORY;
    delete process.env.CANOPY_HARNESS_NATIVE_MEMORY;
    mockedReadLocalMemoryEnabledPreference.mockResolvedValue(true);
    try {
      mockCodexRunEphemeralTurn.mockResolvedValue({
        status: 'completed',
        finalText: 'Codex Summary',
        usage: { inputTokens: 1, outputTokens: 2 },
      });

      await generateChatSummary('Summarize this topic', { model: 'gpt-5.5' });
      const request = mockCodexRunEphemeralTurn.mock.calls[0]?.[0];
      expect(request?.params.config).toMatchObject({
        'features.memories': false,
      });
      expect(request?.params.config).not.toHaveProperty(['features']);

      mockCodexRunEphemeralTurn.mockClear();
      process.env.CANOPY_HARNESS_NATIVE_MEMORY = '1';
      await generateChatSummary('Summarize this topic', { model: 'gpt-5.5' });
      const allowedRequest = mockCodexRunEphemeralTurn.mock.calls[0]?.[0];
      expect(allowedRequest?.params.config).not.toHaveProperty([
        'features.memories',
      ]);
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

  it('uses project Agent Runtime env for archive summary generation', async () => {
    mockQuery.mockReturnValue(
      makeMessages([
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: '# Archive Summary' }],
          },
        },
      ]),
    );

    const result = await generateArchiveSummary('Archived conversation', {
      workspaceId: 'project-1',
    });

    expect(result.text).toBe('# Archive Summary');
    expect(mockedGetEnhancedEnv).toHaveBeenCalledWith({
      environment: { runtime: 'agent', workspaceId: 'project-1' },
    });
    expect(mockQuery.mock.calls[0]?.[0]?.options?.spawnClaudeCodeProcess).toBe(
      mockSpawnClaudeCodeProcessOffMain,
    );
  });

  it('uses project Agent Runtime env for handoff summary generation', async () => {
    mockQuery.mockReturnValue(
      makeMessages([
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Handoff Summary' }],
          },
        },
        {
          type: 'result',
          result: 'Handoff Summary',
          usage: { input_tokens: 12, output_tokens: 4 },
          total_cost_usd: 0.01,
        },
      ]),
    );

    const result = await generateHandoffSummary('User: continue this task', {
      cwd: '/tmp/repo',
      workspaceId: 'project-1',
      observabilityTaskKey: 'helper:handoff-summary:test',
    });

    expect(result.text).toBe('Handoff Summary');
    expect(result.usage).toEqual({
      inputTokens: 12,
      outputTokens: 4,
      totalCostUsd: 0.01,
      messageCount: 1,
      assistantMessageCount: 1,
    });
    expect(mockedGetEnhancedEnv).toHaveBeenCalledWith({
      environment: { runtime: 'agent', workspaceId: 'project-1' },
    });
    expect(mockQuery.mock.calls[0]?.[0]?.options?.spawnClaudeCodeProcess).toBe(
      mockSpawnClaudeCodeProcessOffMain,
    );
    const seededTranscript = mockSeedTranscript.mock.calls[0]?.[1];
    expect(mockSeedTranscript.mock.calls[0]?.[0]).toBe(
      'helper:handoff-summary:test',
    );
    expect(seededTranscript?.originalText).toBe('User: continue this task');
    expect(seededTranscript?.submittedText).toContain(
      'User: continue this task',
    );
    expect(Array.isArray(seededTranscript?.injectedPrompts)).toBe(true);
    expect(mockAppendTranscriptRecord).toHaveBeenCalledWith(
      'helper:handoff-summary:test',
      expect.objectContaining({ type: 'assistant' }),
    );
    expect(mockAppendTranscriptRecord).toHaveBeenCalledWith(
      'helper:handoff-summary:test',
      expect.objectContaining({ type: 'result' }),
    );
    expect(mockUpdateObservedTask).toHaveBeenCalledWith(
      'helper:handoff-summary:test',
      { attempt: 1 },
    );
  });

  it('routes ollama-backed summaries through the Claude-compatible env override', async () => {
    resolveClaudeCompatibleInvocationMock.mockResolvedValue({
      providerType: 'ollama',
      sdkModel: 'qwen3-coder',
      envOverride: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:11534',
        ANTHROPIC_AUTH_TOKEN: 'ollama',
        ANTHROPIC_API_KEY: '',
      },
    });
    mockQuery.mockReturnValue(
      makeMessages([
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Local Summary' }],
          },
        },
      ]),
    );

    const result = await generateChatSummary('Summarize this topic', {
      model: 'ollama-qwen3-coder',
    });
    const calls = mockQuery.mock.calls as Array<
      [
        {
          options?: {
            env?: Record<string, string>;
            model?: string;
          };
        },
      ]
    >;
    const firstCall = calls[0]?.[0];

    expect(result.text).toBe('Local Summary');
    expect(resolveClaudeCompatibleInvocationMock).toHaveBeenCalledWith(
      'ollama-qwen3-coder',
      {
        ensureRunningReason: 'helper',
        assertInstalled: true,
        providerType: 'ollama',
      },
    );
    expect(firstCall?.options?.model).toBe('qwen3-coder');
    expect(firstCall?.options?.env).toEqual(
      expect.objectContaining({
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:11534',
        ANTHROPIC_AUTH_TOKEN: 'ollama',
        ANTHROPIC_API_KEY: '',
      }),
    );
  });

  it('uses bypass permission for terminal-mode summary workers', async () => {
    mockedReadPreferencesFile.mockResolvedValue(
      preferencesForBackgroundProcessMode('terminal'),
    );
    mockRunWorker.mockResolvedValueOnce({
      status: 'success',
      finalText: 'Terminal Summary',
      usage: {},
    });

    const result = await generateChatSummary('Summarize this topic', {
      workspaceId: 'project-1',
      purpose: 'chat-title',
    });

    expect(result.text).toBe('Terminal Summary');
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockRunWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'chat_summary',
        systemPrompt: SHORT_CHAT_TITLE_SYSTEM_PROMPT,
        label: 'Chat Summary',
        projectId: 'project-1',
        permission: {
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          tools: [],
          allowedTools: [],
        },
        approvalMode: 'full-access',
        settingSources: [],
      }),
    );
  });

  it('marks empty terminal-worker output as a fallback', async () => {
    mockedReadPreferencesFile.mockResolvedValue(
      preferencesForBackgroundProcessMode('terminal'),
    );
    mockRunWorker.mockResolvedValueOnce({
      status: 'success',
      finalText: '',
      usage: { inputTokens: 2, outputTokens: 0 },
    });

    await expect(generateChatSummary('Summarize this topic')).resolves.toEqual(
      expect.objectContaining({
        text: 'Summarize this topic',
        fallback: { reason: 'Summary generation returned no usable text.' },
      }),
    );
  });

  it('retries transient terminal-mode summary worker failures', async () => {
    jest.useFakeTimers();
    try {
      mockedReadPreferencesFile.mockResolvedValue(
        preferencesForBackgroundProcessMode('terminal'),
      );
      let signalFirstWorkerStarted: (() => void) | undefined;
      const firstWorkerStarted = new Promise<void>((resolve) => {
        signalFirstWorkerStarted = resolve;
      });
      mockRunWorker
        .mockImplementationOnce(() => {
          signalFirstWorkerStarted?.();
          return Promise.resolve({
            workerId: 'summary-worker-1',
            sessionId: 'summary-session-1',
            sessionStarted: true,
            status: 'failure',
            finalText: 'Claude SDK error: server_error',
            usage: { inputTokens: 11, outputTokens: 4 },
            transcriptJsonl: JSON.stringify({
              type: 'assistant',
              error: 'server_error',
            }),
          });
        })
        .mockResolvedValueOnce({
          workerId: 'summary-worker-2',
          sessionId: 'summary-session-1',
          sessionStarted: true,
          status: 'success',
          finalText: 'Recovered Terminal Summary',
          usage: {},
          transcriptJsonl: '',
        });

      const resultPromise = generateChatSummary('Summarize this topic', {
        workspaceId: 'project-1',
      });
      await firstWorkerStarted;
      await jest.advanceTimersByTimeAsync(30_000);

      await expect(resultPromise).resolves.toMatchObject({
        text: 'Recovered Terminal Summary',
        usage: { inputTokens: 11, outputTokens: 4 },
      });
      expect(mockRunWorker).toHaveBeenCalledTimes(2);
      expect(mockRunWorker.mock.calls[1]?.[0]).toMatchObject({
        prompt: 'Continue',
        resumeSessionId: 'summary-session-1',
      });
      expect(mockQuery).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
