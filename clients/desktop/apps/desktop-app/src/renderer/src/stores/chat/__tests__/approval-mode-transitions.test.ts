import type { StoreApi } from 'zustand/vanilla';
import { useChatStore } from '../../chatStore';
import type { ChatState } from '../state';
import type {
  ApprovalAutoResolvedEvent,
  ApprovalRequestEvent,
} from '@canopy/desktop-shared/types';
import type { ChatMessage, ChatTab } from '../types';
import { emptyWorktreeChat } from '../tab-utils';

const scheduleSaveMock = jest.fn<void, unknown[]>();
jest.mock('../persistence', () => ({
  scheduleSave: (...args: unknown[]): void => scheduleSaveMock(...args),
}));

function makeTab(overrides: Partial<ChatTab> = {}): ChatTab {
  return {
    id: 'chat',
    title: 'Chat',
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-07-28T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    approvalMode: 'full-access',
    ...overrides,
  };
}

function createHarness(): StoreApi<ChatState> {
  const tab = makeTab();
  useChatStore.setState({
    selectedWorktree: { projectId: 'project', worktreeId: 'worktree' },
    worktreeChats: {
      'project/worktree': {
        ...emptyWorktreeChat(),
        activeTabId: tab.id,
        tabs: [tab],
      },
    },
    pendingApprovals: {},
    approvalDefaultsCache: {},
  });
  return useChatStore;
}

describe('approval-mode transitions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each(['steer', 'resend'] as const)(
    'preserves omitted legacy settings when global defaults change before %s',
    async (action) => {
      const command = jest.fn(() =>
        Promise.resolve({ commandId: 'test', outcome: 'applied', revision: 1 }),
      );
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { api: { chat: { command } } },
      });
      const store = createHarness();
      const inheritedTab = makeTab({
        status: 'streaming',
        model: 'claude-haiku-4-5-20251001',
        defaultStampModel: 'claude-haiku-4-5-20251001',
        providerType: 'claude',
        approvalMode: undefined,
        thinkingLevel: undefined,
        modelConfig: undefined,
        queuedMessages: [
          { hostQueueEntryId: 'queued', text: 'Retained input' },
        ],
      });
      store.setState({
        worktreeChats: {
          'project/worktree': {
            ...emptyWorktreeChat(),
            activeTabId: inheritedTab.id,
            tabs: [inheritedTab],
          },
        },
        modelDefaults: {
          chatProvider: 'claude',
          chatModelByProvider: {
            claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'high' },
            codex: null,
            ollama: null,
          },
          worktreeProvider: 'claude',
          worktreeModelByProvider: {
            claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'high' },
            codex: null,
            ollama: null,
          },
        },
      });
      await store.getState().syncActiveEmptyTabToDefaults();
      const request =
        action === 'steer'
          ? ({
              type: 'chat.steer_queued_message',
              chatId: 'chat',
              queuedMessageId: 'queued',
            } as const)
          : ({
              type: 'chat.input_delivery_action',
              chatId: 'chat',
              rowId: 'row',
              rowRevision: 1,
              action: 'resend',
            } as const);
      await store
        .getState()
        .dispatchChatCommand(
          { projectId: 'project', worktreeId: 'worktree' },
          request,
        );
      // Existing input keeps its host-owned payload. These commands identify
      // the row; they must not overlay new global defaults on that payload.
      expect(
        store.getState().worktreeChats['project/worktree'].tabs[0],
      ).toEqual(inheritedTab);
      expect(command).toHaveBeenCalledWith(
        expect.objectContaining({ command: request }),
      );
    },
  );

  it.each(['steer', 'resend'] as const)(
    'waits for approval changes before %s',
    async (action) => {
      let finish = (): void => {
        throw new Error('Approval transition was not initialized');
      };
      const setMode = jest.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      const command = jest.fn(() =>
        Promise.resolve({ commandId: 'test', outcome: 'applied', revision: 1 }),
      );
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { api: { approvals: { setMode }, chat: { command } } },
      });
      const store = createHarness();
      const transition = store.getState().setTabApprovalMode(undefined, 'ask');
      await Promise.resolve();
      await Promise.resolve();
      const dispatch = store.getState().dispatchChatCommand(
        { projectId: 'project', worktreeId: 'worktree' },
        action === 'steer'
          ? {
              type: 'chat.steer_queued_message',
              chatId: 'chat',
              queuedMessageId: 'queued',
            }
          : {
              type: 'chat.input_delivery_action',
              chatId: 'chat',
              rowId: 'row',
              rowRevision: 1,
              action: 'resend',
            },
      );
      await Promise.resolve();
      const callsBeforeTransition = command.mock.calls.length;
      finish();
      await transition;
      await dispatch;
      expect(callsBeforeTransition).toBe(0);
      expect(command).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps the permissive mode authoritative until a downgrade succeeds', async () => {
    let rejectTransition: (error: Error) => void = () => {
      throw new Error('Approval transition was not initialized');
    };
    const setMode = jest.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectTransition = reject;
        }),
    );
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { api: { approvals: { setMode } } },
    });
    const store = createHarness();

    const transition = store.getState().setTabApprovalMode(undefined, 'ask');
    await Promise.resolve();
    await Promise.resolve();
    expect(
      store.getState().worktreeChats['project/worktree'].tabs[0].approvalMode,
    ).toBe('full-access');
    expect(scheduleSaveMock).not.toHaveBeenCalled();
    expect(setMode).toHaveBeenCalledWith({
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      mode: 'ask',
      previousMode: 'full-access',
    });

    rejectTransition(new Error('Provider remained in full access'));
    await expect(transition).rejects.toThrow(
      'Provider remained in full access',
    );
    expect(
      store.getState().worktreeChats['project/worktree'].tabs[0].approvalMode,
    ).toBe('full-access');
    expect(scheduleSaveMock).not.toHaveBeenCalled();
  });

  it('serializes concurrent mode changes for the same chat', async () => {
    const resolvers: Array<() => void> = [];
    const setMode = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { api: { approvals: { setMode } } },
    });
    const store = createHarness();

    const askTransition = store.getState().setTabApprovalMode(undefined, 'ask');
    const autoTransition = store
      .getState()
      .setTabApprovalMode(undefined, 'auto');
    await Promise.resolve();
    await Promise.resolve();
    expect(setMode).toHaveBeenCalledTimes(1);

    resolvers[0]();
    await askTransition;
    await Promise.resolve();
    await Promise.resolve();
    expect(setMode).toHaveBeenCalledTimes(2);
    expect(
      store.getState().worktreeChats['project/worktree'].tabs[0].approvalMode,
    ).toBe('ask');

    resolvers[1]();
    await autoTransition;
    expect(
      store.getState().worktreeChats['project/worktree'].tabs[0].approvalMode,
    ).toBe('auto');
  });
});

