const mockReadFile = jest.fn<Promise<string>, [string, string]>();
const mockWriteFile = jest.fn<Promise<void>, [string, string, string]>();
const mockMkdir = jest.fn<Promise<void>, [string, { recursive: boolean }]>();

jest.mock('node:fs/promises', () => ({
  mkdir: (path: string, options: { recursive: boolean }): Promise<void> =>
    mockMkdir(path, options),
  readFile: (path: string, encoding: string): Promise<string> =>
    mockReadFile(path, encoding),
  writeFile: (
    path: string,
    contents: string,
    encoding: string,
  ): Promise<void> => mockWriteFile(path, contents, encoding),
}));

jest.mock('../lib/paths', () => ({
  getActivationJourneyFilePath: (): string =>
    '/mock/data-dir/activation-journey.json',
}));

import {
  readActivationJourneyState,
  drainActivationJourneyWrites,
  resetActivationJourneyStateForTests,
  unlatchCampaignDeliveryFailure,
} from '../notifications/campaigns/journey-state';
import { CAMPAIGN_SUPPRESSION_REASONS } from '@canopy/desktop-shared/types';
import {
  EVENT_DRIVEN_SUPPRESSION_REASONS,
  TRANSIENT_SUPPRESSION_REASONS,
  POWER_RESUME_SETTLE_MS,
  recomputeActivationSchedule,
  resetActivationSchedulerForTests,
  startActivationJourney,
  stopActivationJourney,
} from '../notifications/campaigns/scheduler';
import type {
  ActivationJourneyDeps,
  ActivationNotificationPreferences,
} from '../notifications/campaigns/scheduler';

const FIRST_OPEN = '2026-01-01T00:00:00.000Z';
const DAY_MS = 24 * 60 * 60 * 1000;

const LAST_ACTIVE = '2026-01-01T09:00:00.000Z';

function persistedState(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    firstOpenAt: FIRST_OPEN,
    // Deliberately later than every first-open due time used below, so the
    // abandonment-anchored campaign stays out of the way and each test
    // exercises one campaign at a time.
    lastActiveAt: LAST_ACTIVE,
    holdout: false,
    campaigns: {},
    signals: {},
    // Every step already sent, so the Getting Started sequence (CAN-3013)
    // reports `finished` and stays out of the way of the campaign tests.
    gettingStarted: { steps: {} },
    ...overrides,
  });
}

let showNotification: jest.Mock<
  void,
  Parameters<ActivationJourneyDeps['showNotification']>
>;
let recordOutcome: jest.Mock;
let resumeHandlers: Array<() => void>;

