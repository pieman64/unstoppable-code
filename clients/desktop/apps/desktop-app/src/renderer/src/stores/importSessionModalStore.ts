import { create } from 'zustand';
import { useChatStore } from './chatStore';
import { useProjectsStore } from './projectsStore';

export interface ImportSessionModalTarget {
  workspaceId: string;
}

interface ImportSessionModalStore {
  target: ImportSessionModalTarget | null;
  open: (target: ImportSessionModalTarget) => void;
  close: () => void;
}

export const useImportSessionModalStore = create<ImportSessionModalStore>(
  (set) => ({
    target: null,
    open: (target): void => set({ target }),
    close: (): void => set({ target: null }),
  }),
);

/**
 * Open session import for an explicit workspace, or for the currently
 * selected workspace when no id is supplied.
 */
export function openImportSessionModal(workspaceId?: string): boolean {
  const selectedWorkspaceId =
    workspaceId ?? useChatStore.getState().selectedWorktree?.projectId;
  const workspace = useProjectsStore
    .getState()
    .projects.find((candidate) => candidate.id === selectedWorkspaceId);
  if (!workspace) {
    return false;
  }

  useImportSessionModalStore.getState().open({
    workspaceId: workspace.id,
  });
  return true;
}
