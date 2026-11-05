import {
  LedgerErrorReasonSchema,
  type CanopyJsonValue,
  type LedgerErrorReason,
} from '@canopy/protocol/canopy-core';
import { isRecord } from '../lib/type-guards';
import type { LedgerStorageClient } from './ledger-store-client';

/*
 * Private, same-process message contract between the Ledger storage host on the
 * Electron main thread and the storage worker thread that holds the only
 * connection to the Ledger database. It transports repository calls and their
 * outcomes; Ledger policy stays in the core service.
 */

/** The `workerData` the host starts the storage worker with. */
export interface LedgerStorageWorkerData {
  dbPath: string;
}

/** A Ledger error reason, or `INTERNAL` for a failure with no Ledger meaning. */
export type LedgerStorageErrorReason = LedgerErrorReason | 'INTERNAL';

/**
 * A failure the worker reports. `details` must be plain JSON data: no
 * `undefined` values, class instances or cycles. `message` never carries
 * entry text or paths; `details` carries them only as the protocol
 * `currentEntry` of a `REVISION_CONFLICT` or `TERMINAL_ENTRY` store error.
 */
export interface LedgerStorageError {
  reason: LedgerStorageErrorReason;
  message: string;
  details?: CanopyJsonValue;
}

/** Host to worker. The host sends one request at a time, in FIFO order. */
export interface LedgerStorageRequest {
  id: number;
  method: string;
  args: unknown;
}

export interface LedgerStorageSuccessResponse {
  id: number;
  ok: true;
  result: unknown;
}

export interface LedgerStorageFailureResponse {
  id: number;
  ok: false;
  error: LedgerStorageError;
}

/** Worker to host: the outcome of the request with the same `id`. */
export type LedgerStorageResponse =
  | LedgerStorageSuccessResponse
  | LedgerStorageFailureResponse;

/**
 * Worker to host, sent once after the worker tries to open the database and
 * before any response.
 */
export type LedgerStorageStartupMessage =
  | { type: 'ready' }
  | { type: 'openFailed'; error: LedgerStorageError };

// Deep enough for any Ledger error details; a cycle exceeds it and is rejected.
const MAX_DETAILS_DEPTH = 32;

function isRequestId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isJsonValue(value: unknown, depth: number): value is CanopyJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || depth >= MAX_DETAILS_DEPTH) return false;
  if (Array.isArray(value)) {
    return value.every((item: unknown): boolean =>
      isJsonValue(item, depth + 1),
    );
  }
  // A plain object from any realm: structured clone builds messages with the
  // receiving context's Object.prototype, which need not be this module's.
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && Object.getPrototypeOf(prototype) !== null) {
    return false;
  }
  return Object.values(value).every((item: unknown): boolean =>
    isJsonValue(item, depth + 1),
  );
}

export function isLedgerStorageErrorReason(
  value: unknown,
): value is LedgerStorageErrorReason {
  return (
    value === 'INTERNAL' || LedgerErrorReasonSchema.safeParse(value).success
  );
}

export function isLedgerStorageError(
  value: unknown,
): value is LedgerStorageError {
  return (
    isRecord(value) &&
    isLedgerStorageErrorReason(value.reason) &&
    typeof value.message === 'string' &&
    (value.details === undefined || isJsonValue(value.details, 0))
  );
}

export function isLedgerStorageWorkerData(
  value: unknown,
): value is LedgerStorageWorkerData {
  return (
    isRecord(value) &&
    typeof value.dbPath === 'string' &&
    value.dbPath.length > 0
  );
}

export function isLedgerStorageRequest(
  value: unknown,
): value is LedgerStorageRequest {
  return (
    isRecord(value) &&
    isRequestId(value.id) &&
    typeof value.method === 'string' &&
    value.method.length > 0 &&
    'args' in value
  );
}

export function isLedgerStorageResponse(
  value: unknown,
): value is LedgerStorageResponse {
  if (!isRecord(value) || !isRequestId(value.id)) return false;
  if (value.ok === true) return 'result' in value;
  return value.ok === false && isLedgerStorageError(value.error);
}

export function isLedgerStorageStartupMessage(
  value: unknown,
): value is LedgerStorageStartupMessage {
  if (!isRecord(value)) return false;
  if (value.type === 'ready') return true;
  return value.type === 'openFailed' && isLedgerStorageError(value.error);
}

/** The `id` of a message, when it carries one a response can answer. */
export function readLedgerStorageRequestId(value: unknown): number | undefined {
  return isRecord(value) && isRequestId(value.id) ? value.id : undefined;
}

/**
 * How one storage method argument travels in `args`: `'input'` is a
 * plain-object repository input (or container) and `'id'` a string ID.
 */
type LedgerStorageArgumentKind = 'input' | 'id';

type LedgerStorageArgumentKindOf<Argument> = Argument extends string
  ? 'id'
  : Argument extends object
    ? 'input'
    : never;

type LedgerStorageArgumentKinds<Args extends readonly unknown[]> = {
  readonly [Index in keyof Args]: LedgerStorageArgumentKindOf<Args[Index]>;
};

