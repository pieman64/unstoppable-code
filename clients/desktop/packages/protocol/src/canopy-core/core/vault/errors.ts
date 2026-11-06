import { z } from 'zod';

import {
  CanopyErrorPayloadSchema,
  CanopyRetryDirectiveSchema,
  type CanopyErrorKind,
  type CanopyErrorPayload,
  type CanopyRetryDirective,
} from '../../errors';
import {
  VaultBlockingProtectionSchema,
  VaultRevisionSchema,
  VaultSecretRefSchema,
  type VaultBlockingProtection,
} from './schemas';

export const VAULT_ENTRY_REFRESH_RESOURCE = 'core.vault.entry';
export const VAULT_STATUS_REFRESH_RESOURCE = 'core.vault.status';

export const VAULT_ERROR_REASONS = [
  'absent',
  'deleted',
  'foreign_vault',
  'managed_family',
] as const;
export type VaultErrorReason = (typeof VAULT_ERROR_REASONS)[number];

export const VaultErrorDetailsSchema = z.strictObject({
  reason: z.enum(VAULT_ERROR_REASONS).optional(),
  currentRevision: VaultRevisionSchema.optional(),
  protection: VaultBlockingProtectionSchema.optional(),
  ref: VaultSecretRefSchema.optional(),
});
export type VaultErrorDetails = z.output<typeof VaultErrorDetailsSchema>;
type VaultErrorDetailField = keyof VaultErrorDetails;

type VaultErrorRetry =
  | { readonly kind: 'never' }
  | { readonly kind: 'same_idempotency_key' }
  | { readonly kind: 'after_refresh'; readonly resource: string };

interface VaultErrorSpec {
  readonly kind: CanopyErrorKind;
  readonly retry: VaultErrorRetry;
  /** Fixed: a vault error never carries caller- or secret-derived text. */
  readonly message: string;
  readonly meaning: string;
  readonly required: readonly VaultErrorDetailField[];
  readonly optional: readonly VaultErrorDetailField[];
  readonly reasons?: readonly VaultErrorReason[];
  readonly protection?: VaultBlockingProtection['state'];
}

const NEVER = { kind: 'never' } as const;
const SAME_KEY = { kind: 'same_idempotency_key' } as const;
const REFRESH_ENTRY = {
  kind: 'after_refresh',
  resource: VAULT_ENTRY_REFRESH_RESOURCE,
} as const;
const REFRESH_STATUS = {
  kind: 'after_refresh',
  resource: VAULT_STATUS_REFRESH_RESOURCE,
} as const;

export const VAULT_ERROR_CODES = [
  'core.vault.entry.notFound',
  'core.vault.entry.revisionConflict',
  'core.vault.entry.corrupt',
  'core.vault.entry.keyMissing',
  'core.vault.entry.outcomeUnknown',
  'core.vault.entry.unavailable',
  'core.vault.entry.closureUnrecorded',
  'core.vault.entry.writerRefused',
  'core.vault.entry.idempotencyKeyReused',
  'core.vault.protection.locked',
  'core.vault.protection.denied',
  'core.vault.protection.unavailable',
] as const;
export type VaultErrorCode = (typeof VAULT_ERROR_CODES)[number];

