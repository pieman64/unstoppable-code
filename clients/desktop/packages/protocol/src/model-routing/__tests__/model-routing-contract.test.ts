import {
  benchmarkModelRoutingUsage,
  MODEL_ROUTING_CACHE_WARM_MS,
  MODEL_ROUTING_LONG_CONTEXT_THRESHOLDS_TOKENS,
  MODEL_ROUTING_MAX_BODY_BYTES,
  MODEL_ROUTING_PRICING_REVISION,
  modelRoutingLongContextBandInputTokens,
  ModelRoutingValidationError,
  priceModelRoutingUsage,
  parseAutoModelRoutingRequestV1,
  shouldKeepCurrentModelForCache,
  truncateAutoModelRoutingRecentMessages,
  type AutoModelRoutingRequestV1,
  type ModelRoutingUsage,
} from '../index';

function request(
  overrides: Partial<AutoModelRoutingRequestV1> = {},
): AutoModelRoutingRequestV1 {
  return {
    schemaVersion: 1,
    requestId: '018f1f1e-7b3e-7d82-8b31-71b33f2d41d5',
    surface: 'desktop',
    currentModelId: 'claude-sonnet',
    fallbackModelId: 'claude-sonnet',
    capturedHarness: 'claude',
    executionLane: 'provider_subscription',
    candidates: [
      {
        modelId: 'claude-sonnet',
        label: 'Sonnet',
        description: 'Balanced coding model',
        harness: 'claude',
        executionLane: 'provider_subscription',
        isDefault: true,
      },
      {
        modelId: 'claude-haiku',
        label: 'Haiku',
        description: 'Fast focused model',
        harness: 'claude',
        executionLane: 'provider_subscription',
      },
    ],
    state: {
      prompt: 'Fix the failing test',
      recentMessages: [{ role: 'user', text: 'The test fails on Windows' }],
      attachmentCounts: { files: 0, images: 0, documents: 0 },
      mode: {
        task: 'execute',
        approval: 'ask',
        thinkingLevel: 'high',
        fast: false,
        workspace: 'single-repo',
      },
    },
    ...overrides,
  };
}

