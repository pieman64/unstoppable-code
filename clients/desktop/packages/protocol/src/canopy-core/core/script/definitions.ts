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

// The script model's limits (`@canopy/protocol/scripts`), which canopy-core
// cannot import; the core-runtime script tests pin them together.
const MAX_SCRIPT_TIMEOUT_SECONDS = 2_000_000;
const MAX_SCRIPT_DEV_SERVER_PATTERN_LENGTH = 1000;
const MAX_SCRIPT_DEV_SERVER_LABEL_LENGTH = 80;
const MAX_SCRIPT_DEV_SERVER_PATTERNS = 8;

export const CORE_SCRIPT_GRANTS = {
  read: 'core.script.read',
  write: 'core.script.write',
} as const;

export const CORE_SCRIPT_ERROR_CODES = [
  'core.script.notFound',
  'core.script.invalidDefinition',
  'core.script.readOnly',
  'core.script.configurationUnavailable',
  'core.script.revisionConflict',
  'core.script.idempotencyKeyReused',
  'core.script.requestInProgress',
  'core.script.recoveryRequired',
  'core.script.outcomeExpired',
] as const;

export type CoreScriptErrorCode = (typeof CORE_SCRIPT_ERROR_CODES)[number];

// Identifiers match the desktop `validateId` slug, so a request the IPC
// projection accepted is never refused here.
const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9-]*$/);
// Reads accept any name a source may hold; changes keep the settings
// command's 512-character bound.
const scriptName = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, 'Script names are trimmed');
const settingName = scriptName.max(512);

/**
 * Where a script is defined: a single-repository project, the root of a
 * multi-repository workspace, or one of its repositories. `worktreeId` reads
 * the source-controlled configuration of that worktree's checkout instead of
 * the source checkout.
 */
export const CoreScriptTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('project'),
    workspaceId: id,
    worktreeId: id.optional(),
  }),
  z.strictObject({
    kind: z.literal('workspace-root'),
    workspaceId: id,
    worktreeId: id.optional(),
  }),
  z.strictObject({
    kind: z.literal('workspace-repo'),
    workspaceId: id,
    repoId: id,
    worktreeId: id.optional(),
  }),
]);
export type CoreScriptTarget = z.output<typeof CoreScriptTargetSchema>;

/** The layer that supplied a resolved script (the ten resolver kinds). */
export const CORE_SCRIPT_SOURCE_KINDS = [
  'local-override',
  'local-disabled',
  'repo-conductor',
  'repo-canopy',
  'workspace-conductor',
  'workspace-manifest',
  'workspace-manifest-disabled',
  'workspace-hook',
  'workspace-hook-disabled',
  'none',
] as const;
export const CoreScriptSourceKindSchema = z.enum(CORE_SCRIPT_SOURCE_KINDS);
export type CoreScriptSourceKind = z.output<typeof CoreScriptSourceKindSchema>;

export const CORE_SCRIPT_LIFECYCLE_ROLES = [
  'before-setup',
  'setup',
  'after-setup',
  'before-launch',
  'launch',
  'after-launch',
  'before-teardown',
  'teardown',
  'after-teardown',
  'custom',
] as const;

/**
 * The shell a run would select on each operating system, without probing the
 * host. `default` is PowerShell when installed, otherwise `cmd`, on Windows,
 * and the user's login shell on macOS.
 */
export const CoreScriptShellSelectionSchema = z.strictObject({
  windows: z.enum(['default', 'cmd', 'powershell', 'bash']),
  mac: z.enum(['default', 'zsh', 'bash']),
  linux: z.enum(['bash', 'zsh']),
});

/**
 * The timeout a run would apply. `default` is the user's script timeout
 * preference; `none` names why a run has no timeout.
 */
