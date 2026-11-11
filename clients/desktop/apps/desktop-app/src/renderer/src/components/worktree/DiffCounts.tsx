import type { JSX } from 'react';
import type { DiffStats } from '@canopy/desktop-shared/types';

interface DiffCountsProps {
  stats?: DiffStats;
  compact?: boolean;
}

/**
 * A worktree's `+N -M` line counts as plain colored text, zeros included. It
 * draws no marker: the counts sit beside a row's other metadata.
 */
export function DiffCounts({ stats, compact }: DiffCountsProps): JSX.Element {
  const insertions = stats?.insertions ?? 0;
  const deletions = stats?.deletions ?? 0;

  return (
    <span
      className={`inline-flex items-center gap-1 ${compact ? 'text-2xs' : 'text-xs'}`}
    >
      <span className="fg-success">+{insertions}</span>
      <span className="fg-destructive">-{deletions}</span>
    </span>
  );
}
