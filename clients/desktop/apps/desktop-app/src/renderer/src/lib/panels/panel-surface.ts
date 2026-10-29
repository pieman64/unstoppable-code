/**
 * Maps a `${projectId}/${worktreeId}` panel worktree key to the default-layout
 * surface it belongs to. Cowork chat targets (real cowork workspace ids plus
 * the legacy standalone-chat sentinel) save/load the cowork default template;
 * everything else uses the code-worktree template.
 */
import type { PanelLayoutSurface } from '@canopy/desktop-shared/types';
import { isCoworkChatTarget } from '@/lib/cowork';

export function panelSurfaceForWorktreeKey(
  worktreeKey: string,
): PanelLayoutSurface {
  const separator = worktreeKey.indexOf('/');
  const projectId =
    separator === -1 ? worktreeKey : worktreeKey.slice(0, separator);
  return isCoworkChatTarget(projectId) ? 'cowork' : 'code';
}
