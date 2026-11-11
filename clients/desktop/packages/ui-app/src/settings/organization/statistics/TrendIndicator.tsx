'use client';

import type { JSX } from 'react';
import {
  ArrowDownRight,
  ArrowUpRight,
  Minus,
} from '@canopy/ui-shared/icons/AppIcons';
import { computeTrend, type TrendDirection } from './format';

/**
 * How trend chips are colored, since "up" is not universally good across the
 * surfaces that share this chip.
 *
 * - `'cost'` (default): a cost/usage dashboard where a rising trend draws
 *   attention (`up → fg-warning`) and a falling one is reassuring
 *   (`down → fg-success`). Used by the team/org statistics and team-member
 *   profile dashboards.
 * - `'flex'`: a more-is-better framing where an upward trend is positive
 *   (`up → fg-success`) and a downward trend reads as a decline
 *   (`down → fg-destructive`). Used by the public profile and by the work
 *   digest report, where every card — spend included — is framed as output.
 */
export type TrendColorScheme = 'cost' | 'flex';

interface TrendIndicatorProps {
  /** Current-period value. */
  current: number;
  /** Prior-period value; null when there is nothing to compare against. */
  previous: number | null;
  scheme?: TrendColorScheme;
  /**
   * Suppress the chip unless a real percentage exists — i.e. hide it when the
   * delta is not computable *or* the prior value was `<= 0`. Surfaces that opt
   * in render nothing rather than a `New` or `0%` chip, so a card with no
   * baseline reads as "no comparison" instead of a fabricated signal.
   *
   * Defaults to `false`, preserving the usage dashboards' existing behavior of
   * always showing a chip so the tile grid stays visually even.
   */
  requireComputablePercent?: boolean;
  /**
   * Optional trailing copy (e.g. `vs. prior`) rendered in secondary text after
   * the percentage. Only shown when a real percentage exists.
   */
  comparisonLabel?: string;
  'data-testid'?: string;
}

/**
 * Period-over-period trend chip: a direction arrow, a signed percentage, and
 * optional comparison copy. Renders `null` when there is no trend worth
 * showing, so callers can drop it into a card unconditionally.
 */
export function TrendIndicator({
  current,
  previous,
  scheme = 'cost',
  requireComputablePercent = false,
  comparisonLabel,
  'data-testid': testId,
}: TrendIndicatorProps): JSX.Element | null {
  const trend = computeTrend(current, previous);
  if (trend.label === '—') return null;
  if (
    requireComputablePercent &&
    (trend.deltaPct === null || previous === null || previous <= 0)
  ) {
    return null;
  }

  return (
    <p
      className={`mt-1 inline-flex items-center gap-1 text-xs font-medium ${trendColor(
        trend.direction,
        scheme,
      )}`}
      data-testid={testId}
    >
      {TREND_GLYPHS[trend.direction]}
      {trend.label}
      {trend.deltaPct !== null && comparisonLabel && (
        <span className="fg-secondary">{comparisonLabel}</span>
      )}
    </p>
  );
}

function trendColor(
  direction: TrendDirection,
  scheme: TrendColorScheme,
): string {
  switch (direction) {
    case 'up':
      return scheme === 'flex' ? 'fg-success' : 'fg-warning';
    case 'down':
      return scheme === 'flex' ? 'fg-destructive' : 'fg-success';
    default:
      return 'fg-secondary';
  }
}

const TREND_GLYPHS: Readonly<Record<TrendDirection, JSX.Element>> = {
  up: <ArrowUpRight size="sm" aria-hidden="true" />,
  down: <ArrowDownRight size="sm" aria-hidden="true" />,
  flat: <Minus size="sm" aria-hidden="true" />,
};
