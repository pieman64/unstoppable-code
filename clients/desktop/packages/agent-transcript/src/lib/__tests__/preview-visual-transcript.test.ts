import {
  applyClaudeTranscriptEvent,
  applyCodexTranscriptEvent,
  createEmptyTranscriptReducerState,
  type TranscriptReducerOptions,
} from '../transcript-parser';

const options: TranscriptReducerOptions = {
  now: 1,
  createMessageId: (): string => 'message-1',
  childToolLiveness: { kind: 'unknown' },
};
const image = 'data:image/png;base64,' + 'A'.repeat(400);

it('omits a PreviewVisual image when replaying a Codex dynamic tool result', () => {
  const state = applyCodexTranscriptEvent(
    createEmptyTranscriptReducerState(),
    {
      type: 'item.completed',
      item: {
        id: 'preview-1',
        type: 'dynamic_tool_call',
        tool: 'canopy_preview_visual',
        status: 'completed',
        success: true,
        arguments: { html: '<p>ok</p>' },
        content_items: [
          { type: 'inputText', text: 'height 100' },
          { type: 'inputImage', imageUrl: image },
        ],
      },
    },
    options,
  );
  expect(JSON.stringify(state.messages)).toContain('not stored');
  expect(JSON.stringify(state.messages)).not.toContain(image);
});

it('omits a linked Claude PreviewVisual image and preserves another result', () => {
  const start = {
    ...createEmptyTranscriptReducerState(),
    messages: [
      {
        id: 'prior',
        role: 'assistant' as const,
        timestamp: 1,
        blocks: [
          {
            type: 'tool_use' as const,
            toolUseId: 'preview',
            toolName: 'mcp__canopy__PreviewVisual',
            input: '{}',
          },
          {
            type: 'tool_use' as const,
            toolUseId: 'browser',
            toolName: 'browser.screenshot',
            input: '{}',
          },
        ],
      },
    ],
  };
  const state = applyClaudeTranscriptEvent(
    start,
    {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'preview',
            content: [
              { type: 'image', data: 'A'.repeat(400), mimeType: 'image/png' },
            ],
          },
          {
            type: 'tool_result',
            tool_use_id: 'browser',
            content: [
              { type: 'image', data: 'A'.repeat(400), mimeType: 'image/png' },
            ],
          },
        ],
      },
    },
    options,
  );
  const output = JSON.stringify(state.messages);
  expect(output).toContain('not stored');
  expect(output).toContain('A'.repeat(400));
});
