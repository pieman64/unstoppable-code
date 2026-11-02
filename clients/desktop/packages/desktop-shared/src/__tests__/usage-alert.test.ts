import type {
  AgentUsageOverview,
  ProviderUsageSummary,
} from '../types/observability';
import type { AiCreditsRoutingMode, CanopyCloudAiCreditsState } from '../types';
import type {
  AccountProxyAccount,
  AccountProxyStatus,
} from '../types/account-proxy';
import {
  AI_CREDITS_LOW_BALANCE_WARNING,
  computeAiCreditsAlertLevel,
  computeUsageAlertLevel,
  isAiCreditsActiveMethod,
  maxUsageAlertLevel,
  usageAlertBackgroundClass,
  usageAlertColorClass,
  usagePercentColorClass,
} from '../lib/usage-alert';

function makeUsage(
  ...providerOverrides: Array<Partial<ProviderUsageSummary>>
): AgentUsageOverview {
  const base: ProviderUsageSummary = {
    provider: 'claude',
    authState: 'authenticated',
    hasRemainingLimits: false,
  };
  return {
    updatedAt: new Date().toISOString(),
    providers: providerOverrides.map((o) => ({ ...base, ...o })),
  };
}

describe('computeUsageAlertLevel', () => {
  it('returns normal when there are no providers', () => {
    expect(computeUsageAlertLevel(makeUsage())).toBe('normal');
  });

  it('returns normal when no rate limits exist', () => {
    expect(computeUsageAlertLevel(makeUsage({ rateLimits: [] }))).toBe(
      'normal',
    );
  });

  it('returns normal when usedPercent is undefined', () => {
    expect(
      computeUsageAlertLevel(
        makeUsage({
          rateLimits: [{ primary: { limit: 100, remaining: 50 } }],
        }),
      ),
    ).toBe('normal');
  });

  it('returns normal at 79.9%', () => {
    expect(
      computeUsageAlertLevel(
        makeUsage({
          rateLimits: [{ primary: { usedPercent: 79.9 } }],
        }),
      ),
    ).toBe('normal');
  });

  it('returns warning at exactly 80%', () => {
    expect(
      computeUsageAlertLevel(
        makeUsage({
          rateLimits: [{ primary: { usedPercent: 80 } }],
        }),
      ),
    ).toBe('warning');
  });

  it('returns warning at 97.9%', () => {
    expect(
      computeUsageAlertLevel(
        makeUsage({
          rateLimits: [{ primary: { usedPercent: 97.9 } }],
        }),
      ),
    ).toBe('warning');
  });

  it('returns critical at exactly 98%', () => {
    expect(
      computeUsageAlertLevel(
        makeUsage({
          rateLimits: [{ primary: { usedPercent: 98 } }],
        }),
      ),
    ).toBe('critical');
  });

  it('returns critical at 100%', () => {
    expect(
      computeUsageAlertLevel(
        makeUsage({
          rateLimits: [{ secondary: { usedPercent: 100 } }],
        }),
      ),
    ).toBe('critical');
  });

  it('returns critical when any provider hits critical', () => {
    expect(
      computeUsageAlertLevel(
        makeUsage(
          { rateLimits: [{ primary: { usedPercent: 50 } }] },
          {
            provider: 'codex',
            rateLimits: [{ secondary: { usedPercent: 99 } }],
          },
        ),
      ),
    ).toBe('critical');
  });

  it.each([
    [undefined, 'normal'],
    [85, 'warning'],
    [99, 'critical'],
  ] as const)(
    'includes reported Cursor usage (%s) in the sidebar alert',
    (usedPercent, expected) => {
      expect(
        computeUsageAlertLevel(
          makeUsage({
            provider: 'cursor',
            rateLimits: [{ limitId: 'cursor-plan', primary: { usedPercent } }],
          }),
        ),
      ).toBe(expected);
    },
  );

  it('returns warning from secondary window', () => {
    expect(
      computeUsageAlertLevel(
        makeUsage({
          rateLimits: [
            { primary: { usedPercent: 10 }, secondary: { usedPercent: 85 } },
          ],
        }),
      ),
    ).toBe('warning');
  });

  it('handles multiple rate limit snapshots', () => {
    expect(
      computeUsageAlertLevel(
        makeUsage({
          rateLimits: [
            { primary: { usedPercent: 50 } },
            { primary: { usedPercent: 90 } },
          ],
        }),
      ),
    ).toBe('warning');
  });
});

