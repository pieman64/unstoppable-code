import type { PipelineRunUsageEvent } from '@canopy/desktop-shared/types';

let lastUsageEvent: PipelineRunUsageEvent | undefined;
const recordUsageMetricEvent = jest.fn((event: PipelineRunUsageEvent): void => {
  lastUsageEvent = event;
});
const resolveAction = jest.fn();

jest.mock('../observability', () => ({
  getObservabilityService: (): {
    recordUsageMetricEvent: (event: PipelineRunUsageEvent) => void;
  } => ({
    recordUsageMetricEvent,
  }),
}));

jest.mock('../pipelines/action-resolver', () => ({
  resolveAction: (...args: unknown[]): unknown => resolveAction(...args),
}));

jest.mock('../lib/pipeline-run-completion-emitter', () => ({
  emitPipelineRunCompletion: jest.fn(),
}));

import type {
  ExecutionState,
  JobResult,
  NormalizedJob,
  NormalizedStep,
  StepResult,
} from '@canopy/desktop-shared/node/pipelines/executor';
import { recordPipelineUsageEvent } from '../pipelines/pipeline-usage-events';

function step(id: string, uses = 'project/agent'): NormalizedStep {
  return {
    id,
    uses,
    shell: 'bash',
    continue_on_error: false,
    timeout_minutes: 10,
    skip_on_missing_action: false,
  };
}

function job(steps: NormalizedStep[]): NormalizedJob {
  return {
    name: 'Job',
    needs: [],
    timeout_minutes: 10,
    max_retries: 0,
    continue_on_error: false,
    steps,
  };
}

function result(
  status: StepResult['status'],
  overrides: Partial<StepResult> = {},
): StepResult {
  return {
    status,
    outputs: {},
    dynamic_env: {},
    ...(status === 'pending' || status === 'skipped'
      ? {}
      : { started_at: '2026-08-20T12:00:00.000Z' }),
    ...overrides,
  };
}

function state(
  definitions: Record<string, { logicalId: string; steps: NormalizedStep[] }>,
  jobs: Record<string, JobResult>,
): ExecutionState {
  const logicalJobs = Object.fromEntries(
    Object.values(definitions).map(({ logicalId, steps }) => [
      logicalId,
      job(steps),
    ]),
  );
  return {
    version: 9,
    id: 'execution-1',
    pipeline_id: 'pipeline-1',
    pipeline_snapshot: {
      name: 'Pipeline',
      scope: ['directory'],
      jobs: logicalJobs,
    },
    status: 'success',
    jobs,
    job_definitions: Object.fromEntries(
      Object.entries(definitions).map(([physicalId, { logicalId, steps }]) => [
        physicalId,
        {
          ...job(steps),
          physical_job_id: physicalId,
          logical_job_id: logicalId,
        },
      ]),
    ),
    job_groups: {},
    started_at: '2026-08-20T12:00:00.000Z',
    completed_at: '2026-08-20T12:05:00.000Z',
    cwd: '/repo',
    env: {},
    inputs: {},
    project_id: 'workspace-1',
    pending_pauses: [],
    status_reasons: [],
  };
}

function recordedAgentSteps(executionState: ExecutionState): number {
  const timestamp = executionState.completed_at;
  if (!timestamp) throw new Error('Expected a completed execution state');
  recordPipelineUsageEvent({
    executionId: executionState.id,
    type: 'execution.completed',
    state: executionState,
    timestamp,
  });
  if (!lastUsageEvent) throw new Error('Expected a recorded usage event');
  return lastUsageEvent.agentStepCount ?? 0;
}

describe('pipeline run duration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    lastUsageEvent = undefined;
    resolveAction.mockReturnValue({ log_format_hint: 'agent' });
  });

  it('reports run time with whole-run pauses excluded', () => {
    const executionState = state(
      { job1: { logicalId: 'job1', steps: [step('run')] } },
      {
        job1: {
          status: 'success',
          outputs: {},
          steps: { run: result('success') },
        },
      },
    );
    // 5m wall clock, 4m of it spent paused waiting for input.
    executionState.paused_ms = 240_000;

    recordPipelineUsageEvent({
      executionId: executionState.id,
      type: 'execution.completed',
      state: executionState,
      timestamp: executionState.completed_at ?? '',
    });

    expect(lastUsageEvent?.runDurationMs).toBe(60_000);
  });
});

