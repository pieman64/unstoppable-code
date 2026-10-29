// ---------------------------------------------------------------------------
// OpenAI pricing API contract (Best-Effort Codex Observed Cost).
//
// This module owns the wire shape served by the unauthenticated public
// pricing endpoint `GET /api/v1/[brandNamespace]/openai-pricing` (producer:
// the web route; consumer: the desktop pricing cache client). It is the
// single source of truth for every rate, threshold, multiplier, alias,
// billable-tool price, and unpriced-model marker the desktop cost calculator
// consumes — the desktop must never hardcode pricing constants.
//
// IMPORTANT: like every other protocol module, this file must stay
// dependency-free (no node:crypto, no filesystem, no Prisma, no React, no
// zod). The validator below is hand-written and structural only.
// ---------------------------------------------------------------------------

// ===========================================================================
// Payload types (Contract 1).
// ===========================================================================

export type OpenAiPricingCurrency = 'usd';
export type OpenAiPricingUnit = 'per_1m_tokens';

/** Canonical service tier after alias resolution. */
export type OpenAiPricingCanonicalTier = 'standard' | 'fast';

export interface OpenAiPricingSourceInfo {
  pricingUrl: string;
  codexPricingUrl: string;
  codexSpeedUrl: string;
  fetchedAt: string;
  generatedBy: string;
}

export interface OpenAiTokenRatesPerMillion {
  input: number;
  cachedInput: number;
  /** Price for creating a cache entry. Falls back to `input` when omitted. */
  cacheWriteInput?: number;
  output: number;
}

export interface OpenAiLongContextRule {
  inputTokenThresholdExclusive: number;
  inputMultiplier: number;
  cachedInputMultiplier: number;
  /** Falls back to `inputMultiplier` when omitted. */
  cacheWriteInputMultiplier?: number;
  outputMultiplier: number;
}

export interface OpenAiCodexFastRule {
  supported: boolean;
  standardCostMultiplier?: number;
  /**
   * Which cost components the Fast multiplier scales. Omitted ⇒ ['tokens'] only.
   * Include 'billable_tools' only when OpenAI docs state Fast also scales
   * hosted-tool surcharges (e.g. web search).
   */
  appliesTo?: Array<'tokens' | 'billable_tools'>;
  unsupportedReason?: string;
}

export interface OpenAiModelPricing {
  model: string;
  displayName?: string;
  standard: OpenAiTokenRatesPerMillion;
  longContext?: OpenAiLongContextRule;
  codexFast?: OpenAiCodexFastRule;
}

export type OpenAiUnpricedModelReason =
  | 'not_available_in_api_pricing'
  | 'not_available_in_codex_pricing'
  | 'unknown';

export interface OpenAiUnpricedModel {
  model: string;
  reason: OpenAiUnpricedModelReason;
  note?: string;
}

export interface OpenAiBillableToolPricing {
  webSearchCall?: {
    unit: 'per_1k_calls';
    standardUsd: number;
  };
}

export interface OpenAiPricingResponseV1 {
  version: 1;
  currency: OpenAiPricingCurrency;
  tokenUnit: OpenAiPricingUnit;
  source: OpenAiPricingSourceInfo;
  cache: {
    maxAgeSeconds: number;
    staleWhileRevalidateSeconds: number;
  };
  basis: {
    tokenPricing: 'openai_api_standard';
    fastModePricing: 'codex_credit_adjusted_standard_equivalent';
    notes: string[];
  };
  serviceTierAliases: Record<string, OpenAiPricingCanonicalTier>;
  models: Record<string, OpenAiModelPricing>;
  unpricedModels: Record<string, OpenAiUnpricedModel>;
  billableTools: OpenAiBillableToolPricing;
}

// ===========================================================================
// Validator (Contract 2).
//
// Canonical contract enforcer shared by BOTH sides: the web loader validates
// before serving, and the desktop cache validates before caching. Throws on
// the first malformed field; on success returns a value typed as
// `OpenAiPricingResponseV1`.
// ===========================================================================

const VALIDATION_PREFIX = 'OpenAI pricing payload';

const CANONICAL_TIERS: readonly OpenAiPricingCanonicalTier[] = [
  'standard',
  'fast',
];
const REQUIRED_SERVICE_TIER_ALIASES: Record<
  string,
  OpenAiPricingCanonicalTier
> = {
  default: 'standard',
  standard: 'standard',
  priority: 'fast',
  fast: 'fast',
};

const UNPRICED_REASONS: readonly OpenAiUnpricedModelReason[] = [
  'not_available_in_api_pricing',
  'not_available_in_codex_pricing',
  'unknown',
];

const CODEX_FAST_APPLIES_TO: readonly ('tokens' | 'billable_tools')[] = [
  'tokens',
  'billable_tools',
];

