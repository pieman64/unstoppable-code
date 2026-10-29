// Helper that navigates the user to the chat a watcher subscribed from
// (i.e. the watcher's `destination`, not its `target`).
//
// Two destination shapes are supported:
//  - App Advisor sentinel: open or focus the standalone App Advisor window
//    via the IPC bridge so the user sees the chat that owns the watcher.
//  - Worktree chat: navigate the main window to `main`, select the worktree,
//    and switch to the destination tab. If the destination is no longer
//    available (worktree removed since the watcher was created), the helper
//    returns a structured error so the caller can render an inline message
//    rather than silently failing.

import type { AppAdvisorWatcherSummary } from '@canopy/desktop-shared/types';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { isAppAdvisorDestination } from './watcherDisplay';

export type JumpToWatcherSubscriberResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Navigate to the chat that subscribed to this watcher. Returns synchronously
 * because the App Advisor window-open call is fire-and-forget (the IPC layer
 * resolves on its own; callers can re-poll the appAdvisorStore for window
 * state) and the worktree navigation is synchronous Zustand state.
 */
export function jumpToWatcherSubscriberChat(
  watcher: AppAdvisorWatcherSummary,
): JumpToWatcherSubscriberResult {
  const destination = watcher.destination;
  if (isAppAdvisorDestination(destination)) {
    // The App Advisor window owns its own renderer; the IPC bridge focuses
    // it (creating the BrowserWindow if needed) and selects the chat. Best-
    // effort fire-and-forget: failures are surfaced through the App Advisor
    // store's own diagnostics, not the watcher modal.
    void window.api.appAdvisor.openWindow({
      focus: true,
      focusComposer: true,
      chatId: destination.chatId,
    });
    return { ok: true };
  }

  const projects = useProjectsStore.getState().projects;
  const exists = projects.some(
    (project) =>
      project.id === destination.projectId &&
      project.type !== 'cowork' &&
      project.worktrees.some(
        (worktree) => worktree.id === destination.worktreeId,
      ),
  );
  if (!exists) {
    return {
      ok: false,
      error: 'Destination worktree is no longer available.',
    };
  }

  useNavigationStore.getState().navigate('main');
  useChatStore
    .getState()
    .selectWorktree(destination.projectId, destination.worktreeId);
  useChatStore.getState().switchTab(destination.chatId, {
    projectId: destination.projectId,
    worktreeId: destination.worktreeId,
  });
  return { ok: true };
}
