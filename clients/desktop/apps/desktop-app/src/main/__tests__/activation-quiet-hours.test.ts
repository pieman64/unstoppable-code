import {
  DEFAULT_ACTIVATION_QUIET_HOURS,
  isWithinQuietHours,
} from '../notifications/campaigns/quiet-hours';

function at(hour: number): Date {
  return new Date(2026, 0, 15, hour, 30, 0);
}

describe('isWithinQuietHours', () => {
  it('is never quiet when disabled', () => {
    const disabled = { enabled: false, startHour: 22, endHour: 8 };
    for (const hour of [0, 6, 12, 23]) {
      expect(isWithinQuietHours(at(hour), disabled)).toBe(false);
    }
  });

  it('handles an overnight window across midnight', () => {
    // The default 22:00-08:00 case: a naive start <= hour < end comparison
    // would be wrong for every overnight setting.
    const quiet = DEFAULT_ACTIVATION_QUIET_HOURS;
    expect(isWithinQuietHours(at(23), quiet)).toBe(true);
    expect(isWithinQuietHours(at(2), quiet)).toBe(true);
    expect(isWithinQuietHours(at(7), quiet)).toBe(true);
    expect(isWithinQuietHours(at(8), quiet)).toBe(false);
    expect(isWithinQuietHours(at(12), quiet)).toBe(false);
    expect(isWithinQuietHours(at(21), quiet)).toBe(false);
    expect(isWithinQuietHours(at(22), quiet)).toBe(true);
  });

  it('handles a same-day window', () => {
    const quiet = { enabled: true, startHour: 9, endHour: 17 };
    expect(isWithinQuietHours(at(8), quiet)).toBe(false);
    expect(isWithinQuietHours(at(9), quiet)).toBe(true);
    expect(isWithinQuietHours(at(16), quiet)).toBe(true);
    expect(isWithinQuietHours(at(17), quiet)).toBe(false);
  });

  it('treats an empty window as never quiet, not always quiet', () => {
    // Silently muting a campaign forever is the worse failure mode.
    const quiet = { enabled: true, startHour: 10, endHour: 10 };
    for (const hour of [0, 9, 10, 11, 23]) {
      expect(isWithinQuietHours(at(hour), quiet)).toBe(false);
    }
  });

  it('ignores an out-of-range window rather than muting everything', () => {
    expect(
      isWithinQuietHours(at(3), { enabled: true, startHour: -1, endHour: 8 }),
    ).toBe(false);
    expect(
      isWithinQuietHours(at(3), { enabled: true, startHour: 22, endHour: 99 }),
    ).toBe(false);
    expect(
      isWithinQuietHours(at(3), { enabled: true, startHour: 1.5, endHour: 8 }),
    ).toBe(false);
  });
});
