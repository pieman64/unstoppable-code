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
import { WORKER_TERMINAL_PROFILE_IDS } from '../../worker/terminal';
import {
  inherentOperationErrorSchema,
  keyedOperationErrorSchema,
} from '../shared';

export const CORE_TERMINAL_SETTINGS_GRANTS = {
  read: 'core.config.read',
  write: 'core.config.write',
} as const;

/** The retry resource a stale revision names. */
export const CORE_TERMINAL_SETTINGS_RESOURCE = 'core.terminal.settings';

export const CORE_TERMINAL_SETTINGS_LIMITS = {
  presets: 50,
  presetId: 128,
  name: 64,
  command: 4000,
  iconCharacter: 16,
  artifactId: 512,
} as const;

const ID = z.string().min(1).max(512);
const PROFILE_ID = z.enum(WORKER_TERMINAL_PROFILE_IDS);
const ARTIFACT_ID = z
  .string()
  .min(1)
  .max(CORE_TERMINAL_SETTINGS_LIMITS.artifactId);

export const CoreTerminalPresetIconSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('character'),
    value: z.string().min(1).max(CORE_TERMINAL_SETTINGS_LIMITS.iconCharacter),
  }),
  z.strictObject({
    kind: z.literal('image'),
    lightArtifactId: ARTIFACT_ID.nullable(),
    darkArtifactId: ARTIFACT_ID.nullable(),
  }),
]);
export type CoreTerminalPresetIcon = z.output<
  typeof CoreTerminalPresetIconSchema
>;

export const CoreTerminalPresetSchema = z.strictObject({
  presetId: z.string().min(1).max(CORE_TERMINAL_SETTINGS_LIMITS.presetId),
  name: z.string().min(1).max(CORE_TERMINAL_SETTINGS_LIMITS.name),
  profileId: PROFILE_ID,
  command: z.string().min(1).max(CORE_TERMINAL_SETTINGS_LIMITS.command),
  enabled: z.boolean(),
  icon: CoreTerminalPresetIconSchema.nullable(),
});
export type CoreTerminalPreset = z.output<typeof CoreTerminalPresetSchema>;
export type CoreTerminalProfileId = z.output<typeof PROFILE_ID>;

const DISABLED_PROFILE_IDS = z
  .array(PROFILE_ID)
  .max(WORKER_TERMINAL_PROFILE_IDS.length)
  .refine((ids) => new Set(ids).size === ids.length, 'Duplicate profile id')
  .meta({ uniqueItems: true });
const PRESETS = z
  .array(CoreTerminalPresetSchema)
  .max(CORE_TERMINAL_SETTINGS_LIMITS.presets);

export const CoreTerminalSettingsSchema = z.strictObject({
  revision: z.number().int().min(0),
  disabledProfileIds: DISABLED_PROFILE_IDS,
  presets: PRESETS,
});
export type CoreTerminalSettings = z.output<typeof CoreTerminalSettingsSchema>;

export const CoreTerminalSettingsGetParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema.optional(),
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});
export type CoreTerminalSettingsGetParams = z.output<
  typeof CoreTerminalSettingsGetParamsSchema
>;

export const CoreTerminalSettingsUpdateParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema,
  expectedRevision: z.number().int().min(0),
  disabledProfileIds: DISABLED_PROFILE_IDS,
  presets: PRESETS,
  _meta: CanopyRequestMetadataSchema.extend({ idempotencyKey: ID }),
});
export type CoreTerminalSettingsUpdateParams = z.output<
  typeof CoreTerminalSettingsUpdateParamsSchema
>;

const BASE = {
  plane: 'core',
  domain: 'terminal',
  version: 1,
  placement: 'core-only',
} as const;

// Served by the desktop dispatcher over Electron main's preference repository
// (CAN-4148). The daemon serves them once CAN-5722 places that repository; the
// web core does not serve them.
export const CORE_TERMINAL_SETTINGS_QUERIES = defineCanopyQueryRegistry(
  'core',
  {
    'core.terminal.settings.get': defineCanopyQuery({
      ...BASE,
      idempotency: 'inherent',
      requiredGrants: [CORE_TERMINAL_SETTINGS_GRANTS.read],
      params: CoreTerminalSettingsGetParamsSchema,
      result: CoreTerminalSettingsSchema,
      error: inherentOperationErrorSchema([
        'core.terminal.settingsInvalid',
        'core.terminal.settingsUnavailable',
      ]),
    }),
  },
);

export const CORE_TERMINAL_SETTINGS_INSTRUCTIONS =
  defineCanopyInstructionRegistry('core', {
    'core.terminal.settings.update': defineCanopyInstruction({
      ...BASE,
      idempotency: 'keyed',
      requiredGrants: [CORE_TERMINAL_SETTINGS_GRANTS.write],
      params: CoreTerminalSettingsUpdateParamsSchema,
      result: CoreTerminalSettingsSchema,
      error: keyedOperationErrorSchema([
        'core.terminal.settingsInvalid',
        'core.terminal.settingsConflict',
        'core.terminal.presetDuplicate',
        'core.terminal.presetIconMissing',
      ]),
    }),
  });
