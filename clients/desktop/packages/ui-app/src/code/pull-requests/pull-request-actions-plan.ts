import { aggregateCheckStatus } from '@canopy/protocol/pull-requests';
import type { WorktreeRowPrStatus } from '@canopy/ui-shared/components';
import type {
  PullRequestSectionCheckDetail,
  PullRequestSectionCheckStatus,
  PullRequestSectionPrState,
  PullRequestSectionReviewStatus,
} from '../activity/PullRequestSectionBody';
import {
  getMultiRepoBranchSyncVisibility,
  getSingleRepoGitAction,
  repoCanMergeLocalBranch,
  repoHasChanges,
  repoIsLocalOnly,
  repoRequiresCommitOnly,
  type BranchSyncAction,
  type PullRequestBranchFacts,
} from './branch-actions';
import {
  PULL_REQUEST_BLOCKED_COPY,
  describeMergeButton,
  getMergeQueueStatusLabel,
  type CreatePrLabelParams,
  type PrMergeRoute,
} from './pull-request-actions-copy';

/**
 * Which worktree-header PR actions apply, from host-neutral facts (REG-3025).
 *
 * These are the desktop `PrStatusBar` rules, moved so every host renders the
 * same controls for the same state. Hosts sample git and GitHub their own way
 * and describe the result here; nothing below knows which host it runs on.
 */

/** One repository's pull request, as the header needs it. */
export interface PullRequestActionsPr {
  readonly number: number;
  readonly url: string | null;
  readonly state: PullRequestSectionPrState;
  readonly checkStatus: PullRequestSectionCheckStatus;
  readonly checkDetails: readonly PullRequestSectionCheckDetail[];
  /** The host's merge readiness (desktop: `isPrReadyToMerge`). */
  readonly readyToMerge: boolean;
  readonly inMergeQueue: boolean;
  readonly mergeQueuePosition?: number;
  readonly hasConflicts: boolean;
  /**
   * The PR has unresolved review threads, or their state is unknown. Merge
   * takes its warning tint and help for it.
   */
  readonly reviewThreadsWarning: boolean;
  readonly mergeRoute: PrMergeRoute;
  readonly reviewStatus?: PullRequestSectionReviewStatus;
  /** Rich hover content for the PR badge. */
  readonly tooltip?: WorktreeRowPrStatus;
}

export interface PullRequestActionsRepo {
  readonly repoId: string;
  readonly repoName: string;
  /** `null` when the repository has no PR yet. */
  readonly pr: PullRequestActionsPr | null;
}

export interface PullRequestActionsFacts {
  readonly isMultiRepo: boolean;
  /** Every repository's PR, or `null` until the host has a PR snapshot. */
  readonly repos: readonly PullRequestActionsRepo[] | null;
  /**
   * The worktree's own git facts: the single repository, or the multi-repo
   * aggregate (`uncommitted`/`unpushed` across repositories).
   */
  readonly worktree: PullRequestBranchFacts;
  /** Per-repository git facts of a multi-repo worktree. */
  readonly repoBranches?: readonly PullRequestBranchFacts[];
  /**
   * Split PR where the host can split this PR at all (enabled and eligible);
   * `blockedReason` says what it waits for. `null` otherwise.
   */
  readonly splitPr: { readonly blockedReason?: string } | null;
  /**
   * The host starts agent chats from the header: Fix, Resolve conflicts and
   * Triage (`CanopyCapabilities.worktreePrAgentHelpers`). Without it those
   * actions still show, unavailable with the reason.
   */
  readonly agentHelpers: boolean;
}

/** The git or PR work in flight on this worktree. */
export interface PullRequestActionsActivity {
  readonly committingAndPushing: boolean;
  readonly activeBranchSyncAction: BranchSyncAction | null;
  readonly commitReviewPending: boolean;
  readonly creatingPr: boolean;
  readonly mergingLocalBranches: boolean;
  readonly mergingPr: boolean;
  /** A multi-repo merge is checking each PR before it asks. */
  readonly mergeChecking: boolean;
  /** A git stats refresh is finishing the action off; nothing to cancel. */
  readonly refreshing: boolean;
  readonly mergeRefreshing: boolean;
  readonly cancellationRequested: boolean;
  readonly startingCiFix: boolean;
  readonly startingConflictResolution: boolean;
  /**
   * The host can stop a running merge. Absent means it can (desktop); a host
   * whose merge is a single API call says it cannot, so no ✕ is offered.
   */
  readonly mergeCancellable?: boolean;
  /**
   * The host can still stop a running Create PR. Absent means it can
   * (desktop); a host whose create is one GitHub call says so once that
   * call is running, so no ✕ is offered for it.
   */
  readonly createCancellable?: boolean;
}

