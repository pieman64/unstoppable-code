/**
 * Wire contract for install subscriptions on shared items.
 *
 * Desktop registers the shared items a signed-in user installs (and later
 * uninstalls) so web can email them when the owner publishes an update. The
 * email worker is framework-free and keeps its own copy of the kind enum,
 * pinned to {@link SHARED_ITEM_KINDS} by a test.
 *
 * Every parser here is strict: a missing, extra or wrong-typed field returns
 * `null`.
 */

export const SHARED_ITEM_KINDS = [
  'skill',
  'pipeline',
  'automation',
  'collection',
  'agent',
  'workspace-template',
] as const;

export type SharedItemKind = (typeof SHARED_ITEM_KINDS)[number];

/**
 * `shared` items are reached through a team or organization share and are
 * addressed by the item's `externalId`. `public` items are reached through a
 * public share link.
 */
export const SHARED_ITEM_SOURCE_KINDS = ['shared', 'public'] as const;

export type SharedItemSourceKind = (typeof SHARED_ITEM_SOURCE_KINDS)[number];

/** Upper bound on upserts plus removals in one batch request. */
export const MAX_SHARED_ITEM_BATCH_SIZE = 200;

/** Matches the `shared_item_installs.source_key` column width. */
export const MAX_SHARED_ITEM_SOURCE_KEY_LENGTH = 128;

const MAX_REMOTE_ID_LENGTH = 256;
const MAX_CONTENT_HASH_LENGTH = 256;
const SOURCE_KEY_PATTERN = /^(desktop|cloud):[A-Za-z0-9._:-]+$/;

export interface SharedItemInstallRemoval {
  kind: SharedItemKind;
  remoteId: string;
  sourceKind: SharedItemSourceKind;
  /** `desktop:<clientDeviceId>` or `cloud:<cloudWorkspaceExternalId>`. */
  sourceKey: string;
}

export interface SharedItemInstallUpsert extends SharedItemInstallRemoval {
  /**
   * The content hash the installer holds, or `null` when it is unknown (a
   * backfilled install). The server records the live hash for `null`.
   */
  contentHash: string | null;
}

export interface SharedItemSubscriptionBatch {
  upserts: SharedItemInstallUpsert[];
  removals: SharedItemInstallRemoval[];
}

export const SHARED_ITEM_SUBSCRIPTION_ERROR_CODES = [
  'not-found',
  'forbidden',
  'invalid',
  'error',
] as const;

export type SharedItemSubscriptionErrorCode =
  (typeof SHARED_ITEM_SUBSCRIPTION_ERROR_CODES)[number];

export type SharedItemSubscriptionItemResult =
  | { ok: true }
  | { ok: false; code: SharedItemSubscriptionErrorCode };

/** Results in the same order as the request's `upserts` and `removals`. */
export interface SharedItemSubscriptionBatchResult {
  upserts: SharedItemSubscriptionItemResult[];
  removals: SharedItemSubscriptionItemResult[];
}

/**
 * Per-item codes that will never succeed on retry. Desktop marks these synced
 * instead of re-sending them. `error` is transient.
 */
export function isPermanentSharedItemSubscriptionError(
  code: SharedItemSubscriptionErrorCode,
): boolean {
  return code !== 'error';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

function isBoundedString(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    value.trim() === value
  );
}

export function parseSharedItemKind(value: unknown): SharedItemKind | null {
  return SHARED_ITEM_KINDS.find((kind) => kind === value) ?? null;
}

export function parseSharedItemSourceKind(
  value: unknown,
): SharedItemSourceKind | null {
  return SHARED_ITEM_SOURCE_KINDS.find((kind) => kind === value) ?? null;
}

export function isValidSharedItemSourceKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_SHARED_ITEM_SOURCE_KEY_LENGTH &&
    SOURCE_KEY_PATTERN.test(value)
  );
}

const REMOVAL_KEYS = ['kind', 'remoteId', 'sourceKind', 'sourceKey'] as const;
const UPSERT_KEYS = [...REMOVAL_KEYS, 'contentHash'] as const;

