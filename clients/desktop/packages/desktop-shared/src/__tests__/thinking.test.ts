import { providerFallbackThinkingLevels } from '@canopy/protocol/thinking';
import * as sharedTypes from '../types';
import {
  buildClaudeThinkingFlagSettings,
  buildClaudeThinkingOptions,
  getThinkingUiValueForProvider,
  isThinkingLevel,
  normalizePersistedThinkingLevel,
  normalizeThinkingForProvider,
  normalizeThinkingForUi,
  THINKING_LEVELS,
  THINKING_UI_LEVELS,
  THINKING_UI_OPTIONS,
  type ThinkingLevel,
} from '../types';

describe('thinking helpers', () => {
  describe('level constants', () => {
    it('exposes canonical THINKING_LEVELS in the documented order', () => {
      expect([...THINKING_LEVELS]).toEqual([
        'off',
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
        'ultra',
      ]);
    });

    it('exposes UI-selectable THINKING_UI_LEVELS (without `low`)', () => {
      expect([...THINKING_UI_LEVELS]).toEqual([
        'off',
        'medium',
        'high',
        'xhigh',
        'max',
        'ultra',
      ]);
    });

    it('exposes a single labeled UI option list', () => {
      expect(THINKING_UI_OPTIONS).toEqual([
        { value: 'off', label: 'None' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
        { value: 'xhigh', label: 'Extra High' },
        { value: 'max', label: 'Max' },
        { value: 'ultra', label: 'Ultra' },
      ]);
    });

    it('no longer exports the legacy THINKING_BUDGET / buildThinkingOption helpers', () => {
      expect(sharedTypes).not.toHaveProperty('THINKING_BUDGET');
      expect(sharedTypes).not.toHaveProperty('buildThinkingOption');
    });
  });

  describe('isThinkingLevel', () => {
    it('accepts every canonical thinking level', () => {
      for (const level of THINKING_LEVELS) {
        expect(isThinkingLevel(level)).toBe(true);
      }
    });

    it('accepts the new `max` level', () => {
      expect(isThinkingLevel('max')).toBe(true);
    });

    it('rejects the removed `auto` level', () => {
      expect(isThinkingLevel('auto')).toBe(false);
    });

    it('rejects empty and unknown strings', () => {
      expect(isThinkingLevel('')).toBe(false);
      expect(isThinkingLevel('extreme')).toBe(false);
    });
  });

  describe('normalizePersistedThinkingLevel', () => {
    it('migrates legacy `auto` to `high`', () => {
      expect(normalizePersistedThinkingLevel('auto', 'medium')).toBe('high');
    });

    it('passes canonical values through unchanged', () => {
      for (const level of THINKING_LEVELS) {
        expect(normalizePersistedThinkingLevel(level, 'medium')).toBe(level);
      }
    });

    it('falls back to the provided fallback for unknown values', () => {
      expect(normalizePersistedThinkingLevel('huh', 'medium')).toBe('medium');
      expect(normalizePersistedThinkingLevel(undefined, 'high')).toBe('high');
      expect(normalizePersistedThinkingLevel(null, 'off')).toBe('off');
      expect(normalizePersistedThinkingLevel(42, 'xhigh')).toBe('xhigh');
    });
  });

  describe('normalizeThinkingForUi', () => {
    it('maps canonical `low` to `medium`', () => {
      expect(normalizeThinkingForUi('low')).toBe('medium');
    });

    it('passes all other canonical levels through unchanged', () => {
      const passthrough: ThinkingLevel[] = [
        'off',
        'medium',
        'high',
        'xhigh',
        'max',
        'ultra',
      ];
      for (const level of passthrough) {
        expect(normalizeThinkingForUi(level)).toBe(level);
      }
    });
  });

  describe('normalizeThinkingForProvider', () => {
    it('preserves `max` for both providers (Codex wire-mapping happens elsewhere)', () => {
      expect(normalizeThinkingForProvider('max', 'claude')).toBe('max');
      expect(normalizeThinkingForProvider('max', 'codex')).toBe('max');
    });

    it('preserves `xhigh` for both providers', () => {
      expect(normalizeThinkingForProvider('xhigh', 'claude')).toBe('xhigh');
      expect(normalizeThinkingForProvider('xhigh', 'codex')).toBe('xhigh');
    });

    it('passes every canonical level through unchanged', () => {
      for (const level of THINKING_LEVELS) {
        expect(normalizeThinkingForProvider(level, 'claude')).toBe(level);
        expect(normalizeThinkingForProvider(level, 'codex')).toBe(level);
      }
    });

    it('no longer treats `auto` as valid — it falls through to the persisted-normalize path', () => {
      // `auto` is no longer a canonical level. The legacy behaviour of
      // mapping `auto -> high` stays centralized in the same normalizer used
      // during hydration.
      expect(
        normalizeThinkingForProvider('auto' as ThinkingLevel, 'claude'),
      ).toBe('high');
      expect(
        normalizeThinkingForProvider('auto' as ThinkingLevel, 'codex'),
      ).toBe('high');
    });
  });

  describe('getThinkingUiValueForProvider', () => {
    it('maps Codex `max` to `xhigh` for provider-specific selects', () => {
      expect(getThinkingUiValueForProvider('max', 'high', 'codex')).toBe(
        'xhigh',
      );
    });

    it('preserves `max` for non-Codex provider-specific selects', () => {
      expect(getThinkingUiValueForProvider('max', 'high', 'claude')).toBe(
        'max',
      );
    });

    it('clamps `ultra` to the provider default top tier when no model is given', () => {
      expect(getThinkingUiValueForProvider('ultra', 'high', 'claude')).toBe(
        'max',
      );
      expect(getThinkingUiValueForProvider('ultra', 'high', 'codex')).toBe(
        'xhigh',
      );
    });

    it('falls back and normalizes `low` to `medium`', () => {
      expect(getThinkingUiValueForProvider(undefined, 'low', 'codex')).toBe(
        'medium',
      );
    });
  });

  describe('per-model supported thinking levels', () => {
    beforeEach(() => {
      sharedTypes.initClaudeModels([
        {
          id: 'fable[1m]',
          label: 'Fable 5 1M',
          supportedThinkingLevels: [
            'off',
            'low',
            'medium',
            'high',
            'xhigh',
            'max',
            'ultra',
          ],
        },
        {
          id: 'claude-haiku-4-5-20251001',
          label: 'Haiku 4.5',
          supportedThinkingLevels: [
            'off',
            'low',
            'medium',
            'high',
            'xhigh',
            'max',
          ],
        },
        { id: 'sonnet', label: 'Sonnet 5' },
      ]);
      sharedTypes.initCodexModels([
        {
          id: 'gpt-5.6-sol',
          label: 'GPT 5.6 Sol',
          supportedThinkingLevels: [
            'off',
            'low',
            'medium',
            'high',
            'xhigh',
            'max',
            'ultra',
          ],
        },
        {
          id: 'gpt-5.6-luna',
          label: 'GPT 5.6 Luna',
          supportedThinkingLevels: [
            'off',
            'low',
            'medium',
            'high',
            'xhigh',
            'max',
          ],
        },
        { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
      ]);
    });

    afterEach(() => {
      sharedTypes.initClaudeModels([]);
      sharedTypes.initCodexModels([]);
    });

    it('returns configured levels for configured models', () => {
      expect([
        ...sharedTypes.getSupportedThinkingLevelsForModel('fable[1m]'),
      ]).toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
      expect([
        ...sharedTypes.getSupportedThinkingLevelsForModel('gpt-5.6-sol'),
      ]).toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    });

    it('keeps the provider fallback tables equivalent to the protocol cycle fallback', () => {
      // The desktop fallback (CAN-2540) is DERIVED from
      // `providerFallbackThinkingLevels` plus the canonical internal-only
      // `low` tier, so the two tables cannot drift apart. This pins the
      // equivalence: stripping `low` from the desktop set must yield exactly
      // the protocol provider cycle.
      const providers = ['claude', 'codex', 'ollama'] as const;
      for (const provider of providers) {
        const fallback = sharedTypes.getSupportedThinkingLevelsForModel(
          undefined,
          provider,
        );
        expect(fallback.filter((level) => level !== 'low')).toEqual(
          providerFallbackThinkingLevels(provider),
        );
        // `low` stays available at the canonical layer for persisted configs.
        expect(fallback).toContain('low');
      }
    });

    it('falls back to provider defaults for unconfigured models', () => {
      expect([
        ...sharedTypes.getSupportedThinkingLevelsForModel('sonnet'),
      ]).toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max']);
      expect([
        ...sharedTypes.getSupportedThinkingLevelsForModel('deepseek-v4-pro'),
      ]).toEqual(['off', 'low', 'medium', 'high', 'xhigh']);
      expect([
        ...sharedTypes.getSupportedThinkingLevelsForModel(undefined, 'codex'),
      ]).toEqual(['off', 'low', 'medium', 'high', 'xhigh']);
    });

    it('supports `off` when the model declares it', () => {
      expect(
        sharedTypes.modelSupportsThinkingLevel('gpt-5.6-luna', 'off'),
      ).toBe(true);
    });

    it('clamps unsupported levels to the nearest lower supported tier', () => {
      expect(sharedTypes.clampThinkingLevelForModel('ultra', 'fable[1m]')).toBe(
        'ultra',
      );
      expect(
        sharedTypes.clampThinkingLevelForModel(
          'ultra',
          'claude-haiku-4-5-20251001',
        ),
      ).toBe('max');
      expect(
        sharedTypes.clampThinkingLevelForModel('ultra', 'gpt-5.6-sol'),
      ).toBe('ultra');
      expect(sharedTypes.clampThinkingLevelForModel('max', 'gpt-5.6-sol')).toBe(
        'max',
      );
      expect(
        sharedTypes.clampThinkingLevelForModel('ultra', 'gpt-5.6-luna'),
      ).toBe('max');
      expect(
        sharedTypes.clampThinkingLevelForModel('max', 'deepseek-v4-pro'),
      ).toBe('xhigh');
      expect(
        sharedTypes.clampThinkingLevelForModel('off', 'gpt-5.6-luna'),
      ).toBe('off');
    });

    it('clamps off against an exact model set that omits it', () => {
      sharedTypes.initCodexModels([
        {
          id: 'medium-only',
          label: 'Medium only',
          supportedThinkingLevels: ['medium'],
        },
      ]);

      expect(sharedTypes.clampThinkingLevelForModel('off', 'medium-only')).toBe(
        'medium',
      );
    });

    it('clamps an unsupported `low` to `medium`, matching the protocol clamp', () => {
      // Canonical `low` displays and transmits as `medium`
      // (`normalizeThinkingForUi`), so a sparse declaration that omits `low`
      // must resolve a persisted `low` to `medium` — not fall through to
      // `off` while `@canopy/protocol/thinking` resolves it to `medium`.
      expect(
        sharedTypes.clampThinkingLevelForModel(
          'low',
          undefined,
          'claude',
          false,
          ['off', 'medium'],
        ),
      ).toBe('medium');
      // A set that declares `low` keeps it verbatim.
      expect(
        sharedTypes.clampThinkingLevelForModel(
          'low',
          undefined,
          'claude',
          false,
          ['off', 'low', 'medium'],
        ),
      ).toBe('low');
      // Nothing at or below the normalized tier still lands on `off`.
      expect(
        sharedTypes.clampThinkingLevelForModel(
          'low',
          undefined,
          'claude',
          false,
          ['off', 'high'],
        ),
      ).toBe('off');
    });

    it('hides every thinking option — including off — for an empty exact set', () => {
      sharedTypes.initCodexModels([
        {
          id: 'no-thinking',
          label: 'No thinking',
          supportedThinkingLevels: [],
        },
        {
          id: 'medium-only',
          label: 'Medium only',
          supportedThinkingLevels: ['medium'],
        },
      ]);

      expect(
        sharedTypes.getThinkingUiOptionsForProvider('codex', 'no-thinking'),
      ).toEqual([]);
      expect(
        sharedTypes
          .getThinkingUiOptionsForProvider('codex', 'medium-only')
          .map((option) => option.value),
      ).toEqual(['medium']);
    });

    it('filters UI options by model support', () => {
      const values = (provider: 'claude' | 'codex', model?: string): string[] =>
        sharedTypes
          .getThinkingUiOptionsForProvider(provider, model)
          .map((option) => option.value);

      expect(values('claude', 'fable[1m]')).toEqual([
        'off',
        'medium',
        'high',
        'xhigh',
        'max',
        'ultra',
      ]);
      expect(values('claude', 'claude-haiku-4-5-20251001')).toEqual([
        'off',
        'medium',
        'high',
        'xhigh',
        'max',
      ]);
      expect(values('codex', 'gpt-5.6-sol')).toEqual([
        'off',
        'medium',
        'high',
        'xhigh',
        'max',
        'ultra',
      ]);
      expect(values('codex', 'gpt-5.6-luna')).toEqual([
        'off',
        'medium',
        'high',
        'xhigh',
        'max',
      ]);
      // No model → provider default (historical behavior).
      expect(values('codex')).toEqual(['off', 'medium', 'high', 'xhigh']);
      expect(values('claude')).toEqual([
        'off',
        'medium',
        'high',
        'xhigh',
        'max',
      ]);
    });

    it('displays unsupported persisted values as the nearest supported tier', () => {
      expect(
        getThinkingUiValueForProvider(
          'ultra',
          'high',
          'claude',
          'claude-haiku-4-5-20251001',
        ),
      ).toBe('max');
      expect(
        getThinkingUiValueForProvider('ultra', 'high', 'codex', 'gpt-5.6-sol'),
      ).toBe('ultra');
    });
  });

  describe('buildClaudeThinkingOptions', () => {
    it('returns a disabled payload for `off` with no effort / extraArgs', () => {
      const result = buildClaudeThinkingOptions('off');
      expect(result).toEqual({ thinking: { type: 'disabled' } });
      expect(result).not.toHaveProperty('effort');
      expect(result).not.toHaveProperty('extraArgs');
    });

    it('returns the typed `effort` field for `xhigh`', () => {
      const result = buildClaudeThinkingOptions('xhigh');
      expect(result).toEqual({
        thinking: { type: 'adaptive', display: 'summarized' },
        effort: 'xhigh',
      });
      expect(result).not.toHaveProperty('extraArgs');
    });

    it('returns the typed `effort` field for `max` (no extraArgs)', () => {
      const result = buildClaudeThinkingOptions('max');
      expect(result).toEqual({
        thinking: { type: 'adaptive', display: 'summarized' },
        effort: 'max',
      });
      expect(result).not.toHaveProperty('extraArgs');
    });

    it.each(['low', 'medium', 'high'] as const)(
      'returns the typed `effort` field for `%s`',
      (level) => {
        const result = buildClaudeThinkingOptions(level);
        expect(result).toEqual({
          thinking: { type: 'adaptive', display: 'summarized' },
          effort: level,
        });
        expect(result).not.toHaveProperty('extraArgs');
      },
    );

    it('maps `ultra` to xhigh effort plus the ultracode session setting', () => {
      const result = buildClaudeThinkingOptions('ultra');
      expect(result).toEqual({
        thinking: { type: 'adaptive', display: 'summarized' },
        effort: 'xhigh',
        settings: { ultracode: true },
      });
      expect(result).not.toHaveProperty('extraArgs');
    });
  });

  describe('buildClaudeThinkingFlagSettings', () => {
    it('disables thinking and clears ultracode for `off`', () => {
      expect(buildClaudeThinkingFlagSettings('off')).toEqual({
        alwaysThinkingEnabled: false,
        ultracode: false,
      });
    });

    it.each(['low', 'medium', 'high', 'xhigh'] as const)(
      'enables thinking and echoes `%s` as the effort level',
      (level) => {
        expect(buildClaudeThinkingFlagSettings(level)).toEqual({
          alwaysThinkingEnabled: true,
          effortLevel: level,
          ultracode: false,
        });
      },
    );

    it('maps `max` to the live settings effort fallback', () => {
      expect(buildClaudeThinkingFlagSettings('max')).toEqual({
        alwaysThinkingEnabled: true,
        effortLevel: 'xhigh',
        ultracode: false,
      });
    });

    it('enables ultracode with xhigh effort for `ultra`', () => {
      expect(buildClaudeThinkingFlagSettings('ultra')).toEqual({
        alwaysThinkingEnabled: true,
        effortLevel: 'xhigh',
        ultracode: true,
      });
    });
  });
});
