import type { JSX } from 'react';
import { LinearProgress } from './LinearProgress';

/**
 * Meter fill: the accent for the used share, turning to warning and then
 * destructive as it nears the limit.
 */
function getMeterBarClass(percentage: number): string {
  if (percentage >= 90) return 'bg-destructive';
  if (percentage >= 70) return 'bg-warning';
  return 'bg-accent';
}

/** 44px tap floor on touch hardware (DESIGN.md), untouched on a mouse. */
export const USAGE_TOUCH_FLOOR_CLASS =
  'pointer-coarse:min-h-11 pointer-coarse:min-w-11';

/** Whole percents read at a glance; a nonzero sliver never rounds to 0%. */
export function formatUsagePercent(percentage: number): string {
  if (percentage > 0 && percentage < 1) return '<1%';
  return `${Math.round(percentage)}%`;
}

export function UsageMeter({
  percentage,
  label,
}: {
  percentage: number;
  label: string;
}): JSX.Element {
  return (
    <LinearProgress
      percentage={percentage}
      barColor={getMeterBarClass(percentage)}
      height="h-1.5"
      label={label}
    />
  );
}