function isCodexFastAppliesTo(
  value: unknown,
): value is (typeof CODEX_FAST_APPLIES_TO)[number] {
  return value === 'tokens' || value === 'billable_tools';
}

function isUnpricedModelReason(
  value: unknown,
): value is OpenAiUnpricedModelReason {
  return (
    value === 'not_available_in_api_pricing' ||
    value === 'not_available_in_codex_pricing' ||
    value === 'unknown'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ensureRecord(field: string, value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${VALIDATION_PREFIX} field "${field}" must be an object`);
  }
  return value;
}

function ensureString(field: string, value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error(`${VALIDATION_PREFIX} field "${field}" must be a string`);
  }
  return value;
}

function ensureNonEmptyString(field: string, value: unknown): string {
  const str = ensureString(field, value);
  if (str.length === 0) {
    throw new Error(`${VALIDATION_PREFIX} field "${field}" must be non-empty`);
  }
  return str;
}

function ensureOptionalString(
  field: string,
  value: unknown,
): string | undefined {
  if (value === undefined) return undefined;
  return ensureString(field, value);
}

function ensureFiniteNumber(field: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(
      `${VALIDATION_PREFIX} field "${field}" must be a finite number`,
    );
  }
  return value;
}

/** Finite and >= 0. Rejects negative rates and non-finite numbers. */
function ensureNonNegativeNumber(field: string, value: unknown): number {
  const num = ensureFiniteNumber(field, value);
  if (num < 0) {
    throw new Error(
      `${VALIDATION_PREFIX} field "${field}" must not be negative`,
    );
  }
  return num;
}

/** Finite and > 0. Used for multipliers and thresholds. */
function ensurePositiveNumber(field: string, value: unknown): number {
  const num = ensureFiniteNumber(field, value);
  if (num <= 0) {
    throw new Error(`${VALIDATION_PREFIX} field "${field}" must be positive`);
  }
  return num;
}

function ensureBoolean(field: string, value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${VALIDATION_PREFIX} field "${field}" must be a boolean`);
  }
  return value;
}

function ensureLiteral<T extends string | number>(
  field: string,
  value: unknown,
  expected: T,
): T {
  if (value !== expected) {
    throw new Error(
      `${VALIDATION_PREFIX} field "${field}" must equal ${JSON.stringify(
        expected,
      )}`,
    );
  }
  return expected;
}

function ensureIsoTimestamp(field: string, value: unknown): string {
  const str = ensureString(field, value);
  if (str.length === 0 || Number.isNaN(Date.parse(str))) {
    throw new Error(
      `${VALIDATION_PREFIX} field "${field}" must be a valid ISO 8601 timestamp`,
    );
  }
  return str;
}

