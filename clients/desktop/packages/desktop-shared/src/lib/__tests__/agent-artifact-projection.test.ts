import type {
  AgentArtifactReceiptV1,
  AutomationRunArtifactReceiptV1,
  CapabilityReferenceArtifactReceiptV1,
  PipelineArtifactReceiptV1,
} from '../../types/agent-artifacts';
import type {
  PersistedChatMessage,
  PipelineRunArtifactReceiptV1,
} from '../../types';
import { buildPipelineRunArtifactReceipt } from '../agent-artifacts';
import {
  createEmptyAgentArtifactProjectionCache,
  isArtifactDispatchTool,
  projectAgentArtifactsWithCarry,
  projectPipelineRunTurnLinks,
  type AgentArtifactProjectionStats,
} from '../agent-artifact-projection';

const now = '2026-08-04T12:00:00.000Z';
const scope = { projectId: 'project-1', worktreeId: 'worktree-1' };

function receipt(
  executionId: string,
  operation = 'pipeline.run',
  worktreeId = 'worktree-1',
  pipelineId = 'pipe-1',
): PipelineRunArtifactReceiptV1 {
  return buildPipelineRunArtifactReceipt({
    operation,
    executionId,
    pipelineId,
    pipelineName: 'Build',
    initialStatus: 'running',
    queuedAt: now,
    createdAt: now,
    projectId: 'project-1',
    worktreeId,
    navigationTarget: {
      kind: 'pipeline_execution',
      executionId,
      projectId: 'project-1',
      worktreeId,
    },
  });
}

function user(id: string, hidden = false): PersistedChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text: id }],
    timestamp: 1,
    ...(hidden ? { hidden: true } : {}),
  };
}

function call(
  id: string,
  toolUseId: string,
  toolName = 'DispatchAction',
): PersistedChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'tool_use', toolUseId, toolName, input: '{}' }],
    timestamp: 2,
  };
}

function result(
  id: string,
  toolUseId: string,
  receipts: readonly AgentArtifactReceiptV1[],
  toolName = 'DispatchAction',
): PersistedChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [
      {
        type: 'tool_result',
        toolUseId,
        toolName,
        output: JSON.stringify({
          ok: true,
          result: { agentArtifacts: receipts },
        }),
        isError: false,
      },
    ],
    timestamp: 3,
  };
}

function foundPipeline(
  pipelineId: string,
  source: 'user' | 'project' | 'shared',
  sharedRemoteId?: string,
): CapabilityReferenceArtifactReceiptV1 {
  return {
    version: 1,
    kind: 'capability_reference',
    operation: 'pipeline.get',
    dedupeKey: `canopy:capability_reference:${source}:pipeline:${pipelineId}`,
    createdAt: now,
    itemKind: 'pipeline',
    source,
    sourceId: sharedRemoteId ?? pipelineId,
    name: 'Build',
    sourceLabel: source === 'shared' ? 'Shared' : 'Local',
    state: 'installed',
    relation: 'found',
    navigationTarget: {
      kind: 'pipeline_editor',
      pipelineId,
      source,
      ...(source === 'project' ? scope : {}),
      ...(sharedRemoteId === undefined ? {} : { sharedRemoteId }),
    },
  };
}

function foundAutomation(
  activityId: string,
): CapabilityReferenceArtifactReceiptV1 {
  return {
    version: 1,
    kind: 'capability_reference',
    operation: 'automation.get',
    dedupeKey: `canopy:capability_reference:local:automation:${activityId}`,
    createdAt: now,
    itemKind: 'automation',
    source: 'local',
    sourceId: activityId,
    name: 'Nightly triage',
    sourceLabel: 'Local',
    state: 'installed',
    relation: 'found',
    navigationTarget: { kind: 'automation_editor', activityId },
  };
}

function automationRun(activityId: string): AutomationRunArtifactReceiptV1 {
  return {
    version: 1,
    kind: 'automation_run',
    operation: 'automation.run_now',
    dedupeKey: `canopy:automation_run:local:run-1`,
    createdAt: now,
    activityId,
    runId: 'run-1',
    name: 'Nightly triage',
    status: 'success',
    trigger: 'manual',
    scheduledFor: now,
    startedAt: now,
    navigationTarget: {
      kind: 'automation_editor',
      activityId,
      section: 'runs',
      runId: 'run-1',
    },
  };
}

