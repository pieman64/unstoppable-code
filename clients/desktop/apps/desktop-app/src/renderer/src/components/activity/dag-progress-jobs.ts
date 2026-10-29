import type {
  ExecutionState,
  JobResult,
} from '@canopy/desktop-shared/types/pipeline';
import type { DagJobMeta, DagJobStatus } from '@canopy/ui-shared/components';

export function buildDagJobs(
  executionState: ExecutionState,
): Record<string, DagJobMeta> {
  const out: Record<string, DagJobMeta> = {};
  for (const [jobId, jobDef] of Object.entries(
    executionState.pipeline_snapshot.jobs,
  )) {
    const group = executionState.job_groups[jobId];
    const physicalJobId = group?.variant_job_ids[0] ?? jobId;
    const result = executionState.jobs[physicalJobId];
    const executionStatus = group?.status ?? result?.status;
    // The portable DAG surface has no separate queued state; queued work is
    // pending from the presentation layer's perspective.
    const status: DagJobStatus | undefined =
      executionStatus === 'queued' ? 'pending' : executionStatus;
    const variants = (group?.variant_job_ids ?? []).map(
      (id) => executionState.jobs[id],
    );
    const completedVariants = variants.filter((variant) =>
      ['success', 'failure', 'cancelled', 'skipped'].includes(variant.status),
    ).length;
    const breakdown = variants.length
      ? ['success', 'failure', 'running', 'paused']
          .map((variantStatus) => ({
            status: variantStatus,
            count: variants.filter(
              (variant) => variant.status === variantStatus,
            ).length,
          }))
          .filter(({ count }) => count > 0)
          .map(
            ({ status: variantStatus, count }) =>
              `${String(count)} ${variantStatus}`,
          )
          .join(' · ')
      : '';
    out[jobId] = {
      jobId,
      name: jobDef.name ?? jobId,
      status,
      startedAt: group?.started_at ?? result?.started_at,
      // Matrix group completion is authoritative. While a group is active its
      // completed_at is intentionally absent, even if the first variant ended.
      completedAt: group ? group.completed_at : result?.completed_at,
      stepProgress:
        group?.kind === 'matrix'
          ? undefined
          : getStepProgress(result, jobDef ?? { steps: [] }),
      // One dot per authored logical job; physical variants stay grouped.
      ...(group?.kind === 'matrix'
        ? {
            variantProgress: `${String(completedVariants)} / ${String(variants.length)} complete`,
            ...(breakdown !== '' ? { variantBreakdown: breakdown } : {}),
            ...(group.resolved_max_parallel !== undefined
              ? { maxParallel: group.resolved_max_parallel }
              : {}),
          }
        : {}),
    };
  }
  return out;
}

function getStepProgress(
  jobResult: JobResult | undefined,
  jobDef: { steps: { id: string }[] },
): string | undefined {
  if (!jobResult) return undefined;
  // Logical matrix groups have no steps of their own; variant progress is
  // reported separately.
  const total = jobDef.steps.length;
  if (total === 0) return undefined;
  let completed = 0;
  for (const step of jobDef.steps) {
    const stepResult = jobResult.steps[step.id];
    if (
      stepResult?.status === 'success' ||
      stepResult?.status === 'failure' ||
      stepResult?.status === 'cancelled' ||
      stepResult?.status === 'skipped'
    ) {
      completed++;
    }
  }
  return `${completed}/${total}`;
}
