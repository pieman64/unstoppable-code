import { normalizePreferences } from '../lib/preferences-store';

describe('normalizePreferences — onboardingCompleted', () => {
  test('defaults to an empty array when omitted', () => {
    const result = normalizePreferences({});
    expect(result.onboardingCompleted).toEqual([]);
  });

  test('round-trips known string entries', () => {
    const result = normalizePreferences({ onboardingCompleted: ['v1'] });
    expect(result.onboardingCompleted).toEqual(['v1']);
  });

  test('filters non-string entries', () => {
    const result = normalizePreferences({
      onboardingCompleted: [
        'v1',
        42,
        null,
        undefined,
        'v2',
      ] as unknown as string[],
    });
    expect(result.onboardingCompleted).toEqual(['v1', 'v2']);
  });

  test('dedupes repeated entries', () => {
    const result = normalizePreferences({
      onboardingCompleted: ['v1', 'v1', 'v2', 'v1'],
    });
    expect(result.onboardingCompleted).toEqual(['v1', 'v2']);
  });

  test('returns an empty array when input is not an array', () => {
    const result = normalizePreferences({
      onboardingCompleted: 'v1' as unknown as string[],
    });
    expect(result.onboardingCompleted).toEqual([]);
  });
});
