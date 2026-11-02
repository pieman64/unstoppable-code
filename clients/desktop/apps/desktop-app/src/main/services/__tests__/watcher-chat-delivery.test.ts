import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import type {
  ChatRuntimeState,
  ChatSendMessageRequest,
  PersistedChatTab,
  PersistedHostQueuedMessage,
} from '@canopy/desktop-shared/types';
import type { ChatScopeKey } from '../chat-state-contracts';
import type * as ChatServiceModule from '../chat-service';
import type * as ChatStateServiceModule from '../chat-state-service';
import type * as UsageLimitedChatsModule from '../../lib/usage-limited-chats-registry';
import {
  deliverGeneratedWatcherMessageToChat,
  deliverWatcherMessageToChat,
  type WatcherChatDelivery,
} from '../watcher-chat-delivery';

const mockRunWithScopeActivity = jest.fn(
  async <T>(_scope: ChatScopeKey, operation: () => Promise<T>): Promise<T> =>
    operation(),
);
const mockRecoverHostRuntime = jest.fn<
  ReturnType<ChatStateServiceModule.ChatStateService['recoverHostRuntime']>,
  Parameters<ChatStateServiceModule.ChatStateService['recoverHostRuntime']>
>();
const mockHasTranscriptMessage = jest.fn<
  ReturnType<ChatStateServiceModule.ChatStateService['hasTranscriptMessage']>,
  Parameters<ChatStateServiceModule.ChatStateService['hasTranscriptMessage']>
>();
const mockHasMutation = jest.fn<
  ReturnType<ChatStateServiceModule.ChatStateService['hasMutation']>,
  Parameters<ChatStateServiceModule.ChatStateService['hasMutation']>
>();
const mockBuildExistingTabDispatchOptions = jest.fn<
  ReturnType<typeof ChatServiceModule.buildExistingTabDispatchOptions>,
  Parameters<typeof ChatServiceModule.buildExistingTabDispatchOptions>
>();
const mockDispatchLocalWorktreeChatMessage = jest.fn<
  ReturnType<typeof ChatServiceModule.dispatchLocalWorktreeChatMessage>,
  Parameters<typeof ChatServiceModule.dispatchLocalWorktreeChatMessage>
>();
const mockSendWorktreeChatMessage = jest.fn<
  ReturnType<typeof ChatServiceModule.sendWorktreeChatMessage>,
  Parameters<typeof ChatServiceModule.sendWorktreeChatMessage>
>();
const mockResolvePersistedApprovalMode = jest.fn();
const mockInvalidateForNewTurn = jest.fn();
const mockClearUsageLimitedChat = jest
  .fn<
    ReturnType<typeof UsageLimitedChatsModule.clearUsageLimitedChat>,
    Parameters<typeof UsageLimitedChatsModule.clearUsageLimitedChat>
  >()
  .mockResolvedValue(undefined);

jest.mock('../chat-state-service', () => ({
  getChatStateService: (): {
    runWithScopeActivity: typeof mockRunWithScopeActivity;
    recoverHostRuntime: typeof mockRecoverHostRuntime;
    hasTranscriptMessage: typeof mockHasTranscriptMessage;
    hasMutation: typeof mockHasMutation;
  } => ({
    runWithScopeActivity: mockRunWithScopeActivity,
    recoverHostRuntime: mockRecoverHostRuntime,
    hasTranscriptMessage: mockHasTranscriptMessage,
    hasMutation: mockHasMutation,
  }),
}));
jest.mock('../chat-service', () => ({
  buildExistingTabDispatchOptions: mockBuildExistingTabDispatchOptions,
  dispatchLocalWorktreeChatMessage: mockDispatchLocalWorktreeChatMessage,
  sendWorktreeChatMessage: mockSendWorktreeChatMessage,
  ExistingTabDispatchTargetNotFoundError: class extends Error {},
}));
jest.mock('../../lib/approval-mode-resolution', () => ({
  resolvePersistedApprovalMode: mockResolvePersistedApprovalMode,
}));
jest.mock('../stopped-turn-resume-service', () => ({
  getStoppedTurnResumeService: (): {
    invalidateForNewTurn: typeof mockInvalidateForNewTurn;
  } => ({
    invalidateForNewTurn: mockInvalidateForNewTurn,
  }),
}));
jest.mock('../../lib/usage-limited-chats-registry', () => ({
  clearUsageLimitedChat: mockClearUsageLimitedChat,
}));
jest.mock('../../lib/claude-tui-chats', () => ({
  getEffectiveClaudeChatInterfaceMode: (mode: string | undefined): string =>
    mode ?? 'canopy',
}));

