import {
  MODEL_CATALOG_PROVIDERS,
  MODEL_CATALOG_THINKING_LEVELS,
  advanceThinkingLevelIn,
  clampThinkingLevelToSupported,
  formatModelContextWindow,
  getModelCatalogProviderLabel,
  getModelCatalogThinkingLevels,
  getModelVendorLabel,
  resolveModelCatalogThinkingLevels,
  type ModelCatalog,
  type ModelCatalogProvider,
  type ModelCatalogThinkingLevel,
} from '../index';

describe('model catalog contract (CAN-1218)', () => {
  it('enumerates the three concrete providers in desktop-picker order', () => {
    expect(MODEL_CATALOG_PROVIDERS).toEqual(['claude', 'codex', 'ollama']);
  });

  it('maps every provider to a human display label', () => {
    const labels = MODEL_CATALOG_PROVIDERS.map((provider) =>
      getModelCatalogProviderLabel(provider),
    );
    expect(labels).toEqual(['Claude', 'Codex', 'Ollama']);
  });

  it('types a flat catalog of provider models and custom Agents', () => {
    // A compile-time + runtime shape check: the catalog is a flat array whose
    // rows discriminate on `kind`, so the picker can group by provider and
    // gate Agents on `available` without any `as` casts.
    const provider: ModelCatalogProvider = 'claude';
    const catalog: ModelCatalog = [
      { id: 'opus', label: 'Opus', provider, kind: 'model', available: true },
      {
        id: 'agent_model_reviewer',
        label: 'Reviewer',
        provider,
        kind: 'agent',
        available: false,
        unavailableReason: 'base_model_unavailable',
      },
    ];
    expect(catalog.filter((option) => option.kind === 'agent')).toHaveLength(1);
    expect(catalog.every((option) => typeof option.id === 'string')).toBe(true);
  });

  it('keeps gateway rows inside the legacy provider union', () => {
    const catalog: ModelCatalog = [
      {
        id: 'gateway-model',
        label: 'Gateway Model',
        provider: 'claude',
        source: 'ai-gateway',
        harness: 'claude',
        kind: 'model',
        available: true,
      },
    ];
    expect(catalog[0]).toMatchObject({
      provider: 'claude',
      source: 'ai-gateway',
      harness: 'claude',
    });
    expect(MODEL_CATALOG_PROVIDERS).not.toContain('ai-gateway');
  });
});

