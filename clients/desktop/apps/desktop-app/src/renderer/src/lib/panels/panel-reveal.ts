/**
 * Shared panel reveal seam.
 *
 * Bringing one panel into view is more than selecting its tab: a different
 * maximized group would keep the panel's group hidden, a collapsed group
 * would show only its icon bar, and a panel pulled out into an auxiliary
 * window lives behind that window. `revealPanel` handles all three for the
 * content-panel opener and terminal activation.
 *
 * Logical focus (active group / MRU) is set here; DOM focus is deliberately
 * left to the surfaces themselves (the terminal caret, panel-focus.ts) so a
 * reveal never races a surface's own focus request.
 */
import {
  getAuxPanelLayoutOwnerKey,
  usePanelLayoutStore,
  type PanelInstanceLocation,
} from '@/stores/panelLayoutStore';
import {
  usePanelWindowsStore,
  type PanelAuxWindowRecord,
} from '@/stores/panelWindowsStore';

export interface RevealPanelOptions {
  /**
   * `false` makes the reveal a no-op, for passive callers such as layout
   * hydration that must not steal selection. Defaults to `true`.
   */
  readonly focus?: boolean;
  /**
   * `false` keeps an owning auxiliary window where it is. Defaults to `true`:
   * a panel revealed inside a pulled-out window brings that window forward.
   */
  readonly focusWindow?: boolean;
}

/**
 * Reveals a panel at `location`: exits a maximize held by ANOTHER group,
 * expands the panel's group if it is collapsed, selects the tab, makes its
 * group the active group, and focuses the auxiliary window that hosts it.
 * A maximize held by the panel's own group is kept.
 */
export function revealPanel(
  location: PanelInstanceLocation,
  options: RevealPanelOptions = {},
): void {
  if (options.focus === false) return;
  const store = usePanelLayoutStore.getState();
  const maximizedGroupId =
    store.layouts[location.layoutKey]?.maximizedGroupId ?? null;
  if (maximizedGroupId !== null && maximizedGroupId !== location.groupId) {
    store.maximizeGroup(location.layoutKey, maximizedGroupId, false);
  }
  store.ensureGroupExpanded(location.layoutKey, location.groupId);
  store.selectTab(location.layoutKey, location.groupId, location.panelId);
  store.focusGroup(location.layoutKey, location.groupId);
  if (options.focusWindow !== false) {
    focusAuxWindowForLayout(location.layoutKey);
  }
}

/** The live auxiliary window record rendering `layoutKey`, if any. */
export function findAuxWindowForLayout(
  layoutKey: string,
): PanelAuxWindowRecord | null {
  const records = Object.values(usePanelWindowsStore.getState().auxWindows);
  return records.find((record) => record.layoutKey === layoutKey) ?? null;
}

/**
 * Brings the auxiliary window rendering `layoutKey` forward. Returns whether
 * a window was asked to focus: main-window layouts, windows being merged
 * back, and closed windows are skipped. OS focus only takes effect in a shown
 * window (headless windows are never OS-focused). The windows store owns the
 * window records, so it owns the focus step too.
 */
export function focusAuxWindowForLayout(layoutKey: string): boolean {
  return usePanelWindowsStore.getState().focusAuxWindowForLayout(layoutKey);
}

/**
 * Finds a panel by id across `worktreeKey`'s layout family: the main layout
 * first, then auxiliary layouts in insertion order.
 */
export function findPanelLocation(
  worktreeKey: string,
  panelId: string,
): PanelInstanceLocation | null {
  const layouts = usePanelLayoutStore.getState().layouts;
  const familyKeys = [
    worktreeKey,
    ...Object.keys(layouts).filter(
      (layoutKey) => getAuxPanelLayoutOwnerKey(layoutKey) === worktreeKey,
    ),
  ];
  for (const layoutKey of familyKeys) {
    const groups = layouts[layoutKey]?.groups ?? {};
    for (const [groupId, group] of Object.entries(groups)) {
      if (group.tabs.some((tab) => tab.panelId === panelId)) {
        return { layoutKey, groupId, panelId };
      }
    }
  }
  return null;
}
