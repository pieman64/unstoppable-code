import { z } from 'zod';

import {
  CanopyQueryRequestMetadataSchema,
  CanopyRequestMetadataSchema,
  CanopyWorkspaceScopeSchema,
} from '../../common';
import {
  PIPELINE_DEFINITION_SOURCES,
  PipelineRunOwnerSchema,
} from '../../pipeline-values';

export { PIPELINE_DEFINITION_SOURCES, PipelineRunOwnerSchema };

export const PIPELINE_DEFINITION_FORMATS = ['yaml', 'json'] as const;

/** Execution contexts a definition declares it can run in. */
export const PIPELINE_DEFINITION_EXECUTION_SCOPES = [
  'global',
  'directory',
  'worktree',
] as const;

export const PIPELINE_DEFINITION_TRIGGER_TYPES = [
  'dispatch',
  'plan_ready',
  'task_ready',
] as const;

/** One mebibyte, the largest document a definition operation accepts. */
export const PIPELINE_DEFINITION_DOCUMENT_MAX_LENGTH = 1_048_576;
export const PIPELINE_DEFINITION_LIST_MAX_LIMIT = 500;
export const PIPELINE_DEFINITION_LIST_DEFAULT_LIMIT = 100;

const id = z.string().min(1).max(512);
const timestamp = z.iso.datetime({ offset: true });

/** `personal`, or `org:<uuid>`: a serialized workspace context. */
export const PipelineDefinitionOwnerSchema = z
  .string()
  .regex(
    /^(personal|org:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
  );

export const PipelineDefinitionSourceSchema = z.enum(
  PIPELINE_DEFINITION_SOURCES,
);
export const PipelineDefinitionFormatSchema = z.enum(
  PIPELINE_DEFINITION_FORMATS,
);

/** A YAML or JSON document as text, or its already parsed object. */
export const PipelineDefinitionDocumentSchema = z.union([
  z.string().max(PIPELINE_DEFINITION_DOCUMENT_MAX_LENGTH),
  z.record(z.string(), z.unknown()),
]);

export const PipelineDefinitionDiagnosticSchema = z.looseObject({
  severity: z.enum(['error', 'warning', 'info']),
  code: id,
  message: z.string().max(8_192),
  path: z.string().max(2_048).optional(),
  line: z.number().int().min(1).optional(),
  column: z.number().int().min(1).optional(),
});

export const PipelineDefinitionSummarySchema = z.looseObject({
  definitionId: id,
  scope: CanopyWorkspaceScopeSchema,
  source: PipelineDefinitionSourceSchema,
  owner: PipelineDefinitionOwnerSchema.nullable(),
  // Display fields come from stored documents, which bound their size.
  name: z.string(),
  description: z.string(),
  icon: z.string(),
  enabled: z.boolean(),
  readonly: z.boolean(),
  format: PipelineDefinitionFormatSchema,
  revision: z.number().int().min(0),
  /** `null` in a listing whose source did not read the document. */
  checksum: id.nullable(),
  triggerTypes: z.array(z.enum(PIPELINE_DEFINITION_TRIGGER_TYPES)),
  executionScopes: z.array(z.enum(PIPELINE_DEFINITION_EXECUTION_SCOPES)),
  createdAt: timestamp.nullable(),
  updatedAt: timestamp.nullable(),
});

export const PipelineDefinitionSchema = PipelineDefinitionSummarySchema.extend({
  checksum: id,
  document: z.string().max(PIPELINE_DEFINITION_DOCUMENT_MAX_LENGTH),
  normalized: z.record(z.string(), z.unknown()).nullable(),
  diagnostics: z.array(PipelineDefinitionDiagnosticSchema),
});

export const PipelineDefinitionListParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema.optional(),
  query: z.string().max(1_024).optional(),
  cursor: z.string().max(2_048).optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(PIPELINE_DEFINITION_LIST_MAX_LIMIT)
    .optional(),
  sources: z.array(PipelineDefinitionSourceSchema).optional(),
  enabled: z.boolean().optional(),
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});

export const PipelineDefinitionListResultSchema = z.looseObject({
  items: z.array(PipelineDefinitionSummarySchema),
  nextCursor: z.string().max(2_048).nullable(),
  /** Sources that could not be read; their rows are missing from `items`. */
  unavailableSources: z.array(PipelineDefinitionSourceSchema),
});

export const PipelineDefinitionGetParamsSchema = z.strictObject({
  definitionId: id,
  scope: CanopyWorkspaceScopeSchema.optional(),
  /**
   * Read the definition as this run owner may use it, instead of through the
   * selected navigation context. Only callers holding
   * `core.pipeline.ownerRead` may send it.
   */
  owner: PipelineRunOwnerSchema.optional(),
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});

export const PipelineDefinitionGetResultSchema = z.looseObject({
  definition: PipelineDefinitionSchema,
});

export const PipelineDefinitionValidateParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema,
  targetId: id.nullable(),
  format: PipelineDefinitionFormatSchema,
  document: PipelineDefinitionDocumentSchema,
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});

export const PipelineDefinitionValidateResultSchema = z.looseObject({
  valid: z.boolean(),
  normalized: z.record(z.string(), z.unknown()).nullable(),
  diagnostics: z.array(PipelineDefinitionDiagnosticSchema),
});

