import { z } from 'zod';

import {
  CanopyErrorKindSchema,
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

/*
 * `core.workspace.item.*`: notes, prompts and attachments owned by a
 * workspace or worktree. CAN-4105 serves kind `attachment` and the import;
 * CAN-4152 adds `note` and `prompt` (and `upsert`/`delete`) to the same get
 * and list definitions, so these schemas are shared by every kind.
 */

const id = z.string().min(1).max(512);
const timestamp = z.iso.datetime({ offset: true });
/** The item, workspace, worktree and cursor ID schema every item operation uses. */
export const CoreWorkspaceItemIdSchema = id;
/** RFC 3339 with an offset, as item `createdAt` and `updatedAt` require. */
export const CoreWorkspaceItemTimestampSchema = timestamp;

export const CORE_WORKSPACE_ITEM_GRANTS = {
  read: 'core.workspace.read',
  write: 'core.workspace.write',
} as const;

export const CORE_WORKSPACE_ITEM_KINDS = [
  'note',
  'prompt',
  'attachment',
] as const;
export const CoreWorkspaceItemKindSchema = z.enum(CORE_WORKSPACE_ITEM_KINDS);
export type CoreWorkspaceItemKind = z.output<
  typeof CoreWorkspaceItemKindSchema
>;

export const CORE_WORKSPACE_ITEM_LIST_MAX_LIMIT = 500;
export const CORE_WORKSPACE_ITEM_IMPORT_MAX_SOURCES = 100;
export const CORE_WORKSPACE_ITEM_SOURCE_HANDLE_PATTERN = /^h-[0-9a-f]{32}$/;

/** Codes shared by every kind's get and list. */
export const CORE_WORKSPACE_ITEM_READ_ERROR_CODES = [
  'core.workspace.item.invalidScope',
  'core.workspace.item.invalidItemId',
  'core.workspace.item.invalidCursor',
  'core.workspace.item.notFound',
  'core.workspace.item.kindUnavailable',
  'core.workspace.item.scopeUnavailable',
] as const;

/** Codes of one import source that failed; the call itself succeeds. */
export const CORE_WORKSPACE_ITEM_SOURCE_ERROR_CODES = [
  'core.workspace.item.invalidItemId',
  'core.workspace.item.kindUnavailable',
  'core.workspace.item.sourceNotFound',
  'core.workspace.item.sourceNotFile',
  'core.workspace.item.sourceAccessDenied',
  'core.workspace.item.filenameInvalid',
  'core.workspace.item.writeFailed',
] as const;

export const CORE_WORKSPACE_ITEM_IMPORT_ERROR_CODES = [
  'core.workspace.item.invalidScope',
  'core.workspace.item.readOnlyScope',
  'core.workspace.item.unsupportedScope',
  'core.workspace.item.idempotencyKeyReused',
] as const;

/** Codes of a note or prompt `delete`. */
export const CORE_WORKSPACE_ITEM_DELETE_ERROR_CODES = [
  'core.workspace.item.invalidScope',
  'core.workspace.item.invalidItemId',
  'core.workspace.item.notFound',
  'core.workspace.item.kindUnavailable',
  'core.workspace.item.readOnlyScope',
  'core.workspace.item.revisionConflict',
  'core.workspace.item.idempotencyKeyReused',
] as const;

/** Codes of a note or prompt `upsert`. */
export const CORE_WORKSPACE_ITEM_UPSERT_ERROR_CODES = [
  'core.workspace.item.invalidScope',
  'core.workspace.item.invalidItemId',
  'core.workspace.item.notFound',
  'core.workspace.item.kindUnavailable',
  'core.workspace.item.readOnlyScope',
  'core.workspace.item.unsupportedScope',
  'core.workspace.item.revisionConflict',
  'core.workspace.item.idempotencyKeyReused',
] as const;

/** `after_refresh` resource of a `core.workspace.item.revisionConflict`. */
export const CORE_WORKSPACE_ITEM_RESOURCE = 'core.workspace.item';

export type CoreWorkspaceItemReadErrorCode =
  (typeof CORE_WORKSPACE_ITEM_READ_ERROR_CODES)[number];
export type CoreWorkspaceItemUpsertErrorCode =
  (typeof CORE_WORKSPACE_ITEM_UPSERT_ERROR_CODES)[number];
export type CoreWorkspaceItemDeleteErrorCode =
  (typeof CORE_WORKSPACE_ITEM_DELETE_ERROR_CODES)[number];
export type CoreWorkspaceItemSourceErrorCode =
  (typeof CORE_WORKSPACE_ITEM_SOURCE_ERROR_CODES)[number];
export type CoreWorkspaceItemImportErrorCode =
  (typeof CORE_WORKSPACE_ITEM_IMPORT_ERROR_CODES)[number];

export const CoreWorkspaceItemSchema = z.strictObject({
  itemId: id,
  workspaceId: id,
  worktreeId: id.nullable(),
  kind: CoreWorkspaceItemKindSchema,
  title: z.string().min(1).max(512),
  content: z.string().max(2_000_000).nullable(),
  artifactId: id.nullable(),
  mediaType: z.string().max(255).nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  origin: z.strictObject({
    worktreeId: id.optional(),
    branchName: z.string().max(512).optional(),
    worktreeExists: z.boolean().optional(),
  }),
  revision: z.number().int().nonnegative(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type CoreWorkspaceItem = z.output<typeof CoreWorkspaceItemSchema>;

export const CoreWorkspaceItemGetParamsSchema = z.strictObject({
  itemId: id,
});

export const CoreWorkspaceItemListParamsSchema = z.strictObject({
  workspaceId: id,
  worktreeId: id.nullable(),
  kinds: z.array(CoreWorkspaceItemKindSchema),
  cursor: id.nullable(),
  limit: z.number().int().min(1).max(CORE_WORKSPACE_ITEM_LIST_MAX_LIMIT),
});

export const CoreWorkspaceItemListResultSchema = z.strictObject({
  items: z.array(CoreWorkspaceItemSchema),
  nextCursor: id.nullable(),
});

/**
 * An opaque host handle that only the issuing host resolves during the call
 * it was issued for, or an existing item to copy.
 */
export const CoreWorkspaceItemImportSourceSchema = z.discriminatedUnion(
  'kind',
  [
    z.strictObject({
      kind: z.literal('host'),
      handle: z.string().regex(CORE_WORKSPACE_ITEM_SOURCE_HANDLE_PATTERN),
    }),
    z.strictObject({ kind: z.literal('item'), itemId: id }),
  ],
);
export type CoreWorkspaceItemImportSource = z.output<
  typeof CoreWorkspaceItemImportSourceSchema
>;

export const CoreWorkspaceItemImportParamsSchema = z.strictObject({
  workspaceId: id,
  worktreeId: id.nullable(),
  kind: z.literal('attachment'),
  sources: z
    .array(CoreWorkspaceItemImportSourceSchema)
    .min(1)
    .max(CORE_WORKSPACE_ITEM_IMPORT_MAX_SOURCES),
});

export const CoreWorkspaceItemSourceErrorSchema = z.strictObject({
  kind: CanopyErrorKindSchema,
  code: z.enum(CORE_WORKSPACE_ITEM_SOURCE_ERROR_CODES),
  message: z.string().min(1).max(2_048),
});
export type CoreWorkspaceItemSourceError = z.output<
  typeof CoreWorkspaceItemSourceErrorSchema
>;

export const CoreWorkspaceItemImportOutcomeSchema = z.discriminatedUnion(
  'status',
  [
    z.strictObject({
      status: z.literal('imported'),
      item: CoreWorkspaceItemSchema,
    }),
    z.strictObject({
      status: z.literal('failed'),
      error: CoreWorkspaceItemSourceErrorSchema,
    }),
    z.strictObject({ status: z.literal('notAttempted') }),
  ],
);
export type CoreWorkspaceItemImportOutcome = z.output<
  typeof CoreWorkspaceItemImportOutcomeSchema
>;

export const CoreWorkspaceItemImportResultSchema = z.strictObject({
  outcomes: z
    .array(CoreWorkspaceItemImportOutcomeSchema)
    .max(CORE_WORKSPACE_ITEM_IMPORT_MAX_SOURCES),
});

export const CoreWorkspaceItemUpsertParamsSchema = z.strictObject({
  itemId: id.nullable(),
  workspaceId: id,
  worktreeId: id.nullable(),
  kind: CoreWorkspaceItemKindSchema,
  title: CoreWorkspaceItemSchema.shape.title,
  content: CoreWorkspaceItemSchema.shape.content,
  artifactId: id.nullable(),
  expectedRevision: z.number().int().nonnegative().nullable(),
  originWorktreeId: id.nullable(),
});

export const CoreWorkspaceItemDeleteParamsSchema = z.strictObject({
  itemId: id,
  expectedRevision: z.number().int().nonnegative(),
});

export const CoreWorkspaceItemDeleteResultSchema = z.strictObject({
  deleted: z.literal(true),
});

export const CoreWorkspaceItemUpsertErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z.enum(CORE_WORKSPACE_ITEM_UPSERT_ERROR_CODES).optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  });

export const CoreWorkspaceItemDeleteErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z.enum(CORE_WORKSPACE_ITEM_DELETE_ERROR_CODES).optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  });

