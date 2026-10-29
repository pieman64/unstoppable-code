export function clampLimit(
  limit: number | undefined,
  defaultValue: number,
  maxValue: number,
): number {
  if (limit === undefined || !Number.isFinite(limit)) return defaultValue;
  return Math.max(1, Math.min(maxValue, Math.floor(limit)));
}
