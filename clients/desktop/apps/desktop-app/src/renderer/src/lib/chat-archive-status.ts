/**
 * Whether a chat is live or archived, read from the chat store only, so
 * light openers (such as a sender title's) can ask without loading panels.
 */
import { useChatStore } from '@/stores/chatStore';

interface ChatEntryScope {
  readonly projectId: string;
  readonly worktreeId: string;
}

/** Whether the chat is a live tab of its worktree or Work Entry. */
export function isLiveChat(scope: ChatEntryScope, chatId: string): boolean {
  return (
    useChatStore
      .getState()
      .worktreeChats[
        `${scope.projectId}/${scope.worktreeId}`
      ]?.tabs.some((tab) => tab.id === chatId) ?? false
  );
}

/** Whether the chat is no longer a live tab and sits in the entry's archive. */
export async function isArchivedChat(
  scope: ChatEntryScope,
  chatId: string,
): Promise<boolean> {
  if (isLiveChat(scope, chatId)) return false;
  try {
    await useChatStore
      .getState()
      .loadTabsForTarget(scope.projectId, scope.worktreeId);
  } catch {
    // The live list stays as it was.
  }
  if (isLiveChat(scope, chatId)) return false;
  try {
    await useChatStore
      .getState()
      .loadArchivedChats(scope.projectId, scope.worktreeId);
  } catch {
    // An unread archive counts as not archived; the caller reports the rest.
  }
  return (
    useChatStore
      .getState()
      .archivedChats[
        `${scope.projectId}/${scope.worktreeId}`
      ]?.some((chat) => chat.chatId === chatId) ?? false
  );
}
