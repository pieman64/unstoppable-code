import { z } from 'zod';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
} from '../definitions';
import { CanopyErrorPayloadSchema } from '../errors';
import { WORKER_GIT_GRANTS } from './git';

// A single-use, host-staged binding, never a path or a workspace selector.
const bindingId = z.string().uuid();
export const WorkerGitFileRevertParamsSchema = z.strictObject({
  bindingId,
  filePath: z.string(),
  status: z.enum([
    'untracked',
    'added',
    'copied',
    'renamed',
    'modified',
    'deleted',
    'type-changed',
    'unmerged',
    'unknown',
  ]),
  previousPath: z.string().optional(),
});
export type WorkerGitFileRevertParams = z.output<
  typeof WorkerGitFileRevertParamsSchema
>;
export const WorkerGitSnapshotRestoreParamsSchema = z.strictObject({
  bindingId,
  treeSha: z.string(),
  headCommitSha: z.string().optional(),
});
export type WorkerGitSnapshotRestoreParams = z.output<
  typeof WorkerGitSnapshotRestoreParamsSchema
>;
export const WorkerGitTurnRefPersistParamsSchema = z.strictObject({
  bindingId,
  projectId: z.string(),
  worktreeId: z.string(),
  treeSha: z.string(),
});
export type WorkerGitTurnRefPersistParams = z.output<
  typeof WorkerGitTurnRefPersistParamsSchema
>;
export const WorkerGitRepoShadowEnsureParamsSchema = z.strictObject({
  bindingId,
});
export const WorkerGitLocalMutationResultSchema = z.strictObject({});
export const WorkerGitRepoShadowEnsureResultSchema = z.strictObject({
  defaultBranch: z.string(),
  lastSyncAt: z.string(),
});

export const WorkerGitLocalMutationErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z
      .enum([
        'worker.git.localMutation.callerRefused',
        'worker.git.localMutation.bindingUnavailable',
      ])
      .optional(),
  });

/** Desktop in-process only (CAN-5931); not a daemon registration or route. */
export const WORKER_GIT_LOCAL_MUTATION_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('worker', {
    'worker.git.file.revert': defineCanopyInstruction({
      plane: 'worker',
      domain: 'git',
      version: 1,
      placement: 'worker-only',
      error: WorkerGitLocalMutationErrorSchema,
      idempotency: 'none',
      requiredGrants: [WORKER_GIT_GRANTS.write],
      params: WorkerGitFileRevertParamsSchema,
      result: WorkerGitLocalMutationResultSchema,
    }),
    'worker.git.snapshot.restore': defineCanopyInstruction({
      plane: 'worker',
      domain: 'git',
      version: 1,
      placement: 'worker-only',
      error: WorkerGitLocalMutationErrorSchema,
      idempotency: 'none',
      requiredGrants: [WORKER_GIT_GRANTS.write],
      params: WorkerGitSnapshotRestoreParamsSchema,
      result: WorkerGitLocalMutationResultSchema,
    }),
    'worker.git.turnRef.persist': defineCanopyInstruction({
      plane: 'worker',
      domain: 'git',
      version: 1,
      placement: 'worker-only',
      error: WorkerGitLocalMutationErrorSchema,
      idempotency: 'none',
      requiredGrants: [WORKER_GIT_GRANTS.write],
      params: WorkerGitTurnRefPersistParamsSchema,
      result: WorkerGitLocalMutationResultSchema,
    }),
    'worker.git.repoShadow.ensure': defineCanopyInstruction({
      plane: 'worker',
      domain: 'git',
      version: 1,
      placement: 'worker-only',
      error: WorkerGitLocalMutationErrorSchema,
      idempotency: 'none',
      requiredGrants: [WORKER_GIT_GRANTS.write],
      params: WorkerGitRepoShadowEnsureParamsSchema,
      result: WorkerGitRepoShadowEnsureResultSchema,
    }),
  });
