import type { HookAction, HookOverrides } from '@canopy/desktop-shared/hooks';
import type {
  AppAdvisorWatcherSummary,
  AutomationAction,
  ScheduledActivity,
  ScheduledActivityRun,
  SidebarItem,
} from '@canopy/desktop-shared/types';
import type {
  ExecutionSummary,
  PipelineInfo,
} from '@canopy/desktop-shared/types/pipeline';
import type { WorkflowRunRow } from '@canopy/ui-app/workflows';
import { projectLibraryRows } from '../library-projection';
import {
  automationsRunningPipeline,
  hooksRunningPipeline,
  pipelineStartKinds,
  runsForPipeline,
} from '../pipeline-automations';
import { buildWorkflowRunRows } from '../run-feed';

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
    schedule: { kind: 'cron', expression: '0 9 * * 1-5', timezone: 'local' },
    action,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-05T00:00:00.000Z',
    failureCount: 0,
    ...overrides,
  };
}

function pipeline(
  id: string,
  overrides: Partial<PipelineInfo> = {},
): PipelineInfo {
  return {
    id,
    name: `Pipeline ${id}`,
    filename: `${id}.yaml`,
    description: '',
    icon: '',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    source: 'user',
    readonly: false,
    ...overrides,
  };
}

function pipelineAction(
  pipelineId: string,
  pipelineSource?: PipelineInfo['source'],
): AutomationAction {
  return {
    type: 'worktree_pipeline',
    workspaceId: 'storefront',
    pipelineId,
    ...(pipelineSource ? { pipelineSource } : {}),
  };
}

const CHAT_ACTION: AutomationAction = {
  type: 'standalone_prompt',
  chatProjectId: 'storefront',
  prompt: 'Triage new tickets',
};

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
  pipelineId: string,
  overrides: Partial<ExecutionSummary> = {},
): ExecutionSummary {
  return {
    id,
    pipeline_id: pipelineId,
    pipeline_name: pipelineId,
    status: 'success',
    status_reasons: [],
    started_at: '2026-10-12T02:00:05.000Z',
    completed_at: '2026-10-12T02:14:08.000Z',
    cwd: '/tmp/storefront',
    ...overrides,
  };
}

const WATCHER: AppAdvisorWatcherSummary = {
  target: {
    kind: 'worktree_chat',
    projectId: 'canopy',
    worktreeId: 'main',
    chatId: 'inbox',
  },
  destination: { projectId: 'canopy', worktreeId: 'main', chatId: 'inbox' },
  id: 'watcher-1',
  trigger: 'worktree_chat_completion',
  status: 'active',
  label: 'Watch the inbox',
  createdAt: '2026-10-12T09:40:00.000Z',
};

function feed(input: {
  readonly activities?: readonly ScheduledActivity[];
  readonly runs?: readonly ScheduledActivityRun[];
  readonly executions?: readonly ExecutionSummary[];
  readonly watchers?: readonly AppAdvisorWatcherSummary[];
}): readonly WorkflowRunRow[] {
  return buildWorkflowRunRows({
    executions: input.executions ?? [],
    runs: input.runs ?? [],
    activities: input.activities ?? [],
    watchers: input.watchers ?? [],
    activityInScope: () => true,
    orphanRunInScope: () => true,
    executionInScope: () => true,
    watcherInScope: () => true,
    executionActions: () => ['rerun'],
    automationRunResult: () => ({ available: true }),
    names: {
      project: () => undefined,
      worktree: () => undefined,
      chat: () => undefined,
      watcherDestination: () => undefined,
    },
  });
}

const DEPS = pipeline('deps', { name: 'Dependency check' });
const SHARED_DEPS = pipeline('deps', {
  source: 'shared',
  remoteId: 'remote-deps',
  name: 'Shared dependency check',
});
const RELEASE = pipeline('release', { name: 'Release' });
const PIPELINES = [DEPS, SHARED_DEPS, RELEASE];

