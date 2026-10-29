import { CANOPY_CLOUD_SERVER_ID } from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  MarketplaceUnshareError,
  marketplaceUnshareReasonForStatus,
  type MarketplaceUnshareKind,
} from '@canopy/ui-shared/lib/marketplace-unshare';
import { readSharedResourceErrorStatus } from './sharedResourceErrors';

/**
 * Deletes an account share through the existing preload methods, for the
 * shared Marketplace Unshare (CAN-4263). `shareId` is the account share's
 * own identifier: the summary `id` for skills, collections and agents, and
 * the plugin's `externalId` (the preload request's `remoteId`).
 *
 * Resolves only once main confirmed the delete. The plugin channel answers
 * with an `IPCResult` instead of rejecting, so a resolved failure is turned
 * into a rejection here and never reads as success.
 */
export async function unshareMarketplaceResource(
  kind: MarketplaceUnshareKind,
  shareId: string,
): Promise<void> {
  try {
    switch (kind) {
      case 'skill':
        await window.skills.deleteShared({ skillId: shareId });
        return;
      case 'collection':
        await window.collections.deleteShared({ collectionId: shareId });
        return;
      case 'agent':
        await window.agents.deleteShared({ agentId: shareId });
        return;
      case 'plugin': {
        const result = await window.plugins.deleteShared({
          serverId: CANOPY_CLOUD_SERVER_ID,
          remoteId: shareId,
        });
        if (!result.success) throw new Error(result.error ?? 'Unshare failed');
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
