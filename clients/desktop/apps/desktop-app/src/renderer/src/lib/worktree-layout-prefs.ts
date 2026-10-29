export type { WorktreeViewMode } from '@canopy/ui-app/panel-contexts';
import type { WorktreeViewMode } from '@canopy/ui-app/panel-contexts';

let currentChatPanelVisible = true;
const chatPanelVisibilityListeners = new Set<() => void>();

export function setCurrentChatPanelVisible(visible: boolean): void {
  if (currentChatPanelVisible === visible) {
    return;
  }
  currentChatPanelVisible = visible;
  chatPanelVisibilityListeners.forEach((listener) => listener());
}

export function getCurrentChatPanelVisible(): boolean {
  return currentChatPanelVisible;
}

export function subscribeChatPanelVisibility(listener: () => void): () => void {
  chatPanelVisibilityListeners.add(listener);
  return (): void => {
    chatPanelVisibilityListeners.delete(listener);
  };
}

function worktreePanelPercentKey(
  mode: WorktreeViewMode,
): 'worktreePanelPercent' | 'kanbanWorktreePanelPercent' {
  return mode === 'list'
    ? 'worktreePanelPercent'
    : 'kanbanWorktreePanelPercent';
}

function activityPanelExpandedKey(
  mode: WorktreeViewMode,
): 'activityPanelExpanded' | 'kanbanActivityPanelExpanded' {
  return mode === 'list'
    ? 'activityPanelExpanded'
    : 'kanbanActivityPanelExpanded';
}

export function saveActivityPanelExpanded(
  mode: WorktreeViewMode,
  expanded: boolean,
): void {
  void window.api.savePreferences({
    [activityPanelExpandedKey(mode)]: expanded,
  });
}

export function saveWorktreePanelPercent(
  mode: WorktreeViewMode,
  percent: number,
): void {
  void window.api.savePreferences({
    [worktreePanelPercentKey(mode)]: percent,
  });
}
