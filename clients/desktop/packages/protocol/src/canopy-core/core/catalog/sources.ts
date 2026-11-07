import { z } from 'zod';

import {
  CanopyQueryRequestMetadataSchema,
  CanopyRequestMetadataSchema,
  CanopyWorkspaceScopeSchema,
} from '../../common';
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
import { CATALOG_GRANTS } from './operations';

export const CATALOG_PROVIDERS = ['claude', 'codex'] as const;

const unique = (v: readonly unknown[]): boolean => new Set(v).size === v.length;

const ProviderSchema = z.enum(CATALOG_PROVIDERS);
const ProvidersSchema = z
  .array(ProviderSchema)
  .min(1)
  .refine(unique, 'Duplicate provider')
  .meta({ uniqueItems: true });
const IdSchema = z.string().min(1).max(512);

export const CatalogSourceLocatorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('builtin'), builtinId: IdSchema }),
  z.strictObject({ kind: z.literal('curated'), catalogId: IdSchema }),
  z.strictObject({
    kind: z.literal('git'),
    repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    ref: z.string().max(512).nullable(),
  }),
  z.strictObject({
    kind: z.literal('directory'),
    fileRootId: IdSchema,
    relativePath: z.string().max(4096),
  }),
]);

export const CatalogSourceLastRefreshSchema = z.union([
  z.strictObject({ state: z.literal('never') }),
  z.strictObject({
    state: z.enum(['running', 'succeeded', 'failed']),
    operationId: IdSchema.nullable(),
    completedAt: z.iso.datetime({ offset: true }).nullable(),
    errorCode: z.string().max(256).nullable(),
  }),
]);

export const CatalogSourceSchema = z.strictObject({
  sourceId: IdSchema,
  displayName: z.string().min(1).max(256),
  locator: CatalogSourceLocatorSchema,
  providers: ProvidersSchema,
  enabled: z.boolean(),
  revision: z.number().int().min(0),
  lastRefresh: CatalogSourceLastRefreshSchema,
});
export type CatalogSource = z.output<typeof CatalogSourceSchema>;

export const CatalogSourceListParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema.pick({
    organizationId: true,
    workspaceId: true,
    worktreeId: true,
    chatId: true,
    targetId: true,
  }).optional(),
  providers: z
    .array(ProviderSchema)
    .refine(unique, 'Duplicate provider')
    .meta({ uniqueItems: true })
    .optional(),
  includeDisabled: z.boolean().optional(),
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});
export const CatalogSourceListResultSchema = z.strictObject({
  sources: z.array(CatalogSourceSchema),
  revision: z.number().int().min(0),
});

const KeyedMetaSchema = CanopyRequestMetadataSchema.extend({
  idempotencyKey: IdSchema,
});

export const CatalogSourceUpsertParamsSchema = z.strictObject({
  sourceId: IdSchema.nullable(),
  displayName: z.string().min(1).max(256),
  locator: CatalogSourceLocatorSchema,
  providers: ProvidersSchema,
  enabled: z.boolean(),
  expectedRevision: z.number().int().min(0).nullable(),
  _meta: KeyedMetaSchema,
});
export const CatalogSourceUpsertResultSchema = CatalogSourceSchema;

export const CatalogSourceDeleteParamsSchema = z.strictObject({
  sourceId: IdSchema,
  providers: ProvidersSchema,
  expectedRevision: z.number().int().min(0).nullable(),
  _meta: KeyedMetaSchema,
});
export const CatalogSourceDeleteResultSchema = z.strictObject({
  sourceId: IdSchema,
  removedProviders: z
    .array(ProviderSchema)
    .refine(unique, 'Duplicate provider')
    .meta({ uniqueItems: true }),
  alreadyAbsent: z.boolean(),
});

/** The most sources one refresh names; `'all'` over more is refused (CAN-5866). */
export const CATALOG_REFRESH_MAX_SOURCES = 100;

export const CatalogSourceRefreshParamsSchema = z.strictObject({
  /** `'all'` names every registered source, read when the request is admitted (CAN-5866). */
  sourceIds: z.union([
    z.literal('all'),
    z
      .array(IdSchema)
      .min(1)
      .max(CATALOG_REFRESH_MAX_SOURCES)
      .refine(unique, 'Duplicate source')
      .meta({ uniqueItems: true }),
  ]),
  providers: ProvidersSchema,
  mode: z.enum(['scan', 'update_then_scan']),
  _meta: KeyedMetaSchema,
});
export const CatalogSourceRefreshResultSchema = z.strictObject({
  operationId: IdSchema,
  acceptedSources: z
    .array(IdSchema)
    .refine(unique, 'Duplicate source')
    .meta({ uniqueItems: true }),
  scanOnlySources: z
    .array(IdSchema)
    .refine(unique, 'Duplicate source')
    .meta({ uniqueItems: true }),
});

