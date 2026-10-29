import { sanitizePersistedChatMessages } from '../chatMessageSanitization';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';

describe('sanitizePersistedChatMessages', () => {
  it('drops assistant messages with only empty text/thinking blocks', () => {
    const messages: PersistedChatMessage[] = [
      {
        id: 'a',
        role: 'assistant',
        blocks: [{ type: 'text', text: '   ' }],
        timestamp: 0,
      },
      {
        id: 'b',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'hello' }],
        timestamp: 0,
      },
    ];
    const result = sanitizePersistedChatMessages(messages);
    expect(result.map((message) => message.id)).toEqual(['b']);
  });

  it('keeps user messages even when they look empty (only assistant rows are pruned)', () => {
    const messages: PersistedChatMessage[] = [
      {
        id: 'user-empty',
        role: 'user',
        blocks: [{ type: 'text', text: '' }],
        timestamp: 0,
      },
    ];
    expect(sanitizePersistedChatMessages(messages)).toEqual(messages);
  });

  it('preserves assistant messages whose only block is a compaction_info marker', () => {
    const messages: PersistedChatMessage[] = [
      {
        id: 'compaction-banner',
        role: 'assistant',
        blocks: [
          {
            type: 'compaction_info',
            timestamp: 1,
            provider: 'claude',
            interfaceMode: 'claude-code',
          },
        ],
        timestamp: 1,
      },
    ];

    expect(sanitizePersistedChatMessages(messages)).toEqual(messages);
  });

  it('preserves system messages carrying a compaction_info block', () => {
    const messages: PersistedChatMessage[] = [
      {
        id: 'system-banner',
        role: 'system',
        blocks: [
          {
            type: 'compaction_info',
            timestamp: 2,
            provider: 'claude',
            interfaceMode: 'canopy',
            summary: 'Compacted older context.',
          },
        ],
        timestamp: 2,
      },
    ];

    expect(sanitizePersistedChatMessages(messages)).toEqual(messages);
  });

  it('drops Claude Code local command transcript artifacts from persisted chat messages', () => {
    const messages: PersistedChatMessage[] = [
      {
        id: 'normal-user',
        role: 'user',
        blocks: [{ type: 'text', text: 'what is your favorite color?' }],
        timestamp: 1,
      },
      {
        id: 'normal-assistant',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Blue.' }],
        timestamp: 2,
      },
      {
        id: 'local-caveat',
        role: 'user',
        blocks: [
          {
            type: 'text',
            text: '<local-command-caveat>Caveat</local-command-caveat>',
          },
        ],
        timestamp: 3,
      },
      {
        id: 'local-command',
        role: 'user',
        blocks: [
          {
            type: 'text',
            text: '<command-name>/exit</command-name>\n<command-message>exit</command-message>',
          },
        ],
        timestamp: 4,
      },
      {
        id: 'local-stdout',
        role: 'user',
        blocks: [
          {
            type: 'text',
            text: '<local-command-stdout>Bye!</local-command-stdout>',
          },
        ],
        timestamp: 5,
      },
      {
        id: 'synthetic-no-response',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'No response requested.' }],
        timestamp: 6,
      },
    ];

    expect(
      sanitizePersistedChatMessages(messages).map((message) => message.id),
    ).toEqual(['normal-user', 'normal-assistant']);
  });

  it('keeps ordinary assistant no-response text when it is not adjacent to local command artifacts', () => {
    const messages: PersistedChatMessage[] = [
      {
        id: 'ordinary',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'No response requested.' }],
        timestamp: 1,
      },
    ];

    expect(sanitizePersistedChatMessages(messages)).toEqual(messages);
  });
});
