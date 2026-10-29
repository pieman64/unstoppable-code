import {
  accountBillingPath,
  BILLING_CAPABILITIES,
  creditsBillingTargetKey,
  creditsBillingTargetPath,
  isBillingCapability,
  organizationBillingPath,
  resolveCreditsBillingPath,
  resolveCreditsBillingTarget,
  parseDailyCreditDripPreference,
  parseDailyCreditDripPreferenceInput,
  parseDailyCreditDripPreferenceSaveResult,
} from '../billing';

describe('AI Credits billing target (CAN-3926)', () => {
  const ACME = '33333333-3333-4333-8333-333333333333';
  const BETA = '44444444-4444-4444-8444-444444444444';
  const GAMMA = '55555555-5555-4555-8555-555555555555';
  const organizations = [
    { id: ACME, name: 'Acme', role: 'OWNER' as const },
    { id: BETA, name: 'Beta', role: 'ADMIN' as const },
    { id: GAMMA, name: 'Gamma', role: 'MEMBER' as const },
  ];

  it('sends the Personal context to the wallet', () => {
    const target = resolveCreditsBillingTarget(
      { kind: 'personal' },
      organizations,
    );
    expect(target).toEqual({ kind: 'personal' });
    expect(creditsBillingTargetPath(target)).toBe('/account/billing');
    expect(creditsBillingTargetKey(target)).toBe('personal');
  });

  it("sends an OWNER to the selected organization's credit pool", () => {
    const target = resolveCreditsBillingTarget(
      { kind: 'organization', organizationId: ACME.toUpperCase() },
      organizations,
    );
    expect(target).toEqual({ kind: 'organization', organizationId: ACME });
    expect(creditsBillingTargetPath(target)).toBe(
      organizationBillingPath(ACME),
    );
    expect(creditsBillingTargetKey(target)).toBe(`org:${ACME}`);
  });

  it('sends an ADMIN, a MEMBER, or a non-member to their own wallet', () => {
    for (const organizationId of [BETA, GAMMA, 'not-a-member']) {
      expect(
        resolveCreditsBillingPath(
          { kind: 'organization', organizationId },
          organizations,
        ),
      ).toBe('/account/billing');
    }
  });
});

describe('accountBillingPath', () => {
  it('builds account billing with an optional encoded plan intent', () => {
    expect(accountBillingPath()).toBe('/account/billing');
    expect(accountBillingPath({})).toBe('/account/billing');
    expect(accountBillingPath({ plan: '' })).toBe('/account/billing');
    expect(accountBillingPath({ plan: 'individual' })).toBe(
      '/account/billing?plan=individual',
    );
    expect(accountBillingPath({ plan: 'pro plus&x=1' })).toBe(
      '/account/billing?plan=pro+plus%26x%3D1',
    );
  });
});

describe('organizationBillingPath', () => {
  it('builds the organization billing settings subtab path', () => {
    expect(organizationBillingPath('org_123')).toBe(
      '/organization/org_123/settings?tab=billing',
    );
  });

  it('encodes the organization id as one URL path segment', () => {
    expect(organizationBillingPath('org/with spaces')).toBe(
      '/organization/org%2Fwith%20spaces/settings?tab=billing',
    );
  });

  it('carries the plan intent as part of the query it owns', () => {
    // `/subscribe` used to append `&plan=` onto the returned string, which
    // silently assumed this function always emits a `?`. Owning the whole
    // query means changing the shape here cannot produce malformed URLs at a
    // caller that no type or test would catch.
    expect(organizationBillingPath('org_123', { plan: 'business' })).toBe(
      '/organization/org_123/settings?tab=billing&plan=business',
    );
  });

  it('encodes plan values that need escaping', () => {
    expect(organizationBillingPath('org_123', { plan: 'pro plus&x=1' })).toBe(
      '/organization/org_123/settings?tab=billing&plan=pro+plus%26x%3D1',
    );
  });

  it('omits the plan param entirely when no plan is given', () => {
    // An absent plan must not become `plan=` or `plan=undefined`; the Billing
    // subtab reads this as a one-shot upgrade intent.
    expect(organizationBillingPath('org_123', {})).toBe(
      '/organization/org_123/settings?tab=billing',
    );
    expect(organizationBillingPath('org_123')).not.toContain('plan');
    // An empty plan is "no plan", not "a plan named empty string" — a bare
    // `plan=` would still read as a one-shot upgrade intent on arrival.
    expect(organizationBillingPath('org_123', { plan: '' })).toBe(
      '/organization/org_123/settings?tab=billing',
    );
  });
});

describe('BILLING_CAPABILITIES', () => {
  it('contains exactly the known keys in append-only order', () => {
    expect(BILLING_CAPABILITIES).toEqual([
      'data_sync_control',
      'teams',
      'org_credit_pool',
      'priority_support',
      'remote_control',
      'enforce_sharing_transcripts',
      'enforce_sharing_plans',
      'enforce_sharing_summaries',
      'enforce_sharing_metadata',
      'enforce_model_policy',
      'custom_model_gateway',
    ]);
  });
});

