import type {
  ExecutionState,
  ExecutionSummary,
  NormalizedJob,
} from '@canopy/desktop-shared/types/pipeline';
import {
  buildAttemptViews,
  findChildExecutionSummary,
  findDefaultSelection,
  resolveSelectedStep,
} from '../lib/pipelineAttemptTimeline';

function createState(overrides: Partial<ExecutionState> = {}): ExecutionState {
  const buildJob: NormalizedJob = {
    name: 'Build',
    needs: [],
    timeout_minutes: 360,
    max_retries: 1,
    max_iterations: 3,
    continue_on_error: false,
    steps: [
      {
        id: 'first',
        run: 'echo first',
        shell: 'bash',
        continue_on_error: false,
        timeout_minutes: 360,
        skip_on_missing_action: false,
      },
      {
        id: 'second',
        run: 'echo second',
        shell: 'bash',
        continue_on_error: false,
        timeout_minutes: 360,
        skip_on_missing_action: false,
      },
    ],
  };
  return {
    version: 2,
    id: 'execution-1',
    pipeline_id: 'attempt-timeline',
    pipeline_snapshot: {
      name: 'Attempt Timeline',
      scope: ['directory'],
      jobs: { build: buildJob },
    },
    status: 'pending',
    jobs: {
      build: {
        status: 'pending',
        steps: {
          first: {
            status: 'pending',
            outputs: {},
            dynamic_env: {},
          },
          second: {
            status: 'pending',
            outputs: {},
            dynamic_env: {},
          },
        },
        outputs: {},
        retry_count: 0,
        retry_history: [],
        iteration_count: 0,
      },
    },
    job_definitions: {
      build: {
        physical_job_id: 'build',
        logical_job_id: 'build',
        ...buildJob,
      },
    },
    job_groups: {},
    pending_pauses: [],
    status_reasons: [],
    started_at: '2026-03-26T08:59:00.000Z',
    cwd: '/tmp/canopy-tests',
    env: {},
    inputs: {},
    event_name: 'dispatch',
    ...overrides,
  };
}

