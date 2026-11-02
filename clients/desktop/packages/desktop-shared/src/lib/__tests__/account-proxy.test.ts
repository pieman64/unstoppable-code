import {
  accountProxyNoUsableAccountsMessage,
  accountProxyHarnessForChat,
  aiCreditsOutrankAccountProxy,
  isAccountProxyReadyForHarness,
  isAccountProxyRoutingStrategy,
  normalizeAccountProxyUrl,
  resolveChatAccountSource,
  resolveProviderAccountSource,
  parseAccountProxyConfigAccounts,
  parseAccountProxyCredentials,
  parseAccountProxyLimits,
  parseAccountProxyPassiveUsage,
  parseAccountProxyRouting,
  parseAccountProxyTraceId,
  parseAccountProxyVersion,
  sortAccountProxyAccounts,
} from '../account-proxy';
import type {
  AccountProxyAccount,
  AccountProxyStatus,
} from '../../types/account-proxy';

// Shapes recorded from CLIProxyAPI v8.0.27 (`GET /v8/management/credentials`
// and `GET /v8/management/config`), trimmed to the fields the parser reads.
const NOW = Date.parse('2026-10-12T11:30:00Z');

const CREDENTIALS = {
  files: [
    {
      account: 'ops@example.com',
      auth_index: '15356e8f5d38e233',
      cooldowns: [],
      disabled: false,
      email: 'ops@example.com',
      label: 'ops@example.com',
      name: 'claude-ops@example.com.json',
      provider: 'claude',
      quota: { signals: {} },
      source: 'file',
      status: 'active',
      status_message: '',
      type: 'claude',
      unavailable: false,
    },
    {
      auth_index: 'cfa0013737935dfc',
      cooldowns: [],
      disabled: false,
      email: 'sam@example.com',
      id_token: { chatgpt_account_id: 'acct_1', plan_type: 'pro' },
      label: 'sam@example.com',
      name: 'codex-sam@example.com-pro.json',
      provider: 'codex',
      quota: { signals: {} },
      status: 'active',
      unavailable: false,
    },
  ],
  observed_at: '2026-10-12T18:53:44.918710097Z',
};

const CONFIG = {
  access: { 'api-keys': ['ck-test-client'] },
  'api-keys': {
    claude: [
      {
        'base-url': 'http://127.0.0.1:18400',
        keys: [{ 'api-key': 'sk-aaaaaa', auth_index: '1010d86d0c820746' }],
        name: 'claude-a',
      },
      {
        keys: [
          { 'api-key': 'sk-bbbbbb', auth_index: 'f56be060e32f388f' },
          { 'api-key': 'sk-cccccc', auth_index: 'a56be060e32f388f' },
        ],
        name: 'claude-b',
      },
    ],
  },
  routing: {
    'session-affinity': true,
    'session-affinity-subagents': true,
    strategy: 'round-robin',
  },
};

describe('normalizeAccountProxyUrl', () => {
  it('adds https and strips paths users paste from the API', () => {
    expect(normalizeAccountProxyUrl('proxy.example.com/')).toEqual({
      ok: true,
      url: 'https://proxy.example.com',
    });
    expect(
      normalizeAccountProxyUrl('https://proxy.example.com/cpa/v8/management'),
    ).toEqual({ ok: true, url: 'https://proxy.example.com/cpa' });
    expect(normalizeAccountProxyUrl('https://proxy.example.com/v1')).toEqual({
      ok: true,
      url: 'https://proxy.example.com',
    });
  });

  it('allows plain HTTP only on loopback', () => {
    expect(normalizeAccountProxyUrl('http://127.0.0.1:8317')).toEqual({
      ok: true,
      url: 'http://127.0.0.1:8317',
    });
    expect(normalizeAccountProxyUrl('http://localhost:8317')).toEqual({
      ok: true,
      url: 'http://localhost:8317',
    });
    expect(normalizeAccountProxyUrl('http://proxy.example.com')).toEqual({
      ok: false,
      code: 'insecure-url',
    });
  });

  it('rejects credentials, queries, and other schemes', () => {
    for (const raw of [
      '',
      'ftp://proxy.example.com',
      'https://user:pass@proxy.example.com',
      'https://proxy.example.com?key=1',
      'https://',
    ]) {
      expect(normalizeAccountProxyUrl(raw).ok).toBe(false);
    }
  });
});

