import { z } from 'zod';

import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
} from '../../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyJsonValueSchema,
  CanopyKeyedRetryDirectiveSchema,
} from '../../errors';

/*
 * The W5 workspace metadata commands the desktop core owns (W7a, CAN-5523):
 * #4 reorder, #6 scripts, #8 plan detection, #10 private memory, and #13 and
 * #14 repository add and remove. #3 `core.workspace.update` is web-owned
 * (`commands.ts`, CAN-4158). The typed in-process commands are
 * `@canopy/core-runtime/node/w5/workspace-metadata/*` (CAN-5520).
 *
 * Kept out of the composed CORE_INSTRUCTION_DEFINITIONS, as the web-only and
 * qualification-only sets are, because the daemon dispatcher requires a
 * handler for every definition it is given and none is registered yet
 * (W7a-2, W7a-3). The web core never serves them: W5 files are host-local.
 *
 * Params never carry `source`, `scope` or a host path: the caller's source and
 * receipt scope are derived from the trusted caller, a repository is named by
 * an opaque selection, and results are path-free.
 */

export const CORE_WORKSPACE_METADATA_GRANTS = {
  write: 'core.workspace.write',
} as const;

// The desktop `validateId` charset (`@canopy/core-runtime/node/identifiers`),
// capped at the #6 page's 512.
const slug = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[a-z0-9][a-z0-9-]*$/);
const revision = z.int().nonnegative();
const scriptName = z.string().min(1).max(512);
// Property names carry bounds but no type in the #6 page's `propertyNames`.
const scriptMapKey = scriptName.meta({ type: undefined });

const errorCode = {
  notFound: 'core.workspace.notFound',
  readOnly: 'core.workspace.readOnly',
  configurationUnavailable: 'core.workspace.configurationUnavailable',
  repositoryNotFound: 'core.workspace.repositoryNotFound',
  invalidState: 'core.workspace.invalidState',
  revisionConflict: 'core.workspace.revisionConflict',
  idempotencyKeyReused: 'core.workspace.idempotencyKeyReused',
  requestInProgress: 'core.workspace.requestInProgress',
  recoveryRequired: 'core.workspace.recoveryRequired',
  outcomeExpired: 'core.workspace.outcomeExpired',
} as const;

// Every keyed W5 command reports these, last in each operation's enum.
const KEYED_CODES = [
  errorCode.revisionConflict,
  errorCode.idempotencyKeyReused,
  errorCode.requestInProgress,
  errorCode.recoveryRequired,
  errorCode.outcomeExpired,
] as const;

/** Each operation's `data.code` enum, in page order. */
export const CORE_WORKSPACE_METADATA_ERROR_CODES = {
  'core.workspace.reorder': [
    errorCode.notFound,
    errorCode.invalidState,
    ...KEYED_CODES,
  ],
  // The #6 page's enum, which governs #6 and #8 (first-come).
  'core.workspace.scripts.update': [
    errorCode.readOnly,
    errorCode.configurationUnavailable,
    errorCode.repositoryNotFound,
    ...KEYED_CODES,
  ],
  'core.workspace.planDetection.update': [
    errorCode.readOnly,
    errorCode.configurationUnavailable,
    ...KEYED_CODES,
  ],
  'core.workspace.privateMemory.update': [
    errorCode.notFound,
    errorCode.configurationUnavailable,
    errorCode.invalidState,
    ...KEYED_CODES,
  ],
  'core.workspace.repository.add': [
    errorCode.notFound,
    errorCode.configurationUnavailable,
    errorCode.invalidState,
    ...KEYED_CODES,
  ],
  'core.workspace.repository.remove': [
    errorCode.notFound,
    errorCode.configurationUnavailable,
    ...KEYED_CODES,
  ],
} as const;

export type CoreWorkspaceMetadataOperation =
  keyof typeof CORE_WORKSPACE_METADATA_ERROR_CODES;

type WorkspaceErrorCode = `core.workspace.${string}`;

function metadataError<
  const Codes extends readonly [WorkspaceErrorCode, ...WorkspaceErrorCode[]],
>(codes: Codes): z.ZodType<z.output<typeof CanopyErrorPayloadSchema>> {
  return CanopyErrorPayloadSchema.extend({
    code: z.enum(codes).optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  });
}

// ---------------------------------------------------------------------------
// #4 core.workspace.reorder
// ---------------------------------------------------------------------------

export const CORE_WORKSPACE_REORDER_MAX_VISIBLE = 4096;

