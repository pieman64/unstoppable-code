import { z } from 'zod';

import { CanopyStreamCursorSchema } from '../../definitions';
import { CanopyWorkspaceScopeSchema } from '../../common';
import { CanopyErrorPayloadSchema, CanopyJsonValueSchema } from '../../errors';

/*
 * Durable operation records (CAN-4130). One record per accepted unit of work,
 * whichever domain runs it: its lineage, origin, accountable owner, retry
 * receipt and terminal outcome. Records survive client disconnects and
 * restarts; a restart reconciles each interrupted record by its domain's
 * restart class instead of leaving it running.
 */

const id = z.string().min(1).max(512);
const timestamp = z.iso.datetime({ offset: true });

export const OPERATION_LIMITS = {
  listPageMax: 500,
  listPageDefault: 100,
  listCursorMax: 2_048,
  eventsOperationIdsMax: 256,
  listKindsMax: 32,
  reasonMax: 1_024,
} as const;

// One plane prefix only: `core.core.run` is not a valid name.
const PLANE_QUALIFIED_NAME =
  /^(core|worker)\.(?!(core|worker)\.)[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/;

/** A plane-qualified operation kind, such as `core.pipeline.run`. */
export const OperationKindSchema = z
  .string()
  .max(512)
  .regex(PLANE_QUALIFIED_NAME);

/** How finished work failed, in the shape of an operation error payload. */
export const OperationFailureSchema = CanopyErrorPayloadSchema.extend({
  code: z.string().max(512).regex(PLANE_QUALIFIED_NAME).optional(),
});
export type OperationFailure = z.output<typeof OperationFailureSchema>;

export const OPERATION_STATUSES = [
  'queued',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const;
export const OperationStatusSchema = z.enum(OPERATION_STATUSES);
export type OperationStatus = z.output<typeof OperationStatusSchema>;

export const OPERATION_TERMINAL_STATUSES = [
  'completed',
  'failed',
  'cancelled',
] as const satisfies readonly OperationStatus[];
export type OperationTerminalStatus =
  (typeof OPERATION_TERMINAL_STATUSES)[number];

export function isTerminalOperationStatus(
  status: OperationStatus,
): status is OperationTerminalStatus {
  return OPERATION_TERMINAL_STATUSES.some((terminal) => terminal === status);
}

export const OPERATION_ORIGIN_KINDS = [
  'client',
  'hook',
  'automation',
  'watcher',
  'system',
  'delegation',
] as const;
export type OperationOriginKind = (typeof OPERATION_ORIGIN_KINDS)[number];

/** What started the work. A client origin names the requesting principal. */
export const OperationOriginSchema = z.strictObject({
  kind: z.enum(OPERATION_ORIGIN_KINDS),
  sourceId: id,
  occurrenceKey: id.optional(),
  context: CanopyJsonValueSchema.optional(),
});
export type OperationOrigin = z.output<typeof OperationOriginSchema>;

/** Who is accountable for the work, independent of which client asked. */
export const OperationOwnerSchema = z.strictObject({
  kind: z.enum(['principal', 'organization', 'system']),
  id,
});
export type OperationOwner = z.output<typeof OperationOwnerSchema>;

/**
 * The retry receipt. The operation and its idempotency key are committed
 * before the request is acknowledged; a retry with the same key and
 * parameters returns this record instead of starting the work again.
 * `outcome` is `pending` until a terminal outcome is recorded, and `expired`
 * once the retention window dropped the saved outcome (the identity stays).
 */
export const OperationReceiptSchema = z.strictObject({
  idempotencyKey: id.nullable(),
  acceptedAt: timestamp,
  outcome: z.enum(['pending', 'recorded', 'expired']),
});
export type OperationReceipt = z.output<typeof OperationReceiptSchema>;

export const OperationCancellationSchema = z.strictObject({
  requestedAt: timestamp,
  requestedBy: id,
  reason: z.string().min(1).max(OPERATION_LIMITS.reasonMax),
});
export type OperationCancellation = z.output<
  typeof OperationCancellationSchema
>;

/**
 * How a domain's interrupted work is reconciled after a restart: `lost` work
 * ends failed (its effects may have started and are never replayed),
 * `resumable` work waits paused for its domain to resume it, and
 * `reattachable` work waits for its domain to find the effect still running.
 */
export const OPERATION_RESTART_CLASSES = [
  'lost',
  'resumable',
  'reattachable',
] as const;
export const OperationRestartClassSchema = z.enum(OPERATION_RESTART_CLASSES);
export type OperationRestartClass = z.output<
  typeof OperationRestartClassSchema
>;

export const OPERATION_RESTART_DISPOSITIONS = [
  'lost',
  'awaiting-resume',
  'resumed',
  'awaiting-reattach',
  'reattached',
  'cancelled',
  'unclaimed',
] as const;
export const OperationRestartDispositionSchema = z.enum(
  OPERATION_RESTART_DISPOSITIONS,
);
export type OperationRestartDisposition = z.output<
  typeof OperationRestartDispositionSchema
>;

export const OperationRestartSchema = z.strictObject({
  /** Absent while no running domain claims the operation's kind. */
  class: OperationRestartClassSchema.nullable(),
  disposition: OperationRestartDispositionSchema,
  reconciledAt: timestamp,
});
export type OperationRestart = z.output<typeof OperationRestartSchema>;

export const OperationRecordSchema = z.strictObject({
  operationId: id,
  kind: OperationKindSchema,
  status: OperationStatusSchema,
  /** Advances on every change; `core.operation.cancel` may compare it. */
  revision: z.number().int().min(1),
  parentOperationId: id.nullable(),
  rootOperationId: id,
  authorityId: id.nullable(),
  executionTargetId: id.nullable(),
  runtimeDelegationId: id.nullable(),
  scope: CanopyWorkspaceScopeSchema,
  origin: OperationOriginSchema,
  owner: OperationOwnerSchema,
  receipt: OperationReceiptSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
  completedAt: timestamp.nullable(),
  progress: z.number().min(0).max(1).nullable(),
  /** The recorded result of completed work; null otherwise or once expired. */
  outcome: CanopyJsonValueSchema.nullable(),
  error: OperationFailureSchema.nullable(),
  cancellation: OperationCancellationSchema.nullable(),
  restart: OperationRestartSchema.nullable(),
});
export type OperationRecord = z.output<typeof OperationRecordSchema>;

export const CoreOperationGetParamsSchema = z.strictObject({
  operationId: id,
});
export type CoreOperationGetParams = z.output<
  typeof CoreOperationGetParamsSchema
>;
export const CoreOperationGetResultSchema = z.strictObject({
  operation: OperationRecordSchema,
});
export type CoreOperationGetResult = z.output<
  typeof CoreOperationGetResultSchema
>;

export const CoreOperationListParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema.optional(),
  statuses: z.array(OperationStatusSchema).min(1).max(6).optional(),
  kinds: z
    .array(OperationKindSchema)
    .min(1)
    .max(OPERATION_LIMITS.listKindsMax)
    .optional(),
  parentOperationId: id.optional(),
  pageSize: z
    .number()
    .int()
    .min(1)
    .max(OPERATION_LIMITS.listPageMax)
    .optional(),
  cursor: z.string().min(1).max(OPERATION_LIMITS.listCursorMax).optional(),
});
export type CoreOperationListParams = z.output<
  typeof CoreOperationListParamsSchema
