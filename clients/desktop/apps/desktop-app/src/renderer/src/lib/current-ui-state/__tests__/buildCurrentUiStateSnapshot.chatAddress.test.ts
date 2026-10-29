/**
 * @jest-environment jsdom
 */
import type { ChatTab } from '@/stores/chat/types';
import { useChatStore } from '@/stores/chatStore';
import { buildCurrentUiStateSnapshot } from '../buildCurrentUiStateSnapshot';

const ENTRY = { projectId: 'cowork-default', worktreeId: 'entry-1' };

function tab(id: string): ChatTab {
  return {
    id,
    title: `Chat ${id}`,
    messages: [],
    status: 'idle',
    error: null,
    createdAt: new Date(0).toISOString(),
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    providerType: 'claude',
  };
}

beforeEach(() => {
  useChatStore.setState({
    selectedWorktree: ENTRY,
    worktreeChats: {
      [`${ENTRY.projectId}/${ENTRY.worktreeId}`]: {
        activeTabId: 'chat-2',
        tabs: [tab('entry-1'), tab('chat-2')],
      },
    },
  });
});

afterEach(() => {
  useChatStore.setState({ selectedWorktree: null, worktreeChats: {} });
});

describe('buildCurrentUiStateSnapshot active chat address', () => {
  it('gives the focused chat the address projects.send_message takes', () => {
    expect(buildCurrentUiStateSnapshot({}).activeChat?.address).toEqual({
      projectId: 'cowork-default',
      taskId: 'entry-1',
      chatId: 'chat-2',
    });
  });

  it('gives no address to a reported chat outside the selected task', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'chat.activeTab': { chatId: 'chat-elsewhere', title: 'Elsewhere' },
    });

    expect(snapshot.activeChat?.chatId).toBe('chat-elsewhere');
    expect(snapshot.activeChat?.address).toBeUndefined();
  });
});
