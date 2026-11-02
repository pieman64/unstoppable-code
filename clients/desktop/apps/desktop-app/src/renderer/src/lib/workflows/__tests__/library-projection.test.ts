import type {
  AutomationAction,
  ScheduledActivity,
  ScheduledActivityRun,
} from '@canopy/desktop-shared/types';
import type {
  ExecutionSummary,
  PipelineInfo,
} from '@canopy/desktop-shared/types/pipeline';
import type { WorkflowLibraryRow } from '@canopy/ui-app/workflows';
import {
  projectLibraryRows,
  type LibraryProjectionInput,
} from '../library-projection';

const NOW = new Date(2026, 9, 12, 12, 0, 0).getTime();
const NEXT = new Date(2026, 9, 13, 2, 0, 0);

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
    started_at: '2026-10-11T02:00:00.000Z',
    completed_at: '2026-10-11T02:10:00.000Z',
    cwd: '/tmp/x',
    ...overrides,
  };
}

function runningRun(activityId: string): ScheduledActivityRun {
  return {
    id: `run-${activityId}`,
    activityId,
    activityName: activityId,
    scheduledFor: '2026-10-12T02:00:00.000Z',
    manual: false,
    status: 'running',
    startedAt: '2026-10-12T02:00:00.000Z',
  };
}

function project(
  overrides: Partial<LibraryProjectionInput> = {},
): readonly WorkflowLibraryRow[] {
  return projectLibraryRows({
    activities: [],
    recentRuns: [],
    pipelines: [],
    disabledPipelineIds: new Set(),
    executions: [],
    sharedAutomations: [],
    now: NOW,
    locale: 'en-US',
    nextRun: (candidate) => (candidate.enabled ? NEXT : null),
    projectName: (id) => (id === 'storefront' ? 'storefront' : undefined),
    chatTitle: (_project, _worktree, id) =>
      id === 'chat-1' ? 'Checkout form validation' : undefined,
    ...overrides,
  });
}

function only(rows: readonly WorkflowLibraryRow[]): WorkflowLibraryRow {
  const [row] = rows;
  if (!row || rows.length !== 1) {
    throw new Error(`Expected one row, got ${String(rows.length)}`);
  }
  return row;
}

const PIPELINE_ACTION: AutomationAction = {
  type: 'worktree_pipeline',
  workspaceId: 'storefront',
  pipelineId: 'deps',
  pipelineSource: 'user',
  pipelineName: 'Dependency check',
};

const RESUME_ACTION: AutomationAction = {
  type: 'pipeline_execution_resume',
  executionId: 'e',
  statusReasonIds: [],
  provider: 'claude',
  purpose: 'usage_limit_resume',
  pipelineName: 'Release',
};

