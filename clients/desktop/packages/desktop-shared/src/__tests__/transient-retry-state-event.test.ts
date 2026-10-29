import {
  TRANSIENT_RETRY_STATE_EVENT_TYPE,
  isTransientRetryStateEventData,
} from '@canopy/desktop-shared/types';

const VALID_EVENT = {
  type: TRANSIENT_RETRY_STATE_EVENT_TYPE,
  provider: 'claude',
  active: true,
  attempt: 2,
  maxAttempts: 5,
  nextRetryAt: 1_750_000_000_000,
  exhausted: false,
};

describe('transient retry state event guard', () => {
  it('accepts scheduled, exhausted, and inactive service states', () => {
    expect(isTransientRetryStateEventData(VALID_EVENT)).toBe(true);
    expect(
      isTransientRetryStateEventData({
        ...VALID_EVENT,
        attempt: 5,
        nextRetryAt: null,
        exhausted: true,
      }),
    ).toBe(true);
    expect(
      isTransientRetryStateEventData({
        ...VALID_EVENT,
        active: false,
        nextRetryAt: null,
      }),
    ).toBe(true);
  });

  it.each([
    ['NaN attempt', { ...VALID_EVENT, attempt: Number.NaN }],
    ['infinite attempt', { ...VALID_EVENT, attempt: Number.POSITIVE_INFINITY }],
    ['fractional attempt', { ...VALID_EVENT, attempt: 1.5 }],
    ['zero attempt', { ...VALID_EVENT, attempt: 0 }],
    ['attempt beyond maximum', { ...VALID_EVENT, attempt: 6 }],
    ['fractional maximum', { ...VALID_EVENT, maxAttempts: 5.5 }],
    ['non-positive maximum', { ...VALID_EVENT, maxAttempts: 0 }],
    ['NaN retry timestamp', { ...VALID_EVENT, nextRetryAt: Number.NaN }],
    [
      'infinite retry timestamp',
      { ...VALID_EVENT, nextRetryAt: Number.POSITIVE_INFINITY },
    ],
    ['fractional retry timestamp', { ...VALID_EVENT, nextRetryAt: 1.5 }],
    ['negative retry timestamp', { ...VALID_EVENT, nextRetryAt: -1 }],
    [
      'active state without a retry timestamp',
      { ...VALID_EVENT, nextRetryAt: null },
    ],
    [
      'exhausted state before the maximum attempt',
      { ...VALID_EVENT, nextRetryAt: null, exhausted: true },
    ],
    [
      'exhausted state with a retry timestamp',
      { ...VALID_EVENT, attempt: 5, exhausted: true },
    ],
    [
      'inactive state with a retry timestamp',
      { ...VALID_EVENT, active: false },
    ],
  ])('rejects %s', (_description, event) => {
    expect(isTransientRetryStateEventData(event)).toBe(false);
  });
});
