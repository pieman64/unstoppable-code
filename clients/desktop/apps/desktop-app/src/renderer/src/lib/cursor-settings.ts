import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';

type FlagReader = Pick<
  ReturnType<typeof useFeatureFlagsStore.getState>,
  'isEnabled'
>;

export function isCursorHarnessReleased(state: FlagReader): boolean {
  return (
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarness.key) &&
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarnessReleased.key)
  );
}

export function getCursorSettingsSection(): 'account' | 'experiments' {
  return isCursorHarnessReleased(useFeatureFlagsStore.getState())
    ? 'account'
    : 'experiments';
}
