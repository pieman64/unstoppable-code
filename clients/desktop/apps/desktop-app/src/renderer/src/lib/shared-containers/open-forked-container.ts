/**
 * Navigation for a freshly forked container (CAN-2552, CAN-4782).
 *
 * A fork lands in ordinary user-owned storage, so getting to it is the same
 * navigation any other workspace uses. There is deliberately no fork-specific
 * viewer. The call sites (the accepted row's menu, the viewer header, and the
 * success toast's Open copy action) share this helper rather than each
 * re-deriving the code-vs-Cowork split.
 *
 * Main created the workspace, worktree, or Work Entry after the renderer's last
 * listing, and the renderer keeps two parallel lists. `projectsStore.loadProjects`
 * below feeds the sidebar rows; it does *not* feed the Cowork store's own
 * `chatProjects`, which `switchChatProject` re-lists for itself when the target
 * is missing. So one reload here is not enough on its own, and adding a second
 * one would duplicate that funnel rather than replace it.
 *
 * The copy is put in front, not just selected: the share viewer that started
 * the fork would otherwise keep covering it, and a copy owned by another
 * context would be hidden by the sidebar's scoping. The owning context comes
 * from the destination workspace's owner. A Personal workspace linked into an
 * organization is still Personal.
 */
import type {
  SharedContainerForkResponse,
  WorkspaceContext,
  WorktreeSelection,
} from '@canopy/desktop-shared/types';
import { isSameWorkspaceContext } from '@canopy/protocol/workspace-context';
import { getSidebarScopingContext } from '@/components/sidebar/useSidebarScopingContext';
import { workspaceOwnerContext } from '@/lib/automationContextScope';
import { reconcileSelectionWithScoping } from '@/lib/workspaceContextSelection';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useSharedContainerReplicasStore } from '@/stores/sharedContainerReplicasStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

export interface OpenForkedContainerResult {
  /** The context entered to reveal the copy; `null` when none was switched. */
  readonly switchedTo: WorkspaceContext | null;
}

/** One reload-and-select retry, as the restored-container navigation does. */
const MAX_ATTEMPTS = 2;

let revealGeneration = 0;
let pendingReveal: Promise<void> | undefined;
const revealGuards = new Set<RevealGuard>();

class RetryableRevealError extends Error {}

interface RevealGuard {
  /** Throws once a newer reveal, an account change, or another switch wins. */
  readonly assertCurrent: () => void;
  /** Enter `context` as this reveal's own switch, then verify it applied. */
  readonly enter: (context: WorkspaceContext) => Promise<void>;
  readonly switchedTo: () => WorkspaceContext | null;
  readonly acceptContext: (context: WorkspaceContext) => void;
  readonly acceptSelection: () => void;
}

function sameSelection(
  left: WorktreeSelection | null,
  right: WorktreeSelection | null,
): boolean {
  return (
    left?.projectId === right?.projectId &&
    left?.worktreeId === right?.worktreeId
  );
}

function createRevealGuard(): RevealGuard {
  const ticket = ++revealGeneration;
  const accountEpoch = useWorkspaceContextStore.getState().accountEpoch;
  // The context this reveal expects. Its own switch moves it; any other
  // change (a user switch, another window) makes the reveal stale.
  let expectedContext = getSidebarScopingContext();
  let expectedPage = useNavigationStore.getState().activePage;
  let expectedSelection = useChatStore.getState().selectedWorktree;
  let switchedTo: WorkspaceContext | null = null;
  const assertCurrent = (): void => {
    if (
      ticket !== revealGeneration ||
      useWorkspaceContextStore.getState().accountEpoch !== accountEpoch
    ) {
      throw new Error('A newer request replaced opening the copy.');
    }
    const context = getSidebarScopingContext();
    const unchanged =
      context === undefined || expectedContext === undefined
        ? context === expectedContext
        : isSameWorkspaceContext(context, expectedContext);
    if (!unchanged) {
      throw new Error('The workspace context changed while opening the copy.');
    }
    if (useNavigationStore.getState().activePage !== expectedPage) {
      throw new Error('Navigation changed while opening the copy.');
    }
    if (
      !sameSelection(
        useChatStore.getState().selectedWorktree,
        expectedSelection,
      )
    ) {
      throw new Error('Selection changed while opening the copy.');
    }
  };
  return {
    assertCurrent,
    enter: async (context): Promise<void> => {
      let applied = false;
      let restoring = false;
      let navigationChanged = false;
      let observedPage = expectedPage;
      let observedSelection = expectedSelection;
      // Context selection sync runs synchronously with the applied context.
      // Only that turn may change the route/selection on behalf of this reveal;
      // user navigation while the IPC reply is pending must still cancel it.
      const observeContext = (): void => {
        const current = getSidebarScopingContext();
        if (
          !applied &&
          current !== undefined &&
          isSameWorkspaceContext(current, context)
        ) {
          applied = true;
          restoring = true;
          queueMicrotask((): void => {
            restoring = false;
          });
        }
      };
      const observeNavigation = (): void => {
        observeContext();
        const page = useNavigationStore.getState().activePage;
        const selection = useChatStore.getState().selectedWorktree;
        if (
          page !== observedPage ||
          !sameSelection(selection, observedSelection)
        ) {
          if (!restoring) navigationChanged = true;
          observedPage = page;
          observedSelection = selection;
        }
      };
      const unsubscribeContext =
        useWorkspaceContextStore.subscribe(observeContext);
      const unsubscribeNavigation =
        useNavigationStore.subscribe(observeNavigation);
      const unsubscribeSelection = useChatStore.subscribe(observeNavigation);
      try {
        await useWorkspaceContextStore.getState().setContext(context);
        observeNavigation();
        const current = getSidebarScopingContext();
        if (
          current === undefined ||
          !isSameWorkspaceContext(current, context)
        ) {
          throw new Error(
            'The workspace context changed while opening the copy.',
          );
        }
        if (navigationChanged) {
          throw new Error('Navigation changed while opening the copy.');
        }
        // A queued reveal must follow this owned transition even if it has
        // superseded us. Independent changes never reach this adoption point.
        revealGuards.forEach((guard): void => guard.acceptContext(context));
      } finally {
        unsubscribeContext();
        unsubscribeNavigation();
        unsubscribeSelection();
      }
      assertCurrent();
      switchedTo = context;
    },
    switchedTo: (): WorkspaceContext | null => switchedTo,
    acceptContext: (context): void => {
      expectedContext = context;
      expectedPage = useNavigationStore.getState().activePage;
      expectedSelection = useChatStore.getState().selectedWorktree;
    },
    acceptSelection: (): void => {
      expectedSelection = useChatStore.getState().selectedWorktree;
    },
  };
}

