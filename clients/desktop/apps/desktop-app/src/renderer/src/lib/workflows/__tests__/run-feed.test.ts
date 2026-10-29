import type {
  AppAdvisorWatcherSummary,
  AutomationAction,
  ScheduledActivity,
  ScheduledActivityRun,
} from '@canopy/desktop-shared/types';
import type { ExecutionSummary } from '@canopy/desktop-shared/types/pipeline';
import type { WorkflowRunRow } from '@canopy/ui-app/workflows';
import {
  activitiesWithRunHistory,
  buildWorkflowRunRows,
  loadOlderAutomationRuns,
  mergeAutomationRuns,
  runsForAutomation,
  type RunFeedInput,
} from '../run-feed';

const PROJECTS: Readonly<Record<string, string>> = {
  storefront: 'storefront',
  canopy: 'canopy',
};

function activity(
  id: string,
  action: AutomationAction,
  overrides: Partial<ScheduledActivity> = {},
): ScheduledActivity {
  return {
    version: 1,
    id,
    name: `Activity ${id}`,
    enabled: true,
    schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
    action,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    failureCount: 0,
    ...overrides,
  };
}

function run(
  id: string,
  activityId: string,
  overrides: Partial<ScheduledActivityRun> = {},
): ScheduledActivityRun {
  return {
    id,
    activityId,
    activityName: `Activity ${activityId}`,
    scheduledFor: '2026-10-12T02:00:00.000Z',
    manual: false,
    trigger: 'scheduled',
    status: 'success',
    startedAt: '2026-10-12T02:00:00.000Z',
    completedAt: '2026-10-12T02:02:04.000Z',
    ...overrides,
  };
}

function execution(
  id: string,
  overrides: Partial<ExecutionSummary> = {},
): ExecutionSummary {
  return {
    id,
    pipeline_id: 'dependency-check',
    pipeline_name: 'Dependency check',
    status: 'success',
    status_reasons: [],
    started_at: '2026-10-12T02:00:05.000Z',
    completed_at: '2026-10-12T02:14:08.000Z',
    cwd: '/tmp/storefront',
    project_id: 'storefront',
    ...overrides,
  };
}

function watcher(
  id: string,
  status: AppAdvisorWatcherSummary['status'],
  overrides: Partial<AppAdvisorWatcherSummary> = {},
): AppAdvisorWatcherSummary {
  return {
    target: {
      kind: 'worktree_chat',
      projectId: 'canopy',
      worktreeId: 'main',
      chatId: 'inbox',
    },
    destination: { projectId: 'canopy', worktreeId: 'main', chatId: 'inbox' },
    id,
    trigger: 'worktree_chat_completion',
    status,
    label: `Watcher ${id}`,
    createdAt: '2026-10-12T09:40:00.000Z',
    ...overrides,
  };
}

const PIPELINE_ACTION: AutomationAction = {
  type: 'worktree_pipeline',
  workspaceId: 'storefront',
  pipelineId: 'dependency-check',
  pipelineName: 'Dependency check',
};

function feed(
  overrides: Partial<RunFeedInput> = {},
): readonly WorkflowRunRow[] {
  return buildWorkflowRunRows({
    executions: [],
    runs: [],
    activities: [],
    watchers: [],
    activityInScope: () => true,
    orphanRunInScope: () => true,
    executionInScope: () => true,
    watcherInScope: () => true,
    executionActions: (summary) =>
      summary.status === 'paused'
        ? ['respond', 'cancel']
        : summary.status === 'running'
          ? ['cancel']
          : summary.status === 'failure'
            ? ['retry', 'rerun']
            : ['rerun'],
    automationRunResult: () => ({ available: true }),
    names: {
      project: (id) => PROJECTS[id],
      worktree: (_project, id) =>
        id === 'left-rail' ? 'left-rail' : undefined,
      chat: (_project, _worktree, id) =>
        id === 'chat-1' ? 'Checkout form validation' : undefined,
      watcherDestination: () => 'canopy · Inbox chat',
    },
    ...overrides,
  });
}

function only(rows: readonly WorkflowRunRow[]): WorkflowRunRow {
  const [row] = rows;
  if (!row || rows.length !== 1) {
    throw new Error(`Expected one row, got ${String(rows.length)}`);
  }
  return row;
}

