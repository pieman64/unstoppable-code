import type { CanopyCloudConnectSuccess } from './useCanopyCloudAuth';
import { useGitHubStore } from '@/stores/githubStore';

export const GUEST_MERGE_FAILURE_MESSAGE =
  "You're signed in, but we couldn't sync your guest work to this account.";

export function didGuestMergeFail(
  result: CanopyCloudConnectSuccess,
  confirmedGuest = false,
): boolean {
  return (
    result.guestDataMerged === false ||
    ((confirmedGuest || result.upgradedFromGuest) &&
      result.guestDataMerged !== true)
  );
}

export function showGuestMergeFailureToast(): void {
  useGitHubStore
    .getState()
    .addToast(GUEST_MERGE_FAILURE_MESSAGE, 'warning', undefined, {
      category: 'Account',
      title: 'Guest work not synced',
      persistent: true,
      forceInApp: true,
    });
}
