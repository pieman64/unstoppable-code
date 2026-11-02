import type { AgentDelegationSnapshot } from '@canopy/protocol/delegation';
import type { DelegatedAgentCallBlock } from '../../../types';
import {
  SUBAGENT_KINDS,
  autoSubagentLevelCount,
  buildSubagentTree,
  countSubagentsByFilter,
  formatSubagentReference,
  isLiveSubagentStatus,
  liveSubagentNodes,
  managedSubagentInputFromBlock,
  matchesSubagentFilter,
  parseWorkflowAgentNodeId,
  parseSubagentReference,
  projectSubagentSkipEdges,
  projectSubagentTree,
  subagentAncestors,
  subagentDescendants,
  subagentRecipients,
  withSubagentReference,
  workflowAgentNodeId,
  workflowPhaseNodeId,
  workflowRunNodeId,
  windowSubagentTree,
  type ClaudeNativeSubagentInput,
  type CodexNativeCallInput,
  type ManagedSubagentInput,
  type SubagentNode,
  type SubagentTree,
  type WorkflowAgentSubagentInput,
  type WorkflowRunSubagentInput,
} from '..';

function snapshot(
  delegationId: string,
  status: AgentDelegationSnapshot['status'],
  extra: Partial<AgentDelegationSnapshot> = {},
): AgentDelegationSnapshot {
  return {
    delegationId,
    status,
    outputTruncated: false,
    ...extra,
  };
}

function managed(
  delegationId: string,
  parentDelegationId: string | undefined,
  status: AgentDelegationSnapshot['status'] = 'running',
  options: {
    readonly runGeneration?: number;
    readonly sequence?: number;
    readonly createdAt?: number;
    readonly description?: string;
    readonly snapshot?: Partial<AgentDelegationSnapshot>;
    readonly agentBlockId?: string;
    readonly prompt?: string;
  } = {},
): ManagedSubagentInput {
  const extra = options.snapshot ?? {};
  return {
    delegationId,
    runGeneration: options.runGeneration ?? 1,
    sequence: options.sequence ?? 1,
    ...(options.agentBlockId !== undefined
      ? { agentBlockId: options.agentBlockId }
      : {}),
    snapshot: snapshot(delegationId, status, {
      ...(parentDelegationId !== undefined ? { parentDelegationId } : {}),
      ...extra,
    }),
    description: options.description ?? `Task ${delegationId}`,
    ...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
    ...(options.createdAt !== undefined
      ? { createdAt: options.createdAt }
      : {}),
  };
}

function tree(
  managedInputs: readonly ManagedSubagentInput[],
  options: {
    readonly claudeNative?: readonly ClaudeNativeSubagentInput[];
    readonly codexNative?: readonly CodexNativeCallInput[];
    readonly codexRootThreadId?: string;
    readonly workflowRuns?: readonly WorkflowRunSubagentInput[];
    readonly complete?: boolean;
  } = {},
): SubagentTree {
  return buildSubagentTree({
    root: { id: 'root-chat', title: 'Root chat' },
    managed: managedInputs,
    ...options,
  });
}

function workflowRun(
  runId: string,
  options: Partial<WorkflowRunSubagentInput> = {},
): WorkflowRunSubagentInput {
  return {
    runId,
    name: `Workflow ${runId}`,
    status: 'running',
    phases: [],
    agents: [],
    ...options,
  };
}

function workflowAgent(
  agentId: string,
  options: Partial<WorkflowAgentSubagentInput> = {},
): WorkflowAgentSubagentInput {
  return {
    agentId,
    label: `Agent ${agentId}`,
    state: 'running',
    ...options,
  };
}

function node(treeValue: SubagentTree, id: string): SubagentNode {
  const result = treeValue.nodes.get(id);
  if (!result) throw new Error(`Expected node ${id}`);
  return result;
}

function codexCall(
  options: Partial<CodexNativeCallInput> &
    Pick<
      CodexNativeCallInput,
      'agentBlockId' | 'callId' | 'tool' | 'senderThreadId'
    >,
): CodexNativeCallInput {
  return {
    status: 'inProgress',
    receiverThreadIds: [],
    prompt: '',
    agentsStates: {},
    ...options,
  };
}

