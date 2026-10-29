import type { AppAdvisorJson } from '@canopy/desktop-shared/types';
import type {
  JobResult,
  StepResult,
} from '@canopy/desktop-shared/types/pipeline';

/** Advisor-facing JSON projections for physical pipeline job results. */

/** Project one step result into the advisor's JSON shape. */
export function advisorStepJson(
  stepId: string,
  step: StepResult,
): AppAdvisorJson {
  return {
    id: stepId,
    status: step.status,
    conclusion: step.conclusion ?? null,
    outcome: step.outcome ?? null,
    startedAt: step.started_at ?? null,
    completedAt: step.completed_at ?? null,
    exitCode: step.exit_code ?? null,
    error: step.error ?? null,
    logFile: step.log_file ?? null,
  };
}

/** Project one physical job result into the advisor's JSON shape. */
export function advisorJobJson(
  jobId: string,
  jobName: string,
  job: JobResult,
): AppAdvisorJson {
  return {
    id: jobId,
    name: jobName,
    status: job.status,
    conclusion: job.conclusion ?? null,
    outcome: job.outcome ?? null,
    startedAt: job.started_at ?? null,
    completedAt: job.completed_at ?? null,
    retryCount: job.retry_count ?? 0,
    stepCount: Object.keys(job.steps).length,
    steps: Object.entries(job.steps).map(([stepId, step]) =>
      advisorStepJson(stepId, step),
    ),
  };
}