describe('pipelineAttemptTimeline', () => {
  it('builds a flat retry and iteration timeline and derives current timing from live steps', () => {
    const state = createState();
    const job = state.jobs.build;

    job.started_at = '2026-03-26T09:00:00.000Z';
    job.retry_count = 1;
    job.iteration_count = 2;
    job.status = 'running';
    job.retry_history = [
      {
        attempt: 0,
        status: 'failure',
        conclusion: 'failure',
        outcome: 'failure',
        steps: {
          first: {
            status: 'failure',
            conclusion: 'failure',
            outcome: 'failure',
            outputs: { artifact: 'retry-final' },
            dynamic_env: {},
            started_at: '2026-03-26T09:00:04.000Z',
            completed_at: '2026-03-26T09:00:05.000Z',
          },
          second: {
            status: 'pending',
            outputs: {},
            dynamic_env: {},
          },
        },
        started_at: '2026-03-26T09:00:04.000Z',
        completed_at: '2026-03-26T09:00:05.000Z',
        iteration_history: [
          {
            iteration: 1,
            status: 'running',
            steps: {
              first: {
                status: 'success',
                conclusion: 'success',
                outcome: 'success',
                outputs: { artifact: 'retry-iter-1' },
                dynamic_env: {},
                started_at: '2026-03-26T09:00:01.000Z',
                completed_at: '2026-03-26T09:00:02.000Z',
              },
              second: {
                status: 'success',
                conclusion: 'success',
                outcome: 'success',
                outputs: { artifact: 'retry-iter-1-second' },
                dynamic_env: {},
                started_at: '2026-03-26T09:00:02.500Z',
                completed_at: '2026-03-26T09:00:03.000Z',
              },
            },
            started_at: '2026-03-26T09:00:01.000Z',
            completed_at: '2026-03-26T09:00:03.000Z',
          },
        ],
      },
    ];
    job.iteration_history = [
      {
        iteration: 1,
        status: 'running',
        steps: {
          first: {
            status: 'success',
            conclusion: 'success',
            outcome: 'success',
            outputs: { artifact: 'current-iter-1' },
            dynamic_env: {},
            started_at: '2026-03-26T10:00:01.000Z',
            completed_at: '2026-03-26T10:00:02.000Z',
          },
          second: {
            status: 'success',
            conclusion: 'success',
            outcome: 'success',
            outputs: { artifact: 'current-iter-1-second' },
            dynamic_env: {},
            started_at: '2026-03-26T10:00:02.500Z',
            completed_at: '2026-03-26T10:00:03.000Z',
          },
        },
        started_at: '2026-03-26T10:00:01.000Z',
        completed_at: '2026-03-26T10:00:03.000Z',
      },
    ];
    job.steps.first = {
      status: 'success',
      conclusion: 'success',
      outcome: 'success',
      outputs: { artifact: 'current-live-first' },
      dynamic_env: {},
      started_at: '2026-03-26T11:00:01.000Z',
      completed_at: '2026-03-26T11:00:02.000Z',
    };
    job.steps.second = {
      status: 'running',
      outputs: {},
      dynamic_env: {},
      started_at: '2026-03-26T11:00:03.000Z',
    };

    const views = buildAttemptViews(job);

    expect(views.map((view) => view.label)).toEqual([
      'Attempt 1 / Iteration 1',
      'Attempt 1 (failure)',
      'Attempt 2 / Iteration 1',
      'Attempt 2 / Iteration 2 (current)',
    ]);
    expect(views[3].started_at).toBe('2026-03-26T11:00:01.000Z');
    expect(views[3].completed_at).toBeUndefined();
  });

  it('finds the latest terminal iteration snapshot before a blank current restart row', () => {
    const state = createState();
    const job = state.jobs.build;

    job.iteration_count = 1;
    job.status = 'pending';
    job.iteration_history = [
      {
        iteration: 1,
        status: 'running',
        steps: {
          first: {
            status: 'success',
            conclusion: 'success',
            outcome: 'success',
            outputs: { artifact: 'done' },
            dynamic_env: {},
            started_at: '2026-03-26T12:00:00.000Z',
            completed_at: '2026-03-26T12:00:01.000Z',
          },
          second: {
            status: 'success',
            conclusion: 'success',
            outcome: 'success',
            outputs: {},
            dynamic_env: {},
            started_at: '2026-03-26T12:00:01.000Z',
            completed_at: '2026-03-26T12:00:02.000Z',
          },
        },
        started_at: '2026-03-26T12:00:00.000Z',
        completed_at: '2026-03-26T12:00:02.000Z',
      },
    ];

    const selection = findDefaultSelection(state);

    expect(selection).toEqual({
      jobId: 'build',
      stepId: 'second',
      attempt: 0,
      iteration: 1,
      source: 'iteration',
    });
  });

  it('resolves a selected step from the pipeline snapshot when normalized job definitions are absent', () => {
    const legacyState = createState({ job_definitions: undefined });

    const selected = findDefaultSelection(legacyState);

    expect(selected).not.toBeNull();
    expect(resolveSelectedStep(legacyState, selected)?.stepDef.id).toBe(
      'first',
    );
  });

  it('matches child executions by parent iteration', () => {
    const childSummaries: ExecutionSummary[] = [
      {
        id: 'child-iter-1',
        pipeline_id: 'child',
        pipeline_name: 'Child Iteration 1',
        status: 'success',
        status_reasons: [],
        started_at: '2026-03-26T13:00:00.000Z',
        cwd: '/tmp/canopy-tests',
        parent_execution_id: 'execution-1',
        parent_step_id: 'nested',
        parent_attempt: 1,
        parent_iteration: 1,
      },
      {
        id: 'child-iter-2',
        pipeline_id: 'child',
        pipeline_name: 'Child Iteration 2',
        status: 'success',
        status_reasons: [],
        started_at: '2026-03-26T13:01:00.000Z',
        cwd: '/tmp/canopy-tests',
        parent_execution_id: 'execution-1',
        parent_step_id: 'nested',
        parent_attempt: 1,
        parent_iteration: 2,
      },
    ];

    expect(findChildExecutionSummary(childSummaries, 'nested', 1, 1)?.id).toBe(
      'child-iter-1',
    );
    expect(findChildExecutionSummary(childSummaries, 'nested', 1, 2)?.id).toBe(
      'child-iter-2',
    );
  });

  it('treats an omitted iteration as a wildcard for retry attempt views', () => {
    const childSummaries: ExecutionSummary[] = [
      {
        id: 'child-retry',
        pipeline_id: 'child',
        pipeline_name: 'Child Retry View',
        status: 'success',
        status_reasons: [],
        started_at: '2026-03-26T13:02:00.000Z',
        cwd: '/tmp/canopy-tests',
        parent_execution_id: 'execution-1',
        parent_step_id: 'nested',
        parent_attempt: 1,
        parent_iteration: 1,
      },
    ];

    expect(findChildExecutionSummary(childSummaries, 'nested', 1)?.id).toBe(
      'child-retry',
    );
  });

  it('prefers the persisted child execution id for matrix siblings', () => {
    const childSummaries: ExecutionSummary[] = [
      {
        id: 'child-first-variant',
        pipeline_id: 'child',
        pipeline_name: 'First Variant Child',
        status: 'success',
        status_reasons: [],
        started_at: '2026-03-26T13:00:00.000Z',
        cwd: '/tmp/canopy-tests',
        parent_execution_id: 'execution-1',
        parent_step_id: 'nested',
        parent_attempt: 1,
        parent_iteration: 1,
      },
      {
        id: 'child-second-variant',
        pipeline_id: 'child',
        pipeline_name: 'Second Variant Child',
        status: 'success',
        status_reasons: [],
        started_at: '2026-03-26T13:01:00.000Z',
        cwd: '/tmp/canopy-tests',
        parent_execution_id: 'execution-1',
        parent_step_id: 'nested',
        parent_attempt: 1,
        parent_iteration: 1,
      },
    ];

    expect(
      findChildExecutionSummary(
        childSummaries,
        'nested',
        1,
        1,
        'child-second-variant',
      )?.id,
    ).toBe('child-second-variant');
  });
});
