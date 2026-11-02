jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
}));

const mockSpawnClaudeCodeProcessOffMain = jest.fn();
jest.mock('../agents/claude-process-host-runner', () => ({
  get spawnClaudeCodeProcessOffMain(): typeof mockSpawnClaudeCodeProcessOffMain {
    return mockSpawnClaudeCodeProcessOffMain;
  },
}));

jest.mock('../pipelines/config-paths', () => ({
  getBundledClaudeBinaryPath: jest.fn(() => '/fake/claude'),
  getBundledRgBinaryPath: jest.fn(() => '/fake/rg'),
  getEnhancedEnv: jest.fn(() => ({ PATH: '/usr/bin' })),
}));

jest.mock('@canopy/desktop-shared/pipelines/config-paths', () => ({
  getEnhancedEnv: jest.fn(() => ({ PATH: '/usr/bin' })),
}));

jest.mock('@canopy/desktop-shared/lib/codex-model-config', () => ({
  codexServiceTierForModelConfig: jest.fn((config?: { fastMode?: boolean }) =>
    config?.fastMode === true ? 'priority' : 'default',
  ),
  mapThinkingToReasoningEffort: jest.fn((level: string) => level),
  toSdkThreadOptions: jest.fn((options: unknown) => options),
}));

interface WorktreeCodexRequestForTest {
  model?: string;
  repoPath?: string;
  thinkingLevel?: string;
  workspaceId?: string;
  modelConfig?: { fastMode?: boolean };
  pluginRuntime?: {
    codexProcessEnv?: Record<string, string>;
    codexMcpServers?: Record<string, unknown>;
  };
}

const mockCodexStructuredRun = jest.fn<
  Promise<unknown>,
  [WorktreeCodexRequestForTest]
>();

jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    seedTranscript: jest.fn(),
    appendTranscriptRecord: jest.fn(),
  })),
}));

jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(() =>
    Promise.resolve({ canopyBackgroundProcessesMode: 'canopy' }),
  ),
  // Local memory is opt-in (CAN-1969); default off in tests.
  readLocalMemoryEnabledPreference: jest.fn(() => Promise.resolve(false)),
}));

jest.mock('../integration/structured-helper-dispatch', () => ({
  codexStructuredHelperRunner: {
    get run(): typeof mockCodexStructuredRun {
      return mockCodexStructuredRun;
    },
  },
  runStructuredHelper: jest.fn(),
  structuredHelperReadOnlyPermission: jest.fn(() => ({
    approvalPolicy: 'never',
    sandboxMode: 'read-only',
    tools: [],
  })),
}));
// Worktree summaries are unattended (scheduler-driven), so both provider
// branches must opt out of `no-native-auth` AI Credits routing. Mocked so the
// opt-out can be asserted where it actually has to hold — ECW-9091 review round
// 6 found the Codex branch opted out while the Claude branch, which the default
// `worktreeSummaryModel` selects, still routed.
const mockResolveHelperInvocation = jest.fn<
  Promise<Record<string, unknown>>,
  unknown[]
>();
jest.mock('../ollama/helper-invocation', () => ({
  resolveHelperInvocation: (
    ...args: unknown[]
  ): Promise<Record<string, unknown>> => mockResolveHelperInvocation(...args),
}));
const mockResolveInvocationWorkOwner = jest.fn();
jest.mock('../agents/work-owner', () => ({
  resolveInvocationWorkOwner: (...args: unknown[]): unknown =>
    mockResolveInvocationWorkOwner(...args),
}));
import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { runStructuredHelper } from '../integration/structured-helper-dispatch';
import {
  DEFAULT_PREFERENCES,
  readPreferencesFile,
} from '../lib/preferences-store';
import {
  initClaudeModels,
  initCodexModels,
  initModelAliases,
  type WorktreeSummaryData,
} from '@canopy/desktop-shared/types';
import { TransientAgentRetryExhaustedError } from '@canopy/desktop-shared/agent-failures';
import {
  generateWorktreeSummary,
  isWorktreeSummaryData,
} from '../lib/worktree-summary-generator';

