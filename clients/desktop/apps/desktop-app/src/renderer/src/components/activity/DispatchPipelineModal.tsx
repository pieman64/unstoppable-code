import { type JSX } from 'react';
import {
  PipelineTriggerModal,
  type PipelinePluginCollectionRunContext,
} from './PipelineTriggerModal';
import type { PipelineWatcherSelection } from './usePipelineRunWatcher';
import type { PipelineData } from '@canopy/desktop-shared/types/pipeline';
import type { WatcherRecipientGroup } from '@/components/watchers/WatcherRecipientPicker';
import { isCoworkChatTarget } from '@/lib/cowork';
import { useEarlyAccessTitle } from '@/lib/earlyAccessTitles';
import { usePipelineWorktreeContext } from './usePipelineWorktreeContext';

export type DispatchPipelinePluginCollectionContext =
  PipelinePluginCollectionRunContext;

interface DispatchPipelineModalProps {
  projectId?: string;
  worktreeId?: string;
  /** Preselects a pipeline in the select step (see PipelineTriggerModal). */
  initialPipelineId?: string;
  onClose: () => void;
  onRun: (
    pipeline: PipelineData,
    inputs: Record<string, string>,
    selectedRepoId: string | undefined,
    pluginCollectionContext: PipelinePluginCollectionRunContext,
  ) => Promise<void>;
  isRunning?: boolean;
  runError?: string | null;
  onClearError?: () => void;
  watcherRecipientGroups?: WatcherRecipientGroup[];
  onWatcherSelectionChange?: (
    selection: PipelineWatcherSelection | null,
  ) => void;
}

export function DispatchPipelineModal({
  projectId,
  worktreeId,
  initialPipelineId,
  onClose,
  onRun,
  isRunning = false,
  runError = null,
  onClearError,
  watcherRecipientGroups,
  onWatcherSelectionChange,
}: DispatchPipelineModalProps): JSX.Element {
  const title = useEarlyAccessTitle('Dispatch Pipeline');
  const { cwd, repoChoices } = usePipelineWorktreeContext(
    projectId,
    worktreeId,
  );

  // A resolved worktree cwd means this dispatch surface runs in a worktree
  // context (so it should also list `directory`/legacy pipelines via the
  // capability relation); otherwise treat it as a `directory` surface.
  // Cowork workspaces resolve a cwd too (the workspace folder), but they are
  // never a git worktree — their dispatches are directory-scoped, so only
  // directory-satisfiable pipelines are listed.
  const isCowork = projectId !== undefined && isCoworkChatTarget(projectId);
  const executionScope = isCowork
    ? 'directory'
    : cwd
      ? 'worktree'
      : 'directory';

  const handleRun = async (
    _pipelineId: string,
    pipeline: PipelineData,
    inputs: Record<string, string> | undefined,
    selectedRepoId: string | undefined,
    pluginCollectionContext: PipelinePluginCollectionRunContext,
  ): Promise<void> => {
    await onRun(
      pipeline,
      inputs ?? {},
      selectedRepoId,
      pluginCollectionContext,
    );
  };

  return (
    <PipelineTriggerModal
      triggerType="dispatch"
      labels={{
        title,
        selectSubtitle: 'Select a pipeline with dispatch trigger',
        emptyMessage: 'No pipelines with dispatch trigger found',
      }}
      cwd={cwd}
      repoChoices={repoChoices}
      executionScope={executionScope}
      initialPipelineId={initialPipelineId}
      onClose={onClose}
      onRun={handleRun}
      isRunning={isRunning}
      runError={runError}
      onClearError={onClearError}
      watcherRecipientGroups={watcherRecipientGroups}
      onWatcherSelectionChange={onWatcherSelectionChange}
    />
  );
}
