import type * as ActiveChatInputModule from '../services/active-chat-input';
import { browserHandoffs } from '../browser/browser-handoffs';
import {
  capturePresentationTurn,
  clearPresentationTurn,
  presentationChatKey,
} from '../canopy-tools/presentation-state';
jest.mock('../opencode/connection', () => ({
  assertOpenCodeModelAvailable: jest.fn(() =>
    Promise.resolve({
      id: 'opencode:fixture%2Fmodel',
      supportedThinkingLevels: [],
    }),
  ),
}));
jest.mock('../copilot/connection', () => ({
  assertCopilotModelAvailable: jest.fn(() =>
    Promise.resolve({ id: 'copilot:gpt-5', supportedThinkingLevels: [] }),
  ),
}));
import { cancelChatTurn } from '../lib/chat-turn-cancel';
const composeRepoRulesMock = jest.fn<Promise<string>, [string, string, string]>(
  () => Promise.resolve(''),
);
jest.mock('../repo-rules/host', () => ({
  composeWorktreeRepoRules: (
    ...args: [string, string, string]
  ): Promise<string> => composeRepoRulesMock(...args),
}));
import type * as ChatTurnAuditModule from '../lib/chat-turn-audit';
import type * as ChatSubmittedMessageModule from '../lib/chat-submitted-message';
import type * as PlanFileSyncModule from '../lib/plan-file-sync';
import type { PendingSystemInstruction } from '@canopy/desktop-shared/types';
import type { AgentSentInfo } from '@canopy/protocol/portal/external-agent-sender';

const isDelegationDeliveryActiveMock = jest.fn<boolean, unknown[]>(() => false);
const claimDelegationDeliveryMock = jest.fn<boolean, unknown[]>(() => false);
const releaseDelegationDeliveryMock = jest.fn<void, unknown[]>();
const resolveManagedDelegationModeMock = jest.fn(
  (mode: 'off' | 'explicit-only' | 'proactive' | undefined) =>
    mode ?? 'explicit-only',
);
jest.mock('../agents/delegation/lifecycle', () => ({
  isDelegationDeliveryActive: (...args: unknown[]): boolean =>
    isDelegationDeliveryActiveMock(...args),
  claimDelegationDelivery: (...args: unknown[]): boolean =>
    claimDelegationDeliveryMock(...args),
  releaseDelegationDelivery: (...args: unknown[]): void =>
    releaseDelegationDeliveryMock(...args),
}));
jest.mock('../agents/delegation/gate', () => ({
  resolveManagedDelegationMode: (
    mode: 'off' | 'explicit-only' | 'proactive' | undefined,
  ): 'off' | 'explicit-only' | 'proactive' =>
    resolveManagedDelegationModeMock(mode),
}));

interface MockAgentSession {
  sendMessage: jest.Mock;
  setPlanMode: jest.Mock;
  setApprovalMode: jest.Mock;
  getProviderSessionId: jest.Mock;
  isDisposed?: () => boolean;
  setSpeed?: jest.Mock;
  setFastMode?: jest.Mock;
  __onEvent: (data: unknown) => void;
}

interface MockSessionLifecycle {
  onRemoved?: () => void;
  drainEventsBeforeRemoval?: () => Promise<void>;
}

const releaseResourceMock = jest.fn();
const reserveChatTurnStartMock = jest.fn(() =>
  Promise.resolve({ release: releaseResourceMock }),
);
const runWithScopeActivityMock = jest.fn(
  async <T>(_scope: unknown, operation: () => Promise<T>): Promise<T> =>
    operation(),
);
const updateChatDescriptionMock = jest.fn(() => Promise.resolve());
const commitInitialChatTitleMock = jest.fn(() => Promise.resolve(true));
const getInitialChatTitlePromptMock = jest.fn<
  Promise<string | null>,
  unknown[]
>(() => Promise.resolve('Investigate the failing health-check endpoint.'));
let cancellationSession: { cancel: jest.Mock<Promise<void>, []> } | undefined;
const drainChatSessionEventsMock = jest.fn<Promise<void>, []>(() =>
  Promise.resolve(),
);

jest.mock('../resource-monitor', () => ({
  getResourceMonitorService: (): { reserveChatTurnStart: jest.Mock } => ({
    reserveChatTurnStart: reserveChatTurnStartMock,
  }),
}));

jest.mock('../services/chat-state-service', () => ({
  getChatStateService: (): Record<string, jest.Mock> => ({
    runWithScopeActivity: runWithScopeActivityMock,
    updateChatDescription: updateChatDescriptionMock,
    commitInitialChatTitle: commitInitialChatTitleMock,
    getInitialChatTitlePrompt: getInitialChatTitlePromptMock,
    reconcileHostQueue: jest.fn(() => Promise.resolve()),
    inputDelivery: {
      stop: async (
        _target: unknown,
        operation: () => Promise<void>,
      ): Promise<void> => operation(),
    },
  }),
}));

const readPreferencesFileMock = jest.fn(() =>
  Promise.resolve({ orgMemoryInjectionEnabled: false }),
);
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: async (): Promise<Record<string, unknown>> => {
    const preferences = await readPreferencesFileMock();
    const defaultChatModelByProvider = {
      claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'high' },
      codex: { model: 'gpt-5.5', thinkingLevel: 'high' },
      ...((preferences.defaultChatModelByProvider as Record<string, unknown>) ??
        {}),
    };
    const defaultWorktreeModelByProvider = {
      claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'high' },
      codex: { model: 'gpt-5.5', thinkingLevel: 'high' },
      ...((preferences.defaultWorktreeModelByProvider as Record<
        string,
        unknown
      >) ?? {}),
    };
    return {
      defaultChatProvider: 'claude',
      defaultChatModelByProvider,
      defaultWorktreeProvider: 'claude',
      defaultWorktreeModelByProvider,
      ...preferences,
      defaultChatModelByProvider,
      defaultWorktreeModelByProvider,
    };
  },
  updatePreferencesFile: (): Promise<void> => Promise.resolve(),
}));

const requireLaneAwareDefaultSelectionMock = jest.fn(
  (
    preferences: Record<string, unknown>,
    scope: 'chat' | 'worktree',
    preferredProvider?: 'claude' | 'codex' | 'ollama',
  ): Promise<Record<string, unknown>> => {
    const providerKey =
      scope === 'chat' ? 'defaultChatProvider' : 'defaultWorktreeProvider';
    const defaultsKey =
      scope === 'chat'
        ? 'defaultChatModelByProvider'
        : 'defaultWorktreeModelByProvider';
    const provider =
      preferredProvider ?? (preferences[providerKey] as string) ?? 'claude';
    const defaults = preferences[defaultsKey] as Record<
      string,
      Record<string, unknown>
    >;
    return Promise.resolve(defaults[provider]);
  },
);
jest.mock('../lib/default-model-lane-resolver', () => ({
  requireLaneAwareDefaultSelection: (
    preferences: Record<string, unknown>,
    scope: 'chat' | 'worktree',
    _credentialScope: unknown,
    preferredProvider?: 'claude' | 'codex' | 'ollama',
  ): Promise<Record<string, unknown>> =>
    requireLaneAwareDefaultSelectionMock(preferences, scope, preferredProvider),
}));

jest.mock('../agents/agent-model-runtime', () => ({
  resolveAgentModelRuntime: (options: {
    model: string;
    providerType?: 'claude' | 'codex' | 'ollama';
    systemPromptAppend?: string;
    pluginSelections?: unknown;
  }): Promise<Record<string, unknown>> => {
    const providerType =
      options.providerType ??
      (options.model.startsWith('gpt-') ? 'codex' : 'claude');
    return Promise.resolve({
      selectedModel: options.model,
      runtimeModel: options.model,
      providerType,
      executionHarness: providerType,
      systemPromptAppend: options.systemPromptAppend,
      pluginSelections: options.pluginSelections,
    });
  },
}));

// Two orgs the account may search, A first: org memory must still search only
// the org that owns the chat's work (CAN-3457).
const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const getCanopyCloudCredentialsMock = jest.fn(() =>
  Promise.resolve({
    baseUrl: 'https://cloud.example',
    apiKey: 'key',
    capabilities: ['memorySearch'],
    memorySearchOrganizationExternalId: ORG_A,
    memorySearchOrganizationExternalIds: [ORG_A, ORG_B],
  }),
);
const isOrganizationTeamsLapsedMock = jest.fn<Promise<boolean>, [string]>(() =>
  Promise.resolve(false),
);
jest.mock('../lib/org-billing-state', () => ({
  isOrganizationTeamsLapsed: (org: string): Promise<boolean> =>
    isOrganizationTeamsLapsedMock(org),
}));
jest.mock('../lib/canopy-cloud-account-store', () => ({
  getCanopyCloudCredentials: (): Promise<Record<string, unknown>> =>
    getCanopyCloudCredentialsMock(),
  subscribeCanopyCloudAccountChanges: jest.fn(() => jest.fn()),
}));

const fetchOrgMemoryAttemptMock = jest.fn<Promise<unknown>, unknown[]>(() =>
  Promise.resolve({
    result: null,
    factCount: 0,
    responseReceived: true,
  }),
);
const ackOrgMemoryDeliveredMock = jest.fn<
  Promise<void>,
  [string, string, unknown?]
>(() => Promise.resolve());
jest.mock('../memory/memory-client', () => {
  // The real budget constant, not a stale copy: `remainingMemoryBudgetMs`
  // reads it through this mock, so a drifted literal would silently retune
  // the race for every test in this file.
  const actualMemoryClient = jest.requireActual<typeof MemoryClientModule>(
    '../memory/memory-client',
  );
  return {
    CLIENT_FETCH_TIMEOUT_MS: actualMemoryClient.CLIENT_FETCH_TIMEOUT_MS,
    fetchOrgMemoryAttempt: (...args: unknown[]): Promise<unknown> =>
      fetchOrgMemoryAttemptMock(...args),
    ackOrgMemoryDelivered: (
      organizationExternalId: string,
      searchId: string,
      details?: unknown,
    ): Promise<void> =>
      ackOrgMemoryDeliveredMock(organizationExternalId, searchId, details),
  };
});

const persistOrgMemoryUsedForChatMock = jest.fn(() => Promise.resolve(true));
jest.mock('../lib/chat-tab-dispatch-utils', () => ({
  persistOrgMemoryUsedForChat: (...args: unknown[]): Promise<boolean> =>
    persistOrgMemoryUsedForChatMock(...args),
}));

const sendMessageMock = jest.fn();
const setPlanModeMock = jest.fn(() => Promise.resolve());
const setApprovalModeMock = jest.fn(() => Promise.resolve());
const getProviderSessionIdMock = jest.fn<string | undefined, []>();
const makeMockSessionForEventHandler = (
  onEvent: (data: unknown) => void,
): MockAgentSession => ({
  sendMessage: sendMessageMock,
  setPlanMode: setPlanModeMock,
  setApprovalMode: setApprovalModeMock,
  getProviderSessionId: getProviderSessionIdMock,
  __onEvent: onEvent,
});
const getOrCreateSessionMock = jest.fn(
  (
    ...args: [
      unknown,
      (data: unknown) => void,
      (() => unknown)?,
      MockSessionLifecycle?,
    ]
  ): MockAgentSession => makeMockSessionForEventHandler(args[1]),
);
const getSessionCodeGraphToolsAdvertisedMock = jest.fn<
  boolean | undefined,
  [string, string, string]
>();
const getSessionGlobalInstructionsSnapshotMock = jest.fn<
  string | undefined,
  [string, string, string]
>();
const getSessionProviderTypeMock = jest.fn<
  'claude' | 'codex' | 'cursor' | undefined,
  []
>(() => (cancellationSession ? 'codex' : undefined));
const canReuseSessionMock = jest.fn<Promise<boolean>, [unknown]>(() =>
  Promise.resolve(true),
);
const canPreserveSessionCapabilitySnapshotMock = jest.fn<
  Promise<boolean>,
  [unknown]
>(() => Promise.resolve(true));
const releaseSessionTurnPreparationMock = jest.fn();
const beginSessionTurnPreparationMock = jest.fn<() => void, [string]>(
  () => releaseSessionTurnPreparationMock,
);
const releaseSessionTurnPreparationOnActivationMock = jest.fn<
  void,
  [string, () => void]
>();

jest.mock('../agents/session-manager', () => ({
  subscribeGlobalPluginDefaultsRevision: jest.fn(() => jest.fn()),
  getGlobalPluginDefaultsRevision: jest.fn(() => 0),
  getSessionGlobalPluginDefaultsRevision: jest.fn(() => undefined),
  getSessionPluginSelections: jest.fn(() => undefined),
  suppressCodexAuthenticationRecovery: jest.fn(),
  getSession: (): typeof cancellationSession => cancellationSession,
  getSessionProviderType: (): 'claude' | 'codex' | 'cursor' | undefined =>
    getSessionProviderTypeMock(),
  drainChatSessionEvents: (): Promise<void> => drainChatSessionEventsMock(),
  getOrCreateSession: (
    ...args: [
      unknown,
      (data: unknown) => void,
      (() => unknown)?,
      MockSessionLifecycle?,
    ]
  ): MockAgentSession => getOrCreateSessionMock(...args),
  buildSessionKey: (
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): string => `${projectId}/${worktreeId}/${chatId}`,
  beginSessionTurnPreparation: (key: string): (() => void) =>
    beginSessionTurnPreparationMock(key),
  releaseSessionTurnPreparationOnActivation: (
    key: string,
    release: () => void,
  ): void => releaseSessionTurnPreparationOnActivationMock(key, release),
  getActiveSessionInfos: (): unknown[] => [],
  canReuseSession: (options: unknown): Promise<boolean> =>
    canReuseSessionMock(options),
  canPreserveSessionCapabilitySnapshot: (options: unknown): Promise<boolean> =>
    canPreserveSessionCapabilitySnapshotMock(options),
  getSessionCodeGraphToolsAdvertised: (
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): boolean | undefined =>
    getSessionCodeGraphToolsAdvertisedMock(projectId, worktreeId, chatId),
  getSessionGlobalInstructionsSnapshot: (
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): string | undefined =>
    getSessionGlobalInstructionsSnapshotMock(projectId, worktreeId, chatId),
  isAgentContinuationEvent: (data: unknown): boolean => {
    if (typeof data !== 'object' || data === null || !('type' in data)) {
      return false;
    }
    if (data.type === 'assistant' || data.type === 'user') return true;
    if (
      data.type !== 'codex' ||
      !('event' in data) ||
      typeof data.event !== 'object' ||
      data.event === null ||
      !('type' in data.event)
    ) {
      return false;
    }
    return [
      'turn.started',
      'item.started',
      'item.updated',
      'item.completed',
      'item.plan.delta',
    ].includes(typeof data.event.type === 'string' ? data.event.type : '');
  },
  destroySession: (): Promise<void> => Promise.resolve(),
  shouldRecreateSessionOnNextTurn: (): boolean => false,
  isSessionAiCreditsRouted: (): boolean => false,
  isSessionAccountProxyRouted: (): boolean => false,
}));

const generateAndRenameBranchMock = jest.fn(() => Promise.resolve({}));
jest.mock('../lib/branch-namer', () => ({
  generateAndRenameBranch: (...args: unknown[]): Promise<unknown> =>
    generateAndRenameBranchMock(...args),
}));

const pairPendingAuthFailuresMock = jest.fn<unknown[], [unknown, string]>(
  () => [],
);
jest.mock('../lib/auth-failure-event', () => ({
  pairPendingAuthFailuresWithTool: (
    event: unknown,
    routeOwnerId: string,
  ): unknown[] => pairPendingAuthFailuresMock(event, routeOwnerId),
}));

const stopTurnForAuthFailureMock = jest.fn<
  Promise<{ stopped: boolean; autoResumeSafe: boolean; notified: boolean }>,
  [Record<string, unknown>]
>(() =>
  Promise.resolve({ stopped: true, autoResumeSafe: false, notified: false }),
);
jest.mock('../lib/auth-failure-turn-stop', () => ({
  stopTurnForAuthFailure: (
    input: Record<string, unknown>,
  ): Promise<{
    stopped: boolean;
    autoResumeSafe: boolean;
    notified: boolean;
  }> => stopTurnForAuthFailureMock(input),
  clearPendingAuthResume: (): void => undefined,
}));

const mockIsCoworkWorkspace = jest.fn((id: string) => id === 'cowork-default');

jest.mock('../lib/workspace-registry', () => ({
  isCoworkWorkspace: (id: string): boolean => mockIsCoworkWorkspace(id),
  isWorkEntryWorkspace: (id: string): boolean =>
    id === 'app-advisor' || mockIsCoworkWorkspace(id),
  getWorkspaceType: (): null => null,
}));

jest.mock('../lib/chat-turn-audit', () => ({
  getDiagnosticEventMetadata: (): Record<string, never> => ({}),
  getChatTurnAuditStatus: jest.requireActual<typeof ChatTurnAuditModule>(
    '../lib/chat-turn-audit',
  ).getChatTurnAuditStatus,
  isAgentContinuationEvent: (data: unknown): boolean => {
    if (typeof data !== 'object' || data === null || !('type' in data)) {
      return false;
    }
    return ['assistant', 'user', 'codex'].includes(String(data.type));
  },
  isCodexSubagentFollowupEvent: jest.requireActual<typeof ChatTurnAuditModule>(
    '../lib/chat-turn-audit',
  ).isCodexSubagentFollowupEvent,
  isStaleCodexRootErrorEvent: jest.requireActual<typeof ChatTurnAuditModule>(
    '../lib/chat-turn-audit',
  ).isStaleCodexRootErrorEvent,
  readCodexRootTurnId: jest.requireActual<typeof ChatTurnAuditModule>(
    '../lib/chat-turn-audit',
  ).readCodexRootTurnId,
  isRecord: (value: unknown): boolean =>
    typeof value === 'object' && value !== null,
  readCodexRootThreadId: (data: unknown): string | undefined => {
    if (
      typeof data !== 'object' ||
      data === null ||
      !('type' in data) ||
      !('subtype' in data) ||
      !('session_id' in data)
    ) {
      return undefined;
    }
    return data.type === 'system' &&
      data.subtype === 'init' &&
      typeof data.session_id === 'string'
      ? data.session_id
      : undefined;
  },
  isRootTerminalChatEventData: jest.requireActual<typeof ChatTurnAuditModule>(
    '../lib/chat-turn-audit',
  ).isRootTerminalChatEventData,
  isTerminalChatEventData: (data: unknown): boolean =>
    typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    data.type === 'result',
}));
const mockResolveWorktreeCwd = jest.fn(() => '/mock/cowork-home');
const mockResolveWorktreeTargetIds = jest.fn(
  (projectId: string, worktreeId: string) => ({ projectId, worktreeId }),
);
const mockReadPersistedWorktreeBranch = jest.fn<
  Promise<{ worktreeId: string; branchName: string } | null>,
  [string, string]
>(() => Promise.resolve(null));
const mockDoesBranchMatchWorktreeId = jest.fn<
  Promise<{ matches: boolean }>,
  []
>(() => Promise.resolve({ matches: false }));

jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: (...args: unknown[]): string =>
    mockResolveWorktreeCwd(...args),
  resolveWorktreeTargetIds: (projectId: string, worktreeId: string): unknown =>
    mockResolveWorktreeTargetIds(projectId, worktreeId),
  readPersistedWorktreeBranch: (
    projectId: string,
    worktreeId: string,
  ): Promise<{ worktreeId: string; branchName: string } | null> =>
    mockReadPersistedWorktreeBranch(projectId, worktreeId),
  isBranchPromptSent: (): Promise<boolean> => Promise.resolve(true),
  doesBranchMatchWorktreeId: (): Promise<{ matches: boolean }> =>
    mockDoesBranchMatchWorktreeId(),
}));

jest.mock('../lib/worktree-repair', () => ({
  recordWorktreeDiscovery: (): Promise<unknown> =>
    Promise.resolve({ status: 'unchanged', worktree: null }),
}));

const sendToWindowMock = jest.fn<void, unknown[]>();
const sendToWindowDetailedMock = jest.fn<
  { delivered: boolean },
  [unknown, string, unknown]
>(() => ({ delivered: true }));
jest.mock('../lib/window-send', () => ({
  sendToWindow: (...args: unknown[]): void => {
    sendToWindowMock(...args);
  },
  sendToWindowDetailed: (
    window: unknown,
    channel: string,
    payload: unknown,
  ): { delivered: boolean } =>
    sendToWindowDetailedMock(window, channel, payload),
}));

const scheduleSummaryGenerationMock = jest.fn();
jest.mock('../lib/worktree-summary-scheduler', () => ({
  scheduleSummaryGeneration: (...args: unknown[]): void => {
    scheduleSummaryGenerationMock(...args);
  },
}));

const captureTurnStartMock = jest.fn(() => Promise.resolve());
const captureTurnEndAndDiffMock = jest.fn<Promise<unknown>, unknown[]>(() =>
  Promise.resolve(null),
);
jest.mock('../lib/turn-diff-capture', () => ({
  captureTurnStart: (...args: unknown[]): Promise<void> =>
    captureTurnStartMock(...args),
  captureTurnEndAndDiff: (...args: unknown[]): Promise<unknown> =>
    captureTurnEndAndDiffMock(...args),
}));

const scheduleCodeGraphBuildMock = jest.fn();
jest.mock('../lib/code-graph-scheduler', () => ({
  scheduleCodeGraphBuild: (...args: unknown[]): void => {
    scheduleCodeGraphBuildMock(...args);
  },
}));

interface MockSubmittedMessageOptions {
  text: string;
  attachmentBaseDir?: string;
}

const buildSubmittedMessageTextMock = jest.fn(
  (options: MockSubmittedMessageOptions) => options.text,
);
const prependPendingSystemInstructionsMock = jest.fn(
  jest.requireActual<typeof ChatSubmittedMessageModule>(
    '../lib/chat-submitted-message',
  ).prependPendingSystemInstructions,
);
jest.mock('../lib/chat-submitted-message', () => ({
  buildSubmittedMessageText: (options: MockSubmittedMessageOptions): string =>
    buildSubmittedMessageTextMock(options),
  prependPendingSystemInstructions: (
    text: string,
    instructions: PendingSystemInstruction[] | undefined,
  ): string => prependPendingSystemInstructionsMock(text, instructions),
}));

const resolveActivePlanSystemInstructionMock = jest.fn<
  Promise<PendingSystemInstruction | null>,
  [Record<string, unknown>]
>(() => Promise.resolve(null));
jest.mock('../lib/active-plan-instruction', () => ({
  resolveActivePlanSystemInstruction: (
    options: Record<string, unknown>,
  ): Promise<PendingSystemInstruction | null> =>
    resolveActivePlanSystemInstructionMock(options),
  withActivePlanInstruction: (
    instructions: readonly PendingSystemInstruction[] | undefined,
    activePlanInstruction: PendingSystemInstruction | null,
  ): PendingSystemInstruction[] | undefined =>
    activePlanInstruction
      ? [...(instructions ?? []), activePlanInstruction]
      : instructions
        ? [...instructions]
        : undefined,
}));

const mockReadPersistedChatDispatchMetadata = jest.fn<
  Promise<{
    deferredToolsAllowed?: boolean;
    approvalMode?: 'ask' | 'auto' | 'full-access';
    executionHarness?: 'claude' | 'codex';
    model?: string;
  }>,
  []
>(() => Promise.resolve({}));
jest.mock('../lib/chat-tabs-reader', () => ({
  readPersistedChatDispatchMetadata: (): Promise<{
    deferredToolsAllowed?: boolean;
    approvalMode?: 'ask' | 'auto' | 'full-access';
    executionHarness?: 'claude' | 'codex';
    model?: string;
  }> => mockReadPersistedChatDispatchMetadata(),
  readPersistedChatExecutionContext: (): Promise<string | undefined> =>
    Promise.resolve(undefined),
}));

const mockBuildWorktreeInjectedToolPrompt = jest.fn<
  string,
  [provider: 'claude' | 'codex', includeCodeGraphTools?: boolean]
>(() => 'worktree-injected-prompt');
jest.mock('../canopy-tools/prompting', (): unknown => ({
  buildWorktreeInjectedToolPrompt: (
    provider: 'claude' | 'codex',
    includeCodeGraphTools?: boolean,
  ): string =>
    mockBuildWorktreeInjectedToolPrompt(provider, includeCodeGraphTools),
  buildCoworkInjectedToolPrompt: (provider: 'claude' | 'codex'): string =>
    `cowork-injected-prompt:${provider}`,
}));

const mockIsEnabled = jest.fn();
jest.mock('../feature-flags', (): unknown => ({
  getFeatureFlagService: () => ({
    isEnabled: mockIsEnabled,
  }),
}));

const hasGraphMock = jest.fn(() => false);
jest.mock('@canopy/desktop-shared/node/code-graph/service', () => ({
  getCodeGraphWorktreeService: (): { hasGraph: jest.Mock } => ({
    hasGraph: hasGraphMock,
  }),
}));

jest.mock('../lib/chat-event-description', () => ({
  describeChatEventData: (): string => 'event',
}));

jest.mock('../lib/plan-mode-workspace-scope', () => ({
  buildPlanModeWorkspaceScopePrompt: (): Promise<null> => Promise.resolve(null),
}));

/** Registered takeover targets, keyed by the plan-explore sentinel's plan id. */
const mockPlanExploreTargets = new Map<
  string,
  { projectId: string; worktreeId: string }
>();
const getPlanExploreTargetMock = jest.fn<
  Promise<{ projectId: string; worktreeId: string } | null>,
  [string]
>(() => Promise.resolve(null));
jest.mock('../lib/plan-explore-registry', () => ({
  getPlanExploreTarget: (
    planId: string,
  ): Promise<{ projectId: string; worktreeId: string } | null> =>
    getPlanExploreTargetMock(planId),
  getPlanExploreTargetSync: (
    planId: string,
  ): { projectId: string; worktreeId: string } | null =>
    mockPlanExploreTargets.get(planId) ?? null,
}));

const getTrackedPlanMock = jest.fn<
  Promise<{ id: string; title: string } | null>,
  [string, string, string]
>(() => Promise.resolve(null));
jest.mock('../lib/plan-persistence', () => ({
  getTrackedPlan: (
    projectId: string,
    worktreeId: string,
    planId: string,
  ): Promise<{ id: string; title: string } | null> =>
    getTrackedPlanMock(projectId, worktreeId, planId),
}));

const materializePlanFileMock = jest.fn<
  Promise<PlanFileSyncModule.MaterializedPlanFile | null>,
  [
    PlanFileSyncModule.PlanFileRef,
    PlanFileSyncModule.MaterializePlanFileOptions,
  ]
>(() => Promise.resolve(null));

/**
 * A plan-file turn lease as the fake sync service tracks it: like the real
 * service, a newer `beginTurn` with the same key supersedes a live lease, and
 * a superseded or ended lease stays ended.
 */
interface FakePlanTurn {
  readonly turnKey: string;
  readonly scope: PlanFileSyncModule.PlanFileScope;
  live: boolean;
}
const planTurns: FakePlanTurn[] = [];
const endPlanTurnMock = jest.fn<void, [string]>();
const beginPlanTurnMock = jest.fn(
  (
    turnKey: string,
    scope: PlanFileSyncModule.PlanFileScope,
  ): PlanFileSyncModule.PlanTurnLease => {
    for (const turn of planTurns) {
      if (turn.turnKey === turnKey) turn.live = false;
    }
    const turn: FakePlanTurn = { turnKey, scope, live: true };
    planTurns.push(turn);
    return {
      end: (): void => {
        endPlanTurnMock(turnKey);
        turn.live = false;
      },
    };
  },
);
jest.mock('../lib/plan-file-sync', () => {
  // The real key and scope resolution (plan-explore sentinel → registered
  // worktree, no scope for Cowork and assistant sentinels); only the service
  // is faked.
  const actual = jest.requireActual<typeof PlanFileSyncModule>(
    '../lib/plan-file-sync',
  );
  return {
    planChatTurnKey: actual.planChatTurnKey,
    resolvePlanTurnScope: actual.resolvePlanTurnScope,
    getPlanFileSyncService: (): Record<string, jest.Mock> => ({
      materializePlanFile: materializePlanFileMock,
      beginTurn: beginPlanTurnMock,
    }),
  };
});

jest.mock('../services/active-chat-input', () => {
  const actual = jest.requireActual<typeof ActiveChatInputModule>(
    '../services/active-chat-input',
  );
  return {
    ...actual,
    captureCanonicalChatProducerContext: jest.fn(
      (target: { projectId: string; worktreeId: string; chatId: string }) =>
        Promise.resolve({
          address: {
            projectId: target.projectId,
            taskId: target.worktreeId,
            chatId: target.chatId,
          },
          evidence: { sourceOwner: { kind: 'personal' } },
        }),
    ),
  };
});
const handleCanonicalChatTerminalEventMock = jest.fn(() => Promise.resolve());
const handleCanonicalChatStartedEventMock = jest.fn(() => Promise.resolve());
jest.mock('../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: (): Record<string, unknown> => ({
    handleCanonicalChatTerminalEvent: (...args: unknown[]): Promise<void> =>
      handleCanonicalChatTerminalEventMock(...args),
    handleCanonicalChatStartedEvent: (...args: unknown[]): Promise<void> =>
      handleCanonicalChatStartedEventMock(...args),
  }),
}));

const readWorkspaceConfigMock = jest.fn(() =>
  Promise.resolve({
    version: 1,
    type: 'single-repo',
    repoPath: '/mock/repo',
    repos: [],
  }),
);
// Persisted owner authority read by the org-memory owner resolver. Defaults to
// an org-A-owned single repo so memory tests exercise an eligible owner.
const readWorkspaceConfigDetailedMock = jest.fn<
  Promise<{
    config: Record<string, unknown>;
    authority: 'ok' | 'absent' | 'unreadable';
    ownerMalformed: boolean;
  }>,
  [string]
>(() =>
  Promise.resolve({
    config: {
      version: 1,
      type: 'single-repo',
      repoPath: '/mock/repo',
      repos: [],
      owner: { type: 'organization', organizationId: ORG_A },
    },
    authority: 'ok',
    ownerMalformed: false,
  }),
);
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfig: (...args: unknown[]): Promise<unknown> =>
    readWorkspaceConfigMock(...args),
  readWorkspaceConfigDetailed: (workspaceId: string): Promise<unknown> =>
    readWorkspaceConfigDetailedMock(workspaceId),
}));

const generateChatSummaryForProjectMock = jest.fn(
  (): Promise<{
    text: string;
    usage: Record<string, never>;
    fallback?: { reason: string; retryable?: boolean };
  }> => Promise.resolve({ text: 'summary', usage: {} }),
);
jest.mock('../ipc/standalone-chat', () => ({
  generateChatSummaryForProject: (
    ...args: [string, Record<string, unknown>]
  ): Promise<{
    text: string;
    usage: Record<string, never>;
    fallback?: { reason: string; retryable?: boolean };
  }> => generateChatSummaryForProjectMock(...args),
  updateChatMeta: (): Promise<void> => Promise.resolve(),
}));

