import type {
  PortalPrActionPayload,
  PortalPrStatus,
  PortalWorktreePrActionsState,
} from '@canopy/protocol/portal';
import {
  portalPlannedSteps,
  type PortalPullRequestStep,
} from './pull-request-planned-steps';
import type {
  ProgressChecklistStep,
  WorktreePrBadgeCheckStatus,
  WorktreeRowPrStatus,
} from '@canopy/ui-shared/components';
import { PR_PHASE_LABELS } from '@canopy/ui-shared/lib';
import type {
  PullRequestSectionCheckStatus,
  PullRequestSectionPrStatus,
} from '../activity/PullRequestSectionBody';
import { portalPrStatusToSectionModel } from '../activity/portal-pr-section-mapper';
import type { BranchSyncAction } from './branch-actions';
import type {
  PullRequestActionRequest,
  PullRequestProgressTarget,
} from './PullRequestActions';
import {
  IDLE_PULL_REQUEST_ACTIVITY,
  type PullRequestActionsActivity,
  type PullRequestActionsFacts,
  type PullRequestActionsPr,
} from './pull-request-actions-plan';
import {
  COMMIT_PUSH_PHASE_LABELS,
  type PullRequestProgressModel,
} from './PullRequestProgressTooltip';

/**
 * The header's PR actions for a host that speaks the Portal vocabulary
 * (REG-3025): the web cloud worktree today. Its server decides the action
 * state (`PortalWorktreePrActionsState`) and reads the PR
 * (`PortalPrStatus`); these map both onto the shared facts and the user's
 * request back onto a `pr.action` payload.
 */

type PortalActionsRepo = PortalWorktreePrActionsState['repos'][number];

/** One worktree's PR action state as a Portal host holds it. */
export interface PortalPullRequestActionsRow {
  readonly repo: PortalActionsRepo | null;
  /** The action in flight, with what the user asked for. */
  readonly pendingPayload: PortalPrActionPayload | null;
  /** The steps the pending action runs, decided when it was asked for. */
  readonly plannedSteps: readonly (PortalPullRequestStep | 'create')[];
  /** The step the server reports the pending action on (or about to start). */
  readonly pendingStep: PortalPullRequestStep | 'create' | null;
  readonly cancellationRequested: boolean;
}

function badgeCheckStatus(
  status: PullRequestSectionCheckStatus,
): WorktreePrBadgeCheckStatus {
  return status === 'neutral' ? 'none' : status;
}

function tooltipOf(
  section: PullRequestSectionPrStatus,
  checkStatus: PullRequestSectionCheckStatus,
  unresolved: number | undefined,
): WorktreeRowPrStatus {
  return {
    state: section.state,
    checkStatus: badgeCheckStatus(checkStatus),
    reviewStatus: section.reviewStatus,
    ...(section.isMergeReady === undefined
      ? {}
      : { isMergeReady: section.isMergeReady }),
    url: section.prUrl,
    label: `PR #${section.prNumber}`,
    title: section.title,
    ciStatus: badgeCheckStatus(checkStatus),
    unresolvedCommentCount: unresolved ?? 0,
    hasConflicts: section.hasConflicts,
  };
}

/** The repository's PR from a Portal status, or null without one. */
function portalPr(
  repo: PortalActionsRepo,
  prStatus: PortalPrStatus | undefined,
): PullRequestActionsPr | null {
  const raw =
    prStatus?.repos?.find((entry) => entry.repoId === repo.repoId)?.status ??
    prStatus?.repos?.[0]?.status ??
    null;
  const sections = portalPrStatusToSectionModel(prStatus).repos;
  const section =
    sections?.find((entry) => entry.repoId === repo.repoId)?.status ??
    sections?.[0]?.status ??
    null;
  if (raw === null || section === null) return null;
  const checkStatus = raw.checkStatus ?? 'none';
  const unresolved = raw.unresolvedReviewThreadCount;
  return {
    number: section.prNumber,
    url: section.prUrl === '' ? null : section.prUrl,
    state: section.state,
    checkStatus,
    checkDetails: section.checkDetails,
    readyToMerge: raw.mergeReady === true,
    // The Portal status carries no merge queue entry yet.
    inMergeQueue: false,
    hasConflicts: raw.hasConflicts === true,
    // Unknown thread state warns, as on desktop.
    reviewThreadsWarning: unresolved === undefined || unresolved > 0,
    mergeRoute: 'direct',
    reviewStatus: section.reviewStatus,
    tooltip: tooltipOf(section, checkStatus, unresolved),
  };
}

/** The shared facts for one Portal worktree row. */
export function portalPullRequestActionsFacts(
  repo: PortalActionsRepo,
  prStatus: PortalPrStatus | undefined,
  options: { readonly agentHelpers?: boolean } = {},
): PullRequestActionsFacts {
  const ahead = repo.ahead ?? 0;
  const commitsAhead = repo.commitsAhead === true;
  return {
    isMultiRepo: false,
    repos: [
      {
        repoId: repo.repoId,
        repoName: repo.repoName,
        pr: portalPr(repo, prStatus),
      },
    ],
    worktree: {
      repoId: repo.repoId,
      commitsAhead,
      hasUncommittedChanges: repo.dirty === true,
      // An unpublished branch's own commits have not been pushed either.
      hasUnpushedCommits:
        ahead > 0 || (repo.published === false && commitsAhead),
      hasUnpulledCommits: (repo.behind ?? 0) > 0,
      hasRemoteTrackingBranch: repo.published === true,
      hasOriginRemote: true,
    },
    // Splitting needs the desktop's diff-size eligibility; a Portal host
    // does not offer it.
    splitPr: null,
    agentHelpers: options.agentHelpers === true,
  };
}

