/**
 * @jest-environment jsdom
 */
/* eslint-disable @typescript-eslint/require-await -- act() callbacks stay async so React flushes the settled promises they trigger. */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  ModelRoutingBacktestCreateResponseV1,
  ModelRoutingBacktestLookupResponseV1,
  ModelRoutingBacktestResultV1,
  ModelRoutingBacktestV1,
} from '@canopy/protocol/model-routing';

const lookupRoutingBacktest = jest.fn<
  Promise<ModelRoutingBacktestLookupResponseV1>,
  unknown[]
>();
const createRoutingBacktest = jest.fn<
  Promise<ModelRoutingBacktestCreateResponseV1>,
  unknown[]
>();
const getRoutingBacktest = jest.fn<
  Promise<ModelRoutingBacktestV1>,
  unknown[]
>();

jest.mock('../routing-backtest-api', () => ({
  lookupRoutingBacktest: (
    ...args: unknown[]
  ): Promise<ModelRoutingBacktestLookupResponseV1> =>
    lookupRoutingBacktest(...args),
  createRoutingBacktest: (
    ...args: unknown[]
  ): Promise<ModelRoutingBacktestCreateResponseV1> =>
    createRoutingBacktest(...args),
  getRoutingBacktest: (...args: unknown[]): Promise<ModelRoutingBacktestV1> =>
    getRoutingBacktest(...args),
}));

jest.mock('../../team-api', () => ({
  TeamApiError: class TeamApiError extends Error {
    constructor(
      public status: number,
      public serverDetail?: string,
      public code?: string,
    ) {
      super('Something went wrong. Try again.');
    }
  },
}));

jest.mock('../charts', () => ({
  ComparisonLineChart: ({ testId }: { testId: string }): JSX.Element => (
    <div data-testid={testId} />
  ),
  PairedCategoryBarChart: ({ testId }: { testId: string }): JSX.Element => (
    <div data-testid={testId} />
  ),
}));

import {
  TestSettingsHost,
  createFakeSettingsClient,
  createTestSettingsHost,
} from '../../../__tests__/helpers/test-settings-host';
import { RoutingBacktestCard } from '../RoutingBacktestCard';

/** `expect.any` is typed `any`; hold it as `unknown` for strict lint. */
const ANY_STRING: unknown = expect.any(String);

/** The card's settings client; the API module is mocked, so it only has to be passed through. */
const SETTINGS_CLIENT = createFakeSettingsClient();

/** A root that renders inside the settings test host (brand, links, client). */
interface HostedRoot {
  render(node: ReactNode): void;
  unmount(): void;
}

function createHostedRoot(container: HTMLElement): HostedRoot {
  const { host } = createTestSettingsHost({ client: SETTINGS_CLIENT });
  const root = createRoot(container);
  return {
    render: (node) =>
      root.render(<TestSettingsHost host={host}>{node}</TestSettingsHost>),
    unmount: () => root.unmount(),
  };
}

const ESTIMATE = {
  coverageTurnCount: 5_000,
  eligibleTurnCount: 4_000,
  plannedTurnCount: { sample: 2_000, full: 4_000 },
  estimatedCostUsd: { sample: 0.6, full: 1.2 },
  balanceSufficient: true,
  runsRemainingToday: 3,
};

const RESULT: ModelRoutingBacktestResultV1 = {
  baselineCostUsd: 100,
  autoCostUsd: 62,
  routingCostUsd: 0.5,
  savingsUsd: 38,
  savingsFraction: 0.38,
  savingsLowUsd: 30,
  savingsHighUsd: 45,
  coverageTurnCount: 48_210,
  eligibleTurnCount: 30_000,
  replayedTurnCount: 1_940,
  keptForCacheShare: 0.12,
  subscriptionLaneShare: 0.2,
  pricingRevision: 'r1',
  bucketGranularity: 'week',
  series: [],
  modelShare: [],
  shifts: [],
};

