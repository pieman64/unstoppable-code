export interface FormatByteSizeOptions {
  /**
   * `fixed` (default) keeps one decimal above bytes and caps at gigabytes
   * (`1.0 KB`, `3.4 MB`). `adaptive` keeps one decimal only below 10, drops a
   * trailing `.0`, and reaches terabytes for disk totals (`1 KB`, `1.5 KB`,
   * `11 KB`, `2.3 GB`).
   */
  readonly precision?: 'fixed' | 'adaptive';
}

const ADAPTIVE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** Compact binary byte size for display. Invalid or negative input is `0 B`. */
export function formatByteSize(
  bytes: number,
  options: FormatByteSizeOptions = {},
): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (options.precision === 'adaptive') return formatAdaptive(bytes);
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatAdaptive(bytes: number): string {
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < ADAPTIVE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const unit = ADAPTIVE_UNITS[unitIndex];
  if (unitIndex === 0) return `${Math.round(value)} ${unit}`;
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${rounded} ${unit}`;
}
