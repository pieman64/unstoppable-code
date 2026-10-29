import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SharedContainerForkRequest } from '@canopy/protocol/shared-containers';
import { getSharedContainerReconciliationService } from '../reconciliation-service';
import { BORROWED_CHECKOUT_MARKER } from '../replica/manager';

export async function withSharedContainerForkGuard<T>(
  request: SharedContainerForkRequest,
  operation: (revisionRoot: string) => Promise<T>,
): Promise<T> {
  return getSharedContainerReconciliationService().withReplicaReadGuard(
    request.containerId,
    request.organizationId,
    request.revisionId,
    async (revisionRoot) => {
      await assertRevisionCheckoutNotBorrowed(revisionRoot);
      return operation(revisionRoot);
    },
  );
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
