import {
  parseOpenAiPricingResponse,
  type OpenAiPricingResponseV1,
} from '../index';

/**
 * A complete, valid `OpenAiPricingResponseV1`. Tests clone and mutate this so
 * each rejection case differs from the canonical payload by exactly one field.
 */
function validPayload(): OpenAiPricingResponseV1 {
  return {
    version: 1,
    currency: 'usd',
    tokenUnit: 'per_1m_tokens',
    source: {
      pricingUrl: 'https://openai.com/api/pricing',
      codexPricingUrl: 'https://openai.com/codex/pricing',
      codexSpeedUrl: 'https://openai.com/codex/speed',
      fetchedAt: '2026-06-18T00:00:00.000Z',
      generatedBy: 'generate-openai-pricing.ts',
    },
    cache: {
      maxAgeSeconds: 3600,
      staleWhileRevalidateSeconds: 86400,
    },
    basis: {
      tokenPricing: 'openai_api_standard',
      fastModePricing: 'codex_credit_adjusted_standard_equivalent',
      notes: [
        'Cache-creation input is billed as uncached input unless a separate cache-write rate is later added.',
      ],
    },
    serviceTierAliases: {
      default: 'standard',
      standard: 'standard',
      priority: 'fast',
      fast: 'fast',
    },
    models: {
      'gpt-5.3-codex': {
        model: 'gpt-5.3-codex',
        displayName: 'GPT-5.3 Codex',
        standard: {
          input: 1.25,
          cachedInput: 0.125,
          cacheWriteInput: 1.5625,
          output: 10,
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
          standardCostMultiplier: 2,
          appliesTo: ['tokens'],
        },
      },
      'gpt-5.3-codex-mini': {
        model: 'gpt-5.3-codex-mini',
        standard: {
          input: 0.25,
          cachedInput: 0.025,
          output: 2,
        },
        codexFast: {
          supported: false,
          unsupportedReason: 'Fast mode not documented for this model.',
        },
      },
    },
    unpricedModels: {
      'gpt-5.3-codex-spark': {
        model: 'gpt-5.3-codex-spark',
        reason: 'not_available_in_api_pricing',
        note: 'No published API pricing yet.',
      },
    },
    billableTools: {
      webSearchCall: {
        unit: 'per_1k_calls',
        standardUsd: 10,
      },
    },
  };
}

function mutableUnknownPayload(): Record<string, unknown> {
  const payload: unknown = JSON.parse(JSON.stringify(validPayload()));
  if (!isMutableRecord(payload)) {
    throw new Error('Expected cloned payload to be an object');
  }
  return payload;
}

function isMutableRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getMutableRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = record[key];
  if (!isMutableRecord(value)) {
    throw new Error(`Expected ${key} to be an object`);
  }
  return value;
}

function getMutablePricedModel(
  payload: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  return getMutableRecord(getMutableRecord(payload, 'models'), model);
}

function getMutableUnpricedModel(
  payload: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  return getMutableRecord(getMutableRecord(payload, 'unpricedModels'), model);
}

