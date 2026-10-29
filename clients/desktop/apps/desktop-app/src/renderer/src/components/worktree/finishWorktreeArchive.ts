import {
  makeWorktreePanelKey,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
import { usePanelWindowsStore } from '@/stores/panelWindowsStore';
import { releasePipelinePanelUiForOwner } from '@/stores/pipelinePanelUiStore';

export interface FinishWorktreeArchiveInput {
  readonly projectId: string;
  readonly worktreeId: string;
  /**
   * The worktree was a merged (done) multi-repo worktree, read before the
   * archive removed it: its project's reference repositories need a refresh.
   */
  readonly refreshReferenceRepos: boolean;
}

/**
 * Renderer cleanup after a worktree archive or delete succeeded. Single-row
 * removal, its force-delete retry, and bulk removal all run it, so a removed
 * worktree never leaves panels or pipeline UI behind.
 */
export function finishWorktreeArchive({
  projectId,
  worktreeId,
  refreshReferenceRepos,
}: FinishWorktreeArchiveInput): void {
  // The worktree is gone; drop its panel layout (layouts otherwise survive
  // worktree switches on purpose — see WorktreePart).
  const worktreePanelKey = makeWorktreePanelKey(projectId, worktreeId);
  usePanelWindowsStore.getState().disposeWorktreeAuxWindows(worktreePanelKey);
  usePanelLayoutStore.getState().disposeLayout(worktreePanelKey);
  releasePipelinePanelUiForOwner(worktreePanelKey);

  if (refreshReferenceRepos) {
    void window.api.requestWorkspaceReferenceRepoRefresh({
      workspaceId: projectId,
    });
  }
}