function parseRemovalFields(
  value: Record<string, unknown>,
): SharedItemInstallRemoval | null {
  const kind = parseSharedItemKind(value.kind);
  const sourceKind = parseSharedItemSourceKind(value.sourceKind);
  if (kind === null || sourceKind === null) return null;
  if (!isBoundedString(value.remoteId, MAX_REMOTE_ID_LENGTH)) return null;
  if (!isValidSharedItemSourceKey(value.sourceKey)) return null;
  return {
    kind,
    remoteId: value.remoteId,
    sourceKind,
    sourceKey: value.sourceKey,
  };
}

export function parseSharedItemInstallRemoval(
  value: unknown,
): SharedItemInstallRemoval | null {
  if (!isPlainRecord(value) || !hasExactKeys(value, REMOVAL_KEYS)) return null;
  return parseRemovalFields(value);
}

export function parseSharedItemInstallUpsert(
  value: unknown,
): SharedItemInstallUpsert | null {
  if (!isPlainRecord(value) || !hasExactKeys(value, UPSERT_KEYS)) return null;
  const removal = parseRemovalFields(value);
  if (removal === null) return null;
  const { contentHash } = value;
  if (
    contentHash !== null &&
    !isBoundedString(contentHash, MAX_CONTENT_HASH_LENGTH)
  ) {
    return null;
  }
  return { ...removal, contentHash };
}

/**
 * Parse a batch body. Returns `null` for any malformed entry. Size is not
 * checked here so the route can answer an oversize batch distinctly; use
 * {@link isSharedItemSubscriptionBatchOversize}.
 */
export function parseSharedItemSubscriptionBatch(
  value: unknown,
): SharedItemSubscriptionBatch | null {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['upserts', 'removals'])) {
    return null;
  }
  const { upserts, removals } = value;
  if (!Array.isArray(upserts) || !Array.isArray(removals)) return null;
  const parsedUpserts: SharedItemInstallUpsert[] = [];
  for (const entry of upserts) {
    const parsed = parseSharedItemInstallUpsert(entry);
    if (parsed === null) return null;
    parsedUpserts.push(parsed);
  }
  const parsedRemovals: SharedItemInstallRemoval[] = [];
  for (const entry of removals) {
    const parsed = parseSharedItemInstallRemoval(entry);
    if (parsed === null) return null;
    parsedRemovals.push(parsed);
  }
  return { upserts: parsedUpserts, removals: parsedRemovals };
}

export function isSharedItemSubscriptionBatchOversize(
  batch: SharedItemSubscriptionBatch,
): boolean {
  return (
    batch.upserts.length + batch.removals.length > MAX_SHARED_ITEM_BATCH_SIZE
  );
}

export function parseSharedItemSubscriptionItemResult(
  value: unknown,
): SharedItemSubscriptionItemResult | null {
  if (!isPlainRecord(value)) return null;
  if (value.ok === true && hasExactKeys(value, ['ok'])) return { ok: true };
  if (value.ok !== false || !hasExactKeys(value, ['ok', 'code'])) return null;
  const code = SHARED_ITEM_SUBSCRIPTION_ERROR_CODES.find(
    (candidate) => candidate === value.code,
  );
  return code === undefined ? null : { ok: false, code };
}

export function parseSharedItemSubscriptionBatchResult(
  value: unknown,
): SharedItemSubscriptionBatchResult | null {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['upserts', 'removals'])) {
    return null;
  }
  const { upserts, removals } = value;
  if (!Array.isArray(upserts) || !Array.isArray(removals)) return null;
  const parsedUpserts: SharedItemSubscriptionItemResult[] = [];
  for (const entry of upserts) {
    const parsed = parseSharedItemSubscriptionItemResult(entry);
    if (parsed === null) return null;
    parsedUpserts.push(parsed);
  }
  const parsedRemovals: SharedItemSubscriptionItemResult[] = [];
  for (const entry of removals) {
    const parsed = parseSharedItemSubscriptionItemResult(entry);
    if (parsed === null) return null;
    parsedRemovals.push(parsed);
  }
  return { upserts: parsedUpserts, removals: parsedRemovals };
}

/** The desktop ledger key for one installed item. */
export function sharedItemSubscriptionKey(item: {
  kind: SharedItemKind;
  sourceKind: SharedItemSourceKind;
  remoteId: string;
}): string {
  return `${item.kind}:${item.sourceKind}:${item.remoteId}`;
}
