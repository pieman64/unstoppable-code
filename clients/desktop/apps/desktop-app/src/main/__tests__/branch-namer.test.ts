import type * as HelperInvocationModule from '../ollama/helper-invocation';
const mockResolveNamingInvocation = jest.fn<
  ReturnType<typeof HelperInvocationModule.resolveHelperInvocation>,
  Parameters<typeof HelperInvocationModule.resolveHelperInvocation>
>();
jest.mock('../ollama/helper-invocation', () => {
  const actual = jest.requireActual<typeof HelperInvocationModule>(
    '../ollama/helper-invocation',
  );
  return {
    ...actual,
    resolveHelperInvocation: (
      ...args: Parameters<typeof actual.resolveHelperInvocation>
    ): ReturnType<typeof actual.resolveHelperInvocation> =>
      mockResolveNamingInvocation(...args),
  };
});
import type * as NodeCrypto from 'node:crypto';
import type * as StructuredHelperDispatchModule from '../integration/structured-helper-dispatch';

interface BranchCodexRequestForTest {
  model?: string;
  thinkingLevel?: string;
  modelConfig?: { fastMode?: boolean };
  workspaceId?: string;
  abortController?: AbortController;
  pluginRuntime?: {
    codexCapabilityRoots?: Array<{ id: string }>;
    codexMcpServers?: Record<string, unknown>;
  };
}

jest.mock('node:fs/promises', () => ({
  readdir: jest.fn(),
}));

jest.mock('node:crypto', () => ({
  ...jest.requireActual<typeof NodeCrypto>('node:crypto'),
  randomUUID: jest.fn(() => '12345678-1234-4234-9234-123456789abc'),
}));

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
}));

const mockRunWorker = jest.fn();
const mockCancelWorker = jest.fn();
const mockCodexStructuredHelperRun = jest.fn<
  Promise<unknown>,
  [BranchCodexRequestForTest]
>();

jest.mock('../integration/structured-helper-dispatch', () => {
  const actual = jest.requireActual<typeof StructuredHelperDispatchModule>(
    '../integration/structured-helper-dispatch',
  );
  return {
    ...actual,
    codexStructuredHelperRunner: {
      get run(): typeof mockCodexStructuredHelperRun {
        return mockCodexStructuredHelperRun;
      },
    },
  };
});

jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(),
  // Local memory is opt-in (CAN-1969); default off in tests.
  readLocalMemoryEnabledPreference: jest.fn(() => Promise.resolve(false)),
}));

jest.mock('../lib/github-auth', () => ({
  ...jest.requireActual<object>('../lib/github-auth'),
  checkGitHubCliStatus: jest.fn(),
}));

jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    seedTranscript: jest.fn(),
    appendTranscriptRecord: jest.fn(),
  })),
}));

jest.mock('../lib/git', () => ({
  appendBranchSuffix: jest.fn((branchName: string, suffixNumber: number) => {
    const suffix = `-${suffixNumber}`;
    const maxBaseLength = Math.max(1, 100 - suffix.length);
    return `${branchName.slice(0, maxBaseLength)}${suffix}`;
  }),
  doesOriginBranchExist: jest.fn(),
  getCurrentBranch: jest.fn(),
  isBranchNameAvailable: jest.fn(),
  renameBranch: jest.fn(),
  resolveSharedAvailableBranchName: jest.fn(),
  validateBranchName: jest.fn(),
}));

jest.mock('../lib/github-pr', () => ({
  hasGitHubPullRequestHistoryForBranch: jest.fn(),
}));

jest.mock('../lib/worktree-branch-watcher', () => ({
  recordWorktreeBranchChange: jest.fn(() => Promise.resolve()),
}));

jest.mock('../lib/resolve-worktree', () => ({
  doesBranchMatchWorktreeId: jest.fn(),
}));

jest.mock('../plugins/plugin-resolver', () => ({
  resolvePlugins: jest.fn(),
}));

jest.mock('../plugins/plugin-cleanup', () => ({
  cleanupChatSkillPluginDir: jest.fn(),
}));

jest.mock('../integration/claude-worker-session-service', () => ({
  getClaudeWorkerSessionService: jest.fn(() => ({
    runWorker: mockRunWorker,
    cancel: mockCancelWorker,
  })),
}));

jest.mock('@canopy/desktop-shared/lib/codex-model-config', () => {
  return {
    codexServiceTierForModelConfig: jest.fn(
      (config?: { fastMode?: boolean }) =>
        config?.fastMode === true ? 'priority' : 'default',
    ),
    mapThinkingToReasoningEffort: (level: string): string => {
      switch (level) {
        case 'off':
          return 'minimal';
        case 'low':
          return 'low';
        case 'medium':
          return 'medium';
        case 'xhigh':
          return 'xhigh';
        case 'max':
          return 'max';
        default:
          return 'high';
      }
    },
  };
});

import { readdir } from 'node:fs/promises';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import { emptyCursorCapabilityProjection } from '@canopy/desktop-shared/lib/cursor-capabilities';
import {
  DEFAULT_HIDE_ANTHROPIC_NAV,
  initClaudeModels,
  initCodexModels,
  WORKSPACE_ROOT_REPO_ID,
} from '@canopy/desktop-shared/types';
import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { BrowserWindow } from 'electron';
import { readPreferencesFile } from '../lib/preferences-store';
import { checkGitHubCliStatus } from '../lib/github-auth';
import {
  doesOriginBranchExist,
  getCurrentBranch,
  isBranchNameAvailable,
  renameBranch,
  resolveSharedAvailableBranchName,
  validateBranchName,
} from '../lib/git';
import { hasGitHubPullRequestHistoryForBranch } from '../lib/github-pr';
import { doesBranchMatchWorktreeId } from '../lib/resolve-worktree';
import { recordWorktreeBranchChange } from '../lib/worktree-branch-watcher';
import { cleanupChatSkillPluginDir } from '../plugins/plugin-cleanup';
import { resolvePlugins } from '../plugins/plugin-resolver';
import { getMcpHttpProxyService } from '../mcp/http-proxy-service';
import {
  generateAndRenameBranch,
  sanitizeBranchName,
} from '../lib/branch-namer';
import { getBundledRgBinaryPath } from '../pipelines/config-paths';

