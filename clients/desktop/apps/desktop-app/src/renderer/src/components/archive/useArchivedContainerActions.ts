import { useCallback, useRef, useState } from 'react';
import { navigateToRestoredContainerDestination } from '@/lib/archivedContainerNavigation';
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';
import { useGitHubStore } from '@/stores/githubStore';
import {
  ARCHIVED_ITEM_DELETE_FAILED,
  offerRetainedArchiveDiscard,
} from './offerRetainedArchiveDiscard';

export interface ArchivedContainerActions {
  /** True while a Deleted ⇄ Archived state change is in flight. */
  changingState: boolean;
  restoring: boolean;
  deleting: boolean;
  /**
   * Move the container between its two retained states: `true` archives it
   * (locked, kept until the user deletes it), `false` deletes it (unlocked,
   * removed after the retention window restarts from now).
   */
  setArchived: (archived: boolean) => Promise<void>;
  restore: () => Promise<void>;
  deletePermanently: () => Promise<void>;
}

/**
 * One behavior source for archive actions used by the full viewer, the
 * overview page rows, and every archived-container menu.
 */
export function useArchivedContainerActions(
  workspaceId: string,
  containerId: string,
  archived: boolean,
): ArchivedContainerActions {
  const setLocked = useArchivedContainersStore((state) => state.setLocked);
  const restoreContainer = useArchivedContainersStore((state) => state.restore);
  const deleteContainer = useArchivedContainersStore(
    (state) => state.deletePermanently,
  );
  const addToast = useGitHubStore((state) => state.addToast);
  const [changingState, setChangingState] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const changingStateRef = useRef(false);
  const restoringRef = useRef(false);
  const deletingRef = useRef(false);

  const setArchived = useCallback(
    async (nextArchived: boolean): Promise<void> => {
      if (changingStateRef.current || nextArchived === archived) return;
      changingStateRef.current = true;
      setChangingState(true);
      try {
        const result = await setLocked(workspaceId, containerId, nextArchived);
        if (result === null) {
          addToast(
            nextArchived
              ? "Couldn't archive this item"
              : "Couldn't move this item to deleted",
            'error',
          );
        }
      } finally {
        changingStateRef.current = false;
        setChangingState(false);
      }
    },
    [addToast, archived, containerId, setLocked, workspaceId],
  );

  const restore = useCallback(async (): Promise<void> => {
    if (restoringRef.current) return;
    restoringRef.current = true;
    setRestoring(true);
    try {
      const result = await restoreContainer(workspaceId, containerId);
      if (result === null) {
        addToast("Couldn't restore this item", 'error');
        return;
      }
      if (result.warnings.length > 0) {
        addToast(result.warnings.join(' — '), 'warning', undefined, {
          category: result.kind === 'worktree' ? 'Worktree' : 'Chat',
        });
      }
      const stillPresent =
        useArchivedContainersStore
          .getState()
          .byWorkspace[
            workspaceId
          ]?.some((entry) => entry.id === containerId) ?? false;
      if (!stillPresent) {
        await navigateToRestoredContainerDestination(workspaceId, result);
      }
    } finally {
      restoringRef.current = false;
      setRestoring(false);
    }
  }, [addToast, containerId, restoreContainer, workspaceId]);

  const deletePermanently = useCallback(async (): Promise<void> => {
    const run = async (): Promise<void> => {
      if (deletingRef.current) return;
      deletingRef.current = true;
      setDeleting(true);
      try {
        const ok = await deleteContainer(workspaceId, containerId);
        // CAN-5338: a retained worktree whose deletion can't finish offers
        // its discard, whose Retry runs this again; anything else keeps the
        // toast.
        if (
          !ok &&
          !(await offerRetainedArchiveDiscard(workspaceId, containerId, () => {
            void run();
          }))
        ) {
          addToast(ARCHIVED_ITEM_DELETE_FAILED, 'error');
        }
      } finally {
        deletingRef.current = false;
        setDeleting(false);
      }
    };
    await run();
  }, [addToast, containerId, deleteContainer, workspaceId]);

  return {
    changingState,
    restoring,
    deleting,
    setArchived,
    restore,
    deletePermanently,
  };
}
