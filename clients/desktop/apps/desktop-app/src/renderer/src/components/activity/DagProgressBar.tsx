import { memo, useMemo, type JSX } from 'react';
import { DagProgressBar as SharedDagProgressBar } from '@canopy/ui-shared/components';
import { computeDagTiers } from './dag-tiers';
import {
  buildDagJobs,
  type DagProgressExecutionState,
} from './dag-progress-jobs';

interface DagProgressBarProps {
  executionState: DagProgressExecutionState;
  muted?: boolean;
  onJobClick?: (jobId: string) => void;
}

/**
 * Desktop wrapper around the shared {@link SharedDagProgressBar}. Adapts the
 * shared row projection or full execution detail into the portable tiers +
 * jobs payload the shared component consumes.
 */
function DagProgressBarInner({
  executionState,
  muted = false,
  onJobClick,
}: DagProgressBarProps): JSX.Element {
  const tiers = useMemo(
    () => computeDagTiers(executionState.pipeline_snapshot.jobs),
    [executionState.pipeline_snapshot.jobs],
  );
  const jobs = useMemo(() => buildDagJobs(executionState), [executionState]);

  return (
    <SharedDagProgressBar
      tiers={tiers}
      jobs={jobs}
      muted={muted}
      onJobClick={onJobClick}
    />
  );
}

export const DagProgressBar = memo(DagProgressBarInner);
