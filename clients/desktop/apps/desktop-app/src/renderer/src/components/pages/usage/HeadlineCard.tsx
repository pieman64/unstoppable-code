import { type JSX } from 'react';
import type {
  UsageStats,
  UsageTabSummaryCard,
} from '@canopy/desktop-shared/types';
import type { HeadlineCardSpec } from './tab-specs';
import {
  computeTrendDelta,
  formatCurrencyUsd,
  formatNumber,
  formatStartingDate,
} from './format';

function pickValue(
  spec: HeadlineCardSpec,
  value: number | UsageStats | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  if (spec.display === 'count' || spec.display === 'currency') {
    return typeof value === 'number' ? value : undefined;
  }
  if (typeof value === 'number') return undefined;
  return spec.display === 'distribution-avg' ? value.avg : value.p95;
}

function formatHeadlineValue(
  spec: HeadlineCardSpec,
  value: number | undefined,
): string {
  return spec.display === 'currency'
    ? formatCurrencyUsd(value)
    : formatNumber(value);
}

interface HeadlineCardProps {
  spec: HeadlineCardSpec;
  card: UsageTabSummaryCard;
  earliestEventAt: string;
}

export function HeadlineCard({
  spec,
  card,
  earliestEventAt,
}: HeadlineCardProps): JSX.Element {
  const last7d = pickValue(spec, card.last7d);
  const prior7d = pickValue(spec, card.prior7d);
  const allTime = pickValue(spec, card.allTime);
  const trend = computeTrendDelta(last7d, prior7d);
  const trendColor =
    trend.tone === 'up'
      ? 'fg-success'
      : trend.tone === 'down'
        ? 'fg-destructive'
        : 'fg-secondary';
  const testId = `usage-headline-card-${spec.key}`;
  return (
    <div
      className="rounded-xl border bg-card/60 p-3 text-s"
      data-testid={testId}
    >
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-xs fg-secondary">{spec.title}</div>
        <div className={`text-xs ${trendColor}`}>{trend.text}</div>
      </div>
      <div
        className="mt-1 text-lg font-semibold fg-primary"
        data-testid={`${testId}-value`}
      >
        {formatHeadlineValue(spec, last7d)}
      </div>
      {spec.unit && <div className="text-2xs fg-secondary">{spec.unit}</div>}
      <div className="mt-1 text-2xs fg-secondary">
        All time: {formatHeadlineValue(spec, allTime)} · since{' '}
        {formatStartingDate(earliestEventAt)}
      </div>
    </div>
  );
}
