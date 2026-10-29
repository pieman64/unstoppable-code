import {
  makeWorktreePanelKey,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
import { useChatStore } from '@/stores/chatStore';
import { getWorkspaceLayoutMode } from '@/stores/workspaceLayoutModeStore';
import { ensureMinimalDestination } from './minimal-layout';
import {
  DEFAULT_ACTIVITY_GROUP_ID,
  DEFAULT_EXTRAS_GROUP_ID,
} from './panel-group-ids';
import {
  findSubagentsPanel,
  openSubagentsPanel,
  type SubagentPanelScope,
} from './subagent-panel-open';

/**
 * Shows the worktree's Subagents panel in the right sidebar: the Side Panel
 * of a Minimal layout (ensured, as the Activity card's rows do), or the
 * right-hand column of an Advanced one (its Side Panel, else its Activity
 * column) when it has one, on the current chat with the Active filter. A
 * Subagents panel that is already open is revealed where it is.
 */
export function openSubagentsInSidePanel(scope: SubagentPanelScope): void {
  // It opens on the current chat's subagents that are still at work, as the
  // chat's Agent activity section showed them. The view-state store loads
  // with the panel, so it is set once that module is in.
  const scopeKey = `${scope.projectId}/${scope.worktreeId}`;
  const currentChatId =
    useChatStore.getState().worktreeChats[scopeKey]?.activeTabId;
  void import('@canopy/ui-app/subagents')
    .then(({ useSubagentViewStateStore }): void => {
      const viewState = useSubagentViewStateStore.getState();
      if (currentChatId) viewState.setSelectedRoot(scopeKey, currentChatId);
      viewState.setFilter(scopeKey, 'active');
    })
    .catch((): void => undefined);
  if (findSubagentsPanel(scope) !== null) {
    void openSubagentsPanel(scope);
    return;
  }
  const worktreeKey = makeWorktreePanelKey(scope.projectId, scope.worktreeId);
  if (getWorkspaceLayoutMode(worktreeKey) === 'minimal') {
    const groupId =
      ensureMinimalDestination(worktreeKey, 'subagents') ??
      DEFAULT_EXTRAS_GROUP_ID;
    void openSubagentsPanel(scope, { intent: { groupId } });
    return;
  }
  // Advanced: the right-hand column is the Side Panel when the layout has
  // one, else the Activity column beside the chat.
  const groups = usePanelLayoutStore.getState().layouts[worktreeKey]?.groups;
  const groupId = [DEFAULT_EXTRAS_GROUP_ID, DEFAULT_ACTIVITY_GROUP_ID].find(
    (id) => groups?.[id] !== undefined,
  );
  void openSubagentsPanel(scope, {
    intent: groupId === undefined ? 'auto' : { groupId },
  });
}
