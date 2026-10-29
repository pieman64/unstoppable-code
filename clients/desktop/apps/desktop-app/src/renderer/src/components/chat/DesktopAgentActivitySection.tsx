import { memo, useCallback, useMemo, type JSX, type ReactNode } from 'react';
import type {
  AgentArtifactReceiptV1,
  BackgroundProcess,
  GitHubWorkflowRunArtifactReceiptV1,
  PipelineRunArtifactReceiptV1,
} from '@canopy/desktop-shared/types';
import { AgentActivitySection } from '@canopy/ui-app/agent-activity';
import { isCapabilityTileReceipt } from '@canopy/ui-shared/components';
import { useSubagentEntryActions } from '@/components/subagents/subagent-entry-actions';
import { useBackgroundTaskActions } from '@/components/activity/useBackgroundTaskActions';
import { reportBackgroundProcessSelection } from '@/lib/current-ui-state/backgroundProcessesUiState';
import { backgroundProcessToTask } from '@/lib/background-tasks';
import { AgentArtifactCard } from './AgentArtifactCard';
import { GitHubWorkflowRunArtifactCard } from './GitHubWorkflowRunArtifactCard';
import { PipelineRunArtifactCard } from './PipelineRunArtifactCard';

interface AgentActivityChatTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

interface DesktopAgentActivitySectionProps {
  artifacts: readonly AgentArtifactReceiptV1[];
  agentItems?: readonly ReactNode[];
  /**
   * Background processes this turn launched, read live from the activity
   * store. They render with the same card UX as the Agent Background
   * Processes panel section, so the chat and the panel stay one presentation.
   */
  backgroundProcesses?: readonly BackgroundProcess[];
  variant: 'active' | 'completed';
  defaultExpanded?: boolean;
  chatTarget?: AgentActivityChatTarget;
  /** The user turn these artifacts belong to; lets cards refresh their carry. */
  ownerUserMessageId?: string;
  /**
   * Managed delegations in this chat that are queued, starting or running, at
   * any depth. While non-empty (and `onStopAllDelegations` is supplied) the
   * header offers Stop all delegates.
   */
  liveDelegationIds?: readonly string[];
  /**
   * Stops every live managed delegation in the chat. Resolves `true` once the
   * host accepted the stop; the host reports failures. Background processes,
   * pipeline runs, GitHub runs and native subagents are never affected.
   */
  onStopAllDelegations?: (target: AgentActivityChatTarget) => Promise<boolean>;
}

const EMPTY_BACKGROUND_PROCESSES: readonly BackgroundProcess[] = [];

/**
 * Desktop host for the shared Agent activity section: renders the desktop
 * artifact and run cards, projects background processes onto portable tasks,
 * and binds the chat's Stop all, View tree and background-process actions.
 */
export const DesktopAgentActivitySection = memo(
  function DesktopAgentActivitySection({
    artifacts,
    agentItems,
    backgroundProcesses = EMPTY_BACKGROUND_PROCESSES,
    variant,
    defaultExpanded,
    chatTarget,
    ownerUserMessageId,
    liveDelegationIds,
    onStopAllDelegations,
  }: DesktopAgentActivitySectionProps): JSX.Element | null {
    const subagentEntryActions = useSubagentEntryActions();
    const backgroundTasks = useMemo(
      () => backgroundProcesses.map(backgroundProcessToTask),
      [backgroundProcesses],
    );
    const reportSelectedBackgroundProcess = useCallback(
      (selectedTaskId: string | null): void => {
        if (!chatTarget) return;
        reportBackgroundProcessSelection({
          projectId: chatTarget.projectId,
          worktreeId: chatTarget.worktreeId,
          processes: backgroundProcesses,
          selectedTaskId,
        });
      },
      [backgroundProcesses, chatTarget],
    );
    const backgroundTaskActions = useBackgroundTaskActions({
      projectId: chatTarget?.projectId ?? '',
      worktreeId: chatTarget?.worktreeId ?? '',
      processes: backgroundProcesses,
      onSelectedTaskIdChange: reportSelectedBackgroundProcess,
    });
    // Create/update cards are compact and stay readable in narrow columns, so
    // the section packs more per row as the container grows. Pipeline runs and
    // watched GitHub workflow runs use the same full-width row presentation as
    // the Pipeline Runs panel.
    const artifactItems = artifacts
      .filter(isCapabilityTileReceipt)
      .map((receipt) => (
        <AgentArtifactCard key={receipt.dedupeKey} receipt={receipt} />
      ));
    const pipelineRunItems = artifacts
      .filter(
        (receipt): receipt is PipelineRunArtifactReceiptV1 =>
          receipt.kind === 'pipeline_run',
      )
      .map((receipt) => (
        <PipelineRunArtifactCard
          key={receipt.dedupeKey}
          receipt={receipt}
          chatTarget={chatTarget}
        />
      ));
    const githubRunItems = artifacts
      .filter(
        (receipt): receipt is GitHubWorkflowRunArtifactReceiptV1 =>
          receipt.kind === 'github_workflow_run',
      )
      .map((receipt) => (
        <GitHubWorkflowRunArtifactCard
          key={receipt.dedupeKey}
          receipt={receipt}
          chatTarget={chatTarget}
          ownerUserMessageId={ownerUserMessageId}
        />
      ));
    return (
      <AgentActivitySection
        agentItems={agentItems}
        artifactItems={artifactItems}
        pipelineRunItems={pipelineRunItems}
        githubRunItems={githubRunItems}
        backgroundTasks={backgroundTasks}
        backgroundTaskActions={chatTarget ? backgroundTaskActions : undefined}
        variant={variant}
        defaultExpanded={defaultExpanded}
        onViewSubagentTree={subagentEntryActions?.viewTree}
        liveDelegationIds={liveDelegationIds}
        onStopAllDelegations={
          chatTarget && onStopAllDelegations
            ? (): Promise<boolean> => onStopAllDelegations(chatTarget)
            : undefined
        }
      />
    );
  },
);
