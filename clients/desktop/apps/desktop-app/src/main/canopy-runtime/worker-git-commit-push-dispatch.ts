import { randomUUID } from 'node:crypto';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { WORKER_GIT_GRANTS } from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  commitWithMessage,
  stageAllChanges,
  getHeadCommitSha,
  getCurrentBranch,
} from '../lib/git';
import { pushBranchWithAuthFailure } from '../lib/github-push';
import { syncScope, type GitSyncRepository } from './worker-git-sync-dispatch';
import {
  commitForLegacyIpc,
  desktopTrackingHead,
  type WorkerGitCommitPushDispatcher,
  type GitCommitPhases,
} from './worker-git-commit-push-adapter';

function hostError(error: unknown): unknown {
  return error instanceof CanopyOperationError &&
    error.runtimeCause !== undefined
    ? error.runtimeCause
    : error;
}
function options(caller: CanopyCallerDescriptor): {
  caller: CanopyCallerDescriptor;
  metadata: { idempotencyKey: string };
} {
  return {
    caller: { ...caller, grants: [WORKER_GIT_GRANTS.write] },
    metadata: { idempotencyKey: randomUUID() },
  };
}
type Request = { readonly projectId: string; readonly worktreeId: string };

/** Unrepresentable legacy inputs retain their exact commands until CAN-4731. */
export async function commitWorktreeRepository(
  dispatcher: WorkerGitCommitPushDispatcher,
  caller: CanopyCallerDescriptor,
  request: Request,
  entry: GitSyncRepository,
  message: string,
  phases?: GitCommitPhases,
): Promise<string> {
  const scope = syncScope(request, entry);
  const expectedHeadSha = await getHeadCommitSha(entry.repoPath);
  if (scope === null || expectedHeadSha === null || message.length > 100_000) {
    const stage = (): Promise<void> => stageAllChanges(entry.repoPath);
    const commit = (): Promise<string> =>
      commitWithMessage(entry.repoPath, message);
    await (phases ? phases.stage(stage) : stage());
    return phases ? phases.commit(commit) : commit();
  }
  try {
    return await commitForLegacyIpc(
      dispatcher,
      { scope, message, expectedHeadSha },
      options(caller),
      phases,
    );
  } catch (error) {
    throw hostError(error);
  }
}

export async function pushWorktreeRepository(
  dispatcher: WorkerGitCommitPushDispatcher,
  caller: CanopyCallerDescriptor,
  request: Request,
  entry: GitSyncRepository,
): Promise<void> {
  const scope = syncScope(request, entry);
  const expectedLocalHeadSha = await getHeadCommitSha(entry.repoPath);
  if (scope === null || expectedLocalHeadSha === null) {
    await pushBranchWithAuthFailure(entry.repoPath);
    return;
  }
  const branch = await getCurrentBranch(entry.repoPath);
  const expectedRemoteHeadSha = await desktopTrackingHead(
    entry.repoPath,
    branch,
  );
  try {
    await dispatcher.instruction(
      'worker.git.push',
      {
        scope,
        remote: 'origin',
        branch,
        expectedLocalHeadSha,
        expectedRemoteHeadSha,
        setUpstream: true,
      },
      options(caller),
    );
  } catch (error) {
    throw hostError(error);
  }
}
