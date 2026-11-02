import { z } from 'zod';

import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';
import {
  inherentOperationErrorSchema,
  keyedOperationErrorSchema,
} from '../shared';

export const CORE_PULL_REQUEST_GRANTS = {
  read: 'core.pullRequest.read',
  write: 'core.pullRequest.write',
} as const;

const OpaqueIdSchema = z
  .string()
  .min(1)
  .max(512)
  .describe('Stable opaque identifier.');
const GitObjectIdSchema = z.string().regex(/^[a-fA-F0-9]{7,64}$/);
const TimestampSchema = z.iso
  .datetime({ offset: true })
  .describe('RFC 3339 timestamp with an offset.');

export const CORE_PULL_REQUEST_STATES = ['open', 'closed', 'merged'] as const;
export type CorePullRequestState = (typeof CORE_PULL_REQUEST_STATES)[number];

export const CorePullRequestCheckSchema = z.strictObject({
  checkId: OpaqueIdSchema,
  name: z.string().max(512),
  status: z.enum(['queued', 'in_progress', 'completed']),
  conclusion: z
    .enum([
      'success',
      'failure',
      'cancelled',
      'timed_out',
      'action_required',
      'neutral',
      'skipped',
    ])
    .nullable(),
  url: z.string().max(8192).nullable(),
  completedAt: TimestampSchema.nullable(),
});

export type CorePullRequestCheck = z.output<typeof CorePullRequestCheckSchema>;

/** The full pull-request projection every `core.pullRequest.*` read returns. */
export const CorePullRequestSchema = z.strictObject({
  pullRequestId: OpaqueIdSchema,
  integrationId: OpaqueIdSchema,
  repositoryId: OpaqueIdSchema,
  number: z.number().int().min(1),
  title: z.string().max(1024),
  body: z.string().max(200_000),
  url: z.string().max(8192),
  state: z.enum(CORE_PULL_REQUEST_STATES),
  draft: z.boolean(),
  baseBranch: z.string().max(512),
  baseSha: GitObjectIdSchema.nullable(),
  headBranch: z.string().max(512),
  headSha: GitObjectIdSchema,
  mergeable: z.enum(['unknown', 'mergeable', 'conflicting']),
  reviewDecision: z.enum([
    'none',
    'review_required',
    'approved',
    'changes_requested',
  ]),
  checks: z.array(CorePullRequestCheckSchema),
  reviewThreadCount: z.number().int().min(0),
  unresolvedReviewThreadCount: z.number().int().min(0),
  commentCount: z.number().int().min(0),
  updatedAt: TimestampSchema,
  revision: z.number().int().min(0),
});

export type CorePullRequest = z.output<typeof CorePullRequestSchema>;

export const CorePullRequestGetParamsSchema = z.strictObject({
  pullRequestId: OpaqueIdSchema,
  refresh: z.boolean(),
});

export type CorePullRequestGetParams = z.output<
  typeof CorePullRequestGetParamsSchema
>;

export const CorePullRequestListParamsSchema = z.strictObject({
  integrationId: OpaqueIdSchema.nullable(),
  repositoryId: OpaqueIdSchema.nullable(),
  states: z.array(z.enum(CORE_PULL_REQUEST_STATES)),
  cursor: OpaqueIdSchema.nullable(),
  limit: z.number().int().min(1).max(200),
});

export type CorePullRequestListParams = z.output<
  typeof CorePullRequestListParamsSchema
>;

export const CorePullRequestListResultSchema = z.strictObject({
  pullRequests: z.array(CorePullRequestSchema),
  nextCursor: OpaqueIdSchema.nullable(),
});

export type CorePullRequestListResult = z.output<
  typeof CorePullRequestListResultSchema
>;

export const CorePullRequestCreateParamsSchema = z.strictObject({
  integrationId: OpaqueIdSchema,
  repositoryId: OpaqueIdSchema,
  title: z.string().min(1).max(1024),
  body: z.string().max(200_000),
  baseBranch: z.string().max(512),
  headBranch: z.string().max(512),
  expectedHeadSha: GitObjectIdSchema,
  draft: z.boolean(),
});

export type CorePullRequestCreateParams = z.output<
  typeof CorePullRequestCreateParamsSchema
>;

export const CorePullRequestPatchSchema = z.strictObject({
  title: z.string().min(1).max(1024).nullable(),
  body: z.string().max(200_000).nullable(),
  baseBranch: z.string().max(512).nullable(),
  draft: z.boolean().nullable(),
});

