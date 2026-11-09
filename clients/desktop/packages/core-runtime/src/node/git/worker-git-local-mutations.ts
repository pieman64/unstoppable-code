import type {
  WORKER_GIT_LOCAL_MUTATION_INSTRUCTION_DEFINITIONS,
  WorkerGitFileRevertParams,
  WorkerGitSnapshotRestoreParams,
  WorkerGitTurnRefPersistParams,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../runtime/errors';
import type {
  CanopyDispatcherInstructionHandlerMap,
  CanopyHandlerContext,
} from '../../runtime/types';
import { isWorkerGitWriteCaller } from './worker-git-branch-writes';

export type WorkerGitLocalMutationName =
  | 'worker.git.file.revert'
  | 'worker.git.snapshot.restore'
  | 'worker.git.turnRef.persist'
  | 'worker.git.repoShadow.ensure';

/** Host paths, shadow locks/caches and host-owned cancellation stay behind this port. */
export interface WorkerGitLocalMutationPort {
  revert(params: Omit<WorkerGitFileRevertParams, 'bindingId'>): Promise<void>;
  restore(
    params: Omit<WorkerGitSnapshotRestoreParams, 'bindingId'>,
  ): Promise<void>;
  persist(
    params: Omit<WorkerGitTurnRefPersistParams, 'bindingId'>,
  ): Promise<void>;
  ensureShadow(): Promise<{ defaultBranch: string; lastSyncAt: string }>;
}
export interface WorkerGitLocalMutationHost {
  consume(
    bindingId: string,
    operation: WorkerGitLocalMutationName,
    context: CanopyHandlerContext,
  ): WorkerGitLocalMutationPort;
}
export type WorkerGitLocalMutationHandlers =
  CanopyDispatcherInstructionHandlerMap<
    typeof WORKER_GIT_LOCAL_MUTATION_INSTRUCTION_DEFINITIONS
  >;

export function createWorkerGitLocalMutationHandlers(
  host: WorkerGitLocalMutationHost,
): WorkerGitLocalMutationHandlers {
  const port = (
    bindingId: string,
    operation: WorkerGitLocalMutationName,
    context: CanopyHandlerContext,
  ): WorkerGitLocalMutationPort => {
    const caller = context.caller;
    if (!isWorkerGitWriteCaller(caller) && caller.interfaceKind !== 'test')
      throw new CanopyOperationError({
        kind: 'permission_denied',
        code: 'worker.git.localMutation.callerRefused',
        message: 'This Git operation requires a local desktop caller.',
        retry: { kind: 'never' },
      });
    return host.consume(bindingId, operation, context);
  };
  return {
    'worker.git.file.revert': async ({ bindingId, ...params }, context) => {
      await port(bindingId, 'worker.git.file.revert', context).revert(params);
      return {};
    },
    'worker.git.snapshot.restore': async (
      { bindingId, ...params },
      context,
    ) => {
      await port(bindingId, 'worker.git.snapshot.restore', context).restore(
        params,
      );
      return {};
    },
    'worker.git.turnRef.persist': async ({ bindingId, ...params }, context) => {
      await port(bindingId, 'worker.git.turnRef.persist', context).persist(
        params,
      );
      return {};
    },
    'worker.git.repoShadow.ensure': async ({ bindingId }, context) =>
      port(bindingId, 'worker.git.repoShadow.ensure', context).ensureShadow(),
  };
}
