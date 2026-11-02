jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(),
}));

jest.mock('node:fs/promises', () => ({
  readdir: jest.fn().mockResolvedValue([]),
  stat: jest.fn(),
}));

jest.mock('../lib/chat-tabs-reader', () => ({
  readChatTabsFile: jest.fn(),
}));

jest.mock('../lib/worktree-summary-persistence', () => ({
  emitWorktreeSummaryPortalDelta: jest.fn(),
  readWorktreeSummary: jest.fn(),
  readWorktreeSummaryWriteAbortReason: jest.fn(),
  writeWorktreeSummarySnapshot: jest.fn(),
}));

const mockLedgerEnabled = jest.fn<boolean, []>(() => false);
const mockTurnRunning = jest.fn<boolean, [string, string]>(() => false);

jest.mock('../agents/session-manager', () => ({
  hasActiveChatTurnsForWorktree: (
    projectId: string,
    worktreeId: string,
  ): boolean => mockTurnRunning(projectId, worktreeId),
}));

jest.mock('../ledger/summary-publication', () => ({
  DESKTOP_SUMMARY_PUBLICATION_HOST: {
    isEnabled: (): boolean => mockLedgerEnabled(),
  },
  isSummaryScopePublishable: (): boolean => mockLedgerEnabled(),
  reportAbortedSummaryWrite: jest.fn(),
  reportDroppedSummarySnapshots: jest.fn(),
  reportInvalidSummarySnapshots: jest.fn(),
  reportReplacedSummaryFile: jest.fn(),
  reportStrippedSummaryProvenance: jest.fn(),
}));

jest.mock('../ledger/summary-reconciliation', () => ({
  publishPendingSummarySnapshots: jest.fn(),
}));

jest.mock('../lib/worktree-summary-generator', () => ({
  generateWorktreeSummary: jest.fn(),
}));

jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(() => '/repo'),
}));

jest.mock('../lib/workspace-source', () => ({
  readEffectiveWorkspaceConfig: jest.fn(),
}));

const mockIsCoworkWorkspace = jest.fn<boolean, [string]>(() => false);

jest.mock('../lib/workspace-registry', () => ({
  isMultiRepoWorkspace: jest.fn(() => false),
  isCoworkWorkspace: (projectId: string): boolean =>
    mockIsCoworkWorkspace(projectId),
  isWorkEntryWorkspace: (projectId: string): boolean =>
    projectId === 'app-advisor' || mockIsCoworkWorkspace(projectId),
}));

jest.mock('../lib/git', () => ({
  getRemoteDefaultBranch: jest.fn(),
  getComparisonDiff: jest.fn(),
  getUncommittedDiff: jest.fn(),
}));

jest.mock('../lib/paths', () => ({
  getWorkspaceWorktreeRepoDir: jest.fn(() => '/repo'),
}));

jest.mock('../lib/window-send', () => ({
  sendToAllWindows: jest.fn(),
}));

jest.mock('../lib/helper-plugin-resolution', () => ({
  withResolvedHelperPlugins: jest.fn(),
}));

const mockIsE2eBuild = jest.fn<boolean, []>();

jest.mock('../lib/e2e-gate', () => ({
  isE2eBuild: (): boolean => mockIsE2eBuild(),
}));

const mockIsModelBlockedByStoredPolicy = jest.fn<
  Promise<boolean>,
  [string | undefined]
>(() => Promise.resolve(false));

jest.mock('../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: (
    modelId: string | undefined,
  ): Promise<boolean> => mockIsModelBlockedByStoredPolicy(modelId),
}));

const startObservedTaskMock = jest.fn();
const finalizeObservedTaskMock = jest.fn();

jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    startObservedTask: startObservedTaskMock,
    finalizeObservedTask: finalizeObservedTaskMock,
  })),
}));

import {
  DEFAULT_HIDE_ANTHROPIC_NAV,
  IPC_CHANNELS,
  WORKSPACE_ROOT_REPO_NAME,
  initClaudeModels,
  initCodexModels,
  initModelAliases,
  type ChatTabsFile,
  type PreferencesData,
  type WorktreeSummaryData,
  type WorktreeSummaryProvenance,
} from '@canopy/desktop-shared/types';
import { readPreferencesFile } from '../lib/preferences-store';
import { readChatTabsFile } from '../lib/chat-tabs-reader';
import {
  emitWorktreeSummaryPortalDelta,
  readWorktreeSummary,
  readWorktreeSummaryWriteAbortReason,
  writeWorktreeSummarySnapshot,
  type WorktreeSummaryWriteResult,
} from '../lib/worktree-summary-persistence';
import {
  reportAbortedSummaryWrite,
  reportDroppedSummarySnapshots,
  reportInvalidSummarySnapshots,
  reportReplacedSummaryFile,
  reportStrippedSummaryProvenance,
} from '../ledger/summary-publication';
import { publishPendingSummarySnapshots } from '../ledger/summary-reconciliation';
import {
  generateWorktreeSummary,
  type WorktreeSummaryResult,
} from '../lib/worktree-summary-generator';
import {
  getComparisonDiff,
  getRemoteDefaultBranch,
  getUncommittedDiff,
} from '../lib/git';
import { getWorkspaceWorktreeRepoDir } from '../lib/paths';
import { isMultiRepoWorkspace } from '../lib/workspace-registry';
import { sendToAllWindows } from '../lib/window-send';
import { withResolvedHelperPlugins } from '../lib/helper-plugin-resolution';
import {
  BACKGROUND_HELPER_PRIORITIES,
  backgroundHelperQueueTestExports,
  enqueueBackgroundHelperTask,
} from '../lib/background-helper-queue';
import {
  readEffectiveWorkspaceConfig,
  type EffectiveWorkspaceConfig,
} from '../lib/workspace-source';
import {
  LEDGER_SUMMARY_MAX_WAIT_MS,
  LEDGER_SUMMARY_QUIET_MS,
  cancelScheduledGeneration,
  scheduleSummaryGeneration,
  triggerManualRefresh,
} from '../lib/worktree-summary-scheduler';

