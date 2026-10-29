import {
  LEDGER_ERROR_CODES,
  LEDGER_WRITER_REFRESH_RESOURCE,
  LedgerErrorDetailsSchema,
  isBoundedCanopyJsonValue,
  type CanopyInstructionName,
  type CanopyErrorKind,
  type CanopyQueryName,
  type CanopyRetryDirective,
  type LedgerErrorDetails,
  type LedgerErrorReason,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '@canopy/core-runtime';
import { LedgerStorageHostError } from './storage-host';
import type { LedgerStorageErrorReason } from './storage-worker-contract';

/*
 * Maps Ledger failures to the core error envelope: a kind per reason, the
 * `core.ledger.*` code, bounded details, and a retry directive that the
 * operation's error schema accepts. Messages are fixed and content-free;
 * nothing here logs.
 */

export type LedgerQueryOperation = Extract<
  CanopyQueryName,
  `core.ledger.${string}`
>;
// The Ledger's commands are keyed instructions on the core dispatcher.
export type LedgerCommandOperation = Extract<
  CanopyInstructionName,
  `core.ledger.${string}`
>;
export type LedgerOperation = LedgerQueryOperation | LedgerCommandOperation;

/** Where a failure happened: a query, or a keyed command. */
export interface LedgerErrorSite {
  readonly operation: LedgerOperation;
  readonly mode: 'query' | 'command';
  /** The caller's ledger, once resolved; details never carry another's entry. */
  readonly ledgerId?: string;
}

const KIND_BY_REASON: {
  readonly [Reason in LedgerStorageErrorReason]: CanopyErrorKind;
} = {
  INVALID_INPUT: 'invalid_argument',
  NOT_FOUND: 'not_found',
  FORBIDDEN: 'permission_denied',
  TERMINAL_ENTRY: 'failed_precondition',
  REVISION_CONFLICT: 'conflict',
  OWNER_UNAVAILABLE: 'failed_precondition',
  SCOPE_RETIRED: 'failed_precondition',
  IDEMPOTENCY_KEY_REUSED: 'conflict',
  CURSOR_EXPIRED: 'failed_precondition',
  UNSUPPORTED_SCHEMA: 'capability_unavailable',
  STORAGE_UNAVAILABLE: 'unavailable',
  RATE_LIMITED: 'resource_exhausted',
  WRITER_UNAVAILABLE: 'capability_unavailable',
  INTERNAL: 'internal',
};

const MESSAGE_BY_REASON: {
  readonly [Reason in LedgerStorageErrorReason]: string;
} = {
  INVALID_INPUT: 'The Feed request is invalid.',
  NOT_FOUND: 'The Feed item was not found.',
  FORBIDDEN: 'The caller may not perform this Feed operation.',
  TERMINAL_ENTRY: 'The Feed entry is closed and cannot change.',
  REVISION_CONFLICT: 'The Feed entry changed since it was read.',
  OWNER_UNAVAILABLE: 'The requested Feed owner is unavailable.',
  SCOPE_RETIRED: 'The Feed scope no longer accepts changes.',
  IDEMPOTENCY_KEY_REUSED:
    'The idempotency key was already used for a different request.',
  CURSOR_EXPIRED: 'The Feed cursor is no longer valid.',
  UNSUPPORTED_SCHEMA: 'The Feed database uses an unsupported schema.',
  STORAGE_UNAVAILABLE: 'Feed storage is unavailable.',
  RATE_LIMITED: 'Too many Feed requests.',
  WRITER_UNAVAILABLE: 'The Feed is not available right now.',
  INTERNAL: 'The Feed operation failed.',
};

/**
 * Retry directives valid for the site: queries replay the same request,
 * keyed commands replay the same idempotency key. Anything that may have
 * committed (a storage timeout, a lost worker reply, an unexpected failure)
 * tells a command to retry with the same key, which returns the stored
 * receipt if it did commit.
 */
function retryFor(
  reason: LedgerStorageErrorReason,
  site: LedgerErrorSite,
): CanopyRetryDirective {
  switch (reason) {
    case 'REVISION_CONFLICT':
      return { kind: 'after_refresh', resource: 'core.ledger.entry.get' };
    case 'OWNER_UNAVAILABLE':
      return { kind: 'after_refresh', resource: 'core.ledger.owners.list' };
    case 'CURSOR_EXPIRED':
      return { kind: 'after_refresh', resource: site.operation };
    case 'WRITER_UNAVAILABLE':
      return {
        kind: 'after_refresh',
        resource: LEDGER_WRITER_REFRESH_RESOURCE,
      };
    case 'STORAGE_UNAVAILABLE':
    case 'RATE_LIMITED':
      return site.mode === 'command'
        ? { kind: 'same_idempotency_key' }
        : { kind: 'same_request' };
    case 'INTERNAL':
      return site.mode === 'command'
        ? { kind: 'same_idempotency_key' }
        : { kind: 'never' };
    case 'INVALID_INPUT':
    case 'NOT_FOUND':
    case 'FORBIDDEN':
    case 'TERMINAL_ENTRY':
    case 'SCOPE_RETIRED':
    case 'IDEMPOTENCY_KEY_REUSED':
    case 'UNSUPPORTED_SCHEMA':
      return { kind: 'never' };
  }
}

function withoutCurrentEntry(details: LedgerErrorDetails): LedgerErrorDetails {
  return {
    reason: details.reason,
    ...(details.field === undefined ? {} : { field: details.field }),
    ...(details.limit === undefined ? {} : { limit: details.limit }),
  };
}

/**
 * Details as plain JSON of this realm, within the envelope's size bound.
 * Worker replies are structured clones whose objects need not share this
 * module's prototypes, which the envelope rejects, so they are rebuilt. A
 * current entry from another ledger, or one too large for the bound, is
 * dropped.
 */
export function boundLedgerErrorDetails(
  reason: LedgerErrorReason,
  raw: unknown,
  ledgerId?: string,
): LedgerErrorDetails {
  let plain: unknown;
  try {
    plain = raw === undefined ? undefined : JSON.parse(JSON.stringify(raw));
  } catch {
    plain = undefined;
  }
  const parsed = LedgerErrorDetailsSchema.safeParse(plain);
  if (!parsed.success || parsed.data.reason !== reason) return { reason };
  const details = parsed.data;
  if (details.currentEntry === undefined) return details;
  if (
    ledgerId === undefined ||
    details.currentEntry.scope.ledgerId !== ledgerId ||
    !isBoundedCanopyJsonValue(details)
  ) {
    return withoutCurrentEntry(details);
  }
  return details;
}

export interface LedgerErrorOptions {
  readonly field?: string;
  readonly limit?: number;
  readonly message?: string;
}

/** A Ledger failure the service itself detected. */
export function ledgerOperationError(
  reason: LedgerErrorReason,
  site: LedgerErrorSite,
  options: LedgerErrorOptions = {},
): CanopyOperationError {
  return new CanopyOperationError({
    kind: KIND_BY_REASON[reason],
    message: options.message ?? MESSAGE_BY_REASON[reason],
    code: LEDGER_ERROR_CODES[reason],
    details: {
      reason,
      ...(options.field === undefined ? {} : { field: options.field }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    },
    retry: retryFor(reason, site),
  });
}

/**
 * The flag is off: the operation is unavailable until a refresh, exactly as
 * it was before the store existed.
 */
export function ledgerDisabledError(
  site: LedgerErrorSite,
): CanopyOperationError {
  return ledgerOperationError('WRITER_UNAVAILABLE', site, {
    message: 'The Feed is not available.',
  });
}

function storageError(
  error: LedgerStorageHostError,
  site: LedgerErrorSite,
): CanopyOperationError {
  const reason = error.reason;
  if (reason === 'INTERNAL') {
    return new CanopyOperationError(
      {
        kind: KIND_BY_REASON.INTERNAL,
        message: MESSAGE_BY_REASON.INTERNAL,
        retry: retryFor(reason, site),
      },
      error,
    );
  }
  return new CanopyOperationError(
    {
      kind: KIND_BY_REASON[reason],
      message: MESSAGE_BY_REASON[reason],
      code: LEDGER_ERROR_CODES[reason],
      details: boundLedgerErrorDetails(reason, error.details, site.ledgerId),
      retry: retryFor(reason, site),
    },
    error,
  );
}

/**
 * Converts anything a Ledger operation threw into the core error envelope.
 * Envelope errors pass through; storage errors map by reason; anything else is
 * an internal failure whose outcome, for a command, is unknown.
 */
export function toLedgerOperationError(
  error: unknown,
  site: LedgerErrorSite,
): CanopyOperationError {
  if (error instanceof CanopyOperationError) return error;
  if (error instanceof LedgerStorageHostError) return storageError(error, site);
  return new CanopyOperationError(
    {
      kind: KIND_BY_REASON.INTERNAL,
      message: MESSAGE_BY_REASON.INTERNAL,
      retry: retryFor('INTERNAL', site),
    },
    error,
  );
}
