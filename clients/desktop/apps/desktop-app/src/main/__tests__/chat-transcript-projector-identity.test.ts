import {
  runtimeChatEventToPortalMessage,
  persistedMessageToPortalMessage,
} from '../services/chat-transcript-projector';
import type {
  PersistedChatMessage,
  PortalChatMessage,
} from '@canopy/desktop-shared/types';

function legacyToolUseBlock(): PersistedChatMessage['blocks'][number] {
  const block: PersistedChatMessage['blocks'][number] = {
    type: 'tool_use',
    toolUseId: 't1',
    toolName: 'Bash',
    input: '{}',
  };
  // Legacy persisted rows carry decoded JSON tool input; preserve that runtime shape.
  Reflect.set(block, 'input', {});
  return block;
}

// Realistic Claude Agent SDK event sequence for a single turn:
//   assistant(text A) → assistant(tool_use) → user(tool_result)
//   → assistant(text B) → result
// Each `assistant` event is a finalized message block (the non-delta path),
// carrying its own stable `message.id` (real SDK) or `uuid` (fixtures).
const fallbackMessageId = 'user-1:assistant';

function project(data: unknown): PortalChatMessage | null {
  return runtimeChatEventToPortalMessage({
    scope: 'worktree',
    workspaceLocalId: 'ws',
    worktreeLocalId: 'wt',
    chatId: 'chat-1',
    data,
    fallbackMessageId,
  });
}

describe('runtimeChatEventToPortalMessage — per-message identity (D1)', () => {
  it('gives distinct assistant messages distinct ids so neither overwrites the other', () => {
    const first = project({
      type: 'assistant',
      uuid: 'a1',
      message: {
        id: 'msg_a1',
        role: 'assistant',
        content: [{ type: 'text', text: 'First answer chunk.' }],
      },
    });
    const second = project({
      type: 'assistant',
      uuid: 'a2',
      message: {
        id: 'msg_a2',
        role: 'assistant',
        content: [{ type: 'text', text: 'Second answer chunk.' }],
      },
    });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.text).toBe('First answer chunk.');
    expect(second?.text).toBe('Second answer chunk.');
    // The regression: both collapsed onto `${userMessageId}:assistant`, so the
    // second overwrote the first on the server and the first vanished.
    expect(first?.messageId).not.toBe(second?.messageId);
  });

  it('keys a tool_use assistant message stably by its message id', () => {
    const toolMessage = project({
      type: 'assistant',
      uuid: 'a3',
      message: {
        id: 'msg_a3',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'Bash',
            input: { command: 'npm test' },
          },
        ],
      },
    });
    expect(toolMessage).not.toBeNull();
    expect(toolMessage?.messageId).toBe('msg_a3');
    expect(toolMessage?.parts?.some((p) => p.kind === 'tool_use')).toBe(true);
  });

  it('keys a tool_result user event stably by its tool_use_id', () => {
    const toolResult = project({
      type: 'user',
      uuid: 'tr1',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: 'ok',
            is_error: false,
          },
        ],
      },
    });
    expect(toolResult).not.toBeNull();
    expect(toolResult?.messageId).toBe('tool:tool-1');
    expect(toolResult?.parts?.some((p) => p.kind === 'tool_result')).toBe(true);
  });

  it('marks finalized assistant content messages complete (not perpetually streaming)', () => {
    const message = project({
      type: 'assistant',
      uuid: 'a4',
      message: {
        id: 'msg_a4',
        role: 'assistant',
        content: [{ type: 'text', text: 'Done.' }],
      },
    });
    expect(message?.status).toBe('complete');
  });

  it('does not emit a duplicate empty message for the terminal result event', () => {
    const result = project({
      type: 'result',
      uuid: 'r1',
      subtype: 'success',
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(result).toBeNull();
  });

  it('does not duplicate the final assistant text via the success result event', () => {
    // The Claude `result` event echoes the final assistant text, which the
    // assistant content event already delivered. Emitting it again would mint
    // a second identical assistant bubble.
    const result = project({
      type: 'result',
      uuid: 'r3',
      subtype: 'success',
      result: 'Second answer chunk.',
    });
    expect(result).toBeNull();
  });

  it('still emits an error message for a failed result with text', () => {
    const errored = project({
      type: 'result',
      uuid: 'r2',
      subtype: 'error',
      is_error: true,
      result: 'Something went wrong.',
    });
    expect(errored).not.toBeNull();
    expect(errored?.status).toBe('failed');
    expect(errored?.text).toContain('Something went wrong.');
  });
});

describe('persistedMessageToPortalMessage (unchanged contract)', () => {
  it('folds tool_result into the paired tool_use and keeps message id', () => {
    const message: PersistedChatMessage = {
      id: 'msg-persist-1',
      role: 'assistant',
      timestamp: 1000,
      blocks: [
        { type: 'text', text: 'Hello' },
        legacyToolUseBlock(),
        {
          type: 'tool_result',
          toolUseId: 't1',
          toolName: 'Bash',
          output: 'ok',
          isError: false,
        },
      ],
    };
    const portal = persistedMessageToPortalMessage({
      scope: 'worktree',
      chatId: 'chat-1',
      message,
    });
    expect(portal.messageId).toBe('msg-persist-1');
    const toolUse = portal.parts?.find((p) => p.kind === 'tool_use');
    expect(toolUse).toBeDefined();
  });
});
