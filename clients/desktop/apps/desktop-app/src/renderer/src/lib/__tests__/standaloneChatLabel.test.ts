import {
  getArchivedChatDisplayLabel,
  getStandaloneChatDisplayLabel,
} from '@/components/standalone-chat/chat-label';

describe('getStandaloneChatDisplayLabel', () => {
  it('prefers the generated description over placeholder titles', () => {
    expect(
      getStandaloneChatDisplayLabel({
        title: 'New Chat',
        description: 'Debug audit trail summaries',
        fallback: 'New chat',
      }),
    ).toBe('Debug audit trail summaries');
  });

  it('prefers the generated description over a live title', () => {
    expect(
      getStandaloneChatDisplayLabel({
        title: 'New Chat',
        description: 'Debug audit trail summaries',
        liveTitle: 'Renderer state investigation',
        fallback: 'New chat',
      }),
    ).toBe('Debug audit trail summaries');
  });

  it('prefers the generated description over a saved title', () => {
    expect(
      getStandaloneChatDisplayLabel({
        title: 'Renderer state investigation',
        description: 'Debug audit trail summaries',
        fallback: 'New chat',
      }),
    ).toBe('Debug audit trail summaries');
  });

  it('preserves the placeholder title when no description exists yet', () => {
    expect(
      getStandaloneChatDisplayLabel({
        title: 'New Chat',
        description: '',
        fallback: 'Archived chat',
      }),
    ).toBe('New Chat');
  });

  it('ignores the placeholder description and falls back to the live title', () => {
    expect(
      getStandaloneChatDisplayLabel({
        title: 'New Chat',
        description: 'New chat',
        liveTitle: 'Renderer state investigation',
        fallback: 'New chat',
      }),
    ).toBe('Renderer state investigation');
  });
});

describe('getArchivedChatDisplayLabel', () => {
  it('prefers the generated description over the raw title', () => {
    expect(
      getArchivedChatDisplayLabel({
        title: '$builtin-gh:handle-pr-checks',
        description: 'Handle pull request checks',
      }),
    ).toBe('Handle pull request checks');
  });

  it('falls back to the raw title when no description was generated', () => {
    expect(getArchivedChatDisplayLabel({ title: 'Archive Me' })).toBe(
      'Archive Me',
    );
  });

  it('keeps a placeholder title when nothing else is available', () => {
    expect(getArchivedChatDisplayLabel({ title: 'New Chat' })).toBe('New Chat');
  });

  it('falls back to a neutral label when the chat has no name at all', () => {
    expect(getArchivedChatDisplayLabel({ title: '   ' })).toBe('Untitled chat');
  });
});
