import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ExecutionState } from '../../../types/pipeline';
import { loadExecutionState, saveExecutionState } from './execution-state';
import { refreshAllJobGroups } from './job-scheduler';
import { isKnownOrphanedExecution } from './pipeline-executor';
import {
  buildAgentRecoveryStepResult,
  buildNestedPipelineOutputs,
} from './step-runner';
import { pauseInterruptedExecution } from './shutdown-recovery';

function isTerminalExecutionStatus(
  status: ExecutionState['status'],
): status is 'success' | 'failure' | 'cancelled' {
  return status === 'success' || status === 'failure' || status === 'cancelled';
}

/** Recover only executions whose recorded process owner has exited. */
export async function recoverOrphanedPipelineExecutions(
  executionIds: readonly string[],
  executionsDir: string,
): Promise<string[]> {
  const errors: string[] = [];
  const recovered = new Map<string, ExecutionState | null>();
  const visiting = new Set<string>();
  const recover = async (id: string): Promise<ExecutionState | null> => {
    if (recovered.has(id)) return recovered.get(id) ?? null;
    if (visiting.has(id))
      throw new Error(`Cyclic child execution reference: ${id}`);
    visiting.add(id);
    try {
      const state = await loadExecutionState(id, executionsDir);
      if (
        !state ||
        !['pending', 'running'].includes(state.status) ||
        !isKnownOrphanedExecution(state)
      ) {
        recovered.set(id, state);
        return state;
      }
      const interrupted = new Set<string>();
      for (const [jobId, job] of Object.entries(state.jobs)) {
        if (
          ['success', 'failure', 'cancelled', 'skipped', 'paused'].includes(
            job.status,
          )
        )
          continue;
        interrupted.add(jobId);
        for (const [stepId, step] of Object.entries(job.steps)) {
          if (step.status !== 'running') continue;
          const definition = state.job_definitions[jobId]?.steps.find(
            (candidate) => candidate.id === stepId,
          );
          if (step.child_execution_id) {
            const child = await recover(step.child_execution_id);
            if (child && ['running', 'pending'].includes(child.status)) {
              throw new Error(
                `Child execution ${child.id} still has a live or unknown owner`,
              );
            }
            if (child?.status === 'paused') {
              const reasons = child.status_reasons.map((reason) => ({
                ...reason,
                id: randomUUID(),
                source: {
                  job_id: jobId,
                  step_id: stepId,
                  attempt: job.retry_count ?? 0,
                  iteration: Math.max(1, job.iteration_count ?? 1),
                  child_execution_id: child.id,
                  child_reason_id: reason.id,
                },
              }));
              if (child.shutdown_checkpoint)
                reasons.push({
                  id: randomUUID(),
                  kind: 'app_shutdown',
                  code: 'app_shutdown',
                  detected_at: child.shutdown_checkpoint.detected_at,
                  source: {
                    job_id: jobId,
                    step_id: stepId,
                    attempt: job.retry_count ?? 0,
                    iteration: Math.max(1, job.iteration_count ?? 1),
                    child_execution_id: child.id,
                    child_reason_id: child.shutdown_checkpoint.id,
                  },
                });
              if (reasons.length) {
                step.status = 'paused';
                step.pause_reasons = reasons;
                state.status_reasons.push(...reasons);
                job.status = 'paused';
                continue;
              }
            }
            if (child && isTerminalExecutionStatus(child.status)) {
              const status = child.status;
              Object.assign(step, {
                status,
                conclusion: status,
                outcome: status,
                completed_at: child.completed_at,
                outputs: buildNestedPipelineOutputs(child),
              });
              if (
                status === 'cancelled' ||
                (status === 'failure' && !definition?.continue_on_error)
              ) {
                Object.assign(job, {
                  status,
                  conclusion: status,
                  outcome: status,
                  completed_at: child.completed_at,
                });
                interrupted.delete(jobId);
              }
              continue;
            }
            // Missing child state or an action/input-only pause cannot safely
            // be replayed as a fresh nested pipeline. Keep a visible blocker.
            step.log_format_hint = 'agent';
          }
          if (
            definition?.uses === 'builtin/run-pipeline' &&
            !step.child_execution_id
          )
            step.log_format_hint = 'agent';
          if (
            definition &&
            ['builtin/agent-prompt', 'builtin/agent-resume'].includes(
              definition.uses ?? '',
            )
          ) {
            step.log_format_hint = 'agent';
            // Discard a prior attempt's checkpoint before reconstructing this
            // attempt from its log. Missing evidence must block automatic replay.
            delete step.agent_recovery;
            const result = step.log_file
              ? await buildAgentRecoveryStepResult({
                  result: {
                    ...step,
                    status: 'cancelled',
                    conclusion: 'cancelled',
                    outcome: 'cancelled',
                    log_file: step.log_file,
                  },
                  step: definition,
                  tempDir: join(executionsDir, id),
                  executionDir: join(executionsDir, id),
                  attempt: job.retry_count ?? 0,
                  iteration: Math.max(1, job.iteration_count ?? 1),
                  jobId,
                  stepId,
                  model: step.agent_model,
                  shutdown: true,
                  crashed: true,
                })
              : null;
            if (result?.pause_reason) {
              // The catalog can change between launches. The saved process
              // metadata remains authoritative for this provider session.
              if (result.agent_recovery) {
                result.agent_recovery.provider =
                  step.agent_provider ?? result.agent_recovery.provider;
                result.agent_recovery.harness =
                  step.agent_harness ?? result.agent_recovery.harness;
                result.pause_reason.provider = result.agent_recovery.provider;
                result.pause_reason.agent_harness =
                  result.agent_recovery.harness;
              }
              Object.assign(step, result);
              state.status_reasons.push(result.pause_reason);
              job.status = 'paused';
            }
          }
        }
      }
      pauseInterruptedExecution(state, interrupted);
      refreshAllJobGroups(state);
      // A crash after the final step persisted must not turn completed work
      // into an unresumable pause with no checkpoint.
      if (
        !state.status_reasons.length &&
        !state.pending_pauses.length &&
        Object.values(state.job_groups).every((job) =>
          ['success', 'failure', 'cancelled', 'skipped'].includes(job.status),
        )
      ) {
        state.status = Object.values(state.jobs).some(
          (job) => job.status === 'failure',
        )
          ? 'failure'
          : Object.values(state.jobs).some((job) => job.status === 'cancelled')
            ? 'cancelled'
            : 'success';
        state.completed_at = new Date().toISOString();
        delete state.shutdown_checkpoint;
      }
      await saveExecutionState(state, executionsDir);
      recovered.set(id, state);
      return state;
    } finally {
      visiting.delete(id);
    }
  };
  for (const id of executionIds) {
    try {
      await recover(id);
    } catch (error) {
      errors.push(`Pipeline ${id}: ${String(error)}`);
    }
  }
  return errors;
}
