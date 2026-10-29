import { memo, useEffect, useMemo, type JSX, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type {
  AgentArtifactReceiptV1,
  BackgroundProcess,
  PipelineRunArtifactReceiptV1,
} from '@canopy/desktop-shared/types';
import { useAppAdvisorWatchersStore } from '@/stores/appAdvisorWatchersStore';
import { useChatStore } from '@/stores/chatStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import {
  mergeAgentArtifactTurn,
  selectWatchedCarryReceipts,
} from './agent-artifact-projection';
import { DesktopAgentActivitySection } from './DesktopAgentActivitySection';
import { requestManagedDelegationStopAll } from './managed-delegation-stop';

interface ActiveAgentActivitySectionProps {
  projectedArtifacts: readonly AgentArtifactReceiptV1[];
  agentItems?: readonly ReactNode[];
  backgroundProcesses?: readonly BackgroundProcess[];
  knownPipelineRuns?: Readonly<Record<string, PipelineRunArtifactReceiptV1>>;
  ownerUserMessageId: string;
  chatTarget: { projectId: string; worktreeId: string; chatId: string };
  variant?: 'active' | 'completed';
  /**
   * Live managed delegations in the chat, at any depth. Supplying it offers
   * Stop all delegates in the section header while it is non-empty.
   */
  liveDelegationIds?: readonly string[];
}

const EMPTY_PIPELINE_RUNS: Readonly<
  Record<string, PipelineRunArtifactReceiptV1>
> = {};

export const ActiveAgentActivitySection = memo(
  function ActiveAgentActivitySection({
    projectedArtifacts,
    agentItems,
    backgroundProcesses,
    knownPipelineRuns = EMPTY_PIPELINE_RUNS,
    ownerUserMessageId,
    chatTarget,
    variant = 'active',
    liveDelegationIds,
  }: ActiveAgentActivitySectionProps): JSX.Element | null {
    const { watchers, completedWatchers } = useAppAdvisorWatchersStore(
      useShallow((state) => ({
        watchers: state.watchers,
        completedWatchers: state.completedWatchers,
      })),
    );
    const summaries = usePipelineRunsStore(
      useShallow((state) => state.summaries),
    );

    useEffect(() => {
      const unsubscribe = useAppAdvisorWatchersStore
        .getState()
        .subscribeBridge();
      const store = useAppAdvisorWatchersStore.getState();
      if (!store.hydrated && !store.loading) void store.hydrate();
      return unsubscribe;
    }, []);

    const watchedRuns = useMemo(
      () =>
        selectWatchedCarryReceipts(
          knownPipelineRuns,
          summaries,
          watchers,
          chatTarget,
          completedWatchers,
        ),
      [chatTarget, completedWatchers, knownPipelineRuns, summaries, watchers],
    );
    const artifacts = useMemo(
      () => mergeAgentArtifactTurn(projectedArtifacts, watchedRuns),
      [projectedArtifacts, watchedRuns],
    );

    useEffect(() => {
      if (!ownerUserMessageId || watchedRuns.length === 0) return;
      useChatStore
        .getState()
        .recordAgentArtifactCarry(chatTarget, ownerUserMessageId, watchedRuns);
    }, [chatTarget, ownerUserMessageId, watchedRuns]);

    return (
      <DesktopAgentActivitySection
        artifacts={artifacts}
        agentItems={agentItems}
        backgroundProcesses={backgroundProcesses}
        variant={variant}
        chatTarget={chatTarget}
        ownerUserMessageId={ownerUserMessageId}
        liveDelegationIds={liveDelegationIds}
        onStopAllDelegations={
          liveDelegationIds ? requestManagedDelegationStopAll : undefined
        }
      />
    );
  },
);
