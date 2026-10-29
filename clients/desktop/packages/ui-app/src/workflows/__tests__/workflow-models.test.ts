import type { CanopyCapabilities } from '@canopy/app-core';
import type { PipelineRunSummary } from '../../code/activity/pipeline/PipelineRunRows';
import {
  EMPTY_WORKFLOW_RUN_FILTERS,
  filterWorkflowRunRows,
  parseRunSearch,
  runSearchHint,
  workflowRunFiltersActive,
} from '../run-search';
import {
  EMPTY_WORKFLOW_LIBRARY_FILTERS,
  WORKFLOW_NO_PROJECT,
  availableWorkflowTriggerKinds,
  countLibraryFacets,
  describeNoLibraryMatches,
  describePipelineTriggers,
  describeRunUnavailable,
  describeStepCount,
  describeTriggerFilter,
  filterLibraryRows,
  menuWorkflowLibraryActions,
  pageLibraryRows,
  sortLibraryRows,
  truncateStepChain,
  type WorkflowLibraryRow,
} from '../workflow-library-model';
import {
  availableWorkflowRunKinds,
  countActiveWorkflowRuns,
  menuWorkflowRunActions,
  normalizeAutomationRunStatus,
  primaryWorkflowRunAction,
  sortWorkflowRunRows,
  workflowRunDurationLabel,
  workflowRunStatusFromPipeline,
  workflowRunStatusFromWatcher,
  workflowRunStatusTone,
  type WorkflowAutomationRunRow,
  type WorkflowRunRow,
} from '../workflow-run-model';
import {
  formatNextRun,
  formatOneTimeTrigger,
  formatRunDuration,
  formatRunStarted,
} from '../workflow-time';

const WEB: CanopyCapabilities = {
  localExecution: false,
  terminalPty: false,
  fileSystemAccess: 'none',
  voice: false,
  settingsScope: 'api-keys-only',
  pipelines: 'read-only',
  routing: 'url',
  overviewNotifications: false,
};
const DESKTOP: CanopyCapabilities = {
  ...WEB,
  automations: true,
  watchers: true,
};

const summary: PipelineRunSummary = {
  id: 'exec-1',
  pipeline_id: 'implementation',
  pipeline_name: 'Implementation (autopilot)',
  status: 'paused',
  status_reasons: [],
  started_at: '2026-10-12T10:52:00.000Z',
};

const T0 = new Date(2026, 9, 12, 12, 0, 0).getTime();
const HOUR = 3_600_000;

function automationRun(
  key: string,
  overrides: Partial<
    Pick<
      WorkflowAutomationRunRow,
      'name' | 'status' | 'starter' | 'startedAt' | 'endedAt' | 'detail'
    >
  > = {},
): WorkflowRunRow {
  const row: WorkflowAutomationRunRow = {
    kind: 'automation',
    key,
    runId: key,
    activityId: 'activity-1',
    name: 'Nightly dependency check',
    status: 'success',
    starter: 'schedule',
    startedAt: T0 - HOUR,
    endedAt: T0 - HOUR + 124_000,
    actions: ['open-library'],
    cancellable: false,
    result: { available: true },
    ...overrides,
  };
  return row;
}

const pipelineRun: WorkflowRunRow = {
  kind: 'pipeline',
  key: 'pipeline:exec-1',
  name: 'Implementation (autopilot)',
  status: 'waiting',
  starter: 'task-ready',
  where: 'canopy · left-rail',
  startedAt: T0 - 2 * HOUR,
  detail: 'Waiting for you to approve the plan',
  actions: ['respond', 'cancel', 'open-library'],
  result: { available: true },
  summary,
};

const watcherRun: WorkflowRunRow = {
  kind: 'watcher',
  key: 'watcher:w1',
  watcherId: 'w1',
  state: 'watching',
  name: 'PR #5116 merged',
  status: 'watching',
  starter: 'chat',
  where: 'canopy · Inbox chat',
  startedAt: T0 - 3 * HOUR,
  actions: ['cancel', 'inspect', 'go-to-chat'],
  result: { available: true },
};