export function openForkedContainer(
  response: SharedContainerForkResponse,
): Promise<OpenForkedContainerResult> {
  const accountEpoch = useWorkspaceContextStore.getState().accountEpoch;
  const guard = createRevealGuard();
  revealGuards.add(guard);
  const previous = pendingReveal;
  const reveal = async (): Promise<OpenForkedContainerResult> => {
    // Selection itself can await Cowork initialization. Let it settle before
    // another reveal starts, so an older completion cannot replace the winner.
    if (previous !== undefined) await previous;
    guard.assertCurrent();
    return revealCopy(response, guard, accountEpoch);
  };
  const result = reveal();
  const settled = result.then(
    (): void => {
      revealGuards.delete(guard);
    },
    (): void => {
      revealGuards.delete(guard);
    },
  );
  pendingReveal = settled;
  void settled.then((): void => {
    if (pendingReveal === settled) pendingReveal = undefined;
  });
  return result;
}

async function revealCopy(
  response: SharedContainerForkResponse,
  guard: RevealGuard,
  accountEpoch: number,
): Promise<OpenForkedContainerResult> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await revealAttempt(response, guard);
      break;
    } catch (error) {
      if (!(error instanceof RetryableRevealError) || attempt >= MAX_ATTEMPTS) {
        throw error;
      }
    }
  }

  guard.assertCurrent();
  const page = response.containerType === 'COWORK_WORK_ENTRY' ? 'chat' : 'main';
  const navigation = useNavigationStore.getState();
  navigation.navigate(page);
  if (useNavigationStore.getState().activePage !== page) {
    throw new Error('The copy could not be opened.');
  }
  useSharedContainerReplicasStore.getState().closeViewer();
  navigation.requestForkedContainerFocus({
    projectId: response.projectId,
    worktreeId: response.worktreeId,
    page,
    accountEpoch,
  });
  return { switchedTo: guard.switchedTo() };
}

/** Reload, enter the owning context, and select the copy, once. */
async function revealAttempt(
  response: SharedContainerForkResponse,
  guard: RevealGuard,
): Promise<void> {
  await useProjectsStore
    .getState()
    .loadProjects({ silent: true, requireSuccess: true })
    .catch((error: unknown) => {
      throw new RetryableRevealError(
        error instanceof Error ? error.message : String(error),
      );
    });
  guard.assertCurrent();

  const project = useProjectsStore
    .getState()
    .projects.find((item) => item.id === response.projectId);
  if (project === undefined) {
    throw new RetryableRevealError('The copy is not in the list yet.');
  }

  const refreshedContext = getSidebarScopingContext();
  if (refreshedContext !== undefined) {
    reconcileSelectionWithScoping(refreshedContext);
    revealGuards.forEach((pending): void => pending.acceptSelection());
  }

  const owningContext = workspaceOwnerContext(project);
  const currentContext = getSidebarScopingContext();
  if (
    currentContext !== undefined &&
    !isSameWorkspaceContext(currentContext, owningContext)
  ) {
    // Switch before selecting: the switch clears the selection and restores
    // the one remembered for the entered context.
    await guard.enter(owningContext);
  }

  if (response.containerType === 'COWORK_WORK_ENTRY') {
    await selectWorkEntry(response.projectId, response.worktreeId, guard);
  } else {
    selectWorktree(response.projectId, response.worktreeId);
  }
  revealGuards.forEach((pending): void => pending.acceptSelection());
  guard.assertCurrent();
}

