import { isHumanAuthoredUserMessage } from '../transcript-storage';
import type { PersistedChatMessage } from '../types';

describe('isHumanAuthoredUserMessage', () => {
  it('does not classify agent-sent user messages as human-authored', () => {
    const message: Pick<
      PersistedChatMessage,
      'role' | 'userMessageSource' | 'watcherFired'
    > = {
      role: 'user',
      userMessageSource: 'agent',
    };

    expect(isHumanAuthoredUserMessage(message)).toBe(false);
  });

  it('continues to classify human user messages as human-authored', () => {
    const message: Pick<
      PersistedChatMessage,
      'role' | 'userMessageSource' | 'watcherFired'
    > = {
      role: 'user',
      userMessageSource: 'human',
    };

    expect(isHumanAuthoredUserMessage(message)).toBe(true);
  });
});
