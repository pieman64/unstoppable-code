import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';

type FlagReader = Pick<
  ReturnType<typeof useFeatureFlagsStore.getState>,
  'isEnabled'
>;

export function isCopilotHarnessReleased(state: FlagReader): boolean {
  return (
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarness.key) &&
    state.isEnabled(
      CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarnessReleased.key,
    )
  );
}

export function getCopilotSettingsSection(): 'account' | 'experiments' {
  return isCopilotHarnessReleased(useFeatureFlagsStore.getState())
    ? 'account'
    : 'experiments';
}
