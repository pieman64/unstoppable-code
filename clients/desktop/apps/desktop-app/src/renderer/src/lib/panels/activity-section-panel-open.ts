import {
  findPanelByInstanceKey,
  getPanelInstanceKey,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
import { getActivitySectionDefinition } from '@/components/activity/activity-sections';
import { getWorkspaceLayoutMode } from '@/stores/workspaceLayoutModeStore';
import { ensureMinimalDestination } from './minimal-layout';
import { DEFAULT_EXTRAS_GROUP_ID } from './panel-group-ids';
import { revealPanel } from './panel-reveal';
import {
  COST_PANEL_ID,
  COST_PANEL_TITLE,
  costPanelSeed,
} from '@/lib/cost/open-cost-panels';

/**
 * Narrows a group to its minimum width, keeping its height.
 */
function fitGroupToMinimumWidth(worktreeKey: string, groupId: string): void {
  const store = usePanelLayoutStore.getState();
  const layout = store.layouts[worktreeKey];
  const view = layout?.leafViews.get(groupId);
  if (!layout || !view) return;
  const { height } = layout.grid.getViewSize(view);
  store.resizeGroup(worktreeKey, groupId, {
    width: view.minimumWidth,
    height,
  });
}

/**
 * Opens one Activity section as its own tab in the Side Panel, or reveals the
 * tab when the section is already open somewhere in the worktree. The Activity
 * card's rows use it, so the card stays a short list and each section gets
 * the room of a panel. `false` when the section has no panel of its own, the
 * layout is Advanced (no Side Panel), or the Side Panel cannot take a tab;
 * the caller then shows the section in place.
 *
 * A Side Panel that held nothing before (no tab but its New tab placeholder)
 * opens at its minimum width, with the section in place of the New tab: the
 * section is a side view of the chat, so the chat keeps the room. One that
 * already holds real tabs keeps them, and the width the user gave it.
 */
export function openActivitySectionInSidePanel(
  worktreeKey: string,
  sectionId: string,
): boolean {
  if (sectionId === 'cost') {
    return openCostSectionInSidePanel(worktreeKey);
  }
  const definition = getActivitySectionDefinition(sectionId);
  if (definition === undefined) return false;
  const instance = { sectionId };
  const existing = findPanelByInstanceKey(
    worktreeKey,
    getPanelInstanceKey({ kind: 'activity-card', instance }),
  );
  if (existing !== null) {
    revealPanel(existing);
    return true;
  }
  // Only Minimal has a Side Panel to open in; there, the destination is
  // ensured (and the layout repaired if needed). An Advanced layout is the
  // user's own arrangement, so the row opens in place instead.
  if (getWorkspaceLayoutMode(worktreeKey) !== 'minimal') return false;
  const groupId =
    ensureMinimalDestination(worktreeKey, 'activity-card') ??
    DEFAULT_EXTRAS_GROUP_ID;
  // An emptied Side Panel still holds a New tab (its placeholder), so
  // "empty" means no tab but New tabs.
  const tabsBefore =
    usePanelLayoutStore.getState().layouts[worktreeKey]?.groups[groupId]
      ?.tabs ?? [];
  const wasEmpty = tabsBefore.every((tab) => tab.kind === 'new-tab');
  const panelId = usePanelLayoutStore
    .getState()
    .addTab(worktreeKey, groupId, 'activity-card', {
      instance,
      title: definition.title,
    });
  if (panelId === null) return false;
  revealPanel({ layoutKey: worktreeKey, groupId, panelId });
  if (wasEmpty) {
    // The section replaces the placeholder rather than sitting beside it.
    for (const tab of tabsBefore) {
      usePanelLayoutStore
        .getState()
        .closeTab(worktreeKey, groupId, tab.panelId);
    }
    fitGroupToMinimumWidth(worktreeKey, groupId);
  }
  return true;
}

/** Cost is a singleton content panel, not an `activity-card` section tab. */
function openCostSectionInSidePanel(worktreeKey: string): boolean {
  // Advanced has no Side Panel. In that layout the card row expands in place,
  // even if an unrelated Cost panel happens to exist in another group.
  if (getWorkspaceLayoutMode(worktreeKey) !== 'minimal') return false;

  const seed = costPanelSeed();
  const instance = seed.instance ?? {};
  const existing = findPanelByInstanceKey(
    worktreeKey,
    getPanelInstanceKey({ kind: seed.kind, instance }),
  );
  if (existing !== null) {
    revealPanel(existing);
    return true;
  }

  const groupId =
    ensureMinimalDestination(worktreeKey, seed.kind) ?? DEFAULT_EXTRAS_GROUP_ID;
  const tabsBefore =
    usePanelLayoutStore.getState().layouts[worktreeKey]?.groups[groupId]
      ?.tabs ?? [];
  const wasEmpty = tabsBefore.every((tab) => tab.kind === 'new-tab');
  const store = usePanelLayoutStore.getState();
  const options = {
    title: COST_PANEL_TITLE,
    ...(Object.keys(instance).length > 0 ? { instance } : {}),
  };
  const panelId =
    store.addTab(worktreeKey, groupId, seed.kind, {
      ...options,
      panelId: COST_PANEL_ID,
    }) ?? store.addTab(worktreeKey, groupId, seed.kind, options);
  if (panelId === null) return false;

  revealPanel({ layoutKey: worktreeKey, groupId, panelId });
  if (wasEmpty) {
    for (const tab of tabsBefore) {
      store.closeTab(worktreeKey, groupId, tab.panelId);
    }
    fitGroupToMinimumWidth(worktreeKey, groupId);
  }
  return true;
}
