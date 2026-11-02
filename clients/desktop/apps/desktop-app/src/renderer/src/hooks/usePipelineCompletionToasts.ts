import { useEffect } from 'react';
import { useGitHubStore } from '@/stores/githubStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { getToastType } from '@canopy/desktop-shared/pipelines/get-toast-type';
import { getPipelineNotificationClass } from '@canopy/desktop-shared/pipelines/get-notification-class';
import { openPipelineExecutionFromUi } from '@/lib/panels/open-pipeline-execution';
import { WORKFLOW_ITEM_LABEL } from '@canopy/ui-shared/lib/workflow-labels';

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
      useGitHubStore.getState().addToast(message, toastType, onClick, {
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
      });
    });

    return (): void => {
      unsubscribe();
    };
  }, []);
}
