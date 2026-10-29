import * as claudeTuiChats from '../../lib/claude-tui-chats';
import * as senderContext from '../../agent-messaging/sender-context';
const mockPreviewPinnedProxy = jest
  .fn<Promise<boolean>, [unknown]>()
  .mockResolvedValue(true);
jest.mock('../../account-proxy/routing', () => ({
  previewAccountProxySessionRoute: (options: unknown): Promise<boolean> =>
    mockPreviewPinnedProxy(options),
}));
/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
// Must be mocked: `sendWorktreeChatMessage` calls
// `notifyOnboardingChecklistChatStarted()`, whose fire-and-forget latch writes
// through real `node:fs/promises` + `paths.ts`. Unmocked, running this suite
// latches checklist items into the developer's live `~/.canopy` install (and
// leaks an async require past Jest teardown via the cloud-account store).
import type * as WorkOwnerModule from '../../agents/work-owner';
import type * as ChatTabsReaderModule from '../../lib/chat-tabs-reader';
import type * as ChatStateServiceModule from '../chat-state-service';
import * as ModelCatalogProjection from '../../portal/model-catalog-projection';

// The real pin resolves Settings; these cases need only its outcome.
jest.mock('../../agents/agent-default-model', () => ({
  resolveCatalogAgentDefaultModel: (projectId: string): Promise<string> =>
    Promise.resolve(`default-for-${projectId}`),
  resolveSendModelPin: (
    _projectId: string,
    stored: string | undefined,
    requested: string | undefined,
  ): Promise<string | undefined> => {
    const selected = requested ?? stored;
    if (selected === 'agent_model_nested')
      return Promise.reject(new Error('The default model is an Agent.'));
    return Promise.resolve(
      selected === 'agent_model_inherit'
        ? 'agent_model_inherit@gpt-5.5'
        : undefined,
    );
  },
}));

const mockNotifyOnboardingChecklistChatStarted = jest.fn<void, []>();
jest.mock('../../ipc/onboarding-checklist', () => ({
  notifyOnboardingChecklistChatStarted: (): void => {
    mockNotifyOnboardingChecklistChatStarted();
  },
}));
jest.mock('../../lib/chat-tabs-reader', () => ({
  ...jest.requireActual<typeof ChatTabsReaderModule>(
    '../../lib/chat-tabs-reader',
  ),
  readChatTabsFile: jest.fn(),
  readChatTranscript: jest.fn(),
}));
jest.mock('../../lib/chat-tabs', () => ({
  writeChatTabsFile: jest.fn(),
  notifyChatTabsMaterialized: jest.fn().mockResolvedValue(undefined),
}));
const mockChatStateService = {
  retainTrustedTerminalInput: jest.fn().mockResolvedValue(undefined),
  restoreRetainedTerminalAgentInputAfterFailedNativeAdmission: jest
    .fn()
    .mockResolvedValue(undefined),
  claimRetainedTerminalAgentInputForNative: jest.fn<
    Promise<ChatSendMessageRequest>,
    [ChatSendMessageRequest]
  >((request): Promise<ChatSendMessageRequest> => Promise.resolve(request)),
  runWithScopeActivity: jest.fn(
    async <T>(_scope: unknown, operation: () => Promise<T>): Promise<T> =>
      operation(),
  ),
  settleRejectedStartup: jest.fn(() => Promise.resolve()),
  command: jest.fn().mockResolvedValue({ outcome: 'applied' }),
  getCompatibilityTabs: jest
    .fn()
    .mockResolvedValue({ version: 1, tabs: [], activeTabId: '' }),
  ensureChatForTrustedSend: jest.fn().mockResolvedValue(undefined),
  ingestProviderEvent: jest
    .fn<
      Promise<boolean>,
      [
        Parameters<
          ChatStateServiceModule.ChatStateService['ingestProviderEvent']
        >[0],
      ]
    >()
    .mockResolvedValue(true),
  // Delivery reads the outcome; it mirrors the boolean commit mock above.
  ingestProviderEventWithOutcome: async (
    input: ChatStateServiceModule.ProviderEventInput,
  ): Promise<ChatStateServiceModule.ProviderEventIngestOutcome> =>
    (await mockChatStateService.ingestProviderEvent(input))
      ? 'applied'
      : 'not-applied',
  hasMutation: jest.fn().mockResolvedValue(false),
  hasTranscriptMessage: jest.fn(() => Promise.resolve(false)),
  replaceCompatibilityTabs: jest.fn(
    async (
      scope: { projectId: string; worktreeId: string },
      data: ChatTabsFile,
    ) => {
      const { writeChatTabsFile } = jest.requireMock('../../lib/chat-tabs');
      await writeChatTabsFile(scope.projectId, scope.worktreeId, data);
      return data;
    },
  ),
  updateCompatibilityTab: jest.fn(
    async (
      scope: { projectId: string; worktreeId: string },
      chatId: string,
      update: (tab: PersistedChatTab) => PersistedChatTab | null,
    ) => {
      const { readChatTabsFile } = jest.requireMock(
        '../../lib/chat-tabs-reader',
      );
      const { writeChatTabsFile } = jest.requireMock('../../lib/chat-tabs');
      const data: ChatTabsFile = await readChatTabsFile(
        scope.projectId,
        scope.worktreeId,
      );
      const current = data.tabs.find((tab) => tab.id === chatId);
      const next = current ? update(current) : null;
      if (!next) return { tabsFile: data, updated: false };
      const tabsFile = {
        ...data,
        tabs: data.tabs.map((tab) => (tab.id === chatId ? next : tab)),
      };
      await writeChatTabsFile(scope.projectId, scope.worktreeId, tabsFile);
      return { tabsFile, updated: true };
    },
  ),
  reconcileHostQueue: jest.fn().mockResolvedValue(undefined),
  removeUnacceptedUserPrompt: jest.fn().mockResolvedValue(undefined),
};
jest.mock('../chat-state-service', () => ({
  getChatStateService: () => mockChatStateService,
}));
jest.mock('../../lib/window-send', () => ({
  sendToWindow: jest.fn(),
  sendToWindowDetailed: jest.fn(() => ({ delivered: true })),
}));
jest.mock('../../lib/validation', () => ({
  validateId: jest.fn(),
  validateOptionalRepoId: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  createPortalEvent: jest.fn((type: string, payload: unknown) => ({
    type,
    eventId: 'event-1',
    clientEventId: 'event-1',
    occurredAt: '2026-05-28T12:00:00.000Z',
    payload,
  })),
  enqueuePortalEvent: jest.fn(),
  // These summary-projection tests exercise the portal-connected path, so the
  // model catalog (gated behind this in `chatSummaryEntity`, CAN-1218) is
  // projected. Returning `true` keeps that path covered.
  isCanopyPortalActive: jest.fn(() => true),
}));
jest.mock('../../lib/worktree-chat-turn', () => ({
  dispatchWorktreeChatTurn: jest.fn(),
}));
jest.mock('../../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: jest.fn(() => ({
    handleCanonicalChatStartedEvent: jest.fn(),
  })),
}));
jest.mock('../../app-advisor/chat-service', () => ({
  dispatchAppAdvisorChatMessage: jest.fn(),
}));
jest.mock('../../lib/usage-limited-chats-registry', () => ({
  clearUsageLimitedChat: jest.fn(),
}));
const blockedModelIds = new Set<string>();
const mockAssertTurnAuthDependencies = jest.fn(
  (input: unknown): Promise<void> => {
    void input;
    return Promise.resolve();
  },
);
jest.mock('../../lib/model-policy-state', () => ({
  // Async for enforcement; the sync one is still imported by the catalog
  // projection this service builds summaries with.
  isModelBlockedByStoredPolicy: (
    modelId: string | undefined,
  ): Promise<boolean> =>
    Promise.resolve(modelId !== undefined && blockedModelIds.has(modelId)),
  isModelBlockedByCurrentPolicy: (modelId: string | undefined): boolean =>
    modelId !== undefined && blockedModelIds.has(modelId),
}));
jest.mock('../../lib/cowork-work-entries', () => ({
  listWorkEntryIds: jest.fn(() => Promise.resolve(['advisor-entry-1'])),
  listWorkEntryChatSummaries: jest.fn(() =>
    Promise.resolve([{ entryId: 'entry-1', title: 'Cowork entry', chats: [] }]),
  ),
}));
jest.mock('../../lib/transient-error-retry-service', () => ({
  cancelTransientRetryForChat: jest.fn(),
}));
const mockBuildSessionKey = jest.fn(
  (projectId: string, worktreeId: string, chatId: string): string =>
    `${projectId}/${worktreeId}/${chatId}`,
);
const mockCancelActiveChatTurn = jest.fn<boolean, [string, string]>();
const mockRequestChatTurnCancel = jest.fn<void, [string, string]>();
// CAN-1814 PR 5. The send-time auth preflight is cached-only and lives in its
// own module (`lib/auth-preflight.ts`); here we only care that both send
// funnels consult it before writing anything.
jest.mock('../../lib/auth-preflight', () => ({
  assertTurnAuthDependencies: (input: unknown): Promise<void> =>
    mockAssertTurnAuthDependencies(input),
}));
jest.mock('../../agents/session-manager', () => ({
  subscribeGlobalPluginDefaultsRevision: jest.fn(() => jest.fn()),
  getGlobalPluginDefaultsRevision: jest.fn(() => 0),
  getSessionGlobalPluginDefaultsRevision: jest.fn(() => undefined),
  getActiveChatIds: jest.fn(() => []),
  getActiveSessionInfos: jest.fn(() => []),
  hasPendingCodexContinuation: jest.fn(() => false),
  getSession: jest.fn(),
  buildSessionKey: (
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): string => mockBuildSessionKey(projectId, worktreeId, chatId),
  cancelActiveChatTurn: (sessionKey: string, turnId: string): boolean =>
    mockCancelActiveChatTurn(sessionKey, turnId),
  requestChatTurnCancel: (sessionKey: string, turnId: string): void =>
    mockRequestChatTurnCancel(sessionKey, turnId),
  destroySession: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../agents/work-owner', () => ({
  ...jest.requireActual<typeof WorkOwnerModule>('../../agents/work-owner'),
  resolveAiCreditsScopeOwner: jest.fn(() =>
    Promise.resolve({ kind: 'personal' }),
  ),
}));
jest.mock('../../agents/session-event-router', () => ({
  drainCurrentSessionEvents: jest.fn(() => Promise.resolve()),
}));
jest.mock('../split-lock-service', () => ({
  assertNotSplitLocked: jest.fn(),
}));
jest.mock('../../lib/approval-mode-resolution', () => ({
  resolvePersistedApprovalMode: jest.fn(),
}));
const mockResolveWorktreeTargetIds = jest.fn(
  (
    projectId: string,
    worktreeId: string,
  ): { projectId: string; worktreeId: string } | null => ({
    projectId,
    worktreeId,
  }),
);
const mockResolveWorktreeCwd = jest.fn(
  (projectId: string, worktreeId: string, selectedRepoId?: string): string =>
    `/roots/${projectId}/${worktreeId}${selectedRepoId ? `/${selectedRepoId}` : ''}`,
);
jest.mock('../../lib/resolve-worktree', () => ({
  resolveWorktreeTargetIds: (
    projectId: string,
    worktreeId: string,
  ): { projectId: string; worktreeId: string } | null =>
    mockResolveWorktreeTargetIds(projectId, worktreeId),
  resolveWorktreeCwd: (
    projectId: string,
    worktreeId: string,
    selectedRepoId?: string,
  ): string => mockResolveWorktreeCwd(projectId, worktreeId, selectedRepoId),
}));

import type {
  ApprovalRule,
  ChatSendMessageRequest,
  ChatTabsFile,
  PersistedChatTab,
  PersistedPendingQuestion,
} from '@canopy/desktop-shared/types';
import { BRAND } from '@canopy/brand/current';
import { getChatQueueService } from '../chat-queue-service';
import type { PersistedHostQueuedMessage } from '@canopy/desktop-shared/types';
import { isDelegationDeliveryActive } from '../../agents/delegation/lifecycle';
jest.mock('../../agents/delegation/lifecycle', () => ({
  claimDelegationDelivery: jest.fn(() => false),
  isDelegationDeliveryActive: jest.fn(() => false),
  releaseDelegationDelivery: jest.fn(),
}));
import {
  readChatTabsFile,
  readChatTranscript,
} from '../../lib/chat-tabs-reader';
import { writeChatTabsFile } from '../../lib/chat-tabs';
import { enqueueChatTabMutation } from '../../lib/chat-tab-mutation-queue';
import { clearUsageLimitedChat } from '../../lib/usage-limited-chats-registry';
import { cancelTransientRetryForChat } from '../../lib/transient-error-retry-service';
import { sendToWindow, sendToWindowDetailed } from '../../lib/window-send';
import { dispatchWorktreeChatTurn } from '../../lib/worktree-chat-turn';
import { createPortalEvent } from '../../portal/portal-event-bus';
import { enqueuePortalEvent } from '../../portal/portal-event-bus';
import { registerWorkspaceTypes } from '../../lib/workspace-registry';
import { assertNotSplitLocked } from '../split-lock-service';
import { dispatchAppAdvisorChatMessage } from '../../app-advisor/chat-service';
import { resolvePersistedApprovalMode } from '../../lib/approval-mode-resolution';
import {
  clearLiveApprovalMode,
  setLiveApprovalMode,
} from '../../approvals/live-approval-modes';
import {
  isReusableEmptyChatTab,
  buildExistingTabDispatchOptions,
  cancelWorktreeChat,
  cancelWorktreeChatTurn,
  dispatchHostQueuedWorktreeChatMessage,
  dispatchLocalWorktreeChatMessage,
  emitHostQueueForcedCancellation,
  isWorktreeChatMessageCommitted,
  listWorktreeChatSummaries,
  resolveWorktreeChatApprovalPolicy,
  resumeStoppedWorktreeChatTurn,
  sendWorktreeChatMessage,
  setAutoModelRoutingDispatcher,
  setSendModelPreparer,
  setWorktreeChatWindowAccessor,
  setSpecialNativeChatDispatcher,
} from '../chat-service';
import {
  PORTAL_CHAT_TRANSCRIPT_MESSAGE_LIMIT,
  persistedMessageToPortalMessage,
} from '../chat-transcript-projector';
import { portalChatAssetId } from '@canopy/protocol/portal';
import type { AgentSentInfo } from '@canopy/protocol/portal/external-agent-sender';
import {
  APP_ADVISOR_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
  CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE,
  IPC_CHANNELS,
  getProviderForModel,
  initAiGatewayModels,
  initClaudeModels,
  initCodexModels,
  initModelHarnessAssignments,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import { RETIRED_PLAN_CHAT_MESSAGE } from '@canopy/desktop-shared/lib/retired-chat-scopes';
import { getActiveSessionInfos } from '../../agents/session-manager';
import type { ChatActiveSessionInfo } from '@canopy/desktop-shared/types';
import { BrowserWindow } from 'electron';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatStateV2Repository } from '../chat-state-v2-repository';

const APP_ADVISOR_ENTRY_ID = 'advisor-entry-1';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const mockedGetActiveSessionInfos = jest.mocked(getActiveSessionInfos);

/**
 * A complete `ChatActiveSessionInfo`. `jest.mocked` keeps the real return type,
 * so a partial literal fails typecheck even though the projection only reads
 * `chatId` and `turnActive`.
 */
function sessionInfo(
  overrides: Pick<ChatActiveSessionInfo, 'chatId' | 'turnActive'> &
    Partial<Pick<ChatActiveSessionInfo, 'turnElapsedMs' | 'turnStartedAt'>>,
): ChatActiveSessionInfo {
  return {
    projectId: 'workspace-1',
    worktreeId: 'worktree-1',
    providerType: 'claude',
    turnActive: false,
    createdAt: 1,
    lastActivityAt: 1,
    turnCount: 0,
    pendingMessageCount: 0,
    ...overrides,
  };
}
const mockedReadChatTabsFile = jest.mocked(readChatTabsFile);
const mockedReadChatTranscript = jest.mocked(readChatTranscript);
const mockedWriteChatTabsFile = jest.mocked(writeChatTabsFile);
const mockedDispatchWorktreeChatTurn = jest.mocked(dispatchWorktreeChatTurn);
const mockedCreatePortalEvent = jest.mocked(createPortalEvent);
const mockedEnqueuePortalEvent = jest.mocked(enqueuePortalEvent);
const mockedDispatchAppAdvisorChatMessage = jest.mocked(
  dispatchAppAdvisorChatMessage,
);
const mockedSendToWindow = jest.mocked(sendToWindow);
const mockedSendToWindowDetailed = jest.mocked(sendToWindowDetailed);
const mockedClearUsageLimitedChat = jest.mocked(clearUsageLimitedChat);
const mockedCancelTransientRetryForChat = jest.mocked(
  cancelTransientRetryForChat,
);
const mockedAssertNotSplitLocked = jest.mocked(assertNotSplitLocked);
const mockedResolvePersistedApprovalMode = jest.mocked(
  resolvePersistedApprovalMode,
);

function chatTabsFile(
  tabs: PersistedChatTab[],
  pendingQuestions?: PersistedPendingQuestion[],
): ChatTabsFile {
  return {
    version: 1,
    tabs,
    activeTabId: tabs[0]?.id ?? '',
    ...(pendingQuestions !== undefined ? { pendingQuestions } : {}),
  };
}