export const VAULT_ERROR_SPECS = {
  'core.vault.entry.notFound': {
    kind: 'not_found',
    retry: NEVER,
    message: 'The vault entry was not found.',
    meaning:
      'No live entry has this reference: `absent` (never existed, or its tombstone is gone), `deleted`, or `foreign_vault` (another vault minted it).',
    required: ['reason'],
    optional: ['ref'],
    reasons: ['absent', 'deleted', 'foreign_vault'],
  },
  'core.vault.entry.revisionConflict': {
    kind: 'conflict',
    retry: REFRESH_ENTRY,
    message: 'The vault entry revision has changed.',
    meaning:
      '`expectedRevision` is not the current revision of the entry; `currentRevision` reports it.',
    required: ['currentRevision'],
    optional: ['ref'],
  },
  'core.vault.entry.corrupt': {
    kind: 'failed_precondition',
    retry: NEVER,
    message: 'The vault entry cannot be read.',
    meaning:
      'The stored entry fails integrity checks. It is never reported as absent; delete it and create a new entry.',
    required: [],
    optional: ['ref'],
  },
  'core.vault.entry.keyMissing': {
    kind: 'failed_precondition',
    retry: NEVER,
    message: 'The vault key is missing.',
    meaning:
      'Entry metadata exists but the vault key slot is absent or unrecoverable (corrupt, or its data key fails to unwrap), for example after a restore to a new machine.',
    required: [],
    optional: ['ref'],
  },
  'core.vault.entry.outcomeUnknown': {
    kind: 'unavailable',
    retry: SAME_KEY,
    message: 'The vault write may have committed.',
    meaning:
      'The write may have committed (W5 `outcome-unknown`). The entry stays unusable until a retry with the same idempotency key settles it.',
    required: [],
    optional: ['ref'],
  },
  'core.vault.entry.unavailable': {
    kind: 'unavailable',
    retry: SAME_KEY,
    message: 'The vault write did not reach the store.',
    meaning:
      'The commit never reached the store (W5 `unavailable`), but its closure intent is durable, so admission stays closed across a restart. A retry with the same idempotency key re-attempts the commit once nothing else refuses it; a put retry also needs the vault key, and returns this error again while the key is not held.',
    required: [],
    optional: ['ref'],
  },
  'core.vault.entry.closureUnrecorded': {
    kind: 'unavailable',
    retry: SAME_KEY,
    message: 'The vault write was not accepted.',
    meaning:
      'The closure intent could not be recorded, so the write was not accepted: nothing changed durably and the idempotency key was not reserved. A put leaves admission unchanged; a delete fails closed, so the entry stays unusable for as long as the owning process runs. A retry with the same key is a fresh attempt.',
    required: [],
    optional: [],
  },
  'core.vault.entry.writerRefused': {
    kind: 'permission_denied',
    retry: NEVER,
    message: 'The caller is not the writer for this entry family.',
    meaning:
      'The caller is not the designated writer for the entry family, or no writer is installed. V6-a refuses managed-family writes with this code.',
    required: ['reason'],
    optional: [],
    reasons: ['managed_family'],
  },
  'core.vault.entry.idempotencyKeyReused': {
    kind: 'conflict',
    retry: NEVER,
    message: 'The idempotency key was already used for a different request.',
    meaning:
      'This `_meta.idempotencyKey` was already used with different canonical params (W5 `key-reused`). Nothing changed; send the new request under a new key.',
    required: [],
    optional: ['ref'],
  },
  'core.vault.protection.locked': {
    kind: 'failed_precondition',
    retry: REFRESH_STATUS,
    message: 'Vault protection is locked.',
    meaning:
      'The backend is locked (`evidence` says whether it reported or was inferred). Refresh `core.vault.status.get` before retrying.',
    required: ['protection'],
    optional: [],
    protection: 'locked',
  },
  'core.vault.protection.denied': {
    kind: 'failed_precondition',
    retry: REFRESH_STATUS,
    message: 'Vault protection access was denied.',
    meaning:
      'The backend refused access to the vault key. Refresh `core.vault.status.get` before retrying.',
    required: ['protection'],
    optional: [],
    protection: 'denied',
  },
  'core.vault.protection.unavailable': {
    kind: 'unavailable',
    retry: REFRESH_STATUS,
    message: 'Vault protection is unavailable.',
    meaning:
      'No usable backend, an unsupported session, a backend failure or an unavailable local authority (`protection.reason`). Refresh `core.vault.status.get`; this is not a same-key replay.',
    required: ['protection'],
    optional: [],
    protection: 'unavailable',
  },
} as const satisfies Readonly<Record<VaultErrorCode, VaultErrorSpec>>;

export function vaultErrorSpec(code: VaultErrorCode): VaultErrorSpec {
  return VAULT_ERROR_SPECS[code];
}

