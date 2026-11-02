import {
  completionStampTooltip,
  formatCompletionTimestamp,
} from '../format-completion-timestamp';

describe('formatCompletionTimestamp', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // A fixed local-noon anchor keeps same-day / yesterday tier boundaries
    // stable regardless of the machine timezone.
    jest.setSystemTime(new Date(2026, 7, 20, 12, 0, 0));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const now = (): number => Date.now();

  const timeOf = (ms: number): string =>
    new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    }).format(ms);

  it('renders "just now" under a minute', () => {
    expect(formatCompletionTimestamp(now() - 5_000)).toBe('just now');
    expect(formatCompletionTimestamp(now() - 59_000)).toBe('just now');
  });

  it('renders minutes ago under 11 minutes', () => {
    expect(formatCompletionTimestamp(now() - 60_000)).toBe('1m ago');
    expect(formatCompletionTimestamp(now() - 5 * 60_000)).toBe('5m ago');
    expect(formatCompletionTimestamp(now() - 10 * 60_000)).toBe('10m ago');
  });

  it('renders the clock time from 11 minutes on the same day', () => {
    const elevenMinutesAgo = now() - 11 * 60_000;
    expect(formatCompletionTimestamp(elevenMinutesAgo)).toBe(
      timeOf(elevenMinutesAgo),
    );
    const threeHoursAgo = now() - 3 * 3_600_000;
    expect(formatCompletionTimestamp(threeHoursAgo)).toBe(
      timeOf(threeHoursAgo),
    );
  });

  it('renders the weekday and clock time for completions within the past week', () => {
    const weekdayOf = (ms: number): string =>
      new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(ms);

    const yesterdayEvening = new Date(2026, 7, 19, 20, 30, 0).getTime();
    expect(formatCompletionTimestamp(yesterdayEvening)).toBe(
      `${weekdayOf(yesterdayEvening)}, ${timeOf(yesterdayEvening)}`,
    );

    // Six calendar days back is still the weekday tier...
    const sixDaysAgo = new Date(2026, 7, 14, 9, 15, 0).getTime();
    expect(formatCompletionTimestamp(sixDaysAgo)).toBe(
      `${weekdayOf(sixDaysAgo)}, ${timeOf(sixDaysAgo)}`,
    );

    // ...seven days back would collide with today's weekday name, so it
    // falls through to the month-day tier.
    const sevenDaysAgo = new Date(2026, 7, 13, 9, 15, 0).getTime();
    const datePart = new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
    }).format(sevenDaysAgo);
    expect(formatCompletionTimestamp(sevenDaysAgo)).toBe(
      `${datePart}, ${timeOf(sevenDaysAgo)}`,
    );
  });

  it('renders month, day, and clock time for older completions', () => {
    const older = new Date(2026, 3, 10, 9, 15, 0).getTime();
    const datePart = new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
    }).format(older);
    expect(formatCompletionTimestamp(older)).toBe(
      `${datePart}, ${timeOf(older)}`,
    );
  });

  it('includes the year for completions from a different year', () => {
    const lastYear = new Date(2025, 3, 10, 9, 15, 0).getTime();
    const datePart = new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(lastYear);
    expect(formatCompletionTimestamp(lastYear)).toBe(
      `${datePart}, ${timeOf(lastYear)}`,
    );
  });

  it('falls back to "just now" for future or invalid timestamps', () => {
    expect(formatCompletionTimestamp(now() + 60_000)).toBe('just now');
    expect(formatCompletionTimestamp(Number.NaN)).toBe('just now');
  });
});

describe('completionStampTooltip', () => {
  const now = new Date(2026, 9, 22, 12, 0).getTime();
  const at = (date: Date): number => date.getTime();

  it('adds the exact time behind a relative or time-only label', () => {
    expect(completionStampTooltip(now - 2 * 60_000, undefined, now)).toMatch(
      /Oct 22, 2026/,
    );
    expect(
      completionStampTooltip(at(new Date(2026, 9, 22, 9, 15)), undefined, now),
    ).toMatch(/Oct 22, 2026/);
    expect(
      completionStampTooltip(at(new Date(2026, 9, 19, 9, 15)), undefined, now),
    ).toMatch(/Oct 19, 2026/);
  });

  it('shows nothing when the label already has the date and time', () => {
    expect(
      completionStampTooltip(at(new Date(2026, 9, 9, 14, 23)), undefined, now),
    ).toBeUndefined();
    expect(
      completionStampTooltip(at(new Date(2025, 9, 9, 14, 23)), undefined, now),
    ).toBeUndefined();
  });

  it('keeps the model, which the label never shows', () => {
    expect(
      completionStampTooltip(at(new Date(2026, 9, 9, 14, 23)), 'Opus 5.5', now),
    ).toBe('Opus 5.5');
    expect(completionStampTooltip(now - 60_000, 'Opus 5.5', now)).toMatch(
      /Oct 22, 2026.* · Opus 5\.5$/,
    );
  });
});
