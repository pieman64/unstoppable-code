import { useChatStore, type ChatTab } from '@/stores/chatStore';
import {
  getAuxPanelLayoutOwnerKey,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
import { chatTabToPanelSeed } from './chat-panel-binding';

/**
 * Creates a chat tab and places its bound panel in `groupId`.
 *
 * Shared by the tab strip's `+` button (which creates a chat directly) and
 * the add-panel menu's `New Chat` row, so both land the panel in the group
 * the user acted on rather than wherever the chat ⇄ panel sync bridge would
 * place it. The bridge reconciles on a microtask and skips instance keys that
 * already have a panel, so adding the panel synchronously here (same task as
 * `createTab`) wins over its MRU placement; the bridge's active-tab sweep then
 * just focuses the panel placed here.
 */
export function addChatPanelToGroup(
  worktreeKey: string,
  groupId: string,
): void {
  // Aux layout keys (`<worktreeKey>#<auxWindowId>`) still create the chat tab
  // under the OWNING worktree; the panel lands in the aux group.
  const ownerKey = getAuxPanelLayoutOwnerKey(worktreeKey) ?? worktreeKey;
  const separator = ownerKey.indexOf('/');
  const projectId = ownerKey.slice(0, separator);
  const worktreeId = ownerKey.slice(separator + 1);

  const tabsBefore = new Set(
    (useChatStore.getState().worktreeChats[ownerKey]?.tabs ?? []).map(
      (tab) => tab.id,
    ),
  );
  useChatStore.getState().createTab({ projectId, worktreeId });

  // `createTab` returns void: the created tab is the newest (last) chat tab of
  // the worktree that was not there before the call.
  let createdTab: ChatTab | undefined;
  for (const tab of useChatStore.getState().worktreeChats[ownerKey]?.tabs ??
    []) {
    if (tab.kind !== 'file' && !tabsBefore.has(tab.id)) {
      createdTab = tab;
    }
  }
  if (createdTab === undefined) {
    return;
  }

  const seed = chatTabToPanelSeed(createdTab);
  const layoutStore = usePanelLayoutStore.getState();
  // Deterministic panel id first (`panel-chat-<id>`, the id the sync bridge /
  // default layout would mint); fall back to a generated id if it is somehow
  // taken in the family (sync-bridge convention).
  const added = layoutStore.addTab(worktreeKey, groupId, seed.kind, {
    panelId: seed.panelId,
    title: seed.title,
    instance: seed.instance,
  });
  if (added === null) {
    layoutStore.addTab(worktreeKey, groupId, seed.kind, {
      title: seed.title,
      instance: seed.instance,
    });
  }
}

/**
 * Creates an EMPTY file tab (`filePath: ''`) and places its bound panel in
 * `groupId` — the add-panel menu's "New File" row. Same synchronous
 * create-then-bind pattern as {@link addChatPanelToGroup} so placement wins
 * over the chat ⇄ panel sync bridge's MRU fallback.
 */
export function addEmptyFileTabPanelToGroup(
  worktreeKey: string,
  groupId: string,
): string | null {
  const ownerKey = getAuxPanelLayoutOwnerKey(worktreeKey) ?? worktreeKey;
  const separator = ownerKey.indexOf('/');
  const projectId = ownerKey.slice(0, separator);
  const worktreeId = ownerKey.slice(separator + 1);

  const chatStore = useChatStore.getState();
  const tabId = chatStore.createEmptyFileTab({ projectId, worktreeId });
  if (tabId === null) {
    return null;
  }
  const createdTab = useChatStore
    .getState()
    .worktreeChats[ownerKey]?.tabs.find((tab) => tab.id === tabId);
  if (createdTab === undefined) {
    return null;
  }

  const seed = chatTabToPanelSeed(createdTab);
  const layoutStore = usePanelLayoutStore.getState();
  const added = layoutStore.addTab(worktreeKey, groupId, seed.kind, {
    panelId: seed.panelId,
    title: seed.title,
    instance: seed.instance,
  });
  if (added === null) {
    return layoutStore.addTab(worktreeKey, groupId, seed.kind, {
      title: seed.title,
      instance: seed.instance,
    });
  }
  return added;
}
