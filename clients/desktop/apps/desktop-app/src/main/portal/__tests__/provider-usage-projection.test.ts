import type {
  AccountProxyAccount,
  AccountProxyStatus,
  AgentObservabilityUpdateEvent,
  AgentUsageOverview,
  PortalEventEnvelope,
  ProviderRateLimitSnapshot,
  ProviderUsageErrorInfo,
  ProviderUsageSummary,
} from '@canopy/desktop-shared/types';
import type { PortalCommandEnvelope } from '@canopy/protocol/portal';
import type { PortalAdapterContext } from '../adapters/types';

const mockListeners = new Set<(event: AgentObservabilityUpdateEvent) => void>();
const mockAccountProxyListeners = new Set<() => void>();
const mockAiCreditsRoutingListeners = new Set<() => void>();
const mockGetUsageOverview = jest.fn<AgentUsageOverview, []>();
type AccountProxyStatusReadOptions = {
  refresh?: boolean;
  refreshUsage?: boolean;
};
const mockGetAccountProxyStatus = jest.fn<
  Promise<AccountProxyStatus>,
  [AccountProxyStatusReadOptions]
>();
const mockIsAiCreditsChosenOverAccountProxy = jest.fn<boolean, [undefined]>();
const mockRefreshProviderUsage = jest.fn<
  Promise<void>,
  [string, { joinInFlight: boolean }]
>();
const mockRefreshAccountProxyUsage = jest.fn<
  Promise<void>,
  [{ interactive: boolean; provider: 'claude' | 'codex' }]
>();
jest.mock('../../observability', (): unknown => ({
  getObservabilityService: () => ({
    getUsageOverview: mockGetUsageOverview,
    refreshProviderUsage: mockRefreshProviderUsage,
    refreshAccountProxyUsage: mockRefreshAccountProxyUsage,
    subscribe: (
      listener: (event: AgentObservabilityUpdateEvent) => void,
    ): (() => void) => {
      mockListeners.add(listener);
      return (): void => {
        mockListeners.delete(listener);
      };
    },
  }),
}));
// Keep these service seams in one place; the status reader is intentionally
// async and non-refreshing for Portal projection, while the listener mocks
// provide routing/account-list change notifications.
jest.mock('../../account-proxy/service', (): unknown => ({
  get getAccountProxyStatus(): typeof mockGetAccountProxyStatus {
    return mockGetAccountProxyStatus;
  },
  onAccountProxyInventoryChanged: (listener: () => void): (() => void) => {
    mockAccountProxyListeners.add(listener);
    return (): void => {
      mockAccountProxyListeners.delete(listener);
    };
  },
}));
jest.mock('../../agents/ai-credits-routing', (): unknown => ({
  get isAiCreditsChosenOverAccountProxy(): typeof mockIsAiCreditsChosenOverAccountProxy {
    return mockIsAiCreditsChosenOverAccountProxy;
  },
  subscribeAiCreditsRoutingModeChanges: (
    listener: () => void,
  ): (() => void) => {
    mockAiCreditsRoutingListeners.add(listener);
    return (): void => {
      mockAiCreditsRoutingListeners.delete(listener);
    };
  },
}));
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessError: jest.fn(),
}));

import { handlePortalProviderUsageRefresh } from '../adapters/provider-usage-adapter';
import {
  listPortalProviderUsageEntities,
  projectPortalProviderUsage,
  subscribePortalProviderUsage,
} from '../provider-usage-projection';

type AccountProxyUsageFixture = {
  rateLimits: ProviderRateLimitSnapshot[];
  source: 'live' | 'passive';
  lastUpdatedAt?: string;
  errorInfo?: ProviderUsageErrorInfo;
  retryAt?: number;
};

type ProxyAccountFixture = AccountProxyAccount & {
  usage?: AccountProxyUsageFixture;
  connectionId?: string;
  key?: string;
};

function accountProxyUsage(
  overrides: Partial<AccountProxyStatus> = {},
  accounts: readonly ProxyAccountFixture[] = [],
): AccountProxyStatus {
  return {
    available: true,
    connection: {
      id: 'proxy-connection-private',
      kind: 'server',
      url: 'https://proxy-private.example',
    },
    state: 'connected',
    error: null,
    version: '1.0.0',
    accounts,
    routing: { strategy: 'round-robin', sessionAffinity: null },
    keepChatOnOneAccount: true,
    routeClaude: true,
    routeCodex: true,
    refreshedAt: Date.parse('2026-10-20T16:00:00.000Z'),
    local: {
      phase: 'stopped',
      version: null,
      install: null,
      port: null,
      startWithApp: true,
      message: null,
    },
    signIn: null,
    ...overrides,
  };
}

function disconnectedProxy(): AccountProxyStatus {
  return accountProxyUsage({
    available: false,
    connection: null,
    state: 'not-configured',
    routeClaude: false,
    routeCodex: false,
    accounts: [],
  });
}

function proxyAccount(
  input: Partial<ProxyAccountFixture> &
    Pick<ProxyAccountFixture, 'authIndex' | 'provider'>,
): ProxyAccountFixture {
  return {
    label: '',
    source: 'sign-in',
    fileName: null,
    planType: null,
    status: 'active',
    statusMessage: null,
    availableAt: null,
    limits: [],
    ...input,
  };
}

function emitAccountProxyInventoryChange(): void {
  for (const listener of Array.from(mockAccountProxyListeners)) {
    listener();
  }
}

function emitAiCreditsRoutingChange(): void {
  for (const listener of Array.from(mockAiCreditsRoutingListeners)) {
    listener();
  }
}

async function flushProviderUsageProjection(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value) => resolvePromise(value) };
}

beforeEach(() => {
  mockListeners.clear();
  mockAccountProxyListeners.clear();
  mockAiCreditsRoutingListeners.clear();
  mockGetUsageOverview.mockReset();
  mockGetAccountProxyStatus.mockReset();
  mockGetAccountProxyStatus.mockResolvedValue(disconnectedProxy());
  mockIsAiCreditsChosenOverAccountProxy.mockReset();
  mockIsAiCreditsChosenOverAccountProxy.mockReturnValue(false);
  mockRefreshProviderUsage.mockReset();
  mockRefreshProviderUsage.mockResolvedValue(undefined);
  mockRefreshAccountProxyUsage.mockReset();
  mockRefreshAccountProxyUsage.mockResolvedValue(undefined);
});

