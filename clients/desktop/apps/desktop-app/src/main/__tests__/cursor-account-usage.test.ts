import type { CursorConnectionStatus } from '@canopy/desktop-shared/types';
const mockStatus = jest.fn<Promise<CursorConnectionStatus>, []>();
const mockManaged = jest.fn();
const mockCommand = jest.fn();
const mockToken = jest.fn();
const mockEnabled = jest.fn(() => true);
jest.mock('../cursor/runtime-status', () => ({
  cursorConnectionStatus: mockStatus,
}));
jest.mock('../cursor/connection', () => ({
  getManagedCursorRuntime: mockManaged,
}));
jest.mock('@canopy/desktop-shared/node/cursor/runtime-process', () => ({
  runCursorRuntimeCommand: mockCommand,
}));
jest.mock('../cursor/account-credentials', () => ({
  readCursorAccessToken: mockToken,
}));
jest.mock('../cursor/feature-flag', () => ({
  isCursorHarnessEnabled: mockEnabled,
}));
jest.mock('../lib/e2e-mock-control-plane', () => ({
  getMockLlmOrigin: (): null => null,
}));

import { readCursorAccountUsage } from '../cursor/account-usage';
import { cursorUsageRateLimits } from '../cursor/account-usage-data';

function partial(value: Record<string, unknown>): unknown {
  return expect.objectContaining(value);
}

function requestUrl(value: RequestInfo | URL): string {
  return typeof value === 'string'
    ? value
    : value instanceof URL
      ? value.href
      : value.url;
}

const cycle = {
  billingCycleStart: '1789268163000',
  billingCycleEnd: '1791860163000',
};
const usage = {
  ...cycle,
  enabled: true,
  planUsage: {
    totalPercentUsed: 75,
    autoPercentUsed: 12.5,
    apiPercentUsed: 0,
    includedSpend: 1500,
    remaining: 500,
    limit: 2000,
  },
};

describe('Cursor account allowance normalization', () => {
  it('preserves native percentages, currency cents, zero, and actual billing windows', () => {
    const limits = cursorUsageRateLimits(usage, {});
    expect(limits[0]).toEqual(
      partial({
        limitId: 'cursor-plan',
        limitName: 'Included usage',
        primary: {
          usedPercent: 75,
          resetsAt: '2026-10-13T02:56:03.000Z',
          windowDurationMins: 43200,
        },
        credits: { totalUsd: 20, remainingUsd: 5 },
      }),
    );
    expect(
      limits.find((entry) => entry.limitId === 'cursor-api')?.primary
        ?.usedPercent,
    ).toBe(0);
  });
  it('does not fabricate optional percentages or a context limit', () => {
    expect(
      cursorUsageRateLimits(
        { ...cycle, planUsage: { includedSpend: 100, limit: 2000 } },
        {},
      ),
    ).toEqual([
      partial({
        limitId: 'cursor-plan',
        primary: partial({ usedPercent: 5 }),
      }),
    ]);
    expect(cursorUsageRateLimits({}, {})).toEqual([]);
    expect(cursorUsageRateLimits({ planUsage: {} }, {})).toEqual([]);
  });
  it('decodes omitted non-optional protobuf scalars as zero but preserves optional absence', () => {
    // Pinned GetCurrentPeriodUsageResponse: PlanUsage #2/#4 and
    // SpendLimitUsage #6 are int32 with no presence; percentages are optional.
    const included = cursorUsageRateLimits({ planUsage: { limit: 2000 } }, {});
    expect(included).toHaveLength(1);
    expect(included[0]?.primary?.usedPercent).toBe(0);
    expect(included[0]?.credits).toEqual({ totalUsd: 20, remainingUsd: 0 });
    const onDemand = cursorUsageRateLimits({ spendLimitUsage: {} }, {});
    expect(onDemand[0]?.credits).toEqual({ usedUsd: 0 });
    expect(onDemand[0]?.primary?.usedPercent).toBeUndefined();
    expect(cursorUsageRateLimits({}, {})).toEqual([]);
  });
  it('prefers a valid usage reset and rejects invalid fallback timestamps', () => {
    expect(
      cursorUsageRateLimits(usage, {}, { billingCycleEnd: '1794538563000' })[0]
        ?.primary?.resetsAt,
    ).toBe('2026-10-13T02:56:03.000Z');
    expect(
      cursorUsageRateLimits(
        { planUsage: { totalPercentUsed: 10 } },
        {},
        { billingCycleEnd: 'invalid' },
      )[0]?.primary?.resetsAt,
    ).toBeUndefined();
  });
  it('keeps over-limit percentages and rejects nonfinite/negative/malformed counters', () => {
    expect(
      cursorUsageRateLimits({ planUsage: { totalPercentUsed: 115 } }, {})[0]
        ?.primary?.usedPercent,
    ).toBe(115);
    expect(
      cursorUsageRateLimits(
        {
          planUsage: {
            totalPercentUsed: NaN,
            autoPercentUsed: -2,
            apiPercentUsed: '80',
            limit: Infinity,
          },
        },
        {},
      ),
    ).toEqual([]);
  });
  it('uses dollar hard limits for personal on-demand and cent limits for team members', () => {
    const personal = cursorUsageRateLimits(
      {
        ...cycle,
        spendLimitUsage: { individualUsed: 1250, limitType: 'user' },
      },
      { hardLimit: 50 },
    );
    expect(personal[0]).toEqual(
      partial({
        limitId: 'cursor-on-demand',
        primary: partial({ usedPercent: 25 }),
        credits: { usedUsd: 12.5, totalUsd: 50, remainingUsd: 37.5 },
      }),
    );
    const team = cursorUsageRateLimits(
      {
        ...cycle,
        spendLimitUsage: {
          individualUsed: 500,
          individualLimit: 2000,
          limitType: 'team',
        },
      },
      { hardLimit: 1000 },
    );
    expect(team[0]?.credits).toEqual({
      usedUsd: 5,
      totalUsd: 20,
      remainingUsd: 15,
    });
  });
  it('never turns disabled or unlimited on-demand into a blocking quota', () => {
    for (const hardLimit of [
      { hardLimit: 50, noUsageBasedAllowed: true },
      { hardLimit: 2147483647 },
      {},
    ]) {
      expect(
        cursorUsageRateLimits(
          { spendLimitUsage: { individualUsed: 200 } },
          hardLimit,
        ).some((entry) => entry.primary?.usedPercent !== undefined),
      ).toBe(false);
    }
  });
});