describe('automation rows', () => {
  it('describes a cron trigger in plain language and falls back to the expression', () => {
    expect(
      only(
        project({
          activities: [
            activity('a', { type: 'app_advisor_prompt', prompt: 'x' }),
          ],
        }),
      ).triggerText,
    ).toBe('Every day at 02:00');
    const raw = only(
      project({
        activities: [
          activity(
            'a',
            { type: 'app_advisor_prompt', prompt: 'x' },
            {
              schedule: {
                kind: 'cron',
                expression: '*/7 3 1 2 *',
                timezone: 'local',
              },
            },
          ),
        ],
      }),
    );
    expect(raw.triggerText).toBe('*/7 3 1 2 *');
    expect(raw.triggers).toEqual(['schedule']);
  });

  it('shows a one-time trigger as its date, with no next run once it has passed', () => {
    const row = only(
      project({
        activities: [
          activity(
            'a',
            { type: 'app_advisor_prompt', prompt: 'x' },
            {
              schedule: {
                kind: 'one_time',
                runAt: new Date(2026, 9, 2, 10, 30).toISOString(),
                timezone: 'local',
              },
            },
          ),
        ],
        nextRun: () => null,
      }),
    );
    expect(row.triggers).toEqual(['once']);
    expect(row.triggerText).toBe('Oct 2 at 10:30 AM');
    expect(row.nextRunAt).toBeUndefined();
  });

  it.each([
    [
      'app_advisor_prompt',
      { type: 'app_advisor_prompt', prompt: 'x' },
      ['advisor'],
      'Ask Orchestrator',
    ],
    [
      'standalone_prompt',
      { type: 'standalone_prompt', chatProjectId: 'storefront', prompt: 'x' },
      ['chat'],
      'Start chat in storefront',
    ],
    [
      'worktree_prompt',
      { type: 'worktree_prompt', workspaceId: 'unknown', prompt: 'x' },
      ['chat'],
      'Start chat',
    ],
    [
      'worktree_session_prompt',
      {
        type: 'worktree_session_prompt',
        workspaceId: 'storefront',
        worktreeId: 'main',
        chatId: 'chat-1',
        prompt: 'x',
      },
      ['message'],
      'Send message to Checkout form validation',
    ],
    [
      'pipeline_execution_resume',
      RESUME_ACTION,
      ['pipeline'],
      'Resume Release',
    ],
  ] as const)(
    'builds the chain and destination for %s',
    (_name, action, steps, summary) => {
      const row = only(project({ activities: [activity('a', action)] }));
      expect(row.steps).toEqual(steps);
      expect(row.summary).toBe(summary);
      expect(row.kind).toBe('automation');
    },
  );

  it("shows the target pipeline's steps, after the gate when there is an If command", () => {
    const rows = project({
      activities: [activity('a', PIPELINE_ACTION, { ifCommand: 'test -f x' })],
      pipelines: [pipeline('deps', { name: 'Dependency check' })],
      pipelineSteps: () => ['agent', 'script', 'agent', 'input'],
    });
    const automation = rows.find((row) => row.kind === 'automation');
    expect(automation?.steps).toEqual([
      'gate',
      'agent',
      'script',
      'agent',
      'input',
    ]);
    expect(automation?.summary).toBe('4 steps');
    // No folding: the pipeline keeps its own row.
    expect(rows.filter((row) => row.kind === 'pipeline')).toHaveLength(1);
  });

  it('shows the pipeline name alone when its definition is not loaded', () => {
    const row = project({
      activities: [activity('a', PIPELINE_ACTION)],
      pipelines: [pipeline('deps', { name: 'Dependency check' })],
    }).find((candidate) => candidate.kind === 'automation');
    expect(row?.steps).toEqual(['pipeline']);
    expect(row?.summary).toBe('Dependency check');
    expect(row?.attention).toBeUndefined();
  });

  it('flags a missing target pipeline, matching source as well as id', () => {
    const row = only(project({ activities: [activity('a', PIPELINE_ACTION)] }));
    expect(row.summary).toBe('Dependency check');
    expect(row.attention).toBe('The workflow it runs is missing');
    // Same id in another source is a different pipeline.
    const otherSource = project({
      activities: [activity('a', PIPELINE_ACTION)],
      pipelines: [pipeline('deps', { source: 'bundled', readonly: true })],
    }).find((candidate) => candidate.kind === 'automation');
    expect(otherSource?.attention).toBe('The workflow it runs is missing');
  });

  it('orders the attention lines: review, missing pipeline, target, failures', () => {
    const attention = (
      overrides: Partial<ScheduledActivity>,
      input: Partial<LibraryProjectionInput> = {},
    ): string | undefined =>
      only(
        project({
          activities: [
            activity(
              'a',
              { type: 'app_advisor_prompt', prompt: 'x' },
              overrides,
            ),
          ],
          ...input,
        }),
      ).attention;
    expect(attention({})).toBeUndefined();
    expect(attention({ failureCount: 1 })).toBe('The last run failed');
    expect(attention({ failureCount: 3 })).toBe('Failed the last 3 runs');
    expect(
      attention(
        { failureCount: 3 },
        { targetUnavailable: () => 'Chat target is unavailable' },
      ),
    ).toBe('Chat target is unavailable');
    expect(
      attention({
        failureCount: 3,
        sharedPipelineReview: {
          detectedAt: '2026-10-10T00:00:00.000Z',
          remoteId: 'r',
        },
      }),
    ).toBe('Review needed: the shared workflow changed');
  });

  it('reads last run from a running run first, then the last result', () => {
    const base = activity(
      'a',
      { type: 'app_advisor_prompt', prompt: 'x' },
      {
        lastResult: {
          status: 'failure',
          completedAt: '2026-10-12T02:14:00.000Z',
        },
      },
    );
    expect(only(project({ activities: [base] })).lastRun).toEqual({
      state: 'failure',
      at: Date.parse('2026-10-12T02:14:00.000Z'),
    });
    expect(
      only(project({ activities: [base], recentRuns: [runningRun('a')] }))
        .lastRun,
    ).toEqual({ state: 'running' });
    expect(
      only(
        project({
          activities: [
            activity('never', { type: 'app_advisor_prompt', prompt: 'x' }),
          ],
        }),
      ).lastRun,
    ).toBeUndefined();
  });

  it('gives a switched-off automation no next run and keeps its project', () => {
    const row = only(
      project({
        activities: [activity('a', PIPELINE_ACTION, { enabled: false })],
        pipelines: [],
      }),
    );
    expect(row.enabled).toBe(false);
    expect(row.nextRunAt).toBeUndefined();
    expect(row.projectId).toBe('storefront');
    expect(row.projectName).toBe('storefront');
    const on = only(
      project({
        activities: [
          activity('a', { type: 'app_advisor_prompt', prompt: 'x' }),
        ],
      }),
    );
    expect(on.nextRunAt).toBe(NEXT.getTime());
    expect(on.projectId).toBeUndefined();
    expect(on.actions).toEqual([
      'toggle',
      'run',
      'edit',
      'view-runs',
      'share',
      'delete',
    ]);
  });

  it('keeps several automations on one pipeline as separate rows with distinct ids', () => {
    const rows = project({
      activities: [
        activity('nightly', PIPELINE_ACTION, { name: 'Dependency check' }),
        activity('friday', PIPELINE_ACTION, { name: 'Dependency check' }),
      ],
      pipelines: [pipeline('deps', { name: 'Dependency check' })],
    });
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.key)).size).toBe(3);
  });
});

