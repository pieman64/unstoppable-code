const mockProbe = jest.fn();
const mockReadPreferences = jest.fn();

jest.mock('../canopy-cloud/entitlements', () => ({
  probeEntitlementsSummary: (): unknown => mockProbe(),
}));

jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: (): unknown => mockReadPreferences(),
}));

import { resolveCampaignVariantKey } from '../notifications/campaigns/variant-resolver';

beforeEach(() => {
  jest.clearAllMocks();
  mockReadPreferences.mockResolvedValue({});
});

describe('activation-first-task variant', () => {
  it('uses the offer copy only when a trial is confirmed active', async () => {
    mockProbe.mockResolvedValue({
      resolved: true,
      trial: { active: true, endsAt: '2026-02-01T00:00:00.000Z' },
    });
    await expect(
      resolveCampaignVariantKey('activation-first-task'),
    ).resolves.toEqual({ variantKey: 'offer' });
  });

  it('falls back to generic copy when the trial is not active', async () => {
    mockProbe.mockResolvedValue({
      resolved: true,
      trial: { active: false, endsAt: '2025-01-01T00:00:00.000Z' },
    });
    await expect(
      resolveCampaignVariantKey('activation-first-task'),
    ).resolves.toEqual({ variantKey: 'default' });
  });

  it('falls back to generic copy when the account has no trial at all', async () => {
    mockProbe.mockResolvedValue({ resolved: true, trial: null });
    await expect(
      resolveCampaignVariantKey('activation-first-task'),
    ).resolves.toEqual({ variantKey: 'default' });
  });

  it('never offers a free month under free app access', async () => {
    // Free access unlocks every feature, so trial copy has nothing to offer,
    // even if a response still reports an active trial.
    mockProbe.mockResolvedValue({
      resolved: true,
      freeAccess: true,
      trial: { active: true, endsAt: '2026-02-01T00:00:00.000Z' },
    });
    await expect(
      resolveCampaignVariantKey('activation-first-task'),
    ).resolves.toEqual({ variantKey: 'default' });
  });

  it('falls back to generic copy when the probe cannot resolve', async () => {
    // Offline, auth failure, 5xx. Never promise an offer we cannot confirm.
    mockProbe.mockResolvedValue({ resolved: false });
    await expect(
      resolveCampaignVariantKey('activation-first-task'),
    ).resolves.toEqual({ variantKey: 'default' });
  });

  it('suppresses rather than guessing when the probe throws', async () => {
    mockProbe.mockRejectedValue(new Error('boom'));
    await expect(
      resolveCampaignVariantKey('activation-first-task'),
    ).resolves.toEqual({ variantKey: null, reason: 'variant-unavailable' });
  });
});

describe('other campaigns', () => {
  it('uses the default variant for the marketplace campaign', async () => {
    await expect(
      resolveCampaignVariantKey('activation-marketplace'),
    ).resolves.toEqual({ variantKey: 'default' });
  });

  it('uses the default variant for the mobile campaign', async () => {
    await expect(
      resolveCampaignVariantKey('activation-mobile'),
    ).resolves.toEqual({
      variantKey: 'default',
    });
  });

  it('does not probe billing for the role campaign', async () => {
    mockReadPreferences.mockResolvedValue({ profileRole: 'software-engineer' });
    await resolveCampaignVariantKey('activation-role-branch');
    expect(mockProbe).not.toHaveBeenCalled();
  });

  it('does not probe billing for campaigns that carry no offer', async () => {
    await resolveCampaignVariantKey('activation-marketplace');
    expect(mockProbe).not.toHaveBeenCalled();
  });
});

describe('activation-role-branch variant', () => {
  it.each(['software-engineer', 'engineering-leader'])(
    'maps %s to developer copy',
    async (profileRole) => {
      mockReadPreferences.mockResolvedValue({ profileRole });
      await expect(
        resolveCampaignVariantKey('activation-role-branch'),
      ).resolves.toEqual({ variantKey: 'developer' });
    },
  );

  it.each([
    'product-manager',
    'marketing-sales',
    'marketing',
    'sales',
    'operations-support',
  ])('maps %s to business copy', async (profileRole) => {
    mockReadPreferences.mockResolvedValue({ profileRole });
    await expect(
      resolveCampaignVariantKey('activation-role-branch'),
    ).resolves.toEqual({ variantKey: 'business' });
  });

  it.each(['designer', 'founder', 'data-analytics', 'student', 'other'])(
    'suppresses %s rather than guessing a branch',
    async (profileRole) => {
      mockReadPreferences.mockResolvedValue({ profileRole });
      await expect(
        resolveCampaignVariantKey('activation-role-branch'),
      ).resolves.toEqual({ variantKey: null, reason: 'role-not-mapped' });
    },
  );

  it('distinguishes an unanswered role from an unmapped one', async () => {
    // Since the onboarding wizard no longer auto-launches, unset is the
    // common case; the funnel must not conflate it with an unmapped answer.
    mockReadPreferences.mockResolvedValue({});
    await expect(
      resolveCampaignVariantKey('activation-role-branch'),
    ).resolves.toEqual({ variantKey: null, reason: 'role-unknown' });
  });
});
