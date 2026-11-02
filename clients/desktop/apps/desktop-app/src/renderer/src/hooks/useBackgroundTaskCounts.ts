import { useEffect, useMemo } from 'react';
import { useShallow } from 'zustand/shallow';
import {
  selectDelegationCountsByWorktree,
  useDelegationActivityStore,
} from '@/stores/delegationActivityStore';
import {
  selectLiveTaskCountsByWorktree,
  useLiveBackgroundTaskStore,
  type LiveBackgroundTaskWorktreeTarget,
} from '@/stores/liveBackgroundTaskStore';

// Control characters never appear in ids, so the joined list round-trips.
const ID_SEPARATOR = '\u0000';
const TARGET_SEPARATOR = '\u0001';

/**
 * Pull each listed worktree's live-task snapshot once. The mirror is
 * push-only, so work that started before this renderer subscribed would
 * otherwise count as nothing. Hydrated worktrees are skipped, and a failed
 * pull is retried only when the list changes or the reader remounts.
 */
export function useLiveTaskSnapshots(
  targets: readonly LiveBackgroundTaskWorktreeTarget[],
): void {
  const targetList = targets
    .map(({ projectId, worktreeId }) => projectId + ID_SEPARATOR + worktreeId)
    .join(TARGET_SEPARATOR);
  useEffect(() => {
    if (targetList === '') return;
    void useLiveBackgroundTaskStore.getState().ensureWorktreesHydrated(
      targetList.split(TARGET_SEPARATOR).map((target) => {
        const [projectId = '', worktreeId = ''] = target.split(ID_SEPARATOR);
        return { projectId, worktreeId };
      }),
    );
  }, [targetList]);
}

/**
 * Live background tasks per worktree or Work Entry of a project: queued and
 * live delegations plus every provider task, shells included (turn-state D11).
 * Rows draw the background spinner from it (D15). A count changes only when
 * work starts or ends, so streaming never re-renders a reader. The reader's
 * worktrees are pulled once (see {@link useLiveTaskSnapshots}).
 */
export function useBackgroundTaskCounts(
  projectId: string,
  worktreeIds: readonly string[],
): Readonly<Record<string, number>> {
  useLiveTaskSnapshots(
    worktreeIds.map((worktreeId) => ({ projectId, worktreeId })),
  );
  const delegations = useDelegationActivityStore(
    useShallow((state) => selectDelegationCountsByWorktree(state, projectId)),
  );
  const tasks = useLiveBackgroundTaskStore(
    useShallow((state) => selectLiveTaskCountsByWorktree(state, projectId)),
  );
  return useMemo(() => {
    const counts: Record<string, number> = { ...delegations };
    for (const [worktreeId, count] of Object.entries(tasks)) {
      counts[worktreeId] = (counts[worktreeId] ?? 0) + count;
    }
    return counts;
  }, [delegations, tasks]);
}
