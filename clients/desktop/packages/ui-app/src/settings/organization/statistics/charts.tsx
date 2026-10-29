'use client';

import type { JSX } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { categoryBarChartHeight } from './chart-layout';
import {
  compactNumber,
  formatBucketTick,
  type PivotedSeries,
  seriesColor,
} from './format';

interface StackedTimeSeriesChartProps {
  series: PivotedSeries;
  granularity: 'hour' | 'day' | 'week';
  /** Formats a stacked value for the tooltip (e.g. tokens vs. currency). */
  valueFormatter: (value: number) => string;
  /** Accessible chart title. */
  ariaLabel: string;
  /** Extra classes for the chart frame (for example replay privacy). */
  className?: string;
}

/**
 * Stacked vertical bar chart over time buckets, one stack segment per series
 * key (provider or model). Empty series render a muted placeholder.
 */
export function StackedTimeSeriesChart({
  series,
  granularity,
  valueFormatter,
  ariaLabel,
  className,
}: StackedTimeSeriesChartProps): JSX.Element {
  if (series.rows.length === 0 || series.keys.length === 0) {
    return <EmptyChart label="No data for this range" />;
  }
  return (
    <div
      className={className ? `h-72 w-full ${className}` : 'h-72 w-full'}
      data-testid="stacked-time-series"
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={series.rows}
          margin={{ top: 8, right: 8, bottom: 4, left: 4 }}
          aria-label={ariaLabel}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="var(--line-base)"
            vertical={false}
          />
          <XAxis
            dataKey="bucket"
            tickFormatter={(value: string) =>
              formatBucketTick(value, granularity)
            }
            tick={{ fontSize: 11, fill: 'var(--fg-secondary)' }}
            stroke="var(--line-base)"
          />
          <YAxis
            tickFormatter={(value: number) => compactNumber(value, 1)}
            tick={{ fontSize: 11, fill: 'var(--fg-secondary)' }}
            stroke="var(--line-base)"
            width={48}
          />
          <Tooltip
            formatter={(value) => valueFormatter(Number(value))}
            labelFormatter={(label) =>
              formatBucketTick(String(label), granularity)
            }
            cursor={{ fill: 'var(--bg-accent-subtle)', opacity: 0.3 }}
            contentStyle={{
              background: 'var(--bg-popover)',
              border: '0.5px solid var(--line-base)',
              borderRadius: 8,
              fontSize: 12,
              color: 'var(--fg-primary)',
            }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {series.keys.map((key, index) => (
            <Bar
              key={key}
              dataKey={key}
              stackId="usage"
              fill={seriesColor(index)}
              radius={
                index === series.keys.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]
              }
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface CategoryDatum {
  label: string;
  value: number;
}

interface CategoryBarChartProps {
  data: readonly CategoryDatum[];
  valueFormatter: (value: number) => string;
  ariaLabel: string;
}

/** Horizontal bar chart for a flat category breakdown (e.g. tool categories). */
export function CategoryBarChart({
  data,
  valueFormatter,
  ariaLabel,
}: CategoryBarChartProps): JSX.Element {
  if (data.length === 0) {
    return <EmptyChart label="No data for this range" />;
  }
  const rows = data.map((datum) => ({ ...datum }));
  return (
    <div
      className="w-full"
      style={{ height: categoryBarChartHeight(rows.length) }}
      data-testid="category-bar-chart"
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={rows}
          layout="vertical"
          margin={{ top: 4, right: 16, bottom: 4, left: 8 }}
          aria-label={ariaLabel}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="var(--line-base)"
            horizontal={false}
          />
          <XAxis
            type="number"
            tickFormatter={(value: number) => compactNumber(value, 1)}
            tick={{ fontSize: 11, fill: 'var(--fg-secondary)' }}
            stroke="var(--line-base)"
          />
          <YAxis
            type="category"
            dataKey="label"
            tick={{ fontSize: 11, fill: 'var(--fg-secondary)' }}
            stroke="var(--line-base)"
            width={120}
          />
          <Tooltip
            formatter={(value) => valueFormatter(Number(value))}
            contentStyle={{
              background: 'var(--bg-popover)',
              border: '0.5px solid var(--line-base)',
              borderRadius: 8,
              fontSize: 12,
              color: 'var(--fg-primary)',
            }}
            cursor={{ fill: 'var(--bg-accent-subtle)', opacity: 0.3 }}
          />
          <Bar dataKey="value" radius={[0, 3, 3, 0]}>
            {rows.map((row, index) => (
              <Cell key={row.label} fill={seriesColor(index)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

const TOOLTIP_STYLE = {
  background: 'var(--bg-popover)',
  border: '0.5px solid var(--line-base)',
  borderRadius: 8,
  fontSize: 12,
  color: 'var(--fg-primary)',
} as const;

export interface ComparisonSeries {
  /** Row key in `data`. */
  key: string;
  label: string;
  /** Fixed theme role, e.g. `var(--fg-accent)`. */
  color: string;
}

interface ComparisonLineChartProps {
  data: ReadonlyArray<Record<string, string | number>>;
  /** Row key holding the bucket start ISO timestamp. */
  bucketKey: string;
  granularity: 'hour' | 'day' | 'week';
  series: readonly [ComparisonSeries, ComparisonSeries];
  valueFormatter: (value: number) => string;
  ariaLabel: string;
  testId?: string;
}

/** Two named series over time buckets, legend top right. */
export function ComparisonLineChart({
  data,
  bucketKey,
  granularity,
  series,
  valueFormatter,
  ariaLabel,
  testId = 'comparison-line-chart',
}: ComparisonLineChartProps): JSX.Element {
  if (data.length === 0) {
    return <EmptyChart label="No data for this range" />;
  }
  const rows = data.map((row) => ({ ...row }));
  return (
    <div className="h-72 w-full" data-testid={testId}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={rows}
          margin={{ top: 8, right: 8, bottom: 4, left: 4 }}
          aria-label={ariaLabel}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="var(--line-base)"
            vertical={false}
          />
          <XAxis
            dataKey={bucketKey}
            tickFormatter={(value: string) =>
              formatBucketTick(value, granularity)
            }
            tick={{ fontSize: 11, fill: 'var(--fg-secondary)' }}
            stroke="var(--line-base)"
          />
          <YAxis
            tickFormatter={(value: number) => valueFormatter(value)}
            tick={{ fontSize: 11, fill: 'var(--fg-secondary)' }}
            stroke="var(--line-base)"
            width={64}
          />
          <Tooltip
            formatter={(value) => valueFormatter(Number(value))}
            labelFormatter={(label) =>
              formatBucketTick(String(label), granularity)
            }
            contentStyle={TOOLTIP_STYLE}
          />
          <Legend
            verticalAlign="top"
            align="right"
            wrapperStyle={{ fontSize: 12, paddingBottom: 8 }}
          />
          {series.map((line) => (
            <Line
              key={line.key}
              type="monotone"
              dataKey={line.key}
              name={line.label}
              stroke={line.color}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface PairedCategoryDatum {
  label: string;
  first: number;
  second: number;
  /** Optional tooltip detail per side (e.g. cost share). */
  firstDetail?: string;
  secondDetail?: string;
}

interface PairedCategoryBarChartProps {
  data: readonly PairedCategoryDatum[];
  series: readonly [ComparisonSeries, ComparisonSeries];
  /** Formats bar-end labels and the axis. */
  valueFormatter: (value: number) => string;
  ariaLabel: string;
  testId?: string;
}

/** Grouped horizontal bars (two per category) with value labels at the end. */
export function PairedCategoryBarChart({
  data,
  series,
  valueFormatter,
  ariaLabel,
  testId = 'paired-category-bar-chart',
}: PairedCategoryBarChartProps): JSX.Element {
  if (data.length === 0) {
    return <EmptyChart label="No data for this range" />;
  }
  const rows = data.map((datum) => ({ ...datum }));
  return (
    <div
      className="w-full"
      style={{ height: Math.max(180, rows.length * 56 + 48) }}
      data-testid={testId}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={rows}
          layout="vertical"
          margin={{ top: 4, right: 48, bottom: 4, left: 8 }}
          aria-label={ariaLabel}
          barGap={2}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="var(--line-base)"
            horizontal={false}
          />
          <XAxis
            type="number"
            tickFormatter={(value: number) => valueFormatter(value)}
            tick={{ fontSize: 11, fill: 'var(--fg-secondary)' }}
            stroke="var(--line-base)"
          />
          <YAxis
            type="category"
            dataKey="label"
            tick={{ fontSize: 11, fill: 'var(--fg-secondary)' }}
            stroke="var(--line-base)"
            width={140}
          />
          <Tooltip
            formatter={(value, name, item) => {
              const payload: unknown = item.payload;
              const detailKey =
                item.dataKey === 'first' ? 'firstDetail' : 'secondDetail';
              const detail: unknown =
                typeof payload === 'object' &&
                payload !== null &&
                detailKey in payload
                  ? Reflect.get(payload, detailKey)
                  : undefined;
              const formatted = valueFormatter(Number(value));
              return [
                typeof detail === 'string'
                  ? `${formatted} (${detail})`
                  : formatted,
                name,
              ];
            }}
            contentStyle={TOOLTIP_STYLE}
            cursor={{ fill: 'var(--bg-accent-subtle)', opacity: 0.3 }}
          />
          <Legend
            verticalAlign="top"
            align="right"
            wrapperStyle={{ fontSize: 12, paddingBottom: 8 }}
          />
          <Bar
            dataKey="first"
            name={series[0].label}
            fill={series[0].color}
            radius={[0, 3, 3, 0]}
            isAnimationActive={false}
          >
            <LabelList
              dataKey="first"
              position="right"
              formatter={(value: unknown) => valueFormatter(Number(value))}
              style={{ fontSize: 11, fill: 'var(--fg-secondary)' }}
            />
          </Bar>
          <Bar
            dataKey="second"
            name={series[1].label}
            fill={series[1].color}
            radius={[0, 3, 3, 0]}
            isAnimationActive={false}
          >
            <LabelList
              dataKey="second"
              position="right"
              formatter={(value: unknown) => valueFormatter(Number(value))}
              style={{ fontSize: 11, fill: 'var(--fg-secondary)' }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function EmptyChart({ label }: { label: string }): JSX.Element {
  return (
    <div
      className="flex h-48 w-full items-center justify-center rounded-lg border border-dashed text-s fg-secondary"
      data-testid="chart-empty"
    >
      {label}
    </div>
  );
}