describe('parseAccountProxyVersion', () => {
  it('reads the major version from X-CPA-VERSION', () => {
    expect(parseAccountProxyVersion('8.0.27')).toEqual({
      raw: '8.0.27',
      major: 8,
    });
    expect(parseAccountProxyVersion('v6.9.4')).toEqual({
      raw: '6.9.4',
      major: 6,
    });
    expect(parseAccountProxyVersion(null)).toBeNull();
    expect(parseAccountProxyVersion('dev')).toBeNull();
  });
});

describe('parseAccountProxyTraceId', () => {
  it('returns the account that served the request', () => {
    expect(
      parseAccountProxyTraceId(
        '20261012195407-F56BE060E32F388F-01a13177-0994-7245-82a6-b4728af4bc7d',
      ),
    ).toEqual({
      authIndex: 'f56be060e32f388f',
      requestId: '01a13177-0994-7245-82a6-b4728af4bc7d',
    });
  });

  it('ignores malformed headers', () => {
    expect(parseAccountProxyTraceId(undefined)).toBeNull();
    expect(parseAccountProxyTraceId('abc')).toBeNull();
    expect(parseAccountProxyTraceId('20261012195407-xyz-req')).toBeNull();
  });
});

describe('parseAccountProxyCredentials', () => {
  it('maps signed-in accounts', () => {
    expect(parseAccountProxyCredentials(CREDENTIALS, NOW)).toEqual([
      {
        authIndex: '15356e8f5d38e233',
        provider: 'claude',
        label: 'ops@example.com',
        source: 'sign-in',
        fileName: 'claude-ops@example.com.json',
        planType: null,
        status: 'active',
        statusMessage: null,
        availableAt: null,
        limits: [],
      },
      {
        authIndex: 'cfa0013737935dfc',
        provider: 'codex',
        label: 'sam@example.com',
        source: 'sign-in',
        fileName: 'codex-sam@example.com-pro.json',
        planType: 'pro',
        status: 'active',
        statusMessage: null,
        availableAt: null,
        limits: [],
      },
    ]);
  });

  it('reports a credential cooldown as cooling with its end', () => {
    const retryAt = '2026-10-12T13:15:00Z';
    const [account] = parseAccountProxyCredentials(
      {
        files: [
          {
            ...CREDENTIALS.files[0],
            status: 'error',
            unavailable: true,
            next_retry_after: retryAt,
            cooldowns: [
              { scope: 'credential', reason: 'quota', retry_at: retryAt },
              {
                scope: 'model',
                model_key: 'claude-opus',
                retry_at: '2026-10-12T12:00:00Z',
              },
            ],
          },
        ],
      },
      NOW,
    );
    expect(account?.status).toBe('cooling');
    expect(account?.availableAt).toBe(Date.parse(retryAt));
  });

  it('keeps an account usable when only one model cools down', () => {
    const [account] = parseAccountProxyCredentials(
      {
        files: [
          {
            ...CREDENTIALS.files[0],
            cooldowns: [
              {
                scope: 'model',
                model_key: 'claude-opus',
                retry_at: '2026-10-12T12:00:00Z',
              },
            ],
          },
        ],
      },
      NOW,
    );
    expect(account?.status).toBe('active');
  });

  it('distinguishes turned-off and failed accounts', () => {
    const accounts = parseAccountProxyCredentials(
      {
        files: [
          { ...CREDENTIALS.files[0], disabled: true },
          {
            ...CREDENTIALS.files[1],
            status: 'error',
            status_message: 'token expired',
          },
        ],
      },
      NOW,
    );
    expect(accounts.map((account) => account.status)).toEqual([
      'disabled',
      'error',
    ]);
    expect(accounts[1]?.statusMessage).toBe('token expired');
  });

  it('skips entries it cannot act on', () => {
    expect(
      parseAccountProxyCredentials(
        { files: [{ provider: 'claude' }, null, 'x', { auth_index: 'zz' }] },
        NOW,
      ),
    ).toEqual([]);
    expect(parseAccountProxyCredentials({ files: 'x' }, NOW)).toEqual([]);
  });
});

