/**
 * Provider reset times arrive as epoch seconds or milliseconds. Normalizes to
 * milliseconds, treating non-finite and non-positive values as missing.
 */
export function normalizeEpochMs(value: number): number | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value < 1e10 ? value * 1000 : value;
}
