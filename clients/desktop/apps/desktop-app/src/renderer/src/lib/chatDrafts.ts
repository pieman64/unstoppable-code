import type { Descendant } from 'slate';
import type { WorktreeChatState } from '@/stores/chatStore';

export interface ChatDraftStoreSnapshot {
  worktreeChats: Record<string, WorktreeChatState>;
  saveTabDraft: (tabId: string, content: Descendant[]) => void;
}

export function tabExistsInWorktreeChats(
  tabId: string,
  worktreeChats: Record<string, WorktreeChatState>,
): boolean {
  return Object.values(worktreeChats).some((wc) =>
    wc.tabs.some((tab) => tab.id === tabId),
  );
}

export function saveDraftForExistingTab(
  state: ChatDraftStoreSnapshot,
  tabId: string | null,
  content: Descendant[],
): void {
  if (tabId === null) {
    return;
  }

  if (!tabExistsInWorktreeChats(tabId, state.worktreeChats)) {
    return;
  }

  state.saveTabDraft(tabId, structuredClone(content));
}
