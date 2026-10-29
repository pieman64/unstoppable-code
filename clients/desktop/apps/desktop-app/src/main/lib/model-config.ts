import { isOpenCodeModel } from '@canopy/desktop-shared/lib/opencode-models';
import { isCopilotModel } from '@canopy/desktop-shared/lib/copilot-models';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import {
  parseModelPackageConfig,
  replaceModelFamilyMetadata,
} from '@canopy/desktop-shared/model-config';
import {
  mergeAiGatewayModelCatalog,
  type OrgGatewayCatalogInput,
} from '@canopy/desktop-shared/ai-gateway-model-catalog';
import type { AiGatewayModelCatalogResponse } from '@canopy/protocol/ai-gateway-models';
import {
  initClaudeModels,
  initCodexModels,
  initAiGatewayModels,
  initModelAliases,
  getCursorModelEntries,
  getCopilotModelEntries,
  getOpenCodeModelEntries,
  getSupportedThinkingLevelsForModel,
  type ClientFeatureFlagValues,
  type ConfiguredModelEntry,
  type ThinkingLevel,
} from '@canopy/desktop-shared/types';
import { initOrgGatewayModelAliases } from '@canopy/desktop-shared/lib/gateway-model-availability';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { isCursorModel } from '@canopy/desktop-shared/lib/cursor-models';

type ParsedModelConfig = ReturnType<typeof parseModelPackageConfig>;

export interface AuthoritativeConfiguredModel {
  readonly id: string;
  readonly label: string;
  readonly modelSource: string;
  readonly defaultHarness: string;
  readonly enabled: boolean;
  readonly selectable: boolean;
  readonly supportedThinkingLevels: readonly ThinkingLevel[];
}

/** Cursor discovery changes independently of the packaged/gateway catalog. */
function authoritativeCursorModels(): readonly AuthoritativeConfiguredModel[] {
  const entries = getCursorModelEntries();
  if (!entries.some((entry) => entry.id === 'cursor-default'))
    entries.unshift({
      id: 'cursor-default',
      rawModelId: 'default[]',
      label: 'Cursor default',
    });
  const enabled =
    cachedFeatureFlags[CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarness.key] ===
    true;
  return entries.map((entry) =>
    Object.freeze({
      id: entry.id,
      label: entry.label,
      modelSource: 'cursor-managed',
      defaultHarness: 'cursor',
      enabled,
      selectable: enabled,
      supportedThinkingLevels: Object.freeze([
        ...(entry.supportedThinkingLevels ?? []),
      ]),
    }),
  );
}

function authoritativeCopilotModels(): readonly AuthoritativeConfiguredModel[] {
  const enabled =
    cachedFeatureFlags[CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarness.key] ===
    true;
  return getCopilotModelEntries().map((entry) =>
    Object.freeze({
      id: entry.id,
      label: entry.label,
      modelSource: 'copilot-managed',
      defaultHarness: 'copilot',
      enabled,
      selectable: enabled,
      supportedThinkingLevels: Object.freeze([
        ...entry.supportedThinkingLevels,
      ]),
    }),
  );
}

function authoritativeOpenCodeModels(): readonly AuthoritativeConfiguredModel[] {
  return getOpenCodeModelEntries().map((entry) =>
    Object.freeze({
      id: entry.id,
      label: entry.label,
      modelSource: 'opencode-managed',
      defaultHarness: 'opencode',
      enabled: true,
      selectable: true,
      supportedThinkingLevels: Object.freeze([
        ...entry.supportedThinkingLevels,
      ]),
    }),
  );
}

/** Canonical IDs only. Historical lookup must not reinterpret current aliases. */
export function getAuthoritativeConfiguredModel(
  modelId: string,
): AuthoritativeConfiguredModel | undefined {
  if (!authoritativeConfigAvailable || !cachedModelConfig) return undefined;
  if (isOpenCodeModel(modelId))
    return authoritativeOpenCodeModels().find((entry) => entry.id === modelId);
  if (isCopilotModel(modelId))
    return authoritativeCopilotModels().find((entry) => entry.id === modelId);
  if (isCursorModel(modelId))
    return authoritativeCursorModels().find((entry) => entry.id === modelId);
  if (
    authoritativeCache?.config === cachedModelConfig &&
    authoritativeCache.catalog === cachedCatalog &&
    authoritativeCache.featureFlags === cachedFeatureFlags &&
    authoritativeCache.orgGateways === cachedOrgGateways
  ) {
    return authoritativeCache.models.get(modelId);
  }
  const models = new Map<string, AuthoritativeConfiguredModel>();
  const nativeSources: ReadonlyArray<{
    entries: readonly ConfiguredModelEntry[];
    harness: 'claude' | 'codex';
    source: string;
  }> = [
    {
      entries: cachedModelConfig.claudeModels,
      harness: 'claude',
      source: 'claude-managed',
    },
    {
      entries: cachedModelConfig.codexModels,
      harness: 'codex',
      source: 'codex-managed',
    },
  ];
  for (const source of nativeSources) {
    for (const entry of source.entries) {
      const enabled =
        !entry.featureFlag || cachedFeatureFlags[entry.featureFlag] === true;
      models.set(
        entry.id,
        Object.freeze({
          id: entry.id,
          label: entry.label,
          modelSource: source.source,
          defaultHarness: source.harness,
          enabled,
          selectable: enabled && entry.selectable !== false,
          supportedThinkingLevels: Object.freeze([
            ...(entry.supportedThinkingLevels ??
              getSupportedThinkingLevelsForModel(undefined, source.harness)),
          ]),
        }),
      );
    }
  }
  const merged = mergeAiGatewayModelCatalog({
    packageConfig: cachedModelConfig,
    catalog: cachedCatalog,
    featureFlags: cachedFeatureFlags,
    orgGateways: cachedOrgGateways,
  });
  for (const entry of merged.aiGatewayModels) {
    models.set(
      entry.id,
      Object.freeze({
        id: entry.id,
        label: entry.label,
        modelSource: 'ai-gateway',
        defaultHarness: entry.recommendedHarness,
        enabled: true,
        selectable: true,
        supportedThinkingLevels: Object.freeze([
          ...entry.supportedThinkingLevels,
        ]),
      }),
    );
  }
  authoritativeCache = {
    config: cachedModelConfig,
    catalog: cachedCatalog,
    featureFlags: cachedFeatureFlags,
    orgGateways: cachedOrgGateways,
    models,
  };
  return models.get(modelId);
}