describe('projected per-model thinking levels (CAN-2441)', () => {
  const CLAUDE: readonly ModelCatalogThinkingLevel[] = [
    'off',
    'medium',
    'high',
    'xhigh',
    'max',
  ];
  const CODEX_ULTRA: readonly ModelCatalogThinkingLevel[] = [
    'off',
    'medium',
    'high',
    'xhigh',
    'ultra',
  ];

  const catalog: ModelCatalog = [
    {
      id: 'opus',
      label: 'Opus',
      provider: 'claude',
      kind: 'model',
      available: true,
      thinkingLevels: [...CLAUDE],
    },
    {
      id: 'gpt-5.6-sol',
      label: 'Sol',
      provider: 'codex',
      kind: 'model',
      available: true,
      thinkingLevels: [...CODEX_ULTRA],
    },
    {
      id: 'legacy',
      label: 'Legacy host model',
      provider: 'claude',
      kind: 'model',
      available: true,
    },
  ];

  it('orders the canonical level set weakest-effort first', () => {
    expect(MODEL_CATALOG_THINKING_LEVELS).toEqual([
      'off',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
  });

  it('returns the projected levels for a known model', () => {
    expect(getModelCatalogThinkingLevels(catalog, 'opus')).toEqual(CLAUDE);
    expect(getModelCatalogThinkingLevels(catalog, 'gpt-5.6-sol')).toEqual(
      CODEX_ULTRA,
    );
  });

  it.each([
    ['no catalog', undefined, 'opus'],
    ['no model', catalog, undefined],
    ['unknown model', catalog, 'not-a-model'],
    ['model projected by an older desktop', catalog, 'legacy'],
  ])(
    'reports %s as no per-model data so callers keep the provider cycle',
    (_label, given, modelId) => {
      expect(getModelCatalogThinkingLevels(given, modelId)).toBeUndefined();
    },
  );

  it('treats an empty projected list as no data, not as "off only"', () => {
    const empty: ModelCatalog = [
      {
        id: 'empty',
        label: 'Empty',
        provider: 'claude',
        kind: 'model',
        available: true,
        thinkingLevels: [],
      },
    ];
    expect(getModelCatalogThinkingLevels(empty, 'empty')).toBeUndefined();
  });

  describe('clampThinkingLevelToSupported', () => {
    it('passes through a supported level', () => {
      expect(clampThinkingLevelToSupported('xhigh', CLAUDE)).toBe('xhigh');
    });

    it('falls to the nearest supported tier below an unsupported level', () => {
      expect(clampThinkingLevelToSupported('ultra', CLAUDE)).toBe('max');
      expect(clampThinkingLevelToSupported('max', CODEX_ULTRA)).toBe('xhigh');
    });

    it('falls back to off when nothing at or below is supported', () => {
      expect(clampThinkingLevelToSupported('high', ['off', 'ultra'])).toBe(
        'off',
      );
    });

    it('clamps a persisted off to the weakest supported tier regardless of projection order', () => {
      expect(clampThinkingLevelToSupported('off', ['high', 'medium'])).toBe(
        'medium',
      );
      expect(clampThinkingLevelToSupported('medium', ['max', 'xhigh'])).toBe(
        'xhigh',
      );
      expect(clampThinkingLevelToSupported('off', [])).toBe('off');
    });
  });

  describe('advanceThinkingLevelIn', () => {
    it('walks the projected set in ascending order and wraps', () => {
      const seen: ModelCatalogThinkingLevel[] = [];
      let level: ModelCatalogThinkingLevel = 'off';
      for (let i = 0; i < CODEX_ULTRA.length; i += 1) {
        level = advanceThinkingLevelIn(level, CODEX_ULTRA);
        seen.push(level);
      }
      expect(seen).toEqual(['medium', 'high', 'xhigh', 'ultra', 'off']);
    });

    it('reaches max and ultra when the model supports them', () => {
      expect(advanceThinkingLevelIn('xhigh', CLAUDE)).toBe('max');
      expect(advanceThinkingLevelIn('xhigh', CODEX_ULTRA)).toBe('ultra');
    });

    it('advances from the clamped tier when the stored level is unsupported', () => {
      // Stored `ultra` displays as `max` on a Claude model, so the next press
      // must wrap from `max`, not restart the cycle.
      expect(advanceThinkingLevelIn('ultra', CLAUDE)).toBe('off');
    });

    it('ignores projection order and uses canonical ascending order', () => {
      expect(advanceThinkingLevelIn('off', ['xhigh', 'off', 'medium'])).toBe(
        'medium',
      );
    });

    it('advances from the weakest supported tier for a persisted off', () => {
      expect(advanceThinkingLevelIn('off', ['high', 'medium'])).toBe('high');
    });

    it('returns off for an empty set', () => {
      expect(advanceThinkingLevelIn('high', [])).toBe('off');
    });
  });

  describe('resolveModelCatalogThinkingLevels (CAN-2339)', () => {
    it('does not invent thinking support for a model with unknown harness metadata', () => {
      expect(
        resolveModelCatalogThinkingLevels(
          [
            {
              id: 'uncurated',
              label: 'Uncurated',
              provider: 'unknown',
              source: 'ai-gateway',
              kind: 'model',
              available: true,
            },
          ],
          'uncurated',
          'unknown',
        ),
      ).toEqual([]);
    });

    const resolvable: ModelCatalog = [
      {
        id: 'declared',
        label: 'Declared',
        provider: 'claude',
        kind: 'model',
        available: true,
        supportedThinkingLevels: ['off', 'medium', 'high'],
        // The canonical tri-state field must win over the legacy one.
        thinkingLevels: [...CLAUDE],
      },
      {
        id: 'non-thinking',
        label: 'Non-thinking',
        provider: 'codex',
        kind: 'model',
        available: true,
        supportedThinkingLevels: [],
      },
      {
        id: 'legacy-only',
        label: 'Legacy only',
        provider: 'codex',
        kind: 'model',
        available: true,
        thinkingLevels: [...CLAUDE],
      },
      {
        id: 'default-row',
        label: 'Default row',
        provider: 'claude',
        kind: 'model',
        available: true,
        isDefault: true,
        supportedThinkingLevels: ['off', 'high'],
      },
    ];

    it('returns the canonical declared set verbatim, ahead of the legacy field', () => {
      expect(
        resolveModelCatalogThinkingLevels(resolvable, 'declared', 'claude'),
      ).toEqual(['off', 'medium', 'high']);
    });

    it('keeps the explicit empty "thinking unsupported" set', () => {
      expect(
        resolveModelCatalogThinkingLevels(resolvable, 'non-thinking', 'codex'),
      ).toEqual([]);
    });

    it('honors the legacy thinkingLevels field for version-skewed hosts', () => {
      expect(
        resolveModelCatalogThinkingLevels(resolvable, 'legacy-only', 'codex'),
      ).toEqual(CLAUDE);
    });

    it('resolves an absent model through the host-declared default row', () => {
      expect(
        resolveModelCatalogThinkingLevels(resolvable, undefined, 'claude'),
      ).toEqual(['off', 'high']);
    });

    it('resolves the default row through its legacy thinkingLevels field', () => {
      // A version-skewed host can project a default row that carries only the
      // legacy field. The default-row stand-in must reach the legacy fallback
      // with the row's own id — not bypass it because `modelId` is undefined
      // and land on the provider cycle.
      const legacyDefault: ModelCatalog = [
        {
          id: 'legacy-default',
          label: 'Legacy default',
          provider: 'codex',
          kind: 'model',
          available: true,
          isDefault: true,
          thinkingLevels: ['off', 'medium'],
        },
      ];
      expect(
        resolveModelCatalogThinkingLevels(legacyDefault, undefined, 'codex'),
      ).toEqual(['off', 'medium']);
    });

    it('falls back to the provider cycle when nothing is declared', () => {
      expect(
        resolveModelCatalogThinkingLevels(resolvable, 'unknown', 'codex'),
      ).toEqual(['off', 'medium', 'high', 'xhigh']);
      expect(
        resolveModelCatalogThinkingLevels(undefined, 'opus', 'claude'),
      ).toEqual(['off', 'medium', 'high', 'xhigh', 'max']);
    });
  });
});

describe('vendor display labels (CAN-2701)', () => {
  it('retains local casing for package-owned and native providers', () => {
    expect(getModelVendorLabel('anthropic')).toBe('Anthropic');
    expect(getModelVendorLabel('openai')).toBe('OpenAI');
    expect(getModelVendorLabel('ollama')).toBe('Ollama');
  });

  it('preserves legacy vendor casing for version-skewed catalogs', () => {
    expect(getModelVendorLabel('deepseek')).toBe('DeepSeek');
    expect(getModelVendorLabel('moonshotai')).toBe('Moonshot AI');
    expect(getModelVendorLabel('zai')).toBe('Z.ai');
    expect(getModelVendorLabel('minimax')).toBe('MiniMax');
  });

  it('accepts the provider ids that stand in when a row declares no vendor', () => {
    expect(getModelVendorLabel('claude')).toBe('Anthropic');
    expect(getModelVendorLabel('codex')).toBe('OpenAI');
  });

  it('never returns a non-string for an Object.prototype member name', () => {
    // A bare index on an object literal reaches the prototype chain, so these
    // returned a function/object from a `string` signature — and the picker's
    // section sort would then call `.localeCompare` on it and throw.
    for (const name of ['constructor', '__proto__', 'toString', 'valueOf']) {
      const label = getModelVendorLabel(name);
      expect(typeof label).toBe('string');
    }
    expect(getModelVendorLabel('constructor')).toBe('Constructor');
  });

  it('capitalizes an unknown vendor rather than rendering a bare id', () => {
    expect(getModelVendorLabel('acme')).toBe('Acme');
    expect(getModelVendorLabel('')).toBe('Other');
  });
});

describe('context-window formatting (CAN-2701)', () => {
  it('formats the shipping context windows compactly', () => {
    expect(formatModelContextWindow(1_000_000)).toBe('1M');
    expect(formatModelContextWindow(400_000)).toBe('400K');
    expect(formatModelContextWindow(200_000)).toBe('200K');
  });

  it('keeps one decimal only when it carries information', () => {
    expect(formatModelContextWindow(1_500_000)).toBe('1.5M');
    expect(formatModelContextWindow(128_000)).toBe('128K');
    expect(formatModelContextWindow(8_192)).toBe('8.2K');
  });

  it('returns undefined for values that cannot be a real window', () => {
    expect(formatModelContextWindow(0)).toBeUndefined();
    expect(formatModelContextWindow(-1)).toBeUndefined();
    expect(formatModelContextWindow(Number.NaN)).toBeUndefined();
    expect(formatModelContextWindow(undefined)).toBeUndefined();
  });

  it('leaves sub-thousand values as a plain count', () => {
    expect(formatModelContextWindow(512)).toBe('512');
  });
});
