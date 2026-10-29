jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
}));

jest.mock('@canopy/desktop-shared/pipelines/config-paths', () => ({
  getBundledClaudeBinaryPath: jest.fn(() => '/fake/claude'),
  getBundledRgBinaryPath: jest.fn(() => '/fake/rg'),
  getEnhancedEnv: jest.fn(() => ({ PATH: '/usr/bin' })),
}));

jest.mock('@canopy/desktop-shared/lib/codex-model-config', () => ({
  codexServiceTierForModelConfig: jest.fn((config?: { fastMode?: boolean }) =>
    config?.fastMode === true ? 'priority' : 'default',
  ),
  mapThinkingToReasoningEffort: jest.fn(),
  toSdkThreadOptions: jest.fn((options: unknown) => options),
}));

interface CodexEphemeralRequestForTest {
  profile: {
    environment: Record<string, string>;
    logicalWorkspaceEnvironmentId?: string;
    secretVersionFingerprint?: string;
  };
  params: { config?: unknown };
  turn: {
    outputSchema?: Record<string, unknown>;
    onEvent?: (event: unknown) => void;
  };
}

const mockCodexRunEphemeralTurn = jest.fn<
  Promise<unknown>,
  [CodexEphemeralRequestForTest]
>();
const mockCodexDeleteThread = jest.fn(() => Promise.resolve());
const mockCodexStartThread = jest.fn(
  (request: Omit<CodexEphemeralRequestForTest, 'turn'>) =>
    Promise.resolve({
      threadId: 'commit-helper-thread',
      runTurn: (turn: CodexEphemeralRequestForTest['turn']) =>
        mockCodexRunEphemeralTurn({ ...request, turn }),
      delete: mockCodexDeleteThread,
    }),
);
const mockResolveCodexRuntimeEnvironmentProfile = jest.fn(() => ({
  environment: { WORKSPACE_AGENT_ENV: 'enabled' },
  logicalWorkspaceEnvironmentId: 'agent:workspace-agent',
  secretVersionFingerprint: 'workspace-secret-v1',
}));

jest.mock('../codex/runtime-service', () => ({
  getCodexRuntimeService: jest.fn(() => ({
    startThread: mockCodexStartThread,
  })),
}));

jest.mock('../lib/user-environment-runtime', () => ({
  resolveCodexRuntimeEnvironmentProfile:
    mockResolveCodexRuntimeEnvironmentProfile,
}));

jest.mock('../lib/helper-plugin-resolution', () => ({
  runWithOptionalHelperPlugins: jest.fn(),
}));

jest.mock('../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: jest.fn(() => Promise.resolve(false)),
}));

jest.mock('../ollama/helper-invocation', () => ({
  resolveHelperInvocation: jest.fn(),
  resolveHelperWorkOwner: jest.fn(() => Promise.resolve({ kind: 'personal' })),
}));

jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(() =>
    Promise.resolve({ canopyBackgroundProcessesMode: 'canopy' }),
  ),
  // Local memory is opt-in (CAN-1969); default off in tests.
  readLocalMemoryEnabledPreference: jest.fn(() => Promise.resolve(false)),
}));

const mockRunWorker = jest.fn();

jest.mock('../integration/claude-worker-session-service', () => ({
  getClaudeWorkerSessionService: jest.fn(() => ({
    runWorker: mockRunWorker,
  })),
}));

const startObservedTaskMock = jest.fn();
const finalizeObservedTaskMock = jest.fn();
const seedTranscriptMock = jest.fn();
const appendTranscriptRecordMock = jest.fn();
const updateObservedTaskMock = jest.fn();

jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    startObservedTask: startObservedTaskMock,
    finalizeObservedTask: finalizeObservedTaskMock,
    seedTranscript: seedTranscriptMock,
    appendTranscriptRecord: appendTranscriptRecordMock,
    updateObservedTask: updateObservedTaskMock,
    markObservedTaskAccountProxyRouted: jest.fn(),
  })),
}));

import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import { getEnhancedEnv } from '@canopy/desktop-shared/pipelines/config-paths';
import {
  clampThinkingLevelForModel,
  getExecutionHarnessForModel,
  initClaudeModels,
  initCodexModels,
} from '@canopy/desktop-shared/types';
import * as sharedCommitMessageGenerator from '@canopy/desktop-shared/lib/commit-message-generator';
import { readPreferencesFile } from '../lib/preferences-store';
import { generateCommitMessage } from '../lib/commit-message-generator';
import { runWithOptionalHelperPlugins } from '../lib/helper-plugin-resolution';
import {
  resolveHelperInvocation,
  type HelperInvocation,
} from '../ollama/helper-invocation';
import { isModelBlockedByStoredPolicy } from '../lib/model-policy-state';
import {
  clearAllProviderQuotaReached,
  isProviderQuotaReached,
} from '../agents/ai-credits-quota-state';

