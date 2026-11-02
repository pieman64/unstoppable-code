/** The parts of a sidebar nav row's action that decide what a click does. */
export interface SidebarNavItemActivation {
  /** The row is the current destination. */
  readonly active?: boolean;
  /** Enters the row's section. */
  readonly onSelect?: () => void;
  /**
   * Returns the current row's section to its root, the same as entering it
   * fresh. The host asks its unsaved-changes guard first.
   */
  readonly onReturnToRoot?: () => void;
}

/**
 * One rule for every sidebar nav row on desktop and web: a click on a row
 * that is not current enters its section, and a click on the current row
 * returns that section to its root (2026-10-22). A host with no root to
 * return to selects the row again.
 */
export function activateSidebarNavItem(
  activation: SidebarNavItemActivation,
): void {
  if (activation.active === true && activation.onReturnToRoot) {
    activation.onReturnToRoot();
    return;
  }
  activation.onSelect?.();
}
