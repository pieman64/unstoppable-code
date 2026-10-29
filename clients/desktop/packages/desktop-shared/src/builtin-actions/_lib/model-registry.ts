import {
  initClaudeModels,
  initCodexModels,
  initAiGatewayModels,
  initModelAliases,
  initOllamaModels,
  isThinkingLevel,
  resolveModelAlias,
  stripOllamaModelPrefix,
  type ClaudeModelEntry,
  type CodexModelEntry,
  type OllamaModelEntry,
  type ThinkingLevel,
  initModelHarnessAssignments,
  type ModelHarnessAssignmentSnapshot,
  type ModelHarnessAssignment,
  type BuiltinModelCatalogPayload,
  type AiGatewayModelEntry,
  type GatewayRouteEntry,
} from '@canopy/desktop-shared/types';
import { getBrandEnv } from '@canopy/desktop-shared/brand/env';
import { isAiGatewayModelFamily } from '@canopy/protocol/ai-gateway-models';

let hydrated = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isModelHarnessAssignment(
  value: unknown,
): value is ModelHarnessAssignment {
  return (
    isRecord(value) &&
    typeof value.modelId === 'string' &&
    (value.source === 'claude-managed' ||
      value.source === 'codex-managed' ||
      value.source === 'ai-gateway' ||
      value.source === 'ollama') &&
    (value.harness === 'claude' || value.harness === 'codex') &&
    (value.defaultHarness === 'claude' || value.defaultHarness === 'codex') &&
    typeof value.configurable === 'boolean' &&
    typeof value.overridden === 'boolean'
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

function isBuiltinGatewayRoute(
  value: unknown,
): value is BuiltinModelCatalogPayload['gatewayRoutes'][number] {
  return (
    isRecord(value) &&
    typeof value.modelId === 'string' &&
    typeof value.gatewayId === 'string' &&
    isAiGatewayModelFamily(value.family) &&
    (value.recommendedHarness === 'claude' ||
      value.recommendedHarness === 'codex') &&
    typeof value.gatewayOnly === 'boolean' &&
    (value.contextWindow === undefined ||
      typeof value.contextWindow === 'number') &&
    (value.supportsPromptCaching === undefined ||
      typeof value.supportsPromptCaching === 'boolean') &&
    (value.supportedThinkingLevels === undefined ||
      isStringArray(value.supportedThinkingLevels)) &&
    (value.toolSchemaProfile === undefined ||
      value.toolSchemaProfile === 'standard' ||
      value.toolSchemaProfile === 'flat')
  );
}

function parseStringArray(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((value): value is string => typeof value === 'string');
  } catch {
    return [];
  }
}

function parseStringRecord(raw: string | undefined): Record<string, string> {
  if (!raw) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    const record: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') {
        record[key] = value;
      }
    }
    return record;
  } catch {
    return {};
  }
}

function parseThinkingLevelsRecord(
  raw: string | undefined,
): Record<string, ThinkingLevel[]> {
  if (!raw) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    const record: Record<string, ThinkingLevel[]> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) {
        continue;
      }
      const levels = value.filter(
        (level): level is ThinkingLevel =>
          typeof level === 'string' && isThinkingLevel(level),
      );
      record[key] = levels;
    }
    return record;
  } catch {
    return {};
  }
}

function parseHarnessAssignments(
  raw: string | undefined,
): ModelHarnessAssignmentSnapshot | undefined {
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !isRecord(value) ||
      typeof value.revision !== 'number' ||
      !Array.isArray(value.assignments)
    ) {
      return undefined;
    }
    const assignments = value.assignments;
    if (!assignments.every(isModelHarnessAssignment)) {
      return undefined;
    }
    return { revision: value.revision, assignments };
  } catch {
    return undefined;
  }
}

function parseBuiltinModelCatalog(
  raw: string | undefined,
): BuiltinModelCatalogPayload | undefined {
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) {
      return undefined;
    }
    if (
      value.version !== 1 ||
      !isStringArray(value.claudeModels) ||
      !isStringArray(value.codexModels) ||
      !isStringArray(value.ollamaModels) ||
      !isStringArray(value.aiGatewayModels) ||
      !Array.isArray(value.gatewayRoutes) ||
      !value.gatewayRoutes.every(isBuiltinGatewayRoute) ||
      !isStringRecord(value.modelAliases)
    ) {
      return undefined;
    }
    return {
      version: value.version,
      claudeModels: value.claudeModels,
      codexModels: value.codexModels,
      ollamaModels: value.ollamaModels,
      aiGatewayModels: value.aiGatewayModels,
      gatewayRoutes: value.gatewayRoutes,
      modelAliases: value.modelAliases,
    };
  } catch {
    return undefined;
  }
}

