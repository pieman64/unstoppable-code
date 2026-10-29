import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import type { WorktreePrStatus } from '@canopy/desktop-shared/types/github';
import { IdentifierValidationError, validateId } from './validation';
import {
  applyWorktreeListDecision,
  applyWorktreeRowDecision,
} from './worktree-record-decision-port';
import type {
  WorktreeBaseRetargetOutcome,
  WorktreeGitRowDecision,
  WorktreeMergedBaseRetargetDecision,
} from './worktree-record-decisions';
import {
  WorktreeRecordRefusedError,
  type WorktreeRecordOutcome,
} from './worktree-repair';

export {
  applyWorktreeBranchChange,
  areEquivalentPrStatuses,
} from './worktree-record-decision-apply';
export type { WorktreeBaseRetargetOutcome } from './worktree-record-decisions';

/**
 * `internal.worktree.git.observe` (CAN-3820): what the desktop's Git and
 * pull-request observers persist on worktree rows. It is a host command, not
 * a wire operation (CAN-3799 D9): it takes no client revision and makes no
 * idempotency guarantee. Each observation changes only the fields it owns,
 * under the per-workspace worktree list lock, so a concurrent create, update,
 * archive or other observation keeps its rows and fields. A worktree that is
 * not in the list, or whose list is missing or unreadable, is never written:
 * the list is not created or replaced, and an archived row is not brought
 * back. The Git and GitHub reads behind each observation stay with its
 * observer; this command only persists their result.
 *
 * The observations, each owned by one observer (a closed set):
 *
 * - `branch`: the HEAD watcher saw a checkout change branch. A root or
 *   single-repository change stores the sidebar `branchName`; any change
 *   clears the PR status, which belonged to the old branch.
 * - `pr-status`: the GitHub poller's PR status. An equivalent status (same
 *   repositories, newer check time) is not rewritten. Every known PR merged
 *   marks the worktree `done`; an open or draft PR clears that.
 * - `split-child-grouping`: the PR splitter groups a child worktree it created.
 * - `split-original-retarget`: the PR splitter moved the original worktree to
 *   its integration branch and base.
 * - `merged-base-retarget`: a PR merged, so every worktree of one workspace
 *   whose base tracked the merged branch now tracks the branch it merged into.
 */
export type WorktreeRowGitObservation = WorktreeRowTarget &
  (
    | {
        kind: 'branch';
        /** The repository whose checkout changed; absent for single-repo. */
        repoId?: string;
        branchName: string;
      }
    | { kind: 'pr-status'; status: WorktreePrStatus | null }
    | { kind: 'split-child-grouping' }
    | {
        kind: 'split-original-retarget';
        branchName: string;
        trackedBaseBranch: string;
      }
  );

export interface WorktreeBaseRetargetObservation {
  kind: 'merged-base-retarget';
  workspaceId: string;
  /**
   * The repositories of this workspace that track the merged PR's
   * repository: `null` for a single-repository workspace's scalar base, or a
   * repository id (including the source-backed root) for a per-repository
   * base.
   */
  repoIds: ReadonlyArray<string | null>;
  mergedBranchName: string;
  mergedIntoBranchName: string;
  /**
   * The merged worktree, when it is in this workspace: it is not retargeted
   * itself, and each worktree retargeted here is grouped under it.
   */
  mergedWorktreeId?: string;
}

export type WorktreeGitObservation =
  | WorktreeRowGitObservation
  | WorktreeBaseRetargetObservation;

interface WorktreeRowTarget {
  workspaceId: string;
  worktreeId: string;
}

function refuseInvalid(message: string): never {
  throw new WorktreeRecordRefusedError('invalid-request', message);
}

function admitId(value: unknown, label: string): void {
  try {
    validateId(value, label);
  } catch (error) {
    if (error instanceof IdentifierValidationError) {
      refuseInvalid(error.message);
    }
    throw error;
  }
}