/**
 * `selectWorktree`'s navigation guard can refuse quietly, for example when a
 * concurrent reload replaced the snapshot with one that predates the copy.
 */
function selectWorktree(projectId: string, worktreeId: string): void {
  useChatStore.getState().selectWorktree(projectId, worktreeId);
  const selected = useChatStore.getState().selectedWorktree;
  if (selected?.projectId !== projectId || selected.worktreeId !== worktreeId) {
    throw new RetryableRevealError('The copy could not be selected.');
  }
}

/**
 * Cowork Work Entries live on the 'chat' page, and the entry id occupies the
 * `worktreeId` slot. A rejected open propagates as is. A resolved open is
 * still checked, because it can short-cut or be superseded.
 */
async function selectWorkEntry(
  projectId: string,
  entryId: string,
  guard: RevealGuard,
): Promise<void> {
  // The dynamic import breaks the module cycle the chat store's own cowork
  // navigation already works around.
  const { useStandaloneChatStore } =
    await import('@/stores/standaloneChatStore');
  guard.assertCurrent();
  let observedSelection = useChatStore.getState().selectedWorktree;
  let interrupted = false;
  const target = { projectId, worktreeId: entryId };
  const initialPage = useNavigationStore.getState().activePage;
  const initialAccountEpoch = useWorkspaceContextStore.getState().accountEpoch;
  const initialContext = getSidebarScopingContext();
  let latestUserSelection = {
    selection: observedSelection,
    accountEpoch: initialAccountEpoch,
    context: initialContext,
  };
  const interrupt = (): void => {
    if (interrupted) return;
    interrupted = true;
    useStandaloneChatStore.getState().cancelPendingWorkEntryNavigation();
  };
  const unsubscribe = useChatStore.subscribe((state): void => {
    const previous = observedSelection;
    observedSelection = state.selectedWorktree;
    if (sameSelection(observedSelection, previous)) return;
    if (sameSelection(observedSelection, target)) return;
    // Cold initialization selects even after cancellation, then the open
    // clears that transient target. That cleanup is not a new user choice.
    if (
      interrupted &&
      observedSelection === null &&
      sameSelection(previous, target)
    ) {
      return;
    }
    latestUserSelection = {
      selection: observedSelection,
      accountEpoch: useWorkspaceContextStore.getState().accountEpoch,
      context: getSidebarScopingContext(),
    };
    // The Cowork helper can await project/entry refresh before selecting.
    // Cancel its request IDs now, before that late selection can commit.
    interrupt();
  });
  const unsubscribePage = useNavigationStore.subscribe((): void => {
    if (useNavigationStore.getState().activePage !== initialPage) interrupt();
  });
  const unsubscribeContext = useWorkspaceContextStore.subscribe((): void => {
    const context = getSidebarScopingContext();
    const unchanged =
      context === undefined || initialContext === undefined
        ? context === initialContext
        : isSameWorkspaceContext(context, initialContext);
    if (
      useWorkspaceContextStore.getState().accountEpoch !==
        initialAccountEpoch ||
      !unchanged
    )
      interrupt();
  });
  try {
    await useStandaloneChatStore
      .getState()
      .openWorkEntryFromSidebar(projectId, entryId);
    if (interrupted)
      throw new Error('Navigation changed while opening the copy.');
  } finally {
    unsubscribe();
    unsubscribePage();
    unsubscribeContext();
    if (interrupted) {
      const selected = useChatStore.getState().selectedWorktree;
      const context = getSidebarScopingContext();
      const sameContext =
        context === undefined || latestUserSelection.context === undefined
          ? context === latestUserSelection.context
          : isSameWorkspaceContext(context, latestUserSelection.context);
      if (
        useWorkspaceContextStore.getState().accountEpoch ===
          latestUserSelection.accountEpoch &&
        sameContext &&
        (selected === null || sameSelection(selected, target)) &&
        !sameSelection(selected, latestUserSelection.selection)
      ) {
        const destination = latestUserSelection.selection;
        if (destination === null) useChatStore.getState().deselectWorktree();
        else
          useChatStore
            .getState()
            .selectWorktree(destination.projectId, destination.worktreeId);
      }
    }
  }
  const standalone = useStandaloneChatStore.getState();
  if (
    standalone.activeChatProjectId !== projectId ||
    standalone.activeWorkEntryId !== entryId
  ) {
    throw new Error('The copy could not be opened.');
  }
}