>;
/** What an opaque list cursor encodes: the last record served. */
export const OperationListPositionSchema = z.tuple([timestamp, id]);

export const CoreOperationListResultSchema = z.strictObject({
  items: z.array(OperationRecordSchema).max(OPERATION_LIMITS.listPageMax),
  nextCursor: z.string().min(1).max(OPERATION_LIMITS.listCursorMax).nullable(),
  /**
   * The event position this page was read at. Opening
   * `core.operation.events` from it misses no change made after the read.
   */
  eventsCursor: CanopyStreamCursorSchema,
});
export type CoreOperationListResult = z.output<
  typeof CoreOperationListResultSchema
>;

export const CoreOperationCancelParamsSchema = z.strictObject({
  operationId: id,
  reason: z.string().min(1).max(OPERATION_LIMITS.reasonMax),
  expectedRevision: z.number().int().min(1).optional(),
});
export type CoreOperationCancelParams = z.output<
  typeof CoreOperationCancelParamsSchema
>;

/**
 * `cancelled`: the work stopped and the record is terminal. `requested`: the
 * owning domain accepted the request and records the terminal state when the
 * work stops. `already-terminal`: nothing changed.
 */
export const CoreOperationCancelResultSchema = z.strictObject({
  operation: OperationRecordSchema,
  outcome: z.enum(['cancelled', 'requested', 'already-terminal']),
});
export type CoreOperationCancelResult = z.output<
  typeof CoreOperationCancelResultSchema
>;

export const OPERATION_EVENT_TYPES = [
  'queued',
  'started',
  'paused',
  'resumed',
  'cancelRequested',
  'cancelRefused',
  'completed',
  'failed',
  'cancelled',
  'reconciled',
] as const;
export const OperationEventTypeSchema = z.enum(OPERATION_EVENT_TYPES);
export type OperationEventType = z.output<typeof OperationEventTypeSchema>;

export const CoreOperationEventsParamsSchema = z.strictObject({
  operationIds: z
    .array(id)
    .min(1)
    .max(OPERATION_LIMITS.eventsOperationIdsMax)
    .optional(),
  scope: CanopyWorkspaceScopeSchema.optional(),
  cursor: CanopyStreamCursorSchema.nullable().optional(),
});
export type CoreOperationEventsParams = z.output<
  typeof CoreOperationEventsParamsSchema
>;

export const CoreOperationEventsOpenResultSchema = z.strictObject({
  subscriptionId: id,
  acceptedCursor: CanopyStreamCursorSchema.nullable(),
});

/** A durable lifecycle change, with the record as that change left it. */
export const CoreOperationEventsItemSchema = z.strictObject({
  eventId: id,
  occurredAt: timestamp,
  event: OperationEventTypeSchema,
  previousStatus: OperationStatusSchema.nullable(),
  operation: OperationRecordSchema,
});
export type CoreOperationEventsItem = z.output<
  typeof CoreOperationEventsItemSchema
>;
