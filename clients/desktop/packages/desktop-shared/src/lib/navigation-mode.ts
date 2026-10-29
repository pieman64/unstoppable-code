import type { ProfileRoleId } from '@canopy/protocol/plugin-catalog';
import type { NavigationMode } from '../types/navigation-mode';

export {
  isNavigationMode,
  NAVIGATION_MODES,
  type NavigationMode,
} from '../types/navigation-mode';

/**
 * Roles that read as software engineering. They keep the repository,
 * branch, and worktree controls developers expect; every other role starts
 * in Work mode. Mirrors the roles that also default to the advanced panel
 * layout, so the two role-derived defaults never disagree.
 */
export const CODE_MODE_PROFILE_ROLES: ReadonlySet<ProfileRoleId> =
  new Set<ProfileRoleId>(['software-engineer', 'engineering-leader']);

/**
 * Initial navigation mode for a submitted primary role (CAN-1817). No role
 * selected (a skipped onboarding step) keeps the Code default so an existing
 * developer install never loses controls it had before the preference
 * existed.
 */
export function navigationModeForRole(
  role: ProfileRoleId | null | undefined,
): NavigationMode {
  if (role === null || role === undefined) return 'code';
  return CODE_MODE_PROFILE_ROLES.has(role) ? 'code' : 'work';
}