describe('workflow run model', () => {
  it('maps every pipeline status onto the feed vocabulary', () => {
    expect(workflowRunStatusFromPipeline('pending')).toBe('queued');
    expect(workflowRunStatusFromPipeline('running')).toBe('running');
    expect(workflowRunStatusFromPipeline('paused')).toBe('waiting');
    expect(workflowRunStatusFromPipeline('success')).toBe('success');
    expect(workflowRunStatusFromPipeline('failure')).toBe('failure');
    expect(workflowRunStatusFromPipeline('cancelled')).toBe('canceled');
  });

  it('normalizes automation run statuses and fails closed on unknown ones', () => {
    expect(normalizeAutomationRunStatus('running')).toBe('running');
    expect(normalizeAutomationRunStatus('success')).toBe('success');
    expect(normalizeAutomationRunStatus('skipped')).toBe('skipped');
    expect(normalizeAutomationRunStatus('cancelled')).toBe('canceled');
    expect(normalizeAutomationRunStatus('missed')).toBe('missed');
    expect(normalizeAutomationRunStatus('failure')).toBe('failure');
    expect(normalizeAutomationRunStatus('something-new')).toBe('failure');
  });

  it('maps watcher states', () => {
    expect(workflowRunStatusFromWatcher('watching')).toBe('watching');
    expect(workflowRunStatusFromWatcher('firing')).toBe('running');
    expect(workflowRunStatusFromWatcher('fired')).toBe('fired');
    expect(workflowRunStatusFromWatcher('delivery-failed')).toBe(
      'delivery-failed',
    );
  });

  it('never tones a failure as a success', () => {
    expect(workflowRunStatusTone('failure').tone).toBe('failed');
    expect(workflowRunStatusTone('delivery-failed').tone).toBe('failed');
    expect(workflowRunStatusTone('success').tone).toBe('success');
    expect(workflowRunStatusTone('waiting').tone).toBe('warning');
  });

  it('pins running, waiting and watching rows above the rest, newest first', () => {
    const finishedNew = automationRun('a-new', { startedAt: T0 - 60_000 });
    const finishedOld = automationRun('a-old', { startedAt: T0 - 9 * HOUR });
    const sorted = sortWorkflowRunRows([
      finishedOld,
      watcherRun,
      finishedNew,
      pipelineRun,
    ]);
    expect(sorted.map((row) => row.key)).toEqual([
      'pipeline:exec-1',
      'watcher:w1',
      'a-new',
      'a-old',
    ]);
    expect(countActiveWorkflowRuns(sorted)).toBe(2);
  });

  it('labels the Duration cell by elapsed time or by where the run stands', () => {
    expect(workflowRunDurationLabel(automationRun('a'))).toBe('2m 04s');
    expect(
      workflowRunDurationLabel(automationRun('b', { status: 'skipped' })),
    ).toBe('skipped');
    expect(workflowRunDurationLabel(watcherRun)).toBe('watching');
    expect(
      workflowRunDurationLabel(
        automationRun('c', { status: 'canceled', endedAt: undefined }),
      ),
    ).toBe('canceled');
  });

  it('splits actions into the row button and the More menu', () => {
    expect(primaryWorkflowRunAction(pipelineRun.actions)).toBe('respond');
    expect(menuWorkflowRunActions(pipelineRun.actions)).toEqual([
      'open-library',
      'cancel',
    ]);
    expect(primaryWorkflowRunAction(['open-library'])).toBeUndefined();
    expect(menuWorkflowRunActions(['retry', 'rerun'])).toEqual(['rerun']);
  });

  it('offers only the run kinds a host has surfaces for', () => {
    expect(availableWorkflowRunKinds(WEB)).toEqual(['pipeline']);
    expect(availableWorkflowRunKinds({ ...WEB, watchers: true })).toEqual([
      'pipeline',
      'watcher',
    ]);
    expect(availableWorkflowRunKinds(DESKTOP)).toEqual([
      'automation',
      'pipeline',
      'watcher',
    ]);
  });
});

