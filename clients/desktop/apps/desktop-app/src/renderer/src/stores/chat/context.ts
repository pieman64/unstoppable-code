// Lookup/update helpers over ChatState worktree chat contexts.
import type { WorktreeSelection } from '@canopy/desktop-shared/types';
import type { ChatState } from './state';
import type { ChatTab, WorktreeChatState } from './types';
import { worktreeKey } from './utils';

export interface ActiveStaleSessionContext {
  sel: WorktreeSelection;
  key: string;
  sourceTab: ChatTab;
  /**
   * Absent for read-only tabs without a dropped message — e.g. an archived
   * chat restored from an archived container. Start New Session / Hand Off
   * Session must tolerate `null` (nothing was dropped, so there is nothing to
   * re-send).
   */
  staleSession: NonNullable<ChatTab['staleSessionDetected']> | null;
}

export function getActiveStaleSessionContext(
  state: ChatState,
): ActiveStaleSessionContext | null {
  const sel = state.selectedWorktree;
  if (!sel) {
    return null;
  }

  const key = worktreeKey(sel);
  const wc = state.worktreeChats[key];
  if (!wc) {
    return null;
  }

  const sourceTab = wc.tabs.find((tab) => tab.id === wc.activeTabId);
  if (!sourceTab) {
    return null;
  }
  const staleSession = sourceTab.staleSessionDetected ?? null;
  // Read-only tabs (restored archives) qualify even without a stale-session
  // record; anything else needs a detected stale session.
  if (staleSession === null && sourceTab.readOnly !== true) {
    return null;
  }

  return { sel, key, sourceTab, staleSession };
}

export function updateActiveTabInWorktree(
  state: ChatState,
  key: string,
  updateTab: (tab: ChatTab) => ChatTab,
): Partial<ChatState> {
  const wc = state.worktreeChats[key];
  if (!wc) return state;

  const updatedTabs = wc.tabs.map((tab) =>
    tab.id === wc.activeTabId ? updateTab(tab) : tab,
  );
  return {
    worktreeChats: {
      ...state.worktreeChats,
      [key]: { ...wc, tabs: updatedTabs },
    },
  };
}

export interface ActiveWorktreeChatContext {
  selection: WorktreeSelection;
  key: string;
  worktreeChat: WorktreeChatState;
  chatId: string;
  activeTab: ChatTab | undefined;
}

/**
 * Lookup helper: gather the currently-active worktree/tab context from the
 * given store state. Returns `null` when no worktree is selected or the
 * selected worktree has no chat state yet. Pure read — never mutates state.
 *
 * Pair with {@link updateCapturedChatTab} to mutate the captured tab inside
 * a `set(...)` reducer while preserving captured-tab semantics across awaits.
 */
export function getActiveWorktreeChatContext(
  state: ChatState,
): ActiveWorktreeChatContext | null {
  const selection = state.selectedWorktree;
  if (!selection) return null;

  const key = worktreeKey(selection);
  const worktreeChat = state.worktreeChats[key];
  if (!worktreeChat) return null;

  const chatId = worktreeChat.activeTabId;
  const activeTab = worktreeChat.tabs.find((tab) => tab.id === chatId);

  return { selection, key, worktreeChat, chatId, activeTab };
}

export function getWorktreeChatContext(
  state: ChatState,
  target?: { projectId: string; worktreeId: string; chatId: string },
): ActiveWorktreeChatContext | null {
  if (!target) {
    return getActiveWorktreeChatContext(state);
  }
  const selection = {
    projectId: target.projectId,
    worktreeId: target.worktreeId,
  };
  const key = worktreeKey(selection);
  const worktreeChat = state.worktreeChats[key];
  if (!worktreeChat) return null;
  const activeTab = worktreeChat.tabs.find((tab) => tab.id === target.chatId);
  return {
    selection,
    key,
    worktreeChat,
    chatId: target.chatId,
    activeTab,
  };
}

/**
 * Mutation helper: updates the tab matched by `context.chatId` (the captured
 * id from {@link getActiveWorktreeChatContext}), NOT the live
 * `worktreeChat.activeTabId`. This preserves async-safe behavior — if the
 * user switches tabs while an awaited API call is in flight, the originally
 * captured tab is still the one that gets updated and persisted.
 *
 * Returns `Partial<ChatState>` for use inside zustand's
 * `set((state) => partial)` callback. Returns `{}` (a safe no-op) if the
 * worktree chat entry has been removed since context capture.
 *
 * Do NOT delegate to {@link updateActiveTabInWorktree}: that helper rereads
 * `wc.activeTabId` and would mis-target post-await mutations.
 */
export function updateCapturedChatTab(
  state: ChatState,
  context: ActiveWorktreeChatContext,
  updater: (tab: ChatTab) => ChatTab,
): Partial<ChatState> {
  const currentWc = state.worktreeChats[context.key];
  if (!currentWc) return {};

  // IMPORTANT: match against context.chatId (captured at function entry),
  // never currentWc.activeTabId. This is what existing async actions like
  // setModel rely on so the user switching tabs mid-await does not redirect
  // the update to the new active tab.
  const updatedTabs = currentWc.tabs.map((tab) =>
    tab.id === context.chatId ? updater(tab) : tab,
  );
  const updated: WorktreeChatState = {
    ...currentWc,
    tabs: updatedTabs,
  };

  return {
    worktreeChats: {
      ...state.worktreeChats,
      [context.key]: updated,
    },
  };
}

// ---------------------------------------------------------------------------
// SDK event parsing (minimal slice)
// ---------------------------------------------------------------------------

/**
 * Resolves the chat tab `sendMessage` should write to from an explicit target
 * (when one is supplied) or by walking the worktree's tab list for a
 * fallback. Pure resolution — the caller still owns side effects when a new
 * tab needs to be created (`kind: 'create'`).
 *
 * - `existing`: caller has a writable tab matching the explicit `target` or
 *   the active tab. Caller may need to switch the active tab when
 *   `shouldSwitchTab` is true.
 * - `create`: caller must create a fresh empty tab (no fallback existed).
 * - `abort`: the explicit target failed validation (tab missing, file kind,
 *   or read-only) — the caller should bail out without mutation.
 */
export type SendMessageTabResolution =
  | { kind: 'existing'; chatId: string; tab: ChatTab; shouldSwitchTab: boolean }
  | { kind: 'create' }
  | { kind: 'abort' };

export function resolveSendMessageTargetTab(
  wc: WorktreeChatState,
  target: { chatId: string } | undefined,
): SendMessageTabResolution {
  const chatId = target ? target.chatId : wc.activeTabId;
  const tab = wc.tabs.find((t) => t.id === chatId);

  if (target) {
    if (!tab || tab.kind === 'file' || tab.readOnly) {
      return { kind: 'abort' };
    }
    return { kind: 'existing', chatId, tab, shouldSwitchTab: false };
  }

  if (tab && tab.kind !== 'file') {
    return { kind: 'existing', chatId, tab, shouldSwitchTab: false };
  }

  const fallbackTab = wc.tabs.find(
    (candidate) => candidate.kind !== 'file' && candidate.readOnly !== true,
  );
  if (fallbackTab) {
    return {
      kind: 'existing',
      chatId: fallbackTab.id,
      tab: fallbackTab,
      shouldSwitchTab: wc.activeTabId !== fallbackTab.id,
    };
  }

  return { kind: 'create' };
}