describe('Cursor authenticated usage read', () => {
  const originalFetch = global.fetch;
  const fetchMock = jest.fn<
    Promise<Response>,
    [RequestInfo | URL, RequestInit?]
  >();
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnabled.mockReturnValue(true);
    mockStatus.mockResolvedValue({
      supported: true,
      installed: true,
      enabled: true,
      version: 'test',
      phase: 'connected',
    });
    mockManaged.mockResolvedValue({
      launch: { command: 'cursor-agent', prefix: [] },
      env: { HOME: '/private' },
    });
    mockCommand.mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({
        isAuthenticated: true,
        userInfo: { userId: 'account-one', email: 'one@example.com' },
      }),
    });
    mockToken.mockResolvedValue('private-test-access-token');
    fetchMock.mockImplementation((url) => {
      const method = requestUrl(url).split('/').pop();
      const bodies: Record<string, unknown> = {
        GetMe: { userId: 'account-one', email: 'one@example.com' },
        GetCurrentPeriodUsage: usage,
        GetPlanInfo: { planInfo: { planName: 'Pro' } },
        GetHardLimit: {},
      };
      return Promise.resolve(
        new Response(JSON.stringify(bodies[method ?? '']), { status: 200 }),
      );
    });
    global.fetch = fetchMock;
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });
  it('uses the existing managed sign-in for bounded read-only Cursor dashboard calls', async () => {
    const result = await readCursorAccountUsage(new AbortController().signal);
    expect(result).toEqual(
      partial({
        provider: 'cursor',
        authState: 'authenticated',
        accountEmail: 'one@example.com',
        subscriptionLabel: 'Pro',
        hasRemainingLimits: true,
      }),
    );
    expect(mockCommand).toHaveBeenCalledWith(
      expect.anything(),
      ['status', '--format', 'json'],
      { HOME: '/private' },
      expect.anything(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const [url, options] of fetchMock.mock.calls) {
      expect(requestUrl(url)).toMatch(
        /^https:\/\/api2\.cursor\.sh\/aiserver\.v1\.DashboardService\/Get/,
      );
      expect(options).toEqual(
        partial({
          method: 'POST',
          redirect: 'error',
          body: '{}',
          headers: partial({
            Authorization: 'Bearer private-test-access-token',
          }),
        }),
      );
      expect(options?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(JSON.stringify(result)).not.toContain('private-test-access-token');
  });
  it.each([undefined, '0'])(
    'uses the plan reset when usage billingCycleEnd is %s',
    async (billingCycleEnd) => {
      fetchMock.mockImplementation((url) => {
        const bodies: Record<string, unknown> = {
          GetMe: { userId: 'account-one', email: 'one@example.com' },
          GetCurrentPeriodUsage: { ...usage, billingCycleEnd },
          GetPlanInfo: {
            planInfo: {
              planName: 'Pro',
              billingCycleEnd: cycle.billingCycleEnd,
            },
          },
          GetHardLimit: {},
        };
        return Promise.resolve(
          new Response(
            JSON.stringify(bodies[requestUrl(url).split('/').pop() ?? '']),
          ),
        );
      });
      const result = await readCursorAccountUsage(new AbortController().signal);
      expect(result?.rateLimits?.[0]?.primary?.resetsAt).toBe(
        '2026-10-13T02:56:03.000Z',
      );
    },
  );
  it('does no credential or network work when the rollout or connection is disabled', async () => {
    mockEnabled.mockReturnValue(false);
    expect(
      await readCursorAccountUsage(new AbortController().signal),
    ).toBeNull();
    expect(mockStatus).not.toHaveBeenCalled();
    mockEnabled.mockReturnValue(true);
    mockStatus.mockResolvedValue({
      supported: true,
      installed: true,
      enabled: false,
      version: 'test',
      phase: 'idle',
    });
    expect(
      await readCursorAccountUsage(new AbortController().signal),
    ).toBeNull();
    expect(mockManaged).not.toHaveBeenCalled();
    expect(mockToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('does not launch interactive login for a signed-out account', async () => {
    mockCommand.mockResolvedValue({
      code: 0,
      stdout: '{"isAuthenticated":false}',
    });
    expect(await readCursorAccountUsage(new AbortController().signal)).toEqual(
      partial({
        authState: 'unauthenticated',
        hasRemainingLimits: false,
      }),
    );
    expect(mockToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects counters when the credential identity changed during the status probe', async () => {
    mockCommand.mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({
        isAuthenticated: true,
        userInfo: { userId: 'old-account', email: 'old@example.com' },
      }),
    });
    const result = await readCursorAccountUsage(new AbortController().signal);
    expect(result?.rateLimits).toBeUndefined();
    expect(result?.accountEmail).toBeUndefined();
    expect(result?.errorInfo?.kind).toBe('auth');
  });
  it('retains account identity when plan usage is unavailable without reporting zero', async () => {
    fetchMock.mockImplementation((url) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            requestUrl(url).endsWith('GetMe')
              ? { userId: 'account-one', email: 'one@example.com' }
              : {},
          ),
        ),
      ),
    );
    const result = await readCursorAccountUsage(new AbortController().signal);
    expect(result).toEqual(
      partial({
        authState: 'authenticated',
        accountEmail: 'one@example.com',
        hasRemainingLimits: false,
        errorInfo: partial({ kind: 'unsupported' }),
      }),
    );
    expect(result?.rateLimits).toBeUndefined();
  });
  it.each([401, 403, 429, 500])(
    'handles HTTP %i without exposing credentials or provider response bodies',
    async (status) => {
      fetchMock.mockResolvedValue(
        new Response('private-test-access-token sensitive-body', { status }),
      );
      const result = await readCursorAccountUsage(new AbortController().signal);
      expect(result?.hasRemainingLimits).toBe(false);
      expect(result?.errorInfo?.kind).toBe(
        status === 401 || status === 403 ? 'auth' : 'service',
      );
      expect(JSON.stringify(result)).not.toMatch(
        /private-test-access-token|sensitive-body/,
      );
    },
  );
  it('discards a completed response if Cursor is disabled while the fetch is pending', async () => {
    fetchMock.mockImplementation(() => {
      mockEnabled.mockReturnValue(false);
      return Promise.resolve(new Response('{}'));
    });
    expect(
      await readCursorAccountUsage(new AbortController().signal),
    ).toBeNull();
  });
  it('preserves available usage when optional plan lookup fails', async () => {
    const fetchCurrent = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url, options) => {
      if (requestUrl(url).endsWith('GetPlanInfo'))
        return new Response('{}', { status: 500 });
      if (!fetchCurrent) throw new Error('Missing fixture');
      return fetchCurrent(url, options);
    });
    const result = await readCursorAccountUsage(new AbortController().signal);
    expect(result).toEqual(
      partial({
        hasRemainingLimits: true,
      }),
    );
    expect(Array.isArray(result?.rateLimits)).toBe(true);
  });
  it.each(['invalid json', '[]', ' '.repeat(1024 * 1024 + 1)])(
    'rejects malformed or oversized usage without leaking raw data',
    async (payload) => {
      fetchMock.mockResolvedValue(new Response(payload));
      expect(
        (await readCursorAccountUsage(new AbortController().signal))?.errorInfo
          ?.kind,
      ).toBe('service');
    },
  );
  it('reports a timed-out request as unavailable network data', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(() => {
      const error = new Error('Timeout');
      error.name = 'TimeoutError';
      controller.abort(error);
      return Promise.reject(error);
    });
    expect(
      (await readCursorAccountUsage(controller.signal))?.errorInfo?.kind,
    ).toBe('network');
  });
});
