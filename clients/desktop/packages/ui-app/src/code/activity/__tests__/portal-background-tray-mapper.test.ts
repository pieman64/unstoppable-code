import type { AgentDelegationCardData } from '@canopy/protocol/delegation';
import type {
  PortalBackgroundProcessEntity,
  PortalChatMessage,
  PortalChatPart,
} from '@canopy/protocol/portal';
import type { PipelineRunArtifactReceiptV1 } from '@canopy/protocol/agent-artifacts';
import type {
  PipelineRunExecutionState,
  PipelineRunSummary,
} from '../pipeline/PipelineRunRows';
import {
  portalBackgroundProcessToTask,
  portalBackgroundTrayAgents,
  portalBackgroundTrayRuns,
} from '../portal-background-tray-mapper';

const PROCESS: PortalBackgroundProcessEntity = {
  localId: 'bg-1',
  workspaceLocalId: 'w1',
  worktreeLocalId: 't1',
  chatId: 'chat-1',
  toolUseId: 'toolu-1',
  taskId: 'task-1',
  kind: 'bash',
  description: 'pnpm run dev',
  status: 'running',
  startedAt: 1_000,
  updatedAt: 2_000,
  lastDescription: 'Compiling',
  canStop: true,
};

describe('portalBackgroundProcessToTask', () => {
  it('carries what the Portal knows and no output', () => {
    expect(portalBackgroundProcessToTask(PROCESS)).toEqual({
      id: 'bg-1',
      kind: 'bash',
      status: 'running',
      title: 'pnpm run dev',
      ownerToolUseId: 'toolu-1',
      parentTaskId: null,
      startedAt: 1_000,
      settledAt: null,
      updatedAt: 2_000,
      lastDescription: 'Compiling',
      summary: null,
      outputLines: [],
      canStop: true,
    });
  });

  it('settles a finished process at its last update', () => {
    expect(
      portalBackgroundProcessToTask({ ...PROCESS, status: 'stopped' })
        .settledAt,
    ).toBe(2_000);
  });
});