describe('usagePercentColorClass', () => {
  it('returns muted for values below 80', () => {
    expect(usagePercentColorClass(0)).toBe('fg-secondary');
    expect(usagePercentColorClass(79.9)).toBe('fg-secondary');
  });

  it('returns amber at 80', () => {
    expect(usagePercentColorClass(80)).toBe('fg-warning');
  });

  it('returns amber between 80 and 98', () => {
    expect(usagePercentColorClass(90)).toBe('fg-warning');
    expect(usagePercentColorClass(97.9)).toBe('fg-warning');
  });

  it('returns red at 98', () => {
    expect(usagePercentColorClass(98)).toBe('fg-destructive');
  });

  it('returns red at 100', () => {
    expect(usagePercentColorClass(100)).toBe('fg-destructive');
  });
});

function makeCreditsState(
  overrides: Partial<CanopyCloudAiCreditsState> = {},
): CanopyCloudAiCreditsState {
  return {
    connected: true,
    email: 'user@example.com',
    subscription: null,
    balance: {
      email: 'user@example.com',
      credits: 500,
      eligible: true,
      source: 'canopy',
    },
    noUdAccount: false,
    error: null,
    ...overrides,
  };
}

// A provider window at/above the critical threshold — i.e. out of quota.
const CRITICAL_LIMITS = [{ primary: { usedPercent: 100 } }];

describe('isAiCreditsActiveMethod', () => {
  it('is active when routing is on (always), regardless of other plans', () => {
    expect(
      isAiCreditsActiveMethod(
        'on',
        makeUsage({ rateLimits: [{ primary: { usedPercent: 10 } }] }),
      ),
    ).toBe(true);
  });

  it('is never active when routing is off', () => {
    expect(isAiCreditsActiveMethod('off', makeUsage())).toBe(false);
  });

  it('is never active when routing mode has not loaded (null)', () => {
    expect(isAiCreditsActiveMethod(null, makeUsage())).toBe(false);
  });

  it('on-quota: active when there are no authenticated cloud plans', () => {
    expect(isAiCreditsActiveMethod('on-quota', makeUsage())).toBe(true);
    expect(
      isAiCreditsActiveMethod(
        'on-quota',
        makeUsage({ authState: 'unauthenticated' }),
      ),
    ).toBe(true);
  });

  it('on-quota: not active when an authenticated cloud plan still has quota', () => {
    expect(
      isAiCreditsActiveMethod(
        'on-quota',
        makeUsage({ rateLimits: [{ primary: { usedPercent: 50 } }] }),
      ),
    ).toBe(false);
  });

  it('on-quota: active when every authenticated cloud plan is out of quota', () => {
    expect(
      isAiCreditsActiveMethod(
        'on-quota',
        makeUsage(
          { provider: 'claude', rateLimits: CRITICAL_LIMITS },
          { provider: 'codex', rateLimits: CRITICAL_LIMITS },
        ),
      ),
    ).toBe(true);
  });

  it('on-quota: not active when only some cloud plans are out of quota', () => {
    expect(
      isAiCreditsActiveMethod(
        'on-quota',
        makeUsage(
          { provider: 'claude', rateLimits: CRITICAL_LIMITS },
          { provider: 'codex', rateLimits: [{ primary: { usedPercent: 20 } }] },
        ),
      ),
    ).toBe(false);
  });

  it('on-quota: ignores Ollama (local, no quota) as an alternative plan', () => {
    expect(
      isAiCreditsActiveMethod(
        'on-quota',
        makeUsage({ provider: 'ollama', authState: 'authenticated' }),
      ),
    ).toBe(true);
  });
});

