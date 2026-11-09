import { useEffect } from 'react';
import { useHooksStore } from '@/stores/hooksStore';
import { useGitHubStore } from '@/stores/githubStore';
import { addFailureToast, type ToastMeta } from '@/stores/toastStore';
import { worktreeToastOrigin } from '@/lib/toastWorktreeNavigation';
import { ownWorkToastError } from '@canopy/ui-shared/lib';
import { useProjectsStore } from '@/stores/projectsStore';
import type {
  HookCompleteEvent,
  HookOutputEvent,
  HookSkippedPausedEvent,
  HookStartedEvent,
} from '@canopy/desktop-shared/types';

export interface HookCompletionToast {
  message: string;
  type: 'error' | 'warning';
}

const MAX_HOOK_FAILURE_TOAST_DETAIL_CHARS = 360;

function formatHookFailureDetail(output: string): string | null {
  const detail = output
    .trim()
    .split(/\s*\r?\n\s*/)
    .filter((line) => line.length > 0)
    .join(' ');
  if (!detail) {
    return null;
  }

  if (detail.length <= MAX_HOOK_FAILURE_TOAST_DETAIL_CHARS) {
    return detail;
  }

  return `${detail.slice(0, MAX_HOOK_FAILURE_TOAST_DETAIL_CHARS).trimEnd()}...`;
}

export function buildHookCompletionToast(
  event: HookCompleteEvent,
): HookCompletionToast | null {
  if (event.result.success) {
    return null;
  }

  const prefix = event.hook.label;
  if (event.result.stopped && event.result.exitCode === 2) {
    return {
      message: `${prefix} did not run because its if-command stopped the hook.`,
      type: 'warning',
    };
  }

  if (event.result.stopped) {
    return {
      message: `${prefix} stopped`,
      type: 'warning',
    };
  }

  if (event.result.timedOut) {
    return {
      message: `${prefix} timed out`,
      type: 'error',
    };
  }

  const detail = formatHookFailureDetail(event.result.output);
  if (detail) {
    return {
      message: `${prefix} failed — exit ${event.result.exitCode ?? 'unknown'}: ${detail}`,
      type: 'error',
    };
  }

  return {
    message: `${prefix} failed — exit ${event.result.exitCode ?? 'unknown'}`,
    type: 'error',
  };
}

export function useHookEventSubscriptions(): void {
  const appendOutput = useHooksStore((state) => state.appendOutput);
  const startRunFromEvent = useHooksStore((state) => state.startRunFromEvent);

  useEffect(() => {
    const unsubscribe = window.api.onHookStarted((event: HookStartedEvent) => {
      startRunFromEvent(event);
    });
    return unsubscribe;
  }, [startRunFromEvent]);

  useEffect(() => {
    const unsubscribe = window.api.onHookOutput((event: HookOutputEvent) => {
      appendOutput(event);
    });
    return unsubscribe;
  }, [appendOutput]);

  useEffect(() => {
    const unsubscribe = window.api.onHookComplete(
      (event: HookCompleteEvent) => {
        useHooksStore.getState().completeRunFromEvent(event);
        const toast = buildHookCompletionToast(event);
        if (!toast) {
          return;
        }

        const wk = `${event.projectId}/${event.worktreeId}`;
        const isTearingDown = useProjectsStore
          .getState()
          .tearingDownWorktrees.has(wk);
        if (isTearingDown) {
          return;
        }

        const project = useProjectsStore
          .getState()
          .projects.find((entry) => entry.id === event.projectId);
        const meta: ToastMeta = {
          category: 'Hook',
          workspaceName: project?.name,
          projectId: event.projectId,
          worktreeId: event.worktreeId,
        };
        // Hooks are automated work in the space: a failed run is a failure,
        // a stopped or skipped one is routine (CAN-3615). Hook events carry no
        // run ID or time, so a later success can't safely clear a failure.
        if (toast.type === 'error') {
          addFailureToast({
            message: toast.message,
            error: ownWorkToastError(toast.message),
            origin: worktreeToastOrigin(event.projectId, event.worktreeId),
            meta: {
              ...meta,
              notificationScope: {
                projectId: event.projectId,
                worktreeId: event.worktreeId,
                eventClass: 'failure',
              },
            },
          });
          return;
        }
        useGitHubStore
          .getState()
          .addToast(toast.message, 'warning', undefined, {
            ...meta,
            notificationScope: {
              projectId: event.projectId,
              worktreeId: event.worktreeId,
              eventClass: 'routine',
            },
          });
      },
    );
    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = window.api.onHookSkippedPaused(
      (event: HookSkippedPausedEvent) => {
        const wk = `${event.projectId}/${event.worktreeId}`;
        const isTearingDown = useProjectsStore
          .getState()
          .tearingDownWorktrees.has(wk);
        if (isTearingDown) {
          return;
        }

        const project = useProjectsStore
          .getState()
          .projects.find((entry) => entry.id === event.projectId);
        useGitHubStore
          .getState()
          .addToast(
            `${event.hook.label} is paused — did not execute`,
            'info',
            undefined,
            {
              category: 'Hook',
              workspaceName: project?.name,
              projectId: event.projectId,
              worktreeId: event.worktreeId,
              notificationScope: {
                projectId: event.projectId,
                worktreeId: event.worktreeId,
                eventClass: 'routine',
              },
            },
          );
      },
    );
    return unsubscribe;
  }, []);
}
