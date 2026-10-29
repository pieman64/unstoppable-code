import type { AgentObservedCost } from '@canopy/desktop-shared/types';
import type {
  OpenAiModelPricing,
  OpenAiPricingCanonicalTier,
  OpenAiPricingResponseV1,
} from '@canopy/protocol/openai-pricing';
import type { OpenAiPricingCacheState } from './pricing-client';

export interface CodexObservedCostInput {
  model?: string;
  serviceTier?: string;
  usageObserved: boolean;
  tokens: {
    input: number;
    output: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    reasoningOutputTokens?: number;
  };
  billableToolCounts?: {
    openAiWebSearchCalls?: number;
  };
}

function unpriced(
  reason: AgentObservedCost['reason'],
  input: CodexObservedCostInput,
  componentLabel = 'Codex token usage',
): AgentObservedCost {
  return {
    status: 'unpriced',
    reason,
    currency: 'usd',
    model: input.model,
    serviceTier: input.serviceTier,
    components: [
      {
        kind: 'unpriced_tokens',
        label: componentLabel,
        reason,
      },
    ],
  };
}

/**
 * Resolves the requested tier through the payload's exact aliases only. An
 * absent tier is the Codex `default` request. A tier without its own alias
 * entry (a tier this client does not know, a casing variant, or an inherited
 * `Object.prototype` key) resolves to `undefined` so the caller leaves the turn
 * unpriced instead of falling through to Standard or Fast rates.
 */
function resolveCanonicalServiceTier(
  aliases: OpenAiPricingResponseV1['serviceTierAliases'],
  serviceTier: string | undefined,
): OpenAiPricingCanonicalTier | undefined {
  const requestedTier = serviceTier ?? 'default';
  if (!Object.prototype.hasOwnProperty.call(aliases, requestedTier)) {
    return undefined;
  }
  return aliases[requestedTier];
}

