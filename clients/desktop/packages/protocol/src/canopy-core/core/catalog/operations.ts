import { z } from 'zod';

import {
  CanopyRequestMetadataSchema,
  CanopyWorkspaceScopeSchema,
} from '../../common';
import { CanopyJsonValueSchema } from '../../errors';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';
import {
  OperationKindSchema,
  OperationStatusSchema,
} from '../operation/schemas';
import {
  inherentOperationErrorSchema,
  keyedOperationErrorSchema,
} from '../shared';
import {
  CatalogSnapshotGetErrorSchema,
  CatalogSnapshotGetParamsSchema,
  CatalogSnapshotGetResultSchema,
} from './snapshot';

export const CATALOG_GRANTS = {
  read: 'core.catalog.read',
  write: 'core.catalog.write',
} as const;

const IdSchema = z.string().min(1).max(512);

const SELECTION_CODES = [
  'core.catalog.selection.invalidState',
  'core.catalog.selection.revisionConflict',
  'core.catalog.selection.notFound',
] as const;

export const CatalogSelectionGetParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema,
  targetId: z.string().nullable().optional(),
});

export const CatalogSelectionGetResultSchema = z
  .object({
    /**
     * An opaque tag. A chat's changes whenever its selection, its capability
     * state counter or its workspace defaults' counter does; compare it for
     * equality only, never order by it.
     */
    revision: z.number().int().min(0),
    selectedItemIds: z.array(IdSchema),
    unavailableItemIds: z.array(IdSchema),
  })
  .catchall(CanopyJsonValueSchema);

export const CatalogSelectionGetErrorSchema =
  inherentOperationErrorSchema(SELECTION_CODES);

export const CatalogSelectionUpdateParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema,
  /** The revision the caller read; any other refuses the write. */
  expectedRevision: z.number().int().min(0),
  selectedItemIds: z.array(IdSchema).max(1024),
  targetId: z.string().nullable().optional(),
  _meta: CanopyRequestMetadataSchema.extend({
    idempotencyKey: IdSchema,
  }),
});

/** The worker materialization a selection change scheduled. */
const CatalogMaterializationOperationSchema = z
  .object({
    operationId: IdSchema,
    kind: OperationKindSchema,
    status: OperationStatusSchema,
    authorityId: z.string().max(512).nullable().optional(),
    executionTargetId: z.string().max(512).nullable().optional(),
    runtimeDelegationId: z.string().max(512).nullable().optional(),
    parentOperationId: z.string().max(512).nullable().optional(),
  })
  .catchall(CanopyJsonValueSchema);

export const CatalogSelectionUpdateResultSchema = z
  .object({
    revision: z.number().int().min(0),
    selectedItemIds: z.array(IdSchema),
    /** Null while no materialization is scheduled. */
    materializationOperation: CatalogMaterializationOperationSchema.nullable(),
  })
  .catchall(CanopyJsonValueSchema);

export const CatalogSelectionUpdateErrorSchema =
  keyedOperationErrorSchema(SELECTION_CODES);

/** The catalog write the web core serves (CAN-4161); outside the registries too. */
export const CORE_CATALOG_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.catalog.selection.update': defineCanopyInstruction({
      plane: 'core',
      domain: 'catalog',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: [CATALOG_GRANTS.write],
      params: CatalogSelectionUpdateParamsSchema,
      result: CatalogSelectionUpdateResultSchema,
      error: CatalogSelectionUpdateErrorSchema,
    }),
  });

/**
 * Catalog reads. Kept out of `CORE_QUERY_DEFINITIONS`: the desktop dispatcher
 * requires a handler for every definition there, and only the web core serves
 * these so far (CAN-4161).
 */
export const CORE_CATALOG_QUERY_DEFINITIONS = defineCanopyQueryRegistry(
  'core',
  {
    'core.catalog.snapshot.get': defineCanopyQuery({
      plane: 'core',
      domain: 'catalog',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: [CATALOG_GRANTS.read],
      params: CatalogSnapshotGetParamsSchema,
      result: CatalogSnapshotGetResultSchema,
      error: CatalogSnapshotGetErrorSchema,
    }),
    'core.catalog.selection.get': defineCanopyQuery({
      plane: 'core',
      domain: 'catalog',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: [CATALOG_GRANTS.read],
      params: CatalogSelectionGetParamsSchema,
      result: CatalogSelectionGetResultSchema,
      error: CatalogSelectionGetErrorSchema,
    }),
  },
);