const startChatTurnMock = jest.fn<void, [Record<string, unknown>]>();
const observeChatEventMock = jest.fn();
const completeChatTurnMock = jest.fn();
const startObservedTaskMock = jest.fn();
const finalizeObservedTaskMock = jest.fn();
jest.mock('../observability', () => ({
  getObservabilityService: (): Record<string, unknown> => ({
    startChatTurn: startChatTurnMock,
    observeChatEvent: observeChatEventMock,
    completeChatTurn: completeChatTurnMock,
    recordInjectedPromptForOpenChatTurn: jest.fn(),
    recordSessionDiagnostic: jest.fn(),
    startObservedTask: startObservedTaskMock,
    finalizeObservedTask: finalizeObservedTaskMock,
  }),
}));

import { getCoworkManagedSubdir } from '@canopy/desktop-shared/node/lib/cowork-managed-dir';
import { RETIRED_PLAN_CHAT_MESSAGE } from '@canopy/desktop-shared/lib/retired-chat-scopes';
import {
  APP_ADVISOR_PROJECT_ID,
  CANOPY_AUTH_FAILURE_EVENT_TYPE,
  CODE_REVIEW_CHAT_PROJECT_ID,
  IPC_CHANNELS,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  initAiGatewayModels,
  initClaudeModels,
  initCodexModels,
  initModelAliases,
} from '@canopy/desktop-shared/types';
import { deferredToolsReloadCoordinator } from '../deferred-tools/reload-coordinator';
import { backgroundHelperQueueTestExports } from '../lib/background-helper-queue';
import type * as MemoryClientModule from '../memory/memory-client';
import * as memoryContextModule from '../memory/memory-context';
import * as chatQueueServiceModule from '../services/chat-queue-service';
import { getStoppedTurnResumeService } from '../services/stopped-turn-resume-service';
import {
  clearLiveApprovalMode,
  setLiveApprovalMode,
} from '../approvals/live-approval-modes';
import {
  clearActiveTurnUserMessageId,
  dispatchWorktreeChatTurn,
  scheduleBranchNaming,
  scheduleChatSummary,
  worktreeChatTurnTestExports,
} from '../lib/worktree-chat-turn';
import { getRoutedSessionPressureSnapshot } from '../agents/session-event-router';

initClaudeModels([
  { id: 'opus[1m]', label: 'Opus 1M' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
]);
initCodexModels([
  { id: 'gpt-5.5', label: 'GPT 5.5' },
  { id: 'gpt-5.6-sol', label: 'GPT 5.6 Sol' },
]);
initModelAliases({
  'claude-sonnet-4-6': 'sonnet',
  'gpt-6-sol': 'gpt-5.5',
});
// A gateway-only model: routable on either harness, so a forced providerType
// stays authoritative for it (round-1 contract).
initAiGatewayModels(
  [
    {
      id: 'gateway-any-harness',
      label: 'Gateway Any Harness',
      recommendedHarness: 'claude',
      contextWindow: 100_000,
      supportsPromptCaching: false,
      supportedThinkingLevels: [],
      toolSchemaProfile: 'standard',
    },
  ],
  [
    {
      modelId: 'gateway-any-harness',
      gatewayId: 'provider/gateway-any-harness',
      recommendedHarness: 'claude',
      gatewayOnly: true,
      contextWindow: 100_000,
      supportsPromptCaching: false,
      supportedThinkingLevels: [],
      toolSchemaProfile: 'standard',
    },
  ],
);

/**
 * Asserts the delivery-ack details of a recorded call carry a numeric
 * clientElapsedMs. Kept as a structural check (rather than an
 * `expect.any(Number)` object property) so the object literal stays free of
 * `any`-typed values under the strict lint rules.
 */
function expectAckClientElapsedMs(callIndex: number): void {
  const details: unknown = ackOrgMemoryDeliveredMock.mock.calls[callIndex]?.[2];
  if (
    typeof details !== 'object' ||
    details === null ||
    !('clientElapsedMs' in details)
  ) {
    throw new Error('expected ack details with clientElapsedMs');
  }
  expect(typeof details.clientElapsedMs).toBe('number');
}

function baseOptions(
  overrides: Partial<Parameters<typeof dispatchWorktreeChatTurn>[0]> = {},
): Parameters<typeof dispatchWorktreeChatTurn>[0] {
  return {
    projectId: 'cowork-default',
    worktreeId: 'home',
    chatId: 'chat-1',
    userMessageId: 'msg-1',
    text: 'Hello cowork',
    planMode: false,
    getWindow: () => null,
    onBeforeChatEvent: (): Promise<void> => Promise.resolve(),
    ...overrides,
  };
}

async function flushSessionEventCommits(): Promise<void> {
  // Drain the queued commit and ordered-delivery microtasks through the
  // event loop, including the extra durability link used by group commit.
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function getMockSession(callIndex: number): MockAgentSession {
  const session = getOrCreateSessionMock.mock.results[callIndex]?.value as
    | MockAgentSession
    | undefined;
  if (!session) {
    throw new Error('Expected getOrCreateSession to have been called');
  }
  return session;
}

beforeEach(() => {
  jest.clearAllMocks();
  composeRepoRulesMock.mockResolvedValue('');
  releaseSessionTurnPreparationMock.mockReset();
  cancellationSession = undefined;
  planTurns.length = 0;
  mockPlanExploreTargets.clear();
  getPlanExploreTargetMock.mockResolvedValue(null);
  getTrackedPlanMock.mockResolvedValue(null);
  materializePlanFileMock.mockResolvedValue(null);
  resolveActivePlanSystemInstructionMock.mockResolvedValue(null);
  isDelegationDeliveryActiveMock.mockReturnValue(false);
  claimDelegationDeliveryMock.mockReturnValue(false);
  resolveManagedDelegationModeMock.mockImplementation(
    (mode) => mode ?? 'explicit-only',
  );
  getOrCreateSessionMock.mockImplementation(
    (
      ...args: [
        unknown,
        (data: unknown) => void,
        (() => unknown)?,
        MockSessionLifecycle?,
      ]
    ): MockAgentSession => makeMockSessionForEventHandler(args[1]),
  );
  backgroundHelperQueueTestExports.reset();
  worktreeChatTurnTestExports.resetCurrentSessionEventHandlers();
  mockIsEnabled.mockReturnValue(true);
  mockBuildWorktreeInjectedToolPrompt.mockReturnValue(
    'worktree-injected-prompt',
  );
  mockResolveWorktreeCwd.mockReturnValue('/mock/cowork-home');
  mockReadPersistedWorktreeBranch.mockResolvedValue(null);
  mockDoesBranchMatchWorktreeId.mockResolvedValue({ matches: false });
  mockIsCoworkWorkspace.mockImplementation(
    (id: string) => id === 'cowork-default',
  );
  reserveChatTurnStartMock.mockResolvedValue({ release: releaseResourceMock });
  hasGraphMock.mockReset();
  hasGraphMock.mockReturnValue(false);
  getSessionCodeGraphToolsAdvertisedMock.mockReset();
  getSessionCodeGraphToolsAdvertisedMock.mockReturnValue(undefined);
  getSessionGlobalInstructionsSnapshotMock.mockReset();
  getSessionGlobalInstructionsSnapshotMock.mockReturnValue(undefined);
  getSessionProviderTypeMock.mockReset();
  getSessionProviderTypeMock.mockImplementation(() =>
    cancellationSession ? 'codex' : undefined,
  );
  canReuseSessionMock.mockReset();
  canReuseSessionMock.mockResolvedValue(true);
  canPreserveSessionCapabilitySnapshotMock.mockReset();
  canPreserveSessionCapabilitySnapshotMock.mockResolvedValue(true);
  mockReadPersistedChatDispatchMetadata.mockResolvedValue({});
  clearLiveApprovalMode('my-project', 'wt-1', 'chat-1');
  readPreferencesFileMock.mockResolvedValue({
    orgMemoryInjectionEnabled: false,
  });
  getInitialChatTitlePromptMock
    .mockReset()
    .mockResolvedValue('Investigate the failing health-check endpoint.');
  commitInitialChatTitleMock.mockReset().mockResolvedValue(true);
  generateChatSummaryForProjectMock.mockResolvedValue({
    text: 'summary',
    usage: {},
  });
  fetchOrgMemoryAttemptMock.mockResolvedValue({
    result: null,
    factCount: 0,
    responseReceived: true,
  });
  isOrganizationTeamsLapsedMock.mockImplementation(() =>
    Promise.resolve(false),
  );
  readWorkspaceConfigDetailedMock.mockResolvedValue({
    config: {
      version: 1,
      type: 'single-repo',
      repoPath: '/mock/repo',
      repos: [],
      owner: { type: 'organization', organizationId: ORG_A },
    },
    authority: 'ok',
    ownerMalformed: false,
  });
});

describe('scheduleChatSummary configured model and fallback handling', () => {
  beforeEach(() => {
    readPreferencesFileMock.mockResolvedValue({
      summaryModel: 'claude-haiku-4-5-20251001',
      summaryThinkingLevel: 'off',
      providerModelConfigDefaults: {},
    });
  });
  async function flushBackgroundSummary(): Promise<void> {
    for (let index = 0; index < 60; index += 1) {
      await Promise.resolve();
    }
  }

  const titleOptions = {
    projectId: 'my-project',
    worktreeId: 'wt-1',
    chatId: 'chat-1',
    cwd: '/mock/repo',
    getWindow: (): null => null,
  };

  it('skips authoritative settled or missing chats before preferences and observation', async () => {
    getInitialChatTitlePromptMock.mockResolvedValue(null);
    scheduleChatSummary(titleOptions);
    await flushBackgroundSummary();
    expect(readPreferencesFileMock).not.toHaveBeenCalled();
    expect(startObservedTaskMock).not.toHaveBeenCalled();
    expect(generateChatSummaryForProjectMock).not.toHaveBeenCalled();
  });

  it('coalesces duplicate queued requests and uses the canonical first prompt', async () => {
    scheduleChatSummary(titleOptions);
    scheduleChatSummary(titleOptions);
    await flushBackgroundSummary();
    expect(generateChatSummaryForProjectMock).toHaveBeenCalledTimes(1);
    expect(generateChatSummaryForProjectMock.mock.calls[0]?.[0]).toBe(
      'Investigate the failing health-check endpoint.',
    );
  });

  it('does not project a result rejected by the canonical rename guard', async () => {
    const persistDescription = jest.fn();
    commitInitialChatTitleMock.mockResolvedValue(false);
    scheduleChatSummary({ ...titleOptions, persistDescription });
    await flushBackgroundSummary();
    expect(persistDescription).not.toHaveBeenCalled();
    expect(sendToWindowMock).not.toHaveBeenCalled();
    expect(finalizeObservedTaskMock).toHaveBeenCalledWith(
      expect.any(String),
      'cancelled',
      'Initial chat title no longer eligible.',
      {},
    );
  });

  it('releases a failed persistence claim and retries the same first prompt', async () => {
    commitInitialChatTitleMock.mockRejectedValueOnce(new Error('disk full'));
    scheduleChatSummary(titleOptions);
    await flushBackgroundSummary();
    scheduleChatSummary(titleOptions);
    await flushBackgroundSummary();
    expect(generateChatSummaryForProjectMock).toHaveBeenCalledTimes(2);
    expect(
      generateChatSummaryForProjectMock.mock.calls.map((call) => call[0]),
    ).toEqual([
      'Investigate the failing health-check endpoint.',
      'Investigate the failing health-check endpoint.',
    ]);
  });

  it('fails closed on lookup errors and releases the claim for a later invocation', async () => {
    getInitialChatTitlePromptMock.mockRejectedValueOnce(
      new Error('unreadable'),
    );
    scheduleChatSummary(titleOptions);
    await flushBackgroundSummary();
    expect(generateChatSummaryForProjectMock).not.toHaveBeenCalled();
    scheduleChatSummary(titleOptions);
    await flushBackgroundSummary();
    expect(generateChatSummaryForProjectMock).toHaveBeenCalledTimes(1);
  });

  it('rechecks eligibility when queued work starts', async () => {
    getInitialChatTitlePromptMock
      .mockResolvedValueOnce('First prompt')
      .mockResolvedValueOnce(null);
    scheduleChatSummary(titleOptions);
    await flushBackgroundSummary();
    expect(generateChatSummaryForProjectMock).not.toHaveBeenCalled();
    expect(readPreferencesFileMock).not.toHaveBeenCalled();
  });

  it('coalesces running work but lets different chats proceed independently', async () => {
    let finish:
      | ((result: { text: string; usage: Record<string, never> }) => void)
      | undefined;
    generateChatSummaryForProjectMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    scheduleChatSummary(titleOptions);
    await flushBackgroundSummary();
    scheduleChatSummary(titleOptions);
    scheduleChatSummary({ ...titleOptions, chatId: 'chat-2' });
    await flushBackgroundSummary();
    expect(generateChatSummaryForProjectMock).toHaveBeenCalledTimes(1);
    if (!finish) throw new Error('Generation did not start');
    finish({ text: 'First title', usage: {} });
    await flushBackgroundSummary();
    expect(generateChatSummaryForProjectMock).toHaveBeenCalledTimes(2);
  });

  it('finalizes generation errors and releases the in-flight claim', async () => {
    generateChatSummaryForProjectMock.mockRejectedValueOnce(
      new Error('offline'),
    );
    scheduleChatSummary(titleOptions);
    await flushBackgroundSummary();
    expect(finalizeObservedTaskMock).toHaveBeenCalledWith(
      expect.any(String),
      'failure',
      'offline',
    );
    scheduleChatSummary(titleOptions);
    await flushBackgroundSummary();
    expect(generateChatSummaryForProjectMock).toHaveBeenCalledTimes(2);
  });

  it('does not regenerate after canonical commitment when the projection fails', async () => {
    commitInitialChatTitleMock.mockImplementationOnce((): Promise<boolean> => {
      getInitialChatTitlePromptMock.mockResolvedValue(null);
      return Promise.resolve(true);
    });
    const persistDescription = jest.fn(() =>
      Promise.reject(new Error('projection failed')),
    );
    scheduleChatSummary({ ...titleOptions, persistDescription });
    await flushBackgroundSummary();
    scheduleChatSummary(titleOptions);
    await flushBackgroundSummary();
    expect(generateChatSummaryForProjectMock).toHaveBeenCalledTimes(1);
    // The committed title still reaches the renderer.
    expect(sendToWindowMock).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.chatTabDescriptionUpdated,
      expect.objectContaining({ chatId: 'chat-1', description: 'summary' }),
    );
    expect(finalizeObservedTaskMock).toHaveBeenCalledWith(
      expect.any(String),
      'failure',
      'projection failed',
      {},
    );
  });

  it('reaches initial naming on an ordinary resumed session', async () => {
    await dispatchWorktreeChatTurn({
      ...baseOptions({ projectId: 'my-project', worktreeId: 'wt-1' }),
      sdkSessionId: 'resumed-session',
    });
    await flushBackgroundSummary();
    expect(generateChatSummaryForProjectMock).toHaveBeenCalledTimes(1);
    expect(generateChatSummaryForProjectMock.mock.calls[0]?.[0]).toBe(
      'Investigate the failing health-check endpoint.',
    );
  });

  it('uses the configured summary model even when it equals the default seed', async () => {
    readPreferencesFileMock.mockResolvedValue({
      summaryModel: 'claude-haiku-4-5-20251001',
      summaryModelSetByUser: true,
      summaryThinkingLevel: 'off',
      providerModelConfigDefaults: {},
      defaultWorktreeProvider: 'codex',
      defaultWorktreeModelByProvider: {
        claude: {
          model: 'claude-haiku-4-5-20251001',
          thinkingLevel: 'off',
        },
        codex: { model: 'gpt-5.6-sol', thinkingLevel: 'high' },
      },
    });
    scheduleChatSummary({
      projectId: 'my-project',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      cwd: '/mock/repo',
      getWindow: () => null,
    });
    await flushBackgroundSummary();

    expect(generateChatSummaryForProjectMock).toHaveBeenCalledWith(
      'Investigate the failing health-check endpoint.',
      expect.objectContaining({
        model: 'claude-haiku-4-5-20251001',
        projectId: 'my-project',
      }),
    );
  });

  it('passes the bound chat owner to queued metadata helpers', async () => {
    readPreferencesFileMock.mockResolvedValue({
      summaryModel: 'claude-haiku-4-5-20251001',
      summaryThinkingLevel: 'off',
      branchNamingModel: 'claude-haiku-4-5-20251001',
      branchNamingThinkingLevel: 'off',
      providerModelConfigDefaults: {},
    });
    mockDoesBranchMatchWorktreeId.mockResolvedValue({ matches: true });
    const workOwner = Promise.resolve({
      kind: 'organization' as const,
      organizationId: '123e4567-e89b-12d3-a456-426614174000',
    });
    const base = {
      projectId: 'linked-personal-project',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      text: 'Review the linked project.',
      cwd: '/mock/repo',
      workOwner,
    };

    scheduleChatSummary({ ...base, getWindow: () => null });
    scheduleBranchNaming(base);
    await flushBackgroundSummary();

    expect(generateChatSummaryForProjectMock).toHaveBeenCalledWith(
      'Investigate the failing health-check endpoint.',
      expect.objectContaining({
        projectId: base.projectId,
        workOwner: await workOwner,
      }),
    );
    expect(generateAndRenameBranchMock).toHaveBeenCalledWith(
      expect.objectContaining({ workOwner: await workOwner }),
    );
  });

  it('preserves an explicitly missing chat owner for queued metadata helpers', async () => {
    readPreferencesFileMock.mockResolvedValue({
      summaryModel: 'claude-haiku-4-5-20251001',
      summaryThinkingLevel: 'off',
      branchNamingModel: 'claude-haiku-4-5-20251001',
      branchNamingThinkingLevel: 'off',
      providerModelConfigDefaults: {},
    });
    mockDoesBranchMatchWorktreeId.mockResolvedValue({ matches: true });
    const base = {
      projectId: 'linked-personal-project',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      text: 'Review the linked project.',
      cwd: '/mock/repo',
      workOwner: Promise.resolve(undefined),
    };

    scheduleChatSummary({ ...base, getWindow: () => null });
    scheduleBranchNaming(base);
    await flushBackgroundSummary();

    expect(generateChatSummaryForProjectMock.mock.calls[0]?.[1]).toHaveProperty(
      'workOwner',
      null,
    );
    expect(generateAndRenameBranchMock.mock.calls[0]?.[0]).toHaveProperty(
      'workOwner',
      null,
    );
  });

  it('passes the window to branch naming for the rename event', async () => {
    readPreferencesFileMock.mockResolvedValue({
      branchNamingModel: 'claude-haiku-4-5-20251001',
      branchNamingThinkingLevel: 'off',
      providerModelConfigDefaults: {},
    });
    mockDoesBranchMatchWorktreeId.mockResolvedValue({ matches: true });
    const getWindow = (): null => null;

    scheduleBranchNaming({
      projectId: 'my-project',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      text: 'Add billing metrics.',
      cwd: '/mock/repo',
      getWindow,
    });
    await flushBackgroundSummary();

    expect(generateAndRenameBranchMock.mock.calls[0]?.[0]).toHaveProperty(
      'getWindow',
      getWindow,
    );
  });

  it('uses the persisted summary model even when it equals the default seed', async () => {
    readPreferencesFileMock.mockResolvedValue({
      summaryModel: 'claude-haiku-4-5-20251001',
      summaryModelSetByUser: false,
      summaryThinkingLevel: 'off',
      providerModelConfigDefaults: {},
      defaultWorktreeProvider: 'codex',
      defaultWorktreeModelByProvider: {
        claude: {
          model: 'claude-haiku-4-5-20251001',
          thinkingLevel: 'off',
        },
        codex: { model: 'gpt-5.6-sol', thinkingLevel: 'high' },
      },
    });
    scheduleChatSummary({
      projectId: 'my-project',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      cwd: '/mock/repo',
      getWindow: () => null,
    });
    await flushBackgroundSummary();

    expect(generateChatSummaryForProjectMock).toHaveBeenCalledWith(
      'Investigate the failing health-check endpoint.',
      expect.objectContaining({ model: 'claude-haiku-4-5-20251001' }),
    );
  });

  it.each([
    {
      name: 'standalone',
      projectId: 'standalone-chat',
      standaloneChatProjectId: 'standalone-project',
    },
    {
      name: 'cowork',
      projectId: 'cowork-default',
      standaloneChatProjectId: undefined,
    },
  ])(
    'uses the persisted summary model for $name summaries',
    async ({ projectId, standaloneChatProjectId }) => {
      readPreferencesFileMock.mockResolvedValue({
        summaryModel: 'claude-haiku-4-5-20251001',
        summaryModelSetByUser: false,
        summaryThinkingLevel: 'off',
        providerModelConfigDefaults: {},
      });

      scheduleChatSummary({
        projectId,
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        cwd: '/mock/repo',
        getWindow: () => null,
        ...(standaloneChatProjectId ? { standaloneChatProjectId } : {}),
      });
      await flushBackgroundSummary();

      expect(generateChatSummaryForProjectMock).toHaveBeenCalledWith(
        'Investigate the failing health-check endpoint.',
        expect.objectContaining({ model: 'claude-haiku-4-5-20251001' }),
      );
    },
  );

  it('stops requesting a title after repeated failed canonical writes', async () => {
    const options = { ...titleOptions, chatId: 'chat-store-failing' };
    commitInitialChatTitleMock.mockRejectedValue(new Error('disk full'));
    for (let attempt = 0; attempt < 4; attempt += 1) {
      scheduleChatSummary(options);
      await flushBackgroundSummary();
    }
    // Three failed writes cap the model calls for this app session.
    expect(generateChatSummaryForProjectMock).toHaveBeenCalledTimes(3);
    expect(commitInitialChatTitleMock).toHaveBeenCalledTimes(3);
  });

  it('retries a thrown provider error before saving its fallback', async () => {
    const options = { ...titleOptions, chatId: 'chat-retryable' };
    generateChatSummaryForProjectMock.mockResolvedValue({
      text: 'Investigate the failing health-check',
      usage: {},
      fallback: { reason: 'offline', retryable: true },
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      scheduleChatSummary(options);
      await flushBackgroundSummary();
    }
    // Naming stays pending, so later turns retry.
    expect(generateChatSummaryForProjectMock).toHaveBeenCalledTimes(2);
    expect(commitInitialChatTitleMock).not.toHaveBeenCalled();
    expect(finalizeObservedTaskMock).toHaveBeenLastCalledWith(
      expect.stringMatching(/^helper:chat-summary:/),
      'failure',
      'offline',
      {},
    );

    scheduleChatSummary(options);
    await flushBackgroundSummary();
    expect(commitInitialChatTitleMock).toHaveBeenCalledWith(
      { projectId: 'my-project', worktreeId: 'wt-1' },
      'chat-retryable',
      'Investigate the failing health-check',
    );
  });

  it('persists fallback text but finalizes the observed task as failed', async () => {
    readPreferencesFileMock.mockResolvedValue({
      summaryModel: 'claude-haiku-4-5-20251001',
      summaryThinkingLevel: 'off',
      providerModelConfigDefaults: {},
    });
    generateChatSummaryForProjectMock.mockResolvedValue({
      text: 'Investigate the failing health-check endpoint.',
      usage: {},
      fallback: { reason: 'Provider rejected the summary request.' },
    });

    scheduleChatSummary({
      projectId: 'my-project',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      cwd: '/mock/repo',
      getWindow: () => null,
    });
    await flushBackgroundSummary();

    expect(commitInitialChatTitleMock).toHaveBeenCalledWith(
      { projectId: 'my-project', worktreeId: 'wt-1' },
      'chat-1',
      'Investigate the failing health-check endpoint.',
    );
    expect(finalizeObservedTaskMock).toHaveBeenCalledWith(
      expect.stringMatching(/^helper:chat-summary:/),
      'failure',
      'Provider rejected the summary request.',
      {},
    );
  });
});

afterEach(() => {
  clearLiveApprovalMode('my-project', 'wt-1', 'chat-1');
  backgroundHelperQueueTestExports.reset();
  worktreeChatTurnTestExports.resetCurrentSessionEventHandlers();
});

describe('dispatchWorktreeChatTurn acceptance callback', () => {
  it('rejects a delegated continuation whose live owner was revoked during dispatch preparation', async () => {
    await expect(
      dispatchWorktreeChatTurn({
        ...baseOptions(),
        managedDelegationDeliveryId: 'msg-1',
      }),
    ).rejects.toThrow('Delegation completion owner is no longer active');
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('refuses a turn for a retired plan chat before any session work', async () => {
    await expect(
      dispatchWorktreeChatTurn(
        baseOptions({
          projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
          worktreeId: 'plan-1',
        }),
      ),
    ).rejects.toThrow(RETIRED_PLAN_CHAT_MESSAGE);

    expect(getOrCreateSessionMock).not.toHaveBeenCalled();
    expect(startChatTurnMock).not.toHaveBeenCalled();
    expect(beginPlanTurnMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('holds the session from before it is created until its prompt is handed off', async () => {
    const order: string[] = [];
    beginSessionTurnPreparationMock.mockImplementationOnce((key) => {
      order.push(`hold:${key}`);
      return releaseSessionTurnPreparationMock;
    });
    getOrCreateSessionMock.mockImplementationOnce(
      (...args): MockAgentSession => {
        order.push('acquire');
        return makeMockSessionForEventHandler(args[1]);
      },
    );
    releaseSessionTurnPreparationMock.mockImplementation(() => {
      order.push('release');
    });
    startChatTurnMock.mockImplementationOnce(() => {
      order.push('audit-start');
    });
    sendMessageMock.mockImplementationOnce(() => {
      order.push('send');
    });
    releaseSessionTurnPreparationOnActivationMock.mockImplementationOnce(
      (key, release) => {
        order.push(`hand-off:${key}`);
        expect(release).toBe(releaseSessionTurnPreparationMock);
      },
    );
    const options = baseOptions();
    const key = `${options.projectId}/${options.worktreeId}/${options.chatId}`;

    await dispatchWorktreeChatTurn(options);

    // The hold now ends only when the provider marks the turn active.
    expect(order).toEqual([
      `hold:${key}`,
      'acquire',
      'audit-start',
      'send',
      `hand-off:${key}`,
    ]);
  });

  it('releases the session hold when preparation fails before sending', async () => {
    setPlanModeMock.mockImplementationOnce(() =>
      Promise.reject(new Error('plan mode failed')),
    );

    await expect(dispatchWorktreeChatTurn(baseOptions())).rejects.toThrow(
      'plan mode failed',
    );

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(beginSessionTurnPreparationMock).toHaveBeenCalledTimes(1);
    expect(releaseSessionTurnPreparationMock).toHaveBeenCalled();
    expect(
      releaseSessionTurnPreparationOnActivationMock,
    ).not.toHaveBeenCalled();
  });

  it('refuses to start without a durable chat-event commit hook', async () => {
    await expect(
      Reflect.apply(dispatchWorktreeChatTurn, undefined, [
        { ...baseOptions(), onBeforeChatEvent: undefined },
      ]),
    ).rejects.toThrow('durable chat-event commit hook');

    expect(getOrCreateSessionMock).not.toHaveBeenCalled();
  });

  it('does not send input stopped before provider session creation, and permits the next send', async () => {
    let finishReservation:
      | ((value: { release: typeof releaseResourceMock }) => void)
      | undefined;
    let reservationStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      reservationStarted = resolve;
    });
    reserveChatTurnStartMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishReservation = resolve;
          reservationStarted?.();
        }),
    );
    const options = baseOptions();
    const dispatch = dispatchWorktreeChatTurn(options);
    await started;
    await cancelChatTurn(options);
    finishReservation?.({ release: releaseResourceMock });
    await dispatch;
    expect(sendMessageMock).not.toHaveBeenCalled();
    await dispatchWorktreeChatTurn(
      baseOptions({ userMessageId: 'next-message' }),
    );
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it('drains terminal provider events after cancelling a live turn', async () => {
    const order: string[] = [];
    cancellationSession = {
      cancel: jest.fn((): Promise<void> => {
        order.push('cancel');
        return Promise.resolve();
      }),
    };
    drainChatSessionEventsMock.mockImplementationOnce(() => {
      order.push('drain');
      return Promise.resolve();
    });

    await cancelChatTurn(baseOptions());

    expect(order).toEqual(['cancel', 'drain']);
  });

  it('does not take a plan-file turn lease when preparation was cancelled', async () => {
    let finishTurnCapture: (() => void) | undefined;
    let turnCaptureStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      turnCaptureStarted = resolve;
    });
    captureTurnStartMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishTurnCapture = resolve;
          turnCaptureStarted?.();
        }),
    );
    const options = baseOptions({
      projectId: 'my-project',
      worktreeId: 'plan-1',
    });

    const dispatch = dispatchWorktreeChatTurn(options);
    await started;
    await cancelChatTurn(options);
    finishTurnCapture?.();
    await dispatch;

    expect(beginPlanTurnMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(completeChatTurnMock).toHaveBeenCalledWith(
      'my-project',
      'plan-1',
      'chat-1',
      'interrupted',
    );
  });

  it('refuses admission when parent Stop arrives during asynchronous preparation', async () => {
    const stop = new AbortController();
    setApprovalModeMock.mockImplementationOnce(async () => {
      await Promise.resolve();
      stop.abort(new Error('Parent stopped during admission'));
    });
    const onTurnAccepted = jest.fn();
    await expect(
      dispatchWorktreeChatTurn(
        baseOptions({
          approvalMode: 'ask',
          admissionSignal: stop.signal,
          onTurnAccepted,
        }),
      ),
    ).rejects.toThrow('Parent stopped during admission');
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(onTurnAccepted).not.toHaveBeenCalled();
  });

  it('runs only after the provider session accepts the message', async () => {
    const order: string[] = [];
    sendMessageMock.mockImplementationOnce(() => {
      order.push('send');
    });

    await dispatchWorktreeChatTurn(
      baseOptions({
        onTurnAccepted: () => {
          order.push('accepted');
        },
      }),
    );

    expect(order).toEqual(['send', 'accepted']);
  });

  it('claims a delegated completion immediately before provider dispatch and releases a rejected send', async () => {
    isDelegationDeliveryActiveMock.mockReturnValue(true);
    claimDelegationDeliveryMock.mockReturnValue(true);
    sendMessageMock.mockImplementationOnce(() => {
      throw new Error('dispatch rejected');
    });

    await expect(
      dispatchWorktreeChatTurn({
        ...baseOptions(),
        managedDelegationDeliveryId: 'msg-1',
      }),
    ).rejects.toThrow('dispatch rejected');

    expect(claimDelegationDeliveryMock).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat-1' }),
      'msg-1',
    );
    expect(releaseDelegationDeliveryMock).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat-1' }),
      'msg-1',
    );
  });

  it('does not run when provider dispatch rejects the message', async () => {
    const onTurnAccepted = jest.fn();
    sendMessageMock.mockImplementationOnce(() => {
      throw new Error('dispatch rejected');
    });

    await expect(
      dispatchWorktreeChatTurn(baseOptions({ onTurnAccepted })),
    ).rejects.toThrow('dispatch rejected');

    expect(onTurnAccepted).not.toHaveBeenCalled();
  });
});

