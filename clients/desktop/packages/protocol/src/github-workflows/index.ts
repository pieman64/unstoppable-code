export const GITHUB_WORKFLOW_RUN_INTERMEDIATE_STATUSES = [
  'requested',
  'queued',
  'pending',
  'waiting',
  'in_progress',
] as const;

export type GitHubWorkflowRunIntermediateStatus =
  (typeof GITHUB_WORKFLOW_RUN_INTERMEDIATE_STATUSES)[number];

/** Known terminal GitHub Actions workflow-run conclusions. */
export const GITHUB_WORKFLOW_RUN_CONCLUSIONS = [
  'action_required',
  'cancelled',
  'failure',
  'neutral',
  'skipped',
  'stale',
  'startup_failure',
  'success',
  'timed_out',
] as const;

export type GitHubWorkflowRunConclusion =
  (typeof GITHUB_WORKFLOW_RUN_CONCLUSIONS)[number];

/** Known terminal conclusions for an individual workflow job. */
export const GITHUB_WORKFLOW_JOB_CONCLUSIONS = [
  'action_required',
  'cancelled',
  'failure',
  'neutral',
  'skipped',
  'stale',
  'startup_failure',
  'success',
  'timed_out',
] as const;

export type GitHubWorkflowJobConclusion =
  (typeof GITHUB_WORKFLOW_JOB_CONCLUSIONS)[number];

/**
 * Closed, normalized internal representation of a single workflow-run state.
 *
 * The backend normalizes raw GitHub responses into this union; the frontend
 * renders `previous`/`current` values of it. The `unsupported` variant is the
 * guard against unknown future GitHub status/conclusion values — the rules for
 * how the backend *populates* it (unknown non-terminal values do not notify;
 * `status: "completed"` with an unknown/missing conclusion settles silently; a
 * later `run_attempt` settles the pinned attempt as `unsupported`) live in the
 * backend plan. The **shape** is fixed here.
 */
export type GitHubWorkflowRunState =
  | {
      kind: 'intermediate';
      status: GitHubWorkflowRunIntermediateStatus;
    }
  | {
      kind: 'terminal';
      conclusion: GitHubWorkflowRunConclusion;
    }
  | {
      kind: 'unsupported';
      status: string | null;
      conclusion: string | null;
      terminal: boolean;
    };

// ---------------------------------------------------------------------------
// Persisted per-item snapshot
// ---------------------------------------------------------------------------

/**
 * Persisted, bounded snapshot of a single watched workflow run.
 *
 * ETags are deliberately **not** part of the snapshot: they live only in the
 * broker's in-memory conditional cache (backend) and are lost on restart.
 * Restart correctness relies on comparing the freshly fetched normalized
 * `state` against this persisted snapshot, not on any persisted ETag.
 */
export interface GitHubWorkflowRunSnapshot {
  state: GitHubWorkflowRunState;
  runAttempt: number;
  /** GitHub-provided `html_url`; never constructed. */
  htmlUrl: string;
  workflowName?: string;
  runNumber?: number;
  /** GitHub's `run_started_at`, when the response carried a valid timestamp. */
  startedAt?: string;
  /**
   * Where the run's workflow definition can be read: the run's `path` and
   * `head_sha` plus GitHub's `referenced_workflows` (reusable workflows the
   * run called, each pinned to a commit). Present only when GitHub returned
   * a well-formed set; the definition graph below is derived from it.
   */
  definitionSource?: GitHubWorkflowDefinitionSource;
  observedAt: string;
}

/** Pinned locations of the workflow files that define one run. */
export interface GitHubWorkflowDefinitionSource {
  /** Repository-relative path of the run's own workflow file. */
  path: string;
  /** Commit the run's workflow file was read from (`head_sha`). */
  sha: string;
  /** Reusable workflows the run called, from `referenced_workflows`. */
  referenced: Array<{
    /** `owner/repository` the file lives in. */
    repository: string;
    /** Repository-relative path of the file. */
    path: string;
    /** Commit the file was resolved at. */
    sha: string;
  }>;
}

/**
 * One job of a workflow definition, after static expansion. A reusable
 * workflow's inner jobs appear as `<caller>/<inner>` with the caller's display
 * name prefixed the way GitHub shows them (`Caller name / Inner name`).
 */
export interface GitHubWorkflowGraphJob {
  /** Job key from the YAML, or `<caller>/<inner>` for reusable-workflow jobs. */
  id: string;
  /**
   * Display-name template. `${{ matrix.* }}` and `${{ strategy.* }}` are
   * substituted into `names`; any other expression stays verbatim so the
   * renderer can still match GitHub's reported name by pattern.
   */
  template: string;
  /** Statically expanded display names, one per matrix variant; empty when dynamic. */
  names: string[];
  /** Ids of the jobs this job waits on, resolved to nodes of this graph. */
  needs: string[];
  /**
   * True when the job's matrix could not be expanded statically (for example
   * `fromJSON(needs.x.outputs.y)`), so the node stands for an unknown number
   * of jobs until GitHub materializes them.
   */
  dynamic: boolean;
}

/**
 * The dependency graph of one run's workflow definition, read from the
 * workflow files pinned by {@link GitHubWorkflowDefinitionSource}. It lets the
 * chat progress card show every job the run will have, including jobs GitHub
 * has not created yet, grouped by declared `needs`. Bounded by
 * `MAX_GITHUB_WORKFLOW_GRAPH_JOBS` / `MAX_GITHUB_WORKFLOW_GRAPH_NAMES`.
 */
export interface GitHubWorkflowDefinitionGraph {
  /** Commit the definition files were read at. */
  sha: string;
  jobs: GitHubWorkflowGraphJob[];
  observedAt: string;
}

/**
 * Bounded persisted cursor for one job in the pinned workflow-run attempt.
 * Steps, runner metadata, labels, logs, and raw API fields are deliberately
 * excluded.
 */
export interface GitHubWorkflowJobSnapshot {
  jobId: string;
  name: string;
  status: string;
  conclusion: GitHubWorkflowJobConclusion | null;
  /** GitHub-provided `html_url`; never constructed. */
  htmlUrl: string;
  /**
   * GitHub's job `created_at`, when returned. GitHub creates a job record
   * only once its `needs` are satisfied, so this timestamp against earlier
   * jobs' `completedAt` is how the progress card recovers dependency tiers.
   */
  createdAt?: string;
  /** GitHub's job `started_at` / `completed_at`, when returned. */
  startedAt?: string;
  completedAt?: string;
  observedAt: string;
}
