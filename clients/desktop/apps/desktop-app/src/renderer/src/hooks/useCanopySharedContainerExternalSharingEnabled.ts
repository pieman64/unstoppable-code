import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';

/**
 * Whether shared containers can reach people outside an organization: the
 * invite modal's Public (email) audience, personal containers for accounts
 * with no organization, and direct shares on the recipient side.
 */
export function useCanopySharedContainerExternalSharingEnabled(): boolean {
  return useFeatureFlagsStore((s) =>
    s.isEnabled(CLIENT_FEATURE_FLAGS.canopySharedContainerExternalSharing.key),
  );
}
