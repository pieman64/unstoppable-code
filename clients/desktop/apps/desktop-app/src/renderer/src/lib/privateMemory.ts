import { useProjectsStore } from '@/stores/projectsStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { extractIpcErrorMessage } from '@/lib/errors';

/**
 * Reload every row that projects a project's Private memory value: the
 * sidebar items, and the Cowork project list its settings dialog reads.
 */
export async function refreshPrivateMemoryRows(): Promise<void> {
  await Promise.all([
    useProjectsStore.getState().loadProjects({ silent: true }),
    useStandaloneChatStore.getState().loadChatProjects(),
  ]);
}

/**
 * The renderer's one write path for Private memory (CAN-3562). Main validates
 * the project and refuses an organization-managed one, so a refusal reloads
 * the rows before it is reported: the caller then renders the authoritative
 * value and its managed marker instead of a draft main never accepted.
 */
export async function saveWorkspacePrivateMemory(
  workspaceId: string,
  privateMemory: boolean,
): Promise<void> {
  try {
    await window.api.setWorkspacePrivateMemory({ workspaceId, privateMemory });
  } catch (cause) {
    await refreshPrivateMemoryRows().catch((): undefined => undefined);
    throw new Error(extractIpcErrorMessage(cause));
  }
  // The value is saved; a failed reload only leaves a stale row behind.
  await refreshPrivateMemoryRows().catch((): undefined => undefined);
}
