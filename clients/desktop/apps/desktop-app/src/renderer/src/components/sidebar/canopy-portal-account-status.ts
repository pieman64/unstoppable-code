import type { CanopyPortalState } from '@canopy/desktop-shared/types';
import type { SidebarRemoteControlStatus } from '@canopy/ui-app';

/**
 * Maps the Portal worker snapshot onto the account row's Remote Control line
 * (CAN-3659). It replaced the sidebar nav row's status tint, so it keeps that
 * tint's state branches (the ink is the shared subtitle's): only a session
 * that actually connected can read as disconnected, and a never-paired account
 * reads as off (`null`), which makes the row show the account email instead.
 *
 * The flag guard comes first because the store keeps its last snapshot after
 * `canopy-portal-enabled` flips off.
 */
export function resolveCanopyPortalAccountStatus(
  state: Pick<
    CanopyPortalState,
    'activatedAt' | 'connectionStatus' | 'lastSeenAt' | 'status'
  >,
  enabled: boolean,
): SidebarRemoteControlStatus | null {
  if (!enabled) return null;

  if (state.status === 'active' || state.connectionStatus === 'active') {
    return 'active';
  }

  if (
    state.status === 'reconnecting' ||
    state.connectionStatus === 'reconnecting'
  ) {
    return 'reconnecting';
  }

  const hasActuallyConnected = Boolean(state.activatedAt || state.lastSeenAt);
  if (!hasActuallyConnected && state.status !== 'inactive') {
    return null;
  }

  if (
    state.status === 'error' ||
    state.connectionStatus === 'inactive' ||
    state.connectionStatus === 'ended'
  ) {
    return 'disconnected';
  }

  return null;
}