/** The branch-sync action a pending payload is, if any. */
function branchSyncOf(payload: PortalPrActionPayload): BranchSyncAction | null {
  switch (payload.action) {
    case 'commit':
      if (payload.push !== true) return 'commit';
      return payload.pullFirst === true
        ? 'pull-commit-and-push'
        : 'commit-and-push';
    case 'push':
      return 'push';
    case 'pull':
      return 'pull';
    default:
      return null;
  }
}

/**
 * What the row is running. A Portal merge is one GitHub call with no git
 * operation behind it, so it offers no cancel; nor does Create PR once its
 * own create call runs (every step before it stops at a boundary).
 */
export function portalPullRequestActivity(
  row: Pick<
    PortalPullRequestActionsRow,
    'pendingPayload' | 'cancellationRequested'
  > &
    Partial<Pick<PortalPullRequestActionsRow, 'pendingStep'>>,
): PullRequestActionsActivity {
  const payload = row.pendingPayload;
  const sync = payload === null ? null : branchSyncOf(payload);
  return {
    ...IDLE_PULL_REQUEST_ACTIVITY,
    committingAndPushing: sync !== null,
    activeBranchSyncAction: sync,
    creatingPr: payload?.action === 'create_auto',
    mergingPr: payload?.action === 'merge',
    cancellationRequested: row.cancellationRequested,
    mergeCancellable: false,
    createCancellable: row.pendingStep !== 'create',
  };
}

const STEP_LABEL: Readonly<Record<PortalPullRequestStep | 'create', string>> = {
  pull: COMMIT_PUSH_PHASE_LABELS.pulling,
  commit: COMMIT_PUSH_PHASE_LABELS.committing,
  push: COMMIT_PUSH_PHASE_LABELS.pushing,
  create: PR_PHASE_LABELS.creating_pr,
};

/**
 * The progress checklist for a running action, or null while it is idle
 * or the target is not the action that runs. Steps before the one the
 * server reports are done; once the git steps are done, opening the PR is.
 */
export function portalPullRequestProgress(
  target: PullRequestProgressTarget,
  row: PortalPullRequestActionsRow,
): PullRequestProgressModel | null {
  const payload = row.pendingPayload;
  if (payload === null) return null;
  const sync = branchSyncOf(payload);
  const matches =
    (target.type === 'commit-push' && sync === target.action) ||
    (target.type === 'create-pr' && payload.action === 'create_auto');
  if (!matches || row.plannedSteps.length === 0) return null;
  const current =
    row.pendingStep === null
      ? 0
      : Math.max(0, row.plannedSteps.indexOf(row.pendingStep));
  const steps: ProgressChecklistStep[] = row.plannedSteps.map(
    (step, index) => ({
      key: step,
      label: STEP_LABEL[step],
      status:
        index < current
          ? 'completed'
          : index === current
            ? 'active'
            : 'pending',
    }),
  );
  return { steps, badge: { label: 'In progress', tone: 'progress' } };
}

/**
 * The `pr.action` payload for what the user asked, pinned to what they saw:
 * the head always, the branches to create from, and the PR to merge or
 * align with. Null for a request the Portal host does not run.
 */
export function portalPullRequestActionPayload(
  request:
    | PullRequestActionRequest
    | { readonly kind: 'cancel' }
    | {
        readonly kind: 'align-base';
      },
  repo: PortalActionsRepo,
  prStatus: PortalPrStatus | undefined,
  target: {
    readonly workspaceLocalId: string;
    readonly worktreeLocalId: string;
  },
): PortalPrActionPayload | null {
  const head =
    repo.headSha === undefined || repo.headSha === null
      ? {}
      : { expectedHeadSha: repo.headSha };
  const base = { ...target, ...head };
  const pr = prStatus?.repos?.[0]?.status ?? null;
  switch (request.kind) {
    case 'branch-sync':
      switch (request.action) {
        case 'push':
        case 'pull':
          return { ...base, action: request.action };
        case 'commit':
          return { ...base, action: 'commit' };
        case 'commit-and-push':
          return { ...base, action: 'commit', push: true };
        case 'pull-commit-and-push':
          return { ...base, action: 'commit', push: true, pullFirst: true };
      }
      return null;
    case 'create-pr':
      return repo.baseBranch === undefined
        ? null
        : {
            ...base,
            action: 'create_auto',
            expectedBaseBranch: repo.baseBranch,
            expectedHeadBranch: repo.headBranch,
          };
    case 'merge':
      return typeof pr?.number === 'number' && pr.baseRefName !== undefined
        ? {
            ...base,
            // GitHub's PR head the user saw, not the sandbox's head.
            ...(typeof repo.prHeadSha === 'string'
              ? { expectedHeadSha: repo.prHeadSha }
              : {}),
            action: 'merge',
            expectedPrNumber: pr.number,
            expectedBaseBranch: pr.baseRefName,
            expectedHeadBranch: repo.headBranch,
          }
        : null;
    case 'align-base':
      return pr?.baseRefName === undefined
        ? null
        : { ...base, action: 'update_base_branch', baseBranch: pr.baseRefName };
    case 'cancel':
      return { ...target, action: 'cancel' };
    default:
      return null;
  }
}

export { portalPlannedSteps, type PortalPullRequestStep };