/**
 * The storage methods and the wire encoding of their arguments. Each method
 * runs the `LedgerRepository` method of the same name; `getAuthorityId` reads
 * `authorityId`. A request's `args` is always an array of the method's
 * positional arguments, in order and of the kinds listed here, so
 * `getScope(ledgerId)` travels as `[ledgerId]` and `getStorageCounts()` as
 * `[]`. The type check keeps this table in step with `LedgerStoreClient`.
 */
const LEDGER_STORAGE_METHODS = {
  getAuthorityId: [],
  bindScope: ['input'],
  findScope: ['input'],
  bindGlobalScope: ['input'],
  findGlobalScope: ['input'],
  getScope: ['id'],
  registerActor: ['input'],
  listActors: ['id'],
  addEntry: ['input'],
  listPendingTitles: [],
  recordPendingTitleAttempt: ['input'],
  resolvePendingTitle: ['input'],
  updateEntry: ['input'],
  handBackEntry: ['input'],
  publishSummary: ['input'],
  listReceiptKeys: ['input'],
  getEntry: ['input'],
  searchEntries: ['input'],
  listChanges: ['input'],
  listRollups: ['input'],
  getWorkSummary: ['input'],
  getStorageCounts: [],
  listScopes: [],
  findContainerScopes: ['input'],
  setScopeLifecycle: ['input'],
  rebindScope: ['input'],
  purgeScope: ['id'],
  listSyncScopes: [],
  getScopeSync: ['id'],
  readOutbox: ['input'],
  acknowledgeOutbox: ['input'],
  recordMirrorAudience: ['input'],
  setScopeRepair: ['input'],
  rebindAccount: ['input'],
} as const satisfies {
  readonly [Method in keyof LedgerStorageClient]: LedgerStorageArgumentKinds<
    Parameters<LedgerStorageClient[Method]>
  >;
};

export type LedgerStorageMethod = keyof typeof LEDGER_STORAGE_METHODS;

/** The positional arguments of each storage method, as `args` carries them. */
export type LedgerStorageArguments = {
  readonly [Method in LedgerStorageMethod]: Parameters<
    LedgerStorageClient[Method]
  >;
};

const LEDGER_STORAGE_METHOD_NAMES: ReadonlySet<string> = new Set(
  Object.keys(LEDGER_STORAGE_METHODS),
);

export function isLedgerStorageMethod(
  value: string,
): value is LedgerStorageMethod {
  return LEDGER_STORAGE_METHOD_NAMES.has(value);
}

/** A plain object from any realm, like the objects structured clone builds. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

/**
 * True when `args` follows the encoding of `method`: an array with exactly one
 * argument per parameter, each of the listed kind. The fields of an input are
 * left to the repository, which validates every one of them and reports
 * `INVALID_INPUT` naming the field, as it does for a direct call.
 */
export function isLedgerStorageArguments<Method extends LedgerStorageMethod>(
  method: Method,
  args: unknown,
): args is LedgerStorageArguments[Method] {
  if (!Array.isArray(args)) return false;
  const values: readonly unknown[] = args;
  const kinds: readonly LedgerStorageArgumentKind[] =
    LEDGER_STORAGE_METHODS[method];
  return (
    values.length === kinds.length &&
    kinds.every((kind: LedgerStorageArgumentKind, index: number): boolean =>
      kind === 'id'
        ? typeof values[index] === 'string'
        : isPlainObject(values[index]),
    )
  );
}

function copyJsonArray(
  items: readonly unknown[],
  depth: number,
): CanopyJsonValue[] | undefined {
  const copies: CanopyJsonValue[] = [];
  for (const item of items) {
    const copy = copyJsonValue(item, depth + 1);
    if (copy === undefined) return undefined;
    copies.push(copy);
  }
  return copies;
}

function copyJsonObject(
  value: Record<string, unknown>,
  depth: number,
): CanopyJsonValue | undefined {
  const members: Array<[string, CanopyJsonValue]> = [];
  for (const [key, member] of Object.entries(value)) {
    if (member === undefined) continue;
    const copy = copyJsonValue(member, depth + 1);
    if (copy === undefined) return undefined;
    members.push([key, copy]);
  }
  // Defines own members even for a key such as `__proto__`.
  return Object.fromEntries(members);
}

function copyJsonValue(
  value: unknown,
  depth: number,
): CanopyJsonValue | undefined {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== 'object' || depth >= MAX_DETAILS_DEPTH) {
    return undefined;
  }
  if (Array.isArray(value)) return copyJsonArray(value, depth);
  return isPlainObject(value) ? copyJsonObject(value, depth) : undefined;
}

/**
 * A plain JSON copy of `value` for `LedgerStorageError.details`. Object
 * members whose value is `undefined` are dropped, as `JSON.stringify` drops
 * them. Returns `undefined` when anything else cannot travel as JSON data: a
 * function, symbol, bigint, non-finite number, `undefined` array item, class
 * instance, cycle, or nesting deeper than `isLedgerStorageError` accepts.
 */
export function toLedgerStorageJson(
  value: unknown,
): CanopyJsonValue | undefined {
  return copyJsonValue(value, 0);
}
