import type { ModelLibraryAccess } from '@canopy/protocol/models';

/** Label shared by the account-menu row and the account/organization tabs. */
export const AI_CREDITS_LABEL = 'AI Credits';

/**
 * Whether a balance belongs to a wallet still behind the model-library
 * purchase gate. The gate state stands in for "no purchase yet"; it does not
 * describe where the wallet's credits came from. Unknown access (loading,
 * failed or a host that does not read it) answers `false` rather than
 * guessing. Balance labels no longer depend on it: they always read
 * `AI Credits` (CAN-4769).
 */
export function isFreeOnlyAiCredits(
  access: ModelLibraryAccess | undefined,
): boolean {
  return (
    access === 'needs_purchase' || access === 'needs_sign_in_then_purchase'
  );
}
