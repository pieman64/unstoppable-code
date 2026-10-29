import type {
  AppAdvisorWatcherSummary,
  AutomationAction,
  ScheduledActivity,
  ScheduledActivityRun,
} from '@canopy/desktop-shared/types';
import {
  automationActionWorkspaceId,
  automationActionWorktreeId,
  buildCompletedEntries,
  buildUpcomingEntries,
  filterActivitiesForScope,
  filterWatchersForScope,
  formatTimeUntil,
  getAutomationNextRun,
  watcherTargetWorkspaceId,
  watcherTargetWorktreeId,
  UPCOMING_MIN_ENTRIES,
  COMPLETED_MAX_ENTRIES,
} from '../automations-panel-data';

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

describe('buildCompletedEntries', () => {
  it('merges runs and watcher fires newest first, dropping running and out-of-scope runs', () => {
    const scoped = [activity({ id: 'a-1' })];
    const runs = [
      run({
        id: 'r-old',
        activityId: 'a-1',
        completedAt: '2026-08-30T10:00:00.000Z',
      }),
      run({
        id: 'r-new',
        activityId: 'a-1',
        completedAt: '2026-08-30T11:30:00.000Z',
        status: 'failure',
      }),
      run({ id: 'r-running', activityId: 'a-1', status: 'running' }),
      run({ id: 'r-foreign', activityId: 'a-other' }),
    ];
    const fires = [
      watcher({
        id: 'w-fired',
        status: 'fired',
        firedAt: '2026-08-30T11:00:00.000Z',
      }),
      watcher({
        id: 'w-failed',
        status: 'delivery_failed',
        firedAt: '2026-08-30T11:45:00.000Z',
      }),
    ];
    const entries = buildCompletedEntries(runs, scoped, fires);
    expect(entries.map((entry) => entry.key)).toEqual([
      'watcher:w-failed',
      'run:r-new',
      'watcher:w-fired',
      'run:r-old',
    ]);
    expect(entries[0]).toMatchObject({
      kind: 'watcher-fire',
      status: 'failure',
    });
    expect(entries[1]).toMatchObject({
      kind: 'automation-run',
      status: 'failure',
    });
    expect(entries[2]).toMatchObject({
      kind: 'watcher-fire',
      status: 'success',
    });
  });

  it('leaves watchers whose delivery is still pending out of history', () => {
    const entries = buildCompletedEntries(
      [],
      [activity({ id: 'a-1' })],
      [
        watcher({ id: 'w-firing', status: 'firing' }),
        watcher({
          id: 'w-fired',
          status: 'fired',
          firedAt: '2026-08-30T11:00:00.000Z',
        }),
      ],
    );

    expect(entries.map((entry) => entry.key)).toEqual(['watcher:w-fired']);
  });

  it('orders failed watchers by their projected completion time', () => {
    const failed = Object.assign(
      watcher({
        id: 'failed-recently',
        status: 'delivery_failed',
        createdAt: '2026-08-01T00:00:00.000Z',
      }),
      { completedAt: '2026-08-30T11:45:00.000Z' },
    );
    const entries = buildCompletedEntries(
      [
        run({
          id: 'run-before-failure',
          activityId: 'a-1',
          completedAt: '2026-08-30T11:30:00.000Z',
        }),
      ],
      [activity({ id: 'a-1' })],
      [failed],
    );

    expect(entries.map((entry) => entry.key)).toEqual([
      'watcher:failed-recently',
      'run:run-before-failure',
    ]);
  });

  it('caps the merged list', () => {
    const scoped = [activity({ id: 'a-1' })];
    const runs = Array.from(
      { length: COMPLETED_MAX_ENTRIES + 10 },
      (_, index) =>
        run({
          id: `r-${index}`,
          activityId: 'a-1',
          completedAt: new Date(
            Date.parse('2026-08-30T00:00:00.000Z') + index * 60_000,
          ).toISOString(),
        }),
    );
    expect(buildCompletedEntries(runs, scoped, [])).toHaveLength(
      COMPLETED_MAX_ENTRIES,
    );
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
