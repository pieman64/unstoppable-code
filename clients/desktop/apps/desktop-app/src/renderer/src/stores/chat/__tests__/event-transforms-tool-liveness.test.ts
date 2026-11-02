import type {
  CodexAgentCallBlock,
  PersistedChatBlock,
} from '@canopy/agent-transcript';
import { closeOpenToolUseBlocks } from '../event-transforms';
import { restoreStreamingTabs } from '../session-restore';
import { mergeToolResults } from '@canopy/agent-transcript/lib/message-transforms';
import { computeTurnOutcomes } from '@canopy/desktop-shared/lib/turn-utils';
import type { ChatMessage, ChatTab } from '../types';

function message(
  id: string,
  blocks: PersistedChatBlock[],
  metadata: Pick<
    ChatMessage,
    'parentToolUseId' | 'parentBlockId' | 'codexThreadId'
  > = {},
): ChatMessage {
  return {
    id,
    role: 'assistant',
    blocks,
    timestamp: 1,
    ...metadata,
  };
}

function toolUse(toolUseId: string): PersistedChatBlock {
  return {
    type: 'tool_use',
    toolUseId,
    toolName: 'Bash',
    input: '{}',
  };
}

function codexAgentCall(
  agentsStates: CodexAgentCallBlock['agentsStates'],
): CodexAgentCallBlock {
  return {
    type: 'codex_agent_call',
    agentBlockId: 'codex-agent-call-1',
    callId: 'call-1',
    tool: 'spawnAgent',
    status: 'inProgress',
    senderThreadId: 'root-thread',
    receiverThreadIds: Object.keys(agentsStates),
    prompt: 'Inspect the requested files',
    agentsStates,
  };
}

