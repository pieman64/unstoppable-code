import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { getFeatureFlagService } from '../feature-flags';

/**
 * Single source of truth for the code-graph feature gate. Reads the current
 * (synchronous) feature-flag snapshot for `canopy-desktop-workspace-code-graph`.
 *
 * This helper exposes the raw global kill switch. Workspace-scoped callers use
 * `code-graph-availability.ts`, which combines this value with the persisted
 * generation preference before admitting generation or tools.
 *
 * Defaults (from the protocol registry): `true` when LaunchDarkly is not
 * configured (dev / unconfigured desktop keep the feature on), `false` when
 * LaunchDarkly is configured but has not yet returned a live value (fail-safe).
 *
 * Callers run after `initializeFeatureFlagService()` has completed at startup,
 * so `isEnabled` reflects the latest evaluated value. The startup/flip handler
 * publishes it into the availability cache and reconciles queued work.
 */
export function isCodeGraphFeatureEnabled(): boolean {
  return getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopyDesktopWorkspaceCodeGraph.key,
  );
}
