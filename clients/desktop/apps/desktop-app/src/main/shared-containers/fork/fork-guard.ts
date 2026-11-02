import {
  SharedContainerReplicaRevisionUnavailableError,
  type SharedContainerReplicaRevisionSnapshot,
} from '../replica/types';
import { SharedContainerForkError } from './destination';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SharedContainerForkRequest } from '@canopy/protocol/shared-containers';
import { getSharedContainerReconciliationService } from '../reconciliation-service';
import { BORROWED_CHECKOUT_MARKER } from '../replica/manager';

export async function withSharedContainerForkGuard<T>(
  request: SharedContainerForkRequest,
  operation: (
    revisionRoot: string,
    revision: SharedContainerReplicaRevisionSnapshot,
  ) => Promise<T>,
): Promise<T> {
  try {
    return await getSharedContainerReconciliationService().withReplicaReadGuard(
      request.containerId,
      request.organizationId,
      request.revisionId,
      async (revisionRoot, revision) => {
        await assertRevisionCheckoutNotBorrowed(revisionRoot);
        return operation(revisionRoot, revision);
      },
    );
  } catch (error) {
    if (!(error instanceof SharedContainerReplicaRevisionUnavailableError))
      throw error;
    throw new SharedContainerForkError(
      'source-unavailable',
      error.reason === 'superseded'
        ? `${request.sourceOwnerDisplayName} published a newer version of this share. Open it again, then make your copy.`
        : 'The share is unavailable. Open the share again before making a copy.',
      { cause: error },
    );
  }
}

export async function assertRevisionCheckoutNotBorrowed(
  revisionRoot: string,
): Promise<void> {
  try {
    await lstat(join(revisionRoot, 'repos', BORROWED_CHECKOUT_MARKER));
    throw new Error(
      'Shared-container revision checkout is temporarily unavailable',
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
