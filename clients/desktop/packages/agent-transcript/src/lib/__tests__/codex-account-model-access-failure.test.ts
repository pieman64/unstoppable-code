import type { CodexAccountModelAccessFailure } from '@canopy/protocol/auth-recovery';
import {
  applyCodexTranscriptEvent,
  createEmptyTranscriptReducerState,
  type TranscriptReducerOptions,
} from '../transcript-parser';
import {
  persistedMessageToPortalMessage,
  portalChatMessagesToPersisted,
} from '../../portal/persisted-chat-projection';
import type { PersistedChatMessage } from '../../types';

const raw =
  "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.";
const failure: CodexAccountModelAccessFailure = {
  kind: 'model_unsupported',
  model: 'gpt-6.1-sol',
  modelLabel: '6.1 Sol',
  fallbackModel: 'gpt-6-luna',
  fallbackModelLabel: 'Luna 6.0',
};
const options: TranscriptReducerOptions = {
  childToolLiveness: { kind: 'unknown' },
  now: 1_700_000_000_000,
  createMessageId: () => 'failure-message',
};
const result = {
  type: 'result',
  is_error: true,
  subtype: 'codex_error',
  result: raw,
  codexErrorInfo: 'badRequest',
  errors: [raw],
  canopy_model_access_failure: failure,
};

describe('Codex account model rejection on the error row (CAN-4716)', () => {
  it('stamps the row the native failure already wrote', () => {
    const failed = applyCodexTranscriptEvent(
      createEmptyTranscriptReducerState(),
      { type: 'turn.failed', error: { message: raw } },
      options,
    );
    expect(failed.messages).toHaveLength(1);
    const state = applyCodexTranscriptEvent(failed, result, options);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.blocks).toEqual([
      { type: 'text', text: `Error: ${raw}`, modelAccessFailure: failure },
    ]);
  });

  it('stamps the row it authors when only the result arrives', () => {
    const state = applyCodexTranscriptEvent(
      createEmptyTranscriptReducerState(),
      result,
      options,
    );
    expect(state.messages.at(-1)).toMatchObject({
      role: 'system',
      blocks: [
        { type: 'text', text: `Error: ${raw}`, modelAccessFailure: failure },
      ],
    });
  });

  it.each([
    ['absent', undefined],
    ['malformed', { kind: 'other', model: 'x', modelLabel: 'X' }],
    ['a half fallback', { ...failure, fallbackModelLabel: undefined }],
  ])('leaves the row unstamped when the carrier is %s', (_label, carrier) => {
    const state = applyCodexTranscriptEvent(
      createEmptyTranscriptReducerState(),
      { ...result, canopy_model_access_failure: carrier },
      options,
    );
    expect(state.messages.at(-1)?.blocks).toEqual([
      { type: 'text', text: `Error: ${raw}` },
    ]);
  });

  it('carries the notice to the Portal and back, even without text parts', () => {
    const message: PersistedChatMessage = {
      id: 'failure-message',
      role: 'system',
      blocks: [
        { type: 'text', text: `Error: ${raw}`, modelAccessFailure: failure },
      ],
      timestamp: options.now,
    };
    const projected = persistedMessageToPortalMessage(
      { scope: 'worktree', chatId: 'chat', message },
      { includeText: false },
    );
    expect(projected.text).toBe('');
    expect(projected.parts).toEqual([
      {
        kind: 'text',
        data: { text: `Error: ${raw}`, modelAccessFailure: failure },
      },
    ]);
    expect(
      portalChatMessagesToPersisted([projected]).messages[0]?.blocks,
    ).toEqual(message.blocks);
  });
});
