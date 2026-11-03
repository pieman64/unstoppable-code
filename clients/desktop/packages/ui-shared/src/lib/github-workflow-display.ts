/** Display layout data. No UI, host or execution dependencies. */
type DagJobStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failure'
  | 'paused'
  | 'cancelled'
  | 'skipped';
interface DagJobMeta {
  jobId: string;
  name: string;
  status: DagJobStatus | undefined;
  startedAt?: string;
  completedAt?: string;
}

export interface GitHubWorkflowRunRowJob {
  readonly jobId: string;
  readonly name: string;
  /** GitHub job status (`queued`, `in_progress`, `completed`, ...). */
  readonly status: string;
  readonly conclusion: string | null;
  readonly htmlUrl: string;
  /** GitHub's `created_at`; drives dependency-tier inference. */
  readonly createdAt?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

/** GitHub job status/conclusion → shared DAG dot status. */
export function githubWorkflowJobDagStatus(
  job: Pick<GitHubWorkflowRunRowJob, 'status' | 'conclusion'>,
): DagJobStatus | undefined {
  if (job.status === 'completed') {
    switch (job.conclusion) {
      case 'success':
        return 'success';
      case 'failure':
      case 'timed_out':
      case 'startup_failure':
        return 'failure';
      case 'cancelled':
        return 'cancelled';
      case 'skipped':
      case 'neutral':
      case 'stale':
        return 'skipped';
      case 'action_required':
        return 'paused';
      default:
        return undefined;
    }
  }
  if (job.status === 'in_progress') return 'running';
  if (
    job.status === 'queued' ||
    job.status === 'pending' ||
    job.status === 'waiting' ||
    job.status === 'requested'
  ) {
    return 'pending';
  }
  return undefined;
}

/**
 * Display-only dependency graph shared by desktop projection and clients.
 */
export interface GitHubWorkflowRunRowGraphJob {
  readonly id: string;
  readonly template: string;
  readonly names: readonly string[];
  readonly needs: readonly string[];
  readonly dynamic: boolean;
}

export interface GitHubWorkflowRunRowGraph {
  readonly sha?: string;
  readonly jobs: readonly GitHubWorkflowRunRowGraphJob[];
}

export interface GitHubWorkflowDefinitionTiers {
  tiers: string[][];
  jobs: Record<string, DagJobMeta>;
  /** Observed jobs the definition did not account for; shown in a final tier. */
  unplaced: string[];
}

/** Prefix of placeholder dot ids for jobs GitHub has not created yet. */
export const GITHUB_PLACEHOLDER_JOB_PREFIX = 'definition:';

const EXPRESSION_SPLIT = /\$\{\{[^}]*\}\}/g;
const HAS_EXPRESSION = /\$\{\{[^}]*\}\}/;

/** A linear-time matcher for GitHub's reported templated job names. */
function templateMatcher(
  template: string,
): ((value: string) => boolean) | undefined {
  const parts = template.split(EXPRESSION_SPLIT);
  if (parts.length === 1) return (value): boolean => value === template;
  if (!parts.some((part) => part.length > 0)) return undefined;
  return (value): boolean => {
    const first = parts[0];
    if (!value.startsWith(first)) return false;
    let cursor = first.length;
    for (let index = 1; index < parts.length - 1; index += 1) {
      const part = parts[index];
      const found = value.indexOf(part, cursor);
      if (found < 0) return false;
      cursor = found + part.length;
    }
    const last = parts[parts.length - 1];
    const suffixStart = value.length - last.length;
    return suffixStart >= cursor && value.startsWith(last, suffixStart);
  };
}

/** Match constant dynamic names from matrices or nested reusable workflows. */
function constantDynamicMatcher(template: string): (value: string) => boolean {
  const matrixPrefix = `${template} (`;
  const reusablePrefix = `${template} / `;
  return (value): boolean =>
    (value.startsWith(matrixPrefix) && value.endsWith(')')) ||
    value.startsWith(reusablePrefix);
}

/**
 * Longest-path depth of every graph job over its `needs`; cycles and unknown
 * ids count as roots. Mirrors the desktop helper so both sides agree.
 */
export function githubWorkflowGraphDepths(
  jobs: readonly GitHubWorkflowRunRowGraphJob[],
): Map<string, number> {
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    const job = byId.get(id);
    if (!job || visiting.has(id)) return 0;
    visiting.add(id);
    let value = 0;
    for (const need of job.needs) {
      if (byId.has(need)) value = Math.max(value, depth(need) + 1);
    }
    visiting.delete(id);
    depths.set(id, value);
    return value;
  };
  for (const job of jobs) depth(job.id);
  return depths;
}

function dagMeta(job: GitHubWorkflowRunRowJob): DagJobMeta {
  return {
    jobId: job.jobId,
    name: job.name,
    status: githubWorkflowJobDagStatus(job),
    ...(job.startedAt ? { startedAt: job.startedAt } : {}),
    ...(job.completedAt ? { completedAt: job.completedAt } : {}),
  };
}

