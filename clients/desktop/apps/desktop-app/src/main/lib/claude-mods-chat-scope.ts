import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import {
  parseClaudeModsGetArgs,
  type ClaudeModsChatContext,
} from '@canopy/protocol/claude-mods';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import { findClaudeProjectGitRoot } from '@canopy/execution-engine/node/plugins/claude-mod-admission';
import { resolveWorktreeCwd } from './resolve-worktree';
import {
  validateOptionalRepoId,
  validateWorktreeChatScope,
} from './validation';
import { listWorkspaceWorktreeRepoEntries } from './worktree-repo-entries';

/**
 * Resolve the folders a chat's Claude launches read project settings from:
 * the folder `resolveWorktreeCwd` gives the chat's launches, and its Git root,
 * as launch admission does. `chatId` is correlation only; this never opens
 * chat storage. Callers supply ids only; a repository must belong to the
 * worktree. Null when the context does not resolve to an existing folder.
 */
export async function resolveClaudeModsChatScope(
  context: ClaudeModsChatContext,
): Promise<readonly string[] | null> {
  const parsedContext = parseClaudeModsGetArgs({ context })?.context;
  if (!parsedContext) return null;

  try {
    const { projectId, worktreeId, repoId } = parsedContext;
    validateWorktreeChatScope(projectId, worktreeId);
    validateOptionalRepoId(repoId, 'repoId');

    if (repoId !== undefined && repoId !== WORKSPACE_ROOT_REPO_ID) {
      // Only a repository of this worktree, never a caller-chosen folder.
      const entries = await listWorkspaceWorktreeRepoEntries(
        projectId,
        resolveWorktreeCwd(projectId, worktreeId),
      );
      if (!entries.some((entry) => entry.repoId === repoId)) return null;
    }

    const cwd = resolveWorktreeCwd(projectId, worktreeId, repoId);
    if (!path.isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) return null;

    const gitRoot = findClaudeProjectGitRoot(cwd);
    return gitRoot && gitRoot !== path.resolve(cwd) ? [cwd, gitRoot] : [cwd];
  } catch {
    return null;
  }
}
