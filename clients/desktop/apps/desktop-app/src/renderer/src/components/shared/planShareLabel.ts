import type { TrackedPlanData } from '@canopy/desktop-shared/types';

/**
 * Whether the plan has a share anyone else can see. `private` is only a
 * storage value (a legacy private-only cloud copy that list endpoints hide),
 * so such a plan reads as unshared and Share opens the scope picker.
 */
export function hasVisiblePlanShare(
  plan: Pick<TrackedPlanData, 'share'>,
): boolean {
  return plan.share !== undefined && plan.share.shareScope !== 'private';
}

/**
 * Visible Share-button label derived from the persisted sync status plus the
 * in-flight explicit click. The explicit `Sharing...` click state takes
 * precedence so a stale persisted status never masks it; otherwise the label
 * follows the background `trackedPlansUpdated`-driven sync status.
 */
export function shareButtonLabel(
  plan: Pick<TrackedPlanData, 'share'>,
  sharing: boolean,
): string {
  if (sharing) {
    return 'Sharing…';
  }
  if (!hasVisiblePlanShare(plan)) {
    return 'Share';
  }
  switch (plan.share?.syncStatus) {
    case 'pending':
    case 'syncing':
      return 'Syncing…';
    case 'synced':
      return 'Shared';
    case 'error':
      return 'Try sharing again';
    default:
      return 'Share';
  }
}
