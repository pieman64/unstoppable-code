import { type JSX, useEffect, useMemo, useState } from 'react';
import type {
  UsageCountsTimeseriesBucket,
  UsageDistributionTimeseriesBucket,
  UsageMetricId,
} from '@canopy/desktop-shared/types';
import { useObservabilityStore } from '@/stores/observabilityStore';
import { LoadingPlaceholder } from '@/components/shared/StatusBlocks';
import { ChartErrorBoundary } from '@/components/shared/ChartErrorBoundary';
import type { PickerOption, TabSpec } from './tab-specs';
import {
  CHART_HEIGHT_PX,
  GranularityPicker,
  RangePicker,
  SegmentedPicker,
  computeRangeWindow,
  normalizeRange,
  resolveBucket,
  type GranularityChoice,
  type RangePreset,
} from './chart-primitives';
import { MetricsCountsChart, colorForSeries } from './MetricsCountsChart';
import {
  MetricsDistributionChart,
  type Percentile,
} from './MetricsDistributionChart';

type ViewMode = 'counts' | 'distribution';

const PERCENTILES: ReadonlyArray<Percentile> = ['p50', 'p95', 'p99'];
const DEFAULT_COUNT_VIEW_KEY = 'default';
const EMPTY_COUNT_SERIES: ReadonlyArray<PickerOption<UsageMetricId>> = [];

interface MetricsChartProps {
  spec: TabSpec;
  retentionDays: number;
}