function ensureStringArray(field: string, value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${VALIDATION_PREFIX} field "${field}" must be an array`);
  }
  return value.map((entry, index) => ensureString(`${field}[${index}]`, entry));
}

function parseSource(value: unknown): OpenAiPricingSourceInfo {
  const source = ensureRecord('source', value);
  return {
    pricingUrl: ensureNonEmptyString('source.pricingUrl', source.pricingUrl),
    codexPricingUrl: ensureNonEmptyString(
      'source.codexPricingUrl',
      source.codexPricingUrl,
    ),
    codexSpeedUrl: ensureNonEmptyString(
      'source.codexSpeedUrl',
      source.codexSpeedUrl,
    ),
    fetchedAt: ensureIsoTimestamp('source.fetchedAt', source.fetchedAt),
    generatedBy: ensureNonEmptyString('source.generatedBy', source.generatedBy),
  };
}

function parseCache(value: unknown): OpenAiPricingResponseV1['cache'] {
  const cache = ensureRecord('cache', value);
  return {
    maxAgeSeconds: ensureNonNegativeNumber(
      'cache.maxAgeSeconds',
      cache.maxAgeSeconds,
    ),
    staleWhileRevalidateSeconds: ensureNonNegativeNumber(
      'cache.staleWhileRevalidateSeconds',
      cache.staleWhileRevalidateSeconds,
    ),
  };
}

function parseBasis(value: unknown): OpenAiPricingResponseV1['basis'] {
  const basis = ensureRecord('basis', value);
  return {
    tokenPricing: ensureLiteral(
      'basis.tokenPricing',
      basis.tokenPricing,
      'openai_api_standard',
    ),
    fastModePricing: ensureLiteral(
      'basis.fastModePricing',
      basis.fastModePricing,
      'codex_credit_adjusted_standard_equivalent',
    ),
    notes: ensureStringArray('basis.notes', basis.notes),
  };
}

function isRequiredServiceTierAlias(alias: string): boolean {
  return Object.prototype.hasOwnProperty.call(
    REQUIRED_SERVICE_TIER_ALIASES,
    alias,
  );
}

function parseServiceTierAliases(
  value: unknown,
): Record<string, OpenAiPricingCanonicalTier> {
  const aliases = ensureRecord('serviceTierAliases', value);
  const result: Record<string, OpenAiPricingCanonicalTier> = {};
  for (const [key, target] of Object.entries(aliases)) {
    const field = `serviceTierAliases.${key}`;
    if (target === 'standard' || target === 'fast') {
      result[key] = target;
      continue;
    }
    if (isRequiredServiceTierAlias(key)) {
      throw new Error(
        `${VALIDATION_PREFIX} field "${field}" must be one of ${JSON.stringify(
          CANONICAL_TIERS,
        )}`,
      );
    }
    // Forward compatibility: a newer payload may alias an optional tier to a
    // canonical tier this client does not know (for example
    // `ultrafast: "ultrafast"`). Drop that alias instead of rejecting every
    // rate, and never coerce it to Standard or Fast: the cost calculator
    // leaves the tier unpriced. A non-string or empty target is malformed.
    ensureNonEmptyString(field, target);
  }

  for (const [alias, target] of Object.entries(REQUIRED_SERVICE_TIER_ALIASES)) {
    if (result[alias] !== target) {
      throw new Error(
        `${VALIDATION_PREFIX} field "serviceTierAliases.${alias}" must be "${target}"`,
      );
    }
  }
  return result;
}

function parseTokenRates(
  field: string,
  value: unknown,
): OpenAiTokenRatesPerMillion {
  const rates = ensureRecord(field, value);
  const cacheWriteInput =
    rates.cacheWriteInput === undefined
      ? undefined
      : ensureNonNegativeNumber(
          `${field}.cacheWriteInput`,
          rates.cacheWriteInput,
        );
  return {
    input: ensureNonNegativeNumber(`${field}.input`, rates.input),
    cachedInput: ensureNonNegativeNumber(
      `${field}.cachedInput`,
      rates.cachedInput,
    ),
    ...(cacheWriteInput !== undefined ? { cacheWriteInput } : {}),
    output: ensureNonNegativeNumber(`${field}.output`, rates.output),
  };
}

function parseLongContext(
  field: string,
  value: unknown,
): OpenAiLongContextRule {
  const rule = ensureRecord(field, value);
  const cacheWriteInputMultiplier =
    rule.cacheWriteInputMultiplier === undefined
      ? undefined
      : ensurePositiveNumber(
          `${field}.cacheWriteInputMultiplier`,
          rule.cacheWriteInputMultiplier,
        );
  return {
    inputTokenThresholdExclusive: ensurePositiveNumber(
      `${field}.inputTokenThresholdExclusive`,
      rule.inputTokenThresholdExclusive,
    ),
    inputMultiplier: ensurePositiveNumber(
      `${field}.inputMultiplier`,
      rule.inputMultiplier,
    ),
    cachedInputMultiplier: ensurePositiveNumber(
      `${field}.cachedInputMultiplier`,
      rule.cachedInputMultiplier,
    ),
    ...(cacheWriteInputMultiplier !== undefined
      ? { cacheWriteInputMultiplier }
      : {}),
    outputMultiplier: ensurePositiveNumber(
      `${field}.outputMultiplier`,
      rule.outputMultiplier,
    ),
  };
}

function parseCodexFast(field: string, value: unknown): OpenAiCodexFastRule {
  const rule = ensureRecord(field, value);
  const supported = ensureBoolean(`${field}.supported`, rule.supported);

  let appliesTo: Array<'tokens' | 'billable_tools'> | undefined;
  if (rule.appliesTo !== undefined) {
    if (!Array.isArray(rule.appliesTo)) {
      throw new Error(
        `${VALIDATION_PREFIX} field "${field}.appliesTo" must be an array`,
      );
    }
    appliesTo = rule.appliesTo.map((entry, index) => {
      if (!isCodexFastAppliesTo(entry)) {
        throw new Error(
          `${VALIDATION_PREFIX} field "${field}.appliesTo[${index}]" must be one of ${JSON.stringify(
            CODEX_FAST_APPLIES_TO,
          )}`,
        );
      }
      return entry;
    });
  }

  let standardCostMultiplier: number | undefined;
  if (supported) {
    // supported === true requires a finite positive standardCostMultiplier.
    standardCostMultiplier = ensurePositiveNumber(
      `${field}.standardCostMultiplier`,
      rule.standardCostMultiplier,
    );
  } else if (rule.standardCostMultiplier !== undefined) {
    // When present alongside an unsupported rule it must still be sane.
    standardCostMultiplier = ensurePositiveNumber(
      `${field}.standardCostMultiplier`,
      rule.standardCostMultiplier,
    );
  }

  const unsupportedReason = ensureOptionalString(
    `${field}.unsupportedReason`,
    rule.unsupportedReason,
  );

  return {
    supported,
    ...(standardCostMultiplier !== undefined ? { standardCostMultiplier } : {}),
    ...(appliesTo !== undefined ? { appliesTo } : {}),
    ...(unsupportedReason !== undefined ? { unsupportedReason } : {}),
  };
}

function parseModels(value: unknown): Record<string, OpenAiModelPricing> {
  const models = ensureRecord('models', value);
  const result: Record<string, OpenAiModelPricing> = {};
  for (const [key, raw] of Object.entries(models)) {
    const field = `models.${key}`;
    const model = ensureRecord(field, raw);
    const parsed: OpenAiModelPricing = {
      model: ensureNonEmptyString(`${field}.model`, model.model),
      standard: parseTokenRates(`${field}.standard`, model.standard),
    };
    if (parsed.model !== key) {
      throw new Error(
        `${VALIDATION_PREFIX} field "${field}.model" must equal its map key "${key}"`,
      );
    }
    const displayName = ensureOptionalString(
      `${field}.displayName`,
      model.displayName,
    );
    if (displayName !== undefined) parsed.displayName = displayName;
    if (model.longContext !== undefined) {
      parsed.longContext = parseLongContext(
        `${field}.longContext`,
        model.longContext,
      );
    }
    if (model.codexFast !== undefined) {
      parsed.codexFast = parseCodexFast(`${field}.codexFast`, model.codexFast);
    }
    result[key] = parsed;
  }
  return result;
}

function parseUnpricedModels(
  value: unknown,
): Record<string, OpenAiUnpricedModel> {
  const unpriced = ensureRecord('unpricedModels', value);
  const result: Record<string, OpenAiUnpricedModel> = {};
  for (const [key, raw] of Object.entries(unpriced)) {
    const field = `unpricedModels.${key}`;
    const entry = ensureRecord(field, raw);
    const reason = ensureString(`${field}.reason`, entry.reason);
    if (!isUnpricedModelReason(reason)) {
      throw new Error(
        `${VALIDATION_PREFIX} field "${field}.reason" must be one of ${JSON.stringify(
          UNPRICED_REASONS,
        )}`,
      );
    }
    const parsed: OpenAiUnpricedModel = {
      model: ensureNonEmptyString(`${field}.model`, entry.model),
      reason,
    };
    if (parsed.model !== key) {
      throw new Error(
        `${VALIDATION_PREFIX} field "${field}.model" must equal its map key "${key}"`,
      );
    }
    const note = ensureOptionalString(`${field}.note`, entry.note);
    if (note !== undefined) parsed.note = note;
    result[key] = parsed;
  }
  return result;
}

function parseBillableTools(value: unknown): OpenAiBillableToolPricing {
  const tools = ensureRecord('billableTools', value);
  const result: OpenAiBillableToolPricing = {};
  if (tools.webSearchCall !== undefined) {
    const webSearch = ensureRecord(
      'billableTools.webSearchCall',
      tools.webSearchCall,
    );
    result.webSearchCall = {
      unit: ensureLiteral(
        'billableTools.webSearchCall.unit',
        webSearch.unit,
        'per_1k_calls',
      ),
      standardUsd: ensureNonNegativeNumber(
        'billableTools.webSearchCall.standardUsd',
        webSearch.standardUsd,
      ),
    };
  }
  return result;
}

/**
 * Validate an unknown value as an {@link OpenAiPricingResponseV1}. Throws on
 * the first malformed field (unsupported version, negative/non-finite rates,
 * missing model keys, invalid timestamps, missing or retargeted required
 * aliases, non-string alias targets, bad `codexFast`, etc.). An optional alias
 * whose target is a canonical tier this client does not know is dropped, so
 * that tier stays unpriced. On success returns the value typed as the contract.
 */
export function parseOpenAiPricingResponse(
  value: unknown,
): OpenAiPricingResponseV1 {
  const root = ensureRecord('<root>', value);
  ensureLiteral('version', root.version, 1);
  const models = parseModels(root.models);
  const unpricedModels = parseUnpricedModels(root.unpricedModels);
  for (const model of Object.keys(models)) {
    if (unpricedModels[model] !== undefined) {
      throw new Error(
        `${VALIDATION_PREFIX} model "${model}" cannot appear in both models and unpricedModels`,
      );
    }
  }

  return {
    version: 1,
    currency: ensureLiteral('currency', root.currency, 'usd'),
    tokenUnit: ensureLiteral('tokenUnit', root.tokenUnit, 'per_1m_tokens'),
    source: parseSource(root.source),
    cache: parseCache(root.cache),
    basis: parseBasis(root.basis),
    serviceTierAliases: parseServiceTierAliases(root.serviceTierAliases),
    models,
    unpricedModels,
    billableTools: parseBillableTools(root.billableTools),
  };
}
