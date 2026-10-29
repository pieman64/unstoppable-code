import type { WorktreeRowMergeQueuePhase } from '../components/WorktreeRow';

/** GitHub's merge queue entry state, normalized (see `WorktreeRow`). */
export type MergeQueueEntryPhase = WorktreeRowMergeQueuePhase;

/** The steps a queued pull request moves through, as the queue popover shows them. */
export type MergeQueueStep = 'queued' | 'testing' | 'merging';

export function mergeQueueStep(
  phase: MergeQueueEntryPhase | undefined,
): MergeQueueStep {
  switch (phase) {
    case 'awaiting_checks':
    case 'unmergeable':
      return 'testing';
    case 'mergeable':
    case 'locked':
      return 'merging';
    default:
      return 'queued';
  }
}

/**
 * Seconds left on an estimate GitHub gave at `observedAt`, counted down to
 * `now` so the display moves between reads. Null without an estimate; an
 * unreadable observation time leaves the estimate as given.
 */
export function remainingEstimateSeconds(
  estimateSeconds: number | null | undefined,
  observedAt: string | number | null | undefined,
  now: number,
): number | null {
  if (
    typeof estimateSeconds !== 'number' ||
    !Number.isFinite(estimateSeconds)
  ) {
    return null;
  }
  const observedMs =
    typeof observedAt === 'number'
      ? observedAt
      : typeof observedAt === 'string'
        ? Date.parse(observedAt)
        : Number.NaN;
  if (!Number.isFinite(observedMs)) return Math.max(0, estimateSeconds);
  const elapsedSeconds = Math.max(0, now - observedMs) / 1000;
  return Math.max(0, estimateSeconds - elapsedSeconds);
}

/** Whole minutes, never under one: a pull request still queued reads "1 min". */
export function estimateMinutes(seconds: number): number {
  return Math.max(1, Math.round(seconds / 60));
}

/** `19 min`. */
export function formatEstimateMinutes(seconds: number): string {
  return `${estimateMinutes(seconds)} min`;
}

/** The local time the estimate lands, in the user's clock format. */
export function formatEstimateClock(seconds: number, now: number): string {
  return new Date(now + seconds * 1000).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** One queued pull request, as the PR bar's queue label reads it. */
export interface MergeQueueLabelInput {
  readonly phase?: MergeQueueEntryPhase;
  readonly position?: number | null;
  /** Seconds left, already counted down; null without an estimate. */
  readonly remainingSeconds: number | null;
}

export type MergeQueueLabel =
  | {
      readonly kind: 'queued';
      readonly position: number | null;
      readonly remainingSeconds: number | null;
    }
  | { readonly kind: 'testing'; readonly remainingSeconds: number | null }
  | { readonly kind: 'merging' }
  | { readonly kind: 'blocked' }
  | {
      readonly kind: 'several';
      readonly count: number;
      readonly remainingSeconds: number | null;
    };

/**
 * The label for a worktree whose open pull requests are all queued. Several
 * pull requests read as one count with the latest estimate, since the
 * worktree is done when the last one lands; without every estimate there is
 * no such time to show.
 */
export function mergeQueueLabel(
  pullRequests: readonly MergeQueueLabelInput[],
): MergeQueueLabel | null {
  const [first] = pullRequests;
  if (!first) return null;
  if (pullRequests.length === 1) {
    if (first.phase === 'unmergeable') return { kind: 'blocked' };
    switch (mergeQueueStep(first.phase)) {
      case 'merging':
        return { kind: 'merging' };
      case 'testing':
        return { kind: 'testing', remainingSeconds: first.remainingSeconds };
      case 'queued':
        return {
          kind: 'queued',
          position:
            typeof first.position === 'number' && first.position > 0
              ? first.position
              : null,
          remainingSeconds: first.remainingSeconds,
        };
    }
  }
  if (pullRequests.every((pr) => mergeQueueStep(pr.phase) === 'merging')) {
    return { kind: 'merging' };
  }
  const estimates = pullRequests.map((pr) => pr.remainingSeconds);
  return {
    kind: 'several',
    count: pullRequests.length,
    remainingSeconds: estimates.every(
      (estimate): estimate is number => estimate !== null,
    )
      ? Math.max(...estimates)
      : null,
  };
}