describe('worktree chat service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    blockedModelIds.clear();
    mockAssertTurnAuthDependencies.mockResolvedValue(undefined);
    registerWorkspaceTypes(new Map());
    getChatQueueService().resetForTests();
    setWorktreeChatWindowAccessor(() => null);
    setAutoModelRoutingDispatcher((request) => Promise.resolve(request));
    setSpecialNativeChatDispatcher(() => Promise.resolve(), {
      getMainWindow: () => null,
      getAppAdvisorWindow: () => null,
      openAppAdvisorWindow: jest.fn(),
      ensureAppAdvisorWindow: jest.fn(),
    });
    mockedWriteChatTabsFile.mockResolvedValue(undefined);
    mockChatStateService.ensureChatForTrustedSend.mockResolvedValue(undefined);
    mockChatStateService.ingestProviderEvent.mockResolvedValue(true);
    mockChatStateService.hasMutation.mockResolvedValue(false);
    mockChatStateService.reconcileHostQueue.mockResolvedValue(undefined);
    mockChatStateService.removeUnacceptedUserPrompt.mockResolvedValue(
      undefined,
    );
    mockedDispatchWorktreeChatTurn.mockResolvedValue(undefined);
    jest.mocked(isDelegationDeliveryActive).mockReset().mockReturnValue(false);
    mockedDispatchAppAdvisorChatMessage.mockResolvedValue(undefined);
    mockedClearUsageLimitedChat.mockResolvedValue(undefined);
    mockedResolvePersistedApprovalMode.mockImplementation(
      (_projectId, _worktreeId, tabMode) => Promise.resolve(tabMode ?? 'ask'),
    );
    initAiGatewayModels([], []);
    initModelHarnessAssignments({ revision: 0, assignments: [] });
  });

  describe('retired plan chats', () => {
    const legacyTarget = {
      projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
      worktreeId: 'plan-1',
      chatId: 'legacy-chat',
      userMessageId: 'message-1',
    };

    it.each([
      {
        entry: 'sendWorktreeChatMessage',
        send: (): Promise<unknown> =>
          sendWorktreeChatMessage({
            projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
            worktreeId: 'plan-1',
            text: 'hi',
          }),
      },
      {
        entry: 'dispatchLocalWorktreeChatMessage',
        send: (): Promise<unknown> =>
          dispatchLocalWorktreeChatMessage({ ...legacyTarget, text: 'hi' }),
      },
      {
        entry: 'resumeStoppedWorktreeChatTurn',
        send: (): Promise<unknown> =>
          resumeStoppedWorktreeChatTurn(
            { ...legacyTarget, providerType: 'claude' },
            'attempt-1',
          ),
      },
      {
        entry: 'dispatchHostQueuedWorktreeChatMessage',
        send: (): Promise<unknown> =>
          dispatchHostQueuedWorktreeChatMessage(
            { ...legacyTarget, text: 'hi' },
            'desktop',
            true,
          ),
      },
    ])(
      '$entry refuses a legacy plan chat before touching its state',
      async ({ send }) => {
        const submit = jest.spyOn(getChatQueueService(), 'submit');
        try {
          await expect(send()).rejects.toThrow(RETIRED_PLAN_CHAT_MESSAGE);
          expect(submit).not.toHaveBeenCalled();
        } finally {
          submit.mockRestore();
        }
        expect(mockedReadChatTabsFile).not.toHaveBeenCalled();
        expect(
          mockChatStateService.ensureChatForTrustedSend,
        ).not.toHaveBeenCalled();
        expect(mockChatStateService.ingestProviderEvent).not.toHaveBeenCalled();
        expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
      },
    );
  });

  it.each(['hook', 'user'] as const)(
    'retains %s provenance on live host-dispatched prompts',
    async (initiationSource) => {
      await dispatchHostQueuedWorktreeChatMessage(
        {
          projectId: 'workspace-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          userMessageId: 'live-source',
          text: 'Plain text',
          initiationSource,
        },
        'desktop',
        false,
      );
      const source = initiationSource === 'hook' ? 'automated' : 'human';
      expect(mockedCreatePortalEvent).toHaveBeenCalledWith(
        'portal.chat.event',
        expect.objectContaining({
          message: expect.objectContaining({
            messageId: 'live-source',
            promptSource: source,
            parts: expect.arrayContaining([
              { kind: 'prompt_source', data: { source } },
            ]),
          }),
        }),
      );
    },
  );

  it('carries merged watcher attribution on live host-dispatched prompts', async () => {
    const watcherFired = {
      kind: 'Multiple watchers fired (2)',
      combinedWatchers: [
        { kind: 'Pipeline completion (Deploy)', text: 'Deploy succeeded' },
        { kind: 'Chat completion', text: 'Review finished' },
      ],
    };
    await dispatchHostQueuedWorktreeChatMessage(
      {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        userMessageId: 'live-watcher',
        text: 'Deploy succeeded\n\nReview finished',
        watcherFired,
      },
      'desktop',
      false,
    );
    expect(mockedCreatePortalEvent).toHaveBeenCalledWith(
      'portal.chat.event',
      expect.objectContaining({
        message: expect.objectContaining({
          messageId: 'live-watcher',
          promptSource: 'automated',
          watcherFired,
          parts: expect.arrayContaining([
            {
              kind: 'prompt_source',
              data: { source: 'automated', watcherFired },
            },
          ]),
        }),
      }),
    );
  });

  it('routes host-queued desktop turns through the registered main window', async () => {
    const mainWindow = new BrowserWindow();
    setWorktreeChatWindowAccessor(() => mainWindow);

    await dispatchHostQueuedWorktreeChatMessage(
      {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Continue in the fork',
      },
      'desktop',
      false,
    );

    const dispatchOptions = mockedDispatchWorktreeChatTurn.mock.calls[0]?.[0];
    expect(dispatchOptions?.getWindow()).toBe(mainWindow);
    expect(mockChatStateService.runWithScopeActivity).toHaveBeenCalledWith(
      { projectId: 'workspace-1', worktreeId: 'worktree-1' },
      expect.any(Function),
    );
  });

  it.each([
    [undefined, false],
    ['app_advisor', false],
    ['automation', false],
    ['user', true],
    ['portal', true],
  ] as const)(
    'counts skill usage only for explicit user sources (%s) on both send paths',
    async (initiationSource, eligible) => {
      mockedReadChatTabsFile.mockResolvedValue(
        chatTabsFile([
          {
            id: 'chat-1',
            title: 'Worktree chat',
            createdAt: '2026-09-03T00:00:00.000Z',
            kind: 'chat',
            messages: [],
          },
        ]),
      );
      const request = {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: '/release-notes write notes',
        ...(initiationSource ? { initiationSource } : {}),
      };
      await dispatchLocalWorktreeChatMessage(request);
      expect(mockedDispatchWorktreeChatTurn).toHaveBeenLastCalledWith(
        expect.objectContaining({ countsTowardSkillUsage: eligible }),
      );
      await sendWorktreeChatMessage(request);
      expect(mockedDispatchWorktreeChatTurn).toHaveBeenLastCalledWith(
        expect.objectContaining({ countsTowardSkillUsage: eligible }),
      );
    },
  );

  it('resumes a stopped turn with a hidden continuation anchored to the original user message', async () => {
    const queueService = getChatQueueService();
    const confirmTurnRevived = jest.spyOn(queueService, 'confirmTurnRevived');

    await resumeStoppedWorktreeChatTurn(
      {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        providerType: 'claude',
        sdkSessionId: 'session-1',
      },
      'resume-attempt-1',
    );

    expect(confirmTurnRevived).toHaveBeenCalledWith(
      {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
      'message-1',
    );
    expect(confirmTurnRevived.mock.invocationCallOrder[0]).toBeLessThan(
      mockedDispatchWorktreeChatTurn.mock.invocationCallOrder[0] ?? Infinity,
    );

    expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Continue from where you left off. Do not repeat work that is already complete.',
        sdkSessionId: 'session-1',
        hiddenDeferredContinuation: true,
        countsTowardSkillUsage: false,
        hiddenContinuationKind: 'stopped_turn_resume',
        providerEventSequenceNamespace: 'resume-attempt-1',
      }),
    );
    const dispatchOptions = mockedDispatchWorktreeChatTurn.mock.calls[0]?.[0];
    expect(dispatchOptions?.onTurnAccepted).toBeUndefined();
    expect(mockChatStateService.ingestProviderEvent).not.toHaveBeenCalled();
    expect(mockedCreatePortalEvent).not.toHaveBeenCalledWith(
      'portal.chat.event',
      expect.objectContaining({
        message: expect.objectContaining({ role: 'user' }),
      }),
    );
  });

  it('releases the resume queue reservation when dispatch fails', async () => {
    const queueService = getChatQueueService();
    const onTurnTerminal = jest.spyOn(queueService, 'onTurnTerminal');
    mockedDispatchWorktreeChatTurn.mockRejectedValueOnce(
      new Error('resume dispatch failed'),
    );

    await expect(
      resumeStoppedWorktreeChatTurn(
        {
          projectId: 'workspace-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          userMessageId: 'message-1',
          providerType: 'claude',
          sdkSessionId: 'session-1',
        },
        'resume-attempt-1',
      ),
    ).rejects.toThrow('resume dispatch failed');

    expect(onTurnTerminal).toHaveBeenCalledWith(
      {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
      'error',
      'message-1',
    );
  });

  it('rejects a malformed active plan before queueing a desktop send', async () => {
    const submit = jest.spyOn(getChatQueueService(), 'submit');
    const request: ChatSendMessageRequest = {
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      userMessageId: 'message-1',
      text: 'Revise the plan',
    };
    try {
      await expect(
        dispatchLocalWorktreeChatMessage({
          ...request,
          activePlan: { planId: 'plan-1', viewedRevisionNumber: 0 },
        }),
      ).rejects.toThrow('Invalid active plan context.');
      await expect(
        dispatchLocalWorktreeChatMessage(
          Object.assign({ ...request }, { activePlan: 'plan-1' }),
        ),
      ).rejects.toThrow('Invalid active plan context.');

      expect(submit).not.toHaveBeenCalled();
      expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
    } finally {
      submit.mockRestore();
    }
  });

  it('rejects a malformed active plan on a direct send', async () => {
    await expect(
      sendWorktreeChatMessage({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Revise the plan',
        activePlan: { planId: 'plan-1', viewedRevisionNumber: 1.5 },
      }),
    ).rejects.toThrow('Invalid active plan context.');

    expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
  });

  it('keeps a valid active plan on a desktop send queued behind a running turn', async () => {
    const target = {
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
    };
    await dispatchLocalWorktreeChatMessage({
      ...target,
      userMessageId: 'active-message',
      text: 'Start the work',
    });
    await dispatchLocalWorktreeChatMessage({
      ...target,
      userMessageId: 'queued-message',
      text: 'Revise the plan',
      activePlan: { planId: 'plan-1', viewedRevisionNumber: 2 },
    });
    expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledTimes(1);
    expect(
      mockedDispatchWorktreeChatTurn.mock.calls[0]?.[0],
    ).not.toHaveProperty('activePlan');

    getChatQueueService().onTurnTerminal(target, 'complete', 'active-message');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledTimes(2);
    expect(mockedDispatchWorktreeChatTurn.mock.calls[1]?.[0]).toMatchObject({
      userMessageId: 'queued-message',
      activePlan: { planId: 'plan-1', viewedRevisionNumber: 2 },
    });
  });

  it('refuses a recovered delegated completion before persisting or launching a parent turn', async () => {
    await dispatchHostQueuedWorktreeChatMessage(
      {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        userMessageId: 'delivery-id',
        managedDelegationDeliveryId: 'delivery-id',
        text: 'Retained child result',
        initiationSource: 'automation',
      },
      'desktop',
      true,
    );
    expect(
      mockChatStateService.ensureChatForTrustedSend,
    ).not.toHaveBeenCalled();
    expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
  });

  it('dispatches a claimed completion through the normal automation prompt and queue path', async () => {
    const mainWindow = new BrowserWindow();
    setWorktreeChatWindowAccessor(() => mainWindow);
    jest.mocked(isDelegationDeliveryActive).mockReturnValue(true);
    mockedDispatchWorktreeChatTurn.mockImplementationOnce((options) => {
      options.onTurnAccepted?.();
      return Promise.resolve();
    });
    await dispatchHostQueuedWorktreeChatMessage(
      {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        userMessageId: 'delivery-id',
        managedDelegationDeliveryId: 'delivery-id',
        text: 'Retained child result',
        initiationSource: 'automation',
      },
      'desktop',
      false,
    );
    expect(mockedDispatchWorktreeChatTurn.mock.calls[0]?.[0]).toMatchObject({
      userMessageId: 'delivery-id',
      initiationSource: 'automation',
    });
    expect(sendToWindow).toHaveBeenCalledWith(
      mainWindow,
      IPC_CHANNELS.chatEvent,
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'canopy_user_prompt_accepted',
          canopy_turn_user_message_id: 'delivery-id',
        }),
      }),
    );
  });

  it('does not consume a delegated completion before turn preparation reaches provider dispatch', async () => {
    jest.mocked(isDelegationDeliveryActive).mockReturnValue(true);
    mockedDispatchWorktreeChatTurn.mockImplementation(() =>
      Promise.reject(new Error('Auth preflight failed')),
    );
    await expect(
      dispatchHostQueuedWorktreeChatMessage(
        {
          projectId: 'workspace-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          userMessageId: 'delivery-id',
          managedDelegationDeliveryId: 'delivery-id',
          text: 'Retained child result',
          initiationSource: 'automation',
        },
        'desktop',
        true,
      ),
    ).rejects.toThrow('Auth preflight failed');
    const lifecycle = jest.requireMock<{
      claimDelegationDelivery: jest.Mock;
    }>('../../agents/delegation/lifecycle');
    expect(lifecycle.claimDelegationDelivery).not.toHaveBeenCalled();
  });

  it('removes an unaccepted delegated prompt without projecting it to the portal', async () => {
    jest.mocked(isDelegationDeliveryActive).mockReturnValue(true);
    mockedDispatchWorktreeChatTurn.mockRejectedValueOnce(
      new Error('Delegation completion owner is no longer active'),
    );

    await expect(
      dispatchHostQueuedWorktreeChatMessage(
        {
          projectId: 'workspace-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          userMessageId: 'delivery-id',
          managedDelegationDeliveryId: 'delivery-id',
          text: 'Retained child result',
          initiationSource: 'automation',
        },
        'desktop',
        true,
      ),
    ).rejects.toThrow('Delegation completion owner is no longer active');
    expect(
      mockChatStateService.removeUnacceptedUserPrompt,
    ).toHaveBeenCalledWith({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      userMessageId: 'delivery-id',
    });
    expect(mockedEnqueuePortalEvent).not.toHaveBeenCalled();
  });
  it('resolves Auto at the shared host dispatch boundary', async () => {
    setAutoModelRoutingDispatcher((request, origin, fromQueue) => {
      expect(origin).toBe('desktop');
      expect(fromQueue).toBe(true);
      return Promise.resolve({
        ...request,
        model: 'claude-sonnet-4-6',
        providerType: 'claude',
      });
    });

    await dispatchHostQueuedWorktreeChatMessage(
      {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Route this when dequeued',
        initiationSource: 'user',
        model: 'claude-opus-4-6',
        modelSelectionMode: 'auto',
      },
      'desktop',
      true,
    );

    expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-sonnet-4-6',
        providerType: 'claude',
        modelSelectionMode: 'auto',
        countsTowardSkillUsage: true,
      }),
    );
  });

  it('resolves Auto before cowork uses the special native dispatcher', async () => {
    const nativeDispatch = jest.fn().mockResolvedValue(undefined);
    registerWorkspaceTypes(new Map([['cowork-1', 'cowork']]));
    setSpecialNativeChatDispatcher(nativeDispatch, {
      getMainWindow: () => null,
      getAppAdvisorWindow: () => null,
      openAppAdvisorWindow: jest.fn(),
      ensureAppAdvisorWindow: jest.fn(),
    });
    setAutoModelRoutingDispatcher((request) =>
      Promise.resolve({
        ...request,
        model: 'claude-haiku-4-5-20251001',
      }),
    );

    await dispatchHostQueuedWorktreeChatMessage(
      {
        projectId: 'cowork-1',
        worktreeId: 'entry-1',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Route this cowork turn',
        modelSelectionMode: 'auto',
      },
      'desktop',
      false,
    );

    expect(nativeDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-haiku-4-5-20251001',
        modelSelectionMode: 'auto',
      }),
    );
  });

  it.each(['tools', 'timer'] as const)(
    'preserves canonical %s when an automated Codex continuation finishes',
    async (assertion) => {
      const directory = mkdtempSync(join(tmpdir(), 'canopy-retry-history-'));
      const scope = { projectId: 'workspace-1', worktreeId: 'worktree-1' };
      const repository = new ChatStateV2Repository({
        resolvePaths: () => ({
          tabs: join(directory, 'chats.json'),
          archives: join(directory, 'archives.json'),
          journal: join(directory, 'journal.jsonl'),
        }),
      });
      const { ChatStateService } = jest.requireActual<
        typeof ChatStateServiceModule
      >('../chat-state-service');
      const target = new ChatStateService({
        repository,
        dispatch: () => Promise.resolve(),
        authorizeSend: () => Promise.resolve(),
        cleanupSession: () => Promise.resolve(),
        recordDiagnostic: jest.fn(),
      });
      const originalReplace =
        mockChatStateService.replaceCompatibilityTabs.getMockImplementation();
      const originalIngest =
        mockChatStateService.ingestProviderEvent.getMockImplementation();
      const output = 'complete tool output\n'.repeat(300);
      try {
        await target.replaceCompatibilityTabs(
          scope,
          chatTabsFile([
            {
              id: 'chat-1',
              title: 'Retry history',
              createdAt: new Date().toISOString(),
              providerType: 'codex',
              model: 'gpt-6-sol',
              sdkSessionId: 'retry-thread',
              messages: [],
            },
          ]),
        );
        mockedReadChatTabsFile.mockImplementation(() =>
          target.getCompatibilityTabs(scope, { chatIds: ['chat-1'] }),
        );
        mockChatStateService.replaceCompatibilityTabs.mockImplementation(
          async (currentScope, file) => {
            if (
              assertion === 'timer' &&
              file.tabs[0].messages.some(
                (message) => message.id === 'codex-retry-answer',
              )
            ) {
              // The provider can finish while the display callback holds a
              // pre-completion snapshot. Commit that native event first, then
              // let the compatibility write race in with its stale timer.
              await target.ingestProviderEvent({
                ...scope,
                chatId: 'chat-1',
                providerType: 'codex',
                turnUserMessageId: 'retry-user',
                mutationId: 'chat-1:retry-user:provider:initial:3',
                data: {
                  type: 'codex',
                  event: {
                    type: 'turn.completed',
                    thread_id: 'retry-thread',
                    turn_id: 'retry-turn',
                  },
                },
              });
            }
            return target.replaceCompatibilityTabs(currentScope, file);
          },
        );
        mockChatStateService.ingestProviderEvent.mockImplementation((input) =>
          target.ingestProviderEvent(input),
        );
        mockedDispatchWorktreeChatTurn.mockImplementationOnce(
          async (options) => {
            let sequence = 0;
            const deliver = async (event: Record<string, unknown>) => {
              const data = { type: 'codex', event };
              await options.onBeforeChatEvent({
                ...scope,
                chatId: 'chat-1',
                data,
                sequenceNamespace: 'initial',
                sequence: sequence++,
                turnUserMessageId: 'retry-user',
              });
              options.onChatEvent?.({
                ...scope,
                chatId: 'chat-1',
                data,
                isTerminalEvent: event.type === 'turn.completed',
              });
            };
            await deliver({
              type: 'turn.started',
              thread_id: 'retry-thread',
              turn_id: 'retry-turn',
            });
            await deliver({
              type: 'item.completed',
              thread_id: 'retry-thread',
              turn_id: 'retry-turn',
              item: {
                type: 'command_execution',
                id: 'retry-command',
                command: 'echo retry',
                aggregated_output: output,
                status: 'completed',
                exit_code: 0,
              },
            });
            // Drain the old compatibility writer before the next provider item.
            await enqueueChatTabMutation(
              scope.projectId,
              scope.worktreeId,
              () => Promise.resolve(),
            );
            await deliver({
              type: 'item.completed',
              thread_id: 'retry-thread',
              turn_id: 'retry-turn',
              item: {
                type: 'agent_message',
                id: 'retry-answer',
                text: 'Recovered.',
                phase: 'final_answer',
              },
            });
            await enqueueChatTabMutation(
              scope.projectId,
              scope.worktreeId,
              () => Promise.resolve(),
            );
            await deliver({
              type: 'turn.completed',
              thread_id: 'retry-thread',
              turn_id: 'retry-turn',
            });
          },
        );
        await dispatchHostQueuedWorktreeChatMessage(
          {
            ...scope,
            chatId: 'chat-1',
            userMessageId: 'retry-user',
            text: 'Continue',
            providerType: 'codex',
            model: 'gpt-6-sol',
            initiationSource: 'automation',
          },
          'portal',
          false,
        );
        await enqueueChatTabMutation(scope.projectId, scope.worktreeId, () =>
          Promise.resolve(),
        );
        const state = await target.getState(scope);
        const messages = state.tabsFile.tabs[0].messages;
        if (assertion === 'tools') {
          expect(
            messages.find((message) => message.id === 'codex-retry-command'),
          ).toMatchObject({
            role: 'system',
            blocks: [
              { type: 'tool_use', toolName: 'command', input: 'echo retry' },
              { type: 'tool_result', toolName: 'command', output },
            ],
          });
        } else {
          expect(state.runtimeByChatId['chat-1'].status).toBe('completed');
          expect(
            messages
              .flatMap((message) => message.blocks)
              .filter((block) => block.type === 'turn_timer'),
          ).toEqual([
            expect.objectContaining({ completedAt: expect.any(Number) }),
          ]);
        }
      } finally {
        if (originalReplace)
          mockChatStateService.replaceCompatibilityTabs.mockImplementation(
            originalReplace,
          );
        if (originalIngest)
          mockChatStateService.ingestProviderEvent.mockImplementation(
            originalIngest,
          );
        await repository.drainAll();
        rmSync(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it('admits a queued cowork dispatch before host-side turn preparation', async () => {
    registerWorkspaceTypes(new Map([['cowork-1', 'cowork' as const]]));

    await dispatchHostQueuedWorktreeChatMessage(
      {
        projectId: 'cowork-1',
        worktreeId: 'entry-1',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Dispatch this queued cowork prompt',
      },
      'desktop',
      true,
    );

    expect(mockChatStateService.runWithScopeActivity).toHaveBeenCalledWith(
      { projectId: 'cowork-1', worktreeId: 'entry-1' },
      expect.any(Function),
    );
  });

  it('admits a queued App Advisor dispatch before host-side turn preparation', async () => {
    await dispatchHostQueuedWorktreeChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_ENTRY_ID,
        chatId: 'advisor-chat-1',
        userMessageId: 'message-1',
        text: 'Dispatch this queued advisor prompt',
      },
      'desktop',
      true,
    );

    expect(mockChatStateService.runWithScopeActivity).toHaveBeenCalledWith(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_ENTRY_ID,
      },
      expect.any(Function),
    );
  });

  it('admits a direct cowork send before reading or mutating chat state', async () => {
    registerWorkspaceTypes(new Map([['cowork-1', 'cowork' as const]]));
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Cowork chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
        },
      ]),
    );

    await sendWorktreeChatMessage({
      projectId: 'cowork-1',
      worktreeId: 'entry-1',
      chatId: 'chat-1',
      userMessageId: 'message-1',
      text: 'Dispatch this direct cowork prompt',
    });

    expect(mockChatStateService.runWithScopeActivity).toHaveBeenCalledWith(
      { projectId: 'cowork-1', worktreeId: 'entry-1' },
      expect.any(Function),
    );
  });

  it("reports a message committed once the chat's canonical transcript holds it", async () => {
    mockChatStateService.hasTranscriptMessage.mockResolvedValueOnce(true);
    await expect(
      isWorktreeChatMessageCommitted({
        projectId: 'p1',
        worktreeId: 'w1',
        chatId: 'chat-1',
        userMessageId: 'user-1',
      }),
    ).resolves.toBe(true);
    expect(mockChatStateService.hasTranscriptMessage).toHaveBeenCalledWith(
      { projectId: 'p1', worktreeId: 'w1' },
      'chat-1',
      'user-1',
    );
  });

  it('saves a prompt before a dispatch that fails, and accepts it when the send is retried', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Worktree chat',
          createdAt: '2026-09-03T00:00:00.000Z',
          kind: 'chat',
          messages: [],
        },
      ]),
    );
    const request = {
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      userMessageId: 'first-message',
      text: 'Start the review',
    };
    mockedDispatchWorktreeChatTurn.mockRejectedValueOnce(
      new Error('provider failed to initialise'),
    );
    await expect(sendWorktreeChatMessage(request)).rejects.toThrow(
      'provider failed to initialise',
    );
    // The prompt was saved under its id before the dispatch failed.
    expect(mockChatStateService.ingestProviderEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'canopy_user_prompt',
          canopy_turn_user_message_id: 'first-message',
        }),
      }),
    );

    mockedDispatchWorktreeChatTurn.mockImplementationOnce((options) => {
      options.onTurnAccepted?.();
      return Promise.resolve();
    });
    await sendWorktreeChatMessage(request);
    expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledTimes(2);
    expect(mockChatStateService.ingestProviderEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        mutationId: 'chat-1:first-message:accepted',
      }),
    );
  });

  it('admits a direct ordinary worktree send before reading or mutating chat state', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Worktree chat',
          createdAt: '2026-09-03T00:00:00.000Z',
          kind: 'chat',
          messages: [],
        },
      ]),
    );

    await sendWorktreeChatMessage({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      userMessageId: 'message-1',
      text: 'Dispatch this direct worktree prompt',
    });

    expect(mockChatStateService.runWithScopeActivity).toHaveBeenCalledWith(
      { projectId: 'workspace-1', worktreeId: 'worktree-1' },
      expect.any(Function),
    );
  });

  it('carries attachment metadata on the live portal user-message event for a portal-initiated send', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Worktree chat',
          createdAt: '2026-09-03T00:00:00.000Z',
          kind: 'chat',
          messages: [],
        },
      ]),
    );

    await sendWorktreeChatMessage({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      userMessageId: 'message-portal-1',
      text: 'Look at this screenshot',
      attachmentPaths: ['/w/attachments/t/screen.png'],
    });

    expect(mockedCreatePortalEvent).toHaveBeenCalledWith(
      'portal.chat.event',
      expect.objectContaining({
        message: expect.objectContaining({
          messageId: 'message-portal-1',
          role: 'user',
          promptSource: 'human',
          parts: expect.arrayContaining([
            { kind: 'prompt_source', data: { source: 'human' } },
          ]),
          text: 'Look at this screenshot',
          attachments: [
            expect.objectContaining({
              filename: 'screen.png',
              mediaType: 'image/png',
            }),
          ],
        }),
      }),
    );
  });

  it.each([
    {
      mode: 'Code portal',
      projectId: 'workspace-1',
      scope: 'worktree',
      hostQueued: false,
    },
    {
      mode: 'Cowork portal',
      projectId: 'cowork-1',
      scope: 'standalone',
      hostQueued: false,
    },
    {
      mode: 'Code host queue',
      projectId: 'workspace-1',
      scope: 'worktree',
      hostQueued: true,
    },
  ] as const)(
    'preserves normalized canonical attachment asset identities on live $mode events',
    async ({ projectId, scope, hostQueued }) => {
      registerWorkspaceTypes(new Map([['cowork-1', 'cowork']]));
      mockedReadChatTabsFile.mockResolvedValue(
        chatTabsFile([
          {
            id: 'chat-1',
            title: 'Attachment parity',
            createdAt: '2026-09-03T00:00:00.000Z',
            kind: 'chat',
            messages: [],
          },
        ]),
      );
      const userMessageId = 'message-attachment-assets';
      const agentSent: AgentSentInfo = {
        kind: 'external_agent',
        connectionId: '123e4567-e89b-42d3-a456-426614174000',
        clientName: 'Web MCP Agent',
        verified: true,
        userId: '123e4567-e89b-42d3-a456-426614174001',
      };
      const attachmentPaths = [
        '',
        '   ',
        '/private/attachments/図-é.png',
        '/private/attachments/図-é.png',
        'C:\\private\\attachments\\árvore-日本語.txt',
        '/private/attachments/résumé-日本語.md',
      ];
      const request = {
        projectId,
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        userMessageId,
        text: 'Review these attachments',
        attachmentPaths,
        agentSent,
      };
      if (hostQueued) {
        await dispatchHostQueuedWorktreeChatMessage(request, 'desktop', true);
      } else {
        await sendWorktreeChatMessage(request);
      }
      const expectedAttachments = [
        expect.objectContaining({
          filename: '図-é.png',
          mediaType: 'image/png',
          assetId: portalChatAssetId(userMessageId, 'attachment', 0),
        }),
        expect.objectContaining({
          filename: 'árvore-日本語.txt',
          mediaType: 'text/plain',
          assetId: portalChatAssetId(userMessageId, 'attachment', 1),
        }),
        expect.objectContaining({
          filename: 'résumé-日本語.md',
          mediaType: 'text/markdown',
          assetId: portalChatAssetId(userMessageId, 'attachment', 2),
        }),
      ];
      const persisted = persistedMessageToPortalMessage(
        {
          scope,
          chatId: request.chatId,
          message: {
            id: userMessageId,
            role: 'user',
            timestamp: 1,
            blocks: [{ type: 'text', text: request.text }],
            attachmentPaths,
            agentSent,
          },
        },
        { includeAssetReferences: true },
      );
      expect(persisted.attachments).toEqual(expectedAttachments);
      expect(persisted.agentSent).toEqual(agentSent);
      const liveEvent = mockedCreatePortalEvent.mock.calls.find(
        ([type, payload]) => {
          const eventPayload: unknown = payload;
          return (
            type === 'portal.chat.event' &&
            isRecord(eventPayload) &&
            isRecord(eventPayload.message) &&
            eventPayload.message.messageId === userMessageId
          );
        },
      );
      const payload: unknown = liveEvent?.[1];
      expect(payload).toMatchObject({
        scope,
        message: {
          messageId: userMessageId,
          attachments: expectedAttachments,
          agentSent,
        },
      });
      if (!isRecord(payload) || !isRecord(payload.message)) {
        throw new Error('Expected a live user-message event');
      }
      expect(payload.message.attachments).toEqual(persisted.attachments);
      expect(JSON.stringify(payload.message)).not.toContain(
        '/private/attachments',
      );
      expect(JSON.stringify(payload.message)).not.toContain('C:\\\\private');
      expect(payload.message).not.toHaveProperty('attachmentPaths');
    },
  );

  it('omits attachments from the live portal user-message event for a portal-initiated send without any', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Worktree chat',
          createdAt: '2026-09-03T00:00:00.000Z',
          kind: 'chat',
          messages: [],
        },
      ]),
    );

    await sendWorktreeChatMessage({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      userMessageId: 'message-portal-2',
      text: 'No attachments here',
    });

    const userPortalEventCall = mockedCreatePortalEvent.mock.calls.find(
      ([type, payload]) => {
        if (type !== 'portal.chat.event') return false;
        const eventPayload: unknown = payload;
        return (
          isRecord(eventPayload) &&
          isRecord(eventPayload.message) &&
          eventPayload.message.messageId === 'message-portal-2'
        );
      },
    );
    const message = isRecord(userPortalEventCall?.[1])
      ? userPortalEventCall[1].message
      : undefined;
    expect(isRecord(message) ? 'attachments' in message : true).toBe(false);
  });

  it('durably accepts an immediate desktop turn without re-emitting it to the renderer', async () => {
    mockedDispatchWorktreeChatTurn.mockImplementationOnce((options) => {
      options.onTurnAccepted?.();
      return Promise.resolve();
    });

    await dispatchHostQueuedWorktreeChatMessage(
      {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Start immediately',
        pendingSystemInstructions: [
          { id: 'instruction-1', text: 'Use the migrated worktree.' },
        ],
      },
      'desktop',
      false,
    );

    expect(mockChatStateService.ingestProviderEvent).toHaveBeenCalledWith({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      data: {
        type: CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE,
        canopy_turn_user_message_id: 'message-1',
        canopy_consumed_pending_system_instruction_ids: ['instruction-1'],
      },
      mutationId: 'chat-1:message-1:accepted',
      turnUserMessageId: 'message-1',
    });
    expect(mockedSendToWindow).not.toHaveBeenCalled();
  });

  describe('queued independent branch startup', () => {
    const request = {
      projectId: 'workspace-1',
      worktreeId: 'child-worktree',
      chatId: 'child-chat',
      userMessageId: 'first-send',
      text: 'Continue',
      pendingSystemInstructions: [
        { id: 'independent-agent-start', text: 'Investigate independently' },
      ],
    };
    beforeEach(() => {
      mockChatStateService.command
        .mockReset()
        .mockResolvedValue({ outcome: 'applied' });
      mockChatStateService.getCompatibilityTabs.mockResolvedValue(
        chatTabsFile([
          {
            id: request.chatId,
            title: 'Independent branch',
            kind: 'chat',
            createdAt: '2026-10-03T00:00:00.000Z',
            messages: [],
            pendingSystemInstructions: request.pendingSystemInstructions,
            forkedFrom: {
              projectId: 'workspace-1',
              worktreeId: 'source-worktree',
              chatId: 'source-chat',
            },
          },
        ]),
      );
    });
    it.each([false, true])(
      'closes the branch on initial prompt persistence failure (host queued: %s)',
      async (fromQueue) => {
        const failure = new Error('initial prompt write failed');
        mockChatStateService.ingestProviderEvent.mockRejectedValueOnce(failure);
        await expect(
          dispatchHostQueuedWorktreeChatMessage(request, 'desktop', fromQueue),
        ).rejects.toBe(failure);
        expect(mockChatStateService.command).toHaveBeenCalledWith(
          expect.objectContaining({
            projectId: request.projectId,
            worktreeId: request.worktreeId,
            command: {
              type: 'chat.close_tab',
              tabId: request.chatId,
              mode: 'archive',
            },
          }),
        );
        expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
      },
    );
    it('still closes when recording the queued startup error also fails', async () => {
      const failure = new Error('initial prompt write failed');
      mockChatStateService.ingestProviderEvent
        .mockRejectedValueOnce(failure)
        .mockRejectedValueOnce(new Error('error record failed'));
      await expect(
        dispatchHostQueuedWorktreeChatMessage(request, 'desktop', false),
      ).rejects.toBe(failure);
      expect(mockChatStateService.command).toHaveBeenCalledWith(
        expect.objectContaining({
          command: {
            type: 'chat.close_tab',
            tabId: request.chatId,
            mode: 'archive',
          },
        }),
      );
    });
    it('retains a startup with an already-durable accepted receipt', async () => {
      const failure = new Error('repeated dispatch failed');
      mockChatStateService.ingestProviderEvent.mockRejectedValueOnce(failure);
      mockChatStateService.hasMutation.mockResolvedValue(true);
      await expect(
        dispatchHostQueuedWorktreeChatMessage(request, 'desktop', false),
      ).rejects.toBe(failure);
      expect(mockChatStateService.command).not.toHaveBeenCalled();
    });
    it('does not close a turn whose provider accepted it before dispatch rejected', async () => {
      const failure = new Error('post-acceptance error');
      mockedDispatchWorktreeChatTurn.mockImplementationOnce((options) => {
        options.onTurnAccepted?.();
        return Promise.reject(failure);
      });
      await expect(
        dispatchHostQueuedWorktreeChatMessage(request, 'desktop', false),
      ).rejects.toBe(failure);
      expect(mockChatStateService.command).not.toHaveBeenCalled();
    });
    it('does not treat a stale renderer instruction as pending canonical startup', async () => {
      mockChatStateService.getCompatibilityTabs.mockResolvedValue(
        chatTabsFile([
          {
            id: request.chatId,
            title: 'Accepted branch',
            kind: 'chat',
            createdAt: '2026-10-03T00:00:00.000Z',
            messages: [],
          },
        ]),
      );
      const failure = new Error('ordinary later send failed');
      mockChatStateService.ingestProviderEvent.mockRejectedValueOnce(failure);
      await expect(
        dispatchHostQueuedWorktreeChatMessage(request, 'desktop', false),
      ).rejects.toBe(failure);
      expect(mockChatStateService.command).not.toHaveBeenCalled();
    });
  });

  it('announces an idle watcher root that has no optimistic renderer message', async () => {
    mockChatStateService.ingestProviderEvent.mockResolvedValue(true);
    await dispatchHostQueuedWorktreeChatMessage(
      {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        userMessageId: 'watcher-idle',
        text: 'Build finished',
        watcherFired: { kind: 'Wakeup' },
      },
      'desktop',
      false,
    );
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.chatEvent,
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'canopy_user_prompt',
          canopy_turn_user_message_id: 'watcher-idle',
        }),
      }),
    );
  });

  it('records acceptance for every consolidated watcher delivery id', async () => {
    mockedDispatchWorktreeChatTurn.mockImplementationOnce((options) => {
      options.onTurnAccepted?.();
      return Promise.resolve();
    });

    await dispatchHostQueuedWorktreeChatMessage(
      {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        userMessageId: 'watcher-delivery-1',
        consolidatedWatcherUserMessageIds: [
          'watcher-delivery-1',
          'watcher-delivery-2',
        ],
        text: 'Two watcher prompts',
        watcherFired: { kind: 'Multiple watchers fired (2)' },
      },
      'desktop',
      false,
    );

    expect(mockChatStateService.ingestProviderEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        mutationId: 'chat-1:watcher-delivery-1:accepted',
      }),
    );
    expect(mockChatStateService.ingestProviderEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        mutationId: 'chat-1:watcher-delivery-2:accepted',
      }),
    );
  });

  it('commits forced queue cancellation before broadcasting it', async () => {
    let releaseCommit: ((value: boolean) => void) | undefined;
    mockChatStateService.ingestProviderEvent.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseCommit = resolve;
        }),
    );

    const request = emitHostQueueForcedCancellation(
      {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
      'message-1',
    );
    await Promise.resolve();

    expect(mockChatStateService.ingestProviderEvent).toHaveBeenCalledWith({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      data: {
        type: 'result',
        is_error: false,
        result: 'Cancelled',
        canopy_turn_user_message_id: 'message-1',
      },
      mutationId: 'message-1:forced-cancellation',
      turnUserMessageId: 'message-1',
    });
    expect(mockedSendToWindow).not.toHaveBeenCalled();

    releaseCommit?.(true);
    await request;

    expect(mockedSendToWindow).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.chatEvent,
      expect.objectContaining({
        chatId: 'chat-1',
        data: expect.objectContaining({ result: 'Cancelled' }),
      }),
    );
  });

  it('materializes a newly created renderer tab before durable prompt ingestion', async () => {
    let canonicalTabExists = false;
    mockChatStateService.ensureChatForTrustedSend.mockImplementationOnce(() => {
      canonicalTabExists = true;
      return Promise.resolve();
    });
    mockChatStateService.ingestProviderEvent.mockImplementationOnce(() =>
      canonicalTabExists
        ? Promise.resolve(true)
        : Promise.reject(
            new Error('Provider event targets missing chat chat-new'),
          ),
    );

    const request = {
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-new',
      userMessageId: 'message-new',
      text: 'Start the new chat',
      providerType: 'claude' as const,
      model: 'claude-sonnet-4-5' as const,
    };
    await expect(
      dispatchHostQueuedWorktreeChatMessage(request, 'desktop', false),
    ).resolves.toBeUndefined();

    expect(mockChatStateService.ensureChatForTrustedSend).toHaveBeenCalledWith(
      request,
    );
    expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledTimes(1);
  });

  it('preserves attachment metadata when a host-queued desktop turn starts', async () => {
    const mainWindow = new BrowserWindow();
    const agentSent: AgentSentInfo = {
      kind: 'external_agent',
      connectionId: '123e4567-e89b-42d3-a456-426614174000',
      clientName: 'Web MCP Agent',
      verified: true,
      userId: '123e4567-e89b-42d3-a456-426614174001',
    };
    setWorktreeChatWindowAccessor(() => mainWindow);

    await dispatchHostQueuedWorktreeChatMessage(
      {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Review the attachment',
        fileReferences: [
          {
            displayPath: 'src/index.ts',
            absolutePath: '/repo/src/index.ts',
            repoName: 'canopy',
          },
        ],
        attachmentPaths: ['/attachments/context.png'],
        attachmentPromptContexts: [
          {
            attachmentPath: '/attachments/context.png',
            promptKind: 'in-app-browser-resource',
          },
        ],
        inputMode: 'voice',
        providerType: 'claude',
        agentSent,
      },
      'desktop',
      true,
    );
    expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({ agentSent }),
    );

    const promptCall = mockedSendToWindow.mock.calls.find(
      ([target, channel]) =>
        target === mainWindow && channel === IPC_CHANNELS.chatEvent,
    );
    expect(promptCall?.[2]).toMatchObject({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      data: {
        type: 'canopy_user_prompt',
        canopy_turn_user_message_id: 'message-1',
        canopy_persisted_messages: [
          expect.objectContaining({
            id: 'message-1',
            role: 'user',
            blocks: [
              {
                type: 'file_references',
                references: [
                  {
                    displayPath: 'src/index.ts',
                    absolutePath: '/repo/src/index.ts',
                    repoName: 'canopy',
                  },
                ],
              },
              { type: 'text', text: 'Review the attachment' },
            ],
            attachmentPaths: ['/attachments/context.png'],
            attachmentPromptContexts: [
              {
                attachmentPath: '/attachments/context.png',
                promptKind: 'in-app-browser-resource',
              },
            ],
            inputMode: 'voice',
            agentSent,
          }),
        ],
      },
    });

    const userPortalEventCall = mockedCreatePortalEvent.mock.calls.find(
      ([type, payload]) => {
        if (type !== 'portal.chat.event') return false;
        const eventPayload: unknown = payload;
        return (
          isRecord(eventPayload) &&
          isRecord(eventPayload.message) &&
          eventPayload.message.messageId === 'message-1'
        );
      },
    );
    expect(userPortalEventCall?.[1]).toMatchObject({
      message: {
        role: 'user',
        text: 'Review the attachment',
        agentSent,
        promptSource: 'human',
        parts: expect.arrayContaining([
          { kind: 'prompt_source', data: { source: 'human' } },
        ]),
        attachments: [
          expect.objectContaining({
            filename: 'context.png',
            mediaType: 'image/png',
          }),
        ],
      },
    });
  });

  it('omits attachments from the live portal user-message event when the host-queued turn carries none', async () => {
    const mainWindow = new BrowserWindow();
    setWorktreeChatWindowAccessor(() => mainWindow);

    await dispatchHostQueuedWorktreeChatMessage(
      {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        userMessageId: 'message-no-attachments',
        text: 'No attachments here',
        providerType: 'claude',
      },
      'desktop',
      true,
    );

    const userPortalEventCall = mockedCreatePortalEvent.mock.calls.find(
      ([type, payload]) => {
        if (type !== 'portal.chat.event') return false;
        const eventPayload: unknown = payload;
        return (
          isRecord(eventPayload) &&
          isRecord(eventPayload.message) &&
          eventPayload.message.messageId === 'message-no-attachments'
        );
      },
    );
    expect(userPortalEventCall?.[1]).toMatchObject({
      message: {
        role: 'user',
        text: 'No attachments here',
      },
    });
    const message = isRecord(userPortalEventCall?.[1])
      ? userPortalEventCall[1].message
      : undefined;
    expect(isRecord(message) ? 'attachments' in message : true).toBe(false);
  });

  it('lets an activity-only provider event through but holds back a rejected one', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Activity turn',
          createdAt: '2026-08-07T12:00:00.000Z',
          messages: [],
          providerType: 'claude',
          model: 'claude-sonnet-4-5',
        },
      ]),
    );
    // Neither status event is a durable commit; only 'busy' is activity-only.
    const statusOf = (data: unknown): unknown =>
      isRecord(data) && data.type === 'system' ? data.status : undefined;
    mockChatStateService.ingestProviderEvent.mockImplementation((input) =>
      Promise.resolve(statusOf(input.data) === undefined),
    );
    const outcome = jest
      .spyOn(mockChatStateService, 'ingestProviderEventWithOutcome')
      .mockImplementation((input) =>
        Promise.resolve(
          statusOf(input.data) === 'busy'
            ? 'activity-only'
            : statusOf(input.data) === 'stale'
              ? 'not-applied'
              : 'applied',
        ),
      );
    const deliverable: (boolean | void)[] = [];
    mockedDispatchWorktreeChatTurn.mockImplementationOnce(async (options) => {
      for (const [sequence, status] of ['busy', 'stale'].entries()) {
        deliverable.push(
          await options.onBeforeChatEvent({
            projectId: options.projectId,
            worktreeId: options.worktreeId,
            chatId: options.chatId,
            data: { type: 'system', subtype: 'status', status },
            sequenceNamespace: 'initial',
            sequence,
          }),
        );
      }
    });

    try {
      await dispatchHostQueuedWorktreeChatMessage(
        {
          projectId: 'workspace-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          userMessageId: 'user-activity',
          text: 'Keep going.',
          providerType: 'claude',
          model: 'claude-sonnet-4-5',
        },
        'desktop',
        true,
      );

      expect(deliverable).toEqual([true, false]);
      expect(outcome).toHaveBeenCalledTimes(2);
    } finally {
      outcome.mockRestore();
      mockChatStateService.ingestProviderEvent.mockResolvedValue(true);
    }
  });

  it('persists provider events with the provider lane selection ran', async () => {
    const outcome = jest
      .spyOn(mockChatStateService, 'ingestProviderEventWithOutcome')
      .mockResolvedValue('applied');
    mockedDispatchWorktreeChatTurn.mockImplementationOnce(async (options) => {
      await options.onBeforeChatEvent({
        projectId: options.projectId,
        worktreeId: options.worktreeId,
        chatId: options.chatId,
        data: { type: 'user', message: { content: [] } },
        sequenceNamespace: 'initial',
        sequence: 0,
        providerType: 'claude',
      });
    });

    try {
      await dispatchHostQueuedWorktreeChatMessage(
        {
          projectId: 'workspace-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          userMessageId: 'user-lane',
          text: 'Show the chart.',
          providerType: 'codex',
          model: 'claude-sonnet-4-5',
        },
        'desktop',
        true,
      );

      expect(outcome).toHaveBeenCalledWith(
        expect.objectContaining({ providerType: 'claude' }),
      );
    } finally {
      outcome.mockRestore();
    }
  });

  it('persists provider events with the session provider when the request names none', async () => {
    const outcome = jest
      .spyOn(mockChatStateService, 'ingestProviderEventWithOutcome')
      .mockResolvedValue('applied');
    mockedDispatchWorktreeChatTurn.mockImplementationOnce(async (options) => {
      await options.onBeforeChatEvent({
        projectId: options.projectId,
        worktreeId: options.worktreeId,
        chatId: options.chatId,
        data: { type: 'user', message: { content: [] } },
        sequenceNamespace: 'initial',
        sequence: 0,
        providerType: 'claude',
      });
    });

    try {
      await dispatchHostQueuedWorktreeChatMessage(
        {
          projectId: 'workspace-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          userMessageId: 'user-provider',
          text: 'Show the chart.',
          model: 'claude-sonnet-4-5',
        },
        'desktop',
        true,
      );

      expect(outcome).toHaveBeenCalledWith(
        expect.objectContaining({ providerType: 'claude' }),
      );
    } finally {
      outcome.mockRestore();
    }
  });

  it('routes a provider turn through durable ingestion after the renderer disappears', async () => {
    let persisted = chatTabsFile([
      {
        id: 'chat-1',
        title: 'Renderer-free turn',
        createdAt: '2026-08-07T12:00:00.000Z',
        messages: [],
        providerType: 'claude',
        model: 'claude-sonnet-4-5',
      },
    ]);
    mockedReadChatTabsFile.mockImplementation(() => Promise.resolve(persisted));
    mockedWriteChatTabsFile.mockImplementation(
      (_projectId, _worktreeId, next) => {
        persisted = next;
        return Promise.resolve();
      },
    );
    const mainWindow = new BrowserWindow();
    setWorktreeChatWindowAccessor(() => mainWindow);
    mockedDispatchWorktreeChatTurn.mockImplementationOnce(async (options) => {
      mainWindow.destroy();
      let sequence = 0;
      for (const data of [
        {
          type: 'system',
          subtype: 'init',
          session_id: 'session-renderer-free',
        },
        {
          type: 'assistant',
          message: {
            id: 'assistant-renderer-free',
            role: 'assistant',
            content: [
              { type: 'text', text: 'I can finish without a renderer.' },
              {
                type: 'tool_use',
                id: 'tool-renderer-free',
                name: 'Read',
                input: { file_path: '/tmp/example.ts' },
              },
            ],
          },
        },
        {
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-renderer-free',
                content: 'example contents',
              },
            ],
          },
        },
        {
          type: 'result',
          is_error: false,
          result: 'Completed',
          duration_ms: 42,
          session_id: 'session-renderer-free',
        },
      ]) {
        await options.onBeforeChatEvent?.({
          projectId: options.projectId,
          worktreeId: options.worktreeId,
          chatId: options.chatId,
          data,
          sequenceNamespace: 'initial',
          sequence,
        });
        options.onChatEvent?.({
          projectId: options.projectId,
          worktreeId: options.worktreeId,
          chatId: options.chatId,
          data,
          isTerminalEvent: data.type === 'result',
        });
        sequence += 1;
      }
    });

    await dispatchHostQueuedWorktreeChatMessage(
      {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        userMessageId: 'user-renderer-free',
        text: 'Finish this even if I close the window.',
        providerType: 'claude',
        model: 'claude-sonnet-4-5',
      },
      'desktop',
      true,
    );

    expect(mockChatStateService.ingestProviderEvent).toHaveBeenCalledTimes(5);
    expect(mockChatStateService.ingestProviderEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        data: expect.objectContaining({ type: 'assistant' }),
      }),
    );
  });

  it.each([false, true])(
    'pushes the original persisted turn timer to the portal (hidden continuation: %s)',
    async (hidden): Promise<void> => {
      // Desktop-initiated turns never emitted a live timer row: the portal only
      // learned "Completed in M:SS" from a later snapshot re-push, and a loop
      // continuation (a second terminal event on the same turn, no new user
      // row) never refreshed it at all — the browser kept the first, shorter
      // duration while the desktop showed the extended one.
      const persisted = chatTabsFile([
        {
          id: 'chat-1',
          title: 'Timer turn',
          createdAt: '2026-08-07T12:00:00.000Z',
          providerType: 'claude',
          model: 'claude-sonnet-4-5',
          autoRoutedModels: { 'user-timer': 'claude-sonnet-4-5' },
          messages: [
            {
              id: 'user-timer',
              role: 'user',
              timestamp: 1_000,
              blocks: [{ type: 'text', text: 'hows going' }],
            },
            {
              id: 'renderer-timer-row',
              role: 'system',
              timestamp: 1_000,
              blocks: [
                {
                  type: 'turn_timer',
                  startedAt: 1_000,
                  pausedAt: 2_000,
                  resumedAt: 3_000,
                  accumulatedPausedDurationMs: 1_000,
                  completedAt: null,
                },
              ],
            },
          ],
        },
      ]);
      if (hidden)
        persisted.tabs[0].messages?.push({
          id: 'hidden-delivery',
          role: 'user',
          hidden: true,
          timestamp: 4_000,
          blocks: [{ type: 'text', text: 'hows going' }],
        });
      let now = 10_000;
      const terminalInstants: number[] = [];
      mockedReadChatTabsFile.mockImplementation(
        async (): Promise<ChatTabsFile> => {
          await new Promise<void>((resolve): void => {
            setImmediate(resolve);
          });
          now += 5_000;
          return persisted;
        },
      );
      const terminal = {
        type: 'result',
        is_error: false,
        result: 'Completed',
        duration_ms: 42,
        session_id: 'session-timer',
      };
      mockedDispatchWorktreeChatTurn.mockImplementationOnce(
        async (options): Promise<void> => {
          const clock = jest
            .spyOn(Date, 'now')
            .mockImplementation((): number => now);
          try {
            for (const data of [terminal, terminal]) {
              await options.onBeforeChatEvent?.({
                projectId: options.projectId,
                worktreeId: options.worktreeId,
                chatId: options.chatId,
                data,
                sequenceNamespace: 'initial',
                sequence: 0,
              });
              terminalInstants.push(now);
              options.onChatEvent?.({
                projectId: options.projectId,
                worktreeId: options.worktreeId,
                chatId: options.chatId,
                data,
                isTerminalEvent: true,
              });
              // The timer read is asynchronous; let it settle before the next
              // terminal event so the emission order is deterministic.
              await new Promise<void>((resolve): void => {
                setImmediate(resolve);
              });
            }
          } finally {
            clock.mockRestore();
          }
        },
      );

      await dispatchHostQueuedWorktreeChatMessage(
        {
          projectId: 'workspace-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          userMessageId: hidden ? 'hidden-delivery' : 'user-timer',
          text: 'hows going',
          providerType: 'claude',
          model: 'claude-sonnet-4-5',
        },
        'desktop',
        true,
      );
      await new Promise<void>((resolve): void => {
        setImmediate(resolve);
      });

      const timerEvents = mockedCreatePortalEvent.mock.calls.flatMap(
        ([type, payload]): Record<string, unknown>[] => {
          if (type !== 'portal.chat.event') return [];
          const eventPayload: unknown = payload;
          if (!isRecord(eventPayload) || !isRecord(eventPayload.message)) {
            return [];
          }
          return eventPayload.message.messageId === 'user-timer:turn-timer'
            ? [eventPayload.message]
            : [];
        },
      );
      expect(timerEvents).toHaveLength(2);
      for (const message of timerEvents) {
        expect(message).toMatchObject({
          chatId: 'chat-1',
          role: 'system',
          status: 'complete',
          parts: [
            {
              kind: 'turn_timer',
              data: {
                startedAt: 1_000,
                pausedAt: 2_000,
                resumedAt: 3_000,
                accumulatedPausedDurationMs: 1_000,
                completedAt: expect.any(Number),
                autoRoutedModel: 'claude-sonnet-4-5',
                autoRoutedModelLabel: expect.any(String),
              },
            },
          ],
        });
      }
      // Ordering is load-bearing: the shared store sorts by `createdAtMs`, and
      // `partitionTurns` DROPS any message that precedes the turn's user row
      // (it has no anchor to attach to). Stamping the row at turn START sorted
      // it ahead of the user message — which main emits a beat later than the
      // renderer minted it — so the timer never entered a turn group and never
      // rendered on the portal at all.
      for (const message of timerEvents) {
        const parts = isRecord(message) ? message.parts : undefined;
        const first = Array.isArray(parts) ? parts[0] : undefined;
        const data = isRecord(first) ? first.data : undefined;
        const completed =
          isRecord(data) && typeof data.completedAt === 'number'
            ? data.completedAt
            : Number.NaN;
        expect(isRecord(message) ? message.createdAtMs : undefined).toBe(
          completed,
        );
      }

      const completedAt = (message: unknown): number => {
        const parts = isRecord(message) ? message.parts : undefined;
        const first = Array.isArray(parts) ? parts[0] : undefined;
        const data = isRecord(first) ? first.data : undefined;
        return isRecord(data) && typeof data.completedAt === 'number'
          ? data.completedAt
          : Number.NaN;
      };
      expect(timerEvents.map(completedAt)).toEqual(terminalInstants);
      expect(completedAt(timerEvents[1])).toBeGreaterThanOrEqual(
        completedAt(timerEvents[0]),
      );
      expect(mockedReadChatTabsFile.mock.calls).toContainEqual([
        'workspace-1',
        'worktree-1',
        { chatIds: ['chat-1'] },
      ]);
    },
  );

  it.each([
    [
      'a stopped Claude turn',
      { type: 'result', is_error: false, result: 'Session aborted' },
      'cancelled',
    ],
    [
      'an interrupted Codex turn',
      {
        type: 'codex',
        event: { type: 'turn.completed', status: 'interrupted' },
      },
      'cancelled',
    ],
    [
      'a failed turn',
      { type: 'result', is_error: true, result: 'boom' },
      'failed',
    ],
    [
      'a normal turn',
      { type: 'result', is_error: false, result: 'Completed' },
      undefined,
    ],
  ])(
    'marks how a desktop-initiated turn ended on the pushed turn timer: %s',
    async (_name, terminal, expectedEndReason): Promise<void> => {
      mockedReadChatTabsFile.mockResolvedValue(
        chatTabsFile([
          {
            id: 'chat-1',
            title: 'Timer turn',
            createdAt: '2026-08-07T12:00:00.000Z',
            providerType: 'claude',
            model: 'claude-sonnet-4-5',
            messages: [
              {
                id: 'user-timer',
                role: 'user',
                timestamp: 1_000,
                blocks: [{ type: 'text', text: 'hows going' }],
              },
            ],
          },
        ]),
      );
      mockedDispatchWorktreeChatTurn.mockImplementationOnce(
        (options): Promise<void> => {
          options.onChatEvent?.({
            projectId: options.projectId,
            worktreeId: options.worktreeId,
            chatId: options.chatId,
            data: terminal,
            isTerminalEvent: true,
          });
          return Promise.resolve();
        },
      );

      await dispatchHostQueuedWorktreeChatMessage(
        {
          projectId: 'workspace-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          userMessageId: 'user-timer',
          text: 'hows going',
          providerType: 'claude',
          model: 'claude-sonnet-4-5',
        },
        'desktop',
        true,
      );
      await new Promise<void>((resolve): void => {
        setImmediate(resolve);
      });

      const timerData = mockedCreatePortalEvent.mock.calls.flatMap(
        ([type, payload]): unknown[] => {
          if (type !== 'portal.chat.event') return [];
          const eventPayload: unknown = payload;
          if (!isRecord(eventPayload) || !isRecord(eventPayload.message)) {
            return [];
          }
          const { messageId, parts } = eventPayload.message;
          return messageId === 'user-timer:turn-timer' && Array.isArray(parts)
            ? parts.map((part: unknown) =>
                isRecord(part) ? part.data : undefined,
              )
            : [];
        },
      );
      expect(timerData).toHaveLength(1);
      const data = timerData[0];
      expect(isRecord(data) ? data.endReason : 'not a record').toBe(
        expectedEndReason,
      );
      expect(isRecord(data) && 'endReason' in data).toBe(
        expectedEndReason !== undefined,
      );
    },
  );

  it('restores a claimed terminal input when model preparation fails', async () => {
    const incoming: ChatSendMessageRequest = {
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      userMessageId: 'accepted-terminal',
      text: 'renderer text',
      interfaceMode: 'native',
    };
    const claimed: ChatSendMessageRequest = {
      ...incoming,
      text: 'main retained body',
    };
    mockChatStateService.claimRetainedTerminalAgentInputForNative.mockResolvedValueOnce(
      claimed,
    );
    const submit = jest
      .spyOn(getChatQueueService(), 'submit')
      .mockResolvedValue(undefined);
    setSendModelPreparer(() =>
      Promise.reject(new Error('model preparation failed')),
    );
    try {
      await expect(dispatchLocalWorktreeChatMessage(incoming)).rejects.toThrow(
        'model preparation failed',
      );
      expect(submit).not.toHaveBeenCalled();
      expect(
        mockChatStateService.restoreRetainedTerminalAgentInputAfterFailedNativeAdmission,
      ).toHaveBeenCalledWith(claimed);
    } finally {
      setSendModelPreparer((request) => Promise.resolve(request));
      submit.mockRestore();
    }
  });

  it('review: native ingress restores main terminal authority before host queue admission', async () => {
    const incoming: ChatSendMessageRequest = {
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      userMessageId: 'accepted-terminal',
      text: 'renderer text',
      interfaceMode: 'native',
    };
    const sender = {
      kind: 'bot' as const,
      botId: 'app_advisor',
      taskId: 'origin-task',
      chatId: 'origin-chat',
    };
    const restored: ChatSendMessageRequest = {
      ...incoming,
      text: 'main retained body',
      agentSent: { sender, chatTitle: 'Captured', projectLabel: 'App Advisor' },
      agentSenderProvenance: {
        version: 1,
        sender,
        owner: { kind: 'none' },
        capturedAt: '2026-10-16T00:00:00.000Z',
        acceptedInputId: incoming.userMessageId,
      },
      hiddenContext: {
        kind: 'agent-sender-context',
        text: '<system_instruction>Sender</system_instruction>',
      },
    };
    mockChatStateService.claimRetainedTerminalAgentInputForNative.mockResolvedValueOnce(
      restored,
    );
    const submit = jest
      .spyOn(getChatQueueService(), 'submit')
      .mockResolvedValue(undefined);
    try {
      await dispatchLocalWorktreeChatMessage(incoming);
      expect(
        mockChatStateService.claimRetainedTerminalAgentInputForNative,
      ).toHaveBeenCalledWith(incoming);
      expect(submit).toHaveBeenCalledWith(restored, 'desktop');
      submit.mockRejectedValueOnce(new Error('admission persistence failed'));
      mockChatStateService.claimRetainedTerminalAgentInputForNative.mockResolvedValueOnce(
        restored,
      );
      await expect(dispatchLocalWorktreeChatMessage(incoming)).rejects.toThrow(
        'admission persistence failed',
      );
      expect(
        mockChatStateService.restoreRetainedTerminalAgentInputAfterFailedNativeAdmission,
      ).toHaveBeenCalledWith(restored);

      expect(
        mockChatStateService.claimRetainedTerminalAgentInputForNative.mock
          .invocationCallOrder[0],
      ).toBeLessThan(submit.mock.invocationCallOrder[0]);
      mockChatStateService.claimRetainedTerminalAgentInputForNative.mockRejectedValueOnce(
        new Error(
          'The agent that sent this message can no longer reach this chat.',
        ),
      );
      submit.mockClear();
      await expect(dispatchLocalWorktreeChatMessage(incoming)).rejects.toThrow(
        'can no longer reach',
      );
      expect(submit).not.toHaveBeenCalled();
      submit.mockRestore();
      // Exercise the real host queue/native materializer after the interface switch.
      const validation = jest
        .spyOn(senderContext, 'revalidateAgentSenderRequest')
        .mockResolvedValue(undefined);
      try {
        mockChatStateService.claimRetainedTerminalAgentInputForNative.mockResolvedValueOnce(
          restored,
        );
        await dispatchLocalWorktreeChatMessage(incoming);
        expect(validation).toHaveBeenCalledWith(restored);
        expect(mockChatStateService.ingestProviderEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              type: 'canopy_user_prompt',
              canopy_persisted_messages: [
                expect.objectContaining({
                  id: incoming.userMessageId,
                  userMessageSource: 'agent',
                  agentSent: restored.agentSent,
                  blocks: [{ type: 'text', text: restored.text }],
                }),
              ],
            }),
          }),
        );
      } finally {
        validation.mockRestore();
      }
    } finally {
      submit.mockRestore();
    }
  });

  it('validates a trusted new-chat send with an explicit missing-target allowance before canonical creation and queueing', async () => {
    const validation = jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    const submit = jest
      .spyOn(getChatQueueService(), 'submit')
      .mockResolvedValue(undefined);
    try {
      mockedReadChatTabsFile.mockResolvedValue(chatTabsFile([]));
      const sender = {
        kind: 'bot' as const,
        botId: 'app_advisor',
        taskId: 'source-task',
        chatId: 'source-chat',
      };
      const request: ChatSendMessageRequest = {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'new-tool-chat',
        userMessageId: 'new-accepted-agent',
        text: 'Create and begin',
        agentSent: {
          sender,
          chatTitle: 'Captured',
          projectLabel: 'App Advisor',
        },
        agentSenderProvenance: {
          version: 1,
          sender,
          owner: { kind: 'none' },
          capturedAt: '2026-10-16T00:00:00.000Z',
          acceptedInputId: 'new-accepted-agent',
        },
        hiddenContext: {
          kind: 'agent-sender-context',
          text: '<system_instruction>Sender</system_instruction>',
        },
      };
      await sendWorktreeChatMessage(request);
      expect(validation).toHaveBeenCalledWith(request, {
        allowMissingTarget: true,
      });
      expect(
        mockChatStateService.ensureChatForTrustedSend,
      ).toHaveBeenCalledWith(expect.objectContaining(request));
      expect(submit).toHaveBeenCalledWith(
        expect.objectContaining(request),
        'portal',
      );
      expect(validation.mock.invocationCallOrder[0]).toBeLessThan(
        mockChatStateService.ensureChatForTrustedSend.mock
          .invocationCallOrder[0],
      );
      expect(
        mockChatStateService.ensureChatForTrustedSend.mock
          .invocationCallOrder[0],
      ).toBeLessThan(submit.mock.invocationCallOrder[0]);
    } finally {
      submit.mockRestore();
      validation.mockRestore();
    }
  });

  it("runs a project agent's queued send with the target's current approval settings", async () => {
    const validation = jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    const authority = jest
      .spyOn(senderContext, 'withAgentSenderAuthority')
      .mockImplementation((_request, handoff) => handoff());
    try {
      const denySecrets = {
        id: 'deny-secrets',
        behavior: 'deny' as const,
        target: { kind: 'file-write' as const, path: '/ws/secrets/**' },
        createdAt: '2026-10-20T00:00:00.000Z',
        origin: 'prompt' as const,
      };
      // Changed while the send waited: a new deny, and no selected repo.
      mockedReadChatTabsFile.mockResolvedValue(
        chatTabsFile([
          {
            id: 'chat-1',
            title: 'Target',
            createdAt: '2026-05-28T11:00:00.000Z',
            kind: 'chat',
            messages: [],
            approvalMode: 'ask',
            sessionApprovalRules: [denySecrets],
          },
        ]),
      );
      const sender = {
        kind: 'project' as const,
        projectType: 'code' as const,
        projectId: 'source-project',
        taskId: 'source-task',
        chatId: 'source-chat',
      };
      const request: ChatSendMessageRequest = {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        userMessageId: 'queued-project-send',
        text: 'Visible body',
        // Captured when the send was queued.
        approvalMode: 'full-access',
        sessionApprovalRules: [],
        selectedRepoId: 'old-repo',
        agentSent: {
          sender,
          chatTitle: 'Origin',
          projectLabel: 'Source',
        },
        agentSenderProvenance: {
          version: 1,
          sender,
          owner: { kind: 'personal' },
          capturedAt: '2026-10-20T00:00:00.000Z',
          acceptedInputId: 'queued-project-send',
        },
        hiddenContext: {
          kind: 'agent-sender-context',
          text: '<system_instruction>Sender</system_instruction>',
        },
      };
      await dispatchHostQueuedWorktreeChatMessage(request, 'desktop', true);
      const current = {
        approvalMode: 'ask',
        sessionApprovalRules: [denySecrets],
      };
      // The settings admitted at dispatch are the settings that run.
      expect(validation).toHaveBeenCalledWith(expect.objectContaining(current));
      expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledTimes(1);
      const dispatched = mockedDispatchWorktreeChatTurn.mock.calls[0]?.[0];
      expect(dispatched).toMatchObject(current);
      expect(dispatched?.selectedRepoId).toBeUndefined();
    } finally {
      authority.mockRestore();
      validation.mockRestore();
    }
  });

  it('delivers a queued agent send natively when its tab left terminal mode', async () => {
    const validation = jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    const authority = jest
      .spyOn(senderContext, 'withAgentSenderAuthority')
      .mockImplementation((_request, handoff) => handoff());
    const released = jest.spyOn(getChatQueueService(), 'onTurnTerminal');
    try {
      mockedReadChatTabsFile.mockResolvedValue(
        chatTabsFile([
          {
            id: 'chat-1',
            title: 'Now native',
            createdAt: '2026-05-28T11:00:00.000Z',
            kind: 'chat',
            messages: [],
            providerType: 'claude',
            interfaceMode: 'canopy',
          },
        ]),
      );
      const sender = {
        kind: 'bot' as const,
        botId: 'app_advisor',
        taskId: 'source-task',
        chatId: 'source-chat',
      };
      const request: ChatSendMessageRequest = {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        userMessageId: 'queued-mode-changed',
        text: 'Visible body',
        // Captured while the tab was terminal-backed.
        interfaceMode: 'auto',
        agentSent: {
          sender,
          chatTitle: 'Captured',
          projectLabel: 'App Advisor',
        },
        agentSenderProvenance: {
          version: 1,
          sender,
          owner: { kind: 'none' },
          capturedAt: '2026-10-16T00:00:00.000Z',
          acceptedInputId: 'queued-mode-changed',
        },
        hiddenContext: {
          kind: 'agent-sender-context',
          text: '<system_instruction>Sender</system_instruction>',
        },
      };
      await dispatchHostQueuedWorktreeChatMessage(request, 'desktop', true);
      expect(
        mockChatStateService.retainTrustedTerminalInput,
      ).not.toHaveBeenCalled();
      expect(released).not.toHaveBeenCalledWith(
        expect.anything(),
        'complete',
        'queued-mode-changed',
      );
      expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockedDispatchWorktreeChatTurn.mock.calls[0]?.[0]).toMatchObject({
        userMessageId: 'queued-mode-changed',
        interfaceMode: 'canopy',
      });
    } finally {
      released.mockRestore();
      authority.mockRestore();
      validation.mockRestore();
    }
  });

  it('releases the host queue turn after handing an agent send to a terminal session', async () => {
    const validation = jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    const released = jest.spyOn(getChatQueueService(), 'onTurnTerminal');
    try {
      mockedSendToWindowDetailed.mockReturnValue({ delivered: true });
      mockedReadChatTabsFile.mockResolvedValue(
        chatTabsFile([
          {
            id: 'chat-1',
            title: 'Terminal',
            createdAt: '2026-05-28T11:00:00.000Z',
            kind: 'chat',
            messages: [],
            providerType: 'claude',
            interfaceMode: 'auto',
          },
        ]),
      );
      const sender = {
        kind: 'bot' as const,
        botId: 'app_advisor',
        taskId: 'source-task',
        chatId: 'source-chat',
      };
      const request: ChatSendMessageRequest = {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        userMessageId: 'queued-terminal-agent',
        text: 'Visible body',
        interfaceMode: 'auto',
        agentSent: {
          sender,
          chatTitle: 'Captured',
          projectLabel: 'App Advisor',
        },
        agentSenderProvenance: {
          version: 1,
          sender,
          owner: { kind: 'none' },
          capturedAt: '2026-10-16T00:00:00.000Z',
          acceptedInputId: 'queued-terminal-agent',
        },
        hiddenContext: {
          kind: 'agent-sender-context',
          text: '<system_instruction>Sender</system_instruction>',
        },
      };
      await dispatchHostQueuedWorktreeChatMessage(request, 'desktop', true);
      expect(
        mockChatStateService.retainTrustedTerminalInput,
      ).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'chat-1' }));
      // The terminal session gates its own turns; the host queue must not
      // stay busy, or later sends to this chat never drain.
      expect(released).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: 'chat-1' }),
        'complete',
        'queued-terminal-agent',
      );
    } finally {
      released.mockRestore();
      validation.mockRestore();
    }
  });

  it('forwards a trusted tool input to managed terminals with accepted id and separate context, retaining authority only in main', async () => {
    const validation = jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    try {
      mockedSendToWindowDetailed.mockReturnValue({ delivered: true });
      mockedReadChatTabsFile.mockResolvedValue(
        chatTabsFile([
          {
            id: 'chat-1',
            title: 'Terminal',
            createdAt: '2026-05-28T11:00:00.000Z',
            kind: 'chat',
            messages: [],
            providerType: 'claude',
            interfaceMode: 'auto',
          },
        ]),
      );
      const sender = {
        kind: 'bot' as const,
        botId: 'app_advisor',
        taskId: 'source-task',
        chatId: 'source-chat',
      };
      const request: ChatSendMessageRequest = {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        userMessageId: 'accepted-agent',
        text: 'Visible body',
        agentSent: {
          sender,
          chatTitle: 'Captured',
          projectLabel: 'App Advisor',
        },
        agentSenderProvenance: {
          version: 1,
          sender,
          owner: { kind: 'none' },
          capturedAt: '2026-10-16T00:00:00.000Z',
          acceptedInputId: 'accepted-agent',
        },
        hiddenContext: {
          kind: 'agent-sender-context',
          text: '<system_instruction>Sender</system_instruction>',
        },
      };
      expect(await sendWorktreeChatMessage(request)).toEqual({
        ok: true,
        chatId: 'chat-1',
      });
      expect(
        mockChatStateService.retainTrustedTerminalInput,
      ).toHaveBeenCalledWith(request);
      const event: unknown = mockedSendToWindowDetailed.mock.calls.find(
        (call) => call[1] === IPC_CHANNELS.claudeTerminalScheduledPrompt,
      )?.[2];
      expect(event).toMatchObject({
        text: 'Visible body',
        userMessageId: 'accepted-agent',
        acceptedInputId: 'accepted-agent',
        hiddenContext: request.hiddenContext,
        agentSent: request.agentSent,
      });
      expect(event).not.toHaveProperty('agentSenderProvenance');
      expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
    } finally {
      validation.mockRestore();
    }
  });

  it('forwards automation sends for terminal-backed Claude tabs to the renderer terminal path', async () => {
    mockedSendToWindowDetailed.mockReturnValue({ delivered: true });
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Terminal chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
          providerType: 'claude',
          interfaceMode: 'auto',
        },
      ]),
    );

    const result = await sendWorktreeChatMessage({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      userMessageId: 'automation-message-1',
      text: 'Scheduled check-in',
      initiationSource: 'automation',
      automationName: 'Nightly',
      attachmentPaths: ['/attachments/shot.png'],
    });

    expect(result).toEqual({ ok: true, chatId: 'chat-1' });
    expect(mockedSendToWindowDetailed).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.claudeTerminalScheduledPrompt,
      expect.objectContaining({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        userMessageId: 'automation-message-1',
        text: 'Scheduled check-in',
        automationName: 'Nightly',
        attachmentPaths: ['/attachments/shot.png'],
      }),
    );
    // The renderer owns persistence (the prompt arrives via transcript
    // import) and no native SDK turn runs.
    expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();
    expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
  });

  it('rejects terminal automation overrides rather than forwarding a prompt with stale settings', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Terminal chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
          providerType: 'claude',
          interfaceMode: 'auto',
          planMode: false,
          approvalMode: 'ask',
        },
      ]),
    );

    await expect(
      sendWorktreeChatMessage({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        text: 'Scheduled check-in',
        initiationSource: 'automation',
        planMode: true,
        approvalMode: 'full-access',
      }),
    ).rejects.toThrow('terminal chat settings');
    expect(mockedSendToWindowDetailed).not.toHaveBeenCalledWith(
      expect.anything(),
      IPC_CHANNELS.claudeTerminalScheduledPrompt,
      expect.anything(),
    );
  });

  it('accepts terminal automation settings echoed from the live tab', async () => {
    mockedSendToWindowDetailed.mockReturnValue({ delivered: true });
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Terminal chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
          providerType: 'claude',
          interfaceMode: 'auto',
          planMode: false,
          approvalMode: 'ask',
        },
      ]),
    );

    await expect(
      sendWorktreeChatMessage({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        text: 'Scheduled check-in',
        initiationSource: 'automation',
        providerType: 'claude',
        interfaceMode: 'auto',
        planMode: false,
        approvalMode: 'ask',
      }),
    ).resolves.toEqual({ ok: true, chatId: 'chat-1' });
    expect(mockedSendToWindowDetailed).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.claudeTerminalScheduledPrompt,
      expect.objectContaining({ text: 'Scheduled check-in' }),
    );
  });

  it('accepts an explicit off Plan mode when the terminal tab has no stored Plan mode', async () => {
    mockedSendToWindowDetailed.mockReturnValue({ delivered: true });
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Terminal chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
          providerType: 'claude',
          interfaceMode: 'auto',
        },
      ]),
    );
    await expect(
      sendWorktreeChatMessage({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        text: 'Scheduled check-in',
        initiationSource: 'automation',
        planMode: false,
      }),
    ).resolves.toEqual({ ok: true, chatId: 'chat-1' });
  });

  it('fails automation sends for terminal-backed tabs when no window can receive them', async () => {
    mockedSendToWindowDetailed.mockReturnValue({
      delivered: false,
      reason: 'no_window',
    });
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Terminal chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
          providerType: 'claude',
          interfaceMode: 'auto',
        },
      ]),
    );

    await expect(
      sendWorktreeChatMessage({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        text: 'Scheduled check-in',
        initiationSource: 'automation',
      }),
    ).rejects.toThrow(
      `Cannot deliver a scheduled prompt to a Claude Code terminal chat without a ${BRAND.displayName} window.`,
    );
    expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
  });

  it('routes terminal-backed App Advisor scheduled prompts to the App Advisor window', async () => {
    const mainWindow = new BrowserWindow();
    const appAdvisorWindow = new BrowserWindow();
    mockedSendToWindowDetailed.mockReturnValue({ delivered: true });
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'advisor-chat-1',
          title: 'Terminal advisor chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
          providerType: 'claude',
          interfaceMode: 'auto',
        },
      ]),
    );

    await sendWorktreeChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_ENTRY_ID,
        chatId: 'advisor-chat-1',
        text: 'Continue',
        initiationSource: 'automation',
      },
      {
        getWindow: () => mainWindow,
        appAdvisorSurfaces: {
          getMainWindow: () => mainWindow,
          getAppAdvisorWindow: () => appAdvisorWindow,
          openAppAdvisorWindow: jest.fn(),
          ensureAppAdvisorWindow: jest.fn(),
        },
      },
    );

    expect(mockedSendToWindowDetailed).toHaveBeenCalledWith(
      appAdvisorWindow,
      IPC_CHANNELS.claudeTerminalScheduledPrompt,
      expect.objectContaining({
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_ENTRY_ID,
        chatId: 'advisor-chat-1',
        text: 'Continue',
      }),
    );
    expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();
    expect(mockedDispatchAppAdvisorChatMessage).not.toHaveBeenCalled();
  });

  // CAN-2663: this is the send funnel the `chatSendMessage` IPC handler does
  // NOT go through — Portal / mobile Remote Control, automations, transient
  // retry, and usage-limit resume all arrive here. Without the notifier, a
  // first-ever message over Remote Control leaves "Start a chat" unchecked for
  // the rest of the session, because the backfill memoizes its `false` answer.
  it('passes a trusted proxy pin through dispatch and rejects a replaced connection before persistence', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Existing chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
          providerType: 'codex',
        },
      ]),
    );
    const request = {
      projectId: 'ws-a',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      text: 'Continue',
      providerType: 'codex' as const,
    };
    mockPreviewPinnedProxy.mockResolvedValue(true);
    await sendWorktreeChatMessage(request, {
      requiredAccountProxyConnectionId: 'proxy-A',
    });
    expect(mockPreviewPinnedProxy).toHaveBeenCalledWith(
      expect.objectContaining({ requiredConnectionId: 'proxy-A' }),
    );
    expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({ requiredAccountProxyConnectionId: 'proxy-A' }),
    );
    mockedWriteChatTabsFile.mockClear();
    mockedDispatchWorktreeChatTurn.mockClear();
    mockPreviewPinnedProxy.mockResolvedValue(false);
    await expect(
      sendWorktreeChatMessage(request, {
        requiredAccountProxyConnectionId: 'proxy-A',
      }),
    ).rejects.toThrow('continuation is unavailable');
    expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();
    expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
    mockPreviewPinnedProxy.mockResolvedValue(true);
  });

  it.each([true, false])(
    'restores a trusted proxy pin into a hydrated Continue dispatch, connection available: %s',
    async (available) => {
      mockedReadChatTabsFile.mockResolvedValue(
        chatTabsFile([
          {
            id: 'chat-1',
            title: 'Existing chat',
            createdAt: '2026-05-28T11:00:00.000Z',
            kind: 'chat',
            messages: [],
            providerType: 'codex',
          },
        ]),
      );
      let durable: PersistedHostQueuedMessage | undefined;
      mockChatStateService.reconcileHostQueue.mockImplementation(
        (
          ...args: Parameters<
            ChatStateServiceModule.ChatStateService['reconcileHostQueue']
          >
        ): Promise<void> => {
          const queuedMessages = args[4];
          durable = queuedMessages?.[0] ?? durable;
          return Promise.resolve();
        },
      );
      const queue = getChatQueueService();
      const target = {
        projectId: 'ws-a',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
      };
      await queue.pauseForAuthentication(target, 'held-for-restart');
      await sendWorktreeChatMessage(
        {
          ...target,
          userMessageId: 'resume-1',
          text: 'Continue',
          providerType: 'codex',
        },
        {
          requiredAccountProxyConnectionId: 'proxy-A',
        },
      );
      if (!durable) throw new Error('Expected a durable queued continuation');
      expect(durable.requiredAccountProxyConnectionId).toBe('proxy-A');
      // Remove request identity and live dispatch options as a restart does.
      const restored: PersistedHostQueuedMessage = JSON.parse(
        JSON.stringify(durable),
      );
      queue.resetForTests();
      queue.hydratePersistedInput(
        restored.request,
        restored.id,
        restored.origin,
        restored.enqueuedAtMs,
        restored.authenticationAttemptId,
        restored.requiredAccountProxyConnectionId,
      );
      queue.releaseAuthenticationPause(target, 'held-for-restart');
      mockPreviewPinnedProxy.mockClear();
      mockedDispatchWorktreeChatTurn.mockClear();
      mockedWriteChatTabsFile.mockClear();
      mockPreviewPinnedProxy.mockResolvedValueOnce(available);
      if (available) {
        await expect(queue.force(target, restored.id)).resolves.toBe('applied');
      } else {
        await expect(queue.force(target, restored.id)).rejects.toThrow(
          'continuation is unavailable',
        );
      }
      expect(mockPreviewPinnedProxy).toHaveBeenCalledWith(
        expect.objectContaining({ requiredConnectionId: 'proxy-A' }),
      );
      if (available) {
        expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledWith(
          expect.objectContaining({
            requiredAccountProxyConnectionId: 'proxy-A',
          }),
        );
      } else {
        expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
        expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();
      }
    },
  );

  it('latches the onboarding checklist start-chat item on a normal send', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Existing chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
        },
      ]),
    );

    await sendWorktreeChatMessage({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      userMessageId: 'message-1',
      text: 'Continue',
    });

    // At least once, not exactly once: this send path re-enters itself for
    // non-desktop origins (`sendWorktreeChatMessage` is re-called after
    // `authorizedPortalDispatches.add`), so the notifier legitimately fires
    // twice for one logical send. That is safe because the latch is
    // idempotent — the second call reports `changed: false` and skips the
    // broadcast — and pinning an exact count here would just encode a
    // re-entry detail this test does not care about.
    expect(mockNotifyOnboardingChecklistChatStarted).toHaveBeenCalled();
  });

  // `handlePortalChatSend`'s chat-id-less fallthrough reaches
  // `sendWorktreeChatMessage` with only `validateId` in between, and
  // 'pipeline-editor' is a valid id — so this exclusion has to be enforced
  // here, not assumed from upstream routing.
  it('does not latch start-chat for a Pipeline Editor target', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'pipeline-editor-chat',
          title: 'Pipeline editor chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
        },
      ]),
    );

    await sendWorktreeChatMessage({
      projectId: PIPELINE_EDITOR_PROJECT_ID,
      worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
      chatId: 'pipeline-editor-chat',
      userMessageId: 'message-1',
      text: 'Continue',
    });

    expect(mockNotifyOnboardingChecklistChatStarted).not.toHaveBeenCalled();
  });

  // A Canopy-owned assistant turn is not the user starting a chat of their own.
  it('does not latch start-chat for an App Advisor target', async () => {
    const mainWindow = new BrowserWindow();
    const appAdvisorWindow = new BrowserWindow();
    mockedSendToWindowDetailed.mockReturnValue({ delivered: true });
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'advisor-chat-1',
          title: 'Terminal advisor chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
          providerType: 'claude',
          interfaceMode: 'auto',
        },
      ]),
    );

    await sendWorktreeChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_ENTRY_ID,
        chatId: 'advisor-chat-1',
        text: 'Continue',
        initiationSource: 'automation',
      },
      {
        getWindow: () => mainWindow,
        appAdvisorSurfaces: {
          getMainWindow: () => mainWindow,
          getAppAdvisorWindow: () => appAdvisorWindow,
          openAppAdvisorWindow: jest.fn(),
          ensureAppAdvisorWindow: jest.fn(),
        },
      },
    );

    expect(mockNotifyOnboardingChecklistChatStarted).not.toHaveBeenCalled();
  });

  it('persists file reference blocks for backend-originated sends', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Existing chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
        },
      ]),
    );

    await sendWorktreeChatMessage({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      userMessageId: 'message-1',
      text: 'Continue',
      fileReferences: [
        {
          displayPath: 'src/index.ts',
          absolutePath: '/repo/src/index.ts',
          repoName: 'canopy',
        },
      ],
    });

    expect(mockedCancelTransientRetryForChat).toHaveBeenCalledWith(
      {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
      'manual-send',
    );

    const writtenTabsFile = mockedWriteChatTabsFile.mock.calls[0]?.[2];
    const userMessage = writtenTabsFile?.tabs[0]?.messages[0];
    expect(userMessage).toMatchObject({
      id: 'message-1',
      role: 'user',
      blocks: [
        {
          type: 'file_references',
          references: [
            {
              displayPath: 'src/index.ts',
              absolutePath: '/repo/src/index.ts',
              repoName: 'canopy',
            },
          ],
        },
        { type: 'text', text: 'Continue' },
      ],
    });
    expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Continue',
      }),
    );
  });

  it('keeps a portal turn timer live after dispatch accepts until the terminal event', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Existing chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
        },
      ]),
    );
    let onChatEvent:
      | Parameters<typeof dispatchWorktreeChatTurn>[0]['onChatEvent']
      | undefined;
    mockedDispatchWorktreeChatTurn.mockImplementationOnce((options) => {
      onChatEvent = options.onChatEvent;
      return Promise.resolve();
    });

    await sendWorktreeChatMessage({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      userMessageId: 'message-1',
      text: 'Continue',
    });

    const timerStatuses = (): string[] =>
      mockedCreatePortalEvent.mock.calls.flatMap(([type, payload]) => {
        if (type !== 'portal.chat.event') return [];
        const eventPayload: unknown = payload;
        if (!isRecord(eventPayload) || !isRecord(eventPayload.message)) {
          return [];
        }
        const { messageId, status } = eventPayload.message;
        return messageId === 'message-1:turn-timer' &&
          typeof status === 'string'
          ? [status]
          : [];
      });
    expect(timerStatuses()).toEqual(['streaming']);

    onChatEvent?.({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      isTerminalEvent: true,
      data: {
        type: 'result',
        is_error: false,
        result: 'Turn completed',
      },
    });

    expect(timerStatuses()).toEqual(['streaming', 'complete']);
  });

  it('carries the model Auto picked on a portal turn timer', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Existing chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
          autoRoutedModels: { 'message-1': 'claude-sonnet-4-5' },
        },
      ]),
    );
    let onChatEvent:
      | Parameters<typeof dispatchWorktreeChatTurn>[0]['onChatEvent']
      | undefined;
    mockedDispatchWorktreeChatTurn.mockImplementationOnce((options) => {
      onChatEvent = options.onChatEvent;
      return Promise.resolve();
    });

    await sendWorktreeChatMessage({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      userMessageId: 'message-1',
      text: 'Continue',
    });
    onChatEvent?.({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      isTerminalEvent: true,
      data: { type: 'result', is_error: false, result: 'Turn completed' },
    });

    const timerData = mockedCreatePortalEvent.mock.calls.flatMap(
      ([type, payload]): unknown[] => {
        if (type !== 'portal.chat.event') return [];
        const eventPayload: unknown = payload;
        if (!isRecord(eventPayload) || !isRecord(eventPayload.message)) {
          return [];
        }
        const { messageId, parts } = eventPayload.message;
        return messageId === 'message-1:turn-timer' && Array.isArray(parts)
          ? parts.map((part: unknown) =>
              isRecord(part) ? part.data : undefined,
            )
          : [];
      },
    );
    expect(timerData).toHaveLength(2);
    for (const data of timerData) {
      expect(data).toMatchObject({
        autoRoutedModel: 'claude-sonnet-4-5',
        autoRoutedModelLabel: expect.any(String),
      });
    }
  });

  it('streams a portal-originated Cursor turn as folded patch messages without persisting blank rows', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Cursor chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          providerType: 'cursor',
          executionHarness: 'cursor',
          model: 'cursor-default',
          messages: [],
        },
      ]),
    );
    let onChatEvent:
      | Parameters<typeof dispatchWorktreeChatTurn>[0]['onChatEvent']
      | undefined;
    mockedDispatchWorktreeChatTurn.mockImplementationOnce((options) => {
      onChatEvent = options.onChatEvent;
      return Promise.resolve();
    });

    await sendWorktreeChatMessage({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      userMessageId: 'message-1',
      text: 'CURSOR_CHAT_E2E_TEXT',
      providerType: 'cursor',
      model: 'cursor-default',
    });
    mockChatStateService.replaceCompatibilityTabs.mockClear();

    // The shape `CursorEventProjection` emits per ACP chunk: incremental
    // patches against one assistant message. The state service folds these
    // into the persisted transcript (`onBeforeChatEvent`); the live portal
    // projection must carry the same folded text, not a blank row.
    const patch = (
      revision: number,
      patches: Record<string, unknown>[],
    ): Record<string, unknown> => ({
      type: 'canopy_assistant_patch',
      provider: 'cursor',
      messageId: 'cursor-message-1',
      timestamp: 1_700_000_000_000,
      revision,
      patches,
    });
    onChatEvent?.({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      isTerminalEvent: false,
      data: patch(1, [{ index: 0, block: { type: 'text', text: 'Cursor ' } }]),
    });
    onChatEvent?.({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      isTerminalEvent: false,
      data: patch(2, [{ index: 0, appendText: 'chat works.' }]),
    });
    await new Promise<void>((resolve): void => {
      setImmediate(resolve);
    });

    const assistantMessages = mockedCreatePortalEvent.mock.calls.flatMap(
      ([type, payload]): Record<string, unknown>[] => {
        if (type !== 'portal.chat.event') return [];
        const eventPayload: unknown = payload;
        if (!isRecord(eventPayload) || !isRecord(eventPayload.message)) {
          return [];
        }
        return eventPayload.message.role === 'assistant'
          ? [eventPayload.message]
          : [];
      },
    );
    expect(assistantMessages).toEqual([
      expect.objectContaining({
        messageId: 'cursor-message-1',
        chatId: 'chat-1',
        text: 'Cursor ',
      }),
      expect.objectContaining({
        messageId: 'cursor-message-1',
        chatId: 'chat-1',
        text: 'Cursor chat works.',
      }),
    ]);
    // The state service already persisted the folded message under the
    // patch id; re-upserting a lossy portal projection would overwrite it
    // (and before the fix persisted a blank `message-1:assistant` row).
    expect(
      mockChatStateService.replaceCompatibilityTabs,
    ).not.toHaveBeenCalled();
  });

  it('reuses an existing empty chat tab when a send arrives without a chatId (portal New Task)', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'tab-empty',
          title: 'New Chat',
          createdAt: '2026-07-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
        },
      ]),
    );

    const result = await sendWorktreeChatMessage({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      userMessageId: 'message-1',
      text: 'Fibonacci sequence math',
    });

    expect(result).toEqual({ ok: true, chatId: 'tab-empty' });
    const writtenTabsFile = mockedWriteChatTabsFile.mock.calls[0]?.[2];
    expect(writtenTabsFile?.tabs).toHaveLength(1);
    expect(writtenTabsFile?.tabs[0]).toMatchObject({
      id: 'tab-empty',
      title: 'Fibonacci sequence math',
    });
    expect(writtenTabsFile?.tabs[0]?.messages[0]).toMatchObject({
      id: 'message-1',
      role: 'user',
    });
  });

  // CAN-3652. A first-line label is a preview, not a saved name: main's
  // initial-title guard treats a non-placeholder title without `pending` as
  // settled, so a portal send must keep the chat eligible for one title.
  it('keeps portal-minted and reused empty chats eligible for their initial title', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'tab-empty',
          title: 'New Chat',
          createdAt: '2026-07-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
        },
      ]),
    );
    await sendWorktreeChatMessage({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      userMessageId: 'message-1',
      text: 'Fibonacci sequence math',
    });
    expect(mockedWriteChatTabsFile.mock.calls[0]?.[2].tabs[0]).toMatchObject({
      id: 'tab-empty',
      title: 'Fibonacci sequence math',
      automaticTitleState: 'pending',
    });

    mockedWriteChatTabsFile.mockClear();
    mockedReadChatTabsFile.mockResolvedValue(chatTabsFile([]));
    const minted = await sendWorktreeChatMessage({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      userMessageId: 'message-2',
      text: 'Plan the release checklist',
    });
    expect(
      mockedWriteChatTabsFile.mock.calls[0]?.[2].tabs.find(
        (tab) => tab.id === minted.chatId,
      ),
    ).toMatchObject({
      title: 'Plan the release checklist',
      automaticTitleState: 'pending',
    });

    mockedWriteChatTabsFile.mockClear();
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'tab-renamed',
          title: 'New Chat',
          createdAt: '2026-07-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
          automaticTitleState: 'closed',
        },
      ]),
    );
    await sendWorktreeChatMessage({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'tab-renamed',
      userMessageId: 'message-3',
      text: 'Renamed chats stay closed',
    });
    expect(mockedWriteChatTabsFile.mock.calls[0]?.[2].tabs[0]).toMatchObject({
      id: 'tab-renamed',
      automaticTitleState: 'closed',
    });
  });

  it('preserves a meaningful saved creation title when a Portal sends its first message', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'tab-named',
          title: 'Release planning',
          createdAt: '2026-07-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
        },
      ]),
    );
    await sendWorktreeChatMessage({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'tab-named',
      userMessageId: 'message-1',
      text: 'A different subject',
    });
    const saved = mockedWriteChatTabsFile.mock.calls[0]?.[2].tabs[0];
    expect(saved?.title).toBe('Release planning');
    expect(saved?.automaticTitleState).toBeUndefined();
  });

  it('keeps the explicit title a send carries when it starts an empty tab', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'tab-reserved',
          title: 'Review the parser',
          createdAt: '2026-07-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
        },
      ]),
    );
    await sendWorktreeChatMessage({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'tab-reserved',
      userMessageId: 'message-1',
      text: 'Review the parser for empty input',
      title: 'Parser review',
    });

    expect(mockedWriteChatTabsFile.mock.calls[0]?.[2].tabs[0]).toMatchObject({
      id: 'tab-reserved',
      title: 'Parser review',
      customTitle: 'Parser review',
      // A saved name closes the one initial generated title (CAN-3652).
      automaticTitleState: 'closed',
    });
  });

  // CAN-2318. A chat-id-less send is policed against the PROVIDER DEFAULT,
  // because the reusable empty tab has no chat id for the preflight to look
  // up. Left alone, the reused tab keeps a since-blocked model while the turn
  // runs the permitted default — so the chat succeeds displaying a blocked
  // selection, and its next send is refused once the preflight can see it.
  it('clears a since-blocked model off a reused empty tab', async () => {
    blockedModelIds.add('now-blocked-model');
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'tab-empty',
          title: 'New Chat',
          createdAt: '2026-07-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
          model: 'now-blocked-model',
          providerType: 'codex',
        },
      ]),
    );

    const result = await sendWorktreeChatMessage({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      userMessageId: 'message-1',
      text: 'Mobile New Task, no chatId and no model',
    });

    expect(result).toEqual({ ok: true, chatId: 'tab-empty' });
    const writtenTab = mockedWriteChatTabsFile.mock.calls[0]?.[2].tabs[0];
    expect(writtenTab?.model).toBeUndefined();
    expect(writtenTab?.providerType).toBeUndefined();
  });

  it('clears a permitted-but-unused model off a reused empty tab', async () => {
    // Same rule, no policy involved. Dispatch resolves
    // `options.model ?? default` and a chat-id-less send carries no tab
    // options, so this Codex pick never runs — the turn takes the provider
    // default. Keeping it left the chat labeled Codex for a Claude turn and
    // silently switched the NEXT send onto Codex.
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'tab-empty',
          title: 'New Chat',
          createdAt: '2026-07-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
          model: 'permitted-model',
          providerType: 'codex',
        },
      ]),
    );

    await sendWorktreeChatMessage({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      userMessageId: 'message-1',
      text: 'Mobile New Task, no chatId and no model',
    });

    const writtenTab = mockedWriteChatTabsFile.mock.calls[0]?.[2].tabs[0];
    expect(writtenTab?.model).toBeUndefined();
    expect(writtenTab?.providerType).toBeUndefined();
    // The persisted state has to match what dispatch was actually handed —
    // asserting only the tab fields would let the two drift apart again.
    expect(
      mockedDispatchWorktreeChatTurn.mock.calls[0]?.[0].model,
    ).toBeUndefined();
  });

  it('dispatches the execution context just captured for this turn', async () => {
    // CAN-3457: org memory follows this context, so a reused tab captured in
    // org A and now sent from an automation authorized for org B must
    // dispatch B, not the tab's previous A.
    const orgA = 'org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const orgB = 'org:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'tab-empty',
          title: 'New Chat',
          createdAt: '2026-07-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
          executionContext: orgA,
        },
      ]),
    );

    await sendWorktreeChatMessage(
      {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'tab-empty',
        userMessageId: 'message-1',
        text: 'Automation prompt',
      },
      { executionContext: orgB },
    );

    expect(
      mockedWriteChatTabsFile.mock.calls[0]?.[2].tabs[0]?.executionContext,
    ).toBe(orgB);
    expect(
      mockedDispatchWorktreeChatTurn.mock.calls[0]?.[0].executionContext,
    ).toBe(orgB);
  });

  it('keeps an explicitly requested model on a reused empty tab', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'tab-empty',
          title: 'New Chat',
          createdAt: '2026-07-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
          model: 'stale-model',
          providerType: 'codex',
        },
      ]),
    );

    await sendWorktreeChatMessage({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      userMessageId: 'message-1',
      text: 'Explicit pick',
      model: 'requested-model',
    });

    // An explicit request model IS dispatched, so it must survive the clear.
    const writtenTab = mockedWriteChatTabsFile.mock.calls[0]?.[2].tabs[0];
    expect(writtenTab?.model).toBe('requested-model');
    expect(mockedDispatchWorktreeChatTurn.mock.calls[0]?.[0].model).toBe(
      'requested-model',
    );
    // ...and it must take its own provider with it. Leaving the tab's previous
    // `codex` in place next to a Claude model would dispatch correctly THIS
    // turn (the provider is derived from the request model) but wrong on the
    // next one, where `buildExistingTabDispatchOptions` reloads both fields
    // and the explicit `providerType` outranks the model's own.
    expect(writtenTab?.providerType).toBe(
      getProviderForModel('requested-model'),
    );
    expect(writtenTab?.providerType).not.toBe('codex');
  });

  it('keeps the active App Advisor chat for a background send to another chat', async () => {
    let persistedTabsFile = chatTabsFile([
      {
        id: 'advisor-viewed',
        title: 'Viewed chat',
        createdAt: '2026-07-28T11:00:00.000Z',
        kind: 'chat',
        messages: [],
      },
      {
        id: 'advisor-target',
        title: 'Target chat',
        createdAt: '2026-07-28T11:01:00.000Z',
        kind: 'chat',
        messages: [],
      },
    ]);
    mockedReadChatTabsFile.mockImplementation(() =>
      Promise.resolve(persistedTabsFile),
    );
    mockedWriteChatTabsFile.mockImplementation(
      (_projectId, _worktreeId, tabsFile) => {
        persistedTabsFile = tabsFile;
        return Promise.resolve();
      },
    );
    const appAdvisorSurfaces = {
      getMainWindow: (): null => null,
      getAppAdvisorWindow: (): null => null,
      openAppAdvisorWindow: jest.fn(),
      ensureAppAdvisorWindow: jest.fn(),
    };

    await sendWorktreeChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_ENTRY_ID,
        chatId: 'advisor-target',
        userMessageId: 'message-1',
        text: 'Run in the background',
      },
      { appAdvisorSurfaces, preserveActiveTab: true },
    );
    expect(persistedTabsFile.activeTabId).toBe('advisor-viewed');
  });

  it('keeps the active App Advisor chat for a restored queued background send', async () => {
    // A send restored from the durable queue has no live options; the intent
    // travels on the persisted request.
    let persistedTabsFile = chatTabsFile([
      {
        id: 'advisor-viewed',
        title: 'Viewed chat',
        createdAt: '2026-07-28T11:00:00.000Z',
        kind: 'chat',
        messages: [],
      },
      {
        id: 'advisor-target',
        title: 'Target chat',
        createdAt: '2026-07-28T11:01:00.000Z',
        kind: 'chat',
        messages: [],
      },
    ]);
    mockedReadChatTabsFile.mockImplementation(() =>
      Promise.resolve(persistedTabsFile),
    );
    mockedWriteChatTabsFile.mockImplementation(
      (_projectId, _worktreeId, tabsFile) => {
        persistedTabsFile = tabsFile;
        return Promise.resolve();
      },
    );

    await sendWorktreeChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_ENTRY_ID,
        chatId: 'advisor-target',
        userMessageId: 'message-restored',
        text: 'Run in the background',
        preserveActiveTab: true,
      },
      {
        appAdvisorSurfaces: {
          getMainWindow: (): null => null,
          getAppAdvisorWindow: (): null => null,
          openAppAdvisorWindow: jest.fn(),
          ensureAppAdvisorWindow: jest.fn(),
        },
      },
    );
    expect(persistedTabsFile.activeTabId).toBe('advisor-viewed');
  });

  it('keeps an explicitly chosen routable model on an empty App Advisor tab for a bare send', async () => {
    initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);
    let persistedTabsFile = chatTabsFile([
      {
        id: 'advisor-chat-1',
        title: 'New Chat',
        createdAt: '2026-07-28T11:00:00.000Z',
        kind: 'chat',
        messages: [],
        model: 'gpt-5.5',
        providerType: 'codex',
        executionHarness: 'codex',
        modelExplicitlyChosen: true,
      },
    ]);
    mockedReadChatTabsFile.mockImplementation(() =>
      Promise.resolve(persistedTabsFile),
    );
    mockedWriteChatTabsFile.mockImplementation(
      (_projectId, _worktreeId, tabsFile) => {
        persistedTabsFile = tabsFile;
        return Promise.resolve();
      },
    );
    const appAdvisorSurfaces = {
      getMainWindow: (): null => null,
      getAppAdvisorWindow: (): null => null,
      openAppAdvisorWindow: jest.fn(),
      ensureAppAdvisorWindow: jest.fn(),
    };

    await sendWorktreeChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_ENTRY_ID,
        chatId: 'advisor-chat-1',
        userMessageId: 'message-1',
        text: 'Use the model I selected',
      },
      { appAdvisorSurfaces },
    );

    expect(persistedTabsFile.tabs[0]).toMatchObject({
      model: 'gpt-5.5',
      providerType: 'codex',
      executionHarness: 'codex',
      modelExplicitlyChosen: true,
    });
    expect(mockedDispatchAppAdvisorChatMessage).toHaveBeenCalledWith(
      expect.not.objectContaining({ model: expect.anything() }),
      expect.objectContaining({ toolSurfaces: appAdvisorSurfaces }),
    );
  });

  it('clears provider-coupled settings with a stale empty-tab model', async () => {
    // `thinkingLevel` and `modelConfig` belong to the model that was cleared —
    // `fastMode` is Codex-only, and thinking is clamped per model — so leaving
    // them would apply that model's configuration to the replacement default
    // on the NEXT send.
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'tab-empty',
          title: 'New Chat',
          createdAt: '2026-07-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
          model: 'stale-model',
          providerType: 'codex',
          thinkingLevel: 'high',
          modelConfig: { fastMode: true },
        },
      ]),
    );

    await sendWorktreeChatMessage({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      userMessageId: 'message-1',
      text: 'Mobile New Task, no chatId and no model',
    });

    const writtenTab = mockedWriteChatTabsFile.mock.calls[0]?.[2].tabs[0];
    expect(writtenTab?.model).toBeUndefined();
    expect(writtenTab?.providerType).toBeUndefined();
    expect(writtenTab?.thinkingLevel).toBeUndefined();
    expect(writtenTab?.modelConfig).toBeUndefined();
  });

  it('clears the captured harness with a stale empty-tab model', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'tab-empty',
          title: 'New Chat',
          createdAt: '2026-07-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
          model: 'stale-codex-harness-model',
          providerType: 'codex',
          executionHarness: 'codex',
        },
      ]),
    );

    await sendWorktreeChatMessage({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      userMessageId: 'message-1',
      text: 'Use the provider default',
    });

    const writtenTab = mockedWriteChatTabsFile.mock.calls[0]?.[2].tabs[0];
    expect(writtenTab?.model).toBeUndefined();
    expect(writtenTab?.executionHarness).toBeUndefined();
    expect(
      mockedDispatchWorktreeChatTurn.mock.calls[0]?.[0].executionHarness,
    ).toBeUndefined();
  });

  it('lets an explicit request value survive the stale-tab clear', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'tab-empty',
          title: 'New Chat',
          createdAt: '2026-07-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
          model: 'stale-model',
          providerType: 'codex',
          thinkingLevel: 'high',
        },
      ]),
    );

    await sendWorktreeChatMessage({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      userMessageId: 'message-1',
      text: 'No model, but an explicit thinking level',
      thinkingLevel: 'low',
    });

    // The clear runs BEFORE the request spreads, so an explicitly supplied
    // value still wins over it.
    const writtenTab = mockedWriteChatTabsFile.mock.calls[0]?.[2].tabs[0];
    expect(writtenTab?.model).toBeUndefined();
    expect(writtenTab?.thinkingLevel).toBe('low');
  });

  // CAN-2318. Automations call this service directly with no adapter
  // preflight, and a queued send drains after the model may have been blocked.
  // Both re-enter with a concrete `request.model`.
  it('refuses a blocked model before persisting anything', async () => {
    blockedModelIds.add('blocked-model');

    await expect(
      sendWorktreeChatMessage({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        userMessageId: 'message-1',
        text: 'Automation prompt on a since-blocked model',
        model: 'blocked-model',
      }),
    ).rejects.toThrow('This model is blocked by your organization policy.');

    expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();
    expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
  });

  // CAN-1814 PR 5. A dependency the turn provably cannot authenticate is
  // refused on the same terms as a blocked model: before the tab, the user
  // message, or the turn exist.
  it('refuses a send whose required dependency is known-unauthenticated', async () => {
    mockAssertTurnAuthDependencies.mockRejectedValue(
      new Error(
        'Prod MCP server needs to be reconnected before this message can run.',
      ),
    );

    await expect(
      sendWorktreeChatMessage({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        userMessageId: 'message-1',
        text: 'Look up the record',
      }),
    ).rejects.toThrow('Prod MCP server needs to be reconnected');

    expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();
    expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
    expect(mockChatStateService.ingestProviderEvent).not.toHaveBeenCalled();
  });

  it('preflights the selections the turn will actually dispatch', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
          providerType: 'claude',
        },
      ]),
    );
    const pluginSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [{ serverId: 'srv-1', configId: 'cfg-1' }],
    };

    await sendWorktreeChatMessage({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      userMessageId: 'message-1',
      text: 'Look up the record',
      pluginSelections,
    });

    expect(mockAssertTurnAuthDependencies).toHaveBeenCalledWith({
      target: {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
      pluginSelections,
    });
  });

  it('does not refuse a send when nothing required is broken', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
          providerType: 'claude',
        },
      ]),
    );
    await expect(
      sendWorktreeChatMessage({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Look up the record',
      }),
    ).resolves.toEqual({ ok: true, chatId: 'chat-1' });
    expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledTimes(1);
  });

  it('refuses a desktop-funnel send before the user message is persisted', async () => {
    mockAssertTurnAuthDependencies.mockRejectedValue(
      new Error(
        'Prod MCP server needs to be reconnected before this message can run.',
      ),
    );

    await expect(
      dispatchHostQueuedWorktreeChatMessage(
        {
          projectId: 'workspace-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          userMessageId: 'message-1',
          text: 'Look up the record',
        },
        'desktop',
        false,
      ),
    ).rejects.toThrow('Prod MCP server needs to be reconnected');

    expect(
      mockChatStateService.ensureChatForTrustedSend,
    ).not.toHaveBeenCalled();
    expect(mockChatStateService.ingestProviderEvent).not.toHaveBeenCalled();
    expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
  });

  // The terminal branch returns BEFORE `getOrCreateSession`, forwarding the
  // prompt straight to the renderer's Claude terminal — so the guard has to
  // sit ahead of it. A session can never LAUNCH blocked
  // (`buildClaudeTerminalLaunchConfig` gates the model), but a policy can
  // change while one is live, and a new automation prompt must not be fed to
  // it.
  it('refuses a blocked model before forwarding to a Claude terminal', async () => {
    blockedModelIds.add('blocked-model');
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'tab-terminal',
          title: 'Terminal chat',
          createdAt: '2026-07-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
          providerType: 'claude',
          interfaceMode: 'auto',
        },
      ]),
    );

    await expect(
      sendWorktreeChatMessage({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'tab-terminal',
        userMessageId: 'message-1',
        text: 'Automation prompt into a live terminal',
        model: 'blocked-model',
        initiationSource: 'automation',
      }),
    ).rejects.toThrow('This model is blocked by your organization policy.');

    expect(mockedSendToWindowDetailed).not.toHaveBeenCalledWith(
      expect.anything(),
      IPC_CHANNELS.claudeTerminalScheduledPrompt,
      expect.anything(),
    );
    expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();
  });

  it('does not reuse an empty terminal-backed tab for a chatId-less send', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'tab-terminal',
          title: 'Terminal chat',
          createdAt: '2026-07-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
          providerType: 'claude',
          interfaceMode: 'auto',
        },
      ]),
    );

    const result = await sendWorktreeChatMessage({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      userMessageId: 'message-1',
      text: 'Fresh native turn',
    });

    expect(result.chatId).not.toBe('tab-terminal');
    const writtenTabsFile = mockedWriteChatTabsFile.mock.calls[0]?.[2];
    expect(writtenTabsFile?.tabs).toHaveLength(2);
    expect(writtenTabsFile?.tabs[0]).toMatchObject({
      id: 'tab-terminal',
      messages: [],
    });
  });

  it('does not reuse a tab that already has messages for a chatId-less send', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'tab-used',
          title: 'Existing conversation',
          createdAt: '2026-07-28T11:00:00.000Z',
          kind: 'chat',
          messages: [
            {
              id: 'old-message',
              role: 'user',
              timestamp: 1753700000000,
              blocks: [{ type: 'text', text: 'Earlier prompt' }],
            },
          ],
        },
      ]),
    );

    const result = await sendWorktreeChatMessage({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      userMessageId: 'message-1',
      text: 'Separate new task',
    });

    expect(result.chatId).not.toBe('tab-used');
    const writtenTabsFile = mockedWriteChatTabsFile.mock.calls[0]?.[2];
    expect(writtenTabsFile?.tabs).toHaveLength(2);
    expect(writtenTabsFile?.tabs[0]?.messages).toHaveLength(1);
  });

  it('cancels a manual send retry before loading the chat tabs', async () => {
    let resolveTabs: ((tabsFile: ChatTabsFile) => void) | undefined;
    mockedReadChatTabsFile.mockReturnValue(
      new Promise((resolve) => {
        resolveTabs = resolve;
      }),
    );

    const sendPromise = sendWorktreeChatMessage({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      text: 'Continue',
    });

    expect(mockedCancelTransientRetryForChat).toHaveBeenCalledWith(
      {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
      'manual-send',
    );

    resolveTabs?.(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Existing chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
        },
      ]),
    );
    await sendPromise;
  });

  it('cancels a stale retry when a queued manual turn begins dispatch', async () => {
    await dispatchHostQueuedWorktreeChatMessage(
      {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Queued follow-up',
      },
      'desktop',
      true,
    );

    expect(mockedCancelTransientRetryForChat).toHaveBeenCalledWith(
      {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Queued follow-up',
      },
      'queued-manual-send',
    );
  });

  it('drops a cancelled automatic retry when its queued row drains', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Existing chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
        },
      ]),
    );
    await getChatQueueService().submit(
      {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        userMessageId: 'active-message-1',
        text: 'Active turn',
      },
      'desktop',
    );
    expect(
      getChatQueueService().isTurnActive({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      }),
    ).toBe(true);
    await getChatQueueService().submit(
      {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        userMessageId: 'retry-message-1',
        text: 'Retry automatically',
        initiationSource: 'automation',
      },
      'desktop',
    );
    mockedDispatchWorktreeChatTurn.mockClear();
    mockedCancelTransientRetryForChat.mockReturnValueOnce(true);
    getChatQueueService().onTurnTerminal(
      {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
      'complete',
      'active-message-1',
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
    expect(
      getChatQueueService().isTurnActive({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      }),
    ).toBe(false);
  });

  it.each([
    {
      label: 'AI Credits routing',
      tabOptions: {
        aiCreditsRouting: {
          active: true,
          scope: 'session' as const,
          activatedAt: 1_000,
        },
      },
    },
    {
      label: 'subscription billing override',
      tabOptions: { subscriptionBillingOverride: true },
    },
    {
      label: 'Auto model selection',
      tabOptions: { modelSelectionMode: 'auto' as const },
    },
    {
      label: 'legacy model configuration',
      tabOptions: {
        thinkingLevel: 'low' as const,
        codexFastModeEnabled: true,
      },
    },
  ])(
    'preserves $label in existing-tab dispatch options',
    async ({ tabOptions }) => {
      mockedReadChatTabsFile.mockResolvedValue(
        chatTabsFile([
          {
            id: 'chat-1',
            title: 'Existing chat',
            createdAt: '2026-05-28T11:00:00.000Z',
            kind: 'chat',
            messages: [],
            ...tabOptions,
          },
        ]),
      );

      await expect(
        buildExistingTabDispatchOptions('workspace-1', 'worktree-1', 'chat-1'),
      ).resolves.toMatchObject(tabOptions);
    },
  );

  it('drops stale session AI Credits routing from existing-tab dispatch options (CAN-4200)', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Existing chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
          providerType: 'claude',
          aiCreditsRouting: {
            active: true,
            scope: 'session',
            activatedAt: 1_000,
            resetsAt: Date.now() - 1,
          },
          subscriptionBillingOverride: true,
        },
      ]),
    );

    const options = await buildExistingTabDispatchOptions(
      'workspace-1',
      'worktree-1',
      'chat-1',
    );
    expect(options).not.toHaveProperty('aiCreditsRouting');
    expect(options).toMatchObject({ subscriptionBillingOverride: true });
  });

  it('resolves the point-in-time fork anchor for a pending Claude fork send', async () => {
    // The source session can advance between fork creation and the fork's
    // first send, so the resume must name the chain entry the fork kept.
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Forked chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          providerType: 'claude',
          sdkSessionId: 'source-session',
          claudeForkSessionOnNextSend: true,
          forkedFrom: {
            projectId: 'workspace-1',
            worktreeId: 'worktree-1',
            chatId: 'source-chat',
            atMessageId: 'timer-1',
            resumePointRequired: true,
          },
          messages: [],
        },
      ]),
    );
    // Metadata-only tabs guard `messages`; the anchor is resolved through the
    // canonical transcript reader instead.
    mockedReadChatTranscript.mockResolvedValue([
      {
        id: 'u1',
        role: 'user',
        timestamp: 1,
        blocks: [{ type: 'text', text: 'First' }],
      },
      {
        id: 'a1',
        role: 'assistant',
        timestamp: 2,
        blocks: [{ type: 'text', text: 'First answer' }],
        claudeUuid: '11111111-1111-4111-8111-111111111111',
      },
      {
        id: 'timer-1',
        role: 'system',
        timestamp: 3,
        blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 2 }],
      },
    ]);

    await expect(
      buildExistingTabDispatchOptions('workspace-1', 'worktree-1', 'chat-1'),
    ).resolves.toMatchObject({
      sdkSessionId: 'source-session',
      claudeForkSession: true,
      claudeForkResumeAt: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('starts fresh when a point-in-time fork has no valid chain uuid', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Forked chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          providerType: 'claude',
          sdkSessionId: 'source-session',
          claudeForkSessionOnNextSend: true,
          forkedFrom: {
            projectId: 'workspace-1',
            worktreeId: 'worktree-1',
            chatId: 'source-chat',
            resumePointRequired: true,
          },
          messages: [],
        },
      ]),
    );
    mockedReadChatTranscript.mockResolvedValue([
      {
        id: 'a1',
        role: 'assistant',
        timestamp: 2,
        blocks: [{ type: 'text', text: 'Legacy answer' }],
      },
    ]);

    const options = await buildExistingTabDispatchOptions(
      'workspace-1',
      'worktree-1',
      'chat-1',
    );
    expect(options.sdkSessionId).toBeUndefined();
    expect(options.claudeForkSession).toBeUndefined();
    expect(options.claudeForkResumeAt).toBeUndefined();
    expect(options.claudeForkStartsFresh).toBe(true);
  });

  it('does not reuse durable fork provenance as a resume anchor after restore', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Cloned fork',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          providerType: 'claude',
          sdkSessionId: 'source-session',
          claudeForkSessionOnNextSend: true,
          forkedFrom: {
            projectId: 'workspace-1',
            worktreeId: 'worktree-1',
            chatId: 'source-chat',
            atMessageId: 'a1',
          },
          messages: [],
        },
      ]),
    );
    const options = await buildExistingTabDispatchOptions(
      'workspace-1',
      'worktree-1',
      'chat-1',
    );
    expect(options).toMatchObject({
      sdkSessionId: 'source-session',
      claudeForkSession: true,
    });
    expect(options.claudeForkResumeAt).toBeUndefined();
    expect(options.claudeForkStartsFresh).toBeUndefined();
    expect(mockedReadChatTranscript).not.toHaveBeenCalled();
  });

  it('preserves a plain fork resume when no point-in-time anchor is required', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Imported continuation',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          providerType: 'claude',
          sdkSessionId: 'source-session',
          claudeForkSessionOnNextSend: true,
          messages: [],
        },
      ]),
    );

    await expect(
      buildExistingTabDispatchOptions('workspace-1', 'worktree-1', 'chat-1'),
    ).resolves.toMatchObject({
      sdkSessionId: 'source-session',
      claudeForkSession: true,
    });
    expect(mockedReadChatTranscript).not.toHaveBeenCalled();
  });

  it('fails closed when a pending fork transcript cannot be read', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Forked chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          providerType: 'claude',
          sdkSessionId: 'source-session',
          claudeForkSessionOnNextSend: true,
          forkedFrom: {
            projectId: 'workspace-1',
            worktreeId: 'worktree-1',
            chatId: 'source-chat',
            resumePointRequired: true,
          },
          messages: [],
        },
      ]),
    );
    mockedReadChatTranscript.mockRejectedValueOnce(
      new Error('transcript unavailable'),
    );

    await expect(
      buildExistingTabDispatchOptions('workspace-1', 'worktree-1', 'chat-1'),
    ).rejects.toThrow('transcript unavailable');
  });

  it('never reads messages off a metadata-only dispatch tab', async () => {
    // `readChatTabsFile` returns tabs whose `messages` getter throws unless
    // the transcript was explicitly selected. Touching it here broke every
    // dispatch through this helper (StartForkedAgent, automations, portal).
    const guardedTab: PersistedChatTab = {
      id: 'chat-1',
      title: 'Forked chat',
      createdAt: '2026-05-28T11:00:00.000Z',
      kind: 'chat',
      providerType: 'claude',
      sdkSessionId: 'source-session',
      claudeForkSessionOnNextSend: true,
      messages: [],
    };
    Object.defineProperty(guardedTab, 'messages', {
      enumerable: false,
      get(): never {
        throw new Error(
          'Transcript chat-1 was not selected for this operation',
        );
      },
    });
    mockedReadChatTabsFile.mockResolvedValue(chatTabsFile([guardedTab]));
    mockedReadChatTranscript.mockResolvedValue([]);

    await expect(
      buildExistingTabDispatchOptions('workspace-1', 'worktree-1', 'chat-1'),
    ).resolves.toMatchObject({
      sdkSessionId: 'source-session',
      claudeForkSession: true,
    });
    expect(mockedReadChatTranscript).not.toHaveBeenCalled();
  });

  it('rejects backend chat sends while the worktree is split-locked', async () => {
    mockedAssertNotSplitLocked.mockImplementationOnce(() => {
      throw new Error('split locked');
    });

    await expect(
      sendWorktreeChatMessage({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        text: 'Retry automatically',
        initiationSource: 'automation',
      }),
    ).rejects.toThrow('split locked');

    expect(mockedReadChatTabsFile).not.toHaveBeenCalled();
    expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
  });

  it('checks managed chat split locks against the borrowed worktree', async () => {
    mockResolveWorktreeTargetIds.mockReturnValueOnce({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
    });
    mockedAssertNotSplitLocked.mockImplementationOnce(() => {
      throw new Error('split locked');
    });

    await expect(
      sendWorktreeChatMessage({
        projectId: 'code-review-chat',
        worktreeId: 'review-session-1',
        chatId: 'chat-1',
        text: 'Retry automatically',
        initiationSource: 'automation',
      }),
    ).rejects.toThrow('split locked');

    expect(mockResolveWorktreeTargetIds).toHaveBeenCalledWith(
      'code-review-chat',
      'review-session-1',
    );
    expect(mockedAssertNotSplitLocked).toHaveBeenCalledWith(
      'workspace-1',
      'worktree-1',
      'sending a chat message',
    );
    expect(mockedReadChatTabsFile).not.toHaveBeenCalled();
  });

  it('rejects a managed chat send when its borrowed worktree is unavailable', async () => {
    mockResolveWorktreeTargetIds.mockReturnValueOnce(null);

    await expect(
      sendWorktreeChatMessage({
        projectId: 'code-review-chat',
        worktreeId: 'review-session-1',
        chatId: 'chat-1',
        text: 'Retry automatically',
        initiationSource: 'automation',
      }),
    ).rejects.toThrow('Managed chat target could not be resolved.');

    expect(mockedAssertNotSplitLocked).not.toHaveBeenCalled();
    expect(mockedReadChatTabsFile).not.toHaveBeenCalled();
  });

  it('preserves only the retry service own dispatch and cancels on stop', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Existing chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
        },
      ]),
    );

    await sendWorktreeChatMessage(
      {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        text: 'Retry internally',
        initiationSource: 'automation',
      },
      { preserveTransientRetry: true },
    );
    expect(mockedCancelTransientRetryForChat).not.toHaveBeenCalled();

    await cancelWorktreeChat({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
    });
    expect(mockedCancelTransientRetryForChat).toHaveBeenCalledWith(
      {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
      'stop',
    );
  });

  it('cancels an active worktree turn by turn id without retrying', async () => {
    mockCancelActiveChatTurn.mockReturnValueOnce(false);

    await expect(
      cancelWorktreeChatTurn({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        turnId: 'message-1',
      }),
    ).resolves.toEqual({ ok: true, outcome: 'turn_not_active' });

    expect(mockBuildSessionKey).toHaveBeenCalledWith(
      'workspace-1',
      'worktree-1',
      'chat-1',
    );
    expect(mockCancelActiveChatTurn).toHaveBeenCalledWith(
      'workspace-1/worktree-1/chat-1',
      'message-1',
    );
    expect(mockedCancelTransientRetryForChat).not.toHaveBeenCalled();
  });

  describe('exact-turn stop of a turn that has not started', () => {
    const target = {
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
    };

    it('withdraws a queued turn instead of reporting it inactive', async () => {
      mockCancelActiveChatTurn.mockReturnValueOnce(false);
      const queue = getChatQueueService();
      jest.spyOn(queue, 'holdsUserMessage').mockReturnValueOnce(true);
      const withdraw = jest
        .spyOn(queue, 'withdrawQueuedUserMessage')
        .mockResolvedValueOnce('applied');

      await expect(
        cancelWorktreeChatTurn({ ...target, turnId: 'message-1' }),
      ).resolves.toEqual({ ok: true, outcome: 'stop_requested' });
      expect(withdraw).toHaveBeenCalledWith(target, 'message-1');
      expect(mockRequestChatTurnCancel).not.toHaveBeenCalled();
    });

    it('stops a queued turn when it starts if the queue is busy', async () => {
      mockCancelActiveChatTurn.mockReturnValueOnce(false);
      const queue = getChatQueueService();
      jest.spyOn(queue, 'holdsUserMessage').mockReturnValueOnce(true);
      jest
        .spyOn(queue, 'withdrawQueuedUserMessage')
        .mockResolvedValueOnce('busy');

      await expect(
        cancelWorktreeChatTurn({ ...target, turnId: 'message-1' }),
      ).resolves.toEqual({ ok: true, outcome: 'stop_requested' });
      expect(mockRequestChatTurnCancel).toHaveBeenCalledWith(
        'workspace-1/worktree-1/chat-1',
        'message-1',
      );
    });

    it('stops a turn the queue has claimed when its provider marks it active', async () => {
      mockCancelActiveChatTurn.mockReturnValueOnce(false);
      const queue = getChatQueueService();
      jest
        .spyOn(queue, 'runningTurnUserMessageId')
        .mockReturnValueOnce('message-1');
      const withdraw = jest.spyOn(queue, 'withdrawQueuedUserMessage');

      await expect(
        cancelWorktreeChatTurn({ ...target, turnId: 'message-1' }),
      ).resolves.toEqual({ ok: true, outcome: 'stop_requested' });
      expect(mockRequestChatTurnCancel).toHaveBeenCalledWith(
        'workspace-1/worktree-1/chat-1',
        'message-1',
      );
      expect(withdraw).not.toHaveBeenCalled();
    });
  });

  it('reports an exact active-turn stop request', async () => {
    mockCancelActiveChatTurn.mockReturnValueOnce(true);

    await expect(
      cancelWorktreeChatTurn({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        turnId: 'message-1',
      }),
    ).resolves.toEqual({ ok: true, outcome: 'stop_requested' });
  });

  it('rejects Cowork and standalone scopes for worktree turn cancellation', async () => {
    registerWorkspaceTypes(new Map([['cowork-1', 'cowork' as const]]));
    const request = {
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      turnId: 'message-1',
    };

    await expect(
      cancelWorktreeChatTurn({ ...request, projectId: 'cowork-1' }),
    ).rejects.toThrow('Standalone and Cowork chats are not worktree targets.');
    await expect(
      cancelWorktreeChatTurn({
        ...request,
        projectId: 'standalone-chat',
      }),
    ).rejects.toThrow('Standalone and Cowork chats are not worktree targets.');

    expect(mockCancelActiveChatTurn).not.toHaveBeenCalled();
  });

  it('emits standalone Portal events for retry dispatches to Cowork chats', async () => {
    registerWorkspaceTypes(new Map([['cowork-1', 'cowork' as const]]));
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Cowork chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
        },
      ]),
    );
    mockedDispatchWorktreeChatTurn.mockImplementationOnce((options) => {
      // The real worktree dispatcher releases its host queue before publishing
      // the terminal callback; this mock owns both sides of that boundary.
      getChatQueueService().onTurnTerminal(
        options,
        'complete',
        options.userMessageId,
      );
      options.onChatEvent?.({
        projectId: options.projectId,
        worktreeId: options.worktreeId,
        chatId: options.chatId,
        isTerminalEvent: true,
        data: {
          type: 'result',
          is_error: false,
          result: 'Turn completed',
        },
      });
      return Promise.resolve();
    });

    await sendWorktreeChatMessage(
      {
        projectId: 'cowork-1',
        worktreeId: 'entry-1',
        chatId: 'chat-1',
        userMessageId: 'retry-message-1',
        text: 'Continue',
        initiationSource: 'automation',
      },
      { preserveTransientRetry: true },
    );

    expect(mockedCreatePortalEvent).toHaveBeenCalledWith(
      'portal.chat.event',
      expect.objectContaining({
        scope: 'standalone',
        projectLocalId: 'cowork-1',
        projectId: 'cowork-1',
        workEntryId: 'entry-1',
        chatId: 'chat-1',
      }),
    );
    expect(mockedCreatePortalEvent).not.toHaveBeenCalledWith(
      'portal.chat.event',
      expect.objectContaining({ scope: 'worktree' }),
    );
    expect(mockedCreatePortalEvent).toHaveBeenCalledWith(
      'portal.state.delta',
      expect.objectContaining({
        scope: 'standalone_chat',
        target: { standaloneChatLocalId: 'chat-1' },
        entities: [
          expect.objectContaining({
            entityType: 'standalone_chat',
            localId: 'chat-1',
            parentLocalId: 'cowork-1',
          }),
        ],
      }),
    );
    expect(mockedCreatePortalEvent).not.toHaveBeenCalledWith(
      'portal.state.delta',
      expect.objectContaining({
        entities: [expect.objectContaining({ entityType: 'chat_summary' })],
      }),
    );
    const serializedPortalEvents = JSON.stringify(
      mockedCreatePortalEvent.mock.calls,
    );
    expect(serializedPortalEvents).toContain('"hasActiveChat":true');
    expect(serializedPortalEvents).toContain('"hasActiveChat":false');
  });

  it('keeps standalone chats active when dispatch returns before the turn ends', async () => {
    registerWorkspaceTypes(new Map([['cowork-1', 'cowork' as const]]));
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Cowork chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
        },
      ]),
    );

    await sendWorktreeChatMessage({
      projectId: 'cowork-1',
      worktreeId: 'entry-1',
      chatId: 'chat-1',
      userMessageId: 'message-1',
      text: 'Continue',
    });

    const serializedPortalEvents = JSON.stringify(
      mockedCreatePortalEvent.mock.calls,
    );
    expect(serializedPortalEvents).toContain('"hasActiveChat":true');
    expect(serializedPortalEvents).not.toContain('"hasActiveChat":false');
  });

  it('rejects App Advisor sends before mutating chat state when surfaces are missing', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'advisor-chat-1',
          title: 'Existing advisor chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
        },
      ]),
    );

    await expect(
      sendWorktreeChatMessage({
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_ENTRY_ID,
        chatId: 'advisor-chat-1',
        text: 'Continue',
        initiationSource: 'automation',
      }),
    ).rejects.toThrow(
      'Cannot dispatch an App Advisor scheduled message without App Advisor surfaces.',
    );

    expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();
    expect(mockedSendToWindow).not.toHaveBeenCalled();
    expect(mockedDispatchAppAdvisorChatMessage).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'carries fork admission cancellation through the queued send, advisor: %s',
    async (advisor) => {
      const stop = new AbortController();
      mockedReadChatTabsFile.mockResolvedValue(
        chatTabsFile([
          {
            id: 'fork-chat',
            title: 'Fork',
            createdAt: '2026-10-15T00:00:00.000Z',
            kind: 'chat',
            messages: [],
          },
        ]),
      );
      const rejectAdmission = (options: {
        admissionSignal?: AbortSignal;
      }): Promise<never> => {
        stop.abort(new Error('Parent stopped during admission'));
        options.admissionSignal?.throwIfAborted();
        return Promise.reject(new Error('Missing admission signal'));
      };
      if (advisor)
        mockedDispatchAppAdvisorChatMessage.mockImplementationOnce(
          (_request, options) => rejectAdmission(options),
        );
      else
        mockedDispatchWorktreeChatTurn.mockImplementationOnce(rejectAdmission);
      const appAdvisorSurfaces = {
        getMainWindow: (): null => null,
        getAppAdvisorWindow: (): null => null,
        openAppAdvisorWindow: jest.fn(),
        ensureAppAdvisorWindow: jest.fn(),
      };
      await expect(
        sendWorktreeChatMessage(
          {
            projectId: advisor ? APP_ADVISOR_PROJECT_ID : 'workspace-1',
            worktreeId: advisor ? APP_ADVISOR_ENTRY_ID : 'worktree-1',
            chatId: 'fork-chat',
            userMessageId: 'message-1',
            text: 'Continue',
            initiationSource: 'automation',
          },
          {
            admissionSignal: stop.signal,
            ...(advisor ? { appAdvisorSurfaces } : {}),
          },
        ),
      ).rejects.toThrow('Parent stopped during admission');
    },
  );

  it('preserves the App Advisor acceptance signal when later host persistence fails', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'advisor-chat-1',
          title: 'Advisor',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
        },
      ]),
    );
    const onTurnAccepted = jest.fn();
    const failure = new Error('accepted advisor post-dispatch failure');
    mockedDispatchAppAdvisorChatMessage.mockImplementationOnce(
      (_request, options) => {
        options.onTurnAccepted?.();
        return Promise.reject(failure);
      },
    );
    const appAdvisorSurfaces = {
      getMainWindow: (): null => null,
      getAppAdvisorWindow: (): null => null,
      openAppAdvisorWindow: jest.fn(),
      ensureAppAdvisorWindow: jest.fn(),
    };
    await expect(
      sendWorktreeChatMessage(
        {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: APP_ADVISOR_ENTRY_ID,
          chatId: 'advisor-chat-1',
          userMessageId: 'message-1',
          text: 'Continue',
          initiationSource: 'automation',
        },
        { getWindow: () => null, appAdvisorSurfaces, onTurnAccepted },
      ),
    ).rejects.toBe(failure);
    expect(onTurnAccepted).toHaveBeenCalledTimes(1);
  });

  it('dispatches existing App Advisor session prompts through the App Advisor runtime', async () => {
    const sessionApprovalRules = [
      {
        id: 'deny-env',
        behavior: 'deny' as const,
        target: { kind: 'file-write' as const, path: '.env' },
        createdAt: '2026-07-23T00:00:00.000Z',
        origin: 'prompt' as const,
      },
    ];
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'advisor-chat-1',
          title: 'Existing advisor chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
          providerType: 'codex',
          model: 'gpt-5.5',
          approvalMode: 'auto',
          sessionApprovalRules,
        },
      ]),
    );
    const mainWindow = new BrowserWindow();
    const appAdvisorWindow = new BrowserWindow();
    const appAdvisorSurfaces = {
      getMainWindow: (): BrowserWindow => mainWindow,
      getAppAdvisorWindow: (): BrowserWindow => appAdvisorWindow,
      openAppAdvisorWindow: jest.fn(),
      ensureAppAdvisorWindow: jest.fn(),
    };

    await sendWorktreeChatMessage(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_ENTRY_ID,
        chatId: 'advisor-chat-1',
        userMessageId: 'message-1',
        text: 'Continue',
        initiationSource: 'automation',
        automationName: 'Resume advisor chat',
        fileReferences: [
          {
            displayPath: 'src/index.ts',
            absolutePath: '/repo/src/index.ts',
            repoName: 'canopy',
          },
        ],
        attachmentPaths: ['/attachments/context.png'],
        attachmentPromptContexts: [
          {
            attachmentPath: '/attachments/context.png',
            promptKind: 'in-app-browser-resource',
          },
        ],
        inputMode: 'voice',
        providerType: 'codex',
        model: 'gpt-5.5',
      },
      { getWindow: appAdvisorSurfaces.getMainWindow, appAdvisorSurfaces },
    );

    expect(mockChatStateService.runWithScopeActivity).toHaveBeenCalledWith(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_ENTRY_ID,
      },
      expect.any(Function),
    );

    expect(mockedWriteChatTabsFile).toHaveBeenCalledWith(
      APP_ADVISOR_PROJECT_ID,
      APP_ADVISOR_ENTRY_ID,
      expect.objectContaining({ activeTabId: 'advisor-chat-1' }),
    );
    const mainPromptCall = mockedSendToWindow.mock.calls.find(
      ([target, channel]) =>
        target === mainWindow && channel === IPC_CHANNELS.chatEvent,
    );
    expect(mainPromptCall?.[2]).toMatchObject({
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: APP_ADVISOR_ENTRY_ID,
      chatId: 'advisor-chat-1',
      data: {
        type: 'canopy_user_prompt',
        original_text: 'Continue',
        canopy_persisted_messages: [
          expect.objectContaining({
            role: 'system',
            blocks: [expect.objectContaining({ type: 'automation_info' })],
          }),
          {
            id: 'message-1',
            role: 'user',
            blocks: [
              {
                type: 'file_references',
                references: [
                  {
                    displayPath: 'src/index.ts',
                    absolutePath: '/repo/src/index.ts',
                    repoName: 'canopy',
                  },
                ],
              },
              { type: 'text', text: 'Continue' },
            ],
            attachmentPaths: ['/attachments/context.png'],
            attachmentPromptContexts: [
              {
                attachmentPath: '/attachments/context.png',
                promptKind: 'in-app-browser-resource',
              },
            ],
            inputMode: 'voice',
          },
        ],
      },
    });
    expect(appAdvisorSurfaces.ensureAppAdvisorWindow).toHaveBeenCalledTimes(1);
    expect(
      appAdvisorSurfaces.ensureAppAdvisorWindow.mock.invocationCallOrder[0],
    ).toBeLessThan(mockedWriteChatTabsFile.mock.invocationCallOrder[0]);
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      appAdvisorWindow,
      IPC_CHANNELS.chatEvent,
      expect.any(Object),
    );
    expect(mockedDispatchAppAdvisorChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_ENTRY_ID,
        chatId: 'advisor-chat-1',
        text: 'Continue',
        assistantMode: 'app-advisor',
        approvalMode: 'auto',
        sessionApprovalRules,
      }),
      expect.objectContaining({ toolSurfaces: appAdvisorSurfaces }),
    );
    expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
    const [clearTarget, clearOptions] =
      mockedClearUsageLimitedChat.mock.calls.at(-1) ?? [];
    expect(clearTarget).toEqual({
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: APP_ADVISOR_ENTRY_ID,
      chatId: 'advisor-chat-1',
    });
    expect(typeof clearOptions?.onlyIfDetectedBefore).toBe('number');
  });

  it.each([
    {
      label: 'cross-harness',
      providerType: 'claude' as const,
      expectedHarness: undefined,
    },
    {
      label: 'same-harness',
      providerType: 'ollama' as const,
      expectedHarness: undefined,
    },
  ])(
    'clears persisted provider state for a $label App Advisor provider switch',
    async ({ providerType, expectedHarness }) => {
      mockedReadChatTabsFile.mockResolvedValue(
        chatTabsFile([
          {
            id: 'advisor-chat-1',
            title: 'Existing advisor chat',
            createdAt: '2026-05-28T11:00:00.000Z',
            kind: 'chat',
            messages: [
              {
                id: 'existing-message',
                role: 'user',
                timestamp: 1,
                blocks: [{ type: 'text', text: 'Existing' }],
              },
            ],
            providerType: 'codex',
            model: 'gpt-5.5',
            modelConfig: { thinkingLevel: 'high' },
            thinkingLevel: 'high',
            executionHarness: 'codex',
            sdkSessionId: 'codex-session',
            globalInstructionsSnapshot: 'codex instructions',
            codexReconstructionSeedId: 'codex-seed',
          },
        ]),
      );
      const mainWindow = new BrowserWindow();
      const appAdvisorWindow = new BrowserWindow();
      const appAdvisorSurfaces = {
        getMainWindow: (): BrowserWindow => mainWindow,
        getAppAdvisorWindow: (): BrowserWindow => appAdvisorWindow,
        openAppAdvisorWindow: jest.fn(),
        ensureAppAdvisorWindow: jest.fn(),
      };

      await sendWorktreeChatMessage(
        {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: APP_ADVISOR_ENTRY_ID,
          chatId: 'advisor-chat-1',
          userMessageId: 'message-1',
          text: 'Switch providers',
          providerType,
          model: 'gpt-5.5',
          modelConfig: { thinkingLevel: 'high' },
          sdkSessionId: 'codex-session',
          globalInstructionsSnapshot: 'codex instructions',
          codexReconstructionSeedId: 'codex-seed',
        },
        { getWindow: appAdvisorSurfaces.getMainWindow, appAdvisorSurfaces },
      );

      const persistedTab = mockedWriteChatTabsFile.mock.calls[0]?.[2].tabs[0];
      expect(persistedTab).toMatchObject({ providerType });
      expect(persistedTab?.executionHarness).toBe(expectedHarness);
      expect(persistedTab).not.toHaveProperty('model');
      expect(persistedTab).not.toHaveProperty('modelConfig');
      expect(persistedTab).not.toHaveProperty('thinkingLevel');
      expect(persistedTab).not.toHaveProperty('sdkSessionId');
      expect(persistedTab).not.toHaveProperty('globalInstructionsSnapshot');
      expect(persistedTab).not.toHaveProperty('codexReconstructionSeedId');

      expect(mockedDispatchAppAdvisorChatMessage).toHaveBeenCalledWith(
        expect.objectContaining({ providerType }),
        expect.any(Object),
      );
      const dispatchedRequest =
        mockedDispatchAppAdvisorChatMessage.mock.calls[0]?.[0];
      expect(dispatchedRequest?.executionHarness).toBe(expectedHarness);
      expect(dispatchedRequest).not.toHaveProperty('model');
      expect(dispatchedRequest).not.toHaveProperty('sdkSessionId');
      expect(dispatchedRequest).not.toHaveProperty(
        'globalInstructionsSnapshot',
      );
    },
  );

  it.each([false, true])(
    'reports acceptance before Claude fork-init persistence (write rejected: %s)',
    async (writeRejected) => {
      const failure = new Error('fork marker persistence failed');
      const onTurnAccepted = jest.fn();
      const sendOptions = { getWindow: () => null, onTurnAccepted };
      let persistedTabsFile = chatTabsFile([
        {
          id: 'chat-1',
          title: 'Forked chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
          providerType: 'claude',
          sdkSessionId: 'source-session',
          claudeForkSessionOnNextSend: true,
          forkedFrom: {
            projectId: 'workspace-1',
            worktreeId: 'worktree-1',
            chatId: 'source-chat',
            resumePointRequired: true,
          },
          pendingSystemInstructions: [
            {
              id: 'worktree-relocation',
              text: 'The current working directory is /worktrees/destination.',
            },
          ],
        },
      ]);
      mockedReadChatTabsFile.mockImplementation(() =>
        Promise.resolve(persistedTabsFile),
      );
      mockedWriteChatTabsFile.mockImplementation(
        (_projectId, _worktreeId, tabsFile) => {
          if (
            writeRejected &&
            tabsFile.tabs[0]?.sdkSessionId === 'forked-session'
          )
            return Promise.reject(failure);
          persistedTabsFile = tabsFile;
          return Promise.resolve();
        },
      );
      mockedDispatchWorktreeChatTurn.mockImplementationOnce((options) => {
        options.onTurnAccepted?.();
        options.onChatEvent?.({
          projectId: 'workspace-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          isTerminalEvent: false,
          data: {
            type: 'system',
            subtype: 'init',
            session_id: 'forked-session',
          },
        });
        return Promise.resolve();
      });

      const send = sendWorktreeChatMessage(
        {
          projectId: 'workspace-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          userMessageId: 'message-1',
          text: 'Continue in the fork',
          providerType: 'claude',
          sdkSessionId: 'source-session',
          claudeForkSession: true,
          initiationSource: 'automation',
        },
        sendOptions,
      );
      if (writeRejected) await expect(send).rejects.toBe(failure);
      else await send;
      expect(onTurnAccepted).toHaveBeenCalledTimes(1);
      if (writeRejected) return;

      expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          sdkSessionId: 'source-session',
          claudeForkSession: true,
          pendingSystemInstructions: [
            expect.objectContaining({ id: 'worktree-relocation' }),
          ],
        }),
      );
      expect(persistedTabsFile.tabs[0]).toMatchObject({
        sdkSessionId: 'forked-session',
      });
      expect(
        persistedTabsFile.tabs[0]?.claudeForkSessionOnNextSend,
      ).toBeUndefined();
      expect(
        persistedTabsFile.tabs[0]?.forkedFrom?.resumePointRequired,
      ).toBeUndefined();
      expect(
        persistedTabsFile.tabs[0]?.pendingSystemInstructions,
      ).toBeUndefined();
      expect(mockedSendToWindow).toHaveBeenCalledWith(
        null,
        IPC_CHANNELS.chatEvent,
        {
          projectId: 'workspace-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          data: {
            type: CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE,
            canopy_turn_user_message_id: 'message-1',
            canopy_consumed_pending_system_instruction_ids: [
              'worktree-relocation',
            ],
          },
        },
      );
    },
  );

  it('clears persisted provider session state when a requested model switches harnesses', async () => {
    initClaudeModels([{ id: 'claude-cross-harness', label: 'Claude Cross' }]);
    initCodexModels([{ id: 'gpt-cross-harness', label: 'Codex Cross' }]);
    let persistedTabsFile = chatTabsFile([
      {
        id: 'chat-1',
        title: 'Harness switch',
        createdAt: '2026-05-28T11:00:00.000Z',
        kind: 'chat',
        messages: [],
        providerType: 'claude',
        model: 'claude-cross-harness',
        executionHarness: 'claude',
        sdkSessionId: 'claude-session',
        claudeForkSessionOnNextSend: true,
        codexReconstructionSeedId: 'stale-seed',
      },
    ]);
    mockedReadChatTabsFile.mockImplementation(() =>
      Promise.resolve(persistedTabsFile),
    );
    mockedWriteChatTabsFile.mockImplementation(
      (_projectId, _worktreeId, tabsFile) => {
        persistedTabsFile = tabsFile;
        return Promise.resolve();
      },
    );

    await sendWorktreeChatMessage({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      userMessageId: 'message-1',
      text: 'Switch harness',
      providerType: 'codex',
      model: 'gpt-cross-harness',
    });

    expect(persistedTabsFile.tabs[0]).toMatchObject({
      model: 'gpt-cross-harness',
      providerType: 'codex',
      executionHarness: 'codex',
    });
    expect(persistedTabsFile.tabs[0]).not.toHaveProperty('sdkSessionId');
    expect(persistedTabsFile.tabs[0]).not.toHaveProperty(
      'claudeForkSessionOnNextSend',
    );
    expect(persistedTabsFile.tabs[0]).not.toHaveProperty(
      'codexReconstructionSeedId',
    );
    expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({ executionHarness: 'codex' }),
    );
  });

  // CAN-2339 round 7. The portal adapter discards a persisted tab model that
  // no longer resolves to a provider, but only from its LOCAL dispatch
  // options: the service reloads the established tab from disk, so the stale
  // model, harness, model configuration, and session fields survived — this
  // model-less send ran a resolved default while the tab kept advertising
  // (and re-dispatching, via the adapter's tab-options echo) the stale
  // routing/session state.
  it('resets stale routing and session state on an established tab whose model no longer routes', async () => {
    initClaudeModels([{ id: 'claude-live-model', label: 'Claude Live' }]);
    initCodexModels([{ id: 'gpt-live-model', label: 'Codex Live' }]);
    initAiGatewayModels(
      [
        {
          id: 'gateway-live-model',
          label: 'Gateway Live',
          recommendedHarness: 'codex',
          contextWindow: 100_000,
          supportsPromptCaching: false,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'standard',
        },
      ],
      [
        {
          modelId: 'gateway-live-model',
          gatewayId: 'provider/gateway-live-model',
          recommendedHarness: 'codex',
          gatewayOnly: true,
          contextWindow: 100_000,
          supportsPromptCaching: false,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'standard',
        },
      ],
    );
    let persistedTabsFile = chatTabsFile([
      {
        id: 'chat-1',
        title: 'Established conversation',
        createdAt: '2026-05-28T11:00:00.000Z',
        kind: 'chat',
        messages: [
          {
            id: 'old-message',
            role: 'user',
            timestamp: 1753700000000,
            blocks: [{ type: 'text', text: 'Earlier prompt' }],
          },
        ],
        model: 'stale-removed-model',
        executionHarness: 'claude',
        sdkSessionId: 'claude-session',
        claudeForkSessionOnNextSend: true,
        codexReconstructionSeedId: 'stale-seed',
        thinkingLevel: 'high',
        modelConfig: { fastMode: true },
      },
    ]);
    mockedReadChatTabsFile.mockImplementation(() =>
      Promise.resolve(persistedTabsFile),
    );
    mockedWriteChatTabsFile.mockImplementation(
      (_projectId, _worktreeId, tabsFile) => {
        persistedTabsFile = tabsFile;
        return Promise.resolve();
      },
    );

    // The adapter's post-discard request: no model, with the tab's own
    // persisted fields echoed back through `buildExistingTabDispatchOptions`.
    await sendWorktreeChatMessage({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      userMessageId: 'message-1',
      text: 'Continue without a model',
      sdkSessionId: 'claude-session',
      claudeForkSession: true,
      codexReconstructionSeedId: 'stale-seed',
      executionHarness: 'claude',
      modelConfig: { fastMode: true },
    });

    const writtenTab = persistedTabsFile.tabs[0];
    expect(writtenTab?.model).toBeUndefined();
    expect(writtenTab?.providerType).toBeUndefined();
    expect(writtenTab?.executionHarness).toBeUndefined();
    expect(writtenTab?.thinkingLevel).toBeUndefined();
    expect(writtenTab?.modelConfig).toBeUndefined();
    expect(writtenTab).not.toHaveProperty('sdkSessionId');
    expect(writtenTab).not.toHaveProperty('claudeForkSessionOnNextSend');
    expect(writtenTab).not.toHaveProperty('codexReconstructionSeedId');
    // The dispatched turn must match the reset tab: no stale session resume,
    // no forced harness, no stale model configuration.
    const dispatched = mockedDispatchWorktreeChatTurn.mock.calls[0]?.[0];
    expect(dispatched?.model).toBeUndefined();
    expect(dispatched?.sdkSessionId).toBeUndefined();
    expect(dispatched?.executionHarness).toBeUndefined();
    expect(dispatched?.modelConfig).toBeUndefined();
  });

  describe('a chat that stores an Agent now on the default model', () => {
    let persistedTabsFile = chatTabsFile([]);

    function storeAgent(model: string): void {
      persistedTabsFile = chatTabsFile([
        {
          id: 'chat-1',
          title: 'Agent chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          messages: [
            {
              id: 'old-message',
              role: 'user',
              timestamp: 1753700000000,
              blocks: [{ type: 'text', text: 'Earlier prompt' }],
            },
          ],
          model,
          providerType: 'claude',
        },
      ]);
      mockedReadChatTabsFile.mockImplementation(() =>
        Promise.resolve(persistedTabsFile),
      );
      mockedWriteChatTabsFile.mockImplementation(
        (_projectId, _worktreeId, tabsFile) => {
          persistedTabsFile = tabsFile;
          return Promise.resolve();
        },
      );
    }

    it('pins it before saving a send that names no model', async () => {
      storeAgent('agent_model_inherit');

      await sendWorktreeChatMessage({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'From the Portal',
      });

      expect(persistedTabsFile.tabs[0]?.model).toBe(
        'agent_model_inherit@gpt-5.5',
      );
      expect(mockedDispatchWorktreeChatTurn.mock.calls[0]?.[0]?.model).toBe(
        'agent_model_inherit@gpt-5.5',
      );
    });

    it('saves nothing when the default is another Agent', async () => {
      storeAgent('agent_model_nested');

      await expect(
        sendWorktreeChatMessage({
          projectId: 'workspace-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          userMessageId: 'message-1',
          text: 'From the Portal',
        }),
      ).rejects.toThrow('The default model is an Agent.');

      expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();
      expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
    });
  });

  it('resets an established stale model even when it has a persisted provider', async () => {
    initClaudeModels([{ id: 'claude-live-model', label: 'Claude Live' }]);
    initCodexModels([{ id: 'gpt-live-model', label: 'Codex Live' }]);
    let persistedTabsFile = chatTabsFile([
      {
        id: 'chat-1',
        title: 'Established conversation',
        createdAt: '2026-05-28T11:00:00.000Z',
        kind: 'chat',
        messages: [
          {
            id: 'old-message',
            role: 'user',
            timestamp: 1753700000000,
            blocks: [{ type: 'text', text: 'Earlier prompt' }],
          },
        ],
        model: 'stale-removed-model',
        providerType: 'claude',
        executionHarness: 'claude',
        sdkSessionId: 'claude-session',
      },
    ]);
    mockedReadChatTabsFile.mockImplementation(() =>
      Promise.resolve(persistedTabsFile),
    );
    mockedWriteChatTabsFile.mockImplementation(
      (_projectId, _worktreeId, tabsFile) => {
        persistedTabsFile = tabsFile;
        return Promise.resolve();
      },
    );

    await sendWorktreeChatMessage({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      userMessageId: 'message-1',
      text: 'Continue without a model',
      sdkSessionId: 'claude-session',
      executionHarness: 'claude',
    });

    const writtenTab = persistedTabsFile.tabs[0];
    expect(writtenTab?.model).toBeUndefined();
    expect(writtenTab?.providerType).toBeUndefined();
    expect(writtenTab?.executionHarness).toBeUndefined();
    expect(writtenTab?.sdkSessionId).toBeUndefined();
    expect(
      mockedDispatchWorktreeChatTurn.mock.calls[0]?.[0],
    ).not.toHaveProperty('sdkSessionId');
  });

  it('rejects a conflicting Portal harness echo for a managed model', async () => {
    initClaudeModels([{ id: 'claude-host-owned', label: 'Claude Host Owned' }]);
    mockedReadChatTabsFile.mockResolvedValue(chatTabsFile([]));

    await expect(
      dispatchHostQueuedWorktreeChatMessage(
        {
          projectId: 'workspace-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-portal-conflict',
          userMessageId: 'message-1',
          text: 'Use the managed model',
          model: 'claude-host-owned',
          providerType: 'claude',
          executionHarness: 'codex',
        },
        'portal',
        false,
      ),
    ).rejects.toThrow(/execution harness/i);

    expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();
    expect(mockedDispatchWorktreeChatTurn).not.toHaveBeenCalled();
  });

  it('preserves a captured harness when the global assignment changes', async () => {
    initAiGatewayModels(
      [
        {
          id: 'gateway-captured-harness',
          label: 'Gateway Captured Harness',
          recommendedHarness: 'codex',
          contextWindow: 100_000,
          supportsPromptCaching: false,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'standard',
        },
      ],
      [
        {
          modelId: 'gateway-captured-harness',
          gatewayId: 'provider/gateway-captured-harness',
          recommendedHarness: 'codex',
          gatewayOnly: true,
          contextWindow: 100_000,
          supportsPromptCaching: false,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'standard',
        },
      ],
    );
    initModelHarnessAssignments({
      revision: 2,
      assignments: [
        {
          modelId: 'gateway-captured-harness',
          source: 'ai-gateway',
          harness: 'codex',
          defaultHarness: 'codex',
          configurable: true,
          overridden: false,
        },
      ],
    });
    let persistedTabsFile = chatTabsFile([
      {
        id: 'chat-1',
        title: 'Captured harness',
        createdAt: '2026-05-28T11:00:00.000Z',
        kind: 'chat',
        messages: [],
        providerType: 'claude',
        model: 'gateway-captured-harness',
        executionHarness: 'claude',
        sdkSessionId: 'captured-session',
      },
    ]);
    mockedReadChatTabsFile.mockImplementation(() =>
      Promise.resolve(persistedTabsFile),
    );
    mockedWriteChatTabsFile.mockImplementation(
      (_projectId, _worktreeId, tabsFile) => {
        persistedTabsFile = tabsFile;
        return Promise.resolve();
      },
    );

    await sendWorktreeChatMessage({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      userMessageId: 'message-1',
      text: 'Continue captured session',
      providerType: 'claude',
      model: 'gateway-captured-harness',
      executionHarness: 'claude',
      sdkSessionId: 'captured-session',
    });

    expect(persistedTabsFile.tabs[0]).toMatchObject({
      executionHarness: 'claude',
      sdkSessionId: 'captured-session',
    });
    expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        executionHarness: 'claude',
        sdkSessionId: 'captured-session',
      }),
    );
  });

  it('does not reject an accepted turn when system instruction cleanup fails', async () => {
    const persistedTabsFile = chatTabsFile([
      {
        id: 'chat-1',
        title: 'Forked chat',
        createdAt: '2026-05-28T11:00:00.000Z',
        kind: 'chat',
        messages: [],
        providerType: 'claude',
        pendingSystemInstructions: [
          {
            id: 'worktree-relocation',
            text: 'The current working directory is /worktrees/destination.',
          },
        ],
      },
    ]);
    mockedReadChatTabsFile.mockResolvedValue(persistedTabsFile);
    mockedWriteChatTabsFile
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('cleanup failed'));
    mockedDispatchWorktreeChatTurn.mockImplementationOnce((options) => {
      options.onTurnAccepted?.();
      return Promise.resolve();
    });

    await expect(
      sendWorktreeChatMessage({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Continue in the fork',
        providerType: 'claude',
        initiationSource: 'automation',
      }),
    ).resolves.toEqual({ ok: true, chatId: 'chat-1' });
  });

  it('serializes the prompt mutation and routes Claude events through canonical ingestion', async () => {
    let persistedTabsFile = chatTabsFile([
      {
        id: 'chat-1',
        title: 'Portal chat',
        createdAt: '2026-05-28T11:00:00.000Z',
        kind: 'chat',
        messages: [],
        providerType: 'claude',
      },
    ]);
    mockedReadChatTabsFile.mockImplementation(() =>
      Promise.resolve(persistedTabsFile),
    );
    mockedWriteChatTabsFile.mockImplementation(
      (_projectId, _worktreeId, tabsFile) => {
        persistedTabsFile = tabsFile;
        return Promise.resolve();
      },
    );

    let releaseMutation: (() => void) | undefined;
    const inFlightMutation = enqueueChatTabMutation(
      'workspace-1',
      'worktree-1',
      () =>
        new Promise<void>((resolve) => {
          releaseMutation = resolve;
        }),
    );
    await Promise.resolve();

    const data = {
      type: 'assistant',
      message_id: 'assistant-1',
      message: { content: [{ type: 'text', text: 'Persist me.' }] },
    };
    mockedDispatchWorktreeChatTurn.mockImplementationOnce(async (options) => {
      await options.onBeforeChatEvent({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        data,
        sequenceNamespace: 'initial',
        sequence: 0,
        turnUserMessageId: 'message-1',
      });
      const writesBeforeDisplay = mockedWriteChatTabsFile.mock.calls.length;
      options.onChatEvent?.({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        isTerminalEvent: false,
        data,
      });
      await enqueueChatTabMutation('workspace-1', 'worktree-1', () =>
        Promise.resolve(),
      );
      expect(mockedWriteChatTabsFile).toHaveBeenCalledTimes(
        writesBeforeDisplay,
      );
    });

    const sendPromise = sendWorktreeChatMessage({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      userMessageId: 'message-1',
      text: 'Continue from portal',
      providerType: 'claude',
    });
    await Promise.resolve();

    expect(
      persistedTabsFile.tabs[0]?.messages.some(
        (message) => message.id === 'assistant-1',
      ),
    ).toBe(false);

    releaseMutation?.();
    await Promise.all([inFlightMutation, sendPromise]);

    expect(mockChatStateService.ingestProviderEvent).toHaveBeenCalledWith({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      providerType: 'claude',
      turnUserMessageId: 'message-1',
      mutationId: 'chat-1:message-1:provider:initial:0',
      data,
    });
  });

  it('clears the usage-limited registry entry for the target chat on send', async () => {
    // Automations (`worktree_session_prompt`, including the usage-limit
    // banner's own "resume at reset" automation) and the Portal chat adapter
    // both dispatch turns through this shared send primitive, not through
    // the renderer's `chatSendMessage` IPC handler. If this function doesn't
    // clear the usage-limited registry itself, a chat resumed via one of
    // those paths lingers in the registry and gets re-offered by the
    // account-change resume modal even though it has already been resumed.
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Existing chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
        },
      ]),
    );

    await sendWorktreeChatMessage({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      userMessageId: 'message-1',
      text: 'Continue at reset',
      initiationSource: 'automation',
    });

    // Guarded by the instant the dispatch began, so a usage-limit record the
    // dispatched turn writes by immediately re-hitting the limit survives the
    // clear that ends this send.
    const [clearTarget, clearOptions] =
      mockedClearUsageLimitedChat.mock.calls[0] ?? [];
    expect(clearTarget).toEqual({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
    });
    expect(typeof clearOptions?.onlyIfDetectedBefore).toBe('number');
  });

  it('restores persisted approval state when a resumed send omits it', async () => {
    const sessionApprovalRules = [
      {
        id: 'deny-env',
        behavior: 'deny' as const,
        target: { kind: 'file-write' as const, path: '.env' },
        createdAt: '2026-07-23T00:00:00.000Z',
        origin: 'prompt' as const,
      },
    ];
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Existing chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
          approvalMode: 'auto',
          sessionApprovalRules,
        },
      ]),
    );

    await sendWorktreeChatMessage({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      userMessageId: 'message-1',
      text: 'Resume safely',
      initiationSource: 'automation',
    });

    expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalMode: 'auto',
        sessionApprovalRules,
      }),
    );
  });

  it('captures host-resolved approval state in a Portal queue request', async () => {
    const sessionApprovalRules = [
      {
        id: 'deny-env',
        behavior: 'deny' as const,
        target: { kind: 'file-write' as const, path: '.env' },
        createdAt: '2026-07-23T00:00:00.000Z',
        origin: 'prompt' as const,
      },
    ];
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Existing chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
          approvalMode: 'auto',
          sessionApprovalRules,
        },
      ]),
    );
    const submit = jest
      .spyOn(getChatQueueService(), 'submit')
      .mockResolvedValue();

    try {
      await sendWorktreeChatMessage({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Queue from Portal',
      });

      expect(submit).toHaveBeenCalledWith(
        expect.objectContaining({
          approvalMode: 'auto',
          sessionApprovalRules,
        }),
        'portal',
      );
    } finally {
      submit.mockRestore();
    }
  });

  it('resolves and persists the approval default for a new Portal chat', async () => {
    mockedReadChatTabsFile.mockResolvedValue(chatTabsFile([]));
    mockedResolvePersistedApprovalMode.mockResolvedValueOnce('auto');

    await dispatchHostQueuedWorktreeChatMessage(
      {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'new-chat',
        userMessageId: 'message-1',
        text: 'Start a Portal chat',
      },
      'portal',
      false,
    );

    expect(mockedResolvePersistedApprovalMode).toHaveBeenCalledWith(
      'workspace-1',
      'worktree-1',
      undefined,
    );
    expect(mockedWriteChatTabsFile).toHaveBeenCalledWith(
      'workspace-1',
      'worktree-1',
      expect.objectContaining({
        tabs: [expect.objectContaining({ approvalMode: 'auto' })],
      }),
    );
    expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({ approvalMode: 'auto' }),
    );
  });

  it('keeps the usage-limited registry entry when dispatch fails', async () => {
    mockedDispatchWorktreeChatTurn.mockRejectedValueOnce(
      new Error('dispatch failed'),
    );
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Existing chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
        },
      ]),
    );

    await expect(
      sendWorktreeChatMessage({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Continue at reset',
        initiationSource: 'automation',
      }),
    ).rejects.toThrow('dispatch failed');

    expect(mockedClearUsageLimitedChat).not.toHaveBeenCalled();
    for (const [, channel, payload] of mockedSendToWindow.mock.calls) {
      if (channel === IPC_CHANNELS.chatEvent) {
        expect(payload).not.toMatchObject({
          data: {
            type: CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE,
          },
        });
      }
    }
  });

  it('confirms renderer portal prompts only after provider dispatch accepts them', async () => {
    mockedDispatchWorktreeChatTurn.mockImplementationOnce((options) => {
      options.onTurnAccepted?.();
      return Promise.resolve();
    });
    let persistedTabsFile = chatTabsFile([
      {
        id: 'chat-1',
        title: 'Existing chat',
        createdAt: '2026-05-28T11:00:00.000Z',
        kind: 'chat',
        messages: [],
        llmProviderUsageLimitBanner: {
          provider: 'claude',
          message: 'Usage limit reached',
          detectedAt: 1,
          dismissKey: 'limit-1',
        },
        dismissedLlmProviderUsageLimitBannerKey: 'limit-1',
      },
    ]);
    mockedReadChatTabsFile.mockImplementation(() =>
      Promise.resolve(persistedTabsFile),
    );
    mockedWriteChatTabsFile.mockImplementation(
      (_projectId, _worktreeId, tabsFile) => {
        persistedTabsFile = tabsFile;
        return Promise.resolve();
      },
    );

    await sendWorktreeChatMessage({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      userMessageId: 'message-1',
      text: 'Continue from portal',
      providerType: 'claude',
    });

    expect(persistedTabsFile.tabs[0]).not.toHaveProperty(
      'llmProviderUsageLimitBanner',
    );
    expect(persistedTabsFile.tabs[0]).not.toHaveProperty(
      'dismissedLlmProviderUsageLimitBannerKey',
    );

    expect(mockedSendToWindow).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.chatEvent,
      {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        data: {
          type: 'canopy_user_prompt',
          original_text: 'Continue from portal',
          canopy_turn_user_message_id: 'message-1',
          provider: 'claude',
          canopy_persisted_messages: [
            expect.objectContaining({
              id: 'message-1',
              role: 'user',
              blocks: [{ type: 'text', text: 'Continue from portal' }],
            }),
          ],
        },
      },
    );
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.chatEvent,
      {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        data: {
          type: CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE,
          canopy_turn_user_message_id: 'message-1',
        },
      },
    );
  });

  it('emits acceptance after its durable commit and preserves a newer recovery banner', async () => {
    let persistedTabsFile = chatTabsFile([
      {
        id: 'chat-1',
        title: 'Existing chat',
        createdAt: '2026-05-28T11:00:00.000Z',
        kind: 'chat',
        messages: [],
        llmProviderUsageLimitBanner: {
          provider: 'claude',
          message: 'First usage limit',
          detectedAt: 1,
          dismissKey: 'limit-1',
        },
      },
    ]);
    mockedReadChatTabsFile.mockImplementation(() =>
      Promise.resolve(persistedTabsFile),
    );
    mockedWriteChatTabsFile.mockImplementation(
      (_projectId, _worktreeId, tabsFile) => {
        persistedTabsFile = tabsFile;
        return Promise.resolve();
      },
    );
    mockedDispatchWorktreeChatTurn.mockImplementationOnce((options) => {
      options.onTurnAccepted?.();
      expect(
        mockedSendToWindow.mock.calls.some(
          ([, channel, payload]) =>
            channel === IPC_CHANNELS.chatEvent &&
            isRecord(payload) &&
            isRecord(payload.data) &&
            payload.data.type === CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE,
        ),
      ).toBe(false);
      persistedTabsFile = {
        ...persistedTabsFile,
        tabs: persistedTabsFile.tabs.map((tab) =>
          tab.id === 'chat-1'
            ? {
                ...tab,
                llmProviderUsageLimitBanner: {
                  provider: 'claude',
                  message: 'Newer usage limit',
                  detectedAt: 2,
                  dismissKey: 'limit-2',
                },
              }
            : tab,
        ),
      };
      return Promise.resolve();
    });

    await sendWorktreeChatMessage({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      userMessageId: 'message-1',
      text: 'Continue from portal',
      providerType: 'claude',
    });

    expect(mockChatStateService.ingestProviderEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        mutationId: 'chat-1:message-1:accepted',
        data: {
          type: CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE,
          canopy_turn_user_message_id: 'message-1',
        },
      }),
    );
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.chatEvent,
      expect.objectContaining({
        data: {
          type: CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE,
          canopy_turn_user_message_id: 'message-1',
        },
      }),
    );

    expect(persistedTabsFile.tabs[0]?.llmProviderUsageLimitBanner).toEqual({
      provider: 'claude',
      message: 'Newer usage limit',
      detectedAt: 2,
      dismissKey: 'limit-2',
    });
  });

  it('does not forward caller-provided startsNewTrackedChat into worktree turn dispatch', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Existing chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
        },
      ]),
    );

    await sendWorktreeChatMessage({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      userMessageId: 'message-1',
      text: 'Continue',
      startsNewTrackedChat: true,
    });

    expect(mockedDispatchWorktreeChatTurn).toHaveBeenCalledWith(
      expect.not.objectContaining({
        startsNewTrackedChat: true,
      }),
    );
  });

  it('projects conversational roles from authoritative descriptors and legacy inline rows', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'modern',
          title: 'Modern',
          createdAt: '2026-10-01T00:00:00Z',
          messages: [
            { id: 'stale', role: 'assistant', timestamp: 1, blocks: [] },
          ],
          transcript: {
            format: 'complete-message-jsonl-v1',
            committedMessageCount: 1,
            committedByteLength: 10,
            transcriptRevision: 1,
            hasActiveSidecar: false,
            messageCount: 1,
            lastMessageRole: 'user',
          },
        },
        {
          id: 'legacy',
          title: 'Legacy',
          createdAt: '2026-10-01T00:00:00Z',
          messages: [
            { id: 'assistant', role: 'assistant', timestamp: 1, blocks: [] },
            { id: 'system', role: 'system', timestamp: 2, blocks: [] },
          ],
        },
        {
          id: 'system-only',
          title: 'System',
          createdAt: '2026-10-01T00:00:00Z',
          messages: [
            { id: 'system-only', role: 'system', timestamp: 1, blocks: [] },
          ],
        },
      ]),
    );
    const summaries = await listWorktreeChatSummaries({
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-1',
    });
    expect(summaries.map((summary) => summary.lastMessageRole)).toEqual([
      'user',
      'assistant',
      undefined,
    ]);
  });

  it('projects how each tab latest accepted turn ended', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Stopped',
          createdAt: '2026-09-05T00:00:00Z',
          messages: [],
          lastAcceptedUserMessageId: 'user-1',
          turnEnds: { 'user-1': { outcome: 'cancelled', endedAt: 0 } },
        },
        {
          id: 'chat-2',
          title: 'Never ran',
          createdAt: '2026-09-05T00:00:00Z',
          messages: [],
        },
      ]),
    );
    const summaries = await listWorktreeChatSummaries({
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-1',
    });
    expect(summaries.map((summary) => summary.lastTurnEnd)).toEqual([
      {
        userMessageId: 'user-1',
        outcome: 'cancelled',
        endedAt: '1970-01-01T00:00:00.000Z',
      },
      undefined,
    ]);
  });

  it('projects each tab unread flag independently for remote viewing', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Unread',
          createdAt: '2026-09-05T00:00:00Z',
          messages: [],
          unread: true,
        },
        {
          id: 'chat-2',
          title: 'Read',
          createdAt: '2026-09-05T00:00:00Z',
          messages: [],
          unread: false,
        },
      ]),
    );
    const summaries = await listWorktreeChatSummaries({
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-1',
    });
    expect(
      summaries.map((summary) => [summary.chatId, summary.hasUnread]),
    ).toEqual([
      ['chat-1', true],
      ['chat-2', false],
    ]);
  });

  it('projects custom titles alongside generated names and accepts older tabs without them', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Original',
          description: 'Generated',
          customTitle: 'My chat',
          createdAt: '2026-09-05T00:00:00Z',
          messages: [],
        },
        {
          id: 'chat-2',
          title: 'Older chat',
          createdAt: '2026-09-05T00:00:00Z',
          messages: [],
        },
      ]),
    );
    const summaries = await listWorktreeChatSummaries({
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-1',
    });
    expect(summaries[0]).toMatchObject({
      title: 'Original',
      description: 'Generated',
      customTitle: 'My chat',
    });
    expect(summaries[1]).toMatchObject({ title: 'Older chat' });
    expect(summaries[1]?.customTitle).toBeUndefined();
  });

  it('maps the tab model to its human-friendly display name in summaries', async () => {
    initClaudeModels([
      {
        id: 'claude-haiku-4-5-20251001',
        label: 'Haiku 4.5',
      },
    ]);
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          model: 'claude-haiku-4-5-20251001',
          modelSelectionMode: 'auto',
          messages: [],
        },
      ]),
    );

    const summaries = await listWorktreeChatSummaries({
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-1',
    });
    // The portal composer renders this string verbatim; it must be the
    // display name, not the raw model id.
    expect(summaries[0]?.modelLabel).toBe('Haiku 4.5');
    expect(summaries[0]?.modelSelectionMode).toBe('auto');
  });

  it('projects legacy bundleIds as canonical collectionIds in Portal summaries', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Legacy plugins',
          createdAt: '2026-08-21T00:00:00.000Z',
          kind: 'chat',
          messages: [],
          pluginSelections: {
            collectionIds: [],
            bundleIds: ['legacy-collection'],
            skillRefs: [],
            pluginRefs: [],
          },
        },
      ]),
    );

    const [summary] = await listWorktreeChatSummaries({
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-1',
    });

    expect(summary?.pluginSelections).toEqual({
      collectionIds: ['legacy-collection'],
      skillCount: 0,
      pluginCount: 0,
      mcpServerCount: 0,
    });
    expect(summary?.pluginSelectionsDetail).toEqual({
      collectionIds: ['legacy-collection'],
      skillRefs: [],
      pluginRefs: [],
    });
  });

  it("describes Agents on the default model by each workspace's own default", async () => {
    const build = jest.spyOn(
      ModelCatalogProjection,
      'buildProjectedModelCatalog',
    );
    try {
      mockedReadChatTabsFile.mockResolvedValue(
        chatTabsFile([
          {
            id: 'chat-1',
            title: 'Chat',
            createdAt: '2026-10-14T00:00:00.000Z',
            kind: 'chat',
            messages: [],
          },
        ]),
      );

      await listWorktreeChatSummaries({
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-1',
      });
      await listWorktreeChatSummaries({
        workspaceId: 'workspace-2',
        worktreeId: 'worktree-1',
      });

      expect(
        build.mock.calls.map(([, options]) => options?.agentDefaultModel),
      ).toEqual(['default-for-workspace-1', 'default-for-workspace-2']);
    } finally {
      build.mockRestore();
    }
  });

  it('projects turnActive when the chat has an in-flight turn', async () => {
    // Without this the browser only learns a turn is running from a live
    // `turn_timer` frame, so a portal attaching MID-TURN renders the chat as
    // idle: no working indicator, no end-of-turn timer (CAN-2525).
    const now = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      mockedGetActiveSessionInfos.mockReturnValueOnce([
        sessionInfo({
          chatId: 'chat-1',
          turnActive: true,
          turnStartedAt: now - 1_000,
          turnElapsedMs: 550_000,
        }),
      ]);
      mockedReadChatTabsFile.mockResolvedValue(
        chatTabsFile([
          {
            id: 'chat-1',
            title: 'Running chat',
            createdAt: '2026-05-28T11:00:00.000Z',
            kind: 'chat',
            messages: [],
          },
        ]),
      );

      const [summary] = await listWorktreeChatSummaries({
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-1',
      });

      expect(summary?.turnActive).toBe(true);
      expect(summary?.turnElapsedMs).toBe(550_000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('projects turnActive false for an idle between-turn session', async () => {
    // A live session that is NOT mid-turn must not raise the indicator: the
    // session manager keeps idle sessions registered between turns.
    mockedGetActiveSessionInfos.mockReturnValueOnce([
      sessionInfo({ chatId: 'chat-1', turnActive: false }),
    ]);
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Idle chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
        },
      ]),
    );

    const [summary] = await listWorktreeChatSummaries({
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-1',
    });

    expect(summary?.turnActive).toBe(false);
  });

  it("does not attribute another chat's active turn to this chat", async () => {
    mockedGetActiveSessionInfos.mockReturnValueOnce([
      sessionInfo({ chatId: 'chat-other', turnActive: true }),
    ]);
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Quiet chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
        },
      ]),
    );

    const [summary] = await listWorktreeChatSummaries({
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-1',
    });

    expect(summary?.turnActive).toBe(false);
  });

  it.each([
    [{ speed: 'ultrafast', fastMode: false }, 'ultrafast', false],
    [{ fastMode: true }, 'fast', true],
    [{ thinkingLevel: 'high' }, undefined, undefined],
  ] as const)(
    'projects the exact Codex speed for %j in worktree chat summaries',
    async (modelConfig, speed, fastMode) => {
      mockedReadChatTabsFile.mockResolvedValue(
        chatTabsFile([
          {
            id: 'chat-1',
            title: 'Codex chat',
            createdAt: '2026-05-28T11:00:00.000Z',
            kind: 'chat',
            messages: [],
            providerType: 'codex',
            modelConfig,
          },
        ]),
      );

      const [summary] = await listWorktreeChatSummaries({
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-1',
      });

      expect(summary?.speed).toBe(speed);
      expect(summary?.fastMode).toBe(fastMode);
    },
  );

  it.each(['pending', 'cleared'])(
    'projects a bounded OpenCode review identity and explicit removal: %s',
    async (mode) => {
      mockedReadChatTabsFile.mockResolvedValue(
        chatTabsFile([
          {
            id: 'chat-1',
            title: 'Plan',
            createdAt: '2026-10-12T11:00:00.000Z',
            kind: 'chat',
            messages: [],
            providerType: 'opencode',
            planMode: true,
            trackedPlanSource: 'opencode',
            trackedPlanId: 'plan-1',
            trackedPlanReviewStatus: 'pending',
            latestRevisionNumber: 2,
            ...(mode === 'pending'
              ? {
                  pendingPlanExitRequestId: 'review-1',
                  pendingPlanExit: {
                    source: 'opencode',
                    plan: 'Private plan contents',
                    filePath: '/host/private',
                  },
                }
              : {}),
          },
        ]),
      );
      const [summary] = await listWorktreeChatSummaries({
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-1',
      });
      expect(summary?.planReview).toEqual(
        mode === 'pending'
          ? {
              source: 'opencode',
              requestId: 'review-1',
              planId: 'plan-1',
              revisionNumber: 2,
            }
          : null,
      );
    },
  );

  it('projects only the context disclosure of a fork, then clears it', async () => {
    for (const context of ['visible-transcript', undefined] as const) {
      mockedReadChatTabsFile.mockResolvedValue(
        chatTabsFile([
          {
            id: 'chat-1',
            title: 'Fork',
            createdAt: '2026-10-12T00:00:00.000Z',
            kind: 'chat',
            messages: [],
            forkedFrom: {
              projectId: 'private-source',
              worktreeId: 'private-worktree',
              chatId: 'private-chat',
              modelContext: context,
            },
          },
        ]),
      );
      const [summary] = await listWorktreeChatSummaries({
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-1',
      });
      expect(summary?.forkContext).toBe(context ?? null);
      expect(JSON.stringify(summary)).not.toContain('private-source');
    }
  });

  it('projects the persisted message count in worktree chat summaries', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Existing conversation',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          messages: [
            {
              id: 'message-1',
              role: 'user',
              timestamp: 1753700000000,
              blocks: [{ type: 'text', text: 'Earlier prompt' }],
            },
          ],
        },
      ]),
    );

    const [summary] = await listWorktreeChatSummaries({
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-1',
    });

    expect(summary?.messageCount).toBe(1);
  });

  it('projects only the awaiting Claude questions owned by each chat', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile(
        [
          {
            id: 'chat-1',
            title: 'First chat',
            createdAt: '2026-05-28T11:00:00.000Z',
            kind: 'chat',
            messages: [],
          },
          {
            id: 'chat-2',
            title: 'Second chat',
            createdAt: '2026-05-28T11:01:00.000Z',
            kind: 'chat',
            messages: [],
          },
        ],
        [
          {
            requestId: 'claude-request-1',
            chatId: 'chat-1',
            questions: [
              {
                header: 'Scope',
                question: 'Which scope?',
                options: ['Focused', 'Broad'],
              },
            ],
          },
          {
            requestId: 'claude-request-2',
            chatId: 'chat-2',
            questions: [
              {
                question: 'Continue?',
                options: ['Yes', 'No'],
              },
            ],
          },
        ],
      ),
    );

    const summaries = await listWorktreeChatSummaries({
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-1',
    });

    expect(summaries[0]?.pendingQuestions).toEqual([
      {
        requestId: 'claude-request-1',
        questions: [
          {
            header: 'Scope',
            question: 'Which scope?',
            options: ['Focused', 'Broad'],
          },
        ],
        answered: false,
      },
    ]);
    expect(summaries[0]?.pendingQuestions?.[0]).not.toHaveProperty('toolUseId');
    expect(summaries[0]?.pendingQuestions?.[0]).not.toHaveProperty('answers');
    expect(
      summaries[1]?.pendingQuestions?.map((entry) => entry.requestId),
    ).toEqual(['claude-request-2']);
  });

  it('preserves the exact Codex tool-use id in projected question state', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile(
        [
          {
            id: 'chat-1',
            title: 'Codex chat',
            createdAt: '2026-05-28T11:00:00.000Z',
            kind: 'chat',
            messages: [],
          },
        ],
        [
          {
            requestId: 'codex-request-1',
            toolUseId: 'codex-call-42',
            chatId: 'chat-1',
            questions: [
              {
                question: 'Choose a target',
                options: ['Desktop', 'Web'],
              },
            ],
          },
        ],
      ),
    );

    const [summary] = await listWorktreeChatSummaries({
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-1',
    });

    expect(summary?.pendingQuestions?.[0]?.toolUseId).toBe('codex-call-42');
  });

  it('projects answered questions with display-safe redacted answers', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile(
        [
          {
            id: 'chat-1',
            title: 'Answered chat',
            createdAt: '2026-05-28T11:00:00.000Z',
            kind: 'chat',
            messages: [],
          },
        ],
        [
          {
            requestId: 'secret-request-1',
            chatId: 'chat-1',
            questions: [
              {
                id: 'token',
                question: 'Provide the token',
                options: [],
                allowOther: true,
                secret: true,
              },
            ],
            answers: [
              {
                questionId: 'token',
                question: 'Provide the token',
                selectedOptions: [],
                freeformText: '[hidden]',
              },
            ],
            answeredAt: 1,
          },
        ],
      ),
    );

    const [summary] = await listWorktreeChatSummaries({
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-1',
    });

    expect(summary?.pendingQuestions).toEqual([
      expect.objectContaining({
        requestId: 'secret-request-1',
        answered: true,
        answers: [
          {
            questionId: 'token',
            question: 'Provide the token',
            selectedOptions: [],
            freeformText: '[hidden]',
          },
        ],
      }),
    ]);
  });

  it('projects an explicit empty array after persisted questions are removed', async () => {
    const tab: PersistedChatTab = {
      id: 'chat-1',
      title: 'Chat',
      createdAt: '2026-05-28T11:00:00.000Z',
      kind: 'chat',
      messages: [],
    };
    mockedReadChatTabsFile
      .mockResolvedValueOnce(
        chatTabsFile(
          [tab],
          [
            {
              requestId: 'request-to-clear',
              chatId: 'chat-1',
              questions: [{ question: 'Continue?', options: ['Yes'] }],
            },
          ],
        ),
      )
      .mockResolvedValueOnce(chatTabsFile([tab]));

    const [before] = await listWorktreeChatSummaries({
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-1',
    });
    const [after] = await listWorktreeChatSummaries({
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-1',
    });

    expect(before?.pendingQuestions).toHaveLength(1);
    expect(after).toHaveProperty('pendingQuestions', []);
  });

  it('omits question state from streaming-only summary deltas', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile(
        [
          {
            id: 'chat-1',
            title: 'Chat',
            createdAt: '2026-05-28T11:00:00.000Z',
            kind: 'chat',
            messages: [],
          },
        ],
        [
          {
            requestId: 'question-request-1',
            chatId: 'chat-1',
            questions: [{ question: 'Continue?', options: ['Yes'] }],
          },
        ],
      ),
    );

    await dispatchHostQueuedWorktreeChatMessage(
      {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Continue',
      },
      'portal',
      false,
    );

    const summaryDelta = mockedCreatePortalEvent.mock.calls.find(
      ([type]) => type === 'portal.state.delta',
    )?.[1] as
      | { entities?: Array<{ payload?: Record<string, unknown> }> }
      | undefined;
    expect(summaryDelta?.entities?.[0]?.payload).not.toHaveProperty(
      'pendingQuestions',
    );
  });

  it('projects whether queued messages have attachments', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
        },
      ]),
    );
    const target = {
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
    };
    await getChatQueueService().submit(
      { ...target, text: 'active', userMessageId: 'active-1' },
      'desktop',
    );
    await getChatQueueService().submit(
      {
        ...target,
        text: 'attached follow-up',
        userMessageId: 'queued-1',
        attachmentPaths: ['/tmp/screenshot.png'],
      },
      'portal',
    );

    const summaries = await listWorktreeChatSummaries({
      workspaceId: target.projectId,
      worktreeId: target.worktreeId,
    });

    expect(summaries[0]?.queuedMessages).toEqual([
      expect.objectContaining({
        text: 'attached follow-up',
        supersedesUserMessageId: 'queued-1',
        hasAttachments: true,
        attachmentEditsPreservePayload: true,
        promptSource: 'human',
      }),
    ]);
  });

  it('keeps the sender of a queued agent message in the Portal summary', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-1',
          title: 'Chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
        },
      ]),
    );
    const agentSent = {
      sender: {
        kind: 'project' as const,
        projectType: 'code' as const,
        projectId: 'source-project',
        taskId: 'source-task',
        chatId: 'source-chat',
      },
      chatTitle: 'Origin',
      projectLabel: 'Source',
    };
    const snapshots = jest
      .spyOn(getChatQueueService(), 'getWorktreeSnapshots')
      .mockReturnValue([
        {
          projectId: 'workspace-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          turnActive: true,
          queue: [
            {
              id: 'queued-agent',
              text: 'From another chat',
              origin: 'desktop',
              enqueuedAtMs: 1,
              agentSent,
            },
          ],
        },
      ]);
    try {
      const summaries = await listWorktreeChatSummaries({
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-1',
      });
      expect(summaries[0]?.queuedMessages).toEqual([
        expect.objectContaining({ id: 'queued-agent', agentSent }),
      ]);
    } finally {
      snapshots.mockRestore();
    }
  });

  it('projects a stable 0-based order index matching chat-tab position (CAN-1239)', async () => {
    // The portal orders its tab bar by `order`; it must mirror the desktop's tab
    // position and never depend on message recency.
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-a',
          title: 'A',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          messages: [],
        },
        {
          id: 'chat-b',
          title: 'B',
          createdAt: '2026-05-28T11:01:00.000Z',
          kind: 'chat',
          // A newer last message must NOT change this tab's order.
          messages: [
            {
              id: 'm1',
              role: 'user',
              timestamp: 9_999_999_999_999,
              blocks: [{ type: 'text', text: 'hi' }],
            },
          ],
        },
        {
          id: 'chat-c',
          title: 'C',
          createdAt: '2026-05-28T11:02:00.000Z',
          kind: 'chat',
          messages: [],
        },
      ]),
    );

    const summaries = await listWorktreeChatSummaries({
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-1',
    });
    expect(summaries.map((s) => [s.chatId, s.order])).toEqual([
      ['chat-a', 0],
      ['chat-b', 1],
      ['chat-c', 2],
    ]);
  });

  it('projects CUA REPL calls into the dedicated Computer Use summary', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-computer-use',
          title: 'Computer Use',
          createdAt: '2026-09-15T12:00:00.000Z',
          kind: 'chat',
          messages: [
            {
              id: 'user-1',
              role: 'user',
              timestamp: 1,
              blocks: [{ type: 'text', text: 'Inspect the UI.' }],
            },
            {
              id: 'assistant-tools',
              role: 'assistant',
              timestamp: 2,
              blocks: [
                {
                  type: 'tool_use',
                  toolUseId: 'js',
                  toolName: 'mcp__cua_repl__js',
                  input: '{}',
                },
                {
                  type: 'tool_use',
                  toolUseId: 'reset',
                  toolName: 'mcp__cua_repl__js_reset',
                  input: '{}',
                },
              ],
            },
            {
              id: 'assistant-final',
              role: 'assistant',
              timestamp: 3,
              blocks: [{ type: 'text', text: 'Done.' }],
            },
          ],
        },
      ]),
    );

    const summaries = await listWorktreeChatSummaries({
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-1',
    });

    expect(summaries[0]?.chatTurnGroups?.[0]?.summary).toEqual({
      computerUseCount: 2,
    });
  });

  it('caps chatTurnGroups to the portal transcript window for huge histories', async () => {
    // Real worktrees carry thousands of messages (a 44MB chats file was
    // observed in the field). Turn groups for messages the portal transcript
    // cache will never hold (it keeps the last
    // PORTAL_CHAT_TRANSCRIPT_MESSAGE_LIMIT) are dead weight that pushed
    // worktree snapshots past the 1MiB event cap, so the whole snapshot was
    // dropped and the browser showed an empty worktree.
    const messages = [];
    for (let turn = 0; turn < 150; turn += 1) {
      messages.push({
        id: `user-${turn}`,
        role: 'user' as const,
        timestamp: 1_000 + turn * 10,
        blocks: [{ type: 'text' as const, text: `prompt ${turn}` }],
      });
      messages.push({
        id: `assistant-${turn}`,
        role: 'assistant' as const,
        timestamp: 1_001 + turn * 10,
        blocks: [{ type: 'text' as const, text: `reply ${turn}` }],
      });
    }
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        {
          id: 'chat-big',
          title: 'Big chat',
          createdAt: '2026-05-28T11:00:00.000Z',
          kind: 'chat',
          messages,
        },
      ]),
    );

    const summaries = await listWorktreeChatSummaries({
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-1',
    });
    const groups = summaries[0]?.chatTurnGroups ?? [];
    expect(groups.length).toBeGreaterThan(0);

    const referencedIds = groups.flatMap((group) => [
      group.userMessageId,
      ...group.intermediateMessageIds,
      ...group.finalMessageIds,
    ]);
    // Every referenced message must fall inside the transcript window the
    // portal cache actually holds…
    const windowIds = new Set(
      messages
        .slice(-PORTAL_CHAT_TRANSCRIPT_MESSAGE_LIMIT)
        .map((message) => message.id),
    );
    for (const id of referencedIds) {
      expect(windowIds.has(id)).toBe(true);
    }
    // …and the total stays bounded by that window, no matter how long the
    // history is.
    expect(referencedIds.length).toBeLessThanOrEqual(
      PORTAL_CHAT_TRANSCRIPT_MESSAGE_LIMIT,
    );
  });
});