export type CoreWorkspaceItemUpsertParams = z.output<
  typeof CoreWorkspaceItemUpsertParamsSchema
>;
export type CoreWorkspaceItemDeleteParams = z.output<
  typeof CoreWorkspaceItemDeleteParamsSchema
>;
export type CoreWorkspaceItemDeleteResult = z.output<
  typeof CoreWorkspaceItemDeleteResultSchema
>;

export const CoreWorkspaceItemReadErrorSchema = CanopyErrorPayloadSchema.extend(
  {
    code: z.enum(CORE_WORKSPACE_ITEM_READ_ERROR_CODES).optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  },
);

export const CoreWorkspaceItemImportErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z.enum(CORE_WORKSPACE_ITEM_IMPORT_ERROR_CODES).optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  });

export type CoreWorkspaceItemGetParams = z.output<
  typeof CoreWorkspaceItemGetParamsSchema
>;
export type CoreWorkspaceItemListParams = z.output<
  typeof CoreWorkspaceItemListParamsSchema
>;
export type CoreWorkspaceItemListResult = z.output<
  typeof CoreWorkspaceItemListResultSchema
>;
export type CoreWorkspaceItemImportParams = z.output<
  typeof CoreWorkspaceItemImportParamsSchema
>;
export type CoreWorkspaceItemImportResult = z.output<
  typeof CoreWorkspaceItemImportResultSchema