describe('automation rows', () => {
  const cases: readonly {
    readonly name: string;
    readonly action: AutomationAction;
    readonly detail: string;
    readonly where: string | undefined;
  }[] = [
    {
      name: 'app_advisor_prompt',
      action: { type: 'app_advisor_prompt', prompt: 'Standup notes' },
      detail: 'Asked App Advisor',
      where: 'App Advisor',
    },
    {
      name: 'standalone_prompt',
      action: {
        type: 'standalone_prompt',
        chatProjectId: 'storefront',
        prompt: 'Triage',
      },
      detail: 'Started a chat in storefront',
      where: 'storefront · new chat',
    },
    {
      name: 'worktree_prompt',
      action: {
        type: 'worktree_prompt',
        workspaceId: 'storefront',
        prompt: 'Lint sweep',
      },
      detail: 'Started a chat in storefront',
      where: 'storefront · new worktree',
    },
    {
      name: 'worktree_session_prompt',
      action: {
        type: 'worktree_session_prompt',
        workspaceId: 'storefront',
        worktreeId: 'main',
        chatId: 'chat-1',
        prompt: 'Follow up',
      },
      detail: 'Sent a message to Checkout form validation',
      where: 'storefront · Checkout form validation',
    },
    {
      name: 'worktree_pipeline',
      action: PIPELINE_ACTION,
      detail: 'Pipeline Dependency check finished',
      where: 'storefront · new worktree',
    },
    {
      name: 'pipeline_execution_resume',
      action: {
        type: 'pipeline_execution_resume',
        executionId: 'exec-elsewhere',
        pipelineName: 'Release',
        projectId: 'canopy',
      },
      detail: 'Resumed pipeline Release',
      where: 'canopy',
    },
  ];

  it.each(cases)(
    'builds an Automation row for $name from its run record',
    ({ action, detail, where }) => {
      const row = only(
        feed({ activities: [activity('a', action)], runs: [run('r', 'a')] }),
      );
      expect(row.kind).toBe('automation');
      expect(row.detail).toBe(detail);
      expect(row.where).toBe(where);
      expect(row.starter).toBe('schedule');
      expect(row.libraryRowKey).toBe('automation:a');
      expect(row.actions).toContain('open-library');
    },
  );

  it('labels who started it from the run trigger', () => {
    const activities = [activity('a', PIPELINE_ACTION)];
    const starter = (overrides: Partial<ScheduledActivityRun>): unknown =>
      only(feed({ activities, runs: [run('r', 'a', overrides)] })).starter;
    expect(starter({ trigger: 'scheduled' })).toBe('schedule');
    expect(starter({ trigger: 'catch_up' })).toBe('catch-up');
    expect(starter({ trigger: 'manual', manual: true })).toBe('run-now');
    expect(starter({ trigger: undefined, manual: true })).toBe('run-now');
    expect(starter({ trigger: undefined, manual: false })).toBe('schedule');
  });

  it.each([
    ['if_command_exit', 'If command did not pass, so nothing ran'],
    [
      'idempotency',
      'If command reported a result already handled, so nothing ran',
    ],
    [
      'already_running',
      'The previous run was still going, so this one was skipped',
    ],
  ] as const)(
    'explains a %s skip and expands to the recorded output',
    (skipReason, detail) => {
      const row = only(
        feed({
          activities: [activity('a', PIPELINE_ACTION, { ifCommand: 'true' })],
          runs: [
            run('r', 'a', {
              status: 'skipped',
              skipReason,
              ifCommandOutput: 'no commits since last release',
            }),
          ],
        }),
      );
      expect(row.status).toBe('skipped');
      expect(row.detail).toBe(detail);
      expect(row.result).toEqual({ available: false });
      expect(row.output).toBe('no commits since last release');
    },
  );

  it('puts the gate result before the action and its failure', () => {
    const row = only(
      feed({
        activities: [activity('a', PIPELINE_ACTION, { ifCommand: 'true' })],
        runs: [
          run('r', 'a', {
            status: 'failure',
            error: 'npm test failed, 3 tests in apps/web',
          }),
        ],
      }),
    );
    expect(row.detail).toBe(
      'If command passed · Pipeline Dependency check failed: npm test failed, 3 tests in apps/web',
    );
  });

  it('reports an If command that could not run, a cancel and a missed run', () => {
    const activities = [activity('a', PIPELINE_ACTION)];
    const detail = (overrides: Partial<ScheduledActivityRun>): unknown =>
      only(feed({ activities, runs: [run('r', 'a', overrides)] })).detail;
    expect(
      detail({ status: 'failure', ifCommandError: 'command not found' }),
    ).toBe('If command could not run: command not found');
    expect(detail({ status: 'canceled' })).toBe('Canceled');
    expect(detail({ status: 'missed' })).toBe('The app was not running');
    expect(
      detail({
        status: 'missed',
        omittedCount: 4,
        missedOccurrencesTruncated: true,
      }),
    ).toBe('The app was not running. 4 or more more missed');
  });

  it('offers Cancel only while the run can still be aborted', () => {
    const activities = [activity('a', PIPELINE_ACTION)];
    const cancellable = only(
      feed({
        activities,
        runs: [
          run('r', 'a', {
            status: 'running',
            cancellable: true,
            completedAt: undefined,
          }),
        ],
      }),
    );
    expect(cancellable.actions).toContain('cancel');
    const finished = only(
      feed({ activities, runs: [run('r', 'a', { cancellable: true })] }),
    );
    expect(finished.actions).not.toContain('cancel');
  });

  it('keeps the recorded name of a deleted automation and opens nothing in Library', () => {
    const row = only(
      feed({
        runs: [
          run('r', 'gone', {
            activityName: 'Weekly lint sweep',
            result: { appAdvisorChatId: 'chat-9' },
          }),
        ],
      }),
    );
    expect(row.name).toBe('Weekly lint sweep');
    expect(row.libraryRowKey).toBeUndefined();
    expect(row.actions).not.toContain('open-library');
    expect(row.detail).toBe('Asked App Advisor');
  });

  it('passes through why a destination no longer opens', () => {
    const row = only(
      feed({
        activities: [
          activity('a', { type: 'app_advisor_prompt', prompt: 'x' }),
        ],
        runs: [run('r', 'a')],
        automationRunResult: () => ({
          available: false,
          reason: 'The chat was deleted.',
        }),
      }),
    );
    expect(row.result).toEqual({
      available: false,
      reason: 'The chat was deleted.',
    });
  });
});

