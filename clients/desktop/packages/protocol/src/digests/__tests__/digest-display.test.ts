import {
  DIGEST_DAILY_DESCRIPTION,
  DIGEST_WEEKDAY_LABELS,
  digestMonthlyDescription,
  digestOrdinalDay,
  digestWeekdayLabel,
  digestWeeklyDescription,
} from '../index';

describe('digestWeekdayLabel', () => {
  it('maps every ISO weekday anchor', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(digestWeekdayLabel)).toEqual([
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
      'Sunday',
    ]);
    expect(DIGEST_WEEKDAY_LABELS).toHaveLength(7);
  });

  it('clamps an out-of-range anchor instead of returning undefined', () => {
    // The wire contract validates 1-7, but a stale persisted row must still
    // render a string rather than "Every undefined".
    expect(digestWeekdayLabel(0)).toBe('Monday');
    expect(digestWeekdayLabel(99)).toBe('Sunday');
  });
});

describe('digestOrdinalDay', () => {
  it('uses the right suffix for every calendar day', () => {
    expect(digestOrdinalDay(1)).toBe('1st');
    expect(digestOrdinalDay(2)).toBe('2nd');
    expect(digestOrdinalDay(3)).toBe('3rd');
    expect(digestOrdinalDay(4)).toBe('4th');
    // The teens are the case a naive `% 10` gets wrong.
    expect(digestOrdinalDay(11)).toBe('11th');
    expect(digestOrdinalDay(12)).toBe('12th');
    expect(digestOrdinalDay(13)).toBe('13th');
    expect(digestOrdinalDay(21)).toBe('21st');
    expect(digestOrdinalDay(22)).toBe('22nd');
    expect(digestOrdinalDay(23)).toBe('23rd');
    expect(digestOrdinalDay(31)).toBe('31st');
  });

  it('clamps to the supported 1-31 range', () => {
    expect(digestOrdinalDay(0)).toBe('1st');
    expect(digestOrdinalDay(40)).toBe('31st');
  });
});

describe('cadence descriptions', () => {
  it('has no anchor for daily', () => {
    expect(DIGEST_DAILY_DESCRIPTION).toBe(
      'Every morning, covering the previous day.',
    );
  });

  it('names the weekly anchor day', () => {
    expect(digestWeeklyDescription(1)).toBe(
      'Every Monday, covering the previous week.',
    );
    expect(digestWeeklyDescription(5)).toBe(
      'Every Friday, covering the previous week.',
    );
  });

  it('names the monthly anchor day', () => {
    expect(digestMonthlyDescription(1)).toBe(
      'On the 1st, covering the previous calendar month.',
    );
    expect(digestMonthlyDescription(12)).toBe(
      'On the 12th, covering the previous calendar month.',
    );
  });

  it('calls out clamping for anchors past the shortest month', () => {
    // Server-side the anchor is passed explicitly to `addMonthsClamped`, so 31
    // gives Jan 31 -> Feb 28 -> Mar 31 rather than collapsing to the 28th. The
    // copy has to admit February will differ.
    expect(digestMonthlyDescription(29)).toContain(
      'Shorter months use their last day.',
    );
    expect(digestMonthlyDescription(31)).toContain(
      'Shorter months use their last day.',
    );
    expect(digestMonthlyDescription(28)).not.toContain('Shorter months');
  });
});
