import {
  applyCodexTranscriptEvent,
  createEmptyTranscriptReducerState,
} from '../transcript-parser';
import { codexNeutralItemBlocks } from '../codex-neutral-item';
import { codexDynamicToolOutput } from '../codex-dynamic-tool-results';
import { codexMcpToolResult } from '../codex-mcp-tool-results';
import {
  codexToolImageBlocks,
  withCodexImagePreviewNotices,
} from '../codex-tool-images';

describe('codexNeutralItemBlocks', () => {
  it('normalizes native text, reasoning, command, file-change, and error items', () => {
    expect(
      codexNeutralItemBlocks(
        { id: 'text-1', type: 'agent_message', text: 'Hello' },
        'item.completed',
      ),
    ).toEqual({ role: 'assistant', blocks: [{ type: 'text', text: 'Hello' }] });
    expect(
      codexNeutralItemBlocks(
        { id: 'reason-1', type: 'reasoning', text: 'Thinking' },
        'item.updated',
      ),
    ).toEqual({
      role: 'assistant',
      blocks: [{ type: 'thinking', text: 'Thinking' }],
    });
    expect(
      codexNeutralItemBlocks(
        {
          id: 'command-1',
          type: 'command_execution',
          command: 'npm test',
          status: 'inProgress',
        },
        'item.started',
      ),
    ).toEqual({
      role: 'system',
      blocks: [
        {
          type: 'tool_use',
          toolUseId: 'codex-command-1',
          toolName: 'command',
          input: 'npm test',
        },
      ],
    });
    expect(
      codexNeutralItemBlocks(
        {
          id: 'change-1',
          type: 'file_change',
          changes: [{ kind: 'add', path: 'src/new.ts' }],
          status: 'completed',
        },
        'item.updated',
      ),
    ).toEqual({
      role: 'system',
      blocks: [
        {
          type: 'tool_use',
          toolUseId: 'codex-change-1',
          toolName: 'file_change',
          input: 'add: src/new.ts',
        },
        {
          type: 'tool_result',
          toolUseId: 'codex-change-1',
          toolName: 'file_change',
          output: 'completed',
          isError: false,
        },
      ],
    });
    expect(
      codexNeutralItemBlocks(
        { id: 'error-1', type: 'error', message: 'Denied' },
        'item.completed',
      ),
    ).toEqual({
      role: 'system',
      blocks: [{ type: 'text', text: 'Error: Denied' }],
    });
  });

  it('uses dynamic/MCP normalizers and preserves images, errors, and exclusions', () => {
    const image = {
      type: 'inputImage',
      imageUrl: 'data:image/png;base64,AA==',
    };
    const contentItems = [{ type: 'inputText', text: 'dynamic result' }, image];
    const dynamic = codexNeutralItemBlocks(
      {
        id: 'dynamic-1',
        type: 'dynamic_tool_call',
        tool: 'provider.raw_tool',
        arguments: { arg: 1 },
        status: 'completed',
        success: true,
        content_items: contentItems,
      },
      'item.completed',
    );
    expect(dynamic).toEqual({
      role: 'system',
      blocks: [
        {
          type: 'tool_use',
          toolUseId: 'codex-dynamic-1',
          toolName: 'provider.raw_tool',
          input: '{"arg":1}',
        },
        {
          type: 'tool_result',
          toolUseId: 'codex-dynamic-1',
          toolName: 'provider.raw_tool',
          output: codexDynamicToolOutput({
            contentItems: withCodexImagePreviewNotices(contentItems),
            success: true,
          }),
          isError: false,
        },
        ...codexToolImageBlocks(contentItems),
      ],
    });

    const mcpResult = {
      content: [
        { type: 'resource', resource: { text: 'resource result' } },
        {
          type: 'image',
          mimeType: 'image/png',
          data: 'AA==',
        },
      ],
      structuredContent: { count: 2 },
    };
    const mcp = codexNeutralItemBlocks(
      {
        id: 'mcp-1',
        type: 'mcp_tool_call',
        server: 'fs',
        tool: 'read_file',
        arguments: { path: '/tmp/a' },
        status: 'failed',
        result: mcpResult,
        error: { message: 'read denied' },
      },
      'item.completed',
    );
    expect(mcp).toEqual({
      role: 'system',
      blocks: [
        {
          type: 'tool_use',
          toolUseId: 'codex-mcp-1',
          toolName: 'mcp__fs__read_file',
          input: '{"path":"/tmp/a"}',
        },
        {
          type: 'tool_result',
          toolUseId: 'codex-mcp-1',
          toolName: 'mcp__fs__read_file',
          ...codexMcpToolResult({
            status: 'failed',
            result: {
              ...mcpResult,
              content: withCodexImagePreviewNotices(mcpResult.content),
            },
            error: { message: 'read denied' },
          }),
        },
        ...codexToolImageBlocks(mcpResult.content),
      ],
    });

    const resourceResult = {
      content: [{ type: 'resource', resource: { text: 'resource text' } }],
    };
    const resourceItem = codexNeutralItemBlocks(
      {
        id: 'mcp-resource',
        type: 'mcp_tool_call',
        server: 'fs',
        tool: 'read_resource',
        status: 'completed',
        result: resourceResult,
        error: null,
      },
      'item.completed',
    );
    expect(resourceItem?.blocks[1]).toMatchObject({
      type: 'tool_result',
      output: codexMcpToolResult({
        status: 'completed',
        result: {
          ...resourceResult,
          content: withCodexImagePreviewNotices(resourceResult.content),
        },
        error: null,
      }).output,
    });

    const structuredResult = { structuredContent: { count: 2 } };
    const structuredItem = codexNeutralItemBlocks(
      {
        id: 'mcp-structured',
        type: 'mcp_tool_call',
        server: 'fs',
        tool: 'inspect',
        status: 'completed',
        result: structuredResult,
        error: null,
      },
      'item.completed',
    );
    expect(structuredItem?.blocks[1]).toMatchObject({
      type: 'tool_result',
      output: codexMcpToolResult({
        status: 'completed',
        result: {
          ...structuredResult,
          content: withCodexImagePreviewNotices(undefined),
        },
        error: null,
      }).output,
    });

    expect(
      codexNeutralItemBlocks(
        { id: 'delegate-1', type: 'collab_agent_tool_call' },
        'item.started',
      ),
    ).toBeUndefined();
    expect(
      codexNeutralItemBlocks(
        { id: 'unknown-1', type: 'not_a_transcript_item' },
        'item.updated',
      ),
    ).toBeUndefined();
  });

  it('matches the primary Codex reducer and uses canonical item IDs', () => {
    const item = {
      id: 'fixture-1',
      type: 'dynamic_tool_call',
      tool: 'raw_dynamic_name',
      arguments: { prompt: 'hello' },
      status: 'completed',
      success: false,
      content_items: [{ type: 'inputText', text: 'failed output' }],
    };
    const normalized = codexNeutralItemBlocks(item, 'item.completed');
    const primary = applyCodexTranscriptEvent(
      createEmptyTranscriptReducerState(),
      { type: 'item.completed', item },
      {
        now: 456,
        createMessageId: () => 'generated-message',
        childToolLiveness: { kind: 'unknown' },
      },
    );
    const primaryMessage = primary.messages[primary.messages.length - 1];

    expect(primaryMessage?.id).toBe('codex-fixture-1');
    expect(primaryMessage?.role).toBe(normalized?.role);
    expect(primaryMessage?.blocks).toEqual(normalized?.blocks);
  });
});
