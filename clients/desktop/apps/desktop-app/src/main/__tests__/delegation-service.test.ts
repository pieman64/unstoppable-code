import type { SessionDiagnosticRecord } from '../observability/service';
import type { AgentSessionOptions } from '../agents/types';
import { routeFixture } from '@canopy/desktop-shared/node/delegation/__tests__/fixtures';
const mockRecordDelegationDiagnostic = jest.fn<
  void,
  [SessionDiagnosticRecord]
>();
jest.mock('../observability', () => ({
  getObservabilityService: (): {
    recordSessionDiagnostic: typeof mockRecordDelegationDiagnostic;
  } => ({ recordSessionDiagnostic: mockRecordDelegationDiagnostic }),
}));
import type { CanopyCloudAccountEntry } from '../lib/canopy-cloud-account-store';
import type {
  AgentDelegationWorkspaceObservation,
  DelegationParentContext,
  ResolvedAgentRouteSnapshot,
} from '@canopy/desktop-shared/node/delegation';
import type {
  AgentDelegationBrokerOptions,
  StoredDelegation,
} from '@canopy/desktop-shared/node/delegation/broker';
import { createDelegationRunState } from '@canopy/desktop-shared/node/delegation/lifecycle';
import type { DelegationDeliveryTransport } from '@canopy/desktop-shared/node/delegation/delivery';
import type {
  DelegationContinuationCandidate,
  DelegationLineage,
} from '@canopy/desktop-shared/node/delegation/broker';
import type { AgentRunRequest } from '@canopy/desktop-shared/node/delegation';
import type { LocalDelegationContext } from '@canopy/desktop-shared/node/delegation/local-runner';
import type * as LedgerToolsModule from '../agents/delegation/ledger-tools';
import type {
  ChildLedgerRunContext,
  ChildLedgerTools,
} from '../agents/delegation/ledger-tools';
import { readLedgerContainerLiveDelegates } from '../ledger/delegate-owners';
import {
  isAgentDelegationTranscript,
  type AgentDelegationResult,
  type AgentDelegationSnapshot,
  type AgentDelegationSpawnRequest,
  type AgentDelegationTranscript,
  type DelegationListFilter,
} from '@canopy/protocol/delegation';
import type { DelegationStopReason } from '@canopy/desktop-shared/node/delegation/types';
import {
  IPC_CHANNELS,
  type ChatStateChangedEvent,
  type PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type { ChatReadSelection } from '../services/chat-state-v2-backend';
import type { ProviderEventIngestOutcome } from '../services/chat-state-service';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { DELEGATION_CARD_SETTLED_INTERVAL_MS } from '../agents/delegation/card-publication';
let account: CanopyCloudAccountEntry = {
  apiKey: 'selected-cloud-credential',
  capabilities: [],
  createdAt: 'initial',
  updatedAt: 'initial',
};
let accountChanged:
  | ((entry: CanopyCloudAccountEntry | null) => void)
  | undefined;
jest.mock('../lib/canopy-cloud-account-store', () => ({
  loadCanopyCloudAccount: (): Promise<CanopyCloudAccountEntry> =>
    Promise.resolve(account),
  subscribeCanopyCloudAccountChanges: (
    callback: (entry: CanopyCloudAccountEntry | null) => void,
  ): (() => void) => {
    accountChanged = callback;
    return () => undefined;
  },
}));
// Live delegate snapshots also go to Portal; this suite drives none, and the
// real event bus would subscribe to the account changes mocked above.
jest.mock('../portal/portal-event-bus', () => ({
  isCanopyPortalActive: (): boolean => false,
  enqueuePortalEvent: jest.fn(),
  createPortalEvent: jest.fn(),
}));
import path from 'node:path';
import { FileDelegationStorage } from '@canopy/desktop-shared/node/delegation/storage';
import {
  createManagedDelegationSession,
  deliverManagedDelegationWatcherToChild,
  shutdownManagedDelegations,
  stopAllManagedDelegationsForUser,
  readManagedDelegationChangesForUser,
  stopManagedDelegationForUser,
  updateManagedDelegationMaxConcurrent,
  updateManagedDelegationPolicy,
  revokeManagedDelegations,
} from '../agents/delegation/service';
import {
  claimDelegationDelivery,
  closeDelegationScope,
  hasDelegationLifecycle,
  isDelegationDeliveryActive,
  retireDelegationDelivery,
} from '../agents/delegation/lifecycle';
import {
  clearLiveApprovalMode,
  setLiveApprovalMode,
} from '../approvals/live-approval-modes';
import { ManagedChildMessageInbox } from '../agents/delegation/child-messages';
import { hasLiveDelegations } from '../agents/delegation/activity';
import * as windowSend from '../lib/window-send';

const closeBroker = jest.fn(() => Promise.resolve());
const initializeBroker = jest.fn(() => Promise.resolve());
const replayQueuedBackground = jest.fn(() => Promise.resolve());
const transcripts = jest.fn<
  Promise<readonly AgentDelegationTranscript[]>,
  [DelegationParentContext]
>(() => Promise.resolve([]));
const deliver = jest.fn(
  (
    _parent: DelegationParentContext,
    id: string,
    channel: 'foreground' | 'background',
    transport: DelegationDeliveryTransport,
  ): Promise<undefined> => {
    void transport.dispatch(id, channel);
    return Promise.resolve(undefined);
  },
);
const dispatchLocalWorktreeChatMessage = jest.fn<
  Promise<void>,
  [{ readonly text: string }]
>(() => Promise.resolve());
const buildExistingTabDispatchOptions = jest.fn(() => Promise.resolve({}));
type ResolveBrokerCwd = (parent: DelegationParentContext) => string | undefined;
type ObserveBrokerParentWorkspace = (
  parent: DelegationParentContext,
  signal: AbortSignal,
) => Promise<AgentDelegationWorkspaceObservation>;
let resolveBrokerCwd: ResolveBrokerCwd | undefined;
let observeBrokerParentWorkspace: ObserveBrokerParentWorkspace | undefined;
let resolveBrokerRoute: AgentDelegationBrokerOptions['resolveRoute'];
let resolveBrokerHostParent: AgentDelegationBrokerOptions['resolveHostParent'];
let manageBrokerWorkspace: AgentDelegationBrokerOptions['manageWorkspace'];
let capturedAdmission: AgentDelegationBrokerOptions['admission'];
let capturedPreflight: AgentDelegationBrokerOptions['preflight'];
let capturedOnActivity: AgentDelegationBrokerOptions['onActivity'];
let capturedIsParentActive: AgentDelegationBrokerOptions['isParentActive'];
let capturedOnTranscript: AgentDelegationBrokerOptions['onTranscript'];
let capturedDeliverUpward: AgentDelegationBrokerOptions['deliverUpward'];
const mockRevokeHarness = jest.fn<Promise<void>, [string]>(() =>
  Promise.resolve(),
);
const closeOwner = jest.fn<
  Promise<void>,
  [DelegationParentContext, DelegationStopReason]
>(() => Promise.resolve());
function defaultBrokerStop(
  _parent: DelegationParentContext,
  id: string,
): Promise<AgentDelegationResult<AgentDelegationSnapshot>> {
  return Promise.resolve({
    ok: true,
    value: { delegationId: id, status: 'cancelled', outputTruncated: false },
  });
}
const brokerStop = jest.fn<
  Promise<AgentDelegationResult<AgentDelegationSnapshot>>,
  [DelegationParentContext, string, DelegationStopReason?]
>(defaultBrokerStop);
const brokerList = jest.fn<
  readonly AgentDelegationSnapshot[],
  [DelegationParentContext, DelegationListFilter?]
>(() => []);
const mockRemoveDelegateWatchers = jest.fn<
  Promise<void>,
  [
    { projectId: string; worktreeId: string; chatId: string },
    ReadonlySet<string>?,
  ]
>(() => Promise.resolve());
jest.mock('../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: (): {
    removeDelegateWatchersForChat: typeof mockRemoveDelegateWatchers;
  } => ({ removeDelegateWatchersForChat: mockRemoveDelegateWatchers }),
}));
const brokerActiveCount = jest.fn<number, [DelegationParentContext]>(() => 0);
const brokerQueuedCount = jest.fn<number, [DelegationParentContext]>(() => 0);
jest.mock('@canopy/desktop-shared/node/delegation/broker', () => ({
  AgentDelegationBroker: jest.fn((options: AgentDelegationBrokerOptions) => {
    resolveBrokerCwd = options.resolveCwd;
    observeBrokerParentWorkspace = options.observeParentWorkspace;
    resolveBrokerRoute = options.resolveRoute;
    resolveBrokerHostParent = options.resolveHostParent;
    manageBrokerWorkspace = options.manageWorkspace;
    capturedAdmission = options.admission;
    capturedPreflight = options.preflight;
    capturedOnActivity = options.onActivity;
    capturedIsParentActive = options.isParentActive;
    capturedOnTranscript = options.onTranscript;
    capturedDeliverUpward = options.deliverUpward;
    return {
      initialize: initializeBroker,
      parentCwd: (parent: DelegationParentContext): string =>
        options.resolveCwd?.(parent) ?? options.cwd,
      replayQueuedBackground,
      transcripts,
      deliver,
      inspect: (): { runGeneration: number } => ({ runGeneration: 1 }),
      list: brokerList,
      activeCount: brokerActiveCount,
      queuedCount: brokerQueuedCount,
      stop: brokerStop,
      close: closeBroker,
      closeOwner,
      revokeHarness: mockRevokeHarness,
      childContext: (
        ...args: Parameters<typeof mockChildContext>
      ): ReturnType<typeof mockChildContext> => mockChildContext(...args),
      continuationCandidates: (
        ...args: Parameters<typeof mockContinuationCandidates>
      ): ReturnType<typeof mockContinuationCandidates> =>
        mockContinuationCandidates(...args),
      delegationLineage: (
        ...args: Parameters<typeof mockDelegationLineage>
      ): ReturnType<typeof mockDelegationLineage> =>
        mockDelegationLineage(...args),
    };
  }),
}));
const mockChildContext = jest.fn<
  DelegationParentContext | undefined,
  [AgentRunRequest, string, string?]
>(() => undefined);
const mockContinuationCandidates = jest.fn<
  readonly DelegationContinuationCandidate[],
  [{ projectId: string; worktreeId: string }]
>(() => []);
const mockDelegationLineage = jest.fn<DelegationLineage | undefined, [string]>(
  () => undefined,
);
const mockOpenChildLedgerTools = jest.fn<
  Promise<ChildLedgerTools | null>,
  [AgentRunRequest, ChildLedgerRunContext]
>(() => Promise.resolve(null));
jest.mock('../agents/delegation/ledger-tools', () => ({
  ...jest.requireActual<typeof LedgerToolsModule>(
    '../agents/delegation/ledger-tools',
  ),
  openChildLedgerTools: (
    ...args: Parameters<typeof mockOpenChildLedgerTools>
  ): ReturnType<typeof mockOpenChildLedgerTools> =>
    mockOpenChildLedgerTools(...args),
}));
let managedWorkspaceOwnerCwd: string | undefined;
const mockManageIsolatedDelegationWorkspace = jest.fn(
  (options: { owner: () => { cwd: string } | undefined }): Promise<void> => {
    managedWorkspaceOwnerCwd = options.owner()?.cwd;
    return Promise.resolve();
  },
);
const mockReadIsolatedDelegationChanges = jest.fn<
  Promise<{ files: [] }>,
  [{ directory: string; delegationId: string; revision: string }]
>(() => Promise.resolve({ files: [] }));
jest.mock('../agents/delegation/manage-workspace', () => ({
  manageIsolatedDelegationWorkspace: (options: {
    owner: () => { cwd: string } | undefined;
  }): Promise<void> => mockManageIsolatedDelegationWorkspace(options),
  readIsolatedDelegationChanges: (options: {
    directory: string;
    delegationId: string;
    revision: string;
  }): Promise<{ files: [] }> => mockReadIsolatedDelegationChanges(options),
}));
const ingestProviderEvent = jest.fn<Promise<void>, [event: unknown]>(() =>
  Promise.resolve(),
);
// Detached card publication reads the three-way outcome. By default it records
// through the commit mock above and reports no durable commit, as before.
const ingestProviderEventWithOutcome = jest.fn<
  Promise<ProviderEventIngestOutcome>,
  [event: unknown]
>(async (event) => {
  await ingestProviderEvent(event);
  return 'not-applied';
});
/** Delegate log appends from chat roots, resolved at once by default. */
const appendDelegationItems = jest.fn<
  Promise<boolean>,
  [scope: unknown, chatId: string, runs: Array<{ items: unknown[] }>]
>(() => Promise.resolve(true));
const mockGetSession = jest.fn<unknown, unknown[]>(() => undefined);
const getCompatibilityTabs = jest.fn<
  Promise<{
    version: number;
    activeTabId: string | null;
    tabs: PersistedChatTab[];
  }>,
  [scope: unknown, selection?: ChatReadSelection]
>(() => Promise.resolve({ version: 1, activeTabId: null, tabs: [] }));
const getCompatibilityArchives = jest.fn<
  Promise<{
    version: number;
    archived: { tab: PersistedChatTab; archivedAt: string }[];
  }>,
  [scope: unknown, selection?: ChatReadSelection]
>(() => Promise.resolve({ version: 1, archived: [] }));
/**
 * Mirrors the canonical store: unselected transcripts throw on access, and a
 * selection without `fullTranscript` returns only the latest page.
 */
function selectedTab(
  tab: PersistedChatTab,
  selection: ChatReadSelection | undefined,
): PersistedChatTab {
  if (!selection?.chatIds?.includes(tab.id)) {
    const guarded: PersistedChatTab = { ...tab };
    Object.defineProperty(guarded, 'messages', {
      get: (): never => {
        throw new Error(
          `Transcript ${tab.id} was not selected for this operation`,
        );
      },
    });
    return guarded;
  }
  return selection.fullTranscript
    ? tab
    : { ...tab, messages: tab.messages.slice(-1) };
}
/** Listeners of committed canonical chat state, like the real service's. */
const mockChatStateListeners = new Set<
  (event: ChatStateChangedEvent) => void
>();
function commitChatState(
  scope: { projectId: string; worktreeId: string },
  changes: ChatStateChangedEvent['changes'],
): void {
  const event: ChatStateChangedEvent = {
    schemaVersion: 1,
    eventId: `event-${String(Math.random())}`,
    occurredAt: new Date().toISOString(),
    projectId: scope.projectId,
    worktreeId: scope.worktreeId,
    baseRevision: 1,
    revision: 2,
    changes,
  };
  for (const listener of Array.from(mockChatStateListeners)) listener(event);
}
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: (): {
    getCompatibilityTabs: typeof getCompatibilityTabs;
    getCompatibilityArchives: typeof getCompatibilityArchives;
    ingestProviderEvent: typeof ingestProviderEvent;
    ingestProviderEventWithOutcome: typeof ingestProviderEventWithOutcome;
    appendDelegationItems: typeof appendDelegationItems;
    subscribe: (listener: (event: ChatStateChangedEvent) => void) => () => void;
  } => ({
    getCompatibilityTabs,
    getCompatibilityArchives,
    ingestProviderEvent,
    ingestProviderEventWithOutcome,
    appendDelegationItems,
    subscribe: (listener): (() => void) => {
      mockChatStateListeners.add(listener);
      return () => mockChatStateListeners.delete(listener);
    },
  }),
}));
jest.mock('../services/chat-service', () => ({
  dispatchLocalWorktreeChatMessage,
  buildExistingTabDispatchOptions,
}));
const runtimeResolve = jest.fn();
const runtimeRelease = jest.fn();
const runtimeDispose = jest.fn();
const runtimeRevokeHarness = jest.fn();
const runtimeDiscoverCapabilities = jest.fn(() =>
  Promise.resolve({ capabilities: [] }),
);
let capturedRuntimeOwner:
  | ((parent: DelegationParentContext) => AgentSessionOptions | undefined)
  | undefined;
