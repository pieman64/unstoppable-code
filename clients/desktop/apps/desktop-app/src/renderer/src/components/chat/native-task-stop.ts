import { createContext, useEffect } from 'react';
import type { ModelHarness } from '@canopy/desktop-shared/types';
import {
  clearEndedBackgroundTaskStops,
  useCanopyClient,
} from '@canopy/app-state';
import { TASK_STOP_FAILED_LABEL } from '@canopy/ui-app';
import { extractIpcErrorMessage } from '@/lib/errors';
import { useGitHubStore } from '@/stores/githubStore';
import {
  isWorktreeLiveTasksHydrated,
  liveBackgroundTaskKey,
  useLiveBackgroundTaskStore,
} from '@/stores/liveBackgroundTaskStore';

export interface NativeTaskStopTarget {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}

export interface NativeTaskStopControls {
  readonly target: NativeTaskStopTarget;
  readonly onError: (error: unknown) => void;
}

export const NativeTaskStopContext =
  createContext<NativeTaskStopControls | null>(null);

export interface NativeTaskStopScopeInput {
  readonly readOnly: boolean;
  readonly target: NativeTaskStopTarget | null | undefined;
  readonly lockedHarness: ModelHarness | undefined;
}

export function deriveNativeTaskStopTarget(
  input: NativeTaskStopScopeInput,
): NativeTaskStopTarget | null {
  if (
    input.readOnly ||
    input.target === null ||
    input.target === undefined ||
    input.lockedHarness !== 'claude'
  ) {
    return null;
  }
  return input.target;
}

export function useReconcileNativeTaskStops(
  target: NativeTaskStopTarget | null,
): void {
  const client = useCanopyClient();
  const chatKey = target
    ? liveBackgroundTaskKey(target.projectId, target.worktreeId, target.chatId)
    : null;
  const liveChat = useLiveBackgroundTaskStore((state) =>
    chatKey ? state.byChat[chatKey] : undefined,
  );
  const hydrated = useLiveBackgroundTaskStore((state) =>
    target
      ? isWorktreeLiveTasksHydrated(target.projectId, target.worktreeId, state)
      : false,
  );

  useEffect(() => {
    if (!target || !hydrated) return;
    clearEndedBackgroundTaskStops(
      client,
      target,
      new Set(liveChat?.liveTasks.map((task) => task.taskId) ?? []),
    );
  }, [client, hydrated, liveChat, target]);
}

export function reportNativeTaskStopFailure(
  target: Pick<NativeTaskStopTarget, 'projectId' | 'worktreeId'> & {
    readonly chatId?: string;
  },
  error: unknown,
): void {
  const detail = extractIpcErrorMessage(error).trim();
  const message = detail
    ? `${TASK_STOP_FAILED_LABEL} ${detail}`
    : TASK_STOP_FAILED_LABEL;
  useGitHubStore.getState().addToast(message, 'error', undefined, {
    category: 'Chat',
    projectId: target.projectId,
    worktreeId: target.worktreeId,
    ...(target.chatId !== undefined ? { chatId: target.chatId } : {}),
  });
}
