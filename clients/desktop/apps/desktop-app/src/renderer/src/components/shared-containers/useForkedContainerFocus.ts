/**
 * Focus a freshly forked container once it is actually in front (CAN-4782).
 *
 * `openForkedContainer` registers the request as soon as the copy is selected,
 * but the copy's surface can still be covered then: the share viewer is
 * closing, and the fork dialog stays mounted until the reveal settles. Focusing
 * the mounted worktree behind either would put keyboard focus somewhere the
 * user cannot see. So the request waits until its page is shown, the viewer is
 * gone, no fork dialog holds it, and the provenance read has finished.
 *
 * The request is consumed only once focus lands, so effect replays and
 * provenance rerenders cannot focus it twice. A request for another
 * destination on this page means the user moved on, so it is cancelled rather
 * than left to take focus on a later visit.
 */
import { useEffect, useSyncExternalStore, type RefObject } from 'react';
import {
  isWorkspaceContextSelectionRestoring,
  subscribeWorkspaceContextSelectionRestoration,
} from '@/lib/workspaceContextSelection';
import { focusForkedContainerTarget } from '@/lib/shared-containers/forked-container-focus';
import { useNavigationStore } from '@/stores/navigationStore';
import { useChatStore } from '@/stores/chatStore';
import { useSharedContainerReplicasStore } from '@/stores/sharedContainerReplicasStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

const HEADER_FOCUS_SELECTOR =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ForkedContainerFocusTarget {
  readonly page: 'main' | 'chat';
  /**
   * The destination header's test id. Its first control takes focus when the
   * copy's provenance could not be read.
   */
  readonly headerTestId: string;
}

export interface UseForkedContainerFocusOptions {
  readonly projectId: string | null;
  readonly worktreeId: string | null;
  /** `null` where no fork can land, which leaves every request alone. */
  readonly focusTarget: ForkedContainerFocusTarget | null;
  /** The provenance read for this destination has finished. */
  readonly provenanceSettled: boolean;
  readonly provenanceRef: RefObject<HTMLElement | null>;
}

function findHeaderFocusTarget(headerTestId: string): HTMLElement | null {
  const header = document.querySelector(`[data-testid="${headerTestId}"]`);
  return header?.querySelector<HTMLElement>(HEADER_FOCUS_SELECTOR) ?? null;
}

export function useForkedContainerFocus({
  projectId,
  worktreeId,
  focusTarget,
  provenanceSettled,
  provenanceRef,
}: UseForkedContainerFocusOptions): void {
  const page = focusTarget?.page ?? null;
  const headerTestId = focusTarget?.headerTestId ?? null;
  const request = useNavigationStore(
    (state) => state.pendingForkedContainerFocus,
  );
  const activePage = useNavigationStore((state) => state.activePage);
  const held = useNavigationStore(
    (state) => state.forkedContainerFocusHolds > 0,
  );
  const viewerOpen = useSharedContainerReplicasStore(
    (state) => state.viewer !== null,
  );
  const accountEpoch = useWorkspaceContextStore((state) => state.accountEpoch);
  const restoringSelection = useSyncExternalStore(
    subscribeWorkspaceContextSelectionRestoration,
    isWorkspaceContextSelectionRestoring,
    isWorkspaceContextSelectionRestoring,
  );

  useEffect(() => {
    if (request === undefined || page !== request.page) return;
    // Selection notifications run before React unmounts a deselected page.
    // A render-only check would lose its consumer and retain a stale request.
    const unsubscribeSelection = useChatStore.subscribe(
      (state, previous): void => {
        if (state.selectedWorktree === previous.selectedWorktree) return;
        if (isWorkspaceContextSelectionRestoring()) return;
        const selected = state.selectedWorktree;
        if (
          selected?.projectId !== request.projectId ||
          selected.worktreeId !== request.worktreeId
        ) {
          useNavigationStore
            .getState()
            .consumeForkedContainerFocus(request.nonce);
        }
      },
    );
    const unsubscribeAccount = useWorkspaceContextStore.subscribe(
      (state): void => {
        if (state.accountEpoch !== request.accountEpoch) {
          useNavigationStore
            .getState()
            .consumeForkedContainerFocus(request.nonce);
        }
      },
    );
    return (): void => {
      unsubscribeSelection();
      unsubscribeAccount();
    };
  }, [page, request]);

  useEffect(() => {
    if (
      page === null ||
      headerTestId === null ||
      request === undefined ||
      request.page !== page ||
      activePage !== page
    ) {
      return;
    }
    const { consumeForkedContainerFocus } = useNavigationStore.getState();
    if (request.accountEpoch !== accountEpoch) {
      consumeForkedContainerFocus(request.nonce);
      return;
    }
    if (restoringSelection) return;
    if (request.projectId !== projectId || request.worktreeId !== worktreeId) {
      consumeForkedContainerFocus(request.nonce);
      return;
    }
    if (viewerOpen || held || !provenanceSettled) return;
    const target = provenanceRef.current ?? findHeaderFocusTarget(headerTestId);
    if (target === null) {
      // Nothing to focus on this destination; waiting would only let the
      // request take focus on a later visit.
      consumeForkedContainerFocus(request.nonce);
      return;
    }
    if (focusForkedContainerTarget(target)) {
      consumeForkedContainerFocus(request.nonce);
    }
  }, [
    accountEpoch,
    activePage,
    headerTestId,
    held,
    page,
    projectId,
    provenanceRef,
    provenanceSettled,
    request,
    restoringSelection,
    viewerOpen,
    worktreeId,
  ]);
}
