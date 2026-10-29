import type { BackgroundProcess } from '@canopy/desktop-shared/types';
import { useActivityStore } from '@/stores/activityStore';
import { useDelegationActivityStore } from '@/stores/delegationActivityStore';

const EMPTY_PROCESSES: readonly BackgroundProcess[] = [];

/** Background work that is a subagent: a native agent or a workflow run. */
function isRunningSubagentProcess(process: BackgroundProcess): boolean {
  return (
    (process.kind === 'agent' || process.kind === 'workflow') &&
    (process.status === 'queued' || process.status === 'running')
  );
}

/**
 * How many subagents are queued or running in a worktree: its managed
 * delegations (main's live per-chat aggregate) plus the background agents
 * and workflow runs its chats started. Both selectors return a number, so
 * the worktree top bar re-renders only when the count changes, never on the
 * transcript's streaming, which the Subagents panel's own index re-reads.
 * While `enabled` is false (the Subagents view is off) both read 0, so the
 * top bar never re-renders for it.
 */
export function useRunningSubagentCount(
  projectId: string,
  worktreeId: string,
  enabled = true,
): number {
  const managed = useDelegationActivityStore((state): number => {
    if (!enabled) return 0;
    let count = 0;
    for (const entry of Object.values(state.byChat)) {
      if (entry.projectId === projectId && entry.worktreeId === worktreeId) {
        count += entry.live + entry.queued;
      }
    }
    return count;
  });
  const background = useActivityStore((state): number =>
    enabled
      ? (
          state.bgProcesses[`${projectId}/${worktreeId}`] ?? EMPTY_PROCESSES
        ).filter(isRunningSubagentProcess).length
      : 0,
  );
  return managed + background;
}