export type CorePullRequestPatch = z.output<typeof CorePullRequestPatchSchema>;

export const CorePullRequestUpdateParamsSchema = z.strictObject({
  pullRequestId: OpaqueIdSchema,
  expectedRevision: z.number().int().min(0),
  patch: CorePullRequestPatchSchema,
});

export type CorePullRequestUpdateParams = z.output<
  typeof CorePullRequestUpdateParamsSchema
>;

const CORE_PULL_REQUEST_READ_CODES = [
  'core.pullRequest.invalidId',
  'core.pullRequest.integrationUnavailable',
  'core.pullRequest.repositoryUnavailable',
  'core.pullRequest.notAuthenticated',
] as const;

export const CORE_PULL_REQUEST_GET_ERROR_CODES = [
  ...CORE_PULL_REQUEST_READ_CODES,
  'core.pullRequest.notFound',
] as const;

export const CORE_PULL_REQUEST_LIST_ERROR_CODES = [
  ...CORE_PULL_REQUEST_READ_CODES,
  'core.pullRequest.list.invalidFilter',
  'core.pullRequest.list.scopeUnsupported',
] as const;

export const CORE_PULL_REQUEST_CREATE_ERROR_CODES = [
  ...CORE_PULL_REQUEST_READ_CODES,
  'core.pullRequest.create.invalidBranch',
  'core.pullRequest.create.headMissing',
  'core.pullRequest.create.headMismatch',
  'core.pullRequest.create.baseRejected',
  'core.pullRequest.projectionUnavailable',
  'core.pullRequest.idempotencyKeyReused',
] as const;

export const CORE_PULL_REQUEST_UPDATE_ERROR_CODES = [
  ...CORE_PULL_REQUEST_READ_CODES,
  'core.pullRequest.notFound',
  'core.pullRequest.update.invalidPatch',
  'core.pullRequest.update.draftUnsupported',
  'core.pullRequest.update.revisionConflict',
  'core.pullRequest.update.baseRejected',
  'core.pullRequest.projectionUnavailable',
  'core.pullRequest.idempotencyKeyReused',
] as const;

/** Pull request reads, served by the desktop dispatcher (CAN-4109). */
export const CORE_PULL_REQUEST_QUERY_DEFINITIONS = defineCanopyQueryRegistry(
  'core',
  {
    'core.pullRequest.get': defineCanopyQuery({
      plane: 'core',
      domain: 'pullRequest',
      version: 1,
      placement: 'core-only',
      params: CorePullRequestGetParamsSchema,
      result: CorePullRequestSchema,
      error: inherentOperationErrorSchema(CORE_PULL_REQUEST_GET_ERROR_CODES),
      idempotency: 'inherent',
      requiredGrants: ['core.pullRequest.read'],
    }),
    'core.pullRequest.list': defineCanopyQuery({
      plane: 'core',
      domain: 'pullRequest',
      version: 1,
      placement: 'core-only',
      params: CorePullRequestListParamsSchema,
      result: CorePullRequestListResultSchema,
      error: inherentOperationErrorSchema(CORE_PULL_REQUEST_LIST_ERROR_CODES),
      idempotency: 'inherent',
      requiredGrants: ['core.pullRequest.read'],
    }),
  },
);

/** Pull request create and update, served by the desktop dispatcher (CAN-4109). */
export const CORE_PULL_REQUEST_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.pullRequest.create': defineCanopyInstruction({
      plane: 'core',
      domain: 'pullRequest',
      version: 1,
      placement: 'core-only',
      params: CorePullRequestCreateParamsSchema,
      result: CorePullRequestSchema,
      error: keyedOperationErrorSchema(CORE_PULL_REQUEST_CREATE_ERROR_CODES),
      idempotency: 'keyed',
      requiredGrants: ['core.pullRequest.write'],
    }),
    'core.pullRequest.update': defineCanopyInstruction({
      plane: 'core',
      domain: 'pullRequest',
      version: 1,
      placement: 'core-only',
      params: CorePullRequestUpdateParamsSchema,
      result: CorePullRequestSchema,
      error: keyedOperationErrorSchema(CORE_PULL_REQUEST_UPDATE_ERROR_CODES),
      idempotency: 'keyed',
      requiredGrants: ['core.pullRequest.write'],
    }),
  });