describe('computeAiCreditsAlertLevel', () => {
  const routingOn: AiCreditsRoutingMode = 'on';
  // routing 'on' is always active, so provider usage is irrelevant here.
  const anyUsage = makeUsage();

  it('returns normal when state is null', () => {
    expect(computeAiCreditsAlertLevel(null, routingOn, anyUsage)).toBe(
      'normal',
    );
  });

  it('returns normal when disconnected', () => {
    expect(
      computeAiCreditsAlertLevel(
        makeCreditsState({ connected: false }),
        routingOn,
        anyUsage,
      ),
    ).toBe('normal');
  });

  it('returns normal when the account has no UD account', () => {
    expect(
      computeAiCreditsAlertLevel(
        makeCreditsState({ noUdAccount: true }),
        routingOn,
        anyUsage,
      ),
    ).toBe('normal');
  });

  it('returns normal on transient error', () => {
    expect(
      computeAiCreditsAlertLevel(
        makeCreditsState({ error: 'boom' }),
        routingOn,
        anyUsage,
      ),
    ).toBe('normal');
  });

  it('returns normal when routing is off (never), even when exhausted', () => {
    expect(
      computeAiCreditsAlertLevel(
        makeCreditsState({
          balance: {
            email: 'e',
            source: 'canopy',
            credits: 0,
            eligible: false,
          },
        }),
        'off',
        anyUsage,
      ),
    ).toBe('normal');
  });

  it('returns normal when routing off even with an active subscription', () => {
    expect(
      computeAiCreditsAlertLevel(
        makeCreditsState({
          subscription: { email: 'e', source: 'canopy', active: true },
          balance: {
            email: 'e',
            source: 'canopy',
            credits: 0,
            eligible: false,
          },
        }),
        'off',
        anyUsage,
      ),
    ).toBe('normal');
  });

  it('returns normal when an org pool covers an empty personal wallet', () => {
    // The sidebar dot used to go red here — "you're out of credits" — while the
    // org's shared pool was paying and the session ran fine.
    expect(
      computeAiCreditsAlertLevel(
        makeCreditsState({
          balance: {
            email: 'e',
            source: 'canopy',
            credits: 0,
            eligible: false,
            orgPool: { orgId: 'org_1', orgName: 'Acme' },
          },
        }),
        routingOn,
        anyUsage,
      ),
    ).toBe('normal');
  });

  it('still warns on a low personal balance even when a pool sits behind it', () => {
    // The personal number is still the actionable one until it hits zero, so a
    // named fallback pool does not suppress the low-balance amber.
    expect(
      computeAiCreditsAlertLevel(
        makeCreditsState({
          balance: {
            email: 'e',
            source: 'canopy',
            credits: AI_CREDITS_LOW_BALANCE_WARNING - 1,
            eligible: true,
            orgPool: { orgId: 'org_1', orgName: 'Acme' },
          },
        }),
        routingOn,
        anyUsage,
      ),
    ).toBe('warning');
  });

  it('still returns critical for a genuinely unfunded user with no pool', () => {
    expect(
      computeAiCreditsAlertLevel(
        makeCreditsState({
          balance: {
            email: 'e',
            source: 'canopy',
            credits: 0,
            eligible: false,
            orgPool: null,
          },
        }),
        routingOn,
        anyUsage,
      ),
    ).toBe('critical');
  });

  it('returns critical when exhausted and routing is on', () => {
    expect(
      computeAiCreditsAlertLevel(
        makeCreditsState({
          balance: {
            email: 'e',
            source: 'canopy',
            credits: 0,
            eligible: false,
          },
        }),
        routingOn,
        anyUsage,
      ),
    ).toBe('critical');
  });

  it('returns critical when ineligible even if credits > 0', () => {
    expect(
      computeAiCreditsAlertLevel(
        makeCreditsState({
          balance: {
            email: 'e',
            source: 'canopy',
            credits: 5,
            eligible: false,
          },
        }),
        routingOn,
        anyUsage,
      ),
    ).toBe('critical');
  });

  it('on-quota: normal when exhausted but another plan still has quota', () => {
    expect(
      computeAiCreditsAlertLevel(
        makeCreditsState({
          balance: {
            email: 'e',
            source: 'canopy',
            credits: 0,
            eligible: false,
          },
        }),
        'on-quota',
        makeUsage({ rateLimits: [{ primary: { usedPercent: 30 } }] }),
      ),
    ).toBe('normal');
  });

  it('on-quota: critical when exhausted and the only cloud plan is out of quota', () => {
    expect(
      computeAiCreditsAlertLevel(
        makeCreditsState({
          balance: {
            email: 'e',
            source: 'canopy',
            credits: 0,
            eligible: false,
          },
        }),
        'on-quota',
        makeUsage({ rateLimits: CRITICAL_LIMITS }),
      ),
    ).toBe('critical');
  });

  it('returns warning when balance is below the low threshold', () => {
    expect(
      computeAiCreditsAlertLevel(
        makeCreditsState({
          balance: {
            email: 'e',
            source: 'canopy',
            credits: AI_CREDITS_LOW_BALANCE_WARNING - 1,
            eligible: true,
          },
        }),
        routingOn,
        anyUsage,
      ),
    ).toBe('warning');
  });

  it('returns normal when balance is at or above the low threshold', () => {
    expect(
      computeAiCreditsAlertLevel(
        makeCreditsState({
          balance: {
            email: 'e',
            source: 'canopy',
            credits: AI_CREDITS_LOW_BALANCE_WARNING,
            eligible: true,
          },
        }),
        routingOn,
        anyUsage,
      ),
    ).toBe('normal');
  });
});

