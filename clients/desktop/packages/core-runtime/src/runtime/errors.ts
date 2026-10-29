import {
  CanopyErrorPayloadSchema,
  type CanopyErrorKind,
  type CanopyErrorPayload,
  type CanopyRetryDirective,
} from '@canopy/protocol/canopy-core';

const NEVER_RETRY = { kind: 'never' } as const;
const SAME_REQUEST_RETRY = { kind: 'same_request' } as const;

export class CanopyOperationError extends Error {
  public readonly payload: CanopyErrorPayload;
  public readonly runtimeCause: unknown;

  public constructor(payload: CanopyErrorPayload, runtimeCause?: unknown) {
    const validatedPayload = CanopyErrorPayloadSchema.parse(payload);
    super(validatedPayload.message);
    this.name = 'CanopyOperationError';
    this.payload = validatedPayload;
    Object.defineProperty(this, 'runtimeCause', {
      configurable: false,
      enumerable: false,
      writable: false,
      value: runtimeCause,
    });
  }

  public toJSON(): CanopyErrorPayload {
    return this.payload;
  }
}

function operationError(
  kind: CanopyErrorKind,
  message: string,
  retry: CanopyRetryDirective,
  runtimeCause?: unknown,
): CanopyOperationError {
  return new CanopyOperationError(
    { kind, message: message.slice(0, 4_096), retry },
    runtimeCause,
  );
}

export function canopyInvalidArgumentError(
  message: string,
  runtimeCause?: unknown,
): CanopyOperationError {
  return operationError('invalid_argument', message, NEVER_RETRY, runtimeCause);
}

export function canopyUnauthenticatedError(
  message = 'Caller authentication is invalid.',
  runtimeCause?: unknown,
): CanopyOperationError {
  return operationError('unauthenticated', message, NEVER_RETRY, runtimeCause);
}

export function canopyPermissionDeniedError(
  message = 'The caller is not permitted to perform this operation.',
  runtimeCause?: unknown,
): CanopyOperationError {
  return operationError(
    'permission_denied',
    message,
    NEVER_RETRY,
    runtimeCause,
  );
}

export function canopyDeadlineExceededError(
  message = 'The operation deadline was exceeded.',
  retry: CanopyRetryDirective = SAME_REQUEST_RETRY,
): CanopyOperationError {
  return operationError('deadline_exceeded', message, retry);
}

export function canopyCancelledError(
  message = 'The operation was cancelled.',
): CanopyOperationError {
  return operationError('cancelled', message, NEVER_RETRY);
}

export function canopyUnavailableError(
  message = 'The runtime is unavailable.',
  retry: CanopyRetryDirective = SAME_REQUEST_RETRY,
): CanopyOperationError {
  return operationError('unavailable', message, retry);
}

export function canopyStreamBufferExhaustedError(): CanopyOperationError {
  return operationError(
    'resource_exhausted',
    'Stream buffer capacity exceeded.',
    { kind: 'after_refresh', resource: 'stream' },
  );
}

export function canopyCapabilityUnavailableError(
  message = 'The requested operation is unavailable.',
): CanopyOperationError {
  return operationError('capability_unavailable', message, NEVER_RETRY);
}

export function canopyInvalidHandlerResultError(): CanopyOperationError {
  return operationError(
    'internal',
    'The operation returned an invalid result.',
    NEVER_RETRY,
  );
}

export function canopyInternalError(
  message = 'The operation failed.',
  runtimeCause?: unknown,
): CanopyOperationError {
  return operationError('internal', message, NEVER_RETRY, runtimeCause);
}
