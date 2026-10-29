import type { Descendant } from 'slate';
import {
  saveDraftForExistingTab,
  tabExistsInWorktreeChats,
} from '@/lib/chatDrafts';
import type { ChatTab, WorktreeChatState } from '@/stores/chatStore';

function makeChatTab(id: string): ChatTab {
  return {
    id,
    title: 'Chat',
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-05-04T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    thinkingLevel: 'high',
    proposalMode: 'optional',
  };
}

function makeDraft(text: string): Descendant[] {
  return [
    {
      type: 'paragraph',
      children: [{ text }],
    },
  ];
}

describe('chatDrafts', () => {
  it('detects whether a tab still exists in any loaded worktree chat', () => {
    const worktreeChats: Record<string, WorktreeChatState> = {
      'project/worktree-a': {
        tabs: [makeChatTab('chat-1')],
        activeTabId: 'chat-1',
      },
      'project/worktree-b': {
        tabs: [makeChatTab('chat-2')],
        activeTabId: 'chat-2',
      },
    };

    expect(tabExistsInWorktreeChats('chat-2', worktreeChats)).toBe(true);
    expect(tabExistsInWorktreeChats('missing', worktreeChats)).toBe(false);
  });

  it('saves a cloned draft only when the tab still exists', () => {
    const saveTabDraft = jest.fn<void, [string, Descendant[]]>();
    const draft = makeDraft('unsent text');
    const state = {
      worktreeChats: {
        'project/worktree': {
          tabs: [makeChatTab('chat-1')],
          activeTabId: 'chat-1',
        },
      },
      saveTabDraft,
    };

    saveDraftForExistingTab(state, 'chat-1', draft);
    saveDraftForExistingTab(state, 'closed-chat', makeDraft('closed draft'));
    saveDraftForExistingTab(state, null, makeDraft('null draft'));

    expect(saveTabDraft).toHaveBeenCalledTimes(1);
    expect(saveTabDraft).toHaveBeenCalledWith('chat-1', draft);

    const call = saveTabDraft.mock.calls[0];
    if (!call) {
      throw new Error('Expected saveTabDraft to be called');
    }
    expect(call[1]).not.toBe(draft);
  });
});