export const CatalogPluginInstallParamsSchema = z.strictObject({
  entryId: IdSchema,
  providers: ProvidersSchema,
  _meta: KeyedMetaSchema,
});
const ProviderListSchema = z
  .array(ProviderSchema)
  .refine(unique, 'Duplicate provider')
  .meta({ uniqueItems: true });

/** `providers` is the request's; the two lists split it by outcome (CAN-5859). */
export const CatalogPluginInstallResultSchema = z.strictObject({
  entryId: IdSchema,
  providers: z.array(ProviderSchema),
  installedProviders: ProviderListSchema,
  failedProviders: ProviderListSchema,
});

export const CORE_CATALOG_SOURCE_CODES = {
  list: ['core.catalog.sourceInvalid', 'core.catalog.sourceUnavailable'],
  upsert: [
    'core.catalog.sourceInvalid',
    'core.catalog.sourceConflict',
    'core.catalog.sourceDuplicate',
    'core.catalog.sourceProviderRejected',
  ],
  delete: [
    'core.catalog.sourceNotFound',
    'core.catalog.sourceBuiltin',
    'core.catalog.sourceConflict',
    'core.catalog.sourceBusy',
  ],
  refresh: [
    'core.catalog.sourceNotFound',
    'core.catalog.sourceBusy',
    'core.catalog.sourceProviderRejected',
    'core.catalog.refreshUnavailable',
    'core.catalog.refreshTooLarge',
  ],
  install: [
    'core.catalog.pluginNotFound',
    'core.catalog.pluginNotInstallable',
    'core.catalog.pluginSourceRejected',
    'core.catalog.pluginUninstallPending',
    'core.catalog.pluginInstallFailed',
  ],
} as const;

/** Served by the desktop dispatcher only (CAN-4123); kept out of the composed registries. */
export const CORE_CATALOG_SOURCE_QUERY_DEFINITIONS = defineCanopyQueryRegistry(
  'core',
  {
    'core.catalog.source.list': defineCanopyQuery({
      plane: 'core',
      domain: 'catalog',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: [CATALOG_GRANTS.read],
      params: CatalogSourceListParamsSchema,
      result: CatalogSourceListResultSchema,
      error: inherentOperationErrorSchema(CORE_CATALOG_SOURCE_CODES.list),
    }),
  },
);

/** Served by the desktop dispatcher only (CAN-4123); kept out of the composed registries. */
export const CORE_CATALOG_SOURCE_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.catalog.source.upsert': defineCanopyInstruction({
      plane: 'core',
      domain: 'catalog',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: [CATALOG_GRANTS.write],
      params: CatalogSourceUpsertParamsSchema,
      result: CatalogSourceUpsertResultSchema,
      error: keyedOperationErrorSchema(CORE_CATALOG_SOURCE_CODES.upsert),
    }),
    'core.catalog.source.delete': defineCanopyInstruction({
      plane: 'core',
      domain: 'catalog',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: [CATALOG_GRANTS.write],
      params: CatalogSourceDeleteParamsSchema,
      result: CatalogSourceDeleteResultSchema,
      error: keyedOperationErrorSchema(CORE_CATALOG_SOURCE_CODES.delete),
    }),
    'core.catalog.source.refresh': defineCanopyInstruction({
      plane: 'core',
      domain: 'catalog',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: [CATALOG_GRANTS.write],
      params: CatalogSourceRefreshParamsSchema,
      result: CatalogSourceRefreshResultSchema,
      error: keyedOperationErrorSchema(CORE_CATALOG_SOURCE_CODES.refresh),
    }),
    'core.catalog.plugin.install': defineCanopyInstruction({
      plane: 'core',
      domain: 'catalog',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: [CATALOG_GRANTS.write],
      params: CatalogPluginInstallParamsSchema,
      result: CatalogPluginInstallResultSchema,
      error: keyedOperationErrorSchema(CORE_CATALOG_SOURCE_CODES.install),
    }),
  });