function createdPipeline(pipelineId: string): PipelineArtifactReceiptV1 {
  return {
    version: 1,
    kind: 'pipeline',
    operation: 'pipeline.create',
    dedupeKey: `canopy:pipeline:user:${pipelineId}`,
    createdAt: now,
    source: 'user',
    localId: pipelineId,
    name: 'Build',
    enabled: false,
    scopes: [],
    runModes: [],
    jobCount: 1,
    stepCount: 1,
    navigationTarget: { kind: 'pipeline_editor', pipelineId, source: 'user' },
  };
}

/** One turn whose tool results carry `receipts`, one result per receipt. */
function turn(
  id: string,
  receipts: readonly AgentArtifactReceiptV1[],
): PersistedChatMessage[] {
  return [
    user(id),
    ...receipts.flatMap((item, index) => [
      call(`${id}-c-${index}`, `${id}-t-${index}`),
      result(`${id}-r-${index}`, `${id}-t-${index}`, [item]),
    ]),
  ];
}

describe('shared agent artifact projection (CAN-3619)', () => {
  it('recognizes only action dispatch tools', () => {
    expect(isArtifactDispatchTool('DispatchAction')).toBe(true);
    expect(isArtifactDispatchTool('Bash')).toBe(false);
  });

  it('reports projection work to the host callback', () => {
    const stats: AgentArtifactProjectionStats[] = [];
    projectAgentArtifactsWithCarry(
      [user('u-1'), call('c-1', 't-1'), result('r-1', 't-1', [receipt('e')])],
      undefined,
      undefined,
      (next) => stats.push(next),
    );
    expect(stats).toEqual([{ turns: 1, segments: 1 }]);
  });

  it('links each run once per owning turn with its merged relation', () => {
    const messages = [
      user('u-1'),
      call('c-1', 't-1'),
      result('r-1', 't-1', [receipt('exec-run')]),
      call('c-2', 't-2'),
      result('r-2', 't-2', [receipt('exec-run', 'pipeline.execution_resume')]),
      // A hidden delivery does not start a turn; its calls stay with u-1.
      user('hidden-1', true),
      call('c-3', 't-3'),
      result('r-3', 't-3', [receipt('exec-foreign', 'pipeline.run', 'wt-2')]),
      user('u-2'),
      call('c-4', 't-4'),
      user('u-3'),
      // Late result: belongs to u-2, which made the call.
      result('r-4', 't-4', [receipt('exec-retry', 'pipeline.execution_retry')]),
      call('c-5', 't-5', 'Bash'),
      result('r-5', 't-5', [receipt('exec-bash')], 'Bash'),
    ];
    const projection = projectAgentArtifactsWithCarry(messages, {
      'u-3': [receipt('exec-watch', 'pipeline.watch')],
      'u-gone': [receipt('exec-ghost', 'pipeline.watch')],
    });

    expect(
      projectPipelineRunTurnLinks(projection, ['u-1', 'u-2', 'u-3'], scope),
    ).toEqual([
      { executionId: 'exec-run', userMessageId: 'u-1', relation: 'launched' },
      {
        executionId: 'exec-retry',
        userMessageId: 'u-2',
        relation: 'launched',
      },
      {
        executionId: 'exec-watch',
        userMessageId: 'u-3',
        relation: 'watching',
      },
    ]);
    // Without a scope, another worktree's receipt still attributes to u-1.
    expect(
      projectPipelineRunTurnLinks(projection, ['u-1']).map(
        (link) => link.executionId,
      ),
    ).toEqual(['exec-run', 'exec-foreign']);
  });

  it('follows the given turn order and skips turns without receipts', () => {
    const projection = projectAgentArtifactsWithCarry(
      [user('u-1'), user('u-2')],
      {
        'u-1': [receipt('exec-a', 'pipeline.watch')],
        'u-2': [receipt('exec-b', 'pipeline.watch')],
      },
    );
    expect(
      projectPipelineRunTurnLinks(projection, ['u-2', 'u-missing', 'u-1']).map(
        (link) => link.userMessageId,
      ),
    ).toEqual(['u-2', 'u-1']);
  });
});

