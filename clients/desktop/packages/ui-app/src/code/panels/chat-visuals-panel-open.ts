import type { PanelKind } from '@canopy/protocol';
import {
  findPanelByInstanceKey,
  getPanelInstanceKey,
  usePanelLayoutStore,
  type PanelInstanceLocation,
} from './panel-layout-store';
import {
  createChatSiblingGroupToRight,
  pickReusableChatSiblingGroupId,
  rollbackCreatedChatSiblingGroup,
} from './sibling-panel-placement';

export const CHAT_VISUALS_PANEL_KIND = 'chat-visuals' satisfies PanelKind;
export const CHAT_VISUALS_PANEL_TITLE = 'Chat visuals';

/**
 * Points the worktree's open Chat visuals panel at `chatId`. There is one
 * such panel per layout family, so expanding a visual from another chat
 * rebinds it instead of opening a second one. Returns where the panel is, or
 * null when none is open or it could not be rebound.
 */
export function rebindChatVisualsPanel(
  worktreeKey: string,
  chatId: string,
): PanelInstanceLocation | null {
  const existing = findPanelByInstanceKey(
    worktreeKey,
    getPanelInstanceKey({ kind: CHAT_VISUALS_PANEL_KIND }),
  );
  if (!existing) return null;
  const store = usePanelLayoutStore.getState();
  const tab = store.layouts[existing.layoutKey]?.groups[
    existing.groupId
  ]?.tabs.find((candidate) => candidate.panelId === existing.panelId);
  if (!tab) return null;
  if (tab.instance?.chatId === chatId) return existing;
  return store.replaceTab(existing.layoutKey, existing.groupId, tab.panelId, {
    ...tab,
    instance: { chatId },
  })
    ? existing
    : null;
}

/**
 * Brings the panel at `location` into view: leaves a maximize held by another
 * group, which would keep this one hidden, expands its group, selects the tab,
 * and makes its group the active one.
 */
function revealChatVisualsPanel(location: PanelInstanceLocation): void {
  const store = usePanelLayoutStore.getState();
  const maximizedGroupId =
    store.layouts[location.layoutKey]?.maximizedGroupId ?? null;
  if (maximizedGroupId !== null && maximizedGroupId !== location.groupId)
    store.maximizeGroup(location.layoutKey, maximizedGroupId, false);
  store.ensureGroupExpanded(location.layoutKey, location.groupId);
  store.selectTab(location.layoutKey, location.groupId, location.panelId);
  store.focusGroup(location.layoutKey, location.groupId);
}

export interface OpenChatVisualsPanelRequest {
  /** The layout family the chat lives in. */
  readonly worktreeKey: string;
  /** The chat's panel binding, `instance.chatTabId` of its `chat` tab. */
  readonly chatTabId: string;
  /** Stored on the panel as `instance.chatId`; the host resolves it. */
  readonly chatId: string;
}

/**
 * Shows the worktree's Chat visuals panel for one chat: an open panel is
 * rebound and selected where it is; otherwise a tab is added beside the chat,
 * in the side group that content opened from chat shares, or in a new group
 * to the chat's right.
 *
 * Returns false when the chat has no panel in the layout, so there is nothing
 * to open beside, or when the tab could not be added.
 */
export function openChatVisualsPanel({
  worktreeKey,
  chatTabId,
  chatId,
}: OpenChatVisualsPanelRequest): boolean {
  const store = usePanelLayoutStore.getState();
  const existing = rebindChatVisualsPanel(worktreeKey, chatId);
  if (existing) {
    revealChatVisualsPanel(existing);
    return true;
  }

  const origin = findPanelByInstanceKey(
    worktreeKey,
    getPanelInstanceKey({ kind: 'chat', instance: { chatTabId } }),
  );
  if (!origin) return false;
  const layout = store.layouts[origin.layoutKey];
  if (!layout) return false;
  const reusableGroupId = pickReusableChatSiblingGroupId(
    layout,
    origin.groupId,
  );
  const created =
    reusableGroupId === null
      ? createChatSiblingGroupToRight(origin.layoutKey, origin.groupId)
      : null;
  const groupId = reusableGroupId ?? created?.groupId;
  if (groupId === undefined) return false;
  if (reusableGroupId !== null)
    store.ensureGroupExpanded(origin.layoutKey, groupId);
  const panelId = store.addTab(
    origin.layoutKey,
    groupId,
    CHAT_VISUALS_PANEL_KIND,
    { title: CHAT_VISUALS_PANEL_TITLE, instance: { chatId } },
  );
  if (panelId === null) {
    if (created) rollbackCreatedChatSiblingGroup(origin.layoutKey, created);
    return false;
  }
  revealChatVisualsPanel({ layoutKey: origin.layoutKey, groupId, panelId });
  return true;
}