describe('automationsRunningPipeline', () => {
  it('lists the automations that run the pipeline, by name', () => {
    const activities = [
      activity('b', pipelineAction('deps', 'user'), { name: 'Nightly triage' }),
      activity('a', pipelineAction('deps', 'user'), {
        name: 'Release check',
        enabled: false,
      }),
      activity('c', pipelineAction('release', 'user'), { name: 'Other' }),
      activity('d', CHAT_ACTION, { name: 'Chat' }),
    ];
    const rows = automationsRunningPipeline(activities, DEPS, {
      pipelines: PIPELINES,
      locale: 'en-US',
    });
    expect(
      rows.map((row) => [row.activity.id, row.activity.name, row.enabled]),
    ).toEqual([
      ['b', 'Nightly triage', true],
      ['a', 'Release check', false],
    ]);
  });

  it('shows the same schedule text as the Library row', () => {
    const activities = [
      activity('cron', pipelineAction('deps', 'user')),
      activity('once', pipelineAction('deps', 'user'), {
        schedule: {
          kind: 'one_time',
          runAt: '2026-10-20T16:00:00.000Z',
          timezone: 'local',
        },
      }),
    ];
    const library = projectLibraryRows({
      activities,
      recentRuns: [],
      pipelines: PIPELINES,
      disabledPipelineIds: new Set(),
      executions: [],
      sharedAutomations: [],
      now: Date.parse('2026-10-14T12:00:00.000Z'),
      locale: 'en-US',
      nextRun: () => null,
      projectName: () => undefined,
      chatTitle: () => undefined,
    });
    const libraryText = new Map(
      library.map((row) => [row.key, row.triggerText]),
    );
    const rows = automationsRunningPipeline(activities, DEPS, {
      pipelines: PIPELINES,
      locale: 'en-US',
    });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.scheduleText).toBe(
        libraryText.get(`automation:${row.activity.id}`),
      );
    }
    expect(
      rows.find((row) => row.activity.id === 'cron')?.scheduleText,
    ).not.toBe('0 9 * * 1-5');
  });

  it('tells same-id pipelines apart by the recorded source', () => {
    const activities = [
      activity('mine', pipelineAction('deps', 'user')),
      activity('shared', pipelineAction('deps', 'shared')),
    ];
    const options = { pipelines: PIPELINES };
    expect(
      automationsRunningPipeline(activities, DEPS, options).map(
        (row) => row.activity.id,
      ),
    ).toEqual(['mine']);
    expect(
      automationsRunningPipeline(activities, SHARED_DEPS, options).map(
        (row) => row.activity.id,
      ),
    ).toEqual(['shared']);
  });

  it('gives an automation with no recorded source to the first listed match, as the Library does', () => {
    const activities = [activity('legacy', pipelineAction('deps'))];
    expect(
      automationsRunningPipeline(activities, DEPS, { pipelines: PIPELINES }),
    ).toHaveLength(1);
    expect(
      automationsRunningPipeline(activities, SHARED_DEPS, {
        pipelines: PIPELINES,
      }),
    ).toEqual([]);
  });

  it('matches a different copy of the same listed pipeline', () => {
    const activities = [activity('a', pipelineAction('deps', 'user'))];
    expect(
      automationsRunningPipeline(
        activities,
        { ...DEPS },
        { pipelines: PIPELINES },
      ),
    ).toHaveLength(1);
  });

  it('lists nothing when no automation runs the pipeline', () => {
    expect(
      automationsRunningPipeline([activity('a', CHAT_ACTION)], RELEASE, {
        pipelines: PIPELINES,
      }),
    ).toEqual([]);
  });
});

