import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizePipeline } from '@canopy/desktop-shared/pipelines/normalize-pipeline';
import {
  listExecutionSummaries,
  loadExecutionState,
  prepareActiveExecutionResume,
  prepareExecutionResume,
  saveExecutionState,
} from '../execution-state';
import { resumePipeline } from '../pipeline-executor';
import type { ExecutionRuntime, ExecutionState } from '../types';

function legacyState(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 5,
    id: 'legacy-paused',
    pipeline_id: 'pipeline',
    pipeline_snapshot: {
      name: 'Paused pipeline',
      on: ['dispatch'],
      env: {},
      inputs: {},
      jobs: {
        job: {
          name: 'Job',
          needs: [],
          env: {},
          timeout_minutes: 60,
          max_retries: 0,
          continue_on_error: false,
          steps: [
            {
              id: 'step',
              shell: 'bash',
              continue_on_error: false,
              timeout_minutes: 60,
              skip_on_missing_action: false,
            },
          ],
        },
      },
    },
    status: 'paused',
    jobs: {
      job: {
        status: 'paused',
        steps: {
          step: {
            status: 'success',
            outputs: {},
            dynamic_env: {},
            input_request: {
              fields: [{ key: 'answer', label: 'Answer', type: 'string' }],
            },
          },
        },
        outputs: {},
      },
    },
    started_at: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp',
    env: {},
    inputs: {},
    pending_input: {
      job_id: 'job',
      step_id: 'step',
      request: {
        fields: [{ key: 'answer', label: 'Answer', type: 'string' }],
      },
    },
    ...overrides,
  };
}

function createRuntime(dir: string): ExecutionRuntime {
  return {
    // Pipeline fixtures do not enforce an org model policy.
    isModelBlockedByOrgPolicy: (): Promise<boolean> => Promise.resolve(false),
    isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
    executionsDir: dir,
    tempRootDir: join(dir, 'tmp'),
    bundledActionsDir: join(dir, 'actions'),
    getProjectActionsDir: (repoPath: string): string =>
      join(repoPath, '.canopy', 'actions'),
    getProjectPipelinesDir: (repoPath: string): string =>
      join(repoPath, '.canopy', 'pipelines'),
  };
}