describe('closeOpenToolUseBlocks child liveness', () => {
  it('keeps malformed restored timer accounting finite', () => {
    const messages = [
      message('timer', [
        {
          type: 'turn_timer',
          startedAt: NaN,
          completedAt: null,
          pausedAt: Infinity,
          accumulatedPausedDurationMs: NaN,
        },
      ]),
    ];
    const tab: ChatTab = {
      id: 'chat',
      title: 'Chat',
      status: 'idle' as const,
      error: null,
      queuedMessages: [],
      planMode: false,
      proposalMode: 'optional',
      thinkingLevel: 'medium',
      modelConfig: {
        thinkingLevel: 'medium',
        fastMode: false,
        speed: 'standard',
      },
      fastModeExplicit: false,
      createdAt: '2026-10-28T00:00:00.000Z',
      messages,
    };
    expect(
      restoreStreamingTabs([tab], { activeChatIds: [] }, 200).tabs[0]
        .messages[0].blocks,
    ).toMatchObject([{ completedAt: 1, accumulatedPausedDurationMs: 0 }]);
  });
  it('counts a newly interrupted tool as interrupted rather than successful or failed', () => {
    const closed = closeOpenToolUseBlocks(
      [message('call', [toolUse('stopped')])],
      { liveness: { kind: 'no-live-session' }, at: 180 },
    );
    expect(computeTurnOutcomes(mergeToolResults(closed))).toEqual({
      failed: 0,
      blocked: 0,
      interrupted: 1,
    });
  });
  it('keeps repeated ids in different user turns and child threads separate', () => {
    const messages: ChatMessage[] = [
      { id: 'user-1', role: 'user', timestamp: 100, blocks: [] },
      message('old-call', [toolUse('reused')]),
      { id: 'user-2', role: 'user', timestamp: 500, blocks: [] },
      message('new-result', [
        {
          type: 'tool_result',
          toolUseId: 'reused',
          toolName: 'Bash',
          output: 'done',
          isError: false,
        },
      ]),
    ];
    const settled = closeOpenToolUseBlocks(messages, {
      liveness: { kind: 'no-live-session' },
      at: 180,
    });
    expect(settled).toHaveLength(5);
    expect(settled[2]).toMatchObject({
      blocks: [{ type: 'tool_result', interruption: { at: 180 } }],
    });
  });

  it('restores each owning turn at its historical time, including paused timers', () => {
    const messages: ChatMessage[] = [
      { id: 'user-1', role: 'user', timestamp: 100, blocks: [] },
      message('old-timer', [
        {
          type: 'turn_timer',
          startedAt: 100,
          completedAt: null,
          pausedAt: 150,
          accumulatedPausedDurationMs: 1000,
        },
      ]),
      { ...message('old-call', [toolUse('old')]), timestamp: 180 },
      { id: 'user-2', role: 'user', timestamp: 500, blocks: [] },
      {
        ...message('new-timer', [
          { type: 'turn_timer', startedAt: 500, completedAt: null },
        ]),
        timestamp: 500,
      },
      { ...message('new-call', [toolUse('new')]), timestamp: 550 },
    ];
    const tab: ChatTab = {
      id: 'chat',
      title: 'Chat',
      status: 'idle' as const,
      error: null,
      queuedMessages: [],
      planMode: false,
      proposalMode: 'optional',
      thinkingLevel: 'medium',
      modelConfig: {
        thinkingLevel: 'medium',
        fastMode: false,
        speed: 'standard',
      },
      fastModeExplicit: false,
      createdAt: '2026-10-28T00:00:00.000Z',
      messages,
    };
    const restored = restoreStreamingTabs([tab], { activeChatIds: [] }, 1000)
      .tabs[0].messages;
    expect(restored.find((m) => m.id === 'old-timer')?.blocks).toMatchObject([
      { completedAt: 180, pausedAt: null, accumulatedPausedDurationMs: 80 },
    ]);
    expect(restored.find((m) => m.id === 'new-timer')?.blocks).toMatchObject([
      { completedAt: 550 },
    ]);
    expect(
      restoreStreamingTabs(
        [{ ...tab, messages: restored }],
        { activeChatIds: [] },
        2000,
      ).tabs[0].messages,
    ).toBe(restored);
  });
  it('closes root tools when liveness is unknown but preserves child tools', () => {
    const root = message('root', [toolUse('root-tool')]);
    const child = message('child', [toolUse('child-tool')], {
      parentToolUseId: 'root-tool',
    });

    const closed = closeOpenToolUseBlocks([root, child], {
      liveness: { kind: 'unknown' },
      output: 'Root turn ended',
      isError: true,
      at: 50,
    });

    expect(closed).toHaveLength(3);
    expect(closed[1]).toBe(child);
    expect(closed[2]?.blocks).toEqual([
      {
        type: 'tool_result',
        toolUseId: 'root-tool',
        toolName: 'Bash',
        output: 'Root turn ended',
        isError: true,
        interruption: { reason: 'unknown', at: 50 },
      },
    ]);
    expect(
      closed.some((candidate) =>
        candidate.blocks.some(
          (block) =>
            block.type === 'tool_result' && block.toolUseId === 'child-tool',
        ),
      ),
    ).toBe(false);
  });

  it('uses Codex receiver status and keeps terminal results separated by thread', () => {
    const agentBlock = codexAgentCall({
      'running-thread': { status: 'running' },
      'terminal-thread': { status: 'completed' },
    });
    const root = message('root', [agentBlock]);
    const runningChild = message('running-child', [toolUse('running-tool')], {
      parentBlockId: agentBlock.agentBlockId,
      codexThreadId: 'running-thread',
    });
    const terminalChild = message(
      'terminal-child',
      [toolUse('terminal-tool')],
      {
        parentBlockId: agentBlock.agentBlockId,
        codexThreadId: 'terminal-thread',
      },
    );

    const closed = closeOpenToolUseBlocks([root, runningChild, terminalChild], {
      liveness: { kind: 'unknown' },
      codexRootThreadId: 'root-thread',
    });

    expect(closed).toHaveLength(4);
    expect(closed[1]).toBe(runningChild);
    const syntheticResult = closed[3];
    expect(syntheticResult).toMatchObject({
      role: 'system',
      parentBlockId: agentBlock.agentBlockId,
      codexThreadId: 'terminal-thread',
      blocks: [
        {
          type: 'tool_result',
          toolUseId: 'terminal-tool',
          output: 'Cancelled',
          // Synthetic settlement is an interruption, not a success (CAN-4897).
          isError: true,
          interruption: { reason: 'unknown' },
        },
      ],
    });
    expect(
      closed.some((candidate) =>
        candidate.blocks.some(
          (block) =>
            block.type === 'tool_result' && block.toolUseId === 'running-tool',
        ),
      ),
    ).toBe(false);
  });

  it('groups synthetic Codex results by receiver thread', () => {
    const agentBlock = codexAgentCall({
      'first-thread': { status: 'completed' },
      'second-thread': { status: 'errored' },
    });
    const firstChild = message('first-child', [toolUse('first-tool')], {
      parentBlockId: agentBlock.agentBlockId,
      codexThreadId: 'first-thread',
    });
    const secondChild = message('second-child', [toolUse('second-tool')], {
      parentBlockId: agentBlock.agentBlockId,
      codexThreadId: 'second-thread',
    });

    const closed = closeOpenToolUseBlocks(
      [message('root', [agentBlock]), firstChild, secondChild],
      {
        liveness: { kind: 'unknown' },
        codexRootThreadId: 'root-thread',
      },
    );

    expect(closed).toHaveLength(5);
    expect(closed[3]).toMatchObject({
      codexThreadId: 'first-thread',
      blocks: [
        { type: 'tool_result', toolUseId: 'first-tool', output: 'Cancelled' },
      ],
    });
    expect(closed[4]).toMatchObject({
      codexThreadId: 'second-thread',
      blocks: [
        { type: 'tool_result', toolUseId: 'second-tool', output: 'Cancelled' },
      ],
    });
  });

  it('stamps typed interruption metadata at the supplied historical time', () => {
    const root = message('root', [toolUse('edit')]);

    const closed = closeOpenToolUseBlocks([root], {
      liveness: { kind: 'no-live-session' },
      interruption: 'app_restart',
      at: 1_000,
    });

    expect(closed[1]).toMatchObject({
      role: 'system',
      timestamp: 1_000,
      blocks: [
        {
          type: 'tool_result',
          toolUseId: 'edit',
          // Stored output text is unchanged; the metadata drives rendering.
          output: 'Cancelled',
          isError: true,
          interruption: { reason: 'app_restart', at: 1_000 },
        },
      ],
    });
  });

  it('settles idempotently once every tool has a result', () => {
    const root = message('root', [toolUse('edit')]);
    const once = closeOpenToolUseBlocks([root], {
      liveness: { kind: 'no-live-session' },
      interruption: 'app_restart',
      at: 1_000,
    });
    expect(
      closeOpenToolUseBlocks(once, {
        liveness: { kind: 'no-live-session' },
        interruption: 'app_restart',
        at: 2_000,
      }),
    ).toBe(once);
  });
});
