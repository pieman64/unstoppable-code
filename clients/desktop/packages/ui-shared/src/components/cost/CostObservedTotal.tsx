import type { JSX } from 'react';
import { formatCostDay } from './cost-format';

export interface CostObservedTotalProps {
  /** The formatted total (`$21.66`, `Not priced`). */
  readonly amountLabel: string;
  /** ISO day where the data starts, only when the entry or chat is older than it: `observed since Oct 1`. */
  readonly coverageStart?: string;
  /** `header` (text-m font-medium, the Cost panel) or `inline` (text-s font-medium, subagent and run sections). Default header. */
  readonly size?: 'header' | 'inline';
  readonly testId?: string;
}

export function CostObservedTotal({
  amountLabel,
  coverageStart,
  size = 'header',
  testId = 'cost-total',
}: CostObservedTotalProps): JSX.Element {
  const coverageDay =
    coverageStart === undefined ? null : formatCostDay(coverageStart);
  const observedLabel =
    coverageDay === null ? 'observed' : `observed since ${coverageDay}`;

  return (
    <div data-testid={testId} className="flex items-baseline gap-1.5">
      <span
        data-testid={`${testId}-amount`}
        className={`${size === 'inline' ? 'text-s' : 'text-m'} font-medium tabular-nums fg-primary`}
      >
        {amountLabel}
      </span>
      <span className="text-xs fg-tertiary">{observedLabel}</span>
    </div>
  );
}
