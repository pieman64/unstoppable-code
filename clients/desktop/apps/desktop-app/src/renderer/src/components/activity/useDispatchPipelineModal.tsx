import { useCallback, useState, type JSX } from 'react';
import {
  PIPELINE_NOW_OWNED_ERROR_CODE,
  type PipelineData,
  type PipelineExecutionStartResult,
} from '@canopy/desktop-shared/types/pipeline';
import { WORKFLOW_RUN_STARTED_TOAST } from '@canopy/ui-app/workflows';
import { extractIpcErrorMessage } from '@/lib/errors';
import { useGitHubStore } from '@/stores/githubStore';
import {
  DispatchPipelineModal,
  WorkflowsRunPipelineModal,
  type DispatchPipelinePluginCollectionContext,
  type PipelineRunDestination,
} from './DispatchPipelineModal';
import { usePipelineRunWatcher } from './usePipelineRunWatcher';

export interface DispatchPipelineTarget {
  projectId: string;
  worktreeId: string;
  /**
   * Preselects this pipeline in the modal's select step (CAN-2361 PR2b:
   * share-landing "Try now"). Preselect only — Run stays an explicit click.
   */
  initialPipelineId?: string;
}

/** Workflows' Run, which needs no selected task (CAN-4542). */
export interface WorkflowsRunOptions {
  initialPipelineId?: string;
  /** The selected task, offered as **Current task**. */
  currentTarget?: { projectId: string; worktreeId: string };
}

interface DispatchPipelineModalController {
  openDispatchPipelineModal: (target: DispatchPipelineTarget) => void;
  openWorkflowsRunModal: (options?: WorkflowsRunOptions) => void;
  dispatchPipelineModal: JSX.Element | null;
}

export const PIPELINE_STARTED_TOAST = WORKFLOW_RUN_STARTED_TOAST;

export function pipelineStartedToast(
  destination: PipelineRunDestination | undefined,
): string {
  return destination?.kind === 'global' && destination.outsideNavigation
    ? `Pipeline started. Find it in ${destination.ownerLabel} › Workflows › Runs.`
    : PIPELINE_STARTED_TOAST;
}

