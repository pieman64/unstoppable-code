import {
  computeSubscriptionStatus,
  type SubscriptionStatusInput,
} from '../subscription-status';

const NOW = Date.UTC(2026, 6, 17, 12, 0, 0); // 2026-07-17T12:00:00Z
const DAY = 86_400_000;

/** ISO instant `days` whole days after NOW. */
function inDays(days: number): string {
  return new Date(NOW + days * DAY).toISOString();
}

describe('computeSubscriptionStatus — trial', () => {
  it('prefers the personal conversion presentation over the capability tier', () => {
    const input: SubscriptionStatusInput = {
      source: 'trial',
      plan: { key: 'business', displayName: 'Business' },
      trial: { active: true, endsAt: inDays(12) },
      billingPresentation: {
        plan: { key: 'individual', displayName: 'Pro' },
        owner: { type: 'user' },
        lifecycle: 'trial',
        trialEndsAt: inDays(12),
        action: 'subscribe',
      },
    };
    expect(computeSubscriptionStatus(input, NOW)).toEqual({
      kind: 'trial',
      label: 'Pro',
      tone: 'neutral',
      trialEndsAt: inDays(12),
      billingPresentation: input.billingPresentation,
    });
  });

  it('shows the effective server-resolved plan without trial lifecycle copy', () => {
    const input: SubscriptionStatusInput = {
      source: 'trial',
      plan: { key: 'business', displayName: 'Business' },
      trial: { active: true, endsAt: inDays(12) },
    };
    expect(computeSubscriptionStatus(input, NOW)).toEqual({
      kind: 'trial',
      label: 'Business',
      tone: 'neutral',
      trialEndsAt: inDays(12),
    });
  });

  it('keeps the same plan-only label close to expiration', () => {
    const input: SubscriptionStatusInput = {
      source: 'trial',
      plan: { key: 'business', displayName: 'Business' },
      trial: { active: true, endsAt: inDays(1) },
    };
    expect(computeSubscriptionStatus(input, NOW)).toEqual({
      kind: 'trial',
      label: 'Business',
      tone: 'neutral',
      trialEndsAt: inDays(1),
    });
  });

  it('uses the entitlement display name rather than mapping a plan key locally', () => {
    const status = computeSubscriptionStatus(
      {
        source: 'trial',
        plan: { key: 'business-v2', displayName: 'Business Plus' },
        trial: { active: true, endsAt: inDays(12) },
      },
      NOW,
    );
    expect(status).toEqual({
      kind: 'trial',
      label: 'Business Plus',
      tone: 'neutral',
      trialEndsAt: inDays(12),
    });
  });

  it('uses the resolved plan when a legacy server omits trial timing', () => {
    expect(
      computeSubscriptionStatus(
        {
          source: 'trial',
          plan: { key: 'business', displayName: 'Business' },
          trial: null,
        },
        NOW,
      ),
    ).toEqual({
      kind: 'trial',
      label: 'Business',
      tone: 'neutral',
    });
  });

  it('falls back to Free when a trial grant has no resolved plan', () => {
    expect(
      computeSubscriptionStatus(
        {
          source: 'trial',
          plan: null,
          trial: { active: true, endsAt: inDays(12) },
        },
        NOW,
      ),
    ).toEqual({ kind: 'free', label: 'Free', tone: 'neutral' });
  });

  it('falls back to Free once a previously fetched trial expires', () => {
    const status = computeSubscriptionStatus(
      {
        source: 'trial',
        plan: { key: 'business', displayName: 'Business' },
        trial: { active: true, endsAt: inDays(-1) },
      },
      NOW,
    );
    expect(status).toEqual({ kind: 'free', label: 'Free', tone: 'neutral' });
  });

  it('treats active:false as expired even with a future endsAt', () => {
    const status = computeSubscriptionStatus(
      {
        source: 'trial',
        plan: { key: 'business', displayName: 'Business' },
        trial: { active: false, endsAt: inDays(5) },
      },
      NOW,
    );
    expect(status).toEqual({ kind: 'free', label: 'Free', tone: 'neutral' });
  });

  it('treats an unparseable endsAt as expired', () => {
    const status = computeSubscriptionStatus(
      {
        source: 'trial',
        plan: { key: 'business', displayName: 'Business' },
        trial: { active: true, endsAt: 'not-a-date' },
      },
      NOW,
    );
    expect(status).toEqual({ kind: 'free', label: 'Free', tone: 'neutral' });
  });
});

describe('computeSubscriptionStatus — paid / org / free', () => {
  it('labels a paid subscription with the server plan name', () => {
    const status = computeSubscriptionStatus(
      {
        source: 'subscription',
        plan: { key: 'pro', displayName: 'Pro' },
        trial: null,
      },
      NOW,
    );
    expect(status).toEqual({ kind: 'paid', label: 'Pro', tone: 'positive' });
  });

  it('paid subscription wins over a concurrent active trial', () => {
    const status = computeSubscriptionStatus(
      {
        source: 'subscription',
        plan: { key: 'pro', displayName: 'Pro' },
        trial: { active: true, endsAt: inDays(2) },
      },
      NOW,
    );
    expect(status.kind).toBe('paid');
  });

  it('labels an org seat with the plan name (neutral)', () => {
    const status = computeSubscriptionStatus(
      {
        source: 'org_seat',
        plan: { key: 'team', displayName: 'Team' },
        trial: null,
      },
      NOW,
    );
    expect(status).toEqual({ kind: 'org', label: 'Team', tone: 'neutral' });
  });

  it('falls back to Team when an org seat has no plan name', () => {
    const status = computeSubscriptionStatus(
      { source: 'org_seat', plan: null, trial: null },
      NOW,
    );
    expect(status.label).toBe('Team');
  });

  it('labels a no-grant account as Free', () => {
    const status = computeSubscriptionStatus(
      { source: 'none', plan: null, trial: null },
      NOW,
    );
    expect(status).toEqual({ kind: 'free', label: 'Free', tone: 'neutral' });
  });
});

describe('computeSubscriptionStatus — displayPlan (highest-priced grant)', () => {
  it('shows an org-seat displayPlan over a cheaper personal plan, in the positive tone', () => {
    const status = computeSubscriptionStatus(
      {
        // Wallet-primary is the personal Pro subscription...
        source: 'subscription',
        plan: { key: 'individual', displayName: 'Pro' },
        trial: null,
        // ...but the user is covered by a pricier org Business plan.
        displayPlan: {
          key: 'business',
          displayName: 'Business',
          source: 'org_seat',
        },
      },
      NOW,
    );
    expect(status).toEqual({
      kind: 'org',
      label: 'Business',
      tone: 'positive',
    });
  });

  it('shows a subscription displayPlan as paid/positive', () => {
    const status = computeSubscriptionStatus(
      {
        source: 'subscription',
        plan: { key: 'individual', displayName: 'Pro' },
        trial: null,
        displayPlan: {
          key: 'individual',
          displayName: 'Pro',
          source: 'subscription',
        },
      },
      NOW,
    );
    expect(status).toEqual({ kind: 'paid', label: 'Pro', tone: 'positive' });
  });

  it('takes precedence over an active trial', () => {
    const status = computeSubscriptionStatus(
      {
        source: 'org_seat',
        plan: { key: 'business', displayName: 'Business' },
        trial: { active: true, endsAt: inDays(3) },
        displayPlan: {
          key: 'business',
          displayName: 'Business',
          source: 'org_seat',
        },
      },
      NOW,
    );
    expect(status.kind).toBe('org');
    expect(status.label).toBe('Business');
    expect(status.tone).toBe('positive');
  });
});
