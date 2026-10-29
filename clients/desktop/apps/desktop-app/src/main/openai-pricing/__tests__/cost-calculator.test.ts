import {
  parseOpenAiPricingResponse,
  type OpenAiPricingResponseV1,
} from '@canopy/protocol/openai-pricing';
import { computeCodexObservedCost } from '../cost-calculator';
import type { OpenAiPricingCacheState } from '../pricing-client';

const pricingPayload: OpenAiPricingResponseV1 = {
  version: 1,
  currency: 'usd',
  tokenUnit: 'per_1m_tokens',
  source: {
    pricingUrl: 'https://developers.openai.com/api/docs/pricing',
    codexPricingUrl: 'https://developers.openai.com/codex/pricing',
    codexSpeedUrl: 'https://developers.openai.com/codex/speed',
    fetchedAt: '2026-06-18T00:00:00.000Z',
    generatedBy: 'test',
  },
  cache: { maxAgeSeconds: 3600, staleWhileRevalidateSeconds: 86400 },
  basis: {
    tokenPricing: 'openai_api_standard',
    fastModePricing: 'codex_credit_adjusted_standard_equivalent',
    notes: ['cache-creation input billed as uncached input'],
  },
  serviceTierAliases: {
    default: 'standard',
    standard: 'standard',
    priority: 'fast',
    fast: 'fast',
  },
  models: {
    'gpt-6-astra': {
      model: 'gpt-6-astra',
      displayName: 'GPT-6 Astra',
      standard: {
        input: 10,
        cachedInput: 1,
        cacheWriteInput: 12.5,
        output: 50,
      },
      longContext: {
        inputTokenThresholdExclusive: 272000,
        inputMultiplier: 2,
        cachedInputMultiplier: 2,
        cacheWriteInputMultiplier: 2,
        outputMultiplier: 1.5,
      },
      codexFast: {
        supported: true,
        standardCostMultiplier: 2.5,
        appliesTo: ['tokens'],
      },
    },
    priced: {
      model: 'priced',
      standard: {
        input: 10,
        cachedInput: 1,
        cacheWriteInput: 12.5,
        output: 30,
      },
      longContext: {
        inputTokenThresholdExclusive: 1000,
        inputMultiplier: 2,
        cachedInputMultiplier: 2,
        cacheWriteInputMultiplier: 2,
        outputMultiplier: 1.5,
      },
      codexFast: {
        supported: true,
        standardCostMultiplier: 2,
        appliesTo: ['tokens'],
      },
    },
    noFast: {
      model: 'noFast',
      standard: { input: 1, cachedInput: 0.1, output: 2 },
      codexFast: { supported: false },
    },
  },
  unpricedModels: {
    spark: { model: 'spark', reason: 'not_available_in_api_pricing' },
  },
  billableTools: {
    webSearchCall: { unit: 'per_1k_calls', standardUsd: 10 },
  },
};

function pricingState(
  payload?: OpenAiPricingResponseV1,
): OpenAiPricingCacheState {
  const resolvedPayload = arguments.length === 0 ? pricingPayload : payload;
  return {
    payload: resolvedPayload,
    fetchedAt: '2026-06-18T00:00:00.000Z',
    loadedFrom: resolvedPayload ? 'memory' : 'none',
    stale: false,
  };
}

const baseInput = {
  model: 'priced',
  usageObserved: true,
  tokens: {
    input: 1000,
    output: 100,
    cacheReadInputTokens: 100,
    cacheCreationInputTokens: 50,
    reasoningOutputTokens: 25,
  },
};

