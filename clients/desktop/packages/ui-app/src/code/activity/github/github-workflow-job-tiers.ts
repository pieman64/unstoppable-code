import type { GitHubWorkflowRunRowJob } from './GitHubWorkflowRunRow';

interface DatedJob {
  jobId: string;
  index: number;
  createdAt: number;
  completedAt: number | undefined;
}

function timestampMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Group workflow jobs into dependency tiers for the shared dot progress bar.
 *
 * GitHub's jobs API carries no `needs` data, but GitHub only creates a job
 * record once every job it depends on has completed, and jobs still blocked
 * on `needs` are not listed at all. A job therefore belongs one tier below
 * the deepest job that had already completed when it was created; jobs that
 * were created while nothing had completed form the first tier. Jobs are
 * kept in their given (GitHub) order within a tier.
 *
 * Any job without a valid `createdAt` (cursors persisted before the timestamp
 * was captured) makes the inference unsafe, so the jobs then render as a
 * single tier, exactly as before.
 */
export function githubWorkflowJobTiers(
  jobs: readonly GitHubWorkflowRunRowJob[],
): string[][] {
  if (jobs.length === 0) return [];
  const dated: DatedJob[] = [];
  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index];
    const createdAt = timestampMs(job.createdAt);
    if (createdAt === undefined) return [jobs.map((entry) => entry.jobId)];
    dated.push({
      jobId: job.jobId,
      index,
      createdAt,
      completedAt: timestampMs(job.completedAt),
    });
  }
  dated.sort(
    (left, right) =>
      left.createdAt - right.createdAt || left.index - right.index,
  );

  const completed: Array<{ completedAt: number; tier: number }> = [];
  const placements = new Map<string, { index: number; tier: number }>();
  let tierCount = 0;
  for (const job of dated) {
    let tier = 0;
    for (const prior of completed) {
      if (prior.completedAt <= job.createdAt) {
        tier = Math.max(tier, prior.tier + 1);
      }
    }
    placements.set(job.jobId, { index: job.index, tier });
    tierCount = Math.max(tierCount, tier + 1);
    if (job.completedAt !== undefined) {
      completed.push({ completedAt: job.completedAt, tier });
    }
  }

  const tiers: string[][] = Array.from({ length: tierCount }, () => []);
  for (const [jobId, placement] of Array.from(placements.entries()).sort(
    (left, right) => left[1].index - right[1].index,
  )) {
    tiers[placement.tier].push(jobId);
  }
  return tiers;
}
