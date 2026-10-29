import type { PanelDropEdge, PanelSplitDirection } from '@canopy/protocol';
import { usePanelLayoutStore } from './panel-layout-store';

export function splitDirectionToDropEdge(
  direction: PanelSplitDirection,
): PanelDropEdge {
  switch (direction) {
    case 'up':
      return 'top';
    case 'down':
      return 'bottom';
    case 'left':
      return 'left';
    case 'right':
      return 'right';
  }
}

/**
 * Split a group from the chrome menu. When the group has multiple tabs, this
 * mirrors editor split behavior by moving the active tab into the new split.
 * A single-tab group, or an active tab the store will not move into a split
 * (a chat kept in the chat group), keeps the empty-split behavior.
 */
export function splitGroupMovingActiveTab(
  layoutKey: string,
  groupId: string,
  direction: PanelSplitDirection,
): void {
  const store = usePanelLayoutStore.getState();
  const group = store.layouts[layoutKey]?.groups[groupId];

  const edge = splitDirectionToDropEdge(direction);
  if (
    group !== undefined &&
    group.tabs.length > 1 &&
    group.activePanelId !== null &&
    store.canMovePanel(layoutKey, group.activePanelId, groupId, edge)
  ) {
    store.movePanel(layoutKey, group.activePanelId, groupId, edge);
    return;
  }

  store.splitGroup(layoutKey, groupId, direction);
}
