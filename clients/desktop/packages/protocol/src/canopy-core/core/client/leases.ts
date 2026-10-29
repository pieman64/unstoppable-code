import { z } from 'zod';

// Nested core modules use ../../ for common canopy-core contracts.

import {
  CANOPY_INTERFACE_KINDS,
  CanopyRequestMetadataSchema,
} from '../../common';
import { CanopyJsonValueSchema } from '../../errors';
import {
  inherentOperationErrorSchema,
  keyedOperationErrorSchema,
} from '../shared';

const id = z.string().min(1).max(512);
const json = CanopyJsonValueSchema;
const LEASE_ERROR_CODES = [
  'core.client.lease.invalidState',
  'core.client.lease.revisionConflict',
  'core.client.lease.notFound',
] as const;

// The lease is bound to the authenticated connection, never named in params.
export const CoreClientLeaseAcquireParamsSchema = z.strictObject({
  clientInstanceId: id,
  interfaceKind: z.enum(CANOPY_INTERFACE_KINDS).exclude(['worker']),
  label: z.string().min(1).max(256),
  interactive: z.boolean(),
  foreground: z.boolean(),
  renewalIntervalMs: z.number().int().min(1_000).max(300_000),
  previousLeaseId: z.string().nullable().optional(),
  _meta: CanopyRequestMetadataSchema.extend({ idempotencyKey: id }),
});

export const CoreClientLeaseSchema = z
  .object({
    leaseId: id,
    clientInstanceId: id,
    expiresAt: z.iso.datetime({ offset: true }),
    renewAfterMs: z.number().int().min(1_000),
    revision: z.number().int().nonnegative(),
  })
  .catchall(json);
export type CoreClientLease = z.output<typeof CoreClientLeaseSchema>;

export const CORE_CLIENT_LEASE_EVICTED = 'core.client.lease.evicted';
export const CoreClientLeaseEvictedSchema = z.strictObject({
  leaseId: id,
  reason: z.literal('expired'),
  releasedRegistrationCount: z.number().int().min(0).max(288),
});
export type CoreClientLeaseEvicted = z.output<
  typeof CoreClientLeaseEvictedSchema
>;

export const CoreClientLeaseRenewParamsSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  interactive: z.boolean(),
  foreground: z.boolean(),
});

export const CoreClientLeaseReleaseParamsSchema = z.strictObject({
  reason: z.enum(['normal_shutdown', 'sign_out', 'replaced', 'error']),
});
export const CoreClientLeaseReleaseResultSchema = z
  .object({
    released: z.boolean(),
    releasedRegistrationCount: z.number().int().min(0).max(288),
    failedRequestIds: z.array(id).max(32),
  })
  .catchall(json);

export const CoreClientLeaseAcquireErrorSchema =
  keyedOperationErrorSchema(LEASE_ERROR_CODES);
export const CoreClientLeaseErrorSchema =
  inherentOperationErrorSchema(LEASE_ERROR_CODES);