jest.mock('../agents/delegation/route-runtime', () => ({
  DelegationRouteRuntime: jest.fn(
    (options: {
      owner: (
        parent: DelegationParentContext,
      ) => AgentSessionOptions | undefined;
    }) => {
      capturedRuntimeOwner = options.owner;
      return {
        resolve: runtimeResolve,
        release: runtimeRelease,
        dispose: runtimeDispose,
        discoverCapabilities: runtimeDiscoverCapabilities,
        retainsRoute: (): boolean => false,
        withdrawPreparation: (): void => undefined,
        revokeHarness: runtimeRevokeHarness,
      };
    },
  ),
}));
const mockClaudeRunnerOptions: {
  ledger?: (
    context: LocalDelegationContext,
  ) => Promise<ChildLedgerTools | undefined>;
}[] = [];
jest.mock('../agents/delegation/claude-runner', () => ({
  createClaudeDelegationRunner: (options: {
    ledger?: (
      context: LocalDelegationContext,
    ) => Promise<ChildLedgerTools | undefined>;
  }): {
    harnessId: string;
    version: string;
    capabilities: readonly string[];
  } => {
    mockClaudeRunnerOptions.push(options);
    return {
      harnessId: 'claude',
      version: '1',
      capabilities: [],
    };
  },
}));
jest.mock('../agents/delegation/codex-runner', () => ({
  createCodexDelegationRunner: (): {
    harnessId: string;
    version: string;
    capabilities: readonly string[];
  } => ({
    harnessId: 'codex',
    version: '1',
    capabilities: [],
  }),
}));
jest.mock('../agents/delegation/cursor-runner', () => ({
  createCursorDelegationRunner: (): {
    harnessId: string;
    version: string;
    capabilities: string[];
  } => ({
    harnessId: 'cursor',
    version: '1',
    capabilities: [],
  }),
}));
jest.mock('../cursor/connection', () => ({
  getCursorAccountGeneration: (): number => 1,
}));
jest.mock('../agents/delegation/copilot-runner', () => ({
  createCopilotDelegationRunner: (): {
    harnessId: string;
    version: string;
    capabilities: string[];
  } => ({
    harnessId: 'copilot',
    version: '1',
    capabilities: [],
  }),
}));
jest.mock('../copilot/connection', () => ({
  getCopilotAccountGeneration: (): number => 1,
}));
jest.mock('../agents/delegation/opencode-runner', () => ({
  createOpenCodeDelegationRunner: (): {
    harnessId: string;
    version: string;
    capabilities: string[];
  } => ({
    harnessId: 'opencode',
    version: '1',
    capabilities: [],
  }),
}));
jest.mock('../opencode/connection', () => ({
  getOpenCodeConnectionGeneration: (): number => 1,
}));
const mockObserveDelegationWorkspace = jest.fn(() =>
  Promise.resolve({
    consistency: 'live_shared_worktree' as const,
    headRevision: null,
    dirty: null,
    observedAt: Date.now(),
  }),
);
jest.mock('../agents/delegation/workspace-observation', () => ({
  observeDelegationWorkspace: (
    cwd: string,
    signal: AbortSignal,
  ): ReturnType<typeof mockObserveDelegationWorkspace> =>
    mockObserveDelegationWorkspace(cwd, signal),
}));
jest.mock('@canopy/desktop-shared/node/delegation/runner-registry', () => ({
  AgentRunnerRegistry: jest.fn(() => ({ register: jest.fn() })),
}));
jest.mock('../agents/session-manager', () => ({
  getSession: (...args: unknown[]): unknown => mockGetSession(...args),
  getProviderAuthGeneration: (): number => 1,
  getSessionPluginSelections: (): undefined => undefined,
  getSessionGlobalPluginDefaultsRevision: (): undefined => undefined,
  getGlobalPluginDefaultsRevision: (): number => 0,
  subscribeGlobalPluginDefaultsRevision: (): (() => void) => () => undefined,
}));
jest.mock('../agents/agent-model-store', () => ({
  listAgentModels: (): Promise<readonly never[]> => Promise.resolve([]),
}));
const mockGetAuthoritativeConfiguredModel = jest.fn<
  { enabled: boolean } | undefined,
  [string]
>(() => ({ enabled: true }));
jest.mock('../lib/model-config', () => ({
  getAuthoritativeConfiguredModel: (
    modelId: string,
  ): { enabled: boolean } | undefined =>
    mockGetAuthoritativeConfiguredModel(modelId),
}));
const mockResolveAgentModelRuntime = jest.fn<
  Promise<{
    selectedModel: string;
    runtimeModel: string;
    providerType: string;
    executionHarness: 'claude' | 'codex';
    systemPromptAppend: undefined;
    pluginSelections: undefined;
  }>,
  [{ model: string }]
>(({ model }) =>
  Promise.resolve({
    selectedModel: model,
    runtimeModel: model,
    providerType: 'anthropic',
    executionHarness: 'claude',
    systemPromptAppend: undefined,
    pluginSelections: undefined,
  }),
);
jest.mock('../agents/agent-model-runtime', () => ({
  resolveAgentModelRuntime: (options: {
    model: string;
  }): ReturnType<typeof mockResolveAgentModelRuntime> =>
    mockResolveAgentModelRuntime(options),
}));
const mockIsModelBlockedByStoredPolicy = jest.fn<Promise<boolean>, [string]>(
  () => Promise.resolve(false),
);
jest.mock('../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: (
    modelId: string,
  ): ReturnType<typeof mockIsModelBlockedByStoredPolicy> =>
    mockIsModelBlockedByStoredPolicy(modelId),
}));
jest.mock('../lib/paths', () => ({
  getWorktreeDataDir: (project: string, worktree: string): string =>
    path.join('/private/state', project, worktree),
}));
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));
const mockWakeLockAcquire = jest.fn();
const mockWakeLockRelease = jest.fn();
jest.mock('../power/wake-lock-service', () => ({
  getWakeLockService: (): {
    acquire: typeof mockWakeLockAcquire;
    release: typeof mockWakeLockRelease;
  } => ({
    acquire: mockWakeLockAcquire,
    release: mockWakeLockRelease,
  }),
}));

it('does not install a lifecycle or subscribe to account changes merely by loading its bundle', () => {
  expect(hasDelegationLifecycle()).toBe(false);
  expect(accountChanged).toBeUndefined();
});

it('lists changes only from the starting revision the delegation recorded', async () => {
  const recorded = 'a'.repeat(40);
  const loadOne = jest
    .spyOn(FileDelegationStorage.prototype, 'loadOne')
    .mockResolvedValue({
      isolationRevision: recorded,
    } as Awaited<ReturnType<FileDelegationStorage['loadOne']>>);
  const scope = { projectId: 'project', worktreeId: 'worktree' };
  const signal = new AbortController().signal;
  try {
    await expect(
      readManagedDelegationChangesForUser(
        scope,
        'delegation',
        'b'.repeat(40),
        signal,
      ),
    ).rejects.toThrow("isn't this delegate's starting revision");
    expect(mockReadIsolatedDelegationChanges).not.toHaveBeenCalled();

    await readManagedDelegationChangesForUser(
      scope,
      'delegation',
      recorded,
      signal,
    );
    expect(loadOne).toHaveBeenCalledWith('delegation');
    expect(mockReadIsolatedDelegationChanges).toHaveBeenCalledWith(
      expect.objectContaining({
        directory: path.join('/private/state/project/worktree/delegation'),
        delegationId: 'delegation',
        revision: recorded,
      }),
    );
  } finally {
    loadOne.mockRestore();
  }
});

it('defers a delegate watcher notification while its recipient actor is unloaded', async () => {
  const scope = { projectId: 'unloaded-recipient', worktreeId: 'worktree' };
  await expect(
    deliverManagedDelegationWatcherToChild(
      scope,
      'delegate-id',
      'completion',
      'delivery-id',
    ),
  ).rejects.toHaveProperty('name', 'WatcherRecipientNotReadyError');
  const send = jest
    .spyOn(ManagedChildMessageInbox.prototype, 'deliver')
    .mockResolvedValue({ ok: true, value: { status: 'accepted' } });
  const options = { ...scope, chatId: 'chat', cwd: '/root/worktree' };
  const session = await createManagedDelegationSession({
    harness: 'claude',
    sessionKey: 'unloaded-recipient/worktree/chat',
    currentOptions: () => options,
    currentTurn: () => 'turn',
    getWindow: () => null,
  });
  try {
    await expect(
      deliverManagedDelegationWatcherToChild(
        scope,
        'delegate-id',
        'completion',
        'delivery-id',
      ),
    ).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledWith(
      'delegate-id',
      'completion',
      'delivery-id',
      'The delegate watch notification could not be delivered.',
      undefined,
    );
  } finally {
    send.mockRestore();
    session.detach();
    await closeDelegationScope(options);
  }
});

it('resolves an idle parent for a background child result using its saved turn', async () => {
  const options = {
    projectId: 'idle-parent-project',
    worktreeId: 'worktree',
    chatId: 'chat',
    cwd: '/worktree',
  };
  let currentTurn: string | undefined = 'original-turn';
  const session = await createManagedDelegationSession({
    harness: 'claude',
    sessionKey: 'idle-parent-project/worktree/chat',
    currentOptions: () => options,
    currentTurn: () => currentTurn,
    getWindow: () => null,
  });
  try {
    const saved = session.parent.context('original-turn', 'delegate-call');
    if (!saved) throw new Error('Expected active parent context');
    currentTurn = undefined;
    expect(resolveBrokerHostParent?.(saved)).toMatchObject({
      runtimeGeneration: saved.runtimeGeneration,
      turnId: 'original-turn',
      toolCallId: 'delegate-call',
    });
  } finally {
    session.detach();
    await closeDelegationScope(options);
  }
});

it('uses an isolated delegate creation base after its parent context changes', async () => {
  const options = {
    projectId: 'isolated-base-project',
    worktreeId: 'worktree',
    chatId: 'chat',
    cwd: '/root/worktree',
  };
  const session = await createManagedDelegationSession({
    harness: 'claude',
    sessionKey: 'isolated-base-project/worktree/chat',
    currentOptions: () => options,
    currentTurn: () => 'turn',
    getWindow: () => null,
  });
  try {
    const resumedParent = session.parent.context();
    if (!resumedParent || !manageBrokerWorkspace)
      throw new Error('Expected workspace management callback');
    const record: StoredDelegation = {
      version: 1,
      depth: 2,
      parentDelegationId: 'isolated-parent',
      parent: { ...resumedParent, depth: 0 },
      task: {
        modelId: 'reviewer',
        description: 'Review code',
        prompt: 'Review the implementation.',
        executionMode: 'background',
        contextPolicy: 'task_only',
        isolation: 'worktree',
      },
      callKey: 'call-key',
      requestHash: 'a'.repeat(64),
      createdAt: 1,
      executionCwd: '/isolated/grandchild',
      isolationBaseCwd: '/isolated/parent',
      isolationRevision: 'b'.repeat(40),
      state: createDelegationRunState('grandchild', 1),
      launch: {
        version: 1,
        delegationId: 'grandchild',
        launchKey: 'call-key',
        runGeneration: 1,
        phase: 'settled',
        terminalStatus: 'completed',
      },
      delivery: { status: 'unclaimed' },
    };

    await manageBrokerWorkspace(
      resumedParent,
      record,
      'apply',
      new AbortController().signal,
      {
        approvalPending: (): Promise<void> => Promise.resolve(),
        awaitingUser: (): void => undefined,
        journal: (): Promise<void> => Promise.resolve(),
        applied: (): Promise<void> => Promise.resolve(),
      },
    );

    expect(managedWorkspaceOwnerCwd).toBe('/isolated/parent');
  } finally {
    session.detach();
    await closeDelegationScope(options);
  }
});

it('revokes a session whose initialization crosses a policy update', async () => {
  let releaseInitialization: (() => void) | undefined;
  let signalInitializationStarted: (() => void) | undefined;
  const initializationStarted = new Promise<void>((resolve) => {
    signalInitializationStarted = resolve;
  });
  initializeBroker.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        releaseInitialization = resolve;
        signalInitializationStarted?.();
      }),
  );
  const options = {
    projectId: 'policy-race-project',
    worktreeId: 'worktree',
    chatId: 'chat',
    cwd: '/worktree',
    managedDelegationMode: 'explicit-only' as const,
  };
  const creating = createManagedDelegationSession({
    harness: 'claude',
    sessionKey: 'policy-race-project/worktree/chat',
    currentOptions: () => options,
    currentTurn: () => 'turn',
    getWindow: () => null,
  });
  const replayCallsBefore = replayQueuedBackground.mock.calls.length;
  await initializationStarted;
  await updateManagedDelegationPolicy('off');
  releaseInitialization?.();
  const session = await creating;
  expect(replayQueuedBackground).toHaveBeenCalledTimes(replayCallsBefore);
  const spawn = session.parent.options.names.spawn;
  const bound = session.parent.bindClaude(
    spawn,
    {
      model: 'reviewer',
      description: 'Review code',
      prompt: 'Review src/index.ts',
      run_in_background: true,
    },
    'call',
  );
  if (!bound.ok) throw new Error('Expected a bound invocation');

  await expect(
    session.parent.invokeClaude(spawn, bound.value),
  ).resolves.toMatchObject({
    ok: false,
    error: { code: 'policy_blocked' },
  });
  session.detach();
  await closeDelegationScope(options);
});

it('revokes a session created after Off is authoritative but before its options refresh', async () => {
  await updateManagedDelegationPolicy('off');
  const options = {
    projectId: 'policy-before-snapshot-project',
    worktreeId: 'worktree',
    chatId: 'chat',
    cwd: '/worktree',
    // The owning chat has not received the preferences broadcast yet.
    managedDelegationMode: 'explicit-only' as const,
  };
  const replayCallsBefore = replayQueuedBackground.mock.calls.length;
  const session = await createManagedDelegationSession({
    harness: 'claude',
    sessionKey: 'policy-before-snapshot-project/worktree/chat',
    currentOptions: () => options,
    currentTurn: () => 'turn',
    getWindow: () => null,
  });

  expect(session.allowsRecoveryReplay()).toBe(false);
  expect(replayQueuedBackground).toHaveBeenCalledTimes(replayCallsBefore);
  const spawn = session.parent.options.names.spawn;
  const bound = session.parent.bindClaude(
    spawn,
    {
      model: 'reviewer',
      description: 'Review code',
      prompt: 'Review src/index.ts',
      run_in_background: true,
    },
    'call',
  );
  if (!bound.ok) throw new Error('Expected a bound invocation');
  await expect(
    session.parent.invokeClaude(spawn, bound.value),
  ).resolves.toMatchObject({
    ok: false,
    error: { code: 'policy_blocked' },
  });

  session.detach();
  await closeDelegationScope(options);
  await updateManagedDelegationPolicy('explicit-only');
});

it('does not re-admit a revoked session from a stale per-turn policy snapshot', async () => {
  await updateManagedDelegationPolicy('off');
  const options: AgentSessionOptions = {
    projectId: 'stale-policy-snapshot-project',
    worktreeId: 'worktree',
    chatId: 'chat',
    cwd: '/worktree',
    managedDelegationMode: 'explicit-only',
  };
  const session = await createManagedDelegationSession({
    harness: 'claude',
    sessionKey: 'stale-policy-snapshot-project/worktree/chat',
    currentOptions: () => options,
    currentTurn: () => 'turn',
    getWindow: () => null,
  });

  session.updatePolicy('explicit-only');

  expect(session.parent.options.authorizeSpawn?.()).toBe(false);
  session.detach();
  await closeDelegationScope(options);
  await updateManagedDelegationPolicy('explicit-only');
});

