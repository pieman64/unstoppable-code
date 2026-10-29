import {
  PR_RECONCILIATION_CLIENT_LOCAL_ID,
  type PrCheckStatusValue,
  type PrReviewStatusValue,
  type PrStateValue,
  type TelemetryPullRequestPayload,
} from '@canopy/protocol/telemetry';

/**
 * Stable worktree id that owns PR rows recovered by the reconciliation sweep.
 *
 * The live path (`github-poller` -> `pr-status-change-emitter`) can only report
 * a PR while its worktree still exists AND is still checked out on the PR's
 * head branch. A PR opened from a checkout Canopy does not track (an agent
 * side-worktree, a /tmp checkout, a pipeline) is never visible to it, and every
 * merge that lands outside that window is invisible to it too:
 *
 *  - the worktree was archived/deleted before the poller observed the merge;
 *  - the branch was switched (a follow-up PR reuses the worktree);
 *  - the work ran in a Cowork / App Advisor workspace, which the poller skips
 *    entirely (`syncTrackedWorktrees` drops `type === 'cowork'`);
 *  - the desktop app was not running when the PR merged;
 *  - the PR was merged from the GitHub UI or `gh` after the branch was cleaned up.
 *
 * Those PRs would be permanently absent from org statistics because there is
 * no server-side PR discovery. The sweep closes that gap by
 * asking GitHub directly, so recovered PRs need a worktree to hang off that is
 * NOT tied to any local checkout. This synthetic id is per workspace and stable,
 * so re-sweeps upsert in place instead of creating a new container each run.
 *
 * The sweep leaves a PR to the poller only when a tracked worktree reports it
 * AND the poller has already recorded it — see `ReconcilableRepo.ownedPrNumbers`.
 * Together with the per-URL claim in the sync service, that keeps exactly one
 * writer per PR, so a PR can never be reported by both the poller and the sweep
 * and counted twice.
 *
 * Conforms to the app-wide safe-id shape (`/^[a-z0-9][a-z0-9-]*$/`) so it stays
 * legal anywhere a worktree id is validated. A real worktree of the same name
 * would simply share the container, which still counts each PR exactly once.
 *
 * The value itself is protocol-owned: `apps/web` reads the same id to suppress
 * on-PR provenance comments for rows this sweep created. Aliased here so desktop
 * call sites keep their local name while a rename can no longer desync the two.
 */
export const PR_RECONCILIATION_WORKTREE_ID = PR_RECONCILIATION_CLIENT_LOCAL_ID;

/** Human-readable label for the synthetic reconciliation worktree. */
export const PR_RECONCILIATION_WORKTREE_NAME = 'Recovered pull requests';

/**
 * How far back a sweep looks.
 *
 * Matches the widest leaderboard range that anchors on merge time. It is NOT
 * narrowed on the assumption that older merges were caught by a previous run:
 * the very first sweep after this ships has no prior run, so anything shorter
 * would permanently strand existing users' older merges.
 */
export const PR_RECONCILIATION_LOOKBACK_DAYS = 90;

/** Sweep cadence once the app is running. */
export const PR_RECONCILIATION_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Delay before the first sweep. Startup already contends for the GitHub rate
 * limit while the poller hydrates every tracked worktree, and reconciliation is
 * a catch-up path with no latency requirement.
 */
export const PR_RECONCILIATION_STARTUP_DELAY_MS = 60 * 1000;

