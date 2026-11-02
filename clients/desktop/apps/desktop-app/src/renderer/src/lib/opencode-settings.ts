import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';

type FlagReader = Pick<
  ReturnType<typeof useFeatureFlagsStore.getState>,
  'isEnabled'
>;

export function isOpenCodeHarnessReleased(state: FlagReader): boolean {
  return (
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopOpenCodeHarness.key) &&
    state.isEnabled(
      CLIENT_FEATURE_FLAGS.canopyDesktopOpenCodeHarnessReleased.key,
    )
  );
}

export function getOpenCodeSettingsSection(): 'account' | 'experiments' {
  return isOpenCodeHarnessReleased(useFeatureFlagsStore.getState())
    ? 'account'
    : 'experiments';
}