describe('subagent tree reduction', () => {
  it('converts a managed transcript block into a tree input', () => {
    const block = {
      ...snapshot('managed-1', 'running'),
      type: 'delegated_agent_call',
      agentBlockId: 'delegated-agent-managed-1',
      runGeneration: 2,
      sequence: 9,
      parentHarnessId: 'claude',
      parentTurnId: 'turn-1',
      parentToolCallId: 'tool-1',
      createdAt: 150,
      selectedModelId: 'model-id',
      runtimeModelId: 'runtime-id',
      targetHarnessId: 'codex',
      description: 'Review the patch',
      prompt: 'Read carefully',
      executionMode: 'background',
    } satisfies DelegatedAgentCallBlock;

    expect(managedSubagentInputFromBlock(block)).toEqual({
      delegationId: 'managed-1',
      runGeneration: 2,
      sequence: 9,
      agentBlockId: 'delegated-agent-managed-1',
      snapshot: block,
      description: 'Review the patch',
      prompt: 'Read carefully',
      createdAt: 150,
    });
  });

  it('builds unbounded-depth ancestry and descendants iteratively', () => {
    const chain = Array.from({ length: 12 }, (_, index) =>
      managed(
        `level-${index + 1}`,
        index === 0 ? undefined : `level-${index}`,
        'running',
        { createdAt: index + 1 },
      ),
    );
    const result = tree(chain);
    expect(node(result, 'level-12').depth).toBe(12);
    expect(
      subagentAncestors(result, 'level-12').map((entry) => entry.id),
    ).toEqual(Array.from({ length: 11 }, (_, index) => `level-${11 - index}`));
    expect(subagentDescendants(result, 'level-1')).toHaveLength(11);
    expect(subagentDescendants(result, null)).toHaveLength(12);
  });

  it('roots unknown parents and drops the later edge in a cycle', () => {
    const unknownParent = tree([
      managed('orphan', 'not-in-tree', 'running', { createdAt: 1 }),
    ]);
    expect(unknownParent.rootChildIds).toEqual(['orphan']);
    expect(node(unknownParent, 'orphan').parentId).toBeNull();

    const cyclic = tree([
      managed('first', 'second', 'running', { createdAt: 1 }),
      managed('second', 'first', 'running', { createdAt: 2 }),
    ]);
    expect(node(cyclic, 'first').parentId).toBe('second');
    expect(node(cyclic, 'second').parentId).toBeNull();
    expect(subagentDescendants(cyclic, null).map((entry) => entry.id)).toEqual([
      'second',
      'first',
    ]);
  });

  it('is deterministic when managed transcript inputs are replayed backwards', () => {
    const inputs = [
      managed('a', undefined, 'running', { createdAt: 1 }),
      managed('b', 'a', 'running', {
        createdAt: 2,
        snapshot: { approvalPending: true },
      }),
      managed('c', 'b', 'completed', { createdAt: 3 }),
    ];
    const forward = tree(inputs);
    const reverse = tree([...inputs].reverse());
    expect([...reverse.nodes]).toEqual([...forward.nodes]);
    expect(reverse.rootChildIds).toEqual(forward.rootChildIds);
  });

  it('keeps every managed generation and projects facts from the latest run', () => {
    const result = tree([
      managed('same', undefined, 'running', {
        runGeneration: 1,
        sequence: 99,
        createdAt: 10,
        agentBlockId: 'run-1',
        description: 'Old title',
        prompt: 'Old prompt',
      }),
      managed('same', undefined, 'failed', {
        runGeneration: 2,
        sequence: 2,
        createdAt: 20,
        agentBlockId: 'run-2',
        description: 'Current title',
        prompt: 'Current prompt',
        snapshot: {
          routeSnapshot: {
            selectedModelId: 'selected-id',
            selectedModelLabel: 'Selected name',
            runtimeModelId: 'runtime-id',
            runtimeModelLabel: 'Runtime name',
            harnessId: 'codex',
            runtimeKind: 'local',
            runnerRegistrationId: 'runner',
            runtimeVersion: '1',
            adapterVersion: '1',
            modelSource: 'provider',
            providerType: 'codex',
            assignmentRevision: '1',
            billingAuthority: 'local',
            aiCreditsRouted: false,
            capabilities: [],
            supportedThinkingLevels: [],
            capabilitySnapshotHash: 'hash',
            capabilityGeneration: 1,
            policyRevision: '1',
          },
          isolatedWorkspace: {
            revision: 'revision-2',
            dirtyParentChangesIncluded: false,
          },
          workspaceDiscarded: true,
          error: {
            code: 'runtime_error',
            message: 'Latest error',
            retryable: false,
          },
        },
      }),
    ]);
    expect(node(result, 'same')).toMatchObject({
      title: 'Current title',
      status: 'failed',
      prompt: 'Current prompt',
      modelLabel: 'Runtime name',
      harnessId: 'codex',
      workspace: 'isolated',
      isolatedRevision: 'revision-2',
      workspaceDiscarded: true,
      errorMessage: 'Latest error',
      runs: [
        { runGeneration: 1, agentBlockId: 'run-1' },
        { runGeneration: 2, agentBlockId: 'run-2' },
      ],
    });
  });

  it('keeps run timestamps when a transcript observation ties the canonical one', () => {
    const canonical: ManagedSubagentInput = {
      ...managed('timed', undefined, 'completed', { sequence: 5 }),
      startedAt: 100,
      settledAt: 200,
    };
    const transcript = managed('timed', undefined, 'completed', {
      sequence: 5,
      agentBlockId: 'delegated-agent-timed',
    });

    const result = tree([canonical, transcript]);

    expect(node(result, 'timed')).toMatchObject({
      startedAt: 100,
      settledAt: 200,
    });
  });

  it('maps managed status, stopped-by-parent, and partial-completeness facts', () => {
    const result = tree(
      [
        managed('queued', undefined, 'pending', {
          snapshot: { phase: 'queued' },
        }),
        managed('starting', undefined, 'pending'),
        managed('approval', undefined, 'running', {
          snapshot: { approvalPending: true },
        }),
        managed('parent-stop', undefined, 'cancelled', {
          snapshot: { stopReason: 'ancestor_stopped' },
        }),
        managed('agent-stop', undefined, 'cancelled', {
          snapshot: { stoppedBy: { kind: 'agent', depth: 0 } },
        }),
        managed('user-stop', undefined, 'cancelled'),
        managed('deadline', undefined, 'deadline_exceeded'),
      ],
      { complete: false },
    );
    expect(result.complete).toBe(false);
    expect(
      new Map(result.rootChildIds.map((id) => [id, node(result, id).status])),
    ).toEqual(
      new Map([
        ['queued', 'queued'],
        ['starting', 'starting'],
        ['approval', 'approval'],
        ['parent-stop', 'stopped-by-parent'],
        ['agent-stop', 'stopped-by-parent'],
        ['user-stop', 'cancelled'],
        ['deadline', 'failed'],
      ]),
    );
    expect(node(result, 'approval').approvalPending).toBe(true);
  });

  it('reduces multi-receiver Codex spawns and later status updates by thread', () => {
    const spawn = codexCall({
      agentBlockId: 'spawn-block',
      callId: 'spawn-call',
      tool: 'spawnAgent',
      senderThreadId: 'root-thread',
      receiverThreadIds: ['thread-a', 'thread-b'],
      prompt: 'Split this work',
      description: 'Investigate the issue',
      model: 'gpt-6',
      reasoningEffort: 'high',
      occurredAt: 10,
      agentsStates: {
        'thread-a': { status: 'running' },
        'thread-b': { status: 'pendingInit' },
      },
      receiverAgents: {
        'thread-a': {
          nickname: 'Alpha',
          agentPath: 'agents/alpha',
          model: 'gpt-a',
        },
        'thread-b': { agentPath: 'agents/beta', reasoningEffort: 'medium' },
      },
    });
    const send = codexCall({
      agentBlockId: 'send-block',
      callId: 'send-call',
      tool: 'sendInput',
      senderThreadId: 'root-thread',
      receiverThreadIds: ['thread-a'],
      occurredAt: 20,
      agentsStates: { 'thread-a': { status: 'completed' } },
    });
    const wait = codexCall({
      agentBlockId: 'wait-block',
      callId: 'wait-call',
      tool: 'wait',
      senderThreadId: 'root-thread',
      receiverThreadIds: ['thread-a'],
      occurredAt: 30,
      agentsStates: { 'thread-a': { status: 'running' } },
    });
    const result = buildSubagentTree({
      root: { id: 'root-chat', title: 'Root chat' },
      managed: [],
      codexNative: [wait, spawn, send],
      codexRootThreadId: 'root-thread',
    });
    expect(result.rootChildIds).toEqual(['thread-a', 'thread-b']);
    expect(node(result, 'thread-a')).toMatchObject({
      kind: 'codex-native',
      parentId: null,
      title: 'Investigate the issue',
      status: 'running',
      modelLabel: 'gpt-a',
      prompt: 'Split this work',
    });
    expect(node(result, 'thread-b')).toMatchObject({
      title: 'Investigate the issue',
      status: 'starting',
      thinkingLevel: 'medium',
    });
  });

  it("times a Codex node by its own thread's turns when they are known (CAN-5203)", () => {
    const spawn = codexCall({
      agentBlockId: 'spawn-block',
      callId: 'spawn-call',
      tool: 'spawnAgent',
      senderThreadId: 'root-thread',
      receiverThreadIds: ['thread-a', 'thread-b', 'thread-c'],
      occurredAt: 10,
      agentsStates: {
        'thread-a': { status: 'completed' },
        'thread-b': { status: 'running' },
        'thread-c': { status: 'completed' },
      },
      receiverTimes: {
        'thread-a': { startedAt: 12, settledAt: 40 },
        'thread-b': { startedAt: 14 },
      },
    });
    const result = buildSubagentTree({
      root: { id: 'root-chat', title: 'Root chat' },
      managed: [],
      codexNative: [spawn],
      codexRootThreadId: 'root-thread',
    });
    expect(node(result, 'thread-a')).toMatchObject({
      createdAt: 10,
      startedAt: 12,
      settledAt: 40,
    });
    expect(node(result, 'thread-b')).toMatchObject({
      createdAt: 10,
      startedAt: 14,
    });
    expect(node(result, 'thread-b')).not.toHaveProperty('settledAt');
    // Without times, a node keeps its spawn time as before.
    expect(node(result, 'thread-c')).toMatchObject({
      createdAt: 10,
      startedAt: 10,
      settledAt: 10,
    });
  });

  it('uses Codex receiver fallbacks and keys receiver-less calls by block id', () => {
    const result = buildSubagentTree({
      root: { id: 'root-chat', title: 'Root chat' },
      managed: [],
      codexNative: [
        codexCall({
          agentBlockId: 'spawn',
          callId: 'spawn',
          tool: 'spawnAgent',
          senderThreadId: 'root-thread',
          receiverThreadIds: ['thread-path'],
          occurredAt: 1,
          agentsStates: { 'thread-path': { status: 'running' } },
          receiverAgents: {
            'thread-path': { agentPath: 'one/two/path-agent' },
          },
        }),
        codexCall({
          agentBlockId: 'call-row',
          callId: 'close',
          tool: 'closeAgent',
          status: 'completed',
          senderThreadId: 'root-thread',
          occurredAt: 2,
          description: 'Close agent call',
        }),
      ],
      codexRootThreadId: 'root-thread',
    });
    expect(node(result, 'thread-path').title).toBe('path-agent');
    expect(node(result, 'call-row')).toMatchObject({
      kind: 'codex-native',
      title: 'Close agent call',
      status: 'completed',
    });
  });

  it('builds a mixed managed and native tree, resolving Codex sender aliases', () => {
    const result = tree(
      [
        managed('managed-parent', undefined, 'running', {
          createdAt: 1,
          snapshot: { nativeSessionId: 'managed-thread' },
        }),
      ],
      {
        claudeNative: [
          {
            toolUseId: 'claude-child',
            parentId: 'managed-parent',
            subagentType: 'Explore',
            description: 'Find usages',
            state: 'running',
            runInBackground: true,
            modelLabel: 'Haiku',
            startedAt: 2,
          },
        ],
        codexNative: [
          codexCall({
            agentBlockId: 'codex-spawn',
            callId: 'spawn',
            tool: 'spawnAgent',
            senderThreadId: 'managed-thread',
            receiverThreadIds: ['codex-child'],
            occurredAt: 3,
            agentsStates: { 'codex-child': { status: 'running' } },
          }),
        ],
      },
    );
    expect(node(result, 'claude-child')).toMatchObject({
      kind: 'claude-native',
      parentId: 'managed-parent',
      subagentType: 'Explore',
      modelLabel: 'Haiku',
    });
    expect(node(result, 'codex-child').parentId).toBe('managed-parent');
    expect(node(result, 'managed-parent').childIds).toEqual([
      'claude-child',
      'codex-child',
    ]);
  });

  it('derives idle parents and counts live descendants below them', () => {
    const result = tree([
      managed('parent', undefined, 'completed', { createdAt: 1 }),
      managed('active-a', 'parent', 'running', { createdAt: 2 }),
      managed('idle-child', 'parent', 'interrupted', { createdAt: 3 }),
      managed('active-b', 'idle-child', 'pending', {
        createdAt: 4,
        snapshot: { phase: 'queued' },
      }),
    ]);
    expect(node(result, 'parent')).toMatchObject({
      status: 'idle',
      liveDescendantCount: 2,
    });
    expect(node(result, 'idle-child')).toMatchObject({
      status: 'idle',
      liveDescendantCount: 1,
    });
    expect(isLiveSubagentStatus('idle')).toBe(false);
    expect(isLiveSubagentStatus('approval')).toBe(true);
  });
});