describe('dispatchWorktreeChatTurn stopped-turn resume offers', () => {
  const target = {
    projectId: 'cowork-default',
    worktreeId: 'home',
    chatId: 'chat-1',
  };

  afterEach(() => {
    getStoppedTurnResumeService().resetForTests();
  });

  it('retires a stopped turn offer when any path dispatches a newer turn', async () => {
    // Queue drains, watcher turns, and portal sends all reach this funnel
    // without passing the chat:send-message IPC handler (CAN-3137).
    getStoppedTurnResumeService().offer(target, 'stopped-message');

    await dispatchWorktreeChatTurn(baseOptions({ userMessageId: 'msg-2' }));

    await expect(
      getStoppedTurnResumeService().resume(
        { ...target, userMessageId: 'stopped-message' },
        () => Promise.resolve(),
      ),
    ).resolves.toEqual({ disposition: 'stale' });
  });

  it('keeps the offer for a hidden continuation of the stopped turn itself', async () => {
    getStoppedTurnResumeService().offer(target, 'stopped-message');

    await dispatchWorktreeChatTurn(
      baseOptions({
        userMessageId: 'stopped-message',
        hiddenDeferredContinuation: true,
      }),
    );

    await expect(
      getStoppedTurnResumeService().resume(
        { ...target, userMessageId: 'stopped-message' },
        () => Promise.resolve(),
      ),
    ).resolves.toEqual({ disposition: 'dispatched' });
  });

  it('does not offer resume when the stopped turn used an unpersisted package overlay', async () => {
    const overlayTarget = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'package-overlay-chat',
    };

    await dispatchWorktreeChatTurn(
      baseOptions({
        ...overlayTarget,
        userMessageId: 'packaged-turn',
        packageOverlay: {
          packageDigest: `pp:v1:${'A'.repeat(43)}`,
          resources: [],
        },
      }),
    );
    getStoppedTurnResumeService().offer(overlayTarget, 'packaged-turn');

    await expect(
      getStoppedTurnResumeService().resume(
        { ...overlayTarget, userMessageId: 'packaged-turn' },
        () => Promise.resolve(),
      ),
    ).resolves.toEqual({ disposition: 'stale' });
  });

  it('persists each provider event with the provider that ran the turn', async () => {
    type BeforeChatEvent = Parameters<
      Parameters<typeof dispatchWorktreeChatTurn>[0]['onBeforeChatEvent']
    >[0];
    const beforeEvent = jest.fn<Promise<boolean>, [BeforeChatEvent]>(() =>
      Promise.resolve(true),
    );

    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'project-provider',
        worktreeId: 'worktree-provider',
        chatId: 'chat-provider',
        providerType: 'codex',
        onBeforeChatEvent: beforeEvent,
      }),
    );
    getMockSession(0).__onEvent({
      type: 'assistant',
      message: {
        id: 'provider-output',
        role: 'assistant',
        content: [{ type: 'text', text: 'Output' }],
      },
    });
    await flushSessionEventCommits();

    expect(beforeEvent.mock.calls[0]?.[0].providerType).toBe('codex');
  });

  it('attributes a hook prompt before canonical persistence and delivery', async () => {
    type BeforeChatEvent = Parameters<
      Parameters<typeof dispatchWorktreeChatTurn>[0]['onBeforeChatEvent']
    >[0];
    const beforeEvent = jest.fn<Promise<boolean>, [BeforeChatEvent]>(() =>
      Promise.resolve(true),
    );
    await dispatchWorktreeChatTurn(
      baseOptions({ initiationSource: 'hook', onBeforeChatEvent: beforeEvent }),
    );
    getMockSession(0).__onEvent({
      type: 'canopy_user_prompt',
      original_text: 'Hook request',
      user_message_id: 'message-1',
    });
    await flushSessionEventCommits();
    expect(beforeEvent.mock.calls.at(-1)?.[0].data).toMatchObject({
      canopy_user_message_source: 'hook',
    });
  });

  it('strips a preview screenshot before the commit hook, delivery, and observability see it', async () => {
    type BeforeChatEvent = Parameters<
      Parameters<typeof dispatchWorktreeChatTurn>[0]['onBeforeChatEvent']
    >[0];
    type ChatEvent = Parameters<
      NonNullable<Parameters<typeof dispatchWorktreeChatTurn>[0]['onChatEvent']>
    >[0];
    const beforeEvent = jest.fn<Promise<boolean>, [BeforeChatEvent]>(() =>
      Promise.resolve(true),
    );
    const turnHandler = jest.fn<void, [ChatEvent]>();
    const screenshot = 'PREVIEWSCREENSHOT'.repeat(64);
    const otherImage = 'BROWSERSCREENSHOT'.repeat(64);
    observeChatEventMock.mockClear();

    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'project-preview',
        worktreeId: 'worktree-preview',
        chatId: 'chat-preview',
        onBeforeChatEvent: beforeEvent,
        onChatEvent: turnHandler,
      }),
    );
    const session = getMockSession(0);
    session.__onEvent({
      type: 'assistant',
      message: {
        id: 'preview-call',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu-preview',
            name: 'mcp__canopy__PreviewVisual',
            input: { html: '<p>chart</p>' },
          },
          {
            type: 'tool_use',
            id: 'toolu-browser',
            name: 'mcp__canopy__DispatchAction',
            input: {},
          },
        ],
      },
    });
    session.__onEvent({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu-preview',
            content: [
              { type: 'text', text: 'Preview rendered at 720px.' },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: screenshot,
                },
              },
            ],
          },
          {
            type: 'tool_result',
            tool_use_id: 'toolu-browser',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: otherImage,
                },
              },
            ],
          },
        ],
      },
    });
    await flushSessionEventCommits();

    const seen = JSON.stringify([
      beforeEvent.mock.calls,
      turnHandler.mock.calls,
      observeChatEventMock.mock.calls,
    ]);
    expect(seen).toContain('Preview rendered at 720px.');
    expect(seen).toContain('Preview screenshot,');
    expect(seen).not.toContain(screenshot);
    // Another tool's image is not this tool's to remove.
    expect(seen).toContain(otherImage);
  });

  it('revives canonical delivery and the host queue for a stopped-turn continuation', async () => {
    type BeforeChatEvent = Parameters<
      Parameters<typeof dispatchWorktreeChatTurn>[0]['onBeforeChatEvent']
    >[0];
    const beforeEvent = jest.fn<Promise<boolean>, [BeforeChatEvent]>(() =>
      Promise.resolve(true),
    );
    const turnHandler = jest.fn();
    const queueService = chatQueueServiceModule.getChatQueueService();
    const onTurnRevived = jest
      .spyOn(queueService, 'onTurnRevived')
      .mockReturnValue(true);

    try {
      await dispatchWorktreeChatTurn(
        baseOptions({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          userMessageId: 'stopped-message',
          hiddenDeferredContinuation: true,
          hiddenContinuationKind: 'stopped_turn_resume',
          providerEventSequenceNamespace: 'resume-attempt',
          onBeforeChatEvent: beforeEvent,
          onChatEvent: turnHandler,
        }),
      );

      getMockSession(0).__onEvent({
        type: 'assistant',
        canopy_turn_user_message_id: 'stopped-message',
        message: {
          id: 'resumed-output',
          role: 'assistant',
          content: [{ type: 'text', text: 'Continued output' }],
        },
      });
      await flushSessionEventCommits();

      expect(onTurnRevived).toHaveBeenCalledWith(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
        },
        'stopped-message',
      );
      const persistedEvent = beforeEvent.mock.calls[0]?.[0];
      expect(persistedEvent?.sequenceNamespace).toBe('resume-attempt');
      expect(persistedEvent?.data).toMatchObject({
        canopy_turn_revival: true,
        canopy_turn_user_message_id: 'stopped-message',
      });
      expect(turnHandler).toHaveBeenCalledTimes(1);
    } finally {
      onTurnRevived.mockRestore();
    }
  });

  it('delivers an immediate provider failure for a stopped-turn continuation', async () => {
    type BeforeChatEvent = Parameters<
      Parameters<typeof dispatchWorktreeChatTurn>[0]['onBeforeChatEvent']
    >[0];
    type ChatEvent = Parameters<
      NonNullable<Parameters<typeof dispatchWorktreeChatTurn>[0]['onChatEvent']>
    >[0];
    const beforeEvent = jest.fn<Promise<boolean>, [BeforeChatEvent]>(() =>
      Promise.resolve(true),
    );
    const turnHandler = jest.fn<void, [ChatEvent]>();
    const queueService = chatQueueServiceModule.getChatQueueService();
    const onTurnRevived = jest
      .spyOn(queueService, 'onTurnRevived')
      .mockReturnValue(true);
    const onTurnTerminal = jest
      .spyOn(queueService, 'onTurnTerminal')
      .mockImplementation();

    try {
      await dispatchWorktreeChatTurn(
        baseOptions({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          userMessageId: 'stopped-message',
          hiddenDeferredContinuation: true,
          hiddenContinuationKind: 'stopped_turn_resume',
          providerEventSequenceNamespace: 'resume-attempt',
          onBeforeChatEvent: beforeEvent,
          onChatEvent: turnHandler,
        }),
      );

      getMockSession(0).__onEvent({
        type: 'error',
        error: 'Provider unavailable. Try again.',
        canopy_turn_user_message_id: 'stopped-message',
      });
      await flushSessionEventCommits();

      expect(onTurnRevived).toHaveBeenCalledWith(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
        },
        'stopped-message',
      );
      const persistedEvent = beforeEvent.mock.calls[0]?.[0];
      expect(persistedEvent?.data).toMatchObject({
        type: 'error',
        canopy_turn_revival: true,
        canopy_turn_user_message_id: 'stopped-message',
      });
      const deliveredEvent = turnHandler.mock.calls[0]?.[0];
      expect(deliveredEvent?.data).toMatchObject({
        type: 'error',
        error: 'Provider unavailable. Try again.',
      });
      expect(deliveredEvent?.isTerminalEvent).toBe(true);
      getOrCreateSessionMock.mock.calls[0]?.[3]?.onRemoved?.();
      await flushSessionEventCommits();
      expect(onTurnTerminal).toHaveBeenCalledTimes(1);
    } finally {
      onTurnRevived.mockRestore();
      onTurnTerminal.mockRestore();
    }
  });

  it('settles a resumed turn when its provider session disappears before the first event', async () => {
    const resumeTarget = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
    };
    const resumeService = getStoppedTurnResumeService();
    const terminal = jest
      .spyOn(chatQueueServiceModule.getChatQueueService(), 'onTurnTerminal')
      .mockImplementation();

    try {
      resumeService.offer(resumeTarget, 'stopped-message');
      await expect(
        resumeService.resume(
          { ...resumeTarget, userMessageId: 'stopped-message' },
          async (attemptId, isCurrent) => {
            if (
              !isCurrent() ||
              !resumeService.markDispatchStarted(
                resumeTarget,
                'stopped-message',
                attemptId,
              )
            ) {
              return false;
            }
            await dispatchWorktreeChatTurn(
              baseOptions({
                ...resumeTarget,
                userMessageId: 'stopped-message',
                hiddenDeferredContinuation: true,
                hiddenContinuationKind: 'stopped_turn_resume',
                providerEventSequenceNamespace: attemptId,
              }),
            );
            return true;
          },
        ),
      ).resolves.toEqual({ disposition: 'dispatched' });

      getOrCreateSessionMock.mock.calls[0]?.[3]?.onRemoved?.();
      await flushSessionEventCommits();

      expect(terminal).toHaveBeenCalledWith(
        resumeTarget,
        'cancelled',
        'stopped-message',
      );
      await expect(
        resumeService.resume(
          { ...resumeTarget, userMessageId: 'stopped-message' },
          () => Promise.resolve(),
        ),
      ).resolves.toEqual({ disposition: 'stale' });
    } finally {
      terminal.mockRestore();
    }
  });

  it('does not let removed stopped-session ownership release a resumed turn when a follow-up queues', async () => {
    const resumeTarget = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
    };
    const terminal = jest
      .spyOn(chatQueueServiceModule.getChatQueueService(), 'onTurnTerminal')
      .mockImplementation();
    const beforeEvent = jest.fn(() => Promise.resolve(true));
    let finishResume: (() => void) | undefined;

    try {
      await dispatchWorktreeChatTurn(
        baseOptions({
          ...resumeTarget,
          userMessageId: 'stopped-message',
          onBeforeChatEvent: beforeEvent,
        }),
      );
      const stoppedSession = getMockSession(0);
      const stoppedLifecycle = getOrCreateSessionMock.mock.calls[0]?.[3];
      getStoppedTurnResumeService().offer(resumeTarget, 'stopped-message');
      const resume = getStoppedTurnResumeService().resume(
        { ...resumeTarget, userMessageId: 'stopped-message' },
        () =>
          new Promise<void>((resolve) => {
            finishResume = resolve;
          }),
      );

      finishResume?.();
      await expect(resume).resolves.toEqual({ disposition: 'dispatched' });
      getStoppedTurnResumeService().invalidateForNewTurn(
        resumeTarget,
        'follow-up-message',
      );

      stoppedSession.__onEvent({
        type: 'assistant',
        canopy_turn_user_message_id: 'stopped-message',
        message: 'late stopped-session output',
      });
      stoppedLifecycle?.onRemoved?.();
      await flushSessionEventCommits();

      expect(beforeEvent).not.toHaveBeenCalled();
      expect(terminal).not.toHaveBeenCalled();
    } finally {
      terminal.mockRestore();
    }
  });

  it('drops a stopped-session event whose durable commit overlaps an in-progress resume', async () => {
    const resumeTarget = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
    };
    let releaseCommit: (() => void) | undefined;
    const commitBlocked = new Promise<boolean>((resolve) => {
      releaseCommit = (): void => resolve(true);
    });
    const beforeEvent = jest.fn((): Promise<boolean> => commitBlocked);
    const turnHandler = jest.fn();
    const terminal = jest
      .spyOn(chatQueueServiceModule.getChatQueueService(), 'onTurnTerminal')
      .mockImplementation();
    let finishResume: (() => void) | undefined;

    try {
      await dispatchWorktreeChatTurn(
        baseOptions({
          ...resumeTarget,
          userMessageId: 'stopped-message',
          onBeforeChatEvent: beforeEvent,
          onChatEvent: turnHandler,
        }),
      );
      getMockSession(0).__onEvent({
        type: 'result',
        canopy_turn_user_message_id: 'stopped-message',
        result: 'late stopped-session result',
      });
      await flushSessionEventCommits();
      expect(beforeEvent).toHaveBeenCalledTimes(1);

      getStoppedTurnResumeService().offer(resumeTarget, 'stopped-message');
      const resume = getStoppedTurnResumeService().resume(
        { ...resumeTarget, userMessageId: 'stopped-message' },
        () =>
          new Promise<void>((resolve) => {
            finishResume = resolve;
          }),
      );

      releaseCommit?.();
      await flushSessionEventCommits();

      expect(turnHandler).not.toHaveBeenCalled();
      expect(terminal).not.toHaveBeenCalled();
      finishResume?.();
      await expect(resume).resolves.toEqual({ disposition: 'dispatched' });
    } finally {
      terminal.mockRestore();
    }
  });
});

describe('dispatchWorktreeChatTurn organization memory composition', () => {
  const longText = 'Explain the repository release process in detail.';
  const memoryFact = {
    factText: 'fact',
    validAt: null,
    sourceTurnIds: ['turn-1'],
  };
  // This suite dispatches into an org-owned project instead of the file-wide
  // cowork default; Cowork owner cases live in the owning-organization block.
  function memoryOptions(
    overrides: Partial<Parameters<typeof dispatchWorktreeChatTurn>[0]> = {},
  ): Parameters<typeof dispatchWorktreeChatTurn>[0] {
    return baseOptions({
      projectId: 'org-project',
      worktreeId: 'wt-1',
      ...overrides,
    });
  }

  it('is byte-identical and performs no fetch with an explicit opt-out', async () => {
    await dispatchWorktreeChatTurn(
      memoryOptions({
        text: longText,
        hiddenContext: { kind: 'canopy-watcher-event', text: 'existing' },
      }),
    );

    expect(fetchOrgMemoryAttemptMock).not.toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalledWith(
      `existing\n\n${longText}`,
      expect.objectContaining({ userMessageId: 'msg-1' }),
    );
  });

  it('appends memory after existing hidden context and before visible text', async () => {
    readPreferencesFileMock.mockResolvedValue({
      orgMemoryInjectionEnabled: true,
    });
    fetchOrgMemoryAttemptMock.mockResolvedValue({
      result: {
        organizationExternalId: ORG_A,
        renderedBlock: '<org_memory>fact</org_memory>',
        facts: [memoryFact],
      },
      factCount: 1,
      responseReceived: true,
    });

    await dispatchWorktreeChatTurn(
      memoryOptions({
        text: longText,
        // A human-originated hidden-context kind: watcher-event dispatches
        // intentionally skip the memory fetch (covered below).
        hiddenContext: { kind: 'file-comment-instructions', text: 'existing' },
      }),
    );

    expect(fetchOrgMemoryAttemptMock).toHaveBeenCalledTimes(1);
    expect(fetchOrgMemoryAttemptMock).toHaveBeenCalledWith(
      ORG_A,
      expect.stringContaining(longText),
      false,
      longText,
    );
    expect(sendMessageMock).toHaveBeenCalledWith(
      `existing\n\n<org_memory>fact</org_memory>\n\n${longText}`,
      expect.objectContaining({ userMessageId: 'msg-1' }),
    );
    expect(startChatTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgMemoryBlock: '<org_memory>fact</org_memory>',
      }),
    );
    expect(persistOrgMemoryUsedForChatMock).toHaveBeenCalledWith({
      projectId: 'org-project',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      userMessageId: 'msg-1',
      organizationExternalId: ORG_A,
      facts: [memoryFact],
    });
    // Injected without a searchId: there is no occurrence to acknowledge.
    expect(ackOrgMemoryDeliveredMock).not.toHaveBeenCalled();
    expect(
      sendToWindowDetailedMock.mock.calls.some(
        ([, channel, payload]) =>
          channel === 'chat:event' &&
          typeof payload === 'object' &&
          payload !== null &&
          'data' in payload &&
          typeof payload.data === 'object' &&
          payload.data !== null &&
          'type' in payload.data &&
          payload.data.type === 'org_memory_used',
      ),
    ).toBe(true);
  });

  it('forwards the raw user text trimmed and capped at 2000 chars as the lexical query', async () => {
    readPreferencesFileMock.mockResolvedValue({
      orgMemoryInjectionEnabled: true,
    });
    const rawText = `  ${'x'.repeat(2_100)}  `;

    await dispatchWorktreeChatTurn(memoryOptions({ text: rawText }));

    expect(fetchOrgMemoryAttemptMock).toHaveBeenCalledTimes(1);
    const lexicalArg = fetchOrgMemoryAttemptMock.mock.calls[0]?.[3];
    expect(lexicalArg).toBe('x'.repeat(2_000));
  });

  it('omits a generated worktree branch from the retrieval query', async () => {
    readPreferencesFileMock.mockResolvedValue({
      orgMemoryInjectionEnabled: true,
    });
    mockReadPersistedWorktreeBranch.mockResolvedValue({
      worktreeId: 'alpaca',
      branchName: 'alpaca-1713571200123',
    });

    await dispatchWorktreeChatTurn(
      memoryOptions({
        projectId: 'project-1',
        worktreeId: 'alpaca',
        text: longText,
      }),
    );

    expect(fetchOrgMemoryAttemptMock).toHaveBeenCalledWith(
      ORG_A,
      `repo — ${longText}`,
      false,
      longText,
    );
  });

  it('uses the resolved target id to omit a generated sentinel branch', async () => {
    readPreferencesFileMock.mockResolvedValue({
      orgMemoryInjectionEnabled: true,
    });
    mockReadPersistedWorktreeBranch.mockResolvedValue({
      worktreeId: 'alpaca',
      branchName: 'alpaca-1713571200123',
    });

    await dispatchWorktreeChatTurn(
      memoryOptions({
        projectId: 'plan-explore',
        worktreeId: 'plan-123',
        text: longText,
      }),
    );

    expect(fetchOrgMemoryAttemptMock).toHaveBeenCalledWith(
      ORG_A,
      `repo — ${longText}`,
      false,
      longText,
    );
  });

  it('includes a meaningful branch in the retrieval query', async () => {
    readPreferencesFileMock.mockResolvedValue({
      orgMemoryInjectionEnabled: true,
    });
    mockReadPersistedWorktreeBranch.mockResolvedValue({
      worktreeId: 'alpaca',
      branchName: 'feature/canopy-credits',
    });

    await dispatchWorktreeChatTurn(
      memoryOptions({
        projectId: 'project-1',
        worktreeId: 'alpaca',
        text: longText,
      }),
    );

    expect(fetchOrgMemoryAttemptMock).toHaveBeenCalledWith(
      ORG_A,
      `repo — feature/canopy-credits — ${longText}`,
      false,
      longText,
    );
  });

  it('does not fetch memory for a watcher-event dispatch even when enabled', async () => {
    readPreferencesFileMock.mockResolvedValue({
      orgMemoryInjectionEnabled: true,
    });

    await dispatchWorktreeChatTurn(
      memoryOptions({
        text: longText,
        hiddenContext: { kind: 'canopy-watcher-event', text: 'existing' },
      }),
    );

    expect(fetchOrgMemoryAttemptMock).not.toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalledWith(
      `existing\n\n${longText}`,
      expect.objectContaining({ userMessageId: 'msg-1' }),
    );
  });

  it('does not fetch memory for an automation-initiated dispatch', async () => {
    readPreferencesFileMock.mockResolvedValue({
      orgMemoryInjectionEnabled: true,
    });

    await dispatchWorktreeChatTurn(
      memoryOptions({ text: longText, initiationSource: 'automation' }),
    );

    expect(fetchOrgMemoryAttemptMock).not.toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalledWith(
      longText,
      expect.objectContaining({ userMessageId: 'msg-1' }),
    );
  });

  it('threads the searchId into persisted metadata and the memory-used event', async () => {
    readPreferencesFileMock.mockResolvedValue({
      orgMemoryInjectionEnabled: true,
    });
    fetchOrgMemoryAttemptMock.mockResolvedValue({
      result: {
        organizationExternalId: ORG_A,
        renderedBlock: '<org_memory>fact</org_memory>',
        facts: [memoryFact],
        searchId: 'search-1',
      },
      factCount: 1,
      responseReceived: true,
    });

    await dispatchWorktreeChatTurn(memoryOptions({ text: longText }));

    expect(persistOrgMemoryUsedForChatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        facts: [memoryFact],
        organizationExternalId: ORG_A,
        searchId: 'search-1',
      }),
    );
    expect(ackOrgMemoryDeliveredMock).toHaveBeenCalledTimes(1);
    expect(ackOrgMemoryDeliveredMock).toHaveBeenCalledWith(
      ORG_A,
      'search-1',
      expect.objectContaining({
        outcome: 'delivered',
        clientChatId: 'chat-1',
      }),
    );
    expectAckClientElapsedMs(0);
    const memoryUsedCall = sendToWindowDetailedMock.mock.calls.find(
      ([, channel, payload]) =>
        channel === 'chat:event' &&
        typeof payload === 'object' &&
        payload !== null &&
        'data' in payload &&
        typeof payload.data === 'object' &&
        payload.data !== null &&
        'type' in payload.data &&
        payload.data.type === 'org_memory_used',
    );
    expect(memoryUsedCall?.[2]).toMatchObject({
      data: { searchId: 'search-1', organizationExternalId: ORG_A },
    });
  });

  it('keeps submitted text byte-identical when an enabled fetch returns null', async () => {
    readPreferencesFileMock.mockResolvedValue({
      orgMemoryInjectionEnabled: true,
    });

    await dispatchWorktreeChatTurn(
      memoryOptions({
        text: longText,
        hiddenContext: { kind: 'canopy-watcher-event', text: 'existing' },
      }),
    );

    expect(sendMessageMock).toHaveBeenCalledWith(
      `existing\n\n${longText}`,
      expect.objectContaining({ userMessageId: 'msg-1' }),
    );
    expect(persistOrgMemoryUsedForChatMock).not.toHaveBeenCalled();
    // No facts were injected, so no delivery ack fires either.
    expect(ackOrgMemoryDeliveredMock).not.toHaveBeenCalled();
  });

  it('still injects a fetch that only settles after session setup', async () => {
    readPreferencesFileMock.mockResolvedValue({
      orgMemoryInjectionEnabled: true,
    });
    // The fetch is deliberately held open until the provider session has been
    // created, so it can only be injected if the turn settles the memory race
    // after setup rather than ahead of it.
    let releaseFetch = (): void => {};
    const sessionCreated = new Promise<void>((resolve) => {
      getOrCreateSessionMock.mockImplementation(
        (
          ...args: [
            unknown,
            (data: unknown) => void,
            (() => unknown)?,
            MockSessionLifecycle?,
          ]
        ): MockAgentSession => {
          resolve();
          return makeMockSessionForEventHandler(args[1]);
        },
      );
    });
    fetchOrgMemoryAttemptMock.mockReturnValue(
      new Promise((resolve) => {
        releaseFetch = (): void => {
          resolve({
            result: {
              organizationExternalId: ORG_A,
              renderedBlock: '<org_memory>fact</org_memory>',
              facts: [memoryFact],
            },
            factCount: 1,
            responseReceived: true,
          });
        };
      }),
    );
    void sessionCreated.then(releaseFetch);

    await dispatchWorktreeChatTurn(memoryOptions({ text: longText }));

    expect(sendMessageMock).toHaveBeenCalledWith(
      `<org_memory>fact</org_memory>\n\n${longText}`,
      expect.objectContaining({ userMessageId: 'msg-1' }),
    );
  });

  it('does not emit a memory-used event when the injected block has no facts', async () => {
    readPreferencesFileMock.mockResolvedValue({
      orgMemoryInjectionEnabled: true,
    });
    fetchOrgMemoryAttemptMock.mockResolvedValue({
      result: {
        organizationExternalId: ORG_A,
        renderedBlock: '<org_memory>context</org_memory>',
        facts: [],
      },
      factCount: 0,
      responseReceived: true,
    });

    await dispatchWorktreeChatTurn(memoryOptions({ text: longText }));

    expect(
      sendToWindowDetailedMock.mock.calls.some(
        ([, channel, payload]) =>
          channel === 'chat:event' &&
          typeof payload === 'object' &&
          payload !== null &&
          'data' in payload &&
          typeof payload.data === 'object' &&
          payload.data !== null &&
          'type' in payload.data &&
          payload.data.type === 'org_memory_used',
      ),
    ).toBe(false);
  });

  it('does not fetch or inject memory for a deferred continuation', async () => {
    readPreferencesFileMock.mockResolvedValue({
      orgMemoryInjectionEnabled: true,
    });

    await dispatchWorktreeChatTurn(
      memoryOptions({
        text: longText,
        hiddenDeferredContinuation: true,
      }),
    );

    expect(fetchOrgMemoryAttemptMock).not.toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalledWith(
      longText,
      expect.objectContaining({ userMessageId: 'msg-1' }),
    );
  });

  it('attributes a race-lost late result with a dropped race_timeout ack', async () => {
    readPreferencesFileMock.mockResolvedValue({
      orgMemoryInjectionEnabled: true,
    });
    // Force the race to settle immediately so the pending fetch loses without
    // waiting out the real floor; the continuation attached at the race site
    // must still attribute the late result.
    const budgetSpy = jest
      .spyOn(memoryContextModule, 'remainingMemoryBudgetMs')
      .mockReturnValue(0);
    let releaseFetch = (): void => {};
    fetchOrgMemoryAttemptMock.mockReturnValue(
      new Promise((resolve) => {
        releaseFetch = (): void => {
          resolve({
            result: {
              organizationExternalId: ORG_A,
              renderedBlock: '<org_memory>fact</org_memory>',
              facts: [memoryFact],
              searchId: 'search-9',
            },
            factCount: 1,
            responseReceived: true,
          });
        };
      }),
    );
    try {
      await dispatchWorktreeChatTurn(memoryOptions({ text: longText }));

      // The block missed the turn: sent without memory, nothing acked yet.
      expect(sendMessageMock).toHaveBeenCalledWith(
        longText,
        expect.objectContaining({ userMessageId: 'msg-1' }),
      );
      expect(ackOrgMemoryDeliveredMock).not.toHaveBeenCalled();

      releaseFetch();
      await new Promise((resolve) => setImmediate(resolve));

      expect(ackOrgMemoryDeliveredMock).toHaveBeenCalledTimes(1);
      expect(ackOrgMemoryDeliveredMock).toHaveBeenCalledWith(
        ORG_A,
        'search-9',
        expect.objectContaining({
          outcome: 'dropped',
          dropReason: 'race_timeout',
          clientChatId: 'chat-1',
        }),
      );
      expectAckClientElapsedMs(0);
    } finally {
      budgetSpy.mockRestore();
    }
  });

  it('does not fire a dropped ack when the race-lost result has no facts', async () => {
    readPreferencesFileMock.mockResolvedValue({
      orgMemoryInjectionEnabled: true,
    });
    const budgetSpy = jest
      .spyOn(memoryContextModule, 'remainingMemoryBudgetMs')
      .mockReturnValue(0);
    let releaseFetch = (): void => {};
    fetchOrgMemoryAttemptMock.mockReturnValue(
      new Promise((resolve) => {
        releaseFetch = (): void => {
          resolve({
            result: {
              organizationExternalId: ORG_A,
              renderedBlock: '<org_memory>context</org_memory>',
              facts: [],
              searchId: 'search-9',
            },
            factCount: 0,
            responseReceived: true,
          });
        };
      }),
    );
    try {
      await dispatchWorktreeChatTurn(memoryOptions({ text: longText }));
      releaseFetch();
      await new Promise((resolve) => setImmediate(resolve));

      expect(ackOrgMemoryDeliveredMock).not.toHaveBeenCalled();
    } finally {
      budgetSpy.mockRestore();
    }
  });

  it('attributes a provider-rejected send with a dropped send_failed ack', async () => {
    readPreferencesFileMock.mockResolvedValue({
      orgMemoryInjectionEnabled: true,
    });
    fetchOrgMemoryAttemptMock.mockResolvedValue({
      result: {
        organizationExternalId: ORG_A,
        renderedBlock: '<org_memory>fact</org_memory>',
        facts: [memoryFact],
        searchId: 'search-8',
      },
      factCount: 1,
      responseReceived: true,
    });
    sendMessageMock.mockImplementationOnce(() => {
      throw new Error('dispatch rejected');
    });

    await expect(
      dispatchWorktreeChatTurn(memoryOptions({ text: longText })),
    ).rejects.toThrow('dispatch rejected');

    expect(ackOrgMemoryDeliveredMock).toHaveBeenCalledTimes(1);
    expect(ackOrgMemoryDeliveredMock).toHaveBeenCalledWith(
      ORG_A,
      'search-8',
      expect.objectContaining({
        outcome: 'dropped',
        dropReason: 'send_failed',
        clientChatId: 'chat-1',
      }),
    );
    expectAckClientElapsedMs(0);
  });

  it('attributes a dispatch that throws before send with a dropped turn_aborted ack', async () => {
    readPreferencesFileMock.mockResolvedValue({
      orgMemoryInjectionEnabled: true,
    });
    fetchOrgMemoryAttemptMock.mockResolvedValue({
      result: {
        organizationExternalId: ORG_A,
        renderedBlock: '<org_memory>fact</org_memory>',
        facts: [memoryFact],
        searchId: 'search-10',
      },
      factCount: 1,
      responseReceived: true,
    });
    // The dispatch dies after the memory race settled with an injectable
    // block but before `session.sendMessage` — an exit path that is neither
    // the race-loss continuation nor the send_failed handler.
    setPlanModeMock.mockRejectedValueOnce(new Error('session setup failed'));

    await expect(
      dispatchWorktreeChatTurn(memoryOptions({ text: longText })),
    ).rejects.toThrow('session setup failed');
    await new Promise((resolve) => setImmediate(resolve));

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(ackOrgMemoryDeliveredMock).toHaveBeenCalledTimes(1);
    expect(ackOrgMemoryDeliveredMock).toHaveBeenCalledWith(
      ORG_A,
      'search-10',
      expect.objectContaining({
        outcome: 'dropped',
        dropReason: 'turn_aborted',
        clientChatId: 'chat-1',
      }),
    );
    expectAckClientElapsedMs(0);
  });

  it('attributes a dispatch that dies before the race once the fetch resolves', async () => {
    readPreferencesFileMock.mockResolvedValue({
      orgMemoryInjectionEnabled: true,
    });
    fetchOrgMemoryAttemptMock.mockResolvedValue({
      result: {
        organizationExternalId: ORG_A,
        renderedBlock: '<org_memory>fact</org_memory>',
        facts: [memoryFact],
        searchId: 'search-11',
      },
      factCount: 1,
      responseReceived: true,
    });
    // The very first await inside the dispatch body throws: the fetch has
    // started but the race site (and its continuation) is never reached.
    reserveChatTurnStartMock.mockRejectedValueOnce(
      new Error('resource reservation failed'),
    );

    await expect(
      dispatchWorktreeChatTurn(memoryOptions({ text: longText })),
    ).rejects.toThrow('resource reservation failed');
    await new Promise((resolve) => setImmediate(resolve));

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(ackOrgMemoryDeliveredMock).toHaveBeenCalledTimes(1);
    expect(ackOrgMemoryDeliveredMock).toHaveBeenCalledWith(
      ORG_A,
      'search-11',
      expect.objectContaining({
        outcome: 'dropped',
        dropReason: 'turn_aborted',
        clientChatId: 'chat-1',
      }),
    );
  });

  it('acks turn_aborted instead of delivered when the session is disposed at send time', async () => {
    readPreferencesFileMock.mockResolvedValue({
      orgMemoryInjectionEnabled: true,
    });
    fetchOrgMemoryAttemptMock.mockResolvedValue({
      result: {
        organizationExternalId: ORG_A,
        renderedBlock: '<org_memory>fact</org_memory>',
        facts: [memoryFact],
        searchId: 'search-12',
      },
      factCount: 1,
      responseReceived: true,
    });
    // Both provider sessions enqueue into their in-memory queue even after
    // destruction, so sendMessage "succeeds" — the liveness check is the
    // only honest delivery signal at this seam.
    getOrCreateSessionMock.mockImplementation(
      (
        ...args: [
          unknown,
          (data: unknown) => void,
          (() => unknown)?,
          MockSessionLifecycle?,
        ]
      ): MockAgentSession => ({
        ...makeMockSessionForEventHandler(args[1]),
        isDisposed: (): boolean => true,
      }),
    );

    await dispatchWorktreeChatTurn(memoryOptions({ text: longText }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(ackOrgMemoryDeliveredMock).toHaveBeenCalledTimes(1);
    expect(ackOrgMemoryDeliveredMock).toHaveBeenCalledWith(
      ORG_A,
      'search-12',
      expect.objectContaining({
        outcome: 'dropped',
        dropReason: 'turn_aborted',
        clientChatId: 'chat-1',
      }),
    );
    expectAckClientElapsedMs(0);
    // A block dropped into an undrainable queue never reached the model, so
    // it must not be persisted or broadcast as a used memory — that would
    // surface it in the UI and accept feedback on an injection that never
    // happened.
    expect(persistOrgMemoryUsedForChatMock).not.toHaveBeenCalled();
    expect(
      sendToWindowDetailedMock.mock.calls.some(
        ([, channel, payload]) =>
          channel === 'chat:event' &&
          typeof payload === 'object' &&
          payload !== null &&
          'data' in payload &&
          typeof payload.data === 'object' &&
          payload.data !== null &&
          'type' in payload.data &&
          payload.data.type === 'org_memory_used',
      ),
    ).toBe(false);
  });

  // CAN-3457: org memory follows the owner of the work. The account may
  // search both A and B (A first), so every case below would have searched A
  // before this fix.
  describe('owning organization', () => {
    function ownedBy(
      owner: { type: 'organization'; organizationId: string } | undefined,
      type: 'single-repo' | 'multi-repo' | 'cowork' = 'single-repo',
    ): void {
      readWorkspaceConfigDetailedMock.mockResolvedValue({
        config: {
          version: 1,
          type,
          repoPath: '/mock/repo',
          repos: [],
          ...(owner ? { owner } : {}),
        },
        authority: 'ok',
        ownerMalformed: false,
      });
    }

    beforeEach(() => {
      readPreferencesFileMock.mockResolvedValue({
        orgMemoryInjectionEnabled: true,
      });
    });

    it('searches only A for an A-owned project', async () => {
      ownedBy({ type: 'organization', organizationId: ORG_A });

      await dispatchWorktreeChatTurn(memoryOptions({ text: longText }));

      expect(fetchOrgMemoryAttemptMock).toHaveBeenCalledTimes(1);
      expect(fetchOrgMemoryAttemptMock.mock.calls[0]?.[0]).toBe(ORG_A);
    });

    it('searches only B for a B-owned project even though A is listed first', async () => {
      ownedBy({ type: 'organization', organizationId: ORG_B });
      fetchOrgMemoryAttemptMock.mockResolvedValue({
        result: {
          organizationExternalId: ORG_B,
          renderedBlock: '<org_memory>fact</org_memory>',
          facts: [memoryFact],
          searchId: 'search-b',
        },
        factCount: 1,
        responseReceived: true,
      });

      await dispatchWorktreeChatTurn(memoryOptions({ text: longText }));

      expect(fetchOrgMemoryAttemptMock).toHaveBeenCalledTimes(1);
      expect(fetchOrgMemoryAttemptMock.mock.calls[0]?.[0]).toBe(ORG_B);
      // The ack and the persisted disclosure carry the searched org, so
      // feedback on this turn goes to B.
      expect(ackOrgMemoryDeliveredMock).toHaveBeenCalledWith(
        ORG_B,
        'search-b',
        expect.objectContaining({ outcome: 'delivered' }),
      );
      expect(persistOrgMemoryUsedForChatMock).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationExternalId: ORG_B,
          searchId: 'search-b',
        }),
      );
    });

    it('makes no request for a Personal project', async () => {
      ownedBy(undefined, 'multi-repo');

      await dispatchWorktreeChatTurn(memoryOptions({ text: longText }));

      expect(fetchOrgMemoryAttemptMock).not.toHaveBeenCalled();
      expect(sendMessageMock).toHaveBeenCalledWith(
        longText,
        expect.objectContaining({ userMessageId: 'msg-1' }),
      );
    });

    it('makes no request for a Personal single repo running in Personal', async () => {
      ownedBy(undefined, 'single-repo');

      await dispatchWorktreeChatTurn(
        memoryOptions({ text: longText, executionContext: 'personal' }),
      );

      expect(fetchOrgMemoryAttemptMock).not.toHaveBeenCalled();
    });

    // CAN-3477: a Cowork workspace follows its saved owner.
    describe('Cowork', () => {
      function coworkOptions(
        overrides: Partial<Parameters<typeof dispatchWorktreeChatTurn>[0]> = {},
      ): Parameters<typeof dispatchWorktreeChatTurn>[0] {
        return baseOptions({
          projectId: 'cowork-default',
          worktreeId: 'entry-1',
          text: longText,
          ...overrides,
        });
      }

      it('searches only A for an A-owned Cowork chat', async () => {
        ownedBy({ type: 'organization', organizationId: ORG_A }, 'cowork');
        fetchOrgMemoryAttemptMock.mockResolvedValue({
          result: {
            organizationExternalId: ORG_A,
            renderedBlock: '<org_memory>fact</org_memory>',
            facts: [memoryFact],
            searchId: 'search-a',
          },
          factCount: 1,
          responseReceived: true,
        });

        await dispatchWorktreeChatTurn(coworkOptions());

        expect(readWorkspaceConfigDetailedMock).toHaveBeenCalledWith(
          'cowork-default',
        );
        expect(fetchOrgMemoryAttemptMock).toHaveBeenCalledTimes(1);
        expect(fetchOrgMemoryAttemptMock.mock.calls[0]?.[0]).toBe(ORG_A);
        expect(ackOrgMemoryDeliveredMock).toHaveBeenCalledWith(
          ORG_A,
          'search-a',
          expect.objectContaining({ outcome: 'delivered' }),
        );
        expect(persistOrgMemoryUsedForChatMock).toHaveBeenCalledWith(
          expect.objectContaining({
            projectId: 'cowork-default',
            worktreeId: 'entry-1',
            organizationExternalId: ORG_A,
            searchId: 'search-a',
          }),
        );
      });

      it('searches only B for a B-owned Cowork chat even though A is listed first', async () => {
        ownedBy({ type: 'organization', organizationId: ORG_B }, 'cowork');

        await dispatchWorktreeChatTurn(coworkOptions());

        expect(fetchOrgMemoryAttemptMock).toHaveBeenCalledTimes(1);
        expect(fetchOrgMemoryAttemptMock.mock.calls[0]?.[0]).toBe(ORG_B);
      });

      it('makes no request for a Personal Cowork chat', async () => {
        ownedBy(undefined, 'cowork');

        await dispatchWorktreeChatTurn(
          coworkOptions({ executionContext: `org:${ORG_A}` }),
        );

        expect(fetchOrgMemoryAttemptMock).not.toHaveBeenCalled();
        expect(sendMessageMock).toHaveBeenCalledWith(
          longText,
          expect.objectContaining({ userMessageId: 'msg-1' }),
        );
      });

      it('makes no request and tries no other org when the Cowork owner is not eligible', async () => {
        const otherOrg = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
        ownedBy({ type: 'organization', organizationId: otherOrg }, 'cowork');

        await dispatchWorktreeChatTurn(coworkOptions());

        expect(fetchOrgMemoryAttemptMock).not.toHaveBeenCalled();
      });

      it('makes no request and tries no other org when the Cowork owner has lapsed', async () => {
        ownedBy({ type: 'organization', organizationId: ORG_B }, 'cowork');
        isOrganizationTeamsLapsedMock.mockImplementation((org: string) =>
          Promise.resolve(org === ORG_B),
        );

        await dispatchWorktreeChatTurn(coworkOptions());

        expect(fetchOrgMemoryAttemptMock).not.toHaveBeenCalled();
      });

      it('builds the Cowork query with no branch component', async () => {
        ownedBy({ type: 'organization', organizationId: ORG_A }, 'cowork');
        mockReadPersistedWorktreeBranch.mockResolvedValue({
          worktreeId: 'entry-1',
          branchName: 'feature/not-a-cowork-branch',
        });

        await dispatchWorktreeChatTurn(coworkOptions());

        expect(fetchOrgMemoryAttemptMock).toHaveBeenCalledTimes(1);
        const query = fetchOrgMemoryAttemptMock.mock.calls[0]?.[1];
        expect(query).toContain(longText);
        expect(query).not.toContain('feature/not-a-cowork-branch');
        expect(mockReadPersistedWorktreeBranch).not.toHaveBeenCalled();
      });

      // The owner and the query shape must come from the same persisted read:
      // the sidebar registry may not have observed a new Cowork workspace yet.
      it('shapes the query from the saved Cowork type when the registry has not seen the workspace', async () => {
        ownedBy({ type: 'organization', organizationId: ORG_A }, 'cowork');
        readWorkspaceConfigMock.mockResolvedValue({
          version: 1,
          type: 'cowork',
          repoPath: '/mock/repo',
          repos: [],
        });
        mockReadPersistedWorktreeBranch.mockResolvedValue({
          worktreeId: 'wt-1',
          branchName: 'feature/not-a-cowork-branch',
        });

        // `org-project` is not a Cowork id to the in-memory registry.
        await dispatchWorktreeChatTurn(memoryOptions({ text: longText }));

        expect(mockIsCoworkWorkspace('org-project')).toBe(false);
        expect(fetchOrgMemoryAttemptMock).toHaveBeenCalledTimes(1);
        expect(fetchOrgMemoryAttemptMock.mock.calls[0]?.[0]).toBe(ORG_A);
        const query = fetchOrgMemoryAttemptMock.mock.calls[0]?.[1];
        expect(query).toContain(longText);
        expect(query).not.toContain('feature/not-a-cowork-branch');
      });
    });

    it('makes no request for an App Advisor chat', async () => {
      await dispatchWorktreeChatTurn(
        memoryOptions({ projectId: 'app-advisor', text: longText }),
      );

      expect(fetchOrgMemoryAttemptMock).not.toHaveBeenCalled();
    });

    it('makes no request and tries no other org when the owner is not eligible', async () => {
      const otherOrg = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      ownedBy({ type: 'organization', organizationId: otherOrg });

      await dispatchWorktreeChatTurn(memoryOptions({ text: longText }));

      expect(fetchOrgMemoryAttemptMock).not.toHaveBeenCalled();
    });

    it('makes no request and tries no other org when the owner has lapsed', async () => {
      ownedBy({ type: 'organization', organizationId: ORG_B });
      isOrganizationTeamsLapsedMock.mockImplementation((org: string) =>
        Promise.resolve(org === ORG_B),
      );

      await dispatchWorktreeChatTurn(memoryOptions({ text: longText }));

      expect(fetchOrgMemoryAttemptMock).not.toHaveBeenCalled();
    });

    it.each([
      [
        'lacks the memorySearch capability',
        { capabilities: [], memorySearchOrganizationExternalIds: [ORG_A] },
      ],
      [
        'has no eligible organization',
        {
          capabilities: ['memorySearch'],
          memorySearchOrganizationExternalIds: [],
        },
      ],
    ])(
      'skips the owner lookup when the account %s',
      async (_label, account) => {
        ownedBy({ type: 'organization', organizationId: ORG_A });
        getCanopyCloudCredentialsMock.mockResolvedValueOnce({
          baseUrl: 'https://cloud.example',
          apiKey: 'key',
          memorySearchOrganizationExternalId: ORG_A,
          ...account,
        });

        await dispatchWorktreeChatTurn(memoryOptions({ text: longText }));

        expect(fetchOrgMemoryAttemptMock).not.toHaveBeenCalled();
        // Only the system prompt's Private memory check reads the config; the
        // owner lookup would add a second read.
        expect(readWorkspaceConfigDetailedMock).toHaveBeenCalledTimes(1);
      },
    );

    it('makes no request when the owner config is unreadable', async () => {
      readWorkspaceConfigDetailedMock.mockResolvedValue({
        config: { version: 1, type: 'single-repo', repos: [] },
        authority: 'unreadable',
        ownerMalformed: false,
      });

      await dispatchWorktreeChatTurn(memoryOptions({ text: longText }));

      expect(fetchOrgMemoryAttemptMock).not.toHaveBeenCalled();
    });
  });
});

