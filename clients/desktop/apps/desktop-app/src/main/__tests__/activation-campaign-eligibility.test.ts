import { evaluateCampaign } from '../notifications/campaigns/eligibility';
import type { CampaignEvaluationContext } from '../notifications/campaigns/eligibility';
import type { CampaignDefinition } from '../notifications/campaigns/campaign-config';
import type { ActivationJourneyPersistedState } from '@canopy/desktop-shared/types';

const DEFINITION: CampaignDefinition = {
  id: 'activation-marketplace',
  anchor: 'first-open',
  offsetMs: 8 * 60 * 60 * 1000,
  maxLatenessMs: 48 * 60 * 60 * 1000,
  variants: {
    default: {
      title: 'title',
      body: 'body',
      destination: { kind: 'page', page: 'plugins' },
    },
  },
};

const BASE_STATE: ActivationJourneyPersistedState = {
  firstOpenAt: '2026-01-01T00:00:00.000Z',
  lastActiveAt: '2026-01-01T00:00:00.000Z',
  holdout: false,
  campaigns: {},
  signals: {},
};

function context(
  overrides: Partial<CampaignEvaluationContext> = {},
): CampaignEvaluationContext {
  return {
    state: BASE_STATE,
    // Exactly on the due boundary: 8h after the first-open anchor.
    nowMs: Date.parse('2026-01-01T08:00:00.000Z'),
    campaignFlagEnabled: true,
    osNotificationsEnabled: true,
    activationCategoryEnabled: true,
    skipWhenFocused: true,
    appFocused: false,
    inQuietHours: false,
    hasActivated: () => Promise.resolve(false),
    isEligible: () => Promise.resolve(true),
    ...overrides,
  };
}

describe('evaluateCampaign', () => {
  it('sends when every gate passes', async () => {
    await expect(evaluateCampaign(DEFINITION, context())).resolves.toEqual({
      send: true,
    });
  });

  it('suppresses when the feature flag is off', async () => {
    await expect(
      evaluateCampaign(DEFINITION, context({ campaignFlagEnabled: false })),
    ).resolves.toEqual({ send: false, reason: 'campaign-disabled' });
  });

  it('suppresses a campaign that already sent', async () => {
    const decision = await evaluateCampaign(
      DEFINITION,
      context({
        state: {
          ...BASE_STATE,
          campaigns: {
            'activation-marketplace': { sentAt: '2026-01-01T08:00:00.000Z' },
          },
        },
      }),
    );
    expect(decision).toEqual({ send: false, reason: 'already-sent' });
  });

  it('suppresses for the holdout cohort', async () => {
    await expect(
      evaluateCampaign(
        DEFINITION,
        context({ state: { ...BASE_STATE, holdout: true } }),
      ),
    ).resolves.toEqual({ send: false, reason: 'holdout' });
  });

  it('suppresses when OS notifications are off entirely', async () => {
    await expect(
      evaluateCampaign(DEFINITION, context({ osNotificationsEnabled: false })),
    ).resolves.toEqual({ send: false, reason: 'notifications-disabled' });
  });

  it('suppresses when the activation category is opted out', async () => {
    await expect(
      evaluateCampaign(
        DEFINITION,
        context({ activationCategoryEnabled: false }),
      ),
    ).resolves.toEqual({ send: false, reason: 'category-disabled' });
  });

  it('suppresses during quiet hours', async () => {
    await expect(
      evaluateCampaign(DEFINITION, context({ inQuietHours: true })),
    ).resolves.toEqual({ send: false, reason: 'quiet-hours' });
  });

  it('suppresses while the app is focused', async () => {
    await expect(
      evaluateCampaign(DEFINITION, context({ appFocused: true })),
    ).resolves.toEqual({ send: false, reason: 'app-focused' });
  });

  it('sends while focused when skipWhenFocused is off', async () => {
    await expect(
      evaluateCampaign(
        DEFINITION,
        context({ appFocused: true, skipWhenFocused: false }),
      ),
    ).resolves.toEqual({ send: true });
  });

  it('suppresses once the user has meaningfully activated', async () => {
    await expect(
      evaluateCampaign(
        DEFINITION,
        context({ hasActivated: () => Promise.resolve(true) }),
      ),
    ).resolves.toEqual({ send: false, reason: 'already-activated' });
  });

  it('suppresses when the campaign predicate is false', async () => {
    await expect(
      evaluateCampaign(
        DEFINITION,
        context({ isEligible: () => Promise.resolve(false) }),
      ),
    ).resolves.toEqual({ send: false, reason: 'not-eligible' });
  });

  it('suppresses past the lateness bound', async () => {
    await expect(
      evaluateCampaign(
        DEFINITION,
        context({ nowMs: Date.parse('2026-01-04T00:00:00.000Z') }),
      ),
    ).resolves.toEqual({ send: false, reason: 'expired' });
  });

  it('reports a missing anchor as transient, not as ineligible', async () => {
    // `no-anchor` is distinct from `not-eligible` because it is TRANSIENT:
    // on a fresh install the anchor is written by the first window focus,
    // which lands after the journey's initial evaluation. Reporting it as
    // `not-eligible` made the scheduler write the campaign off.
    await expect(
      evaluateCampaign(
        DEFINITION,
        context({ state: { ...BASE_STATE, firstOpenAt: null } }),
      ),
    ).resolves.toEqual({ send: false, reason: 'no-anchor' });
  });

  it('does not send before the due time', async () => {
    await expect(
      evaluateCampaign(
        DEFINITION,
        context({ nowMs: Date.parse('2026-01-01T07:59:59.000Z') }),
      ),
    ).resolves.toEqual({ send: false, reason: 'not-yet-due' });
  });

  it('reports not-yet-due ahead of any transient gate it has not reached', async () => {
    // Regression: the due check used to run last, so a campaign eight hours
    // from sending reported `notifications-disabled` -- a state the user
    // never actually hit, which polluted the suppression funnel.
    await expect(
      evaluateCampaign(
        DEFINITION,
        context({
          nowMs: Date.parse('2026-01-01T07:59:59.000Z'),
          osNotificationsEnabled: false,
          activationCategoryEnabled: false,
          inQuietHours: true,
        }),
      ),
    ).resolves.toEqual({ send: false, reason: 'not-yet-due' });
  });
});

