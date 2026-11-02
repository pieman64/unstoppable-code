'use client';

import { useMemo, useState, type JSX, type ReactNode } from 'react';
import {
  CheckStatusBadge,
  LoadingSpinner,
  Notice,
  PrLabelBadge,
  ProgressChecklist,
  PullRequestStateBadge,
  ReviewStatusBadge,
  type CheckStatusBadgeStatus,
  type ProgressChecklistStep,
  type ReviewStatusBadgeStatus,
} from '@canopy/ui-shared/components';
import {
  PR_ORDERED_PHASES,
  PR_PHASE_LABELS,
  derivePhaseStatus,
  type PullRequestCreationPhase,
} from '@canopy/ui-shared/lib';
import { ChevronRightMediumIcon as AppCatalogChevronRightMediumIcon } from '@canopy/ui-shared/icons/AppIcons';

// ---------------------------------------------------------------------------
// CAN-1528 — the desktop `PullRequestSection` presentational core, extracted
// VERBATIM (markup + Tailwind classes + data-testids untouched) into a
// props-only component rendered by BOTH surfaces: the desktop wrapper feeds
// it from the githubStore, the portal feeds it from the `PortalPrStatus`
// snapshot. Host-specific concerns arrive as props: merge-readiness is
// precomputed per status (`isMergeReady`, desktop `isPrReadyToMerge`),
// section chrome collapses to the single `framelessChecks` boolean, and any
// host-only UI (the desktop split-PR surfaces) renders through `children`.
//
// The prop types below are neutral structural twins of the desktop
// `RepoPrStatus` / `PrCreationProgress` shapes — this package must not import
// `@canopy/desktop-shared`, and the desktop objects stay assignable.
// ---------------------------------------------------------------------------

export type PullRequestSectionPrState = 'open' | 'merged' | 'closed' | 'draft';

export type PullRequestSectionCheckStatus =
  | 'passing'
  | 'failing'
  | 'pending'
  | 'neutral'
  | 'none';

export type PullRequestSectionReviewStatus =
  | 'approved'
  | 'changes_requested'
  | 'pending'
  | 'none';

export interface PullRequestSectionCheckDetail {
  readonly name: string;
  readonly status: PullRequestSectionCheckStatus;
  readonly detailsUrl: string | null;
}

export interface PullRequestSectionLabel {
  readonly name: string;
  readonly color: string;
  readonly description: string | null;
}

export interface PullRequestSectionPrStatus {
  readonly prNumber: number;
  readonly prUrl: string;
  readonly state: PullRequestSectionPrState;
  readonly title: string;
  readonly checkDetails: readonly PullRequestSectionCheckDetail[];
  readonly reviewStatus: PullRequestSectionReviewStatus;
  readonly labels?: readonly PullRequestSectionLabel[];
  readonly hasConflicts: boolean;
  readonly commentCount: number;
  /**
   * Host-computed merge readiness (desktop: `isPrReadyToMerge`, which also
   * weighs GitHub's `mergeable`/`mergeableState`). Drives the approved review
   * badge tone: approved-but-not-ready renders muted instead of success.
   */
  readonly isMergeReady?: boolean;
}

export interface PullRequestSectionRepo {
  readonly repoId: string;
  readonly repoName: string;
  readonly status: PullRequestSectionPrStatus | null;
}

export interface PullRequestSectionCreationStep {
  readonly phase: PullRequestCreationPhase;
  readonly repoName?: string;
  readonly error?: string;
}

export interface PullRequestSectionCreationProgress {
  readonly steps: readonly PullRequestSectionCreationStep[];
  readonly currentPhase: PullRequestCreationPhase;
}

function StateTag({
  state,
}: {
  state: PullRequestSectionPrState;
}): JSX.Element {
  return <PullRequestStateBadge state={state} dataTestId="pr-status-badge" />;
}

function toCheckStatusBadgeStatus(
  status: PullRequestSectionCheckStatus,
): CheckStatusBadgeStatus | null {
  switch (status) {
    case 'passing':
      return 'success';
    case 'failing':
      return 'failure';
    case 'neutral':
      return 'neutral';
    case 'pending':
      return 'pending';
    default:
      return null;
  }
}