function overview(providers: ProviderUsageSummary[]): AgentUsageOverview {
  return { updatedAt: '2026-10-04T17:05:00.000Z', providers };
}

function emitUsage(usage: AgentUsageOverview): void {
  for (const listener of Array.from(mockListeners)) {
    listener({ type: 'usage', usage });
  }
}

const signedOutCodex: ProviderUsageSummary = {
  provider: 'codex',
  authState: 'unauthenticated',
  hasRemainingLimits: false,
};

describe('projectPortalProviderUsage (CAN-3635)', () => {
  beforeEach(() => {
    mockListeners.clear();
    mockGetUsageOverview.mockReset();
  });

  it('gives legacy Claude keys the titles and durations of the desktop Usage page', () => {
    const projection = projectPortalProviderUsage(
      overview([
        {
          provider: 'claude',
          authState: 'authenticated',
          hasRemainingLimits: true,
          accountEmail: 'claude-user@example.com',
          subscriptionLabel: 'Claude Pro',
          rateLimits: [
            {
              limitId: 'five_hour',
              limitName: 'Five Hour',
              primary: {
                usedPercent: 10,
                resetsAt: '2026-10-04T20:00:00.000Z',
              },
            },
            {
              limitId: 'seven_day_opus',
              limitName: 'Seven Day Opus',
              primary: { usedPercent: 30 },
            },
          ],
        },
        signedOutCodex,
      ]),
    );

    expect(projection.providers[0]).toEqual({
      provider: 'claude',
      authState: 'authenticated',
      accountEmail: 'claude-user@example.com',
      planLabel: 'Claude Pro',
      windows: [
        {
          id: 'five_hour-primary',
          label: 'Five Hour',
          usedPercent: 10,
          resetsAt: '2026-10-04T20:00:00.000Z',
          windowDurationMs: 5 * 60 * 60 * 1000,
        },
        {
          id: 'seven_day_opus-primary',
          label: 'Seven Day Opus',
          usedPercent: 30,
          windowDurationMs: 7 * 24 * 60 * 60 * 1000,
        },
      ],
    });
  });

  it('keeps Extra usage spend when the provider reports no monthly limit', () => {
    const projection = projectPortalProviderUsage(
      overview([
        {
          provider: 'claude',
          authState: 'authenticated',
          hasRemainingLimits: true,
          rateLimits: [
            {
              limitId: 'extra_usage',
              limitName: 'Extra usage',
              spend: { currency: 'USD', used: 0, isEnabled: true },
            },
          ],
        },
        signedOutCodex,
      ]),
    );

    expect(projection.providers[0]?.windows).toEqual([
      {
        id: 'extra_usage-primary',
        label: 'Extra usage',
        spend: { currency: 'USD', used: 0, isEnabled: true },
      },
    ]);
  });

  it('reports a signed-out Codex without windows or its previous account', () => {
    const projection = projectPortalProviderUsage(
      overview([
        {
          provider: 'codex',
          authState: 'unauthenticated',
          hasRemainingLimits: false,
          lastUpdatedAt: '2026-10-04T17:01:00.000Z',
          accountEmail: 'stale@example.com',
          subscriptionLabel: 'ChatGPT Pro',
          rateLimits: [{ limitId: 'codex', primary: { usedPercent: 5 } }],
        },
      ]),
    );

    expect(projection.providers).toEqual([
      { provider: 'claude', authState: 'unknown', windows: [] },
      {
        provider: 'codex',
        authState: 'unauthenticated',
        lastUpdatedAt: '2026-10-04T17:01:00.000Z',
        windows: [],
      },
    ]);
  });

  it('reports a failed Claude fetch as a classified error with safe copy only', () => {
    const projection = projectPortalProviderUsage(
      overview([
        {
          provider: 'claude',
          authState: 'authenticated',
          hasRemainingLimits: false,
          accountEmail: 'claude-user@example.com',
          error:
            'raw-sentinel 401 from /Users/someone/.claude/.credentials.json',
          errorInfo: {
            kind: 'auth',
            message: 'curated-sentinel /Users/someone/.claude',
            detail: 'detail-sentinel token=secret-sentinel',
          },
          rateLimits: [{ limitId: 'session', primary: { usedPercent: 99 } }],
        },
        {
          provider: 'codex',
          authState: 'unknown',
          hasRemainingLimits: false,
          error: 'failed to fetch codex rate limits: 503 Service Unavailable',
        },
      ]),
    );

    expect(projection.providers).toEqual([
      {
        provider: 'claude',
        authState: 'error',
        accountEmail: 'claude-user@example.com',
        error: {
          kind: 'auth',
          message: 'Sign in to Claude again to see live usage.',
        },
        windows: [],
      },
      {
        provider: 'codex',
        authState: 'error',
        error: {
          kind: 'service',
          message:
            'Codex is not answering right now, so try again in a moment.',
        },
        windows: [],
      },
    ]);
    const wire = JSON.stringify(projection);
    for (const sentinel of [
      'raw-sentinel',
      'curated-sentinel',
      'detail-sentinel',
      'secret-sentinel',
      '/Users/',
    ]) {
      expect(wire).not.toContain(sentinel);
    }
  });

  it('projects retained throttled windows as authenticated without an error', () => {
    const projection = projectPortalProviderUsage(
      overview([
        {
          provider: 'claude',
          authState: 'authenticated',
          hasRemainingLimits: true,
          accountEmail: 'user@example.com',
          lastUpdatedAt: '2026-10-04T16:00:00.000Z',
          rateLimits: [{ limitId: 'session', primary: { usedPercent: 42 } }],
          error: 'raw-throttling-sentinel',
          errorInfo: {
            kind: 'rate_limited',
            retryAt: '2026-10-04T18:00:00.000Z',
            detail: 'private-detail-sentinel',
          },
        },
      ]),
    );

    expect(projection.providers[0]).toMatchObject({
      authState: 'authenticated',
      accountEmail: 'user@example.com',
      lastUpdatedAt: '2026-10-04T16:00:00.000Z',
      windows: [{ usedPercent: 42 }],
    });
    expect(projection.providers[0]).not.toHaveProperty('error');
    expect(JSON.stringify(projection)).not.toContain('sentinel');
  });

  it.each([undefined, []])(
    'projects cold-start throttling without usable windows as a safe service error (%p)',
    (rateLimits) => {
      const projection = projectPortalProviderUsage(
        overview([
          {
            provider: 'claude',
            authState: 'authenticated',
            hasRemainingLimits: false,
            rateLimits,
            errorInfo: { kind: 'rate_limited' },
          },
        ]),
      );

      expect(projection.providers[0]).toEqual({
        provider: 'claude',
        authState: 'error',
        windows: [],
        error: {
          kind: 'service',
          message:
            'Claude is limiting usage checks right now. Try again later.',
        },
      });
    },
  );

  it('keeps window ids stable across reordering and omits malformed values', () => {
    const buckets = [
      {
        limitId: 'codex_other',
        limitName: 'GPT-5 Codex Mini',
        primary: {
          usedPercent: Number.NaN,
          resetsAt: 'not a date',
          windowDurationMins: 90,
        },
      },
      {
        limitId: 'codex',
        limitName: 'Codex',
        primary: { usedPercent: 23, windowDurationMins: 300 },
        secondary: { usedPercent: 61, windowDurationMins: 10_080 },
        credits: { remainingUsd: 0 },
      },
    ];
    const codex = (
      rateLimits: ProviderUsageSummary['rateLimits'],
    ): AgentUsageOverview =>
      overview([
        {
          provider: 'codex',
          authState: 'authenticated',
          hasRemainingLimits: true,
          rateLimits,
        },
      ]);

    const first = projectPortalProviderUsage(codex(buckets)).providers[1];
    const reordered = projectPortalProviderUsage(codex([...buckets].reverse()))
      .providers[1];

    expect(first?.windows.map((window) => window.id)).toEqual([
      'codex-primary',
      'codex-secondary',
      'codex_other-primary',
    ]);
    expect(reordered?.windows).toEqual(first?.windows);
    expect(first?.windows[0]?.credits).toEqual({
      unit: 'credits',
      remaining: 0,
    });
    expect(first?.windows[1]?.credits).toBeUndefined();
    expect(first?.windows[2]).toEqual({
      id: 'codex_other-primary',
      label: '90-minute GPT-5 Codex Mini',
      windowDurationMs: 90 * 60 * 1000,
    });
  });

  it('gives windows without provider ids distinct ids', () => {
    const projection = projectPortalProviderUsage(
      overview([
        {
          provider: 'claude',
          authState: 'authenticated',
          hasRemainingLimits: true,
          rateLimits: [
            { primary: { usedPercent: 1 } },
            { primary: { usedPercent: 2 } },
          ],
        },
      ]),
    );

    expect(projection.providers[0]?.windows.map((window) => window.id)).toEqual(
      ['default-primary', 'default-primary-2'],
    );
  });

  it('projects only routed Claude and Codex accounts with normalized display usage', () => {
    const nativeOverview = overview([
      {
        provider: 'claude',
        authState: 'authenticated',
        hasRemainingLimits: true,
        accountEmail: 'native-claude@example.com',
        subscriptionLabel: 'Claude Pro',
        rateLimits: [
          {
            limitId: 'native-five-hour',
            limitName: 'Native Claude window',
            primary: { usedPercent: 11 },
          },
        ],
      },
      {
        provider: 'codex',
        authState: 'authenticated',
        hasRemainingLimits: true,
        accountEmail: 'native-codex@example.com',
        subscriptionLabel: 'ChatGPT Plus',
        rateLimits: [
          {
            limitId: 'native-codex',
            limitName: 'Native Codex window',
            primary: { usedPercent: 12 },
          },
        ],
      },
      {
        provider: 'copilot',
        authState: 'authenticated',
        hasRemainingLimits: true,
        accountLabel: 'octocat',
        rateLimits: [
          {
            limitId: 'premium',
            limitName: 'Premium requests',
            primary: { usedPercent: 25 },
          },
        ],
      },
    ]);
    const status = accountProxyUsage({}, [
      proxyAccount({
        authIndex: 'claude-auth-1',
        provider: 'claude',
        label: 'dev@example.com',
        planType: 'max',
        availableAt: Date.parse('2026-10-20T16:30:00.000Z'),
        fileName: '/private/claude-credential.json',
        statusMessage: 'private-status-sentinel',
        connectionId: 'private-account-connection-sentinel',
        key: 'private-management-key-sentinel',
        usage: {
          source: 'live',
          lastUpdatedAt: '2026-10-20T16:00:00.000Z',
          rateLimits: [
            {
              limitId: 'five_hour',
              limitName: '5-hour limit',
              primary: {
                usedPercent: 42,
                resetsAt: '2026-10-20T19:00:00.000Z',
                windowDurationMins: 300,
              },
            },
          ],
        },
      }),
      proxyAccount({
        authIndex: 'claude-api-key',
        provider: 'claude',
        source: 'api-key',
        label: '',
        planType: 'max',
      }),
      proxyAccount({
        authIndex: 'codex-auth-1',
        provider: 'codex',
        label: 'codex@example.com',
        planType: 'plus',
        usage: {
          source: 'passive',
          lastUpdatedAt: '2026-10-20T15:55:00.000Z',
          rateLimits: [
            {
              limitId: 'codex',
              limitName: 'Codex',
              primary: {
                usedPercent: 23,
                resetsAt: '2026-10-20T19:00:00.000Z',
                windowDurationMins: 300,
              },
              secondary: {
                usedPercent: 61,
                resetsAt: '2026-10-27T16:00:00.000Z',
                windowDurationMins: 10_080,
              },
              credits: { remainingUsd: 120 },
            },
          ],
        },
      }),
      proxyAccount({ authIndex: 'other-provider', provider: 'gemini' }),
    ]);

    const projection = projectPortalProviderUsage(nativeOverview, {
      status,
      aiCreditsChosen: false,
    });
    const claude = projection.providers.find(
      (entry) => entry.provider === 'claude',
    );
    const codex = projection.providers.find(
      (entry) => entry.provider === 'codex',
    );
    const copilot = projection.providers.find(
      (entry) => entry.provider === 'copilot',
    );

    expect(claude).toMatchObject({
      provider: 'claude',
      authState: 'authenticated',
      accountEmail: 'native-claude@example.com',
      planLabel: 'Claude Pro',
      windows: [
        {
          id: 'native-five-hour-primary',
          label: 'Native Claude window',
          usedPercent: 11,
        },
      ],
      accounts: [
        {
          id: 'claude-auth-1',
          label: 'dev@example.com',
          planLabel: 'Claude Max 5x',
          status: 'active',
          availableAt: '2026-10-20T16:30:00.000Z',
          usageSource: 'live',
          lastUpdatedAt: '2026-10-20T16:00:00.000Z',
          windows: [
            {
              id: 'five_hour-primary',
              label: '5-hour limit',
              usedPercent: 42,
              resetsAt: '2026-10-20T19:00:00.000Z',
              windowDurationMs: 18_000_000,
            },
          ],
        },
        {
          id: 'claude-api-key',
          planLabel: 'API key',
          status: 'active',
          windows: [],
        },
      ],
    });
    expect(claude).not.toHaveProperty('accounts.0.authIndex');
    expect(claude).not.toHaveProperty('accounts.0.fileName');
    expect(claude).not.toHaveProperty('accounts.0.statusMessage');
    expect(claude).not.toHaveProperty('accounts.0.connectionId');
    expect(claude).not.toHaveProperty('accounts.0.key');
    expect(claude).not.toHaveProperty('accounts.1.label');
    expect(claude).not.toHaveProperty('accounts.1.availableAt');
    expect(codex).toMatchObject({
      provider: 'codex',
      accountEmail: 'native-codex@example.com',
      planLabel: 'ChatGPT Plus',
      windows: [{ id: 'native-codex-primary' }],
      accounts: [
        {
          id: 'codex-auth-1',
          label: 'codex@example.com',
          planLabel: 'ChatGPT Plus',
          usageSource: 'passive',
          windows: [
            {
              id: 'codex-primary',
              label: '5-hour window',
              usedPercent: 23,
              credits: { unit: 'credits', remaining: 120 },
            },
            {
              id: 'codex-secondary',
              label: '7-day window',
              usedPercent: 61,
            },
          ],
        },
      ],
    });
    expect(codex).not.toHaveProperty('accounts.0.windows.1.credits');
    expect(copilot).not.toHaveProperty('accounts');
    const wire = JSON.stringify(projection);
    for (const sentinel of [
      '/private/claude-credential.json',
      'private-status-sentinel',
      'private-account-connection-sentinel',
      'private-management-key-sentinel',
      'proxy-connection-private',
      'proxy-private.example',
    ]) {
      expect(wire).not.toContain(sentinel);
    }
  });

  it('uses legacy limits only when usage is absent, not when present but empty', () => {
    const projection = projectPortalProviderUsage(
      overview([
        {
          provider: 'claude',
          authState: 'authenticated',
          hasRemainingLimits: true,
        },
      ]),
      {
        status: accountProxyUsage({}, [
          proxyAccount({
            authIndex: 'legacy',
            provider: 'claude',
            limits: [
              {
                id: 'five-hour',
                usedPercent: 64,
                resetsAt: Date.parse('2026-10-20T17:00:00.000Z'),
              },
              { id: 'weekly', usedPercent: 8, resetsAt: null },
            ],
          }),
          proxyAccount({
            authIndex: 'empty-live',
            provider: 'claude',
            limits: [{ id: 'five-hour', usedPercent: 99, resetsAt: null }],
            usage: { rateLimits: [], source: 'live' },
          }),
          proxyAccount({ authIndex: 'unavailable', provider: 'claude' }),
        ]),
        aiCreditsChosen: false,
      },
    );

    expect(projection.providers[0]).toMatchObject({
      accounts: [
        {
          id: 'legacy',
          usageSource: 'passive',
          windows: [
            {
              id: 'five-hour',
              label: '5-hour limit',
              windowDurationMs: 18_000_000,
              usedPercent: 64,
              resetsAt: '2026-10-20T17:00:00.000Z',
            },
            {
              id: 'weekly',
              label: 'Weekly limit',
              windowDurationMs: 604_800_000,
              usedPercent: 8,
            },
          ],
        },
        { id: 'empty-live', usageSource: 'live', windows: [] },
        { id: 'unavailable', windows: [] },
      ],
    });
    expect(projection.providers[0]).not.toHaveProperty(
      'accounts.2.usageSource',
    );
  });

  it('retains cached account windows beside curated errors and retry time', () => {
    const projection = projectPortalProviderUsage(
      overview([
        {
          provider: 'claude',
          authState: 'authenticated',
          hasRemainingLimits: true,
        },
      ]),
      {
        status: accountProxyUsage({}, [
          proxyAccount({
            authIndex: 'a1b2',
            provider: 'claude',
            usage: {
              source: 'passive',
              lastUpdatedAt: '2026-10-20T15:00:00.000Z',
              retryAt: Date.parse('2026-10-20T18:00:00.000Z'),
              errorInfo: {
                kind: 'rate_limited',
                message: 'private-provider-message-sentinel',
                detail: 'private-provider-detail-sentinel',
              },
              rateLimits: [
                {
                  limitId: 'session',
                  limitName: '5-hour window',
                  primary: { usedPercent: 42 },
                },
              ],
            },
          }),
        ]),
        aiCreditsChosen: false,
      },
    );

    expect(projection.providers[0]).toMatchObject({
      accounts: [
        {
          id: 'a1b2',
          usageSource: 'passive',
          lastUpdatedAt: '2026-10-20T15:00:00.000Z',
          retryAt: '2026-10-20T18:00:00.000Z',
          error: {
            kind: 'service',
            message:
              'Claude is limiting usage checks right now. Try again later.',
          },
          windows: [
            {
              id: 'session-primary',
              label: '5-hour window',
              usedPercent: 42,
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(projection)).not.toContain(
      'private-provider-message-sentinel',
    );
    expect(JSON.stringify(projection)).not.toContain(
      'private-provider-detail-sentinel',
    );
  });

  it('deduplicates account ids first-wins before limiting to 50 unique accounts', () => {
    const inputAccounts = [
      proxyAccount({
        authIndex: 'duplicate',
        provider: 'claude',
        label: 'first@example.com',
      }),
      proxyAccount({
        authIndex: 'duplicate',
        provider: 'claude',
        label: 'second@example.com',
      }),
      ...Array.from({ length: 49 }, (_value, index) =>
        proxyAccount({ authIndex: `unique-${index}`, provider: 'claude' }),
      ),
    ];
    const projection = projectPortalProviderUsage(
      overview([
        {
          provider: 'claude',
          authState: 'authenticated',
          hasRemainingLimits: true,
        },
      ]),
      {
        status: accountProxyUsage({}, inputAccounts),
        aiCreditsChosen: false,
      },
    );

    // First-wins de-duplication happens before the 50-account wire cap.
    expect(projection.providers[0]).toHaveProperty('accounts.length', 50);
    expect(projection.providers[0]?.accounts?.slice(0, 2)).toMatchObject([
      { id: 'duplicate', label: 'first@example.com' },
      { id: 'unique-0' },
    ]);
    expect(projection.providers[0]).toHaveProperty(
      'accounts.49.id',
      'unique-48',
    );
    expect(projection.providers[0]).not.toHaveProperty('accounts.50');
  });

  it('limits account usage windows to 20 on the Portal wire projection', () => {
    const rateLimits = Array.from({ length: 21 }, (_value, index) => ({
      limitId: `window-${index}`,
      limitName: `Window ${index}`,
      primary: { usedPercent: index },
    }));
    const projection = projectPortalProviderUsage(
      overview([
        {
          provider: 'claude',
          authState: 'authenticated',
          hasRemainingLimits: true,
        },
      ]),
      {
        status: accountProxyUsage({}, [
          proxyAccount({
            authIndex: 'a1b2',
            provider: 'claude',
            usage: { source: 'live', rateLimits },
          }),
        ]),
        aiCreditsChosen: false,
      },
    );

    expect(projection.providers[0]).toHaveProperty(
      'accounts.0.windows.length',
      20,
    );
    expect(JSON.stringify(projection)).not.toContain('Window 20');
  });

  it('truncates long account labels to the Portal wire bound instead of dropping usage', () => {
    const longLabel = `${'a'.repeat(400)}@example.com`;
    const projection = projectPortalProviderUsage(
      overview([
        {
          provider: 'claude',
          authState: 'authenticated',
          hasRemainingLimits: true,
        },
      ]),
      {
        status: accountProxyUsage({}, [
          proxyAccount({
            authIndex: 'a1b2',
            provider: 'claude',
            label: longLabel,
            source: 'sign-in',
            planType: 'max',
          }),
        ]),
        aiCreditsChosen: false,
      },
    );

    expect(projection.providers[0]).toHaveProperty(
      'accounts.0.label',
      longLabel.slice(0, 320),
    );
  });

  it('omits account projections whenever routing does not serve a provider', () => {
    const nativeOverview = overview([
      {
        provider: 'claude',
        authState: 'authenticated',
        hasRemainingLimits: true,
      },
      {
        provider: 'codex',
        authState: 'authenticated',
        hasRemainingLimits: true,
      },
    ]);
    const accounts = [
      proxyAccount({ authIndex: 'claude', provider: 'claude' }),
      proxyAccount({ authIndex: 'codex', provider: 'codex' }),
    ];
    const routed = accountProxyUsage({}, accounts);
    const notServingAnyProvider = [
      accountProxyUsage({ available: false }, accounts),
      accountProxyUsage({ state: 'not-configured' }, accounts),
      accountProxyUsage(
        {
          error: { code: 'unreachable', message: 'Proxy unavailable' },
        },
        accounts,
      ),
      accountProxyUsage(
        {
          connection: {
            id: 'local-connection',
            kind: 'local',
            url: 'http://127.0.0.1:4100',
          },
          local: {
            phase: 'stopped',
            version: null,
            install: null,
            port: null,
            startWithApp: true,
            message: null,
          },
        },
        accounts,
      ),
    ];

    for (const status of notServingAnyProvider) {
      const projection = projectPortalProviderUsage(nativeOverview, {
        status,
        aiCreditsChosen: false,
      });
      expect(
        projection.providers.find((entry) => entry.provider === 'claude'),
      ).not.toHaveProperty('accounts');
      expect(
        projection.providers.find((entry) => entry.provider === 'codex'),
      ).not.toHaveProperty('accounts');
    }
    const claudeRoutingOff = projectPortalProviderUsage(nativeOverview, {
      status: accountProxyUsage({ routeClaude: false }, accounts),
      aiCreditsChosen: false,
    });
    expect(
      claudeRoutingOff.providers.find((entry) => entry.provider === 'claude'),
    ).not.toHaveProperty('accounts');
    expect(
      claudeRoutingOff.providers.find((entry) => entry.provider === 'codex'),
    ).toHaveProperty('accounts.0.id', 'codex');
    const codexRoutingOff = projectPortalProviderUsage(nativeOverview, {
      status: accountProxyUsage({ routeCodex: false }, accounts),
      aiCreditsChosen: false,
    });
    expect(
      codexRoutingOff.providers.find((entry) => entry.provider === 'codex'),
    ).not.toHaveProperty('accounts');
    expect(
      codexRoutingOff.providers.find((entry) => entry.provider === 'claude'),
    ).toHaveProperty('accounts.0.id', 'claude');
    const aiCreditsProjection = projectPortalProviderUsage(nativeOverview, {
      status: routed,
      aiCreditsChosen: true,
    });
    expect(aiCreditsProjection.providers[0]).not.toHaveProperty('accounts');
    expect(aiCreditsProjection.providers[1]).not.toHaveProperty('accounts');
  });

  it('requires a running matching local proxy connection before projecting accounts', () => {
    const nativeOverview = overview([
      {
        provider: 'claude',
        authState: 'authenticated',
        hasRemainingLimits: true,
      },
    ]);
    const status = accountProxyUsage(
      {
        connection: {
          id: 'local-connection',
          kind: 'local',
          url: 'http://127.0.0.1:4100',
        },
        local: {
          phase: 'running',
          version: '1.0.0',
          install: null,
          port: 4100,
          startWithApp: true,
          message: null,
        },
      },
      [proxyAccount({ authIndex: 'a1b2', provider: 'claude' })],
    );

    expect(
      projectPortalProviderUsage(nativeOverview, {
        status,
        aiCreditsChosen: false,
      }).providers[0],
    ).toHaveProperty('accounts.0.id', 'a1b2');
  });

  it('keeps optional null proxy status identical to the original native projection', () => {
    const nativeOverview = overview([signedOutCodex]);
    expect(
      projectPortalProviderUsage(nativeOverview, {
        status: null,
        aiCreditsChosen: false,
      }),
    ).toEqual(projectPortalProviderUsage(nativeOverview));
  });

  it('builds the overview snapshot entity from cached usage', async () => {
    mockGetUsageOverview.mockReturnValue(overview([signedOutCodex]));

    const entities = await listPortalProviderUsageEntities();

    expect(entities).toEqual([
      {
        entityType: 'provider_usage',
        localId: 'overview',
        payload: {
          updatedAt: '2026-10-04T17:05:00.000Z',
          providers: [
            { provider: 'claude', authState: 'unknown', windows: [] },
            { provider: 'codex', authState: 'unauthenticated', windows: [] },
          ],
        },
      },
    ]);
  });

  it('reads current proxy status without refreshing quota for the snapshot', async () => {
    mockGetUsageOverview.mockReturnValue(overview([signedOutCodex]));
    mockGetAccountProxyStatus.mockResolvedValue(disconnectedProxy());

    await listPortalProviderUsageEntities();

    expect(mockGetAccountProxyStatus.mock.calls).toEqual([
      [{ refresh: false }],
    ]);
    expect(
      mockGetAccountProxyStatus.mock.calls.some(
        ([options]) =>
          options.refresh === true || options.refreshUsage === true,
      ),
    ).toBe(false);
  });

  it('includes the currently served account in an async overview snapshot', async () => {
    mockGetUsageOverview.mockReturnValue(overview([signedOutCodex]));
    mockGetAccountProxyStatus.mockResolvedValue(
      accountProxyUsage({}, [
        proxyAccount({
          authIndex: 'a1b2',
          provider: 'claude',
          label: 'dev@example.com',
        }),
      ]),
    );

    const entities = await listPortalProviderUsageEntities();

    const payload = entities[0]?.payload;
    expect(payload).toHaveProperty('providers.0.provider', 'claude');
    expect(payload).toHaveProperty('providers.0.accounts.length', 1);
    expect(payload).toHaveProperty('providers.0.accounts.0.id', 'a1b2');
    expect(payload).toHaveProperty(
      'providers.0.accounts.0.label',
      'dev@example.com',
    );
    expect(mockGetAccountProxyStatus).toHaveBeenCalledWith({ refresh: false });
    expect(mockIsAiCreditsChosenOverAccountProxy).toHaveBeenCalledWith(
      undefined,
    );
  });

  it('leaves provider usage out of the snapshot when the overview cannot be read', async () => {
    mockGetUsageOverview.mockImplementation(() => {
      throw new Error('observability unavailable');
    });

    await expect(listPortalProviderUsageEntities()).resolves.toEqual([]);
  });
});

describe('subscribePortalProviderUsage (CAN-3635)', () => {
  it('publishes changed usage as overview deltas until all subscriptions stop', async () => {
    const events: PortalEventEnvelope[] = [];
    const stop = subscribePortalProviderUsage((event) => events.push(event));
    const signedIn = overview([
      {
        provider: 'codex',
        authState: 'authenticated',
        hasRemainingLimits: true,
        rateLimits: [{ limitId: 'codex', primary: { usedPercent: 23 } }],
      },
    ]);

    for (const listener of Array.from(mockListeners)) {
      listener({ type: 'retention', retentionDays: 30 });
    }
    emitUsage(signedIn);
    await flushProviderUsageProjection();
    emitUsage({ ...signedIn, updatedAt: '2026-10-04T17:06:00.000Z' });
    await flushProviderUsageProjection();
    emitUsage(overview([signedOutCodex]));
    await flushProviderUsageProjection();

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: 'portal.state.delta',
      payload: {
        scope: 'overview',
        entities: [{ entityType: 'provider_usage', localId: 'overview' }],
      },
    });
    expect(events[0]?.payload).not.toHaveProperty('target');
    expect(events[1]).toMatchObject({
      payload: {
        entities: [
          {
            payload: {
              providers: [
                { provider: 'claude', authState: 'unknown' },
                { provider: 'codex', authState: 'unauthenticated' },
              ],
            },
          },
        ],
      },
    });

    const captured = Array.from(mockListeners);
    expect(mockAccountProxyListeners.size).toBe(1);
    expect(mockAiCreditsRoutingListeners.size).toBe(1);
    stop();
    expect(mockListeners.size).toBe(0);
    expect(mockAccountProxyListeners.size).toBe(0);
    expect(mockAiCreditsRoutingListeners.size).toBe(0);
    for (const listener of captured) {
      listener({ type: 'usage', usage: signedIn });
    }
    expect(events).toHaveLength(2);
  });

  it('reprojects usage changes with the current proxy account inventory', async () => {
    const events: PortalEventEnvelope[] = [];
    const account = proxyAccount({
      authIndex: 'a1b2',
      provider: 'claude',
      label: 'dev@example.com',
    });
    mockGetAccountProxyStatus.mockResolvedValue(
      accountProxyUsage({}, [account]),
    );
    const stop = subscribePortalProviderUsage((event) => events.push(event));

    emitUsage(
      overview([
        {
          provider: 'claude',
          authState: 'authenticated',
          hasRemainingLimits: true,
        },
      ]),
    );
    await flushProviderUsageProjection();

    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).toContain('dev@example.com');
    expect(mockGetAccountProxyStatus).toHaveBeenCalledWith({ refresh: false });
    stop();
  });

  it('withdraws proxy accounts when routing mode changes to AI Credits', async () => {
    const events: PortalEventEnvelope[] = [];
    const usage = overview([
      {
        provider: 'claude',
        authState: 'authenticated',
        hasRemainingLimits: true,
      },
    ]);
    mockGetUsageOverview.mockReturnValue(usage);
    mockGetAccountProxyStatus.mockResolvedValue(
      accountProxyUsage({}, [
        proxyAccount({
          authIndex: 'a1b2',
          provider: 'claude',
          label: 'dev@example.com',
        }),
      ]),
    );
    const stop = subscribePortalProviderUsage((event) => events.push(event));

    emitUsage(usage);
    await flushProviderUsageProjection();
    mockIsAiCreditsChosenOverAccountProxy.mockReturnValue(true);
    emitAiCreditsRoutingChange();
    await flushProviderUsageProjection();

    expect(events).toHaveLength(2);
    expect(JSON.stringify(events[0])).toContain('dev@example.com');
    expect(JSON.stringify(events[1])).not.toContain('dev@example.com');
    expect(JSON.stringify(events[1])).not.toContain('"accounts"');
    stop();
  });

  it('publishes only the latest proxy status when async projection reads resolve out of order', async () => {
    const events: PortalEventEnvelope[] = [];
    const usage = overview([
      {
        provider: 'claude',
        authState: 'authenticated',
        hasRemainingLimits: true,
      },
    ]);
    const oldStatus = accountProxyUsage({}, [
      proxyAccount({
        authIndex: 'old-account',
        provider: 'claude',
        label: 'old@example.com',
      }),
    ]);
    mockGetUsageOverview.mockReturnValue(usage);
    mockGetAccountProxyStatus.mockResolvedValue(oldStatus);
    const stop = subscribePortalProviderUsage((event) => events.push(event));

    emitUsage(usage);
    await flushProviderUsageProjection();
    expect(JSON.stringify(events[0])).toContain('old@example.com');

    const pendingReads: Array<{
      resolve(status: AccountProxyStatus): void;
    }> = [];
    mockGetAccountProxyStatus.mockImplementation(
      () =>
        new Promise<AccountProxyStatus>((resolve) => {
          pendingReads.push({ resolve });
        }),
    );
    emitUsage(usage);
    emitAccountProxyInventoryChange();
    await flushProviderUsageProjection();
    expect(pendingReads).toHaveLength(2);

    pendingReads[1]?.resolve(disconnectedProxy());
    await flushProviderUsageProjection();
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events[1])).not.toContain('old@example.com');

    pendingReads[0]?.resolve(oldStatus);
    await flushProviderUsageProjection();

    expect(events).toHaveLength(2);
    expect(JSON.stringify(events[1])).not.toContain('old@example.com');
    stop();
  });

  it('does not emit after unsubscribe when a proxy status read is still pending', async () => {
    const events: PortalEventEnvelope[] = [];
    const pendingRead = deferred<AccountProxyStatus>();
    mockGetAccountProxyStatus.mockReturnValue(pendingRead.promise);
    const stop = subscribePortalProviderUsage((event) => events.push(event));

    emitUsage(
      overview([
        {
          provider: 'claude',
          authState: 'authenticated',
          hasRemainingLimits: true,
        },
      ]),
    );
    await flushProviderUsageProjection();
    expect(mockGetAccountProxyStatus).toHaveBeenCalledTimes(1);

    stop();
    pendingRead.resolve(
      accountProxyUsage({}, [
        proxyAccount({
          authIndex: 'a1b2',
          provider: 'claude',
          label: 'late@example.com',
        }),
      ]),
    );
    await flushProviderUsageProjection();

    expect(events).toEqual([]);
    expect(mockListeners.size).toBe(0);
    expect(mockAccountProxyListeners.size).toBe(0);
    expect(mockAiCreditsRoutingListeners.size).toBe(0);
  });
});

