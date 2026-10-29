import {
  CanopyErrorPayloadSchema,
  decodeCanopyError,
  type CanopyErrorPayload,
} from '@canopy/protocol/canopy-core';

export const CANOPY_CLIENT_PROTOCOL_VERSIONS = [1] as const;

/** Payload message limit enforced by `CanopyErrorPayloadSchema`. */
export const MAX_ERROR_MESSAGE_LENGTH = 4_096;

export class CanopyClientError extends Error {
  public readonly payload: CanopyErrorPayload;

  public constructor(payload: CanopyErrorPayload) {
    const validated = CanopyErrorPayloadSchema.parse(payload);
    super(validated.message);
    this.name = 'CanopyClientError';
    this.payload = validated;
  }

  public toJSON(): CanopyErrorPayload {
    return this.payload;
  }
}

function internalError(message: string): CanopyClientError {
  return new CanopyClientError({
    kind: 'internal',
    message:
      message.slice(0, MAX_ERROR_MESSAGE_LENGTH) || 'Canopy client failure.',
    retry: { kind: 'never' },
  });
}

function typedPayload(error: unknown): CanopyErrorPayload | null {
  if (typeof error !== 'object' || error === null || !('payload' in error))
    return null;
  const parsed = CanopyErrorPayloadSchema.safeParse(error.payload);
  return parsed.success ? parsed.data : null;
}

/** Normalizes any thrown value; only schema-valid payloads keep their taxonomy. */
export function toCanopyClientError(error: unknown): CanopyClientError {
  if (error instanceof CanopyClientError) return error;
  const payload = typedPayload(error);
  if (payload) return new CanopyClientError(payload);
  if (error instanceof Error && error.name === 'AbortError')
    return new CanopyClientError({
      kind: 'cancelled',
      message:
        error.message.slice(0, MAX_ERROR_MESSAGE_LENGTH) ||
        'The operation was cancelled.',
      retry: { kind: 'never' },
    });
  return internalError(error instanceof Error ? error.message : '');
}

/** Decodes a JSON-RPC `error` object; a malformed one fails closed as `internal`. */
export function decodeCanopyClientResponseError(
  error: unknown,
): CanopyClientError {
  return new CanopyClientError(decodeCanopyError(error));
}
