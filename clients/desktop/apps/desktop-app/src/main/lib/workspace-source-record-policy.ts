import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { getFeatureFlagService } from '../feature-flags';

/** Host policy; source recording observes it after admission in the manifest queue. */
export function pipelineHookBindingsEnabled(): boolean {
  return getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
  );
}
