import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { getFeatureFlagService } from '../feature-flags';

export function isAccountProxyFlagEnabled(): boolean {
  return getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopyDesktopAccountProxy.key,
  );
}

/**
 * Whether the flag's value is one LaunchDarkly served, or the unconfigured
 * default. While LaunchDarkly starts, changes account, or is unreachable,
 * the flag reads its fallback (off), which says nothing about the feature.
 */
export function isAccountProxyFlagSettled(): boolean {
  const { status } = getFeatureFlagService().getSnapshot();
  return status === 'ready' || status === 'not_configured';
}
