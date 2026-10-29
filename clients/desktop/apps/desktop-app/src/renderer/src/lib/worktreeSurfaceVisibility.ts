import { useChatStore } from '@/stores/chatStore';
import {
  type NavigationPage,
  useNavigationStore,
} from '@/stores/navigationStore';

interface WorktreeSurfaceContext {
  activePage: NavigationPage;
  settingsOpen: boolean;
  selectedProjectId: string | undefined;
  selectedWorktreeId: string | undefined;
}

function isVisibleInContext(
  context: WorktreeSurfaceContext,
  projectId: string,
  worktreeId: string,
): boolean {
  return (
    (context.activePage === 'main' || context.activePage === 'kanban') &&
    !context.settingsOpen &&
    context.selectedProjectId === projectId &&
    context.selectedWorktreeId === worktreeId
  );
}

/**
 * Whether the worktree is the selected one and its surface is on screen: the
 * main or kanban page is showing and Settings is closed. Worktree-scoped
 * prompts check this so they never open over another worktree or page.
 */
export function isWorktreeSurfaceVisible(
  projectId: string,
  worktreeId: string,
): boolean {
  const { activePage, settingsOpen } = useNavigationStore.getState();
  const selectedWorktree = useChatStore.getState().selectedWorktree;
  return isVisibleInContext(
    {
      activePage,
      settingsOpen,
      selectedProjectId: selectedWorktree?.projectId,
      selectedWorktreeId: selectedWorktree?.worktreeId,
    },
    projectId,
    worktreeId,
  );
}

/** Reactive {@link isWorktreeSurfaceVisible}; false when no worktree is given. */
export function useIsWorktreeSurfaceVisible(
  target: { projectId: string; worktreeId: string } | null,
): boolean {
  const activePage = useNavigationStore((state) => state.activePage);
  const settingsOpen = useNavigationStore((state) => state.settingsOpen);
  const selectedProjectId = useChatStore(
    (state) => state.selectedWorktree?.projectId,
  );
  const selectedWorktreeId = useChatStore(
    (state) => state.selectedWorktree?.worktreeId,
  );
  if (!target) return false;
  return isVisibleInContext(
    { activePage, settingsOpen, selectedProjectId, selectedWorktreeId },
    target.projectId,
    target.worktreeId,
  );
}
