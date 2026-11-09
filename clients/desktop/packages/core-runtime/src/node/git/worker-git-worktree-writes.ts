import type {
  WORKER_GIT_WORKTREE_WRITE_INSTRUCTION_DEFINITIONS,
  WorkerGitRecordedRepositoryScope,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../runtime/errors';
import type {
  CanopyDispatcherInstructionHandlerMap,
  CanopyHandlerContext,
} from '../../runtime/types';
import { WorkerGitScopeError } from './worker-git-branch-list';
import { GitBranchWriteInterrupted } from './branch-writes';
import { isWorkerGitWriteCaller } from './worker-git-branch-writes';
import {
  assertWorkerGitServedSelection,
  type WorkerGitServedSelection,
} from './worker-git-selection';

export interface WorkerGitWorktreeWritePort {
  add(branch: string, backgroundPriority?: boolean): Promise<string>;
  remove(): Promise<void>;
  prune(): Promise<void>;
}
export type WorkerGitWorktreeScope = WorkerGitRecordedRepositoryScope & {
  worktreeId?: string;
};
export interface WorkerGitWorktreeWriteHost extends WorkerGitServedSelection {
  /** Resolve only trusted records or an owning command's admitted reservation. */
  resolve(
    scope: WorkerGitWorktreeScope,
    context: CanopyHandlerContext,
    operation: 'add' | 'remove' | 'prune',
  ): Promise<WorkerGitWorktreeWritePort>;
}
export type WorkerGitWorktreeWriteHandlers =
  CanopyDispatcherInstructionHandlerMap<
    typeof WORKER_GIT_WORKTREE_WRITE_INSTRUCTION_DEFINITIONS
  >;
export function createWorkerGitWorktreeWriteHandlers(
  host: WorkerGitWorktreeWriteHost,
): WorkerGitWorktreeWriteHandlers {
  const run = async <T>(
    scope: WorkerGitWorktreeScope,
    context: CanopyHandlerContext,
    operation: 'add' | 'remove' | 'prune',
    effect: (port: WorkerGitWorktreeWritePort) => Promise<T>,
  ): Promise<T> => {
    if (!isWorkerGitWriteCaller(context.caller))
      throw new CanopyOperationError({
        kind: 'permission_denied',
        code: 'worker.git.worktree.callerRefused',
        message: 'This Git operation requires a local desktop caller.',
        retry: { kind: 'never' },
      });
    assertWorkerGitServedSelection(scope, host);
    try {
      return await effect(await host.resolve(scope, context, operation));
    } catch (error) {
      if (error instanceof WorkerGitScopeError)
        throw new CanopyOperationError(
          {
            kind:
              error.reason === 'invalid'
                ? 'invalid_argument'
                : 'failed_precondition',
            code:
              error.reason === 'invalid'
                ? 'worker.git.worktree.invalidScope'
                : 'worker.git.worktree.scopeUnsupported',
            message:
              'The worktree scope cannot be resolved from trusted records.',
            retry: { kind: 'never' },
          },
          error.hostCause ?? error,
        );
      if (error instanceof GitBranchWriteInterrupted)
        throw new CanopyOperationError(
          {
            kind: 'unavailable',
            message: error.message,
            retry: {
              kind: 'after_refresh',
              resource: 'worker.git.branch.list',
            },
          },
          error.hostCause ?? error,
        );
      throw error;
    }
  };
  return {
    'worker.git.worktree.add': (params, context) =>
      run(params.scope, context, 'add', async (port) => ({
        branch: await port.add(params.branch, params.backgroundPriority),
      })),
    'worker.git.worktree.remove': (params, context) =>
      run(params.scope, context, 'remove', async (port) => {
        await port.remove();
        return {};
      }),
    'worker.git.worktree.prune': (params, context) =>
      run(params.scope, context, 'prune', async (port) => {
        await port.prune();
        return {};
      }),
  };
}
