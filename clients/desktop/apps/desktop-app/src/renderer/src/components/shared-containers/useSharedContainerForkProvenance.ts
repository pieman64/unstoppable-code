/**
 * Durable fork provenance for a local container (CAN-2552).
 *
 * Reads the record main wrote next to the destination worktree or Work Entry
 * rather than carrying the fork response around in renderer state. Provenance
 * has to survive a restart. It is the only thing left tying an independent
 * local container back to the share it came from, and the source can be
 * revoked at any time, so the file is the source of truth, not a store.
 *
 * Every non-forked container in the app would ask this question, so a `null`
 * answer is the overwhelmingly common one and must stay silent: no error
 * state, no toast, nothing rendered.
 */
import { useEffect, useState } from 'react';
import type { SharedContainerForkProvenance } from '@canopy/desktop-shared/types';

export function useSharedContainerForkProvenance(
  projectId: string | null,
  worktreeId: string | null,
): SharedContainerForkProvenance | null {
  const [provenance, setProvenance] =
    useState<SharedContainerForkProvenance | null>(null);

  useEffect(() => {
    if (projectId === null || worktreeId === null) {
      setProvenance(null);
      return;
    }
    let canceled = false;
    void window.api.sharedContainers
      .readForkProvenance({ projectId, worktreeId })
      .then((record) => {
        if (!canceled) setProvenance(record);
      })
      .catch(() => {
        // A missing or unreadable record is indistinguishable from "this is
        // not a fork" as far as the UI is concerned, and neither is worth
        // interrupting the user over.
        if (!canceled) setProvenance(null);
      });
    return (): void => {
      canceled = true;
    };
  }, [projectId, worktreeId]);

  return provenance;
}
