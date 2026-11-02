/**
 * Focused tests for {@link dispatchCodexActivityEvent}'s `mcp_tool_call`
 * branch (frontend plan Phase 1). The activity store is mocked so the tests
 * can assert the exact IDs, names, inputs, outputs, and error flags handed to
 * `handleToolUseBlock()` / `handleToolResultBlock()`; the name/output/error
 * mapping itself comes from the real shared `codexMcpToolName()` /
 * `previewCodexMcpToolResult()` helpers, the bounded preview of the output
 * persisted chat stores in full.
 */
import { dispatchCodexActivityEvent } from '../activity-dispatch';
import { useActivityStore } from '../../activityStore';

jest.mock('../../activityStore', () => ({
  useActivityStore: {
    getState: jest.fn(),
  },
}));

const handleToolUseBlock = jest.fn();
const handleToolResultBlock = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  (useActivityStore.getState as jest.Mock).mockReturnValue({
    handleToolUseBlock,
    handleToolResultBlock,
  });
});

function codexEvent(
  innerType: string,
  item: Record<string, unknown>,
): Record<string, unknown> {
  return { type: 'codex', event: { type: innerType, item } };
}

const mcpItem = {
  type: 'mcp_tool_call',
  id: 'mcp-success',
  server: 'appproxy-internal-hub-prod--opaque',
  tool: 'query-gcp-logs',
  status: 'inProgress',
  arguments: { filter: 'operationId="fixture-operation"' },
  result: null,
  error: null,
};

describe('dispatchCodexActivityEvent mcp_tool_call', () => {
  it('registers one pending activity entry on item.started', () => {
    const handled = dispatchCodexActivityEvent(
      'project',
      'worktree',
      'chat-1',
      codexEvent('item.started', mcpItem),
    );

    expect(handled).toBe(true);
    expect(handleToolUseBlock).toHaveBeenCalledTimes(1);
    expect(handleToolUseBlock).toHaveBeenCalledWith(
      'project',
      'worktree',
      'chat-1',
      'codex-mcp-success',
      'mcp__appproxy-internal-hub-prod--opaque__query-gcp-logs',
      '{"filter":"operationId=\\"fixture-operation\\""}',
    );
    expect(handleToolResultBlock).not.toHaveBeenCalled();
  });

  it('serializes missing arguments as an empty JSON object', () => {
    dispatchCodexActivityEvent(
      'project',
      'worktree',
      'chat-1',
      codexEvent('item.started', {
        ...mcpItem,
        arguments: undefined,
        server: '',
        tool: '',
      }),
    );

    expect(handleToolUseBlock).toHaveBeenCalledWith(
      'project',
      'worktree',
      'chat-1',
      'codex-mcp-success',
      'mcp__unknown__unknown',
      '{}',
    );
  });

  it('ignores item.updated without a second activity or a result', () => {
    const handled = dispatchCodexActivityEvent(
      'project',
      'worktree',
      'chat-1',
      codexEvent('item.updated', {
        ...mcpItem,
        _meta: { progress: 0.4 },
      }),
    );

    expect(handled).toBe(true);
    expect(handleToolUseBlock).not.toHaveBeenCalled();
    expect(handleToolResultBlock).not.toHaveBeenCalled();
  });

  it('resolves a successful item.completed through the shared flattener', () => {
    dispatchCodexActivityEvent(
      'project',
      'worktree',
      'chat-1',
      codexEvent('item.completed', {
        ...mcpItem,
        status: 'completed',
        result: {
          content: [{ type: 'text', text: '3 log entries' }],
          structuredContent: { rows: ['sentinel-structured-content'] },
        },
      }),
    );

    expect(handleToolUseBlock).not.toHaveBeenCalled();
    expect(handleToolResultBlock).toHaveBeenCalledTimes(1);
    expect(handleToolResultBlock).toHaveBeenCalledWith(
      'project',
      'worktree',
      'chat-1',
      'codex-mcp-success',
      '3 log entries',
      false,
    );
  });

  it('maps a transport failure to the error message with isError=true', () => {
    dispatchCodexActivityEvent(
      'project',
      'worktree',
      'chat-1',
      codexEvent('item.completed', {
        ...mcpItem,
        id: 'mcp-failure',
        status: 'failed',
        result: null,
        error: { message: 'HTTP 504 gateway timeout' },
      }),
    );

    expect(handleToolResultBlock).toHaveBeenCalledTimes(1);
    expect(handleToolResultBlock).toHaveBeenCalledWith(
      'project',
      'worktree',
      'chat-1',
      'codex-mcp-failure',
      'HTTP 504 gateway timeout',
      true,
    );
  });

  it('keeps concurrent item IDs independent', () => {
    dispatchCodexActivityEvent(
      'project',
      'worktree',
      'chat-1',
      codexEvent('item.started', mcpItem),
    );
    dispatchCodexActivityEvent(
      'project',
      'worktree',
      'chat-1',
      codexEvent('item.started', { ...mcpItem, id: 'mcp-failure' }),
    );

    expect(handleToolUseBlock).toHaveBeenCalledTimes(2);
    expect(handleToolUseBlock).toHaveBeenNthCalledWith(
      1,
      'project',
      'worktree',
      'chat-1',
      'codex-mcp-success',
      expect.any(String),
      expect.any(String),
    );
    expect(handleToolUseBlock).toHaveBeenNthCalledWith(
      2,
      'project',
      'worktree',
      'chat-1',
      'codex-mcp-failure',
      expect.any(String),
      expect.any(String),
    );
  });
});
