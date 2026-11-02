import {
  DEFAULT_MANAGED_DELEGATION_LIFETIME_LIMIT,
  MAX_MANAGED_DELEGATION_LIFETIME_LIMIT,
  DELEGATION_STORAGE_RECORD_LIMIT,
  DELEGATION_STORAGE_ENTRY_LIMIT,
  MANAGED_DELEGATION_LIFETIME_LIMIT_CHOICES,
  managedDelegationLifetimeLimitChoices,
  defaultManagedDelegationLifetimeLimit,
  normalizeManagedDelegationLifetimeLimit,
  managedDelegationEffectiveLifetimeLimit,
} from '../discovery';

describe('measured lifetime policy', () => {
  it('ships only the measured 512 choice, cap and default', () => {
    expect(DEFAULT_MANAGED_DELEGATION_LIFETIME_LIMIT).toBe(512);
    expect(MAX_MANAGED_DELEGATION_LIFETIME_LIMIT).toBe(512);
    expect(defaultManagedDelegationLifetimeLimit()).toBe(512);
    expect(defaultManagedDelegationLifetimeLimit(512)).toBe(512);
    expect(MANAGED_DELEGATION_LIFETIME_LIMIT_CHOICES).toEqual([
      512, 1024, 2048, 4096,
    ]);
    expect(managedDelegationLifetimeLimitChoices()).toEqual([512]);
    expect(DELEGATION_STORAGE_RECORD_LIMIT).toBe(65536);
    expect(DELEGATION_STORAGE_ENTRY_LIMIT).toBe(131072);
  });

  it.each([
    undefined,
    null,
    '',
    '1024',
    0,
    -1,
    511,
    513,
    1024,
    4096,
    NaN,
    Infinity,
  ])('defaults invalid or above-shipped-cap preference %p', (value) => {
    expect(normalizeManagedDelegationLifetimeLimit(value)).toBe(512);
  });

  it('supports injected caps without offering choices beyond them', () => {
    expect(managedDelegationLifetimeLimitChoices(1024)).toEqual([512, 1024]);
    expect(managedDelegationLifetimeLimitChoices(3072)).toEqual([
      512, 1024, 2048,
    ]);
    expect(normalizeManagedDelegationLifetimeLimit(1024, 3072)).toBe(1024);
    expect(normalizeManagedDelegationLifetimeLimit(4096, 3072)).toBe(1024);
  });

  it.each([1024, 3072])(
    'uses the cap-aware 1024 default under test cap %p',
    (cap) => {
      expect(defaultManagedDelegationLifetimeLimit(cap)).toBe(1024);
      expect(normalizeManagedDelegationLifetimeLimit(undefined, cap)).toBe(
        1024,
      );
      expect(normalizeManagedDelegationLifetimeLimit('invalid', cap)).toBe(
        1024,
      );
    },
  );

  it.each([
    [0, 512, 512, 512],
    [1024, 1024, 3072, 2048],
    [2048, 512, 3072, 2560],
    [2560, 1024, 3072, 3072],
    [Number.MAX_SAFE_INTEGER, 1024, 3072, 3072],
    [Number.MAX_SAFE_INTEGER - 1, 4096, Number.MAX_SAFE_INTEGER, 65536],
    [65535, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 65536],
  ])(
    'saturates baseline %p plus setting %p under cap %p to %p',
    (baseline, setting, cap, expected) => {
      expect(
        managedDelegationEffectiveLifetimeLimit(baseline, setting, cap),
      ).toBe(expected);
    },
  );
});
