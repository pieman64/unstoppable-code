import { formatUsageLimitTimeLabel } from '../usage-limit-time-label';

describe('formatUsageLimitTimeLabel', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-17T10:00:00'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns a clock time for a moment later today', () => {
    const label = formatUsageLimitTimeLabel(
      new Date('2026-09-17T18:00:00').getTime(),
    );
    expect(label).toMatch(/^6:00/);
    expect(label).not.toMatch(/Thu/);
  });

  it('adds the weekday for another day, from a number or an ISO string', () => {
    const at = new Date('2026-09-22T09:00:00');
    expect(formatUsageLimitTimeLabel(at.getTime())).toMatch(/Tue/);
    expect(formatUsageLimitTimeLabel(at.toISOString())).toMatch(/Tue/);
  });

  it('treats absent, empty, zero, and invalid inputs as no time', () => {
    expect(formatUsageLimitTimeLabel(undefined)).toBeNull();
    expect(formatUsageLimitTimeLabel('')).toBeNull();
    expect(formatUsageLimitTimeLabel(0)).toBeNull();
    expect(formatUsageLimitTimeLabel('not a date')).toBeNull();
    expect(formatUsageLimitTimeLabel(Number.NaN)).toBeNull();
  });
});
