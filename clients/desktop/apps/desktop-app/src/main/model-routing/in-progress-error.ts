const DEFAULT_RETRY_AFTER_MS = 1_000;
const MIN_RETRY_AFTER_MS = 250;
const MAX_RETRY_AFTER_MS = 5_000;

export class AutoModelRoutingInProgressError extends Error {
  readonly retryAfterMs: number;
  readonly cause?: unknown;

  constructor(retryAfterMs?: number, cause?: unknown) {
    super('Model routing is still in progress');
    this.name = 'AutoModelRoutingInProgressError';
    const requestedDelay = Number.isFinite(retryAfterMs)
      ? retryAfterMs
      : DEFAULT_RETRY_AFTER_MS;
    this.retryAfterMs = Math.min(
      MAX_RETRY_AFTER_MS,
      Math.max(MIN_RETRY_AFTER_MS, requestedDelay ?? DEFAULT_RETRY_AFTER_MS),
    );
    this.cause = cause;
  }
}

export function isAutoModelRoutingInProgressError(
  error: unknown,
): error is AutoModelRoutingInProgressError {
  return error instanceof AutoModelRoutingInProgressError;
}
