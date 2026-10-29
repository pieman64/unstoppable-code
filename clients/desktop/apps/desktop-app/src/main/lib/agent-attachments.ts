/**
 * Shared resolver for the attachments directory agents and chat surfaces
 * read/write for a given chat target. One rule everywhere:
 *
 * - Code workspaces (single-repo / multi-repo): the existing per-worktree
 *   attachments dir `workspaces/{workspaceId}/attachments/{worktreeId}`.
 * - Work Entry workspaces: the brand-managed attachments subdir under the
 *   shared workspace folder (`.{brand}/attachments`) — the same place chat
 *   uploads land (`worktree-chat-turn.ts`) and the Attachments card lists.
 *   App Advisor uses its app-managed home; cowork uses its resolved root.
 *
 * Used by the workspace-items IPC adapter, browser screenshot/recording
 * saves, and any future agent-facing attachment writes, so saved artifacts
 * always land where the UI actually looks.
 */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { getCoworkManagedSubdir } from '@canopy/desktop-shared/node/lib/cowork-managed-dir';
import {
  getAppAdvisorHomeDir,
  getCoworkWorkspaceRootDir,
  getWorktreeAttachmentsDir,
} from './paths';
import { resolveCoworkWorkspaceId } from './cowork-migration-map';
import {
  APP_ADVISOR_PROJECT_ID,
  type WorkspaceAttachmentItem,
} from '@canopy/desktop-shared/types';
import { isCoworkWorkspace } from './workspace-registry';

export function resolveAgentAttachmentsDir(
  projectId: string,
  worktreeId: string,
): string {
  if (projectId === APP_ADVISOR_PROJECT_ID) {
    return getCoworkManagedSubdir(getAppAdvisorHomeDir(), 'attachments');
  }
  if (isCoworkWorkspace(projectId)) {
    return getCoworkManagedSubdir(
      getCoworkWorkspaceRootDir(resolveCoworkWorkspaceId(projectId)),
      'attachments',
    );
  }
  return getWorktreeAttachmentsDir(projectId, worktreeId);
}

/**
 * Lists plain attachment files in a directory (dotfiles excluded), newest
 * first. Missing directories and unreadable entries degrade to empty/skipped.
 * Shared by the workspace-items adapter and the archived-container viewer.
 */
export async function listAttachmentsInDir(
  dir: string,
): Promise<WorkspaceAttachmentItem[]> {
  let names: string[];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    names = entries
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const items = await Promise.all(
    names.map(async (name): Promise<WorkspaceAttachmentItem | null> => {
      const absolutePath = join(dir, name);
      try {
        const info = await stat(absolutePath);
        return {
          filename: name,
          absolutePath,
          sizeBytes: info.size,
          createdAt: info.birthtime.toISOString(),
        };
      } catch {
        return null;
      }
    }),
  );
  return items
    .filter((item): item is WorkspaceAttachmentItem => item !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