function unsupportedServiceTier(
  input: CodexObservedCostInput,
  openAiWebSearchCalls: number,
): AgentObservedCost {
  const cost = unpriced('unsupported_service_tier', input);
  if (openAiWebSearchCalls > 0) {
    // Tool surcharges are not priced at Standard rates either: whether a tier
    // scales them is unknown without an exact tier rule.
    cost.components.push({
      kind: 'unpriced_tool',
      label: 'OpenAI web search calls',
      quantity: openAiWebSearchCalls,
      unit: 'calls',
      reason: 'unsupported_service_tier',
    });
  }
  return cost;
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function roundUsd(value: number): number {
  return Number(value.toFixed(12));
}

function pricingSource(
  pricingState: OpenAiPricingCacheState,
  pricing: NonNullable<OpenAiPricingCacheState['payload']>,
): NonNullable<AgentObservedCost['pricingSource']> {
  return {
    type: 'canopy_openai_pricing',
    fetchedAt: pricingState.fetchedAt ?? pricing.source.fetchedAt,
    pricingUrl: pricing.source.pricingUrl,
    codexPricingUrl: pricing.source.codexPricingUrl,
    codexSpeedUrl: pricing.source.codexSpeedUrl,
  };
}

function appliesToTokens(model: OpenAiModelPricing): boolean {
  return model.codexFast?.appliesTo?.includes('tokens') ?? true;
}

function appliesToBillableTools(model: OpenAiModelPricing): boolean {
  return model.codexFast?.appliesTo?.includes('billable_tools') ?? false;
}

export function computeCodexObservedCost(
  input: CodexObservedCostInput,
  pricingState: OpenAiPricingCacheState,
): AgentObservedCost {
  if (!input.model) {
    return unpriced('model_missing', input);
  }
  if (!input.usageObserved) {
    return unpriced(
      'unsupported_usage_shape',
      input,
      'Codex token usage was not observed',
    );
  }

  const pricing = pricingState.payload;
  if (!pricing) {
    return unpriced('pricing_unavailable', input);
  }

  const openAiWebSearchCalls = Math.max(
    0,
    input.billableToolCounts?.openAiWebSearchCalls ?? 0,
  );
  const canonicalTier = resolveCanonicalServiceTier(
    pricing.serviceTierAliases,
    input.serviceTier,
  );
  if (canonicalTier === undefined) {
    return unsupportedServiceTier(input, openAiWebSearchCalls);
  }
  const model = pricing.models[input.model];
  if (pricing.unpricedModels[input.model] || !model) {
    const webSearch = pricing.billableTools.webSearchCall;
    if (openAiWebSearchCalls > 0 && webSearch) {
      const nonTokenUsd = roundUsd(
        (openAiWebSearchCalls * webSearch.standardUsd) / 1_000,
      );
      return {
        status: 'partially_priced',
        reason: 'model_not_priced',
        currency: 'usd',
        totalUsd: nonTokenUsd,
        tokenUsd: 0,
        nonTokenUsd,
        pricingSource: pricingSource(pricingState, pricing),
        pricingBasis: 'openai_api_standard',
        model: input.model,
        serviceTier: input.serviceTier,
        canonicalServiceTier: canonicalTier,
        contextTier: 'unknown',
        contextTierSource: 'unknown',
        longContextApplied: false,
        components: [
          {
            kind: 'unpriced_tokens',
            label: 'Codex token usage',
            reason: 'model_not_priced',
          },
          {
            kind: 'web_search_call',
            label: 'OpenAI web search calls',
            quantity: openAiWebSearchCalls,
            unit: 'calls',
            usd: nonTokenUsd,
          },
        ],
      };
    }
    return unpriced('model_not_priced', input);
  }

  const cachedInput = Math.max(0, input.tokens.cacheReadInputTokens);
  const cacheCreationInput = Math.max(0, input.tokens.cacheCreationInputTokens);
  const inputTokens = Math.max(0, input.tokens.input);
  const outputTokens = Math.max(0, input.tokens.output);
  const uncachedInput = Math.max(
    0,
    inputTokens - cachedInput - cacheCreationInput,
  );

  const longContext = model.longContext;
  const longContextApplied =
    longContext !== undefined &&
    inputTokens > longContext.inputTokenThresholdExclusive;
  const contextTier = longContextApplied ? 'long' : 'standard';
  const contextTierSource =
    longContext !== undefined ? 'pricing_payload_threshold' : 'not_applicable';

  let inputRate = model.standard.input;
  let cachedInputRate = model.standard.cachedInput;
  let cacheWriteInputRate =
    model.standard.cacheWriteInput ?? model.standard.input;
  let outputRate = model.standard.output;
  if (longContextApplied && longContext) {
    inputRate *= longContext.inputMultiplier;
    cachedInputRate *= longContext.cachedInputMultiplier;
    cacheWriteInputRate *=
      longContext.cacheWriteInputMultiplier ?? longContext.inputMultiplier;
    outputRate *= longContext.outputMultiplier;
  }

  let tokenUsd =
    (uncachedInput * inputRate) / 1_000_000 +
    (cacheCreationInput * cacheWriteInputRate) / 1_000_000 +
    (cachedInput * cachedInputRate) / 1_000_000 +
    (outputTokens * outputRate) / 1_000_000;
  let pricingBasis: AgentObservedCost['pricingBasis'] = 'openai_api_standard';
  let fastModeMultiplierApplied: number | undefined;

  if (canonicalTier === 'fast') {
    const fast = model.codexFast;
    if (
      !fast ||
      fast.supported !== true ||
      !finitePositive(fast.standardCostMultiplier)
    ) {
      return {
        ...unpriced('unsupported_fast_pricing', input),
        canonicalServiceTier: canonicalTier,
        contextTier,
        contextTierSource,
        longContextApplied,
      };
    }
    fastModeMultiplierApplied = fast.standardCostMultiplier;
    pricingBasis = 'codex_credit_adjusted_standard_equivalent';
    if (appliesToTokens(model)) {
      tokenUsd *= fast.standardCostMultiplier;
    }
  }

  const components: AgentObservedCost['components'] = [
    {
      kind: 'tokens',
      label: 'Codex token usage',
      quantity: inputTokens + outputTokens,
      unit: 'tokens',
      usd: roundUsd(tokenUsd),
    },
  ];
  let nonTokenUsd = 0;
  let hasUnpricedTool = false;
  if (openAiWebSearchCalls > 0) {
    const webSearch = pricing.billableTools.webSearchCall;
    if (webSearch) {
      let webSearchUsd = (openAiWebSearchCalls * webSearch.standardUsd) / 1_000;
      if (
        canonicalTier === 'fast' &&
        fastModeMultiplierApplied !== undefined &&
        appliesToBillableTools(model)
      ) {
        webSearchUsd *= fastModeMultiplierApplied;
      }
      nonTokenUsd += webSearchUsd;
      components.push({
        kind: 'web_search_call',
        label:
          canonicalTier === 'fast' && appliesToBillableTools(model)
            ? 'OpenAI web search calls (Fast multiplier applied)'
            : 'OpenAI web search calls',
        quantity: openAiWebSearchCalls,
        unit: 'calls',
        usd: roundUsd(webSearchUsd),
      });
    } else {
      hasUnpricedTool = true;
      components.push({
        kind: 'unpriced_tool',
        label: 'OpenAI web search calls',
        quantity: openAiWebSearchCalls,
        unit: 'calls',
        reason: 'billable_tool_pricing_unavailable',
      });
    }
  }

  const totalUsd = tokenUsd + nonTokenUsd;
  return {
    status: hasUnpricedTool ? 'partially_priced' : 'priced',
    reason: hasUnpricedTool ? 'billable_tool_pricing_unavailable' : 'priced',
    currency: 'usd',
    totalUsd: roundUsd(totalUsd),
    tokenUsd: roundUsd(tokenUsd),
    nonTokenUsd: roundUsd(nonTokenUsd),
    pricingSource: pricingSource(pricingState, pricing),
    pricingBasis,
    model: input.model,
    serviceTier: input.serviceTier,
    canonicalServiceTier: canonicalTier,
    contextTier,
    contextTierSource,
    longContextApplied,
    ...(fastModeMultiplierApplied !== undefined
      ? { fastModeMultiplierApplied }
      : {}),
    components,
  };
}
