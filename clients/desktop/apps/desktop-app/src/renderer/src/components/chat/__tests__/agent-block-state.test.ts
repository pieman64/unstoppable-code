import type { ToolResult } from '../types';
import { isClaudeAgentRunning } from '../agent-block-state';

describe('isClaudeAgentRunning', () => {
  it('does not treat an agent id mention as a running foreground result', () => {
    const result: ToolResult = {
      output: 'Done. agentId: abc123',
      isError: false,
    };

    expect(isClaudeAgentRunning(false, result)).toBe(false);
    expect(isClaudeAgentRunning(true, result)).toBe(true);
  });

  it('recognizes an async agent launch regardless of the background flag', () => {
    const result: ToolResult = {
      output: 'Async agent launched successfully. agentId: abc123',
      isError: false,
    };

    expect(isClaudeAgentRunning(false, result)).toBe(true);
  });

  it('does not treat an error result as a running agent', () => {
    const result: ToolResult = {
      output: 'Async agent launched successfully. agentId: abc123',
      isError: true,
    };

    expect(isClaudeAgentRunning(false, result)).toBe(false);
  });

  it('settles when task output is present', () => {
    const launchResult: ToolResult = {
      output: 'Async agent launched successfully. agentId: abc123',
      isError: false,
    };
    const taskOutputResult: ToolResult = {
      output: 'Task completed',
      isError: false,
    };

    expect(isClaudeAgentRunning(false, launchResult, taskOutputResult)).toBe(
      false,
    );
  });

  it('stays running when its task output read returned before it finished', () => {
    const launchResult: ToolResult = {
      output: 'Async agent launched successfully. agentId: abc123',
      isError: false,
    };
    for (const status of ['not_ready', 'timeout']) {
      const taskOutputResult: ToolResult = {
        output: `<retrieval_status>${status}</retrieval_status>\n\n<status>running</status>`,
        isError: false,
      };
      expect(isClaudeAgentRunning(true, launchResult, taskOutputResult)).toBe(
        true,
      );
    }
  });

  it('assumes an agent without a result is still running', () => {
    expect(isClaudeAgentRunning(false)).toBe(true);
  });

  it('lets a known background status override result inference', () => {
    const launchResult: ToolResult = {
      output: 'Async agent launched successfully. agentId: abc123',
      isError: false,
    };
    const errorResult: ToolResult = {
      output: 'Failed to launch',
      isError: true,
    };

    expect(
      isClaudeAgentRunning(false, launchResult, undefined, 'completed'),
    ).toBe(false);
    expect(isClaudeAgentRunning(false, errorResult, undefined, 'running')).toBe(
      true,
    );
    expect(isClaudeAgentRunning(false, undefined, undefined, 'queued')).toBe(
      true,
    );
  });
});

describe('isClaudeAgentRunning with non-hex agent ids', () => {
  it('treats a background launch receipt naming any agent id as running', () => {
    const result: ToolResult = {
      output: 'Launched.\nagentId: task-watch',
      isError: false,
    };

    expect(isClaudeAgentRunning(true, result)).toBe(true);
    expect(isClaudeAgentRunning(false, result)).toBe(false);
  });
});
