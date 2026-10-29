import { ONBOARDING_CHECKLIST_ITEM_IDS } from '@canopy/desktop-shared/types';
import type {
  ActivationJourneyPersistedState,
  OnboardingChecklistItemId,
  OnboardingChecklistState,
} from '@canopy/desktop-shared/types';
import {
  GETTING_STARTED_INTERVAL_MS,
  GETTING_STARTED_WINDOW_MS,
  evaluateGettingStartedSequence,
  getGettingStartedStep,
  isValidGettingStartedStep,
} from '../notifications/campaigns/getting-started-sequence';
import type {
  GettingStartedSequenceContext,
  GettingStartedStep,
} from '../notifications/campaigns/getting-started-sequence';

const FIRST_OPEN = '2026-01-01T00:00:00.000Z';
const FIRST_OPEN_MS = Date.parse(FIRST_OPEN);
const HOUR_MS = 60 * 60 * 1000;

function journeyState(
  overrides: Partial<ActivationJourneyPersistedState> = {},
): ActivationJourneyPersistedState {
  return {
    firstOpenAt: FIRST_OPEN,
    lastActiveAt: null,
    holdout: false,
    campaigns: {},
    signals: {},
    gettingStarted: { steps: {} },
    ...overrides,
  };
}

function checklist(
  complete: readonly OnboardingChecklistItemId[] = [],
  overrides: Partial<OnboardingChecklistState> = {},
): OnboardingChecklistState {
  return {
    items: ONBOARDING_CHECKLIST_ITEM_IDS.map((id) => ({
      id,
      complete: complete.includes(id),
    })),
    dismissedAt: null,
    snoozedUntil: null,
    providersNotUsed: [],
    ...overrides,
  };
}

function context(
  overrides: Partial<GettingStartedSequenceContext> = {},
): GettingStartedSequenceContext {
  return {
    state: journeyState(),
    nowMs: FIRST_OPEN_MS + GETTING_STARTED_INTERVAL_MS,
    campaignFlagEnabled: true,
    osNotificationsEnabled: true,
    gettingStartedCategoryEnabled: true,
    skipWhenFocused: true,
    appFocused: false,
    inQuietHours: false,
    readChecklistState: () => Promise.resolve(checklist()),
    ...overrides,
  };
}

function sequence(): GettingStartedStep[] {
  return ONBOARDING_CHECKLIST_ITEM_IDS.flatMap((itemId) => {
    const step = getGettingStartedStep(itemId);
    return step === undefined ? [] : [step];
  });
}

describe('getting started sequence definition', () => {
  it('defines a step for every canonical checklist item id', () => {
    expect(sequence().map((step) => step.itemId)).toEqual([
      ...ONBOARDING_CHECKLIST_ITEM_IDS,
    ]);
  });

  it('gives every step a validated headline, subtitle, and deep link', () => {
    for (const step of sequence()) {
      expect(step.headline.trim().length).toBeGreaterThan(0);
      expect(step.subtitle.trim().length).toBeGreaterThan(0);
      expect(isValidGettingStartedStep(step)).toBe(true);
    }
  });

  it('rejects a step with blank copy or an unroutable deep link', () => {
    const [step] = sequence();
    expect(isValidGettingStartedStep({ ...step, headline: '  ' })).toBe(false);
    expect(isValidGettingStartedStep({ ...step, subtitle: '' })).toBe(false);
    expect(
      isValidGettingStartedStep({
        ...step,
        deepLink: { kind: 'settings', section: '' },
      }),
    ).toBe(false);
    expect(
      isValidGettingStartedStep({ ...step, deepLink: { kind: 'nowhere' } }),
    ).toBe(false);
  });

  it('points "Connect a tool" at Integrations and "Create an account" at the account', () => {
    expect(getGettingStartedStep('connect-accounts')?.deepLink).toEqual({
      kind: 'settings',
      section: 'account',
      target: 'integrations',
    });
    expect(getGettingStartedStep('create-account')?.deepLink).toEqual({
      kind: 'settings',
      section: 'account',
    });
  });

  it('resolves only item ids the checklist defines', () => {
    expect(getGettingStartedStep('start-chat')?.itemId).toBe('start-chat');
    expect(getGettingStartedStep('run-pipeline')).toBeUndefined();
  });
});

