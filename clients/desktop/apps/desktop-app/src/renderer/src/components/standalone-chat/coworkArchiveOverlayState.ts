/**
 * Which archive surface `CoworkArchiveOverlay` shows for a mount, as pure
 * selectors plus one hook. The overlay covers the whole panel grid
 * (`absolute inset-0`), so the Cowork page also reads
 * {@link useCoworkArchiveOverlayOpen} to report its grid as hidden while an
 * archive view is up.
 */
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { isCoworkChatTarget } from '@/lib/cowork';
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';

/** The mount that owns an overlay: the Cowork page or the App Advisor. */
export type CoworkArchiveOverlaySurface = 'cowork' | 'app-advisor';

function belongsToSurface(
  workspaceId: string,
  surface: CoworkArchiveOverlaySurface,
): boolean {
  const isAdvisor = workspaceId === APP_ADVISOR_PROJECT_ID;
  if (surface === 'app-advisor') return isAdvisor;
  return !isAdvisor && isCoworkChatTarget(workspaceId);
}

/**
 * The archived work-entry container viewer this surface renders, or `null`.
 * Gated on the owning workspace (synchronously known), never on a loaded
 * summary, so the overlay neither waits for summaries nor drops early.
 */
export function selectArchivedViewerForSurface<
  Viewer extends { readonly workspaceId: string },
>(viewer: Viewer | null, surface: CoworkArchiveOverlaySurface): Viewer | null {
  if (viewer === null) return null;
  return belongsToSurface(viewer.workspaceId, surface) ? viewer : null;
}

/** The archived-items overview workspace this surface renders, or `null`. */
export function selectArchivedOverviewWorkspaceForSurface(
  overview: { readonly workspaceId: string } | null,
  surface: CoworkArchiveOverlaySurface,
): string | null {
  if (overview === null) return null;
  return belongsToSurface(overview.workspaceId, surface)
    ? overview.workspaceId
    : null;
}

/** Whether this surface's archive overlay currently covers its panel grid. */
export function useCoworkArchiveOverlayOpen(
  surface: CoworkArchiveOverlaySurface,
): boolean {
  const viewerOpen = useArchivedContainersStore(
    (s) => selectArchivedViewerForSurface(s.viewer, surface) !== null,
  );
  const overviewOpen = useArchivedContainersStore(
    (s) =>
      selectArchivedOverviewWorkspaceForSurface(s.overview, surface) !== null,
  );
  const legacyChatOpen = useStandaloneChatStore(
    (s) => s.archiveOverlayChatId !== null,
  );
  return viewerOpen || overviewOpen || legacyChatOpen;
}
