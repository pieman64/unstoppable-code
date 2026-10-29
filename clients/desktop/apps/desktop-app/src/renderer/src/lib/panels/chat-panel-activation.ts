/**
 * Chat-panel reveal bridge — routes `requestChatPanelReveal(...)` requests
 * (unread-chat toast click, overview unread card) into the panel grid: the
 * panel bound to the chat is expanded (if collapsed), selected, and focused.
 *
 * This closes the gap where clicking a chat that is ALREADY the worktree's
 * active tab (e.g. it went unread while its panel was collapsed) cleared the
 * unread state but never expanded the panel — the chat↔panel bridge only
 * reveals on an active-tab CHANGE, and a re-select of the active tab is not a
 * change.
 *
 * Like `browser-panel-activation` / `chat-panel-sync`, this lives OUTSIDE the
 * stores and is installed idempotently from `WorktreePart`.
 */
import { subscribeChatPanelReveal } from '@/lib/chatPanelReveal';
import {
  findPanelByInstanceKey,
  getPanelInstanceKey,
  makeWorktreePanelKey,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';

let installed = false;

/** Install the chat-panel reveal subscription once (idempotent). */
export function initChatPanelReveal(): void {
  if (installed) {
    return;
  }
  installed = true;

  subscribeChatPanelReveal(({ projectId, worktreeId, chatId }) => {
    const worktreeKey = makeWorktreePanelKey(projectId, worktreeId);
    const store = usePanelLayoutStore.getState();
    const instanceKey = getPanelInstanceKey({
      kind: 'chat',
      instance: { chatTabId: chatId },
    });
    const existing = findPanelByInstanceKey(worktreeKey, instanceKey);
    if (existing === null) {
      // The worktree's layout is not loaded yet (cross-worktree navigation);
      // the sync bridge's hydration sweep reveals the active chat instead.
      return;
    }
    store.ensureGroupExpanded(existing.layoutKey, existing.groupId);
    store.selectTab(existing.layoutKey, existing.groupId, existing.panelId, {
      focus: true,
    });
    store.focusGroup(existing.layoutKey, existing.groupId);
  });
}