describe('parseAccountProxyConfigAccounts', () => {
  it('lists one account per key without reading the key', () => {
    const accounts = parseAccountProxyConfigAccounts(CONFIG);
    expect(accounts.map((account) => account.label)).toEqual([
      'claude-a',
      'claude-b · key 1',
      'claude-b · key 2',
    ]);
    expect(accounts[0]).toEqual({
      authIndex: '1010d86d0c820746',
      provider: 'claude',
      label: 'claude-a',
      source: 'api-key',
      fileName: null,
      planType: null,
      status: 'active',
      statusMessage: null,
      availableAt: null,
      limits: [],
    });
    expect(JSON.stringify(accounts)).not.toContain('sk-');
  });
});

describe('parseAccountProxyRouting', () => {
  it('reads the routing block, defaulting to the proxy defaults', () => {
    expect(parseAccountProxyRouting(CONFIG)).toEqual({
      strategy: 'round-robin',
      sessionAffinity: true,
    });
    expect(parseAccountProxyRouting({})).toEqual({
      strategy: 'round-robin',
      sessionAffinity: false,
    });
  });

  it.each([
    ['round-robin', 'round-robin'],
    ['weighted-round-robin', 'weighted-round-robin'],
    ['fill-first', 'fill-first'],
    [' Fill-First ', 'fill-first'],
    ['wrr', 'weighted-round-robin'],
    ['fillfirst', 'fill-first'],
    ['ff', 'fill-first'],
    ['rr', 'round-robin'],
    ['', 'round-robin'],
    ['bogus', 'round-robin'],
  ])('reads strategy %j as the proxy runs it: %s', (value, strategy) => {
    expect(
      parseAccountProxyRouting({ routing: { strategy: value } }).strategy,
    ).toBe(strategy);
  });
});

describe('isAccountProxyRoutingStrategy', () => {
  it('accepts only the canonical strategy names', () => {
    expect(isAccountProxyRoutingStrategy('round-robin')).toBe(true);
    expect(isAccountProxyRoutingStrategy('weighted-round-robin')).toBe(true);
    expect(isAccountProxyRoutingStrategy('fill-first')).toBe(true);
    expect(isAccountProxyRoutingStrategy('ff')).toBe(false);
    expect(isAccountProxyRoutingStrategy('Fill-First')).toBe(false);
    expect(isAccountProxyRoutingStrategy(null)).toBe(false);
  });
});

