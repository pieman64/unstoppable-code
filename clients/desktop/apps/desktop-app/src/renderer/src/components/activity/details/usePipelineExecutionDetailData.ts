import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/shallow';
import type {
  ExecutionState,
  ExecutionSummary,
  PipelineAdvisorSnapshot,
} from '@canopy/desktop-shared/types/pipeline';
import { useChatStore } from '@/stores/chatStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import {
  usePipelineExecutionDetailLease,
  type PipelineDetailOwner,
} from '@/stores/pipelineDetailCoordinator';
import type { ArchivedPipelineSource } from './pipelineDetailTypes';

/** Stable empty list for archived-mode selectors (never allocate in a selector). */
const EMPTY_CHILD_SUMMARIES: ExecutionSummary[] = [];

/**
 * Resolves the owner a detail's lease is held under. An explicit owner
 * (including `null` for ownerless runs) wins; `undefined` captures the
 * worktree selected when the detail mounted, which is what the legacy modal
 * did. A later selection change never moves the captured owner.
 */
export function useResolvedPipelineDetailOwner(
  owner: PipelineDetailOwner | null | undefined,
): PipelineDetailOwner | null {
  const [captured] = useState<PipelineDetailOwner | null>(() => {
    if (owner !== undefined) return owner;
    const selected = useChatStore.getState().selectedWorktree;
    return selected
      ? { projectId: selected.projectId, worktreeId: selected.worktreeId }
      : null;
  });
  return owner !== undefined ? owner : captured;
}

export interface PipelineExecutionDetailData {
  archived: boolean;
  summary?: ExecutionSummary;
  state?: ExecutionState;
  /** The snapshot read failed and no state is available. */
  loadFailed: boolean;
  childSummaries: ExecutionSummary[];
  rootSummary?: ExecutionSummary;
  rerunSourceSummary?: ExecutionSummary;
  advisorSnapshot?: PipelineAdvisorSnapshot;
}

/**
 * Reads the execution shown by a detail body. Live executions are held by a
 * phase 02 detail lease while `enabled`; archived executions are read once
 * through the archive transport and held locally, so the live pipeline store
 * never learns about them.
 */
export function usePipelineExecutionDetailData({
  rootExecutionId,
  activeExecutionId,
  owner,
  enabled,
  archivedSource,
}: {
  rootExecutionId: string;
  activeExecutionId: string;
  owner: PipelineDetailOwner | null;
  enabled: boolean;
  archivedSource?: ArchivedPipelineSource;
}): PipelineExecutionDetailData {
  const archived = archivedSource !== undefined;
  const [archivedStatesById, setArchivedStatesById] = useState<
    Record<string, ExecutionState>
  >({});
  const [archivedSummaries, setArchivedSummaries] = useState<
    ExecutionSummary[]
  >([]);
  const [archivedFailedExecutionId, setArchivedFailedExecutionId] = useState<
    string | null
  >(null);

  const liveSummary = usePipelineRunsStore((s) =>
    archived
      ? undefined
      : s.summaries.find((entry) => entry.id === activeExecutionId),
  );
  const liveState = usePipelineRunsStore((s) =>
    archived ? undefined : s.statesById[activeExecutionId],
  );
  // The lease registers interest before the snapshot read, keeps the
  // execution live under events whatever worktree is selected, and evicts its
  // unretained detail when released (hidden or closed).
  const { loadFailed: liveLoadFailed } = usePipelineExecutionDetailLease(
    owner,
    activeExecutionId,
    enabled && !archived,
  );
  const advisorSnapshot = usePipelineRunsStore((s) =>
    archived ? undefined : s.advisorSnapshotsByExecutionId[activeExecutionId],
  );
  const liveChildSummaries = usePipelineRunsStore(
    useShallow((s) =>
      archived
        ? EMPTY_CHILD_SUMMARIES
        : s.summaries.filter(
            (entry) => entry.parent_execution_id === activeExecutionId,
          ),
    ),
  );
  const liveRootSummary = usePipelineRunsStore((s) =>
    archived
      ? undefined
      : s.summaries.find((entry) => entry.id === rootExecutionId),
  );
  const rerunSourceId = archived
    ? archivedStatesById[activeExecutionId]?.rerun_source_id
    : liveState?.rerun_source_id;
  const liveRerunSourceSummary = usePipelineRunsStore((s) =>
    !archived && rerunSourceId
      ? s.summaries.find((entry) => entry.id === rerunSourceId)
      : undefined,
  );

  // Archived summaries resolve breadcrumbs, child drill-in, and rerun lineage
  // labels without touching the live pipeline store.
  useEffect(() => {
    if (archivedSource === undefined) return undefined;
    let cancelled = false;
    void window.api.archivedContainers
      .listExecutions({
        projectId: archivedSource.projectId,
        containerId: archivedSource.containerId,
      })
      .then((response) => {
        if (!cancelled) setArchivedSummaries(response.executions);
      })
      .catch(() => {
        // Summaries are presentation sugar; state loads independently below.
      });
    return (): void => {
      cancelled = true;
    };
  }, [archivedSource]);

  const archivedState = archived
    ? archivedStatesById[activeExecutionId]
    : undefined;
  useEffect(() => {
    if (archivedSource === undefined || archivedState !== undefined) {
      return undefined;
    }
    let cancelled = false;
    void window.api.archivedContainers
      .readExecution({
        projectId: archivedSource.projectId,
        containerId: archivedSource.containerId,
        executionId: activeExecutionId,
      })
      .then((state) => {
        if (cancelled) return;
        setArchivedStatesById((current) => ({
          ...current,
          [activeExecutionId]: state,
        }));
      })
      .catch(() => {
        if (!cancelled) setArchivedFailedExecutionId(activeExecutionId);
      });
    return (): void => {
      cancelled = true;
    };
  }, [activeExecutionId, archivedSource, archivedState]);

  const archivedChildSummaries = useMemo(
    () =>
      archived
        ? archivedSummaries.filter(
            (entry) => entry.parent_execution_id === activeExecutionId,
          )
        : EMPTY_CHILD_SUMMARIES,
    [activeExecutionId, archived, archivedSummaries],
  );

  if (archived) {
    return {
      archived,
      summary: archivedSummaries.find(
        (entry) => entry.id === activeExecutionId,
      ),
      state: archivedState,
      loadFailed:
        archivedState === undefined &&
        archivedFailedExecutionId === activeExecutionId,
      childSummaries: archivedChildSummaries,
      rootSummary: archivedSummaries.find(
        (entry) => entry.id === rootExecutionId,
      ),
      rerunSourceSummary: rerunSourceId
        ? archivedSummaries.find((entry) => entry.id === rerunSourceId)
        : undefined,
    };
  }
  return {
    archived,
    summary: liveSummary,
    state: liveState,
    loadFailed: liveLoadFailed,
    childSummaries: liveChildSummaries,
    rootSummary: liveRootSummary,
    rerunSourceSummary: liveRerunSourceSummary,
    advisorSnapshot,
  };
}
