import type { JSX } from 'react';

interface LinearProgressProps {
  /** 0–100 */
  percentage: number;
  /** Render a pulsing bar without exposing a determinate value. */
  indeterminate?: boolean;
  /** Tailwind color class for the filled bar, e.g. "bg-success" */
  barColor?: string;
  /** Tailwind color class for the track background */
  trackColor?: string;
  /** Tailwind height class */
  height?: string;
  className?: string;
  label?: string;
}

export function LinearProgress({
  percentage,
  indeterminate = false,
  barColor = 'bg-accent',
  trackColor = 'bg-fg-primary/[0.08]',
  height = 'h-0.75',
  className = '',
  label,
}: LinearProgressProps): JSX.Element {
  const clamped = Math.min(Math.max(percentage, 0), 100);

  return (
    <div
      className={`w-full overflow-hidden rounded-full ${trackColor} ${height} ${className}`}
      role="progressbar"
      aria-valuenow={indeterminate ? undefined : clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div
        className={`h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none ${barColor} ${indeterminate ? 'w-1/3 animate-pulse' : ''}`}
        style={indeterminate ? undefined : { width: `${clamped}%` }}
      />
    </div>
  );
}