describe('runsForPipeline', () => {
  it("keeps the pipeline's executions and the automation runs that started them", () => {
    const activities = [
      activity('nightly', pipelineAction('deps', 'user')),
      activity('release-check', pipelineAction('release', 'user')),
      activity('chat', CHAT_ACTION),
    ];
    const executions = [
      execution('exec-manual', 'deps', {
        started_at: '2026-10-11T02:00:00.000Z',
        completed_at: '2026-10-11T02:10:00.000Z',
      }),
      execution('exec-nightly', 'deps'),
      execution('exec-release', 'release'),
      execution('exec-other', 'release', {
        started_at: '2026-10-10T02:00:00.000Z',
        completed_at: '2026-10-10T02:10:00.000Z',
      }),
    ];
    const runs = [
      run('run-nightly', 'nightly', {
        result: { pipelineExecutionId: 'exec-nightly' },
      }),
      run('run-skipped', 'nightly', {
        status: 'skipped',
        skipReason: 'if_command_exit',
        startedAt: '2026-10-09T02:00:00.000Z',
        completedAt: '2026-10-09T02:00:01.000Z',
      }),
      run('run-release', 'release-check', {
        result: { pipelineExecutionId: 'exec-release' },
      }),
      run('run-chat', 'chat'),
    ];
    const rows = feed({ activities, runs, executions, watchers: [WATCHER] });
    const kept = runsForPipeline(rows, DEPS, {
      pipelines: PIPELINES,
      activities,
      executions,
    });
    expect(kept.map((row) => row.key)).toEqual(
      rows
        .filter(
          (row) =>
            row.key === 'automation-run:run-nightly' ||
            row.key === 'pipeline-run:exec-manual',
        )
        .map((row) => row.key),
    );
    expect(kept).toHaveLength(2);
  });

  it('falls back to the automation target once the execution is no longer kept', () => {
    const activities = [
      activity('nightly', pipelineAction('deps', 'user')),
      activity('release-check', pipelineAction('release', 'user')),
    ];
    const runs = [
      run('run-nightly', 'nightly', {
        result: { pipelineExecutionId: 'exec-gone' },
      }),
      run('run-release', 'release-check', {
        result: { pipelineExecutionId: 'exec-gone-too' },
      }),
    ];
    const rows = feed({ activities, runs });
    expect(
      runsForPipeline(rows, DEPS, {
        pipelines: PIPELINES,
        activities,
        executions: [],
      }).map((row) => row.key),
    ).toEqual(['automation-run:run-nightly']);
  });

  it('drops a run of a deleted automation whose execution is no longer kept', () => {
    const rows: readonly WorkflowRunRow[] = [
      {
        kind: 'automation',
        key: 'automation-run:run-orphan',
        runId: 'run-orphan',
        activityId: 'deleted',
        name: 'Deleted',
        status: 'success',
        actions: [],
        linkedExecutionId: 'exec-gone',
        cancellable: false,
        result: { available: false },
      },
    ];
    expect(
      runsForPipeline(rows, DEPS, {
        pipelines: PIPELINES,
        activities: [],
        executions: [],
      }),
    ).toEqual([]);
  });

  it('uses the execution when the automation now runs another pipeline', () => {
    // The run started `deps` before the automation was pointed at `release`.
    const activities = [activity('moved', pipelineAction('release', 'user'))];
    const executions = [execution('exec-old', 'deps')];
    const rows: readonly WorkflowRunRow[] = [
      {
        kind: 'automation',
        key: 'automation-run:run-old',
        runId: 'run-old',
        activityId: 'moved',
        name: 'Moved',
        status: 'success',
        actions: [],
        linkedExecutionId: 'exec-old',
        cancellable: false,
        result: { available: true },
      },
    ];
    const options = { pipelines: PIPELINES, activities, executions };
    expect(runsForPipeline(rows, DEPS, options)).toHaveLength(1);
    expect(runsForPipeline(rows, RELEASE, options)).toEqual([]);
  });

  it('tells same-id pipelines apart by the automation source', () => {
    const activities = [activity('shared', pipelineAction('deps', 'shared'))];
    const executions = [execution('exec-shared', 'deps')];
    const runs = [
      run('run-shared', 'shared', {
        result: { pipelineExecutionId: 'exec-shared' },
      }),
    ];
    const rows = feed({ activities, runs, executions });
    const options = { pipelines: PIPELINES, activities, executions };
    expect(runsForPipeline(rows, DEPS, options)).toEqual([]);
    expect(
      runsForPipeline(rows, SHARED_DEPS, options).map((row) => row.key),
    ).toEqual(['automation-run:run-shared']);
  });
});

describe('pipelineStartKinds', () => {
  it('maps each declared trigger, and reads none as Manual', () => {
    expect(pipelineStartKinds(['dispatch', 'plan_ready'])).toEqual([
      'manual',
      'plan-approved',
    ]);
    expect(pipelineStartKinds(['task_ready'])).toEqual(['task-ready']);
    expect(pipelineStartKinds(undefined)).toEqual(['manual']);
    expect(pipelineStartKinds([])).toEqual(['manual']);
  });
});

