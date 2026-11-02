export class AutoModelRoutingApplyError extends Error {
  readonly code = 'auto_model_routing_apply_failed';
  readonly retryable = true;
  // `declare`: only some programs' libs (via type-fest) give Error a `cause`.
  declare readonly cause?: unknown;

  constructor(cause?: unknown) {
    super(
      'The model picked by model routing couldn’t be applied. Try sending the message again.',
    );
    this.name = 'AutoModelRoutingApplyError';
    if (cause !== undefined) this.cause = cause;
  }
}

export function isAutoModelRoutingApplyError(
  error: unknown,
): error is AutoModelRoutingApplyError {
  return error instanceof AutoModelRoutingApplyError;
}