interface VaultErrorShape {
  readonly kind: CanopyErrorKind;
  readonly message: string;
  readonly code?: VaultErrorCode;
  readonly details?: VaultErrorDetails;
  readonly retry: CanopyRetryDirective;
}

function sameRetry(
  actual: CanopyRetryDirective,
  expected: VaultErrorRetry,
): boolean {
  if (actual.kind !== expected.kind) return false;
  return (
    expected.kind !== 'after_refresh' ||
    (actual.kind === 'after_refresh' && actual.resource === expected.resource)
  );
}

function detailProblems(
  spec: VaultErrorSpec,
  details: VaultErrorDetails,
): string[] {
  const allowed = new Set<string>([...spec.required, ...spec.optional]);
  // An `undefined` field never reaches the wire, so only present ones count.
  const problems = Object.entries(details)
    .filter(([field, value]) => value !== undefined && !allowed.has(field))
    .map(([field]) => `unexpected detail ${field}`);
  for (const field of spec.required)
    if (details[field] === undefined) problems.push(`missing detail ${field}`);
  if (details.reason !== undefined && !spec.reasons?.includes(details.reason))
    problems.push(`unexpected reason ${details.reason}`);
  if (
    details.protection !== undefined &&
    details.protection.state !== spec.protection
  )
    problems.push(`unexpected protection ${details.protection.state}`);
  return problems;
}

/**
 * The daemon control plane sends this refusal before it reads the method, so
 * the dispatcher never rewrites its `same_request` retry for a keyed call. The
 * schema cannot tell it from a handler's copy, so a replay keeps the
 * idempotency key and a client never infers that nothing ran. Keep the message
 * equal to control-plane.ts; the framed control-plane test fails on drift.
 */
export const VAULT_OVERLOAD_REFUSAL = {
  kind: 'resource_exhausted',
  message: 'Too many requests in flight on this connection.',
} as const;

/**
 * Uncoded vault errors are the core runtime's own refusals (dispatcher and
 * daemon control plane), so their messages are closed per kind: a handler
 * cannot pass secret- or provider-derived text without a code. An unlisted
 * message fails the schema; the dispatcher then sends a redacted `internal`
 * error, and a client reports an undeclared one. Add a message here when the
 * runtime adds a generic refusal that vault calls can reach; the vault
 * dispatch and framed control-plane tests check the refusals they trigger.
 */
export const VAULT_UNCODED_ERROR_MESSAGES = {
  invalid_argument: [
    'Invalid request metadata.',
    'An idempotency key is required.',
    'An idempotency key is not allowed.',
    'Invalid operation parameters.',
  ],
  unauthenticated: ['Caller authentication is invalid.'],
  permission_denied: ['The caller is not permitted to perform this operation.'],
  failed_precondition: ['Call core.runtime.initialize first.'],
  capability_unavailable: ['The requested operation is unavailable.'],
  cancelled: ['The operation was cancelled.'],
  deadline_exceeded: ['The operation deadline was exceeded.'],
  unavailable: ['The runtime is unavailable.'],
  resource_exhausted: [VAULT_OVERLOAD_REFUSAL.message],
  internal: [
    'The operation failed.',
    'The operation returned an invalid error.',
    'The operation returned an invalid result.',
  ],
} as const satisfies Partial<Record<CanopyErrorKind, readonly string[]>>;

function isVaultUncodedErrorMessage(
  kind: CanopyErrorKind,
  message: string,
): boolean {
  const messages: Partial<Record<CanopyErrorKind, readonly string[]>> =
    VAULT_UNCODED_ERROR_MESSAGES;
  return messages[kind]?.includes(message) ?? false;
}

interface VaultUncodedErrorShape {
  readonly kind: CanopyErrorKind;
  readonly message: string;
}

function checkVaultUncodedMessage(
  payload: VaultUncodedErrorShape,
  context: z.RefinementCtx,
): void {
  if (!isVaultUncodedErrorMessage(payload.kind, payload.message))
    context.addIssue({
      code: 'custom',
      message: `an uncoded ${payload.kind} vault error must use a fixed runtime message`,
    });
}

