import {
  applyClaudeTranscriptEvent,
  createEmptyTranscriptReducerState,
  type TranscriptReducerOptions,
} from '../transcript-parser';
import {
  persistedMessageToPortalMessage,
  portalChatMessagesToPersisted,
} from '../../portal/persisted-chat-projection';

const raw = 'API Error: 400 messages.4.content: Invalid input';
const code = 'claude_ai_credits_fallback_rejected';
const options: TranscriptReducerOptions = {
  childToolLiveness: { kind: 'unknown' },
  now: 1_700_000_000_000,
  createMessageId: () => 'failure-message',
};

describe('Claude signed-out AI Credits fallback presentation', () => {
  const assistant = {
    type: 'assistant',
    error: 'unknown',
    canopy_display_error_code: code,
    message: {
      id: 'sdk-message',
      model: '<synthetic>',
      role: 'assistant',
      content: [{ type: 'text', text: raw }],
    },
  };

  it('retains the raw error while marking one display block, including after result replay', () => {
    const first = applyClaudeTranscriptEvent(
      createEmptyTranscriptReducerState(),
      assistant,
      options,
    );
    const state = applyClaudeTranscriptEvent(
      first,
      {
        type: 'result',
        is_error: true,
        api_error_status: 400,
        result: raw,
        canopy_display_error_code: code,
      },
      options,
    );
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.blocks).toEqual([
      { type: 'text', text: raw, errorCode: code },
    ]);
    expect(state.error).toBe(raw);
  });

  it('authors a visible system notice when only the failed result arrives', () => {
    const state = applyClaudeTranscriptEvent(
      createEmptyTranscriptReducerState(),
      {
        type: 'result',
        is_error: true,
        api_error_status: 400,
        result: raw,
        canopy_display_error_code: code,
      },
      options,
    );
    expect(state.error).toBe(raw);
    expect(state.messages).toEqual([
      expect.objectContaining({
        role: 'system',
        blocks: [{ type: 'text', text: raw, errorCode: code }],
      }),
    ]);
  });

  it('carries the marked raw text in a durable Portal part without duplicating it in visible root prose', () => {
    const state = applyClaudeTranscriptEvent(
      createEmptyTranscriptReducerState(),
      assistant,
      options,
    );
    const message = state.messages[0];
    if (!message) throw new Error('Expected a persisted failure message');
    const projected = persistedMessageToPortalMessage({
      scope: 'app_advisor',
      chatId: 'chat',
      message,
    });
    expect(
      portalChatMessagesToPersisted([projected]).messages[0]?.blocks,
    ).toEqual(message.blocks);
    expect(projected.text).toBe('');
    expect(projected.parts).toEqual([
      { kind: 'text', data: { text: raw, errorCode: code } },
    ]);
  });

  it.each([undefined, 'unknown_display_code'])(
    'does not infer the display context from raw error text (%s)',
    (stamp) => {
      const state = applyClaudeTranscriptEvent(
        createEmptyTranscriptReducerState(),
        {
          ...assistant,
          canopy_display_error_code: stamp,
        },
        options,
      );
      const message = state.messages[0];
      if (!message) throw new Error('Expected the original failure message');
      expect(message.blocks).toEqual([{ type: 'text', text: raw }]);
      expect(
        persistedMessageToPortalMessage({
          scope: 'app_advisor',
          chatId: 'chat',
          message,
        }).text,
      ).toBe(raw);
    },
  );
});
