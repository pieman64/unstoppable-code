/**
 * The sidebar nav model now lives in `@canopy/protocol/sidebar` so the web
 * portal sidebar can render the same nav item set as the desktop app —
 * `apps/web` may not import `@canopy/desktop-shared`. This module stays as the
 * desktop-facing entry point so existing call sites keep their import path.
 */
export {
  DEFAULT_SIDEBAR_NAV_LAYOUT,
  LEGACY_DEFAULT_SIDEBAR_NAV_LAYOUT,
  SIDEBAR_NAV_ITEM_KEYS,
  createDefaultSidebarNavLayout,
  isLegacyDefaultSidebarNavLayout,
  reconcileSidebarNavLayout,
} from '@canopy/protocol/sidebar';

import {
  splitSidebarNavLayout,
  type SidebarNavLayout,
} from '@canopy/protocol/sidebar';

/** Desktop visibility gates for sidebar nav keys. */
export interface SidebarNavVisibilityOptions {
  workersVisible?: boolean;
  /** Whether the Agent Ledger is on; the Feed is hidden while it is off. */
  ledgerEnabled?: boolean;
  /**
   * Keys owned by Labs experiments that are off. Hidden like any other gate;
   * their stored positions are kept so turning the experiment on restores
   * them in place.
   */
  experimentHiddenKeys?: readonly string[];
}

/**
 * The desktop app's visibility policy for one nav key in the reorderable
 * regions: `remote-control` is never listed (the web rail renders it; desktop
 * reports Remote Control on the account row and opens it from the account
 * menu, CAN-3659), `agents` is hidden when shared custom agents are off,
 * `workers` when Claude Workers is not available, `feed` while the Ledger is
 * off, and the
 * {@link SidebarNavVisibilityOptions.experimentHiddenKeys} of experiments
 * that are off.
 *
 * Deliberately lives here rather than in `@canopy/protocol`: which keys a host
 * renders is presentation policy driven by that host's feature flags, not part
 * of the persisted wire contract.
 */
export function isSidebarNavKeyVisible(
  key: string,
  opts: SidebarNavVisibilityOptions,
): boolean {
  return (
    key !== 'remote-control' &&
    (key !== 'workers' || opts.workersVisible === true) &&
    (key !== 'feed' || opts.ledgerEnabled === true) &&
    opts.experimentHiddenKeys?.includes(key) !== true
  );
}

/**
 * Apply {@link isSidebarNavKeyVisible} to each region of a split layout,
 * keeping the stored order and the Sidebar/More boundary. Stored positions of
 * hidden keys are untouched.
 */
export function deriveSidebarNavRegions(
  layout: SidebarNavLayout,
  opts: SidebarNavVisibilityOptions,
): { mainNav: string[]; more: string[] } {
  const visible = (key: string): boolean => isSidebarNavKeyVisible(key, opts);
  const regions = splitSidebarNavLayout(layout);
  return {
    mainNav: regions.mainNav.filter(visible),
    more: regions.more.filter(visible),
  };
}