describe('auto model routing contract', () => {
  describe('switch cost against a warm prompt cache', () => {
    const warm = (tokens: number): { tokens: number; idleMs: number } => ({
      tokens,
      idleMs: 30_000,
    });

    it('keeps the current model when re-reading a long conversation costs more than the switch saves', () => {
      // Opus -> Sonnet on 100k tokens: ~$0.20 to re-cache vs ~$0.135 saved.
      expect(
        shouldKeepCurrentModelForCache({
          currentModelId: 'anthropic/claude-opus-5',
          selectedModelId: 'anthropic/claude-sonnet-5',
          currentContext: warm(100_000),
        }),
      ).toBe(true);
    });

    it('allows the switch when the conversation is short', () => {
      expect(
        shouldKeepCurrentModelForCache({
          currentModelId: 'anthropic/claude-opus-5',
          selectedModelId: 'anthropic/claude-sonnet-5',
          currentContext: warm(20_000),
        }),
      ).toBe(false);
    });

    it('allows a much cheaper model to win even on a long conversation', () => {
      expect(
        shouldKeepCurrentModelForCache({
          currentModelId: 'anthropic/claude-opus-5',
          selectedModelId: 'anthropic/claude-haiku-4.5',
          currentContext: warm(100_000),
        }),
      ).toBe(false);
    });

    it('always allows switching up to a more capable model', () => {
      expect(
        shouldKeepCurrentModelForCache({
          currentModelId: 'anthropic/claude-sonnet-5',
          selectedModelId: 'anthropic/claude-opus-5',
          currentContext: warm(500_000),
        }),
      ).toBe(false);
    });

    it('ignores a cache that has already gone cold or unknown rates', () => {
      expect(
        shouldKeepCurrentModelForCache({
          currentModelId: 'anthropic/claude-opus-5',
          selectedModelId: 'anthropic/claude-sonnet-5',
          currentContext: {
            tokens: 100_000,
            idleMs: MODEL_ROUTING_CACHE_WARM_MS + 1,
          },
        }),
      ).toBe(false);
      expect(
        shouldKeepCurrentModelForCache({
          currentModelId: 'anthropic/claude-opus-5',
          selectedModelId: 'unpriced-model',
          currentContext: warm(100_000),
        }),
      ).toBe(false);
    });

    it('prices a switch-induced cache miss as cache reads for the benchmark', () => {
      expect(
        benchmarkModelRoutingUsage(
          {
            input: 120_000,
            output: 1_000,
            cacheReadInput: 0,
            cacheCreationInput: 110_000,
          },
          100_000,
        ),
      ).toEqual({
        input: 120_000,
        output: 1_000,
        cacheReadInput: 100_000,
        cacheCreationInput: 10_000,
      });
      // A provider without cache-write billing reports the miss as uncached input.
      expect(
        benchmarkModelRoutingUsage(
          {
            input: 120_000,
            output: 1_000,
            cacheReadInput: 5_000,
            cacheCreationInput: 0,
          },
          100_000,
        ),
      ).toMatchObject({ cacheReadInput: 105_000, cacheCreationInput: 0 });
    });

    it('accepts and bounds the current context on routing requests', () => {
      expect(
        parseAutoModelRoutingRequestV1(
          request({ currentContext: { tokens: 42_000, idleMs: 1_000 } }),
        ).currentContext,
      ).toEqual({ tokens: 42_000, idleMs: 1_000 });
      expect(() =>
        parseAutoModelRoutingRequestV1(
          request({ currentContext: { tokens: -1, idleMs: 0 } }),
        ),
      ).toThrow(ModelRoutingValidationError);
    });
  });

  it('reprices the same observed token and cache usage for Claude benchmarks', () => {
    expect(
      priceModelRoutingUsage('anthropic/claude-opus-5', {
        input: 1_000,
        output: 200,
        cacheReadInput: 400,
        cacheCreationInput: 100,
      }),
    ).toEqual({
      status: 'priced',
      costUsd: 0.008325,
      pricingRevision: MODEL_ROUTING_PRICING_REVISION,
    });
  });

  it.each([
    ['opus[1m]', 'anthropic/claude-opus-5.5'],
    ['claude-opus-5-5', 'anthropic/claude-opus-5.5'],
    ['sonnet', 'anthropic/claude-sonnet-5.5'],
    ['claude-sonnet-5-5', 'anthropic/claude-sonnet-5.5'],
    ['haiku', 'anthropic/claude-haiku-5.5'],
    ['claude-haiku-5-5', 'anthropic/claude-haiku-5.5'],
    ['claude-haiku-4-5-20251001', 'anthropic/claude-haiku-4.5'],
  ])('prices the %s provider alias as %s', (alias, gatewayId) => {
    const usage = {
      input: 1_000,
      output: 200,
      cacheReadInput: 400,
      cacheCreationInput: 100,
    };
    expect(priceModelRoutingUsage(alias, usage)).toEqual(
      priceModelRoutingUsage(gatewayId, usage),
    );
    expect(priceModelRoutingUsage(alias, usage).status).toBe('priced');
  });

  it('bills every Haiku 5.5 token at five times the rate above 100,000 input tokens', () => {
    const usage = (input: number): ModelRoutingUsage => ({
      input,
      output: 1_000,
      cacheReadInput: 60_000,
      cacheCreationInput: 10_000,
    });
    // (input - cache) * $0.10/M + 1k * $0.50/M + 60k * $0.01/M + 10k * $0.125/M
    expect(priceModelRoutingUsage('haiku', usage(100_000))).toMatchObject({
      status: 'priced',
      costUsd: 0.00535,
    });
    expect(priceModelRoutingUsage('haiku', usage(100_001))).toMatchObject({
      status: 'priced',
      costUsd: 0.0267505,
    });
    // A summed multi-turn usage is judged by the per-turn input size.
    expect(
      priceModelRoutingUsage('haiku', usage(300_000), {
        longContextInputTokens: 50_000,
      }),
    ).toMatchObject({ status: 'priced', costUsd: 0.02535 });
  });

  it('lists every distinct long-context threshold in ascending order', () => {
    expect(MODEL_ROUTING_LONG_CONTEXT_THRESHOLDS_TOKENS).toEqual([
      100_000, 272_000, 272_001,
    ]);
  });

  it.each([
    [0, 50_000],
    [1, 200_000],
    [2, 272_001],
    [3, 900_000],
  ])(
    'prices long-context band %i like a request of %i input tokens',
    (band, observedInput) => {
      const usage = {
        input: 2_000_000,
        output: 1_000,
        cacheReadInput: 0,
        cacheCreationInput: 0,
      };
      for (const model of [
        'haiku',
        'openai/gpt-5.6-sol',
        'openai/gpt-6-astra',
      ]) {
        expect(
          priceModelRoutingUsage(model, usage, {
            longContextInputTokens:
              modelRoutingLongContextBandInputTokens(band),
          }),
        ).toEqual(
          priceModelRoutingUsage(model, usage, {
            longContextInputTokens: observedInput,
          }),
        );
      }
    },
  );

  it('reports unknown models as unpriced instead of inventing a comparison', () => {
    expect(
      priceModelRoutingUsage('private-model', {
        input: 1,
        output: 1,
        cacheReadInput: 0,
        cacheCreationInput: 0,
      }),
    ).toEqual({ status: 'unpriced_model' });
  });

  it('accepts a strict valid request and preserves the execution lane', () => {
    expect(parseAutoModelRoutingRequestV1(request())).toEqual(request());
  });

  it('rejects unknown fields, URLs, paths, duplicate ids, and malformed modes', () => {
    const duplicateCandidate = request().candidates[0];
    if (duplicateCandidate === undefined) {
      throw new Error('expected a routing candidate fixture');
    }
    const cases: unknown[] = [
      { ...request(), metadata: { secret: true } },
      request({
        candidates: [duplicateCandidate, duplicateCandidate],
      }),
      request({
        candidates: request().candidates.map((candidate, index) => ({
          ...candidate,
          description:
            index === 0 ? 'https://example.com/private' : candidate.description,
        })),
      }),
      request({
        candidates: request().candidates.map((candidate, index) => ({
          ...candidate,
          label: index === 0 ? '/Users/alice/repo' : candidate.label,
        })),
      }),
      {
        ...request(),
        state: {
          ...request().state,
          mode: { ...request().state.mode, task: 'chat' },
        },
      },
    ];

    for (const value of cases) {
      expect(() => parseAutoModelRoutingRequestV1(value)).toThrow(
        ModelRoutingValidationError,
      );
    }
  });

  it('enforces bounded text, candidates, and decoded body size', () => {
    expect(() =>
      parseAutoModelRoutingRequestV1(
        request({ candidates: request().candidates.slice(0, 1) }),
      ),
    ).not.toThrow();
    expect(() =>
      parseAutoModelRoutingRequestV1(request({ candidates: [] })),
    ).toThrow('between 1 and 12');
    expect(() =>
      parseAutoModelRoutingRequestV1(
        request({
          state: { ...request().state, prompt: 'x'.repeat(8_001) },
        }),
      ),
    ).toThrow('prompt');
    expect(() =>
      parseAutoModelRoutingRequestV1(
        request(),
        MODEL_ROUTING_MAX_BODY_BYTES + 1,
      ),
    ).toThrow('64 KiB');
  });

  it('rejects mixed lanes, cross-harness candidates, invalid fallback, and duplicate defaults', () => {
    const mixedLane = request({
      candidates: request().candidates.map((candidate, index) => ({
        ...candidate,
        executionLane: index === 0 ? 'ai_credits' : candidate.executionLane,
      })),
    });
    const crossHarness = request({
      candidates: request().candidates.map((candidate, index) => ({
        ...candidate,
        harness: index === 0 ? 'codex' : candidate.harness,
      })),
    });
    const duplicateDefaults = request({
      candidates: request().candidates.map((candidate) => ({
        ...candidate,
        isDefault: true,
      })),
    });

    for (const value of [
      mixedLane,
      crossHarness,
      duplicateDefaults,
      request({ fallbackModelId: 'unknown' }),
    ]) {
      expect(() => parseAutoModelRoutingRequestV1(value)).toThrow(
        ModelRoutingValidationError,
      );
    }
  });

  it('retains newest recent content within message and character limits', () => {
    const messages = Array.from({ length: 14 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      text: `${index}:`.padEnd(1_100, String(index % 10)),
    }));
    const truncated = truncateAutoModelRoutingRecentMessages(messages);

    expect(truncated).toHaveLength(11);
    expect(truncated.at(-1)).toEqual(messages.at(-1));
    expect(
      truncated.reduce((sum, item) => sum + item.text.length, 0),
    ).toBeLessThanOrEqual(12_000);
  });
});

