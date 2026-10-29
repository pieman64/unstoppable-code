import { randomUUID } from 'node:crypto';
import {
  WORKSPACE_ROOT_REPO_ID,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import type { WorktreeReplicaState } from '@canopy/desktop-shared/worktree-replica';
import {
  observeReplicaBranch,
  parseWorktreeReplica,
} from './worktree-replica-codec';

/** Trusted host identities and repository membership; never repository paths. */
export interface LocalReplicaContext {
  authorityId: string;
  targetId: string;
  repoIds: readonly string[];
}

/** Mint once on the existing list write; no Git observation or revision is implied. */
export function recordLocalWorktreeReplica(
  workspaceId: string,
  worktree: WorktreeData,
  context: LocalReplicaContext,
): WorktreeReplicaState {
  const included = worktree.includedRepoIds;
  const repoIds = [
    WORKSPACE_ROOT_REPO_ID,
    ...context.repoIds.filter(
      (repoId) =>
        repoId !== WORKSPACE_ROOT_REPO_ID &&
        (included === undefined || included.includes(repoId)),
    ),
  ];
  const replica: WorktreeReplicaState = {
    state: 'recorded',
    primarySnapshotRevision: { state: 'unknown' },
    repositories: Array.from(new Set(repoIds)).map((repoId) => ({
      authorityId: context.authorityId,
      workspaceId,
      worktreeId: worktree.id,
      repoId,
      targetId: {
        primaryAuthorityId: context.authorityId,
        targetId: context.targetId,
      },
      replicaId: randomUUID(),
      remoteIdentity: { state: 'unknown' },
      // Only the root branch is established by this list row. A child checkout
      // can use another branch; do not infer it from the logical worktree name.
      branchName:
        repoId === WORKSPACE_ROOT_REPO_ID &&
        !worktree.restoredFromFilesOnlyArchiveId
          ? observeReplicaBranch(worktree.branchName)
          : { state: 'unknown' },
      baseOid: { state: 'unknown' },
      localHeadOid: { state: 'unknown' },
      observedRemoteHeadOid: { state: 'unknown' },
      expectedRemoteHeadOid: { state: 'unknown' },
      syncMode: { state: 'unconfigured' },
      syncState: 'not-yet-observed',
    })),
  };
  // Legacy identity strings that cannot be admitted are kept unrecorded,
  // rather than inventing replacements or changing existing local behavior.
  return parseWorktreeReplica(replica, workspaceId, worktree.id).state ===
    'recorded'
    ? replica
    : { state: 'never-recorded' };
}
