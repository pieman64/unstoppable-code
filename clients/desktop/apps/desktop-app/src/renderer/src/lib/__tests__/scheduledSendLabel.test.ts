import {
  formatScheduledSendCompactLabel,
  formatScheduledSendLabel,
} from '../scheduledSendLabel';

// Friday, October 2 2026, 11:20 local time.
const NOW = new Date(2026, 9, 2, 11, 20);

function at(
  month: number,
  day: number,
  hour: number,
  minute = 0,
  year = 2026,
): Date {
  return new Date(year, month, day, hour, minute);
}

describe('formatScheduledSendLabel', () => {
  it('names today and tomorrow', () => {
    expect(formatScheduledSendLabel(at(9, 2, 15, 30), NOW, 'en-US')).toBe(
      'Today 3:30 PM',
    );
    expect(formatScheduledSendLabel(at(9, 3, 9), NOW, 'en-US')).toBe(
      'Tomorrow 9:00 AM',
    );
  });

  it('counts calendar days, not 24-hour spans', () => {
    // Under 24 hours away, but past midnight: tomorrow.
    expect(formatScheduledSendLabel(at(9, 3, 1), NOW, 'en-US')).toBe(
      'Tomorrow 1:00 AM',
    );
  });

  it('uses the weekday within the week', () => {
    expect(formatScheduledSendLabel(at(9, 4, 9), NOW, 'en-US')).toBe(
      'Sun 9:00 AM',
    );
    expect(formatScheduledSendLabel(at(9, 8, 18, 5), NOW, 'en-US')).toBe(
      'Thu 6:05 PM',
    );
  });

  it('uses the date past the week, with the year only when it differs', () => {
    expect(formatScheduledSendLabel(at(9, 12, 9), NOW, 'en-US')).toBe(
      'Oct 12, 9:00 AM',
    );
    expect(formatScheduledSendLabel(at(0, 5, 9, 0, 2027), NOW, 'en-US')).toBe(
      'Jan 5, 2027, 9:00 AM',
    );
  });
});

describe('formatScheduledSendCompactLabel', () => {
  it('keeps only the time today and tomorrow, then the day', () => {
    expect(
      formatScheduledSendCompactLabel(at(9, 2, 15, 30), NOW, 'en-US'),
    ).toBe('3:30 PM');
    expect(formatScheduledSendCompactLabel(at(9, 3, 9), NOW, 'en-US')).toBe(
      '9:00 AM',
    );
    expect(formatScheduledSendCompactLabel(at(9, 4, 9), NOW, 'en-US')).toBe(
      'Sun',
    );
    expect(formatScheduledSendCompactLabel(at(9, 12, 9), NOW, 'en-US')).toBe(
      'Oct 12',
    );
  });
});
