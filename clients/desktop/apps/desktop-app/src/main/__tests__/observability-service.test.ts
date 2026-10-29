import { publishOpenCodeAccounts } from '../opencode/account-information';
import type {
  AccountProxyUsageInventoryEntry,
  AccountProxyUsageReadResult,
} from '../account-proxy/usage';
const mockProxyUsageInventory = jest.fn<
  readonly AccountProxyUsageInventoryEntry[],
  []
>(() => []);
const mockProxyUsageRead = jest.fn<
  Promise<AccountProxyUsageReadResult>,
  [AccountProxyUsageInventoryEntry, AbortSignal?]
>();
const mockProxyInventoryListeners = new Set<() => void>();
const mockPublishProxyStatus = jest.fn((): Promise<void> => Promise.resolve());
jest.mock('../account-proxy/service', () => ({
  getAccountProxyUsageInventory: mockProxyUsageInventory,
  fetchAccountProxyUsage: mockProxyUsageRead,
  onAccountProxyInventoryChanged: (listener: () => void): (() => void) => {
    mockProxyInventoryListeners.add(listener);
    return (): void => {
      mockProxyInventoryListeners.delete(listener);
    };
  },
  publishAccountProxyStatus: mockPublishProxyStatus,
}));
const mockReadCopilotUsage = jest.fn();
const mockCopilotEnabled = jest.fn(() => false);
const mockLogMainProcessWarn = jest.fn();
jest.mock('../copilot/account-usage', () => ({
  readCopilotUsageSummary: mockReadCopilotUsage,
}));
jest.mock('../copilot/feature-flag', () => ({
  isCopilotHarnessEnabled: mockCopilotEnabled,
}));
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: mockLogMainProcessWarn,
}));
import { notifyCopilotUsageChanged } from '../copilot/usage-events';
import type { CostHistoryRepairOptions } from '../observability/cost-history-repair';
import { CursorEventProjection } from '@canopy/desktop-shared/node/cursor/events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';
import type { SessionDiagnosticRecord } from '../observability/service';
const readCursorAccountUsageMock = jest.fn<Promise<unknown>, [AbortSignal]>();
jest.mock('../cursor/account-usage', () => ({
  readCursorAccountUsage: readCursorAccountUsageMock,
}));
const mockCursorEnabled = jest.fn(() => true);
const mockFlagListeners = new Set<() => void>();
jest.mock('../cursor/feature-flag', () => ({
  isCursorHarnessEnabled: mockCursorEnabled,
}));
jest.mock('../feature-flags', () => ({
  getFeatureFlagService: (): {
    onSnapshotChanged(listener: () => void): () => void;
  } => ({
    onSnapshotChanged: (listener: () => void): (() => void) => {
      mockFlagListeners.add(listener);
      return (): void => {
        mockFlagListeners.delete(listener);
      };
    },
  }),
}));
import { parseAgentTranscriptLines } from '@canopy/agent-transcript';
jest.mock('node:fs/promises', () => ({
  appendFile: jest.fn(),
  mkdir: jest.fn(),
  readFile: jest.fn(),
  readdir: jest.fn(),
  rename: jest.fn(),
  rm: jest.fn(),
  stat: jest.fn(),
  writeFile: jest.fn(),
}));

const execFileMock = jest.fn();
const fetchMock = jest.fn<
  Promise<Response>,
  [RequestInfo | URL, RequestInit?]
>();

jest.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

const readAccountMock = jest.fn();
const readRateLimitsMock = jest.fn();
const onAccountUpdatedMock = jest.fn();
const onRateLimitsUpdatedMock = jest.fn();
const disposeCodexMonitorMock = jest.fn();
interface MockCodexAdminClient {
  readAccount(refreshToken?: boolean): unknown;
  readRateLimits(): unknown;
  onAccountUpdated(listener: () => void): void;
  onRateLimitsUpdated(listener: () => void): void;
  dispose(): void;
}

const mockCodexAppServerClient = jest.fn<MockCodexAdminClient, []>();
const mockCaptureDesktopInstrumentationError = jest.fn<
  void,
  [unknown, { context?: Record<string, unknown> }?]
>();
const mockStartDesktopOperation = jest.fn<
  void,
  [string, { context?: Record<string, unknown>; operationKey?: string }?]
>();
const mockSucceedDesktopOperation = jest.fn<
  void,
  [string, { context?: Record<string, unknown>; operationKey?: string }?]
>();
const mockFailDesktopOperation = jest.fn<
  void,
  [
    string,
    string,
    { context?: Record<string, unknown>; operationKey?: string }?,
  ]
>();
const mockGetOpenAiPricingForCostingSync = jest.fn(() => ({
  loadedFrom: 'none',
  stale: true,
}));
const mockPrewarmOpenAiPricingCache = jest.fn();
const mockRunCostHistoryRepair = jest.fn<
  Promise<{
    claudeRepaired: number;
    claudeSkippedNoTranscript: number;
    codexDelegationsPriced: number;
    skipped: boolean;
  }>,
  [CostHistoryRepairOptions]
>(() =>
  Promise.resolve({
    claudeRepaired: 0,
    claudeSkippedNoTranscript: 0,
    codexDelegationsPriced: 0,
    skipped: false,
  }),
);

jest.mock('@canopy/desktop-instrumentation', () => ({
  createDesktopInstrumentationOperationKey: jest.fn(
    (value: string) => `op-${value}`,
  ),
}));

jest.mock('@canopy/desktop-instrumentation/electron/main', () => ({
  captureDesktopInstrumentationError: mockCaptureDesktopInstrumentationError,
  startDesktopOperation: mockStartDesktopOperation,
  succeedDesktopOperation: mockSucceedDesktopOperation,
  failDesktopOperation: mockFailDesktopOperation,
}));

interface CitationTrackingOptions {
  auditEntryId: string;
  provider: string;
  transcriptLines: string[];
}

const mockTrackCompletedTurnLocalMemoryCitations = jest.fn<
  Promise<void>,
  [CitationTrackingOptions]
>(() => Promise.resolve());
const mockIsLocalMemoryCitationTrackingEnabled = jest.fn<Promise<boolean>, []>(
  () => Promise.resolve(true),
);

jest.mock('../memory/local/citation-tracking', () => ({
  isLocalMemoryCitationTrackingEnabled: (): Promise<boolean> =>
    mockIsLocalMemoryCitationTrackingEnabled(),
  trackCompletedTurnLocalMemoryCitations: (
    options: CitationTrackingOptions,
  ): Promise<void> => mockTrackCompletedTurnLocalMemoryCitations(options),
}));

jest.mock('../codex/runtime-service', () => ({
  getCodexRuntimeService: jest.fn(() => ({
    admin: (): {
      request(method: string, params?: unknown): unknown;
      onAccountUpdated(listener: () => void): () => void;
      onRateLimitsUpdated(listener: () => void): () => void;
    } => {
      const client = mockCodexAppServerClient();
      return {
        request: (method: string, params?: unknown): unknown => {
          if (method === 'account/read') {
            return client.readAccount(
              (params as { refreshToken?: boolean } | undefined)?.refreshToken,
            );
          }
          if (method === 'account/rateLimits/read') {
            return client.readRateLimits();
          }
          throw new Error(`Unexpected Codex admin request: ${method}`);
        },
        onAccountUpdated: (listener: () => void): (() => void) => {
          client.onAccountUpdated(listener);
          return () => {};
        },
        onRateLimitsUpdated: (listener: () => void): (() => void) => {
          client.onRateLimitsUpdated(listener);
          return () => client.dispose();
        },
      };
    },
  })),
}));

jest.mock('../lib/paths', () => ({
  getAgentObservabilityAppEventsDayFilePath: jest.fn(
    (day: string) => `/mock/observability/diagnostics/app-events/${day}.jsonl`,
  ),
  getAgentObservabilityAppEventsDir: jest.fn(
    () => '/mock/observability/diagnostics/app-events',
  ),
  getAgentObservabilityAuditDayFilePath: jest.fn(
    (day: string) => `/mock/observability/${day}.jsonl`,
  ),
  getAgentObservabilityAuditDir: jest.fn(() => '/mock/observability'),
  getAgentObservabilityUsageEventsDayFilePath: jest.fn(
    (day: string) => `/mock/observability/usage-events/${day}.jsonl`,
  ),
  getAgentObservabilityUsageEventsDir: jest.fn(
    () => '/mock/observability/usage-events',
  ),
  getAgentObservabilitySessionEventsDayFilePath: jest.fn(
    (day: string) =>
      `/mock/observability/diagnostics/session-events/${day}.jsonl`,
  ),
  getAgentObservabilitySessionEventsDir: jest.fn(
    () => '/mock/observability/diagnostics/session-events',
  ),
  getAgentObservabilitySnapshotPath: jest.fn(
    () => '/mock/observability/snapshot.json',
  ),
  getAgentObservabilityTranscriptDayDir: jest.fn(
    (day: string) => `/mock/observability/transcripts/${day}`,
  ),
  getAgentObservabilityTranscriptFilePath: jest.fn(
    (request: { eventType: string; startedAt: string; id: string }) =>
      `/mock/observability/transcripts/${request.startedAt.slice(0, 10)}/${request.eventType}-${request.id
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/^-+|-+$/g, '')}.jsonl`,
  ),
  getAgentObservabilityTranscriptIndexDayFilePath: jest.fn(
    (day: string) => `/mock/observability/transcript-index/${day}.jsonl`,
  ),
  getAgentObservabilityTranscriptIndexDir: jest.fn(
    () => '/mock/observability/transcript-index',
  ),
  getAgentObservabilityTranscriptsDir: jest.fn(
    () => '/mock/observability/transcripts',
  ),
}));

jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(),
}));

jest.mock('../pipelines/config-paths', () => ({
  getBundledClaudeBinaryPath: jest.fn(() => '/mock/bin/claude'),
  getEnhancedEnv: jest.fn(() => ({ PATH: '/mock/bin' })),
}));

jest.mock('../observability/cost-history-repair', () => ({
  runCostHistoryRepair: mockRunCostHistoryRepair,
}));

jest.mock('../openai-pricing/pricing-client', () => ({
  getOpenAiPricingForCostingSync: mockGetOpenAiPricingForCostingSync,
  prewarmOpenAiPricingCache: mockPrewarmOpenAiPricingCache,
}));

import type {
  AgentAuditEntry,
  AgentAuditTranscriptResponse,
  AgentObservabilityUpdateEvent,
  PipelineRunUsageEvent,
  PreferencesData,
  UsageMetricEvent,
  UsageTimeseriesRequest,
} from '@canopy/desktop-shared/types';
import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  DEFAULT_HIDE_ANTHROPIC_NAV,
  getAiGatewayModelEntries,
  getGatewayModelEntries,
  initAiGatewayModels,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import { CANOPY_AUTH_FAILURE_EVENT_TYPE } from '@canopy/protocol/auth-recovery';
import { projectCodexRuntimeEvent } from '@canopy/desktop-shared/node/codex-runtime';
import type { StepResult } from '@canopy/desktop-shared/node/pipelines/executor';
import { readPreferencesFile } from '../lib/preferences-store';
import { getEnhancedEnv } from '../pipelines/config-paths';
import {
  commandLooksLikePrCreate,
  ObservabilityService,
  resolveAuditContextWorkspaceId,
} from '../observability/service';
import * as providerAuthState from '../auth/provider-auth-state';

const mockedCheckClaudeAuthStatusObserved = jest.spyOn(
  providerAuthState,
  'checkClaudeAuthStatusObserved',
);
const mockedWarmProviderAccountIdentity = jest
  .spyOn(providerAuthState, 'warmProviderAccountIdentity')
  .mockImplementation(() => undefined);

interface FsPromisesMock {
  appendFile: jest.Mock<Promise<void>, [unknown, unknown]>;
  mkdir: jest.Mock<Promise<void>, [unknown, unknown?]>;
  readFile: jest.Mock<Promise<string>, [unknown, unknown?]>;
  readdir: jest.Mock<Promise<string[]>, [unknown]>;
  rename: jest.Mock<Promise<void>, [unknown, unknown]>;
  rm: jest.Mock<Promise<void>, [unknown, unknown?]>;
  stat: jest.Mock<Promise<{ size: number }>, [unknown]>;
  writeFile: jest.Mock<Promise<void>, [unknown, unknown, unknown?]>;
}

const fsPromisesMock = jest.requireMock<FsPromisesMock>('node:fs/promises');
const mockedAppendFile = fsPromisesMock.appendFile;
const mockedMkdir = fsPromisesMock.mkdir;
const mockedReadFile = fsPromisesMock.readFile;
const mockedReaddir = fsPromisesMock.readdir;
const mockedRename = fsPromisesMock.rename;
const mockedRm = fsPromisesMock.rm;
const mockedStat = fsPromisesMock.stat;
const mockedWriteFile = fsPromisesMock.writeFile;
const mockedReadPreferencesFile = jest.mocked(readPreferencesFile);

describe('Cursor account usage overview', () => {
  beforeEach(() => {
    readCursorAccountUsageMock.mockReset();
    mockedReadPreferencesFile.mockResolvedValue({
      ...makePreferences(30),
      cursorEnabled: true,
    });
  });
  it('publishes current Cursor account allowance through the shared overview', async () => {
    const service = new ObservabilityService();
    mockedReadPreferencesFile.mockResolvedValue({
      ...makePreferences(30),
      cursorEnabled: true,
    });
    readCursorAccountUsageMock.mockResolvedValue({
      provider: 'cursor',
      authState: 'authenticated',
      hasRemainingLimits: true,
      accountEmail: 'cursor@example.com',
      subscriptionLabel: 'Pro',
      rateLimits: [{ limitId: 'cursor-plan', primary: { usedPercent: 75 } }],
    });
    await service.refreshProviderUsage('cursor');
    expect(service.loadSnapshot().usage.providers).toContainEqual(
      expect.objectContaining({
        provider: 'cursor',
        accountEmail: 'cursor@example.com',
        rateLimits: [{ limitId: 'cursor-plan', primary: { usedPercent: 75 } }],
      }),
    );
  });

  it('deduplicates concurrent refreshes and discards an older account after disconnect', async () => {
    const service = new ObservabilityService();
    let finish: (value: unknown) => void = () => {};
    readCursorAccountUsageMock.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const first = service.refreshProviderUsage('cursor');
    const second = service.refreshProviderUsage('cursor');
    await new Promise((resolve) => setImmediate(resolve));
    expect(readCursorAccountUsageMock).toHaveBeenCalledTimes(1);
    service.invalidateCursorUsage();
    finish({
      provider: 'cursor',
      authState: 'authenticated',
      hasRemainingLimits: true,
      accountEmail: 'old@example.com',
    });
    await Promise.all([first, second]);
    expect(
      service
        .loadSnapshot()
        .usage.providers.some((entry) => entry.provider === 'cursor'),
    ).toBe(false);
    readCursorAccountUsageMock.mockResolvedValue({
      provider: 'cursor',
      authState: 'authenticated',
      hasRemainingLimits: false,
      accountEmail: 'new@example.com',
    });
    await service.refreshProviderUsage('cursor');
    expect(
      service
        .loadSnapshot()
        .usage.providers.find((entry) => entry.provider === 'cursor')
        ?.accountEmail,
    ).toBe('new@example.com');
  });

  it('does not load Cursor authentication for disabled connections', async () => {
    const service = new ObservabilityService();
    mockedReadPreferencesFile.mockResolvedValue({
      ...makePreferences(30),
      cursorEnabled: false,
    });
    await service.refreshProviderUsage('cursor');
    expect(readCursorAccountUsageMock).not.toHaveBeenCalled();
  });
});
const mockedGetEnhancedEnv = jest.mocked(getEnhancedEnv);
const originalFetch = globalThis.fetch;

function makePreferences(auditRetentionDays: number): PreferencesData {
  return {
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
    pipelineAdvisorEnabled: true,
    pipelineAdvisorModel: 'gpt-6-luna',
    pipelineAdvisorThinkingLevel: 'high',
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
    auditRetentionDays,
    lastOpenApp: '',
    disabledOpenApps: [],
    lastSelectedWorktreeProjectId: '',
    lastSelectedWorktreeId: '',
    executionDetailViewMode: 'list',
    worktreeViewMode: 'list',
    worktreeFilterHiddenWorkspaceIds: [],
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
    },
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
    voiceDictationEnabled: true,
    mcpHttpAuthDefaultHandler: 'canopy',
    fileIndexing: {
      disabledBuiltinGlobIds: [],
      customGlobs: [],
    },
    autoDownloadUpdates: true,
    showDiagnosticsPill: true,
  };
}

function makeRunningPipelineState(): Parameters<
  ObservabilityService['syncPipelineExecutionState']
>[0] {
  return {
    id: 'exec-1',
    pipeline_id: 'pipeline-1',
    pipeline_snapshot: { name: 'Pipeline' },
    project_id: 'proj',
    worktree_id: 'wt',
    jobs: {
      job1: {
        status: 'running',
        outputs: {},
        steps: {
          step1: {
            status: 'running',
            outputs: {},
            dynamic_env: {},
            started_at: '2026-03-26T10:00:00.000Z',
            log_format_hint: 'agent',
            agent_provider: 'claude',
            agent_model: 'claude-sonnet-4-6',
          },
        },
      },
    },
  };
}

function makeCompletedPipelineState(): Parameters<
  ObservabilityService['syncPipelineExecutionState']
>[0] {
  return {
    id: 'exec-1',
    pipeline_id: 'pipeline-1',
    pipeline_snapshot: { name: 'Pipeline' },
    project_id: 'proj',
    worktree_id: 'wt',
    jobs: {
      job1: {
        status: 'success',
        outputs: {},
        steps: {
          step1: {
            status: 'success',
            outputs: {},
            dynamic_env: {},
            started_at: '2026-03-26T10:00:00.000Z',
            completed_at: '2026-03-26T10:01:00.000Z',
            log_format_hint: 'agent',
            agent_provider: 'claude',
            agent_model: 'claude-sonnet-4-6',
          },
        },
      },
    },
  };
}

// Session totals are durable production state, but each test owns its ledger.
import * as claudeCostLedger from '../observability/claude-session-cost-ledger';
beforeEach(() => {
  const ledger = new claudeCostLedger.ClaudeSessionCostLedger({
    filePath: '/audit/test-claude-session-costs.json',
    persistDelayMs: 0,
  });
  jest.spyOn(ledger, 'flush').mockResolvedValue(undefined);
  jest
    .spyOn(claudeCostLedger, 'getClaudeSessionCostLedger')
    .mockReturnValue(ledger);
});

function loadOnlyRecentEntry(service: ObservabilityService): AgentAuditEntry {
  const [entry] = service.loadSnapshot().recentEntries;
  if (!entry) {
    throw new Error('Expected a recent observability entry');
  }
  return entry;
}

function loadRecentEntryForChat(
  service: ObservabilityService,
  chatId: string,
  worktreeId = 'wt',
): AgentAuditEntry {
  const entry = service
    .loadSnapshot()
    .recentEntries.find(
      (candidate) =>
        candidate.chatId === chatId && candidate.worktreeId === worktreeId,
    );
  if (!entry) {
    throw new Error(`Expected an observability entry for chat ${chatId}`);
  }
  return entry;
}

function startClaudeChatTurn(
  service: ObservabilityService,
  chatId = 'chat',
  worktreeId = 'wt',
): void {
  service.beginClaudeQuery(`chat:proj/${worktreeId}/${chatId}`);
  service.startChatTurn({
    projectId: 'proj',
    worktreeId,
    chatId,
    provider: 'claude',
    originalUserText: 'Inspect cost',
    submittedText: 'Inspect cost',
    planMode: false,
    isStandalone: false,
  });
}

function observeClaudeResult(
  service: ObservabilityService,
  cumulativeCostUsd: number,
  options: {
    chatId?: string;
    worktreeId?: string;
    sessionId?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  } = {},
): void {
  service.observeChatEvent(
    'proj',
    options.worktreeId ?? 'wt',
    options.chatId ?? 'chat',
    {
      type: 'result',
      session_id:
        options.sessionId ??
        `session-${options.worktreeId ?? 'wt'}-${options.chatId ?? 'chat'}`,
      usage: {
        input_tokens: options.inputTokens ?? 1,
        output_tokens: options.outputTokens ?? 1,
        cache_read_input_tokens: options.cacheReadInputTokens ?? 0,
        cache_creation_input_tokens: options.cacheCreationInputTokens ?? 0,
      },
      total_cost_usd: cumulativeCostUsd,
    },
  );
}

function completeClaudeChatTurn(
  service: ObservabilityService,
  chatId = 'chat',
  worktreeId = 'wt',
): AgentAuditEntry {
  service.completeChatTurn('proj', worktreeId, chatId, 'success');
  return loadRecentEntryForChat(service, chatId, worktreeId);
}

function makeStartedAt(daysAgo: number): string {
  const startedAt = new Date();
  startedAt.setUTCDate(startedAt.getUTCDate() - daysAgo);
  startedAt.setUTCHours(12, 0, 0, 0);
  return startedAt.toISOString();
}

function isoDay(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 10);
}

function makeAuditEntry(
  id: string,
  startedAt: string,
  overrides: Partial<AgentAuditEntry> = {},
): AgentAuditEntry {
  return {
    id,
    eventType: 'worktree_chat',
    status: 'success',
    provider: 'claude',
    label: 'Code Chat',
    startedAt,
    completedAt: startedAt,
    durationMs: 0,
    model: 'claude-sonnet-4-6',
    tokens: {
      input: 10,
      output: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    messageCount: 1,
    assistantMessageCount: 1,
    toolUseCount: 0,
    subAgentCount: 0,
    hasTranscript: false,
    toolCounts: {
      thinking: 0,
      bash: 0,
      read: 0,
      readLines: 0,
      writeEdit: 0,
      fileEdit: 0,
      fileAdd: 0,
      fileDelete: 0,
      search: 0,
      grep: 0,
      web: 0,
      agent: 0,
      workflow: 0,
      tasks: 0,
      taskStop: 0,
      skills: 0,
      monitor: 0,
      claude: 0,
      scheduleWakeup: 0,
      askUser: 0,
      scriptOutput: 0,
      watcher: 0,
      canopy: 0,
      appAdvisor: 0,
      pipelineEditor: 0,
      mcp: 0,
      other: 0,
    },
    ...overrides,
  };
}

function makePipelineUsageEvent(
  overrides: Partial<PipelineRunUsageEvent> = {},
): PipelineRunUsageEvent {
  const type = overrides.type ?? 'pipeline_run_completed';
  const id =
    overrides.id ??
    (type === 'pipeline_run_started'
      ? 'pipeline-run-started:exec-1'
      : 'pipeline-run-completed:exec-1');
  const timestamp = overrides.timestamp ?? '2026-05-26T12:05:00.000Z';
  const pipeline = overrides.pipeline ?? {
    key: 'stored:user:pipeline-1',
    id: 'pipeline-1',
    name: 'Deploy',
    source: 'user' as const,
  };

  return {
    version: 1,
    id,
    type,
    timestamp,
    workspaceId: 'workspace-1',
    worktreeId: 'worktree-1',
    provider: 'pipeline',
    initiationSource: 'user',
    pipelineExecutionId: 'exec-1',
    pipeline,
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    pipelineIdentityKey: pipeline.key,
    eventName: 'dispatch',
    runStartedAt: '2026-05-26T12:00:00.000Z',
    runCompletedAt:
      type === 'pipeline_run_completed'
        ? '2026-05-26T12:05:00.000Z'
        : undefined,
    runDurationMs: type === 'pipeline_run_completed' ? 300_000 : undefined,
    status: type === 'pipeline_run_started' ? 'running' : 'success',
    jobCount: 2,
    stepCount: 5,
    agentStepCount: 1,
    retryCount: 0,
    ...overrides,
  };
}

function serializeAuditEntries(entries: readonly AgentAuditEntry[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}

function findProviderUsage(
  service: ObservabilityService,
  provider: 'claude' | 'codex',
): {
  authState: string;
  accountLabel?: string;
} {
  const summary = service
    .loadSnapshot()
    .usage.providers.find((entry) => entry.provider === provider);
  if (!summary) {
    throw new Error(`Expected ${provider} usage summary`);
  }
  return {
    authState: summary.authState,
    accountLabel: summary.accountLabel,
  };
}

function installMockFilesystem(): Map<string, string> {
  const files = new Map<string, string>();

  mockedAppendFile.mockImplementation(
    (pathArg: unknown, payloadArg: unknown): Promise<void> => {
      if (typeof pathArg !== 'string') {
        return Promise.reject(new Error('Unexpected append path'));
      }
      const payload =
        typeof payloadArg === 'string' ? payloadArg : String(payloadArg);
      files.set(pathArg, `${files.get(pathArg) ?? ''}${payload}`);
      return Promise.resolve();
    },
  );

  mockedReadFile.mockImplementation((pathArg: unknown): Promise<string> => {
    if (typeof pathArg !== 'string') {
      return Promise.reject(new Error('Unexpected read path'));
    }
    const contents = files.get(pathArg);
    if (contents === undefined) {
      return Promise.reject(new Error(`ENOENT: ${pathArg}`));
    }
    return Promise.resolve(contents);
  });

  mockedStat.mockImplementation(
    (pathArg: unknown): Promise<{ size: number }> => {
      if (typeof pathArg !== 'string') {
        return Promise.reject(new Error('Unexpected stat path'));
      }
      const contents = files.get(pathArg);
      if (contents === undefined) {
        return Promise.reject(new Error(`ENOENT: ${pathArg}`));
      }
      return Promise.resolve({ size: Buffer.byteLength(contents, 'utf8') });
    },
  );

  mockedReaddir.mockImplementation((pathArg: unknown): Promise<string[]> => {
    if (typeof pathArg !== 'string') {
      return Promise.reject(new Error('Unexpected readdir path'));
    }

    const prefix = `${pathArg.replace(/\/+$/, '')}/`;
    const children = new Set<string>();
    const filePaths: string[] = Array.from(files.keys());
    for (const filePath of filePaths) {
      if (!filePath.startsWith(prefix)) {
        continue;
      }
      const relative = filePath.slice(prefix.length);
      const [child] = relative.split('/');
      if (child) {
        children.add(child);
      }
    }
    return Promise.resolve(Array.from(children).sort());
  });

  mockedWriteFile.mockImplementation(
    (pathArg: unknown, payloadArg: unknown): Promise<void> => {
      if (typeof pathArg !== 'string') {
        return Promise.reject(new Error('Unexpected write path'));
      }
      const payload =
        typeof payloadArg === 'string' ? payloadArg : String(payloadArg);
      files.set(pathArg, payload);
      return Promise.resolve();
    },
  );

  mockedRename.mockImplementation(
    (sourceArg: unknown, targetArg: unknown): Promise<void> => {
      if (typeof sourceArg !== 'string' || typeof targetArg !== 'string') {
        return Promise.reject(new Error('Unexpected rename path'));
      }
      const contents = files.get(sourceArg);
      if (contents === undefined) {
        return Promise.reject(new Error(`ENOENT: ${sourceArg}`));
      }
      files.set(targetArg, contents);
      files.delete(sourceArg);
      return Promise.resolve();
    },
  );

  mockedRm.mockImplementation((pathArg: unknown, optionsArg?: unknown) => {
    if (typeof pathArg !== 'string') {
      return Promise.reject(new Error('Unexpected rm path'));
    }

    const recursive =
      typeof optionsArg === 'object' &&
      optionsArg !== null &&
      'recursive' in optionsArg &&
      optionsArg.recursive === true;

    if (recursive) {
      for (const path of Array.from(files.keys())) {
        if (path === pathArg || path.startsWith(`${pathArg}/`)) {
          files.delete(path);
        }
      }
      return Promise.resolve();
    }

    files.delete(pathArg);
    return Promise.resolve();
  });

  return files;
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  throw new Error('Timed out waiting for condition');
}

async function waitForTicks(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

async function withSystemTime<T>(
  now: string,
  callback: () => Promise<T>,
): Promise<T> {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(now));
  try {
    return await callback();
  } finally {
    jest.useRealTimers();
  }
}

function localBucketStartIso(
  timestamp: string,
  bucket: UsageTimeseriesRequest['bucket'],
): string {
  const date = new Date(timestamp);
  switch (bucket) {
    case 'hour':
      return new Date(
        date.getTime() -
          date.getMinutes() * 60 * 1000 -
          date.getSeconds() * 1000 -
          date.getMilliseconds(),
      ).toISOString();
    case 'day':
      return new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
      ).toISOString();
    case 'week': {
      const start = new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
      );
      const daysSinceMonday = (start.getDay() + 6) % 7;
      start.setDate(start.getDate() - daysSinceMonday);
      return start.toISOString();
    }
  }
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolveDeferred = (value: T): void => {
    void value;
  };
  let rejectDeferred = (reason?: unknown): void => {
    void reason;
  };
  const promise = new Promise<T>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });
  return {
    promise,
    resolve: resolveDeferred,
    reject: rejectDeferred,
  };
}

function createClaudeUsageResponse(
  sessionPercent = 10,
  weeklyPercent = 60,
  status = 200,
  headers: HeadersInit = { 'Content-Type': 'application/json' },
): Response {
  return new Response(
    JSON.stringify({
      five_hour: {
        utilization: sessionPercent,
        resets_at: '2026-03-27T04:00:00.000Z',
      },
      seven_day: {
        utilization: weeklyPercent,
        resets_at: '2026-03-27T13:00:00.000Z',
      },
    }),
    { status, headers },
  );
}

function installDateNowClock(initialTime: number): {
  advance: (durationMs: number) => void;
  restore: () => void;
} {
  let now = initialTime;
  const dateNow = jest.spyOn(Date, 'now').mockImplementation(() => now);
  return {
    advance: (durationMs: number): void => {
      now += durationMs;
    },
    restore: (): void => dateNow.mockRestore(),
  };
}

function fileNotFoundError(): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error('ENOENT');
  error.code = 'ENOENT';
  return error;
}

const anyToolUseId: unknown = expect.any(String);

describe('resolveAuditContextWorkspaceId', () => {
  const resolvers = {
    codeReview: jest.fn((scopeKey: string) =>
      scopeKey === 'review-scope' ? { projectId: 'review-project' } : null,
    ),
    planExplore: jest.fn((planId: string) =>
      planId === 'plan-1' ? { projectId: 'plan-project' } : null,
    ),
  };

  it('resolves persistent Plan Explore and Code Review owners', () => {
    expect(
      resolveAuditContextWorkspaceId(
        {
          projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
          worktreeId: 'plan-1',
        },
        resolvers,
      ),
    ).toBe('plan-project');
    expect(
      resolveAuditContextWorkspaceId(
        {
          projectId: CODE_REVIEW_CHAT_PROJECT_ID,
          worktreeId: 'review-scope',
        },
        resolvers,
      ),
    ).toBe('review-project');
  });
});

describe('ObservabilityService', () => {
  const originalPlatform = process.platform;
  const originalUser = process.env.USER;
  const originalClaudeOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const originalClaudeUsageFreshnessOverride =
    process.env.CANOPY_E2E_CLAUDE_USAGE_FRESHNESS_MS;

  beforeAll(() => {
    globalThis.fetch = fetchMock;
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      writable: true,
    });
    process.env.USER = 'testuser';
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CANOPY_E2E_CLAUDE_USAGE_FRESHNESS_MS;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      writable: true,
    });
    if (originalUser !== undefined) {
      process.env.USER = originalUser;
    } else {
      delete process.env.USER;
    }
    if (originalClaudeOauthToken !== undefined) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = originalClaudeOauthToken;
    } else {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
    if (originalClaudeUsageFreshnessOverride !== undefined) {
      process.env.CANOPY_E2E_CLAUDE_USAGE_FRESHNESS_MS =
        originalClaudeUsageFreshnessOverride;
    } else {
      delete process.env.CANOPY_E2E_CLAUDE_USAGE_FRESHNESS_MS;
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockedCheckClaudeAuthStatusObserved.mockResolvedValue({
      authenticated: true,
      accountLabel: 'user@example.com',
      detail: 'claude.ai (max)',
      error: null,
    });
    mockCodexAppServerClient.mockImplementation(() => ({
      readAccount: readAccountMock,
      readRateLimits: readRateLimitsMock,
      onAccountUpdated: onAccountUpdatedMock,
      onRateLimitsUpdated: onRateLimitsUpdatedMock,
      dispose: disposeCodexMonitorMock,
    }));
    mockedAppendFile.mockReset();
    mockedMkdir.mockReset();
    mockedReadPreferencesFile.mockResolvedValue(makePreferences(30));
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    mockedReaddir.mockResolvedValue([]);
    mockedRename.mockResolvedValue(undefined);
    mockedMkdir.mockResolvedValue(undefined);
    mockedRm.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          five_hour: {
            utilization: 10,
            resets_at: '2026-03-27T04:00:00.000Z',
          },
          seven_day: {
            utilization: 60,
            resets_at: '2026-03-27T13:00:00.000Z',
          },
          extra_usage: {
            is_enabled: false,
            monthly_limit: null,
            used_credits: null,
            utilization: null,
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );
    execFileMock.mockImplementation(
      (
        file: string,
        args: string[],
        _options: unknown,
        callback: (
          error: Error | null,
          stdout?: string,
          stderr?: string,
        ) => void,
      ): void => {
        if (
          file === '/mock/bin/claude' &&
          args[0] === 'auth' &&
          args[1] === 'status' &&
          args[2] === '--json'
        ) {
          callback(
            null,
            JSON.stringify({
              loggedIn: true,
              authMethod: 'claude.ai',
              email: 'user@example.com',
              subscriptionType: 'max',
            }),
            '',
          );
          return;
        }

        if (file === 'security') {
          callback(
            null,
            JSON.stringify({
              claudeAiOauth: {
                accessToken: 'claude-access-token',
                subscriptionType: 'max',
                rateLimitTier: 'default_claude_max_20x',
              },
            }),
            '',
          );
          return;
        }

        callback(new Error('unavailable'));
      },
    );
    readAccountMock.mockResolvedValue({
      requiresOpenaiAuth: false,
      account: {
        type: 'chatgpt',
        email: 'user@example.com',
        planType: 'pro',
      },
    });
    readRateLimitsMock.mockResolvedValue({
      rateLimitsByLimitId: {},
      rateLimits: {},
    });
    onAccountUpdatedMock.mockImplementation(() => {});
    onRateLimitsUpdatedMock.mockImplementation(() => {});
    disposeCodexMonitorMock.mockImplementation(() => {});
  });

  it('refreshes Cursor on live rollout enable and aborts on disable or disposal', async () => {
    mockCursorEnabled.mockReturnValue(false);
    readCursorAccountUsageMock.mockReset();
    mockedReadPreferencesFile.mockResolvedValue({
      ...makePreferences(30),
      cursorEnabled: true,
    });
    const service = new ObservabilityService();
    let resolveRead: (value: unknown) => void = () => {};
    readCursorAccountUsageMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    try {
      await service.start();
      expect(readCursorAccountUsageMock).not.toHaveBeenCalled();
      mockCursorEnabled.mockReturnValue(true);
      mockFlagListeners.forEach((listener) => listener());
      await new Promise((resolve) => setImmediate(resolve));
      expect(readCursorAccountUsageMock).toHaveBeenCalledTimes(1);
      const signal: AbortSignal = readCursorAccountUsageMock.mock.calls[0][0];
      mockFlagListeners.forEach((listener) => listener());
      expect(readCursorAccountUsageMock).toHaveBeenCalledTimes(1);
      mockCursorEnabled.mockReturnValue(false);
      mockFlagListeners.forEach((listener) => listener());
      expect(signal.aborted).toBe(true);
      resolveRead({
        provider: 'cursor',
        authState: 'authenticated',
        accountEmail: 'old@example.com',
      });
      await new Promise((resolve) => setImmediate(resolve));
      mockCursorEnabled.mockReturnValue(true);
      mockFlagListeners.forEach((listener) => listener());
      await new Promise((resolve) => setImmediate(resolve));
      expect(
        service
          .loadSnapshot()
          .usage.providers.some((entry) => entry.provider === 'cursor'),
      ).toBe(false);
      expect(readCursorAccountUsageMock).toHaveBeenCalledTimes(2);
    } finally {
      await service.dispose();
      mockCursorEnabled.mockReturnValue(true);
    }
    expect(mockFlagListeners.size).toBe(0);
    expect(readCursorAccountUsageMock.mock.calls[1][0].aborted).toBe(true);
  });

  it('normalizes and persists pipeline advisor entries with transcript index and mutable sdk session id', async () => {
    await withSystemTime('2026-05-14T00:00:00.000Z', async () => {
      const files = installMockFilesystem();
      const service = new ObservabilityService();
      const startedAt = new Date(
        Date.now() - 12 * 60 * 60 * 1000,
      ).toISOString();
      const startedDay = startedAt.slice(0, 10);
      service.startObservedTask('advisor-task', {
        ...makeAuditEntry('advisor-entry', startedAt, {
          eventType: 'pipeline_advisor',
          status: 'running',
          provider: 'codex',
          label: 'Pipeline Advisor',
          model: 'gpt-6-luna',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          completedAt: undefined,
          durationMs: undefined,
          pipelineId: 'pipeline-1',
          pipelineExecutionId: 'execution-1',
          linkTarget: {
            page: 'pipelines',
            kind: 'pipeline-execution',
            pipelineExecutionId: 'execution-1',
          },
        }),
      });

      service.updateObservedTask('advisor-task', {
        sdkSessionId: 'thread-1',
      });
      service.seedTranscript('advisor-task', {
        provider: 'codex',
        originalText: 'Inspect execution execution-1',
        submittedText: 'Inspect execution execution-1',
        planMode: false,
        injectedPrompts: [
          {
            kind: 'system_prompt_append',
            provider: 'codex',
            applicationCondition: 'helper_task_system_prompt',
            text: 'Pipeline Advisor system prompt.',
          },
        ],
      });
      service.appendTranscriptRecord('advisor-task', {
        type: 'agent_message',
        message: { content: [{ type: 'text', text: '{"health":{}}' }] },
      });
      service.finalizeObservedTask('advisor-task', 'success', undefined, {
        inputTokens: 11,
        outputTokens: 7,
        cacheReadInputTokens: 3,
        observedCost: {
          status: 'unpriced',
          reason: 'pricing_unavailable',
        },
        messageCount: 2,
        assistantMessageCount: 1,
      });

      await service.flush();

      const persistedEntry = service
        .loadSnapshot()
        .recentEntries.find((entry) => entry.id === 'advisor-entry');
      expect(persistedEntry).toMatchObject({
        eventType: 'pipeline_advisor',
        label: 'Pipeline Advisor',
        status: 'success',
        sdkSessionId: 'thread-1',
        hasTranscript: true,
        tokens: {
          input: 11,
          output: 7,
          cacheReadInputTokens: 3,
        },
        observedCost: {
          status: 'unpriced',
          reason: 'pricing_unavailable',
        },
        messageCount: 2,
        assistantMessageCount: 1,
      });
      expect(persistedEntry?.linkTarget).toEqual({
        page: 'pipelines',
        kind: 'pipeline-execution',
        pipelineExecutionId: 'execution-1',
      });

      const auditFile = files.get(`/mock/observability/${startedDay}.jsonl`);
      expect(auditFile).toContain('"eventType":"pipeline_advisor"');
      expect(auditFile).toContain('"sdkSessionId":"thread-1"');
      expect(auditFile).toContain('"hasTranscript":true');

      const transcriptPath = `/mock/observability/transcripts/${startedDay}/pipeline_advisor-advisor-entry.jsonl`;
      expect(files.get(transcriptPath)).toContain(
        'Pipeline Advisor system prompt',
      );
      expect(files.get(transcriptPath)).toContain('"type":"agent_message"');

      const transcriptIndex = files.get(
        `/mock/observability/transcript-index/${startedDay}.jsonl`,
      );
      expect(transcriptIndex).toContain('"eventType":"pipeline_advisor"');
      expect(transcriptIndex).toContain('"projectId":"project-1"');
      expect(transcriptIndex).toContain('"worktreeId":"worktree-1"');
      expect(transcriptIndex).toContain('"entryId":"advisor-entry"');
      expect(transcriptIndex).toContain(transcriptPath);

      const transcript = await service.loadTranscript({
        id: 'advisor-entry',
        eventType: 'pipeline_advisor',
        startedAt,
      });
      expect(transcript.type).toBe('success');
      if (transcript.type !== 'success') {
        throw new Error('Expected Pipeline Advisor transcript response');
      }
      expect(transcript.providerHint).toBe('codex');
      expect(transcript.injectedPrompts).toEqual([
        {
          kind: 'system_prompt_append',
          provider: 'codex',
          applicationCondition: 'helper_task_system_prompt',
          text: 'Pipeline Advisor system prompt.',
        },
      ]);
      expect(
        transcript.lines.some((line) => line.includes('agent_message')),
      ).toBe(true);

      const rehydrated = new ObservabilityService();
      mockedReadPreferencesFile.mockResolvedValue(makePreferences(365));
      await rehydrated.start();
      const normalizedEntry = rehydrated
        .loadSnapshot()
        .recentEntries.find((entry) => entry.id === 'advisor-entry');
      expect(normalizedEntry).toMatchObject({
        eventType: 'pipeline_advisor',
        label: 'Pipeline Advisor',
        sdkSessionId: 'thread-1',
        hasTranscript: true,
      });
      expect(normalizedEntry?.linkTarget).toEqual({
        page: 'pipelines',
        kind: 'pipeline-execution',
        pipelineExecutionId: 'execution-1',
      });
      await rehydrated.dispose();
    });
  });

  it('observes Codex transcript events for billable web-search counts', () => {
    installMockFilesystem();
    mockGetOpenAiPricingForCostingSync.mockReturnValue({
      payload: {
        version: 1,
        currency: 'usd',
        tokenUnit: 'per_1m_tokens',
        source: {
          pricingUrl: 'https://developers.openai.com/api/docs/pricing',
          codexPricingUrl: 'https://developers.openai.com/codex/pricing',
          codexSpeedUrl: 'https://developers.openai.com/codex/speed',
          fetchedAt: '2026-06-18T00:00:00.000Z',
          generatedBy: 'test',
        },
        cache: {
          maxAgeSeconds: 3600,
          staleWhileRevalidateSeconds: 86400,
        },
        basis: {
          tokenPricing: 'openai_api_standard',
          fastModePricing: 'codex_credit_adjusted_standard_equivalent',
          notes: ['test pricing'],
        },
        serviceTierAliases: {
          default: 'standard',
          standard: 'standard',
          priority: 'fast',
          fast: 'fast',
        },
        models: {
          priced: {
            model: 'priced',
            standard: { input: 1, cachedInput: 0.1, output: 2 },
          },
        },
        unpricedModels: {},
        billableTools: {
          webSearchCall: { unit: 'per_1k_calls', standardUsd: 10 },
        },
      },
      fetchedAt: '2026-06-18T00:00:00.000Z',
      loadedFrom: 'memory',
      stale: false,
    });

    const service = new ObservabilityService();
    const startedAt = '2026-05-13T00:00:00.000Z';
    service.startObservedTask('advisor-task', {
      ...makeAuditEntry('advisor-entry', startedAt, {
        eventType: 'pipeline_advisor',
        status: 'running',
        provider: 'codex',
        label: 'Pipeline Advisor',
        model: 'priced',
        completedAt: undefined,
        durationMs: undefined,
      }),
    });
    service.seedTranscript('advisor-task', {
      provider: 'codex',
      originalText: 'Inspect execution execution-1',
      submittedText: 'Inspect execution execution-1',
      planMode: false,
    });

    const webSearchCompleted = {
      type: 'item.completed',
      item: {
        id: 'web-search-1',
        type: 'web_search',
        query: 'OpenAI pricing',
      },
    };
    service.appendTranscriptRecord('advisor-task', {
      type: 'item.started',
      item: {
        id: 'web-search-started-only',
        type: 'web_search',
        query: 'OpenAI pricing started',
      },
    });
    service.appendTranscriptRecord('advisor-task', {
      type: 'item.updated',
      item: {
        id: 'web-search-updated-only',
        type: 'web_search',
        query: 'OpenAI pricing updated',
      },
    });
    service.appendTranscriptRecord('advisor-task', webSearchCompleted);
    service.appendTranscriptRecord('advisor-task', webSearchCompleted);
    service.finalizeObservedTask('advisor-task', 'success', undefined, {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
      messageCount: 1,
      assistantMessageCount: 1,
    });

    const persistedEntry = service
      .loadSnapshot()
      .recentEntries.find((entry) => entry.id === 'advisor-entry');
    expect(persistedEntry?.billableToolCounts).toEqual({
      openAiWebSearchCalls: 1,
    });
    expect(persistedEntry?.observedCost).toMatchObject({
      status: 'priced',
      reason: 'priced',
      nonTokenUsd: 0.01,
      totalUsd: 0.01,
    });
    expect(persistedEntry?.totalCostUsd).toBe(
      persistedEntry?.observedCost?.totalUsd,
    );
    expect(persistedEntry?.observedCost?.components).toContainEqual(
      expect.objectContaining({
        kind: 'web_search_call',
        quantity: 1,
        usd: 0.01,
      }),
    );
  });

  it('does not treat empty Codex usage objects as observed usage', () => {
    installMockFilesystem();

    const service = new ObservabilityService();
    const startedAt = '2026-05-13T00:00:00.000Z';
    service.startObservedTask('advisor-task', {
      ...makeAuditEntry('advisor-entry', startedAt, {
        eventType: 'pipeline_advisor',
        status: 'running',
        provider: 'codex',
        label: 'Pipeline Advisor',
        model: 'priced',
        completedAt: undefined,
        durationMs: undefined,
      }),
    });

    service.appendTranscriptRecord('advisor-task', {
      type: 'turn.completed',
      usage: {},
    });
    service.finalizeObservedTask('advisor-task', 'success');

    const persistedEntry = service
      .loadSnapshot()
      .recentEntries.find((entry) => entry.id === 'advisor-entry');
    expect(persistedEntry?.totalCostUsd).toBeUndefined();
    expect(persistedEntry?.observedCost).toMatchObject({
      status: 'unpriced',
      reason: 'unsupported_usage_shape',
    });
  });

  it('never assigns vendor-list-price cost to an organization gateway turn', () => {
    installMockFilesystem();
    mockGetOpenAiPricingForCostingSync.mockReturnValue({
      version: 1,
      currency: 'usd',
      models: {
        'org-model': {
          model: 'org-model',
          standard: { input: 1, cachedInput: 0.1, output: 2 },
        },
      },
      unpricedModels: {},
      billableTools: {},
      fetchedAt: '2026-06-18T00:00:00.000Z',
      loadedFrom: 'memory',
      stale: false,
    });

    const service = new ObservabilityService();
    const startedAt = '2026-05-13T00:00:00.000Z';
    service.startObservedTask('org-gateway-task', {
      ...makeAuditEntry('org-gateway-entry', startedAt, {
        eventType: 'pipeline_advisor',
        status: 'running',
        provider: 'codex',
        label: 'Organization gateway task',
        model: 'org-model',
        modelGatewayRouted: true,
        completedAt: undefined,
        durationMs: undefined,
      }),
    });
    service.finalizeObservedTask('org-gateway-task', 'success', undefined, {
      inputTokens: 10,
      outputTokens: 5,
    });

    const persistedEntry = service
      .loadSnapshot()
      .recentEntries.find((entry) => entry.id === 'org-gateway-entry');
    expect(persistedEntry?.tokens).toMatchObject({ input: 10, output: 5 });
    expect(persistedEntry?.totalCostUsd).toBeUndefined();
    expect(persistedEntry?.observedCost).toBeUndefined();
  });

  it('keeps native cost for a model that is only eligible for an additive org route', () => {
    installMockFilesystem();
    mockGetOpenAiPricingForCostingSync.mockReturnValue({
      payload: {
        version: 1,
        currency: 'usd',
        tokenUnit: 'per_1m_tokens',
        source: {
          pricingUrl: 'https://developers.openai.com/api/docs/pricing',
          codexPricingUrl: 'https://developers.openai.com/codex/pricing',
          codexSpeedUrl: 'https://developers.openai.com/codex/speed',
          fetchedAt: '2026-06-18T00:00:00.000Z',
          generatedBy: 'test',
        },
        cache: { maxAgeSeconds: 3600, staleWhileRevalidateSeconds: 86400 },
        basis: {
          tokenPricing: 'openai_api_standard',
          fastModePricing: 'codex_credit_adjusted_standard_equivalent',
          notes: ['test pricing'],
        },
        serviceTierAliases: {
          default: 'standard',
          standard: 'standard',
          priority: 'fast',
          fast: 'fast',
        },
        models: {
          priced: {
            model: 'priced',
            standard: { input: 1, cachedInput: 0.1, output: 2 },
          },
        },
        unpricedModels: {},
        billableTools: {},
      },
      fetchedAt: '2026-06-18T00:00:00.000Z',
      loadedFrom: 'memory',
      stale: false,
    });
    const previousModels = getAiGatewayModelEntries();
    const previousRoutes = getGatewayModelEntries();
    initAiGatewayModels(previousModels, [
      ...previousRoutes,
      {
        modelId: 'priced',
        gatewayId: 'org/priced',
        family: 'custom',
        recommendedHarness: 'codex',
        gatewayOnly: false,
        contextWindow: 128_000,
        supportsPromptCaching: true,
        supportedThinkingLevels: [],
        toolSchemaProfile: 'standard',
        origin: 'org-gateway',
        baseUrl: 'https://gateway.acme.test',
        organizationId: 'org-1',
        promptCachePassthrough: true,
      },
    ]);

    try {
      const service = new ObservabilityService();
      const startedAt = '2026-05-13T00:00:00.000Z';
      service.startObservedTask('native-additive-task', {
        ...makeAuditEntry('native-additive-entry', startedAt, {
          eventType: 'pipeline_advisor',
          status: 'running',
          provider: 'codex',
          label: 'Native additive task',
          model: 'priced',
          completedAt: undefined,
          durationMs: undefined,
        }),
      });
      service.finalizeObservedTask(
        'native-additive-task',
        'success',
        undefined,
        {
          inputTokens: 10,
          outputTokens: 5,
        },
      );

      const persistedEntry = service
        .loadSnapshot()
        .recentEntries.find((entry) => entry.id === 'native-additive-entry');
      expect(persistedEntry?.modelGatewayRouted).toBeUndefined();
      expect(persistedEntry?.observedCost).toMatchObject({ status: 'priced' });
      expect(persistedEntry?.totalCostUsd).toBeGreaterThan(0);

      service.startObservedTask('routed-additive-task', {
        ...makeAuditEntry('routed-additive-entry', startedAt, {
          eventType: 'pipeline_advisor',
          status: 'running',
          provider: 'codex',
          label: 'Routed additive task',
          model: 'priced',
          aiCreditsRouted: true,
          completedAt: undefined,
          durationMs: undefined,
        }),
      });
      service.finalizeObservedTask(
        'routed-additive-task',
        'success',
        undefined,
        { inputTokens: 10, outputTokens: 5 },
      );

      const routedEntry = service
        .loadSnapshot()
        .recentEntries.find((entry) => entry.id === 'routed-additive-entry');
      expect(routedEntry?.modelGatewayRouted).toBe(true);
      expect(routedEntry?.observedCost).toBeUndefined();
      expect(routedEntry?.totalCostUsd).toBeUndefined();
    } finally {
      initAiGatewayModels(previousModels, previousRoutes);
    }
  });

  it('applies cost repairs to unchanged recent entries and commits them to disk', async () => {
    jest.useFakeTimers();
    try {
      mockRunCostHistoryRepair.mockClear();
      mockGetOpenAiPricingForCostingSync.mockReturnValue({
        loadedFrom: 'cache',
        stale: false,
        payload: {},
      });
      const service = new ObservabilityService();
      await service.start();
      service.startChatTurn({
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat',
        provider: 'claude',
        originalUserText: 'Hello',
        submittedText: 'Hello',
        planMode: false,
        isStandalone: false,
      });
      service.completeChatTurn('proj', 'wt', 'chat', 'success');
      const live = loadOnlyRecentEntry(service);
      jest.advanceTimersByTime(60_000);
      const options = mockRunCostHistoryRepair.mock.calls[0]?.[0];
      if (!options) throw new Error('Expected the cost history repair to run');

      // A snapshot that no longer matches the live entry is not applied.
      await options.append({
        ...live,
        totalCostUsd: 9,
        costRepair: { version: 1, previousTotalCostUsd: 42 },
      });
      expect(loadOnlyRecentEntry(service).totalCostUsd).toBe(live.totalCostUsd);
      // Only the repaired cost fields are taken; newer live metadata stays.
      await options.append({
        ...live,
        label: 'label read before the scan',
        totalCostUsd: 1.5,
        costRepair: {
          version: 1,
          previousTotalCostUsd: live.totalCostUsd ?? 0,
        },
      });
      expect(loadOnlyRecentEntry(service)).toMatchObject({
        label: live.label,
        totalCostUsd: 1.5,
        costRepair: { version: 1 },
      });

      mockedAppendFile.mockRejectedValue(new Error('disk full'));
      await expect(options.commit?.()).rejects.toThrow(
        'Cost history repair entries were not written',
      );
      mockedAppendFile.mockResolvedValue(undefined);
      await expect(options.commit?.()).resolves.toBeUndefined();
      expect(
        options.transcriptPathFor?.({ ...live, hasTranscript: true }),
      ).toContain('transcripts');

      await service.dispose();
    } finally {
      mockedAppendFile.mockResolvedValue(undefined);
      mockGetOpenAiPricingForCostingSync.mockReturnValue({
        loadedFrom: 'none',
        stale: true,
      });
      jest.useRealTimers();
    }
  });

  it('runs the cost history repair in the background only once prices are loaded', async () => {
    jest.useFakeTimers();
    try {
      mockRunCostHistoryRepair.mockClear();
      mockGetOpenAiPricingForCostingSync.mockReturnValue({
        loadedFrom: 'none',
        stale: true,
      });
      const service = new ObservabilityService();
      await service.start();

      // No price list yet: the repair waits instead of marking Codex rows unpriced.
      jest.advanceTimersByTime(60_000);
      expect(mockRunCostHistoryRepair).not.toHaveBeenCalled();

      mockGetOpenAiPricingForCostingSync.mockReturnValue({
        loadedFrom: 'cache',
        stale: false,
        payload: {},
      });
      jest.advanceTimersByTime(60_000);
      expect(mockRunCostHistoryRepair).toHaveBeenCalledTimes(1);
      expect(mockRunCostHistoryRepair.mock.calls[0]?.[0].markerPath).toContain(
        'cost-history-repair.json',
      );

      await service.dispose();
    } finally {
      mockGetOpenAiPricingForCostingSync.mockReturnValue({
        loadedFrom: 'none',
        stale: true,
      });
      jest.useRealTimers();
    }
  });

  it('keeps audit retention from preferences when snapshot contains a stale value', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        retentionDays: 1,
        recentEntries: [],
      }),
    );

    const service = new ObservabilityService();
    await service.start();

    expect(service.loadSnapshot().retentionDays).toBe(30);

    await service.dispose();
  });

  it('drops snapshot entries outside the active retention window on startup', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        retentionDays: 1,
        recentEntries: [
          makeAuditEntry('old-entry', makeStartedAt(40)),
          makeAuditEntry('recent-entry', makeStartedAt(2)),
        ],
      }),
    );

    const service = new ObservabilityService();
    await service.start();

    expect(
      service.loadSnapshot().recentEntries.map((entry) => entry.id),
    ).toEqual(['recent-entry']);

    await service.dispose();
  });

  it('prunes in-memory entries immediately when retention days are lowered', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        retentionDays: 30,
        recentEntries: [
          makeAuditEntry('older-entry', makeStartedAt(12)),
          makeAuditEntry('recent-entry', makeStartedAt(1)),
        ],
      }),
    );

    const service = new ObservabilityService();
    await service.start();

    service.setRetentionDays(7);

    expect(
      service.loadSnapshot().recentEntries.map((entry) => entry.id),
    ).toEqual(['recent-entry']);

    await service.dispose();
  });

  it('writes app diagnostics into app-events day files', async () => {
    const files = installMockFilesystem();
    const service = new ObservabilityService();

    service.recordAppDiagnostic({
      version: 1,
      timestamp: '2026-04-23T12:00:00.000Z',
      kind: 'before_quit',
    });
    await service.flush();

    expect(
      files.get('/mock/observability/diagnostics/app-events/2026-04-23.jsonl'),
    ).toContain('"kind":"before_quit"');
  });

  it('keeps Ledger lifecycle failures in the local app-events day file', async () => {
    const files = installMockFilesystem();
    const service = new ObservabilityService();

    service.recordAppDiagnostic({
      version: 1,
      timestamp: '2026-04-23T12:00:00.000Z',
      kind: 'ledger_lifecycle_failed',
      reason: 'move: STORAGE_UNAVAILABLE',
    });
    await service.flush();

    expect(
      files.get('/mock/observability/diagnostics/app-events/2026-04-23.jsonl'),
    ).toContain(
      '"kind":"ledger_lifecycle_failed","reason":"move: STORAGE_UNAVAILABLE"',
    );
    expect(mockCaptureDesktopInstrumentationError).not.toHaveBeenCalled();
    expect(mockStartDesktopOperation).not.toHaveBeenCalled();
  });

  it('never persists or forwards a worktree or chat identifier in app-events', async () => {
    const files = installMockFilesystem();
    const service = new ObservabilityService();
    // Assembled from a wider object, the way a spread can slip identifiers
    // past the record type.
    const smuggled = {
      version: 1 as const,
      timestamp: '2026-04-23T12:00:00.000Z',
      kind: 'resource_pressure_critical' as const,
      worktreeId: 'wt-sentinel-4be',
      chatId: 'chat-sentinel-93d',
      reason:
        'spawn /Users/u/.canopy/workspaces/ws-sentinel-7c1/worktrees/wt-sentinel-4be/bin/claude ENOENT',
    };
    const record: Parameters<ObservabilityService['recordAppDiagnostic']>[0] =
      smuggled;

    service.recordAppDiagnostic(record);
    await service.flush();

    const persisted =
      files.get(
        '/mock/observability/diagnostics/app-events/2026-04-23.jsonl',
      ) ?? '';
    expect(persisted).toContain('"kind":"resource_pressure_critical"');
    const forwarded = JSON.stringify(mockStartDesktopOperation.mock.calls);
    for (const sentinel of [
      'wt-sentinel-4be',
      'chat-sentinel-93d',
      'ws-sentinel-7c1',
    ]) {
      expect(persisted).not.toContain(sentinel);
      expect(forwarded).not.toContain(sentinel);
    }
  });

  it('reports renderer process crashes to desktop instrumentation with crash context', () => {
    const service = new ObservabilityService();

    service.recordAppDiagnostic({
      version: 1,
      timestamp: '2026-04-23T12:00:00.000Z',
      kind: 'renderer_process_gone',
      reason: 'crashed',
      exitCode: 9,
      rendererSurface: 'main_window',
    });

    expect(mockCaptureDesktopInstrumentationError).toHaveBeenCalledTimes(1);
    const [error, options] =
      mockCaptureDesktopInstrumentationError.mock.calls[0] ?? [];
    expect(error).toEqual(
      expect.objectContaining({
        message: 'Canopy renderer process gone: crashed',
      }),
    );
    expect(options?.context).toMatchObject({
      kind: 'renderer_process_gone',
      reason: 'crashed',
      exit_code: 9,
      renderer_surface: 'main_window',
      renderer_crash_reason: 'crashed',
      renderer_crashed: true,
    });
  });

  it('forwards only failed cloud OAuth diagnostics with privacy-safe context', () => {
    const service = new ObservabilityService();

    service.recordAppDiagnostic({
      version: 1,
      timestamp: '2026-04-23T12:00:00.000Z',
      kind: 'cloud_oauth_login_stage',
      cloudOAuthStage: 'start',
      cloudOAuthDurationMs: 0,
      cloudOAuthCorrelationId: '0123456789abcdef',
      cloudOAuthLoopbackPort: 49152,
      cloudOAuthClientDeviceId: 'device-1',
    });
    expect(mockCaptureDesktopInstrumentationError).not.toHaveBeenCalled();

    service.recordAppDiagnostic({
      version: 1,
      timestamp: '2026-04-23T12:00:01.000Z',
      kind: 'cloud_oauth_login_failed',
      cloudOAuthStage: 'exchange',
      cloudOAuthOutcome: 'exchange_failed',
      cloudOAuthFailureClass: 'http_error',
      cloudOAuthHttpStatus: 400,
      cloudOAuthDurationMs: 1_000,
      cloudOAuthCorrelationId: '0123456789abcdef',
      cloudOAuthLoopbackPort: 49152,
      cloudOAuthClientDeviceId: 'device-1',
    });

    expect(mockCaptureDesktopInstrumentationError).toHaveBeenCalledTimes(1);
    expect(
      mockCaptureDesktopInstrumentationError.mock.calls[0]?.[0],
    ).toBeInstanceOf(Error);
    expect(
      mockCaptureDesktopInstrumentationError.mock.calls[0]?.[1]?.context,
    ).toMatchObject({
      kind: 'cloud_oauth_login_failed',
      cloud_oauth_stage: 'exchange',
      cloud_oauth_outcome: 'exchange_failed',
      cloud_oauth_failure_class: 'http_error',
      cloud_oauth_http_status: 400,
      cloud_oauth_duration_ms: 1_000,
      cloud_oauth_correlation_id: '0123456789abcdef',
    });
    expect(
      mockCaptureDesktopInstrumentationError.mock.calls[0]?.[1]?.context,
    ).not.toHaveProperty('cloud_oauth_loopback_port');
    expect(
      mockCaptureDesktopInstrumentationError.mock.calls[0]?.[1]?.context,
    ).not.toHaveProperty('cloud_oauth_client_device_id');
  });

  it.each(['cancelled', 'replaced', 'timeout'] as const)(
    'forwards the benign cloud OAuth %s outcome as a warning operation',
    (outcome) => {
      const service = new ObservabilityService();

      service.recordAppDiagnostic({
        version: 1,
        timestamp: '2026-04-23T12:00:01.000Z',
        kind: 'cloud_oauth_login_failed',
        cloudOAuthStage: 'browser_opened',
        cloudOAuthOutcome: outcome,
        cloudOAuthDurationMs: 1_000,
        cloudOAuthCorrelationId: '0123456789abcdef',
      });

      expect(mockCaptureDesktopInstrumentationError).not.toHaveBeenCalled();
      expect(mockStartDesktopOperation).toHaveBeenCalledWith(
        'canopy.app_diagnostic',
        {
          operationKey:
            'op-app-diagnostic:cloud_oauth_login_failed:2026-04-23T12:00:01.000Z',
          context: {
            kind: 'cloud_oauth_login_failed',
            severity: 'warning',
            pressure_level: undefined,
            memory_rss_bytes: undefined,
            cpu_percent: undefined,
            process_count: undefined,
            active_chat_turn_count: undefined,
            active_pipeline_execution_count: undefined,
            cloud_oauth_stage: 'browser_opened',
            cloud_oauth_outcome: outcome,
            cloud_oauth_duration_ms: 1_000,
            cloud_oauth_correlation_id: '0123456789abcdef',
          },
        },
      );
      expect(mockSucceedDesktopOperation).toHaveBeenCalledTimes(1);
    },
  );

  it('forwards the cloud OAuth success stage as the attempt denominator', () => {
    const service = new ObservabilityService();

    service.recordAppDiagnostic({
      version: 1,
      timestamp: '2026-04-23T12:00:01.000Z',
      kind: 'cloud_oauth_login_stage',
      cloudOAuthStage: 'success',
      cloudOAuthDurationMs: 1_000,
      cloudOAuthCorrelationId: '0123456789abcdef',
    });

    expect(mockCaptureDesktopInstrumentationError).not.toHaveBeenCalled();
    expect(mockStartDesktopOperation).toHaveBeenCalledTimes(1);
    expect(mockStartDesktopOperation.mock.calls[0]?.[0]).toBe(
      'canopy.app_diagnostic',
    );
    expect(mockStartDesktopOperation.mock.calls[0]?.[1]?.operationKey).toBe(
      'op-app-diagnostic:cloud_oauth_login_stage:2026-04-23T12:00:01.000Z',
    );
    expect(mockStartDesktopOperation.mock.calls[0]?.[1]?.context).toMatchObject(
      {
        kind: 'cloud_oauth_login_stage',
        severity: 'info',
        cloud_oauth_stage: 'success',
        cloud_oauth_duration_ms: 1_000,
        cloud_oauth_correlation_id: '0123456789abcdef',
      },
    );
    expect(mockSucceedDesktopOperation).toHaveBeenCalledTimes(1);
  });

  it.each([
    { aiCreditsRouted: true, expected: true },
    { aiCreditsRouted: false, expected: false },
  ])(
    'reports whether AI credits paid for a chat turn ($expected)',
    ({ aiCreditsRouted, expected }) => {
      const service = new ObservabilityService();

      service.startChatTurn({
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat',
        provider: 'claude',
        originalUserText: 'Inspect the bug',
        submittedText: 'Inspect the bug',
        planMode: false,
        isStandalone: false,
        aiCreditsRouted,
      });
      service.completeChatTurn('proj', 'wt', 'chat', 'success');

      expect(mockSucceedDesktopOperation).toHaveBeenCalledTimes(1);
      expect(mockSucceedDesktopOperation.mock.calls[0]?.[0]).toBe(
        'canopy.chat_turn',
      );
      expect(
        mockSucceedDesktopOperation.mock.calls[0]?.[1]?.context,
      ).toMatchObject({ is_ai_credits_routed: expected });
    },
  );

  it.each([
    { aiCreditsRouted: true, expected: true },
    { aiCreditsRouted: undefined, expected: false },
  ])(
    'reports whether AI credits paid for an agent task ($expected)',
    ({ aiCreditsRouted, expected }) => {
      const service = new ObservabilityService();
      const startedAt = '2026-10-12T12:00:00.000Z';

      service.startObservedTask('agent-task', {
        ...makeAuditEntry('agent-task-entry', startedAt, {
          eventType: 'pipeline_advisor',
          status: 'running',
          completedAt: undefined,
          durationMs: undefined,
        }),
        ...(aiCreditsRouted ? { aiCreditsRouted } : {}),
      });
      service.finalizeObservedTask('agent-task', 'failure', 'Provider error');

      expect(mockFailDesktopOperation).toHaveBeenCalledTimes(1);
      expect(mockFailDesktopOperation.mock.calls[0]?.slice(0, 2)).toEqual([
        'canopy.agent_task',
        'error',
      ]);
      expect(
        mockFailDesktopOperation.mock.calls[0]?.[2]?.context,
      ).toMatchObject({ is_ai_credits_routed: expected });
    },
  );

  it('forwards provider access denial as a warning operation with its bounded code', () => {
    const service = new ObservabilityService();

    service.recordAppDiagnostic({
      version: 1,
      timestamp: '2026-04-23T12:00:01.000Z',
      kind: 'cloud_oauth_login_failed',
      cloudOAuthStage: 'callback_received',
      cloudOAuthOutcome: 'provider_error',
      cloudOAuthProviderError: 'access_denied',
      cloudOAuthDurationMs: 1_000,
      cloudOAuthCorrelationId: '0123456789abcdef',
    });

    expect(mockCaptureDesktopInstrumentationError).not.toHaveBeenCalled();
    expect(mockStartDesktopOperation).toHaveBeenCalledTimes(1);
    expect(mockStartDesktopOperation.mock.calls[0]?.[1]?.context).toMatchObject(
      {
        cloud_oauth_provider_error: 'access_denied',
        severity: 'warning',
      },
    );
  });

  it('forwards rejected callback identities as nonterminal warning operations', () => {
    const service = new ObservabilityService();

    service.recordAppDiagnostic({
      version: 1,
      timestamp: '2026-04-23T12:00:01.000Z',
      kind: 'cloud_oauth_callback_rejected',
      reason: 'invalid_request_identity',
      cloudOAuthStage: 'browser_opened',
      cloudOAuthCorrelationId: '0123456789abcdef',
    });

    expect(mockCaptureDesktopInstrumentationError).not.toHaveBeenCalled();
    expect(mockStartDesktopOperation).toHaveBeenCalledTimes(1);
    expect(mockStartDesktopOperation.mock.calls[0]?.[1]?.context).toMatchObject(
      {
        reason: 'invalid_request_identity',
        severity: 'warning',
      },
    );
  });

  it('reports a main event-loop stall as a numeric warning operation', () => {
    const service = new ObservabilityService();

    service.recordAppDiagnostic({
      version: 1,
      timestamp: '2026-09-25T12:00:00.000Z',
      kind: 'main_event_loop_stall',
      eventLoopWindowMs: 30_000,
      eventLoopDelayMaxMs: 52_000,
      eventLoopDelayP99Ms: 130,
      eventLoopDelayP50Ms: 2,
      runningCodeGraphBuildCount: 1,
      queuedCodeGraphBuildCount: 3,
      // Local-only enrichment: the Datadog context below must not change.
      eventLoopUtilization: 0.93,
      eventLoopUtilizationSource: 'main-thread-cpu',
      threadPoolProbeCount: 15,
      threadPoolProbeP50Ms: 0.2,
      threadPoolProbeP99Ms: 41,
      threadPoolProbeMaxMs: 41,
      threadPoolProbePendingMs: 3,
      chatStorageCommitCount: 120,
      activeTurnCount: 4,
    });

    const expectedOptions = {
      operationKey:
        'op-app-diagnostic:main_event_loop_stall:2026-09-25T12:00:00.000Z',
      context: {
        kind: 'main_event_loop_stall',
        severity: 'warning',
        event_loop_window_ms: 30_000,
        event_loop_delay_max_ms: 52_000,
        event_loop_delay_p99_ms: 130,
        event_loop_delay_p50_ms: 2,
        running_code_graph_build_count: 1,
        queued_code_graph_build_count: 3,
      },
    };
    expect(mockCaptureDesktopInstrumentationError).not.toHaveBeenCalled();
    expect(mockStartDesktopOperation).toHaveBeenCalledWith(
      'canopy.app_diagnostic',
      expectedOptions,
    );
    expect(mockSucceedDesktopOperation).toHaveBeenCalledWith(
      'canopy.app_diagnostic',
      expectedOptions,
    );
  });

  it('reports critical resource pressure to desktop instrumentation as a warning operation', () => {
    const service = new ObservabilityService();

    service.recordAppDiagnostic({
      version: 1,
      timestamp: '2026-04-23T12:00:00.000Z',
      kind: 'resource_pressure_critical',
      pressureLevel: 'critical',
      memoryRssBytes: 2048,
      mainHeapUsedBytes: 100,
      mainHeapTotalBytes: 200,
      mainHeapLimitBytes: 400,
      mainRssBytes: 300,
      mainExternalBytes: 50,
      mainArrayBufferBytes: 25,
      cpuPercent: 98,
      processCount: 42,
      activeChatTurnCount: 3,
      activePipelineExecutionCount: 2,
    });

    const expectedOptions = {
      operationKey:
        'op-app-diagnostic:resource_pressure_critical:2026-04-23T12:00:00.000Z',
      context: {
        kind: 'resource_pressure_critical',
        severity: 'warning',
        pressure_level: 'critical',
        memory_rss_bytes: 2048,
        main_heap_used_bytes: 100,
        main_heap_total_bytes: 200,
        main_heap_limit_bytes: 400,
        main_rss_bytes: 300,
        main_external_bytes: 50,
        main_array_buffer_bytes: 25,
        cpu_percent: 98,
        process_count: 42,
        active_chat_turn_count: 3,
        active_pipeline_execution_count: 2,
      },
    };

    expect(mockCaptureDesktopInstrumentationError).not.toHaveBeenCalled();
    expect(mockStartDesktopOperation).toHaveBeenCalledWith(
      'canopy.app_diagnostic',
      expectedOptions,
    );
    expect(mockSucceedDesktopOperation).toHaveBeenCalledWith(
      'canopy.app_diagnostic',
      expectedOptions,
    );
  });

  it('writes session diagnostics into session-events day files', async () => {
    const files = installMockFilesystem();
    const service = new ObservabilityService();

    service.recordSessionDiagnostic({
      version: 1,
      timestamp: '2026-04-23T12:00:00.000Z',
      kind: 'session_registered',
      sessionKey: 'proj/wt/chat',
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      providerType: 'codex',
    });
    await service.flush();

    expect(
      files.get(
        '/mock/observability/diagnostics/session-events/2026-04-23.jsonl',
      ),
    ).toContain('"kind":"session_registered"');
  });

  it('declares browser download diagnostics in a closed string-literal kind union', () => {
    // Jest uses isolatedModules: explicitly inspect the contract so widening
    // kind to string cannot silently make the persistence tests pass.
    const servicePath = join(__dirname, '../observability/service.ts');
    const source = ts.createSourceFile(
      servicePath,
      readFileSync(servicePath, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const record = source.statements.find(
      (statement): statement is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(statement) &&
        statement.name.text === 'SessionDiagnosticRecord',
    );
    const kind = record?.members.find(
      (member): member is ts.PropertySignature =>
        ts.isPropertySignature(member) &&
        ts.isIdentifier(member.name) &&
        member.name.text === 'kind',
    );
    if (!kind?.type || !ts.isUnionTypeNode(kind.type)) {
      throw new Error('SessionDiagnosticRecord.kind must be a closed union');
    }
    const kinds = kind.type.types.map((type) => {
      if (!ts.isLiteralTypeNode(type) || !ts.isStringLiteral(type.literal)) {
        throw new Error('Session diagnostic kinds must be string literals');
      }
      return type.literal.text;
    });
    expect(kinds).toEqual(
      expect.arrayContaining([
        'browser_download_started',
        'browser_download_finished',
      ]),
    );
  });

  it.each<SessionDiagnosticRecord['kind']>([
    'browser_download_started',
    'browser_download_finished',
  ])('writes %s only to scoped session-events day files', async (kind) => {
    const files = installMockFilesystem();
    const service = new ObservabilityService();
    const record: SessionDiagnosticRecord = {
      version: 1,
      timestamp: '2026-04-23T12:00:00.000Z',
      kind,
      sessionKey: 'proj/wt/chat',
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      providerType: 'codex',
    };

    service.recordSessionDiagnostic(record);
    await service.flush();

    expect(
      files.get(
        '/mock/observability/diagnostics/session-events/2026-04-23.jsonl',
      ),
    ).toBe(`${JSON.stringify(record)}\n`);
    expect(
      files.has('/mock/observability/diagnostics/app-events/2026-04-23.jsonl'),
    ).toBe(false);
  });

  it('flushes continuous diagnostics by maximum pending age despite trailing debounce', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-23T12:00:00.000Z'));
    const files = installMockFilesystem();
    const service = new ObservabilityService();
    const dayFile =
      '/mock/observability/diagnostics/session-events/2026-04-23.jsonl';
    let emittedBytes = 0;
    let maxPendingBytes = 0;
    let firstPersistedAgeMs: number | null = null;
    try {
      for (let index = 0; index < 25; index += 1) {
        const record = {
          version: 1 as const,
          timestamp: new Date().toISOString(),
          kind: 'session_registered' as const,
          sessionKey: `proj/wt/chat-${index}`,
          projectId: 'proj',
          worktreeId: 'wt',
          chatId: `chat-${index}`,
          providerType: 'codex' as const,
        };
        service.recordSessionDiagnostic(record);
        emittedBytes += Buffer.byteLength(`${JSON.stringify(record)}\n`);
        await jest.advanceTimersByTimeAsync(100);
        const persisted = files.get(dayFile) ?? '';
        if (persisted && firstPersistedAgeMs === null) {
          firstPersistedAgeMs = (index + 1) * 100;
        }
        maxPendingBytes = Math.max(
          maxPendingBytes,
          emittedBytes - Buffer.byteLength(persisted),
        );
      }
      // The producer has never left a 400 ms quiet interval. The oldest
      // diagnostic still must reach the day file within a bounded age.
      const written = files.get(dayFile) ?? '';
      const persistedDuringStream = written.includes('proj/wt/chat-0');
      if (process.env.CANOPY_OBSERVER_DIAGNOSTIC_MEASURE === '1') {
        await jest.advanceTimersByTimeAsync(500);
        const appendPayloads = mockedAppendFile.mock.calls
          .filter(([filePath]) => filePath === dayFile)
          .map(([, payload]) => String(payload));
        process.stdout.write(
          `OBSERVER_DIAGNOSTIC_MEASURE ${JSON.stringify({
            stage: process.env.CANOPY_OBSERVER_DIAGNOSTIC_STAGE ?? 'sample',
            firstPersistedAgeMs: firstPersistedAgeMs ?? 3_000,
            maxPendingBytes,
            appendBatches: appendPayloads.length,
            maxAppendBytes: Math.max(
              0,
              ...appendPayloads.map((payload) =>
                Buffer.byteLength(payload, 'utf8'),
              ),
            ),
            persistedDuringStream,
          })}\n`,
        );
      }
      expect(persistedDuringStream).toBe(true);
    } finally {
      await service.dispose();
      jest.useRealTimers();
    }
  });

  it('coalesces continuous enqueue while a diagnostic append is held', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-23T12:00:00.000Z'));
    const files = installMockFilesystem();
    const dayFile =
      '/mock/observability/diagnostics/session-events/2026-04-23.jsonl';
    const appendNow = mockedAppendFile.getMockImplementation();
    if (!appendNow) throw new Error('Expected mock append implementation');
    let enter = (): void => undefined;
    let release = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holdFirstAppend = true;
    mockedAppendFile.mockImplementation((pathArg, payloadArg) => {
      if (pathArg === dayFile && holdFirstAppend) {
        holdFirstAppend = false;
        enter();
        return held.then(() => appendNow(pathArg, payloadArg));
      }
      return appendNow(pathArg, payloadArg);
    });
    const service = new ObservabilityService();
    const flushCalls = jest.spyOn(service, 'flush');
    const record = (index: number): void => {
      service.recordSessionDiagnostic({
        version: 1,
        timestamp: new Date().toISOString(),
        kind: 'session_registered',
        sessionKey: `proj/wt/chat-${index}`,
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: `chat-${index}`,
        providerType: 'codex',
      });
    };
    record(0);
    const firstFlush = service.flush();
    try {
      await entered;
      for (let index = 1; index <= 30; index += 1) {
        record(index);
        await jest.advanceTimersByTimeAsync(100);
      }
      // A held write must have at most one coalesced follow-up, rather than
      // allocating a new unresolved flush waiter on every post-age event.
      expect(flushCalls.mock.calls.length).toBeLessThanOrEqual(2);
      release();
      await firstFlush;
      await jest.runOnlyPendingTimersAsync();
      await service.flush();
      const persisted = files.get(dayFile) ?? '';
      expect(persisted).toContain('proj/wt/chat-0');
      expect(persisted).toContain('proj/wt/chat-30');
    } finally {
      release();
      await firstFlush;
      await service.dispose();
      jest.useRealTimers();
    }
  });

  it('flushes a large diagnostic backlog in bounded batches without losing records', async () => {
    jest.useFakeTimers();
    const files = installMockFilesystem();
    const service = new ObservabilityService();
    const dayFile =
      '/mock/observability/diagnostics/session-events/2026-04-23.jsonl';
    const recordCount = 400;
    try {
      for (let index = 0; index < recordCount; index += 1) {
        service.recordSessionDiagnostic({
          version: 1,
          timestamp: '2026-04-23T12:00:00.000Z',
          kind: 'session_registered',
          sessionKey: `proj/wt/chat-${index}`,
          projectId: 'proj',
          worktreeId: 'wt',
          chatId: `chat-${index}`,
          providerType: 'codex',
          error: `${index}:${'x'.repeat(4_096)}`,
        });
      }
      await jest.advanceTimersByTimeAsync(0);
      expect(files.get(dayFile)).toContain('proj/wt/chat-0');
      await service.flush();

      const appendPayloads = mockedAppendFile.mock.calls
        .filter(([filePath]) => filePath === dayFile)
        .map(([, payload]) => String(payload));
      expect(appendPayloads.length).toBeGreaterThan(1);
      expect(
        Math.max(
          ...appendPayloads.map((payload) =>
            Buffer.byteLength(payload, 'utf8'),
          ),
        ),
      ).toBeLessThanOrEqual(256 * 1024);
      const persistedSessionKeys = (files.get(dayFile) ?? '')
        .trim()
        .split('\n')
        .map((line) => {
          const value: unknown = JSON.parse(line);
          if (
            typeof value !== 'object' ||
            value === null ||
            !('sessionKey' in value) ||
            typeof value.sessionKey !== 'string'
          ) {
            throw new Error('Expected persisted diagnostic session key');
          }
          return value.sessionKey;
        });
      expect(persistedSessionKeys).toHaveLength(recordCount);
      expect(new Set(persistedSessionKeys).size).toBe(recordCount);
    } finally {
      await service.dispose();
      jest.useRealTimers();
    }
  });

  it('retries a failed diagnostic append in order when another event arrives and on dispose', async () => {
    const files = installMockFilesystem();
    const service = new ObservabilityService();
    const dayFile =
      '/mock/observability/diagnostics/session-events/2026-04-23.jsonl';
    const record = (index: number): void => {
      service.recordSessionDiagnostic({
        version: 1,
        timestamp: '2026-04-23T12:00:00.000Z',
        kind: 'session_registered',
        sessionKey: `proj/wt/chat-${index}`,
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: `chat-${index}`,
        providerType: 'codex',
      });
    };
    mockedAppendFile.mockRejectedValueOnce(new Error('temporary append error'));
    record(0);
    await service.flush();
    expect(files.get(dayFile)).toBeUndefined();

    record(1);
    await service.flush();
    record(2);
    await service.dispose();
    const sessionKeys = (files.get(dayFile) ?? '')
      .trim()
      .split('\n')
      .map((line) => {
        const value: unknown = JSON.parse(line);
        if (
          typeof value !== 'object' ||
          value === null ||
          !('sessionKey' in value) ||
          typeof value.sessionKey !== 'string'
        ) {
          throw new Error('Expected persisted diagnostic session key');
        }
        return value.sessionKey;
      });
    expect(sessionKeys).toEqual([
      'proj/wt/chat-0',
      'proj/wt/chat-1',
      'proj/wt/chat-2',
    ]);
  });

  it.each(['session', 'app'])(
    'does not duplicate an earlier %s diagnostic day when a later day append fails',
    async (diagnosticType) => {
      const files = installMockFilesystem();
      const dayDir =
        diagnosticType === 'session'
          ? '/mock/observability/diagnostics/session-events'
          : '/mock/observability/diagnostics/app-events';
      const firstDayFile = `${dayDir}/2026-04-23.jsonl`;
      const secondDayFile = `${dayDir}/2026-04-24.jsonl`;
      let failedSecondDay = false;
      mockedAppendFile.mockImplementation(
        (filePath: unknown, payload: unknown): Promise<void> => {
          if (typeof filePath !== 'string') {
            return Promise.reject(new Error('Unexpected append path'));
          }
          if (filePath === secondDayFile && !failedSecondDay) {
            failedSecondDay = true;
            return Promise.reject(new Error('second day unavailable'));
          }
          files.set(filePath, `${files.get(filePath) ?? ''}${String(payload)}`);
          return Promise.resolve();
        },
      );
      const service = new ObservabilityService();
      const record = (day: string, index: number): void => {
        const timestamp = `${day}T12:00:00.000Z`;
        if (diagnosticType === 'session') {
          service.recordSessionDiagnostic({
            version: 1,
            timestamp,
            kind: 'session_registered',
            sessionKey: `proj/wt/chat-${index}`,
            projectId: 'proj',
            worktreeId: 'wt',
            chatId: `chat-${index}`,
            providerType: 'codex',
          });
        } else {
          service.recordAppDiagnostic({
            version: 1,
            timestamp,
            kind: 'before_quit',
            error: `event-${index}`,
          });
        }
      };
      record('2026-04-23', 0);
      record('2026-04-24', 1);
      await service.flush();
      expect(failedSecondDay).toBe(true);
      expect(files.get(firstDayFile)).toBeDefined();
      expect(files.get(secondDayFile)).toBeUndefined();

      record('2026-04-23', 2);
      record('2026-04-24', 3);
      await service.flush();
      const readDayField = (filePath: string): string[] =>
        (files.get(filePath) ?? '')
          .trim()
          .split('\n')
          .map((line) => {
            const value: unknown = JSON.parse(line);
            if (typeof value !== 'object' || value === null) {
              throw new Error('Expected persisted diagnostic record');
            }
            const field = diagnosticType === 'session' ? 'sessionKey' : 'error';
            if (!(field in value) || typeof value[field] !== 'string') {
              throw new Error(`Expected persisted diagnostic ${field}`);
            }
            return value[field];
          });
      const firstDay = readDayField(firstDayFile);
      const secondDay = readDayField(secondDayFile);
      expect(firstDay).toHaveLength(2);
      expect(secondDay).toHaveLength(2);
      if (diagnosticType === 'session') {
        expect(firstDay).toEqual(['proj/wt/chat-0', 'proj/wt/chat-2']);
        expect(secondDay).toEqual(['proj/wt/chat-1', 'proj/wt/chat-3']);
      } else {
        expect(firstDay).toEqual(['event-0', 'event-2']);
        expect(secondDay).toEqual(['event-1', 'event-3']);
      }
      await service.dispose();
    },
  );

  it.each(['audit', 'usage', 'index'] as const)(
    'does not duplicate an earlier %s day after a later day append fails',
    async (family) => {
      const files = installMockFilesystem();
      const directory =
        family === 'audit'
          ? '/mock/observability'
          : family === 'usage'
            ? '/mock/observability/usage-events'
            : '/mock/observability/transcript-index';
      const firstDayFile = `${directory}/2026-04-23.jsonl`;
      const secondDayFile = `${directory}/2026-04-24.jsonl`;
      let failedSecondDay = false;
      mockedAppendFile.mockImplementation(
        (filePath: unknown, payload: unknown): Promise<void> => {
          if (typeof filePath !== 'string') {
            return Promise.reject(new Error('Unexpected append path'));
          }
          if (filePath === secondDayFile && !failedSecondDay) {
            failedSecondDay = true;
            return Promise.reject(new Error('second day unavailable'));
          }
          files.set(filePath, `${files.get(filePath) ?? ''}${String(payload)}`);
          return Promise.resolve();
        },
      );
      const service = new ObservabilityService();
      const record = (day: string, id: string): void => {
        const timestamp = `${day}T12:00:00.000Z`;
        if (family === 'usage') {
          service.recordUsageMetricEvent(
            makePipelineUsageEvent({ id, timestamp }),
          );
          return;
        }
        service.startObservedTask(id, {
          ...makeAuditEntry(id, timestamp, {
            projectId: 'proj',
            worktreeId: 'wt',
          }),
          status: 'running',
        });
        if (family === 'index') {
          service.appendTranscriptRecord(id, {
            type: 'assistant',
            message: { role: 'assistant', content: id },
          });
        }
        service.finalizeObservedTask(id, 'success');
      };
      record('2026-04-23', 'entry-0');
      record('2026-04-24', 'entry-1');
      await service.flush();
      expect(failedSecondDay).toBe(true);
      expect(files.get(firstDayFile)).toBeDefined();
      expect(files.get(secondDayFile)).toBeUndefined();
      record('2026-04-23', 'entry-2');
      record('2026-04-24', 'entry-3');
      await service.flush();
      const readIds = (filePath: string): string[] =>
        (files.get(filePath) ?? '')
          .trim()
          .split('\n')
          .map((line) => {
            const value: unknown = JSON.parse(line);
            const field = family === 'index' ? 'entryId' : 'id';
            if (
              typeof value !== 'object' ||
              value === null ||
              !(field in value) ||
              typeof value[field] !== 'string'
            ) {
              throw new Error(`Expected persisted ${family} ${field}`);
            }
            return value[field];
          });
      expect(readIds(firstDayFile)).toEqual(['entry-0', 'entry-2']);
      expect(readIds(secondDayFile)).toEqual(['entry-1', 'entry-3']);
      await service.dispose();
    },
  );

  it('serializes public usage-only flush with a concurrent full flush', async () => {
    const files = installMockFilesystem();
    const dayFile = '/mock/observability/usage-events/2026-04-23.jsonl';
    const appendStarted = createDeferred<void>();
    const releaseAppend = createDeferred<void>();
    let usageAppends = 0;
    mockedAppendFile.mockImplementation(
      async (filePath: unknown, payload: unknown): Promise<void> => {
        if (typeof filePath !== 'string') {
          throw new Error('Unexpected append path');
        }
        if (filePath === dayFile) {
          usageAppends += 1;
          if (usageAppends === 1) {
            appendStarted.resolve(undefined);
            await releaseAppend.promise;
          }
        }
        files.set(filePath, `${files.get(filePath) ?? ''}${String(payload)}`);
      },
    );
    const service = new ObservabilityService();
    service.recordUsageMetricEvent(
      makePipelineUsageEvent({
        id: 'usage-once',
        timestamp: '2026-04-23T12:00:00.000Z',
      }),
    );
    const usageFlush = service.flushUsageMetricEvents();
    await appendStarted.promise;
    const fullFlush = service.flush();
    await Promise.resolve();
    releaseAppend.resolve(undefined);
    await Promise.all([usageFlush, fullFlush]);
    expect(usageAppends).toBe(1);
    expect((files.get(dayFile) ?? '').trim().split('\n')).toHaveLength(1);
    await service.dispose();
  });

  it('preserves a newer audit revision with the same ID while an append is in flight', async () => {
    const files = installMockFilesystem();
    const dayFile = '/mock/observability/2026-04-23.jsonl';
    const appendStarted = createDeferred<void>();
    const releaseAppend = createDeferred<void>();
    let auditAppends = 0;
    mockedAppendFile.mockImplementation(
      async (filePath: unknown, payload: unknown): Promise<void> => {
        if (typeof filePath !== 'string') {
          throw new Error('Unexpected append path');
        }
        if (filePath === dayFile) {
          auditAppends += 1;
          if (auditAppends === 1) {
            appendStarted.resolve(undefined);
            await releaseAppend.promise;
          }
        }
        files.set(filePath, `${files.get(filePath) ?? ''}${String(payload)}`);
      },
    );
    const service = new ObservabilityService();
    const record = (key: string, label: string): void => {
      service.startObservedTask(key, {
        ...makeAuditEntry('same-entry-id', '2026-04-23T12:00:00.000Z', {
          label,
        }),
        status: 'running',
      });
      service.finalizeObservedTask(key, 'success');
    };
    record('old-task', 'Old revision');
    const flushing = service.flush();
    await appendStarted.promise;
    record('new-task', 'New revision');
    releaseAppend.resolve(undefined);
    await flushing;
    const labels = (files.get(dayFile) ?? '')
      .trim()
      .split('\n')
      .map((line) => {
        const value: unknown = JSON.parse(line);
        if (
          typeof value !== 'object' ||
          value === null ||
          !('label' in value) ||
          typeof value.label !== 'string'
        ) {
          throw new Error('Expected persisted audit label');
        }
        return value.label;
      });
    expect(labels).toEqual(['Old revision', 'New revision']);
    await service.dispose();
  });

  it('appends a queued transcript sidecar in bounded chunks', async () => {
    const files = installMockFilesystem();
    const service = new ObservabilityService();
    const key = 'bounded-sidecar';
    service.startObservedTask(key, {
      ...makeAuditEntry(key, '2026-04-23T12:00:00.000Z', {
        projectId: 'proj',
        worktreeId: 'wt',
      }),
      status: 'running',
    });
    for (let index = 0; index < 40; index += 1) {
      service.appendTranscriptRecord(key, {
        type: 'assistant',
        uuid: `sidecar-${index}`,
        message: {
          role: 'assistant',
          content: `${index}:${'x'.repeat(8 * 1024)}`,
        },
      });
    }
    service.finalizeObservedTask(key, 'success');
    await service.flush();
    const sidecarAppends = mockedAppendFile.mock.calls
      .filter(([filePath]) => String(filePath).includes('/transcripts/'))
      .map(([filePath, payload]) => ({
        filePath: String(filePath),
        payload: String(payload),
      }));
    expect(sidecarAppends.length).toBeGreaterThan(1);
    expect(
      Math.max(
        ...sidecarAppends.map(({ payload }) =>
          Buffer.byteLength(payload, 'utf8'),
        ),
      ),
    ).toBeLessThanOrEqual(256 * 1024);
    const sidecarPath = sidecarAppends[0]?.filePath;
    if (!sidecarPath) throw new Error('Missing transcript sidecar path');
    const records = (files.get(sidecarPath) ?? '').trim().split('\n');
    expect(records).toHaveLength(40);
    for (let index = 0; index < records.length; index += 1) {
      expect(records[index]).toContain(`sidecar-${index}`);
    }
    await service.dispose();
  });

  it('exposes OpenCode accounts in snapshots without persisting their labels', async () => {
    const files = installMockFilesystem();
    const service = new ObservabilityService();
    publishOpenCodeAccounts({
      status: 'ready',
      updatedAt: '2026-10-21T23:00:00Z',
      providers: [
        {
          id: 'fixture',
          name: 'Fixture',
          accounts: [
            {
              label: 'Private OpenCode account',
              method: 'oauth',
              selected: true,
              needsSignIn: false,
            },
          ],
        },
      ],
    });
    try {
      expect(JSON.stringify(service.loadSnapshot().usage)).toContain(
        'Private OpenCode account',
      );
      await service.flush();
      const persisted = files.get('/mock/observability/snapshot.json');
      expect(persisted).toBeDefined();
      expect(persisted).not.toContain('Private OpenCode account');
      expect(persisted).not.toContain('openCodeAccounts');
    } finally {
      publishOpenCodeAccounts(undefined);
      await service.dispose();
    }
  });

  it('does not serialize a diagnostic backlog on both enqueue and flush', async () => {
    installMockFilesystem();
    const service = new ObservabilityService();
    const recordCount =
      process.env.CANOPY_OBSERVER_BACKLOG_MEASURE === '1' ? 2_000 : 400;
    const stringifySpy = jest.spyOn(JSON, 'stringify');
    const startedAt = performance.now();
    const cpuBefore = process.cpuUsage();
    let enqueueMs = 0;
    let stringifyCalls = 0;
    let flushMs = 0;
    try {
      for (let index = 0; index < recordCount; index += 1) {
        service.recordSessionDiagnostic({
          version: 1,
          timestamp: '2026-04-23T12:00:00.000Z',
          kind: 'session_registered',
          sessionKey: `proj/wt/chat-${index}`,
          projectId: 'proj',
          worktreeId: 'wt',
          chatId: `chat-${index}`,
          providerType: 'codex',
          error: 'x'.repeat(1_024),
        });
      }
      enqueueMs = performance.now() - startedAt;
      const flushStartedAt = performance.now();
      await service.flush();
      flushMs = performance.now() - flushStartedAt;
      stringifyCalls = stringifySpy.mock.calls.length;
    } finally {
      stringifySpy.mockRestore();
    }
    if (process.env.CANOPY_OBSERVER_BACKLOG_MEASURE === '1') {
      process.stdout.write(
        `OBSERVER_BACKLOG_MEASURE ${JSON.stringify({
          stage: process.env.CANOPY_OBSERVER_DIAGNOSTIC_STAGE ?? 'sample',
          recordCount,
          enqueueMs,
          flushMs,
          stringifyCalls,
          cpuMicroseconds: process.cpuUsage(cpuBefore),
          appendBatches: mockedAppendFile.mock.calls.filter(([filePath]) =>
            String(filePath).includes('/diagnostics/session-events/'),
          ).length,
        })}\n`,
      );
    }
    expect(stringifyCalls).toBeLessThan(recordCount + 50);
    await service.dispose();
  });

  it.each(['cycle', 'bigint'] as const)(
    'queues a diagnostic with a transient %s property without synchronous serialization',
    async (shape) => {
      const files = installMockFilesystem();
      const service = new ObservabilityService();
      const record = {
        version: 1 as const,
        timestamp: '2026-04-23T12:00:00.000Z',
        kind: 'session_registered' as const,
        sessionKey: 'proj/wt/chat',
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat',
        providerType: 'codex' as const,
      };
      Object.defineProperty(record, 'transientExtra', {
        configurable: true,
        enumerable: true,
        value: shape === 'cycle' ? record : 1n,
      });
      expect(() => service.recordSessionDiagnostic(record)).not.toThrow();
      Reflect.deleteProperty(record, 'transientExtra');
      await service.flush();
      expect(
        files.get(
          '/mock/observability/diagnostics/session-events/2026-04-23.jsonl',
        ),
      ).toContain('proj/wt/chat');
      await service.dispose();
    },
  );

  it('retries snapshot persistence after a failed replacement during a diagnostic flush', async () => {
    const service = new ObservabilityService();
    mockedRename.mockRejectedValueOnce(new Error('synthetic rename failure'));

    await service.flush();
    expect(mockedRename).toHaveBeenCalledTimes(1);

    service.recordSessionDiagnostic({
      version: 1,
      timestamp: '2026-04-23T12:00:00.000Z',
      kind: 'session_registered',
      sessionKey: 'proj/wt/chat',
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      providerType: 'codex',
    });
    await service.flush();

    expect(mockedRename).toHaveBeenCalledTimes(2);
    expect(mockedRename).toHaveBeenLastCalledWith(
      '/mock/observability/snapshot.json.tmp',
      '/mock/observability/snapshot.json',
    );
  });

  it('persists changes to nested updatedAt content beside timestamp-looking text', async () => {
    const files = installMockFilesystem();
    const service = new ObservabilityService();
    const startedAt = new Date().toISOString();
    const label =
      'Literal "usage": { "updatedAt": "2026-01-01T00:00:00.000Z" }';
    const entry = (
      updatedAt: string,
    ): AgentAuditEntry & { nested: { updatedAt: string } } => ({
      ...makeAuditEntry('nested-timestamp-entry', startedAt, { label }),
      nested: { updatedAt },
    });

    service.startObservedTask(
      'nested-timestamp-task',
      entry('2026-01-01T00:00:00.000Z'),
    );
    service.finalizeObservedTask('nested-timestamp-task', 'success');
    await service.flush();
    const first: unknown = JSON.parse(
      files.get('/mock/observability/snapshot.json') ?? '{}',
    );
    expect(first).toMatchObject({
      recentEntries: [{ nested: { updatedAt: '2026-01-01T00:00:00.000Z' } }],
    });

    service.startObservedTask(
      'nested-timestamp-task',
      entry('2026-02-02T00:00:00.000Z'),
    );
    service.finalizeObservedTask('nested-timestamp-task', 'success');
    await service.flush();
    const second: unknown = JSON.parse(
      files.get('/mock/observability/snapshot.json') ?? '{}',
    );
    expect(second).toMatchObject({
      recentEntries: [
        { label, nested: { updatedAt: '2026-02-02T00:00:00.000Z' } },
      ],
    });
    expect(mockedRename).toHaveBeenCalledTimes(2);
  });

  it('efficiency: leaves an unchanged snapshot untouched after a diagnostic-only flush', async () => {
    installMockFilesystem();
    const service = new ObservabilityService();
    await service.flush();
    const initialReplacements = mockedRename.mock.calls.filter(
      ([destination]) =>
        destination === '/mock/observability/snapshot.json.tmp',
    ).length;

    service.recordSessionDiagnostic({
      version: 1,
      timestamp: '2026-04-23T12:00:00.000Z',
      kind: 'session_registered',
      sessionKey: 'proj/wt/chat',
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      providerType: 'codex',
    });
    await service.flush();

    expect(
      mockedRename.mock.calls.filter(
        ([destination]) =>
          destination === '/mock/observability/snapshot.json.tmp',
      ),
    ).toHaveLength(initialReplacements);
  });

  it('recreates an externally removed snapshot on a diagnostic-only flush', async () => {
    const files = installMockFilesystem();
    const service = new ObservabilityService();
    await service.flush();
    const snapshotPath = '/mock/observability/snapshot.json';
    const original = files.get(snapshotPath);
    expect(original).toBeDefined();

    files.delete(snapshotPath);
    service.recordSessionDiagnostic({
      version: 1,
      timestamp: '2026-04-23T12:00:00.000Z',
      kind: 'session_registered',
      sessionKey: 'proj/wt/chat',
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      providerType: 'codex',
    });
    await service.flush();

    expect(files.get(snapshotPath)).toBeDefined();
    expect(() => {
      JSON.parse(files.get(snapshotPath) ?? '');
    }).not.toThrow();
    await service.dispose();
  });

  it('replaces an externally corrupted snapshot with the same byte length', async () => {
    const files = installMockFilesystem();
    const snapshotPath = '/mock/observability/snapshot.json';
    let identity = 1n;
    mockedStat.mockImplementation((pathArg: unknown) => {
      if (typeof pathArg !== 'string') {
        return Promise.reject(new Error('Unexpected stat path'));
      }
      const contents = files.get(pathArg);
      if (contents === undefined) {
        return Promise.reject(new Error(`ENOENT: ${pathArg}`));
      }
      return Promise.resolve({
        size: Buffer.byteLength(contents, 'utf8'),
        dev: 1n,
        ino: 1n,
        mtimeNs: identity,
        ctimeNs: identity,
      });
    });
    const service = new ObservabilityService();
    await service.flush();
    const original = files.get(snapshotPath);
    if (!original) throw new Error('Missing initial snapshot');
    files.set(snapshotPath, 'x'.repeat(Buffer.byteLength(original, 'utf8')));
    identity += 1n;

    service.recordSessionDiagnostic({
      version: 1,
      timestamp: '2026-04-23T12:00:00.000Z',
      kind: 'session_registered',
      sessionKey: 'proj/wt/chat',
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      providerType: 'codex',
    });
    await service.flush();

    expect(files.get(snapshotPath)).not.toBe('x'.repeat(original.length));
    expect(() => {
      JSON.parse(files.get(snapshotPath) ?? '');
    }).not.toThrow();
    await service.dispose();
  });

  it('retries unchanged snapshot persistence when its identity cannot be verified', async () => {
    installMockFilesystem();
    const service = new ObservabilityService();
    await service.flush();
    const initialReplacements = mockedRename.mock.calls.length;
    mockedStat.mockRejectedValueOnce(new Error('synthetic stat failure'));

    service.recordSessionDiagnostic({
      version: 1,
      timestamp: '2026-04-23T12:00:00.000Z',
      kind: 'session_registered',
      sessionKey: 'proj/wt/chat',
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      providerType: 'codex',
    });
    await service.flush();

    expect(mockedRename.mock.calls).toHaveLength(initialReplacements + 1);
    await service.dispose();
  });

  it('preserves a Cursor audit entry through persistence and service reload', async () => {
    installMockFilesystem();
    const service = new ObservabilityService();
    service.startObservedTask(
      'cursor-task',
      makeAuditEntry('cursor-entry', new Date().toISOString(), {
        eventType: 'worktree_chat',
        provider: 'cursor',
        model: 'cursor-default',
        status: 'running',
      }),
    );
    service.finalizeObservedTask('cursor-task', 'success', undefined, {
      inputTokens: 11,
      outputTokens: 7,
    });
    await service.flush();
    await service.dispose();
    const reloaded = new ObservabilityService();
    try {
      await reloaded.start();
      const history = await reloaded.loadHistory({ limit: 10 });
      const entry = history.entries.find(
        (entry) => entry.id === 'cursor-entry',
      );
      expect(entry).toMatchObject({
        provider: 'cursor',
        model: 'cursor-default',
        status: 'success',
      });
      expect(entry?.tokens).toMatchObject({ input: 11, output: 7 });
    } finally {
      await reloaded.dispose();
    }
  });

  it('filters expired persisted entries out of history reads', async () => {
    mockedReaddir.mockResolvedValue(['2026-03-01.jsonl', '2026-03-26.jsonl']);
    mockedReadFile.mockImplementation(
      (...args: [unknown, unknown?]): Promise<string> => {
        const pathArg = args[0];
        if (typeof pathArg !== 'string') {
          if (pathArg instanceof URL) {
            return Promise.reject(
              new Error(`Unexpected URL path: ${pathArg.pathname}`),
            );
          }
          if (Buffer.isBuffer(pathArg)) {
            return Promise.reject(
              new Error(`Unexpected buffer path: ${pathArg.toString('utf8')}`),
            );
          }
          return Promise.reject(new Error('Unexpected file handle path'));
        }
        const pathValue = pathArg;
        if (pathValue.endsWith('snapshot.json')) {
          return Promise.reject(new Error('ENOENT'));
        }
        if (pathValue.endsWith('2026-03-01.jsonl')) {
          return Promise.resolve(
            `${JSON.stringify(makeAuditEntry('old-entry', makeStartedAt(30)))}\n`,
          );
        }
        if (pathValue.endsWith('2026-03-26.jsonl')) {
          return Promise.resolve(
            `${JSON.stringify(makeAuditEntry('recent-entry', makeStartedAt(1)))}\n`,
          );
        }
        return Promise.reject(new Error(`Unexpected path: ${pathValue}`));
      },
    );
    mockedReadPreferencesFile.mockResolvedValue(makePreferences(7));

    const service = new ObservabilityService();
    await service.start();

    const history = await service.loadHistory({ limit: 10 });

    expect(history.entries.map((entry) => entry.id)).toEqual(['recent-entry']);

    await service.dispose();
  });

  it('skips audit JSONL day files outside a ranged history request', async () => {
    await withSystemTime('2026-04-22T00:00:00.000Z', async () => {
      mockedReaddir.mockResolvedValue([
        '2026-04-17.jsonl',
        '2026-04-18.jsonl',
        '2026-04-19.jsonl',
        '2026-04-20.jsonl',
        '2026-04-21.jsonl',
        '2026-04-22.jsonl',
      ]);
      mockedReadFile.mockImplementation((pathArg: unknown): Promise<string> => {
        if (typeof pathArg !== 'string') {
          return Promise.reject(new Error('Unexpected read path'));
        }
        const day = pathArg.replace('/mock/observability/', '').slice(0, 10);
        return Promise.resolve(
          serializeAuditEntries([
            makeAuditEntry(`entry-${day}`, `${day}T12:00:00.000Z`),
          ]),
        );
      });

      const service = new ObservabilityService();
      await service.start();
      mockedReadFile.mockClear();
      try {
        const history = await service.loadHistory({
          limit: 20,
          startDate: '2026-04-19T08:00:00.000Z',
          endDate: '2026-04-20T23:00:00.000Z',
        });

        const readPaths = mockedReadFile.mock.calls.map((call) =>
          String(call[0]),
        );
        expect(readPaths).not.toContain('/mock/observability/2026-04-17.jsonl');
        expect(readPaths).toContain('/mock/observability/2026-04-18.jsonl');
        expect(readPaths).toContain('/mock/observability/2026-04-19.jsonl');
        expect(readPaths).toContain('/mock/observability/2026-04-20.jsonl');
        expect(readPaths).toContain('/mock/observability/2026-04-21.jsonl');
        expect(readPaths).not.toContain('/mock/observability/2026-04-22.jsonl');
        expect(history.entries.map((entry) => entry.id)).toEqual([
          'entry-2026-04-20',
          'entry-2026-04-19',
        ]);
      } finally {
        await service.dispose();
      }
    });
  });

  it('filters recent in-memory entries by history date range before merging', async () => {
    const service = new ObservabilityService();
    service.startObservedTask(
      'recent-before',
      makeAuditEntry('recent-before', '2026-04-19T23:59:59.999Z'),
    );
    service.startObservedTask(
      'recent-inside',
      makeAuditEntry('recent-inside', '2026-04-20T12:00:00.000Z'),
    );
    service.startObservedTask(
      'recent-after',
      makeAuditEntry('recent-after', '2026-04-21T00:00:00.000Z'),
    );

    const history = await service.loadHistory({
      limit: 10,
      startDate: '2026-04-20T00:00:00.000Z',
      endDate: '2026-04-21T00:00:00.000Z',
    });

    expect(history.entries.map((entry) => entry.id)).toEqual(['recent-inside']);
  });

  it('returns empty ranged history when no persisted or recent entries match', async () => {
    mockedReaddir.mockResolvedValue(['2026-04-20.jsonl']);
    mockedReadFile.mockResolvedValue(
      serializeAuditEntries([
        makeAuditEntry('outside-file', '2026-04-20T00:00:00.000Z'),
      ]),
    );

    const service = new ObservabilityService();
    service.startObservedTask(
      'outside-recent',
      makeAuditEntry('outside-recent', '2026-04-22T00:00:00.000Z'),
    );

    const history = await service.loadHistory({
      limit: 10,
      startDate: '2026-04-20T12:00:00.000Z',
      endDate: '2026-04-21T00:00:00.000Z',
    });

    expect(history).toEqual({ entries: [], nextCursor: undefined });
  });

  it('preserves unranged history behavior when startDate and endDate are omitted', async () => {
    await withSystemTime('2026-04-22T00:00:00.000Z', async () => {
      const olderStartedAt = makeStartedAt(2);
      const newerStartedAt = makeStartedAt(1);
      const olderDay = isoDay(olderStartedAt);
      const newerDay = isoDay(newerStartedAt);

      mockedReaddir.mockResolvedValue([
        `${olderDay}.jsonl`,
        `${newerDay}.jsonl`,
      ]);
      mockedReadFile.mockImplementation((pathArg: unknown): Promise<string> => {
        if (typeof pathArg !== 'string') {
          return Promise.reject(new Error('Unexpected read path'));
        }
        if (pathArg.endsWith(`${olderDay}.jsonl`)) {
          return Promise.resolve(
            serializeAuditEntries([
              makeAuditEntry('older-file', olderStartedAt),
            ]),
          );
        }
        if (pathArg.endsWith(`${newerDay}.jsonl`)) {
          return Promise.resolve(
            serializeAuditEntries([
              makeAuditEntry('newer-file', newerStartedAt),
            ]),
          );
        }
        return Promise.reject(new Error(`Unexpected path: ${pathArg}`));
      });

      const service = new ObservabilityService();
      const history = await service.loadHistory({ limit: 10 });

      expect(history.entries.map((entry) => entry.id)).toEqual([
        'newer-file',
        'older-file',
      ]);
      expect(mockedReadFile).toHaveBeenCalledTimes(2);
    });
  });

  it('includes padded UTC-day files for timezone-edge history ranges', async () => {
    await withSystemTime('2026-04-22T00:00:00.000Z', async () => {
      mockedReaddir.mockResolvedValue(['2026-04-19.jsonl', '2026-04-20.jsonl']);
      mockedReadFile.mockImplementation((pathArg: unknown): Promise<string> => {
        if (typeof pathArg !== 'string') {
          return Promise.reject(new Error('Unexpected read path'));
        }
        if (pathArg.endsWith('2026-04-19.jsonl')) {
          return Promise.resolve(
            serializeAuditEntries([
              makeAuditEntry('local-day-entry', '2026-04-19T11:00:00.000Z'),
            ]),
          );
        }
        if (pathArg.endsWith('2026-04-20.jsonl')) {
          return Promise.resolve(
            serializeAuditEntries([
              makeAuditEntry('next-file-entry', '2026-04-20T09:00:00.000Z'),
            ]),
          );
        }
        return Promise.reject(new Error(`Unexpected path: ${pathArg}`));
      });

      const service = new ObservabilityService();
      await service.start();
      try {
        const history = await service.loadHistory({
          limit: 10,
          startDate: '2026-04-20T00:00:00.000+14:00',
          endDate: '2026-04-21T00:00:00.000+14:00',
        });

        expect(mockedReadFile).toHaveBeenCalledWith(
          '/mock/observability/2026-04-19.jsonl',
          'utf8',
        );
        expect(history.entries.map((entry) => entry.id)).toEqual([
          'next-file-entry',
          'local-day-entry',
        ]);
      } finally {
        await service.dispose();
      }
    });
  });

  it('loads usage timeseries from multiple audit files with zero-filled providers', async () => {
    await withSystemTime('2026-04-22T00:00:00.000Z', async () => {
      mockedReaddir.mockResolvedValue([
        '2026-04-19.jsonl',
        '2026-04-20.jsonl',
        '2026-04-21.jsonl',
      ]);
      mockedReadFile.mockImplementation((pathArg: unknown): Promise<string> => {
        if (typeof pathArg !== 'string') {
          return Promise.reject(new Error('Unexpected read path'));
        }
        if (pathArg.endsWith('2026-04-19.jsonl')) {
          return Promise.resolve(
            serializeAuditEntries([
              makeAuditEntry('padded-outside', '2026-04-19T23:59:59.999Z'),
            ]),
          );
        }
        if (pathArg.endsWith('2026-04-20.jsonl')) {
          return Promise.resolve(
            serializeAuditEntries([
              makeAuditEntry('day-one-late', '2026-04-20T23:59:59.999Z', {
                tokens: {
                  input: 10,
                  output: 5,
                  cacheReadInputTokens: 0,
                  cacheCreationInputTokens: 0,
                },
              }),
            ]),
          );
        }
        if (pathArg.endsWith('2026-04-21.jsonl')) {
          return Promise.resolve(
            serializeAuditEntries([
              makeAuditEntry('day-two-start', '2026-04-21T00:00:00.000Z', {
                provider: 'codex',
                tokens: {
                  input: 7,
                  output: 3,
                  cacheReadInputTokens: 0,
                  cacheCreationInputTokens: 0,
                },
              }),
            ]),
          );
        }
        return Promise.reject(new Error(`Unexpected path: ${pathArg}`));
      });

      const service = new ObservabilityService();
      const response = await service.loadUsageTimeseries({
        startDate: '2026-04-20T00:00:00.000Z',
        endDate: '2026-04-22T00:00:00.000Z',
        bucket: 'day',
      });

      expect(response.kind).toBe('tokens');
      if (response.kind !== 'tokens') return;

      const bucketsByStart = new Map(
        response.buckets.map((bucket) => [bucket.bucketStart, bucket]),
      );
      const dayOneStart = localBucketStartIso(
        '2026-04-20T23:59:59.999Z',
        'day',
      );
      const dayTwoStart = localBucketStartIso(
        '2026-04-21T00:00:00.000Z',
        'day',
      );

      expect(bucketsByStart.get(dayOneStart)?.providers.claude).toEqual({
        in: 10,
        out: 5,
      });
      expect(bucketsByStart.get(dayTwoStart)?.providers.codex).toEqual({
        in: 7,
        out: 3,
      });
      for (const bucket of response.buckets) {
        expect(bucket.providers.ollama).toEqual({ in: 0, out: 0 });
      }
    });
  });

  it('loads hourly, daily, and weekly usage timeseries buckets', async () => {
    await withSystemTime('2026-04-22T00:00:00.000Z', async () => {
      const service = new ObservabilityService();
      await service.start();
      try {
        service.startObservedTask(
          'recent-sunday',
          makeAuditEntry('recent-sunday', '2026-04-19T23:30:00.000Z', {
            tokens: {
              input: 1,
              output: 2,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
            },
          }),
        );
        service.startObservedTask(
          'recent-monday',
          makeAuditEntry('recent-monday', '2026-04-20T00:30:00.000Z', {
            provider: 'ollama',
            tokens: {
              input: 3,
              output: 4,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
            },
          }),
        );

        const cases: {
          bucket: UsageTimeseriesRequest['bucket'];
          expectedStarts: string[];
        }[] = [
          {
            bucket: 'hour',
            expectedStarts: [
              localBucketStartIso('2026-04-19T23:30:00.000Z', 'hour'),
              localBucketStartIso('2026-04-20T00:30:00.000Z', 'hour'),
            ],
          },
          {
            bucket: 'day',
            expectedStarts: Array.from(
              new Set([
                localBucketStartIso('2026-04-19T23:30:00.000Z', 'day'),
                localBucketStartIso('2026-04-20T00:30:00.000Z', 'day'),
              ]),
            ),
          },
          {
            bucket: 'week',
            expectedStarts: Array.from(
              new Set([
                localBucketStartIso('2026-04-19T23:30:00.000Z', 'week'),
                localBucketStartIso('2026-04-20T00:30:00.000Z', 'week'),
              ]),
            ),
          },
        ];

        for (const testCase of cases) {
          const response = await service.loadUsageTimeseries({
            startDate: '2026-04-19T00:00:00.000Z',
            endDate: '2026-04-21T00:00:00.000Z',
            bucket: testCase.bucket,
          });
          expect(response.kind).toBe('tokens');
          if (response.kind !== 'tokens') continue;
          expect(response.buckets.map((bucket) => bucket.bucketStart)).toEqual(
            testCase.expectedStarts,
          );
        }
      } finally {
        await service.dispose();
      }
    });
  });

  it('returns an empty usage timeseries for an empty range', async () => {
    const service = new ObservabilityService();
    service.startObservedTask(
      'outside-usage',
      makeAuditEntry('outside-usage', '2026-04-20T12:00:00.000Z'),
    );

    const response = await service.loadUsageTimeseries({
      startDate: '2026-04-21T00:00:00.000Z',
      endDate: '2026-04-22T00:00:00.000Z',
      bucket: 'hour',
    });

    expect(response).toEqual({ kind: 'tokens', buckets: [] });
  });

  it('deduplicates recent usage entries over persisted audit entries', async () => {
    await withSystemTime('2026-04-22T00:00:00.000Z', async () => {
      mockedReaddir.mockResolvedValue(['2026-04-20.jsonl']);
      mockedReadFile.mockResolvedValue(
        serializeAuditEntries([
          makeAuditEntry('duplicate-entry', '2026-04-20T12:00:00.000Z', {
            tokens: {
              input: 1,
              output: 1,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
            },
          }),
        ]),
      );

      const service = new ObservabilityService();
      service.startObservedTask(
        'duplicate-entry',
        makeAuditEntry('duplicate-entry', '2026-04-20T12:00:00.000Z', {
          tokens: {
            input: 9,
            output: 8,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        }),
      );

      const response = await service.loadUsageTimeseries({
        startDate: '2026-04-20T00:00:00.000Z',
        endDate: '2026-04-21T00:00:00.000Z',
        bucket: 'day',
      });

      expect(response.kind).toBe('tokens');
      if (response.kind !== 'tokens') return;
      expect(response.buckets[0]?.providers.claude).toEqual({ in: 9, out: 8 });
    });
  });

  it('loads Claude live usage limits from the OAuth usage endpoint', async () => {
    const service = new ObservabilityService();
    await service.start();

    const summary = service
      .loadSnapshot()
      .usage.providers.find((entry) => entry.provider === 'claude');

    expect(summary).toMatchObject({
      authState: 'authenticated',
      accountLabel: 'user@example.com',
      subscriptionLabel: 'Claude Max 5x',
      hasRemainingLimits: true,
    });

    const fiveHourLimit = summary?.rateLimits?.find(
      (limit) => limit.limitId === 'five_hour',
    );
    const sevenDayLimit = summary?.rateLimits?.find(
      (limit) => limit.limitId === 'seven_day',
    );

    expect(fiveHourLimit?.limitName).toBe('5-hour window');
    expect(fiveHourLimit?.primary?.usedPercent).toBe(10);
    expect(sevenDayLimit?.limitName).toBe('7-day window');
    expect(sevenDayLimit?.primary?.usedPercent).toBe(60);
    expect(mockedGetEnhancedEnv).toHaveBeenCalledWith({
      environment: false,
    });

    await service.dispose();
  });

  it('labels the Claude card from the enriched Max tier planType', async () => {
    mockedCheckClaudeAuthStatusObserved.mockResolvedValueOnce({
      authenticated: true,
      accountLabel: 'user@example.com',
      detail: 'claude.ai (max)',
      planType: 'default_claude_max_20x',
      error: null,
    });

    const service = new ObservabilityService();
    await service.start();

    const summary = service
      .loadSnapshot()
      .usage.providers.find((entry) => entry.provider === 'claude');

    expect(summary).toMatchObject({
      authState: 'authenticated',
      subscriptionLabel: 'Claude Max 20x',
    });

    await service.dispose();
  });

  it('labels the Claude card as Team Premium from the enriched planType', async () => {
    mockedCheckClaudeAuthStatusObserved.mockResolvedValueOnce({
      authenticated: true,
      accountLabel: 'user@example.com',
      detail: 'claude.ai (team)',
      planType: 'team-premium',
      error: null,
    });

    const service = new ObservabilityService();
    await service.start();

    const summary = service
      .loadSnapshot()
      .usage.providers.find((entry) => entry.provider === 'claude');

    expect(summary?.subscriptionLabel).toBe('Claude Team Premium');

    await service.dispose();
  });

  it('labels the Codex card from the account planType via the catalog', async () => {
    readAccountMock.mockResolvedValueOnce({
      requiresOpenaiAuth: false,
      account: {
        type: 'chatgpt',
        email: 'user@example.com',
        planType: 'pro',
      },
    });

    const service = new ObservabilityService();
    await service.start();

    const summary = service
      .loadSnapshot()
      .usage.providers.find((entry) => entry.provider === 'codex');

    expect(summary?.subscriptionLabel).toBe('ChatGPT Pro');

    await service.dispose();
  });

  it('leaves the Codex card unlabeled when the planType is unknown', async () => {
    readAccountMock.mockResolvedValueOnce({
      requiresOpenaiAuth: false,
      account: {
        type: 'chatgpt',
        email: 'user@example.com',
        planType: 'unknown',
      },
    });

    const service = new ObservabilityService();
    await service.start();

    const summary = service
      .loadSnapshot()
      .usage.providers.find((entry) => entry.provider === 'codex');

    expect(summary?.subscriptionLabel).toBeUndefined();

    await service.dispose();
  });

  it('loads Claude live usage limits from the modern limits array', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          five_hour: {
            utilization: 10,
            resets_at: '2026-07-02T22:10:01.000000+00:00',
          },
          seven_day: {
            utilization: 60,
            resets_at: '2026-03-27T13:00:00.000Z',
          },
          limits: [
            {
              kind: 'session',
              group: 'session',
              percent: 100,
              severity: 'critical',
              resets_at: '2026-07-02T22:10:00.588025+00:00',
              scope: null,
              is_active: true,
            },
            {
              kind: 'weekly_all',
              group: 'weekly',
              percent: 36,
              severity: 'normal',
              resets_at: '2026-07-03T06:00:00.588048+00:00',
              scope: null,
              is_active: false,
            },
            {
              kind: 'weekly_scoped',
              group: 'weekly',
              percent: 60,
              severity: 'normal',
              resets_at: '2026-07-03T06:00:00.588286+00:00',
              scope: {
                model: {
                  id: null,
                  display_name: 'Fable',
                },
                surface: null,
              },
              is_active: false,
            },
          ],
          extra_usage: {
            is_enabled: false,
            monthly_limit: null,
            used_credits: null,
            utilization: null,
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const service = new ObservabilityService();
    await service.start();

    const summary = service
      .loadSnapshot()
      .usage.providers.find((entry) => entry.provider === 'claude');

    expect(summary?.rateLimits).toEqual([
      {
        limitId: 'session',
        limitName: '5-hour window',
        planType: 'default_claude_max_20x',
        primary: {
          usedPercent: 100,
          resetsAt: '2026-07-02T22:10:00.588Z',
          windowDurationMins: 300,
        },
      },
      {
        limitId: 'weekly_all',
        limitName: '7-day window',
        planType: 'default_claude_max_20x',
        primary: {
          usedPercent: 36,
          resetsAt: '2026-07-03T06:00:00.588Z',
          windowDurationMins: 10080,
        },
      },
      {
        limitId: 'weekly_scoped:Fable',
        limitName: '7-day Fable',
        planType: 'default_claude_max_20x',
        primary: {
          usedPercent: 60,
          resetsAt: '2026-07-03T06:00:00.588Z',
          windowDurationMins: 10080,
        },
      },
    ]);
    expect(
      summary?.rateLimits?.some((limit) => limit.limitId === 'five_hour'),
    ).toBe(false);

    await service.dispose();
  });

  it('preserves Claude Extra usage spend beside the derived remaining balance', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          five_hour: {
            utilization: 10,
            resets_at: '2026-03-27T04:00:00.000Z',
          },
          extra_usage: {
            is_enabled: true,
            monthly_limit: 50,
            used_credits: 12.5,
            utilization: 25,
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const service = new ObservabilityService();
    await service.start();

    const extraUsage = service
      .loadSnapshot()
      .usage.providers.find((entry) => entry.provider === 'claude')
      ?.rateLimits?.find((limit) => limit.limitId === 'extra_usage');
    expect(extraUsage).toEqual({
      limitId: 'extra_usage',
      limitName: 'Extra usage',
      planType: 'default_claude_max_20x',
      primary: { usedPercent: 25 },
      credits: { usedUsd: 12.5, totalUsd: 50, remainingUsd: 37.5 },
    });

    await service.dispose();
  });

  it('keeps a zero Claude Extra usage spend when no monthly limit is reported', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          five_hour: {
            utilization: 10,
            resets_at: '2026-03-27T04:00:00.000Z',
          },
          extra_usage: {
            is_enabled: true,
            monthly_limit: null,
            used_credits: 0,
            utilization: null,
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const service = new ObservabilityService();
    await service.start();

    const extraUsage = service
      .loadSnapshot()
      .usage.providers.find((entry) => entry.provider === 'claude')
      ?.rateLimits?.find((limit) => limit.limitId === 'extra_usage');
    expect(extraUsage?.credits).toEqual({
      usedUsd: 0,
      totalUsd: undefined,
      remainingUsd: undefined,
    });

    await service.dispose();
  });

  it('loads Claude live usage from the current Windows credentials file', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      writable: true,
    });
    mockedReadFile.mockResolvedValueOnce(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'windows-file-access-token',
          subscriptionType: 'max',
          rateLimitTier: 'default_claude_max_20x',
        },
      }),
    );

    const service = new ObservabilityService();
    try {
      await service.refreshProviderUsage('claude');

      const summary = service
        .loadSnapshot()
        .usage.providers.find((entry) => entry.provider === 'claude');
      expect(summary).toMatchObject({
        authState: 'authenticated',
        accountLabel: 'user@example.com',
        subscriptionLabel: 'Claude Max 5x',
        hasRemainingLimits: true,
      });
      expect(summary?.error).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.anthropic.com/api/oauth/usage',
        {
          method: 'GET',
          headers: {
            Authorization: 'Bearer windows-file-access-token',
            'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
            'anthropic-version': '2023-06-01',
          },
        },
      );
      expect(mockedReadFile).toHaveBeenCalledWith(
        expect.stringMatching(/[\\/]\.claude[\\/]\.credentials\.json$/),
        'utf8',
      );
      expect(execFileMock).not.toHaveBeenCalledWith(
        'powershell.exe',
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    } finally {
      await service.dispose();
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        writable: true,
      });
    }
  });

  it('reports an unreadable current Windows credentials file', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      writable: true,
    });
    const permissionError: NodeJS.ErrnoException = new Error('EACCES');
    permissionError.code = 'EACCES';
    mockedReadFile.mockRejectedValue(permissionError);

    const service = new ObservabilityService();
    try {
      await service.refreshProviderUsage('claude');
      const summary = service
        .loadSnapshot()
        .usage.providers.find((entry) => entry.provider === 'claude');
      expect(summary?.error).toBe(
        'Could not read the Claude Code credentials file. Check its permissions or sign in to Claude Code again, then refresh.',
      );
      expect(execFileMock).not.toHaveBeenCalledWith(
        'powershell.exe',
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    } finally {
      await service.dispose();
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        writable: true,
      });
    }
  });

  it('reports a malformed current Windows credentials file', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      writable: true,
    });
    mockedReadFile.mockResolvedValue('not-json');

    const service = new ObservabilityService();
    try {
      await service.refreshProviderUsage('claude');
      const summary = service
        .loadSnapshot()
        .usage.providers.find((entry) => entry.provider === 'claude');
      expect(summary?.error).toBe(
        'The Claude Code credentials file is invalid or unreadable. Sign in to Claude Code again, then refresh.',
      );
      expect(execFileMock).not.toHaveBeenCalledWith(
        'powershell.exe',
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    } finally {
      await service.dispose();
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        writable: true,
      });
    }
  });

  it('loads Claude live usage from legacy Windows Credential Manager', async () => {
    const originalWindowsUsername = process.env.USERNAME;
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      writable: true,
    });
    process.env.USERNAME = 'windows-user';
    mockedReadFile.mockRejectedValue(fileNotFoundError());
    execFileMock.mockImplementation(
      (
        file: string,
        args: string[],
        _options: unknown,
        callback: (
          error: Error | null,
          stdout?: string,
          stderr?: string,
        ) => void,
      ): void => {
        if (file === 'powershell.exe') {
          const encodedCommandIndex = args.indexOf('-EncodedCommand');
          const encodedCommand = args[encodedCommandIndex + 1];
          if (!encodedCommand) {
            throw new Error('Expected an encoded PowerShell command');
          }
          expect(
            Buffer.from(encodedCommand, 'base64').toString('utf16le'),
          ).toContain(
            Buffer.from(
              'Claude Code-credentials/windows-user',
              'utf8',
            ).toString('base64'),
          );
          callback(
            null,
            Buffer.from(
              JSON.stringify({
                claudeAiOauth: {
                  accessToken: 'windows-claude-access-token',
                  subscriptionType: 'max',
                  rateLimitTier: 'default_claude_max_20x',
                },
              }),
              'utf16le',
            ).toString('base64'),
            '',
          );
          return;
        }

        callback(new Error('unavailable'));
      },
    );

    const service = new ObservabilityService();
    try {
      await service.refreshProviderUsage('claude');

      const summary = service
        .loadSnapshot()
        .usage.providers.find((entry) => entry.provider === 'claude');
      expect(summary).toMatchObject({
        authState: 'authenticated',
        accountLabel: 'user@example.com',
        subscriptionLabel: 'Claude Max 5x',
        hasRemainingLimits: true,
      });
      expect(
        summary.rateLimits?.find((limit) => limit.limitId === 'five_hour')
          ?.primary?.usedPercent,
      ).toBe(10);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.anthropic.com/api/oauth/usage',
        {
          method: 'GET',
          headers: {
            Authorization: 'Bearer windows-claude-access-token',
            'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
            'anthropic-version': '2023-06-01',
          },
        },
      );
      expect(execFileMock).toHaveBeenCalledWith(
        'powershell.exe',
        expect.arrayContaining(['-EncodedCommand']),
        expect.objectContaining({
          windowsHide: true,
        }),
        expect.any(Function),
      );
    } finally {
      await service.dispose();
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        writable: true,
      });
      if (originalWindowsUsername === undefined) {
        delete process.env.USERNAME;
      } else {
        process.env.USERNAME = originalWindowsUsername;
      }
    }
  });

  it('explains when Windows Claude credentials are missing', async () => {
    const originalWindowsUsername = process.env.USERNAME;
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      writable: true,
    });
    process.env.USERNAME = 'windows-user';
    mockedReadFile.mockRejectedValue(fileNotFoundError());
    execFileMock.mockImplementation(
      (
        file: string,
        _args: string[],
        _options: unknown,
        callback: (
          error: Error | null,
          stdout?: string,
          stderr?: string,
        ) => void,
      ): void => {
        if (file === 'powershell.exe') {
          callback(null, '', '');
          return;
        }
        callback(new Error('unavailable'));
      },
    );

    const service = new ObservabilityService();
    try {
      await service.refreshProviderUsage('claude');
      const summary = service
        .loadSnapshot()
        .usage.providers.find((entry) => entry.provider === 'claude');
      expect(summary?.error).toBe(
        'Claude credentials were not found in the Windows Claude config or legacy Credential Manager. Sign in to Claude Code from Windows (a WSL-only login is stored separately), then refresh.',
      );
    } finally {
      await service.dispose();
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        writable: true,
      });
      if (originalWindowsUsername === undefined) {
        delete process.env.USERNAME;
      } else {
        process.env.USERNAME = originalWindowsUsername;
      }
    }
  });

  it('reports Windows Credential Manager read failures', async () => {
    const originalWindowsUsername = process.env.USERNAME;
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      writable: true,
    });
    process.env.USERNAME = 'windows-user';
    mockedReadFile.mockRejectedValue(fileNotFoundError());
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null) => void,
      ): void => callback(new Error('PowerShell failed')),
    );

    const service = new ObservabilityService();
    try {
      await service.refreshProviderUsage('claude');
      const summary = service
        .loadSnapshot()
        .usage.providers.find((entry) => entry.provider === 'claude');
      expect(summary?.error).toBe(
        'Could not read Claude credentials from Windows Credential Manager. Sign in to Claude Code from Windows again, then refresh.',
      );
    } finally {
      await service.dispose();
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        writable: true,
      });
      if (originalWindowsUsername === undefined) {
        delete process.env.USERNAME;
      } else {
        process.env.USERNAME = originalWindowsUsername;
      }
    }
  });

  it('reports malformed Windows Claude credentials', async () => {
    const originalWindowsUsername = process.env.USERNAME;
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      writable: true,
    });
    process.env.USERNAME = 'windows-user';
    mockedReadFile.mockRejectedValue(fileNotFoundError());
    execFileMock.mockImplementation(
      (
        file: string,
        _args: string[],
        _options: unknown,
        callback: (
          error: Error | null,
          stdout?: string,
          stderr?: string,
        ) => void,
      ): void => {
        if (file === 'powershell.exe') {
          callback(
            null,
            Buffer.from('not-json', 'utf8').toString('base64'),
            '',
          );
          return;
        }
        callback(new Error('unavailable'));
      },
    );

    const service = new ObservabilityService();
    try {
      await service.refreshProviderUsage('claude');
      const summary = service
        .loadSnapshot()
        .usage.providers.find((entry) => entry.provider === 'claude');
      expect(summary?.error).toBe(
        'The stored Claude credential is invalid or unreadable. Sign in to Claude Code again, then refresh.',
      );
    } finally {
      await service.dispose();
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        writable: true,
      });
      if (originalWindowsUsername === undefined) {
        delete process.env.USERNAME;
      } else {
        process.env.USERNAME = originalWindowsUsername;
      }
    }
  });

  it('skips the Windows usage check when the CLI auth probe reports logged out', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      writable: true,
    });
    mockedCheckClaudeAuthStatusObserved.mockResolvedValueOnce({
      authenticated: false,
      accountLabel: null,
      detail: null,
      error: null,
    });
    mockedReadFile.mockResolvedValueOnce(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'windows-file-access-token',
          subscriptionType: 'max',
          rateLimitTier: 'default_claude_max_20x',
        },
      }),
    );

    const service = new ObservabilityService();
    try {
      await service.refreshProviderUsage('claude');
      const summary = service
        .loadSnapshot()
        .usage.providers.find((entry) => entry.provider === 'claude');
      expect(summary).toMatchObject({
        authState: 'unauthenticated',
        hasRemainingLimits: false,
      });
      expect(summary?.error).toBeUndefined();
      expect(mockedReadFile).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await service.dispose();
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        writable: true,
      });
    }
  });

  it('omits Ollama from usage providers', async () => {
    const service = new ObservabilityService();
    await service.start();

    expect(
      service
        .loadSnapshot()
        .usage.providers.some((entry) => entry.provider === 'ollama'),
    ).toBe(false);

    await service.dispose();
  });

  describe('account snapshot retention', () => {
    it('preserves hidden Cursor snapshots through flush, disabled restart and disposal', async () => {
      const files = installMockFilesystem();
      mockCursorEnabled.mockReturnValue(true);
      mockedReadPreferencesFile.mockResolvedValue({
        ...makePreferences(30),
        cursorEnabled: true,
      });
      readCursorAccountUsageMock.mockResolvedValue({
        provider: 'cursor',
        authState: 'authenticated',
        hasRemainingLimits: true,
        accountEmail: 'retained@example.com',
        subscriptionLabel: 'Pro',
        rateLimits: [
          {
            limitId: 'cursor-plan',
            primary: { usedPercent: 25, resetsAt: '2099-01-01T00:00:00.000Z' },
          },
        ],
      });
      const service = new ObservabilityService();
      const disabled = new ObservabilityService();
      const restored = new ObservabilityService();
      try {
        await service.refreshProviderUsage('cursor');
        const retained = service.loadSnapshot().usage.accountSnapshots;
        expect(retained).toEqual([
          expect.objectContaining({
            provider: 'cursor',
            accountEmail: 'retained@example.com',
          }),
        ]);
        mockCursorEnabled.mockReturnValue(false);
        service.invalidateCursorUsage();
        expect(service.loadSnapshot().usage.accountSnapshots).toEqual([]);
        await service.flush();
        expect(files.get('/mock/observability/snapshot.json')).toContain(
          'retained@example.com',
        );
        await service.dispose();
        await disabled.start();
        expect(disabled.loadSnapshot().usage.accountSnapshots).toEqual([]);
        await disabled.dispose();
        mockCursorEnabled.mockReturnValue(true);
        readCursorAccountUsageMock.mockResolvedValue({
          provider: 'cursor',
          authState: 'unauthenticated',
          hasRemainingLimits: false,
        });
        await restored.start();
        expect(restored.loadSnapshot().usage.accountSnapshots).toEqual(
          retained,
        );
      } finally {
        mockCursorEnabled.mockReturnValue(true);
        await service.dispose();
        await disabled.dispose();
        await restored.dispose();
      }
    });

    it('retains an authenticated account snapshot with a future reset and hydrates it from disk after reload', async () => {
      const files = installMockFilesystem();

      mockedCheckClaudeAuthStatusObserved.mockResolvedValueOnce({
        authenticated: true,
        accountLabel: 'a@x.com',
        detail: 'claude.ai (max)',
        error: null,
      });
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            five_hour: {
              utilization: 10,
              resets_at: '2099-01-01T00:00:00.000Z',
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      );

      const service = new ObservabilityService();
      try {
        await service.refreshProviderUsage('claude');

        const accountSnapshots = service.loadSnapshot().usage.accountSnapshots;
        expect(accountSnapshots).toEqual([
          expect.objectContaining({
            provider: 'claude',
            accountKey: 'claude:a@x.com:claude max 5x',
            accountEmail: 'a@x.com',
            subscriptionLabel: 'Claude Max 5x',
          }),
        ]);

        await service.flush();
        expect(files.get('/mock/observability/snapshot.json')).toContain(
          '"accountKey": "claude:a@x.com:claude max 5x"',
        );
      } finally {
        await service.dispose();
      }

      const rehydrated = new ObservabilityService();
      try {
        await rehydrated.start();
        expect(rehydrated.loadSnapshot().usage.accountSnapshots).toEqual([
          expect.objectContaining({
            provider: 'claude',
            accountKey: 'claude:a@x.com:claude max 5x',
          }),
        ]);
      } finally {
        await rehydrated.dispose();
      }
    });

    it('preserves a retained account snapshot when Claude usage refresh returns no rate limits', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            five_hour: {
              utilization: 10,
              resets_at: '2099-01-01T00:00:00.000Z',
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      );

      const service = new ObservabilityService();
      try {
        await service.refreshProviderUsage('claude');
        const retainedBeforeFailure =
          service.loadSnapshot().usage.accountSnapshots;
        const clock = installDateNowClock(Date.now());
        clock.advance(30_001);

        fetchMock.mockResolvedValueOnce(
          new Response('unauthorized', { status: 401 }),
        );

        try {
          await service.refreshProviderUsage('claude');
        } finally {
          clock.restore();
        }

        expect(service.loadSnapshot().usage.accountSnapshots).toEqual(
          retainedBeforeFailure,
        );
        expect(
          service
            .loadSnapshot()
            .usage.providers.find((entry) => entry.provider === 'claude')
            ?.error,
        ).toBe(
          'Claude rejected the stored credential (HTTP 401). Sign in to Claude Code again, then refresh.',
        );
      } finally {
        await service.dispose();
      }
    });
  });

  describe('Claude usage fetch gate and SDK rate-limit events', () => {
    it('uses one same-account HTTP read for a burst after interactive freshness expires', async () => {
      const service = new ObservabilityService();
      await service.start();
      fetchMock.mockClear();
      mockedCheckClaudeAuthStatusObserved.mockClear();
      const clock = installDateNowClock(Date.now());
      const deferredFetch = createDeferred<Response>();
      fetchMock.mockReturnValueOnce(deferredFetch.promise);

      try {
        clock.advance(30_001);
        const first = service.refreshProviderUsage('claude');
        await waitForCondition(() => fetchMock.mock.calls.length === 1);

        const burst = Array.from({ length: 9 }, () =>
          service.refreshProviderUsage('claude'),
        );
        await waitForCondition(
          () => mockedCheckClaudeAuthStatusObserved.mock.calls.length >= 10,
        );

        expect(fetchMock).toHaveBeenCalledTimes(1);
        deferredFetch.resolve(createClaudeUsageResponse(25, 65));
        await Promise.all([first, ...burst]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        clock.restore();
        await service.dispose();
      }
    });

    it('does not lose the newest publication when an auth read finishes after an older HTTP read', async () => {
      const service = new ObservabilityService();
      await service.start();
      fetchMock.mockClear();
      mockedCheckClaudeAuthStatusObserved.mockClear();
      const clock = installDateNowClock(Date.now());
      clock.advance(30_001);
      const oldFetch = createDeferred<Response>();
      const newestAuth =
        createDeferred<
          Awaited<
            ReturnType<typeof providerAuthState.checkClaudeAuthStatusObserved>
          >
        >();
      fetchMock
        .mockReturnValueOnce(oldFetch.promise)
        .mockResolvedValueOnce(createClaudeUsageResponse(33, 77));
      mockedCheckClaudeAuthStatusObserved
        .mockResolvedValueOnce({
          authenticated: true,
          accountLabel: 'user@example.com',
          detail: 'claude.ai (max)',
          error: null,
        })
        .mockImplementationOnce(() => newestAuth.promise);

      try {
        const oldRefresh = service.refreshProviderUsage('claude');
        await waitForCondition(() => fetchMock.mock.calls.length === 1);
        const newestRefresh = service.refreshProviderUsage('claude');

        oldFetch.resolve(createClaudeUsageResponse(22, 66));
        await oldRefresh;
        newestAuth.resolve({
          authenticated: true,
          accountLabel: 'user@example.com',
          detail: 'claude.ai (max)',
          error: null,
        });
        await newestRefresh;

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(
          service
            .getUsageOverview()
            .providers.find((entry) => entry.provider === 'claude')
            ?.rateLimits?.find((limit) => limit.limitId === 'five_hour')
            ?.primary?.usedPercent,
        ).toBe(33);
      } finally {
        clock.restore();
        await service.dispose();
      }
    });

    it('skips an interactive read while the same account is still fresh', async () => {
      const service = new ObservabilityService();
      await service.start();
      fetchMock.mockClear();

      try {
        await service.refreshProviderUsage('claude');
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        await service.dispose();
      }
    });

    it('fetches for a new login even when the previous account is fresh', async () => {
      const service = new ObservabilityService();
      await service.start();
      fetchMock.mockClear();
      mockedCheckClaudeAuthStatusObserved.mockResolvedValue({
        authenticated: true,
        accountLabel: 'New.User@example.com',
        detail: 'claude.ai (max)',
        error: null,
      });

      try {
        await Promise.all(
          Array.from({ length: 5 }, () =>
            service.refreshProviderUsage('claude'),
          ),
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(findProviderUsage(service, 'claude').accountLabel).toBe(
          'New.User@example.com',
        );
      } finally {
        await service.dispose();
      }
    });

    it('blocks all same-account triggers during a 429 cooldown and retains only that account', async () => {
      const service = new ObservabilityService();
      await service.start();
      const seeded = service
        .getUsageOverview()
        .providers.find((entry) => entry.provider === 'claude');
      if (!seeded) throw new Error('Expected Claude usage summary');
      fetchMock.mockClear();
      const clock = installDateNowClock(Date.now());
      mockLogMainProcessWarn.mockClear();

      try {
        clock.advance(30_001);
        fetchMock.mockResolvedValueOnce(
          new Response('too many requests', {
            status: 429,
            headers: { 'retry-after': '120' },
          }),
        );
        await service.refreshProviderUsage('claude');

        const limited = service
          .getUsageOverview()
          .providers.find((entry) => entry.provider === 'claude');
        expect(limited).toMatchObject({
          authState: 'authenticated',
          accountEmail: 'user@example.com',
          rateLimits: seeded.rateLimits,
          lastUpdatedAt: seeded.lastUpdatedAt,
        });
        expect(limited?.errorInfo?.kind).toBe('rate_limited');
        expect(limited?.errorInfo?.retryAt).toBe(
          new Date(Date.now() + 120_000).toISOString(),
        );
        expect(limited?.errorInfo?.detail).toContain(
          'GET /api/oauth/usage responded 429',
        );
        expect(limited?.errorInfo?.message).toBeUndefined();

        await Promise.all(
          Array.from({ length: 5 }, () =>
            service.refreshProviderUsage('claude'),
          ),
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(mockLogMainProcessWarn).toHaveBeenCalledTimes(1);
        expect(mockLogMainProcessWarn).toHaveBeenCalledWith(
          expect.stringContaining('Claude usage'),
          expect.objectContaining({ cooldownMs: 120_000, reason: 'http_429' }),
        );
        expect(
          service
            .getUsageOverview()
            .providers.find((entry) => entry.provider === 'claude')?.errorInfo
            ?.message,
        ).toBeUndefined();

        // A different login has a different gate key and never inherits the
        // previous account's live numbers or timestamp.
        mockedCheckClaudeAuthStatusObserved.mockResolvedValue({
          authenticated: true,
          accountLabel: 'new@example.com',
          detail: 'claude.ai (pro)',
          error: null,
        });
        fetchMock.mockResolvedValueOnce(
          new Response('too many requests', {
            status: 429,
            headers: { 'retry-after': '120' },
          }),
        );
        await service.refreshProviderUsage('claude');

        const newAccount = service
          .getUsageOverview()
          .providers.find((entry) => entry.provider === 'claude');
        expect(newAccount).toMatchObject({
          accountEmail: 'new@example.com',
          hasRemainingLimits: false,
          errorInfo: { kind: 'rate_limited' },
        });
        expect(newAccount?.rateLimits).toBeUndefined();
        expect(newAccount?.lastUpdatedAt).toBeUndefined();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(mockLogMainProcessWarn).toHaveBeenCalledTimes(2);
      } finally {
        clock.restore();
        await service.dispose();
      }
    });

    it('clears a 429 error on the first successful read after cooldown', async () => {
      const service = new ObservabilityService();
      await service.start();
      const clock = installDateNowClock(Date.now());
      fetchMock.mockClear();
      try {
        clock.advance(30_001);
        fetchMock.mockResolvedValueOnce(
          new Response(null, {
            status: 429,
            headers: { 'Retry-After': '120' },
          }),
        );
        await service.refreshProviderUsage('claude');
        clock.advance(119_999);
        await service.refreshProviderUsage('claude', { joinInFlight: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        clock.advance(1);
        fetchMock.mockResolvedValueOnce(createClaudeUsageResponse(24, 70));
        await service.refreshProviderUsage('claude');
        const summary = service
          .getUsageOverview()
          .providers.find((provider) => provider.provider === 'claude');
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(summary?.error).toBeUndefined();
        expect(summary?.errorInfo).toBeUndefined();
        expect(summary?.rateLimits?.[0]?.primary?.usedPercent).toBe(24);
      } finally {
        clock.restore();
        await service.dispose();
      }
    });

    it('publishes a cold 429 retry time without inventing usage numbers', async () => {
      const service = new ObservabilityService();
      fetchMock.mockResolvedValueOnce(
        new Response('too many requests', {
          status: 429,
          headers: { 'retry-after': '120' },
        }),
      );

      try {
        await service.refreshProviderUsage('claude');
        const summary = service
          .getUsageOverview()
          .providers.find((entry) => entry.provider === 'claude');
        expect(summary).toMatchObject({
          hasRemainingLimits: false,
        });
        expect(summary?.errorInfo?.kind).toBe('rate_limited');
        expect(typeof summary?.errorInfo?.retryAt).toBe('string');
        expect(summary?.errorInfo?.detail).toContain(
          'GET /api/oauth/usage responded 429',
        );
        expect(summary?.errorInfo?.message).toBeUndefined();
        expect(summary?.rateLimits).toBeUndefined();
        expect(summary?.lastUpdatedAt).toBeUndefined();
      } finally {
        await service.dispose();
      }
    });

    it('retains same-account values on a 5xx but does not cooldown the next read', async () => {
      const service = new ObservabilityService();
      await service.start();
      const seeded = service
        .getUsageOverview()
        .providers.find((entry) => entry.provider === 'claude');
      if (!seeded) throw new Error('Expected Claude usage summary');
      fetchMock.mockClear();
      const clock = installDateNowClock(Date.now());

      try {
        clock.advance(30_001);
        fetchMock.mockResolvedValueOnce(
          new Response('temporarily unavailable', { status: 503 }),
        );
        await service.refreshProviderUsage('claude');
        expect(
          service
            .getUsageOverview()
            .providers.find((entry) => entry.provider === 'claude'),
        ).toMatchObject({
          rateLimits: seeded.rateLimits,
          lastUpdatedAt: seeded.lastUpdatedAt,
          errorInfo: { kind: 'service' },
        });

        fetchMock.mockResolvedValueOnce(createClaudeUsageResponse(22, 70));
        await service.refreshProviderUsage('claude');
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(
          service
            .getUsageOverview()
            .providers.find((entry) => entry.provider === 'claude')
            ?.rateLimits?.find((limit) => limit.limitId === 'five_hour')
            ?.primary?.usedPercent,
        ).toBe(22);
      } finally {
        clock.restore();
        await service.dispose();
      }
    });

    it.each([
      ['API key', 'api_key', false, false],
      ['AI Credits', 'subscription', true, false],
      ['account proxy', 'subscription', false, true],
    ] as const)(
      'does not schedule a Claude turn refresh billed by %s',
      async (_label, accountKind, aiCreditsRouted, accountProxyRouted) => {
        const service = new ObservabilityService();
        await service.start();
        fetchMock.mockClear();
        const billingKind = jest
          .spyOn(providerAuthState, 'peekProviderBillingAccountKind')
          .mockReturnValue(accountKind);
        jest.useFakeTimers();
        jest.setSystemTime(new Date(Date.now() + 181_000));

        try {
          service.startChatTurn({
            projectId: 'proj',
            worktreeId: 'wt',
            chatId: 'unbilled',
            provider: 'claude',
            originalUserText: 'Inspect usage',
            submittedText: 'Inspect usage',
            planMode: false,
            isStandalone: false,
            aiCreditsRouted,
            accountProxyRouted,
          });
          service.completeChatTurn('proj', 'wt', 'unbilled', 'success');
          await jest.advanceTimersByTimeAsync(60_000);

          expect(fetchMock).not.toHaveBeenCalled();
        } finally {
          jest.useRealTimers();
          billingKind.mockRestore();
          await service.dispose();
        }
      },
    );

    it('debounces ten subscription turn completions into one trailing read', async () => {
      const service = new ObservabilityService();
      await service.start();
      fetchMock.mockClear();
      const billingKind = jest
        .spyOn(providerAuthState, 'peekProviderBillingAccountKind')
        .mockReturnValue('subscription');
      jest.useFakeTimers();
      jest.setSystemTime(new Date(Date.now() + 181_000));

      try {
        service.startChatTurn({
          projectId: 'proj',
          worktreeId: 'wt',
          chatId: 'first',
          provider: 'claude',
          originalUserText: 'First',
          submittedText: 'First',
          planMode: false,
          isStandalone: false,
        });
        service.completeChatTurn('proj', 'wt', 'first', 'success');
        await jest.advanceTimersByTimeAsync(20_000);
        for (let index = 1; index < 10; index += 1) {
          const chatId = `burst-${index}`;
          service.startChatTurn({
            projectId: 'proj',
            worktreeId: 'wt',
            chatId,
            provider: 'claude',
            originalUserText: 'Another turn',
            submittedText: 'Another turn',
            planMode: false,
            isStandalone: false,
          });
          service.completeChatTurn('proj', 'wt', chatId, 'success');
        }

        await jest.advanceTimersByTimeAsync(29_999);
        expect(fetchMock).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(1);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
        billingKind.mockRestore();
        await service.dispose();
      }
    });

    it('bounds recurring Claude turn refreshes by a five-minute max wait', async () => {
      const service = new ObservabilityService();
      await service.start();
      fetchMock.mockClear();
      const billingKind = jest
        .spyOn(providerAuthState, 'peekProviderBillingAccountKind')
        .mockReturnValue('subscription');
      jest.useFakeTimers();
      jest.setSystemTime(new Date(Date.now() + 181_000));

      try {
        for (let index = 0; index < 15; index += 1) {
          if (index > 0) await jest.advanceTimersByTimeAsync(20_000);
          const chatId = `continuous-${index}`;
          service.startChatTurn({
            projectId: 'proj',
            worktreeId: 'wt',
            chatId,
            provider: 'claude',
            originalUserText: 'Inspect usage',
            submittedText: 'Inspect usage',
            planMode: false,
            isStandalone: false,
          });
          service.completeChatTurn('proj', 'wt', chatId, 'success');
        }

        await jest.advanceTimersByTimeAsync(19_999);
        expect(fetchMock).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(1);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
        billingKind.mockRestore();
        await service.dispose();
      }
    });

    it('allows only a matching subscription SDK rate-limit event to patch usage', async () => {
      installMockFilesystem();
      const service = new ObservabilityService();
      await service.start();
      fetchMock.mockClear();
      const identity = jest
        .spyOn(providerAuthState, 'peekProviderAccountIdentity')
        .mockReturnValue({
          providerAccountKey: 'claude:user@example.com',
          accountEmail: 'USER@EXAMPLE.COM',
          planType: 'max',
        });
      const billingKind = jest
        .spyOn(providerAuthState, 'peekProviderBillingAccountKind')
        .mockReturnValue('subscription');
      const usageEvents: AgentObservabilityUpdateEvent[] = [];
      let unsubscribe = (): void => {};
      const before = service
        .getUsageOverview()
        .providers.find((entry) => entry.provider === 'claude');
      if (!before) throw new Error('Expected Claude usage summary');

      try {
        service.startChatTurn({
          projectId: 'proj',
          worktreeId: 'wt',
          chatId: 'sdk-rate-limit',
          provider: 'claude',
          originalUserText: 'Inspect limits',
          submittedText: 'Inspect limits',
          planMode: false,
          isStandalone: false,
        });
        unsubscribe = service.subscribe((event) => {
          if (event.type === 'usage') usageEvents.push(event);
        });
        service.observeChatEvent('proj', 'wt', 'sdk-rate-limit', {
          type: 'rate_limit_event',
          rate_limit_info: {
            status: 'allowed_warning',
            rateLimitType: 'five_hour',
            utilization: 0.77,
            resetsAt: 1_800_000_000,
          },
        });

        const after = service
          .getUsageOverview()
          .providers.find((entry) => entry.provider === 'claude');
        expect(
          after?.rateLimits?.find((limit) => limit.limitId === 'five_hour'),
        ).toMatchObject({
          primary: {
            usedPercent: 77,
            resetsAt: new Date(1_800_000_000 * 1_000).toISOString(),
          },
        });
        expect(after?.lastUpdatedAt).toBe(before.lastUpdatedAt);
        expect(usageEvents).toHaveLength(1);
        expect(fetchMock).not.toHaveBeenCalled();

        await service.flush();
        const entry = loadRecentEntryForChat(service, 'sdk-rate-limit');
        const transcript = await service.loadTranscript({
          id: entry.id,
          eventType: entry.eventType,
          startedAt: entry.startedAt,
        });
        expect(transcript.type).toBe('success');
        if (transcript.type !== 'success') {
          throw new Error('Expected Claude SDK transcript');
        }
        expect(transcript.lines.join('\n')).not.toContain('rate_limit_event');
      } finally {
        unsubscribe();
        identity.mockRestore();
        billingKind.mockRestore();
        await service.dispose();
      }
    });

    it('ignores Claude SDK events for non-subscription, absent-basis, mismatched-account, or alias payloads', async () => {
      const service = new ObservabilityService();
      await service.start();
      fetchMock.mockClear();
      const identity = jest
        .spyOn(providerAuthState, 'peekProviderAccountIdentity')
        .mockReturnValue({
          providerAccountKey: 'claude:other@example.com',
          accountEmail: 'other@example.com',
          planType: 'max',
        });
      const billingKind = jest
        .spyOn(providerAuthState, 'peekProviderBillingAccountKind')
        .mockReturnValue('subscription');
      const usageEvents: AgentObservabilityUpdateEvent[] = [];
      const unsubscribe = service.subscribe((event) => {
        if (event.type === 'usage') usageEvents.push(event);
      });
      const original = service
        .getUsageOverview()
        .providers.find((entry) => entry.provider === 'claude');

      try {
        service.startChatTurn({
          projectId: 'proj',
          worktreeId: 'wt',
          chatId: 'different-account',
          provider: 'claude',
          originalUserText: 'Inspect',
          submittedText: 'Inspect',
          planMode: false,
          isStandalone: false,
        });
        service.observeChatEvent('proj', 'wt', 'different-account', {
          type: 'rate_limit_event',
          rate_limit_info: {
            status: 'rejected',
            rateLimitType: 'five_hour',
          },
        });

        identity.mockReturnValue({
          providerAccountKey: 'claude:user@example.com',
          accountEmail: 'user@example.com',
          planType: 'max',
        });
        billingKind.mockReturnValue('api_key');
        service.startChatTurn({
          projectId: 'proj',
          worktreeId: 'wt',
          chatId: 'api-key',
          provider: 'claude',
          originalUserText: 'Inspect',
          submittedText: 'Inspect',
          planMode: false,
          isStandalone: false,
        });
        service.observeChatEvent('proj', 'wt', 'api-key', {
          type: 'rate_limit_event',
          rate_limit_info: {
            status: 'rejected',
            rateLimitType: 'five_hour',
          },
        });

        billingKind.mockReturnValue('unknown');
        service.startChatTurn({
          projectId: 'proj',
          worktreeId: 'wt',
          chatId: 'absent-basis',
          provider: 'claude',
          originalUserText: 'Inspect',
          submittedText: 'Inspect',
          planMode: false,
          isStandalone: false,
        });
        const openEntries: unknown = Reflect.get(service, 'openEntries');
        if (!(openEntries instanceof Map)) {
          throw new Error('Expected the service open-entry map');
        }
        const openEntry: unknown = openEntries.get('chat:proj/wt/absent-basis');
        if (typeof openEntry !== 'object' || openEntry === null) {
          throw new Error('Expected an open Claude entry');
        }
        const entry: unknown = Reflect.get(openEntry, 'entry');
        if (typeof entry !== 'object' || entry === null) {
          throw new Error('Expected an open Claude audit entry');
        }
        Reflect.deleteProperty(entry, 'billingBasis');
        service.observeChatEvent('proj', 'wt', 'absent-basis', {
          type: 'rate_limit_event',
          rate_limit_info: {
            status: 'rejected',
            rateLimitType: 'five_hour',
          },
        });

        identity.mockReturnValue({
          providerAccountKey: 'claude:user@example.com',
          accountEmail: 'user@example.com',
          planType: 'max',
        });
        billingKind.mockReturnValue('subscription');
        service.startChatTurn({
          projectId: 'proj',
          worktreeId: 'wt',
          chatId: 'alias-payload',
          provider: 'claude',
          originalUserText: 'Inspect',
          submittedText: 'Inspect',
          planMode: false,
          isStandalone: false,
        });
        service.observeChatEvent('proj', 'wt', 'alias-payload', {
          type: 'rate_limit_event',
          rateLimitInfo: {
            status: 'rejected',
            rateLimitType: 'five_hour',
          },
        });

        usageEvents.length = 0;
        expect(
          service
            .getUsageOverview()
            .providers.find((entry) => entry.provider === 'claude'),
        ).toEqual(original);
        expect(usageEvents).toHaveLength(0);
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        unsubscribe();
        identity.mockRestore();
        billingKind.mockRestore();
        await service.dispose();
      }
    });

    it('keeps SDK fields newer than an in-flight HTTP request while updating other windows', async () => {
      const service = new ObservabilityService();
      await service.start();
      fetchMock.mockClear();
      const identity = jest
        .spyOn(providerAuthState, 'peekProviderAccountIdentity')
        .mockReturnValue({
          providerAccountKey: 'claude:user@example.com',
          accountEmail: 'user@example.com',
          planType: 'max',
        });
      const billingKind = jest
        .spyOn(providerAuthState, 'peekProviderBillingAccountKind')
        .mockReturnValue('subscription');
      const clock = installDateNowClock(Date.now());
      clock.advance(30_001);
      const deferredFetch = createDeferred<Response>();
      fetchMock.mockReturnValueOnce(deferredFetch.promise);

      try {
        const refresh = service.refreshProviderUsage('claude');
        await waitForCondition(() => fetchMock.mock.calls.length === 1);
        service.startChatTurn({
          projectId: 'proj',
          worktreeId: 'wt',
          chatId: 'pending-http',
          provider: 'claude',
          originalUserText: 'Inspect limits',
          submittedText: 'Inspect limits',
          planMode: false,
          isStandalone: false,
        });
        service.observeChatEvent('proj', 'wt', 'pending-http', {
          type: 'rate_limit_event',
          rate_limit_info: {
            status: 'allowed_warning',
            rateLimitType: 'five_hour',
            utilization: 0.77,
            resetsAt: 1_800_000_000,
          },
        });

        deferredFetch.resolve(createClaudeUsageResponse(22, 75));
        await refresh;

        const summary = service
          .getUsageOverview()
          .providers.find((entry) => entry.provider === 'claude');
        expect(
          summary?.rateLimits?.find((limit) => limit.limitId === 'five_hour'),
        ).toMatchObject({
          limitName: '5-hour window',
          primary: {
            usedPercent: 77,
            resetsAt: new Date(1_800_000_000 * 1_000).toISOString(),
          },
        });
        expect(
          summary?.rateLimits?.find((limit) => limit.limitId === 'seven_day')
            ?.primary?.usedPercent,
        ).toBe(75);
      } finally {
        clock.restore();
        identity.mockRestore();
        billingKind.mockRestore();
        await service.dispose();
      }
    });

    it.each([
      {
        name: 'reset-only event',
        info: { resetsAt: 1_800_000_000 },
        expectedUsage: 22,
        expectedReset: '2027-01-15T08:00:00.000Z',
      },
      {
        name: 'utilization-only event',
        info: { utilization: 0.77 },
        expectedUsage: 77,
        expectedReset: '2026-03-27T06:00:00.000Z',
      },
      {
        name: 'unchanged utilization event',
        info: { utilization: 0.1 },
        expectedUsage: 10,
        expectedReset: '2026-03-27T06:00:00.000Z',
      },
      {
        name: 'unchanged reset event',
        info: { resetsAt: Date.parse('2026-03-27T04:00:00.000Z') / 1000 },
        expectedUsage: 22,
        expectedReset: '2026-03-27T04:00:00.000Z',
      },
    ])(
      'preserves per-field observation order for $name',
      async ({ name, info, expectedUsage, expectedReset }) => {
        const service = new ObservabilityService();
        await service.start();
        fetchMock.mockClear();
        const identity = jest
          .spyOn(providerAuthState, 'peekProviderAccountIdentity')
          .mockReturnValue({
            providerAccountKey: 'claude:user@example.com',
            accountEmail: 'user@example.com',
            planType: 'max',
          });
        const billingKind = jest
          .spyOn(providerAuthState, 'peekProviderBillingAccountKind')
          .mockReturnValue('subscription');
        const clock = installDateNowClock(Date.now());
        clock.advance(30_001);
        const deferredFetch = createDeferred<Response>();
        fetchMock.mockReturnValueOnce(deferredFetch.promise);

        try {
          const refresh = service.refreshProviderUsage('claude');
          await waitForCondition(() => fetchMock.mock.calls.length === 1);
          service.startChatTurn({
            projectId: 'proj',
            worktreeId: 'wt',
            chatId: 'pending-http',
            provider: 'claude',
            originalUserText: 'Inspect limits',
            submittedText: 'Inspect limits',
            planMode: false,
            isStandalone: false,
          });
          const usageUpdate = jest.fn();
          const unsubscribe = service.subscribe((event) => {
            if (event.type === 'usage') usageUpdate();
          });
          service.observeChatEvent('proj', 'wt', 'pending-http', {
            type: 'rate_limit_event',
            rate_limit_info: {
              status: 'allowed_warning',
              rateLimitType: 'five_hour',
              ...info,
            },
          });

          expect(usageUpdate).toHaveBeenCalledTimes(
            name.startsWith('unchanged') ? 0 : 1,
          );
          unsubscribe();

          deferredFetch.resolve(
            new Response(
              JSON.stringify({
                five_hour: {
                  utilization: 22,
                  resets_at: '2026-03-27T06:00:00.000Z',
                },
                seven_day: {
                  utilization: 75,
                  resets_at: '2026-03-27T13:00:00.000Z',
                },
              }),
              { status: 200 },
            ),
          );
          await refresh;

          const summary = service
            .getUsageOverview()
            .providers.find((entry) => entry.provider === 'claude');
          expect(
            summary?.rateLimits?.find((limit) => limit.limitId === 'five_hour'),
          ).toMatchObject({
            limitName: '5-hour window',
            primary: {
              usedPercent: expectedUsage,
              resetsAt: expectedReset,
            },
          });
          expect(
            summary?.rateLimits?.find((limit) => limit.limitId === 'seven_day')
              ?.primary?.usedPercent,
          ).toBe(75);
        } finally {
          clock.restore();
          identity.mockRestore();
          billingKind.mockRestore();
          await service.dispose();
        }
      },
    );
  });

  it.each([
    {
      name: 'utilization-only HTTP response',
      window: { utilization: 22 },
      expectedUsage: 22,
      expectedReset: '2027-01-15T08:00:00.000Z',
    },
    {
      name: 'reset-only HTTP response',
      window: { resets_at: '2026-03-27T06:00:00.000Z' },
      expectedUsage: 77,
      expectedReset: '2026-03-27T06:00:00.000Z',
    },
  ])(
    'retains SDK fields omitted by a later $name',
    async ({ window, expectedUsage, expectedReset }) => {
      const service = new ObservabilityService();
      await service.start();
      fetchMock.mockClear();
      const identity = jest
        .spyOn(providerAuthState, 'peekProviderAccountIdentity')
        .mockReturnValue({
          providerAccountKey: 'claude:user@example.com',
          accountEmail: 'user@example.com',
          planType: 'max',
        });
      const billingKind = jest
        .spyOn(providerAuthState, 'peekProviderBillingAccountKind')
        .mockReturnValue('subscription');
      const clock = installDateNowClock(Date.now());
      try {
        service.startChatTurn({
          projectId: 'proj',
          worktreeId: 'wt',
          chatId: 'partial-http',
          provider: 'claude',
          originalUserText: 'Inspect limits',
          submittedText: 'Inspect limits',
          planMode: false,
          isStandalone: false,
        });
        service.observeChatEvent('proj', 'wt', 'partial-http', {
          type: 'rate_limit_event',
          rate_limit_info: {
            status: 'allowed_warning',
            rateLimitType: 'five_hour',
            utilization: 0.77,
            resetsAt: 1_800_000_000,
          },
        });
        for (let read = 0; read < 2; read += 1) {
          clock.advance(30_001);
          fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ five_hour: window }), {
              status: 200,
            }),
          );
          await service.refreshProviderUsage('claude');
          expect(
            service
              .getUsageOverview()
              .providers.find((entry) => entry.provider === 'claude')
              ?.rateLimits?.find((limit) => limit.limitId === 'five_hour')
              ?.primary,
          ).toMatchObject({
            usedPercent: expectedUsage,
            resetsAt: expectedReset,
          });
        }
        clock.advance(30_001);
        fetchMock.mockResolvedValueOnce(createClaudeUsageResponse(5, 80));
        await service.refreshProviderUsage('claude');
        expect(
          service
            .getUsageOverview()
            .providers.find((entry) => entry.provider === 'claude')
            ?.rateLimits?.find((limit) => limit.limitId === 'five_hour')
            ?.primary,
        ).toMatchObject({
          usedPercent: 5,
          resetsAt: '2026-03-27T04:00:00.000Z',
        });
      } finally {
        clock.restore();
        identity.mockRestore();
        billingKind.mockRestore();
        await service.dispose();
      }
    },
  );

  it.each([
    { name: 'older in-flight HTTP read', observeBeforeRead: false },
    { name: 'later HTTP read', observeBeforeRead: true },
  ])(
    'retains an SDK-patched window omitted by the $name',
    async ({ observeBeforeRead }) => {
      const service = new ObservabilityService();
      await service.start();
      fetchMock.mockClear();
      const identity = jest
        .spyOn(providerAuthState, 'peekProviderAccountIdentity')
        .mockReturnValue({
          providerAccountKey: 'claude:user@example.com',
          accountEmail: 'user@example.com',
          planType: 'max',
        });
      const billingKind = jest
        .spyOn(providerAuthState, 'peekProviderBillingAccountKind')
        .mockReturnValue('subscription');
      const clock = installDateNowClock(Date.now());
      const observeUsage = (utilization: number): void => {
        service.observeChatEvent('proj', 'wt', 'missing-window', {
          type: 'rate_limit_event',
          rate_limit_info: {
            status: 'allowed_warning',
            rateLimitType: 'five_hour',
            utilization,
            resetsAt: 1_800_000_000,
          },
        });
      };
      const limits = (): ReturnType<
        ObservabilityService['getUsageOverview']
      >['providers'][number]['rateLimits'] =>
        service
          .getUsageOverview()
          .providers.find((entry) => entry.provider === 'claude')?.rateLimits;
      try {
        service.startChatTurn({
          projectId: 'proj',
          worktreeId: 'wt',
          chatId: 'missing-window',
          provider: 'claude',
          originalUserText: 'Inspect limits',
          submittedText: 'Inspect limits',
          planMode: false,
          isStandalone: false,
        });
        if (observeBeforeRead) observeUsage(0.77);
        clock.advance(30_001);
        const deferredFetch = createDeferred<Response>();
        fetchMock.mockReturnValueOnce(deferredFetch.promise);
        const refresh = service.refreshProviderUsage('claude');
        await waitForCondition(() => fetchMock.mock.calls.length === 1);
        if (!observeBeforeRead) observeUsage(0.77);
        deferredFetch.resolve(
          new Response(JSON.stringify({ seven_day: { utilization: 75 } }), {
            status: 200,
          }),
        );
        await refresh;
        expect(
          limits()?.find((limit) => limit.limitId === 'five_hour'),
        ).toMatchObject({
          limitName: '5-hour window',
          primary: {
            usedPercent: 77,
            resetsAt: '2027-01-15T08:00:00.000Z',
          },
        });
        expect(
          limits()?.find((limit) => limit.limitId === 'seven_day')?.primary
            ?.usedPercent,
        ).toBe(75);
        observeUsage(0.88);
        expect(
          limits()?.find((limit) => limit.limitId === 'five_hour')?.primary
            ?.usedPercent,
        ).toBe(88);
        clock.advance(30_001);
        fetchMock.mockResolvedValueOnce(createClaudeUsageResponse(5, 80));
        await service.refreshProviderUsage('claude');
        expect(
          limits()?.find((limit) => limit.limitId === 'five_hour')?.primary,
        ).toMatchObject({
          usedPercent: 5,
          resetsAt: '2026-03-27T04:00:00.000Z',
        });
      } finally {
        clock.restore();
        identity.mockRestore();
        billingKind.mockRestore();
        await service.dispose();
      }
    },
  );

  it('includes Codex account state in usage providers', async () => {
    const service = new ObservabilityService();
    await service.start();

    expect(findProviderUsage(service, 'codex')).toEqual({
      authState: 'authenticated',
      accountLabel: 'user@example.com',
    });

    await service.dispose();
  });

  it('keeps Claude auth state even when live usage limits cannot be fetched', async () => {
    fetchMock.mockRejectedValueOnce(new Error('usage unavailable'));

    const service = new ObservabilityService();
    await service.start();

    const summary = service
      .loadSnapshot()
      .usage.providers.find((entry) => entry.provider === 'claude');

    expect(summary).toMatchObject({
      authState: 'authenticated',
      accountLabel: 'user@example.com',
      subscriptionLabel: 'Claude Max 5x',
      hasRemainingLimits: false,
      error: 'Could not reach the Claude usage service.',
      errorInfo: {
        kind: 'network',
        message: 'Could not reach the Claude usage service.',
        detail: 'usage unavailable',
      },
    });
    expect(summary?.rateLimits).toBeUndefined();

    await service.dispose();
  });

  it('normalizes Codex reset timestamps and preserves window durations', async () => {
    readRateLimitsMock.mockResolvedValue({
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex',
          limitName: 'Codex',
          planType: 'team',
          primary: {
            usedPercent: 12,
            windowDurationMins: 5,
            resetsAt: 1_710_000_300,
          },
          secondary: {
            usedPercent: 55,
            windowDurationMins: 60,
            resetsAt: 1_710_003_600,
          },
          credits: null,
        },
      },
      rateLimits: {},
    });

    const service = new ObservabilityService();
    await service.start();

    const summary = service
      .loadSnapshot()
      .usage.providers.find((entry) => entry.provider === 'codex');
    const codexLimit = summary?.rateLimits?.find(
      (limit) => limit.limitId === 'codex',
    );

    expect(codexLimit?.primary?.resetsAt).toBe('2024-03-09T16:05:00.000Z');
    expect(codexLimit?.secondary?.resetsAt).toBe('2024-03-09T17:00:00.000Z');
    expect(codexLimit?.primary?.windowDurationMins).toBe(5);
    expect(codexLimit?.secondary?.windowDurationMins).toBe(60);

    await service.dispose();
  });

  it('marks Codex authenticated when account details exist even if requiresOpenaiAuth is true', async () => {
    readAccountMock.mockResolvedValue({
      requiresOpenaiAuth: true,
      account: {
        type: 'chatgpt',
        email: 'user@example.com',
        planType: 'pro',
      },
    });

    const service = new ObservabilityService();
    await service.start();

    expect(findProviderUsage(service, 'codex')).toMatchObject({
      authState: 'authenticated',
      accountLabel: 'user@example.com',
    });

    await service.dispose();
  });

  it('marks Codex unauthenticated without requesting rate limits when no account is available', async () => {
    readAccountMock.mockResolvedValue({
      requiresOpenaiAuth: true,
      account: null,
    });
    readRateLimitsMock.mockRejectedValue(
      new Error('codex account authentication required to read rate limits'),
    );

    const service = new ObservabilityService();
    await service.start();

    const codexUsage = findProviderUsage(service, 'codex');
    expect(codexUsage).toMatchObject({
      authState: 'unauthenticated',
      accountLabel: undefined,
    });
    expect(codexUsage?.error).toBeUndefined();
    expect(codexUsage?.errorInfo).toBeUndefined();
    expect(readRateLimitsMock).not.toHaveBeenCalled();

    await service.dispose();
  });

  it('does not force authenticated invalidation during Claude usage refreshes', async () => {
    const service = new ObservabilityService();

    try {
      await service.refreshProviderUsage('claude');

      expect(mockedCheckClaudeAuthStatusObserved).toHaveBeenCalledWith(
        'usage-refresh',
      );
      expect(mockedCheckClaudeAuthStatusObserved).not.toHaveBeenCalledWith(
        'usage-refresh',
        expect.objectContaining({ forceAuthenticatedInvalidation: true }),
      );
      expect(findProviderUsage(service, 'claude')).toMatchObject({
        authState: 'authenticated',
        accountLabel: 'user@example.com',
      });
    } finally {
      await service.dispose();
    }
  });

  it('does not let stale Codex usage errors overwrite a later successful refresh', async () => {
    let rateLimitsUpdated: (() => void) | null = null;
    onRateLimitsUpdatedMock.mockImplementation((listener: () => void) => {
      rateLimitsUpdated = listener;
    });
    const deferredRateLimits = createDeferred<{
      rateLimitsByLimitId: Record<string, never>;
      rateLimits: Record<string, never>;
    }>();

    const service = new ObservabilityService();
    await service.start();
    readAccountMock.mockClear();
    readRateLimitsMock.mockClear();
    readAccountMock.mockResolvedValue({
      requiresOpenaiAuth: false,
      account: {
        type: 'chatgpt',
        email: 'user@example.com',
        planType: 'pro',
      },
    });
    readRateLimitsMock
      .mockImplementationOnce(() => deferredRateLimits.promise)
      .mockResolvedValue({
        rateLimitsByLimitId: {},
        rateLimits: {},
      });
    const usageEvents: AgentObservabilityUpdateEvent[] = [];
    service.subscribe((event) => {
      if (event.type === 'usage') {
        usageEvents.push(event);
      }
    });

    const firstRefresh = service.refreshProviderUsage('codex');
    await waitForCondition(() => readRateLimitsMock.mock.calls.length === 1);

    // A newer read (the app-server's rate-limit notification) supersedes the
    // pending public refresh instead of joining it.
    if (!rateLimitsUpdated) {
      throw new Error('Expected Codex rate-limit update listener');
    }
    rateLimitsUpdated();
    await waitForCondition(() => usageEvents.length === 1);
    expect(readRateLimitsMock).toHaveBeenCalledTimes(2);
    expect(
      service
        .loadSnapshot()
        .usage.providers.find((entry) => entry.provider === 'codex')?.error,
    ).toBeUndefined();

    deferredRateLimits.reject(new Error('usage unavailable'));
    await firstRefresh;

    expect(
      service
        .loadSnapshot()
        .usage.providers.find((entry) => entry.provider === 'codex')?.error,
    ).toBeUndefined();
    expect(usageEvents).toHaveLength(1);

    await service.dispose();
  });

  it('merges concurrent public Codex refreshes into one provider read', async () => {
    const deferredRateLimits = createDeferred<{
      rateLimitsByLimitId: Record<string, never>;
      rateLimits: Record<string, never>;
    }>();

    const service = new ObservabilityService();
    await service.start();
    readRateLimitsMock.mockClear();
    readRateLimitsMock
      .mockImplementationOnce(() => deferredRateLimits.promise)
      .mockResolvedValue({ rateLimitsByLimitId: {}, rateLimits: {} });

    const first = service.refreshProviderUsage('codex', {
      joinInFlight: true,
    });
    const second = service.refreshProviderUsage('codex', {
      joinInFlight: true,
    });
    await waitForCondition(() => readRateLimitsMock.mock.calls.length > 0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(readRateLimitsMock).toHaveBeenCalledTimes(1);

    deferredRateLimits.resolve({ rateLimitsByLimitId: {}, rateLimits: {} });
    await Promise.all([first, second]);
    expect(readRateLimitsMock).toHaveBeenCalledTimes(1);

    // A request after the merged refresh settled reads the provider again.
    await service.refreshProviderUsage('codex', {
      joinInFlight: true,
    });
    expect(readRateLimitsMock).toHaveBeenCalledTimes(2);

    await service.dispose();
  });

  it('merges concurrent public Claude refreshes into one usage fetch', async () => {
    const service = new ObservabilityService();
    await service.start();
    fetchMock.mockClear();
    mockedCheckClaudeAuthStatusObserved.mockClear();
    const clock = installDateNowClock(Date.now());
    clock.advance(30_001);

    try {
      const first = service.refreshProviderUsage('claude', {
        joinInFlight: true,
      });
      const second = service.refreshProviderUsage('claude', {
        joinInFlight: true,
      });
      await Promise.all([first, second]);

      expect(mockedCheckClaudeAuthStatusObserved).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      clock.restore();
      await service.dispose();
    }
  });

  it('does not let a post-login Claude refresh join a read that started before the login', async () => {
    const service = new ObservabilityService();
    await service.start();
    const preLoginAuth =
      createDeferred<
        Awaited<
          ReturnType<typeof providerAuthState.checkClaudeAuthStatusObserved>
        >
      >();
    mockedCheckClaudeAuthStatusObserved.mockClear();
    mockedCheckClaudeAuthStatusObserved
      .mockImplementationOnce(() => preLoginAuth.promise)
      .mockResolvedValueOnce({
        authenticated: true,
        accountLabel: 'new@example.com',
        detail: 'claude.ai (max)',
        error: null,
      });

    const preLoginRefresh = service.refreshProviderUsage('claude');
    await waitForCondition(
      () => mockedCheckClaudeAuthStatusObserved.mock.calls.length === 1,
    );

    const postLoginRefresh = service.refreshProviderUsage('claude');
    preLoginAuth.resolve({
      authenticated: true,
      accountLabel: 'old@example.com',
      detail: 'claude.ai (pro)',
      error: null,
    });
    await Promise.all([preLoginRefresh, postLoginRefresh]);

    expect(mockedCheckClaudeAuthStatusObserved).toHaveBeenCalledTimes(2);
    expect(findProviderUsage(service, 'claude')).toMatchObject({
      authState: 'authenticated',
      accountLabel: 'new@example.com',
    });

    await service.dispose();
  });

  it('lets a desktop refresh supersede a Remote Control Claude read, which later requests then join', async () => {
    const service = new ObservabilityService();
    await service.start();
    const preLoginAuth =
      createDeferred<
        Awaited<
          ReturnType<typeof providerAuthState.checkClaudeAuthStatusObserved>
        >
      >();
    mockedCheckClaudeAuthStatusObserved.mockClear();
    mockedCheckClaudeAuthStatusObserved
      .mockImplementationOnce(() => preLoginAuth.promise)
      .mockResolvedValueOnce({
        authenticated: true,
        accountLabel: 'new@example.com',
        detail: 'claude.ai (max)',
        error: null,
      });

    const remoteRefresh = service.refreshProviderUsage('claude', {
      joinInFlight: true,
    });
    await waitForCondition(
      () => mockedCheckClaudeAuthStatusObserved.mock.calls.length === 1,
    );

    const desktopRefresh = service.refreshProviderUsage('claude');
    const laterRemoteRefresh = service.refreshProviderUsage('claude', {
      joinInFlight: true,
    });
    preLoginAuth.resolve({
      authenticated: true,
      accountLabel: 'old@example.com',
      detail: 'claude.ai (pro)',
      error: null,
    });
    await Promise.all([remoteRefresh, desktopRefresh, laterRemoteRefresh]);

    expect(mockedCheckClaudeAuthStatusObserved).toHaveBeenCalledTimes(2);
    expect(findProviderUsage(service, 'claude')).toMatchObject({
      authState: 'authenticated',
      accountLabel: 'new@example.com',
    });

    await service.dispose();
  });

  it('starts a new Codex read for a public refresh after a newer read supersedes the pending one', async () => {
    let rateLimitsUpdated: (() => void) | null = null;
    onRateLimitsUpdatedMock.mockImplementation((listener: () => void) => {
      rateLimitsUpdated = listener;
    });
    const staleRateLimits = createDeferred<{
      rateLimitsByLimitId: Record<string, never>;
      rateLimits: Record<string, never>;
    }>();

    const service = new ObservabilityService();
    await service.start();
    readRateLimitsMock.mockClear();
    readRateLimitsMock
      .mockImplementationOnce(() => staleRateLimits.promise)
      .mockResolvedValue({ rateLimitsByLimitId: {}, rateLimits: {} });

    const staleRefresh = service.refreshProviderUsage('codex', {
      joinInFlight: true,
    });
    await waitForCondition(() => readRateLimitsMock.mock.calls.length === 1);
    if (!rateLimitsUpdated) {
      throw new Error('Expected Codex rate-limit update listener');
    }
    rateLimitsUpdated();
    await waitForCondition(() => readRateLimitsMock.mock.calls.length === 2);

    await service.refreshProviderUsage('codex', {
      joinInFlight: true,
    });
    expect(readRateLimitsMock).toHaveBeenCalledTimes(3);

    staleRateLimits.reject(new Error('usage unavailable'));
    await staleRefresh;
    expect(findProviderUsage(service, 'codex')).toMatchObject({
      authState: 'authenticated',
    });
    expect(
      service
        .loadSnapshot()
        .usage.providers.find((entry) => entry.provider === 'codex')?.error,
    ).toBeUndefined();

    await service.dispose();
  });

  it('starts a fresh Codex read for a completed chat turn while a public refresh is pending', async () => {
    const pendingRateLimits = createDeferred<{
      rateLimitsByLimitId: Record<string, never>;
      rateLimits: Record<string, never>;
    }>();

    const service = new ObservabilityService();
    await service.start();
    readRateLimitsMock.mockClear();
    readRateLimitsMock
      .mockImplementationOnce(() => pendingRateLimits.promise)
      .mockResolvedValue({ rateLimitsByLimitId: {}, rateLimits: {} });

    const manualRefresh = service.refreshProviderUsage('codex', {
      joinInFlight: true,
    });
    await waitForCondition(() => readRateLimitsMock.mock.calls.length === 1);

    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'codex',
      originalUserText: 'Inspect the bug',
      submittedText: 'Inspect the bug',
      planMode: false,
      isStandalone: false,
    });
    service.completeChatTurn('proj', 'wt', 'chat', 'success');

    await waitForCondition(() => readRateLimitsMock.mock.calls.length === 2);

    pendingRateLimits.resolve({ rateLimitsByLimitId: {}, rateLimits: {} });
    await manualRefresh;
    await service.dispose();
  });

  it('does not retry Codex usage for unrelated unauthorized responses', async () => {
    const service = new ObservabilityService();
    await service.start();
    jest.clearAllMocks();

    readRateLimitsMock.mockRejectedValueOnce(
      new Error(
        'GET https://chatgpt.com/backend-api/wham/usage failed: 401 Unauthorized',
      ),
    );

    await service.refreshProviderUsage('codex');

    expect(disposeCodexMonitorMock).not.toHaveBeenCalled();
    expect(mockCodexAppServerClient).not.toHaveBeenCalled();
    const codexUsage = service
      .loadSnapshot()
      .usage.providers.find((entry) => entry.provider === 'codex');
    expect(codexUsage?.error).toBe(
      'GET https://chatgpt.com/backend-api/wham/usage failed: 401 Unauthorized',
    );
    expect(codexUsage?.errorInfo).toEqual({
      kind: 'auth',
      detail:
        'GET https://chatgpt.com/backend-api/wham/usage failed: 401 Unauthorized',
    });

    await service.dispose();
  });

  it('classifies a Codex usage-endpoint 404 as unsupported with the raw detail preserved', async () => {
    const service = new ObservabilityService();
    await service.start();
    jest.clearAllMocks();

    const rawMessage =
      'failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/wham/usage failed: 404 Not Found; content-type=; body=';
    readRateLimitsMock.mockRejectedValueOnce(new Error(rawMessage));

    await service.refreshProviderUsage('codex');

    const codexUsage = service
      .loadSnapshot()
      .usage.providers.find((entry) => entry.provider === 'codex');
    expect(codexUsage?.error).toBe(rawMessage);
    expect(codexUsage?.errorInfo).toEqual({
      kind: 'unsupported',
      detail: rawMessage,
    });

    await service.dispose();
  });

  it('retries Codex usage with a fresh monitor when account changes revoke the old token', async () => {
    const service = new ObservabilityService();
    await service.start();
    jest.clearAllMocks();

    const freshReadAccount = jest.fn().mockResolvedValue({
      requiresOpenaiAuth: false,
      account: {
        type: 'chatgpt',
        email: 'new-user@example.com',
        planType: 'team',
      },
    });
    const freshReadRateLimits = jest.fn().mockResolvedValue({
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex',
          limitName: 'Codex',
          planType: 'team',
          primary: {
            usedPercent: 23,
            windowDurationMins: 300,
            resetsAt: 1_710_000_300,
          },
          secondary: null,
          credits: null,
        },
      },
      rateLimits: {},
    });
    const freshDispose = jest.fn();

    mockCodexAppServerClient.mockImplementationOnce(() => ({
      readAccount: freshReadAccount,
      readRateLimits: freshReadRateLimits,
      onAccountUpdated: onAccountUpdatedMock,
      onRateLimitsUpdated: onRateLimitsUpdatedMock,
      dispose: freshDispose,
    }));
    readAccountMock.mockResolvedValue({
      requiresOpenaiAuth: false,
      account: {
        type: 'chatgpt',
        email: 'new-user@example.com',
        planType: 'team',
      },
    });
    readRateLimitsMock.mockRejectedValueOnce(
      new Error(
        'GET https://chatgpt.com/backend-api/wham/usage failed: 401 Unauthorized; body={"error":{"code":"token_revoked","message":"Encountered invalidated oauth token for user, failing request"}}',
      ),
    );

    await service.refreshProviderUsage('codex');

    expect(readAccountMock).toHaveBeenCalledWith(false);
    expect(disposeCodexMonitorMock).toHaveBeenCalledTimes(1);
    expect(mockCodexAppServerClient).toHaveBeenCalledTimes(1);
    expect(freshReadAccount).toHaveBeenCalledWith(false);
    expect(freshReadRateLimits).toHaveBeenCalledTimes(1);
    const codexUsage = service
      .loadSnapshot()
      .usage.providers.find((entry) => entry.provider === 'codex');
    expect(codexUsage).toMatchObject({
      authState: 'authenticated',
      accountLabel: 'new-user@example.com',
      subscriptionLabel: 'ChatGPT Business',
    });
    expect(codexUsage?.error).toBeUndefined();
    expect(codexUsage?.rateLimits?.[0]?.primary?.usedPercent).toBe(23);

    await service.dispose();
    expect(freshDispose).toHaveBeenCalledTimes(1);
  });

  it('does not dispose a newer Codex monitor from a stale invalidated-token refresh', async () => {
    let accountUpdated: (() => void) | null = null;
    onAccountUpdatedMock.mockImplementation((listener: () => void) => {
      accountUpdated = listener;
    });
    const deferredRateLimits = createDeferred<{
      rateLimitsByLimitId: Record<string, never>;
      rateLimits: Record<string, never>;
    }>();

    const service = new ObservabilityService();
    await service.start();
    jest.clearAllMocks();

    const freshReadAccount = jest.fn().mockResolvedValue({
      requiresOpenaiAuth: false,
      account: {
        type: 'chatgpt',
        email: 'updated-user@example.com',
        planType: 'pro',
      },
    });
    const freshReadRateLimits = jest.fn().mockResolvedValue({
      rateLimitsByLimitId: {},
      rateLimits: {},
    });
    const freshDispose = jest.fn();
    mockCodexAppServerClient.mockImplementationOnce(() => ({
      readAccount: freshReadAccount,
      readRateLimits: freshReadRateLimits,
      onAccountUpdated: onAccountUpdatedMock,
      onRateLimitsUpdated: onRateLimitsUpdatedMock,
      dispose: freshDispose,
    }));
    readRateLimitsMock.mockImplementationOnce(() => deferredRateLimits.promise);

    const staleRefresh = service.refreshProviderUsage('codex');
    await waitForCondition(() => readRateLimitsMock.mock.calls.length === 1);

    if (!accountUpdated) {
      throw new Error('Expected Codex account update listener');
    }
    accountUpdated();
    await waitForCondition(() => freshReadRateLimits.mock.calls.length === 1);

    deferredRateLimits.reject(
      new Error(
        'GET https://chatgpt.com/backend-api/wham/usage failed: 401 Unauthorized; body={"error":{"code":"token_revoked"}}',
      ),
    );
    await staleRefresh;

    expect(disposeCodexMonitorMock).toHaveBeenCalledTimes(1);
    expect(freshDispose).not.toHaveBeenCalled();
    expect(freshReadAccount).toHaveBeenCalledWith(false);
    expect(freshReadRateLimits).toHaveBeenCalledTimes(1);

    await service.dispose();
    expect(freshDispose).toHaveBeenCalledTimes(1);
  });

  it('refreshes Codex usage with a fresh monitor after account update notifications', async () => {
    let accountUpdated: (() => void) | null = null;
    onAccountUpdatedMock.mockImplementation((listener: () => void) => {
      accountUpdated = listener;
    });

    const service = new ObservabilityService();
    await service.start();
    jest.clearAllMocks();

    const freshReadAccount = jest.fn().mockResolvedValue({
      requiresOpenaiAuth: false,
      account: {
        type: 'chatgpt',
        email: 'updated-user@example.com',
        planType: 'pro',
      },
    });
    const freshReadRateLimits = jest.fn().mockResolvedValue({
      rateLimitsByLimitId: {},
      rateLimits: {},
    });
    const freshDispose = jest.fn();
    mockCodexAppServerClient.mockImplementationOnce(() => ({
      readAccount: freshReadAccount,
      readRateLimits: freshReadRateLimits,
      onAccountUpdated: onAccountUpdatedMock,
      onRateLimitsUpdated: onRateLimitsUpdatedMock,
      dispose: freshDispose,
    }));

    if (!accountUpdated) {
      throw new Error('Expected Codex account update listener');
    }
    accountUpdated();

    await waitForCondition(() => freshReadRateLimits.mock.calls.length === 1);

    expect(disposeCodexMonitorMock).toHaveBeenCalledTimes(1);
    expect(mockCodexAppServerClient).toHaveBeenCalledTimes(1);
    expect(findProviderUsage(service, 'codex')).toEqual({
      authState: 'authenticated',
      accountLabel: 'updated-user@example.com',
    });

    await service.dispose();
    expect(freshDispose).toHaveBeenCalledTimes(1);
  });

  it('refreshes Copilot after a completed turn and account changes, then clears on rollout disable', async () => {
    mockCopilotEnabled.mockReturnValue(true);
    mockedReadPreferencesFile.mockResolvedValue({
      ...makePreferences(30),
      copilotEnabled: true,
    });
    mockReadCopilotUsage.mockResolvedValue({
      provider: 'copilot',
      authState: 'authenticated',
      hasRemainingLimits: true,
      accountLabel: 'first',
    });
    const service = new ObservabilityService();
    try {
      await service.start();
      await service.refreshProviderUsage('copilot');
      mockReadCopilotUsage.mockClear();
      service.startChatTurn({
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'copilot',
        provider: 'copilot',
        originalUserText: 'Inspect',
        submittedText: 'Inspect',
        planMode: false,
        isStandalone: false,
      });
      service.completeChatTurn('proj', 'wt', 'copilot', 'success');
      await waitForCondition(
        () => mockReadCopilotUsage.mock.calls.length === 1,
      );
      await service.refreshProviderUsage('copilot');
      notifyCopilotUsageChanged(false);
      expect(
        service
          .getUsageOverview()
          .providers.some((p) => p.provider === 'copilot'),
      ).toBe(false);
      mockReadCopilotUsage.mockResolvedValue({
        provider: 'copilot',
        authState: 'authenticated',
        hasRemainingLimits: true,
        accountLabel: 'second',
      });
      notifyCopilotUsageChanged(true);
      await service.refreshProviderUsage('copilot');
      expect(
        service
          .getUsageOverview()
          .providers.find((p) => p.provider === 'copilot')?.accountLabel,
      ).toBe('second');
      mockCopilotEnabled.mockReturnValue(false);
      mockFlagListeners.forEach((listener) => listener());
      expect(
        service
          .getUsageOverview()
          .providers.some((p) => p.provider === 'copilot'),
      ).toBe(false);
    } finally {
      await service.dispose();
      mockCopilotEnabled.mockReturnValue(false);
    }
  });

  it('refreshes Claude live usage after a completed provider turn', async () => {
    const service = new ObservabilityService();
    await service.start();
    execFileMock.mockClear();
    fetchMock.mockClear();
    mockedCheckClaudeAuthStatusObserved.mockClear();
    const billingKind = jest
      .spyOn(providerAuthState, 'peekProviderBillingAccountKind')
      .mockReturnValue('subscription');
    jest.useFakeTimers();
    jest.setSystemTime(new Date(Date.now() + 181_000));

    try {
      service.startChatTurn({
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat',
        provider: 'claude',
        originalUserText: 'Inspect the bug',
        submittedText: 'Inspect the bug',
        planMode: false,
        isStandalone: false,
      });
      service.completeChatTurn('proj', 'wt', 'chat', 'success');

      await jest.advanceTimersByTimeAsync(29_999);
      expect(fetchMock).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);

      expect(mockedCheckClaudeAuthStatusObserved).toHaveBeenCalledWith(
        'usage-refresh',
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
      billingKind.mockRestore();
      await service.dispose();
    }
  });

  it('attributes a completed turn to the provider account captured at start', () => {
    const peekProviderAccountIdentitySpy = jest
      .spyOn(providerAuthState, 'peekProviderAccountIdentity')
      .mockReturnValue({
        providerAccountKey: 'claude:account-a@example.com',
        accountEmail: 'account-a@example.com',
        planType: 'max',
      });
    const service = new ObservabilityService();

    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'claude',
      originalUserText: 'Inspect the bug',
      submittedText: 'Inspect the bug',
      planMode: false,
      isStandalone: false,
    });
    peekProviderAccountIdentitySpy.mockReturnValue({
      providerAccountKey: 'claude:account-b@example.com',
      accountEmail: 'account-b@example.com',
      planType: 'team',
    });

    service.completeChatTurn('proj', 'wt', 'chat', 'success');

    expect(loadOnlyRecentEntry(service)).toMatchObject({
      providerAccountKey: 'claude:account-a@example.com',
      providerAccountEmail: 'account-a@example.com',
      providerPlanType: 'max',
    });
    expect(peekProviderAccountIdentitySpy).toHaveBeenCalledTimes(1);
    expect(mockedWarmProviderAccountIdentity).toHaveBeenCalledWith(
      'claude',
      'audit-entry-start',
    );
    peekProviderAccountIdentitySpy.mockRestore();
  });

  it('clears a captured native identity when an observed task changes to Ollama', () => {
    const peekProviderAccountIdentitySpy = jest
      .spyOn(providerAuthState, 'peekProviderAccountIdentity')
      .mockReturnValue({
        providerAccountKey: 'codex:account@example.com',
        accountEmail: 'account@example.com',
        planType: 'pro',
      });
    const service = new ObservabilityService();
    const startedAt = new Date().toISOString();

    service.startObservedTask(
      'advisor-task',
      makeAuditEntry('advisor-entry', startedAt, {
        eventType: 'pipeline_advisor',
        status: 'running',
        provider: 'codex',
        label: 'Pipeline Advisor',
        model: 'ollama-qwen3-coder',
      }),
    );
    service.updateObservedTask('advisor-task', { provider: 'ollama' });
    service.finalizeObservedTask('advisor-task', 'success');

    expect(loadOnlyRecentEntry(service)).toMatchObject({
      provider: 'ollama',
    });
    expect(loadOnlyRecentEntry(service)).not.toHaveProperty(
      'providerAccountKey',
    );
    expect(loadOnlyRecentEntry(service)).not.toHaveProperty(
      'providerAccountEmail',
    );
    expect(loadOnlyRecentEntry(service)).not.toHaveProperty('providerPlanType');
    peekProviderAccountIdentitySpy.mockRestore();
  });

  it('records separate deferred reload prompts for different enabled resources', () => {
    const service = new ObservabilityService();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'claude',
      originalUserText: 'Use both tools',
      submittedText: 'Use both tools',
      planMode: false,
      isStandalone: false,
    });
    const prompt = {
      kind: 'system_prompt_append' as const,
      provider: 'claude' as const,
      applicationCondition: 'deferred_tools_reload_continuation' as const,
      text: 'Continue the interrupted request.',
    };

    service.recordInjectedPromptForOpenChatTurn('proj', 'wt', 'chat', {
      ...prompt,
      deferredToolsReload: {
        enabledResources: [
          { ref: 'skill:first', kind: 'skill', name: 'First' },
        ],
      },
    });
    service.recordInjectedPromptForOpenChatTurn('proj', 'wt', 'chat', {
      ...prompt,
      deferredToolsReload: {
        enabledResources: [
          { ref: 'plugin:second', kind: 'plugin', name: 'Second' },
        ],
      },
    });

    expect(
      service.getInjectedPromptsForTests('proj', 'wt', 'chat'),
    ).toHaveLength(2);
    service.completeChatTurn('proj', 'wt', 'chat', 'success');
  });

  it('labels App Advisor chat turns with an App Advisor audit target', async () => {
    const service = new ObservabilityService();
    await service.start();

    service.startChatTurn({
      projectId: 'app-advisor',
      worktreeId: 'global',
      chatId: 'advisor-tab',
      provider: 'claude',
      originalUserText: 'Inspect the UI',
      submittedText: 'Inspect the UI',
      planMode: false,
      isStandalone: false,
      assistantMode: 'app-advisor',
    });
    service.completeChatTurn('app-advisor', 'global', 'advisor-tab', 'success');

    const entry = loadOnlyRecentEntry(service);
    expect(entry).toMatchObject({
      eventType: 'app_advisor',
      label: 'App Advisor',
      projectId: 'app-advisor',
      worktreeId: 'global',
      chatId: 'advisor-tab',
      linkTarget: {
        page: 'main',
        kind: 'app-advisor',
        chatId: 'advisor-tab',
      },
    });

    await service.dispose();
  });

  it('labels Pipeline Editor chat turns with a Pipeline Editor audit target', async () => {
    installMockFilesystem();
    const service = new ObservabilityService();
    await service.start();

    service.startChatTurn({
      projectId: PIPELINE_EDITOR_PROJECT_ID,
      worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
      chatId: 'pipeline-editor-tab',
      provider: 'codex',
      originalUserText: 'Edit this pipeline',
      submittedText: 'Edit this pipeline',
      planMode: false,
      isStandalone: false,
      assistantMode: 'pipeline-editor',
    });
    service.completeChatTurn(
      PIPELINE_EDITOR_PROJECT_ID,
      PIPELINE_EDITOR_WORKTREE_ID,
      'pipeline-editor-tab',
      'success',
    );
    await service.flush();

    const entry = loadOnlyRecentEntry(service);
    expect(entry).toMatchObject({
      eventType: 'pipeline_editor',
      label: 'Pipeline Editor',
      projectId: PIPELINE_EDITOR_PROJECT_ID,
      worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
      chatId: 'pipeline-editor-tab',
      linkTarget: {
        page: 'main',
        kind: 'pipeline-editor',
        projectId: PIPELINE_EDITOR_PROJECT_ID,
        worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
        chatId: 'pipeline-editor-tab',
      },
    });
    const completedUsageEvents = mockedAppendFile.mock.calls
      .filter(([pathArg]) =>
        String(pathArg).includes('/mock/observability/usage-events/'),
      )
      .flatMap(([, payload]) =>
        String(payload)
          .trim()
          .split('\n')
          .filter((line) => line.length > 0)
          .map((line): unknown => JSON.parse(line)),
      )
      .filter(
        (event): event is { type: 'chat_turn_completed' } =>
          typeof event === 'object' &&
          event !== null &&
          'type' in event &&
          event.type === 'chat_turn_completed',
      );

    expect(completedUsageEvents).toHaveLength(1);
    expect(completedUsageEvents[0]).toMatchObject({
      workspaceId: PIPELINE_EDITOR_PROJECT_ID,
      worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
      chatId: 'pipeline-editor-tab',
      auditEntryId: entry.id,
      type: 'chat_turn_completed',
    });

    await service.dispose();
  });

  it('carries the cowork project id in the standalone-chat link target', async () => {
    installMockFilesystem();
    const service = new ObservabilityService();
    await service.start();

    const coworkWorkspaceId = 'cowork-acme-workspace';

    service.startChatTurn({
      projectId: coworkWorkspaceId,
      worktreeId: 'home',
      chatId: 'cowork-chat-tab',
      provider: 'claude',
      originalUserText: 'Draft the release notes',
      submittedText: 'Draft the release notes',
      planMode: false,
      isStandalone: true,
      standaloneProjectId: coworkWorkspaceId,
    });
    service.completeChatTurn(
      coworkWorkspaceId,
      'home',
      'cowork-chat-tab',
      'success',
    );
    await service.flush();

    const entry = loadOnlyRecentEntry(service);
    expect(entry).toMatchObject({
      eventType: 'standalone_chat',
      projectId: coworkWorkspaceId,
      worktreeId: 'home',
      chatId: 'cowork-chat-tab',
      linkTarget: {
        page: 'chat',
        kind: 'standalone-chat',
        worktreeId: coworkWorkspaceId,
        chatId: 'cowork-chat-tab',
      },
    });

    await service.dispose();
  });

  it('refreshes Codex live usage after terminal provider turns', async () => {
    const service = new ObservabilityService();
    await service.start();
    readAccountMock.mockClear();
    readRateLimitsMock.mockClear();

    const terminalTurns: Array<{
      chatId: string;
      status: 'success' | 'failure' | 'interrupted';
    }> = [
      { chatId: 'chat-success', status: 'success' },
      { chatId: 'chat-failed', status: 'failure' },
      { chatId: 'chat-interrupted', status: 'interrupted' },
    ];

    for (let index = 0; index < terminalTurns.length; index += 1) {
      const turn = terminalTurns[index];
      if (!turn) {
        throw new Error('Expected terminal turn');
      }

      service.startChatTurn({
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: turn.chatId,
        provider: 'codex',
        originalUserText: 'Run the turn',
        submittedText: 'Run the turn',
        planMode: false,
        isStandalone: false,
      });
      service.completeChatTurn('proj', 'wt', turn.chatId, turn.status);

      await waitForCondition(
        () => readRateLimitsMock.mock.calls.length >= index + 1,
      );
    }

    expect(readAccountMock).toHaveBeenCalledTimes(3);
    expect(readRateLimitsMock).toHaveBeenCalledTimes(3);

    await service.dispose();
  });

  it('does not refresh live usage when pipeline agent turns complete', async () => {
    const service = new ObservabilityService();
    await service.start();
    execFileMock.mockClear();
    fetchMock.mockClear();
    readAccountMock.mockClear();
    readRateLimitsMock.mockClear();

    service.syncPipelineExecutionState(makeRunningPipelineState());
    service.syncPipelineExecutionState(makeCompletedPipelineState());

    await waitForTicks(3);

    expect(execFileMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readAccountMock).not.toHaveBeenCalled();
    expect(readRateLimitsMock).not.toHaveBeenCalled();

    await service.dispose();
  });

  it('stops queued provider usage refreshes once disposal begins', async () => {
    const deferredRateLimits = createDeferred<{
      rateLimitsByLimitId: Record<string, never>;
      rateLimits: Record<string, never>;
    }>();

    readRateLimitsMock.mockResolvedValueOnce({
      rateLimitsByLimitId: {},
      rateLimits: {},
    });

    const service = new ObservabilityService();
    await service.start();
    readAccountMock.mockClear();
    readRateLimitsMock.mockClear();
    readAccountMock.mockResolvedValue({
      requiresOpenaiAuth: false,
      account: {
        type: 'chatgpt',
        email: 'user@example.com',
        planType: 'pro',
      },
    });
    readRateLimitsMock.mockImplementation(() => deferredRateLimits.promise);

    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-dispose-1',
      provider: 'codex',
      originalUserText: 'Run the turn',
      submittedText: 'Run the turn',
      planMode: false,
      isStandalone: false,
    });
    service.completeChatTurn('proj', 'wt', 'chat-dispose-1', 'success');

    await waitForCondition(() => readRateLimitsMock.mock.calls.length === 1);

    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-dispose-2',
      provider: 'codex',
      originalUserText: 'Run another turn',
      submittedText: 'Run another turn',
      planMode: false,
      isStandalone: false,
    });
    service.completeChatTurn('proj', 'wt', 'chat-dispose-2', 'success');

    await service.dispose();

    deferredRateLimits.resolve({
      rateLimitsByLimitId: {},
      rateLimits: {},
    });
    await waitForTicks(3);

    expect(readAccountMock).toHaveBeenCalledTimes(1);
    expect(readRateLimitsMock).toHaveBeenCalledTimes(1);
  });

  it('records plan-explore chat turns under the worktree_plan_chat event type', () => {
    const service = new ObservabilityService();

    service.startChatTurn({
      projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
      worktreeId: 'plan-123',
      chatId: 'plan-chat-1',
      provider: 'claude',
      originalUserText: 'Discuss the plan',
      submittedText: 'Discuss the plan',
      planMode: false,
      isStandalone: false,
    });
    service.completeChatTurn(
      PLAN_EXPLORE_CHAT_PROJECT_ID,
      'plan-123',
      'plan-chat-1',
      'success',
    );

    const entry = service
      .loadSnapshot()
      .recentEntries.find((candidate) => candidate.chatId === 'plan-chat-1');
    expect(entry).toMatchObject({
      eventType: 'worktree_plan_chat',
      label: 'Worktree Plan Chat',
      provider: 'claude',
      status: 'success',
    });
    // The synthetic plan-explore scope is not a navigable worktree-chat target.
    expect(entry?.linkTarget).toBeUndefined();
  });

  it('buffers split JSONL stdout records until a full line arrives', () => {
    const service = new ObservabilityService();
    service.syncPipelineExecutionState(makeRunningPipelineState());

    service.observePipelineOutput({
      executionId: 'exec-1',
      jobId: 'job1',
      stepId: 'step1',
      attempt: 0,
      data: '{"type":"assistant","message":{"model":"claude-test","content":[{"type":"text","text":"hel',
    });

    expect(loadOnlyRecentEntry(service).messageCount).toBe(0);

    service.observePipelineOutput({
      executionId: 'exec-1',
      jobId: 'job1',
      stepId: 'step1',
      attempt: 0,
      data: 'lo"}]}}\n{"type":"result","usage":{"input_tokens":3,"output_tokens":5}}\n',
    });

    const entry = loadOnlyRecentEntry(service);
    expect(entry.model).toBe('claude-test');
    expect(entry.messageCount).toBe(1);
    expect(entry.assistantMessageCount).toBe(1);
    expect(entry.tokens.input).toBe(3);
    expect(entry.tokens.output).toBe(5);
  });

  it('keeps concurrent matrix job agent turns in distinct audit streams', () => {
    const service = new ObservabilityService();
    const childStep = (
      startedAt: string,
    ): {
      status: 'running';
      outputs: Record<string, string>;
      dynamic_env: Record<string, string>;
      started_at: string;
      log_format_hint: 'agent';
      agent_provider: 'claude';
      agent_model: string;
    } => ({
      status: 'running' as const,
      outputs: {},
      dynamic_env: {},
      started_at: startedAt,
      log_format_hint: 'agent' as const,
      agent_provider: 'claude' as const,
      agent_model: 'claude-sonnet-4-6',
    });
    service.syncPipelineExecutionState({
      id: 'exec-1',
      pipeline_id: 'pipeline-1',
      pipeline_snapshot: { name: 'Pipeline' },
      project_id: 'proj',
      worktree_id: 'wt',
      jobs: {
        __matrix__job1__0: {
          status: 'running',
          outputs: {},
          steps: {
            step1: childStep('2026-03-26T10:00:00.000Z'),
          },
        },
        __matrix__job1__1: {
          status: 'running',
          outputs: {},
          steps: {
            step1: childStep('2026-03-26T10:00:01.000Z'),
          },
        },
      },
    });

    service.observePipelineOutput({
      executionId: 'exec-1',
      jobId: '__matrix__job1__0',
      stepId: 'step1',
      attempt: 0,
      data: '{"type":"assistant","message":{"content":[{"type":"text","text":"alpha"}]}}\n',
    });
    service.observePipelineOutput({
      executionId: 'exec-1',
      jobId: '__matrix__job1__1',
      stepId: 'step1',
      attempt: 0,
      data: '{"type":"assistant","message":{"content":[{"type":"text","text":"beta"}]}}\n',
    });

    const entries = service.loadSnapshot().recentEntries;
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('/__matrix__job1__0/'),
        expect.stringContaining('/__matrix__job1__1/'),
      ]),
    );
    expect(entries.every((entry) => entry.messageCount === 1)).toBe(true);
  });

  it('tracks each iteration separately while preserving the iteration-one key', () => {
    const service = new ObservabilityService();
    const iterationStep = (startedAt: string): StepResult => ({
      status: 'running' as const,
      outputs: {},
      dynamic_env: {},
      started_at: startedAt,
      log_format_hint: 'agent' as const,
      agent_provider: 'claude' as const,
    });
    const state: Parameters<
      ObservabilityService['syncPipelineExecutionState']
    >[0] = {
      id: 'exec-iterations',
      pipeline_id: 'pipeline-1',
      pipeline_snapshot: { name: 'Pipeline' },
      project_id: 'proj',
      worktree_id: 'wt',
      jobs: {
        job1: {
          status: 'running',
          outputs: {},
          iteration_count: 2,
          iteration_history: [
            {
              iteration: 1,
              status: 'running',
              steps: {
                step1: iterationStep('2026-03-26T10:00:00.000Z'),
              },
            },
          ],
          steps: {
            step1: iterationStep('2026-03-26T10:01:00.000Z'),
          },
        },
      },
    };

    service.syncPipelineExecutionState(state);
    service.syncPipelineExecutionState(state);
    service.observePipelineOutput({
      executionId: 'exec-iterations',
      jobId: 'job1',
      stepId: 'step1',
      attempt: 0,
      iteration: 2,
      data: '{"type":"assistant","message":{"content":[{"type":"text","text":"iteration two"}]}}\n',
    });

    const entries = service.loadSnapshot().recentEntries;
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'pipeline:exec-iterations/job1/step1/0:2026-03-26T10:00:00.000Z',
        ),
        expect.stringContaining(
          'pipeline:exec-iterations/job1/step1/0/i2:2026-03-26T10:01:00.000Z',
        ),
      ]),
    );
    expect(
      entries.find((entry) => entry.id.includes('/i2:'))?.messageCount,
    ).toBe(1);
    expect(
      entries.find((entry) => !entry.id.includes('/i2:'))?.messageCount,
    ).toBe(0);
  });

  // Regression: at an iteration boundary the executor persists an intermediate
  // state where `iteration_count` has ALREADY advanced to N+1 while `job.steps`
  // still holds iteration N's terminal results — `job-runner.ts` pushes the
  // snapshot, advances the count, sets `status: 'restarting'` and calls
  // `saveState()` (~L609-622) BEFORE `resetJobForRestart` clears `job.steps`
  // (~L717). Every save emits `execution.updated` into this method, so walking
  // the live steps in that window keys iteration N's already-snapshotted result
  // to iteration N+1 and mints a phantom terminal entry with 0 messages / 0
  // tokens / $0. `getAgentWorkByUser` counts every non-RUNNING primary-work
  // row, so that phantom scores as a real agent turn and inflates the very
  // metric this change exists to fix.
  it('does not mint a phantom entry at the restarting iteration boundary', () => {
    const service = new ObservabilityService();
    const terminalStep = (startedAt: string): StepResult => ({
      status: 'success' as const,
      outputs: {},
      dynamic_env: {},
      started_at: startedAt,
      completed_at: '2026-03-26T10:00:30.000Z',
      log_format_hint: 'agent' as const,
      agent_provider: 'claude' as const,
    });
    // The exact shape `saveState()` persists at the boundary: the SAME terminal
    // result present in both containers, with the count already advanced.
    service.syncPipelineExecutionState({
      id: 'exec-restart-boundary',
      pipeline_id: 'pipeline-1',
      pipeline_snapshot: { name: 'Pipeline' },
      project_id: 'proj',
      worktree_id: 'wt',
      jobs: {
        job1: {
          status: 'restarting',
          outputs: {},
          iteration_count: 2,
          iteration_history: [
            {
              iteration: 1,
              status: 'success',
              steps: { step1: terminalStep('2026-03-26T10:00:00.000Z') },
            },
          ],
          steps: { step1: terminalStep('2026-03-26T10:00:00.000Z') },
        },
      },
    });

    const entries = service.loadSnapshot().recentEntries;
    // Exactly one real execution happened, so exactly one entry may exist.
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toContain(
      'pipeline:exec-restart-boundary/job1/step1/0:2026-03-26T10:00:00.000Z',
    );
    expect(entries.filter((entry) => entry.id.includes('/i2:'))).toHaveLength(
      0,
    );
  });

  it('tracks iteration history nested inside a retry attempt', () => {
    const service = new ObservabilityService();
    const completedStep = (
      startedAt: string,
      completedAt: string,
    ): StepResult => ({
      status: 'success' as const,
      outputs: {},
      dynamic_env: {},
      started_at: startedAt,
      completed_at: completedAt,
      log_format_hint: 'agent' as const,
      agent_provider: 'claude' as const,
    });
    service.syncPipelineExecutionState({
      id: 'exec-retry-iterations',
      pipeline_id: 'pipeline-1',
      pipeline_snapshot: { name: 'Pipeline' },
      jobs: {
        job1: {
          status: 'pending',
          outputs: {},
          retry_count: 1,
          retry_history: [
            {
              attempt: 0,
              status: 'failure',
              iteration_history: [
                {
                  iteration: 1,
                  status: 'success',
                  steps: {
                    step1: completedStep(
                      '2026-03-26T10:00:00.000Z',
                      '2026-03-26T10:00:30.000Z',
                    ),
                  },
                },
              ],
              steps: {
                step1: completedStep(
                  '2026-03-26T10:01:00.000Z',
                  '2026-03-26T10:01:30.000Z',
                ),
              },
            },
          ],
          steps: {},
        },
      },
    });

    const ids = service.loadSnapshot().recentEntries.map((entry) => entry.id);
    expect(ids).toHaveLength(2);
    expect(ids).toEqual(
      expect.arrayContaining([
        expect.stringContaining('/job1/step1/0:'),
        expect.stringContaining('/job1/step1/0/i2:'),
      ]),
    );
  });

  it('stores the pipeline snapshot name on pipeline agent audit entries', () => {
    const service = new ObservabilityService();
    service.syncPipelineExecutionState(makeRunningPipelineState());

    const entry = loadOnlyRecentEntry(service);
    expect(entry.pipelineId).toBe('pipeline-1');
    expect(entry.pipelineName).toBe('Pipeline');
  });

  it('updates pipeline provider and session id from observed Codex output', () => {
    const service = new ObservabilityService();
    service.syncPipelineExecutionState({
      id: 'exec-1',
      pipeline_id: 'pipeline-1',
      pipeline_snapshot: { name: 'Pipeline' },
      project_id: 'proj',
      worktree_id: 'wt',
      jobs: {
        job1: {
          status: 'running',
          outputs: {},
          steps: {
            step1: {
              status: 'running',
              outputs: {},
              dynamic_env: {},
              started_at: '2026-03-26T10:00:00.000Z',
              log_format_hint: 'agent',
            },
          },
        },
      },
    });

    service.observePipelineOutput({
      executionId: 'exec-1',
      jobId: 'job1',
      stepId: 'step1',
      attempt: 0,
      data: '{"type":"thread.started","thread_id":"thread-9"}\n{"type":"item.completed","item":{"id":"msg-1","type":"agent_message","text":"done"}}\n{"type":"turn.completed","usage":{"input_tokens":2,"cached_input_tokens":0,"output_tokens":1}}\n',
    });

    const entry = loadOnlyRecentEntry(service);
    expect(entry.provider).toBe('codex');
    expect(entry.sdkSessionId).toBe('thread-9');
    expect(entry.messageCount).toBe(1);
  });

  it('updates live Codex pipeline details and transcript from streamed projected events', async () => {
    installMockFilesystem();

    const service = new ObservabilityService();
    service.syncPipelineExecutionState({
      id: 'exec-1',
      pipeline_id: 'pipeline-1',
      pipeline_snapshot: { name: 'Pipeline' },
      project_id: 'proj',
      worktree_id: 'wt',
      jobs: {
        job1: {
          status: 'running',
          outputs: {},
          steps: {
            step1: {
              status: 'running',
              outputs: {},
              dynamic_env: {},
              started_at: '2026-03-26T10:00:00.000Z',
              log_format_hint: 'agent',
              agent_provider: 'codex',
              agent_model: 'gpt-6-sol',
            },
          },
        },
      },
    });

    // Exactly the JSONL lines the pipeline runners stream: a hand-built
    // thread.started record plus projectCodexRuntimeEvent projections of raw
    // app-server notifications.
    const lines = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-live' }),
      JSON.stringify(
        projectCodexRuntimeEvent({
          method: 'turn/started',
          params: {
            threadId: 'thread-live',
            turn: { id: 'turn-1', items: [], status: 'inProgress' },
          },
        }),
      ),
      JSON.stringify(
        projectCodexRuntimeEvent({
          method: 'item/completed',
          params: {
            threadId: 'thread-live',
            turnId: 'turn-1',
            item: { type: 'agentMessage', id: 'msg-1', text: 'working on it' },
          },
        }),
      ),
      JSON.stringify(
        projectCodexRuntimeEvent({
          method: 'thread/tokenUsage/updated',
          params: {
            threadId: 'thread-live',
            turnId: 'turn-1',
            tokenUsage: {
              total: {
                totalTokens: 120,
                inputTokens: 80,
                cachedInputTokens: 16,
                outputTokens: 40,
                reasoningOutputTokens: 8,
              },
              last: {
                totalTokens: 120,
                inputTokens: 80,
                cachedInputTokens: 16,
                outputTokens: 40,
                reasoningOutputTokens: 8,
              },
              modelContextWindow: 200000,
            },
          },
        }),
      ),
    ];
    service.observePipelineOutput({
      executionId: 'exec-1',
      jobId: 'job1',
      stepId: 'step1',
      attempt: 0,
      data: `${lines.join('\n')}\n`,
    });

    // The step is still running: details must already be live.
    const runningEntry = loadOnlyRecentEntry(service);
    expect(runningEntry.status).toBe('running');
    expect(runningEntry.provider).toBe('codex');
    expect(runningEntry.sdkSessionId).toBe('thread-live');
    expect(runningEntry.messageCount).toBe(1);
    expect(runningEntry.assistantMessageCount).toBe(1);
    expect(runningEntry.tokens.input).toBe(80);
    expect(runningEntry.tokens.output).toBe(40);
    expect(runningEntry.tokens.cacheReadInputTokens).toBe(16);
    expect(runningEntry.tokens.reasoningOutputTokens).toBe(8);

    // An interactive-shaped context-only usage record must not zero the
    // observed token breakdown.
    service.observePipelineOutput({
      executionId: 'exec-1',
      jobId: 'job1',
      stepId: 'step1',
      attempt: 0,
      data: `${JSON.stringify({
        type: 'thread.token_usage.updated',
        usage: { context_tokens: 130, context_window: 200000 },
      })}\n`,
    });
    expect(loadOnlyRecentEntry(service).tokens.input).toBe(80);

    await service.flush();

    const entry = loadOnlyRecentEntry(service);
    expect(entry.hasTranscript).toBe(true);
    const response = await service.loadTranscript({
      id: entry.id,
      eventType: entry.eventType,
      startedAt: entry.startedAt,
    });
    expect(response.type).toBe('success');
    if (response.type !== 'success') {
      throw new Error('Expected pipeline transcript response');
    }
    expect(response.lines[0]).toContain('"type":"thread.started"');
    expect(response.lines[2]).toContain('"working on it"');
    expect(response.lines[3]).toContain('"type":"thread.token_usage.updated"');
  });

  it('records a Cursor pipeline step with provider cursor and non-zero usage from streamed patch/usage lines', () => {
    installMockFilesystem();

    const service = new ObservabilityService();
    service.syncPipelineExecutionState({
      id: 'exec-1',
      pipeline_id: 'pipeline-1',
      pipeline_snapshot: { name: 'Pipeline' },
      project_id: 'proj',
      worktree_id: 'wt',
      jobs: {
        job1: {
          status: 'running',
          outputs: {},
          steps: {
            step1: {
              status: 'running',
              outputs: {},
              dynamic_env: {},
              started_at: '2026-03-26T10:00:00.000Z',
              log_format_hint: 'agent',
              agent_provider: 'cursor',
              agent_harness: 'cursor',
              agent_model: 'cursor-default',
            },
          },
        },
      },
    });

    // Exactly the tagged JSONL lines cursor-prompt-runner.ts's headless host
    // emits for a turn: a session-init record, an assistant text patch, and a
    // final usage snapshot (the "latest reported response", not a delta).
    const lines = [
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'cursor-sess-1',
        provider: 'cursor',
      }),
      JSON.stringify({
        type: 'canopy_assistant_patch',
        provider: 'cursor',
        messageId: 'msg-1',
        timestamp: Date.now(),
        revision: 1,
        patches: [
          {
            index: 0,
            block: { type: 'text', text: 'Working on it' },
          },
        ],
      }),
      JSON.stringify({
        type: 'canopy_cursor_usage',
        provider: 'cursor',
        usage: {
          inputTokens: 120,
          outputTokens: 45,
          cacheReadTokens: 10,
          cacheWriteTokens: 5,
        },
      }),
    ];
    service.observePipelineOutput({
      executionId: 'exec-1',
      jobId: 'job1',
      stepId: 'step1',
      attempt: 0,
      data: `${lines.join('\n')}\n`,
    });

    const entry = loadOnlyRecentEntry(service);
    expect(entry.provider).toBe('cursor');
    expect(entry.assistantMessageCount).toBe(1);
    // Cursor's `inputTokens` (120) already includes cache reads/writes (see
    // CursorReportedUsage's doc comment and parseCursorReportedUsage's
    // `cacheReadTokens + cacheWriteTokens <= inputTokens` invariant), unlike
    // Claude, where input and cache are independent counters that the
    // Usage page's `tokenTotal()` sums together. Recording the raw 120 here
    // alongside cacheReadInputTokens/cacheCreationInputTokens double-counts
    // the 15 cached tokens in every downstream total; `tokens.input` must be
    // the non-cached remainder (120 - 10 - 5 = 105) so the same summed-total
    // formula is correct for every provider.
    expect(entry.tokens.input).toBe(105);
    expect(entry.tokens.output).toBe(45);
    expect(entry.tokens.cacheReadInputTokens).toBe(10);
    expect(entry.tokens.cacheCreationInputTokens).toBe(5);
  });

  it('tracks OpenCode pipeline identity, patches and reported usage', () => {
    installMockFilesystem();
    const service = new ObservabilityService();
    service.syncPipelineExecutionState({
      id: 'exec-1',
      pipeline_id: 'pipeline-1',
      pipeline_snapshot: { name: 'Pipeline' },
      project_id: 'proj',
      worktree_id: 'wt',
      jobs: {
        job1: {
          status: 'running',
          outputs: {},
          steps: {
            step1: {
              status: 'running',
              outputs: {},
              dynamic_env: {},
              started_at: new Date().toISOString(),
              log_format_hint: 'agent',
              agent_provider: 'opencode',
              agent_harness: 'opencode',
              agent_model: 'opencode:fixture%2Fmodel',
            },
          },
        },
      },
    });
    service.observePipelineOutput({
      executionId: 'exec-1',
      jobId: 'job1',
      stepId: 'step1',
      attempt: 0,
      data: [
        {
          type: 'canopy_assistant_patch',
          provider: 'opencode',
          messageId: 'answer',
          timestamp: 1,
          revision: 1,
          patches: [
            { index: 0, block: { type: 'text', text: 'Pipeline answer' } },
          ],
        },
        {
          type: 'result',
          provider: 'opencode',
          is_error: false,
          result: '',
          usage: { input_tokens: 20, output_tokens: 10 },
        },
      ]
        .map((event) => JSON.stringify(event) + '\n')
        .join(''),
    });
    expect(loadOnlyRecentEntry(service)).toMatchObject({
      provider: 'opencode',
      assistantMessageCount: 1,
      tokens: { input: 20, output: 10 },
    });
  });

  it('persists OpenCode assistant patches for durable transcript replay', async () => {
    const service = new ObservabilityService();
    installMockFilesystem();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'opencode',
      model: 'opencode:fixture%2Fmodel',
      originalUserText: 'Hello',
      submittedText: 'Hello',
      planMode: false,
      isStandalone: false,
      repoId: '__single_repo__',
      repoLabel: 'repo',
    });
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'canopy_assistant_patch',
      provider: 'opencode',
      messageId: 'answer',
      timestamp: 1,
      revision: 1,
      patches: [{ index: 0, block: { type: 'text', text: 'OpenCode answer' } }],
    });
    service.completeChatTurn('proj', 'wt', 'chat', 'success');
    const entry = loadOnlyRecentEntry(service);
    await service.flush();
    await service.dispose();
    const reloaded = new ObservabilityService();
    try {
      const transcript = await reloaded.loadTranscript({
        id: entry.id,
        eventType: entry.eventType,
        startedAt: entry.startedAt,
      });
      expect(transcript.type).toBe('success');
      if (transcript.type !== 'success') throw new Error('Expected transcript');
      expect(transcript.lines.join('\n')).toContain('OpenCode answer');
      expect(
        (await reloaded.loadHistory({ limit: 10 })).entries,
      ).toContainEqual(expect.objectContaining({ provider: 'opencode' }));
    } finally {
      await reloaded.dispose();
    }
  });

  it('accumulates Codex token usage across structured-output retry turns', () => {
    installMockFilesystem();

    const service = new ObservabilityService();
    service.syncPipelineExecutionState({
      id: 'exec-1',
      pipeline_id: 'pipeline-1',
      pipeline_snapshot: { name: 'Pipeline' },
      project_id: 'proj',
      worktree_id: 'wt',
      jobs: {
        job1: {
          status: 'running',
          outputs: {},
          steps: {
            step1: {
              status: 'running',
              outputs: {},
              dynamic_env: {},
              started_at: '2026-03-26T10:00:00.000Z',
              log_format_hint: 'agent',
              agent_provider: 'codex',
              agent_model: 'gpt-6-sol',
            },
          },
        },
      },
    });

    const usageLine = (turnId: string, last: Record<string, number>): string =>
      JSON.stringify(
        projectCodexRuntimeEvent({
          method: 'thread/tokenUsage/updated',
          params: {
            threadId: 'thread-live',
            turnId,
            tokenUsage: { last, modelContextWindow: 200000 },
          },
        }),
      );
    const observe = (line: string): void => {
      service.observePipelineOutput({
        executionId: 'exec-1',
        jobId: 'job1',
        stepId: 'step1',
        attempt: 0,
        data: `${line}\n`,
      });
    };

    observe(
      JSON.stringify(
        projectCodexRuntimeEvent({
          method: 'turn/started',
          params: {
            threadId: 'thread-live',
            turn: { id: 'turn-1', items: [], status: 'inProgress' },
          },
        }),
      ),
    );
    observe(
      usageLine('turn-1', {
        totalTokens: 120,
        inputTokens: 80,
        cachedInputTokens: 16,
        outputTokens: 40,
        reasoningOutputTokens: 8,
      }),
    );
    expect(loadOnlyRecentEntry(service).tokens.input).toBe(80);

    // A second notification for the same turn replaces that turn's
    // contribution rather than double counting it.
    observe(
      usageLine('turn-1', {
        totalTokens: 150,
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 50,
        reasoningOutputTokens: 10,
      }),
    );
    let entry = loadOnlyRecentEntry(service);
    expect(entry.tokens.input).toBe(100);
    expect(entry.tokens.output).toBe(50);

    // A structured-output retry runs a second turn against the same audit
    // entry; its usage must add to the first turn's, not replace it.
    observe(
      JSON.stringify(
        projectCodexRuntimeEvent({
          method: 'turn/started',
          params: {
            threadId: 'thread-live',
            turn: { id: 'turn-2', items: [], status: 'inProgress' },
          },
        }),
      ),
    );
    observe(
      usageLine('turn-2', {
        totalTokens: 90,
        inputTokens: 60,
        cachedInputTokens: 4,
        outputTokens: 30,
        reasoningOutputTokens: 2,
      }),
    );
    entry = loadOnlyRecentEntry(service);
    expect(entry.tokens.input).toBe(160);
    expect(entry.tokens.output).toBe(80);
    expect(entry.tokens.cacheReadInputTokens).toBe(24);
    expect(entry.tokens.reasoningOutputTokens).toBe(12);
  });

  it('ignores Codex usage before or outside the active provider turn', () => {
    const service = new ObservabilityService();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'codex',
      originalUserText: 'Continue a restored thread',
      submittedText: 'Continue a restored thread',
      planMode: false,
      isStandalone: false,
    });

    const observe = (event: Record<string, unknown>): void => {
      service.observeChatEvent('proj', 'wt', 'chat', {
        type: 'codex',
        event,
      });
    };
    const staleUsage = {
      input_tokens: 75_000,
      cached_input_tokens: 4_000,
      output_tokens: 2_659,
      reasoning_output_tokens: 1_000,
      cumulative_input_tokens: 700_000,
      cumulative_cached_input_tokens: 40_000,
      cumulative_output_tokens: 8_126,
      cumulative_reasoning_output_tokens: 2_000,
    };

    observe({
      type: 'thread.token_usage.updated',
      thread_id: 'thread-1',
      turn_id: 'turn-before-resume',
      usage: staleUsage,
    });
    expect(loadOnlyRecentEntry(service).tokens.input).toBe(0);

    observe({ type: 'thread.started', thread_id: 'thread-1' });
    observe({
      type: 'turn.started',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
    });
    observe({
      type: 'turn.started',
      thread_id: 'subagent-thread',
      turn_id: 'subagent-turn',
    });
    observe({
      type: 'thread.token_usage.updated',
      thread_id: 'thread-1',
      turn_id: 'turn-before-resume',
      usage: staleUsage,
    });
    expect(loadOnlyRecentEntry(service).tokens.input).toBe(0);

    observe({
      type: 'thread.token_usage.updated',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      usage: {
        input_tokens: 80,
        cached_input_tokens: 16,
        output_tokens: 40,
        reasoning_output_tokens: 8,
        cumulative_input_tokens: 80,
        cumulative_cached_input_tokens: 16,
        cumulative_output_tokens: 40,
        cumulative_reasoning_output_tokens: 8,
      },
    });
    const entry = loadOnlyRecentEntry(service);
    expect(entry.tokens.input).toBe(80);
    expect(entry.tokens.output).toBe(40);
    expect(entry.tokens.cacheReadInputTokens).toBe(16);
    expect(entry.tokens.reasoningOutputTokens).toBe(8);
  });

  it('derives Codex audit totals from cumulative snapshots across responses and turns', () => {
    const service = new ObservabilityService();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'codex',
      originalUserText: 'Use tools and continue after reload',
      submittedText: 'Use tools and continue after reload',
      planMode: false,
      isStandalone: false,
    });

    const observeUsage = (
      turnId: string,
      usage: Record<string, number>,
      threadId = 'thread-1',
    ): void => {
      service.observeChatEvent('proj', 'wt', 'chat', {
        type: 'codex',
        event: {
          type: 'thread.token_usage.updated',
          thread_id: threadId,
          turn_id: turnId,
          usage,
        },
      });
    };
    const observeStarted = (turnId: string, threadId = 'thread-1'): void => {
      service.observeChatEvent('proj', 'wt', 'chat', {
        type: 'codex',
        event: {
          type: 'turn.started',
          thread_id: threadId,
          turn_id: turnId,
        },
      });
    };
    const observeTerminal = (
      turnId: string,
      usage: Record<string, number>,
      threadId = 'thread-1',
    ): void => {
      service.observeChatEvent('proj', 'wt', 'chat', {
        type: 'codex',
        event: {
          type: 'turn.completed',
          thread_id: threadId,
          turn_id: turnId,
          usage,
        },
      });
    };

    observeStarted('turn-1');
    observeUsage('turn-1', {
      input_tokens: 80,
      cached_input_tokens: 16,
      output_tokens: 40,
      reasoning_output_tokens: 8,
      cumulative_input_tokens: 80,
      cumulative_cached_input_tokens: 16,
      cumulative_output_tokens: 40,
      cumulative_reasoning_output_tokens: 8,
    });
    observeUsage('turn-1', {
      input_tokens: 20,
      cached_input_tokens: 4,
      output_tokens: 10,
      reasoning_output_tokens: 2,
      cumulative_input_tokens: 100,
      cumulative_cached_input_tokens: 20,
      cumulative_output_tokens: 50,
      cumulative_reasoning_output_tokens: 10,
    });
    // A repeated cumulative snapshot is idempotent even when `last` is still
    // populated with the most recent response completion.
    observeUsage('turn-1', {
      input_tokens: 20,
      cached_input_tokens: 4,
      output_tokens: 10,
      reasoning_output_tokens: 2,
      cumulative_input_tokens: 100,
      cumulative_cached_input_tokens: 20,
      cumulative_output_tokens: 50,
      cumulative_reasoning_output_tokens: 10,
    });
    observeTerminal('turn-1', {
      input_tokens: 100,
      cached_input_tokens: 20,
      output_tokens: 50,
      reasoning_output_tokens: 10,
    });

    observeStarted('turn-2', 'thread-2');
    observeUsage(
      'turn-2',
      {
        input_tokens: 60,
        cached_input_tokens: 4,
        output_tokens: 30,
        reasoning_output_tokens: 2,
        // This is a different thread whose cumulative history predates the
        // audit entry. Only its latest response belongs to this entry.
        cumulative_input_tokens: 500,
        cumulative_cached_input_tokens: 100,
        cumulative_output_tokens: 250,
        cumulative_reasoning_output_tokens: 50,
      },
      'thread-2',
    );
    observeTerminal(
      'turn-2',
      {
        input_tokens: 60,
        cached_input_tokens: 4,
        output_tokens: 30,
        reasoning_output_tokens: 2,
      },
      'thread-2',
    );

    const entry = loadOnlyRecentEntry(service);
    expect(entry.tokens.input).toBe(160);
    expect(entry.tokens.output).toBe(80);
    expect(entry.tokens.cacheReadInputTokens).toBe(24);
    expect(entry.tokens.reasoningOutputTokens).toBe(12);
  });

  it('accumulates terminal Codex usage by turn when cumulative snapshots are unavailable', () => {
    const service = new ObservabilityService();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'codex',
      originalUserText: 'Continue internally',
      submittedText: 'Continue internally',
      planMode: false,
      isStandalone: false,
    });

    for (const [turnId, inputTokens, outputTokens] of [
      ['turn-1', 100, 50],
      ['turn-2', 60, 30],
    ] as const) {
      service.observeChatEvent('proj', 'wt', 'chat', {
        type: 'codex',
        event: {
          type: 'turn.completed',
          thread_id: 'thread-1',
          turn_id: turnId,
          usage: {
            input_tokens: inputTokens,
            cached_input_tokens: 0,
            output_tokens: outputTokens,
            reasoning_output_tokens: 0,
          },
        },
      });
    }

    const entry = loadOnlyRecentEntry(service);
    expect(entry.tokens.input).toBe(160);
    expect(entry.tokens.output).toBe(80);
  });

  it('uses terminal Codex usage only for turns without cumulative snapshots', () => {
    const service = new ObservabilityService();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'codex',
      originalUserText: 'Continue internally',
      submittedText: 'Continue internally',
      planMode: false,
      isStandalone: false,
    });

    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'codex',
      event: {
        type: 'thread.token_usage.updated',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        usage: {
          input_tokens: 100,
          cached_input_tokens: 20,
          output_tokens: 50,
          reasoning_output_tokens: 10,
          cumulative_input_tokens: 100,
          cumulative_cached_input_tokens: 20,
          cumulative_output_tokens: 50,
          cumulative_reasoning_output_tokens: 10,
        },
      },
    });
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'codex',
      event: {
        type: 'turn.completed',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        usage: {
          input_tokens: 100,
          cached_input_tokens: 20,
          output_tokens: 50,
          reasoning_output_tokens: 10,
        },
      },
    });
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'codex',
      event: {
        type: 'turn.completed',
        thread_id: 'thread-1',
        turn_id: 'turn-2',
        usage: {
          input_tokens: 60,
          cached_input_tokens: 4,
          output_tokens: 30,
          reasoning_output_tokens: 2,
        },
      },
    });

    const entry = loadOnlyRecentEntry(service);
    expect(entry.tokens.input).toBe(160);
    expect(entry.tokens.output).toBe(80);
    expect(entry.tokens.cacheReadInputTokens).toBe(24);
    expect(entry.tokens.reasoningOutputTokens).toBe(12);
  });

  it('accepts live agent-loop stdout events in the iteration wrapper shape', () => {
    const service = new ObservabilityService();
    service.syncPipelineExecutionState(makeRunningPipelineState());

    service.observePipelineOutput({
      executionId: 'exec-1',
      jobId: 'job1',
      stepId: 'step1',
      attempt: 0,
      data: '{"iteration":1,"event":{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"README.md"}}]}}}\n',
    });

    const entry = loadOnlyRecentEntry(service);
    expect(entry.assistantMessageCount).toBe(1);
    expect(entry.toolUseCount).toBe(1);
    expect(entry.toolCounts.read).toBe(1);
  });

  it.each([false, true])(
    'replays a persisted Cursor error with preceding assistant text: %s',
    async (withAssistantText) => {
      installMockFilesystem();
      const service = new ObservabilityService();
      service.startChatTurn({
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat',
        provider: 'cursor',
        model: 'cursor-default',
        originalUserText: 'Reply',
        submittedText: 'Reply',
        planMode: false,
        isStandalone: false,
        repoId: '__single_repo__',
        repoLabel: 'repo',
      });
      if (withAssistantText) {
        const projection = new CursorEventProjection();
        service.observeChatEvent(
          'proj',
          'wt',
          'chat',
          projection.update({
            sessionId: 's',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Starting the request.' },
            },
          }),
        );
      }
      const error = 'Cursor could not complete the request: resource_exhausted';
      service.observeChatEvent('proj', 'wt', 'chat', {
        type: 'error',
        provider: 'cursor',
        error,
      });
      service.completeChatTurn('proj', 'wt', 'chat', 'failed', error);
      const entry = loadOnlyRecentEntry(service);
      await service.flush();
      await service.dispose();
      const reloaded = new ObservabilityService();
      try {
        const transcript = await reloaded.loadTranscript({
          id: entry.id,
          eventType: entry.eventType,
          startedAt: entry.startedAt,
        });
        if (transcript.type !== 'success')
          throw new Error('Expected Cursor transcript');
        const parsed = parseAgentTranscriptLines(transcript.lines, 'cursor');
        expect(
          parsed.messages
            .filter((message) => message.role === 'system')
            .flatMap((message) => message.blocks),
        ).toContainEqual({
          type: 'text',
          text: `Error: ${error}`,
        });
      } finally {
        await reloaded.dispose();
      }
    },
  );

  it('persists live Cursor patches and terminal results for transcript replay', async () => {
    installMockFilesystem();
    const service = new ObservabilityService();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'cursor',
      model: 'cursor-default',
      originalUserText: 'Read file',
      submittedText: 'Read file',
      planMode: false,
      isStandalone: false,
      repoId: '__single_repo__',
      repoLabel: 'repo',
    });
    const projection = new CursorEventProjection();
    for (const event of [
      projection.notice('Cursor context was reset.'),
      projection.update({
        sessionId: 's',
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'Thinking first' },
        },
      }),
      projection.update({
        sessionId: 's',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Hello ' },
        },
      }),
      projection.update({
        sessionId: 's',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'world' },
        },
      }),
      projection.update({
        sessionId: 's',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'read-1',
          title: 'Read file',
          kind: 'read',
          status: 'pending',
          rawInput: { path: '/project/file' },
        },
      }),
      projection.update({
        sessionId: 's',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'read-1',
          status: 'completed',
          rawOutput: 'file contents',
        },
      }),
      { type: 'canopy_cursor_usage', provider: 'cursor', usage: null },
      {
        type: 'canopy_cursor_usage',
        provider: 'cursor',
        usage: { inputTokens: 12000, outputTokens: 800, cacheReadTokens: 9000 },
        text: 'DO_NOT_PERSIST',
      },
      {
        type: 'canopy_cursor_usage',
        provider: 'cursor',
        usage: { inputTokens: -1, outputTokens: 20 },
      },
      { type: 'result', is_error: false, result: '' },
    ])
      service.observeChatEvent('proj', 'wt', 'chat', event);
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'canopy_assistant_patch',
      provider: 'cursor',
      messageId: 'malformed',
      timestamp: 1,
      revision: 1,
      patches: [{ index: -1, appendText: 'DO_NOT_PERSIST' }],
    });
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'result',
      is_error: 'invalid',
      result: 'DO_NOT_PERSIST',
    });
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'codex',
      event: { type: 'DO_NOT_PERSIST' },
    });
    service.completeChatTurn('proj', 'wt', 'chat', 'success');
    const entry = loadOnlyRecentEntry(service);
    const usageRequest = {
      startDate: '2020-01-01T00:00:00Z',
      endDate: '2030-01-01T00:00:00Z',
      provider: 'cursor' as const,
    };
    expect(entry).toMatchObject({
      messageCount: 1,
      assistantMessageCount: 3,
      toolUseCount: 1,
      toolCounts: { ...entry.toolCounts, thinking: 1, read: 1 },
    });
    const liveUsage = await service.loadUsageMetrics(usageRequest);
    expect(liveUsage.chats.turnCountsByProvider?.rows).toContainEqual(
      expect.objectContaining({ provider: 'cursor', count: 1 }),
    );
    await service.flush();
    await service.dispose();
    const reloaded = new ObservabilityService();
    try {
      const reloadedUsage = await reloaded.loadUsageMetrics(usageRequest);
      expect(reloadedUsage.chats.turnCountsByProvider?.rows).toEqual(
        liveUsage.chats.turnCountsByProvider?.rows,
      );
      expect(
        (await reloaded.loadHistory({ limit: 10 })).entries,
      ).toContainEqual(
        expect.objectContaining({
          id: entry.id,
          messageCount: 1,
          assistantMessageCount: 3,
          toolUseCount: 1,
          toolCounts: { ...entry.toolCounts, thinking: 1, read: 1 },
        }),
      );

      const transcript = await reloaded.loadTranscript({
        id: entry.id,
        eventType: entry.eventType,
        startedAt: entry.startedAt,
      });
      expect(transcript.type).toBe('success');
      if (transcript.type !== 'success')
        throw new Error('Expected Cursor transcript');
      expect(
        transcript.lines.filter((line) =>
          line.includes('canopy_assistant_patch'),
        ),
      ).toHaveLength(6);
      expect(transcript.lines.join('\n')).not.toContain('DO_NOT_PERSIST');
      expect(
        transcript.lines.some((line) => line.includes('"type":"result"')),
      ).toBe(true);
      const parsed = parseAgentTranscriptLines(transcript.lines, 'cursor');
      expect(parsed.messages).toContainEqual(
        expect.objectContaining({
          role: 'system',
          blocks: [{ type: 'text', text: 'Cursor context was reset.' }],
        }),
      );
      expect(parsed.usage).toMatchObject({
        cursorReportedUsage: {
          inputTokens: 12000,
          outputTokens: 800,
          cacheReadTokens: 9000,
        },
        contextWindow: 0,
      });
      expect(
        parsed.messages
          .filter((message) => message.role === 'assistant')
          .flatMap((message) => message.blocks),
      ).toEqual([
        { type: 'thinking', text: 'Thinking first' },
        { type: 'text', text: 'Hello world' },
        {
          type: 'tool_use',
          toolUseId: anyToolUseId,
          toolName: 'Read file',
          input: '{"path":"/project/file"}',
          display: { toolName: 'Read', input: '{"file_path":"/project/file"}' },
        },
        {
          type: 'tool_result',
          toolUseId: anyToolUseId,
          toolName: 'Read file',
          output: '"file contents"',
          isError: false,
        },
      ]);
    } finally {
      await reloaded.dispose();
    }
  });

  it('keeps one Claude audit turn open across repeated preludes and persists all later output', async () => {
    installMockFilesystem();
    const service = new ObservabilityService();
    startClaudeChatTurn(service);
    const prelude = {
      type: 'result',
      is_error: false,
      num_turns: 0,
      result: '',
      origin: { kind: 'task-notification' },
      canopy_session_continues: true,
      canopy_turn_user_message_id: 'follow-up-user',
    };
    const nonterminalEvents = [
      prelude,
      prelude,
      {
        type: 'assistant',
        canopy_turn_user_message_id: 'follow-up-user',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'Still working' }],
        },
      },
      {
        type: 'assistant',
        canopy_turn_user_message_id: 'follow-up-user',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Reading the fixture' }],
        },
      },
      {
        type: 'assistant',
        canopy_turn_user_message_id: 'follow-up-user',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Read',
              input: { file_path: '/tmp/fixture.txt' },
            },
          ],
        },
      },
      {
        type: 'user',
        canopy_turn_user_message_id: 'follow-up-user',
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
      {
        type: 'assistant',
        canopy_turn_user_message_id: 'follow-up-user',
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
    ];
    for (const event of nonterminalEvents) {
      service.observeChatEvent('proj', 'wt', 'chat', event);
    }

    expect(loadOnlyRecentEntry(service).status).toBe('running');
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'result',
      is_error: false,
      num_turns: 1,
      result: 'Follow-up finished after interruption.',
      duration_ms: 125,
      canopy_turn_user_message_id: 'follow-up-user',
    });
    service.completeChatTurn('proj', 'wt', 'chat', 'success');
    const entry = loadOnlyRecentEntry(service);
    expect(entry.status).toBe('success');

    await service.flush();
    const transcript = await service.loadTranscript({
      id: entry.id,
      eventType: entry.eventType,
      startedAt: entry.startedAt,
    });
    expect(transcript.type).toBe('success');
    if (transcript.type !== 'success') {
      throw new Error('Expected Claude transcript');
    }
    const serialized = transcript.lines.join('\n');
    expect(
      transcript.lines.filter((line) =>
        line.includes('"canopy_session_continues":true'),
      ),
    ).toHaveLength(2);
    expect(serialized).toContain('Still working');
    expect(serialized).toContain('Reading the fixture');
    expect(serialized).toContain('fixture contents');
    expect(serialized).toContain('Follow-up finished after interruption.');
    expect(serialized).toContain('"duration_ms":125');

    await service.dispose();
  });

  it('counts Cursor blocks once across empty starts, appended chunks and repeated tool updates', async () => {
    installMockFilesystem();
    const service = new ObservabilityService();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'cursor',
      model: 'cursor-default',
      originalUserText: 'Read',
      submittedText: 'Read',
      planMode: false,
      isStandalone: false,
      repoId: '__single_repo__',
      repoLabel: 'repo',
    });
    const base = {
      type: 'canopy_assistant_patch',
      provider: 'cursor',
      messageId: 'cursor-message',
      timestamp: 1,
    };
    const initial = {
      ...base,
      revision: 1,
      patches: [
        { index: 0, block: { type: 'thinking', text: '' } },
        { index: 1, block: { type: 'text', text: '' } },
        {
          index: 2,
          block: {
            type: 'tool_use',
            toolUseId: 'read-1',
            toolName: 'Read',
            input: '{}',
          },
        },
      ],
    };
    const append = {
      ...base,
      revision: 2,
      patches: [
        { index: 0, appendText: 'Inspecting files' },
        { index: 1, appendText: 'The files contain ' },
      ],
    };
    const update = {
      ...base,
      revision: 3,
      patches: [
        { index: 1, appendText: 'source code.' },
        {
          index: 2,
          block: {
            type: 'tool_use',
            toolUseId: 'read-1',
            toolName: 'Read',
            input: '{"file_path":"/project/one"}',
          },
        },
        {
          index: 3,
          block: {
            type: 'tool_result',
            toolUseId: 'read-1',
            toolName: 'Read',
            output: 'source code',
            isError: false,
          },
        },
        {
          index: 4,
          block: {
            type: 'tool_use',
            toolUseId: 'read-2',
            toolName: 'Read',
            input: '{"file_path":"/project/two"}',
          },
        },
      ],
    };
    for (const event of [initial, append, append, update, update])
      service.observeChatEvent('proj', 'wt', 'chat', event);
    expect(loadOnlyRecentEntry(service)).toMatchObject({
      messageCount: 1,
      assistantMessageCount: 1,
      toolUseCount: 2,
      toolCounts: {
        ...loadOnlyRecentEntry(service).toolCounts,
        thinking: 1,
        read: 2,
      },
    });
    service.completeChatTurn('proj', 'wt', 'chat', 'success');
    await service.dispose();
  });

  it('persists a canopy_auth_failure chat event into the transcript sidecar', async () => {
    // The Portal reconstructs a shared run from the decrypted turn JSONL, so an
    // allowlist entry in `parseAgentTranscriptLines` is necessary but NOT
    // sufficient: `canopy_auth_failure` matches neither `isClaudeEventShape`
    // nor `isCodexEventShape` nor the normalized `error` branch, so before this
    // wiring the producer dropped it a layer earlier and the Portal never saw
    // one at all (CAN-1814 review round 3).
    installMockFilesystem();

    const service = new ObservabilityService();
    startClaudeChatTurn(service);
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'assistant',
      message: {
        model: 'claude-test',
        content: [{ type: 'text', text: 'hi' }],
      },
    });
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: CANOPY_AUTH_FAILURE_EVENT_TYPE,
      toolUseId: 'tu-1',
      failure: {
        dependencyClass: 'mcp',
        dependencyId: 'srv-1:cfg-1',
        displayName: 'Prod MCP server',
        failureClass: 'expired',
        recovery: { kind: 'mcp_oauth', serverId: 'srv-1', configId: 'cfg-1' },
      },
    });

    await service.flush();

    const entry = loadOnlyRecentEntry(service);
    expect(entry.hasTranscript).toBe(true);
    const response = await service.loadTranscript({
      id: entry.id,
      eventType: entry.eventType,
      startedAt: entry.startedAt,
    });
    expect(response.type).toBe('success');
    if (response.type !== 'success') {
      throw new Error('Expected chat transcript response');
    }
    expect(
      response.lines.some((line) =>
        line.includes(`"type":"${CANOPY_AUTH_FAILURE_EVENT_TYPE}"`),
      ),
    ).toBe(true);
    expect(
      response.lines.some((line) =>
        line.includes('"dependencyId":"srv-1:cfg-1"'),
      ),
    ).toBe(true);
  });

  it('captures native Claude delegation billing from the API-key account', async () => {
    const kindSpy = jest
      .spyOn(providerAuthState, 'peekProviderBillingAccountKind')
      .mockReturnValue('api_key');
    const service = new ObservabilityService();
    try {
      startClaudeChatTurn(service);
      service.observeChatEvent('proj', 'wt', 'chat', {
        type: 'canopy_delegation',
        delegation: {
          delegationId: 'claude-api-key-child',
          runGeneration: 1,
          sequence: 1,
          parentHarnessId: 'claude',
          parentTurnId: 'original',
          parentToolCallId: 'call',
          createdAt: Date.now(),
          task: {
            description: 'Review',
            prompt: 'Private prompt',
            executionMode: 'background',
          },
          snapshot: {
            delegationId: 'claude-api-key-child',
            status: 'running',
            outputTruncated: false,
            routeSnapshot: {
              selectedModelId: 'claude-reviewer',
              runtimeModelId: 'claude-sonnet-4-6',
              harnessId: 'claude',
              providerType: 'claude',
              billingAuthority: 'native',
            },
            usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
          },
          transcript: [],
        },
      });
      expect(
        service
          .loadSnapshot()
          .recentEntries.find(
            (entry) => entry.eventType === 'managed_delegation',
          ),
      ).toMatchObject({ provider: 'claude', billingBasis: 'api_key' });
    } finally {
      kindSpy.mockRestore();
      await service.dispose();
    }
  });

  it('keeps background child transcript events on the original turn after a new root turn starts', async () => {
    installMockFilesystem();
    const service = new ObservabilityService();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'codex',
      userMessageId: 'original',
      originalUserText: 'Review',
      submittedText: 'Review',
      planMode: false,
      isStandalone: false,
    });
    const original = loadOnlyRecentEntry(service);
    const event = (
      sequence: number,
      status: string,
    ): Record<string, unknown> => ({
      type: 'canopy_delegation',
      delegation: {
        delegationId: 'child',
        runGeneration: 1,
        sequence,
        parentHarnessId: 'codex',
        parentTurnId: 'original',
        parentToolCallId: 'call',
        createdAt: 100,
        task: {
          description: 'Review',
          prompt: 'Inspect source',
          executionMode: 'background',
        },
        snapshot: {
          delegationId: 'child',
          status,
          outputTruncated: false,
          routeSnapshot: {
            selectedModelId: 'reviewer',
            runtimeModelId: 'runtime',
            harnessId: 'claude',
          },
        },
        transcript: [
          {
            id: 'answer',
            type: 'text',
            text: 'Owned finding',
            sequence: 1,
            occurredAt: 110,
          },
        ],
      },
    });
    service.observeChatEvent('proj', 'wt', 'chat', event(1, 'running'));
    await service.flush();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'codex',
      userMessageId: 'newer',
      originalUserText: 'Next task',
      submittedText: 'Next task',
      planMode: false,
      isStandalone: false,
    });
    service.observeChatEvent('proj', 'wt', 'chat', event(2, 'completed'));
    await service.flush();
    const transcript = await service.loadTranscript({
      id: original.id,
      eventType: original.eventType,
      startedAt: original.startedAt,
    });
    expect(transcript.type).toBe('success');
    if (transcript.type !== 'success')
      throw new Error('Expected retained original transcript');
    expect(
      transcript.lines.filter((line) => line.includes('canopy_delegation')),
    ).toHaveLength(2);
    expect(transcript.lines.join('\n')).toContain('"status":"completed"');
  });

  it('shares one transcript byte budget across late delegation sidecar states', async () => {
    installMockFilesystem();
    const service = new ObservabilityService();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'codex',
      userMessageId: 'original',
      originalUserText: 'Review',
      submittedText: 'Review',
      planMode: false,
      isStandalone: false,
    });
    const original = loadOnlyRecentEntry(service);
    service.completeChatTurn('proj', 'wt', 'chat', 'success');
    await service.flush();

    const transcript = Array.from({ length: 16 }, (_, index) => ({
      id: `item-${String(index)}`,
      type: 'text' as const,
      text: 'x'.repeat(8192),
      sequence: index + 1,
      occurredAt: 110 + index,
    }));
    for (let index = 0; index < 70; index++)
      service.observeChatEvent('proj', 'wt', 'chat', {
        type: 'canopy_delegation',
        delegation: {
          delegationId: `child-${String(index)}`,
          runGeneration: 1,
          sequence: 1,
          parentHarnessId: 'codex',
          parentTurnId: 'original',
          parentToolCallId: `call-${String(index)}`,
          createdAt: 100,
          task: {
            description: 'Review',
            prompt: 'Inspect source',
            executionMode: 'background',
          },
          snapshot: {
            delegationId: `child-${String(index)}`,
            status: 'completed',
            outputTruncated: false,
            routeSnapshot: {
              selectedModelId: 'reviewer',
              runtimeModelId: 'runtime',
              harnessId: 'claude',
            },
          },
          transcript,
        },
      });
    await service.flush();

    const response = await service.loadTranscript({
      id: original.id,
      eventType: original.eventType,
      startedAt: original.startedAt,
    });
    expect(response.type).toBe('success');
    if (response.type !== 'success')
      throw new Error('Expected bounded retained transcript');
    expect(response.truncation.truncated).toBe(true);
    expect(response.truncation.storedBytes).toBeLessThanOrEqual(
      response.truncation.maxBytes,
    );
  });

  it('cannot recreate a purged worktree transcript from a late delegation event', async () => {
    const files = installMockFilesystem();
    const service = new ObservabilityService();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'codex',
      userMessageId: 'original',
      originalUserText: 'Review',
      submittedText: 'Review',
      planMode: false,
      isStandalone: false,
    });
    const event = (sequence: number): Record<string, unknown> => ({
      type: 'canopy_delegation',
      delegation: {
        delegationId: 'child',
        runGeneration: 1,
        sequence,
        parentHarnessId: 'codex',
        parentTurnId: 'original',
        parentToolCallId: 'call',
        createdAt: 100,
        task: {
          description: 'Review',
          prompt: 'Inspect source',
          executionMode: 'background',
        },
        snapshot: {
          delegationId: 'child',
          status: 'running',
          outputTruncated: false,
          routeSnapshot: {
            selectedModelId: 'reviewer',
            runtimeModelId: 'runtime',
            harnessId: 'claude',
          },
        },
        transcript: [
          {
            id: 'answer',
            type: 'text',
            text: `Finding ${String(sequence)}`,
            sequence,
            occurredAt: 110 + sequence,
          },
        ],
      },
    });
    service.observeChatEvent('proj', 'wt', 'chat', event(1));
    await service.flush();
    const transcriptPath = Array.from(files.keys()).find((path) =>
      path.includes('/transcripts/'),
    );
    expect(transcriptPath).toBeDefined();

    await service.purgeWorktreeData('proj', 'wt');
    expect(files.has(transcriptPath ?? '')).toBe(false);

    service.observeChatEvent('proj', 'wt', 'chat', event(2));
    await service.flush();

    expect(files.has(transcriptPath ?? '')).toBe(false);
  });

  it('persists synthetic Codex startup failures for transcript replay', async () => {
    installMockFilesystem();

    const service = new ObservabilityService();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'codex',
      originalUserText: 'Continue',
      submittedText: 'Continue',
      planMode: false,
      isStandalone: false,
    });
    const failure = {
      type: 'result',
      is_error: true,
      subtype: 'codex_error',
      result: 'thread example already has an active writer',
    };
    service.observeChatEvent('proj', 'wt', 'chat', {
      ...failure,
      is_error: false,
      result: 'should-not-persist',
    });
    service.observeChatEvent('proj', 'wt', 'chat', failure);

    await service.flush();

    const entry = loadOnlyRecentEntry(service);
    const response = await service.loadTranscript({
      id: entry.id,
      eventType: entry.eventType,
      startedAt: entry.startedAt,
    });
    expect(response.type).toBe('success');
    if (response.type !== 'success') {
      throw new Error('Expected Codex chat transcript response');
    }
    expect(response.lines).toContain(JSON.stringify(failure));
    expect(
      response.lines.some((line) => line.includes('should-not-persist')),
    ).toBe(false);

    const parsed = parseAgentTranscriptLines(response.lines, 'codex');
    expect(parsed.skippedLineCount).toBe(0);
    expect(parsed.messages.flatMap((message) => message.blocks)).toContainEqual(
      expect.objectContaining({
        type: 'text',
        text: `Error: ${failure.result}`,
      }),
    );
  });

  it('does not widen what other chat event types persist to the sidecar', async () => {
    // The auth-failure branch is an explicit, type-scoped addition. An event
    // shape that was dropped before must still be dropped, or this change
    // silently starts persisting unrelated internal chat traffic.
    installMockFilesystem();

    const service = new ObservabilityService();
    startClaudeChatTurn(service);
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'assistant',
      message: {
        model: 'claude-test',
        content: [{ type: 'text', text: 'hi' }],
      },
    });
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'canopy_internal_not_a_transcript_event',
      payload: 'should-not-persist',
    });

    await service.flush();

    const entry = loadOnlyRecentEntry(service);
    const response = await service.loadTranscript({
      id: entry.id,
      eventType: entry.eventType,
      startedAt: entry.startedAt,
    });
    expect(response.type).toBe('success');
    if (response.type !== 'success') {
      throw new Error('Expected chat transcript response');
    }
    expect(
      response.lines.some((line) => line.includes('should-not-persist')),
    ).toBe(false);
  });

  it('captures pipeline prompt records into transcript sidecars', async () => {
    installMockFilesystem();

    const service = new ObservabilityService();
    service.syncPipelineExecutionState(makeRunningPipelineState());

    service.observePipelineOutput({
      executionId: 'exec-1',
      jobId: 'job1',
      stepId: 'step1',
      attempt: 0,
      data: [
        JSON.stringify({
          type: 'canopy_user_prompt',
          provider: 'claude',
          original_text: 'Summarize the worktree changes.',
          submitted_text: 'Summarize the worktree changes.',
          plan_mode: false,
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            model: 'claude-test',
            content: [{ type: 'text', text: 'Summary ready' }],
          },
        }),
      ].join('\n'),
    });
    service.observePipelineOutput({
      executionId: 'exec-1',
      jobId: 'job1',
      stepId: 'step1',
      attempt: 0,
      data: '\n',
    });

    await service.flush();

    const entry = loadOnlyRecentEntry(service);
    const response = await service.loadTranscript({
      id: entry.id,
      eventType: entry.eventType,
      startedAt: entry.startedAt,
    });

    expect(entry.hasTranscript).toBe(true);
    expect(response.type).toBe('success');
    if (response.type !== 'success') {
      throw new Error('Expected pipeline transcript response');
    }
    expect(response.lines[0]).toContain('"type":"canopy_user_prompt"');
    expect(response.lines[1]).toContain('"Summary ready"');
  });

  it('attaches pipeline worker projected messages to the pipeline transcript sidecar', async () => {
    installMockFilesystem();

    const service = new ObservabilityService();
    service.syncPipelineExecutionState(makeRunningPipelineState());

    service.observePipelineOutput({
      executionId: 'exec-1',
      jobId: 'job1',
      stepId: 'step1',
      attempt: 0,
      data: `${JSON.stringify({
        type: 'claude_terminal_projected_messages',
        messages: [
          {
            id: 'msg-1',
            role: 'assistant',
            timestamp: Date.now(),
            blocks: [{ type: 'text', text: 'worker text' }],
          },
        ],
      })}\n`,
    });

    await service.flush();

    const entries = service.loadSnapshot().recentEntries;
    expect(entries).toHaveLength(1);
    const response = await service.loadTranscript({
      id: entries[0].id,
      eventType: entries[0].eventType,
      startedAt: entries[0].startedAt,
    });

    expect(entries[0].hasTranscript).toBe(true);
    expect(response.type).toBe('success');
    if (response.type !== 'success') {
      throw new Error('Expected pipeline transcript response');
    }
    expect(response.lines).toHaveLength(1);
    expect(response.lines[0]).toContain(
      '"type":"claude_terminal_projected_messages"',
    );
    expect(response.lines[0]).toContain('"worker text"');
  });

  it('does not recreate finalized pipeline entries when completed snapshots replay', async () => {
    const service = new ObservabilityService();
    service.syncPipelineExecutionState(makeRunningPipelineState());

    service.observePipelineOutput({
      executionId: 'exec-1',
      jobId: 'job1',
      stepId: 'step1',
      attempt: 0,
      data: '{"type":"assistant","message":{"model":"claude-test","content":[{"type":"text","text":"hello"}]}}\n{"type":"result","usage":{"input_tokens":3,"output_tokens":5}}\n',
    });

    const completedState = makeCompletedPipelineState();
    service.syncPipelineExecutionState(completedState);

    const finalizedEntry = loadOnlyRecentEntry(service);
    expect(finalizedEntry.status).toBe('success');
    expect(finalizedEntry.messageCount).toBe(1);
    expect(finalizedEntry.tokens.input).toBe(3);
    expect(finalizedEntry.tokens.output).toBe(5);

    service.syncPipelineExecutionState(completedState);

    const replayedEntry = loadOnlyRecentEntry(service);
    expect(replayedEntry.status).toBe('success');
    expect(replayedEntry.messageCount).toBe(1);
    expect(replayedEntry.tokens.input).toBe(3);
    expect(replayedEntry.tokens.output).toBe(5);

    await service.flush();

    expect(mockedAppendFile).toHaveBeenCalledTimes(3);
    const auditAppend = mockedAppendFile.mock.calls.find(
      (call) => call[0] === '/mock/observability/2026-03-26.jsonl',
    );
    const transcriptIndexAppend = mockedAppendFile.mock.calls.find(
      (call) =>
        call[0] === '/mock/observability/transcript-index/2026-03-26.jsonl',
    );
    expect(auditAppend).toBeDefined();
    expect(transcriptIndexAppend).toBeDefined();
    expect(String(auditAppend?.[1])).toContain('"hasTranscript":false');
    expect(String(auditAppend?.[1])).toContain('"hasTranscript":true');
  });

  it('stores pipeline session ids from step outputs on completion', () => {
    const service = new ObservabilityService();
    service.syncPipelineExecutionState(makeRunningPipelineState());

    service.syncPipelineExecutionState({
      id: 'exec-1',
      pipeline_id: 'pipeline-1',
      pipeline_snapshot: { name: 'Pipeline' },
      project_id: 'proj',
      worktree_id: 'wt',
      jobs: {
        job1: {
          status: 'success',
          outputs: {},
          steps: {
            step1: {
              status: 'success',
              outputs: {
                session_id: 'session-from-output',
              },
              dynamic_env: {},
              started_at: '2026-03-26T10:00:00.000Z',
              completed_at: '2026-03-26T10:01:00.000Z',
              log_format_hint: 'agent',
              agent_provider: 'claude',
            },
          },
        },
      },
    });

    expect(loadOnlyRecentEntry(service).sdkSessionId).toBe(
      'session-from-output',
    );
  });

  it('uses persisted pipeline gateway provenance without consulting the current catalog', () => {
    const service = new ObservabilityService();
    service.syncPipelineExecutionState(makeRunningPipelineState());

    const completedState = makeCompletedPipelineState();
    completedState.jobs.job1.steps.step1.outputs = {
      canopy_ai_credits_routed: 'true',
      canopy_model_gateway_routed: 'true',
    };
    service.syncPipelineExecutionState(completedState);

    expect(loadOnlyRecentEntry(service)).toMatchObject({
      aiCreditsRouted: true,
      modelGatewayRouted: true,
    });
  });

  it('never credits a pipeline step the account proxy served to the native account', () => {
    const identitySpy = jest
      .spyOn(providerAuthState, 'peekProviderAccountIdentity')
      .mockReturnValue({
        providerAccountKey: 'claude:native@example.com',
        accountEmail: 'native@example.com',
        planType: 'max',
      });
    const kindSpy = jest
      .spyOn(providerAuthState, 'peekProviderBillingAccountKind')
      .mockReturnValue('subscription');
    try {
      const service = new ObservabilityService();
      service.syncPipelineExecutionState(makeRunningPipelineState());

      const completedState = makeCompletedPipelineState();
      completedState.jobs.job1.steps.step1.outputs = {
        canopy_account_proxy_routed: 'true',
      };
      service.syncPipelineExecutionState(completedState);

      const entry = loadOnlyRecentEntry(service);
      expect(entry.billingBasis).toBe('account_proxy');
      expect(entry.providerAccountKey).toBeUndefined();
      expect(entry.aiCreditsRouted).toBeUndefined();
    } finally {
      identitySpy.mockRestore();
      kindSpy.mockRestore();
    }
  });

  it('never credits a helper the account proxy served to the native account', () => {
    const identitySpy = jest
      .spyOn(providerAuthState, 'peekProviderAccountIdentity')
      .mockReturnValue({
        providerAccountKey: 'claude:native@example.com',
        accountEmail: 'native@example.com',
        planType: 'max',
      });
    const kindSpy = jest
      .spyOn(providerAuthState, 'peekProviderBillingAccountKind')
      .mockReturnValue('subscription');
    try {
      const service = new ObservabilityService();
      service.startObservedTask('helper:proxy', {
        id: 'helper-proxy',
        eventType: 'local_memory_consolidation',
        status: 'running',
        provider: 'claude',
        label: 'Helper',
        startedAt: '2026-03-26T10:00:00.000Z',
        tokens: {
          input: 0,
          output: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        messageCount: 0,
        assistantMessageCount: 0,
        toolUseCount: 0,
        subAgentCount: 0,
        hasTranscript: false,
        toolCounts: {},
      });
      // The helper learns its route after its audit entry started.
      service.markObservedTaskAccountProxyRouted('helper:proxy');
      service.finalizeObservedTask('helper:proxy', 'success');

      const entry = loadOnlyRecentEntry(service);
      expect(entry.billingBasis).toBe('account_proxy');
      expect(entry.providerAccountKey).toBeUndefined();
    } finally {
      identitySpy.mockRestore();
      kindSpy.mockRestore();
    }
  });

  it('uses pipeline step model config overrides for Codex service tier', () => {
    const service = new ObservabilityService();

    service.syncPipelineExecutionState({
      ...makeRunningPipelineState(),
      model_config: { fastMode: false },
      jobs: {
        job1: {
          status: 'running',
          outputs: {},
          steps: {
            step1: {
              status: 'running',
              outputs: {},
              dynamic_env: {},
              started_at: '2026-03-26T10:00:00.000Z',
              log_format_hint: 'agent',
              agent_provider: 'codex',
              agent_model: 'gpt-6-sol',
              agent_model_config: { fastMode: true },
            },
          },
        },
      },
    });

    expect(loadOnlyRecentEntry(service).serviceTier).toBe('priority');
  });

  it('reuses the in-flight flush so concurrent callers do not append duplicates', async () => {
    let appendPending = false;
    let resolveAppend: (value?: void | PromiseLike<void>) => void = () => {};
    const appendStarted = createDeferred<void>();
    mockedAppendFile.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          appendPending = true;
          resolveAppend = resolve;
          appendStarted.resolve(undefined);
        }),
    );

    const service = new ObservabilityService();
    const startedAt = makeStartedAt(0);
    service.startObservedTask('task-1', {
      ...makeAuditEntry('task-1', startedAt),
      status: 'running',
      completedAt: undefined,
      durationMs: undefined,
    });
    service.finalizeObservedTask('task-1', 'success');

    const firstFlush = service.flush();
    const secondFlush = service.flush();

    await appendStarted.promise;

    expect(mockedAppendFile).toHaveBeenCalledTimes(1);
    expect(appendPending).toBe(true);
    resolveAppend();

    await Promise.all([firstFlush, secondFlush]);

    expect(mockedAppendFile).toHaveBeenCalledTimes(1);
  });

  it('preserves transcript records enqueued while a transcript append is in flight', async () => {
    const files = new Map<string, string>();
    let transcriptAppendPending = false;
    let releaseTranscriptAppend = (): void => {
      throw new Error('Expected transcript append to be pending');
    };
    let delayFirstTranscriptAppend = true;

    mockedAppendFile.mockImplementation(
      (pathArg: unknown, payloadArg: unknown): Promise<void> => {
        if (typeof pathArg !== 'string') {
          return Promise.reject(new Error('Unexpected append path'));
        }

        const payload =
          typeof payloadArg === 'string' ? payloadArg : String(payloadArg);

        if (
          delayFirstTranscriptAppend &&
          pathArg.includes('/mock/observability/transcripts/')
        ) {
          delayFirstTranscriptAppend = false;
          return new Promise<void>((resolve) => {
            transcriptAppendPending = true;
            releaseTranscriptAppend = (): void => {
              files.set(pathArg, `${files.get(pathArg) ?? ''}${payload}`);
              resolve();
            };
          });
        }

        files.set(pathArg, `${files.get(pathArg) ?? ''}${payload}`);
        return Promise.resolve();
      },
    );

    const service = new ObservabilityService();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'claude',
      originalUserText: 'Inspect the bug',
      submittedText: 'Inspect the bug',
      planMode: false,
      isStandalone: false,
    });
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: 'First response',
          },
        ],
      },
    });

    const flushPromise = service.flush();

    await Promise.resolve();
    await Promise.resolve();

    if (!transcriptAppendPending) {
      throw new Error('Expected transcript append to be pending');
    }

    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: 'Second response',
          },
        ],
      },
    });

    releaseTranscriptAppend();
    await flushPromise;

    const transcriptFile = Array.from(files.entries()).find(([path]) =>
      path.includes('/mock/observability/transcripts/'),
    );

    if (!transcriptFile) {
      throw new Error('Expected transcript file to be written');
    }

    expect(transcriptFile[1]).toContain('First response');
    expect(transcriptFile[1]).toContain('Second response');
  });

  it('observes Claude-compatible Ollama chat events without reclassifying them as Claude', () => {
    const service = new ObservabilityService();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'ollama',
      model: 'ollama-qwen3-coder',
      originalUserText: 'Explain the diff',
      submittedText: 'Explain the diff',
      planMode: false,
      isStandalone: false,
    });

    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'assistant',
      message: {
        model: 'qwen3-coder',
        content: [
          {
            type: 'text',
            text: 'Here is the summary.',
          },
        ],
      },
    });
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'result',
      usage: {
        input_tokens: 8,
        output_tokens: 5,
        cache_read_input_tokens: 2,
      },
    });

    const entry = loadOnlyRecentEntry(service);
    expect(entry.provider).toBe('ollama');
    expect(entry.model).toBe('qwen3-coder');
    expect(entry.messageCount).toBe(1);
    expect(entry.assistantMessageCount).toBe(1);
    expect(entry.tokens).toMatchObject({
      input: 8,
      output: 5,
      cacheReadInputTokens: 2,
    });
  });

  it('keeps the tracked Claude model when a synthetic session-limit message is observed', async () => {
    installMockFilesystem();
    const service = new ObservabilityService();

    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'claude',
      model: 'opus[1m]',
      originalUserText: 'Continue',
      submittedText: 'Continue',
      planMode: false,
      isStandalone: false,
    });

    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'assistant',
      message: {
        model: '<synthetic>',
        content: [
          {
            type: 'text',
            text: "You've hit your session limit.",
          },
        ],
      },
    });
    service.completeChatTurn(
      'proj',
      'wt',
      'chat',
      'failure',
      "You've hit your session limit.",
    );

    expect(loadOnlyRecentEntry(service).model).toBe('opus[1m]');

    await service.flushUsageMetricEvents();
    const completedUsageEvent = mockedAppendFile.mock.calls
      .filter(([pathArg]) =>
        String(pathArg).includes('/mock/observability/usage-events/'),
      )
      .flatMap(([, payload]) =>
        String(payload)
          .trim()
          .split('\n')
          .filter((line) => line.length > 0)
          .map((line): unknown => JSON.parse(line)),
      )
      .find(
        (event): event is { type: 'chat_turn_completed'; model?: string } =>
          typeof event === 'object' &&
          event !== null &&
          'type' in event &&
          event.type === 'chat_turn_completed',
      );

    expect(completedUsageEvent).toMatchObject({
      type: 'chat_turn_completed',
      model: 'opus[1m]',
      status: 'failure',
    });

    await service.dispose();
  });

  it('deducts ask-user pause time from chat turn duration statistics', async () => {
    jest.useFakeTimers();
    try {
      const service = new ObservabilityService();
      jest.setSystemTime(new Date('2026-05-26T12:00:00.000Z'));
      service.startChatTurn({
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat',
        provider: 'codex',
        originalUserText: 'Need a choice',
        submittedText: 'Need a choice',
        planMode: false,
        isStandalone: false,
      });

      jest.setSystemTime(new Date('2026-05-26T12:00:02.000Z'));
      service.pauseChatTurn('proj', 'wt', 'chat');

      jest.setSystemTime(new Date('2026-05-26T12:00:12.000Z'));
      service.resumeChatTurn('proj', 'wt', 'chat');

      jest.setSystemTime(new Date('2026-05-26T12:00:15.000Z'));
      service.completeChatTurn('proj', 'wt', 'chat', 'success');

      const entry = loadOnlyRecentEntry(service);
      expect(entry.durationMs).toBe(5_000);

      const summary = await service.loadUsageMetrics({
        startDate: '2026-05-26T00:00:00.000Z',
        endDate: '2026-05-27T00:00:00.000Z',
      });
      expect(summary.chats.turnDurationMs.stats).toMatchObject({
        avg: 5_000,
        p95: 5_000,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  // CAN-3106: a 56.8-day "turn" reached telemetry ingest and overflowed the
  // INTEGER `transcript_turns.duration_ms` column. The audit entry deliberately
  // keeps the recorded value, but the inputs that produced it must be
  // recoverable — otherwise a stale `startedAt` is indistinguishable from a
  // bogus provider-supplied duration after the fact.
  it('records a session diagnostic when a finalized turn duration is implausible', () => {
    jest.useFakeTimers();
    try {
      const service = new ObservabilityService();
      const recordSessionDiagnostic = jest.spyOn(
        service,
        'recordSessionDiagnostic',
      );
      jest.setSystemTime(new Date('2026-05-26T12:00:00.000Z'));
      service.startChatTurn({
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat',
        provider: 'codex',
        originalUserText: 'Long haul',
        submittedText: 'Long haul',
        planMode: false,
        isStandalone: false,
      });

      // 56.8 days later — the exact staging shape.
      jest.setSystemTime(new Date('2026-07-22T06:26:14.992Z'));
      service.completeChatTurn('proj', 'wt', 'chat', 'success');

      const diagnostic = recordSessionDiagnostic.mock.calls
        .map(([event]) => event)
        .find((event) => event.kind === 'implausible_turn_duration');
      expect(diagnostic).toMatchObject({
        kind: 'implausible_turn_duration',
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat',
        implausibleDurationMs: 4_904_774_992,
        implausibleDurationStartedAt: '2026-05-26T12:00:00.000Z',
        implausibleDurationPausedMs: 0,
        implausibleDurationProviderSupplied: false,
      });

      // Audit-trail fidelity: the locally recorded value is untouched.
      expect(loadOnlyRecentEntry(service).durationMs).toBe(4_904_774_992);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not record a session diagnostic for an unscoped observed task', () => {
    const service = new ObservabilityService();
    const recordSessionDiagnostic = jest.spyOn(
      service,
      'recordSessionDiagnostic',
    );
    const startedAt = '2026-05-26T12:00:00.000Z';
    service.startObservedTask(
      'unscoped-task',
      makeAuditEntry('unscoped-task', startedAt, {
        status: 'running',
        completedAt: undefined,
        durationMs: 4_904_774_992,
        projectId: undefined,
        worktreeId: undefined,
        chatId: undefined,
      }),
    );

    service.finalizeObservedTask('unscoped-task', 'success');

    expect(
      recordSessionDiagnostic.mock.calls.some(
        ([event]) => event.kind === 'implausible_turn_duration',
      ),
    ).toBe(false);
    // Scope filtering must not alter the local audit value.
    expect(loadOnlyRecentEntry(service).durationMs).toBe(4_904_774_992);
  });

  it('does not diagnose a duration at the plausibility ceiling', () => {
    jest.useFakeTimers();
    try {
      const service = new ObservabilityService();
      const recordSessionDiagnostic = jest.spyOn(
        service,
        'recordSessionDiagnostic',
      );
      jest.setSystemTime(new Date('2026-05-26T12:00:00.000Z'));
      service.startChatTurn({
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat',
        provider: 'codex',
        originalUserText: 'Exactly seven days',
        submittedText: 'Exactly seven days',
        planMode: false,
        isStandalone: false,
      });
      jest.setSystemTime(new Date('2026-06-02T12:00:00.000Z'));
      service.completeChatTurn('proj', 'wt', 'chat', 'success');

      expect(
        recordSessionDiagnostic.mock.calls.some(
          ([event]) => event.kind === 'implausible_turn_duration',
        ),
      ).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('counts normalized and raw Codex dynamic tool calls by shared category', () => {
    const service = new ObservabilityService();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'codex',
      originalUserText: 'Use tools',
      submittedText: 'Use tools',
      planMode: false,
      isStandalone: false,
    });

    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'codex',
      event: {
        type: 'item.started',
        item: {
          id: 'tool-1',
          type: 'dynamic_tool_call',
          tool: 'canopy_ask_user_question',
          arguments: { questions: [] },
        },
      },
    });
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'codex',
      event: {
        type: 'item.started',
        item: {
          id: 'tool-2',
          type: 'dynamic_tool_call',
          tool: 'request_user_input',
          arguments: { questions: [] },
        },
      },
    });
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'codex',
      event: {
        type: 'item.started',
        item: {
          id: 'tool-3',
          type: 'dynamicToolCall',
          tool: 'canopy_get_script_output',
          arguments: { scriptId: 'launch' },
        },
      },
    });

    const entry = loadOnlyRecentEntry(service);
    expect(entry.toolUseCount).toBe(3);
    expect(entry.toolCounts.askUser).toBe(2);
    expect(entry.toolCounts.scriptOutput).toBe(1);
  });

  it('counts Codex collab spawnAgent once and ignores control-plane collab calls', () => {
    const service = new ObservabilityService();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'codex',
      originalUserText: 'Use subagents',
      submittedText: 'Use subagents',
      planMode: false,
      isStandalone: false,
    });

    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'codex',
      event: {
        type: 'item.started',
        item: {
          id: 'agent-call-1',
          type: 'collab_agent_tool_call',
          tool: 'spawnAgent',
        },
      },
    });
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'codex',
      event: {
        type: 'item.started',
        item: {
          id: 'agent-call-1',
          type: 'collab_agent_tool_call',
          tool: 'spawnAgent',
        },
      },
    });

    for (const tool of ['sendInput', 'resumeAgent', 'wait', 'closeAgent']) {
      service.observeChatEvent('proj', 'wt', 'chat', {
        type: 'codex',
        event: {
          type: 'item.started',
          item: {
            id: `agent-call-${tool}`,
            type: 'collab_agent_tool_call',
            tool,
          },
        },
      });
    }

    const entry = loadOnlyRecentEntry(service);
    expect(entry.toolUseCount).toBe(1);
    expect(entry.subAgentCount).toBe(1);
    expect(entry.toolCounts.agent).toBe(1);
  });

  it('attributes Codex child usage from the public chat event path without retaining prompts', () => {
    const service = new ObservabilityService();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'codex',
      model: 'parent-model',
      originalUserText: 'Use subagents',
      submittedText: 'Use subagents',
      planMode: false,
      isStandalone: false,
    });

    const observe = (event: Record<string, unknown>): void => {
      service.observeChatEvent('proj', 'wt', 'chat', {
        type: 'codex',
        event,
      });
    };
    observe({ type: 'thread.started', thread_id: 'root-thread' });
    observe({
      type: 'item.started',
      item: {
        id: 'agent-call-1',
        type: 'collab_agent_tool_call',
        tool: 'spawnAgent',
        receiver_thread_ids: ['sub-thread'],
        model: 'requested-child-model',
        prompt: 'never retain this private prompt',
      },
    });
    observe({
      type: 'thread.started',
      thread_id: 'sub-thread',
      model: 'actual-child-model',
      agent_nickname: 'Explorer',
      // The app-server can identify a child through its source union without
      // a top-level parent_thread_id.
      source: { subAgent: {} },
    });
    const childUsage = {
      type: 'thread.subagent_token_usage.updated',
      thread_id: 'sub-thread',
      turn_id: 'child-turn-1',
      total: {
        input_tokens: 900,
        cached_input_tokens: 90,
        cache_write_input_tokens: 30,
        output_tokens: 80,
        reasoning_output_tokens: 20,
      },
      last: {
        input_tokens: 12,
        cached_input_tokens: 3,
        cache_write_input_tokens: 2,
        output_tokens: 5,
        reasoning_output_tokens: 1,
      },
    };
    observe(childUsage);
    observe(childUsage);

    service.completeChatTurn('proj', 'wt', 'chat', 'success');

    const entry = loadOnlyRecentEntry(service);
    expect(entry.sdkSessionId).toBe('root-thread');
    expect(entry.subagents).toEqual([
      {
        id: 'sub-thread',
        kind: 'codex_agent',
        label: 'Explorer',
        model: 'actual-child-model',
        tokens: {
          input: 12,
          output: 5,
          cacheReadInputTokens: 3,
          cacheCreationInputTokens: 2,
          reasoningOutputTokens: 1,
        },
        inclusion: 'additional',
      },
    ]);
    expect(JSON.stringify(entry.subagents)).not.toContain(
      'never retain this private prompt',
    );
  });

  it('prices a Codex child whose receiver id and model arrive only on spawn completion', () => {
    installMockFilesystem();
    mockGetOpenAiPricingForCostingSync.mockReturnValue({
      payload: {
        version: 1,
        currency: 'usd',
        tokenUnit: 'per_1m_tokens',
        source: {
          pricingUrl: 'https://example.invalid/api-pricing',
          codexPricingUrl: 'https://example.invalid/codex-pricing',
          codexSpeedUrl: 'https://example.invalid/codex-speed',
          fetchedAt: '2026-06-18T00:00:00.000Z',
          generatedBy: 'test',
        },
        cache: { maxAgeSeconds: 3600, staleWhileRevalidateSeconds: 86400 },
        basis: {
          tokenPricing: 'openai_api_standard',
          fastModePricing: 'codex_credit_adjusted_standard_equivalent',
          notes: ['test pricing'],
        },
        serviceTierAliases: { default: 'standard', standard: 'standard' },
        models: {
          'requested-child-model': {
            model: 'requested-child-model',
            standard: { input: 2, cachedInput: 0.2, output: 8 },
            codexFast: { supported: true, standardCostMultiplier: 2 },
          },
        },
        unpricedModels: {},
        billableTools: {},
      },
      fetchedAt: '2026-06-18T00:00:00.000Z',
      loadedFrom: 'memory',
      stale: false,
    });
    try {
      const service = new ObservabilityService();
      service.startChatTurn({
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat',
        provider: 'codex',
        model: 'parent-model',
        originalUserText: 'Use a subagent',
        submittedText: 'Use a subagent',
        planMode: false,
        isStandalone: false,
      });
      const observe = (event: Record<string, unknown>): void => {
        service.observeChatEvent('proj', 'wt', 'chat', {
          type: 'codex',
          event,
        });
      };
      const spawn = {
        id: 'spawn-late',
        type: 'collab_agent_tool_call',
        tool: 'spawnAgent',
      };
      observe({ type: 'item.started', item: spawn });
      observe({
        type: 'item.completed',
        item: {
          ...spawn,
          receiver_thread_ids: ['child-late'],
          model: 'requested-child-model',
        },
      });
      observe({
        type: 'thread.started',
        thread_id: 'child-late',
        model: null,
        source: { subAgent: {} },
      });
      observe({
        type: 'thread.subagent_token_usage.updated',
        thread_id: 'child-late',
        turn_id: 'child-turn',
        total: { input_tokens: 10, output_tokens: 5 },
        last: { input_tokens: 10, output_tokens: 5 },
      });
      service.completeChatTurn('proj', 'wt', 'chat', 'success');

      const entry = loadOnlyRecentEntry(service);
      const [child] = entry.subagents ?? [];
      expect(child?.model).toBe('requested-child-model');
      expect(child?.costUsd).toBeGreaterThan(0);
      // The spawn is counted once even though both events carried it.
      expect(entry.subAgentCount).toBe(1);
    } finally {
      mockGetOpenAiPricingForCostingSync.mockReturnValue({
        loadedFrom: 'none',
        stale: true,
      });
    }
  });

  it('prices multiple Codex children using each child model and the parent service tier', () => {
    installMockFilesystem();
    mockGetOpenAiPricingForCostingSync.mockReturnValue({
      payload: {
        version: 1,
        currency: 'usd',
        tokenUnit: 'per_1m_tokens',
        source: {
          pricingUrl: 'https://example.invalid/api-pricing',
          codexPricingUrl: 'https://example.invalid/codex-pricing',
          codexSpeedUrl: 'https://example.invalid/codex-speed',
          fetchedAt: '2026-06-18T00:00:00.000Z',
          generatedBy: 'test',
        },
        cache: { maxAgeSeconds: 3600, staleWhileRevalidateSeconds: 86400 },
        basis: {
          tokenPricing: 'openai_api_standard',
          fastModePricing: 'codex_credit_adjusted_standard_equivalent',
          notes: ['test pricing'],
        },
        serviceTierAliases: {
          default: 'standard',
          standard: 'standard',
          priority: 'fast',
        },
        models: {
          'actual-child-model': {
            model: 'actual-child-model',
            standard: {
              input: 1,
              cachedInput: 0.1,
              cacheWriteInput: 2,
              output: 4,
            },
            codexFast: { supported: true, standardCostMultiplier: 2 },
          },
          'requested-child-model': {
            model: 'requested-child-model',
            standard: { input: 2, cachedInput: 0.2, output: 8 },
            codexFast: { supported: true, standardCostMultiplier: 2 },
          },
        },
        unpricedModels: {},
        billableTools: {},
      },
      fetchedAt: '2026-06-18T00:00:00.000Z',
      loadedFrom: 'memory',
      stale: false,
    });

    const service = new ObservabilityService();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'codex',
      model: 'parent-model',
      serviceTier: 'priority',
      originalUserText: 'Use subagents',
      submittedText: 'Use subagents',
      planMode: false,
      isStandalone: false,
    });
    const observe = (event: Record<string, unknown>): void => {
      service.observeChatEvent('proj', 'wt', 'chat', {
        type: 'codex',
        event,
      });
    };
    observe({
      type: 'item.started',
      item: {
        id: 'spawn-a',
        type: 'collab_agent_tool_call',
        tool: 'spawnAgent',
        receiver_thread_ids: ['child-a'],
        model: 'requested-child-model',
        prompt: 'private prompt text',
      },
    });
    observe({
      type: 'item.started',
      item: {
        id: 'spawn-b',
        type: 'collab_agent_tool_call',
        tool: 'spawnAgent',
        receiver_thread_ids: ['child-b'],
        model: 'requested-child-model',
      },
    });
    observe({
      type: 'thread.started',
      thread_id: 'child-a',
      model: 'actual-child-model',
      agent_nickname: 'Explorer',
      source: { subAgent: {} },
    });

    const childAUsage = {
      type: 'thread.subagent_token_usage.updated',
      thread_id: 'child-a',
      turn_id: 'child-turn-a',
      total: {
        input_tokens: 1000,
        cached_input_tokens: 200,
        cache_write_input_tokens: 100,
        output_tokens: 500,
        reasoning_output_tokens: 300,
      },
      last: {
        input_tokens: 10,
        cached_input_tokens: 2,
        cache_write_input_tokens: 1,
        output_tokens: 5,
        reasoning_output_tokens: 3,
      },
    };
    const childBUsage = {
      type: 'thread.subagent_token_usage.updated',
      thread_id: 'child-b',
      turn_id: 'child-turn-b',
      total: {
        input_tokens: 2000,
        cached_input_tokens: 400,
        output_tokens: 1000,
        reasoning_output_tokens: 600,
      },
      last: {
        input_tokens: 20,
        cached_input_tokens: 4,
        output_tokens: 10,
        reasoning_output_tokens: 6,
      },
    };
    observe(childAUsage);
    observe(childAUsage);
    observe(childBUsage);

    service.completeChatTurn('proj', 'wt', 'chat', 'success');

    const entry = loadOnlyRecentEntry(service);
    expect(entry.subagents).toEqual([
      expect.objectContaining({
        id: 'child-a',
        kind: 'codex_agent',
        label: 'Explorer',
        model: 'actual-child-model',
        costUsd: 0.0000584,
        inclusion: 'additional',
        tokens: {
          input: 10,
          output: 5,
          cacheReadInputTokens: 2,
          cacheCreationInputTokens: 1,
          reasoningOutputTokens: 3,
        },
      }),
      expect.objectContaining({
        id: 'child-b',
        kind: 'codex_agent',
        model: 'requested-child-model',
        costUsd: 0.0002256,
        inclusion: 'additional',
        tokens: {
          input: 20,
          output: 10,
          cacheReadInputTokens: 4,
          cacheCreationInputTokens: 0,
          reasoningOutputTokens: 6,
        },
      }),
    ]);
    expect(entry.subAgentCount).toBe(2);
    expect(JSON.stringify(entry.subagents)).not.toContain(
      'private prompt text',
    );
  });

  it('keeps accumulating Codex child usage after a completed chat turn reopens', () => {
    const service = new ObservabilityService();
    const observe = (event: Record<string, unknown>): void => {
      service.observeChatEvent('proj', 'wt', 'chat', {
        type: 'codex',
        event,
      });
    };
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'codex',
      model: 'parent-model',
      originalUserText: 'Use a subagent',
      submittedText: 'Use a subagent',
      planMode: false,
      isStandalone: false,
    });
    observe({
      type: 'thread.subagent_token_usage.updated',
      thread_id: 'child-a',
      turn_id: 'child-turn-1',
      total: { input_tokens: 10, output_tokens: 5 },
      last: { input_tokens: 10, output_tokens: 5 },
    });
    service.completeChatTurn('proj', 'wt', 'chat', 'interrupted');

    observe({
      type: 'item.completed',
      item: { type: 'agent_message', id: 'late-result', text: 'More work' },
    });
    expect(loadOnlyRecentEntry(service).status).toBe('running');
    observe({
      type: 'thread.subagent_token_usage.updated',
      thread_id: 'child-a',
      turn_id: 'child-turn-2',
      total: { input_tokens: 30, output_tokens: 8 },
      last: { input_tokens: 20, output_tokens: 3 },
    });
    service.completeChatTurn('proj', 'wt', 'chat', 'success');

    const [child] = loadOnlyRecentEntry(service).subagents ?? [];
    expect(child?.id).toBe('child-a');
    expect(child?.tokens).toMatchObject({ input: 30, output: 8 });
  });

  it('carries idle Codex child usage into the next chat turn without replaying totals', () => {
    const service = new ObservabilityService();
    const observe = (event: Record<string, unknown>): void => {
      service.observeChatEvent('proj', 'wt', 'chat', {
        type: 'codex',
        event,
      });
    };
    const startTurn = (): void => {
      service.startChatTurn({
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat',
        provider: 'codex',
        model: 'parent-model',
        originalUserText: 'Continue',
        submittedText: 'Continue',
        planMode: false,
        isStandalone: false,
      });
    };
    startTurn();
    observe({
      type: 'item.started',
      item: {
        id: 'spawn-a',
        type: 'collab_agent_tool_call',
        tool: 'spawnAgent',
        receiver_thread_ids: ['child-a'],
        model: 'child-model',
      },
    });
    observe({
      type: 'thread.subagent_token_usage.updated',
      thread_id: 'child-a',
      turn_id: 'child-turn-1',
      total: { input_tokens: 100, output_tokens: 20 },
      last: { input_tokens: 10, output_tokens: 2 },
    });
    service.completeChatTurn('proj', 'wt', 'chat', 'success');
    expect(loadOnlyRecentEntry(service).subagents?.[0]?.tokens).toMatchObject({
      input: 10,
      output: 2,
    });

    observe({
      type: 'thread.subagent_token_usage.updated',
      thread_id: 'child-a',
      turn_id: 'child-turn-late',
      total: { input_tokens: 125, output_tokens: 25 },
      last: { input_tokens: 25, output_tokens: 5 },
    });
    startTurn();
    observe({
      type: 'thread.subagent_token_usage.updated',
      thread_id: 'child-a',
      turn_id: 'child-turn-late',
      total: { input_tokens: 125, output_tokens: 25 },
      last: { input_tokens: 25, output_tokens: 5 },
    });
    observe({
      type: 'thread.subagent_token_usage.updated',
      thread_id: 'child-a',
      turn_id: 'child-turn-next',
      total: { input_tokens: 135, output_tokens: 27 },
      last: { input_tokens: 10, output_tokens: 2 },
    });
    service.completeChatTurn('proj', 'wt', 'chat', 'success');

    const entries = service.loadSnapshot().recentEntries;
    const nextTurn = entries.find((entry) => entry.subagents?.length === 1);
    expect(nextTurn?.subagents?.[0]?.tokens).toMatchObject({
      input: 35,
      output: 7,
    });
  });

  it('keeps late Codex child events pending while a Claude turn is open', () => {
    const service = new ObservabilityService();
    startClaudeChatTurn(service);
    const observe = (event: Record<string, unknown>): void => {
      service.observeChatEvent('proj', 'wt', 'chat', {
        type: 'codex',
        event,
      });
    };
    observe({
      type: 'item.started',
      item: {
        id: 'late-spawn',
        type: 'collab_agent_tool_call',
        tool: 'spawnAgent',
        receiver_thread_ids: ['late-child'],
        model: 'requested-child-model',
        prompt: 'private late prompt',
      },
    });
    observe({
      type: 'thread.started',
      thread_id: 'late-child',
      model: 'actual-child-model',
      agent_nickname: 'Late Explorer',
      source: { subAgent: {} },
    });
    const lateUsage = {
      type: 'thread.subagent_token_usage.updated',
      thread_id: 'late-child',
      turn_id: 'late-child-turn',
      total: { input_tokens: 100, output_tokens: 40 },
      last: { input_tokens: 10, output_tokens: 4 },
    };
    observe(lateUsage);
    // The transcript-capture path can dispatch a native event directly too;
    // child events must not relabel this still-open Claude entry there either.
    service.observeCodexEvent('chat:proj/wt/chat', lateUsage);

    const stillClaude = loadOnlyRecentEntry(service);
    expect(stillClaude.provider).toBe('claude');
    expect(stillClaude.subagents).toBeUndefined();
    expect(stillClaude.subAgentCount).toBe(0);

    service.completeChatTurn('proj', 'wt', 'chat', 'success');
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'codex',
      model: 'parent-model',
      originalUserText: 'Continue',
      submittedText: 'Continue',
      planMode: false,
      isStandalone: false,
    });
    service.completeChatTurn('proj', 'wt', 'chat', 'success');

    const codexEntry = loadOnlyRecentEntry(service);
    expect(codexEntry.provider).toBe('codex');
    expect(codexEntry.subAgentCount).toBe(0);
    expect(codexEntry.subagents).toEqual([
      expect.objectContaining({
        id: 'late-child',
        kind: 'codex_agent',
        label: 'Late Explorer',
        model: 'actual-child-model',
        tokens: {
          input: 10,
          output: 4,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          reasoningOutputTokens: 0,
        },
        inclusion: 'additional',
      }),
    ]);
    expect(JSON.stringify(codexEntry.subagents)).not.toContain(
      'private late prompt',
    );
  });

  it('keeps Codex child usage scoped to each open pipeline step', () => {
    const service = new ObservabilityService();
    service.syncPipelineExecutionState({
      id: 'exec-1',
      pipeline_id: 'pipeline-1',
      pipeline_snapshot: { name: 'Pipeline' },
      project_id: 'proj',
      worktree_id: 'wt',
      jobs: {
        job1: {
          status: 'running',
          outputs: {},
          steps: {
            step1: {
              status: 'running',
              outputs: {},
              dynamic_env: {},
              started_at: '2026-03-26T10:00:00.000Z',
              log_format_hint: 'agent',
              agent_provider: 'codex',
              agent_model: 'parent-model',
            },
          },
        },
      },
    });

    service.observePipelineOutput({
      executionId: 'exec-1',
      jobId: 'job1',
      stepId: 'step1',
      attempt: 0,
      data: `${JSON.stringify({
        type: 'thread.subagent_token_usage.updated',
        thread_id: 'pipeline-child',
        turn_id: 'pipeline-child-turn',
        total: { input_tokens: 800, output_tokens: 50 },
        last: { input_tokens: 8, output_tokens: 5 },
      })}\n`,
    });
    service.syncPipelineExecutionState({
      id: 'exec-1',
      pipeline_id: 'pipeline-1',
      pipeline_snapshot: { name: 'Pipeline' },
      project_id: 'proj',
      worktree_id: 'wt',
      jobs: {
        job1: {
          status: 'success',
          outputs: {},
          steps: {
            step1: {
              status: 'success',
              outputs: {},
              dynamic_env: {},
              started_at: '2026-03-26T10:00:00.000Z',
              completed_at: '2026-03-26T10:01:00.000Z',
              log_format_hint: 'agent',
              agent_provider: 'codex',
              agent_model: 'parent-model',
            },
          },
        },
      },
    });

    const entry = service
      .loadSnapshot()
      .recentEntries.find(
        (candidate) => candidate.eventType === 'pipeline_agent_turn',
      );
    expect(entry?.subagents).toHaveLength(1);
    expect(entry?.subagents).toMatchObject([
      {
        id: 'pipeline-child',
        kind: 'codex_agent',
        tokens: { input: 8, output: 5 },
        inclusion: 'additional',
      },
    ]);
  });

  it('does not guess a Codex child model from the parent when the child is unpriced', () => {
    const service = new ObservabilityService();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'codex',
      model: 'parent-model',
      originalUserText: 'Use subagents',
      submittedText: 'Use subagents',
      planMode: false,
      isStandalone: false,
    });
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'codex',
      event: {
        type: 'thread.subagent_token_usage.updated',
        thread_id: 'child-without-model',
        turn_id: 'child-turn-1',
        total: { input_tokens: 50, output_tokens: 10 },
        last: { input_tokens: 5, output_tokens: 1 },
      },
    });
    service.completeChatTurn('proj', 'wt', 'chat', 'success');

    expect(loadOnlyRecentEntry(service).subagents).toEqual([
      {
        id: 'child-without-model',
        kind: 'codex_agent',
        tokens: {
          input: 5,
          output: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          reasoningOutputTokens: 0,
        },
        inclusion: 'additional',
      },
    ]);
  });

  it('keeps Codex audit sdkSessionId pinned to the root thread', () => {
    const service = new ObservabilityService();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'codex',
      originalUserText: 'Use subagents',
      submittedText: 'Use subagents',
      planMode: false,
      isStandalone: false,
    });

    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'codex',
      event: {
        type: 'thread.started',
        thread_id: 'root-thread',
      },
    });
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'codex',
      event: {
        type: 'thread.started',
        thread_id: 'sub-thread',
        agent_nickname: 'Explorer',
      },
    });

    expect(loadOnlyRecentEntry(service).sdkSessionId).toBe('root-thread');
  });

  it('records local PR generation when Codex creates a PR via gh', () => {
    const service = new ObservabilityService();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'codex',
      repoId: 'repo-a',
      repoLabel: 'org/repo-a',
      originalUserText: 'Create a PR',
      submittedText: 'Create a PR',
      planMode: false,
      isStandalone: false,
    });

    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'codex',
      event: {
        type: 'item.completed',
        item: {
          id: 'cmd-pr',
          type: 'command_execution',
          command: 'gh pr create --title "Test" --body "Body"',
          aggregated_output: 'https://github.com/org/repo-a/pull/42',
          status: 'completed',
          exit_code: 0,
        },
      },
    });

    const prEntry = service
      .loadSnapshot()
      .recentEntries.find((entry) => entry.eventType === 'pr_generation');
    expect(prEntry).toMatchObject({
      status: 'success',
      provider: 'codex',
      projectId: 'proj',
      worktreeId: 'wt',
      repoId: 'repo-a',
      repoLabel: 'org/repo-a',
      chatId: 'chat',
    });
  });

  it('records created pull requests as PR activity entries', () => {
    const service = new ObservabilityService();

    service.recordCreatedPullRequest({
      projectId: 'proj',
      worktreeId: 'wt',
      repoId: 'repo-a',
      repoLabel: 'canopy',
      provider: 'claude',
      prNumber: 123,
      prUrl: 'https://github.com/org/canopy/pull/123',
    });

    const prEntry = service
      .loadSnapshot()
      .recentEntries.find((entry) => entry.eventType === 'pr_generation');
    expect(prEntry).toMatchObject({
      status: 'success',
      provider: 'claude',
      label: 'PR Created',
      projectId: 'proj',
      worktreeId: 'wt',
      repoId: 'repo-a',
      repoLabel: 'canopy',
    });
    expect(prEntry?.linkTarget).toBeUndefined();
  });

  it('records local PR generation when Codex creates a PR via gh with global options', () => {
    const service = new ObservabilityService();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'codex',
      repoId: 'repo-a',
      repoLabel: 'org/repo-a',
      originalUserText: 'Create a PR',
      submittedText: 'Create a PR',
      planMode: false,
      isStandalone: false,
    });

    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'codex',
      event: {
        type: 'item.completed',
        item: {
          id: 'cmd-pr',
          type: 'command_execution',
          command: 'gh --repo org/repo-a pr create --title "Test"',
          aggregated_output: 'https://github.com/org/repo-a/pull/42',
          status: 'completed',
          exit_code: 0,
        },
      },
    });

    const prEntry = service
      .loadSnapshot()
      .recentEntries.find((entry) => entry.eventType === 'pr_generation');
    expect(prEntry).toMatchObject({
      status: 'success',
      provider: 'codex',
      repoLabel: 'org/repo-a',
    });
  });

  it('recognizes gh pr new as a PR creation command', () => {
    const service = new ObservabilityService();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'codex',
      repoId: 'repo-a',
      repoLabel: 'org/repo-a',
      originalUserText: 'Create a PR',
      submittedText: 'Create a PR',
      planMode: false,
      isStandalone: false,
    });

    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'codex',
      event: {
        type: 'item.completed',
        item: {
          id: 'cmd-pr',
          type: 'command_execution',
          command: 'gh pr new --title "Test"',
          aggregated_output: 'https://github.com/org/repo-a/pull/42',
          status: 'completed',
          exit_code: 0,
        },
      },
    });

    const prEntry = service
      .loadSnapshot()
      .recentEntries.find((entry) => entry.eventType === 'pr_generation');
    expect(prEntry).toMatchObject({
      status: 'success',
      provider: 'codex',
      repoLabel: 'org/repo-a',
    });
  });

  it('does not record local PR generation when gh pr create is only mentioned', () => {
    const service = new ObservabilityService();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'codex',
      repoId: 'repo-a',
      repoLabel: 'org/repo-a',
      originalUserText: 'Create a PR',
      submittedText: 'Create a PR',
      planMode: false,
      isStandalone: false,
    });

    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'codex',
      event: {
        type: 'item.completed',
        item: {
          id: 'cmd-pr',
          type: 'command_execution',
          command: 'echo "Run: gh pr create"',
          aggregated_output: 'https://github.com/org/repo-a/pull/42',
          status: 'completed',
          exit_code: 0,
        },
      },
    });

    expect(
      service
        .loadSnapshot()
        .recentEntries.some((entry) => entry.eventType === 'pr_generation'),
    ).toBe(false);
  });

  it('does not record local PR generation for unrelated gh subcommands', () => {
    const service = new ObservabilityService();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'codex',
      repoId: 'repo-a',
      repoLabel: 'org/repo-a',
      originalUserText: 'Create a PR',
      submittedText: 'Create a PR',
      planMode: false,
      isStandalone: false,
    });

    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'codex',
      event: {
        type: 'item.completed',
        item: {
          id: 'cmd-pr',
          type: 'command_execution',
          command: 'gh auth login pr create',
          aggregated_output: 'https://github.com/org/repo-a/pull/42',
          status: 'completed',
          exit_code: 0,
        },
      },
    });

    expect(
      service
        .loadSnapshot()
        .recentEntries.some((entry) => entry.eventType === 'pr_generation'),
    ).toBe(false);
  });

  it.each(['Bash', 'PowerShell'] as const)(
    'records local PR generation when Claude creates a PR via %s',
    (toolName) => {
      const service = new ObservabilityService();
      service.startChatTurn({
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat',
        provider: 'claude',
        repoId: 'repo-b',
        repoLabel: 'org/repo-b',
        originalUserText: 'Create a PR',
        submittedText: 'Create a PR',
        planMode: false,
        isStandalone: false,
      });

      service.observeChatEvent('proj', 'wt', 'chat', {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-pr',
              name: toolName,
              input: {
                command: 'gh pr create --title "Test" --body "Body"',
              },
            },
          ],
        },
      });
      service.observeChatEvent('proj', 'wt', 'chat', {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-pr',
              content: 'https://github.com/org/repo-b/pull/84',
            },
          ],
        },
      });

      const prEntry = service
        .loadSnapshot()
        .recentEntries.find((entry) => entry.eventType === 'pr_generation');
      expect(prEntry).toMatchObject({
        status: 'success',
        provider: 'claude',
        projectId: 'proj',
        worktreeId: 'wt',
        repoId: 'repo-b',
        repoLabel: 'org/repo-b',
        chatId: 'chat',
      });
    },
  );

  it('does not record local PR generation from failed Claude Bash results', () => {
    const service = new ObservabilityService();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'claude',
      repoId: 'repo-b',
      repoLabel: 'org/repo-b',
      originalUserText: 'Create a PR',
      submittedText: 'Create a PR',
      planMode: false,
      isStandalone: false,
    });

    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tool-pr',
            name: 'Bash',
            input: {
              command: 'gh pr create --title "Test" --body "Body"',
            },
          },
        ],
      },
    });
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-pr',
            is_error: true,
            content:
              'could not create PR, see https://github.com/org/repo-b/pull/84',
          },
        ],
      },
    });

    expect(
      service
        .loadSnapshot()
        .recentEntries.some((entry) => entry.eventType === 'pr_generation'),
    ).toBe(false);
  });

  describe('commandLooksLikePrCreate', () => {
    it.each([
      ['gh pr create', true],
      ['gh pr new', true],
      ['cd app && gh pr create', true],
      ['gh --repo org/r pr create', true],
      ['FOO=bar gh pr create', true],
      ['gh "FOO=bar" pr create', false],
      ['gh --help pr create', true],
      ['gh pr list', false],
      ['gh auth login pr create', false],
      ['echo "Run: gh pr create"', false],
    ])('%s -> %s', (command, expected) => {
      expect(commandLooksLikePrCreate(command)).toBe(expected);
    });
  });

  it('flushes queued transcript lines before deleting a closed transcript state', async () => {
    const files = new Map<string, string>();
    let transcriptAppendPending = false;
    let releaseTranscriptAppend = (): void => {
      throw new Error('Expected transcript append to be pending');
    };
    let delayFirstTranscriptAppend = true;

    mockedAppendFile.mockImplementation(
      (pathArg: unknown, payloadArg: unknown): Promise<void> => {
        if (typeof pathArg !== 'string') {
          return Promise.reject(new Error('Unexpected append path'));
        }

        const payload =
          typeof payloadArg === 'string' ? payloadArg : String(payloadArg);

        if (
          delayFirstTranscriptAppend &&
          pathArg.includes('/mock/observability/transcripts/')
        ) {
          delayFirstTranscriptAppend = false;
          return new Promise<void>((resolve) => {
            transcriptAppendPending = true;
            releaseTranscriptAppend = (): void => {
              files.set(pathArg, `${files.get(pathArg) ?? ''}${payload}`);
              resolve();
            };
          });
        }

        files.set(pathArg, `${files.get(pathArg) ?? ''}${payload}`);
        return Promise.resolve();
      },
    );

    const service = new ObservabilityService();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'claude',
      originalUserText: 'Inspect the bug',
      submittedText: 'Inspect the bug',
      planMode: false,
      isStandalone: false,
    });
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: 'First response',
          },
        ],
      },
    });

    const flushPromise = service.flush();

    await Promise.resolve();
    await Promise.resolve();

    if (!transcriptAppendPending) {
      throw new Error('Expected transcript append to be pending');
    }

    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: 'Second response',
          },
        ],
      },
    });
    service.completeChatTurn('proj', 'wt', 'chat', 'success');

    releaseTranscriptAppend();
    await flushPromise;

    const transcriptFile = Array.from(files.entries()).find(([path]) =>
      path.includes('/mock/observability/transcripts/'),
    );

    if (!transcriptFile) {
      throw new Error('Expected transcript file to be written');
    }

    expect(transcriptFile[1]).toContain('First response');
    expect(transcriptFile[1]).toContain('Second response');
    expect(loadOnlyRecentEntry(service).status).toBe('success');
  });

  it('creates a separate audit and sidecar when steering starts a new root turn', async () => {
    const files = installMockFilesystem();
    const service = new ObservabilityService();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      executionHarness: 'claude',
      userMessageId: 'root-1',
      originalUserText: 'Original task',
      submittedText: 'Original task',
      planMode: false,
      isStandalone: false,
    });
    service.completeChatTurn('proj', 'wt', 'chat', 'success');
    service.observeSteeringInput({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'claude',
      userMessageId: 'steered-1',
      originalUserText: 'Follow up',
      submittedText: 'Follow up with file context',
      planMode: false,
      startsTurn: true,
    });
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'New root response' }] },
    });
    service.completeChatTurn('proj', 'wt', 'chat', 'success');
    const entries = service.loadSnapshot().recentEntries;
    expect(entries).toHaveLength(2);
    expect(
      entries.find((entry) => entry.userMessageId === 'root-1'),
    ).toMatchObject({ status: 'success', assistantMessageCount: 0 });
    expect(
      entries.find((entry) => entry.userMessageId === 'steered-1'),
    ).toMatchObject({
      status: 'success',
      assistantMessageCount: 1,
      model: 'claude-sonnet-4-6',
    });
    await service.dispose();
    const transcripts = Array.from(files.entries())
      .filter(([path]) => path.includes('/mock/observability/transcripts/'))
      .map(([, text]) => text);
    expect(transcripts).toHaveLength(2);
    const steered = transcripts.find((text) =>
      text.includes('Follow up with file context'),
    );
    expect(steered).toContain('New root response');
    expect(steered).not.toContain('Original task');
  });

  it('records an in-turn steering prompt without replacing the running audit', async () => {
    const files = installMockFilesystem();
    const service = new ObservabilityService();
    startClaudeChatTurn(service);
    const originalId = loadOnlyRecentEntry(service).id;
    service.observeSteeringInput({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'claude',
      userMessageId: 'steered-1',
      originalUserText: 'Use the existing test',
      submittedText: 'Use the existing test',
      planMode: false,
      startsTurn: false,
    });
    expect(service.loadSnapshot().recentEntries).toHaveLength(1);
    expect(loadOnlyRecentEntry(service).id).toBe(originalId);
    await service.dispose();
    expect(Array.from(files.values()).join('\n')).toContain(
      'Use the existing test',
    );
    expect(Array.from(files.values()).join('\n')).toContain(
      '"user_message_id":"steered-1"',
    );
    expect(Array.from(files.values()).join('\n')).toContain(
      '"startsTurn":false',
    );
  });

  it('appends a session-ended task notification after the chat transcript retired', async () => {
    const files = installMockFilesystem();
    const service = new ObservabilityService();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'claude',
      originalUserText: 'Run the workflow',
      submittedText: 'Run the workflow',
      planMode: false,
      isStandalone: false,
    });
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Started' }] },
    });
    service.completeChatTurn('proj', 'wt', 'chat', 'success');
    await service.flush();

    const notification = {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'workflow-task',
      status: 'stopped',
      reason: 'session_ended',
      canopy_synthetic: true,
    };
    await service.appendFinalizedChatTranscriptRecord(
      'proj',
      'wt',
      'chat',
      notification,
    );
    await service.flush();

    expect(Array.from(files.values()).join('\n')).toContain(
      JSON.stringify(notification),
    );
    await service.dispose();
  });

  it('drains an unawaited finalized transcript append during dispose', async () => {
    const files = installMockFilesystem();
    const service = new ObservabilityService();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'claude',
      originalUserText: 'Run the workflow',
      submittedText: 'Run the workflow',
      planMode: false,
      isStandalone: false,
    });
    service.completeChatTurn('proj', 'wt', 'chat', 'success');
    await service.flush();

    const notification = {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'late-task',
      status: 'stopped',
      reason: 'session_ended',
      canopy_synthetic: true,
    };
    let resolveLateStat: ((value: { size: number }) => void) | undefined;
    mockedStat.mockImplementationOnce(
      () =>
        new Promise<{ size: number }>((resolve) => {
          resolveLateStat = resolve;
        }),
    );
    const append = service.appendFinalizedChatTranscriptRecord(
      'proj',
      'wt',
      'chat',
      notification,
    );
    const dispose = service.dispose();
    let disposeResolved = false;
    void dispose.then(() => {
      disposeResolved = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(disposeResolved).toBe(false);
    if (!resolveLateStat) {
      throw new Error('Expected finalized transcript append to await stat');
    }
    resolveLateStat({ size: 0 });
    await Promise.all([append, dispose]);

    expect(Array.from(files.values()).join('\n')).toContain(
      JSON.stringify(notification),
    );
  });

  it('reopens a completed chat turn when the agent continues later', async () => {
    const identitySpy = jest
      .spyOn(providerAuthState, 'peekProviderAccountIdentity')
      .mockReturnValue({
        providerAccountKey: 'claude:original-account',
        accountEmail: 'original@example.com',
        planType: 'max',
      });
    const billingKindSpy = jest
      .spyOn(providerAuthState, 'peekProviderBillingAccountKind')
      .mockReturnValue('subscription');
    const service = new ObservabilityService();
    try {
      service.startChatTurn({
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat',
        provider: 'claude',
        originalUserText: 'Run the checks',
        submittedText: 'Run the checks',
        planMode: false,
        isStandalone: false,
      });
      service.observeChatEvent('proj', 'wt', 'chat', {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Initial result' }],
        },
      });
      service.completeChatTurn('proj', 'wt', 'chat', 'success');

      expect(loadOnlyRecentEntry(service)).toMatchObject({
        status: 'success',
        billingBasis: 'subscription',
        providerAccountKey: 'claude:original-account',
        providerAccountEmail: 'original@example.com',
        providerPlanType: 'max',
      });

      billingKindSpy.mockReturnValue('api_key');
      identitySpy.mockReturnValue({
        providerAccountKey: 'claude:current-account',
        accountEmail: 'current@example.com',
        planType: 'team',
      });

      service.observeChatEvent('proj', 'wt', 'chat', {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Continuing after the poller' }],
        },
      });

      const revivedEntry = loadOnlyRecentEntry(service);
      expect(revivedEntry.status).toBe('running');
      expect(revivedEntry.completedAt).toBeUndefined();
      expect(revivedEntry.assistantMessageCount).toBe(2);
      expect(revivedEntry.billingBasis).toBe('subscription');
      expect(revivedEntry.providerAccountKey).toBe('claude:original-account');

      service.completeChatTurn('proj', 'wt', 'chat', 'success');

      const completedEntry = loadOnlyRecentEntry(service);
      expect(completedEntry.status).toBe('success');
      expect(completedEntry.assistantMessageCount).toBe(2);
      expect(completedEntry.billingBasis).toBe('subscription');
      expect(completedEntry.providerAccountKey).toBe('claude:original-account');
      expect(identitySpy).toHaveBeenCalledTimes(1);
      expect(billingKindSpy).toHaveBeenCalledTimes(1);
    } finally {
      await service.dispose();
      identitySpy.mockRestore();
      billingKindSpy.mockRestore();
    }
  });

  it('reopens a completed Codex chat turn when an item arrives later', async () => {
    const identitySpy = jest
      .spyOn(providerAuthState, 'peekProviderAccountIdentity')
      .mockReturnValue({
        providerAccountKey: 'codex:original-account',
        accountEmail: 'original@example.com',
        planType: 'pro',
      });
    const billingKindSpy = jest
      .spyOn(providerAuthState, 'peekProviderBillingAccountKind')
      .mockReturnValue('api_key');
    const service = new ObservabilityService();
    try {
      service.startChatTurn({
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat',
        provider: 'codex',
        originalUserText: 'Run the checks',
        submittedText: 'Run the checks',
        planMode: false,
        isStandalone: false,
      });
      service.observeChatEvent('proj', 'wt', 'chat', {
        type: 'codex',
        event: {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            id: 'initial-result',
            text: 'Initial result',
          },
        },
      });
      service.completeChatTurn('proj', 'wt', 'chat', 'interrupted');

      expect(loadOnlyRecentEntry(service)).toMatchObject({
        status: 'interrupted',
        billingBasis: 'api_key',
        providerAccountKey: 'codex:original-account',
        providerAccountEmail: 'original@example.com',
        providerPlanType: 'pro',
      });

      billingKindSpy.mockReturnValue('subscription');
      identitySpy.mockReturnValue({
        providerAccountKey: 'codex:current-account',
        accountEmail: 'current@example.com',
        planType: 'team',
      });

      service.observeChatEvent('proj', 'wt', 'chat', {
        type: 'codex',
        event: {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            id: 'late-result',
            text: 'Continuing after the app-server notification',
          },
        },
      });

      const revivedEntry = loadOnlyRecentEntry(service);
      expect(revivedEntry.status).toBe('running');
      expect(revivedEntry.completedAt).toBeUndefined();
      expect(revivedEntry.assistantMessageCount).toBe(2);
      expect(revivedEntry.billingBasis).toBe('api_key');
      expect(revivedEntry.providerAccountKey).toBe('codex:original-account');

      service.completeChatTurn('proj', 'wt', 'chat', 'success');

      const completedEntry = loadOnlyRecentEntry(service);
      expect(completedEntry.status).toBe('success');
      expect(completedEntry.assistantMessageCount).toBe(2);
      expect(completedEntry.billingBasis).toBe('api_key');
      expect(completedEntry.providerAccountKey).toBe('codex:original-account');
      expect(identitySpy).toHaveBeenCalledTimes(1);
      expect(billingKindSpy).toHaveBeenCalledTimes(1);
    } finally {
      await service.dispose();
      identitySpy.mockRestore();
      billingKindSpy.mockRestore();
    }
  });

  it('does not apply a finished turn transcript flush to the next turn for the same chat key', async () => {
    const files = new Map<string, string>();
    let transcriptAppendPending = false;
    let releaseTranscriptAppend = (): void => {
      throw new Error('Expected transcript append to be pending');
    };
    let delayFirstTranscriptAppend = true;

    mockedAppendFile.mockImplementation(
      (pathArg: unknown, payloadArg: unknown): Promise<void> => {
        if (typeof pathArg !== 'string') {
          return Promise.reject(new Error('Unexpected append path'));
        }

        const payload =
          typeof payloadArg === 'string' ? payloadArg : String(payloadArg);

        if (
          delayFirstTranscriptAppend &&
          pathArg.includes('/mock/observability/transcripts/')
        ) {
          delayFirstTranscriptAppend = false;
          return new Promise<void>((resolve) => {
            transcriptAppendPending = true;
            releaseTranscriptAppend = (): void => {
              files.set(pathArg, `${files.get(pathArg) ?? ''}${payload}`);
              resolve();
            };
          });
        }

        files.set(pathArg, `${files.get(pathArg) ?? ''}${payload}`);
        return Promise.resolve();
      },
    );

    const service = new ObservabilityService();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'claude',
      originalUserText: 'First prompt',
      submittedText: 'First prompt',
      planMode: false,
      isStandalone: false,
    });
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: 'First response',
          },
        ],
      },
    });

    const flushPromise = service.flush();

    await Promise.resolve();
    await Promise.resolve();

    if (!transcriptAppendPending) {
      throw new Error('Expected transcript append to be pending');
    }

    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'claude',
      originalUserText: 'Second prompt',
      submittedText: 'Second prompt',
      planMode: false,
      isStandalone: false,
    });
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: 'Second response',
          },
        ],
      },
    });

    releaseTranscriptAppend();
    await flushPromise;
    await service.flush();

    const transcriptFiles = Array.from(files.entries()).filter(([path]) =>
      path.includes('/mock/observability/transcripts/'),
    );

    expect(transcriptFiles.length).toBeGreaterThan(0);
    const combinedTranscript = transcriptFiles
      .map(([, contents]) => contents)
      .join('\n');
    expect(combinedTranscript.includes('First prompt')).toBe(true);
    expect(combinedTranscript.includes('First response')).toBe(true);
    expect(combinedTranscript.includes('Second prompt')).toBe(true);
    expect(combinedTranscript.includes('Second response')).toBe(true);

    const latestEntry = loadOnlyRecentEntry(service);
    expect(latestEntry.status).toBe('running');
    expect(latestEntry.hasTranscript).toBe(true);
  });

  it('writes chat transcript sidecars and flips hasTranscript after the first append', async () => {
    installMockFilesystem();

    const service = new ObservabilityService();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'claude',
      originalUserText: 'Inspect the bug',
      submittedText: 'Inspect the bug',
      planMode: false,
      isStandalone: false,
    });
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: 'I found the issue',
          },
        ],
      },
    });

    await service.flush();

    const transcriptCall = mockedAppendFile.mock.calls.find(
      (call) =>
        typeof call[0] === 'string' && call[0].includes('/transcripts/'),
    );
    expect(transcriptCall).toBeDefined();
    expect(String(transcriptCall?.[1])).toContain(
      '"type":"canopy_user_prompt"',
    );
    expect(String(transcriptCall?.[1])).toContain('"type":"assistant"');
    expect(loadOnlyRecentEntry(service).hasTranscript).toBe(true);
  });

  it('stores helper-task transcript sidecars with seeded prompt metadata', async () => {
    installMockFilesystem();

    const service = new ObservabilityService();
    const startedAt = '2026-03-30T12:34:56.000Z';
    const entry = makeAuditEntry('helper-branch-1', startedAt, {
      eventType: 'branch_naming',
      status: 'running',
      completedAt: undefined,
      durationMs: undefined,
      label: 'Branch Naming',
    });

    service.startObservedTask('helper:branch', entry);
    service.seedTranscript('helper:branch', {
      provider: 'claude',
      originalText: 'Add OAuth login support',
      submittedText: 'Add OAuth login support',
      planMode: false,
      injectedPrompts: [
        {
          kind: 'system_prompt_append',
          provider: 'claude',
          applicationCondition: 'helper_task_system_prompt',
          text: 'Generate a concise git branch name.',
        },
      ],
    });
    service.appendTranscriptRecord('helper:branch', {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'oauth-login' }],
      },
    });
    service.finalizeObservedTask('helper:branch', 'success');

    await service.flush();

    const response = await service.loadTranscript({
      id: entry.id,
      eventType: entry.eventType,
      startedAt,
    });

    expect(response.type).toBe('success');
    if (response.type !== 'success') {
      throw new Error('Expected helper transcript response');
    }

    expect(response.lines[0]).toContain('"type":"canopy_user_prompt"');
    expect(response.lines[1]).toContain('"type":"assistant"');
    expect(response.injectedPrompts).toEqual([
      {
        kind: 'system_prompt_append',
        provider: 'claude',
        applicationCondition: 'helper_task_system_prompt',
        text: 'Generate a concise git branch name.',
      },
    ]);
    expect(
      service.loadSnapshot().recentEntries.find((item) => item.id === entry.id)
        ?.hasTranscript,
    ).toBe(true);
  });

  it.each(['claude', 'cursor'] as const)(
    'reloads injected %s organization memory from the sidecar',
    async (provider) => {
      installMockFilesystem();
      const service = new ObservabilityService();
      service.startChatTurn({
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat',
        provider,
        originalUserText: 'Explain the release process',
        submittedText:
          '<org_memory>Use the release checklist.</org_memory>\n\nExplain the release process',
        planMode: false,
        isStandalone: false,
        orgMemoryBlock: '<org_memory>Use the release checklist.</org_memory>',
      });
      service.completeChatTurn('proj', 'wt', 'chat', 'success');
      await service.flush();

      const entry = loadOnlyRecentEntry(service);
      await service.dispose();
      const reloaded = new ObservabilityService();
      const response = await reloaded.loadTranscript({
        id: entry.id,
        eventType: entry.eventType,
        startedAt: entry.startedAt,
      });
      expect(response.type).toBe('success');
      if (response.type !== 'success') {
        throw new Error('Expected chat transcript response');
      }
      expect(response.injectedPrompts).toContainEqual({
        kind: 'org_memory',
        provider,
        applicationCondition: 'org_memory_enabled_for_turn',
        text: '<org_memory>Use the release checklist.</org_memory>',
      });
      await reloaded.dispose();
    },
  );

  it('persists usage metric events and includes pending events in summaries', async () => {
    const service = new ObservabilityService();
    const event: UsageMetricEvent = {
      version: 1,
      id: 'chat-turn-completed:entry-1',
      type: 'chat_turn_completed',
      timestamp: '2026-05-26T12:00:00.000Z',
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-1',
      repoId: '__single_repo__',
      repoLabel: 'repo',
      provider: 'codex',
      initiationSource: 'hook',
      chatId: 'chat-1',
      auditEntryId: 'entry-1',
      turnStartedAt: '2026-05-26T11:59:00.000Z',
      turnCompletedAt: '2026-05-26T12:00:00.000Z',
      turnDurationMs: 60_000,
      toolUseCount: 7,
      status: 'success',
      toolCounts: {
        thinking: 0,
        bash: 2,
        read: 0,
        readLines: 0,
        writeEdit: 1,
        fileEdit: 0,
        fileAdd: 0,
        fileDelete: 0,
        search: 0,
        grep: 0,
        web: 0,
        agent: 0,
        workflow: 0,
        tasks: 0,
        taskStop: 0,
        skills: 0,
        monitor: 0,
        claude: 0,
        scheduleWakeup: 0,
        askUser: 0,
        scriptOutput: 0,
        watcher: 0,
        appAdvisor: 0,
        pipelineEditor: 4,
        mcp: 0,
        other: 0,
      },
    };

    service.recordUsageMetricEvent(event);
    const pendingSummary = await service.loadUsageMetrics({
      startDate: '2026-05-26T00:00:00.000Z',
      endDate: '2026-05-27T00:00:00.000Z',
      provider: 'codex',
      initiationSource: 'hook',
    });

    expect(pendingSummary.chats.toolCallsPerTurn.rows[0]?.stats?.p95).toBe(7);
    expect(pendingSummary.chats.turnCountsByInitiationSource?.rows).toEqual([
      expect.objectContaining({
        initiationSource: 'hook',
        count: 1,
      }),
    ]);
    expect(pendingSummary.chats.turnCountsByProvider?.rows).toEqual([
      expect.objectContaining({
        provider: 'codex',
        count: 1,
      }),
    ]);
    expect(pendingSummary.tools.byCategory).toEqual([
      { category: 'bash', count: 2 },
      { category: 'writeEdit', count: 1 },
      { category: 'pipelineEditor', count: 4 },
    ]);

    await service.flush();

    expect(mockedAppendFile).toHaveBeenCalledWith(
      '/mock/observability/usage-events/2026-05-26.jsonl',
      expect.stringContaining('"type":"chat_turn_completed"'),
    );
    await service.dispose();
  });

  it('preserves chat start metadata for completion events after started events flush', async () => {
    const service = new ObservabilityService();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'codex',
      originalUserText: 'Start work',
      submittedText: 'Start work',
      planMode: false,
      isStandalone: false,
      initiationSource: 'portal',
      workspaceLabel: 'Workspace',
      repoId: 'repo-a',
      repoLabel: 'Repo A',
    });

    await service.flush();
    mockedAppendFile.mockClear();

    service.completeChatTurn('proj', 'wt', 'chat', 'success');
    await service.flush();

    const usageAppend = mockedAppendFile.mock.calls.find(
      ([pathArg, payload]) =>
        String(pathArg).includes('/mock/observability/usage-events/') &&
        String(payload).includes('"type":"chat_turn_completed"'),
    );
    expect(usageAppend).toBeDefined();
    const completedEvent: unknown = JSON.parse(String(usageAppend?.[1]).trim());
    expect(completedEvent).toMatchObject({
      initiationSource: 'portal',
      workspaceLabel: 'Workspace',
      repoId: 'repo-a',
      repoLabel: 'Repo A',
    });

    await service.dispose();
  });

  it('finishes shutdown audit flushing even when the Claude ledger write fails', async () => {
    const service = new ObservabilityService();
    jest
      .spyOn(claudeCostLedger.getClaudeSessionCostLedger(), 'flush')
      .mockRejectedValueOnce(new Error('Ledger write unavailable'));
    const finalAuditFlush = jest
      .spyOn(service, 'flush')
      .mockResolvedValue(undefined);
    await expect(service.dispose()).resolves.toBeUndefined();
    expect(finalAuditFlush).toHaveBeenCalledTimes(1);
  });

  it('preserves Claude session spend across teardown in the parrot regression', () => {
    const service = new ObservabilityService();
    const result = (total: number): void => {
      service.observeChatEvent('proj', 'wt', 'chat', {
        type: 'result',
        session_id: 'parrot-session',
        total_cost_usd: total,
        usage: { input_tokens: 12, output_tokens: 8 },
        modelUsage: {
          'claude-sonnet-4-6': {
            inputTokens: total * 1000,
            outputTokens: total * 100,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: total,
          },
        },
      });
    };
    startClaudeChatTurn(service);
    result(41.99);
    completeClaudeChatTurn(service);
    service.interruptMatchingEntries('chat:proj/wt/chat');
    startClaudeChatTurn(service);
    result(46.75);
    const entry = completeClaudeChatTurn(service);
    expect(entry.totalCostUsd).toBeCloseTo(4.76);
    expect(entry.costDerivation).toBe('exact');
    expect(entry.sdkCumulativeCostUsd).toBe(46.75);
    expect(entry.modelUsage).toHaveLength(1);
    expect(entry.modelUsage?.[0]?.model).toBe('claude-sonnet-4-6');
    expect(entry.modelUsage?.[0]?.costUsd).toBeCloseTo(4.76);
  });

  it('records consecutive Claude chat costs as per-turn deltas', () => {
    jest.useFakeTimers();
    try {
      const service = new ObservabilityService();

      jest.setSystemTime(new Date('2026-05-26T12:00:00.000Z'));
      startClaudeChatTurn(service);
      observeClaudeResult(service, 5);
      const firstEntry = completeClaudeChatTurn(service);

      jest.setSystemTime(new Date('2026-05-26T12:01:00.000Z'));
      startClaudeChatTurn(service);
      observeClaudeResult(service, 8.5);
      const secondEntry = completeClaudeChatTurn(service);

      expect(firstEntry.totalCostUsd).toBeCloseTo(5);
      expect(secondEntry.totalCostUsd).toBeCloseTo(3.5);
    } finally {
      jest.useRealTimers();
    }
  });

  it('starts a new Claude cost epoch on an explicit conversation reset', () => {
    jest.useFakeTimers();
    try {
      const service = new ObservabilityService();

      jest.setSystemTime(new Date('2026-05-26T12:00:00.000Z'));
      startClaudeChatTurn(service);
      observeClaudeResult(service, 5);
      completeClaudeChatTurn(service);

      jest.setSystemTime(new Date('2026-05-26T12:01:00.000Z'));
      startClaudeChatTurn(service);
      observeClaudeResult(service, 8.5);
      completeClaudeChatTurn(service);

      jest.setSystemTime(new Date('2026-05-26T12:02:00.000Z'));
      startClaudeChatTurn(service);
      service.observeChatEvent('proj', 'wt', 'chat', {
        type: 'conversation_reset',
      });
      observeClaudeResult(service, 1.2);
      const resetEntry = completeClaudeChatTurn(service);

      expect(resetEntry.totalCostUsd).toBeCloseTo(1.2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('starts a new Claude cost epoch when the SDK session changes without a cumulative drop', () => {
    jest.useFakeTimers();
    try {
      const service = new ObservabilityService();

      jest.setSystemTime(new Date('2026-05-26T12:00:00.000Z'));
      startClaudeChatTurn(service);
      observeClaudeResult(service, 0.1, { sessionId: 'session-a' });
      const firstEntry = completeClaudeChatTurn(service);

      // The replacement process reports a first cumulative total >= the prior
      // session's, so only the session identity reveals the reset.
      jest.setSystemTime(new Date('2026-05-26T12:01:00.000Z'));
      startClaudeChatTurn(service);
      observeClaudeResult(service, 0.2, { sessionId: 'session-b' });
      const replacementEntry = completeClaudeChatTurn(service);

      expect(firstEntry.totalCostUsd).toBeCloseTo(0.1);
      expect(replacementEntry.totalCostUsd).toBeCloseTo(0.2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('retains completed cost segments when the SDK session changes within one turn', () => {
    jest.useFakeTimers();
    try {
      const service = new ObservabilityService();

      jest.setSystemTime(new Date('2026-05-26T12:00:00.000Z'));
      startClaudeChatTurn(service);
      observeClaudeResult(service, 0.1, { sessionId: 'session-a' });
      service.observeChatEvent('proj', 'wt', 'chat', {
        type: 'conversation_reset',
      });
      observeClaudeResult(service, 0.15, { sessionId: 'session-b' });
      const entry = completeClaudeChatTurn(service);

      expect(entry.totalCostUsd).toBeCloseTo(0.25);
    } finally {
      jest.useRealTimers();
    }
  });

  it('recomputes repeated Claude results from one entry baseline', () => {
    jest.useFakeTimers();
    try {
      const service = new ObservabilityService();

      jest.setSystemTime(new Date('2026-05-26T12:00:00.000Z'));
      startClaudeChatTurn(service);
      observeClaudeResult(service, 5);
      completeClaudeChatTurn(service);

      jest.setSystemTime(new Date('2026-05-26T12:01:00.000Z'));
      startClaudeChatTurn(service);
      observeClaudeResult(service, 5);
      observeClaudeResult(service, 5.75);
      const repeatedResultEntry = completeClaudeChatTurn(service);

      expect(repeatedResultEntry.totalCostUsd).toBeCloseTo(0.75);
    } finally {
      jest.useRealTimers();
    }
  });

  it('retains completed cost segments when Claude resets within one turn', () => {
    jest.useFakeTimers();
    try {
      const service = new ObservabilityService();

      jest.setSystemTime(new Date('2026-05-26T12:00:00.000Z'));
      startClaudeChatTurn(service);
      observeClaudeResult(service, 5);
      completeClaudeChatTurn(service);

      jest.setSystemTime(new Date('2026-05-26T12:01:00.000Z'));
      startClaudeChatTurn(service);
      observeClaudeResult(service, 5.75);
      service.observeChatEvent('proj', 'wt', 'chat', {
        type: 'conversation_reset',
      });
      observeClaudeResult(service, 0.4);
      const resetEntry = completeClaudeChatTurn(service);

      expect(resetEntry.totalCostUsd).toBeCloseTo(1.15);
    } finally {
      jest.useRealTimers();
    }
  });

  it('preserves a Claude entry baseline when a completed turn is revived', () => {
    jest.useFakeTimers();
    try {
      const service = new ObservabilityService();

      jest.setSystemTime(new Date('2026-05-26T12:00:00.000Z'));
      startClaudeChatTurn(service);
      observeClaudeResult(service, 5);
      completeClaudeChatTurn(service);

      jest.setSystemTime(new Date('2026-05-26T12:01:00.000Z'));
      startClaudeChatTurn(service);
      observeClaudeResult(service, 5.75);
      const completedEntry = completeClaudeChatTurn(service);

      service.observeChatEvent('proj', 'wt', 'chat', {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Continuing the same turn' }],
        },
      });
      const revivedEntry = loadRecentEntryForChat(service, 'chat');
      expect(revivedEntry.id).toBe(completedEntry.id);

      observeClaudeResult(service, 6.25);
      const amendedEntry = completeClaudeChatTurn(service);

      expect(amendedEntry.id).toBe(completedEntry.id);
      expect(amendedEntry.totalCostUsd).toBeCloseTo(1.25);
    } finally {
      jest.useRealTimers();
    }
  });

  it('records zero Claude cost and zero tokens for an unchanged cumulative wakeup', () => {
    jest.useFakeTimers();
    try {
      const service = new ObservabilityService();

      jest.setSystemTime(new Date('2026-05-26T12:00:00.000Z'));
      startClaudeChatTurn(service);
      observeClaudeResult(service, 5, {
        inputTokens: 8,
        outputTokens: 5,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 1,
      });
      completeClaudeChatTurn(service);

      jest.setSystemTime(new Date('2026-05-26T12:01:00.000Z'));
      startClaudeChatTurn(service);
      observeClaudeResult(service, 5, {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      });
      const wakeupEntry = completeClaudeChatTurn(service);

      expect(wakeupEntry.totalCostUsd).toBeCloseTo(0);
      expect(wakeupEntry.tokens).toMatchObject({
        input: 0,
        output: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('isolates cumulative Claude cost tracking by chat identity', () => {
    const service = new ObservabilityService();

    startClaudeChatTurn(service, 'chat-a');
    observeClaudeResult(service, 4, { chatId: 'chat-a' });
    completeClaudeChatTurn(service, 'chat-a');

    startClaudeChatTurn(service, 'chat-b');
    observeClaudeResult(service, 9, { chatId: 'chat-b' });
    completeClaudeChatTurn(service, 'chat-b');

    expect(loadRecentEntryForChat(service, 'chat-a').totalCostUsd).toBeCloseTo(
      4,
    );
    expect(loadRecentEntryForChat(service, 'chat-b').totalCostUsd).toBeCloseTo(
      9,
    );
  });

  it('retains Claude session cost baselines on explicit session interruption', () => {
    jest.useFakeTimers();
    try {
      const service = new ObservabilityService();

      jest.setSystemTime(new Date('2026-05-26T12:00:00.000Z'));
      startClaudeChatTurn(service);
      observeClaudeResult(service, 5);
      completeClaudeChatTurn(service);
      service.interruptMatchingEntries('chat:proj/wt/chat');

      jest.setSystemTime(new Date('2026-05-26T12:01:00.000Z'));
      startClaudeChatTurn(service);
      observeClaudeResult(service, 8.5);
      const restartedEntry = completeClaudeChatTurn(service);

      expect(restartedEntry.totalCostUsd).toBeCloseTo(3.5);
    } finally {
      jest.useRealTimers();
    }
  });

  it('preserves accrued Claude cost when an interrupted entry is revived after tracker cleanup', () => {
    jest.useFakeTimers();
    try {
      const service = new ObservabilityService();

      jest.setSystemTime(new Date('2026-05-26T12:00:00.000Z'));
      startClaudeChatTurn(service);
      observeClaudeResult(service, 5);
      completeClaudeChatTurn(service);

      jest.setSystemTime(new Date('2026-05-26T12:01:00.000Z'));
      startClaudeChatTurn(service);
      observeClaudeResult(service, 5.75);
      service.interruptMatchingEntries('chat:proj/wt/chat');
      const interruptedEntry = loadRecentEntryForChat(service, 'chat');
      expect(interruptedEntry.totalCostUsd).toBeCloseTo(0.75);

      service.observeChatEvent('proj', 'wt', 'chat', {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Continuing after restart' }],
        },
      });
      service.observeChatEvent('proj', 'wt', 'chat', {
        type: 'conversation_reset',
      });
      observeClaudeResult(service, 0.4);
      const amendedEntry = completeClaudeChatTurn(service);

      expect(amendedEntry.id).toBe(interruptedEntry.id);
      expect(amendedEntry.totalCostUsd).toBeCloseTo(1.15);
    } finally {
      jest.useRealTimers();
    }
  });

  it('retains Claude session cost baselines while another provider is used', () => {
    jest.useFakeTimers();
    try {
      const service = new ObservabilityService();

      jest.setSystemTime(new Date('2026-05-26T12:00:00.000Z'));
      startClaudeChatTurn(service);
      observeClaudeResult(service, 5);
      completeClaudeChatTurn(service);

      jest.setSystemTime(new Date('2026-05-26T12:01:00.000Z'));
      service.startChatTurn({
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat',
        provider: 'ollama',
        originalUserText: 'Use the local provider',
        submittedText: 'Use the local provider',
        planMode: false,
        isStandalone: false,
      });
      service.observeChatEvent('proj', 'wt', 'chat', {
        type: 'result',
        usage: {
          input_tokens: 1,
          output_tokens: 1,
        },
        total_cost_usd: 0.25,
      });
      const ollamaEntry = completeClaudeChatTurn(service);
      expect(ollamaEntry.totalCostUsd).toBeCloseTo(0.25);

      jest.setSystemTime(new Date('2026-05-26T12:02:00.000Z'));
      startClaudeChatTurn(service);
      observeClaudeResult(service, 8.5);
      const restartedClaudeEntry = completeClaudeChatTurn(service);

      expect(restartedClaudeEntry.totalCostUsd).toBeCloseTo(3.5);
    } finally {
      jest.useRealTimers();
    }
  });

  it('retains Claude session cost baselines when worktree observability data is purged', async () => {
    jest.useFakeTimers();
    try {
      installMockFilesystem();
      const service = new ObservabilityService();

      jest.setSystemTime(new Date('2026-05-26T12:00:00.000Z'));
      startClaudeChatTurn(service);
      observeClaudeResult(service, 5);
      completeClaudeChatTurn(service);

      await service.purgeWorktreeData('proj', 'wt');

      jest.setSystemTime(new Date('2026-05-26T12:01:00.000Z'));
      startClaudeChatTurn(service);
      observeClaudeResult(service, 8.5);
      const recreatedEntry = completeClaudeChatTurn(service);

      expect(recreatedEntry.totalCostUsd).toBeCloseTo(3.5);
    } finally {
      jest.useRealTimers();
    }
  });

  it('records observed cost on completed chat turn usage events', async () => {
    installMockFilesystem();

    const service = new ObservabilityService();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'claude',
      originalUserText: 'Inspect cost',
      submittedText: 'Inspect cost',
      planMode: false,
      isStandalone: false,
    });
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'result',
      usage: {
        input_tokens: 8,
        output_tokens: 5,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 1,
      },
      total_cost_usd: 1.2345,
    });
    service.completeChatTurn('proj', 'wt', 'chat', 'success');
    await service.flush();

    const completedEvents = mockedAppendFile.mock.calls
      .filter(([pathArg]) =>
        String(pathArg).includes('/mock/observability/usage-events/'),
      )
      .flatMap(([, payload]) =>
        String(payload)
          .trim()
          .split('\n')
          .filter((line) => line.length > 0)
          .map((line): unknown => JSON.parse(line)),
      )
      .filter(
        (event): event is { type: 'chat_turn_completed' } =>
          typeof event === 'object' &&
          event !== null &&
          'type' in event &&
          event.type === 'chat_turn_completed',
      );

    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0]).toMatchObject({
      totalCostUsd: 1.2345,
      tokens: {
        input: 8,
        output: 5,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 1,
      },
    });

    await service.dispose();
  });

  it('keeps tokens but drops every dollar field for organization gateway turns', async () => {
    installMockFilesystem();

    const service = new ObservabilityService();
    const startedAt = '2026-05-26T11:59:00.000Z';
    service.startObservedTask(
      'chat:proj/wt/chat',
      makeAuditEntry('org-gateway-chat-entry', startedAt, {
        eventType: 'worktree_chat',
        status: 'running',
        provider: 'claude',
        label: 'Chat',
        modelGatewayRouted: true,
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat',
        completedAt: undefined,
        durationMs: undefined,
      }),
    );
    service.finalizeObservedTask('chat:proj/wt/chat', 'success', undefined, {
      inputTokens: 8,
      outputTokens: 5,
      totalCostUsd: 1.2345,
    });
    await service.flush();

    expect(loadOnlyRecentEntry(service)).toMatchObject({
      tokens: { input: 8, output: 5 },
      modelGatewayRouted: true,
    });
    expect(loadOnlyRecentEntry(service).totalCostUsd).toBeUndefined();
    expect(loadOnlyRecentEntry(service).observedCost).toBeUndefined();
    const completedEvent = mockedAppendFile.mock.calls
      .filter(([pathArg]) =>
        String(pathArg).includes('/mock/observability/usage-events/'),
      )
      .flatMap(([, payload]) =>
        String(payload)
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line): unknown => JSON.parse(line)),
      )
      .find(
        (event) =>
          typeof event === 'object' &&
          event !== null &&
          'type' in event &&
          event.type === 'chat_turn_completed',
      );
    expect(completedEvent).toMatchObject({
      tokens: { input: 8, output: 5 },
    });
    expect(completedEvent).not.toHaveProperty('totalCostUsd');
    expect(completedEvent).not.toHaveProperty('observedCost');

    await service.dispose();
  });

  it('does not publish desktop AI Credits estimates as Gateway actual savings', () => {
    const service = new ObservabilityService();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'auto-ai-credits',
      provider: 'claude',
      originalUserText: 'Route this turn',
      submittedText: 'Route this turn',
      planMode: false,
      isStandalone: false,
      model: 'claude-sonnet-4-6',
      aiCreditsRouted: true,
      modelRouting: {
        schemaVersion: 1,
        selectionMode: 'auto',
        outcome: 'selected',
        executionLane: 'ai_credits',
        benchmarkModelId: 'opus[1m]',
        selectedModelId: 'claude-sonnet-4-6',
        routingCostUsd: 0.001,
      },
    });

    service.finalizeObservedTask(
      'chat:proj/wt/auto-ai-credits',
      'success',
      undefined,
      {
        inputTokens: 10,
        outputTokens: 5,
        totalCostUsd: 0.005,
      },
    );
    const completed = loadRecentEntryForChat(service, 'auto-ai-credits');

    expect(completed.modelRouting?.savings).toEqual({
      status: 'incomparable_basis',
    });
  });

  it('prices a switch-induced cache miss as cache reads for the Auto benchmark', () => {
    const service = new ObservabilityService();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'auto-switch',
      provider: 'claude',
      originalUserText: 'Add docs',
      submittedText: 'Add docs',
      planMode: false,
      isStandalone: false,
      model: 'sonnet',
      modelRouting: {
        schemaVersion: 1,
        selectionMode: 'auto',
        outcome: 'selected',
        executionLane: 'provider_subscription',
        benchmarkModelId: 'opus[1m]',
        selectedModelId: 'sonnet',
        routingCostUsd: 0,
        cacheMissContextTokens: 100_000,
      },
    });

    service.finalizeObservedTask(
      'chat:proj/wt/auto-switch',
      'success',
      undefined,
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 100_000,
        totalCostUsd: 0.25,
      },
    );
    const completed = loadRecentEntryForChat(service, 'auto-switch');

    // Staying on Opus 5.5 reads the 100k context from cache ($0.02) instead of
    // re-writing it ($0.50).
    expect(completed.modelRouting?.savings).toMatchObject({
      status: 'computed',
      benchmarkEstimatedExecutionCostUsd: 0.02,
    });
  });

  it('hydrates observed cost for retained usage events from matching audit entries', async () => {
    await withSystemTime('2026-06-01T12:00:00.000Z', async () => {
      mockedReadPreferencesFile.mockResolvedValue(makePreferences(365));
      const files = installMockFilesystem();
      files.set(
        '/mock/observability/usage-events/2026-05-26.jsonl',
        `${JSON.stringify({
          version: 1,
          id: 'chat-turn-completed:entry-cost',
          type: 'chat_turn_completed',
          timestamp: '2026-05-26T12:00:00.000Z',
          workspaceId: 'workspace-1',
          worktreeId: 'worktree-1',
          provider: 'claude',
          initiationSource: 'user',
          chatId: 'chat-1',
          auditEntryId: 'entry-cost',
          turnStartedAt: '2026-05-26T11:59:00.000Z',
          turnCompletedAt: '2026-05-26T12:00:00.000Z',
          status: 'success',
        })}\n`,
      );
      files.set(
        '/mock/observability/2026-05-26.jsonl',
        serializeAuditEntries([
          makeAuditEntry('entry-cost', '2026-05-26T12:00:00.000Z', {
            totalCostUsd: 2.5,
          }),
        ]),
      );

      const service = new ObservabilityService();
      const response = await service.loadUsageTimeseries({
        startDate: '2026-05-26T00:00:00.000Z',
        endDate: '2026-05-27T00:00:00.000Z',
        bucket: 'day',
        dataset: {
          kind: 'tab-counts',
          tab: 'cost',
          series: ['cost_total_usd', 'cost_provider_claude_usd'],
        },
      });

      expect(response.kind).toBe('tab-counts');
      if (response.kind !== 'tab-counts') return;
      const eventBucket = response.buckets.find(
        (bucket) =>
          bucket.bucketStart ===
          localBucketStartIso('2026-05-26T12:00:00.000Z', 'day'),
      );
      expect(eventBucket?.series.cost_total_usd ?? 0).toBeCloseTo(2.5);
      expect(eventBucket?.series.cost_provider_claude_usd ?? 0).toBeCloseTo(
        2.5,
      );

      await service.dispose();
    });
  });

  it('loads observed cost directly from retained usage events', async () => {
    const files = installMockFilesystem();
    files.set(
      '/mock/observability/usage-events/2026-05-26.jsonl',
      `${JSON.stringify({
        version: 1,
        id: 'chat-turn-completed:observed-cost',
        type: 'chat_turn_completed',
        timestamp: '2026-05-26T12:00:00.000Z',
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-1',
        provider: 'codex',
        initiationSource: 'user',
        chatId: 'chat-1',
        auditEntryId: 'entry-observed-cost',
        model: 'gpt-5',
        turnStartedAt: '2026-05-26T11:59:00.000Z',
        turnCompletedAt: '2026-05-26T12:00:00.000Z',
        status: 'success',
        observedCost: {
          status: 'priced',
          reason: 'priced',
          currency: 'usd',
          totalUsd: 1.75,
          tokenUsd: 1.5,
          nonTokenUsd: 0.25,
          components: [
            {
              kind: 'tokens',
              label: 'gpt-5 tokens',
              quantity: 1000,
              unit: 'tokens',
              usd: 1.5,
              reason: 'priced',
            },
            {
              kind: 'web_search_call',
              label: 'OpenAI web search',
              quantity: 25,
              unit: 'calls',
              usd: 0.25,
              reason: 'priced',
            },
          ],
        },
      })}\n`,
    );

    const service = new ObservabilityService();
    const response = await service.loadUsageTimeseries({
      startDate: '2026-05-26T00:00:00.000Z',
      endDate: '2026-05-27T00:00:00.000Z',
      bucket: 'day',
      dataset: {
        kind: 'tab-counts',
        tab: 'cost',
        series: ['cost_total_usd', 'cost_provider_codex_usd'],
      },
    });

    expect(response.kind).toBe('tab-counts');
    if (response.kind !== 'tab-counts') return;
    const eventBucket = response.buckets.find(
      (bucket) =>
        bucket.bucketStart ===
        localBucketStartIso('2026-05-26T12:00:00.000Z', 'day'),
    );
    expect(eventBucket?.series.cost_total_usd ?? 0).toBeCloseTo(1.75);
    expect(eventBucket?.series.cost_provider_codex_usd ?? 0).toBeCloseTo(1.75);
    expect(mockedReadFile).not.toHaveBeenCalledWith(
      '/mock/observability/2026-05-26.jsonl',
      expect.anything(),
    );

    await service.dispose();
  });

  it('does not re-read cost-less audit entries after cost hydration lookup', async () => {
    await withSystemTime('2026-06-01T12:00:00.000Z', async () => {
      mockedReadPreferencesFile.mockResolvedValue(makePreferences(365));
      const files = installMockFilesystem();
      files.set(
        '/mock/observability/usage-events/2026-05-26.jsonl',
        `${JSON.stringify({
          version: 1,
          id: 'chat-turn-completed:no-cost',
          type: 'chat_turn_completed',
          timestamp: '2026-05-26T12:00:00.000Z',
          workspaceId: 'workspace-1',
          worktreeId: 'worktree-1',
          provider: 'claude',
          initiationSource: 'user',
          chatId: 'chat-1',
          auditEntryId: 'entry-no-cost',
          turnStartedAt: '2026-05-26T11:59:00.000Z',
          turnCompletedAt: '2026-05-26T12:00:00.000Z',
          status: 'success',
        })}\n`,
      );
      files.set(
        '/mock/observability/2026-05-26.jsonl',
        serializeAuditEntries([
          makeAuditEntry('entry-no-cost', '2026-05-26T12:00:00.000Z'),
        ]),
      );

      const service = new ObservabilityService();
      const request: UsageTimeseriesRequest = {
        startDate: '2026-05-26T00:00:00.000Z',
        endDate: '2026-05-27T00:00:00.000Z',
        bucket: 'day',
        dataset: {
          kind: 'tab-counts',
          tab: 'cost',
          series: ['cost_total_usd'],
        },
      };

      await service.loadUsageTimeseries(request);
      await service.loadUsageTimeseries(request);

      const auditEntryReads = mockedReadFile.mock.calls.filter(
        ([pathArg]) => pathArg === '/mock/observability/2026-05-26.jsonl',
      );
      expect(auditEntryReads).toHaveLength(1);

      await service.dispose();
    });
  });

  it('hydrates token tab count timeseries from matching audit entries', async () => {
    await withSystemTime('2026-06-01T12:00:00.000Z', async () => {
      mockedReadPreferencesFile.mockResolvedValue(makePreferences(365));
      const files = installMockFilesystem();
      files.set(
        '/mock/observability/usage-events/2026-05-26.jsonl',
        `${JSON.stringify({
          version: 1,
          id: 'chat-turn-completed:entry-tokens',
          type: 'chat_turn_completed',
          timestamp: '2026-05-26T12:00:00.000Z',
          workspaceId: 'workspace-1',
          worktreeId: 'worktree-1',
          provider: 'claude',
          initiationSource: 'user',
          chatId: 'chat-1',
          auditEntryId: 'entry-tokens',
          turnStartedAt: '2026-05-26T11:59:00.000Z',
          turnCompletedAt: '2026-05-26T12:00:00.000Z',
          status: 'success',
        })}\n`,
      );
      files.set(
        '/mock/observability/2026-05-26.jsonl',
        serializeAuditEntries([
          makeAuditEntry('entry-tokens', '2026-05-26T12:00:00.000Z', {
            tokens: {
              input: 11,
              output: 7,
              cacheReadInputTokens: 3,
              cacheCreationInputTokens: 2,
            },
          }),
        ]),
      );

      const service = new ObservabilityService();
      const response = await service.loadUsageTimeseries({
        startDate: '2026-05-26T00:00:00.000Z',
        endDate: '2026-05-27T00:00:00.000Z',
        bucket: 'day',
        dataset: {
          kind: 'tab-counts',
          tab: 'tokens',
          series: ['token_total', 'token_input', 'token_output'],
        },
      });

      expect(response.kind).toBe('tab-counts');
      if (response.kind !== 'tab-counts') return;
      const eventBucket = response.buckets.find(
        (bucket) =>
          bucket.bucketStart ===
          localBucketStartIso('2026-05-26T12:00:00.000Z', 'day'),
      );
      expect(eventBucket?.series.token_total ?? 0).toBe(23);
      expect(eventBucket?.series.token_input ?? 0).toBe(11);
      expect(eventBucket?.series.token_output ?? 0).toBe(7);

      await service.dispose();
    });
  });

  it('dedupes cost usage events by id in tab-count timeseries', async () => {
    const files = installMockFilesystem();
    const baseEvent = {
      version: 1,
      id: 'chat-turn-completed:duplicate-cost',
      type: 'chat_turn_completed',
      timestamp: '2026-05-26T12:00:00.000Z',
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-1',
      provider: 'claude',
      initiationSource: 'user',
      chatId: 'chat-1',
      auditEntryId: 'duplicate-cost',
      turnStartedAt: '2026-05-26T11:59:00.000Z',
      turnCompletedAt: '2026-05-26T12:00:00.000Z',
      status: 'success',
    };
    files.set(
      '/mock/observability/usage-events/2026-05-26.jsonl',
      [
        JSON.stringify({ ...baseEvent, totalCostUsd: 1 }),
        JSON.stringify({ ...baseEvent, totalCostUsd: 3 }),
      ].join('\n') + '\n',
    );

    const service = new ObservabilityService();
    const response = await service.loadUsageTimeseries({
      startDate: '2026-05-26T00:00:00.000Z',
      endDate: '2026-05-27T00:00:00.000Z',
      bucket: 'day',
      dataset: {
        kind: 'tab-counts',
        tab: 'cost',
        series: ['cost_total_usd'],
      },
    });

    expect(response.kind).toBe('tab-counts');
    if (response.kind !== 'tab-counts') return;
    const eventBucket = response.buckets.find(
      (bucket) =>
        bucket.bucketStart ===
        localBucketStartIso('2026-05-26T12:00:00.000Z', 'day'),
    );
    expect(eventBucket?.series.cost_total_usd ?? 0).toBeCloseTo(3);

    await service.dispose();
  });

  it('loads usage metrics from retained files while ignoring corrupt lines', async () => {
    mockedReaddir.mockImplementation((pathArg: unknown): Promise<string[]> => {
      if (pathArg === '/mock/observability/usage-events') {
        return Promise.resolve(['2026-05-26.jsonl', '2026-05-26-extra.jsonl']);
      }
      return Promise.resolve([]);
    });
    mockedReadFile.mockImplementation((pathArg: unknown): Promise<string> => {
      if (pathArg === '/mock/observability/usage-events/2026-05-26.jsonl') {
        return Promise.resolve(
          [
            '{not-json',
            JSON.stringify({
              version: 1,
              id: 'worktree-created:workspace-1/worktree-1:1',
              type: 'worktree_created',
              timestamp: '2026-05-26T12:00:00.000Z',
              workspaceId: 'workspace-1',
              worktreeId: 'worktree-1',
              worktreeCreatedAt: '2026-05-26T12:00:00.000Z',
              repos: [
                {
                  workspaceId: 'workspace-1',
                  worktreeId: 'worktree-1',
                  repoId: '__single_repo__',
                  repoLabel: 'repo',
                },
              ],
            }),
          ].join('\n'),
        );
      }
      return Promise.reject(new Error('ENOENT'));
    });

    const service = new ObservabilityService();
    const summary = await service.loadUsageMetrics({
      startDate: '2026-05-26T00:00:00.000Z',
      endDate: '2026-05-27T00:00:00.000Z',
      repoId: '__single_repo__',
    });

    expect(summary.worktrees.created.total).toBe(1);
    expect(summary.worktrees.created.rows[0]?.repoId).toBe('__single_repo__');
    expect(mockedReadFile).not.toHaveBeenCalledWith(
      '/mock/observability/usage-events/2026-05-26-extra.jsonl',
      'utf8',
    );
  });

  it('scopes multi-repo rows to the requested repo and buckets deletion changes per repo', async () => {
    mockedReaddir.mockImplementation((pathArg: unknown): Promise<string[]> => {
      if (pathArg === '/mock/observability/usage-events') {
        return Promise.resolve(['2026-05-26.jsonl']);
      }
      return Promise.resolve([]);
    });
    mockedReadFile.mockImplementation((pathArg: unknown): Promise<string> => {
      if (pathArg !== '/mock/observability/usage-events/2026-05-26.jsonl') {
        return Promise.reject(new Error('ENOENT'));
      }
      return Promise.resolve(
        [
          JSON.stringify({
            version: 1,
            id: 'worktree-created:workspace-1/worktree-1',
            type: 'worktree_created',
            timestamp: '2026-05-26T12:00:00.000Z',
            workspaceId: 'workspace-1',
            worktreeId: 'worktree-1',
            worktreeCreatedAt: '2026-05-26T12:00:00.000Z',
            repos: [
              {
                workspaceId: 'workspace-1',
                worktreeId: 'worktree-1',
                repoId: 'repo-a',
                repoLabel: 'Repo A',
              },
              {
                workspaceId: 'workspace-1',
                worktreeId: 'worktree-1',
                repoId: 'repo-b',
                repoLabel: 'Repo B',
              },
            ],
          }),
          JSON.stringify({
            version: 1,
            id: 'worktree-deleted:workspace-1/worktree-1',
            type: 'worktree_deleted',
            timestamp: '2026-05-26T13:00:00.000Z',
            workspaceId: 'workspace-1',
            worktreeId: 'worktree-1',
            deletedWithChanges: true,
            worktreeAgeMs: 3_600_000,
            repos: [
              {
                workspaceId: 'workspace-1',
                worktreeId: 'worktree-1',
                repoId: 'repo-a',
                repoLabel: 'Repo A',
                hadChanges: true,
                insertions: 10,
                deletions: 0,
              },
              {
                workspaceId: 'workspace-1',
                worktreeId: 'worktree-1',
                repoId: 'repo-b',
                repoLabel: 'Repo B',
                hadChanges: false,
                insertions: 0,
                deletions: 0,
              },
            ],
          }),
        ].join('\n'),
      );
    });

    const service = new ObservabilityService();
    const allReposSummary = await service.loadUsageMetrics({
      startDate: '2026-05-26T00:00:00.000Z',
      endDate: '2026-05-27T00:00:00.000Z',
    });

    expect(
      allReposSummary.worktrees.deletedWithChanges.rows.map(
        (row) => row.repoId,
      ),
    ).toEqual(['repo-a']);
    expect(
      allReposSummary.worktrees.deletedWithoutChanges.rows.map(
        (row) => row.repoId,
      ),
    ).toEqual(['repo-b']);

    const repoScopedSummary = await service.loadUsageMetrics({
      startDate: '2026-05-26T00:00:00.000Z',
      endDate: '2026-05-27T00:00:00.000Z',
      repoId: 'repo-a',
    });

    expect(repoScopedSummary.worktrees.created.rows).toEqual([
      expect.objectContaining({ repoId: 'repo-a' }),
    ]);
  });

  it('returns aggregate usage stats across every grouped row', async () => {
    mockedReaddir.mockImplementation((pathArg: unknown): Promise<string[]> => {
      if (pathArg === '/mock/observability/usage-events') {
        return Promise.resolve(['2026-05-26.jsonl']);
      }
      return Promise.resolve([]);
    });
    mockedReadFile.mockImplementation((pathArg: unknown): Promise<string> => {
      if (pathArg !== '/mock/observability/usage-events/2026-05-26.jsonl') {
        return Promise.reject(new Error('ENOENT'));
      }
      return Promise.resolve(
        [
          JSON.stringify({
            version: 1,
            id: 'chat-turn-completed:entry-1',
            type: 'chat_turn_completed',
            timestamp: '2026-05-26T12:00:00.000Z',
            workspaceId: 'workspace-1',
            worktreeId: 'worktree-1',
            repoId: 'repo-a',
            repoLabel: 'Repo A',
            provider: 'codex',
            initiationSource: 'user',
            chatId: 'chat-1',
            auditEntryId: 'entry-1',
            turnStartedAt: '2026-05-26T11:59:59.000Z',
            turnCompletedAt: '2026-05-26T12:00:00.000Z',
            turnDurationMs: 1_000,
            toolUseCount: 1,
            status: 'success',
          }),
          JSON.stringify({
            version: 1,
            id: 'chat-turn-completed:entry-2',
            type: 'chat_turn_completed',
            timestamp: '2026-05-26T12:10:00.000Z',
            workspaceId: 'workspace-1',
            worktreeId: 'worktree-2',
            repoId: 'repo-b',
            repoLabel: 'Repo B',
            provider: 'codex',
            initiationSource: 'user',
            chatId: 'chat-2',
            auditEntryId: 'entry-2',
            turnStartedAt: '2026-05-26T12:09:51.000Z',
            turnCompletedAt: '2026-05-26T12:10:00.000Z',
            turnDurationMs: 9_000,
            toolUseCount: 9,
            status: 'success',
          }),
        ].join('\n'),
      );
    });

    const service = new ObservabilityService();
    const summary = await service.loadUsageMetrics({
      startDate: '2026-05-26T00:00:00.000Z',
      endDate: '2026-05-27T00:00:00.000Z',
    });

    expect(summary.chats.turnDurationMs.rows).toHaveLength(2);
    expect(summary.chats.turnDurationMs.stats).toMatchObject({
      avg: 5_000,
      p95: 9_000,
    });
    expect(summary.chats.toolCallsPerTurn.stats).toMatchObject({
      avg: 5,
      p95: 9,
    });
  });

  it('skips legacy token hydration for non-token tab summaries', async () => {
    mockedReaddir.mockImplementation((pathArg: unknown): Promise<string[]> => {
      if (pathArg === '/mock/observability/usage-events') {
        return Promise.resolve(['2026-05-26.jsonl']);
      }
      if (pathArg === '/mock/observability') {
        return Promise.resolve(['2026-05-26.jsonl']);
      }
      return Promise.resolve([]);
    });
    mockedReadFile.mockImplementation((pathArg: unknown): Promise<string> => {
      if (pathArg !== '/mock/observability/usage-events/2026-05-26.jsonl') {
        return Promise.reject(new Error('ENOENT'));
      }
      return Promise.resolve(
        JSON.stringify({
          version: 1,
          id: 'chat-turn-completed:entry-1',
          type: 'chat_turn_completed',
          timestamp: '2026-05-26T12:00:00.000Z',
          workspaceId: 'workspace-1',
          worktreeId: 'worktree-1',
          provider: 'codex',
          initiationSource: 'user',
          chatId: 'chat-1',
          auditEntryId: 'entry-1',
          turnStartedAt: '2026-05-26T11:59:59.000Z',
          turnCompletedAt: '2026-05-26T12:00:00.000Z',
          status: 'success',
        }),
      );
    });

    const service = new ObservabilityService();
    await service.loadUsageTabSummary({ tab: 'pipelines' });

    expect(mockedReaddir).not.toHaveBeenCalledWith('/mock/observability');
    expect(mockedReadFile).not.toHaveBeenCalledWith(
      '/mock/observability/2026-05-26.jsonl',
      'utf8',
    );
  });

  it('caches legacy token hydration across token summary loads', async () => {
    await withSystemTime('2026-06-01T12:00:00.000Z', async () => {
      mockedReadPreferencesFile.mockResolvedValue(makePreferences(365));
      mockedReaddir.mockImplementation(
        (pathArg: unknown): Promise<string[]> => {
          if (pathArg === '/mock/observability/usage-events') {
            return Promise.resolve(['2026-05-26.jsonl']);
          }
          if (pathArg === '/mock/observability') {
            return Promise.resolve(['2026-05-26.jsonl']);
          }
          return Promise.resolve([]);
        },
      );
      mockedReadFile.mockImplementation((pathArg: unknown): Promise<string> => {
        if (pathArg === '/mock/observability/usage-events/2026-05-26.jsonl') {
          return Promise.resolve(
            JSON.stringify({
              version: 1,
              id: 'chat-turn-completed:entry-1',
              type: 'chat_turn_completed',
              timestamp: '2026-05-26T12:00:00.000Z',
              workspaceId: 'workspace-1',
              worktreeId: 'worktree-1',
              provider: 'codex',
              initiationSource: 'user',
              chatId: 'chat-1',
              auditEntryId: 'entry-1',
              turnStartedAt: '2026-05-26T11:59:59.000Z',
              turnCompletedAt: '2026-05-26T12:00:00.000Z',
              status: 'success',
            }),
          );
        }
        if (pathArg === '/mock/observability/2026-05-26.jsonl') {
          return Promise.resolve(
            JSON.stringify(
              makeAuditEntry('entry-1', '2026-05-26T12:00:00.000Z', {
                tokens: {
                  input: 100,
                  output: 50,
                  cacheReadInputTokens: 25,
                  cacheCreationInputTokens: 0,
                },
              }),
            ),
          );
        }
        return Promise.reject(new Error('ENOENT'));
      });

      const service = new ObservabilityService();
      const firstSummary = await service.loadUsageTabSummary({ tab: 'tokens' });
      const secondSummary = await service.loadUsageTabSummary({
        tab: 'tokens',
      });

      expect(
        firstSummary.cards.find((card) => card.key === 'total_tokens')?.allTime,
      ).toBe(175);
      expect(
        secondSummary.cards.find((card) => card.key === 'total_tokens')
          ?.allTime,
      ).toBe(175);
      expect(
        mockedReadFile.mock.calls.filter(
          ([pathArg]) => pathArg === '/mock/observability/2026-05-26.jsonl',
        ),
      ).toHaveLength(1);
    });
  });

  it('keeps chat and tool breakdown rows separated by repo provider and source', async () => {
    mockedReaddir.mockImplementation((pathArg: unknown): Promise<string[]> => {
      if (pathArg === '/mock/observability/usage-events') {
        return Promise.resolve(['2026-05-26.jsonl']);
      }
      return Promise.resolve([]);
    });
    mockedReadFile.mockImplementation((pathArg: unknown): Promise<string> => {
      if (pathArg !== '/mock/observability/usage-events/2026-05-26.jsonl') {
        return Promise.reject(new Error('ENOENT'));
      }
      const base = {
        version: 1,
        type: 'chat_turn_completed',
        timestamp: '2026-05-26T12:00:00.000Z',
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-1',
        workspaceLabel: 'Workspace',
        chatId: 'chat-1',
        turnStartedAt: '2026-05-26T11:59:59.000Z',
        turnCompletedAt: '2026-05-26T12:00:00.000Z',
        status: 'success',
      };
      return Promise.resolve(
        [
          JSON.stringify({
            ...base,
            id: 'chat-turn-completed:entry-1',
            auditEntryId: 'entry-1',
            repoId: 'repo-a',
            repoLabel: 'Repo A',
            provider: 'codex',
            initiationSource: 'user',
            toolUseCount: 2,
          }),
          JSON.stringify({
            ...base,
            id: 'chat-turn-completed:entry-2',
            auditEntryId: 'entry-2',
            repoId: 'repo-b',
            repoLabel: 'Repo B',
            provider: 'claude',
            initiationSource: 'hook',
            toolUseCount: 5,
          }),
        ].join('\n'),
      );
    });

    const service = new ObservabilityService();
    const summary = await service.loadUsageMetrics({
      startDate: '2026-05-26T00:00:00.000Z',
      endDate: '2026-05-27T00:00:00.000Z',
    });

    expect(summary.chats.turnCountsPerChat.rows).toEqual([
      expect.objectContaining({
        repoId: 'repo-a',
        provider: 'codex',
        initiationSource: 'user',
        count: 1,
      }),
      expect.objectContaining({
        repoId: 'repo-b',
        provider: 'claude',
        initiationSource: 'hook',
        count: 1,
      }),
    ]);
    expect(summary.chats.toolCallsPerChat.rows).toEqual([
      expect.objectContaining({
        repoId: 'repo-b',
        provider: 'claude',
        initiationSource: 'hook',
        count: 5,
      }),
      expect.objectContaining({
        repoId: 'repo-a',
        provider: 'codex',
        initiationSource: 'user',
        count: 2,
      }),
    ]);
    expect(summary.chats.toolCallsPerChat.rows[0]?.stats?.total).toBe(5);
    expect(summary.chats.toolCallsPerChat.rows[1]?.stats?.total).toBe(2);
    expect(summary.chats.toolCallsPerWorktree.rows).toHaveLength(2);
  });

  it('keeps plan breakdown rows separated by provider and source', async () => {
    mockedReaddir.mockImplementation((pathArg: unknown): Promise<string[]> => {
      if (pathArg === '/mock/observability/usage-events') {
        return Promise.resolve(['2026-05-26.jsonl']);
      }
      return Promise.resolve([]);
    });
    mockedReadFile.mockImplementation((pathArg: unknown): Promise<string> => {
      if (pathArg !== '/mock/observability/usage-events/2026-05-26.jsonl') {
        return Promise.reject(new Error('ENOENT'));
      }
      const base = {
        version: 1,
        type: 'plan_created',
        timestamp: '2026-05-26T12:00:00.000Z',
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-1',
        workspaceLabel: 'Workspace',
        chatId: 'chat-1',
        planId: 'plan-1',
      };
      return Promise.resolve(
        [
          JSON.stringify({
            ...base,
            id: 'plan-created:entry-1',
            provider: 'codex',
            initiationSource: 'user',
          }),
          JSON.stringify({
            ...base,
            id: 'plan-created:entry-2',
            provider: 'claude',
            initiationSource: 'hook',
          }),
        ].join('\n'),
      );
    });

    const service = new ObservabilityService();
    const summary = await service.loadUsageMetrics({
      startDate: '2026-05-26T00:00:00.000Z',
      endDate: '2026-05-27T00:00:00.000Z',
    });

    expect(summary.plans.created.rows).toHaveLength(2);
    expect(summary.plans.created.rows).toContainEqual(
      expect.objectContaining({
        provider: 'codex',
        initiationSource: 'user',
        count: 1,
      }),
    );
    expect(summary.plans.created.rows).toContainEqual(
      expect.objectContaining({
        provider: 'claude',
        initiationSource: 'hook',
        count: 1,
      }),
    );
    expect(summary.plans.createdPerWorktree.rows).toHaveLength(2);
  });

  it('normalizes pipeline usage events and ignores malformed pipeline lines', async () => {
    mockedReaddir.mockImplementation((pathArg: unknown): Promise<string[]> => {
      if (pathArg === '/mock/observability/usage-events') {
        return Promise.resolve(['2026-05-26.jsonl']);
      }
      return Promise.resolve([]);
    });
    mockedReadFile.mockImplementation((pathArg: unknown): Promise<string> => {
      if (pathArg !== '/mock/observability/usage-events/2026-05-26.jsonl') {
        return Promise.reject(new Error('ENOENT'));
      }
      return Promise.resolve(
        [
          JSON.stringify(
            makePipelineUsageEvent({
              id: 'pipeline-run-started:exec-1',
              type: 'pipeline_run_started',
              timestamp: '2026-05-26T12:00:00.000Z',
              status: 'running',
              runCompletedAt: undefined,
              runDurationMs: undefined,
            }),
          ),
          JSON.stringify(
            makePipelineUsageEvent({
              id: 'pipeline-run-completed:exec-1',
              type: 'pipeline_run_completed',
              status: 'success',
            }),
          ),
          JSON.stringify({
            ...makePipelineUsageEvent({
              id: 'pipeline-run-completed:malformed',
            }),
            pipelineIdentityKey: undefined,
          }),
          JSON.stringify({
            ...makePipelineUsageEvent({
              id: 'pipeline-run-completed:unknown-source',
              pipeline: {
                key: 'stored:user:pipeline-2',
                id: 'pipeline-2',
                name: 'Unknown Source Pipeline',
                source: 'nonsense' as never,
              },
              pipelineId: 'pipeline-2',
              pipelineName: 'Unknown Source Pipeline',
              pipelineIdentityKey: 'stored:user:pipeline-2',
            }),
          }),
        ].join('\n'),
      );
    });

    const service = new ObservabilityService();
    const view = await service.loadUsageMetricsView({
      tab: 'pipelines',
      metric: 'pipeline_runs_completed',
      groupBy: 'pipeline',
      window: {
        kind: 'custom',
        start: '2026-05-26T00:00:00.000Z',
        end: '2026-05-27T00:00:00.000Z',
      },
    });

    expect(view.rows).toEqual([
      expect.objectContaining({
        key: 'stored:user:pipeline-1',
        label: 'Deploy',
        count: 1,
      }),
      expect.objectContaining({
        key: 'stored:user:pipeline-2',
        label: 'Unknown Source Pipeline',
        count: 1,
      }),
    ]);
  });

  it('loads pipeline tab cards, count series, and duration distributions', async () => {
    await withSystemTime('2026-05-27T12:00:00.000Z', async () => {
      const service = new ObservabilityService();
      service.recordUsageMetricEvent(
        makePipelineUsageEvent({
          id: 'pipeline-run-started:exec-1',
          type: 'pipeline_run_started',
          timestamp: '2026-05-26T12:00:00.000Z',
          status: 'running',
          runCompletedAt: undefined,
          runDurationMs: undefined,
        }),
      );
      service.recordUsageMetricEvent(
        makePipelineUsageEvent({
          id: 'pipeline-run-completed:exec-1',
          type: 'pipeline_run_completed',
          timestamp: '2026-05-26T12:05:00.000Z',
          status: 'success',
          runDurationMs: 300_000,
        }),
      );
      service.recordUsageMetricEvent(
        makePipelineUsageEvent({
          id: 'pipeline-run-completed:exec-2',
          pipelineExecutionId: 'exec-2',
          timestamp: '2026-05-26T13:05:00.000Z',
          status: 'failure',
          runDurationMs: 600_000,
        }),
      );
      service.recordUsageMetricEvent(
        makePipelineUsageEvent({
          id: 'pipeline-run-completed:exec-3',
          pipelineExecutionId: 'exec-3',
          timestamp: '2026-05-26T14:05:00.000Z',
          status: 'cancelled',
          runDurationMs: 900_000,
        }),
      );
      service.recordUsageMetricEvent(
        makePipelineUsageEvent({
          id: 'pipeline-run-completed:hidden',
          pipelineExecutionId: 'hidden',
          status: 'failure',
          hidden: true,
        }),
      );

      const summary = await service.loadUsageTabSummary({ tab: 'pipelines' });
      expect(summary.cards.map((card) => card.key)).toEqual([
        'runs_started',
        'runs_completed',
        'avg_duration_ms',
        'runs_failed',
      ]);
      expect(
        summary.cards.find((card) => card.key === 'runs_started')?.allTime,
      ).toBe(1);
      expect(
        summary.cards.find((card) => card.key === 'runs_completed')?.allTime,
      ).toBe(3);
      expect(
        summary.cards.find((card) => card.key === 'runs_failed')?.allTime,
      ).toBe(1);

      const counts = await service.loadUsageTimeseries({
        startDate: '2026-05-26T00:00:00.000Z',
        endDate: '2026-05-27T00:00:00.000Z',
        bucket: 'day',
        dataset: {
          kind: 'tab-counts',
          tab: 'pipelines',
          series: [
            'pipeline_runs_started',
            'pipeline_runs_completed',
            'pipeline_runs_succeeded',
            'pipeline_runs_failed',
            'pipeline_runs_cancelled',
          ],
        },
      });

      expect(counts.kind).toBe('tab-counts');
      if (counts.kind !== 'tab-counts') return;
      const countBucket = counts.buckets.find(
        (bucket) =>
          bucket.bucketStart ===
          localBucketStartIso('2026-05-26T12:05:00.000Z', 'day'),
      );
      expect(countBucket?.series).toEqual({
        pipeline_runs_started: 1,
        pipeline_runs_completed: 3,
        pipeline_runs_succeeded: 1,
        pipeline_runs_failed: 1,
        pipeline_runs_cancelled: 1,
      });

      const duration = await service.loadUsageTimeseries({
        startDate: '2026-05-26T00:00:00.000Z',
        endDate: '2026-05-27T00:00:00.000Z',
        bucket: 'day',
        dataset: {
          kind: 'tab-distribution',
          tab: 'pipelines',
          metric: 'pipeline_duration_ms',
        },
      });

      expect(duration.kind).toBe('tab-distribution');
      if (duration.kind !== 'tab-distribution') return;
      const durationBucket = duration.buckets.find(
        (bucket) =>
          bucket.bucketStart ===
          localBucketStartIso('2026-05-26T12:05:00.000Z', 'day'),
      );
      expect(durationBucket).toEqual({
        bucketStart: localBucketStartIso('2026-05-26T12:05:00.000Z', 'day'),
        p50: 600_000,
        p95: 900_000,
        p99: 900_000,
        sampleCount: 3,
      });
    });
  });

  it('groups pipeline metrics by pipeline, project, and worktree without repo fields', async () => {
    const service = new ObservabilityService();
    service.recordUsageMetricEvent(
      makePipelineUsageEvent({
        id: 'pipeline-run-completed:deploy-1',
        pipelineExecutionId: 'deploy-1',
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-1',
        workspaceLabel: 'Workspace 1',
      }),
    );
    service.recordUsageMetricEvent(
      makePipelineUsageEvent({
        id: 'pipeline-run-completed:deploy-2',
        pipelineExecutionId: 'deploy-2',
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-1',
        workspaceLabel: 'Workspace 1',
      }),
    );
    service.recordUsageMetricEvent(
      makePipelineUsageEvent({
        id: 'pipeline-run-completed:test-1',
        pipelineExecutionId: 'test-1',
        workspaceId: 'workspace-2',
        worktreeId: 'worktree-2',
        workspaceLabel: 'Workspace 2',
        pipeline: {
          key: 'stored:bundled:test',
          id: 'test',
          name: 'Test',
          source: 'bundled',
        },
        pipelineId: 'test',
        pipelineName: 'Test',
        pipelineIdentityKey: 'stored:bundled:test',
      }),
    );

    const pipelineRows = await service.loadUsageMetricsView({
      tab: 'pipelines',
      metric: 'pipeline_runs_completed',
      groupBy: 'pipeline',
      window: { kind: 'allTime' },
    });

    expect(pipelineRows.rows).toEqual([
      expect.objectContaining({
        key: 'stored:user:pipeline-1',
        label: 'Deploy',
        count: 2,
      }),
      expect.objectContaining({
        key: 'stored:bundled:test',
        label: 'Test',
        count: 1,
      }),
    ]);
    expect(pipelineRows.rows[0]?.repoId).toBeUndefined();

    const workspaceRows = await service.loadUsageMetricsView({
      tab: 'pipelines',
      metric: 'pipeline_runs_completed',
      groupBy: 'workspace',
      window: { kind: 'allTime' },
    });
    expect(workspaceRows.rows).toEqual([
      expect.objectContaining({
        key: 'workspace-1',
        label: 'Workspace 1',
        workspaceId: 'workspace-1',
        count: 2,
      }),
      expect.objectContaining({
        key: 'workspace-2',
        label: 'Workspace 2',
        workspaceId: 'workspace-2',
        count: 1,
      }),
    ]);

    const worktreeRows = await service.loadUsageMetricsView({
      tab: 'pipelines',
      metric: 'pipeline_runs_completed',
      groupBy: 'worktree',
      window: { kind: 'allTime' },
    });
    expect(worktreeRows.rows.map((row) => row.key)).toEqual([
      'workspace-1::worktree-1',
      'workspace-2::worktree-2',
    ]);
    expect(worktreeRows.rows.map((row) => row.worktreeId)).toEqual([
      'worktree-1',
      'worktree-2',
    ]);
  });

  it('omits pipeline breakdown rows that do not contribute to the selected metric', async () => {
    const service = new ObservabilityService();
    service.recordUsageMetricEvent(
      makePipelineUsageEvent({
        id: 'pipeline-run-started:started-only',
        type: 'pipeline_run_started',
        pipelineExecutionId: 'started-only',
        timestamp: '2026-05-26T12:00:00.000Z',
        status: 'running',
        pipeline: {
          key: 'stored:user:started-only',
          id: 'started-only',
          name: 'Started Only',
          source: 'user',
        },
        pipelineId: 'started-only',
        pipelineName: 'Started Only',
        pipelineIdentityKey: 'stored:user:started-only',
      }),
    );
    service.recordUsageMetricEvent(
      makePipelineUsageEvent({
        id: 'pipeline-run-completed:completed',
        pipelineExecutionId: 'completed',
        pipeline: {
          key: 'stored:user:completed',
          id: 'completed',
          name: 'Completed',
          source: 'user',
        },
        pipelineId: 'completed',
        pipelineName: 'Completed',
        pipelineIdentityKey: 'stored:user:completed',
      }),
    );

    const completedByPipeline = await service.loadUsageMetricsView({
      tab: 'pipelines',
      metric: 'pipeline_runs_completed',
      groupBy: 'pipeline',
      window: { kind: 'allTime' },
    });
    expect(completedByPipeline.rows).toEqual([
      expect.objectContaining({
        key: 'stored:user:completed',
        label: 'Completed',
        count: 1,
      }),
    ]);

    const durationByInitiation = await service.loadUsageMetricsView({
      tab: 'pipelines',
      metric: 'pipeline_duration_ms',
      groupBy: 'initiation_source',
      window: { kind: 'allTime' },
    });
    expect(durationByInitiation.rows).toHaveLength(1);
    expect(durationByInitiation.rows[0]).toEqual(
      expect.objectContaining({
        key: 'user',
        count: 1,
      }),
    );

    const durationByTrigger = await service.loadUsageMetricsView({
      tab: 'pipelines',
      metric: 'pipeline_duration_ms',
      groupBy: 'trigger_source',
      window: { kind: 'allTime' },
    });
    expect(durationByTrigger.rows).toEqual([]);
  });

  it('groups pipeline trigger sources only when an explicit trigger is present', async () => {
    const service = new ObservabilityService();
    service.recordUsageMetricEvent(
      makePipelineUsageEvent({
        id: 'pipeline-run-completed:hook',
        pipelineExecutionId: 'hook',
        initiationSource: 'hook',
        triggerSource: 'hook',
      }),
    );

    const durationByTrigger = await service.loadUsageMetricsView({
      tab: 'pipelines',
      metric: 'pipeline_duration_ms',
      groupBy: 'trigger_source',
      window: { kind: 'allTime' },
    });
    expect(durationByTrigger.rows).toHaveLength(1);
    expect(durationByTrigger.rows[0]).toEqual(
      expect.objectContaining({
        key: 'hook',
        count: 1,
      }),
    );
  });

  it('loads transcript sidecars with injected prompt metadata and skips a malformed trailing line', async () => {
    const files = installMockFilesystem();
    files.set(
      '/mock/observability/transcripts/2026-03-30/worktree_chat-entry-1.jsonl',
      [
        JSON.stringify({
          type: 'canopy_user_prompt',
          provider: 'claude',
          original_text: 'Please debug this',
          submitted_text: 'Please debug this',
          plan_mode: false,
        }),
        JSON.stringify({
          type: 'canopy_injected_prompt',
          kind: 'system_prompt_append',
          provider: 'claude',
          application_condition: 'claude_system_prompt_append_each_turn',
          text: 'Use the standalone history directory.',
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'text',
                text: 'Working on it',
              },
            ],
          },
        }),
        '{"type":"assistant"',
      ].join('\n'),
    );

    const service = new ObservabilityService();
    const response = await service.loadTranscript({
      id: 'entry-1',
      eventType: 'worktree_chat',
      startedAt: '2026-03-30T12:00:00.000Z',
    });

    expect(response.type).toBe('success');
    if (response.type !== 'success') {
      throw new Error('Expected transcript response');
    }

    expect(response.lines).toEqual([
      JSON.stringify({
        type: 'canopy_user_prompt',
        provider: 'claude',
        original_text: 'Please debug this',
        submitted_text: 'Please debug this',
        plan_mode: false,
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: 'Working on it',
            },
          ],
        },
      }),
    ]);
    expect(response.providerHint).toBe('claude');
    expect(response.truncation.truncated).toBe(false);
    expect(response.truncation.maxBytes).toBe(8 * 1024 * 1024);
    expect(typeof response.truncation.storedBytes).toBe('number');
    expect(response.injectedPrompts).toEqual([
      {
        kind: 'system_prompt_append',
        provider: 'claude',
        applicationCondition: 'claude_system_prompt_append_each_turn',
        text: 'Use the standalone history directory.',
      },
    ]);
  });

  it('returns not_available when a transcript sidecar is missing', async () => {
    const service = new ObservabilityService();

    await expect(
      service.loadTranscript({
        id: 'missing-entry',
        eventType: 'worktree_chat',
        startedAt: '2026-03-30T12:00:00.000Z',
      }),
    ).resolves.toEqual({ type: 'not_available' });
  });

  it('writes a truncation marker when a chat transcript exceeds the byte cap', async () => {
    installMockFilesystem();

    const service = new ObservabilityService();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'claude',
      originalUserText: 'Start work',
      submittedText: 'Start work',
      planMode: false,
      isStandalone: false,
    });
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: 'x'.repeat(9_000_000),
          },
        ],
      },
    });

    await service.flush();

    const transcriptWrite = mockedAppendFile.mock.calls.find(
      (call) =>
        typeof call[0] === 'string' && call[0].includes('/transcripts/'),
    );
    expect(String(transcriptWrite?.[1])).toContain(
      '"type":"canopy_transcript_truncated"',
    );

    const recentEntry = loadOnlyRecentEntry(service);
    const response = await service.loadTranscript({
      id: recentEntry.id,
      eventType: 'worktree_chat',
      startedAt: recentEntry.startedAt,
    });

    expect(recentEntry.hasTranscript).toBe(true);
    expect(response).toMatchObject({
      type: 'success',
      truncation: {
        truncated: true,
      },
    });
  });

  it('does not mark transcripts available when only the truncation marker is persisted', async () => {
    installMockFilesystem();

    const service = new ObservabilityService();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'claude',
      originalUserText: 'x'.repeat(9_000_000),
      submittedText: 'x'.repeat(9_000_000),
      planMode: false,
      isStandalone: false,
    });

    await service.flush();

    const recentEntry = loadOnlyRecentEntry(service);
    const response = await service.loadTranscript({
      id: recentEntry.id,
      eventType: 'worktree_chat',
      startedAt: recentEntry.startedAt,
    });

    expect(recentEntry.hasTranscript).toBe(false);
    expect(response).toEqual({ type: 'not_available' });
  });

  it('serializes audit purges with queued flushes from other worktrees', async () => {
    const files = installMockFilesystem();
    const day = new Date().toISOString().slice(0, 10);
    const filePath = `/mock/observability/${day}.jsonl`;
    const sessionEventsPath = `/mock/observability/diagnostics/session-events/${day}.jsonl`;
    const appEventsPath = `/mock/observability/diagnostics/app-events/${day}.jsonl`;
    mockedReaddir.mockImplementation((pathArg: unknown): Promise<string[]> => {
      if (pathArg === '/mock/observability') {
        return Promise.resolve([`${day}.jsonl`]);
      }
      if (pathArg === '/mock/observability/diagnostics/session-events') {
        return Promise.resolve([`${day}.jsonl`]);
      }
      return Promise.resolve([]);
    });
    files.set(
      filePath,
      [
        makeAuditEntry('purge-me', `${day}T12:00:00.000Z`, {
          projectId: 'proj',
          worktreeId: 'wt-1',
        }),
        makeAuditEntry('keep-me', `${day}T12:30:00.000Z`, {
          projectId: 'proj',
          worktreeId: 'wt-2',
        }),
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n') + '\n',
    );
    files.set(
      sessionEventsPath,
      [
        {
          version: 1,
          timestamp: `${day}T12:00:00.000Z`,
          kind: 'session_registered',
          sessionKey: 'proj/wt-1/chat-1',
          projectId: 'proj',
          worktreeId: 'wt-1',
          chatId: 'chat-1',
          providerType: 'claude',
        },
        {
          version: 1,
          timestamp: `${day}T12:30:00.000Z`,
          kind: 'session_registered',
          sessionKey: 'proj/wt-2/chat-2',
          projectId: 'proj',
          worktreeId: 'wt-2',
          chatId: 'chat-2',
          providerType: 'codex',
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n') + '\n',
    );
    files.set(
      appEventsPath,
      `${JSON.stringify({
        version: 1,
        timestamp: `${day}T12:45:00.000Z`,
        kind: 'before_quit',
      })}\n`,
    );

    let auditReadPending = false;
    let notifyAuditReadStarted = (): void => undefined;
    const auditReadStarted = new Promise<void>((resolve) => {
      notifyAuditReadStarted = resolve;
    });
    let releaseAuditRead = (): void => {
      throw new Error('Expected audit day read to be pending');
    };
    mockedReadFile.mockImplementation((pathArg: unknown): Promise<string> => {
      if (typeof pathArg !== 'string') {
        return Promise.reject(new Error('Unexpected read path'));
      }

      if (pathArg === filePath && !auditReadPending) {
        return new Promise<string>((resolve) => {
          auditReadPending = true;
          notifyAuditReadStarted();
          releaseAuditRead = (): void => {
            const contents = files.get(pathArg);
            if (contents === undefined) {
              throw new Error(`ENOENT: ${pathArg}`);
            }
            resolve(contents);
          };
        });
      }

      const contents = files.get(pathArg);
      if (contents === undefined) {
        return Promise.reject(new Error(`ENOENT: ${pathArg}`));
      }
      return Promise.resolve(contents);
    });

    const service = new ObservabilityService();
    const purgePromise = service.purgeWorktreeData('proj', 'wt-1');

    await auditReadStarted;

    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt-2',
      chatId: 'chat-late',
      provider: 'claude',
      originalUserText: 'Late prompt',
      submittedText: 'Late prompt',
      planMode: false,
      isStandalone: false,
    });
    service.completeChatTurn('proj', 'wt-2', 'chat-late', 'success');
    const lateEntryId = loadOnlyRecentEntry(service).id;
    const lateFlushPromise = service.flush();

    releaseAuditRead();
    await purgePromise;
    await lateFlushPromise;

    const auditContents = files.get(filePath);
    if (auditContents === undefined) {
      throw new Error(`Expected ${filePath} to exist`);
    }

    expect(auditContents.includes('"id":"purge-me"')).toBe(false);
    expect(auditContents.includes('"id":"keep-me"')).toBe(true);
    expect(auditContents.includes(`"id":"${lateEntryId}"`)).toBe(true);
    const sessionContents = files.get(sessionEventsPath);
    if (sessionContents === undefined) {
      throw new Error(`Expected ${sessionEventsPath} to exist`);
    }
    expect(sessionContents.includes('"sessionKey":"proj/wt-1/chat-1"')).toBe(
      false,
    );
    expect(sessionContents.includes('"sessionKey":"proj/wt-2/chat-2"')).toBe(
      true,
    );
    expect(files.get(appEventsPath)).toContain('"kind":"before_quit"');
    expect(mockedWriteFile).toHaveBeenCalledWith(
      `${filePath}.tmp`,
      expect.any(String),
      'utf8',
    );
    expect(mockedRename).toHaveBeenCalledWith(`${filePath}.tmp`, filePath);
  });

  it('prunes expired transcript and diagnostic day files alongside audit day files', async () => {
    mockedReaddir.mockImplementation((pathArg: unknown): Promise<string[]> => {
      if (pathArg === '/mock/observability') {
        return Promise.resolve(['2020-01-01.jsonl', '2099-01-01.jsonl']);
      }
      if (pathArg === '/mock/observability/usage-events') {
        return Promise.resolve(['2020-01-01.jsonl', '2099-01-01.jsonl']);
      }
      if (pathArg === '/mock/observability/diagnostics/app-events') {
        return Promise.resolve(['2020-01-01.jsonl', '2099-01-01.jsonl']);
      }
      if (pathArg === '/mock/observability/diagnostics/session-events') {
        return Promise.resolve(['2020-01-01.jsonl', '2099-01-01.jsonl']);
      }
      if (pathArg === '/mock/observability/transcripts') {
        return Promise.resolve(['2020-01-01', '2099-01-01']);
      }
      return Promise.resolve([]);
    });

    const service = new ObservabilityService();
    await service.start();

    expect(mockedRm).toHaveBeenCalledWith(
      '/mock/observability/2020-01-01.jsonl',
      {
        force: true,
      },
    );
    expect(mockedRm).toHaveBeenCalledWith(
      '/mock/observability/transcripts/2020-01-01',
      {
        force: true,
        recursive: true,
      },
    );
    expect(mockedRm).toHaveBeenCalledWith(
      '/mock/observability/usage-events/2020-01-01.jsonl',
      {
        force: true,
      },
    );
    expect(mockedRm).toHaveBeenCalledWith(
      '/mock/observability/diagnostics/app-events/2020-01-01.jsonl',
      {
        force: true,
      },
    );
    expect(mockedRm).toHaveBeenCalledWith(
      '/mock/observability/diagnostics/session-events/2020-01-01.jsonl',
      {
        force: true,
      },
    );

    await service.dispose();
  });

  describe('local-memory citation tracking gate', () => {
    const citationTranscriptLines = [
      JSON.stringify({
        type: 'canopy_user_prompt',
        provider: 'claude',
        original_text: 'Question',
        submitted_text: '<local_memory>facts</local_memory>\nQuestion',
        plan_mode: false,
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: 'Answer <memory_citation files="topics/x.md"/>',
            },
          ],
        },
      }),
    ];

    function makeTranscriptResponse(
      truncated: boolean,
    ): AgentAuditTranscriptResponse {
      return {
        type: 'success',
        lines: citationTranscriptLines,
        truncation: {
          truncated,
          maxBytes: 8 * 1024 * 1024,
          storedBytes: 256,
        },
        injectedPrompts: [],
      };
    }

    async function flushCitationTracking(): Promise<void> {
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
    }

    it.each(['failure', 'cancelled', 'interrupted'] as const)(
      'does not emit citation tracking for a %s turn',
      async (status) => {
        const service = new ObservabilityService();
        await service.start();
        const loadTranscriptSpy = jest
          .spyOn(service, 'loadTranscript')
          .mockResolvedValue(makeTranscriptResponse(false));
        startClaudeChatTurn(service);
        service.completeChatTurn('proj', 'wt', 'chat', status);
        await flushCitationTracking();

        expect(loadTranscriptSpy).not.toHaveBeenCalled();
        expect(
          mockTrackCompletedTurnLocalMemoryCitations,
        ).not.toHaveBeenCalled();

        await service.dispose();
      },
    );

    it('does not emit citation tracking when the stored transcript is truncated', async () => {
      const service = new ObservabilityService();
      await service.start();
      jest
        .spyOn(service, 'loadTranscript')
        .mockResolvedValue(makeTranscriptResponse(true));
      startClaudeChatTurn(service);
      service.completeChatTurn('proj', 'wt', 'chat', 'success');
      await flushCitationTracking();

      expect(mockTrackCompletedTurnLocalMemoryCitations).not.toHaveBeenCalled();

      await service.dispose();
    });

    it('does not load the transcript when local memory is disabled', async () => {
      mockIsLocalMemoryCitationTrackingEnabled.mockResolvedValueOnce(false);
      const service = new ObservabilityService();
      await service.start();
      const loadTranscriptSpy = jest
        .spyOn(service, 'loadTranscript')
        .mockResolvedValue(makeTranscriptResponse(false));
      startClaudeChatTurn(service);
      service.completeChatTurn('proj', 'wt', 'chat', 'success');
      await flushCitationTracking();

      expect(mockIsLocalMemoryCitationTrackingEnabled).toHaveBeenCalled();
      expect(loadTranscriptSpy).not.toHaveBeenCalled();
      expect(mockTrackCompletedTurnLocalMemoryCitations).not.toHaveBeenCalled();

      await service.dispose();
    });

    it('does not schedule citation tracking before the service starts', async () => {
      const service = new ObservabilityService();
      const loadTranscriptSpy = jest
        .spyOn(service, 'loadTranscript')
        .mockResolvedValue(makeTranscriptResponse(false));
      startClaudeChatTurn(service);
      service.completeChatTurn('proj', 'wt', 'chat', 'success');
      await flushCitationTracking();

      expect(loadTranscriptSpy).not.toHaveBeenCalled();
      expect(mockTrackCompletedTurnLocalMemoryCitations).not.toHaveBeenCalled();

      await service.dispose();
    });

    it('does not schedule citation tracking once disposal has begun', async () => {
      const service = new ObservabilityService();
      await service.start();
      const loadTranscriptSpy = jest
        .spyOn(service, 'loadTranscript')
        .mockResolvedValue(makeTranscriptResponse(false));
      await service.dispose();
      startClaudeChatTurn(service);
      service.completeChatTurn('proj', 'wt', 'chat', 'success');
      await flushCitationTracking();

      expect(loadTranscriptSpy).not.toHaveBeenCalled();
      expect(mockTrackCompletedTurnLocalMemoryCitations).not.toHaveBeenCalled();
    });

    it('tracks citations for a successful turn with an untruncated transcript', async () => {
      const service = new ObservabilityService();
      await service.start();
      jest
        .spyOn(service, 'loadTranscript')
        .mockResolvedValue(makeTranscriptResponse(false));
      startClaudeChatTurn(service);
      const entry = completeClaudeChatTurn(service);
      await flushCitationTracking();

      expect(mockTrackCompletedTurnLocalMemoryCitations).toHaveBeenCalledWith({
        auditEntryId: entry.id,
        provider: 'claude',
        transcriptLines: citationTranscriptLines,
      });

      await service.dispose();
    });
  });
});

describe('Copilot account usage overview', () => {
  beforeEach(() => {
    mockReadCopilotUsage.mockReset();
    mockCopilotEnabled.mockReturnValue(true);
    mockedReadPreferencesFile.mockResolvedValue({
      ...makePreferences(30),
      copilotEnabled: true,
    });
  });
  afterEach(() => {
    mockCopilotEnabled.mockReturnValue(false);
  });
  it('coalesces reads, clears immediately and ignores both stale successes and errors', async () => {
    const service = new ObservabilityService();
    let finish: (value: unknown) => void = () => {};
    mockReadCopilotUsage.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const first = service.refreshProviderUsage('copilot');
    const second = service.refreshProviderUsage('copilot');
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockReadCopilotUsage).toHaveBeenCalledTimes(1);
    service.invalidateCopilotUsage();
    expect(mockReadCopilotUsage).toHaveBeenLastCalledWith(
      expect.objectContaining({ aborted: true }),
    );
    finish({
      provider: 'copilot',
      authState: 'authenticated',
      hasRemainingLimits: true,
      accountLabel: 'old',
    });
    await Promise.all([first, second]);
    expect(
      service
        .getUsageOverview()
        .providers.some((p) => p.provider === 'copilot'),
    ).toBe(false);
    let fail: (reason: Error) => void = () => {};
    mockReadCopilotUsage.mockReturnValue(
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
    );
    const stale = service.refreshProviderUsage('copilot');
    await new Promise((resolve) => setImmediate(resolve));
    service.invalidateCopilotUsage();
    mockReadCopilotUsage.mockResolvedValue({
      provider: 'copilot',
      authState: 'authenticated',
      hasRemainingLimits: false,
      accountLabel: 'new',
    });
    await service.refreshProviderUsage('copilot');
    fail(new Error('old account failure'));
    await stale;
    expect(
      service.getUsageOverview().providers.find((p) => p.provider === 'copilot')
        ?.accountLabel,
    ).toBe('new');
  });
  it('does not read authentication or quotas while disabled', async () => {
    const service = new ObservabilityService();
    const usageEvents = jest.fn();
    service.subscribe((event) => {
      if (event.type === 'usage') usageEvents();
    });
    mockCopilotEnabled.mockReturnValue(false);
    await service.refreshProviderUsage('copilot');
    mockCopilotEnabled.mockReturnValue(true);
    mockedReadPreferencesFile.mockResolvedValue({
      ...makePreferences(30),
      copilotEnabled: false,
    });
    await service.refreshProviderUsage('copilot');
    expect(mockReadCopilotUsage).not.toHaveBeenCalled();
    expect(usageEvents).not.toHaveBeenCalled();
  });
  it('drops previous account data when a fresh read fails', async () => {
    const service = new ObservabilityService();
    mockReadCopilotUsage.mockResolvedValue({
      provider: 'copilot',
      authState: 'authenticated',
      hasRemainingLimits: true,
      accountLabel: 'old',
      rateLimits: [{ limitId: 'premium', primary: { usedPercent: 10 } }],
    });
    await service.refreshProviderUsage('copilot');
    mockReadCopilotUsage.mockRejectedValue(new Error('sensitive diagnostics'));
    await service.refreshProviderUsage('copilot');
    const summary = service
      .getUsageOverview()
      .providers.find((p) => p.provider === 'copilot');
    expect(summary).toMatchObject({
      authState: 'error',
      hasRemainingLimits: false,
      errorInfo: { kind: 'service' },
    });
    expect(summary?.accountLabel).toBeUndefined();
    expect(summary?.rateLimits).toBeUndefined();
  });
  it('publishes Copilot allowance through the shared overview', async () => {
    mockCopilotEnabled.mockReturnValue(true);
    mockedReadPreferencesFile.mockResolvedValue({
      ...makePreferences(30),
      copilotEnabled: true,
    });
    mockReadCopilotUsage.mockResolvedValue({
      provider: 'copilot',
      authState: 'authenticated',
      hasRemainingLimits: true,
      accountLabel: 'copilot-fixture',
      rateLimits: [
        {
          limitId: 'premium_interactions',
          limitName: 'Premium requests',
          primary: { usedPercent: 25 },
        },
      ],
    });
    const service = new ObservabilityService();
    await service.refreshProviderUsage('copilot');
    expect(service.getUsageOverview().providers).toContainEqual(
      expect.objectContaining({
        provider: 'copilot',
        accountLabel: 'copilot-fixture',
        rateLimits: [
          {
            limitId: 'premium_interactions',
            limitName: 'Premium requests',
            primary: { usedPercent: 25 },
          },
        ],
      }),
    );
  });
});

describe('canonical account proxy quota projection', () => {
  beforeEach(() => {
    mockProxyUsageInventory.mockReturnValue([]);
    mockProxyUsageRead.mockReset();
    mockProxyInventoryListeners.clear();
    mockPublishProxyStatus.mockClear();
  });

  it('refreshes only the selected provider and publishes canonical values', async () => {
    const claude: AccountProxyUsageInventoryEntry = {
      connectionId: 'proxy',
      authIndex: 'claude-account',
      provider: 'claude',
      identity: 'first',
    };
    const codex: AccountProxyUsageInventoryEntry = {
      connectionId: 'proxy',
      authIndex: 'codex-account',
      provider: 'codex',
      identity: 'second',
    };
    mockProxyUsageInventory.mockReturnValue([claude, codex]);
    mockProxyUsageRead.mockResolvedValue({
      status: 'success',
      rateLimits: [{ primary: { usedPercent: 42 } }],
    });
    const service = new ObservabilityService();
    try {
      await service.refreshAccountProxyUsage({
        interactive: true,
        provider: 'claude',
      });
      expect(mockProxyUsageRead).toHaveBeenCalledTimes(1);
      expect(mockProxyUsageRead).toHaveBeenCalledWith(
        claude,
        expect.any(AbortSignal),
      );
      expect(
        service.getAccountProxyUsage('proxy', 'claude-account'),
      ).toMatchObject({
        source: 'live',
        rateLimits: [{ primary: { usedPercent: 42 } }],
      });
      expect(
        service.getAccountProxyUsage('proxy', 'claude-account')?.lastUpdatedAt,
      ).toEqual(expect.any(String));
      expect(
        service.getAccountProxyUsage('proxy', 'codex-account'),
      ).toBeUndefined();
      expect(mockPublishProxyStatus).toHaveBeenCalled();
      mockProxyUsageInventory.mockReturnValue([]);
      for (const listener of Array.from(mockProxyInventoryListeners))
        listener();
      expect(
        service.getAccountProxyUsage('proxy', 'claude-account'),
      ).toBeUndefined();
    } finally {
      await service.dispose();
    }
    expect(mockProxyInventoryListeners.size).toBe(0);
  });
});
