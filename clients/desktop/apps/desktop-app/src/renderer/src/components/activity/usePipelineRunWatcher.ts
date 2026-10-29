// Shared wiring for the pipeline-run modal's watcher toggle. Builds the
// recipient groups (App Advisor chats plus the current worktree's chats),
// tracks the chosen recipient, and returns watcher setup to include in the
// pipeline execute request. Used by the dispatch / plan-ready / task-ready run
// flows so the watcher is set up before execution events can complete.

import { useCallback, useEffect, useRef } from 'react';
import type { AppAdvisorWatcherDestination } from '@canopy/desktop-shared/types';
import { useAppAdvisorWatchersStore } from '@/stores/appAdvisorWatchersStore';
import type { WatcherRecipientGroup } from '@/components/watchers/WatcherRecipientPicker';
import { useWatcherRecipientGroups } from '@/components/watchers/useWatcherRecipientGroups';

type AppAdvisorPipelineWatcherSetups = Parameters<
  typeof window.pipelines.execute
>[1]['appAdvisorPipelineWatchers'];

/**
 * The pipeline-run watcher selection reported by the trigger modal: the chosen
 * destination chat plus an optional follow-up instruction sent to that chat
 * when the watcher fires. `null` means no watcher is configured.
 */
export interface PipelineWatcherSelection {
  destination: AppAdvisorWatcherDestination;
  followUpInstruction?: string;
}

export interface PipelineRunWatcherWiring {
  recipientGroups: WatcherRecipientGroup[];
  onWatcherSelectionChange: (
    selection: PipelineWatcherSelection | null,
  ) => void;
  /**
   * Return watcher setup to include in the pipeline execute request. No-op when
   * no recipient was selected.
   */
  appAdvisorPipelineWatchers: () => AppAdvisorPipelineWatcherSetups | undefined;
  /** Clear the pending selection (call when the modal closes). */
  reset: () => void;
}

export function usePipelineRunWatcher(
  worktree: { projectId: string; worktreeId: string } | null,
): PipelineRunWatcherWiring {
  const recipientGroups = useWatcherRecipientGroups({ worktree });
  const selectedRef = useRef<PipelineWatcherSelection | null>(null);

  // Keep the store subscribed/hydrated so the recipient list and the created
  // watcher stay in sync.
  useEffect(() => {
    const unsubscribe = useAppAdvisorWatchersStore.getState().subscribeBridge();
    void useAppAdvisorWatchersStore.getState().hydrate();
    return unsubscribe;
  }, []);

  const onWatcherSelectionChange = useCallback(
    (selection: PipelineWatcherSelection | null): void => {
      selectedRef.current = selection;
    },
    [],
  );

  const appAdvisorPipelineWatchers = useCallback(():
    | AppAdvisorPipelineWatcherSetups
    | undefined => {
    const selection = selectedRef.current;
    if (!selection) return undefined;
    return [
      {
        destination: selection.destination,
        watcher: {
          ...(selection.followUpInstruction
            ? { followUpInstruction: selection.followUpInstruction }
            : {}),
        },
      },
    ];
  }, []);

  const reset = useCallback((): void => {
    selectedRef.current = null;
  }, []);

  return {
    recipientGroups,
    onWatcherSelectionChange,
    appAdvisorPipelineWatchers,
    reset,
  };
}
