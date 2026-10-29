import { type JSX } from 'react';

export type RangePreset = '24h' | '7d' | 'max';
export type GranularityChoice = 'auto' | 'hour' | 'day' | 'week';

const RANGE_HOUR_MS = 60 * 60 * 1000;
const MAX_RANGE_DAYS = 30;

export interface RangeWindow {
  startDate: string;
  endDate: string;
  hours: number;
}

export interface SegmentedPickerOption<T extends string> {
  key: T;
  label: string;
}

export interface SegmentedPickerProps<T extends string> {
  value: T;
  options: ReadonlyArray<SegmentedPickerOption<T>>;
  testIdPrefix: string;
  onChange: (value: T) => void;
}

export function SegmentedPicker<T extends string>({
  value,
  options,
  testIdPrefix,
  onChange,
}: SegmentedPickerProps<T>): JSX.Element {
  return (
    <div className="inline-flex items-center rounded-md border bg-base p-0.5 text-xs">
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          onClick={() => onChange(option.key)}
          data-testid={`${testIdPrefix}-${option.key}`}
          className={`px-2 py-1 rounded-sm transition-colors ${
            value === option.key
              ? 'bg-accent-subtle fg-accent'
              : 'fg-secondary hover:fg-primary'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function retentionCapDays(retentionDays: number): number {
  return Math.max(1, Math.min(MAX_RANGE_DAYS, Math.floor(retentionDays)));
}

export function getRangeOptions(
  retentionDays: number,
): SegmentedPickerOption<RangePreset>[] {
  const capDays = retentionCapDays(retentionDays);
  const options: SegmentedPickerOption<RangePreset>[] = [
    { key: '24h', label: '24h' },
  ];
  if (capDays >= 7) options.push({ key: '7d', label: '7d' });
  if (capDays > 7 || (capDays > 1 && capDays < 7)) {
    options.push({ key: 'max', label: `${capDays}d` });
  }
  return options;
}

export function normalizeRange(
  preset: RangePreset,
  retentionDays: number,
): RangePreset {
  const options = getRangeOptions(retentionDays);
  if (options.some((option) => option.key === preset)) return preset;
  return options[options.length - 1]?.key ?? '24h';
}

export function computeRangeWindow(
  preset: RangePreset,
  retentionDays: number,
  nowMs: number = Date.now(),
): RangeWindow {
  const end = nowMs;
  const capHours = retentionCapDays(retentionDays) * 24;
  let hours: number;
  switch (preset) {
    case '24h':
      hours = Math.min(24, capHours);
      break;
    case '7d':
      hours = Math.min(24 * 7, capHours);
      break;
    case 'max':
      hours = capHours;
      break;
  }
  const start = end - hours * RANGE_HOUR_MS;
  return {
    startDate: new Date(start).toISOString(),
    endDate: new Date(end).toISOString(),
    hours,
  };
}

export const GRANULARITY_OPTIONS: SegmentedPickerOption<GranularityChoice>[] = [
  { key: 'auto', label: 'Auto' },
  { key: 'hour', label: 'Hour' },
  { key: 'day', label: 'Day' },
  { key: 'week', label: 'Week' },
];

export function resolveBucket(
  granularity: GranularityChoice,
  rangeWindow: RangeWindow,
): 'hour' | 'day' | 'week' {
  if (granularity !== 'auto') return granularity;
  if (rangeWindow.hours <= 24) return 'hour';
  if (rangeWindow.hours <= 24 * 7) return 'day';
  return 'week';
}

export function formatBucketLabel(
  bucketStart: string,
  bucket: 'hour' | 'day' | 'week',
): string {
  const ms = Date.parse(bucketStart);
  if (!Number.isFinite(ms)) return bucketStart;
  const date = new Date(ms);
  switch (bucket) {
    case 'hour':
      return date.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
      });
    case 'day':
    case 'week':
      return date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      });
  }
}

export function formatTokenCount(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(abs / 1_000).toFixed(1)}k`;
  return String(abs);
}

export function formatCompactNumber(value: number): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}k`;
  return `${sign}${abs}`;
}

export const CHART_HEIGHT_PX = 280;

export interface RangePickerProps {
  value: RangePreset;
  retentionDays: number;
  onChange: (value: RangePreset) => void;
}

export function RangePicker({
  value,
  retentionDays,
  onChange,
}: RangePickerProps): JSX.Element {
  return (
    <SegmentedPicker
      value={value}
      options={getRangeOptions(retentionDays)}
      testIdPrefix="overview-range"
      onChange={onChange}
    />
  );
}

export interface GranularityPickerProps {
  value: GranularityChoice;
  onChange: (value: GranularityChoice) => void;
}

export function GranularityPicker({
  value,
  onChange,
}: GranularityPickerProps): JSX.Element {
  return (
    <SegmentedPicker
      value={value}
      options={GRANULARITY_OPTIONS}
      testIdPrefix="overview-granularity"
      onChange={onChange}
    />
  );
}
