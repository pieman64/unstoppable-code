import { useRef, type JSX } from 'react';
import { useFlipBox } from '../lib/flip-box';

/**
 * The bar's fill: a compositor stretch, not a `width` transition, on the 300ms
 * Tailwind default curve it has always used.
 */
const BAR_FILL = {
  durationMs: 300,
  easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
} as const;

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
  /**
   * Human-readable value (`aria-valuetext`) for determinate progress, when the
   * number alone does not convey the state. Ignored while indeterminate.
   */
  valueText?: string;
}

export function LinearProgress({
  percentage,
  indeterminate = false,
  barColor = 'bg-accent',
  trackColor = 'bg-fg-primary/[0.08]',
  height = 'h-0.75',
  className = '',
  label,
  valueText,
}: LinearProgressProps): JSX.Element {
  const clamped = Math.min(Math.max(percentage, 0), 100);
  // The bar takes its new width at once and is drawn growing into it with a
  // compositor scale, so it moves smoothly while the main thread is busy and
  // is exact, ends and all, once it lands.
  const barRef = useRef<HTMLDivElement>(null);
  useFlipBox(barRef, BAR_FILL);

  return (
    <div
      className={`w-full overflow-hidden rounded-full ${trackColor} ${height} ${className}`}
      role="progressbar"
      aria-valuenow={indeterminate ? undefined : clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      aria-valuetext={indeterminate ? undefined : valueText}
    >
      <div
        ref={barRef}
        className={`h-full origin-top-left rounded-full ${barColor} ${indeterminate ? 'w-1/3 animate-pulse' : ''}`}
        style={indeterminate ? undefined : { width: `${clamped}%` }}
      />
    </div>
  );
}