describe('dispatchWorktreeChatTurn reused-session event routing', () => {
  it('routes retained provider callbacks to the current turn handler', async () => {
    let retainedProviderCallback: ((data: unknown) => void) | undefined;
    const sharedSession: MockAgentSession = {
      sendMessage: sendMessageMock,
      setPlanMode: setPlanModeMock,
      getProviderSessionId: getProviderSessionIdMock,
      __onEvent: (data: unknown) => retainedProviderCallback?.(data),
    };
    getOrCreateSessionMock.mockImplementation((_options, onEvent) => {
      retainedProviderCallback ??= onEvent;
      return sharedSession;
    });
    const firstTurnHandler = jest.fn();
    const secondTurnHandler = jest.fn();
    const firstTurnBeforeEvent = jest.fn(() => Promise.resolve());
    const secondTurnBeforeEvent = jest.fn(() => Promise.resolve());

    await dispatchWorktreeChatTurn(
      baseOptions({
        userMessageId: 'msg-1',
        onChatEvent: firstTurnHandler,
        onBeforeChatEvent: firstTurnBeforeEvent,
      }),
    );
    retainedProviderCallback?.({
      type: 'result',
      is_error: false,
      canopy_turn_user_message_id: 'msg-1',
    });
    await flushSessionEventCommits();
    expect(firstTurnHandler).toHaveBeenCalledTimes(1);

    await dispatchWorktreeChatTurn(
      baseOptions({
        userMessageId: 'msg-2',
        onChatEvent: secondTurnHandler,
        onBeforeChatEvent: secondTurnBeforeEvent,
      }),
    );
    retainedProviderCallback?.({
      type: 'assistant',
      canopy_turn_user_message_id: 'msg-1',
    });
    retainedProviderCallback?.({
      type: 'result',
      is_error: false,
      canopy_turn_user_message_id: 'msg-1',
    });
    retainedProviderCallback?.({
      type: 'assistant',
      canopy_turn_user_message_id: 'msg-2',
    });
    await flushSessionEventCommits();

    expect(firstTurnHandler).toHaveBeenCalledTimes(1);
    expect(secondTurnHandler).toHaveBeenCalledTimes(1);
    expect(firstTurnBeforeEvent).toHaveBeenCalledTimes(1);
    expect(secondTurnBeforeEvent).toHaveBeenCalledTimes(1);
  });

  it('offers tagged late output to canonical state and drops it when the settled turn rejects it', async () => {
    const turnHandler = jest.fn();
    const beforeEvent = jest
      .fn<Promise<boolean>, []>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await dispatchWorktreeChatTurn(
      baseOptions({
        userMessageId: 'msg-1',
        onChatEvent: turnHandler,
        onBeforeChatEvent: beforeEvent,
      }),
    );
    const session = getMockSession(0);
    session.__onEvent({
      type: 'result',
      is_error: false,
      canopy_turn_user_message_id: 'msg-1',
    });
    session.__onEvent({
      type: 'assistant',
      canopy_turn_user_message_id: 'msg-1',
    });
    await flushSessionEventCommits();

    expect(turnHandler).toHaveBeenCalledTimes(1);
    expect(beforeEvent).toHaveBeenCalledTimes(2);
  });

  it('delivers tagged late output when canonical state accepts empty-completion reconciliation', async () => {
    type DeliveredChatEvent = Parameters<
      NonNullable<Parameters<typeof dispatchWorktreeChatTurn>[0]['onChatEvent']>
    >[0];
    const turnHandler = jest.fn<void, [DeliveredChatEvent]>();
    const beforeEvent = jest.fn(() => Promise.resolve(true));

    await dispatchWorktreeChatTurn(
      baseOptions({
        userMessageId: 'msg-1',
        onChatEvent: turnHandler,
        onBeforeChatEvent: beforeEvent,
      }),
    );
    const session = getMockSession(0);
    session.__onEvent({
      type: 'result',
      is_error: false,
      canopy_turn_user_message_id: 'msg-1',
    });
    session.__onEvent({
      type: 'assistant',
      canopy_turn_user_message_id: 'msg-1',
      message: {
        id: 'late-assistant',
        role: 'assistant',
        content: [{ type: 'text', text: 'Late recovered output' }],
      },
    });
    await flushSessionEventCommits();

    expect(beforeEvent).toHaveBeenCalledTimes(2);
    expect(turnHandler).toHaveBeenCalledTimes(2);
    const lateDeliveredEvent: unknown = turnHandler.mock.calls[1]?.[0];
    expect(lateDeliveredEvent).toMatchObject({
      data: { type: 'assistant' },
      isTerminalEvent: false,
    });
  });

  it.each([
    ['item.started', 'thread-root'],
    ['item.updated', 'thread-root'],
    ['item.completed', 'thread-root'],
    ['item.plan.delta', 'thread-root'],
    ['turn.started', 'thread-child'],
  ])(
    'does not revive a settled Codex turn for late %s from %s',
    async (type, threadId) => {
      const turnHandler = jest.fn();
      const beforeEvent = jest.fn(() => Promise.resolve());
      const onTurnRevived = jest
        .spyOn(chatQueueServiceModule.getChatQueueService(), 'onTurnRevived')
        .mockReturnValue(true);
      try {
        await dispatchWorktreeChatTurn(
          baseOptions({
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            sdkSessionId: 'thread-root',
            userMessageId: 'msg-1',
            onChatEvent: turnHandler,
            onBeforeChatEvent: beforeEvent,
          }),
        );
        const session = getMockSession(0);
        session.__onEvent({
          type: 'codex',
          event: {
            type: 'turn.completed',
            thread_id: 'thread-root',
            turn_id: 'turn-1',
          },
          canopy_turn_user_message_id: 'msg-1',
        });
        await flushSessionEventCommits();
        // Background commands can complete after Codex clears activeTurn, so
        // their events have provider ids but no canopy_turn_user_message_id.
        session.__onEvent({
          type: 'codex',
          event: {
            type,
            thread_id: threadId,
            turn_id: 'turn-1',
            ...(type.startsWith('item.')
              ? {
                  item: {
                    id: 'background-command',
                    type: 'command_execution',
                  },
                }
              : {}),
          },
        });
        await flushSessionEventCommits();
        expect(onTurnRevived).not.toHaveBeenCalled();
        expect(turnHandler).toHaveBeenCalledTimes(1);
        expect(beforeEvent).toHaveBeenCalledTimes(1);
      } finally {
        onTurnRevived.mockRestore();
      }
    },
  );

  it('delivers late routed Codex subagent output without reviving the settled root turn', async () => {
    const turnHandler = jest.fn();
    const beforeEvent = jest.fn(() => Promise.resolve());
    const onTurnRevived = jest
      .spyOn(chatQueueServiceModule.getChatQueueService(), 'onTurnRevived')
      .mockReturnValue(true);
    try {
      await dispatchWorktreeChatTurn(
        baseOptions({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          sdkSessionId: 'thread-root',
          userMessageId: 'msg-1',
          onChatEvent: turnHandler,
          onBeforeChatEvent: beforeEvent,
        }),
      );
      const session = getMockSession(0);
      session.__onEvent({
        type: 'codex',
        event: {
          type: 'turn.completed',
          thread_id: 'thread-root',
          turn_id: 'turn-root',
        },
        canopy_turn_user_message_id: 'msg-1',
      });
      await flushSessionEventCommits();

      const lateChildMessage = {
        type: 'codex',
        event: {
          type: 'item.completed',
          thread_id: 'thread-child',
          turn_id: 'turn-child',
          item: {
            id: 'child-final-message',
            type: 'agent_message',
            text: 'Late child result',
          },
        },
      };
      session.__onEvent(lateChildMessage);
      await flushSessionEventCommits();

      expect(onTurnRevived).not.toHaveBeenCalled();
      expect(turnHandler).toHaveBeenCalledTimes(2);
      expect(turnHandler).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: lateChildMessage,
          isTerminalEvent: false,
        }),
      );
      expect(beforeEvent).toHaveBeenCalledTimes(2);
    } finally {
      onTurnRevived.mockRestore();
    }
  });

  it('delivers late Codex subagent lifecycle metadata without reviving the settled root turn', async () => {
    const turnHandler = jest.fn();
    const beforeEvent = jest.fn(() => Promise.resolve());
    const onTurnRevived = jest
      .spyOn(chatQueueServiceModule.getChatQueueService(), 'onTurnRevived')
      .mockReturnValue(true);
    try {
      await dispatchWorktreeChatTurn(
        baseOptions({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          sdkSessionId: 'thread-root',
          userMessageId: 'msg-1',
          onChatEvent: turnHandler,
          onBeforeChatEvent: beforeEvent,
        }),
      );
      const session = getMockSession(0);
      session.__onEvent({
        type: 'codex',
        event: {
          type: 'turn.completed',
          thread_id: 'thread-root',
          turn_id: 'turn-root',
        },
        canopy_turn_user_message_id: 'msg-1',
      });
      await flushSessionEventCommits();

      session.__onEvent({
        type: 'codex',
        event: {
          type: 'item.completed',
          thread_id: 'thread-root',
          turn_id: 'turn-root',
          item: {
            id: 'child-completed',
            type: 'sub_agent_activity',
            kind: 'completed',
            agent_thread_id: 'thread-child',
            agent_path: '/root/review',
          },
        },
      });
      session.__onEvent({
        type: 'codex',
        event: {
          type: 'thread.started',
          thread_id: 'thread-child',
          parent_thread_id: 'thread-root',
          agent_nickname: 'Tesla',
          model: 'gpt-6-astra',
          reasoning_effort: 'high',
        },
      });
      session.__onEvent({
        type: 'codex',
        event: {
          type: 'turn.failed',
          thread_id: 'thread-child',
          turn_id: 'turn-child',
          error: { message: 'Child failed' },
        },
      });
      await flushSessionEventCommits();

      expect(onTurnRevived).not.toHaveBeenCalled();
      expect(turnHandler).toHaveBeenCalledTimes(4);
      expect(beforeEvent).toHaveBeenCalledTimes(4);
    } finally {
      onTurnRevived.mockRestore();
    }
  });

  it.each([
    { type: 'turn.started', taggedRetry: false },
    { type: 'item.completed', taggedRetry: true },
  ])(
    'preserves Codex continuation for $type (explicit retry: $taggedRetry)',
    async ({ type, taggedRetry }) => {
      const beforeEvent = jest.fn(() => Promise.resolve());
      const onTurnRevived = jest
        .spyOn(chatQueueServiceModule.getChatQueueService(), 'onTurnRevived')
        .mockReturnValue(true);
      try {
        await dispatchWorktreeChatTurn(
          baseOptions({
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            sdkSessionId: 'thread-root',
            userMessageId: 'msg-1',
            onBeforeChatEvent: beforeEvent,
          }),
        );
        const session = getMockSession(0);
        session.__onEvent({
          type: 'codex',
          event: {
            type: 'turn.completed',
            thread_id: 'thread-root',
            turn_id: 'turn-1',
          },
          canopy_turn_user_message_id: 'msg-1',
        });
        await flushSessionEventCommits();
        session.__onEvent({
          type: 'codex',
          event: { type, thread_id: 'thread-root', turn_id: 'turn-2' },
          ...(taggedRetry
            ? {
                canopy_turn_user_message_id: 'msg-1',
                canopy_turn_revival: true,
              }
            : {}),
        });
        await flushSessionEventCommits();
        expect(onTurnRevived).toHaveBeenCalledTimes(1);
        expect(beforeEvent).toHaveBeenCalledTimes(2);
      } finally {
        onTurnRevived.mockRestore();
      }
    },
  );

  it('revives delivery for untagged agent continuation output after settlement', async () => {
    const turnHandler = jest.fn();
    const beforeEvent = jest.fn(() => Promise.resolve());
    const queueService = chatQueueServiceModule.getChatQueueService();
    const onTurnTerminal = jest
      .spyOn(queueService, 'onTurnTerminal')
      .mockImplementation();
    const onTurnRevived = jest
      .spyOn(queueService, 'onTurnRevived')
      .mockReturnValue(true);

    try {
      await dispatchWorktreeChatTurn(
        baseOptions({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          userMessageId: 'msg-1',
          onChatEvent: turnHandler,
          onBeforeChatEvent: beforeEvent,
        }),
      );
      const session = getMockSession(0);
      session.__onEvent({
        type: 'result',
        is_error: false,
        canopy_turn_user_message_id: 'msg-1',
      });
      session.__onEvent({ type: 'assistant', message: 'continued output' });
      await flushSessionEventCommits();

      expect(turnHandler).toHaveBeenCalledTimes(2);
      expect(beforeEvent).toHaveBeenCalledTimes(2);
      expect(onTurnTerminal).toHaveBeenCalledWith(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
        },
        'complete',
        'msg-1',
      );
      expect(onTurnRevived).toHaveBeenCalledWith(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
        },
        'msg-1',
      );
    } finally {
      onTurnTerminal.mockRestore();
      onTurnRevived.mockRestore();
    }
  });

  it('delivers a late async Codex question without rearming the settled queue', async () => {
    const turnHandler = jest.fn();
    const beforeEvent = jest.fn(() => Promise.resolve());
    const queueService = chatQueueServiceModule.getChatQueueService();
    const onTurnRevived = jest
      .spyOn(queueService, 'onTurnRevived')
      .mockReturnValue(true);

    try {
      await dispatchWorktreeChatTurn(
        baseOptions({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          userMessageId: 'msg-1',
          onChatEvent: turnHandler,
          onBeforeChatEvent: beforeEvent,
        }),
      );
      const session = getMockSession(0);
      session.__onEvent({
        type: 'result',
        is_error: false,
        canopy_turn_user_message_id: 'msg-1',
      });
      session.__onEvent({
        type: 'codex',
        event: {
          type: 'item.completed',
          thread_id: 'thread-root',
          turn_id: 'turn-1',
          item: {
            id: 'question-1',
            type: 'agent_message',
            delivery: 'async',
            text: 'Which scope?',
            questions: [{ title: 'Which scope?', options: ['Full'] }],
          },
        },
      });
      await flushSessionEventCommits();

      expect(onTurnRevived).not.toHaveBeenCalled();
      expect(beforeEvent).toHaveBeenCalledTimes(2);
      expect(turnHandler).toHaveBeenCalledTimes(2);
    } finally {
      onTurnRevived.mockRestore();
    }
  });

  it('delivers owned child output from an earlier turn without reviving the parent', async () => {
    const onChatEvent = jest.fn();
    const onBeforeChatEvent = jest.fn(() => Promise.resolve());
    const revived = jest
      .spyOn(chatQueueServiceModule.getChatQueueService(), 'onTurnRevived')
      .mockReturnValue(true);
    try {
      await dispatchWorktreeChatTurn(
        baseOptions({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          userMessageId: 'msg-1',
          onChatEvent,
          onBeforeChatEvent,
        }),
      );
      const session = getMockSession(0);
      session.__onEvent({
        type: 'result',
        is_error: false,
        canopy_turn_user_message_id: 'msg-1',
      });
      await flushSessionEventCommits();
      session.__onEvent({
        type: 'canopy_delegation',
        canopy_turn_user_message_id: 'original',
        delegation: {
          delegationId: 'child',
          runGeneration: 1,
          sequence: 2,
          parentHarnessId: 'codex',
          parentTurnId: 'original',
          parentToolCallId: 'call',
          createdAt: 1,
          task: {
            description: 'Review',
            prompt: 'Read',
            executionMode: 'background',
          },
          snapshot: {
            delegationId: 'child',
            status: 'completed',
            outputTruncated: false,
            routeSnapshot: {
              selectedModelId: 'reviewer',
              runtimeModelId: 'runtime',
              harnessId: 'claude',
            },
          },
          transcript: [],
        },
      });
      await flushSessionEventCommits();
      expect(revived).not.toHaveBeenCalled();
      expect(onBeforeChatEvent).toHaveBeenCalledTimes(2);
      expect(onChatEvent).toHaveBeenCalledTimes(2);
    } finally {
      revived.mockRestore();
    }
  });

  it('revives delivery for a same-turn tagged retry after settlement', async () => {
    const turnHandler = jest.fn();
    const beforeEvent = jest.fn(() => Promise.resolve());
    const queueService = chatQueueServiceModule.getChatQueueService();
    const onTurnTerminal = jest
      .spyOn(queueService, 'onTurnTerminal')
      .mockImplementation();
    const onTurnRevived = jest
      .spyOn(queueService, 'onTurnRevived')
      .mockReturnValue(true);

    try {
      await dispatchWorktreeChatTurn(
        baseOptions({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          userMessageId: 'msg-1',
          onChatEvent: turnHandler,
          onBeforeChatEvent: beforeEvent,
        }),
      );
      const session = getMockSession(0);
      session.__onEvent({
        type: 'result',
        is_error: true,
        canopy_turn_user_message_id: 'msg-1',
      });
      session.__onEvent({
        type: 'system',
        subtype: 'init',
        session_id: 'replacement-thread',
        canopy_turn_user_message_id: 'msg-1',
        canopy_turn_revival: true,
      });
      session.__onEvent({
        type: 'assistant',
        message: 'retried output',
        canopy_turn_user_message_id: 'msg-1',
        canopy_turn_revival: true,
      });
      await flushSessionEventCommits();

      expect(onTurnRevived).toHaveBeenCalledWith(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
        },
        'msg-1',
      );
      expect(turnHandler).toHaveBeenCalledTimes(3);
      expect(beforeEvent).toHaveBeenCalledTimes(3);
    } finally {
      onTurnTerminal.mockRestore();
      onTurnRevived.mockRestore();
    }
  });

  it('drops revived output after the host queue advances', async () => {
    const turnHandler = jest.fn();
    const beforeEvent = jest.fn(() => Promise.resolve());
    const queueService = chatQueueServiceModule.getChatQueueService();
    const onTurnTerminal = jest
      .spyOn(queueService, 'onTurnTerminal')
      .mockImplementation();
    const onTurnRevived = jest
      .spyOn(queueService, 'onTurnRevived')
      .mockReturnValue(false);

    try {
      await dispatchWorktreeChatTurn(
        baseOptions({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          userMessageId: 'msg-1',
          onChatEvent: turnHandler,
          onBeforeChatEvent: beforeEvent,
        }),
      );
      const session = getMockSession(0);
      session.__onEvent({
        type: 'result',
        is_error: false,
        canopy_turn_user_message_id: 'msg-1',
      });
      session.__onEvent({ type: 'assistant', message: 'stale continuation' });
      await flushSessionEventCommits();

      expect(onTurnRevived).toHaveBeenCalledTimes(1);
      expect(turnHandler).toHaveBeenCalledTimes(1);
      expect(beforeEvent).toHaveBeenCalledTimes(1);
    } finally {
      onTurnTerminal.mockRestore();
      onTurnRevived.mockRestore();
    }
  });

  it('honors a durable rejected pickup without re-arbitrating the turn root', async () => {
    const turnHandler = jest.fn();
    const beforeEvent = jest.fn(() => Promise.resolve());
    const onTurnRevived = jest
      .spyOn(chatQueueServiceModule.getChatQueueService(), 'onTurnRevived')
      .mockReturnValue(true);

    try {
      await dispatchWorktreeChatTurn(
        baseOptions({
          userMessageId: 'current',
          onChatEvent: turnHandler,
          onBeforeChatEvent: beforeEvent,
        }),
      );
      const session = getMockSession(0);
      session.__onEvent({
        type: 'canopy_input_delivery',
        provider: 'claude',
        phase: 'picked-up',
        generation: 'live',
        attemptId: 'late-attempt',
        startsTurn: true,
        userMessageId: 'stale',
        turnRootAccepted: false,
      });
      await flushSessionEventCommits();

      expect(onTurnRevived).not.toHaveBeenCalled();
      expect(beforeEvent).toHaveBeenCalledWith(
        expect.objectContaining({ turnUserMessageId: 'current' }),
      );
      expect(turnHandler).toHaveBeenCalledTimes(1);
    } finally {
      onTurnRevived.mockRestore();
    }
  });

  it('does not settle the root turn when a Codex subagent completes', async () => {
    const turnHandler = jest.fn(
      (
        event: Parameters<
          Parameters<typeof dispatchWorktreeChatTurn>[0]['onChatEvent']
        >[0],
      ) => event.isTerminalEvent,
    );
    const beforeEvent = jest.fn(() => Promise.resolve());

    await dispatchWorktreeChatTurn(
      baseOptions({
        userMessageId: 'msg-codex-root',
        onChatEvent: turnHandler,
        onBeforeChatEvent: beforeEvent,
      }),
    );
    const session = getMockSession(0);
    session.__onEvent({
      type: 'system',
      subtype: 'init',
      session_id: 'thread-root',
      canopy_turn_user_message_id: 'msg-codex-root',
    });
    session.__onEvent({
      type: 'codex',
      event: {
        type: 'turn.started',
        thread_id: 'thread-root',
        turn_id: 'turn-root',
      },
      canopy_turn_user_message_id: 'msg-codex-root',
    });
    session.__onEvent({
      type: 'codex',
      event: {
        type: 'turn.completed',
        thread_id: 'thread-child',
        turn_id: 'turn-child',
      },
      canopy_turn_user_message_id: 'msg-codex-root',
    });
    session.__onEvent({
      type: 'codex',
      event: {
        type: 'item.completed',
        thread_id: 'thread-root',
        turn_id: 'turn-root',
        item: { id: 'answer-root', type: 'agent_message', text: 'Root tail' },
      },
      canopy_turn_user_message_id: 'msg-codex-root',
    });
    await flushSessionEventCommits();

    expect(beforeEvent).toHaveBeenCalledTimes(4);
    expect(turnHandler).toHaveBeenCalledTimes(4);
    expect(turnHandler.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({ isTerminalEvent: false }),
    );

    session.__onEvent({
      type: 'codex',
      event: {
        type: 'turn.completed',
        thread_id: 'thread-root',
        turn_id: 'turn-root',
      },
      canopy_turn_user_message_id: 'msg-codex-root',
    });
    await flushSessionEventCommits();

    expect(beforeEvent).toHaveBeenCalledTimes(5);
    expect(turnHandler).toHaveBeenCalledTimes(5);
    expect(turnHandler.mock.calls[4]?.[0]).toEqual(
      expect.objectContaining({ isTerminalEvent: true }),
    );
  });

  it('keeps a reused Codex root turn open without another init event', async () => {
    const turnHandler = jest.fn();
    const beforeEvent = jest.fn(() => Promise.resolve());

    await dispatchWorktreeChatTurn(
      baseOptions({
        userMessageId: 'msg-codex-reused',
        sdkSessionId: 'thread-root',
        onChatEvent: turnHandler,
        onBeforeChatEvent: beforeEvent,
      }),
    );
    const session = getMockSession(0);
    session.__onEvent({
      type: 'codex',
      event: {
        type: 'turn.started',
        thread_id: 'thread-root',
        turn_id: 'turn-root-reused',
      },
      canopy_turn_user_message_id: 'msg-codex-reused',
    });
    session.__onEvent({
      type: 'codex',
      event: {
        type: 'turn.completed',
        thread_id: 'thread-child',
        turn_id: 'turn-child',
      },
      canopy_turn_user_message_id: 'msg-codex-reused',
    });
    session.__onEvent({
      type: 'codex',
      event: {
        type: 'item.completed',
        thread_id: 'thread-root',
        turn_id: 'turn-root-reused',
        item: { id: 'answer-root', type: 'agent_message', text: 'Root tail' },
      },
      canopy_turn_user_message_id: 'msg-codex-reused',
    });
    await flushSessionEventCommits();

    expect(beforeEvent).toHaveBeenCalledTimes(3);
    expect(turnHandler).toHaveBeenCalledTimes(3);

    session.__onEvent({
      type: 'codex',
      event: {
        type: 'turn.completed',
        thread_id: 'thread-root',
        turn_id: 'turn-root-reused',
      },
      canopy_turn_user_message_id: 'msg-codex-reused',
    });
    await flushSessionEventCommits();

    expect(beforeEvent).toHaveBeenCalledTimes(4);
    expect(turnHandler).toHaveBeenCalledTimes(4);
  });

  it('does not deliver an event rejected by canonical precommit ingestion', async () => {
    const turnHandler = jest.fn();
    const beforeEvent = jest.fn(() => Promise.resolve(false));

    await dispatchWorktreeChatTurn(
      baseOptions({
        onChatEvent: turnHandler,
        onBeforeChatEvent: beforeEvent,
      }),
    );
    getMockSession(0).__onEvent({ type: 'assistant', message: 'stale output' });
    await flushSessionEventCommits();

    expect(beforeEvent).toHaveBeenCalledTimes(1);
    expect(turnHandler).not.toHaveBeenCalled();
  });

  it('releases the matching queue gate when a session disappears without a terminal event', async () => {
    const terminal = jest
      .spyOn(chatQueueServiceModule.getChatQueueService(), 'onTurnTerminal')
      .mockImplementation();
    try {
      await dispatchWorktreeChatTurn(
        baseOptions({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          userMessageId: 'removed-turn',
        }),
      );
      const lifecycle = getOrCreateSessionMock.mock.calls[0]?.[3];
      await lifecycle?.drainEventsBeforeRemoval?.();
      lifecycle?.onRemoved?.();
      await flushSessionEventCommits();
      expect(terminal).toHaveBeenCalledWith(
        { projectId: 'project-1', worktreeId: 'worktree-1', chatId: 'chat-1' },
        'cancelled',
        'removed-turn',
      );
    } finally {
      terminal.mockRestore();
    }
  });

  it('commits a synchronous terminal event before session removal releases the queue gate', async () => {
    const terminal = jest
      .spyOn(chatQueueServiceModule.getChatQueueService(), 'onTurnTerminal')
      .mockImplementation();
    const beforeEvent = jest.fn(() => Promise.resolve());
    try {
      await dispatchWorktreeChatTurn(
        baseOptions({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          userMessageId: 'removed-after-error',
          sdkSessionId: 'root-thread',
          onBeforeChatEvent: beforeEvent,
        }),
      );
      const session = getMockSession(0);
      session.__onEvent({
        type: 'codex',
        event: {
          type: 'error',
          thread_id: 'root-thread',
          message: 'Usage limit exceeded',
          codexErrorInfo: 'usageLimitExceeded',
        },
        canopy_turn_user_message_id: 'removed-after-error',
      });
      getOrCreateSessionMock.mock.calls[0]?.[3]?.onRemoved?.();
      await flushSessionEventCommits();
      expect(beforeEvent).toHaveBeenCalledTimes(1);
      expect(terminal).toHaveBeenCalledTimes(1);
      expect(terminal).toHaveBeenCalledWith(
        { projectId: 'project-1', worktreeId: 'worktree-1', chatId: 'chat-1' },
        'error',
        'removed-after-error',
      );
    } finally {
      terminal.mockRestore();
    }
  });

  it('releases a native usage error once even when canonical state rejects the trailing result', async () => {
    const terminal = jest
      .spyOn(chatQueueServiceModule.getChatQueueService(), 'onTurnTerminal')
      .mockImplementation();
    const beforeEvent = jest.fn((event: { data: unknown }) => {
      const data = event.data;
      return Promise.resolve(
        typeof data !== 'object' ||
          data === null ||
          !('type' in data) ||
          data.type !== 'result',
      );
    });
    try {
      await dispatchWorktreeChatTurn(
        baseOptions({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          userMessageId: 'limited-turn',
          sdkSessionId: 'root-thread',
          onBeforeChatEvent: beforeEvent,
        }),
      );
      const session = getMockSession(0);
      session.__onEvent({
        type: 'codex',
        event: {
          type: 'error',
          thread_id: 'child-thread',
          message: 'Child failed',
        },
        canopy_turn_user_message_id: 'limited-turn',
      });
      await flushSessionEventCommits();
      expect(terminal).not.toHaveBeenCalled();
      session.__onEvent({
        type: 'codex',
        event: {
          type: 'error',
          thread_id: 'root-thread',
          message: 'Usage limit exceeded',
          codexErrorInfo: 'usageLimitExceeded',
        },
        canopy_turn_user_message_id: 'stale-turn',
      });
      await flushSessionEventCommits();
      expect(terminal).not.toHaveBeenCalled();
      session.__onEvent({
        type: 'codex',
        event: {
          type: 'error',
          thread_id: 'root-thread',
          message: 'Usage limit exceeded',
          codexErrorInfo: 'usageLimitExceeded',
        },
        canopy_turn_user_message_id: 'limited-turn',
      });
      session.__onEvent({
        type: 'result',
        is_error: true,
        result: 'Usage limit exceeded',
        canopy_turn_user_message_id: 'limited-turn',
      });
      await flushSessionEventCommits();
      getOrCreateSessionMock.mock.calls[0]?.[3]?.onRemoved?.();
      await flushSessionEventCommits();
      expect(terminal).toHaveBeenCalledTimes(1);
      expect(terminal).toHaveBeenCalledWith(
        { projectId: 'project-1', worktreeId: 'worktree-1', chatId: 'chat-1' },
        'error',
        'limited-turn',
      );
    } finally {
      terminal.mockRestore();
    }
  });

  it('preserves the logical queue gate while a deferred-tools reload removes its transport', async () => {
    const terminal = jest
      .spyOn(chatQueueServiceModule.getChatQueueService(), 'onTurnTerminal')
      .mockImplementation();
    const reload = jest
      .spyOn(deferredToolsReloadCoordinator, 'hasActiveReload')
      .mockReturnValue(true);
    try {
      await dispatchWorktreeChatTurn(
        baseOptions({ projectId: 'project-1', worktreeId: 'worktree-1' }),
      );
      getOrCreateSessionMock.mock.calls[0]?.[3]?.onRemoved?.();
      await flushSessionEventCommits();
      expect(terminal).not.toHaveBeenCalled();
    } finally {
      terminal.mockRestore();
      reload.mockRestore();
    }
  });

  it('removes the current handler when the session is unregistered', async () => {
    await dispatchWorktreeChatTurn(baseOptions());
    const lifecycle = getOrCreateSessionMock.mock.calls[0]?.[3];

    expect(worktreeChatTurnTestExports.currentSessionEventHandlerCount()).toBe(
      1,
    );
    lifecycle?.onRemoved?.();
    expect(worktreeChatTurnTestExports.currentSessionEventHandlerCount()).toBe(
      0,
    );
  });

  it('preserves a replacement event route when the previous session is unregistered', async () => {
    let previousLifecycle: MockSessionLifecycle | undefined;
    let replacementSession: MockAgentSession | undefined;
    getOrCreateSessionMock.mockImplementation(
      (
        _options: unknown,
        onEvent: (data: unknown) => void,
        _getWindow?: () => unknown,
        lifecycle?: MockSessionLifecycle,
      ): MockAgentSession => {
        if (!previousLifecycle) {
          previousLifecycle = lifecycle;
          return makeMockSessionForEventHandler(onEvent);
        }

        previousLifecycle.onRemoved?.();
        replacementSession = makeMockSessionForEventHandler(onEvent);
        return replacementSession;
      },
    );

    await dispatchWorktreeChatTurn(baseOptions({ userMessageId: 'msg-1' }));
    const onBeforeReplacementEvent = jest.fn(() => Promise.resolve());
    await dispatchWorktreeChatTurn(
      baseOptions({
        userMessageId: 'msg-2',
        onBeforeChatEvent: onBeforeReplacementEvent,
      }),
    );

    replacementSession?.__onEvent({
      type: 'assistant',
      canopy_turn_user_message_id: 'msg-2',
    });
    await flushSessionEventCommits();

    expect(onBeforeReplacementEvent).toHaveBeenCalledTimes(1);
    expect(worktreeChatTurnTestExports.currentSessionEventHandlerCount()).toBe(
      1,
    );
  });

  it('captures a new diff baseline for an autonomously picked up steering input', async () => {
    await dispatchWorktreeChatTurn(
      baseOptions({ projectId: 'project-1', worktreeId: 'worktree-1' }),
    );
    expect(captureTurnStartMock).toHaveBeenCalledTimes(1);
    const session = getMockSession(0);
    Object.assign(session, {
      getSteeringCapabilities: () => ({
        generation: 'g1',
        provider: 'claude',
        steer: true,
        withdraw: true,
        interrupt: true,
      }),
    });
    session.__onEvent({
      type: 'result',
      subtype: 'success',
      canopy_turn_user_message_id: 'msg-1',
    });
    await flushSessionEventCommits();
    session.__onEvent({
      type: 'canopy_input_delivery',
      provider: 'claude',
      generation: 'g1',
      attemptId: 'a1',
      phase: 'picked-up',
      startsTurn: true,
      userMessageId: 'steered-1',
    });
    await flushSessionEventCommits();
    expect(captureTurnStartMock).toHaveBeenCalledTimes(2);
    session.__onEvent({
      type: 'result',
      subtype: 'success',
      canopy_turn_user_message_id: 'steered-1',
    });
    await flushSessionEventCommits();
    expect(captureTurnEndAndDiffMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['its provider turn ends', 'terminal'],
    ['its session is removed', 'removal'],
  ] as const)(
    'releases the host queue gate of a steering pickup with no input-delivery row once %s',
    async (_release, trigger) => {
      const target = {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: `chat-unledgered-pickup-${trigger}`,
      };
      const queueService = chatQueueServiceModule.getChatQueueService();
      // The gate as an ordinary queue dispatch of this turn leaves it.
      queueService.invalidatePendingInputOperations(target);
      queueService.confirmTurnRevived(target, 'msg-1');
      // A delegate's upward steer is submitted straight to the provider session,
      // so canonical state has no input-delivery row for its pickup and reports
      // the event as not applied.
      const onBeforeChatEvent = jest.fn(
        ({ data }: { data: unknown }): Promise<boolean> =>
          Promise.resolve(
            !(
              typeof data === 'object' &&
              data !== null &&
              'type' in data &&
              data.type === 'canopy_input_delivery'
            ),
          ),
      );

      try {
        await dispatchWorktreeChatTurn(
          baseOptions({ ...target, onBeforeChatEvent }),
        );
        const session = getMockSession(0);
        Object.assign(session, {
          getSteeringCapabilities: () => ({
            generation: 'g1',
            provider: 'claude',
            steer: true,
            withdraw: true,
            interrupt: true,
          }),
        });
        session.__onEvent({
          type: 'result',
          subtype: 'success',
          canopy_turn_user_message_id: 'msg-1',
        });
        await flushSessionEventCommits();
        expect(queueService.isTurnActive(target)).toBe(false);

        session.__onEvent({
          type: 'canopy_input_delivery',
          provider: 'claude',
          generation: 'g1',
          attemptId: 'upward-1',
          phase: 'picked-up',
          startsTurn: true,
          userMessageId: 'upward-1',
        });
        await flushSessionEventCommits();
        session.__onEvent({
          type: 'assistant',
          canopy_turn_user_message_id: 'upward-1',
        });
        await flushSessionEventCommits();
        expect(queueService.isTurnActive(target)).toBe(true);

        if (trigger === 'terminal') {
          session.__onEvent({
            type: 'result',
            subtype: 'success',
            canopy_turn_user_message_id: 'upward-1',
          });
        } else {
          getOrCreateSessionMock.mock.calls[0]?.[3]?.onRemoved?.();
        }
        await flushSessionEventCommits();
        await flushSessionEventCommits();

        // No provider turn remains, so queued messages must be able to drain.
        expect(queueService.isTurnActive(target)).toBe(false);
      } finally {
        queueService.resetForTests();
      }
    },
  );

  it('commits a late pickup and reply when the preceding turn diff finishes afterward', async () => {
    let releaseCapture: ((value: unknown) => void) | undefined;
    const captureBlocked = new Promise<unknown>((resolve) => {
      releaseCapture = resolve;
    });
    captureTurnEndAndDiffMock.mockReturnValueOnce(captureBlocked);
    const committedEvents: unknown[] = [];
    const onBeforeChatEvent = jest.fn(
      ({ data }: { data: unknown }): Promise<void> => {
        committedEvents.push(data);
        return Promise.resolve();
      },
    );
    const committedEvent = (type: string): unknown =>
      committedEvents.find(
        (data) =>
          typeof data === 'object' &&
          data !== null &&
          'type' in data &&
          data.type === type,
      );

    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        onBeforeChatEvent,
      }),
    );
    const session = getMockSession(0);
    Object.assign(session, {
      getSteeringCapabilities: () => ({
        generation: 'g1',
        provider: 'claude',
        steer: true,
        withdraw: true,
        interrupt: true,
      }),
    });
    session.__onEvent({
      type: 'result',
      subtype: 'success',
      canopy_turn_user_message_id: 'msg-1',
    });
    await flushSessionEventCommits();
    expect(captureTurnEndAndDiffMock).toHaveBeenCalledTimes(1);

    session.__onEvent({
      type: 'canopy_input_delivery',
      provider: 'claude',
      generation: 'g1',
      attemptId: 'a1',
      phase: 'picked-up',
      startsTurn: true,
      userMessageId: 'steered-1',
    });
    await flushSessionEventCommits();
    try {
      expect(committedEvent('canopy_input_delivery')).toMatchObject({
        type: 'canopy_input_delivery',
        phase: 'picked-up',
        userMessageId: 'steered-1',
      });
    } finally {
      releaseCapture?.({
        files: [],
        totalInsertions: 0,
        totalDeletions: 0,
        capturedAt: 1,
        treeRefs: [],
      });
    }
    session.__onEvent({
      type: 'assistant',
      canopy_turn_user_message_id: 'steered-1',
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(captureTurnStartMock).toHaveBeenCalledTimes(2);
    expect(committedEvent('turn_diff')).toMatchObject({
      type: 'turn_diff',
      userMessageId: 'msg-1',
    });
    expect(committedEvent('assistant')).toMatchObject({
      type: 'assistant',
      canopy_turn_user_message_id: 'steered-1',
    });
  });

  it('preserves a newer active turn when a late autonomous pickup is rejected', async () => {
    const firstTurnHandler = jest.fn();
    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'my-project',
        worktreeId: 'wt-1',
        userMessageId: 'msg-1',
        onChatEvent: firstTurnHandler,
      }),
    );
    getMockSession(0).__onEvent({
      type: 'result',
      is_error: false,
      canopy_turn_user_message_id: 'msg-1',
    });
    await flushSessionEventCommits();

    const secondTurnHandler = jest.fn();
    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'my-project',
        worktreeId: 'wt-1',
        userMessageId: 'msg-2',
        onChatEvent: secondTurnHandler,
      }),
    );
    const queueService = chatQueueServiceModule.getChatQueueService();
    const onTurnRevived = jest
      .spyOn(queueService, 'onTurnRevived')
      .mockReturnValue(false);
    try {
      const session = getMockSession(1);
      session.__onEvent({
        type: 'canopy_input_delivery',
        provider: 'claude',
        generation: 'g1',
        attemptId: 'late-a1',
        phase: 'picked-up',
        startsTurn: true,
        userMessageId: 'stale-steered-1',
      });
      session.__onEvent({
        type: 'assistant',
        canopy_turn_user_message_id: 'msg-2',
      });
      await flushSessionEventCommits();

      expect(onTurnRevived).toHaveBeenCalledWith(
        {
          projectId: 'my-project',
          worktreeId: 'wt-1',
          chatId: 'chat-1',
        },
        'stale-steered-1',
      );
      expect(
        worktreeChatTurnTestExports.activeTurnUserMessageId(
          'my-project',
          'wt-1',
          'chat-1',
        ),
      ).toBe('msg-2');
      expect(secondTurnHandler).toHaveBeenCalledTimes(2);
    } finally {
      onTurnRevived.mockRestore();
    }
  });

  it('exposes a lifecycle drain that waits for queued provider event commits', async () => {
    let releaseCommit: (() => void) | undefined;
    const commitBlocked = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const onBeforeChatEvent = jest.fn(() => commitBlocked);

    await dispatchWorktreeChatTurn(baseOptions({ onBeforeChatEvent }));
    getMockSession(0).__onEvent({
      type: 'assistant',
      canopy_turn_user_message_id: 'msg-1',
    });

    const lifecycle = getOrCreateSessionMock.mock.calls[0]?.[3];
    const drain = lifecycle?.drainEventsBeforeRemoval;
    expect(drain).toEqual(expect.any(Function));
    let drained = false;
    const drainPromise = drain?.().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(onBeforeChatEvent).toHaveBeenCalledTimes(1);
    expect(drained).toBe(false);

    releaseCommit?.();
    await drainPromise;
    expect(drained).toBe(true);
  });

  it('preserves a fast provider prefix behind a slow worktree commit', async () => {
    let releaseCommit = (): void => undefined;
    const commitBlocked = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const committed: number[] = [];
    const onBeforeChatEvent = jest.fn(async ({ data }: { data: unknown }) => {
      await commitBlocked;
      if (
        typeof data === 'object' &&
        data !== null &&
        'sequence' in data &&
        typeof data.sequence === 'number'
      ) {
        committed.push(data.sequence);
      }
    });
    await dispatchWorktreeChatTurn(baseOptions({ onBeforeChatEvent }));
    const session = getMockSession(0);
    const events = [
      ...Array.from({ length: 128 }, (_, sequence) => ({
        type: 'assistant',
        canopy_turn_user_message_id: 'msg-1',
        sequence,
        payload: 'x'.repeat(2048),
      })),
      {
        type: 'result',
        canopy_turn_user_message_id: 'msg-1',
        sequence: 128,
        result: 'Done',
      },
    ];
    const largestFrameBytes = Math.max(
      ...events.map((event) =>
        Buffer.byteLength(JSON.stringify(event), 'utf8'),
      ),
    );
    const drain =
      getOrCreateSessionMock.mock.calls[0]?.[3]?.drainEventsBeforeRemoval;
    if (!drain) throw new Error('Missing worktree provider drain');
    let produced = 0;
    let producedBytes = 0;
    const producer = (async (): Promise<void> => {
      for (const event of events) {
        await Promise.resolve(session.__onEvent(event));
        produced += 1;
        producedBytes += Buffer.byteLength(JSON.stringify(event), 'utf8');
      }
    })();
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(committed).toHaveLength(0);
      expect(onBeforeChatEvent).toHaveBeenCalledTimes(1);
      process.stdout.write(
        `WORKTREE_PRESSURE_METRIC ${JSON.stringify({
          produced,
          retainedBytesLowerBound: producedBytes,
          startedCommitCalls: onBeforeChatEvent.mock.calls.length,
        })}\n`,
      );
      expect(producedBytes).toBeLessThanOrEqual(64 * 1024 + largestFrameBytes);
    } finally {
      releaseCommit();
      await producer;
      await drain();
    }
    expect(produced).toBe(events.length);
    expect(committed).toEqual(events.map((event) => event.sequence));
  });

  it('drains completed turn-diff capture and its durable event commit', async () => {
    let releaseCapture: ((value: unknown) => void) | undefined;
    const captureBlocked = new Promise<unknown>((resolve) => {
      releaseCapture = resolve;
    });
    captureTurnEndAndDiffMock.mockReturnValueOnce(captureBlocked);
    let releaseDiffCommit: (() => void) | undefined;
    const diffCommitBlocked = new Promise<void>((resolve) => {
      releaseDiffCommit = resolve;
    });
    let markDiffCommitStarted: (() => void) | undefined;
    const diffCommitStarted = new Promise<void>((resolve) => {
      markDiffCommitStarted = resolve;
    });
    const onBeforeChatEvent = jest.fn(
      ({ data }: { data: unknown }): Promise<void> => {
        if (
          typeof data === 'object' &&
          data !== null &&
          'type' in data &&
          data.type === 'turn_diff'
        ) {
          markDiffCommitStarted?.();
          return diffCommitBlocked;
        }
        return Promise.resolve();
      },
    );

    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'my-project',
        worktreeId: 'wt-1',
        onBeforeChatEvent,
      }),
    );
    getMockSession(0).__onEvent({
      type: 'result',
      is_error: false,
      result: 'ok',
    });

    const drain =
      getOrCreateSessionMock.mock.calls[0]?.[3]?.drainEventsBeforeRemoval;
    expect(drain).toEqual(expect.any(Function));
    let drained = false;
    const drainPromise = drain?.().then(() => {
      drained = true;
    });
    await flushSessionEventCommits();
    expect(captureTurnEndAndDiffMock).toHaveBeenCalledTimes(1);
    try {
      expect(drained).toBe(false);
    } finally {
      releaseCapture?.({
        files: [],
        totalInsertions: 0,
        totalDeletions: 0,
        capturedAt: 1,
        treeRefs: [],
      });
    }

    try {
      await diffCommitStarted;
      expect(drained).toBe(false);
    } finally {
      releaseDiffCommit?.();
    }
    await drainPromise;
    expect(onBeforeChatEvent).toHaveBeenCalledTimes(2);
    const durableTurnDiffCall: unknown = onBeforeChatEvent.mock.calls[1]?.[0];
    expect(durableTurnDiffCall).toMatchObject({
      data: {
        type: 'turn_diff',
        userMessageId: 'msg-1',
      },
    });
  });

  it('lets a reused session drain the current turn event commits', async () => {
    let retainedProviderCallback: ((data: unknown) => void) | undefined;
    const sharedSession: MockAgentSession = {
      sendMessage: sendMessageMock,
      setPlanMode: setPlanModeMock,
      getProviderSessionId: getProviderSessionIdMock,
      __onEvent: (data: unknown) => retainedProviderCallback?.(data),
    };
    getOrCreateSessionMock.mockImplementation((_options, onEvent) => {
      retainedProviderCallback ??= onEvent;
      return sharedSession;
    });

    await dispatchWorktreeChatTurn(baseOptions({ userMessageId: 'msg-1' }));
    const providerBoundDrain =
      getOrCreateSessionMock.mock.calls[0]?.[3]?.drainEventsBeforeRemoval;
    expect(providerBoundDrain).toEqual(expect.any(Function));

    let releaseSecondCommit: (() => void) | undefined;
    const secondCommitBlocked = new Promise<void>((resolve) => {
      releaseSecondCommit = resolve;
    });
    const onBeforeSecondEvent = jest.fn(() => secondCommitBlocked);
    await dispatchWorktreeChatTurn(
      baseOptions({
        userMessageId: 'msg-2',
        onBeforeChatEvent: onBeforeSecondEvent,
      }),
    );
    retainedProviderCallback?.({
      type: 'assistant',
      canopy_turn_user_message_id: 'msg-2',
    });

    let drained = false;
    const drainPromise = providerBoundDrain?.().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(onBeforeSecondEvent).toHaveBeenCalledTimes(1);
    expect(drained).toBe(false);

    releaseSecondCommit?.();
    await drainPromise;
    expect(drained).toBe(true);
  });

  it('keeps an older reused-session turn-diff drain reachable during teardown', async () => {
    let retainedProviderCallback: ((data: unknown) => void) | undefined;
    const sharedSession: MockAgentSession = {
      sendMessage: sendMessageMock,
      setPlanMode: setPlanModeMock,
      getProviderSessionId: getProviderSessionIdMock,
      __onEvent: (data: unknown) => retainedProviderCallback?.(data),
    };
    getOrCreateSessionMock.mockImplementation((_options, onEvent) => {
      retainedProviderCallback ??= onEvent;
      return sharedSession;
    });
    let releaseFirstCapture: ((value: unknown) => void) | undefined;
    const firstCaptureBlocked = new Promise<unknown>((resolve) => {
      releaseFirstCapture = resolve;
    });
    captureTurnEndAndDiffMock.mockReturnValueOnce(firstCaptureBlocked);
    const onBeforeFirstEvent = jest.fn(() => Promise.resolve());

    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'my-project',
        worktreeId: 'wt-1',
        userMessageId: 'msg-1',
        onBeforeChatEvent: onBeforeFirstEvent,
      }),
    );
    const providerBoundDrain =
      getOrCreateSessionMock.mock.calls[0]?.[3]?.drainEventsBeforeRemoval;
    retainedProviderCallback?.({
      type: 'result',
      is_error: false,
      result: 'ok',
      canopy_turn_user_message_id: 'msg-1',
    });
    await flushSessionEventCommits();
    expect(captureTurnEndAndDiffMock).toHaveBeenCalledTimes(1);

    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'my-project',
        worktreeId: 'wt-1',
        userMessageId: 'msg-2',
        onBeforeChatEvent: jest.fn(() => Promise.resolve()),
      }),
    );
    await flushSessionEventCommits();

    let drained = false;
    const drainPromise = providerBoundDrain?.().then(() => {
      drained = true;
    });
    try {
      const outcome = await Promise.race([
        drainPromise?.then(() => 'drained' as const),
        new Promise<'blocked'>((resolve) => {
          setTimeout(() => resolve('blocked'), 20);
        }),
      ]);
      expect(outcome).toBe('blocked');
      expect(drained).toBe(false);
    } finally {
      releaseFirstCapture?.({
        files: [],
        totalInsertions: 0,
        totalDeletions: 0,
        capturedAt: 1,
        treeRefs: [],
      });
    }

    await drainPromise;
    expect(onBeforeFirstEvent).toHaveBeenCalledTimes(2);
  });

  it('does not let stale session cleanup remove a replacement handler', async () => {
    const terminal = jest
      .spyOn(chatQueueServiceModule.getChatQueueService(), 'onTurnTerminal')
      .mockImplementation();
    const firstTurnHandler = jest.fn();
    const secondTurnHandler = jest.fn();

    await dispatchWorktreeChatTurn(
      baseOptions({ userMessageId: 'msg-1', onChatEvent: firstTurnHandler }),
    );
    const firstLifecycle = getOrCreateSessionMock.mock.calls[0]?.[3];
    await dispatchWorktreeChatTurn(
      baseOptions({ userMessageId: 'msg-2', onChatEvent: secondTurnHandler }),
    );
    const secondSession = getMockSession(1);

    firstLifecycle?.onRemoved?.();
    secondSession.__onEvent({
      type: 'assistant',
      canopy_turn_user_message_id: 'msg-2',
    });
    await flushSessionEventCommits();

    expect(worktreeChatTurnTestExports.currentSessionEventHandlerCount()).toBe(
      1,
    );
    expect(firstTurnHandler).not.toHaveBeenCalled();
    expect(secondTurnHandler).toHaveBeenCalledTimes(1);
    expect(terminal).not.toHaveBeenCalled();
    terminal.mockRestore();
  });

  it('CAN-2835 rejects even untagged output from a replaced provider session', async () => {
    const first = jest.fn();
    const second = jest.fn();
    await dispatchWorktreeChatTurn(
      baseOptions({ userMessageId: 'old', onChatEvent: first }),
    );
    const oldSession = getMockSession(0);
    await dispatchWorktreeChatTurn(
      baseOptions({ userMessageId: 'new', onChatEvent: second }),
    );
    oldSession.__onEvent({ type: 'assistant', message: 'obsolete generation' });
    await flushSessionEventCommits();
    expect(second).not.toHaveBeenCalled();
    getMockSession(1).__onEvent({
      type: 'assistant',
      canopy_turn_user_message_id: 'new',
    });
    await flushSessionEventCommits();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('removes the handler when session creation fails', async () => {
    getOrCreateSessionMock.mockRejectedValueOnce(
      new Error('session creation failed'),
    );

    await expect(dispatchWorktreeChatTurn(baseOptions())).rejects.toThrow(
      'session creation failed',
    );
    expect(worktreeChatTurnTestExports.currentSessionEventHandlerCount()).toBe(
      0,
    );
  });
});