initClaudeModels([
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
]);
initCodexModels([
  { id: 'gpt-5.5', label: 'GPT 5.5' },
  { id: 'gpt-5.6-luna', label: 'GPT 5.6 Luna' },
]);

const mockedReaddir = jest.mocked(readdir);
const mockedClaudeQuery = jest.mocked(claudeQuery);
const mockedReadPreferencesFile = jest.mocked(readPreferencesFile);
const mockedCheckGitHubCliStatus = jest.mocked(checkGitHubCliStatus);
const mockedDoesOriginBranchExist = jest.mocked(doesOriginBranchExist);
const mockedGetCurrentBranch = jest.mocked(getCurrentBranch);
const mockedIsBranchNameAvailable = jest.mocked(isBranchNameAvailable);
const mockedRenameBranch = jest.mocked(renameBranch);
const mockedResolveSharedAvailableBranchName = jest.mocked(
  resolveSharedAvailableBranchName,
);
const mockedValidateBranchName = jest.mocked(validateBranchName);
const mockedHasGitHubPullRequestHistoryForBranch = jest.mocked(
  hasGitHubPullRequestHistoryForBranch,
);
const mockedDoesBranchMatchWorktreeId = jest.mocked(doesBranchMatchWorktreeId);
const mockedRecordWorktreeBranchChange = jest.mocked(
  recordWorktreeBranchChange,
);
const mockedResolvePlugins = jest.mocked(resolvePlugins);
const mockedCleanupChatSkillPluginDir = jest.mocked(cleanupChatSkillPluginDir);

function makeResolvedPlugins(
  overrides: Partial<Awaited<ReturnType<typeof resolvePlugins>>> = {},
): Awaited<ReturnType<typeof resolvePlugins>> {
  return {
    sdkPlugins: [],
    skillPluginDir: null,
    selectedCapabilityRoots: [],
    codexMcpServers: {},
    mcpServers: {},
    mcpServerBindings: {},
    warnings: [],
    cursorNotices: [],
    cursorCapabilities: emptyCursorCapabilityProjection(),
    ...overrides,
  };
}

function makePreferences(
  overrides: Partial<PreferencesData> = {},
): PreferencesData {
  const preferences: Partial<PreferencesData> = {
    worktreePanelPercent: 32,
    activityPanelExpanded: false,
    activityPanelWidthPercent: 25,
    kanbanWorktreePanelPercent: 32,
    kanbanActivityPanelExpanded: false,
    kanbanActivityPanelWidthPercent: 25,
    kanbanChatPanelVisible: false,
    sidebarCollapsed: false,
    branchNamePrefixMode: 'none',
    branchNameCustomPrefix: '',
    deleteBranchOnArchive: true,
    archiveOnMerge: true,
    defaultChatProvider: 'claude',
    defaultChatModelByProvider: {
      claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'high' },
      codex: { model: 'gpt-5.5', thinkingLevel: 'high' },
      ollama: null,
    },
    defaultWorktreeProvider: 'claude',
    defaultWorktreeModelByProvider: {
      claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'high' },
      codex: { model: 'gpt-5.5', thinkingLevel: 'high' },
      ollama: null,
    },
    summaryModel: 'claude-haiku-4-5-20251001',
    summaryThinkingLevel: 'off',
    worktreeSummaryEnabled: true,
    worktreeSummaryModel: 'claude-haiku-4-5-20251001',
    worktreeSummaryThinkingLevel: 'off',
    prGenerationModel: 'claude-sonnet-4-6',
    prGenerationThinkingLevel: 'high',
    prInstructions: '',
    prInstructionMode: 'append',
    commitGenerationModel: 'claude-sonnet-4-6',
    commitGenerationThinkingLevel: 'high',
    commitInstructions: '',
    commitInstructionMode: 'append',
    branchNamingModel: 'claude-haiku-4-5-20251001',
    branchNamingThinkingLevel: 'off',
    branchNamingInstructions: '',
    branchNamingPluginSelections: {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    },
    commitGenerationPluginSelections: {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    },
    prGenerationPluginSelections: {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    },
    worktreeSummaryPluginSelections: {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    },
    branchDisplayMappings: [],
    reviewCommitMessage: false,
    agentRebaseResolutionEnabled: false,
    agentRebaseResolutionModel: null,
    agentRebaseResolutionThinkingLevel: null,
    mergeQueueAgentHandling: 'when_hook_absent',
    rtkEnabled: true,
    scriptTimeoutMinutes: 5,
    codexAppServerIdleTimeoutMinutes: 10,
    maxActiveChatTurns: 10,
    maxActivePipelineExecutions: 5,
    memoryPressureGuardEnabled: false,
    memoryPressureWarningThresholdBytes: 2 * 1024 * 1024 * 1024,
    memoryPressureCriticalThresholdBytes: 4 * 1024 * 1024 * 1024,
    keepSystemAwakeWhileAgentsActive: true,
    codexMultiAgentWorktreeChatsEnabled: false,
    codexMultiAgentStandaloneChatsEnabled: false,
    codexMultiAgentPipelinesEnabled: false,
    lastOpenApp: '',
    disabledOpenApps: [],
    lastSelectedWorktreeProjectId: '',
    lastSelectedWorktreeId: '',
    executionDetailViewMode: 'list',
    worktreeViewMode: 'list',
    worktreeFilterHiddenWorkspaceIds: [],
    auditRetentionDays: 7,
    theme: 'default',
    colorMode: 'dark',
    uiScale: 100,
    windowBounds: null,
    windowMaximized: false,
    windowFullScreen: false,
    ollamaServerPort: 11534,
    mcpProxyPort: 37645,
    hideAnthropicNav: DEFAULT_HIDE_ANTHROPIC_NAV,
    lastActiveContext: null,
    fileAutoSave: false,
    terminalDrawerCollapsed: true,
    terminalDrawerHeight: 300,
    terminalDrawerActiveTabId: 'terminal',
    voiceDictationEnabled: true,
    mcpHttpAuthDefaultHandler: 'canopy',
    fileIndexing: {
      disabledBuiltinGlobIds: [],
      customGlobs: [],
    },
    autoDownloadUpdates: true,
    ...overrides,
    showDiagnosticsPill: overrides.showDiagnosticsPill ?? true,
  };
  Reflect.set(preferences, 'inAppNotifications', {
    enabled: true,
    placement: 'bottom-right',
    categories: {
      chat: true,
      script: true,
      hook: true,
      gitCommit: true,
      gitPush: true,
      prCreate: true,
      pipeline: true,
      terminal: true,
    },
  });
  Reflect.set(preferences, 'osNotifications', {
    enabled: false,
    skipWhenFocused: true,
    defaultSound: 'System',
    categories: {
      chat: true,
      script: true,
      hook: true,
      gitCommit: true,
      gitPush: true,
      prCreate: true,
      pipeline: true,
      terminal: true,
    },
    categorySounds: {
      chat: 'Default',
      script: 'Default',
      hook: 'Default',
      gitCommit: 'Default',
      gitPush: 'Default',
      prCreate: 'Default',
      pipeline: 'Default',
      terminal: 'Default',
    },
  });
  // A partial fixture: these tests rely on unset preferences staying undefined.
  return preferences as PreferencesData;
}

