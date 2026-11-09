import type {
  OrgProhibitableUsageDataKey,
  UsageDataPolicySnapshot,
} from '@canopy/desktop-shared/types';

/** Lock badge text per prohibitable switch; `null` is the member's choice. */
export type UsageDataLockMap = Record<
  OrgProhibitableUsageDataKey,
  string | null
>;

/** Badge copy while the stored account can't be read (main fails closed). */
export const USAGE_DATA_UNREADABLE_LOCK =
  'Turned off until your account can be checked';

/**
 * Badge copy while the stored preferences can't be read, so the member's own
 * choice is unknown (main fails closed until a save or restart).
 */
export const USAGE_DATA_PREFERENCES_UNREADABLE_LOCK =
  'Turned off until your settings can be read';

/**
 * Map main's usage-data policy to the inline lock badge on each Usage data
 * row. A thin mapper only: main already resolved the selected workspace
 * context and the fail-closed state, so the renderer never re-resolves
 * policy. A missing snapshot (not loaded yet) locks nothing; the rows stay
 * disabled until it arrives.
 */
export function resolveUsageDataLocks(
  snapshot: UsageDataPolicySnapshot | null,
): UsageDataLockMap {
  const lockFor = (key: OrgProhibitableUsageDataKey): string | null => {
    const source = snapshot?.prohibitedBy[key];
    if (!source) {
      return null;
    }
    if (source.preferencesUnreadable) {
      return USAGE_DATA_PREFERENCES_UNREADABLE_LOCK;
    }
    return source.organizationName === null
      ? USAGE_DATA_UNREADABLE_LOCK
      : `Turned off by ${source.organizationName}`;
  };
  return {
    productAnalytics: lockFor('productAnalytics'),
    sessionReplay: lockFor('sessionReplay'),
    errorReports: lockFor('errorReports'),
    activeUseSignal: lockFor('activeUseSignal'),
    featureFlagIdentity: lockFor('featureFlagIdentity'),
  };
}
