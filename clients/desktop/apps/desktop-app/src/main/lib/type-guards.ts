/**
 * Type guard that checks if a value is a plain object (not null, not an array).
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isErrnoException(
  error: unknown,
): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}
