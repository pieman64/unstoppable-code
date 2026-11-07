import { z } from 'zod';

import { CanopyWorkspaceScopeSchema } from '../../common';
import {
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../../errors';

export const CORE_SEARCH_GRANTS = {
  read: 'core.search.read',
} as const;

export const CORE_SEARCH_SOURCES = [
  'live_chat',
  'chat_archive',
  'cowork_archive',
  'archived_container',
  'plan',
] as const;
export const CORE_SEARCH_REF_KINDS = [
  'workspace',
  'worktree',
  'chat',
  'turn',
  'plan',
  'pipeline_execution',
  'agent_session',
  'artifact',
  'archive',
  'review',
] as const;
export const CORE_SEARCH_REVIEW_STATUSES = [
  'draft',
  'in_review',
  'approved',
  'changes_requested',
  'dismissed',
] as const;
export const CORE_SEARCH_TITLE_MAX = 1024;
export const CORE_SEARCH_DESCRIPTION_MAX = 4096;
export const CORE_SEARCH_PROVIDER_MAX = 128;
export const CORE_SEARCH_SNIPPET_MAX = 8192;

const OpaqueIdSchema = z
  .string()
  .min(1)
  .max(512)
  .describe('Stable opaque identifier.');
const TimestampSchema = z.iso
  .datetime({ offset: true })
  .describe('RFC 3339 timestamp with an offset.');

export const CoreSearchQueryParamsSchema = z.strictObject({
  query: z.string().min(1).max(4096),
  scope: CanopyWorkspaceScopeSchema,
  sources: z.array(z.enum(CORE_SEARCH_SOURCES)),
  cursor: OpaqueIdSchema.nullable(),
  limit: z.number().int().min(1).max(200),
});

export const CoreSearchHitSchema = z.strictObject({
  document: z.strictObject({
    documentId: OpaqueIdSchema,
    ref: z.strictObject({
      kind: z.enum(CORE_SEARCH_REF_KINDS),
      id: OpaqueIdSchema,
      revision: z.number().int().min(0).optional(),
      digest: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    }),
    source: z.enum(CORE_SEARCH_SOURCES),
    title: z.string().max(CORE_SEARCH_TITLE_MAX),
    description: z.string().max(CORE_SEARCH_DESCRIPTION_MAX).nullable(),
    provider: z.string().max(CORE_SEARCH_PROVIDER_MAX).nullable(),
    updatedAt: TimestampSchema,
    archivedAt: TimestampSchema.nullable(),
    messageCount: z.number().int().min(0),
    reviewStatus: z.enum(CORE_SEARCH_REVIEW_STATUSES).nullable(),
  }),
  score: z.number().min(0),
  snippet: z.string().max(CORE_SEARCH_SNIPPET_MAX),
  matches: z.array(
    z.strictObject({
      start: z.number().int().min(0),
      end: z.number().int().min(0),
    }),
  ),
});

export const CoreSearchQueryResultSchema = z.strictObject({
  indexRevision: z.number().int().min(0),
  hits: z.array(CoreSearchHitSchema),
  nextCursor: z
    .string()
    .min(1)
    .max(512)
    .describe('Opaque pagination cursor.')
    .nullable(),
});

// The page's error data predates the frozen payload (CAN-4162 precedent); the
// served errors carry no operation code.
const CoreSearchErrorSchema = CanopyErrorPayloadSchema.omit({
  code: true,
}).extend({ retry: CanopyQueryRetryDirectiveSchema });

export const CORE_SEARCH_QUERY_DEFINITIONS = defineCanopyQueryRegistry('core', {
  'core.search.query': defineCanopyQuery({
    plane: 'core',
    domain: 'search',
    version: 1,
    placement: 'core-only',
    params: CoreSearchQueryParamsSchema,
    result: CoreSearchQueryResultSchema,
    error: CoreSearchErrorSchema,
    idempotency: 'inherent',
    requiredGrants: [CORE_SEARCH_GRANTS.read],
  }),
});

export type CoreSearchHit = z.output<typeof CoreSearchHitSchema>;
export type CoreSearchQueryParams = z.output<
  typeof CoreSearchQueryParamsSchema
>;
export type CoreSearchQueryResult = z.output<
  typeof CoreSearchQueryResultSchema
>;
