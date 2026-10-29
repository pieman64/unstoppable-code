jest.mock('@electron-toolkit/utils', () => ({
  is: { dev: true },
}));

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  cancelPipelineExecution,
  executePipeline,
  findPendingInput,
  loadExecutionState,
  resumePipeline,
  retryPipelineExecution,
  saveExecutionState,
} from '@canopy/desktop-shared/node/pipelines/executor';
import type {
  ExecutionRuntime,
  ExecutionState,
  PipelineStatusReason,
} from '@canopy/desktop-shared/node/pipelines/executor/types';
import type { Pipeline } from '@canopy/desktop-shared/types/pipeline';
import { createPendingRequest, resolveRequest } from '../mcp/pending-requests';

function createRuntime(rootDir: string): ExecutionRuntime {
  return {
    // Pipeline fixtures do not enforce an org model policy.
    isModelBlockedByOrgPolicy: (): Promise<boolean> => Promise.resolve(false),
    isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
    executionsDir: path.join(rootDir, 'executions'),
    tempRootDir: path.join(rootDir, 'tmp'),
    bundledActionsDir: path.join(rootDir, 'actions'),
    getProjectActionsDir: (repoPath: string): string =>
      path.join(repoPath, '.canopy', 'actions'),
    getProjectPipelinesDir: (repoPath: string): string =>
      path.join(repoPath, '.canopy', 'pipelines'),
  };
}

function baseState(): ExecutionState {
  return {
    version: 5,
    id: 'e1',
    pipeline_id: 'p1',
    pipeline_snapshot: { name: 'p', jobs: {} },
    status: 'paused',
    jobs: {},
    started_at: '2026-05-30T00:00:00.000Z',
    cwd: '/tmp',
    env: {},
    inputs: {},
  };
}

function requestOutput(fieldsJson: string, title?: string): string {
  const titleJson = title ? `"title":"${title}",` : '';
  return `CANOPY_INPUT_REQUEST={${titleJson}"fields":${fieldsJson}}`;
}

