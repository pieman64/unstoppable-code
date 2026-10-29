/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  AgentProviderType,
  AgentUsageOverview,
  ProviderRateLimitSnapshot,
  ProviderUsageSummary,
} from '@canopy/desktop-shared/types';
import { formatUsageLimitTimeLabel } from '@/lib/usage-limit-time-label';
import { useObservabilityStore } from '@/stores/observabilityStore';
import { PlanAccountUsage } from '../PlanAccountUsage';
import { resetUsageRefreshOnOpen } from '../usageRefreshOnOpen';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
  writable: true,
});

const USAGE_UPDATED_AT = '2026-10-13T19:30:00.000Z';
const LAST_UPDATED_AT = '2026-10-13T19:30:00.000Z';
const FIXED_NOW = new Date(2026, 9, 13, 15, 42);
const RETRY_DELAY_MS = 6 * 60 * 1000;

const CLAUDE_RATE_LIMITS: ProviderRateLimitSnapshot[] = [
  {
    limitId: 'five_hour',
    limitName: '5-hour window',
    primary: { usedPercent: 42, resetsAt: '2099-10-14T00:00:00.000Z' },
  },
  {
    limitId: 'seven_day',
    limitName: '7-day window',
    primary: { usedPercent: 61, resetsAt: '2099-10-20T00:00:00.000Z' },
  },
];

interface RateLimitedOptions {
  retryAt?: string;
  lastUpdatedAt?: string;
  omitLastUpdatedAt?: boolean;
  includeRateLimits?: boolean;
}

function rateLimitedClaudeUsage(
  options: RateLimitedOptions = {},
): AgentUsageOverview {
  const includeRateLimits = options.includeRateLimits !== false;
  const provider: ProviderUsageSummary = {
    provider: 'claude',
    authState: 'authenticated',
    hasRemainingLimits: includeRateLimits,
    ...(options.omitLastUpdatedAt
      ? {}
      : { lastUpdatedAt: options.lastUpdatedAt ?? LAST_UPDATED_AT }),
    accountEmail: 'claude@example.com',
    subscriptionLabel: 'Claude Max 20x',
    ...(includeRateLimits ? { rateLimits: CLAUDE_RATE_LIMITS } : {}),
    // The legacy text is retained by main during rollout; rate limiting must
    // take precedence over treating it as an ordinary failed fetch.
    error: 'Claude usage request failed (HTTP 429).',
    errorInfo: {
      kind: 'rate_limited',
      detail: 'Claude returned HTTP 429.',
      ...(options.retryAt === undefined ? {} : { retryAt: options.retryAt }),
    },
  };

  return { updatedAt: USAGE_UPDATED_AT, providers: [provider] };
}

function providerUsage(provider: ProviderUsageSummary): AgentUsageOverview {
  return { updatedAt: USAGE_UPDATED_AT, providers: [provider] };
}

function claudeProvider(
  overrides: Partial<ProviderUsageSummary> = {},
): ProviderUsageSummary {
  return {
    provider: 'claude',
    authState: 'authenticated',
    hasRemainingLimits: true,
    ...overrides,
  };
}

function formatTime(at: string): string {
  const label = formatUsageLimitTimeLabel(at);
  if (!label) {
    throw new Error(`Expected a formatted time for ${at}`);
  }
  return label;
}

