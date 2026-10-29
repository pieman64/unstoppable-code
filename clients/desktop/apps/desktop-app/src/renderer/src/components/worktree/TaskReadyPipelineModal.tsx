import type { JSX } from 'react';
import {
  PipelineTriggerModal,
  type PipelineRepoChoice,
  type PipelinePluginCollectionRunContext,
} from '@/components/activity/PipelineTriggerModal';
import type { PipelineExecutionScope } from '@canopy/protocol/pipelines';
import type { PipelineWatcherSelection } from '@/components/activity/usePipelineRunWatcher';
import type { PipelineData } from '@canopy/desktop-shared/types/pipeline';
import type { WatcherRecipientGroup } from '@/components/watchers/WatcherRecipientPicker';

interface TaskReadyPipelineModalProps {
  cwd?: string;
  repoChoices?: PipelineRepoChoice[];
  /**
   * Explicit execution-scope filter hint. Defaults to deriving from `cwd`
   * (`worktree` when resolved, `directory` otherwise) when omitted — callers
   * that resolve `cwd` for a target with no worktree concept (e.g. a cowork
   * root) must pass `'directory'` explicitly since a truthy `cwd` would
   * otherwise default to `worktree`.
   */
  executionScope?: PipelineExecutionScope;
  /** Preselects this pipeline in the list when present. */
  initialPipelineId?: string;
  /** Input seeds applied only while `initialPipelineId` is selected. */
  initialInputs?: Record<string, string>;
  onClose: () => void;
  onRun: (
    pipelineId: string,
    pipeline: PipelineData,
    inputs: Record<string, string> | undefined,
    selectedRepoId: string | undefined,
    pluginCollectionContext: PipelinePluginCollectionRunContext,
  ) => Promise<void>;
  isRunning?: boolean;
  runError?: string | null;
  watcherRecipientGroups?: WatcherRecipientGroup[];
  onWatcherSelectionChange?: (
    selection: PipelineWatcherSelection | null,
  ) => void;
}

export function TaskReadyPipelineModal({
  cwd,
  repoChoices,
  executionScope: executionScopeOverride,
  initialPipelineId,
  initialInputs,
  onClose,
  onRun,
  isRunning = false,
  runError = null,
  watcherRecipientGroups,
  onWatcherSelectionChange,
}: TaskReadyPipelineModalProps): JSX.Element {
  // Task pipelines run against a worktree; a resolved worktree cwd makes this a
  // `worktree` surface (which also lists `directory`/legacy pipelines via the
  // capability relation). Fall back to `directory` if no cwd is available.
  // Callers targeting a non-worktree cwd (e.g. a cowork root) pass an
  // explicit override instead of relying on this default.
  const executionScope =
    executionScopeOverride ?? (cwd ? 'worktree' : 'directory');

  return (
    <PipelineTriggerModal
      triggerType="task_ready"
      labels={{
        title: 'Run task pipeline',
        selectSubtitle: 'Select a pipeline with task_ready trigger',
        emptyMessage: 'No pipelines with task_ready trigger found',
      }}
      cwd={cwd}
      repoChoices={repoChoices}
      executionScope={executionScope}
      initialPipelineId={initialPipelineId}
      initialInputs={initialInputs}
      onClose={onClose}
      onRun={onRun}
      isRunning={isRunning}
      runError={runError}
      watcherRecipientGroups={watcherRecipientGroups}
      onWatcherSelectionChange={onWatcherSelectionChange}
    />
  );
}
