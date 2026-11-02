import {
  APP_ADVISOR_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import { useChatStore } from '@/stores/chatStore';
import { worktreeKey } from '@/stores/chat/utils';

/** The chat tab menu's read-state hooks (see `PanelTabContextMenu`). */
export interface ChatReadStateServices {
  getChatReadState: (chatTabId: string) => 'read' | 'unread' | undefined;
  onSetChatUnread: (chatTabId: string, unread: boolean) => void;
}

// Embedded scopes keep their own read paths and are refused by the Portal
// adapter, so their tab menus offer no read item.
const EMBEDDED_CHAT_SCOPES: ReadonlySet<string> = new Set([
  APP_ADVISOR_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
]);

/**
 * "Mark as unread" / "Mark as read" for a scope's chat tabs, or undefined for
 * embedded scopes. Read-only viewers keep it: read state is personal, and
 * main allows viewers to mark chats read and unread.
 */
export function chatReadStateServices(
  projectId: string,
  worktreeId: string,
): ChatReadStateServices | undefined {
  if (EMBEDDED_CHAT_SCOPES.has(projectId)) return undefined;
  return {
    // Read when the menu opens; the menu is transient, so no subscription.
    getChatReadState: (chatTabId): 'read' | 'unread' | undefined => {
      const tab = useChatStore
        .getState()
        .worktreeChats[
          worktreeKey({ projectId, worktreeId })
        ]?.tabs.find((candidate) => candidate.id === chatTabId);
      if (!tab) return undefined;
      return tab.unread === true ? 'unread' : 'read';
    },
    onSetChatUnread: (chatTabId, unread): void => {
      useChatStore
        .getState()
        .setChatUnread(projectId, worktreeId, chatTabId, unread);
    },
  };
}
