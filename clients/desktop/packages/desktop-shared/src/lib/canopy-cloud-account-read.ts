import type { CanopyCloudAccountPublicState } from '../types';
import { isGuestAccount } from './guest-account';

/**
 * Whether a loaded Canopy Cloud account snapshot is an *authoritative* answer
 * about who is signed in.
 *
 * The main process collapses a `unavailable` / `error` secure-store read into a
 * `null` entry, which serializes into a shape indistinguishable from a real
 * sign-out (`hasApiKey: false`, no `account`, `authMode: null`). Because the
 * read is cached only briefly, any ambient re-probe (window focus / visibility,
 * via `CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT`) past that TTL goes back to disk and
 * re-decrypts — so a single transient failure would otherwise flip a signed-in
 * user's UI to a signed-out/disconnected state.
 *
 * Any surface that re-reads the account on that ambient event and holds
 * last-known-good state should gate on this rather than re-deriving the rule:
 *
 * ```ts
 * if (!isConclusiveAccountRead(next)) return; // hold last-known-good
 * ```
 *
 * A genuinely absent account file reports `read: 'ok'` (the store maps `ENOENT`
 * to an ok/empty result), so a real sign-out still returns `true` here and is
 * applied normally. Snapshots produced before `read` existed omit the field and
 * are treated as conclusive, preserving prior behavior.
 */
export function isConclusiveAccountRead(
  account: Pick<CanopyCloudAccountPublicState, 'read'>,
): boolean {
  return account.read == null || account.read === 'ok';
}

/**
 * Who a conclusive account read says is signed in, as a key to compare across
 * reads: the account (or, until the account is known, its API key or sign-in
 * method) and whether it is a guest. Null when signed out.
 *
 * Surfaces that keep state for whoever is signed in reset it when this
 * changes, after first checking {@link isConclusiveAccountRead}.
 */
export function canopyCloudAccountIdentity(
  account: Pick<
    CanopyCloudAccountPublicState,
    'hasApiKey' | 'account' | 'serverApiKeyId' | 'authMode' | 'credentialSource'
  >,
): string | null {
  return account.hasApiKey
    ? JSON.stringify([
        account.account?.id ?? account.serverApiKeyId ?? account.authMode,
        isGuestAccount(account),
      ])
    : null;
}
