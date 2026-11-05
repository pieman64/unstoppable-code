'use client';

import type { JSX, ReactNode } from 'react';
import type { CostViewProblem } from '@canopy/app-state/cost';
import {
  CenteredLoadingSpinner,
  DelayedLoadingPlaceholder,
  Notice,
  NoticeButton,
  Skeleton,
} from '@canopy/ui-shared/components';

/** A failed read's explanation, after the `Couldn't load cost.` title. */
export function costProblemMessage(problem: CostViewProblem): string {
  if (problem.kind === 'unavailable') {
    return problem.reason === 'no_scope'
      ? 'This entry no longer exists.'
      : 'Cost is not available right now. Try again in a moment.';
  }
  if (problem.reason === 'NOT_FOUND') return 'No cost is recorded for it yet.';
  return problem.message.length > 0 ? problem.message : 'Try again.';
}

/** The tooltip reason for a failed refresh (`Couldn't refresh`). */
export function costRefreshFailureReason(
  problem: CostViewProblem | null,
): string | null {
  return problem === null ? null : costProblemMessage(problem);
}

export interface CostViewFrameProps<Value> {
  readonly value: Value | null;
  readonly status: 'idle' | 'loading' | 'ready' | 'problem';
  readonly problem: CostViewProblem | null;
  readonly onRetry: () => void;
  /** Rendered whenever a value exists, even while a re-read runs or after it failed. */
  readonly children: (value: Value) => ReactNode;
  /**
   * A plain value of the real shape: a few rows with short names. Given one,
   * the first read draws `children(loadingSample)` as a measured skeleton, so
   * a table's rows sit where the figures will.
   */
  readonly loadingSample?: Value;
  readonly testId?: string;
}

/**
 * The states every cost view shares before it has figures: loading on the
 * first read, and a failed first read with Try again. Once a value exists it
 * stays on screen through later reads and failures; a view never blanks and
 * never shows an error as an empty entry.
 */
export function CostViewFrame<Value>({
  value,
  status,
  problem,
  onRetry,
  children,
  loadingSample,
  testId = 'cost-view',
}: CostViewFrameProps<Value>): JSX.Element {
  if (value !== null) return <>{children(value)}</>;
  if (status === 'problem' && problem !== null) {
    return (
      <div className="p-3" data-testid={`${testId}-problem`}>
        <Notice
          intent="attention"
          title="Couldn't load cost."
          actions={<NoticeButton onClick={onRetry}>Try again</NoticeButton>}
        >
          {costProblemMessage(problem)}
        </Notice>
      </div>
    );
  }
  if (loadingSample !== undefined) {
    return (
      <DelayedLoadingPlaceholder slowNote="Still loading cost…">
        <Skeleton loading label="Loading cost" testId={`${testId}-loading`}>
          {children(loadingSample)}
        </Skeleton>
      </DelayedLoadingPlaceholder>
    );
  }
  // Without a sample (a chart, drawn on a canvas, has nothing to measure)
  // the first read keeps the spinner.
  return (
    <div data-testid={`${testId}-loading`}>
      <DelayedLoadingPlaceholder slowNote="Still loading cost…">
        <CenteredLoadingSpinner className="my-12" />
      </DelayedLoadingPlaceholder>
    </div>
  );
}