/** Writes replay only with their idempotency key. */
export const PipelineDefinitionKeyedRequestMetadataSchema =
  CanopyRequestMetadataSchema.required({ idempotencyKey: true });

/** The only source a definition write reaches today. */
export const PIPELINE_DEFINITION_WRITABLE_SOURCES = ['user'] as const;

export const PipelineDefinitionUpsertParamsSchema = z.strictObject({
  /** `null` creates a definition with a new id. */
  definitionId: id.nullable(),
  /**
   * The revision the caller read. A different stored revision refuses the
   * write; `null` writes without a precondition.
   */
  expectedRevision: z.number().int().min(0).nullable(),
  scope: CanopyWorkspaceScopeSchema,
  source: z.enum(PIPELINE_DEFINITION_WRITABLE_SOURCES),
  // As in summaries, the document's size bounds its display fields.
  name: z.string(),
  description: z.string().optional(),
  icon: z.string().optional(),
  /** Omitted keeps a definition's state; a new definition is enabled. */
  enabled: z.boolean().optional(),
  format: PipelineDefinitionFormatSchema,
  document: PipelineDefinitionDocumentSchema,
  _meta: PipelineDefinitionKeyedRequestMetadataSchema,
});

export const PipelineDefinitionUpsertResultSchema = z.looseObject({
  definition: PipelineDefinitionSchema,
});

export const PipelineDefinitionDeleteParamsSchema = z.strictObject({
  definitionId: id,
  /** As in upsert: `null` deletes without a precondition. */
  expectedRevision: z.number().int().min(0).nullable(),
  _meta: PipelineDefinitionKeyedRequestMetadataSchema,
});

export const PipelineDefinitionDeleteResultSchema = z.looseObject({
  definitionId: id,
  deleted: z.literal(true),
  /** The revision the deleted definition had. */
  revision: z.number().int().min(0),
});

/**
 * A copy of any readable definition as a new user definition, under an id
 * core assigns.
 */
export const PipelineDefinitionDuplicateParamsSchema = z.strictObject({
  sourceDefinitionId: id,
  /** Resolves a project source; the copy itself is unscoped. */
  scope: CanopyWorkspaceScopeSchema,
  /** The copy's name; omitted names it after its source with " (Copy)". */
  name: z.string().min(1).optional(),
  /**
   * The source checksum the caller checked; a source that changed since is
   * refused with `revisionConflict` rather than copied.
   */
  expectedChecksum: id.optional(),
  _meta: PipelineDefinitionKeyedRequestMetadataSchema,
});

export const PipelineDefinitionDuplicateResultSchema = z.looseObject({
  definition: PipelineDefinitionSchema,
  sourceDefinitionId: id,
});

/** Records whether a definition of any source, read-only ones included, is enabled. */
export const PipelineDefinitionSetEnabledParamsSchema = z.strictObject({
  definitionId: id,
  enabled: z.boolean(),
  _meta: PipelineDefinitionKeyedRequestMetadataSchema,
});

export const PipelineDefinitionSetEnabledResultSchema = z.looseObject({
  definitionId: id,
  enabled: z.boolean(),
});

export type PipelineDefinitionSource = z.output<
  typeof PipelineDefinitionSourceSchema
>;
export type PipelineDefinitionFormat = z.output<
  typeof PipelineDefinitionFormatSchema
>;
export type PipelineDefinitionDocument = z.output<
  typeof PipelineDefinitionDocumentSchema
>;
export type PipelineDefinitionDiagnostic = z.output<
  typeof PipelineDefinitionDiagnosticSchema
>;
export type PipelineDefinitionSummary = z.output<
  typeof PipelineDefinitionSummarySchema
>;
export type PipelineDefinition = z.output<typeof PipelineDefinitionSchema>;
export type PipelineDefinitionListParams = z.output<
  typeof PipelineDefinitionListParamsSchema
>;
export type PipelineDefinitionListResult = z.output<
  typeof PipelineDefinitionListResultSchema
>;
export type PipelineDefinitionGetParams = z.output<
  typeof PipelineDefinitionGetParamsSchema
>;
export type PipelineDefinitionGetResult = z.output<
  typeof PipelineDefinitionGetResultSchema
>;
export type PipelineDefinitionValidateParams = z.output<
  typeof PipelineDefinitionValidateParamsSchema
>;
export type PipelineDefinitionValidateResult = z.output<
  typeof PipelineDefinitionValidateResultSchema
>;
export type PipelineDefinitionUpsertParams = z.output<
  typeof PipelineDefinitionUpsertParamsSchema
>;
export type PipelineDefinitionUpsertResult = z.output<
  typeof PipelineDefinitionUpsertResultSchema
>;
export type PipelineDefinitionDeleteParams = z.output<
  typeof PipelineDefinitionDeleteParamsSchema
>;
export type PipelineDefinitionDeleteResult = z.output<
  typeof PipelineDefinitionDeleteResultSchema
>;
export type PipelineDefinitionDuplicateParams = z.output<
  typeof PipelineDefinitionDuplicateParamsSchema
>;
export type PipelineDefinitionDuplicateResult = z.output<
  typeof PipelineDefinitionDuplicateResultSchema
>;
export type PipelineDefinitionSetEnabledParams = z.output<
  typeof PipelineDefinitionSetEnabledParamsSchema
>;
export type PipelineDefinitionSetEnabledResult = z.output<
  typeof PipelineDefinitionSetEnabledResultSchema
>;