describe('dispatchWorktreeChatTurn cowork treatment for a real cowork project id', () => {
  it('attributes the ordinary cowork turn after an autonomous pickup to its new message', async () => {
    const firstTurnHandler = jest.fn();
    await dispatchWorktreeChatTurn(
      baseOptions({ userMessageId: 'msg-1', onChatEvent: firstTurnHandler }),
    );
    const queueService = chatQueueServiceModule.getChatQueueService();
    const onTurnRevived = jest
      .spyOn(queueService, 'onTurnRevived')
      .mockReturnValue(true);
    try {
      const firstSession = getMockSession(0);
      firstSession.__onEvent({
        type: 'canopy_input_delivery',
        provider: 'claude',
        generation: 'g1',
        attemptId: 'a1',
        phase: 'picked-up',
        startsTurn: true,
        userMessageId: 'steered-1',
      });
      firstSession.__onEvent({
        type: 'result',
        is_error: false,
        canopy_turn_user_message_id: 'steered-1',
      });
      await flushSessionEventCommits();

      const secondTurnHandler = jest.fn();
      await dispatchWorktreeChatTurn(
        baseOptions({
          userMessageId: 'msg-2',
          onChatEvent: secondTurnHandler,
        }),
      );
      getMockSession(1).__onEvent({
        type: 'assistant',
        canopy_turn_user_message_id: 'msg-2',
      });
      await flushSessionEventCommits();

      expect(
        worktreeChatTurnTestExports.activeTurnUserMessageId(
          'cowork-default',
          'home',
          'chat-1',
        ),
      ).toBeUndefined();
      expect(secondTurnHandler).toHaveBeenCalledTimes(1);
    } finally {
      onTurnRevived.mockRestore();
    }
  });

  it.each(['my-project', 'cowork-default'])(
    'passes explicit OpenCode attachment selection with its trusted root (%s)',
    async (projectId) => {
      const attachmentPaths = ['/selected/attachment.png'];
      await dispatchWorktreeChatTurn(
        baseOptions({
          projectId,
          providerType: 'opencode',
          model: 'opencode:fixture%2Fmodel',
          executionHarness: 'opencode',
          attachmentPaths,
        }),
      );
      expect(sendMessageMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          attachments: {
            paths: attachmentPaths,
            baseDir:
              buildSubmittedMessageTextMock.mock.calls[0]?.[0]
                .attachmentBaseDir,
          },
        }),
      );
    },
  );

  it('uses the cowork managed attachments dir under the resolved home cwd', async () => {
    await dispatchWorktreeChatTurn(baseOptions());

    expect(mockResolveWorktreeCwd).toHaveBeenCalledWith(
      'cowork-default',
      'home',
      undefined,
    );
    const call = buildSubmittedMessageTextMock.mock.calls[0]?.[0];
    expect(call?.attachmentBaseDir).toBe(
      getCoworkManagedSubdir('/mock/cowork-home', 'attachments'),
    );
  });

  it('passes an external agent sender to the submitted message', async () => {
    const agentSent: AgentSentInfo = {
      kind: 'external_agent',
      connectionId: '123e4567-e89b-42d3-a456-426614174000',
      clientName: 'Claude Desktop',
      verified: true,
      userId: '123e4567-e89b-42d3-a456-426614174001',
    };

    await dispatchWorktreeChatTurn(baseOptions({ agentSent }));

    expect(buildSubmittedMessageTextMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ agentSent }),
    );
  });

  it('uses the cowork system prompt instead of the worktree injected-tool prompt', async () => {
    await dispatchWorktreeChatTurn(baseOptions());

    const startArgs = startChatTurnMock.mock.calls[0]?.[0];
    const systemPromptAppend = startArgs?.systemPromptAppend;
    expect(typeof systemPromptAppend).toBe('string');
    expect(systemPromptAppend).toContain('cowork project');
    expect(systemPromptAppend).toContain(
      "absent from the agent's current Skills list and callable tool surface",
    );
    expect(systemPromptAppend).toContain(
      'never search for or load a skill, plugin, MCP server, or command that is already available',
    );
    expect(systemPromptAppend).not.toBe('worktree-injected-prompt');
  });

  it('classifies real cowork turns as standalone with project navigation', async () => {
    await dispatchWorktreeChatTurn(baseOptions());

    expect(startChatTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'cowork-default',
        worktreeId: 'home',
        isStandalone: true,
        standaloneProjectId: 'cowork-default',
      }),
    );
  });

  it('schedules worktree summaries on turn end but skips branch naming and usage repo-scope lookups', async () => {
    await dispatchWorktreeChatTurn(baseOptions());

    // Not at dispatch time...
    expect(scheduleSummaryGenerationMock).not.toHaveBeenCalled();
    expect(readWorkspaceConfigMock).not.toHaveBeenCalled();
    expect(captureTurnStartMock).not.toHaveBeenCalled();

    // ...but cowork chats DO get the shared Summary card: the scheduler runs
    // on the terminal event (its cowork branch summarizes folder activity
    // instead of git diffs). Branch naming / usage repo-scope stay skipped.
    const session = getMockSession(0);
    session.__onEvent({ type: 'result', is_error: false, result: 'ok' });
    await flushSessionEventCommits();
    expect(scheduleSummaryGenerationMock).toHaveBeenCalled();
    expect(readWorkspaceConfigMock).not.toHaveBeenCalled();
  });

  it('reports the App Advisor watcher scope as standalone on turn completion', async () => {
    await dispatchWorktreeChatTurn(baseOptions());

    const session = getMockSession(0);
    session.__onEvent({ type: 'result', is_error: false, result: 'ok' });
    await flushSessionEventCommits();

    expect(handleCanonicalChatTerminalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        address: {
          projectId: 'cowork-default',
          taskId: 'home',
          chatId: 'chat-1',
        },
        sourceInputId: 'msg-1',
      }),
    );
  });

  it('reports the App Advisor watcher scope as standalone on new-chat start', async () => {
    await dispatchWorktreeChatTurn(baseOptions({ startsNewTrackedChat: true }));

    expect(handleCanonicalChatStartedEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        address: {
          projectId: 'cowork-default',
          taskId: 'home',
          chatId: 'chat-1',
        },
        sourceInputId: 'msg-1',
      }),
    );
  });
});