describe('portalBackgroundTrayAgents', () => {
  function delegation(
    over: Partial<AgentDelegationCardData> = {},
  ): AgentDelegationCardData {
    return {
      delegationId: 'child-1',
      status: 'running',
      outputTruncated: false,
      routeSnapshot: {
        selectedModelId: 'model',
        selectedModelLabel: 'GPT-6 Sol',
        runtimeModelId: 'model',
        harnessId: 'codex',
        runtimeKind: 'local',
        runnerRegistrationId: 'runner',
        runtimeVersion: '1',
        adapterVersion: '1',
        modelSource: 'agent',
        providerType: 'custom',
        assignmentRevision: '1',
        billingAuthority: 'native',
        aiCreditsRouted: false,
        capabilities: [],
        supportedThinkingLevels: [],
        capabilitySnapshotHash: 'hash',
        capabilityGeneration: 1,
        policyRevision: '1',
      },
      parentHarnessId: 'claude',
      description: 'Fix flaky e2e',
      prompt: 'Fix the flaky checkout e2e.',
      executionMode: 'background',
      ...over,
    };
  }
  function message(parts: PortalChatPart[], id = 'm1'): PortalChatMessage {
    return {
      messageId: id,
      chatId: 'chat-1',
      role: 'assistant',
      status: 'complete',
      text: '',
      createdAtMs: 1,
      parts,
    };
  }
  const readStep: PortalChatPart = {
    kind: 'tool_use',
    data: {
      toolUseId: 'read-1',
      toolName: 'Read',
      input: { file_path: 'src/a.ts' },
    },
  };
  const claudeAgent = (isRunning: boolean): PortalChatPart => ({
    kind: 'agent',
    data: {
      toolUseId: 'toolu-1',
      subagentType: 'code-reviewer',
      description: 'Review the diff',
      prompt: 'Review it.',
      runInBackground: true,
      isRunning,
      subBlocks: [readStep],
    },
  });

  it('merges a Claude background agent with its task, by tool use id', () => {
    const task = portalBackgroundProcessToTask({
      ...PROCESS,
      kind: 'agent',
    });
    expect(
      portalBackgroundTrayAgents([message([claudeAgent(true)])], [task]),
    ).toEqual([
      {
        id: 'claude:toolu-1',
        kind: 'claude',
        title: 'Review the diff',
        status: 'running',
        activity: null,
        startedAt: 1_000,
        steps: [
          {
            id: 'read-1',
            toolName: 'Read',
            input: '{"file_path":"src/a.ts"}',
          },
        ],
        prompt: 'Review it.',
        meta: 'Claude · code-reviewer',
        taskId: 'bg-1',
        canStop: false,
        target: {
          kind: 'claude-native',
          id: 'toolu-1',
          title: 'Review the diff',
        },
      },
    ]);
  });

  it('lists a Claude agent known only from its background task', () => {
    // A desktop-relayed chat carries native agents as background processes.
    const task = portalBackgroundProcessToTask({
      ...PROCESS,
      kind: 'agent',
      description: 'Review the diff',
    });
    expect(portalBackgroundTrayAgents([], [task])).toEqual([
      {
        id: 'claude:toolu-1',
        kind: 'claude',
        title: 'Review the diff',
        status: 'running',
        activity: 'Compiling',
        startedAt: 1_000,
        steps: [],
        prompt: null,
        meta: 'Claude',
        taskId: 'bg-1',
        canStop: false,
        // The Portal's subagent viewer finds agents by their transcript
        // parts, so one known only from its task has no chat to open.
        target: null,
      },
    ]);
    // A settled agent, a shell and a part for the same agent add nothing.
    expect(
      portalBackgroundTrayAgents(
        [message([claudeAgent(true)])],
        [
          task,
          portalBackgroundProcessToTask({ ...PROCESS, localId: 'bg-2' }),
          portalBackgroundProcessToTask({
            ...PROCESS,
            localId: 'bg-3',
            toolUseId: 'toolu-3',
            kind: 'agent',
            status: 'completed',
          }),
        ],
      ).map((row) => row.id),
    ).toEqual(['claude:toolu-1']);
  });

  it('lists background delegates that are queued or running, without Stop', () => {
    const rows = portalBackgroundTrayAgents(
      [
        message([
          { kind: 'agent', data: { delegation: delegation() } },
          {
            kind: 'agent',
            data: {
              delegation: delegation({
                delegationId: 'child-2',
                status: 'pending',
              }),
            },
          },
          {
            kind: 'agent',
            data: {
              delegation: delegation({
                delegationId: 'child-3',
                executionMode: 'foreground',
              }),
            },
          },
        ]),
      ],
      [],
    );
    expect(
      rows.map((row) => [row.id, row.status, row.canStop, row.meta]),
    ).toEqual([
      ['managed:child-1', 'running', false, 'Delegate · GPT-6 Sol'],
      ['managed:child-2', 'queued', false, 'Delegate · GPT-6 Sol'],
    ]);
  });

  it('keeps the latest part for an agent, so a settled one leaves', () => {
    expect(
      portalBackgroundTrayAgents(
        [
          message([claudeAgent(true)], 'm1'),
          message([claudeAgent(false)], 'm2'),
        ],
        [],
      ),
    ).toEqual([]);
    expect(
      portalBackgroundTrayAgents(
        [
          message([
            { kind: 'agent', data: { delegation: delegation() } },
            {
              kind: 'agent',
              data: { delegation: delegation({ status: 'completed' }) },
            },
          ]),
        ],
        [],
      ),
    ).toEqual([]);
  });

  it('lists a running Codex child with no Open chat', () => {
    const [row] = portalBackgroundTrayAgents(
      [
        message([
          {
            kind: 'agent',
            data: {
              provider: 'codex',
              toolUseId: 'call-1',
              description: 'Audit coupon rules',
              model: 'gpt-6-sol',
              reasoningEffort: 'high',
              isRunning: true,
            },
          },
        ]),
      ],
      [],
    );
    expect(row).toMatchObject({
      id: 'codex:call-1',
      kind: 'codex',
      meta: 'Codex · gpt-6-sol · high',
      canStop: false,
      target: null,
    });
  });
});

