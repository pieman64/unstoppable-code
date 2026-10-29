import { useChatStore } from '@/stores/chatStore';
import {
  getAuxPanelLayoutOwnerKey,
  restrictedChatGroupId,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
import { chatTabToPanelSeed } from './chat-panel-binding';
import { revealPanel } from './panel-reveal';

/**
 * Places the chat produced by a standalone `startNewChat()` run into the
 * group whose tab-strip `+` was clicked.
 *
 * The standalone flow owns creation semantics (empty-tab reuse, model
 * defaults, archive-overlay cleanup) but knows nothing about panel groups —
 * it lands the chat wherever the chat ⇄ panel sync bridge's MRU placement
 * puts it. Called AFTER the flow resolves, this binds the resulting active
 * chat tab's panel to `groupId`: adding it there when it has no panel yet
 * (same synchronous-add-beats-the-bridge trick as `addChatPanelToGroup`), or
 * moving the existing panel (the reused empty tab) into the clicked group.
 * A chat restricted to the chat group (early access) goes there instead, and
 * one already there is revealed, so the chat the user started always shows.
 */
export function placeActiveStandaloneChatInGroup(
  worktreeKey: string,
  requestedGroupId: string,
): void {
  const chats = useChatStore.getState().worktreeChats[worktreeKey];
  const activeTab = chats?.tabs.find(
    (tab) => tab.id === chats.activeTabId && tab.kind !== 'file',
  );
  if (activeTab === undefined) {
    return;
  }
  const seed = chatTabToPanelSeed(activeTab);
  const layoutStore = usePanelLayoutStore.getState();
  const chatGroupId = restrictedChatGroupId(layoutStore.layouts[worktreeKey]);
  const groupId = chatGroupId ?? requestedGroupId;
  const group = layoutStore.layouts[worktreeKey]?.groups[groupId];
  if (group === undefined) {
    return;
  }
  if (group.tabs.some((tab) => tab.panelId === seed.panelId)) {
    if (chatGroupId !== null) {
      revealPanel({ layoutKey: worktreeKey, groupId, panelId: seed.panelId });
    }
    return;
  }
  const added = layoutStore.addTab(worktreeKey, groupId, seed.kind, {
    panelId: seed.panelId,
    title: seed.title,
    instance: seed.instance,
  });
  if (added !== null) {
    return;
  }
  // The panel already exists (reused empty tab). `movePanel` only searches
  // ONE layout, so find the actual host across the family first: within the
  // main layout it moves in place; hosted by a popped-out auxiliary layout
  // it is closed there and re-added to the clicked group (chat panels are
  // freely re-creatable, unlike browser panels).
  const hostKey = Object.keys(layoutStore.layouts).find((key) => {
    if (key !== worktreeKey && getAuxPanelLayoutOwnerKey(key) !== worktreeKey) {
      return false;
    }
    const layout = layoutStore.layouts[key];
    return Object.values(layout.groups).some((candidate) =>
      candidate.tabs.some((tab) => tab.panelId === seed.panelId),
    );
  });
  if (hostKey === undefined) {
    return;
  }
  if (hostKey === worktreeKey) {
    layoutStore.movePanel(worktreeKey, seed.panelId, groupId, 'center');
    return;
  }
  const hostLayout = layoutStore.layouts[hostKey];
  const hostGroupId = Object.entries(hostLayout.groups).find(([, candidate]) =>
    candidate.tabs.some((tab) => tab.panelId === seed.panelId),
  )?.[0];
  if (hostGroupId === undefined) {
    return;
  }
  layoutStore.closeTab(hostKey, hostGroupId, seed.panelId);
  layoutStore.addTab(worktreeKey, groupId, seed.kind, {
    panelId: seed.panelId,
    title: seed.title,
    instance: seed.instance,
  });
}
