import type {
  CanopyCloudAccountEntry,
  CanopyCloudAccountTransition,
} from '../lib/canopy-cloud-account-store';
import { getObservabilityService } from '../observability';
import { getSharedContainerReconciliationService } from './reconciliation-service';

function recordDeferredCleanup(error: unknown): void {
  try {
    getObservabilityService().recordAppDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'shared_container_org_reconcile_deferred',
      error: error instanceof Error ? error.message : String(error),
    });
  } catch {
    // Best-effort: the diagnostic must never be what fails the account save.
  }
}

/**
 * Same-account transition for a confirmed organization snapshot: purge the
 * replicas of organizations the snapshot no longer lists, then persist it.
 *
 * A replica-store fault must not block the account refresh itself. Keeping the
 * previous snapshot would go on listing organizations the account may have
 * lost and withhold refreshed capabilities, billing states, and enforced
 * settings. So when cleanup fails before persistence starts, the snapshot is
 * persisted anyway and the purge is retried by the next refresh, which
 * recomputes it from the stored snapshot. A failure after persistence started
 * is rethrown unchanged so the account is never written twice. Account-identity
 * changes keep the strict `withReplicaPurgeFence` transition.
 */
export function organizationSnapshotTransition(
  organizationIds: readonly string[],
  personalOrganizationId?: string | null,
): CanopyCloudAccountTransition<CanopyCloudAccountEntry> {
  return async (persist) => {
    let persistStarted = false;
    const trackedPersist = (): Promise<CanopyCloudAccountEntry> => {
      persistStarted = true;
      return persist();
    };
    try {
      return await getSharedContainerReconciliationService().reconcileOrganizationSnapshot(
        personalOrganizationId
          ? [...organizationIds, personalOrganizationId]
          : organizationIds,
        trackedPersist,
      );
    } catch (error) {
      if (persistStarted) throw error;
      recordDeferredCleanup(error);
      return persist();
    }
  };
}