/** Each vault code has one kind, retry, message and detail shape. */
function checkVaultErrorPairing(
  payload: VaultErrorShape,
  context: z.RefinementCtx,
): void {
  const problems: string[] = [];
  if (payload.code === undefined) {
    if (payload.details !== undefined)
      problems.push('vault error details require a vault code');
    checkVaultUncodedMessage(payload, context);
  } else {
    const spec = vaultErrorSpec(payload.code);
    if (
      payload.kind !== spec.kind ||
      payload.message !== spec.message ||
      !sameRetry(payload.retry, spec.retry)
    )
      problems.push(
        `${payload.code} must use its fixed kind, retry and message`,
      );
    problems.push(...detailProblems(spec, payload.details ?? {}));
  }
  for (const message of problems) context.addIssue({ code: 'custom', message });
}

export type VaultOperationErrorPayload<
  Code extends VaultErrorCode = VaultErrorCode,
> = Omit<CanopyErrorPayload, 'code' | 'details'> & {
  code?: Code;
  details?: VaultErrorDetails;
};

export function vaultOperationErrorSchema<
  const Codes extends readonly [VaultErrorCode, ...VaultErrorCode[]],
>(
  codes: Codes,
  retry: z.ZodType<CanopyRetryDirective>,
): z.ZodType<VaultOperationErrorPayload<Codes[number]>> {
  return CanopyErrorPayloadSchema.extend({
    code: z.enum(codes).optional(),
    details: VaultErrorDetailsSchema.optional(),
    retry,
  }).superRefine(checkVaultErrorPairing);
}

function checkVaultKeyedRetry(
  payload: VaultErrorShape,
  context: z.RefinementCtx,
): void {
  if (
    payload.retry.kind === 'same_request' &&
    (payload.code !== undefined ||
      payload.kind !== VAULT_OVERLOAD_REFUSAL.kind ||
      payload.message !== VAULT_OVERLOAD_REFUSAL.message)
  )
    context.addIssue({
      code: 'custom',
      message:
        'a keyed vault error retries with its idempotency key; only the overload refusal retries the same request',
    });
}

/**
 * For keyed writes: a replay reuses the idempotency key, so `same_request` is
 * refused except on `VAULT_OVERLOAD_REFUSAL`. Vault handlers must not emit
 * `resource_exhausted`; the dispatcher does not enforce that.
 */
export function vaultKeyedOperationErrorSchema<
  const Codes extends readonly [VaultErrorCode, ...VaultErrorCode[]],
>(codes: Codes): z.ZodType<VaultOperationErrorPayload<Codes[number]>> {
  return CanopyErrorPayloadSchema.extend({
    code: z.enum(codes).optional(),
    details: VaultErrorDetailsSchema.optional(),
    retry: CanopyRetryDirectiveSchema,
  }).superRefine((payload, context) => {
    checkVaultErrorPairing(payload, context);
    checkVaultKeyedRetry(payload, context);
  });
}

/** For operations without vault codes: only the runtime's own refusals. */
export function vaultUncodedErrorSchema(
  retry: z.ZodType<CanopyRetryDirective>,
): z.ZodType<Omit<CanopyErrorPayload, 'code' | 'details'>> {
  return CanopyErrorPayloadSchema.omit({ code: true, details: true })
    .extend({ retry })
    .superRefine(checkVaultUncodedMessage);
}

const VaultErrorPayloadSchema = vaultOperationErrorSchema(
  VAULT_ERROR_CODES,
  CanopyRetryDirectiveSchema,
);

/**
 * Builds a vault error with its code's fixed kind, retry and message. Throws
 * when `details` does not fit the code, which is a programming error.
 */
export function vaultError(
  code: VaultErrorCode,
  details?: VaultErrorDetails,
): CanopyErrorPayload {
  const spec = vaultErrorSpec(code);
  return VaultErrorPayloadSchema.parse({
    kind: spec.kind,
    message: spec.message,
    code,
    ...(details === undefined ? {} : { details }),
    retry: { ...spec.retry },
  });
}
