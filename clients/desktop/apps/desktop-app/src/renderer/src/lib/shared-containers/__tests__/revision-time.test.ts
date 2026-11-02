import { formatRevisionTime } from '../revision-time';

const NY = { locale: 'en-US', timeZone: 'America/New_York' };

describe('formatRevisionTime (CAN-4908)', () => {
  it('shows only the time for a revision published today', () => {
    expect(
      formatRevisionTime('2026-10-23T19:42:00.000Z', {
        ...NY,
        now: new Date('2026-10-23T21:00:00.000Z'),
      }),
    ).toEqual({
      short: '3:42 PM',
      full: 'Friday, October 23, 2026 at 3:42:00 PM EDT',
      iso: '2026-10-23T19:42:00.000Z',
    });
  });

  it('adds the date for an earlier day this year', () => {
    expect(
      formatRevisionTime('2026-03-02T14:05:00.000Z', {
        ...NY,
        now: new Date('2026-10-23T21:00:00.000Z'),
      })?.short,
    ).toBe('Mar 2, 9:05 AM');
  });

  it('adds the year for an earlier year', () => {
    expect(
      formatRevisionTime('2025-12-31T15:00:00.000Z', {
        ...NY,
        now: new Date('2026-01-02T15:00:00.000Z'),
      })?.short,
    ).toBe('Dec 31, 2025, 10:00 AM');
  });

  it('decides "today" on the viewer clock, not UTC, across midnight', () => {
    // 11:30 PM local on the 22nd is 03:30 UTC on the 23rd.
    const lateEvening = '2026-10-23T03:30:00.000Z';
    expect(
      formatRevisionTime(lateEvening, {
        ...NY,
        now: new Date('2026-10-23T12:00:00.000Z'),
      })?.short,
    ).toBe('Oct 22, 11:30 PM');
    expect(
      formatRevisionTime(lateEvening, {
        ...NY,
        now: new Date('2026-10-23T03:45:00.000Z'),
      })?.short,
    ).toBe('11:30 PM');
  });

  it('names the timezone that applied at publication across a DST change', () => {
    const now = new Date('2026-11-02T15:00:00.000Z');
    expect(
      formatRevisionTime('2026-10-31T16:00:00.000Z', { ...NY, now })?.full,
    ).toBe('Saturday, October 31, 2026 at 12:00:00 PM EDT');
    expect(
      formatRevisionTime('2026-11-01T17:00:00.000Z', { ...NY, now })?.full,
    ).toBe('Sunday, November 1, 2026 at 12:00:00 PM EST');
  });

  it.each([undefined, '', 'later', '2026-13-45T99:00:00Z'])(
    'returns null for %p instead of an invalid date',
    (value) => {
      expect(formatRevisionTime(value, NY)).toBeNull();
    },
  );
});