describe('approved gateway pricing', () => {
  it.each([
    ['kimi-k3.1-pro', 'moonshotai/kimi-k3.1-pro', 2, 10, 0.2],
    ['minimax-m3.1-flash', 'minimax/minimax-m3.1-flash', 0.15, 0.6, 0.015],
    ['mercury-3', 'inception/mercury-3', 0.1, 0.35, 0.01],
  ] as const)(
    'prices %s and its exact gateway identity consistently',
    (id, gatewayId, input, output, cacheRead) => {
      for (const modelId of [id, gatewayId]) {
        for (const [usage, costUsd] of [
          [
            {
              input: 1_000_000,
              output: 0,
              cacheReadInput: 0,
              cacheCreationInput: 0,
            },
            input,
          ],
          [
            {
              input: 0,
              output: 1_000_000,
              cacheReadInput: 0,
              cacheCreationInput: 0,
            },
            output,
          ],
          [
            {
              input: 0,
              output: 0,
              cacheReadInput: 1_000_000,
              cacheCreationInput: 0,
            },
            cacheRead,
          ],
        ] as const) {
          const price = priceModelRoutingUsage(modelId, usage);
          expect(price.status).toBe('priced');
          if (price.status === 'priced')
            expect(price.costUsd).toBeCloseTo(costUsd);
        }
      }
    },
  );
});