export const IDLE_PULL_REQUEST_ACTIVITY: PullRequestActionsActivity = {
  committingAndPushing: false,
  activeBranchSyncAction: null,
  commitReviewPending: false,
  creatingPr: false,
  mergingLocalBranches: false,
  mergingPr: false,
  mergeChecking: false,
  refreshing: false,
  mergeRefreshing: false,
  cancellationRequested: false,
  startingCiFix: false,
  startingConflictResolution: false,
};

export interface PullRequestCreatePlan {
  /** `undefined` creates for the single repository. */
  readonly repoIds: readonly string[] | undefined;
  readonly label: CreatePrLabelParams;
}

export interface PullRequestBadgesPlan {
  readonly checkStatus: PullRequestSectionCheckStatus;
  readonly checkDetails: readonly PullRequestSectionCheckDetail[];
  /** Single repository: its PR. */
  readonly pr: PullRequestActionsPr | null;
  /** Multi-repo: the open PRs the `N PRs` badge lists. */
  readonly openRepos: readonly PullRequestActionsRepo[];
}

export interface PullRequestActionsPlan {
  readonly badges: PullRequestBadgesPlan | null;
  /** Checks settled as failed: Fix beside the CI badge. */
  readonly fixCi: PullRequestBlockable | null;
  /** Branch-sync buttons, in render order. */
  readonly branchSync: readonly BranchSyncAction[];
  readonly splitPr: PullRequestBlockable | null;
  /** Local-only repositories to commit; `undefined` for the single repo. */
  readonly localCommit: {
    readonly repoIds: readonly string[] | undefined;
  } | null;
  readonly localMerge: boolean;
  readonly additionalCreatePr: PullRequestCreatePlan | null;
  readonly merge:
    | ({
        readonly via: PrMergeRoute;
        readonly help: string;
        readonly warning: boolean;
        /** Every open PR merges through a chat; no API merge runs. */
        readonly onlyStartsChat: boolean;
      } & PullRequestBlockable)
    | null;
  readonly mergeQueue: { readonly label: string } | null;
  readonly resolveConflicts: PullRequestBlockable | null;
  readonly createPr: PullRequestCreatePlan | null;
}

/**
 * An action that applies but waits: shown disabled with the reason (DESIGN:
 * only an action that can never apply is hidden). No reason: available.
 */
export interface PullRequestBlockable {
  readonly blockedReason?: string;
}

/** Why Merge waits on this PR, in the shared blocked-action copy. */
function mergeBlockedReason(
  pr: PullRequestActionsPr | null,
  clean: boolean,
  busy: boolean,
): string {
  if (!clean) return PULL_REQUEST_BLOCKED_COPY.mergeLocalChanges;
  if (busy) return PULL_REQUEST_BLOCKED_COPY.busy;
  if (pr === null) return PULL_REQUEST_BLOCKED_COPY.mergeNotReady;
  if (pr.state === 'draft') return PULL_REQUEST_BLOCKED_COPY.mergeDraft;
  if (pr.hasConflicts) return PULL_REQUEST_BLOCKED_COPY.mergeConflicts;
  if (pr.checkStatus === 'failing') {
    return PULL_REQUEST_BLOCKED_COPY.mergeChecksFailing;
  }
  if (pr.checkStatus === 'pending') {
    return PULL_REQUEST_BLOCKED_COPY.mergeChecksPending;
  }
  if (
    pr.reviewStatus === 'changes_requested' ||
    pr.reviewStatus === 'pending'
  ) {
    return PULL_REQUEST_BLOCKED_COPY.mergeReview;
  }
  return PULL_REQUEST_BLOCKED_COPY.mergeNotReady;
}

function hasOpenPr(repo: PullRequestActionsRepo): boolean {
  return repo.pr?.state === 'open' || repo.pr?.state === 'draft';
}

function scopedBranches(
  repoBranches: readonly PullRequestBranchFacts[] | undefined,
  repoIds: readonly string[],
): readonly PullRequestBranchFacts[] | undefined {
  if (repoIds.length === 0) return undefined;
  const ids = new Set(repoIds);
  return repoBranches?.filter((branch) => ids.has(branch.repoId));
}

function branchOf(
  facts: PullRequestActionsFacts,
  repoId: string,
): PullRequestBranchFacts | undefined {
  return facts.repoBranches?.find((branch) => branch.repoId === repoId);
}

