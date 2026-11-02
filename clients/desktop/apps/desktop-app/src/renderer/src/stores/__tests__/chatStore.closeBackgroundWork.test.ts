/** @jest-environment jsdom */
import { useChatStore, type ChatTab } from '@/stores/chatStore';
import {
  BACKGROUND_BLOCKS_CLOSE_NOTICE,
  DELEGATES_BLOCK_CLOSE_NOTICE,
} from '@/stores/chat/close-guard';
import {
  resetDelegationActivityStoreForTests,
  useDelegationActivityStore,
} from '@/stores/delegationActivityStore';
import {
  resetLiveBackgroundTaskStoreForTests,
  useLiveBackgroundTaskStore,
} from '@/stores/liveBackgroundTaskStore';
import { useGitHubStore } from '@/stores/githubStore';

function makeTab(id: string): ChatTab {
  return {
    id,
    title: id,
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', speed: 'standard', fastMode: false },
    fastModeExplicit: false,
    model: 'claude-sonnet-4-5-20250514',
    providerType: 'claude',
  };
}

function pushTasks(chatId: string, taskTypes: readonly string[]): void {
  useLiveBackgroundTaskStore.getState().applyPush({
    projectId: 'project',
    worktreeId: 'worktree',
    chatId,
    sessionActive: true,
    liveTasks: taskTypes.map((taskType, index) => ({
      taskId: `${chatId}-${index}`,
      taskType,
    })),
  });
}

async function flushCloseWork(): Promise<void> {
  for (let index = 0; index < 25; index += 1) {
    await Promise.resolve();
  }
}

describe('chat store close refusal for provider background work', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
    resetDelegationActivityStoreForTests();
    resetLiveBackgroundTaskStoreForTests();
    useGitHubStore.setState({ toasts: [], notifications: [] });
    useChatStore.setState({
      selectedWorktree: { projectId: 'project', worktreeId: 'worktree' },
      worktreeChats: {},
      closingChatTabs: {},
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { chat: {} },
    });
  });

  afterEach(() => {
    resetDelegationActivityStoreForTests();
    resetLiveBackgroundTaskStoreForTests();
    useGitHubStore.setState({ toasts: [], notifications: [] });
    jest.clearAllTimers();
    jest.useRealTimers();
    Reflect.deleteProperty(window, 'api');
  });

  it('keeps an idle chat with a live provider agent open and shows one notice', async () => {
    useChatStore.setState({
      worktreeChats: {
        'project/worktree': {
          activeTabId: 'provider-chat',
          tabs: [makeTab('provider-chat'), makeTab('sibling')],
        },
      },
    });
    pushTasks('provider-chat', ['local_agent']);

    useChatStore.getState().closeTab('provider-chat');
    await flushCloseWork();

    expect(
      useChatStore
        .getState()
        .worktreeChats['project/worktree']?.tabs.map((tab) => tab.id),
    ).toEqual(['provider-chat', 'sibling']);
    expect(
      useGitHubStore.getState().toasts.map((toast) => toast.message),
    ).toEqual([BACKGROUND_BLOCKS_CLOSE_NOTICE]);
  });

  it('allows a chat with only local shell work to close', async () => {
    useChatStore.setState({
      worktreeChats: {
        'project/worktree': {
          activeTabId: 'shell-chat',
          tabs: [makeTab('shell-chat'), makeTab('sibling')],
        },
      },
    });
    pushTasks('shell-chat', ['local_bash']);

    useChatStore.getState().closeTab('shell-chat');
    await flushCloseWork();

    expect(
      useChatStore
        .getState()
        .worktreeChats['project/worktree']?.tabs.map((tab) => tab.id),
    ).toEqual(['sibling']);
    expect(useGitHubStore.getState().toasts).toEqual([]);
  });

  it('shows one delegate-priority notice while batch close leaves only blocked chats', async () => {
    useChatStore.setState({
      worktreeChats: {
        'project/worktree': {
          activeTabId: 'idle-chat',
          tabs: [
            makeTab('provider-agent'),
            makeTab('provider-workflow'),
            makeTab('delegate-chat'),
            makeTab('idle-chat'),
          ],
        },
      },
    });
    pushTasks('provider-agent', ['local_agent']);
    pushTasks('provider-workflow', ['local_workflow']);
    useDelegationActivityStore.getState().applyActivity({
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'delegate-chat',
      live: 1,
      queued: 0,
    });

    useChatStore
      .getState()
      .closeTabs(
        ['provider-agent', 'provider-workflow', 'delegate-chat', 'idle-chat'],
        { projectId: 'project', worktreeId: 'worktree' },
      );
    await flushCloseWork();

    expect(
      useChatStore
        .getState()
        .worktreeChats['project/worktree']?.tabs.map((tab) => tab.id),
    ).toEqual(['provider-agent', 'provider-workflow', 'delegate-chat']);
    expect(
      useGitHubStore.getState().toasts.map((toast) => toast.message),
    ).toEqual([DELEGATES_BLOCK_CLOSE_NOTICE]);
  });
});
