import { type JSX, useMemo } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { UsageDistributionTimeseriesBucket } from '@canopy/desktop-shared/types';
import {
  CHART_HEIGHT_PX,
  formatBucketLabel,
  formatCompactNumber,
} from './chart-primitives';

export type Percentile = 'p50' | 'p95' | 'p99';

const PERCENTILE_COLORS: Record<Percentile, string> = {
  p50: '#34d399',
  p95: '#fbbf24',
  p99: '#f87171',
};

interface MetricsDistributionChartProps {
  buckets: ReadonlyArray<UsageDistributionTimeseriesBucket>;
  visiblePercentiles: ReadonlySet<Percentile>;
  bucket: 'hour' | 'day' | 'week';
}

interface DistributionDatum {
  bucketStart: string;
  label: string;
  p50: number;
  p95: number;
  p99: number;
  sampleCount: number;
}

interface DistributionTooltipEntry {
  dataKey?: unknown;
  name?: unknown;
  value?: unknown;
  stroke?: unknown;
}

interface DistributionTooltipProps {
  active?: boolean;
  label?: unknown;
  payload?: ReadonlyArray<unknown>;
}

function DistributionTooltipContent({
  active,
  label,
  payload,
}: DistributionTooltipProps): JSX.Element {
  if (!active || !payload || payload.length === 0) return <></>;
  const labelStr =
    typeof label === 'string'
      ? label
      : typeof label === 'number'
        ? String(label)
        : '';
  return (
    <div className="rounded bg-popover fg-primary p-2 shadow-md text-xs space-y-1">
      {labelStr ? <div className="font-semibold">{labelStr}</div> : null}
      {payload.map((raw, i) => {
        const entry = raw as DistributionTooltipEntry;
        const name = typeof entry.name === 'string' ? entry.name : '';
        const value = typeof entry.value === 'number' ? entry.value : 0;
        const stroke =
          typeof entry.stroke === 'string' ? entry.stroke : undefined;
        return (
          <div key={i} className="flex items-center gap-2 whitespace-nowrap">
            {stroke ? (
              <span
                aria-hidden="true"
                className="inline-block h-0.5 w-3"
                style={{ backgroundColor: stroke }}
              />
            ) : null}
            <span className="fg-secondary">{name}</span>
            <span className="ml-auto tabular-nums">
              {formatCompactNumber(value)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function MetricsDistributionChart({
  buckets,
  visiblePercentiles,
  bucket,
}: MetricsDistributionChartProps): JSX.Element {
  const data = useMemo<DistributionDatum[]>(
    () =>
      buckets.map((b) => ({
        bucketStart: b.bucketStart,
        label: formatBucketLabel(b.bucketStart, bucket),
        p50: b.p50,
        p95: b.p95,
        p99: b.p99,
        sampleCount: b.sampleCount,
      })),
    [buckets, bucket],
  );

  const percentileOrder: ReadonlyArray<Percentile> = ['p50', 'p95', 'p99'];

  return (
    <ResponsiveContainer width="100%" height={CHART_HEIGHT_PX}>
      <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--line-base)" />
        <XAxis
          dataKey="label"
          stroke="var(--fg-secondary)"
          fontSize={11}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          stroke="var(--fg-secondary)"
          fontSize={11}
          tickFormatter={(v: number) => formatCompactNumber(v)}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          cursor={{ stroke: 'var(--bg-secondary)', strokeWidth: 1 }}
          content={DistributionTooltipContent}
        />
        {percentileOrder.map((p) =>
          visiblePercentiles.has(p) ? (
            <Line
              key={p}
              type="monotone"
              dataKey={p}
              stroke={PERCENTILE_COLORS[p]}
              dot={false}
              strokeWidth={2}
            />
          ) : null,
        )}
      </LineChart>
    </ResponsiveContainer>
  );
}
