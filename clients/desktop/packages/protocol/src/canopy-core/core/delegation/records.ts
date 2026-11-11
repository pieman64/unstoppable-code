import { z } from 'zod';

import { CANOPY_IN_PROCESS_WORKER_TARGET_ID } from '../../common';
import { OperationKindSchema } from '../operation/schemas';

/*
 * Dispatch and placement records (CAN-4132). The core keeps them in its
 * operation ledger, so a dispatch commits with its child operation. Internal
 * record shapes: no `core.delegation.*` or `core.target.*` operation serves
 * them yet. The shapes follow `execution-targets.yaml` and the
 * catalog-frozen `core.delegation.create` result, so remote targets can
 * reuse them unchanged.
 */

const id = z.string().min(1).max(512);
const timestamp = z.iso.datetime({ offset: true });

/** A SHA-256 digest; records hold digests, never the material itself. */
export const Sha256FingerprintSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/);

export const ExecutionTargetRecordSchema = z.strictObject({
  targetId: id,
  catalogKind: z.enum(['builtin', 'standalone', 'cloud', 'secondary_daemon']),
  profile: z.enum(['core', 'worker', 'core+worker']),
  /** The lease binding row of `execution-targets.yaml` `leaseBindings`. */
  leaseBinding: z.enum(['in-process', 'local', 'http']),
  activationDelivery: z.enum([
    'inline-parameters',
    'sealed-reference',
    'bootstrap-injection',
  ]),
  registeredAt: timestamp,
});
export type ExecutionTargetRecord = z.output<
  typeof ExecutionTargetRecordSchema
>;
export type ExecutionTargetRegistration = Omit<
  ExecutionTargetRecord,
  'registeredAt'
>;

/** The builtin target row; always registered, never provisioned. */
export const IN_PROCESS_WORKER_TARGET: ExecutionTargetRegistration = {
  targetId: CANOPY_IN_PROCESS_WORKER_TARGET_ID,
  catalogKind: 'builtin',
  profile: 'core+worker',
  leaseBinding: 'in-process',
  activationDelivery: 'inline-parameters',
};

/**
 * Why a lease ended. `process-ended`: the run holding it ended. The rest
 * belong to a remote executor's lease (ADR 31): `child-terminal`, the primary
 * recorded the child's terminal state; `drained`, the executor checkpointed
 * and released for rollover or shutdown; `superseded`, a newer lease epoch was
 * granted; `expired`, the TTL lapsed and the child may still be running;
 * `revoked`, the primary withdrew the target or the work; `executor-lost`,
 * the executor's host reported its sandbox gone.
 */
export const DELEGATION_LEASE_RELEASE_REASONS = [
  'process-ended',
  'child-terminal',
  'drained',
  'superseded',
  'expired',
  'revoked',
  'executor-lost',
] as const;
export const DelegationLeaseReleaseReasonSchema = z.enum(
  DELEGATION_LEASE_RELEASE_REASONS,
);
export type DelegationLeaseReleaseReason = z.output<
  typeof DelegationLeaseReleaseReasonSchema
>;

/** A renewal: only the primary renews, never the executor (ADR 31). */
export const DelegationLeaseRenewalSchema = z.strictObject({
  renewedAt: timestamp,
  /** The primary instance that renewed, such as one web core pod. */
  renewedBy: id,
});
export type DelegationLeaseRenewal = z.output<
  typeof DelegationLeaseRenewalSchema
>;

/**
 * A delegation lease. The in-process binding's is degenerate: process
 * liveness is its only signal, it is never renewed and never expires by
 * timer, and it ends with the process run that holds it.
 *
 * A remote executor's lease (ADR 31) adds a lease epoch and its last
 * renewal. Leases that are never granted again, such as the in-process one,
 * omit both, so the ledger rows older builds wrote and read stay unchanged.
 */
export const DelegationLeaseRecordSchema = z
  .strictObject({
    leaseId: id,
    targetId: id,
    binding: z.enum(['in-process', 'local', 'http']),
    signal: z.enum(['process_liveness', 'transport_close', 'renewal']),
    /** The ledger run (process) that holds it. */
    runEpoch: id,
    /**
     * Separate from `runEpoch`: the primary raises it at each grant to a new
     * executor incarnation, and writes from an older epoch are refused.
     */
    leaseEpoch: z.number().int().min(1).optional(),
    /** Null until the primary first renews it. */
    lastRenewal: DelegationLeaseRenewalSchema.nullable().optional(),
    acquiredAt: timestamp,
    renewAfterMs: z.number().int().min(0).nullable(),
    ttlMs: z.number().int().min(0).nullable(),
    expiresAt: timestamp.nullable(),
    releasedAt: timestamp.nullable(),
    releaseReason: DelegationLeaseReleaseReasonSchema.nullable(),
  })
  .refine(
    (lease): boolean =>
      lease.lastRenewal === undefined ||
      lease.lastRenewal === null ||
      lease.leaseEpoch !== undefined,
    {
      path: ['lastRenewal'],
      message: 'Only a lease with a lease epoch is renewed.',
    },
  );
