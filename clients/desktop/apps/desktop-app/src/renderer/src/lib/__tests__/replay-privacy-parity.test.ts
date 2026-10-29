import {
  POSTHOG_REPLAY_BLOCK_CLASS,
  POSTHOG_REPLAY_MASK_CLASS,
} from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import {
  REPLAY_BLOCK_CLASS,
  REPLAY_MASK_CLASS,
} from '@canopy/ui-shared/lib/replay-privacy';

// The UI packages cannot import the instrumentation package, so they carry
// their own copy of the replay marker vocabulary. The desktop renderer can
// import both, so it pins the copy to the recorder's value here.
describe('replay privacy marker parity', () => {
  it('keeps the ui-shared block class equal to the recorder constant', () => {
    expect(REPLAY_BLOCK_CLASS).toBe(POSTHOG_REPLAY_BLOCK_CLASS);
  });

  it('keeps the ui-shared mask class equal to the recorder constant', () => {
    expect(REPLAY_MASK_CLASS).toBe(POSTHOG_REPLAY_MASK_CLASS);
  });
});
