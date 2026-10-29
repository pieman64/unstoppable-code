import type * as ValidationModule from '../lib/validation';
import type * as ActiveChatInputModule from '../services/active-chat-input';
const mockEditRetainedTerminalAgentInput = jest
  .fn<Promise<void>, [unknown]>()
  .mockResolvedValue(undefined);
const mockReadCursorAccount = jest.fn(
  (): Promise<{ email: string } | null> => Promise.resolve({ email: '' }),
);
jest.mock('../cursor/connection', () => ({
  readCursorAccount: (): Promise<{ email: string } | null> =>
    mockReadCursorAccount(),
}));
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import type * as AgentDefaultModelModule from '../agents/agent-default-model';
import type * as DesktopSharedTypesModule from '@canopy/desktop-shared/types';
import type * as WorktreeChatTurnModule from '../lib/worktree-chat-turn';
import type * as WorkOwnerModule from '../agents/work-owner';
import type * as ChatTabDispatchUtilsModule from '../lib/chat-tab-dispatch-utils';
import type * as DeliveryTrackerModule from '../memory/delivery-tracker';
import type * as ModelGatewayStateModule from '../lib/model-gateway-state';

const mockPrepareOrgMemory = jest
  .fn<Promise<unknown>, [unknown]>()
  .mockResolvedValue(null);
jest.mock('../lib/worktree-chat-turn', () => ({
  ...jest.requireActual<typeof WorktreeChatTurnModule>(
    '../lib/worktree-chat-turn',
  ),
  prepareOrgMemory: (options: unknown) => mockPrepareOrgMemory(options),
}));

const mockPersistOrgMemoryUsedForChat = jest
  .fn<Promise<boolean>, [unknown]>()
  .mockResolvedValue(true);
jest.mock('../lib/chat-tab-dispatch-utils', () => ({
  ...jest.requireActual<typeof ChatTabDispatchUtilsModule>(
    '../lib/chat-tab-dispatch-utils',
  ),
  persistOrgMemoryUsedForChat: (args: unknown) =>
    mockPersistOrgMemoryUsedForChat(args),
}));

const mockMemoryAckDelivered = jest.fn();
const mockMemoryAckDropped = jest.fn();
jest.mock('../memory/delivery-tracker', () => {
  const actual = jest.requireActual<typeof DeliveryTrackerModule>(
    '../memory/delivery-tracker',
  );
  return {
    ...actual,
    createOrgMemoryDeliveryTracker: (
      options: DeliveryTrackerModule.OrgMemoryDeliveryTrackerOptions,
    ): DeliveryTrackerModule.OrgMemoryDeliveryTracker => {
      const tracker = actual.createOrgMemoryDeliveryTracker(options);
      return {
        ...tracker,
        ackDelivered: (organizationExternalId, searchId): void => {
          mockMemoryAckDelivered(organizationExternalId, searchId);
          tracker.ackDelivered(organizationExternalId, searchId);
        },
        ackDropped: (organizationExternalId, searchId, reason): void => {
          mockMemoryAckDropped(organizationExternalId, searchId, reason);
          tracker.ackDropped(organizationExternalId, searchId, reason);
        },
      };
    },
  };
});

jest.mock('../opencode/connection', () => ({
  assertOpenCodeModelAvailable: () =>
    Promise.resolve({ id: 'opencode:fixture%2Fmodel' }),
}));
jest.mock('../opencode/runtime-availability', () => ({
  isOpenCodeRuntimeAvailable: () => Promise.resolve(true),
}));

const mockAssertCopilotModelAvailable = jest.fn<
  Promise<void>,
  [string | undefined]
>(() => Promise.reject(new Error('This Copilot model is unavailable.')));
jest.mock('../copilot/connection', () => ({
  assertCopilotModelAvailable: (model?: string) =>
    mockAssertCopilotModelAvailable(model),
}));
jest.mock('../copilot/runtime-availability', () => ({
  isCopilotRuntimeAvailable: () => Promise.resolve(true),
}));

const mockCursorFlagEnabled = jest.fn(() => true);
jest.mock('../feature-flags', () => ({
  getFeatureFlagService: () => ({ isEnabled: mockCursorFlagEnabled }),
}));
jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));

const mockCursorConnectionStatus = jest.fn(() =>
  Promise.resolve({
    supported: true,
    installed: true,
    enabled: true,
    version: 'test',
    phase: 'connected',
  }),
);
jest.mock('../cursor/runtime-status', () => ({
  cursorConnectionStatus: () => mockCursorConnectionStatus(),
}));
// `isCursorRuntimeAvailable` lives in `runtime-availability`, which is what
// `ipc/chat.ts` imports. Declaring it on `runtime-status` left a dead mock and
// ran the real implementation.
jest.mock('../cursor/runtime-availability', () => ({
  isCursorRuntimeAvailable: async () => {
    try {
      const status = await mockCursorConnectionStatus();
      return status.supported && status.enabled && status.installed;
    } catch {
      return false;
    }
  },
}));

jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(() => '/tmp/repo'),
  resolveWorktreeTargetIds: jest.fn(() => null),
  isBranchPromptSent: jest.fn().mockResolvedValue(true),
  doesBranchMatchWorktreeId: jest.fn().mockResolvedValue({
    matches: false,
    matchingRepos: null,
  }),
}));

jest.mock('../lib/worktree-repair', () => ({
  recordWorktreeDiscovery: jest.fn(),
}));

jest.mock('../lib/branch-namer', () => ({
  generateAndRenameBranch: jest.fn().mockResolvedValue(undefined),
}));

const mockResolveAgentDestinationDefaultModel = jest.fn<
  Promise<string>,
  [string | undefined]
>();
jest.mock('../agents/agent-default-model', () => {
  const actual = jest.requireActual<typeof AgentDefaultModelModule>(
    '../agents/agent-default-model',
  );
  return {
    ...actual,
    resolveAgentDestinationDefaultModel: (
      projectId: string | undefined,
    ): Promise<string> => mockResolveAgentDestinationDefaultModel(projectId),
    // The real pin's rules (unit-tested in agent-default-model.test.ts) over
    // the mocked destination default.
    resolveSendModelPin: async (
      projectId: string,
      stored: string | undefined,
      requested: string | undefined,
    ): Promise<string | undefined> => {
      const selected = requested ?? stored;
      const { isInheritingAgentModel } = jest.requireActual<
        typeof DesktopSharedTypesModule
      >('@canopy/desktop-shared/types');
      // The real resolver reads the default only to pin a bare inheriting
      // Agent the chat holds no route for; give it that route, pinned to the
      // mocked default, as the chat's own.
      const needsDefault =
        selected !== undefined &&
        isInheritingAgentModel(selected) &&
        !stored?.startsWith(`${selected}@`);
      const chatModel = needsDefault
        ? actual.formatInheritedAgentRoute(
            selected,
            await mockResolveAgentDestinationDefaultModel(projectId),
          )
        : stored;
      return actual.resolveSendModelPin(projectId, chatModel, selected);
    },
  };
});

jest.mock('../agents/utils', () => ({
  HANDOFF_SUMMARY_MODEL: 'claude-haiku-4-5-20251001',
  generateHandoffSummary: jest.fn().mockResolvedValue({
    text: 'handoff summary',
    usage: {},
  }),
}));

const mockResolveSessionWorkOwner = jest.fn(() => Promise.resolve(undefined));
const mockCaptureSessionWorkOwner = jest.fn();
jest.mock('../agents/work-owner', () => {
  const actual = jest.requireActual<typeof WorkOwnerModule>(
    '../agents/work-owner',
  );
  return {
    ...actual,
    captureSessionWorkOwner: (...args: unknown[]): unknown =>
      mockCaptureSessionWorkOwner(...args),
    resolveSessionWorkOwner: (...args: unknown[]): unknown =>
      mockResolveSessionWorkOwner(...args),
  };
});

jest.mock('../codex/fork-thread', () => ({
  forkCodexThreadByIdViaOneShot: jest.fn(),
}));

jest.mock('../lib/validation', () => ({
  validateId: jest.fn(),
  validateOptionalRepoId: jest.fn(),
}));

jest.mock('../lib/usage-limited-chats-registry', () => ({
  clearUsageLimitedChat: jest.fn(),
}));

const blockedModelIds = new Set<string>();
jest.mock('../lib/model-policy-state', () => ({
  // Async, matching the real guard: enforcement must consult the stored
  // account, not process-local state that is empty during startup.
  isModelBlockedByStoredPolicy: (modelId: string): Promise<boolean> =>
    Promise.resolve(blockedModelIds.has(modelId)),
  isOrgModelPolicyActiveForStoredAccount: (): Promise<boolean> =>
    Promise.resolve(false),
  isStoredModelPolicyReadDegraded: (): boolean => false,
}));

const mockCheckModelGatewayRoute = jest.fn<
  Promise<{ ok: true; orgRoute: boolean } | { ok: false; message: string }>,
  [string | undefined, unknown]
>(() => Promise.resolve({ ok: true, orgRoute: false }));
jest.mock('../lib/model-gateway-state', () => ({
  ...jest.requireActual<typeof ModelGatewayStateModule>(
    '../lib/model-gateway-state',
  ),
  checkModelGatewayRoute: (modelId: string | undefined, owner: unknown) =>
    mockCheckModelGatewayRoute(modelId, owner),
}));

jest.mock('../auth/provider-auth-state', () => ({
  isProviderNativelyAuthenticatedForRouting: (): Promise<boolean> =>
    Promise.resolve(true),
  peekProviderNativeAuthAvailability: (): {
    claude: boolean;
    codex: boolean;
  } => ({ claude: true, codex: true }),
}));

const mockRouteDesktopAutoTurn = jest.fn();
jest.mock('../model-routing/route-turn', () => ({
  routeDesktopAutoTurn: (...args: unknown[]): unknown =>
    mockRouteDesktopAutoTurn(...args),
}));

jest.mock('../agents/ai-credits-routing', () => ({
  getAiCreditsRoutingContext: (): Promise<null> => Promise.resolve(null),
  // Lane resolution reads the context and its degraded status as ONE value so
  // a concurrent read cannot move the status out from under it. `degraded:
  // false` here means the `null` above is a real sign-out, not a failed read.
  getAiCreditsRoutingContextWithStatus: (): Promise<{
    context: null;
    degraded: boolean;
  }> => Promise.resolve({ context: null, degraded: false }),
}));

jest.mock('../lib/transient-error-retry-service', () => ({
  cancelTransientRetryForChat: jest.fn(),
  getTransientRetryStateSnapshot: jest.fn(() => []),
}));

// CAN-1814 PR 5/7. The send-time auth preflight is cached-only and owns its own
// module; here only its VERDICT matters. `requireActual` is spread rather than
// hand-rolling a double so `TurnAuthPreflightBlockedError` stays the real class
// -- the handler identifies a refusal with `instanceof`, and a fake class would
// make that check pass without proving anything about production.
const mockAssertTurnAuthDependencies = jest.fn<Promise<void>, [unknown]>(() =>
  Promise.resolve(),
);
jest.mock('../lib/auth-preflight', () => {
  const actual = jest.requireActual<typeof AuthPreflightModule>(
    '../lib/auth-preflight',
  );
  return {
    ...actual,
    assertTurnAuthDependencies: (input: unknown): Promise<void> =>
      mockAssertTurnAuthDependencies(input),
  };
});

const resetChatToPointMock = jest.fn();
jest.mock('../lib/chat-reset-to-point', () => ({
  resetChatToPoint: (...args: unknown[]): unknown =>
    resetChatToPointMock(...args),
}));

const buildPlanFileSystemInstructionMock = jest.fn();
jest.mock('../lib/plan-system-instructions', () => ({
  buildPlanFileSystemInstruction: (...args: unknown[]): unknown =>
    buildPlanFileSystemInstructionMock(...args),
}));

const cancelQueuedHookChatMock = jest.fn<{ cancelled: boolean }, [string]>(
  () => ({ cancelled: true }),
);
const forceQueuedHookChatMock = jest.fn<Promise<{ forced: boolean }>, [string]>(
  () => Promise.resolve({ forced: true }),
);
const updateQueuedHookChatPlanModeMock = jest.fn();
const updateQueuedHookChatApprovalModeMock = jest.fn();
const updateQueuedHookChatCodexFastModeMock = jest.fn();
const updateQueuedHookChatThinkingLevelMock = jest.fn();
const updateQueuedHookChatInterfaceModeMock = jest.fn(() => true);
const updateQueuedHookChatModelMock = jest.fn();
const updateQueuedHookChatPluginSelectionsMock = jest.fn();
const hasQueuedHookChatMock = jest.fn(() => false);

jest.mock('../lib/hook-chat', () => ({
  hasQueuedHookChat: (...args: unknown[]): unknown =>
    hasQueuedHookChatMock(...args),
  cancelQueuedHookChat: (...args: [string]): { cancelled: boolean } =>
    cancelQueuedHookChatMock(...args),
  forceQueuedHookChat: (...args: [string]): Promise<{ forced: boolean }> =>
    forceQueuedHookChatMock(...args),
  updateQueuedHookChatPlanMode: (...args: unknown[]): unknown =>
    updateQueuedHookChatPlanModeMock(...args),
  updateQueuedHookChatApprovalMode: (...args: unknown[]): unknown =>
    updateQueuedHookChatApprovalModeMock(...args),
  updateQueuedHookChatCodexFastMode: (...args: unknown[]): unknown =>
    updateQueuedHookChatCodexFastModeMock(...args),
  updateQueuedHookChatThinkingLevel: (...args: unknown[]): unknown =>
    updateQueuedHookChatThinkingLevelMock(...args),
  updateQueuedHookChatInterfaceMode: (...args: unknown[]): unknown =>
    updateQueuedHookChatInterfaceModeMock(...args),
  updateQueuedHookChatModel: (...args: unknown[]): unknown =>
    updateQueuedHookChatModelMock(...args),
  updateQueuedHookChatPluginSelections: (...args: unknown[]): unknown =>
    updateQueuedHookChatPluginSelectionsMock(...args),
}));

jest.mock('../agents/session-manager', () => ({
  beginSessionTurnPreparation: jest.fn(() => jest.fn()),
  releaseSessionTurnPreparationOnActivation: jest.fn(),
  getOrCreateSession: jest.fn(),
  getSession: jest.fn(),
  getSessionSelectedModel: jest.fn(),
  getActiveChatIds: jest.fn(() => []),
  hasPendingCodexContinuation: jest.fn(() => false),
  getActiveSessionInfos: jest.fn(() => []),
  getActiveSessionCapabilityProfile: jest.fn(() => undefined),
  getChatTurnConcurrencySnapshot: jest.fn(() => ({
    activeTurns: 0,
    pendingMessages: 0,
  })),
  drainChatSessionEvents: jest.fn(() => Promise.resolve()),
  destroySession: jest.fn().mockResolvedValue(undefined),
  suppressCodexAuthenticationRecovery: jest.fn(),
  markSessionForNextTurnRecreation: jest.fn(),
  getSessionProviderType: jest.fn(),
  getSessionCodeGraphToolsAdvertised: jest.fn(() => undefined),
  getSessionGlobalInstructionsSnapshot: jest.fn(() => undefined),
  shouldRecreateSessionOnNextTurn: jest.fn(() => false),
  isProviderChangeAllowed: jest.fn(() => true),
  buildSessionKey: jest.fn(
    (projectId: string, worktreeId: string, chatId: string) =>
      `${projectId}/${worktreeId}/${chatId}`,
  ),
  subscribeChatSessionActivity: jest.fn((): (() => void) => () => {}),
  hasActiveChatTurns: jest.fn(() => false),
  isSessionAiCreditsRouted: jest.fn(() => false),
  isSessionAccountProxyRouted: jest.fn(() => false),
  getSessionAiCreditsRoutedState: jest.fn(() => undefined),
  getSessionPluginSelections: jest.fn(() => undefined),
  getSessionGlobalPluginDefaultsRevision: jest.fn(() => undefined),
  getGlobalPluginDefaultsRevision: jest.fn(() => 0),
  subscribeGlobalPluginDefaultsRevision: jest.fn((): (() => void) => () => {}),
}));

jest.mock('../mcp/pending-requests', () => ({
  resolveRequest: jest.fn(),
  rejectRequest: jest.fn(),
}));

jest.mock('../mcp/plan-pending-requests', () => ({
  approvePlanExit: jest.fn(),
  denyPlanExit: jest.fn(),
}));

const mockResolvePersistedApprovalMode = jest.fn().mockResolvedValue('ask');
const mockResolveApprovalProjectId = jest.fn(
  (projectId: string): string | undefined => projectId,
);
const mockSurfaceForChat = jest.fn((): string => 'worktree');
const mockEndPendingApprovalDefaultWrite = jest.fn();
const mockApprovalDefaultIntentGenerations = new Map<string, number>();
const mockCommittedApprovalDefaultIntentGenerations = new Map<string, number>();
const mockBeginApprovalDefaultIntent = jest.fn((surface: string): number => {
  const generation =
    (mockApprovalDefaultIntentGenerations.get(surface) ?? 0) + 1;
  mockApprovalDefaultIntentGenerations.set(surface, generation);
  return generation;
});
const mockIsApprovalDefaultIntentCurrent = jest.fn(
  (surface: string, generation: number): boolean =>
    (mockCommittedApprovalDefaultIntentGenerations.get(surface) ?? 0) <=
    generation,
);
const mockCommitApprovalDefaultIntent = jest.fn(
  (surface: string, generation: number): void => {
    const committedGeneration =
      mockCommittedApprovalDefaultIntentGenerations.get(surface) ?? 0;
    if (generation > committedGeneration) {
      mockCommittedApprovalDefaultIntentGenerations.set(surface, generation);
    }
  },
);
const mockBeginPendingApprovalDefaultWrite = jest.fn(
  (): (() => void) => mockEndPendingApprovalDefaultWrite,
);
jest.mock('../lib/approval-mode-resolution', () => ({
  resolvePersistedApprovalMode: (...args: unknown[]): unknown =>
    mockResolvePersistedApprovalMode(...args),
  resolveApprovalProjectId: (...args: unknown[]): unknown =>
    mockResolveApprovalProjectId(...(args as [string])),
  surfaceForChat: (...args: unknown[]): unknown => mockSurfaceForChat(...args),
  defaultsKeyForSurface: (surface: string): string =>
    surface === 'cowork'
      ? 'cowork'
      : surface === 'app-advisor'
        ? 'appAdvisor'
        : 'worktree',
  beginPendingApprovalDefaultWrite: (...args: unknown[]): unknown =>
    mockBeginPendingApprovalDefaultWrite(...(args as [])),
  beginApprovalDefaultIntent: (...args: unknown[]): unknown =>
    mockBeginApprovalDefaultIntent(...(args as [string])),
  commitApprovalDefaultIntent: (...args: unknown[]): unknown =>
    mockCommitApprovalDefaultIntent(...(args as [string, number])),
  isApprovalDefaultIntentCurrent: (...args: unknown[]): unknown =>
    mockIsApprovalDefaultIntentCurrent(...(args as [string, number])),
  isEphemeralApprovalSurface: (projectId: string): boolean =>
    projectId === 'code-review-chat' || projectId === 'plan-explore-chat',
}));

const mockBroadcastPreferencesSynced = jest.fn();
jest.mock('../lib/preferences-broadcast', () => ({
  broadcastPreferencesSynced: (...args: unknown[]): unknown =>
    mockBroadcastPreferencesSynced(...args),
}));

const mockReadPreferencesFile = jest.fn();
const mockGetWorkspaceType = jest.fn();
const mockReadEffectiveWorkspaceConfig = jest.fn();

jest.mock('../ipc/preferences', () => ({
  readPreferencesFile: mockReadPreferencesFile,
}));

// Simulates `updatePreferencesFileWithPrevious`: the updater runs INSIDE the
// serialized write queue and is handed the state as re-read at that moment,
// not the caller's earlier snapshot. Tests that need to model a concurrent
// write set `queuedPreferencesState` to whatever landed in between.
let queuedPreferencesState: unknown = {};
const mockPeekPreferencesLoadError = jest.fn<unknown, unknown[]>(() => null);
const mockUpdatePreferencesFile = jest.fn(
  (updater: (previous: unknown) => unknown): Promise<unknown> =>
    Promise.resolve(updater(queuedPreferencesState)),
);
jest.mock('../lib/preferences-store', () => ({
  // Not degraded: approval resolution fails closed when this is non-null.
  peekPreferencesLoadError: (...args: unknown[]): unknown =>
    mockPeekPreferencesLoadError(...args),
  readPreferencesFile: mockReadPreferencesFile,
  updatePreferencesFile: (...args: unknown[]): unknown =>
    mockUpdatePreferencesFile(...(args as [(previous: unknown) => unknown])),
}));

jest.mock('../lib/workspace-registry', () => ({
  getWorkspaceType: (workspaceId: string): unknown =>
    mockGetWorkspaceType(workspaceId),
  // 'standalone-chat' is the legacy sentinel keying; 'cowork-default'
  // simulates a real, rekeyed cowork workspace id so cowork-treatment tests
  // can exercise both keyings.
  isCoworkWorkspace: (id: string): boolean =>
    id === 'standalone-chat' || id === 'cowork-default',
  isWorkEntryWorkspace: (id: string): boolean =>
    id === 'app-advisor' || id === 'standalone-chat' || id === 'cowork-default',
}));

jest.mock('../lib/workspace-source', () => ({
  readEffectiveWorkspaceConfig: (workspaceId: string): unknown =>
    mockReadEffectiveWorkspaceConfig(workspaceId),
}));

jest.mock('../ipc/standalone-chat', () => ({
  generateChatSummaryForProject: jest.fn().mockResolvedValue('summary'),
  updateChatMeta: jest.fn().mockResolvedValue(undefined),
}));

const scheduleSummaryGenerationMock = jest.fn();
jest.mock('../lib/worktree-summary-scheduler', () => ({
  scheduleSummaryGeneration: scheduleSummaryGenerationMock,
}));

const startObservedTaskMock = jest.fn<
  ReturnType<ObservabilityService['startObservedTask']>,
  Parameters<ObservabilityService['startObservedTask']>
>();
const finalizeObservedTaskMock = jest.fn<
  ReturnType<ObservabilityService['finalizeObservedTask']>,
  Parameters<ObservabilityService['finalizeObservedTask']>
>();
const observeChatEventMock = jest.fn();
const completeChatTurnMock = jest.fn();
const recordSessionDiagnosticMock = jest.fn();
const recordInjectedPromptForOpenChatTurnMock = jest.fn();
const startChatTurnMock = jest.fn<
  void,
  [Parameters<ObservabilityService['startChatTurn']>[0]]
>();
const mockCheckWatcherIngress = jest.fn<
  ReturnType<typeof ActiveChatInputModule.checkWatcherDeliveryIngress>,
  [unknown]
>();
jest.mock('../services/active-chat-input', () => {
  const actual = jest.requireActual<typeof ActiveChatInputModule>(
    '../services/active-chat-input',
  );
  return {
    ...actual,
    checkWatcherDeliveryIngress: (request: unknown) =>
      mockCheckWatcherIngress(request),
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
const mockHandleChatTerminalEvent = jest.fn();

jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    startObservedTask: startObservedTaskMock,
    finalizeObservedTask: finalizeObservedTaskMock,
    observeChatEvent: observeChatEventMock,
    completeChatTurn: completeChatTurnMock,
    startChatTurn: startChatTurnMock,
    recordSessionDiagnostic: recordSessionDiagnosticMock,
    recordInjectedPromptForOpenChatTurn:
      recordInjectedPromptForOpenChatTurnMock,
  })),
}));

jest.mock('../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: jest.fn(() => ({
    handleCanonicalChatTerminalEvent: mockHandleChatTerminalEvent,
  })),
}));

jest.mock('../lib/turn-diff-capture', () => ({
  captureTurnStart: jest.fn().mockResolvedValue(undefined),
  captureTurnEndAndDiff: jest.fn().mockResolvedValue(null),
}));

jest.mock('../lib/window-send', () => ({
  sendToWindow: jest.fn(),
  sendToWindowDetailed: jest.fn(),
}));

const mockReadChatTabsFile = jest.fn<Promise<ChatTabsFile>, [string, string]>();
jest.mock('../lib/chat-tabs-reader', () => ({
  readPersistedChatDispatchMetadata: jest.fn().mockResolvedValue({}),
  readChatTabsFile: (...args: [string, string]): Promise<ChatTabsFile> =>
    mockReadChatTabsFile(...args),
}));

const mockWriteChatTabsFile = jest
  .fn<Promise<void>, [string, string, ChatTabsFile, unknown?]>()
  .mockResolvedValue(undefined);
jest.mock('../lib/chat-tabs', () => ({
  writeChatTabsFile: (
    projectId: string,
    worktreeId: string,
    data: ChatTabsFile,
    delta?: unknown,
  ): Promise<void> => mockWriteChatTabsFile(projectId, worktreeId, data, delta),
}));

const mockAnswerPendingQuestion = jest.fn().mockResolvedValue(false);
const mockEnsureChatForTrustedSend = jest.fn().mockResolvedValue(undefined);
const mockRunWithScopeActivity = jest.fn(
  async (
    _scope: { projectId: string; worktreeId: string },
    operation: () => Promise<void>,
  ): Promise<void> => operation(),
);
const mockIngestProviderEvent = jest.fn<Promise<boolean>, [ProviderEventInput]>(
  () => Promise.resolve(true),
);
// Delivery-gated callers read the three-way outcome; by default it mirrors the
// boolean commit mock so existing commit expectations keep their meaning.
const ingestOutcomeFromCommit = async (
  input: ProviderEventInput,
): Promise<ProviderEventIngestOutcome> =>
  (await mockIngestProviderEvent(input)) ? 'applied' : 'not-applied';
const mockIngestProviderEventWithOutcome = jest.fn<
  Promise<ProviderEventIngestOutcome>,
  [ProviderEventInput]
>(ingestOutcomeFromCommit);
const mockHasMutation = jest.fn<
  Promise<boolean>,
  [{ projectId: string; worktreeId: string }, string]
>(() => Promise.resolve(false));
const mockGetChatState = jest.fn<
  Promise<Pick<ChatStateSnapshot, 'runtimeByChatId' | 'tabsFile'>>,
  []
>(() =>
  Promise.resolve({
    runtimeByChatId: {},
    tabsFile: { version: 1, tabs: [], activeTabId: '' },
  }),
);
const mockReconcileHostQueue = jest.fn().mockResolvedValue(undefined);
const mockReplaceCompatibilityTabs = jest.fn(
  (
    scope: { projectId: string; worktreeId: string },
    tabsFile: unknown,
  ): unknown =>
    mockWriteChatTabsFile(scope.projectId, scope.worktreeId, tabsFile),
);
const mockUpdateCompatibilityTab = jest.fn(
  async (
    scope: { projectId: string; worktreeId: string },
    chatId: string,
    update: (
      tab: ChatTabsFile['tabs'][number],
    ) => ChatTabsFile['tabs'][number] | null,
  ) => {
    const file = await mockReadChatTabsFile(scope.projectId, scope.worktreeId);
    let updated = false;
    const tabs = file.tabs.map((tab) => {
      if (tab.id !== chatId) return tab;
      const next = update(tab);
      updated = next !== null;
      return next ?? tab;
    });
    const tabsFile = { ...file, tabs };
    if (updated)
      await mockWriteChatTabsFile(scope.projectId, scope.worktreeId, tabsFile);
    return { tabsFile, updated };
  },
);
const mockChatStateCommand = jest.fn((envelope: unknown) => {
  void envelope;
  return Promise.resolve({
    commandId: 'test',
    revision: 1,
    outcome: 'applied',
  });
});

function lastCanonicalChatCommand(): Record<string, unknown> {
  const calls = mockChatStateCommand.mock.calls;
  const envelope = calls[calls.length - 1]?.[0];
  if (typeof envelope !== 'object' || envelope === null) {
    throw new Error('Expected a canonical chat command envelope');
  }
  const command = (envelope as Record<string, unknown>)['command'];
  if (typeof command !== 'object' || command === null) {
    throw new Error('Expected a canonical chat command');
  }
  return command as Record<string, unknown>;
}
const mockGetCompatibilityTabs = jest.fn(
  (scope: { projectId: string; worktreeId: string }): Promise<ChatTabsFile> =>
    mockReadChatTabsFile(scope.projectId, scope.worktreeId),
);
const mockConsumeTranscript = jest.fn(
  async (
    _scope: unknown,
    _chatId: string,
    _fullOutputs: boolean,
    consume: (
      messages: AsyncIterable<PersistedChatMessage>,
    ) => Promise<unknown>,
  ): Promise<unknown> =>
    consume(
      (async function* (): AsyncGenerator<PersistedChatMessage> {
        await Promise.resolve();
        yield {
          id: 'canonical',
          role: 'user',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'resume this task' }],
        };
      })(),
    ),
);
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: () => ({
    claimRetainedTerminalAgentInputForNative: (
      request: ChatSendMessageRequest,
    ): Promise<ChatSendMessageRequest> => Promise.resolve(request),
    restoreRetainedTerminalAgentInputAfterFailedNativeAdmission:
      (): Promise<void> => Promise.resolve(),
    answerPendingQuestion: mockAnswerPendingQuestion,
    command: mockChatStateCommand,
    consumeTranscript: mockConsumeTranscript,
    ensureChatForTrustedSend: mockEnsureChatForTrustedSend,
    editRetainedTerminalAgentInput: mockEditRetainedTerminalAgentInput,
    getCompatibilityTabs: mockGetCompatibilityTabs,
    getState: mockGetChatState,
    hasMutation: mockHasMutation,
    ingestProviderEvent: mockIngestProviderEvent,
    ingestProviderEventWithOutcome: mockIngestProviderEventWithOutcome,
    inputDelivery: {
      steerWatcher: () => Promise.resolve({ status: 'fallback' as const }),
      stop: async (
        _target: unknown,
        operation: () => Promise<void>,
      ): Promise<void> => operation(),
    },
    reconcileHostQueue: mockReconcileHostQueue,
    replaceCompatibilityTabs: mockReplaceCompatibilityTabs,
    updateCompatibilityTab: mockUpdateCompatibilityTab,
    runWithScopeActivity: mockRunWithScopeActivity,
  }),
}));

// Typed so specs can inspect the transition input without `any`.
const mockMaterializeCodexCapabilityTransition = jest.fn<
  unknown,
  [input: Record<string, unknown>]
>();
jest.mock('../codex/capability-transition', () => ({
  materializeCodexCapabilityTransition: (...args: unknown[]): unknown =>
    mockMaterializeCodexCapabilityTransition(...args),
}));

const mockDispatchAppAdvisorChatMessage = jest.fn<
  Promise<void>,
  [unknown, unknown]
>(() => Promise.resolve());

jest.mock('../app-advisor/chat-service', () => ({
  dispatchAppAdvisorChatMessage: (...args: [unknown, unknown]): Promise<void> =>
    mockDispatchAppAdvisorChatMessage(...args),
}));

const mockDispatchPipelineEditorChatMessage = jest.fn<
  Promise<void>,
  [unknown, unknown]
>(() => Promise.resolve());

jest.mock('../pipeline-editor/chat-service', () => ({
  dispatchPipelineEditorChatMessage: (
    ...args: [unknown, unknown]
  ): Promise<void> => mockDispatchPipelineEditorChatMessage(...args),
}));

const mockClaudeTerminalGetState = jest.fn();
const mockClaudeTerminalCleanup = jest.fn();
const mockClaudeTerminalUpdateDeferredToolsContext = jest.fn();
const mockClaudeTerminalSetPlanMode = jest.fn();
const mockClaudeTerminalSetApprovalMode = jest.fn();

jest.mock('../integration/claude-terminal-session-service', () => ({
  getClaudeTerminalSessionService: jest.fn(() => ({
    getState: mockClaudeTerminalGetState,
    cleanup: mockClaudeTerminalCleanup,
    updateDeferredToolsContext: mockClaudeTerminalUpdateDeferredToolsContext,
    setPlanMode: mockClaudeTerminalSetPlanMode,
    setApprovalMode: mockClaudeTerminalSetApprovalMode,
  })),
}));

import { BrowserWindow } from 'electron';
import type { AgentSession } from '../agents/types';
import type {
  AgentModelConfig,
  ApprovalMode,
  ChatActiveSessionInfo,
  ChatStateSnapshot,
  PersistedChatMessage,
  ChatTabsFile,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import type { ObservabilityService } from '../observability/service';
import type {
  ProviderEventIngestOutcome,
  ProviderEventInput,
} from '../services/chat-state-service';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  DEFAULT_HIDE_ANTHROPIC_NAV,
  IPC_CHANNELS,
  ORG_MEMORY_USED_EVENT_TYPE,
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
  STANDALONE_CHAT_PROJECT_ID,
  initAgentModels,
  initAiGatewayModels,
  initClaudeModels,
  initCodexModels,
  initModelHarnessAssignments,
  initOllamaModels,
} from '@canopy/desktop-shared/types';
import { registerIpcHandler } from '../ipc/register';
import {
  getActiveChatIds,
  getActiveSessionInfos,
  getActiveSessionCapabilityProfile,
  getOrCreateSession,
  getSession,
  getSessionSelectedModel,
  destroySession,
  markSessionForNextTurnRecreation,
  getSessionProviderType,
  isSessionAiCreditsRouted,
  getSessionAiCreditsRoutedState,
  shouldRecreateSessionOnNextTurn,
} from '../agents/session-manager';
import {
  resolveWorktreeCwd,
  doesBranchMatchWorktreeId,
  isBranchPromptSent,
} from '../lib/resolve-worktree';
import { recordWorktreeDiscovery } from '../lib/worktree-repair';
import { generateHandoffSummary } from '../agents/utils';
import { StructuredHelperQueryError } from '@canopy/desktop-shared/lib/structured-helper-query';
import { forkCodexThreadByIdViaOneShot } from '../codex/fork-thread';
import { generateAndRenameBranch } from '../lib/branch-namer';
import { readPreferencesFile } from '../lib/preferences-store';
import { validateId, validateOptionalRepoId } from '../lib/validation';
import { clearUsageLimitedChat } from '../lib/usage-limited-chats-registry';
import {
  cancelTransientRetryForChat,
  getTransientRetryStateSnapshot,
} from '../lib/transient-error-retry-service';
import {
  captureTurnStart,
  captureTurnEndAndDiff,
} from '../lib/turn-diff-capture';
import { sendToWindow, sendToWindowDetailed } from '../lib/window-send';
import { readPersistedChatDispatchMetadata } from '../lib/chat-tabs-reader';
import { getChatQueueService } from '../services/chat-queue-service';
import {
  dispatchHostQueuedWorktreeChatMessage,
  dispatchLocalWorktreeChatMessage,
} from '../services/chat-service';
import type * as AuthPreflightModule from '../lib/auth-preflight';
import { TurnAuthPreflightBlockedError } from '../lib/auth-preflight';
import type { AuthDependencyFailure } from '@canopy/protocol/auth-recovery';
import { changeChatModel, registerChatHandlers } from '../ipc/chat';
import { registerApprovalHandlers } from '../ipc/approvals';
import {
  registerApprovalSession,
  resetApprovalSessionRegistryForTests,
} from '../approvals/approval-session-registry';
import {
  clearLiveApprovalMode,
  getLiveApprovalMode,
  setLiveApprovalMode,
  withApprovalModeOperation,
} from '../approvals/live-approval-modes';
import { getWorktreeAttachmentsDir } from '../lib/paths';
import { updateChatMeta } from '../ipc/standalone-chat';
import { getCoworkManagedSubdir } from '@canopy/desktop-shared/node/lib/cowork-managed-dir';
import { CANOPY_INJECTED_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/canopy-injected-tools';
import { deferredToolsReloadCoordinator } from '../deferred-tools/reload-coordinator';
import { backgroundHelperQueueTestExports } from '../lib/background-helper-queue';
import { getStoppedTurnResumeService } from '../services/stopped-turn-resume-service';

const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
const mockedGetActiveSessionInfos = jest.mocked(getActiveSessionInfos);
const mockedGetOrCreateSession = jest.mocked(getOrCreateSession);
const mockedGetSessionSelectedModel = jest.mocked(getSessionSelectedModel);
const mockedGetSession = jest.mocked(getSession);
const mockedDestroySession = jest.mocked(destroySession);
const mockedMarkSessionForNextTurnRecreation = jest.mocked(
  markSessionForNextTurnRecreation,
);
const mockedGetSessionProviderType = jest.mocked(getSessionProviderType);
const mockedShouldRecreateSessionOnNextTurn = jest.mocked(
  shouldRecreateSessionOnNextTurn,
);
const mockedDoesBranchMatchWorktreeId = jest.mocked(doesBranchMatchWorktreeId);
const mockedIsBranchPromptSent = jest.mocked(isBranchPromptSent);
const mockedRecordWorktreeDiscovery = jest.mocked(recordWorktreeDiscovery);
const mockedGenerateAndRenameBranch = jest.mocked(generateAndRenameBranch);
const mockedReadPreferencesFile = jest.mocked(readPreferencesFile);
const mockedForkCodexThreadByIdViaOneShot = jest.mocked(
  forkCodexThreadByIdViaOneShot,
);
const mockedValidateId = jest.mocked(validateId);
const mockedValidateOptionalRepoId = jest.mocked(validateOptionalRepoId);
const mockedClearUsageLimitedChat = jest.mocked(clearUsageLimitedChat);
const mockedCancelTransientRetryForChat = jest.mocked(
  cancelTransientRetryForChat,
);
const mockedGetTransientRetryStateSnapshot = jest.mocked(
  getTransientRetryStateSnapshot,
);
const mockedCaptureTurnStart = jest.mocked(captureTurnStart);
const mockedCaptureTurnEndAndDiff = jest.mocked(captureTurnEndAndDiff);
const mockedSendToWindow = jest.mocked(sendToWindow);
const mockedSendToWindowDetailed = jest.mocked(sendToWindowDetailed);
const mockedReadPersistedChatDispatchMetadata = jest.mocked(
  readPersistedChatDispatchMetadata,
);
const mockedResolveWorktreeCwd = jest.mocked(resolveWorktreeCwd);
const mockedUpdateChatMeta = jest.mocked(updateChatMeta);
const mockedGenerateHandoffSummary = jest.mocked(generateHandoffSummary);
const mockedCancelQueuedHookChat = jest.mocked(cancelQueuedHookChatMock);
const mockedForceQueuedHookChat = jest.mocked(forceQueuedHookChatMock);
const ensureAppAdvisorWindowMock = jest.fn(() =>
  Promise.resolve({ open: false, focused: false }),
);
const openAppAdvisorWindowMock = jest.fn(() =>
  Promise.resolve({ open: true, focused: true }),
);
const closeAppAdvisorWindowMock = jest.fn(() =>
  Promise.resolve({ open: false, focused: false }),
);
const toggleAppAdvisorWindowMock = jest.fn(() =>
  Promise.resolve({ open: true, focused: true }),
);
const sendAppAdvisorWindowCommandMock = jest.fn();

initClaudeModels([
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
]);
initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);
initOllamaModels([
  {
    id: 'ollama-qwen3-coder',
    rawModelId: 'qwen3-coder',
    label: 'qwen3-coder',
    show: {
      capabilities: ['completion', 'tools'],
    },
  },
]);

function makePreferences(
  overrides: Partial<PreferencesData> = {},
): PreferencesData {
  return {
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
    summaryModel: 'claude-sonnet-4-6',
    summaryThinkingLevel: 'high',
    handoffSummaryModel: 'claude-haiku-4-5-20251001',
    handoffSummaryThinkingLevel: 'off',
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
    ...overrides,
    showDiagnosticsPill: overrides.showDiagnosticsPill ?? true,
  };
}

const PROD_MCP_BLOCKER: AuthDependencyFailure = {
  dependencyClass: 'mcp',
  dependencyId: 'srv-prod:cfg-1',
  displayName: 'Prod MCP server',
  failureClass: 'expired',
  recovery: { kind: 'mcp_oauth', serverId: 'srv-prod', configId: 'cfg-1' },
};

const STAGING_MCP_BLOCKER: AuthDependencyFailure = {
  dependencyClass: 'mcp',
  dependencyId: 'srv-staging:cfg-1',
  displayName: 'Staging MCP server',
  failureClass: 'unauthenticated',
  recovery: { kind: 'mcp_oauth', serverId: 'srv-staging', configId: 'cfg-1' },
};

type HandlerFn = (...args: unknown[]) => unknown;

function getHandler(channel: string): HandlerFn {
  const call = mockedRegisterIpcHandler.mock.calls.find(
    ([registeredChannel]) => registeredChannel === channel,
  );

  if (!call) {
    throw new Error(`No handler registered for ${channel}`);
  }

  const [, handler] = call;
  return (...args: unknown[]): unknown => {
    const result: unknown = Reflect.apply(handler, undefined, args);
    return result;
  };
}

function expectLatestSessionLifecycleDrain(): void {
  const calls = mockedGetOrCreateSession.mock.calls;
  const lifecycle = calls[calls.length - 1]?.[3];
  expect(typeof lifecycle?.drainEventsBeforeRemoval).toBe('function');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function expectChatActiveSessions(value: unknown): {
  activeChatIds: string[];
  sessions?: Array<Record<string, unknown>>;
} {
  if (!isRecord(value)) {
    throw new Error('Expected active sessions response object');
  }
  const { activeChatIds, sessions } = value;
  if (
    !Array.isArray(activeChatIds) ||
    !activeChatIds.every((entry) => typeof entry === 'string')
  ) {
    throw new Error('Expected activeChatIds array');
  }
  if (
    sessions !== undefined &&
    (!Array.isArray(sessions) || !sessions.every((entry) => isRecord(entry)))
  ) {
    throw new Error('Expected sessions array');
  }
  return { activeChatIds, sessions };
}

function makeMockSession(): AgentSession {
  return {
    sendMessage: jest.fn(),
    cancel: jest.fn().mockResolvedValue(undefined),
    destroy: jest.fn().mockResolvedValue(undefined),
    setPlanMode: jest.fn().mockResolvedValue(undefined),
    setApprovalMode: jest.fn().mockResolvedValue(undefined),
    setCodexFastMode: jest.fn().mockResolvedValue(undefined),
    setCodexAppServerIdleTimeoutMinutes: jest.fn().mockResolvedValue(undefined),
    setRtkEnabled: jest.fn().mockResolvedValue(undefined),
    setThinkingLevel: jest.fn().mockResolvedValue(undefined),
    setModel: jest.fn().mockResolvedValue(undefined),
  };
}

function makeActiveSessionInfo(
  overrides: Partial<ChatActiveSessionInfo> = {},
): ChatActiveSessionInfo {
  return {
    projectId: 'proj',
    worktreeId: 'worktree',
    chatId: 'chat',
    providerType: 'codex',
    executionHarness: 'codex',
    turnActive: false,
    createdAt: 1,
    lastActivityAt: 1,
    turnCount: 0,
    pendingMessageCount: 0,
    ...overrides,
  };
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function makeWindowAccessors(
  getMainWindow: () => BrowserWindow | null = () => null,
): Parameters<typeof registerChatHandlers>[0] {
  return {
    getMainWindow,
    getAppAdvisorWindow: () => null,
    openAppAdvisorWindow: openAppAdvisorWindowMock,
    ensureAppAdvisorWindow: ensureAppAdvisorWindowMock,
    closeAppAdvisorWindow: closeAppAdvisorWindowMock,
    toggleAppAdvisorWindow: toggleAppAdvisorWindowMock,
    getAppAdvisorWindowState: () => ({ open: false, focused: false }),
    sendAppAdvisorWindowCommand: sendAppAdvisorWindowCommandMock,
    sendChatWindowCommand: jest.fn(() => true),
    notifyStartupUnlocked: jest.fn(),
  };
}

beforeEach(() => {
  mockCheckWatcherIngress.mockReset().mockResolvedValue({ allowed: true });
  mockPrepareOrgMemory.mockReset().mockResolvedValue(null);
  mockPersistOrgMemoryUsedForChat.mockReset().mockResolvedValue(true);
  mockMemoryAckDelivered.mockReset();
  mockMemoryAckDropped.mockReset();
  getChatQueueService().resetForTests();
  getStoppedTurnResumeService().resetForTests();
});
afterEach(() => {
  getChatQueueService().resetForTests();
  getStoppedTurnResumeService().resetForTests();
});

describe('chat IPC sendMessage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getChatQueueService().resetForTests();
    backgroundHelperQueueTestExports.reset();
    getChatQueueService().resetForTests();
    mockedSendToWindow.mockReturnValue(true);
    mockedSendToWindowDetailed.mockReturnValue({ delivered: true });
    mockedReadPersistedChatDispatchMetadata.mockResolvedValue({});
    mockedDoesBranchMatchWorktreeId.mockResolvedValue({
      matches: false,
    });
    mockedIsBranchPromptSent.mockResolvedValue(true);
    mockedRecordWorktreeDiscovery.mockResolvedValue({
      status: 'recorded',
      worktree: null,
    });
    mockedGenerateAndRenameBranch.mockResolvedValue({});
    mockedReadPreferencesFile.mockResolvedValue(makePreferences());
    mockedClearUsageLimitedChat.mockResolvedValue(undefined);
    mockClaudeTerminalGetState.mockReturnValue(undefined);
    mockClaudeTerminalCleanup.mockResolvedValue(undefined);
    mockGetWorkspaceType.mockReturnValue(null);
    mockReadEffectiveWorkspaceConfig.mockResolvedValue({
      repos: [],
      sourceRepoPath: undefined,
    });
    mockedShouldRecreateSessionOnNextTurn.mockReturnValue(false);
    ensureAppAdvisorWindowMock.mockClear();
    openAppAdvisorWindowMock.mockClear();
    closeAppAdvisorWindowMock.mockClear();
    toggleAppAdvisorWindowMock.mockClear();
    sendAppAdvisorWindowCommandMock.mockClear();
    mockHandleChatTerminalEvent.mockClear();
    mockIngestProviderEvent.mockResolvedValue(true);
    mockIngestProviderEventWithOutcome.mockImplementation(
      ingestOutcomeFromCommit,
    );
    mockHasMutation.mockResolvedValue(false);
    registerChatHandlers(makeWindowAccessors());
  });

  it.each(['../delivery', '', 'delivery/invalid'])(
    'validates watcher delivery ID %p before ingress',
    async (watcherDeliveryId) => {
      const actual =
        jest.requireActual<typeof ValidationModule>('../lib/validation');
      mockedValidateId.mockImplementation(actual.validateId);
      try {
        await expect(
          getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
            projectId: 'proj',
            worktreeId: 'worktree',
            chatId: 'chat',
            userMessageId: 'watcher-root',
            text: 'Watcher fired',
            watcherFired: { kind: 'Task completed' },
            watcherDeliveryId,
          }),
        ).rejects.toThrow('Invalid watcherDeliveryId');
        expect(mockedValidateId).toHaveBeenCalledWith(
          watcherDeliveryId,
          'watcherDeliveryId',
        );
        expect(mockCheckWatcherIngress).not.toHaveBeenCalled();
        expect(mockEnsureChatForTrustedSend).not.toHaveBeenCalled();
      } finally {
        mockedValidateId.mockReset();
      }
    },
  );

  it('returns a typed nonterminal held result before accepting watcher input', async () => {
    mockCheckWatcherIngress.mockResolvedValue({
      allowed: false,
      outcome: 'held',
      reason: 'owner_boundary',
    });
    const result = await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      userMessageId: 'watcher-root',
      text: 'Watcher fired',
      watcherFired: { kind: 'Task completed' },
      watcherDeliveryId: 'delivery-1',
    });
    expect(result).toEqual({
      watcherDeliveryHeld: { outcome: 'held', reason: 'owner_boundary' },
    });
    expect(mockEnsureChatForTrustedSend).not.toHaveBeenCalled();
    expect(mockedGetOrCreateSession).not.toHaveBeenCalled();
  });
  it('returns a typed held result when dispatch rechecks watcher input', async () => {
    mockCheckWatcherIngress
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValue({
        allowed: false,
        outcome: 'held',
        reason: 'advisor_access_disabled',
      });
    const result = await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      userMessageId: 'watcher-root',
      text: 'Watcher fired',
      watcherFired: { kind: 'Task completed' },
      watcherDeliveryId: 'delivery-1',
    });
    expect(mockCheckWatcherIngress.mock.calls.length).toBeGreaterThan(1);
    expect(result).toEqual({
      watcherDeliveryHeld: {
        outcome: 'held',
        reason: 'advisor_access_disabled',
      },
    });
    expect(mockedGetOrCreateSession).not.toHaveBeenCalled();
  });
  it('rejects a recipient send before starting an agent turn', async () => {
    await expect(
      getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
        projectId: 'shared-container-viewer',
        worktreeId: 'container-1',
        chatId: 'published-chat',
        userMessageId: 'message-1',
        text: 'This must not execute',
        model: 'claude-sonnet-4-5',
        providerType: 'claude',
      }),
    ).rejects.toThrow('Shared-container recipient workspaces are read-only');
    expect(startChatTurnMock).not.toHaveBeenCalled();
  });

  it('refuses a legacy plan-chat send before any scope activity', async () => {
    mockRunWithScopeActivity.mockClear();
    await expect(
      getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
        projectId: 'plan-explore-chat',
        worktreeId: 'plan-1',
        chatId: 'legacy-plan-chat',
        userMessageId: 'message-1',
        text: 'This must not execute',
        model: 'claude-sonnet-4-5',
        providerType: 'claude',
      }),
    ).rejects.toThrow('This plan chat is no longer available.');
    // Refused before the scope is opened, so its legacy storage is untouched.
    expect(mockRunWithScopeActivity).not.toHaveBeenCalled();
    expect(startChatTurnMock).not.toHaveBeenCalled();
  });

  it('keeps the queue-edit IPC thin while the backend reaches retained terminal edits', async () => {
    mockEditRetainedTerminalAgentInput.mockClear();
    const request = {
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      entryId: 'accepted-agent',
      text: 'Edited',
    };
    await getHandler(IPC_CHANNELS.chatQueueEdit)(undefined, request);
    expect(mockEditRetainedTerminalAgentInput).toHaveBeenCalledWith(request);
  });

  it('rejects recipient queue edits before touching the host queue', async () => {
    await expect(
      getHandler(IPC_CHANNELS.chatQueueEdit)(undefined, {
        projectId: 'shared-container-viewer',
        worktreeId: 'container-1',
        chatId: 'published-chat',
        entryId: 'queue-entry',
        text: 'This must not persist',
      }),
    ).rejects.toThrow('Shared-container recipient workspaces are read-only');
  });

  it('rejects acquiring a missing queued entry through the existing lock IPC', async () => {
    await expect(
      getHandler(IPC_CHANNELS.chatQueueSetEditLock)(undefined, {
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        entryId: 'missing-entry',
        locked: true,
      }),
    ).rejects.toThrow('This message is no longer available to edit.');
  });

  it('dispatches the first worktree turn with the persisted explicit harness', async () => {
    mockedGetOrCreateSession.mockReturnValue(makeMockSession());
    mockedReadPersistedChatDispatchMetadata.mockResolvedValueOnce({
      model: 'ollama-qwen3-coder',
      providerType: 'ollama',
      executionHarness: 'claude',
    });
    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      userMessageId: 'first-message',
      text: 'Use the chosen harness',
      model: 'ollama-qwen3-coder',
      providerType: 'ollama',
      executionHarness: 'claude',
    });
    expect(startChatTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({ executionHarness: 'claude' }),
    );
  });

  it('refuses a renderer-supplied agentSent marker, dispatching nothing', async () => {
    mockedGetOrCreateSession.mockReturnValue(makeMockSession());
    const send = getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'entry-app-advisor',
      chatId: 'chat',
      userMessageId: 'spoofed-message',
      text: 'Pretend an agent sent this',
      assistantMode: 'app-advisor',
      agentSent: {
        kind: 'external_agent',
        connectionId: '0b9d2c4e-1f3a-4b5c-8d6e-7f8091a2b3c4',
        clientName: 'Spoofed agent',
        verified: true,
        userId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
      },
    });
    await expect(send).rejects.toThrow(
      'Untrusted chat input cannot contain the "agentSent" field.',
    );
    expect(mockDispatchAppAdvisorChatMessage).not.toHaveBeenCalled();
  });

  it('invalidates an older stopped-turn offer when a new turn starts', async () => {
    mockedGetOrCreateSession.mockReturnValue(makeMockSession());
    const target = {
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
    };
    getStoppedTurnResumeService().offer(target, 'stopped-message');

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      ...target,
      userMessageId: 'new-message',
      text: 'Start something else',
    });

    await expect(
      getStoppedTurnResumeService().resume(
        { ...target, userMessageId: 'stopped-message' },
        jest.fn(),
      ),
    ).resolves.toEqual({ disposition: 'stale' });
  });

  it('does not dispatch when Stop arrives while an Auto model change is pending', async () => {
    mockedGetOrCreateSession.mockReturnValue(makeMockSession());
    let releaseModelChange: (() => void) | undefined;
    let markModelChangeStarted: (() => void) | undefined;
    const modelChangeStarted = new Promise<void>((resolve) => {
      markModelChangeStarted = resolve;
    });
    const modelChangePending = new Promise<void>((resolve) => {
      releaseModelChange = resolve;
    });
    mockChatStateCommand.mockImplementation(async (envelope: unknown) => {
      const command =
        typeof envelope === 'object' && envelope !== null
          ? (envelope as { command?: { type?: string } }).command
          : undefined;
      if (command?.type === 'chat.set_model') {
        markModelChangeStarted?.();
        await modelChangePending;
      }
      return {
        commandId: 'test',
        revision: 1,
        outcome: 'applied',
      };
    });
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Auto chat',
          messages: [],
          createdAt: '2026-09-20T00:00:00.000Z',
          providerType: 'claude',
          executionHarness: 'claude',
          model: 'claude-sonnet-4-6',
          modelSelectionMode: 'auto',
        },
      ],
    });
    mockRouteDesktopAutoTurn.mockResolvedValue({
      modelId: 'claude-haiku-4-5-20251001',
      harness: 'claude',
      durableLoss: false,
      attribution: {
        schemaVersion: 1,
        selectionMode: 'auto',
        outcome: 'selected',
        executionLane: 'provider_subscription',
        selectedModelId: 'claude-haiku-4-5-20251001',
      },
    });

    const send = dispatchHostQueuedWorktreeChatMessage(
      {
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        userMessageId: 'auto-message',
        text: 'Route this turn',
        model: 'claude-sonnet-4-6',
        providerType: 'claude',
        modelSelectionMode: 'auto',
      },
      'desktop',
      false,
    );
    void send.catch(() => undefined);
    await Promise.race([
      modelChangeStarted,
      new Promise<void>((_resolve, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `Auto routing did not reach the model change (route calls: ${mockRouteDesktopAutoTurn.mock.calls.length}, command calls: ${mockChatStateCommand.mock.calls.length})`,
              ),
            ),
          100,
        ),
      ),
    ]);

    const cancel = Promise.resolve(
      getHandler(IPC_CHANNELS.chatCancel)(undefined, {
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      }),
    );
    void cancel.catch(() => undefined);
    releaseModelChange?.();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mockEnsureChatForTrustedSend).not.toHaveBeenCalled();
  });

  describe('a send that names an inheriting Agent', () => {
    let persistedModel = 'agent_model_inherit';
    let restoreMocks = (): void => {};

    beforeEach(() => {
      persistedModel = 'agent_model_inherit';
      const readTabs = mockReadChatTabsFile.getMockImplementation();
      const runCommand = mockChatStateCommand.getMockImplementation();
      restoreMocks = (): void => {
        mockReadChatTabsFile.mockImplementation(readTabs);
        if (runCommand) mockChatStateCommand.mockImplementation(runCommand);
      };
      mockResolveAgentDestinationDefaultModel.mockReset();
      initAgentModels([
        {
          id: 'agent_model_inherit',
          name: 'Inherit',
          baseModel: 'default',
          instructions: '',
          pluginSelections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
          },
          createdAt: '2026-10-12T00:00:00.000Z',
          updatedAt: '2026-10-12T00:00:00.000Z',
          available: true,
        },
      ]);
      mockChatStateCommand.mockImplementation((envelope: unknown) => {
        const command = (envelope as { command?: Record<string, unknown> })
          .command;
        if (command?.type === 'chat.set_model') {
          persistedModel = String(command.model);
        }
        return Promise.resolve({
          commandId: 'test',
          revision: 1,
          outcome: 'applied',
        });
      });
      mockReadChatTabsFile.mockImplementation(() =>
        Promise.resolve({
          version: 1,
          activeTabId: 'chat',
          tabs: [
            {
              id: 'chat',
              title: 'Agent chat',
              messages: [],
              createdAt: '2026-10-12T00:00:00.000Z',
              model: persistedModel,
            },
          ],
        }),
      );
    });

    afterEach(() => {
      restoreMocks();
      initAgentModels([]);
    });

    const agentSend = {
      projectId: 'standalone-chat',
      worktreeId: 'entry-1',
      chatId: 'chat',
      userMessageId: 'agent-message',
      text: 'Hello',
    };

    it('pins the chat to its destination default before the send is queued', async () => {
      mockResolveAgentDestinationDefaultModel.mockResolvedValue('gpt-5.5');
      mockEnsureChatForTrustedSend.mockRejectedValueOnce(
        new Error('stop after pin'),
      );

      await expect(
        dispatchLocalWorktreeChatMessage({
          ...agentSend,
          model: 'agent_model_inherit',
        }),
      ).rejects.toThrow('stop after pin');

      expect(persistedModel).toBe('agent_model_inherit@gpt-5.5');
      expect(mockEnsureChatForTrustedSend).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'agent_model_inherit@gpt-5.5',
          providerType: 'codex',
          executionHarness: 'codex',
        }),
      );
    });

    it('pins an Agent stored on the chat when the send names no model', async () => {
      mockResolveAgentDestinationDefaultModel.mockResolvedValue('gpt-5.5');
      mockEnsureChatForTrustedSend.mockRejectedValueOnce(
        new Error('stop after pin'),
      );

      await expect(dispatchLocalWorktreeChatMessage(agentSend)).rejects.toThrow(
        'stop after pin',
      );

      expect(persistedModel).toBe('agent_model_inherit@gpt-5.5');
      expect(mockEnsureChatForTrustedSend).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'agent_model_inherit@gpt-5.5' }),
      );
    });

    it('keeps the route a chat already holds after Settings change', async () => {
      persistedModel = 'agent_model_inherit@gpt-5.5';
      mockResolveAgentDestinationDefaultModel.mockResolvedValue(
        'claude-sonnet-4-6',
      );
      mockEnsureChatForTrustedSend.mockRejectedValueOnce(
        new Error('stop after pin'),
      );

      await expect(
        dispatchLocalWorktreeChatMessage({
          ...agentSend,
          model: 'agent_model_inherit',
        }),
      ).rejects.toThrow('stop after pin');

      expect(persistedModel).toBe('agent_model_inherit@gpt-5.5');
      expect(mockEnsureChatForTrustedSend).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'agent_model_inherit@gpt-5.5' }),
      );
    });

    it('queues nothing for a route whose model is no longer available', async () => {
      await expect(
        dispatchLocalWorktreeChatMessage({
          ...agentSend,
          model: 'agent_model_inherit@removed-model',
        }),
      ).rejects.toThrow('is set to unavailable model "removed-model"');

      expect(mockEnsureChatForTrustedSend).not.toHaveBeenCalled();
      expect(
        getChatQueueService().getWorktreeSnapshots(
          'standalone-chat',
          'entry-1',
        ),
      ).toEqual([]);
    });

    it('queues nothing when the route a chat keeps is on a model no longer available', async () => {
      persistedModel = 'agent_model_inherit@removed-model';

      await expect(
        dispatchLocalWorktreeChatMessage({
          ...agentSend,
          model: 'agent_model_inherit',
        }),
      ).rejects.toThrow('is set to unavailable model "removed-model"');

      expect(persistedModel).toBe('agent_model_inherit@removed-model');
      expect(mockResolveAgentDestinationDefaultModel).not.toHaveBeenCalled();
      expect(mockEnsureChatForTrustedSend).not.toHaveBeenCalled();
      expect(
        getChatQueueService().getWorktreeSnapshots(
          'standalone-chat',
          'entry-1',
        ),
      ).toEqual([]);
    });

    it('runs a queued send on its captured route without reading Settings', async () => {
      mockEnsureChatForTrustedSend.mockRejectedValueOnce(
        new Error('stop after dispatch'),
      );

      await expect(
        dispatchHostQueuedWorktreeChatMessage(
          { ...agentSend, model: 'agent_model_inherit@gpt-5.5' },
          'desktop',
          true,
        ),
      ).rejects.toThrow('stop after dispatch');

      expect(mockResolveAgentDestinationDefaultModel).not.toHaveBeenCalled();
      expect(mockEnsureChatForTrustedSend).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'agent_model_inherit@gpt-5.5' }),
      );
    });

    it('refuses a queued send whose Agent switched to the default model while it waited', async () => {
      await expect(
        dispatchHostQueuedWorktreeChatMessage(
          { ...agentSend, model: 'agent_model_inherit' },
          'desktop',
          true,
        ),
      ).rejects.toThrow(
        'Inherit now uses the default model. Choose it again, then send.',
      );

      expect(mockResolveAgentDestinationDefaultModel).not.toHaveBeenCalled();
      expect(mockEnsureChatForTrustedSend).not.toHaveBeenCalled();
    });

    it.each([
      {
        surface: 'App Advisor',
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-app-advisor',
        assistantMode: 'app-advisor' as const,
        dispatch: mockDispatchAppAdvisorChatMessage,
      },
      {
        surface: 'Pipeline Assistant',
        projectId: PIPELINE_EDITOR_PROJECT_ID,
        worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
        assistantMode: undefined,
        dispatch: mockDispatchPipelineEditorChatMessage,
      },
    ])(
      'pins a $surface tab that still names the Agent before the send is queued',
      async ({ projectId, worktreeId, assistantMode, dispatch }) => {
        mockResolveAgentDestinationDefaultModel.mockResolvedValue('gpt-5.5');

        await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
          projectId,
          worktreeId,
          chatId: 'chat',
          userMessageId: 'agent-message',
          text: 'Hello',
          ...(assistantMode ? { assistantMode } : {}),
        });

        expect(persistedModel).toBe('agent_model_inherit@gpt-5.5');
        expect(mockResolveAgentDestinationDefaultModel).toHaveBeenCalledWith(
          projectId,
        );
        expect(dispatch).toHaveBeenCalledWith(
          expect.objectContaining({
            model: 'agent_model_inherit@gpt-5.5',
            providerType: 'codex',
          }),
          expect.anything(),
        );
      },
    );

    it('queues one committed selection when a model change races the pin', async () => {
      mockResolveAgentDestinationDefaultModel.mockResolvedValue('gpt-5.5');
      mockEnsureChatForTrustedSend.mockRejectedValueOnce(
        new Error('stop after pin'),
      );
      let persistedProvider: unknown;
      let persistedHarness: unknown;
      let racingChange: Promise<boolean> | undefined;
      mockChatStateCommand.mockImplementation((envelope: unknown) => {
        const command = (envelope as { command?: Record<string, unknown> })
          .command;
        if (command?.type === 'chat.set_model') {
          persistedModel = String(command.model);
          persistedProvider = command.providerType;
          persistedHarness = command.executionHarness;
          // Another surface switches the chat right after the pin commits.
          racingChange ??= changeChatModel({
            projectId: 'standalone-chat',
            worktreeId: 'entry-1',
            chatId: 'chat',
            model: 'claude-sonnet-4-6',
          });
        }
        return Promise.resolve({
          commandId: 'test',
          revision: 1,
          outcome: 'applied',
        });
      });
      let delayedFirstRead = false;
      mockReadChatTabsFile.mockImplementation(async () => {
        // Slow the first read after the pin commits, so a change that is not
        // held off by the model-change lock lands before it.
        if (racingChange && !delayedFirstRead) {
          delayedFirstRead = true;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return {
          version: 1,
          activeTabId: 'chat',
          tabs: [
            {
              id: 'chat',
              title: 'Agent chat',
              messages: [],
              createdAt: '2026-10-12T00:00:00.000Z',
              model: persistedModel,
              providerType: persistedProvider,
              executionHarness: persistedHarness,
            },
          ],
        };
      });

      await expect(
        dispatchLocalWorktreeChatMessage({
          ...agentSend,
          model: 'agent_model_inherit',
        }),
      ).rejects.toThrow('stop after pin');
      await expect(racingChange).resolves.toBe(true);
      expect(persistedModel).toBe('claude-sonnet-4-6');

      expect(mockEnsureChatForTrustedSend).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'agent_model_inherit@gpt-5.5',
          providerType: 'codex',
          executionHarness: 'codex',
        }),
      );
    });

    it.each([
      [
        'has no usable default',
        (): void => {
          mockResolveAgentDestinationDefaultModel.mockRejectedValue(
            new Error('No dispatchable model is available (billing-lane).'),
          );
        },
        'No dispatchable model is available (billing-lane).',
      ],
      [
        'defaults to another Agent',
        (): void => {
          mockResolveAgentDestinationDefaultModel.mockResolvedValue(
            'agent_model_other',
          );
        },
        'the default model is an Agent',
      ],
    ])(
      'refuses the send before anything is written when the destination %s',
      async (_case, arrange, message) => {
        arrange();

        await expect(
          dispatchLocalWorktreeChatMessage({
            ...agentSend,
            model: 'agent_model_inherit',
          }),
        ).rejects.toThrow(message);

        expect(persistedModel).toBe('agent_model_inherit');
        expect(mockEnsureChatForTrustedSend).not.toHaveBeenCalled();
        expect(
          getChatQueueService().getWorktreeSnapshots(
            'standalone-chat',
            'entry-1',
          ),
        ).toEqual([]);
      },
    );
  });

  it('binds the session work owner and sends it with the Auto resolve call (CAN-3462)', async () => {
    const owner = {
      kind: 'organization' as const,
      organizationId: '123e4567-e89b-12d3-a456-426614174000',
    };
    mockResolveSessionWorkOwner.mockImplementationOnce(() =>
      Promise.resolve(owner),
    );
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Auto chat',
          messages: [],
          createdAt: '2026-09-20T00:00:00.000Z',
          providerType: 'claude',
          executionHarness: 'claude',
          model: 'claude-sonnet-4-6',
          modelSelectionMode: 'auto',
        },
      ],
    });
    // Stop after routing: only the resolve call's inputs matter here.
    mockRouteDesktopAutoTurn.mockRejectedValue(new Error('stop after routing'));

    await expect(
      dispatchHostQueuedWorktreeChatMessage(
        {
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          userMessageId: 'auto-message',
          text: 'Route this turn',
          model: 'claude-sonnet-4-6',
          providerType: 'claude',
          modelSelectionMode: 'auto',
        },
        'desktop',
        false,
      ),
    ).rejects.toThrow('stop after routing');

    const session = {
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
    };
    expect(mockCaptureSessionWorkOwner).toHaveBeenCalledWith(session);
    expect(mockResolveSessionWorkOwner).toHaveBeenCalledWith(session);
    expect(mockRouteDesktopAutoTurn).toHaveBeenCalledWith(
      expect.objectContaining({ workOwner: owner }),
    );
  });

  it.each([
    [
      'an explicit Ultra fast request',
      { speed: 'ultrafast', fastMode: false },
      {},
      true,
    ],
    [
      'an inherited Ultra fast Codex default',
      undefined,
      { codex: { speed: 'ultrafast', fastMode: false } },
      true,
    ],
    [
      'an explicit Ultra fast request with unreadable preferences',
      { speed: 'ultrafast', fastMode: false },
      {},
      false,
    ],
  ] satisfies Array<
    [
      string,
      AgentModelConfig | undefined,
      PreferencesData['providerModelConfigDefaults'],
      boolean,
    ]
  >)(
    'rejects Auto with %s before routing, model changes, or the prompt commit',
    async (
      _label,
      modelConfig,
      providerModelConfigDefaults,
      preferencesReadable,
    ) => {
      if (preferencesReadable) {
        mockedReadPreferencesFile.mockResolvedValue(
          makePreferences({ providerModelConfigDefaults }),
        );
      } else {
        mockedReadPreferencesFile.mockRejectedValue(
          new Error('preferences unreadable'),
        );
      }
      // Reaching the paid routing call is the failure this test guards.
      mockRouteDesktopAutoTurn.mockRejectedValue(new Error('routing reached'));
      mockReadChatTabsFile.mockResolvedValue({
        version: 1,
        activeTabId: 'chat',
        tabs: [
          {
            id: 'chat',
            title: 'Auto chat',
            messages: [],
            createdAt: '2026-09-20T00:00:00.000Z',
            providerType: 'claude',
            executionHarness: 'claude',
            model: 'claude-sonnet-4-6',
            modelSelectionMode: 'auto',
          },
        ],
      });

      await expect(
        dispatchHostQueuedWorktreeChatMessage(
          {
            projectId: 'project',
            worktreeId: 'worktree',
            chatId: 'chat',
            userMessageId: 'auto-ultra-message',
            text: 'Route this turn',
            model: 'claude-sonnet-4-6',
            providerType: 'claude',
            modelSelectionMode: 'auto',
            ...(modelConfig ? { modelConfig } : {}),
          },
          'desktop',
          false,
        ),
      ).rejects.toThrow(/Ultra fast needs a specific model/);

      expect(mockRouteDesktopAutoTurn).not.toHaveBeenCalled();
      expect(
        mockChatStateCommand.mock.calls.filter(([envelope]) =>
          JSON.stringify(envelope).includes('"chat.set_model"'),
        ),
      ).toEqual([]);
      expect(mockEnsureChatForTrustedSend).not.toHaveBeenCalled();
    },
  );

  it('binds the resolve call to the tab execution context the turn dispatch uses', async () => {
    const executionContext = 'org:123e4567-e89b-12d3-a456-426614174000';
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Auto chat',
          messages: [],
          createdAt: '2026-09-20T00:00:00.000Z',
          providerType: 'claude',
          executionHarness: 'claude',
          model: 'claude-sonnet-4-6',
          modelSelectionMode: 'auto',
          executionContext,
        },
      ],
    });
    mockRouteDesktopAutoTurn.mockRejectedValue(new Error('stop after routing'));

    await expect(
      dispatchHostQueuedWorktreeChatMessage(
        {
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          userMessageId: 'auto-message',
          text: 'Route this turn',
          model: 'claude-sonnet-4-6',
          providerType: 'claude',
          modelSelectionMode: 'auto',
        },
        'desktop',
        false,
      ),
    ).rejects.toThrow('stop after routing');

    expect(mockCaptureSessionWorkOwner).toHaveBeenCalledWith({
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      executionContext,
    });
  });

  it('routes without a work owner when owner authority is unreadable', async () => {
    mockResolveSessionWorkOwner.mockImplementationOnce(() =>
      Promise.resolve(undefined),
    );
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Auto chat',
          messages: [],
          createdAt: '2026-09-20T00:00:00.000Z',
          providerType: 'claude',
          executionHarness: 'claude',
          model: 'claude-sonnet-4-6',
          modelSelectionMode: 'auto',
        },
      ],
    });
    mockRouteDesktopAutoTurn.mockRejectedValue(new Error('stop after routing'));

    await expect(
      dispatchHostQueuedWorktreeChatMessage(
        {
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          userMessageId: 'auto-message',
          text: 'Route this turn',
          model: 'claude-sonnet-4-6',
          providerType: 'claude',
          modelSelectionMode: 'auto',
        },
        'desktop',
        false,
      ),
    ).rejects.toThrow('stop after routing');

    expect(mockRouteDesktopAutoTurn).toHaveBeenCalledTimes(1);
    const calls: unknown = mockRouteDesktopAutoTurn.mock.calls;
    const firstCall: unknown = Array.isArray(calls) ? calls[0] : undefined;
    const routeInput: unknown = Array.isArray(firstCall)
      ? firstCall[0]
      : undefined;
    expect(routeInput).toBeDefined();
    expect(routeInput).not.toHaveProperty('workOwner');
  });

  it('refuses an Auto turn when its routed model can no longer be applied', async () => {
    mockedGetOrCreateSession.mockReturnValue(makeMockSession());
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Auto chat',
          messages: [],
          createdAt: '2026-09-20T00:00:00.000Z',
          providerType: 'claude',
          executionHarness: 'claude',
          model: 'claude-sonnet-4-6',
          modelSelectionMode: 'auto',
        },
      ],
    });
    mockRouteDesktopAutoTurn.mockResolvedValue({
      modelId: 'removed-routed-model',
      harness: 'claude',
      durableLoss: false,
      attribution: {
        schemaVersion: 1,
        selectionMode: 'auto',
        outcome: 'selected',
        executionLane: 'provider_subscription',
        selectedModelId: 'removed-routed-model',
      },
    });

    await expect(
      dispatchHostQueuedWorktreeChatMessage(
        {
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          userMessageId: 'auto-message',
          text: 'Route this turn',
          model: 'claude-sonnet-4-6',
          providerType: 'claude',
          modelSelectionMode: 'auto',
        },
        'desktop',
        false,
      ),
    ).rejects.toMatchObject({
      code: 'auto_model_routing_apply_failed',
      retryable: true,
    });
    expect(mockEnsureChatForTrustedSend).not.toHaveBeenCalled();
  });

  it('applies an Auto-routed managed model without an explicit harness override', async () => {
    mockedGetOrCreateSession.mockReturnValue(makeMockSession());
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Auto chat',
          messages: [],
          createdAt: '2026-09-20T00:00:00.000Z',
          providerType: 'claude',
          model: 'claude-sonnet-4-6',
          modelSelectionMode: 'auto',
        },
      ],
    });
    mockRouteDesktopAutoTurn.mockResolvedValue({
      modelId: 'claude-haiku-4-5-20251001',
      harness: 'claude',
      durableLoss: false,
      attribution: {
        schemaVersion: 1,
        selectionMode: 'auto',
        outcome: 'selected',
        executionLane: 'provider_subscription',
        selectedModelId: 'claude-haiku-4-5-20251001',
      },
    });

    await dispatchHostQueuedWorktreeChatMessage(
      {
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        userMessageId: 'auto-message',
        text: 'Route this turn',
        model: 'claude-sonnet-4-6',
        providerType: 'claude',
        modelSelectionMode: 'auto',
      },
      'desktop',
      false,
    );

    const modelCommand = mockChatStateCommand.mock.calls
      .map(([envelope]) =>
        isRecord(envelope) && isRecord(envelope.command)
          ? envelope.command
          : undefined,
      )
      .find((command) => command?.type === 'chat.set_model');
    expect(modelCommand).toMatchObject({
      type: 'chat.set_model',
      model: 'claude-haiku-4-5-20251001',
      executionHarness: undefined,
    });
    expect(mockEnsureChatForTrustedSend).toHaveBeenCalledTimes(1);
  });

  it('classifies a rejected Auto model mutation as a pre-provider apply failure', async () => {
    mockedGetOrCreateSession.mockReturnValue(makeMockSession());
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Auto chat',
          messages: [],
          createdAt: '2026-09-20T00:00:00.000Z',
          providerType: 'claude',
          executionHarness: 'claude',
          model: 'claude-sonnet-4-6',
          modelSelectionMode: 'auto',
        },
      ],
    });
    mockRouteDesktopAutoTurn.mockResolvedValue({
      modelId: 'claude-haiku-4-5-20251001',
      harness: 'claude',
      durableLoss: false,
      attribution: {
        schemaVersion: 1,
        selectionMode: 'auto',
        outcome: 'selected',
        executionLane: 'provider_subscription',
        selectedModelId: 'claude-haiku-4-5-20251001',
      },
    });
    mockChatStateCommand.mockRejectedValueOnce(
      new Error('canonical model persistence failed'),
    );

    const failure: unknown = await dispatchHostQueuedWorktreeChatMessage(
      {
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        userMessageId: 'auto-message',
        text: 'Route this turn',
        model: 'claude-sonnet-4-6',
        providerType: 'claude',
        modelSelectionMode: 'auto',
      },
      'desktop',
      false,
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: 'auto_model_routing_apply_failed',
      retryable: true,
    });
    if (!isRecord(failure)) throw new Error('Expected an apply failure');
    expect(failure.cause).toBeInstanceOf(Error);
    expect((failure.cause as Error).message).toBe(
      'canonical model persistence failed',
    );
    expect(mockEnsureChatForTrustedSend).not.toHaveBeenCalled();
  });

  it('refuses a stale Copilot model before persisting a user prompt', async () => {
    mockedGetOrCreateSession.mockReturnValue(makeMockSession());
    const failure: unknown = await Promise.resolve(
      getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
        projectId: 'project-1',
        worktreeId: 'main',
        chatId: 'copilot-stale',
        userMessageId: 'copilot-stale-prompt',
        text: 'Do not persist this prompt',
        model: 'copilot:stale-model',
        providerType: 'copilot',
        executionHarness: 'copilot',
      }),
    ).catch((error: unknown) => error);
    expect(mockAssertCopilotModelAvailable).toHaveBeenCalledTimes(1);
    expect(failure).toEqual(new Error('This Copilot model is unavailable.'));
    expect(mockEnsureChatForTrustedSend).not.toHaveBeenCalled();
    expect(mockIngestProviderEvent).not.toHaveBeenCalled();
    expect(mockedGetOrCreateSession).not.toHaveBeenCalled();
  });

  it('runs a model-less Copilot Cowork send with the validated live model', async () => {
    mockAssertCopilotModelAvailable.mockResolvedValueOnce(undefined);
    mockedGetOrCreateSession.mockReturnValue(makeMockSession());
    mockedGetSessionSelectedModel.mockReturnValue('copilot:gpt-5');
    mockedGetActiveSessionInfos.mockReturnValue([
      makeActiveSessionInfo({
        projectId: 'cowork-default',
        worktreeId: 'home',
        chatId: 'copilot-live',
        executionHarness: 'copilot',
        providerType: 'copilot',
      }),
    ]);
    try {
      await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
        projectId: 'cowork-default',
        worktreeId: 'home',
        chatId: 'copilot-live',
        userMessageId: 'copilot-live-prompt',
        text: 'Keep going',
      });
      expect(mockAssertCopilotModelAvailable).toHaveBeenCalledWith(
        'copilot:gpt-5',
      );
      expect(mockIngestProviderEvent).toHaveBeenCalledWith(
        expect.objectContaining({ providerType: 'copilot' }),
      );
      expect(startChatTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'copilot:gpt-5' }),
      );
      expect(mockedGetOrCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({
          executionHarness: 'copilot',
          providerType: 'copilot',
          model: 'copilot:gpt-5',
          selectedModel: 'copilot:gpt-5',
        }),
        expect.any(Function),
        expect.any(Function),
        expect.anything(),
      );
    } finally {
      mockedGetActiveSessionInfos.mockReturnValue([]);
      mockedGetSessionSelectedModel.mockReturnValue(undefined);
    }
  });

  it('rejects a Copilot Cowork send without any model before saving its prompt', async () => {
    mockedReadPersistedChatDispatchMetadata.mockResolvedValue({
      executionHarness: 'copilot',
    });
    await expect(
      getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
        projectId: 'cowork-default',
        worktreeId: 'home',
        chatId: 'copilot-no-model',
        userMessageId: 'copilot-no-model-prompt',
        text: 'Do not save',
      }),
    ).rejects.toThrow('Choose a GitHub Copilot model before sending.');
    expect(mockAssertCopilotModelAvailable).not.toHaveBeenCalled();
    expect(mockEnsureChatForTrustedSend).not.toHaveBeenCalled();
    expect(mockIngestProviderEvent).not.toHaveBeenCalled();
    expect(mockedGetOrCreateSession).not.toHaveBeenCalled();
  });

  // Cowork runs Cursor on the managed runtime (2026-09-25). A session whose
  // harness is `claude` runs on Claude whatever its provider label says, so
  // the old `'active provider'` signal (harness claude, provider cursor) is no
  // longer a Cursor routing input; a request naming only `executionHarness:
  // 'cursor'` with no model fails closed on the host-owned routing mismatch
  // before any preflight runs.
  it.each([
    'request model',
    'request provider',
    'stored model',
    'stored provider',
    'stored harness',
    'active harness',
  ])(
    'preflights Cursor Cowork %s against the managed runtime before persisting a prompt',
    async (signal) => {
      mockCursorConnectionStatus.mockResolvedValue({
        supported: true,
        installed: false,
        enabled: false,
        version: 'test',
        phase: 'disconnected',
      });
      mockedGetOrCreateSession.mockReturnValue(makeMockSession());
      if (signal === 'stored model')
        mockedReadPersistedChatDispatchMetadata.mockResolvedValue({
          model: 'cursor-default',
        });
      if (signal === 'stored provider')
        mockedReadPersistedChatDispatchMetadata.mockResolvedValue({
          providerType: 'cursor',
        });
      if (signal === 'stored harness')
        mockedReadPersistedChatDispatchMetadata.mockResolvedValue({
          executionHarness: 'cursor',
        });
      if (signal === 'active harness')
        mockedGetActiveSessionInfos.mockReturnValue([
          makeActiveSessionInfo({
            projectId: 'cowork-default',
            worktreeId: 'home',
            chatId: 'cursor-rejected',
            executionHarness: 'cursor',
            providerType: 'cursor',
          }),
        ]);
      try {
        await expect(
          getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
            projectId: 'cowork-default',
            worktreeId: 'home',
            chatId: 'cursor-rejected',
            userMessageId: 'cursor-rejected-prompt',
            text: 'Offline Cursor request',
            ...(signal === 'request model' ? { model: 'cursor-default' } : {}),
            ...(signal === 'request provider'
              ? { providerType: 'cursor' }
              : {}),
          }),
        ).rejects.toThrow(
          'Connect Cursor in Settings to send with Cursor, or choose another model.',
        );
        expect(mockEnsureChatForTrustedSend).not.toHaveBeenCalled();
        expect(mockIngestProviderEvent).not.toHaveBeenCalled();
        expect(mockedGetOrCreateSession).not.toHaveBeenCalled();
      } finally {
        mockedGetActiveSessionInfos.mockReturnValue([]);
        mockCursorConnectionStatus.mockResolvedValue({
          supported: true,
          installed: true,
          enabled: true,
          version: 'test',
          phase: 'connected',
        });
      }
    },
  );

  it('persists a Cursor Cowork prompt when the managed runtime is connected', async () => {
    mockedGetOrCreateSession.mockReturnValue(makeMockSession());
    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'cowork-default',
      worktreeId: 'home',
      chatId: 'cursor-accepted',
      userMessageId: 'cursor-accepted-prompt',
      text: 'Cursor in Cowork',
      model: 'cursor-default',
    });
    expect(mockEnsureChatForTrustedSend).toHaveBeenCalled();
  });

  it('runs a Cowork prompt on Claude when the live session harness is claude, whatever its provider label', async () => {
    mockedGetOrCreateSession.mockReturnValue(makeMockSession());
    mockedGetActiveSessionInfos.mockReturnValue([
      makeActiveSessionInfo({
        projectId: 'cowork-default',
        worktreeId: 'home',
        chatId: 'stale-cursor-label',
        executionHarness: 'claude',
        providerType: 'cursor',
      }),
    ]);
    try {
      await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
        projectId: 'cowork-default',
        worktreeId: 'home',
        chatId: 'stale-cursor-label',
        userMessageId: 'stale-cursor-label-prompt',
        text: 'Keep running on Claude',
      });
      expect(mockEnsureChatForTrustedSend).toHaveBeenCalled();
      expect(mockedGetOrCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({
          executionHarness: 'claude',
          providerType: 'claude',
        }),
        expect.any(Function),
        expect.any(Function),
        expect.anything(),
      );
    } finally {
      mockedGetActiveSessionInfos.mockReturnValue([]);
    }
  });

  it('records the Cursor provider on a model-less Cowork prompt that a live Cursor session runs', async () => {
    mockedGetOrCreateSession.mockReturnValue(makeMockSession());
    mockedGetSessionSelectedModel.mockReturnValue('cursor-default');
    mockedGetActiveSessionInfos.mockReturnValue([
      makeActiveSessionInfo({
        projectId: 'cowork-default',
        worktreeId: 'home',
        chatId: 'cursor-live',
        executionHarness: 'cursor',
        providerType: 'cursor',
      }),
    ]);
    try {
      await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
        projectId: 'cowork-default',
        worktreeId: 'home',
        chatId: 'cursor-live',
        userMessageId: 'cursor-live-prompt',
        text: 'Keep going',
      });
      // The request named no provider, so the pre-fix code recorded and ran a
      // `claude` provider under the Cursor harness.
      expect(mockIngestProviderEvent).toHaveBeenCalledWith(
        expect.objectContaining({ providerType: 'cursor' }),
      );
      // The live session's model is threaded into the options so the same
      // session is reused rather than recreated without a model, and the
      // audit trail records the model the turn actually runs on.
      expect(startChatTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'cursor-default' }),
      );
      expect(mockedGetOrCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({
          executionHarness: 'cursor',
          providerType: 'cursor',
          model: 'cursor-default',
          selectedModel: 'cursor-default',
        }),
        expect.any(Function),
        expect.any(Function),
        expect.anything(),
      );
    } finally {
      mockedGetActiveSessionInfos.mockReturnValue([]);
      mockedGetSessionSelectedModel.mockReturnValue(undefined);
    }
  });

  it('refuses a model-less Cowork prompt when the live Cursor session holds no model either', async () => {
    mockedGetOrCreateSession.mockReturnValue(makeMockSession());
    mockedGetActiveSessionInfos.mockReturnValue([
      makeActiveSessionInfo({
        projectId: 'cowork-default',
        worktreeId: 'home',
        chatId: 'cursor-live-no-model',
        executionHarness: 'cursor',
        providerType: 'cursor',
      }),
    ]);
    try {
      await expect(
        getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
          projectId: 'cowork-default',
          worktreeId: 'home',
          chatId: 'cursor-live-no-model',
          userMessageId: 'cursor-live-no-model-prompt',
          text: 'Keep going',
        }),
      ).rejects.toThrow(
        'Choose a Cursor model to send with Cursor, or choose another model.',
      );
      expect(mockEnsureChatForTrustedSend).not.toHaveBeenCalled();
      expect(mockedGetOrCreateSession).not.toHaveBeenCalled();
    } finally {
      mockedGetActiveSessionInfos.mockReturnValue([]);
    }
  });

  it('refuses a model-less Cursor Cowork route before persisting a prompt', async () => {
    mockedGetOrCreateSession.mockReturnValue(makeMockSession());
    mockedReadPersistedChatDispatchMetadata.mockResolvedValue({
      providerType: 'cursor',
    });
    await expect(
      getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
        projectId: 'cowork-default',
        worktreeId: 'home',
        chatId: 'cursor-no-model',
        userMessageId: 'cursor-no-model-prompt',
        text: 'Cursor without a model',
      }),
    ).rejects.toThrow(
      'Choose a Cursor model to send with Cursor, or choose another model.',
    );
    expect(mockEnsureChatForTrustedSend).not.toHaveBeenCalled();
    expect(mockIngestProviderEvent).not.toHaveBeenCalled();
    expect(mockedGetOrCreateSession).not.toHaveBeenCalled();
  });

  it.each(['claude', 'codex'] as const)(
    'CAN-2835 routes reused cowork %s events to the current turn',
    async (providerType) => {
      const session = makeMockSession();
      let retained: ((data: unknown) => void) | undefined;
      mockedGetOrCreateSession.mockImplementation((_opts, onEvent) => {
        retained ??= onEvent;
        return session;
      });
      const send = getHandler(IPC_CHANNELS.chatSendMessage);
      for (const userMessageId of ['first', 'second']) {
        await send(undefined, {
          projectId: 'cowork-default',
          worktreeId: 'reuse-entry',
          chatId: 'reuse-chat',
          userMessageId,
          text: 'testing',
          providerType,
        });
        retained?.({
          type: 'assistant',
          canopy_turn_user_message_id: userMessageId,
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(mockIngestProviderEvent).toHaveBeenLastCalledWith(
          expect.objectContaining({ turnUserMessageId: userMessageId }),
        );
        retained?.({
          type: 'result',
          is_error: false,
          canopy_turn_user_message_id: userMessageId,
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      mockIngestProviderEvent.mockClear();
      retained?.({ type: 'result', canopy_turn_user_message_id: 'first' });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(mockIngestProviderEvent).not.toHaveBeenCalled();
    },
  );

  it('dispatches after Stop disposes a session whose activity registry is still settling', async () => {
    const disposed = makeMockSession();
    disposed.isDisposed = () => true;
    const fresh = makeMockSession();
    const sendFresh = jest.fn();
    fresh.sendMessage = sendFresh;
    mockedGetSession.mockReturnValue(disposed);
    mockedGetOrCreateSession.mockReturnValue(fresh);
    jest.mocked(getActiveChatIds).mockReturnValue(['stop-follow-up']);
    try {
      await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
        projectId: 'cowork-default',
        worktreeId: 'native-entry',
        chatId: 'stop-follow-up',
        userMessageId: 'next',
        text: 'Follow up',
        providerType: 'claude',
      });
      expect(sendFresh).toHaveBeenCalledTimes(1);
      expect(
        getChatQueueService().getWorktreeSnapshots(
          'cowork-default',
          'native-entry',
        ),
      ).toEqual([]);
    } finally {
      jest.mocked(getActiveChatIds).mockReturnValue([]);
      mockedGetSession.mockReturnValue(undefined);
    }
  });

  it.each(['cowork', 'advisor', 'pipeline'] as const)(
    'queues busy %s messages in the canonical host queue',
    async (surface) => {
      const session = makeMockSession();
      mockedGetOrCreateSession.mockReturnValue(session);
      const projectId =
        surface === 'cowork'
          ? 'cowork-default'
          : surface === 'advisor'
            ? APP_ADVISOR_PROJECT_ID
            : PIPELINE_EDITOR_PROJECT_ID;
      const worktreeId =
        surface === 'pipeline' ? PIPELINE_EDITOR_WORKTREE_ID : 'native-entry';
      const send = getHandler(IPC_CHANNELS.chatSendMessage);
      for (const userMessageId of ['first', 'second'])
        await send(undefined, {
          projectId,
          worktreeId,
          chatId: 'native-queue',
          userMessageId,
          text: userMessageId,
          providerType: 'claude',
        });
      const queued = getChatQueueService().getWorktreeSnapshots(
        projectId,
        worktreeId,
      )[0]?.queue;
      expect(queued).toHaveLength(1);
      expect(queued?.[0].text).toBe('second');
    },
  );

  it('follows a committed Claude pickup into a new cowork root turn', async () => {
    const session = makeMockSession();
    session.getSteeringCapabilities = () => ({
      provider: 'claude',
      generation: 'live',
      steer: true,
      withdraw: true,
      interrupt: true,
    });
    mockedGetOrCreateSession.mockReturnValue(session);
    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'cowork-default',
      worktreeId: 'steering-entry',
      chatId: 'steering-chat',
      userMessageId: 'original',
      text: 'Original',
      providerType: 'claude',
    });
    const call = mockedGetOrCreateSession.mock.calls[0];
    const onEvent = call?.[1];
    if (!onEvent) throw new Error('Expected cowork route');
    getChatQueueService().onTurnTerminal(
      {
        projectId: 'cowork-default',
        worktreeId: 'steering-entry',
        chatId: 'steering-chat',
      },
      'complete',
      'original',
    );
    void onEvent({
      type: 'canopy_input_delivery',
      provider: 'claude',
      phase: 'picked-up',
      generation: 'live',
      attemptId: 'attempt',
      startsTurn: true,
      userMessageId: 'selected',
    });
    void onEvent({
      type: 'assistant',
      canopy_turn_user_message_id: 'selected',
      message: {
        id: 'reply',
        role: 'assistant',
        content: [{ type: 'text', text: 'Selected reply' }],
      },
    });
    await call[3]?.drainEventsBeforeRemoval?.();
    expect(mockIngestProviderEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ turnUserMessageId: 'selected' }),
    );
  });

  it('waits for the prior cowork terminal commit before accepting a pickup root', async () => {
    const session = makeMockSession();
    session.getSteeringCapabilities = () => ({
      provider: 'claude',
      generation: 'live',
      steer: true,
      withdraw: true,
      interrupt: true,
    });
    mockedGetOrCreateSession.mockReturnValue(session);
    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'cowork-default',
      worktreeId: 'steering-entry',
      chatId: 'steering-chat',
      userMessageId: 'original',
      text: 'Original',
      providerType: 'claude',
    });
    const call = mockedGetOrCreateSession.mock.calls[0];
    const onEvent = call?.[1];
    if (!onEvent) throw new Error('Expected cowork route');

    let releaseTerminalCommit: ((committed: boolean) => void) | undefined;
    mockIngestProviderEvent.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseTerminalCommit = resolve;
        }),
    );
    void onEvent({ type: 'result', is_error: false, result: 'Done' });
    await flushPromises();
    void onEvent({
      type: 'canopy_input_delivery',
      provider: 'claude',
      phase: 'picked-up',
      generation: 'live',
      attemptId: 'attempt',
      startsTurn: true,
      userMessageId: 'selected',
    });
    await flushPromises();

    releaseTerminalCommit?.(true);
    await call[3]?.drainEventsBeforeRemoval?.();

    const pickupCommit = mockIngestProviderEvent.mock.calls.at(-1)?.[0];
    expect(pickupCommit?.turnUserMessageId).toBe('original');
    expect(
      pickupCommit && isRecord(pickupCommit.data)
        ? pickupCommit.data.turnRootAccepted
        : undefined,
    ).toBe(true);
  });

  it('preserves a fast cowork provider prefix behind a slow durable commit', async () => {
    mockedGetOrCreateSession.mockReturnValue(makeMockSession());
    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'cowork-default',
      worktreeId: 'pressure-entry',
      chatId: 'pressure-chat',
      userMessageId: 'pressure-root',
      text: 'Stress provider delivery',
      providerType: 'claude',
    });
    const call = mockedGetOrCreateSession.mock.calls[0];
    const onEvent = call?.[1];
    if (!onEvent) throw new Error('Missing cowork provider callback');
    const drain = call?.[3]?.drainEventsBeforeRemoval;
    if (!drain) throw new Error('Missing cowork provider drain');
    mockIngestProviderEvent.mockClear();
    let releaseCommit = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    mockIngestProviderEvent.mockImplementationOnce(async () => {
      await held;
      return true;
    });
    const events = [
      ...Array.from({ length: 128 }, (_, sequence) => ({
        type: 'assistant',
        canopy_turn_user_message_id: 'pressure-root',
        sequence,
        message: {
          id: `pressure-${sequence}`,
          role: 'assistant',
          content: [{ type: 'text', text: 'x'.repeat(2048) }],
        },
      })),
      {
        type: 'result',
        canopy_turn_user_message_id: 'pressure-root',
        sequence: 128,
        is_error: false,
        result: 'Done',
      },
    ];
    const largestFrameBytes = Math.max(
      ...events.map((event) =>
        Buffer.byteLength(JSON.stringify(event), 'utf8'),
      ),
    );
    let produced = 0;
    let producedBytes = 0;
    const producer = (async (): Promise<void> => {
      for (const event of events) {
        await onEvent(event);
        produced += 1;
        producedBytes += Buffer.byteLength(JSON.stringify(event), 'utf8');
      }
    })();
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(mockIngestProviderEvent).toHaveBeenCalledTimes(1);
      process.stdout.write(
        `COWORK_PRESSURE_METRIC ${JSON.stringify({
          produced,
          retainedBytesLowerBound: producedBytes,
          startedCommitCalls: mockIngestProviderEvent.mock.calls.length,
        })}\n`,
      );
      expect(producedBytes).toBeLessThanOrEqual(64 * 1024 + largestFrameBytes);
    } finally {
      releaseCommit();
      await producer;
      await drain();
    }
    expect(produced).toBe(events.length);
    const committed = mockIngestProviderEvent.mock.calls
      .map(([request]) => request.data)
      .filter((data): data is Record<string, unknown> => isRecord(data))
      .map((data) => data.sequence)
      .filter((sequence): sequence is number => typeof sequence === 'number');
    expect(committed).toEqual(events.map((event) => event.sequence));
  });

  it('keeps the current cowork root when a committed pickup is rejected', async () => {
    const session = makeMockSession();
    session.getSteeringCapabilities = () => ({
      provider: 'claude',
      generation: 'live',
      steer: true,
      withdraw: true,
      interrupt: true,
    });
    mockedGetOrCreateSession.mockReturnValue(session);
    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'cowork-default',
      worktreeId: 'steering-entry',
      chatId: 'steering-chat',
      userMessageId: 'original',
      text: 'Original',
      providerType: 'claude',
    });
    const call = mockedGetOrCreateSession.mock.calls[0];
    const onEvent = call?.[1];
    if (!onEvent) throw new Error('Expected cowork route');
    const queueService = getChatQueueService();
    const onTurnRevived = jest
      .spyOn(queueService, 'onTurnRevived')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    mockedSendToWindowDetailed.mockClear();

    void onEvent({
      type: 'canopy_input_delivery',
      provider: 'claude',
      phase: 'picked-up',
      generation: 'live',
      attemptId: 'stale-attempt',
      startsTurn: true,
      userMessageId: 'stale-selected',
    });
    void onEvent({
      type: 'assistant',
      message: {
        id: 'reply',
        role: 'assistant',
        content: [{ type: 'text', text: 'Original reply' }],
      },
    });
    await call[3]?.drainEventsBeforeRemoval?.();

    expect(onTurnRevived).toHaveBeenCalledWith(
      {
        projectId: 'cowork-default',
        worktreeId: 'steering-entry',
        chatId: 'steering-chat',
      },
      'stale-selected',
    );
    expect(onTurnRevived).toHaveBeenCalledTimes(1);
    expect(mockIngestProviderEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ turnUserMessageId: 'original' }),
    );
    expect(
      mockedSendToWindowDetailed.mock.calls.some(
        ([, channel, payload]) =>
          channel === IPC_CHANNELS.chatEvent &&
          isRecord(payload) &&
          isRecord(payload.data) &&
          payload.data.type === 'canopy_input_delivery' &&
          payload.data.userMessageId === 'stale-selected',
      ),
    ).toBe(false);
  });

  it('retries a cowork turn when the durable prompt exists but was not accepted', async () => {
    mockedGetOrCreateSession.mockReturnValue(makeMockSession());
    mockIngestProviderEvent.mockResolvedValueOnce(false);

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'cowork-default',
      worktreeId: 'entry-duplicate',
      chatId: 'chat-duplicate',
      userMessageId: 'msg-duplicate',
      text: 'Do not run twice',
      providerType: 'claude',
    });

    expect(mockHasMutation).toHaveBeenCalledWith(
      { projectId: 'cowork-default', worktreeId: 'entry-duplicate' },
      'chat-duplicate:msg-duplicate:accepted',
    );
    expect(mockedGetOrCreateSession).toHaveBeenCalledTimes(1);
  });

  it('returns already_accepted for a cowork replay accepted by the provider', async () => {
    mockIngestProviderEvent.mockResolvedValueOnce(false);
    mockHasMutation.mockResolvedValueOnce(true);

    const outcome = await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'cowork-default',
      worktreeId: 'entry-duplicate',
      chatId: 'chat-duplicate',
      userMessageId: 'msg-duplicate',
      text: 'Do not run twice',
      providerType: 'claude',
    });

    expect(outcome).toEqual({ disposition: 'already_accepted' });
    expect(mockedGetOrCreateSession).not.toHaveBeenCalled();
  });

  it('retries a worktree turn when its prompt exists but was not accepted', async () => {
    mockedGetOrCreateSession.mockReturnValue(makeMockSession());
    mockIngestProviderEvent.mockResolvedValueOnce(false);

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      userMessageId: 'watcher-delivery-duplicate',
      text: 'Do not run twice',
      providerType: 'claude',
    });

    expect(mockHasMutation).toHaveBeenCalledWith(
      { projectId: 'proj', worktreeId: 'worktree' },
      'chat:watcher-delivery-duplicate:accepted',
    );
    expect(mockedGetOrCreateSession).toHaveBeenCalledTimes(1);
  });

  it('releases the queue after suppressing an already-accepted replay', async () => {
    mockedGetOrCreateSession.mockReturnValue(makeMockSession());
    mockIngestProviderEvent.mockResolvedValueOnce(false);
    mockHasMutation.mockResolvedValueOnce(true);

    const handler = getHandler(IPC_CHANNELS.chatSendMessage);
    await handler(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      userMessageId: 'watcher-delivery-accepted',
      text: 'Already accepted',
      providerType: 'claude',
    });
    await handler(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      userMessageId: 'next-message',
      text: 'Continue after the replay',
      providerType: 'claude',
    });

    expect(mockedGetOrCreateSession).toHaveBeenCalledTimes(1);
  });

  it('returns an already-accepted replay before it enters the host queue', async () => {
    mockHasMutation.mockResolvedValueOnce(true);

    const outcome = await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      userMessageId: 'watcher-delivery-accepted-before-queue',
      text: 'Already accepted',
      providerType: 'claude',
    });

    expect(outcome).toEqual({ disposition: 'already_accepted' });
    expect(mockIngestProviderEvent).not.toHaveBeenCalled();
    expect(mockedGetOrCreateSession).not.toHaveBeenCalled();
  });

  it('deduplicates a replay using the stable worktree prompt identity', async () => {
    mockedGetOrCreateSession.mockReturnValue(makeMockSession());
    const mutationIds = new Set<string>();
    mockIngestProviderEvent.mockImplementation((input) => {
      if (!input.mutationId || mutationIds.has(input.mutationId)) {
        return Promise.resolve(false);
      }
      mutationIds.add(input.mutationId);
      return Promise.resolve(true);
    });
    mockHasMutation.mockImplementation((_scope, mutationId) =>
      Promise.resolve(mutationIds.has(mutationId)),
    );
    const request = {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      userMessageId: 'watcher-delivery-stable',
      text: 'Run exactly once',
      providerType: 'claude' as const,
    };

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, request);
    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, request);

    expect(mockIngestProviderEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        mutationId: 'chat:watcher-delivery-stable:user-prompt',
      }),
    );
    expect(mockedGetOrCreateSession).toHaveBeenCalledTimes(1);
  });

  afterEach(() => {
    getChatQueueService().resetForTests();
    backgroundHelperQueueTestExports.reset();
  });

  it('routes App Advisor messages for real Work Entry ids', async () => {
    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'entry-app-advisor',
      chatId: 'app-advisor-chat',
      userMessageId: 'msg-1',
      text: 'Help me use the app',
      assistantMode: 'app-advisor',
    });

    expect(mockDispatchAppAdvisorChatMessage).toHaveBeenCalledTimes(1);
    expect(ensureAppAdvisorWindowMock).toHaveBeenCalledTimes(1);
    expect(openAppAdvisorWindowMock).not.toHaveBeenCalled();
    const dispatchOptions =
      mockDispatchAppAdvisorChatMessage.mock.calls[0]?.[1];
    if (!isRecord(dispatchOptions) || !isRecord(dispatchOptions.toolSurfaces)) {
      throw new Error('Expected App Advisor dispatch options');
    }
    expect(typeof dispatchOptions.getMainWindow).toBe('function');
    expect(typeof dispatchOptions.getAppAdvisorWindow).toBe('function');
    expect(dispatchOptions.toolSurfaces.openAppAdvisorWindow).toBe(
      openAppAdvisorWindowMock,
    );
    expect(dispatchOptions.toolSurfaces.ensureAppAdvisorWindow).toBe(
      ensureAppAdvisorWindowMock,
    );
    expect(mockedResolveWorktreeCwd).not.toHaveBeenCalled();
  });

  it('holds App Advisor sends inside the Work Entry deletion activity fence', async () => {
    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'entry-app-advisor',
      chatId: 'app-advisor-chat',
      userMessageId: 'msg-fenced',
      text: 'Do not race deletion',
      assistantMode: 'app-advisor',
    });

    expect(mockRunWithScopeActivity).toHaveBeenCalledWith(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-app-advisor',
      },
      expect.any(Function),
    );
    expect(mockDispatchAppAdvisorChatMessage).toHaveBeenCalledTimes(1);
  });

  it('holds ordinary worktree sends inside the deletion activity fence', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);
    const send = getHandler(IPC_CHANNELS.chatSendMessage);

    await send(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      userMessageId: 'msg-active',
      text: 'Keep the turn active',
    });
    mockRunWithScopeActivity.mockClear();

    await send(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      userMessageId: 'msg-worktree-fenced',
      text: 'Do not queue after deletion starts',
    });

    expect(mockRunWithScopeActivity).toHaveBeenCalledWith(
      { projectId: 'proj', worktreeId: 'worktree' },
      expect.any(Function),
    );
    expect(
      getChatQueueService().getWorktreeSnapshots('proj', 'worktree')[0]?.queue,
    ).toHaveLength(1);
  });

  it('clamps and registers App Advisor approval mode before dispatch', async () => {
    setLiveApprovalMode(
      APP_ADVISOR_PROJECT_ID,
      'entry-app-advisor',
      'app-advisor-chat',
      'ask',
    );
    try {
      await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-app-advisor',
        chatId: 'app-advisor-chat',
        userMessageId: 'msg-1',
        text: 'Continue safely',
        approvalMode: 'full-access',
      });

      expect(mockDispatchAppAdvisorChatMessage).toHaveBeenCalledWith(
        expect.objectContaining({ approvalMode: 'ask' }),
        expect.any(Object),
      );
      expect(
        getLiveApprovalMode(
          APP_ADVISOR_PROJECT_ID,
          'entry-app-advisor',
          'app-advisor-chat',
        ),
      ).toBe('ask');
    } finally {
      clearLiveApprovalMode(
        APP_ADVISOR_PROJECT_ID,
        'entry-app-advisor',
        'app-advisor-chat',
      );
    }
  });

  it('routes App Advisor entry messages before considering pipeline-editor assistantMode', async () => {
    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'entry-app-advisor',
      chatId: 'app-advisor-chat',
      userMessageId: 'msg-1',
      text: 'Help me use the app',
      assistantMode: 'pipeline-editor',
    });

    expect(mockDispatchAppAdvisorChatMessage).toHaveBeenCalledTimes(1);
    expect(mockDispatchPipelineEditorChatMessage).not.toHaveBeenCalled();
    expect(ensureAppAdvisorWindowMock).toHaveBeenCalledTimes(1);
    expect(mockedResolveWorktreeCwd).not.toHaveBeenCalled();
  });

  it('rejects app-advisor assistant mode for a foreign project', async () => {
    await expect(
      getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
        projectId: 'foreign-project',
        worktreeId: APP_ADVISOR_WORKTREE_ID,
        chatId: 'app-advisor-chat',
        userMessageId: 'msg-1',
        text: 'Help me use the app',
        assistantMode: 'app-advisor',
      }),
    ).rejects.toThrow('Invalid App Advisor chat target');

    expect(mockDispatchAppAdvisorChatMessage).not.toHaveBeenCalled();
    expect(mockedResolveWorktreeCwd).not.toHaveBeenCalled();
  });

  it('keeps usage-limited registry entries when validation rejects a send', async () => {
    mockedValidateId.mockImplementationOnce(() => undefined);
    mockedValidateId.mockImplementationOnce(() => {
      throw new Error('Invalid worktreeId');
    });

    await expect(
      getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
        projectId: 'proj',
        worktreeId: '../bad',
        chatId: 'chat',
        userMessageId: 'msg-1',
        text: 'Continue',
      }),
    ).rejects.toThrow('Invalid worktreeId');

    expect(mockedClearUsageLimitedChat).not.toHaveBeenCalled();
  });

  it('routes Pipeline Editor sentinel messages without colliding with App Advisor', async () => {
    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: PIPELINE_EDITOR_PROJECT_ID,
      worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
      chatId: 'pipeline-editor-chat',
      userMessageId: 'msg-1',
      text: 'Create a test pipeline',
    });

    expect(mockDispatchPipelineEditorChatMessage).toHaveBeenCalledTimes(1);
    expect(mockedCancelTransientRetryForChat).toHaveBeenCalledWith(
      {
        projectId: PIPELINE_EDITOR_PROJECT_ID,
        worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
        chatId: 'pipeline-editor-chat',
      },
      'manual-send',
    );
    expect(
      mockedCancelTransientRetryForChat.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mockDispatchPipelineEditorChatMessage.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mockDispatchAppAdvisorChatMessage).not.toHaveBeenCalled();
    expect(ensureAppAdvisorWindowMock).not.toHaveBeenCalled();
    expect(mockedResolveWorktreeCwd).not.toHaveBeenCalled();

    const dispatchOptions =
      mockDispatchPipelineEditorChatMessage.mock.calls[0]?.[1];
    if (!isRecord(dispatchOptions) || !isRecord(dispatchOptions.toolSurfaces)) {
      throw new Error('Expected Pipeline Editor dispatch options');
    }
    expect(typeof dispatchOptions.getMainWindow).toBe('function');
    expect(typeof dispatchOptions.toolSurfaces.getMainWindow).toBe('function');

    jest.clearAllMocks();
    registerChatHandlers(makeWindowAccessors());

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: APP_ADVISOR_WORKTREE_ID,
      chatId: 'app-advisor-chat',
      userMessageId: 'msg-2',
      text: 'Help me use the app',
    });

    expect(mockDispatchAppAdvisorChatMessage).toHaveBeenCalledTimes(1);
    expect(mockDispatchPipelineEditorChatMessage).not.toHaveBeenCalled();
    expect(ensureAppAdvisorWindowMock).toHaveBeenCalledTimes(1);
  });

  it('clamps and registers Pipeline Editor approval mode before dispatch', async () => {
    setLiveApprovalMode(
      PIPELINE_EDITOR_PROJECT_ID,
      PIPELINE_EDITOR_WORKTREE_ID,
      'pipeline-editor-chat',
      'ask',
    );
    try {
      await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
        projectId: PIPELINE_EDITOR_PROJECT_ID,
        worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
        chatId: 'pipeline-editor-chat',
        userMessageId: 'msg-1',
        text: 'Continue safely',
        approvalMode: 'full-access',
      });

      expect(mockDispatchPipelineEditorChatMessage).toHaveBeenCalledWith(
        expect.objectContaining({ approvalMode: 'ask' }),
        expect.any(Object),
      );
      expect(
        getLiveApprovalMode(
          PIPELINE_EDITOR_PROJECT_ID,
          PIPELINE_EDITOR_WORKTREE_ID,
          'pipeline-editor-chat',
        ),
      ).toBe('ask');
    } finally {
      clearLiveApprovalMode(
        PIPELINE_EDITOR_PROJECT_ID,
        PIPELINE_EDITOR_WORKTREE_ID,
        'pipeline-editor-chat',
      );
    }
  });

  it('keeps Pipeline Editor pair validation without suppressing App Advisor entries', async () => {
    await expect(
      getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
        projectId: PIPELINE_EDITOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_WORKTREE_ID,
        chatId: 'pipeline-editor-chat',
        userMessageId: 'msg-1',
        text: 'Create a test pipeline',
      }),
    ).rejects.toThrow('Invalid pipeline-editor chat target');

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
      chatId: 'pipeline-editor-chat',
      userMessageId: 'msg-2',
      text: 'Create a test pipeline',
    });

    expect(mockDispatchPipelineEditorChatMessage).not.toHaveBeenCalled();
    expect(mockDispatchAppAdvisorChatMessage).toHaveBeenCalledTimes(1);
    expect(ensureAppAdvisorWindowMock).toHaveBeenCalledTimes(1);
    expect(mockedResolveWorktreeCwd).not.toHaveBeenCalled();
  });

  it('notifies watcher service once for standalone chat terminal events', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: STANDALONE_CHAT_PROJECT_ID,
      worktreeId: 'standalone-project',
      chatId: 'standalone-chat',
      userMessageId: 'msg-1',
      text: 'Do the work',
    });

    const onEvent = mockedGetOrCreateSession.mock.calls[0]?.[1];
    if (!onEvent) {
      throw new Error('Expected standalone chat session event handler');
    }

    void onEvent({ type: 'assistant_delta', content: 'Working' });
    void onEvent({ type: 'result', is_error: false, result: 'Done' });
    await flushPromises();

    expect(mockHandleChatTerminalEvent).toHaveBeenCalledTimes(1);
    expect(mockHandleChatTerminalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'terminal',
        address: {
          projectId: STANDALONE_CHAT_PROJECT_ID,
          taskId: 'standalone-project',
          chatId: 'standalone-chat',
        },
        sourceInputId: 'msg-1',
        disposition: 'completed',
      }),
    );
  });

  it('notifies standalone watchers only for root Codex errors', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: STANDALONE_CHAT_PROJECT_ID,
      worktreeId: 'standalone-project',
      chatId: 'standalone-chat',
      userMessageId: 'msg-root-error',
      text: 'Do the work',
      providerType: 'codex',
      model: 'gpt-5.5',
      sdkSessionId: 'thread-root',
    });

    const onEvent = mockedGetOrCreateSession.mock.calls[0]?.[1];
    if (!onEvent) {
      throw new Error('Expected standalone chat session event handler');
    }
    void onEvent({
      type: 'codex',
      event: { type: 'error', thread_id: 'thread-child' },
    });
    await flushPromises();
    expect(mockHandleChatTerminalEvent).not.toHaveBeenCalled();

    void onEvent({
      type: 'codex',
      event: { type: 'error', thread_id: 'thread-root' },
    });
    await flushPromises();
    expect(mockHandleChatTerminalEvent).toHaveBeenCalledTimes(1);
    expect(mockHandleChatTerminalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'terminal',
        disposition: 'error',
      }),
    );
  });

  // -------------------------------------------------------------------------
  // CAN-1814 PR 7. A send refused by the auth preflight has to reach the
  // renderer as DATA, not as a rejected string.
  //
  // The preflight already knows exactly which dependencies are broken and how
  // each is recovered. Rejecting drops all of that at the IPC boundary, so the
  // user gets a dead-end sentence while `AuthRecoveryCard` -- which renders
  // that exact shape with a working reconnect button -- ships unused.
  // -------------------------------------------------------------------------
  it('returns the blocked dependencies instead of rejecting with a bare string', async () => {
    mockAssertTurnAuthDependencies.mockRejectedValueOnce(
      new TurnAuthPreflightBlockedError([
        PROD_MCP_BLOCKER,
        STAGING_MCP_BLOCKER,
      ]),
    );

    const result = await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      userMessageId: 'msg-1',
      text: 'Look up the record',
    });

    expect(result).toEqual({
      refusedAuthDependencies: {
        message: expect.stringContaining('Prod MCP server') as unknown,
        failures: [PROD_MCP_BLOCKER, STAGING_MCP_BLOCKER],
      },
    });
  });

  it('persists nothing durable when the preflight refuses the send', async () => {
    mockAssertTurnAuthDependencies.mockRejectedValueOnce(
      new TurnAuthPreflightBlockedError([PROD_MCP_BLOCKER]),
    );

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      userMessageId: 'msg-1',
      text: 'Look up the record',
    });

    expect(mockEnsureChatForTrustedSend).not.toHaveBeenCalled();
    expect(mockIngestProviderEvent).not.toHaveBeenCalled();
    expect(mockedGetOrCreateSession).not.toHaveBeenCalled();
    // The send never ran, so the chat is still usage-limited if it was.
    expect(mockedClearUsageLimitedChat).not.toHaveBeenCalled();
  });

  it('still rejects when the send fails for an unrelated reason', async () => {
    mockAssertTurnAuthDependencies.mockRejectedValueOnce(
      new Error('preflight exploded'),
    );

    await expect(
      getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
        projectId: 'proj',
        worktreeId: 'worktree',
        chatId: 'chat',
        userMessageId: 'msg-1',
        text: 'Look up the record',
      }),
    ).rejects.toThrow('preflight exploded');
  });

  it('reports no refusal for a send the preflight allows', async () => {
    mockedGetOrCreateSession.mockReturnValue(makeMockSession());

    const result = await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      userMessageId: 'msg-1',
      text: 'Look up the record',
    });

    expect(result).toEqual({ disposition: 'dispatched' });
  });

  it('notifies watcher service once for worktree chat terminal events after completing the audit turn', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      userMessageId: 'msg-1',
      text: 'Do the work',
    });

    const onEvent = mockedGetOrCreateSession.mock.calls[0]?.[1];
    if (!onEvent) {
      throw new Error('Expected worktree chat session event handler');
    }

    void onEvent({ type: 'assistant_delta', content: 'Working' });
    void onEvent({ type: 'result', is_error: false, result: 'Done' });
    await flushPromises();

    expect(completeChatTurnMock).toHaveBeenCalledWith(
      'proj',
      'worktree',
      'chat',
      'success',
      undefined,
    );
    expect(mockHandleChatTerminalEvent).toHaveBeenCalledTimes(1);
    expect(mockHandleChatTerminalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'terminal',
        address: { projectId: 'proj', taskId: 'worktree', chatId: 'chat' },
        disposition: 'completed',
      }),
    );
    const completeOrder = completeChatTurnMock.mock.invocationCallOrder[0];
    const watcherOrder =
      mockHandleChatTerminalEvent.mock.invocationCallOrder[0];
    expect(completeOrder).toBeLessThan(watcherOrder);
  });

  it('delivers host-queued worktree events to the registered main window', async () => {
    const mainWindow = new BrowserWindow();
    registerChatHandlers(makeWindowAccessors(() => mainWindow));
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'forked-chat',
      userMessageId: 'msg-1',
      text: 'Continue in the fork',
    });

    const onEvent = mockedGetOrCreateSession.mock.calls[0]?.[1];
    if (!onEvent) {
      throw new Error('Expected worktree chat session event handler');
    }
    void onEvent({
      type: 'assistant',
      canopy_turn_user_message_id: 'msg-1',
      message: { role: 'assistant', content: [] },
    });
    await flushPromises();

    expect(mockedSendToWindowDetailed).toHaveBeenCalledWith(
      mainWindow,
      IPC_CHANNELS.chatEvent,
      expect.objectContaining({
        projectId: 'proj',
        worktreeId: 'worktree',
        chatId: 'forked-chat',
      }),
    );
  });

  it('keeps queued Interrupt usable before Claude advertises its extended receipts', async () => {
    const session = makeMockSession();
    const cancel = jest.fn(() => Promise.resolve());
    session.cancel = cancel;
    session.getSteeringCapabilities = () => ({
      provider: 'claude',
      generation: 'initializing',
      steer: false,
      withdraw: false,
      interrupt: false,
    });
    session.hasPendingSteeringInput = () => false;
    session.interruptWithPendingSweep = jest.fn(() =>
      Promise.reject(new Error('Safe interruption is unavailable')),
    );
    mockedGetSession.mockReturnValue(session);
    mockedGetSessionProviderType.mockReturnValue('claude');
    const { interruptChatTurnForQueuedMessage } =
      await import('../lib/chat-turn-cancel');
    const target = {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
    };
    await interruptChatTurnForQueuedMessage(target);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(markSessionForNextTurnRecreation).toHaveBeenCalledWith(
      'proj',
      'worktree',
      'chat',
    );
  });

  it('settles the interrupted turn before dispatching a forced queued prompt', async () => {
    const mainWindow = new BrowserWindow();
    registerChatHandlers(makeWindowAccessors(() => mainWindow));
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);
    mockedGetSession.mockReturnValue(session);
    mockedGetSessionProviderType.mockReturnValue('codex');
    const target = {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
    };

    const send = getHandler(IPC_CHANNELS.chatSendMessage);
    await send(undefined, {
      ...target,
      userMessageId: 'msg-old',
      text: 'Old turn',
      providerType: 'codex',
    });
    await send(undefined, {
      ...target,
      userMessageId: 'msg-new',
      text: 'Queued follow-up',
      providerType: 'codex',
    });

    const queuedEntry = getChatQueueService().getWorktreeSnapshots(
      'proj',
      'worktree',
    )[0]?.queue[0];
    if (!queuedEntry) {
      throw new Error('Expected the follow-up to be queued');
    }

    mockedSendToWindow.mockClear();
    await getHandler(IPC_CHANNELS.chatQueueForce)(undefined, {
      ...target,
      entryId: queuedEntry.id,
    });

    const chatEvents = mockedSendToWindow.mock.calls.filter(
      ([, channel]) => channel === IPC_CHANNELS.chatEvent,
    );
    const cancelledIndex = chatEvents.findIndex(
      ([, , payload]) =>
        isRecord(payload) &&
        isRecord(payload.data) &&
        payload.data.result === 'Cancelled',
    );
    const followUpIndex = chatEvents.findIndex(
      ([, , payload]) =>
        isRecord(payload) &&
        isRecord(payload.data) &&
        payload.data.original_text === 'Queued follow-up',
    );

    expect(cancelledIndex).toBeGreaterThanOrEqual(0);
    expect(followUpIndex).toBeGreaterThan(cancelledIndex);
    expect(chatEvents[cancelledIndex]?.[2]).toEqual({
      ...target,
      data: {
        type: 'result',
        is_error: false,
        result: 'Cancelled',
        canopy_turn_user_message_id: 'msg-old',
      },
    });
  });

  it('applies the exact requested Codex speed to an existing session before sending', async () => {
    const setSpeed = jest.fn().mockResolvedValue(undefined);
    const session = { ...makeMockSession(), setSpeed };
    mockedGetOrCreateSession.mockResolvedValue(session);

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      userMessageId: 'msg-1',
      text: 'Do the work',
      sdkSessionId: 'thread-1',
      providerType: 'codex',
      modelConfig: { speed: 'ultrafast', fastMode: false },
    });

    expect(setSpeed).toHaveBeenCalledWith('ultrafast');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(session.setCodexFastMode).not.toHaveBeenCalled();
  });

  it('synchronizes plan mode onto an existing session before sending a message', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      userMessageId: 'msg-1',
      text: 'PLEASE IMPLEMENT THIS PLAN:\nDo the work',
      planMode: false,
      sdkSessionId: 'thread-1',
      providerType: 'codex',
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(session.setPlanMode).toHaveBeenCalledWith(false);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(session.setCodexAppServerIdleTimeoutMinutes).toHaveBeenCalledWith(
      10,
    );
    expect(mockedGetOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        codexAppServerIdleTimeoutMinutes: 10,
      }),
      expect.any(Function),
      expect.any(Function),
      expect.anything(),
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(session.sendMessage).toHaveBeenCalledWith(
      'PLEASE IMPLEMENT THIS PLAN:\nDo the work',
      { userMessageId: 'msg-1', countsTowardSkillUsage: true },
    );

    // eslint-disable-next-line @typescript-eslint/unbound-method
    const planModeOrder = jest.mocked(session.setPlanMode).mock
      .invocationCallOrder[0];
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const sendOrder = jest.mocked(session.sendMessage).mock
      .invocationCallOrder[0];
    expect(planModeOrder).toBeLessThan(sendOrder);
  });

  it('passes worktree Codex multi-agent preference into Codex worktree sessions', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);
    mockedReadPreferencesFile.mockResolvedValue(
      makePreferences({ codexMultiAgentWorktreeChatsEnabled: false }),
    );

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      userMessageId: 'msg-multi-agent-worktree',
      text: 'Run the task',
      providerType: 'codex',
      sdkSessionId: 'thread-1',
    });

    expect(mockedGetOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ codexMultiAgentEnabled: false }),
      expect.any(Function),
      expect.any(Function),
      expect.anything(),
    );
  });

  it('passes the Codex subagent concurrency preference into cowork sessions', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);
    mockedReadPreferencesFile.mockResolvedValue(
      makePreferences({ codexMaxConcurrentSubagents: 3 }),
    );

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'cowork-default',
      worktreeId: 'home',
      chatId: 'chat-concurrency',
      userMessageId: 'msg-concurrency',
      text: 'Run the task',
      providerType: 'codex',
    });

    expect(mockedGetOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ codexMaxConcurrentSubagents: 3 }),
      expect.any(Function),
      expect.any(Function),
      expect.anything(),
    );
  });

  it('passes enabled Claude RTK through worktree chat turns before sendMessage', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);
    mockedReadPreferencesFile.mockResolvedValue(
      makePreferences({ rtkEnabled: true }),
    );

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      userMessageId: 'msg-rtk-worktree',
      text: 'Run the task',
      providerType: 'claude',
      sdkSessionId: 'thread-1',
    });

    expect(mockedGetOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ rtkEnabled: true }),
      expect.any(Function),
      expect.any(Function),
      expect.anything(),
    );
    if (!session.setRtkEnabled) {
      throw new Error('Expected setRtkEnabled');
    }
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(session.setRtkEnabled).toHaveBeenCalledWith(true);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const rtkOrder = jest.mocked(session.setRtkEnabled).mock
      .invocationCallOrder[0];
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const sendOrder = jest.mocked(session.sendMessage).mock
      .invocationCallOrder[0];
    if (rtkOrder === undefined || sendOrder === undefined) {
      throw new Error('Expected RTK and sendMessage call order');
    }
    expect(rtkOrder).toBeLessThan(sendOrder);
  });

  it('passes disabled Claude RTK through worktree chat turns before sendMessage', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);
    mockedReadPreferencesFile.mockResolvedValue(
      makePreferences({ rtkEnabled: false }),
    );

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      userMessageId: 'msg-rtk-worktree-off',
      text: 'Run the task',
      providerType: 'claude',
      sdkSessionId: 'thread-1',
    });

    expect(mockedGetOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ rtkEnabled: false }),
      expect.any(Function),
      expect.any(Function),
      expect.anything(),
    );
    if (!session.setRtkEnabled) {
      throw new Error('Expected setRtkEnabled');
    }
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(session.setRtkEnabled).toHaveBeenCalledWith(false);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const rtkOrder = jest.mocked(session.setRtkEnabled).mock
      .invocationCallOrder[0];
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const sendOrder = jest.mocked(session.sendMessage).mock
      .invocationCallOrder[0];
    if (rtkOrder === undefined || sendOrder === undefined) {
      throw new Error('Expected RTK and sendMessage call order');
    }
    expect(rtkOrder).toBeLessThan(sendOrder);
  });

  it.each(['starting', 'cleaning_up'] as const)(
    'rejects native Claude send while Claude Code terminal is %s',
    async (turnState) => {
      const session = makeMockSession();
      mockedGetOrCreateSession.mockReturnValue(session);
      mockClaudeTerminalGetState.mockReturnValue({ turnState });

      await expect(
        getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
          projectId: 'proj',
          worktreeId: 'worktree',
          chatId: 'chat',
          userMessageId: 'msg-terminal-busy',
          text: 'Run the task',
          providerType: 'claude',
          sdkSessionId: 'thread-1',
        }),
      ).rejects.toThrow(
        'Claude Code terminal mode is currently active. Wait for it to finish before sending from Canopy.',
      );

      expect(mockClaudeTerminalCleanup).not.toHaveBeenCalled();
      expect(mockedGetOrCreateSession).not.toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(session.sendMessage).not.toHaveBeenCalled();
    },
  );

  it('cleans up inactive Claude Code terminal state before native Claude send', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);
    mockClaudeTerminalGetState.mockReturnValue({ turnState: 'idle' });

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      userMessageId: 'msg-terminal-idle',
      text: 'Run the task',
      providerType: 'claude',
      sdkSessionId: 'thread-1',
    });

    expect(mockClaudeTerminalCleanup).toHaveBeenCalledWith({
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      reason: 'switch-to-native-send',
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(session.sendMessage).toHaveBeenCalledWith('Run the task', {
      userMessageId: 'msg-terminal-idle',
      countsTowardSkillUsage: true,
    });
  });

  it('rejects direct Cursor sends while rollout is off before creating a session', async () => {
    mockCursorFlagEnabled.mockReturnValue(false);
    try {
      await expect(
        getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
          projectId: 'proj',
          worktreeId: 'worktree',
          chatId: 'chat',
          userMessageId: 'cursor-gated',
          text: 'Run the task',
          providerType: 'cursor',
          model: 'cursor-default',
        }),
      ).rejects.toThrow(
        'This Cursor model is unavailable. Choose another Cursor model and try again.',
      );
      expect(mockedGetOrCreateSession).not.toHaveBeenCalled();
    } finally {
      mockCursorFlagEnabled.mockReturnValue(true);
    }
  });

  it.each([true, false])(
    'forwards the RTK preference %s to Cursor worktree chat turns',
    async (rtkEnabled) => {
      const session = makeMockSession();
      mockedGetOrCreateSession.mockReturnValue(session);
      mockedReadPreferencesFile.mockResolvedValue(
        makePreferences({ rtkEnabled }),
      );

      await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
        projectId: 'proj',
        worktreeId: 'worktree',
        chatId: 'chat',
        userMessageId: `msg-rtk-cursor-${rtkEnabled}`,
        text: 'Run the task',
        providerType: 'cursor',
        model: 'cursor-default',
      });

      expect(mockedGetOrCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({ rtkEnabled }),
        expect.any(Function),
        expect.any(Function),
        expect.anything(),
      );
      if (!session.setRtkEnabled) {
        throw new Error('Expected setRtkEnabled');
      }
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(session.setRtkEnabled).toHaveBeenCalledWith(rtkEnabled);
    },
  );

  it('does not enable RTK for Codex worktree chat turns even if the preference is true', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);
    mockedReadPreferencesFile.mockResolvedValue(
      makePreferences({ rtkEnabled: true }),
    );

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      userMessageId: 'msg-rtk-codex',
      text: 'Run the task',
      providerType: 'codex',
      sdkSessionId: 'thread-1',
    });

    expect(mockedGetOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ rtkEnabled: false }),
      expect.any(Function),
      expect.any(Function),
      expect.anything(),
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(session.setRtkEnabled).not.toHaveBeenCalled();
  });

  it('triggers background branch naming on the first message without mutating the prompt', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);
    mockedDoesBranchMatchWorktreeId.mockResolvedValue({ matches: true });
    mockedIsBranchPromptSent.mockResolvedValue(false);

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      userMessageId: 'msg-2',
      text: 'Add user authentication with OAuth2',
      sdkSessionId: undefined,
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method
    const sendMessageMock = jest.mocked(session.sendMessage);
    expect(sendMessageMock).toHaveBeenCalledWith(
      'Add user authentication with OAuth2',
      { userMessageId: 'msg-2', countsTowardSkillUsage: true },
    );

    await flushPromises();
    await flushPromises();

    expect(mockedRecordWorktreeDiscovery).toHaveBeenCalledWith({
      kind: 'branch-prompt',
      workspaceId: 'proj',
      worktreeId: 'worktree',
      sent: true,
    });
    expect(mockedGenerateAndRenameBranch).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj',
        worktreeId: 'worktree',
        cwd: '/tmp/repo',
        userMessage: 'Add user authentication with OAuth2',
        branchResult: { matches: true },
      }),
    );
    const firstBranchCall = mockedGenerateAndRenameBranch.mock.calls[0]?.[0];
    expect(typeof firstBranchCall?.observabilityTaskKey).toBe('string');
    expect(
      firstBranchCall?.observabilityTaskKey?.startsWith(
        'helper:branch-naming:',
      ),
    ).toBe(true);
  });

  it('validates selectedRepoId at the IPC boundary before resolving cwd', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      userMessageId: 'msg-selected-repo',
      text: 'Run from the repo-scoped directory',
      sdkSessionId: 'thread-1',
      selectedRepoId: 'frontend',
    });

    expect(mockedValidateOptionalRepoId).toHaveBeenCalledWith(
      'frontend',
      'selectedRepoId',
    );
    expect(mockedResolveWorktreeCwd).toHaveBeenCalledWith(
      'proj',
      'worktree',
      'frontend',
    );
  });

  it('records undelivered chat-event diagnostics without hardcoding claude', async () => {
    const consoleWarnSpy = jest
      .spyOn(console, 'warn')
      .mockImplementation((): void => undefined);
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);
    mockedGetActiveSessionInfos.mockReturnValue([]);
    mockedSendToWindowDetailed
      .mockReturnValueOnce({ delivered: true })
      .mockReturnValueOnce({
        delivered: false,
        reason: 'no_window',
      })
      .mockReturnValueOnce({
        delivered: false,
        reason: 'window_destroyed',
      });

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      userMessageId: 'msg-undelivered',
      text: 'Do the work',
      sdkSessionId: 'thread-1',
    });

    const onEvent = mockedGetOrCreateSession.mock.calls[0]?.[1];
    if (!onEvent) {
      throw new Error('Expected chat session event handler');
    }

    void onEvent({
      type: 'assistant',
      message: { role: 'assistant', content: [] },
      providerType: 'codex',
    });
    void onEvent({
      type: 'result',
      is_error: false,
      result: 'Done again',
    });
    await flushPromises();
    await flushPromises();

    expect(recordSessionDiagnosticMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        kind: 'chat_event_undelivered',
        providerType: 'codex',
        sendFailureReason: 'no_window',
      }),
    );
    expect(recordSessionDiagnosticMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        kind: 'chat_event_undelivered',
        providerType: 'claude',
        sendFailureReason: 'window_destroyed',
      }),
    );
    consoleWarnSpy.mockRestore();
  });

  it('falls back to persisted chat metadata for undelivered synthetic events', async () => {
    mockedSendToWindowDetailed.mockReturnValue({
      delivered: false,
      reason: 'no_window',
    });
    mockedReadPersistedChatDispatchMetadata.mockResolvedValue({
      providerType: 'codex',
      model: 'gpt-5.5',
    });

    await getHandler(IPC_CHANNELS.chatCancel)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
    });
    await flushPromises();

    expect(mockedReadPersistedChatDispatchMetadata).toHaveBeenCalledWith(
      'proj',
      'worktree',
      'chat',
    );
    expect(recordSessionDiagnosticMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'chat_event_undelivered',
        providerType: 'codex',
        model: 'gpt-5.5',
        sendFailureReason: 'no_window',
      }),
    );
  });

  it('retries background branch naming when the legacy flag is set but the branch still matches the worktree id', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);
    mockedDoesBranchMatchWorktreeId.mockResolvedValue({
      matches: true,
      matchingRepos: ['repo-a'],
    });
    mockedIsBranchPromptSent.mockResolvedValue(true);

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      userMessageId: 'msg-3',
      text: 'Implement API pagination',
      sdkSessionId: undefined,
    });

    await flushPromises();

    expect(mockedRecordWorktreeDiscovery).not.toHaveBeenCalled();
    expect(mockedGenerateAndRenameBranch).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj',
        worktreeId: 'worktree',
        cwd: '/tmp/repo',
        userMessage: 'Implement API pagination',
        branchResult: { matches: true, matchingRepos: ['repo-a'] },
      }),
    );
    const secondBranchCall = mockedGenerateAndRenameBranch.mock.calls[0]?.[0];
    expect(typeof secondBranchCall?.observabilityTaskKey).toBe('string');
    expect(
      secondBranchCall?.observabilityTaskKey?.startsWith(
        'helper:branch-naming:',
      ),
    ).toBe(true);
  });

  it('clears the legacy branch naming flag when background naming fails', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);
    mockedDoesBranchMatchWorktreeId.mockResolvedValue({ matches: true });
    mockedIsBranchPromptSent.mockResolvedValue(false);
    mockedGenerateAndRenameBranch.mockRejectedValue(new Error('rename failed'));

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      userMessageId: 'msg-4',
      text: 'Fix flaky CI tests',
      sdkSessionId: undefined,
    });

    await flushPromises();
    await flushPromises();

    expect(mockedRecordWorktreeDiscovery).toHaveBeenCalledWith({
      kind: 'branch-prompt',
      workspaceId: 'proj',
      worktreeId: 'worktree',
      sent: false,
    });
  });

  it('records branch naming with the configured Codex provider', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);
    mockedDoesBranchMatchWorktreeId.mockResolvedValue({ matches: true });
    mockedIsBranchPromptSent.mockResolvedValue(true);
    mockedReadPreferencesFile.mockResolvedValue(
      makePreferences({
        branchNamingModel: 'gpt-5.5',
        providerModelConfigDefaults: { codex: { fastMode: true } },
      }),
    );

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      text: 'Implement API pagination',
      sdkSessionId: undefined,
    });

    await flushPromises();

    expect(startObservedTaskMock).toHaveBeenCalledWith(
      expect.stringContaining('helper:branch-naming:'),
      expect.objectContaining({
        eventType: 'branch_naming',
        provider: 'codex',
        model: 'gpt-5.5',
        serviceTier: 'priority',
      }),
    );
    expect(mockedGenerateAndRenameBranch).toHaveBeenCalledWith(
      expect.objectContaining({
        modelConfig: { speed: 'fast', fastMode: true, thinkingLevel: 'off' },
      }),
    );
  });

  it('injects attachment system instructions into worktree messages sent to agents', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);
    const attachmentDir = getWorktreeAttachmentsDir('proj', 'worktree');
    const firstAttachment = `${attachmentDir}/notes-1.txt`;
    const secondAttachment = `${attachmentDir}/notes-2.txt`;

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      userMessageId: 'msg-attachments',
      text: 'Review these notes and summarize them',
      fileReferences: [
        {
          displayPath: 'docs/spec.md',
          absolutePath: '/tmp/repo/docs/spec.md',
        },
      ],
      attachmentPaths: [firstAttachment, secondAttachment],
      sdkSessionId: 'thread-1',
    });

    const submittedText = [
      '<system_instruction>Review these attachments before responding to the user message:',
      firstAttachment,
      secondAttachment,
      '</system_instruction>',
      '',
      'Referenced files:',
      '- docs/spec.md',
      '',
      'Review these notes and summarize them',
    ].join('\n');

    // eslint-disable-next-line @typescript-eslint/unbound-method
    const sendMessageMock = jest.mocked(session.sendMessage);
    expect(sendMessageMock).toHaveBeenCalledWith(submittedText, {
      userMessageId: 'msg-attachments',
      countsTowardSkillUsage: true,
    });
    expect(startChatTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj',
        worktreeId: 'worktree',
        chatId: 'chat',
        originalUserText: 'Review these notes and summarize them',
        submittedText,
        fileReferences: [
          {
            displayPath: 'docs/spec.md',
            absolutePath: '/tmp/repo/docs/spec.md',
          },
        ],
        isStandalone: false,
      }),
    );
  });

  it('passes enriched transcript metadata into startChatTurn', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'standalone-chat',
      worktreeId: 'default',
      chatId: 'chat',
      userMessageId: 'msg-transcript',
      text: 'Review the archived notes',
      fileReferences: [
        {
          displayPath: 'notes/todo.md',
          absolutePath: '/tmp/repo/notes/todo.md',
        },
      ],
      planMode: true,
      providerType: 'codex',
      sdkSessionId: undefined,
    });

    expect(startChatTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'standalone-chat',
        worktreeId: 'default',
        chatId: 'chat',
        provider: 'codex',
        originalUserText: 'Review the archived notes',
        submittedText:
          'Referenced files:\n- notes/todo.md\n\nReview the archived notes',
        fileReferences: [
          {
            displayPath: 'notes/todo.md',
            absolutePath: '/tmp/repo/notes/todo.md',
          },
        ],
        planMode: true,
        isStandalone: true,
      }),
    );
    expect(mockedGetOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        codexAppServerIdleTimeoutMinutes: 10,
      }),
      expect.any(Function),
      expect.any(Function),
      expect.anything(),
    );
    expectLatestSessionLifecycleDrain();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(session.setCodexAppServerIdleTimeoutMinutes).toHaveBeenCalledWith(
      10,
    );
    const startArgs = startChatTurnMock.mock.calls[0]?.[0];
    if (!startArgs || typeof startArgs.systemPromptAppend !== 'string') {
      throw new Error('Expected startChatTurn to receive systemPromptAppend');
    }
    expect(startArgs.systemPromptAppend).toContain('cowork project');
    expect(startArgs.systemPromptAppend).toContain('/attachments');
  });

  it('coerces invalid standalone initiationSource to user', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: STANDALONE_CHAT_PROJECT_ID,
      worktreeId: 'default',
      chatId: 'chat',
      userMessageId: 'msg-invalid-source',
      text: 'Review this',
      initiationSource: 'not-a-real-source',
    });

    expect(startChatTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: STANDALONE_CHAT_PROJECT_ID,
        worktreeId: 'default',
        chatId: 'chat',
        isStandalone: true,
        initiationSource: 'user',
      }),
    );
  });

  it('preserves valid standalone initiationSource values', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: STANDALONE_CHAT_PROJECT_ID,
      worktreeId: 'default',
      chatId: 'chat',
      userMessageId: 'msg-automation-source',
      text: 'Review this',
      initiationSource: 'automation',
    });

    expect(startChatTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: STANDALONE_CHAT_PROJECT_ID,
        worktreeId: 'default',
        chatId: 'chat',
        isStandalone: true,
        initiationSource: 'automation',
      }),
    );
  });

  it('passes enabled Claude RTK through standalone chat turns before sendMessage', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);
    mockedReadPreferencesFile.mockResolvedValue(
      makePreferences({ rtkEnabled: true }),
    );

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: STANDALONE_CHAT_PROJECT_ID,
      worktreeId: 'default',
      chatId: 'chat',
      userMessageId: 'msg-standalone-rtk',
      text: 'Standalone work',
      providerType: 'claude',
      sdkSessionId: 'thread-1',
    });

    expect(mockedGetOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ rtkEnabled: true }),
      expect.any(Function),
      expect.any(Function),
      expect.anything(),
    );
    expectLatestSessionLifecycleDrain();
    if (!session.setRtkEnabled) {
      throw new Error('Expected setRtkEnabled');
    }
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(session.setRtkEnabled).toHaveBeenCalledWith(true);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const rtkOrder = jest.mocked(session.setRtkEnabled).mock
      .invocationCallOrder[0];
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const sendOrder = jest.mocked(session.sendMessage).mock
      .invocationCallOrder[0];
    if (rtkOrder === undefined || sendOrder === undefined) {
      throw new Error('Expected RTK and sendMessage call order');
    }
    expect(rtkOrder).toBeLessThan(sendOrder);
  });

  it('forwards rtkEnabled false for standalone Codex chats', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);
    mockedReadPreferencesFile.mockResolvedValue(
      makePreferences({ rtkEnabled: true }),
    );

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: STANDALONE_CHAT_PROJECT_ID,
      worktreeId: 'default',
      chatId: 'chat',
      userMessageId: 'msg-standalone-codex',
      text: 'Standalone work',
      providerType: 'codex',
      sdkSessionId: 'thread-1',
    });

    expect(mockedGetOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ rtkEnabled: false }),
      expect.any(Function),
      expect.any(Function),
      expect.anything(),
    );
    expectLatestSessionLifecycleDrain();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(session.setRtkEnabled).not.toHaveBeenCalled();
  });

  it('passes standalone Codex multi-agent preference into standalone Codex sessions', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);
    mockedReadPreferencesFile.mockResolvedValue(
      makePreferences({ codexMultiAgentStandaloneChatsEnabled: false }),
    );

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: STANDALONE_CHAT_PROJECT_ID,
      worktreeId: 'default',
      chatId: 'chat',
      userMessageId: 'msg-standalone-codex-multi-agent',
      text: 'Standalone work',
      providerType: 'codex',
      sdkSessionId: 'thread-1',
    });

    expect(mockedGetOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ codexMultiAgentEnabled: false }),
      expect.any(Function),
      expect.any(Function),
      expect.anything(),
    );
    expectLatestSessionLifecycleDrain();
  });

  it('destroys standalone sessions flagged for next-turn recreation before sending', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);
    mockedShouldRecreateSessionOnNextTurn.mockReturnValue(true);

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: STANDALONE_CHAT_PROJECT_ID,
      worktreeId: 'default',
      chatId: 'chat',
      userMessageId: 'msg-standalone-recreate',
      text: 'Standalone work',
      providerType: 'codex',
      sdkSessionId: 'thread-1',
    });

    expect(mockedShouldRecreateSessionOnNextTurn).toHaveBeenCalledWith(
      STANDALONE_CHAT_PROJECT_ID,
      'default',
      'chat',
    );
    expect(mockedDestroySession).toHaveBeenCalledWith(
      STANDALONE_CHAT_PROJECT_ID,
      'default',
      'chat',
      { retainDelegations: true },
    );
    const destroyOrder = mockedDestroySession.mock.invocationCallOrder[0];
    const createOrder = mockedGetOrCreateSession.mock.invocationCallOrder[0];
    if (destroyOrder === undefined || createOrder === undefined) {
      throw new Error('Expected destroy and create call order');
    }
    expect(destroyOrder).toBeLessThan(createOrder);
  });

  it('adds multi-repo repository scope instructions to plan-mode worktree prompts', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);
    mockGetWorkspaceType.mockReturnValue('multi-repo');
    mockReadEffectiveWorkspaceConfig.mockResolvedValue({
      sourceRepoPath: '/workspace/source',
      repos: [
        { id: 'api', name: 'API', repoPath: '/workspace/repos/api' },
        { id: 'web', name: 'Web', repoPath: '/workspace/repos/web' },
      ],
    });

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'workspace',
      worktreeId: 'worktree',
      chatId: 'chat',
      userMessageId: 'msg-scope',
      text: 'Plan this cross-repo change',
      planMode: true,
      providerType: 'codex',
      selectedRepoId: 'web',
      sdkSessionId: undefined,
    });

    const sessionOptions = mockedGetOrCreateSession.mock.calls[0]?.[0];
    if (
      !sessionOptions ||
      typeof sessionOptions.systemPromptAppend !== 'string'
    ) {
      throw new Error('Expected session options with systemPromptAppend');
    }

    expect(sessionOptions.systemPromptAppend).toContain(
      'Multi-repo planning scope:',
    );
    expect(sessionOptions.systemPromptAppend).toContain(
      'Current working scope: child repo Web (web).',
    );
    expect(sessionOptions.systemPromptAppend).toContain('- API (api)');
    expect(sessionOptions.systemPromptAppend).toContain('- Web (web)');
    expect(sessionOptions.systemPromptAppend).toContain(
      '"Repository Scope" section',
    );
    expect(sessionOptions.systemPromptAppend).toContain(
      'Which child repos are in scope, by name and id',
    );
    expect(sessionOptions.systemPromptAppend).toContain(
      'which child repos are out of scope by name and id',
    );
    expect(sessionOptions.systemPromptAppend).toContain(
      'all child repos are out of scope',
    );
  });

  it('does not append multi-repo repository scope instructions outside plan mode', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);
    mockGetWorkspaceType.mockReturnValue('multi-repo');

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'workspace',
      worktreeId: 'worktree',
      chatId: 'chat',
      userMessageId: 'msg-non-plan',
      text: 'Continue implementation',
      planMode: false,
      providerType: 'codex',
      selectedRepoId: 'web',
      sdkSessionId: undefined,
    });

    const sessionOptions = mockedGetOrCreateSession.mock.calls[0]?.[0];
    if (
      !sessionOptions ||
      typeof sessionOptions.systemPromptAppend !== 'string'
    ) {
      throw new Error('Expected session options with systemPromptAppend');
    }

    expect(sessionOptions.systemPromptAppend).not.toContain(
      'Multi-repo planning scope:',
    );
    expect(mockReadEffectiveWorkspaceConfig).not.toHaveBeenCalled();
  });

  it('recreates the session on the next turn after a plan-mode transition', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);
    mockedShouldRecreateSessionOnNextTurn.mockReturnValue(true);
    mockGetWorkspaceType.mockReturnValue('multi-repo');
    mockReadEffectiveWorkspaceConfig.mockResolvedValue({
      sourceRepoPath: '/workspace/source',
      repos: [{ id: 'web', name: 'Web', repoPath: '/workspace/repos/web' }],
    });

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'workspace',
      worktreeId: 'worktree',
      chatId: 'chat',
      userMessageId: 'msg-transition',
      text: 'Plan the migration',
      planMode: true,
      providerType: 'codex',
      selectedRepoId: 'web',
      sdkSessionId: 'thread-9',
    });

    expect(mockedDestroySession).toHaveBeenCalledWith(
      'workspace',
      'worktree',
      'chat',
      { retainDelegations: true },
    );
    const sessionOptions = mockedGetOrCreateSession.mock.calls[0]?.[0];
    if (
      !sessionOptions ||
      typeof sessionOptions.systemPromptAppend !== 'string'
    ) {
      throw new Error('Expected session options with systemPromptAppend');
    }
    expect(sessionOptions.sdkSessionId).toBe('thread-9');
    expect(sessionOptions.systemPromptAppend).toContain(
      'Multi-repo planning scope:',
    );

    const destroyOrder = mockedDestroySession.mock.invocationCallOrder[0];
    const createOrder = mockedGetOrCreateSession.mock.invocationCallOrder[0];
    expect(destroyOrder).toBeLessThan(createOrder);
  });

  it('validates and tracks userMessageId for turn diff capture', async () => {
    const session = makeMockSession();
    let sessionEventHandler: ((data: unknown) => void) | undefined;
    mockedGetOrCreateSession.mockImplementation((_opts, onEvent) => {
      sessionEventHandler = onEvent;
      return session;
    });
    mockedCaptureTurnEndAndDiff.mockResolvedValue({
      files: [
        {
          path: 'src/app.ts',
          status: 'modified',
          insertions: 3,
          deletions: 1,
        },
      ],
      totalInsertions: 3,
      totalDeletions: 1,
      capturedAt: 123,
    });

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      userMessageId: 'msg-5',
      text: 'Update the app shell',
      sdkSessionId: 'thread-2',
    });

    expect(mockedValidateId).toHaveBeenCalledWith('msg-5', 'userMessageId');
    expect(mockedCaptureTurnStart).toHaveBeenCalledWith(
      'proj/worktree/chat',
      'proj',
      'worktree',
    );

    if (!sessionEventHandler) {
      throw new Error('Expected session event callback');
    }

    sessionEventHandler({ type: 'result', is_error: false, result: 'done' });
    await flushPromises();
    await flushPromises();
    await flushPromises();

    expect(mockedCaptureTurnEndAndDiff).toHaveBeenCalledWith(
      'proj/worktree/chat',
    );
    expect(mockedSendToWindowDetailed).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.chatEvent,
      expect.objectContaining({
        projectId: 'proj',
        worktreeId: 'worktree',
        chatId: 'chat',
        data: {
          type: 'turn_diff',
          userMessageId: 'msg-5',
          files: [
            {
              path: 'src/app.ts',
              status: 'modified',
              insertions: 3,
              deletions: 1,
            },
          ],
          totalInsertions: 3,
          totalDeletions: 1,
          capturedAt: 123,
        },
      }),
    );
  });

  it('does not let a stale tagged terminal consume the active turn diff id', async () => {
    const firstSession = makeMockSession();
    const secondSession = makeMockSession();
    const sessionEventHandlers: Array<(data: unknown) => void> = [];
    mockedGetOrCreateSession.mockImplementation((_opts, onEvent) => {
      sessionEventHandlers.push(onEvent);
      return sessionEventHandlers.length === 1 ? firstSession : secondSession;
    });
    mockedCaptureTurnEndAndDiff.mockResolvedValue({
      files: [],
      totalInsertions: 0,
      totalDeletions: 0,
      capturedAt: 123,
    });

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      userMessageId: 'msg-old',
      text: 'Old turn',
    });
    // The host queue serializes dispatches per chat, so overlapping turns can
    // only arise when the first turn's gate is released without its session
    // terminal reaching the tagged handler (user Stop / destroyed session).
    // Release the gate the same way the cancel IPC path does, then dispatch
    // the follow-up; the old session's late tagged terminal must still be
    // ignored by the new turn's diff bookkeeping.
    getChatQueueService().onTurnTerminal(
      { projectId: 'proj', worktreeId: 'worktree', chatId: 'chat' },
      'complete',
    );
    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      userMessageId: 'msg-new',
      text: 'Follow-up turn',
    });

    const oldHandler = sessionEventHandlers[0];
    const newHandler = sessionEventHandlers[1];
    if (!oldHandler || !newHandler) {
      throw new Error('Expected both session event callbacks');
    }

    oldHandler({
      type: 'result',
      is_error: false,
      result: 'Session ended',
      canopy_turn_user_message_id: 'msg-old',
    });
    await flushPromises();
    await flushPromises();

    expect(mockedCaptureTurnEndAndDiff).not.toHaveBeenCalled();

    newHandler({
      type: 'result',
      is_error: false,
      result: 'done',
      canopy_turn_user_message_id: 'msg-new',
    });
    await flushPromises();
    await flushPromises();
    await flushPromises();

    expect(mockedCaptureTurnEndAndDiff).toHaveBeenCalledTimes(1);
    expect(mockedCaptureTurnEndAndDiff).toHaveBeenCalledWith(
      'proj/worktree/chat',
    );
    expect(mockedSendToWindowDetailed).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.chatEvent,
      {
        projectId: 'proj',
        worktreeId: 'worktree',
        chatId: 'chat',
        data: {
          type: 'turn_diff',
          userMessageId: 'msg-new',
          files: [],
          totalInsertions: 0,
          totalDeletions: 0,
          capturedAt: 123,
        },
      },
    );
  });

  it('releases the host queue when a reused session emits a later turn terminal', async () => {
    const session = makeMockSession();
    let retainedSessionEventHandler: ((data: unknown) => void) | undefined;
    mockedGetOrCreateSession.mockImplementation((_opts, onEvent) => {
      // A real reusable provider session keeps the callback it received when
      // it was created; later getOrCreateSession calls return that session
      // without installing their newly supplied callback.
      retainedSessionEventHandler ??= onEvent;
      return session;
    });

    const send = getHandler(IPC_CHANNELS.chatSendMessage);
    const target = {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
    };

    await send(undefined, {
      ...target,
      userMessageId: 'msg-first',
      text: 'First turn',
      providerType: 'codex',
    });
    if (!retainedSessionEventHandler) {
      throw new Error('Expected the reusable session event callback');
    }
    retainedSessionEventHandler({
      type: 'result',
      is_error: false,
      result: 'done',
      canopy_turn_user_message_id: 'msg-first',
    });
    await flushPromises();
    await flushPromises();
    expect(getChatQueueService().isTurnActive(target)).toBe(false);

    await send(undefined, {
      ...target,
      userMessageId: 'msg-second',
      text: 'Second turn',
      providerType: 'codex',
    });
    expect(getChatQueueService().isTurnActive(target)).toBe(true);

    // The retained callback closes over the first dispatch options, but its
    // provider event and the active-turn map identify the actual second turn.
    retainedSessionEventHandler({
      type: 'result',
      is_error: false,
      result: 'done',
      canopy_turn_user_message_id: 'msg-second',
    });
    await flushPromises();
    await flushPromises();

    expect(getChatQueueService().isTurnActive(target)).toBe(false);
    expect(mockedGetOrCreateSession).toHaveBeenCalledTimes(2);
  });

  it('does not mark successful turns as cancelled based on free-form text', async () => {
    const session = makeMockSession();
    let onEvent: ((data: unknown) => void) | undefined;
    mockedGetOrCreateSession.mockImplementation(
      (_opts, handler): AgentSession => {
        onEvent = handler;
        return session;
      },
    );

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      text: 'Summarize the incident',
      sdkSessionId: 'thread-1',
    });

    if (!onEvent) {
      throw new Error('Expected chat event handler to be registered');
    }

    void onEvent({
      type: 'result',
      is_error: false,
      result: 'I cancelled the meeting and documented the follow-up steps.',
    });
    await flushPromises();

    expect(completeChatTurnMock).toHaveBeenCalledWith(
      'proj',
      'worktree',
      'chat',
      'success',
      undefined,
    );
  });

  it('still marks known synthetic cancellation results as cancelled', async () => {
    const session = makeMockSession();
    let onEvent: ((data: unknown) => void) | undefined;
    mockedGetOrCreateSession.mockImplementation(
      (_opts, handler): AgentSession => {
        onEvent = handler;
        return session;
      },
    );

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      text: 'Stop the turn',
      sdkSessionId: 'thread-1',
    });

    if (!onEvent) {
      throw new Error('Expected chat event handler to be registered');
    }

    void onEvent({
      type: 'result',
      is_error: false,
      result: 'Turn cancelled',
    });
    await flushPromises();

    expect(completeChatTurnMock).toHaveBeenCalledWith(
      'proj',
      'worktree',
      'chat',
      'cancelled',
      undefined,
    );
  });

  it('marks gracefully ended sessions as interrupted', async () => {
    const session = makeMockSession();
    let onEvent: ((data: unknown) => void) | undefined;
    mockedGetOrCreateSession.mockImplementation(
      (_opts, handler): AgentSession => {
        onEvent = handler;
        return session;
      },
    );

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      text: 'Abort the turn',
      sdkSessionId: 'thread-1',
    });

    if (!onEvent) {
      throw new Error('Expected chat event handler to be registered');
    }

    void onEvent({
      type: 'result',
      is_error: false,
      result: 'Session ended',
    });
    await flushPromises();

    expect(completeChatTurnMock).toHaveBeenCalledWith(
      'proj',
      'worktree',
      'chat',
      'interrupted',
      undefined,
    );
  });

  it.each([
    ['continue-on-other-harness', 'Chat Handoff Summary (Continue)'],
    ['stale-session', 'Chat Handoff Summary (Stale Session)'],
    ['archived-chat', 'Chat Handoff Summary (Archive)'],
  ])(
    'audits a %s handoff summary with its source chat',
    async (kind, label) => {
      mockedReadPreferencesFile.mockResolvedValue(
        makePreferences({
          handoffSummaryModel: 'claude-sonnet-4-6',
          handoffSummaryThinkingLevel: 'high',
        }),
      );
      const usage = { inputTokens: 11, outputTokens: 5 };
      mockedGenerateHandoffSummary.mockResolvedValueOnce({
        text: 'summarized handoff',
        usage,
      });

      const result = await getHandler(IPC_CHANNELS.chatGenerateHandoffSummary)(
        undefined,
        {
          projectId: 'proj',
          worktreeId: 'worktree',
          conversationText: 'User: resume this task',
          kind,
          chatId: 'chat-1-1234567890',
        },
      );

      expect(mockedResolveWorktreeCwd).toHaveBeenCalledWith('proj', 'worktree');
      const taskKey = startObservedTaskMock.mock.calls[0]?.[0];
      expect(taskKey).toEqual(
        expect.stringMatching(
          /^helper:handoff-summary:proj\/worktree\/chat-1-1234567890:\d+$/,
        ),
      );
      const entry = startObservedTaskMock.mock.calls[0]?.[1];
      expect(entry).toMatchObject({
        id: taskKey,
        eventType: 'chat_handoff_summary',
        status: 'running',
        provider: 'claude',
        label,
        attempt: 1,
        model: 'claude-sonnet-4-6',
        tokens: {
          input: 0,
          output: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          reasoningOutputTokens: 0,
        },
        messageCount: 0,
        assistantMessageCount: 0,
        toolUseCount: 0,
        subAgentCount: 0,
        hasTranscript: false,
        projectId: 'proj',
        worktreeId: 'worktree',
        repoId: undefined,
        repoLabel: undefined,
        chatId: 'chat-1-1234567890',
        linkTarget: {
          page: 'main',
          kind: 'worktree-chat',
          projectId: 'proj',
          worktreeId: 'worktree',
          chatId: 'chat-1-1234567890',
        },
      });
      expect(typeof entry?.startedAt).toBe('string');
      expect(mockedGenerateHandoffSummary).toHaveBeenCalledWith(
        'User: resume this task',
        {
          model: 'claude-sonnet-4-6',
          thinkingLevel: 'high',
          modelConfig: {
            thinkingLevel: 'high',
            speed: 'standard',
            fastMode: false,
          },
          cwd: '/tmp/repo',
          workspaceId: 'proj',
          observabilityTaskKey: taskKey,
        },
      );
      expect(finalizeObservedTaskMock).toHaveBeenCalledWith(
        taskKey,
        'success',
        undefined,
        usage,
      );
      expect(result).toEqual({ summary: 'summarized handoff' });
    },
  );

  it('summarizes the canonical full transcript for cross-provider continuation', async () => {
    mockConsumeTranscript.mockImplementationOnce(
      async (_scope, _chatId, _fullOutputs, consume) =>
        consume(
          (async function* (): AsyncGenerator<PersistedChatMessage> {
            await Promise.resolve();
            yield {
              id: 'older-than-renderer-page',
              role: 'user',
              timestamp: 1,
              blocks: [
                { type: 'text', text: 'retain the original constraint' },
              ],
            };
            yield {
              id: 'visible-page',
              role: 'assistant',
              timestamp: 2,
              blocks: [{ type: 'text', text: 'continuing now' }],
            };
          })(),
        ),
    );

    await getHandler(IPC_CHANNELS.chatGenerateHandoffSummary)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      conversationText: 'Renderer page omitted the original constraint',
      kind: 'continue-on-other-harness',
      chatId: 'chat-1',
    });

    expect(mockConsumeTranscript).toHaveBeenCalledWith(
      { projectId: 'proj', worktreeId: 'worktree' },
      'chat-1',
      false,
      expect.any(Function),
    );
    expect(mockedGenerateHandoffSummary).toHaveBeenCalledWith(
      expect.stringContaining('User: retain the original constraint'),
      expect.any(Object),
    );
  });

  it.each(['ollama-removed-model', 'saved-unavailable-model'])(
    'directs unavailable saved handoff selection %s back to Settings before provider work',
    async (model) => {
      mockedReadPreferencesFile.mockResolvedValue(
        makePreferences({ handoffSummaryModel: model }),
      );
      await expect(
        getHandler(IPC_CHANNELS.chatGenerateHandoffSummary)(undefined, {
          projectId: 'proj',
          worktreeId: 'worktree',
          conversationText: 'Keep this conversation local',
        }),
      ).rejects.toThrow(
        'Choose a supported conversation handoff model in Settings',
      );
      expect(mockedGenerateHandoffSummary).not.toHaveBeenCalled();
    },
  );

  it('captures handoff settings before asynchronous transcript consumption', async () => {
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const consuming = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockConsumeTranscript.mockImplementationOnce(async () => {
      entered?.();
      await gate;
      return 'Canonical conversation';
    });
    mockedReadPreferencesFile.mockResolvedValue(
      makePreferences({
        handoffSummaryModel: 'claude-sonnet-4-6',
        handoffSummaryThinkingLevel: 'high',
        providerModelConfigDefaults: { codex: { speed: 'fast' } },
      }),
    );
    const req = {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      kind: 'continue-on-other-harness',
      conversationText: 'Renderer page',
    };
    const running = getHandler(IPC_CHANNELS.chatGenerateHandoffSummary)(
      undefined,
      req,
    );
    await consuming;
    mockedReadPreferencesFile.mockResolvedValue(
      makePreferences({
        handoffSummaryModel: 'claude-haiku-4-5-20251001',
        handoffSummaryThinkingLevel: 'off',
        providerModelConfigDefaults: { codex: { speed: 'standard' } },
      }),
    );
    release?.();
    await running;
    expect(mockedGenerateHandoffSummary).toHaveBeenLastCalledWith(
      'Canonical conversation',
      expect.objectContaining({
        model: 'claude-sonnet-4-6',
        thinkingLevel: 'high',
        modelConfig: { thinkingLevel: 'high', speed: 'fast', fastMode: true },
      }),
    );
    await getHandler(IPC_CHANNELS.chatGenerateHandoffSummary)(undefined, req);
    expect(mockedGenerateHandoffSummary).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        model: 'claude-haiku-4-5-20251001',
        thinkingLevel: 'off',
        modelConfig: {
          thinkingLevel: 'off',
          speed: 'standard',
          fastMode: false,
        },
      }),
    );
  });

  it('inherits the source chat owner for a handoff summary', async () => {
    const workOwner = {
      kind: 'organization' as const,
      organizationId: '123e4567-e89b-12d3-a456-426614174000',
    };
    mockResolveSessionWorkOwner.mockResolvedValueOnce(workOwner);

    await getHandler(IPC_CHANNELS.chatGenerateHandoffSummary)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      conversationText: 'User: resume this task',
      kind: 'stale-session',
      chatId: 'chat-1',
    });

    expect(mockCaptureSessionWorkOwner).toHaveBeenCalledWith({
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat-1',
    });
    expect(mockResolveSessionWorkOwner).toHaveBeenCalledWith({
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat-1',
    });
    expect(mockedGenerateHandoffSummary).toHaveBeenCalledWith(
      'User: resume this task',
      expect.objectContaining({ workOwner }),
    );
  });

  it('retains oversized canonical context before a short trailing handoff error', async () => {
    mockConsumeTranscript.mockImplementationOnce(
      async (_scope, _chatId, _fullOutputs, consume) =>
        consume(
          (async function* (): AsyncGenerator<PersistedChatMessage> {
            await Promise.resolve();
            yield {
              id: 'oversized-response',
              role: 'assistant',
              timestamp: 1,
              blocks: [
                {
                  type: 'text',
                  text:
                    'Earlier details. '.repeat(4000) +
                    ' Essential final constraint.',
                },
              ],
            };
            yield {
              id: 'short-error',
              role: 'system',
              timestamp: 2,
              blocks: [
                {
                  type: 'text',
                  text: 'Provider failed; please continue.',
                },
              ],
            };
          })(),
        ),
    );
    await getHandler(IPC_CHANNELS.chatGenerateHandoffSummary)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat-1',
      conversationText: 'Renderer projection',
      kind: 'continue-on-other-harness',
    });
    const input = mockedGenerateHandoffSummary.mock.calls[0]?.[0];
    expect(input).toContain('Essential final constraint.');
    expect(input).toContain('Earlier turns omitted');
    expect(input).toContain('Provider failed; please continue.');
    expect(input?.length).toBeLessThanOrEqual(24_000);
    expect(input?.length).toBeGreaterThan(23_000);
  });

  // `'constructor'` / `'__proto__'` are the reason the kind lookup is a `Map`
  // rather than plain-object indexing: object lookup would resolve them
  // through `Object.prototype` and hand back a function where a
  // `HandoffSummaryKind` is expected, yielding a `Chat Handoff Summaryundefined`
  // label. Keeping them in this table makes that regression a failure.
  it.each([undefined, 'future-kind', 'constructor', '__proto__'])(
    'uses the generic audit label for an unrecognized kind (%s)',
    async (kind) => {
      await getHandler(IPC_CHANNELS.chatGenerateHandoffSummary)(undefined, {
        projectId: 'proj',
        worktreeId: 'worktree',
        conversationText: 'User: resume this task',
        kind,
      });

      expect(startObservedTaskMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          label: 'Chat Handoff Summary',
          chatId: undefined,
        }),
      );
    },
  );

  it('records helper usage and rethrows when handoff generation fails', async () => {
    const error = new StructuredHelperQueryError('boom', { inputTokens: 7 });
    mockedGenerateHandoffSummary.mockRejectedValueOnce(error);

    await expect(
      getHandler(IPC_CHANNELS.chatGenerateHandoffSummary)(undefined, {
        projectId: 'proj',
        worktreeId: 'worktree',
        conversationText: 'User: resume this task',
      }),
    ).rejects.toBe(error);

    const taskKey = startObservedTaskMock.mock.calls[0]?.[0];
    expect(finalizeObservedTaskMock).toHaveBeenCalledWith(
      taskKey,
      'failure',
      'boom',
      { inputTokens: 7 },
    );
  });

  it.each([
    [
      'cowork-default',
      'cowork-chat',
      {
        page: 'chat',
        kind: 'standalone-chat',
        worktreeId: 'cowork-default',
        chatId: 'chat-source',
      },
    ],
    [
      // Legacy standalone keying: the sentinel is in `projectId` and the real
      // cowork workspace id is in `worktreeId`. The link target must carry the
      // workspace id, not the sentinel — persisting `'standalone-chat'` would
      // make Inspect call `switchChatProject('standalone-chat')` and dead-end.
      STANDALONE_CHAT_PROJECT_ID,
      'cowork-default',
      {
        page: 'chat',
        kind: 'standalone-chat',
        worktreeId: 'cowork-default',
        chatId: 'chat-source',
      },
    ],
    [
      APP_ADVISOR_PROJECT_ID,
      APP_ADVISOR_WORKTREE_ID,
      { page: 'main', kind: 'app-advisor', chatId: 'chat-source' },
    ],
  ])(
    'builds the handoff link target for project %s',
    async (projectId, worktreeId, linkTarget) => {
      await getHandler(IPC_CHANNELS.chatGenerateHandoffSummary)(undefined, {
        projectId,
        worktreeId,
        conversationText: 'User: resume this task',
        chatId: 'chat-source',
      });

      expect(startObservedTaskMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ linkTarget }),
      );
    },
  );

  it('forks a Codex thread using the resolved worktree cwd and returns the forked thread id', async () => {
    mockedForkCodexThreadByIdViaOneShot.mockResolvedValueOnce('thread-forked');
    mockedReadPreferencesFile.mockResolvedValue(
      makePreferences({ codexMultiAgentWorktreeChatsEnabled: false }),
    );
    const pluginSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'codex-market', pluginName: 'ud-git' }],
      mcpServerRefs: [],
    };

    const result = await getHandler(IPC_CHANNELS.chatForkCodexThread)(
      undefined,
      {
        projectId: 'proj',
        worktreeId: 'worktree',
        chatId: 'chat',
        selectedRepoId: 'repo-1',
        sourceThreadId: 'thread-source',
        pluginSelections,
        codexFastModeEnabled: true,
      },
    );

    expect(mockedValidateId).toHaveBeenCalledWith('proj', 'projectId');
    expect(mockedValidateId).toHaveBeenCalledWith('worktree', 'worktreeId');
    expect(mockedValidateId).toHaveBeenCalledWith('chat', 'chatId');
    expect(mockedValidateOptionalRepoId).toHaveBeenCalledWith(
      'repo-1',
      'selectedRepoId',
    );
    expect(mockedResolveWorktreeCwd).toHaveBeenCalledWith(
      'proj',
      'worktree',
      'repo-1',
    );
    expect(mockedForkCodexThreadByIdViaOneShot).toHaveBeenCalledTimes(1);
    const forkRequest = mockedForkCodexThreadByIdViaOneShot.mock.calls[0]?.[0];
    if (!forkRequest) {
      throw new Error('Expected forkCodexThreadByIdViaOneShot to be called');
    }
    expect(forkRequest).toEqual({
      cwd: '/tmp/repo',
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      sourceThreadId: 'thread-source',
      pluginSelections,
      codexMultiAgentEnabled: false,
      codexMaxConcurrentSubagents: undefined,
      modelConfig: { speed: 'fast', fastMode: true, thinkingLevel: 'high' },
      onForked: forkRequest.onForked,
    });
    expect(typeof forkRequest.onForked).toBe('function');
    const onForked = forkRequest.onForked;
    await onForked?.('thread-forked');
    expect(lastCanonicalChatCommand()).toEqual({
      type: 'chat.patch_tab_settings',
      tabId: 'chat',
      patch: { sdkSessionId: 'thread-forked' },
    });
    expect(result).toEqual({ forkedThreadId: 'thread-forked' });
  });

  it('forks a Codex thread with the exact requested Ultra fast speed', async () => {
    mockedForkCodexThreadByIdViaOneShot.mockResolvedValueOnce('thread-forked');

    await getHandler(IPC_CHANNELS.chatForkCodexThread)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      sourceThreadId: 'thread-source',
      modelConfig: { speed: 'ultrafast', fastMode: false },
      codexFastModeEnabled: true,
    });

    expect(mockedForkCodexThreadByIdViaOneShot).toHaveBeenCalledWith(
      expect.objectContaining({
        modelConfig: {
          speed: 'ultrafast',
          fastMode: false,
          thinkingLevel: 'high',
        },
      }),
    );
  });

  it.each([
    [{ speed: 'turbo' }, 'Codex speed is unsupported'],
    [
      { speed: 'ultrafast', fastMode: true },
      'Codex fast mode contradicts the requested speed',
    ],
  ])(
    'rejects an invalid Codex speed %j before forking',
    async (modelConfig, message) => {
      await expect(
        getHandler(IPC_CHANNELS.chatForkCodexThread)(undefined, {
          projectId: 'proj',
          worktreeId: 'worktree',
          chatId: 'chat',
          sourceThreadId: 'thread-source',
          modelConfig,
        }),
      ).rejects.toThrow(message);
      expect(mockedForkCodexThreadByIdViaOneShot).not.toHaveBeenCalled();
    },
  );

  it('forks a standalone Codex thread using the standalone multi-agent preference', async () => {
    mockedForkCodexThreadByIdViaOneShot.mockResolvedValueOnce('thread-forked');
    mockedReadPreferencesFile.mockResolvedValue(
      makePreferences({
        codexMultiAgentWorktreeChatsEnabled: true,
        codexMultiAgentStandaloneChatsEnabled: false,
      }),
    );

    const result = await getHandler(IPC_CHANNELS.chatForkCodexThread)(
      undefined,
      {
        projectId: STANDALONE_CHAT_PROJECT_ID,
        worktreeId: 'default',
        chatId: 'chat',
        sourceThreadId: 'thread-source',
      },
    );

    expect(mockedForkCodexThreadByIdViaOneShot).toHaveBeenCalledTimes(1);
    const forkRequest = mockedForkCodexThreadByIdViaOneShot.mock.calls[0]?.[0];
    if (!forkRequest) {
      throw new Error('Expected forkCodexThreadByIdViaOneShot to be called');
    }
    expect(forkRequest).toEqual({
      cwd: '/tmp/repo',
      projectId: STANDALONE_CHAT_PROJECT_ID,
      worktreeId: 'default',
      chatId: 'chat',
      sourceThreadId: 'thread-source',
      codexMultiAgentEnabled: false,
      codexMaxConcurrentSubagents: undefined,
      modelConfig: {
        speed: 'standard',
        fastMode: false,
        thinkingLevel: 'high',
      },
      onForked: forkRequest.onForked,
    });
    expect(typeof forkRequest.onForked).toBe('function');
    expect(result).toEqual({ forkedThreadId: 'thread-forked' });
  });

  it('forks an App Advisor Codex thread from the shared project cwd', async () => {
    mockedForkCodexThreadByIdViaOneShot.mockResolvedValueOnce('thread-forked');
    mockedReadPreferencesFile.mockResolvedValue(
      makePreferences({
        codexMultiAgentWorktreeChatsEnabled: false,
        codexMultiAgentStandaloneChatsEnabled: false,
        codexMultiAgentAppAdvisorEnabled: true,
      }),
    );

    const result = await getHandler(IPC_CHANNELS.chatForkCodexThread)(
      undefined,
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-app-advisor',
        chatId: 'app-advisor-chat',
        sourceThreadId: 'thread-source',
      },
    );

    expect(mockedResolveWorktreeCwd).toHaveBeenCalledWith(
      APP_ADVISOR_PROJECT_ID,
      'entry-app-advisor',
    );
    expect(mockedForkCodexThreadByIdViaOneShot).toHaveBeenCalledTimes(1);
    const forkRequest = mockedForkCodexThreadByIdViaOneShot.mock.calls[0]?.[0];
    if (!forkRequest) {
      throw new Error('Expected forkCodexThreadByIdViaOneShot to be called');
    }
    expect(typeof forkRequest.cwd).toBe('string');
    expect(forkRequest).toEqual({
      cwd: forkRequest.cwd,
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'entry-app-advisor',
      chatId: 'app-advisor-chat',
      sourceThreadId: 'thread-source',
      codexMultiAgentEnabled: true,
      codexMaxConcurrentSubagents: undefined,
      modelConfig: {
        speed: 'standard',
        fastMode: false,
        thinkingLevel: 'high',
      },
      onForked: forkRequest.onForked,
    });
    expect(typeof forkRequest.onForked).toBe('function');
    expect(result).toEqual({ forkedThreadId: 'thread-forked' });
  });

  it('propagates Codex fork-thread failures to the renderer', async () => {
    mockedForkCodexThreadByIdViaOneShot.mockRejectedValueOnce(
      new Error('thread/fork failed'),
    );

    await expect(
      getHandler(IPC_CHANNELS.chatForkCodexThread)(undefined, {
        projectId: 'proj',
        worktreeId: 'worktree',
        chatId: 'chat',
        sourceThreadId: 'thread-source',
      }),
    ).rejects.toThrow('thread/fork failed');
  });
});

describe('chat IPC sendMessage cowork treatment for a real cowork project id', () => {
  beforeEach(() => {
    deferredToolsReloadCoordinator.resetForTests();
    jest.clearAllMocks();
    mockedSendToWindow.mockReturnValue(true);
    mockedSendToWindowDetailed.mockReturnValue({ delivered: true });
    mockedReadPersistedChatDispatchMetadata.mockResolvedValue({});
    mockedReadPreferencesFile.mockResolvedValue(makePreferences());
    mockClaudeTerminalGetState.mockReturnValue(undefined);
    mockClaudeTerminalCleanup.mockResolvedValue(undefined);
    mockGetWorkspaceType.mockReturnValue(null);
    mockedShouldRecreateSessionOnNextTurn.mockReturnValue(false);
    mockHandleChatTerminalEvent.mockClear();
    mockIngestProviderEvent.mockResolvedValue(true);
    mockIngestProviderEventWithOutcome.mockImplementation(
      ingestOutcomeFromCommit,
    );
    registerChatHandlers(makeWindowAccessors());
  });

  it('injects prepared owner-scoped organization memory into a native Cowork send', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);
    mockPrepareOrgMemory.mockResolvedValueOnce({
      attempt: {
        result: {
          organizationExternalId: 'org-owned',
          renderedBlock: 'Owner organization release guidance',
          facts: [],
        },
      },
    });
    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'cowork-default',
      worktreeId: 'entry-memory',
      chatId: 'chat-memory',
      userMessageId: 'msg-memory',
      text: 'Prepare the next release',
    });
    expect(mockPrepareOrgMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'cowork-default',
        worktreeId: 'entry-memory',
        chatId: 'chat-memory',
        userMessageId: 'msg-memory',
        userText: 'Prepare the next release',
        initiationSource: 'user',
      }),
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(session.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Owner organization release guidance'),
      { userMessageId: 'msg-memory', countsTowardSkillUsage: true },
    );
    expect(startChatTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgMemoryBlock: 'Owner organization release guidance',
      }),
    );
  });

  it('discloses and broadcasts retrieved organization memory for a native Cowork send', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);
    const facts = [
      {
        factId: 'fact-release-train',
        factText: 'Releases use a weekly release train.',
        validAt: null,
        sourceTurnIds: [],
      },
    ];
    mockPrepareOrgMemory.mockResolvedValueOnce({
      attempt: {
        result: {
          organizationExternalId: 'org-owned',
          searchId: 'search-1',
          renderedBlock: 'Owner organization release guidance',
          facts,
        },
      },
    });
    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'cowork-default',
      worktreeId: 'entry-memory',
      chatId: 'chat-memory',
      userMessageId: 'msg-memory',
      text: 'Prepare the next release',
    });
    expect(mockMemoryAckDelivered).toHaveBeenCalledWith(
      'org-owned',
      'search-1',
    );
    expect(mockMemoryAckDropped).not.toHaveBeenCalled();
    expect(mockPersistOrgMemoryUsedForChat).toHaveBeenCalledWith({
      projectId: 'cowork-default',
      worktreeId: 'entry-memory',
      chatId: 'chat-memory',
      userMessageId: 'msg-memory',
      organizationExternalId: 'org-owned',
      searchId: 'search-1',
      facts,
    });
    expect(mockedSendToWindowDetailed).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.chatEvent,
      expect.objectContaining({
        projectId: 'cowork-default',
        worktreeId: 'entry-memory',
        chatId: 'chat-memory',
        data: {
          type: ORG_MEMORY_USED_EVENT_TYPE,
          localChatId: 'chat-memory',
          localMessageId: 'msg-memory',
          organizationExternalId: 'org-owned',
          searchId: 'search-1',
          facts,
        },
      }),
    );
  });

  it('attributes retrieved organization memory as dropped when a native Cowork send fails', async () => {
    const session: AgentSession = {
      ...makeMockSession(),
      sendMessage: jest.fn(() => {
        throw new Error('provider rejected the turn');
      }),
    };
    mockedGetOrCreateSession.mockReturnValue(session);
    mockPrepareOrgMemory.mockResolvedValueOnce({
      attempt: {
        result: {
          organizationExternalId: 'org-owned',
          searchId: 'search-2',
          renderedBlock: 'Owner organization release guidance',
          facts: [
            {
              factText: 'Releases use a weekly release train.',
              validAt: null,
              sourceTurnIds: [],
            },
          ],
        },
      },
    });
    await expect(
      getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
        projectId: 'cowork-default',
        worktreeId: 'entry-memory',
        chatId: 'chat-memory',
        userMessageId: 'msg-memory-failed',
        text: 'Prepare the next release',
      }),
    ).rejects.toThrow('provider rejected the turn');
    expect(mockMemoryAckDropped).toHaveBeenCalledWith(
      'org-owned',
      'search-2',
      'send_failed',
    );
    expect(mockMemoryAckDelivered).not.toHaveBeenCalled();
    expect(mockPersistOrgMemoryUsedForChat).not.toHaveBeenCalled();
  });

  it('admits the full cowork send before asynchronous dispatch preparation', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'cowork-default',
      worktreeId: 'entry-lease',
      chatId: 'chat-lease',
      userMessageId: 'msg-lease',
      text: 'Keep this send inside the deletion fence',
    });

    expect(mockRunWithScopeActivity).toHaveBeenCalledWith(
      { projectId: 'cowork-default', worktreeId: 'entry-lease' },
      expect.any(Function),
    );
    expect(mockRunWithScopeActivity.mock.invocationCallOrder[0]).toBeLessThan(
      mockedReadPersistedChatDispatchMetadata.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mockedGetOrCreateSession).toHaveBeenCalledTimes(1);
  });

  it('guards cowork usage-limit cleanup with the pre-send timestamp', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'cowork-default',
      worktreeId: 'entry-usage-limit',
      chatId: 'chat-usage-limit',
      userMessageId: 'msg-usage-limit',
      text: 'Continue after the reset',
    });

    const [target, options] =
      mockedClearUsageLimitedChat.mock.calls.at(-1) ?? [];
    expect(target).toEqual({
      projectId: 'cowork-default',
      worktreeId: 'entry-usage-limit',
      chatId: 'chat-usage-limit',
    });
    expect(typeof options?.onlyIfDetectedBefore).toBe('number');
  });

  it('commits the prompt and provider events before broadcasting cowork state', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);
    const request = {
      projectId: 'cowork-default',
      worktreeId: 'entry-1',
      chatId: 'chat-canonical',
      userMessageId: 'msg-canonical',
      text: 'Persist this cowork turn',
      providerType: 'claude' as const,
    };

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, request);

    expect(mockEnsureChatForTrustedSend).toHaveBeenCalledWith({
      ...request,
      initiationSource: 'user',
    });
    const initialCommit = mockIngestProviderEvent.mock.calls[0]?.[0];
    expect(initialCommit).toMatchObject({
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      chatId: request.chatId,
      turnUserMessageId: request.userMessageId,
    });
    expect(initialCommit?.data).toMatchObject({
      type: 'canopy_user_prompt',
      canopy_turn_user_message_id: request.userMessageId,
    });

    const onEvent = mockedGetOrCreateSession.mock.calls[0]?.[1];
    if (!onEvent) {
      throw new Error('Expected cowork chat session event handler');
    }
    mockIngestProviderEvent.mockClear();
    mockedSendToWindowDetailed.mockClear();
    let releaseCommit: (() => void) | undefined;
    mockIngestProviderEvent.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseCommit = () => resolve(true);
        }),
    );

    void onEvent({
      type: 'assistant',
      message: {
        id: 'assistant-1',
        role: 'assistant',
        content: [{ type: 'text', text: 'Durable reply' }],
      },
    });
    await flushPromises();

    expect(mockIngestProviderEvent).toHaveBeenCalledTimes(1);
    expect(mockIngestProviderEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        mutationId: `${request.chatId}:${request.userMessageId}:provider:0`,
      }),
    );
    expect(mockedSendToWindowDetailed).not.toHaveBeenCalled();

    releaseCommit?.();
    await flushPromises();

    const deliveredEvent = mockedSendToWindowDetailed.mock.calls[0]?.[2];
    expect(mockedSendToWindowDetailed).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.chatEvent,
      deliveredEvent,
    );
    expect(deliveredEvent).toMatchObject({
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      chatId: request.chatId,
      data: { type: 'assistant' },
    });
    expect(mockIngestProviderEvent.mock.invocationCallOrder[0]).toBeLessThan(
      mockedSendToWindowDetailed.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('broadcasts a terminal result when canonical state already settled', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'cowork-default',
      worktreeId: 'entry-result',
      chatId: 'chat-result',
      userMessageId: 'msg-result',
      text: 'Finish this turn',
      providerType: 'codex',
    });

    const onEvent = mockedGetOrCreateSession.mock.calls[0]?.[1];
    if (!onEvent) {
      throw new Error('Expected cowork chat session event handler');
    }
    mockIngestProviderEvent.mockClear();
    mockedSendToWindowDetailed.mockClear();
    mockIngestProviderEvent.mockResolvedValueOnce(false);

    void onEvent({ type: 'result', is_error: false, result: 'Turn completed' });
    await flushPromises();

    expect(mockedSendToWindowDetailed).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.chatEvent,
      expect.objectContaining({
        projectId: 'cowork-default',
        worktreeId: 'entry-result',
        chatId: 'chat-result',
        data: { type: 'result', is_error: false, result: 'Turn completed' },
      }),
    );
  });

  it('delivers an activity-only cowork event but suppresses a rejected one', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'cowork-default',
      worktreeId: 'entry-activity',
      chatId: 'chat-activity',
      userMessageId: 'msg-activity',
      text: 'Keep streaming',
      providerType: 'claude',
    });

    const onEvent = mockedGetOrCreateSession.mock.calls[0]?.[1];
    if (!onEvent) {
      throw new Error('Expected cowork chat session event handler');
    }
    const activity = { type: 'system', subtype: 'status', status: 'busy' };
    const rejected = { type: 'system', subtype: 'status', status: 'stale' };
    const outcomeFor = (data: unknown): ProviderEventIngestOutcome =>
      data === activity ? 'activity-only' : 'not-applied';
    // Neither event is a durable commit.
    mockIngestProviderEvent.mockResolvedValue(false);
    mockIngestProviderEventWithOutcome.mockImplementation((input) =>
      Promise.resolve(outcomeFor(input.data)),
    );
    mockedSendToWindowDetailed.mockClear();

    void onEvent(activity);
    void onEvent(rejected);
    await flushPromises();

    expect(mockedSendToWindowDetailed).toHaveBeenCalledTimes(1);
    expect(mockedSendToWindowDetailed).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.chatEvent,
      expect.objectContaining({
        projectId: 'cowork-default',
        worktreeId: 'entry-activity',
        chatId: 'chat-activity',
        data: activity,
      }),
    );
  });

  it('exposes the current cowork provider-event tail to session teardown', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'cowork-default',
      worktreeId: 'entry-drain',
      chatId: 'chat-drain',
      userMessageId: 'msg-drain',
      text: 'Persist terminal events before teardown',
    });

    const onEvent = mockedGetOrCreateSession.mock.calls[0]?.[1];
    const lifecycle = mockedGetOrCreateSession.mock.calls[0]?.[3];
    if (!onEvent || !lifecycle?.drainEventsBeforeRemoval) {
      throw new Error('Expected cowork session event-drain lifecycle');
    }

    let releaseCommit: (() => void) | undefined;
    mockIngestProviderEvent.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseCommit = () => resolve(true);
        }),
    );
    void onEvent({ type: 'result', is_error: false, result: 'Done' });

    let drained = false;
    const drain = lifecycle.drainEventsBeforeRemoval().then(() => {
      drained = true;
    });
    await flushPromises();
    expect(drained).toBe(false);

    releaseCommit?.();
    await drain;
    expect(drained).toBe(true);
  });

  it('delivers Cowork attachment blocks to OpenCode from the managed attachment root', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);
    const baseDir = getCoworkManagedSubdir('/tmp/repo', 'attachments');
    const attachmentPaths = [`${baseDir}/notes.txt`];
    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'cowork-default',
      worktreeId: 'home',
      chatId: 'chat',
      userMessageId: 'opencode-cowork-attachment',
      text: 'Review this attachment',
      model: 'opencode:fixture%2Fmodel',
      providerType: 'opencode',
      executionHarness: 'opencode',
      attachmentPaths,
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(session.sendMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        attachments: { baseDir, paths: attachmentPaths },
      }),
    );
  });

  it('uses the cowork managed attachments dir instead of a legacy resolveCoworkWorkspaceId(worktreeId) lookup', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);
    const attachmentsDir = getCoworkManagedSubdir('/tmp/repo', 'attachments');
    const attachmentPath = `${attachmentsDir}/notes.txt`;

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'cowork-default',
      worktreeId: 'home',
      chatId: 'chat',
      userMessageId: 'msg-cowork-attachment',
      text: 'Review this attachment',
      attachmentPaths: [attachmentPath],
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method
    const sendMessageMock = jest.mocked(session.sendMessage);
    // If the attachment base dir were still resolved from
    // `getWorkspaceHomeDir(resolveCoworkWorkspaceId(worktreeId))` (treating
    // the literal 'home' worktree slot as a workspace id), validating this
    // attachment path against that wrong directory would throw instead of
    // reaching sendMessage.
    expect(sendMessageMock).toHaveBeenCalled();
  });

  it('mirrors deferred-reload events for every App Advisor entry to both windows', () => {
    const getMainWindow = jest.fn<BrowserWindow | null, []>(() => null);
    const getAppAdvisorWindow = jest.fn<BrowserWindow | null, []>(() => null);
    const accessors = makeWindowAccessors(getMainWindow);
    accessors.getAppAdvisorWindow = getAppAdvisorWindow;
    registerChatHandlers(accessors);
    const intent = deferredToolsReloadCoordinator.createIntent({
      scope: {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-app-advisor',
        chatId: 'app-advisor-reload',
      },
      toolCallId: 'tool-app-advisor-reload',
      providerType: 'claude',
      interfaceMode: 'canopy',
      additions: { skillRefs: [], pluginRefs: [], mcpServerRefs: [] },
      enabledResources: [],
    });
    expect(intent.accepted).toBe(true);

    deferredToolsReloadCoordinator.markToolResultDelivered(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-app-advisor',
        chatId: 'app-advisor-reload',
      },
      'tool-app-advisor-reload',
    );

    expect(getAppAdvisorWindow).toHaveBeenCalledTimes(1);
    expect(getMainWindow).toHaveBeenCalledTimes(1);
  });

  it('does not classify a foreign global worktree as App Advisor for deferred reload routing', () => {
    const getMainWindow = jest.fn<BrowserWindow | null, []>(() => null);
    const getAppAdvisorWindow = jest.fn<BrowserWindow | null, []>(() => null);
    const accessors = makeWindowAccessors(getMainWindow);
    accessors.getAppAdvisorWindow = getAppAdvisorWindow;
    registerChatHandlers(accessors);
    const scope = {
      projectId: 'foreign-project',
      worktreeId: APP_ADVISOR_WORKTREE_ID,
      chatId: 'foreign-global-reload',
    };
    const intent = deferredToolsReloadCoordinator.createIntent({
      scope,
      toolCallId: 'tool-foreign-global-reload',
      providerType: 'claude',
      interfaceMode: 'canopy',
      additions: { skillRefs: [], pluginRefs: [], mcpServerRefs: [] },
      enabledResources: [],
    });
    expect(intent.accepted).toBe(true);

    deferredToolsReloadCoordinator.markToolResultDelivered(
      scope,
      'tool-foreign-global-reload',
    );

    expect(getAppAdvisorWindow).not.toHaveBeenCalled();
    expect(getMainWindow).toHaveBeenCalledTimes(1);
  });

  it.each(['claude', 'codex'] as const)(
    'uses the cowork system and %s tool prompts and marks the chat standalone in the audit turn',
    async (providerType) => {
      const session = makeMockSession();
      mockedGetOrCreateSession.mockReturnValue(session);

      await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
        projectId: 'cowork-default',
        worktreeId: 'home',
        chatId: 'chat',
        userMessageId: 'msg-cowork',
        text: 'Hello cowork',
        providerType,
      });

      const startArgs = startChatTurnMock.mock.calls[0]?.[0];
      if (!startArgs || typeof startArgs.systemPromptAppend !== 'string') {
        throw new Error('Expected startChatTurn to receive systemPromptAppend');
      }
      expect(startArgs.systemPromptAppend).toContain('cowork project');
      expect(startArgs.systemPromptAppend).toContain('project tools');
      expect(startArgs.systemPromptAppend).toContain(
        providerType === 'codex'
          ? CANOPY_INJECTED_TOOL_REGISTRY.dispatch_action.codexToolName
          : CANOPY_INJECTED_TOOL_REGISTRY.dispatch_action.claudeToolName,
      );
      expect(startArgs.isStandalone).toBe(true);
      expect(startArgs.standaloneProjectId).toBe('cowork-default');
    },
  );

  it('records the original instruction snapshot when resuming a cowork provider session', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);
    mockedReadPreferencesFile.mockResolvedValue(
      makePreferences({
        globalInstructions: {
          chats: {
            overall: 'Do not record this on resume.',
            scoped: [],
          },
          pipelines: { overall: '', scoped: [] },
        },
      }),
    );

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'cowork-default',
      worktreeId: 'home',
      chatId: 'chat',
      userMessageId: 'msg-cowork-resume-audit',
      text: 'Continue cowork',
      providerType: 'claude',
      sdkSessionId: 'provider-session-id',
      globalInstructionsSnapshot:
        '# User Overall Preferences\n\nOriginal snapshot.',
    });

    const startArgs = startChatTurnMock.mock.calls[0]?.[0];
    expect(startArgs?.systemPromptAppend).toContain('cowork project');
    expect(startArgs?.systemPromptAppend).toContain('Original snapshot.');
    expect(startArgs?.systemPromptAppend).not.toContain(
      'Do not record this on resume.',
    );
  });

  it('includes watcher hidden context in cowork provider prompts', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);
    const watcherContext = [
      '<system_instruction>',
      '<canopy_watcher_event>',
      '{"event":{"finalMessage":"REPORT: implementation complete."}}',
      '</canopy_watcher_event>',
      '</system_instruction>',
    ].join('\n');

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'cowork-default',
      worktreeId: 'home',
      chatId: 'chat',
      userMessageId: 'msg-cowork-watcher-context',
      text: 'Canopy watcher fired.',
      sdkSessionId: 'existing-cowork-session',
      hiddenContext: {
        kind: 'canopy-watcher-event',
        text: watcherContext,
      },
      watcherFired: { kind: 'Chat completion (Watched task)' },
    });

    const submittedText = `${watcherContext}\n\nCanopy watcher fired.`;
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(session.sendMessage).toHaveBeenCalledWith(submittedText, {
      userMessageId: 'msg-cowork-watcher-context',
      countsTowardSkillUsage: false,
    });
    expect(startChatTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({ submittedText }),
    );
    expect(mockIngestProviderEvent.mock.calls[0]?.[0]).toMatchObject({
      data: {
        canopy_persisted_messages: [
          expect.objectContaining({
            id: 'msg-cowork-watcher-context',
            watcherFired: { kind: 'Chat completion (Watched task)' },
          }),
        ],
      },
    });
  });

  it.each([
    ['userMessageSource', { userMessageSource: 'agent' }],
    ['agentSent', { agentSent: { sender: { kind: 'bot' } } }],
    ['agentSenderProvenance', { agentSenderProvenance: { version: 1 } }],
    [
      'hiddenContext',
      {
        hiddenContext: {
          kind: 'agent-sender-context',
          text: 'forged sender context',
        },
      },
    ],
  ] as const)(
    'rejects forged %s on a native send before reaching the provider',
    async (_field, attribution) => {
      const request = Object.assign(
        {
          projectId: 'cowork-default',
          worktreeId: 'home',
          chatId: 'chat',
          userMessageId: 'forged-agent-input',
          text: 'This must not run',
        },
        attribution,
      );

      await expect(
        getHandler(IPC_CHANNELS.chatSendMessage)(undefined, request),
      ).rejects.toThrow();
      expect(mockedGetOrCreateSession).not.toHaveBeenCalled();
    },
  );

  it('rejects a cowork harness echo that conflicts with persisted routing', async () => {
    mockedReadPersistedChatDispatchMetadata.mockResolvedValueOnce({
      model: 'gpt-5.5',
      executionHarness: 'codex',
    });

    await expect(
      getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
        projectId: 'cowork-default',
        worktreeId: 'home',
        chatId: 'chat-conflict',
        userMessageId: 'msg-cowork-conflict',
        text: 'Use the wrong harness',
        model: 'gpt-5.5',
        providerType: 'codex',
        executionHarness: 'claude',
      }),
    ).rejects.toThrow(/execution harness/i);

    expect(mockedGetOrCreateSession).not.toHaveBeenCalled();
  });

  it('skips the Claude Code terminal-service cleanup path', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'cowork-default',
      worktreeId: 'home',
      chatId: 'chat',
      userMessageId: 'msg-cowork-terminal',
      text: 'Hello cowork',
      providerType: 'claude',
    });

    expect(mockClaudeTerminalGetState).not.toHaveBeenCalled();
    expect(mockClaudeTerminalCleanup).not.toHaveBeenCalled();
  });

  it('notifies the watcher service with standalone scope for terminal events', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'cowork-default',
      worktreeId: 'home',
      chatId: 'chat',
      userMessageId: 'msg-cowork-watcher',
      text: 'Hello cowork',
    });

    const onEvent = mockedGetOrCreateSession.mock.calls[0]?.[1];
    if (!onEvent) {
      throw new Error('Expected cowork chat session event handler');
    }
    void onEvent({ type: 'result', is_error: false, result: 'Done' });
    await flushPromises();

    expect(mockHandleChatTerminalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'terminal',
        address: {
          projectId: 'cowork-default',
          taskId: 'home',
          chatId: 'chat',
        },
      }),
    );
    expect(scheduleSummaryGenerationMock).toHaveBeenCalledWith(
      'cowork-default',
      'home',
      expect.any(Function),
    );
  });

  it('does not write the legacy chat-history meta mirror for cowork sends', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'cowork-default',
      worktreeId: 'home',
      chatId: 'chat',
      userMessageId: 'msg-cowork-meta',
      text: 'Hello cowork',
      providerType: 'codex',
      sdkSessionId: undefined,
    });

    // Work Entries: provider/description metadata is derived from the tab
    // file main-side; the chat-history meta mirror is a frozen legacy store.
    expect(mockedUpdateChatMeta).not.toHaveBeenCalled();
  });

  it.each(['claude', 'codex'])(
    'preserves a disabled deferred-tools policy for %s sessions',
    async (providerType) => {
      const session = makeMockSession();
      mockedGetOrCreateSession.mockReturnValue(session);

      await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
        projectId: 'cowork-default',
        worktreeId: 'home',
        chatId: `chat-${providerType}`,
        userMessageId: `msg-${providerType}`,
        text: 'Do not use deferred tools',
        providerType,
        deferredToolsAllowed: false,
      });

      expect(mockedGetOrCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({
          providerType,
          deferredToolsAllowed: false,
        }),
        expect.any(Function),
        expect.any(Function),
        expect.anything(),
      );
      expectLatestSessionLifecycleDrain();
    },
  );

  it('reclamps a deferred-tools reload before its hidden continuation', async () => {
    const initialSession = makeMockSession();
    initialSession.getProviderSessionId = jest.fn(
      () => 'provider-owned-session',
    );
    const resumedSession = makeMockSession();
    mockedReadPreferencesFile.mockResolvedValue(
      makePreferences({ codexMaxConcurrentSubagents: 3 }),
    );
    const resumedSetApprovalMode = jest.fn().mockResolvedValue(undefined);
    const resumedSendMessage = jest.fn();
    resumedSession.setApprovalMode = resumedSetApprovalMode;
    resumedSession.sendMessage = resumedSendMessage;
    mockedGetSession.mockReturnValue(initialSession);
    mockedGetOrCreateSession
      .mockReturnValueOnce(initialSession)
      .mockImplementationOnce(() => {
        setLiveApprovalMode('cowork-default', 'home', 'chat-reload', 'ask');
        return resumedSession;
      });
    const registerResumeHandler = jest.spyOn(
      deferredToolsReloadCoordinator,
      'registerResumeHandler',
    );

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'cowork-default',
      worktreeId: 'home',
      chatId: 'chat-reload',
      userMessageId: 'msg-reload',
      text: 'Use the deferred tool',
      providerType: 'codex',
      approvalMode: 'full-access',
    });

    const registration = registerResumeHandler.mock.calls.find(
      ([scope]) => scope.chatId === 'chat-reload',
    );
    const resume = registration?.[1];
    if (!resume) {
      throw new Error('Expected cowork deferred-tools resume handler');
    }
    const controller = new AbortController();
    await resume({
      scope: {
        projectId: 'cowork-default',
        worktreeId: 'home',
        chatId: 'chat-reload',
      },
      requestId: 'reload-request',
      toolCallId: 'tool-call',
      userMessageId: 'msg-reload',
      continuationText: '<system_instruction>Continue</system_instruction>',
      enabledResources: [
        { kind: 'skill', ref: 'marketplace:skill', name: 'Skill' },
      ],
      sdkSessionId: undefined,
      providerType: 'codex',
      pluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      signal: controller.signal,
    });

    expect(mockedGetOrCreateSession).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sdkSessionId: 'provider-owned-session',
        providerType: 'codex',
        approvalMode: 'full-access',
        codexMaxConcurrentSubagents: 3,
      }),
      expect.any(Function),
      expect.any(Function),
      expect.anything(),
    );
    expectLatestSessionLifecycleDrain();
    expect(resumedSendMessage).toHaveBeenCalledWith(
      '<system_instruction>Continue</system_instruction>',
      { userMessageId: 'msg-reload' },
    );
    expect(resumedSetApprovalMode).toHaveBeenCalledWith('ask');
    expect(resumedSetApprovalMode.mock.invocationCallOrder[0]).toBeLessThan(
      resumedSendMessage.mock.invocationCallOrder[0],
    );
    expect(recordInjectedPromptForOpenChatTurnMock).toHaveBeenCalledWith(
      'cowork-default',
      'home',
      'chat-reload',
      expect.objectContaining({
        applicationCondition: 'deferred_tools_reload_continuation',
      }),
    );
    expect(startChatTurnMock).toHaveBeenCalledTimes(1);
    registerResumeHandler.mockRestore();
  });

  it('resumes a started Claude fork child after a deferred-tools reload', async () => {
    const initialSession = makeMockSession();
    initialSession.getProviderSessionId = jest.fn(() => 'fork-child-session');
    const resumedSession = makeMockSession();
    mockedGetSession.mockReturnValue(initialSession);
    mockedGetOrCreateSession
      .mockReturnValueOnce(initialSession)
      .mockReturnValueOnce(resumedSession);
    const registerResumeHandler = jest.spyOn(
      deferredToolsReloadCoordinator,
      'registerResumeHandler',
    );

    try {
      await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
        projectId: 'cowork-default',
        worktreeId: 'home',
        chatId: 'chat-fork-reload',
        userMessageId: 'msg-fork-reload',
        text: 'Load the deferred tool',
        providerType: 'claude',
        sdkSessionId: 'source-session',
        claudeForkSession: true,
        claudeForkResumeAt: 'source-anchor-uuid',
      });
      expect(mockedGetOrCreateSession).toHaveBeenLastCalledWith(
        expect.objectContaining({
          sdkSessionId: 'source-session',
          claudeForkSession: true,
          claudeForkResumeAt: 'source-anchor-uuid',
        }),
        expect.any(Function),
        expect.any(Function),
        expect.anything(),
      );

      const resume = registerResumeHandler.mock.calls.find(
        ([scope]) => scope.chatId === 'chat-fork-reload',
      )?.[1];
      if (!resume) {
        throw new Error('Expected cowork deferred-tools resume handler');
      }
      await resume({
        scope: {
          projectId: 'cowork-default',
          worktreeId: 'home',
          chatId: 'chat-fork-reload',
        },
        requestId: 'reload-request',
        toolCallId: 'tool-call',
        userMessageId: 'msg-fork-reload',
        continuationText: '<system_instruction>Continue</system_instruction>',
        enabledResources: [],
        sdkSessionId: 'fork-child-session',
        providerType: 'claude',
        signal: new AbortController().signal,
      });

      const resumedOptions = mockedGetOrCreateSession.mock.lastCall?.[0];
      expect(resumedOptions?.sdkSessionId).toBe('fork-child-session');
      expect(resumedOptions?.claudeForkSession).toBeUndefined();
      expect(resumedOptions?.claudeForkResumeAt).toBeUndefined();
    } finally {
      registerResumeHandler.mockRestore();
    }
  });

  it('does not finalize observability for the internal reload interruption', async () => {
    const session = makeMockSession();
    mockedGetOrCreateSession.mockReturnValue(session);

    await getHandler(IPC_CHANNELS.chatSendMessage)(undefined, {
      projectId: 'cowork-default',
      worktreeId: 'home',
      chatId: 'chat-interruption',
      userMessageId: 'msg-interruption',
      text: 'Use the deferred tool',
    });

    const intent = deferredToolsReloadCoordinator.createIntent({
      scope: {
        projectId: 'cowork-default',
        worktreeId: 'home',
        chatId: 'chat-interruption',
      },
      toolCallId: 'tool-interruption',
      providerType: 'claude',
      interfaceMode: 'canopy',
      additions: { skillRefs: [], pluginRefs: [], mcpServerRefs: [] },
      enabledResources: [],
    });
    expect(intent.accepted).toBe(true);
    const onEvent = mockedGetOrCreateSession.mock.calls[0]?.[1];
    if (!onEvent) {
      throw new Error('Expected cowork session event handler');
    }
    void onEvent({ type: 'result', is_error: false, result: 'Cancelled' });

    expect(completeChatTurnMock).not.toHaveBeenCalled();
    expect(mockHandleChatTerminalEvent).not.toHaveBeenCalled();
  });
});

describe('chat IPC chatCodexFastModeToggle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    registerChatHandlers(makeWindowAccessors());
  });

  it('validates and forwards Codex fast mode toggles', async () => {
    const session = makeMockSession();
    mockedGetSession.mockReturnValue(session);

    await getHandler(IPC_CHANNELS.chatCodexFastModeToggle)(undefined, {
      projectId: 'workspace',
      worktreeId: 'worktree',
      chatId: 'chat',
      enabled: true,
    });

    expect(mockedValidateId).toHaveBeenCalledWith('workspace', 'projectId');
    expect(mockedValidateId).toHaveBeenCalledWith('worktree', 'worktreeId');
    expect(mockedValidateId).toHaveBeenCalledWith('chat', 'chatId');
    expect(updateQueuedHookChatCodexFastModeMock).toHaveBeenCalledWith({
      projectId: 'workspace',
      worktreeId: 'worktree',
      chatId: 'chat',
      enabled: true,
    });
    expect(mockedGetSession).toHaveBeenCalledWith(
      'workspace',
      'worktree',
      'chat',
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(session.setCodexFastMode).toHaveBeenCalledWith(true);
  });

  it('forwards an exact Codex speed to queued hook chats and the live session', async () => {
    const setSpeed = jest.fn().mockResolvedValue(undefined);
    const session = { ...makeMockSession(), setSpeed };
    mockedGetSession.mockReturnValue(session);

    await getHandler(IPC_CHANNELS.chatCodexFastModeToggle)(undefined, {
      projectId: 'workspace',
      worktreeId: 'worktree',
      chatId: 'chat',
      enabled: false,
      speed: 'ultrafast',
    });

    expect(updateQueuedHookChatCodexFastModeMock).toHaveBeenCalledWith({
      projectId: 'workspace',
      worktreeId: 'worktree',
      chatId: 'chat',
      enabled: false,
      speed: 'ultrafast',
    });
    expect(setSpeed).toHaveBeenCalledWith('ultrafast');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(session.setCodexFastMode).not.toHaveBeenCalled();
  });

  it('keeps an Ultra fast choice without downgrading a session that cannot run it', async () => {
    const session = makeMockSession();
    mockedGetSession.mockReturnValue(session);

    await getHandler(IPC_CHANNELS.chatCodexFastModeToggle)(undefined, {
      projectId: 'workspace',
      worktreeId: 'worktree',
      chatId: 'chat',
      enabled: false,
      speed: 'ultrafast',
    });

    expect(updateQueuedHookChatCodexFastModeMock).toHaveBeenCalledWith(
      expect.objectContaining({ speed: 'ultrafast' }),
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(session.setCodexFastMode).not.toHaveBeenCalled();
  });

  it.each([
    [{ enabled: false, speed: 'turbo' }, 'Codex speed is unsupported'],
    [
      { enabled: true, speed: 'ultrafast' },
      'Codex fast mode enabled contradicts the speed',
    ],
  ])(
    'rejects an invalid Codex speed toggle %j before any update',
    async (toggle, message) => {
      await expect(
        getHandler(IPC_CHANNELS.chatCodexFastModeToggle)(undefined, {
          projectId: 'workspace',
          worktreeId: 'worktree',
          chatId: 'chat',
          ...toggle,
        }),
      ).rejects.toThrow(message);

      expect(updateQueuedHookChatCodexFastModeMock).not.toHaveBeenCalled();
      expect(mockedGetSession).not.toHaveBeenCalled();
    },
  );

  it('commits overlapping speed toggles in the order they were requested', async () => {
    // The first toggle's settings read stalls, so an unserialized second
    // toggle would commit first and the older speed would win.
    let releaseFirstRead = (): void => {};
    const firstRead = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    mockGetCompatibilityTabs.mockImplementationOnce(async (scope) => {
      await firstRead;
      return mockReadChatTabsFile(scope.projectId, scope.worktreeId);
    });

    const toggle = getHandler(IPC_CHANNELS.chatCodexFastModeToggle);
    const first = toggle(undefined, {
      projectId: 'workspace',
      worktreeId: 'worktree',
      chatId: 'chat',
      enabled: true,
      speed: 'fast',
    });
    const second = toggle(undefined, {
      projectId: 'workspace',
      worktreeId: 'worktree',
      chatId: 'chat',
      enabled: false,
      speed: 'standard',
    });
    await new Promise((resolve) => setImmediate(resolve));
    releaseFirstRead();
    await Promise.all([first, second]);

    const isRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null;
    const committedSpeeds = mockChatStateCommand.mock.calls.map(
      ([envelope]) => {
        const command = isRecord(envelope) ? envelope['command'] : undefined;
        const patch = isRecord(command) ? command['patch'] : undefined;
        const modelConfig = isRecord(patch) ? patch['modelConfig'] : undefined;
        return isRecord(modelConfig) ? modelConfig['speed'] : undefined;
      },
    );
    expect(committedSpeeds).toEqual(['fast', 'standard']);
  });

  it('rejects non-boolean Codex fast mode toggle values', async () => {
    await expect(
      getHandler(IPC_CHANNELS.chatCodexFastModeToggle)(undefined, {
        projectId: 'workspace',
        worktreeId: 'worktree',
        chatId: 'chat',
        enabled: 'yes',
      }),
    ).rejects.toThrow('Codex fast mode enabled must be a boolean');

    expect(updateQueuedHookChatCodexFastModeMock).not.toHaveBeenCalled();
    expect(mockedGetSession).not.toHaveBeenCalled();
  });
});

describe('chat IPC planModeToggle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    registerChatHandlers(makeWindowAccessors());
  });

  it('marks active worktree sessions for recreation after a plan-mode toggle', async () => {
    const session = makeMockSession();
    mockedGetSession.mockReturnValue(session);

    await getHandler(IPC_CHANNELS.planModeToggle)(undefined, {
      projectId: 'workspace',
      worktreeId: 'worktree',
      chatId: 'chat',
      enabled: true,
    });

    expect(mockedGetSession).toHaveBeenCalledWith(
      'workspace',
      'worktree',
      'chat',
    );
    expect(mockClaudeTerminalSetPlanMode).toHaveBeenCalledWith(
      'workspace',
      'worktree',
      'chat',
      true,
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(session.setPlanMode).toHaveBeenCalledWith(true);
    expect(mockedMarkSessionForNextTurnRecreation).toHaveBeenCalledWith(
      'workspace',
      'worktree',
      'chat',
    );
  });

  it('does not mark standalone chat sessions for recreation on plan-mode toggle', async () => {
    const session = makeMockSession();
    mockedGetSession.mockReturnValue(session);

    await getHandler(IPC_CHANNELS.planModeToggle)(undefined, {
      projectId: STANDALONE_CHAT_PROJECT_ID,
      worktreeId: 'history',
      chatId: 'chat',
      enabled: false,
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(session.setPlanMode).toHaveBeenCalledWith(false);
    expect(mockedMarkSessionForNextTurnRecreation).not.toHaveBeenCalled();
  });

  it('updates terminal plan mode even without a native session', async () => {
    mockedGetSession.mockReturnValue(undefined);

    await getHandler(IPC_CHANNELS.planModeToggle)(undefined, {
      projectId: 'workspace',
      worktreeId: 'worktree',
      chatId: 'terminal-chat',
      enabled: true,
    });

    expect(mockClaudeTerminalSetPlanMode).toHaveBeenCalledWith(
      'workspace',
      'worktree',
      'terminal-chat',
      true,
    );
  });
});

describe('chat IPC approval mode propagation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApprovalDefaultIntentGenerations.clear();
    mockCommittedApprovalDefaultIntentGenerations.clear();
    mockReadPreferencesFile.mockResolvedValue({
      approvalDefaults: {
        worktree: 'full-access',
        cowork: 'full-access',
        appAdvisor: 'full-access',
      },
    });
    mockPeekPreferencesLoadError.mockReturnValue(null);
    // By default nothing else writes while we are queued, so the state the
    // updater is handed matches what the caller read.
    queuedPreferencesState = {
      approvalDefaults: {
        worktree: 'full-access',
        cowork: 'full-access',
        appAdvisor: 'full-access',
      },
    };
    mockUpdatePreferencesFile.mockImplementation((updater) =>
      Promise.resolve(updater(queuedPreferencesState)),
    );
    mockResolveApprovalProjectId.mockImplementation(
      (projectId: string): string | undefined => projectId,
    );
    mockSurfaceForChat.mockReturnValue('worktree');
    registerChatHandlers(makeWindowAccessors());
    registerApprovalHandlers();
  });

  afterEach(() => {
    // Restore the file-wide default (no implementation) so later describes
    // keep seeing an unconfigured preferences read.
    mockReadPreferencesFile.mockReset();
  });

  /**
   * CAN-3083: a widening re-runs the policy for prompts already on screen.
   * Enrols a fake handle for the chat and records when it was asked, so the
   * *ordering* guarantees can be asserted rather than just the call.
   */
  function enrolPendingApprovalRecorder(
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): {
    modes: ApprovalMode[];
    previousModes: Array<ApprovalMode | undefined>;
    liveModeWhenCalled: Array<ApprovalMode | undefined>;
    terminalCallsWhenCalled: number[];
  } {
    const modes: ApprovalMode[] = [];
    const previousModes: Array<ApprovalMode | undefined> = [];
    const liveModeWhenCalled: Array<ApprovalMode | undefined> = [];
    const terminalCallsWhenCalled: number[] = [];
    registerApprovalSession(projectId, worktreeId, chatId, {
      reevaluatePendingApprovals: (mode, previousMode): Promise<void> => {
        modes.push(mode);
        previousModes.push(previousMode);
        liveModeWhenCalled.push(
          getLiveApprovalMode(projectId, worktreeId, chatId),
        );
        terminalCallsWhenCalled.push(
          mockClaudeTerminalSetApprovalMode.mock.calls.length,
        );
        return Promise.resolve();
      },
    });
    return {
      modes,
      previousModes,
      liveModeWhenCalled,
      terminalCallsWhenCalled,
    };
  }

  it('re-evaluates pending approvals only after the live registry and terminal service accepted the widening', async () => {
    mockedGetSession.mockReturnValue(undefined);
    resetApprovalSessionRegistryForTests();
    setLiveApprovalMode('workspace-widen', 'worktree', 'terminal-chat', 'ask');
    const recorder = enrolPendingApprovalRecorder(
      'workspace-widen',
      'worktree',
      'terminal-chat',
    );

    await getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
      projectId: 'workspace-widen',
      worktreeId: 'worktree',
      chatId: 'terminal-chat',
      mode: 'full-access',
      previousMode: 'ask',
    });

    expect(recorder.modes).toEqual(['full-access']);
    // The handle's own `mode` is already `full-access` by now (every runtime
    // owner was updated above), so the pre-widening mode has to travel with
    // the broadcast or `previousMode` is unreportable.
    expect(recorder.previousModes).toEqual(['ask']);
    // The clamp inside the handle reads the live registry, so it must already
    // hold the widened mode by the time we dispatch.
    expect(recorder.liveModeWhenCalled).toEqual(['full-access']);
    // And the terminal service must already have accepted it.
    expect(recorder.terminalCallsWhenCalled[0]).toBeGreaterThan(0);
    clearLiveApprovalMode('workspace-widen', 'worktree', 'terminal-chat');
    resetApprovalSessionRegistryForTests();
  });

  it('never re-evaluates pending approvals when the escalation rolls back', async () => {
    // The rollback means "the escalation did not take effect". Auto-approving
    // would have granted authority the system then withdrew - after the tool
    // had already run.
    const session = makeMockSession();
    mockedGetSession.mockReturnValue(session);
    resetApprovalSessionRegistryForTests();
    setLiveApprovalMode(
      'workspace-widen-rollback',
      'worktree',
      'terminal-chat',
      'ask',
    );
    const recorder = enrolPendingApprovalRecorder(
      'workspace-widen-rollback',
      'worktree',
      'terminal-chat',
    );
    mockClaudeTerminalSetApprovalMode
      .mockRejectedValueOnce(new Error('terminal update failed'))
      .mockResolvedValueOnce(undefined);

    await expect(
      getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
        projectId: 'workspace-widen-rollback',
        worktreeId: 'worktree',
        chatId: 'terminal-chat',
        mode: 'full-access',
        previousMode: 'ask',
      }),
    ).rejects.toThrow('terminal update failed');

    expect(recorder.modes).toEqual([]);
    clearLiveApprovalMode(
      'workspace-widen-rollback',
      'worktree',
      'terminal-chat',
    );
    resetApprovalSessionRegistryForTests();
  });

  it('never re-evaluates pending approvals on a downgrade', async () => {
    // Restricting must leave the prompt standing; it must never auto-deny.
    mockedGetSession.mockReturnValue(undefined);
    resetApprovalSessionRegistryForTests();
    setLiveApprovalMode(
      'workspace-restrict',
      'worktree',
      'terminal-chat',
      'full-access',
    );
    const recorder = enrolPendingApprovalRecorder(
      'workspace-restrict',
      'worktree',
      'terminal-chat',
    );

    await getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
      projectId: 'workspace-restrict',
      worktreeId: 'worktree',
      chatId: 'terminal-chat',
      mode: 'ask',
      previousMode: 'full-access',
    });

    expect(recorder.modes).toEqual([]);
    clearLiveApprovalMode('workspace-restrict', 'worktree', 'terminal-chat');
    resetApprovalSessionRegistryForTests();
  });

  it('does not reject approvals.setMode when a pending re-evaluation throws', async () => {
    // A propagated rejection would make the renderer skip `applyRendererMode`
    // and desync the UI from a mode that *is* canonical. The safe fallback is
    // "the card stays up".
    mockedGetSession.mockReturnValue(undefined);
    resetApprovalSessionRegistryForTests();
    setLiveApprovalMode(
      'workspace-widen-throws',
      'worktree',
      'terminal-chat',
      'ask',
    );
    registerApprovalSession(
      'workspace-widen-throws',
      'worktree',
      'terminal-chat',
      {
        reevaluatePendingApprovals: (): Promise<void> =>
          Promise.reject(new Error('re-evaluation exploded')),
      },
    );

    await expect(
      getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
        projectId: 'workspace-widen-throws',
        worktreeId: 'worktree',
        chatId: 'terminal-chat',
        mode: 'full-access',
        previousMode: 'ask',
      }),
    ).resolves.toBeUndefined();

    clearLiveApprovalMode(
      'workspace-widen-throws',
      'worktree',
      'terminal-chat',
    );
    resetApprovalSessionRegistryForTests();
  });

  it('updates terminal approval mode even without a native session', async () => {
    mockedGetSession.mockReturnValue(undefined);

    await getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
      projectId: 'workspace',
      worktreeId: 'worktree',
      chatId: 'terminal-chat',
      mode: 'ask',
    });

    expect(mockClaudeTerminalSetApprovalMode).toHaveBeenCalledWith(
      'workspace',
      'worktree',
      'terminal-chat',
      'ask',
    );
    expect(mockChatStateCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'workspace',
        worktreeId: 'worktree',
        command: {
          type: 'chat.patch_tab_settings',
          tabId: 'terminal-chat',
          patch: { approvalMode: 'ask' },
        },
      }),
    );
  });

  it('does not activate an approval-mode escalation when the canonical commit fails', async () => {
    const session = makeMockSession();
    mockedGetSession.mockReturnValue(session);
    setLiveApprovalMode(
      'workspace-escalation',
      'worktree',
      'terminal-chat',
      'ask',
    );
    mockChatStateCommand.mockResolvedValueOnce({
      commandId: 'test',
      revision: 1,
      outcome: 'rejected',
      reason: 'persistence unavailable',
    });

    await expect(
      getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
        projectId: 'workspace-escalation',
        worktreeId: 'worktree',
        chatId: 'terminal-chat',
        mode: 'full-access',
        previousMode: 'ask',
      }),
    ).rejects.toThrow('Canonical settings patch was rejected');

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(session.setApprovalMode).not.toHaveBeenCalled();
    expect(mockClaudeTerminalSetApprovalMode).not.toHaveBeenCalled();
    expect(updateQueuedHookChatApprovalModeMock).not.toHaveBeenCalled();
    expect(
      getLiveApprovalMode('workspace-escalation', 'worktree', 'terminal-chat'),
    ).toBe('ask');
    clearLiveApprovalMode('workspace-escalation', 'worktree', 'terminal-chat');
  });

  it('rolls back an approval-mode escalation when a live runtime update fails', async () => {
    const session = makeMockSession();
    mockedGetSession.mockReturnValue(session);
    setLiveApprovalMode(
      'workspace-runtime-failure',
      'worktree',
      'terminal-chat',
      'ask',
    );
    mockClaudeTerminalSetApprovalMode
      .mockRejectedValueOnce(new Error('terminal update failed'))
      .mockResolvedValueOnce(undefined);

    await expect(
      getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
        projectId: 'workspace-runtime-failure',
        worktreeId: 'worktree',
        chatId: 'terminal-chat',
        mode: 'full-access',
        previousMode: 'ask',
      }),
    ).rejects.toThrow('terminal update failed');

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(session.setApprovalMode).toHaveBeenNthCalledWith(1, 'full-access');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(session.setApprovalMode).toHaveBeenNthCalledWith(2, 'ask');
    expect(mockClaudeTerminalSetApprovalMode).toHaveBeenNthCalledWith(
      2,
      'workspace-runtime-failure',
      'worktree',
      'terminal-chat',
      'ask',
    );
    expect(updateQueuedHookChatApprovalModeMock).toHaveBeenLastCalledWith({
      projectId: 'workspace-runtime-failure',
      worktreeId: 'worktree',
      chatId: 'terminal-chat',
      mode: 'ask',
    });
    expect(
      getLiveApprovalMode(
        'workspace-runtime-failure',
        'worktree',
        'terminal-chat',
      ),
    ).toBe('ask');
    expect(lastCanonicalChatCommand()).toMatchObject({
      patch: { approvalMode: 'ask' },
    });
    clearLiveApprovalMode(
      'workspace-runtime-failure',
      'worktree',
      'terminal-chat',
    );
  });

  it('destroys a live session before acknowledging a Full Access downgrade', async () => {
    const session = makeMockSession();
    mockedGetSession.mockReturnValue(session);
    setLiveApprovalMode(
      'workspace-downgrade',
      'worktree',
      'terminal-chat',
      'full-access',
    );

    await getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
      projectId: 'workspace-downgrade',
      worktreeId: 'worktree',
      chatId: 'terminal-chat',
      mode: 'ask',
    });

    expect(mockedDestroySession).toHaveBeenCalledWith(
      'workspace-downgrade',
      'worktree',
      'terminal-chat',
      { retainDelegations: true },
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(session.setApprovalMode).not.toHaveBeenCalled();
    expect(mockClaudeTerminalSetApprovalMode).toHaveBeenCalledWith(
      'workspace-downgrade',
      'worktree',
      'terminal-chat',
      'ask',
    );
  });

  it('destroys a restarted Full Access session when previousMode is the only authority signal', async () => {
    const session = makeMockSession();
    mockedGetSession.mockReturnValue(session);

    await getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
      projectId: 'workspace-restarted-downgrade',
      worktreeId: 'worktree',
      chatId: 'terminal-chat',
      mode: 'ask',
      previousMode: 'full-access',
    });

    expect(mockedDestroySession).toHaveBeenCalledWith(
      'workspace-restarted-downgrade',
      'worktree',
      'terminal-chat',
      { retainDelegations: true },
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(session.setApprovalMode).not.toHaveBeenCalled();
    clearLiveApprovalMode(
      'workspace-restarted-downgrade',
      'worktree',
      'terminal-chat',
    );
  });

  it('revokes Full Access before a queued approval operation releases', async () => {
    const session = makeMockSession();
    mockedGetSession.mockReturnValue(session);
    setLiveApprovalMode(
      'workspace-queued-downgrade',
      'worktree',
      'terminal-chat',
      'full-access',
    );
    let releaseOperation: (() => void) | undefined;
    const operationPaused = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    let signalOperationStarted: (() => void) | undefined;
    const operationStarted = new Promise<void>((resolve) => {
      signalOperationStarted = resolve;
    });
    const blockingOperation = withApprovalModeOperation(
      'workspace-queued-downgrade',
      'worktree',
      'terminal-chat',
      async () => {
        signalOperationStarted?.();
        await operationPaused;
      },
    );
    await operationStarted;

    let downgradeSettled = false;
    const downgrade = Promise.resolve(
      getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
        projectId: 'workspace-queued-downgrade',
        worktreeId: 'worktree',
        chatId: 'terminal-chat',
        mode: 'ask',
        previousMode: 'full-access',
      }),
    ).finally(() => {
      downgradeSettled = true;
    });
    await Promise.resolve();

    expect(
      getLiveApprovalMode(
        'workspace-queued-downgrade',
        'worktree',
        'terminal-chat',
      ),
    ).toBe('ask');
    expect(mockedDestroySession).toHaveBeenCalledWith(
      'workspace-queued-downgrade',
      'worktree',
      'terminal-chat',
      { retainDelegations: true },
    );
    expect(downgradeSettled).toBe(false);

    releaseOperation?.();
    await blockingOperation;
    await downgrade;
    clearLiveApprovalMode(
      'workspace-queued-downgrade',
      'worktree',
      'terminal-chat',
    );
  });

  it('reserves the approval queue before awaiting downgrade runtime revocation', async () => {
    const session = makeMockSession();
    mockedGetSession.mockReturnValue(session);
    setLiveApprovalMode(
      'workspace-overlapping-transition',
      'worktree',
      'terminal-chat',
      'full-access',
    );
    let releaseRuntimeRevocation: (() => void) | undefined;
    const runtimeRevocationPaused = new Promise<void>((resolve) => {
      releaseRuntimeRevocation = resolve;
    });
    mockClaudeTerminalSetApprovalMode.mockImplementation(
      (_projectId, _worktreeId, _chatId, mode) =>
        mode === 'ask' ? runtimeRevocationPaused : Promise.resolve(),
    );

    const downgrade = getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
      projectId: 'workspace-overlapping-transition',
      worktreeId: 'worktree',
      chatId: 'terminal-chat',
      mode: 'ask',
      previousMode: 'full-access',
    });
    await Promise.resolve();

    let escalationSettled = false;
    const escalation = Promise.resolve(
      getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
        projectId: 'workspace-overlapping-transition',
        worktreeId: 'worktree',
        chatId: 'terminal-chat',
        mode: 'full-access',
        previousMode: 'ask',
      }),
    ).finally(() => {
      escalationSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(escalationSettled).toBe(false);
    expect(mockChatStateCommand).not.toHaveBeenCalled();

    releaseRuntimeRevocation?.();
    await downgrade;
    await escalation;
    const canonicalCalls = mockChatStateCommand.mock.calls;
    expect(canonicalCalls[0]?.[0]).toMatchObject({
      command: {
        type: 'chat.patch_tab_settings',
        patch: { approvalMode: 'ask' },
      },
    });
    expect(canonicalCalls[1]?.[0]).toMatchObject({
      command: {
        type: 'chat.patch_tab_settings',
        patch: { approvalMode: 'full-access' },
      },
    });
    clearLiveApprovalMode(
      'workspace-overlapping-transition',
      'worktree',
      'terminal-chat',
    );
  });

  it('never publishes an in-flight escalation superseded by a restrictive request', async () => {
    const session = makeMockSession();
    mockedGetSession.mockReturnValue(session);
    setLiveApprovalMode(
      'workspace-superseded-escalation',
      'worktree',
      'terminal-chat',
      'ask',
    );
    let releaseEscalation: (() => void) | undefined;
    const escalationPaused = new Promise<void>((resolve) => {
      releaseEscalation = resolve;
    });
    let signalEscalationStarted: (() => void) | undefined;
    const escalationStarted = new Promise<void>((resolve) => {
      signalEscalationStarted = resolve;
    });
    session.setApprovalMode = jest.fn((mode) => {
      if (mode === 'full-access') {
        signalEscalationStarted?.();
        return escalationPaused;
      }
      return Promise.resolve();
    });

    const escalation = getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
      projectId: 'workspace-superseded-escalation',
      worktreeId: 'worktree',
      chatId: 'terminal-chat',
      mode: 'full-access',
      previousMode: 'ask',
    });
    await escalationStarted;

    const downgrade = getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
      projectId: 'workspace-superseded-escalation',
      worktreeId: 'worktree',
      chatId: 'terminal-chat',
      mode: 'ask',
      previousMode: 'ask',
    });
    expect(
      getLiveApprovalMode(
        'workspace-superseded-escalation',
        'worktree',
        'terminal-chat',
      ),
    ).toBe('ask');
    expect(mockedDestroySession).toHaveBeenCalledWith(
      'workspace-superseded-escalation',
      'worktree',
      'terminal-chat',
      { retainDelegations: true },
    );

    releaseEscalation?.();
    await escalation;
    await downgrade;

    expect(
      getLiveApprovalMode(
        'workspace-superseded-escalation',
        'worktree',
        'terminal-chat',
      ),
    ).toBe('ask');
    expect(lastCanonicalChatCommand()).toMatchObject({
      patch: { approvalMode: 'ask' },
    });
    expect(updateQueuedHookChatApprovalModeMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'full-access' }),
    );
    // The superseded escalation must not publish Full Access as the sticky
    // surface default. Only the later restrictive transition is remembered.
    expect(mockUpdatePreferencesFile).toHaveBeenCalledTimes(1);
    await expect(
      mockUpdatePreferencesFile.mock.results[0]?.value,
    ).resolves.toEqual({
      approvalDefaults: {
        worktree: 'ask',
        cowork: 'full-access',
        appAdvisor: 'full-access',
      },
    });
    clearLiveApprovalMode(
      'workspace-superseded-escalation',
      'worktree',
      'terminal-chat',
    );
  });

  it('does not let an older transition in another chat overwrite the latest surface choice', async () => {
    const delayedSession = makeMockSession();
    let releaseEscalation: (() => void) | undefined;
    const escalationPaused = new Promise<void>((resolve) => {
      releaseEscalation = resolve;
    });
    let signalEscalationStarted: (() => void) | undefined;
    const escalationStarted = new Promise<void>((resolve) => {
      signalEscalationStarted = resolve;
    });
    delayedSession.setApprovalMode = jest.fn((mode) => {
      if (mode === 'full-access') {
        signalEscalationStarted?.();
        return escalationPaused;
      }
      return Promise.resolve();
    });
    mockedGetSession.mockImplementation((_projectId, _worktreeId, chatId) =>
      chatId === 'chat-a' ? delayedSession : undefined,
    );
    setLiveApprovalMode('workspace-cross-chat', 'worktree', 'chat-a', 'ask');
    setLiveApprovalMode(
      'workspace-cross-chat',
      'worktree',
      'chat-b',
      'full-access',
    );
    mockUpdatePreferencesFile.mockImplementation((updater) => {
      const patch = updater(queuedPreferencesState);
      if (patch !== null) {
        queuedPreferencesState = {
          ...(queuedPreferencesState as Record<string, unknown>),
          ...(patch as Record<string, unknown>),
        };
      }
      return Promise.resolve(queuedPreferencesState);
    });

    const olderEscalation = getHandler(IPC_CHANNELS.approvalModeSet)(
      undefined,
      {
        projectId: 'workspace-cross-chat',
        worktreeId: 'worktree',
        chatId: 'chat-a',
        mode: 'full-access',
        previousMode: 'ask',
      },
    );
    await escalationStarted;

    await getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
      projectId: 'workspace-cross-chat',
      worktreeId: 'worktree',
      chatId: 'chat-b',
      mode: 'ask',
      previousMode: 'full-access',
    });
    releaseEscalation?.();
    await olderEscalation;

    expect(
      (
        queuedPreferencesState as {
          approvalDefaults: { worktree: ApprovalMode };
        }
      ).approvalDefaults.worktree,
    ).toBe('ask');
    expect(mockUpdatePreferencesFile).toHaveBeenCalledTimes(1);
    clearLiveApprovalMode('workspace-cross-chat', 'worktree', 'chat-a');
    clearLiveApprovalMode('workspace-cross-chat', 'worktree', 'chat-b');
  });

  it('remembers an older successful choice when a newer cross-chat intent fails', async () => {
    mockedGetSession.mockReturnValue(undefined);
    setLiveApprovalMode(
      'workspace-failed-newer-intent',
      'worktree',
      'chat-a',
      'full-access',
    );
    setLiveApprovalMode(
      'workspace-failed-newer-intent',
      'worktree',
      'chat-b',
      'ask',
    );
    let releaseOlderDowngrade: (() => void) | undefined;
    const olderDowngradePaused = new Promise<void>((resolve) => {
      releaseOlderDowngrade = resolve;
    });
    let signalOlderDowngradeStarted: (() => void) | undefined;
    const olderDowngradeStarted = new Promise<void>((resolve) => {
      signalOlderDowngradeStarted = resolve;
    });
    mockClaudeTerminalSetApprovalMode.mockImplementation(
      (_projectId, _worktreeId, chatId, mode) => {
        if (chatId === 'chat-a' && mode === 'ask') {
          signalOlderDowngradeStarted?.();
          return olderDowngradePaused;
        }
        if (chatId === 'chat-b' && mode === 'full-access') {
          return Promise.reject(new Error('newer transition failed'));
        }
        return Promise.resolve();
      },
    );

    const olderDowngrade = getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
      projectId: 'workspace-failed-newer-intent',
      worktreeId: 'worktree',
      chatId: 'chat-a',
      mode: 'ask',
      previousMode: 'full-access',
    });
    await olderDowngradeStarted;

    await expect(
      getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
        projectId: 'workspace-failed-newer-intent',
        worktreeId: 'worktree',
        chatId: 'chat-b',
        mode: 'full-access',
        previousMode: 'ask',
      }),
    ).rejects.toThrow('newer transition failed');

    releaseOlderDowngrade?.();
    await olderDowngrade;

    expect(mockUpdatePreferencesFile).toHaveBeenCalledTimes(1);
    await expect(
      mockUpdatePreferencesFile.mock.results[0]?.value,
    ).resolves.toEqual({
      approvalDefaults: {
        worktree: 'ask',
        cowork: 'full-access',
        appAdvisor: 'full-access',
      },
    });
    clearLiveApprovalMode(
      'workspace-failed-newer-intent',
      'worktree',
      'chat-a',
    );
    clearLiveApprovalMode(
      'workspace-failed-newer-intent',
      'worktree',
      'chat-b',
    );
  });

  it('does not roll a failed escalation back over a newer revocation', async () => {
    const session = makeMockSession();
    mockedGetSession.mockReturnValue(session);
    setLiveApprovalMode(
      'workspace-superseded-rollback',
      'worktree',
      'terminal-chat',
      'auto',
    );
    let rejectEscalation: ((error: Error) => void) | undefined;
    const escalationPaused = new Promise<void>((_resolve, reject) => {
      rejectEscalation = reject;
    });
    let signalEscalationStarted: (() => void) | undefined;
    const escalationStarted = new Promise<void>((resolve) => {
      signalEscalationStarted = resolve;
    });
    session.setApprovalMode = jest.fn((mode) => {
      if (mode === 'full-access') {
        signalEscalationStarted?.();
        return escalationPaused;
      }
      return Promise.resolve();
    });

    const escalation = getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
      projectId: 'workspace-superseded-rollback',
      worktreeId: 'worktree',
      chatId: 'terminal-chat',
      mode: 'full-access',
      previousMode: 'auto',
    });
    await escalationStarted;

    const downgrade = getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
      projectId: 'workspace-superseded-rollback',
      worktreeId: 'worktree',
      chatId: 'terminal-chat',
      mode: 'ask',
      previousMode: 'auto',
    });
    rejectEscalation?.(new Error('stale escalation failed'));

    await expect(escalation).rejects.toThrow('stale escalation failed');
    await downgrade;

    expect(
      getLiveApprovalMode(
        'workspace-superseded-rollback',
        'worktree',
        'terminal-chat',
      ),
    ).toBe('ask');
    expect(updateQueuedHookChatApprovalModeMock).toHaveBeenLastCalledWith({
      projectId: 'workspace-superseded-rollback',
      worktreeId: 'worktree',
      chatId: 'terminal-chat',
      mode: 'ask',
    });
    clearLiveApprovalMode(
      'workspace-superseded-rollback',
      'worktree',
      'terminal-chat',
    );
  });

  it('reapplies a newer restriction after a stale session escalation resolves', async () => {
    const session = makeMockSession();
    mockedGetSession.mockReturnValue(session);
    setLiveApprovalMode(
      'workspace-stale-session-escalation',
      'worktree',
      'terminal-chat',
      'ask',
    );
    let releaseEscalation: (() => void) | undefined;
    const escalationPaused = new Promise<void>((resolve) => {
      releaseEscalation = resolve;
    });
    let signalEscalationStarted: (() => void) | undefined;
    const escalationStarted = new Promise<void>((resolve) => {
      signalEscalationStarted = resolve;
    });
    let effectiveSessionMode = 'ask';
    const setSessionApprovalMode = jest.fn(async (mode: ApprovalMode) => {
      if (mode === 'auto') {
        signalEscalationStarted?.();
        await escalationPaused;
      }
      effectiveSessionMode = mode;
    });
    session.setApprovalMode = setSessionApprovalMode;

    const escalation = getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
      projectId: 'workspace-stale-session-escalation',
      worktreeId: 'worktree',
      chatId: 'terminal-chat',
      mode: 'auto',
      previousMode: 'ask',
    });
    await escalationStarted;

    const downgrade = getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
      projectId: 'workspace-stale-session-escalation',
      worktreeId: 'worktree',
      chatId: 'terminal-chat',
      mode: 'ask',
      previousMode: 'ask',
    });
    await Promise.resolve();
    expect(effectiveSessionMode).toBe('ask');

    releaseEscalation?.();
    await escalation;
    await downgrade;

    expect(effectiveSessionMode).toBe('ask');
    expect(setSessionApprovalMode).toHaveBeenLastCalledWith('ask');
    clearLiveApprovalMode(
      'workspace-stale-session-escalation',
      'worktree',
      'terminal-chat',
    );
  });

  it('does not publish a partial escalation merely because it cancels a larger pending escalation', async () => {
    const session = makeMockSession();
    mockedGetSession.mockReturnValue(session);
    setLiveApprovalMode(
      'workspace-partial-escalation',
      'worktree',
      'terminal-chat',
      'ask',
    );
    let releaseFullAccess: (() => void) | undefined;
    const fullAccessPaused = new Promise<void>((resolve) => {
      releaseFullAccess = resolve;
    });
    let signalFullAccessStarted: (() => void) | undefined;
    const fullAccessStarted = new Promise<void>((resolve) => {
      signalFullAccessStarted = resolve;
    });
    session.setApprovalMode = jest.fn((mode) => {
      if (mode === 'full-access') {
        signalFullAccessStarted?.();
        return fullAccessPaused;
      }
      return Promise.resolve();
    });

    const fullAccess = getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
      projectId: 'workspace-partial-escalation',
      worktreeId: 'worktree',
      chatId: 'terminal-chat',
      mode: 'full-access',
      previousMode: 'ask',
    });
    await fullAccessStarted;

    const auto = getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
      projectId: 'workspace-partial-escalation',
      worktreeId: 'worktree',
      chatId: 'terminal-chat',
      mode: 'auto',
      previousMode: 'ask',
    });
    expect(
      getLiveApprovalMode(
        'workspace-partial-escalation',
        'worktree',
        'terminal-chat',
      ),
    ).toBe('ask');

    releaseFullAccess?.();
    await fullAccess;
    await auto;

    expect(
      getLiveApprovalMode(
        'workspace-partial-escalation',
        'worktree',
        'terminal-chat',
      ),
    ).toBe('auto');
    clearLiveApprovalMode(
      'workspace-partial-escalation',
      'worktree',
      'terminal-chat',
    );
  });

  it('normalizes a non-Error downgrade runtime rejection', async () => {
    mockedGetSession.mockReturnValue(undefined);
    setLiveApprovalMode(
      'workspace-non-error-rejection',
      'worktree',
      'terminal-chat',
      'full-access',
    );
    mockClaudeTerminalSetApprovalMode.mockRejectedValueOnce('terminal failed');

    const result = getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
      projectId: 'workspace-non-error-rejection',
      worktreeId: 'worktree',
      chatId: 'terminal-chat',
      mode: 'ask',
      previousMode: 'full-access',
    });
    await expect(result).rejects.toBeInstanceOf(Error);
    await expect(result).rejects.toThrow('terminal failed');
    clearLiveApprovalMode(
      'workspace-non-error-rejection',
      'worktree',
      'terminal-chat',
    );
  });

  it('keeps a failed Full Access downgrade restricted in the live registry', async () => {
    const session = makeMockSession();
    mockedGetSession.mockReturnValue(session);
    setLiveApprovalMode(
      'workspace-failed-downgrade',
      'worktree',
      'terminal-chat',
      'full-access',
    );
    mockChatStateCommand.mockResolvedValueOnce({
      commandId: 'test',
      revision: 1,
      outcome: 'rejected',
      reason: 'persistence unavailable',
    });

    await expect(
      getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
        projectId: 'workspace-failed-downgrade',
        worktreeId: 'worktree',
        chatId: 'terminal-chat',
        mode: 'ask',
        previousMode: 'full-access',
      }),
    ).rejects.toThrow('Canonical settings patch was rejected');

    expect(mockedDestroySession).toHaveBeenCalledWith(
      'workspace-failed-downgrade',
      'worktree',
      'terminal-chat',
      { retainDelegations: true },
    );
    expect(
      getLiveApprovalMode(
        'workspace-failed-downgrade',
        'worktree',
        'terminal-chat',
      ),
    ).toBe('ask');
    clearLiveApprovalMode(
      'workspace-failed-downgrade',
      'worktree',
      'terminal-chat',
    );
  });

  // CAN-3055: an in-chat mode change is remembered as that surface's default.
  // The write-back is deliberately symmetric, so both directions are covered:
  // this de-escalation, and the escalation case immediately below it.
  it('remembers the new mode as the surface default', async () => {
    mockedGetSession.mockReturnValue(undefined);

    await getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
      projectId: 'workspace-sticky',
      worktreeId: 'worktree',
      chatId: 'chat',
      mode: 'ask',
    });

    expect(mockUpdatePreferencesFile).toHaveBeenCalledTimes(1);
    await expect(
      mockUpdatePreferencesFile.mock.results[0]?.value,
    ).resolves.toEqual({
      approvalDefaults: {
        worktree: 'ask',
        cowork: 'full-access',
        appAdvisor: 'full-access',
      },
    });
    expect(mockBroadcastPreferencesSynced).toHaveBeenCalledTimes(1);
  });

  it('remembers an escalation to Full Access just as it remembers a downgrade', async () => {
    mockedGetSession.mockReturnValue(undefined);
    // Start from a surface that the user had previously moved down to Ask.
    mockReadPreferencesFile.mockResolvedValue({
      approvalDefaults: {
        worktree: 'ask',
        cowork: 'ask',
        appAdvisor: 'ask',
      },
    });
    // Nothing else writes in between, so the queue re-reads the same state.
    queuedPreferencesState = {
      approvalDefaults: {
        worktree: 'ask',
        cowork: 'ask',
        appAdvisor: 'ask',
      },
    };

    await getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
      projectId: 'workspace-escalate',
      worktreeId: 'worktree',
      chatId: 'chat',
      mode: 'full-access',
    });

    expect(mockUpdatePreferencesFile).toHaveBeenCalledTimes(1);
    await expect(
      mockUpdatePreferencesFile.mock.results[0]?.value,
    ).resolves.toEqual({
      approvalDefaults: {
        worktree: 'full-access',
        cowork: 'ask',
        appAdvisor: 'ask',
      },
    });
    expect(mockBroadcastPreferencesSynced).toHaveBeenCalledTimes(1);
  });

  // CAN-3055 regression: the persisted object must be built from the state the
  // write queue hands the updater, NOT from the caller's earlier
  // `readPreferencesFile()` snapshot. Otherwise a Settings save (or another
  // surface's write-back) that lands in between is silently clobbered, because
  // `updatePreferencesFile` merges shallowly at the top level.
  it('builds the patch from the queue-fresh state, not the pre-read snapshot', async () => {
    mockedGetSession.mockReturnValue(undefined);
    // What this handler saw before queueing.
    mockReadPreferencesFile.mockResolvedValue({
      approvalDefaults: {
        worktree: 'full-access',
        cowork: 'full-access',
        appAdvisor: 'full-access',
      },
    });
    // What a concurrent Settings save committed while we were queued: the user
    // moved cowork and appAdvisor down to Ask.
    queuedPreferencesState = {
      approvalDefaults: {
        worktree: 'full-access',
        cowork: 'ask',
        appAdvisor: 'ask',
      },
    };

    await getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
      projectId: 'workspace-concurrent',
      worktreeId: 'worktree',
      chatId: 'chat',
      mode: 'ask',
    });

    expect(mockUpdatePreferencesFile).toHaveBeenCalledTimes(1);
    await expect(
      mockUpdatePreferencesFile.mock.results[0]?.value,
    ).resolves.toEqual({
      // Only the worktree key this handler owns may change; the concurrent
      // cowork/appAdvisor downgrades must survive.
      approvalDefaults: {
        worktree: 'ask',
        cowork: 'ask',
        appAdvisor: 'ask',
      },
    });
  });

  it('does not let a stale pre-read skip a later same-surface choice', async () => {
    mockedGetSession.mockReturnValue(undefined);
    // The outside-queue snapshot already matches the user's later chat choice.
    mockReadPreferencesFile.mockResolvedValue({
      approvalDefaults: {
        worktree: 'ask',
        cowork: 'full-access',
        appAdvisor: 'full-access',
      },
    });
    // A Settings change was queued first and commits Full Access before the
    // chat write-back reaches the serialized updater. The later chat choice
    // must win for this same surface.
    queuedPreferencesState = {
      approvalDefaults: {
        worktree: 'full-access',
        cowork: 'full-access',
        appAdvisor: 'full-access',
      },
    };

    await getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
      projectId: 'workspace-same-surface-order',
      worktreeId: 'worktree',
      chatId: 'chat',
      mode: 'ask',
    });

    expect(mockUpdatePreferencesFile).toHaveBeenCalledTimes(1);
    await expect(
      mockUpdatePreferencesFile.mock.results[0]?.value,
    ).resolves.toEqual({
      approvalDefaults: {
        worktree: 'ask',
        cowork: 'full-access',
        appAdvisor: 'full-access',
      },
    });
  });

  it('registers the surface write before waiting for the preference queue', async () => {
    mockedGetSession.mockReturnValue(undefined);
    mockUpdatePreferencesFile.mockImplementationOnce((updater) => {
      expect(mockBeginPendingApprovalDefaultWrite).toHaveBeenCalledWith(
        'worktree',
      );
      return Promise.resolve(updater(queuedPreferencesState));
    });

    await getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
      projectId: 'workspace-queued-barrier',
      worktreeId: 'worktree',
      chatId: 'chat',
      mode: 'ask',
    });

    expect(mockBeginPendingApprovalDefaultWrite).toHaveBeenCalledTimes(1);
    expect(mockEndPendingApprovalDefaultWrite).toHaveBeenCalledTimes(1);
  });

  it('writes the cowork surface key for a cowork chat', async () => {
    mockedGetSession.mockReturnValue(undefined);
    mockSurfaceForChat.mockReturnValue('cowork');

    await getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
      projectId: 'cowork-workspace',
      worktreeId: 'entry',
      chatId: 'chat',
      mode: 'auto',
    });

    await expect(
      mockUpdatePreferencesFile.mock.results[0]?.value,
    ).resolves.toEqual({
      approvalDefaults: {
        worktree: 'full-access',
        cowork: 'auto',
        appAdvisor: 'full-access',
      },
    });
  });

  it('writes the App Advisor surface key for an App Advisor chat', async () => {
    mockedGetSession.mockReturnValue(undefined);
    mockSurfaceForChat.mockReturnValue('app-advisor');

    await getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
      projectId: 'app-advisor',
      worktreeId: 'entry',
      chatId: 'chat',
      mode: 'ask',
    });

    await expect(
      mockUpdatePreferencesFile.mock.results[0]?.value,
    ).resolves.toEqual({
      approvalDefaults: {
        worktree: 'full-access',
        cowork: 'full-access',
        appAdvisor: 'ask',
      },
    });
  });

  // Uses the legacy-cowork sentinel rather than code-review/plan-explore: the
  // latter two are ephemeral scratch surfaces that skip the write-back
  // entirely (covered separately below), while legacy cowork maps to a real
  // workspace the user owns and must still classify through the sentinel.
  it('classifies the surface from the sentinel-mapped owning workspace', async () => {
    mockedGetSession.mockReturnValue(undefined);
    mockResolveApprovalProjectId.mockReturnValue('owning-workspace');

    await getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
      projectId: 'standalone-chat',
      worktreeId: 'cowork-entry',
      chatId: 'chat',
      mode: 'ask',
    });

    expect(mockResolveApprovalProjectId).toHaveBeenCalledWith(
      'standalone-chat',
      'cowork-entry',
    );
    expect(mockSurfaceForChat).toHaveBeenCalledWith('owning-workspace');
    expect(mockUpdatePreferencesFile).toHaveBeenCalledTimes(1);
  });

  // CAN-3055: code-review and plan-explore chats are ephemeral Canopy-owned
  // scratch surfaces that resolve to their OWNING worktree's projectId. Letting
  // them write back would repoint the default for every worktree chat from
  // inside a throwaway side chat.
  it('builds the persisted patch only from the queue-fresh state', async () => {
    mockedGetSession.mockReturnValue(undefined);
    mockReadPreferencesFile.mockResolvedValue({
      approvalDefaults: {
        worktree: 'full-access',
        cowork: 'full-access',
        appAdvisor: 'full-access',
      },
    });
    // A Settings save committed a cowork downgrade while we were queued.
    queuedPreferencesState = {
      approvalDefaults: {
        worktree: 'full-access',
        cowork: 'ask',
        appAdvisor: 'full-access',
      },
    };

    await getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
      projectId: 'workspace-pending',
      worktreeId: 'worktree',
      chatId: 'chat',
      mode: 'ask',
    });

    await expect(
      mockUpdatePreferencesFile.mock.results[0]?.value,
    ).resolves.toEqual({
      approvalDefaults: {
        worktree: 'ask',
        cowork: 'ask',
        appAdvisor: 'full-access',
      },
    });
  });

  // CAN-3055 round 2/4: a write-back derived from a file we could not read is
  // not a user choice and must not become durable global policy. The guard
  // runs inside the updater so it observes the authoritative queued read.
  it('skips the write-back when the preferences read was degraded', async () => {
    mockedGetSession.mockReturnValue(undefined);
    mockPeekPreferencesLoadError.mockReturnValue({
      stage: 'parse',
      message: 'Preferences file is corrupt.',
    });

    await getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
      projectId: 'workspace-degraded',
      worktreeId: 'worktree',
      chatId: 'chat',
      mode: 'ask',
    });

    expect(mockUpdatePreferencesFile).toHaveBeenCalledTimes(1);
    await expect(
      mockUpdatePreferencesFile.mock.results[0]?.value,
    ).resolves.toBeNull();
    expect(mockBroadcastPreferencesSynced).not.toHaveBeenCalled();
    // The per-chat change the user asked for still happened.
    expect(mockClaudeTerminalSetApprovalMode).toHaveBeenCalled();
  });

  it('skips the write-back for an ephemeral sentinel surface', async () => {
    mockedGetSession.mockReturnValue(undefined);
    mockResolveApprovalProjectId.mockReturnValue('owning-workspace');

    await getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
      projectId: 'code-review-chat',
      worktreeId: 'review-scope',
      chatId: 'chat',
      mode: 'ask',
    });

    expect(mockUpdatePreferencesFile).not.toHaveBeenCalled();
    expect(mockBroadcastPreferencesSynced).not.toHaveBeenCalled();
    // The per-chat change still happened.
    expect(mockClaudeTerminalSetApprovalMode).toHaveBeenCalled();
  });

  // CAN-3055: `mode` now reaches durable GLOBAL policy via the write-back, and
  // `normalizeApprovalDefaults` falls back per key to the Full Access product
  // default rather than to the previously persisted value. An unvalidated
  // `mode` would therefore silently escalate a user's persisted Ask.
  it('rejects an invalid approval mode instead of persisting it', async () => {
    mockedGetSession.mockReturnValue(undefined);

    await expect(
      getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
        projectId: 'workspace-invalid',
        worktreeId: 'worktree',
        chatId: 'chat',
        mode: 'not-a-mode',
      }),
    ).rejects.toThrow(/mode/i);

    expect(mockUpdatePreferencesFile).not.toHaveBeenCalled();
    expect(mockClaudeTerminalSetApprovalMode).not.toHaveBeenCalled();
  });

  it('skips the write-back when the owning project cannot be resolved', async () => {
    mockedGetSession.mockReturnValue(undefined);
    mockResolveApprovalProjectId.mockReturnValue(undefined);

    await getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
      projectId: 'code-review-chat',
      worktreeId: 'missing-scope',
      chatId: 'chat',
      mode: 'ask',
    });

    expect(mockUpdatePreferencesFile).not.toHaveBeenCalled();
    expect(mockBroadcastPreferencesSynced).not.toHaveBeenCalled();
    // The per-chat change still happened.
    expect(mockClaudeTerminalSetApprovalMode).toHaveBeenCalled();
  });

  it('skips the write-back when the surface default already matches', async () => {
    mockedGetSession.mockReturnValue(undefined);

    await getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
      projectId: 'workspace-noop',
      worktreeId: 'worktree',
      chatId: 'chat',
      mode: 'full-access',
    });

    expect(mockUpdatePreferencesFile).toHaveBeenCalledTimes(1);
    await expect(
      mockUpdatePreferencesFile.mock.results[0]?.value,
    ).resolves.toBeNull();
    expect(mockBroadcastPreferencesSynced).not.toHaveBeenCalled();
  });

  it('does not remember the mode when a rolled-back escalation fails', async () => {
    const session = makeMockSession();
    mockedGetSession.mockReturnValue(session);
    setLiveApprovalMode(
      'workspace-rollback-sticky',
      'worktree',
      'terminal-chat',
      'ask',
    );
    mockClaudeTerminalSetApprovalMode
      .mockRejectedValueOnce(new Error('terminal update failed'))
      .mockResolvedValueOnce(undefined);

    await expect(
      getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
        projectId: 'workspace-rollback-sticky',
        worktreeId: 'worktree',
        chatId: 'terminal-chat',
        mode: 'ask',
        previousMode: 'full-access',
      }),
    ).rejects.toThrow('terminal update failed');

    expect(mockUpdatePreferencesFile).not.toHaveBeenCalled();
    clearLiveApprovalMode(
      'workspace-rollback-sticky',
      'worktree',
      'terminal-chat',
    );
  });

  it('keeps the per-chat change applied when the preference write fails', async () => {
    mockedGetSession.mockReturnValue(undefined);
    mockUpdatePreferencesFile.mockRejectedValueOnce(
      new Error('preferences unavailable'),
    );
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation((): void => {});

    await expect(
      getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
        projectId: 'workspace-write-failure',
        worktreeId: 'worktree',
        chatId: 'chat',
        mode: 'ask',
      }),
    ).resolves.toBeUndefined();

    expect(mockClaudeTerminalSetApprovalMode).toHaveBeenCalledWith(
      'workspace-write-failure',
      'worktree',
      'chat',
      'ask',
    );
    expect(mockEndPendingApprovalDefaultWrite).toHaveBeenCalledTimes(1);
    expect(mockBroadcastPreferencesSynced).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('releases the surface barrier when the write fails after the updater ran', async () => {
    mockedGetSession.mockReturnValue(undefined);
    mockUpdatePreferencesFile.mockImplementationOnce(
      (updater: (previous: unknown) => unknown): Promise<unknown> => {
        updater(queuedPreferencesState);
        return Promise.reject(new Error('disk write failed'));
      },
    );
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation((): void => {});

    await expect(
      getHandler(IPC_CHANNELS.approvalModeSet)(undefined, {
        projectId: 'workspace-late-write-failure',
        worktreeId: 'worktree',
        chatId: 'chat',
        mode: 'ask',
      }),
    ).resolves.toBeUndefined();

    expect(mockEndPendingApprovalDefaultWrite).toHaveBeenCalledTimes(1);
    expect(mockBroadcastPreferencesSynced).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe('chat IPC settings handlers commit canonical tab patches', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCursorConnectionStatus.mockReset().mockResolvedValue({
      supported: true,
      installed: true,
      enabled: true,
      version: 'test',
      phase: 'connected',
    });
    mockGetCompatibilityTabs.mockResolvedValue({
      version: 1,
      tabs: [
        {
          id: 'chat',
          title: 'Chat',
          createdAt: '2026-08-01T00:00:00.000Z',
          messages: [],
          providerType: 'claude',
          modelConfig: { thinkingLevel: 'low', fastMode: false },
          thinkingLevel: 'low',
          interfaceMode: 'claude-code',
        },
      ],
      activeTabId: 'chat',
    });
    mockedReadPreferencesFile.mockResolvedValue(
      makePreferences({
        defaultWorktreeModelByProvider: {
          claude: {
            model: 'claude-sonnet-4-6',
            thinkingLevel: 'high',
          },
          codex: { model: 'gpt-5.5', thinkingLevel: 'max' },
          ollama: null,
        },
        providerModelConfigDefaults: { codex: { fastMode: true } },
      }),
    );
    registerChatHandlers(makeWindowAccessors());
  });

  function isSettingsRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  function patchCommands(): unknown[] {
    const commands: unknown[] = [];
    for (const call of mockChatStateCommand.mock.calls) {
      const envelope: unknown = call[0];
      if (!isSettingsRecord(envelope)) continue;
      const command = envelope['command'];
      if (
        isSettingsRecord(command) &&
        command['type'] === 'chat.patch_tab_settings'
      ) {
        commands.push(command);
      } else if (
        isSettingsRecord(command) &&
        command['type'] === 'chat.set_model' &&
        isSettingsRecord(command['settings'])
      ) {
        commands.push({
          type: 'chat.patch_tab_settings',
          tabId: command['tabId'],
          patch: {
            modelExplicitlyChosen: true,
            ...command['settings'],
          },
        });
      }
    }
    return commands;
  }

  function modelCommands(): unknown[] {
    const commands: unknown[] = [];
    for (const call of mockChatStateCommand.mock.calls) {
      const envelope: unknown = call[0];
      if (!isSettingsRecord(envelope)) continue;
      const command = envelope['command'];
      if (isSettingsRecord(command) && command['type'] === 'chat.set_model') {
        commands.push(command);
      }
    }
    return commands;
  }

  it('plan-mode toggle commits the durable planMode patch', async () => {
    await getHandler(IPC_CHANNELS.planModeToggle)(undefined, {
      projectId: 'workspace',
      worktreeId: 'worktree',
      chatId: 'chat',
      enabled: true,
    });

    expect(patchCommands()).toEqual([
      expect.objectContaining({
        type: 'chat.patch_tab_settings',
        tabId: 'chat',
        patch: { planMode: true },
      }),
    ]);
  });

  it('thinking-level toggle commits the merged modelConfig patch', async () => {
    await getHandler(IPC_CHANNELS.thinkingLevelToggle)(undefined, {
      projectId: 'workspace',
      worktreeId: 'worktree',
      chatId: 'chat',
      level: 'high',
    });

    expect(patchCommands()).toEqual([
      expect.objectContaining({
        type: 'chat.patch_tab_settings',
        tabId: 'chat',
        patch: {
          modelConfig: { thinkingLevel: 'high', fastMode: false },
        },
      }),
    ]);
  });

  it('thinking-level toggles commit in the order they were requested', async () => {
    let releaseFirstRead = (): void => {};
    const firstRead = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    mockGetCompatibilityTabs.mockImplementationOnce(async (scope) => {
      await firstRead;
      return mockReadChatTabsFile(scope.projectId, scope.worktreeId);
    });

    const toggle = getHandler(IPC_CHANNELS.thinkingLevelToggle);
    const target = { projectId: 'workspace', worktreeId: 'worktree' };
    const first = toggle(undefined, {
      ...target,
      chatId: 'chat',
      level: 'high',
    });
    const second = toggle(undefined, {
      ...target,
      chatId: 'chat',
      level: 'low',
    });
    await new Promise((resolve) => setImmediate(resolve));
    releaseFirstRead();
    await Promise.all([first, second]);

    const committedLevels = patchCommands().map((command) => {
      const patch = isSettingsRecord(command) ? command['patch'] : undefined;
      const modelConfig = isSettingsRecord(patch)
        ? patch['modelConfig']
        : undefined;
      return isSettingsRecord(modelConfig)
        ? modelConfig['thinkingLevel']
        : undefined;
    });
    expect(committedLevels).toEqual(['high', 'low']);
  });

  it('codex fast-mode toggle commits the merged modelConfig patch', async () => {
    await getHandler(IPC_CHANNELS.chatCodexFastModeToggle)(undefined, {
      projectId: 'workspace',
      worktreeId: 'worktree',
      chatId: 'chat',
      enabled: true,
    });

    expect(patchCommands()).toEqual([
      expect.objectContaining({
        type: 'chat.patch_tab_settings',
        tabId: 'chat',
        patch: {
          modelConfig: { thinkingLevel: 'low', speed: 'fast', fastMode: true },
        },
      }),
    ]);
  });

  it('codex speed toggle commits the exact Ultra fast speed', async () => {
    await getHandler(IPC_CHANNELS.chatCodexFastModeToggle)(undefined, {
      projectId: 'workspace',
      worktreeId: 'worktree',
      chatId: 'chat',
      enabled: false,
      speed: 'ultrafast',
    });

    expect(patchCommands()).toEqual([
      expect.objectContaining({
        type: 'chat.patch_tab_settings',
        tabId: 'chat',
        patch: {
          modelConfig: {
            thinkingLevel: 'low',
            speed: 'ultrafast',
            fastMode: false,
          },
        },
      }),
    ]);
  });

  it('legacy fast-mode toggle replaces a canonical Ultra fast speed', async () => {
    mockGetCompatibilityTabs.mockResolvedValueOnce({
      version: 1,
      tabs: [
        {
          id: 'chat',
          title: 'Chat',
          createdAt: '2026-08-01T00:00:00.000Z',
          messages: [],
          providerType: 'codex',
          model: 'gpt-5.5',
          modelConfig: {
            thinkingLevel: 'low',
            speed: 'ultrafast',
            fastMode: false,
          },
        },
      ],
      activeTabId: 'chat',
    });

    await getHandler(IPC_CHANNELS.chatCodexFastModeToggle)(undefined, {
      projectId: 'workspace',
      worktreeId: 'worktree',
      chatId: 'chat',
      enabled: true,
    });

    expect(patchCommands()).toEqual([
      expect.objectContaining({
        patch: {
          modelConfig: { thinkingLevel: 'low', speed: 'fast', fastMode: true },
        },
      }),
    ]);
  });

  it('restores the retained Codex speed when a Claude tab returns to Codex', async () => {
    mockedGetSession.mockReturnValue(undefined);
    mockGetCompatibilityTabs.mockResolvedValueOnce({
      version: 1,
      tabs: [
        {
          id: 'chat',
          title: 'Chat',
          createdAt: '2026-08-01T00:00:00.000Z',
          messages: [],
          providerType: 'claude',
          model: 'claude-sonnet-4-6',
          modelConfig: { thinkingLevel: 'low' },
          retainedCodexSpeed: 'ultrafast',
        },
      ],
      activeTabId: 'chat',
    });

    await getHandler(IPC_CHANNELS.chatModelChange)(undefined, {
      projectId: 'workspace',
      worktreeId: 'worktree',
      chatId: 'chat',
      model: 'gpt-5.5',
    });

    expect(patchCommands()).toEqual([
      expect.objectContaining({
        patch: {
          modelExplicitlyChosen: true,
          thinkingLevel: 'max',
          modelConfig: {
            thinkingLevel: 'max',
            speed: 'ultrafast',
            fastMode: false,
          },
          codexFastModeEnabled: false,
          interfaceMode: null,
        },
      }),
    ]);
  });

  it('uses an Ultra fast Codex default on a provider switch', async () => {
    mockedGetSession.mockReturnValue(undefined);
    mockedReadPreferencesFile.mockResolvedValueOnce(
      makePreferences({
        defaultWorktreeModelByProvider: {
          claude: {
            model: 'claude-sonnet-4-6',
            thinkingLevel: 'high',
          },
          codex: { model: 'gpt-5.5', thinkingLevel: 'max' },
          ollama: null,
        },
        providerModelConfigDefaults: {
          codex: { speed: 'ultrafast', fastMode: false },
        },
      }),
    );

    await getHandler(IPC_CHANNELS.chatModelChange)(undefined, {
      projectId: 'workspace',
      worktreeId: 'worktree',
      chatId: 'chat',
      model: 'gpt-5.5',
    });

    expect(patchCommands()).toEqual([
      expect.objectContaining({
        patch: {
          modelExplicitlyChosen: true,
          thinkingLevel: 'max',
          modelConfig: {
            thinkingLevel: 'max',
            speed: 'ultrafast',
            fastMode: false,
          },
          codexFastModeEnabled: false,
          interfaceMode: null,
        },
      }),
    ]);
  });

  it.each(['plan-explore-chat'])(
    'refuses Cursor model mutation for unsupported %s before persistence',
    async (projectId) => {
      mockedGetSession.mockReturnValue(undefined);
      const accepted = await changeChatModel({
        projectId,
        worktreeId: 'entry-1',
        chatId: 'chat',
        model: 'cursor-default',
      });
      expect(accepted).toBe(false);
      expect(modelCommands()).toEqual([]);
      expect(patchCommands()).toEqual([]);
      expect(updateQueuedHookChatModelMock).not.toHaveBeenCalled();
    },
  );

  it.each(['pipeline-editor', 'code-review-chat'])(
    'accepts Cursor for assistant %s with runtime and auth preflight',
    async (projectId) => {
      mockedGetSession.mockReturnValue(undefined);
      await expect(
        changeChatModel({
          projectId,
          worktreeId: 'entry-1',
          chatId: 'chat',
          model: 'cursor-default',
        }),
      ).resolves.toBe(true);
      expect(mockReadCursorAccount).toHaveBeenCalled();
      expect(modelCommands()).toHaveLength(1);
    },
  );

  it.each(['pipeline-editor', 'code-review-chat'])(
    'refuses signed-out Cursor for assistant %s before mutation',
    async (projectId) => {
      mockReadCursorAccount.mockResolvedValueOnce(null);
      mockedGetSession.mockReturnValue(undefined);
      await expect(
        changeChatModel({
          projectId,
          worktreeId: 'entry-1',
          chatId: 'chat',
          model: 'cursor-default',
        }),
      ).resolves.toBe(false);
      expect(modelCommands()).toHaveLength(0);
    },
  );

  it.each(['standalone-chat', 'cowork-default'])(
    'accepts a Cursor model for Cowork %s while the runtime is connected',
    async (projectId) => {
      mockedGetSession.mockReturnValue(undefined);
      const accepted = await changeChatModel({
        projectId,
        worktreeId: 'entry-1',
        chatId: 'chat',
        model: 'cursor-default',
      });
      expect(accepted).toBe(true);
      expect(modelCommands()).toEqual([
        expect.objectContaining({
          type: 'chat.set_model',
          tabId: 'chat',
          model: 'cursor-default',
          providerType: 'cursor',
        }),
      ]);
    },
  );

  it.each(['standalone-chat', 'cowork-default'])(
    'refuses a Cursor model for Cowork %s while the runtime is disconnected',
    async (projectId) => {
      mockedGetSession.mockReturnValue(undefined);
      mockCursorConnectionStatus.mockResolvedValueOnce({
        supported: true,
        installed: false,
        enabled: false,
        version: 'test',
        phase: 'disconnected',
      });
      const accepted = await changeChatModel({
        projectId,
        worktreeId: 'entry-1',
        chatId: 'chat',
        model: 'cursor-default',
      });
      expect(accepted).toBe(false);
      expect(modelCommands()).toEqual([]);
      expect(patchCommands()).toEqual([]);
    },
  );

  it('accepts a Cursor model for an App Advisor chat while the runtime is connected', async () => {
    mockedGetSession.mockReturnValue(undefined);
    const accepted = await changeChatModel({
      projectId: 'app-advisor',
      worktreeId: 'entry-1',
      chatId: 'chat',
      model: 'cursor-default',
    });
    expect(accepted).toBe(true);
    expect(modelCommands()).toEqual([
      expect.objectContaining({
        type: 'chat.set_model',
        tabId: 'chat',
        model: 'cursor-default',
        providerType: 'cursor',
      }),
    ]);
  });

  describe('an Agent that inherits the default model', () => {
    beforeEach(() => {
      mockedGetSession.mockReturnValue(undefined);
      mockResolveAgentDestinationDefaultModel.mockReset();
      initAgentModels([
        {
          id: 'agent_model_inherit',
          name: 'Inherit',
          baseModel: 'default',
          instructions: '',
          pluginSelections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
          },
          createdAt: '2026-10-12T00:00:00.000Z',
          updatedAt: '2026-10-12T00:00:00.000Z',
          available: true,
        },
      ]);
    });

    afterEach(() => {
      initAgentModels([]);
    });

    it('persists the route resolved from the destination default', async () => {
      mockResolveAgentDestinationDefaultModel.mockResolvedValue('gpt-5.5');
      const accepted = await changeChatModel({
        projectId: 'workspace',
        worktreeId: 'worktree',
        chatId: 'chat',
        model: 'agent_model_inherit',
      });
      expect(accepted).toBe(true);
      expect(mockResolveAgentDestinationDefaultModel).toHaveBeenCalledWith(
        'workspace',
      );
      expect(modelCommands()).toEqual([
        expect.objectContaining({
          type: 'chat.set_model',
          model: 'agent_model_inherit@gpt-5.5',
          providerType: 'codex',
        }),
      ]);
    });

    it('keeps an already resolved route without consulting the default', async () => {
      const accepted = await changeChatModel({
        projectId: 'workspace',
        worktreeId: 'worktree',
        chatId: 'chat',
        model: 'agent_model_inherit@claude-sonnet-4-6',
      });
      expect(accepted).toBe(true);
      expect(mockResolveAgentDestinationDefaultModel).not.toHaveBeenCalled();
      expect(modelCommands()).toEqual([
        expect.objectContaining({
          model: 'agent_model_inherit@claude-sonnet-4-6',
          providerType: 'claude',
        }),
      ]);
    });

    it('refuses a route that would run a pinned Agent on another model', async () => {
      initAgentModels([
        {
          id: 'agent_model_pinned',
          name: 'Pinned',
          baseModel: 'claude-sonnet-4-6',
          instructions: '',
          pluginSelections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
          },
          createdAt: '2026-10-12T00:00:00.000Z',
          updatedAt: '2026-10-12T00:00:00.000Z',
          available: true,
        },
      ]);
      await expect(
        changeChatModel({
          projectId: 'workspace',
          worktreeId: 'worktree',
          chatId: 'chat',
          model: 'agent_model_pinned@gpt-5.5',
        }),
      ).resolves.toBe(false);
      expect(modelCommands()).toEqual([]);
    });

    it('refuses the change when the destination has no usable default', async () => {
      mockResolveAgentDestinationDefaultModel.mockRejectedValue(
        new Error('No dispatchable model is available (billing-lane).'),
      );
      await expect(
        changeChatModel({
          projectId: 'workspace',
          worktreeId: 'worktree',
          chatId: 'chat',
          model: 'agent_model_inherit',
        }),
      ).resolves.toBe(false);
      expect(modelCommands()).toEqual([]);
    });
  });

  it.each(['supported', 'enabled', 'installed', 'status-error'])(
    'refuses new Cursor selection before persistence when %s is unavailable',
    async (unavailable) => {
      mockedGetSession.mockReturnValue(undefined);
      if (unavailable === 'status-error')
        mockCursorConnectionStatus.mockRejectedValueOnce(
          new Error('status unavailable'),
        );
      else
        mockCursorConnectionStatus.mockResolvedValueOnce({
          supported: unavailable !== 'supported',
          installed: unavailable !== 'installed',
          enabled: unavailable !== 'enabled',
          version: 'test',
          phase: 'idle',
        });
      expect(
        await changeChatModel({
          projectId: 'workspace',
          worktreeId: 'worktree',
          chatId: 'chat',
          model: 'cursor-default',
        }),
      ).toBe(false);
      expect(modelCommands()).toEqual([]);
      expect(updateQueuedHookChatModelMock).not.toHaveBeenCalled();
      mockCursorConnectionStatus.mockReset().mockResolvedValue({
        supported: true,
        installed: true,
        enabled: true,
        version: 'test',
        phase: 'connected',
      });
    },
  );

  it('model change commits the durable model/provider patch', async () => {
    mockedGetSession.mockReturnValue(undefined);
    mockGetCompatibilityTabs.mockResolvedValueOnce({
      version: 1,
      tabs: [
        {
          id: 'chat',
          title: 'Chat',
          createdAt: '2026-08-01T00:00:00.000Z',
          messages: [],
          providerType: 'claude',
          modelConfig: { thinkingLevel: 'low' },
          thinkingLevel: 'low',
          interfaceMode: 'claude-code',
        },
      ],
      activeTabId: 'chat',
    });
    await getHandler(IPC_CHANNELS.chatModelChange)(undefined, {
      projectId: 'workspace',
      worktreeId: 'worktree',
      chatId: 'chat',
      model: 'gpt-5.5',
    });

    expect(modelCommands()).toEqual([
      expect.objectContaining({
        type: 'chat.set_model',
        tabId: 'chat',
        model: 'gpt-5.5',
        providerType: 'codex',
      }),
    ]);
    expect(patchCommands()).toEqual([
      expect.objectContaining({
        type: 'chat.patch_tab_settings',
        tabId: 'chat',
        patch: {
          modelExplicitlyChosen: true,
          thinkingLevel: 'max',
          modelConfig: { thinkingLevel: 'max', speed: 'fast', fastMode: true },
          codexFastModeEnabled: true,
          interfaceMode: null,
        },
      }),
    ]);
  });

  it('preserves the canonical modelConfig thinking level for the same provider', async () => {
    mockGetCompatibilityTabs.mockResolvedValueOnce({
      version: 1,
      tabs: [
        {
          id: 'chat',
          title: 'Chat',
          createdAt: '2026-08-01T00:00:00.000Z',
          messages: [],
          providerType: 'codex',
          model: 'gpt-5.5',
          modelConfig: { thinkingLevel: 'xhigh', fastMode: false },
        },
      ],
      activeTabId: 'chat',
    });

    await getHandler(IPC_CHANNELS.chatModelChange)(undefined, {
      projectId: 'workspace',
      worktreeId: 'worktree',
      chatId: 'chat',
      model: 'gpt-5.5',
    });

    expect(patchCommands()).toEqual([
      {
        type: 'chat.patch_tab_settings',
        tabId: 'chat',
        patch: {
          modelExplicitlyChosen: true,
          thinkingLevel: 'xhigh',
          modelConfig: {
            thinkingLevel: 'xhigh',
            speed: 'standard',
            fastMode: false,
          },
          codexFastModeEnabled: false,
          interfaceMode: null,
        },
      },
    ]);
  });

  it('uses chat-provider defaults for an App Advisor provider switch', async () => {
    mockedReadPreferencesFile.mockResolvedValueOnce(
      makePreferences({
        defaultChatModelByProvider: {
          claude: {
            model: 'claude-sonnet-4-6',
            thinkingLevel: 'high',
          },
          codex: { model: 'gpt-5.5', thinkingLevel: 'xhigh' },
          ollama: null,
        },
        defaultWorktreeModelByProvider: {
          claude: {
            model: 'claude-sonnet-4-6',
            thinkingLevel: 'high',
          },
          codex: { model: 'gpt-5.5', thinkingLevel: 'low' },
          ollama: null,
        },
        providerModelConfigDefaults: { codex: { fastMode: true } },
      }),
    );

    await getHandler(IPC_CHANNELS.chatModelChange)(undefined, {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'entry-1',
      chatId: 'chat',
      model: 'gpt-5.5',
    });

    expect(patchCommands()).toEqual([
      {
        type: 'chat.patch_tab_settings',
        tabId: 'chat',
        patch: {
          modelExplicitlyChosen: true,
          thinkingLevel: 'xhigh',
          modelConfig: {
            thinkingLevel: 'xhigh',
            speed: 'fast',
            fastMode: true,
          },
          codexFastModeEnabled: true,
          interfaceMode: null,
        },
      },
    ]);
  });

  it.each([0, 1])(
    'selects Claude interface defaults from native metadata (%i messages)',
    async (messageCount) => {
      mockedGetSession.mockReturnValue(undefined);
      mockedReadPreferencesFile.mockResolvedValueOnce(
        makePreferences({
          defaultChatInterfaceMode: 'canopy',
          providerModelConfigDefaults: { claude: { fastMode: false } },
        }),
      );
      mockGetCompatibilityTabs.mockResolvedValueOnce({
        version: 1,
        activeTabId: 'chat',
        tabs: [
          {
            id: 'chat',
            title: 'Chat',
            createdAt: '2026-08-01T00:00:00.000Z',
            providerType: 'codex',
            model: 'gpt-5.5',
            interfaceMode: 'claude-code',
            transcript: {
              format: 'complete-message-jsonl-v1',
              committedMessageCount: messageCount,
              committedByteLength: messageCount * 100,
              transcriptRevision: messageCount,
              hasActiveSidecar: false,
              messageCount,
            },
            get messages(): never {
              throw new Error('Transcript body is not loaded');
            },
          },
        ],
      });
      await expect(
        changeChatModel({
          projectId: 'workspace',
          worktreeId: 'worktree',
          chatId: 'chat',
          model: 'claude-sonnet-4-6',
        }),
      ).resolves.toBe(true);
      expect(patchCommands()).toMatchObject([
        {
          type: 'chat.patch_tab_settings',
          patch: {
            // The default native mode clears the persisted terminal override.
            interfaceMode: messageCount ? 'claude-code' : null,
          },
        },
      ]);
    },
  );

  it('honors a native interface override for a portal Claude selection', async () => {
    mockedReadPreferencesFile.mockResolvedValueOnce(
      makePreferences({
        defaultAppAdvisorInterfaceMode: 'auto',
        providerModelConfigDefaults: { claude: { fastMode: false } },
      }),
    );
    mockGetCompatibilityTabs.mockResolvedValueOnce({
      version: 1,
      tabs: [
        {
          id: 'chat',
          title: 'Chat',
          createdAt: '2026-08-01T00:00:00.000Z',
          messages: [],
          providerType: 'codex',
          model: 'gpt-5.5',
        },
      ],
      activeTabId: 'chat',
    });

    await changeChatModel(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-1',
        chatId: 'chat',
        model: 'claude-sonnet-4-6',
      },
      undefined,
      { interfaceModeOverride: 'canopy' },
    );

    expect(patchCommands()).toEqual([
      {
        type: 'chat.patch_tab_settings',
        tabId: 'chat',
        patch: {
          modelExplicitlyChosen: true,
          thinkingLevel: 'high',
          modelConfig: {
            thinkingLevel: 'high',
            speed: 'standard',
            fastMode: false,
          },
          codexFastModeEnabled: false,
          interfaceMode: 'canopy',
        },
      },
    ]);
  });

  it('serializes overlapping model changes before reading and committing settings', async () => {
    let markFirstStarted = (): void => {};
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let releaseFirst = (): void => {};
    const firstCommit = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    mockChatStateCommand
      .mockImplementationOnce(async () => {
        markFirstStarted();
        await firstCommit;
        return { commandId: 'first', revision: 1, outcome: 'applied' };
      })
      .mockResolvedValueOnce({
        commandId: 'second',
        revision: 2,
        outcome: 'applied',
      });

    const first = changeChatModel({
      projectId: 'workspace',
      worktreeId: 'worktree',
      chatId: 'chat',
      model: 'gpt-5.5',
    });
    await firstStarted;
    const second = changeChatModel({
      projectId: 'workspace',
      worktreeId: 'worktree',
      chatId: 'chat',
      model: 'claude-sonnet-4-6',
    });
    expect(mockGetCompatibilityTabs).toHaveBeenCalledTimes(1);
    expect(mockChatStateCommand).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([first, second]);

    const commands = modelCommands();
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatchObject({
      model: 'gpt-5.5',
      settings: { thinkingLevel: 'max' },
    });
    expect(commands[1]).toMatchObject({
      model: 'claude-sonnet-4-6',
      settings: { thinkingLevel: 'low' },
    });
  });

  it('uses Codex fast-mode defaults for an Ollama model on the Codex harness', async () => {
    initModelHarnessAssignments({
      revision: 1,
      assignments: [
        {
          modelId: 'ollama-qwen3-coder',
          source: 'ollama',
          harness: 'codex',
          defaultHarness: 'claude',
          configurable: true,
          overridden: true,
        },
      ],
    });
    mockedReadPreferencesFile.mockResolvedValueOnce(
      makePreferences({
        defaultWorktreeModelByProvider: {
          claude: {
            model: 'claude-sonnet-4-6',
            thinkingLevel: 'high',
          },
          codex: { model: 'gpt-5.5', thinkingLevel: 'high' },
          ollama: { model: 'ollama-qwen3-coder', thinkingLevel: 'medium' },
        },
        providerModelConfigDefaults: {
          codex: { fastMode: true },
          ollama: { fastMode: false },
        },
      }),
    );

    try {
      await getHandler(IPC_CHANNELS.chatModelChange)(undefined, {
        projectId: 'workspace',
        worktreeId: 'worktree',
        chatId: 'chat',
        model: 'ollama-qwen3-coder',
      });

      expect(modelCommands()).toEqual([
        expect.objectContaining({
          type: 'chat.set_model',
          model: 'ollama-qwen3-coder',
          providerType: 'ollama',
        }),
      ]);
      expect(patchCommands()).toEqual([
        {
          type: 'chat.patch_tab_settings',
          tabId: 'chat',
          patch: {
            modelExplicitlyChosen: true,
            thinkingLevel: 'medium',
            modelConfig: {
              thinkingLevel: 'medium',
              speed: 'fast',
              fastMode: true,
            },
            codexFastModeEnabled: true,
            interfaceMode: null,
          },
        },
      ]);
    } finally {
      initModelHarnessAssignments({ revision: 0, assignments: [] });
    }
  });

  it('rejects a plan-mode toggle before updating queue or session state when the canonical commit is rejected', async () => {
    const session = makeMockSession();
    mockedGetSession.mockReturnValue(session);
    mockChatStateCommand.mockResolvedValueOnce({
      commandId: 'rejected-settings',
      revision: 2,
      outcome: 'rejected',
      reason: 'journal unavailable',
    });

    await expect(
      getHandler(IPC_CHANNELS.planModeToggle)(undefined, {
        projectId: 'workspace',
        worktreeId: 'worktree',
        chatId: 'chat',
        enabled: true,
      }),
    ).rejects.toThrow('journal unavailable');

    expect(updateQueuedHookChatPlanModeMock).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(session.setPlanMode).not.toHaveBeenCalled();
  });

  it('rejects a model change before queue, session, or renderer updates when the canonical commit is rejected', async () => {
    const session = makeMockSession();
    mockedGetSession.mockReturnValue(session);
    mockChatStateCommand.mockResolvedValueOnce({
      commandId: 'rejected-model',
      revision: 2,
      outcome: 'rejected',
      reason: 'model conflict',
    });

    await expect(
      getHandler(IPC_CHANNELS.chatModelChange)(undefined, {
        projectId: 'cowork-default',
        worktreeId: 'home',
        chatId: 'chat',
        model: 'gpt-5.5',
      }),
    ).rejects.toThrow('model conflict');

    expect(updateQueuedHookChatModelMock).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(session.setModel).not.toHaveBeenCalled();
    expect(mockedSendToWindow).not.toHaveBeenCalled();
  });
});

describe('chat IPC chatCancel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIngestProviderEvent.mockResolvedValue(true);
    mockedSendToWindow.mockReturnValue(true);
    mockedSendToWindowDetailed.mockReturnValue({ delivered: true });
    mockedReadPersistedChatDispatchMetadata.mockResolvedValue({});
    mockGetChatState.mockResolvedValue({
      runtimeByChatId: {},
      tabsFile: { version: 1, tabs: [], activeTabId: '' },
    });
    registerChatHandlers(makeWindowAccessors());
  });

  it('returns the active turn anchor when the stopped turn is resumable', async () => {
    mockGetChatState.mockResolvedValueOnce({
      runtimeByChatId: {
        chat: {
          status: 'streaming',
          activeTurn: { userMessageId: 'user-message', startedAt: 1 },
          queuedMessageIds: [],
        },
      },
      tabsFile: {
        version: 1,
        tabs: [
          {
            id: 'chat',
            title: 'Chat',
            createdAt: '2026-09-23T00:00:00.000Z',
            messages: [],
            interfaceMode: 'canopy',
            sdkSessionId: 'session-1',
          },
        ],
        activeTabId: 'chat',
      },
    });

    await expect(
      getHandler(IPC_CHANNELS.chatCancel)(undefined, {
        projectId: 'proj',
        worktreeId: 'worktree',
        chatId: 'chat',
      }),
    ).resolves.toEqual({
      resumableTurn: { userMessageId: 'user-message' },
    });
  });

  it('resumes with canonical persisted session metadata instead of stale renderer state', async () => {
    const sessionApprovalRules = [
      {
        id: 'rule-1',
        behavior: 'allow' as const,
        target: { kind: 'tool' as const, toolName: 'Read' },
        createdAt: '2026-09-23T00:00:00.000Z',
        origin: 'prompt' as const,
      },
    ];
    const persistedTab = {
      id: 'chat',
      title: 'Chat',
      createdAt: '2026-09-23T00:00:00.000Z',
      messages: [],
      interfaceMode: 'canopy' as const,
      sdkSessionId: 'canonical-session',
      providerType: 'claude' as const,
      executionHarness: 'claude' as const,
      model: 'claude-sonnet-4-6' as const,
      sessionApprovalRules,
    };
    mockGetChatState.mockResolvedValueOnce({
      runtimeByChatId: {
        chat: {
          status: 'streaming',
          activeTurn: { userMessageId: 'user-message', startedAt: 1 },
          queuedMessageIds: [],
        },
      },
      tabsFile: {
        version: 1,
        tabs: [persistedTab],
        activeTabId: 'chat',
      },
    });
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      tabs: [persistedTab],
      activeTabId: 'chat',
    });
    mockedGetOrCreateSession.mockReturnValue(makeMockSession());

    await getHandler(IPC_CHANNELS.chatCancel)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
    });
    await expect(
      getHandler(IPC_CHANNELS.chatResumeStoppedTurn)(undefined, {
        projectId: 'proj',
        worktreeId: 'worktree',
        chatId: 'chat',
        userMessageId: 'user-message',
        sdkSessionId: 'stale-renderer-session',
        providerType: 'codex',
        executionHarness: 'codex',
        model: 'gpt-5.5',
      }),
    ).resolves.toEqual({ disposition: 'dispatched' });

    expect(mockedGetOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sdkSessionId: 'canonical-session',
        providerType: 'claude',
        executionHarness: 'claude',
        model: 'claude-sonnet-4-6',
        sessionApprovalRules,
      }),
      expect.any(Function),
      expect.any(Function),
      expect.any(Object),
    );
  });

  it('does not dispatch a resume invalidated while canonical metadata is loading', async () => {
    const target = {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
    };
    const persistedTab = {
      id: 'chat',
      title: 'Chat',
      createdAt: '2026-09-23T00:00:00.000Z',
      messages: [],
      interfaceMode: 'canopy' as const,
      sdkSessionId: 'canonical-session',
      providerType: 'claude' as const,
      executionHarness: 'claude' as const,
      model: 'claude-sonnet-4-6' as const,
    };
    mockGetChatState.mockResolvedValueOnce({
      runtimeByChatId: {
        chat: {
          status: 'streaming',
          activeTurn: { userMessageId: 'stopped-message', startedAt: 1 },
          queuedMessageIds: [],
        },
      },
      tabsFile: {
        version: 1,
        tabs: [persistedTab],
        activeTabId: 'chat',
      },
    });
    let releaseMetadata: (() => void) | undefined;
    mockReadChatTabsFile.mockReturnValueOnce(
      new Promise<ChatTabsFile>((resolve) => {
        releaseMetadata = (): void =>
          resolve({
            version: 1,
            tabs: [persistedTab],
            activeTabId: 'chat',
          });
      }),
    );
    mockedGetOrCreateSession.mockReturnValue(makeMockSession());

    await getHandler(IPC_CHANNELS.chatCancel)(undefined, target);
    const resume = getHandler(IPC_CHANNELS.chatResumeStoppedTurn)(undefined, {
      ...target,
      userMessageId: 'stopped-message',
    });
    await flushPromises();

    getStoppedTurnResumeService().invalidateForNewTurn(target, 'new-message');
    releaseMetadata?.();

    await expect(resume).resolves.toEqual({ disposition: 'stale' });
    expect(mockedGetOrCreateSession).not.toHaveBeenCalled();
  });

  it('does not offer resume before the provider session identity is persisted', async () => {
    mockGetChatState.mockResolvedValueOnce({
      runtimeByChatId: {
        chat: {
          status: 'starting',
          activeTurn: { userMessageId: 'user-message', startedAt: 1 },
          queuedMessageIds: [],
        },
      },
      tabsFile: {
        version: 1,
        tabs: [
          {
            id: 'chat',
            title: 'Chat',
            createdAt: '2026-09-23T00:00:00.000Z',
            messages: [],
            interfaceMode: 'canopy',
          },
        ],
        activeTabId: 'chat',
      },
    });

    await expect(
      getHandler(IPC_CHANNELS.chatCancel)(undefined, {
        projectId: 'proj',
        worktreeId: 'worktree',
        chatId: 'chat',
      }),
    ).resolves.toEqual({});
  });

  it('does not offer native resume for terminal-backed chats', async () => {
    mockGetChatState.mockResolvedValueOnce({
      runtimeByChatId: {
        chat: {
          status: 'streaming',
          activeTurn: { userMessageId: 'user-message', startedAt: 1 },
          queuedMessageIds: [],
        },
      },
      tabsFile: {
        version: 1,
        tabs: [
          {
            id: 'chat',
            title: 'Terminal chat',
            createdAt: '2026-09-23T00:00:00.000Z',
            messages: [],
            interfaceMode: 'claude-code',
            sdkSessionId: 'session-1',
          },
        ],
        activeTabId: 'chat',
      },
    });

    await expect(
      getHandler(IPC_CHANNELS.chatCancel)(undefined, {
        projectId: 'proj',
        worktreeId: 'worktree',
        chatId: 'chat',
      }),
    ).resolves.toEqual({});
  });

  it('does not offer native resume for cowork chats', async () => {
    mockGetChatState.mockResolvedValueOnce({
      runtimeByChatId: {
        chat: {
          status: 'streaming',
          activeTurn: { userMessageId: 'user-message', startedAt: 1 },
          queuedMessageIds: [],
        },
      },
      tabsFile: {
        version: 1,
        tabs: [
          {
            id: 'chat',
            title: 'Cowork chat',
            createdAt: '2026-09-23T00:00:00.000Z',
            messages: [],
            interfaceMode: 'canopy',
            sdkSessionId: 'session-1',
          },
        ],
        activeTabId: 'chat',
      },
    });

    await expect(
      getHandler(IPC_CHANNELS.chatCancel)(undefined, {
        projectId: 'cowork-default',
        worktreeId: 'home',
        chatId: 'chat',
      }),
    ).resolves.toEqual({});
  });

  it('does not offer resume when a newer queued turn is already waiting', async () => {
    mockGetChatState.mockResolvedValueOnce({
      runtimeByChatId: {
        chat: {
          status: 'streaming',
          activeTurn: { userMessageId: 'user-message', startedAt: 1 },
          queuedMessageIds: ['newer-message'],
        },
      },
      tabsFile: {
        version: 1,
        tabs: [
          {
            id: 'chat',
            title: 'Chat',
            createdAt: '2026-09-23T00:00:00.000Z',
            messages: [],
            interfaceMode: 'canopy',
            sdkSessionId: 'session-1',
          },
        ],
        activeTabId: 'chat',
      },
    });

    await expect(
      getHandler(IPC_CHANNELS.chatCancel)(undefined, {
        projectId: 'proj',
        worktreeId: 'worktree',
        chatId: 'chat',
      }),
    ).resolves.toEqual({});
  });

  it('registers a structured stale result for a missing resume offer', async () => {
    await expect(
      getHandler(IPC_CHANNELS.chatResumeStoppedTurn)(undefined, {
        projectId: 'proj',
        worktreeId: 'worktree',
        chatId: 'chat',
        userMessageId: 'old-user-message',
      }),
    ).resolves.toEqual({ disposition: 'stale' });
  });

  it('commits the synthetic cancellation before broadcasting it', async () => {
    let releaseCommit: ((committed: boolean) => void) | undefined;
    mockIngestProviderEvent.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseCommit = resolve;
        }),
    );

    const request = {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
    };
    const cancellation = getHandler(IPC_CHANNELS.chatCancel)(
      undefined,
      request,
    );
    await flushPromises();

    const [committedEvent] = mockIngestProviderEvent.mock.calls[0] ?? [];
    expect(committedEvent).toMatchObject({
      ...request,
      data: {
        type: 'result',
        is_error: false,
        result: 'Cancelled',
      },
    });
    expect(committedEvent?.mutationId).toMatch(/^manual-cancellation:/);
    expect(mockedSendToWindowDetailed).not.toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.chatEvent,
      expect.anything(),
    );

    releaseCommit?.(true);
    await cancellation;

    expect(mockedSendToWindowDetailed).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.chatEvent,
      {
        ...request,
        data: {
          type: 'result',
          is_error: false,
          result: 'Cancelled',
        },
      },
    );
    expect(mockIngestProviderEvent.mock.invocationCallOrder[0]).toBeLessThan(
      mockedSendToWindowDetailed.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('marks a cancelled Claude session for next-turn recreation so the next message starts a fresh session', async () => {
    const session = makeMockSession();
    mockedGetSession.mockReturnValue(session);
    mockedGetSessionProviderType.mockReturnValue('claude');

    await getHandler(IPC_CHANNELS.chatCancel)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
    });
    await flushPromises();

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(session.cancel).toHaveBeenCalled();
    expect(mockedMarkSessionForNextTurnRecreation).toHaveBeenCalledWith(
      'proj',
      'worktree',
      'chat',
    );
  });

  it('does not mark a cancelled Codex session for recreation', async () => {
    const session = makeMockSession();
    mockedGetSession.mockReturnValue(session);
    mockedGetSessionProviderType.mockReturnValue('codex');

    await getHandler(IPC_CHANNELS.chatCancel)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
    });
    await flushPromises();

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(session.cancel).toHaveBeenCalled();
    expect(mockedMarkSessionForNextTurnRecreation).not.toHaveBeenCalled();
  });

  it('marks a cancelled Ollama session for next-turn recreation', async () => {
    const session = makeMockSession();
    mockedGetSession.mockReturnValue(session);
    mockedGetSessionProviderType.mockReturnValue('ollama');

    await getHandler(IPC_CHANNELS.chatCancel)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
    });
    await flushPromises();

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(session.cancel).toHaveBeenCalled();
    expect(mockedMarkSessionForNextTurnRecreation).toHaveBeenCalledWith(
      'proj',
      'worktree',
      'chat',
    );
  });

  it('cancels a deferred-tools intent that has not reached the renderer yet', async () => {
    const scope = {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'pre-marker-reload',
    };
    const intent = deferredToolsReloadCoordinator.createIntent({
      scope,
      toolCallId: 'tool-before-marker',
      providerType: 'claude',
      interfaceMode: 'canopy',
      additions: { skillRefs: [], pluginRefs: [], mcpServerRefs: [] },
      enabledResources: [],
    });
    expect(intent.accepted).toBe(true);

    await getHandler(IPC_CHANNELS.chatCancel)(undefined, scope);

    expect(deferredToolsReloadCoordinator.hasActiveReload(scope)).toBe(false);
  });

  it('removes the logical-chat resume handler when the session is destroyed', async () => {
    const scope = {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: APP_ADVISOR_WORKTREE_ID,
      chatId: 'closed-advisor-chat',
    };
    const unregister = jest.spyOn(
      deferredToolsReloadCoordinator,
      'unregisterResumeHandler',
    );

    await getHandler(IPC_CHANNELS.chatDestroySession)(undefined, scope);

    expect(unregister).toHaveBeenCalledWith(scope);
    unregister.mockRestore();
  });
});

describe('chat IPC transient retry cancellation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    registerChatHandlers(makeWindowAccessors());
  });

  it('registers, validates, and dispatches the banner cancellation handler', () => {
    const target = {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
    };

    getHandler(IPC_CHANNELS.chatTransientRetryCancel)(undefined, target);

    expect(mockedValidateId).toHaveBeenCalledWith('proj', 'projectId');
    expect(mockedValidateId).toHaveBeenCalledWith('worktree', 'worktreeId');
    expect(mockedValidateId).toHaveBeenCalledWith('chat', 'chatId');
    expect(mockedCancelTransientRetryForChat).toHaveBeenCalledWith(
      target,
      'banner-dismiss',
    );
  });

  it('returns the live retry snapshot for renderer hydration', () => {
    const snapshot = [
      {
        projectId: 'proj',
        worktreeId: 'worktree',
        chatId: 'chat',
        data: {
          type: 'canopy_transient_retry_state' as const,
          provider: 'claude' as const,
          active: true,
          attempt: 1,
          maxAttempts: 5,
          nextRetryAt: 31_000,
          exhausted: false,
        },
      },
    ];
    mockedGetTransientRetryStateSnapshot.mockReturnValueOnce(snapshot);

    expect(
      getHandler(IPC_CHANNELS.chatTransientRetryGetSnapshot)(undefined),
    ).toEqual(snapshot);
  });

  it('rejects invalid targets before dispatching cancellation', () => {
    mockedValidateId.mockImplementationOnce(() => {
      throw new Error('Invalid projectId');
    });

    expect(() =>
      getHandler(IPC_CHANNELS.chatTransientRetryCancel)(undefined, {
        projectId: '../bad',
        worktreeId: 'worktree',
        chatId: 'chat',
      }),
    ).toThrow('Invalid projectId');
    expect(mockedCancelTransientRetryForChat).not.toHaveBeenCalled();
  });

  it('cancels a pending retry before resetting a chat turn', async () => {
    const tab = {
      id: 'chat',
      title: 'Reset chat',
      messages: [],
      createdAt: '2026-07-20T00:00:00.000Z',
    };
    resetChatToPointMock.mockResolvedValueOnce(tab);

    await expect(
      getHandler(IPC_CHANNELS.chatResetToPoint)(undefined, {
        projectId: 'proj',
        worktreeId: 'worktree',
        chatId: 'chat',
        userMessageId: 'user-message',
      }),
    ).resolves.toEqual({ tab });

    expect(mockedCancelTransientRetryForChat).toHaveBeenCalledWith(
      {
        projectId: 'proj',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      'reset-to-point',
    );
    expect(
      mockedCancelTransientRetryForChat.mock.invocationCallOrder[0],
    ).toBeLessThan(resetChatToPointMock.mock.invocationCallOrder[0] ?? 0);
  });
});

describe('chat IPC preparePlanFileSystemInstruction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    registerChatHandlers(makeWindowAccessors());
  });

  it('validates ids and forwards the whole request to buildPlanFileSystemInstruction', async () => {
    buildPlanFileSystemInstructionMock.mockResolvedValueOnce({
      id: 'plan-file-location:plan-1',
      text: 'instruction text',
    });

    const request = {
      projectId: 'proj',
      worktreeId: 'worktree',
      planId: 'plan-1',
      purpose: 'active-plan' as const,
      viewedRevisionNumber: 2,
    };

    const result = await getHandler(
      IPC_CHANNELS.chatPreparePlanFileSystemInstruction,
    )(undefined, request);

    expect(mockedValidateId).toHaveBeenCalledWith('plan-1', 'planId');
    expect(mockedValidateId).toHaveBeenCalledWith('proj', 'projectId');
    expect(mockedValidateId).toHaveBeenCalledWith('worktree', 'worktreeId');
    expect(buildPlanFileSystemInstructionMock).toHaveBeenCalledWith(request);
    expect(result).toEqual({
      instruction: {
        id: 'plan-file-location:plan-1',
        text: 'instruction text',
      },
    });
  });

  it('returns no instruction when the builder returns null', async () => {
    buildPlanFileSystemInstructionMock.mockResolvedValueOnce(null);

    const result = await getHandler(
      IPC_CHANNELS.chatPreparePlanFileSystemInstruction,
    )(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      planId: 'plan-1',
    });

    expect(result).toEqual({});
  });

  it('accepts the authored-plan and active-plan purposes', async () => {
    buildPlanFileSystemInstructionMock.mockResolvedValue(null);

    await expect(
      getHandler(IPC_CHANNELS.chatPreparePlanFileSystemInstruction)(undefined, {
        projectId: 'proj',
        worktreeId: 'worktree',
        planId: 'plan-1',
        purpose: 'authored-plan',
      }),
    ).resolves.toEqual({});
    await expect(
      getHandler(IPC_CHANNELS.chatPreparePlanFileSystemInstruction)(undefined, {
        projectId: 'proj',
        worktreeId: 'worktree',
        planId: 'plan-1',
        purpose: 'active-plan',
      }),
    ).resolves.toEqual({});
  });

  it('rejects an invalid purpose without calling the builder', async () => {
    await expect(
      getHandler(IPC_CHANNELS.chatPreparePlanFileSystemInstruction)(undefined, {
        projectId: 'proj',
        worktreeId: 'worktree',
        planId: 'plan-1',
        purpose: 'bogus',
      }),
    ).rejects.toThrow('Invalid purpose for plan file system instruction.');
    expect(buildPlanFileSystemInstructionMock).not.toHaveBeenCalled();
  });

  it('accepts a positive integer viewedRevisionNumber', async () => {
    buildPlanFileSystemInstructionMock.mockResolvedValueOnce(null);

    await expect(
      getHandler(IPC_CHANNELS.chatPreparePlanFileSystemInstruction)(undefined, {
        projectId: 'proj',
        worktreeId: 'worktree',
        planId: 'plan-1',
        viewedRevisionNumber: 3,
      }),
    ).resolves.toEqual({});
  });

  it.each([1.5, 0, -1])(
    'rejects a viewedRevisionNumber of %p without calling the builder',
    async (viewedRevisionNumber) => {
      await expect(
        getHandler(IPC_CHANNELS.chatPreparePlanFileSystemInstruction)(
          undefined,
          {
            projectId: 'proj',
            worktreeId: 'worktree',
            planId: 'plan-1',
            viewedRevisionNumber,
          },
        ),
      ).rejects.toThrow(
        'viewedRevisionNumber must be a positive safe integer.',
      );
      expect(buildPlanFileSystemInstructionMock).not.toHaveBeenCalled();
    },
  );
});

describe('chat IPC plan-explore modal-open removal', () => {
  it('no longer registers a plan-explore modal-open handler (D-G/S7)', () => {
    registerChatHandlers(makeWindowAccessors());

    expect(() => getHandler('chat:plan-explore-modal-open')).toThrow(
      'No handler registered for chat:plan-explore-modal-open',
    );
  });
});

describe('chat IPC register-plan-explore removal', () => {
  it('no longer registers a register-plan-explore handler (D-I/S7)', () => {
    registerChatHandlers(makeWindowAccessors());

    expect(() => getHandler('chat:register-plan-explore')).toThrow(
      'No handler registered for chat:register-plan-explore',
    );
  });
});

describe('chat IPC cancelQueuedHookChat', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    registerChatHandlers(makeWindowAccessors());
  });

  it('validates queueId before cancelling the queued hook chat', () => {
    const response = getHandler(IPC_CHANNELS.chatCancelQueuedHookChat)(
      undefined,
      {
        queueId: 'queued-hook-1',
      },
    );

    expect(mockedValidateId).toHaveBeenCalledWith('queued-hook-1', 'queueId');
    expect(mockedCancelQueuedHookChat).toHaveBeenCalledWith('queued-hook-1');
    expect(response).toEqual({ cancelled: true });
  });
});

describe('chat IPC forceQueuedHookChat', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    registerChatHandlers(makeWindowAccessors());
  });

  it('validates queueId before forcing the queued hook chat', async () => {
    const response = await getHandler(IPC_CHANNELS.chatForceQueuedHookChat)(
      undefined,
      {
        queueId: 'queued-hook-1',
      },
    );

    expect(mockedValidateId).toHaveBeenCalledWith('queued-hook-1', 'queueId');
    expect(mockedForceQueuedHookChat).toHaveBeenCalledWith('queued-hook-1');
    expect(response).toEqual({ forced: true });
  });
});

describe('chat IPC setQueuedHookChatInterfaceMode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    registerChatHandlers(makeWindowAccessors());
  });

  it('validates the target before updating the queued hook launch mode', () => {
    const request = {
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'hook-chat',
      interfaceMode: 'claude-code',
    };
    const response = getHandler(
      IPC_CHANNELS.chatSetQueuedHookChatInterfaceMode,
    )(undefined, request);

    expect(mockedValidateId).toHaveBeenCalledWith('project', 'projectId');
    expect(mockedValidateId).toHaveBeenCalledWith('worktree', 'worktreeId');
    expect(mockedValidateId).toHaveBeenCalledWith('hook-chat', 'chatId');
    expect(updateQueuedHookChatInterfaceModeMock).toHaveBeenCalledWith(request);
    expect(response).toEqual({ updated: true });
  });

  it('rejects an unsupported interface mode', () => {
    expect(() =>
      getHandler(IPC_CHANNELS.chatSetQueuedHookChatInterfaceMode)(undefined, {
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'hook-chat',
        interfaceMode: 'terminal',
      }),
    ).toThrow('Unsupported interface mode.');
    expect(updateQueuedHookChatInterfaceModeMock).not.toHaveBeenCalled();
  });
});

describe('chat IPC model changes', () => {
  beforeEach(() => {
    blockedModelIds.clear();
    jest.clearAllMocks();
    mockedGetSession.mockReturnValue(undefined);
    mockedGetSessionProviderType.mockReturnValue(undefined);
    mockCheckModelGatewayRoute.mockResolvedValue({
      ok: true,
      orgRoute: false,
    });
    registerChatHandlers(makeWindowAccessors());
  });

  it('records the selected gateway harness as the chat runtime provider', async () => {
    const entry = {
      recommendedHarness: 'codex' as const,
      contextWindow: 100_000,
      supportsPromptCaching: false,
      supportedThinkingLevels: [],
      toolSchemaProfile: 'standard' as const,
    };
    initAiGatewayModels(
      [{ id: 'gateway-chat-harness', label: 'Gateway chat harness', ...entry }],
      [
        {
          modelId: 'gateway-chat-harness',
          gatewayId: 'openai/gateway-chat-harness',
          gatewayOnly: true,
          ...entry,
        },
      ],
    );
    try {
      const result = await getHandler(IPC_CHANNELS.chatModelChange)(undefined, {
        projectId: 'proj',
        worktreeId: 'worktree',
        chatId: 'chat',
        model: 'gateway-chat-harness',
        executionHarness: 'claude',
      });
      expect(result).toBe(true);
      expect(lastCanonicalChatCommand()).toMatchObject({
        type: 'chat.set_model',
        model: 'gateway-chat-harness',
        providerType: 'claude',
        executionHarness: 'claude',
      });
    } finally {
      initAiGatewayModels([], []);
    }
  });

  it('rejects a per-chat harness override unsupported by a native model', async () => {
    const result = await getHandler(IPC_CHANNELS.chatModelChange)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      model: 'gpt-5.5',
      executionHarness: 'claude',
    });
    expect(result).toBe(false);
    expect(mockChatStateCommand).not.toHaveBeenCalled();
    expect(updateQueuedHookChatModelMock).not.toHaveBeenCalled();
  });

  it('rejects unsupported ollama-prefixed model selections', async () => {
    const result = await getHandler(IPC_CHANNELS.chatModelChange)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      model: 'ollama-missing-local-model',
    });

    expect(result).toBe(false);
  });

  it('accepts a registered Agent model selection', async () => {
    initAgentModels([
      {
        id: 'agent_model_locked_plugin',
        name: 'Locked Plugin Agent',
        baseModel: 'claude-sonnet-4-6',
        instructions: 'Use the inherited plugin.',
        createdAt: '2026-08-16T00:00:00.000Z',
        updatedAt: '2026-08-16T00:00:00.000Z',
        available: true,
      },
    ]);

    const result = await getHandler(IPC_CHANNELS.chatModelChange)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      model: 'agent_model_locked_plugin',
    });

    expect(result).toBe(true);
  });

  it('rejects a model blocked by the current organization policy', async () => {
    blockedModelIds.add('gpt-5.5');

    const result = await getHandler(IPC_CHANNELS.chatModelChange)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      model: 'gpt-5.5',
    });

    expect(result).toBe(false);
    expect(updateQueuedHookChatModelMock).not.toHaveBeenCalled();
    // The bare `false` is indistinguishable from "unknown model" or "provider
    // change not allowed" on this IPC contract, so the diagnostic is the only
    // signal that a policy refused the pick. Pinned here so removing it is a
    // visible failure rather than a silent loss of traceability.
    expect(recordSessionDiagnosticMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'model_policy_refused',
        model: 'gpt-5.5',
        projectId: 'proj',
        worktreeId: 'worktree',
        chatId: 'chat',
      }),
    );
  });

  it("rejects a model excluded by the work owner's enforced gateway", async () => {
    mockCheckModelGatewayRoute.mockResolvedValueOnce({
      ok: false,
      message: 'Acme requires model traffic to use its configured gateway.',
    });

    const result = await getHandler(IPC_CHANNELS.chatModelChange)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      model: 'gpt-5.5',
    });

    expect(result).toBe(false);
    expect(mockCheckModelGatewayRoute).toHaveBeenCalledWith(
      'gpt-5.5',
      undefined,
    );
    expect(mockChatStateCommand).not.toHaveBeenCalled();
    expect(updateQueuedHookChatModelMock).not.toHaveBeenCalled();
  });

  it('broadcasts a cowork meta-updated event on model change without the legacy meta mirror', async () => {
    const result = await getHandler(IPC_CHANNELS.chatModelChange)(undefined, {
      projectId: 'cowork-default',
      worktreeId: 'home',
      chatId: 'chat',
      model: 'gpt-5.5',
    });

    expect(result).toBe(true);
    // Work Entries: provider persistence lives in the tab file itself; the
    // legacy chat-history meta mirror is gone, but the renderer still gets
    // the meta-updated broadcast so entry-list metadata refreshes.
    expect(mockedUpdateChatMeta).not.toHaveBeenCalled();
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.standaloneChatMetaUpdated,
      expect.objectContaining({
        projectId: 'cowork-default',
        chatId: 'chat',
        providerType: 'codex',
      }),
    );
  });

  it('recreates an active session when a same-harness model changes provider source', async () => {
    const setModel = jest.fn().mockResolvedValue(undefined);
    const session: AgentSession = { ...makeMockSession(), setModel };
    mockedGetSession.mockReturnValue(session);
    mockedGetSessionProviderType.mockReturnValue('ollama');

    const result = await getHandler(IPC_CHANNELS.chatModelChange)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      model: 'gpt-5.5',
      lockedHarness: 'codex',
    });

    expect(result).toBe(true);
    expect(mockedDestroySession).toHaveBeenCalledWith(
      'proj',
      'worktree',
      'chat',
      { retainDelegations: true },
    );
    expect(setModel).not.toHaveBeenCalled();
  });

  it('does not persist chat meta for a plain git worktree chat', async () => {
    await getHandler(IPC_CHANNELS.chatModelChange)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      model: 'gpt-5.5',
    });

    expect(mockedUpdateChatMeta).not.toHaveBeenCalled();
  });
});

describe('chat IPC chatUpdatePlugins', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCompatibilityTabs.mockImplementation(
      (scope: { projectId: string; worktreeId: string }) =>
        mockReadChatTabsFile(scope.projectId, scope.worktreeId),
    );
    jest.mocked(getActiveSessionCapabilityProfile).mockReturnValue(undefined);
    jest.mocked(isSessionAiCreditsRouted).mockReturnValue(false);
    jest.mocked(getSessionAiCreditsRoutedState).mockReturnValue(undefined);
    mockedGetSession.mockReturnValue(undefined);
    mockedGetActiveSessionInfos.mockReturnValue([]);
    mockWriteChatTabsFile.mockResolvedValue(undefined);
    registerChatHandlers(makeWindowAccessors());
  });

  it('commits a materialized Codex thread only after history injection succeeds', async () => {
    const pluginSelections = {
      collectionIds: [],
      skillRefs: [{ sourceId: 'personal', skillName: 'review' }],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    const unsubscribe = jest.fn().mockResolvedValue(undefined);
    const removeProvisionalThread = jest.fn().mockResolvedValue(undefined);
    const releaseRoutes = jest.fn();
    const disabledGlobalPluginSelections = {
      collectionIds: ['global-collection'],
    };
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Codex chat',
          messages: [],
          createdAt: '2026-07-22T00:00:00.000Z',
          providerType: 'codex',
          model: 'gpt-5.5',
          sdkSessionId: 'thread-old',
          pluginSelections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
            mcpServerRefs: [],
          },
        },
      ],
    });
    mockMaterializeCodexCapabilityTransition.mockResolvedValue({
      handle: {
        threadId: 'thread-new',
        unsubscribe,
        delete: removeProvisionalThread,
      },
      snapshotId: 'snapshot-new',
      releaseRoutes,
    });
    jest.mocked(getActiveSessionCapabilityProfile).mockReturnValue({
      assistantMode: 'pipeline-editor',
      codeGraphToolsAdvertised: false,
    });
    jest.mocked(getSessionAiCreditsRoutedState).mockReturnValue(true);

    const response = await getHandler(IPC_CHANNELS.chatUpdatePlugins)(
      undefined,
      {
        projectId: 'proj',
        worktreeId: 'worktree',
        chatId: 'chat',
        pluginSelections,
        deferredToolsAllowed: false,
        materializeCodexThread: true,
        expectedCurrentThreadId: 'thread-old',
        disabledGlobalPluginSelections,
      },
    );

    expect(mockWriteChatTabsFile).toHaveBeenCalledTimes(1);
    expect(mockWriteChatTabsFile).toHaveBeenCalledWith(
      'proj',
      'worktree',
      expect.objectContaining({
        tabs: [
          expect.objectContaining({
            id: 'chat',
            sdkSessionId: 'thread-new',
            pluginSelections,
            deferredToolsAllowed: false,
            disabledGlobalPluginSelections,
          }),
        ],
      }),
    );
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(removeProvisionalThread).not.toHaveBeenCalled();
    expect(releaseRoutes).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      pluginSelections,
      deferredToolsAllowed: false,
      disabledGlobalPluginSelections,
      sdkSessionId: 'thread-new',
    });
    expect(mockMaterializeCodexCapabilityTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantMode: 'pipeline-editor',
        codeGraphToolsAdvertised: false,
        aiCreditsRouted: true,
      }),
    );
  });

  it.each(['metadata', 'session', 'model', 'removed'] as const)(
    'reconciles a capability transition with a concurrent %s change',
    async (change) => {
      mockedReadPreferencesFile.mockResolvedValue(makePreferences());
      const pluginSelections = {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [{ serverId: 'deferred', configId: 'default' }],
      };
      const file: ChatTabsFile = {
        version: 1,
        revision: 1,
        activeTabId: 'chat',
        tabs: [
          {
            id: 'chat',
            title: 'Before transition',
            messages: [],
            createdAt: '2026-07-22T00:00:00.000Z',
            providerType: 'codex',
            model: 'gpt-5.5',
            sdkSessionId: 'thread-old',
          },
        ],
      };
      const removeThread = jest.fn().mockResolvedValue(undefined);
      mockReadChatTabsFile.mockResolvedValue(file);
      mockMaterializeCodexCapabilityTransition.mockImplementationOnce(() => {
        mockReadChatTabsFile.mockResolvedValue({
          ...file,
          revision: 2,
          tabs:
            change === 'removed'
              ? []
              : [
                  {
                    ...file.tabs[0],
                    title: 'Concurrent title',
                    ...(change === 'session'
                      ? { sdkSessionId: 'different-thread' }
                      : {}),
                    ...(change === 'model' ? { model: 'gpt-6-sol' } : {}),
                  },
                ],
        });
        return Promise.resolve({
          handle: {
            threadId: 'thread-new',
            unsubscribe: jest.fn(),
            delete: removeThread,
          },
          snapshotId: 'new',
          releaseRoutes: jest.fn(),
        });
      });
      const update = getHandler(IPC_CHANNELS.chatUpdatePlugins)(undefined, {
        projectId: 'proj',
        worktreeId: 'worktree',
        chatId: 'chat',
        pluginSelections,
        materializeCodexThread: true,
        expectedCurrentThreadId: 'thread-old',
      });
      if (change !== 'metadata') {
        await expect(update).rejects.toThrow(
          change === 'removed' ? 'removed while tools' : 'Chat changed',
        );
        expect(removeThread).toHaveBeenCalledTimes(1);
        expect(mockWriteChatTabsFile).not.toHaveBeenCalled();
        return;
      }
      await update;
      expect(removeThread).not.toHaveBeenCalled();
      const writes = mockWriteChatTabsFile.mock.calls;
      expect(writes[writes.length - 1]?.[2]).toMatchObject({
        revision: 2,
        tabs: [
          {
            title: 'Concurrent title',
            sdkSessionId: 'thread-new',
            pluginSelections,
          },
        ],
      });
    },
  );

  it('persists a picker save without starting a replacement Codex thread', async () => {
    const pluginSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'official', pluginName: 'linear' }],
      mcpServerRefs: [],
    };
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Codex chat',
          messages: [],
          createdAt: '2026-07-22T00:00:00.000Z',
          providerType: 'codex',
          model: 'gpt-6-sol',
          sdkSessionId: 'thread-old',
          pluginSelections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
            mcpServerRefs: [],
          },
        },
      ],
    });
    mockedGetSession.mockReturnValue(makeMockSession());
    mockedGetActiveSessionInfos.mockReturnValue([
      makeActiveSessionInfo({ turnActive: false, pendingMessageCount: 0 }),
    ]);

    const response = await getHandler(IPC_CHANNELS.chatUpdatePlugins)(
      undefined,
      {
        projectId: 'proj',
        worktreeId: 'worktree',
        chatId: 'chat',
        pluginSelections,
        materializeCodexThread: false,
        expectedCurrentThreadId: 'thread-old',
      },
    );

    expect(mockMaterializeCodexCapabilityTransition).not.toHaveBeenCalled();
    expect(lastCanonicalChatCommand()).toEqual({
      type: 'chat.patch_tab_settings',
      tabId: 'chat',
      patch: { pluginSelections },
    });
    expect(mockedDestroySession).toHaveBeenCalledWith(
      'proj',
      'worktree',
      'chat',
      { suppressObservabilityInterrupt: false, retainDelegations: true },
    );
    expect(response).toEqual({ pluginSelections });
  });

  it('waits for picker persistence before acknowledging a non-materializing save', async () => {
    let finishCommit: (() => void) | undefined;
    mockChatStateCommand.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCommit = () =>
            resolve({
              commandId: 'test',
              revision: 1,
              outcome: 'applied',
            });
        }),
    );
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Codex chat',
          messages: [],
          createdAt: '2026-07-22T00:00:00.000Z',
          providerType: 'codex',
          model: 'gpt-6-sol',
          sdkSessionId: 'thread-old',
        },
      ],
    });
    mockedGetSession.mockReturnValue(makeMockSession());
    mockedGetActiveSessionInfos.mockReturnValue([
      makeActiveSessionInfo({ turnActive: false, pendingMessageCount: 0 }),
    ]);

    let acknowledged = false;
    const responsePromise: Promise<unknown> = (async (): Promise<unknown> => {
      const response: unknown = await getHandler(
        IPC_CHANNELS.chatUpdatePlugins,
      )(undefined, {
        projectId: 'proj',
        worktreeId: 'worktree',
        chatId: 'chat',
        pluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
        },
        materializeCodexThread: false,
        expectedCurrentThreadId: 'thread-old',
      });
      acknowledged = true;
      return response;
    })();

    await flushPromises();
    expect(mockChatStateCommand).toHaveBeenCalledTimes(1);
    expect(acknowledged).toBe(false);

    finishCommit?.();
    await expect(responsePromise).resolves.toEqual({
      pluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
    });
  });

  it('validates a picker save against the live provider thread before persistence catches up', async () => {
    const pluginSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'official', pluginName: 'linear' }],
      mcpServerRefs: [],
    };
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Codex chat',
          messages: [],
          createdAt: '2026-07-22T00:00:00.000Z',
          providerType: 'codex',
          model: 'gpt-6-sol',
          sdkSessionId: 'thread-persisted',
        },
      ],
    });
    const session = makeMockSession();
    session.getProviderSessionId = (): string => 'thread-live';
    mockedGetSession.mockReturnValue(session);
    mockedGetActiveSessionInfos.mockReturnValue([
      makeActiveSessionInfo({ turnActive: false, pendingMessageCount: 0 }),
    ]);

    await expect(
      getHandler(IPC_CHANNELS.chatUpdatePlugins)(undefined, {
        projectId: 'proj',
        worktreeId: 'worktree',
        chatId: 'chat',
        pluginSelections,
        materializeCodexThread: false,
        expectedCurrentThreadId: 'thread-live',
      }),
    ).resolves.toEqual({ pluginSelections });

    expect(lastCanonicalChatCommand()).toEqual({
      type: 'chat.patch_tab_settings',
      tabId: 'chat',
      patch: { pluginSelections },
    });
  });

  it('omits the AI Credits routing signal when no live session reports one', async () => {
    // Editing tool selections on an idle chat (app restarted, nothing sent
    // yet) has no session to read routing from. Forwarding `false` there would
    // tell the transition an AI Credits chat is native, which downgrades its
    // reasoning route family and strips the thread's cached reasoning.
    const pluginSelections = {
      collectionIds: [],
      skillRefs: [{ sourceId: 'personal', skillName: 'review' }],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Codex chat',
          messages: [],
          createdAt: '2026-07-22T00:00:00.000Z',
          providerType: 'codex',
          model: 'gpt-5.5',
          sdkSessionId: 'thread-old',
          pluginSelections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
            mcpServerRefs: [],
          },
        },
      ],
    });
    mockMaterializeCodexCapabilityTransition.mockResolvedValue({
      handle: {
        threadId: 'thread-new',
        unsubscribe: jest.fn().mockResolvedValue(undefined),
        delete: jest.fn().mockResolvedValue(undefined),
      },
      snapshotId: 'snapshot-new',
      releaseRoutes: jest.fn(),
    });
    jest.mocked(getSessionAiCreditsRoutedState).mockReturnValue(undefined);

    await getHandler(IPC_CHANNELS.chatUpdatePlugins)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      pluginSelections,
      materializeCodexThread: true,
      expectedCurrentThreadId: 'thread-old',
    });

    const transitionInput: unknown =
      mockMaterializeCodexCapabilityTransition.mock.calls[0]?.[0];
    expect(transitionInput).not.toHaveProperty('aiCreditsRouted');
  });

  it('derives the Ollama execution backend from the model, not the persisted providerType', async () => {
    // `resolveProviderType` in the session manager derives `ollama` from
    // `getModelSource(model)`, so a tab whose persisted `providerType` drifted
    // to `codex` still runs on Ollama. Forwarding the stale field would make the
    // transition resolve the `native` family and skip the loopback Responses
    // config while still passing the raw `ollama-*` model id to a canonical
    // Codex app-server.
    const pluginSelections = {
      collectionIds: [],
      skillRefs: [{ sourceId: 'personal', skillName: 'review' }],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Ollama chat',
          messages: [],
          createdAt: '2026-07-22T00:00:00.000Z',
          providerType: 'codex',
          executionHarness: 'codex',
          model: 'ollama-qwen3-coder',
          sdkSessionId: 'thread-old',
        },
      ],
    });
    mockMaterializeCodexCapabilityTransition.mockResolvedValue({
      handle: {
        threadId: 'thread-new',
        unsubscribe: jest.fn().mockResolvedValue(undefined),
        delete: jest.fn().mockResolvedValue(undefined),
      },
      snapshotId: 'snapshot-new',
      releaseRoutes: jest.fn(),
    });

    await getHandler(IPC_CHANNELS.chatUpdatePlugins)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      pluginSelections,
      materializeCodexThread: true,
      expectedCurrentThreadId: 'thread-old',
    });

    expect(mockMaterializeCodexCapabilityTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'ollama-qwen3-coder',
        providerType: 'ollama',
      }),
    );
  });

  it('drops a stale ollama providerType when the model is not an Ollama model', async () => {
    // The other drift direction. The session would run this chat on the
    // canonical Codex route, so forwarding `ollama` would make the transition
    // demand a running Ollama server and fail the tool update outright.
    const pluginSelections = {
      collectionIds: [],
      skillRefs: [{ sourceId: 'personal', skillName: 'review' }],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Codex chat',
          messages: [],
          createdAt: '2026-07-22T00:00:00.000Z',
          providerType: 'ollama',
          executionHarness: 'codex',
          model: 'gpt-5.5',
          sdkSessionId: 'thread-old',
        },
      ],
    });
    mockMaterializeCodexCapabilityTransition.mockResolvedValue({
      handle: {
        threadId: 'thread-new',
        unsubscribe: jest.fn().mockResolvedValue(undefined),
        delete: jest.fn().mockResolvedValue(undefined),
      },
      snapshotId: 'snapshot-new',
      releaseRoutes: jest.fn(),
    });

    await getHandler(IPC_CHANNELS.chatUpdatePlugins)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      pluginSelections,
      materializeCodexThread: true,
      expectedCurrentThreadId: 'thread-old',
    });

    const transitionInput: unknown =
      mockMaterializeCodexCapabilityTransition.mock.calls[0]?.[0];
    expect(transitionInput).not.toHaveProperty('providerType');
  });

  it('persists and echoes normalized tombstones for non-Codex updates', async () => {
    const pluginSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    const plugin = { marketplaceId: 'market', pluginName: 'plugin' };
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Claude chat',
          messages: [],
          createdAt: '2026-07-22T00:00:00.000Z',
          providerType: 'claude',
        },
      ],
    });

    const response = await getHandler(IPC_CHANNELS.chatUpdatePlugins)(
      undefined,
      {
        projectId: 'proj',
        worktreeId: 'worktree',
        chatId: 'chat',
        pluginSelections,
        disabledGlobalPluginSelections: {
          collectionIds: [' global ', '', 'global'],
          pluginRefs: [plugin, plugin],
        },
      },
    );

    const normalized = {
      collectionIds: ['global'],
      pluginRefs: [plugin],
    };
    expect(lastCanonicalChatCommand()).toEqual({
      type: 'chat.patch_tab_settings',
      tabId: 'chat',
      patch: {
        pluginSelections,
        disabledGlobalPluginSelections: normalized,
      },
    });
    expect(response).toEqual({
      pluginSelections,
      disabledGlobalPluginSelections: normalized,
    });
  });

  it('clears persisted tombstones when the replacement normalizes empty', async () => {
    const pluginSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Claude chat',
          messages: [],
          createdAt: '2026-07-22T00:00:00.000Z',
          providerType: 'claude',
          disabledGlobalPluginSelections: {
            collectionIds: ['global'],
          },
        },
      ],
    });

    const response = await getHandler(IPC_CHANNELS.chatUpdatePlugins)(
      undefined,
      {
        projectId: 'proj',
        worktreeId: 'worktree',
        chatId: 'chat',
        pluginSelections,
        disabledGlobalPluginSelections: {},
      },
    );

    expect(lastCanonicalChatCommand()).toEqual({
      type: 'chat.patch_tab_settings',
      tabId: 'chat',
      patch: {
        pluginSelections,
        disabledGlobalPluginSelections: {},
      },
    });
    expect(response).toEqual({
      pluginSelections,
      disabledGlobalPluginSelections: {},
    });
  });

  it('preserves the provider-owned Claude session id across deferred-tool teardown', async () => {
    const pluginSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Claude chat',
          messages: [],
          createdAt: '2026-07-22T00:00:00.000Z',
          providerType: 'claude',
        },
      ],
    });
    const sessionId = jest.fn<string | undefined, []>(() => 'provider-session');
    mockedGetSession.mockReturnValue({
      ...makeMockSession(),
      getProviderSessionId: sessionId,
    });
    mockedGetSessionProviderType.mockReturnValue('claude');
    mockedGetActiveSessionInfos.mockReturnValue([]);
    mockedDestroySession.mockImplementationOnce(() => {
      sessionId.mockReturnValue(undefined);
      return Promise.resolve();
    });
    const activeReload = jest
      .spyOn(deferredToolsReloadCoordinator, 'hasActiveReload')
      .mockReturnValue(true);
    try {
      const response = await getHandler(IPC_CHANNELS.chatUpdatePlugins)(
        undefined,
        {
          projectId: 'proj',
          worktreeId: 'worktree',
          chatId: 'chat',
          pluginSelections,
        },
      );
      expect(mockedDestroySession).toHaveBeenCalled();
      expect(response.sdkSessionId).toBe('provider-session');
    } finally {
      activeReload.mockRestore();
    }
  });

  it('materializes a direct Codex save from the active provider thread before the renderer has persisted its id', async () => {
    const pluginSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [{ serverId: 'deferred', configId: 'default' }],
    };
    const unsubscribe = jest.fn().mockResolvedValue(undefined);
    const releaseRoutes = jest.fn();
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Codex chat',
          messages: [],
          createdAt: '2026-07-22T00:00:00.000Z',
          providerType: 'codex',
          pluginSelections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
            mcpServerRefs: [],
          },
        },
      ],
    });
    mockedGetSession.mockReturnValue({
      getProviderSessionId: () => 'thread-active',
    } as never);
    mockedGetActiveSessionInfos.mockReturnValue([
      {
        projectId: 'proj',
        worktreeId: 'worktree',
        chatId: 'chat',
        providerType: 'codex',
        turnActive: false,
        pendingMessageCount: 0,
      },
    ] as never);
    mockMaterializeCodexCapabilityTransition.mockResolvedValue({
      handle: {
        threadId: 'thread-materialized',
        unsubscribe,
        delete: jest.fn().mockResolvedValue(undefined),
      },
      snapshotId: 'snapshot-new',
      releaseRoutes,
    });

    const response = await getHandler(IPC_CHANNELS.chatUpdatePlugins)(
      undefined,
      {
        projectId: 'proj',
        worktreeId: 'worktree',
        chatId: 'chat',
        pluginSelections,
        materializeCodexThread: true,
        expectedCurrentThreadId: 'thread-active',
      },
    );

    expect(mockMaterializeCodexCapabilityTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceThreadId: 'thread-active',
        pluginSelections,
      }),
    );
    expect(mockWriteChatTabsFile).toHaveBeenCalledWith(
      'proj',
      'worktree',
      expect.objectContaining({
        tabs: [
          expect.objectContaining({
            sdkSessionId: 'thread-materialized',
            pluginSelections,
          }),
        ],
      }),
    );
    expect(response.sdkSessionId).toBe('thread-materialized');
  });

  it('stages plugin selections for the next turn while a Codex turn is active', async () => {
    const pluginSelections = {
      collectionIds: [],
      skillRefs: [{ sourceId: 'personal', skillName: 'review' }],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Codex chat',
          messages: [],
          createdAt: '2026-07-22T00:00:00.000Z',
          providerType: 'codex',
          model: 'gpt-5.5',
          sdkSessionId: 'thread-active',
        },
      ],
    });
    const session = makeMockSession();
    session.getProviderSessionId = (): string => 'thread-active';
    mockedGetSession.mockReturnValue(session);
    mockedGetActiveSessionInfos.mockReturnValue([
      makeActiveSessionInfo({
        turnActive: true,
      }),
    ]);

    const response = await getHandler(IPC_CHANNELS.chatUpdatePlugins)(
      undefined,
      {
        projectId: 'proj',
        worktreeId: 'worktree',
        chatId: 'chat',
        pluginSelections,
        materializeCodexThread: true,
        expectedCurrentThreadId: 'thread-active',
      },
    );

    expect(response).toEqual({ pluginSelections });
    expect(mockMaterializeCodexCapabilityTransition).not.toHaveBeenCalled();
    expect(mockedDestroySession).not.toHaveBeenCalled();
    expect(mockedMarkSessionForNextTurnRecreation).toHaveBeenCalledWith(
      'proj',
      'worktree',
      'chat',
    );
    expect(updateQueuedHookChatPluginSelectionsMock).toHaveBeenCalledWith({
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      pluginSelections,
      deferredToolsAllowed: undefined,
    });
  });

  it('rejects a non-materializing picker save when its chat tab was removed', async () => {
    const pluginSelections = {
      collectionIds: [],
      skillRefs: [{ sourceId: 'personal', skillName: 'review' }],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: null,
      tabs: [],
    });

    await expect(
      getHandler(IPC_CHANNELS.chatUpdatePlugins)(undefined, {
        projectId: 'proj',
        worktreeId: 'worktree',
        chatId: 'removed-chat',
        pluginSelections,
      }),
    ).rejects.toThrow('Chat tab was not found while updating tools');

    expect(mockedMarkSessionForNextTurnRecreation).not.toHaveBeenCalled();
    expect(updateQueuedHookChatPluginSelectionsMock).not.toHaveBeenCalled();
  });

  it('updates a queued hook placeholder without a canonical chat tab', async () => {
    const pluginSelections = {
      collectionIds: [],
      skillRefs: [{ sourceId: 'personal', skillName: 'review' }],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: null,
      tabs: [],
    });
    hasQueuedHookChatMock.mockReturnValueOnce(true);

    await expect(
      getHandler(IPC_CHANNELS.chatUpdatePlugins)(undefined, {
        projectId: 'proj',
        worktreeId: 'worktree',
        chatId: 'queued-hook-chat',
        pluginSelections,
        deferredToolsAllowed: false,
      }),
    ).resolves.toEqual({ pluginSelections, deferredToolsAllowed: false });

    expect(hasQueuedHookChatMock).toHaveBeenCalledWith({
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'queued-hook-chat',
    });
    expect(updateQueuedHookChatPluginSelectionsMock).toHaveBeenCalledWith({
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'queued-hook-chat',
      pluginSelections,
      deferredToolsAllowed: false,
    });
  });

  it('stages plugin selections for an active Ollama-backed Codex turn', async () => {
    const pluginSelections = {
      collectionIds: [],
      skillRefs: [{ sourceId: 'personal', skillName: 'review' }],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Ollama chat',
          messages: [],
          createdAt: '2026-07-22T00:00:00.000Z',
          providerType: 'ollama',
          model: 'ollama-llama3',
        },
      ],
    });
    mockedGetSession.mockReturnValue(makeMockSession());
    mockedGetActiveSessionInfos.mockReturnValue([
      makeActiveSessionInfo({
        providerType: 'ollama',
        executionHarness: 'codex',
        turnActive: true,
      }),
    ]);

    await getHandler(IPC_CHANNELS.chatUpdatePlugins)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      pluginSelections,
    });

    expect(mockedDestroySession).not.toHaveBeenCalled();
    expect(mockedMarkSessionForNextTurnRecreation).toHaveBeenCalledWith(
      'proj',
      'worktree',
      'chat',
    );
  });

  it('rejects plugin updates with queued Ollama-backed Codex work', async () => {
    mockedGetActiveSessionInfos.mockReturnValue([
      makeActiveSessionInfo({
        providerType: 'ollama',
        executionHarness: 'codex',
        pendingMessageCount: 1,
      }),
    ]);

    await expect(
      getHandler(IPC_CHANNELS.chatUpdatePlugins)(undefined, {
        projectId: 'proj',
        worktreeId: 'worktree',
        chatId: 'chat',
        pluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
        },
      }),
    ).rejects.toThrow(
      'Wait for queued Codex messages to finish before updating tools',
    );
  });

  it('rejects stale plugin selections while a Codex turn is active', async () => {
    const pluginSelections = {
      collectionIds: [],
      skillRefs: [{ sourceId: 'personal', skillName: 'review' }],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Codex chat',
          messages: [],
          createdAt: '2026-07-22T00:00:00.000Z',
          providerType: 'codex',
          model: 'gpt-5.5',
          sdkSessionId: 'thread-current',
        },
      ],
    });
    const session = makeMockSession();
    session.getProviderSessionId = (): string => 'thread-current';
    mockedGetSession.mockReturnValue(session);
    mockedGetActiveSessionInfos.mockReturnValue([
      makeActiveSessionInfo({ turnActive: true }),
    ]);

    await expect(
      getHandler(IPC_CHANNELS.chatUpdatePlugins)(undefined, {
        projectId: 'proj',
        worktreeId: 'worktree',
        chatId: 'chat',
        pluginSelections,
        materializeCodexThread: true,
        expectedCurrentThreadId: 'thread-stale',
      }),
    ).rejects.toThrow('Chat changed while tools were being updated');

    expect(mockMaterializeCodexCapabilityTransition).not.toHaveBeenCalled();
    expect(mockedMarkSessionForNextTurnRecreation).not.toHaveBeenCalled();
  });

  it('keeps a first Codex turn active when selections are staged before its thread id is persisted', async () => {
    const pluginSelections = {
      collectionIds: ['review-tools'],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    const session = makeMockSession();
    session.getProviderSessionId = (): undefined => undefined;
    mockedGetSession.mockReturnValue(session);
    mockedGetActiveSessionInfos.mockReturnValue([
      makeActiveSessionInfo({
        turnActive: true,
      }),
    ]);

    const response = await getHandler(IPC_CHANNELS.chatUpdatePlugins)(
      undefined,
      {
        projectId: 'proj',
        worktreeId: 'worktree',
        chatId: 'chat',
        pluginSelections,
      },
    );

    expect(response).toEqual({ pluginSelections });
    expect(mockReadChatTabsFile).toHaveBeenCalledWith('proj', 'worktree');
    expect(mockedDestroySession).not.toHaveBeenCalled();
    expect(mockedMarkSessionForNextTurnRecreation).toHaveBeenCalledWith(
      'proj',
      'worktree',
      'chat',
    );
  });

  it('rejects plugin updates when a Codex message queues before teardown', async () => {
    const pluginSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [{ serverId: 'deferred', configId: 'default' }],
    };
    mockedGetSession.mockReturnValue(makeMockSession());
    mockedGetActiveSessionInfos
      .mockReturnValueOnce([makeActiveSessionInfo()])
      .mockReturnValueOnce([makeActiveSessionInfo({ pendingMessageCount: 1 })]);

    await expect(
      getHandler(IPC_CHANNELS.chatUpdatePlugins)(undefined, {
        projectId: 'proj',
        worktreeId: 'worktree',
        chatId: 'chat',
        pluginSelections,
      }),
    ).rejects.toThrow(
      'Wait for queued Codex messages to finish before updating tools',
    );

    expect(mockedMarkSessionForNextTurnRecreation).not.toHaveBeenCalled();
    expect(mockedDestroySession).not.toHaveBeenCalled();
    expect(updateQueuedHookChatPluginSelectionsMock).not.toHaveBeenCalled();
    expect(mockClaudeTerminalUpdateDeferredToolsContext).not.toHaveBeenCalled();
  });

  it('rejects queued Codex work before committing a materialized thread', async () => {
    const pluginSelections = {
      collectionIds: [],
      skillRefs: [{ sourceId: 'personal', skillName: 'review' }],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    const removeProvisionalThread = jest.fn().mockResolvedValue(undefined);
    const releaseRoutes = jest.fn();
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Codex chat',
          messages: [],
          createdAt: '2026-07-22T00:00:00.000Z',
          providerType: 'codex',
          sdkSessionId: 'thread-old',
        },
      ],
    });
    mockedGetActiveSessionInfos
      .mockReturnValueOnce([makeActiveSessionInfo()])
      .mockReturnValueOnce([makeActiveSessionInfo()])
      .mockReturnValueOnce([makeActiveSessionInfo({ pendingMessageCount: 1 })]);
    mockMaterializeCodexCapabilityTransition.mockResolvedValue({
      handle: {
        threadId: 'thread-new',
        unsubscribe: jest.fn().mockResolvedValue(undefined),
        delete: removeProvisionalThread,
      },
      snapshotId: 'snapshot-new',
      releaseRoutes,
    });

    await expect(
      getHandler(IPC_CHANNELS.chatUpdatePlugins)(undefined, {
        projectId: 'proj',
        worktreeId: 'worktree',
        chatId: 'chat',
        pluginSelections,
        materializeCodexThread: true,
        expectedCurrentThreadId: 'thread-old',
      }),
    ).rejects.toThrow(
      'Wait for queued Codex messages to finish before updating tools',
    );

    expect(mockWriteChatTabsFile).not.toHaveBeenCalled();
    expect(removeProvisionalThread).toHaveBeenCalledTimes(1);
    expect(releaseRoutes).toHaveBeenCalledTimes(1);
    expect(updateQueuedHookChatPluginSelectionsMock).not.toHaveBeenCalled();
  });

  it('validates plugin-update identifiers before reading chat files', async () => {
    jest.mocked(validateId).mockImplementationOnce(() => {
      throw new Error('Invalid projectId');
    });

    await expect(
      getHandler(IPC_CHANNELS.chatUpdatePlugins)(undefined, {
        projectId: '../escape',
        worktreeId: 'worktree',
        chatId: 'chat',
        pluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
        },
        materializeCodexThread: true,
      }),
    ).rejects.toThrow('Invalid projectId');

    expect(mockReadChatTabsFile).not.toHaveBeenCalled();
  });

  it('deletes the provisional Codex thread when the tab commit fails', async () => {
    const oldSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    const nextSelections = {
      ...oldSelections,
      skillRefs: [{ sourceId: 'personal', skillName: 'review' }],
    };
    const removeProvisionalThread = jest.fn().mockResolvedValue(undefined);
    const releaseRoutes = jest.fn();
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Codex chat',
          messages: [],
          createdAt: '2026-07-22T00:00:00.000Z',
          providerType: 'codex',
          sdkSessionId: 'thread-old',
          pluginSelections: oldSelections,
        },
      ],
    });
    mockMaterializeCodexCapabilityTransition.mockResolvedValue({
      handle: {
        threadId: 'thread-new',
        unsubscribe: jest.fn().mockResolvedValue(undefined),
        delete: removeProvisionalThread,
      },
      snapshotId: 'snapshot-new',
      releaseRoutes,
    });
    mockWriteChatTabsFile.mockRejectedValueOnce(new Error('disk full'));

    await expect(
      getHandler(IPC_CHANNELS.chatUpdatePlugins)(undefined, {
        projectId: 'proj',
        worktreeId: 'worktree',
        chatId: 'chat',
        pluginSelections: nextSelections,
        materializeCodexThread: true,
        expectedCurrentThreadId: 'thread-old',
      }),
    ).rejects.toThrow('disk full');

    expect(removeProvisionalThread).toHaveBeenCalledTimes(1);
    expect(releaseRoutes).toHaveBeenCalledTimes(1);
    expect(updateQueuedHookChatPluginSelectionsMock).not.toHaveBeenCalled();
  });

  it('does not write the legacy chat-history meta mirror for cowork plugin updates', async () => {
    const pluginSelections = {
      collectionIds: ['bundle-a'],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    };

    await getHandler(IPC_CHANNELS.chatUpdatePlugins)(undefined, {
      projectId: 'cowork-default',
      worktreeId: 'home',
      chatId: 'chat',
      pluginSelections,
      deferredToolsAllowed: false,
    });

    // Work Entries: plugin selections persist on the tab file via the
    // renderer's debounced tab save; the chat-history meta mirror is gone.
    expect(mockedUpdateChatMeta).not.toHaveBeenCalled();
    expect(mockClaudeTerminalUpdateDeferredToolsContext).toHaveBeenCalledWith(
      'cowork-default',
      'home',
      'chat',
      { pluginSelections, deferredToolsAllowed: false },
    );
    expect(updateQueuedHookChatPluginSelectionsMock).toHaveBeenCalledWith({
      projectId: 'cowork-default',
      worktreeId: 'home',
      chatId: 'chat',
      pluginSelections,
      deferredToolsAllowed: false,
    });
  });

  it('does not persist plugin selections for a plain git worktree chat', async () => {
    await getHandler(IPC_CHANNELS.chatUpdatePlugins)(undefined, {
      projectId: 'proj',
      worktreeId: 'worktree',
      chatId: 'chat',
      pluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
    });

    expect(mockedUpdateChatMeta).not.toHaveBeenCalled();
  });
});

describe('chat IPC activeSessions', () => {
  const mockedGetActiveChatIds = jest.mocked(getActiveChatIds);
  const mockedGetActiveSessionInfos = jest.mocked(getActiveSessionInfos);

  beforeEach(() => {
    jest.clearAllMocks();
    registerChatHandlers(makeWindowAccessors());
  });

  it('returns sessions entries for registered idle sessions alongside active ones', async () => {
    const now = Date.now();
    mockedGetActiveChatIds.mockReturnValue(['chat-active']);
    mockedGetActiveSessionInfos.mockReturnValue([
      {
        chatId: 'chat-active',
        projectId: 'proj',
        worktreeId: 'worktree',
        providerType: 'claude',
        model: 'claude-sonnet-4-6',
        turnActive: true,
        createdAt: now - 5_000,
        lastActivityAt: now - 100,
        turnStartedAt: now - 200,
        turnCount: 1,
        pendingMessageCount: 0,
        lastEventType: 'assistant',
      },
      {
        chatId: 'chat-idle',
        projectId: 'proj',
        worktreeId: 'worktree',
        providerType: 'codex',
        model: 'gpt-5.5',
        turnActive: false,
        createdAt: now - 30_000,
        lastActivityAt: now - 10_000,
        turnCount: 1,
        pendingMessageCount: 0,
        lastEventType: 'codex:turn.completed',
      },
    ]);

    const result = expectChatActiveSessions(
      await getHandler(IPC_CHANNELS.chatActiveSessions)(undefined, {
        projectId: 'proj',
        worktreeId: 'worktree',
      }),
    );

    expect(mockedGetActiveSessionInfos).toHaveBeenCalledWith(
      'proj',
      'worktree',
    );
    expect(result.activeChatIds).toEqual(['chat-active']);
    expect(result.sessions).toHaveLength(2);

    const idle = (result.sessions ?? []).find(
      (entry) => entry.chatId === 'chat-idle',
    );
    expect(idle).toBeDefined();
    if (!idle) {
      throw new Error('Expected idle session entry in sessions');
    }

    // Required guarantees from the transport plan: each entry carries the
    // identifying + diagnostic fields consumed by the renderer.
    expect(idle).toMatchObject({
      chatId: 'chat-idle',
      projectId: 'proj',
      worktreeId: 'worktree',
      providerType: 'codex',
      model: 'gpt-5.5',
      turnActive: false,
      lastEventType: 'codex:turn.completed',
    });
    expect(typeof idle.lastActivityAt).toBe('number');

    // providerType must be a real provider value, not a hardcoded default.
    expect(idle.providerType).not.toBe('claude');
  });
});
