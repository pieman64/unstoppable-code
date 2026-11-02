import type { ExecutionState } from '@canopy/desktop-shared/types/pipeline';
import { toPipelineRunRowState } from '@/lib/pipelineRunRowState';
import { buildDagJobs } from '../dag-progress-jobs';

function matrixExecutionState(): ExecutionState {
  return {
    version: 8,
    id: 'matrix-timing-execution',
    pipeline_id: 'matrix-timing',
    pipeline_snapshot: {
      name: 'Matrix timing',
      scope: ['directory'],
      jobs: {
        build: {
          name: 'Build',
          needs: [],
          if: 'true',
          env: {},
          outputs: {},
          timeout_minutes: 60,
          max_retries: 0,
          continue_on_error: false,
          steps: [],
        },
      },
    },
    status: 'running',
    jobs: {
      __matrix__build__0: {
        status: 'success',
        conclusion: 'success',
        outcome: 'success',
        steps: {},
        outputs: {},
        started_at: '2026-08-05T12:01:00.000Z',
        completed_at: '2026-08-05T12:02:00.000Z',
      },
      __matrix__build__1: {
        status: 'running',
        steps: {},
        outputs: {},
        started_at: '2026-08-05T12:00:00.000Z',
      },
    },
    job_definitions: {},
    job_groups: {
      build: {
        job_id: 'build',
        kind: 'matrix',
        expansion: 'expanded',
        variant_job_ids: ['__matrix__build__0', '__matrix__build__1'],
        status: 'running',
        fail_fast: true,
        resolved_max_parallel: 2,
        started_at: '2026-08-05T12:00:00.000Z',
      },
    },
    pending_pauses: [],
    status_reasons: [],
    started_at: '2026-08-05T12:00:00.000Z',
    cwd: '/repo',
    env: {},
    inputs: {},
    event_name: 'dispatch',
  };
}

describe('DagProgressBar matrix timing projection', () => {
  it('uses aggregate group timing instead of the first variant window', () => {
    const state = matrixExecutionState();

    expect(buildDagJobs(state).build).toMatchObject({
      startedAt: '2026-08-05T12:00:00.000Z',
      completedAt: undefined,
    });

    state.status = 'success';
    state.job_groups.build.status = 'success';
    state.job_groups.build.completed_at = '2026-08-05T12:05:00.000Z';
    expect(buildDagJobs(state).build.completedAt).toBe(
      '2026-08-05T12:05:00.000Z',
    );
  });

  it('keeps complete DAG jobs identical for full states and row projections', () => {
    const singleAndDependencies = matrixExecutionState();
    const buildJob = singleAndDependencies.pipeline_snapshot.jobs.build;
    const step: (typeof buildJob.steps)[number] = {
      id: 'compile',
      name: 'Compile',
      run: 'echo compile',
      shell: 'bash',
      continue_on_error: false,
      timeout_minutes: 30,
      skip_on_missing_action: false,
    };
    singleAndDependencies.pipeline_snapshot.jobs.build = {
      ...buildJob,
      steps: [step],
    };
    singleAndDependencies.pipeline_snapshot.jobs.test = {
      ...buildJob,
      name: 'Test',
      needs: ['build'],
      steps: [step],
    };
    singleAndDependencies.job_groups = {};
    singleAndDependencies.jobs = {
      build: {
        status: 'success',
        steps: {
          compile: {
            status: 'success',
            outputs: {},
            dynamic_env: {},
          },
        },
        outputs: {},
      },
      test: {
        status: 'running',
        steps: {
          compile: {
            status: 'running',
            outputs: {},
            dynamic_env: {},
          },
        },
        outputs: {},
      },
    };

    const variants = matrixExecutionState();
    variants.jobs.__matrix__build__1.status = 'restarting';
    variants.jobs.__matrix__build__2 = {
      status: 'cancelled',
      steps: {},
      outputs: {},
    };
    variants.jobs.__matrix__build__3 = {
      status: 'skipped',
      steps: {},
      outputs: {},
    };
    variants.jobs.__matrix__build__4 = {
      status: 'failure',
      steps: {},
      outputs: {},
    };
    variants.job_groups.build.variant_job_ids = [
      '__matrix__build__0',
      '__matrix__build__1',
      '__matrix__build__2',
      '__matrix__build__3',
      '__matrix__build__4',
    ];
    variants.job_groups.build.resolved_max_parallel = 3;
    variants.job_groups.build.status = 'running';

    const queuedVariants = matrixExecutionState();
    queuedVariants.jobs.__matrix__build__0.status = 'queued';
    queuedVariants.jobs.__matrix__build__1.status = 'restarting';
    queuedVariants.job_groups.build.status = 'queued';

    for (const state of [singleAndDependencies, variants, queuedVariants]) {
      expect(buildDagJobs(toPipelineRunRowState(state))).toEqual(
        buildDagJobs(state),
      );
    }
  });
});
