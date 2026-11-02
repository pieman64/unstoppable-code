/**
 * Maps a `${projectId}/${worktreeId}` panel worktree key to the default-layout
 * surface it belongs to. Cowork chat targets (real cowork workspace ids plus
 * the legacy standalone-chat sentinel) save/load the cowork default template;
 * everything else uses the code-worktree template.
 */
import type { PanelLayoutSurface } from '@canopy/desktop-shared/types';
import type { FilePanelPlacementPolicy } from '@canopy/ui-app/panel-layout-store';
import { isCoworkChatTarget } from '@/lib/cowork';

export function panelSurfaceForWorktreeKey(
  worktreeKey: string,
): PanelLayoutSurface {
  const separator = worktreeKey.indexOf('/');
  const projectId =
    separator === -1 ? worktreeKey : worktreeKey.slice(0, separator);
  return isCoworkChatTarget(projectId) ? 'cowork' : 'code';
}

/**
 * Where files open in a worktree's Advanced layout. Cowork keeps the
 * conversation visible and opens files in one documents group beside it;
 * Code keeps opening them among its chats. Minimal layout routes files to its
 * Side Panel before this policy applies.
 */
export function filePanelPlacementPolicyForWorktreeKey(
  worktreeKey: string,
): FilePanelPlacementPolicy {
  return panelSurfaceForWorktreeKey(worktreeKey) === 'cowork'
    ? 'documents-group'
    : 'chat-group';
}