const mockedClaudeQuery = jest.mocked(claudeQuery);
const mockedGetEnhancedEnv = jest.mocked(getEnhancedEnv);
const mockedReadPreferencesFile = jest.mocked(readPreferencesFile);
const mockedRunWithOptionalHelperPlugins = jest.mocked(
  runWithOptionalHelperPlugins,
);
const mockedResolveHelperInvocation = jest.mocked(resolveHelperInvocation);
const mockedIsModelBlockedByStoredPolicy = jest.mocked(
  isModelBlockedByStoredPolicy,
);

/** Mirrors native (unrouted) helper resolution for registry models. */
function nativeInvocation(
  model: string | undefined,
): Promise<HelperInvocation> {
  const harness = model ? getExecutionHarnessForModel(model) : 'claude';
  const invocation: HelperInvocation = {
    providerType: harness === 'codex' ? 'codex' : 'claude',
    source: harness === 'codex' ? 'codex-managed' : 'claude-managed',
    harness: harness ?? 'claude',
    sdkModel: model,
    aiCreditsRouted: false,
  };
  return Promise.resolve(invocation);
}

const NO_USABLE_RESULT_DETAIL =
  'Commit message generation failed: the model returned no usable message.';
const ROUTED_GATEWAY_MODEL = 'anthropic/claude-sonnet-5.5';

initClaudeModels([
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-fallback-test', label: 'Claude fallback test' },
]);
// `gpt-5.5` is an alias of `gpt-6.1-sol`; register the target so it resolves.
initCodexModels([
  { id: 'gpt-5.5', label: 'GPT 5.5' },
  { id: 'gpt-6.1-sol', label: 'GPT 6.1 Sol' },
]);

async function* makeMessages(
  messages: unknown[],
): AsyncGenerator<unknown, void, void> {
  for (const message of messages) {
    await Promise.resolve();
    yield message;
  }
}

function mockClaudeQueryResultOnce(messages: unknown[]): void {
  // @ts-expect-error The async iterator is the only Claude SDK surface used here.
  mockedClaudeQuery.mockImplementationOnce(() => makeMessages(messages));
}