describe('execution ownership', () => {
  it('shows a worktree_pipeline execution inside its automation row only', () => {
    const rows = feed({
      activities: [activity('a', PIPELINE_ACTION)],
      runs: [run('r', 'a', { result: { pipelineExecutionId: 'exec-1' } })],
      executions: [
        execution('exec-1', { status: 'paused', completed_at: undefined }),
        execution('exec-2', { pipeline_name: 'Triage new issues' }),
      ],
    });
    expect(rows.map((row) => `${row.kind}:${row.name}`)).toEqual([
      'automation:Activity a',
      'pipeline:Triage new issues',
    ]);
    const [owner] = rows;
    // The linked execution is live: it supplies status and the actions.
    expect(owner?.status).toBe('waiting');
    expect(owner?.actions).toEqual(['respond', 'cancel', 'open-library']);
    expect(owner?.kind === 'automation' && owner.linkedExecutionId).toBe(
      'exec-1',
    );
    expect(owner?.result).toEqual({ available: true });
  });

  it('carries the linked execution failure onto the automation row', () => {
    const row = only(
      feed({
        activities: [activity('a', PIPELINE_ACTION)],
        // The automation's own record ended when the pipeline was dispatched.
        runs: [run('r', 'a', { result: { pipelineExecutionId: 'exec-1' } })],
        executions: [execution('exec-1', { status: 'failure' })],
      }),
    );
    expect(row.status).toBe('failure');
    expect(row.detail).toBe('Pipeline Dependency check failed');
    expect(row.actions).toEqual(['retry', 'rerun', 'open-library']);
  });

  it('does not offer Hide on the automation row that owns an execution', () => {
    const row = only(
      feed({
        activities: [activity('a', PIPELINE_ACTION)],
        runs: [run('r', 'a', { result: { pipelineExecutionId: 'exec-1' } })],
        executions: [execution('exec-1', { status: 'success' })],
        // Hide flags the execution, which this row would keep showing.
        executionActions: () => ['rerun', 'hide'],
      }),
    );
    expect(row.actions).toEqual(['rerun', 'open-library']);
  });

  it('leaves a resumed execution as its own Pipeline row', () => {
    const rows = feed({
      activities: [
        activity('a', {
          type: 'pipeline_execution_resume',
          executionId: 'exec-1',
          pipelineName: 'Release',
        }),
      ],
      runs: [run('r', 'a', { result: { pipelineExecutionId: 'exec-1' } })],
      // Retried since it was resumed, so its clock restarted after the run.
      executions: [
        execution('exec-1', {
          pipeline_name: 'Release',
          started_at: '2026-10-12T03:00:00.000Z',
        }),
      ],
    });
    expect(rows.map((row) => row.kind).sort()).toEqual([
      'automation',
      'pipeline',
    ]);
    const automation = rows.find((row) => row.kind === 'automation');
    expect(
      automation?.kind === 'automation' && automation.linkedExecutionId,
    ).toBeUndefined();
  });

  it('keeps one row for a run whose automation was deleted or edited', () => {
    // The execution started after the run did, so the run created it.
    const created = {
      runs: [run('r', 'a', { result: { pipelineExecutionId: 'exec-1' } })],
      executions: [execution('exec-1')],
    };
    expect(feed(created).map((row) => row.kind)).toEqual(['automation']);
    expect(
      feed({
        ...created,
        activities: [
          activity('a', { type: 'app_advisor_prompt', prompt: 'x' }),
        ],
      }).map((row) => row.kind),
    ).toEqual(['automation']);
  });

  it('leaves an execution that began before a deleted resume run as its own row', () => {
    const rows = feed({
      runs: [run('r', 'a', { result: { pipelineExecutionId: 'exec-1' } })],
      executions: [
        execution('exec-1', { started_at: '2026-10-11T22:00:00.000Z' }),
      ],
    });
    expect(rows.map((row) => row.kind).sort()).toEqual([
      'automation',
      'pipeline',
    ]);
  });

  it('keeps the recorded result and says the output is gone when the execution is not retained', () => {
    const row = only(
      feed({
        activities: [activity('a', PIPELINE_ACTION)],
        runs: [run('r', 'a', { result: { pipelineExecutionId: 'exec-old' } })],
      }),
    );
    expect(row.status).toBe('success');
    expect(row.detail).toBe(
      'Pipeline Dependency check finished · The run output is no longer kept',
    );
    expect(row.result).toEqual({
      available: false,
      reason: 'The run output is no longer kept.',
    });
  });

  it('does not call the output gone while the executions are not listed', () => {
    // Still loading, or the listing failed: nothing is known about retention.
    const row = only(
      feed({
        activities: [activity('a', PIPELINE_ACTION)],
        runs: [run('r', 'a', { result: { pipelineExecutionId: 'exec-1' } })],
        executions: [],
        executionsKnown: false,
      }),
    );
    expect(row.detail).not.toContain('no longer kept');
    expect(row.result).toEqual({ available: true });
  });

  it('shows the execution as a Pipeline row once its automation run aged out', () => {
    const rows = feed({
      activities: [activity('a', PIPELINE_ACTION)],
      runs: [],
      executions: [execution('exec-1')],
    });
    expect(only(rows).kind).toBe('pipeline');
  });
});

