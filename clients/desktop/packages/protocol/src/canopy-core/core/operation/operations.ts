import { z } from 'zod';

import {
  CanopyStreamEndSchema,
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
  defineCanopyStream,
  defineCanopyStreamRegistry,
} from '../../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../../errors';
import {
  CoreOperationCancelParamsSchema,
  CoreOperationCancelResultSchema,
  CoreOperationEventsItemSchema,
  CoreOperationEventsOpenResultSchema,
  CoreOperationEventsParamsSchema,
  CoreOperationGetParamsSchema,
  CoreOperationGetResultSchema,
  CoreOperationListParamsSchema,
  CoreOperationListResultSchema,
} from './schemas';

export const OPERATION_GRANTS = {
  read: 'core.operation.read',
  cancel: 'core.operation.cancel',
} as const;

/** The snapshot a client refreshes before it reopens events or retries. */
export const OPERATION_SNAPSHOT_RESOURCE = 'core.operation.list';

export const OPERATION_ERROR_REASONS = [
  'NOT_FOUND',
  'REVISION_CONFLICT',
  'INVALID_STATE',
  'SNAPSHOT_REQUIRED',
] as const;
export type OperationErrorReason = (typeof OPERATION_ERROR_REASONS)[number];

export const OPERATION_ERROR_CODES = {
  NOT_FOUND: 'core.operation.notFound',
  REVISION_CONFLICT: 'core.operation.revisionConflict',
  INVALID_STATE: 'core.operation.invalidState',
  SNAPSHOT_REQUIRED: 'core.operation.snapshotRequired',
} as const satisfies Record<OperationErrorReason, string>;

export const OperationErrorDetailsSchema = z.strictObject({
  reason: z.enum(OPERATION_ERROR_REASONS),
  currentRevision: z.number().int().min(1).optional(),
});
export type OperationErrorDetails = z.output<
  typeof OperationErrorDetailsSchema
>;

export const OperationErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z
    .enum([
      OPERATION_ERROR_CODES.NOT_FOUND,
      OPERATION_ERROR_CODES.REVISION_CONFLICT,
      OPERATION_ERROR_CODES.INVALID_STATE,
      OPERATION_ERROR_CODES.SNAPSHOT_REQUIRED,
    ])
    .optional(),
  details: OperationErrorDetailsSchema.optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});

export const CoreOperationEventsEndSchema = CanopyStreamEndSchema.extend({
  error: OperationErrorSchema.nullable(),
});

export const OPERATION_QUERY_DEFINITIONS = defineCanopyQueryRegistry('core', {
  'core.operation.get': defineCanopyQuery({
    plane: 'core',
    domain: 'operation',
    version: 1,
    placement: 'core-only',
    params: CoreOperationGetParamsSchema,
    result: CoreOperationGetResultSchema,
    error: OperationErrorSchema,
    idempotency: 'inherent',
    requiredGrants: [OPERATION_GRANTS.read],
  }),
  'core.operation.list': defineCanopyQuery({
    plane: 'core',
    domain: 'operation',
    version: 1,
    placement: 'core-only',
    params: CoreOperationListParamsSchema,
    result: CoreOperationListResultSchema,
    error: OperationErrorSchema,
    idempotency: 'inherent',
    requiredGrants: [OPERATION_GRANTS.read],
  }),
});

export const OPERATION_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.operation.cancel': defineCanopyInstruction({
      plane: 'core',
      domain: 'operation',
      version: 1,
      placement: 'core-only',
      params: CoreOperationCancelParamsSchema,
      result: CoreOperationCancelResultSchema,
      error: OperationErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [OPERATION_GRANTS.cancel],
    }),
  });

export const OPERATION_STREAM_DEFINITIONS = defineCanopyStreamRegistry('core', {
  'core.operation.events': defineCanopyStream({
    plane: 'core',
    domain: 'operation',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: [OPERATION_GRANTS.read],
    params: CoreOperationEventsParamsSchema,
    openResult: CoreOperationEventsOpenResultSchema,
    item: CoreOperationEventsItemSchema,
    end: CoreOperationEventsEndSchema,
    error: OperationErrorSchema,
  }),
});
