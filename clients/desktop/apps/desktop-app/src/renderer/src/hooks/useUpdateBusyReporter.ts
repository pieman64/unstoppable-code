import { useEffect } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';

const REPORT_DEBOUNCE_MS = 200;

function hasEntries(value: Set<unknown> | Record<string, unknown>): boolean {
  if (value instanceof Set) {
    return value.size > 0;
  }
  return Object.keys(value).length > 0;
}

function isAnyAgentBusy(): boolean {
  // `worktreeChats` holds both worktree-bound chats and standalone chats;
  // standalone entries are keyed under `${STANDALONE_CHAT_PROJECT_ID}/${projectId}`
  // (see standaloneChatStore.ts), so one loop covers both.
  const chats = useChatStore.getState();
  const worktreeKeysWithPendingQuestionsByChat = new Set(
    Object.values(chats.pendingQuestions)
      .filter((pending) => pending.answeredAt === undefined)
      .map(
        (pending) =>
          `${pending.projectId}/${pending.worktreeId}/${pending.chatId}`,
      ),
  );
  for (const [worktreeKey, wc] of Object.entries(chats.worktreeChats)) {
    for (const tab of wc.tabs) {
      const isWaitingForUser = worktreeKeysWithPendingQuestionsByChat.has(
        `${worktreeKey}/${tab.id}`,
      );
      if (tab.status === 'streaming' && !isWaitingForUser) {
        return true;
      }
    }
  }

  const pipelines = usePipelineRunsStore.getState();
  if (
    !pipelines.hasHydratedGlobalPipelineStatuses ||
    pipelines.isHydratingGlobalPipelineStatuses
  ) {
    return true;
  }
  for (const running of Object.values(pipelines.runningExecutionsByWorktree)) {
    if (running.size > 0) {
      return true;
    }
  }
  for (const pending of Object.values(pipelines.pendingExecutions)) {
    if (pending.length > 0) {
      return true;
    }
  }
  for (const queued of Object.values(pipelines.queuedExecutionsByWorktree)) {
    if (queued.length > 0) {
      return true;
    }
  }

  const git = useGitHubStore.getState();
  if (
    hasEntries(git.creatingPr) ||
    hasEntries(git.committingAndPushing) ||
    hasEntries(git.mergingLocalBranches) ||
    hasEntries(git.mergingPr) ||
    hasEntries(git.gitStatsRefreshing) ||
    hasEntries(git.commitReviewPending)
  ) {
    return true;
  }

  return false;
}

/**
 * Reports the renderer's "any agent busy" state to the main process so the
 * updater can fire a deferred install once all agents are idle. Mounted once
 * at the App root.
 */
export function useUpdateBusyReporter(): void {
  useEffect(() => {
    let lastReported: boolean | null = null;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;

    const report = (busy: boolean): void => {
      if (busy === lastReported) {
        return;
      }
      lastReported = busy;
      void window.api.update.reportBusyState(busy).catch(() => {
        // Updater has its own error reporting; busy reporting is best-effort.
      });
    };

    const flush = (): void => {
      pendingTimer = null;
      report(isAnyAgentBusy());
    };

    const clearPendingTimer = (): void => {
      if (pendingTimer === null) {
        return;
      }
      clearTimeout(pendingTimer);
      pendingTimer = null;
    };

    const schedule = (): void => {
      const busy = isAnyAgentBusy();
      if (busy) {
        clearPendingTimer();
        report(true);
        return;
      }
      if (pendingTimer !== null) {
        return;
      }
      pendingTimer = setTimeout(flush, REPORT_DEBOUNCE_MS);
    };

    const unsubscribeChat = useChatStore.subscribe(schedule);
    const unsubscribePipelines = usePipelineRunsStore.subscribe(
      (state, previousState) => {
        // Output buffering publishes frequently while pipelines stream, but
        // it cannot change updater busy state. Avoid rescanning every chat and
        // pipeline collection for those output-only store updates.
        if (
          state.hasHydratedGlobalPipelineStatuses ===
            previousState.hasHydratedGlobalPipelineStatuses &&
          state.isHydratingGlobalPipelineStatuses ===
            previousState.isHydratingGlobalPipelineStatuses &&
          state.runningExecutionsByWorktree ===
            previousState.runningExecutionsByWorktree &&
          state.pendingExecutions === previousState.pendingExecutions &&
          state.queuedExecutionsByWorktree ===
            previousState.queuedExecutionsByWorktree
        ) {
          return;
        }
        schedule();
      },
    );
    const unsubscribeGit = useGitHubStore.subscribe(schedule);

    // Let store hydration and same-tick subscription setup settle before the
    // first busy snapshot is reported to the main process.
    pendingTimer = setTimeout(flush, 0);

    return (): void => {
      unsubscribeChat();
      unsubscribePipelines();
      unsubscribeGit();
      clearPendingTimer();
    };
  }, []);
}
