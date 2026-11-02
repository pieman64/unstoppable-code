import { getDisplayBlockKey } from '../display-block-keys';
import type { DisplayBlock } from '../types';

describe('getDisplayBlockKey', () => {
  it('uses stable provider identifiers for tool and agent blocks', () => {
    expect(
      getDisplayBlockKey(
        {
          type: 'tool_use',
          toolUseId: 'tool-1',
          toolName: 'Bash',
          input: '{}',
        },
        0,
      ),
    ).toBe('tool_use:tool-1');
    expect(
      getDisplayBlockKey({ type: 'tool_result', toolUseId: 'tool-1' }, 1),
    ).toBe('tool_result:tool-1');
    expect(
      getDisplayBlockKey(
        {
          type: 'agent',
          toolUseId: 'agent-1',
          subagentType: 'worker',
          description: 'Work',
          prompt: 'Do work',
          runInBackground: true,
          subBlocks: [],
        },
        2,
      ),
    ).toBe('agent:agent-1');
    expect(
      getDisplayBlockKey(
        {
          type: 'codex_agent',
          agentBlockId: 'agent-block-1',
          callId: 'call-1',
          status: 'inProgress',
          senderThreadId: 'thread-a',
          receiverThreadIds: ['thread-b'],
          prompt: 'Do work',
          description: 'Work',
          displayName: 'Worker',
          agentsStates: {},
          subBlocks: [],
        },
        3,
      ),
    ).toBe('codex-agent:agent-block-1');
    expect(
      getDisplayBlockKey(
        {
          type: 'delegated_agent_call',
          agentBlockId: 'delegated-agent-child-run-2',
          delegationId: 'child',
          parentTurnId: 'turn',
          sequence: 1,
          createdAt: 1,
          selectedModelId: 'sonnet',
          runtimeModelId: 'claude-sonnet-4-6',
          targetHarnessId: 'claude',
          parentToolCallId: 'spawn',
          parentHarnessId: 'codex',
          description: 'Review',
          prompt: 'Review',
          executionMode: 'background',
          status: 'running',
          runGeneration: 2,
          outputTruncated: false,
          subBlocks: [],
        },
        4,
      ),
    ).toBe('delegated-agent:delegated-agent-child-run-2');
  });

  it('keeps turn timer keys stable when completedAt changes', () => {
    const running: DisplayBlock = {
      type: 'turn_timer',
      startedAt: 123,
      completedAt: null,
    };
    const completed: DisplayBlock = {
      ...running,
      completedAt: 456,
    };

    expect(getDisplayBlockKey(running, 0)).toBe(
      getDisplayBlockKey(completed, 0),
    );
  });

  it('does not key streaming text by content', () => {
    const first: DisplayBlock = { type: 'text', text: 'hello' };
    const appended: DisplayBlock = { type: 'text', text: 'hello world' };

    expect(getDisplayBlockKey(first, 4)).toBe(getDisplayBlockKey(appended, 4));
  });

  it('uses the index to disambiguate approval resolutions in the same millisecond', () => {
    const block: DisplayBlock = {
      type: 'approval_resolution_info',
      timestamp: 123,
      resolvedBy: 'mode-change',
      mode: 'full-access',
      titles: ['ls apps/web/src/app/'],
    };

    expect(getDisplayBlockKey(block, 0)).toBe('approval-resolution:123:0');
    expect(getDisplayBlockKey(block, 1)).toBe('approval-resolution:123:1');
  });

  it('keys safety denial receipts by receipt identity, not position or time', () => {
    const block: DisplayBlock = {
      type: 'approval_safety_denied_info',
      receiptId: 'approval-safety-abc',
      timestamp: 123,
      reason: 'force-push',
      command: 'git push --force origin HEAD',
      mode: 'ask',
      toolUseId: 'tool-1',
    };

    expect(getDisplayBlockKey(block, 0)).toBe(
      'approval-safety-denied:approval-safety-abc',
    );
    expect(getDisplayBlockKey(block, 3)).toBe(getDisplayBlockKey(block, 0));
  });

  it('uses the index to disambiguate pending setup blocks with the same timestamp', () => {
    const block: DisplayBlock = {
      type: 'pending_setup_info',
      timestamp: 123,
    };

    expect(getDisplayBlockKey(block, 0)).toBe('pending-setup:123:0');
    expect(getDisplayBlockKey(block, 1)).toBe('pending-setup:123:1');
  });
});