const mockedReadPreferencesFile = jest.mocked(readPreferencesFile);
const mockedReadChatTabsFile = jest.mocked(readChatTabsFile);
const mockedReadWorktreeSummary = jest.mocked(readWorktreeSummary);
const mockedWriteWorktreeSummary = jest.mocked(writeWorktreeSummarySnapshot);
const mockedReadWriteAbortReason = jest.mocked(
  readWorktreeSummaryWriteAbortReason,
);
const mockedPublishPending = jest.mocked(publishPendingSummarySnapshots);
const mockedReportDropped = jest.mocked(reportDroppedSummarySnapshots);
const mockedReportReplaced = jest.mocked(reportReplacedSummaryFile);
const mockedReportAborted = jest.mocked(reportAbortedSummaryWrite);
const mockedReportInvalid = jest.mocked(reportInvalidSummarySnapshots);
const mockedReportStripped = jest.mocked(reportStrippedSummaryProvenance);
const mockedEmitWorktreeSummaryPortalDelta = jest.mocked(
  emitWorktreeSummaryPortalDelta,
);
const mockedGenerateWorktreeSummary = jest.mocked(generateWorktreeSummary);
const mockedGetRemoteDefaultBranch = jest.mocked(getRemoteDefaultBranch);
const mockedGetComparisonDiff = jest.mocked(getComparisonDiff);
const mockedGetUncommittedDiff = jest.mocked(getUncommittedDiff);
const mockedGetWorkspaceWorktreeRepoDir = jest.mocked(
  getWorkspaceWorktreeRepoDir,
);
const mockedIsMultiRepoWorkspace = jest.mocked(isMultiRepoWorkspace);
const mockedReadEffectiveWorkspaceConfig = jest.mocked(
  readEffectiveWorkspaceConfig,
);
const mockedSendToAllWindows = jest.mocked(sendToAllWindows);
const mockedWithResolvedHelperPlugins = jest.mocked(withResolvedHelperPlugins);

initClaudeModels([
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  { id: 'sonnet', label: 'Sonnet' },
]);
initCodexModels([
  { id: 'gpt-5.5', label: 'GPT 5.5' },
  { id: 'o4-mini', label: 'o4-mini' },
]);
initClaudeModels([
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
]);
initModelAliases({ 'claude-sonnet-4-6': 'sonnet' });

function makeChatTabs(turns: number): ChatTabsFile {
  return {
    version: 1,
    activeTabId: 'tab-1',
    tabs: [
      {
        id: 'tab-1',
        title: 'Main',
        createdAt: '2026-03-25T10:00:00.000Z',
        messages: Array.from({ length: turns }).flatMap((_, index) => [
          {
            id: `u-${index}`,
            role: 'user' as const,
            timestamp: index * 2 + 1,
            blocks: [{ type: 'text' as const, text: `User turn ${index + 1}` }],
          },
          {
            id: `a-${index}`,
            role: 'assistant' as const,
            timestamp: index * 2 + 2,
            blocks: [
              { type: 'text' as const, text: `Assistant reply ${index + 1}` },
            ],
          },
        ]),
      },
    ],
  };
}

function makePreferences(
  overrides: Partial<PreferencesData> = {},
): PreferencesData {
  // A partial fixture: these tests rely on unset preferences staying undefined.
  const preferences: Partial<PreferencesData> = {
    worktreePanelPercent: 32,
    activityPanelExpanded: false,
    activityPanelWidthPercent: 25,
    kanbanWorktreePanelPercent: 32,
    kanbanActivityPanelExpanded: false,
    kanbanActivityPanelWidthPercent: 25,
    kanbanChatPanelVisible: false,
    sidebarCollapsed: false,
    branchNamePrefixMode: 'github',
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
    inAppNotifications: {
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
        runComment: true,
        activation: true,
      },
    },
    terminalDrawerCollapsed: true,
    terminalDrawerHeight: 300,
    terminalDrawerActiveTabId: 'terminal',
    osNotifications: {
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
        runComment: true,
        activation: true,
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
        runComment: 'Default',
        activation: 'Default',
      },
    },
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
  return preferences as PreferencesData;
}

function makeSummaryData(turnCountAtGeneration: number): WorktreeSummaryData {
  return {
    title: 'Summary',
    description: 'Description',
    highlights: ['One highlight'],
    generatedAt: '2026-03-25T10:00:00.000Z',
    turnCountAtGeneration,
    lastFullRefreshAt: '2026-03-25T10:00:00.000Z',
    lastFullRefreshTurnCount: turnCountAtGeneration,
  };
}

function makeSummary(turnCountAtGeneration: number): {
  summary: WorktreeSummaryData;
  usage: Record<string, never>;
} {
  return { summary: makeSummaryData(turnCountAtGeneration), usage: {} };
}

function makeEffectiveWorkspaceConfig(
  overrides: Partial<EffectiveWorkspaceConfig> = {},
): EffectiveWorkspaceConfig {
  return {
    sourceRepoPath: undefined,
    manifest: null,
    repos: [],
    scripts: undefined,
    defaultPluginSelections: undefined,
    suppressedRepoIds: undefined,
    suppressedManifestRepos: [],
    unresolvedManifestRepoIds: [],
    localConfig: {
      version: 1,
      type: 'multi-repo',
      repos: [],
    },
    ...overrides,
  };
}

