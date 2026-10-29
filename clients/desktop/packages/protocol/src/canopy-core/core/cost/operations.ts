import { z } from 'zod';

import {
  CanopyErrorPayloadSchema,
  CanopyKeyedRetryDirectiveSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../../errors';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';
import {
  CostChatGetResultSchema,
  CostChatRequestSchema,
  CostIndexRefreshParamsSchema,
  CostIndexRefreshResultSchema,
  CostPipelineRunGetResultSchema,
  CostPipelineRunRequestSchema,
  CostScopeGetResultSchema,
  CostScopeRequestSchema,
} from './schemas';

export const COST_GRANTS = {
  read: 'core.cost.read',
} as const;

export const CostOperationErrorDetailsSchema = z.strictObject({
  reason: z.enum([
    'no_scope',
    'runtime_unavailable',
    'NOT_FOUND',
    'SCOPE_SEALED',
    'UNKNOWN',
  ]),
});

const costErrorCodes = z.enum([
  'core.cost.noScope',
  'core.cost.runtimeUnavailable',
  'core.cost.notFound',
  'core.cost.scopeSealed',
  'core.cost.unknown',
]);

export const CostQueryErrorSchema = CanopyErrorPayloadSchema.extend({
  code: costErrorCodes.optional(),
  details: CostOperationErrorDetailsSchema.optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});

export const CostInstructionErrorSchema = CanopyErrorPayloadSchema.extend({
  code: costErrorCodes.optional(),
  details: CostOperationErrorDetailsSchema.optional(),
  retry: CanopyKeyedRetryDirectiveSchema,
});

export const COST_QUERY_DEFINITIONS = defineCanopyQueryRegistry('core', {
  'core.cost.scope.get': defineCanopyQuery({
    plane: 'core',
    domain: 'cost',
    version: 1,
    placement: 'core-only',
    params: CostScopeRequestSchema,
    result: CostScopeGetResultSchema,
    error: CostQueryErrorSchema,
    idempotency: 'inherent',
    requiredGrants: [COST_GRANTS.read],
  }),
  'core.cost.chat.get': defineCanopyQuery({
    plane: 'core',
    domain: 'cost',
    version: 1,
    placement: 'core-only',
    params: CostChatRequestSchema,
    result: CostChatGetResultSchema,
    error: CostQueryErrorSchema,
    idempotency: 'inherent',
    requiredGrants: [COST_GRANTS.read],
  }),
  'core.cost.pipelineRun.get': defineCanopyQuery({
    plane: 'core',
    domain: 'cost',
    version: 1,
    placement: 'core-only',
    params: CostPipelineRunRequestSchema,
    result: CostPipelineRunGetResultSchema,
    error: CostQueryErrorSchema,
    idempotency: 'inherent',
    requiredGrants: [COST_GRANTS.read],
  }),
});

export const COST_INSTRUCTION_DEFINITIONS = defineCanopyInstructionRegistry(
  'core',
  {
    'core.cost.index.refresh': defineCanopyInstruction({
      plane: 'core',
      domain: 'cost',
      version: 1,
      placement: 'core-only',
      params: CostIndexRefreshParamsSchema,
      result: CostIndexRefreshResultSchema,
      error: CostInstructionErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [COST_GRANTS.read],
    }),
  },
);
