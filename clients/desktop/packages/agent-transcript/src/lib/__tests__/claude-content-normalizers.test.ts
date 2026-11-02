import {
  applyClaudeTranscriptEvent,
  createEmptyTranscriptReducerState,
  type TranscriptReducerOptions,
} from '../transcript-parser';
import {
  parseClaudeAssistantBlocks,
  parseClaudeToolResults,
} from '../claude-content-normalizers';

const options: TranscriptReducerOptions = {
  now: 123,
  createMessageId: () => 'generated-message',
  childToolLiveness: { kind: 'unknown' },
};

describe('Claude content normalizers', () => {
  it('matches the primary assistant parser for canonical block fixtures', () => {
    const content: unknown[] = [
      { type: 'text', text: 'Assistant text' },
      { type: 'thinking', thinking: 'Private reasoning' },
      {
        type: 'tool_use',
        id: 'call-1',
        name: 'Bash',
        input: { command: 'pwd' },
      },
      { type: 'unsupported', text: 'not persisted' },
      { type: 'text', text: '' },
    ];
    const parsed = parseClaudeAssistantBlocks(content);
    const state = applyClaudeTranscriptEvent(
      createEmptyTranscriptReducerState(),
      {
        type: 'assistant',
        message: { id: 'assistant-1', role: 'assistant', content },
      },
      options,
    );
    const primaryMessage = state.messages[state.messages.length - 1];

    expect(primaryMessage?.blocks).toEqual(parsed);
    expect(parsed).toEqual([
      { type: 'text', text: 'Assistant text' },
      { type: 'thinking', text: 'Private reasoning' },
      {
        type: 'tool_use',
        toolUseId: 'call-1',
        toolName: 'Bash',
        input: '{"command":"pwd"}',
      },
    ]);
  });

  it('matches the primary tool-result parser without assigning finality', () => {
    const content: unknown[] = [
      {
        type: 'tool_result',
        tool_use_id: 'call-1',
        content: [
          { type: 'text', text: 'Done' },
          { type: 'json', value: 2 },
        ],
        is_error: true,
      },
      { type: 'text', text: 'not a tool result' },
    ];
    const parsed = parseClaudeToolResults(content);
    const state = applyClaudeTranscriptEvent(
      createEmptyTranscriptReducerState(),
      {
        type: 'user',
        message: { id: 'tool-message', role: 'user', content },
        parent_tool_use_id: 'call-1',
      },
      options,
    );
    const primaryMessage = state.messages[state.messages.length - 1];

    expect(primaryMessage?.blocks).toEqual(parsed);
    expect(parsed).toEqual([
      {
        type: 'tool_result',
        toolUseId: 'call-1',
        toolName: '',
        output: 'Done\n{\n  "type": "json",\n  "value": 2\n}',
        isError: true,
      },
    ]);
  });
});
