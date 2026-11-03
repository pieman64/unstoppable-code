import type { JSX } from 'react';
import {
  formatCostAmount,
  formatCostShare,
  type CostSegment,
} from './cost-format';
import { ValueRow, ValueRows } from '../settings/ValueRows';

export interface CostLegendProps {
  readonly segments: readonly CostSegment[];
  /** Adds each part's share of the total (sum of segments). */
  readonly showShare?: boolean;
  /** `inline`: one wrapping line of parts, a chart legend (the panel and Activity summary). `list`: one value row per part, label left, amount and share right-aligned (the popover and breakdown; design call 1C). */
  readonly layout?: 'inline' | 'list';
  readonly testId?: string;
}

export function CostLegend({
  segments,
  showShare = false,
  layout = 'inline',
  testId,
}: CostLegendProps): JSX.Element {
  const visibleSegments = segments.filter((segment) => segment.value > 0);
  const total = visibleSegments.reduce(
    (sum, segment) => sum + segment.value,
    0,
  );

  if (layout === 'list') {
    return (
      <ValueRows dataTestId={testId}>
        {visibleSegments.map((segment) => (
          <ValueRow
            key={segment.key}
            swatch={segment.color}
            label={segment.label}
            value={formatCostAmount(segment.value)}
            share={
              showShare ? formatCostShare(segment.value, total) : undefined
            }
          />
        ))}
      </ValueRows>
    );
  }

  // A chart legend: one wrapping line under the bar it explains.
  return (
    <dl data-testid={testId} className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
      {visibleSegments.map((segment) => (
        <div key={segment.key} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-xs"
            style={{ backgroundColor: segment.color }}
          />
          <dt className="fg-secondary">{segment.label}</dt>
          <dd className="tabular-nums fg-primary">
            {formatCostAmount(segment.value)}
          </dd>
          {showShare ? (
            <dd className="tabular-nums fg-tertiary">
              {formatCostShare(segment.value, total)}
            </dd>
          ) : null}
        </div>
      ))}
    </dl>
  );
}
