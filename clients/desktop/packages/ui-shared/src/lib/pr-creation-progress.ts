import type { ProgressStepStatus } from '../components/ProgressChecklist';

/**
 * PR-creation phase union shared by the desktop renderer and the extracted
 * `PullRequestSectionBody` in `@canopy/ui-app` (CAN-1528). Structural twin of
 * the desktop `PrCreationPhase` in `@canopy/desktop-shared/types/github` —
 * this package must stay free of desktop-shared imports, so the literal
 * values are declared here and the desktop type stays assignable.
 */
export type PullRequestCreationPhase =
  | 'gathering_changes'
  | 'summarizing'
  | 'pushing'
  | 'creating_pr'
  | 'skipped'
  | 'done'
  | 'error';

/** Ordered PR creation phases shown in the checklist (excludes terminal). */
export const PR_ORDERED_PHASES: readonly PullRequestCreationPhase[] = [
  'gathering_changes',
  'summarizing',
  'pushing',
  'creating_pr',
];

export const PR_PHASE_LABELS: Record<PullRequestCreationPhase, string> = {
  gathering_changes: 'Gathering changes',
  summarizing: 'Summarizing changes',
  pushing: 'Pushing to remote',
  creating_pr: 'Creating pull request',
  skipped: 'Skipped (no changes)',
  done: 'Done',
  error: 'Error',
};

interface DerivePhaseStatusParams {
  phase: string;
  orderedPhases: readonly string[];
  steps: ReadonlyArray<{ phase: string; error?: string }>;
  /** The current overall phase; may be a terminal phase ('done' | 'error'). */
  currentPhase: string;
  isActive: boolean;
}

/**
 * Phase→status derivation shared by every git progress surface. Earlier phases
 * are completed, the current phase is active while the action runs (else
 * completed), later phases are pending. On error, the last reached ordered
 * phase is marked error and unreached phases stay pending. Typed on plain
 * `string` (not a generic phase enum) so it works uniformly for the PR and
 * commit/push phase sets without `as` casts.
 */
export function derivePhaseStatus({
  phase,
  orderedPhases,
  steps,
  currentPhase,
  isActive,
}: DerivePhaseStatusParams): ProgressStepStatus {
  if (currentPhase === 'error') {
    // Parity with the PR activity-card derivation: the failing step is only
    // marked 'error' when an error step carrying text exists. If currentPhase
    // is 'error' but no step has error text, reached phases stay 'completed'.
    const hasError = steps.some((s) => s.phase === 'error' && s.error);
    const reached = new Set(steps.map((s) => s.phase));
    if (reached.has(phase)) {
      const reachedOrderedIdx = steps
        .filter((s) => orderedPhases.some((p) => p === s.phase))
        .map((s) => orderedPhases.findIndex((p) => p === s.phase));
      const lastReachedIdx =
        reachedOrderedIdx.length > 0 ? Math.max(...reachedOrderedIdx) : -1;
      if (orderedPhases.indexOf(phase) === lastReachedIdx && hasError) {
        return 'error';
      }
      return 'completed';
    }
    return 'pending';
  }

  if (currentPhase === 'done') return 'completed';

  const currentIdx = orderedPhases.findIndex((p) => p === currentPhase);
  const phaseIdx = orderedPhases.indexOf(phase);
  if (phaseIdx < currentIdx) return 'completed';
  if (phaseIdx === currentIdx) return isActive ? 'active' : 'completed';
  return 'pending';
}