describe('probe failures reach the gate', () => {
  it('reports probe-failed when the real activation helper rejects', async () => {
    // Regression: `probe-failed` previously passed its unit tests against
    // throwing fakes while being unreachable in production, because the
    // helpers caught their own errors. This drives the gate with a rejecting
    // probe and asserts the retryable classification.
    await expect(
      evaluateCampaign(
        DEFINITION,
        context({
          hasActivated: () => Promise.reject(new Error('EIO')),
        }),
      ),
    ).resolves.toEqual({ send: false, reason: 'probe-failed' });
  });

  it('reports probe-failed when the campaign predicate rejects', async () => {
    await expect(
      evaluateCampaign(
        DEFINITION,
        context({
          isEligible: () => Promise.reject(new Error('EIO')),
        }),
      ),
    ).resolves.toEqual({ send: false, reason: 'probe-failed' });
  });
});

describe('gate ordering', () => {
  it('reports already-sent before holdout', async () => {
    const decision = await evaluateCampaign(
      DEFINITION,
      context({
        state: {
          ...BASE_STATE,
          holdout: true,
          campaigns: {
            'activation-marketplace': { sentAt: '2026-01-01T08:00:00.000Z' },
          },
        },
      }),
    );
    expect(decision).toEqual({ send: false, reason: 'already-sent' });
  });

  it('reports campaign-disabled before already-sent', async () => {
    const decision = await evaluateCampaign(
      DEFINITION,
      context({
        campaignFlagEnabled: false,
        state: {
          ...BASE_STATE,
          campaigns: {
            'activation-marketplace': { sentAt: '2026-01-01T08:00:00.000Z' },
          },
        },
      }),
    );
    expect(decision).toEqual({ send: false, reason: 'campaign-disabled' });
  });

  it('checks cheap local gates before the async activation probe', async () => {
    const hasActivated = jest.fn(() => Promise.resolve(false));
    await evaluateCampaign(
      DEFINITION,
      context({ osNotificationsEnabled: false, hasActivated }),
    );
    expect(hasActivated).not.toHaveBeenCalled();
  });
});

describe('shared promotional frequency cap (CAN-3013)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  // Due at 08:00; a Getting Started step sent at 07:00 the same morning.
  const STEP_SENT_AT = '2026-01-01T07:00:00.000Z';
  const cappedState: ActivationJourneyPersistedState = {
    ...BASE_STATE,
    gettingStarted: { steps: { 'create-account': { sentAt: STEP_SENT_AT } } },
  };

  it('holds a due campaign for 24 hours after a Getting Started step', async () => {
    await expect(
      evaluateCampaign(DEFINITION, context({ state: cappedState })),
    ).resolves.toEqual({ send: false, reason: 'frequency-capped' });
  });

  it('sends once the cap has elapsed', async () => {
    await expect(
      evaluateCampaign(
        DEFINITION,
        context({
          state: cappedState,
          nowMs: Date.parse(STEP_SENT_AT) + DAY_MS,
        }),
      ),
    ).resolves.toEqual({ send: true });
  });

  it('holds for another campaign that sent within the day', async () => {
    const state: ActivationJourneyPersistedState = {
      ...BASE_STATE,
      campaigns: { 'activation-first-task': { sentAt: STEP_SENT_AT } },
    };
    await expect(
      evaluateCampaign(DEFINITION, context({ state })),
    ).resolves.toEqual({ send: false, reason: 'frequency-capped' });
  });

  it('reports not-yet-due ahead of the cap', async () => {
    // A campaign that is merely early has not reached the cap gate.
    await expect(
      evaluateCampaign(
        DEFINITION,
        context({
          state: cappedState,
          nowMs: Date.parse('2026-01-01T07:30:00.000Z'),
        }),
      ),
    ).resolves.toEqual({ send: false, reason: 'not-yet-due' });
  });

  it('checks the cap before the preference gates', async () => {
    // The cap resolves on its own with time; a preference gate only on an
    // event. Reporting the transient reason first keeps the retry armed.
    await expect(
      evaluateCampaign(
        DEFINITION,
        context({ state: cappedState, osNotificationsEnabled: false }),
      ),
    ).resolves.toEqual({ send: false, reason: 'frequency-capped' });
  });
});

describe('fail-closed behavior', () => {
  it('suppresses when the eligibility predicate throws', async () => {
    await expect(
      evaluateCampaign(
        DEFINITION,
        context({ isEligible: () => Promise.reject(new Error('boom')) }),
      ),
    ).resolves.toEqual({ send: false, reason: 'probe-failed' });
  });

  it('suppresses when the activation probe throws', async () => {
    await expect(
      evaluateCampaign(
        DEFINITION,
        context({ hasActivated: () => Promise.reject(new Error('boom')) }),
      ),
    ).resolves.toEqual({ send: false, reason: 'probe-failed' });
  });
});
