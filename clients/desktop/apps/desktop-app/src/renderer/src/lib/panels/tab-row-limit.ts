/**
 * Desktop side of the per-group tab limit (the panel layout store's
 * `tabRowLimit`). Filled tab rows never scroll. Actions the user starts
 * into a specific group (the `+`, the add menu, New Terminal/Browser) check
 * BEFORE creating the entity the tab would show, so a full row refuses with a
 * note instead of leaving a chat or terminal session without a tab.
 */
import { useGitHubStore } from '@/stores/githubStore';
import { usePanelLayoutStore } from '@/stores/panelLayoutStore';
import {
  hasRoomForTab,
  MAX_TABS_PER_GROUP,
  PANEL_TAB_ROW_FULL_NOTE,
} from '@canopy/ui-shared/panels';
/** Filled panel tabs always enforce the shared row limit. */
export function ensureTabRowLimitSync(): void {
  usePanelLayoutStore.getState().setTabRowLimit(MAX_TABS_PER_GROUP);
}

/** Test-only: restore the store before the next initialization. */
export function resetTabRowLimitSyncForTest(): void {
  usePanelLayoutStore.getState().setTabRowLimit(null);
}

/** Shows the full-row note, once at a time. */
export function notifyTabRowFull(): void {
  const github = useGitHubStore.getState();
  if (
    github.toasts.some((toast) => toast.message === PANEL_TAB_ROW_FULL_NOTE)
  ) {
    return;
  }
  github.addToast(PANEL_TAB_ROW_FULL_NOTE, 'info', undefined, {
    // Feedback to the user's own gesture, not a notification.
    forceInApp: true,
    suppressOsNotification: true,
  });
}

/** The tab the surface being opened replaces (a New tab), if any. */
let replacedPanelId: string | null = null;

/**
 * Runs `open` (which checks {@link refuseFullTabRow} synchronously, before
 * its first await) as the replacement for tab `panelId`: that tab closes
 * once the new one opens, so it does not count toward its row's limit.
 */
export function openReplacingTab<T>(panelId: string, open: () => T): T {
  const previous = replacedPanelId;
  replacedPanelId = panelId;
  try {
    return open();
  } finally {
    replacedPanelId = previous;
  }
}

/**
 * Returns `true` (and shows the note) when `groupId` in `layoutKey` is full,
 * so the caller stops before creating anything. An unknown group is not
 * "full": the caller's own missing-group handling applies. Inside
 * {@link openReplacingTab}, the tab being replaced does not count.
 */
export function refuseFullTabRow(layoutKey: string, groupId: string): boolean {
  const store = usePanelLayoutStore.getState();
  const group = store.layouts[layoutKey]?.groups[groupId];
  if (group === undefined || store.canAddTabToGroup(layoutKey, groupId)) {
    return false;
  }
  const replaced = replacedPanelId;
  if (
    replaced !== null &&
    hasRoomForTab(
      { tabs: group.tabs.filter((tab) => tab.panelId !== replaced) },
      store.tabRowLimit,
    )
  ) {
    return false;
  }
  notifyTabRowFull();
  return true;
}