describe('parseOpenAiPricingResponse', () => {
  it('parses and returns a complete valid payload', () => {
    const payload = validPayload();
    const parsed = parseOpenAiPricingResponse(
      JSON.parse(JSON.stringify(payload)),
    );
    expect(parsed).toEqual(payload);
  });

  it('round-trips a valid payload through JSON', () => {
    const payload = validPayload();
    const reparsed = parseOpenAiPricingResponse(
      JSON.parse(JSON.stringify(parseOpenAiPricingResponse(payload))),
    );
    expect(reparsed).toEqual(payload);
  });

  it('round-trips the required serviceTierAliases keys', () => {
    const parsed = parseOpenAiPricingResponse(validPayload());
    expect(parsed.serviceTierAliases).toMatchObject({
      default: 'standard',
      standard: 'standard',
      priority: 'fast',
      fast: 'fast',
    });
  });

  it('rejects a non-object root', () => {
    expect(() => parseOpenAiPricingResponse(null)).toThrow();
    expect(() => parseOpenAiPricingResponse('nope')).toThrow();
    expect(() => parseOpenAiPricingResponse([])).toThrow();
  });

  it('rejects an unsupported version', () => {
    const payload = mutableUnknownPayload();
    payload.version = 2;
    expect(() => parseOpenAiPricingResponse(payload)).toThrow(/version/);
  });

  it('rejects an unexpected currency / token unit', () => {
    const badCurrency = mutableUnknownPayload();
    badCurrency.currency = 'eur';
    expect(() => parseOpenAiPricingResponse(badCurrency)).toThrow(/currency/);

    const badUnit = mutableUnknownPayload();
    badUnit.tokenUnit = 'per_1k_tokens';
    expect(() => parseOpenAiPricingResponse(badUnit)).toThrow(/tokenUnit/);
  });

  it('rejects negative token rates', () => {
    const payload = validPayload();
    payload.models['gpt-5.3-codex'].standard.input = -1;
    expect(() => parseOpenAiPricingResponse(payload)).toThrow(/input/);

    const cacheWritePayload = validPayload();
    cacheWritePayload.models['gpt-5.3-codex'].standard.cacheWriteInput = -1;
    expect(() => parseOpenAiPricingResponse(cacheWritePayload)).toThrow(
      /cacheWriteInput/,
    );
  });

  it('rejects non-finite numbers', () => {
    const payload = validPayload();
    payload.models['gpt-5.3-codex'].standard.output = Number.POSITIVE_INFINITY;
    expect(() => parseOpenAiPricingResponse(payload)).toThrow(/output/);

    const nanPayload = validPayload();
    nanPayload.models['gpt-5.3-codex'].standard.cachedInput = Number.NaN;
    expect(() => parseOpenAiPricingResponse(nanPayload)).toThrow(/cachedInput/);
  });

  it('rejects a model entry missing its model key', () => {
    const payload = mutableUnknownPayload();
    delete getMutablePricedModel(payload, 'gpt-5.3-codex').model;
    expect(() => parseOpenAiPricingResponse(payload)).toThrow(/model/);
  });

  it('rejects a priced model whose embedded model does not match the map key', () => {
    const payload = validPayload();
    payload.models['gpt-5.3-codex'].model = 'gpt-5.3-codex-other';
    expect(() => parseOpenAiPricingResponse(payload)).toThrow(
      /models\.gpt-5\.3-codex\.model/,
    );
  });

  it('rejects an invalid fetchedAt timestamp', () => {
    const payload = validPayload();
    payload.source.fetchedAt = 'not-a-timestamp';
    expect(() => parseOpenAiPricingResponse(payload)).toThrow(/fetchedAt/);
  });

  it('rejects an invalid service-tier alias target', () => {
    const payload = mutableUnknownPayload();
    getMutableRecord(payload, 'serviceTierAliases').priority = 'turbo';
    expect(() => parseOpenAiPricingResponse(payload)).toThrow(
      /serviceTierAliases/,
    );
  });

  it('rejects missing or incorrect required service-tier aliases', () => {
    const wrongTarget = validPayload();
    wrongTarget.serviceTierAliases.priority = 'standard';
    expect(() => parseOpenAiPricingResponse(wrongTarget)).toThrow(
      /serviceTierAliases\.priority/,
    );

    const missingAlias = validPayload();
    const aliases: Record<string, unknown> = missingAlias.serviceTierAliases;
    delete aliases.fast;
    expect(() => parseOpenAiPricingResponse(missingAlias)).toThrow(
      /serviceTierAliases\.fast/,
    );
  });

  describe('forward-compatible service-tier aliases', () => {
    it.each([
      ['ultrafast', 'ultrafast'],
      ['flex', 'flex'],
      ['ultra', 'ultra_fast'],
    ])(
      'ignores optional alias "%s" whose target "%s" is a canonical tier this client does not know',
      (alias, target) => {
        const payload = mutableUnknownPayload();
        getMutableRecord(payload, 'serviceTierAliases')[alias] = target;

        const parsed = parseOpenAiPricingResponse(payload);

        // Dropped rather than coerced to Standard or Fast, so the cost
        // calculator leaves the tier unpriced instead of rejecting all pricing.
        expect(
          Object.prototype.hasOwnProperty.call(
            parsed.serviceTierAliases,
            alias,
          ),
        ).toBe(false);
        expect(parsed.serviceTierAliases).toEqual(
          validPayload().serviceTierAliases,
        );
      },
    );

    it('keeps required aliases strict when they target a future canonical tier', () => {
      const payload = mutableUnknownPayload();
      getMutableRecord(payload, 'serviceTierAliases').priority = 'ultrafast';
      expect(() => parseOpenAiPricingResponse(payload)).toThrow(
        /serviceTierAliases\.priority/,
      );
    });

    it.each([7, null, '', true, ['fast'], { tier: 'fast' }])(
      'rejects a malformed optional alias target %p',
      (target) => {
        const payload = mutableUnknownPayload();
        getMutableRecord(payload, 'serviceTierAliases').ultrafast = target;
        expect(() => parseOpenAiPricingResponse(payload)).toThrow(
          /serviceTierAliases\.ultrafast/,
        );
      },
    );
  });

  describe('codexFast validation', () => {
    it('rejects supported:true with a missing standardCostMultiplier', () => {
      const payload = mutableUnknownPayload();
      delete getMutableRecord(
        getMutablePricedModel(payload, 'gpt-5.3-codex'),
        'codexFast',
      ).standardCostMultiplier;
      expect(() => parseOpenAiPricingResponse(payload)).toThrow(
        /standardCostMultiplier/,
      );
    });

    it('rejects supported:true with a non-positive standardCostMultiplier', () => {
      const payload = validPayload();
      payload.models['gpt-5.3-codex'].codexFast = {
        supported: true,
        standardCostMultiplier: 0,
      };
      expect(() => parseOpenAiPricingResponse(payload)).toThrow(
        /standardCostMultiplier/,
      );

      const negative = validPayload();
      negative.models['gpt-5.3-codex'].codexFast = {
        supported: true,
        standardCostMultiplier: -2,
      };
      expect(() => parseOpenAiPricingResponse(negative)).toThrow(
        /standardCostMultiplier/,
      );
    });

    it('rejects supported:true with a non-finite standardCostMultiplier', () => {
      const payload = validPayload();
      payload.models['gpt-5.3-codex'].codexFast = {
        supported: true,
        standardCostMultiplier: Number.POSITIVE_INFINITY,
      };
      expect(() => parseOpenAiPricingResponse(payload)).toThrow(
        /standardCostMultiplier/,
      );
    });

    it('rejects an appliesTo containing an unknown value', () => {
      const payload = mutableUnknownPayload();
      getMutableRecord(
        getMutablePricedModel(payload, 'gpt-5.3-codex'),
        'codexFast',
      ).appliesTo = ['tokens', 'gpu_minutes'];
      expect(() => parseOpenAiPricingResponse(payload)).toThrow(/appliesTo/);
    });

    it('accepts billable_tools in appliesTo', () => {
      const payload = validPayload();
      payload.models['gpt-5.3-codex'].codexFast = {
        supported: true,
        standardCostMultiplier: 2,
        appliesTo: ['tokens', 'billable_tools'],
      };
      const parsed = parseOpenAiPricingResponse(payload);
      expect(parsed.models['gpt-5.3-codex'].codexFast?.appliesTo).toEqual([
        'tokens',
        'billable_tools',
      ]);
    });

    it('accepts supported:false with an unsupportedReason', () => {
      const parsed = parseOpenAiPricingResponse(validPayload());
      expect(parsed.models['gpt-5.3-codex-mini'].codexFast).toEqual({
        supported: false,
        unsupportedReason: 'Fast mode not documented for this model.',
      });
    });
  });

  it('rejects an invalid unpriced-model reason', () => {
    const payload = mutableUnknownPayload();
    getMutableUnpricedModel(payload, 'gpt-5.3-codex-spark').reason = 'because';
    expect(() => parseOpenAiPricingResponse(payload)).toThrow(/reason/);
  });

  it('rejects an unpriced model whose embedded model does not match the map key', () => {
    const payload = validPayload();
    payload.unpricedModels['gpt-5.3-codex-spark'].model = 'gpt-5.3-codex-other';
    expect(() => parseOpenAiPricingResponse(payload)).toThrow(
      /unpricedModels\.gpt-5\.3-codex-spark\.model/,
    );
  });

  it('rejects a model that is both priced and explicitly unpriced', () => {
    const payload = validPayload();
    payload.unpricedModels['gpt-5.3-codex'] = {
      model: 'gpt-5.3-codex',
      reason: 'not_available_in_api_pricing',
    };
    expect(() => parseOpenAiPricingResponse(payload)).toThrow(
      /both models and unpricedModels/,
    );
  });

  it('accepts a minimal payload without optional model fields', () => {
    const payload = validPayload();
    payload.models = {
      'gpt-5.3-codex-min': {
        model: 'gpt-5.3-codex-min',
        standard: { input: 1, cachedInput: 0.1, output: 4 },
      },
    };
    payload.unpricedModels = {};
    payload.billableTools = {};
    const parsed = parseOpenAiPricingResponse(payload);
    expect(parsed.models['gpt-5.3-codex-min'].longContext).toBeUndefined();
    expect(parsed.models['gpt-5.3-codex-min'].codexFast).toBeUndefined();
    expect(parsed.billableTools.webSearchCall).toBeUndefined();
  });
});
