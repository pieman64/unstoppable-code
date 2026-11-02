import type {
  BackgroundProcess,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import { selectActiveAgentBlocks } from '../agent-artifact-projection';
import { backgroundTrayAgents } from '../background-tray-agents';
import { mergeToolResults } from '../message-transforms';
import type {
  DisplayBlock,
  DisplayMessage,
  TurnGroupOrMessage,
} from '../types';

function toolUse(index: number): DisplayBlock {
  return {
    type: 'tool_use',
    toolUseId: `read-${String(index)}`,
    toolName: 'Read',
    input: JSON.stringify({ file_path: `src/${String(index)}.ts` }),
  };
}

const CLAUDE_AGENT: DisplayBlock = {
  type: 'agent',
  toolUseId: 'toolu-review',
  subagentType: 'code-reviewer',
  description: 'Review the checkout validation diff',
  prompt: 'Review the diff.',
  runInBackground: true,
  subBlocks: Array.from({ length: 25 }, (_, index) => toolUse(index)),
};

const PROCESS: BackgroundProcess = {
  id: 'process-review',
  chatId: 'chat',
  toolUseId: 'toolu-review',
  toolName: 'Agent',
  kind: 'agent',
  description: 'Review the checkout validation diff',
  status: 'running',
  startedAt: 1_000,
  updatedAt: 2_000,
  lastDescription: 'Reading validation.ts',
  outputLines: [],
  canStop: true,
};

function standalone(message: DisplayMessage): TurnGroupOrMessage {
  return { kind: 'standalone', message };
}

describe('backgroundTrayAgents', () => {
  it("lists a nested Claude agent as one of its parent agent's steps", () => {
    const nested: DisplayBlock = {
      type: 'agent',
      toolUseId: 'toolu-nested',
      subagentType: 'general-purpose',
      description: 'Check the auth middleware',
      prompt: 'Report which routes skip requireAuth.',
      runInBackground: false,
      subBlocks: [toolUse(99)],
    };
    const [row] = backgroundTrayAgents(
      [{ ...CLAUDE_AGENT, subBlocks: [toolUse(0), nested] }],
      [PROCESS],
      'chat',
    );
    expect(row?.steps.map((step) => [step.id, step.toolName])).toEqual([
      ['read-0', 'Read'],
      ['toolu-nested', 'Agent'],
    ]);
    expect(JSON.parse(row?.steps[1]?.input ?? '{}')).toMatchObject({
      description: 'Check the auth middleware',
    });
  });

  it('merges a Claude background agent with its task, by tool use id', () => {
    const [row] = backgroundTrayAgents([CLAUDE_AGENT], [PROCESS], 'chat');
    expect(row).toMatchObject({
      id: 'claude:toolu-review',
      kind: 'claude',
      title: 'Review the checkout validation diff',
      status: 'running',
      activity: 'Reading validation.ts',
      startedAt: 1_000,
      meta: 'Claude · code-reviewer',
      taskId: 'process-review',
      // It stops through its task, in the drawer.
      canStop: false,
      target: {
        kind: 'claude-native',
        id: 'toolu-review',
        title: 'Review the checkout validation diff',
      },
    });
    // The newest 20 steps, newest last.
    expect(row?.steps).toHaveLength(20);
    expect(row?.steps[19]?.id).toBe('read-24');
    // Another chat's process is not this agent's task.
    expect(
      backgroundTrayAgents(
        [CLAUDE_AGENT],
        [{ ...PROCESS, chatId: 'other' }],
        'chat',
      )[0]?.taskId,
    ).toBeNull();
  });

  it('lists the latest live generation of a background delegate, with Stop', () => {
    const delegate = (
      runGeneration: number,
      status: 'running' | 'completed',
      executionMode: 'background' | 'foreground' = 'background',
      delegationId = 'child',
    ): PersistedChatMessage => ({
      id: `${delegationId}-${String(runGeneration)}-${status}`,
      role: 'assistant',
      timestamp: runGeneration,
      blocks: [
        {
          type: 'delegated_agent_call',
          agentBlockId: `delegated-agent-${delegationId}`,
          delegationId,
          runGeneration,
          sequence: runGeneration,
          parentHarnessId: 'claude',
          parentTurnId: 'turn',
          parentToolCallId: 'call',
          createdAt: 5_000,
          selectedModelId: 'sol',
          runtimeModelId: 'gpt-6-sol',
          targetHarnessId: 'codex',
          description: 'Fix flaky checkout e2e',
          prompt: 'Fix it.',
          executionMode,
          status,
          outputTruncated: false,
          routeSnapshot: {
            runtimeKind: 'codex',
            runnerRegistrationId: 'runner',
            runtimeVersion: '1',
            adapterVersion: '1',
            modelSource: 'catalog',
            providerType: 'codex',
            assignmentRevision: '1',
            billingAuthority: 'personal',
            aiCreditsRouted: false,
            capabilities: [],
            supportedThinkingLevels: [],
            capabilitySnapshotHash: 'hash',
            capabilityGeneration: 1,
            policyRevision: '1',
            selectedModelId: 'sol',
            selectedModelLabel: 'GPT-6 Sol',
            runtimeModelId: 'gpt-6-sol',
            harnessId: 'codex',
          },
        },
      ],
    });
    const blocks = selectActiveAgentBlocks(
      mergeToolResults([
        delegate(1, 'completed'),
        delegate(2, 'running'),
        // A foreground delegate is not background work.
        delegate(1, 'running', 'foreground', 'inline'),
      ]).map(standalone),
      [],
      'chat',
    );
    expect(backgroundTrayAgents(blocks, [], 'chat')).toEqual([
      {
        id: 'managed:child',
        kind: 'delegate',
        title: 'Fix flaky checkout e2e',
        status: 'running',
        activity: null,
        startedAt: 5_000,
        steps: [],
        prompt: 'Fix it.',
        meta: 'Delegate · GPT-6 Sol',
        taskId: null,
        canStop: true,
        target: {
          kind: 'managed',
          id: 'child',
          title: 'Fix flaky checkout e2e',
        },
      },
    ]);
  });

  it('lists a Codex native child without Stop', () => {
    const codex: DisplayBlock = {
      type: 'codex_agent',
      agentBlockId: 'codex-agent-call-1',
      callId: 'call-1',
      status: 'inProgress',
      senderThreadId: 'parent',
      receiverThreadIds: ['thread-1'],
      prompt: 'Audit the coupon rules.',
      description: 'Audit coupon rules',
      displayName: 'Audit',
      model: 'gpt-6-sol',
      reasoningEffort: 'high',
      agentsStates: { 'thread-1': { status: 'running' } },
      subBlocks: [],
    };
    expect(backgroundTrayAgents([codex], [], 'chat')).toEqual([
      expect.objectContaining({
        id: 'codex:codex-agent-call-1',
        kind: 'codex',
        meta: 'Codex · gpt-6-sol · high',
        canStop: false,
        target: {
          kind: 'codex-native',
          id: 'thread-1',
          title: 'Audit coupon rules',
        },
      }),
    ]);
  });
});

describe('backgroundTrayAgents descendants', () => {
  it('marks a delegate whose Stop also ends tasks it started', () => {
    const block: DisplayBlock = {
      type: 'delegated_agent_call',
      agentBlockId: 'delegated-agent-parent',
      delegationId: 'parent',
      runGeneration: 1,
      sequence: 1,
      parentHarnessId: 'claude',
      parentTurnId: 'turn',
      parentToolCallId: 'call',
      createdAt: 1,
      selectedModelId: 'sol',
      runtimeModelId: 'gpt-6-sol',
      targetHarnessId: 'codex',
      description: 'Review',
      prompt: 'Review it.',
      executionMode: 'background',
      status: 'running',
      outputTruncated: false,
      subBlocks: [],
    };
    expect(
      backgroundTrayAgents([block], [], 'chat', new Set(['parent']))[0]
        ?.stopsDescendants,
    ).toBe(true);
    expect(
      backgroundTrayAgents([block], [], 'chat')[0]?.stopsDescendants,
    ).toBeUndefined();
  });
});
