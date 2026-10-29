/**
 * Transport contracts for the `WatchGitHubItems` agent tool and the GitHub
 * workflow-run watcher feature.
 *
 * This module owns **shapes and names only**. The backend plan normalizes raw
 * GitHub responses into these shapes, persists them, observes transitions, and
 * validates tool requests; the frontend plan renders `previous`/`current`
 * states and watcher summaries. Neither sibling redefines a type declared here
 * — they consume these contracts.
 *
 * Design rules baked into these types:
 *  - Workflow-run statuses/conclusions are **closed** unions. Unknown future
 *    GitHub values are represented by the `unsupported` variant of
 *    {@link GitHubWorkflowRunState} so they can never falsely match a known
 *    filter.
 *  - The watch target is an **explicitly extensible discriminator**
 *    ({@link GitHubWatchItem}). New GitHub targets add a new `kind` variant;
 *    they never add unrelated optional fields to the `workflow_run` variant.
 *  - Provider-facing results and fired-event context are optimized for bounded
 *    size. They never echo raw Octokit responses, complete job lists, steps, logs,
 *    artifacts, destination ids, ETags, or renderer IPC objects.
 */

import type { PrMergeQueueKnownPhase, PrMergeQueuePhase } from './github';

// ---------------------------------------------------------------------------
// Workflow-run status types
// ---------------------------------------------------------------------------

/**
 * Known intermediate (non-terminal) GitHub Actions workflow-run statuses.
 *
 * `completed` is intentionally **not** part of this set: a completed run is
 * represented by its conclusion (see {@link GITHUB_WORKFLOW_RUN_CONCLUSIONS}).
 */
import type {
  GitHubWorkflowRunIntermediateStatus,
  GitHubWorkflowRunConclusion,
  GitHubWorkflowJobConclusion,
  GitHubWorkflowRunState,
  GitHubWorkflowDefinitionGraph,
  GitHubWorkflowJobSnapshot,
} from '@canopy/protocol/github-workflows';
export * from '@canopy/protocol/github-workflows';

/**
 * Renderer-visible projection of one watched run, published on
 * `AppAdvisorWatcherSummary.githubProgress`. The main process derives it from
 * the backend-only runtime state on every summary, so the chat Agent activity
 * card can mirror the watcher's own polling without any additional GitHub
 * request. It carries the last observed run snapshot and bounded job cursors
 * only — never queued events, the delivery outbox, ETags, or retry state.
 */
export interface GitHubWorkflowRunWatchProgress {
  repository: string;
  runId: string;
  runAttempt: number;
  requestedAttempt?: number;
  workflowName?: string;
  runNumber?: number;
  /** GitHub-provided `html_url`; never constructed. */
  htmlUrl: string;
  state: GitHubWorkflowRunState;
  startedAt?: string;
  observedAt: string;
  /** Set once the run reached a terminal state and polling stopped for it. */
  settledAt?: string;
  /**
   * Job cursors for the pinned attempt, in GitHub's order. Observed for
   * every watcher regardless of `notifyOn.jobs`; absent only until the first
   * successful jobs read for rows persisted before that was unconditional.
   */
  jobs?: GitHubWorkflowJobSnapshot[];
  /** The run's declared job graph, once its workflow definition was read. */
  definition?: GitHubWorkflowDefinitionGraph;
}

// ---------------------------------------------------------------------------
// Event shapes (shared by runtime outbox and fired context)
// ---------------------------------------------------------------------------

/**
 * A single observed `previous` → `current` transition for one workflow run.
 *
 * Reused by the persisted `pendingDelivery` outbox (backend runtime state) and
 * the fired hidden-context payload delivered to the subscribing chat. Only
 * transitions selected for notification are included; unchanged items are not.
 */
export interface GitHubWorkflowRunTransition {
  repository: string;
  runId: string;
  workflowName?: string;
  runNumber?: number;
  runAttempt: number;
  previous: GitHubWorkflowRunState;
  current: GitHubWorkflowRunState;
  /** GitHub-provided `html_url`; never constructed. */
  url: string;
}