describe('maxUsageAlertLevel', () => {
  it('returns normal with no levels', () => {
    expect(maxUsageAlertLevel()).toBe('normal');
  });

  it('returns critical when any level is critical', () => {
    expect(maxUsageAlertLevel('normal', 'warning', 'critical')).toBe(
      'critical',
    );
  });

  it('returns warning when the most severe is warning', () => {
    expect(maxUsageAlertLevel('normal', 'warning')).toBe('warning');
  });

  it('returns normal when all levels are normal', () => {
    expect(maxUsageAlertLevel('normal', 'normal')).toBe('normal');
  });
});

describe('usageAlertColorClass', () => {
  it('maps critical to red', () => {
    expect(usageAlertColorClass('critical')).toBe('fg-destructive');
  });

  it('maps warning to amber', () => {
    expect(usageAlertColorClass('warning')).toBe('fg-warning');
  });

  it('maps normal to muted', () => {
    expect(usageAlertColorClass('normal')).toBe('fg-secondary');
  });
});

describe('usageAlertBackgroundClass', () => {
  it('maps critical to red', () => {
    expect(usageAlertBackgroundClass('critical')).toBe('bg-destructive');
  });

  it('maps warning to amber', () => {
    expect(usageAlertBackgroundClass('warning')).toBe('bg-warning');
  });

  it('maps normal to the default usage accent', () => {
    expect(usageAlertBackgroundClass('normal')).toBe('bg-accent');
  });
});

