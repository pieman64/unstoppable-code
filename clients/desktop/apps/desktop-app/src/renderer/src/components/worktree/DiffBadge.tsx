import type { JSX } from 'react';
import type { DiffStats } from '@canopy/desktop-shared/types';

interface DiffBadgeProps {
  stats?: DiffStats;
  compact?: boolean;
}

export function DiffBadge({ stats, compact }: DiffBadgeProps): JSX.Element {
  const insertions = stats?.insertions ?? 0;
  const deletions = stats?.deletions ?? 0;

  const className = compact
    ? 'inline-flex items-center gap-1 rounded border bg-base/25 px-1.5 py-0 text-3xs font-semibold tabular-nums'
    : 'inline-flex items-center gap-1.5 rounded-md border bg-base/25 px-2 py-0.5 text-xs font-semibold tabular-nums';

  return (
    <span className={className}>
      <span className="fg-success">+{insertions}</span>
      <span className="fg-destructive">-{deletions}</span>
    </span>
  );
}
