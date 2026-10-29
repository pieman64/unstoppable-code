import { chatDisplayLabel } from '../chat-display-label';

describe('chatDisplayLabel', () => {
  it('prefers a custom title even when it is the generated-name placeholder', () => {
    expect(
      chatDisplayLabel({
        customTitle: '  New Chat  ',
        title: 'Creation title',
        description: 'Latest generated name',
        liveTitle: 'Live title',
        fallback: 'Chat',
      }),
    ).toBe('New Chat');
  });

  it.each(['', '  ', undefined])(
    'falls back after clearing or for blank legacy custom names: %s',
    (customTitle) => {
      expect(
        chatDisplayLabel({
          customTitle,
          description: 'Latest generated name',
          fallback: 'Chat',
        }),
      ).toBe('Latest generated name');
    },
  );
  it('prefers the generated name to the one the chat was created with', () => {
    expect(
      chatDisplayLabel({
        title: 'Plan: auth overhaul',
        description: 'Fix login redirect',
        fallback: 'Chat',
      }),
    ).toBe('Fix login redirect');
  });

  it('skips placeholders and blank names, in order', () => {
    expect(
      chatDisplayLabel({
        title: 'Plan: auth overhaul',
        description: '  New Chat ',
        fallback: 'Chat',
      }),
    ).toBe('Plan: auth overhaul');
    expect(
      chatDisplayLabel({
        title: 'New Chat',
        description: '   ',
        liveTitle: 'Renamed tab',
        fallback: 'Chat',
      }),
    ).toBe('Renamed tab');
  });

  it('keeps a placeholder only when nothing else names the chat', () => {
    expect(chatDisplayLabel({ title: 'New Chat', fallback: 'Chat' })).toBe(
      'New Chat',
    );
    expect(chatDisplayLabel({ fallback: 'Untitled chat' })).toBe(
      'Untitled chat',
    );
  });
});