it('adopts an enabled policy whose update crosses session initialization', async () => {
  let releaseInitialization: (() => void) | undefined;
  let signalInitializationStarted: (() => void) | undefined;
  const initializationStarted = new Promise<void>((resolve) => {
    signalInitializationStarted = resolve;
  });
  initializeBroker.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        releaseInitialization = resolve;
        signalInitializationStarted?.();
      }),
  );
  let managedDelegationMode: 'explicit-only' | 'proactive' = 'explicit-only';
  const options = {
    projectId: 'enabled-policy-race-project',
    worktreeId: 'worktree',
    chatId: 'chat',
    cwd: '/worktree',
    get managedDelegationMode(): 'explicit-only' | 'proactive' {
      return managedDelegationMode;
    },
  };
  const creating = createManagedDelegationSession({
    harness: 'claude',
    sessionKey: 'enabled-policy-race-project/worktree/chat',
    currentOptions: () => options,
    currentTurn: () => 'turn',
    getWindow: () => null,
  });
  await initializationStarted;
  managedDelegationMode = 'proactive';
  await updateManagedDelegationPolicy('proactive');
  releaseInitialization?.();
  const session = await creating;

  expect(session.parent.options.authorizeSpawn?.()).toBe(true);
  expect(
    session.tools.find(
      (tool) => tool.name === session.parent.options.names.spawn,
    )?.description,
  ).toContain('proactively consult');
  expect(session.systemPromptGuidance).toMatch(
    /call mcp__\w+__WatchDelegates in the same turn/,
  );
  session.updatePolicy('explicit-only');
  expect(session.applyPolicyGuidance('Continue parent work')).toContain(
    'Only delegate when the user explicitly asks',
  );
  expect(session.applyPolicyGuidance('Continue parent work')).toContain(
    'Continue parent work',
  );
  session.detach();
  await closeDelegationScope(options);
});

it('releases a route resolved after its parent dispatch was aborted', async () => {
  const options = {
    projectId: 'abort-project',
    worktreeId: 'worktree',
    chatId: 'chat',
    cwd: '/worktree',
  };
  const session = await createManagedDelegationSession({
    harness: 'claude',
    sessionKey: 'abort-project/worktree/chat',
    currentOptions: () => options,
    currentTurn: () => 'turn',
    getWindow: () => null,
  });
  const parent = session.parent.context('turn', 'message');
  if (!parent) throw new Error('Expected an active delegation parent');
  const controller = new AbortController();
  let finishResolve:
    | ((value: { ok: true; value: ResolvedAgentRouteSnapshot }) => void)
    | undefined;
  runtimeResolve.mockReturnValueOnce(
    new Promise((resolve) => {
      finishResolve = resolve;
    }),
  );
  const resolving = resolveBrokerRoute(
    parent,
    'Review this',
    controller.signal,
  );
  controller.abort();
  const route: ResolvedAgentRouteSnapshot = {
    selectedModelId: 'reviewer',
    runtimeModelId: 'gpt-5.6-sol',
    harnessId: 'codex',
    runtimeKind: 'app-server',
    runnerRegistrationId: 'codex',
    runtimeVersion: '1',
    adapterVersion: '1',
    modelSource: 'test',
    providerType: 'openai',
    assignmentRevision: '1',
    billingAuthority: 'native',
    aiCreditsRouted: false,
    capabilities: ['read'],
    supportedThinkingLevels: ['low'],
    capabilitySnapshotHash: 'hash',
    capabilityGeneration: 1,
    policyRevision: 'read-only',
    routeId: 'late-route',
  };
  finishResolve?.({ ok: true, value: route });

  await expect(resolving).resolves.toMatchObject({
    ok: false,
    error: { code: 'parent_unavailable' },
  });
  expect(runtimeRelease).toHaveBeenCalledWith(route);
  session.detach();
  await closeDelegationScope(options);
});

it('passes the retained Agent route through owner follow-up wiring', async () => {
  const options = {
    projectId: 'retained-route-project',
    worktreeId: 'worktree',
    chatId: 'chat',
    cwd: '/worktree',
  };
  const session = await createManagedDelegationSession({
    harness: 'claude',
    sessionKey: 'retained-route-project/worktree/chat',
    currentOptions: () => options,
    currentTurn: () => 'turn',
    getWindow: () => null,
  });
  try {
    const parent = session.parent.context('turn', 'follow-up');
    if (!parent) throw new Error('Expected active parent');
    const retained = routeFixture({ routeId: 'retained-route' });
    const fresh = routeFixture({ routeId: 'fresh-route' });
    const request: AgentDelegationSpawnRequest = {
      modelId: retained.selectedModelId,
      description: 'Review code',
      prompt: 'Continue the review.',
      executionMode: 'background',
      contextPolicy: 'task_only',
      isolation: 'shared_worktree',
    };
    runtimeResolve.mockResolvedValueOnce({ ok: true, value: fresh });
    await expect(
      resolveBrokerRoute(
        parent,
        request,
        new AbortController().signal,
        retained,
      ),
    ).resolves.toMatchObject({ ok: true, value: fresh });
    expect(runtimeResolve).toHaveBeenCalledWith(
      parent,
      request,
      expect.any(AbortSignal),
      retained,
    );
  } finally {
    session.detach();
    await closeDelegationScope(options);
  }
});

it('retires the durable broker after worktree deletion so restore rereads its ledger', async () => {
  const initializedBefore = initializeBroker.mock.calls.length;
  const closedBefore = closeBroker.mock.calls.length;
  const options = {
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'chat',
    cwd: '/worktree',
  };
  const create = (): ReturnType<typeof createManagedDelegationSession> =>
    createManagedDelegationSession({
      harness: 'claude',
      sessionKey: 'project/worktree/chat',
      currentOptions: () => options,
      currentTurn: () => 'turn',
      getWindow: () => null,
    });
  await create();
  await closeDelegationScope({ projectId: 'project', worktreeId: 'worktree' });
  expect(closeBroker).toHaveBeenCalledTimes(closedBefore + 1);
  const restored = await create();
  expect(initializeBroker).toHaveBeenCalledTimes(initializedBefore + 2);
  restored.detach();
  await closeDelegationScope({ projectId: 'project', worktreeId: 'worktree' });
});

it('keeps the owned generation active when an authenticated refresh only updates its timestamp', async () => {
  const options = {
    projectId: 'refresh-project',
    worktreeId: 'worktree',
    chatId: 'chat',
    cwd: '/worktree',
  };
  const session = await createManagedDelegationSession({
    harness: 'claude',
    sessionKey: 'refresh-project/worktree/chat',
    currentOptions: () => options,
    currentTurn: () => 'turn',
    getWindow: () => null,
  });
  const previous = session.parent;
  account = { ...account, updatedAt: 'refreshed' };
  accountChanged?.(account);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(previous.active).toBe(true);
  expect(session.parent).toBe(previous);
  await closeDelegationScope(options);
});

it('revokes an owned child generation when cloud account authority changes', async () => {
  const options = {
    projectId: 'cloud-project',
    worktreeId: 'worktree',
    chatId: 'chat',
    cwd: '/worktree',
  };
  const session = await createManagedDelegationSession({
    harness: 'claude',
    sessionKey: 'cloud-project/worktree/chat',
    currentOptions: () => options,
    currentTurn: () => 'turn',
    getWindow: () => null,
  });
  const previous = session.parent;
  account = { ...account, apiKey: 'replacement-cloud-credential' };
  accountChanged?.(account);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(previous.active).toBe(false);
  expect(session.parent).not.toBe(previous);
  await closeDelegationScope(options);
});

it('resolves launch cwd and workspace observation from each owning session', async () => {
  const base = {
    projectId: 'multi-repo-project',
    worktreeId: 'worktree',
  };
  const first = await createManagedDelegationSession({
    harness: 'claude',
    sessionKey: 'multi-repo-project/worktree/chat-a',
    currentOptions: () => ({
      ...base,
      chatId: 'chat-a',
      cwd: '/worktree/repo-a',
    }),
    currentTurn: () => 'turn-a',
    getWindow: () => null,
  });
  const second = await createManagedDelegationSession({
    harness: 'codex',
    sessionKey: 'multi-repo-project/worktree/chat-b',
    currentOptions: () => ({
      ...base,
      chatId: 'chat-b',
      cwd: '/worktree/repo-b',
    }),
    currentTurn: () => 'turn-b',
    getWindow: () => null,
  });
  const parent = second.parent.context();
  if (!parent) throw new Error('Expected live parent context');
  if (!resolveBrokerCwd || !observeBrokerParentWorkspace)
    throw new Error('Expected parent-aware broker options');
  expect(resolveBrokerCwd(parent)).toBe('/worktree/repo-b');
  const signal = new AbortController().signal;
  await observeBrokerParentWorkspace(parent, signal);
  expect(mockObserveDelegationWorkspace).toHaveBeenLastCalledWith(
    '/worktree/repo-b',
    signal,
  );
  first.detach();
  second.detach();
  await closeDelegationScope(base);
});

it('does not replay legacy background deliveries after registering a live parent', async () => {
  const options = {
    projectId: 'restore-project',
    worktreeId: 'worktree',
    chatId: 'chat',
    cwd: '/worktree',
  };
  const replayCallsBefore = replayQueuedBackground.mock.calls.length;
  const session = await createManagedDelegationSession({
    harness: 'codex',
    sessionKey: 'restore-project/worktree/chat',
    currentOptions: () => options,
    currentTurn: () => 'turn',
    getWindow: () => null,
  });

  expect(replayQueuedBackground).toHaveBeenCalledTimes(replayCallsBefore);
  await closeDelegationScope(options);
  expect(session.parent.active).toBe(false);
});

it('replays only delegation transcripts still anchored in retained chat history', async () => {
  const options = {
    projectId: 'anchored-project',
    worktreeId: 'worktree',
    chatId: 'chat',
    cwd: '/worktree',
  };
  const makeTranscript = (
    delegationId: string,
    parentTurnId: string,
  ): AgentDelegationTranscript => ({
    delegationId,
    runGeneration: 1,
    sequence: 1,
    parentHarnessId: 'codex',
    parentTurnId,
    parentToolCallId: `call-${delegationId}`,
    createdAt: 100,
    task: {
      description: 'Review',
      prompt: 'Inspect source',
      executionMode: 'background',
    },
    snapshot: {
      delegationId,
      status: 'completed',
      outputTruncated: false,
      routeSnapshot: {
        selectedModelId: 'reviewer',
        runtimeModelId: 'runtime',
        harnessId: 'claude',
      },
    },
    transcript: [],
  });
  const anchored = makeTranscript('anchored', 'retained-turn');
  const cleared = makeTranscript('cleared', 'cleared-turn');
  transcripts.mockResolvedValueOnce([anchored, cleared]);
  const retainedTabs = {
    version: 1,
    activeTabId: 'chat',
    tabs: [
      {
        id: 'chat',
        title: 'Review',
        createdAt: '2026-09-11T00:00:00.000Z',
        messages: [
          {
            id: 'retained-turn',
            role: 'user' as const,
            timestamp: 90,
            blocks: [{ type: 'text' as const, text: 'Review' }],
          },
        ],
      },
    ],
  };
  getCompatibilityTabs.mockResolvedValueOnce(retainedTabs);
  getCompatibilityTabs.mockResolvedValueOnce(retainedTabs);
  const published: AgentDelegationTranscript[] = [];

  await createManagedDelegationSession({
    harness: 'codex',
    sessionKey: 'anchored-project/worktree/chat',
    currentOptions: () => options,
    currentTurn: () => 'current-turn',
    getWindow: () => null,
    onTranscript: (transcript): void => {
      published.push(transcript);
    },
  });

  expect(published).toEqual([anchored]);
  await closeDelegationScope(options);
});

it.each(['live', 'archived'] as const)(
  'selects the %s parent transcript before replaying retained delegations',
  async (location) => {
    const options = {
      projectId: `selected-${location}-project`,
      worktreeId: 'worktree',
      chatId: 'chat',
      cwd: '/worktree',
    };
    const retained: AgentDelegationTranscript = {
      delegationId: 'retained',
      runGeneration: 1,
      sequence: 1,
      parentHarnessId: 'claude',
      parentTurnId: 'retained-turn',
      parentToolCallId: 'call-retained',
      createdAt: 100,
      task: {
        description: 'Review',
        prompt: 'Inspect source',
        executionMode: 'background',
      },
      snapshot: {
        delegationId: 'retained',
        status: 'completed',
        outputTruncated: false,
        routeSnapshot: {
          selectedModelId: 'reviewer',
          runtimeModelId: 'runtime',
          harnessId: 'codex',
        },
      },
      transcript: [],
    };
    const tab: PersistedChatTab = {
      id: 'chat',
      title: 'Review',
      createdAt: '2026-09-11T00:00:00.000Z',
      messages: [
        {
          id: 'retained-turn',
          role: 'user',
          timestamp: 90,
          blocks: [{ type: 'text', text: 'Review' }],
        },
        {
          id: 'later-turn',
          role: 'user',
          timestamp: 200,
          blocks: [{ type: 'text', text: 'Later work' }],
        },
      ],
    };
    transcripts.mockResolvedValueOnce([retained]);
    getCompatibilityTabs.mockImplementationOnce((_scope, selection) =>
      Promise.resolve({
        version: 1,
        activeTabId: location === 'live' ? 'chat' : null,
        tabs: location === 'live' ? [selectedTab(tab, selection)] : [],
      }),
    );
    if (location === 'live')
      getCompatibilityTabs.mockImplementationOnce((_scope, selection) =>
        Promise.resolve({
          version: 1,
          activeTabId: 'chat',
          tabs: [selectedTab(tab, selection)],
        }),
      );
    if (location === 'archived')
      getCompatibilityArchives.mockImplementationOnce((_scope, selection) =>
        Promise.resolve({
          version: 1,
          archived: [
            {
              tab: selectedTab(tab, selection),
              archivedAt: '2026-09-12T00:00:00.000Z',
            },
          ],
        }),
      );
    const published: AgentDelegationTranscript[] = [];

    await createManagedDelegationSession({
      harness: 'claude',
      sessionKey: `selected-${location}-project/worktree/chat`,
      currentOptions: () => options,
      currentTurn: () => 'current-turn',
      getWindow: () => null,
      onTranscript: (transcript): void => {
        published.push(transcript);
      },
    });

    expect(published).toEqual([retained]);
    const fullTranscriptReads = [
      ...getCompatibilityTabs.mock.calls,
      ...getCompatibilityArchives.mock.calls,
    ].filter(
      ([scope, selection]) =>
        (scope as { projectId: string }).projectId === options.projectId &&
        selection?.fullTranscript === true,
    );
    expect(fullTranscriptReads).toHaveLength(1);
    expect(fullTranscriptReads[0]?.[1]).toEqual({
      chatIds: ['chat'],
      fullTranscript: true,
    });
    await closeDelegationScope(options);
  },
);

