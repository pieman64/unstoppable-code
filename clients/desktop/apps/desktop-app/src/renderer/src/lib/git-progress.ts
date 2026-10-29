import type {
  CommitPushPhase,
  MergePrPhase,
} from '@canopy/desktop-shared/types/github';
import type {
  ProgressChecklistStep,
  ProgressStepStatus,
  ProgressChecklistBadge,
} from '@canopy/ui-shared';
import {
  derivePhaseStatus,
  PR_ORDERED_PHASES,
  PR_PHASE_LABELS,
} from '@canopy/ui-shared/lib';
import type {
  CommitPushProgress,
  MergePrProgress,
  PrCreationProgress,
} from '@/stores/githubStore';
import type { BranchSyncAction } from '@/lib/githubBranchActions';
import { COMMIT_PUSH_PHASE_LABELS as SHARED_COMMIT_PUSH_PHASE_LABELS } from '@canopy/ui-app/pull-requests';

export interface GitActionTooltipModel {
  steps: ProgressChecklistStep[];
  error?: string;
  badge: ProgressChecklistBadge;
}

// The phase→status derivation moved to `@canopy/ui-shared/lib` with the
// CAN-1528 PullRequestSection extraction (the shared body needs it too).
// Re-exported so existing desktop call sites keep this import path.
export { derivePhaseStatus };

function firstErrorText(
  steps: ReadonlyArray<{ phase: string; error?: string }>,
): string | undefined {
  return steps.find((s) => s.phase === 'error' && s.error)?.error;
}

function progressBadge(isError: boolean): ProgressChecklistBadge {
  return isError
    ? { label: 'Failed', tone: 'error' }
    : { label: 'In progress', tone: 'progress' };
}

/** Renderer-only post-action step shown for local Git stats refresh. */
function gitStatsRefreshStep(
  status: ProgressStepStatus,
): ProgressChecklistStep {
  return {
    key: 'refreshing-git-stats',
    label: 'Refreshing Git stats',
    status,
  };
}

const ACTIVE_GIT_STATS_REFRESH_STEP: ProgressChecklistStep = {
  key: 'refreshing-git-stats',
  label: 'Refreshing Git stats',
  status: 'active',
};

/**
 * Show the post-action local Git refresh as part of the same checklist. Before
 * the refresh starts it is pending; while the refresh runs, mark the action's
 * own steps completed and make the refresh row active. This is button-tooltip
 * state only — the PR activity-panel card derives its steps directly (it never
 * calls these builders), so it never shows this step.
 */
function withRefreshStep(
  model: GitActionTooltipModel,
  refreshing: boolean,
  includeRefreshStep: boolean,
): GitActionTooltipModel {
  if (!includeRefreshStep) return model;
  if (!refreshing) {
    return {
      ...model,
      steps: [...model.steps, gitStatsRefreshStep('pending')],
    };
  }

  return {
    steps: [
      ...model.steps.map(
        (step): ProgressChecklistStep => ({
          ...step,
          status: 'completed',
        }),
      ),
      ACTIVE_GIT_STATS_REFRESH_STEP,
    ],
    error: model.error,
    badge: { label: 'Refreshing', tone: 'progress' },
  };
}

// ---------------------------------------------------------------------------
// Pull Request creation
// ---------------------------------------------------------------------------

// The ordered phases + labels moved to `@canopy/ui-shared/lib` with the
// CAN-1528 extraction (typed there on the structural `PullRequestCreationPhase`
// twin of `PrCreationPhase`). Re-exported so desktop call sites keep this path.
export { PR_ORDERED_PHASES, PR_PHASE_LABELS };

export function isCreatePrTooltipEnabled(
  progress: PrCreationProgress | undefined,
  isCreating: boolean,
): boolean {
  return isCreating || progress?.currentPhase === 'error';
}

export function buildCreatePrTooltipModel(
  progress: PrCreationProgress | undefined,
  isCreating: boolean,
  refreshing = false,
): GitActionTooltipModel {
  const steps = progress?.steps ?? [];
  const currentPhase: string = progress?.currentPhase ?? PR_ORDERED_PHASES[0];
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
  return withRefreshStep(
    {
      steps: rows,
      error: firstErrorText(steps),
      badge: progressBadge(currentPhase === 'error'),
    },
    refreshing,
    isCreating || refreshing,
  );
}

// ---------------------------------------------------------------------------
// Commit / Push family
// ---------------------------------------------------------------------------

// The phase copy is shared with the web header's checklist (REG-3025).
export const COMMIT_PUSH_PHASE_LABELS: Record<CommitPushPhase, string> =
  SHARED_COMMIT_PUSH_PHASE_LABELS;

/** The ordered relevant phases per branch-sync action. */
export const COMMIT_PUSH_ACTION_PHASES: Record<
  BranchSyncAction,
  readonly CommitPushPhase[]
