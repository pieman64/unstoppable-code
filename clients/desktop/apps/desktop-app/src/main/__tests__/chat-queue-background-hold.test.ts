import type * as ChatTabsModule from '../lib/chat-tabs';
import type * as ChatTabsReaderModule from '../lib/chat-tabs-reader';
import type * as ChatStateServiceModule from '../services/chat-state-service';
import type * as TurnSessionReuseModule from '../lib/turn-session-reuse';
import type * as WorkOwnerModule from '../agents/work-owner';

import type {
  ChatSendMessageRequest,
  ChatTabsFile,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';

const mockNativeBackgroundWork = jest.fn<
  boolean,
  [projectId: string, worktreeId: string, chatId: string]
>(() => false);
const mockSessionLiveness = jest.fn<
  { foreground: boolean; background: boolean },
  [projectId: string, worktreeId: string, chatId: string]
>(() => ({
  foreground: false,
  background: false,
}));
const mockLiveDelegationWork = jest.fn((): boolean => false);
const mockDecideTurnSessionReuse = jest.fn<
  Promise<TurnSessionReuseModule.TurnSessionReuseDecision>,
  [ChatSendMessageRequest]
>(() => Promise.resolve({ kind: 'absent' }));
const mockApplyLiveSessionSettings = jest.fn(
  (request: ChatSendMessageRequest): ChatSendMessageRequest => request,
);
const mockReadChatTabsFile = jest.fn<
  ReturnType<typeof ChatTabsReaderModule.readChatTabsFile>,
  Parameters<typeof ChatTabsReaderModule.readChatTabsFile>
>();
const mockReadChatTranscript = jest.fn<
  ReturnType<typeof ChatTabsReaderModule.readChatTranscript>,
  Parameters<typeof ChatTabsReaderModule.readChatTranscript>
>();
const mockWriteChatTabsFile = jest.fn<
  ReturnType<typeof ChatTabsModule.writeChatTabsFile>,
  Parameters<typeof ChatTabsModule.writeChatTabsFile>
>();
const mockDispatchWorktreeChatTurn = jest.fn(
  (): Promise<void> => Promise.resolve(),
);
const mockLatchFirstTaskSubmitted = jest.fn((): void => undefined);
const mockIngestProviderEvent = jest.fn<
  Promise<boolean>,
  [ChatStateServiceModule.ProviderEventInput]
>(() => Promise.resolve(true));
const mockEnsureChatForTrustedSend = jest.fn(
  (): Promise<void> => Promise.resolve(),
);
const mockReconcileHostQueue = jest.fn((): Promise<void> => Promise.resolve());
const mockHasTranscriptMessage = jest.fn(
  (): Promise<boolean> => Promise.resolve(false),
);

function emptyChatTabsFile(): ChatTabsFile {
  const tab: PersistedChatTab = {
    id: 'chat-1',
    title: 'Worktree chat',
    createdAt: '2026-10-01T00:00:00.000Z',
    kind: 'chat',
    messages: [],
  };
  return { version: 1, tabs: [tab], activeTabId: tab.id };
}

const mockChatStateService = {
  runWithScopeActivity: jest.fn(
    <T>(scope: unknown, operation: () => Promise<T>): Promise<T> => {
      void scope;
      return operation();
    },
  ),
  ensureChatForTrustedSend: mockEnsureChatForTrustedSend,
  ingestProviderEvent: mockIngestProviderEvent,
  ingestProviderEventWithResult: jest.fn(
    async (
      input: ChatStateServiceModule.ProviderEventInput,
    ): Promise<ChatStateServiceModule.ProviderEventIngestResult> => ({
      outcome: (await mockIngestProviderEvent(input))
        ? 'applied'
        : 'not-applied',
    }),
  ),
  getCompatibilityTabs: jest
    .fn()
    .mockResolvedValue({ version: 1, tabs: [], activeTabId: '' }),
  hasMutation: jest.fn().mockResolvedValue(false),
  command: jest.fn(() => Promise.resolve({ outcome: 'applied' })),
  commitTurnOverrideModelFor: jest.fn().mockResolvedValue(undefined),
  settleRejectedStartup: jest.fn(() => Promise.resolve()),
  reconcileHostQueue: mockReconcileHostQueue,
  hasTranscriptMessage: mockHasTranscriptMessage,
  removeUnacceptedUserPrompt: jest.fn().mockResolvedValue(undefined),
  replaceCompatibilityTabs: jest.fn(
    (
      scope: { projectId: string; worktreeId: string },
      data: ChatTabsFile,
    ): Promise<ChatTabsFile> => {
      void scope;
      return Promise.resolve(data);
    },
  ),
  updateCompatibilityTab: jest.fn(
    async (
      scope: { projectId: string; worktreeId: string },
      chatId: string,
      update: (tab: PersistedChatTab) => PersistedChatTab | null,
    ): Promise<{ tabsFile: ChatTabsFile; updated: false }> => {
      void chatId;
      void update;
      return {
        tabsFile: await mockReadChatTabsFile(scope.projectId, scope.worktreeId),
        updated: false,
      };
    },
  ),
};

jest.mock('../agents/session-manager', () => ({
  subscribeGlobalPluginDefaultsRevision: jest.fn(() => jest.fn()),
  subscribeChatSessionActivity: jest.fn(() => jest.fn()),
  subscribeLiveBackgroundTasks: jest.fn(() => jest.fn()),
  getChatSessionLiveness: (
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): ReturnType<typeof mockSessionLiveness> =>
    mockSessionLiveness(projectId, worktreeId, chatId),
  get chatHasNativeBackgroundWork(): typeof mockNativeBackgroundWork {
    return mockNativeBackgroundWork;
  },
  getSessionTurnSettings: jest.fn(() => undefined),
  getGlobalPluginDefaultsRevision: jest.fn(() => 0),
  getSessionGlobalPluginDefaultsRevision: jest.fn(() => undefined),
  getSessionPluginSelections: jest.fn(() => undefined),
  getActiveChatIds: jest.fn(() => []),
  getActiveSessionInfos: jest.fn(() => []),
  hasPendingCodexContinuation: jest.fn(() => false),
  getSession: jest.fn(),
  destroySession: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../agents/delegation/activity', () => ({
  chatHasLiveDelegations: (): boolean => mockLiveDelegationWork(),
  subscribeDelegationActivity: jest.fn(() => jest.fn()),
}));
jest.mock('../agents/steering-eligibility-events', () => ({
  subscribeSteeringEligibility: jest.fn(() => jest.fn()),
}));
jest.mock('../agents/provider-turn-evidence', () => ({
  getCodexTurnEvidence: jest.fn(() => ({ holdsTurn: false })),
  observeCodexTurnTerminal: jest.fn(),
}));
jest.mock('../agents/session-event-router', () => ({
  drainCurrentSessionEvents: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/turn-session-reuse', () => {
  const actual = jest.requireActual<typeof TurnSessionReuseModule>(
    '../lib/turn-session-reuse',
  );
  return {
    ...actual,
    get decideTurnSessionReuse(): typeof mockDecideTurnSessionReuse {
      return mockDecideTurnSessionReuse;
    },
    get applyLiveSessionSettings(): typeof mockApplyLiveSessionSettings {
      return mockApplyLiveSessionSettings;
    },
  };
});
jest.mock('../lib/chat-tabs-reader', () => ({
  get readChatTabsFile(): typeof mockReadChatTabsFile {
    return mockReadChatTabsFile;
  },
  get readChatTranscript(): typeof mockReadChatTranscript {
    return mockReadChatTranscript;
  },
}));
jest.mock('../lib/chat-tabs', () => ({
  get writeChatTabsFile(): typeof mockWriteChatTabsFile {
    return mockWriteChatTabsFile;
  },
  notifyChatTabsMaterialized: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: (): typeof mockChatStateService => mockChatStateService,
}));
jest.mock('../notifications/campaigns/activation-signals', () => ({
  latchFirstTaskSubmitted: (): void => mockLatchFirstTaskSubmitted(),
}));
jest.mock('../lib/window-send', () => ({
  sendToWindow: jest.fn(),
  sendToWindowDetailed: jest.fn(() => ({ delivered: true })),
}));
jest.mock('../lib/validation', () => ({
  validateId: jest.fn(),
  validateOptionalRepoId: jest.fn(),
}));
jest.mock('../portal/portal-event-bus', () => ({
  createPortalEvent: jest.fn((_type: string, payload: unknown) => ({
    type: _type,
    eventId: 'event-1',
    clientEventId: 'event-1',
    occurredAt: '2026-10-01T00:00:00.000Z',
    payload,
  })),
  enqueuePortalEvent: jest.fn(),
  isCanopyPortalActive: jest.fn(() => true),
}));
jest.mock('../lib/worktree-chat-turn', () => ({
  get dispatchWorktreeChatTurn(): typeof mockDispatchWorktreeChatTurn {
    return mockDispatchWorktreeChatTurn;
  },
}));
jest.mock('../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: jest.fn(() => ({
    handleNewChatStartedEvent: jest.fn(),
    checkDeliveryIngress: jest.fn(() => Promise.resolve({ allowed: true })),
  })),
}));
jest.mock('../app-advisor/chat-service', () => ({
  dispatchAppAdvisorChatMessage: jest.fn(),
}));
jest.mock('../lib/usage-limited-chats-registry', () => ({
  clearUsageLimitedChat: jest.fn(),
}));
jest.mock('../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: jest.fn(() => Promise.resolve(false)),
  isModelBlockedByCurrentPolicy: jest.fn(() => false),
}));
jest.mock('../lib/cowork-work-entries', () => ({
  listWorkEntryIds: jest.fn(() => Promise.resolve(['entry-1'])),
  listWorkEntries: jest.fn(() => Promise.resolve([])),
  resolveWorkEntryForChat: jest.fn(() => Promise.resolve(undefined)),
}));
jest.mock('../lib/transient-error-retry-service', () => ({
  cancelTransientRetryForChat: jest.fn(),
}));
jest.mock('../lib/auth-preflight', () => ({
  assertTurnAuthDependencies: jest.fn(() => Promise.resolve()),
}));
jest.mock('../agents/work-owner', () => ({
  ...jest.requireActual<typeof WorkOwnerModule>('../agents/work-owner'),
  resolveAiCreditsScopeOwner: jest.fn(() =>
    Promise.resolve({ kind: 'personal' }),
  ),
}));
jest.mock('../lib/approval-mode-resolution', () => ({
  resolvePersistedApprovalMode: jest.fn(
    (_projectId: string, _worktreeId: string, mode?: string) =>
      Promise.resolve(mode ?? 'ask'),
  ),
}));
jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeTargetIds: (
    projectId: string,
    worktreeId: string,
  ): { projectId: string; worktreeId: string } => ({ projectId, worktreeId }),
}));
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));
jest.mock('../services/split-lock-service', () => ({
  assertNotSplitLocked: jest.fn(),
}));
jest.mock('../approvals/pending-approvals', () => ({
  hasPendingApprovalForSession: jest.fn(() => false),
}));
jest.mock('../mcp/pending-requests', () => ({
  hasPendingRequestForSession: jest.fn(() => false),
}));
jest.mock('../lib/chat-turn-cancel', () => ({
  beginChatTurnPreparation: jest.fn(() => ({
    cancelled: false,
    finish: jest.fn(),
  })),
}));

