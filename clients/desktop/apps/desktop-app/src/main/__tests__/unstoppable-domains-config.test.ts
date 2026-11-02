import {
  getUnstoppableDomainsAiCreditsManageUrl,
  getUnstoppableDomainsAiCreditsPurchaseUrl,
  getUnstoppableDomainsBaseUrl,
  getUnstoppableDomainsEnvironment,
  getUnstoppableDomainsWebBaseUrl,
  UNSTOPPABLE_DOMAINS_OAUTH_SCOPE,
} from '../unstoppable-domains/config';

describe('unstoppable-domains config', () => {
  describe('getUnstoppableDomainsEnvironment', () => {
    it('defaults to staging (jest build constant) when no runtime override', () => {
      expect(getUnstoppableDomainsEnvironment({})).toBe('staging');
    });

    it('honors a valid CANOPY_UD_OAUTH_ENV (case-insensitive)', () => {
      expect(
        getUnstoppableDomainsEnvironment({ CANOPY_UD_OAUTH_ENV: 'production' }),
      ).toBe('production');
      expect(
        getUnstoppableDomainsEnvironment({ CANOPY_UD_OAUTH_ENV: 'SANDBOX' }),
      ).toBe('sandbox');
    });

    it('falls back to the build-time env for unknown runtime values', () => {
      expect(
        getUnstoppableDomainsEnvironment({ CANOPY_UD_OAUTH_ENV: 'nope' }),
      ).toBe('staging');
    });

    it('uses the per-build __CANOPY_UD_OAUTH_ENV__ default when no runtime override', () => {
      // jest.config bakes this to 'staging'; flip to production for this case.
      try {
        Reflect.set(globalThis, '__CANOPY_UD_OAUTH_ENV__', 'production');
        expect(getUnstoppableDomainsEnvironment({})).toBe('production');
      } finally {
        Reflect.set(globalThis, '__CANOPY_UD_OAUTH_ENV__', 'staging');
      }
    });
  });

  describe('getUnstoppableDomainsBaseUrl', () => {
    it('resolves per-environment defaults', () => {
      expect(
        getUnstoppableDomainsBaseUrl({ CANOPY_UD_OAUTH_ENV: 'production' }),
      ).toBe('https://api.unstoppabledomains.com');
      expect(
        getUnstoppableDomainsBaseUrl({ CANOPY_UD_OAUTH_ENV: 'sandbox' }),
      ).toBe('https://api.ud-sandbox.com');
      expect(getUnstoppableDomainsBaseUrl({})).toBe(
        'https://api.ud-staging.com',
      );
    });

    it('prefers an explicit base-URL override and trims a trailing slash', () => {
      expect(
        getUnstoppableDomainsBaseUrl({
          CANOPY_UD_OAUTH_ENV: 'production',
          CANOPY_UD_OAUTH_BASE_URL: 'https://example.test/ud/',
        }),
      ).toBe('https://example.test/ud');
    });

    it('ignores a blank override', () => {
      expect(
        getUnstoppableDomainsBaseUrl({ CANOPY_UD_OAUTH_BASE_URL: '   ' }),
      ).toBe('https://api.ud-staging.com');
    });
  });

  describe('web + AI Credits URLs', () => {
    it('resolves the user-facing web host per environment (no api. prefix)', () => {
      expect(
        getUnstoppableDomainsWebBaseUrl({ CANOPY_UD_OAUTH_ENV: 'production' }),
      ).toBe('https://unstoppabledomains.com');
      expect(getUnstoppableDomainsWebBaseUrl({})).toBe(
        'https://domains.ud-staging.com',
      );
      expect(
        getUnstoppableDomainsWebBaseUrl({ CANOPY_UD_OAUTH_ENV: 'sandbox' }),
      ).toBe('https://ud-sandbox.com');
    });

    it('builds the signed-in AI Credits purchase URL from the web host', () => {
      expect(
        getUnstoppableDomainsAiCreditsPurchaseUrl({
          CANOPY_UD_OAUTH_ENV: 'production',
        }),
      ).toBe('https://unstoppabledomains.com/account/ai-credits?purchase=1');
      expect(getUnstoppableDomainsAiCreditsPurchaseUrl({})).toBe(
        'https://domains.ud-staging.com/account/ai-credits?purchase=1',
      );
    });

    it('builds the signed-in AI Credits management URL from the web host', () => {
      expect(
        getUnstoppableDomainsAiCreditsManageUrl({
          CANOPY_UD_OAUTH_ENV: 'production',
        }),
      ).toBe('https://unstoppabledomains.com/account/ai-credits');
      expect(getUnstoppableDomainsAiCreditsManageUrl({})).toBe(
        'https://domains.ud-staging.com/account/ai-credits',
      );
    });

    it('ignores the API base-URL override for the web host', () => {
      expect(
        getUnstoppableDomainsWebBaseUrl({
          CANOPY_UD_OAUTH_ENV: 'production',
          CANOPY_UD_OAUTH_BASE_URL: 'https://example.test/ud',
        }),
      ).toBe('https://unstoppabledomains.com');
    });
  });

  it('requests the ai-billing scope', () => {
    expect(UNSTOPPABLE_DOMAINS_OAUTH_SCOPE).toBe('ai-billing');
  });
});