describe('pipeline rows', () => {
  it('labels the starter and where, and leaves out sub-pipelines and hidden runs', () => {
    const rows = feed({
      executions: [
        execution('manual', {
          event_name: 'dispatch',
          project_id: 'canopy',
          worktree_id: 'left-rail',
        }),
        execution('plan', { event_name: 'plan_ready' }),
        execution('task', { event_name: 'task_ready' }),
        execution('hook', {
          trigger_source: {
            kind: 'hook',
            hook_label: 'post-merge',
            triggered_at: '2026-10-12T01:00:00.000Z',
          },
        }),
        execution('child', { parent_execution_id: 'manual' }),
        execution('hidden', { hidden: true }),
      ],
    });
    const byId = new Map(
      rows.map((row) => [row.kind === 'pipeline' ? row.summary.id : '', row]),
    );
    expect([...byId.keys()].sort()).toEqual(['hook', 'manual', 'plan', 'task']);
    expect(byId.get('manual')?.starter).toBe('manual');
    expect(byId.get('manual')?.where).toBe('canopy · left-rail');
    expect(byId.get('plan')?.starter).toBe('plan-approved');
    expect(byId.get('task')?.starter).toBe('task-ready');
    expect(byId.get('hook')?.starter).toBe('hook');
  });

  it('says a paused run is waiting and takes its actions from the host gates', () => {
    const row = only(
      feed({
        executions: [
          execution('e', { status: 'paused', completed_at: undefined }),
        ],
      }),
    );
    expect(row.status).toBe('waiting');
    expect(row.detail).toBe('Waiting for you');
    expect(row.actions).toEqual(['respond', 'cancel']);
  });
});