/** A GitHub repo the sweep can query, resolved from a local workspace. */
export interface ReconcilableRepo {
  /** Workspace (project) id the recovered PRs are attributed to. */
  projectId: string;
  /**
   * `repoId` recorded on rows this sweep writes. Stable per remote (the GitHub
   * repo name), so repeated sweeps address the same server row.
   *
   * NOTE this deliberately does NOT match what the live poller writes for a
   * single-repo workspace: there `repoId` is `basename(worktreeDir)`, i.e. the
   * worktree name, so it varies per worktree (one real account showed 69 PR
   * keys spread across 47 distinct `repoId`s in a single workspace). Matching
   * on `repoId` alone would therefore miss almost every already-synced PR and
   * re-ingest it as a duplicate. `dedupeByPrNumberOnly` exists for exactly that
   * reason.
   */
  repoId: string;
  repoName: string;
  owner: string;
  repo: string;
  /**
   * When true, a PR counts as already synced if ANY recorded key in the
   * workspace ends in `#<prNumber>`, regardless of its `repoId`.
   *
   * Safe precisely for single-repo workspaces: every worktree there shares one
   * remote, so a PR number is unambiguous within the workspace. Multi-repo
   * workspaces keep exact-key matching, because the poller writes a stable
   * per-repo `repoId` there and two sibling repos can legitimately share a PR
   * number.
   */
  dedupeByPrNumberOnly: boolean;
  /**
   * PR numbers a tracked worktree currently reports for this repo, taken from
   * each worktree's persisted `lastKnownPrStatus`.
   *
   * A listed PR is the poller's only once the poller has also recorded it (a
   * sync-map entry or a pending item for its URL or key). Listing alone is not
   * ownership: `lastKnownPrStatus` is persisted whether or not the telemetry
   * listener ever delivered the PR, so a listed-but-unsent PR (CAN-3514,
   * tapir's #3994) would otherwise be skipped by the sweep forever. Recovering
   * it cannot double-count, because the sync service claims each PR URL for
   * exactly one writer.
   *
   * Fencing on branch NAME alone was wrong in both directions: the poller
   * resolves a branch to at most one PR (it asks for open PRs first and only
   * falls back to closed history when none exists, see `github-pr.ts`), so an
   * older merged PR sharing a branch name with a newer open one is invisible to
   * the poller forever — and a name-only fence would have made the sweep skip
   * it forever too, losing it permanently once it aged out of the lookback
   * window.
   */
  ownedPrNumbers: ReadonlySet<number>;
  /**
   * Every branch currently checked out in a tracked worktree of this repo.
   *
   * Fences OPEN PRs only. The poller resolves a live branch to its open PR
   * first, so an open PR on one of these branches is the poller's to report.
   * Merged and closed PRs are not fenced by it: the poller cannot see an older
   * PR on a branch that has a newer one (see `ownedPrNumbers`).
   */
  liveBranches: ReadonlySet<string>;
  /**
   * Live branches whose worktree has no recorded PR state yet.
   *
   * The poller's intent for these is genuinely unknown (cold start, or it has
   * not polled them yet), so the sweep defers rather than guessing. Deferring
   * can only delay a recovery to the next sweep; guessing could double-count.
   */
  unresolvedLiveBranches: ReadonlySet<string>;
}

/** A PR authored by the viewer, as returned by GitHub, narrowed to what telemetry needs. */
export interface PullRequestRecord {
  prNumber: number;
  title: string;
  prUrl: string;
  /** Current state on GitHub. */
  state: PrStateValue;
  openedAt: string;
  /** Present only when `state` is `merged`. */
  mergedAt?: string;
  /** Head branch, used to skip PRs the live poller still owns. */
  headRefName?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  commentCount?: number;
  /**
   * Check and review outcomes GitHub reported for the PR. Omitted when GitHub
   * reported none, which maps to an explicit `none` rather than a guess.
   */
  checkStatus?: PrCheckStatusValue;
  reviewStatus?: PrReviewStatusValue;
}

