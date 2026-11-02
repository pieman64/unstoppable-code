import {
  APP_ADVISOR_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
  serializeWorkspaceContext,
  type WorkspaceContext,
  type WorktreeSelection,
} from '@canopy/desktop-shared/types';
import { isSameWorkspaceContext } from '@canopy/protocol/workspace-context';
import { getSidebarScopingContext } from '@/components/sidebar/useSidebarScopingContext';
import { sharedContainerHomeContext } from '@/lib/shared-containers/home-context';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useSharedContainerReplicasStore } from '@/stores/sharedContainerReplicasStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { selectionBelongsToContext } from './standaloneChatSelection';

let pendingSelectionRestorations = 0;
const restorationListeners = new Set<() => void>();

/** Focus waits until a context restore has released its transient selection. */
export function isWorkspaceContextSelectionRestoring(): boolean {
  return pendingSelectionRestorations > 0;
}

export function subscribeWorkspaceContextSelectionRestoration(
  listener: () => void,
): () => void {
  restorationListeners.add(listener);
  return (): void => {
    restorationListeners.delete(listener);
  };
}

/**
 * Keep the open Code worktree or Cowork task selection consistent with the Personal/organization
 * context (CAN-2954, plan chapter 03). Switching into a context clears the
 * selection that belonged to the previous one and restores the last selection
 * made in the new one, if any. Nothing running is stopped: selection is
 * navigation only, and the worktree or task keeps working in the background.
 * A selection that does not belong to the departing context (a fork opened
 * there for another context, for example) is never remembered for it
 * (CAN-4781).
 */
export function syncSelectionForContextChange(
  previous: WorkspaceContext,
  next: WorkspaceContext,
): void {
  const previousKey = serializeWorkspaceContext(previous);
  const nextKey = serializeWorkspaceContext(next);
  if (previousKey === nextKey) {
    return;
  }
  const chat = useChatStore.getState();
  const context = useWorkspaceContextStore.getState();
  const departing = chat.selectedWorktree;
  context.rememberSelection(
    previousKey,
    departing && selectionFitsContext(departing, previous) ? departing : null,
  );
  clearCurrentSelection();
  closeShareViewerOutside(next);
  restoreSelectionForContext(nextKey, next);
}

/**
 * A selection belongs to its workspace's owner. A Personal checkout linked to
 * an organization still belongs to Personal (CAN-4781). The Personal
 * standalone and global App Advisor sentinels can have no workspace row.
 * A missing workspace was deleted and is not restorable.
 */
function selectionFitsContext(
  selection: WorktreeSelection,
  context: WorkspaceContext,
): boolean {
  const projects = useProjectsStore.getState().projects;
  const project = projects.find((item) => item.id === selection.projectId);
  if (!project) {
    return (
      selection.projectId === APP_ADVISOR_PROJECT_ID ||
      (context.kind === 'personal' &&
        selection.projectId === STANDALONE_CHAT_PROJECT_ID)
    );
  }
  return selectionBelongsToContext(selection, projects, context);
}

/**
 * A share viewer shows one share's content; it is not part of the remembered
 * selection, so it closes whenever the entered context is not the share's
 * home context. An accepted share's home is the context it was accepted in
 * (its acceptance record), so a viewer opened in a round that classified an
 * organization share as direct stays open in that organization. Without a
 * record the access path decides: direct shares belong to Personal,
 * organization shares to the organization that shared them.
 */
function closeShareViewerOutside(context: WorkspaceContext): void {
  const replicas = useSharedContainerReplicasStore.getState();
  const viewer = replicas.viewer;
  if (viewer === null) {
    return;
  }
  const { state, hydrated } = useWorkspaceContextStore.getState();
  const home = sharedContainerHomeContext(
    { access: viewer.access, organizationId: viewer.organizationId },
    replicas.acceptedRecords[viewer.containerId],
    // Memberships that have not loaded are not "no memberships".
    hydrated ? state.organizations : undefined,
  );
  if (home !== null && isSameWorkspaceContext(context, home)) {
    return;
  }
  replicas.closeViewer();
}

