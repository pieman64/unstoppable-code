/**
 * Phase 15: the sidebar and badge store publishes exactly what sidebar rows,
 * unread markers and badges read, and only when one of those values changes.
 */
import type {
  ApprovalRequestEvent,
  WorktreeChatBadgesSummary,
} from '@canopy/desktop-shared/types';
import { useChatStore } from '../chatStore';
import { useChatSidebarStore } from '../chatSidebarStore';
import {
  resetDelegationActivityStoreForTests,
  useDelegationActivityStore,
} from '../delegationActivityStore';
import {
  resetLiveBackgroundTaskStoreForTests,
  useLiveBackgroundTaskStore,
} from '../liveBackgroundTaskStore';
import { fromPersistedTab } from '../chat/persisted-tabs';
import type { ChatTab, WorktreeChatState } from '../chat/types';

function tab(id: string, overrides: Partial<ChatTab> = {}): ChatTab {
  return {
    ...fromPersistedTab({
      id,
      title: `Tab ${id}`,
      createdAt: '2026-10-01T00:00:00.000Z',
      messages: [],
    }),
    ...overrides,
  };
}

function chats(
  entries: Record<string, ChatTab[]>,
): Record<string, WorktreeChatState> {
  return Object.fromEntries(
    Object.entries(entries).map(([key, tabs]) => [
      key,
      { activeTabId: tabs[0]?.id ?? '', tabs },
    ]),
  );
}

function updateTab(
  key: string,
  id: string,
  update: (current: ChatTab) => ChatTab,
): void {
  useChatStore.setState((state) => ({
    worktreeChats: {
      ...state.worktreeChats,
      [key]: {
        ...state.worktreeChats[key],
        tabs: state.worktreeChats[key].tabs.map((entry) =>
          entry.id === id ? update(entry) : entry,
        ),
      },
    },
  }));
}

beforeEach(() => {
  resetDelegationActivityStoreForTests();
  resetLiveBackgroundTaskStoreForTests();
  useChatStore.setState({
    worktreeChats: chats({
      'p/w1': [tab('a'), tab('b')],
      'p/w2': [tab('c')],
    }),
    pendingPlanExits: {},
    pendingQuestions: {},
    pendingApprovals: {},
    persistedWorktreeBadges: {},
    unreadWorktreeKeys: new Set(),
  });
});

describe('chatSidebarStore', () => {
  it('mirrors the sidebar fields of every loaded worktree', () => {
    updateTab('p/w1', 'b', (entry) => ({
      ...entry,
      status: 'streaming',
      unread: true,
    }));
    const state = useChatSidebarStore.getState();
    expect(Object.keys(state.worktrees)).toStrictEqual(['p/w1', 'p/w2']);
    expect(state.worktrees['p/w1']?.tabs).toStrictEqual([
      {
        id: 'a',
        title: 'Tab a',
        providerType: undefined,
        status: 'idle',
        unread: undefined,
        pendingPlanExit: undefined,
      },
      {
        id: 'b',
        title: 'Tab b',
        providerType: undefined,
        status: 'streaming',
        unread: true,
        pendingPlanExit: undefined,
      },
    ]);
    expect(state.badgeKeys.streaming).toBe('p/w1');
    expect(state.badgeKeys.active).toBe('p/w1');
  });

  it('does not publish for transcript-only changes', () => {
    const before = useChatSidebarStore.getState();
    const published = jest.fn();
    const unsubscribe = useChatSidebarStore.subscribe(published);
    updateTab('p/w1', 'a', (entry) => ({
      ...entry,
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'hello' }],
          timestamp: 1,
        },
      ],
      lastEventAt: 5,
      currentTodos: [],
    }));
    unsubscribe();
    expect(published).not.toHaveBeenCalled();
    expect(useChatSidebarStore.getState()).toBe(before);
  });

  it('keeps unchanged worktree entries by identity when one row changes', () => {
    const before = useChatSidebarStore.getState();
    updateTab('p/w1', 'a', (entry) => ({ ...entry, unread: true }));
    const after = useChatSidebarStore.getState();
    expect(after).not.toBe(before);
    expect(after.worktrees['p/w2']).toBe(before.worktrees['p/w2']);
    expect(after.worktrees['p/w1']?.tabs[1]).toBe(
      before.worktrees['p/w1']?.tabs[1],
    );
  });

  it('passes the chat store unread keys and questions through by identity', () => {
    const unread = new Set(['p/w2']);
    useChatStore.setState({
      unreadWorktreeKeys: unread,
      pendingQuestions: {
        q1: {
          requestId: 'q1',
          projectId: 'p',
          worktreeId: 'w2',
          chatId: 'c',
          questions: [],
        },
      },
    });
    const state = useChatSidebarStore.getState();
    expect(state.unreadWorktreeKeys).toBe(unread);
    expect(state.pendingQuestions).toBe(
      useChatStore.getState().pendingQuestions,
    );
    expect(state.badgeKeys.question).toBe('p/w2');
  });

  it('derives badge keys from approvals, persisted badges and live delegates', () => {
    const approval: ApprovalRequestEvent = {
      requestId: 'r1',
      projectId: 'p',
      worktreeId: 'w2',
      chatId: 'c',
      provider: 'claude',
      title: 'Run command',
      details: { kind: 'command', command: 'npm publish' },
    };
    const persisted: WorktreeChatBadgesSummary = {
      version: 1,
      unreadChats: [],
      approvalChats: [{ chatId: 'z', title: 'Plan' }],
      needsHydration: false,
      updatedAt: '2026-10-01T00:00:00.000Z',
    };
    useChatStore.setState({
      pendingApprovals: { r1: approval },
      persistedWorktreeBadges: { 'p/w9': persisted },
    });
    expect(useChatSidebarStore.getState().badgeKeys).toMatchObject({
      toolApproval: 'p/w2',
      awaiting: 'p/w9',
      streaming: '',
    });

    useDelegationActivityStore.setState({
      byChat: {
        'p/w1/a': {
          projectId: 'p',
          worktreeId: 'w1',
          chatId: 'a',
          live: 1,
          queued: 0,
        },
      },
    });
    // Delegates alone are background work, not a running turn (D15).
    expect(useChatSidebarStore.getState().badgeKeys).toMatchObject({
      streaming: '',
      background: 'p/w1=1',
      active: 'p/w1',
    });
  });

  it('derives the active key from live provider agents, not shells, and counts both as background work', () => {
    useLiveBackgroundTaskStore.getState().applyPush({
      projectId: 'p',
      worktreeId: 'w2',
      chatId: 'c',
      sessionActive: true,
      liveTasks: [{ taskId: 't1', taskType: 'local_bash' }],
    });
    // A shell is background work (D11) but doesn't block close.
    expect(useChatSidebarStore.getState().badgeKeys).toMatchObject({
      active: '',
      background: 'p/w2=1',
    });

    useLiveBackgroundTaskStore.getState().applyPush({
      projectId: 'p',
      worktreeId: 'w2',
      chatId: 'c',
      sessionActive: true,
      liveTasks: [{ taskId: 't2', taskType: 'local_agent' }],
    });
    expect(useChatSidebarStore.getState().badgeKeys).toMatchObject({
      active: 'p/w2',
      streaming: '',
      background: 'p/w2=1',
    });

    useLiveBackgroundTaskStore.getState().applyPush({
      projectId: 'p',
      worktreeId: 'w2',
      chatId: 'c',
      sessionActive: true,
      liveTasks: [],
    });
    expect(useChatSidebarStore.getState().badgeKeys).toMatchObject({
      active: '',
      background: '',
    });
  });
});
