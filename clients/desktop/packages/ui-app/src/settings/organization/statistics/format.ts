// Pure formatting + chart-spec helpers for the team usage & cost dashboard.
//
// The money formatters (`formatUsd`/`compactNumber`) now live in
// `@canopy/ui-shared/lib` and are re-exported below so existing callers keep
// importing them from this path; the remaining chart-spec helpers stay
// web-local. Everything here is dependency-free and unit-tested so the
// node-environment jest harness can exercise it without a DOM.

import type {
  TelemetryCardUnit,
  TelemetryCostBucket,
  TelemetryImpactBucket,
  TelemetryTimeGranularity,
  TelemetryTokenBucket,
} from '@canopy/protocol/telemetry';
// `formatUsd` and its `compactNumber` dependency now live in
// `@canopy/ui-shared/lib` so the shared responsive billing tables can own their
// money formatting. Re-exported below so existing callers of this module (and
// its unit tests) keep importing from the same path.
import { compactNumber, formatUsd } from '@canopy/ui-shared/lib';

export { compactNumber, formatUsd };

/** Ordered palette assigned to chart series by index (wraps if exceeded). */
export const SERIES_PALETTE: readonly string[] = [
  '#6366f1', // indigo
  '#22c55e', // green
  '#f59e0b', // amber
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#a855f7', // purple
  '#ef4444', // red
  '#14b8a6', // teal
  '#eab308', // yellow
  '#3b82f6', // blue
];

/** Stable color for a series key, by its position in the ordered key list. */
export function seriesColor(index: number): string {
  return SERIES_PALETTE[index % SERIES_PALETTE.length];
}

/** Format a raw token count compactly (e.g. `1.2K`, `3.4M`). */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) {
    return '0';
  }
  return compactNumber(value, 1);
}

/** Format an integer count with grouped thousands. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) {
    return '0';
  }
  return Math.round(value).toLocaleString('en-US');
}

/**
 * Format a per-unit rate (e.g. turns per delivered unit) to one decimal place.
 * Non-finite values render as `0`, matching the other count formatters.
 */
export function formatRate(value: number): string {
  if (!Number.isFinite(value)) {
    return '0';
  }
  return value.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

/**
 * Format a millisecond duration as a compact human label (`0s`, `45s`,
 * `3m 20s`, `2h 5m`). Non-finite or non-positive values render as `0s`.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return '0s';
  }
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${totalSeconds % 60}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * Format `numerator / denominator` as a whole-percent string (e.g. `75%`).
 * Returns `'—'` when the denominator is zero or either input is non-finite,
 * so callers never divide by zero.
 */
export function formatPercent(numerator: number, denominator: number): string {
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator === 0
  ) {
    return '—';
  }
  return `${Math.round((numerator / denominator) * 100)}%`;
}

/** Format a headline-card value according to its declared unit. */
export function formatCardValue(
  value: number,
  unit: TelemetryCardUnit,
): string {
  switch (unit) {
    case 'currency':
      return formatUsd(value);
    case 'tokens':
      return formatTokens(value);
    case 'count':
      return formatCount(value);
    default:
      return formatCount(value);
  }
}

/** Direction of a period-over-period change. */
export type TrendDirection = 'up' | 'down' | 'flat';

export interface TrendResult {
  /** Signed percentage change vs. the prior window; null when not computable. */
  deltaPct: number | null;
  direction: TrendDirection;
  /** Human-friendly label such as `+12.5%`, `-4.0%`, or `—`. */
  label: string;
}

/**
 * Compute a period-over-period trend. Returns a null delta (and `—` label) when
 * there is no comparison value, or when the prior window was zero and so a
 * percentage is undefined.
 */
export function computeTrend(
  current: number,
  previous: number | null,
): TrendResult {
  if (previous === null || !Number.isFinite(previous)) {
    return { deltaPct: null, direction: 'flat', label: '—' };
  }
  if (previous === 0) {
    if (current === 0) {
      return { deltaPct: 0, direction: 'flat', label: '0%' };
    }
    // No prior baseline to divide by, so a percentage is undefined. Surface a
    // "New" chip (rather than nothing) so cost tiles stay visually consistent.
    return { deltaPct: null, direction: 'up', label: 'New' };
  }
  const deltaPct = ((current - previous) / Math.abs(previous)) * 100;
  const direction: TrendDirection =
    deltaPct > 0.05 ? 'up' : deltaPct < -0.05 ? 'down' : 'flat';
  const sign = deltaPct > 0 ? '+' : '';
  return { deltaPct, direction, label: `${sign}${deltaPct.toFixed(1)}%` };
}

/** A pivoted time-series ready for a stacked Recharts bar chart. */
export interface PivotedSeries {
  /** One row per bucket; `bucket` is the ISO start, keys are series totals. */
  rows: Array<Record<string, number | string>>;
  /** Distinct series keys (providers or models) in first-seen order. */
  keys: string[];
}

/** Range/granularity used to synthesize a gap-filled bucket grid. */
export interface BucketGrid {
  startIso: string;
  endIso: string;
  granularity: TelemetryTimeGranularity;
}

/** Exact UTC step size (ms) for each supported granularity. */
const STEP_MS_BY_GRANULARITY: Record<TelemetryTimeGranularity, number> = {
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
};