/** One completed workflow job selected for notification. */
export interface GitHubWorkflowJobCompletedEvent {
  kind: 'workflow_job_completed';
  repository: string;
  runId: string;
  workflowName?: string;
  runNumber?: number;
  runAttempt: number;
  job: {
    id: string;
    name: string;
    conclusion: GitHubWorkflowJobConclusion;
    /** GitHub-provided `html_url`; never constructed. */
    url: string;
  };
}

/** Extensible, bounded event union delivered when a GitHub watcher fires. */
export type GitHubWorkflowWatcherEvent =
  | ({ kind: 'workflow_run_transition' } & GitHubWorkflowRunTransition)
  | GitHubWorkflowJobCompletedEvent;

export type GitHubWorkflowWatcherEventKind = GitHubWorkflowWatcherEvent['kind'];

// ---------------------------------------------------------------------------
// GitHub item and notification input
// ---------------------------------------------------------------------------

/**
 * Explicitly extensible discriminated GitHub watch target.
 *
 * Version one supports only concrete GitHub Actions workflow-run IDs on
 * GitHub.com. When another GitHub target is added later, add a new discriminated
 * variant; do **not** add unrelated optional fields to the `workflow_run`
 * variant.
 */
export type GitHubWorkflowRunReference = string | number;

export type GitHubNumericIdInput = string | number;

export type GitHubWorkflowRunInput =
  | GitHubWorkflowRunReference
  | {
      kind: 'workflow_run';
      target: GitHubWorkflowRunReference;
      repository?: string;
      runAttempt?: number;
    }
  | {
      kind: 'workflow_run';
      repository?: string;
      runId: GitHubNumericIdInput;
      runAttempt?: number;
    };

export type GitHubWorkflowRunTarget = {
  kind: 'workflow_run';
  /** Validated `owner/repository`. */
  repository: string;
  /** Positive decimal string. */
  runId: string;
  /** Present only when the caller explicitly selected an attempt. */
  requestedAttempt?: number;
};

/** Backward-compatible name for the persisted workflow-run target. */
export type GitHubWatchItem = GitHubWorkflowRunTarget;

/**
 * A model-supplied selection of enum values, or the compact `"any"` alias.
 * `"any"` is normalized to the complete corresponding enum before persistence.
 */
export type GitHubWatchSelection<T extends string> = 'any' | readonly T[];

/**
 * The `notifyOn` selection that applies to every item in a grouped watcher.
 * The nested `run` / `jobs` form is the advertised contract. Top-level
 * `statuses` / `conclusions` remain accepted as compatibility aliases for
 * `run.statuses` / `run.conclusions`.
 */
export interface GitHubWorkflowRunNotificationSelection {
  run?: {
    statuses?: GitHubWatchSelection<GitHubWorkflowRunIntermediateStatus>;
    conclusions?: GitHubWatchSelection<GitHubWorkflowRunConclusion>;
  };
  jobs?: {
    /** A selected conclusion means the job has completed. */
    conclusions: GitHubWatchSelection<GitHubWorkflowJobConclusion>;
  };
  /** @deprecated Prefer `run.statuses`. */
  statuses?: GitHubWatchSelection<GitHubWorkflowRunIntermediateStatus>;
  /** @deprecated Prefer `run.conclusions`. */
  conclusions?: GitHubWatchSelection<GitHubWorkflowRunConclusion>;
}

// ---------------------------------------------------------------------------
// Pull request observation
// ---------------------------------------------------------------------------

/**
 * A pull request to watch. `target` is a GitHub.com PR URL or
 * `owner/repository#number`; the object form takes an explicit number with an
 * optional `repository` (falling back to the call's default repository).
 * Identity is repository + number, never a queue branch, SHA, or run id.
 */
export type GitHubPullRequestInput =
  | { kind: 'pull_request'; target: string }
  | {
      kind: 'pull_request';
      repository?: string;
      number: GitHubNumericIdInput;
    };

export type GitHubPullRequestTarget = {
  kind: 'pull_request';
  /** Validated, canonical `owner/repository`. */
  repository: string;
  /** Positive integer. */
  number: number;
};

