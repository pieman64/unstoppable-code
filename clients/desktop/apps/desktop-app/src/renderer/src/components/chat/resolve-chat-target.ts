import {
  useChatStore,
  type ChatMessage,
  type ChatTab,
} from '@/stores/chatStore';

export interface ResolvedChat {
  target: { projectId: string; worktreeId: string; chatId: string };
  messages: ChatMessage[];
}

function selectMessages(tabs: ChatTab[], tabId: string): ChatMessage[] {
  return tabs.find((tab) => tab.id === tabId)?.messages ?? [];
}

/**
 * Recover the `(projectId, worktreeId, chatId)` triple from the tab id the
 * block renderer already carries, rather than threading a chat target down
 * through every intermediate chat component. Cowork work entries occupy the
 * `worktreeId` slot in the same map, so this resolves both surfaces.
 */
export function resolveChat(tabId: string | undefined): ResolvedChat | null {
  if (!tabId) {
    return null;
  }
  const chats = useChatStore.getState().worktreeChats;
  for (const [key, state] of Object.entries(chats)) {
    if (!state.tabs.some((tab) => tab.id === tabId)) {
      continue;
    }
    const separator = key.indexOf('/');
    if (separator <= 0 || separator === key.length - 1) {
      continue;
    }
    return {
      target: {
        projectId: key.slice(0, separator),
        worktreeId: key.slice(separator + 1),
        chatId: tabId,
      },
      messages: selectMessages(state.tabs, tabId),
    };
  }
  return null;
}