/** Current authoritative inventory, including disabled routes for actionable discovery. */
export function listAuthoritativeConfiguredModels(): readonly AuthoritativeConfiguredModel[] {
  getAuthoritativeConfiguredModel('__inventory__');
  return authoritativeConfigAvailable
    ? [
        ...Array.from(authoritativeCache?.models.values() ?? []),
        ...authoritativeCursorModels(),
        ...authoritativeCopilotModels(),
        ...authoritativeOpenCodeModels(),
      ]
    : [];
}

function readModelConfigFromPackageJson(): ParsedModelConfig {
  const appPathPackageJson = join(app.getAppPath(), 'package.json');
  const cwdPackageJson = join(process.cwd(), 'package.json');
  const pkgPath = existsSync(appPathPackageJson)
    ? appPathPackageJson
    : cwdPackageJson;
  return parseModelPackageConfig(
    JSON.parse(readFileSync(pkgPath, 'utf8')) as unknown,
  );
}

let cachedModelConfig: ParsedModelConfig | null = null;
let cachedCatalog: AiGatewayModelCatalogResponse | undefined;
let cachedFeatureFlags: Partial<ClientFeatureFlagValues> = {};
let authoritativeConfigAvailable = false;
let authoritativeCache:
  | {
      config: ParsedModelConfig;
      catalog: AiGatewayModelCatalogResponse | undefined;
      featureFlags: Partial<ClientFeatureFlagValues>;
      orgGateways: typeof cachedOrgGateways;
      models: ReadonlyMap<string, AuthoritativeConfiguredModel>;
    }
  | undefined;
let cachedOrgGateways: readonly OrgGatewayCatalogInput[] = [];

function applyModelConfig(
  config: ParsedModelConfig,
  featureFlags?: Partial<ClientFeatureFlagValues>,
): void {
  const merged = mergeAiGatewayModelCatalog({
    packageConfig: config,
    catalog: cachedCatalog,
    featureFlags,
    orgGateways: cachedOrgGateways,
  });
  replaceModelFamilyMetadata([...merged.claudeModels, ...merged.codexModels]);
  initClaudeModels(merged.claudeModels, featureFlags);
  initCodexModels(merged.codexModels, featureFlags);
  initAiGatewayModels(merged.aiGatewayModels, merged.gatewayRoutes);
  initOrgGatewayModelAliases(merged.orgGatewayModelAliases);
  initModelAliases(merged.modelAliases);
  authoritativeConfigAvailable = true;
}

export function updateOrgGatewayModelCatalog(
  gateways: readonly OrgGatewayCatalogInput[],
): void {
  const config = cachedModelConfig ?? readModelConfigFromPackageJson();
  const previous = cachedOrgGateways;
  try {
    cachedModelConfig = config;
    cachedOrgGateways = gateways;
    applyModelConfig(config, cachedFeatureFlags);
  } catch (error) {
    cachedOrgGateways = previous;
    throw error;
  }
}

/**
 * Validate and load every configured model section from package.json before
 * IPC handlers register.
 */
export function loadModelsFromPackageJson(
  featureFlags?: Partial<ClientFeatureFlagValues>,
): void {
  try {
    const config = readModelConfigFromPackageJson();
    cachedModelConfig = config;
    cachedFeatureFlags = { ...(featureFlags ?? {}) };
    applyModelConfig(config, featureFlags);
  } catch (error) {
    // A packaged build should have passed validate:model-config. Keep startup
    // resilient if the file is nevertheless missing or corrupt.
    authoritativeConfigAvailable = false;
    authoritativeCache = undefined;
    initClaudeModels([]);
    initCodexModels([]);
    initAiGatewayModels([], []);
    initOrgGatewayModelAliases({});
    initModelAliases({});
    // eslint-disable-next-line no-console
    console.error(
      'Failed to load model configuration from package.json.',
      error,
    );
  }
}

export function refreshModelsForFeatureFlags(
  featureFlags: Partial<ClientFeatureFlagValues>,
): void {
  try {
    const config = cachedModelConfig ?? readModelConfigFromPackageJson();
    cachedModelConfig = config;
    cachedFeatureFlags = { ...featureFlags };
    applyModelConfig(config, featureFlags);
  } catch {
    // Keep the last-known-good registries if a runtime refresh fails.
  }
}

/** Apply a fully validated API catalog while preserving the last good merge. */
export function updateAiGatewayModelCatalog(
  catalog: AiGatewayModelCatalogResponse,
): void {
  const config = cachedModelConfig ?? readModelConfigFromPackageJson();
  const previous = cachedCatalog;
  try {
    cachedModelConfig = config;
    cachedCatalog = catalog;
    applyModelConfig(config, cachedFeatureFlags);
  } catch (error) {
    cachedCatalog = previous;
    throw error;
  }
}