describe('Claude Code workflow subagents', () => {
  it('round-trips stable workflow node ids', () => {
    expect(workflowRunNodeId('run-a')).toBe('workflow-run:run-a');
    expect(workflowPhaseNodeId('run-a', 'Build & ship')).toBe(
      'workflow-phase:run-a:Build%20%26%20ship',
    );
    const agentId = workflowAgentNodeId('run:a', 'agent-1');
    expect(agentId).toBe('workflow-agent:run:a:agent-1');
    expect(parseWorkflowAgentNodeId(agentId)).toEqual({
      runId: 'run:a',
      agentId: 'agent-1',
    });
    expect(parseWorkflowAgentNodeId('workflow-agent:run:')).toBeNull();
    expect(parseWorkflowAgentNodeId('managed:agent')).toBeNull();
  });

  it('builds ordered run, phase, and agent nodes with run and agent facts', () => {
    const result = tree(
      [managed('root-before', undefined, 'completed', { createdAt: 5 })],
      {
        workflowRuns: [
          workflowRun('later', {
            name: 'Later',
            status: 'completed',
            startedAt: 20,
            settledAt: 25,
          }),
          workflowRun('z', {
            name: 'Zed',
            startedAt: 10,
            phases: [{ title: 'Build' }, { title: 'Review' }],
            agents: [
              workflowAgent('build-1', {
                label: 'Builder 1',
                phaseTitle: 'Build',
                modelLabel: 'Sonnet',
                prompt: 'Build it',
                startedAt: 11,
                settledAt: 12,
                tokens: 5,
                toolCalls: 2,
                durationMs: 900,
              }),
              workflowAgent('direct', { phaseTitle: '' }),
              workflowAgent('unmatched', { phaseTitle: 'Other' }),
              workflowAgent('review', {
                phaseTitle: 'Review',
                tokens: 3,
                toolCalls: 1,
                durationMs: 400,
              }),
              workflowAgent('build-2', { phaseTitle: 'Build' }),
            ],
          }),
          workflowRun('a', { name: 'Aardvark', startedAt: 10 }),
        ],
      },
    );

    const runZId = workflowRunNodeId('z');
    const buildId = workflowPhaseNodeId('z', 'Build');
    const reviewId = workflowPhaseNodeId('z', 'Review');
    expect(result.rootChildIds).toEqual([
      'root-before',
      workflowRunNodeId('a'),
      runZId,
      workflowRunNodeId('later'),
    ]);
    expect(node(result, runZId)).toMatchObject({
      kind: 'workflow-run',
      title: 'Zed',
      parentId: null,
      depth: 1,
      startedAt: 10,
      workflow: {
        runId: 'z',
        runName: 'Zed',
        runOrdinal: 2,
        runCount: 3,
        phaseCount: 2,
        agentCount: 5,
        tokens: 8,
        toolCalls: 3,
      },
      childIds: [
        buildId,
        reviewId,
        workflowAgentNodeId('z', 'direct'),
        workflowAgentNodeId('z', 'unmatched'),
      ],
    });
    expect(node(result, workflowRunNodeId('later'))).toMatchObject({
      status: 'completed',
      startedAt: 20,
      settledAt: 25,
    });
    expect(node(result, buildId)).toMatchObject({
      kind: 'workflow-phase',
      title: 'Build',
      parentId: runZId,
      workflow: {
        runId: 'z',
        runOrdinal: 2,
        runCount: 3,
        phaseCount: 2,
        phaseTitle: 'Build',
        phaseIndex: 0,
        agentCount: 5,
      },
      childIds: [
        workflowAgentNodeId('z', 'build-1'),
        workflowAgentNodeId('z', 'build-2'),
      ],
    });
    expect(node(result, reviewId)).toMatchObject({
      kind: 'workflow-phase',
      title: 'Review',
      workflow: { phaseIndex: 1, phaseTitle: 'Review' },
    });
    expect(node(result, workflowAgentNodeId('z', 'build-1'))).toMatchObject({
      kind: 'workflow-agent',
      title: 'Builder 1',
      parentId: buildId,
      harnessId: 'claude',
      subagentType: 'workflow',
      modelLabel: 'Sonnet',
      prompt: 'Build it',
      startedAt: 11,
      settledAt: 12,
      workflow: {
        runId: 'z',
        runName: 'Zed',
        runOrdinal: 2,
        runCount: 3,
        phaseCount: 2,
        phaseTitle: 'Build',
        phaseIndex: 0,
        agentPosition: 1,
        agentCount: 5,
        tokens: 5,
        toolCalls: 2,
        durationMs: 900,
      },
    });
    expect(node(result, workflowAgentNodeId('z', 'unmatched'))).toMatchObject({
      parentId: runZId,
      workflow: { phaseTitle: 'Other' },
    });
    expect(
      node(result, workflowAgentNodeId('z', 'direct')).workflow,
    ).not.toHaveProperty('phaseTitle');
  });

  it('creates observed phases in first-appearance order when none are declared', () => {
    const result = tree([], {
      workflowRuns: [
        workflowRun('observed', {
          agents: [
            workflowAgent('one', { phaseTitle: 'Plan' }),
            workflowAgent('direct', { phaseTitle: '  ' }),
            workflowAgent('two', { phaseTitle: 'Implement' }),
            workflowAgent('three', { phaseTitle: 'Plan' }),
          ],
        }),
      ],
    });
    const runId = workflowRunNodeId('observed');
    const planId = workflowPhaseNodeId('observed', 'Plan');
    const implementId = workflowPhaseNodeId('observed', 'Implement');
    expect(node(result, runId)).toMatchObject({
      workflow: { phaseCount: 2, agentCount: 4 },
      childIds: [
        planId,
        implementId,
        workflowAgentNodeId('observed', 'direct'),
      ],
    });
    expect(node(result, planId).childIds).toEqual([
      workflowAgentNodeId('observed', 'one'),
      workflowAgentNodeId('observed', 'three'),
    ]);
    expect(node(result, implementId).childIds).toEqual([
      workflowAgentNodeId('observed', 'two'),
    ]);
  });

  it('applies agent and run lifecycle rules without inferring run status', () => {
    const result = tree([], {
      workflowRuns: [
        workflowRun('running-done', {
          phases: [{ title: 'Done' }],
          agents: [
            workflowAgent('done', { phaseTitle: 'Done', state: 'completed' }),
          ],
        }),
        workflowRun('empty-live', {
          phases: [{ title: 'Waiting' }],
          agents: [],
        }),
        workflowRun('finished-dangling', {
          status: 'completed',
          phases: [{ title: 'Interrupted' }, { title: 'Done' }],
          agents: [
            workflowAgent('queued', {
              phaseTitle: 'Interrupted',
              state: 'queued',
            }),
            workflowAgent('running', {
              phaseTitle: 'Interrupted',
              state: 'running',
            }),
            workflowAgent('completed', {
              phaseTitle: 'Done',
              state: 'completed',
            }),
            workflowAgent('failed', {
              state: 'failed',
              errorMessage: 'Agent failed',
            }),
            workflowAgent('cancelled', { state: 'cancelled' }),
            workflowAgent('interrupted', { state: 'interrupted' }),
          ],
        }),
        workflowRun('failed-run', {
          status: 'failed',
          agents: [workflowAgent('done-in-failed-run', { state: 'completed' })],
        }),
        workflowRun('interrupted-run', {
          status: 'interrupted',
          agents: [workflowAgent('in-interrupted-run', { state: 'running' })],
        }),
        workflowRun('state-mapping', {
          agents: [
            workflowAgent('queued-state', { state: 'queued' }),
            workflowAgent('running-state', { state: 'running' }),
            workflowAgent('completed-state', { state: 'completed' }),
            workflowAgent('failed-state', { state: 'failed' }),
            workflowAgent('cancelled-state', { state: 'cancelled' }),
            workflowAgent('interrupted-state', { state: 'interrupted' }),
          ],
        }),
      ],
    });

    const runningDoneId = workflowRunNodeId('running-done');
    const emptyLiveId = workflowRunNodeId('empty-live');
    const finishedId = workflowRunNodeId('finished-dangling');
    expect(node(result, runningDoneId).status).toBe('running');
    expect(
      node(result, workflowPhaseNodeId('running-done', 'Done')).status,
    ).toBe('completed');
    expect(node(result, emptyLiveId).status).toBe('running');
    expect(
      node(result, workflowPhaseNodeId('empty-live', 'Waiting')).status,
    ).toBe('queued');
    expect(node(result, finishedId).status).toBe('completed');
    expect(
      node(result, workflowPhaseNodeId('finished-dangling', 'Interrupted'))
        .status,
    ).toBe('interrupted');
    expect(
      node(result, workflowPhaseNodeId('finished-dangling', 'Done')).status,
    ).toBe('completed');
    expect(
      node(result, workflowAgentNodeId('finished-dangling', 'queued')).status,
    ).toBe('interrupted');
    expect(
      node(result, workflowAgentNodeId('finished-dangling', 'running')).status,
    ).toBe('interrupted');
    expect(
      node(result, workflowAgentNodeId('finished-dangling', 'completed'))
        .status,
    ).toBe('completed');
    expect(
      node(result, workflowAgentNodeId('finished-dangling', 'failed')).status,
    ).toBe('failed');
    expect(
      node(result, workflowAgentNodeId('finished-dangling', 'failed'))
        .errorMessage,
    ).toBe('Agent failed');
    expect(
      node(result, workflowAgentNodeId('finished-dangling', 'cancelled'))
        .status,
    ).toBe('cancelled');
    expect(
      node(result, workflowAgentNodeId('finished-dangling', 'interrupted'))
        .status,
    ).toBe('interrupted');
    expect(node(result, workflowRunNodeId('failed-run')).status).toBe('failed');
    expect(node(result, workflowRunNodeId('interrupted-run')).status).toBe(
      'interrupted',
    );
    expect(
      node(result, workflowAgentNodeId('state-mapping', 'queued-state')).status,
    ).toBe('queued');
    expect(
      node(result, workflowAgentNodeId('state-mapping', 'running-state'))
        .status,
    ).toBe('running');
    expect(
      node(result, workflowAgentNodeId('state-mapping', 'completed-state'))
        .status,
    ).toBe('completed');
    expect(
      node(result, workflowAgentNodeId('state-mapping', 'failed-state')).status,
    ).toBe('failed');
    expect(
      node(result, workflowAgentNodeId('state-mapping', 'cancelled-state'))
        .status,
    ).toBe('cancelled');
    expect(
      node(result, workflowAgentNodeId('state-mapping', 'interrupted-state'))
        .status,
    ).toBe('interrupted');
    expect(node(result, runningDoneId).status).not.toBe('idle');
    expect(node(result, emptyLiveId).status).not.toBe('idle');
  });

  it('excludes workflow groups from subagent totals and live descendant counts', () => {
    const result = tree([], {
      workflowRuns: [
        workflowRun('counted', {
          phases: [{ title: 'Phase' }],
          agents: [workflowAgent('live', { phaseTitle: 'Phase' })],
        }),
      ],
    });
    expect(node(result, workflowRunNodeId('counted')).liveDescendantCount).toBe(
      1,
    );
    expect(
      node(result, workflowPhaseNodeId('counted', 'Phase')).liveDescendantCount,
    ).toBe(1);
    expect(countSubagentsByFilter(result)).toEqual({
      all: 1,
      active: 1,
      attention: 0,
    });
    expect(
      matchesSubagentFilter(node(result, workflowRunNodeId('counted')), 'all'),
    ).toBe(true);
    expect(
      matchesSubagentFilter(
        node(result, workflowRunNodeId('counted')),
        'active',
      ),
    ).toBe(true);
    expect(
      matchesSubagentFilter(
        node(result, workflowPhaseNodeId('counted', 'Phase')),
        'active',
      ),
    ).toBe(true);
    expect(
      matchesSubagentFilter(
        node(result, workflowPhaseNodeId('counted', 'Phase')),
        'attention',
      ),
    ).toBe(false);
  });

  it('lists the live subagents the Active count counts, never their groups', () => {
    const result = tree([], {
      workflowRuns: [
        workflowRun('listed', {
          phases: [{ title: 'Phase' }],
          agents: [
            workflowAgent('live', { phaseTitle: 'Phase' }),
            workflowAgent('done', { phaseTitle: 'Phase', state: 'completed' }),
          ],
        }),
      ],
    });
    const live = liveSubagentNodes(result);
    expect(live.map((entry) => entry.id)).toEqual([
      workflowAgentNodeId('listed', 'live'),
    ]);
    expect(live).toHaveLength(countSubagentsByFilter(result).active);
  });

  it('projects failed agents through run and phase paths under Needs attention', () => {
    const result = tree([], {
      workflowRuns: [
        workflowRun('attention', {
          status: 'failed',
          phases: [{ title: 'Review' }],
          agents: [
            workflowAgent('failed', { phaseTitle: 'Review', state: 'failed' }),
          ],
        }),
      ],
    });
    const run = node(result, workflowRunNodeId('attention'));
    const phase = node(result, workflowPhaseNodeId('attention', 'Review'));
    expect(matchesSubagentFilter(run, 'attention')).toBe(false);
    expect(matchesSubagentFilter(phase, 'attention')).toBe(false);
    expect(projectSubagentSkipEdges(result, 'attention').items).toMatchObject([
      {
        node: { id: workflowAgentNodeId('attention', 'failed') },
        via: [
          { id: workflowRunNodeId('attention') },
          { id: workflowPhaseNodeId('attention', 'Review') },
        ],
      },
    ]);
  });

  it('collapses groups into agent-only stubs and never collapses the focused node', () => {
    const result = tree([], {
      workflowRuns: [
        workflowRun('collapsed', {
          phases: [{ title: 'Phase' }],
          agents: [
            workflowAgent('live', { phaseTitle: 'Phase', state: 'running' }),
            workflowAgent('done', { phaseTitle: 'Phase', state: 'completed' }),
          ],
        }),
      ],
    });
    const runId = workflowRunNodeId('collapsed');
    const phaseId = workflowPhaseNodeId('collapsed', 'Phase');
    const collapsedRun = windowSubagentTree(result, {
      levels: 'all',
      collapsedIds: new Set([runId]),
    });
    expect(collapsedRun.items[0]).toMatchObject({
      node: { id: runId },
      children: [
        {
          kind: 'stub',
          parentId: runId,
          hiddenCount: 2,
          hiddenLiveCount: 1,
        },
      ],
    });
    const collapsedPhase = windowSubagentTree(result, {
      levels: 'all',
      collapsedIds: new Set([phaseId]),
    });
    expect(collapsedPhase.items[0]).toMatchObject({
      children: [
        {
          kind: 'node',
          node: { id: phaseId },
          children: [
            {
              kind: 'stub',
              parentId: phaseId,
              hiddenCount: 2,
              hiddenLiveCount: 1,
            },
          ],
        },
      ],
    });
    const focusedRun = windowSubagentTree(result, {
      focusId: runId,
      levels: 'all',
      collapsedIds: new Set([runId]),
    });
    expect(focusedRun.items[0]).toMatchObject({
      node: { id: runId },
      children: [{ kind: 'node', node: { id: phaseId } }],
    });

    const emptyGroups = tree([], {
      workflowRuns: [
        workflowRun('empty-groups', { phases: [{ title: 'Empty' }] }),
      ],
    });
    const emptyRunId = workflowRunNodeId('empty-groups');
    expect(
      windowSubagentTree(emptyGroups, {
        levels: 'all',
        collapsedIds: new Set([emptyRunId]),
      }).items[0],
    ).toMatchObject({
      node: { id: emptyRunId },
      children: [
        {
          kind: 'stub',
          parentId: emptyRunId,
          hiddenCount: 0,
          hiddenLiveCount: 0,
        },
      ],
    });
  });

  it('keeps a phase id when the final run state declares an earlier phase', () => {
    const agent = workflowAgent('verify-1', {
      phaseTitle: 'Verify',
      state: 'completed',
    });
    const phaseIdFor = (
      result: SubagentTree,
      title: string,
    ): string | undefined =>
      Array.from(result.nodes.values()).find(
        (candidate) =>
          candidate.kind === 'workflow-phase' && candidate.title === title,
      )?.id;
    // The live journal only shows phases with agents; the final state lists
    // every declared phase, including one before them.
    const live = tree([], {
      workflowRuns: [workflowRun('stable', { agents: [agent] })],
    });
    const final = tree([], {
      workflowRuns: [
        workflowRun('stable', {
          status: 'completed',
          phases: [{ title: 'Register' }, { title: 'Verify' }],
          agents: [agent],
        }),
      ],
    });
    expect(phaseIdFor(live, 'Verify')).toBeDefined();
    expect(phaseIdFor(final, 'Verify')).toBe(phaseIdFor(live, 'Verify'));
  });

  it('times a run by its wall clock, not the sum of overlapping agents', () => {
    const agents = [
      workflowAgent('first', {
        state: 'completed',
        startedAt: 1_000,
        settledAt: 6_000,
        durationMs: 5_000,
      }),
      workflowAgent('second', {
        state: 'completed',
        startedAt: 2_000,
        settledAt: 7_000,
        durationMs: 5_000,
      }),
    ];
    const result = tree([], {
      workflowRuns: [
        workflowRun('finished', {
          status: 'completed',
          startedAt: 1_000,
          settledAt: 7_000,
          agents,
        }),
        workflowRun('live', { startedAt: 1_000, agents }),
      ],
    });
    expect(
      node(result, workflowRunNodeId('finished')).workflow?.durationMs,
    ).toBe(6_000);
    // A live run has no fixed duration; hosts show its elapsed time instead.
    expect(
      node(result, workflowRunNodeId('live')).workflow?.durationMs,
    ).toBeUndefined();
  });

  it('offers workflow agents only the root chat as a recipient', () => {
    const result = tree([], {
      workflowRuns: [
        workflowRun('recipients', {
          phases: [{ title: 'Phase' }],
          agents: [workflowAgent('child', { phaseTitle: 'Phase' })],
        }),
      ],
    });
    expect(
      subagentRecipients(result, workflowAgentNodeId('recipients', 'child')),
    ).toEqual([
      {
        id: 'root-chat',
        kind: 'root',
        title: 'Root chat',
        levelsUp: 3,
        canMessage: true,
      },
    ]);
  });
});