function clearCurrentSelection(): void {
  useStandaloneChatStore.getState().cancelPendingWorkEntryNavigation();
  const chat = useChatStore.getState();
  if (chat.selectedWorktree) {
    chat.deselectWorktree();
  }
  const standalone = useStandaloneChatStore.getState();
  if (standalone.activeWorkEntryId !== null) {
    standalone.clearActiveWorkEntry();
  }
  const navigation = useNavigationStore.getState();
  if (navigation.activePage === 'chat') {
    navigation.navigate('main');
  }
}

function restoreSelectionForContext(
  nextKey: string,
  next: WorkspaceContext,
): void {
  const chat = useChatStore.getState();
  const context = useWorkspaceContextStore.getState();
  const restored = context.lastSelectionByContext[nextKey] ?? null;
  if (restored && !selectionFitsContext(restored, next)) {
    // Remembered before this guard existed, or its workspace changed owner
    // or was deleted since: forget it rather than reopen a foreign workspace.
    context.rememberSelection(nextKey, null);
    return;
  }
  if (restored) {
    const project = useProjectsStore
      .getState()
      .projects.find((item) => item.id === restored.projectId);
    if (project?.type === 'cowork') {
      pendingSelectionRestorations += 1;
      restorationListeners.forEach((listener): void => listener());
      void restoreCoworkSelection(nextKey, restored).finally((): void => {
        pendingSelectionRestorations -= 1;
        if (pendingSelectionRestorations === 0) {
          const navigation = useNavigationStore.getState();
          const request = navigation.pendingForkedContainerFocus;
          const selected = useChatStore.getState().selectedWorktree;
          // No consumer may remain mounted after a user deselects during
          // restoration. Retire that request before a later visit can focus it.
          if (
            request !== undefined &&
            (request.accountEpoch !==
              useWorkspaceContextStore.getState().accountEpoch ||
              request.page !== navigation.activePage ||
              selected?.projectId !== request.projectId ||
              selected.worktreeId !== request.worktreeId)
          )
            navigation.consumeForkedContainerFocus(request.nonce);
        }
        restorationListeners.forEach((listener): void => listener());
      });
      return;
    }
    chat.selectWorktree(restored.projectId, restored.worktreeId);
    const selected = useChatStore.getState().selectedWorktree;
    if (
      selected?.projectId === restored.projectId &&
      selected?.worktreeId === restored.worktreeId
    ) {
      useNavigationStore.getState().navigate('main');
      return;
    }
    context.rememberSelection(nextKey, null);
  }
}

/** Clear a selection hidden by newly active scoping without attributing it to a context. */
export function reconcileSelectionWithScoping(
  context: WorkspaceContext | undefined = getSidebarScopingContext(),
): void {
  if (context === undefined) {
    return;
  }
  const selected = useChatStore.getState().selectedWorktree;
  if (selected && !selectionFitsContext(selected, context)) {
    clearCurrentSelection();
    restoreSelectionForContext(serializeWorkspaceContext(context), context);
  }
  closeShareViewerOutside(context);
}

/**
 * Undo whatever a Cowork open installed for `target`, leaving any other selection alone.
 */
function releaseCoworkTarget(target: {
  projectId: string;
  worktreeId: string;
}): void {
  const chat = useChatStore.getState();
  if (
    chat.selectedWorktree?.projectId === target.projectId &&
    chat.selectedWorktree?.worktreeId === target.worktreeId
  ) {
    chat.deselectWorktree();
  }
  const standalone = useStandaloneChatStore.getState();
  if (
    standalone.activeChatProjectId === target.projectId &&
    standalone.activeWorkEntryId === target.worktreeId
  ) {
    standalone.clearActiveWorkEntry();
  }
}

