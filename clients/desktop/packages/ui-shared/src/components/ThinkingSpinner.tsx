import type { JSX } from 'react';
import {
  spinnerClassName,
  spinnerGapStyle,
  type SpinnerTone,
} from './spinner-tone';
import { CometSpinner } from './CometSpinner';
import { cometTone, useSpinnerStyle } from './spinner-style';

interface ThinkingSpinnerProps {
  /** Placement only: margin, alignment, and flex participation. */
  className?: string;
  /** Ink of the dots. Defaults to the surrounding text color. */
  tone?: SpinnerTone;
  /** Reads beneath an adjacent label, such as inside an action button. */
  quiet?: boolean;
  /**
   * Total width/height in px. The three 2px dot columns are fixed, so the
   * size is met by widening the gaps — 10px (the default grid) up to any
   * larger box. Set it where the spinner shares a slot with sized icons and
   * must not read narrower than them; omit it everywhere else.
   */
  sizePx?: number;
}

const DOT =
  'h-0.5 w-0.5 rounded-full bg-current will-change-[transform,opacity]';
/** The 3×3 grid's natural box: three 2px dots and two 2px gaps. */
const DOT_GRID_SIZE_PX = 10;

/**
 * Pure display "thinking" spinner. Renders a 3x3 grid of dots whose
 * opacity/scale pulses on the `--animate-thinking-dot` theme animation from
 * `canopy-tokens.css`, each dot offset by its own `animation-delay`. Hosts
 * set its ink with `tone` and its slot with `sizePx`; `className` is for
 * placement.
 */
export function ThinkingSpinner({
  className = '',
  tone = 'inherit',
  quiet = false,
  sizePx,
}: ThinkingSpinnerProps): JSX.Element {
  // A host that draws spinners as the comet (desktop early access) gets the
  // ring at the dot grid's footprint, keeping the "Thinking" name.
  if (useSpinnerStyle() === 'comet') {
    return (
      <CometSpinner
        className={className}
        tone={cometTone(tone)}
        quiet={quiet}
        sizePx={sizePx ?? DOT_GRID_SIZE_PX}
        ariaLabel="Thinking"
      />
    );
  }
  return (
    <span
      className={`inline-grid grid-cols-3 gap-0.5 ${spinnerClassName(tone, quiet)} ${className}`}
      style={spinnerGapStyle(sizePx)}
      aria-label="Thinking"
    >
      {/* Row 0: split targets (0 left, 1 center, 2 right) */}
      <span className={`${DOT} animate-thinking-dot [animation-delay:0.45s]`} />
      <span className={`${DOT} animate-thinking-dot [animation-delay:0.3s]`} />
      <span className={`${DOT} animate-thinking-dot [animation-delay:0.45s]`} />
      {/* Row 1: split mid (3 left, 4 center, 5 right) */}
      <span className={`${DOT} animate-thinking-dot [animation-delay:0.6s]`} />
      <span className={`${DOT} animate-thinking-dot [animation-delay:0.15s]`} />
      <span className={`${DOT} animate-thinking-dot [animation-delay:0.6s]`} />
      {/* Row 2: start + split end (6 left, 7 center, 8 right) */}
      <span className={`${DOT} animate-thinking-dot [animation-delay:0.75s]`} />
      <span className={`${DOT} animate-thinking-dot`} />
      <span className={`${DOT} animate-thinking-dot [animation-delay:0.75s]`} />
    </span>
  );
}
