/**
 * Formatting helpers shared by the resource diagnostics UI.
 *
 * `formatMemoryBytes` produces adaptive labels for detailed resource rows:
 * 0-1023 B as bytes, then KB / MB / GB with one decimal.
 *
 * `formatCpuPercent` rounds a fractional CPU percent to a whole-number string
 * (negative or NaN values clamp to "0"; values above 100 clamp to "100").
 */
export function formatMemoryBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  if (unitIndex === 0) {
    return `${Math.round(value)} ${units[unitIndex]}`;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export function formatCpuPercent(percent: number): string {
  if (!Number.isFinite(percent) || percent < 0) return '0';
  return String(Math.min(100, Math.round(percent)));
}

/** A memory report's size and save time, such as "612.4 MB, saved Oct 26, 2026, 1:47 PM". */
export function describeMemoryReport(report: {
  readonly totalBytes: number;
  readonly createdAt: string;
}): string {
  const size = formatMemoryBytes(report.totalBytes);
  const date = new Date(report.createdAt);
  if (!Number.isFinite(date.getTime())) return size;
  return `${size}, saved ${date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })}`;
}