export interface PrReconciliationDeps {
  /** Repos to sweep, one entry per (workspace, repo). */
  listRepos: () => Promise<ReconcilableRepo[]>;
  /**
   * PRs authored by the authenticated GitHub user in `repo`: merged at or after
   * `since`, or open or closed unmerged and opened or closed at or after
   * `since`. Implementations should return an empty array rather than throw on
   * a per-repo failure; a throw is caught and isolated to that repo.
   */
  listPullRequestsByViewer: (
    repo: ReconcilableRepo,
    since: Date,
  ) => Promise<PullRequestRecord[]>;
  /**
   * `${repoId}#${prNumber}` keys already recorded for this workspace, across
   * every worktree and every owner-scope target. The sweep is additive only:
   * anything already synced is left alone so the live path stays authoritative.
   */
  getSyncedPrKeys: (projectId: string) => Promise<ReadonlySet<string>>;
  /** Canonical PR URLs already synced or pending under any workspace. */
  getSyncedPrUrls: () => Promise<ReadonlySet<string>>;
  /**
   * Least advanced PR state already sent or queued, per canonical PR URL,
   * across the owner-scope targets (server rows) the PR was sent to. A URL
   * with no entry has an unknown sent state in at least one target (recorded
   * before states were tracked, or recorded without a URL).
   */
  getSyncedPrStates: () => Promise<ReadonlyMap<string, PrStateValue>>;
  /**
   * Hand recovered PRs to the telemetry sync queue. Resolves to the URLs that
   * were actually queued: a workspace whose sharing is off, or whose metadata
   * cannot be resolved, queues nothing.
   */
  enqueue: (
    projectId: string,
    payloads: TelemetryPullRequestPayload[],
  ) => Promise<ReadonlySet<string>>;
  /**
   * Queue a newer state for PRs that were already sent. Unlike `enqueue`, these
   * PRs may be claimed by another writer; the server updates the existing row,
   * matched by creator, PR URL and owner scope, rather than adding one.
   * Resolves to the URLs that were actually queued.
   */
  enqueueStateUpdates: (
    projectId: string,
    payloads: TelemetryPullRequestPayload[],
  ) => Promise<ReadonlySet<string>>;
  now?: () => number;
  onLog?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface PrReconciliationResult {
  reposSwept: number;
  prsSeen: number;
  prsRecovered: number;
  reposFailed: number;
  /** PRs skipped because a tracked worktree still holds their head branch. */
  prsLeftToPoller: number;
  /** Already-sent PRs whose newer state (e.g. merged) was queued again. */
  prsStateUpdated: number;
}

/**
 * How far along its lifecycle a PR state is. A PR can be reopened, but a
 * terminal state the server has not seen yet is always worth sending: `merged`
 * never changes again, and a `closed` that follows a recorded `open` is news.
 */
function prStateRank(state: PrStateValue | undefined): number {
  switch (state) {
    case 'merged':
      return 3;
    case 'closed':
      return 2;
    case 'open':
    case 'draft':
      return 1;
    default:
      return 0;
  }
}

/**
 * Whether `next` is further along than the `recorded` state. An unknown
 * recorded state (undefined) is behind every known one.
 */
export function prStateIsBehind(
  recorded: PrStateValue | undefined,
  next: PrStateValue,
): boolean {
  return prStateRank(next) > prStateRank(recorded);
}

/** The more advanced of two recorded states for one PR. */
export function mostAdvancedPrState(
  current: PrStateValue | undefined,
  next: PrStateValue,
): PrStateValue {
  return current !== undefined && prStateRank(current) >= prStateRank(next)
    ? current
    : next;
}

/**
 * Whether an already-sent PR must be sent again because GitHub now reports a
 * terminal state the recorded copy is behind on (CAN-3513). The live poller
 * only watches the PR a worktree has checked out now, so a PR sent while open
 * whose worktree moved on would otherwise keep reading OPEN server-side.
 *
 * An unknown recorded state (a sync-map entry written before states were
 * tracked) counts as behind. That is the backfill for rows already stranded
 * OPEN: each is re-sent once, which the server applies as an in-place update.
 */
function needsStateUpdate(
  githubState: PrStateValue,
  recorded: PrStateValue | undefined,
): boolean {
  if (githubState !== 'merged' && githubState !== 'closed') {
    return false;
  }
  return prStateIsBehind(recorded, githubState);
}

/**
 * Whether the live poller owns this PR, and the sweep must therefore leave it
 * alone. Both writers producing a row would double-count, because
 * `(worktreeId, repoId, prNumber)` is a storage key, not a PR identity.
 *
 * `recorded` says whether the PR already has a sync-map entry or pending item.
 * A worktree listing the PR makes it the poller's only when it is recorded;
 * see `ReconcilableRepo.ownedPrNumbers`.
 */
function ownsPullRequest(
  repo: ReconcilableRepo,
  record: PullRequestRecord,
  recorded: boolean,
): boolean {
  if (recorded && repo.ownedPrNumbers.has(record.prNumber)) {
    return true;
  }
  // Without a head ref we cannot rule the poller out. Defer: a missed recovery
  // is retried next sweep, a duplicate is permanent.
  if (record.headRefName === undefined) {
    return true;
  }
  if (
    !recorded &&
    (record.state === 'open' || record.state === 'draft') &&
    repo.liveBranches.has(record.headRefName)
  ) {
    // The poller reports a live branch's open PR itself (CAN-3516).
    return true;
  }
  return repo.unresolvedLiveBranches.has(record.headRefName);
}

export function pullRequestKey(repoId: string, prNumber: number): string {
  return `${repoId}#${prNumber}`;
}

/** PR numbers present in a set of `${repoId}#${prNumber}` keys. */
function prNumbersIn(keys: ReadonlySet<string>): ReadonlySet<number> {
  const numbers = new Set<number>();
  for (const key of Array.from(keys)) {
    const parsed = Number(key.slice(key.lastIndexOf('#') + 1));
    if (Number.isInteger(parsed)) {
      numbers.add(parsed);
    }
  }
  return numbers;
}

/**
 * Build the telemetry payload for a recovered PR.
 *
 * `state` is the PR's current state on GitHub. A PR opened from a worktree
 * Canopy does not track (an agent side-worktree, a /tmp checkout, a pipeline)
 * counts for the scope that owns the repo's work exactly like a recovered
 * merge (CAN-3516), and carries no agent turns or cost for the same reason.
 * `checkStatus`/`reviewStatus` carry what GitHub reported for the PR and are
 * never assumed: the server keeps those two client-sourced (it overrides only
 * state/timestamps/diff stats from its own GitHub fetch), and they feed the
 * leaderboard's checks-passing quality ratio. An unobserved value stays an
 * explicit `none`. Carrying the observed value matters for state updates: the
 * update rewrites the whole row, so `none` would erase what the poller sent.
 */
export function toPullRequestPayload(
  repo: ReconcilableRepo,
  record: PullRequestRecord,
): TelemetryPullRequestPayload {
  const payload: TelemetryPullRequestPayload = {
    repoId: repo.repoId,
    repoName: repo.repoName,
    prNumber: record.prNumber,
    prUrl: record.prUrl,
    title: record.title,
    state: record.state,
    checkStatus: record.checkStatus ?? 'none',
    reviewStatus: record.reviewStatus ?? 'none',
    hasConflicts: false,
    commentCount: record.commentCount ?? 0,
    openedAt: record.openedAt,
  };
  if (record.mergedAt !== undefined) payload.mergedAt = record.mergedAt;
  if (record.additions !== undefined) payload.additions = record.additions;
  if (record.deletions !== undefined) payload.deletions = record.deletions;
  if (record.changedFiles !== undefined) {
    payload.changedFiles = record.changedFiles;
  }
  return payload;
}

/** One workspace that could send a PR, in the order the sweep found it. */
interface EnqueueCandidate {
  projectId: string;
  payload: TelemetryPullRequestPayload;
}

/** Add `projectId` as a candidate for `payload`'s URL, once per workspace. */
function addCandidate(
  candidatesByUrl: Map<string, EnqueueCandidate[]>,
  projectId: string,
  payload: TelemetryPullRequestPayload,
): void {
  const candidates = candidatesByUrl.get(payload.prUrl) ?? [];
  if (!candidates.some((c) => c.projectId === projectId)) {
    candidates.push({ projectId, payload });
  }
  candidatesByUrl.set(payload.prUrl, candidates);
}

/**
 * Queue each PR through the first candidate workspace that accepts it.
 *
 * A workspace can refuse a payload without failing (metadata sharing off, no
 * resolvable metadata), so a PR is only handled once its enqueue reports it
 * queued. Until then the next workspace that listed the same repo gets a turn,
 * in rounds so each round is one enqueue call per workspace. A PR no workspace
 * accepts is left for the next sweep. Resolves to the URLs queued.
 */
async function enqueueWithFallback(
  candidatesByUrl: ReadonlyMap<string, readonly EnqueueCandidate[]>,
  enqueue: (
    projectId: string,
    payloads: TelemetryPullRequestPayload[],
  ) => Promise<ReadonlySet<string>>,
  onFailure: (projectId: string, error: unknown) => void,
): Promise<ReadonlySet<string>> {
  const queued = new Set<string>();
  for (let round = 0; ; round += 1) {
    const byProject = new Map<string, TelemetryPullRequestPayload[]>();
    for (const [prUrl, candidates] of Array.from(candidatesByUrl)) {
      const candidate = candidates[round];
      if (queued.has(prUrl) || candidate === undefined) {
        continue;
      }
      const payloads = byProject.get(candidate.projectId) ?? [];
      payloads.push(candidate.payload);
      byProject.set(candidate.projectId, payloads);
    }
    if (byProject.size === 0) {
      return queued;
    }
    for (const [projectId, payloads] of Array.from(byProject)) {
      try {
        const accepted = await enqueue(projectId, payloads);
        for (const payload of payloads) {
          if (accepted.has(payload.prUrl)) {
            queued.add(payload.prUrl);
          }
        }
      } catch (error) {
        onFailure(projectId, error);
      }
    }
  }
}

/**
 * One reconciliation sweep.
 *
 * Idempotent: a PR already present anywhere in the machine's sync map is not
 * recovered again, matched by canonical URL, including when the same checkout
 * belongs to more than one workspace identity. The sync service also atomically
 * claims URLs queued during this sweep so a racing live poller cannot duplicate
 * them. An already-sent PR is queued again only when GitHub reports a terminal
 * state its recorded copy is behind on (see `needsStateUpdate`).
 */
export async function reconcilePullRequests(
  deps: PrReconciliationDeps,
): Promise<PrReconciliationResult> {
  const now = deps.now?.() ?? Date.now();
  const since = new Date(
    now - PR_RECONCILIATION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  );

  const repos = await deps.listRepos();
  const syncedPrUrls = await deps.getSyncedPrUrls();
  const syncedPrStates = await deps.getSyncedPrStates();
  const result: PrReconciliationResult = {
    reposSwept: 0,
    prsSeen: 0,
    prsRecovered: 0,
    reposFailed: 0,
    prsLeftToPoller: 0,
    prsStateUpdated: 0,
  };

  // Cache per workspace: several repos in a multi-repo workspace share one
  // synced-key set, and re-reading it per repo would race the flush that the
  // previous repo just scheduled.
  const syncedByProject = new Map<string, ReadonlySet<string>>();
  // Every workspace that could send each recovery or state update, in sweep
  // order. Nothing is marked handled while scanning: a workspace may queue
  // nothing (sharing off, no metadata), and the next workspace listing the
  // repo must then get the chance to send the PR.
  const recoveryCandidates = new Map<string, EnqueueCandidate[]>();
  const updateCandidates = new Map<string, EnqueueCandidate[]>();
  // Keys already a recovery candidate per workspace, so a workspace listing
  // the same repo twice does not offer one PR twice.
  const candidateKeysByProject = new Map<string, Set<string>>();

  for (const repo of repos) {
    try {
      let synced = syncedByProject.get(repo.projectId);
      if (!synced) {
        synced = await deps.getSyncedPrKeys(repo.projectId);
        syncedByProject.set(repo.projectId, synced);
      }

      const records = await deps.listPullRequestsByViewer(repo, since);
      result.reposSwept += 1;
      result.prsSeen += records.length;

      // Track within-sweep too: the same PR must not be enqueued twice if a
      // workspace somehow lists the same repo more than once.
      const alreadyPending =
        candidateKeysByProject.get(repo.projectId) ?? new Set<string>();
      candidateKeysByProject.set(repo.projectId, alreadyPending);
      const syncedNumbers = repo.dedupeByPrNumberOnly
        ? prNumbersIn(synced)
        : null;

      for (const record of records) {
        const key = pullRequestKey(repo.repoId, record.prNumber);
        const seen =
          syncedPrUrls.has(record.prUrl) ||
          synced.has(key) ||
          alreadyPending.has(key) ||
          (syncedNumbers?.has(record.prNumber) ?? false);
        // Leave anything the live poller owns to the poller.
        if (ownsPullRequest(repo, record, seen)) {
          result.prsLeftToPoller += 1;
          continue;
        }
        if (seen) {
          const payload = toPullRequestPayload(repo, record);
          if (
            needsStateUpdate(payload.state, syncedPrStates.get(record.prUrl))
          ) {
            addCandidate(updateCandidates, repo.projectId, payload);
          }
          continue;
        }
        addCandidate(
          recoveryCandidates,
          repo.projectId,
          toPullRequestPayload(repo, record),
        );
        alreadyPending.add(key);
      }
    } catch (error) {
      // A single unreachable repo (no remote, revoked token, rate limit) must
      // not abort the sweep for every other workspace.
      result.reposFailed += 1;
      deps.onLog?.('PR reconciliation: repo sweep failed', {
        projectId: repo.projectId,
        repo: `${repo.owner}/${repo.repo}`,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const recovered = await enqueueWithFallback(
    recoveryCandidates,
    (projectId, payloads) => deps.enqueue(projectId, payloads),
    (projectId, error) => {
      result.reposFailed += 1;
      deps.onLog?.('PR reconciliation: enqueue failed', {
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
  result.prsRecovered = recovered.size;
  if (recovered.size > 0) {
    deps.onLog?.('PR reconciliation: recovered PRs', {
      count: recovered.size,
    });
  }

  // A PR this sweep just recovered is not also a state change. One no
  // workspace could recover stays a state update for a workspace that
  // recorded it by key alone.
  for (const prUrl of Array.from(recovered)) {
    updateCandidates.delete(prUrl);
  }
  const updated = await enqueueWithFallback(
    updateCandidates,
    (projectId, payloads) => deps.enqueueStateUpdates(projectId, payloads),
    (projectId, error) => {
      result.reposFailed += 1;
      deps.onLog?.('PR reconciliation: state update enqueue failed', {
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
  result.prsStateUpdated = updated.size;
  if (result.prsStateUpdated > 0) {
    deps.onLog?.('PR reconciliation: re-sent newer PR states', {
      count: result.prsStateUpdated,
    });
  }

  return result;
}
