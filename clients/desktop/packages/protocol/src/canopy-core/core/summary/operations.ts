import { z } from 'zod';

import {
  CanopyRequestMetadataSchema,
  CanopyWorkspaceScopeSchema,
} from '../../common';
import {
  CanopyErrorPayloadSchema,
  CanopyJsonValueSchema,
  CanopyKeyedRetryDirectiveSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../../errors';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';
import { OperationStatusSchema } from '../operation/schemas';

const id = z.string().min(1).max(512);

export const CORE_SUMMARY_GRANTS = {
  read: 'core.summary.read',
  write: 'core.summary.write',
} as const;

export const CORE_SUMMARY_ERROR_CODES = [
  'core.summary.invalidState',
  'core.summary.revisionConflict',
  'core.summary.notFound',
] as const;

export const CORE_SUMMARY_CONTENT_MAX = 2_000_000;

export const CoreSummaryGetParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema,
});

export const CoreSummaryGetResultSchema = z
  .object({
    summaryId: id,
    scope: CanopyWorkspaceScopeSchema,
    sourceRevision: z.string(),
    content: z.string().max(CORE_SUMMARY_CONTENT_MAX),
    state: z.enum(['ready', 'stale', 'missing', 'failed']),
    revision: z.number().int().min(0),
    generatedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  // Results may gain additive fields, as the catalog page allows.
  .catchall(CanopyJsonValueSchema);

export const CoreSummaryRegenerateParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema,
  expectedSourceRevision: z.string(),
  targetId: z.string().nullable().optional(),
  providerProfile: z.object({}).catchall(CanopyJsonValueSchema).optional(),
  _meta: CanopyRequestMetadataSchema.required({ idempotencyKey: true }),
});

export const CoreSummaryOperationRefSchema = z
  .object({
    operationId: id,
    kind: z.string().regex(/^(core|worker)(\.[a-z][A-Za-z0-9]*){2,}$/),
    status: OperationStatusSchema,
    authorityId: z.string().max(512).nullable().optional(),
    executionTargetId: z.string().max(512).nullable().optional(),
    runtimeDelegationId: z.string().max(512).nullable().optional(),
    parentOperationId: z.string().max(512).nullable().optional(),
  })
  // Results may gain additive fields, as the catalog page allows.
  .catchall(CanopyJsonValueSchema);

export const CoreSummaryErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z.enum(CORE_SUMMARY_ERROR_CODES).optional(),
});

export const CoreSummaryQueryErrorSchema = CoreSummaryErrorSchema.extend({
  retry: CanopyQueryRetryDirectiveSchema,
});

export const CoreSummaryInstructionErrorSchema = CoreSummaryErrorSchema.extend({
  retry: CanopyKeyedRetryDirectiveSchema,
});

export const CORE_SUMMARY_QUERY_DEFINITIONS = defineCanopyQueryRegistry(
  'core',
  {
    'core.summary.get': defineCanopyQuery({
      plane: 'core',
      domain: 'summary',
      version: 1,
      placement: 'core-only',
      params: CoreSummaryGetParamsSchema,
      result: CoreSummaryGetResultSchema,
      error: CoreSummaryQueryErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [CORE_SUMMARY_GRANTS.read],
    }),
  },
);

export const CORE_SUMMARY_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.summary.regenerate': defineCanopyInstruction({
      plane: 'core',
      domain: 'summary',
      version: 1,
      placement: 'core-only',
      params: CoreSummaryRegenerateParamsSchema,
      result: CoreSummaryOperationRefSchema,
      error: CoreSummaryInstructionErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [CORE_SUMMARY_GRANTS.write],
    }),
  });

export type CoreSummaryGetResult = z.output<typeof CoreSummaryGetResultSchema>;
export type CoreSummaryRegenerateParams = z.output<
  typeof CoreSummaryRegenerateParamsSchema
>;
export type CoreSummaryOperationRef = z.output<
  typeof CoreSummaryOperationRefSchema
>;