const SCOPE: ChatScopeKey = {
  projectId: 'workspace-1',
  worktreeId: 'worktree-1',
};

function persistedTab(
  overrides: Partial<PersistedChatTab> = {},
): PersistedChatTab {
  return {
    id: 'chat-1',
    title: 'Existing chat',
    createdAt: '2026-10-12T12:00:00.000Z',
    messages: [],
    providerType: 'codex',
    pendingSystemInstructions: [
      { id: 'instruction-1', text: 'Use the staged runtime context.' },
    ],
    ...overrides,
  };
}

function runtimeState(
  overrides: Partial<ChatRuntimeState> = {},
): ChatRuntimeState {
  return {
    status: 'idle',
    queuedMessageIds: [],
    ...overrides,
  };
}

function watcherDelivery(
  overrides: Partial<WatcherChatDelivery> = {},
): WatcherChatDelivery {
  return {
    ...SCOPE,
    chatId: 'chat-1',
    watcherId: 'watcher-1',
    deliveryId: 'delivery-1',
    text: 'The build finished successfully.',
    ...overrides,
  };
}

function queuedWatcher(
  request: ChatSendMessageRequest,
): PersistedHostQueuedMessage {
  return {
    id: 'queue-watcher',
    request,
    origin: 'desktop',
    enqueuedAtMs: 1_791_820_800_000,
  };
}

const CONSOLIDATED_WATCHER_DELIVERIES: ReadonlyArray<{
  deliveryId: string;
  userMessageId: string;
}> = [
  { deliveryId: 'delivery-1', userMessageId: 'watcher-delivery-1' },
  { deliveryId: 'delivery-2', userMessageId: 'watcher-delivery-2' },
  { deliveryId: 'delivery-3', userMessageId: 'watcher-delivery-3' },
];

type InputDeliveryRow = NonNullable<
  PersistedChatTab['inputDelivery']
>['rows'][number];

function consolidatedWatcherRequest(): ChatSendMessageRequest {
  return {
    ...SCOPE,
    chatId: 'chat-1',
    userMessageId: 'watcher-delivery-1',
    text: 'Three watcher events were combined.',
    hiddenContext: {
      kind: 'canopy-watcher-event',
      text: 'Combined watcher context.',
    },
    watcherFired: { kind: 'Multiple watchers fired (3)' },
    consolidatedWatcherUserMessageIds: CONSOLIDATED_WATCHER_DELIVERIES.map(
      ({ userMessageId }) => userMessageId,
    ),
  };
}

function inputDeliveryRow(
  state: InputDeliveryRow['state'],
  payload: ChatSendMessageRequest,
  payloadSnapshot: ChatSendMessageRequest = payload,
  reason?: string,
): InputDeliveryRow {
  return {
    id: payload.userMessageId,
    revision: 2,
    createdAt: 1_791_820_800_000,
    state,
    text: payload.text,
    payload,
    settingsKey: 'provider:codex',
    origin: 'desktop',
    currentAttemptId: 'steer-attempt-1',
    attempts: [
      {
        id: 'steer-attempt-1',
        generation: 'generation-1',
        provider: 'codex',
        createdAt: 1_791_820_800_000,
        payloadSnapshot,
        ...(state === 'picked-up'
          ? {
              pickedUpAt: 1_791_820_801_000,
              rootUserMessageId: 'ordinary-turn-1',
            }
          : {}),
      },
    ],
    ...(reason ? { reason } : {}),
  };
}

async function expectAllConsolidatedDeliveriesAlreadyDelivered(): Promise<void> {
  for (const { deliveryId } of CONSOLIDATED_WATCHER_DELIVERIES) {
    await expect(
      deliverWatcherMessageToChat(watcherDelivery({ deliveryId })),
    ).resolves.toBe('already_delivered');
  }
  expect(mockDispatchLocalWorktreeChatMessage).not.toHaveBeenCalled();
}

