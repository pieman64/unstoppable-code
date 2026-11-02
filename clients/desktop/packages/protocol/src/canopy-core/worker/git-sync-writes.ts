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

// Mutations are idempotency `none`: a failed or unknown outcome is retried
// only after the caller refreshes the checkout.
const WorkerGitSyncRetryDirectiveSchema = z.discriminatedUnion('kind', [
  CanopyRetryDirectiveSchema.options[0],
  CanopyRetryDirectiveSchema.options[3],
]);

export const WORKER_GIT_FETCH_ERROR_CODES = [
  'worker.git.fetch.invalidScope',
  'worker.git.fetch.scopeUnsupported',
  'worker.git.fetch.callerRefused',
] as const;

export type WorkerGitFetchErrorCode =
  (typeof WORKER_GIT_FETCH_ERROR_CODES)[number];

export const WorkerGitFetchParamsSchema = z.strictObject({
  scope: WorkerGitCheckoutScopeSchema,
  /** Also delete `origin/*` refs whose branch `origin` no longer has. */
  prune: z.boolean(),
});

export type WorkerGitFetchParams = z.output<typeof WorkerGitFetchParamsSchema>;

export const WorkerGitFetchResultSchema = z.strictObject({
  /** The remote fetched; always `origin` in version 1. */
  remote: z.literal('origin'),
  pruned: z.boolean(),
});

export type WorkerGitFetchResult = z.output<typeof WorkerGitFetchResultSchema>;

export const WorkerGitFetchErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z.enum(WORKER_GIT_FETCH_ERROR_CODES).optional(),
  retry: WorkerGitSyncRetryDirectiveSchema,
});

export const WORKER_GIT_PULL_ERROR_CODES = [
  'worker.git.pull.invalidScope',
  'worker.git.pull.scopeUnsupported',
  'worker.git.pull.callerRefused',
  'worker.git.pull.headChanged',
] as const;

export type WorkerGitPullErrorCode =
  (typeof WORKER_GIT_PULL_ERROR_CODES)[number];

/**
 * `fast-forward` runs `pull --ff-only`; `rebase` runs `pull --rebase
 * --autostash`, setting uncommitted changes aside and re-applying them.
 */
export const WORKER_GIT_PULL_STRATEGIES = ['fast-forward', 'rebase'] as const;

export type WorkerGitPullStrategy = (typeof WORKER_GIT_PULL_STRATEGIES)[number];

export const WorkerGitPullParamsSchema = z.strictObject({
  scope: WorkerGitCheckoutScopeSchema,
  /**
   * The `origin` branch to integrate. Unvalidated, as the desktop pull was:
   * a branch `origin` lacks fails as Git fails.
   */
  branch: z.string(),
  strategy: z.enum(WORKER_GIT_PULL_STRATEGIES),
  expected: WorkerGitExpectedHeadSchema.optional(),
});

export type WorkerGitPullParams = z.output<typeof WorkerGitPullParamsSchema>;

/**
 * Where a failed rebase pull left the checkout: `rebase` mid-rebase with
 * conflicts, or `autostash` rebased with the set-aside changes unmerged and
 * the autostash entry kept.
 */
export const WORKER_GIT_PULL_CONFLICTS = ['rebase', 'autostash'] as const;

export type WorkerGitPullConflict = (typeof WORKER_GIT_PULL_CONFLICTS)[number];

export const WorkerGitPullResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('pulled') }),
  z.strictObject({
    outcome: z.literal('conflict'),
    conflict: z.enum(WORKER_GIT_PULL_CONFLICTS),
  }),
]);

export type WorkerGitPullResult = z.output<typeof WorkerGitPullResultSchema>;

export const WorkerGitPullErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z.enum(WORKER_GIT_PULL_ERROR_CODES).optional(),
  retry: WorkerGitSyncRetryDirectiveSchema,
});

/**
 * Fetching `origin` and pulling one branch into one checkout. Idempotency
 * `none`, with no `_meta` in params: a repeated call re-runs Git against the
 * checkout and `origin` as they then are (CAN-4108 Q7).
 */
export const WORKER_GIT_SYNC_WRITE_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('worker', {
    'worker.git.fetch': defineCanopyInstruction({
      plane: 'worker',
      domain: 'git',
      version: 1,
      placement: 'target-selectable',
      params: WorkerGitFetchParamsSchema,
      result: WorkerGitFetchResultSchema,
      error: WorkerGitFetchErrorSchema,
      idempotency: 'none',
      requiredGrants: [WORKER_GIT_GRANTS.write],
    }),
    'worker.git.pull': defineCanopyInstruction({
      plane: 'worker',
      domain: 'git',
      version: 1,
      placement: 'target-selectable',
      params: WorkerGitPullParamsSchema,
      result: WorkerGitPullResultSchema,
      error: WorkerGitPullErrorSchema,
      idempotency: 'none',
      requiredGrants: [WORKER_GIT_GRANTS.write],
    }),
  });
