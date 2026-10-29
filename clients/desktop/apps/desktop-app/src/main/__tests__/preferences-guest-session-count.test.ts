import { normalizePreferences } from '../lib/preferences-store';

describe('normalizePreferences — guest session counters (CAN-936, WS3)', () => {
  test('defaults both counters to 0 when omitted', () => {
    const result = normalizePreferences({});
    expect(result.guestSessionCount).toBe(0);
    expect(result.guestUpgradeNudgeLastShownSessionCount).toBe(0);
  });

  test('round-trips finite integer values', () => {
    const result = normalizePreferences({
      guestSessionCount: 7,
      guestUpgradeNudgeLastShownSessionCount: 5,
    });
    expect(result.guestSessionCount).toBe(7);
    expect(result.guestUpgradeNudgeLastShownSessionCount).toBe(5);
  });

  test('floors fractional values to integers', () => {
    const result = normalizePreferences({
      guestSessionCount: 3.9,
      guestUpgradeNudgeLastShownSessionCount: 2.4,
    });
    expect(result.guestSessionCount).toBe(3);
    expect(result.guestUpgradeNudgeLastShownSessionCount).toBe(2);
  });

  test('clamps negative values to 0', () => {
    const result = normalizePreferences({
      guestSessionCount: -4,
      guestUpgradeNudgeLastShownSessionCount: -1,
    });
    expect(result.guestSessionCount).toBe(0);
    expect(result.guestUpgradeNudgeLastShownSessionCount).toBe(0);
  });

  test('falls back to 0 for non-numeric / non-finite values', () => {
    const result = normalizePreferences({
      guestSessionCount: 'nope' as unknown as number,
      guestUpgradeNudgeLastShownSessionCount: Number.NaN,
    });
    expect(result.guestSessionCount).toBe(0);
    expect(result.guestUpgradeNudgeLastShownSessionCount).toBe(0);
  });
});