function admitRepoId(value: unknown, label: string): void {
  // Source-backed workspaces address the workspace root through the synthetic
  // root repository id, which is not a plain slug.
  if (value !== WORKSPACE_ROOT_REPO_ID) admitId(value, label);
}

function admitBranchName(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    refuseInvalid(`A Git observation needs a ${label}`);
  }
  return value.trim();
}

function isPrStatus(value: unknown): value is WorktreePrStatus | null {
  if (value === null) return true;
  return (
    typeof value === 'object' && 'repos' in value && Array.isArray(value.repos)
  );
}

/**
 * Records one Git or pull-request observation. A row observation reports
 * `recorded`, `unchanged` (the row already held it; nothing was written) or
 * `not-found`; a merged-PR retarget reports the bases it moved.
 */
export async function observeWorktreeGit(
  observation: WorktreeRowGitObservation,
): Promise<WorktreeRecordOutcome>;
export async function observeWorktreeGit(
  observation: WorktreeBaseRetargetObservation,
): Promise<WorktreeBaseRetargetOutcome>;
export async function observeWorktreeGit(
  observation: WorktreeGitObservation,
): Promise<WorktreeRecordOutcome | WorktreeBaseRetargetOutcome> {
  if (observation.kind === 'merged-base-retarget') {
    return applyWorktreeListDecision(
      observation.workspaceId,
      admitBaseRetarget(observation),
    );
  }
  admitId(observation.workspaceId, 'workspaceId');
  admitId(observation.worktreeId, 'worktreeId');
  return applyWorktreeRowDecision(
    {
      workspaceId: observation.workspaceId,
      worktreeId: observation.worktreeId,
    },
    rowDecision(observation),
  );
}

function rowDecision(
  observation: WorktreeRowGitObservation,
): WorktreeGitRowDecision {
  switch (observation.kind) {
    case 'branch': {
      const branchName = admitBranchName(observation.branchName, 'branch name');
      if (observation.repoId !== undefined) {
        admitRepoId(observation.repoId, 'repoId');
      }
      return {
        kind: 'git.branch',
        branchName,
        updatesSidebarBranch:
          !observation.repoId || observation.repoId === WORKSPACE_ROOT_REPO_ID,
      };
    }
    case 'pr-status': {
      const { status } = observation;
      if (!isPrStatus(status)) refuseInvalid('Invalid pull request status');
      return { kind: 'git.pr-status', status };
    }
    case 'split-child-grouping':
      return { kind: 'git.split-child-grouping' };
    case 'split-original-retarget':
      return {
        kind: 'git.split-original-retarget',
        branchName: admitBranchName(observation.branchName, 'branch name'),
        trackedBaseBranch: admitBranchName(
          observation.trackedBaseBranch,
          'base branch',
        ),
      };
    default:
      return refuseInvalid('Unknown Git observation');
  }
}

function admitBaseRetarget(
  observation: WorktreeBaseRetargetObservation,
): WorktreeMergedBaseRetargetDecision {
  const { workspaceId, mergedWorktreeId } = observation;
  admitId(workspaceId, 'workspaceId');
  if (mergedWorktreeId !== undefined) {
    admitId(mergedWorktreeId, 'mergedWorktreeId');
  }
  const repoIds = observation.repoIds.map((repoId, index) => {
    if (repoId !== null) admitRepoId(repoId, `repoIds[${index}]`);
    return repoId;
  });
  const mergedBranchName = admitBranchName(
    observation.mergedBranchName,
    'merged branch name',
  );
  const mergedIntoBranchName = admitBranchName(
    observation.mergedIntoBranchName,
    'merged-into branch name',
  );
  return {
    kind: 'git.merged-base-retarget',
    repoIds,
    mergedBranchName,
    mergedIntoBranchName,
    ...(mergedWorktreeId !== undefined ? { mergedWorktreeId } : {}),
  };
}
