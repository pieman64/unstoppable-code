import type {
  CanopyApi,
  ChatCommandRequest,
  ChatCommandResult,
  SharedRunMetadata,
} from '@canopy/desktop-shared/types';
import type * as ChatStoreModule from '../chatStore';

// Durable chat persistence is main-owned now; the renderer store only mutates
// the in-memory projection. Canonical sharedRun round-trips are covered by the
// main-process chat-state repository tests.
const flushScopeMock = jest.fn<
  Promise<void>,
  [{ projectId: string; worktreeId: string }]
>();
const commandMock = jest.fn<Promise<ChatCommandResult>, [ChatCommandRequest]>();

declare global {
  interface Window {
    api: CanopyApi;
  }
}

function loadChatStore(): typeof ChatStoreModule {
  jest.resetModules();
  Object.defineProperty(global, 'window', {
    configurable: true,
    value: {
      api: {
        chat: {
          flushScope: flushScopeMock,
          command: commandMock,
        },
      },
    },
  });

  return jest.requireActual<typeof ChatStoreModule>('../chatStore');
}

const SHARED_RUN: SharedRunMetadata = {
  externalId: 'run-ext-1',
  organizationId: 'org-1',
  organizationName: 'Acme',
  shareScope: 'organization',
  sharedAt: '2026-07-09T00:00:00.000Z',
};

function seedTab(useChatStore: typeof ChatStoreModule.useChatStore): void {
  useChatStore.setState({
    selectedWorktree: { projectId: 'project', worktreeId: 'worktree' },
    worktreeChats: {
      'project/worktree': {
        activeTabId: 'chat-1',
        tabs: [
          {
            id: 'chat-1',
            title: 'Chat',
            messages: [],
            status: 'idle',
            error: null,
            createdAt: '2026-07-09T00:00:00.000Z',
            queuedMessages: [],
            planMode: false,
            proposalMode: 'optional',
            thinkingLevel: 'high',
            model: 'claude-sonnet-4-6',
            providerType: 'claude',
          },
        ],
      },
    },
    chatStateSync: {
      'project/worktree': { phase: 'live', revision: 1 },
    },
  });
}

describe('chatStore setSharedRun', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    flushScopeMock.mockReset();
    flushScopeMock.mockResolvedValue(undefined);
    commandMock.mockReset();
    commandMock.mockResolvedValue({
      commandId: 'shared-run-command',
      revision: 2,
      outcome: 'applied',
    });
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.resetModules();
  });

  it('sets sharedRun on the in-memory tab', async () => {
    const { useChatStore } = loadChatStore();
    seedTab(useChatStore);

    await useChatStore
      .getState()
      .setSharedRun('project', 'worktree', 'chat-1', SHARED_RUN);

    expect(
      useChatStore.getState().worktreeChats['project/worktree']?.tabs[0]
        ?.sharedRun,
    ).toEqual(SHARED_RUN);
  });

  it('clears sharedRun canonically when unshared', async () => {
    const { useChatStore } = loadChatStore();
    seedTab(useChatStore);

    await useChatStore
      .getState()
      .setSharedRun('project', 'worktree', 'chat-1', SHARED_RUN);
    await useChatStore
      .getState()
      .setSharedRun('project', 'worktree', 'chat-1', undefined);

    const tab =
      useChatStore.getState().worktreeChats['project/worktree']?.tabs[0];
    expect(tab?.sharedRun).toBeUndefined();
    expect(tab && 'sharedRun' in tab).toBe(false);
    expect(commandMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        projectId: 'project',
        worktreeId: 'worktree',
        command: {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: { sharedRun: null },
        },
      }),
    );
  });

  it('commits the unread comment count and revision canonically (CAN-397)', async () => {
    const { useChatStore } = loadChatStore();
    seedTab(useChatStore);

    await useChatStore
      .getState()
      .setSharedRun('project', 'worktree', 'chat-1', {
        ...SHARED_RUN,
        commentRevision: 4,
        unreadCommentCount: 2,
      });

    expect(commandMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        command: {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: {
            sharedRun: {
              ...SHARED_RUN,
              commentRevision: 4,
              unreadCommentCount: 2,
            },
          },
        },
      }),
    );
  });

  it('clears the unread count on markSeen while keeping the share (CAN-397)', async () => {
    const { useChatStore } = loadChatStore();
    seedTab(useChatStore);

    await useChatStore
      .getState()
      .setSharedRun('project', 'worktree', 'chat-1', {
        ...SHARED_RUN,
        commentRevision: 4,
        unreadCommentCount: 2,
      });
    // What the comments panel does after `runs:comments:markSeen` resolves.
    await useChatStore
      .getState()
      .setSharedRun('project', 'worktree', 'chat-1', {
        ...SHARED_RUN,
        commentRevision: 4,
        unreadCommentCount: 0,
      });

    const tab =
      useChatStore.getState().worktreeChats['project/worktree']?.tabs[0];
    expect(tab?.sharedRun?.unreadCommentCount).toBe(0);
    // The share itself survives — markSeen is not an unshare.
    expect(tab?.sharedRun?.externalId).toBe('run-ext-1');

    expect(commandMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        command: {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: {
            sharedRun: {
              ...SHARED_RUN,
              commentRevision: 4,
              unreadCommentCount: 0,
            },
          },
        },
      }),
    );
  });

  it('retries a shared-run metadata command after a transient scope refresh', async () => {
    const { useChatStore } = loadChatStore();
    seedTab(useChatStore);
    commandMock
      .mockImplementationOnce(() => {
        useChatStore.setState({
          chatStateSync: {
            'project/worktree': { phase: 'refreshing', revision: 1 },
          },
        });
        setTimeout(() => {
          useChatStore.setState({
            chatStateSync: {
              'project/worktree': { phase: 'live', revision: 2 },
            },
          });
        }, 1);
        throw new Error('scope refresh interrupted the command');
      })
      .mockResolvedValueOnce({
        commandId: 'shared-run-command-retry',
        revision: 3,
        outcome: 'applied',
      });

    const update = useChatStore
      .getState()
      .setSharedRun('project', 'worktree', 'chat-1', {
        ...SHARED_RUN,
        commentRevision: 4,
        unreadCommentCount: 0,
      });
    const result = expect(update).resolves.toBeUndefined();

    await jest.advanceTimersByTimeAsync(1);
    await result;

    expect(commandMock).toHaveBeenCalledTimes(2);
    expect(
      useChatStore.getState().worktreeChats['project/worktree']?.tabs[0]
        ?.sharedRun?.unreadCommentCount,
    ).toBe(0);
  });

  it('retries idempotent shared-run metadata after a revision conflict', async () => {
    const { useChatStore } = loadChatStore();
    seedTab(useChatStore);
    commandMock
      .mockResolvedValueOnce({
        commandId: 'shared-run-command-conflict',
        revision: 2,
        outcome: 'conflict',
      })
      .mockResolvedValueOnce({
        commandId: 'shared-run-command-retry',
        revision: 3,
        outcome: 'applied',
      });

    await useChatStore
      .getState()
      .setSharedRun('project', 'worktree', 'chat-1', {
        ...SHARED_RUN,
        commentRevision: 4,
        unreadCommentCount: 0,
      });

    expect(commandMock).toHaveBeenCalledTimes(2);
    expect(
      useChatStore.getState().worktreeChats['project/worktree']?.tabs[0]
        ?.sharedRun?.unreadCommentCount,
    ).toBe(0);
    expect(useChatStore.getState().chatStateNotices).toEqual({});
  });
});
