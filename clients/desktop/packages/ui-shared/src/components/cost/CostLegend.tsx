import type { JSX } from 'react';
import {
  formatCostAmount,
  formatCostShare,
  type CostSegment,
} from './cost-format';

export interface CostLegendProps {
  readonly segments: readonly CostSegment[];
  /** Adds each part's share of the total (sum of segments). */
  readonly showShare?: boolean;
  /** `inline`: one wrapping line of parts (the panel and Activity summary). `list`: one row per part, label left, amount and share right-aligned (the popover and breakdown). */
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
  const inline = layout === 'inline';

  return (
    <dl
      data-testid={testId}
      className={
        inline
          ? 'flex flex-wrap gap-x-3 gap-y-1 text-xs'
          : 'flex flex-col gap-1 text-xs'
      }
    >
      {visibleSegments.map((segment) => (
        <div
          key={segment.key}
          className={
            inline ? 'flex items-center gap-1.5' : 'flex items-center gap-2'
          }
        >
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-xs"
            style={{ backgroundColor: segment.color }}
          />
          <dt
            className={
              inline ? 'fg-secondary' : 'min-w-0 flex-1 truncate fg-primary'
            }
          >
            {segment.label}
          </dt>
          <dd
            className={
              inline
                ? 'tabular-nums fg-primary'
                : 'text-right tabular-nums fg-secondary'
            }
          >
            {formatCostAmount(segment.value)}
          </dd>
          {showShare ? (
            <dd
              className={
                inline
                  ? 'tabular-nums fg-tertiary'
                  : 'w-12 text-right tabular-nums fg-primary'
              }
            >
              {formatCostShare(segment.value, total)}
            </dd>
          ) : null}
        </div>
      ))}
    </dl>
  );
}
