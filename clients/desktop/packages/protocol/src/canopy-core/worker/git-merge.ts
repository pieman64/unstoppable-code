import { z } from 'zod';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
} from '../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyRetryDirectiveSchema,
} from '../errors';
import { WORKER_GIT_GRANTS } from './git';
import {
  WorkerGitCheckoutScopeSchema,
  WorkerGitExpectedHeadSchema,
} from './git-branch-writes';

export const WORKER_GIT_MERGE_ERROR_CODES = [
  'worker.git.merge.invalidScope',
  'worker.git.merge.scopeUnsupported',
  'worker.git.merge.callerRefused',
  'worker.git.merge.headChanged',
  'worker.git.merge.sameBranch',
  'worker.git.merge.baseNotFound',
  'worker.git.merge.uncommittedChanges',
] as const;
export type WorkerGitMergeErrorCode =
  (typeof WORKER_GIT_MERGE_ERROR_CODES)[number];

const MergeBranchSchema = z
  .string()
  .min(1)
  .regex(/^[^-\0][^\0]*$/);

export const WorkerGitMergeParamsSchema = z.strictObject({
  scope: WorkerGitCheckoutScopeSchema,
  sourceBranch: MergeBranchSchema,
  baseBranch: MergeBranchSchema,
  expected: WorkerGitExpectedHeadSchema.optional(),
});
export type WorkerGitMergeParams = z.output<typeof WorkerGitMergeParamsSchema>;

export const WorkerGitMergeResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('merged'), mergeCommitHash: z.string() }),
  z.strictObject({ outcome: z.literal('conflict') }),
]);
export type WorkerGitMergeResult = z.output<typeof WorkerGitMergeResultSchema>;
export const WorkerGitMergeErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z.enum(WORKER_GIT_MERGE_ERROR_CODES).optional(),
  retry: z.discriminatedUnion('kind', [
    CanopyRetryDirectiveSchema.options[0],
    CanopyRetryDirectiveSchema.options[3],
  ]),
});

/** Source into local base, not base into source (CAN-5884 legacy direction). */
export const WORKER_GIT_MERGE_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('worker', {
    'worker.git.merge': defineCanopyInstruction({
      plane: 'worker',
      domain: 'git',
      version: 1,
      placement: 'target-selectable',
      params: WorkerGitMergeParamsSchema,
      result: WorkerGitMergeResultSchema,
      error: WorkerGitMergeErrorSchema,
      idempotency: 'none',
      requiredGrants: [WORKER_GIT_GRANTS.write],
    }),
  });