function CheckIcon({
  status,
}: {
  status: PullRequestSectionCheckStatus;
}): JSX.Element {
  const mapped = toCheckStatusBadgeStatus(status);
  if (mapped === null) {
    return <LoadingSpinner tone="warning" />;
  }
  if (mapped === 'pending') {
    return (
      <CheckStatusBadge status="pending" pendingIcon={<LoadingSpinner />} />
    );
  }
  return <CheckStatusBadge status={mapped} />;
}

function toReviewBadgeStatus(
  status: PullRequestSectionReviewStatus,
): ReviewStatusBadgeStatus {
  switch (status) {
    case 'approved':
      return 'approved';
    case 'changes_requested':
      return 'changes-requested';
    case 'pending':
      return 'pending';
    case 'none':
      return 'none';
  }
}

function ReviewSummary({
  status,
  isMergeReady,
}: {
  status: PullRequestSectionReviewStatus;
  isMergeReady: boolean;
}): JSX.Element {
  return (
    <ReviewStatusBadge
      status={toReviewBadgeStatus(status)}
      approvedTone={
        status === 'approved' && !isMergeReady ? 'muted' : 'success'
      }
    />
  );
}

function PhaseList({
  steps,
  currentPhase,
  isCreating,
}: {
  steps: readonly PullRequestSectionCreationStep[];
  currentPhase: PullRequestCreationPhase;
  isCreating: boolean;
}): JSX.Element {
  const errorStep = steps.find((s) => s.phase === 'error' && s.error);
  const rows: ProgressChecklistStep[] = PR_ORDERED_PHASES.map((phase) => ({
    key: phase,
    label: PR_PHASE_LABELS[phase],
    status: derivePhaseStatus({
      phase,
      orderedPhases: PR_ORDERED_PHASES,
      steps,
      currentPhase,
      isActive: isCreating,
    }),
  }));
  return <ProgressChecklist steps={rows} error={errorStep?.error} />;
}

interface RepoGroup {
  repoName: string;
  steps: PullRequestSectionCreationStep[];
  currentPhase: PullRequestCreationPhase;
}

function groupStepsByRepo(steps: readonly PullRequestSectionCreationStep[]): {
  repos: RepoGroup[];
  skipped: string[];
} {
  const skipped: string[] = [];
  const repoMap = new Map<string, PullRequestSectionCreationStep[]>();
  const repoOrder: string[] = [];

  for (const step of steps) {
    if (!step.repoName) continue;
    if (step.phase === 'skipped') {
      skipped.push(step.repoName);
      continue;
    }
    let bucket = repoMap.get(step.repoName);
    if (!bucket) {
      bucket = [];
      repoMap.set(step.repoName, bucket);
      repoOrder.push(step.repoName);
    }
    bucket.push(step);
  }

  const repos: RepoGroup[] = repoOrder.map((name) => {
    const repoSteps = repoMap.get(name) ?? [];
    const last = repoSteps[repoSteps.length - 1];
    return { repoName: name, steps: repoSteps, currentPhase: last.phase };
  });

  return { repos, skipped };
}