describe('per-turn collapse by item identity (CAN-4689)', () => {
  it.each([
    ['local', 'pipe-1', foundPipeline('pipe-1', 'user')],
    [
      'project',
      'project--.canopy/pipelines/build.yaml',
      foundPipeline('project--.canopy/pipelines/build.yaml', 'project'),
    ],
    [
      'shared',
      'shared:canopy-cloud:rid',
      foundPipeline('shared:canopy-cloud:rid', 'shared', 'rid'),
    ],
  ])(
    'keeps only the run when a %s pipeline was found and run',
    (_, pipelineId, found) => {
      const run = receipt('exec-1', 'pipeline.run', 'worktree-1', pipelineId);
      // The found tile survives projection on its own, so the drop below is
      // the collapse and not validation.
      expect(
        projectAgentArtifactsWithCarry(turn('u-1', [found])).byTurn['u-1'],
      ).toEqual([found]);
      const projection = projectAgentArtifactsWithCarry(
        turn('u-1', [found, run]),
      );
      expect(projection.byTurn['u-1']).toEqual([run]);
    },
  );

  it('keeps only the automation run when the automation was found and run', () => {
    const run = automationRun('act-1');
    const projection = projectAgentArtifactsWithCarry(
      turn('u-1', [foundAutomation('act-1'), run]),
    );
    expect(projection.byTurn['u-1']).toEqual([run]);
  });

  it('keeps the recommendation when the pipeline was recommended then found', () => {
    const recommended: CapabilityReferenceArtifactReceiptV1 = {
      ...foundPipeline('pipe-1', 'user'),
      operation: 'capabilities.show',
      relation: 'recommended',
      reason: 'Runs the release checks',
    };
    const found = foundPipeline('pipe-1', 'user');
    // Both references share one dedupe key, so this is the merge keeping the
    // higher-precedence receipt, not the collapse.
    expect(recommended.dedupeKey).toBe(found.dedupeKey);
    expect(
      projectAgentArtifactsWithCarry(turn('u-1', [recommended, found])).byTurn[
        'u-1'
      ],
    ).toEqual([recommended]);
    expect(
      projectAgentArtifactsWithCarry([
        user('u-1'),
        call('u-1-c', 'u-1-t'),
        result('u-1-r', 'u-1-t', [recommended, found]),
      ]).byTurn['u-1'],
    ).toEqual([recommended]);
  });

  it('keeps only the created receipt when the pipeline was found and created', () => {
    const created = createdPipeline('pipe-1');
    const projection = projectAgentArtifactsWithCarry(
      turn('u-1', [foundPipeline('pipe-1', 'user'), created]),
    );
    expect(projection.byTurn['u-1']).toEqual([created]);
  });

  it('drops a found tile for a carried watched run without changing run links', () => {
    const watch = receipt('exec-9', 'pipeline.watch');
    const carry = { 'u-1': [watch] };
    const withFound = projectAgentArtifactsWithCarry(
      turn('u-1', [foundPipeline('pipe-1', 'user')]),
      carry,
    );
    const withoutFound = projectAgentArtifactsWithCarry([user('u-1')], carry);

    expect(withFound.byTurn['u-1']).toEqual([watch]);
    expect(withFound.chatInitiatedPipelineRuns).toEqual({});
    expect(projectPipelineRunTurnLinks(withFound, ['u-1'], scope)).toEqual(
      projectPipelineRunTurnLinks(withoutFound, ['u-1'], scope),
    );
  });

  it('keeps chat-initiated runs from contributions when a turn collapses', () => {
    const run = receipt('exec-1');
    const projection = projectAgentArtifactsWithCarry(
      turn('u-1', [foundPipeline('pipe-1', 'user'), run]),
    );
    expect(projection.chatInitiatedPipelineRuns).toEqual({ 'exec-1': run });
  });

  it('returns the cached turn array on an unchanged second projection', () => {
    const cache = createEmptyAgentArtifactProjectionCache();
    const messages = [
      ...turn('u-1', [foundPipeline('pipe-1', 'user'), receipt('exec-1')]),
      ...turn('u-2', [foundPipeline('pipe-2', 'user')]),
    ];
    const first = projectAgentArtifactsWithCarry(messages, undefined, cache);
    const second = projectAgentArtifactsWithCarry(messages, undefined, cache);

    expect(first.byTurn['u-1']).toHaveLength(1);
    expect(second.byTurn['u-1']).toBe(first.byTurn['u-1']);
    expect(first.byTurn['u-2']).toHaveLength(1);
    expect(second.byTurn['u-2']).toBe(first.byTurn['u-2']);
  });
});
