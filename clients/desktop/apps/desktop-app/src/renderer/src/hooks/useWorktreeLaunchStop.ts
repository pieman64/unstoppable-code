import { useCallback, type MouseEvent } from 'react';
import { useShallow } from 'zustand/shallow';
import { isScriptRunActive, useScriptsStore } from '@/stores/scriptsStore';

export interface WorktreeLaunchStop {
  /** The running launch script's key, or null when no launch is running. */
  readonly launchScriptKey: string | null;
  readonly isLaunchStopping: boolean;
  readonly stopLaunch: (event: MouseEvent<HTMLButtonElement>) => void;
}

/**
 * The worktree's running launch script and the action that stops it: the
 * row's stop control on both sidebar rails. The click never reaches the row,
 * so stopping the script does not also select the worktree.
 */
export function useWorktreeLaunchStop(
  projectId: string,
  worktreeId: string,
): WorktreeLaunchStop {
  // The scripts store keys runs by `projectId/worktreeId`.
  const key = `${projectId}/${worktreeId}`;
  const { launchScriptKey, isLaunchStopping } = useScriptsStore(
    useShallow((state) => {
      const runs = state.runs[key];
      if (!runs) return { launchScriptKey: null, isLaunchStopping: false };
      for (const [scriptKey, run] of Object.entries(runs)) {
        if (run.lifecycle === 'launch' && isScriptRunActive(run.status)) {
          return {
            launchScriptKey: scriptKey,
            isLaunchStopping: run.status === 'stopping',
          };
        }
      }
      return { launchScriptKey: null, isLaunchStopping: false };
    }),
  );
  const markScriptStopping = useScriptsStore((state) => state.markStopping);
  const stopLaunch = useCallback(
    (event: MouseEvent<HTMLButtonElement>): void => {
      event.stopPropagation();
      if (!launchScriptKey || isLaunchStopping) return;
      if (!markScriptStopping(projectId, worktreeId, launchScriptKey)) return;
      void window.api
        .stopScript({ projectId, worktreeId, scriptKey: launchScriptKey })
        .then((response) => {
          const scriptsState = useScriptsStore.getState();
          if (response) {
            scriptsState.completeRun(
              projectId,
              worktreeId,
              launchScriptKey,
              response,
            );
            return;
          }
          scriptsState.completeStaleRun(projectId, worktreeId, launchScriptKey);
        })
        .catch(() => {
          useScriptsStore
            .getState()
            .completeStaleRun(projectId, worktreeId, launchScriptKey);
        });
    },
    [
      launchScriptKey,
      isLaunchStopping,
      markScriptStopping,
      projectId,
      worktreeId,
    ],
  );
  return { launchScriptKey, isLaunchStopping, stopLaunch };
}