describe('parseAccountProxyLimits', () => {
  it('reads Claude unified limits as percentages', () => {
    const reset = Math.floor(NOW / 1000) + 2 * 3600;
    expect(
      parseAccountProxyLimits(
        'claude',
        {
          signals: {
            'anthropic-ratelimit-unified-5h-utilization': '0.64',
            'anthropic-ratelimit-unified-5h-reset': String(reset),
            'anthropic-ratelimit-unified-7d-utilization': '0.381',
            'anthropic-ratelimit-unified-7d-status': 'allowed',
          },
        },
        NOW,
      ),
    ).toEqual([
      { id: 'five-hour', usedPercent: 64, resetsAt: reset * 1000 },
      { id: 'weekly', usedPercent: 38, resetsAt: null },
    ]);
  });

  it('reads Claude quota signals with canonical HTTP header casing', () => {
    const reset = Math.floor(NOW / 1000) + 2 * 3600;
    expect(
      parseAccountProxyLimits(
        'claude',
        {
          signals: {
            'Anthropic-Ratelimit-Unified-5h-Utilization': '0.64',
            'Anthropic-Ratelimit-Unified-5h-Reset': String(reset),
          },
        },
        NOW,
      ),
    ).toEqual([{ id: 'five-hour', usedPercent: 64, resetsAt: reset * 1000 }]);
  });

  it('reads Codex primary and secondary windows', () => {
    expect(
      parseAccountProxyLimits(
        'codex',
        {
          observed_at: new Date(NOW - 300_000).toISOString(),
          signals: {
            'x-codex-primary-used-percent': '22',
            'x-codex-primary-window-minutes': '300',
            'x-codex-primary-reset-after-seconds': '600',
            'x-codex-secondary-used-percent': '54',
            'x-codex-secondary-window-minutes': '10080',
          },
        },
        NOW,
      ),
    ).toEqual([
      { id: 'five-hour', usedPercent: 22, resetsAt: NOW + 300_000 },
      { id: 'weekly', usedPercent: 54, resetsAt: null },
    ]);
  });

  it('reads Codex quota signals with canonical HTTP header casing', () => {
    expect(
      parseAccountProxyLimits(
        'codex',
        {
          observed_at: new Date(NOW - 300_000).toISOString(),
          signals: {
            'X-Codex-Primary-Used-Percent': '22',
            'X-Codex-Primary-Window-Minutes': '300',
            'X-Codex-Primary-Reset-After-Seconds': '600',
            'X-Codex-Secondary-Used-Percent': '54',
            'X-Codex-Secondary-Window-Minutes': '10080',
          },
        },
        NOW,
      ),
    ).toEqual([
      { id: 'five-hour', usedPercent: 22, resetsAt: NOW + 300_000 },
      { id: 'weekly', usedPercent: 54, resetsAt: null },
    ]);
  });

  it('builds passive usage from canonical headers and the actual observation time', () => {
    expect(
      parseAccountProxyPassiveUsage('claude', {
        observed_at: '2026-10-12T11:00:00.000Z',
        signals: {
          'Anthropic-Ratelimit-Unified-5h-Utilization': '0.64',
          'Anthropic-Ratelimit-Unified-5h-Reset': String(
            Math.floor(NOW / 1000) + 7200,
          ),
          'Anthropic-Ratelimit-Unified-7d-Utilization': '0.381',
        },
      }),
    ).toEqual({
      source: 'passive',
      lastUpdatedAt: '2026-10-12T11:00:00.000Z',
      rateLimits: [
        {
          limitId: 'five-hour',
          limitName: '5-hour window',
          primary: {
            usedPercent: 64,
            resetsAt: new Date(
              (Math.floor(NOW / 1000) + 7200) * 1000,
            ).toISOString(),
            windowDurationMins: 300,
          },
        },
        {
          limitId: 'weekly',
          limitName: '7-day window',
          primary: { usedPercent: 38, windowDurationMins: 10080 },
        },
      ],
    });
  });

  it('keeps reported Codex windows distinct and names their actual durations', () => {
    expect(
      parseAccountProxyPassiveUsage('codex', {
        signals: {
          'X-Codex-Primary-Used-Percent': '20',
          'X-Codex-Primary-Window-Minutes': '1440',
          'X-Codex-Secondary-Used-Percent': '40',
          'X-Codex-Secondary-Window-Minutes': '300',
        },
      }),
    ).toEqual({
      source: 'passive',
      rateLimits: [
        {
          limitId: 'primary',
          limitName: 'Codex',
          primary: { usedPercent: 20, windowDurationMins: 1440 },
        },
        {
          limitId: 'secondary',
          limitName: 'Codex',
          secondary: { usedPercent: 40, windowDurationMins: 300 },
        },
      ],
    });
  });

  it('does not invent a passive observation timestamp', () => {
    expect(
      parseAccountProxyPassiveUsage('codex', {
        signals: { 'X-Codex-Primary-Used-Percent': '20' },
      }),
    ).toEqual({
      source: 'passive',
      rateLimits: [
        {
          limitId: 'primary',
          limitName: 'Codex',
          primary: { usedPercent: 20 },
        },
      ],
    });
  });

  it('counts a relative reset from when the proxy saw it, not from the poll', () => {
    const quota = {
      observed_at: new Date(NOW).toISOString(),
      signals: {
        'x-codex-primary-used-percent': '100',
        'x-codex-primary-window-minutes': '300',
        'x-codex-primary-reset-after-seconds': '600',
      },
    };
    const first = parseAccountProxyLimits('codex', quota, NOW);
    const later = parseAccountProxyLimits('codex', quota, NOW + 5 * 60_000);
    expect(later).toEqual(first);
    // Once the window has reset, the old signal no longer counts.
    expect(parseAccountProxyLimits('codex', quota, NOW + 15 * 60_000)).toEqual(
      [],
    );
    // Without the time it was seen, the reset time is unknown.
    expect(
      parseAccountProxyLimits('codex', { signals: quota.signals }, NOW),
    ).toEqual([{ id: 'five-hour', usedPercent: 100, resetsAt: null }]);
  });

  it('drops limits that already reset and other providers', () => {
    expect(
      parseAccountProxyLimits(
        'claude',
        {
          signals: {
            'anthropic-ratelimit-unified-5h-utilization': '1',
            'anthropic-ratelimit-unified-5h-reset': String(
              Math.floor(NOW / 1000) - 60,
            ),
          },
        },
        NOW,
      ),
    ).toEqual([]);
    expect(
      parseAccountProxyLimits(
        'kimi',
        { signals: { 'x-codex-primary-used-percent': '5' } },
        NOW,
      ),
    ).toEqual([]);
  });
});