function makeAsyncGenerator(
  values: unknown[],
): AsyncGenerator<unknown, void, unknown> {
  async function* generate(): AsyncGenerator<unknown, void, unknown> {
    for (const value of values) {
      await Promise.resolve();
      yield value;
    }
  }

  return generate();
}

function makeQuery(values: unknown[]): Query {
  return Object.assign(makeAsyncGenerator(values), {
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
  }) as unknown as Query;
}

function setupCodexBranchNamingFailures(message: string): jest.Mock {
  mockCodexStructuredHelperRun.mockRejectedValue(new Error(message));
  mockedReadPreferencesFile.mockResolvedValue(
    makePreferences({ branchNamingModel: 'gpt-5.5' }),
  );
  return mockCodexStructuredHelperRun;
}

describe('branch-namer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveNamingInvocation
      .mockReset()
      .mockImplementation(
        jest.requireActual<typeof HelperInvocationModule>(
          '../ollama/helper-invocation',
        ).resolveHelperInvocation,
      );
    mockRunWorker.mockReset();
    mockCancelWorker.mockReset();
    mockCodexStructuredHelperRun.mockReset();
    mockedReadPreferencesFile.mockResolvedValue(makePreferences());
    mockedCheckGitHubCliStatus.mockResolvedValue({
      authenticated: false,
      username: null,
      error: null,
      tokenSource: null,
      envOverride: false,
      envOverrideName: null,
      hasCredentialStoreLogin: false,
    });
    mockedResolveSharedAvailableBranchName.mockResolvedValue(
      'generated-branch',
    );
    mockedValidateBranchName.mockResolvedValue(true);
    mockedIsBranchNameAvailable.mockResolvedValue(true);
    mockedDoesOriginBranchExist.mockResolvedValue(false);
    mockedHasGitHubPullRequestHistoryForBranch.mockResolvedValue(false);
    mockedRenameBranch.mockResolvedValue(undefined);
    mockedDoesBranchMatchWorktreeId.mockResolvedValue({ matches: false });
    mockedReaddir.mockResolvedValue([]);
    mockedResolvePlugins.mockResolvedValue(makeResolvedPlugins());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('sanitizes generated branch names', () => {
    expect(sanitizeBranchName('  Fix OAuth__Flow!!!  ')).toBe('fix-oauth-flow');
    expect(sanitizeBranchName('feature.lock')).toBe('feature');
    expect(sanitizeBranchName('!!!')).toBeNull();
  });

  it('applies the configured prefix locally and passes Claude thinking through', async () => {
    mockedReadPreferencesFile.mockResolvedValue(
      makePreferences({
        branchNamePrefixMode: 'custom',
        branchNameCustomPrefix: 'team',
        branchNamingModel: 'claude-sonnet-4-6',
        branchNamingThinkingLevel: 'medium',
        branchNamingInstructions: 'Prefer auth-related names.',
      }),
    );
    mockedClaudeQuery.mockReturnValue(
      makeQuery([
        {
          type: 'result',
          structured_output: { branchName: 'oauth login' },
        },
      ]),
    );
    mockedResolveSharedAvailableBranchName.mockResolvedValue(
      'team/oauth-login',
    );

    await generateAndRenameBranch({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      cwd: '/workspace/project-a',
      userMessage: 'Add OAuth login support',
      branchResult: { matches: true },
    });

    expect(mockedResolveSharedAvailableBranchName).toHaveBeenCalledWith(
      ['/workspace/project-a'],
      'team/oauth-login',
    );
    expect(mockedRenameBranch).toHaveBeenCalledWith(
      '/workspace/project-a',
      'team/oauth-login',
    );
    const queryCall = mockedClaudeQuery.mock.calls[0];
    expect(queryCall).toBeDefined();
    if (!queryCall) {
      throw new Error('Expected Claude query call');
    }
    const [queryArg] = queryCall;
    expect(queryArg.prompt).toBe(
      '<task_description>Add OAuth login support</task_description>',
    );
    const queryOptions = queryArg.options;
    expect(queryOptions).toBeDefined();
    if (!queryOptions) {
      throw new Error('Expected Claude query options');
    }
    expect(queryOptions.model).toBe('claude-sonnet-4-6');
    expect(queryOptions.thinking).toEqual({
      type: 'adaptive',
      display: 'summarized',
    });
    expect(queryOptions.effort).toBe('medium');
    expect(queryOptions.systemPrompt).toContain(
      'Do not explore the repo, use tools, or connect to MCP servers.',
    );
    // A task such as "Read the full scope of the ticket" must be named, not
    // carried out: the helper gets no account connectors to act on it with.
    expect(queryOptions.systemPrompt).toContain(
      'The user message describes work for someone else to do',
    );
    expect(queryOptions.systemPrompt).toContain(
      'Ignore ids that are only mentioned in passing.',
    );
    expect(queryOptions.strictMcpConfig).toBe(true);
    expect(queryOptions.abortController).toBeInstanceOf(AbortController);
    expect(queryOptions.sandbox?.ripgrep?.command).toBe(
      getBundledRgBinaryPath(),
    );
  });

  it('retries Codex generation failures and preserves thinking propagation', async () => {
    mockCodexStructuredHelperRun
      .mockResolvedValueOnce({ value: null, usage: {} })
      .mockResolvedValueOnce({
        value: { branchName: 'fix-login' },
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    mockedReadPreferencesFile.mockResolvedValue(
      makePreferences({
        branchNamingModel: 'gpt-5.5',
        branchNamingThinkingLevel: 'xhigh',
      }),
    );
    mockedResolveSharedAvailableBranchName.mockResolvedValue('fix-login');

    await generateAndRenameBranch({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      cwd: '/workspace/project-a',
      userMessage: 'Fix the login bug',
      branchResult: { matches: true },
      modelConfig: { fastMode: true },
    });

    expect(mockCodexStructuredHelperRun).toHaveBeenCalledTimes(2);
    expect(mockCodexStructuredHelperRun).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5.5',
        thinkingLevel: 'xhigh',
        modelConfig: { fastMode: true },
        workspaceId: 'project-a',
        abortController: expect.any(AbortController) as unknown,
      }),
    );
    expect(mockedRenameBranch).toHaveBeenCalledWith(
      '/workspace/project-a',
      'fix-login',
    );
  });

  it.each([
    {
      name: 'turn.failed event',
      expected: 'model unavailable',
    },
    {
      name: 'error event',
      expected: 'stream exploded',
    },
    {
      name: 'missing terminal turn',
      expected: 'Codex branch naming ended without a terminal turn event',
    },
    {
      name: 'empty final agent message',
      expected: 'Codex branch naming returned no final agent message',
    },
  ])('surfaces Codex $name failures after retrying', async (scenario) => {
    const run = setupCodexBranchNamingFailures(scenario.expected);

    await expect(
      generateAndRenameBranch({
        projectId: 'project-a',
        worktreeId: 'wt-1',
        cwd: '/workspace/project-a',
        userMessage: 'Fix the login bug',
        branchResult: { matches: true },
      }),
    ).rejects.toThrow(
      `Failed to generate a valid branch name. Last failure: ${scenario.expected}`,
    );

    expect(run).toHaveBeenCalledTimes(2);
    expect(mockedRenameBranch).not.toHaveBeenCalled();
  });

  it('passes resolved Claude plugins and MCP servers to branch naming', async () => {
    mockedReadPreferencesFile.mockResolvedValue(
      makePreferences({
        branchNamingPluginSelections: {
          collectionIds: ['bundle-a'],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
        },
      }),
    );
    mockedResolvePlugins.mockResolvedValueOnce(
      makeResolvedPlugins({
        sdkPlugins: [{ type: 'local', path: '/plugins/branch' }],
        mcpServers: {
          helper: { type: 'stdio', command: 'helper-mcp' },
        },
      }),
    );
    mockedClaudeQuery.mockReturnValue(
      makeQuery([
        {
          type: 'result',
          structured_output: { branchName: 'plugin branch' },
        },
      ]),
    );
    mockedResolveSharedAvailableBranchName.mockResolvedValue('plugin-branch');

    await generateAndRenameBranch({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      cwd: '/workspace/project-a',
      userMessage: 'Use selected helper plugin',
      branchResult: { matches: true },
    });

    expect(mockedResolvePlugins).toHaveBeenCalledWith(
      expect.objectContaining({ collectionIds: ['bundle-a'] }),
      'project-a',
      'wt-1',
      expect.stringMatching(/^helper-branch-namer-/),
      { purpose: 'claude-session' },
    );
    const queryOptions = mockedClaudeQuery.mock.calls[0]?.[0].options;
    expect(queryOptions?.plugins).toEqual([
      { type: 'local', path: '/plugins/branch' },
    ]);
    expect(queryOptions?.mcpServers).toEqual({
      helper: { type: 'stdio', command: 'helper-mcp' },
    });
    expect(queryOptions?.tools).toEqual([]);
    expect(queryOptions?.strictMcpConfig).toBeUndefined();
    expect(queryOptions?.allowedTools?.[0]).toContain('ReportStructuredResult');
    expect(queryOptions?.systemPrompt).toContain(
      'If helper tools or MCP servers are configured, you may use them only when needed to disambiguate the task; otherwise answer directly without exploring the repo.',
    );
    expect(queryOptions?.systemPrompt).not.toContain(
      'Do not explore the repo, use tools, or connect to MCP servers.',
    );
    expect(mockedCleanupChatSkillPluginDir).toHaveBeenCalledWith(
      'project-a',
      'wt-1',
      expect.stringMatching(/^helper-branch-namer-/),
    );
  });

  it('routes terminal-mode Claude branch naming through the structured helper worker', async () => {
    mockedReadPreferencesFile.mockResolvedValue(
      makePreferences({
        canopyBackgroundProcessesMode: 'terminal',
      }),
    );
    mockRunWorker.mockResolvedValueOnce({
      status: 'success',
      result: { branchName: 'terminal branch' },
      usage: {
        inputTokens: 10,
        outputTokens: 3,
        messageCount: 1,
        assistantMessageCount: 1,
      },
      transcriptJsonl: '',
    });
    mockedResolveSharedAvailableBranchName.mockResolvedValue('terminal-branch');

    await generateAndRenameBranch({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      cwd: '/workspace/project-a',
      userMessage: 'Use terminal helper',
      branchResult: { matches: true },
    });

    expect(mockedClaudeQuery).not.toHaveBeenCalled();
    expect(mockRunWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'branch_naming',
        label: 'Branch Naming',
        cwd: '/workspace/project-a',
        projectId: 'project-a',
        settingSources: [],
        timeoutMs: 30_000,
      }),
    );
    // CAN-1641: report-only helpers must not carry Claude's dangerous
    // permission skip — `auto` helpers are governed by the Canopy approval
    // hook, and only `full-access` may combine bypassPermissions with
    // allowDangerouslySkipPermissions. Matching `permission` exactly (rather
    // than with objectContaining) makes any reintroduced permissionMode or
    // allowDangerouslySkipPermissions key fail this assertion. Built-in
    // mutation stays unavailable via `tools: []`, while the trusted internal
    // report tool stays reachable so an unattended worker can return a result
    // without a prompt it has no window to answer.
    expect(mockRunWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        permission: {
          tools: [],
          allowedTools: [expect.stringMatching(/__ReportStructuredResult$/)],
        },
      }),
    );
    expect(mockedRenameBranch).toHaveBeenCalledWith(
      '/workspace/project-a',
      'terminal-branch',
    );
  });

  it.each(['claude', 'codex'] as const)(
    'cancels %s proxy capacity preparation when its naming deadline expires',
    async (harness) => {
      jest.useFakeTimers();
      const model =
        harness === 'codex' ? 'gpt-5.5' : 'claude-haiku-4-5-20251001';
      mockedReadPreferencesFile.mockResolvedValue(
        makePreferences({ branchNamingModel: model }),
      );
      let passedSignal: AbortSignal | undefined;
      let enter: () => void = () => undefined;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      let release: () => void = () => undefined;
      mockResolveNamingInvocation.mockImplementationOnce(
        (_model, _routing, options) => {
          passedSignal = options?.signal;
          enter();
          return new Promise((resolve, reject) => {
            release = (): void =>
              resolve({
                providerType: harness,
                harness,
                source:
                  harness === 'codex' ? 'codex-managed' : 'claude-managed',
                sdkModel: model,
                aiCreditsRouted: false,
                dispose: () => undefined,
              });
            passedSignal?.addEventListener(
              'abort',
              () => reject(new Error('Capacity wait aborted')),
              { once: true },
            );
          });
        },
      );
      try {
        const attempt = generateAndRenameBranch({
          projectId: 'project-a',
          worktreeId: 'wt-1',
          cwd: '/workspace/project-a',
          userMessage: 'Name this branch',
          branchResult: { matches: true },
        });
        const rejected = expect(attempt).rejects.toThrow(
          'Branch naming timed out after 30 seconds.',
        );
        await entered;
        await jest.advanceTimersByTimeAsync(30_000);
        await rejected;
        expect(passedSignal?.aborted).toBe(true);
        expect(mockedRenameBranch).not.toHaveBeenCalled();
      } finally {
        release();
        await Promise.resolve();
        jest.useRealTimers();
      }
    },
  );

  it('aborts a hung helper after 30 seconds and allows a later retry', async () => {
    jest.useFakeTimers();
    let finishPluginResolution:
      | ((value: Awaited<ReturnType<typeof resolvePlugins>>) => void)
      | undefined;
    const pluginResolution = new Promise<
      Awaited<ReturnType<typeof resolvePlugins>>
    >((resolve) => {
      finishPluginResolution = resolve;
    });
    mockedReadPreferencesFile.mockResolvedValue(
      makePreferences({
        branchNamingPluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [{ marketplaceId: 'official', pluginName: 'plugin-a' }],
          mcpServerRefs: [],
        },
      }),
    );
    mockedResolvePlugins.mockImplementationOnce(() => pluginResolution);

    const firstAttempt = generateAndRenameBranch({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      cwd: '/workspace/project-a',
      userMessage: 'Name this branch',
      branchResult: { matches: true },
    });
    const rejection = expect(firstAttempt).rejects.toThrow(
      'Branch naming timed out after 30 seconds.',
    );

    await jest.advanceTimersByTimeAsync(30_000);
    await rejection;
    expect(mockedRenameBranch).not.toHaveBeenCalled();
    finishPluginResolution?.(makeResolvedPlugins());
    await Promise.resolve();

    jest.useRealTimers();
    mockedReadPreferencesFile.mockResolvedValue(makePreferences());
    mockedClaudeQuery.mockReturnValue(
      makeQuery([
        {
          type: 'result',
          structured_output: { branchName: 'retry-works' },
        },
      ]),
    );
    mockedResolveSharedAvailableBranchName.mockResolvedValue('retry-works');

    await generateAndRenameBranch({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      cwd: '/workspace/project-a',
      userMessage: 'Name this branch',
      branchResult: { matches: true },
    });

    expect(mockedRenameBranch).toHaveBeenCalledWith(
      '/workspace/project-a',
      'retry-works',
    );
  });

  it('extends the branch deadline while retrying a transient provider error', async () => {
    jest.useFakeTimers();
    try {
      mockedClaudeQuery
        .mockReturnValueOnce(
          makeQuery([
            {
              type: 'assistant',
              error: 'server_error',
              message: {
                content: [{ type: 'text', text: 'API Error: 529 Overloaded.' }],
              },
            },
          ]),
        )
        .mockReturnValueOnce(
          makeQuery([
            {
              type: 'result',
              structured_output: { branchName: 'retry-branch-name' },
            },
          ]),
        );
      mockedResolveSharedAvailableBranchName.mockResolvedValue(
        'retry-branch-name',
      );

      const resultPromise = generateAndRenameBranch({
        projectId: 'project-a',
        worktreeId: 'wt-1',
        cwd: '/workspace/project-a',
        userMessage: 'Retry this branch name',
        branchResult: { matches: true },
      });

      await jest.advanceTimersByTimeAsync(30_000);
      await expect(resultPromise).resolves.toEqual(
        expect.objectContaining({
          messageCount: 1,
          assistantMessageCount: 1,
        }),
      );
      expect(mockedClaudeQuery).toHaveBeenCalledTimes(2);
      expect(mockedRenameBranch).toHaveBeenCalledWith(
        '/workspace/project-a',
        'retry-branch-name',
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('cancels a hung terminal worker with managed worker cleanup', async () => {
    jest.useFakeTimers();
    mockedReadPreferencesFile.mockResolvedValue(
      makePreferences({
        canopyBackgroundProcessesMode: 'terminal',
      }),
    );
    let settleWorker:
      | ((result: {
          status: 'cancelled';
          finalText: string;
          usage: Record<string, never>;
          transcriptJsonl: string;
        }) => void)
      | undefined;
    mockRunWorker.mockImplementation(
      (request: { onCreated?: (workerId: string) => void }) => {
        request.onCreated?.('branch-worker');
        return new Promise((resolve) => {
          settleWorker = resolve;
        });
      },
    );
    mockCancelWorker.mockImplementation(() => {
      settleWorker?.({
        status: 'cancelled',
        finalText: '',
        usage: {},
        transcriptJsonl: '',
      });
      return Promise.resolve();
    });

    const attempt = generateAndRenameBranch({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      cwd: '/workspace/project-a',
      userMessage: 'Name this branch',
      branchResult: { matches: true },
    });
    const rejection = expect(attempt).rejects.toThrow(
      'Branch naming timed out after 30 seconds.',
    );

    await jest.advanceTimersByTimeAsync(30_000);
    await rejection;

    expect(mockCancelWorker).toHaveBeenCalledWith('branch-worker');
    expect(mockedRenameBranch).not.toHaveBeenCalled();
  });

  it('passes resolved Codex runtime to branch naming', async () => {
    mockCodexStructuredHelperRun.mockResolvedValue({
      value: { branchName: 'codex-plugin' },
      usage: {},
    });
    mockedReadPreferencesFile.mockResolvedValue(
      makePreferences({
        branchNamingModel: 'gpt-5.5',
        branchNamingPluginSelections: {
          collectionIds: ['bundle-a'],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
        },
      }),
    );
    mockedResolvePlugins.mockResolvedValueOnce(
      makeResolvedPlugins({
        selectedCapabilityRoots: [
          {
            id: 'plugin-root',
            location: {
              type: 'environment',
              environmentId: 'local',
              path: 'file:///tmp/plugin-root',
            },
          },
        ],
        codexMcpServers: {
          helper: { command: 'helper-mcp', args: [] },
        },
      }),
    );
    mockedResolveSharedAvailableBranchName.mockResolvedValue('codex-plugin');
    const helperChatId =
      'helper-branch-namer-12345678-1234-4234-9234-123456789abc';

    await generateAndRenameBranch({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      cwd: '/workspace/project-a',
      userMessage: 'Use selected Codex plugin',
      branchResult: { matches: true },
    });

    expect(mockedResolvePlugins).toHaveBeenCalledWith(
      expect.objectContaining({ collectionIds: ['bundle-a'] }),
      'project-a',
      'wt-1',
      helperChatId,
      expect.objectContaining({
        purpose: 'codex-session',
        enableHttpMcpProxy: true,
        mcpHttpProxyService: getMcpHttpProxyService(),
        sessionId: helperChatId,
      }),
    );
    expect(mockCodexStructuredHelperRun).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginRuntime: expect.objectContaining({
          codexCapabilityRoots: [
            expect.objectContaining({ id: 'plugin-root' }),
          ],
          codexMcpServers: {
            helper: { command: 'helper-mcp', args: [] },
          },
        }) as unknown,
      }),
    );
  });

  it('resolves one shared available branch name across target repos', async () => {
    mockedClaudeQuery.mockReturnValue(
      makeQuery([
        {
          type: 'result',
          structured_output: { branchName: 'feature api' },
        },
      ]),
    );
    mockedResolveSharedAvailableBranchName.mockResolvedValue('feature-api-2');

    await generateAndRenameBranch({
      projectId: 'workspace-a',
      worktreeId: 'wt-1',
      cwd: '/workspace/wt-1',
      userMessage: 'Build the new API feature',
      branchResult: { matches: true, matchingRepos: ['repo-a', 'repo-b'] },
    });

    expect(mockedResolveSharedAvailableBranchName).toHaveBeenCalledWith(
      ['/workspace/wt-1/repos/repo-a', '/workspace/wt-1/repos/repo-b'],
      'feature-api',
    );
    expect(mockedRenameBranch).toHaveBeenCalledWith(
      '/workspace/wt-1/repos/repo-a',
      'feature-api-2',
    );
    expect(mockedRenameBranch).toHaveBeenCalledWith(
      '/workspace/wt-1/repos/repo-b',
      'feature-api-2',
    );
  });

  it('suffixes all target repos when a branch exists on origin only', async () => {
    mockedClaudeQuery.mockReturnValue(
      makeQuery([
        {
          type: 'result',
          structured_output: { branchName: 'feature api' },
        },
      ]),
    );
    mockedResolveSharedAvailableBranchName.mockResolvedValue('feature-api');
    mockedDoesOriginBranchExist.mockImplementation((_repoPath, branchName) =>
      Promise.resolve(branchName === 'feature-api'),
    );

    await generateAndRenameBranch({
      projectId: 'workspace-a',
      worktreeId: 'wt-1',
      cwd: '/workspace/wt-1',
      userMessage: 'Build the new API feature',
      branchResult: { matches: true, matchingRepos: ['repo-a', 'repo-b'] },
    });

    expect(mockedRenameBranch).toHaveBeenCalledWith(
      '/workspace/wt-1/repos/repo-a',
      'feature-api-2',
    );
    expect(mockedRenameBranch).toHaveBeenCalledWith(
      '/workspace/wt-1/repos/repo-b',
      'feature-api-2',
    );
  });

  it('continues counter suffixes after local and remote branch conflicts', async () => {
    mockedClaudeQuery.mockReturnValue(
      makeQuery([
        {
          type: 'result',
          structured_output: { branchName: 'feature api' },
        },
      ]),
    );
    mockedResolveSharedAvailableBranchName.mockResolvedValue('feature-api-2');
    mockedDoesOriginBranchExist.mockImplementation((_repoPath, branchName) =>
      Promise.resolve(branchName === 'feature-api-2'),
    );

    await generateAndRenameBranch({
      projectId: 'workspace-a',
      worktreeId: 'wt-1',
      cwd: '/workspace/wt-1',
      userMessage: 'Build the new API feature',
      branchResult: { matches: true },
    });

    expect(mockedRenameBranch).toHaveBeenCalledWith(
      '/workspace/wt-1',
      'feature-api-3',
    );
    expect(mockedRenameBranch).not.toHaveBeenCalledWith(
      '/workspace/wt-1',
      'feature-api-2-2',
    );
  });

  it('suffixes branch names that have historical GitHub pull requests', async () => {
    mockedClaudeQuery.mockReturnValue(
      makeQuery([
        {
          type: 'result',
          structured_output: { branchName: 'fix login' },
        },
      ]),
    );
    mockedResolveSharedAvailableBranchName.mockResolvedValue('fix-login');
    mockedHasGitHubPullRequestHistoryForBranch.mockImplementation(
      (_repoPath, branchName) => Promise.resolve(branchName === 'fix-login'),
    );

    await generateAndRenameBranch({
      projectId: 'workspace-a',
      worktreeId: 'wt-1',
      cwd: '/workspace/wt-1',
      userMessage: 'Fix login',
      branchResult: { matches: true },
    });

    expect(mockedRenameBranch).toHaveBeenCalledWith(
      '/workspace/wt-1',
      'fix-login-2',
    );
  });

  it('uses a partial uuid suffix after five counter conflicts', async () => {
    mockedClaudeQuery.mockReturnValue(
      makeQuery([
        {
          type: 'result',
          structured_output: { branchName: 'feature api' },
        },
      ]),
    );
    mockedResolveSharedAvailableBranchName.mockResolvedValue('feature-api');
    mockedDoesOriginBranchExist.mockImplementation((_repoPath, branchName) =>
      Promise.resolve(
        [
          'feature-api',
          'feature-api-2',
          'feature-api-3',
          'feature-api-4',
          'feature-api-5',
          'feature-api-6',
        ].includes(branchName),
      ),
    );

    await generateAndRenameBranch({
      projectId: 'workspace-a',
      worktreeId: 'wt-1',
      cwd: '/workspace/wt-1',
      userMessage: 'Build the new API feature',
      branchResult: { matches: true },
    });

    expect(mockedRenameBranch).toHaveBeenCalledWith(
      '/workspace/wt-1',
      'feature-api-12345678',
    );
  });

  it('resolves source-backed project root branches against the worktree root path', async () => {
    mockedClaudeQuery.mockReturnValue(
      makeQuery([
        {
          type: 'result',
          structured_output: { branchName: 'explore workspace' },
        },
      ]),
    );
    mockedResolveSharedAvailableBranchName.mockResolvedValue(
      'explore-workspace',
    );

    await generateAndRenameBranch({
      projectId: 'workspace-a',
      worktreeId: 'cow',
      cwd: '/workspace/cow',
      userMessage: 'Explore this project',
      branchResult: {
        matches: true,
        matchingRepos: [WORKSPACE_ROOT_REPO_ID, 'repo-a'],
      },
    });

    expect(mockedResolveSharedAvailableBranchName).toHaveBeenCalledWith(
      ['/workspace/cow', '/workspace/cow/repos/repo-a'],
      'explore-workspace',
    );
    expect(mockedRenameBranch).toHaveBeenCalledWith(
      '/workspace/cow',
      'explore-workspace',
    );
    expect(mockedRenameBranch).toHaveBeenCalledWith(
      '/workspace/cow/repos/repo-a',
      'explore-workspace',
    );
  });

  it('reuses an existing shared branch name after a partial multi-repo success', async () => {
    mockedReaddir.mockResolvedValue([
      { name: 'repo-a', isDirectory: (): boolean => true },
      { name: 'repo-b', isDirectory: (): boolean => true },
      { name: 'repo-c', isDirectory: (): boolean => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);
    mockedGetCurrentBranch.mockResolvedValue('shared-branch');

    await generateAndRenameBranch({
      projectId: 'workspace-a',
      worktreeId: 'wt-1',
      cwd: '/workspace/wt-1',
      userMessage: 'Refactor API routes',
      branchResult: { matches: true, matchingRepos: ['repo-b', 'repo-c'] },
    });

    expect(mockedClaudeQuery).not.toHaveBeenCalled();
    expect(mockedResolveSharedAvailableBranchName).not.toHaveBeenCalled();
    expect(mockedValidateBranchName).toHaveBeenCalledWith(
      '/workspace/wt-1/repos/repo-b',
      'shared-branch',
    );
    expect(mockedRenameBranch).toHaveBeenCalledWith(
      '/workspace/wt-1/repos/repo-b',
      'shared-branch',
    );
    expect(mockedRenameBranch).toHaveBeenCalledWith(
      '/workspace/wt-1/repos/repo-c',
      'shared-branch',
    );
  });

  it('ignores timestamped default branch names when reusing shared branches', async () => {
    mockedReaddir.mockResolvedValue([
      { name: 'repo-a', isDirectory: (): boolean => true },
      { name: 'repo-b', isDirectory: (): boolean => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);
    mockedGetCurrentBranch.mockResolvedValue('wt-1-1713571200123');
    mockedClaudeQuery.mockReturnValue(
      makeQuery([
        {
          type: 'result',
          structured_output: { branchName: 'refactor api' },
        },
      ]),
    );
    mockedResolveSharedAvailableBranchName.mockResolvedValue('refactor-api');

    await generateAndRenameBranch({
      projectId: 'workspace-a',
      worktreeId: 'wt-1',
      cwd: '/workspace/wt-1',
      userMessage: 'Refactor API routes',
      branchResult: { matches: true, matchingRepos: ['repo-b'] },
    });

    expect(mockedClaudeQuery).toHaveBeenCalled();
    expect(mockedResolveSharedAvailableBranchName).toHaveBeenCalledWith(
      ['/workspace/wt-1/repos/repo-b'],
      'refactor-api',
    );
    expect(mockedRenameBranch).toHaveBeenCalledWith(
      '/workspace/wt-1/repos/repo-b',
      'refactor-api',
    );
  });
  describe('records the rename for the sidebar', () => {
    const windowRef = {} as BrowserWindow;

    function mockGeneratedName(branchName: string): void {
      mockedClaudeQuery.mockReturnValue(
        makeQuery([{ type: 'result', structured_output: { branchName } }]),
      );
    }

    function recordedWindow(callIndex: number): BrowserWindow | null {
      const getWindow =
        mockedRecordWorktreeBranchChange.mock.calls[callIndex]?.[1];
      return getWindow ? getWindow() : null;
    }

    it('records a single-repo rename once with its final name', async () => {
      mockGeneratedName('feature api');
      mockedResolveSharedAvailableBranchName.mockResolvedValue('feature-api');

      await generateAndRenameBranch({
        projectId: 'workspace-a',
        worktreeId: 'wt-1',
        cwd: '/workspace/wt-1',
        userMessage: 'Build the new API feature',
        branchResult: { matches: true },
        getWindow: () => windowRef,
      });

      const renamedTo = mockedRenameBranch.mock.calls.at(-1)?.[1];
      expect(renamedTo).toEqual(expect.any(String));
      expect(mockedRecordWorktreeBranchChange).toHaveBeenCalledTimes(1);
      expect(mockedRecordWorktreeBranchChange).toHaveBeenCalledWith(
        { projectId: 'workspace-a', worktreeId: 'wt-1', branchName: renamedTo },
        expect.any(Function),
      );
      expect(recordedWindow(0)).toBe(windowRef);
    });

    it('records only the repos whose multi-repo rename succeeded', async () => {
      // repo-a already carries the shared branch, so no model is needed.
      mockedReaddir.mockResolvedValue([
        { name: 'repo-a', isDirectory: (): boolean => true },
        { name: 'repo-b', isDirectory: (): boolean => true },
        { name: 'repo-c', isDirectory: (): boolean => true },
      ] as unknown as Awaited<ReturnType<typeof readdir>>);
      mockedGetCurrentBranch.mockResolvedValue('shared-branch');
      mockedRenameBranch.mockImplementation((repoPath) =>
        repoPath.endsWith('/repo-c')
          ? Promise.reject(new Error('locked'))
          : Promise.resolve(undefined),
      );

      await generateAndRenameBranch({
        projectId: 'workspace-a',
        worktreeId: 'wt-1',
        cwd: '/workspace/wt-1',
        userMessage: 'Refactor API routes',
        branchResult: { matches: true, matchingRepos: ['repo-b', 'repo-c'] },
        getWindow: () => windowRef,
      });

      expect(mockedRecordWorktreeBranchChange).toHaveBeenCalledTimes(1);
      expect(mockedRecordWorktreeBranchChange).toHaveBeenCalledWith(
        {
          projectId: 'workspace-a',
          worktreeId: 'wt-1',
          branchName: 'shared-branch',
          repoId: 'repo-b',
        },
        expect.any(Function),
      );
    });

    it('records nothing when every rename candidate fails', async () => {
      mockGeneratedName('feature api');
      mockedResolveSharedAvailableBranchName.mockResolvedValue('feature-api');
      mockedRenameBranch.mockRejectedValue(new Error('locked'));

      await expect(
        generateAndRenameBranch({
          projectId: 'workspace-a',
          worktreeId: 'wt-1',
          cwd: '/workspace/wt-1',
          userMessage: 'Build the new API feature',
          branchResult: { matches: true },
          getWindow: () => windowRef,
        }),
      ).rejects.toThrow('locked');

      expect(mockedRecordWorktreeBranchChange).not.toHaveBeenCalled();
    });

    it('records the rename without a window', async () => {
      mockGeneratedName('feature api');
      mockedResolveSharedAvailableBranchName.mockResolvedValue('feature-api');

      await generateAndRenameBranch({
        projectId: 'workspace-a',
        worktreeId: 'wt-1',
        cwd: '/workspace/wt-1',
        userMessage: 'Build the new API feature',
        branchResult: { matches: true },
      });

      expect(mockedRecordWorktreeBranchChange).toHaveBeenCalledTimes(1);
      expect(recordedWindow(0)).toBeNull();
    });

    it('keeps the rename when recording it fails', async () => {
      mockGeneratedName('feature api');
      mockedResolveSharedAvailableBranchName.mockResolvedValue('feature-api');
      mockedRecordWorktreeBranchChange.mockRejectedValueOnce(
        new Error('disk full'),
      );

      // Resolves: a failed record does not fail the rename.
      await generateAndRenameBranch({
        projectId: 'workspace-a',
        worktreeId: 'wt-1',
        cwd: '/workspace/wt-1',
        userMessage: 'Build the new API feature',
        branchResult: { matches: true },
        getWindow: () => windowRef,
      });

      expect(mockedRenameBranch).toHaveBeenCalled();
      expect(mockedRecordWorktreeBranchChange).toHaveBeenCalledTimes(1);
    });
  });
});
