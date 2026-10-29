import {
  advanceThinkingLevel,
  providerFallbackThinkingLevels,
  type ThinkingLevel,
} from '@canopy/protocol/thinking';

function advanceForProvider(
  current: ThinkingLevel,
  providerType: string | undefined,
): ThinkingLevel {
  return advanceThinkingLevel(
    current,
    providerFallbackThinkingLevels(providerType),
  );
}

describe('thinking-level', () => {
  it('uses the default cycle for Claude/Ollama/unknown and the shorter cycle for Codex', () => {
    const defaultCycle = providerFallbackThinkingLevels('claude');
    expect(providerFallbackThinkingLevels('ollama')).toEqual(defaultCycle);
    expect(providerFallbackThinkingLevels(undefined)).toEqual(defaultCycle);
    expect(providerFallbackThinkingLevels('codex')).toEqual([
      'off',
      'medium',
      'high',
      'xhigh',
    ]);
  });

  it('advances the default cycle off → medium → high → xhigh → max → off', () => {
    expect(advanceForProvider('off', 'claude')).toBe('medium');
    expect(advanceForProvider('medium', 'claude')).toBe('high');
    expect(advanceForProvider('high', 'claude')).toBe('xhigh');
    expect(advanceForProvider('xhigh', 'claude')).toBe('max');
    expect(advanceForProvider('max', 'claude')).toBe('off');
  });

  it('advances the provider-level Codex cycle off → medium → high → xhigh → off', () => {
    expect(advanceForProvider('xhigh', 'codex')).toBe('off');
    expect(advanceForProvider('high', 'codex')).toBe('xhigh');
  });

  it('lands on off when an upper tier is outside the provider cycle', () => {
    expect(advanceForProvider('max', 'codex')).toBe('off');
  });

  it('treats UI-hidden low as medium before advancing', () => {
    expect(advanceForProvider('low', 'claude')).toBe('high');
  });

  describe('model-driven cycle (CAN-2441)', () => {
    const CLAUDE_MAX = ['off', 'medium', 'high', 'xhigh', 'max'] as const;
    const CODEX_ULTRA = ['off', 'medium', 'high', 'xhigh', 'ultra'] as const;
    const NARROW = ['off', 'medium'] as const;

    it("cycles the model's own efforts when the desktop projected them", () => {
      expect(advanceThinkingLevel('xhigh', CODEX_ULTRA)).toBe('ultra');
      expect(advanceThinkingLevel('ultra', CODEX_ULTRA)).toBe('off');
    });

    it('reaches max on a provider whose hardcoded cycle would allow it too', () => {
      expect(advanceThinkingLevel('xhigh', CLAUDE_MAX)).toBe('max');
    });

    it('respects a model that supports fewer tiers than its provider cycle', () => {
      expect(advanceThinkingLevel('medium', NARROW)).toBe('off');
    });

    it('clamps an unsupported stored level down before stepping', () => {
      // `max` is not in the Codex+ultra set; it displays as `xhigh`, so the
      // next press must advance from there rather than restarting the cycle.
      expect(advanceThinkingLevel('max', CODEX_ULTRA)).toBe('ultra');
    });

    it('normalizes the never-projected `low` before advancing', () => {
      expect(advanceThinkingLevel('low', CLAUDE_MAX)).toBe('high');
    });

    it('falls back to the provider cycle when no levels are projected', () => {
      expect(
        advanceThinkingLevel('xhigh', providerFallbackThinkingLevels('codex')),
      ).toBe('off');
      expect(advanceThinkingLevel('xhigh', [])).toBe('off');
      expect(
        advanceThinkingLevel('xhigh', providerFallbackThinkingLevels('claude')),
      ).toBe('max');
    });
  });
});
