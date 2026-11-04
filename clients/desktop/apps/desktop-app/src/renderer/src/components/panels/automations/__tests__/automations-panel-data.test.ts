import type {
  AppAdvisorWatcherSummary,
  AutomationAction,
  ScheduledActivity,
  ScheduledActivityRun,
} from '@canopy/desktop-shared/types';
import {
  automationActionWorkspaceId,
  automationActionWorktreeId,
  buildLibraryRows,
  buildUpcomingEntries,
  filterActivitiesForScope,
  filterWatchersForScope,
  formatTimeUntil,
  getAutomationNextRun,
  panelRunFeedPredicates,
  watcherTargetWorkspaceId,
  watcherTargetWorktreeId,
  UPCOMING_MIN_ENTRIES,
  type LibraryTypeFilter,
} from '../automations-panel-data';
import type {
  ExecutionSummary,
  PipelineInfo,
} from '@canopy/desktop-shared/types/pipeline';
import type { WorkflowRunRow } from '@canopy/ui-app/workflows';
import {
  buildWorkflowRunRows,
  type RunFeedInput,
} from '@/lib/workflows/run-feed';

const NOW = new Date('2026-08-30T12:00:00.000Z');

function activity(
  overrides: Partial<ScheduledActivity> & { id: string },
): ScheduledActivity {
  return {
    version: 1,
    name: overrides.id,
    enabled: true,
    schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
    action: { type: 'app_advisor_prompt', prompt: 'Do the thing.' },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    failureCount: 0,
    ...overrides,
  };
}

function oneTimeAt(id: string, runAt: string): ScheduledActivity {
  return activity({
    id,
    schedule: { kind: 'one_time', runAt, timezone: 'local' },
    action: {
      type: 'worktree_prompt',
      workspaceId: 'ws-1',
      existingWorktreeId: 'wt-1',
      prompt: 'Go.',
    },
  });
}

