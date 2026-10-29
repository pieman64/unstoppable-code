import {
  computeRetentionExpiryMs,
  normalizeArchiveRetentionDays,
  retainedItemStateOf,
  isRetainedItemExpired,
  isArchiveRetentionDays,
} from '../index';

describe('archive retention', () => {
  it.each([0, 36_501, null, undefined, NaN, 1.5])(
    'defaults invalid retention %s to seven days',
    (value): void => {
      expect(normalizeArchiveRetentionDays(value)).toBe(7);
    },
  );
  it('preserves a valid retention window', (): void => {
    expect(normalizeArchiveRetentionDays(30)).toBe(30);
    expect(isArchiveRetentionDays('7')).toBe(false);
  });
  it('computes a deadline from entry into Deleted', (): void => {
    expect(computeRetentionExpiryMs(0, 7)).toBe(604_800_000);
  });
  it('keeps Archives forever and expires Deleted items inclusively', (): void => {
    expect(retainedItemStateOf(null)).toBe('archived');
    expect(retainedItemStateOf(5)).toBe('deleted');
    expect(isRetainedItemExpired(null, 100)).toBe(false);
    expect(isRetainedItemExpired(5, 5)).toBe(true);
  });
});
