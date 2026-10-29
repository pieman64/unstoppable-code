import {
  applyClaudeTranscriptEvent,
  createEmptyTranscriptReducerState,
  type TranscriptReducerOptions,
  type TranscriptReducerState,
} from '../transcript-parser';

/**
 * `claudeUuid` is the Claude Code session chain uuid of the top-level SDK
 * event that produced a persisted message. It is the only thing that lets a
 * truncated fork ask the SDK to resume the source session at a point in time
 * (`resumeSessionAt`) instead of starting the model with no context.
 *
 * Sidechain (subagent) frames carry their own uuids that are NOT valid fork
 * points on the main chain, so they must never be stamped.
 */
const options: TranscriptReducerOptions = {
  now: 1_700_000_000_000,
  createMessageId: () => 'generated-id',
};

function emptyState(): TranscriptReducerState {
  return createEmptyTranscriptReducerState();
}

describe('Claude chain uuid stamping', () => {
  it('stamps a top-level assistant event uuid onto the persisted message', () => {
    const next = applyClaudeTranscriptEvent(
      emptyState(),
      {
        type: 'assistant',
        uuid: 'chain-assistant-1',
        parent_tool_use_id: null,
        message: {
          id: 'msg_1',
          role: 'assistant',
          content: [{ type: 'text', text: 'Done' }],
        },
      },
      options,
    );

    const assistant = next.messages.find(
      (message) => message.role === 'assistant',
    );
    expect(assistant?.claudeUuid).toBe('chain-assistant-1');
  });

  it('stamps a top-level tool_result carrier uuid onto the persisted message', () => {
    const next = applyClaudeTranscriptEvent(
      emptyState(),
      {
        type: 'user',
        uuid: 'chain-tool-result-1',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: 'ok',
            },
          ],
        },
      },
      options,
    );

    const toolResult = next.messages.find((message) =>
      message.blocks.some((block) => block.type === 'tool_result'),
    );
    expect(toolResult?.claudeUuid).toBe('chain-tool-result-1');
  });

  it('does not stamp a subagent (sidechain) assistant frame', () => {
    const next = applyClaudeTranscriptEvent(
      emptyState(),
      {
        type: 'assistant',
        uuid: 'sidechain-assistant-1',
        parent_tool_use_id: 'toolu_x',
        message: {
          id: 'msg_2',
          role: 'assistant',
          content: [{ type: 'text', text: 'Subagent thought' }],
        },
      },
      options,
    );

    const assistant = next.messages.find(
      (message) => message.role === 'assistant',
    );
    expect(assistant).toBeDefined();
    expect(assistant?.claudeUuid).toBeUndefined();
  });

  it('does not stamp a subagent (sidechain) tool_result carrier', () => {
    const next = applyClaudeTranscriptEvent(
      emptyState(),
      {
        type: 'user',
        uuid: 'sidechain-tool-result-1',
        parent_tool_use_id: 'toolu_x',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_y',
              content: 'ok',
            },
          ],
        },
      },
      options,
    );

    const toolResult = next.messages.find((message) =>
      message.blocks.some((block) => block.type === 'tool_result'),
    );
    expect(toolResult).toBeDefined();
    expect(toolResult?.claudeUuid).toBeUndefined();
  });

  it('leaves the field absent when the event carries no uuid', () => {
    const next = applyClaudeTranscriptEvent(
      emptyState(),
      {
        type: 'assistant',
        message: {
          id: 'msg_3',
          role: 'assistant',
          content: [{ type: 'text', text: 'No chain uuid' }],
        },
      },
      options,
    );

    const assistant = next.messages.find(
      (message) => message.role === 'assistant',
    );
    expect(assistant).toBeDefined();
    expect(assistant?.claudeUuid).toBeUndefined();
  });
});