describe('generateCommitMessage', () => {
  it('cancels while helper preparation is waiting for proxy capacity', async () => {
    const controller = new AbortController();
    let entered: () => void = () => undefined;
    const preparing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release: () => void = () => undefined;
    let receivedSignal: AbortSignal | undefined;
    const resolver = jest.mocked(resolveHelperInvocation);
    resolver.mockImplementationOnce((_model, _state, routingOptions) => {
      receivedSignal = routingOptions?.signal;
      entered();
      return new Promise((_resolve, reject) => {
        release = (): void => reject(new Error('cancelled capacity wait'));
        receivedSignal?.addEventListener('abort', release, { once: true });
      });
    });
    let settled = false;
    const generation = generateCommitMessage({
      repoPath: '/repo',
      branchName: 'feat/test',
      diff: 'diff',
      model: 'gpt-5.5',
      abortController: controller,
    }).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await preparing;
      // The attempt runs on a linked signal that the caller's cancel aborts.
      expect(receivedSignal?.aborted).toBe(false);
      controller.abort();
      expect(receivedSignal?.aborted).toBe(true);
      await generation;
      expect(settled).toBe(true);
      expect(mockedRunWithOptionalHelperPlugins).not.toHaveBeenCalled();
    } finally {
      release();
      await generation;
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    clearAllProviderQuotaReached();
    mockedResolveHelperInvocation.mockImplementation(nativeInvocation);
    mockedIsModelBlockedByStoredPolicy.mockResolvedValue(false);
    mockedReadPreferencesFile.mockResolvedValue({
      canopyBackgroundProcessesMode: 'canopy',
    });
    mockedRunWithOptionalHelperPlugins.mockImplementation((_, run) =>
      run({
        claudePlugins: [],
        claudeMcpServers: {},
        codexProcessEnv: {},
        codexCapabilityRoots: [],
        codexMcpServers: {},
      }),
    );
  });

  it('passes the selected Claude thinking effort into claudeQuery', async () => {
    // @ts-expect-error Query exposes extra control methods that this unit test
    // does not exercise; the async iterator surface is sufficient here.
    mockedClaudeQuery.mockImplementation(() =>
      (async function* (): AsyncGenerator<Record<string, unknown>, void, void> {
        await Promise.resolve();
        yield {
          type: 'result',
          structured_output: { message: 'feat: add tests' },
        };
      })(),
    );

    const message = await generateCommitMessage({
      repoPath: '/repo',
      branchName: 'feat/test',
      diff: 'diff --git a/file b/file',
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'medium',
      instructions: '',
      instructionMode: 'append',
    });

    expect(message).toBe('feat: add tests');
    const callArgs = mockedClaudeQuery.mock.calls[0]?.[0] as {
      options?: {
        sandbox?: { ripgrep?: { command?: string } };
        thinking?: { type: string };
        effort?: string;
      };
    };
    expect(callArgs.options?.thinking).toEqual({
      type: 'adaptive',
      display: 'summarized',
    });
    expect(callArgs.options?.effort).toBe('medium');
    expect(callArgs.options?.sandbox?.ripgrep?.command).toBe('/fake/rg');
  });

  it('records worktree links and transcript records for audit entries', async () => {
    mockClaudeQueryResultOnce([
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: '{"message":"feat: add tests"}' }],
        },
      },
      {
        type: 'result',
        structured_output: { message: 'feat: add tests' },
      },
    ]);

    const message = await generateCommitMessage({
      repoPath: '/repo',
      branchName: 'feat/test',
      diff: 'diff --git a/file b/file',
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'medium',
      instructions: '',
      instructionMode: 'append',
      auditContext: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        repoId: 'repo-1',
        repoLabel: 'repo',
      },
    });

    expect(message).toBe('feat: add tests');
    expect(startObservedTaskMock).toHaveBeenCalledWith(
      expect.stringContaining('helper:commit-message:/repo:'),
      expect.objectContaining({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        repoId: 'repo-1',
        repoLabel: 'repo',
      }),
    );
    expect(startObservedTaskMock).toHaveBeenCalledWith(
      expect.stringContaining('helper:commit-message:/repo:'),
      expect.any(Object),
    );
    const firstStartCall: unknown = startObservedTaskMock.mock.calls[0];
    if (!Array.isArray(firstStartCall)) {
      throw new Error('Expected observed task to be started');
    }
    expect(firstStartCall[1]).toEqual(
      expect.objectContaining({
        linkTarget: {
          page: 'main',
          kind: 'worktree-chat',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
      }),
    );
    expect(seedTranscriptMock).toHaveBeenCalledWith(
      expect.stringContaining('helper:commit-message:/repo:'),
      expect.objectContaining({
        provider: 'claude',
        originalText: [
          'Branch: feat/test',
          '',
          '## Diff',
          'diff --git a/file b/file',
        ].join('\n'),
        submittedText: [
          'Branch: feat/test',
          '',
          '## Diff',
          'diff --git a/file b/file',
        ].join('\n'),
        planMode: false,
        injectedPrompts: [
          expect.objectContaining({
            applicationCondition: 'helper_task_system_prompt',
          }),
        ],
      }),
    );
    expect(appendTranscriptRecordMock).toHaveBeenCalledWith(
      expect.stringContaining('helper:commit-message:/repo:'),
      expect.objectContaining({ type: 'assistant' }),
    );
  });

  it('records terminal-mode transcript records for worker-backed audit entries', async () => {
    mockedReadPreferencesFile.mockResolvedValue({
      canopyBackgroundProcessesMode: 'terminal',
    });
    mockRunWorker.mockResolvedValueOnce({
      workerId: 'worker-1',
      sessionId: 'session-1',
      result: { message: 'feat: terminal helper' },
      finalText: 'feat: terminal helper',
      usage: {
        inputTokens: 12,
        outputTokens: 4,
        messageCount: 1,
        assistantMessageCount: 1,
      },
      transcript: [],
      transcriptJsonl: [
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'calling structured tool' }],
          },
        }),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: 'feat: terminal helper',
        }),
      ].join('\n'),
      status: 'success',
    });

    const message = await generateCommitMessage({
      repoPath: '/repo',
      branchName: 'feat/test',
      diff: 'diff --git a/file b/file',
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'medium',
      instructions: '',
      instructionMode: 'append',
      auditContext: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      },
    });

    expect(message).toBe('feat: terminal helper');
    expect(mockedClaudeQuery).not.toHaveBeenCalled();
    expect(mockRunWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'commit_message_generation',
        label: 'Commit Message',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      }),
    );
    expect(updateObservedTaskMock).toHaveBeenCalledWith(
      expect.stringContaining('helper:commit-message:/repo:'),
      { chatMode: 'terminal' },
    );
    expect(appendTranscriptRecordMock).toHaveBeenCalledWith(
      expect.stringContaining('helper:commit-message:/repo:'),
      expect.objectContaining({ type: 'assistant' }),
    );
    expect(appendTranscriptRecordMock).toHaveBeenCalledWith(
      expect.stringContaining('helper:commit-message:/repo:'),
      expect.objectContaining({ type: 'result' }),
    );
    expect(finalizeObservedTaskMock).toHaveBeenLastCalledWith(
      expect.stringContaining('helper:commit-message:/repo:'),
      'success',
      undefined,
      expect.objectContaining({
        inputTokens: 12,
        outputTokens: 4,
      }),
    );
  });

  it('accepts StructuredOutput tool input when the final result is sparse', async () => {
    mockClaudeQueryResultOnce([
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'StructuredOutput',
              input: { message: 'feat: recover structured output' },
            },
          ],
        },
      },
      {
        type: 'result',
        subtype: 'error_max_turns',
        is_error: false,
      },
    ]);

    const message = await generateCommitMessage({
      repoPath: '/repo',
      branchName: 'feat/test',
      diff: 'diff --git a/file b/file',
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'medium',
      instructions: '',
      instructionMode: 'append',
    });

    expect(message).toBe('feat: recover structured output');
    expect(finalizeObservedTaskMock).toHaveBeenLastCalledWith(
      expect.stringContaining('helper:commit-message:/repo:'),
      'success',
      undefined,
      expect.objectContaining({
        messageCount: 1,
        assistantMessageCount: 1,
      }),
    );
  });

  it('records fallback generation as a failed observability task', async () => {
    mockClaudeQueryResultOnce([
      {
        type: 'result',
        structured_output: { note: 'missing message' },
      },
    ]);
    mockClaudeQueryResultOnce([
      {
        type: 'result',
        result: '{"note":"still missing message"}',
      },
    ]);

    const message = await generateCommitMessage({
      repoPath: '/repo',
      branchName: 'fix/observability-status',
      diff: 'diff --git a/file b/file',
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'medium',
      instructions: '',
      instructionMode: 'append',
    });

    expect(message).toBe('Observability status');
    expect(finalizeObservedTaskMock).toHaveBeenLastCalledWith(
      expect.stringContaining('helper:commit-message:/repo:'),
      'failure',
      NO_USABLE_RESULT_DETAIL,
      expect.objectContaining({
        messageCount: 2,
        assistantMessageCount: 2,
      }),
    );
  });

  it('passes fallback usage to failed observability finalization', async () => {
    mockedRunWithOptionalHelperPlugins.mockResolvedValueOnce({
      message: 'Preserve usage',
      usage: { inputTokens: 14, outputTokens: 5, totalCostUsd: 0.22 },
      source: 'fallback',
    });

    const message = await generateCommitMessage({
      repoPath: '/repo',
      branchName: 'fix/preserve-usage',
      diff: 'diff --git a/file b/file',
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'medium',
      instructions: '',
      instructionMode: 'append',
    });

    expect(message).toBe('Preserve usage');
    expect(finalizeObservedTaskMock).toHaveBeenLastCalledWith(
      expect.stringContaining('helper:commit-message:/repo:'),
      'failure',
      NO_USABLE_RESULT_DETAIL,
      { inputTokens: 14, outputTokens: 5, totalCostUsd: 0.22 },
    );
  });

  it('resolves selections and passes Claude plugin runtime to the shared generator', async () => {
    mockedRunWithOptionalHelperPlugins.mockImplementationOnce((_, run) =>
      run({
        claudePlugins: [{ type: 'local', path: '/plugins/commit' }],
        claudeMcpServers: {
          helper: { type: 'stdio', command: 'helper-mcp' },
        },
        codexProcessEnv: {},
        codexCapabilityRoots: [],
        codexMcpServers: {},
      }),
    );
    mockClaudeQueryResultOnce([
      {
        type: 'result',
        structured_output: { message: 'feat: plugin commit' },
      },
    ]);

    const message = await generateCommitMessage({
      repoPath: '/repo',
      branchName: 'feat/test',
      diff: 'diff --git a/file b/file',
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'medium',
      instructions: '',
      instructionMode: 'append',
      pluginSelections: {
        collectionIds: ['bundle-a'],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      auditContext: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      },
    });

    expect(message).toBe('feat: plugin commit');
    expect(mockedRunWithOptionalHelperPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        helperName: 'commit-message',
      }),
      expect.any(Function),
    );
    expect(
      mockedRunWithOptionalHelperPlugins.mock.calls[0]?.[0].selections
        ?.collectionIds,
    ).toEqual(['bundle-a']);
    const queryOptions = mockedClaudeQuery.mock.calls[0]?.[0].options;
    expect(mockedGetEnhancedEnv).toHaveBeenCalledWith({
      environment: { runtime: 'agent', workspaceId: 'project-1' },
    });
    expect(queryOptions?.plugins).toEqual([
      { type: 'local', path: '/plugins/commit' },
    ]);
    expect(queryOptions?.mcpServers).toEqual({
      helper: { type: 'stdio', command: 'helper-mcp' },
    });
  });

  it('gives routed Codex MCP configuration precedence through the shared runtime', async () => {
    mockedRunWithOptionalHelperPlugins.mockImplementationOnce((_, run) =>
      run({
        claudePlugins: [],
        claudeMcpServers: {},
        codexProcessEnv: { CANOPY_TEST_PROFILE: 'commit-plugin' },
        codexCapabilityRoots: [],
        codexMcpServers: {
          helper: { command: 'helper-mcp', args: [] },
        },
      }),
    );
    mockCodexRunEphemeralTurn.mockResolvedValueOnce({
      status: 'completed',
      threadId: 'commit-helper-thread',
      finalText: '{"message":"feat: codex plugin"}',
      usage: { inputTokens: 3, outputTokens: 2 },
    });

    const message = await generateCommitMessage({
      repoPath: '/repo',
      branchName: 'feat/test',
      diff: 'diff --git a/file b/file',
      model: 'gpt-5.5',
      thinkingLevel: 'medium',
      modelConfig: { fastMode: true },
      codexConfigOverride: {
        mcp_servers: {
          helper: { command: 'routed-mcp', args: [] },
        },
      },
      instructions: '',
      instructionMode: 'append',
      pluginSelections: {
        collectionIds: ['bundle-a'],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      auditContext: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      },
    });

    expect(message).toBe('feat: codex plugin');
    const runtimeRequest = mockCodexRunEphemeralTurn.mock.calls[0]?.[0];
    expect(runtimeRequest?.profile.environment).toEqual(
      expect.objectContaining({
        WORKSPACE_AGENT_ENV: 'enabled',
      }),
    );
    expect(runtimeRequest?.profile.environment).not.toHaveProperty(
      'CANOPY_TEST_PROFILE',
    );
    expect(runtimeRequest?.params.config).toEqual({
      service_tier: 'priority',
      mcp_servers: {
        helper: { command: 'routed-mcp', args: [] },
      },
    });
    expect(runtimeRequest?.turn.outputSchema).toMatchObject({
      type: 'object',
      required: ['message'],
    });
    expect(runtimeRequest?.profile.logicalWorkspaceEnvironmentId).toBe(
      'agent:workspace-agent',
    );
    expect(runtimeRequest?.profile.secretVersionFingerprint).toBe(
      'workspace-secret-v1',
    );
    expect(mockResolveCodexRuntimeEnvironmentProfile).toHaveBeenCalledWith({
      runtime: 'agent',
      workspaceId: 'project-1',
    });
  });
});

