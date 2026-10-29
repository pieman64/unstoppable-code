import {
  createPreviewVisualTracker,
  projectPreviewVisualResult,
} from '../preview-visual-projection';
import { CANOPY_INJECTED_TOOL_REGISTRY } from '../canopy-injected-tools';

const base64 = 'data:image/png;base64,' + 'A'.repeat(400);

describe('preview visual event projection', () => {
  it('removes Claude images only for a linked PreviewVisual result', () => {
    const tracker = createPreviewVisualTracker();
    projectPreviewVisualResult(
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'preview',
              name: CANOPY_INJECTED_TOOL_REGISTRY.preview_visual.claudeToolName,
            },
            { type: 'tool_use', id: 'browser', name: 'browser.screenshot' },
          ],
        },
      },
      tracker,
    );
    const event = {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'preview',
            content: [
              { type: 'text', text: 'height 100' },
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
    };
    const projected = projectPreviewVisualResult(event, tracker);
    expect(JSON.stringify(projected)).toContain('not stored');
    expect(JSON.stringify(projected)).toContain('height 100');
    expect(JSON.stringify(projected)).not.toContain(
      'A'.repeat(400) + '\"},{\"type\":\"tool_result\"',
    );
    expect(event.message.content[1]).toEqual(
      (projected as typeof event).message.content[1],
    );
  });

  it.each(['tool_use_result', 'toolUseResult'])(
    'strips the Claude copy of the result in %s as well as the message content',
    (key) => {
      // Shape from a real Claude session: an MCP image result is repeated,
      // block for block, in the event's top-level structured result.
      const tracker = createPreviewVisualTracker();
      projectPreviewVisualResult(
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'preview',
                name: CANOPY_INJECTED_TOOL_REGISTRY.preview_visual
                  .claudeToolName,
              },
            ],
          },
        },
        tracker,
      );
      const result = [
        { type: 'text', text: 'height 100' },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'A'.repeat(400),
          },
        },
      ];
      const event = {
        type: 'user',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            { tool_use_id: 'preview', type: 'tool_result', content: result },
          ],
        },
        [key]: result,
      };
      const stripped = [
        { type: 'text', text: 'height 100' },
        { type: 'text', text: 'Preview screenshot, 300 bytes, not stored' },
      ];
      const projected = projectPreviewVisualResult(event, tracker);
      expect(JSON.stringify(projected)).not.toContain('A'.repeat(400));
      expect(projected).toEqual({
        type: 'user',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            { tool_use_id: 'preview', type: 'tool_result', content: stripped },
          ],
        },
        [key]: stripped,
      });
      // Another tool's event keeps both copies of its image.
      const browser = {
        ...event,
        message: {
          role: 'user',
          content: [
            { tool_use_id: 'browser', type: 'tool_result', content: result },
          ],
        },
      };
      expect(projectPreviewVisualResult(browser, tracker)).toBe(browser);
    },
  );

  it('removes Codex inputImage for the exact dynamic tool only', () => {
    const tracker = createPreviewVisualTracker();
    const event = {
      type: 'item.completed',
      item: {
        type: 'dynamic_tool_call',
        tool: CANOPY_INJECTED_TOOL_REGISTRY.preview_visual.codexToolName,
        content_items: [
          { type: 'inputText', text: 'height 100' },
          { type: 'inputImage', imageUrl: base64 },
        ],
      },
    };
    expect(
      JSON.stringify(projectPreviewVisualResult(event, tracker)),
    ).not.toContain(base64);
    expect(
      JSON.stringify(projectPreviewVisualResult(event, tracker)),
    ).toContain('not stored');
    const browser = {
      ...event,
      item: { ...event.item, tool: 'browser.screenshot' },
    };
    expect(projectPreviewVisualResult(browser, tracker)).toBe(browser);
  });

  it('strips a live Codex event inside its envelope and keeps the Codex text-item shape', () => {
    // The app-server client delivers `{ type: 'codex', event: { item } }`.
    const tracker = createPreviewVisualTracker();
    const event = {
      type: 'codex',
      event: {
        type: 'item.completed',
        item: {
          type: 'dynamic_tool_call',
          tool: CANOPY_INJECTED_TOOL_REGISTRY.preview_visual.codexToolName,
          content_items: [
            { type: 'inputText', text: 'height 100' },
            { type: 'inputImage', imageUrl: base64 },
          ],
        },
      },
    };
    const projected = projectPreviewVisualResult(event, tracker);
    expect(JSON.stringify(projected)).not.toContain(base64);
    // Codex flattens only inputText items; any other shape reads as
    // "[unsupported output omitted]" in the transcript and the Portal.
    expect(projected).toEqual({
      type: 'codex',
      event: {
        type: 'item.completed',
        item: {
          type: 'dynamic_tool_call',
          tool: CANOPY_INJECTED_TOOL_REGISTRY.preview_visual.codexToolName,
          content_items: [
            { type: 'inputText', text: 'height 100' },
            {
              type: 'inputText',
              text: 'Preview screenshot, 300 bytes, not stored',
            },
          ],
        },
      },
    });
    const browser = {
      type: 'codex',
      event: {
        ...event.event,
        item: { ...event.event.item, tool: 'canopy_dispatch_action' },
      },
    };
    expect(projectPreviewVisualResult(browser, tracker)).toBe(browser);
  });

  it('removes Cursor image content only with host-authored invocation identity', () => {
    const tracker = createPreviewVisualTracker();
    const event = {
      type: 'canopy_assistant_patch',
      provider: 'cursor',
      canopyTrustedPreviewToolIds: ['preview'],
      patches: [
        {
          block: {
            type: 'tool_result',
            toolUseId: 'preview',
            output: JSON.stringify([
              { type: 'image', mimeType: 'image/png', data: 'A'.repeat(400) },
            ]),
          },
        },
      ],
    };
    const projected = projectPreviewVisualResult(event, tracker);
    expect(JSON.stringify(projected)).not.toContain('A'.repeat(400));
    expect(JSON.stringify(projected)).toContain('not stored');
    expect(
      projectPreviewVisualResult(
        { ...event, canopyTrustedPreviewToolIds: [] },
        tracker,
      ),
    ).toEqual({
      type: event.type,
      provider: event.provider,
      patches: event.patches,
    });
  });
});