import {
  ChatQueueService,
  type ChatQueueServiceDependencies,
} from '../services/chat-queue-service';
import {
  dispatchHostQueuedWorktreeChatMessage,
  setAutoModelRoutingDispatcher,
  setSpecialNativeChatDispatcher,
} from '../services/chat-service';
import {
  chatHasNativeBackgroundWork,
  getSessionTurnSettings,
} from '../agents/session-manager';
import {
  applyLiveSessionSettings,
  decideTurnSessionReuse,
  holdsForBackgroundWork,
  TurnHeldForBackgroundWorkError,
} from '../lib/turn-session-reuse';
import { dispatchWorktreeChatTurn } from '../lib/worktree-chat-turn';
import { registerWorkspaceTypes } from '../lib/workspace-registry';
import { logMainProcessWarn } from '../lib/main-process-logging';

const mockWarn = jest.mocked(logMainProcessWarn);

const mockedNativeBackgroundWork = jest.mocked(chatHasNativeBackgroundWork);
const mockedGetSessionTurnSettings = jest.mocked(getSessionTurnSettings);
const mockedDecideTurnSessionReuse = jest.mocked(decideTurnSessionReuse);
const mockedApplyLiveSessionSettings = jest.mocked(applyLiveSessionSettings);
const mockedDispatchWorktreeChatTurn = jest.mocked(dispatchWorktreeChatTurn);

