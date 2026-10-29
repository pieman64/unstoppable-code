import { isGuestAccount } from '../guest-account';

describe('isGuestAccount', () => {
  it('returns true when credentialSource is "guest"', () => {
    expect(isGuestAccount({ credentialSource: 'guest', authMode: null })).toBe(
      true,
    );
  });

  it('returns true for a normalized guest tagged only via authMode', () => {
    // Legacy / normalized entries can carry `authMode: 'guest'` while
    // `credentialSource` has been normalized to a non-guest value.
    expect(
      isGuestAccount({ credentialSource: 'manual', authMode: 'guest' }),
    ).toBe(true);
  });

  it('returns false for a real oauth account', () => {
    expect(
      isGuestAccount({ credentialSource: 'oauth_desktop', authMode: 'oauth' }),
    ).toBe(false);
  });

  it('returns false for a manual api-key account', () => {
    expect(
      isGuestAccount({ credentialSource: 'manual', authMode: 'api_key' }),
    ).toBe(false);
  });

  it('returns false for null / undefined', () => {
    expect(isGuestAccount(null)).toBe(false);
    expect(isGuestAccount(undefined)).toBe(false);
  });
});