describe('handlePortalProviderUsageRefresh account-proxy routing', () => {
  function command(
    provider: 'claude' | 'codex' | 'copilot',
  ): PortalCommandEnvelope {
    return {
      id: 'provider-usage-refresh-1',
      sequence: 1,
      type: 'portal.provider_usage.refresh',
      payload: { provider },
      createdAt: '2026-10-20T16:00:00.000Z',
      expiresAt: null,
    };
  }

  function adapterContext(): {
    context: PortalAdapterContext;
    complete: jest.Mock;
  } {
    const complete = jest.fn();
    return {
      context: {
        getWindow: () => null,
        enqueueEvent: jest.fn(),
        complete,
        fail: jest.fn(),
      },
      complete,
    };
  }

  const accountProxyProviders: Array<'claude' | 'codex'> = ['claude', 'codex'];

  it.each(accountProxyProviders)(
    'refreshes account-proxy usage for routed %s without delaying completion',
    (provider) => {
      const pendingRead = deferred<AccountProxyStatus>();
      mockGetAccountProxyStatus.mockReturnValue(pendingRead.promise);
      const request = command(provider);
      const { context, complete } = adapterContext();

      handlePortalProviderUsageRefresh(request, context);

      expect(complete).toHaveBeenCalledWith(request, {
        provider,
        accepted: true,
      });
      expect(mockRefreshProviderUsage).not.toHaveBeenCalled();
      expect(mockRefreshAccountProxyUsage).not.toHaveBeenCalled();

      pendingRead.resolve(accountProxyUsage());
      return flushProviderUsageProjection().then(() => {
        expect(mockRefreshAccountProxyUsage).toHaveBeenCalledWith({
          interactive: true,
          provider,
        });
        expect(mockRefreshProviderUsage).not.toHaveBeenCalled();
      });
    },
  );

  it.each([
    {
      reason: 'a disconnected proxy',
      status: disconnectedProxy(),
      aiCreditsChosen: false,
    },
    {
      reason: 'AI Credits chosen',
      status: accountProxyUsage(),
      aiCreditsChosen: true,
    },
  ])(
    'keeps native usage refresh for $reason',
    async ({ status, aiCreditsChosen }) => {
      mockGetAccountProxyStatus.mockResolvedValue(status);
      mockIsAiCreditsChosenOverAccountProxy.mockReturnValue(aiCreditsChosen);
      const request = command('claude');
      const { context, complete } = adapterContext();

      handlePortalProviderUsageRefresh(request, context);

      expect(complete).toHaveBeenCalledWith(request, {
        provider: 'claude',
        accepted: true,
      });
      await flushProviderUsageProjection();
      expect(mockRefreshProviderUsage).toHaveBeenCalledWith('claude', {
        joinInFlight: true,
      });
      expect(mockRefreshAccountProxyUsage).not.toHaveBeenCalled();
    },
  );

  it('keeps Copilot refresh on its native usage path', async () => {
    mockGetAccountProxyStatus.mockResolvedValue(accountProxyUsage());
    const request = command('copilot');
    const { context } = adapterContext();

    handlePortalProviderUsageRefresh(request, context);
    await flushProviderUsageProjection();

    expect(mockRefreshProviderUsage).toHaveBeenCalledWith('copilot', {
      joinInFlight: true,
    });
    expect(mockRefreshAccountProxyUsage).not.toHaveBeenCalled();
  });
});
// Add to the existing portal/provider-usage-projection.test.ts in the quota branch.
it('projects the current Copilot quota with a GitHub account label', () => {
  const projection = projectPortalProviderUsage(
    overview([
      {
        provider: 'copilot',
        authState: 'authenticated',
        hasRemainingLimits: true,
        accountLabel: 'octocat',
        rateLimits: [
          {
            limitId: 'premium_interactions',
            limitName: 'Premium requests',
            primary: { usedPercent: 25, resetsAt: '2026-11-01T00:00:00.000Z' },
          },
        ],
      },
    ]),
  );
  expect(projection.providers).toContainEqual({
    provider: 'copilot',
    authState: 'authenticated',
    accountLabel: 'octocat',
    windows: [
      {
        id: 'premium_interactions-primary',
        label: 'Premium requests',
        usedPercent: 25,
        resetsAt: '2026-11-01T00:00:00.000Z',
      },
    ],
  });
});