interface ScheduledQueueWork {
  callback: () => void;
  handle: ReturnType<typeof setTimeout>;
}

function createQueueHarness(
  overrides: Partial<ChatQueueServiceDependencies> = {},
): {
  queue: ChatQueueService;
  dispatched: ChatSendMessageRequest[];
  flushScheduledWork: () => Promise<void>;
} {
  const scheduled: ScheduledQueueWork[] = [];
  const dispatched: ChatSendMessageRequest[] = [];
  let id = 0;
  const schedule: ChatQueueServiceDependencies['schedule'] = (
    callback,
    delayMs,
  ) => {
    const handle = setTimeout(() => undefined, Math.max(delayMs, 60_000));
    scheduled.push({ callback, handle });
    return handle;
  };
  const dependencies: ChatQueueServiceDependencies = {
    dispatch: async (queuedRequest, origin, fromQueue): Promise<void> => {
      dispatched.push(queuedRequest);
      await dispatchHostQueuedWorktreeChatMessage(
        queuedRequest,
        origin,
        fromQueue,
      );
    },
    cancel: (): Promise<void> => Promise.resolve(),
    settleCancelledTurn: (): void => undefined,
    hasActiveProviderTurn: () =>
      mockSessionLiveness(target.projectId, target.worktreeId, target.chatId)
        .foreground,
    hasPendingProviderContinuation: () => false,
    hasBackgroundWork: () =>
      mockSessionLiveness(target.projectId, target.worktreeId, target.chatId)
        .background || mockLiveDelegationWork(),
    hasNativeBackgroundWork: (queueTarget) =>
      mockNativeBackgroundWork(
        queueTarget.projectId,
        queueTarget.worktreeId,
        queueTarget.chatId,
      ),
    decideTurnSessionReuse: (input) => mockDecideTurnSessionReuse(input),
    holdsForBackgroundWork: (queueTarget, decision) =>
      holdsForBackgroundWork(queueTarget, decision),
    readPersistedTabOptions: () => Promise.resolve({}),
    persistRuntime: async (): Promise<void> => {
      await mockReconcileHostQueue();
    },
    broadcast: (): void => undefined,
    createId: () => `queue-message-${++id}`,
    now: () => 1_000 + id,
    schedule,
    steerGenerated: () => Promise.resolve({ status: 'fallback' }),
    steerQueuedGenerated: () => Promise.resolve({ status: 'fallback' }),
    ...overrides,
  };
  const queue = new ChatQueueService(dependencies);
  const flushScheduledWork = async (): Promise<void> => {
    let turns = 0;
    while (scheduled.length > 0 && turns < 20) {
      turns += 1;
      const work = scheduled.splice(0);
      for (const item of work) {
        clearTimeout(item.handle);
        item.callback();
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    for (const item of scheduled.splice(0)) clearTimeout(item.handle);
  };
  return { queue, dispatched, flushScheduledWork };
}

const target = {
  projectId: 'workspace-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
};

function request(
  overrides: Partial<ChatSendMessageRequest> = {},
): ChatSendMessageRequest {
  return {
    ...target,
    userMessageId: 'message-1',
    text: 'Continue the work',
    ...overrides,
  };
}

function hasCommittedUserPrompt(): boolean {
  return mockIngestProviderEvent.mock.calls.some(([event]) => {
    const data: unknown = event.data;
    return (
      typeof data === 'object' &&
      data !== null &&
      'type' in data &&
      data.type === 'canopy_user_prompt'
    );
  });
}

describe('chat queue dispatch guard for native background work', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    registerWorkspaceTypes(new Map());
    setAutoModelRoutingDispatcher((input) => Promise.resolve(input));
    setSpecialNativeChatDispatcher(() => Promise.resolve(), {
      getMainWindow: () => null,
      getAppAdvisorWindow: () => null,
      openAppAdvisorWindow: jest.fn(),
      ensureAppAdvisorWindow: jest.fn(),
    });
    mockSessionLiveness.mockReturnValue({
      foreground: false,
      background: false,
    });
    mockLiveDelegationWork.mockReturnValue(false);
    mockNativeBackgroundWork.mockReturnValue(false);
    mockDecideTurnSessionReuse.mockResolvedValue({ kind: 'absent' });
    mockApplyLiveSessionSettings.mockImplementation((input) => input);
    mockedGetSessionTurnSettings.mockReturnValue(undefined);
    mockReadChatTabsFile.mockResolvedValue(emptyChatTabsFile());
    mockReadChatTranscript.mockResolvedValue([]);
    mockWriteChatTabsFile.mockResolvedValue(undefined);
    mockIngestProviderEvent.mockResolvedValue(true);
    mockEnsureChatForTrustedSend.mockResolvedValue(undefined);
    mockReconcileHostQueue.mockResolvedValue(undefined);
    mockHasTranscriptMessage.mockResolvedValue(false);
    mockedDispatchWorktreeChatTurn.mockResolvedValue(undefined);
  });

  it.each([
    ['desktop worktree', 'desktop'],
    ['Portal worktree', 'portal'],
  ] as const)(
    'does not commit or create a session for a changed %s request while native work is active',
    async (_label, origin) => {
      mockSessionLiveness.mockReturnValue({
        foreground: false,
        background: true,
      });
      mockedNativeBackgroundWork.mockReturnValue(true);
      mockedDecideTurnSessionReuse.mockResolvedValue({
        kind: 'recycle',
        changedOptions: ['model'],
        recreateReasons: ['unspecified'],
      });
      const routedRequest = request({
        modelSelectionMode: 'auto',
        model: 'unrouted-model',
      });
      setAutoModelRoutingDispatcher((input) =>
        Promise.resolve({ ...input, model: 'routed-model' }),
      );
      const { queue, dispatched, flushScheduledWork } = createQueueHarness();

      await expect(
        queue.submit(routedRequest, origin),
      ).resolves.toBeUndefined();
      expect(mockReconcileHostQueue).toHaveBeenCalled();
      expect(
        queue.getWorktreeSnapshots(target.projectId, target.worktreeId)[0],
      ).toMatchObject({
        queue: [expect.objectContaining({ id: 'queue-message-1' })],
      });
      expect(dispatched).toEqual([]);
      expect(hasCommittedUserPrompt()).toBe(false);

      await flushScheduledWork();

      expect(dispatched).toHaveLength(1);
      expect(
        mockedDecideTurnSessionReuse.mock.calls.some(
          ([dispatchRequest]) => dispatchRequest.model === 'routed-model',
        ),
      ).toBe(true);
      expect(hasCommittedUserPrompt()).toBe(false);
      expect(mockEnsureChatForTrustedSend).not.toHaveBeenCalled();
      expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
      expect(
        queue.getWorktreeSnapshots(target.projectId, target.worktreeId)[0]
          ?.queue[0],
      ).toMatchObject({ waitingReason: 'background_work' });
    },
  );

  it('does not settle a split startup when a queued dispatch is held', async () => {
    mockSessionLiveness.mockReturnValue({
      foreground: false,
      background: true,
    });
    mockedNativeBackgroundWork.mockReturnValue(true);
    mockedDecideTurnSessionReuse.mockResolvedValue({
      kind: 'recycle',
      changedOptions: ['model'],
      recreateReasons: ['unspecified'],
    });
    mockChatStateService.getCompatibilityTabs.mockClear();
    mockChatStateService.getCompatibilityTabs.mockResolvedValue({
      version: 1,
      activeTabId: 'chat-1',
      tabs: [
        {
          id: 'chat-1',
          title: 'Independent branch',
          createdAt: '2026-10-03T00:00:00.000Z',
          kind: 'chat',
          messages: [],
          pendingSystemInstructions: [
            {
              id: 'independent-agent-start',
              text: 'Investigate independently',
            },
          ],
          forkedFrom: {
            projectId: 'workspace-1',
            worktreeId: 'source-worktree',
            chatId: 'source-chat',
          },
        },
      ],
    });
    const { queue, dispatched, flushScheduledWork } = createQueueHarness();

    await expect(
      queue.submit(
        request({
          pendingSystemInstructions: [
            {
              id: 'independent-agent-start',
              text: 'Investigate independently',
            },
          ],
        }),
        'desktop',
      ),
    ).resolves.toBeUndefined();
    await flushScheduledWork();

    expect(dispatched).toHaveLength(1);
    expect(mockChatStateService.getCompatibilityTabs).not.toHaveBeenCalled();
    expect(mockChatStateService.command).not.toHaveBeenCalled();
    expect(mockChatStateService.settleRejectedStartup).not.toHaveBeenCalled();
    expect(hasCommittedUserPrompt()).toBe(false);
    expect(mockEnsureChatForTrustedSend).not.toHaveBeenCalled();
    expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
  });

  it('runs generated input on the live session without Auto routing and keeps its saved settings', async () => {
    mockSessionLiveness.mockReturnValue({
      foreground: false,
      background: true,
    });
    mockedNativeBackgroundWork.mockReturnValue(true);
    mockedGetSessionTurnSettings.mockReturnValue({
      model: 'live-session-model',
    });
    const generated = request({
      initiationSource: 'automation',
      automationName: 'Nightly check',
      model: 'requested-model',
      modelSelectionMode: 'auto',
    });
    const autoRouter = jest.fn(() =>
      Promise.resolve({ ...generated, model: 'auto-routed-model' }),
    );
    setAutoModelRoutingDispatcher(autoRouter);
    mockedApplyLiveSessionSettings.mockImplementation((input) => ({
      ...input,
      model: 'live-session-model',
    }));
    mockedDecideTurnSessionReuse.mockResolvedValue({ kind: 'reuse' });

    await dispatchHostQueuedWorktreeChatMessage(generated, 'desktop', true);

    expect(autoRouter).not.toHaveBeenCalled();
    // The decision sees the live settings, with recreate markers deferred.
    expect(mockedDecideTurnSessionReuse).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'live-session-model' }),
      { deferRecreateMarkers: true },
    );
    expect(hasCommittedUserPrompt()).toBe(true);
    expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledTimes(1);
    // Dispatch applies the live settings itself; the request keeps the
    // user's saved model so nothing downstream persists the live one.
    expect(mockedDispatchWorktreeChatTurn.mock.calls[0]?.[0]).toMatchObject({
      model: 'requested-model',
      useLiveSessionSettings: true,
    });
  });

  it('holds generated input when even the live settings need a restart', async () => {
    mockSessionLiveness.mockReturnValue({
      foreground: false,
      background: true,
    });
    mockedNativeBackgroundWork.mockReturnValue(true);
    mockedGetSessionTurnSettings.mockReturnValue({
      model: 'live-session-model',
    });
    mockedApplyLiveSessionSettings.mockImplementation((input) => input);
    mockedDecideTurnSessionReuse.mockResolvedValue({
      kind: 'recycle',
      changedOptions: ['workOwner'],
      recreateReasons: [],
    });
    const generated = request({
      initiationSource: 'automation',
      automationName: 'Nightly check',
    });

    await expect(
      dispatchHostQueuedWorktreeChatMessage(generated, 'desktop', true),
    ).rejects.toBeInstanceOf(TurnHeldForBackgroundWorkError);
    expect(hasCommittedUserPrompt()).toBe(false);
    expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
  });

  // A pipeline watcher fired while the idle chat had a background Bash task:
  // the immediate submit rejected with the hold, and the watcher service
  // recorded the delivery as terminally failed instead of waiting.
  it('retains an idle watcher delivery held for background work', async () => {
    mockSessionLiveness.mockReturnValue({
      foreground: false,
      background: true,
    });
    mockedNativeBackgroundWork.mockReturnValue(true);
    mockedGetSessionTurnSettings.mockReturnValue({
      model: 'live-session-model',
    });
    mockedDecideTurnSessionReuse.mockResolvedValue({
      kind: 'recycle',
      changedOptions: ['workOwner'],
      recreateReasons: [],
    });
    const { queue, dispatched, flushScheduledWork } = createQueueHarness();

    await expect(
      queue.submit(
        request({
          userMessageId: 'watcher-delivery-1',
          watcherFired: { kind: 'Pipeline completed' },
          watcherDeliveryId: 'delivery-1',
          hiddenContext: { kind: 'canopy-watcher-event', text: 'done' },
          initiationSource: 'user',
        }),
        'desktop',
      ),
    ).resolves.toBeUndefined();

    expect(dispatched).toHaveLength(1);
    expect(hasCommittedUserPrompt()).toBe(false);
    expect(
      queue.getWorktreeSnapshots(target.projectId, target.worktreeId)[0]?.queue,
    ).toEqual([
      expect.objectContaining({
        waitingReason: 'background_work',
        blockedByBackgroundWork: true,
      }),
    ]);

    mockedNativeBackgroundWork.mockReturnValue(false);
    mockSessionLiveness.mockReturnValue({
      foreground: false,
      background: false,
    });
    queue.onNativeBackgroundWorkChanged(
      `${target.projectId}/${target.worktreeId}/${target.chatId}`,
    );
    await flushScheduledWork();

    expect(dispatched).toHaveLength(2);
    expect(dispatched[1]?.userMessageId).toBe('watcher-delivery-1');
    expect(hasCommittedUserPrompt()).toBe(true);
    expect(
      queue.getWorktreeSnapshots(target.projectId, target.worktreeId),
    ).toEqual([]);
  });

  it('does not keep a held watcher delivery that Stop cancelled', async () => {
    mockSessionLiveness.mockReturnValue({
      foreground: false,
      background: true,
    });
    mockedNativeBackgroundWork.mockReturnValue(true);
    mockedGetSessionTurnSettings.mockReturnValue({
      model: 'live-session-model',
    });
    const preparation = { cancelled: false, finish: jest.fn() };
    mockedDecideTurnSessionReuse.mockImplementation(() => {
      // Stop lands while the reuse decision is pending.
      preparation.cancelled = true;
      return Promise.resolve({
        kind: 'recycle',
        changedOptions: ['workOwner'],
        recreateReasons: [],
      });
    });
    const { queue, dispatched, flushScheduledWork } = createQueueHarness({
      beginTurnPreparation: () => preparation,
    });

    await expect(
      queue.submit(
        request({
          userMessageId: 'watcher-delivery-1',
          watcherFired: { kind: 'Pipeline completed' },
          watcherDeliveryId: 'delivery-1',
          hiddenContext: { kind: 'canopy-watcher-event', text: 'done' },
          initiationSource: 'user',
        }),
        'desktop',
      ),
    ).rejects.toBeInstanceOf(TurnHeldForBackgroundWorkError);

    mockedNativeBackgroundWork.mockReturnValue(false);
    queue.onNativeBackgroundWorkChanged(
      `${target.projectId}/${target.worktreeId}/${target.chatId}`,
    );
    await flushScheduledWork();

    expect(dispatched).toHaveLength(1);
    expect(hasCommittedUserPrompt()).toBe(false);
    expect(
      queue.getWorktreeSnapshots(target.projectId, target.worktreeId)[0]
        ?.queue ?? [],
    ).toEqual([]);
  });

  it('dispatches an unchanged ordinary request when the reuse decision says reuse', async () => {
    mockSessionLiveness.mockReturnValue({
      foreground: false,
      background: true,
    });
    mockedNativeBackgroundWork.mockReturnValue(true);
    mockedDecideTurnSessionReuse.mockResolvedValue({ kind: 'reuse' });
    const { queue, dispatched, flushScheduledWork } = createQueueHarness();

    await queue.submit(request(), 'desktop');
    await flushScheduledWork();

    expect(mockedApplyLiveSessionSettings).not.toHaveBeenCalled();
    expect(dispatched).toHaveLength(1);
    expect(hasCommittedUserPrompt()).toBe(true);
    expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledTimes(1);
  });

  it('skips reuse analysis for managed-only background work', async () => {
    mockLiveDelegationWork.mockReturnValue(true);
    mockSessionLiveness.mockReturnValue({
      foreground: false,
      background: true,
    });
    mockedNativeBackgroundWork.mockReturnValue(false);
    const { queue, dispatched, flushScheduledWork } = createQueueHarness();

    await queue.submit(request(), 'desktop');
    await flushScheduledWork();

    expect(dispatched).toHaveLength(1);
    expect(hasCommittedUserPrompt()).toBe(true);
    expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledTimes(1);
  });

  it('warns and continues dispatch when the reuse decision fails', async () => {
    mockSessionLiveness.mockReturnValue({
      foreground: false,
      background: true,
    });
    mockedNativeBackgroundWork.mockReturnValue(true);
    const decisionError = new Error('Reuse matcher unavailable');
    mockedDecideTurnSessionReuse.mockRejectedValue(decisionError);
    const { queue, dispatched, flushScheduledWork } = createQueueHarness();

    await queue.submit(request(), 'desktop');
    await flushScheduledWork();

    expect(
      mockWarn.mock.calls.some(
        ([message, error]) =>
          String(message).includes('Session reuse decision failed') &&
          error === decisionError,
      ),
    ).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(hasCommittedUserPrompt()).toBe(true);
    expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledTimes(1);
  });

  it('rechecks native work after the async reuse decision', async () => {
    mockSessionLiveness.mockReturnValue({
      foreground: false,
      background: true,
    });
    mockedNativeBackgroundWork.mockReturnValue(true);
    mockedDecideTurnSessionReuse.mockImplementation(() => {
      mockedNativeBackgroundWork.mockReturnValue(false);
      return Promise.resolve({
        kind: 'recycle',
        changedOptions: ['model'],
        recreateReasons: ['unspecified'],
      });
    });
    const { queue, dispatched, flushScheduledWork } = createQueueHarness();

    await queue.submit(request(), 'desktop');
    await flushScheduledWork();

    expect(dispatched).toHaveLength(1);
    expect(hasCommittedUserPrompt()).toBe(true);
    expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledTimes(1);
  });
});