describe('evaluateGettingStartedSequence', () => {
  it('waits a full day after first open before the first step', async () => {
    const decision = await evaluateGettingStartedSequence(
      context({ nowMs: FIRST_OPEN_MS + 23 * HOUR_MS }),
    );
    expect(decision).toEqual({
      kind: 'wait',
      reason: 'not-yet-due',
      retryAt: FIRST_OPEN_MS + GETTING_STARTED_INTERVAL_MS,
    });
  });

  it('sends the first incomplete step in checklist order', async () => {
    const decision = await evaluateGettingStartedSequence(context());
    expect(decision.kind).toBe('send');
    if (decision.kind !== 'send') return;
    expect(decision.step.itemId).toBe('create-account');
    expect(decision.skippedItemIds).toEqual([]);
  });

  it('never prompts for a completed item and reports what it skipped', async () => {
    const decision = await evaluateGettingStartedSequence(
      context({
        readChecklistState: () =>
          Promise.resolve(checklist(['create-account', 'start-chat'])),
      }),
    );
    expect(decision.kind).toBe('send');
    if (decision.kind !== 'send') return;
    expect(decision.step.itemId).toBe('connect-accounts');
    expect(decision.skippedItemIds).toEqual(['create-account', 'start-chat']);
  });

  it('skips an item the checklist does not apply to this install', async () => {
    const state = checklist();
    state.items = state.items.filter((item) => item.id !== 'create-account');
    const decision = await evaluateGettingStartedSequence(
      context({ readChecklistState: () => Promise.resolve(state) }),
    );
    expect(decision.kind).toBe('send');
    if (decision.kind !== 'send') return;
    expect(decision.step.itemId).toBe('start-chat');
  });

  it('holds the next step until 24 hours after the previous send', async () => {
    const sentAt = FIRST_OPEN_MS + 30 * HOUR_MS;
    const state = journeyState({
      gettingStarted: {
        steps: { 'create-account': { sentAt: new Date(sentAt).toISOString() } },
      },
    });
    const early = await evaluateGettingStartedSequence(
      context({ state, nowMs: sentAt + 23 * HOUR_MS }),
    );
    expect(early).toEqual({
      kind: 'wait',
      reason: 'not-yet-due',
      retryAt: sentAt + GETTING_STARTED_INTERVAL_MS,
    });

    const due = await evaluateGettingStartedSequence(
      context({ state, nowMs: sentAt + GETTING_STARTED_INTERVAL_MS }),
    );
    expect(due.kind).toBe('send');
    if (due.kind !== 'send') return;
    // Each step sends at most once, so an item the user ignored is not
    // repeated: the sequence moves on rather than nagging daily.
    expect(due.step.itemId).toBe('start-chat');
  });

  it('shares the daily cap with other promotional campaign sends', async () => {
    const sentAt = FIRST_OPEN_MS + 24 * HOUR_MS;
    const decision = await evaluateGettingStartedSequence(
      context({
        state: journeyState({
          campaigns: {
            'activation-mobile': { sentAt: new Date(sentAt).toISOString() },
          },
        }),
        nowMs: sentAt + HOUR_MS,
      }),
    );
    expect(decision).toEqual({
      kind: 'wait',
      reason: 'not-yet-due',
      retryAt: sentAt + GETTING_STARTED_INTERVAL_MS,
    });
  });

  it('finishes once the checklist is complete', async () => {
    const decision = await evaluateGettingStartedSequence(
      context({
        readChecklistState: () =>
          Promise.resolve(checklist([...ONBOARDING_CHECKLIST_ITEM_IDS])),
      }),
    );
    expect(decision).toEqual({
      kind: 'finished',
      skippedItemIds: [...ONBOARDING_CHECKLIST_ITEM_IDS],
    });
  });

  it('finishes without probing once every step has sent', async () => {
    const readChecklistState = jest.fn(() => Promise.resolve(checklist()));
    const steps = Object.fromEntries(
      ONBOARDING_CHECKLIST_ITEM_IDS.map((id) => [id, { sentAt: FIRST_OPEN }]),
    );
    const decision = await evaluateGettingStartedSequence(
      context({
        state: journeyState({ gettingStarted: { steps } }),
        nowMs: FIRST_OPEN_MS + 5 * GETTING_STARTED_INTERVAL_MS,
        readChecklistState,
      }),
    );
    expect(decision).toEqual({ kind: 'finished', skippedItemIds: [] });
    expect(readChecklistState).not.toHaveBeenCalled();
  });

  it('expires instead of nudging a long-installed user', async () => {
    const readChecklistState = jest.fn(() => Promise.resolve(checklist()));
    const decision = await evaluateGettingStartedSequence(
      context({
        nowMs: FIRST_OPEN_MS + GETTING_STARTED_WINDOW_MS + 1,
        readChecklistState,
      }),
    );
    expect(decision).toEqual({
      kind: 'suppressed',
      reason: 'expired',
      itemId: null,
      skippedItemIds: [],
    });
    expect(readChecklistState).not.toHaveBeenCalled();
  });

  it.each([
    ['campaign-disabled', { campaignFlagEnabled: false }],
    ['notifications-disabled', { osNotificationsEnabled: false }],
    ['category-disabled', { gettingStartedCategoryEnabled: false }],
    ['app-focused', { appFocused: true }],
    ['quiet-hours', { inQuietHours: true }],
  ] as const)('suppresses as %s', async (reason, overrides) => {
    const decision = await evaluateGettingStartedSequence(context(overrides));
    expect(decision).toEqual({
      kind: 'suppressed',
      reason,
      itemId: null,
      skippedItemIds: [],
    });
  });

  it('follows the skip-when-focused preference like every other notification', async () => {
    const decision = await evaluateGettingStartedSequence(
      context({ appFocused: true, skipWhenFocused: false }),
    );
    expect(decision.kind).toBe('send');
  });

  it('suppresses a holdout install', async () => {
    const decision = await evaluateGettingStartedSequence(
      context({ state: journeyState({ holdout: true }) }),
    );
    expect(decision.kind).toBe('suppressed');
    if (decision.kind !== 'suppressed') return;
    expect(decision.reason).toBe('holdout');
  });

  it('does not send before the journey has an anchor', async () => {
    const decision = await evaluateGettingStartedSequence(
      context({ state: journeyState({ firstOpenAt: null }) }),
    );
    expect(decision).toEqual({
      kind: 'wait',
      reason: 'no-anchor',
      retryAt: null,
    });
  });

  it('treats an unreadable checklist as retryable, never as permission', async () => {
    const decision = await evaluateGettingStartedSequence(
      context({
        readChecklistState: () => Promise.reject(new Error('disk')),
      }),
    );
    expect(decision).toEqual({
      kind: 'suppressed',
      reason: 'probe-failed',
      itemId: null,
      skippedItemIds: [],
    });
  });

  it('stops when the user dismissed the checklist', async () => {
    const decision = await evaluateGettingStartedSequence(
      context({
        readChecklistState: () =>
          Promise.resolve(checklist([], { dismissedAt: FIRST_OPEN })),
      }),
    );
    expect(decision).toEqual({
      kind: 'suppressed',
      reason: 'checklist-dismissed',
      itemId: null,
      skippedItemIds: [],
    });
  });

  it('holds while the checklist is snoozed', async () => {
    const nowMs = FIRST_OPEN_MS + GETTING_STARTED_INTERVAL_MS;
    const snoozedUntil = new Date(nowMs + 6 * HOUR_MS).toISOString();
    const decision = await evaluateGettingStartedSequence(
      context({
        nowMs,
        readChecklistState: () =>
          Promise.resolve(checklist([], { snoozedUntil })),
      }),
    );
    expect(decision).toEqual({
      kind: 'wait',
      reason: 'not-yet-due',
      retryAt: nowMs + 6 * HOUR_MS,
    });
  });

  it('skips account-level steps after a reinstall or on a second device', async () => {
    // A wiped data dir or a new machine starts with empty journey latches, so
    // the only thing standing between the user and a repeat nudge is that the
    // step is evaluated against live product state at send time.
    const decision = await evaluateGettingStartedSequence(
      context({
        state: journeyState({ gettingStarted: undefined }),
        readChecklistState: () =>
          Promise.resolve(checklist(['create-account'])),
      }),
    );
    expect(decision.kind).toBe('send');
    if (decision.kind !== 'send') return;
    expect(decision.step.itemId).toBe('start-chat');
    expect(decision.skippedItemIds).toEqual(['create-account']);
  });
});