/**
 * Reproduce the set of bucket starts the DB `date_trunc` rollup would have
 * returned across `[startIso, endIso)` if every bucket had data. The grid is
 * phased off `anchorIso` (a real, DB-aligned bucket instant) rather than
 * guessing the DB's timezone/week-start, then walked in exact UTC step
 * multiples. This matches the rollup while the DB session timezone is UTC; a
 * DST-observing session timezone would need timezone-aware stepping here. The
 * largest anchor-aligned instant `<= startMs` is the first grid point, so the
 * partial leading bucket containing `startMs` is included.
 */
export function expectedBucketStarts(
  grid: BucketGrid,
  anchorIso: string,
): string[] {
  const step = STEP_MS_BY_GRANULARITY[grid.granularity];
  const startMs = new Date(grid.startIso).getTime();
  const endMs = new Date(grid.endIso).getTime();
  const anchorMs = new Date(anchorIso).getTime();
  if (
    !Number.isFinite(step) ||
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    !Number.isFinite(anchorMs)
  ) {
    return [];
  }
  // Double-mod normalizes negative remainders when anchorMs is after startMs.
  const offset = (((startMs - anchorMs) % step) + step) % step;
  const first = startMs - offset;
  const starts: string[] = [];
  for (let ms = first; ms < endMs; ms += step) {
    starts.push(new Date(ms).toISOString());
  }
  return starts;
}

/**
 * Pivot a flat list of `{ bucketStartIso, key, ...metrics }` records into rows
 * keyed by bucket with one numeric column per series key. `valueOf` projects
 * each record to its scalar contribution.
 *
 * When `grid` is provided and `buckets` is non-empty, missing buckets across
 * the range are synthesized as zero-filled rows so the chart renders one slot
 * per expected bucket (a single active day shows a normal-width bar instead of
 * stretching across the whole chart). When omitted, behavior is unchanged.
 */
export function pivotBuckets<T extends { bucketStartIso: string; key: string }>(
  buckets: readonly T[],
  valueOf: (bucket: T) => number,
  grid?: BucketGrid,
): PivotedSeries {
  const rowByBucket = new Map<string, Record<string, number | string>>();
  const keys: string[] = [];
  const orderedBuckets: string[] = [];

  for (const bucket of buckets) {
    if (!keys.includes(bucket.key)) {
      keys.push(bucket.key);
    }
    let row = rowByBucket.get(bucket.bucketStartIso);
    if (!row) {
      row = { bucket: bucket.bucketStartIso };
      rowByBucket.set(bucket.bucketStartIso, row);
      orderedBuckets.push(bucket.bucketStartIso);
    }
    const existing = row[bucket.key];
    const prior = typeof existing === 'number' ? existing : 0;
    row[bucket.key] = prior + valueOf(bucket);
  }

  // Fill missing buckets across the range using the earliest real bucket as the
  // DB-aligned phase anchor. Skipped when no real buckets exist (the chart shows
  // its "No data" state, so gap-filling is moot).
  if (grid && orderedBuckets.length > 0) {
    const anchorIso = orderedBuckets[0];
    for (const iso of expectedBucketStarts(grid, anchorIso)) {
      if (!rowByBucket.has(iso)) {
        rowByBucket.set(iso, { bucket: iso });
        orderedBuckets.push(iso);
      }
    }
  }

  // Ensure every row carries a zero for absent keys so stacks render cleanly.
  const rows = orderedBuckets
    .sort((a, b) => a.localeCompare(b))
    .map((bucketStartIso) => {
      const row = rowByBucket.get(bucketStartIso) ?? { bucket: bucketStartIso };
      for (const key of keys) {
        if (typeof row[key] !== 'number') {
          row[key] = 0;
        }
      }
      return row;
    });

  return { rows, keys };
}

/** Total tokens (all categories) for a token bucket. */
export function tokenBucketTotal(bucket: TelemetryTokenBucket): number {
  return (
    bucket.inputTokens +
    bucket.outputTokens +
    bucket.cacheReadInputTokens +
    bucket.cacheCreationInputTokens
  );
}

/** Cost contribution for a cost bucket. */
export function costBucketTotal(bucket: TelemetryCostBucket): number {
  return bucket.totalCostUsd;
}

/** Impact contribution for an impact bucket. */
export function impactBucketTotal(bucket: TelemetryImpactBucket): number {
  return bucket.impactScore;
}

/** Format an impact value compactly, keeping one decimal for small scores. */
export function formatImpact(value: number): string {
  return Number.isFinite(value) ? compactNumber(value, 1) : '0';
}

/**
 * Format a bucket ISO timestamp for an axis tick, varying detail by
 * granularity (hour shows time, day/week show a short date).
 *
 * Labels are rendered in UTC to match the UTC-bucketed rollup (the server
 * truncates to UTC midnight and the client gap-fill walks UTC step multiples).
 * Without `timeZone: 'UTC'`, a UTC-midnight instant like
 * `2026-07-02T00:00:00.000Z` is reinterpreted in the viewer's local zone and
 * drifts a day back for anyone west of UTC (e.g. US Pacific renders "Jul 1").
 */
export function formatBucketTick(
  iso: string,
  granularity: 'hour' | 'day' | 'week',
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  if (granularity === 'hour') {
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      timeZone: 'UTC',
    });
  }
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
