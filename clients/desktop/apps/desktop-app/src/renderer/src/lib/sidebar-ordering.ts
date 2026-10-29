import type {
  CoworkWorkEntryMeta,
  SidebarItem,
  SidebarSortMode,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import {
  orderSidebarRows,
  toRecencyMs,
  orderWorkEntryRows as orderSharedWorkEntryRows,
  workEntryRecencyMs as sharedWorkEntryRecencyMs,
} from '@canopy/ui-app/sidebar';

/**
 * Desktop's typed entry points to the shared sidebar ordering (CAN-1074).
 *
 * The generic ordering, sort-mode helpers, and Work Entry recency live in
 * `@canopy/ui-app/sidebar` so the desktop rail and the web portal order the
 * same rows the same way (CAN-3053). This module re-exports them for desktop
 * callers and keeps the orderings that read desktop-only persisted types
 * (worktrees and top-level sidebar workspaces).
 */
export {
  canDragSidebarRow,
  DEFAULT_SIDEBAR_SORT_MODE,
  orderSidebarRows,
  resolveSidebarSortMode,
  toRecencyMs,
  type OrderSidebarRowsOptions,
} from '@canopy/ui-app/sidebar';

/**
 * Activity watermark for a worktree row. `lastTouchedAt` is main's durable
 * activity watermark; `createdAt` is the floor for a worktree that has not
 * been touched since creation.
 */
export function worktreeRecencyMs(worktree: WorktreeData): number | undefined {
  return toRecencyMs(worktree.lastTouchedAt) ?? toRecencyMs(worktree.createdAt);
}

/** Activity watermark for a cowork Work Entry row. */
export function workEntryRecencyMs(
  entry: CoworkWorkEntryMeta,
): number | undefined {
  return sharedWorkEntryRecencyMs(entry);
}

/**
 * Activity watermark for a top-level sidebar workspace: the most recent
 * activity across its worktrees.
 *
 * Cowork workspaces carry a persisted aggregate watermark. A caller may also
 * supply a fresher live value through `overrides` (derived from loaded Work
 * Entry metadata); the newer of the two wins. A legacy workspace with neither
 * value keeps its manual slot — see {@link orderSidebarRows}.
 */
export function workspaceRecencyMs(
  item: SidebarItem,
  overrides?: ReadonlyMap<string, number>,
): number | undefined {
  const override = overrides?.get(item.id);
  if (item.type === 'cowork') {
    const persisted = toRecencyMs(item.lastActivityAt);
    if (persisted === undefined) return override;
    if (override === undefined) return persisted;
    return Math.max(persisted, override);
  }
  let latest: number | undefined;
  for (const worktree of item.worktrees) {
    const recency = worktreeRecencyMs(worktree);
    if (recency !== undefined && (latest === undefined || recency > latest)) {
      latest = recency;
    }
  }
  return latest;
}

/** Order the top-level Projects list by pin state then the section's mode. */
export function orderSidebarWorkspaces(
  items: readonly SidebarItem[],
  mode: SidebarSortMode | undefined,
  recencyOverrides?: ReadonlyMap<string, number>,
): SidebarItem[] {
  return orderSidebarRows(items, {
    mode,
    isPinned: (item) => item.pinned === true,
    recencyMs: (item) => workspaceRecencyMs(item, recencyOverrides),
  });
}

/** Order a code workspace's worktree rows. */
export function orderWorktreeRows(
  worktrees: readonly WorktreeData[],
  mode: SidebarSortMode | undefined,
): WorktreeData[] {
  return orderSidebarRows(worktrees, {
    mode,
    isPinned: (worktree) => worktree.pinned === true,
    recencyMs: worktreeRecencyMs,
  });
}

/** Order a cowork workspace's Work Entry rows. */
export function orderWorkEntryRows(
  entries: readonly CoworkWorkEntryMeta[],
  mode: SidebarSortMode | undefined,
): CoworkWorkEntryMeta[] {
  return orderSharedWorkEntryRows(entries, mode);
}