export type GitHubPullRequestState = 'open' | 'closed' | 'merged';

/** Bounded observation of one watched pull request. */
export interface GitHubPullRequestSnapshot {
  state: GitHubPullRequestState;
  /** GitHub-provided URL; never constructed. */
  url: string;
  /** Untrusted, bounded PR title for display. */
  title?: string;
  baseRefName: string;
  headSha: string;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  closedAt: string | null;
  /** Merge queue membership; `null` when not queued or not reported. */
  queue: {
    entryId: string | null;
    enqueuedAt: string | null;
    phase: PrMergeQueuePhase;
    position: number | null;
  } | null;
  observedAt: string;
}

interface GitHubPullRequestEventIdentity {
  repository: string;
  number: number;
  /** GitHub-provided URL. */
  url: string;
  baseBranch: string;
  /** Head commit observed with the event. */
  headSha: string;
}

/** Bounded event union delivered when a pull request watcher fires. */
export type GitHubPullRequestWatcherEvent =
  | (GitHubPullRequestEventIdentity & {
      kind: 'pull_request_merged';
      mergedAt: string;
      mergeCommitSha: string | null;
    })
  | (GitHubPullRequestEventIdentity & {
      kind: 'pull_request_closed';
      closedAt: string;
    })
  | (GitHubPullRequestEventIdentity & {
      /** Left the merge queue without merging; the watcher keeps watching. */
      kind: 'pull_request_queue_removed';
      /** Timeline time when verified from GitHub's removal event. */
      removedAt: string | null;
      /** GitHub's removal reason when verified, for example `failed_checks`. */
      reason: string | null;
      evidence: 'timeline' | 'entry_changed' | 'membership';
      /** Back in the queue at this sample. */
      requeued: boolean;
      /** Present and above 1 when several removals happened between samples. */
      removals?: number;
    })
  | (GitHubPullRequestEventIdentity & {
      kind: 'pull_request_queue_entered';
      enqueuedAt: string | null;
      phase: PrMergeQueuePhase;
      position: number | null;
      reentry: boolean;
    })
  | (GitHubPullRequestEventIdentity & {
      kind: 'pull_request_queue_phase_changed';
      previousPhase: PrMergeQueuePhase;
      phase: PrMergeQueuePhase;
      position: number | null;
    })
  | (GitHubPullRequestEventIdentity & {
      /** Queue history since `since` could not be recovered. */
      kind: 'pull_request_queue_history_incomplete';
      since: string;
      observedAt: string;
    });

export type GitHubPullRequestWatcherEventKind =
  GitHubPullRequestWatcherEvent['kind'];

/**
 * Per-item setup outcome. Items already merged or closed at setup are
 * reported here and never watched.
 */
export type GitHubPullRequestSetupOutcome = {
  index: number;
  repository: string;
  number: number;
  url: string;
} & (
  | { outcome: 'watching' }
  | {
      outcome: 'merged';
      mergedAt: string;
      mergeCommitSha: string | null;
      baseBranch: string;
    }
  | { outcome: 'closed'; closedAt: string }
);

/**
 * Canonical input for the `WatchGitHubItems` tool — the single shared source of
 * truth for the Claude (Zod) and Codex (JSON) schemas, which advertise
 * equivalent shapes.
 *
 * The model cannot provide destination ids, project/worktree ids, current
 * state, ETags, observed attempts, display metadata, runtime state, retry
 * state, or delivery state. `runAttempt` is only an explicit target selector;
 * the baseline attempt observed from GitHub remains runtime-owned. Extra
 * properties are rejected by the backend.
 */
/** Optional merge queue notifications for pull request watchers. */
export interface GitHubPullRequestQueueNotificationSelection {
  /** Wake when the pull request enters or re-enters the queue. */
  entered?: boolean;
  /** Wake when the queue entry moves into one of these phases. */
  phases?: GitHubWatchSelection<PrMergeQueueKnownPhase>;
}

/** Normalized pull request notification selection persisted on the target. */
export interface GitHubPullRequestNotificationSelection {
  queueEntered: boolean;
  queuePhases: PrMergeQueueKnownPhase[];
}

