import {
  createWorkerGitLocalMutationHandlers,
  type WorkerGitLocalMutationHandlers,
  type WorkerGitLocalMutationHost,
  type WorkerGitLocalMutationPort,
} from '@canopy/core-runtime/node/git';
import {
  persistTurnDiffTreeRef,
  restoreToSnapshot,
  revertUncommittedFile,
} from '../lib/git';
import { ensureRepoShadowEffect } from '../lib/repo-shadow';
import { consumeLocalGitBinding } from './worker-git-local-mutations-binding';

const host: WorkerGitLocalMutationHost = {
  consume: (id, operation): WorkerGitLocalMutationPort => {
    const binding = consumeLocalGitBinding(id, operation);
    return {
      revert: ({ filePath, status, previousPath }) =>
        revertUncommittedFile(binding.repoPath, filePath, status, previousPath),
      restore: (ref) => restoreToSnapshot(binding.repoPath, ref),
      persist: ({ projectId, worktreeId, treeSha }) =>
        persistTurnDiffTreeRef(
          binding.repoPath,
          projectId,
          worktreeId,
          treeSha,
        ),
      ensureShadow: async () => {
        const shadow = await ensureRepoShadowEffect(
          binding.repoPath,
          binding.shadowOptions,
        );
        binding.shadow = shadow;
        return {
          defaultBranch: shadow.defaultBranch,
          lastSyncAt: shadow.lastSyncAt,
        };
      },
    };
  },
};
export function createWorkerGitLocalMutationAdapter(): WorkerGitLocalMutationHandlers {
  return createWorkerGitLocalMutationHandlers(host);
}
