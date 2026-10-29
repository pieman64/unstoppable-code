import { deriveRuntimeChatMessageId } from '../portal/persisted-chat-projection';

/**
 * `deriveRuntimeChatMessageId` is the single wire-id derivation shared by the
 * desktop main-process portal projector (`runtimeMessageId` in
 * `apps/desktop-app/src/main/services/chat-transcript-projector.ts`) and the
 * renderer transcript reducer
 * (`apps/desktop-app/src/renderer/src/lib/transcript-parser.ts`). Both sides
 * must produce the SAME id for the same event so a persisted-transcript
 * re-push upserts onto the live portal row instead of duplicating it. The
 * precedence asserted here is a wire contract — do not reorder.
 */
describe('deriveRuntimeChatMessageId', () => {
  it('keys tool_result events by tool:<toolUseId> ahead of everything else', () => {
    expect(
      deriveRuntimeChatMessageId(
        { message: { id: 'msg_1' }, uuid: 'u1' },
        'toolu-9',
      ),
    ).toBe('tool:toolu-9');
  });

  it('falls through an empty toolUseId to the event-level derivation', () => {
    expect(deriveRuntimeChatMessageId({ message: { id: 'msg_1' } }, '')).toBe(
      'msg_1',
    );
  });

  it('prefers the SDK message id (message.id)', () => {
    expect(
      deriveRuntimeChatMessageId({
        message: { id: 'msg_abc' },
        uuid: 'u1',
        message_id: 'm1',
        id: 'top1',
      }),
    ).toBe('msg_abc');
  });

  it('falls back to the per-event uuid, then message_id, then id', () => {
    expect(
      deriveRuntimeChatMessageId({ uuid: 'u1', message_id: 'm1', id: 'top1' }),
    ).toBe('u1');
    expect(deriveRuntimeChatMessageId({ message_id: 'm1', id: 'top1' })).toBe(
      'm1',
    );
    expect(deriveRuntimeChatMessageId({ id: 'top1' })).toBe('top1');
  });

  it('ignores non-string id candidates', () => {
    expect(
      deriveRuntimeChatMessageId({ message: { id: 42 }, uuid: 'u1' }),
    ).toBe('u1');
  });

  it('returns undefined when the event carries no id at all', () => {
    expect(
      deriveRuntimeChatMessageId({
        type: 'assistant',
        message: { content: [] },
      }),
    ).toBeUndefined();
  });
});