describe('portalBackgroundTrayRuns', () => {
  function receipt(executionId: string): PipelineRunArtifactReceiptV1 {
    return {
      version: 1,
      kind: 'pipeline_run',
      operation: 'pipeline.run',
      dedupeKey: `canopy:pipeline_run:local:${executionId}`,
      createdAt: '2026-10-25T10:00:00.000Z',
      executionId,
      pipelineId: 'review',
      pipelineName: `Review ${executionId}`,
      initialStatus: 'running',
      queuedAt: '2026-10-25T10:00:00.000Z',
      projectId: 'proj',
      worktreeId: 'wt',
      navigationTarget: {
        kind: 'pipeline_execution',
        executionId,
        projectId: 'proj',
        worktreeId: 'wt',
      },
    };
  }
  function runMessage(id: string, executionId: string): PortalChatMessage {
    return {
      messageId: id,
      chatId: 'chat-1',
      role: 'assistant',
      status: 'complete',
      text: '',
      createdAtMs: 0,
      parts: [
        {
          kind: 'tool_result',
          data: {
            toolUseId: `tool-${id}`,
            output: '',
            isError: false,
            agentArtifacts: [receipt(executionId)],
          },
        },
      ],
    };
  }
  function summary(
    id: string,
    status: PipelineRunSummary['status'],
  ): PipelineRunSummary {
    return {
      id,
      pipeline_id: 'review',
      pipeline_name: `Review ${id}`,
      status,
      status_reasons: [],
      started_at: '2026-10-25T10:00:01.000Z',
    };
  }
  const STATE: PipelineRunExecutionState = {
    pipeline_snapshot: {
      jobs: { lint: { name: 'Lint', needs: [], steps: [] } },
    },
    jobs: { lint: { status: 'running', steps: {} } },
    job_groups: {},
  };

  it('maps the runs the run host knows, by their dedupe key', () => {
    const { runs, executionIds } = portalBackgroundTrayRuns(
      [
        runMessage('a1', 'e-live'),
        runMessage('a2', 'e-done'),
        runMessage('a3', 'e-unknown'),
      ],
      {
        summaries: [summary('e-live', 'running'), summary('e-done', 'success')],
        statesById: { 'e-live': STATE },
      },
    );
    // A run the host does not know stays in its record.
    expect(runs.map((run) => [run.id, run.status])).toEqual([
      ['canopy:pipeline_run:local:e-live', 'running'],
      ['canopy:pipeline_run:local:e-done', 'succeeded'],
    ]);
    expect(runs[0]).toMatchObject({
      id: 'canopy:pipeline_run:local:e-live',
      kind: 'pipeline',
      name: 'Review e-live',
      status: 'running',
      dag: { tiers: [['lint']] },
    });
    expect(runs[0]?.dag?.jobs.lint?.status).toBe('running');
    expect(executionIds).toEqual({
      'canopy:pipeline_run:local:e-live': 'e-live',
      'canopy:pipeline_run:local:e-done': 'e-done',
    });
  });

  it('lists nothing without a run host', () => {
    expect(
      portalBackgroundTrayRuns([runMessage('a1', 'e-live')], null).runs,
    ).toEqual([]);
  });
});

