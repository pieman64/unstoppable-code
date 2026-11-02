import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import {
  getOpenCodeSettingsSection,
  isOpenCodeHarnessReleased,
} from '../opencode-settings';

function setFlags(harness: boolean, released: boolean): void {
  const snapshot = getDefaultFeatureFlagSnapshot();
  useFeatureFlagsStore.setState({
    snapshot: {
      ...snapshot,
      values: {
        ...snapshot.values,
        [CLIENT_FEATURE_FLAGS.canopyDesktopOpenCodeHarness.key]: harness,
        [CLIENT_FEATURE_FLAGS.canopyDesktopOpenCodeHarnessReleased.key]:
          released,
      },
    },
  });
}

afterEach(() => {
  useFeatureFlagsStore.setState({ snapshot: getDefaultFeatureFlagSnapshot() });
});

it.each([
  { harness: false, released: false, expected: false },
  { harness: false, released: true, expected: false },
  { harness: true, released: false, expected: false },
  { harness: true, released: true, expected: true },
])(
  'releases OpenCode only when the harness gate is on too (harness=$harness, released=$released)',
  ({ harness, released, expected }) => {
    setFlags(harness, released);
    expect(isOpenCodeHarnessReleased(useFeatureFlagsStore.getState())).toBe(
      expected,
    );
  },
);

it('keeps OpenCode setup in Labs until it is released', () => {
  setFlags(true, false);
  expect(getOpenCodeSettingsSection()).toBe('experiments');
});

it('moves OpenCode setup to Accounts once it is released', () => {
  setFlags(true, true);
  expect(getOpenCodeSettingsSection()).toBe('account');
});