describe('isBillingCapability', () => {
  it('returns true for each known capability key', () => {
    for (const key of BILLING_CAPABILITIES) {
      expect(isBillingCapability(key)).toBe(true);
    }
  });

  it('returns false for an unknown string', () => {
    expect(isBillingCapability('some_future_cap')).toBe(false);
    expect(isBillingCapability('')).toBe(false);
  });

  it('returns false for non-string / nullish values', () => {
    expect(isBillingCapability(undefined)).toBe(false);
    expect(isBillingCapability(null)).toBe(false);
    expect(isBillingCapability(42)).toBe(false);
    expect(isBillingCapability({ teams: true })).toBe(false);
  });
});

describe('daily credit drip preference validators', () => {
  const preference = {
    enabled: true,
    decidedAt: '2026-10-06T12:00:00.000Z',
    capCredits: 25,
  };

  it('accepts a valid preference, including an undecided one', () => {
    expect(parseDailyCreditDripPreference(preference)).toEqual(preference);
    expect(
      parseDailyCreditDripPreference({
        enabled: false,
        decidedAt: null,
        capCredits: 25,
      }),
    ).toEqual({ enabled: false, decidedAt: null, capCredits: 25 });
  });

  it('ignores unknown extra keys on the read shape', () => {
    expect(
      parseDailyCreditDripPreference({ ...preference, extra: 'x' }),
    ).toEqual(preference);
  });

  it('rejects missing or wrongly typed preference fields', () => {
    expect(parseDailyCreditDripPreference(null)).toBeNull();
    expect(parseDailyCreditDripPreference([])).toBeNull();
    expect(
      parseDailyCreditDripPreference({ ...preference, enabled: 'true' }),
    ).toBeNull();
    expect(
      parseDailyCreditDripPreference({ decidedAt: null, capCredits: 25 }),
    ).toBeNull();
    expect(
      parseDailyCreditDripPreference({
        ...preference,
        decidedAt: 'not a date',
      }),
    ).toBeNull();
    expect(
      parseDailyCreditDripPreference({ enabled: true, capCredits: 25 }),
    ).toBeNull();
    expect(
      parseDailyCreditDripPreference({ ...preference, capCredits: '25' }),
    ).toBeNull();
    expect(
      parseDailyCreditDripPreference({ ...preference, capCredits: -1 }),
    ).toBeNull();
  });

  it('accepts only a strict { enabled: boolean } input', () => {
    expect(parseDailyCreditDripPreferenceInput({ enabled: true })).toEqual({
      enabled: true,
    });
    expect(parseDailyCreditDripPreferenceInput({ enabled: false })).toEqual({
      enabled: false,
    });
    expect(parseDailyCreditDripPreferenceInput({ enabled: 'true' })).toBeNull();
    expect(parseDailyCreditDripPreferenceInput({ enabled: 1 })).toBeNull();
    expect(parseDailyCreditDripPreferenceInput({})).toBeNull();
    expect(
      parseDailyCreditDripPreferenceInput({ enabled: true, extra: 1 }),
    ).toBeNull();
    expect(parseDailyCreditDripPreferenceInput('enabled')).toBeNull();
    expect(parseDailyCreditDripPreferenceInput(null)).toBeNull();
  });

  it('accepts a save result with a numeric or null balance', () => {
    expect(
      parseDailyCreditDripPreferenceSaveResult({
        ...preference,
        balanceCredits: 25,
        granted: 25,
      }),
    ).toEqual({ ...preference, balanceCredits: 25, granted: 25 });
    expect(
      parseDailyCreditDripPreferenceSaveResult({
        ...preference,
        balanceCredits: null,
        granted: 0,
      }),
    ).toEqual({ ...preference, balanceCredits: null, granted: 0 });
  });

  it('rejects a save result with missing or wrongly typed fields', () => {
    expect(parseDailyCreditDripPreferenceSaveResult(preference)).toBeNull();
    expect(
      parseDailyCreditDripPreferenceSaveResult({
        ...preference,
        balanceCredits: '25',
        granted: 25,
      }),
    ).toBeNull();
    expect(
      parseDailyCreditDripPreferenceSaveResult({
        ...preference,
        balanceCredits: 25,
      }),
    ).toBeNull();
    expect(
      parseDailyCreditDripPreferenceSaveResult({
        ...preference,
        enabled: 'true',
        balanceCredits: 25,
        granted: 25,
      }),
    ).toBeNull();
  });
});

it.each(['network_limit', 'network_unidentified'])(
  'parses optional daily drip blocked reason %s',
  (blockedReason) => {
    const value = {
      enabled: true,
      decidedAt: null,
      capCredits: 25,
      balanceCredits: 0,
      granted: 0,
      blockedReason,
    };
    expect(parseDailyCreditDripPreferenceSaveResult(value)).toEqual(value);
    // The older preference parser ignores extra fields.
    expect(parseDailyCreditDripPreference(value)).toEqual({
      enabled: true,
      decidedAt: null,
      capCredits: 25,
    });
  },
);
it.each(['unknown', null, 1, false])(
  'rejects invalid daily drip blocked reason %s',
  (blockedReason) => {
    expect(
      parseDailyCreditDripPreferenceSaveResult({
        enabled: true,
        decidedAt: null,
        capCredits: 25,
        balanceCredits: 0,
        granted: 0,
        blockedReason,
      }),
    ).toBeNull();
  },
);