describe('generateCommitMessage model fallback chain (CAN-3866)', () => {
  const baseOptions = {
    repoPath: '/repo',
    branchName: 'feat/model-fallback',
    diff: 'diff --git a/file b/file',
    model: 'claude-sonnet-4-6',
    instructions: '',
    instructionMode: 'append' as const,
  };
  const usageLimitMessages = [
    { type: 'assistant', error: 'rate_limit' },
    {
      type: 'result',
      is_error: true,
      api_error_status: 429,
      result: 'rate limit',
    },
  ];

  function mockCodexFallbackSuccess(): void {
    mockCodexRunEphemeralTurn.mockResolvedValueOnce({
      status: 'completed',
      threadId: 'commit-helper-thread',
      finalText: '{"message":"feat: codex fallback"}',
      usage: { inputTokens: 3, outputTokens: 2 },
    });
  }

  function taskKeysFinalizedWith(status: string): string[] {
    return finalizeObservedTaskMock.mock.calls
      .filter((call: unknown[]) => call[1] === status)
      .map((call: unknown[]) => String(call[0]));
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    clearAllProviderQuotaReached();
    mockedResolveHelperInvocation.mockImplementation(nativeInvocation);
    mockedIsModelBlockedByStoredPolicy.mockResolvedValue(false);
    mockedReadPreferencesFile.mockResolvedValue({
      canopyBackgroundProcessesMode: 'canopy',
    });
    mockedRunWithOptionalHelperPlugins.mockImplementation((_, run) =>
      run({
        claudePlugins: [],
        claudeMcpServers: {},
        codexProcessEnv: {},
        codexCapabilityRoots: [],
        codexMcpServers: {},
      }),
    );
  });

  it('runs a routed Claude gateway model instead of rejecting it as unknown', async () => {
    const routed: HelperInvocation = {
      providerType: 'claude',
      source: 'claude-managed',
      harness: 'claude',
      sdkModel: ROUTED_GATEWAY_MODEL,
      envOverride: { ANTHROPIC_BASE_URL: 'https://gateway.example.test' },
      aiCreditsRouted: true,
    };
    mockedResolveHelperInvocation.mockResolvedValue(routed);
    mockClaudeQueryResultOnce([
      {
        type: 'result',
        structured_output: { message: 'feat: routed commit' },
      },
    ]);

    await expect(generateCommitMessage(baseOptions)).resolves.toBe(
      'feat: routed commit',
    );
    expect(seedTranscriptMock).toHaveBeenCalledWith(
      expect.stringContaining('helper:commit-message:/repo:'),
      expect.objectContaining({ provider: 'claude' }),
    );
    expect(mockedClaudeQuery.mock.calls[0]?.[0].options?.model).toBe(
      ROUTED_GATEWAY_MODEL,
    );
  });

  it('advances to the next candidate after a native usage limit and marks the quota', async () => {
    mockClaudeQueryResultOnce(usageLimitMessages);
    mockCodexFallbackSuccess();

    await expect(
      generateCommitMessage({ ...baseOptions, fallbackModels: ['gpt-5.5'] }),
    ).resolves.toBe('feat: codex fallback');
    // With a fallback left, the exhausted lane gets no second try.
    expect(mockedClaudeQuery).toHaveBeenCalledTimes(1);

    const failed = taskKeysFinalizedWith('failure');
    const succeeded = taskKeysFinalizedWith('success');
    expect(failed).toHaveLength(1);
    expect(succeeded).toHaveLength(1);
    expect(failed[0]).not.toBe(succeeded[0]);
    expect(isProviderQuotaReached('claude')).toBe(true);
  });

  it('does not mark native quota for a usage limit on an account-proxy route', async () => {
    mockedResolveHelperInvocation.mockImplementation(async (model) =>
      model === 'claude-sonnet-4-6'
        ? { ...(await nativeInvocation(model)), accountProxyRouted: true }
        : nativeInvocation(model),
    );
    mockClaudeQueryResultOnce(usageLimitMessages);
    mockCodexFallbackSuccess();

    await expect(
      generateCommitMessage({ ...baseOptions, fallbackModels: ['gpt-5.5'] }),
    ).resolves.toBe('feat: codex fallback');
    expect(mockedClaudeQuery).toHaveBeenCalledTimes(1);
    expect(isProviderQuotaReached('claude')).toBe(false);
  });

  it('does not latch the native lane on a bare HTTP 429 without a quota signal', async () => {
    const throttled = (): never => {
      throw Object.assign(new Error('Too Many Requests'), { status: 429 });
    };
    mockedClaudeQuery.mockImplementationOnce(throttled);
    mockedClaudeQuery.mockImplementationOnce(throttled);
    mockCodexFallbackSuccess();

    await expect(
      generateCommitMessage({ ...baseOptions, fallbackModels: ['gpt-5.5'] }),
    ).resolves.toBe('feat: codex fallback');
    // A short throttle without a quota signal still gets its second try.
    expect(mockedClaudeQuery).toHaveBeenCalledTimes(2);
    expect(isProviderQuotaReached('claude')).toBe(false);
  });

  it('moves to the next model when a provider hangs past the attempt limit', async () => {
    jest.useFakeTimers();
    try {
      const hung = {
        [Symbol.asyncIterator]: (): { next: () => Promise<never> } => ({
          next: (): Promise<never> => new Promise<never>(() => undefined),
        }),
      };
      // @ts-expect-error The async iterator is the only Claude SDK surface used here.
      mockedClaudeQuery.mockImplementationOnce(() => hung);
      mockCodexFallbackSuccess();

      let settled: string | undefined;
      const generation = generateCommitMessage({
        ...baseOptions,
        fallbackModels: ['gpt-5.5'],
      }).then((message) => {
        settled = message;
        return message;
      });

      await jest.advanceTimersByTimeAsync(29_000);
      expect(settled).toBeUndefined();
      await jest.advanceTimersByTimeAsync(1_000);

      await expect(generation).resolves.toBe('feat: codex fallback');
      expect(finalizeObservedTaskMock).toHaveBeenCalledWith(
        expect.stringContaining('helper:commit-message:/repo:'),
        'failure',
        'Commit message generation timed out after 30 seconds.',
        undefined,
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not cut off a lone commit model at the attempt limit', async () => {
    jest.useFakeTimers();
    try {
      mockedResolveHelperInvocation.mockImplementationOnce(
        (model) =>
          new Promise((resolve) => {
            setTimeout(() => resolve(nativeInvocation(model)), 45_000);
          }),
      );
      mockClaudeQueryResultOnce([
        {
          type: 'result',
          structured_output: { message: 'feat: slow but fine' },
        },
      ]);

      const generation = generateCommitMessage(baseOptions);
      await jest.advanceTimersByTimeAsync(45_000);

      await expect(generation).resolves.toBe('feat: slow but fine');
    } finally {
      jest.useRealTimers();
    }
  });

  it('advances past a Codex usage limit without a second try', async () => {
    mockCodexRunEphemeralTurn.mockImplementationOnce(({ turn }) => {
      turn.onEvent?.({ type: 'rate_limit.reached' });
      return Promise.resolve({
        status: 'failed',
        error: 'Codex rate limit reached',
        usage: {},
      });
    });
    mockClaudeQueryResultOnce([
      {
        type: 'result',
        structured_output: { message: 'feat: claude fallback' },
      },
    ]);

    await expect(
      generateCommitMessage({
        ...baseOptions,
        model: 'gpt-5.5',
        fallbackModels: ['claude-sonnet-4-6'],
      }),
    ).resolves.toBe('feat: claude fallback');
    expect(mockCodexRunEphemeralTurn).toHaveBeenCalledTimes(1);
    expect(isProviderQuotaReached('codex')).toBe(true);
  });

  it('does not latch or skip the retry for an error that merely mentions a limit', async () => {
    const overLimit = (): never => {
      throw new Error('Prompt exceeds the context window limit');
    };
    mockedClaudeQuery.mockImplementationOnce(overLimit);
    mockedClaudeQuery.mockImplementationOnce(overLimit);
    mockCodexFallbackSuccess();

    await expect(
      generateCommitMessage({ ...baseOptions, fallbackModels: ['gpt-5.5'] }),
    ).resolves.toBe('feat: codex fallback');
    expect(mockedClaudeQuery).toHaveBeenCalledTimes(2);
    expect(isProviderQuotaReached('claude')).toBe(false);
  });

  it('defers a same-lane candidate behind other lanes after a native usage limit', async () => {
    mockClaudeQueryResultOnce(usageLimitMessages);
    mockCodexFallbackSuccess();

    await expect(
      generateCommitMessage({
        ...baseOptions,
        fallbackModels: ['claude-fallback-test', 'gpt-5.5'],
      }),
    ).resolves.toBe('feat: codex fallback');

    expect(
      mockedResolveHelperInvocation.mock.calls.map((call) => call[0]),
    ).toEqual(['claude-sonnet-4-6', 'gpt-5.5']);
    expect(mockedClaudeQuery).toHaveBeenCalledTimes(1);
  });

  it('does not mark native quota for a usage limit hit through AI Credits', async () => {
    mockedResolveHelperInvocation.mockImplementation((model) =>
      model === 'claude-sonnet-4-6'
        ? Promise.resolve({
            providerType: 'claude',
            source: 'claude-managed',
            harness: 'claude',
            sdkModel: ROUTED_GATEWAY_MODEL,
            aiCreditsRouted: true,
          })
        : nativeInvocation(model),
    );
    mockClaudeQueryResultOnce(usageLimitMessages);
    mockCodexFallbackSuccess();

    await expect(
      generateCommitMessage({ ...baseOptions, fallbackModels: ['gpt-5.5'] }),
    ).resolves.toBe('feat: codex fallback');
    expect(isProviderQuotaReached('claude')).toBe(false);
  });

  it('advances when the model returns nothing usable, without marking quota', async () => {
    mockClaudeQueryResultOnce([
      { type: 'result', structured_output: { note: 'missing message' } },
    ]);
    mockClaudeQueryResultOnce([
      { type: 'result', structured_output: { note: 'still missing' } },
    ]);
    mockCodexFallbackSuccess();

    await expect(
      generateCommitMessage({ ...baseOptions, fallbackModels: ['gpt-5.5'] }),
    ).resolves.toBe('feat: codex fallback');
    expect(finalizeObservedTaskMock).toHaveBeenCalledWith(
      expect.stringContaining('helper:commit-message:/repo:'),
      'failure',
      NO_USABLE_RESULT_DETAIL,
      expect.anything(),
    );
    expect(isProviderQuotaReached('claude')).toBe(false);
  });

  it('advances past a pre-generation throw and records its detail', async () => {
    mockedResolveHelperInvocation.mockImplementation((model) =>
      model === 'claude-sonnet-4-6'
        ? Promise.reject(
            new Error(`Unknown model provider: ${ROUTED_GATEWAY_MODEL}`),
          )
        : nativeInvocation(model),
    );
    mockCodexFallbackSuccess();

    await expect(
      generateCommitMessage({ ...baseOptions, fallbackModels: ['gpt-5.5'] }),
    ).resolves.toBe('feat: codex fallback');
    expect(finalizeObservedTaskMock).toHaveBeenCalledWith(
      expect.stringContaining('helper:commit-message:/repo:'),
      'failure',
      `Unknown model provider: ${ROUTED_GATEWAY_MODEL}`,
      undefined,
    );
  });

  it('refuses a policy-blocked primary and uses the next candidate', async () => {
    mockedIsModelBlockedByStoredPolicy.mockImplementation((model) =>
      Promise.resolve(model === 'claude-sonnet-4-6'),
    );
    mockCodexFallbackSuccess();

    await expect(
      generateCommitMessage({ ...baseOptions, fallbackModels: ['gpt-5.5'] }),
    ).resolves.toBe('feat: codex fallback');
    expect(finalizeObservedTaskMock).toHaveBeenCalledWith(
      expect.stringContaining('helper:commit-message:/repo:'),
      'failure',
      'Commit message generation was skipped: this model is blocked by your organization policy.',
      undefined,
    );
    expect(mockedResolveHelperInvocation).toHaveBeenCalledTimes(1);
    expect(mockedResolveHelperInvocation).toHaveBeenCalledWith(
      'gpt-5.5',
      undefined,
      expect.any(Object),
    );
  });

  it('advances past a failed policy read instead of rejecting', async () => {
    mockedIsModelBlockedByStoredPolicy.mockRejectedValueOnce(
      new Error('policy read failed'),
    );
    mockCodexFallbackSuccess();

    await expect(
      generateCommitMessage({ ...baseOptions, fallbackModels: ['gpt-5.5'] }),
    ).resolves.toBe('feat: codex fallback');
    expect(finalizeObservedTaskMock).toHaveBeenCalledWith(
      expect.stringContaining('helper:commit-message:/repo:'),
      'failure',
      'policy read failed',
      undefined,
    );
    expect(taskKeysFinalizedWith('success')).toHaveLength(1);
  });

  it('returns the branch title, never rejecting, when every candidate fails', async () => {
    mockedResolveHelperInvocation.mockRejectedValue(new Error('no route'));

    await expect(
      generateCommitMessage({ ...baseOptions, fallbackModels: ['gpt-5.5'] }),
    ).resolves.toBe('Model fallback');
    expect(taskKeysFinalizedWith('failure')).toHaveLength(2);
  });

  it('returns the branch title for an unknown primary with no fallbacks', async () => {
    await expect(
      generateCommitMessage({ ...baseOptions, model: 'claude-removed-model' }),
    ).resolves.toBe('Model fallback');
    expect(mockedResolveHelperInvocation).not.toHaveBeenCalled();
  });

  it('rethrows cancellation from the first candidate without trying the next', async () => {
    const abortController = new AbortController();
    const cancellation = new Error('cancelled');
    mockedResolveHelperInvocation.mockImplementation(() => {
      abortController.abort(cancellation);
      return Promise.reject(cancellation);
    });

    await expect(
      generateCommitMessage({
        ...baseOptions,
        fallbackModels: ['gpt-5.5'],
        abortController,
      }),
    ).rejects.toBe(cancellation);
    expect(mockedResolveHelperInvocation).toHaveBeenCalledTimes(1);
    expect(mockCodexRunEphemeralTurn).not.toHaveBeenCalled();
  });

  it('rejects when cancelled during the final candidate instead of returning the title', async () => {
    const abortController = new AbortController();
    const cancellation = new Error('cancelled');
    mockClaudeQueryResultOnce([
      { type: 'result', structured_output: { note: 'missing message' } },
    ]);
    mockClaudeQueryResultOnce([
      { type: 'result', structured_output: { note: 'still missing' } },
    ]);
    finalizeObservedTaskMock.mockImplementationOnce(() => {
      abortController.abort(cancellation);
    });

    await expect(
      generateCommitMessage({ ...baseOptions, abortController }),
    ).rejects.toBe(cancellation);
  });

  it('does not start another candidate after cancellation between candidates', async () => {
    const abortController = new AbortController();
    const cancellation = new Error('cancelled');
    mockClaudeQueryResultOnce([
      { type: 'result', structured_output: { note: 'missing message' } },
    ]);
    mockClaudeQueryResultOnce([
      { type: 'result', structured_output: { note: 'still missing' } },
    ]);
    finalizeObservedTaskMock.mockImplementationOnce(() => {
      abortController.abort(cancellation);
    });

    await expect(
      generateCommitMessage({
        ...baseOptions,
        fallbackModels: ['gpt-5.5'],
        abortController,
      }),
    ).rejects.toBe(cancellation);
    expect(mockedResolveHelperInvocation).toHaveBeenCalledTimes(1);
    expect(mockCodexRunEphemeralTurn).not.toHaveBeenCalled();
  });

  it('does not wait for account-proxy quota recovery while fallbacks remain', async () => {
    const sharedSpy = jest.spyOn(
      sharedCommitMessageGenerator,
      'generateCommitMessageWithUsage',
    );
    const waitForQuotaRecovery: HelperInvocation['waitForQuotaRecovery'] =
      jest.fn(() => Promise.resolve());
    mockedResolveHelperInvocation.mockImplementation(async (model) => ({
      ...(await nativeInvocation(model)),
      waitForQuotaRecovery,
    }));
    mockClaudeQueryResultOnce([
      { type: 'result', structured_output: { message: 'feat: primary' } },
    ]);
    await expect(
      generateCommitMessage({ ...baseOptions, fallbackModels: ['gpt-5.5'] }),
    ).resolves.toBe('feat: primary');
    expect(sharedSpy.mock.calls[0]?.[0].waitForQuotaRecovery).toBeUndefined();

    mockClaudeQueryResultOnce([
      { type: 'result', structured_output: { message: 'feat: only' } },
    ]);
    await expect(generateCommitMessage(baseOptions)).resolves.toBe(
      'feat: only',
    );
    expect(sharedSpy.mock.calls[1]?.[0].waitForQuotaRecovery).toBe(
      waitForQuotaRecovery,
    );
  });

  it('clamps the thinking level for each candidate model', async () => {
    const sharedSpy = jest.spyOn(
      sharedCommitMessageGenerator,
      'generateCommitMessageWithUsage',
    );
    mockedResolveHelperInvocation.mockImplementation((model) =>
      model === 'claude-sonnet-4-6'
        ? Promise.reject(new Error('no route'))
        : nativeInvocation(model),
    );
    mockedResolveHelperInvocation.mockImplementationOnce(nativeInvocation);
    mockClaudeQueryResultOnce([
      { type: 'result', structured_output: { note: 'missing message' } },
    ]);
    mockClaudeQueryResultOnce([
      { type: 'result', structured_output: { note: 'still missing' } },
    ]);
    mockCodexFallbackSuccess();

    await expect(
      generateCommitMessage({
        ...baseOptions,
        thinkingLevel: 'ultra',
        fallbackModels: ['gpt-5.5'],
      }),
    ).resolves.toBe('feat: codex fallback');
    expect(sharedSpy).toHaveBeenCalledTimes(2);
    expect(sharedSpy.mock.calls[0]?.[0].thinkingLevel).toBe(
      clampThinkingLevelForModel('ultra', 'claude-sonnet-4-6'),
    );
    expect(sharedSpy.mock.calls[1]?.[0].thinkingLevel).toBe(
      clampThinkingLevelForModel('ultra', 'gpt-5.5'),
    );
  });
});
