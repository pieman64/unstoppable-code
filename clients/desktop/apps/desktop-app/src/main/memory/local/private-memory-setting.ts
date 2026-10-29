import type { SidebarItem } from '@canopy/desktop-shared/types';
import { readAllSidebarItems } from '../../lib/sidebar-items';
import { updateWorkspacePrivateMemory } from '../../lib/workspace-private-memory';
import { resolveMemoryWorkspaceId } from './workspace-scope';
import { validateId } from '../../lib/validation';

/**
 * `workspace:set-private-memory`: resolves the memory workspace (a legacy
 * caller may name the standalone chat sentinel) and changes its local choice
 * through the typed `core.workspace.privateMemory.update` boundary.
 */
export async function setWorkspacePrivateMemory(input: {
  projectId: string;
  worktreeId: string;
  privateMemory: boolean;
}): Promise<SidebarItem> {
  const workspaceId = await resolveMemoryWorkspaceId(input);
  if (workspaceId) validateId(workspaceId, 'workspaceId');
  if (!workspaceId) throw new Error('Project was not found');
  await updateWorkspacePrivateMemory({
    workspaceId,
    privateMemory: input.privateMemory,
    source: 'workspace_settings',
  });
  const item = (await readAllSidebarItems()).items.find(
    (row) => row.id === workspaceId,
  );
  if (!item) throw new Error('Project was not found');
  return item;
}
