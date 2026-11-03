import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  createWorkspaceRepositoryCommands,
  type WorkspaceRepositoryAddRequest,
  type WorkspaceRepositoryCommandHost,
  type WorkspaceRepositoryCommands,
  type WorkspaceRepositoryCommandSource,
  type WorkspaceRepositoryRemoveRequest,
} from '@canopy/core-runtime/node/w5/workspace-metadata/repositories';
import type { W5WorkspaceCommandHost } from '@canopy/core-runtime/node/w5/workspace-metadata/ports';
import type { WorkspaceRepoData } from '@canopy/desktop-shared/types';
import { notifyScriptActionsRepositoryAdd } from '../services/script-actions-lifecycle';
import { isGitRepo } from './git';
import { getWorkspaceWorktreesRootDir } from './paths';
import { afterW5Commit, type W5CommitOptions } from './w5-commit-scope';
import {
  DESKTOP_W5_WORKSPACE_COMMAND_STORAGE,
  desktopW5WorkspaceCommandHost,
  desktopW5WorkspaceManifestEditor,
} from './w5-workspace-command-host';

export {
  WorkspaceRepositoryRefusedError,
  type WorkspaceRepositoryAddRequest,
  type WorkspaceRepositoryCandidate,
  type WorkspaceRepositoryRefusal,
  type WorkspaceRepositoryRemoveRequest,
  type WorkspaceRepositorySource,
} from '@canopy/core-runtime/node/w5/workspace-metadata/repositories';

export interface WorkspaceRepositoryRemoveOutcome {
  /** The removed repository, or `null` when the workspace did not have it. */
  removed: WorkspaceRepoData | null;
}

const repositoryOutcomeSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    repoPath: z.string(),
    source: z.enum(['local', 'manifest']).optional(),
    manifestUrl: z.string().optional(),
    scriptActionsOperationId: z.string().optional(),
  })
  .passthrough();
const removeOutcomeSchema = z.object({
  removed: repositoryOutcomeSchema.nullable(),
});

/**
 * Repository folders of this workspace's worktree checkouts, so a new id
 * never names an existing checkout.
 */
async function checkoutRepoIds(workspaceId: string): Promise<string[]> {
  const taken: string[] = [];
  const worktreesRoot = getWorkspaceWorktreesRootDir(workspaceId);
  try {
    const worktreeDirs = await readdir(worktreesRoot, { withFileTypes: true });
    for (const worktree of worktreeDirs.filter((entry) =>
      entry.isDirectory(),
    )) {
      const repoDirs = await readdir(
        join(worktreesRoot, worktree.name, 'repos'),
        {
          withFileTypes: true,
        },
      ).catch(() => []);
      for (const entry of repoDirs) {
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          taken.push(entry.name);
        }
      }
    }
  } catch {
    // The worktrees directory may not exist yet.
  }
  return taken;
}

/**
 * The desktop's repository commands, under `host`'s decisions and receipts;
 * `admitManifestRead` checks the read inside the manifest write queue.
 */
export function createDesktopWorkspaceRepositoryCommands(
  host: W5WorkspaceCommandHost<WorkspaceRepositoryCommandSource>,
  admitManifestRead?: WorkspaceRepositoryCommandHost['admitManifestRead'],
): WorkspaceRepositoryCommands {
  return createWorkspaceRepositoryCommands({
    ...host,
    ...(admitManifestRead && { admitManifestRead }),
    manifest: desktopW5WorkspaceManifestEditor,
    storage: DESKTOP_W5_WORKSPACE_COMMAND_STORAGE,
    isRepository: (repoPath) => isGitRepo(repoPath),
    checkoutRepoIds,
    afterAdd: async (workspaceId, repository) => {
      const scriptActionsOperationId = randomUUID();
      await afterW5Commit(() => {
        notifyScriptActionsRepositoryAdd(
          workspaceId,
          [repository.id],
          scriptActionsOperationId,
        );
      });
      return { ...repository, scriptActionsOperationId };
    },
    addOutcome: repositoryOutcomeSchema,
    removeOutcome: removeOutcomeSchema,
  });
}

let commands: WorkspaceRepositoryCommands | undefined;

function workspaceRepositoryCommands(): WorkspaceRepositoryCommands {
  commands ??= createDesktopWorkspaceRepositoryCommands(
    desktopW5WorkspaceCommandHost<WorkspaceRepositoryCommandSource>(),
  );
  return commands;
}

/**
 * The typed in-process `core.workspace.repository.add` boundary (CAN-3819):
 * adds a Git repository to a multi-repo workspace, from the renderer's
 * project settings (`workspace:add-repo`), a temporary combine, a
 * shared-container fork, or the organization multi-repo sync putting back a
 * repository it could not remove. The core-runtime command decides it.
 * Source control is not changed here: a repository enters `canopy.json`
 * through `core.workspace.sourceChanges.apply`. Parent compositions carry
 * their own retry identity; `workspace:add-repo` reaches it through the
 * registered operation (W7a).
 */
export async function addWorkspaceRepository(
  request: WorkspaceRepositoryAddRequest,
  commit?: W5CommitOptions,
): Promise<WorkspaceRepoData & { scriptActionsOperationId?: string }> {
  return workspaceRepositoryCommands().add(request, commit);
}

/**
 * The typed in-process `core.workspace.repository.remove` boundary
 * (CAN-3819): removes one repository from a workspace's configuration, from
 * the renderer's project settings (`workspace:remove-repo`) or the
 * organization multi-repo sync undoing an add it could not sync. Worktree
 * checkouts are left for the user to clean up, as before.
 */
export async function removeWorkspaceRepository(
  request: WorkspaceRepositoryRemoveRequest,
  commit?: W5CommitOptions,
): Promise<WorkspaceRepositoryRemoveOutcome> {
  return workspaceRepositoryCommands().remove(request, commit);
}