export const CoreScriptTimeoutSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('none'),
    reason: z.enum(['launch', 'interactive', 'disabled']),
  }),
  z.strictObject({ kind: z.literal('default') }),
  z.strictObject({
    kind: z.literal('custom'),
    seconds: z.int().min(1).max(MAX_SCRIPT_TIMEOUT_SECONDS),
  }),
]);

const devServerPatternEntry = z.union([
  z.string().min(1).max(MAX_SCRIPT_DEV_SERVER_PATTERN_LENGTH),
  z.strictObject({
    pattern: z.string().min(1).max(MAX_SCRIPT_DEV_SERVER_PATTERN_LENGTH),
    label: z.string().min(1).max(MAX_SCRIPT_DEV_SERVER_LABEL_LENGTH).optional(),
    openTarget: z.enum(['in-app', 'external']).optional(),
    autoOpen: z.boolean().optional(),
  }),
]);
const devServerPattern = z.union([
  devServerPatternEntry,
  z.array(devServerPatternEntry).min(1).max(MAX_SCRIPT_DEV_SERVER_PATTERNS),
]);

const commandShell = z.strictObject({
  windows: z.enum(['cmd', 'powershell', 'bash']).optional(),
  mac: z.enum(['zsh', 'bash']).optional(),
  linux: z.enum(['bash', 'zsh']).optional(),
});

const command = z
  .string()
  .min(1)
  .max(65_536)
  .refine((value) => value.trim().length > 0, 'Commands are not blank');

/** A persisted script value: a command, a definition, or a disable (`null`). */
export const CoreScriptValueSchema = z.union([
  command,
  z.strictObject({
    command,
    interactive: z.boolean().optional(),
    timeoutSeconds: z
      .int()
      .min(1)
      .max(MAX_SCRIPT_TIMEOUT_SECONDS)
      .nullable()
      .optional(),
    devServerPattern: devServerPattern.optional(),
    shell: commandShell.optional(),
  }),
  z.null(),
]);

const resolvedBase = {
  name: z.string().min(1),
  lifecycle: z.enum(CORE_SCRIPT_LIFECYCLE_ROLES),
  source: CoreScriptSourceKindSchema,
};

/**
 * A resolved script. A `disabled` script is a disable from a higher layer that
 * hides every lower definition of the name.
 */
export const CoreScriptDefinitionSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('disabled'), ...resolvedBase }),
  z.strictObject({
    state: z.literal('enabled'),
    ...resolvedBase,
    command: z.string().min(1),
    interactive: z.boolean(),
    timeout: CoreScriptTimeoutSchema,
    shell: CoreScriptShellSelectionSchema,
    devServerPattern: devServerPattern.optional(),
  }),
]);
export type CoreScriptDefinition = z.output<typeof CoreScriptDefinitionSchema>;

/**
 * One layer that defines a script, highest priority first. `file` names the
 * source-controlled file a layer was read from; `note` marks a configuration
 * file that is a lower-priority fallback, missing, or the one in use.
 */
export const CoreScriptSourceLayerSchema = z.strictObject({
  sourceKey: z.string().min(1),
  source: CoreScriptSourceKindSchema.exclude([
    'local-disabled',
    'workspace-manifest-disabled',
    'workspace-hook-disabled',
    'none',
  ]),
  file: z.string().min(1).optional(),
  note: z.enum(['overridden-fallback', 'not-found', 'used-config']).optional(),
  command: z.string().nullable(),
  status: z.enum(['active', 'disabled', 'overridden', 'absent']),
});
export type CoreScriptSourceLayer = z.output<
  typeof CoreScriptSourceLayerSchema
>;

export const CoreScriptDefinitionListParamsSchema = z.strictObject({
  target: CoreScriptTargetSchema,
  /**
   * `effective` (the default) resolves every layer; `local` lists only the
   * target's own settings, which `core.script.definition.upsert` and
   * `.delete` change.
   */
  layer: z.enum(['effective', 'local']).optional(),
});
export type CoreScriptDefinitionListParams = z.output<
  typeof CoreScriptDefinitionListParamsSchema