export function hydrateModelRegistryFromEnv(): void {
  if (hydrated) {
    return;
  }

  const rawThinkingLevels = getBrandEnv(process.env, 'MODEL_THINKING_LEVELS');
  const rawClaudeModels = getBrandEnv(process.env, 'CLAUDE_MODELS');
  const rawCodexModels = getBrandEnv(process.env, 'CODEX_MODELS');
  const rawOllamaModels = getBrandEnv(process.env, 'OLLAMA_MODELS');
  const rawModelAliases = getBrandEnv(process.env, 'MODEL_ALIASES');
  const modelCatalog = parseBuiltinModelCatalog(
    getBrandEnv(process.env, 'MODEL_CATALOG'),
  );
  const assignmentSnapshot = parseHarnessAssignments(
    getBrandEnv(process.env, 'MODEL_HARNESS_ASSIGNMENTS'),
  );
  const thinkingLevelsByModel = parseThinkingLevelsRecord(rawThinkingLevels);
  const withThinkingLevels = (
    id: string,
  ): { supportedThinkingLevels?: ThinkingLevel[] } => {
    const levels = thinkingLevelsByModel[id];
    return levels ? { supportedThinkingLevels: levels } : {};
  };

  if (rawClaudeModels !== undefined) {
    const claudeEntries: ClaudeModelEntry[] = parseStringArray(
      rawClaudeModels,
    ).map((id) => ({ id, label: id, ...withThinkingLevels(id) }));
    initClaudeModels(claudeEntries);
  }
  if (rawCodexModels !== undefined) {
    const codexEntries: CodexModelEntry[] = parseStringArray(
      rawCodexModels,
    ).map((id) => ({ id, label: id, ...withThinkingLevels(id) }));
    initCodexModels(codexEntries);
  }
  if (rawOllamaModels !== undefined) {
    const ollamaEntries: OllamaModelEntry[] = parseStringArray(
      rawOllamaModels,
    ).map((id) => ({
      id,
      rawModelId: stripOllamaModelPrefix(id),
      label: stripOllamaModelPrefix(id),
    }));
    initOllamaModels(ollamaEntries);
  }
  if (rawModelAliases !== undefined) {
    initModelAliases(parseStringRecord(rawModelAliases));
  }
  if (modelCatalog) {
    const routes: GatewayRouteEntry[] = modelCatalog.gatewayRoutes.flatMap(
      (route) => {
        if (
          !route ||
          typeof route.modelId !== 'string' ||
          typeof route.gatewayId !== 'string' ||
          !isAiGatewayModelFamily(route.family) ||
          (route.recommendedHarness !== 'claude' &&
            route.recommendedHarness !== 'codex') ||
          typeof route.gatewayOnly !== 'boolean'
        ) {
          return [];
        }
        // Keep `off` when the propagated route declares it: gateway route
        // level sets are materialized with an explicit `off` by the catalog
        // merge, and stripping it here would clamp a requested `off` up to the
        // lowest thinking tier for AI-Credits-routed action models.
        const supportedThinkingLevels = (
          route.supportedThinkingLevels ??
          thinkingLevelsByModel[route.modelId] ??
          []
        ).filter((level): level is ThinkingLevel => isThinkingLevel(level));
        return [
          {
            modelId: route.modelId,
            gatewayId: route.gatewayId,
            family: route.family,
            recommendedHarness: route.recommendedHarness,
            gatewayOnly: route.gatewayOnly,
            contextWindow:
              typeof route.contextWindow === 'number' &&
              Number.isFinite(route.contextWindow)
                ? route.contextWindow
                : 0,
            supportsPromptCaching: route.supportsPromptCaching === true,
            supportedThinkingLevels,
            toolSchemaProfile:
              route.toolSchemaProfile === 'flat' ? 'flat' : 'standard',
          },
        ];
      },
    );
    const routeById = new Map(routes.map((route) => [route.modelId, route]));
    const entries: AiGatewayModelEntry[] = modelCatalog.aiGatewayModels.flatMap(
      (id) => {
        if (typeof id !== 'string') return [];
        const route = routeById.get(id);
        if (!route) return [];
        return [
          {
            id,
            label: id,
            recommendedHarness: route.recommendedHarness,
            contextWindow: route.contextWindow,
            supportsPromptCaching: route.supportsPromptCaching,
            supportedThinkingLevels: [...route.supportedThinkingLevels],
            toolSchemaProfile: route.toolSchemaProfile,
          },
        ];
      },
    );
    initAiGatewayModels(entries, routes);
    initModelAliases(modelCatalog.modelAliases);
  }
  if (assignmentSnapshot) {
    initModelHarnessAssignments(assignmentSnapshot);
  }
  hydrated = true;
}

export function resolveConfiguredModel(
  raw: string | undefined,
  fallback: string,
): string {
  hydrateModelRegistryFromEnv();
  const candidate = raw?.trim();
  if (!candidate) {
    return resolveModelAlias(fallback);
  }
  return resolveModelAlias(candidate);
}
