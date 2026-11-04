import { THINKING_LEVELS, type ThinkingLevel } from '../thinking/index';

export const AI_GATEWAY_MODEL_CATALOG_VERSION = 9 as const;
/** First clients that honor exact thinking sets without adding legacy Off. */
export const AI_GATEWAY_EXACT_THINKING_CATALOG_VERSION = 9 as const;
export const AI_GATEWAY_MODEL_CATALOG_MAX_MODELS = 500;
export const AI_GATEWAY_MODEL_CATALOG_MAX_BODY_BYTES = 1024 * 1024;

export const AI_GATEWAY_THINKING_LEVELS = THINKING_LEVELS;

/**
 * Families are data: the hosted catalog serves any key from its family
 * registry. `custom` is reserved for organization gateway rows and is never a
 * registry key.
 */
export const AI_GATEWAY_CUSTOM_MODEL_FAMILY = 'custom' as const;
export const AI_GATEWAY_MODEL_FAMILY_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type AiGatewayHarness = 'claude' | 'codex';
export type AiGatewayModelFamily = string;
export type AiGatewayThinkingLevel = ThinkingLevel;

/**
 * Controls only the JSON Schema projection used for dynamically injected
 * tools. `flat` strips composition/conditional keywords for restrictive
 * gateway dialects; runtime argument validation is unchanged.
 */
export type AiGatewayToolSchemaProfile = 'standard' | 'flat';

export interface AiGatewayModel {
  /** Stable API-owned selection ID; used directly for gateway-only models. */
  id: string;
  /** Exact provider/model identifier sent to AI Gateway. */
  gatewayId: string;
  /** Cursor base model ID, without ACP variant suffixes. Discovery grants support. */
  cursorModelId?: string;
  label: string;
  family: AiGatewayModelFamily;
  /** API-owned display label for the family. */
  familyLabel: string;
  description?: string;
  recommendedHarness: AiGatewayHarness;
  contextWindow: number;
  supportsPromptCaching: boolean;
  /** Only surface this model when the local package config declares its gateway ID. */
  requiresLocalHarnessSupport: boolean;
  /** Place this model in the nested More menu for its family. */
  showMoreOnly: boolean;
  /** Empty means thinking is unsupported; declared entries are exact. */
  supportedThinkingLevels: AiGatewayThinkingLevel[];
  /** v9: preserve this exact set, including the absence of Off. */
  thinkingLevelsExact?: true;
  toolSchemaProfile: AiGatewayToolSchemaProfile;
}

export interface AiGatewayModelCatalogResponse {
  version: typeof AI_GATEWAY_MODEL_CATALOG_VERSION;
  models: AiGatewayModel[];
}

const MODEL_FIELDS = new Set([
  'id',
  'gatewayId',
  'cursorModelId',
  'label',
  'family',
  'familyLabel',
  'description',
  'recommendedHarness',
  'contextWindow',
  'supportsPromptCaching',
  'requiresLocalHarnessSupport',
  'showMoreOnly',
  'supportedThinkingLevels',
  'thinkingLevelsExact',
  'toolSchemaProfile',
]);
const RESPONSE_FIELDS = new Set(['version', 'models']);
const THINKING_LEVEL_ORDER = new Map<string, number>(
  AI_GATEWAY_THINKING_LEVELS.map((level, index) => [level, index]),
);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyFields(
  value: Record<string, unknown>,
  fields: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => fields.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isAiGatewayModelFamily(
  value: unknown,
): value is AiGatewayModelFamily {
  return (
    typeof value === 'string' && AI_GATEWAY_MODEL_FAMILY_KEY_PATTERN.test(value)
  );
}

export function isAiGatewayThinkingLevel(
  value: unknown,
): value is AiGatewayThinkingLevel {
  return typeof value === 'string' && THINKING_LEVEL_ORDER.has(value);
}

/** Exact, bounded base identity used to reconcile an advertised Cursor model. */
export function isCursorCatalogModelId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value === value.trim() &&
    /^[a-z0-9][a-z0-9._-]{0,159}$/.test(value)
  );
}