it('starts the parent session when retained delegation replay fails', async () => {
  const options = {
    projectId: 'replay-failure-project',
    worktreeId: 'worktree',
    chatId: 'chat',
    cwd: '/worktree',
  };
  const failure = new Error('Chat scope is unavailable');
  transcripts.mockResolvedValueOnce([
    {
      delegationId: 'retained',
      runGeneration: 1,
      sequence: 1,
      parentHarnessId: 'codex',
      parentTurnId: 'retained-turn',
      parentToolCallId: 'call-retained',
      createdAt: 100,
      task: {
        description: 'Review',
        prompt: 'Inspect source',
        executionMode: 'background',
      },
      snapshot: {
        delegationId: 'retained',
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
  ]);
  getCompatibilityTabs.mockRejectedValueOnce(failure);
  const published: AgentDelegationTranscript[] = [];

  const session = await createManagedDelegationSession({
    harness: 'codex',
    sessionKey: 'replay-failure-project/worktree/chat',
    currentOptions: () => options,
    currentTurn: () => 'current-turn',
    getWindow: () => null,
    onTranscript: (transcript): void => {
      published.push(transcript);
    },
  });

  expect(session.parent.context()).toBeDefined();
  expect(published).toEqual([]);
  expect(jest.mocked(logMainProcessWarn)).toHaveBeenCalledWith(
    '[delegation] Unable to replay retained delegation transcripts',
    failure,
  );
  await closeDelegationScope(options);
});

it('does not install an automatic completion-delivery callback', async () => {
  const options = {
    projectId: 'silent-completion-project',
    worktreeId: 'worktree',
    chatId: 'chat',
    cwd: '/worktree',
  };
  const session = await createManagedDelegationSession({
    harness: 'codex',
    sessionKey: 'silent-completion-project/worktree/chat',
    currentOptions: () => options,
    currentTurn: () => 'turn',
    getWindow: () => null,
  });
  expect(session.parent.context()).toBeDefined();
  expect(dispatchLocalWorktreeChatMessage).not.toHaveBeenCalled();
  await closeDelegationScope(options);
});

function authorityAccount(): CanopyCloudAccountEntry {
  const organization = {
    id: 'org',
    name: 'Organization',
    createdAt: 'initial',
    updatedAt: 'initial',
  };
  return {
    apiKey: 'selected-cloud-credential',
    authMode: 'api_key',
    capabilities: ['models', 'teams'],
    account: {
      id: 'account',
      name: 'Name',
      email: 'name@example.test',
      role: 'DEVELOPER',
    },
    organizations: [organization],
    teams: [
      {
        id: 'team',
        name: 'Team',
        organization,
        createdAt: 'initial',
        updatedAt: 'initial',
      },
    ],
    enforcedSettings: [
      {
        organizationId: 'org',
        organizationName: 'Organization',
        policies: [
          {
            kind: 'model-policy',
            blockedModelIds: [],
            reviewedModelIds: ['model'],
          },
        ],
      },
    ],
    orgBillingStates: [
      {
        organizationId: 'org',
        organizationName: 'Organization',
        teamsEntitled: true,
      },
    ],
    createdAt: 'initial',
    updatedAt: 'initial',
  };
}

it('ignores display metadata and membership ordering in otherwise identical account refreshes', async () => {
  account = authorityAccount();
  accountChanged?.(account);
  const options = {
    projectId: 'metadata-project',
    worktreeId: 'worktree',
    chatId: 'chat',
    cwd: '/worktree',
  };
  const session = await createManagedDelegationSession({
    harness: 'codex',
    sessionKey: 'metadata-project/worktree/chat',
    currentOptions: () => options,
    currentTurn: () => 'turn',
    getWindow: () => null,
  });
  const previous = session.parent;
  account = {
    ...account,
    account: {
      id: 'account',
      name: 'New name',
      email: 'new@example.test',
      image: 'https://example.test/avatar',
      role: 'DEVELOPER',
    },
    capabilities: [...account.capabilities].reverse(),
    organizations: account.organizations?.map((entry) => ({
      ...entry,
      name: 'Renamed',
      updatedAt: 'refreshed',
    })),
    teams: account.teams?.map((entry) => ({
      ...entry,
      name: 'Renamed',
      updatedAt: 'refreshed',
      organization: {
        ...entry.organization,
        name: 'Renamed',
        updatedAt: 'refreshed',
      },
    })),
    enforcedSettings: account.enforcedSettings?.map((entry) => ({
      ...entry,
      organizationName: 'Renamed',
    })),
    orgBillingStates: account.orgBillingStates?.map((entry) => ({
      ...entry,
      organizationName: 'Renamed',
    })),
    updatedAt: 'refreshed',
  };
  accountChanged?.(account);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(previous.active).toBe(true);
  expect(session.parent).toBe(previous);
  await closeDelegationScope(options);
});

const authorityChanges: [
  string,
  (entry: CanopyCloudAccountEntry) => CanopyCloudAccountEntry | null,
][] = [
  ['sign-out', (): null => null],
  [
    'capability removal',
    (entry): CanopyCloudAccountEntry => ({
      ...entry,
      capabilities: ['models'],
    }),
  ],
  [
    'organization removal',
    (entry): CanopyCloudAccountEntry => ({ ...entry, organizations: [] }),
  ],
  [
    'team removal',
    (entry): CanopyCloudAccountEntry => ({ ...entry, teams: [] }),
  ],
  [
    'role change',
    (entry): CanopyCloudAccountEntry => ({
      ...entry,
      account: {
        id: 'account',
        name: 'Name',
        email: 'name@example.test',
        role: 'VIEWER',
      },
    }),
  ],
  [
    'enforced model policy',
    (entry): CanopyCloudAccountEntry => ({
      ...entry,
      enforcedSettings: [
        {
          organizationId: 'org',
          organizationName: 'Organization',
          policies: [
            {
              kind: 'model-policy',
              blockedModelIds: ['model'],
              reviewedModelIds: ['model'],
            },
          ],
        },
      ],
    }),
  ],
  [
    'billing entitlement',
    (entry): CanopyCloudAccountEntry => ({
      ...entry,
      orgBillingStates: [
        {
          organizationId: 'org',
          organizationName: 'Organization',
          teamsEntitled: false,
        },
      ],
    }),
  ],
];
it.each(authorityChanges)(
  'revokes captured account authority on %s',
  async (label, change) => {
    account = authorityAccount();
    accountChanged?.(account);
    const options = {
      projectId: `authority-${label}`,
      worktreeId: 'worktree',
      chatId: 'chat',
      cwd: '/worktree',
    };
    const session = await createManagedDelegationSession({
      harness: 'codex',
      sessionKey: `${options.projectId}/worktree/chat`,
      currentOptions: () => options,
      currentTurn: () => 'turn',
      getWindow: (): null => null,
    });
    const previous = session.parent;
    accountChanged?.(change(account));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(previous.active).toBe(false);
    expect(session.parent).not.toBe(previous);
    await closeDelegationScope(options);
  },
);

it('drains local metric writes before closing the owning scope', async () => {
  mockRecordDelegationDiagnostic.mockClear();
  const options = {
    projectId: 'metric-drain',
    worktreeId: 'worktree',
    chatId: 'chat',
    cwd: '/worktree',
  };
  const session = await createManagedDelegationSession({
    harness: 'claude',
    sessionKey: 'metric-drain/worktree/chat',
    currentOptions: () => options,
    currentTurn: () => 'turn',
    getWindow: () => null,
  });
  const transcript: AgentDelegationTranscript = {
    delegationId: 'child',
    runGeneration: 1,
    sequence: 0,
    parentHarnessId: 'claude',
    parentTurnId: 'turn',
    parentToolCallId: 'call',
    createdAt: 1,
    task: {
      description: 'Review',
      prompt: 'Review source',
      executionMode: 'foreground',
    },
    transcript: [],
    snapshot: {
      delegationId: 'child',
      status: 'pending',
      outputTruncated: false,
      routeSnapshot: routeFixture(),
    },
  };
  session.publishTranscript(transcript);
  session.publishTranscript({
    ...transcript,
    sequence: 1,
    snapshot: { ...transcript.snapshot, status: 'completed' },
  });
  await closeDelegationScope(options);
  expect(
    mockRecordDelegationDiagnostic.mock.calls.map(([diagnostic]) => [
      diagnostic.kind,
      diagnostic.projectId,
      diagnostic.delegationMetric?.event,
      diagnostic.delegationMetric?.status,
    ]),
  ).toContainEqual([
    'managed_delegation',
    'metric-drain',
    'terminal',
    'completed',
  ]);
});

it('delivers an explicit hidden subordinate request without automatic result output', async () => {
  mockRecordDelegationDiagnostic.mockClear();
  const options = {
    projectId: 'same-event-receipt',
    worktreeId: 'worktree',
    chatId: 'chat',
    cwd: '/worktree',
  };
  const session = await createManagedDelegationSession({
    harness: 'claude',
    sessionKey: 'same-event-receipt/worktree/chat',
    currentOptions: () => options,
    currentTurn: () => 'delivery-turn',
    getWindow: () => null,
  });
  const id = '658d815f-52b4-4e76-b030-ab8b80162e68';
  const transcript: AgentDelegationTranscript = {
    delegationId: id,
    runGeneration: 1,
    sequence: 0,
    parentHarnessId: 'claude',
    parentTurnId: 'original-turn',
    parentToolCallId: 'call',
    createdAt: 1,
    task: {
      description: 'Review',
      prompt: 'Review source',
      executionMode: 'background',
    },
    transcript: [],
    snapshot: {
      delegationId: id,
      runGeneration: 1,
      status: 'pending',
      outputTruncated: false,
      routeSnapshot: routeFixture(),
    },
  };
  session.publishTranscript(transcript);
  session.publishTranscript({
    ...transcript,
    snapshot: { ...transcript.snapshot, status: 'completed' as const },
  });
  await session.deliverUpward(
    '<system_instruction>Subordinate request</system_instruction>',
    id,
  );
  const event = {
    type: 'assistant',
    session_id: 'native-parent',
    user_message_uuid: id,
    parent_tool_use_id: null,
    message: {
      content: [{ type: 'text', text: 'The independent finding is useful.' }],
    },
  };
  try {
    session.observe(event, 'delivery-turn');
    expect(dispatchLocalWorktreeChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '<system_instruction>Subordinate request</system_instruction>',
      }),
    );
  } finally {
    await closeDelegationScope(options);
  }
});

// A direct steer leaves no durable input for its pickup: one that starts its
// own provider turn then holds the chat queue with nothing to release it. The
// chat queue steers instead, recording the message first.
it.each(['codex', 'claude'] as const)(
  'delivers an explicit %s subordinate request through the chat queue while its root can steer',
  async (harness) => {
    dispatchLocalWorktreeChatMessage.mockClear();
    ingestProviderEvent.mockClear();
    const steer = jest.fn((_message, attemptId: string) =>
      Promise.resolve({ kind: 'accepted' as const, attemptId }),
    );
    mockGetSession.mockReturnValue({
      getSteeringCapabilities: () => ({ steer: true }),
      submitSteeringInput: steer,
    });
    const options = {
      projectId: `steer-${harness}`,
      worktreeId: 'worktree',
      chatId: 'chat',
      cwd: '/worktree',
    };
    const session = await createManagedDelegationSession({
      harness,
      sessionKey: `${options.projectId}/worktree/chat`,
      currentOptions: () => options,
      currentTurn: () => 'turn',
      getWindow: () => null,
    });
    try {
      const admission = await session.deliverUpward(
        '<system_instruction>Subordinate request</system_instruction>',
        'request-steering',
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(steer).not.toHaveBeenCalled();
      expect(dispatchLocalWorktreeChatMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: '<system_instruction>Subordinate request</system_instruction>',
          userMessageId: 'request-steering',
          managedDelegationDeliveryId: 'request-steering',
          initiationSource: 'automation',
        }),
      );
      expect(admission).toEqual({
        kind: 'accepted',
        attemptId: 'request-steering',
      });
      const target = {
        projectId: options.projectId,
        worktreeId: options.worktreeId,
        chatId: options.chatId,
      };
      // The queue retires a delivery it steered; it can no longer be claimed
      // for a queued dispatch.
      expect(isDelegationDeliveryActive(target, 'request-steering')).toBe(true);
      retireDelegationDelivery(target, 'request-steering');
      expect(isDelegationDeliveryActive(target, 'request-steering')).toBe(
        false,
      );
    } finally {
      mockGetSession.mockReturnValue(undefined);
      await closeDelegationScope(options);
    }
  },
);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

// Capabilities (docs/planning/2026-09-25-delegation-capabilities/02-capability-grant.md):
// the spawn tool guides the parent model on inheritance/opt-out/assignment,
// and List Delegates exposes the discovery flag that unlocks it.
it('mentions inherit_capabilities and includeCapabilities in the spawn tool description', async () => {
  const options = {
    projectId: 'capability-copy-project',
    worktreeId: 'worktree',
    chatId: 'chat',
    cwd: '/worktree',
  };
  const session = await createManagedDelegationSession({
    harness: 'claude',
    sessionKey: 'capability-copy-project/worktree/chat',
    currentOptions: () => options,
    currentTurn: () => 'turn',
    getWindow: () => null,
  });
  try {
    const spawnName = session.parent.options.names.spawn;
    const spawnTool = session.tools.find((tool) => tool.name === spawnName);
    expect(spawnTool?.description).toContain('inherit_capabilities');
    expect(spawnTool?.description).toContain('includeCapabilities');
  } finally {
    await closeDelegationScope(options);
  }
});

it('exposes includeCapabilities as a boolean on the List Delegates tool schema', async () => {
  const options = {
    projectId: 'list-delegates-capability-project',
    worktreeId: 'worktree',
    chatId: 'chat',
    cwd: '/worktree',
  };
  const session = await createManagedDelegationSession({
    harness: 'claude',
    sessionKey: 'list-delegates-capability-project/worktree/chat',
    currentOptions: () => options,
    currentTurn: () => 'turn',
    getWindow: () => null,
  });
  try {
    const listName = session.parent.options.names.list;
    const listTool = session.tools.find((tool) => tool.name === listName);
    const schema = record(listTool?.inputSchema);
    const properties = record(schema?.properties);
    if (!properties) throw new Error('Expected an object input schema');
    expect(properties.includeCapabilities).toMatchObject({ type: 'boolean' });
  } finally {
    await closeDelegationScope(options);
  }
});

it('disposes the delegation runtime capability cache when the last chat in a worktree scope closes', async () => {
  const options = {
    projectId: 'dispose-project',
    worktreeId: 'worktree',
    chatId: 'chat',
    cwd: '/worktree',
  };
  const disposedBefore = runtimeDispose.mock.calls.length;
  await createManagedDelegationSession({
    harness: 'claude',
    sessionKey: 'dispose-project/worktree/chat',
    currentOptions: () => options,
    currentTurn: () => 'turn',
    getWindow: () => null,
  });

  await closeDelegationScope({
    projectId: options.projectId,
    worktreeId: options.worktreeId,
  });

  expect(runtimeDispose).toHaveBeenCalledTimes(disposedBefore + 1);
});

it('resolves more than sixteen routes without the removed application capacity ceiling', async () => {
  const options = {
    projectId: 'route-capacity-project',
    worktreeId: 'worktree',
    chatId: 'chat',
    cwd: '/worktree',
  };
  const session = await createManagedDelegationSession({
    harness: 'claude',
    sessionKey: 'route-capacity-project/worktree/chat',
    currentOptions: () => options,
    currentTurn: () => 'turn',
    getWindow: () => null,
  });
  try {
    const parent = session.parent.context('turn', 'call');
    if (!parent) throw new Error('Expected an active delegation parent');
    for (let index = 0; index < 20; index += 1) {
      const route: ResolvedAgentRouteSnapshot = {
        selectedModelId: 'reviewer',
        runtimeModelId: 'gpt-5.6-sol',
        harnessId: 'codex',
        runtimeKind: 'app-server',
        runnerRegistrationId: 'codex',
        runtimeVersion: '1',
        adapterVersion: '1',
        modelSource: 'test',
        providerType: 'openai',
        assignmentRevision: '1',
        billingAuthority: 'native',
        aiCreditsRouted: false,
        capabilities: ['read'],
        supportedThinkingLevels: ['low'],
        capabilitySnapshotHash: 'hash',
        capabilityGeneration: 1,
        policyRevision: 'read-only',
        routeId: `route-capacity-${String(index)}`,
      };
      runtimeResolve.mockResolvedValueOnce({ ok: true, value: route });
      await expect(
        resolveBrokerRoute(parent, 'Review this', new AbortController().signal),
      ).resolves.toMatchObject({ ok: true, value: route });
    }
  } finally {
    session.detach();
    await closeDelegationScope(options);
  }
});

