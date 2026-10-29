import { OPERATIONAL_STATUS_COLORS } from '../lib/operational-status-colors';

/**
 * Ink for the dot spinners. `inherit` takes the surrounding text color, which
 * is right inside a labelled control; the rest name the role the spinner
 * stands for. `active` and `unread` are operational run states and follow
 * {@link OPERATIONAL_STATUS_COLORS}.
 */
export type SpinnerTone =
  | 'inherit'
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'accent'
  | 'emphasis'
  | 'warning'
  | 'destructive'
  | 'active'
  | 'unread';

export const SPINNER_TONE_CLASS_NAMES: Record<SpinnerTone, string> = {
  inherit: '',
  primary: 'fg-primary',
  secondary: 'fg-secondary',
  tertiary: 'fg-tertiary',
  accent: 'fg-accent',
  emphasis: 'fg-emphasis',
  warning: 'fg-warning',
  destructive: 'fg-destructive',
  active: OPERATIONAL_STATUS_COLORS.active.foreground,
  unread: OPERATIONAL_STATUS_COLORS.unread.foreground,
};

/**
 * A quiet spinner reads beneath the label it sits beside, such as the busy
 * spinner inside an action button: the button's own ink, at reduced weight.
 */
export const SPINNER_QUIET_CLASS_NAME = 'opacity-60';

export function spinnerClassName(tone: SpinnerTone, quiet: boolean): string {
  const ink = SPINNER_TONE_CLASS_NAMES[tone];
  return quiet ? `${ink} ${SPINNER_QUIET_CLASS_NAME}` : ink;
}

const DOT_PX = 2;
/** Natural width/height of the 3x3 dot grid at its default 2px gaps. */
const DOT_GRID_PX = 3 * DOT_PX + 2 * 2;

/**
 * Inline gap that grows the dot grid to fill a `sizePx` slot. The three 2px
 * columns are fixed, so a larger box is met by widening the gaps; a size at or
 * below the natural grid returns nothing, since shrinking would need smaller
 * dots rather than a negative gap. Inline so it beats the default `gap-0.5`
 * utility regardless of stylesheet order.
 */
export function spinnerGapStyle(sizePx?: number): { gap: string } | undefined {
  return sizePx !== undefined && sizePx > DOT_GRID_PX
    ? { gap: `${(sizePx - 3 * DOT_PX) / 2}px` }
    : undefined;
}
