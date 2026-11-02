import type { ExecutionState } from '@canopy/desktop-shared/types/pipeline';
import { summaryFromState } from '@/stores/pipelineRunsStore';

function createState(overrides: Partial<ExecutionState> = {}): ExecutionState {
  return {
    version: 1,
    id: 'execution-1',
    pipeline_id: 'pipeline-1',
    pipeline_snapshot: {
      name: 'Pipeline 1',
      scope: ['directory'],
      jobs: {},
      env: {},
      inputs: {},
    },
    status: 'running',
    jobs: {},
    job_definitions: {},
    job_groups: {},
    started_at: '2026-10-21T12:00:00.000Z',
    cwd: '/scratch',
    env: {},
    inputs: {},
    pending_pauses: [],
    status_reasons: [],
    event_name: 'dispatch',
    ...overrides,
  };
}

describe('summaryFromState', () => {
  it('keeps the owner and initiator a live event carries', () => {
    const summary = summaryFromState(
      createState({
        scope: 'global',
        execution_context: 'org:11111111-1111-4111-8111-111111111111',
        initiator: { kind: 'user' },
      }),
    );

    // The Runs feed files a run with no project by this owner.
    expect(summary.execution_context).toBe(
      'org:11111111-1111-4111-8111-111111111111',
    );
    expect(summary.initiator).toEqual({ kind: 'user' });
    expect(summary.project_id).toBeUndefined();
  });
});