function CreationStatusBadge({
  phase,
}: {
  phase: PullRequestCreationPhase;
}): JSX.Element {
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-3xs font-medium ${
        phase === 'error'
          ? 'border-line-destructive bg-destructive-subtle fg-destructive'
          : phase === 'done'
            ? 'border-line-positive bg-success-subtle fg-success'
            : 'border-fg-info/30 bg-info-subtle fg-info'
      }`}
    >
      {phase === 'error' ? 'Failed' : phase === 'done' ? 'Created' : 'Creating'}
    </span>
  );
}

function CreationProgressFeed({
  progress,
  isCreating,
}: {
  progress: PullRequestSectionCreationProgress;
  isCreating: boolean;
}): JSX.Element {
  const isMultiRepo = progress.steps.some(
    (s) => s.repoName != null && s.phase !== 'done',
  );

  const { repos, skipped } = useMemo(
    () =>
      isMultiRepo
        ? groupStepsByRepo(progress.steps)
        : { repos: [], skipped: [] },
    [isMultiRepo, progress.steps],
  );

  if (isMultiRepo) {
    return (
      <div className="space-y-1.5">
        <div className="mb-2 flex items-center gap-2">
          <CreationStatusBadge phase={progress.currentPhase} />
        </div>
        <div className="space-y-3">
          {repos.map((repo) => {
            const repoDone =
              repo.currentPhase === 'done' || repo.currentPhase === 'error';
            return (
              <div key={repo.repoName}>
                <div className="mb-1 flex items-center gap-1.5">
                  <span className="text-xs font-medium fg-primary/80">
                    {repo.repoName}
                  </span>
                  {repo.currentPhase === 'done' && (
                    <span className="text-3xs fg-success">{'✓'}</span>
                  )}
                  {repo.currentPhase === 'error' && (
                    <span className="text-3xs fg-destructive">{'✗'}</span>
                  )}
                </div>
                <div className="pl-2">
                  <PhaseList
                    steps={repo.steps}
                    currentPhase={repo.currentPhase}
                    isCreating={isCreating && !repoDone}
                  />
                </div>
              </div>
            );
          })}
        </div>
        {skipped.length > 0 && (
          <p className="mt-2 text-2xs fg-secondary">
            Skipped {skipped.length} {skipped.length === 1 ? 'repo' : 'repos'}{' '}
            (no changes): {skipped.join(', ')}
          </p>
        )}
      </div>
    );
  }

  // Single-repo progress
  const errorStep = progress.steps.find((s) => s.phase === 'error' && s.error);
  const rows: ProgressChecklistStep[] = PR_ORDERED_PHASES.map((phase) => ({
    key: phase,
    label: PR_PHASE_LABELS[phase],
    status: derivePhaseStatus({
      phase,
      orderedPhases: PR_ORDERED_PHASES,
      steps: progress.steps,
      currentPhase: progress.currentPhase,
      isActive: isCreating,
    }),
  }));
  return (
    <ProgressChecklist
      steps={rows}
      error={errorStep?.error}
      badge={
        progress.currentPhase === 'error'
          ? { label: 'Failed', tone: 'error' }
          : progress.currentPhase === 'done'
            ? { label: 'Created', tone: 'success' }
            : { label: 'Creating', tone: 'progress' }
      }
    />
  );
}

export function PullRequestRepoDetail({
  status,
  hideGitHubLink,
  framelessChecks,
}: {
  status: PullRequestSectionPrStatus | null;
  hideGitHubLink?: boolean;
  /**
   * `true` under the desktop frameless (single-section panel) chrome: the
   * checks list renders in plain flow instead of the capped scroll area.
   */
  framelessChecks?: boolean;
}): JSX.Element {
  const s = status;
  const sortedChecks = useMemo<PullRequestSectionCheckDetail[]>(() => {
    if (!s) {
      return [];
    }
    const priority: Record<PullRequestSectionCheckStatus, number> = {
      pending: 0,
      failing: 1,
      passing: 2,
      neutral: 3,
      none: 4,
    };
    return s.checkDetails
      .map((check, index) => ({ check, index }))
      .sort((a, b) => {
        const diff = priority[a.check.status] - priority[b.check.status];
        return diff !== 0 ? diff : a.index - b.index;
      })
      .map(({ check }) => check);
  }, [s]);
  if (!s) {
    return <></>;
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-s font-medium fg-primary">
            PR #{s.prNumber}
          </span>
          <StateTag state={s.state} />
        </div>
        {/* Portal snapshots can carry a numbered PR without a URL (lenient
            wire contract); an empty href would self-navigate, so the link
            renders only when a URL exists. */}
        {!hideGitHubLink && s.prUrl !== '' && (
          <a
            href={s.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs fg-secondary transition-colors hover:fg-primary"
          >
            GitHub &rarr;
          </a>
        )}
      </div>

      <p className="text-xs fg-secondary">{s.title}</p>

      {/* Checks */}
      {s.checkDetails.length > 0 && (
        <div>
          <p className="mb-1 text-3xs font-semibold fg-secondary">
            Checks (
            {
              s.checkDetails.filter(
                (c: PullRequestSectionCheckDetail) => c.status === 'passing',
              ).length
            }
            /{s.checkDetails.length} passing)
          </p>
          <div
            className={
              framelessChecks
                ? 'space-y-1 pr-1'
                : 'max-h-70 space-y-1 overflow-y-auto pr-1'
            }
          >
            {sortedChecks.map((check: PullRequestSectionCheckDetail, index) => (
              <div
                key={`${check.name}::${index}`}
                className="flex items-center justify-between gap-2 text-xs"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <CheckIcon status={check.status} />
                  <span className="truncate fg-primary/80">{check.name}</span>
                </span>
                {check.detailsUrl && (
                  <a
                    href={check.detailsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 fg-secondary transition-colors hover:fg-primary"
                  >
                    view &rarr;
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Reviews */}
      <div>
        <p className="mb-1 text-3xs font-semibold fg-secondary">Reviews</p>
        <ReviewSummary
          status={s.reviewStatus}
          isMergeReady={s.isMergeReady === true}
        />
      </div>

      {/* Labels */}
      {s.labels && s.labels.length > 0 && (
        <div data-testid="pr-labels-section">
          <p className="mb-1 text-3xs font-semibold fg-secondary">Labels</p>
          <div className="flex flex-wrap gap-1">
            {s.labels.map((label) => (
              <PrLabelBadge
                key={label.name}
                name={label.name}
                color={label.color}
                description={label.description}
                dataTestId="pr-label"
              />
            ))}
          </div>
        </div>
      )}

      {/* Conflicts */}
      {s.hasConflicts && (
        <Notice intent="attention" title="Merge conflict">
          Resolve it on the branch before this pull request can merge.
        </Notice>
      )}

      {/* Comments */}
      {s.commentCount > 0 && (
        <p className="text-xs fg-secondary">
          {s.commentCount} {s.commentCount === 1 ? 'comment' : 'comments'}
        </p>
      )}
    </div>
  );
}

export interface PullRequestSectionBodyProps {
  /**
   * Per-repo PR statuses, or `undefined` when the host has no PR snapshot at
   * all (the desktop store miss). A single-entry array renders the flat card;
   * more entries render the collapsible per-repo grouping.
   */
  readonly repos?: readonly PullRequestSectionRepo[];
  readonly isCreating?: boolean;
  readonly creationProgress?: PullRequestSectionCreationProgress;
  /** See {@link PullRequestRepoDetail}'s `framelessChecks`. */
  readonly framelessChecks?: boolean;
  /**
   * Host-only content rendered after the PR body (the desktop split-PR
   * surfaces). Absent on hosts without those capabilities.
   */
  readonly children?: ReactNode;
}

export function PullRequestSectionBody({
  repos,
  isCreating = false,
  creationProgress,
  framelessChecks,
  children,
}: PullRequestSectionBodyProps): JSX.Element {
  const [expandedRepos, setExpandedRepos] = useState<Set<string>>(new Set());

  const isMultiRepo = repos ? repos.length > 1 : false;
  const hasAnyPr = repos ? repos.some((r) => r.status !== null) : false;

  const creationDone = creationProgress?.currentPhase === 'done';
  const creationError = creationProgress?.currentPhase === 'error';
  const showHybridMultiRepo =
    isMultiRepo &&
    hasAnyPr &&
    creationProgress != null &&
    (isCreating || creationError);
  // Show progress during active creation or on error; once done, prefer the PR card if available
  const showProgress =
    (isCreating || creationProgress) &&
    !showHybridMultiRepo &&
    !(creationDone && repos && repos.some((r) => r.status !== null));
  const showPrDetails = repos && !isCreating && !showHybridMultiRepo;

  const creationRepoGroups = useMemo(() => {
    if (!creationProgress) return { repos: [], skipped: [] };
    return groupStepsByRepo(creationProgress.steps);
  }, [creationProgress]);

  function toggleRepo(repoId: string): void {
    setExpandedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(repoId)) {
        next.delete(repoId);
      } else {
        next.add(repoId);
      }
      return next;
    });
  }

  return (
    <>
      {showProgress && creationProgress ? (
        <CreationProgressFeed
          progress={creationProgress}
          isCreating={isCreating}
        />
      ) : showHybridMultiRepo && creationProgress && repos ? (
        <div className="space-y-2">
          {repos.map((repo) => {
            const creationGroup = creationRepoGroups.repos.find(
              (g) => g.repoName === repo.repoName,
            );

            if (creationGroup) {
              const repoDone =
                creationGroup.currentPhase === 'done' ||
                creationGroup.currentPhase === 'error';
              return (
                <div key={repo.repoId}>
                  <div className="mb-1 flex items-center gap-1.5">
                    <span className="text-xs font-medium fg-primary/80">
                      {repo.repoName}
                    </span>
                    {creationGroup.currentPhase === 'done' && (
                      <span className="text-3xs fg-success">{'✓'}</span>
                    )}
                    {creationGroup.currentPhase === 'error' && (
                      <span className="text-3xs fg-destructive">{'✗'}</span>
                    )}
                    <CreationStatusBadge phase={creationGroup.currentPhase} />
                  </div>
                  <div className="pl-2">
                    <PhaseList
                      steps={creationGroup.steps}
                      currentPhase={creationGroup.currentPhase}
                      isCreating={isCreating && !repoDone}
                    />
                  </div>
                </div>
              );
            }

            return (
              <div key={repo.repoId}>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => toggleRepo(repo.repoId)}
                    className="flex min-w-0 flex-1 items-center gap-1 text-xs font-medium fg-primary/80 transition-colors hover:fg-primary"
                  >
                    <AppCatalogChevronRightMediumIcon
                      width="12"
                      height="12"
                      className={`flex-shrink-0 transition-transform ${expandedRepos.has(repo.repoId) ? 'rotate-90' : ''}`}
                    />
                    <span className="truncate">{repo.repoName}</span>
                    {repo.status && <StateTag state={repo.status.state} />}
                  </button>
                  {repo.status && repo.status.prUrl !== '' && (
                    <a
                      href={repo.status.prUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-shrink-0 text-xs fg-secondary transition-colors hover:fg-primary"
                      onClick={(e) => e.stopPropagation()}
                    >
                      GitHub &rarr;
                    </a>
                  )}
                </div>
                {expandedRepos.has(repo.repoId) && (
                  <div className="mt-2 pl-4">
                    <PullRequestRepoDetail
                      status={repo.status}
                      hideGitHubLink
                      framelessChecks={framelessChecks}
                    />
                  </div>
                )}
              </div>
            );
          })}
          {creationRepoGroups.skipped.length > 0 && (
            <p className="mt-2 text-2xs fg-secondary">
              Skipped {creationRepoGroups.skipped.length}{' '}
              {creationRepoGroups.skipped.length === 1 ? 'repo' : 'repos'} (no
              changes): {creationRepoGroups.skipped.join(', ')}
            </p>
          )}
          {creationProgress.steps
            .flatMap((s): string[] =>
              s.phase === 'error' && s.error && !s.repoName ? [s.error] : [],
            )
            .map((error, i) => (
              <div key={`error-${i}`} className="mt-1 max-h-32 overflow-auto">
                <p className="whitespace-pre-wrap break-words text-2xs fg-destructive">
                  {error}
                </p>
              </div>
            ))}
        </div>
      ) : showPrDetails && !hasAnyPr ? null : showPrDetails && isMultiRepo ? (
        <div className="space-y-2">
          {repos.map((repo) => (
            <div key={repo.repoId}>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => toggleRepo(repo.repoId)}
                  className="flex min-w-0 flex-1 items-center gap-1 text-xs font-medium fg-primary/80 transition-colors hover:fg-primary"
                >
                  <AppCatalogChevronRightMediumIcon
                    width="12"
                    height="12"
                    className={`flex-shrink-0 transition-transform ${expandedRepos.has(repo.repoId) ? 'rotate-90' : ''}`}
                  />
                  <span className="truncate">{repo.repoName}</span>
                  {repo.status && <StateTag state={repo.status.state} />}
                </button>
                {repo.status && repo.status.prUrl !== '' && (
                  <a
                    href={repo.status.prUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-shrink-0 text-xs fg-secondary transition-colors hover:fg-primary"
                    onClick={(e) => e.stopPropagation()}
                  >
                    GitHub &rarr;
                  </a>
                )}
              </div>
              {expandedRepos.has(repo.repoId) && (
                <div className="mt-2 pl-4">
                  <PullRequestRepoDetail
                    status={repo.status}
                    hideGitHubLink
                    framelessChecks={framelessChecks}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      ) : showPrDetails ? (
        <PullRequestRepoDetail
          status={repos[0]?.status ?? null}
          framelessChecks={framelessChecks}
        />
      ) : null}
      {children}
    </>
  );
}