describe('pending pipeline input', () => {
  let tempDir: string;
  let runtime: ExecutionRuntime;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-pending-input-'));
    runtime = createRuntime(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('findPendingInput locates the paused step carrying an input_request', () => {
    const state = baseState();
    state.jobs = {
      gate: {
        status: 'paused',
        steps: {
          ask: {
            status: 'success',
            outputs: {},
            dynamic_env: {},
            input_request: {
              fields: [{ key: 'scope', label: 'Scope', type: 'string' }],
            },
          },
        },
        outputs: {},
      },
    };

    expect(findPendingInput(state)).toEqual({
      job_id: 'gate',
      step_id: 'ask',
      request: { fields: [{ key: 'scope', label: 'Scope', type: 'string' }] },
    });
  });

  it('findPendingInput returns undefined for formless pauses', () => {
    const state = baseState();
    state.jobs = {
      gate: {
        status: 'paused',
        steps: {
          ask: { status: 'success', outputs: {}, dynamic_env: {} },
        },
        outputs: {},
      },
    };

    expect(findPendingInput(state)).toBeUndefined();
  });

  it('findPendingInput ignores non-paused jobs', () => {
    const state = baseState();
    state.jobs = {
      gate: {
        status: 'success',
        steps: {
          ask: {
            status: 'success',
            outputs: {},
            dynamic_env: {},
            input_request: {
              fields: [{ key: 'scope', label: 'Scope', type: 'string' }],
            },
          },
        },
        outputs: {},
      },
    };

    expect(findPendingInput(state)).toBeUndefined();
  });

  it('lands valid answers on the checkpoint step and resumes downstream work', async () => {
    const outputFile = path.join(tempDir, 'scope.txt');
    const pipeline: Pipeline = {
      name: 'pause input',
      on: 'dispatch',
      jobs: {
        gate: {
          steps: [
            {
              id: 'ask',
              run: [
                `printf '%s\n' '${requestOutput(
                  '[{"key":"scope","label":"Scope","type":"string","required":true}]',
                  'Review scope',
                )}' >> "$CANOPY_OUTPUT"`,
                'echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
              ].join('\n'),
            },
            {
              id: 'after',
              run: `printf '%s\n' '${'${{ steps.ask.outputs.scope }}'}' > "${outputFile}"`,
            },
          ],
        },
      },
    };

    const paused = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'pause-input',
      runtime,
      executionId: 'pause-input-exec',
    });
    const pausedState = await paused.waitForCompletion();

    expect(pausedState.status).toBe('paused');
    expect(pausedState.pending_input).toEqual({
      job_id: 'gate',
      step_id: 'ask',
      request: {
        title: 'Review scope',
        fields: [
          { key: 'scope', label: 'Scope', type: 'string', required: true },
        ],
      },
    });
    expect(fs.existsSync(outputFile)).toBe(false);

    const resumed = await resumePipeline('pause-input-exec', {
      cwd: tempDir,
      runtime,
      inputAnswers: { scope: 'desktop' },
      initiationSource: 'automation',
    });
    const resumedState = await resumed.waitForCompletion();

    expect(resumedState.status).toBe('success');
    expect(resumedState.pending_input).toBeUndefined();
    expect(resumedState.jobs.gate.steps.ask.input_request).toBeUndefined();
    expect(resumedState.jobs.gate.steps.ask.outputs.scope).toBe('desktop');
    expect(resumedState.initiation_source).toBe('automation');
    await expect(
      loadExecutionState('pause-input-exec', runtime.executionsDir),
    ).resolves.toMatchObject({ initiation_source: 'automation' });
    expect(fs.readFileSync(outputFile, 'utf8')).toBe('desktop\n');
  });

  it('rejects structured input resume without explicit answers', async () => {
    const pipeline: Pipeline = {
      name: 'optional pause input',
      on: 'dispatch',
      jobs: {
        gate: {
          steps: [
            {
              id: 'ask',
              run: [
                `printf '%s\n' '${requestOutput(
                  '[{"key":"scope","label":"Scope","type":"string","default":"desktop"}]',
                )}' >> "$CANOPY_OUTPUT"`,
                'echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
              ].join('\n'),
            },
          ],
        },
      },
    };

    const paused = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'optional-pause-input',
      runtime,
      executionId: 'optional-pause-input-exec',
    });
    await paused.waitForCompletion();

    await expect(
      resumePipeline('optional-pause-input-exec', {
        cwd: tempDir,
        runtime,
      }),
    ).rejects.toThrow('execution is waiting for input answers');

    const persisted = await loadExecutionState(
      'optional-pause-input-exec',
      runtime.executionsDir,
    );
    expect(persisted?.status).toBe('paused');
    expect(persisted?.pending_input?.step_id).toBe('ask');
  });

  it('rejects a selected input-required reason without answers', async () => {
    const outputFile = path.join(tempDir, 'selected-input-output.txt');
    const pipeline: Pipeline = {
      name: 'selected input reason',
      on: 'dispatch',
      jobs: {
        gate: {
          steps: [
            {
              id: 'ask',
              run: [
                `printf '%s\n' '${requestOutput(
                  '[{"key":"scope","label":"Scope","type":"string","required":true}]',
                )}' >> "$CANOPY_OUTPUT"`,
                'echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
              ].join('\n'),
            },
            {
              id: 'after',
              run: `printf 'continued' > "${outputFile}"`,
            },
          ],
        },
      },
    };

    const handle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'selected-input-reason',
      runtime,
      executionId: 'selected-input-reason-exec',
    });
    const paused = await handle.waitForCompletion();
    const inputReason = paused.status_reasons.find(
      (reason) => reason.kind === 'input_required',
    );
    if (!inputReason) throw new Error('Expected an input-required reason');

    await expect(
      resumePipeline('selected-input-reason-exec', {
        cwd: tempDir,
        runtime,
        statusReasonIds: [inputReason.id],
      }),
    ).rejects.toThrow('execution is waiting for input answers');

    const persisted = await loadExecutionState(
      'selected-input-reason-exec',
      runtime.executionsDir,
    );
    expect(persisted?.status).toBe('paused');
    expect(persisted?.status_reasons).toContainEqual(inputReason);
    expect(fs.existsSync(outputFile)).toBe(false);
  });

  it('resumes a selected provider reason while preserving unrelated pending input', async () => {
    const providerMarker = path.join(tempDir, 'provider-resumed.txt');
    const pipeline: Pipeline = {
      name: 'provider and input pauses',
      on: 'dispatch',
      jobs: {
        input_gate: {
          steps: [
            {
              id: 'ask',
              run: [
                `printf '%s\n' '${requestOutput(
                  '[{"key":"scope","label":"Scope","type":"string","required":true}]',
                )}' >> "$CANOPY_OUTPUT"`,
                'echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
              ].join('\n'),
            },
          ],
        },
        provider_job: {
          steps: [
            {
              id: 'recover',
              run: `printf 'resumed' > "${providerMarker}"`,
            },
          ],
        },
      },
    };

    const paused = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'provider-and-input-pauses',
      runtime,
      executionId: 'provider-and-input-pauses-exec',
    });
    const pausedState = await paused.waitForCompletion();
    fs.rmSync(providerMarker, { force: true });

    const providerReasonId = '123e4567-e89b-42d3-a456-426614174001';
    const providerReason: PipelineStatusReason = {
      id: providerReasonId,
      kind: 'provider_usage_limit',
      code: 'rate_limit',
      provider: 'claude',
      account_scope: 'native',
      detected_at: new Date().toISOString(),
      source: {
        job_id: 'provider_job',
        step_id: 'recover',
        attempt: 0,
        iteration: 1,
      },
    };
    pausedState.jobs.provider_job.status = 'paused';
    pausedState.jobs.provider_job.completed_at = undefined;
    pausedState.jobs.provider_job.conclusion = undefined;
    pausedState.jobs.provider_job.outcome = undefined;
    pausedState.jobs.provider_job.steps.recover = {
      status: 'paused',
      outputs: {},
      dynamic_env: {},
      agent_recovery: {
        version: 1,
        reason_id: providerReasonId,
        action: 'agent-prompt',
        provider: 'claude',
        had_agent_activity: false,
        strategy: 'restart_step',
        recovery_count: 0,
        paused_at: providerReason.detected_at,
        failure_message: 'Usage limited',
      },
    };
    pausedState.status_reasons = [
      ...pausedState.status_reasons,
      providerReason,
    ];
    await saveExecutionState(pausedState, runtime.executionsDir);

    const resumed = await resumePipeline('provider-and-input-pauses-exec', {
      cwd: tempDir,
      runtime,
      statusReasonIds: [providerReasonId],
    });
    const resumedState = await resumed.waitForCompletion();

    expect(resumedState.status).toBe('paused');
    expect(resumedState.pending_input).toEqual(pausedState.pending_input);
    expect(resumedState.jobs.input_gate.status).toBe('paused');
    expect(resumedState.jobs.input_gate.steps.ask.input_request).toEqual(
      pausedState.jobs.input_gate.steps.ask.input_request,
    );
    expect(resumedState.jobs.provider_job.status).toBe('success');
    expect(resumedState.status_reasons).toHaveLength(1);
    expect(resumedState.status_reasons[0]?.kind).toBe('input_required');
    expect(fs.readFileSync(providerMarker, 'utf8')).toBe('resumed');
  });

  it('applies field defaults server-side before injecting answers', async () => {
    const outputFile = path.join(tempDir, 'default-scope.txt');
    const pipeline: Pipeline = {
      name: 'pause input defaults',
      on: 'dispatch',
      jobs: {
        gate: {
          steps: [
            {
              id: 'ask',
              run: [
                `printf '%s\n' '${requestOutput(
                  '[{"key":"scope","label":"Scope","type":"string","default":"desktop"}]',
                )}' >> "$CANOPY_OUTPUT"`,
                'echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
              ].join('\n'),
            },
            {
              id: 'after',
              run: `printf '%s\n' '${'${{ steps.ask.outputs.scope }}'}' > "${outputFile}"`,
            },
          ],
        },
      },
    };

    const paused = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'pause-input-defaults',
      runtime,
      executionId: 'pause-input-defaults-exec',
    });
    await paused.waitForCompletion();

    const resumed = await resumePipeline('pause-input-defaults-exec', {
      cwd: tempDir,
      runtime,
      inputAnswers: {},
    });
    const resumedState = await resumed.waitForCompletion();

    expect(resumedState.status).toBe('success');
    expect(resumedState.jobs.gate.steps.ask.outputs.scope).toBe('desktop');
    expect(fs.readFileSync(outputFile, 'utf8')).toBe('desktop\n');
  });

  it('rejects invalid answers and keeps the execution paused', async () => {
    const pipeline: Pipeline = {
      name: 'pause input validation',
      on: 'dispatch',
      jobs: {
        gate: {
          steps: [
            {
              id: 'ask',
              run: [
                `printf '%s\n' '${requestOutput(
                  '[{"key":"scope","label":"Scope","type":"string","required":true}]',
                )}' >> "$CANOPY_OUTPUT"`,
                'echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
              ].join('\n'),
            },
          ],
        },
      },
    };

    const paused = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'pause-input-validation',
      runtime,
      executionId: 'pause-input-validation-exec',
    });
    await paused.waitForCompletion();

    await expect(
      resumePipeline('pause-input-validation-exec', {
        cwd: tempDir,
        runtime,
        inputAnswers: {},
      }),
    ).rejects.toThrow('scope is required');

    const persisted = await loadExecutionState(
      'pause-input-validation-exec',
      runtime.executionsDir,
    );
    expect(persisted?.status).toBe('paused');
    expect(persisted?.pending_input?.step_id).toBe('ask');
  });

  it('rejects checkpoint answers when an execution is not waiting for input', async () => {
    const pipeline: Pipeline = {
      name: 'formless pause',
      on: 'dispatch',
      jobs: {
        gate: {
          steps: [
            {
              id: 'pause',
              run: 'echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
            },
          ],
        },
      },
    };

    const paused = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'formless-pause',
      runtime,
      executionId: 'formless-pause-exec',
    });
    await paused.waitForCompletion();

    await expect(
      resumePipeline('formless-pause-exec', {
        cwd: tempDir,
        runtime,
        inputAnswers: { scope: 'desktop' },
      }),
    ).rejects.toThrow('execution is not waiting for input');
  });

  it('resumes only the selected formless pause checkpoint', async () => {
    const pipeline: Pipeline = {
      name: 'selective formless pause',
      on: 'dispatch',
      jobs: {
        first: {
          steps: [
            {
              id: 'pause_first',
              run: 'echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
            },
          ],
        },
        second: {
          steps: [
            {
              id: 'pause_second',
              run: 'echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
            },
          ],
        },
      },
    };

    const initial = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'selective-formless-pause',
      runtime,
      executionId: 'selective-formless-pause-exec',
    });
    const pausedState = await initial.waitForCompletion();
    const selectedReason = pausedState.status_reasons.find(
      (reason) => reason.source.job_id === 'first',
    );
    if (!selectedReason) {
      throw new Error('Expected a pause reason for the first job');
    }

    const resumed = await resumePipeline('selective-formless-pause-exec', {
      cwd: tempDir,
      runtime,
      statusReasonIds: [selectedReason.id],
    });
    const selectivelyResumedState = await resumed.waitForCompletion();

    expect(selectivelyResumedState.status).toBe('paused');
    expect(selectivelyResumedState.jobs.first.status).toBe('success');
    expect(selectivelyResumedState.jobs.second.status).toBe('paused');
    expect(selectivelyResumedState.pending_pauses).toMatchObject([
      { job_id: 'second', step_id: 'pause_second', kind: 'action' },
    ]);
  });

  it('resumes a selected action pause while structured input remains pending', async () => {
    const pipeline: Pipeline = {
      name: 'mixed structured and action pauses',
      on: 'dispatch',
      jobs: {
        structured: {
          steps: [
            {
              id: 'ask',
              run: [
                `printf '%s\n' '${requestOutput(
                  '[{"key":"scope","label":"Scope","type":"string","required":true}]',
                )}' >> "$CANOPY_OUTPUT"`,
                'echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
              ].join('\n'),
            },
          ],
        },
        action: {
          steps: [
            {
              id: 'pause',
              run: 'echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
            },
          ],
        },
      },
    };

    const initial = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'mixed-structured-action-pauses',
      runtime,
      executionId: 'mixed-structured-action-pauses-exec',
    });
    const pausedState = await initial.waitForCompletion();
    const actionReason = pausedState.status_reasons.find(
      (reason) =>
        reason.kind === 'action_paused' && reason.source.job_id === 'action',
    );
    if (!actionReason) {
      throw new Error('Expected an action pause reason');
    }

    const resumed = await resumePipeline(
      'mixed-structured-action-pauses-exec',
      {
        cwd: tempDir,
        runtime,
        statusReasonIds: [actionReason.id],
      },
    );
    const selectivelyResumedState = await resumed.waitForCompletion();

    expect(selectivelyResumedState.status).toBe('paused');
    expect(selectivelyResumedState.jobs.action.status).toBe('success');
    expect(selectivelyResumedState.jobs.structured.status).toBe('paused');
    expect(selectivelyResumedState.pending_pauses).toMatchObject([
      { job_id: 'structured', step_id: 'ask', kind: 'input' },
    ]);
  });

  it('does not reuse a consumed input request when the same job pauses again', async () => {
    const pipeline: Pipeline = {
      name: 'pause twice',
      on: 'dispatch',
      jobs: {
        gate: {
          steps: [
            {
              id: 'ask_one',
              run: [
                `printf '%s\n' '${requestOutput(
                  '[{"key":"first","label":"First","type":"string","required":true}]',
                )}' >> "$CANOPY_OUTPUT"`,
                'echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
              ].join('\n'),
            },
            {
              id: 'ask_two',
              run: [
                `printf '%s\n' '${requestOutput(
                  '[{"key":"second","label":"Second","type":"string","required":true}]',
                )}' >> "$CANOPY_OUTPUT"`,
                'echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
              ].join('\n'),
            },
          ],
        },
      },
    };

    const firstPause = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'pause-twice',
      runtime,
      executionId: 'pause-twice-exec',
    });
    const firstPausedState = await firstPause.waitForCompletion();
    expect(firstPausedState.pending_input?.step_id).toBe('ask_one');

    const secondPause = await resumePipeline('pause-twice-exec', {
      cwd: tempDir,
      runtime,
      inputAnswers: { first: 'one' },
    });
    const secondPausedState = await secondPause.waitForCompletion();

    expect(secondPausedState.status).toBe('paused');
    expect(secondPausedState.pending_input?.step_id).toBe('ask_two');
    expect(
      secondPausedState.jobs.gate.steps.ask_one.input_request,
    ).toBeUndefined();
    expect(secondPausedState.jobs.gate.steps.ask_one.outputs.first).toBe('one');
  });

  it('persists parallel input requests as independently addressable checkpoints', async () => {
    const pipeline: Pipeline = {
      name: 'parallel input pause',
      on: 'dispatch',
      jobs: {
        first: {
          steps: [
            {
              id: 'ask_first',
              run: [
                `printf '%s\n' '${requestOutput(
                  '[{"key":"first","label":"First","type":"string","required":true}]',
                )}' >> "$CANOPY_OUTPUT"`,
                'echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
              ].join('\n'),
            },
          ],
        },
        second: {
          steps: [
            {
              id: 'ask_second',
              run: [
                `printf '%s\n' '${requestOutput(
                  '[{"key":"second","label":"Second","type":"string","required":true}]',
                )}' >> "$CANOPY_OUTPUT"`,
                'echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
              ].join('\n'),
            },
          ],
        },
      },
    };

    const handle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'parallel-input-pause',
      runtime,
      executionId: 'parallel-input-pause-exec',
    });
    const state = await handle.waitForCompletion();

    expect(state.status).toBe('paused');
    expect(state.pending_input).toBeUndefined();
    expect(state.pending_pauses).toMatchObject([
      { job_id: 'first', step_id: 'ask_first', kind: 'input' },
      { job_id: 'second', step_id: 'ask_second', kind: 'input' },
    ]);
    expect(state.error).toBeUndefined();
  });

  it('retries a cancelled input pause from the unanswered checkpoint', async () => {
    const outputFile = path.join(tempDir, 'cancelled-input-answer.txt');
    const pipeline: Pipeline = {
      name: 'cancel input pause',
      on: 'dispatch',
      jobs: {
        gate: {
          steps: [
            {
              id: 'ask',
              run: [
                `printf '%s\n' '${requestOutput(
                  '[{"key":"answer","label":"Answer","type":"string","required":true}]',
                )}' >> "$CANOPY_OUTPUT"`,
                'echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
              ].join('\n'),
            },
            {
              id: 'after',
              run: `printf '%s\n' '${'${{ steps.ask.outputs.answer }}'}' > "${outputFile}"`,
            },
          ],
        },
      },
    };

    const paused = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'cancel-input-pause',
      runtime,
      executionId: 'cancel-input-pause-exec',
    });
    await paused.waitForCompletion();

    const cancelled = await cancelPipelineExecution(
      'cancel-input-pause-exec',
      runtime,
    );
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.jobs.gate.steps.ask.status).toBe('cancelled');
    expect(cancelled.job_groups.gate.status).toBe('cancelled');
    expect(cancelled.jobs.gate.steps.ask.input_request).toBeUndefined();

    const retried = await retryPipelineExecution('cancel-input-pause-exec', {
      cwd: tempDir,
      runtime,
    });
    const retriedState = await retried.waitForCompletion();

    expect(retriedState.status).toBe('paused');
    expect(retriedState.pending_input?.step_id).toBe('ask');
    expect(fs.existsSync(outputFile)).toBe(false);
  });
});

describe('pending-request timeout', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('rejects with ask_user_timeout and runs onTimeout after timeoutMs', async () => {
    const onTimeout = jest.fn();
    const promise = createPendingRequest('req-timeout', 'sess-a', {
      timeoutMs: 1000,
      onTimeout,
    });
    jest.advanceTimersByTime(1000);
    await expect(promise).rejects.toThrow('ask_user_timeout');
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('clears the timer when the request resolves first', async () => {
    const onTimeout = jest.fn();
    const promise = createPendingRequest('req-resolve', 'sess-b', {
      timeoutMs: 1000,
      onTimeout,
    });
    expect(resolveRequest('req-resolve', [])).toBe(true);
    jest.advanceTimersByTime(5000);
    await expect(promise).resolves.toEqual([]);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('returns false when resolving a missing request', () => {
    expect(resolveRequest('req-missing', [])).toBe(false);
  });
});
