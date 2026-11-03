'use client';

import { useContinuousMotion } from '../lib/continuous-motion';
import type { JSX } from 'react';
import { CometSpinner } from './CometSpinner';
import { useSpinnerStyle } from './spinner-style';

interface RunSpinnerProps {
  className?: string;
}

const DOT = 'h-0.5 w-0.5 rounded-full bg-current';
/**
 * A sweeping dot. Under reduced motion the global rule would run the sweep
 * once in 0.01ms and hold its last frame, where every dot is hidden, so the
 * dots stop animating instead and the grid shows still.
 */
const SWEEPING_DOT = `${DOT} animate-run-dot motion-reduce:animate-none`;

/**
 * Diagonal-sweep dot spinner on a 3×3 grid.
 * Sequence: (1+9) → (8+2) → (7+3) → (4+6) → repeat.
 * Two fully active dots at a time, sweeping across the anti-diagonals.
 */
export function RunSpinner({ className = '' }: RunSpinnerProps): JSX.Element {
  const motionRef = useContinuousMotion<HTMLSpanElement>();
  // A host that draws spinners as the comet (desktop early access) gets the
  // ring at the dot grid's 10px footprint, keeping the "Running" name.
  if (useSpinnerStyle() === 'comet') {
    return (
      <CometSpinner className={className} sizePx={10} ariaLabel="Running" />
    );
  }
  return (
    <span
      ref={motionRef}
      className={`inline-grid grid-cols-3 gap-0.5 ${className}`}
      role="img"
      aria-label="Running"
    >
      {/* Row 0: positions 1, 2, 3 */}
      <span className={`${SWEEPING_DOT}`} />
      <span className={`${SWEEPING_DOT} [animation-delay:0.3s]`} />
      <span className={`${SWEEPING_DOT} [animation-delay:0.6s]`} />
      {/* Row 1: positions 4, 5 (hidden), 6 */}
      <span className={`${SWEEPING_DOT} [animation-delay:0.9s]`} />
      <span className={`${DOT} opacity-0`} />
      <span className={`${SWEEPING_DOT} [animation-delay:0.9s]`} />
      {/* Row 2: positions 7, 8, 9 */}
      <span className={`${SWEEPING_DOT} [animation-delay:0.6s]`} />
      <span className={`${SWEEPING_DOT} [animation-delay:0.3s]`} />
      <span className={`${SWEEPING_DOT}`} />
    </span>
  );
}