describe('run search', () => {
  const rows = [
    pipelineRun,
    watcherRun,
    automationRun('a-fail', {
      status: 'failure',
      detail: 'Pipeline Dependency check failed: npm test failed',
    }),
    automationRun('a-ok', { name: 'Morning PR triage', starter: 'run-now' }),
  ];

  it('parses free text and the three token kinds', () => {
    const parsed = parseRunSearch(
      'Nightly status:failed kind:automation by:schedule',
    );
    expect(parsed.terms).toEqual(['nightly']);
    expect(parsed.statuses).toEqual([['failure', 'delivery-failed']]);
    expect(parsed.kinds).toEqual(['automation']);
    expect(parsed.starters).toEqual(['schedule']);
    expect(parsed.unknownTokens).toEqual([]);
  });

  it('filters by tokens, free text and the dropdown filters together', () => {
    const keys = (query: string): string[] =>
      filterWorkflowRunRows(rows, query, EMPTY_WORKFLOW_RUN_FILTERS).map(
        (row) => row.key,
      );
    expect(keys('status:failed')).toEqual(['a-fail']);
    expect(keys('kind:watcher')).toEqual(['watcher:w1']);
    expect(keys('by:run-now')).toEqual(['a-ok']);
    expect(keys('npm test')).toEqual(['a-fail']);
    expect(keys('status:active')).toEqual(['pipeline:exec-1', 'watcher:w1']);
    expect(
      filterWorkflowRunRows(rows, 'nightly', {
        ...EMPTY_WORKFLOW_RUN_FILTERS,
        status: 'failure',
      }).map((row) => row.key),
    ).toEqual(['a-fail']);
  });

  it('matches nothing for an unknown token value and names the valid ones, with no message otherwise', () => {
    expect(
      filterWorkflowRunRows(rows, 'status:fialed', EMPTY_WORKFLOW_RUN_FILTERS),
    ).toEqual([]);
    expect(runSearchHint('status:fialed')).toContain('status:fialed');
    expect(runSearchHint('status:fialed')).toContain('failed');
    expect(runSearchHint('kind:robot')).toContain('automation');
    expect(runSearchHint('by:nobody')).toContain('schedule');
    expect(runSearchHint('')).toBeNull();
    expect(runSearchHint('nightly')).toBeNull();
    expect(runSearchHint('status:failed')).toBeNull();
  });

  it('does not take a name every object inherits for a token value', () => {
    for (const query of [
      'status:constructor',
      'status:__proto__',
      'kind:toString',
      'by:__proto__',
    ]) {
      expect(parseRunSearch(query).unknownTokens).toEqual([query]);
      // An unknown value matches nothing; it must not throw while matching.
      expect(
        filterWorkflowRunRows(rows, query, EMPTY_WORKFLOW_RUN_FILTERS),
      ).toEqual([]);
    }
  });

  it('treats a word with a colon but no known key as free text', () => {
    expect(parseRunSearch('foo:bar').terms).toEqual(['foo:bar']);
    expect(parseRunSearch(':x').terms).toEqual([':x']);
  });

  it('reports whether any search or filter is active', () => {
    expect(workflowRunFiltersActive('  ', EMPTY_WORKFLOW_RUN_FILTERS)).toBe(
      false,
    );
    expect(workflowRunFiltersActive('x', EMPTY_WORKFLOW_RUN_FILTERS)).toBe(
      true,
    );
    expect(
      workflowRunFiltersActive('', {
        ...EMPTY_WORKFLOW_RUN_FILTERS,
        kind: 'watcher',
      }),
    ).toBe(true);
  });
});

function libraryRow(
  key: string,
  overrides: Partial<WorkflowLibraryRow> = {},
): WorkflowLibraryRow {
  return {
    key,
    kind: 'automation',
    name: key,
    triggers: ['schedule'],
    triggerText: 'Weekdays at 9:00 AM',
    steps: ['chat'],
    summary: 'Start chat in storefront',
    source: 'mine',
    enabled: true,
    actions: [
      'toggle',
      'run',
      'edit',
      'view-runs',
      'duplicate',
      'share',
      'delete',
    ],
    ...overrides,
  };
}

