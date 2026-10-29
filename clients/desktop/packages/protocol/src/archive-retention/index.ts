export const MIN_ARCHIVE_RETENTION_DAYS = 1;
export const DEFAULT_ARCHIVE_RETENTION_DAYS = 7;
export const MAX_ARCHIVE_RETENTION_DAYS = 36_500;
export type RetainedItemState = 'archived' | 'deleted';

export function isArchiveRetentionDays(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_ARCHIVE_RETENTION_DAYS &&
    value <= MAX_ARCHIVE_RETENTION_DAYS
  );
}
export function normalizeArchiveRetentionDays(
  value: number | null | undefined,
): number {
  return isArchiveRetentionDays(value) ? value : DEFAULT_ARCHIVE_RETENTION_DAYS;
}
export function computeRetentionExpiryMs(nowMs: number, days: number): number {
  return nowMs + normalizeArchiveRetentionDays(days) * 86_400_000;
}
export function retainedItemStateOf(
  expiresAtMs: number | null,
): RetainedItemState {
  return expiresAtMs === null ? 'archived' : 'deleted';
}
export function isRetainedItemExpired(
  expiresAtMs: number | null,
  nowMs: number,
): boolean {
  return (
    expiresAtMs !== null && Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs
  );
}