describe('subagent tree projections', () => {
  it('projects hidden ancestors as condensed paths and supports status counts', () => {
    const result = tree([
      managed('hidden-a', undefined, 'completed', { createdAt: 1 }),
      managed('hidden-b', 'hidden-a', 'cancelled', { createdAt: 2 }),
      managed('approval', 'hidden-b', 'running', {
        createdAt: 3,
        snapshot: { approvalPending: true },
      }),
      managed('failed', undefined, 'failed', { createdAt: 4 }),
      managed('running', undefined, 'running', { createdAt: 5 }),
    ]);
    const attention = projectSubagentTree(result, 'attention');
    expect(attention.items.map((entry) => entry.kind)).toEqual([
      'path',
      'match',
    ]);
    const path = attention.items[0];
    expect(
      path?.kind === 'path' ? path.nodes.map((entry) => entry.id) : [],
    ).toEqual(['hidden-a', 'hidden-b']);
    expect(countSubagentsByFilter(result)).toEqual({
      all: 5,
      active: 2,
      attention: 2,
    });
    expect(matchesSubagentFilter(node(result, 'failed'), 'attention')).toBe(
      true,
    );
    expect(matchesSubagentFilter(node(result, 'running'), 'attention')).toBe(
      false,
    );
  });

  it('projects active skip edges with hidden ancestry in nearest-to-farthest order', () => {
    const result = tree([
      managed('visible-parent', undefined, 'running', { createdAt: 1 }),
      managed('hidden-one', 'visible-parent', 'completed', { createdAt: 2 }),
      managed('hidden-two', 'hidden-one', 'cancelled', { createdAt: 3 }),
      managed('visible-child', 'hidden-two', 'running', { createdAt: 4 }),
    ]);
    const projection = projectSubagentSkipEdges(result, 'active');
    const parent = projection.items[0];
    expect(parent?.node.id).toBe('visible-parent');
    expect(parent?.children[0]).toMatchObject({
      node: { id: 'visible-child' },
      via: [{ id: 'hidden-one' }, { id: 'hidden-two' }],
    });
  });

  it('shows Needs attention as approval or failed, but excludes interrupted work', () => {
    const result = tree([
      managed('needs-approval', undefined, 'running', {
        createdAt: 1,
        snapshot: { approvalPending: true },
      }),
      managed('failed', undefined, 'failed', { createdAt: 2 }),
      managed('interrupted', undefined, 'interrupted', { createdAt: 3 }),
    ]);
    expect(
      projectSubagentSkipEdges(result, 'attention').items.map(
        (entry) => entry.node.id,
      ),
    ).toEqual(['needs-approval', 'failed']);
  });

  it('adds levels-window stubs with hidden and hidden-live counts', () => {
    const result = tree([
      managed('level-one', undefined, 'running', { createdAt: 1 }),
      managed('level-two', 'level-one', 'completed', { createdAt: 2 }),
      managed('level-three-a', 'level-two', 'running', { createdAt: 3 }),
      managed('level-three-b', 'level-two', 'pending', {
        createdAt: 4,
        snapshot: { phase: 'queued' },
      }),
    ]);
    const window = windowSubagentTree(result, { levels: 2 });
    const root = window.items[0];
    const second = root?.kind === 'node' ? root.children[0] : undefined;
    expect(second).toMatchObject({
      kind: 'node',
      node: { id: 'level-two' },
      children: [
        {
          kind: 'stub',
          parentId: 'level-two',
          hiddenCount: 2,
          hiddenLiveCount: 2,
        },
      ],
    });
  });

  it('windows a filtered skip-edge projection and folds focused ancestors nearest-last', () => {
    const result = tree([
      managed('ancestor', undefined, 'completed', { createdAt: 1 }),
      managed('focus', 'ancestor', 'running', { createdAt: 2 }),
      managed('child', 'focus', 'running', { createdAt: 3 }),
      managed('grandchild', 'child', 'pending', {
        createdAt: 4,
        snapshot: { phase: 'queued' },
      }),
    ]);
    const active = projectSubagentSkipEdges(result, 'active');
    const focused = windowSubagentTree(active, {
      focusId: 'focus',
      levels: 1,
    });
    expect(focused.focusedNode?.id).toBe('focus');
    expect(focused.foldedAncestors.map((entry) => entry.id)).toEqual([
      'ancestor',
    ]);
    expect(focused.items[0]).toMatchObject({
      node: { id: 'focus' },
      children: [
        {
          kind: 'stub',
          parentId: 'focus',
          hiddenCount: 2,
          hiddenLiveCount: 2,
        },
      ],
    });
  });

  it("counts a root's skipped ancestors against the levels window", () => {
    const result = tree([
      managed('hidden-a', undefined, 'completed', { createdAt: 1 }),
      managed('hidden-b', 'hidden-a', 'completed', { createdAt: 2 }),
      managed('match', 'hidden-b', 'running', { createdAt: 3 }),
      managed('match-child', 'match', 'running', { createdAt: 4 }),
      managed('match-grandchild', 'match-child', 'running', {
        createdAt: 5,
      }),
    ]);
    const active = projectSubagentSkipEdges(result, 'active');
    const window = windowSubagentTree(active, { levels: 3 });

    expect(window.items[0]).toMatchObject({
      node: { id: 'match' },
      via: [{ id: 'hidden-a' }, { id: 'hidden-b' }],
      children: [
        {
          kind: 'stub',
          parentId: 'match',
          hiddenCount: 2,
          hiddenLiveCount: 2,
        },
      ],
    });
  });

  it("counts a child's skipped ancestors against the levels window", () => {
    const result = tree([
      managed('visible-parent', undefined, 'running', { createdAt: 1 }),
      managed('hidden-one', 'visible-parent', 'completed', { createdAt: 2 }),
      managed('hidden-two', 'hidden-one', 'completed', { createdAt: 3 }),
      managed('visible-child', 'hidden-two', 'running', { createdAt: 4 }),
      managed('grandchild', 'visible-child', 'running', { createdAt: 5 }),
    ]);
    const active = projectSubagentSkipEdges(result, 'active');
    const window = windowSubagentTree(active, { levels: 3 });

    expect(window.items[0]).toMatchObject({
      node: { id: 'visible-parent' },
      children: [
        {
          kind: 'stub',
          parentId: 'visible-parent',
          hiddenCount: 2,
          hiddenLiveCount: 2,
        },
      ],
    });
  });

  it('does not charge a focused task for ancestors its ancestry card shows', () => {
    const result = tree([
      managed('done-1', undefined, 'completed', { createdAt: 1 }),
      managed('done-2', 'done-1', 'completed', { createdAt: 2 }),
      managed('done-3', 'done-2', 'completed', { createdAt: 3 }),
      managed('done-4', 'done-3', 'completed', { createdAt: 4 }),
      managed('focused', 'done-4', 'running', { createdAt: 5 }),
      managed('running-child', 'focused', 'running', { createdAt: 6 }),
    ]);
    const active = projectSubagentSkipEdges(result, 'active');
    const focused = windowSubagentTree(active, {
      focusId: 'focused',
      levels: 3,
    });

    expect(focused.foldedAncestors.map((entry) => entry.id)).toEqual([
      'done-1',
      'done-2',
      'done-3',
      'done-4',
    ]);
    expect(focused.items[0]).toMatchObject({
      node: { id: 'focused' },
      via: [],
      children: [{ kind: 'node', node: { id: 'running-child' } }],
    });
  });

  it('computes Auto levels at multiple widths with a minimum and optional cap', () => {
    const geometry = {
      rootWidth: 10,
      nodeWidth: 10,
      columnGap: 10,
      stubWidth: 10,
      padding: 10,
    };
    expect(autoSubagentLevelCount({ canvasWidth: 0, ...geometry })).toBe(3);
    expect(autoSubagentLevelCount({ canvasWidth: 100, ...geometry })).toBe(4);
    expect(autoSubagentLevelCount({ canvasWidth: 200, ...geometry })).toBe(11);
    expect(
      autoSubagentLevelCount({ canvasWidth: 500, max: 8, ...geometry }),
    ).toBe(8);
  });
});

