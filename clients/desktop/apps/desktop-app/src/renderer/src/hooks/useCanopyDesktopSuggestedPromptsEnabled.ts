import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';

/**
 * Whether MCP-aware suggested prompts render on the New Task and blank chat
 * empty states (CAN-1809). Kill-switch flag: both fallback modes default to
 * enabled; LaunchDarkly can disable it remotely.
 */
export function useCanopyDesktopSuggestedPromptsEnabled(): boolean {
  return useFeatureFlagsStore((s) =>
    s.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopSuggestedPrompts.key),
  );
}
