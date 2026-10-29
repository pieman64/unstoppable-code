import {
  findPanelByInstanceKey,
  getPanelInstanceKey,
  makeWorktreePanelKey,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';

/**
 * Shows a scope's Ledger panel: selects and focuses it when the layout has
 * one (the kind is a scope singleton), and otherwise adds it to the active
 * group. False when the scope's layout is not built yet.
 */
export function openLedgerPanel(
  projectId: string,
  worktreeId: string,
): boolean {
  const worktreeKey = makeWorktreePanelKey(projectId, worktreeId);
  const store = usePanelLayoutStore.getState();
  const existing = findPanelByInstanceKey(
    worktreeKey,
    getPanelInstanceKey({ kind: 'ledger', instance: undefined }),
  );
  if (existing !== null) {
    store.ensureGroupExpanded(existing.layoutKey, existing.groupId);
    store.selectTab(existing.layoutKey, existing.groupId, existing.panelId, {
      focus: true,
    });
    store.focusGroup(existing.layoutKey, existing.groupId);
    return true;
  }
  const layout = store.layouts[worktreeKey];
  const groupId = layout?.activeGroupId ?? null;
  if (layout === undefined || groupId === null || !layout.groups[groupId]) {
    return false;
  }
  return store.addTab(worktreeKey, groupId, 'ledger') !== null;
}
