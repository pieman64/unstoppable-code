import { z } from 'zod';
import {
  isAiGatewayModelFamily,
  isCursorCatalogModelId,
} from '@canopy/protocol/ai-gateway-models';
import {
  CLIENT_FEATURE_FLAGS,
  type ClientFeatureFlagKey,
} from '@canopy/protocol/feature-flags';
import {
  MODEL_FAMILY_IDENTIFIERS,
  type ModelFamilyMetadata,
} from './model-families';
import { THINKING_LEVELS } from '@canopy/execution-engine/thinking';
import { type ClaudeModelEntry, type CodexModelEntry } from './types';

export { MODEL_FAMILY_IDENTIFIERS };
export type { ModelFamilyMetadata } from './model-families';

const thinkingLevelOrder = new Map(
  THINKING_LEVELS.map((level, index) => [level, index]),
);
const clientFeatureFlagKeys = new Set<string>(
  Object.values(CLIENT_FEATURE_FLAGS).map(({ key }) => key),
);

const nonEmptyString = z.string().trim().min(1);
const positiveInteger = z.number().int().positive();
const nonNegativeInteger = z.number().int().nonnegative();
const modelFamilySchema = z.enum(MODEL_FAMILY_IDENTIFIERS);
const runtimeModelFamilyMetadataSchema = z
  .object({
    id: nonEmptyString,
    family: modelFamilySchema,
    familyLabel: nonEmptyString,
    vendor: nonEmptyString,
    sortOrder: nonNegativeInteger,
  })
  .passthrough();
const runtimeModelFamilyMetadata = new Map<string, ModelFamilyMetadata>();

/** Replace the browser-process family lookup from validated registry entries. */
export function replaceModelFamilyMetadata(entries: readonly unknown[]): void {
  runtimeModelFamilyMetadata.clear();
  for (const entry of entries) {
    const parsed = runtimeModelFamilyMetadataSchema.safeParse(entry);
    if (!parsed.success) continue;
    runtimeModelFamilyMetadata.set(parsed.data.id, {
      family: parsed.data.family,
      familyLabel: parsed.data.familyLabel,
      vendor: parsed.data.vendor,
      sortOrder: parsed.data.sortOrder,
    });
  }
}

/** Read declared family metadata without parsing or inferring from a model id. */
export function getModelFamilyMetadata(
  model: string,
): ModelFamilyMetadata | undefined {
  return runtimeModelFamilyMetadata.get(model);
}

const clientFeatureFlagKeySchema = nonEmptyString.refine(
  (key): key is ClientFeatureFlagKey => clientFeatureFlagKeys.has(key),
  {
    message: 'featureFlag must name a client-visible feature flag',
  },
);

const gatewayIdSchema = nonEmptyString.regex(/^[a-z0-9-]+\/[^\s/][^\s]*$/);

const supportedThinkingLevelsSchema = z
  .array(z.enum(THINKING_LEVELS))
  .superRefine((levels, ctx) => {
    if (new Set(levels).size !== levels.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'supportedThinkingLevels must not contain duplicates',
      });
    }
    for (let index = 1; index < levels.length; index += 1) {
      const previous = thinkingLevelOrder.get(levels[index - 1] ?? 'low') ?? -1;
      const current = thinkingLevelOrder.get(levels[index] ?? 'low') ?? -1;
      if (current <= previous) {
        ctx.addIssue({
          code: 'custom',
          message: 'supportedThinkingLevels must be in ascending effort order',
        });
        break;
      }
    }
  });

const commonModelFields = {
  id: nonEmptyString,
  label: nonEmptyString,
  family: modelFamilySchema,
  familyLabel: nonEmptyString,
  vendor: nonEmptyString,
  sortOrder: nonNegativeInteger,
  description: nonEmptyString.optional(),
  showMoreOnly: z.boolean().optional(),
  selectable: z.boolean().optional(),
  gatewayId: gatewayIdSchema.optional(),
  cursorModelId: z.string().refine(isCursorCatalogModelId).optional(),
  featureFlag: clientFeatureFlagKeySchema.optional(),
  contextWindow: positiveInteger.optional(),
  extraChargeOnly: z.boolean().optional(),
  extraChargeMessage: nonEmptyString.optional(),
  supportedThinkingLevels: supportedThinkingLevelsSchema.optional(),
};

const runtimeCommonModelFields = {
  ...commonModelFields,
  family: modelFamilySchema.optional(),
  familyLabel: nonEmptyString.optional(),
  vendor: nonEmptyString.optional(),
  sortOrder: nonNegativeInteger.optional(),
};

const gatewayModelConfigSchema = z
  .object({
    gatewayId: gatewayIdSchema,
    family: z.string().refine(isAiGatewayModelFamily),
    recommendedHarness: z.enum(['claude', 'codex']),
    gatewayOnly: z.boolean(),
    contextWindow: positiveInteger,
    supportsPromptCaching: z.boolean(),
    supportedThinkingLevels: supportedThinkingLevelsSchema,
    toolSchemaProfile: z.enum(['standard', 'flat']),
  })
  .strict();

export const claudeModelEntrySchema = z
  .object({
    ...commonModelFields,
    harness: z.literal('claude').optional(),
  })
  .strict();