async function restoreCoworkSelection(
  nextKey: string,
  restored: { projectId: string; worktreeId: string },
): Promise<void> {
  let reopened = false;
  let userNavigated = false;
  const initialPage = useNavigationStore.getState().activePage;
  const unsubscribeNavigation = useNavigationStore.subscribe((state): void => {
    if (state.activePage !== initialPage) {
      userNavigated = true;
    }
  });
  const pending: { userSelection: WorktreeSelection | null } = {
    userSelection: null,
  };
  const unsubscribe = useChatStore.subscribe((state): void => {
    const current = state.selectedWorktree;
    if (
      current &&
      (current.projectId !== restored.projectId ||
        current.worktreeId !== restored.worktreeId)
    ) {
      pending.userSelection = current;
    }
  });
  try {
    await useStandaloneChatStore
      .getState()
      .openWorkEntryFromSidebar(restored.projectId, restored.worktreeId);
    reopened = true;
  } catch {
    // A missing or unavailable task is no longer a restorable selection.
  } finally {
    unsubscribe();
    unsubscribeNavigation();
  }
  // Another context switch happened meanwhile: that switch already settled
  // the selection for its own context, so only undo what this open installed.
  const context = useWorkspaceContextStore.getState();
  if (serializeWorkspaceContext(context.state.context) !== nextKey) {
    releaseCoworkTarget(restored);
    return;
  }
  // The latest user action wins: a selection made while the open was pending
  // is put back, and a page change leaves the user where they went.
  const userSelection = pending.userSelection;
  if (userSelection) {
    releaseCoworkTarget(restored);
    if (useChatStore.getState().selectedWorktree === null) {
      useChatStore
        .getState()
        .selectWorktree(userSelection.projectId, userSelection.worktreeId);
    }
    return;
  }
  if (userNavigated) {
    releaseCoworkTarget(restored);
    return;
  }
  const selected = useChatStore.getState().selectedWorktree;
  const standalone = useStandaloneChatStore.getState();
  const entryStillExists =
    standalone.activeChatProjectId === restored.projectId &&
    standalone.workEntries.some((entry) => entry.id === restored.worktreeId);
  if (
    reopened &&
    entryStillExists &&
    selected?.projectId === restored.projectId &&
    selected?.worktreeId === restored.worktreeId
  ) {
    useNavigationStore.getState().navigate('chat');
  } else {
    releaseCoworkTarget(restored);
    context.rememberSelection(nextKey, null);
  }
}

/**
 * Subscribe once per window: every applied context change (a switch here, a
 * switch in another window, an account change, or a departure fallback) runs
 * the selection sync when sidebar scoping is active. When the flag is off or
 * hydration has not completed, the sidebar is unscoped, so the selection is
 * left alone. A transition to active scoping reconciles a hidden selection;
 * installing while already active leaves startup restoration alone.
 * Returns one closure that unsubscribes both stores.
 */
export function installWorkspaceContextSelectionSync(): () => void {
  let previous = useWorkspaceContextStore.getState().state.context;
  let previousRevision = useWorkspaceContextStore.getState().state.revision;
  let active = getSidebarScopingContext() !== undefined;
  const updateScopingActive = (): boolean => {
    const nextActive = getSidebarScopingContext() !== undefined;
    const activated = !active && nextActive;
    active = nextActive;
    return activated;
  };
  const unsubscribeContext = useWorkspaceContextStore.subscribe(
    (store): void => {
      const activated = updateScopingActive();
      const next = store.state.context;
      // Rollout refreshes project Personal without changing the saved context.
      const rolloutProjection =
        store.lastChangeReason === 'organizations' &&
        store.state.revision === previousRevision &&
        previous.kind === 'organization' &&
        next.kind === 'personal';
      if (!rolloutProjection) {
        previousRevision = store.state.revision;
        if (next !== previous) {
          const before = previous;
          previous = next;
          if (getSidebarScopingContext() !== undefined) {
            syncSelectionForContextChange(before, next);
          }
        }
      }
      if (activated) {
        reconcileSelectionWithScoping(previous);
      }
    },
  );
  const unsubscribeFlags = useFeatureFlagsStore.subscribe((): void => {
    if (updateScopingActive()) {
      reconcileSelectionWithScoping(previous);
    }
  });
  // A share accepted or opened just before a switch can mount its viewer only
  // after the switch already ran, so a viewer that appears while scoping is
  // active is checked against the active context as well.
  const unsubscribeViewer = useSharedContainerReplicasStore.subscribe(
    (state, previous): void => {
      if (state.viewer === null || state.viewer === previous.viewer) {
        return;
      }
      const context = getSidebarScopingContext();
      if (context !== undefined) {
        closeShareViewerOutside(context);
      }
    },
  );
  return (): void => {
    unsubscribeContext();
    unsubscribeFlags();
    unsubscribeViewer();
  };
}
