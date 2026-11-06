import { z } from 'zod';

import {
  CanopyQueryRequestMetadataSchema,
  CanopyRequestMetadataSchema,
  CanopyWorkspaceScopeSchema,
} from '../common';
import {
  CATALOG_MATERIALIZATION_ID_PATTERN,
  CATALOG_MATERIALIZATION_LIMITS,
  CATALOG_SHA256_PATTERN,
  CatalogMaterializationItemDescriptorSchema,
  checkCatalogMaterializationItems,
} from '../core/catalog/materialization';
import { WORKER_EXECUTION_SECRET_ERROR_CODES } from './execution-secrets';
import {
  inherentOperationErrorSchema,
  keyedOperationErrorSchema,
} from '../core/shared';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../definitions';

/*
 * `worker.catalog.*` (CAN-4123): the worker materializes a resolved selection
 * under its content-addressed identity and never rewrites it. Kept outside the
 * worker registry; the desktop composes it for its in-process worker.
 */
export const WORKER_CATALOG_GRANTS = {
  read: 'worker.catalog.read',
  write: 'worker.catalog.write',
} as const;
export const WORKER_CATALOG_CODES = [
  'worker.catalog.invalidState',
  'worker.catalog.revisionConflict',
  'worker.catalog.notFound',
  ...WORKER_EXECUTION_SECRET_ERROR_CODES,
] as const;
export const WORKER_CATALOG_MATERIALIZATION_CODES = [
  'worker.catalog.materialization.invalidState',
  'worker.catalog.materialization.revisionConflict',
  'worker.catalog.materialization.notFound',
] as const;
export const WORKER_CATALOG_DIAGNOSTIC_CODES = [
  'worker.catalog.itemMissing',
  'worker.catalog.providerMissing',
] as const;

export const WorkerCatalogEffectiveItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    entryId: z.string().min(1).max(512),
    kind: z.literal('plugin'),
    providers: z
      .array(z.enum(['claude', 'codex']))
      .min(1)
      .max(2),
  }),
  z.strictObject({
    entryId: z.string().min(1).max(512),
    kind: z.literal('mcp_server'),
    transport: z.enum(['stdio', 'http']),
  }),
]);
export const WorkerCatalogDiagnosticSchema = z.strictObject({
  entryId: z.string().min(1).max(512).nullable(),
  code: z.enum(WORKER_CATALOG_DIAGNOSTIC_CODES),
  severity: z.enum(['warning', 'error']),
  message: z.string().min(1).max(1024),
});
export const WorkerCatalogMaterializationSchema = z.strictObject({
  materializationId: z.string().regex(CATALOG_MATERIALIZATION_ID_PATTERN),
  state: z.enum(['pending', 'ready', 'failed', 'released']),
  fingerprint: z.string().regex(CATALOG_SHA256_PATTERN),
  effectiveItems: z
    .array(WorkerCatalogEffectiveItemSchema)
    .max(CATALOG_MATERIALIZATION_LIMITS.items),
  diagnostics: z
    .array(WorkerCatalogDiagnosticSchema)
    .max(CATALOG_MATERIALIZATION_LIMITS.diagnostics),
});
export type WorkerCatalogMaterialization = z.output<
  typeof WorkerCatalogMaterializationSchema
>;

export const WorkerCatalogMaterializeParamsSchema = z.strictObject({
  materializationId: z.string().regex(CATALOG_MATERIALIZATION_ID_PATTERN),
  scope: CanopyWorkspaceScopeSchema,
  itemDescriptors: z
    .array(CatalogMaterializationItemDescriptorSchema)
    .max(CATALOG_MATERIALIZATION_LIMITS.items)
    .superRefine(checkCatalogMaterializationItems),
  expectedFingerprint: z.string().regex(CATALOG_SHA256_PATTERN),
  /**
   * `[materializationId]` exactly when the descriptors name a secret binding
   * (`catalogMaterializationSecretBindings`), otherwise absent; the worker
   * redeems from the grant its core staged for
   * `{ operation: 'worker.catalog.materialize', key: materializationId }`.
   */
  secretGrantIds: z.array(z.string().min(1).max(512)).max(64).optional(),
  _meta: CanopyRequestMetadataSchema.extend({
    idempotencyKey: z.string().min(1).max(512),
  }),
});
export const WorkerCatalogMaterializationGetParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema.optional(),
  materializationId: z.string().regex(CATALOG_MATERIALIZATION_ID_PATTERN),
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});
export const WorkerCatalogMaterializationReleaseParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema.optional(),
  materializationId: z.string().regex(CATALOG_MATERIALIZATION_ID_PATTERN),
  _meta: CanopyRequestMetadataSchema.optional(),
});
export const WorkerCatalogMaterializationReleaseResultSchema = z.strictObject({
  released: z.boolean(),
});

/** Served by the desktop's in-process worker only (CAN-4123); outside the worker registry. */
export const WORKER_CATALOG_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('worker', {
    'worker.catalog.materialize': defineCanopyInstruction({
      plane: 'worker',
      domain: 'catalog',
      version: 1,
      placement: 'target-selectable',
      idempotency: 'keyed',
      requiredGrants: [WORKER_CATALOG_GRANTS.write],
      params: WorkerCatalogMaterializeParamsSchema,
      result: WorkerCatalogMaterializationSchema,
      error: keyedOperationErrorSchema(WORKER_CATALOG_CODES),
    }),
    'worker.catalog.materialization.release': defineCanopyInstruction({
      plane: 'worker',
      domain: 'catalog',
      version: 1,
      placement: 'target-selectable',
      idempotency: 'inherent',
      requiredGrants: [WORKER_CATALOG_GRANTS.write],
      params: WorkerCatalogMaterializationReleaseParamsSchema,
      result: WorkerCatalogMaterializationReleaseResultSchema,
      error: inherentOperationErrorSchema(WORKER_CATALOG_MATERIALIZATION_CODES),
    }),
  });

/** Served by the desktop's in-process worker only (CAN-4123); outside the worker registry. */
export const WORKER_CATALOG_QUERY_DEFINITIONS = defineCanopyQueryRegistry(
  'worker',
  {
    'worker.catalog.materialization.get': defineCanopyQuery({
      plane: 'worker',
      domain: 'catalog',
      version: 1,
      placement: 'target-selectable',
      idempotency: 'inherent',
      requiredGrants: [WORKER_CATALOG_GRANTS.read],
      params: WorkerCatalogMaterializationGetParamsSchema,
      result: WorkerCatalogMaterializationSchema,
      error: inherentOperationErrorSchema(WORKER_CATALOG_MATERIALIZATION_CODES),
    }),
  },
);