it('shares one admission controller across worktrees, capped by the application-wide host limit', async () => {
  const first = {
    projectId: 'admission-shared-a',
    worktreeId: 'worktree',
    chatId: 'chat',
    cwd: '/worktree/a',
  };
  const second = {
    projectId: 'admission-shared-b',
    worktreeId: 'worktree',
    chatId: 'chat',
    cwd: '/worktree/b',
  };
  const sessionA = await createManagedDelegationSession({
    harness: 'claude',
    sessionKey: 'admission-shared-a/worktree/chat',
    currentOptions: () => first,
    currentTurn: () => 'turn',
    getWindow: () => null,
  });
  const admissionA = capturedAdmission;
  const sessionB = await createManagedDelegationSession({
    harness: 'claude',
    sessionKey: 'admission-shared-b/worktree/chat',
    currentOptions: () => second,
    currentTurn: () => 'turn',
    getWindow: () => null,
  });
  const admissionB = capturedAdmission;
  const grants: { release(): void }[] = [];
  try {
    if (!admissionA || !admissionB)
      throw new Error('Expected a captured admission controller');
    expect(admissionA).toBe(admissionB);
    // Consume the application-wide host cap (64) across many small buckets,
    // each within its own live per-bucket limit, so the ceiling under test is
    // the shared host cap rather than any one bucket's own limit.
    let bucketIndex = 0;
    let granted = 0;
    while (granted < 64) {
      const bucket = {
        projectId: 'admission-shared-bucket',
        worktreeId: `worktree-${String(bucketIndex)}`,
        chatId: 'chat',
      };
      const limit = admissionA.bucketState(bucket).limit;
      for (let slot = 0; slot < limit && granted < 64; slot += 1) {
        const decision = admissionA.request({
          ticketId: `ticket-${String(bucketIndex)}-${String(slot)}`,
          bucket,
          ifBusy: 'reject',
          queuedAt: granted,
          onGranted: (): void => undefined,
        });
        if (decision.kind !== 'granted')
          throw new Error(`Expected an immediate grant at ${String(granted)}`);
        grants.push(decision.lease);
        granted += 1;
      }
      bucketIndex += 1;
    }
    const overflow = admissionA.request({
      ticketId: 'ticket-overflow',
      bucket: {
        projectId: 'admission-shared-bucket',
        worktreeId: `worktree-${String(bucketIndex)}`,
        chatId: 'chat',
      },
      ifBusy: 'reject',
      queuedAt: 1000,
      onGranted: (): void => undefined,
    });
    expect(overflow).toMatchObject({ kind: 'rejected', reason: 'busy' });
  } finally {
    for (const lease of grants) lease.release();
    sessionA.detach();
    sessionB.detach();
    await closeDelegationScope(first);
    await closeDelegationScope(second);
  }
});

it('follows the live per-bucket preference and grants waiting work when it is raised', async () => {
  const options: AgentSessionOptions = {
    projectId: 'admission-preference-project',
    worktreeId: 'worktree',
    chatId: 'chat',
    cwd: '/worktree',
    managedDelegationMaxConcurrent: 2,
  };
  const session = await createManagedDelegationSession({
    harness: 'claude',
    sessionKey: 'admission-preference-project/worktree/chat',
    currentOptions: () => options,
    currentTurn: () => 'turn',
    getWindow: () => null,
  });
  const bucket = {
    projectId: options.projectId,
    worktreeId: options.worktreeId,
    chatId: options.chatId,
  };
  const grantedLeases: { release(): void }[] = [];
  try {
    if (!capturedAdmission)
      throw new Error('Expected a captured admission controller');
    expect(capturedAdmission.bucketState(bucket).limit).toBe(2);
    for (let index = 0; index < 2; index += 1) {
      const decision = capturedAdmission.request({
        ticketId: `pref-ticket-${String(index)}`,
        bucket,
        ifBusy: 'queue',
        queuedAt: index,
        onGranted: (): void => undefined,
      });
      if (decision.kind !== 'granted')
        throw new Error('Expected an immediate grant');
      grantedLeases.push(decision.lease);
    }
    let waitingGranted = false;
    const waiting = capturedAdmission.request({
      ticketId: 'pref-ticket-waiting',
      bucket,
      ifBusy: 'queue',
      queuedAt: 100,
      onGranted: (): void => {
        waitingGranted = true;
      },
    });
    expect(waiting.kind).toBe('waiting');

    updateManagedDelegationMaxConcurrent(3);
    expect(capturedAdmission.bucketState(bucket).limit).toBe(3);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(waitingGranted).toBe(true);
  } finally {
    for (const lease of grantedLeases) lease.release();
    session.detach();
    await closeDelegationScope(options);
    // Leave the live preference in its default state for later tests.
    updateManagedDelegationMaxConcurrent(5);
  }
});

it('records queued delegation activity without acquiring the wake lock', async () => {
  const options = {
    projectId: 'activity-queued-project',
    worktreeId: 'worktree',
    chatId: 'chat',
    cwd: '/worktree',
  };
  const sessionKey = 'activity-queued-project/worktree/chat';
  const session = await createManagedDelegationSession({
    harness: 'claude',
    sessionKey,
    currentOptions: () => options,
    currentTurn: () => 'turn',
    getWindow: () => null,
  });
  try {
    const parent = session.parent.context('turn', 'call');
    if (!parent) throw new Error('Expected an active delegation parent');
    if (!capturedOnActivity)
      throw new Error('Expected a captured onActivity callback');
    const acquireCallsBefore = mockWakeLockAcquire.mock.calls.length;
    capturedOnActivity(parent, 0, 1);
    expect(hasLiveDelegations(sessionKey)).toBe(true);
    expect(mockWakeLockAcquire.mock.calls.length).toBe(acquireCallsBefore);
    capturedOnActivity(parent, 0, 0);
    expect(hasLiveDelegations(sessionKey)).toBe(false);
  } finally {
    session.detach();
    await closeDelegationScope(options);
  }
});

it('accepts a preflight check for an enabled model and rejects an unknown or disabled one', async () => {
  const options = {
    projectId: 'preflight-project',
    worktreeId: 'worktree',
    chatId: 'chat',
    cwd: '/worktree',
  };
  // Managed delegation runs only on macOS and Windows, so pin a supported
  // platform for the model checks to run on any CI host.
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: 'darwin',
  });
  const session = await createManagedDelegationSession({
    harness: 'claude',
    sessionKey: 'preflight-project/worktree/chat',
    currentOptions: () => options,
    currentTurn: () => 'turn',
    getWindow: () => null,
  });
  try {
    const parent = session.parent.context('turn', 'call');
    if (!parent) throw new Error('Expected an active delegation parent');
    if (!capturedPreflight)
      throw new Error('Expected a captured preflight callback');
    const task: AgentDelegationSpawnRequest = {
      modelId: 'reviewer',
      description: 'Review code',
      prompt: 'Review the diff.',
      executionMode: 'background',
      contextPolicy: 'task_only',
      isolation: 'shared_worktree',
    };

    mockGetAuthoritativeConfiguredModel.mockReturnValueOnce({ enabled: true });
    await expect(
      capturedPreflight(parent, task, new AbortController().signal),
    ).resolves.toEqual({ ok: true, value: undefined });

    mockGetAuthoritativeConfiguredModel.mockReturnValueOnce(undefined);
    await expect(
      capturedPreflight(
        parent,
        { ...task, modelId: 'unknown-model' },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'capability_unavailable' },
    });

    mockGetAuthoritativeConfiguredModel.mockReturnValueOnce({
      enabled: false,
    });
    await expect(
      capturedPreflight(
        parent,
        { ...task, modelId: 'disabled-model' },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'capability_unavailable' },
    });

    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'linux',
    });
    await expect(
      capturedPreflight(parent, task, new AbortController().signal),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'capability_unavailable' },
    });
  } finally {
    if (platform) Object.defineProperty(process, 'platform', platform);
    session.detach();
    await closeDelegationScope(options);
  }
});

// The delegation tree belongs to the root chat, not to a provider session
// (docs/planning/2026-09-28-delegation-root-cause/README.md §2.3, workstream B).
it('offers the retained delegates of a loaded worktree to the Ledger as owners, and none under an Off policy', async () => {
  const container = {
    kind: 'code_worktree' as const,
    workspaceId: 'ledger-owner-project',
    worktreeId: 'worktree',
  };
  mockContinuationCandidates.mockReturnValue([
    {
      delegationId: 'delegation-1',
      runGeneration: 2,
      description: 'Review the storage change',
      chatId: 'chat',
      createdAt: Date.parse('2026-09-01T12:00:00.000Z'),
    },
  ]);
  const options = {
    projectId: 'ledger-owner-project',
    worktreeId: 'worktree',
    chatId: 'chat',
    cwd: '/worktree',
  };
  // Nothing is offered before a managed session loaded the worktree.
  await expect(readLedgerContainerLiveDelegates(container)).resolves.toEqual(
    [],
  );
  const session = await createManagedDelegationSession({
    harness: 'claude',
    sessionKey: 'ledger-owner-project/worktree/chat',
    currentOptions: () => options,
    currentTurn: () => 'turn',
    getWindow: () => null,
  });
  try {
    await expect(readLedgerContainerLiveDelegates(container)).resolves.toEqual([
      {
        delegationId: 'delegation-1',
        description: 'Review the storage change',
        runGeneration: 2,
        rootChatId: 'chat',
        createdAt: '2026-09-01T12:00:00.000Z',
      },
    ]);
    expect(mockContinuationCandidates).toHaveBeenCalledWith({
      projectId: 'ledger-owner-project',
      worktreeId: 'worktree',
    });
    await expect(
      readLedgerContainerLiveDelegates({
        kind: 'cowork_entry',
        workspaceId: 'ledger-owner-project',
        entryId: 'worktree',
      }),
    ).resolves.toEqual([]);
    await updateManagedDelegationPolicy('off');
    await expect(readLedgerContainerLiveDelegates(container)).resolves.toEqual(
      [],
    );
  } finally {
    await updateManagedDelegationPolicy('explicit-only');
    session.detach();
    await closeDelegationScope(options);
    mockContinuationCandidates.mockReturnValue([]);
  }
  await expect(readLedgerContainerLiveDelegates(container)).resolves.toEqual(
    [],
  );
});

it('opens a delegate run Ledger tools only while its root session is live', async () => {
  const options = {
    projectId: 'ledger-hook-project',
    worktreeId: 'worktree',
    chatId: 'chat',
    cwd: '/worktree',
    selectedRepoId: 'api',
  };
  mockClaudeRunnerOptions.length = 0;
  const session = await createManagedDelegationSession({
    harness: 'claude',
    sessionKey: 'ledger-hook-project/worktree/chat',
    currentOptions: () => options,
    currentTurn: () => 'turn',
    getWindow: () => null,
  });
  const ledgerHook = mockClaudeRunnerOptions[0]?.ledger;
  const root = session.parent.context('turn', 'spawn');
  if (!ledgerHook || !root) throw new Error('Expected the runner wiring');
  const controller = new AbortController();
  const request: AgentRunRequest = {
    delegationId: 'delegation-1',
    runGeneration: 1,
    launchKey: 'launch-1',
    parent: root,
    task: {
      modelId: 'claude-test',
      description: 'Review code',
      prompt: 'Review the change.',
      executionMode: 'background',
      contextPolicy: 'task_only',
      isolation: 'shared_worktree',
    },
    route: routeFixture({ harnessId: 'claude' }),
    cwd: '/worktree',
    effectivePermission: 'read-only',
    signal: controller.signal,
  };
  const context: LocalDelegationContext = {
    request,
    signal: controller.signal,
    emit: () => Promise.resolve(),
    retain: () => undefined,
    setInterrupt: () => undefined,
    setSteer: () => undefined,
  };
  const tools: ChildLedgerTools = {
    execute: () => Promise.resolve({ text: '{}' }),
    systemPrompt: (): string => 'Ledger block',
    dispose: (): void => undefined,
  };
  try {
    // Without the run's live communication context there is nothing to open.
    await expect(ledgerHook(context)).resolves.toBeUndefined();
    expect(mockOpenChildLedgerTools).not.toHaveBeenCalled();

    mockChildContext.mockReturnValue({
      ...root,
      depth: 1,
      parentDelegationId: 'delegation-1',
      parentRunGeneration: 1,
      turnId: 'delegation-1:1',
    });
    // A nested delegate continued by its root chat: the request names the
    // root chat, and the broker keeps the delegate that spawned it.
    const lineage: DelegationLineage = {
      parentDelegationId: 'delegation-0',
      parentDescription: 'Parent review',
    };
    mockDelegationLineage.mockReturnValue(lineage);
    mockOpenChildLedgerTools.mockResolvedValueOnce(tools);
    await expect(ledgerHook(context)).resolves.toBe(tools);
    const [openedFor, runContext] =
      mockOpenChildLedgerTools.mock.calls[0] ?? [];
    expect(openedFor).toBe(request);
    expect(mockDelegationLineage).toHaveBeenCalledWith('delegation-1');
    expect(runContext?.lineage).toEqual(lineage);
    expect(runContext?.selectedRepoId).toBe('api');
    expect(runContext?.isLive()).toBe(true);
    // A detached session leaves its children to the chat root.
    session.detach();
    expect(runContext?.isLive()).toBe(true);
    // Closing the chat's delegation scope releases them.
    await closeDelegationScope(options);
    expect(runContext?.isLive()).toBe(false);
  } finally {
    mockChildContext.mockReturnValue(undefined);
    mockDelegationLineage.mockReset();
    mockOpenChildLedgerTools.mockClear();
    await closeDelegationScope(options);
  }
});

it('stops offering Ledger tools to a run once it is stopping', async () => {
  const options = {
    projectId: 'ledger-abort-project',
    worktreeId: 'worktree',
    chatId: 'chat',
    cwd: '/worktree',
  };
  mockClaudeRunnerOptions.length = 0;
  const session = await createManagedDelegationSession({
    harness: 'claude',
    sessionKey: 'ledger-abort-project/worktree/chat',
    currentOptions: () => options,
    currentTurn: () => 'turn',
    getWindow: () => null,
  });
  const ledgerHook = mockClaudeRunnerOptions[0]?.ledger;
  const root = session.parent.context('turn', 'spawn');
  if (!ledgerHook || !root) throw new Error('Expected the runner wiring');
  const controller = new AbortController();
  mockChildContext.mockReturnValue({ ...root, depth: 1 });
  try {
    await ledgerHook({
      request: {
        delegationId: 'delegation-2',
        runGeneration: 3,
        launchKey: 'launch-3',
        parent: root,
        task: {
          modelId: 'claude-test',
          description: 'Review code',
          prompt: 'Review the change.',
          executionMode: 'background',
          contextPolicy: 'task_only',
          isolation: 'shared_worktree',
        },
        route: routeFixture({ harnessId: 'claude' }),
        cwd: '/worktree',
        effectivePermission: 'read-only',
        signal: controller.signal,
      },
      signal: controller.signal,
      emit: () => Promise.resolve(),
      retain: () => undefined,
      setInterrupt: () => undefined,
      setSteer: () => undefined,
    });
    const runContext = mockOpenChildLedgerTools.mock.calls[0]?.[1];
    expect(runContext?.isLive()).toBe(true);
    controller.abort();
    expect(runContext?.isLive()).toBe(false);
  } finally {
    mockChildContext.mockReturnValue(undefined);
    mockOpenChildLedgerTools.mockClear();
    session.detach();
    await closeDelegationScope(options);
  }
});

it('leaves a delegate run without Ledger tools when opening them fails', async () => {
  const options = {
    projectId: 'ledger-failure-project',
    worktreeId: 'worktree',
    chatId: 'chat',
    cwd: '/worktree',
  };
  mockClaudeRunnerOptions.length = 0;
  const session = await createManagedDelegationSession({
    harness: 'claude',
    sessionKey: 'ledger-failure-project/worktree/chat',
    currentOptions: () => options,
    currentTurn: () => 'turn',
    getWindow: () => null,
  });
  const ledgerHook = mockClaudeRunnerOptions[0]?.ledger;
  const root = session.parent.context('turn', 'spawn');
  if (!ledgerHook || !root) throw new Error('Expected the runner wiring');
  const controller = new AbortController();
  mockChildContext.mockReturnValue({ ...root, depth: 1 });
  mockOpenChildLedgerTools.mockRejectedValueOnce(new Error('Ledger failed'));
  try {
    await expect(
      ledgerHook({
        request: {
          delegationId: 'delegation-3',
          runGeneration: 1,
          launchKey: 'launch-1',
          parent: root,
          task: {
            modelId: 'claude-test',
            description: 'Review code',
            prompt: 'Review the change.',
            executionMode: 'background',
            contextPolicy: 'task_only',
            isolation: 'shared_worktree',
          },
          route: routeFixture({ harnessId: 'claude' }),
          cwd: '/worktree',
          effectivePermission: 'read-only',
          signal: controller.signal,
        },
        signal: controller.signal,
        emit: () => Promise.resolve(),
        retain: () => undefined,
        setInterrupt: () => undefined,
        setSteer: () => undefined,
      }),
    ).resolves.toBeUndefined();
  } finally {
    mockChildContext.mockReturnValue(undefined);
    mockOpenChildLedgerTools.mockClear();
    session.detach();
    await closeDelegationScope(options);
  }
});