>;
export const CoreScriptDefinitionListResultSchema = z.strictObject({
  definitions: z.array(CoreScriptDefinitionSchema),
});
export type CoreScriptDefinitionListResult = z.output<
  typeof CoreScriptDefinitionListResultSchema
>;

export const CoreScriptDefinitionGetParamsSchema = z.strictObject({
  target: CoreScriptTargetSchema,
  name: scriptName,
});
export type CoreScriptDefinitionGetParams = z.output<
  typeof CoreScriptDefinitionGetParamsSchema
>;
export const CoreScriptDefinitionGetResultSchema = z.strictObject({
  name: z.string().min(1),
  definition: CoreScriptDefinitionSchema.nullable(),
  layers: z.array(CoreScriptSourceLayerSchema),
  effectiveCommand: z.string().nullable(),
});
export type CoreScriptDefinitionGetResult = z.output<
  typeof CoreScriptDefinitionGetResultSchema
>;

const revision = z.int().nonnegative();

export const CoreScriptDefinitionUpsertParamsSchema = z.strictObject({
  target: CoreScriptTargetSchema,
  name: settingName,
  value: CoreScriptValueSchema,
  expectedRevision: revision.optional(),
});
export type CoreScriptDefinitionUpsertParams = z.output<
  typeof CoreScriptDefinitionUpsertParamsSchema
>;
export const CoreScriptDefinitionDeleteParamsSchema = z.strictObject({
  target: CoreScriptTargetSchema,
  name: settingName,
  expectedRevision: revision.optional(),
});
export type CoreScriptDefinitionDeleteParams = z.output<
  typeof CoreScriptDefinitionDeleteParamsSchema
>;
export const CoreScriptDefinitionChangeResultSchema = z.strictObject({
  name: z.string().min(1),
});
export type CoreScriptDefinitionChangeResult = z.output<
  typeof CoreScriptDefinitionChangeResultSchema
>;

export const CoreScriptQueryErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z.enum(CORE_SCRIPT_ERROR_CODES).optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});
export const CoreScriptInstructionErrorSchema = CanopyErrorPayloadSchema.extend(
  {
    code: z.enum(CORE_SCRIPT_ERROR_CODES).optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  },
);

export const CORE_SCRIPT_DEFINITION_QUERIES = defineCanopyQueryRegistry(
  'core',
  {
    'core.script.definition.list': defineCanopyQuery({
      plane: 'core',
      domain: 'script',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: [CORE_SCRIPT_GRANTS.read],
      params: CoreScriptDefinitionListParamsSchema,
      result: CoreScriptDefinitionListResultSchema,
      error: CoreScriptQueryErrorSchema,
    }),
    'core.script.definition.get': defineCanopyQuery({
      plane: 'core',
      domain: 'script',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: [CORE_SCRIPT_GRANTS.read],
      params: CoreScriptDefinitionGetParamsSchema,
      result: CoreScriptDefinitionGetResultSchema,
      error: CoreScriptQueryErrorSchema,
    }),
  },
);

export const CORE_SCRIPT_DEFINITION_INSTRUCTIONS =
  defineCanopyInstructionRegistry('core', {
    'core.script.definition.upsert': defineCanopyInstruction({
      plane: 'core',
      domain: 'script',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: [CORE_SCRIPT_GRANTS.write],
      params: CoreScriptDefinitionUpsertParamsSchema,
      result: CoreScriptDefinitionChangeResultSchema,
      error: CoreScriptInstructionErrorSchema,
    }),
    'core.script.definition.delete': defineCanopyInstruction({
      plane: 'core',
      domain: 'script',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: [CORE_SCRIPT_GRANTS.write],
      params: CoreScriptDefinitionDeleteParamsSchema,
      result: CoreScriptDefinitionChangeResultSchema,
      error: CoreScriptInstructionErrorSchema,
    }),
  });
