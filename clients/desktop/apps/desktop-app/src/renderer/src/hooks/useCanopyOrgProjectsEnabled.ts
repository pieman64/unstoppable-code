import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';

/**
 * Returns whether the `canopy-shared-org-projects-enabled` flag is on.
 *
 * Gates the organization projects surfaces (CAN-611): the Personal/organization
 * context switcher, org project catalog rows, and the org-mode Add project
 * flow. Renderer reads are presentation only; the main process and the server
 * re-check the same flag (and the `org-projects-v1` capability) at every
 * operation boundary.
 */
export function useCanopyOrgProjectsEnabled(): boolean {
  return useFeatureFlagsStore((s) =>
    s.isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key),
  );
}
