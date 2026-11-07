import { z } from 'zod';
import {
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';
import { inherentOperationErrorSchema } from '../shared';

export const CorePullRequestMergeQueueGetParamsSchema = z.strictObject({
  repository: z.string().min(1).max(512),
  baseBranch: z.string().min(1).max(255),
});

export const CorePullRequestMergeQueueGetResultSchema = z.strictObject({
  queue: z
    .strictObject({
      url: z.string().max(2048).nullable(),
      baseBranch: z.string().min(1).max(255),
      totalCount: z.number().int().nonnegative(),
      maximumEntriesToBuild: z.number().int().positive().nullable(),
      entries: z
        .array(
          z.strictObject({
            position: z.number().int().nonnegative(),
            phase: z.enum([
              'queued',
              'awaiting_checks',
              'mergeable',
              'locked',
              'unmergeable',
              'unknown',
            ]),
            estimatedSecondsToMerge: z.number().nonnegative().nullable(),
            enqueuedAt: z.string().nullable(),
            pullRequest: z.strictObject({
              number: z.number().int().positive(),
              title: z.string().max(1024),
              url: z.string().max(2048),
              author: z.string().nullable(),
            }),
          }),
        )
        .max(50),
      fetchedAt: z.string(),
    })
    .nullable(),
});

export type CorePullRequestMergeQueueGetParams = z.output<
  typeof CorePullRequestMergeQueueGetParamsSchema
>;
export type CorePullRequestMergeQueueGetResult = z.output<
  typeof CorePullRequestMergeQueueGetResultSchema
>;

export const CORE_PULL_REQUEST_MERGE_QUEUE_ERROR_CODES = [
  'core.pullRequest.notAuthenticated',
  'core.pullRequest.notFound',
] as const;

export const CORE_PULL_REQUEST_MERGE_QUEUE_QUERY_DEFINITIONS =
  defineCanopyQueryRegistry('core', {
    'core.pullRequest.mergeQueue.get': defineCanopyQuery({
      plane: 'core',
      domain: 'pullRequest',
      version: 1,
      placement: 'core-only',
      params: CorePullRequestMergeQueueGetParamsSchema,
      result: CorePullRequestMergeQueueGetResultSchema,
      error: inherentOperationErrorSchema(
        CORE_PULL_REQUEST_MERGE_QUEUE_ERROR_CODES,
      ),
      idempotency: 'inherent',
      requiredGrants: ['core.pullRequest.read'],
    }),
  });