function run(
  overrides: Partial<ModelRoutingBacktestV1> = {},
): ModelRoutingBacktestV1 {
  return {
    id: 'bt-1',
    subject: 'organization',
    scope: 'organization',
    status: 'queued',
    mode: 'sample',
    rangeStartIso: '2026-08-23T00:00:00.000Z',
    rangeEndIso: '2026-09-22T00:00:00.000Z',
    createdAtIso: '2026-09-22T00:00:00.000Z',
    completedAtIso: null,
    estimatedCostUsd: 0.6,
    progress: { replayedTurnCount: 0, plannedTurnCount: 2_000 },
    failureCode: null,
    result: null,
    ...overrides,
  };
}

describe('RoutingBacktestCard', () => {
  let container: HTMLElement;
  let root: HostedRoot;

  beforeEach(() => {
    jest.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createHostedRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
  });

  async function render(): Promise<void> {
    await act(async () => {
      root.render(
        <RoutingBacktestCard
          subject={{
            kind: 'organization',
            orgId: 'org-1',
            scope: 'organization',
          }}
          rangeMs={30 * 24 * 60 * 60 * 1000}
          rangeLabel="Last 30 days"
          billingHref="/organization/org-1/settings?tab=billing"
        />,
      );
    });
  }

  const byTestId = (id: string): HTMLElement | null =>
    document.querySelector(`[data-testid="${id}"]`);

  it('renders nothing when the feature is off', async () => {
    lookupRoutingBacktest.mockResolvedValue({
      backtest: null,
      estimate: null,
      unavailableReason: 'feature_disabled',
    });
    await render();
    expect(byTestId('routing-backtest-card')).toBeNull();
  });

  it('shows why a run is unavailable', async () => {
    lookupRoutingBacktest.mockResolvedValue({
      backtest: null,
      estimate: null,
      unavailableReason: 'transcripts_disabled',
    });
    await render();
    expect(byTestId('routing-backtest-unavailable')?.textContent).toContain(
      'Transcript sync is off',
    );
  });

  it('opens billing instead of starting when credits are short', async () => {
    lookupRoutingBacktest.mockResolvedValue({
      backtest: null,
      estimate: { ...ESTIMATE, balanceSufficient: false },
      unavailableReason: null,
    });
    await render();
    expect(byTestId('routing-backtest-run')).toBeNull();
    expect(byTestId('routing-backtest-add-credits')?.getAttribute('href')).toBe(
      '/organization/org-1/settings?tab=billing',
    );
  });

  it('confirms with the cost estimate, starts a run, and shows progress', async () => {
    lookupRoutingBacktest.mockResolvedValue({
      backtest: null,
      estimate: ESTIMATE,
      unavailableReason: null,
    });
    createRoutingBacktest.mockResolvedValue({ backtest: run(), cached: false });
    await render();

    await act(async () => {
      byTestId('routing-backtest-run')?.click();
    });
    expect(byTestId('routing-backtest-cost-estimate')?.textContent).toContain(
      '2,000',
    );
    await act(async () => {
      byTestId('routing-backtest-mode-full')?.click();
    });
    expect(byTestId('routing-backtest-cost-estimate')?.textContent).toContain(
      '4,000',
    );
    await act(async () => {
      byTestId('routing-backtest-confirm-start')?.click();
    });
    expect(createRoutingBacktest).toHaveBeenCalledWith(
      SETTINGS_CLIENT,
      { kind: 'organization', orgId: 'org-1', scope: 'organization' },
      expect.objectContaining({ startIso: ANY_STRING }),
      'full',
    );
    expect(byTestId('routing-backtest-confirm')).toBeNull();
    expect(byTestId('routing-backtest-progress')).not.toBeNull();
  });

  it('shows the credits error inside the dialog when the start is refused', async () => {
    lookupRoutingBacktest.mockResolvedValue({
      backtest: null,
      estimate: ESTIMATE,
      unavailableReason: null,
    });
    const { TeamApiError } = jest.requireMock<{
      TeamApiError: new (
        status: number,
        serverDetail?: string,
        code?: string,
      ) => Error;
    }>('../../team-api');
    createRoutingBacktest.mockRejectedValue(
      new TeamApiError(402, 'Payment required', 'insufficient_credits'),
    );
    await render();
    await act(async () => {
      byTestId('routing-backtest-run')?.click();
    });
    await act(async () => {
      byTestId('routing-backtest-confirm-start')?.click();
    });
    expect(byTestId('routing-backtest-confirm-error')?.textContent).toContain(
      'Add AI Credits',
    );
  });

  it('shows generic start copy, never the route text, for an unknown refusal', async () => {
    lookupRoutingBacktest.mockResolvedValue({
      backtest: null,
      estimate: ESTIMATE,
      unavailableReason: null,
    });
    const { TeamApiError } = jest.requireMock<{
      TeamApiError: new (
        status: number,
        serverDetail?: string,
        code?: string,
      ) => Error;
    }>('../../team-api');
    createRoutingBacktest.mockRejectedValue(
      new TeamApiError(500, 'SENTINEL-SERVER-BODY'),
    );
    await render();
    await act(async () => {
      byTestId('routing-backtest-run')?.click();
    });
    await act(async () => {
      byTestId('routing-backtest-confirm-start')?.click();
    });
    expect(byTestId('routing-backtest-confirm-error')?.textContent).toContain(
      "Couldn't start the estimate. Try again.",
    );
    expect(document.body.textContent).not.toContain('SENTINEL-SERVER-BODY');
  });

  it('shows load copy, never the route text, and Try again reloads', async () => {
    const { TeamApiError } = jest.requireMock<{
      TeamApiError: new (
        status: number,
        serverDetail?: string,
        code?: string,
      ) => Error;
    }>('../../team-api');
    lookupRoutingBacktest.mockRejectedValueOnce(
      new TeamApiError(500, 'SENTINEL-SERVER-BODY'),
    );
    lookupRoutingBacktest.mockResolvedValue({
      backtest: null,
      estimate: ESTIMATE,
      unavailableReason: null,
    });
    await render();
    expect(byTestId('routing-backtest-error')?.textContent).toContain(
      "Couldn't load this.",
    );
    expect(document.body.textContent).not.toContain('SENTINEL-SERVER-BODY');

    await act(async () => {
      byTestId('routing-backtest-retry')?.click();
    });
    expect(lookupRoutingBacktest).toHaveBeenCalledTimes(2);
    expect(byTestId('routing-backtest-error')).toBeNull();
    expect(byTestId('routing-backtest-run')).not.toBeNull();
  });

  it('renders tiles, charts, and coverage for a cached result', async () => {
    lookupRoutingBacktest.mockResolvedValue({
      backtest: run({
        status: 'succeeded',
        result: {
          baselineCostUsd: 100,
          autoCostUsd: 62,
          routingCostUsd: 0.5,
          savingsUsd: 38,
          savingsFraction: 0.38,
          savingsLowUsd: 30,
          savingsHighUsd: 45,
          coverageTurnCount: 48_210,
          eligibleTurnCount: 30_000,
          replayedTurnCount: 1_940,
          keptForCacheShare: 0.12,
          subscriptionLaneShare: 0.2,
          pricingRevision: 'r1',
          bucketGranularity: 'week',
          series: [],
          modelShare: [],
          shifts: [
            {
              fromModelId: 'anthropic/claude-opus-5',
              toModelId: 'anthropic/claude-sonnet-5',
              turnCount: 700,
              baselineCostUsd: 60,
            },
          ],
        },
      }),
      estimate: ESTIMATE,
      unavailableReason: null,
    });
    await render();
    expect(byTestId('usage-card-backtestSaved-value')?.textContent).toBe('38%');
    expect(byTestId('usage-card-backtestSpent')?.textContent).toContain(
      'Last 30 days',
    );
    expect(byTestId('routing-backtest-spend-chart')).not.toBeNull();
    expect(byTestId('routing-backtest-model-share-chart')).not.toBeNull();
    expect(byTestId('routing-backtest-spend-description')?.textContent).toBe(
      'Actual spend versus the estimate with model routing',
    );
    expect(
      byTestId('routing-backtest-model-share-description')?.textContent,
    ).toBe('The share of activity handled by each model with model routing.');
    // The results end at the details table: no coverage footnotes, share
    // image exports, or follow-up link.
    expect(byTestId('routing-backtest-coverage')).toBeNull();
    expect(byTestId('routing-backtest-subscription-note')).toBeNull();
    expect(byTestId('routing-backtest-export-spend')).toBeNull();
    expect(byTestId('routing-backtest-export-models')).toBeNull();
    expect(byTestId('routing-backtest-enable-auto')).toBeNull();
    expect(byTestId('routing-backtest-details')?.textContent).toContain(
      'claude-sonnet-5',
    );
  });

  it('holds the bar at zero with a spinner while the run prepares', async () => {
    lookupRoutingBacktest.mockResolvedValue({
      backtest: run({ status: 'queued' }),
      estimate: ESTIMATE,
      unavailableReason: null,
    });
    await render();
    const progress = byTestId('routing-backtest-progress');
    expect(progress?.getAttribute('data-stage')).toBe('preparing');
    expect(byTestId('routing-backtest-progress-status')?.textContent).toBe(
      'Preparing the data…',
    );
    expect(progress?.querySelector('[aria-label="Thinking"]')).not.toBeNull();
    const bar = progress?.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('0');
    expect(bar?.firstElementChild?.getAttribute('style')).toContain(
      'width: 0%',
    );
    expect(byTestId('routing-backtest-progress-count')).toBeNull();
  });

  it('glides the turn count to each poll’s value', async () => {
    jest.useFakeTimers();
    try {
      lookupRoutingBacktest.mockResolvedValue({
        backtest: run({
          status: 'running',
          progress: { replayedTurnCount: 400, plannedTurnCount: 2_000 },
        }),
        estimate: ESTIMATE,
        unavailableReason: null,
      });
      getRoutingBacktest.mockResolvedValue(
        run({
          status: 'running',
          progress: { replayedTurnCount: 1_000, plannedTurnCount: 2_000 },
        }),
      );
      await render();
      expect(byTestId('routing-backtest-progress-status')?.textContent).toBe(
        'Replaying conversations through model routing…',
      );
      expect(byTestId('routing-backtest-progress-count')?.textContent).toBe(
        '400 of 2,000 turns',
      );
      await act(async () => {
        jest.advanceTimersByTime(3_000);
      });
      // The bar takes the new value at once; only the counter glides.
      expect(
        byTestId('routing-backtest-progress')
          ?.querySelector('[role="progressbar"]')
          ?.getAttribute('aria-valuenow'),
      ).toBe('50');
      await act(async () => {
        jest.advanceTimersByTime(300);
      });
      const midway = byTestId('routing-backtest-progress-count')?.textContent;
      expect(midway).not.toBe('400 of 2,000 turns');
      expect(midway).not.toBe('1,000 of 2,000 turns');
      await act(async () => {
        jest.advanceTimersByTime(1_000);
      });
      expect(byTestId('routing-backtest-progress-count')?.textContent).toBe(
        '1,000 of 2,000 turns',
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('slides results in only when a run finishes while the card is open', async () => {
    jest.useFakeTimers();
    try {
      lookupRoutingBacktest.mockResolvedValue({
        backtest: run({
          status: 'running',
          progress: { replayedTurnCount: 1_900, plannedTurnCount: 2_000 },
        }),
        estimate: ESTIMATE,
        unavailableReason: null,
      });
      getRoutingBacktest.mockResolvedValue(
        run({ status: 'succeeded', result: RESULT }),
      );
      await render();
      await act(async () => {
        jest.advanceTimersByTime(3_000);
      });
      expect(
        byTestId('routing-backtest-results')?.classList.contains(
          'animate-slide-up',
        ),
      ).toBe(true);

      // A later lookup that returns the cached result just shows it.
      lookupRoutingBacktest.mockResolvedValue({
        backtest: run({ status: 'succeeded', result: RESULT }),
        estimate: ESTIMATE,
        unavailableReason: null,
      });
      await act(async () => {
        root.render(
          <RoutingBacktestCard
            subject={{
              kind: 'organization',
              orgId: 'org-1',
              scope: 'organization',
            }}
            rangeMs={7 * 24 * 60 * 60 * 1000}
            rangeLabel="Last 7 days"
            billingHref="/organization/org-1/settings?tab=billing"
          />,
        );
      });
      expect(byTestId('routing-backtest-results')).not.toBeNull();
      expect(
        byTestId('routing-backtest-results')?.classList.contains(
          'animate-slide-up',
        ),
      ).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('drops a poll that lands after the range changes', async () => {
    jest.useFakeTimers();
    try {
      lookupRoutingBacktest.mockResolvedValue({
        backtest: run({ status: 'running' }),
        estimate: ESTIMATE,
        unavailableReason: null,
      });
      let resolvePoll: (value: ModelRoutingBacktestV1) => void = () => {};
      getRoutingBacktest.mockReturnValue(
        new Promise((resolve) => {
          resolvePoll = resolve;
        }),
      );
      await render();
      // The poll goes out for the old range's run...
      await act(async () => {
        jest.advanceTimersByTime(3_000);
      });
      expect(getRoutingBacktest).toHaveBeenCalledTimes(1);

      // ...then the range changes before it answers.
      let resolveLookup: (
        value: ModelRoutingBacktestLookupResponseV1,
      ) => void = () => {};
      lookupRoutingBacktest.mockReturnValue(
        new Promise((resolve) => {
          resolveLookup = resolve;
        }),
      );
      await act(async () => {
        root.render(
          <RoutingBacktestCard
            subject={{
              kind: 'organization',
              orgId: 'org-1',
              scope: 'organization',
            }}
            rangeMs={7 * 24 * 60 * 60 * 1000}
            rangeLabel="Last 7 days"
            billingHref="/organization/org-1/settings?tab=billing"
          />,
        );
      });
      await act(async () => {
        resolvePoll(run({ status: 'succeeded', result: RESULT }));
      });
      await act(async () => {
        resolveLookup({
          backtest: run({ id: 'bt-2', status: 'succeeded', result: RESULT }),
          estimate: ESTIMATE,
          unavailableReason: null,
        });
      });
      expect(byTestId('routing-backtest-results')).not.toBeNull();
      expect(
        byTestId('routing-backtest-results')?.classList.contains(
          'animate-slide-up',
        ),
      ).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('shows a cached result without the finish animation', async () => {
    lookupRoutingBacktest.mockResolvedValue({
      backtest: run({ status: 'succeeded', result: RESULT }),
      estimate: ESTIMATE,
      unavailableReason: null,
    });
    await render();
    expect(
      byTestId('routing-backtest-results')?.classList.contains(
        'animate-slide-up',
      ),
    ).toBe(false);
  });

  it('polls a running run until it finishes', async () => {
    jest.useFakeTimers();
    try {
      lookupRoutingBacktest.mockResolvedValue({
        backtest: run({ status: 'running' }),
        estimate: ESTIMATE,
        unavailableReason: null,
      });
      getRoutingBacktest.mockResolvedValue(
        run({ status: 'failed', failureCode: 'time_limit' }),
      );
      await render();
      expect(byTestId('routing-backtest-progress')).not.toBeNull();
      await act(async () => {
        jest.advanceTimersByTime(3_000);
      });
      expect(getRoutingBacktest).toHaveBeenCalledWith(
        SETTINGS_CLIENT,
        expect.objectContaining({ orgId: 'org-1' }),
        'bt-1',
      );
      expect(byTestId('routing-backtest-failed')?.textContent).toContain(
        'couldn’t finish',
      );
    } finally {
      jest.useRealTimers();
    }
  });
  it('stops polling after repeated failures and offers a retry', async () => {
    jest.useFakeTimers();
    try {
      lookupRoutingBacktest.mockResolvedValue({
        backtest: run({ status: 'running' }),
        estimate: ESTIMATE,
        unavailableReason: null,
      });
      getRoutingBacktest.mockRejectedValue(new Error('Forbidden'));
      await render();
      for (let tick = 0; tick < 8; tick += 1) {
        await act(async () => {
          jest.advanceTimersByTime(3_000);
        });
      }
      expect(getRoutingBacktest).toHaveBeenCalledTimes(5);
      expect(byTestId('routing-backtest-progress')).toBeNull();
      expect(byTestId('routing-backtest-error')?.textContent).toContain(
        'Unable to check on the estimate',
      );
      lookupRoutingBacktest.mockClear();
      await act(async () => {
        byTestId('routing-backtest-retry')?.click();
      });
      expect(lookupRoutingBacktest).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('shows a cached result to a viewer who can’t start a run', async () => {
    lookupRoutingBacktest.mockResolvedValue({
      backtest: run({
        status: 'succeeded',
        result: {
          baselineCostUsd: 100,
          autoCostUsd: 62,
          routingCostUsd: 0.5,
          savingsUsd: 38,
          savingsFraction: 0.38,
          savingsLowUsd: 30,
          savingsHighUsd: 45,
          coverageTurnCount: 48_210,
          eligibleTurnCount: 30_000,
          replayedTurnCount: 1_940,
          keptForCacheShare: 0.12,
          subscriptionLaneShare: 0.2,
          pricingRevision: 'r1',
          bucketGranularity: 'week',
          series: [],
          modelShare: [],
          shifts: [],
        },
      }),
      estimate: null,
      unavailableReason: 'admin_required',
    });
    await render();
    expect(byTestId('usage-card-backtestSaved-value')?.textContent).toBe('38%');
    expect(byTestId('routing-backtest-unavailable')).toBeNull();
  });

  it('asks a non-admin to get an admin to run the estimate', async () => {
    lookupRoutingBacktest.mockResolvedValue({
      backtest: null,
      estimate: null,
      unavailableReason: 'admin_required',
    });
    await render();
    expect(byTestId('routing-backtest-unavailable')?.textContent).toBe(
      'Ask an organization admin to run this estimate.',
    );
    expect(byTestId('routing-backtest-run')).toBeNull();
  });
  it('renders caller controls inside the card and hides them with it', async () => {
    lookupRoutingBacktest.mockResolvedValue({
      backtest: null,
      estimate: ESTIMATE,
      unavailableReason: null,
    });
    await act(async () => {
      root.render(
        <RoutingBacktestCard
          subject={{ kind: 'user' }}
          rangeMs={30 * 24 * 60 * 60 * 1000}
          rangeLabel="Last 30 days"
          billingHref="/account/billing"
          controls={<span data-testid="caller-control">Range</span>}
        />,
      );
    });
    expect(
      byTestId('routing-backtest-card')?.contains(byTestId('caller-control')),
    ).toBe(true);

    lookupRoutingBacktest.mockResolvedValue({
      backtest: null,
      estimate: null,
      unavailableReason: 'feature_disabled',
    });
    await act(async () => {
      root.render(
        <RoutingBacktestCard
          subject={{ kind: 'user' }}
          rangeMs={7 * 24 * 60 * 60 * 1000}
          rangeLabel="Last 7 days"
          billingHref="/account/billing"
          controls={<span data-testid="caller-control">Range</span>}
        />,
      );
    });
    expect(byTestId('caller-control')).toBeNull();
  });
});
