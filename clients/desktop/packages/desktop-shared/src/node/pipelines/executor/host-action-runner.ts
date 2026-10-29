/**
 * Runs a host step (`runs.using: host`) by raising one typed worker-to-core
 * request through `ExecutionRuntime.pipelineHostActions`.
 *
 * The executor owns input validation, the idempotency key and the step's
 * deadline; the host owns policy and the work. A typed failure still returns
 * the action's outputs plus `failure_reason`, so `continue_on_error` and later
 * expressions can branch on it. Input values are user text and never logged.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
  buildPipelineHostIdempotencyKey,
  emptyMoveToGroupOutputs,
  isPipelineHostActionId,
  parseMoveToGroupInputs,
  PIPELINE_HOST_FAILURE_REASON_OUTPUT,
  PIPELINE_NEEDS_DESKTOP_MESSAGE,
  type PipelineHostActionId,
  type PipelineHostFailureReason,
} from '@canopy/desktop-shared/pipelines/host-actions';
import type { UsageInitiationSource } from '@canopy/desktop-shared/types';
import type { ResolvedActionRuntime } from '../action-resolver';
import {
  createSetupWithdrawal,
  SETUP_WITHDRAWN,
  stepTimedOutMessage,
} from '../step-timeout';
import type { RunStepOptions, StepLogMetadata } from './step-runner';
import type {
  ExecutionRuntime,
  PipelineHostActionCaller,
  PipelineHostActionRequest,
  PipelineHostActionResult,
  PipelineHostActions,
  StepResult,
} from './types';

export interface HostActionStepOptions {
  step: RunStepOptions['step'];
  runtime: ExecutionRuntime;
  signal: AbortSignal;
  executionId: string;
  jobId: string;
  /** The step id the executor tracks (a composite's child step is `<parent>/<child>`). */
  stepId: string;
  attempt: number;
  iteration: number;
  childId?: string;
  pipelineId?: string;
  pipelineName?: string;
  executionContext?: string;
  initiationSource?: UsageInitiationSource;
  /** `rawInputValues` from `runStepBody` (already resolved against the manifest defaults). */
  inputValues: Record<string, string>;
  logFile: string;
  logMetadata: StepLogMetadata;
}

type HostCallOutcome =
  | { kind: 'result'; result: PipelineHostActionResult }
  | { kind: 'threw'; error: unknown }
  | { kind: 'timeout' }
  | { kind: 'cancelled' };

type HostRequestBuild =
  | {
      ok: true;
      request: PipelineHostActionRequest;
      emptyOutputs: Record<string, string>;
    }
  | { ok: false; message: string; emptyOutputs: Record<string, string> };