export function MetricsChart({
  spec,
  retentionDays,
}: MetricsChartProps): JSX.Element {
  const hasDistribution = spec.chartDistributionMetrics.length > 0;
  const [mode, setMode] = useState<ViewMode>('counts');
  const [range, setRange] = useState<RangePreset>('7d');
  const [rangeNowMs, setRangeNowMs] = useState(() => Date.now());
  const [granularity, setGranularity] = useState<GranularityChoice>('auto');
  const [visibleSeries, setVisibleSeries] = useState<
    ReadonlySet<UsageMetricId>
  >(() => new Set(spec.chartCountDefaultVisible));
  const [visiblePercentiles, setVisiblePercentiles] = useState<
    ReadonlySet<Percentile>
  >(() => new Set(PERCENTILES));
  const [countViewKey, setCountViewKey] = useState<string>(
    spec.chartCountViews?.[0]?.key ?? DEFAULT_COUNT_VIEW_KEY,
  );
  const [distributionMetric, setDistributionMetric] = useState<
    UsageMetricId | undefined
  >(spec.chartDistributionMetrics[0]?.value ?? spec.chartCountSeries[0]?.value);

  const countViews = useMemo(
    () =>
      spec.chartCountViews ?? [
        {
          key: DEFAULT_COUNT_VIEW_KEY,
          label: 'Counts',
          description: 'Counts per bucket. Toggle series in the legend.',
          series: spec.chartCountSeries,
          defaultVisible: spec.chartCountDefaultVisible,
        },
      ],
    [spec],
  );
  const countView =
    countViews.find((view) => view.key === countViewKey) ?? countViews[0];

  const normalizedRange = normalizeRange(range, retentionDays);
  const rangeWindow = useMemo(
    () => computeRangeWindow(normalizedRange, retentionDays, rangeNowMs),
    [normalizedRange, rangeNowMs, retentionDays],
  );
  const bucket = useMemo(
    () => resolveBucket(granularity, rangeWindow),
    [granularity, rangeWindow],
  );

  const loadUsageTimeseries = useObservabilityStore(
    (s) => s.loadUsageTimeseries,
  );
  const loadUsageMetricsView = useObservabilityStore(
    (s) => s.loadUsageMetricsView,
  );
  const [countsBuckets, setCountsBuckets] = useState<
    UsageCountsTimeseriesBucket[] | null
  >(null);
  const [dynamicCountSeries, setDynamicCountSeries] = useState<ReadonlyArray<
    PickerOption<UsageMetricId>
  > | null>(null);
  const [distBuckets, setDistBuckets] = useState<
    UsageDistributionTimeseriesBucket[] | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  // Reset when changing tabs (spec.id changes).
  useEffect(() => {
    setMode('counts');
    const nextCountView = spec.chartCountViews?.[0];
    setCountViewKey(nextCountView?.key ?? DEFAULT_COUNT_VIEW_KEY);
    setVisibleSeries(
      new Set(nextCountView?.defaultVisible ?? spec.chartCountDefaultVisible),
    );
    setDynamicCountSeries(null);
    setDistributionMetric(
      spec.chartDistributionMetrics[0]?.value ??
        spec.chartCountSeries[0]?.value,
    );
  }, [spec]);

  useEffect(() => {
    let cancelled = false;

    if (!countView.dynamicSeries) {
      setDynamicCountSeries(null);
      setVisibleSeries(new Set(countView.defaultVisible));
      setError(null);
      return (): void => {
        cancelled = true;
      };
    }

    setDynamicCountSeries(null);
    setVisibleSeries(new Set());
    setError(null);
    loadUsageMetricsView({
      tab: spec.id,
      metric: countView.dynamicSeries.metric,
      groupBy: countView.dynamicSeries.groupBy,
      window: {
        kind: 'custom',
        start: rangeWindow.startDate,
        end: rangeWindow.endDate,
      },
    })
      .then((response) => {
        if (cancelled) return;
        const series = response.rows.map((row) => ({
          value: `${countView.dynamicSeries?.metricPrefix ?? ''}${
            row.key
          }` as UsageMetricId,
          label: row.label,
        }));
        setDynamicCountSeries(series);
        setVisibleSeries(new Set(series.map((option) => option.value)));
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setDynamicCountSeries([]);
        setVisibleSeries(new Set());
        setError(
          reason instanceof Error
            ? reason.message
            : 'Failed to load chart series',
        );
      });

    return (): void => {
      cancelled = true;
    };
  }, [
    countView,
    loadUsageMetricsView,
    rangeWindow.endDate,
    rangeWindow.startDate,
    spec.id,
  ]);

  const countSeries = useMemo<ReadonlyArray<PickerOption<UsageMetricId>>>(
    () =>
      countView.dynamicSeries
        ? (dynamicCountSeries ?? EMPTY_COUNT_SERIES)
        : countView.series,
    [countView.dynamicSeries, countView.series, dynamicCountSeries],
  );

  // Load data when relevant inputs change.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    if (mode === 'counts') {
      setCountsBuckets(null);
      if (countView.dynamicSeries && dynamicCountSeries === null) {
        return (): void => {
          cancelled = true;
        };
      }
      loadUsageTimeseries({
        startDate: rangeWindow.startDate,
        endDate: rangeWindow.endDate,
        bucket,
        dataset: {
          kind: 'tab-counts',
          tab: spec.id,
          series: countSeries.map((opt) => opt.value),
        },
      })
        .then((response) => {
          if (cancelled) return;
          setCountsBuckets(
            response.kind === 'tab-counts' ? response.buckets : [],
          );
        })
        .catch((reason: unknown) => {
          if (cancelled) return;
          setCountsBuckets([]);
          setError(
            reason instanceof Error ? reason.message : 'Failed to load chart',
          );
        });
    } else if (distributionMetric) {
      setDistBuckets(null);
      loadUsageTimeseries({
        startDate: rangeWindow.startDate,
        endDate: rangeWindow.endDate,
        bucket,
        dataset: {
          kind: 'tab-distribution',
          tab: spec.id,
          metric: distributionMetric,
        },
      })
        .then((response) => {
          if (cancelled) return;
          setDistBuckets(
            response.kind === 'tab-distribution' ? response.buckets : [],
          );
        })
        .catch((reason: unknown) => {
          if (cancelled) return;
          setDistBuckets([]);
          setError(
            reason instanceof Error ? reason.message : 'Failed to load chart',
          );
        });
    } else {
      setDistBuckets([]);
    }
    return (): void => {
      cancelled = true;
    };
  }, [
    mode,
    spec.id,
    countSeries,
    countView.dynamicSeries,
    dynamicCountSeries,
    distributionMetric,
    rangeWindow.startDate,
    rangeWindow.endDate,
    bucket,
    loadUsageTimeseries,
  ]);

  const toggleSeries = (id: UsageMetricId): void => {
    setVisibleSeries((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const togglePercentile = (p: Percentile): void => {
    setVisiblePercentiles((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  };

  const handleRangeChange = (nextRange: RangePreset): void => {
    setRange(nextRange);
    setRangeNowMs(Date.now());
  };

  const empty =
    (mode === 'counts' &&
      countsBuckets !== null &&
      countsBuckets.every((b) =>
        Object.values(b.series).every((v) => (v ?? 0) === 0),
      )) ||
    (mode === 'distribution' &&
      distBuckets !== null &&
      distBuckets.every((b) => b.sampleCount === 0));

  return (
    <div
      className="rounded-lg border bg-card p-4 flex flex-col gap-3"
      data-testid={`usage-chart-${spec.id}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-s font-semibold fg-primary">{spec.title}</h2>
          <p className="text-xs fg-secondary">
            {mode === 'counts'
              ? countView.description
              : 'Distribution percentiles per bucket.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RangePicker
            value={normalizedRange}
            retentionDays={retentionDays}
            onChange={handleRangeChange}
          />
          <GranularityPicker value={granularity} onChange={setGranularity} />
          {mode === 'counts' && countViews.length > 1 && (
            <SegmentedPicker
              value={countView.key}
              testIdPrefix={`usage-chart-count-view-${spec.id}`}
              options={countViews.map((view) => ({
                key: view.key,
                label: view.label,
              }))}
              onChange={setCountViewKey}
            />
          )}
          {hasDistribution && (
            <SegmentedPicker
              value={mode}
              testIdPrefix={`usage-chart-mode-${spec.id}`}
              options={[
                { key: 'counts', label: 'Counts' },
                { key: 'distribution', label: 'Distribution' },
              ]}
              onChange={setMode}
            />
          )}
        </div>
      </div>

      {error ? (
        <div
          className="flex items-center justify-center rounded border border-line-destructive/30 bg-destructive/5 px-4 text-xs fg-destructive"
          style={{ height: CHART_HEIGHT_PX }}
        >
          {error}
        </div>
      ) : (mode === 'counts' ? countsBuckets : distBuckets) === null ? (
        <LoadingPlaceholder space="fill" style={{ height: CHART_HEIGHT_PX }} />
      ) : empty ? (
        <div
          className="flex items-center justify-center rounded border border-dashed px-4 text-xs fg-secondary"
          style={{ height: CHART_HEIGHT_PX }}
        >
          No activity recorded in this window.
        </div>
      ) : mode === 'counts' ? (
        <ChartErrorBoundary
          label={`${spec.title} counts chart`}
          minHeight={CHART_HEIGHT_PX}
        >
          <MetricsCountsChart
            buckets={countsBuckets ?? []}
            visibleSeries={visibleSeries}
            seriesOptions={countSeries}
            bucket={bucket}
            valueFormat={spec.valueFormat ?? 'number'}
          />
        </ChartErrorBoundary>
      ) : (
        <ChartErrorBoundary
          label={`${spec.title} distribution chart`}
          minHeight={CHART_HEIGHT_PX}
        >
          <MetricsDistributionChart
            buckets={distBuckets ?? []}
            visiblePercentiles={visiblePercentiles}
            bucket={bucket}
          />
        </ChartErrorBoundary>
      )}

      {mode === 'counts' ? (
        <ul className="flex flex-wrap items-center justify-center gap-2 pt-1 text-2xs fg-secondary">
          {countSeries.map((opt) => {
            const hidden = !visibleSeries.has(opt.value);
            return (
              <li key={opt.value}>
                <button
                  type="button"
                  onClick={() => toggleSeries(opt.value)}
                  aria-pressed={!hidden}
                  data-testid={`usage-chart-legend-${spec.id}-${opt.value}`}
                  className={`inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 transition-colors focus-ring hover:bg-secondary ${
                    hidden ? 'opacity-40' : ''
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className="inline-block h-2 w-2 rounded-sm"
                    style={{ backgroundColor: colorForSeries(opt.value) }}
                  />
                  <span>{opt.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <div className="flex items-center gap-2 text-2xs fg-secondary">
            <span>Metric:</span>
            <select
              value={distributionMetric ?? ''}
              onChange={(event): void => {
                const next = spec.chartDistributionMetrics.find(
                  (m) => m.value === event.target.value,
                );
                if (next) setDistributionMetric(next.value);
              }}
              data-testid={`usage-chart-distribution-metric-${spec.id}`}
              className="rounded border bg-base px-1 py-0.5 fg-primary"
            >
              {spec.chartDistributionMetrics.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <ul className="flex flex-wrap items-center gap-2 text-2xs fg-secondary">
            {PERCENTILES.map((p) => {
              const hidden = !visiblePercentiles.has(p);
              return (
                <li key={p}>
                  <button
                    type="button"
                    onClick={() => togglePercentile(p)}
                    aria-pressed={!hidden}
                    data-testid={`usage-chart-percentile-${spec.id}-${p}`}
                    className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors focus-ring hover:bg-secondary ${
                      hidden ? 'opacity-40' : ''
                    }`}
                  >
                    <span>{p}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
