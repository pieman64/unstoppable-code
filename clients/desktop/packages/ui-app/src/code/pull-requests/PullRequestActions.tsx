'use client';

import type { JSX, ReactElement, ReactNode } from 'react';
import {
  CancelActionButton,
  HeaderActionButton,
  RichHoverTooltip,
  RunningActionIcon,
  ThinkingSpinner,
  Tooltip,
  type TooltipTriggerProps,
} from '@canopy/ui-shared/components';
import {
  ChatIcon,
  GitCommitIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  SplitPrIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import type { BranchSyncAction } from './branch-actions';
import {
  CreatePrLabel,
  getBranchSyncActionLabel,
  getCreatePrActionName,
} from './pull-request-actions-copy';
import type {
  PullRequestActionsActivity,
  PullRequestActionsPlan,
  PullRequestCreatePlan,
} from './pull-request-actions-plan';
import {
  CiStatusBadgeWithPopover,
  MultiRepoPrBadge,
  PullRequestStateBadgeWithTooltip,
} from './PullRequestBadges';

/**
 * The worktree header's PR actions (REG-3025): THE one implementation of
 * Commit & Push / Push / Pull / Create PR / Merge and the controls beside
 * them, rendered by the desktop `PrStatusBar` and the web top bar alike.
 *
 * Pure display. The host samples state into {@link PullRequestActionsPlan}
 * and {@link PullRequestActionsActivity}, and runs what the user asks for
 * through {@link PullRequestActionsProps.onAction}. Nothing here knows which
 * host it is on.
 */

/** What the user asked the header to do. */
export type PullRequestActionRequest =
  | { readonly kind: 'branch-sync'; readonly action: BranchSyncAction }
  | {
      readonly kind: 'create-pr';
      /** `undefined` creates for the single repository. */
      readonly repoIds: readonly string[] | undefined;
    }
  | {
      readonly kind: 'local-commit';
      readonly repoIds: readonly string[] | undefined;
    }
  | { readonly kind: 'local-merge' }
  | { readonly kind: 'merge' }
  | { readonly kind: 'resolve-conflicts' }
  | { readonly kind: 'fix-ci' }
  | { readonly kind: 'split-pr' }
  | { readonly kind: 'open-pr-details' };

/** The action a progress checklist describes. */
export type PullRequestProgressTarget =
  | { readonly type: 'commit-push'; readonly action: BranchSyncAction }
  | { readonly type: 'merge' }
  | { readonly type: 'merge-pr' }
  | { readonly type: 'create-pr' };

/**
 * Wraps an action button in the host's in-progress checklist tooltip. The
 * wrapper clones trigger props onto the raw button, so it receives it
 * directly. Hosts without one render the button as is.
 */
export type PullRequestProgressRenderer = (
  target: PullRequestProgressTarget,
  trigger: ReactElement<TooltipTriggerProps>,
  options: { readonly dataTestId?: string; readonly suppressed?: boolean },
) => ReactElement;

const renderWithoutProgress: PullRequestProgressRenderer = (_target, trigger) =>
  trigger;

/**
 * Every header action shares one shell — 28px tall, `rounded-md`, the same
 * padding, text size and gap — so Create PR, Commit & Push and Merge read as
 * one family instead of three unrelated pills. Only the TINT differs.
 *
 * No `disabled:opacity-60`: while an action runs it keeps its normal weight
 * and swaps its leading icon for a spinner (see `RunningActionIcon`), rather
 * than greying out and renaming itself, which read as "broken" mid-flight.
 */
const HEADER_ACTION_BTN =
  'electron-no-drag focus-ring inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-xs font-normal transition-colors';

// Each shell pairs its `hover:` with the same `group-hover/gitaction:`
// background: while an action runs, the cancel ✕ is an overlay INSIDE the
// group but OUTSIDE the pill, so without the group-hover the pill would drop
// its hover state the moment the pointer reaches the ✕. Outside a
// `group/gitaction` (e.g. Split PR) the group-hover half simply never fires.
const COMMIT_PUSH_BTN = `${HEADER_ACTION_BTN} fg-primary enabled:hover:bg-subtle enabled:group-hover/gitaction:bg-subtle`;

// Primary git actions (Commit / Commit & Push / Push / Pull / local Merge /
// Merge PR) keep the ghost shell but take the accent ink, like Create PR, so
// the one thing to do next stands out from the neutral controls beside it.
// Merge PR used the merged status ink before; it read as "already merged".
const GIT_ACTION_ACCENT_BTN = `${HEADER_ACTION_BTN} fg-accent enabled:hover:bg-accent-subtle enabled:group-hover/gitaction:bg-accent-subtle`;

/**
 * An action that applies but waits (DESIGN.md: disabled with its reason,
 * never hidden). `aria-disabled` keeps it focusable and hoverable, so its
 * tooltip can say why; it reads as unavailable at 60% under a not-allowed
 * cursor, the shared Button's treatment, and loses its hover wash.
 */
const BLOCKED_ACTION =
  'aria-disabled:cursor-not-allowed aria-disabled:opacity-60 aria-disabled:hover:bg-transparent aria-disabled:group-hover/gitaction:bg-transparent';

// Warning variant of the primary merge button, shown when the PR has
// unresolved review comments. The default state is GIT_ACTION_ACCENT_BTN.
const MERGE_PR_WARNING_BTN = `${HEADER_ACTION_BTN} fg-warning hover:bg-warning-subtle group-hover/gitaction:bg-warning-subtle`;

// Non-interactive status that replaces Merge while the PR sits in its base
// branch's merge queue. Same footprint as the header actions so nothing shifts
// when it swaps in; the pending tint matches the sidebar row's queued glyph.
const MERGE_QUEUE_STATUS =
  'electron-no-drag inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-xs font-normal fg-warning';

/**
 * Progressive disclosure for the header's action cluster, lowest priority
 * first. The cluster has intrinsic width inside a `min-w-0 flex-1` status
 * region, so without this it simply OVERFLOWED the bar and painted on top of
 * the sibling launch cluster (the archive/PR/`Open in` controls ran past the
 * bar's right edge and sat over the Launch button) rather than degrading.
 *
 * Each tier drops one control as `@container/topbar` narrows, in the order
 * a user can most afford to lose it. Everything below the last tier —
 * breadcrumb (truncates), Launch, and the layout menu — always renders, so
 * the bar keeps a usable floor.
 *
 * Tailwind needs literal class strings, so these are constants rather than
 * a computed scale.
 */
export const HEADER_PRIORITY = {
  /** First to go: archives are reachable from the chat surface too. */
  archive: 'hidden @[560px]/topbar:flex',
  /**
   * Then the Create PR action. Applied to a WRAPPER, never the shared button:
   * Tailwind resolves competing display utilities by stylesheet order rather
   * than by position in the class attribute, so the button could otherwise
   * stay visible at every width and keep overflowing.
   */
  createPr: 'hidden @[480px]/topbar:flex',
  /** Then the PR/CI status badges (informational, not actions). */
  badges: 'hidden @[420px]/topbar:flex',
  /** Last: `Open in`. Below this only breadcrumb + Launch + menu remain. */
  openIn: 'hidden @[360px]/topbar:flex',
  /**
   * Pinned scripts (`WorktreeTopBarPins`) shed their labels before any other
   * header copy, showing the labelled pin above the threshold and the compact
   * play button below it. Both halves share one breakpoint so exactly one of
   * them renders at every width.
   */
  pinLabels: 'hidden @[760px]/topbar:flex',
  pinCompact: 'flex @[760px]/topbar:hidden',
  /**
   * Then the whole pinned run drops, after the badges and before `Open in`
   * and the launch cluster: pins are user-chosen shortcuts to commands the
   * terminal and composer still reach.
   */
  pins: 'hidden @[400px]/topbar:flex',
} as const;

export interface PullRequestActionsProps {
  readonly plan: PullRequestActionsPlan;
  readonly activity: PullRequestActionsActivity;
  readonly onAction: (request: PullRequestActionRequest) => void;
  /** Cancels the running git action. */
  readonly onCancel: () => void;
  readonly renderProgress?: PullRequestProgressRenderer;
  /**
   * The status that replaces Merge while a PR is in its base branch's merge
   * queue, from a host with richer queue data (desktop: GitHub's estimate and
   * a popover listing the queue). Defaults to the plain queue label.
   */
  readonly renderMergeQueueStatus?: () => ReactNode;
}

function isBusy(activity: PullRequestActionsActivity): boolean {
  return (
    activity.committingAndPushing ||
    activity.mergingLocalBranches ||
    activity.mergingPr
  );
}

function BranchSyncButton({
  action,
  activity,
  onAction,
  onCancel,
  renderProgress,
}: {
  readonly action: BranchSyncAction;
  readonly activity: PullRequestActionsActivity;
  readonly onAction: PullRequestActionsProps['onAction'];
  readonly onCancel: () => void;
  readonly renderProgress: PullRequestProgressRenderer;
}): JSX.Element {
  const isReviewing = activity.commitReviewPending;
  const isActive =
    activity.committingAndPushing && activity.activeBranchSyncAction === action;
  const isRefreshing = activity.refreshing && isActive;
  const requiresReview =
    action === 'commit-and-push' || action === 'pull-commit-and-push';
  // The label stays put while the action runs — only the leading icon becomes
  // a spinner. Swapping to "Pushing…"/"Refreshing…" made the control appear to
  // change identity mid-click.
  const label =
    isReviewing && requiresReview
      ? 'Review…'
      : getBranchSyncActionLabel(action);
  // Cancellation is offered while this action is the running one and a stats
  // refresh is not already finishing it off.
  const cancellable =
    isActive && !isRefreshing && !activity.cancellationRequested;

  return (
    <div className="group/gitaction relative inline-flex items-center">
      {renderProgress(
        { type: 'commit-push', action },
        <button
          type="button"
          onClick={() => {
            // While this action is the one running, the button IS the cancel
            // control — that is what the hover ✕ in its icon slot promises.
            if (cancellable) {
              onCancel();
              return;
            }
            onAction({ kind: 'branch-sync', action });
          }}
          // Stays clickable while cancellable, otherwise the hover ✕ would be
          // a dead affordance.
          disabled={cancellable ? false : isBusy(activity) || isReviewing}
          aria-label={
            cancellable
              ? `Cancel ${label.charAt(0).toLowerCase()}${label.slice(1)}`
              : undefined
          }
          data-testid="pr-status-bar-branch-sync"
          className={GIT_ACTION_ACCENT_BTN}
        >
          {isActive && !isReviewing ? (
            <RunningActionIcon
              cancellationRequested={activity.cancellationRequested}
              spinnerTone="accent"
            />
          ) : (
            <GitCommitIcon className="h-4 w-4" />
          )}
          {label}
        </button>,
        {},
      )}
      {cancellable && (
        <CancelActionButton
          onCancel={onCancel}
          label={`Cancel ${label.charAt(0).toLowerCase()}${label.slice(1)}`}
        />
      )}
    </div>
  );
}

function createPrCancellable(activity: PullRequestActionsActivity): boolean {
  return (
    activity.creatingPr &&
    activity.createCancellable !== false &&
    !activity.refreshing &&
    !activity.cancellationRequested
  );
}

function CreatePrButton({
  create,
  activity,
  onAction,
  onCancel,
  renderProgress,
  testId,
}: {
  readonly create: PullRequestCreatePlan;
  readonly activity: PullRequestActionsActivity;
  readonly onAction: PullRequestActionsProps['onAction'];
  readonly onCancel: () => void;
  readonly renderProgress: PullRequestProgressRenderer;
  readonly testId?: string;
}): ReactElement {
  const cancellable = createPrCancellable(activity);
  return renderProgress(
    { type: 'create-pr' },
    <HeaderActionButton
      onClick={() => {
        if (cancellable) {
          onCancel();
          return;
        }
        onAction({ kind: 'create-pr', repoIds: create.repoIds });
      }}
      disabled={cancellable ? false : activity.creatingPr || isBusy(activity)}
      {...(testId === undefined ? {} : { 'data-testid': testId })}
      aria-label={
        cancellable ? 'Cancel create PR' : getCreatePrActionName(create.label)
      }
      groupHover
    >
      {activity.creatingPr ? (
        <RunningActionIcon
          cancellationRequested={activity.cancellationRequested}
          spinnerTone="accent"
        />
      ) : (
        <GitPullRequestIcon className="h-4 w-4 shrink-0" />
      )}
      <CreatePrLabel {...create.label} />
    </HeaderActionButton>,
    {},
  );
}

/**
 * The header's status run: PR and CI badges, then the git and PR actions
 * that apply. Renders as siblings inside the host's status row.
 */
export function PullRequestActions({
  plan,
  activity,
  onAction,
  onCancel,
  renderProgress = renderWithoutProgress,
  renderMergeQueueStatus,
}: PullRequestActionsProps): JSX.Element {
  const busy = isBusy(activity);
  const { badges } = plan;

  // Rendered beside the CI badge when checks have settled as failed.
  // Starts an agent chat that diagnoses and fixes the failing checks; a host
  // without agent helpers shows it unavailable, with the reason.
  const fixBlocked = plan.fixCi?.blockedReason;
  const ciFixButton =
    plan.fixCi === null ? null : (
      <Tooltip label={fixBlocked ?? 'Fix failing CI checks'}>
        <button
          type="button"
          onClick={
            fixBlocked === undefined
              ? (): void => onAction({ kind: 'fix-ci' })
              : undefined
          }
          disabled={fixBlocked === undefined ? activity.startingCiFix : false}
          aria-disabled={fixBlocked === undefined ? undefined : true}
          data-testid="pr-status-bar-fix-ci"
          aria-label="Fix failing CI checks"
          className={`${HEADER_ACTION_BTN} fg-warning hover:bg-warning-subtle ${BLOCKED_ACTION}`}
        >
          {activity.startingCiFix ? (
            <ThinkingSpinner tone="emphasis" quiet className="mr-1" />
          ) : (
            <ChatIcon className="h-4 w-4" />
          )}
          Fix
        </button>
      </Tooltip>
    );

  const localCommitRunning =
    activity.committingAndPushing &&
    activity.activeBranchSyncAction === 'commit';
  const localCommitCancellable =
    localCommitRunning &&
    !activity.refreshing &&
    !activity.cancellationRequested;
  const localMergeCancellable =
    activity.mergingLocalBranches &&
    !activity.refreshing &&
    !activity.cancellationRequested;
  const mergePrCancellable =
    activity.mergeCancellable !== false &&
    (activity.mergingPr || activity.mergeChecking) &&
    !activity.refreshing &&
    !activity.mergeRefreshing &&
    !activity.cancellationRequested;
  // Starting a merge chat takes a few seconds and has nothing to cancel, so
  // the button waits disabled with a spinner that keeps its slot under the
  // pointer.
  const mergeChatStarting =
    activity.mergingPr && plan.merge?.onlyStartsChat === true;
  const mergePrCancelOffered = mergePrCancellable && !mergeChatStarting;

  return (
    <>
      {badges !== null && badges.pr === null && (
        <>
          <MultiRepoPrBadge
            openRepos={badges.openRepos}
            onOpen={() => onAction({ kind: 'open-pr-details' })}
          />
          <CiStatusBadgeWithPopover
            status={badges.checkStatus}
            checkDetails={badges.checkDetails}
          />
          {ciFixButton}
        </>
      )}
      {badges !== null && badges.pr !== null && (
        <div className={`${HEADER_PRIORITY.badges} items-center gap-1`}>
          {/* CI leads the PR badge: the check state is what you scan for
              while a PR is open, and the PR number is the stable anchor
              after it. */}
          <CiStatusBadgeWithPopover
            status={badges.checkStatus}
            checkDetails={badges.checkDetails}
          />
          <PullRequestStateBadgeWithTooltip pr={badges.pr} />
          {ciFixButton}
        </div>
      )}

      {plan.branchSync.map((action) => (
        <BranchSyncButton
          key={action}
          action={action}
          activity={activity}
          onAction={onAction}
          onCancel={onCancel}
          renderProgress={renderProgress}
        />
      ))}

      {plan.splitPr !== null &&
        (plan.splitPr.blockedReason === undefined ? (
          <button
            type="button"
            onClick={() => onAction({ kind: 'split-pr' })}
            data-testid="split-pr-status-bar-button"
            className={COMMIT_PUSH_BTN}
          >
            <SplitPrIcon className="h-4 w-4" />
            Split PR
          </button>
        ) : (
          // Eligible but waiting: shown disabled with what it waits for,
          // as the PR card's Split does.
          <Tooltip label={plan.splitPr.blockedReason}>
            <button
              type="button"
              aria-disabled="true"
              data-testid="split-pr-status-bar-button"
              className={`${COMMIT_PUSH_BTN} ${BLOCKED_ACTION}`}
            >
              <SplitPrIcon className="h-4 w-4" />
              Split PR
            </button>
          </Tooltip>
        ))}

      {/* Local-only Commit / Merge: repositories without an `origin`
          remote. Neither action pushes. */}
      {plan.localCommit !== null && (
        <span className="group/gitaction relative inline-flex items-center">
          {renderProgress(
            { type: 'commit-push', action: 'commit' },
            <button
              type="button"
              onClick={
                localCommitCancellable
                  ? onCancel
                  : (): void =>
                      onAction({
                        kind: 'local-commit',
                        repoIds: plan.localCommit?.repoIds,
                      })
              }
              disabled={
                localCommitCancellable
                  ? false
                  : busy || activity.commitReviewPending
              }
              aria-label={localCommitCancellable ? 'Cancel commit' : undefined}
              data-testid="pr-status-bar-local-commit"
              className={GIT_ACTION_ACCENT_BTN}
            >
              {localCommitRunning ? (
                <RunningActionIcon
                  cancellationRequested={activity.cancellationRequested}
                  spinnerTone="accent"
                />
              ) : (
                <GitCommitIcon className="h-4 w-4" />
              )}
              {activity.commitReviewPending ? 'Review…' : 'Commit'}
            </button>,
            {},
          )}
          {localCommitCancellable && (
            <CancelActionButton onCancel={onCancel} label="Cancel commit" />
          )}
        </span>
      )}
      {plan.localMerge && (
        <span className="group/gitaction relative inline-flex items-center">
          {renderProgress(
            { type: 'merge' },
            <button
              type="button"
              onClick={
                localMergeCancellable
                  ? onCancel
                  : (): void => onAction({ kind: 'local-merge' })
              }
              disabled={
                localMergeCancellable
                  ? false
                  : busy || activity.creatingPr || activity.commitReviewPending
              }
              aria-label={localMergeCancellable ? 'Cancel merge' : undefined}
              className={GIT_ACTION_ACCENT_BTN}
            >
              {activity.mergingLocalBranches ? (
                <RunningActionIcon
                  cancellationRequested={activity.cancellationRequested}
                  spinnerTone="accent"
                />
              ) : (
                <GitMergeIcon className="h-4 w-4" />
              )}
              Merge
            </button>,
            {},
          )}
          {localMergeCancellable && (
            <CancelActionButton onCancel={onCancel} label="Cancel merge" />
          )}
        </span>
      )}

      {plan.additionalCreatePr !== null && (
        <span className="group/gitaction relative inline-flex items-center">
          <CreatePrButton
            create={plan.additionalCreatePr}
            activity={activity}
            onAction={onAction}
            onCancel={onCancel}
            renderProgress={renderProgress}
          />
          {createPrCancellable(activity) && (
            <CancelActionButton onCancel={onCancel} label="Cancel create PR" />
          )}
        </span>
      )}

      {/* Merge PR (GitHub API): an open, mergeable PR on a locally clean
          worktree. Warning-coloured when any mergeable PR has unresolved
          review comments; the chat glyph when an agent chat will drive the
          merge. An open PR that cannot merge yet keeps Merge, disabled with
          what it waits for as its tooltip. */}
      {plan.merge !== null && (
        <span className="group/gitaction relative inline-flex items-center">
          {/* Idle-state help lives on the outer rich Tooltip; it is
              suppressed (wrapper kept, so the button never remounts mid
              action) while merging, when the progress checklist is the only
              surface. A merge that only starts a chat shows neither: the
              chat reports progress. */}
          <Tooltip suppressed={activity.mergingPr} label={plan.merge.help}>
            {renderProgress(
              { type: 'merge-pr' },
              <button
                type="button"
                onClick={
                  mergePrCancelOffered
                    ? onCancel
                    : plan.merge.blockedReason === undefined
                      ? (): void => onAction({ kind: 'merge' })
                      : undefined
                }
                disabled={
                  mergePrCancelOffered || plan.merge.blockedReason !== undefined
                    ? false
                    : activity.mergingPr ||
                      activity.creatingPr ||
                      activity.mergeChecking
                }
                aria-disabled={
                  plan.merge.blockedReason === undefined ? undefined : true
                }
                aria-label={mergePrCancelOffered ? 'Cancel merge' : undefined}
                aria-busy={mergeChatStarting || undefined}
                data-testid="pr-status-bar-merge-pr"
                data-merge-via={plan.merge.via}
                className={`${
                  plan.merge.warning
                    ? MERGE_PR_WARNING_BTN
                    : GIT_ACTION_ACCENT_BTN
                } ${BLOCKED_ACTION}`}
              >
                {activity.mergingPr || activity.mergeChecking ? (
                  <RunningActionIcon
                    cancellationRequested={
                      activity.cancellationRequested || mergeChatStarting
                    }
                    spinnerTone="inherit"
                  />
                ) : plan.merge.via === 'chat' ? (
                  <ChatIcon className="h-4 w-4" />
                ) : (
                  <GitMergeIcon className="h-4 w-4" />
                )}
                Merge
              </button>,
              {
                dataTestId: 'pr-status-bar-merge-pr-tooltip',
                suppressed: plan.merge.onlyStartsChat,
              },
            )}
          </Tooltip>
          {mergePrCancelOffered && (
            <CancelActionButton
              onCancel={onCancel}
              label="Cancel merge"
              tone={plan.merge.warning ? 'warning' : 'accent'}
            />
          )}
        </span>
      )}

      {/* Replaces Merge while the PR is in its base branch's merge queue.
          Non-interactive: GitHub merges the PR once the queue's checks pass,
          and the PR badge keeps the GitHub link. */}
      {plan.mergeQueue !== null &&
        (renderMergeQueueStatus?.() ?? (
          <Tooltip label="GitHub merges this pull request when the merge queue's checks pass">
            <span
              className={MERGE_QUEUE_STATUS}
              data-testid="pr-status-bar-merge-queue"
            >
              <GitMergeIcon className="h-4 w-4" />
              {plan.mergeQueue.label}
            </span>
          </Tooltip>
        ))}

      {/* GitHub reports merge conflicts: an agent chat resolves them, then
          commits and pushes. It waits for a clean worktree, and a host
          without agent helpers shows it unavailable; both with the reason. */}
      {plan.resolveConflicts !== null &&
        (plan.resolveConflicts.blockedReason === undefined ? (
          <RichHoverTooltip
            surfaceClassName="min-w-55 max-w-75"
            surfacePadding="card"
            content={
              <>
                <div className="mb-1 font-semibold fg-primary">
                  Merge conflicts detected
                </div>
                <span className="fg-secondary">
                  Click to have an agent handle resolving the conflicts then
                  commit and push the resolved merge
                </span>
              </>
            }
          >
            <button
              type="button"
              onClick={() => onAction({ kind: 'resolve-conflicts' })}
              disabled={activity.startingConflictResolution}
              data-testid="pr-status-bar-resolve-conflicts"
              className={COMMIT_PUSH_BTN}
            >
              {activity.startingConflictResolution ? (
                <ThinkingSpinner tone="primary" quiet className="mr-1" />
              ) : (
                <ChatIcon className="h-4 w-4" />
              )}
              Resolve, commit &amp; push
            </button>
          </RichHoverTooltip>
        ) : (
          <Tooltip label={plan.resolveConflicts.blockedReason}>
            <button
              type="button"
              aria-disabled="true"
              data-testid="pr-status-bar-resolve-conflicts"
              className={`${COMMIT_PUSH_BTN} ${BLOCKED_ACTION}`}
            >
              <ChatIcon className="h-4 w-4" />
              Resolve, commit &amp; push
            </button>
          </Tooltip>
        ))}
    </>
  );
}

/**
 * The solid-cluster Create PR (beside `Open in`), or nothing when the plan
 * offers none.
 */
export function PullRequestCreateAction({
  plan,
  activity,
  onAction,
  onCancel,
  renderProgress = renderWithoutProgress,
}: PullRequestActionsProps): JSX.Element | null {
  const create = plan.createPr;
  if (create === null) return null;
  return (
    <span className="group/gitaction relative inline-flex items-center">
      <div className={HEADER_PRIORITY.createPr}>
        {/* The compact header shows only "PR", so the full action — which
            may also commit and push — has to be reachable on hover. The
            tooltip sits OUTSIDE the progress wrapper because that wrapper
            clones trigger props onto its child and expects the raw button;
            nesting inside would break its in-progress checklist. Suppressed
            while the action runs so the checklist owns the hover. */}
        <Tooltip
          label={getCreatePrActionName(create.label)}
          suppressed={activity.creatingPr || isBusy(activity)}
        >
          <CreatePrButton
            create={create}
            activity={activity}
            onAction={onAction}
            onCancel={onCancel}
            renderProgress={renderProgress}
            testId="pr-status-bar-primary-action"
          />
        </Tooltip>
      </div>
      {createPrCancellable(activity) && (
        <CancelActionButton onCancel={onCancel} label="Cancel create PR" />
      )}
    </span>
  );
}