describe('handleApprovalAutoResolved', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function pausedTimerMessage(pauseOwnerIds: string[]): ChatMessage {
    return {
      id: 'timer-message',
      role: 'system',
      timestamp: 1,
      blocks: [
        {
          type: 'turn_timer',
          startedAt: 1,
          pausedAt: 2,
          resumedAt: null,
          accumulatedPausedDurationMs: 0,
          completedAt: null,
          pauseOwnerIds,
        },
      ],
    };
  }

  function makeRequest(
    overrides: Partial<ApprovalRequestEvent> = {},
  ): ApprovalRequestEvent {
    return {
      requestId: 'req-1',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      provider: 'claude',
      title: 'ls apps/web/src/app/',
      details: { kind: 'command', command: 'ls apps/web/src/app/' },
      timerPauseOwnerId: 'approval:req-1',
      ...overrides,
    };
  }

  function makeAutoResolvedEvent(
    overrides: Partial<ApprovalAutoResolvedEvent> = {},
  ): ApprovalAutoResolvedEvent {
    return {
      requestId: 'req-1',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      reason: 'mode-change',
      mode: 'full-access',
      previousMode: 'ask',
      ...overrides,
    };
  }

  it('clears the pending entry and resumes the timer it owned', () => {
    const store = createHarness();
    const pending = makeRequest();
    store.setState({
      pendingApprovals: { 'req-1': pending },
      worktreeChats: {
        'project/worktree': {
          ...emptyWorktreeChat(),
          activeTabId: 'chat',
          tabs: [
            makeTab({ messages: [pausedTimerMessage(['approval:req-1'])] }),
          ],
        },
      },
    });

    store.getState().handleApprovalAutoResolved(makeAutoResolvedEvent());

    expect(store.getState().pendingApprovals['req-1']).toBeUndefined();
    const timerBlock =
      store.getState().worktreeChats['project/worktree'].tabs[0].messages[0]
        .blocks[0];
    expect(timerBlock.type).toBe('turn_timer');
    if (timerBlock.type !== 'turn_timer') throw new Error('expected timer');
    expect(timerBlock.resumedAt).not.toBeNull();
  });

  it('leaves the timer paused under another still-pending approval', () => {
    const store = createHarness();
    store.setState({
      pendingApprovals: {
        'req-1': makeRequest(),
        'req-2': makeRequest({
          requestId: 'req-2',
          timerPauseOwnerId: 'approval:req-2',
        }),
      },
      worktreeChats: {
        'project/worktree': {
          ...emptyWorktreeChat(),
          activeTabId: 'chat',
          tabs: [
            makeTab({
              messages: [
                pausedTimerMessage(['approval:req-1', 'approval:req-2']),
              ],
            }),
          ],
        },
      },
    });

    store.getState().handleApprovalAutoResolved(makeAutoResolvedEvent());

    expect(store.getState().pendingApprovals['req-2']).toBeDefined();
    const timerBlock =
      store.getState().worktreeChats['project/worktree'].tabs[0].messages[0]
        .blocks[0];
    if (timerBlock.type !== 'turn_timer') throw new Error('expected timer');
    expect(timerBlock.resumedAt).toBeNull();
    expect(timerBlock.pauseOwnerIds).toEqual(['approval:req-2']);
  });

  it('grafts the resolution message exactly once on duplicate delivery', () => {
    const store = createHarness();
    store.setState({ pendingApprovals: { 'req-1': makeRequest() } });
    const resolutionMessage: ChatMessage = {
      id: 'resolution-1',
      role: 'system',
      timestamp: 10,
      blocks: [
        {
          type: 'approval_resolution_info',
          timestamp: 10,
          resolvedBy: 'mode-change',
          mode: 'full-access',
          previousMode: 'ask',
          titles: ['ls apps/web/src/app/'],
        },
      ],
    };
    const event = makeAutoResolvedEvent({ resolutionMessage });

    store.getState().handleApprovalAutoResolved(event);
    store.getState().handleApprovalAutoResolved(event);

    const messages =
      store.getState().worktreeChats['project/worktree'].tabs[0].messages;
    expect(
      messages.filter((message) => message.id === 'resolution-1'),
    ).toHaveLength(1);
  });

  it('never persists — durability for this block is main-owned', () => {
    const store = createHarness();
    store.setState({ pendingApprovals: { 'req-1': makeRequest() } });

    store.getState().handleApprovalAutoResolved(
      makeAutoResolvedEvent({
        resolutionMessage: {
          id: 'resolution-1',
          role: 'system',
          timestamp: 10,
          blocks: [
            {
              type: 'approval_resolution_info',
              timestamp: 10,
              resolvedBy: 'mode-change',
              mode: 'full-access',
              titles: ['ls apps/web/src/app/'],
            },
          ],
        },
      }),
    );

    expect(scheduleSaveMock).not.toHaveBeenCalled();
  });

  it('still lands the resolution message when the pending entry is already gone', () => {
    const store = createHarness();
    store.setState({ pendingApprovals: {} });

    store.getState().handleApprovalAutoResolved(
      makeAutoResolvedEvent({
        resolutionMessage: {
          id: 'resolution-1',
          role: 'system',
          timestamp: 10,
          blocks: [
            {
              type: 'approval_resolution_info',
              timestamp: 10,
              resolvedBy: 'mode-change',
              mode: 'auto',
              titles: ['Write src/index.ts'],
            },
          ],
        },
      }),
    );

    const messages =
      store.getState().worktreeChats['project/worktree'].tabs[0].messages;
    expect(messages.map((message) => message.id)).toContain('resolution-1');
  });
});
