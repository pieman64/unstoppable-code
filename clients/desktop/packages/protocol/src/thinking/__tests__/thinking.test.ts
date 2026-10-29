import {
  THINKING_LEVEL_LABELS,
  THINKING_LEVELS,
  THINKING_UI_LEVELS,
  advanceThinkingLevel,
  clampThinkingLevel,
  clampThinkingLevelToDeclared,
  encodeThinkingSetting,
  isThinkingSetting,
  isThinkingLevel,
  normalizePersistedThinkingLevel,
  normalizeThinkingForUi,
  providerFallbackThinkingLevels,
  thinkingDotCount,
  type ThinkingLevel,
} from '../index';

describe('canonical thinking vocabulary', () => {
  describe('thinking setting transport', () => {
    it('encodes Default as an explicit reset and preserves concrete levels', () => {
      expect(encodeThinkingSetting('default')).toBeNull();
      expect(encodeThinkingSetting('off')).toBe('off');
      expect(encodeThinkingSetting('high')).toBe('high');
    });

    it('accepts Default as UI state without adding it to model capabilities', () => {
      expect(isThinkingSetting('default')).toBe(true);
      expect(isThinkingSetting('off')).toBe(true);
      expect(THINKING_LEVELS).not.toContain('default');
    });
  });

  it('exposes canonical THINKING_LEVELS in ascending order', () => {
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

  it('exposes UI-selectable levels in ascending order without low', () => {
    expect([...THINKING_UI_LEVELS]).toEqual([
      'off',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
  });

  it('labels every UI level in words (None, Extra High)', () => {
    expect(THINKING_LEVEL_LABELS).toEqual({
      off: 'None',
      medium: 'Medium',
      high: 'High',
      xhigh: 'Extra High',
      max: 'Max',
      ultra: 'Ultra',
    });
  });

  describe('isThinkingLevel', () => {
    it.each(THINKING_LEVELS)('accepts %s', (level) => {
      expect(isThinkingLevel(level)).toBe(true);
    });

    it.each(['auto', '', 'extreme', 'LOW'])('rejects %s', (value) => {
      expect(isThinkingLevel(value)).toBe(false);
    });

    it.each([undefined, null, 42, {}, []])('rejects non-level %p', (value) => {
      expect(isThinkingLevel(value)).toBe(false);
    });
  });

  describe('normalizePersistedThinkingLevel', () => {
    it('migrates legacy auto to high', () => {
      expect(normalizePersistedThinkingLevel('auto', 'medium')).toBe('high');
    });

    it.each(THINKING_LEVELS)('passes canonical %s through', (level) => {
      expect(normalizePersistedThinkingLevel(level, 'medium')).toBe(level);
    });

    it('falls back for an unknown string', () => {
      expect(normalizePersistedThinkingLevel('huh', 'medium')).toBe('medium');
    });

    it('falls back for undefined', () => {
      expect(normalizePersistedThinkingLevel(undefined, 'high')).toBe('high');
    });

    it('falls back for null', () => {
      expect(normalizePersistedThinkingLevel(null, 'off')).toBe('off');
    });

    it('falls back for a number', () => {
      expect(normalizePersistedThinkingLevel(42, 'xhigh')).toBe('xhigh');
    });
  });

  describe('normalizeThinkingForUi', () => {
    it('maps low to medium', () => {
      expect(normalizeThinkingForUi('low')).toBe('medium');
    });

    it.each(['off', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const)(
      'passes %s through',
      (level) => {
        expect(normalizeThinkingForUi(level)).toBe(level);
      },
    );
  });
});

const CLAUDE = providerFallbackThinkingLevels('claude');
const CODEX = providerFallbackThinkingLevels('codex');

describe('supported-set helpers', () => {
  it('permanent fallbacks match the historical provider cycles (A1)', () => {
    expect(CLAUDE).toEqual(['off', 'medium', 'high', 'xhigh', 'max']);
    expect(CODEX).toEqual(['off', 'medium', 'high', 'xhigh']);
    expect(providerFallbackThinkingLevels(undefined)).toEqual(CLAUDE);
  });
  it('does not invent OpenCode effort levels when capabilities are unavailable', () => {
    expect(providerFallbackThinkingLevels('opencode')).toEqual([]);
  });
  it('clamps to the nearest supported tier at or below (defects 2/3)', () => {
    expect(clampThinkingLevel('max', CODEX)).toBe('xhigh');
    expect(clampThinkingLevel('low', CLAUDE)).toBe('medium');
    expect(clampThinkingLevel('high', [])).toBe('off');
  });
  it('advances within the supported set only', () => {
    expect(advanceThinkingLevel('xhigh', CODEX)).toBe('off');
    expect(advanceThinkingLevel('xhigh', CLAUDE)).toBe('max');
    expect(advanceThinkingLevel('low', CLAUDE)).toBe('high'); // low ≡ medium → next
  });
  // The fixed desktop dot table (design §10): Claude/default medium 0, high 1,
  // xhigh 2, max 3, ultra 3; Codex medium 1, high 2, xhigh 3 (clamped levels
  // above a set's top rung saturate at 3). Every (level × provider) cell is
  // pinned against a full declared set so no clamping hides a cell.
  describe('thinkingDotCount desktop-table parity', () => {
    const FULL = [...THINKING_LEVELS];

    it.each([
      ['off', 0],
      ['low', 0], // low ≡ medium in the UI
      ['medium', 0],
      ['high', 1],
      ['xhigh', 2],
      ['max', 3],
      ['ultra', 3],
    ] as const)('claude/default: %s → %d dots', (level, dots) => {
      expect(thinkingDotCount(level, FULL, 'claude')).toBe(dots);
      expect(thinkingDotCount(level, FULL, undefined)).toBe(dots);
    });

    it.each([
      ['off', 0],
      ['low', 1], // low ≡ medium in the UI
      ['medium', 1],
      ['high', 2],
      ['xhigh', 3],
      ['max', 3],
      ['ultra', 3],
    ] as const)('codex: %s → %d dots', (level, dots) => {
      expect(thinkingDotCount(level, FULL, 'codex')).toBe(dots);
    });

    it('clamps into the supported set before reading the table', () => {
      expect(thinkingDotCount('max', CODEX, 'codex')).toBe(3); // max → xhigh
      expect(thinkingDotCount('ultra', CLAUDE, 'claude')).toBe(3); // ultra → max
      expect(thinkingDotCount('high', [], 'claude')).toBe(0); // empty set → off
    });
  });

  it('clamps an unsupported upper tier down through gaps', () => {
    expect(clampThinkingLevel('ultra', ['off', 'medium', 'xhigh'])).toBe(
      'xhigh',
    );
  });

  it('uses the first non-low supported value when no lower tier exists', () => {
    expect(clampThinkingLevel('off', ['low', 'high'])).toBe('high');
  });

  it('falls back to off when low is the only supported value', () => {
    expect(clampThinkingLevel('off', ['low'])).toBe('off');
  });

  it('starts at the first cycle value for an unknown supported position', () => {
    expect(advanceThinkingLevel('max', CODEX)).toBe('off');
  });

  it('returns off for an empty cycle', () => {
    expect(advanceThinkingLevel('high', [])).toBe('off');
  });

  it('does not expose low as an advance result', () => {
    const supported: readonly ThinkingLevel[] = ['low', 'medium', 'high'];
    expect(advanceThinkingLevel('high', supported)).toBe('medium');
  });

  // The wire clamp must always return a member of the DECLARED set: the UI
  // clamp excludes `low` from its fallback candidates, so a low-only model
  // would otherwise transmit `off` — a level the host never declared
  // (PR #2625 round-3 review).
  describe('clampThinkingLevelToDeclared', () => {
    it('matches the UI clamp whenever its result is declared', () => {
      expect(clampThinkingLevelToDeclared('max', CODEX)).toBe('xhigh');
      expect(clampThinkingLevelToDeclared('low', CLAUDE)).toBe('medium');
      expect(
        clampThinkingLevelToDeclared('ultra', ['off', 'medium', 'xhigh']),
      ).toBe('xhigh');
      expect(clampThinkingLevelToDeclared('off', ['low', 'high'])).toBe('high');
    });

    it('preserves low when it is the only declared level', () => {
      expect(clampThinkingLevelToDeclared('high', ['low'])).toBe('low');
      expect(clampThinkingLevelToDeclared('off', ['low'])).toBe('low');
      expect(clampThinkingLevelToDeclared('low', ['low'])).toBe('low');
    });

    it('falls back to off only for an empty declared set', () => {
      expect(clampThinkingLevelToDeclared('high', [])).toBe('off');
    });
  });
});
