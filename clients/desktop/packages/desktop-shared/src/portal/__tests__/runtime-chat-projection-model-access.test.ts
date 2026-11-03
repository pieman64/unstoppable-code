import type { PortalChatMessage } from '@canopy/protocol/portal';
import type { CodexAccountModelAccessFailure } from '@canopy/protocol/auth-recovery';
import { runtimeChatEventToPortalMessage } from '../runtime-chat-projection';

const raw =
  "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.";
const failure: CodexAccountModelAccessFailure = {
  kind: 'model_unsupported',
  model: 'gpt-6.1-sol',
  modelLabel: '6.1 Sol',
};

describe('live Codex account model rejection (CAN-4716)', () => {
  it.each(['error', 'canopy_ai_credits_no_billing_source'])(
    'preserves exact composer refusal identity for %s',
    (type) => {
      const project = (
        extra: Record<string, unknown> = {},
      ): PortalChatMessage | null =>
        runtimeChatEventToPortalMessage({
          scope: 'worktree',
          chatId: 'chat',
          data: {
            type,
            error_code: 'no_billing_source',
            error: 'No billing source',
            canopy_turn_user_message_id: 'submitted-user',
            ...extra,
          },
        });
      expect(project()?.parts).toContainEqual({
        kind: 'text',
        data: {
          text: '',
          composerRefusal: {
            code: 'no_billing_source',
            userMessageId: 'submitted-user',
          },
          errorText: 'No billing source',
        },
      });
      for (const scope of [
        { parent_tool_use_id: 'child' },
        { canopy_turn_user_message_id: undefined },
      ]) {
        const parts = project(scope)?.parts ?? [];
        expect(
          parts.some(
            (part) =>
              typeof part.data === 'object' &&
              part.data !== null &&
              'composerRefusal' in part.data,
          ),
        ).toBe(false);
      }
    },
  );
  it('carries the notice in a text part and keeps the raw text out of the row', () => {
    const projected = runtimeChatEventToPortalMessage({
      scope: 'worktree',
      chatId: 'chat',
      data: {
        type: 'result',
        is_error: true,
        subtype: 'codex_error',
        result: raw,
        canopy_model_access_failure: failure,
      },
    });
    expect(projected).toMatchObject({ status: 'failed', text: '' });
    expect(projected?.parts).toEqual([
      { kind: 'text', data: { text: raw, modelAccessFailure: failure } },
    ]);
  });

  it('projects an unstamped failure as before', () => {
    const projected = runtimeChatEventToPortalMessage({
      scope: 'worktree',
      chatId: 'chat',
      data: {
        type: 'result',
        is_error: true,
        subtype: 'codex_error',
        result: raw,
      },
    });
    expect(projected?.text).toBe(raw);
    expect(projected?.parts).toBeUndefined();
  });
});
