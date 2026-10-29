import {
  DEFAULT_PLAN_PRICES_USD_PER_MONTH,
  getEffectiveMonthlyPrice,
  labelForPlanKey,
  normalizePlanKey,
  providerForPlanKey,
  subscriptionLabelForPlanType,
} from '../subscription-plan-catalog';

describe('normalizePlanKey', () => {
  it.each([
    ['claude', 'pro', 'claude:pro'],
    ['claude', 'max', 'claude:max-5x'],
    ['claude', 'max_5x', 'claude:max-5x'],
    ['claude', 'Max-20x', 'claude:max-20x'],
    // Claude OAuth rateLimitTier forms carry the only 5x-vs-20x signal.
    ['claude', 'default_claude_max_20x', 'claude:max-20x'],
    ['claude', 'default_claude_max_5x', 'claude:max-5x'],
    ['claude', 'team', 'claude:team'],
    // Team seat class resolved on the desktop from the rate bucket.
    ['claude', 'team-premium', 'claude:team-premium'],
    ['claude', 'team_premium', 'claude:team-premium'],
    ['claude', 'enterprise', 'claude:enterprise'],
    ['codex', 'plus', 'codex:plus'],
    ['codex', 'pro', 'codex:pro'],
    ['codex', 'team', 'codex:business'],
    ['codex', 'business', 'codex:business'],
  ] as const)('maps %s/%s to %s', (provider, raw, expected) => {
    expect(normalizePlanKey(provider, raw)).toBe(expected);
  });

  it('passes unknown plan strings through, lowercased and slugged', () => {
    expect(normalizePlanKey('claude', 'Super Duper')).toBe(
      'claude:super-duper',
    );
    expect(normalizePlanKey('codex', 'MYSTERY_PLAN')).toBe(
      'codex:mystery-plan',
    );
  });

  it('falls back to :unknown for empty/nullish plan types', () => {
    expect(normalizePlanKey('claude', null)).toBe('claude:unknown');
    expect(normalizePlanKey('codex', '')).toBe('codex:unknown');
    expect(normalizePlanKey('claude', '   ')).toBe('claude:unknown');
  });
});

describe('getEffectiveMonthlyPrice', () => {
  it('prefers the override over the catalog default', () => {
    const overrides = new Map([['claude:pro', 42]]);
    expect(getEffectiveMonthlyPrice('claude:pro', overrides)).toBe(42);
  });

  it('falls back to the catalog default when no override', () => {
    expect(getEffectiveMonthlyPrice('claude:max-5x', new Map())).toBe(
      DEFAULT_PLAN_PRICES_USD_PER_MONTH['claude:max-5x'],
    );
  });

  it('returns null for unpriced plans with no override', () => {
    expect(getEffectiveMonthlyPrice('claude:enterprise', new Map())).toBeNull();
    expect(getEffectiveMonthlyPrice('codex:mystery', new Map())).toBeNull();
  });

  it('lets an override price an otherwise-unpriced plan', () => {
    const overrides = new Map([['codex:enterprise', 500]]);
    expect(getEffectiveMonthlyPrice('codex:enterprise', overrides)).toBe(500);
  });
});

describe('providerForPlanKey', () => {
  it('extracts the provider', () => {
    expect(providerForPlanKey('claude:max-5x')).toBe('claude');
    expect(providerForPlanKey('codex:plus')).toBe('codex');
  });
  it('returns null for malformed keys', () => {
    expect(providerForPlanKey('ollama:foo')).toBeNull();
    expect(providerForPlanKey('nonsense')).toBeNull();
  });
  it('rejects bare providers and empty slugs', () => {
    expect(providerForPlanKey('claude')).toBeNull();
    expect(providerForPlanKey('claude:')).toBeNull();
    expect(providerForPlanKey('codex')).toBeNull();
    expect(providerForPlanKey('codex:')).toBeNull();
  });
});

describe('labelForPlanKey', () => {
  it('uses curated labels for known keys', () => {
    expect(labelForPlanKey('claude:max-20x')).toBe('Claude Max 20x');
    expect(labelForPlanKey('claude:team-premium')).toBe('Claude Team Premium');
    expect(labelForPlanKey('codex:plus')).toBe('ChatGPT Plus');
  });
  it('title-cases unknown passthrough keys', () => {
    expect(labelForPlanKey('codex:mystery-plan')).toBe('ChatGPT Mystery Plan');
  });
  it('labels the bare Claude Max default and Codex Pro', () => {
    expect(labelForPlanKey(normalizePlanKey('claude', 'max'))).toBe(
      'Claude Max 5x',
    );
    expect(labelForPlanKey(normalizePlanKey('codex', 'pro'))).toBe(
      'ChatGPT Pro',
    );
  });
});

describe('subscriptionLabelForPlanType', () => {
  it('resolves friendly labels from raw provider plan types', () => {
    // Claude tier-enriched plan types normalize to the Max 5x/20x labels.
    expect(
      subscriptionLabelForPlanType('claude', 'default_claude_max_20x'),
    ).toBe('Claude Max 20x');
    expect(subscriptionLabelForPlanType('claude', 'max')).toBe('Claude Max 5x');
    // Codex `team` folds to the Business seat label.
    expect(subscriptionLabelForPlanType('codex', 'team')).toBe(
      'ChatGPT Business',
    );
    expect(subscriptionLabelForPlanType('codex', 'plus')).toBe('ChatGPT Plus');
  });

  it('returns null for absent or unknown plan types', () => {
    expect(subscriptionLabelForPlanType('claude', null)).toBeNull();
    expect(subscriptionLabelForPlanType('codex', undefined)).toBeNull();
    expect(subscriptionLabelForPlanType('codex', '  ')).toBeNull();
    expect(subscriptionLabelForPlanType('codex', 'unknown')).toBeNull();
  });

  it('still title-cases recognized-shape unknown passthrough plans', () => {
    // A non-empty unrecognized plan is priceable via override, so it keeps a
    // sensible label rather than collapsing to null.
    expect(subscriptionLabelForPlanType('codex', 'mystery-plan')).toBe(
      'ChatGPT Mystery Plan',
    );
  });
});
