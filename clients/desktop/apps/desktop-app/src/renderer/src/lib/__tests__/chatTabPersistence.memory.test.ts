import type { PersistedChatTab } from '@canopy/desktop-shared/types';
import { hydratePersistedChatTab } from '../chatTabPersistence';

describe('persisted organization memory normalization', () => {
  it('keeps only associated messages and bounds fact data', () => {
    const persisted: PersistedChatTab = {
      id: 'chat-1',
      title: 'Chat',
      kind: 'chat',
      createdAt: '2026-07-13T00:00:00.000Z',
      messages: [
        {
          id: 'message-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'question' }],
          timestamp: '2026-07-13T00:00:00.000Z',
        },
      ],
      memoryByMessageId: {
        'message-1': {
          facts: Array.from({ length: 10 }, (_unused, index) => ({
            factText: 'x'.repeat(600),
            validAt: null,
            sourceTurnIds: [`turn-${index}`],
          })),
        },
        missing: {
          facts: [
            {
              factText: 'This entry has no matching message.',
              validAt: null,
              sourceTurnIds: ['turn-missing'],
            },
          ],
        },
      },
    };

    const hydrated = hydratePersistedChatTab(
      persisted satisfies PersistedChatTab,
    );
    expect(hydrated.memoryByMessageId?.missing).toBeUndefined();
    expect(hydrated.memoryByMessageId?.['message-1']?.facts).toHaveLength(8);
    expect(
      hydrated.memoryByMessageId?.['message-1']?.facts[0]?.factText,
    ).toHaveLength(500);
    expect(
      hydrated.memoryByMessageId?.['message-1']?.facts[0]?.sourceTurnIds,
    ).toEqual(['turn-0']);
  });
});