describe('dispatchWorktreeChatTurn global instructions injection', () => {
  it('does not carry a cleared non-Cursor snapshot into a new Cursor provider session', async () => {
    composeRepoRulesMock.mockResolvedValue('Unexpected new rules.');
    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'my-project',
        providerType: 'cursor',
        globalInstructionsSnapshot:
          '# Imported repository instructions\nOld non-Cursor rules.',
      }),
    );
    expect(composeRepoRulesMock).not.toHaveBeenCalled();
    expect(readSessionSystemPromptAppend()).not.toContain(
      'Old non-Cursor rules.',
    );
  });
  it('does not reuse a live non-Cursor session snapshot for a new Cursor session', async () => {
    composeRepoRulesMock.mockResolvedValue('Unexpected new rules.');
    getSessionGlobalInstructionsSnapshotMock.mockReturnValue(
      '# Imported repository instructions\nLive Codex rules.',
    );
    getSessionProviderTypeMock.mockReturnValue('codex');
    await dispatchWorktreeChatTurn(
      baseOptions({ projectId: 'my-project', providerType: 'cursor' }),
    );
    expect(composeRepoRulesMock).not.toHaveBeenCalled();
    expect(readSessionSystemPromptAppend()).not.toContain('Live Codex rules.');
  });
  it('composes fresh instructions when a live session from another provider is replaced', async () => {
    composeRepoRulesMock.mockResolvedValue(
      '# Imported repository instructions\n\nFresh rule.',
    );
    getSessionGlobalInstructionsSnapshotMock.mockReturnValue(
      'Claude session snapshot.',
    );
    getSessionProviderTypeMock.mockReturnValue('claude');
    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'my-project',
        worktreeId: 'wt-1',
        providerType: 'codex',
      }),
    );
    expect(readSessionSystemPromptAppend()).toContain('Fresh rule.');
    expect(readSessionSystemPromptAppend()).not.toContain(
      'Claude session snapshot.',
    );
  });
  it('keeps a live same-provider session snapshot without reading rules again', async () => {
    composeRepoRulesMock.mockResolvedValue('Unexpected new rules.');
    getSessionGlobalInstructionsSnapshotMock.mockReturnValue(
      'Live Codex snapshot.',
    );
    getSessionProviderTypeMock.mockReturnValue('codex');
    await dispatchWorktreeChatTurn(
      baseOptions({ projectId: 'my-project', providerType: 'codex' }),
    );
    expect(composeRepoRulesMock).not.toHaveBeenCalled();
    expect(readSessionSystemPromptAppend()).toContain('Live Codex snapshot.');
  });
  it.each(['claude', 'codex'] as const)(
    'captures repo instructions for a new %s code session',
    async (providerType) => {
      composeRepoRulesMock.mockResolvedValue(
        '# Imported repository instructions\n\nEnabled rule.',
      );
      await dispatchWorktreeChatTurn(
        baseOptions({
          projectId: 'my-project',
          worktreeId: 'wt-1',
          providerType,
        }),
      );
      expect(composeRepoRulesMock).toHaveBeenCalledWith(
        'my-project',
        'wt-1',
        '/mock/cowork-home',
      );
      expect(readSessionSystemPromptAppend()).toContain('Enabled rule.');
      const sessionOptions: unknown = getOrCreateSessionMock.mock.calls[0]?.[0];
      if (
        typeof sessionOptions !== 'object' ||
        sessionOptions === null ||
        !('globalInstructionsBlock' in sessionOptions)
      )
        throw new Error('Missing instruction snapshot');
      expect(sessionOptions.globalInstructionsBlock).toContain('Enabled rule.');
    },
  );
  it.each([
    { projectId: 'cowork-default' },
    { projectId: 'my-project', providerType: 'cursor' as const },
    {
      projectId: 'my-project',
      sdkSessionId: 'resume',
      globalInstructionsSnapshot: '',
    },
    { projectId: 'my-project', sdkSessionId: 'legacy' },
  ])('does not compose excluded or resumed sessions: %j', async (options) => {
    composeRepoRulesMock.mockResolvedValue('Unexpected new rules.');
    await dispatchWorktreeChatTurn(baseOptions(options));
    expect(composeRepoRulesMock).not.toHaveBeenCalled();
    expect(readSessionSystemPromptAppend()).not.toContain(
      'Unexpected new rules.',
    );
  });
  function readSessionSystemPromptAppend(): string {
    const options: unknown = getOrCreateSessionMock.mock.calls[0]?.[0];
    if (typeof options !== 'object' || options === null) {
      throw new Error('Expected session options for the dispatched turn');
    }
    if (!('systemPromptAppend' in options)) {
      throw new Error('Expected systemPromptAppend on session options');
    }
    const append = options.systemPromptAppend;
    if (typeof append !== 'string') {
      throw new Error('Expected a string systemPromptAppend');
    }
    const globalBlock =
      'globalInstructionsBlock' in options
        ? options.globalInstructionsBlock
        : undefined;
    return typeof globalBlock === 'string' && globalBlock.length > 0
      ? `${append}\n\n${globalBlock}`
      : append;
  }

  it.each(['claude', 'cursor'] as const)(
    'advertises local memory only to a capable %s harness',
    async (providerType) => {
      readPreferencesFileMock.mockResolvedValue({
        orgMemoryInjectionEnabled: false,
        localMemoryEnabled: true,
      });
      await dispatchWorktreeChatTurn(
        baseOptions({
          projectId: 'my-project',
          worktreeId: 'wt-1',
          providerType,
          model: providerType === 'cursor' ? 'cursor-default' : 'sonnet',
          executionHarness: providerType,
        }),
      );
      const append = readSessionSystemPromptAppend();
      if (providerType === 'cursor') {
        // The Cursor session appends the tool and memory steering itself once
        // it knows the app's MCP servers actually reached the CLI.
        expect(append).not.toMatch(/SaveMemory|SearchMemory|memory_citation/);
        expect(mockBuildWorktreeInjectedToolPrompt).not.toHaveBeenCalled();
      } else {
        expect(append).toContain('SaveMemory');
        expect(append).toContain('SearchMemory');
        expect(mockBuildWorktreeInjectedToolPrompt).toHaveBeenCalledWith(
          providerType,
          true,
        );
      }
    },
  );

  it('appends the User Overall Preferences block for a matching cowork scope', async () => {
    readPreferencesFileMock.mockResolvedValue({
      orgMemoryInjectionEnabled: false,
      globalInstructions: {
        chats: {
          overall: 'Always be terse.',
          scoped: [
            {
              id: 'cowork-only',
              text: 'Cowork sessions: prefer bullet lists.',
              mode: 'append',
              harnesses: [],
              models: [],
              workspaceTypes: ['cowork'],
            },
            {
              id: 'code-only',
              text: 'Code sessions only.',
              mode: 'append',
              harnesses: [],
              models: [],
              workspaceTypes: ['code'],
            },
          ],
        },
        pipelines: { overall: '', scoped: [] },
      },
    });

    await dispatchWorktreeChatTurn(baseOptions());

    const append = readSessionSystemPromptAppend();
    expect(append).toContain(
      '# User Overall Preferences\n\nAlways be terse.\n\nCowork sessions: prefer bullet lists.',
    );
    expect(append).not.toContain('Code sessions only.');
    // The block lands after the cowork system prompt, not instead of it.
    expect(append).toContain('cowork project');
  });

  it('records the original instruction snapshot when resuming a provider session', async () => {
    readPreferencesFileMock.mockResolvedValue({
      orgMemoryInjectionEnabled: false,
      globalInstructions: {
        chats: {
          overall: 'Do not record this on resume.',
          scoped: [],
        },
        pipelines: { overall: '', scoped: [] },
      },
    });

    await dispatchWorktreeChatTurn(
      baseOptions({
        sdkSessionId: 'provider-session-id',
        globalInstructionsSnapshot:
          '# User Overall Preferences\n\nOriginal snapshot.',
      }),
    );

    const startArgs = startChatTurnMock.mock.calls[0]?.[0];
    expect(startArgs?.systemPromptAppend).toContain('cowork project');
    expect(startArgs?.systemPromptAppend).toContain('Original snapshot.');
    expect(startArgs?.systemPromptAppend).not.toContain(
      'Do not record this on resume.',
    );
  });

  it('applies code-scoped instructions to worktree chats and honors replace mode', async () => {
    readPreferencesFileMock.mockResolvedValue({
      orgMemoryInjectionEnabled: false,
      globalInstructions: {
        chats: {
          overall: 'Overall text.',
          scoped: [
            {
              id: 'code-replace',
              text: 'Replaced construction for Code.',
              mode: 'replace',
              harnesses: [],
              models: [],
              workspaceTypes: ['code'],
            },
          ],
        },
        pipelines: { overall: '', scoped: [] },
      },
    });

    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'my-project',
        worktreeId: 'wt-1',
        providerType: 'claude',
      }),
    );

    const append = readSessionSystemPromptAppend();
    expect(append).toContain(
      '# User Overall Preferences\n\nReplaced construction for Code.',
    );
    expect(append).not.toContain('Overall text.');
  });

  it('adds no block when no global instructions are configured', async () => {
    await dispatchWorktreeChatTurn(baseOptions());

    expect(readSessionSystemPromptAppend()).not.toContain(
      '# User Overall Preferences',
    );
  });

  it('skips harness-scoped instructions that do not match the session provider', async () => {
    readPreferencesFileMock.mockResolvedValue({
      orgMemoryInjectionEnabled: false,
      globalInstructions: {
        chats: {
          overall: '',
          scoped: [
            {
              id: 'codex-only',
              text: 'Codex-only instruction.',
              mode: 'append',
              harnesses: ['codex'],
              models: [],
              workspaceTypes: [],
            },
          ],
        },
        pipelines: { overall: '', scoped: [] },
      },
    });

    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'my-project',
        worktreeId: 'wt-1',
        providerType: 'claude',
      }),
    );

    const append = readSessionSystemPromptAppend();
    expect(append).not.toContain('Codex-only instruction.');
    expect(append).not.toContain('# User Overall Preferences');
  });
});