describe('chat-owned delegation tree', () => {
  function chatOptions(projectId: string): AgentSessionOptions {
    return {
      projectId,
      worktreeId: 'worktree',
      chatId: 'chat',
      cwd: '/worktree',
      approvalMode: 'full-access',
    };
  }

  function createSession(
    options: AgentSessionOptions,
    harness: 'claude' | 'codex' | 'cursor' | 'copilot' = 'claude',
    onTranscript?: (transcript: AgentDelegationTranscript) => void,
  ): ReturnType<typeof createManagedDelegationSession> {
    return createManagedDelegationSession({
      harness,
      sessionKey: `${options.projectId}/${options.worktreeId}/${options.chatId}`,
      currentOptions: () => options,
      currentTurn: () => 'turn',
      getWindow: () => null,
      ...(onTranscript ? { onTranscript } : {}),
    });
  }

  function treeParent(
    context: DelegationParentContext | undefined,
  ): DelegationParentContext {
    if (!context) throw new Error('Expected a live root context');
    return context;
  }

  /** Whether the tree's live owner policy is planning; the write gate. */
  function planning(parent: DelegationParentContext): boolean {
    const owner = capturedRuntimeOwner?.(parent);
    if (!owner) throw new Error('Expected a live owner');
    return owner.planMode === true;
  }

  function stoppedChats(projectId: string): DelegationStopReason[] {
    return closeOwner.mock.calls
      .filter(([parent]) => parent.projectId === projectId)
      .map(([, reason]) => reason);
  }

  /** The root harnesses whose owners a tree stop closed, in call order. */
  function stoppedHarnesses(projectId: string): string[] {
    return closeOwner.mock.calls
      .filter(([parent]) => parent.projectId === projectId)
      .map(([parent]) => parent.harnessId);
  }

  beforeEach(() => {
    closeOwner.mockClear();
    brokerStop.mockReset().mockImplementation(defaultBrokerStop);
    brokerList.mockReset().mockReturnValue([]);
    brokerActiveCount.mockReset().mockReturnValue(0);
    brokerQueuedCount.mockReset().mockReturnValue(0);
    dispatchLocalWorktreeChatMessage.mockClear();
    ingestProviderEvent.mockClear();
    ingestProviderEventWithOutcome.mockClear();
    appendDelegationItems.mockClear();
  });

  it('keeps delegates running when a Claude root session stops', async () => {
    const options = chatOptions('claude-stop-project');
    const session = await createSession(options, 'claude');
    const spawnedUnder = treeParent(session.parent.context('turn', 'spawn'));
    try {
      // Stop on a Claude root aborts its query and detaches the session.
      session.detach();

      expect(session.parent.active).toBe(false);
      expect(stoppedChats(options.projectId)).toEqual([]);
      expect(capturedIsParentActive?.(spawnedUnder)).toBe(true);
      // Nested children keep their live policy without the session.
      expect(capturedRuntimeOwner?.(spawnedUnder)).toMatchObject({
        cwd: '/worktree',
        approvalMode: 'full-access',
      });
    } finally {
      await closeDelegationScope(options);
    }
  });

  it('retires only the stopped turn bindings when a Codex root session stops', async () => {
    const options = chatOptions('codex-stop-project');
    const session = await createSession(options, 'codex');
    const previous = session.parent;
    const spawnedUnder = treeParent(previous.context('turn', 'spawn'));
    try {
      session.retireTurn();

      expect(previous.active).toBe(false);
      expect(session.parent).not.toBe(previous);
      expect(session.parent.context()?.runtimeGeneration).toBe(
        spawnedUnder.runtimeGeneration,
      );
      expect(stoppedChats(options.projectId)).toEqual([]);
      expect(capturedIsParentActive?.(spawnedUnder)).toBe(true);
    } finally {
      await closeDelegationScope(options);
    }
  });

  it.each(['cursor', 'copilot'] as const)(
    'retires only the stopped turn bindings when a %s root session stops',
    async (harness) => {
      const options = chatOptions(`${harness}-stop-project`);
      const session = await createSession(options, harness);
      const previous = session.parent;
      const spawnedUnder = treeParent(previous.context('turn', 'spawn'));
      try {
        expect(spawnedUnder.harnessId).toBe(harness);
        // Stop on this root aborts its turn; destroy then detaches.
        session.retireTurn();
        expect(previous.active).toBe(false);
        expect(session.parent.context()?.runtimeGeneration).toBe(
          spawnedUnder.runtimeGeneration,
        );
        session.detach();

        expect(stoppedChats(options.projectId)).toEqual([]);
        expect(capturedIsParentActive?.(spawnedUnder)).toBe(true);
        expect(capturedRuntimeOwner?.(spawnedUnder)).toMatchObject({
          cwd: '/worktree',
          approvalMode: 'full-access',
        });

        // Closing the chat still stops its spawned tree.
        await closeDelegationScope(options);
        expect(stoppedHarnesses(options.projectId)).toContain(harness);
        expect(
          closeOwner.mock.calls.find(
            ([parent]) =>
              parent.projectId === options.projectId &&
              parent.harnessId === harness,
          )?.[0].runtimeGeneration,
        ).toBe(spawnedUnder.runtimeGeneration);
        expect(capturedIsParentActive?.(spawnedUnder)).toBe(false);
      } finally {
        await closeDelegationScope(options);
      }
    },
  );

  it('keeps the tree across a session recycle and lets the new session list, inspect and stop it', async () => {
    const options = chatOptions('recycle-project');
    const first = await createSession(options, 'claude');
    const spawnedUnder = treeParent(first.parent.context('turn', 'spawn'));
    // destroySession({ retainDelegations: true }) destroys the provider
    // session, whose teardown detaches it.
    first.detach();
    const second = await createSession(options, 'codex');
    try {
      expect(stoppedChats(options.projectId)).toEqual([]);
      expect(capturedIsParentActive?.(spawnedUnder)).toBe(true);
      const native = {
        callId: 'call',
        turnId: 'next-turn',
        threadId: 'thread',
      };
      const { list, inspect, stop } = second.parent.options.names;
      await expect(
        second.parent.invokeCodex(list, {}, native, 'thread', 'next-turn'),
      ).resolves.toMatchObject({ ok: true });
      await expect(
        second.parent.invokeCodex(
          inspect,
          { delegationId: 'child' },
          native,
          'thread',
          'next-turn',
        ),
      ).resolves.toMatchObject({ ok: true });
      await expect(
        second.parent.invokeCodex(
          stop,
          { delegationId: 'child' },
          { ...native, callId: 'stop-call' },
          'thread',
          'next-turn',
        ),
      ).resolves.toMatchObject({ ok: true });
      expect(brokerList.mock.calls[0]?.[0].runtimeGeneration).toBe(
        spawnedUnder.runtimeGeneration,
      );
      expect(brokerStop).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimeGeneration: spawnedUnder.runtimeGeneration,
          depth: 0,
        }),
        'child',
        'stopped_by_parent',
      );
      expect(
        capturedIsParentActive?.(brokerStop.mock.calls[0]?.[0] ?? spawnedUnder),
      ).toBe(true);
    } finally {
      second.detach();
      await closeDelegationScope(options);
    }
  });

  it('applies a live approval downgrade to a tree with no attached session', async () => {
    const options = chatOptions('detached-policy-project');
    const session = await createSession(options, 'claude');
    const spawnedUnder = treeParent(session.parent.context('turn', 'spawn'));
    session.detach();
    try {
      setLiveApprovalMode(
        options.projectId,
        options.worktreeId,
        options.chatId,
        'ask',
      );
      expect(capturedRuntimeOwner?.(spawnedUnder)?.approvalMode).toBe('ask');
    } finally {
      clearLiveApprovalMode(
        options.projectId,
        options.worktreeId,
        options.chatId,
      );
      await closeDelegationScope(options);
    }
  });

  it('applies a plan-mode change committed while no session is attached', async () => {
    const options = chatOptions('detached-plan-project');
    const session = await createSession(options, 'claude');
    const spawnedUnder = treeParent(session.parent.context('turn', 'spawn'));
    // Detaching captures the session's options: not planning.
    session.detach();
    const commitPlanMode = (planMode: boolean | null): void =>
      commitChatState(options, [
        {
          type: 'tab.metadata_patched',
          tabId: options.chatId,
          patch: { planMode },
        },
      ]);
    try {
      expect(planning(spawnedUnder)).toBe(false);
      // The plan-mode toggle commits the tab setting; no session exists to
      // update, so the tree must follow the committed setting.
      commitPlanMode(true);
      expect(planning(spawnedUnder)).toBe(true);
      commitPlanMode(false);
      expect(planning(spawnedUnder)).toBe(false);
      commitPlanMode(true);
      commitPlanMode(null);
      expect(planning(spawnedUnder)).toBe(false);
      // Another chat's setting does not reach this tree.
      commitChatState(options, [
        {
          type: 'tab.metadata_patched',
          tabId: 'other-chat',
          patch: { planMode: true },
        },
      ]);
      expect(planning(spawnedUnder)).toBe(false);
    } finally {
      await closeDelegationScope(options);
    }
  });

  it('plans at once when a committed plan mode reaches an attached tree', async () => {
    const options = chatOptions('attached-plan-project');
    const session = await createSession(options, 'codex');
    const spawnedUnder = treeParent(session.parent.context('turn', 'spawn'));
    try {
      // The session applies the change later; the committed tab setting
      // already makes the tree plan.
      commitChatState(options, [
        {
          type: 'tab.metadata_patched',
          tabId: options.chatId,
          patch: { planMode: true },
        },
      ]);
      expect(planning(spawnedUnder)).toBe(true);
      commitChatState(options, [
        {
          type: 'tab.metadata_patched',
          tabId: options.chatId,
          patch: { planMode: false },
        },
      ]);
      expect(planning(spawnedUnder)).toBe(false);
    } finally {
      session.detach();
      await closeDelegationScope(options);
    }
  });

  it('publishes delegate updates to the chat while no session is attached', async () => {
    const options = chatOptions('detached-transcript-project');
    const published: AgentDelegationTranscript[] = [];
    const session = await createSession(options, 'claude', (transcript) => {
      published.push(transcript);
    });
    const spawnedUnder = treeParent(session.parent.context('turn', 'spawn'));
    session.detach();
    const transcript: AgentDelegationTranscript = {
      delegationId: 'child',
      runGeneration: 1,
      sequence: 2,
      parentHarnessId: 'claude',
      parentTurnId: 'turn',
      parentToolCallId: 'spawn',
      createdAt: 1,
      task: {
        description: 'Review',
        prompt: 'Review source',
        executionMode: 'background',
      },
      transcript: [],
      snapshot: {
        delegationId: 'child',
        status: 'completed',
        outputTruncated: false,
        routeSnapshot: routeFixture(),
      },
    };
    try {
      capturedOnTranscript?.(spawnedUnder, transcript);
      for (let turn = 0; turn < 5; turn += 1)
        await new Promise<void>((resolve) => setImmediate(resolve));
      expect(published).toEqual([]);
      const expectedData: unknown = expect.objectContaining({
        type: 'canopy_delegation',
        delegation: { ...transcript, transcriptStore: 'chat-log-v1' },
      });
      expect(ingestProviderEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: options.projectId,
          worktreeId: options.worktreeId,
          chatId: options.chatId,
          data: expectedData,
        }),
      );
    } finally {
      await closeDelegationScope(options);
    }
  });

  it('commits only the newest waiting card change of each detached delegate', async () => {
    const options = chatOptions('detached-coalesce-project');
    const session = await createSession(options, 'claude');
    const spawnedUnder = treeParent(session.parent.context('turn', 'spawn'));
    session.detach();
    const snapshot = (
      delegationId: string,
      sequence: number,
      change: Partial<AgentDelegationTranscript['snapshot']> = {},
    ): AgentDelegationTranscript => ({
      delegationId,
      runGeneration: 1,
      sequence,
      parentHarnessId: 'claude',
      parentTurnId: 'turn',
      parentToolCallId: 'spawn',
      createdAt: 1,
      task: {
        description: 'Review',
        prompt: 'Review source',
        executionMode: 'background',
      },
      transcript: [],
      snapshot: {
        delegationId,
        status: 'running',
        outputTruncated: false,
        routeSnapshot: routeFixture(),
        ...change,
      },
    });
    let releaseFirst = (): void => undefined;
    ingestProviderEvent.mockClear();
    ingestProviderEvent.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    const committed = (): string[] =>
      ingestProviderEvent.mock.calls.map(([event]) => {
        const data: unknown =
          typeof event === 'object' && event !== null
            ? Reflect.get(event, 'data')
            : undefined;
        const delegation: unknown =
          typeof data === 'object' && data !== null
            ? Reflect.get(data, 'delegation')
            : undefined;
        return typeof delegation === 'object' && delegation !== null
          ? `${String(Reflect.get(delegation, 'delegationId'))}:${String(Reflect.get(delegation, 'sequence'))}`
          : 'unknown';
      });
    const settle = async (): Promise<void> => {
      for (let turn = 0; turn < 5; turn += 1)
        await new Promise<void>((resolve) => setImmediate(resolve));
    };
    try {
      capturedOnTranscript?.(spawnedUnder, snapshot('child', 1));
      await settle();
      expect(committed()).toEqual(['child:1']);
      // Progress commits nothing; two status changes while the first commit
      // is held leave only the newer one waiting.
      capturedOnTranscript?.(
        spawnedUnder,
        snapshot('child', 2, { partialText: 'progress' }),
      );
      capturedOnTranscript?.(
        spawnedUnder,
        snapshot('child', 3, { nestedDelegation: 'not_enabled' }),
      );
      capturedOnTranscript?.(
        spawnedUnder,
        snapshot('child', 4, { nativeSessionId: 'native' }),
      );
      capturedOnTranscript?.(spawnedUnder, snapshot('sibling', 1));
      await settle();
      releaseFirst();
      await settle();
      expect(committed()).toEqual(['child:1', 'child:4', 'sibling:1']);
    } finally {
      releaseFirst();
      await closeDelegationScope(options);
    }
  });

  describe('delegate card publication for a settled parent', () => {
    const card = (
      sequence: number,
      snapshot: Partial<AgentDelegationTranscript['snapshot']> = {},
    ): AgentDelegationTranscript => ({
      delegationId: 'child',
      runGeneration: 1,
      sequence,
      parentHarnessId: 'claude',
      parentTurnId: 'turn',
      parentToolCallId: 'spawn',
      createdAt: 1,
      task: {
        description: 'Review',
        prompt: 'Review source',
        executionMode: 'background',
      },
      transcript: [
        {
          id: `item-${String(sequence)}`,
          sequence,
          occurredAt: sequence,
          type: 'text',
          text: `Progress ${String(sequence)}`,
        },
      ],
      snapshot: {
        delegationId: 'child',
        status: 'running',
        outputTruncated: false,
        partialText: `Partial ${String(sequence)}`,
        routeSnapshot: routeFixture(),
        ...snapshot,
      },
    });
    const committedSequences = (): number[] =>
      ingestProviderEvent.mock.calls.map(([event]) => {
        const data: unknown =
          typeof event === 'object' && event !== null
            ? Reflect.get(event, 'data')
            : undefined;
        const delegation: unknown =
          typeof data === 'object' && data !== null
            ? Reflect.get(data, 'delegation')
            : undefined;
        const sequence: unknown =
          typeof delegation === 'object' && delegation !== null
            ? Reflect.get(delegation, 'sequence')
            : undefined;
        return typeof sequence === 'number' ? sequence : -1;
      });
    const settle = async (): Promise<void> => {
      for (let turn = 0; turn < 5; turn += 1)
        await new Promise<void>((resolve) => setImmediate(resolve));
    };

    it('commits the card when it appears and when it settles, never for progress', async () => {
      const options = chatOptions('settled-card-window-project');
      const session = await createSession(options, 'claude');
      const spawnedUnder = treeParent(session.parent.context('turn', 'spawn'));
      session.detach();
      ingestProviderEvent.mockClear();
      jest.useFakeTimers({
        doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
      });
      try {
        capturedOnTranscript?.(spawnedUnder, card(1));
        await settle();
        for (let sequence = 2; sequence <= 9; sequence += 1) {
          jest.advanceTimersByTime(1_000);
          capturedOnTranscript?.(spawnedUnder, card(sequence));
          await settle();
        }
        // Eight progress events: none rewrote the card.
        expect(committedSequences()).toEqual([1]);
        jest.advanceTimersByTime(DELEGATION_CARD_SETTLED_INTERVAL_MS);
        await settle();
        expect(committedSequences()).toEqual([1]);
        // A pending approval is live-only.
        capturedOnTranscript?.(
          spawnedUnder,
          card(10, { approvalPending: true }),
        );
        await settle();
        capturedOnTranscript?.(
          spawnedUnder,
          card(11, { approvalPending: true }),
        );
        await settle();
        const result = card(12, { status: 'completed', finalText: 'Done' });
        capturedOnTranscript?.(spawnedUnder, result);
        await settle();
        expect(committedSequences()).toEqual([1, 12]);
        // The commit carries the delegate's final snapshot; chat state keeps
        // its card, the delegate log its items.
        const resultData: unknown = expect.objectContaining({
          delegation: { ...result, transcriptStore: 'chat-log-v1' },
        });
        expect(ingestProviderEvent).toHaveBeenLastCalledWith(
          expect.objectContaining({ data: resultData }),
        );
        jest.advanceTimersByTime(DELEGATION_CARD_SETTLED_INTERVAL_MS * 2);
        await settle();
        expect(committedSequences()).toEqual([1, 12]);
      } finally {
        jest.useRealTimers();
        await closeDelegationScope(options);
      }
    });

    it('delivers a detached card update that carried no durable change', async () => {
      const options = chatOptions('activity-card-project');
      const session = await createSession(options, 'claude');
      const spawnedUnder = treeParent(session.parent.context('turn', 'spawn'));
      session.detach();
      ingestProviderEvent.mockClear();
      const send = jest
        .spyOn(windowSend, 'sendToWindow')
        .mockImplementation(() => undefined);
      ingestProviderEventWithOutcome
        .mockResolvedValueOnce('activity-only')
        .mockResolvedValueOnce('not-applied');
      try {
        capturedOnTranscript?.(spawnedUnder, card(1));
        await settle();
        const cardData: unknown = expect.objectContaining({
          delegation: { ...card(1), transcriptStore: 'chat-log-v1' },
        });
        // Once live, once after the commit that carried no durable change.
        expect(send).toHaveBeenCalledTimes(2);
        expect(send).toHaveBeenLastCalledWith(
          null,
          IPC_CHANNELS.chatEvent,
          expect.objectContaining({
            projectId: options.projectId,
            chatId: options.chatId,
            data: cardData,
          }),
        );
        send.mockClear();
        // A rejected (duplicate or stale) commit is not delivered again; the
        // live snapshot already was.
        capturedOnTranscript?.(
          spawnedUnder,
          card(2, { status: 'completed', finalText: 'Done' }),
        );
        await settle();
        expect(ingestProviderEventWithOutcome).toHaveBeenCalledTimes(2);
        expect(send).toHaveBeenCalledTimes(1);
      } finally {
        send.mockRestore();
        await closeDelegationScope(options);
      }
    });

    it('commits through an attached session only when the card appears or settles', async () => {
      const options = chatOptions('settled-card-attached-project');
      const published: number[] = [];
      let turn: string | undefined = 'turn';
      const session = await createManagedDelegationSession({
        harness: 'claude',
        sessionKey: `${options.projectId}/${options.worktreeId}/${options.chatId}`,
        currentOptions: () => options,
        currentTurn: () => turn,
        getWindow: () => null,
        onTranscript: (transcript) => published.push(transcript.sequence),
      });
      const spawnedUnder = treeParent(session.parent.context('turn', 'spawn'));
      ingestProviderEvent.mockClear();
      jest.useFakeTimers({
        doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
      });
      try {
        // Active parent turn or not, progress is never committed.
        for (let sequence = 1; sequence <= 3; sequence += 1)
          capturedOnTranscript?.(spawnedUnder, card(sequence));
        await settle();
        expect(published).toEqual([1]);
        turn = undefined;
        for (let sequence = 4; sequence <= 7; sequence += 1)
          capturedOnTranscript?.(spawnedUnder, card(sequence));
        jest.advanceTimersByTime(DELEGATION_CARD_SETTLED_INTERVAL_MS);
        await settle();
        expect(published).toEqual([1]);
        capturedOnTranscript?.(spawnedUnder, card(8, { status: 'failed' }));
        await settle();
        expect(published).toEqual([1, 8]);
        expect(ingestProviderEvent).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
        session.detach();
        await closeDelegationScope(options);
      }
    });
  });

  describe('delegate cards with a delegate log', () => {
    const card = (
      sequence: number,
      snapshot: Partial<AgentDelegationTranscript['snapshot']> = {},
    ): AgentDelegationTranscript => ({
      delegationId: 'logged-child',
      runGeneration: 1,
      sequence,
      parentHarnessId: 'claude',
      parentTurnId: 'turn',
      parentToolCallId: 'spawn',
      createdAt: 1,
      task: {
        description: 'Review',
        prompt: 'Review source',
        executionMode: 'background',
      },
      transcript: Array.from({ length: sequence }, (_, index) => ({
        id: `item-${String(index + 1)}`,
        sequence: index + 1,
        occurredAt: index + 1,
        type: 'text' as const,
        text: `Progress ${String(index + 1)}`,
      })),
      snapshot: {
        delegationId: 'logged-child',
        status: 'running',
        outputTruncated: false,
        partialText: `Partial ${String(sequence)}`,
        routeSnapshot: routeFixture(),
        ...snapshot,
      },
    });
    const settle = async (): Promise<void> => {
      for (let turn = 0; turn < 5; turn += 1)
        await new Promise<void>((resolve) => setImmediate(resolve));
    };

    it('commits a running delegate’s card only when its persisted projection changes while the parent turn runs', async () => {
      const options = chatOptions('logged-card-active-project');
      const published: AgentDelegationTranscript[] = [];
      const session = await createSession(options, 'claude', (transcript) =>
        published.push(transcript),
      );
      const spawnedUnder = treeParent(session.parent.context('turn', 'spawn'));
      try {
        for (let sequence = 1; sequence <= 8; sequence += 1)
          capturedOnTranscript?.(spawnedUnder, card(sequence));
        capturedOnTranscript?.(
          spawnedUnder,
          card(9, { approvalPending: true }),
        );
        await settle();
        // Progress and a pending approval are live-only: one commit, the
        // card's first appearance.
        expect(published.map((entry) => entry.sequence)).toEqual([1]);
        capturedOnTranscript?.(
          spawnedUnder,
          card(10, { status: 'completed', finalText: 'Done' }),
        );
        await settle();
        expect(published.map((entry) => entry.sequence)).toEqual([1, 10]);
        expect(published.map((entry) => entry.transcriptStore)).toEqual([
          'chat-log-v1',
          'chat-log-v1',
        ]);
        // Every item reached the chat's delegate log.
        const logged = new Set(
          appendDelegationItems.mock.calls.flatMap(([, , runs]) =>
            runs
              .flatMap(({ items }) => items)
              .map((item) =>
                typeof item === 'object' && item !== null
                  ? String(Reflect.get(item, 'id'))
                  : '',
              ),
          ),
        );
        expect(logged.size).toBe(10);
      } finally {
        session.detach();
        await closeDelegationScope(options);
      }
    });

    it('commits a settled card only after its items are in the delegate log', async () => {
      const options = chatOptions('logged-card-flush-project');
      const published: number[] = [];
      const session = await createSession(options, 'claude', (transcript) =>
        published.push(transcript.sequence),
      );
      const spawnedUnder = treeParent(session.parent.context('turn', 'spawn'));
      let releaseLog = (): void => undefined;
      appendDelegationItems.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            releaseLog = (): void => resolve(true);
          }),
      );
      try {
        capturedOnTranscript?.(
          spawnedUnder,
          card(1, { status: 'completed', finalText: 'Done' }),
        );
        await settle();
        expect(published).toEqual([]);
        releaseLog();
        await settle();
        expect(published).toEqual([1]);
      } finally {
        releaseLog();
        session.detach();
        await closeDelegationScope(options);
      }
    });

    it('delivers live progress to the window without committing it', async () => {
      const options = chatOptions('logged-card-live-project');
      const session = await createSession(options, 'claude');
      const spawnedUnder = treeParent(session.parent.context('turn', 'spawn'));
      session.detach();
      ingestProviderEvent.mockClear();
      const send = jest
        .spyOn(windowSend, 'sendToWindow')
        .mockImplementation(() => undefined);
      const liveFrames = (): AgentDelegationTranscript[] =>
        send.mock.calls.flatMap(([, , payload]) => {
          const data: unknown =
            typeof payload === 'object' && payload !== null
              ? Reflect.get(payload, 'data')
              : undefined;
          const delegation: unknown =
            typeof data === 'object' && data !== null
              ? Reflect.get(data, 'delegation')
              : undefined;
          return isAgentDelegationTranscript(delegation) ? [delegation] : [];
        });
      const liveSequences = (): number[] =>
        liveFrames().map((frame) => frame.sequence);
      jest.useFakeTimers({
        doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
      });
      try {
        capturedOnTranscript?.(spawnedUnder, card(1));
        await settle();
        for (let sequence = 2; sequence <= 5; sequence += 1)
          capturedOnTranscript?.(spawnedUnder, card(sequence));
        jest.advanceTimersByTime(100);
        await settle();
        // The first appearance at once, then the newest snapshot per window.
        expect(liveSequences()).toContain(5);
        expect(liveSequences()).not.toContain(3);
        // The first frame is whole; later frames carry only changed items.
        const [first, latest] = [liveFrames()[0], liveFrames().at(-1)];
        expect(first?.transcriptMode).toBeUndefined();
        expect(first?.transcript.map((item) => item.id)).toEqual(['item-1']);
        expect(latest?.transcriptMode).toBe('patch');
        expect(latest?.transcript.map((item) => item.id)).toEqual([
          'item-2',
          'item-3',
          'item-4',
          'item-5',
        ]);
        // Only the card's first appearance was committed.
        expect(ingestProviderEvent).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
        send.mockRestore();
        await closeDelegationScope(options);
      }
    });
  });

  it('starts a fresh root turn for an upward delivery to an idle chat with no session', async () => {
    const options = chatOptions('idle-delivery-project');
    const session = await createSession(options, 'codex');
    const spawnedUnder = treeParent(session.parent.context('turn', 'spawn'));
    session.detach();
    const target = {
      projectId: options.projectId,
      worktreeId: options.worktreeId,
      chatId: options.chatId,
    };
    try {
      if (!capturedDeliverUpward) throw new Error('Expected deliverUpward');
      await expect(
        capturedDeliverUpward(
          {
            ...spawnedUnder,
            depth: 1,
            parentDelegationId: 'child',
            parentRunGeneration: 1,
          },
          'child',
          '<system_instruction>Subordinate request</system_instruction>',
          'delivery-attempt',
        ),
      ).resolves.toEqual({ kind: 'accepted', attemptId: 'delivery-attempt' });
      expect(dispatchLocalWorktreeChatMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          ...target,
          userMessageId: 'delivery-attempt',
          managedDelegationDeliveryId: 'delivery-attempt',
          executionHarness: 'codex',
          approvalMode: 'full-access',
        }),
      );
      // The queued delivery stays dispatchable until a new session claims it.
      expect(isDelegationDeliveryActive(target, 'delivery-attempt')).toBe(true);
      expect(claimDelegationDelivery(target, 'delivery-attempt')).toBe(true);
    } finally {
      await closeDelegationScope(options);
    }
  });

  // A provider switch detaches the old session and the persisted tab clears
  // its sdkSessionId, but the root previously kept its own cached native
  // session id around. An upward delivery must never resurrect that stale,
  // other-provider session id (docs/planning/2026-09-28-delegation-fixes).
  function nativeSessionEvent(sessionId: string): unknown {
    return {
      type: 'assistant',
      session_id: sessionId,
      parent_tool_use_id: null,
      message: { content: [] },
    };
  }

  it('omits a stale cached native session id from an upward delivery after a provider switch', async () => {
    const options = chatOptions('provider-switch-stale-session-project');
    const session = await createSession(options, 'claude');
    session.observe(nativeSessionEvent('stale-claude-session'), 'turn');
    session.detach();
    // The provider switch attaches a new session under a different harness;
    // the persisted tab has no sdkSessionId for it yet.
    const recycled = await createSession(options, 'codex');
    try {
      await recycled.deliverUpward(
        '<system_instruction>Subordinate request</system_instruction>',
        'post-switch-delivery',
      );
      const call = dispatchLocalWorktreeChatMessage.mock.calls[0]?.[0];
      if (!call) throw new Error('Expected a dispatched request');
      expect(call).not.toHaveProperty('sdkSessionId');
    } finally {
      recycled.detach();
      await closeDelegationScope(options);
    }
  });

  it('uses the persisted tab sdkSessionId for an upward delivery when the tab currently has one', async () => {
    const options = chatOptions('provider-switch-current-session-project');
    const session = await createSession(options, 'claude');
    session.observe(nativeSessionEvent('stale-claude-session'), 'turn');
    session.detach();
    const recycled = await createSession(options, 'codex');
    buildExistingTabDispatchOptions.mockResolvedValueOnce({
      sdkSessionId: 'current-tab-session',
    });
    try {
      await recycled.deliverUpward(
        '<system_instruction>Subordinate request</system_instruction>',
        'post-switch-delivery-with-tab-session',
      );
      expect(dispatchLocalWorktreeChatMessage).toHaveBeenCalledWith(
        expect.objectContaining({ sdkSessionId: 'current-tab-session' }),
      );
    } finally {
      recycled.detach();
      await closeDelegationScope(options);
    }
  });

  // An upward delivery is an ordinary turn of the ROOT chat, admitted by
  // normal chat dispatch. It must carry the root's exact model config so an
  // Ultra fast root is admitted (or rejected) as Ultra fast, never as the
  // derived `fastMode: false` Regular projection.
  it('passes the root chat exact Codex speed to an upward delivery', async () => {
    const options: AgentSessionOptions = {
      ...chatOptions('ultrafast-root-delivery-project'),
      modelConfig: { speed: 'ultrafast', fastMode: false },
    };
    const session = await createSession(options, 'codex');
    try {
      await session.deliverUpward(
        '<system_instruction>Subordinate request</system_instruction>',
        'ultrafast-root-delivery',
      );
      expect(dispatchLocalWorktreeChatMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          userMessageId: 'ultrafast-root-delivery',
          modelConfig: { speed: 'ultrafast', fastMode: false },
        }),
      );
    } finally {
      session.detach();
      await closeDelegationScope(options);
    }
  });

  it('resolves a host delivery parent for a watch notification with no attached session', async () => {
    const options = chatOptions('idle-watch-project');
    const session = await createSession(options, 'claude');
    const saved = treeParent(session.parent.context('turn', 'spawn'));
    session.detach();
    try {
      // A delegate's watch notification relaunches it under the chat's live
      // epoch instead of waiting for the root chat to start a session.
      expect(resolveBrokerHostParent?.(saved)).toEqual(saved);
      const recycled = await createSession(options, 'codex');
      expect(resolveBrokerHostParent?.(saved)).toMatchObject({
        runtimeGeneration: saved.runtimeGeneration,
        turnId: 'turn',
        toolCallId: 'spawn',
      });
      recycled.detach();
    } finally {
      await closeDelegationScope(options);
    }
    expect(resolveBrokerHostParent?.(saved)).toBeUndefined();
  });

  it('stops one delegation for the user with no attached session', async () => {
    const options = chatOptions('user-stop-project');
    const session = await createSession(options, 'claude');
    session.detach();
    const target = {
      projectId: options.projectId,
      worktreeId: options.worktreeId,
      chatId: options.chatId,
    };
    try {
      await expect(
        stopManagedDelegationForUser(target, 'child'),
      ).resolves.toMatchObject({ ok: true, value: { delegationId: 'child' } });
      const [parent, id, reason] = brokerStop.mock.calls[0] ?? [];
      expect(id).toBe('child');
      expect(reason).toBe('user_cancelled');
      expect(parent).toMatchObject({ ...target, depth: 0 });
      expect(parent && capturedIsParentActive?.(parent)).toBe(true);
    } finally {
      await closeDelegationScope(options);
    }
  });

  it('ends the watchers of the delegates a user stop ends, before and after it', async () => {
    const options = chatOptions('user-stop-watchers-project');
    const session = await createSession(options, 'claude');
    session.detach();
    const target = {
      projectId: options.projectId,
      worktreeId: options.worktreeId,
      chatId: options.chatId,
    };
    // The stopped delegate's task and an unrelated sibling.
    brokerList.mockImplementation((_parent, filter) =>
      filter?.underDelegationId === 'child'
        ? [
            {
              delegationId: 'task',
              status: 'running',
              outputTruncated: false,
              parentDelegationId: 'child',
            },
          ]
        : [],
    );
    mockRemoveDelegateWatchers.mockClear();
    try {
      await expect(
        stopManagedDelegationForUser(target, 'child'),
      ).resolves.toMatchObject({ ok: true });
      // The stopped delegate would otherwise be woken by its task's end.
      expect(mockRemoveDelegateWatchers.mock.calls).toEqual([
        [target, new Set(['child', 'task'])],
        [target, new Set(['child', 'task'])],
      ]);
      const [before, after] =
        mockRemoveDelegateWatchers.mock.invocationCallOrder;
      const [stop] = brokerStop.mock.invocationCallOrder;
      expect(before).toBeLessThan(stop ?? 0);
      expect(after).toBeGreaterThan(stop ?? Infinity);
    } finally {
      await closeDelegationScope(options);
    }
  });

  it('refuses a user stop for a chat with no delegation actor', async () => {
    await expect(
      stopManagedDelegationForUser(
        { projectId: 'no-actor', worktreeId: 'worktree', chatId: 'chat' },
        'child',
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'parent_unavailable' },
    });
    await expect(
      stopAllManagedDelegationsForUser({
        projectId: 'no-actor',
        worktreeId: 'worktree',
        chatId: 'chat',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'parent_unavailable' },
    });
    expect(brokerStop).not.toHaveBeenCalled();
  });

  function snapshot(
    delegationId: string,
    status: AgentDelegationSnapshot['status'],
    parentDelegationId?: string,
  ): AgentDelegationSnapshot {
    return {
      delegationId,
      status,
      outputTruncated: false,
      ...(parentDelegationId ? { parentDelegationId } : {}),
    };
  }

  /**
   * A broker whose list reflects its stops: stopping a delegation cancels its
   * live subtree. `onStop` runs before the stop takes effect.
   */
  function statefulBroker(
    initial: readonly AgentDelegationSnapshot[],
    onStop?: (id: string) => Promise<void> | void,
  ): Map<string, AgentDelegationSnapshot> {
    const records = new Map(
      initial.map((entry) => [entry.delegationId, entry]),
    );
    const descends = (id: string, ancestor: string): boolean => {
      let current = records.get(id)?.parentDelegationId;
      for (let depth = 0; depth < 10 && current; depth += 1) {
        if (current === ancestor) return true;
        current = records.get(current)?.parentDelegationId;
      }
      return false;
    };
    brokerList.mockImplementation(() => Array.from(records.values()));
    brokerStop.mockImplementation(async (_parent, id) => {
      await onStop?.(id);
      for (const [key, entry] of Array.from(records))
        if (
          (key === id || descends(key, id)) &&
          (entry.status === 'pending' || entry.status === 'running')
        )
          records.set(key, { ...entry, status: 'cancelled' });
      return {
        ok: true,
        value: records.get(id) ?? snapshot(id, 'cancelled'),
      };
    });
    return records;
  }

  it('stops every live subtree once for the user', async () => {
    const options = chatOptions('user-stop-all-project');
    const session = await createSession(options, 'codex');
    session.detach();
    statefulBroker([
      snapshot('a', 'running'),
      snapshot('a-child', 'running', 'a'),
      snapshot('a-grandchild', 'pending', 'a-child'),
      snapshot('b', 'completed'),
      snapshot('b-child', 'pending', 'b'),
      snapshot('c', 'cancelled'),
    ]);
    const target = {
      projectId: options.projectId,
      worktreeId: options.worktreeId,
      chatId: options.chatId,
    };
    mockRemoveDelegateWatchers.mockClear();
    try {
      await expect(stopAllManagedDelegationsForUser(target)).resolves.toEqual({
        ok: true,
        value: { stopped: 4 },
      });
      expect(
        brokerStop.mock.calls.map(([, id, reason]) => [id, reason]),
      ).toEqual([
        ['a', 'user_cancelled'],
        ['b-child', 'user_cancelled'],
      ]);
      // An idle delegate watching a stopped one ('b') is not woken: every
      // delegate's watchers end, before the first stop and after the last.
      expect(mockRemoveDelegateWatchers.mock.calls).toEqual([
        [target, undefined],
        [target, undefined],
      ]);
      const [before, after] =
        mockRemoveDelegateWatchers.mock.invocationCallOrder;
      const stops = brokerStop.mock.invocationCallOrder;
      expect(before).toBeLessThan(Math.min(...stops));
      expect(after).toBeGreaterThan(Math.max(...stops));
    } finally {
      await closeDelegationScope(options);
    }
  });

  describe('user stop-all fence', () => {
    const task: AgentDelegationSpawnRequest = {
      modelId: 'reviewer',
      description: 'Review code',
      prompt: 'Review the diff.',
      executionMode: 'background',
      contextPolicy: 'task_only',
      isolation: 'shared_worktree',
    };
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');

    beforeEach(() => {
      // Preflight admits spawns only on macOS and Windows.
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: 'darwin',
      });
    });

    afterEach(() => {
      if (platform) Object.defineProperty(process, 'platform', platform);
    });

    function isLive(entry: AgentDelegationSnapshot): boolean {
      return entry.status === 'pending' || entry.status === 'running';
    }

    it('refuses spawns while it runs and stops one admitted after its first listing', async () => {
      const options = chatOptions('user-stop-all-race-project');
      const session = await createSession(options, 'claude');
      const rootParent = treeParent(session.parent.context('turn', 'spawn'));
      const preflight = capturedPreflight;
      if (!preflight) throw new Error('Expected a captured preflight callback');
      let refusedDuringStop: AgentDelegationResult<void> | undefined;
      const records = statefulBroker([snapshot('a', 'running')], async (id) => {
        if (id !== 'a') return;
        // A root-level spawn admitted after stop-all listed the chat.
        records.set('late', snapshot('late', 'running'));
        // A spawn started while stop-all runs is refused.
        refusedDuringStop = await preflight(
          rootParent,
          task,
          new AbortController().signal,
        );
      });
      try {
        await expect(
          stopAllManagedDelegationsForUser({
            projectId: options.projectId,
            worktreeId: options.worktreeId,
            chatId: options.chatId,
          }),
        ).resolves.toEqual({ ok: true, value: { stopped: 2 } });
        expect(brokerStop.mock.calls.map(([, id]) => id)).toEqual([
          'a',
          'late',
        ]);
        expect(Array.from(records.values()).filter(isLive)).toEqual([]);
        expect(refusedDuringStop).toMatchObject({
          ok: false,
          error: { code: 'policy_blocked', retryable: true },
        });
        // The fence ends with the stop-all.
        await expect(
          preflight(rootParent, task, new AbortController().signal),
        ).resolves.toEqual({ ok: true, value: undefined });
      } finally {
        session.detach();
        await closeDelegationScope(options);
      }
    });

    it('waits for a spawn already in preflight and refuses it', async () => {
      const options = chatOptions('user-stop-all-inflight-project');
      const session = await createSession(options, 'codex');
      const rootParent = treeParent(session.parent.context('turn', 'spawn'));
      const preflight = capturedPreflight;
      if (!preflight) throw new Error('Expected a captured preflight callback');
      let releaseModel: (() => void) | undefined;
      mockResolveAgentModelRuntime.mockImplementationOnce(
        ({ model }) =>
          new Promise((resolve) => {
            releaseModel = (): void =>
              resolve({
                selectedModel: model,
                runtimeModel: model,
                providerType: 'anthropic',
                executionHarness: 'claude',
                systemPromptAppend: undefined,
                pluginSelections: undefined,
              });
          }),
      );
      // Started before the stop-all: it passed the admission checks.
      let inFlightSettled = false;
      const inFlight = preflight(
        rootParent,
        task,
        new AbortController().signal,
      ).finally(() => {
        inFlightSettled = true;
      });
      // The broker counts the spawn as active until its preflight settles.
      brokerActiveCount.mockImplementation(() => (inFlightSettled ? 0 : 1));
      statefulBroker([snapshot('a', 'running')], (id) => {
        if (id === 'a') releaseModel?.();
      });
      try {
        await expect(
          stopAllManagedDelegationsForUser({
            projectId: options.projectId,
            worktreeId: options.worktreeId,
            chatId: options.chatId,
          }),
        ).resolves.toEqual({ ok: true, value: { stopped: 1 } });
        expect(inFlightSettled).toBe(true);
        await expect(inFlight).resolves.toMatchObject({
          ok: false,
          error: { code: 'policy_blocked', retryable: true },
        });
      } finally {
        session.detach();
        await closeDelegationScope(options);
      }
    });

    it('fails instead of reporting success when a spawn is still admitting once rounds are exhausted', async () => {
      const options = chatOptions('user-stop-all-preflight-exhausted-project');
      const session = await createSession(options, 'claude');
      session.detach();
      // Never listed as live (still in preflight, not yet durably recorded),
      // but the broker keeps counting it as active for the whole run, so
      // every round's listing comes back empty and rounds run out.
      brokerList.mockReturnValue([]);
      brokerActiveCount.mockReturnValue(1);
      try {
        await expect(
          stopAllManagedDelegationsForUser({
            projectId: options.projectId,
            worktreeId: options.worktreeId,
            chatId: options.chatId,
          }),
        ).resolves.toMatchObject({
          ok: false,
          error: { code: 'runtime_error', retryable: true },
        });
        expect(brokerStop).not.toHaveBeenCalled();
      } finally {
        await closeDelegationScope(options);
      }
    });
  });

  it('preserves the chat epoch when only a provider authority changes', async () => {
    const options = chatOptions('provider-revoked-project');
    const session = await createSession(options, 'codex');
    const spawnedUnder = treeParent(session.parent.context('turn', 'spawn'));
    session.detach();
    mockRevokeHarness.mockClear();
    runtimeRevokeHarness.mockClear();
    try {
      await revokeManagedDelegations('claude');
      expect(mockRevokeHarness).toHaveBeenCalledWith('claude');
      expect(runtimeRevokeHarness).toHaveBeenCalledWith('claude');
      expect(stoppedChats(options.projectId)).toEqual([]);
      expect(capturedIsParentActive?.(spawnedUnder)).toBe(true);
    } finally {
      await closeDelegationScope(options);
    }
  });

  it('still stops a detached tree on policy revocation', async () => {
    const options = chatOptions('revoked-detached-project');
    const session = await createSession(options, 'claude');
    const spawnedUnder = treeParent(session.parent.context('turn', 'spawn'));
    session.detach();
    try {
      await updateManagedDelegationPolicy('off');
      // One owner per root harness: Claude, Codex, Cursor, Copilot and OpenCode.
      expect(stoppedChats(options.projectId)).toEqual([
        'policy_revoked',
        'policy_revoked',
        'policy_revoked',
        'policy_revoked',
        'policy_revoked',
      ]);
      expect(stoppedHarnesses(options.projectId)).toEqual([
        'claude',
        'codex',
        'cursor',
        'copilot',
        'opencode',
      ]);
      expect(closeOwner.mock.calls[0]?.[0].runtimeGeneration).toBe(
        spawnedUnder.runtimeGeneration,
      );
      expect(capturedIsParentActive?.(spawnedUnder)).toBe(false);
    } finally {
      await updateManagedDelegationPolicy('explicit-only');
      await closeDelegationScope(options);
    }
  });

  it('moves an attached session to a new epoch when authority is revoked', async () => {
    const options = chatOptions('revoked-attached-project');
    const session = await createSession(options, 'codex');
    const previous = session.parent;
    const spawnedUnder = treeParent(previous.context('turn', 'spawn'));
    try {
      account = { ...account, apiKey: 'revoked-attached-credential' };
      accountChanged?.(account);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(stoppedChats(options.projectId)).toContain('policy_revoked');
      expect(previous.active).toBe(false);
      const next = treeParent(session.parent.context('turn', 'next'));
      expect(next.runtimeGeneration).not.toBe(spawnedUnder.runtimeGeneration);
      expect(capturedIsParentActive?.(spawnedUnder)).toBe(false);
      expect(capturedIsParentActive?.(next)).toBe(true);
    } finally {
      session.detach();
      await closeDelegationScope(options);
    }
  });

  it('still stops a detached tree when its chat scope or worktree closes', async () => {
    const chat = chatOptions('closed-chat-project');
    const worktree = chatOptions('closed-worktree-project');
    const chatSession = await createSession(chat, 'claude');
    const worktreeSession = await createSession(worktree, 'codex');
    const chatTree = treeParent(chatSession.parent.context('turn', 'spawn'));
    const worktreeTree = treeParent(
      worktreeSession.parent.context('turn', 'spawn'),
    );
    chatSession.detach();
    worktreeSession.detach();
    const closedBefore = closeBroker.mock.calls.length;

    await closeDelegationScope(chat);
    await closeDelegationScope({
      projectId: worktree.projectId,
      worktreeId: worktree.worktreeId,
    });

    expect(stoppedChats(chat.projectId)).toEqual([
      'parent_cancelled',
      'parent_cancelled',
      'parent_cancelled',
      'parent_cancelled',
      'parent_cancelled',
    ]);
    expect(stoppedChats(worktree.projectId)).toEqual([
      'parent_cancelled',
      'parent_cancelled',
      'parent_cancelled',
      'parent_cancelled',
      'parent_cancelled',
    ]);
    expect(capturedIsParentActive?.(chatTree)).toBe(false);
    expect(capturedIsParentActive?.(worktreeTree)).toBe(false);
    expect(closeBroker.mock.calls.length).toBeGreaterThan(closedBefore);
    await closeDelegationScope({
      projectId: chat.projectId,
      worktreeId: chat.worktreeId,
    });
  });

  // Keep last: shutdown is permanent for this module instance.
  it('still stops a detached tree on shutdown', async () => {
    const options = chatOptions('shutdown-project');
    const session = await createSession(options, 'claude');
    const spawnedUnder = treeParent(session.parent.context('turn', 'spawn'));
    session.detach();

    await shutdownManagedDelegations();

    expect(stoppedChats(options.projectId)).toEqual([
      'shutdown',
      'shutdown',
      'shutdown',
      'shutdown',
      'shutdown',
    ]);
    expect(capturedIsParentActive?.(spawnedUnder)).toBe(false);
  });
});