describe('usage alerts with the account proxy', () => {
  function proxyAccount(
    overrides: Partial<AccountProxyAccount> = {},
  ): AccountProxyAccount {
    return {
      authIndex: 'a1f3c2d4a1f3c2d4',
      provider: 'claude',
      label: 'sam@example.com',
      source: 'sign-in',
      fileName: 'claude-sam.json',
      planType: 'max',
      status: 'active',
      statusMessage: null,
      availableAt: null,
      limits: [{ id: 'five-hour', usedPercent: 20, resetsAt: null }],
      ...overrides,
    };
  }

  function proxyStatus(
    accounts: readonly AccountProxyAccount[],
    routes: {
      readonly routeClaude?: boolean;
      readonly routeCodex?: boolean;
    } = {},
  ): AccountProxyStatus {
    return {
      available: true,
      connection: {
        id: 'c1',
        kind: 'server',
        url: 'https://proxy.example.com',
      },
      state: 'connected',
      error: null,
      version: '8.0.28',
      accounts,
      routing: null,
      keepChatOnOneAccount: true,
      routeClaude: routes.routeClaude ?? true,
      routeCodex: routes.routeCodex ?? false,
      refreshedAt: 1,
      local: {
        phase: 'not-installed',
        version: '8.0.28',
        install: null,
        port: null,
        startWithApp: true,
        message: null,
      },
      signIn: null,
    };
  }

  function alert(
    usage: AgentUsageOverview,
    status: AccountProxyStatus,
    aiCreditsRoutingMode: AiCreditsRoutingMode | null = 'off',
  ): ReturnType<typeof computeUsageAlertLevel> {
    return computeUsageAlertLevel(usage, { status, aiCreditsRoutingMode });
  }

  it("ignores the user's own limits for a harness the proxy serves", () => {
    expect(
      alert(
        makeUsage({ provider: 'claude', rateLimits: CRITICAL_LIMITS }),
        proxyStatus([proxyAccount()]),
      ),
    ).toBe('normal');
    expect(
      alert(
        makeUsage({ provider: 'codex', rateLimits: CRITICAL_LIMITS }),
        proxyStatus([proxyAccount()]),
      ),
    ).toBe('critical');
  });

  it('warns for the pool, not for one account at a limit', () => {
    const near = { id: 'five-hour' as const, usedPercent: 85, resetsAt: null };
    expect(
      alert(
        makeUsage(),
        proxyStatus([
          proxyAccount({ status: 'cooling', availableAt: Date.now() + 1000 }),
          proxyAccount({ authIndex: 'b2f3c2d4a1f3c2d4' }),
        ]),
      ),
    ).toBe('normal');
    expect(
      alert(makeUsage(), proxyStatus([proxyAccount({ limits: [near] })])),
    ).toBe('warning');
    expect(
      alert(makeUsage(), proxyStatus([proxyAccount({ status: 'disabled' })])),
    ).toBe('critical');
    expect(alert(makeUsage(), proxyStatus([]))).toBe('normal');
  });

  it('on-quota: a harness routed through the proxy never falls back to AI Credits', () => {
    // Main sends the harness's work to the proxy whatever its pool's state:
    // it waits for an account, or fails when there is none (CAN-4090).
    const usage = makeUsage({ authState: 'unauthenticated' });
    expect(
      isAiCreditsActiveMethod('on-quota', usage, proxyStatus([proxyAccount()])),
    ).toBe(false);
    expect(
      isAiCreditsActiveMethod(
        'on-quota',
        usage,
        proxyStatus([proxyAccount({ status: 'disabled' })]),
      ),
    ).toBe(false);
    expect(isAiCreditsActiveMethod('on-quota', usage, proxyStatus([]))).toBe(
      false,
    );
    // `on` outranks the proxy in main, so it stays active.
    expect(
      isAiCreditsActiveMethod(
        'on',
        usage,
        proxyStatus([proxyAccount({ status: 'disabled' })]),
      ),
    ).toBe(true);
  });

  it('raises no provider alert for a routed harness with no proxy accounts', () => {
    // Codex routes through a proxy that serves only Claude accounts.
    expect(
      alert(makeUsage(), proxyStatus([proxyAccount()], { routeCodex: true })),
    ).toBe('normal');
    expect(alert(makeUsage(), proxyStatus([], { routeCodex: true }))).toBe(
      'normal',
    );
  });

  it('on-quota: an exhausted and an empty proxy pool do not activate AI Credits', () => {
    // Claude's pool is exhausted and the proxy has no Codex accounts, with both
    // harnesses routed through it. Main waits for a Claude account and fails
    // Codex work with "no Codex accounts"; neither runs on AI Credits.
    const status = proxyStatus([proxyAccount({ status: 'disabled' })], {
      routeCodex: true,
    });
    const usage = makeUsage(
      { provider: 'claude', rateLimits: CRITICAL_LIMITS },
      { provider: 'codex', authState: 'unauthenticated' },
    );
    const emptyCredits = makeCreditsState({
      balance: { email: 'e', source: 'canopy', credits: 0, eligible: false },
    });
    expect(isAiCreditsActiveMethod('on-quota', usage, status)).toBe(false);
    expect(
      computeAiCreditsAlertLevel(emptyCredits, 'on-quota', usage, status),
    ).toBe('normal');
    expect(alert(usage, status)).toBe('critical');
  });

  it('on-quota: a natively routed harness out of quota still activates AI Credits', () => {
    // The proxy is connected but routes neither harness, so Claude's own plan
    // decides, exactly as without a proxy.
    const status = proxyStatus([proxyAccount()], {
      routeClaude: false,
      routeCodex: false,
    });
    const usage = makeUsage(
      { provider: 'claude', rateLimits: CRITICAL_LIMITS },
      { provider: 'codex', authState: 'unauthenticated' },
    );
    expect(isAiCreditsActiveMethod('on-quota', usage, status)).toBe(true);
    expect(
      computeAiCreditsAlertLevel(
        makeCreditsState({
          balance: {
            email: 'e',
            source: 'canopy',
            credits: 0,
            eligible: false,
          },
        }),
        'on-quota',
        usage,
        status,
      ),
    ).toBe('critical');
    // While the other harness routes through the proxy, its work still runs
    // there, so AI Credits are not the active method.
    expect(
      isAiCreditsActiveMethod(
        'on-quota',
        usage,
        proxyStatus([], { routeClaude: false, routeCodex: true }),
      ),
    ).toBe(false);
  });

  it('on: leaves the proxy pool out of the alert, as main leaves the proxy out', () => {
    // Main sends every session to AI Credits while the mode is `on`, so a
    // turned-off proxy account is not a problem for this device's work.
    const usage = makeUsage({
      provider: 'claude',
      rateLimits: [{ primary: { usedPercent: 10 } }],
    });
    const disabled = proxyStatus([proxyAccount({ status: 'disabled' })], {
      routeCodex: true,
    });
    expect(alert(usage, disabled, 'on')).toBe('normal');
    expect(
      computeAiCreditsAlertLevel(
        makeCreditsState({
          balance: {
            email: 'e',
            source: 'canopy',
            credits: 50,
            eligible: true,
          },
        }),
        'on',
        usage,
        disabled,
      ),
    ).toBe('normal');
    // The user's own limits bound that work again.
    expect(
      alert(
        makeUsage({ provider: 'claude', rateLimits: CRITICAL_LIMITS }),
        disabled,
        'on',
      ),
    ).toBe('critical');
    // `on-quota` and `off` keep the proxy, so its empty pool stays critical.
    expect(alert(usage, disabled, 'on-quota')).toBe('critical');
    expect(alert(usage, disabled, 'off')).toBe('critical');
  });
});

describe('Claude included allowance precedes extra usage', () => {
  it('does not raise a provider exhaustion alert for an exhausted overage cap', () => {
    const usage = makeUsage({
      rateLimits: [
        { limitId: 'five_hour', primary: { usedPercent: 0 } },
        { limitId: 'seven_day', primary: { usedPercent: 0 } },
        { limitId: 'extra_usage', primary: { usedPercent: 122 } },
      ],
    });
    expect(computeUsageAlertLevel(usage)).toBe('normal');
    expect(isAiCreditsActiveMethod('on-quota', usage)).toBe(false);
  });

  it('keeps warning severity separate from actual exhaustion', () => {
    const usage = makeUsage({
      rateLimits: [
        { limitId: 'five_hour', primary: { usedPercent: 98 } },
        { limitId: 'seven_day', primary: { usedPercent: 30 } },
      ],
    });
    expect(computeUsageAlertLevel(usage)).toBe('critical');
    expect(isAiCreditsActiveMethod('on-quota', usage)).toBe(false);
  });
});