export const CoreWorkspaceReorderParamsSchema = z.strictObject({
  /** The workspaces the caller shows, in any order; only their slots move. */
  visibleWorkspaceIds: z
    .array(slug)
    .min(1)
    .max(CORE_WORKSPACE_REORDER_MAX_VISIBLE),
  activeWorkspaceId: slug,
  overWorkspaceId: slug,
  /** The workspaces collection revision (`workspaces`). */
  expectedRevision: revision.optional(),
});
export type CoreWorkspaceReorderParams = z.output<
  typeof CoreWorkspaceReorderParamsSchema
>;

/** A17(a): the move is acknowledged; read the order with `core.workspace.list`. */
export const CoreWorkspaceReorderResultSchema = z.strictObject({
  acknowledged: z.literal(true),
});
export type CoreWorkspaceReorderResult = z.output<
  typeof CoreWorkspaceReorderResultSchema
>;

// ---------------------------------------------------------------------------
// #6 core.workspace.scripts.update (conforms to its page)
// ---------------------------------------------------------------------------

const devServerPatternEntry = z.union([
  z.string().min(1),
  z.strictObject({
    pattern: z.string().min(1),
    label: z.string().optional(),
    openTarget: z.enum(['in-app', 'external']).optional(),
    autoOpen: z.boolean().optional(),
  }),
]);

/** A command, a script definition, or `null`, which disables a script. */
export const CoreWorkspaceScriptValueSchema = z.union([
  z.string(),
  z.null(),
  z.strictObject({
    command: z.string(),
    interactive: z.boolean().optional(),
    timeoutSeconds: z.int().min(1).max(2_000_000).nullable().optional(),
    devServerPattern: z
      .union([devServerPatternEntry, z.array(devServerPatternEntry)])
      .optional(),
    shell: z
      .strictObject({
        windows: z.enum(['cmd', 'powershell', 'bash']).optional(),
        mac: z.enum(['zsh', 'bash']).optional(),
        linux: z.enum(['bash', 'zsh']).optional(),
      })
      .optional(),
  }),
]);

const scriptMap = z.record(scriptMapKey, CoreWorkspaceScriptValueSchema);

export const CoreWorkspaceScriptsChangeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('replace'),
    scripts: scriptMap.optional(),
  }),
  z.strictObject({
    kind: z.literal('merge-commands'),
    commands: z.record(scriptMapKey, z.string()),
  }),
  z.strictObject({
    kind: z.literal('repositories'),
    repos: z.array(
      z.strictObject({ repoId: slug, scripts: scriptMap.optional() }),
    ),
  }),
  z.strictObject({
    kind: z.literal('definition'),
    repoId: slug.optional(),
    name: scriptName,
    value: CoreWorkspaceScriptValueSchema,
  }),
  z.strictObject({
    kind: z.literal('remove-definition'),
    repoId: slug.optional(),
    name: scriptName,
  }),
]);
export type CoreWorkspaceScriptsChange = z.output<
  typeof CoreWorkspaceScriptsChangeSchema
>;

export const CoreWorkspaceScriptsUpdateParamsSchema = z.strictObject({
  workspaceId: slug,
  /** The workspace revision (`workspace:{id}`). */
  expectedRevision: revision.optional(),
  change: CoreWorkspaceScriptsChangeSchema,
});
export type CoreWorkspaceScriptsUpdateParams = z.output<
  typeof CoreWorkspaceScriptsUpdateParamsSchema
>;

/**
 * #6's result. Version 1 returns no fields, but its first-come page allows
 * additive fields; read the new revision with `core.workspace.get`.
 */
export const CoreWorkspaceScriptsUpdateResultSchema = z
  .object({})
  .catchall(CanopyJsonValueSchema);
export type CoreWorkspaceScriptsUpdateResult = z.output<
  typeof CoreWorkspaceScriptsUpdateResultSchema
>;

// ---------------------------------------------------------------------------
// #8 core.workspace.planDetection.update
// ---------------------------------------------------------------------------

export const CORE_WORKSPACE_PLAN_DETECTION_LIMITS = {
  rules: 1000,
  idLength: 512,
  // The rules editor defaults a label to its pattern.
  labelLength: 4096,
  patternLength: 4096,
} as const;

/** `@canopy/protocol/plan-detection`'s `PlanDetectionRule`, closed. */
export const CoreWorkspacePlanDetectionRuleSchema = z.strictObject({
  id: z.string().min(1).max(CORE_WORKSPACE_PLAN_DETECTION_LIMITS.idLength),
  label: z.string().max(CORE_WORKSPACE_PLAN_DETECTION_LIMITS.labelLength),
  kind: z.enum(['include', 'exclude']),
  pattern: z
    .string()
    .min(1)
    .max(CORE_WORKSPACE_PLAN_DETECTION_LIMITS.patternLength),
  enabled: z.boolean(),
});

