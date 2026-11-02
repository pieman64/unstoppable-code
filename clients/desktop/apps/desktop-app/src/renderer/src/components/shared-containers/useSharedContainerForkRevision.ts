/**
 * The readable revision a fork dialog may copy (CAN-4908).
 *
 * Both entry points hand the dialog the same shape: the viewer derives it from
 * the replica it is displaying, and a row menu resolves it when its dialog
 * opens and then follows main's replica broadcasts. The dialog pins one
 * revision for review and compares later values against it; it never treats
 * this value as the one to submit.
 */
import { useEffect, useState } from 'react';
import type { SharedContainerRevisionPackage } from '@canopy/protocol/shared-containers';
import type { SharedContainerReplicaState } from '@canopy/desktop-shared/types';

export type SharedContainerForkRevision =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | {
      status: 'available';
      revisionId: string;
      revisionCreatedAt: string;
      capabilityPackage?: SharedContainerRevisionPackage;
    };

export function forkRevisionFromReplica(
  replica: SharedContainerReplicaState | null,
): SharedContainerForkRevision {
  return replica?.status === 'available' || replica?.status === 'pinned'
    ? {
        status: 'available',
        revisionId: replica.revisionId,
        revisionCreatedAt: replica.revisionCreatedAt,
        capabilityPackage: replica.package,
      }
    : { status: 'unavailable' };
}

/** Main's current readable revision; a failed read is not a readable one. */
export async function readForkRevision(
  containerId: string,
): Promise<SharedContainerForkRevision> {
  try {
    return forkRevisionFromReplica(
      await window.api.sharedContainers.getReplicaState({ containerId }),
    );
  } catch {
    return { status: 'unavailable' };
  }
}

/**
 * Row-menu host: resolves when `enabled` turns on (the dialog opening, not the
 * menu) and follows broadcasts for `containerId` until it turns off.
 */
export function useSharedContainerForkRevision(
  containerId: string,
  enabled: boolean,
): SharedContainerForkRevision {
  const [selection, setSelection] = useState<{
    containerId: string;
    revision: SharedContainerForkRevision;
  }>({ containerId, revision: { status: 'loading' } });

  useEffect(() => {
    const setRevision = (revision: SharedContainerForkRevision): void => {
      setSelection({ containerId, revision });
    };
    setRevision({ status: 'loading' });
    if (!enabled) return;
    let canceled = false;
    // A broadcast is newer than a read that was already in flight when it
    // arrived, so the read must not overwrite it.
    let broadcastSeen = false;
    const unsubscribe = window.api.sharedContainers.onReplicaChanged(
      (event) => {
        if (canceled) return;
        if ('purged' in event) {
          if (event.purged === 'container' && event.containerId !== containerId)
            return;
          broadcastSeen = true;
          setRevision({ status: 'unavailable' });
          return;
        }
        if (event.containerId !== containerId) return;
        broadcastSeen = true;
        setRevision(forkRevisionFromReplica(event));
      },
    );
    void readForkRevision(containerId).then((current) => {
      if (!canceled && !broadcastSeen) setRevision(current);
    });
    return (): void => {
      canceled = true;
      unsubscribe();
    };
  }, [containerId, enabled]);

  return enabled && selection.containerId === containerId
    ? selection.revision
    : { status: 'loading' };
}
