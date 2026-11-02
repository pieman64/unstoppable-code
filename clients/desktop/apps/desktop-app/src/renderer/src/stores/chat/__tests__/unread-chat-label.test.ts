import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import { getUnreadChatLabel } from '../unread-previews';

describe('getUnreadChatLabel', () => {
  it.each([ORCHESTRATOR_LABEL, 'App Advisor', 'app advisor', ' New chat '])(
    'suppresses the generic title %p',
    (title) => {
      expect(getUnreadChatLabel(title)).toBe('');
    },
  );

  it('keeps a specific chat title', () => {
    expect(getUnreadChatLabel('Fix the build')).toBe(': Fix the build');
  });
});