/** The header's PR controls for this worktree, and what each offers. */
export function planPullRequestActions(
  facts: PullRequestActionsFacts,
  activity: PullRequestActionsActivity,
): PullRequestActionsPlan {
  const { isMultiRepo, worktree, repoBranches } = facts;
  const repos = facts.repos ?? [];
  const hasSnapshot = facts.repos !== null;
  const withPr = repos.filter((repo) => repo.pr !== null);
  const hasPr = withPr.length > 0;
  const openRepos = repos.filter(hasOpenPr);
  const anyOpenPr = openRepos.length > 0;
  const uncommitted = worktree.hasUncommittedChanges === true;
  const unpushed = worktree.hasUnpushedCommits === true;

  // ---- Badges ----
  const badgeRepos = isMultiRepo ? openRepos : withPr;
  const checkDetails = badgeRepos.flatMap(
    (repo) => repo.pr?.checkDetails ?? [],
  );
  const checkStatus = aggregateCheckStatus(
    badgeRepos
      .map((repo) => repo.pr?.checkStatus)
      .filter((s): s is PullRequestSectionCheckStatus => s != null),
  );
  const badges: PullRequestBadgesPlan | null = !hasPr
    ? null
    : isMultiRepo
      ? openRepos.length > 0
        ? { checkStatus, checkDetails, pr: null, openRepos }
        : null
      : { checkStatus, checkDetails, pr: withPr[0]?.pr ?? null, openRepos: [] };
  const openDetails = openRepos.flatMap((repo) => repo.pr?.checkDetails ?? []);
  const ciSettledFailed =
    badges !== null &&
    openDetails.some((detail) => detail.status === 'failing') &&
    !openDetails.some((detail) => detail.status === 'pending');
  const fixCi: PullRequestBlockable | null = !ciSettledFailed
    ? null
    : facts.agentHelpers
      ? {}
      : { blockedReason: PULL_REQUEST_BLOCKED_COPY.fixUnavailable };

  // ---- Branch sync ----
  const multiActions = getMultiRepoBranchSyncVisibility(
    repoBranches,
    openRepos.map((repo) => repo.repoId),
  );
  const multiPull = getMultiRepoBranchSyncVisibility(repoBranches);
  const singleAction = getSingleRepoGitAction({
    hasOpenPr: anyOpenPr,
    hasAnyChanges: worktree.commitsAhead === true || uncommitted || unpushed,
    hasRemoteTracking: worktree.hasRemoteTrackingBranch === true,
    hasOriginRemote: worktree.hasOriginRemote,
    hasUncommittedChanges: uncommitted,
    hasUnpushedCommits: unpushed,
    hasUnpulledCommits: worktree.hasUnpulledCommits === true,
    commitsAhead: worktree.commitsAhead,
    baseBranchExistsLocally: worktree.baseBranchExistsLocally,
  });
  const running = activity.committingAndPushing;
  const active = activity.activeBranchSyncAction;
  const branchSync: BranchSyncAction[] = [];
  if (
    running
      ? active === 'commit-and-push'
      : anyOpenPr &&
        (isMultiRepo
          ? multiActions.showCommitAndPush
          : singleAction === 'commit-and-push')
  ) {
    branchSync.push('commit-and-push');
  }
  if (
    running
      ? active === 'pull-commit-and-push'
      : anyOpenPr &&
        (isMultiRepo
          ? multiActions.showPullCommitAndPush
          : singleAction === 'pull-commit-and-push')
  ) {
    branchSync.push('pull-commit-and-push');
  }
  if (
    running
      ? active === 'push'
      : anyOpenPr &&
        (isMultiRepo ? multiActions.showPush : singleAction === 'push')
  ) {
    branchSync.push('push');
  }
  if (
    running
      ? active === 'pull'
      : isMultiRepo
        ? multiPull.showPull
        : singleAction === 'pull'
  ) {
    branchSync.push('pull');
  }

  // ---- Local-only Commit / Merge ----
  const localCommitRepoIds = isMultiRepo
    ? (repoBranches
        ?.filter((branch) => repoRequiresCommitOnly(branch))
        .map((branch) => branch.repoId) ?? [])
    : repoRequiresCommitOnly(worktree)
      ? [worktree.repoId]
      : [];
  // Keep the Commit progress surface mounted for any commit-only operation:
  // Branch-from's "Commit first" uses it even for remote-backed repos.
  const localCommit =
    localCommitRepoIds.length > 0 || (running && active === 'commit')
      ? { repoIds: isMultiRepo ? localCommitRepoIds : undefined }
      : null;
  const localMerge = isMultiRepo
    ? (repoBranches?.some((branch) => repoCanMergeLocalBranch(branch)) ?? false)
    : repoCanMergeLocalBranch(worktree);

  // ---- Create PR ----
  const busy =
    activity.committingAndPushing ||
    activity.mergingLocalBranches ||
    activity.mergingPr;
  const readyForPr =
    hasSnapshot && !hasPr && isMultiRepo
      ? repos.filter((repo) => {
          const branch = branchOf(facts, repo.repoId);
          return !repoIsLocalOnly(branch) && repoHasChanges(branch);
        })
      : [];
  const showCreatePr =
    (activity.creatingPr && (!isMultiRepo || !hasPr)) ||
    (hasSnapshot
      ? isMultiRepo
        ? !hasPr && readyForPr.length > 0
        : !hasPr
          ? singleAction === 'create-pr'
          : !running && singleAction === 'create-pr'
      : false);
  const readyIds = readyForPr.map((repo) => repo.repoId);
  const createPr: PullRequestCreatePlan | null =
    showCreatePr && !busy
      ? {
          repoIds: isMultiRepo ? readyIds : undefined,
          label: {
            isMultiRepo,
            uncommittedChanges: uncommitted,
            hasUnpushedCommits: unpushed,
            ...(isMultiRepo
              ? { repoBranches: scopedBranches(repoBranches, readyIds) }
              : repoBranches === undefined
                ? {}
                : { repoBranches }),
            repoCount: readyForPr.length,
          },
        }
      : null;
  const needingPr =
    hasPr && isMultiRepo
      ? repos.filter((repo) => {
          if (hasOpenPr(repo)) return false;
          const branch = branchOf(facts, repo.repoId);
          return !repoIsLocalOnly(branch) && repoHasChanges(branch);
        })
      : [];
  const needingIds = needingPr.map((repo) => repo.repoId);
  const additionalCreatePr: PullRequestCreatePlan | null =
    (needingPr.length > 0 || (activity.creatingPr && isMultiRepo && hasPr)) &&
    !busy
      ? {
          repoIds: needingIds,
          label: {
            isMultiRepo: true,
            uncommittedChanges: uncommitted,
            hasUnpushedCommits: unpushed,
            repoBranches: scopedBranches(repoBranches, needingIds),
            repoCount: needingPr.length,
          },
        }
      : null;

  // ---- Merge ----
  // The worktree must be locally clean (nothing uncommitted or unpushed)
  // before a PR merge is offered.
  const cleanForMerge =
    isMultiRepo && repoBranches
      ? repoBranches.every(
          (branch) =>
            branch.hasUncommittedChanges !== true &&
            branch.hasUnpushedCommits !== true,
        )
      : !uncommitted && !unpushed;
  const mergeable = openRepos.filter((repo) => repo.pr?.readyToMerge === true);
  const queued = openRepos.filter((repo) => repo.pr?.inMergeQueue === true);
  const conflicting = openRepos.filter(
    (repo) => repo.pr?.hasConflicts === true,
  );
  const warning = mergeable.some(
    (repo) => repo.pr?.state === 'open' && repo.pr.reviewThreadsWarning,
  );
  const presentation = describeMergeButton({
    routes: mergeable.map((repo) => repo.pr?.mergeRoute ?? 'direct'),
    warning,
  });
  // Once a merge request has started, keep its button mounted even if a
  // poll observes one of GitHub's transient not-mergeable states.
  const showMerge =
    activity.mergingPr || (mergeable.length > 0 && cleanForMerge && !busy);
  const onlyStartsChat =
    openRepos.length > 0 &&
    openRepos.every((repo) => repo.pr?.mergeRoute === 'chat');
  // The status describes the whole worktree only when every open PR is
  // queued, and merge conflicts take precedence.
  const mergeQueue =
    !showMerge &&
    queued.length > 0 &&
    queued.length === openRepos.length &&
    conflicting.length === 0
      ? {
          label: getMergeQueueStatusLabel(
            queued.length === 1 ? queued[0]?.pr?.mergeQueuePosition : undefined,
          ),
        }
      : null;

  // An open PR that cannot merge yet keeps its Merge, disabled with what it
  // waits for; the merge queue status replaces it while the PR is queued.
  const waiting =
    openRepos.find((repo) => repo.pr?.readyToMerge !== true) ?? openRepos[0];
  const merge = showMerge
    ? {
        via: presentation.via,
        help: presentation.help,
        warning,
        onlyStartsChat,
      }
    : openRepos.length > 0 && mergeQueue === null
      ? {
          via: waiting?.pr?.mergeRoute ?? 'direct',
          help: mergeBlockedReason(waiting?.pr ?? null, cleanForMerge, busy),
          warning: false,
          onlyStartsChat,
          blockedReason: mergeBlockedReason(
            waiting?.pr ?? null,
            cleanForMerge,
            busy,
          ),
        }
      : null;
  const resolveConflicts: PullRequestBlockable | null =
    conflicting.length === 0
      ? null
      : !facts.agentHelpers
        ? { blockedReason: PULL_REQUEST_BLOCKED_COPY.resolveUnavailable }
        : !cleanForMerge
          ? { blockedReason: PULL_REQUEST_BLOCKED_COPY.resolveLocalChanges }
          : busy
            ? { blockedReason: PULL_REQUEST_BLOCKED_COPY.busy }
            : {};

  return {
    badges,
    fixCi,
    branchSync,
    splitPr: facts.splitPr,
    localCommit,
    localMerge,
    additionalCreatePr,
    merge,
    mergeQueue,
    resolveConflicts,
    createPr,
  };
}
