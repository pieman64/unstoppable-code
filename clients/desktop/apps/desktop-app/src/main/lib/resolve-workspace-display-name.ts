import type { WorkspaceType } from '@canopy/desktop-shared/types';
import { readWorkspaceIndexEntry } from './sidebar-items';

export interface WorkspaceRecordingSnapshot {
  /** Display name; '' when unresolvable (callers refresh at read time). */
  name: string;
  /**
   * Workspace kind captured at record time. Undefined when the index entry is
   * unavailable. Persisted so the resume modal can decide cowork-flat vs.
   * worktree-nested rendering even if the live index lookup later misses.
   */
  type?: WorkspaceType;
}

/**
 * Best-effort workspace name + kind for account-change recovery registry
 * snapshots. Never throws — returns an empty name (and no type) on failure.
 */
export async function resolveWorkspaceRecordingSnapshot(
  workspaceId: string,
): Promise<WorkspaceRecordingSnapshot> {
  try {
    const entry = await readWorkspaceIndexEntry(workspaceId);
    return {
      name: entry?.name ?? '',
      ...(entry?.type ? { type: entry.type } : {}),
    };
  } catch {
    return { name: '' };
  }
}
