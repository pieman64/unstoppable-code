import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { toastMessageReplayClass } from '../replayPrivacy';

describe('toastMessageReplayClass', () => {
  it.each([
    ['error', 'Git Push'],
    ['success', 'Chat'],
    ['info', 'Hook'],
  ] as const)('blocks a %s %s message', (type, category) => {
    expect(toastMessageReplayClass(type, category)).toBe(
      POSTHOG_REPLAY_BLOCK_CLASS,
    );
  });

  it('blocks a message whose toast opts in, such as one naming a person', () => {
    expect(toastMessageReplayClass('success', undefined, true)).toBe(
      POSTHOG_REPLAY_BLOCK_CLASS,
    );
    expect(toastMessageReplayClass('success', undefined, false)).toBe('');
  });

  it('records other messages', () => {
    expect(toastMessageReplayClass('success', 'Git Commit')).toBe('');
    expect(toastMessageReplayClass('info')).toBe('');
  });
});
