// A transfer size per docs/ux-writing.md "Numbers and Time": no space before
// an abbreviated unit, case-sensitive byte units.

const BYTE_UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

export function formatTransferBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${Math.max(0, Math.round(bytes))}B`;
  }
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded}${BYTE_UNITS[unit] ?? 'TB'}`;
}
