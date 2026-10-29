import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';

/**
 * Returns whether the `canopy-desktop-workspace-code-graph` flag is currently
 * enabled, including the LaunchDarkly-not-configured fallback used in
 * local/dev builds. Gates the Labs settings tab and every Code Graph
 * surface (Branch Info + workspace Settings modals) in the renderer.
 */
export function useCodeGraphExperimentEnabled(): boolean {
  return useFeatureFlagsStore((s) =>
    s.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopWorkspaceCodeGraph.key),
  );
}