export const codexModelEntrySchema = z
  .object({
    ...commonModelFields,
    harness: z.literal('codex').optional(),
  })
  .strict();

/** Runtime registry entries may carry validated gateway routing metadata. */
export const runtimeClaudeModelEntrySchema = z
  .object({
    ...runtimeCommonModelFields,
    harness: z.literal('claude').optional(),
    gateway: gatewayModelConfigSchema.optional(),
  })
  .strict();

/** Runtime registry entries may carry validated gateway routing metadata. */
export const runtimeCodexModelEntrySchema = z
  .object({
    ...runtimeCommonModelFields,
    harness: z.literal('codex').optional(),
    gateway: gatewayModelConfigSchema.optional(),
  })
  .strict();

const claudeSectionSchema = z
  .object({
    models: z.array(claudeModelEntrySchema).optional(),
    modelAliases: z.record(z.string(), nonEmptyString).optional(),
  })
  .passthrough();

const codexSectionSchema = z
  .object({
    models: z.array(codexModelEntrySchema).optional(),
    modelAliases: z.record(z.string(), nonEmptyString).optional(),
  })
  .passthrough();

export const modelPackageConfigSchema = z
  .object({
    'claude-code': claudeSectionSchema.optional(),
    codex: codexSectionSchema.optional(),
  })
  .passthrough()
  .superRefine((pkg, ctx) => {
    const entries = [
      ...(pkg['claude-code']?.models ?? []).map((entry) => ({
        ...entry,
        harness: 'claude' as const,
      })),
      ...(pkg.codex?.models ?? []).map((entry) => ({
        ...entry,
        harness: 'codex' as const,
      })),
    ];
    const ids = new Set<string>();
    const gatewayIds = new Set<string>();
    const familyMetadata = new Map<
      string,
      {
        readonly label: string;
        readonly vendor: string;
      }
    >();
    const vendorSortOrders = new Map<string, string>();
    for (const entry of entries) {
      if (ids.has(entry.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['models', entry.id],
          message: `duplicate model id: ${entry.id}`,
        });
      }
      ids.add(entry.id);
      if (entry.gatewayId) {
        if (gatewayIds.has(entry.gatewayId)) {
          ctx.addIssue({
            code: 'custom',
            path: ['models', entry.id, 'gatewayId'],
            message: `duplicate gatewayId: ${entry.gatewayId}`,
          });
        }
        gatewayIds.add(entry.gatewayId);
      }
      const existingFamily = familyMetadata.get(entry.family);
      if (
        existingFamily &&
        (existingFamily.label !== entry.familyLabel ||
          existingFamily.vendor !== entry.vendor)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['models', entry.id, 'family'],
          message: `conflicting metadata for family: ${entry.family}`,
        });
      } else if (!existingFamily) {
        familyMetadata.set(entry.family, {
          label: entry.familyLabel,
          vendor: entry.vendor,
        });
      }
      const vendorSortKey = `${entry.vendor}:${entry.sortOrder}`;
      const existingModelAtOrder = vendorSortOrders.get(vendorSortKey);
      if (existingModelAtOrder !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['models', entry.id, 'sortOrder'],
          message: `duplicate sortOrder for vendor ${entry.vendor}: ${entry.sortOrder} (${existingModelAtOrder}, ${entry.id})`,
        });
      } else {
        vendorSortOrders.set(vendorSortKey, entry.id);
      }
    }

    const aliases = new Set<string>();
    for (const section of ['claude-code', 'codex'] as const) {
      for (const [alias, canonical] of Object.entries(
        pkg[section]?.modelAliases ?? {},
      )) {
        if (ids.has(alias)) {
          ctx.addIssue({
            code: 'custom',
            path: [section, 'modelAliases', alias],
            message: `alias collides with canonical model id: ${alias}`,
          });
        }
        if (aliases.has(alias)) {
          ctx.addIssue({
            code: 'custom',
            path: [section, 'modelAliases', alias],
            message: `duplicate model alias: ${alias}`,
          });
        }
        aliases.add(alias);
        if (!ids.has(canonical)) {
          ctx.addIssue({
            code: 'custom',
            path: [section, 'modelAliases', alias],
            message: `alias targets unknown model id: ${canonical}`,
          });
        }
      }
    }
  });

export interface NormalizedModelPackageConfig {
  claudeModels: ClaudeModelEntry[];
  codexModels: CodexModelEntry[];
  modelAliases: Record<string, string>;
}

/**
 * Validate package-owned model metadata and apply native-section harness
 * defaults. API-only gateway models are merged separately at runtime.
 */
export function parseModelPackageConfig(
  input: unknown,
): NormalizedModelPackageConfig {
  const parsed = modelPackageConfigSchema.parse(input);
  const nativeClaude = parsed['claude-code']?.models ?? [];
  const nativeCodex = parsed.codex?.models ?? [];

  const claudeModels: ClaudeModelEntry[] = nativeClaude.map((entry) => ({
    ...entry,
    harness: 'claude' as const,
  }));
  const codexModels: CodexModelEntry[] = nativeCodex.map((entry) => ({
    ...entry,
    harness: 'codex' as const,
  }));

  return {
    claudeModels,
    codexModels,
    modelAliases: {
      ...(parsed['claude-code']?.modelAliases ?? {}),
      ...(parsed.codex?.modelAliases ?? {}),
    },
  };
}
