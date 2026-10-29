import type { JSX } from 'react';
import {
  spinnerClassName,
  spinnerGapStyle,
  type SpinnerTone,
} from './spinner-tone';
import { CometSpinner } from './CometSpinner';
import { cometTone, useSpinnerStyle } from './spinner-style';

interface LoadingSpinnerProps {
  /** Placement only: margin, alignment, and flex participation. */
  className?: string;
  /** Ink of the dots. Defaults to the surrounding text color. */
  tone?: SpinnerTone;
  /** Reads beneath an adjacent label, such as inside an action button. */
  quiet?: boolean;
  /**
   * Width and height in px, for a spinner that shares a slot with sized
   * icons. The dots stay 2px; the gaps widen to fill the slot.
   */
  sizePx?: number;
  /**
   * Stable hook for asserting "this affordance is busy" (CAN-2349 decision 4).
   * The spinner renders inside the button that started the work, so tests
   * scope the query to that button rather than to a page-wide spinner count.
   */
  dataTestId?: string;
  /**
   * Mark the spinner as presentational, for the case where it sits INSIDE a
   * control that is already named.
   *
   * A descendant `aria-label` is folded into the accessible name an ancestor
   * button computes from its contents, so a busy button rendering this spinner
   * next to "Saving…" otherwise announces as "Loading Saving…". Standalone
   * spinners — the common case across the app, and what existing tests query by
   * `[aria-label="Loading"]` — keep the label, so this is opt-in rather than a
   * change of default.
   */
  decorative?: boolean;
}

const DOT =
  'h-0.5 w-0.5 rounded-full bg-current will-change-[transform,opacity]';
/**
 * A marching dot. Under reduced motion the global rule would run the march
 * once in 0.01ms and hold its last frame, where every dot is hidden, so the
 * dots stop animating instead and the ring shows still.
 */
const MARCHING_DOT = `${DOT} animate-loading-dot motion-reduce:animate-none`;
/** The 3×3 grid's natural box: three 2px dots and two 2px gaps. */
const DOT_GRID_SIZE_PX = 10;

/**
 * Perimeter-march dot spinner on a 3×3 grid.
 * Path: 1→2→3→6→9→8→7→4 (repeat).
 * Visually matches ThinkingSpinner's dot size and grid layout.
 */
export function LoadingSpinner({
  className = '',
  tone = 'inherit',
  quiet = false,
  sizePx,
  dataTestId,
  decorative = false,
}: LoadingSpinnerProps): JSX.Element {
  // A host that draws spinners as the comet (desktop early access) gets the
  // ring at the dot grid's footprint, with the same name and test hook.
  if (useSpinnerStyle() === 'comet') {
    return (
      <CometSpinner
        className={className}
        tone={cometTone(tone)}
        quiet={quiet}
        sizePx={sizePx ?? DOT_GRID_SIZE_PX}
        ariaLabel={decorative ? undefined : 'Loading'}
        dataTestId={dataTestId}
      />
    );
  }
  return (
    <span
      className={`inline-grid grid-cols-3 gap-0.5 ${spinnerClassName(tone, quiet)} ${className}`}
      style={spinnerGapStyle(sizePx)}
      {...(decorative ? { 'aria-hidden': true } : { 'aria-label': 'Loading' })}
      data-testid={dataTestId}
    >
      {/* Row 0: positions 1, 2, 3 */}
      <span className={MARCHING_DOT} />
      <span className={`${MARCHING_DOT} [animation-delay:0.15s]`} />
      <span className={`${MARCHING_DOT} [animation-delay:0.3s]`} />
      {/* Row 1: positions 4, (center hidden), 6 */}
      <span className={`${MARCHING_DOT} [animation-delay:1.05s]`} />
      <span className={`${DOT} opacity-0`} />
      <span className={`${MARCHING_DOT} [animation-delay:0.45s]`} />
      {/* Row 2: positions 7, 8, 9 */}
      <span className={`${MARCHING_DOT} [animation-delay:0.9s]`} />
      <span className={`${MARCHING_DOT} [animation-delay:0.75s]`} />
      <span className={`${MARCHING_DOT} [animation-delay:0.6s]`} />
    </span>
  );
}