describe('watcher rows', () => {
  it('maps each watcher status and its actions', () => {
    const rows = feed({
      watchers: [
        watcher('active', 'active'),
        watcher('firing', 'firing'),
        watcher('fired', 'fired', { firedAt: '2026-10-12T10:00:00.000Z' }),
        watcher('failed', 'delivery_failed', {
          deliveryError: 'The chat was archived',
        }),
      ],
    });
    const byName = new Map(rows.map((row) => [row.name, row]));
    expect(byName.get('Watcher active')?.status).toBe('watching');
    expect(byName.get('Watcher active')?.actions).toEqual([
      'cancel',
      'inspect',
      'go-to-chat',
    ]);
    expect(byName.get('Watcher firing')?.status).toBe('running');
    expect(byName.get('Watcher fired')?.status).toBe('fired');
    expect(byName.get('Watcher fired')?.actions).toEqual([
      'inspect',
      'go-to-chat',
    ]);
    expect(byName.get('Watcher failed')?.status).toBe('delivery-failed');
    expect(byName.get('Watcher failed')?.detail).toBe('The chat was archived');
    expect(byName.get('Watcher active')?.where).toBe('canopy · Inbox chat');
  });
});

describe('scope, order and paging', () => {
  it('follows the host scope for every kind, including deleted activities', () => {
    const input: Partial<RunFeedInput> = {
      activities: [
        activity('in', PIPELINE_ACTION),
        activity('out', PIPELINE_ACTION),
      ],
      runs: [run('r1', 'in'), run('r2', 'out'), run('r3', 'deleted')],
      executions: [
        execution('e-in', { project_id: 'storefront' }),
        execution('e-out', { project_id: 'canopy' }),
      ],
      watchers: [watcher('w-in', 'active'), watcher('w-out', 'active')],
    };
    const scoped = feed({
      ...input,
      activityInScope: (candidate) => candidate.id === 'in',
      orphanRunInScope: () => false,
      executionInScope: (candidate) => candidate.project_id === 'storefront',
      watcherInScope: (candidate) => candidate.id === 'w-in',
    });
    expect(scoped.map((row) => row.key).sort()).toEqual([
      'automation-run:r1',
      'pipeline-run:e-in',
      'watcher:w-in',
    ]);
    expect(feed(input)).toHaveLength(7);
  });

  it('pins active rows first, then newest, and counts each run once', () => {
    const rows = feed({
      activities: [activity('a', { type: 'app_advisor_prompt', prompt: 'x' })],
      runs: [
        run('old', 'a', { startedAt: '2026-10-10T02:00:00.000Z' }),
        run('new', 'a', { startedAt: '2026-10-12T02:00:00.000Z' }),
        // A Load more page overlapping the hot window.
        run('new', 'a', { startedAt: '2026-10-12T02:00:00.000Z' }),
      ],
      watchers: [
        watcher('w', 'active', { createdAt: '2026-10-01T00:00:00.000Z' }),
      ],
    });
    expect(rows.map((row) => row.key)).toEqual([
      'watcher:w',
      'automation-run:new',
      'automation-run:old',
    ]);
  });

  it('merges run pages by id and limits Load more to activities with loaded runs', () => {
    const merged = mergeAutomationRuns(
      [run('r1', 'a'), run('r2', 'b')],
      [run('r2', 'b'), run('r3', 'a')],
    );
    expect(merged.map((entry) => entry.id)).toEqual(['r1', 'r2', 'r3']);
    const activities = [
      activity('a', PIPELINE_ACTION),
      activity('b', PIPELINE_ACTION),
      activity('never-ran', PIPELINE_ACTION),
      // A frequent automation pushed this one's runs out of the hot window.
      activity('crowded-out', PIPELINE_ACTION, {
        lastResult: {
          status: 'success',
          completedAt: '2026-10-01T02:00:00.000Z',
        },
      }),
    ];
    expect(
      activitiesWithRunHistory(
        merged,
        activities,
        (candidate) => candidate.id !== 'b',
      ).map((entry) => entry.id),
    ).toEqual(['a', 'crowded-out']);
  });
});