describe('subagent chat and references', () => {
  it('offers managed self, nearest ancestors, and root at depth three', () => {
    const result = tree([
      managed('one', undefined, 'running', { createdAt: 1 }),
      managed('two', 'one', 'running', { createdAt: 2 }),
      managed('three', 'two', 'running', {
        createdAt: 3,
        snapshot: { approvalPending: true },
      }),
    ]);
    expect(subagentRecipients(result, 'three')).toMatchObject([
      { id: 'three', kind: 'self', levelsUp: 0, canMessage: true },
      { id: 'two', kind: 'ancestor', levelsUp: 1, canMessage: true },
      { id: 'one', kind: 'ancestor', levelsUp: 2, canMessage: true },
      { id: 'root-chat', kind: 'root', levelsUp: 3, canMessage: true },
    ]);
  });

  it('limits a native subagent to itself and its nearest messageable parent or root', () => {
    const withManagedParent = tree(
      [managed('parent', undefined, 'running', { createdAt: 1 })],
      {
        claudeNative: [
          {
            toolUseId: 'native-child',
            parentId: 'parent',
            subagentType: 'Explore',
            description: 'Explore',
            state: 'running',
            runInBackground: false,
          },
        ],
      },
    );
    expect(subagentRecipients(withManagedParent, 'native-child')).toMatchObject(
      [
        { id: 'native-child', kind: 'self', levelsUp: 0, canMessage: false },
        { id: 'parent', kind: 'ancestor', levelsUp: 1, canMessage: true },
      ],
    );

    const underRoot = tree([], {
      claudeNative: [
        {
          toolUseId: 'root-native',
          parentId: null,
          subagentType: 'Explore',
          description: 'Explore',
          state: 'running',
          runInBackground: false,
        },
      ],
    });
    expect(subagentRecipients(underRoot, 'root-native')).toMatchObject([
      { id: 'root-native', kind: 'self', canMessage: false },
      { id: 'root-chat', kind: 'root', canMessage: true },
    ]);
  });

  it('formats, embeds, parses, and sanitizes subagent references', () => {
    expect(SUBAGENT_KINDS).toEqual([
      'managed',
      'claude-native',
      'codex-native',
      'workflow-agent',
      'workflow-run',
      'workflow-phase',
    ]);
    const reference = {
      kind: 'claude-native',
      id: 'tool:use-1',
      title: 'Inspect [the] flaky\ncheckout',
    } as const;
    const formatted = formatSubagentReference(reference);
    expect(formatted).toBe(
      'About Inspect the flaky checkout [canopy-subagent:claude-native:tool:use-1]',
    );
    const text = withSubagentReference(reference, 'Please inspect this.');
    expect(parseSubagentReference(text)).toEqual({
      reference: {
        kind: 'claude-native',
        id: 'tool:use-1',
        title: 'Inspect the flaky checkout',
      },
      body: 'Please inspect this.',
    });
    const longest = formatSubagentReference({
      kind: 'managed',
      id: 'x',
      title: 'a'.repeat(220),
    });
    expect(parseSubagentReference(`${longest}\n\nbody`)?.reference.title).toBe(
      'a'.repeat(200),
    );
  });

  it('rejects malformed, invalid-kind, invalid-id, and non-leading references', () => {
    expect(parseSubagentReference('ordinary text')).toBeNull();
    expect(
      parseSubagentReference('About task [canopy-subagent:other:id]\n\nbody'),
    ).toBeNull();
    expect(
      parseSubagentReference(
        'About task [canopy-subagent:managed:bad id]\n\nbody',
      ),
    ).toBeNull();
    expect(
      parseSubagentReference(
        `About task [canopy-subagent:managed:${'x'.repeat(257)}]\n\nbody`,
      ),
    ).toBeNull();
    expect(
      parseSubagentReference(
        'text\nAbout task [canopy-subagent:managed:id]\n\nbody',
      ),
    ).toBeNull();
    expect(
      parseSubagentReference('About task [canopy-subagent:managed:id]\nbody'),
    ).toBeNull();
    expect(
      parseSubagentReference(
        'About task [canopy-subagent:managed:id]\n\nbody\n\nextra',
      ),
    ).toEqual({
      reference: { kind: 'managed', id: 'id', title: 'task' },
      body: 'body\n\nextra',
    });
    expect(() =>
      formatSubagentReference({ kind: 'managed', id: 'not valid', title: 'x' }),
    ).toThrow(TypeError);
  });
});
