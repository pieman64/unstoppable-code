import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { PipelineRunArtifactReceiptV1 } from '@canopy/desktop-shared/types';
import { normalizePipelineRunStatus } from '@canopy/ui-app/agent-activity';
import { useAppAdvisorWatchersStore } from '@/stores/appAdvisorWatchersStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { selectWatchedCarryReceipts } from './agent-artifact-projection';

const NO_KEYS: ReadonlySet<string> = new Set();
const LIVE_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'running',
  'paused',
]);

/**
 * The dedupe keys of the runs that are live in this chat now (CAN-4690): the
 * runs it watches, and every pipeline run its turns list (transcript receipts
 * and persisted carry alike, `chatPipelineRuns`) whose status, read the way
 * their cards read it (execution state, then run row, then summary, then the
 * receipt), is still pending, running or paused. The pinned section owns
 * these runs, so completed turns leave them to it. A chat with no pinned
 * section (no `chatTarget`) has no live keys.
 *
 * A GitHub workflow run is live only while a watcher follows it
 * (`isFollowingWatcher`, delivering an update included). Its watcher
 * is its only live source: once the watcher stops, the receipt's snapshot is
 * frozen, so an in-progress snapshot would pin a card that never updates in
 * the pinned section. The run goes back to its home turn with its last
 * observed state instead.
 *
 * Subscribes through a string so pipeline status ticks re-render the caller
 * only when the live set changes.
 */
export function useLiveAgentRunKeys(
  chatTarget:
    | { projectId: string; worktreeId: string; chatId: string }
    | undefined,
  knownPipelineRuns: Readonly<Record<string, PipelineRunArtifactReceiptV1>>,
  chatPipelineRuns: readonly PipelineRunArtifactReceiptV1[],
): ReadonlySet<string> {
  // The fire history lists a watcher while it delivers an update.
  const { watchers, completedWatchers } = useAppAdvisorWatchersStore(
    useShallow((state) => ({
      watchers: state.watchers,
      completedWatchers: state.completedWatchers,
    })),
  );
  const projectId = chatTarget?.projectId;
  const worktreeId = chatTarget?.worktreeId;
  const chatId = chatTarget?.chatId;
  const joinedKeys = usePipelineRunsStore((state) => {
    if (!projectId || !worktreeId || !chatId) return '';
    const keys = new Set(
      selectWatchedCarryReceipts(
        knownPipelineRuns,
        state.summaries,
        watchers,
        {
          projectId,
          worktreeId,
          chatId,
        },
        completedWatchers,
      )
        // A separately fetched fire history can finish a run before the
        // active watcher list catches up. Its record then belongs in chat.
        .filter(
          (receipt) =>
            receipt.kind !== 'github_workflow_run' ||
            (receipt.state.kind !== 'terminal' &&
              !(
                receipt.state.kind === 'unsupported' && receipt.state.terminal
              )),
        )
        .map((receipt) => receipt.dedupeKey),
    );
    const runs = chatPipelineRuns;
    if (runs.length > 0) {
      const summaryStatus = new Map(
        state.summaries.map((summary) => [summary.id, summary.status]),
      );
      for (const receipt of runs) {
        const status = normalizePipelineRunStatus(
          state.statesById[receipt.executionId]?.status ??
            state.rowStatesById[receipt.executionId]?.status ??
            summaryStatus.get(receipt.executionId) ??
            receipt.initialStatus,
        );
        if (LIVE_STATUSES.has(status)) keys.add(receipt.dedupeKey);
      }
    }
    return Array.from(keys).sort().join('\n');
  });
  return useMemo(
    () => (joinedKeys ? new Set(joinedKeys.split('\n')) : NO_KEYS),
    [joinedKeys],
  );
}