describe('sortAccountProxyAccounts', () => {
  it('lists sign-ins before API keys and drops duplicates', () => {
    const signIns = parseAccountProxyCredentials(CREDENTIALS, NOW);
    const keys = parseAccountProxyConfigAccounts(CONFIG);
    const sorted = sortAccountProxyAccounts([...keys, ...signIns, ...signIns]);
    expect(sorted.map((account) => account.label)).toEqual([
      'ops@example.com',
      'sam@example.com',
      'claude-a',
      'claude-b · key 1',
      'claude-b · key 2',
    ]);
  });
});

describe('isAccountProxyReadyForHarness', () => {
  const account: AccountProxyAccount = {
    authIndex: 'a1f3c2d4a1f3c2d4',
    provider: 'claude',
    label: 'Team key',
    source: 'api-key',
    fileName: null,
    planType: null,
    status: 'active',
    statusMessage: null,
    availableAt: null,
    limits: [],
  };
  const status: AccountProxyStatus = {
    available: true,
    connection: { id: 'c1', kind: 'server', url: 'https://proxy.example.com' },
    state: 'connected',
    error: null,
    version: '8.0.27',
    accounts: [account],
    routing: null,
    keepChatOnOneAccount: true,
    routeClaude: true,
    routeCodex: true,
    refreshedAt: 1,
    local: {
      phase: 'stopped',
      version: null,
      install: null,
      port: null,
      startWithApp: true,
      message: null,
    },
    signIn: null,
  };

  it('is ready only for a harness with a ready account and routing on', () => {
    expect(isAccountProxyReadyForHarness(status, 'claude')).toBe(true);
    expect(isAccountProxyReadyForHarness(status, 'codex')).toBe(false);
    expect(
      isAccountProxyReadyForHarness(
        { ...status, routeClaude: false },
        'claude',
      ),
    ).toBe(false);
    expect(
      isAccountProxyReadyForHarness(
        { ...status, accounts: [{ ...account, status: 'cooling' }] },
        'claude',
      ),
    ).toBe(false);
  });

  it('is never ready while off, disconnected, or failing', () => {
    expect(isAccountProxyReadyForHarness(null, 'claude')).toBe(false);
    expect(
      isAccountProxyReadyForHarness({ ...status, available: false }, 'claude'),
    ).toBe(false);
    expect(
      isAccountProxyReadyForHarness(
        { ...status, state: 'needs-key' },
        'claude',
      ),
    ).toBe(false);
    expect(
      isAccountProxyReadyForHarness(
        {
          ...status,
          state: 'error',
          error: { code: 'unreachable', message: 'unreachable' },
        },
        'claude',
      ),
    ).toBe(false);
  });
});

