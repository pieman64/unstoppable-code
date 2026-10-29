import {
  DEFAULT_CODE_GRAPH_PREFERENCES,
  DEFAULT_GENERATION_TIMEOUT_MINUTES,
  isValidGenerationTimeoutMinutes,
  normalizeCodeGraphPreferences,
} from '../code-graph-preferences';

describe('isValidGenerationTimeoutMinutes', () => {
  it('accepts whole minutes within the inclusive 1–1440 range', () => {
    expect(isValidGenerationTimeoutMinutes(1)).toBe(true);
    expect(isValidGenerationTimeoutMinutes(30)).toBe(true);
    expect(isValidGenerationTimeoutMinutes(1440)).toBe(true);
  });

  it('rejects out-of-range, fractional, and non-finite values', () => {
    expect(isValidGenerationTimeoutMinutes(0)).toBe(false);
    expect(isValidGenerationTimeoutMinutes(1441)).toBe(false);
    expect(isValidGenerationTimeoutMinutes(30.5)).toBe(false);
    expect(isValidGenerationTimeoutMinutes(Number.NaN)).toBe(false);
    expect(isValidGenerationTimeoutMinutes(Number.POSITIVE_INFINITY)).toBe(
      false,
    );
  });
});

describe('normalizeCodeGraphPreferences', () => {
  it('returns the default when the value is missing', () => {
    expect(normalizeCodeGraphPreferences(undefined)).toEqual(
      DEFAULT_CODE_GRAPH_PREFERENCES,
    );
    expect(normalizeCodeGraphPreferences(null)).toEqual(
      DEFAULT_CODE_GRAPH_PREFERENCES,
    );
  });

  it('preserves a complete, valid value', () => {
    const value = {
      mode: 'selected-workspaces' as const,
      selectedWorkspaceIds: ['ws-1', 'ws-2'],
      generationTimeoutMinutes: 45,
    };
    expect(normalizeCodeGraphPreferences(value)).toEqual(value);
  });

  it('falls back the timeout to 30 for out-of-range/fractional/missing values', () => {
    expect(
      normalizeCodeGraphPreferences({
        mode: 'enabled',
        selectedWorkspaceIds: [],
        generationTimeoutMinutes: 5000,
      }).generationTimeoutMinutes,
    ).toBe(DEFAULT_GENERATION_TIMEOUT_MINUTES);
    expect(
      normalizeCodeGraphPreferences({
        mode: 'enabled',
        selectedWorkspaceIds: [],
        generationTimeoutMinutes: 12.5,
      }).generationTimeoutMinutes,
    ).toBe(DEFAULT_GENERATION_TIMEOUT_MINUTES);
  });

  it('coerces an unknown mode to enabled and a non-array selection to []', () => {
    const normalized = normalizeCodeGraphPreferences({
      // @ts-expect-error deliberately invalid runtime input
      mode: 'bogus',
      // @ts-expect-error deliberately invalid runtime input
      selectedWorkspaceIds: 'nope',
      generationTimeoutMinutes: 30,
    });
    expect(normalized.mode).toBe('enabled');
    expect(normalized.selectedWorkspaceIds).toEqual([]);
  });
});
