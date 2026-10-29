import { normalizePreferences } from '../lib/preferences-store';

describe('normalizePreferences — navigation mode (CAN-1817)', () => {
  test('defaults to Code mode when absent', () => {
    expect(normalizePreferences({}).navigationMode).toBe('code');
  });

  test('round-trips both modes', () => {
    expect(
      normalizePreferences({ navigationMode: 'work' }).navigationMode,
    ).toBe('work');
    expect(
      normalizePreferences({ navigationMode: 'code' }).navigationMode,
    ).toBe('code');
  });

  test('falls back to Code mode for unknown values', () => {
    const rawPreferences: Record<string, unknown> = {
      navigationMode: 'cowork',
    };
    expect(normalizePreferences(rawPreferences).navigationMode).toBe('code');
    const numeric: Record<string, unknown> = { navigationMode: 1 };
    expect(normalizePreferences(numeric).navigationMode).toBe('code');
  });
});
