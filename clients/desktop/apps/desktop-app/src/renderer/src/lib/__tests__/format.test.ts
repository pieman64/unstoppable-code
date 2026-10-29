import { formatDate, formatDateOrEmpty } from '../format';

describe('formatDate', () => {
  it('formats an ISO timestamp with a short month', () => {
    const timestamp = '2026-07-22T12:00:00.000Z';
    expect(formatDate(timestamp)).toBe(
      new Intl.DateTimeFormat(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }).format(new Date(timestamp)),
    );
  });

  it('returns the identical string for a repeated timestamp', () => {
    // The formatter is shared and results are cached per ISO string; a second
    // call must not diverge from the first.
    const first = formatDate('2026-01-02T03:04:05.000Z');
    expect(formatDate('2026-01-02T03:04:05.000Z')).toBe(first);
  });

  it('keeps the pre-cache behavior for unparseable input', () => {
    // `Intl.DateTimeFormat#format` throws on an invalid date where
    // `toLocaleDateString` returns 'Invalid Date'; the cached path must still
    // return the latter.
    expect(formatDate('not-a-date')).toBe('Invalid Date');
    expect(formatDate('not-a-date')).toBe('Invalid Date');
  });

  it('distinguishes different timestamps rather than reusing a cached value', () => {
    expect(formatDate('2026-03-04T00:00:00.000Z')).not.toBe(
      formatDate('2025-11-30T00:00:00.000Z'),
    );
  });
});

describe('formatDateOrEmpty', () => {
  it('renders an empty string for absent or invalid values', () => {
    expect(formatDateOrEmpty(undefined)).toBe('');
    expect(formatDateOrEmpty('')).toBe('');
    expect(formatDateOrEmpty('not-a-date')).toBe('');
  });

  it('delegates to formatDate for valid values', () => {
    expect(formatDateOrEmpty('2026-07-22T12:00:00.000Z')).toBe(
      formatDate('2026-07-22T12:00:00.000Z'),
    );
  });
});
