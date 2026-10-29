/**
 * Captures the worktree's current layout and persists it as the default
 * template for its surface (code worktrees vs cowork workspaces keep
 * independent defaults).
 */
import { usePanelLayoutStore } from '@/stores/panelLayoutStore';
import {
  templateHasChatHost,
  templatizeLayoutForDefault,
} from './default-layout-template';
import { panelSurfaceForWorktreeKey } from './panel-surface';
import { withoutEphemeralPanels } from './ephemeral-panels';
import { getWorkspaceLayoutMode } from '@/stores/workspaceLayoutModeStore';

export async function saveCurrentLayoutAsDefault(
  worktreeKey: string,
): Promise<boolean> {
  if (getWorkspaceLayoutMode(worktreeKey) !== 'advanced') {
    return false;
  }
  const file = usePanelLayoutStore.getState().serializeLayout(worktreeKey);
  if (file === null) {
    return false;
  }
  // New tabs are never written (older builds reject the kind).
  const template = templatizeLayoutForDefault(withoutEphemeralPanels(file));
  if (!templateHasChatHost(template)) {
    return false;
  }
  try {
    await window.api.panelLayout.saveDefaultLayout({
      surface: panelSurfaceForWorktreeKey(worktreeKey),
      layout: template,
    });
    return true;
  } catch {
    return false;
  }
}