function watcher(
  overrides: Partial<AppAdvisorWatcherSummary> & { id: string },
): AppAdvisorWatcherSummary {
  return {
    trigger: 'worktree_chat_completion',
    status: 'active',
    label: overrides.id,
    target: {
      kind: 'worktree_chat',
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
    },
    destination: {
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
    },
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function run(
  overrides: Partial<ScheduledActivityRun> & { id: string; activityId: string },
): ScheduledActivityRun {
  return {
    activityName: overrides.activityId,
    scheduledFor: '2026-08-30T11:00:00.000Z',
    manual: false,
    status: 'success',
    startedAt: '2026-08-30T11:00:00.000Z',
    completedAt: '2026-08-30T11:00:05.000Z',
    ...overrides,
  };
}

describe('automation action scoping', () => {
  const cases: Array<{
    action: AutomationAction;
    workspaceId: string | undefined;
    worktreeId: string | undefined;
  }> = [
    {
      action: { type: 'app_advisor_prompt', prompt: 'x' },
      workspaceId: undefined,
      worktreeId: undefined,
    },
    {
      action: {
        type: 'standalone_prompt',
        chatProjectId: 'cowork-1',
        prompt: 'x',
      },
      workspaceId: 'cowork-1',
      worktreeId: undefined,
    },
    {
      action: { type: 'worktree_prompt', workspaceId: 'ws-1', prompt: 'x' },
      workspaceId: 'ws-1',
      worktreeId: undefined,
    },
    {
      action: {
        type: 'worktree_prompt',
        workspaceId: 'ws-1',
        baseWorktreeId: 'wt-base',
        prompt: 'x',
      },
      workspaceId: 'ws-1',
      // A base worktree is the source for a newly provisioned worktree, not
      // the worktree the automation will actually target.
      worktreeId: undefined,
    },
    {
      action: {
        type: 'worktree_prompt',
        workspaceId: 'ws-1',
        existingWorktreeId: 'wt-existing',
        prompt: 'x',
      },
      workspaceId: 'ws-1',
      worktreeId: 'wt-existing',
    },
    {
      action: {
        type: 'worktree_session_prompt',
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        prompt: 'x',
      },
      workspaceId: 'ws-1',
      worktreeId: 'wt-1',
    },
    {
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'ws-1',
        baseWorktreeId: 'wt-1',
        pipelineId: 'p-1',
      },
      workspaceId: 'ws-1',
      // Pipeline automations provision a fresh worktree from this base.
      worktreeId: undefined,
    },
    {
      action: {
        type: 'worktree_pipeline',
        target: { kind: 'task', taskId: 'wt-task' },
        workspaceId: 'ws-1',
        pipelineId: 'p-1',
      },
      workspaceId: 'ws-1',
      // An existing-task destination targets that task.
      worktreeId: 'wt-task',
    },
    {
      action: {
        type: 'worktree_pipeline',
        target: { kind: 'project' },
        workspaceId: 'ws-1',
        pipelineId: 'p-1',
      },
      workspaceId: 'ws-1',
      worktreeId: undefined,
    },
    {
      action: {
        type: 'worktree_pipeline',
        target: { kind: 'global' },
        // Inert compatibility data.
        workspaceId: 'ws-1',
        pipelineId: 'p-1',
      },
      workspaceId: undefined,
      worktreeId: undefined,
    },
    {
      action: {
        type: 'pipeline_execution_resume',
        executionId: 'exec-1',
        statusReasonIds: [],
        provider: 'claude',
        purpose: 'usage_limit_resume',
        pipelineName: 'Deploy',
        projectId: 'ws-1',
        worktreeId: 'wt-1',
      },
      workspaceId: 'ws-1',
      worktreeId: 'wt-1',
    },
  ];

  it.each(cases)(
    'derives workspace/worktree for $action.type',
    ({ action, workspaceId, worktreeId }) => {
      expect(automationActionWorkspaceId(action)).toBe(workspaceId);
      expect(automationActionWorktreeId(action)).toBe(worktreeId);
    },
  );

  it('filters activities by project and narrows to the worktree', () => {
    const inWorktree = activity({
      id: 'in-worktree',
      action: {
        type: 'worktree_prompt',
        workspaceId: 'ws-1',
        existingWorktreeId: 'wt-1',
        prompt: 'x',
      },
    });
    const workspaceOnly = activity({
      id: 'workspace-only',
      action: { type: 'worktree_prompt', workspaceId: 'ws-1', prompt: 'x' },
    });
    const basedOnWorktree = activity({
      id: 'based-on-worktree',
      action: {
        type: 'worktree_prompt',
        workspaceId: 'ws-1',
        baseWorktreeId: 'wt-1',
        prompt: 'x',
      },
    });
    const otherWorkspace = activity({
      id: 'other-workspace',
      action: { type: 'worktree_prompt', workspaceId: 'ws-2', prompt: 'x' },
    });
    const unscoped = activity({ id: 'unscoped' });
    const all = [
      inWorktree,
      workspaceOnly,
      basedOnWorktree,
      otherWorkspace,
      unscoped,
    ];

    expect(
      filterActivitiesForScope(all, {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        worktreeOnly: false,
      }).map((entry) => entry.id),
    ).toEqual(['in-worktree', 'workspace-only', 'based-on-worktree']);
    expect(
      filterActivitiesForScope(all, {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        worktreeOnly: true,
      }).map((entry) => entry.id),
    ).toEqual(['in-worktree']);
  });
});

describe('owned workflow scoping', () => {
  /**
   * A chat automation converted to a workflow it owns (CAN-4551 / CAN-5479)
   * is stored as a global pipeline. Once that workflow no longer shows as its
   * chat, the action stays global and the chat's workspace lives in the
   * inputs the conversion wrote.
   */
  function ownedWorkflow(
    id: string,
    inputs: Record<string, string>,
    owned = true,
  ): ScheduledActivity {
    const action: AutomationAction = {
      type: 'worktree_pipeline',
      target: { kind: 'global' },
      workspaceId: '',
      pipelineId: `${id}-pipeline`,
      pipelineSource: 'user',
      inputs,
    };
    return activity({
      id,
      action,
      ...(owned
        ? {
            ownedPipeline: {
              pipelineId: `${id}-pipeline`,
              chatEditable: false,
              storedAction: action,
            },
          }
        : {}),
    });
  }

  const inWorktree = ownedWorkflow('owned-in-worktree', {
    project_id: 'ws-1',
    task_id: 'wt-1',
    prompt: 'x',
  });
  const newWorktree = ownedWorkflow('owned-new-worktree', {
    project_id: 'ws-1',
    base_branch: 'main',
    prompt: 'x',
  });
  const otherWorkspace = ownedWorkflow('owned-other-workspace', {
    project_id: 'ws-2',
    task_id: 'wt-9',
    prompt: 'x',
  });
  const orchestrator = ownedWorkflow('owned-orchestrator', {
    bot_id: 'app_advisor',
    prompt: 'x',
  });
  const notOwned = ownedWorkflow(
    'global-not-owned',
    { project_id: 'ws-1', task_id: 'wt-1' },
    false,
  );
  const all = [inWorktree, newWorktree, otherWorkspace, orchestrator, notOwned];

  it('keeps an owned workflow in the workspace its inputs name', () => {
    expect(
      filterActivitiesForScope(all, {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        worktreeOnly: false,
      }).map((entry) => entry.id),
    ).toEqual(['owned-in-worktree', 'owned-new-worktree']);
  });

  it('narrows an owned workflow to the task its inputs name', () => {
    expect(
      filterActivitiesForScope(all, {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        worktreeOnly: true,
      }).map((entry) => entry.id),
    ).toEqual(['owned-in-worktree']);
  });

  it('scopes a watcher on an owned workflow to that workflow', () => {
    const automationWatcher = watcher({
      id: 'owned-watcher',
      trigger: 'automation_run',
      target: { kind: 'automation', automationId: 'owned-in-worktree' },
    });
    expect(
      filterWatchersForScope(
        [automationWatcher],
        { projectId: 'ws-1', worktreeId: 'wt-1', worktreeOnly: true },
        all,
      ).map((entry) => entry.id),
    ).toEqual(['owned-watcher']);
  });
});

describe('watcher target scoping', () => {
  it('derives workspace/worktree from scoped target kinds', () => {
    const scoped = watcher({ id: 'scoped' });
    expect(watcherTargetWorkspaceId(scoped)).toBe('ws-1');
    expect(watcherTargetWorktreeId(scoped)).toBe('wt-1');

    const automationTarget = watcher({
      id: 'automation-target',
      trigger: 'automation_run',
      target: { kind: 'automation', automationId: 'auto-1' },
    });
    expect(watcherTargetWorkspaceId(automationTarget)).toBeUndefined();
    expect(watcherTargetWorktreeId(automationTarget)).toBeUndefined();

    const standalone = watcher({
      id: 'standalone',
      trigger: 'standalone_chat_completion',
      target: { kind: 'standalone_chat', projectId: 'cowork-1', chatId: 'c1' },
    });
    expect(watcherTargetWorkspaceId(standalone)).toBe('cowork-1');
    expect(watcherTargetWorktreeId(standalone)).toBeUndefined();
  });

  it('filters watchers by project and narrows to the worktree', () => {
    const inWorktree = watcher({ id: 'in-worktree' });
    const otherWorktree = watcher({
      id: 'other-worktree',
      target: {
        kind: 'worktree_chat_scope',
        projectId: 'ws-1',
        worktreeId: 'wt-2',
      },
    });
    const otherWorkspace = watcher({
      id: 'other-workspace',
      target: {
        kind: 'worktree_chat_scope',
        projectId: 'ws-2',
        worktreeId: 'wt-1',
      },
    });
    const unscoped = watcher({
      id: 'unscoped',
      trigger: 'automation_run',
      target: { kind: 'automation', automationId: 'auto-1' },
    });
    const all = [inWorktree, otherWorktree, otherWorkspace, unscoped];

    expect(
      filterWatchersForScope(all, {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        worktreeOnly: false,
      }).map((entry) => entry.id),
    ).toEqual(['in-worktree', 'other-worktree']);
    expect(
      filterWatchersForScope(all, {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        worktreeOnly: true,
      }).map((entry) => entry.id),
    ).toEqual(['in-worktree']);
  });

  it('scopes automation-run watchers through the automation they observe', () => {
    const automationWatcher = watcher({
      id: 'automation-watcher',
      trigger: 'automation_run',
      target: { kind: 'automation', automationId: 'auto-1' },
    });
    const watchedAutomation = activity({
      id: 'auto-1',
      action: {
        type: 'worktree_prompt',
        workspaceId: 'ws-1',
        existingWorktreeId: 'wt-1',
        prompt: 'x',
      },
    });
    expect(
      filterWatchersForScope(
        [automationWatcher],
        {
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          worktreeOnly: true,
        },
        [watchedAutomation],
      ).map((entry) => entry.id),
    ).toEqual(['automation-watcher']);
  });
});

describe('buildUpcomingEntries', () => {
  it('includes everything inside the 10-minute window and pads to the minimum', () => {
    const activities = [
      oneTimeAt('soon-1', new Date(NOW.getTime() + 2 * 60_000).toISOString()),
      oneTimeAt('soon-2', new Date(NOW.getTime() + 9 * 60_000).toISOString()),
      oneTimeAt('later-1', new Date(NOW.getTime() + 60 * 60_000).toISOString()),
      oneTimeAt(
        'later-2',
        new Date(NOW.getTime() + 2 * 3_600_000).toISOString(),
      ),
      oneTimeAt(
        'later-3',
        new Date(NOW.getTime() + 3 * 3_600_000).toISOString(),
      ),
      oneTimeAt(
        'later-4',
        new Date(NOW.getTime() + 4 * 3_600_000).toISOString(),
      ),
    ];
    const entries = buildUpcomingEntries(activities, NOW);
    expect(entries).toHaveLength(UPCOMING_MIN_ENTRIES);
    expect(entries.map((entry) => entry.activity.id)).toEqual([
      'soon-1',
      'soon-2',
      'later-1',
      'later-2',
      'later-3',
    ]);
    expect(entries[0].withinSoonWindow).toBe(true);
    expect(entries[1].withinSoonWindow).toBe(true);
    expect(entries[2].withinSoonWindow).toBe(false);
  });

  it('shows every soon entry even beyond the minimum', () => {
    const activities = Array.from({ length: 8 }, (_, index) =>
      oneTimeAt(
        `soon-${index}`,
        new Date(NOW.getTime() + (index + 1) * 60_000).toISOString(),
      ),
    );
    const entries = buildUpcomingEntries(activities, NOW);
    expect(entries).toHaveLength(8);
    expect(entries.every((entry) => entry.withinSoonWindow)).toBe(true);
  });

  it('skips disabled activities and returns fewer than the minimum when little is scheduled', () => {
    const activities = [
      oneTimeAt('only', new Date(NOW.getTime() + 30 * 60_000).toISOString()),
      {
        ...oneTimeAt(
          'disabled',
          new Date(NOW.getTime() + 5 * 60_000).toISOString(),
        ),
        enabled: false,
      },
    ];
    const entries = buildUpcomingEntries(activities, NOW);
    expect(entries.map((entry) => entry.activity.id)).toEqual(['only']);
  });

  it('pads sparse recurring schedules with the next five fires beyond seven days', () => {
    const weekly = activity({
      id: 'weekly',
      schedule: { kind: 'cron', expression: '0 9 * * 1', timezone: 'local' },
      action: {
        type: 'worktree_prompt',
        workspaceId: 'ws-1',
        existingWorktreeId: 'wt-1',
        prompt: 'Go.',
      },
    });

    const entries = buildUpcomingEntries([weekly], NOW);

    expect(entries).toHaveLength(UPCOMING_MIN_ENTRIES);
    expect(entries.every((entry) => entry.activity.id === 'weekly')).toBe(true);
    expect(entries.every((entry) => !entry.withinSoonWindow)).toBe(true);
  });
});

describe('panel run feed scope', () => {
  const SCOPE = { projectId: 'ws-1', worktreeId: 'wt-1', worktreeOnly: true };
  const WHOLE_WORKSPACE = { ...SCOPE, worktreeOnly: false };

  function execution(
    id: string,
    overrides: Partial<ExecutionSummary> = {},
  ): ExecutionSummary {
    return {
      id,
      pipeline_id: 'release-checks',
      pipeline_name: 'Release checks',
      status: 'success',
      status_reasons: [],
      started_at: '2026-08-30T10:00:00.000Z',
      completed_at: '2026-08-30T10:02:00.000Z',
      cwd: '/tmp/ws-1',
      project_id: 'ws-1',
      worktree_id: 'wt-1',
      ...overrides,
    };
  }

  function panelRows(
    scope: typeof SCOPE,
    sources: Pick<
      RunFeedInput,
      'executions' | 'runs' | 'activities' | 'watchers'
    >,
  ): readonly WorkflowRunRow[] {
    return buildWorkflowRunRows({
      ...sources,
      ...panelRunFeedPredicates(scope, sources.activities),
      executionActions: () => [],
      automationRunResult: () => ({ available: true }),
      names: {
        project: () => undefined,
        worktree: () => undefined,
        chat: () => undefined,
        watcherDestination: () => undefined,
      },
    });
  }

  it("scopes pipeline runs to the workspace and the toggle's worktree", () => {
    const { executionInScope } = panelRunFeedPredicates(SCOPE, []);
    expect(executionInScope(execution('here'))).toBe(true);
    expect(
      executionInScope(execution('elsewhere', { worktree_id: 'wt-2' })),
    ).toBe(false);
    expect(executionInScope(execution('other', { project_id: 'ws-2' }))).toBe(
      false,
    );
    expect(
      executionInScope(execution('no-project', { project_id: undefined })),
    ).toBe(false);
    const whole = panelRunFeedPredicates(WHOLE_WORKSPACE, []);
    expect(
      whole.executionInScope(execution('elsewhere', { worktree_id: 'wt-2' })),
    ).toBe(true);
  });

  it('lists a watcher once its fire has finished', () => {
    const { watcherInScope } = panelRunFeedPredicates(SCOPE, []);
    expect(watcherInScope(watcher({ id: 'watching', status: 'active' }))).toBe(
      false,
    );
    expect(watcherInScope(watcher({ id: 'firing', status: 'firing' }))).toBe(
      false,
    );
    expect(
      watcherInScope(watcher({ id: 'failed', status: 'delivery_failed' })),
    ).toBe(true);
    expect(watcherInScope(watcher({ id: 'fired', status: 'fired' }))).toBe(
      true,
    );
  });

  it('scopes a run whose workflow is gone by where it ran', () => {
    const { orphanRunInScope } = panelRunFeedPredicates(SCOPE, []);
    expect(
      orphanRunInScope(
        run({
          id: 'by-result',
          activityId: 'gone',
          result: { projectId: 'ws-1', worktreeId: 'wt-1' },
        }),
      ),
    ).toBe(true);
    expect(
      orphanRunInScope(
        run({
          id: 'by-target',
          activityId: 'gone',
          target: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
        }),
      ),
    ).toBe(true);
    expect(
      orphanRunInScope(
        run({
          id: 'other-worktree',
          activityId: 'gone',
          target: { workspaceId: 'ws-1', worktreeId: 'wt-2' },
        }),
      ),
    ).toBe(false);
    expect(orphanRunInScope(run({ id: 'nowhere', activityId: 'gone' }))).toBe(
      false,
    );
  });

  it("lists the workspace's pipeline runs and folds a workflow's own run into its scheduled run", () => {
    const owned: AutomationAction = {
      type: 'worktree_pipeline',
      target: { kind: 'global' },
      workspaceId: '',
      pipelineId: 'owned-pipeline',
      pipelineSource: 'user',
      inputs: { project_id: 'ws-1', task_id: 'wt-1' },
    };
    const migrated = activity({
      id: 'migrated',
      action: owned,
      ownedPipeline: {
        pipelineId: 'owned-pipeline',
        chatEditable: false,
        storedAction: owned,
      },
    });
    const rows = panelRows(SCOPE, {
      activities: [migrated],
      runs: [
        run({
          id: 'migrated-run',
          activityId: 'migrated',
          result: { pipelineExecutionId: 'owned-exec' },
        }),
      ],
      executions: [
        execution('owned-exec', {
          project_id: undefined,
          worktree_id: undefined,
        }),
        execution('release-checks'),
        execution('other-workspace', { project_id: 'ws-2' }),
      ],
      watchers: [
        watcher({
          id: 'here',
          status: 'fired',
          firedAt: '2026-08-30T09:00:00.000Z',
        }),
        watcher({
          id: 'there',
          status: 'fired',
          target: {
            kind: 'worktree_chat',
            projectId: 'ws-2',
            worktreeId: 'wt-9',
            chatId: 'chat-9',
          },
        }),
      ],
    });
    expect(rows.map((row) => row.key).sort()).toEqual(
      [
        'automation-run:migrated-run',
        'pipeline-run:release-checks',
        'watcher:here',
      ].sort(),
    );
  });
});

describe('buildLibraryRows', () => {
  function projectPipeline(
    id: string,
    overrides: Partial<PipelineInfo> = {},
  ): PipelineInfo {
    return {
      id,
      name: id,
      filename: `${id}.yml`,
      description: '',
      icon: '',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      source: 'project',
      readonly: false,
      filePath: `/repo/.canopy/pipelines/${id}.yml`,
      ...overrides,
    };
  }

  const activities = [activity({ id: 'Daily digest' })];
  const pipelines = [
    projectPipeline('Release checks'),
    // Only the workspace's own pipelines belong in its panel.
    projectPipeline('Global lint', { source: 'user', filePath: undefined }),
  ];
  const watchers = [watcher({ id: 'Deploy watcher' })];

  it('lists scheduled workflows, then on-demand workflows, then watchers', () => {
    expect(
      buildLibraryRows({
        activities,
        pipelines,
        watchers,
        typeFilter: 'all',
        search: '',
      }).map((row) => row.kind),
    ).toEqual(['automation', 'pipeline', 'watcher']);
  });

  it('filters by type and by name', () => {
    const rows = (
      typeFilter: LibraryTypeFilter,
      search = '',
    ): readonly string[] =>
      buildLibraryRows({
        activities,
        pipelines,
        watchers,
        typeFilter,
        search,
      }).map((row) => row.kind);
    expect(rows('pipelines')).toEqual(['pipeline']);
    expect(rows('automations')).toEqual(['automation']);
    expect(rows('watchers')).toEqual(['watcher']);
    expect(rows('all', 'release')).toEqual(['pipeline']);
  });
});

describe('formatTimeUntil', () => {
  it('formats now/minutes/hours/days', () => {
    expect(formatTimeUntil(NOW, new Date(NOW.getTime() + 10_000))).toBe('now');
    expect(formatTimeUntil(NOW, new Date(NOW.getTime() + 3 * 60_000))).toBe(
      'in 3m',
    );
    expect(
      formatTimeUntil(
        NOW,
        new Date(NOW.getTime() + 2 * 3_600_000 + 15 * 60_000),
      ),
    ).toBe('in 2h 15m');
    expect(formatTimeUntil(NOW, new Date(NOW.getTime() + 3 * 3_600_000))).toBe(
      'in 3h',
    );
    expect(formatTimeUntil(NOW, new Date(NOW.getTime() + 49 * 3_600_000))).toBe(
      'in 2d',
    );
  });
});

describe('getAutomationNextRun', () => {
  it('derives from the trigger instead of stale persisted scheduler metadata', () => {
    const scheduled = oneTimeAt(
      'future',
      new Date(NOW.getTime() + 60 * 60_000).toISOString(),
    );
    scheduled.nextRunAt = '2000-01-01T00:00:00.000Z';

    expect(getAutomationNextRun(scheduled, NOW)?.toISOString()).toBe(
      new Date(NOW.getTime() + 60 * 60_000).toISOString(),
    );
    expect(
      getAutomationNextRun({ ...scheduled, enabled: false }, NOW),
    ).toBeNull();
  });
});