describe('execution state status reasons', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'execution-reasons-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.each([42, {}, [{ request: 'lookup', identity: 'file', contentHash: 42 }]])(
    'rejects malformed persisted child authorizations: %j',
    async (child_pipeline_authorizations): Promise<void> => {
      await writeFile(
        join(dir, 'legacy-paused.json'),
        JSON.stringify(legacyState({ child_pipeline_authorizations })),
      );
      await expect(loadExecutionState('legacy-paused', dir)).rejects.toThrow(
        'child pipeline authorizations',
      );
    },
  );

  it('migrates a v5 input pause to a deterministic current-version reason', async () => {
    await writeFile(
      join(dir, 'legacy-paused.json'),
      JSON.stringify(legacyState()),
    );
    const first = await loadExecutionState('legacy-paused', dir);
    const second = await loadExecutionState('legacy-paused', dir);
    expect(first).toMatchObject({
      version: 10,
      status: 'paused',
      status_reasons: [
        {
          kind: 'input_required',
          code: 'input_requested',
          source: { job_id: 'job', step_id: 'step' },
        },
      ],
    });
    expect(first?.status_reasons[0]?.id).toBe(second?.status_reasons[0]?.id);
  });

  it('normalizes an unexplained legacy pause to action_paused', async () => {
    await writeFile(
      join(dir, 'legacy-paused.json'),
      JSON.stringify(
        legacyState({
          pending_input: undefined,
          jobs: {
            job: {
              status: 'paused',
              steps: {
                step: {
                  status: 'success',
                  outputs: {},
                  dynamic_env: {},
                  completed_at: '2026-01-01T00:01:00.000Z',
                },
              },
              outputs: {},
            },
          },
        }),
      ),
    );
    const state = await loadExecutionState('legacy-paused', dir);
    expect(state?.status_reasons).toMatchObject([
      { kind: 'action_paused', code: 'action_requested_pause' },
    ]);
  });

  it('preserves a current resumable pause without a synthetic checkpoint reason', async () => {
    const state: ExecutionState = {
      version: 7,
      id: 'current-paused',
      pipeline_id: 'current-paused-pipeline',
      pipeline_snapshot: normalizePipeline({
        name: 'Current paused pipeline',
        on: 'dispatch',
        jobs: {
          job: {
            steps: [
              {
                id: 'step',
                shell: 'node',
                run: "process.stdout.write('resumed')",
              },
            ],
          },
        },
      }),
      status: 'paused',
      status_reasons: [],
      jobs: {
        job: {
          status: 'paused',
          steps: {
            step: {
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
      started_at: '2026-01-01T00:00:00.000Z',
      cwd: dir,
      env: {},
      inputs: {},
      event_name: 'dispatch',
    };
    await saveExecutionState(state, dir);
    const loaded = await loadExecutionState('current-paused', dir);
    if (!loaded) {
      throw new Error('Expected current paused state');
    }
    expect(loaded.status_reasons).toEqual([]);

    await saveExecutionState(loaded, dir);
    const reloaded = await loadExecutionState('current-paused', dir);
    if (!reloaded) {
      throw new Error('Expected persisted current paused state');
    }
    expect(reloaded.status_reasons).toEqual([]);
    const handle = await resumePipeline(reloaded.id, {
      cwd: dir,
      runtime: createRuntime(dir),
    });
    await expect(handle.waitForCompletion()).resolves.toMatchObject({
      status: 'success',
      status_reasons: [],
      jobs: {
        job: {
          status: 'success',
        },
      },
    });
  });

  it.each([5, 6] as const)(
    'migrates and resumes an unexplained v%s paused job',
    async (version) => {
      const id = `legacy-paused-v${version}`;
      const pipeline = normalizePipeline({
        name: `Legacy paused v${version}`,
        on: 'dispatch',
        jobs: {
          job: {
            steps: [
              {
                id: 'step',
                shell: 'node',
                run: "process.stdout.write('resumed')",
              },
            ],
          },
        },
      });
      await writeFile(
        join(dir, `${id}.json`),
        JSON.stringify(
          legacyState({
            version,
            id,
            pipeline_snapshot: pipeline,
            pending_input: undefined,
            cwd: dir,
            ...(version === 6 ? { status_reasons: [] } : {}),
            jobs: {
              job: {
                status: 'paused',
                steps: {
                  step: {
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
          }),
        ),
      );

      const loaded = await loadExecutionState(id, dir);
      expect(loaded).toMatchObject({
        version: 10,
        status: 'paused',
        status_reasons: [
          {
            kind: 'action_paused',
            code: 'action_requested_pause',
          },
        ],
      });

      const handle = await resumePipeline(id, {
        cwd: dir,
        runtime: createRuntime(dir),
      });
      await expect(handle.waitForCompletion()).resolves.toMatchObject({
        status: 'success',
        status_reasons: [],
        jobs: {
          job: {
            status: 'success',
          },
        },
      });
    },
  );

  it('rejects an explicit stale reason instead of resuming defaults', async () => {
    await writeFile(
      join(dir, 'legacy-paused.json'),
      JSON.stringify(legacyState()),
    );
    await expect(
      resumePipeline('legacy-paused', {
        cwd: dir,
        runtime: createRuntime(dir),
        statusReasonIds: ['123e4567-e89b-42d3-a456-426614174099'],
      }),
    ).rejects.toThrow('is stale or does not belong to execution');
  });

  it('drops malformed v6 reasons and projects summaries without diagnostics', async () => {
    const validId = '123e4567-e89b-42d3-a456-426614174000';
    await writeFile(
      join(dir, 'legacy-paused.json'),
      JSON.stringify(
        legacyState({
          version: 6,
          status_reasons: [
            { id: 'bad', kind: 'invented' },
            {
              id: validId,
              kind: 'provider_usage_limit',
              code: 'usage_limit_exceeded',
              provider: 'codex',
              account_scope: 'native',
              detected_at: '2026-01-01T00:02:00.000Z',
              diagnostic_message: 'token=secret-value',
              source: {
                job_id: 'job',
                step_id: 'step',
                attempt: 0,
                iteration: 1,
              },
            },
          ],
        }),
      ),
    );
    const state = await loadExecutionState('legacy-paused', dir);
    const before = structuredClone(state);
    const summaries = await listExecutionSummaries(dir);
    expect(summaries[0]?.status_reasons).toEqual([
      {
        id: validId,
        kind: 'provider_usage_limit',
        code: 'usage_limit_exceeded',
        provider: 'codex',
        account_scope: 'native',
        detected_at: '2026-01-01T00:02:00.000Z',
        source: {
          job_id: 'job',
          step_id: 'step',
          attempt: 0,
          iteration: 1,
        },
      },
    ]);
    expect(summaries[0]).not.toHaveProperty('diagnostic_message');
    expect(state).toEqual(before);
  });

  it('reloads and resumes a Copilot recovery checkpoint after a restart', async () => {
    await writeFile(
      join(dir, 'legacy-paused.json'),
      JSON.stringify(
        legacyState({
          version: 6,
          pending_input: undefined,
          status_reasons: [],
        }),
      ),
    );
    const state = await loadExecutionState('legacy-paused', dir);
    if (!state) throw new Error('Expected execution state');
    const reasonId = '123e4567-e89b-42d3-a456-426614174001';
    state.status_reasons = [
      {
        id: reasonId,
        kind: 'provider_usage_limit',
        code: 'rate_limit',
        provider: 'copilot',
        agent_harness: 'copilot',
        account_scope: 'native',
        detected_at: '2026-01-01T00:02:00.000Z',
        source: { job_id: 'job', step_id: 'step', attempt: 0, iteration: 1 },
      },
    ];
    state.jobs.job.steps.step = {
      status: 'paused',
      outputs: {},
      dynamic_env: {},
      agent_recovery: {
        version: 2,
        reason_id: reasonId,
        action: 'agent-prompt',
        provider: 'copilot',
        harness: 'copilot',
        session_id: 'copilot-conversation',
        had_agent_activity: true,
        strategy: 'continue_session',
        recovery_count: 0,
        paused_at: '2026-01-01T00:02:00.000Z',
        failure_message: 'limited',
      },
    };
    await saveExecutionState(state, dir);
    const reloaded = await loadExecutionState(state.id, dir);
    if (!reloaded) throw new Error('Expected reloaded execution');
    expect(reloaded.jobs.job.steps.step.agent_recovery).toEqual(
      state.jobs.job.steps.step.agent_recovery,
    );
    const resumed = prepareExecutionResume(reloaded, {
      statusReasonIds: [reasonId],
    });
    expect(resumed.jobs.job.steps.step.agent_recovery).toMatchObject({
      harness: 'copilot',
      session_id: 'copilot-conversation',
      strategy: 'continue_session',
    });
  });

  it('preserves continuation checkpoints when resuming interrupted recovery', async () => {
    await writeFile(
      join(dir, 'legacy-paused.json'),
      JSON.stringify(
        legacyState({
          version: 6,
          pending_input: undefined,
          status_reasons: [],
        }),
      ),
    );
    const state = await loadExecutionState('legacy-paused', dir);
    if (!state) throw new Error('Expected execution state');

    const firstId = '123e4567-e89b-42d3-a456-426614174001';
    const secondId = '123e4567-e89b-42d3-a456-426614174002';
    const firstReason = {
      id: firstId,
      kind: 'provider_usage_limit' as const,
      code: 'rate_limit' as const,
      provider: 'claude' as const,
      account_scope: 'native' as const,
      detected_at: '2026-01-01T00:02:00.000Z',
      source: {
        job_id: 'job',
        step_id: 'step',
        attempt: 0,
        iteration: 1,
      },
    };
    const secondReason = {
      ...firstReason,
      id: secondId,
      provider: 'codex' as const,
      code: 'usage_limit_exceeded' as const,
      source: { ...firstReason.source, job_id: 'other' },
    };
    state.pipeline_snapshot.jobs.other = structuredClone(
      state.pipeline_snapshot.jobs.job,
    );
    state.jobs.other = structuredClone(state.jobs.job);
    state.jobs.job.status = 'paused';
    state.jobs.other.status = 'paused';
    state.jobs.job.steps.step = {
      status: 'paused',
      outputs: {},
      dynamic_env: {},
      agent_recovery: {
        version: 1,
        reason_id: firstId,
        action: 'agent-prompt',
        provider: 'claude',
        session_id: 'claude-session',
        had_agent_activity: true,
        strategy: 'continue_session',
        recovery_count: 0,
        paused_at: firstReason.detected_at,
        failure_message: 'limited',
      },
    };
    state.jobs.other.steps.step = {
      status: 'paused',
      outputs: {},
      dynamic_env: {},
      agent_recovery: {
        version: 1,
        reason_id: secondId,
        action: 'agent-prompt',
        provider: 'codex',
        had_agent_activity: false,
        strategy: 'restart_step',
        recovery_count: 0,
        paused_at: secondReason.detected_at,
        failure_message: 'limited',
      },
    };
    state.status_reasons = [firstReason, secondReason];
    const recoveringStep = state.jobs.job.steps.step;
    recoveringStep.status = 'running';
    recoveringStep.recovery_count = 1;
    if (!recoveringStep.agent_recovery) {
      throw new Error('Expected recovery checkpoint');
    }
    recoveringStep.agent_recovery.recovery_count = 1;
    recoveringStep.agent_recovery_history = [
      {
        reason: structuredClone(firstReason),
        strategy: 'continue_session',
        recovery_number: 1,
        started_at: '2026-01-01T00:03:00.000Z',
        status: 'running',
      },
    ];

    const activeState = structuredClone(state);
    activeState.status = 'running';
    activeState.jobs.other.status = 'running';
    const activelyPrepared = prepareActiveExecutionResume(activeState, {
      statusReasonIds: [firstId],
    });

    expect(() =>
      prepareActiveExecutionResume(activeState, {
        statusReasonIds: ['123e4567-e89b-42d3-a456-426614174099'],
      }),
    ).toThrow('is stale or does not belong to execution');

    expect(activelyPrepared.status).toBe('running');
    expect(activelyPrepared.jobs.job.status).toBe('queued');
    expect(activelyPrepared.jobs.other.status).toBe('running');
    expect(activelyPrepared.status_reasons.map((reason) => reason.id)).toEqual([
      secondId,
    ]);

    const prepared = prepareExecutionResume(state, {
      statusReasonIds: [firstId],
    });

    expect(prepared.status).toBe('pending');
    expect(prepared.jobs.job.status).toBe('queued');
    expect(prepared.jobs.other.status).toBe('paused');
    expect(prepared.status_reasons.map((reason) => reason.id)).toEqual([
      secondId,
    ]);
    expect(prepared.jobs.job.steps.step.agent_recovery_history).toHaveLength(2);
    expect(
      prepared.jobs.job.steps.step.agent_recovery_history?.[1],
    ).toMatchObject({
      strategy: 'continue_session',
      recovery_number: 2,
      status: 'running',
    });
    expect(prepared.jobs.job.steps.step.recovery_count).toBe(2);
    expect(prepared.jobs.job.steps.step.agent_recovery).toMatchObject({
      reason_id: firstId,
      session_id: 'claude-session',
      recovery_count: 2,
    });
  });
});
