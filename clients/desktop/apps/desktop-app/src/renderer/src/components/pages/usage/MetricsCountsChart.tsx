import { type JSX, useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type {
  UsageCountsTimeseriesBucket,
  UsageMetricId,
} from '@canopy/desktop-shared/types';
import type { PickerOption } from './tab-specs';
import {
  CHART_HEIGHT_PX,
  formatBucketLabel,
  formatCompactNumber,
} from './chart-primitives';
import { formatCompactCurrencyUsd, formatCurrencyUsd } from './format';

// Stable palette for series. Picked to cover up to ~22 categories.
const SERIES_COLORS = [
  '#60a5fa',
  '#a78bfa',
  '#34d399',
  '#fbbf24',
  '#f87171',
  '#22d3ee',
  '#fb923c',
  '#c084fc',
  '#4ade80',
  '#facc15',
  '#fb7185',
  '#38bdf8',
  '#a3e635',
  '#e879f9',
  '#fde047',
  '#fda4af',
  '#7dd3fc',
  '#bef264',
  '#f0abfc',
  '#fef08a',
  '#fecdd3',
  '#bae6fd',
];

export function colorForSeries(metric: UsageMetricId): string {
  let hash = 0;
  for (let i = 0; i < metric.length; i += 1) {
    hash = (hash * 31 + metric.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash) % SERIES_COLORS.length;
  return SERIES_COLORS[index];
}

interface MetricsCountsChartProps {
  buckets: ReadonlyArray<UsageCountsTimeseriesBucket>;
  visibleSeries: ReadonlySet<UsageMetricId>;
  seriesOptions: ReadonlyArray<PickerOption<UsageMetricId>>;
  bucket: 'hour' | 'day' | 'week';
  valueFormat?: 'number' | 'currency';
}

interface CountsDatum {
  bucketStart: string;
  label: string;
  total: number;
  [key: string]: number | string;
}

interface TooltipPayloadEntry {
  dataKey?: unknown;
  name?: unknown;
  value?: unknown;
  color?: unknown;
}

interface CountsTooltipProps {
  active?: boolean;
  label?: unknown;
  payload?: ReadonlyArray<unknown>;
  valueFormat?: 'number' | 'currency';
}

function CountsTooltipContent({
  active,
  label,
  payload,
  valueFormat = 'number',
}: CountsTooltipProps): JSX.Element {
  if (!active || !payload || payload.length === 0) return <></>;
  const labelStr =
    typeof label === 'string'
      ? label
      : typeof label === 'number'
        ? String(label)
        : '';
  return (
    <div className="flex flex-col rounded bg-popover fg-primary p-2 shadow-md text-xs gap-1">
      {labelStr ? <div className="font-semibold">{labelStr}</div> : null}
      {payload.map((raw, i) => {
        const entry = raw as TooltipPayloadEntry;
        const name = typeof entry.name === 'string' ? entry.name : '';
        const value = typeof entry.value === 'number' ? entry.value : 0;
        const color = typeof entry.color === 'string' ? entry.color : undefined;
        return (
          <div key={i} className="flex items-center gap-2 whitespace-nowrap">
            {color ? (
              <span
                aria-hidden="true"
                className="inline-block h-2 w-2 rounded-sm"
                style={{ backgroundColor: color }}
              />
            ) : null}
            <span className="fg-secondary">{name}</span>
            <span className="ml-auto tabular-nums">
              {valueFormat === 'currency'
                ? formatCurrencyUsd(value)
                : formatCompactNumber(value)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function MetricsCountsChart({
  buckets,
  visibleSeries,
  seriesOptions,
  bucket,
  valueFormat = 'number',
}: MetricsCountsChartProps): JSX.Element {
  const data = useMemo<CountsDatum[]>(() => {
    return buckets.map((b) => {
      const datum: CountsDatum = {
        bucketStart: b.bucketStart,
        label: formatBucketLabel(b.bucketStart, bucket),
        total: 0,
      };
      let total = 0;
      for (const opt of seriesOptions) {
        const value = b.series[opt.value] ?? 0;
        datum[opt.value] = value;
        if (visibleSeries.has(opt.value)) total += value;
      }
      datum.total = total;
      return datum;
    });
  }, [buckets, seriesOptions, visibleSeries, bucket]);

  return (
    <ResponsiveContainer width="100%" height={CHART_HEIGHT_PX}>
      <BarChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
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
          tickFormatter={(v: number) =>
            valueFormat === 'currency'
              ? formatCompactCurrencyUsd(v)
              : formatCompactNumber(v)
          }
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          cursor={{ fill: 'var(--bg-secondary)', fillOpacity: 0.4 }}
          content={(props) => (
            <CountsTooltipContent {...props} valueFormat={valueFormat} />
          )}
        />
        {seriesOptions
          .filter((opt) => visibleSeries.has(opt.value))
          .map((opt) => (
            <Bar
              key={opt.value}
              dataKey={opt.value as string}
              name={opt.label}
              stackId="counts"
              fill={colorForSeries(opt.value)}
              radius={0}
            />
          ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