function deps(
  overrides: Partial<ActivationJourneyDeps> = {},
): ActivationJourneyDeps {
  return {
    now: () => Date.now(),
    showNotification,
    recordOutcome,
    isCampaignFlagEnabled: () => true,
    readNotificationPreferences: () =>
      Promise.resolve({
        enabled: true,
        skipWhenFocused: true,
        activationCategoryEnabled: true,
        quietHours: { enabled: false, startHour: 22, endHour: 8 },
      }),
    isAppFocused: () => false,
    hasActivated: () => Promise.resolve(false),
    isCampaignEligible: () => Promise.resolve(true),
    resolveVariantKey: () => Promise.resolve({ variantKey: 'default' }),
    onPowerResume: (handler: () => void) => {
      resumeHandlers.push(handler);
      return () => {
        resumeHandlers = resumeHandlers.filter((h) => h !== handler);
      };
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  resetActivationJourneyStateForTests();
  resetActivationSchedulerForTests();
  resumeHandlers = [];
  showNotification = jest.fn<
    void,
    Parameters<ActivationJourneyDeps['showNotification']>
  >();
  recordOutcome = jest.fn();
  mockMkdir.mockResolvedValue(undefined);
  mockWriteFile.mockResolvedValue(undefined);
  mockReadFile.mockResolvedValue(persistedState());
});

afterEach(() => {
  stopActivationJourney();
  jest.useRealTimers();
});

describe('transient suppression retries', () => {
  // Regression (multi-model review of PR #2871): a campaign that was DUE but
  // suppressed for a transient reason latched and armed no timer, because
  // only `notYetDue` campaigns contributed to the next wake-up. The state
  // stayed re-deliverable -- the invariant a separate test pins -- but
  // nothing ever re-derived it, so with the shipped `skipWhenFocused: true`
  // a focused window at the due moment killed the campaign for the session.

  it('re-fires after the window loses focus', async () => {
    jest.setSystemTime(Date.parse('2026-01-01T08:00:01.000Z'));
    let focused = true;
    const d = deps({ isAppFocused: () => focused });

    await recomputeActivationSchedule(d);
    expect(showNotification).not.toHaveBeenCalled();
    expect(recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'suppressed', reason: 'app-focused' }),
    );

    focused = false;
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(showNotification).toHaveBeenCalledTimes(1);
  });

  it('re-fires after quiet hours end', async () => {
    jest.setSystemTime(Date.parse('2026-01-01T08:00:01.000Z'));
    let quiet = true;
    const d = deps({
      readNotificationPreferences: () =>
        Promise.resolve({
          enabled: true,
          skipWhenFocused: true,
          activationCategoryEnabled: true,
          quietHours: quiet
            ? { enabled: true, startHour: 0, endHour: 23 }
            : { enabled: false, startHour: 22, endHour: 8 },
        }),
    });

    await recomputeActivationSchedule(d);
    expect(showNotification).not.toHaveBeenCalled();

    quiet = false;
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(showNotification).toHaveBeenCalledTimes(1);
  });

  it('does not poll for notifications-disabled, but recomputes on demand', async () => {
    // Event-driven, not time-driven: polling for it burned a main-thread
    // preference read every five minutes on every install, forever. The
    // preference save path calls requestActivationRecompute() instead.
    jest.setSystemTime(Date.parse('2026-01-01T08:00:01.000Z'));
    let enabled = false;
    const d = deps({
      readNotificationPreferences: () =>
        Promise.resolve({
          enabled,
          skipWhenFocused: true,
          activationCategoryEnabled: true,
          quietHours: { enabled: false, startHour: 22, endHour: 8 },
        }),
    });

    await recomputeActivationSchedule(d);
    expect(showNotification).not.toHaveBeenCalled();

    // No timer was armed, so time alone changes nothing.
    enabled = true;
    await jest.advanceTimersByTimeAsync(60 * 60_000);
    expect(showNotification).not.toHaveBeenCalled();

    // An explicit recompute — what the preference save triggers — delivers.
    await recomputeActivationSchedule(d);
    expect(showNotification).toHaveBeenCalledTimes(1);
  });

  it('stays completely quiet while the journey flag is dark', async () => {
    // Regression: campaign-disabled used to arm a 5-minute retry, so every
    // install polled the main thread forever for a feature shipping dark.
    jest.setSystemTime(Date.parse('2026-01-01T08:00:01.000Z'));
    const readPreferences = jest.fn(() =>
      Promise.resolve({
        enabled: true,
        skipWhenFocused: true,
        activationCategoryEnabled: true,
        quietHours: { enabled: false, startHour: 22, endHour: 8 },
      }),
    );
    await recomputeActivationSchedule(
      deps({
        isCampaignFlagEnabled: () => false,
        readNotificationPreferences: readPreferences,
      }),
    );
    // Returns before reading anything, and arms no timer.
    expect(readPreferences).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);

    await jest.advanceTimersByTimeAsync(60 * 60_000);
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('stops retrying a missing anchor once its ceiling has passed', async () => {
    // A window that never fires `focus` (hidden E2E window,
    // autostart-minimized, launch-then-switch-away) left `no-anchor` polling
    // for the process lifetime -- the one unbounded loop after the poll fix.
    jest.setSystemTime(Date.parse('2026-01-10T00:00:00.000Z'));
    mockReadFile.mockResolvedValue(persistedState({ lastActiveAt: null }));
    await recomputeActivationSchedule(deps());
    await jest.advanceTimersByTimeAsync(60 * 60_000);
    expect(showNotification).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('treats an unreadable first-open as expired rather than unbounded', async () => {
    // firstOpenAt null is the only state a first-open-anchored campaign can
    // report `no-anchor` from, so leaving the ceiling null would exempt the
    // very campaigns the bound names.
    jest.setSystemTime(Date.parse('2026-01-01T00:05:00.000Z'));
    mockReadFile.mockResolvedValue(
      persistedState({ firstOpenAt: null, lastActiveAt: null }),
    );
    await recomputeActivationSchedule(deps());
    await jest.advanceTimersByTimeAsync(60 * 60_000);
    expect(showNotification).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('still retries a missing anchor inside its ceiling', async () => {
    jest.setSystemTime(Date.parse('2026-01-01T00:05:00.000Z'));
    mockReadFile.mockResolvedValue(persistedState({ lastActiveAt: null }));
    await recomputeActivationSchedule(deps());
    expect(jest.getTimerCount()).toBeGreaterThan(0);
  });

  it('stops retrying once the lateness bound has passed', async () => {
    // A campaign that can never send again must not keep a timer alive for
    // the process lifetime.
    // Past every campaign's lateness bound (the largest is 72h after a
    // first-open anchor of 2026-01-01).
    jest.setSystemTime(Date.parse('2026-01-10T00:00:00.000Z'));
    await recomputeActivationSchedule(deps({ isAppFocused: () => true }));
    expect(showNotification).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not retry a terminal suppression', async () => {
    // A holdout user must never be retried into a send.
    jest.setSystemTime(Date.parse('2026-01-01T08:00:01.000Z'));
    mockReadFile.mockResolvedValue(persistedState({ holdout: true }));
    await recomputeActivationSchedule(deps());
    await jest.advanceTimersByTimeAsync(60 * 60_000);
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('keeps a missing abandonment anchor retryable without recording it', async () => {
    // The fresh-install hole: the journey evaluates at app-ready, but
    // `lastActiveAt` is not written until the first window focus. Time is set
    // before the marketplace campaign's 8h offset so only the abandonment
    // campaigns are in play. `firstOpenAt` IS set — `recordFirstOpen` is
    // awaited before the scheduler starts — which keeps the ceiling finite.
    jest.setSystemTime(Date.parse('2026-01-01T01:00:00.000Z'));
    mockReadFile.mockResolvedValue(persistedState({ lastActiveAt: null }));
    await recomputeActivationSchedule(deps());

    expect(showNotification).not.toHaveBeenCalled();
    // A pre-start state, not a suppression the user reached: no record, no
    // telemetry — matching how `not-yet-due` is treated.
    expect(recordOutcome).not.toHaveBeenCalled();
    // Still inside the ceiling, so a retry stays armed and the anchor can
    // arrive later. `recordActivity` also recomputes directly on write.
    expect(jest.getTimerCount()).toBeGreaterThan(0);

    // And it must actually DELIVER once the anchor lands -- `app-focused` and
    // `quiet-hours` both have this end-to-end assertion, and `no-anchor` is
    // the path the flip-on anchor seeding exists to protect.
    resetActivationJourneyStateForTests();
    mockReadFile.mockResolvedValue(
      // Abandonment +10m from 00:30 is due at 00:40, well before the 01:05
      // retry; the +1h campaign is not due until 01:30.
      persistedState({ lastActiveAt: '2026-01-01T00:30:00.000Z' }),
    );
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    // Exactly one: only the +10m campaign is due at 01:05 (the +1h one is
    // not due until 01:30). Pin the identity too, so a future campaign
    // landing in that window fails here rather than silently shifting which
    // campaign this test proves.
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(recordOutcome).toHaveBeenCalledWith({
      campaignId: 'activation-first-task',
      outcome: 'delivered',
      destination: 'home',
      variant: 'default',
    });
  });
});

describe('recomputeActivationSchedule', () => {
  it('fires a campaign once its due time is reached', async () => {
    jest.setSystemTime(Date.parse('2026-01-01T08:00:01.000Z'));
    await recomputeActivationSchedule(deps());
    expect(showNotification).toHaveBeenCalledTimes(1);
    const state = await readActivationJourneyState();
    expect(state.campaigns['activation-marketplace']?.sentAt).toBeDefined();
  });

  it('does not fire before the due time', async () => {
    jest.setSystemTime(Date.parse('2026-01-01T07:00:00.000Z'));
    await recomputeActivationSchedule(deps());
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('never fires the same campaign twice', async () => {
    jest.setSystemTime(Date.parse('2026-01-01T08:00:01.000Z'));
    await recomputeActivationSchedule(deps());
    await recomputeActivationSchedule(deps());
    expect(showNotification).toHaveBeenCalledTimes(1);
  });

  it('expires instead of firing past the lateness bound', async () => {
    jest.setSystemTime(Date.parse('2026-01-05T00:00:01.000Z'));
    await recomputeActivationSchedule(deps());
    expect(showNotification).not.toHaveBeenCalled();
    const state = await readActivationJourneyState();
    expect(state.campaigns['activation-marketplace']?.suppressedReason).toBe(
      'expired',
    );
  });

  it('records the suppression reason when notifications are disabled', async () => {
    jest.setSystemTime(Date.parse('2026-01-01T08:00:01.000Z'));
    await recomputeActivationSchedule(
      deps({
        readNotificationPreferences: () =>
          Promise.resolve({
            enabled: false,
            skipWhenFocused: true,
            activationCategoryEnabled: true,
            quietHours: { enabled: false, startHour: 22, endHour: 8 },
          }),
      }),
    );
    expect(showNotification).not.toHaveBeenCalled();
    expect(recordOutcome).toHaveBeenCalledWith({
      campaignId: 'activation-marketplace',
      outcome: 'suppressed',
      reason: 'notifications-disabled',
    });
  });

  it('reports a delivered outcome with no free text', async () => {
    jest.setSystemTime(Date.parse('2026-01-01T08:00:01.000Z'));
    await recomputeActivationSchedule(deps());
    expect(recordOutcome).toHaveBeenCalledWith({
      campaignId: 'activation-marketplace',
      outcome: 'delivered',
      destination: 'plugins',
      variant: 'default',
    });
  });

  it('still delivers a campaign that was previously suppressed', async () => {
    jest.setSystemTime(Date.parse('2026-01-01T08:00:01.000Z'));
    const disabledPrefs: Partial<ActivationJourneyDeps> = {
      readNotificationPreferences:
        (): Promise<ActivationNotificationPreferences> =>
          Promise.resolve({
            enabled: false,
            skipWhenFocused: true,
            activationCategoryEnabled: true,
            quietHours: { enabled: false, startHour: 22, endHour: 8 },
          }),
    };
    await recomputeActivationSchedule(deps(disabledPrefs));
    expect(showNotification).not.toHaveBeenCalled();
    expect(
      (await readActivationJourneyState()).campaigns['activation-marketplace']
        ?.suppressedReason,
    ).toBe('notifications-disabled');

    // The user opts back in. A suppression must not have retired the campaign.
    await recomputeActivationSchedule(deps());
    expect(showNotification).toHaveBeenCalledTimes(1);
  });

  it('does not re-suppress a campaign whose reason is unchanged', async () => {
    jest.setSystemTime(Date.parse('2026-01-05T00:00:01.000Z'));
    await recomputeActivationSchedule(deps());
    const writesAfterFirst = mockWriteFile.mock.calls.length;
    await recomputeActivationSchedule(deps());
    expect(mockWriteFile.mock.calls.length).toBe(writesAfterFirst);
  });
});

describe('copy variants', () => {
  it('suppresses when no variant applies to this user', async () => {
    jest.setSystemTime(Date.parse('2026-01-01T08:00:01.000Z'));
    await recomputeActivationSchedule(
      deps({
        resolveVariantKey: () =>
          Promise.resolve({
            variantKey: null,
            reason: 'variant-unavailable' as const,
          }),
      }),
    );
    expect(showNotification).not.toHaveBeenCalled();
    expect(recordOutcome).toHaveBeenCalledWith({
      campaignId: 'activation-marketplace',
      outcome: 'suppressed',
      reason: 'variant-unavailable',
    });
  });

  it('suppresses when the resolver names a variant the campaign lacks', async () => {
    jest.setSystemTime(Date.parse('2026-01-01T08:00:01.000Z'));
    await recomputeActivationSchedule(
      deps({
        resolveVariantKey: () =>
          Promise.resolve({ variantKey: 'no-such-variant' }),
      }),
    );
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('encodes the variant in the notification id for click routing', async () => {
    jest.setSystemTime(Date.parse('2026-01-01T08:00:01.000Z'));
    await recomputeActivationSchedule(deps());
    expect(showNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'activation-campaign:activation-marketplace:default',
      }),
      // Second argument is the delivery-failure callback.
      expect.any(Function),
    );
  });
});

describe('startActivationJourney', () => {
  it('schedules a timer instead of firing when the campaign is not yet due', async () => {
    jest.setSystemTime(Date.parse('2026-01-01T00:00:00.000Z'));
    await startActivationJourney(deps());
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('recomputes from wall-clock on resume rather than trusting the timer', async () => {
    jest.setSystemTime(Date.parse('2026-01-01T00:00:00.000Z'));
    await startActivationJourney(deps());
    expect(showNotification).not.toHaveBeenCalled();

    // The machine slept through the due time: the pending timer never ran.
    jest.setSystemTime(Date.parse('2026-01-01T09:00:00.000Z'));
    expect(resumeHandlers.length).toBeGreaterThan(0);
    for (const handler of resumeHandlers) handler();
    await jest.advanceTimersByTimeAsync(POWER_RESUME_SETTLE_MS);

    expect(showNotification).toHaveBeenCalledTimes(1);
  });

  it('waits out the settle delay before notifying after a resume', async () => {
    jest.setSystemTime(Date.parse('2026-01-01T00:00:00.000Z'));
    await startActivationJourney(deps());
    jest.setSystemTime(Date.parse('2026-01-01T09:00:00.000Z'));
    for (const handler of resumeHandlers) handler();

    await jest.advanceTimersByTimeAsync(POWER_RESUME_SETTLE_MS - 1);
    expect(showNotification).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(showNotification).toHaveBeenCalledTimes(1);
  });
});

describe('stopActivationJourney', () => {
  it('unsubscribes power listeners so no timer outlives the app', async () => {
    jest.setSystemTime(Date.parse('2026-01-01T00:00:00.000Z'));
    await startActivationJourney(deps());
    expect(resumeHandlers.length).toBeGreaterThan(0);
    stopActivationJourney();
    expect(resumeHandlers.length).toBe(0);
  });
});

describe('OS refuses to present the notification', () => {
  // Found by running the app: on macOS an ad-hoc-signed dev bundle is denied
  // notification authorization, so `show()` succeeds and the OS then rejects
  // asynchronously. Every campaign burned its once-per-install send and
  // reported `delivered` for a banner nobody saw. No test covered this
  // because the fake `showNotification` never invoked the failure path.
  it('unwinds the send latch so the campaign is retried', async () => {
    jest.setSystemTime(Date.parse('2026-01-01T08:00:01.000Z'));
    const failures: (() => void)[] = [];
    const d = deps({
      showNotification: (_request, onFailed): void => {
        failures.push((): void => onFailed(new Error('UNErrorDomain error 1')));
      },
    });

    await recomputeActivationSchedule(d);
    // Optimistically latched: the OS accepted the request.
    expect(
      (await readActivationJourneyState()).campaigns['activation-marketplace']
        ?.sentAt,
    ).toBeDefined();

    expect(failures).toHaveLength(1);
    failures[0]?.();
    await drainActivationJourneyWrites();

    const record = (await readActivationJourneyState()).campaigns[
      'activation-marketplace'
    ];
    expect(record?.sentAt).toBeUndefined();
    expect(record?.suppressedReason).toBe('delivery-failed');
    expect(recordOutcome).toHaveBeenCalledWith({
      campaignId: 'activation-marketplace',
      outcome: 'suppressed',
      reason: 'delivery-failed',
    });
  });

  it('retries a refused campaign on an event, never on the timer', async () => {
    // The Getting Started sequence (CAN-3013) keeps a daily heartbeat alive
    // for two weeks after install. That heartbeat must not turn a
    // delivery-failed campaign -- event-driven by design -- into a daily
    // re-presentation of a banner the OS refuses.
    jest.setSystemTime(Date.parse('2026-01-01T08:00:01.000Z'));
    // Only the marketplace campaign is live; the hold is per campaign, and
    // the others sending on a later day would be correct, not a leak.
    mockReadFile.mockResolvedValue(
      persistedState({
        campaigns: {
          'activation-first-task': { sentAt: '2025-12-01T00:00:00.000Z' },
          'activation-role-branch': { sentAt: '2025-12-01T00:00:00.000Z' },
          'activation-mobile': { sentAt: '2025-12-01T00:00:00.000Z' },
        },
      }),
    );
    const failures: (() => void)[] = [];
    const sends: string[] = [];
    const d = deps({
      showNotification: (request, onFailed): void => {
        sends.push(request.id);
        failures.push((): void => onFailed(new Error('UNErrorDomain error 1')));
      },
    });

    await recomputeActivationSchedule(d, { event: true });
    expect(failures).toHaveLength(1);
    failures[0]?.();
    await drainActivationJourneyWrites();
    expect(sends).toHaveLength(1);

    // An event inside the day does not release it: the window-focus anchor
    // write is an event, and it fires as often as once a minute of active
    // use. Without this bound a denied OS is re-asked every minute.
    jest.setSystemTime(Date.now() + 60_000);
    await recomputeActivationSchedule(d, { event: true });
    expect(sends).toHaveLength(1);

    // Timer-driven passes leave the hold alone, however old it is. (Stay
    // inside the campaign's 48h lateness bound, measured from 08:00.)
    await recomputeActivationSchedule(d);
    await jest.advanceTimersByTimeAsync(DAY_MS);
    expect(sends).toHaveLength(1);

    // A day after the refusal, an event releases the hold and retries.
    await recomputeActivationSchedule(d, { event: true });
    expect(sends).toHaveLength(2);
  });

  it('redelivers on the next evaluation', async () => {
    jest.setSystemTime(Date.parse('2026-01-01T08:00:01.000Z'));
    const failures: (() => void)[] = [];
    const failing = deps({
      showNotification: (_request, onFailed): void => {
        failures.push((): void => onFailed(new Error('UNErrorDomain error 1')));
      },
    });
    await recomputeActivationSchedule(failing);
    expect(failures).toHaveLength(1);
    failures[0]?.();
    await drainActivationJourneyWrites();

    // A later EVENT -- next launch, or a preference change -- retries once a
    // day has passed since the refusal. A timer-driven pass never does; see
    // the test below.
    jest.setSystemTime(Date.now() + DAY_MS);
    await recomputeActivationSchedule(deps(), { event: true });
    expect(showNotification).toHaveBeenCalledTimes(1);
  });

  it('does not unwind a send that succeeded', async () => {
    // The callback is async; a stray failure after a genuine send must not
    // resurrect the campaign and notify the user twice.
    jest.setSystemTime(Date.parse('2026-01-01T08:00:01.000Z'));
    await recomputeActivationSchedule(deps());
    const before = (await readActivationJourneyState()).campaigns[
      'activation-marketplace'
    ]?.sentAt;
    expect(before).toBeDefined();

    await unlatchCampaignDeliveryFailure(
      'activation-role-branch',
      '2026-01-01T09:00:00.000Z',
    );
    expect(
      (await readActivationJourneyState()).campaigns['activation-marketplace']
        ?.sentAt,
    ).toBe(before);
  });
});

describe('suppression reason classification', () => {
  it('classifies every reason exactly once', () => {
    // Nothing enforces this at compile time, and an unclassified reason
    // silently defaults to terminal -- which retires a campaign for good.
    // Iterate the canonical array rather than spreading the Sets: spreading a
    // ReadonlySet widens the element to `any` under this tsconfig.
    const overlap = CAMPAIGN_SUPPRESSION_REASONS.filter(
      (reason) =>
        TRANSIENT_SUPPRESSION_REASONS.has(reason) &&
        EVENT_DRIVEN_SUPPRESSION_REASONS.has(reason),
    );
    expect(overlap).toEqual([]);

    const unclassified = CAMPAIGN_SUPPRESSION_REASONS.filter(
      (reason) =>
        !TRANSIENT_SUPPRESSION_REASONS.has(reason) &&
        !EVENT_DRIVEN_SUPPRESSION_REASONS.has(reason),
    );
    // The remainder are terminal by design; pinning the list means adding a
    // reason forces a deliberate choice here rather than a silent default.
    expect(unclassified.slice().sort()).toEqual(
      [
        'already-activated',
        'already-sent',
        'expired',
        'holdout',
        'not-eligible',
        'role-not-mapped',
        'role-unknown',
        'variant-unavailable',
      ].sort(),
    );
  });
});
