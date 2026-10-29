import { isDifferentProviderAccount } from '../accountChangeDetection';
import type { AgentProviderAuthStatus } from '@canopy/desktop-shared/types';

const status = (
  over: Partial<AgentProviderAuthStatus>,
): AgentProviderAuthStatus => ({
  authenticated: true,
  accountLabel: null,
  detail: null,
  error: null,
  ...over,
});

describe('isDifferentProviderAccount', () => {
  it('false when after is not authenticated', () => {
    expect(
      isDifferentProviderAccount(
        'claude',
        status({ accountEmail: 'a@x.com' }),
        status({ authenticated: false }),
      ),
    ).toBe(false);
  });

  it('true when subscription email changed', () => {
    expect(
      isDifferentProviderAccount(
        'claude',
        status({ accountEmail: 'a@x.com', accountKind: 'subscription' }),
        status({ accountEmail: 'b@x.com', accountKind: 'subscription' }),
      ),
    ).toBe(true);
  });

  it('false when subscription email unchanged (case-insensitive)', () => {
    expect(
      isDifferentProviderAccount(
        'claude',
        status({ accountEmail: 'a@x.com', accountKind: 'subscription' }),
        status({ accountEmail: 'a@x.com', accountKind: 'subscription' }),
      ),
    ).toBe(false);
    expect(
      isDifferentProviderAccount(
        'claude',
        status({ accountEmail: 'a@x.com', accountKind: 'subscription' }),
        status({ accountEmail: 'A@X.com', accountKind: 'subscription' }),
      ),
    ).toBe(false);
  });

  it('true when subscription email is unchanged but plan changed', () => {
    expect(
      isDifferentProviderAccount(
        'claude',
        status({
          accountEmail: 'same@x.com',
          accountKind: 'subscription',
          planType: 'default_claude_max_20x',
        }),
        status({
          accountEmail: 'same@x.com',
          accountKind: 'subscription',
          planType: 'team-premium',
        }),
      ),
    ).toBe(true);
  });

  it('false when subscription email and normalized plan are unchanged', () => {
    expect(
      isDifferentProviderAccount(
        'claude',
        status({
          accountEmail: 'same@x.com',
          accountKind: 'subscription',
          planType: ' Team-Premium ',
        }),
        status({
          accountEmail: 'SAME@X.COM',
          accountKind: 'subscription',
          planType: 'team-premium',
        }),
      ),
    ).toBe(false);
  });

  it('does not infer a plan change when either plan type is unavailable', () => {
    expect(
      isDifferentProviderAccount(
        'claude',
        status({
          accountEmail: 'same@x.com',
          accountKind: 'subscription',
          planType: 'max',
        }),
        status({
          accountEmail: 'same@x.com',
          accountKind: 'subscription',
          planType: null,
        }),
      ),
    ).toBe(false);
  });

  it('does not infer a Claude plan change from a coarse plan value', () => {
    expect(
      isDifferentProviderAccount(
        'claude',
        status({
          accountEmail: 'same@x.com',
          accountKind: 'subscription',
          planType: 'max',
        }),
        status({
          accountEmail: 'same@x.com',
          accountKind: 'subscription',
          planType: 'default_claude_max_20x',
        }),
      ),
    ).toBe(false);
    expect(
      isDifferentProviderAccount(
        'claude',
        status({
          accountEmail: 'same@x.com',
          accountKind: 'subscription',
          planType: 'team',
        }),
        status({
          accountEmail: 'same@x.com',
          accountKind: 'subscription',
          planType: 'team-premium',
        }),
      ),
    ).toBe(false);
  });

  it('canonicalizes equivalent precise Claude Max tier representations', () => {
    expect(
      isDifferentProviderAccount(
        'claude',
        status({
          accountEmail: 'same@x.com',
          accountKind: 'subscription',
          planType: 'default_claude_max_20x',
        }),
        status({
          accountEmail: 'same@x.com',
          accountKind: 'subscription',
          planType: 'max-20x',
        }),
      ),
    ).toBe(false);
  });

  it('true when previously unauthenticated and now signed in', () => {
    expect(
      isDifferentProviderAccount(
        'claude',
        status({ authenticated: false }),
        status({ accountEmail: 'a@x.com', accountKind: 'subscription' }),
      ),
    ).toBe(true);
  });

  it('API key: uses auth fingerprint to decide different', () => {
    expect(
      isDifferentProviderAccount(
        'claude',
        status({
          accountKind: 'api_key',
          accountLabel: 'API key',
          detail: null,
          authFingerprint: 'auth:API key::api-key:rev1',
        }),
        status({
          accountKind: 'api_key',
          accountLabel: 'API key',
          detail: null,
          authFingerprint: 'auth:API key::api-key:rev2',
        }),
      ),
    ).toBe(true);
    expect(
      isDifferentProviderAccount(
        'claude',
        status({
          accountKind: 'api_key',
          accountLabel: 'API key',
          detail: null,
          authFingerprint: 'auth:API key::api-key:rev1',
        }),
        status({
          accountKind: 'api_key',
          accountLabel: 'API key',
          detail: null,
          authFingerprint: 'auth:API key::api-key:rev1',
        }),
      ),
    ).toBe(false);
  });

  it('API key: uses auth fingerprint when both statuses include an email', () => {
    expect(
      isDifferentProviderAccount(
        'claude',
        status({
          accountKind: 'api_key',
          accountEmail: 'same@x.com',
          authFingerprint: 'auth:API key::api-key:rev1',
        }),
        status({
          accountKind: 'api_key',
          accountEmail: 'same@x.com',
          authFingerprint: 'auth:API key::api-key:rev2',
        }),
      ),
    ).toBe(true);
  });

  it('API key: falls back to label+detail without an auth fingerprint', () => {
    expect(
      isDifferentProviderAccount(
        'claude',
        status({
          accountKind: 'api_key',
          accountLabel: 'API key',
          detail: 'rev1',
        }),
        status({
          accountKind: 'api_key',
          accountLabel: 'API key',
          detail: 'rev2',
        }),
      ),
    ).toBe(true);
    expect(
      isDifferentProviderAccount(
        'claude',
        status({
          accountKind: 'api_key',
          accountLabel: 'API key',
          detail: 'rev1',
        }),
        status({
          accountKind: 'api_key',
          accountLabel: 'API key',
          detail: 'rev1',
        }),
      ),
    ).toBe(false);
  });

  it('asymmetric email presence (subscription -> API key) falls back to fingerprint', () => {
    expect(
      isDifferentProviderAccount(
        'claude',
        status({
          accountKind: 'subscription',
          accountEmail: 'a@x.com',
          accountLabel: 'a@x.com',
          detail: 'oauth (max)',
        }),
        status({
          accountKind: 'api_key',
          accountEmail: undefined,
          accountLabel: 'API key',
          detail: null,
        }),
      ),
    ).toBe(true);
  });

  it('asymmetric email presence with matching fingerprint is not flagged as different', () => {
    expect(
      isDifferentProviderAccount(
        'claude',
        status({
          accountKind: 'subscription',
          accountEmail: 'a@x.com',
          accountLabel: 'API key',
          detail: null,
        }),
        status({
          accountKind: 'api_key',
          accountEmail: undefined,
          accountLabel: 'API key',
          detail: null,
        }),
      ),
    ).toBe(false);
  });
});