describe('PlanAccountUsage', () => {
  let container: HTMLDivElement;
  let root: Root | undefined;

  const initialize = jest.fn<Promise<void>, []>();
  const refreshProviderUsageDetails = jest.fn<
    Promise<AgentUsageOverview>,
    [AgentProviderType]
  >();

  beforeEach(() => {
    resetUsageRefreshOnOpen();
    initialize.mockReset();
    initialize.mockResolvedValue(undefined);
    refreshProviderUsageDetails.mockReset();
    refreshProviderUsageDetails.mockResolvedValue({
      updatedAt: USAGE_UPDATED_AT,
      providers: [],
    });
    useObservabilityStore.setState({
      initialized: true,
      usage: { updatedAt: USAGE_UPDATED_AT, providers: [] },
      refreshingProviders: new Set<AgentProviderType>(),
      initialize,
      refreshProviderUsageDetails,
    });

    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  function unmount(): void {
    if (!root) return;
    const mountedRoot = root;
    root = undefined;
    act(() => mountedRoot.unmount());
  }

  afterEach(() => {
    unmount();
    container.remove();
    jest.useRealTimers();
  });

  async function render(provider: 'claude' | 'codex'): Promise<void> {
    if (!root) {
      throw new Error('Expected a mounted React root');
    }
    const mountedRoot = root;
    act(() => {
      mountedRoot.render(<PlanAccountUsage provider={provider} />);
    });
    // PlanAccountUsage initializes account data on mount. Let the resolved
    // test promise settle so timer cleanup assertions cover that effect.
    await Promise.resolve();
  }

  function account(): HTMLElement {
    const element = container.querySelector<HTMLElement>(
      '[data-testid="usage-indicator-account"]',
    );
    if (!element) {
      throw new Error('Expected the provider account summary');
    }
    return element;
  }

  function statusText(): string {
    const status = account().querySelector('[role="status"]');
    if (!status) {
      throw new Error('Expected an account status message');
    }
    return status.textContent ?? '';
  }

  function retryButton(): HTMLButtonElement | null {
    return account().querySelector<HTMLButtonElement>(
      '[data-testid="usage-indicator-retry"]',
    );
  }

  function expectClaudeLimitsVisible(): void {
    expect(account().textContent).toContain('5-hour window');
    expect(account().textContent).toContain('7-day window');
    expect(account().textContent).toContain('42%');
    expect(account().textContent).toContain('61%');
  }

  it('keeps the last Claude limits visible and unlocks retry at retryAt', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(FIXED_NOW);
    const retryAt = new Date(
      FIXED_NOW.getTime() + RETRY_DELAY_MS,
    ).toISOString();
    useObservabilityStore.setState({
      usage: rateLimitedClaudeUsage({ retryAt }),
    });

    await render('claude');

    expectClaudeLimitsVisible();
    expect(statusText()).toContain(
      `Claude is limiting usage checks. Showing limits from ${formatTime(
        LAST_UPDATED_AT,
      )}; checking again after ${formatTime(retryAt)}.`,
    );
    expect(statusText()).toContain('limiting usage checks');
    expect(statusText()).not.toContain('Claude plan limits are unavailable.');
    expect(retryButton()).toBeNull();

    const callsBeforeRetry = refreshProviderUsageDetails.mock.calls.length;
    act(() => {
      jest.advanceTimersByTime(RETRY_DELAY_MS);
    });
    const retry = retryButton();
    expect(retry?.textContent).toBe('Try again');
    act(() => retry?.click());
    expect(refreshProviderUsageDetails).toHaveBeenCalledTimes(
      callsBeforeRetry + 1,
    );
    expect(refreshProviderUsageDetails).toHaveBeenLastCalledWith('claude');
  });

  it.each([
    ['has passed', new Date(Date.now() - 60_000).toISOString()],
    ['is absent', undefined],
  ])(
    'keeps limits and offers retry immediately when retryAt %s',
    async (_description, retryAt) => {
      useObservabilityStore.setState({
        usage: rateLimitedClaudeUsage({ retryAt }),
      });

      await render('claude');

      expectClaudeLimitsVisible();
      expect(statusText()).toContain(
        `Claude is limiting usage checks. Showing limits from ${formatTime(
          LAST_UPDATED_AT,
        )}.`,
      );
      expect(statusText()).toContain('limiting usage checks');
      expect(retryButton()?.textContent).toBe('Try again');
    },
  );

  it.each([
    ['is omitted', { omitLastUpdatedAt: true }],
    ['is unusable', { lastUpdatedAt: 'not-a-time' }],
  ])(
    'uses fallback copy when lastUpdatedAt %s',
    async (_description, options) => {
      useObservabilityStore.setState({
        usage: rateLimitedClaudeUsage(options),
      });

      await render('claude');

      expectClaudeLimitsVisible();
      expect(statusText()).toContain(
        'Claude is limiting usage checks. Showing the last limits Claude reported.',
      );
      expect(statusText()).not.toContain('Showing limits from');
    },
  );

  it('explains a future retry on a cold start and reveals retry without interaction', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(FIXED_NOW);
    const retryAt = new Date(
      FIXED_NOW.getTime() + RETRY_DELAY_MS,
    ).toISOString();
    useObservabilityStore.setState({
      usage: rateLimitedClaudeUsage({ retryAt, includeRateLimits: false }),
    });

    await render('claude');

    expect(statusText()).toContain(
      `Claude is limiting usage checks. Checking again after ${formatTime(
        retryAt,
      )}.`,
    );
    expect(statusText()).toContain('limiting usage checks');
    expect(account().textContent).not.toMatch(/\b\d+(?:\.\d+)?%/);
    expect(retryButton()).toBeNull();

    act(() => {
      jest.advanceTimersByTime(RETRY_DELAY_MS);
    });
    expect(retryButton()?.textContent).toBe('Try again');
  });

  it.each([
    ['has passed', new Date(Date.now() - 60_000).toISOString()],
    ['is absent', undefined],
  ])(
    'offers an immediate retry on a cold start when retryAt %s',
    async (_description, retryAt) => {
      useObservabilityStore.setState({
        usage: rateLimitedClaudeUsage({
          retryAt,
          includeRateLimits: false,
        }),
      });

      await render('claude');

      expect(statusText()).toContain('Claude is limiting usage checks.');
      expect(account().textContent).not.toMatch(/\b\d+(?:\.\d+)?%/);
      expect(retryButton()?.textContent).toBe('Try again');
    },
  );

  it('clears the pending retry deadline timer when unmounted', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(FIXED_NOW);
    const retryAt = new Date(
      FIXED_NOW.getTime() + RETRY_DELAY_MS,
    ).toISOString();
    useObservabilityStore.setState({
      usage: rateLimitedClaudeUsage({ retryAt }),
    });

    await render('claude');

    unmount();
    await Promise.resolve();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps auth errors ahead of usage errors and does not offer retry', async () => {
    useObservabilityStore.setState({
      usage: providerUsage(
        claudeProvider({
          errorInfo: { kind: 'auth' },
          rateLimits: CLAUDE_RATE_LIMITS,
        }),
      ),
    });

    await render('claude');

    expect(statusText()).toContain('Sign in to Claude to see plan limits.');
    expect(retryButton()).toBeNull();
    expect(account().textContent).not.toContain('42%');
  });

  it('requires sign-in when Claude is unauthenticated', async () => {
    useObservabilityStore.setState({
      usage: providerUsage({
        provider: 'claude',
        authState: 'unauthenticated',
        hasRemainingLimits: true,
        errorInfo: { kind: 'network' },
        rateLimits: CLAUDE_RATE_LIMITS,
      }),
    });

    await render('claude');

    expect(statusText()).toContain('Sign in to Claude to see plan limits.');
    expect(retryButton()).toBeNull();
    expect(account().textContent).not.toContain('42%');
  });

  it('does not offer retry when Claude does not report plan limits', async () => {
    useObservabilityStore.setState({
      usage: providerUsage(
        claudeProvider({
          errorInfo: { kind: 'unsupported' },
          rateLimits: CLAUDE_RATE_LIMITS,
        }),
      ),
    });

    await render('claude');

    expect(statusText()).toContain(
      "Claude doesn't report plan limits for this account.",
    );
    expect(retryButton()).toBeNull();
    expect(account().textContent).not.toContain('42%');
  });

  it('keeps ordinary Claude service errors unavailable with hidden limits and retry', async () => {
    useObservabilityStore.setState({
      usage: providerUsage(
        claudeProvider({
          errorInfo: { kind: 'service' },
          rateLimits: CLAUDE_RATE_LIMITS,
        }),
      ),
    });

    await render('claude');

    expect(statusText()).toContain('Claude plan limits are unavailable.');
    expect(account().textContent).not.toContain('42%');
    expect(account().textContent).not.toContain('61%');
    expect(retryButton()?.textContent).toBe('Try again');
    const callsBeforeRetry = refreshProviderUsageDetails.mock.calls.length;
    const retry = retryButton();
    act(() => retry?.click());
    expect(refreshProviderUsageDetails).toHaveBeenCalledTimes(
      callsBeforeRetry + 1,
    );
  });

  it('shows healthy Claude limits without status or retry', async () => {
    useObservabilityStore.setState({
      usage: providerUsage(claudeProvider({ rateLimits: CLAUDE_RATE_LIMITS })),
    });

    await render('claude');

    expectClaudeLimitsVisible();
    expect(account().querySelector('[role="status"]')).toBeNull();
    expect(retryButton()).toBeNull();
  });

  it('preserves Codex network-error behavior', async () => {
    useObservabilityStore.setState({
      usage: providerUsage({
        provider: 'codex',
        authState: 'authenticated',
        hasRemainingLimits: true,
        errorInfo: { kind: 'network' },
        rateLimits: [
          {
            limitId: 'codex-window',
            primary: { usedPercent: 35, resetsAt: '2099-10-14T00:00:00.000Z' },
          },
        ],
      }),
    });

    await render('codex');

    expect(statusText()).toContain('Codex plan limits are unavailable.');
    expect(account().textContent).not.toContain('35%');
    expect(retryButton()?.textContent).toBe('Try again');
  });
});