/** `WorkspacePlanDetectionConfig`, closed; an empty one clears the setting. */
export const CoreWorkspacePlanDetectionSchema = z.strictObject({
  disabledRuleIds: z
    .array(z.string().min(1).max(CORE_WORKSPACE_PLAN_DETECTION_LIMITS.idLength))
    .max(CORE_WORKSPACE_PLAN_DETECTION_LIMITS.rules)
    .optional(),
  customRules: z
    .array(CoreWorkspacePlanDetectionRuleSchema)
    .max(CORE_WORKSPACE_PLAN_DETECTION_LIMITS.rules)
    .optional(),
});
export type CoreWorkspacePlanDetection = z.output<
  typeof CoreWorkspacePlanDetectionSchema
>;

export const CoreWorkspacePlanDetectionUpdateParamsSchema = z.strictObject({
  workspaceId: slug,
  /** The workspace revision (`workspace:{id}`). */
  expectedRevision: revision.optional(),
  planDetection: CoreWorkspacePlanDetectionSchema,
});
export type CoreWorkspacePlanDetectionUpdateParams = z.output<
  typeof CoreWorkspacePlanDetectionUpdateParamsSchema
>;

/**
 * Closed and empty; read the new revision with `core.workspace.get`. Unlike
 * the first-come #6 result, it gains fields only in a new schema revision.
 */
export const CoreWorkspacePlanDetectionUpdateResultSchema = z.strictObject({});
export type CoreWorkspacePlanDetectionUpdateResult = z.output<
  typeof CoreWorkspacePlanDetectionUpdateResultSchema
>;

// ---------------------------------------------------------------------------
// #10 core.workspace.privateMemory.update
// ---------------------------------------------------------------------------

/** The desktop's standalone chat sentinel, which IPC resolves first. */
export const CORE_WORKSPACE_STANDALONE_CHAT_ID = 'standalone-chat';

const resolvedWorkspaceId = slug
  .refine(
    (id) => id !== CORE_WORKSPACE_STANDALONE_CHAT_ID,
    'Expected a workspace, not the standalone chat sentinel',
  )
  .meta({ not: { const: CORE_WORKSPACE_STANDALONE_CHAT_ID } });

export const CoreWorkspacePrivateMemoryUpdateParamsSchema = z.strictObject({
  workspaceId: resolvedWorkspaceId,
  privateMemory: z.boolean(),
  /** The workspace revision (`workspace:{id}`). */
  expectedRevision: revision.optional(),
});
export type CoreWorkspacePrivateMemoryUpdateParams = z.output<
  typeof CoreWorkspacePrivateMemoryUpdateParamsSchema
>;

export const CoreWorkspacePrivateMemoryUpdateResultSchema = z.strictObject({
  workspaceId: slug,
  privateMemory: z.boolean(),
});
export type CoreWorkspacePrivateMemoryUpdateResult = z.output<
  typeof CoreWorkspacePrivateMemoryUpdateResultSchema
>;

// ---------------------------------------------------------------------------
// #13 and #14 core.workspace.repository.add and .remove
// ---------------------------------------------------------------------------

/**
 * An opaque native-picker selection minted for the authenticated local
 * binding, as `core.workspace.import` takes one. Never a host path.
 */
export const CoreWorkspaceRepositorySelectionSchema = z.strictObject({
  kind: z.literal('local_picker_selection'),
  selectionId: z.string().min(1).max(512),
});

/*
 * 128, not 512: a colliding id gains `uniqueId`'s `-<n>` and a name slugifies
 * to at most twice its length, so the added id stays within the 512-character
 * `repoId` `.repository.remove` takes (as CAN-5522's qualification port caps).
 */
export const CORE_WORKSPACE_NEW_REPOSITORY_MAX = 128;

export const CoreWorkspaceRepositoryAddParamsSchema = z.strictObject({
  workspaceId: slug,
  /** The workspace revision (`workspace:{id}`). */
  expectedRevision: revision.optional(),
  repository: z.strictObject({
    selection: CoreWorkspaceRepositorySelectionSchema,
    /** Derived from the name when omitted; made unique in the workspace. */
    id: slug.max(CORE_WORKSPACE_NEW_REPOSITORY_MAX).optional(),
    /** The folder name when omitted. */
    name: z
      .string()
      .min(1)
      .max(CORE_WORKSPACE_NEW_REPOSITORY_MAX)
      .regex(/\S/)
      .optional(),
  }),
});
export type CoreWorkspaceRepositoryAddParams = z.output<
  typeof CoreWorkspaceRepositoryAddParamsSchema
>;

