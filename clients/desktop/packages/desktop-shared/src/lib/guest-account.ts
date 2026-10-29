import type {
  CanopyCloudAuthMode,
  CanopyCloudCredentialSource,
} from '../types';

/**
 * Whether a saved Canopy Cloud credential is a consented guest device
 * credential (CAN-936). A guest is minted with both `credentialSource: 'guest'`
 * and `authMode: 'guest'`, but legacy / normalized entries can carry
 * `authMode: 'guest'` without `credentialSource: 'guest'`, so the defensive OR
 * across both fields is the canonical guest signal.
 *
 * This is the single source of truth for guest detection shared by the desktop
 * main process and renderer (the renderer additionally wraps it in the
 * `useIsGuestCredential` hook for event-driven re-reads). A guest holds a
 * synthetic `guest+<uuid>@guest.canopy.invalid` identity that resolves as a
 * real cloud user, so any surface that would otherwise treat a resolved cloud
 * account as a real Unstoppable Domains identity must special-case it.
 *
 * New guest checks should call this rather than hand-writing the OR: a
 * normalized guest can carry `authMode: 'guest'` with `credentialSource:
 * 'manual'` (the account store's `normalizeCredentialSource` falls back to
 * 'manual' for unrecognized values), so a `credentialSource`-only check misses
 * it and can re-leak the synthetic email.
 */
export function isGuestAccount(
  account:
    | {
        authMode?: CanopyCloudAuthMode | null;
        credentialSource?: CanopyCloudCredentialSource | null;
      }
    | null
    | undefined,
): boolean {
  return account?.credentialSource === 'guest' || account?.authMode === 'guest';
}

/**
 * Opaque identity of a saved Canopy Cloud credential's account, or null when
 * there is none to name.
 *
 * Used to bind account-scoped answers (model-library access, a pending unlock)
 * to the account they describe, so a value read for one account is never shown
 * or acted on for another. Shared by main and the renderer so both sides derive
 * the same key from the same snapshot.
 *
 * The guest marker is part of the key on purpose. A guest who signs in can
 * keep the same server user id, and an answer about the guest must not carry
 * across that transition as if it described the signed-in account.
 */
export function cloudAccountIdentityKey(
  account:
    | {
        authMode?: CanopyCloudAuthMode | null;
        credentialSource?: CanopyCloudCredentialSource | null;
        serverApiKeyId?: string;
        account?: { id: string };
      }
    | null
    | undefined,
): string | null {
  if (!account) return null;
  const id = account.account?.id ?? account.serverApiKeyId;
  if (!id) return null;
  return `${isGuestAccount(account) ? 'guest' : 'account'}:${id}`;
}