initClaudeModels([{ id: 'sonnet', label: 'Sonnet' }]);
initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);
initModelAliases({ 'claude-sonnet-4-6': 'sonnet' });

const mockedClaudeQuery = jest.mocked(claudeQuery);
const mockedRunStructuredHelper = jest.mocked(runStructuredHelper);
const mockedReadPreferencesFile = jest.mocked(readPreferencesFile);

function makePreviousSummary(): WorktreeSummaryData {
  return {
    title: 'Previous title',
    description: 'Previous description',
    highlights: ['First highlight', 'Second highlight'],
    repos: [{ name: 'web', description: 'Repo summary' }],
    generatedAt: '2026-03-24T10:00:00.000Z',
    turnCountAtGeneration: 4,
    lastFullRefreshAt: '2026-03-24T09:00:00.000Z',
    lastFullRefreshTurnCount: 3,
  };
}

function makeQueryEvents(events: Record<string, unknown>[]): Query {
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

  const iterator = generate();
  return {
    [Symbol.asyncIterator]: () => iterator,
    interrupt: jest.fn().mockResolvedValue(undefined),
    setPermissionMode: jest.fn().mockResolvedValue(undefined),
    setModel: jest.fn().mockResolvedValue(undefined),
    applyFlagSettings: jest.fn().mockResolvedValue(undefined),
    initializationResult: jest.fn(),
    supportedCommands: jest.fn(),
    supportedModels: jest.fn(),
    supportedAgents: jest.fn(),
    mcpServerStatus: jest.fn(),
    accountInfo: jest.fn(),
    rewindFiles: jest.fn(),
    reconnectMcpServer: jest.fn(),
    toggleMcpServer: jest.fn(),
  } as unknown as Query;
}

function makeQuery(payload: Record<string, unknown>): Query {
  return makeQueryEvents([
    {
      type: 'result',
      structured_output: payload,
    },
  ]);
}