describe('workflow library model', () => {
  const rows: readonly WorkflowLibraryRow[] = [
    libraryRow('Morning PR triage', {
      projectId: 'storefront',
      projectName: 'storefront',
      lastRun: { state: 'success', at: T0 - 2 * HOUR },
      nextRunAt: T0 + 21 * HOUR,
      changedAt: T0 - 100 * HOUR,
    }),
    libraryRow('Nightly dependency check', {
      projectId: 'storefront',
      projectName: 'storefront',
      steps: ['agent', 'agent', 'agent', 'agent'],
      summary: '6 steps',
      lastRun: { state: 'failure', at: T0 - 7 * HOUR },
      nextRunAt: T0 + 14 * HOUR,
      attention: 'Failed the last 3 runs',
    }),
    libraryRow('Code review', {
      kind: 'pipeline',
      triggers: ['manual'],
      triggerText: 'Manual',
      source: 'built-in',
      sourceLabel: 'Built-in',
      enabled: undefined,
      lastRun: { state: 'success', at: T0 - 30 * HOUR },
    }),
    libraryRow('Implementation', {
      kind: 'pipeline',
      triggers: ['plan-approved', 'task-ready'],
      triggerText: 'When a plan is approved or a task is ready',
      source: 'built-in',
      enabled: undefined,
      actions: ['edit', 'view-runs'],
    }),
    libraryRow('Weekly lint sweep', {
      projectId: 'api-gateway',
      projectName: 'api-gateway',
      enabled: false,
      lastRun: { state: 'running' },
    }),
    libraryRow('Follow up', {
      triggers: ['once'],
      triggerText: 'Oct 2 at 10:30 AM',
      source: 'shared',
      sourceLabel: 'Shared by Acme',
      changedAt: T0 - HOUR,
    }),
  ];

  const names = (list: readonly WorkflowLibraryRow[]): string[] =>
    list.map((row) => row.name);

  it('filters by each facet and by search text', () => {
    const filter = (
      overrides: Partial<typeof EMPTY_WORKFLOW_LIBRARY_FILTERS>,
    ): string[] =>
      names(
        filterLibraryRows(rows, {
          ...EMPTY_WORKFLOW_LIBRARY_FILTERS,
          ...overrides,
        }),
      );
    expect(filter({ triggers: ['schedule', 'once'] })).toEqual([
      'Morning PR triage',
      'Nightly dependency check',
      'Weekly lint sweep',
      'Follow up',
    ]);
    expect(filter({ triggers: ['task-ready'] })).toEqual(['Implementation']);
    expect(filter({ status: 'off' })).toEqual(['Weekly lint sweep']);
    expect(filter({ status: 'attention' })).toEqual([
      'Nightly dependency check',
    ]);
    expect(filter({ status: 'running' })).toEqual(['Weekly lint sweep']);
    // Pipelines carry no on/off state, so On is automations only.
    expect(filter({ status: 'on' })).toEqual([
      'Morning PR triage',
      'Nightly dependency check',
      'Follow up',
    ]);
    expect(filter({ project: 'api-gateway' })).toEqual(['Weekly lint sweep']);
    expect(filter({ project: WORKFLOW_NO_PROJECT })).toEqual([
      'Code review',
      'Implementation',
      'Follow up',
    ]);
    expect(filter({ source: 'shared' })).toEqual(['Follow up']);
    expect(filter({ query: 'acme' })).toEqual(['Follow up']);
    expect(filter({ query: 'storefront triage' })).toEqual([
      'Morning PR triage',
    ]);
  });

  it('matches search text a row carries but does not show', () => {
    const [first] = rows;
    if (!first) throw new Error('Expected a fixture row');
    const described = {
      ...first,
      searchText: 'Nightly sweep of stale branches',
    };
    expect(
      filterLibraryRows([described, ...rows.slice(1)], {
        ...EMPTY_WORKFLOW_LIBRARY_FILTERS,
        query: 'stale branches',
      }),
    ).toEqual([described]);
  });

  it('counts facets from the unfiltered set, once per trigger of a row', () => {
    const counts = countLibraryFacets(rows);
    expect(counts.triggers).toEqual({
      schedule: 3,
      once: 1,
      manual: 1,
      'plan-approved': 1,
      'task-ready': 1,
    });
    expect(counts.statuses).toEqual({
      on: 3,
      off: 1,
      attention: 1,
      running: 1,
    });
    expect(counts.sources).toEqual({
      mine: 3,
      project: 0,
      'built-in': 2,
      shared: 1,
    });
    expect(counts.projects).toEqual({
      storefront: 2,
      'api-gateway': 1,
      [WORKFLOW_NO_PROJECT]: 3,
    });
  });

  it('sorts recently run with never-run rows last, then by name', () => {
    expect(names(sortLibraryRows(rows, 'recently-run'))).toEqual([
      'Weekly lint sweep',
      'Morning PR triage',
      'Nightly dependency check',
      'Code review',
      'Follow up',
      'Implementation',
    ]);
  });

  it('sorts next run soonest first with rows that have none last', () => {
    expect(names(sortLibraryRows(rows, 'next-run')).slice(0, 3)).toEqual([
      'Nightly dependency check',
      'Morning PR triage',
      'Code review',
    ]);
  });

  it('sorts by name and by recent change, breaking ties by key', () => {
    expect(names(sortLibraryRows(rows, 'name'))[0]).toBe('Code review');
    expect(
      names(sortLibraryRows(rows, 'recently-changed')).slice(0, 3),
    ).toEqual(['Follow up', 'Morning PR triage', 'Code review']);
    const twins = [
      libraryRow('b', { name: 'Same' }),
      libraryRow('a', { name: 'Same' }),
    ];
    expect(sortLibraryRows(twins, 'name').map((row) => row.key)).toEqual([
      'a',
      'b',
    ]);
  });

  it('pages 25 at a time and clamps a page past the end', () => {
    const many = Array.from({ length: 38 }, (_, index) =>
      libraryRow(`row-${String(index).padStart(2, '0')}`),
    );
    const first = pageLibraryRows(many, 1);
    expect([first.from, first.to, first.total, first.pageCount]).toEqual([
      1, 25, 38, 2,
    ]);
    const second = pageLibraryRows(many, 2);
    expect([second.from, second.to, second.rows.length]).toEqual([26, 38, 13]);
    // The row count shrank under the current page: clamp, never show nothing.
    const clamped = pageLibraryRows(many.slice(0, 10), 2);
    expect([clamped.page, clamped.from, clamped.to]).toEqual([1, 1, 10]);
    const empty = pageLibraryRows([], 3);
    expect([empty.page, empty.pageCount, empty.from, empty.to]).toEqual([
      1, 1, 0, 0,
    ]);
    expect(pageLibraryRows(many, Number.NaN).page).toBe(1);
  });

  it('truncates the step chain to three glyphs and a remainder', () => {
    expect(truncateStepChain(['agent', 'agent'])).toEqual({
      shown: ['agent', 'agent'],
      more: 0,
    });
    expect(
      truncateStepChain(['gate', 'agent', 'script', 'agent', 'input']),
    ).toEqual({ shown: ['gate', 'agent', 'script'], more: 2 });
    expect(truncateStepChain([])).toEqual({ shown: [], more: 0 });
  });

  it('describes pipeline triggers for every event mix', () => {
    expect(describePipelineTriggers([])).toBe('Manual');
    expect(describePipelineTriggers(['manual'])).toBe('Manual');
    expect(describePipelineTriggers(['plan-approved'])).toBe(
      'When a plan is approved',
    );
    expect(describePipelineTriggers(['task-ready'])).toBe(
      'When a task is ready',
    );
    expect(describePipelineTriggers(['plan-approved', 'task-ready'])).toBe(
      'When a plan is approved or a task is ready',
    );
    expect(describePipelineTriggers(['manual', 'task-ready'])).toBe(
      'Manual, or when a task is ready',
    );
  });

  it('names where a pipeline starts when it cannot be run by hand', () => {
    expect(describeRunUnavailable(['plan-approved', 'task-ready'])).toBe(
      'Starts from an approved plan or a new task',
    );
    expect(describeRunUnavailable([])).toBe('Cannot be started from here');
    expect(describeStepCount(1)).toBe('1 step');
    expect(describeStepCount(6)).toBe('6 steps');
  });

  it('writes the filtered empty sentence and the Trigger capsule label', () => {
    expect(
      describeNoLibraryMatches({
        ...EMPTY_WORKFLOW_LIBRARY_FILTERS,
        query: 'deploy',
        triggers: ['once'],
      }),
    ).toBe('No workflows match "deploy" with a one-time trigger');
    expect(
      describeNoLibraryMatches({
        ...EMPTY_WORKFLOW_LIBRARY_FILTERS,
        status: 'off',
      }),
    ).toBe('No workflows match these filters');
    expect(
      describeNoLibraryMatches({
        ...EMPTY_WORKFLOW_LIBRARY_FILTERS,
        query: 'deploy',
        source: 'shared',
      }),
    ).toBe('No workflows match "deploy" and these filters');
    expect(describeTriggerFilter([])).toBe('Any trigger');
    expect(describeTriggerFilter(['once'])).toBe('One time');
    expect(describeTriggerFilter(['schedule', 'once'])).toBe('2 triggers');
  });

  it('orders the More menu and keeps only applicable actions', () => {
    expect(
      menuWorkflowLibraryActions(['delete', 'run', 'share', 'toggle', 'edit']),
    ).toEqual(['edit', 'share', 'delete']);
    expect(menuWorkflowLibraryActions(['add'])).toEqual([]);
  });

  it('offers only the triggers a host without automations can show', () => {
    expect(availableWorkflowTriggerKinds(WEB)).toEqual([
      'manual',
      'plan-approved',
      'task-ready',
    ]);
    expect(availableWorkflowTriggerKinds(DESKTOP)).toHaveLength(5);
  });
});