/** A write that appended a new snapshot carrying `provenance`. */
function newSnapshotWrite(
  summary: WorktreeSummaryData,
  provenance?: WorktreeSummaryProvenance,
): WorktreeSummaryWriteResult {
  return {
    kind: 'written',
    snapshot: {
      snapshotId: 'snapshot-new',
      summary,
      ...(provenance === undefined ? {} : { provenance }),
    },
    isNewSnapshot: true,
    droppedPublishableSnapshotIds: [],
    strippedPublishableSnapshotIds: [],
    droppedInvalidSnapshotCount: 0,
    replacedCorruptFile: false,
  };
}

async function flushMicrotasks(): Promise<void> {
  await jest.advanceTimersByTimeAsync(0);
  await Promise.resolve();
  await Promise.resolve();
}

async function flushUntil(
  predicate: () => boolean,
  maxIterations = 50,
): Promise<void> {
  for (let i = 0; i < maxIterations; i += 1) {
    if (predicate()) {
      return;
    }
    await flushMicrotasks();
  }
}

describe('worktree summary scheduler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    backgroundHelperQueueTestExports.reset();
    mockIsE2eBuild.mockReturnValue(false);
    mockIsCoworkWorkspace.mockReturnValue(false);
    mockIsModelBlockedByStoredPolicy.mockReset();
    mockIsModelBlockedByStoredPolicy.mockResolvedValue(false);
    startObservedTaskMock.mockReset();
    finalizeObservedTaskMock.mockReset();
    mockedReadPreferencesFile.mockResolvedValue(makePreferences());
    mockedReadChatTabsFile.mockResolvedValue(makeChatTabs(2));
    mockedReadWorktreeSummary.mockResolvedValue(makeSummaryData(1));
    mockedReadWriteAbortReason.mockResolvedValue(null);
    mockedGenerateWorktreeSummary.mockResolvedValue(makeSummary(2));
    mockLedgerEnabled.mockReturnValue(false);
    mockTurnRunning.mockReturnValue(false);
    mockedWriteWorktreeSummary.mockImplementation(
      (_projectId, _worktreeId, summary, provenance) =>
        Promise.resolve(newSnapshotWrite(summary, provenance)),
    );
    mockedGetRemoteDefaultBranch.mockResolvedValue(null);
    mockedGetComparisonDiff.mockResolvedValue('');
    mockedGetUncommittedDiff.mockResolvedValue('');
    mockedGetWorkspaceWorktreeRepoDir.mockImplementation(
      (_projectId, _worktreeId, repoId): string => `/repo/repos/${repoId}`,
    );
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedReadEffectiveWorkspaceConfig.mockResolvedValue(
      makeEffectiveWorkspaceConfig(),
    );
    mockedWithResolvedHelperPlugins.mockImplementation((_, run) => {
      const pluginRuntime: Parameters<typeof run>[0] = {
        claudePlugins: [],
        claudeMcpServers: {},
        codexCapabilityRoots: [],
        codexMcpServers: {},
      };
      Reflect.deleteProperty(pluginRuntime, 'codexCapabilityRoots');
      // Preserve the legacy runtime field this scheduler fixture supplies.
      Reflect.set(pluginRuntime, 'codexEnv', {});
      return run(pluginRuntime);
    });
  });

  afterEach(() => {
    cancelScheduledGeneration('proj', 'wt');
    backgroundHelperQueueTestExports.reset();
    jest.useRealTimers();
  });

  it('fires once after the debounce interval', async () => {
    scheduleSummaryGeneration('proj', 'wt', () => null);

    expect(mockedGenerateWorktreeSummary).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(30_000);
    await flushMicrotasks();

    expect(mockedGenerateWorktreeSummary).toHaveBeenCalledTimes(1);
  });

  it('does not schedule any generation under the E2E build', async () => {
    mockIsE2eBuild.mockReturnValue(true);
    scheduleSummaryGeneration('proj', 'wt', () => null);

    await jest.advanceTimersByTimeAsync(30_000);
    await flushMicrotasks();

    expect(mockedGenerateWorktreeSummary).not.toHaveBeenCalled();
  });

  it('coalesces multiple rapid schedules into one generation', async () => {
    scheduleSummaryGeneration('proj', 'wt', () => null);
    scheduleSummaryGeneration('proj', 'wt', () => null);
    scheduleSummaryGeneration('proj', 'wt', () => null);

    await jest.advanceTimersByTimeAsync(30_000);
    await flushMicrotasks();

    expect(mockedGenerateWorktreeSummary).toHaveBeenCalledTimes(1);
  });

  it('queues one follow-up run and upgrades it to full when a manual refresh arrives in flight', async () => {
    let resolveFirstRun: (result: WorktreeSummaryResult) => void = () => {};
    const firstRun = new Promise<WorktreeSummaryResult>((resolve) => {
      resolveFirstRun = resolve;
    });
    mockedGenerateWorktreeSummary
      .mockReturnValueOnce(firstRun)
      .mockResolvedValueOnce(makeSummary(2));

    scheduleSummaryGeneration('proj', 'wt', () => null);
    await jest.advanceTimersByTimeAsync(30_000);
    await flushMicrotasks();

    scheduleSummaryGeneration('proj', 'wt', () => null);
    triggerManualRefresh('proj', 'wt', () => null);
    await flushMicrotasks();

    expect(mockedGenerateWorktreeSummary).toHaveBeenCalledTimes(1);

    resolveFirstRun(makeSummary(2));
    await flushMicrotasks();

    expect(mockedGenerateWorktreeSummary).toHaveBeenCalledTimes(2);
    expect(
      mockedGenerateWorktreeSummary.mock.calls[0]?.[0]?.isFullRefresh,
    ).toBe(false);
    expect(
      mockedGenerateWorktreeSummary.mock.calls[1]?.[0]?.isFullRefresh,
    ).toBe(true);
  });

  it('bypasses debounce for manual refreshes', async () => {
    const previousSummary = makeSummaryData(1);
    const generatedSummary = makeSummaryData(2);
    mockedReadWorktreeSummary
      .mockResolvedValueOnce(previousSummary)
      .mockResolvedValueOnce(generatedSummary);

    triggerManualRefresh('proj', 'wt', () => null);
    await flushMicrotasks();

    expect(mockedGenerateWorktreeSummary).toHaveBeenCalledTimes(1);
    expect(
      mockedGenerateWorktreeSummary.mock.calls[0]?.[0]?.isFullRefresh,
    ).toBe(true);
    expect(mockedEmitWorktreeSummaryPortalDelta.mock.calls).toEqual([
      ['proj', 'wt', previousSummary, true],
      ['proj', 'wt', generatedSummary, false],
    ]);
    expect(
      mockedSendToAllWindows.mock.calls
        .filter((call) => call[0] === IPC_CHANNELS.worktreeSummaryGenerating)
        .map((call) => call[1]),
    ).toEqual([
      { projectId: 'proj', worktreeId: 'wt', generating: true },
      { projectId: 'proj', worktreeId: 'wt', generating: false },
    ]);
  });

  it('resolves configured worktree summary plugin selections', async () => {
    mockedReadPreferencesFile.mockResolvedValue(
      makePreferences({
        worktreeSummaryPluginSelections: {
          collectionIds: ['bundle-a'],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
        },
      }),
    );
    mockedWithResolvedHelperPlugins.mockImplementationOnce((_, run) => {
      const pluginRuntime: Parameters<typeof run>[0] = {
        claudePlugins: [{ type: 'local', path: '/plugins/summary' }],
        claudeMcpServers: {},
        codexCapabilityRoots: [],
        codexMcpServers: {},
      };
      Reflect.deleteProperty(pluginRuntime, 'codexCapabilityRoots');
      // Preserve the legacy runtime field this scheduler fixture supplies.
      Reflect.set(pluginRuntime, 'codexEnv', {});
      return run(pluginRuntime);
    });

    triggerManualRefresh('proj', 'wt', () => null);
    await flushMicrotasks();

    expect(mockedWithResolvedHelperPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj',
        worktreeId: 'wt',
        helperName: 'worktree-summary',
      }),
      expect.any(Function),
    );
    expect(
      mockedWithResolvedHelperPlugins.mock.calls[0]?.[0].selections
        .collectionIds,
    ).toEqual(['bundle-a']);
    expect(
      mockedGenerateWorktreeSummary.mock.calls[0]?.[0].pluginRuntime
        ?.claudePlugins,
    ).toEqual([{ type: 'local', path: '/plugins/summary' }]);
  });

  it('clears pending timers when canceled', async () => {
    scheduleSummaryGeneration('proj', 'wt', () => null);
    cancelScheduledGeneration('proj', 'wt');

    await jest.advanceTimersByTimeAsync(30_000);
    await flushMicrotasks();

    expect(mockedGenerateWorktreeSummary).not.toHaveBeenCalled();
  });

  it('leaves the previous summary file untouched when generation fails', async () => {
    mockedGenerateWorktreeSummary.mockResolvedValue({
      summary: null,
      usage: {},
    });

    triggerManualRefresh('proj', 'wt', () => null);
    await flushMicrotasks();

    expect(mockedWriteWorktreeSummary).not.toHaveBeenCalled();
  });

  it('finalizes the observed task as failure when summary generation throws', async () => {
    const previousSummary = makeSummaryData(1);
    mockedReadWorktreeSummary.mockResolvedValue(previousSummary);
    mockedGenerateWorktreeSummary.mockRejectedValue(
      new Error('network failed'),
    );

    triggerManualRefresh('proj', 'wt', () => null);
    await flushMicrotasks();

    expect(startObservedTaskMock).toHaveBeenCalledTimes(1);
    expect(finalizeObservedTaskMock).toHaveBeenCalledWith(
      expect.any(String),
      'failure',
      'network failed',
    );
    expect(mockedWriteWorktreeSummary).not.toHaveBeenCalled();
    expect(mockedEmitWorktreeSummaryPortalDelta.mock.calls).toEqual([
      ['proj', 'wt', previousSummary, true],
      ['proj', 'wt', previousSummary, false],
    ]);
    expect(
      mockedSendToAllWindows.mock.calls
        .filter((call) => call[0] === IPC_CHANNELS.worktreeSummaryGenerating)
        .map((call) => call[1]),
    ).toEqual([
      { projectId: 'proj', worktreeId: 'wt', generating: true },
      { projectId: 'proj', worktreeId: 'wt', generating: false },
    ]);
  });

  // The summary helper ships chat excerpts and the branch diff to the
  // configured model, so an org model policy has to gate it the same way it
  // gates an interactive turn.
  it('refuses the summary run and records it when an org policy blocks the model', async () => {
    const previousSummary = makeSummaryData(1);
    mockedReadWorktreeSummary.mockResolvedValue(previousSummary);
    mockIsModelBlockedByStoredPolicy.mockResolvedValue(true);

    triggerManualRefresh('proj', 'wt', () => null);
    await flushMicrotasks();

    expect(mockIsModelBlockedByStoredPolicy).toHaveBeenCalledWith(
      'claude-haiku-4-5-20251001',
    );
    expect(mockedGenerateWorktreeSummary).not.toHaveBeenCalled();
    expect(mockedWriteWorktreeSummary).not.toHaveBeenCalled();
    expect(startObservedTaskMock).toHaveBeenCalledTimes(1);
    expect(finalizeObservedTaskMock).toHaveBeenCalledWith(
      expect.any(String),
      'failure',
      'Summary generation was skipped: this model is blocked by your organization policy.',
    );
  });

  it('generates the summary normally when no policy blocks the model', async () => {
    triggerManualRefresh('proj', 'wt', () => null);
    await flushMicrotasks();

    expect(mockIsModelBlockedByStoredPolicy).toHaveBeenCalledWith(
      'claude-haiku-4-5-20251001',
    );
    expect(mockedGenerateWorktreeSummary).toHaveBeenCalledTimes(1);
    expect(mockedWriteWorktreeSummary).toHaveBeenCalledTimes(1);
  });

  it('releases the in-flight lock and emits generating false when the final summary read rejects', async () => {
    const previousSummary = makeSummaryData(1);
    mockedReadWorktreeSummary
      .mockResolvedValueOnce(previousSummary)
      .mockRejectedValueOnce(new Error('EACCES'))
      .mockResolvedValue(previousSummary);

    triggerManualRefresh('proj', 'wt', () => null);
    await flushMicrotasks();
    triggerManualRefresh('proj', 'wt', () => null);
    await flushMicrotasks();

    expect(mockedGenerateWorktreeSummary).toHaveBeenCalledTimes(2);
    expect(mockedEmitWorktreeSummaryPortalDelta.mock.calls[1]).toEqual([
      'proj',
      'wt',
      makeSummaryData(2),
      false,
    ]);
  });

  it('starts observation only after the summary leaves the helper queue', async () => {
    let releaseBlocker: (() => void) | undefined;
    const blocker = enqueueBackgroundHelperTask({
      priority: BACKGROUND_HELPER_PRIORITIES.branchNaming,
      task: () =>
        new Promise<void>((resolve) => {
          releaseBlocker = resolve;
        }),
    });
    await flushUntil(() => releaseBlocker !== undefined);

    triggerManualRefresh('proj', 'wt', () => null);
    await flushMicrotasks();

    expect(startObservedTaskMock).not.toHaveBeenCalled();

    releaseBlocker?.();
    await blocker;
    await flushUntil(() => startObservedTaskMock.mock.calls.length > 0);

    expect(startObservedTaskMock).toHaveBeenCalledTimes(1);
  });

  it('does not run a queued summary after cancellation', async () => {
    let releaseBlocker: (() => void) | undefined;
    const blocker = enqueueBackgroundHelperTask({
      priority: BACKGROUND_HELPER_PRIORITIES.branchNaming,
      task: () =>
        new Promise<void>((resolve) => {
          releaseBlocker = resolve;
        }),
    });
    await flushUntil(() => releaseBlocker !== undefined);

    triggerManualRefresh('proj', 'wt', () => null);
    await flushMicrotasks();
    cancelScheduledGeneration('proj', 'wt');

    releaseBlocker?.();
    await blocker;
    await flushMicrotasks();

    expect(startObservedTaskMock).not.toHaveBeenCalled();
    expect(mockedWithResolvedHelperPlugins).not.toHaveBeenCalled();
    expect(mockedGenerateWorktreeSummary).not.toHaveBeenCalled();
  });

  it('records codex as the provider for non-gpt worktree summary models', async () => {
    mockedReadPreferencesFile.mockResolvedValue(
      makePreferences({
        worktreeSummaryModel: 'o4-mini',
        providerModelConfigDefaults: { codex: { fastMode: true } },
      }),
    );

    triggerManualRefresh('proj', 'wt', () => null);
    await flushMicrotasks();

    expect(startObservedTaskMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        provider: 'codex',
        model: 'o4-mini',
        serviceTier: 'priority',
      }),
    );
    expect(mockedGenerateWorktreeSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'o4-mini',
        modelConfig: { speed: 'fast', fastMode: true, thinkingLevel: 'off' },
      }),
    );
  });

  it('builds bounded excerpts from explicit chat pages without reading unloaded bodies', async () => {
    const loaded = makeChatTabs(2);
    const metadata = {
      ...loaded.tabs[0],
      transcript: {
        format: 'complete-message-jsonl-v1' as const,
        committedMessageCount: 1002,
        committedByteLength: 90000000,
        transcriptRevision: 2,
        hasActiveSidecar: false,
        messageCount: 1002,
        userMessageCount: 501,
      },
    };
    Object.defineProperty(metadata, 'messages', {
      enumerable: false,
      get: () => {
        throw new Error('Unselected transcript');
      },
    });
    mockedReadChatTabsFile.mockImplementation(
      (_project, _worktree, selection) =>
        Promise.resolve(
          selection?.chatIds?.includes(metadata.id)
            ? loaded
            : { ...loaded, tabs: [metadata] },
        ),
    );
    mockedReadWorktreeSummary.mockResolvedValue(null);
    scheduleSummaryGeneration('proj', 'wt', () => null);
    await jest.advanceTimersByTimeAsync(30_000);
    await flushMicrotasks();
    expect(
      mockedGenerateWorktreeSummary.mock.calls[0]?.[0].chatExcerpts,
    ).toContain('Assistant reply 2');
    expect(mockedReadChatTabsFile).toHaveBeenCalledWith('proj', 'wt', {
      chatIds: ['tab-1'],
      pageOnly: true,
    });
  });

  it('links cowork summary tasks to a resolvable chat in the Work Entry', async () => {
    mockIsCoworkWorkspace.mockReturnValue(true);
    const chatTabs = makeChatTabs(2);
    mockedReadChatTabsFile.mockResolvedValue({
      ...chatTabs,
      activeTabId: 'file-tab',
      tabs: [
        ...chatTabs.tabs,
        {
          id: 'file-tab',
          title: 'notes.md',
          createdAt: '2026-03-25T10:00:00.000Z',
          kind: 'file',
          filePath: '/repo/notes.md',
          messages: [],
        },
      ],
    });

    triggerManualRefresh('cowork-project', 'entry-1', () => null);
    await flushUntil(() => startObservedTaskMock.mock.calls.length > 0);

    expect(startObservedTaskMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        projectId: 'cowork-project',
        worktreeId: 'entry-1',
        linkTarget: {
          page: 'chat',
          kind: 'standalone-chat',
          worktreeId: 'cowork-project',
          chatId: 'tab-1',
        },
      }),
    );
  });

  it('skips the updated event when the worktree disappears before persistence', async () => {
    mockedWriteWorktreeSummary.mockResolvedValue(null);

    triggerManualRefresh('proj', 'wt', () => null);
    await flushMicrotasks();

    const updatedCalls = mockedSendToAllWindows.mock.calls.filter(
      (call) => call[0] === IPC_CHANNELS.worktreeSummaryUpdated,
    );
    expect(updatedCalls).toHaveLength(0);
  });

  it('short-circuits scheduled and manual refreshes when disabled', async () => {
    mockedReadPreferencesFile.mockResolvedValue(
      makePreferences({ worktreeSummaryEnabled: false }),
    );

    scheduleSummaryGeneration('proj', 'wt', () => null);
    await jest.advanceTimersByTimeAsync(30_000);
    await flushMicrotasks();
    triggerManualRefresh('proj', 'wt', () => null);
    await flushMicrotasks();

    expect(mockedGenerateWorktreeSummary).not.toHaveBeenCalled();
    const generatingCalls = mockedSendToAllWindows.mock.calls.filter(
      (call) => call[0] === IPC_CHANNELS.worktreeSummaryGenerating,
    );
    expect(generatingCalls).toHaveLength(0);
  });

  it('uses chronological turn ordering across tabs for incremental excerpts', async () => {
    mockedReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'tab-a',
      tabs: [
        {
          id: 'tab-a',
          title: 'Tab A',
          createdAt: '2026-03-25T10:00:00.000Z',
          messages: [
            {
              id: 'a-user-1',
              role: 'user',
              timestamp: 1,
              blocks: [{ type: 'text', text: 'Tab A turn 1' }],
            },
            {
              id: 'a-assistant-1',
              role: 'assistant',
              timestamp: 2,
              blocks: [{ type: 'text', text: 'Tab A reply 1' }],
            },
            {
              id: 'a-user-2',
              role: 'user',
              timestamp: 7,
              blocks: [{ type: 'text', text: 'Tab A turn 4' }],
            },
            {
              id: 'a-assistant-2',
              role: 'assistant',
              timestamp: 8,
              blocks: [{ type: 'text', text: 'Tab A reply 4' }],
            },
          ],
        },
        {
          id: 'tab-b',
          title: 'Tab B',
          createdAt: '2026-03-25T10:05:00.000Z',
          messages: [
            {
              id: 'b-user-1',
              role: 'user',
              timestamp: 3,
              blocks: [{ type: 'text', text: 'Tab B turn 2' }],
            },
            {
              id: 'b-assistant-1',
              role: 'assistant',
              timestamp: 4,
              blocks: [{ type: 'text', text: 'Tab B reply 2' }],
            },
            {
              id: 'b-user-2',
              role: 'user',
              timestamp: 5,
              blocks: [{ type: 'text', text: 'Tab B turn 3' }],
            },
            {
              id: 'b-assistant-2',
              role: 'assistant',
              timestamp: 6,
              blocks: [{ type: 'text', text: 'Tab B reply 3' }],
            },
          ],
        },
      ],
    });
    mockedReadWorktreeSummary.mockResolvedValue(makeSummaryData(2));

    scheduleSummaryGeneration('proj', 'wt', () => null);
    await jest.advanceTimersByTimeAsync(30_000);
    await flushMicrotasks();

    const summaryRequest = mockedGenerateWorktreeSummary.mock.calls[0]?.[0];
    expect(summaryRequest?.isFullRefresh).toBe(false);
    expect(summaryRequest?.chatExcerpts).toContain('Tab B turn 3');
    expect(summaryRequest?.chatExcerpts).toContain('Tab B reply 3');
    expect(summaryRequest?.chatExcerpts).toContain('Tab A turn 4');
    expect(summaryRequest?.chatExcerpts).toContain('Tab A reply 4');
    expect(summaryRequest?.chatExcerpts).not.toContain('Tab B turn 2');
    expect(summaryRequest?.chatExcerpts).not.toContain('Tab B reply 2');
  });

  it('includes the project root repo when building source-backed multi-repo summaries', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(true);
    mockedReadEffectiveWorkspaceConfig.mockResolvedValue(
      makeEffectiveWorkspaceConfig({
        sourceRepoPath: '/source/workspace',
        repos: [
          {
            id: 'api',
            name: 'API',
            repoPath: '/repos/api',
          },
        ],
      }),
    );
    mockedGetRemoteDefaultBranch.mockImplementation(
      (repoPath: string): Promise<string> =>
        Promise.resolve(repoPath === '/repo' ? 'main' : 'develop'),
    );
    mockedGetComparisonDiff.mockImplementation(
      (repoPath: string): Promise<string> =>
        Promise.resolve(repoPath === '/repo' ? 'root diff' : 'api diff'),
    );

    triggerManualRefresh('proj', 'wt', () => null);
    await flushMicrotasks();

    const summaryRequest = mockedGenerateWorktreeSummary.mock.calls[0]?.[0];
    expect(summaryRequest?.isMultiRepo).toBe(true);
    expect(summaryRequest?.gitDiff).toContain(`## ${WORKSPACE_ROOT_REPO_NAME}`);
    expect(summaryRequest?.gitDiff).toContain('root diff');
    expect(summaryRequest?.gitDiff).toContain('## API');
    expect(summaryRequest?.gitDiff).toContain('api diff');
    expect(summaryRequest?.repoDiffs?.map((repoDiff) => repoDiff.name)).toEqual(
      [WORKSPACE_ROOT_REPO_NAME, 'API'],
    );
  });

  describe('Summary publication (phase 09)', () => {
    it('captures the helper details before the provider runs', async () => {
      mockLedgerEnabled.mockReturnValue(true);

      triggerManualRefresh('proj', 'wt', () => null);
      await flushMicrotasks();

      const taskKey =
        mockedGenerateWorktreeSummary.mock.calls[0]?.[0].observabilityTaskKey;
      const provenance = mockedWriteWorktreeSummary.mock.calls[0]?.[3];
      const anyUuid: unknown = expect.stringMatching(/^[0-9a-f-]{36}$/);
      const anyTime: unknown = expect.any(String);
      expect(provenance).toEqual({
        generationId: anyUuid,
        harness: 'claude',
        model: 'claude-haiku-4-5-20251001',
        thinkingEffort: 'off',
        observedTaskKey: taskKey,
        capturedAt: anyTime,
        ledgerPublishable: true,
      });
    });

    it('publishes a new snapshot, in order with any earlier pending one', async () => {
      mockLedgerEnabled.mockReturnValue(true);

      triggerManualRefresh('proj', 'wt', () => null);
      await flushMicrotasks();

      expect(mockedPublishPending).toHaveBeenCalledWith({
        projectId: 'proj',
        worktreeId: 'wt',
      });
    });

    it('marks nothing publishable and publishes nothing with the Ledger off', async () => {
      triggerManualRefresh('proj', 'wt', () => null);
      await flushMicrotasks();

      expect(mockedWriteWorktreeSummary.mock.calls[0]?.[3]).not.toHaveProperty(
        'ledgerPublishable',
      );
      expect(mockedPublishPending).not.toHaveBeenCalled();
    });

    it('publishes nothing for an unchanged summary', async () => {
      mockLedgerEnabled.mockReturnValue(true);
      mockedWriteWorktreeSummary.mockImplementation(
        (_projectId, _worktreeId, summary, provenance) =>
          Promise.resolve({
            ...newSnapshotWrite(summary, provenance),
            isNewSnapshot: false,
          }),
      );

      triggerManualRefresh('proj', 'wt', () => null);
      await flushMicrotasks();

      expect(mockedWriteWorktreeSummary).toHaveBeenCalledTimes(1);
      expect(mockedPublishPending).not.toHaveBeenCalled();
    });

    it('publishes nothing for a failed generation', async () => {
      mockLedgerEnabled.mockReturnValue(true);
      mockedGenerateWorktreeSummary.mockResolvedValue({
        summary: null,
        usage: {},
      });

      triggerManualRefresh('proj', 'wt', () => null);
      await flushMicrotasks();

      expect(mockedWriteWorktreeSummary).not.toHaveBeenCalled();
      expect(mockedPublishPending).not.toHaveBeenCalled();
    });

    it('still publishes a snapshot written before the run was cancelled', async () => {
      mockLedgerEnabled.mockReturnValue(true);
      mockedWriteWorktreeSummary.mockImplementation(
        (projectId, worktreeId, summary, provenance) => {
          cancelScheduledGeneration(projectId, worktreeId);
          return Promise.resolve(newSnapshotWrite(summary, provenance));
        },
      );

      triggerManualRefresh('proj', 'wt', () => null);
      await flushMicrotasks();

      expect(mockedPublishPending).toHaveBeenCalledTimes(1);
      expect(
        mockedSendToAllWindows.mock.calls.filter(
          (call) => call[0] === IPC_CHANNELS.worktreeSummaryUpdated,
        ),
      ).toHaveLength(0);
    });

    it('reports publishable snapshots the history cap dropped', async () => {
      mockLedgerEnabled.mockReturnValue(true);
      mockedWriteWorktreeSummary.mockImplementation(
        (_projectId, _worktreeId, summary, provenance) =>
          Promise.resolve({
            ...newSnapshotWrite(summary, provenance),
            droppedPublishableSnapshotIds: ['snapshot-old'],
          }),
      );

      triggerManualRefresh('proj', 'wt', () => null);
      await flushMicrotasks();

      expect(mockedReportDropped).toHaveBeenCalledWith(
        { projectId: 'proj', worktreeId: 'wt' },
        ['snapshot-old'],
      );
      expect(mockedReportReplaced).not.toHaveBeenCalled();
    });

    it('reports a summary file that did not parse and was replaced', async () => {
      mockLedgerEnabled.mockReturnValue(true);
      mockedWriteWorktreeSummary.mockImplementation(
        (_projectId, _worktreeId, summary, provenance) =>
          Promise.resolve({
            ...newSnapshotWrite(summary, provenance),
            replacedCorruptFile: true,
          }),
      );

      triggerManualRefresh('proj', 'wt', () => null);
      await flushMicrotasks();

      expect(mockedReportReplaced).toHaveBeenCalledWith({
        projectId: 'proj',
        worktreeId: 'wt',
      });
      // The new snapshot still publishes.
      expect(mockedPublishPending).toHaveBeenCalledTimes(1);
    });

    it('reports what the write discarded from the history it read', async () => {
      mockLedgerEnabled.mockReturnValue(true);
      mockedWriteWorktreeSummary.mockImplementation(
        (_projectId, _worktreeId, summary, provenance) =>
          Promise.resolve({
            ...newSnapshotWrite(summary, provenance),
            strippedPublishableSnapshotIds: ['snapshot-stripped'],
            droppedInvalidSnapshotCount: 2,
          }),
      );

      triggerManualRefresh('proj', 'wt', () => null);
      await flushMicrotasks();

      const scope = { projectId: 'proj', worktreeId: 'wt' };
      expect(mockedReportStripped).toHaveBeenCalledWith(scope, [
        'snapshot-stripped',
      ]);
      expect(mockedReportInvalid).toHaveBeenCalledWith(scope, 2);
      expect(mockedPublishPending).toHaveBeenCalledTimes(1);
    });

    it.each(['unreadable', 'future_version'] as const)(
      'reports a write aborted because the file is %s, and publishes nothing',
      async (reason) => {
        mockLedgerEnabled.mockReturnValue(true);
        mockedWriteWorktreeSummary.mockResolvedValue({
          kind: 'aborted',
          reason,
        });

        triggerManualRefresh('proj', 'wt', () => null);
        await flushMicrotasks();

        expect(mockedReportAborted).toHaveBeenCalledWith(
          { projectId: 'proj', worktreeId: 'wt' },
          reason,
        );
        expect(mockedPublishPending).not.toHaveBeenCalled();
        expect(
          mockedSendToAllWindows.mock.calls.filter(
            (call) => call[0] === IPC_CHANNELS.worktreeSummaryUpdated,
          ),
        ).toHaveLength(0);
      },
    );

    it.each(['unreadable', 'future_version'] as const)(
      'generates nothing over a summary file that is %s',
      async (reason) => {
        mockLedgerEnabled.mockReturnValue(true);
        mockedReadWriteAbortReason.mockResolvedValue(reason);

        triggerManualRefresh('proj', 'wt', () => null);
        await flushMicrotasks();

        expect(mockedReportAborted).toHaveBeenCalledTimes(1);
        expect(mockedReportAborted).toHaveBeenCalledWith(
          { projectId: 'proj', worktreeId: 'wt' },
          reason,
        );
        expect(mockedGenerateWorktreeSummary).not.toHaveBeenCalled();
        expect(mockedWriteWorktreeSummary).not.toHaveBeenCalled();
        expect(
          mockedSendToAllWindows.mock.calls.filter(
            (call) => call[0] === IPC_CHANNELS.worktreeSummaryGenerating,
          ),
        ).toHaveLength(0);
      },
    );
  });

  describe('cadence while the Ledger is on (LD05)', () => {
    beforeEach(() => {
      mockLedgerEnabled.mockReturnValue(true);
    });

    it('waits five quiet minutes instead of thirty seconds', async () => {
      scheduleSummaryGeneration('proj', 'wt', () => null);

      await jest.advanceTimersByTimeAsync(30_000);
      await flushMicrotasks();
      expect(mockedGenerateWorktreeSummary).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(LEDGER_SUMMARY_QUIET_MS - 30_000);
      await flushMicrotasks();
      expect(mockedGenerateWorktreeSummary).toHaveBeenCalledTimes(1);
    });

    it('restarts on each completed turn but runs by the maximum wait', async () => {
      const turnEveryMs = LEDGER_SUMMARY_QUIET_MS - 60_000;
      scheduleSummaryGeneration('proj', 'wt', () => null);
      let elapsedMs = 0;
      while (elapsedMs + turnEveryMs < LEDGER_SUMMARY_MAX_WAIT_MS) {
        await jest.advanceTimersByTimeAsync(turnEveryMs);
        elapsedMs += turnEveryMs;
        expect(mockedGenerateWorktreeSummary).not.toHaveBeenCalled();
        scheduleSummaryGeneration('proj', 'wt', () => null);
      }

      await jest.advanceTimersByTimeAsync(
        LEDGER_SUMMARY_MAX_WAIT_MS - elapsedMs - 1,
      );
      await flushMicrotasks();
      expect(mockedGenerateWorktreeSummary).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1);
      await flushMicrotasks();
      expect(mockedGenerateWorktreeSummary).toHaveBeenCalledTimes(1);
    });

    it('defers while a turn is running, up to the maximum wait', async () => {
      scheduleSummaryGeneration('proj', 'wt', () => null);
      mockTurnRunning.mockReturnValue(true);

      await jest.advanceTimersByTimeAsync(LEDGER_SUMMARY_QUIET_MS);
      await flushMicrotasks();
      expect(mockTurnRunning).toHaveBeenCalledWith('proj', 'wt');
      expect(mockedGenerateWorktreeSummary).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(
        LEDGER_SUMMARY_MAX_WAIT_MS - LEDGER_SUMMARY_QUIET_MS,
      );
      await flushMicrotasks();
      expect(mockedGenerateWorktreeSummary).toHaveBeenCalledTimes(1);
    });

    it('runs a quiet period after the deferring turn completes', async () => {
      scheduleSummaryGeneration('proj', 'wt', () => null);
      mockTurnRunning.mockReturnValue(true);
      await jest.advanceTimersByTimeAsync(LEDGER_SUMMARY_QUIET_MS);

      mockTurnRunning.mockReturnValue(false);
      scheduleSummaryGeneration('proj', 'wt', () => null);
      await jest.advanceTimersByTimeAsync(LEDGER_SUMMARY_QUIET_MS - 1);
      await flushMicrotasks();
      expect(mockedGenerateWorktreeSummary).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1);
      await flushMicrotasks();
      expect(mockedGenerateWorktreeSummary).toHaveBeenCalledTimes(1);
    });

    it('keeps manual refresh immediate', async () => {
      scheduleSummaryGeneration('proj', 'wt', () => null);
      triggerManualRefresh('proj', 'wt', () => null);
      await flushMicrotasks();

      expect(mockedGenerateWorktreeSummary).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(LEDGER_SUMMARY_MAX_WAIT_MS);
      await flushMicrotasks();
      expect(mockedGenerateWorktreeSummary).toHaveBeenCalledTimes(1);
    });
  });
});
