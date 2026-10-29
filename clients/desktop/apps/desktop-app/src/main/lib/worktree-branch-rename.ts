import { z } from 'zod';
import {
  checkW5ExpectedRevision,
  runW5BoundaryOperation,
  w5ExpectedRevision,
  w5WorktreeOutcomeSchema,
  type W5BoundaryOptions,
} from './w5-boundary-operation';
import {
  withW5Commit,
  W5RevisionConflictError,
} from './w5-commit-log-file-store';
import {
  WORKSPACE_ROOT_REPO_ID,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import { isBranchNameAvailable, renameBranch, validateBranchName } from './git';
import {
  getWorkspaceWorktreesFilePath,
  getWorkspaceWorktreeRepoDir,
} from './paths';
import { isWritableScope, READ_ONLY_SCOPE_ERROR } from './read-only-scope';
import { resolveWorktreeCwd } from './resolve-worktree';
import { validateId } from './validation';
import { WORKTREE_LIST_STORAGE, withStorageAdmission } from './w5-storage';
import { updateWorkspaceWorktree } from './workspace-persistence';
import { applyWorktreeBranchChange } from './worktree-git-observations';

/**
 * The caller of a branch rename: the desktop renderer's branch dialogs today.
 * A closed set, so the later receipt (CAN-3805) can name it.
 */
export type WorktreeBranchRenameSource = 'desktop';

export interface WorktreeBranchRenameRequest extends W5BoundaryOptions {
  source: WorktreeBranchRenameSource;
  workspaceId: string;
  worktreeId: string;
  /**
   * The member repository whose branch is renamed, or the source-backed root;
   * absent for a single-repository worktree.
   */
  repoId?: string;
  newBranchName: string;
}

export interface WorktreeBranchRenameOutcome {
  branchName: string;
  /** The persisted row after the rename. */
  worktree: WorktreeData | null;
}

export type WorktreeBranchRenameRefusal =
  | 'read-only-scope'
  | 'invalid-branch-name'
  | 'branch-unavailable'
  | 'not-found';

/**
 * The rename was refused. The name stays `Error`, so the message a renderer
 * sees is unchanged. A `not-found` refusal comes after the Git rename: the
 * branch was renamed, but the worktree has no row to record it on.
 */
export class WorktreeBranchRenameRefusedError extends Error {
  constructor(
    readonly reason: WorktreeBranchRenameRefusal,
    message: string,
  ) {
    super(message);
  }
}

function refuse(reason: WorktreeBranchRenameRefusal, message: string): never {
  throw new WorktreeBranchRenameRefusedError(reason, message);
}

function resolveRenameCheckout(request: WorktreeBranchRenameRequest): string {
  if (request.repoId && request.repoId !== WORKSPACE_ROOT_REPO_ID) {
    return getWorkspaceWorktreeRepoDir(
      request.workspaceId,
      request.worktreeId,
      request.repoId,
    );
  }
  return resolveWorktreeCwd(request.workspaceId, request.worktreeId);
}

/**
 * `core.worktree.branch.rename` (CAN-3820), the typed in-process command
 * behind `worktree:rename-branch`. Admission (ids, the read-only
 * shared-container scope, the repository id) runs before any Git work; the
 * branch name is checked and the checkout's branch renamed through the
 * existing Git helpers, unchanged; then the row is recorded under the
 * worktree list lock in one write: a root or single-repository rename
 * stores the sidebar `branchName`, and any rename clears the PR status, which
 * belonged to the old name. Optional keyed attempts reserve before Git and
 * save only the final outcome; repository locks cover metadata publication.
 */
export async function renameWorktreeBranch(
  request: WorktreeBranchRenameRequest,
): Promise<WorktreeBranchRenameOutcome> {
  return withStorageAdmission([WORKTREE_LIST_STORAGE], async () => {
    const { workspaceId, worktreeId, repoId, newBranchName } = request;
    validateId(workspaceId, 'workspaceId');
    if (!isWritableScope(workspaceId)) {
      refuse('read-only-scope', READ_ONLY_SCOPE_ERROR);
    }
    validateId(worktreeId, 'worktreeId');
    if (repoId !== undefined && repoId !== WORKSPACE_ROOT_REPO_ID) {
      validateId(repoId, 'repoId');
    }

    const { expectedRevision, idempotencyKey, ...parameters } = request;
    return runW5BoundaryOperation(
      {
        operation: 'core.worktree.branch.rename',
        caller: `desktop-host:${request.source}`,
        idempotencyKey,
        parameters,
        isPreEffectRefusal: (error) =>
          error instanceof WorktreeBranchRenameRefusedError ||
          error instanceof W5RevisionConflictError,
      },
      (outcome) =>
        z
          .object({
            branchName: z.string(),
            worktree: w5WorktreeOutcomeSchema.nullable(),
          })
          .parse(outcome),
      async (options, attempt) => {
        await checkW5ExpectedRevision(
          { kind: 'worktree', workspaceId, worktreeId },
          expectedRevision,
        );
        const checkout = resolveRenameCheckout(request);
        if (!(await validateBranchName(checkout, newBranchName))) {
          refuse(
            'invalid-branch-name',
            `Invalid branch name: "${newBranchName}"`,
          );
        }
        if (!(await isBranchNameAvailable(checkout, newBranchName))) {
          refuse(
            'branch-unavailable',
            `Branch name "${newBranchName}" is already in use`,
          );
        }
        attempt?.beforeEffects();
        await renameBranch(checkout, newBranchName);
        async function stageRenamedWorktree(): Promise<WorktreeBranchRenameOutcome> {
          const updatesSidebarBranch =
            repoId === undefined || repoId === WORKSPACE_ROOT_REPO_ID;
          const recorded: { worktree: WorktreeData | null } = {
            worktree: null,
          };
          const found = await updateWorkspaceWorktree(
            workspaceId,
            worktreeId,
            (current) => {
              const next = applyWorktreeBranchChange(
                current,
                newBranchName,
                updatesSidebarBranch,
              );
              recorded.worktree = next;
              return next;
            },
          );
          if (!found) {
            refuse(
              'not-found',
              `Worktree metadata not found for ${workspaceId}/${worktreeId}`,
            );
          }
          return { branchName: newBranchName, worktree: recorded.worktree };
        }
        return withW5Commit(
          {
            ...options,
            locks: [
              {
                kind: 'list',
                path: getWorkspaceWorktreesFilePath(workspaceId),
              },
            ],
            expectedRevisions: w5ExpectedRevision(
              { kind: 'worktree', workspaceId, worktreeId },
              expectedRevision,
            ),
          },
          stageRenamedWorktree,
        );
      },
    );
  });
}