function buildHostRequest(
  actionId: PipelineHostActionId,
  inputValues: Record<string, string>,
): HostRequestBuild {
  switch (actionId) {
    case 'move-to-group': {
      const parsed = parseMoveToGroupInputs(inputValues);
      const emptyOutputs = emptyMoveToGroupOutputs();
      return parsed.ok
        ? {
            ok: true,
            request: { action: actionId, inputs: parsed.value },
            emptyOutputs,
          }
        : { ok: false, message: parsed.message, emptyOutputs };
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function appendHostLog(logFile: string, line: string): Promise<void> {
  await fsp.mkdir(path.dirname(logFile), { recursive: true });
  await fsp.appendFile(logFile, `${line}\n`, 'utf-8');
}

/** Bounds the host call by the step's deadline and its caller's cancellation. */
async function callHostWithDeadline(
  port: PipelineHostActions,
  request: PipelineHostActionRequest,
  caller: PipelineHostActionCaller,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<HostCallOutcome> {
  const withdrawal = createSetupWithdrawal(signal, timeoutMs);
  try {
    // The call runs on the withdrawal's signal, so a stop or timeout aborts it;
    // a result that settles after withdrawal can no longer change the step.
    const work = (async (): Promise<PipelineHostActionResult> =>
      port.run(request, caller, withdrawal.signal))();
    const result = await withdrawal.race(work);
    if (result === SETUP_WITHDRAWN) {
      return {
        kind: withdrawal.reason === 'timeout' ? 'timeout' : 'cancelled',
      };
    }
    return { kind: 'result', result };
  } catch (error) {
    return { kind: 'threw', error };
  } finally {
    withdrawal.release();
  }
}

export async function runHostAction(
  action: ResolvedActionRuntime,
  options: HostActionStepOptions,
): Promise<StepResult> {
  const startedAt = new Date().toISOString();
  // A host action is bundled-only, so its directory sits directly under the
  // bundled actions root; its name there is the resolver's parsed ref.
  const actionId = path.relative(
    options.runtime.bundledActionsDir,
    action.actionDir,
  );
  const label = `[host:${actionId}]`;

  const finish = (partial: {
    status: 'success' | 'failure' | 'cancelled';
    outputs: Record<string, string>;
    error?: string;
  }): StepResult => {
    return {
      ...options.logMetadata,
      status: partial.status,
      conclusion: partial.status,
      outcome: partial.status,
      outputs: partial.outputs,
      dynamic_env: {},
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      ...(partial.error !== undefined ? { error: partial.error } : {}),
      log_file: options.logFile,
    };
  };

  const typedFailure = async (
    failureReason: PipelineHostFailureReason,
    error: string,
    outputs: Record<string, string>,
  ): Promise<StepResult> => {
    await appendHostLog(
      options.logFile,
      `${label} failed (${failureReason}): ${error}`,
    );
    return finish({
      status: 'failure',
      error,
      outputs: {
        ...outputs,
        [PIPELINE_HOST_FAILURE_REASON_OUTPUT]: failureReason,
      },
    });
  };

  if (options.signal.aborted) {
    await appendHostLog(options.logFile, `${label} cancelled`);
    return finish({ status: 'cancelled', outputs: {} });
  }

  if (!isPipelineHostActionId(actionId)) {
    return typedFailure(
      'unsupported_action',
      `Action "${options.step.uses ?? actionId}" is not a host action this app knows.`,
      {},
    );
  }

  const build = buildHostRequest(actionId, options.inputValues);
  if (!build.ok) {
    return typedFailure('validation_failed', build.message, build.emptyOutputs);
  }

  const caller: PipelineHostActionCaller = {
    executionId: options.executionId,
    jobId: options.jobId,
    stepId: options.stepId,
    attempt: options.attempt,
    iteration: options.iteration,
    idempotencyKey: buildPipelineHostIdempotencyKey({
      executionId: options.executionId,
      jobId: options.jobId,
      ...(options.childId !== undefined ? { childId: options.childId } : {}),
      stepId: options.stepId,
      attempt: options.attempt,
      iteration: options.iteration,
    }),
    ...(options.childId !== undefined ? { childId: options.childId } : {}),
    ...(options.pipelineId !== undefined
      ? { pipelineId: options.pipelineId }
      : {}),
    ...(options.pipelineName !== undefined
      ? { pipelineName: options.pipelineName }
      : {}),
    ...(options.executionContext !== undefined
      ? { executionContext: options.executionContext }
      : {}),
    ...(options.initiationSource !== undefined
      ? { initiationSource: options.initiationSource }
      : {}),
  };

  const port = options.runtime.pipelineHostActions;
  if (!port) {
    return typedFailure(
      'needs_desktop',
      PIPELINE_NEEDS_DESKTOP_MESSAGE,
      build.emptyOutputs,
    );
  }

  const timeoutMs = options.step.timeout_minutes * 60_000;
  const outcome = await callHostWithDeadline(
    port,
    build.request,
    caller,
    options.signal,
    timeoutMs,
  );
  switch (outcome.kind) {
    case 'cancelled':
      await appendHostLog(options.logFile, `${label} cancelled`);
      return finish({ status: 'cancelled', outputs: {} });
    case 'timeout':
      await appendHostLog(options.logFile, `${label} timed out`);
      return finish({
        status: 'failure',
        error: stepTimedOutMessage(timeoutMs),
        outputs: {},
      });
    case 'threw': {
      const message = errorMessage(outcome.error);
      await appendHostLog(options.logFile, `${label} failed: ${message}`);
      return finish({ status: 'failure', error: message, outputs: {} });
    }
    case 'result': {
      const { result } = outcome;
      if (result.status === 'failure') {
        return typedFailure(result.failureReason, result.error, result.outputs);
      }
      await appendHostLog(options.logFile, `${label} success`);
      return finish({
        status: 'success',
        outputs: {
          ...result.outputs,
          [PIPELINE_HOST_FAILURE_REASON_OUTPUT]: '',
        },
      });
    }
  }
}