it('removes Copilot account identity and quota windows on disconnect', () => {
  const projection = projectPortalProviderUsage(
    overview([
      {
        provider: 'copilot',
        authState: 'unauthenticated',
        hasRemainingLimits: false,
        accountLabel: 'old-account',
        rateLimits: [{ limitId: 'stale', primary: { usedPercent: 60 } }],
      },
    ]),
  );
  expect(projection.providers).toContainEqual({
    provider: 'copilot',
    authState: 'unauthenticated',
    windows: [],
  });
});

it('keeps Copilot diagnostics and credentials out of remote usage errors', () => {
  const projection = projectPortalProviderUsage(
    overview([
      {
        provider: 'copilot',
        authState: 'error',
        hasRemainingLimits: false,
        error: 'ghu_private_token at /private/profile',
        errorInfo: { kind: 'service', detail: 'Authorization: private token' },
      },
    ]),
  );
  const copilot = projection.providers.find(
    (entry) => entry.provider === 'copilot',
  );
  expect(copilot).toMatchObject({
    provider: 'copilot',
    authState: 'error',
    windows: [],
    error: { kind: 'service' },
  });
  expect(copilot).toHaveProperty('error.message', expect.any(String));
  expect(JSON.stringify(projection)).not.toMatch(
    /private_token|Authorization|private\/profile/,
  );
});

