import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import {
  getCopilotSettingsSection,
  isCopilotHarnessReleased,
} from '../copilot-settings';

function setFlags(harness: boolean, released: boolean): void {
  const snapshot = getDefaultFeatureFlagSnapshot();
  useFeatureFlagsStore.setState({
    snapshot: {
      ...snapshot,
      values: {
        ...snapshot.values,
        [CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarness.key]: harness,
        [CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarnessReleased.key]:
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
  'releases Copilot only when the harness gate is on too (harness=$harness, released=$released)',
  ({ harness, released, expected }) => {
    setFlags(harness, released);
    expect(isCopilotHarnessReleased(useFeatureFlagsStore.getState())).toBe(
      expected,
    );
  },
);

it('keeps Copilot setup in Labs until it is released', () => {
  setFlags(true, false);
  expect(getCopilotSettingsSection()).toBe('experiments');
});

it('moves Copilot setup to Accounts once it is released', () => {
  setFlags(true, true);
  expect(getCopilotSettingsSection()).toBe('account');
});
