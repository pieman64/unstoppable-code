import { z } from 'zod';

import {
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
  CanopyRetryDirectiveSchema,
  type CanopyErrorPayload,
} from '../errors';
import type { CanopyOperationCode } from '../names';
export { CanopyWorkspaceScopeSchema } from '../common';
export {
  defineCanopyQuery,
  defineCanopyQueryRegistry,
  defineCanopyStream,
  defineCanopyStreamRegistry,
  CanopyStreamCursorSchema,
  CanopyStreamEndSchema,
} from '../definitions';
export {
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
  CanopyJsonValueSchema,
} from '../errors';

const KeyedRetryDirectiveSchema = z.discriminatedUnion('kind', [
  CanopyRetryDirectiveSchema.options[0],
  CanopyRetryDirectiveSchema.options[2],
  CanopyRetryDirectiveSchema.options[3],
]);

/** Error payload for inherent operations: `same_request` is the only replay. */
export function inherentOperationErrorSchema<
  const Codes extends readonly [CanopyOperationCode, ...CanopyOperationCode[]],
>(codes: Codes): z.ZodType<CanopyErrorPayload> {
  return CanopyErrorPayloadSchema.extend({
    code: z.enum(codes).optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  });
}

/** Error payload for keyed operations: `same_idempotency_key` is the only replay. */
export function keyedOperationErrorSchema<
  const Codes extends readonly [CanopyOperationCode, ...CanopyOperationCode[]],
>(codes: Codes): z.ZodType<CanopyErrorPayload> {
  return CanopyErrorPayloadSchema.extend({
    code: z.enum(codes).optional(),
    retry: KeyedRetryDirectiveSchema,
  });
}
