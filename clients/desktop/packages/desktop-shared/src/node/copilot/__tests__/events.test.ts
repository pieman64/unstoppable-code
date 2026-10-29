import type { SessionEvent } from '@github/copilot-sdk';
import { parseAgentTranscriptLines } from '@canopy/agent-transcript';
import { CopilotEventProjection } from '../events';

describe('Copilot canonical transcript projection', () => {
  let sequence = 0;
  const event = (type: string, data: unknown): SessionEvent =>
    ({
      id: `event-${++sequence}`,
      type,
      data,
      timestamp: '2026-09-29T00:00:00.000Z',
      parentId: null,
      ephemeral: false,
    }) as SessionEvent;

  it('persists linear-size deltas and reconciles final text without losing interleaved answers', () => {
    const projection = new CopilotEventProjection('turn', '/workspace');
    const records = [
      event('assistant.message_delta', {
        messageId: 'one',
        deltaContent: 'Hel',
      }),
      event('assistant.message_delta', {
        messageId: 'one',
        deltaContent: 'lo',
      }),
      event('assistant.reasoning', {
        reasoningId: 'reason',
        content: 'Thinking',
      }),
      event('assistant.message', { messageId: 'two', content: ' world' }),
      event('assistant.message', { messageId: 'one', content: 'Hello' }),
    ].map((value) => projection.accept(value));
    expect(records[1]).toMatchObject({
      patches: [{ index: 0, appendText: 'lo' }],
    });
    expect(projection.text).toBe('Hello world');
    const restored = parseAgentTranscriptLines(
      records.map((value) => JSON.stringify(value)),
    );
    expect(restored.providerType).toBe('copilot');
    const blocks = restored.messages.flatMap((message) => message.blocks);
    expect(blocks).toEqual(
      expect.arrayContaining([
        { type: 'text', text: 'Hello' },
        { type: 'text', text: ' world' },
        { type: 'thinking', text: 'Thinking' },
      ]),
    );
  });

  it('pairs tool calls/results across reload and suppresses duplicate SDK events', () => {
    const projection = new CopilotEventProjection('turn', '/workspace');
    const start = event('tool.execution_start', {
      toolCallId: 'tool',
      toolName: 'view',
      arguments: { path: 'a.txt' },
    });
    const first = projection.accept(start);
    expect(projection.accept(start)).toBeUndefined();
    const result = projection.accept(
      event('tool.execution_complete', {
        toolCallId: 'tool',
        success: true,
        result: { content: 'contents' },
      }),
    );
    const restored = parseAgentTranscriptLines(
      [first, result].map((value) => JSON.stringify(value)),
    );
    expect(restored.messages.flatMap((message) => message.blocks)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool_use',
          toolUseId: 'turn:tool',
          display: {
            toolName: 'Read',
            input: JSON.stringify({ file_path: '/workspace/a.txt' }),
          },
        }),
        expect.objectContaining({
          type: 'tool_result',
          toolUseId: 'turn:tool',
          output: 'contents',
          isError: false,
        }),
      ]),
    );
  });

  it('does not flatten unexpected native child output into the root answer', () => {
    const projection = new CopilotEventProjection('turn', '/workspace');
    expect(
      projection.accept({
        ...event('assistant.message', { messageId: 'child', content: 'child' }),
        agentId: 'native-child',
      }),
    ).toBeUndefined();
    expect(projection.text).toBe('');
  });

  it('uses MCP provenance to preserve the shared interactive tool identity', () => {
    const projection = new CopilotEventProjection('turn', '/workspace');
    const input = { questions: [{ question: 'Choose', options: ['A', 'B'] }] };
    const records = [
      event('tool.execution_start', {
        toolCallId: 'mcp-question',
        toolName: 'wire-AskUserQuestion',
        mcpServerName: 'wire',
        mcpConfigServerName: 'canopy_ui',
        mcpToolName: 'AskUserQuestion',
        arguments: input,
      }),
      event('tool.execution_complete', {
        toolCallId: 'mcp-question',
        success: true,
        result: { content: 'B' },
      }),
    ].map((value) => projection.accept(value));
    const blocks = parseAgentTranscriptLines(
      records.map((value) => JSON.stringify(value)),
    ).messages.flatMap((message) => message.blocks);
    expect(blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool_use',
          toolName: 'mcp__canopy_ui__AskUserQuestion',
          input: JSON.stringify(input),
          toolUseId: 'turn:mcp-question',
        }),
        expect.objectContaining({
          type: 'tool_result',
          toolName: 'mcp__canopy_ui__AskUserQuestion',
          output: 'B',
          toolUseId: 'turn:mcp-question',
        }),
      ]),
    );
  });

  it('projects native questions into the shared interactive card and retains the answered pair on reload', () => {
    const projection = new CopilotEventProjection('turn', '/workspace');
    const records = [
      event('tool.execution_start', {
        toolCallId: 'question',
        toolName: 'ask_user',
        arguments: {
          question: 'Choose a color',
          choices: ['Blue', 'Green'],
          allowFreeform: false,
        },
      }),
      event('tool.execution_complete', {
        toolCallId: 'question',
        success: true,
        result: { content: 'Green' },
      }),
    ].map((value) => projection.accept(value));
    const restored = parseAgentTranscriptLines(
      records.map((value) => JSON.stringify(value)),
    );
    expect(restored.messages.flatMap((message) => message.blocks)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool_use',
          toolUseId: 'turn:question',
          toolName: 'AskUserQuestion',
          input: JSON.stringify({
            questions: [
              {
                question: 'Choose a color',
                options: ['Blue', 'Green'],
                allowOther: false,
              },
            ],
          }),
        }),
        expect.objectContaining({
          type: 'tool_result',
          toolUseId: 'turn:question',
          toolName: 'AskUserQuestion',
          output: 'Green',
        }),
      ]),
    );
  });
});
