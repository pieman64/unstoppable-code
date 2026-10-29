import {
  chatTabStripLabel,
  generatedChatTabLabel,
  getChatTabLabel,
  normalizeChatCustomTitle,
} from '../chatTabLabel';

describe('getChatTabLabel', () => {
  it('prefers the generated summary over the literal created-with title', () => {
    expect(
      getChatTabLabel({
        id: 'chat-1',
        title: 'New Chat',
        description: 'Claude Agent Capabilities and Skills',
      }),
    ).toBe('Claude Agent Capabilities and Skills');
  });

  it('falls back to the title when no summary has been generated yet', () => {
    expect(getChatTabLabel({ id: 'chat-1', title: 'New Chat' })).toBe(
      'New Chat',
    );
  });

  it('treats a whitespace-only summary as absent', () => {
    expect(
      getChatTabLabel({ id: 'chat-1', title: 'Renamed', description: '   ' }),
    ).toBe('Renamed');
  });

  it('falls back to the id when both fields are empty', () => {
    expect(
      getChatTabLabel({ id: 'chat-1', title: '   ', description: '' }),
    ).toBe('chat-1');
  });
});

describe('custom chat titles', () => {
  it('prefers a non-blank custom title everywhere a chat is labeled', () => {
    const tab = {
      id: 'chat-1',
      title: 'New Chat',
      description: 'Generated',
      customTitle: '  Mine  ',
    };
    expect(getChatTabLabel(tab)).toBe('Mine');
    expect(chatTabStripLabel(tab)).toBe('Mine');
    expect(generatedChatTabLabel(tab)).toBe('Generated');
  });

  it('keeps the existing strip fallback when the custom title is blank', () => {
    expect(
      chatTabStripLabel({
        title: 'New Chat',
        description: 'Generated',
        customTitle: ' ',
      }),
    ).toBe('Generated');
    expect(chatTabStripLabel({ title: 'New Chat' })).toBe('New Chat');
  });

  it('normalizes rename drafts against the shared limit', () => {
    expect(normalizeChatCustomTitle('  Name ')).toBe('Name');
    expect(normalizeChatCustomTitle('   ')).toBeNull();
    expect(normalizeChatCustomTitle(null)).toBeNull();
    expect(normalizeChatCustomTitle('x'.repeat(256))).toBe('x'.repeat(256));
    expect(normalizeChatCustomTitle('x'.repeat(257))).toBeUndefined();
  });
});
