import { useCallback, useMemo, useState, type JSX } from 'react';
import {
  PipelineTriggerModal,
  type PipelinePluginCollectionRunContext,
  type PipelineRunContextReview,
} from './PipelineTriggerModal';
import type { PipelineWatcherSelection } from './usePipelineRunWatcher';
import type {
  PipelineData,
  PipelineExecutionScope,
} from '@canopy/desktop-shared/types/pipeline';
import {
  PipelineRunContextFields,
  type PipelineRunLocation,
} from '@canopy/ui-app/workflows';
import type { WatcherRecipientGroup } from '@/components/watchers/WatcherRecipientPicker';
import { isCoworkChatTarget } from '@/lib/cowork';
import { useEarlyAccessTitle } from '@/lib/earlyAccessTitles';
import { usePipelineWorktreeContext } from './usePipelineWorktreeContext';
import {
  usePipelineRunOwnerChoices,
  usePipelineRunOwnerSelection,
} from './usePipelineRunOwnerChoices';
import {
  resolveWorkflowsRunContext,
  type PipelineRunDestination,
  type ResolvedRunContext,
} from './workflowsRunContext';

export type { PipelineRunDestination } from './workflowsRunContext';

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
  const { cwd, cwdResolved, repoChoices } = usePipelineWorktreeContext(
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
        selectSubtitle: 'Select a workflow with dispatch trigger',
        emptyMessage: 'No workflows with dispatch trigger found',
      }}
      cwd={cwd}
      contextPending={!cwdResolved}
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

interface WorkflowsRunPipelineModalProps {
  /** The selected task, offered as **Current task** when it can run the pipeline. */
  currentTarget?: { projectId: string; worktreeId: string };
  initialPipelineId?: string;
  onClose: () => void;
  onRun: (
    pipeline: PipelineData,
    inputs: Record<string, string>,
    selectedRepoId: string | undefined,
    pluginCollectionContext: PipelinePluginCollectionRunContext,
    destination: PipelineRunDestination,
  ) => Promise<void>;
  isRunning?: boolean;
  runError?: string | null;
  onClearError?: () => void;
  /** Changing it re-reads the pipelines and their saved owners. */
  reloadToken?: number;
  watcherRecipientGroups?: WatcherRecipientGroup[];
  onWatcherSelectionChange?: (
    selection: PipelineWatcherSelection | null,
  ) => void;
}

/**
 * Workflows' Run dialog (CAN-4542): opens without a selected task, runs a
 * global pipeline with no project, and asks who owns a run of a pipeline
 * with no saved owner.
 */
export function WorkflowsRunPipelineModal({
  currentTarget,
  initialPipelineId,
  onClose,
  onRun,
  isRunning = false,
  runError = null,
  onClearError,
  reloadToken,
  watcherRecipientGroups,
  onWatcherSelectionChange,
}: WorkflowsRunPipelineModalProps): JSX.Element {
  const title = useEarlyAccessTitle('Run pipeline');
  const { cwd, cwdResolved, repoChoices } = usePipelineWorktreeContext(
    currentTarget?.projectId,
    currentTarget?.worktreeId,
  );
  const taskScope: PipelineExecutionScope | undefined =
    currentTarget === undefined
      ? undefined
      : isCoworkChatTarget(currentTarget.projectId) || !cwd
        ? 'directory'
        : 'worktree';
  const executionScopes = useMemo(
    (): readonly PipelineExecutionScope[] =>
      taskScope === undefined ? ['global'] : ['global', taskScope],
    [taskScope],
  );
  const choices = usePipelineRunOwnerChoices();
  const selection = usePipelineRunOwnerSelection(choices);
  // Retry after a pipeline's owner couldn't be read reads it again.
  const [ownerReread, setOwnerReread] = useState(0);
  const rereadPipeline = useCallback((): void => {
    setOwnerReread((current) => current + 1);
  }, []);
  const [chosenLocation, setChosenLocation] = useState<{
    pipelineId: string;
    location: PipelineRunLocation;
  } | null>(null);

  const resolve = useCallback(
    (pipeline: PipelineData): ResolvedRunContext =>
      resolveWorkflowsRunContext({
        pipeline,
        taskScope,
        chosenLocation:
          chosenLocation?.pipelineId === pipeline.info.id
            ? chosenLocation.location
            : undefined,
        choices,
        selection,
        rereadPipeline,
      }),
    [choices, chosenLocation, rereadPipeline, selection, taskScope],
  );

  const runContextReview = useCallback(
    (pipeline: PipelineData): PipelineRunContextReview => {
      const context = resolve(pipeline);
      const global = context.location === 'global';
      return {
        fields: (
          <PipelineRunContextFields
            disabled={isRunning}
            {...(context.showLocation
              ? {
                  location: {
                    value: context.location,
                    currentTaskUnavailable: context.currentTaskUnavailable,
                    onChange: (location: PipelineRunLocation): void => {
                      setChosenLocation({
                        pipelineId: pipeline.info.id,
                        location,
                      });
                      onClearError?.();
                    },
                  },
                }
              : {})}
            {...(context.owner ? { owner: context.owner } : {})}
          />
        ),
        // A task-only pipeline keeps today's Run; anything with a choice or
        // an owner to confirm is reviewed first.
        needsReview: global || context.showLocation,
        runBlocked: context.runBlocked,
        ...(context.blockedReason !== undefined
          ? { blockedReason: context.blockedReason }
          : {}),
        targeted: !global,
      };
    },
    [isRunning, onClearError, resolve],
  );

  const handleRun = async (
    _pipelineId: string,
    pipeline: PipelineData,
    inputs: Record<string, string> | undefined,
    selectedRepoId: string | undefined,
    pluginCollectionContext: PipelinePluginCollectionRunContext,
  ): Promise<void> => {
    const context = resolve(pipeline);
    if (context.runBlocked) return;
    let destination: PipelineRunDestination;
    if (context.location === 'current-task') {
      if (!currentTarget) return;
      destination = { kind: 'current-task', ...currentTarget };
    } else {
      const owner = context.ownerValue ?? '';
      destination = {
        kind: 'global',
        ...(context.requestedOwner !== undefined
          ? { requestedOwner: context.requestedOwner }
          : {}),
        ownerLabel:
          choices.status === 'ready' ? choices.labelFor(owner) : owner,
        outsideNavigation:
          choices.status === 'ready' &&
          choices.navigationOwner !== null &&
          choices.navigationOwner !== owner,
      };
    }
    await onRun(
      pipeline,
      inputs ?? {},
      selectedRepoId,
      pluginCollectionContext,
      destination,
    );
  };

  return (
    <PipelineTriggerModal
      triggerType="dispatch"
      labels={{
        title,
        selectSubtitle: 'Select a pipeline to run',
        emptyMessage: 'No pipelines available for this context.',
      }}
      cwd={cwd}
      contextPending={!cwdResolved}
      repoChoices={repoChoices}
      executionScopes={executionScopes}
      runContextReview={runContextReview}
      reloadToken={(reloadToken ?? 0) + ownerReread}
      initialPipelineId={initialPipelineId}
      onClose={onClose}
      onRun={handleRun}
      isRunning={isRunning}
      runError={runError}
      onClearError={onClearError}
      runLoadingLabel="Starting…"
      watcherRecipientGroups={watcherRecipientGroups}
      onWatcherSelectionChange={onWatcherSelectionChange}
    />
  );
}
