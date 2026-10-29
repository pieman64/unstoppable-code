import {
  settingsCreditPoolEnvelopeSchema,
  settingsCreditPoolStreamPath,
  settingsSubscriptionScopeSchema,
} from '../events';

describe('settings subscription scopes', () => {
  it('accepts an organization feed and a personal or organization credit pool', () => {
    for (const scope of [
      { kind: 'organization-feed', organizationId: 'org-1', lastSequence: 4 },
      { kind: 'credit-pool' },
      { kind: 'credit-pool', organizationId: 'org-1' },
    ])
      expect(settingsSubscriptionScopeSchema.safeParse(scope).success).toBe(
        true,
      );
  });

  it('refuses unknown kinds, feed-only fields on a credit pool, and bad ids', () => {
    for (const scope of [
      { kind: 'organization-feed' },
      { kind: 'credit-pool', lastSequence: 1 },
      { kind: 'credit-pool', teamId: 'team-1' },
      { kind: 'credit-pool', organizationId: '../admin' },
      { kind: 'credit-balance' },
    ])
      expect(settingsSubscriptionScopeSchema.safeParse(scope).success).toBe(
        false,
      );
  });

  it('reads the personal credit stream or the organization stream', () => {
    expect(settingsCreditPoolStreamPath()).toBe(
      '/api/account/billing/credits/stream',
    );
    expect(settingsCreditPoolStreamPath('org 1')).toBe(
      '/api/account/organizations/org%201/stream',
    );
  });

  it('checks the credit-pool frame, not a feed frame', () => {
    const frame = {
      type: 'credit.pool',
      eventId: 'evt-1',
      occurredAt: '2026-10-16T00:00:00.000Z',
      sequence: 1,
      payload: { balanceCredits: 10, extra: true },
    };
    expect(settingsCreditPoolEnvelopeSchema.safeParse(frame).success).toBe(
      true,
    );
    expect(
      settingsCreditPoolEnvelopeSchema.safeParse({
        ...frame,
        type: 'feed.item',
      }).success,
    ).toBe(false);
    expect(
      settingsCreditPoolEnvelopeSchema.safeParse({ ...frame, payload: {} })
        .success,
    ).toBe(false);
  });
});