export type DelegationLeaseRecord = z.output<
  typeof DelegationLeaseRecordSchema
>;
export type DelegationLeaseTerms = Pick<
  DelegationLeaseRecord,
  'binding' | 'signal' | 'renewAfterMs' | 'ttlMs'
>;

export const IN_PROCESS_LEASE_TERMS: DelegationLeaseTerms = {
  binding: 'in-process',
  signal: 'process_liveness',
  renewAfterMs: null,
  ttlMs: null,
};

/**
 * `prepared`: recorded with its child operation, not yet sent.
 * `dispatched`: sent to the target. `reconciling`: the reply is unknown and
 * the target is being asked how the work ended. `unreachable`: the target
 * cannot be asked; the child may still be running. The rest are terminal and
 * mirror the child operation.
 */
export const DELEGATION_STATES = [
  'prepared',
  'dispatched',
  'reconciling',
  'unreachable',
  'completed',
  'failed',
  'cancelled',
] as const;
export const DelegationStateSchema = z.enum(DELEGATION_STATES);
export type DelegationState = z.output<typeof DelegationStateSchema>;
export const UNSETTLED_DELEGATION_STATES = [
  'prepared',
  'dispatched',
  'reconciling',
  'unreachable',
] as const satisfies readonly DelegationState[];

/**
 * How a settled delegation's outcome was established: the target's `reply`;
 * its `executor-receipt` after an unknown reply; `not-started` when the
 * target proved it never received the work; `unqueryable` when an
 * instruction without an idempotency key lost its reply, so its outcome
 * stays unknown; or a `restart` that ended the process running it.
 */
export const DelegationResolutionSchema = z.enum([
  'reply',
  'executor-receipt',
  'not-started',
  'unqueryable',
  'restart',
]);
export type DelegationResolution = z.output<typeof DelegationResolutionSchema>;

export const DelegationSecretFingerprintSchema = z.strictObject({
  /** The caller's name for the secret, such as an environment variable. */
  name: z.string().min(1).max(256),
  fingerprint: Sha256FingerprintSchema,
});
export type DelegationSecretFingerprint = z.output<
  typeof DelegationSecretFingerprintSchema
>;

export const DELEGATION_SECRETS_MAX = 64;

export const DelegationRecordSchema = z.strictObject({
  delegationId: id,
  parentOperationId: id,
  childOperationId: id,
  rootOperationId: id,
  /** Resolved placement: never re-evaluated for this dispatch. */
  targetId: id,
  leaseId: id,
  operation: z.strictObject({
    name: OperationKindSchema,
    version: z.number().int().min(1),
    idempotency: z.enum(['keyed', 'none', 'inherent']),
  }),
  /** The dispatch key, also the child operation's receipt key. */
  idempotencyKey: id,
  /**
   * The key the target records the work under, so an unknown reply can be
   * resolved by asking for it; null when the instruction takes no key.
   */
  executorKey: id.nullable(),
  /** What the target was given: inline parameters, by digest only. */
  activation: z.strictObject({
    delivery: z.enum([
      'inline-parameters',
      'sealed-reference',
      'bootstrap-injection',
    ]),
    digest: Sha256FingerprintSchema,
  }),
  /** Secrets handed to the work, by fingerprint only (CAN-5067). */
  secrets: z
    .array(DelegationSecretFingerprintSchema)
    .max(DELEGATION_SECRETS_MAX),
  state: DelegationStateSchema,
  resolution: DelegationResolutionSchema.nullable(),
  createdAt: timestamp,
  dispatchedAt: timestamp.nullable(),
  settledAt: timestamp.nullable(),
  updatedAt: timestamp,
});
export type DelegationRecord = z.output<typeof DelegationRecordSchema>;

/** What a dispatch records with its child operation. */
export type DelegationDispatchInput = Pick<
  DelegationRecord,
  | 'delegationId'
  | 'targetId'
  | 'leaseId'
  | 'operation'
  | 'idempotencyKey'
  | 'executorKey'
  | 'activation'
  | 'secrets'
>;