export function isAiGatewayModel(value: unknown): value is AiGatewayModel {
  if (!isPlainRecord(value) || !hasOnlyFields(value, MODEL_FIELDS)) {
    return false;
  }
  if (
    !isNonEmptyString(value.id) ||
    !/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\[[a-z0-9]+\])?$/.test(value.id) ||
    !isNonEmptyString(value.gatewayId) ||
    !/^[a-z0-9-]+\/[^\s/][^\s]*$/.test(value.gatewayId) ||
    (value.cursorModelId !== undefined &&
      !isCursorCatalogModelId(value.cursorModelId)) ||
    !isNonEmptyString(value.label) ||
    !isAiGatewayModelFamily(value.family) ||
    !isNonEmptyString(value.familyLabel) ||
    (value.description !== undefined && !isNonEmptyString(value.description)) ||
    (value.recommendedHarness !== 'claude' &&
      value.recommendedHarness !== 'codex') ||
    typeof value.contextWindow !== 'number' ||
    !Number.isInteger(value.contextWindow) ||
    value.contextWindow <= 0 ||
    typeof value.supportsPromptCaching !== 'boolean' ||
    typeof value.requiresLocalHarnessSupport !== 'boolean' ||
    typeof value.showMoreOnly !== 'boolean' ||
    (value.toolSchemaProfile !== 'standard' &&
      value.toolSchemaProfile !== 'flat') ||
    (value.thinkingLevelsExact !== undefined &&
      value.thinkingLevelsExact !== true) ||
    !Array.isArray(value.supportedThinkingLevels)
  ) {
    return false;
  }

  let previous = -1;
  const seen = new Set<string>();
  for (const level of value.supportedThinkingLevels) {
    if (!isAiGatewayThinkingLevel(level) || seen.has(level)) {
      return false;
    }
    const order = THINKING_LEVEL_ORDER.get(level);
    if (order === undefined || order <= previous) {
      return false;
    }
    seen.add(level);
    previous = order;
  }
  return true;
}

export function isAiGatewayModelCatalogResponse(
  value: unknown,
  bodyByteLength?: number,
): value is AiGatewayModelCatalogResponse {
  if (
    bodyByteLength !== undefined &&
    bodyByteLength > AI_GATEWAY_MODEL_CATALOG_MAX_BODY_BYTES
  ) {
    return false;
  }
  if (
    !isPlainRecord(value) ||
    !hasOnlyFields(value, RESPONSE_FIELDS) ||
    value.version !== AI_GATEWAY_MODEL_CATALOG_VERSION ||
    !Array.isArray(value.models) ||
    value.models.length > AI_GATEWAY_MODEL_CATALOG_MAX_MODELS
  ) {
    return false;
  }

  const ids = new Set<string>();
  const gatewayIds = new Set<string>();
  for (const model of value.models) {
    if (
      !isAiGatewayModel(model) ||
      ids.has(model.id) ||
      gatewayIds.has(model.gatewayId)
    ) {
      return false;
    }
    ids.add(model.id);
    gatewayIds.add(model.gatewayId);
  }
  return true;
}

export function parseAiGatewayModelCatalogResponse(
  value: unknown,
  bodyByteLength?: number,
): AiGatewayModelCatalogResponse {
  // Retained v6-v8 wire shapes cannot carry v9 exact-thinking metadata.
  // Promote compatible old servers/caches, retaining legacy effort semantics.
  if (
    isPlainRecord(value) &&
    value.version === 6 &&
    Array.isArray(value.models) &&
    value.models.every(
      (model) => isPlainRecord(model) && !('cursorModelId' in model),
    )
  ) {
    value = { ...value, version: 7 };
  }
  if (
    isPlainRecord(value) &&
    (value.version === 7 || value.version === 8) &&
    Array.isArray(value.models) &&
    value.models.every(
      (model) => isPlainRecord(model) && !('thinkingLevelsExact' in model),
    )
  ) {
    value = { ...value, version: AI_GATEWAY_MODEL_CATALOG_VERSION };
  }
  if (!isAiGatewayModelCatalogResponse(value, bodyByteLength)) {
    throw new Error('Invalid AI Gateway model catalog response');
  }
  return {
    version: value.version,
    models: value.models.map((model) => ({
      ...model,
      supportedThinkingLevels: [...model.supportedThinkingLevels],
    })),
  };
}