describe('generateWorktreeSummary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveInvocationWorkOwner.mockResolvedValue({
      kind: 'organization',
      organizationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    });
    mockResolveHelperInvocation.mockResolvedValue({
      providerType: 'claude',
      source: 'claude-managed',
      harness: 'claude',
      aiCreditsRouted: false,
    });
  });

  // ECW-9091 review round 6. The generator dispatches on the model's provider,
  // and the DEFAULT `worktreeSummaryModel` is a Claude one — so opting only the
  // Codex branch out of `no-native-auth` routing left the stock configuration
  // still able to silently debit a guest's daily credit allowance from a
  // background scheduler run. Assert the opt-out on both branches here, at the
  // level where it actually has to hold; the resolver-level tests cannot see a
  describe('unattended AI Credits opt-out', () => {
    it('opts the Claude branch out of no-native-auth routing', async () => {
      mockedClaudeQuery.mockReturnValue(
        makeQuery({
          title: 'T',
          description: 'D',
          highlights: ['H'],
        }),
      );

      await generateWorktreeSummary({
        cwd: '/repo',
        model: 'claude-sonnet-4-6',
        thinkingLevel: 'off',
        isFullRefresh: true,
        previousSummary: null,
        chatExcerpts: 'User: hi',
        gitDiff: 'diff --git a/f b/f',
        currentTurnCount: 1,
        isMultiRepo: false,
      });

      expect(mockResolveHelperInvocation).toHaveBeenCalledWith(
        'claude-sonnet-4-6',
        undefined,
        {
          allowNoNativeAuthFallback: false,
          workOwner: {
            kind: 'organization',
            organizationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          },
        },
      );
    });

    // ECW-9091 review round 7: the generator is NOT scheduler-only. The Refresh
    // button in SummarySection reaches it via `triggerManualRefresh`, and
    // denying that request would spawn natively with no login and silently
    // produce nothing.
    it('allows routing when the user explicitly asked for the summary', async () => {
      mockedClaudeQuery.mockReturnValue(
        makeQuery({ title: 'T', description: 'D', highlights: ['H'] }),
      );

      await generateWorktreeSummary({
        cwd: '/repo',
        model: 'claude-sonnet-4-6',
        thinkingLevel: 'off',
        isFullRefresh: true,
        userInitiated: true,
        previousSummary: null,
        chatExcerpts: 'User: hi',
        gitDiff: 'diff --git a/f b/f',
        currentTurnCount: 1,
        isMultiRepo: false,
      });

      expect(mockResolveHelperInvocation).toHaveBeenCalledWith(
        'claude-sonnet-4-6',
        undefined,
        {
          allowNoNativeAuthFallback: true,
          workOwner: {
            kind: 'organization',
            organizationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          },
        },
      );
    });

    // The guard must resolve the SAME environment the spawn uses. A workspace
    // assignment replaces the global one, so omitting the workspace would miss a
    // per-workspace ANTHROPIC_API_KEY and bill credits around it.
    it('forwards the project so the credential guard matches the spawn', async () => {
      mockedClaudeQuery.mockReturnValue(
        makeQuery({ title: 'T', description: 'D', highlights: ['H'] }),
      );

      await generateWorktreeSummary({
        projectId: 'ws-1',
        cwd: '/repo',
        model: 'claude-sonnet-4-6',
        thinkingLevel: 'off',
        isFullRefresh: true,
        previousSummary: null,
        chatExcerpts: 'User: hi',
        gitDiff: 'diff --git a/f b/f',
        currentTurnCount: 1,
        isMultiRepo: false,
      });

      expect(mockResolveHelperInvocation).toHaveBeenCalledWith(
        'claude-sonnet-4-6',
        undefined,
        {
          allowNoNativeAuthFallback: false,
          workspaceId: 'ws-1',
          workOwner: {
            kind: 'organization',
            organizationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          },
        },
      );
    });

    it('opts the Codex branch out of no-native-auth routing', async () => {
      mockResolveHelperInvocation.mockResolvedValue({
        providerType: 'codex',
        source: 'codex-managed',
        harness: 'codex',
        sdkModel: 'gpt-6-sol',
        aiCreditsRouted: false,
      });
      mockCodexStructuredRun.mockResolvedValue({
        text: JSON.stringify({
          title: 'T',
          description: 'D',
          highlights: ['H'],
        }),
        usage: {},
      });

      await generateWorktreeSummary({
        cwd: '/repo',
        model: 'gpt-5.5',
        thinkingLevel: 'off',
        isFullRefresh: true,
        previousSummary: null,
        chatExcerpts: 'User: hi',
        gitDiff: 'diff --git a/f b/f',
        currentTurnCount: 1,
        isMultiRepo: false,
      });

      expect(mockResolveHelperInvocation).toHaveBeenCalledWith(
        'gpt-5.5',
        undefined,
        {
          allowNoNativeAuthFallback: false,
          workOwner: {
            kind: 'organization',
            organizationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          },
        },
      );
    });
  });

  it('produces valid structured output from Claude results', async () => {
    delete process.env.CANOPY_HARNESS_NATIVE_MEMORY;
    mockedClaudeQuery.mockReturnValue(
      makeQuery({
        title: 'Add auth flow',
        description: 'Implements OAuth login and wires settings updates.',
        highlights: ['OAuth screens added', 'Settings state synced'],
      }),
    );

    const result = await generateWorktreeSummary({
      cwd: '/repo',
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'off',
      isFullRefresh: true,
      previousSummary: null,
      chatExcerpts: 'User: add auth',
      gitDiff: 'diff --git a/file b/file',
      currentTurnCount: 5,
      isMultiRepo: false,
    });

    expect(result.summary).not.toBeNull();
    expect(result.summary?.title).toBe('Add auth flow');
    expect(result.summary?.turnCountAtGeneration).toBe(5);
    expect(result.summary?.lastFullRefreshTurnCount).toBe(5);
    expect(mockedClaudeQuery.mock.calls[0]?.[0]?.options?.thinking).toEqual({
      type: 'disabled',
    });
    expect(
      mockedClaudeQuery.mock.calls[0]?.[0]?.options?.spawnClaudeCodeProcess,
    ).toBe(mockSpawnClaudeCodeProcessOffMain);
    // Local memory is opt-in and off by default, so summary generation sends
    // no native-memory suppression settings (CAN-1969).
    expect(
      mockedClaudeQuery.mock.calls[0]?.[0]?.options?.settings,
    ).toBeUndefined();
  });

  it('runs the SDK summary helper with read-only tools instead of plan mode', async () => {
    mockedClaudeQuery.mockReturnValue(
      makeQuery({
        title: 'Add auth flow',
        description: 'Implements OAuth login and wires settings updates.',
        highlights: ['OAuth screens added'],
      }),
    );

    await generateWorktreeSummary({
      cwd: '/repo',
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'off',
      isFullRefresh: true,
      previousSummary: null,
      chatExcerpts: 'User: add auth',
      gitDiff: 'diff --git a/file b/file',
      currentTurnCount: 5,
      isMultiRepo: false,
    });

    // Only the read-only built-ins exist, so the helper cannot write, edit,
    // exit plan mode or launch agents.
    const readOnly = ['Read', 'Glob', 'Grep', 'NotebookRead'];
    const queryOptions = mockedClaudeQuery.mock.calls[0]?.[0]?.options;
    expect(queryOptions?.permissionMode).toBeUndefined();
    expect(queryOptions?.tools).toEqual(readOnly);
    expect(queryOptions?.allowedTools).toEqual(readOnly);
  });

  it('suppresses native memory on summary generation while local memory is enabled', async () => {
    mockedReadPreferencesFile.mockResolvedValueOnce({
      ...DEFAULT_PREFERENCES,
      canopyBackgroundProcessesMode: 'canopy',
      localMemoryEnabled: true,
    });
    mockedClaudeQuery.mockReturnValue(
      makeQuery({
        title: 'Add auth flow',
        description: 'Adds authentication flow',
        highlights: ['Adds login form'],
        repos: [],
      }),
    );

    const result = await generateWorktreeSummary({
      cwd: '/repo',
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'off',
      isFullRefresh: true,
      previousSummary: null,
      chatExcerpts: 'User: add auth',
      gitDiff: 'diff --git a/file b/file',
      currentTurnCount: 5,
      isMultiRepo: false,
    });

    expect(result.summary).not.toBeNull();
    expect(mockedClaudeQuery.mock.calls[0]?.[0]?.options?.settings).toEqual({
      autoMemoryEnabled: false,
    });
  });

  it('passes Claude plugin skills but not MCP servers into summary generation', async () => {
    mockedClaudeQuery.mockReturnValue(
      makeQuery({
        title: 'Plugin summary',
        description: 'Uses selected helper plugins.',
        highlights: ['Plugin runtime applied'],
      }),
    );

    const pluginRuntimeInput: NonNullable<
      Parameters<typeof generateWorktreeSummary>[0]['pluginRuntime']
    > = {
      claudePlugins: [{ type: 'local', path: '/plugins/summary' }],
      claudeMcpServers: {
        helper: { type: 'stdio', command: 'helper-mcp' },
      },
      codexCapabilityRoots: [],
      codexMcpServers: {},
    };
    // Keep the legacy runtime field that this sanitizer test feeds to the helper.
    Reflect.set(pluginRuntimeInput, 'codexProcessEnv', {});

    await generateWorktreeSummary({
      cwd: '/repo',
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'off',
      isFullRefresh: true,
      previousSummary: null,
      chatExcerpts: 'User: summarize',
      gitDiff: 'diff --git a/file b/file',
      currentTurnCount: 5,
      isMultiRepo: false,
      pluginRuntime: pluginRuntimeInput,
    });

    const queryOptions = mockedClaudeQuery.mock.calls[0]?.[0]?.options;
    expect(queryOptions?.plugins).toEqual([
      {
        type: 'local',
        path: '/plugins/summary',
        skipMcpDiscovery: true,
      },
    ]);
    expect(queryOptions?.mcpServers).toBeUndefined();
    expect(queryOptions?.strictMcpConfig).toBe(true);
  });

  it('clears plugin MCP servers for terminal-mode summary helpers', async () => {
    mockedReadPreferencesFile.mockResolvedValueOnce({
      ...DEFAULT_PREFERENCES,
      canopyBackgroundProcessesMode: 'terminal',
    });
    mockedRunStructuredHelper.mockResolvedValueOnce({
      value: {
        title: 'Terminal summary',
        description: 'Generated without plugin MCP access.',
        highlights: ['MCP servers excluded'],
      },
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const pluginRuntimeInput: NonNullable<
      Parameters<typeof generateWorktreeSummary>[0]['pluginRuntime']
    > = {
      claudePlugins: [],
      claudeMcpServers: {
        claudeHelper: { type: 'stdio', command: 'claude-helper-mcp' },
      },
      codexCapabilityRoots: [],
      codexMcpServers: {
        codexHelper: { command: 'codex-helper-mcp' },
      },
    };
    // Preserve the old input's missing capability roots and legacy secret fields.
    Reflect.deleteProperty(pluginRuntimeInput, 'codexCapabilityRoots');
    Reflect.set(pluginRuntimeInput, 'codexProcessEnv', {
      CANOPY_TEST_PROFILE: 'summary-plugin',
      PLUGIN_MCP_TOKEN: 'secret',
    });
    Reflect.set(pluginRuntimeInput, 'codexMcpEnvKeys', ['PLUGIN_MCP_TOKEN']);

    await generateWorktreeSummary({
      cwd: '/repo',
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'off',
      isFullRefresh: true,
      previousSummary: null,
      chatExcerpts: 'User: summarize',
      gitDiff: 'diff --git a/file b/file',
      currentTurnCount: 5,
      isMultiRepo: false,
      pluginRuntime: pluginRuntimeInput,
    });

    expect(mockedRunStructuredHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginRuntime: {
          claudePlugins: [],
          claudeMcpServers: {},
          codexMcpServers: {},
        },
      }),
    );
  });

  it('retries after a first failure and succeeds on the second attempt', async () => {
    mockedClaudeQuery
      .mockImplementationOnce(() => {
        throw new Error('temporary failure');
      })
      .mockReturnValueOnce(
        makeQuery({
          title: 'Second attempt worked',
          description: 'Retry succeeded.',
          highlights: ['Recovered after failure'],
        }),
      );

    const result = await generateWorktreeSummary({
      cwd: '/repo',
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'medium',
      isFullRefresh: true,
      previousSummary: null,
      chatExcerpts: 'chat',
      gitDiff: 'diff',
      currentTurnCount: 2,
      isMultiRepo: false,
    });

    expect(mockedClaudeQuery).toHaveBeenCalledTimes(2);
    expect(mockResolveInvocationWorkOwner).toHaveBeenCalledTimes(1);
    expect(mockResolveHelperInvocation).toHaveBeenCalledTimes(2);
    for (const call of mockResolveHelperInvocation.mock.calls) {
      expect(call[2]).toEqual(
        expect.objectContaining({
          workOwner: {
            kind: 'organization',
            organizationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          },
        }),
      );
    }
    expect(result.summary?.title).toBe('Second attempt worked');
  });

  it('uses the chat backoff for a classified transient summary failure', async () => {
    jest.useFakeTimers();
    try {
      mockedClaudeQuery
        .mockReturnValueOnce(
          makeQueryEvents([
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
                input_tokens: 6,
                output_tokens: 2,
              },
              total_cost_usd: 0.08,
            },
          ]),
        )
        .mockReturnValueOnce(
          makeQuery({
            title: 'Recovered worktree summary',
            description: 'Retry succeeded.',
            highlights: ['Recovered after overload'],
          }),
        );

      const resultPromise = generateWorktreeSummary({
        cwd: '/repo',
        model: 'claude-sonnet-4-6',
        thinkingLevel: 'medium',
        isFullRefresh: true,
        previousSummary: null,
        chatExcerpts: 'chat',
        gitDiff: 'diff',
        currentTurnCount: 2,
        isMultiRepo: false,
      });

      await jest.advanceTimersByTimeAsync(29_999);
      expect(mockedClaudeQuery).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);

      const result = await resultPromise;
      expect(mockedClaudeQuery).toHaveBeenCalledTimes(2);
      const retryQueryArgs = mockedClaudeQuery.mock.calls[1]?.[0];
      expect(retryQueryArgs?.prompt).toContain('Current user turn count: 2');
      expect(retryQueryArgs?.options).not.toHaveProperty('resume');
      expect(result.summary?.title).toBe('Recovered worktree summary');
      expect(result.usage).toMatchObject({
        inputTokens: 6,
        outputTokens: 2,
        totalCostUsd: 0.08,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('preserves exhausted retry usage in a null summary result', async () => {
    mockCodexStructuredRun.mockRejectedValueOnce(
      new TransientAgentRetryExhaustedError(
        new Error('Codex helper failed'),
        {
          kind: 'provider_temporarily_unavailable',
          code: 'server_overloaded',
          provider: 'codex',
          account_scope: 'native',
          diagnostic_message: 'Codex helper failed',
        },
        { inputTokens: 17, outputTokens: 6, totalCostUsd: 0.31 },
      ),
    );

    const result = await generateWorktreeSummary({
      cwd: '/repo',
      model: 'gpt-5.5',
      thinkingLevel: 'medium',
      isFullRefresh: true,
      previousSummary: null,
      chatExcerpts: 'chat',
      gitDiff: 'diff',
      currentTurnCount: 2,
      isMultiRepo: false,
    });

    expect(result).toEqual({
      summary: null,
      usage: { inputTokens: 17, outputTokens: 6, totalCostUsd: 0.31 },
    });
  });

  it('accumulates mixed-failure usage into a later summary result', async () => {
    mockCodexStructuredRun
      .mockRejectedValueOnce(
        Object.assign(new Error('Invalid request after retry'), {
          usage: {
            inputTokens: 9,
            outputTokens: 4,
            totalCostUsd: 0.09,
          },
        }),
      )
      .mockResolvedValueOnce({
        value: {
          title: 'Recovered summary',
          description: 'The second outer attempt succeeded.',
          highlights: ['Preserved prior usage'],
        },
        usage: {
          inputTokens: 7,
          outputTokens: 3,
          totalCostUsd: 0.07,
        },
      });

    const result = await generateWorktreeSummary({
      cwd: '/repo',
      model: 'gpt-5.5',
      thinkingLevel: 'medium',
      isFullRefresh: true,
      previousSummary: null,
      chatExcerpts: 'chat',
      gitDiff: 'diff',
      currentTurnCount: 2,
      isMultiRepo: false,
    });

    expect(result.summary?.title).toBe('Recovered summary');
    expect(result.usage).toMatchObject({
      inputTokens: 16,
      outputTokens: 7,
    });
    expect(result.usage.totalCostUsd).toBeCloseTo(0.16);
  });

  it('returns null after two failures', async () => {
    mockedClaudeQuery.mockImplementation(() => {
      throw new Error('boom');
    });

    const result = await generateWorktreeSummary({
      cwd: '/repo',
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'off',
      isFullRefresh: true,
      previousSummary: null,
      chatExcerpts: 'chat',
      gitDiff: 'diff',
      currentTurnCount: 1,
      isMultiRepo: false,
    });

    expect(mockedClaudeQuery).toHaveBeenCalledTimes(2);
    expect(result.summary).toBeNull();
  });

  it('validates correct and incorrect summary shapes', () => {
    expect(isWorktreeSummaryData(makePreviousSummary())).toBe(true);
    expect(
      isWorktreeSummaryData({
        title: 'Missing metadata',
        description: 'Bad shape',
        highlights: ['Only partial'],
      }),
    ).toBe(false);
  });

  it('includes the previous summary for incremental refreshes and omits it for full refreshes', async () => {
    mockedClaudeQuery.mockReturnValue(
      makeQuery({
        title: 'Updated summary',
        description: 'Updated description',
        highlights: ['Updated highlight'],
      }),
    );

    const previousSummary = makePreviousSummary();

    await generateWorktreeSummary({
      cwd: '/repo',
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'off',
      isFullRefresh: false,
      previousSummary,
      chatExcerpts: 'chat',
      gitDiff: 'diff',
      currentTurnCount: 7,
      isMultiRepo: false,
    });

    await generateWorktreeSummary({
      cwd: '/repo',
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'off',
      isFullRefresh: true,
      previousSummary,
      chatExcerpts: 'chat',
      gitDiff: 'diff',
      currentTurnCount: 8,
      isMultiRepo: false,
    });

    const incrementalPrompt = mockedClaudeQuery.mock.calls[0]?.[0]?.prompt;
    const fullPrompt = mockedClaudeQuery.mock.calls[1]?.[0]?.prompt;

    expect(incrementalPrompt).toContain('## Previous summary');
    expect(incrementalPrompt).toContain('Previous title');
    expect(fullPrompt).not.toContain('## Previous summary');
  });

  it('runs Codex summaries through the shared structured runtime', async () => {
    mockCodexStructuredRun.mockResolvedValueOnce({
      value: {
        title: 'Workspace summary',
        description: 'Summarizes a multi-repo project change.',
        highlights: ['Updated repo coordination'],
        repos: [{ name: 'web', description: 'Adjusted auth flow' }],
      },
      usage: { inputTokens: 5, outputTokens: 4 },
    });

    const result = await generateWorktreeSummary({
      projectId: 'workspace-a',
      cwd: '/workspace/wt-1',
      model: 'gpt-5.5',
      thinkingLevel: 'medium',
      modelConfig: { fastMode: true },
      isFullRefresh: true,
      previousSummary: null,
      chatExcerpts: 'User: sync the multi-repo auth changes',
      gitDiff: 'diff --git a/file b/file',
      currentTurnCount: 6,
      isMultiRepo: true,
      repoDiffs: [{ name: 'web', diff: 'diff --git a/web b/web' }],
    });

    expect(result.summary?.title).toBe('Workspace summary');
    expect(mockCodexStructuredRun).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5.5',
        repoPath: '/workspace/wt-1',
        thinkingLevel: 'medium',
        workspaceId: 'workspace-a',
      }),
    );
    expect(mockCodexStructuredRun.mock.calls[0]?.[0]?.modelConfig).toEqual({
      fastMode: true,
    });
  });

  it('passes Codex plugin capabilities but not MCP secrets into summary generation', async () => {
    mockCodexStructuredRun.mockResolvedValueOnce({
      value: {
        title: 'Codex plugin summary',
        description: 'Uses a selected Codex plugin.',
        highlights: ['Codex capabilities applied'],
      },
      usage: { inputTokens: 3, outputTokens: 2 },
    });

    const pluginRuntimeInput: NonNullable<
      Parameters<typeof generateWorktreeSummary>[0]['pluginRuntime']
    > = {
      claudePlugins: [],
      claudeMcpServers: {},
      codexCapabilityRoots: [],
      codexMcpServers: {
        helper: { command: 'helper-mcp', args: [] },
      },
    };
    // Keep legacy secrets in the untyped input that the sanitizer must remove.
    Reflect.set(pluginRuntimeInput, 'codexProcessEnv', {
      CANOPY_TEST_PROFILE: 'summary-plugin',
      PLUGIN_MCP_TOKEN: 'secret',
    });
    Reflect.set(pluginRuntimeInput, 'codexMcpEnvKeys', ['PLUGIN_MCP_TOKEN']);

    const result = await generateWorktreeSummary({
      cwd: '/workspace/wt-1',
      model: 'gpt-5.5',
      thinkingLevel: 'medium',
      isFullRefresh: true,
      previousSummary: null,
      chatExcerpts: 'User: summarize with plugin',
      gitDiff: 'diff --git a/file b/file',
      currentTurnCount: 6,
      isMultiRepo: false,
      pluginRuntime: pluginRuntimeInput,
    });

    expect(result.summary?.title).toBe('Codex plugin summary');
    const pluginRuntime =
      mockCodexStructuredRun.mock.calls[0]?.[0]?.pluginRuntime;
    expect(pluginRuntime).not.toHaveProperty('codexProcessEnv');
    expect(pluginRuntime).not.toHaveProperty('codexMcpEnvKeys');
    expect(pluginRuntime?.codexMcpServers).toEqual({});
  });
});
