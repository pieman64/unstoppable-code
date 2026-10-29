import { useLayoutEffect, type JSX } from 'react';
import { useFileViewerStoreApi } from '@canopy/app-state';
import { desktopFileSessionController } from '@/lib/file-viewer/desktop-file-session-controller';
import { useFileTabUiStore } from '@/stores/fileTabUiStore';
import { useProjectsStore } from '@/stores/projectsStore';

/**
 * Binds the singleton {@link desktopFileSessionController} to the exact
 * provider-scoped shared file-viewer store instance used by `FileViewer`.
 *
 * Mounted once inside `CanopyClientProvider` (main surface only). It:
 * - attaches the store and supplies the diff-stat refresh callback, so a
 *   successful save refreshes changed-file stats exactly once regardless of the
 *   save entrypoint (button, shortcut, App Advisor, close-save, autosave);
 * - keeps the controller's autosave policy in sync with the file-tab UI
 *   preference (hydration + live Settings toggles);
 * - detaches (cancelling queued timers, never aborting an in-flight write) on
 *   unmount.
 *
 * It never owns file tabs itself, so it is intentionally NOT mounted for the
 * standalone App Advisor renderer.
 */
export function DesktopFileSessionRuntime(): JSX.Element | null {
  const storeApi = useFileViewerStoreApi();

  useLayoutEffect(() => {
    const detach = desktopFileSessionController.attachStore(storeApi, {
      onSaveCommitted: (request): void => {
        useProjectsStore
          .getState()
          .fastRefreshWorktreeDiffStats(request.projectId, request.worktreeId, {
            bypassFreshness: true,
          });
      },
    });
    // Sync the current autosave preference, then track live changes (Settings
    // toggle + preference hydration) so scheduling reflects the user's choice.
    desktopFileSessionController.setAutoSaveEnabled(
      useFileTabUiStore.getState().autoSaveEnabled,
    );
    const unsubscribePreference = useFileTabUiStore.subscribe((state) => {
      desktopFileSessionController.setAutoSaveEnabled(state.autoSaveEnabled);
    });
    return (): void => {
      unsubscribePreference();
      detach();
    };
  }, [storeApi]);

  return null;
}
