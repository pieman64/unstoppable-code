import type { JSX } from 'react';
import type { DiffStats } from '@canopy/desktop-shared/types';

interface DiffBadgeProps {
  stats?: DiffStats;
  compact?: boolean;
}

export function DiffBadge({ stats, compact }: DiffBadgeProps): JSX.Element {
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
