import {
  createCursorAssistantPatchProjector,
  runtimeChatEventToPortalMessage,
} from '../runtime-chat-projection';

describe('16c live primary output remains preview-only', () => {
  it('does not advertise canonical row reads for a live delegation snapshot', () => {
    const projected = runtimeChatEventToPortalMessage({
      scope: 'worktree',
      chatId: 'chat',
      data: {
        type: 'canopy_delegation',
        delegation: {
          delegationId: 'delegate-1',
          runGeneration: 1,
          sequence: 1,
          parentHarnessId: 'claude',
          parentTurnId: 'turn-1',
          parentToolCallId: 'tool-1',
          createdAt: 1,
          task: {
            description: 'Inspect',
            prompt: 'Inspect output',
            executionMode: 'foreground',
          },
          snapshot: {
            delegationId: 'delegate-1',
            status: 'completed',
            requestedModelId: 'model',
            outputTruncated: false,
            routeSnapshot: {
              selectedModelId: 'model',
              runtimeModelId: 'model',
              harnessId: 'claude',
            },
          },
          transcript: [
            {
              id: 'live-tool',
              sequence: 1,
              occurredAt: 1,
              type: 'tool',
              toolName: 'Read',
              input: '{}',
              output: 'x'.repeat(4001),
              isError: false,
            },
          ],
        },
      },
    });
    expect(projected?.parts?.[0]?.kind).toBe('agent');
    expect(JSON.stringify(projected)).toContain('live-tool');
    expect(JSON.stringify(projected)).not.toContain('outputLocator');
  });

  it('does not invent a locator from a Claude runtime display id or part index', () => {
    const projected = runtimeChatEventToPortalMessage({
      scope: 'worktree',
      chatId: 'chat',
      fallbackMessageId: 'display-only',
      data: {
        type: 'user',
        message: {
          id: 'sdk-row',
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'read',
              content: 'x'.repeat(4001),
            },
          ],
        },
      },
    });
    expect(projected?.parts).toHaveLength(1);
    expect(projected?.parts?.[0]?.kind).toBe('tool_result');
    expect(JSON.stringify(projected)).not.toContain('outputLocator');
  });

  it.each([
    {
      type: 'command_execution',
      command: 'ls',
      aggregated_output: 'x'.repeat(4001),
      exit_code: 0,
    },
    {
      type: 'dynamic_tool_call',
      tool: 'Read',
      arguments: {},
      content_items: [{ type: 'input_text', text: 'x'.repeat(4001) }],
      success: true,
    },
    {
      type: 'mcp_tool_call',
      server: 'tools',
      tool: 'Read',
      arguments: {},
      result: { content: [{ type: 'text', text: 'x'.repeat(4001) }] },
    },
  ])('does not invent a locator for Codex $type', (item) => {
    const projected = runtimeChatEventToPortalMessage({
      scope: 'standalone',
      chatId: 'chat',
      data: {
        type: 'codex',
        event: {
          type: 'item.completed',
          item: { ...item, id: 'runtime-item', status: 'completed' },
        },
      },
    });
    expect(projected?.parts?.map((part) => part.kind)).toEqual([
      'tool_use',
      'tool_result',
    ]);
    expect(JSON.stringify(projected)).not.toContain('outputLocator');
  });

  it.each(['cursor', 'copilot', 'opencode'])(
    'does not mistake a live %s folded patch for a canonical persisted row',
    (provider) => {
      const projector = createCursorAssistantPatchProjector({
        scope: 'worktree',
        chatId: 'chat',
      });
      const projected = projector.apply({
        type: 'canopy_assistant_patch',
        provider,
        messageId: 'live-patch-row',
        timestamp: 1,
        patches: [
          {
            index: 0,
            block: {
              type: 'tool_use',
              toolUseId: 'read',
              toolName: 'Read',
              input: '{}',
            },
          },
          {
            index: 1,
            block: {
              type: 'tool_result',
              toolUseId: 'read',
              toolName: 'Read',
              output: 'x'.repeat(4001),
              isError: false,
            },
          },
        ],
      });
      expect(projected?.parts).toHaveLength(1);
      expect(projected?.parts?.[0]).toHaveProperty(
        'data.result.output',
        expect.any(String),
      );
      expect(JSON.stringify(projected)).not.toContain('outputLocator');
    },
  );
});