describe('watcher chat delivery', () => {
  let tab: PersistedChatTab;

  beforeEach(() => {
    jest.clearAllMocks();
    tab = persistedTab();
    mockRecoverHostRuntime.mockResolvedValue({
      tabs: [tab],
      runtimeByChatId: { [tab.id]: runtimeState() },
    });
    mockHasTranscriptMessage.mockResolvedValue(false);
    mockHasMutation.mockResolvedValue(false);
    mockBuildExistingTabDispatchOptions.mockResolvedValue({
      providerType: 'codex',
    });
    mockDispatchLocalWorktreeChatMessage.mockResolvedValue(undefined);
    mockResolvePersistedApprovalMode.mockResolvedValue('ask');
  });

  it('dedupes a notice batch represented by a queued single-authority merge (phase-02 oracle)', async () => {
    const request = {
      ...consolidatedWatcherRequest(),
      watcherDeliveryId: 'delivery-1',
      consolidatedWatcherUserMessageIds: ['notice-1', 'watcher-delivery-1'],
    };
    mockRecoverHostRuntime.mockResolvedValue({
      tabs: [tab],
      runtimeByChatId: {
        [tab.id]: runtimeState({
          queuedMessageIds: ['queue-watcher'],
          queuedMessages: [queuedWatcher(request)],
        }),
      },
    });
    await expect(
      deliverGeneratedWatcherMessageToChat({
        ...SCOPE,
        chatId: tab.id,
        userMessageId: 'notice-1',
        delegationNoticeBatchId: 'notice-1',
        text: 'Notice',
        watcherFired: { kind: 'Delegate finished' },
      }),
    ).resolves.toBe('already_delivered');
    expect(mockDispatchLocalWorktreeChatMessage).not.toHaveBeenCalled();
  });

  it.each(['missing', 'read-only'] as const)(
    'refuses a %s destination before queue admission',
    async (condition) => {
      mockRecoverHostRuntime.mockResolvedValue({
        tabs: condition === 'missing' ? [] : [persistedTab({ readOnly: true })],
        runtimeByChatId: {},
      });
      await expect(
        deliverWatcherMessageToChat(watcherDelivery()),
      ).rejects.toThrow('Watcher destination chat is not available.');
      expect(mockDispatchLocalWorktreeChatMessage).not.toHaveBeenCalled();
    },
  );

  it.each([
    'projectId',
    'worktreeId',
    'chatId',
    'watcherId',
    'deliveryId',
  ] as const)('validates %s before runtime recovery', async (id) => {
    const delivery = watcherDelivery();
    delivery[id] = '../invalid';
    await expect(deliverWatcherMessageToChat(delivery)).rejects.toThrow();
    expect(mockRecoverHostRuntime).not.toHaveBeenCalled();
    expect(mockDispatchLocalWorktreeChatMessage).not.toHaveBeenCalled();
  });

  it('refuses retired plan scopes before recovery', async () => {
    await expect(
      deliverWatcherMessageToChat(
        watcherDelivery({
          projectId: 'plan-explore-chat',
        }),
      ),
    ).rejects.toThrow('This plan chat is no longer available.');
    expect(mockRecoverHostRuntime).not.toHaveBeenCalled();
    expect(mockDispatchLocalWorktreeChatMessage).not.toHaveBeenCalled();
  });

  it('recovers the destination before dispatching a fired watcher with normalized settings', async () => {
    const delivery = watcherDelivery({
      hiddenContextText: 'The originating check was passed and verified.',
      watcherFired: { kind: 'Pipeline completion' },
    });
    Object.defineProperty(tab, 'messages', {
      get: (): never => {
        throw new Error(
          'Watcher delivery must not select transcript messages.',
        );
      },
    });

    await expect(deliverWatcherMessageToChat(delivery)).resolves.toBe(
      'submitted',
    );

    const request = mockDispatchLocalWorktreeChatMessage.mock.calls[0]?.[0];
    expect(mockRecoverHostRuntime).toHaveBeenCalledWith(SCOPE);
    expect(mockBuildExistingTabDispatchOptions).toHaveBeenCalledWith(
      SCOPE.projectId,
      SCOPE.worktreeId,
      delivery.chatId,
    );
    expect(request).toMatchObject({
      ...SCOPE,
      chatId: delivery.chatId,
      userMessageId: 'watcher-delivery-1',
      text: delivery.text,
      providerType: 'codex',
      executionHarness: 'codex',
      approvalMode: 'ask',
      pendingSystemInstructions: [
        { id: 'instruction-1', text: 'Use the staged runtime context.' },
      ],
      hiddenContext: {
        kind: 'canopy-watcher-event',
        text: delivery.hiddenContextText,
      },
      watcherFired: { kind: 'Pipeline completion' },
      initiationSource: 'user',
    });
    expect(request?.pendingSystemInstructions).not.toBe(
      tab.pendingSystemInstructions,
    );
    expect(request).not.toHaveProperty('recoverInterruptedCodexTurn');
    expect(mockSendWorktreeChatMessage).not.toHaveBeenCalled();
    expect(mockInvalidateForNewTurn).toHaveBeenCalledWith(
      { ...SCOPE, chatId: delivery.chatId },
      'watcher-delivery-1',
    );
    expect(mockClearUsageLimitedChat).toHaveBeenCalledTimes(1);
    const cleanupCall = mockClearUsageLimitedChat.mock.calls[0];
    expect(cleanupCall?.[0]).toEqual({
      ...SCOPE,
      chatId: delivery.chatId,
    });
    const usageCleanupCutoff = cleanupCall?.[1]?.onlyIfDetectedBefore;
    expect(typeof usageCleanupCutoff).toBe('number');
    if (typeof usageCleanupCutoff === 'number') {
      expect(usageCleanupCutoff).toBeGreaterThan(0);
    }
    expect(mockRecoverHostRuntime.mock.invocationCallOrder[0]).toBeLessThan(
      mockHasTranscriptMessage.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it('dispatches generated completion notices from persisted tab options without watcher authority', async () => {
    const notice = {
      ...SCOPE,
      chatId: 'chat-1',
      userMessageId: 'notice-batch-1',
      text: 'Delegate finished.',
      hiddenContextText:
        '<system_instruction>Read the result.</system_instruction>',
      watcherFired: { kind: 'Delegate finished' },
      delegationNoticeBatchId: 'notice-batch-1',
    };

    await expect(deliverGeneratedWatcherMessageToChat(notice)).resolves.toBe(
      'submitted',
    );

    expect(mockRecoverHostRuntime).toHaveBeenCalledWith(SCOPE);
    expect(mockBuildExistingTabDispatchOptions).toHaveBeenCalledWith(
      SCOPE.projectId,
      SCOPE.worktreeId,
      notice.chatId,
    );
    const request = mockDispatchLocalWorktreeChatMessage.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      ...SCOPE,
      chatId: notice.chatId,
      userMessageId: notice.userMessageId,
      delegationNoticeBatchId: notice.userMessageId,
      text: notice.text,
      providerType: 'codex',
      executionHarness: 'codex',
      hiddenContext: {
        kind: 'canopy-watcher-event',
        text: notice.hiddenContextText,
      },
      watcherFired: { kind: 'Delegate finished' },
      initiationSource: 'user',
    });
    expect(request?.delegationNoticeBatchId).toBe(request?.userMessageId);
    expect(request).not.toHaveProperty('watcherDeliveryId');
    expect(mockSendWorktreeChatMessage).not.toHaveBeenCalled();
    expect(mockInvalidateForNewTurn).toHaveBeenCalledWith(
      { ...SCOPE, chatId: notice.chatId },
      notice.userMessageId,
    );
  });

  it.each(['missing', 'read-only', 'non-chat'] as const)(
    'returns parent_gone for a generated message targeting a %s tab',
    async (condition) => {
      mockRecoverHostRuntime.mockResolvedValue({
        tabs:
          condition === 'missing'
            ? []
            : [
                persistedTab({
                  ...(condition === 'read-only'
                    ? { readOnly: true }
                    : { kind: 'file' }),
                }),
              ],
        runtimeByChatId: {},
      });

      await expect(
        deliverGeneratedWatcherMessageToChat({
          ...SCOPE,
          chatId: 'chat-1',
          userMessageId: 'notice-batch-1',
          text: 'Delegate finished.',
        }),
      ).resolves.toBe('parent_gone');
      expect(mockDispatchLocalWorktreeChatMessage).not.toHaveBeenCalled();
    },
  );

  it('returns parent_gone before runtime recovery for an unavailable scope', async () => {
    await expect(
      deliverGeneratedWatcherMessageToChat({
        projectId: 'plan-explore-chat',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        userMessageId: 'notice-batch-1',
        text: 'Delegate finished.',
      }),
    ).resolves.toBe('parent_gone');
    expect(mockRecoverHostRuntime).not.toHaveBeenCalled();
    expect(mockDispatchLocalWorktreeChatMessage).not.toHaveBeenCalled();
  });

  it('returns terminal_presenter for generated notices targeting a terminal-backed chat', async () => {
    const terminalTab = persistedTab({
      providerType: 'claude',
      interfaceMode: 'claude-code',
    });
    mockRecoverHostRuntime.mockResolvedValue({
      tabs: [terminalTab],
      runtimeByChatId: { [terminalTab.id]: runtimeState() },
    });

    await expect(
      deliverGeneratedWatcherMessageToChat({
        ...SCOPE,
        chatId: 'chat-1',
        userMessageId: 'notice-batch-1',
        text: 'Delegate finished.',
      }),
    ).resolves.toBe('terminal_presenter');
    expect(mockDispatchLocalWorktreeChatMessage).not.toHaveBeenCalled();
  });

  it('sends deleted watcher notices with a watcher context even without hidden text or fired metadata', async () => {
    const delivery = watcherDelivery({
      deliveryId: 'deleted-notice',
      text: 'This watcher destination is no longer available.',
    });

    await expect(deliverWatcherMessageToChat(delivery)).resolves.toBe(
      'submitted',
    );

    expect(mockDispatchLocalWorktreeChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessageId: 'watcher-deleted-notice',
        text: delivery.text,
        hiddenContext: { kind: 'canopy-watcher-event', text: '' },
        initiationSource: 'user',
      }),
    );
    const request = mockDispatchLocalWorktreeChatMessage.mock.calls[0]?.[0];
    expect(request).not.toHaveProperty('watcherFired');
  });

  it('returns already_delivered for a watcher id retained in the recovered queue', async () => {
    const userMessageId = 'watcher-delivery-1';
    const existingRequest: ChatSendMessageRequest = {
      ...SCOPE,
      chatId: 'chat-1',
      userMessageId: 'watcher-primary',
      text: 'Two events were combined.',
      hiddenContext: {
        kind: 'canopy-watcher-event',
        text: 'Combined context.',
      },
      watcherFired: { kind: 'Multiple watchers fired (2)' },
      consolidatedWatcherUserMessageIds: ['watcher-primary', userMessageId],
    };
    mockRecoverHostRuntime.mockResolvedValue({
      tabs: [tab],
      runtimeByChatId: {
        [tab.id]: runtimeState({
          queuedMessages: [queuedWatcher(existingRequest)],
        }),
      },
    });

    await expect(deliverWatcherMessageToChat(watcherDelivery())).resolves.toBe(
      'already_delivered',
    );

    expect(mockDispatchLocalWorktreeChatMessage).not.toHaveBeenCalled();
    expect(mockBuildExistingTabDispatchOptions).not.toHaveBeenCalled();
  });

  it('retries a delivery whose earlier dispatch was rejected before its prompt was persisted', async () => {
    // A rejected dispatch releases the queue's claim, but the committed
    // runtime keeps naming that turn. Nothing else holds the delivery id.
    mockRecoverHostRuntime.mockResolvedValue({
      tabs: [tab],
      runtimeByChatId: {
        [tab.id]: runtimeState({
          activeTurn: { userMessageId: 'watcher-delivery-1', startedAt: 1 },
        }),
      },
    });

    await expect(deliverWatcherMessageToChat(watcherDelivery())).resolves.toBe(
      'submitted',
    );
    expect(mockDispatchLocalWorktreeChatMessage).toHaveBeenCalledTimes(1);
  });

  it('retains pending system instructions when dispatch fails before acceptance', async () => {
    const delivery = watcherDelivery();
    mockDispatchLocalWorktreeChatMessage.mockRejectedValueOnce(
      new Error('queue unavailable'),
    );

    await expect(deliverWatcherMessageToChat(delivery)).rejects.toThrow(
      'queue unavailable',
    );
    const firstRequest =
      mockDispatchLocalWorktreeChatMessage.mock.calls[0]?.[0];
    expect(firstRequest?.pendingSystemInstructions).toEqual(
      tab.pendingSystemInstructions,
    );
    expect(mockClearUsageLimitedChat).not.toHaveBeenCalled();
    expect(tab.pendingSystemInstructions).toEqual([
      { id: 'instruction-1', text: 'Use the staged runtime context.' },
    ]);

    await expect(deliverWatcherMessageToChat(delivery)).resolves.toBe(
      'submitted',
    );
    expect(
      mockDispatchLocalWorktreeChatMessage.mock.calls[1]?.[0]
        .pendingSystemInstructions,
    ).toEqual(tab.pendingSystemInstructions);
  });

  it('returns already_delivered for a watcher id present in the input ledger', async () => {
    const userMessageId = 'watcher-delivery-1';
    const ledgerRequest: ChatSendMessageRequest = {
      ...SCOPE,
      chatId: 'chat-1',
      userMessageId,
      text: 'Ledgered watcher notice',
      watcherFired: { kind: 'Pipeline completion' },
    };
    const trackedTab = persistedTab({
      inputDelivery: {
        version: 1,
        epoch: 0,
        rows: [
          {
            id: 'input-row-1',
            revision: 1,
            createdAt: 1,
            state: 'queued',
            text: ledgerRequest.text,
            payload: ledgerRequest,
            settingsKey: 'provider:codex',
            origin: 'desktop',
            attempts: [],
          },
        ],
      },
    });
    mockRecoverHostRuntime.mockResolvedValue({
      tabs: [trackedTab],
      runtimeByChatId: { [trackedTab.id]: runtimeState() },
    });

    await expect(deliverWatcherMessageToChat(watcherDelivery())).resolves.toBe(
      'already_delivered',
    );

    expect(mockDispatchLocalWorktreeChatMessage).not.toHaveBeenCalled();
  });

  it('deduplicates every constituent from a combined watcher row before durable claim', async () => {
    const request = consolidatedWatcherRequest();
    mockRecoverHostRuntime.mockResolvedValue({
      tabs: [tab],
      runtimeByChatId: {
        [tab.id]: runtimeState({
          queuedMessages: [queuedWatcher(request)],
        }),
      },
    });

    await expectAllConsolidatedDeliveriesAlreadyDelivered();

    expect(mockDispatchLocalWorktreeChatMessage).not.toHaveBeenCalled();
    expect(mockBuildExistingTabDispatchOptions).not.toHaveBeenCalled();
  });

  it('deduplicates every constituent after pickup from the row and attempt snapshot', async () => {
    const request = consolidatedWatcherRequest();
    const {
      consolidatedWatcherUserMessageIds: attemptConstituentIds,
      ...requestWithoutAttemptIds
    } = request;
    const pickedUpTab = persistedTab({
      inputDelivery: {
        version: 1,
        epoch: 0,
        rows: [
          inputDeliveryRow('picked-up', requestWithoutAttemptIds, request),
        ],
      },
    });
    expect(attemptConstituentIds).toEqual(
      CONSOLIDATED_WATCHER_DELIVERIES.map(({ userMessageId }) => userMessageId),
    );
    mockRecoverHostRuntime.mockResolvedValue({
      tabs: [pickedUpTab],
      runtimeByChatId: { [pickedUpTab.id]: runtimeState() },
    });

    await expectAllConsolidatedDeliveriesAlreadyDelivered();

    expect(mockDispatchLocalWorktreeChatMessage).not.toHaveBeenCalled();
  });

  it('deduplicates every constituent from a safely restored queued ledger and runtime row', async () => {
    const request = consolidatedWatcherRequest();
    const queuedTab = persistedTab({
      inputDelivery: {
        version: 1,
        epoch: 0,
        rows: [inputDeliveryRow('queued', request)],
      },
    });
    mockRecoverHostRuntime.mockResolvedValue({
      tabs: [queuedTab],
      runtimeByChatId: { [queuedTab.id]: runtimeState() },
    });

    await expectAllConsolidatedDeliveriesAlreadyDelivered();

    const queuedRuntimeTab = persistedTab();
    mockRecoverHostRuntime.mockResolvedValue({
      tabs: [queuedRuntimeTab],
      runtimeByChatId: {
        [queuedRuntimeTab.id]: runtimeState({
          queuedMessages: [queuedWatcher(request)],
        }),
      },
    });

    await expectAllConsolidatedDeliveriesAlreadyDelivered();

    expect(mockDispatchLocalWorktreeChatMessage).not.toHaveBeenCalled();
  });

  it('deduplicates every constituent after a safe restore refusal leaves a cancelled ledger row', async () => {
    const request = consolidatedWatcherRequest();
    const refusedTab = persistedTab({
      inputDelivery: {
        version: 1,
        epoch: 0,
        rows: [
          inputDeliveryRow(
            'cancelled',
            request,
            request,
            'The active session no longer accepts steering. Falling back to ordinary delivery.',
          ),
        ],
      },
    });
    mockRecoverHostRuntime.mockResolvedValue({
      tabs: [refusedTab],
      runtimeByChatId: { [refusedTab.id]: runtimeState() },
    });

    await expectAllConsolidatedDeliveriesAlreadyDelivered();

    expect(mockDispatchLocalWorktreeChatMessage).not.toHaveBeenCalled();
  });

  it('deduplicates every constituent from the persisted ledger after a reload', async () => {
    const request = consolidatedWatcherRequest();
    const reloadedTab = structuredClone(
      persistedTab({
        inputDelivery: {
          version: 1,
          epoch: 0,
          rows: [inputDeliveryRow('uncertain', request, request)],
        },
      }),
    );
    mockRecoverHostRuntime.mockResolvedValue({
      tabs: [reloadedTab],
      runtimeByChatId: { [reloadedTab.id]: runtimeState() },
    });

    await expectAllConsolidatedDeliveriesAlreadyDelivered();

    expect(mockDispatchLocalWorktreeChatMessage).not.toHaveBeenCalled();
  });

  it.each(['transcript', 'accepted mutation'] as const)(
    'returns already_delivered when its %s receipt is present',
    async (receipt) => {
      if (receipt === 'transcript') {
        mockHasTranscriptMessage.mockResolvedValue(true);
      } else {
        mockHasMutation.mockResolvedValue(true);
      }

      await expect(
        deliverWatcherMessageToChat(watcherDelivery()),
      ).resolves.toBe('already_delivered');

      expect(mockDispatchLocalWorktreeChatMessage).not.toHaveBeenCalled();
    },
  );

  it('returns terminal_presenter for ordinary terminal-backed Claude chats', async () => {
    const terminalTab = persistedTab({
      providerType: 'claude',
      interfaceMode: 'claude-code',
    });
    mockRecoverHostRuntime.mockResolvedValue({
      tabs: [terminalTab],
      runtimeByChatId: { [terminalTab.id]: runtimeState() },
    });

    await expect(deliverWatcherMessageToChat(watcherDelivery())).resolves.toBe(
      'terminal_presenter',
    );

    expect(mockDispatchLocalWorktreeChatMessage).not.toHaveBeenCalled();
  });

  it('rejects a terminal-backed Advisor chat instead of dispatching a provider turn', async () => {
    const terminalAdvisorTab = persistedTab({
      providerType: 'claude',
      interfaceMode: 'claude-code',
    });
    mockRecoverHostRuntime.mockResolvedValue({
      tabs: [terminalAdvisorTab],
      runtimeByChatId: { [terminalAdvisorTab.id]: runtimeState() },
    });

    await expect(
      deliverWatcherMessageToChat(
        watcherDelivery({
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-1',
        }),
      ),
    ).rejects.toMatchObject({
      name: 'Error',
      message: 'Watcher destination chat is not available.',
    });

    expect(mockDispatchLocalWorktreeChatMessage).not.toHaveBeenCalled();
  });

  it('refuses an Advisor terminal destination even when an old receipt exists', async () => {
    mockRecoverHostRuntime.mockResolvedValue({
      tabs: [
        persistedTab({ providerType: 'claude', interfaceMode: 'claude-code' }),
      ],
      runtimeByChatId: {},
    });
    mockHasTranscriptMessage.mockResolvedValue(true);
    await expect(
      deliverWatcherMessageToChat(
        watcherDelivery({
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-1',
        }),
      ),
    ).rejects.toThrow('Watcher destination chat is not available.');
    expect(mockDispatchLocalWorktreeChatMessage).not.toHaveBeenCalled();
  });

  it('marks App Advisor watcher turns for the Advisor dispatcher', async () => {
    const advisorTab = persistedTab();
    mockRecoverHostRuntime.mockResolvedValue({
      tabs: [advisorTab],
      runtimeByChatId: { [advisorTab.id]: runtimeState() },
    });

    await expect(
      deliverWatcherMessageToChat(
        watcherDelivery({
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-1',
        }),
      ),
    ).resolves.toBe('submitted');

    expect(mockDispatchLocalWorktreeChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantMode: 'app-advisor',
        hiddenContext: { kind: 'canopy-watcher-event', text: '' },
      }),
    );
  });

  it.each(['cursor', 'copilot'] as const)(
    'normalizes a persisted %s harness over stale provider metadata',
    async (harness) => {
      tab = persistedTab({ providerType: 'claude', executionHarness: harness });
      mockRecoverHostRuntime.mockResolvedValue({
        tabs: [tab],
        runtimeByChatId: { [tab.id]: runtimeState() },
      });
      mockBuildExistingTabDispatchOptions.mockResolvedValue({
        providerType: 'claude',
        executionHarness: harness,
      });

      await expect(
        deliverWatcherMessageToChat(watcherDelivery()),
      ).resolves.toBe('submitted');

      expect(mockDispatchLocalWorktreeChatMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          providerType: harness,
          executionHarness: harness,
        }),
      );
    },
  );

  it('preserves persisted provider metadata over model-derived routing', async () => {
    const persistedOptions: Pick<
      ChatSendMessageRequest,
      'providerType' | 'executionHarness' | 'model'
    > = {
      providerType: 'codex',
      executionHarness: 'codex',
      model: 'claude-opus-4-6',
    };
    tab = persistedTab(persistedOptions);
    mockRecoverHostRuntime.mockResolvedValue({
      tabs: [tab],
      runtimeByChatId: { [tab.id]: runtimeState() },
    });
    mockBuildExistingTabDispatchOptions.mockResolvedValue(persistedOptions);

    await expect(deliverWatcherMessageToChat(watcherDelivery())).resolves.toBe(
      'submitted',
    );

    expect(mockDispatchLocalWorktreeChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        providerType: 'codex',
        executionHarness: 'codex',
        model: 'claude-opus-4-6',
      }),
    );
  });

  it('defaults an unconfigured chat to the native Claude provider and harness', async () => {
    tab = persistedTab({ providerType: undefined });
    mockRecoverHostRuntime.mockResolvedValue({
      tabs: [tab],
      runtimeByChatId: { [tab.id]: runtimeState() },
    });
    mockBuildExistingTabDispatchOptions.mockResolvedValue({});

    await expect(deliverWatcherMessageToChat(watcherDelivery())).resolves.toBe(
      'submitted',
    );

    expect(mockDispatchLocalWorktreeChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        providerType: 'claude',
        executionHarness: 'claude',
      }),
    );
  });

  it('rejects a persisted non-chat tab with the unavailable error', async () => {
    const fileTab = persistedTab({ kind: 'file' });
    mockRecoverHostRuntime.mockResolvedValue({
      tabs: [fileTab],
      runtimeByChatId: { [fileTab.id]: runtimeState() },
    });

    await expect(
      deliverWatcherMessageToChat(watcherDelivery()),
    ).rejects.toMatchObject({
      name: 'Error',
      message: 'Watcher destination chat is not available.',
    });
    expect(mockBuildExistingTabDispatchOptions).not.toHaveBeenCalled();
  });

  it('serializes delivery per chat while allowing another chat to proceed', async () => {
    const secondTab = persistedTab({ id: 'chat-2' });
    mockRecoverHostRuntime.mockResolvedValue({
      tabs: [tab, secondTab],
      runtimeByChatId: {
        [tab.id]: runtimeState(),
        [secondTab.id]: runtimeState(),
      },
    });
    let notifyStarted: () => void = () => undefined;
    let unblockFirst: () => void = () => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const firstDispatch = new Promise<void>((resolve) => {
      unblockFirst = resolve;
    });
    mockDispatchLocalWorktreeChatMessage.mockImplementationOnce(async () => {
      notifyStarted();
      await firstDispatch;
    });

    const first = deliverWatcherMessageToChat(
      watcherDelivery({ deliveryId: 'first' }),
    );
    await firstStarted;
    const secondSameChat = deliverWatcherMessageToChat(
      watcherDelivery({ deliveryId: 'second' }),
    );
    const otherChat = deliverWatcherMessageToChat(
      watcherDelivery({ chatId: 'chat-2', deliveryId: 'other-chat' }),
    );

    await expect(otherChat).resolves.toBe('submitted');
    expect(
      mockDispatchLocalWorktreeChatMessage.mock.calls.map(
        ([request]) => request.userMessageId,
      ),
    ).toEqual(['watcher-first', 'watcher-other-chat']);

    unblockFirst();
    await expect(Promise.all([first, secondSameChat])).resolves.toEqual([
      'submitted',
      'submitted',
    ]);
    expect(
      mockDispatchLocalWorktreeChatMessage.mock.calls.map(
        ([request]) => request.userMessageId,
      ),
    ).toEqual(['watcher-first', 'watcher-other-chat', 'watcher-second']);
  });
});
