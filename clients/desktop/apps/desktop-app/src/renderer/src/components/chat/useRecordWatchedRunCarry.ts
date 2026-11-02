import { memo, useEffect, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type {
  AgentArtifactCarryReceiptV1,
  PipelineRunArtifactReceiptV1,
} from '@canopy/desktop-shared/types';
import {
  retainAppAdvisorWatchersBridge,
  useAppAdvisorWatchersStore,
} from '@/stores/appAdvisorWatchersStore';
import { useChatStore } from '@/stores/chatStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import {
  refreshGitHubWorkflowRunReceipt,
  selectPersistableCarryReceipts,
  selectWatchedCarryReceipts,
} from './agent-artifact-projection';

type CarryByTurn = Readonly<
  Record<string, readonly AgentArtifactCarryReceiptV1[]>
>;

interface WatchedRunCarryTarget {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}

/**
 * Records the runs a chat watches as carry into its owner turn (the
 * streaming turn, else the latest), so its turns list them and the
 * background drawer finds them (CAN-4690). Only runs started elsewhere are
 * persisted (`selectPersistableCarryReceipts`). Holds the watcher bridge
 * while a target is set. Moved out of the pinned Agent activity section,
 * which no longer lists runs (background drawer Phase 06).
 *
 * Also brings carried GitHub runs up to what their watchers last observed,
 * finished ones included, in the turns that carry them: the run card did this
 * when mounted, but a run the drawer holds has no card.
 */
export function useRecordWatchedRunCarry(
  chatTarget: WatchedRunCarryTarget | undefined,
  ownerUserMessageId: string,
  knownPipelineRuns: Readonly<Record<string, PipelineRunArtifactReceiptV1>>,
  carryByTurn?: CarryByTurn,
): void {
  const { watchers, completedWatchers } = useAppAdvisorWatchersStore(
    useShallow((state) => ({
      watchers: state.watchers,
      completedWatchers: state.completedWatchers,
    })),
  );
  const summaries = usePipelineRunsStore(
    useShallow((state) => state.summaries),
  );
  const hasTarget = chatTarget !== undefined;
  useEffect(
    () => (hasTarget ? retainAppAdvisorWatchersBridge() : undefined),
    [hasTarget],
  );
  const carryReceipts = useMemo(
    () =>
      chatTarget === undefined
        ? []
        : selectPersistableCarryReceipts(
            selectWatchedCarryReceipts(
              knownPipelineRuns,
              summaries,
              watchers,
              chatTarget,
              completedWatchers,
            ),
            knownPipelineRuns,
          ),
    [chatTarget, completedWatchers, knownPipelineRuns, summaries, watchers],
  );
  useEffect(() => {
    if (!chatTarget || !ownerUserMessageId || carryReceipts.length === 0) {
      return;
    }
    useChatStore
      .getState()
      .recordAgentArtifactCarry(chatTarget, ownerUserMessageId, carryReceipts);
  }, [carryReceipts, chatTarget, ownerUserMessageId]);
  // Same reference when nothing newer was observed, so this settles.
  const carryRefreshes = useMemo(() => {
    if (chatTarget === undefined || carryByTurn === undefined) return [];
    const known = [...watchers, ...completedWatchers];
    return Object.entries(carryByTurn).flatMap(([turnId, receipts]) => {
      const refreshed = receipts.flatMap((receipt) => {
        if (receipt.kind !== 'github_workflow_run') return [];
        const next = refreshGitHubWorkflowRunReceipt(receipt, known);
        return next === receipt ? [] : [next];
      });
      return refreshed.length === 0 ? [] : [{ turnId, refreshed }];
    });
  }, [carryByTurn, chatTarget, completedWatchers, watchers]);
  useEffect(() => {
    if (!chatTarget) return;
    for (const { turnId, refreshed } of carryRefreshes) {
      useChatStore
        .getState()
        .recordAgentArtifactCarry(chatTarget, turnId, refreshed);
    }
  }, [carryRefreshes, chatTarget]);
}

/**
 * Renders nothing; keeps the watcher and run-summary subscriptions out of
 * the transcript list's renders, and skips list renders that change none of
 * its props.
 */
export const WatchedRunCarryRecorder = memo(function WatchedRunCarryRecorder({
  chatTarget,
  ownerUserMessageId,
  knownPipelineRuns,
  carryByTurn,
}: {
  readonly chatTarget: WatchedRunCarryTarget;
  readonly ownerUserMessageId: string;
  readonly knownPipelineRuns: Readonly<
    Record<string, PipelineRunArtifactReceiptV1>
  >;
  readonly carryByTurn?: CarryByTurn;
}): null {
  useRecordWatchedRunCarry(
    chatTarget,
    ownerUserMessageId,
    knownPipelineRuns,
    carryByTurn,
  );
  return null;
});