describe('isReusableEmptyChatTab', () => {
  beforeEach(() => {
    jest
      .spyOn(claudeTuiChats, 'getEffectiveClaudeChatInterfaceMode')
      .mockImplementation((mode) => mode ?? 'canopy');
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  const descriptor: NonNullable<PersistedChatTab['transcript']> = {
    format: 'complete-message-jsonl-v1',
    committedMessageCount: 0,
    committedByteLength: 0,
    transcriptRevision: 1,
    hasActiveSidecar: false,
  };
  function emptyTab(
    overrides: Partial<PersistedChatTab> = {},
  ): PersistedChatTab {
    return {
      id: 'empty',
      title: 'Empty',
      createdAt: '2026-10-17T00:00:00.000Z',
      messages: [],
      ...overrides,
    };
  }
  it('retains the send empty-tab policy for missing kind and native interface', () => {
    expect(isReusableEmptyChatTab(emptyTab())).toBe(true);
    expect(
      isReusableEmptyChatTab(
        emptyTab({ kind: 'chat', interfaceMode: 'canopy' }),
      ),
    ).toBe(true);
  });
  it('uses canonical transcript counts before unloaded message arrays', () => {
    expect(
      isReusableEmptyChatTab(
        emptyTab({ transcript: { ...descriptor, messageCount: 2 } }),
      ),
    ).toBe(false);
    expect(
      isReusableEmptyChatTab(
        emptyTab({ transcript: { ...descriptor, committedMessageCount: 2 } }),
      ),
    ).toBe(false);
    expect(
      isReusableEmptyChatTab(
        emptyTab({
          transcript: {
            ...descriptor,
            messageCount: 0,
            committedMessageCount: 2,
          },
        }),
      ),
    ).toBe(true);
  });
  it('never reuses file or terminal-backed tabs', () => {
    expect(isReusableEmptyChatTab(emptyTab({ kind: 'file' }))).toBe(false);
    expect(
      isReusableEmptyChatTab(emptyTab({ interfaceMode: 'claude-code' })),
    ).toBe(false);
    expect(isReusableEmptyChatTab(emptyTab({ interfaceMode: 'auto' }))).toBe(
      false,
    );
  });
});

describe('resolveWorktreeChatApprovalPolicy', () => {
  const target = { projectId: 'p1', worktreeId: 'w1', chatId: 'chat-1' };
  const withTab = (tab: Partial<PersistedChatTab>): void => {
    mockedReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat-1',
      tabs: [
        { id: 'chat-1', title: 'Chat', createdAt: '', messages: [], ...tab },
      ],
    });
  };

  beforeEach(() => {
    clearLiveApprovalMode('p1', 'w1', 'chat-1');
    jest
      .mocked(resolvePersistedApprovalMode)
      .mockImplementation((_projectId, _worktreeId, tabMode) =>
        Promise.resolve(tabMode ?? 'full-access'),
      );
  });

  it("resolves an existing chat's tab mode", async () => {
    withTab({ approvalMode: 'auto' });
    await expect(resolveWorktreeChatApprovalPolicy(target)).resolves.toEqual({
      mode: 'auto',
      tabMode: 'auto',
      sessionRules: [],
      root: '/roots/p1/w1',
    });
  });

  it('falls back to the persisted defaults for a tab without a mode', async () => {
    withTab({});
    const resolved = await resolveWorktreeChatApprovalPolicy(target);
    expect(resolved).toMatchObject({ mode: 'full-access' });
    expect(resolved).not.toHaveProperty('tabMode');
    expect(resolvePersistedApprovalMode).toHaveBeenCalledWith(
      'p1',
      'w1',
      undefined,
    );
  });

  it('returns the session grants the chat holds', async () => {
    const grant: ApprovalRule = {
      id: 'grant-1',
      behavior: 'allow',
      target: { kind: 'command', pattern: 'npm publish' },
      createdAt: '2026-01-01T00:00:00.000Z',
      origin: 'prompt',
    };
    withTab({ approvalMode: 'ask', sessionApprovalRules: [grant] });
    await expect(resolveWorktreeChatApprovalPolicy(target)).resolves.toEqual({
      mode: 'ask',
      tabMode: 'ask',
      sessionRules: [grant],
      root: '/roots/p1/w1',
    });
  });

  it("resolves the chat's execution root with its selected repository, or none when unresolvable", async () => {
    withTab({ approvalMode: 'auto', selectedRepoId: 'repo-2' });
    await expect(
      resolveWorktreeChatApprovalPolicy(target),
    ).resolves.toMatchObject({
      root: '/roots/p1/w1/repo-2',
      selectedRepoId: 'repo-2',
    });
    mockResolveWorktreeCwd.mockImplementationOnce(() => {
      throw new Error('worktree removed');
    });
    await expect(
      resolveWorktreeChatApprovalPolicy(target),
    ).resolves.not.toHaveProperty('root');
  });

  it("clamps the chat to its live turn's stricter mode", async () => {
    withTab({ approvalMode: 'full-access' });
    setLiveApprovalMode('p1', 'w1', 'chat-1', 'ask');
    await expect(
      resolveWorktreeChatApprovalPolicy(target),
    ).resolves.toMatchObject({ mode: 'ask' });
  });
});
