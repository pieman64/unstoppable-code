import { useEffect } from 'react';
import { useGitHubStore } from '@/stores/githubStore';
import {
  addFailureToast,
  clearFailureToast,
  type ToastMeta,
} from '@/stores/toastStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { getToastType } from '@canopy/desktop-shared/pipelines/get-toast-type';
import { getPipelineNotificationClass } from '@canopy/desktop-shared/pipelines/get-notification-class';
import { openPipelineExecutionFromUi } from '@/lib/panels/open-pipeline-execution';
import { WORKFLOW_ITEM_LABEL } from '@canopy/ui-shared/lib/workflow-labels';
import {
  ownWorkToastError,
  unclassifiedToastError,
} from '@canopy/ui-shared/lib';
import type { AppError } from '@canopy/protocol/app-errors';
import type { ExecutionEvent } from '@canopy/execution-engine/types/pipeline';

/**
 * A workflow's visible failure. Only a run with a space has a stable identity,
 * so a project-only or global run stays unkeyed.
 */
function pipelineFailureToastKey({
  state,
}: ExecutionEvent): string | undefined {
  return state.project_id && state.worktree_id
    ? `pipeline:${state.project_id}/${state.worktree_id}/${state.pipeline_id}`
    : undefined;
}

/** A failed execution is an app failure; a finished failed run is the person's. */
function pipelineFailureError(
  event: ExecutionEvent,
  message: string,
): AppError {
  return event.type === 'execution.failed'
    ? unclassifiedToastError()
    : ownWorkToastError(message);
}

/**
 * Completed, failed, and paused root runs raise a toast (and, through the
 * toast store, an OS notification sharing its click), subject to the
 * originating space's notification choice. Receiving one never
 * navigates or moves focus. Clicking it opens the run's own panel in its
 * worktree or Cowork task through the shared opener, which takes the owner
 * from the run; a run without a workspace opens in the compatibility view.
 */
export function usePipelineCompletionToasts(): void {
  useEffect(() => {
    // The start of the newest failure on screen per workflow and space: a run
    // that started earlier can't speak for the one that failed after it.
    const failedStarts = new Map<string, string>();
    const unsubscribe = window.pipelines.onExecutionEvent((event) => {
      const toastType = getToastType(event);
      if (!toastType) {
        return;
      }

      const { pipeline_snapshot, project_id, worktree_id } = event.state;
      const message =
        toastType === 'success'
          ? `${WORKFLOW_ITEM_LABEL} "${pipeline_snapshot.name}" completed`
          : toastType === 'warning'
            ? `${WORKFLOW_ITEM_LABEL} "${pipeline_snapshot.name}" paused`
            : `${WORKFLOW_ITEM_LABEL} "${pipeline_snapshot.name}" failed`;
      const executionId = event.executionId;
      const onClick = (): void => {
        void openPipelineExecutionFromUi({
          executionId,
          ...(project_id && worktree_id
            ? { owner: { projectId: project_id, worktreeId: worktree_id } }
            : {}),
        });
      };

      const wsName = project_id
        ? useProjectsStore.getState().projects.find((p) => p.id === project_id)
            ?.name
        : undefined;
      // A run started from a worktree or Cowork task reports to that space's
      // notification choice. A project-only run (a Cowork automation with no
      // task) belongs to no space and keeps the default.
      const eventClass = getPipelineNotificationClass(event);
      const meta: ToastMeta = {
        category: 'Pipeline',
        workspaceName: wsName,
        projectId: project_id ?? undefined,
        worktreeId: worktree_id ?? undefined,
        // A paused run waits on the user; only a finished run is a completion.
        ...(toastType === 'warning' ? {} : { agentCompletion: true }),
        ...(project_id && worktree_id && eventClass
          ? {
              notificationScope: {
                projectId: project_id,
                worktreeId: worktree_id,
                eventClass,
              },
            }
          : {}),
      };
      const key = pipelineFailureToastKey(event);
      if (toastType === 'error') {
        const failedStart =
          key === undefined ? undefined : failedStarts.get(key);
        // Only the newest run's failure takes the key. An older run that fails
        // later stays unkeyed, so it can't replace the newer toast and its link.
        const newest =
          key !== undefined &&
          (failedStart === undefined || event.state.started_at >= failedStart);
        if (newest) failedStarts.set(key, event.state.started_at);
        addFailureToast({
          message,
          error: pipelineFailureError(event, message),
          origin: {
            label: `Open ${WORKFLOW_ITEM_LABEL.toLowerCase()}`,
            open: onClick,
          },
          ...(newest ? { key } : {}),
          meta,
        });
        return;
      }
      if (toastType === 'success' && key !== undefined) {
        const failedStart = failedStarts.get(key);
        if (
          failedStart !== undefined &&
          event.state.started_at >= failedStart
        ) {
          failedStarts.delete(key);
          clearFailureToast(key);
        }
      }
      useGitHubStore
        .getState()
        .addToast(
          message,
          toastType === 'success' ? 'success' : 'warning',
          onClick,
          meta,
        );
    });

    return (): void => {
      unsubscribe();
    };
  }, []);
}
