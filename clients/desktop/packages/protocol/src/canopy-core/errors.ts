import { z } from 'zod';

import { CanopyOperationCodeSchema } from './names';

export const CANOPY_ERROR_KINDS = [
  'invalid_argument',
  'unauthenticated',
  'permission_denied',
  'not_found',
  'already_exists',
  'conflict',
  'failed_precondition',
  'capability_unavailable',
  'cancelled',
  'deadline_exceeded',
  'unavailable',
  'resource_exhausted',
  'internal',
] as const;

export const CanopyErrorKindSchema = z.enum(CANOPY_ERROR_KINDS);
export type CanopyErrorKind = z.output<typeof CanopyErrorKindSchema>;

const RETRY_DELAY_SCHEMA = z.number().int().nonnegative().max(86_400_000);

export const CanopyRetryDirectiveSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('never') }),
  z.strictObject({
    kind: z.literal('same_request'),
    delayMs: RETRY_DELAY_SCHEMA.optional(),
  }),
  z.strictObject({
    kind: z.literal('same_idempotency_key'),
    delayMs: RETRY_DELAY_SCHEMA.optional(),
  }),
  z.strictObject({
    kind: z.literal('after_refresh'),
    resource: z.string().min(1).max(512),
    delayMs: RETRY_DELAY_SCHEMA.optional(),
  }),
]);

export const CanopyQueryRetryDirectiveSchema = z.discriminatedUnion('kind', [
  CanopyRetryDirectiveSchema.options[0],
  CanopyRetryDirectiveSchema.options[1],
  CanopyRetryDirectiveSchema.options[3],
]);

// Keyed operations replay only with their idempotency key.
export const CanopyKeyedRetryDirectiveSchema = z.discriminatedUnion('kind', [
  CanopyRetryDirectiveSchema.options[0],
  CanopyRetryDirectiveSchema.options[2],
  CanopyRetryDirectiveSchema.options[3],
]);

export type CanopyRetryDirective = z.output<typeof CanopyRetryDirectiveSchema>;

export type CanopyJsonValue =
  | null
  | boolean
  | number
  | string
  | CanopyJsonValue[]
  | { [key: string]: CanopyJsonValue };

const MAX_DETAILS_DEPTH = 16;
const MAX_DETAILS_COLLECTION_SIZE = 1_000;
const MAX_DETAILS_SERIALIZED_LENGTH = 32_768;

function isJsonValue(
  value: unknown,
  depth: number,
  ancestors: Set<object>,
): value is CanopyJsonValue {
  if (value === null) return true;
  if (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true;
  }
  if (typeof value !== 'object' || depth >= MAX_DETAILS_DEPTH) return false;
  if (ancestors.has(value)) return false;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return (
        value.length <= MAX_DETAILS_COLLECTION_SIZE &&
        value.every((entry) => isJsonValue(entry, depth + 1, ancestors))
      );
    }

    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;

    const keys = Object.getOwnPropertyNames(value);
    const symbolKeys = Object.getOwnPropertySymbols(value);
    if (keys.length > MAX_DETAILS_COLLECTION_SIZE || symbolKeys.length !== 0) {
      return false;
    }

    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !isJsonValue(descriptor.value, depth + 1, ancestors)
      ) {
        return false;
      }
    }
    return true;
  } finally {
    ancestors.delete(value);
  }
}

export function isBoundedCanopyJsonValue(
  value: unknown,
): value is CanopyJsonValue {
  if (!isJsonValue(value, 0, new Set())) return false;
  try {
    return JSON.stringify(value).length <= MAX_DETAILS_SERIALIZED_LENGTH;
  } catch {
    return false;
  }
}

export const CanopyJsonValueSchema = z.custom<CanopyJsonValue>(
  isBoundedCanopyJsonValue,
  'Expected bounded JSON-safe data',
);

export const CanopyErrorPayloadSchema = z.strictObject({
  kind: CanopyErrorKindSchema,
  message: z.string().min(1).max(4_096),
  code: CanopyOperationCodeSchema.optional(),
  details: CanopyJsonValueSchema.optional(),
  retry: CanopyRetryDirectiveSchema,
});

export type CanopyErrorPayload = z.output<typeof CanopyErrorPayloadSchema>;
