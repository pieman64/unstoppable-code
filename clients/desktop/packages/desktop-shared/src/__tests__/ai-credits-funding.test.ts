import {
  resolveAiCreditsFundingSource,
  scopeAiCreditsBalanceToWorkOwner,
} from '../lib/ai-credits-funding';
import type { CanopyCloudAiCreditsState } from '../types';

function makeState(
  overrides: Partial<CanopyCloudAiCreditsState> = {},
): CanopyCloudAiCreditsState {
  return {
    connected: true,
    email: 'user@example.com',
    subscription: null,
    balance: { email: 'user@example.com', credits: 500, eligible: true },
    noUdAccount: false,
    error: null,
    ...overrides,
  };
}

const ORG_POOL = { orgId: 'org_1', orgName: 'Acme' };

describe('scopeAiCreditsBalanceToWorkOwner', () => {
  const balance = {
    email: 'user@example.com',
    credits: 0,
    eligible: true,
    orgPool: ORG_POOL,
    orgFundingAvailable: true,
  };

  it('keeps only the selected owner organization pool', () => {
    expect(
      scopeAiCreditsBalanceToWorkOwner(balance, {
        kind: 'organization',
        organizationId: 'org_1',
      }),
    ).toEqual(balance);
  });

  it('drops a non-owner organization pool', () => {
    expect(
      scopeAiCreditsBalanceToWorkOwner(balance, {
        kind: 'organization',
        organizationId: 'org_2',
      }),
    ).toEqual({
      ...balance,
      eligible: false,
      orgPool: null,
      orgFundingAvailable: false,
    });
  });

  it('drops organization funding for personal work', () => {
    expect(
      scopeAiCreditsBalanceToWorkOwner(balance, { kind: 'personal' }),
    ).toEqual({
      ...balance,
      eligible: false,
      orgPool: null,
      orgFundingAvailable: false,
    });
  });
});

describe('resolveAiCreditsFundingSource', () => {
  it('is unknown when there is no state at all', () => {
    expect(resolveAiCreditsFundingSource(null)).toEqual({ kind: 'unknown' });
  });

  it('is unknown when the account is not connected', () => {
    expect(
      resolveAiCreditsFundingSource(makeState({ connected: false })),
    ).toEqual({ kind: 'unknown' });
  });

  it('is unknown on a transient lookup error', () => {
    expect(
      resolveAiCreditsFundingSource(makeState({ error: 'network down' })),
    ).toEqual({ kind: 'unknown' });
  });

  it('is unknown when the account has no matching UD account', () => {
    expect(
      resolveAiCreditsFundingSource(makeState({ noUdAccount: true })),
    ).toEqual({ kind: 'unknown' });
  });

  it('is unknown when no balance has resolved yet', () => {
    expect(resolveAiCreditsFundingSource(makeState({ balance: null }))).toEqual(
      {
        kind: 'unknown',
      },
    );
  });

  it('is personal when the wallet has credits', () => {
    expect(resolveAiCreditsFundingSource(makeState())).toEqual({
      kind: 'personal',
      credits: 500,
    });
  });

  it('prefers the personal wallet over the org pool while it still has credits', () => {
    const state = makeState({
      balance: {
        email: 'user@example.com',
        credits: 12,
        eligible: true,
        orgPool: ORG_POOL,
      },
    });
    expect(resolveAiCreditsFundingSource(state)).toEqual({
      kind: 'personal',
      credits: 12,
    });
  });

  it('is org-pool when the wallet is empty and the server named a pool', () => {
    const state = makeState({
      balance: {
        email: 'user@example.com',
        credits: 0,
        eligible: false,
        orgPool: ORG_POOL,
      },
    });
    expect(resolveAiCreditsFundingSource(state)).toEqual({
      kind: 'org-pool',
      orgName: 'Acme',
    });
  });

  it('is org-pool when the wallet has gone negative but a pool covers it', () => {
    const state = makeState({
      balance: {
        email: 'user@example.com',
        credits: -3,
        eligible: false,
        orgPool: ORG_POOL,
      },
    });
    expect(resolveAiCreditsFundingSource(state)).toEqual({
      kind: 'org-pool',
      orgName: 'Acme',
    });
  });

  it('is unknown when the wallet is empty and no pool is eligible', () => {
    const state = makeState({
      balance: {
        email: 'user@example.com',
        credits: 0,
        eligible: false,
        orgPool: null,
      },
    });
    expect(resolveAiCreditsFundingSource(state)).toEqual({ kind: 'unknown' });
  });

  it('treats an older server that omits orgPool entirely as no pool', () => {
    const state = makeState({
      balance: { email: 'user@example.com', credits: 0, eligible: false },
    });
    expect(resolveAiCreditsFundingSource(state)).toEqual({ kind: 'unknown' });
  });

  it('ignores an empty org name rather than rendering a nameless payer', () => {
    const state = makeState({
      balance: {
        email: 'user@example.com',
        credits: 0,
        eligible: false,
        orgPool: { orgId: 'org_1', orgName: '' },
      },
    });
    expect(resolveAiCreditsFundingSource(state)).toEqual({ kind: 'unknown' });
  });

  // The "never show 0 credits" invariant is structural, not a rendering
  // convention: no input may ever produce a personal source at zero.
  it('never yields a personal source with a non-positive balance', () => {
    const credits = [-10, -1, 0, 0.4, 1, 500];
    const orgPools = [undefined, null, ORG_POOL];
    const flags = [true, false];
    for (const c of credits) {
      for (const pool of orgPools) {
        for (const connected of flags) {
          for (const noUdAccount of flags) {
            for (const error of [null, 'boom']) {
              const state = makeState({
                connected,
                noUdAccount,
                error,
                balance: {
                  email: 'user@example.com',
                  credits: c,
                  eligible: c > 0,
                  orgPool: pool,
                },
              });
              const funding = resolveAiCreditsFundingSource(state);
              if (funding.kind === 'personal') {
                expect(funding.credits).toBeGreaterThan(0);
              }
            }
          }
        }
      }
    }
  });
});
