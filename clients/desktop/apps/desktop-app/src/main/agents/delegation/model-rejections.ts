/**
 * Models a provider refused for the signed-in account at delegated launch,
 * such as a Codex model that a ChatGPT plan does not include. Discovery reads
 * this so it stops advertising a model the account cannot run. In memory
 * only: a restart, or the time-to-live, lets discovery offer the model again.
 */

/** How long a rejection is remembered. Plans and model access change rarely. */
export const DELEGATION_MODEL_REJECTION_TTL_MS = 24 * 60 * 60 * 1000;

/** Bounds the cache; the oldest rejection is forgotten first. */
const MAX_REJECTIONS = 256;

/** Stands in for an account whose identity was not cached at launch. */
const UNKNOWN_ACCOUNT = 'unknown-account';

interface DelegationModelRejectionKey {
  /** The route's `authAccountKey`; absent when the identity was not cached. */
  readonly accountKey?: string;
  readonly modelId: string;
}

const rejections = new Map<string, number>();

function cacheKey(key: DelegationModelRejectionKey): string {
  return JSON.stringify([key.accountKey ?? UNKNOWN_ACCOUNT, key.modelId]);
}

/** Remembers that the provider refused this model for this account. */
export function recordDelegationModelRejection(
  key: DelegationModelRejectionKey,
  now: number = Date.now(),
): void {
  if (!key.modelId) return;
  const id = cacheKey(key);
  rejections.delete(id);
  rejections.set(id, now + DELEGATION_MODEL_REJECTION_TTL_MS);
  for (const [stale, expiresAt] of Array.from(rejections))
    if (expiresAt <= now) rejections.delete(stale);
  while (rejections.size > MAX_REJECTIONS) {
    const oldest = rejections.keys().next();
    if (oldest.done) break;
    rejections.delete(oldest.value);
  }
}

/** Whether the provider refused this model for this account recently. */
export function isDelegationModelRejected(
  key: DelegationModelRejectionKey,
  now: number = Date.now(),
): boolean {
  const id = cacheKey(key);
  const expiresAt = rejections.get(id);
  if (expiresAt === undefined) return false;
  if (expiresAt > now) return true;
  rejections.delete(id);
  return false;
}

/** Forgets every remembered rejection. */
export function clearDelegationModelRejections(): void {
  rejections.clear();
}
