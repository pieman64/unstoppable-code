/**
 * Archive surfaces for cowork / App Advisor, shown as an overlay ABOVE the
 * panel grid so grid content (Slate composers, terminals) never unmounts
 * while browsing: the retained-container viewer, the legacy archived-chat
 * viewer (driven by the standalone store's `archiveOverlayChatId`), and the
 * workspace-scoped "Archived and deleted" overview page, in that precedence.
 * Extracted from `StandaloneChatPage` so the Cowork page and the App Advisor
 * workspace surface share one implementation.
 *
 * Stacking: `z-30` — above chat grid/composer surfaces by paint order in the
 * same stacking context, while staying below semantic app overlay tiers.
 */
import { useCallback, useEffect, type JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { StandaloneChatMeta } from '@canopy/desktop-shared/types';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';
import {
  selectArchivedOverviewWorkspaceForSurface,
  selectArchivedViewerForSurface,
  type CoworkArchiveOverlaySurface,
} from './coworkArchiveOverlayState';
import { StandaloneArchiveViewer } from '@/components/standalone-chat/StandaloneArchiveViewer';
import { ArchivedContainerView } from '@/components/archive/ArchivedContainerView';
import { ArchivedContainersOverviewPage } from '@/components/archive/ArchivedContainersOverviewPage';
import { LoadingSpinner } from '@/components/shared/loading/spinners/LoadingSpinner';

const SUMMARY_LOADING = '__loading__';

export interface CoworkArchiveOverlayProps {
  /**
   * Which mount owns this overlay: the cowork chat page or the App Advisor
   * workspace surface (popout). Determines which work-entry containers this
   * instance renders so both surfaces can be mounted simultaneously.
   */
  surface?: CoworkArchiveOverlaySurface;
}

export function CoworkArchiveOverlay({
  surface = 'cowork',
}: CoworkArchiveOverlayProps = {}): JSX.Element | null {
  // Archived work-entry container viewer (Archive & Retention). Takes
  // precedence over the legacy single-chat archive when open for this
  // surface; worktree-kind containers render in WorktreeManager instead.
  // Gate on the OWNING WORKSPACE (synchronously known), never on the loaded
  // summary: waiting for summaries delays the open, and a consumed summary
  // mid-restore would drop the overlay early and flash the underlying grid.
  const archivedEntryViewer = useArchivedContainersStore(
    useShallow((s) => selectArchivedViewerForSurface(s.viewer, surface)),
  );
  const closeArchivedViewerToOverview = useArchivedContainersStore(
    (s) => s.closeViewerToOverview,
  );
  const closeArchivedOverview = useArchivedContainersStore(
    (s) => s.closeOverview,
  );
  // Overview page for this surface's workspaces; same ownership gate as the
  // container viewer above.
  const archivedOverviewWorkspaceId = useArchivedContainersStore((s) =>
    selectArchivedOverviewWorkspaceForSurface(s.overview, surface),
  );
  const archiveOverlayChatId = useStandaloneChatStore(
    (s) => s.archiveOverlayChatId,
  );
  const activeSummary = useStandaloneChatStore((s) => s.activeSummary);
  const activeArchiveData = useStandaloneChatStore((s) => s.activeArchiveData);
  const activeChatProjectId = useStandaloneChatStore(
    (s) => s.activeChatProjectId,
  );
  // Legacy archived metas are no longer part of the live entry list; read the
  // lazily loaded legacy slice (loaded by the sidebar on expand and again here
  // as a fallback for direct opens, e.g. ForkedFromLink).
  const legacyArchivedLoaded = useStandaloneChatStore(
    (s) => s.legacyArchivedByProject[s.activeChatProjectId] !== undefined,
  );
  const activeMeta = useStandaloneChatStore((s): StandaloneChatMeta | null => {
    if (s.archiveOverlayChatId === null) {
      return null;
    }
    return (
      s.legacyArchivedByProject[s.activeChatProjectId]?.find(
        (chat) => chat.id === s.archiveOverlayChatId,
      ) ?? null
    );
  });
  const loadLegacyArchivedChats = useStandaloneChatStore(
    (s) => s.loadLegacyArchivedChats,
  );
  const closeArchiveOverlay = useStandaloneChatStore(
    (s) => s.closeArchiveOverlay,
  );

  const overlayOpen = archiveOverlayChatId !== null;
  useEffect(() => {
    if (overlayOpen && !legacyArchivedLoaded) {
      void loadLegacyArchivedChats(activeChatProjectId).catch(() => {
        // Meta lookup is best-effort; the viewer falls back to the snapshot.
      });
    }
  }, [
    overlayOpen,
    legacyArchivedLoaded,
    loadLegacyArchivedChats,
    activeChatProjectId,
  ]);

  const handleClose = useCallback((): void => {
    closeArchiveOverlay();
  }, [closeArchiveOverlay]);

  if (archivedEntryViewer !== null) {
    return (
      <div
        className="electron-no-drag absolute inset-0 z-30 flex flex-col bg-base"
        data-testid="cowork-archive-overlay"
      >
        {surface === 'app-advisor' && (
          // The popout's AppAdvisorTopBar unmounts while this viewer is open;
          // reserve its 43px titlebar row (window-drag region + the strip the
          // persistent AppAdvisorTitlebarCorner controls sit over when the
          // nav is collapsed) so the viewer header stays clear of window
          // chrome.
          <div className="electron-drag h-10.75 shrink-0" />
        )}
        <ArchivedContainerView
          workspaceId={archivedEntryViewer.workspaceId}
          containerId={archivedEntryViewer.containerId}
          onClose={closeArchivedViewerToOverview}
        />
      </div>
    );
  }

  if (archiveOverlayChatId === null) {
    if (archivedOverviewWorkspaceId === null) {
      return null;
    }
    return (
      <div
        className="electron-no-drag absolute inset-0 z-30 flex flex-col bg-base"
        data-testid="cowork-archive-overlay"
      >
        {surface === 'app-advisor' && (
          <div className="electron-drag h-10.75 shrink-0" />
        )}
        <ArchivedContainersOverviewPage
          workspaceId={archivedOverviewWorkspaceId}
          surface={surface}
          onClose={closeArchivedOverview}
        />
      </div>
    );
  }

  return (
    <div
      className="electron-no-drag absolute inset-0 z-30 flex flex-col bg-base"
      data-testid="cowork-archive-overlay"
    >
      <div className="flex shrink-0 justify-end border-b px-3 py-1.5">
        <button
          type="button"
          onClick={handleClose}
          data-testid="cowork-archive-overlay-close"
          className="rounded px-2 py-1 text-xs fg-secondary hover:bg-fg-primary/[0.06] hover:fg-primary"
        >
          Back
        </button>
      </div>
      {activeSummary === SUMMARY_LOADING ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-3 fg-secondary">
            <LoadingSpinner tone="secondary" />
            <span className="text-sm">Loading archive…</span>
          </div>
        </div>
      ) : (
        <StandaloneArchiveViewer
          transcriptScope={activeArchiveData?.transcriptScope}
          summary={activeSummary}
          meta={activeMeta}
          tab={activeArchiveData?.tab ?? null}
          legacySummaryOnly={activeArchiveData?.legacySummaryOnly ?? true}
        />
      )}
    </div>
  );
}
