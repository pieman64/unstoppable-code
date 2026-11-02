import { z } from 'zod';

import {
  CanopyErrorPayloadSchema,
  CanopyJsonValueSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../../errors';
import {
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';

export const CORE_INITIATED_WORK_SOURCE_GRANTS = {
  read: 'core.initiatedWork.read',
} as const;

export const CORE_INITIATED_WORK_SOURCE_ERROR_CODES = [
  'core.initiatedWork.source.invalidTarget',
] as const;

// Identifier rules stay with the host validators so a rejected ID keeps its
// existing message; the wire only requires strings.
export const CoreHookSourceTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('project'),
    workspaceId: z.string(),
    worktreeId: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal('workspace-root'),
    workspaceId: z.string(),
    worktreeId: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal('workspace-repo'),
    workspaceId: z.string(),
    repoId: z.string(),
    worktreeId: z.string().optional(),
  }),
]);

// Hook actions are the persisted `canopy.json` / workspace action records.
// The discriminator is closed; the remaining fields are JSON values whose
// shape is owned by the hook settings validators.
export const CoreHookActionSchema = z
  .object({ type: z.enum(['command', 'chat', 'pipeline']) })
  .catchall(CanopyJsonValueSchema);

export const CORE_HOOK_SOURCE_ORIGINS = [
  'local-override',
  'local-disabled',
  'repo-canopy',
  'workspace-manifest',
  'workspace-manifest-disabled',
  'workspace-hook',
  'workspace-hook-disabled',
  'none',
] as const;

export const CORE_HOOK_SOURCE_LAYER_KEYS = [
  'local-override',
  'workspace-manifest',
  'repo-canopy',
  'workspace-hook',
] as const;

export const CoreHookSourceSchema = z.strictObject({
  sourceKind: z.literal('hook'),
  triggerName: z.string(),
  origin: z.enum(CORE_HOOK_SOURCE_ORIGINS),
  actions: z.array(CoreHookActionSchema).nullable(),
});

export const CoreHookSourceLayerSchema = z.strictObject({
  sourceKey: z.enum(CORE_HOOK_SOURCE_LAYER_KEYS),
  status: z.enum(['active', 'overridden', 'disabled', 'absent']),
  actions: z.array(CoreHookActionSchema).nullable(),
});

export const CoreInitiatedWorkSourceListParamsSchema = z.strictObject({
  sourceKind: z.literal('hook'),
  target: CoreHookSourceTargetSchema,
});

export const CoreInitiatedWorkSourceGetParamsSchema = z.strictObject({
  sourceKind: z.literal('hook'),
  target: CoreHookSourceTargetSchema,
  triggerName: z.string(),
});

export const CoreInitiatedWorkSourceListResultSchema = z.strictObject({
  sources: z.array(CoreHookSourceSchema),
});

export const CoreInitiatedWorkSourceGetResultSchema = z.strictObject({
  sourceKind: z.literal('hook'),
  triggerName: z.string(),
  effectiveActions: z.array(CoreHookActionSchema).nullable(),
  layers: z.array(CoreHookSourceLayerSchema),
});

export const CoreInitiatedWorkSourceErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z.enum(CORE_INITIATED_WORK_SOURCE_ERROR_CODES).optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  });

export type CoreHookSourceTarget = z.output<typeof CoreHookSourceTargetSchema>;
export type CoreHookAction = z.output<typeof CoreHookActionSchema>;
export type CoreHookSourceOrigin = (typeof CORE_HOOK_SOURCE_ORIGINS)[number];
export type CoreHookSourceLayerKey =
  (typeof CORE_HOOK_SOURCE_LAYER_KEYS)[number];
export type CoreHookSource = z.output<typeof CoreHookSourceSchema>;
export type CoreHookSourceLayer = z.output<typeof CoreHookSourceLayerSchema>;
export type CoreInitiatedWorkSourceListParams = z.output<
  typeof CoreInitiatedWorkSourceListParamsSchema
>;
export type CoreInitiatedWorkSourceGetParams = z.output<
  typeof CoreInitiatedWorkSourceGetParamsSchema
>;
export type CoreInitiatedWorkSourceListResult = z.output<
  typeof CoreInitiatedWorkSourceListResultSchema
>;
export type CoreInitiatedWorkSourceGetResult = z.output<
  typeof CoreInitiatedWorkSourceGetResultSchema
>;

export const CORE_INITIATED_WORK_SOURCE_QUERIES = defineCanopyQueryRegistry(
  'core',
  {
    'core.initiatedWork.source.list': defineCanopyQuery({
      plane: 'core',
      domain: 'initiatedWork',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: [CORE_INITIATED_WORK_SOURCE_GRANTS.read],
      params: CoreInitiatedWorkSourceListParamsSchema,
      result: CoreInitiatedWorkSourceListResultSchema,
      error: CoreInitiatedWorkSourceErrorSchema,
    }),
    'core.initiatedWork.source.get': defineCanopyQuery({
      plane: 'core',
      domain: 'initiatedWork',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: [CORE_INITIATED_WORK_SOURCE_GRANTS.read],
      params: CoreInitiatedWorkSourceGetParamsSchema,
      result: CoreInitiatedWorkSourceGetResultSchema,
      error: CoreInitiatedWorkSourceErrorSchema,
    }),
  },
);
