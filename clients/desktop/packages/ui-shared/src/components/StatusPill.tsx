import type { JSX, ReactNode } from 'react';

/**
 * Metrics for every small status marker in the app: fixed 16px height, pill
 * radius, 6px horizontal padding, and the smallest label ramp with its line
 * height pinned so the pill never grows a row.
 *
 * Kept as one private constant because these values only mean something
 * together - a status marker that changes its height or padding alone stops
 * matching the ones it sits beside. The fill (`bg-subtle`) is part of the
 * metrics; the ink is the `tone`.
 */
const STATUS_PILL_METRICS =
  'inline-flex h-4 shrink-0 items-center rounded-full bg-subtle px-1.5 text-3xs font-medium leading-none';

/**
 * Ink for the label. `quaternary` is the common neutral marker (Private,
 * Archived, View only); `tertiary` and `secondary` step up for markers the
 * row relies on to be read (an import's provider, its status); `warning`
 * flags a marker the user should act on (Unavailable); `warning-strong` is
 * that flag where it must read at 4.5:1 in light mode (an expired sign-in).
 */
export type StatusPillTone =
  | 'quaternary'
  | 'tertiary'
  | 'secondary'
  | 'warning'
  | 'warning-strong';

const TONE_CLASS_NAMES: Record<StatusPillTone, string> = {
  quaternary: 'fg-quaternary',
  tertiary: 'fg-tertiary',
  secondary: 'fg-secondary',
  warning: 'fg-warning',
  'warning-strong': 'fg-warning-strong',
};

export interface StatusPillProps {
  /** The pill label. Kept as a node so a marker can pair an icon with text. */
  children: ReactNode;
  tone?: StatusPillTone;
  /**
   * Placement classes appended after the shared metrics and tone. Do not use
   * it to restate the metrics or the ink - the point of this component is
   * that they live in one place.
   */
  className?: string;
  'data-testid'?: string;
}

/**
 * The single source of truth for status-marker metrics.
 *
 * `CapabilityPill` and `ViewOnlyPill` previously carried a byte-identical
 * className, and their docblocks each asserted that they matched the other -
 * a claim nothing enforced, so the two would have drifted on the first
 * one-sided tweak. New status markers compose this component instead of
 * restating the classes.
 *
 * Presentation only: it renders exactly one `<span>` and adds no behavior, so
 * composing it is a drop-in replacement for a hand-written pill span.
 */
export function StatusPill({
  children,
  tone = 'quaternary',
  className,
  'data-testid': testId,
}: StatusPillProps): JSX.Element {
  const pillClassName = `${STATUS_PILL_METRICS} ${TONE_CLASS_NAMES[tone]}`;
  return (
    <span
      data-testid={testId}
      className={className ? `${pillClassName} ${className}` : pillClassName}
    >
      {children}
    </span>
  );
}
