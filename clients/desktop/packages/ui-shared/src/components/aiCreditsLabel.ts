import type { ModelLibraryAccess } from '@canopy/protocol/models';

/** Label shared by the account-menu row and the account/organization tabs. */
export const AI_CREDITS_LABEL = 'AI Credits';

/** Balance label for a wallet that has not made its first purchase yet. */
export const FREE_AI_CREDITS_LABEL = 'Free AI Credits';

/**
 * Whether a balance belongs to a wallet still behind the model-library
 * purchase gate. The gate state stands in for "no purchase yet"; it does not
 * describe where the wallet's credits came from. Unknown access (loading,
 * failed or a host that does not read it) answers `false`, so the balance
 * keeps the plain label rather than guessing.
 */
export function isFreeOnlyAiCredits(
  access: ModelLibraryAccess | undefined,
): boolean {
  return (
    access === 'needs_purchase' || access === 'needs_sign_in_then_purchase'
  );
}

/** `Free AI Credits` before the first purchase, `AI Credits` otherwise. */
export function aiCreditsLabel(access: ModelLibraryAccess | undefined): string {
  return isFreeOnlyAiCredits(access) ? FREE_AI_CREDITS_LABEL : AI_CREDITS_LABEL;
}