describe('automation row actions', () => {
  it('does not offer Share on a usage-limit resume', () => {
    const row = only(
      project({
        activities: [
          activity('a', {
            type: 'pipeline_execution_resume',
            executionId: 'e',
            statusReasonIds: [],
            provider: 'claude',
            purpose: 'usage_limit_resume',
            pipelineName: 'Release',
          }),
        ],
      }),
    );
    expect(row.actions).toEqual([
      'toggle',
      'run',
      'edit',
      'view-runs',
      'delete',
    ]);
  });
});

describe('pipeline rows', () => {
  // CAN-4551: a converted automation's own pipeline folds into its row,
  // which reads as the chat it starts.
  it('folds a pipeline an automation owns into the automation’s row', () => {
    const converted = activity(
      'a',
      { type: 'standalone_prompt', chatProjectId: 'storefront', prompt: 'x' },
      {
        ownedPipeline: {
          pipelineId: 'owned-1',
          chatEditable: true,
          storedAction: {
            type: 'standalone_prompt',
            chatProjectId: 'storefront',
            prompt: 'x',
          },
        },
      },
    );
    const rows = project({
      activities: [converted],
      pipelines: [pipeline('owned-1'), pipeline('mine')],
      ownedPipelineIds: new Set(['owned-1']),
    });
    expect(rows.map((row) => row.name)).toEqual([
      'Activity a',
      'Pipeline mine',
    ]);
    expect(rows[0]?.summary).toContain('Start chat in storefront');
  });
  it('lets the search reach a description the row does not show', () => {
    const row = only(
      project({
        pipelines: [pipeline('zephyr', { description: 'Nightly sweep' })],
      }),
    );
    expect(row.searchText).toBe('Nightly sweep');
    expect(only(project({ pipelines: [pipeline('plain')] })).searchText).toBe(
      undefined,
    );
  });

  it.each([
    [undefined, ['manual'], 'Manual', true],
    [['dispatch'], ['manual'], 'Manual', true],
    [['plan_ready'], ['plan-approved'], 'When a plan is approved', false],
    [
      ['plan_ready', 'task_ready'],
      ['plan-approved', 'task-ready'],
      'When a plan is approved or a task is ready',
      false,
    ],
    [
      ['dispatch', 'task_ready'],
      ['manual', 'task-ready'],
      'Manual, or when a task is ready',
      true,
    ],
  ] as const)(
    'names the trigger for %j',
    (triggerTypes, triggers, text, runnable) => {
      const row = only(
        project({
          pipelines: [
            pipeline('p', {
              triggerTypes: triggerTypes ? [...triggerTypes] : undefined,
            }),
          ],
        }),
      );
      expect(row.triggers).toEqual(triggers);
      expect(row.triggerText).toBe(text);
      expect(row.actions.includes('run')).toBe(runnable);
      expect(row.runUnavailableLabel === undefined).toBe(runnable);
    },
  );

  it('labels each source and applies its permissions', () => {
    const rows = project({
      currentProjectId: 'storefront',
      pipelines: [
        pipeline('mine'),
        pipeline('builtin', { source: 'bundled', readonly: true }),
        pipeline('curated', { source: 'curated', readonly: true }),
        pipeline('proj', {
          source: 'project',
          filePath: '.canopy/pipelines/proj.yaml',
        }),
        pipeline('shared-team', {
          source: 'shared',
          readonly: true,
          remoteId: 'r-team',
          shareScope: 'team',
          owner: {
            type: 'organization',
            id: 'o1',
            name: 'Acme',
          },
        }),
        pipeline('shared-person', {
          source: 'shared',
          readonly: true,
          remoteId: 'r-person',
          canUpdate: true,
          canDelete: true,
          owner: { type: 'user', id: 'u1', name: 'Dana Lee' },
        }),
      ],
    });
    const byName = new Map(rows.map((row) => [row.name, row]));
    const mine = byName.get('Pipeline mine');
    expect(mine?.source).toBe('mine');
    expect(mine?.sourceLabel).toBeUndefined();
    expect(mine?.actions).toContain('delete');
    // Your own pipeline is edited in place; the others are copied to change.
    expect(mine?.actions).not.toContain('duplicate');
    expect(byName.get('Pipeline builtin')?.actions).toContain('duplicate');
    expect(byName.get('Pipeline builtin')?.sourceLabel).toBe('Built-in');
    expect(byName.get('Pipeline builtin')?.actions).not.toContain('delete');
    expect(byName.get('Pipeline curated')?.source).toBe('built-in');
    const proj = byName.get('Pipeline proj');
    expect(proj?.sourceLabel).toBe('From project');
    expect(proj?.projectId).toBe('storefront');
    const team = byName.get('Pipeline shared-team');
    expect(team?.sourceLabel).toBe('Shared by Acme');
    expect(team?.sourceIsPerson).toBeUndefined();
    expect(team?.actions).not.toContain('delete');
    expect(team?.actions).not.toContain('share');
    // A team share has no public link, but members can open its lander.
    expect(team?.actions).toContain('copy-link');
    expect(mine?.actions).not.toContain('copy-link');
    const person = byName.get('Pipeline shared-person');
    expect(person?.sourceLabel).toBe('Shared by Dana Lee');
    expect(person?.sourceIsPerson).toBe(true);
    expect(person?.actions).toEqual(
      expect.arrayContaining(['share', 'delete']),
    );
  });

  it('keeps same-name and same-id copies distinct by source', () => {
    const rows = project({
      pipelines: [
        pipeline('review'),
        pipeline('review', { source: 'bundled', readonly: true }),
        pipeline('review', { source: 'project', filePath: 'a/review.yaml' }),
        pipeline('review', { source: 'project', filePath: 'b/review.yaml' }),
      ],
    });
    expect(new Set(rows.map((row) => row.key)).size).toBe(4);
  });

  it('reads the on/off state from the existing pipeline toggle and has no next run', () => {
    const rows = project({
      pipelines: [pipeline('on'), pipeline('off')],
      disabledPipelineIds: new Set(['off']),
    });
    expect(rows.map((row) => row.enabled)).toEqual([true, false]);
    expect(rows.every((row) => row.nextRunAt === undefined)).toBe(true);
    expect(rows[0]?.actions).toContain('toggle');
  });

  it('takes Last run from the newest top-level execution of that pipeline', () => {
    const rows = project({
      pipelines: [pipeline('deps'), pipeline('idle'), pipeline('live')],
      executions: [
        execution('old', 'deps', { started_at: '2026-10-09T02:00:00.000Z' }),
        execution('new', 'deps', {
          status: 'failure',
          started_at: '2026-10-11T02:00:00.000Z',
          completed_at: '2026-10-11T02:14:00.000Z',
        }),
        // A sub-pipeline run is part of its parent, not this pipeline's own.
        execution('child', 'deps', {
          started_at: '2026-10-12T02:00:00.000Z',
          parent_execution_id: 'new',
        }),
        execution('running', 'live', {
          status: 'running',
          completed_at: undefined,
        }),
      ],
    });
    const byName = new Map(rows.map((row) => [row.name, row]));
    expect(byName.get('Pipeline deps')?.lastRun).toEqual({
      state: 'failure',
      at: Date.parse('2026-10-11T02:14:00.000Z'),
    });
    expect(byName.get('Pipeline idle')?.lastRun).toBeUndefined();
    expect(byName.get('Pipeline live')?.lastRun).toEqual({ state: 'running' });
  });

  it('shows the step count only when the definition is loaded', () => {
    expect(only(project({ pipelines: [pipeline('p')] })).summary).toBe('');
    const loaded = only(
      project({
        pipelines: [pipeline('p')],
        pipelineSteps: () => ['agent', 'agent'],
      }),
    );
    expect(loaded.summary).toBe('2 steps');
    expect(loaded.steps).toEqual(['agent', 'agent']);
  });
});