/**
 * The output shape of the desktop's `sanitizeRemoteUrl`: a URL with a
 * multi-letter non-`file:` scheme, a host and no credentials, query or
 * fragment, or a `git@host:path` remote. Absolute paths, `~/`, drive letters
 * and UNC paths fail. Unlike a length cap, a stored value outside this shape
 * is not a deliverability risk: the host projection omits `manifestUrl`
 * rather than returning it unsanitized.
 */
const remoteManifestUrl = z
  .string()
  .regex(
    /^(?:(?![Ff][Ii][Ll][Ee]:)[A-Za-z][A-Za-z0-9+.-]+:\/\/[^\s/?#@\\]+(?:\/[^\s?#]*)?|git@[^:/\s]+:[^?#\s]+)$/,
  );

/**
 * A member repository, without its host path or scripts. Uncapped: an added
 * id carries a `-<n>` suffix and a removed repository is stored state, and a
 * result is checked only after its decision commits, so a cap could make that
 * decision and every replay of it undeliverable.
 */
export const CoreWorkspaceRepositorySchema = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  source: z.enum(['local', 'manifest']).optional(),
  /** Present only when it is a remote URL; a host-path manifest stays local. */
  manifestUrl: remoteManifestUrl.optional(),
});
export type CoreWorkspaceRepository = z.output<
  typeof CoreWorkspaceRepositorySchema
>;

export const CoreWorkspaceRepositoryAddResultSchema = z.strictObject({
  repository: CoreWorkspaceRepositorySchema,
});
export type CoreWorkspaceRepositoryAddResult = z.output<
  typeof CoreWorkspaceRepositoryAddResultSchema
>;

export const CoreWorkspaceRepositoryRemoveParamsSchema = z.strictObject({
  workspaceId: slug,
  repoId: slug,
  /** The workspace revision (`workspace:{id}`). */
  expectedRevision: revision.optional(),
});
export type CoreWorkspaceRepositoryRemoveParams = z.output<
  typeof CoreWorkspaceRepositoryRemoveParamsSchema
>;

/** `removed` is `null` when the workspace did not have the repository. */
export const CoreWorkspaceRepositoryRemoveResultSchema = z.strictObject({
  removed: CoreWorkspaceRepositorySchema.nullable(),
});
export type CoreWorkspaceRepositoryRemoveResult = z.output<
  typeof CoreWorkspaceRepositoryRemoveResultSchema
>;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const codes = CORE_WORKSPACE_METADATA_ERROR_CODES;

export const CORE_WORKSPACE_METADATA_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.workspace.reorder': defineCanopyInstruction({
      plane: 'core',
      domain: 'workspace',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: [CORE_WORKSPACE_METADATA_GRANTS.write],
      params: CoreWorkspaceReorderParamsSchema,
      result: CoreWorkspaceReorderResultSchema,
      error: metadataError(codes['core.workspace.reorder']),
    }),
    'core.workspace.scripts.update': defineCanopyInstruction({
      plane: 'core',
      domain: 'workspace',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: [CORE_WORKSPACE_METADATA_GRANTS.write],
      params: CoreWorkspaceScriptsUpdateParamsSchema,
      result: CoreWorkspaceScriptsUpdateResultSchema,
      error: metadataError(codes['core.workspace.scripts.update']),
    }),
    'core.workspace.planDetection.update': defineCanopyInstruction({
      plane: 'core',
      domain: 'workspace',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: [CORE_WORKSPACE_METADATA_GRANTS.write],
      params: CoreWorkspacePlanDetectionUpdateParamsSchema,
      result: CoreWorkspacePlanDetectionUpdateResultSchema,
      error: metadataError(codes['core.workspace.planDetection.update']),
    }),
    'core.workspace.privateMemory.update': defineCanopyInstruction({
      plane: 'core',
      domain: 'workspace',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: [CORE_WORKSPACE_METADATA_GRANTS.write],
      params: CoreWorkspacePrivateMemoryUpdateParamsSchema,
      result: CoreWorkspacePrivateMemoryUpdateResultSchema,
      error: metadataError(codes['core.workspace.privateMemory.update']),
    }),
    'core.workspace.repository.add': defineCanopyInstruction({
      plane: 'core',
      domain: 'workspace',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: [CORE_WORKSPACE_METADATA_GRANTS.write],
      params: CoreWorkspaceRepositoryAddParamsSchema,
      result: CoreWorkspaceRepositoryAddResultSchema,
      error: metadataError(codes['core.workspace.repository.add']),
    }),
    'core.workspace.repository.remove': defineCanopyInstruction({
      plane: 'core',
      domain: 'workspace',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: [CORE_WORKSPACE_METADATA_GRANTS.write],
      params: CoreWorkspaceRepositoryRemoveParamsSchema,
      result: CoreWorkspaceRepositoryRemoveResultSchema,
      error: metadataError(codes['core.workspace.repository.remove']),
    }),
  });
