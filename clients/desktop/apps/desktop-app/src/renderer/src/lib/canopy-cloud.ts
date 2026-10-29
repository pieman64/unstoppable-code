import type { CanopyCloudAccountPublicState } from '@canopy/desktop-shared/types';

/**
 * Shared "is the Canopy Cloud account fully connected" predicate. A connected
 * account both has an API key persisted and a resolved server account record.
 */
export function isCanopyCloudConnected(
  account: CanopyCloudAccountPublicState | null | undefined,
): boolean {
  return account?.hasApiKey === true && !!account?.account;
}