>;

export const CORE_WORKSPACE_ITEM_QUERIES = defineCanopyQueryRegistry('core', {
  'core.workspace.item.get': defineCanopyQuery({
    plane: 'core',
    domain: 'workspace',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: [CORE_WORKSPACE_ITEM_GRANTS.read],
    params: CoreWorkspaceItemGetParamsSchema,
    result: CoreWorkspaceItemSchema,
    error: CoreWorkspaceItemReadErrorSchema,
  }),
  'core.workspace.item.list': defineCanopyQuery({
    plane: 'core',
    domain: 'workspace',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: [CORE_WORKSPACE_ITEM_GRANTS.read],
    params: CoreWorkspaceItemListParamsSchema,
    result: CoreWorkspaceItemListResultSchema,
    error: CoreWorkspaceItemReadErrorSchema,
  }),
});

export const CORE_WORKSPACE_ITEM_INSTRUCTIONS = defineCanopyInstructionRegistry(
  'core',
  {
    'core.workspace.item.import': defineCanopyInstruction({
      plane: 'core',
      domain: 'workspace',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: [CORE_WORKSPACE_ITEM_GRANTS.write],
      params: CoreWorkspaceItemImportParamsSchema,
      result: CoreWorkspaceItemImportResultSchema,
      error: CoreWorkspaceItemImportErrorSchema,
    }),
    'core.workspace.item.upsert': defineCanopyInstruction({
      plane: 'core',
      domain: 'workspace',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: [CORE_WORKSPACE_ITEM_GRANTS.write],
      params: CoreWorkspaceItemUpsertParamsSchema,
      result: CoreWorkspaceItemSchema,
      error: CoreWorkspaceItemUpsertErrorSchema,
    }),
    'core.workspace.item.delete': defineCanopyInstruction({
      plane: 'core',
      domain: 'workspace',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: [CORE_WORKSPACE_ITEM_GRANTS.write],
      params: CoreWorkspaceItemDeleteParamsSchema,
      result: CoreWorkspaceItemDeleteResultSchema,
      error: CoreWorkspaceItemDeleteErrorSchema,
    }),
  },
);
