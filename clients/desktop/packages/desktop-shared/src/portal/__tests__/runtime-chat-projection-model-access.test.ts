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
