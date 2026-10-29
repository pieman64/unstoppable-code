import { useCallback, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import type { PipelineData } from '@canopy/desktop-shared/types/pipeline';
import { extractIpcErrorMessage } from '@/lib/errors';
import {
  DispatchPipelineModal,
  type DispatchPipelinePluginCollectionContext,
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

interface DispatchPipelineModalController {
  openDispatchPipelineModal: (target: DispatchPipelineTarget) => void;
  dispatchPipelineModal: JSX.Element | null;
}

export function useDispatchPipelineModal(): DispatchPipelineModalController {
  const [target, setTarget] = useState<DispatchPipelineTarget | null>(null);
  const [dispatchRunning, setDispatchRunning] = useState(false);
  const [dispatchRunError, setDispatchRunError] = useState<string | null>(null);
  const watcher = usePipelineRunWatcher(target);

  const closeDispatchModal = useCallback((): void => {
    if (dispatchRunning) return;
    setTarget(null);
    setDispatchRunError(null);
    watcher.reset();
  }, [dispatchRunning, watcher]);

  const openDispatchPipelineModal = useCallback(
    (nextTarget: DispatchPipelineTarget): void => {
      setTarget(nextTarget);
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
    ): Promise<void> => {
      if (!target) {
        setDispatchRunError('No worktree is selected');
        return;
      }

      setDispatchRunning(true);
      setDispatchRunError(null);

      let cwd: string;
      try {
        cwd = await window.api.getWorktreePath({
          projectId: target.projectId,
          worktreeId: target.worktreeId,
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
          projectId: target.projectId,
          worktreeId: target.worktreeId,
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
          setDispatchRunError(result.error ?? 'Pipeline execution failed');
          return;
        }

        watcher.reset();
        setTarget(null);
        setDispatchRunError(null);
      } catch (error: unknown) {
        setDispatchRunError(extractIpcErrorMessage(error));
      } finally {
        setDispatchRunning(false);
      }
    },
    [target, watcher],
  );

  const dispatchPipelineModal = target
    ? createPortal(
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
        />,
        document.body,
      )
    : null;

  return { openDispatchPipelineModal, dispatchPipelineModal };
}