it('does not advertise Copilot when the host omits its gated usage summary', () => {
  expect(
    projectPortalProviderUsage(overview([])).providers.map(
      (entry) => entry.provider,
    ),
  ).toEqual(['claude', 'codex']);
});

it('distinguishes an unlimited Copilot quota from an unknown one', () => {
  const limits = [
    {
      limitId: 'chat',
      limitName: 'Chat · Unlimited',
      primary: { unlimited: true },
    },
    { limitId: 'unknown', limitName: 'Unknown', primary: {} },
  ];
  const projection = projectPortalProviderUsage(
    overview([
      {
        provider: 'copilot',
        authState: 'authenticated',
        hasRemainingLimits: true,
        rateLimits: limits,
      },
    ]),
  );
  expect(projection.providers).toContainEqual({
    provider: 'copilot',
    authState: 'authenticated',
    windows: [
      { id: 'chat-primary', label: 'Chat', unlimited: true },
      { id: 'unknown-primary', label: 'Unknown' },
    ],
  });
});

it('publishes OpenCode-only account changes and removes the optional field on disconnect', async () => {
  const first: AgentUsageOverview = {
    ...overview([]),
    openCodeAccounts: {
      status: 'ready',
      updatedAt: '2026-10-21T23:00:00Z',
      providers: [
        {
          id: 'fixture',
          name: 'Fixture',
          accounts: [
            {
              label: 'Work account',
              method: 'oauth',
              selected: true,
              needsSignIn: false,
            },
          ],
        },
      ],
    },
  };
  mockGetUsageOverview.mockReturnValue(overview([]));
  const events: PortalEventEnvelope[] = [];
  const stop = subscribePortalProviderUsage((event) => events.push(event));
  try {
    emitUsage(first);
    await flushProviderUsageProjection();
    expect(JSON.stringify(events.at(-1))).toContain('Work account');
    const count = events.length;
    emitUsage(overview([]));
    await flushProviderUsageProjection();
    expect(events).toHaveLength(count + 1);
    expect(JSON.stringify(events.at(-1))).not.toContain('Work account');
    expect(
      projectPortalProviderUsage(first).providers.map(
        (entry) => entry.provider,
      ),
    ).toEqual(['claude', 'codex']);
  } finally {
    stop();
  }
});