describe('Portal watched GitHub tray rows', () => {
  const base = {
    id: 'watcher',
    projectId: 'proj',
    worktreeId: 'wt',
    chatId: 'chat-1',
    trigger: 'github_workflow_runs_changed',
    targetKind: 'github_workflow_runs',
    status: 'active' as const,
    createdAt: '2026-11-01T12:00:00Z',
    display: {
      title: 'CI',
      subtitle: '',
      watching: '',
      watchingSubtitle: '',
      status: 'Active',
      details: [],
    },
  };
  const run = {
    repository: 'acme/api',
    runId: '101',
    runAttempt: 2,
    workflowName: 'CI',
    runNumber: 42,
    htmlUrl: 'https://github.com/acme/api/actions/runs/101',
    state: { kind: 'intermediate' as const, status: 'in_progress' as const },
    observedAt: '2026-11-01T12:00:00Z',
    jobs: [
      {
        jobId: '5',
        name: 'Build',
        status: 'in_progress',
        conclusion: null,
        htmlUrl: 'https://github.com/acme/api/actions/runs/101/job/5',
      },
    ],
  };
  const scope = { projectId: 'proj', worktreeId: 'wt', chatId: 'chat-1' };

  it.each(['delivery_failed', 'fired'] as const)(
    'does not show unfinished GitHub observations from a %s watcher as live work',
    (status) => {
      const watcher = {
        ...base,
        status,
        githubProgress: { runs: [run] },
        githubPullRequestProgress: {
          pullRequests: [
            {
              repository: 'acme/api',
              number: 7,
              url: 'https://github.com/acme/api/pull/7',
              state: 'open' as const,
              baseRefName: 'main',
              queue: null,
              observedAt: run.observedAt,
            },
          ],
        },
      };
      expect(portalBackgroundTrayRuns([], null, [watcher], scope).runs).toEqual(
        [],
      );
      const stillFollowed = portalBackgroundTrayRuns(
        [],
        null,
        [watcher, { ...watcher, id: 'following', status: 'active' }],
        scope,
      );
      expect(stillFollowed.runs.map((row) => row.status)).toEqual([
        'running',
        'running',
      ]);
      const completed = portalBackgroundTrayRuns(
        [],
        null,
        [
          {
            ...watcher,
            githubProgress: {
              runs: [
                { ...run, state: { kind: 'terminal', conclusion: 'success' } },
              ],
            },
            githubPullRequestProgress: {
              pullRequests: watcher.githubPullRequestProgress.pullRequests.map(
                (pr) => ({ ...pr, state: 'merged' }),
              ),
            },
          },
        ],
        scope,
      );
      expect(completed.runs.map((row) => row.status)).toEqual([
        'succeeded',
        'succeeded',
      ]);
    },
  );

  it('lists watched runs and PRs without a pipeline host or receipts, scoped to the chat', () => {
    const result = portalBackgroundTrayRuns(
      [],
      null,
      [
        { ...base, githubProgress: { runs: [run] } },
        {
          ...base,
          id: 'foreign',
          chatId: 'other',
          githubProgress: { runs: [{ ...run, runId: '999' }] },
        },
        {
          ...base,
          id: 'pr',
          trigger: 'github_pull_requests_changed',
          targetKind: 'github_pull_requests',
          githubPullRequestProgress: {
            pullRequests: [
              {
                repository: 'acme/api',
                number: 7,
                title: 'Ship it',
                url: 'https://github.com/acme/api/pull/7',
                state: 'open',
                baseRefName: 'main',
                queue: { position: 3 },
                observedAt: run.observedAt,
              },
            ],
          },
        },
      ],
      scope,
    );
    expect(result.runs).toMatchObject([
      {
        kind: 'github',
        name: 'CI #42 · attempt 2',
        status: 'running',
        dag: { tiers: [['5']] },
      },
      {
        kind: 'github-pr',
        name: '#7 Ship it',
        statusLabel: 'In merge queue',
        note: 'into main · position 3 in the merge queue',
      },
    ]);
    expect(Object.values(result.githubUrls)).toEqual([
      run.htmlUrl,
      'https://github.com/acme/api/pull/7',
    ]);
    expect(result.executionIds).toEqual({});
  });

  it('deduplicates snapshots by newest observation and pins each run attempt separately', () => {
    const result = portalBackgroundTrayRuns(
      [],
      null,
      [
        {
          ...base,
          id: 'final',
          status: 'fired',
          githubProgress: {
            runs: [
              {
                ...run,
                state: { kind: 'terminal', conclusion: 'success' },
                observedAt: '2026-11-01T12:05:00Z',
              },
            ],
          },
        },
        { ...base, githubProgress: { runs: [run, { ...run, runAttempt: 1 }] } },
      ],
      scope,
    );
    expect(
      result.runs.find((row) => row.id.endsWith('/attempt/2'))?.status,
    ).toBe('succeeded');
    expect(
      result.runs.find((row) => row.id.endsWith('/attempt/1'))?.status,
    ).toBe('running');
    expect(new Set(result.runs.map((row) => row.id)).size).toBe(2);
  });
});