export function useDispatchPipelineModal(): DispatchPipelineModalController {
  const [target, setTarget] = useState<DispatchPipelineTarget | null>(null);
  const [workflowsRun, setWorkflowsRun] = useState<WorkflowsRunOptions | null>(
    null,
  );
  const [dispatchRunning, setDispatchRunning] = useState(false);
  const [dispatchRunError, setDispatchRunError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const watcher = usePipelineRunWatcher(
    target ?? workflowsRun?.currentTarget ?? null,
  );

  const closeDispatchModal = useCallback((): void => {
    if (dispatchRunning) return;
    setTarget(null);
    setWorkflowsRun(null);
    setDispatchRunError(null);
    watcher.reset();
  }, [dispatchRunning, watcher]);

  const openDispatchPipelineModal = useCallback(
    (nextTarget: DispatchPipelineTarget): void => {
      setWorkflowsRun(null);
      setTarget(nextTarget);
      setDispatchRunError(null);
    },
    [],
  );

  const openWorkflowsRunModal = useCallback(
    (options: WorkflowsRunOptions = {}): void => {
      setTarget(null);
      setWorkflowsRun(options);
      setDispatchRunError(null);
    },
    [],
  );

  const clearDispatchError = useCallback((): void => {
    setDispatchRunError(null);
  }, []);

  const handleDispatchRun = useCallback(
    async (
      pipeline: PipelineData,
      inputs: Record<string, string>,
      selectedRepoId: string | undefined,
      pluginCollectionContext: DispatchPipelinePluginCollectionContext,
      destination?: PipelineRunDestination,
    ): Promise<void> => {
      if (destination?.kind === 'global') {
        setDispatchRunError(null);
        await startGlobalRun(pipeline, inputs, pluginCollectionContext, {
          requestedOwner: destination.requestedOwner,
          onStarted: () => {
            watcher.reset();
            setWorkflowsRun(null);
            useGitHubStore
              .getState()
              .addToast(
                pipelineStartedToast(destination),
                'success',
                undefined,
                {
                  category: 'Pipeline',
                },
              );
          },
          setRunning: setDispatchRunning,
          setError: (message, errorCode) => {
            setDispatchRunError(message);
            // A pipeline that gained an owner is re-read to show it.
            if (errorCode === PIPELINE_NOW_OWNED_ERROR_CODE)
              setReloadToken((current) => current + 1);
          },
        });
        return;
      }
      const taskTarget =
        destination?.kind === 'current-task' ? destination : target;
      if (!taskTarget) {
        setDispatchRunError('No worktree is selected');
        return;
      }

      setDispatchRunning(true);
      setDispatchRunError(null);

      let cwd: string;
      try {
        cwd = await window.api.getWorktreePath({
          projectId: taskTarget.projectId,
          worktreeId: taskTarget.worktreeId,
          repoId: selectedRepoId,
        });
      } catch (error: unknown) {
        setDispatchRunning(false);
        setDispatchRunError(
          error instanceof Error
            ? error.message
            : 'Failed to resolve worktree path',
        );
        return;
      }

      try {
        const appAdvisorPipelineWatchers = watcher.appAdvisorPipelineWatchers();
        const result = await window.pipelines.execute(pipeline.content, {
          cwd,
          pipelineId: pipeline.info.id,
          pipelineFilePath:
            pipeline.info.source === 'project'
              ? pipeline.info.filePath
              : undefined,
          repoPath: pipeline.info.source === 'project' ? cwd : undefined,
          projectId: taskTarget.projectId,
          worktreeId: taskTarget.worktreeId,
          eventName: 'dispatch',
          inputs,
          pluginCollectionPreferences: pluginCollectionContext.preferences,
          ...(pluginCollectionContext.modelAliasPreferences
            ? {
                modelAliasPreferences:
                  pluginCollectionContext.modelAliasPreferences,
              }
            : {}),
          modelConfig: pluginCollectionContext.modelConfig,
          ...(appAdvisorPipelineWatchers ? { appAdvisorPipelineWatchers } : {}),
          ...(pluginCollectionContext.pipelinePreferenceLocator
            ? {
                pipelinePreferenceLocator:
                  pluginCollectionContext.pipelinePreferenceLocator,
              }
            : {}),
          ...(pipeline.info.source === 'shared' &&
          pipeline.info.serverId &&
          pipeline.info.remoteId
            ? {
                sharedPipeline: {
                  serverId: pipeline.info.serverId,
                  remoteId: pipeline.info.remoteId,
                },
              }
            : {}),
        });

        if (!result.success) {
          setDispatchRunError(result.error ?? 'Workflow execution failed');
          return;
        }

        watcher.reset();
        if (destination !== undefined) {
          useGitHubStore
            .getState()
            .addToast(pipelineStartedToast(destination), 'success', undefined, {
              category: 'Pipeline',
            });
        }
        setTarget(null);
        setWorkflowsRun(null);
        setDispatchRunError(null);
      } catch (error: unknown) {
        setDispatchRunError(extractIpcErrorMessage(error));
      } finally {
        setDispatchRunning(false);
      }
    },
    [target, watcher],
  );

  const dispatchPipelineModal = workflowsRun ? (
    <WorkflowsRunPipelineModal
      currentTarget={workflowsRun.currentTarget}
      initialPipelineId={workflowsRun.initialPipelineId}
      onClose={closeDispatchModal}
      onRun={handleDispatchRun}
      isRunning={dispatchRunning}
      runError={dispatchRunError}
      onClearError={clearDispatchError}
      reloadToken={reloadToken}
      watcherRecipientGroups={watcher.recipientGroups}
      onWatcherSelectionChange={watcher.onWatcherSelectionChange}
    />
  ) : target ? (
    <DispatchPipelineModal
      projectId={target.projectId}
      worktreeId={target.worktreeId}
      initialPipelineId={target.initialPipelineId}
      onClose={closeDispatchModal}
      onRun={handleDispatchRun}
      isRunning={dispatchRunning}
      runError={dispatchRunError}
      onClearError={clearDispatchError}
      watcherRecipientGroups={watcher.recipientGroups}
      onWatcherSelectionChange={watcher.onWatcherSelectionChange}
    />
  ) : null;

  return {
    openDispatchPipelineModal,
    openWorkflowsRunModal,
    dispatchPipelineModal,
  };
}

type StartErrorCode = Extract<
  PipelineExecutionStartResult,
  { success: false }
>['errorCode'];

/**
 * Starts a run with no project. Main supplies its scratch folder, so no
 * working directory, project, task, or repository goes with it, and no
 * completion watcher: global runs have none yet.
 */
async function startGlobalRun(
  pipeline: PipelineData,
  inputs: Record<string, string>,
  pluginCollectionContext: DispatchPipelinePluginCollectionContext,
  handlers: {
    requestedOwner: string | undefined;
    onStarted: () => void;
    setRunning: (running: boolean) => void;
    setError: (message: string, errorCode?: StartErrorCode) => void;
  },
): Promise<void> {
  handlers.setRunning(true);
  try {
    const result = await window.pipelines.execute(pipeline.content, {
      pipelineId: pipeline.info.id,
      scope: 'global',
      target: { scope: 'global' },
      eventName: 'dispatch',
      inputs,
      ...(handlers.requestedOwner !== undefined
        ? { requestedOwner: handlers.requestedOwner }
        : {}),
      pluginCollectionPreferences: pluginCollectionContext.preferences,
      ...(pluginCollectionContext.modelAliasPreferences
        ? {
            modelAliasPreferences:
              pluginCollectionContext.modelAliasPreferences,
          }
        : {}),
      modelConfig: pluginCollectionContext.modelConfig,
      ...(pluginCollectionContext.pipelinePreferenceLocator
        ? {
            pipelinePreferenceLocator:
              pluginCollectionContext.pipelinePreferenceLocator,
          }
        : {}),
      ...(pipeline.info.source === 'shared' &&
      pipeline.info.serverId &&
      pipeline.info.remoteId
        ? {
            sharedPipeline: {
              serverId: pipeline.info.serverId,
              remoteId: pipeline.info.remoteId,
            },
          }
        : {}),
    });
    if (!result.success) {
      handlers.setError(
        result.error ?? 'Pipeline execution failed',
        result.errorCode,
      );
      return;
    }
    handlers.onStarted();
  } catch (error: unknown) {
    handlers.setError(extractIpcErrorMessage(error));
  } finally {
    handlers.setRunning(false);
  }
}
