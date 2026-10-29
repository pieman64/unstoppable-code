import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';

/**
 * Whether the recipient may be offered the run affordance for a shared
 * container (CAN-2831).
 *
 * Two conditions, both required, mirroring `assertSharedContainerRunEnabled`
 * in main:
 *
 * 1. The shared-container feature itself is on. Running is an extension of the
 *    viewer, so it can never outlive it.
 * 2. The platform is macOS. Windows is deliberately out of scope for the MVP
 *    (`chmod` is a no-op, run-copy paths hit length limits, and `EBUSY` on
 *    refresh is unsolved), so the affordance is gated off rather than shipped
 *    broken.
 *
 * There is no separate run flag: running ships with the viewer. The real gates
 * on execution are the publisher's explicit opt-in at publish time and the
 * recipient's per-share consent, which main re-checks on every spawn. This
 * hook is a visibility gate only.
 */
export function useCanopyDesktopSharedContainerRunEnabled(): boolean {
  const sharedContainersEnabled = useFeatureFlagsStore((s) =>
    s.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopSharedContainers.key),
  );
  return sharedContainersEnabled && isMacOs();
}

/**
 * Platform check kept as a function rather than a module constant so tests can
 * exercise both branches without reloading the module graph.
 */
function isMacOs(): boolean {
  return window.platform === 'darwin';
}
