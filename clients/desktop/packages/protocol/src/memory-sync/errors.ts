import { z } from 'zod';
import { MEMORY_SYNC_LIMITS } from './constants';
import {
  MemoryNoteIdSchema,
  MemoryRevisionSchema,
  MemoryTimestampSchema,
} from './identifiers';

export const MEMORY_SYNC_ERROR_CODES = [
  'memory_invalid_request',
  'memory_request_too_large',
  'memory_unsupported_protocol',
  'memory_ingest_disabled',
  'memory_scope_suspended',
  'memory_account_ineligible',
  'memory_account_mismatch',
  'memory_sync_disabled',
  'memory_scope_device_only',
  'memory_device_unregistered',
  'memory_stale_session',
  'memory_scope_not_found',
  'memory_scope_deleted',
  'memory_cursor_expired',
  'memory_settings_conflict',
  'memory_revision_conflict',
  'memory_notes_changed',
  'memory_lease_held',
  'memory_lease_lost',
  'memory_lease_required',
  'memory_lease_not_eligible',
  'memory_idempotency_conflict',
  'memory_history_unavailable',
  'memory_note_divergent',
  'memory_origin_blocked',
  'memory_secret_detected',
  'memory_quota_exceeded',
  'memory_rate_limited',
] as const;
export const MemorySyncErrorCodeSchema = z.enum(MEMORY_SYNC_ERROR_CODES);
export type MemorySyncErrorCode = z.output<typeof MemorySyncErrorCodeSchema>;

export const MEMORY_SYNC_ERROR_HTTP_STATUS: Readonly<
  Record<MemorySyncErrorCode, number>
> = {
  memory_invalid_request: 400,
  memory_request_too_large: 413,
  memory_unsupported_protocol: 426,
  memory_ingest_disabled: 503,
  memory_scope_suspended: 503,
  memory_account_ineligible: 403,
  memory_account_mismatch: 409,
  memory_sync_disabled: 409,
  memory_scope_device_only: 409,
  memory_device_unregistered: 409,
  memory_stale_session: 409,
  memory_scope_not_found: 404,
  memory_scope_deleted: 410,
  memory_cursor_expired: 410,
  memory_settings_conflict: 409,
  memory_revision_conflict: 409,
  memory_notes_changed: 409,
  memory_lease_held: 409,
  memory_lease_lost: 409,
  memory_lease_required: 409,
  memory_lease_not_eligible: 409,
  memory_idempotency_conflict: 409,
  memory_history_unavailable: 410,
  memory_note_divergent: 409,
  memory_origin_blocked: 403,
  memory_secret_detected: 422,
  memory_quota_exceeded: 429,
  memory_rate_limited: 429,
};

export const MemorySyncRetrySchema = z.enum([
  'later',
  'after_register',
  'after_pull',
  'after_snapshot',
  'never',
]);
export type MemorySyncRetry = z.output<typeof MemorySyncRetrySchema>;

export const MemoryLeaseHolderKindSchema = z.enum(['desktop', 'cloud']);

export const MemorySyncErrorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: MemorySyncErrorCodeSchema,
    message: z.string().max(MEMORY_SYNC_LIMITS.messageMaxChars),
    retry: MemorySyncRetrySchema,
    retryAfterMs: z.int().min(0).optional(),
    headRevision: MemoryRevisionSchema.optional(),
    noteIds: z
      .array(MemoryNoteIdSchema)
      .max(MEMORY_SYNC_LIMITS.commitConsumedNotesMax)
      .optional(),
    leaseHolder: z
      .strictObject({
        kind: MemoryLeaseHolderKindSchema,
        expiresAt: MemoryTimestampSchema,
      })
      .optional(),
    minimumProtocolVersion: z.int().min(1).optional(),
  }),
});
export type MemorySyncErrorResponse = z.output<
  typeof MemorySyncErrorResponseSchema
>;
