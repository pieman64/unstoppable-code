import type {
  ExecutionState,
  PipelinePauseCheckpoint,
  PipelinePauseResponse,
  PipelineScalar,
} from '../../../types/pipeline';
import { validatePauseInputAnswers } from '../../../pipelines/pause-input-validation';

function withDefaults(
  checkpoint: PipelinePauseCheckpoint,
  answers: Record<string, PipelineScalar>,
): Record<string, PipelineScalar> {
  const merged: Record<string, PipelineScalar> = {};
  for (const field of checkpoint.request?.fields ?? []) {
    if (field.default !== undefined) merged[field.key] = field.default;
  }
  return { ...merged, ...answers };
}

export function sortPauseCheckpoints(state: ExecutionState): void {
  const logicalOrder = new Map(
    Object.keys(state.pipeline_snapshot.jobs).map((jobId, index) => [
      jobId,
      index,
    ]),
  );
  state.pending_pauses.sort((left, right) => {
    const logicalDifference =
      (logicalOrder.get(left.logical_job_id) ?? Number.MAX_SAFE_INTEGER) -
      (logicalOrder.get(right.logical_job_id) ?? Number.MAX_SAFE_INTEGER);
    if (logicalDifference !== 0) return logicalDifference;
    const leftIndex = state.job_definitions[left.job_id]?.matrix?.index ?? -1;
    const rightIndex = state.job_definitions[right.job_id]?.matrix?.index ?? -1;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    const steps = state.job_definitions[left.job_id]?.steps ?? [];
    const leftStep = steps.findIndex((step) => step.id === left.step_id);
    const rightStep = steps.findIndex((step) => step.id === right.step_id);
    return leftStep - rightStep || left.id.localeCompare(right.id);
  });
}

export interface AppliedPauseResponses {
  state: ExecutionState;
  selectedJobIds: string[];
}

export function applyPauseResponses(
  state: ExecutionState,
  responses: readonly PipelinePauseResponse[],
): AppliedPauseResponses {
  if (responses.length === 0) {
    throw new Error('pauseResponses must contain at least one response');
  }
  const prepared = structuredClone(state);
  const seen = new Set<string>();
  const selected: Array<{
    checkpoint: PipelinePauseCheckpoint;
    answers: Record<string, PipelineScalar>;
  }> = [];

  for (const response of responses) {
    const locator = `${response.job_id}\0${response.step_id}`;
    if (seen.has(locator)) {
      throw new Error(
        `Duplicate pause response for "${response.job_id}.${response.step_id}"`,
      );
    }
    seen.add(locator);
    const checkpoint = prepared.pending_pauses.find(
      (candidate) =>
        candidate.job_id === response.job_id &&
        candidate.step_id === response.step_id,
    );
    if (!checkpoint) {
      const id =
        response.checkpoint_id ?? `${response.job_id}.${response.step_id}`;
      throw new Error(`Checkpoint "${id}" is no longer pending`);
    }
    if (
      response.checkpoint_id !== undefined &&
      response.checkpoint_id !== checkpoint.id
    ) {
      throw new Error(
        `Checkpoint "${response.checkpoint_id}" is no longer pending`,
      );
    }
    const job = prepared.jobs[checkpoint.job_id];
    const step = job?.steps[checkpoint.step_id];
    if (!job || job.status !== 'paused' || !step?.pause_requested) {
      throw new Error(`Checkpoint "${checkpoint.id}" is no longer pending`);
    }
    const rawAnswers = response.answers ?? {};
    if (!checkpoint.request) {
      if (Object.keys(rawAnswers).length > 0) {
        throw new Error(
          `Checkpoint "${checkpoint.id}" does not accept answers`,
        );
      }
      selected.push({ checkpoint, answers: {} });
      continue;
    }
    const answers = withDefaults(checkpoint, rawAnswers);
    const errors = validatePauseInputAnswers(checkpoint.request, answers);
    if (errors.length > 0) {
      throw new Error(errors.join('; '));
    }
    selected.push({ checkpoint, answers });
  }

  const selectedIds = new Set(selected.map(({ checkpoint }) => checkpoint.id));
  const selectedJobIds = new Set<string>();
  for (const { checkpoint, answers } of selected) {
    const job = prepared.jobs[checkpoint.job_id];
    const step = job.steps[checkpoint.step_id];
    step.outputs = {
      ...step.outputs,
      ...Object.fromEntries(
        Object.entries(answers).map(([key, value]) => [key, String(value)]),
      ),
    };
    delete step.input_request;
    delete step.pause_requested;
    job.status = 'queued';
    job.completed_at = undefined;
    job.conclusion = undefined;
    job.outcome = undefined;
    selectedJobIds.add(checkpoint.job_id);
  }
  prepared.pending_pauses = prepared.pending_pauses.filter(
    (checkpoint) => !selectedIds.has(checkpoint.id),
  );
  prepared.status_reasons = prepared.status_reasons.filter(
    (reason) =>
      !selected.some(
        ({ checkpoint }) =>
          reason.source.job_id === checkpoint.job_id &&
          reason.source.step_id === checkpoint.step_id &&
          (reason.kind === 'input_required' || reason.kind === 'action_paused'),
      ),
  );
  return { state: prepared, selectedJobIds: Array.from(selectedJobIds) };
}
