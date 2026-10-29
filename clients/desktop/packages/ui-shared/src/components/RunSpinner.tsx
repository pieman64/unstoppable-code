import type { JSX } from 'react';
import { CometSpinner } from './CometSpinner';
import { useSpinnerStyle } from './spinner-style';

interface RunSpinnerProps {
  className?: string;
}

const DOT =
  'h-0.5 w-0.5 rounded-full bg-current will-change-[transform,opacity]';

/**
 * Diagonal-sweep dot spinner on a 3×3 grid.
 * Sequence: (1+9) → (8+2) → (7+3) → (4+6) → repeat.
 * Two fully active dots at a time, sweeping across the anti-diagonals.
 */
export function RunSpinner({ className = '' }: RunSpinnerProps): JSX.Element {
  // A host that draws spinners as the comet (desktop early access) gets the
  // ring at the dot grid's 10px footprint, keeping the "Running" name.
  if (useSpinnerStyle() === 'comet') {
    return (
      <CometSpinner className={className} sizePx={10} ariaLabel="Running" />
    );
  }
  return (
    <span
      className={`inline-grid grid-cols-3 gap-0.5 ${className}`}
      aria-label="Running"
    >
      {/* Row 0: positions 1, 2, 3 */}
      <span className={`${DOT} animate-run-dot`} />
      <span className={`${DOT} animate-run-dot [animation-delay:0.3s]`} />
      <span className={`${DOT} animate-run-dot [animation-delay:0.6s]`} />
      {/* Row 1: positions 4, 5 (hidden), 6 */}
      <span className={`${DOT} animate-run-dot [animation-delay:0.9s]`} />
      <span className={`${DOT} opacity-0`} />
      <span className={`${DOT} animate-run-dot [animation-delay:0.9s]`} />
      {/* Row 2: positions 7, 8, 9 */}
      <span className={`${DOT} animate-run-dot [animation-delay:0.6s]`} />
      <span className={`${DOT} animate-run-dot [animation-delay:0.3s]`} />
      <span className={`${DOT} animate-run-dot`} />
    </span>
  );
}