> = {
  push: ['pushing'],
  pull: ['pulling'],
  commit: ['generating_message', 'staging', 'committing'],
  'commit-and-push': ['generating_message', 'staging', 'committing', 'pushing'],
  'pull-commit-and-push': [
    'pulling',
    'generating_message',
    'staging',
    'committing',
    'pushing',
  ],
};

export function isCommitPushTooltipEnabled(
  progress: CommitPushProgress | undefined,
  isActive: boolean,
): boolean {
  return isActive || progress?.currentPhase === 'error';
}

export function buildCommitPushTooltipModel(
  action: BranchSyncAction,
  progress: CommitPushProgress | undefined,
  isActive: boolean,
  refreshing = false,
): GitActionTooltipModel {
  const orderedPhases = COMMIT_PUSH_ACTION_PHASES[action];
  const steps = progress?.steps ?? [];
  const currentPhase: string = progress?.currentPhase ?? orderedPhases[0];
  const rows: ProgressChecklistStep[] = orderedPhases.map((phase) => ({
    key: phase,
    label: COMMIT_PUSH_PHASE_LABELS[phase],
    status: derivePhaseStatus({
      phase,
      orderedPhases,
      steps,
      currentPhase,
      isActive,
    }),
  }));
  return withRefreshStep(
    {
      steps: rows,
      error: firstErrorText(steps),
      badge: progressBadge(currentPhase === 'error'),
    },
    refreshing,
    isActive || refreshing,
  );
}

// ---------------------------------------------------------------------------
// Merge (no sub-phases tracked)
// ---------------------------------------------------------------------------

export function buildMergeTooltipModel(
  refreshing = false,
  includeRefreshStep = false,
): GitActionTooltipModel {
  return withRefreshStep(
    {
      steps: [{ key: 'merging', label: 'Merging', status: 'active' }],
      badge: progressBadge(false),
    },
    refreshing,
    includeRefreshStep,
  );
}

// ---------------------------------------------------------------------------
// Pull Request merge
// ---------------------------------------------------------------------------

const MERGE_PR_ORDERED_PHASES: readonly MergePrPhase[] = [
  'checking_mergeability',
  'waiting_mergeability',
  'merging',
  'refreshing_pr_status',
];

const MERGE_PR_PHASE_LABELS: Record<MergePrPhase, string> = {
  queued: 'Queued',
  checking_mergeability: 'Checking mergeability',
  waiting_mergeability: 'Waiting for GitHub',
  merging: 'Merging pull request',
  refreshing_pr_status: 'Refreshing PR status',
  done: 'Done',
  error: 'Error',
};

function latestMergePrStep(
  progress: MergePrProgress | undefined,
  phase: MergePrPhase,
): MergePrProgress['steps'][number] | undefined {
  if (!progress) return undefined;
  for (let index = progress.steps.length - 1; index >= 0; index -= 1) {
    const step = progress.steps[index];
    if (step.phase === phase) return step;
  }
  return undefined;
}

function formatRetryDelay(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined;
  return `${Math.round(ms / 1000)}s`;
}

export function isMergePrTooltipEnabled(
  progress: MergePrProgress | undefined,
  isActive: boolean,
): boolean {
  return isActive || progress?.currentPhase === 'error';
}

export function buildMergePrTooltipModel(
  progress: MergePrProgress | undefined,
  isActive: boolean,
  refreshing = false,
): GitActionTooltipModel {
  const currentPhase: string =
    progress?.currentPhase ?? 'checking_mergeability';
  const queued = latestMergePrStep(progress, 'queued');
  const waiting = latestMergePrStep(progress, 'waiting_mergeability');
  const steps = progress?.steps ?? [];
  const rows: ProgressChecklistStep[] = [];

  if (queued && (queued.queuePosition ?? 1) > 1) {
    const positionText =
      queued.queuePosition !== undefined && queued.queueLength !== undefined
        ? ` (${queued.queuePosition} of ${queued.queueLength})`
        : '';
    rows.push({
      key: 'queued',
      label: `${MERGE_PR_PHASE_LABELS.queued}${positionText}`,
      status: currentPhase === 'queued' ? 'active' : 'completed',
    });
  }

  rows.push(
    ...MERGE_PR_ORDERED_PHASES.map((phase) => {
      const retryText =
        phase === 'waiting_mergeability'
          ? formatRetryDelay(waiting?.retryDelayMs)
          : undefined;
      return {
        key: phase,
        label: `${MERGE_PR_PHASE_LABELS[phase]}${
          retryText ? ` (${retryText})` : ''
        }`,
        status: derivePhaseStatus({
          phase,
          orderedPhases: MERGE_PR_ORDERED_PHASES,
          steps,
          currentPhase,
          isActive,
        }),
      };
    }),
  );

  return withRefreshStep(
    {
      steps: rows,
      error: firstErrorText(steps),
      badge: progressBadge(currentPhase === 'error'),
    },
    refreshing,
    isActive || refreshing,
  );
}