describe('computeCodexObservedCost', () => {
  it('looks up and prices GPT-6 Astra by its exact model id', () => {
    const cost = computeCodexObservedCost(
      { ...baseInput, model: 'gpt-6-astra' },
      pricingState(),
    );

    expect(cost.status).toBe('priced');
    expect(cost.tokenUsd).toBe(0.014225);
    expect(cost.totalUsd).toBe(0.014225);
    expect(cost.contextTier).toBe('standard');
  });

  it('applies GPT-6 Astra long-context rates above 272K input tokens', () => {
    const cost = computeCodexObservedCost(
      {
        ...baseInput,
        model: 'gpt-6-astra',
        tokens: { ...baseInput.tokens, input: 272001 },
      },
      pricingState(),
    );

    expect(cost.contextTier).toBe('long');
    expect(cost.longContextApplied).toBe(true);
    expect(cost.tokenUsd).toBe(5.44597);
  });

  it('keeps GPT-6 Astra at Standard rates at exactly 272K input tokens', () => {
    const cost = computeCodexObservedCost(
      {
        ...baseInput,
        model: 'gpt-6-astra',
        tokens: { ...baseInput.tokens, input: 272000 },
      },
      pricingState(),
    );

    expect(cost.contextTier).toBe('standard');
    expect(cost.longContextApplied).toBe(false);
    expect(cost.tokenUsd).toBe(2.724225);
  });

  it('applies the GPT-6 Astra Codex Fast credit multiplier', () => {
    const cost = computeCodexObservedCost(
      { ...baseInput, model: 'gpt-6-astra', serviceTier: 'priority' },
      pricingState(),
    );

    expect(cost.canonicalServiceTier).toBe('fast');
    expect(cost.fastModeMultiplierApplied).toBe(2.5);
    expect(cost.tokenUsd).toBe(0.0355625);
    expect(cost.pricingBasis).toBe('codex_credit_adjusted_standard_equivalent');
  });

  it('prices standard tokens including model-specific cache writes', () => {
    const cost = computeCodexObservedCost(baseInput, pricingState());

    expect(cost.status).toBe('priced');
    expect(cost.tokenUsd).toBe(0.012225);
    expect(cost.totalUsd).toBe(0.012225);
    expect(cost.contextTier).toBe('standard');
  });

  it('falls back to uncached input pricing when no cache-write rate exists', () => {
    const cost = computeCodexObservedCost(
      { ...baseInput, model: 'noFast' },
      pricingState(),
    );

    expect(cost.status).toBe('priced');
    expect(cost.tokenUsd).toBe(0.00111);
  });

  it('applies long-context multipliers from the payload threshold', () => {
    const cost = computeCodexObservedCost(
      {
        ...baseInput,
        tokens: { ...baseInput.tokens, input: 1001 },
      },
      pricingState(),
    );

    expect(cost.contextTier).toBe('long');
    expect(cost.longContextApplied).toBe(true);
    expect(cost.tokenUsd).toBeGreaterThan(0.012225);
  });

  it('applies Fast multiplier from the payload', () => {
    const cost = computeCodexObservedCost(
      { ...baseInput, serviceTier: 'priority' },
      pricingState(),
    );

    expect(cost.canonicalServiceTier).toBe('fast');
    expect(cost.fastModeMultiplierApplied).toBe(2);
    expect(cost.tokenUsd).toBe(0.02445);
    expect(cost.pricingBasis).toBe('codex_credit_adjusted_standard_equivalent');
  });

  it('marks unsupported Fast pricing unpriced', () => {
    const cost = computeCodexObservedCost(
      { ...baseInput, model: 'noFast', serviceTier: 'priority' },
      pricingState(),
    );

    expect(cost.status).toBe('unpriced');
    expect(cost.reason).toBe('unsupported_fast_pricing');
    expect(cost.totalUsd).toBeUndefined();
  });

  it('marks unpriced models and unavailable pricing explicitly', () => {
    expect(
      computeCodexObservedCost({ ...baseInput, model: 'spark' }, pricingState())
        .reason,
    ).toBe('model_not_priced');
    expect(
      computeCodexObservedCost(baseInput, pricingState(undefined)).reason,
    ).toBe('pricing_unavailable');
  });

  it('preserves priced web-search costs when token pricing is unavailable', () => {
    const cost = computeCodexObservedCost(
      {
        ...baseInput,
        model: 'spark',
        billableToolCounts: { openAiWebSearchCalls: 2 },
      },
      pricingState(),
    );

    expect(cost.status).toBe('partially_priced');
    expect(cost.reason).toBe('model_not_priced');
    expect(cost.tokenUsd).toBe(0);
    expect(cost.nonTokenUsd).toBe(0.02);
    expect(cost.totalUsd).toBe(0.02);
    expect(cost.contextTier).toBe('unknown');
    expect(
      cost.components.find((component) => component.kind === 'unpriced_tokens'),
    ).toMatchObject({
      label: 'Codex token usage',
      reason: 'model_not_priced',
    });
    expect(
      cost.components.find((component) => component.kind === 'web_search_call'),
    ).toMatchObject({
      label: 'OpenAI web search calls',
      quantity: 2,
      usd: 0.02,
    });
  });

  it('includes priced web-search calls as non-token cost', () => {
    const cost = computeCodexObservedCost(
      { ...baseInput, billableToolCounts: { openAiWebSearchCalls: 2 } },
      pricingState(),
    );

    expect(cost.nonTokenUsd).toBe(0.02);
    expect(cost.totalUsd).toBe(0.032225);
    expect(
      cost.components.some((component) => component.kind === 'web_search_call'),
    ).toBe(true);
  });

  it('marks missing web-search pricing as partially priced', () => {
    const payloadWithoutWebSearch = {
      ...pricingPayload,
      billableTools: {},
    };
    const cost = computeCodexObservedCost(
      { ...baseInput, billableToolCounts: { openAiWebSearchCalls: 2 } },
      pricingState(payloadWithoutWebSearch),
    );

    expect(cost.status).toBe('partially_priced');
    expect(cost.reason).toBe('billable_tool_pricing_unavailable');
    expect(cost.totalUsd).toBe(0.012225);
    expect(
      cost.components.find((component) => component.kind === 'unpriced_tool'),
    ).toMatchObject({
      label: 'OpenAI web search calls',
      quantity: 2,
      reason: 'billable_tool_pricing_unavailable',
    });
  });

  it('does not price missing usage as zero', () => {
    const cost = computeCodexObservedCost(
      { ...baseInput, usageObserved: false },
      pricingState(),
    );

    expect(cost.status).toBe('unpriced');
    expect(cost.reason).toBe('unsupported_usage_shape');
    expect(cost.totalUsd).toBeUndefined();
  });

  describe('requested service tiers', () => {
    it.each(['default', 'standard'])(
      'prices the %p request at Standard rates',
      (serviceTier) => {
        const cost = computeCodexObservedCost(
          { ...baseInput, serviceTier },
          pricingState(),
        );

        expect(cost.status).toBe('priced');
        expect(cost.canonicalServiceTier).toBe('standard');
        expect(cost.pricingBasis).toBe('openai_api_standard');
        expect(cost.fastModeMultiplierApplied).toBeUndefined();
        expect(cost.tokenUsd).toBe(0.012225);
      },
    );

    it('prices the fast request exactly like priority', () => {
      const cost = computeCodexObservedCost(
        { ...baseInput, serviceTier: 'fast' },
        pricingState(),
      );

      expect(cost.canonicalServiceTier).toBe('fast');
      expect(cost.fastModeMultiplierApplied).toBe(2);
      expect(cost.tokenUsd).toBe(0.02445);
    });

    it('leaves Ultra fast unpriced with the exact unsupported-tier reason', () => {
      const cost = computeCodexObservedCost(
        { ...baseInput, model: 'gpt-6-astra', serviceTier: 'ultrafast' },
        pricingState(),
      );

      expect(cost).toEqual({
        status: 'unpriced',
        reason: 'unsupported_service_tier',
        currency: 'usd',
        model: 'gpt-6-astra',
        serviceTier: 'ultrafast',
        components: [
          {
            kind: 'unpriced_tokens',
            label: 'Codex token usage',
            reason: 'unsupported_service_tier',
          },
        ],
      });
    });

    it.each([
      'flex',
      'scale',
      'ultra_fast',
      'Priority',
      'FAST',
      ' priority',
      'constructor',
      'toString',
      '__proto__',
    ])(
      'never falls through to Standard or Fast token or tool rates for the %p request',
      (serviceTier) => {
        const cost = computeCodexObservedCost(
          {
            ...baseInput,
            serviceTier,
            billableToolCounts: { openAiWebSearchCalls: 2 },
          },
          pricingState(),
        );

        expect(cost.status).toBe('unpriced');
        expect(cost.reason).toBe('unsupported_service_tier');
        expect(cost.serviceTier).toBe(serviceTier);
        expect(cost.totalUsd).toBeUndefined();
        expect(cost.tokenUsd).toBeUndefined();
        expect(cost.nonTokenUsd).toBeUndefined();
        expect(cost.canonicalServiceTier).toBeUndefined();
        expect(cost.fastModeMultiplierApplied).toBeUndefined();
        expect(cost.pricingBasis).toBeUndefined();
        expect(
          cost.components.filter((component) => component.usd !== undefined),
        ).toEqual([]);
      },
    );

    it('does not price web-search calls at Standard rates for an unsupported tier', () => {
      const cost = computeCodexObservedCost(
        {
          ...baseInput,
          serviceTier: 'ultrafast',
          billableToolCounts: { openAiWebSearchCalls: 2 },
        },
        pricingState(),
      );

      expect(cost.status).toBe('unpriced');
      expect(cost.reason).toBe('unsupported_service_tier');
      expect(cost.totalUsd).toBeUndefined();
      expect(cost.nonTokenUsd).toBeUndefined();
      expect(cost.components).toEqual([
        {
          kind: 'unpriced_tokens',
          label: 'Codex token usage',
          reason: 'unsupported_service_tier',
        },
        {
          kind: 'unpriced_tool',
          label: 'OpenAI web search calls',
          quantity: 2,
          unit: 'calls',
          reason: 'unsupported_service_tier',
        },
      ]);
    });

    it('adds no Standard web-search surcharge for an unsupported tier on a model without API pricing', () => {
      const cost = computeCodexObservedCost(
        {
          ...baseInput,
          model: 'spark',
          serviceTier: 'ultrafast',
          billableToolCounts: { openAiWebSearchCalls: 2 },
        },
        pricingState(),
      );

      expect(cost.status).toBe('unpriced');
      expect(cost.reason).toBe('unsupported_service_tier');
      expect(cost.totalUsd).toBeUndefined();
      expect(cost.nonTokenUsd).toBeUndefined();
      expect(cost.canonicalServiceTier).toBeUndefined();
      expect(cost.pricingBasis).toBeUndefined();
      expect(cost.components).toEqual([
        {
          kind: 'unpriced_tokens',
          label: 'Codex token usage',
          reason: 'unsupported_service_tier',
        },
        {
          kind: 'unpriced_tool',
          label: 'OpenAI web search calls',
          quantity: 2,
          unit: 'calls',
          reason: 'unsupported_service_tier',
        },
      ]);
    });

    it('stays unpriced when a newer payload aliases the tier to a canonical tier this client does not know', () => {
      const newerAliases: Record<string, string> = {
        ...pricingPayload.serviceTierAliases,
        ultrafast: 'ultrafast',
      };
      const newerPayload: unknown = JSON.parse(
        JSON.stringify({ ...pricingPayload, serviceTierAliases: newerAliases }),
      );

      const cost = computeCodexObservedCost(
        { ...baseInput, model: 'gpt-6-astra', serviceTier: 'ultrafast' },
        pricingState(parseOpenAiPricingResponse(newerPayload)),
      );

      expect(cost.status).toBe('unpriced');
      expect(cost.reason).toBe('unsupported_service_tier');
      expect(cost.serviceTier).toBe('ultrafast');
      expect(cost.totalUsd).toBeUndefined();
    });
  });
});