describe('workflow time labels', () => {
  const at = (day: number, hour: number, minute = 0): number =>
    new Date(2026, 9, day, hour, minute).getTime();

  it('labels when a run started relative to today', () => {
    expect(formatRunStarted(at(12, 10, 52), T0, 'en-US')).toBe(
      'Today 10:52 AM',
    );
    expect(formatRunStarted(at(11, 2), T0, 'en-US')).toBe('Yesterday 2:00 AM');
    expect(formatRunStarted(at(9, 16), T0, 'en-US')).toBe('Fri 4:00 PM');
    expect(formatRunStarted(at(1, 16), T0, 'en-US')).toBe('Oct 1');
    expect(formatRunStarted(Number.NaN, T0, 'en-US')).toBe('');
  });

  it('labels the next run and a one-time trigger', () => {
    expect(formatNextRun(at(12, 14), T0, 'en-US')).toBe('Today, 2:00 PM');
    expect(formatNextRun(at(13, 9), T0, 'en-US')).toBe('Tomorrow, 9:00 AM');
    expect(formatNextRun(at(16, 16), T0, 'en-US')).toBe('Friday, 4:00 PM');
    expect(formatNextRun(at(30, 9), T0, 'en-US')).toBe('Oct 30, 9:00 AM');
    // Another year is named, so a far-off run is not read as this year's.
    expect(
      formatNextRun(new Date(2099, 5, 1, 15, 0, 0).getTime(), T0, 'en-US'),
    ).toBe('Jun 1, 2099, 3:00 PM');
    expect(formatOneTimeTrigger(at(2, 10, 30), 'en-US')).toBe(
      'Oct 2 at 10:30 AM',
    );
  });

  it('formats durations', () => {
    expect(formatRunDuration(42_000)).toBe('42s');
    expect(formatRunDuration(124_000)).toBe('2m 04s');
    expect(formatRunDuration(47 * 60_000)).toBe('47m');
    expect(formatRunDuration(72 * 60_000)).toBe('1h 12m');
    expect(formatRunDuration(-1)).toBe('');
  });
});
