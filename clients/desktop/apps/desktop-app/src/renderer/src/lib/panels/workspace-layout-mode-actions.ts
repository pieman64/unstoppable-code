import type { WorkspaceLayoutMode } from '@canopy/desktop-shared/types';
import {
  setPanelLayoutFixedTopology,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
import { usePanelWindowsStore } from '@/stores/panelWindowsStore';
import {
  getWorkspaceLayoutMode,
  useWorkspaceLayoutModeStore,
} from '@/stores/workspaceLayoutModeStore';
import {
  hideOptionalMinimalRegions,
  planMinimalLayout,
} from './minimal-layout';
import { earlyAccessMinimalFor } from './early-access-minimal';
import { DEFAULT_TERMINAL_GROUP_ID } from './panel-group-ids';

/** Worktrees with a mode transition in flight. */
const pendingTransitions = new Set<string>();

/** Whether a mode transition for this worktree has not settled yet. */
export function isWorkspaceLayoutModeTransitionPending(
  worktreeKey: string,
): boolean {
  return pendingTransitions.has(worktreeKey);
}

/**
 * Applies the per-worktree mode transition used by the layout controls and
 * persists it as the worktree's own mode.
 */
export async function setWorkspacePanelLayoutMode(
  worktreeKey: string,
  mode: WorkspaceLayoutMode,
): Promise<boolean> {
  if (getWorkspaceLayoutMode(worktreeKey) === mode) return true;
  pendingTransitions.add(worktreeKey);
  try {
    return await runTransition(worktreeKey, mode, () =>
      useWorkspaceLayoutModeStore.getState().save(worktreeKey, mode),
    );
  } finally {
    pendingTransitions.delete(worktreeKey);
  }
}

/**
 * The Advanced transition only changes policy. The Minimal transition first
 * folds auxiliary windows into the main grid, then atomically applies the
 * fixed three-section plan and commits the policy, rolling the layout family
 * back if any step fails.
 */
async function runTransition(
  worktreeKey: string,
  mode: WorkspaceLayoutMode,
  commit: () => Promise<void>,
): Promise<boolean> {
  if (mode === 'advanced') {
    try {
      await commit();
      return true;
    } catch {
      return false;
    }
  }

  const store = usePanelLayoutStore.getState();
  const current = store.serializeLayout(worktreeKey);
  if (current === null) return false;
  const auxiliarySnapshots = Object.values(
    usePanelWindowsStore.getState().auxWindows,
  )
    .filter((record) => record.worktreeKey === worktreeKey)
    .map((record) => ({
      record,
      layout: store.serializeLayout(record.layoutKey),
    }))
    .filter(
      (
        entry,
      ): entry is typeof entry & {
        layout: NonNullable<typeof entry.layout>;
      } => entry.layout !== null,
    );
  const plan = planMinimalLayout(
    current,
    auxiliarySnapshots.map(({ layout, record }) => ({
      layout,
      sourceWasBottom:
        record.sourceGroupId === DEFAULT_TERMINAL_GROUP_ID ||
        record.returnTarget?.direction === 'down',
    })),
    { seedSidePanels: !earlyAccessMinimalFor(worktreeKey) },
  );

  setPanelLayoutFixedTopology(worktreeKey, true);
  try {
    for (const { record } of auxiliarySnapshots) {
      if (
        !store.adoptLayoutTabs(record.layoutKey, worktreeKey, {
          preferredGroupId: record.sourceGroupId,
          fallbackAnchorGroupId: record.returnTarget?.anchorGroupId,
          fallbackDirection: record.returnTarget?.direction,
          fallbackSize: record.returnTarget?.size,
        })
      ) {
        throw new Error('auxiliary adoption failed');
      }
    }
    // Early access opens Minimal on Chat alone; the user reveals the Side
    // Panel or Bottom Drawer when they want them. This runs only for a
    // switch the user asked for, never because early access turned on.
    const target = earlyAccessMinimalFor(worktreeKey)
      ? hideOptionalMinimalRegions(plan.layout)
      : plan.layout;
    if (!store.restoreLayout(worktreeKey, target)) {
      throw new Error('layout apply failed');
    }
    await commit();
    usePanelWindowsStore.getState().disposeWorktreeAuxWindows(worktreeKey);
    return true;
  } catch {
    store.restoreLayout(worktreeKey, current);
    for (const { record, layout } of auxiliarySnapshots) {
      store.restoreLayout(record.layoutKey, layout);
    }
    setPanelLayoutFixedTopology(worktreeKey, false);
    return false;
  }
}
