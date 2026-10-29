import { ClaudeDelegationUsage } from '../agents/delegation/claude-usage';

describe('delegated Claude partial usage', () => {
  it('updates each response once across streaming and assistant snapshots', () => {
    const usage = new ClaudeDelegationUsage();
    expect(
      usage.receive({
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: {
            id: 'first',
            usage: {
              input_tokens: 12,
              output_tokens: 0,
              cache_read_input_tokens: 4,
            },
          },
        },
      }),
    ).toEqual({ inputTokens: 12, outputTokens: 0, cachedInputTokens: 4 });
    expect(
      usage.receive({
        type: 'stream_event',
        event: { type: 'message_delta', usage: { output_tokens: 5 } },
      }),
    ).toEqual({ inputTokens: 12, outputTokens: 5, cachedInputTokens: 4 });
    const complete = {
      type: 'assistant',
      message: { id: 'first', usage: { input_tokens: 12, output_tokens: 5 } },
    };
    usage.receive(complete);
    expect(usage.receive(complete)).toEqual({
      inputTokens: 12,
      outputTokens: 5,
      cachedInputTokens: 4,
    });
    expect(
      usage.receive({
        type: 'assistant',
        message: {
          id: 'second',
          usage: { input_tokens: 20, output_tokens: 8 },
        },
      }),
    ).toEqual({ inputTokens: 32, outputTokens: 13, cachedInputTokens: 4 });
  });

  it('ignores unrelated events and invalid usage', () => {
    const usage = new ClaudeDelegationUsage();
    expect(
      usage.receive({ type: 'tool_result', usage: { input_tokens: 999 } }),
    ).toBeUndefined();
    expect(
      usage.receive({
        type: 'assistant',
        message: {
          id: 'first',
          usage: { input_tokens: -1, output_tokens: Infinity },
        },
      }),
    ).toEqual({});
  });
});
