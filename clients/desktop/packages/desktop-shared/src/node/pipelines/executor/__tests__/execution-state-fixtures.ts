import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { normalizePipeline } from '@canopy/execution-engine/pipelines/normalize-pipeline';
import { createInitialState } from '../pipeline-executor';
import type {
  AgentRecoveryCheckpoint,
  ExecutionRuntime,
  ExecutionState,
  PipelinePauseCheckpoint,
  PipelineStatusReason,
} from '../types';

/*
 * The current-format execution state fixture and the shape each historical
 * writer (versions 1 to 10) produced from it. The current-format golden pins
 * how the store loads them; the worker detail projection golden (CAN-6117)
 * maps the loaded states onto the wire.
 */

export const EXECUTION_ID = 'current-format';
export const STARTED_AT = '2026-01-01T00:00:00.000Z';
export const INPUT_REASON_ID = '123e4567-e89b-42d3-a456-426614174001';
export const PROVIDER_REASON_ID = '123e4567-e89b-42d3-a456-426614174002';
export const CHILD_REASON_ID = '123e4567-e89b-42d3-a456-426614174003';
export const INPUT_CHECKPOINT_ID = '123e4567-e89b-42d3-a456-426614174004';
export const AUTHENTICATION_ATTEMPT_ID = '123e4567-e89b-42d3-a456-426614174005';
export const INPUT_REQUEST = {
  fields: [{ key: 'answer', label: 'Answer', type: 'string' as const }],
};

/** Mirrors the store's deterministic legacy pause identity. */
export function deterministicId(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(
    17,
    20,
  )}-${hex.slice(20, 32)}`;
}

export function inputReason(): PipelineStatusReason {
  return {
    id: INPUT_REASON_ID,
    kind: 'input_required',
    code: 'input_requested',
    detected_at: '2026-01-01T00:01:00.000Z',
    source: { job_id: 'ask', step_id: 'question', attempt: 0, iteration: 1 },
  };
}

export function providerReason(): PipelineStatusReason {
  return {
    id: PROVIDER_REASON_ID,
    kind: 'provider_usage_limit',
    code: 'rate_limit',
    provider: 'copilot',
    agent_harness: 'copilot',
    authentication_attempt_id: AUTHENTICATION_ATTEMPT_ID,
    account_scope: 'native',
    account_proxy_connection_id: 'proxy-connection',
    auto_resume_suppressed: true,
    model: 'gpt-5',
    detected_at: '2026-01-01T00:02:00.000Z',
    resets_at: '2026-01-01T05:00:00.000Z',
    diagnostic_message: 'Usage limit reached',
    source: {
      job_id: 'agent',
      step_id: 'prompt',
      attempt: 0,
      iteration: 1,
      child_execution_id: 'child-execution',
      child_reason_id: CHILD_REASON_ID,
    },
  };
}

export function recoveryCheckpoint(dir: string): AgentRecoveryCheckpoint {
  return {
    version: 2,
    reason_id: PROVIDER_REASON_ID,
    action: 'agent-prompt',
    provider: 'copilot',
    harness: 'copilot',
    step_id: 'prompt',
    session_id: 'copilot-conversation',
    had_agent_activity: true,
    strategy: 'continue_session',
    recovery_count: 0,
    paused_at: '2026-01-01T00:02:00.000Z',
    transcript_file: join(dir, EXECUTION_ID, 'agent', 'transcript.jsonl'),
    failure_message: 'Usage limit reached',
  };
}

export function inputCheckpoint(): PipelinePauseCheckpoint {
  return {
    id: INPUT_CHECKPOINT_ID,
    kind: 'input',
    job_id: 'ask',
    logical_job_id: 'ask',
    step_id: 'question',
    attempt: 0,
    iteration: 1,
    detected_at: '2026-01-01T00:01:00.000Z',
    request: INPUT_REQUEST,
  };
}

export function createRuntime(dir: string): ExecutionRuntime {
  return {
    // Pipeline fixtures do not enforce an org model policy.
    isModelBlockedByOrgPolicy: (): Promise<boolean> => Promise.resolve(false),
    isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
    executionsDir: dir,
    tempRootDir: join(dir, 'tmp'),
    bundledActionsDir: join(dir, 'actions'),
    getProjectActionsDir: (repoPath: string): string => repoPath,
    getProjectPipelinesDir: (repoPath: string): string => repoPath,
  };
}

/** A paused current-format execution: one input pause and one provider pause. */
export function pausedState(dir: string): ExecutionState {
  const state = createInitialState(
    normalizePipeline({
      name: 'Current format',
      on: 'dispatch',
      jobs: {
        ask: { steps: [{ id: 'question', run: 'echo question' }] },
        agent: { steps: [{ id: 'prompt', run: 'echo prompt' }] },
      },
    }),
    { cwd: dir, pipelineId: 'current-format', runtime: createRuntime(dir) },
    EXECUTION_ID,
  );
  state.started_at = STARTED_AT;
  state.status = 'paused';
  state.jobs.ask = {
    status: 'paused',
    steps: {
      question: {
        status: 'paused',
        outputs: {},
        dynamic_env: {},
        pause_requested: true,
        input_request: INPUT_REQUEST,
      },
    },
    outputs: {},
    retry_count: 0,
    iteration_count: 1,
  };
  state.jobs.agent = {
    status: 'paused',
    steps: {
      prompt: {
        status: 'paused',
        outputs: {},
        dynamic_env: {},
        recovery_count: 0,
        agent_recovery: recoveryCheckpoint(dir),
      },
    },
    outputs: {},
    retry_count: 0,
    iteration_count: 1,
  };
  state.status_reasons = [inputReason(), providerReason()];
  state.pending_pauses = [inputCheckpoint()];
  state.pending_input = {
    job_id: 'ask',
    step_id: 'question',
    request: INPUT_REQUEST,
  };
  state.authentication_pause = {
    attempt_id: AUTHENTICATION_ATTEMPT_ID,
    reason_ids: [PROVIDER_REASON_ID],
  };
  return state;
}

export function serializedRecord(value: unknown): Record<string, unknown> {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Expected a serialized record');
  }
  const record: Record<string, unknown> = {};
  Object.assign(record, parsed);
  return record;
}

/** Rewrites the current fixture in the shape each historical writer produced. */
export function legacyFixture(
  state: ExecutionState,
  version: number,
): Record<string, unknown> {
  const raw = serializedRecord(state);
  raw.version = version;
  if (version < 8) {
    delete raw.job_definitions;
    delete raw.job_groups;
    delete raw.pending_pauses;
    const jobs = structuredClone(state.jobs);
    for (const job of Object.values(jobs)) {
      for (const step of Object.values(job.steps)) delete step.pause_requested;
      // v1 counted iterations from zero.
      if (version === 1) job.iteration_count = 0;
    }
    raw.jobs = jobs;
  }
  if (version < 6) delete raw.status_reasons;
  return raw;
}
