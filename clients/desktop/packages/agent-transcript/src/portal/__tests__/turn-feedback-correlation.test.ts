import { persistedMessageToPortalMessage } from '../persisted-chat-projection';

describe('turn feedback correlation keys', () => {
  it('preserves the persisted user message id as the portal messageId', () => {
    const projected = persistedMessageToPortalMessage({
      scope: 'standalone' as const,
      chatId: 'chat-abc',
      message: {
        id: 'msg-3-1757000000000',
        role: 'user',
        timestamp: 1757000000000,
        blocks: [{ type: 'text', text: 'hello' }],
      },
    });

    // `clientUserMessageId` on the wire IS the persisted message id. Mobile
    // sends `messageId` verbatim, so any remap here silently breaks
    // cross-device rehydration instead of failing a build.
    expect(projected.messageId).toBe('msg-3-1757000000000');
  });

  it('preserves the chat id as the portal chatId', () => {
    const projected = persistedMessageToPortalMessage({
      scope: 'standalone' as const,
      chatId: 'chat-abc',
      message: {
        id: 'msg-4-1757000000001',
        role: 'assistant',
        timestamp: 1757000000001,
        blocks: [{ type: 'text', text: 'hi' }],
      },
    });

    // `clientChatId` on the wire IS this chat id.
    expect(projected.chatId).toBe('chat-abc');
  });
});
