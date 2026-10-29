import {
  LEDGER_ERROR_CODES,
  type LedgerEntry,
  type LedgerErrorCode,
  type LedgerErrorDetails,
  type LedgerErrorReason,
} from '@canopy/protocol/canopy-core';

/**
 * Fixed, content-free messages. Store errors never carry entry text, file
 * paths, database paths or identifiers in their message, so hosts may log the
 * message and reason without redaction.
 */
const LEDGER_STORE_ERROR_MESSAGES: {
  readonly [Reason in LedgerErrorReason]: string;
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
  WRITER_UNAVAILABLE: 'Another process holds the Feed database.',
};

/** Longest `field` accepted by the protocol's `LedgerErrorDetails`. */
const FIELD_MAX_LENGTH = 256;

export interface LedgerStoreErrorOptions {
  /** Offending request field, such as `referenceFiles.0.path`. */
  readonly field?: string;
  /** Limit the field exceeded, when one applies. */
  readonly limit?: number;
  /**
   * The current entry projection. Set only for `REVISION_CONFLICT` and
   * `TERMINAL_ENTRY`, after the entry was found in the caller's ledger.
   */
  readonly currentEntry?: LedgerEntry;
  /**
   * Content-free diagnostic such as `sqlite_13` or `ENOSPC`. Safe to log; it
   * never contains text, paths or identifiers.
   */
  readonly diagnosticCode?: string;
}

/** The single typed error thrown by the local Ledger store. */
export class LedgerStoreError extends Error {
  readonly reason: LedgerErrorReason;
  readonly code: LedgerErrorCode;
  readonly field: string | undefined;
  readonly limit: number | undefined;
  readonly currentEntry: LedgerEntry | undefined;
  readonly diagnosticCode: string | undefined;

  constructor(
    reason: LedgerErrorReason,
    options: LedgerStoreErrorOptions = {},
  ) {
    super(LEDGER_STORE_ERROR_MESSAGES[reason]);
    this.name = 'LedgerStoreError';
    this.reason = reason;
    this.code = LEDGER_ERROR_CODES[reason];
    this.field =
      options.field === undefined || options.field.length === 0
        ? undefined
        : options.field.slice(0, FIELD_MAX_LENGTH);
    this.limit = options.limit;
    this.currentEntry = options.currentEntry;
    this.diagnosticCode = options.diagnosticCode;
  }

  /** Bounded details in the protocol's `LedgerErrorDetails` shape. */
  toDetails(): LedgerErrorDetails {
    return {
      reason: this.reason,
      ...(this.field === undefined ? {} : { field: this.field }),
      ...(this.limit === undefined ? {} : { limit: this.limit }),
      ...(this.currentEntry === undefined
        ? {}
        : { currentEntry: this.currentEntry }),
    };
  }
}

export function isLedgerStoreError(value: unknown): value is LedgerStoreError {
  return value instanceof LedgerStoreError;
}

function numericProperty(value: unknown, key: string): number | null {
  if (typeof value !== 'object' || value === null || !(key in value)) {
    return null;
  }
  const property: unknown = Reflect.get(value, key);
  return typeof property === 'number' ? property : null;
}

function stringProperty(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null || !(key in value)) {
    return null;
  }
  const property: unknown = Reflect.get(value, key);
  return typeof property === 'string' ? property : null;
}

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

/** True when SQLite reported that another connection holds the database. */
export function isSqliteLockContention(error: unknown): boolean {
  const code = numericProperty(error, 'errcode');
  if (code === null) return false;
  // Extended result codes keep the primary code in the low byte.
  const primary = code & 0xff;
  return primary === SQLITE_BUSY || primary === SQLITE_LOCKED;
}

/** Content-free diagnostic code for an unexpected storage error. */
export function storageDiagnosticCode(error: unknown): string {
  const sqliteCode = numericProperty(error, 'errcode');
  if (sqliteCode !== null) return `sqlite_${sqliteCode}`;
  const systemCode = stringProperty(error, 'code');
  if (systemCode !== null && /^E[A-Z0-9]{1,31}$/.test(systemCode)) {
    return systemCode;
  }
  return 'unexpected';
}

/**
 * Maps any thrown value to a `LedgerStoreError`. Lock contention becomes
 * `WRITER_UNAVAILABLE`; everything else unexpected becomes the given fallback
 * reason with a content-free diagnostic code.
 */
export function toLedgerStoreError(
  error: unknown,
  fallback: 'STORAGE_UNAVAILABLE' | 'UNSUPPORTED_SCHEMA',
): LedgerStoreError {
  if (isLedgerStoreError(error)) return error;
  if (isSqliteLockContention(error)) {
    return new LedgerStoreError('WRITER_UNAVAILABLE', {
      diagnosticCode: storageDiagnosticCode(error),
    });
  }
  return new LedgerStoreError(fallback, {
    diagnosticCode: storageDiagnosticCode(error),
  });
}