describe('resolveProviderAccountSource', () => {
  const status: AccountProxyStatus = {
    available: true,
    connection: { id: 'c1', kind: 'server', url: 'https://proxy.example.com' },
    state: 'connected',
    error: null,
    version: '8.0.28',
    accounts: [],
    routing: null,
    keepChatOnOneAccount: true,
    routeClaude: true,
    routeCodex: false,
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

  const device = (
    deviceStatus: AccountProxyStatus | null,
    harness: 'claude' | 'codex',
    aiCreditsRoutingMode: 'off' | 'on' | 'on-quota' | null = 'off',
  ): string =>
    resolveProviderAccountSource({
      status: deviceStatus,
      harness,
      aiCreditsRoutingMode,
    });
  const chat = (
    overrides: Partial<Parameters<typeof resolveChatAccountSource>[0]> = {},
  ): string =>
    resolveChatAccountSource({
      status,
      providerType: 'claude',
      model: 'claude-sonnet-4-5',
      sessionAccountProxyRouted: undefined,
      aiCreditsRoutingMode: 'off',
      chatChoseAiCredits: false,
      ...overrides,
    });

  it('follows the proxy for a routed harness, even before an account is ready', () => {
    expect(device(status, 'claude')).toBe('account-proxy');
    expect(device(status, 'codex')).toBe('native');
  });

  it('keeps the native sign-in while the proxy is off, unreachable, or stopped', () => {
    expect(device(null, 'claude')).toBe('native');
    expect(device({ ...status, available: false }, 'claude')).toBe('native');
    expect(
      device(
        {
          ...status,
          state: 'error',
          error: { code: 'unreachable', message: 'unreachable' },
        },
        'claude',
      ),
    ).toBe('native');
    const local: AccountProxyStatus = {
      ...status,
      connection: { id: 'c1', kind: 'local', url: 'http://127.0.0.1:8411' },
    };
    expect(device(local, 'claude')).toBe('native');
    expect(
      device(
        { ...local, local: { ...local.local, phase: 'running', port: 8411 } },
        'claude',
      ),
    ).toBe('account-proxy');
  });

  it('leaves the proxy out while AI Credits route every session, as main does', () => {
    // Main skips the proxy whenever the global mode is `on`, whatever the
    // credit balance; `on-quota` and `off` keep it.
    expect(device(status, 'claude', 'on')).toBe('native');
    expect(device(status, 'claude', 'on-quota')).toBe('account-proxy');
    expect(device(status, 'claude', null)).toBe('account-proxy');
    expect(chat({ aiCreditsRoutingMode: 'on' })).toBe('native');
    expect(chat({ aiCreditsRoutingMode: 'on-quota' })).toBe('account-proxy');
    // A per-chat subscription choice keeps the global mode from applying.
    expect(
      chat({ aiCreditsRoutingMode: 'on', subscriptionBillingOverride: true }),
    ).toBe('account-proxy');
    // AI Credits chosen for the chat outrank the proxy in every mode.
    expect(chat({ chatChoseAiCredits: true })).toBe('native');
  });

  it("lets a chat's session route outrank the device route", () => {
    expect(chat({ sessionAccountProxyRouted: false })).toBe('native');
    expect(
      chat({
        status: null,
        providerType: 'codex',
        model: 'gpt-5.1-codex',
        sessionAccountProxyRouted: true,
      }),
    ).toBe('account-proxy');
    expect(chat()).toBe('account-proxy');
  });

  it('routes only Claude Code and Codex chats through the proxy', () => {
    const both: AccountProxyStatus = { ...status, routeCodex: true };
    // main/opencode-session.ts has no proxy route, so an OpenCode chat on an
    // Anthropic model keeps its own billing.
    expect(
      accountProxyHarnessForChat({
        providerType: 'opencode',
        model: 'opencode:anthropic%2Fclaude-sonnet-4-5',
      }),
    ).toBeNull();
    expect(
      chat({
        status: both,
        providerType: 'opencode',
        model: 'opencode:anthropic%2Fclaude-sonnet-4-5',
      }),
    ).toBe('native');
    for (const providerType of ['cursor', 'copilot', 'ollama'] as const) {
      expect(
        accountProxyHarnessForChat({ providerType, model: 'some-model' }),
      ).toBeNull();
      expect(chat({ status: both, providerType })).toBe('native');
    }
    // Ollama models stay on this device even on the Claude harness.
    expect(
      accountProxyHarnessForChat({
        providerType: 'claude',
        model: 'ollama-llama3',
      }),
    ).toBeNull();
    expect(
      accountProxyHarnessForChat({
        providerType: 'codex',
        model: 'gpt-5.1-codex',
      }),
    ).toBe('codex');
    expect(chat({ status: both, providerType: 'codex' })).toBe('account-proxy');
  });
});

describe('aiCreditsOutrankAccountProxy', () => {
  it('lets AI Credits chosen for the chat or for every session outrank the proxy', () => {
    expect(
      aiCreditsOutrankAccountProxy({
        chatChoseAiCredits: true,
        routingMode: 'off',
        subscriptionBillingOverride: true,
      }),
    ).toBe(true);
    expect(
      aiCreditsOutrankAccountProxy({
        chatChoseAiCredits: false,
        routingMode: 'on',
      }),
    ).toBe(true);
  });

  it('keeps the proxy for on-quota, off, and a per-chat subscription choice', () => {
    for (const routingMode of ['on-quota', 'off', null] as const) {
      expect(
        aiCreditsOutrankAccountProxy({
          chatChoseAiCredits: false,
          routingMode,
        }),
      ).toBe(false);
    }
    expect(
      aiCreditsOutrankAccountProxy({
        chatChoseAiCredits: false,
        routingMode: 'on',
        subscriptionBillingOverride: true,
      }),
    ).toBe(false);
  });
});

describe('accountProxyNoUsableAccountsMessage', () => {
  const account: AccountProxyAccount = {
    authIndex: 'a1f3c2d4a1f3c2d4',
    provider: 'claude',
    label: 'sam@example.com',
    source: 'sign-in',
    fileName: 'claude-sam.json',
    planType: 'max',
    status: 'active',
    statusMessage: null,
    availableAt: null,
    limits: [],
  };

  it('tells the user to add an account when the harness has none', () => {
    expect(accountProxyNoUsableAccountsMessage([], 'claude')).toBe(
      'The account proxy has no Claude accounts. Add one in Settings > Multi-account proxy, or turn off Use for Claude there.',
    );
    expect(accountProxyNoUsableAccountsMessage([account], 'codex')).toBe(
      'The account proxy has no Codex accounts. Add one in Settings > Multi-account proxy, or turn off Use for Codex there.',
    );
  });

  it('tells the user to fix accounts that are turned off or signed out', () => {
    expect(
      accountProxyNoUsableAccountsMessage(
        [
          { ...account, status: 'disabled' },
          {
            ...account,
            authIndex: 'b',
            status: 'error',
            statusMessage: '401 Unauthorized: token expired',
          },
        ],
        'claude',
      ),
    ).toBe(
      "None of the account proxy's Claude accounts can be used. Turn one on or sign in again in Settings > Multi-account proxy, or turn off Use for Claude there.",
    );
  });

  it('leaves accounts that can recover on their own to the quota wait', () => {
    for (const waiting of [
      account,
      { ...account, status: 'cooling' as const, availableAt: NOW + 60_000 },
      { ...account, status: 'pending' as const },
      { ...account, status: 'refreshing' as const },
      {
        ...account,
        status: 'error' as const,
        statusMessage: '429 usage_limit_reached',
      },
    ]) {
      expect(
        accountProxyNoUsableAccountsMessage(
          [{ ...account, status: 'disabled' }, waiting],
          'claude',
        ),
      ).toBeNull();
    }
  });
});