describe('loadOlderAutomationRuns', () => {
  const nightly = activity('a', { type: 'app_advisor_prompt', prompt: 'x' });

  it('keeps paging past a first page the feed already lists', async () => {
    const cursors = new Map<string, string | null>();
    const requests: (string | undefined)[] = [];
    const result = await loadOlderAutomationRuns({
      activities: [nightly],
      cursors,
      listedRunIds: new Set(['r1', 'r2']),
      listRuns: (request) => {
        requests.push(request.cursor);
        return Promise.resolve(
          request.cursor === undefined
            ? { runs: [run('r1', 'a'), run('r2', 'a')], nextCursor: 'page-2' }
            : { runs: [run('r3', 'a')], nextCursor: null },
        );
      },
    });

    // One Load more reached the first run that was not listed yet.
    expect(requests).toEqual([undefined, 'page-2']);
    expect(result.loaded.map((entry) => entry.id)).toEqual(['r1', 'r2', 'r3']);
    expect(result.failed).toBe(false);
    expect(cursors.get('a')).toBeNull();
  });

  it('stops at the first page that adds a run', async () => {
    const cursors = new Map<string, string | null>();
    const listRuns = jest.fn(() =>
      Promise.resolve({ runs: [run('r9', 'a')], nextCursor: 'page-2' }),
    );
    await loadOlderAutomationRuns({
      activities: [nightly],
      cursors,
      listedRunIds: new Set(),
      listRuns,
    });

    expect(listRuns).toHaveBeenCalledTimes(1);
    expect(cursors.get('a')).toBe('page-2');
  });

  it('keeps the cursor of a history that failed, and skips a finished one', async () => {
    const finished = activity('done', {
      type: 'app_advisor_prompt',
      prompt: 'x',
    });
    const cursors = new Map<string, string | null>([
      ['a', 'page-2'],
      ['done', null],
    ]);
    const listRuns = jest.fn(() => Promise.reject(new Error('offline')));
    const result = await loadOlderAutomationRuns({
      activities: [nightly, finished],
      cursors,
      listedRunIds: new Set(),
      listRuns,
    });

    expect(listRuns).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ loaded: [], failed: true });
    // The next Load more asks for the same page again.
    expect(cursors.get('a')).toBe('page-2');
  });
});

describe('runsForAutomation', () => {
  it("lists only the automation's own runs, with the executions they started", () => {
    const rows = feed({
      activities: [
        activity('a', PIPELINE_ACTION),
        activity('b', { type: 'app_advisor_prompt', prompt: 'x' }),
      ],
      runs: [
        run('r1', 'a', {
          startedAt: '2026-10-12T02:00:00.000Z',
          result: { pipelineExecutionId: 'exec-1' },
        }),
        run('r2', 'b'),
        run('r3', 'a', { startedAt: '2026-10-11T02:00:00.000Z' }),
      ],
      executions: [execution('exec-1'), execution('exec-other')],
      watchers: [watcher('w', 'active')],
    });

    const own = runsForAutomation(rows, 'a');
    expect(own.map((row) => row.key)).toEqual([
      'automation-run:r1',
      'automation-run:r3',
    ]);
    // The execution it started shows inside its row, not as its own row.
    expect(own[0]?.kind === 'automation' && own[0].linkedExecutionId).toBe(
      'exec-1',
    );
  });

  it('leaves out the Pipeline row of an execution a resume run continued', () => {
    const rows = feed({
      activities: [
        activity('a', {
          type: 'pipeline_execution_resume',
          executionId: 'exec-1',
          pipelineName: 'Release',
        }),
      ],
      runs: [run('r', 'a', { result: { pipelineExecutionId: 'exec-1' } })],
      executions: [
        execution('exec-1', { started_at: '2026-10-12T03:00:00.000Z' }),
      ],
    });

    expect(only(runsForAutomation(rows, 'a')).kind).toBe('automation');
  });
});
