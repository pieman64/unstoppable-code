import type { ExecutionState } from '@canopy/desktop-shared/types/pipeline';
import { buildDagJobs } from '../dag-progress-jobs';

function matrixExecutionState(): ExecutionState {
  return {
    version: 8,
    id: 'matrix-timing-execution',
    pipeline_id: 'matrix-timing',
    pipeline_snapshot: {
      id: 'matrix-timing',
      name: 'Matrix timing',
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
});