describe('shared automation rows', () => {
  const share = {
    remoteId: 'share-1',
    name: 'Weekly org digest',
    triggerKind: 'cron',
    actionType: 'standalone_prompt',
    sharer: { name: 'Acme', isPerson: false },
  } as const;

  it('offers Add for a share that is not installed yet', () => {
    const row = only(project({ sharedAutomations: [share] }));
    expect(row.installable).toBe(true);
    expect(row.actions).toEqual(['add']);
    expect(row.source).toBe('shared');
    expect(row.sourceLabel).toBe('Shared by Acme');
    expect(row.steps).toEqual(['chat']);
    expect(row.enabled).toBeUndefined();
    expect(row.installing).toBeUndefined();
    expect(
      only(
        project({
          sharedAutomations: [share],
          installingRemoteIds: new Set(['share-1']),
        }),
      ).installing,
    ).toBe(true);
  });

  it('does not offer Add for a share whose copy runs outside this context', () => {
    expect(
      project({
        activities: [],
        sharedAutomations: [share],
        installedRemoteIds: new Set(['share-1']),
      }),
    ).toEqual([]);
  });

  it('shows one row per share once added: the added copy, with its suffix', () => {
    const installed = activity(
      'copy',
      { type: 'standalone_prompt', chatProjectId: 'storefront', prompt: 'x' },
      {
        installedFrom: {
          remoteId: 'share-1',
          contentHash: 'h',
          installedAt: '2026-10-10T00:00:00.000Z',
        },
      },
    );
    const row = only(
      project({
        activities: [installed],
        sharedAutomations: [share],
        sharerForInstalled: () => ({ name: 'Dana Lee', isPerson: true }),
      }),
    );
    expect(row.key).toBe('automation:copy');
    expect(row.installable).toBeUndefined();
    expect(row.sourceLabel).toBe('Shared by Dana Lee');
    expect(row.sourceIsPerson).toBe(true);
    expect(row.actions).toContain('toggle');
  });

  it('keeps a copy as its own row with the suffix after the share is revoked', () => {
    const revoked = activity(
      'copy',
      { type: 'app_advisor_prompt', prompt: 'x' },
      {
        installedFrom: {
          remoteId: 'share-gone',
          contentHash: 'h',
          installedAt: '2026-10-10T00:00:00.000Z',
          staleAt: '2026-10-11T00:00:00.000Z',
        },
      },
    );
    // The share list no longer returns it, and the sharer is unknown.
    const row = only(project({ activities: [revoked], sharedAutomations: [] }));
    expect(row.source).toBe('shared');
    expect(row.sourceLabel).toBe('Shared');
    expect(row.actions).toContain('delete');
  });

  it('still projects local rows when the share list could not be loaded', () => {
    const rows = project({
      activities: [activity('a', { type: 'app_advisor_prompt', prompt: 'x' })],
      pipelines: [pipeline('p')],
      sharedAutomations: [],
    });
    expect(rows.map((row) => row.kind)).toEqual(['automation', 'pipeline']);
  });
});
