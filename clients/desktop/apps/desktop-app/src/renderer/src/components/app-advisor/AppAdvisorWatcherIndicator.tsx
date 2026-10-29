import { useEffect, type JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { AppAdvisorWatcherDestination } from '@canopy/desktop-shared/types';
import { useAppAdvisorWatchersStore } from '@/stores/appAdvisorWatchersStore';
import { WatcherManagementButton } from '@/components/watchers/WatcherManagementButton';

interface AppAdvisorWatcherIndicatorProps {
  chatId?: string;
  destination?: AppAdvisorWatcherDestination;
}

/**
 * App Advisor / cowork composer watcher indicator.
 *
 * This is a thin wrapper around the shared
 * {@link WatcherManagementButton}/`WatcherManagementModal` so the App Advisor
 * surface and the worktree chat surface render every watcher target — including
 * the grouped `github_workflow_runs` target — through a single display
 * implementation. The wrapper owns only what is specific to this surface: the
 * store hydration on mount and the destination-based filtering that decides
 * which watchers this composer manages. All row/tooltip/modal rendering plus the
 * jump, delete, notify-subscriber, and follow-up behaviors live in the shared
 * components, so App Advisor and worktree chat can never drift into different
 * target semantics.
 */
export function AppAdvisorWatcherIndicator({
  chatId,
  destination,
}: AppAdvisorWatcherIndicatorProps): JSX.Element | null {
  const effectiveChatId = destination?.chatId ?? chatId;

  // Subscribe to the whole watcher list and filter locally so we re-render
  // whenever any visible watcher changes. `useShallow` keeps the returned
  // array reference stable when the filtered slice has not moved. Only
  // renderer-visible statuses (`active`, `delivery_failed`) participate.
  const matchingWatchers = useAppAdvisorWatchersStore(
    useShallow((s) =>
      s.watchers.filter((watcher) => {
        if (
          watcher.status !== 'active' &&
          watcher.status !== 'delivery_failed'
        ) {
          return false;
        }
        if (destination) {
          return (
            watcher.destination.projectId === destination.projectId &&
            watcher.destination.worktreeId === destination.worktreeId &&
            watcher.destination.chatId === destination.chatId
          );
        }
        return effectiveChatId
          ? watcher.destination.chatId === effectiveChatId
          : false;
      }),
    ),
  );

  // Hydrate once on mount if no upstream has loaded the watcher list yet. The
  // store's `subscribeBridge` is the long-lived listener so updates continue to
  // flow through `onWatchersChanged` after this initial fetch.
  useEffect(() => {
    const unsubscribe = useAppAdvisorWatchersStore.getState().subscribeBridge();
    const store = useAppAdvisorWatchersStore.getState();
    if (!store.hydrated && !store.loading && store.error === null) {
      void store.hydrate();
    }
    return unsubscribe;
    // Intentionally only on mount; the store keeps itself in sync after that.
  }, []);

  return (
    <WatcherManagementButton
      watchers={matchingWatchers}
      modalTitle="Watchers"
      modalEmptyMessage="No active watchers for this chat."
      ariaLabel="Active watchers"
      dataTestId="app-advisor-watcher-indicator"
      icon="bigtop"
      tooltipTitle="Active watchers"
    />
  );
}