function pipelineHook(
  source: 'bundled' | 'local' | 'project' | 'curated',
  id: string,
): HookAction {
  return { type: 'pipeline', source, id };
}

function singleRepo(
  id: string,
  hooks: HookOverrides,
  overrides: Partial<Extract<SidebarItem, { type: 'single-repo' }>> = {},
): SidebarItem {
  return {
    type: 'single-repo',
    id,
    name: `Project ${id}`,
    repoPath: `/repos/${id}`,
    color: '#000000',
    worktrees: [],
    collapsed: false,
    order: 0,
    effectiveHooks: hooks,
    ...overrides,
  };
}

describe('hooksRunningPipeline', () => {
  it('lists the hooks in every project that run a pipeline by its source', () => {
    const projects = [
      singleRepo('storefront', {
        'pr:checks:fail': [
          { type: 'command', command: 'echo deps' },
          pipelineHook('local', 'deps'),
        ],
        'pr:create': [pipelineHook('bundled', 'deps')],
        'pr:merged': [pipelineHook('local', 'other')],
      }),
      singleRepo('api', { 'pr:merged': [pipelineHook('local', 'deps')] }),
    ];

    expect(
      hooksRunningPipeline(projects, pipeline('deps')).map((row) => [
        row.projectId,
        row.eventLabel,
        row.where,
      ]),
    ).toEqual([
      ['api', 'PR Merged', 'Project api'],
      ['storefront', 'PR Check Failed', 'Project storefront'],
    ]);
    expect(
      hooksRunningPipeline(projects, pipeline('deps', { source: 'bundled' })),
    ).toHaveLength(1);
  });

  it('lists a hook once when a worktree resolves the same hook', () => {
    const hooks: HookOverrides = {
      'pr:create': [pipelineHook('local', 'deps')],
    };
    const projects = [
      singleRepo('storefront', hooks, {
        worktreeEffective: {
          main: { effectiveHooks: hooks },
          feature: {
            effectiveHooks: {
              ...hooks,
              'pr:merged': [pipelineHook('local', 'deps')],
            },
          },
        },
      }),
    ];

    expect(
      hooksRunningPipeline(projects, pipeline('deps')).map(
        (row) => row.eventLabel,
      ),
    ).toEqual(['PR Created', 'PR Merged']);
  });

  it("names a multi-repo project's repository", () => {
    const projects: SidebarItem[] = [
      {
        type: 'multi-repo',
        id: 'suite',
        name: 'Suite',
        color: '#000000',
        worktrees: [],
        collapsed: false,
        order: 0,
        repos: [
          {
            id: 'web',
            name: 'web',
            repoPath: '/repos/suite/web',
            effectiveHooks: { 'pr:create': [pipelineHook('local', 'deps')] },
          },
        ],
        effectiveHooks: { 'pr:merged': [pipelineHook('local', 'deps')] },
      },
    ];

    expect(
      hooksRunningPipeline(projects, pipeline('deps')).map((row) => row.where),
    ).toEqual(['Suite', 'Suite · web']);
  });

  it("keeps a project pipeline's hooks to the project its file is in", () => {
    const hooks: HookOverrides = {
      'pr:create': [pipelineHook('project', 'review.yaml')],
    };
    const projects = [
      singleRepo('storefront', hooks),
      singleRepo('api', hooks),
    ];
    const review = pipeline('project--review.yaml', {
      source: 'project',
      filename: 'review.yaml',
      filePath: '/repos/api/.canopy/pipelines/review.yaml',
    });

    expect(
      hooksRunningPipeline(projects, review).map((row) => row.projectId),
    ).toEqual(['api']);
    // A checkout outside every project's repository says nothing about which
    // project it is, so each project's hook for that path is listed.
    expect(
      hooksRunningPipeline(projects, {
        ...review,
        filePath: '/worktrees/feature/.canopy/pipelines/review.yaml',
      }).map((row) => row.projectId),
    ).toEqual(['api', 'storefront']);
  });

  it('skips a hook a local override turned off', () => {
    const projects = [singleRepo('storefront', { 'pr:create': null })];
    expect(hooksRunningPipeline(projects, pipeline('deps'))).toEqual([]);
  });
});