/**
 * Lay the run's declared job graph out as progress-bar tiers and fill each
 * slot with the observed job GitHub reported for it, or a pending placeholder
 * when GitHub has not created that job yet.
 *
 * Matching is by display name: an expanded name matches exactly; a name that
 * still holds an expression (or a dynamic-matrix job) matches GitHub's name by
 * pattern, including the literal template GitHub reports for skipped jobs it
 * never evaluated. Observed jobs nothing accounts for are kept in a final
 * tier so no reported job ever disappears from the card.
 */
export function githubWorkflowDefinitionTiers(
  graph: GitHubWorkflowRunRowGraph,
  observed: readonly GitHubWorkflowRunRowJob[],
): GitHubWorkflowDefinitionTiers {
  const depths = githubWorkflowGraphDepths(graph.jobs);
  const jobs: Record<string, DagJobMeta> = {};
  const remaining = new Map(observed.map((job) => [job.jobId, job]));
  const takeByName = (name: string): GitHubWorkflowRunRowJob | undefined => {
    for (const job of Array.from(remaining.values())) {
      if (job.name === name) {
        remaining.delete(job.jobId);
        return job;
      }
    }
    return undefined;
  };
  const takeAllByName = (name: string): GitHubWorkflowRunRowJob[] => {
    const taken = Array.from(remaining.values()).filter(
      (job) => job.name === name,
    );
    for (const job of taken) remaining.delete(job.jobId);
    return taken;
  };
  const takeFirstByTemplate = (
    matches: (value: string) => boolean,
  ): GitHubWorkflowRunRowJob | undefined => {
    for (const job of Array.from(remaining.values())) {
      if (matches(job.name)) {
        remaining.delete(job.jobId);
        return job;
      }
    }
    return undefined;
  };
  const takeAllByTemplate = (
    matches: (value: string) => boolean,
  ): GitHubWorkflowRunRowJob[] => {
    const taken: GitHubWorkflowRunRowJob[] = [];
    for (const job of Array.from(remaining.values())) {
      if (matches(job.name)) taken.push(job);
    }
    for (const job of taken) remaining.delete(job.jobId);
    return taken;
  };

  // Claim every exact/expanded display name before evaluating dynamic
  // patterns. This prevents an earlier broad dynamic job from stealing an
  // observation that a later declared job can identify exactly.
  const exactNameMatches = new Map<
    GitHubWorkflowRunRowGraphJob,
    Array<GitHubWorkflowRunRowJob | undefined>
  >();
  for (const graphJob of graph.jobs) {
    exactNameMatches.set(
      graphJob,
      graphJob.names.map((name) => takeByName(name)),
    );
  }
  const exactDynamicMatches = new Map<
    GitHubWorkflowRunRowGraphJob,
    GitHubWorkflowRunRowJob[]
  >();
  for (const graphJob of graph.jobs) {
    if (graphJob.dynamic) {
      exactDynamicMatches.set(graphJob, takeAllByName(graphJob.template));
    }
  }

  const placements: Array<{ tier: number; ids: string[] }> = [];
  let tierCount = 0;
  for (const graphJob of graph.jobs) {
    const tier = depths.get(graphJob.id) ?? 0;
    tierCount = Math.max(tierCount, tier + 1);
    const ids: string[] = [];
    const exactNames = exactNameMatches.get(graphJob) ?? [];
    graphJob.names.forEach((name, index) => {
      const matcher = HAS_EXPRESSION.test(name)
        ? templateMatcher(name)
        : undefined;
      const matched =
        exactNames[index] ??
        (matcher ? takeFirstByTemplate(matcher) : undefined);
      if (matched) {
        jobs[matched.jobId] = dagMeta(matched);
        ids.push(matched.jobId);
        return;
      }
      const placeholder = `${GITHUB_PLACEHOLDER_JOB_PREFIX}${graphJob.id}:${index}`;
      jobs[placeholder] = { jobId: placeholder, name, status: 'pending' };
      ids.push(placeholder);
    });
    if (graphJob.dynamic) {
      // GitHub reports the literal template for skipped jobs it never
      // evaluated, and the substituted name for the ones it ran.
      const matcher = HAS_EXPRESSION.test(graphJob.template)
        ? templateMatcher(graphJob.template)
        : constantDynamicMatcher(graphJob.template);
      const matched = [
        ...(exactDynamicMatches.get(graphJob) ?? []),
        ...(matcher ? takeAllByTemplate(matcher) : []),
      ];
      for (const job of matched) {
        jobs[job.jobId] = dagMeta(job);
        ids.push(job.jobId);
      }
      if (matched.length === 0) {
        const placeholder = `${GITHUB_PLACEHOLDER_JOB_PREFIX}${graphJob.id}`;
        jobs[placeholder] = {
          jobId: placeholder,
          name: graphJob.template,
          status: 'pending',
        };
        ids.push(placeholder);
      }
    }
    placements.push({ tier, ids });
  }

  const tiers: string[][] = Array.from({ length: tierCount }, () => []);
  for (const placement of placements)
    tiers[placement.tier].push(...placement.ids);
  const unplaced = Array.from(remaining.values()).map((job) => {
    jobs[job.jobId] = dagMeta(job);
    return job.jobId;
  });
  if (unplaced.length > 0) tiers.push(unplaced);
  return { tiers: tiers.filter((tier) => tier.length > 0), jobs, unplaced };
}

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
