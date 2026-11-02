import {
  MarketplaceUnshareError,
  marketplaceUnshareReasonForStatus,
  type MarketplaceUnshareKind,
} from '@canopy/ui-shared/lib/marketplace-unshare';
import { readSharedResourceErrorStatus } from './sharedResourceErrors';

/**
 * Removes only the public link of an account share, for the Shared by you
 * public-link row (CAN-4842); the account share stays. `shareId` is the key
 * `unshareMarketplaceResource` sends for the same kind: the summary `id` for
 * skills, collections and agents, and the plugin's `externalId`, which the
 * plugin revoke channel takes as its `remoteId` like the delete channel does.
 *
 * The plugin channel answers with an `IPCResult` instead of rejecting, so a
 * resolved failure is turned into a rejection here and never reads as success.
 */
export async function revokeMarketplacePublicShare(
  kind: MarketplaceUnshareKind,
  shareId: string,
): Promise<void> {
  try {
    switch (kind) {
      case 'skill':
        await window.skills.revokePublicShare(shareId);
        return;
      case 'collection':
        await window.collections.revokePublicShare(shareId);
        return;
      case 'agent':
        await window.agents.revokePublicShare(shareId);
        return;
      case 'plugin': {
        const result = await window.plugins.revokePublicShare(shareId);
        if (!result.success) {
          throw new Error(result.error ?? 'Remove public link failed');
        }
        return;
      }
    }
  } catch (error: unknown) {
    throw new MarketplaceUnshareError(
      marketplaceUnshareReasonForStatus(readSharedResourceErrorStatus(error)),
      error instanceof Error ? error.message : undefined,
    );
  }
}