describe('pipeline usage agent-step counting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    lastUsageEvent = undefined;
    resolveAction.mockReturnValue({ log_format_hint: 'agent' });
  });

  it('excludes pending, skipped, and cascade-cancelled steps that never started', () => {
    const pending = step('pending');
    const skipped = step('skipped');
    const cascadeCancelled = step('cascade-cancelled');
    expect(
      recordedAgentSteps(
        state(
          {
            job1: {
              logicalId: 'job1',
              steps: [pending, skipped, cascadeCancelled],
            },
          },
          {
            job1: {
              status: 'cancelled',
              outputs: {},
              steps: {
                pending: result('pending'),
                skipped: result('skipped'),
                'cascade-cancelled': result('cancelled', {
                  started_at: undefined,
                }),
              },
            },
          },
        ),
      ),
    ).toBe(0);
  });

  it('counts a cancelled step when it actually started', () => {
    const agent = step('agent');
    expect(
      recordedAgentSteps(
        state(
          { job1: { logicalId: 'job1', steps: [agent] } },
          {
            job1: {
              status: 'cancelled',
              outputs: {},
              steps: { agent: result('cancelled') },
            },
          },
        ),
      ),
    ).toBe(1);
  });

  it('counts every physical matrix variant', () => {
    const agent = step('agent');
    expect(
      recordedAgentSteps(
        state(
          {
            matrix0: { logicalId: 'matrix', steps: [agent] },
            matrix1: { logicalId: 'matrix', steps: [agent] },
          },
          {
            matrix0: {
              status: 'success',
              outputs: {},
              steps: { agent: result('success') },
            },
            matrix1: {
              status: 'success',
              outputs: {},
              steps: { agent: result('success') },
            },
          },
        ),
      ),
    ).toBe(2);
  });

  it('counts retry and iteration histories without collapsing them', () => {
    const agent = step('agent');
    expect(
      recordedAgentSteps(
        state(
          { job1: { logicalId: 'job1', steps: [agent] } },
          {
            job1: {
              status: 'success',
              outputs: {},
              retry_count: 1,
              retry_history: [
                {
                  attempt: 0,
                  status: 'failure',
                  iteration_history: [
                    {
                      iteration: 1,
                      status: 'failure',
                      steps: { agent: result('failure') },
                    },
                  ],
                  steps: { agent: result('failure') },
                },
              ],
              iteration_count: 2,
              iteration_history: [
                {
                  iteration: 1,
                  status: 'failure',
                  steps: { agent: result('failure') },
                },
              ],
              steps: { agent: result('success') },
            },
          },
        ),
      ),
    ).toBe(4);
  });

  it('weights parallel-agents by its completed fan-out and floors invalid output at one', () => {
    const parallel = step('parallel', 'builtin/parallel-agents');
    expect(
      recordedAgentSteps(
        state(
          { job1: { logicalId: 'job1', steps: [parallel] } },
          {
            job1: {
              status: 'success',
              outputs: {},
              iteration_history: [
                {
                  iteration: 1,
                  status: 'success',
                  steps: {
                    parallel: result('success', {
                      outputs: { success_count: '2', failure_count: '1' },
                    }),
                  },
                },
              ],
              steps: {
                parallel: result('running', {
                  outputs: { success_count: 'nope', failure_count: '' },
                }),
              },
            },
          },
        ),
      ),
    ).toBe(4);
  });

  it('counts a valid zero-width parallel-agents fan-out as zero agent steps', () => {
    // An empty `prompts` array really does run zero agents. Two VALID counts
    // are taken at their word so a no-op is not reported as one agent step;
    // the floor of one applies only to absent/unparseable counts (covered by
    // the test above, where the still-running step contributes its floored 1).
    const parallel = step('parallel', 'builtin/parallel-agents');
    expect(
      recordedAgentSteps(
        state(
          { job1: { logicalId: 'job1', steps: [parallel] } },
          {
            job1: {
              status: 'success',
              outputs: {},
              steps: {
                parallel: result('success', {
                  outputs: { success_count: '0', failure_count: '0' },
                }),
              },
            },
          },
        ),
      ),
    ).toBe(0);
  });

  it('does not double-count the restarting iteration boundary', () => {
    // The executor persists `status: 'restarting'` with `job.steps` still
    // holding the terminal results it just snapshotted into
    // `iteration_history`. Counting both containers would report that
    // iteration's agent steps twice.
    const agent = step('agent', 'builtin/agent-prompt');
    const terminal = (): ReturnType<typeof result> =>
      result('success', { agent_provider: 'claude' });
    expect(
      recordedAgentSteps(
        state(
          { job1: { logicalId: 'job1', steps: [agent] } },
          {
            job1: {
              status: 'restarting',
              outputs: {},
              iteration_count: 2,
              iteration_history: [
                {
                  iteration: 1,
                  status: 'success',
                  steps: { agent: terminal() },
                },
              ],
              steps: { agent: terminal() },
            },
          },
        ),
      ),
    ).toBe(1);
  });

  it('uses result metadata and builtin classification without resolving actions', () => {
    const metadata = step('metadata', 'project/missing');
    const builtin = step('builtin', 'builtin/parallel-agents');
    expect(
      recordedAgentSteps(
        state(
          { job1: { logicalId: 'job1', steps: [metadata, builtin] } },
          {
            job1: {
              status: 'success',
              outputs: {},
              steps: {
                metadata: result('success', { agent_provider: 'claude' }),
                builtin: result('success'),
              },
            },
          },
        ),
      ),
    ).toBe(2);
    expect(resolveAction).not.toHaveBeenCalled();
  });

  it('does not memoize transient action-resolution failures', () => {
    resolveAction.mockImplementation(() => {
      throw new Error('action mid-edit');
    });
    const agent = step('agent', 'project/transient');
    expect(
      recordedAgentSteps(
        state(
          {
            job1: { logicalId: 'job1', steps: [agent] },
            job2: { logicalId: 'job2', steps: [agent] },
          },
          {
            job1: {
              status: 'success',
              outputs: {},
              steps: { agent: result('success') },
            },
            job2: {
              status: 'success',
              outputs: {},
              steps: { agent: result('success') },
            },
          },
        ),
      ),
    ).toBe(0);
    expect(resolveAction).toHaveBeenCalledTimes(2);
  });
});
