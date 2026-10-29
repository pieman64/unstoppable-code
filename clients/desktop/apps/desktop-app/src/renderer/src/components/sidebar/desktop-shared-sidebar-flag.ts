export const DESKTOP_SHARED_SIDEBAR_STORAGE_KEY =
  'canopy.desktop.sharedSidebar';

/**
 * Reads the hidden shared-sidebar switch. Callers intentionally latch this for
 * the sidebar lifetime so localStorage changes require a reload and cannot swap
 * the mounted sidebar implementation mid-session.
 *
 * A build that sets the `__CANOPY_DESKTOP_SHARED_SIDEBAR__` define pins the
 * shared rail on; the `'0'` escape hatch below applies only to builds without
 * that define (every default build).
 */
export function isDesktopSharedSidebarEnabled(): boolean {
  if (__CANOPY_DESKTOP_SHARED_SIDEBAR__) return true;
  try {
    // Default ON (CAN-3053 flag flip): the shared surface is the desktop rail.
    // '0' keeps the legacy section as an escape hatch until it is removed.
    return (
      window.localStorage.getItem(DESKTOP_SHARED_SIDEBAR_STORAGE_KEY) !== '0'
    );
  } catch {
    return true;
  }
}
