import { persistedMessageToPortalMessage } from '../portal/persisted-chat-projection';
import type { PersistedChatMessage } from '@canopy/agent-transcript/types';

const agentSent = {
  sender: {
    kind: 'bot',
    botId: 'app_advisor',
    taskId: 'advisor-task',
    chatId: 'advisor-chat',
  },
  chatTitle: 'Weekly summary',
  projectLabel: 'App Advisor',
};

function userMessage(
  metadata: Record<string, unknown> = {},
): PersistedChatMessage {
  return {
    id: 'agent-sent-message',
    role: 'user' as const,
    timestamp: 1_760_000_000_000,
    blocks: [{ type: 'text' as const, text: 'The weekly summary is ready.' }],
    ...metadata,
  };
}

describe('desktop portal agent-sent projection adapter', () => {
  it('passes validated sender display metadata through the neutral projector', () => {
    const secret = 'hidden-instruction-must-not-reach-portal';
    const untrustedMetadata = {
      ...agentSent,
      provenance: { acceptedInputId: secret, rawSenderContext: secret },
      hiddenInstruction: secret,
    };
    const projected = persistedMessageToPortalMessage({
      scope: 'worktree',
      chatId: 'receiving-chat',
      message: userMessage({
        agentSent: untrustedMetadata,
        hiddenContext: { text: secret },
      }),
    });

    expect(projected).toEqual(
      expect.objectContaining({
        messageId: 'agent-sent-message',
        agentSent,
      }),
    );
    expect(JSON.stringify(projected)).not.toContain(secret);
  });

  it('keeps old rows without agent-sent metadata unchanged', () => {
    const projected = persistedMessageToPortalMessage({
      scope: 'worktree',
      chatId: 'receiving-chat',
      message: userMessage(),
    });

    expect('agentSent' in projected).toBe(false);
  });

  it('drops malformed persisted metadata instead of projecting it', () => {
    const projected = persistedMessageToPortalMessage({
      scope: 'standalone',
      chatId: 'receiving-chat',
      message: userMessage({
        agentSent: {
          sender: {
            kind: 'bot',
            botId: 'app_advisor',
            taskId: 'advisor-task',
            chatId: 123,
          },
          chatTitle: 'Weekly summary',
          projectLabel: 'App Advisor',
        },
      }),
    });

    expect('agentSent' in projected).toBe(false);
  });
});