describe('dispatchWorktreeChatTurn worktree (non-cowork) treatment is unchanged', () => {
  it('passes the trusted quota continuation connection into session allocation', async () => {
    await dispatchWorktreeChatTurn(
      baseOptions({ requiredAccountProxyConnectionId: 'proxy-A' }),
    );
    expect(getOrCreateSessionMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ requiredAccountProxyConnectionId: 'proxy-A' }),
    );
  });

  it('forwards a trusted background execution context into the provider session', async () => {
    const executionContext = 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        executionContext,
      }),
    );

    expect(getOrCreateSessionMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ executionContext }),
    );
  });

  it.each(['automation', 'hook'] as const)(
    'does not infer a new owner for a %s continuation without an execution context',
    async (initiationSource) => {
      await dispatchWorktreeChatTurn(
        baseOptions({
          projectId: 'workspace-1',
          worktreeId: 'worktree-1',
          initiationSource,
        }),
      );

      expect(getOrCreateSessionMock.mock.calls[0]?.[0]).not.toHaveProperty(
        'executionContext',
      );
    },
  );

  it('resolves the effective managed-delegation policy before session reuse', async () => {
    await dispatchWorktreeChatTurn(
      baseOptions({ projectId: 'my-project', worktreeId: 'wt-1' }),
    );

    expect(resolveManagedDelegationModeMock).toHaveBeenCalledWith(undefined);
    expect(getOrCreateSessionMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        managedDelegationSurface: 'worktree-chat',
        managedDelegationMode: 'explicit-only',
      }),
    );
  });

  it('keeps the code review helper surface ineligible for managed delegation', async () => {
    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: CODE_REVIEW_CHAT_PROJECT_ID,
        worktreeId: 'wt-1',
      }),
    );

    expect(getOrCreateSessionMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        managedDelegationSurface: undefined,
        managedDelegationMode: undefined,
      }),
    );
  });

  it('resolves an omitted model from the main-process worktree defaults', async () => {
    readPreferencesFileMock.mockResolvedValue({
      orgMemoryInjectionEnabled: false,
      defaultWorktreeProvider: 'claude',
      defaultWorktreeModelByProvider: {
        claude: { model: 'opus[1m]', thinkingLevel: 'high' },
      },
    });

    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'my-project',
        worktreeId: 'wt-1',
        providerType: 'claude',
      }),
    );

    expect(getOrCreateSessionMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        providerType: 'claude',
        model: 'opus[1m]',
        selectedModel: 'opus[1m]',
      }),
    );
  });

  it('seeds recreated sessions with persisted approval state', async () => {
    const sessionApprovalRules = [
      {
        id: 'rule-1',
        behavior: 'deny' as const,
        target: { kind: 'file-write' as const, path: '.env' },
        createdAt: '2026-07-23T00:00:00.000Z',
        origin: 'prompt' as const,
      },
    ];

    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'my-project',
        worktreeId: 'wt-1',
        approvalMode: 'auto',
        sessionApprovalRules,
      }),
    );

    expect(getOrCreateSessionMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        approvalMode: 'auto',
        sessionApprovalRules,
      }),
    );
  });

  it('keeps an explicit providerType authoritative over a lane-resolved gateway model', async () => {
    // The chat carries a persisted Codex provider lock. A gateway model is
    // routable on either harness, so deriving the provider from the model would
    // silently switch the locked session to Claude for no reason.
    requireLaneAwareDefaultSelectionMock.mockResolvedValueOnce({
      model: 'gateway-any-harness',
      thinkingLevel: 'high',
    });
    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'my-project',
        worktreeId: 'wt-1',
        providerType: 'codex',
      }),
    );

    expect(getOrCreateSessionMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ providerType: 'codex' }),
    );
  });

  it('applies the exact requested Codex speed to the session before sending', async () => {
    const order: string[] = [];
    const setSpeed = jest.fn((speed: string): Promise<void> => {
      order.push(`speed:${speed}`);
      return Promise.resolve();
    });
    getOrCreateSessionMock.mockImplementationOnce((_options, onEvent) => ({
      ...makeMockSessionForEventHandler(onEvent),
      setSpeed,
    }));
    sendMessageMock.mockImplementationOnce(() => {
      order.push('send');
    });

    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'my-project',
        worktreeId: 'wt-1',
        providerType: 'codex',
        model: 'gpt-5.5',
        modelConfig: { speed: 'ultrafast', fastMode: false },
      }),
    );

    expect(order).toEqual(['speed:ultrafast', 'send']);
  });

  it('rejects Ultra fast before sending when the session has only boolean speed setters', async () => {
    const setFastMode = jest.fn((): Promise<void> => Promise.resolve());
    getOrCreateSessionMock.mockImplementationOnce((_options, onEvent) => ({
      ...makeMockSessionForEventHandler(onEvent),
      setFastMode,
    }));

    await expect(
      dispatchWorktreeChatTurn(
        baseOptions({
          projectId: 'my-project',
          worktreeId: 'wt-1',
          providerType: 'codex',
          model: 'gpt-5.5',
          modelConfig: { speed: 'ultrafast', fastMode: false },
        }),
      ),
    ).rejects.toThrow('This session cannot run Ultra fast');

    expect(setFastMode).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('reconciles a forced provider to a cross-lane NATIVE substitution (round-2 finding 7)', async () => {
    // Lane resolution treats a forced providerType as a lane PREFERENCE and
    // falls through when that lane cannot pay — a Codex-locked chat with Codex
    // signed out comes back holding a native CLAUDE model. Pinning `codex` over
    // it paired a Claude model with the Codex harness and tripped the
    // caller-supplied `executionHarness` guard.
    requireLaneAwareDefaultSelectionMock.mockResolvedValueOnce({
      model: 'opus[1m]',
      thinkingLevel: 'high',
    });

    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'my-project',
        worktreeId: 'wt-1',
        providerType: 'codex',
        executionHarness: 'claude',
      }),
    );

    expect(getOrCreateSessionMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        providerType: 'claude',
        model: 'opus[1m]',
      }),
    );
  });

  it('uses the live persisted approval mode when queued authority was revoked', async () => {
    mockReadPersistedChatDispatchMetadata
      .mockResolvedValueOnce({ approvalMode: 'full-access' })
      .mockResolvedValue({ approvalMode: 'ask' });

    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'my-project',
        worktreeId: 'wt-1',
        approvalMode: 'full-access',
      }),
    );

    expect(setApprovalModeMock).toHaveBeenLastCalledWith('ask');
  });

  it('does not let stale persisted metadata restore a revoked live mode', async () => {
    mockReadPersistedChatDispatchMetadata.mockResolvedValue({
      approvalMode: 'full-access',
    });
    setLiveApprovalMode('my-project', 'wt-1', 'chat-1', 'ask');

    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'my-project',
        worktreeId: 'wt-1',
        approvalMode: 'full-access',
      }),
    );

    expect(setApprovalModeMock).toHaveBeenLastCalledWith('ask');
  });

  it('reconciles a substitution against the CALLER persisted harness and drops its session id (round-3 finding 5)', async () => {
    // The round-2 spec passed `executionHarness: 'claude'` — the one
    // combination where the caller already agrees with the substitution. Real
    // callers forward the TAB's persisted fields (the renderer's
    // `stores/chat/slices/messaging.ts` sends `currentTab?.executionHarness`),
    // so a Codex-locked chat arrives holding `executionHarness: 'codex'` AND a
    // Codex thread id. Before this fix the guard hard-threw, and when it did
    // not, the Codex thread id was handed straight to a Claude session.
    requireLaneAwareDefaultSelectionMock.mockResolvedValueOnce({
      model: 'opus[1m]',
      thinkingLevel: 'high',
    });
    readPreferencesFileMock.mockResolvedValue({
      orgMemoryInjectionEnabled: false,
      globalInstructions: {
        chats: {
          overall: 'Fresh Claude-lane instruction.',
          scoped: [],
        },
        pipelines: { overall: '', scoped: [] },
      },
    });

    await expect(
      dispatchWorktreeChatTurn(
        baseOptions({
          projectId: 'my-project',
          worktreeId: 'wt-1',
          providerType: 'codex',
          executionHarness: 'codex',
          sdkSessionId: 'codex-thread-abc',
          globalInstructionsSnapshot:
            '# User Overall Preferences\n\nStale Codex-lane snapshot.',
        }),
      ),
    ).resolves.not.toThrow();

    const sessionOptions = getOrCreateSessionMock.mock.calls[0]?.[0];
    expect(sessionOptions).toEqual(
      expect.objectContaining({
        providerType: 'claude',
        model: 'opus[1m]',
        executionHarness: 'claude',
      }),
    );
    expect(sessionOptions?.sdkSessionId).toBeUndefined();
    expect(sessionOptions?.globalInstructionsBlock).toContain(
      'Fresh Claude-lane instruction.',
    );
    expect(sessionOptions?.globalInstructionsBlock).not.toContain(
      'Stale Codex-lane snapshot.',
    );
  });

  it('keeps the caller session id when no substitution happened', async () => {
    requireLaneAwareDefaultSelectionMock.mockResolvedValueOnce({
      model: 'gpt-5.6-codex',
      thinkingLevel: 'high',
    });

    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'my-project',
        worktreeId: 'wt-1',
        providerType: 'codex',
        sdkSessionId: 'codex-thread-abc',
      }),
    );

    expect(getOrCreateSessionMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ sdkSessionId: 'codex-thread-abc' }),
    );
  });

  it('uses the provider-owned thread id for a same-turn deferred continuation', async () => {
    getProviderSessionIdMock.mockReturnValue('provider-owned-thread');
    const onBeforeChatEvent = jest.fn(() => Promise.resolve());
    getSessionGlobalInstructionsSnapshotMock.mockReturnValue(
      '# User Overall Preferences\n\nOriginal live snapshot.',
    );
    const registerResumeHandler = jest.spyOn(
      deferredToolsReloadCoordinator,
      'registerResumeHandler',
    );
    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        providerType: 'codex',
        onBeforeChatEvent,
      }),
    );
    getMockSession(0).__onEvent({
      type: 'assistant',
      message: 'before reload',
    });
    await flushSessionEventCommits();
    const registration = registerResumeHandler.mock.calls.find(
      ([scope]) => scope.chatId === 'chat-1',
    );
    const resume = registration?.[1];
    if (!resume) throw new Error('Expected deferred-tools resume handler');

    await resume({
      scope: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
      requestId: 'reload-request',
      toolCallId: 'tool-call',
      userMessageId: 'msg-1',
      continuationText: '<system_instruction>Continue</system_instruction>',
      enabledResources: [],
      providerType: 'codex',
      pluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      signal: new AbortController().signal,
    });

    expect(runWithScopeActivityMock).toHaveBeenCalledWith(
      { projectId: 'project-1', worktreeId: 'worktree-1' },
      expect.any(Function),
    );

    const lastGetOrCreateCall = getOrCreateSessionMock.mock.lastCall;
    expect(lastGetOrCreateCall?.[0]).toEqual(
      expect.objectContaining({
        sdkSessionId: 'provider-owned-thread',
        globalInstructionsBlock:
          '# User Overall Preferences\n\nOriginal live snapshot.',
      }),
    );
    expect(lastGetOrCreateCall?.[1]).toEqual(expect.any(Function));
    expect(lastGetOrCreateCall?.[2]).toEqual(expect.any(Function));
    expect(lastGetOrCreateCall?.[3]?.onRemoved).toEqual(expect.any(Function));
    getMockSession(1).__onEvent({ type: 'assistant', message: 'after reload' });
    await flushSessionEventCommits();
    expect(onBeforeChatEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sequence: 0, sequenceNamespace: 'initial' }),
    );
    expect(onBeforeChatEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sequence: 0,
        sequenceNamespace: 'reload-request',
      }),
    );
    registerResumeHandler.mockRestore();
  });

  describe('deferred continuation of a Claude fork', () => {
    const forkToolResults = [
      {
        toolUseId: 'toolu_open',
        content: 'Tool result was not captured before the fork.',
      },
    ];

    async function resumeFirstForkTurn(input: {
      providerSessionId: string;
      requestedSessionId?: string;
    }): Promise<void> {
      getProviderSessionIdMock.mockReturnValue(input.providerSessionId);
      const registerResumeHandler = jest.spyOn(
        deferredToolsReloadCoordinator,
        'registerResumeHandler',
      );
      try {
        await dispatchWorktreeChatTurn(
          baseOptions({
            projectId: 'my-project',
            worktreeId: 'wt-1',
            sdkSessionId: 'source-session',
            claudeForkSession: true,
            claudeForkResumeAt: 'source-anchor-uuid',
            claudeForkToolResults: forkToolResults,
          }),
        );
        const resume = registerResumeHandler.mock.calls.find(
          ([scope]) => scope.chatId === 'chat-1',
        )?.[1];
        if (!resume) throw new Error('Expected deferred-tools resume handler');
        await resume({
          scope: {
            projectId: 'my-project',
            worktreeId: 'wt-1',
            chatId: 'chat-1',
          },
          requestId: 'reload-request',
          toolCallId: 'tool-call',
          userMessageId: 'msg-1',
          continuationText: '<system_instruction>Continue</system_instruction>',
          enabledResources: [],
          ...(input.requestedSessionId
            ? { sdkSessionId: input.requestedSessionId }
            : {}),
          providerType: 'claude',
          signal: new AbortController().signal,
        });
      } finally {
        registerResumeHandler.mockRestore();
      }
    }

    it('resumes the started fork child in place instead of forking its source again', async () => {
      await resumeFirstForkTurn({
        providerSessionId: 'fork-child-session',
        requestedSessionId: 'fork-child-session',
      });

      expect(getOrCreateSessionMock).toHaveBeenCalledTimes(2);
      const resumedOptions = getOrCreateSessionMock.mock.lastCall?.[0];
      expect(resumedOptions).toEqual(
        expect.objectContaining({ sdkSessionId: 'fork-child-session' }),
      );
      expect(resumedOptions).not.toHaveProperty('claudeForkSession');
      expect(resumedOptions).not.toHaveProperty('claudeForkResumeAt');
      expect(resumedOptions).not.toHaveProperty('claudeForkToolResults');
    });

    it('prefers the provider-owned child over a source id captured before init', async () => {
      await resumeFirstForkTurn({
        providerSessionId: 'fork-child-session',
        requestedSessionId: 'source-session',
      });

      const resumedOptions = getOrCreateSessionMock.mock.lastCall?.[0];
      expect(resumedOptions).toEqual(
        expect.objectContaining({ sdkSessionId: 'fork-child-session' }),
      );
      expect(resumedOptions).not.toHaveProperty('claudeForkSession');
      expect(resumedOptions).not.toHaveProperty('claudeForkResumeAt');
    });

    it('repeats the source fork when the child session never started', async () => {
      await resumeFirstForkTurn({ providerSessionId: 'source-session' });

      expect(getOrCreateSessionMock.mock.lastCall?.[0]).toEqual(
        expect.objectContaining({
          sdkSessionId: 'source-session',
          claudeForkSession: true,
          claudeForkResumeAt: 'source-anchor-uuid',
          claudeForkToolResults: forkToolResults,
        }),
      );
    });
  });

  it('forwards an imported Codex reconstruction seed into the provider session', async () => {
    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'my-project',
        worktreeId: 'wt-1',
        providerType: 'codex',
        codexReconstructionSeedId: 'retained-seed-id',
      }),
    );

    expect(getOrCreateSessionMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        codexReconstructionSeedId: 'retained-seed-id',
      }),
    );
  });

  it('inherits a persisted disabled deferred-tools policy when omitted', async () => {
    mockReadPersistedChatDispatchMetadata.mockResolvedValueOnce({
      deferredToolsAllowed: false,
    });

    await dispatchWorktreeChatTurn(
      baseOptions({ projectId: 'my-project', worktreeId: 'wt-1' }),
    );

    expect(getOrCreateSessionMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ deferredToolsAllowed: false }),
    );
  });

  it('rejects an echoed harness that conflicts with the persisted chat owner', async () => {
    mockReadPersistedChatDispatchMetadata.mockResolvedValueOnce({
      deferredToolsAllowed: true,
      executionHarness: 'claude',
      model: 'opus[1m]',
    });

    await expect(
      dispatchWorktreeChatTurn(
        baseOptions({
          projectId: 'my-project',
          worktreeId: 'wt-1',
          model: 'opus[1m]',
          providerType: 'claude',
          executionHarness: 'codex',
          deferredToolsAllowed: true,
        }),
      ),
    ).rejects.toThrow(/execution harness/i);

    expect(mockReadPersistedChatDispatchMetadata).toHaveBeenCalledTimes(1);
    expect(getOrCreateSessionMock).not.toHaveBeenCalled();
  });

  it('rejects an echoed harness that conflicts with model-owned routing', async () => {
    await expect(
      dispatchWorktreeChatTurn(
        baseOptions({
          projectId: 'my-project',
          worktreeId: 'wt-1',
          model: 'opus[1m]',
          providerType: 'claude',
          executionHarness: 'codex',
        }),
      ),
    ).rejects.toThrow(/execution harness/i);

    expect(getOrCreateSessionMock).not.toHaveBeenCalled();
  });

  it('uses the enabled default for a new chat without persisted metadata', async () => {
    await dispatchWorktreeChatTurn(
      baseOptions({ projectId: 'my-project', worktreeId: 'wt-1' }),
    );

    expect(getOrCreateSessionMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ deferredToolsAllowed: true }),
    );
  });

  it('preserves the existing turn-diff baseline for a hidden deferred continuation', async () => {
    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'my-project',
        worktreeId: 'wt-1',
        hiddenDeferredContinuation: true,
      }),
    );

    expect(captureTurnStartMock).not.toHaveBeenCalled();
  });

  it('keeps internal reload terminal events out of external callbacks', async () => {
    const onChatEvent = jest.fn();
    const onBeforeChatEvent = jest.fn(() => Promise.resolve());
    const activeReloadSpy = jest
      .spyOn(deferredToolsReloadCoordinator, 'hasActiveReload')
      .mockReturnValueOnce(true);
    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'my-project',
        worktreeId: 'wt-1',
        onChatEvent,
        onBeforeChatEvent,
      }),
    );
    const session = getMockSession(0);

    session.__onEvent({ type: 'assistant', message: 'working' });
    session.__onEvent({ type: 'result', is_error: false, result: 'cancelled' });
    await flushSessionEventCommits();

    expect(onChatEvent).toHaveBeenCalledTimes(1);
    expect(onChatEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { type: 'assistant', message: 'working' },
      }),
    );
    expect(onBeforeChatEvent).toHaveBeenCalledTimes(1);
    expect(onBeforeChatEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { type: 'assistant', message: 'working' },
      }),
    );
    activeReloadSpy.mockRestore();
  });

  it('forwards Claude session forks through the regular worktree path', async () => {
    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'my-project',
        worktreeId: 'wt-1',
        sdkSessionId: 'source-session',
        claudeForkSession: true,
      }),
    );

    expect(getOrCreateSessionMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        sdkSessionId: 'source-session',
        claudeForkSession: true,
      }),
    );
  });

  it('forwards fresh Claude fork disclosure through the regular worktree path', async () => {
    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'my-project',
        worktreeId: 'wt-1',
        claudeForkStartsFresh: true,
      }),
    );

    expect(getOrCreateSessionMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ claudeForkStartsFresh: true }),
    );
  });

  it('uses the worktree injected-tool prompt and schedules a worktree summary', async () => {
    await dispatchWorktreeChatTurn(
      baseOptions({ projectId: 'my-project', worktreeId: 'wt-1' }),
    );

    const startArgs = startChatTurnMock.mock.calls[0]?.[0];
    expect(startArgs?.systemPromptAppend).toBe('worktree-injected-prompt');

    const session = getMockSession(0);
    session.__onEvent({ type: 'result', is_error: false, result: 'ok' });
    await flushSessionEventCommits();

    expect(scheduleSummaryGenerationMock).toHaveBeenCalled();
    expect(handleCanonicalChatTerminalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'terminal',
        address: { projectId: 'my-project', taskId: 'wt-1', chatId: 'chat-1' },
        sourceInputId: 'msg-1',
        evidence: { sourceOwner: { kind: 'personal' } },
      }),
    );
  });

  it('keeps queue, audit, summary, and watcher ownership open across repeated Claude preludes', async () => {
    const onChatEvent = jest.fn();
    const onBeforeChatEvent = jest.fn(() => Promise.resolve());
    const queueService = chatQueueServiceModule.getChatQueueService();
    const onTurnTerminal = jest
      .spyOn(queueService, 'onTurnTerminal')
      .mockImplementation();
    try {
      await dispatchWorktreeChatTurn(
        baseOptions({
          projectId: 'my-project',
          worktreeId: 'wt-1',
          userMessageId: 'follow-up-user',
          onChatEvent,
          onBeforeChatEvent,
        }),
      );
      const session = getMockSession(0);
      const prelude = {
        type: 'result',
        is_error: false,
        num_turns: 0,
        result: '',
        origin: { kind: 'task-notification' },
        canopy_session_continues: true,
        canopy_turn_user_message_id: 'follow-up-user',
      };
      session.__onEvent(prelude);
      session.__onEvent(prelude);
      session.__onEvent({
        type: 'assistant',
        canopy_turn_user_message_id: 'follow-up-user',
        message: {
          content: [
            { type: 'thinking', thinking: 'Still following the request' },
          ],
        },
      });
      session.__onEvent({
        type: 'assistant',
        canopy_turn_user_message_id: 'follow-up-user',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Read',
              input: { file_path: '/tmp/fixture.txt' },
            },
          ],
        },
      });
      await flushSessionEventCommits();

      expect(completeChatTurnMock).not.toHaveBeenCalled();
      expect(onTurnTerminal).not.toHaveBeenCalled();
      expect(scheduleSummaryGenerationMock).not.toHaveBeenCalled();
      expect(handleCanonicalChatTerminalEventMock).not.toHaveBeenCalled();
      expect(onChatEvent).toHaveBeenCalledTimes(4);
      expect(onBeforeChatEvent).toHaveBeenCalledTimes(4);
      expect(observeChatEventMock).toHaveBeenCalledTimes(4);

      session.__onEvent({
        type: 'result',
        is_error: false,
        num_turns: 1,
        result: 'Follow-up finished after interruption.',
        duration_ms: 125,
        canopy_turn_user_message_id: 'follow-up-user',
      });
      await flushSessionEventCommits();

      expect(completeChatTurnMock).toHaveBeenCalledTimes(1);
      expect(completeChatTurnMock).toHaveBeenCalledWith(
        'my-project',
        'wt-1',
        'chat-1',
        'success',
        undefined,
      );
      expect(onTurnTerminal).toHaveBeenCalledTimes(1);
      expect(onTurnTerminal).toHaveBeenCalledWith(
        {
          projectId: 'my-project',
          worktreeId: 'wt-1',
          chatId: 'chat-1',
        },
        'complete',
        'follow-up-user',
      );
      expect(scheduleSummaryGenerationMock).toHaveBeenCalledTimes(1);
      expect(handleCanonicalChatTerminalEventMock).toHaveBeenCalledTimes(1);
      expect(observeChatEventMock).toHaveBeenCalledTimes(5);
    } finally {
      onTurnTerminal.mockRestore();
    }
  });

  it('appends the code-graph availability nudge when a graph exists for this worktree', async () => {
    hasGraphMock.mockReturnValue(true);

    await dispatchWorktreeChatTurn(
      baseOptions({ projectId: 'my-project', worktreeId: 'wt-1' }),
    );

    const startArgs = startChatTurnMock.mock.calls[0]?.[0];
    expect(startArgs?.systemPromptAppend).toBe(
      'worktree-injected-prompt\n\nA code graph exists for this worktree. Use GetCodeGraphContext, then QueryCodeGraph or SearchCodeGraph before broad source exploration, including in subagents.',
    );
    expect(hasGraphMock).toHaveBeenCalledWith('my-project', 'wt-1');
    // The injected-tool prompt is built with code-graph bullets included.
    expect(mockBuildWorktreeInjectedToolPrompt).toHaveBeenCalledWith(
      'claude',
      true,
    );
  });

  it.each([undefined, true, false])(
    'omits unavailable graph tools from Cursor prompts and session capabilities (snapshot %s)',
    async (snapshot) => {
      hasGraphMock.mockReturnValue(true);
      getSessionCodeGraphToolsAdvertisedMock.mockReturnValue(snapshot);
      await dispatchWorktreeChatTurn(
        baseOptions({
          projectId: 'my-project',
          worktreeId: 'wt-1',
          providerType: 'cursor',
          model: 'cursor-default',
          executionHarness: 'cursor',
        }),
      );
      expect(
        startChatTurnMock.mock.calls[0]?.[0]?.systemPromptAppend,
      ).not.toMatch(
        /GetCodeGraphContext|QueryCodeGraph|SearchCodeGraph|A code graph exists/,
      );
      expect(mockBuildWorktreeInjectedToolPrompt).not.toHaveBeenCalled();
      expect(getOrCreateSessionMock.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({ codeGraphToolsAdvertised: false }),
      );
    },
  );

  it.each([undefined, true, false])(
    'passes the effective Copilot graph snapshot to the provider (%s)',
    async (snapshot) => {
      getSessionCodeGraphToolsAdvertisedMock.mockReturnValue(snapshot);
      await dispatchWorktreeChatTurn(
        baseOptions({
          projectId: 'my-project',
          worktreeId: 'wt-1',
          providerType: 'copilot',
          model: 'copilot:gpt-5',
          executionHarness: 'copilot',
        }),
      );
      expect(getOrCreateSessionMock.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({ codeGraphToolsAdvertised: snapshot ?? true }),
      );
    },
  );

  it.each([undefined, true, false])(
    'passes the effective OpenCode graph snapshot to the provider (%s)',
    async (snapshot) => {
      getSessionCodeGraphToolsAdvertisedMock.mockReturnValue(snapshot);
      await dispatchWorktreeChatTurn(
        baseOptions({
          projectId: 'my-project',
          worktreeId: 'wt-1',
          providerType: 'opencode',
          model: 'opencode:fixture%2Fmodel',
          executionHarness: 'opencode',
        }),
      );
      expect(getOrCreateSessionMock.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({ codeGraphToolsAdvertised: snapshot ?? true }),
      );
    },
  );

  it('schedules a graph refresh after a non-empty completed turn diff', async () => {
    captureTurnEndAndDiffMock.mockResolvedValueOnce({
      files: [{ path: 'src/app.ts', status: 'modified' }],
      totalInsertions: 1,
      totalDeletions: 0,
      capturedAt: 1,
      treeRefs: [],
    });
    await dispatchWorktreeChatTurn(
      baseOptions({ projectId: 'my-project', worktreeId: 'wt-1' }),
    );
    getMockSession(0).__onEvent({
      type: 'result',
      is_error: false,
      result: 'ok',
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(scheduleCodeGraphBuildMock).toHaveBeenCalledWith({
      projectId: 'my-project',
      worktreeId: 'wt-1',
      reason: 'refresh',
      source: 'turn-diff',
    });
  });

  it('schedules a completed sentinel turn against its resolved real worktree', async () => {
    mockResolveWorktreeTargetIds.mockReturnValueOnce({
      projectId: 'real-project',
      worktreeId: 'real-worktree',
    });
    captureTurnEndAndDiffMock.mockResolvedValueOnce({
      files: [{ path: 'src/app.ts', status: 'modified' }],
      totalInsertions: 1,
      totalDeletions: 0,
      capturedAt: 1,
      treeRefs: [],
    });
    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: CODE_REVIEW_CHAT_PROJECT_ID,
        worktreeId: 'scope-id',
      }),
    );
    getMockSession(0).__onEvent({ type: 'result', result: 'ok' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockResolveWorktreeTargetIds).toHaveBeenCalledWith(
      CODE_REVIEW_CHAT_PROJECT_ID,
      'scope-id',
    );
    expect(scheduleCodeGraphBuildMock).toHaveBeenCalledWith({
      projectId: 'real-project',
      worktreeId: 'real-worktree',
      reason: 'refresh',
      source: 'turn-diff',
    });
  });

  it('suppresses the code-graph nudge and code-graph bullets when the feature flag is off', async () => {
    mockIsEnabled.mockReturnValue(false);
    hasGraphMock.mockReturnValue(true);

    await dispatchWorktreeChatTurn(
      baseOptions({ projectId: 'my-project', worktreeId: 'wt-1' }),
    );

    const startArgs = startChatTurnMock.mock.calls[0]?.[0];
    // No nudge even though a graph "exists" — the gate is explicit, not an
    // accident of hasGraph being false.
    expect(startArgs?.systemPromptAppend).toBe('worktree-injected-prompt');
    // The injected-tool prompt is built WITHOUT code-graph bullets.
    expect(mockBuildWorktreeInjectedToolPrompt).toHaveBeenCalledWith(
      'claude',
      false,
    );
  });

  it('does not add tools to a session whose creation snapshot omitted them', async () => {
    getSessionCodeGraphToolsAdvertisedMock.mockReturnValue(false);
    hasGraphMock.mockReturnValue(true);

    await dispatchWorktreeChatTurn(
      baseOptions({ projectId: 'my-project', worktreeId: 'wt-1' }),
    );

    expect(mockBuildWorktreeInjectedToolPrompt).toHaveBeenCalledWith(
      'claude',
      false,
    );
    expect(hasGraphMock).not.toHaveBeenCalled();
    expect(getOrCreateSessionMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ codeGraphToolsAdvertised: false }),
    );
  });

  it('keeps an advertised session capability while live availability suppresses prompt text', async () => {
    getSessionCodeGraphToolsAdvertisedMock.mockReturnValue(true);
    mockIsEnabled.mockReturnValue(false);
    hasGraphMock.mockReturnValue(true);

    await dispatchWorktreeChatTurn(
      baseOptions({ projectId: 'my-project', worktreeId: 'wt-1' }),
    );

    expect(mockBuildWorktreeInjectedToolPrompt).toHaveBeenCalledWith(
      'claude',
      false,
    );
    expect(getOrCreateSessionMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ codeGraphToolsAdvertised: true }),
    );
  });

  it('preserves an advertised capability when an availability prompt change recreates the session', async () => {
    getSessionCodeGraphToolsAdvertisedMock.mockReturnValue(true);
    canReuseSessionMock.mockResolvedValue(false);
    mockIsEnabled.mockReturnValue(false);

    await dispatchWorktreeChatTurn(
      baseOptions({ projectId: 'my-project', worktreeId: 'wt-1' }),
    );

    expect(canPreserveSessionCapabilitySnapshotMock).toHaveBeenCalled();
    expect(getOrCreateSessionMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ codeGraphToolsAdvertised: true }),
    );
  });

  it('uses current availability when the requested options replace the session', async () => {
    getSessionCodeGraphToolsAdvertisedMock.mockReturnValue(false);
    canReuseSessionMock.mockResolvedValue(false);
    canPreserveSessionCapabilitySnapshotMock.mockResolvedValue(false);

    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'my-project',
        worktreeId: 'wt-1',
        providerType: 'codex',
      }),
    );

    expect(canReuseSessionMock).toHaveBeenCalled();
    expect(getOrCreateSessionMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ codeGraphToolsAdvertised: true }),
    );
  });

  it('does not carry advertised tools into an ineligible replacement session', async () => {
    getSessionCodeGraphToolsAdvertisedMock.mockReturnValue(true);
    canReuseSessionMock.mockResolvedValue(false);
    canPreserveSessionCapabilitySnapshotMock.mockResolvedValue(false);
    mockIsEnabled.mockReturnValue(false);

    await dispatchWorktreeChatTurn(
      baseOptions({ projectId: 'my-project', worktreeId: 'wt-1' }),
    );

    expect(getOrCreateSessionMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ codeGraphToolsAdvertised: false }),
    );
  });
});

describe('dispatchWorktreeChatTurn MCP auth failure pairing recursion guard', () => {
  it('skips the pairing call for an incoming canopy_auth_failure event', async () => {
    const onChatEvent = jest.fn();
    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'my-project',
        worktreeId: 'wt-1',
        onChatEvent,
      }),
    );
    const session = getMockSession(0);

    // A regular event still routes through pairing (defence-in-depth
    // coverage that the guard is type-specific, not a blanket skip).
    session.__onEvent({ type: 'assistant', message: 'working' });
    await flushSessionEventCommits();
    expect(pairPendingAuthFailuresMock).toHaveBeenCalledWith(
      { type: 'assistant', message: 'working' },
      'my-project/wt-1/chat-1',
    );
    pairPendingAuthFailuresMock.mockClear();

    // CAN-1814 fix-round-1: `handleSessionEvent` must not attempt to pair a
    // `canopy_auth_failure` event it (or a future emitter) produced — that
    // would be self-feeding recursion. This is defence-in-depth today
    // (the current pairing shape check also can't match this event), but
    // pins the call-site guard directly so a future shape change to either
    // side can't silently reintroduce recursion with nothing to catch it.
    const authFailureEvent = {
      type: CANOPY_AUTH_FAILURE_EVENT_TYPE,
      toolUseId: 'tu-1',
      failure: {
        dependencyClass: 'mcp',
        dependencyId: 'srv-1:cfg-1',
        displayName: 'Prod MCP server',
        failureClass: 'expired',
        recovery: { kind: 'mcp_oauth', serverId: 'srv-1', configId: 'cfg-1' },
      },
    };
    session.__onEvent(authFailureEvent);
    await flushSessionEventCommits();

    expect(pairPendingAuthFailuresMock).not.toHaveBeenCalled();
    expect(onChatEvent).toHaveBeenCalledWith(
      expect.objectContaining({ data: authFailureEvent }),
    );
    expect(onChatEvent).toHaveBeenCalledTimes(2);
  });
});

describe('dispatchWorktreeChatTurn auth failure turn stop (CAN-1814 PR 6)', () => {
  const pairedFailure = {
    dependencyClass: 'mcp',
    dependencyId: 'srv-1:cfg-1',
    displayName: 'Prod MCP server',
    failureClass: 'expired',
    recovery: { kind: 'mcp_oauth', serverId: 'srv-1', configId: 'cfg-1' },
  };
  const pairedEvent = {
    type: CANOPY_AUTH_FAILURE_EVENT_TYPE,
    toolUseId: 'tu-1',
    failure: pairedFailure,
    failures: [pairedFailure],
  };

  it('hands the paired failure, tool name, and initiation source to the stopper', async () => {
    const onChatEvent = jest.fn();
    pairPendingAuthFailuresMock.mockReturnValueOnce([
      { event: pairedEvent, toolName: 'mcp__prod__lookup-records' },
    ]);

    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'my-project',
        worktreeId: 'wt-1',
        onChatEvent,
        initiationSource: 'automation',
      }),
    );
    getMockSession(0).__onEvent({ type: 'assistant', message: 'working' });
    await flushSessionEventCommits();
    // The stop chains off the commit tail, so it settles a few ticks later.
    await flushSessionEventCommits();

    expect(stopTurnForAuthFailureMock).toHaveBeenCalledTimes(1);
    const input = stopTurnForAuthFailureMock.mock.calls[0]?.[0];
    expect(input).toEqual(
      expect.objectContaining({
        target: {
          projectId: 'my-project',
          worktreeId: 'wt-1',
          chatId: 'chat-1',
        },
        event: pairedEvent,
        toolName: 'mcp__prod__lookup-records',
        initiationSource: 'automation',
      }),
    );
    // The card's own event must reach the renderer BEFORE the turn is torn
    // down, otherwise the turn stops with nothing on screen explaining why.
    expect(onChatEvent).toHaveBeenCalledWith(
      expect.objectContaining({ data: pairedEvent }),
    );
    // The stopped turn's terminal event can lag behind `cancel()` resolving, so
    // the active-turn marker is cleared here; a stale one would make the resume
    // dispatch trip the second-active-turn guard.
    expect(
      worktreeChatTurnTestExports.activeTurnUserMessageId(
        'my-project',
        'wt-1',
        'chat-1',
      ),
    ).toBeUndefined();
  });

  it('leaves the active-turn marker alone when the stopper declined', async () => {
    stopTurnForAuthFailureMock.mockResolvedValueOnce({
      stopped: false,
      autoResumeSafe: false,
      notified: false,
    });
    pairPendingAuthFailuresMock.mockReturnValueOnce([
      { event: pairedEvent, toolName: 'mcp__prod__lookup-records' },
    ]);

    await dispatchWorktreeChatTurn(
      baseOptions({ projectId: 'my-project', worktreeId: 'wt-1' }),
    );
    getMockSession(0).__onEvent({ type: 'assistant', message: 'working' });
    await flushSessionEventCommits();
    await flushSessionEventCommits();

    expect(
      worktreeChatTurnTestExports.activeTurnUserMessageId(
        'my-project',
        'wt-1',
        'chat-1',
      ),
    ).toBe('msg-1');
  });

  it('never stops a turn when nothing paired', async () => {
    await dispatchWorktreeChatTurn(
      baseOptions({ projectId: 'my-project', worktreeId: 'wt-1' }),
    );
    getMockSession(0).__onEvent({ type: 'assistant', message: 'working' });
    await flushSessionEventCommits();

    expect(stopTurnForAuthFailureMock).not.toHaveBeenCalled();
  });
});

describe('dispatchWorktreeChatTurn commit overlap while chat storage group-commits', () => {
  type BeforeEvent = Parameters<
    Parameters<typeof dispatchWorktreeChatTurn>[0]['onBeforeChatEvent']
  >[0];
  interface PendingCommit {
    event: BeforeEvent;
    settle: (committed: boolean) => void;
    fail: (error: Error) => void;
  }

  /** A commit hook whose commits the test settles; `queue` signals order. */
  function heldCommits(queue: boolean): {
    commits: PendingCommit[];
    hook: (event: BeforeEvent) => Promise<boolean>;
  } {
    const commits: PendingCommit[] = [];
    return {
      commits,
      hook: (event): Promise<boolean> =>
        new Promise<boolean>((resolve, reject) => {
          commits.push({ event, settle: resolve, fail: reject });
          // The repository queues the commit's lease turn synchronously.
          if (queue) event.onCommitQueued?.();
        }),
    };
  }

  type DeliveredChatEvent = Parameters<
    NonNullable<Parameters<typeof dispatchWorktreeChatTurn>[0]['onChatEvent']>
  >[0];
  const deliveries = (): jest.Mock<void, [DeliveredChatEvent]> =>
    jest.fn<void, [DeliveredChatEvent]>();
  const texts = (handler: jest.Mock<void, [DeliveredChatEvent]>): unknown[] =>
    handler.mock.calls.map(([event]) =>
      typeof event.data === 'object' &&
      event.data !== null &&
      'message' in event.data
        ? event.data.message
        : 'result',
    );

  it('starts the next streamed commit once the previous one is queued and delivers in order after durability', async () => {
    const delivered = deliveries();
    const { commits, hook } = heldCommits(true);
    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'my-project',
        worktreeId: 'wt-1',
        onChatEvent: delivered,
        onBeforeChatEvent: hook,
      }),
    );
    const session = getMockSession(0);
    session.__onEvent({ type: 'assistant', message: 'one' });
    session.__onEvent({ type: 'assistant', message: 'two' });
    session.__onEvent({ type: 'assistant', message: 'three' });
    session.__onEvent({ type: 'result', is_error: false });
    await flushSessionEventCommits();
    await flushSessionEventCommits();
    // Three commits are in flight together, in provider order; the turn's
    // terminal event waits for all of them.
    expect(commits.map((commit) => commit.event.sequence)).toEqual([0, 1, 2]);
    expect(
      commits.every(
        (commit) => typeof commit.event.onCommitQueued === 'function',
      ),
    ).toBe(true);
    // Nothing is delivered before its commit is durable.
    expect(delivered).not.toHaveBeenCalled();
    // A later commit settling first (the same batch) delivers nothing.
    commits[1].settle(true);
    commits[2].settle(true);
    await flushSessionEventCommits();
    expect(delivered).not.toHaveBeenCalled();
    expect(commits).toHaveLength(3);
    commits[0].settle(true);
    await flushSessionEventCommits();
    await flushSessionEventCommits();
    expect(texts(delivered)).toEqual(['one', 'two', 'three']);
    // Only now does the terminal event commit, alone and without the signal.
    expect(commits).toHaveLength(4);
    expect(commits[3].event.sequence).toBe(3);
    expect(commits[3].event.onCommitQueued).toBeUndefined();
    commits[3].settle(true);
    await flushSessionEventCommits();
    expect(texts(delivered)).toEqual(['one', 'two', 'three', 'result']);
    expect(delivered.mock.calls[3][0]).toMatchObject({ isTerminalEvent: true });
  });

  it('commits a paired authentication failure before a terminal event that arrives behind its errored tool result', async () => {
    const pairedFailure = {
      dependencyClass: 'mcp',
      dependencyId: 'srv-1:cfg-1',
      displayName: 'Prod MCP server',
      failureClass: 'expired',
      recovery: { kind: 'mcp_oauth', serverId: 'srv-1', configId: 'cfg-1' },
    };
    const pairedEvent = {
      type: CANOPY_AUTH_FAILURE_EVENT_TYPE,
      toolUseId: 'tu-1',
      failure: pairedFailure,
      failures: [pairedFailure],
    };
    pairPendingAuthFailuresMock.mockReturnValueOnce([
      { event: pairedEvent, toolName: 'mcp__prod__lookup-records' },
    ]);
    const delivered = deliveries();
    const { commits, hook } = heldCommits(true);
    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'my-project',
        worktreeId: 'wt-1',
        onChatEvent: delivered,
        onBeforeChatEvent: hook,
      }),
    );
    const session = getMockSession(0);
    // The provider delivers the errored tool result and, right behind it,
    // the turn's terminal event, before the first commit is durable.
    session.__onEvent({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tu-1', is_error: true }],
      },
    });
    session.__onEvent({ type: 'result', is_error: false });
    const committed: unknown[] = [];
    for (let step = 0; step < 12 && committed.length < 3; step += 1) {
      await flushSessionEventCommits();
      const next = commits[committed.length];
      if (!next) continue;
      const { data } = next.event;
      committed.push(
        typeof data === 'object' && data !== null && 'type' in data
          ? data.type
          : data,
      );
      next.settle(true);
    }
    // The failure notice is committed with the turn still open, before the
    // terminal event can settle it.
    expect(committed).toEqual([
      'user',
      CANOPY_AUTH_FAILURE_EVENT_TYPE,
      'result',
    ]);
    expect(delivered).toHaveBeenCalledWith(
      expect.objectContaining({ data: pairedEvent }),
    );
  });

  it('keeps each overlapped event pressure charge until its durable delivery', async () => {
    const delivered = deliveries();
    const { commits, hook } = heldCommits(true);
    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'my-project',
        worktreeId: 'wt-1',
        onChatEvent: delivered,
        onBeforeChatEvent: hook,
      }),
    );
    const session = getMockSession(0);
    /** Events whose pressure charge the route has not released. */
    const charged = (): number =>
      getRoutedSessionPressureSnapshot({
        projectId: 'my-project',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
      }).activeCount;
    session.__onEvent({ type: 'assistant', message: 'one' });
    session.__onEvent({ type: 'assistant', message: 'two' });
    await flushSessionEventCommits();
    expect(commits).toHaveLength(2);
    expect(charged()).toBe(2);
    commits[0].settle(true);
    await flushSessionEventCommits();
    await flushSessionEventCommits();
    expect(commits).toHaveLength(2);
    // The second commit overlaps, but its charge remains until durable
    // delivery. Queueing a commit does not release its pressure charge.
    expect(charged()).toBe(1);
    expect(commits[1].event.onCommitQueued).toEqual(expect.any(Function));
    commits[1].settle(true);
    await flushSessionEventCommits();
    await flushSessionEventCommits();
    expect(charged()).toBe(0);
    expect(texts(delivered)).toEqual(['one', 'two']);
  });

  it('keeps one commit at a time when the hook never reports its place in commit order', async () => {
    const delivered = deliveries();
    const { commits, hook } = heldCommits(false);
    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'my-project',
        worktreeId: 'wt-1',
        onChatEvent: delivered,
        onBeforeChatEvent: hook,
      }),
    );
    const session = getMockSession(0);
    session.__onEvent({ type: 'assistant', message: 'one' });
    session.__onEvent({ type: 'assistant', message: 'two' });
    await flushSessionEventCommits();
    await flushSessionEventCommits();
    expect(commits).toHaveLength(1);
    commits[0].settle(true);
    await flushSessionEventCommits();
    await flushSessionEventCommits();
    expect(commits).toHaveLength(2);
    commits[1].settle(true);
    await flushSessionEventCommits();
    await flushSessionEventCommits();
    expect(texts(delivered)).toEqual(['one', 'two']);
  });

  it('delivers the events behind a failed overlapped commit and keeps the turn usable', async () => {
    const delivered = deliveries();
    const { commits, hook } = heldCommits(true);
    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'my-project',
        worktreeId: 'wt-1',
        onChatEvent: delivered,
        onBeforeChatEvent: hook,
      }),
    );
    const session = getMockSession(0);
    session.__onEvent({ type: 'assistant', message: 'one' });
    session.__onEvent({ type: 'assistant', message: 'two' });
    await flushSessionEventCommits();
    await flushSessionEventCommits();
    expect(commits).toHaveLength(2);
    commits[0].fail(new Error('batch failed'));
    commits[1].settle(true);
    await flushSessionEventCommits();
    await flushSessionEventCommits();
    // The failed event is not delivered; the next one is, as when a single
    // commit fails without overlap.
    expect(texts(delivered)).toEqual(['two']);
    session.__onEvent({ type: 'result', is_error: false });
    await flushSessionEventCommits();
    await flushSessionEventCommits();
    expect(commits).toHaveLength(3);
    commits[2].settle(true);
    await flushSessionEventCommits();
    expect(texts(delivered)).toEqual(['two', 'result']);
  });
});