export interface WatchGitHubItemsInput {
  /**
   * 1–20 entries of one target family (workflow runs or pull requests);
   * validated and de-duplicated by the backend, which rejects mixed families.
   */
  items: Array<GitHubWorkflowRunInput | GitHubPullRequestInput>;
  /** Default repository for bare workflow-run ids and numbered pull requests. */
  repository?: string;
  /**
   * Required for workflow runs. Pull requests always notify on merge, close,
   * and removal from the merge queue; `queue` opts into entry and phases.
   */
  notifyOn?: GitHubWorkflowRunNotificationSelection & {
    queue?: GitHubPullRequestQueueNotificationSelection;
  };
  label?: string;
  followUpInstruction?: string;
  allowDuplicate?: boolean;
}

// ---------------------------------------------------------------------------
// Tool result contract
// ---------------------------------------------------------------------------

/**
 * Error codes returned by the `WatchGitHubItems` tool. See the backend plan for
 * the exact code → cause mapping; the closed union is the contract.
 */
export type WatchGitHubItemsErrorCode =
  | 'invalid_input'
  | 'invalid_reference'
  | 'repository_required'
  | 'reference_conflict'
  | 'duplicate_item'
  | 'not_authenticated'
  | 'not_found_or_inaccessible'
  | 'already_terminal'
  | 'capacity_exceeded'
  | 'github_unavailable'
  | 'internal_error';

/**
 * Bounded result of the `WatchGitHubItems` tool.
 *
 * The result must **not** return enriched targets, destination ids, current
 * snapshots, rate-limit headers, ETags, or complete watcher summaries. On
 * failure, `itemIndex` carries the zero-based index of the offending item for
 * per-item preflight failures (`not_found_or_inaccessible` / `already_terminal`).
 */
export type WatchGitHubItemsResult =
  | {
      ok: true;
      status: 'created' | 'deduped';
      watcherId: string;
      itemCount: number;
      /** Compact confirmation of the event kinds actually armed. */
      events: Array<
        GitHubWorkflowWatcherEventKind | GitHubPullRequestWatcherEventKind
      >;
      /** Pull request watchers only: one outcome per requested item. */
      items?: GitHubPullRequestSetupOutcome[];
    }
  | {
      /** Every requested pull request was already merged or closed. */
      ok: true;
      status: 'not_created';
      itemCount: 0;
      events: [];
      items: GitHubPullRequestSetupOutcome[];
    }
  | {
      ok: false;
      code: WatchGitHubItemsErrorCode;
      message: string;
      itemIndex?: number;
      field?: 'items' | 'repository' | 'notifyOn';
    };

// ---------------------------------------------------------------------------
// Fired message hidden-context shape
// ---------------------------------------------------------------------------

/**
 * The **only** shape delivered as hidden context to the subscribing chat when a
 * GitHub workflow-run watcher fires. Message-text templates, population rules,
 * and the default follow-up instruction live in the backend plan.
 *
 * Contract rules: use GitHub's returned `html_url` (never construct it); include
 * only selected run transitions and completed jobs; do not include unchanged
 * items, the complete watcher target, actors, commits, PR arrays, job steps,
 * logs, artifacts, headers, or raw responses. The `eventId` is the at-least-once
 * dedupe key exposed in hidden context.
 */
export interface GitHubWorkflowRunFiredContext {
  watcherId: string;
  eventId: string;
  trigger: 'github_workflow_runs_changed';
  observedAt: string;
  events: GitHubWorkflowWatcherEvent[];
  progress: {
    total: number;
    settled: number;
    active: number;
  };
  followUpInstruction?: string;
}

/** Hidden context delivered when a pull request watcher fires. */
export interface GitHubPullRequestFiredContext {
  watcherId: string;
  eventId: string;
  trigger: 'github_pull_requests_changed';
  observedAt: string;
  events: GitHubPullRequestWatcherEvent[];
  progress: {
    total: number;
    settled: number;
    active: number;
  };
  followUpInstruction?: string;
}
