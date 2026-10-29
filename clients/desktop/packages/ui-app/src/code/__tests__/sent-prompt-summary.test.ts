import type { PortalChatMessage } from '@canopy/protocol/portal';
import { persistedMessageToPortalMessage } from '@canopy/agent-transcript/portal/persisted-chat-projection';
import {
  isPersonPromptText,
  summarizeTranscriptPrompts,
} from '../sent-prompt-summary';

const WATCHER_PROMPT =
  '<system_instruction><canopy_watcher_event>{"label":"Build finished"}</canopy_watcher_event></system_instruction>';

function message(
  messageId: string,
  role: PortalChatMessage['role'],
  createdAtMs: number,
  text = messageId,
): PortalChatMessage {
  return {
    messageId,
    chatId: 'c1',
    role,
    promptSource: 'human',
    status: 'complete',
    text,
    createdAtMs,
  };
}

describe('isPersonPromptText', () => {
  it('accepts a prompt the person wrote', () => {
    expect(isPersonPromptText('Please fix the build')).toBe(true);
  });

  it('rejects a fired watcher prompt', () => {
    expect(isPersonPromptText(WATCHER_PROMPT)).toBe(false);
  });
});

describe('summarizeTranscriptPrompts', () => {
  it.each(['human', 'hook'] as const)(
    'retains %s provenance through cached history parts',
    (userMessageSource) => {
      const projected = persistedMessageToPortalMessage({
        scope: 'worktree',
        chatId: 'c1',
        message: {
          id: 'prompt',
          role: 'user',
          userMessageSource,
          timestamp: 1,
          blocks: [{ type: 'text', text: 'plain' }],
        },
      });
      const cached = { ...projected, promptSource: undefined };
      expect(summarizeTranscriptPrompts([cached]).promptCount).toBe(
        userMessageSource === 'human' ? 1 : 0,
      );
    },
  );

  it('does not silently classify missing provenance as human', () => {
    expect(
      summarizeTranscriptPrompts([
        { ...message('unknown', 'user', 2), promptSource: undefined },
      ]).promptCount,
    ).toBe(0);
  });
  it('counts person prompts and keeps the latest one', () => {
    expect(
      summarizeTranscriptPrompts([
        message('u1', 'user', 1),
        message('a1', 'assistant', 2),
        message('u2', 'user', 3),
        message('w1', 'user', 4, WATCHER_PROMPT),
        message('a2', 'assistant', 5),
      ]),
    ).toEqual({ latest: { id: 'u2', timestamp: 3 }, promptCount: 2 });
  });

  it('reports no latest prompt for a transcript without one', () => {
    expect(summarizeTranscriptPrompts([message('a1', 'assistant', 1)])).toEqual(
      { latest: null, promptCount: 0 },
    );
  });
});