/** Plan-file turn leases the dispatch took and has not ended. */
function livePlanTurnCount(): number {
  return planTurns.filter((turn) => turn.live).length;
}

describe('dispatchWorktreeChatTurn plan-file turn ownership', () => {
  const worktreeOptions = (): Parameters<typeof dispatchWorktreeChatTurn>[0] =>
    baseOptions({ projectId: 'my-project', worktreeId: 'wt-1' });

  beforeEach(() => {
    // Earlier suites leave active-turn markers for these shared ids.
    for (const chatId of ['chat-1', 'chat-2']) {
      clearActiveTurnUserMessageId('my-project', 'wt-1', chatId);
    }
  });

  afterEach(() => {
    getStoppedTurnResumeService().resetForTests();
  });

  it('ends the plan turn when the provider rejects an ordinary send', async () => {
    sendMessageMock.mockImplementationOnce(() => {
      throw new Error('dispatch rejected');
    });

    await expect(dispatchWorktreeChatTurn(worktreeOptions())).rejects.toThrow(
      'dispatch rejected',
    );

    expect(beginPlanTurnMock).toHaveBeenCalledWith(worktreeTurnKey('chat-1'), {
      projectId: 'my-project',
      worktreeId: 'wt-1',
    });
    expect(livePlanTurnCount()).toBe(0);
  });

  it('ends the plan turn of an ordinary send when the session is removed without a terminal event', async () => {
    await dispatchWorktreeChatTurn(worktreeOptions());
    expect(livePlanTurnCount()).toBe(1);

    getOrCreateSessionMock.mock.calls[0]?.[3]?.onRemoved?.();
    await flushSessionEventCommits();

    expect(livePlanTurnCount()).toBe(0);
  });

  it('keeps one plan turn of an ordinary send across a deferred-tools reload and ends it once', async () => {
    const registerResumeHandler = jest.spyOn(
      deferredToolsReloadCoordinator,
      'registerResumeHandler',
    );
    const activeReload = jest
      .spyOn(deferredToolsReloadCoordinator, 'hasActiveReload')
      .mockReturnValue(true);
    try {
      await dispatchWorktreeChatTurn(worktreeOptions());
      // The reload's internal terminal event is not the turn's end.
      getMockSession(0).__onEvent({
        type: 'result',
        is_error: false,
        result: 'reloading',
      });
      await flushSessionEventCommits();
      activeReload.mockRestore();

      const resume = registerResumeHandler.mock.calls.find(
        ([scope]) => scope.chatId === 'chat-1',
      )?.[1];
      if (!resume) throw new Error('Expected deferred-tools resume handler');
      await resume({
        scope: {
          projectId: 'my-project',
          worktreeId: 'wt-1',
          chatId: 'chat-1',
        },
        requestId: 'reload-request',
        toolCallId: 'tool-call',
        userMessageId: 'msg-1',
        continuationText: '<system_instruction>Continue</system_instruction>',
        enabledResources: [],
        providerType: 'claude',
        pluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
        },
        signal: new AbortController().signal,
      });
      getMockSession(1).__onEvent({
        type: 'result',
        is_error: false,
        result: 'ok',
      });
      await flushSessionEventCommits();

      expect(livePlanTurnCount()).toBe(0);
    } finally {
      activeReload.mockRestore();
      registerResumeHandler.mockRestore();
    }
  });

  describe('when a deferred-tools reload removes the transport', () => {
    const reloadScope = {
      projectId: 'my-project',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
    };
    const toolCallId = 'load-tool-call';
    const reloadAdditions = {
      skillRefs: [{ sourceId: 'source', skillName: 'skill-one' }],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    let restoreRevalidator: (() => void) | undefined;
    let restoreIntentTimeout: (() => void) | undefined;

    beforeEach(() => {
      restoreRevalidator =
        deferredToolsReloadCoordinator.setCatalogRevalidatorForTests(() =>
          Promise.resolve(undefined),
        );
    });

    afterEach(() => {
      deferredToolsReloadCoordinator.resetForTests();
      restoreIntentTimeout?.();
      restoreIntentTimeout = undefined;
      restoreRevalidator?.();
      restoreRevalidator = undefined;
    });

    /**
     * Dispatch an ordinary worktree turn, start a reload for its chat, and
     * remove the turn's session the way the reload's plugin update does. The
     * turn's plan-file lease is kept across the reload.
     */
    async function removeTransportDuringReload(): Promise<string> {
      await dispatchWorktreeChatTurn(
        baseOptions({ projectId: 'my-project', worktreeId: 'wt-1' }),
      );
      const intent = deferredToolsReloadCoordinator.createIntent({
        scope: reloadScope,
        toolCallId,
        providerType: 'claude',
        additions: reloadAdditions,
        enabledResources: [],
      });
      if (!intent.accepted) throw new Error('Expected an accepted reload');
      getOrCreateSessionMock.mock.calls[0]?.[3]?.onRemoved?.();
      await flushSessionEventCommits();
      expect(livePlanTurnCount()).toBe(1);
      expect(endPlanTurnMock).not.toHaveBeenCalled();
      return intent.requestId;
    }

    function finishRequest(
      requestId: string,
    ): Parameters<typeof deferredToolsReloadCoordinator.finish>[0] {
      return {
        scope: reloadScope,
        requestId,
        toolCallId,
        userMessageId: 'msg-1',
        continuationText: '<system_instruction>Continue</system_instruction>',
        resume: {
          sdkSessionId: 'session-1',
          providerType: 'claude',
          pluginSelections: {
            collectionIds: [],
            skillRefs: [{ sourceId: 'source', skillName: 'skill-one' }],
            pluginRefs: [],
          },
        },
      };
    }

    it.each([
      {
        label: 'cancelled',
        settle: (requestId: string): Promise<unknown> =>
          Promise.resolve(
            deferredToolsReloadCoordinator.cancel({
              scope: reloadScope,
              requestId,
              toolCallId,
              reason: 'cancelled',
            }),
          ),
      },
      {
        label: 'cancelled by Stop',
        settle: (): Promise<unknown> =>
          Promise.resolve(
            deferredToolsReloadCoordinator.cancelActiveReload(reloadScope),
          ),
      },
      {
        label: 'failed to enable',
        settle: (requestId: string): Promise<unknown> => {
          restoreRevalidator?.();
          restoreRevalidator =
            deferredToolsReloadCoordinator.setCatalogRevalidatorForTests(() =>
              Promise.resolve('skill-one: no longer installed'),
            );
          return deferredToolsReloadCoordinator.begin({
            scope: reloadScope,
            requestId,
            toolCallId,
            additions: reloadAdditions,
            enabledResources: [],
          });
        },
      },
      {
        label: 'failed to resume',
        settle: (requestId: string): Promise<unknown> => {
          deferredToolsReloadCoordinator.unregisterResumeHandler(reloadScope);
          return deferredToolsReloadCoordinator.finish(
            finishRequest(requestId),
          );
        },
      },
      {
        label: 'timed out',
        settle: (): Promise<unknown> => {
          restoreIntentTimeout =
            deferredToolsReloadCoordinator.setIntentTimeoutMsForTests(1);
          // The shortened timeout applies from the next phase change.
          deferredToolsReloadCoordinator.markToolResultDelivered(
            reloadScope,
            toolCallId,
          );
          return new Promise((resolve) => {
            setTimeout(resolve, 20);
          });
        },
      },
    ])(
      'releases the kept plan-file lease once when the reload is $label',
      async ({ settle }) => {
        const requestId = await removeTransportDuringReload();

        await settle(requestId);
        await flushSessionEventCommits();

        expect(
          deferredToolsReloadCoordinator.hasActiveReload(reloadScope),
        ).toBe(false);
        expect(livePlanTurnCount()).toBe(0);
        expect(endPlanTurnMock).toHaveBeenCalledTimes(1);
        expect(beginPlanTurnMock).toHaveBeenCalledTimes(1);
      },
    );

    it('releases the lease when the removal finishes after the reload already failed', async () => {
      await dispatchWorktreeChatTurn(
        baseOptions({ projectId: 'my-project', worktreeId: 'wt-1' }),
      );
      const intent = deferredToolsReloadCoordinator.createIntent({
        scope: reloadScope,
        toolCallId,
        providerType: 'claude',
        additions: reloadAdditions,
        enabledResources: [],
      });
      if (!intent.accepted) throw new Error('Expected an accepted reload');
      getOrCreateSessionMock.mock.calls[0]?.[3]?.onRemoved?.();
      deferredToolsReloadCoordinator.cancelActiveReload(reloadScope);
      await flushSessionEventCommits();

      expect(livePlanTurnCount()).toBe(0);
      expect(endPlanTurnMock).toHaveBeenCalledTimes(1);
    });

    it('keeps the worktree leased across a successful hand-off until the continuation ends', async () => {
      const requestId = await removeTransportDuringReload();

      const ack = await deferredToolsReloadCoordinator.finish(
        finishRequest(requestId),
      );
      await flushSessionEventCommits();

      expect(ack.accepted).toBe(true);
      expect(deferredToolsReloadCoordinator.hasActiveReload(reloadScope)).toBe(
        false,
      );
      // The continuation's lease superseded the kept one.
      expect(beginPlanTurnMock).toHaveBeenCalledTimes(2);
      expect(livePlanTurnCount()).toBe(1);

      getMockSession(1).__onEvent({
        type: 'result',
        is_error: false,
        result: 'ok',
      });
      await flushSessionEventCommits();

      expect(livePlanTurnCount()).toBe(0);
    });
  });

  const worktreeTurnKey = (chatId = 'chat-1'): string =>
    JSON.stringify(['my-project', 'wt-1', chatId]);

  it.each([
    {
      label: 'successful',
      event: { type: 'result', is_error: false, result: 'Done.' },
    },
    {
      label: 'failed',
      event: { type: 'result', is_error: true, result: 'Provider failed.' },
    },
    {
      label: 'cancelled',
      event: { type: 'result', is_error: false, result: 'Turn cancelled' },
    },
    {
      label: 'interrupted',
      event: { type: 'result', is_error: false, result: 'Session aborted' },
    },
    { label: 'error', event: { type: 'error', error: 'Stream failed.' } },
  ])(
    'leases an ordinary worktree turn before sending and ends it once on a $label terminal event',
    async ({ event }) => {
      await dispatchWorktreeChatTurn(
        baseOptions({ projectId: 'my-project', worktreeId: 'wt-1' }),
      );

      expect(beginPlanTurnMock).toHaveBeenCalledTimes(1);
      expect(beginPlanTurnMock).toHaveBeenCalledWith(worktreeTurnKey(), {
        projectId: 'my-project',
        worktreeId: 'wt-1',
      });
      expect(beginPlanTurnMock.mock.invocationCallOrder[0]).toBeLessThan(
        sendMessageMock.mock.invocationCallOrder[0] ?? 0,
      );
      expect(livePlanTurnCount()).toBe(1);

      getMockSession(0).__onEvent(event);
      await flushSessionEventCommits();
      getOrCreateSessionMock.mock.calls[0]?.[3]?.onRemoved?.();
      await flushSessionEventCommits();

      expect(endPlanTurnMock).toHaveBeenCalledTimes(1);
      expect(livePlanTurnCount()).toBe(0);
    },
  );

  it.each([
    { label: 'Cowork', projectId: 'cowork-default', worktreeId: 'home' },
    {
      label: 'App Advisor',
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'advisor-entry',
    },
    {
      label: 'Code Review',
      projectId: CODE_REVIEW_CHAT_PROJECT_ID,
      worktreeId: 'review-scope',
    },
  ])(
    'takes no plan-file turn lease for $label chats',
    async ({ projectId, worktreeId }) => {
      await dispatchWorktreeChatTurn(baseOptions({ projectId, worktreeId }));
      getMockSession(0).__onEvent({ type: 'result', is_error: false });
      await flushSessionEventCommits();

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(beginPlanTurnMock).not.toHaveBeenCalled();
      expect(endPlanTurnMock).not.toHaveBeenCalled();
    },
  );

  it('gives concurrent chats in one worktree their own leases', async () => {
    await dispatchWorktreeChatTurn(
      baseOptions({ projectId: 'my-project', worktreeId: 'wt-1' }),
    );
    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'my-project',
        worktreeId: 'wt-1',
        chatId: 'chat-2',
        userMessageId: 'msg-2',
      }),
    );

    expect(beginPlanTurnMock.mock.calls).toEqual([
      [
        worktreeTurnKey('chat-1'),
        { projectId: 'my-project', worktreeId: 'wt-1' },
      ],
      [
        worktreeTurnKey('chat-2'),
        { projectId: 'my-project', worktreeId: 'wt-1' },
      ],
    ]);
    getMockSession(0).__onEvent({ type: 'result', is_error: false });
    await flushSessionEventCommits();
    expect(endPlanTurnMock.mock.calls).toEqual([[worktreeTurnKey('chat-1')]]);
    expect(livePlanTurnCount()).toBe(1);

    getMockSession(1).__onEvent({ type: 'result', is_error: false });
    await flushSessionEventCommits();
    expect(livePlanTurnCount()).toBe(0);
  });

  it('ends the lease of a turn sent into a disposed session', async () => {
    getOrCreateSessionMock.mockImplementationOnce(
      (
        ...args: [
          unknown,
          (data: unknown) => void,
          (() => unknown)?,
          MockSessionLifecycle?,
        ]
      ): MockAgentSession => ({
        ...makeMockSessionForEventHandler(args[1]),
        isDisposed: () => true,
      }),
    );

    await dispatchWorktreeChatTurn(
      baseOptions({ projectId: 'my-project', worktreeId: 'wt-1' }),
    );

    expect(beginPlanTurnMock).toHaveBeenCalledTimes(1);
    expect(endPlanTurnMock).toHaveBeenCalledTimes(1);
    expect(livePlanTurnCount()).toBe(0);
  });

  it('gives a stopped-turn resume its own lease and ends it once', async () => {
    const queueService = chatQueueServiceModule.getChatQueueService();
    const onTurnRevived = jest
      .spyOn(queueService, 'onTurnRevived')
      .mockReturnValue(true);
    const onTurnTerminal = jest
      .spyOn(queueService, 'onTurnTerminal')
      .mockImplementation();
    try {
      await dispatchWorktreeChatTurn(
        baseOptions({
          projectId: 'my-project',
          worktreeId: 'wt-1',
          userMessageId: 'stopped-message',
          hiddenDeferredContinuation: true,
          hiddenContinuationKind: 'stopped_turn_resume',
          providerEventSequenceNamespace: 'resume-attempt',
        }),
      );
      expect(beginPlanTurnMock).toHaveBeenCalledTimes(1);
      expect(beginPlanTurnMock).toHaveBeenCalledWith(worktreeTurnKey(), {
        projectId: 'my-project',
        worktreeId: 'wt-1',
      });

      const session = getMockSession(0);
      session.__onEvent({
        type: 'assistant',
        canopy_turn_user_message_id: 'stopped-message',
        message: { content: [{ type: 'text', text: 'Continued.' }] },
      });
      await flushSessionEventCommits();
      expect(onTurnRevived).toHaveBeenCalled();
      // The revival continues the resume's own lease.
      expect(beginPlanTurnMock).toHaveBeenCalledTimes(1);

      session.__onEvent({
        type: 'result',
        is_error: false,
        result: 'Done.',
        canopy_turn_user_message_id: 'stopped-message',
      });
      await flushSessionEventCommits();
      getOrCreateSessionMock.mock.calls[0]?.[3]?.onRemoved?.();
      await flushSessionEventCommits();

      expect(endPlanTurnMock).toHaveBeenCalledTimes(1);
      expect(livePlanTurnCount()).toBe(0);
    } finally {
      onTurnRevived.mockRestore();
      onTurnTerminal.mockRestore();
    }
  });

  it('re-leases a turn started by a picked-up input', async () => {
    await dispatchWorktreeChatTurn(
      baseOptions({ projectId: 'my-project', worktreeId: 'wt-1' }),
    );
    const session = getMockSession(0);
    Object.assign(session, {
      getSteeringCapabilities: () => ({
        generation: 'g1',
        provider: 'claude',
        steer: true,
        withdraw: true,
        interrupt: true,
      }),
    });
    session.__onEvent({
      type: 'result',
      subtype: 'success',
      canopy_turn_user_message_id: 'msg-1',
    });
    await flushSessionEventCommits();
    expect(endPlanTurnMock).toHaveBeenCalledTimes(1);

    session.__onEvent({
      type: 'canopy_input_delivery',
      provider: 'claude',
      generation: 'g1',
      attemptId: 'a1',
      phase: 'picked-up',
      startsTurn: true,
      userMessageId: 'steered-1',
    });
    await flushSessionEventCommits();
    expect(beginPlanTurnMock).toHaveBeenCalledTimes(2);
    expect(beginPlanTurnMock).toHaveBeenLastCalledWith(worktreeTurnKey(), {
      projectId: 'my-project',
      worktreeId: 'wt-1',
    });
    expect(livePlanTurnCount()).toBe(1);

    session.__onEvent({
      type: 'result',
      subtype: 'success',
      canopy_turn_user_message_id: 'steered-1',
    });
    await flushSessionEventCommits();
    expect(endPlanTurnMock).toHaveBeenCalledTimes(2);
    expect(livePlanTurnCount()).toBe(0);
  });

  it('re-leases a revived settled turn and ends it at its next terminal event', async () => {
    const queueService = chatQueueServiceModule.getChatQueueService();
    const onTurnRevived = jest
      .spyOn(queueService, 'onTurnRevived')
      .mockReturnValue(true);
    const onTurnTerminal = jest
      .spyOn(queueService, 'onTurnTerminal')
      .mockImplementation();
    try {
      await dispatchWorktreeChatTurn(
        baseOptions({ projectId: 'my-project', worktreeId: 'wt-1' }),
      );
      const session = getMockSession(0);
      session.__onEvent({
        type: 'result',
        is_error: false,
        canopy_turn_user_message_id: 'msg-1',
      });
      session.__onEvent({ type: 'assistant', message: 'continued output' });
      await flushSessionEventCommits();
      expect(beginPlanTurnMock).toHaveBeenCalledTimes(2);
      expect(livePlanTurnCount()).toBe(1);

      session.__onEvent({ type: 'result', is_error: false, result: 'Done.' });
      await flushSessionEventCommits();
      expect(endPlanTurnMock).toHaveBeenCalledTimes(2);
      expect(livePlanTurnCount()).toBe(0);
    } finally {
      onTurnRevived.mockRestore();
      onTurnTerminal.mockRestore();
    }
  });

  it('ends the revived lease when canonical state rejects the revival', async () => {
    const queueService = chatQueueServiceModule.getChatQueueService();
    const onTurnRevived = jest
      .spyOn(queueService, 'onTurnRevived')
      .mockReturnValue(true);
    const onTurnTerminal = jest
      .spyOn(queueService, 'onTurnTerminal')
      .mockImplementation();
    const onBeforeChatEvent = jest.fn(
      ({ data }: { data: unknown }): Promise<boolean> =>
        Promise.resolve(
          !(
            typeof data === 'object' &&
            data !== null &&
            'message' in data &&
            data.message === 'rejected continuation'
          ),
        ),
    );
    try {
      await dispatchWorktreeChatTurn(
        baseOptions({
          projectId: 'my-project',
          worktreeId: 'wt-1',
          onBeforeChatEvent,
        }),
      );
      const session = getMockSession(0);
      session.__onEvent({
        type: 'result',
        is_error: false,
        canopy_turn_user_message_id: 'msg-1',
      });
      session.__onEvent({
        type: 'assistant',
        message: 'rejected continuation',
      });
      await flushSessionEventCommits();

      expect(beginPlanTurnMock).toHaveBeenCalledTimes(2);
      expect(endPlanTurnMock).toHaveBeenCalledTimes(2);
      expect(livePlanTurnCount()).toBe(0);
    } finally {
      onTurnRevived.mockRestore();
      onTurnTerminal.mockRestore();
    }
  });
});

describe('dispatchWorktreeChatTurn active-plan context', () => {
  const tabInstruction: PendingSystemInstruction = {
    id: 'plan-file-location:plan-9',
    text: 'Use the authored plan file.',
  };
  const activePlanInstruction: PendingSystemInstruction = {
    id: 'active-plan:plan-1',
    text: 'The user is working with the tracked plan "Roadmap".',
  };

  it('resolves the captured plan beside preparation and prepends it once', async () => {
    resolveActivePlanSystemInstructionMock.mockResolvedValueOnce(
      activePlanInstruction,
    );

    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'my-project',
        worktreeId: 'wt-1',
        text: 'Tighten step two.',
        countsTowardSkillUsage: true,
        activePlan: { planId: 'plan-1', viewedRevisionNumber: 2 },
        pendingSystemInstructions: [tabInstruction],
      }),
    );

    expect(resolveActivePlanSystemInstructionMock).toHaveBeenCalledTimes(1);
    expect(resolveActivePlanSystemInstructionMock).toHaveBeenCalledWith({
      projectId: 'my-project',
      worktreeId: 'wt-1',
      activePlan: { planId: 'plan-1', viewedRevisionNumber: 2 },
    });
    expect(
      resolveActivePlanSystemInstructionMock.mock.invocationCallOrder[0],
    ).toBeLessThan(getOrCreateSessionMock.mock.invocationCallOrder[0] ?? 0);
    expect(buildSubmittedMessageTextMock.mock.calls[0]?.[0]).not.toHaveProperty(
      'pendingSystemInstructions',
    );
    const submittedText = [
      '<system_instruction>',
      tabInstruction.text,
      activePlanInstruction.text,
      '</system_instruction>',
      '',
      'Tighten step two.',
    ].join('\n');
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith(submittedText, {
      userMessageId: 'msg-1',
      countsTowardSkillUsage: true,
    });
    expect(startChatTurnMock.mock.calls[0]?.[0]?.submittedText).toBe(
      submittedText,
    );
  });

  it('keeps pending instructions without an active plan and never infers one', async () => {
    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'my-project',
        worktreeId: 'wt-1',
        text: 'Hello.',
        pendingSystemInstructions: [tabInstruction],
      }),
    );

    expect(resolveActivePlanSystemInstructionMock).toHaveBeenCalledWith({
      projectId: 'my-project',
      worktreeId: 'wt-1',
      activePlan: undefined,
    });
    expect(sendMessageMock).toHaveBeenCalledWith(
      [
        '<system_instruction>',
        tabInstruction.text,
        '</system_instruction>',
        '',
        'Hello.',
      ].join('\n'),
      { userMessageId: 'msg-1' },
    );
  });

  it('does not resolve or prepend instructions for a hidden continuation', async () => {
    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'my-project',
        worktreeId: 'wt-1',
        text: '<system_instruction>Continue</system_instruction>',
        hiddenDeferredContinuation: true,
        countsTowardSkillUsage: true,
        activePlan: { planId: 'plan-1' },
        pendingSystemInstructions: [tabInstruction],
      }),
    );

    expect(resolveActivePlanSystemInstructionMock).not.toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalledWith(
      '<system_instruction>Continue</system_instruction>',
      { userMessageId: 'msg-1' },
    );
  });

  it('drops the active plan from a deferred-tools reload continuation', async () => {
    const registerResumeHandler = jest.spyOn(
      deferredToolsReloadCoordinator,
      'registerResumeHandler',
    );
    try {
      await dispatchWorktreeChatTurn(
        baseOptions({
          projectId: 'my-project',
          worktreeId: 'wt-1',
          activePlan: { planId: 'plan-1' },
        }),
      );
      const resume = registerResumeHandler.mock.calls.find(
        ([scope]) => scope.chatId === 'chat-1',
      )?.[1];
      if (!resume) throw new Error('Expected deferred-tools resume handler');
      const dispatchSpy = jest.fn();
      runWithScopeActivityMock.mockImplementationOnce(
        async <T>(_scope: unknown, operation: () => Promise<T>): Promise<T> => {
          dispatchSpy();
          return operation();
        },
      );
      await resume({
        scope: {
          projectId: 'my-project',
          worktreeId: 'wt-1',
          chatId: 'chat-1',
        },
        requestId: 'reload-request',
        toolCallId: 'tool-call',
        userMessageId: 'msg-1',
        continuationText: 'Continue.',
        enabledResources: [],
        signal: new AbortController().signal,
      });

      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      expect(resolveActivePlanSystemInstructionMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock).toHaveBeenLastCalledWith('Continue.', {
        userMessageId: 'msg-1',
      });
    } finally {
      registerResumeHandler.mockRestore();
    }
  });

  it('still sends when resolving the active plan fails', async () => {
    resolveActivePlanSystemInstructionMock.mockRejectedValueOnce(
      new Error('plans unreadable'),
    );

    await dispatchWorktreeChatTurn(
      baseOptions({
        projectId: 'my-project',
        worktreeId: 'wt-1',
        text: 'Hello.',
        activePlan: { planId: 'plan-1' },
      }),
    );

    expect(sendMessageMock).toHaveBeenCalledWith('Hello.', {
      userMessageId: 'msg-1',
    });
    expect(livePlanTurnCount()).toBe(1);
  });
});

describe('browser handoff acceptance and trusted turn origin', () => {
  const origin = {
    projectId: 'cowork-default',
    worktreeId: 'home',
    chatTabId: 'chat-1',
  };
  const pin = (): void => {
    browserHandoffs.request(
      {
        projectId: origin.projectId,
        worktreeId: origin.worktreeId,
        browserId: 'pinned-browser',
        origin,
      },
      jest.fn(),
    );
  };
  beforeEach(() => {
    browserHandoffs.releaseWorktree(origin.projectId, origin.worktreeId);
    clearPresentationTurn(presentationChatKey(origin));
  });
  afterEach(() => {
    browserHandoffs.releaseWorktree(origin.projectId, origin.worktreeId);
    clearPresentationTurn(presentationChatKey(origin));
  });

  it.each(['user', 'portal', 'automation', 'hook'] as const)(
    'releases only accepted user/portal sends (%s)',
    async (source) => {
      pin();
      await dispatchWorktreeChatTurn(baseOptions({ initiationSource: source }));
      expect(capturePresentationTurn(origin)?.source).toBe(source);
      expect(
        browserHandoffs.snapshot(origin.projectId, origin.worktreeId)
          .handoff === null,
      ).toBe(source === 'user' || source === 'portal');
      getMockSession(0).__onEvent({ type: 'result', is_error: false });
      await flushSessionEventCommits();
      expect(capturePresentationTurn(origin)).toBeUndefined();
    },
  );

  it('records provenance when an untrusted IPC request omits userMessageId', async () => {
    // IPC payloads are not schema-checked at runtime, so a request can omit
    // the id. With no captured turn, undefined === undefined must not be read
    // as a match against the absent capture.
    const options = baseOptions({ initiationSource: 'automation' });
    Reflect.deleteProperty(options, 'userMessageId');
    await expect(dispatchWorktreeChatTurn(options)).resolves.not.toThrow();
    expect(capturePresentationTurn(origin)?.source).toBe('automation');
  });

  it('keeps the pin and clears provenance after a rejected send', async () => {
    pin();
    sendMessageMock.mockImplementationOnce(() => {
      throw new Error('rejected');
    });
    await expect(
      dispatchWorktreeChatTurn(baseOptions({ initiationSource: 'user' })),
    ).rejects.toThrow('rejected');
    expect(
      browserHandoffs.snapshot(origin.projectId, origin.worktreeId).handoff
        ?.browserId,
    ).toBe('pinned-browser');
    expect(capturePresentationTurn(origin)).toBeUndefined();
  });

  it('does not release a replacement installed during asynchronous send preparation', async () => {
    pin();
    setApprovalModeMock.mockImplementationOnce(() => {
      browserHandoffs.request(
        {
          projectId: origin.projectId,
          worktreeId: origin.worktreeId,
          browserId: 'replacement',
          origin,
        },
        jest.fn(),
      );
      return Promise.resolve();
    });
    await dispatchWorktreeChatTurn(
      baseOptions({ initiationSource: 'user', approvalMode: 'ask' }),
    );
    expect(setApprovalModeMock).toHaveBeenCalled();
    expect(
      browserHandoffs.snapshot(origin.projectId, origin.worktreeId).handoff
        ?.browserId,
    ).toBe('replacement');
  });

  it('does not release a handoff owned by another chat', async () => {
    pin();
    await dispatchWorktreeChatTurn(
      baseOptions({ chatId: 'chat-2', initiationSource: 'user' }),
    );
    expect(
      browserHandoffs.snapshot(origin.projectId, origin.worktreeId).handoff
        ?.browserId,
    ).toBe('pinned-browser');
    clearPresentationTurn(
      presentationChatKey({ ...origin, chatTabId: 'chat-2' }),
    );
  });
});
