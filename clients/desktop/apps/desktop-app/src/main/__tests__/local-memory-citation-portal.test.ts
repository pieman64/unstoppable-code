import { runtimeChatEventToPortalMessage } from '../services/chat-transcript-projector';

describe('local-memory citation live Portal stripping', () => {
  it.each([
    {
      provider: 'Claude',
      data: {
        type: 'assistant',
        message: {
          id: 'claude-answer',
          content: [
            {
              type: 'text',
              text: 'Claude answer.\n<memory_citation files="topics/x.md"/>',
            },
          ],
        },
      },
      expected: 'Claude answer.',
    },
    {
      provider: 'Codex',
      data: {
        type: 'codex',
        event: {
          type: 'item.completed',
          item: {
            id: 'codex-answer',
            type: 'agent_message',
            text: 'Codex answer.\n<memory_citation files="topics/x.md"/>',
          },
        },
      },
      expected: 'Codex answer.',
    },
  ])('does not send the tag from a live $provider event', (testCase) => {
    const projected = runtimeChatEventToPortalMessage({
      scope: 'worktree',
      chatId: 'chat-1',
      data: testCase.data,
    });

    expect(projected?.text).toBe(testCase.expected);
    expect(JSON.stringify(projected)).not.toContain('memory_citation');
  });

  it('falls through an empty direct text field to structured message content', () => {
    const projected = runtimeChatEventToPortalMessage({
      scope: 'worktree',
      chatId: 'chat-1',
      data: {
        type: 'assistant',
        text: '',
        message: {
          id: 'claude-answer',
          content: [
            {
              type: 'text',
              text: 'Structured answer.\n<memory_citation files="topics/x.md"/>',
            },
          ],
        },
      },
    });

    expect(projected?.text).toBe('Structured answer.');
    expect(JSON.stringify(projected)).not.toContain('memory_citation');
  });

  it('passes live tool input and output containing the literal tag through unchanged', () => {
    const input = 'grep for <memory_citation files="topics/x.md"/> in docs';
    const output =
      'docs/example.md: found <memory_citation files="topics/x.md"/> on line 3';
    const projected = runtimeChatEventToPortalMessage({
      scope: 'worktree',
      chatId: 'chat-1',
      data: {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Grep',
              input,
            },
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              content: output,
            },
          ],
        },
      },
    });

    const toolUsePart = (projected?.parts ?? []).find(
      (part) => part.kind === 'tool_use',
    );
    expect(toolUsePart?.data).toMatchObject({ input });
    const toolResultPart = (projected?.parts ?? []).find(
      (part) => part.kind === 'tool_result',
    );
    expect(toolResultPart?.data).toMatchObject({ output });
  });

  it('passes runtime error text containing the literal tag through unchanged', () => {
    const errorText =
      'Provider failed while writing <memory_citation files="topics/x.md"/> to the reply';
    const projected = runtimeChatEventToPortalMessage({
      scope: 'worktree',
      chatId: 'chat-1',
      data: { type: 'error', error: errorText },
    });

    expect(projected?.status).toBe('failed');
    expect(projected?.text).toBe(errorText);
  });

  it('passes a failed tool result containing the literal tag through unchanged', () => {
    const output =
      'Command failed: unexpected token <memory_citation files="topics/x.md"/> in input';
    const projected = runtimeChatEventToPortalMessage({
      scope: 'worktree',
      chatId: 'chat-1',
      data: {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-err',
              content: output,
              is_error: true,
            },
          ],
        },
      },
    });

    const toolResultPart = (projected?.parts ?? []).find(
      (part) => part.kind === 'tool_result',
    );
    expect(toolResultPart?.data).toMatchObject({ output, isError: true });
  });
});
