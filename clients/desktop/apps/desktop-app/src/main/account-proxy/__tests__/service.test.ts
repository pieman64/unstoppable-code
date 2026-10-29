import type { PreferencesData } from '@canopy/desktop-shared/types';
import type { AccountProxyCredentials } from '../../lib/account-proxy-credential-store';

let preferences: Partial<PreferencesData> = {};
const storedCredentials = new Map<string, AccountProxyCredentials>();
let flagEnabled = true;
/** False while the flag shows a fallback, not a value LaunchDarkly served. */
let flagSettled = true;
let saveGate: Promise<void> = Promise.resolve();
let loadGate: Promise<void> = Promise.resolve();
let credentialReadError: Error | null = null;
/** Holds only the next settings read until released. */
let nextReadGate: Promise<void> | null = null;

jest.mock('../../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(async () => {
    const gate = nextReadGate;
    nextReadGate = null;
    await gate;
    return preferences;
  }),
  updatePreferencesFile: jest.fn(
    (
      updater: (current: Partial<PreferencesData>) => Partial<PreferencesData>,
    ) => {
      preferences = updater(preferences);
      return Promise.resolve(preferences);
    },
  ),
}));

jest.mock('../../lib/account-proxy-credential-store', () => ({
  AccountProxyStorageUnavailableError: class extends Error {},
  loadAccountProxyCredentials: jest.fn(async (id: string) => {
    if (credentialReadError) throw credentialReadError;
    const credentials = storedCredentials.get(id) ?? null;
    await loadGate;
    return credentials;
  }),
  saveAccountProxyCredentials: jest.fn(
    async (id: string, credentials: AccountProxyCredentials) => {
      await saveGate;
      storedCredentials.set(id, credentials);
    },
  ),
  deleteAccountProxyCredentials: jest.fn((id: string) => {
    storedCredentials.delete(id);
    return Promise.resolve();
  }),
  markAccountProxyKeyRejected: jest.fn(
    (
      id: string,
      keyRejection: AccountProxyCredentials['keyRejection'],
      rejectedKey: string,
    ) => {
      // Like the real store, a rejection only lands on the key it is about.
      const current = storedCredentials.get(id);
      if (current && current.managementKey === rejectedKey)
        storedCredentials.set(id, { ...current, keyRejection });
      return Promise.resolve();
    },
  ),
}));

jest.mock('../../lib/window-send', () => ({ sendToAllWindows: jest.fn() }));
jest.mock('../../lib/open-external', () => ({
  openExternalGuarded: jest.fn(() => Promise.resolve()),
}));

/** The proxy on this device, standing in for the process the runtime owns. */
interface MockLocal {
  phase: 'unsupported' | 'not-installed' | 'running' | 'stopped' | 'error';
  port: number | null;
  /** The port the next start lands on; null keeps the preferred one. */
  nextPort: number | null;
  startError: Error | null;
  /** Holds the next start open until released. */
  startGate: Promise<void> | null;
  /** Holds port selection for a new local connection until released. */
  portGate: Promise<void> | null;
  /** Holds the runtime status read until released. */
  runtimeGate: Promise<void> | null;
  /** Fails port selection for a new local connection. */
  portError: Error | null;
  /** Holds stops open until released; the proxy runs until then. */
  stopGate: Promise<void> | null;
}
/** Runtime change listeners, so a test can report the proxy exiting. */
const mockLocalListeners = new Set<() => void>();
const mockLocal: MockLocal = {
  phase: 'not-installed',
  port: null,
  nextPort: null,
  startError: null,
  startGate: null,
  portGate: null,
  runtimeGate: null,
  portError: null,
  stopGate: null,
};
jest.mock('../local-runtime', () => {
  class LocalAccountProxyError extends Error {
    constructor(
      readonly code: 'local-unsupported' | 'local-failed',
      message: string,
    ) {
      super(message);
    }
  }
  return {
    LocalAccountProxyError,
    getLocalAccountProxyRuntime: jest.fn(async (startWithApp: boolean) => {
      await mockLocal.runtimeGate;
      return {
        phase: mockLocal.phase,
        version: mockLocal.phase === 'unsupported' ? null : '8.0.28',
        install: null,
        port: mockLocal.phase === 'running' ? mockLocal.port : null,
        startWithApp,
        message: null,
      };
    }),
    getLocalAccountProxyPort: jest.fn(() =>
      mockLocal.phase === 'running' ? mockLocal.port : null,
    ),
    onLocalAccountProxyChanged: jest.fn((listener: () => void) => {
      mockLocalListeners.add(listener);
      return (): void => {
        mockLocalListeners.delete(listener);
      };
    }),
    pickLocalAccountProxyPort: jest.fn(async () => {
      await mockLocal.portGate;
      if (mockLocal.portError) throw mockLocal.portError;
      return 18555;
    }),
    isLocalAccountProxyStarting: jest.fn(() => mockLocal.startGate !== null),
    startLocalAccountProxy: jest.fn(
      async (launch: { preferredPort: number | null }) => {
        await mockLocal.startGate;
        if (mockLocal.startError) {
          mockLocal.phase = 'error';
          throw mockLocal.startError;
        }
        mockLocal.phase = 'running';
        mockLocal.port = mockLocal.nextPort ?? launch.preferredPort ?? 18555;
        return mockLocal.port;
      },
    ),
    stopLocalAccountProxy: jest.fn(async () => {
      await mockLocal.stopGate;
      mockLocal.phase = 'stopped';
      mockLocal.port = null;
    }),
  };
});
jest.mock('../feature-flag', () => ({
  isAccountProxyFlagEnabled: (): boolean => flagEnabled,
  isAccountProxyFlagSettled: (): boolean => flagSettled,
}));

import { accountProxyClientKeyFingerprint } from '../client-key';
import { saveAccountProxyCredentials } from '../../lib/account-proxy-credential-store';
import {
  LocalAccountProxyError,
  startLocalAccountProxy,
  stopLocalAccountProxy,
} from '../local-runtime';
import { openExternalGuarded } from '../../lib/open-external';
import type { AccountProxySignInPageRequest } from '../remote-sign-in';
import {
  completeRemoteAccountProxySignIn,
  controlLocalAccountProxy,
  signInLocalAccountProxyAccount,
  initializeLocalAccountProxy,
  publishAccountProxyStatus,
  setUpLocalAccountProxy,
  accountProxyServingSignal,
  connectAccountProxy,
  getAccountProxyRouteTarget,
  accountProxySettingsSignature,
  reportAccountProxyClientKeyRejected,
  disconnectAccountProxy,
  findAccountProxyAccount,
  getAccountProxyStatus,
  removeAccountProxyAccount,
  resetAccountProxyServiceForTests,
  setAccountProxyAccountDisabled,
  setAccountProxyRoutingStrategy,
  getAccountProxyUsageInventory,
  fetchAccountProxyUsage,
  onAccountProxyInventoryChanged,
} from '../service';

const VERSION = { 'x-cpa-version': '8.0.27' };

const CREDENTIALS = {
  files: [
    {
      auth_index: '15356e8f5d38e233',
      email: 'ops@example.com',
      name: 'claude-ops@example.com.json',
      provider: 'claude',
      status: 'active',
      cooldowns: [],
      quota: { signals: {} },
    },
  ],
};

const CONFIG = {
  'api-keys': {
    claude: [
      {
        name: 'team-key',
        keys: [{ 'api-key': 'sk-secret', auth_index: '1010d86d0c820746' }],
      },
    ],
  },
  routing: { strategy: 'fill-first', 'session-affinity': true },
};

let clientKeys: string[] = [];

type Route = (init: RequestInit | undefined) => Response | Promise<Response>;

describe('account proxy service', () => {
  const routes = new Map<string, Route>();
  let credentialsBody: unknown = CREDENTIALS;
  const fetchMock = jest.fn(
    (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const key = `${init?.method ?? 'GET'} ${url}`;
      const route = routes.get(key);
      if (!route) return Promise.reject(new TypeError(`fetch failed: ${key}`));
      return Promise.resolve(route(init));
    },
  );

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: VERSION });
  }

  beforeEach(() => {
    saveGate = Promise.resolve();
    loadGate = Promise.resolve();
    credentialReadError = null;
    nextReadGate = null;
    preferences = { accountProxyEnabled: true };
    storedCredentials.clear();
    flagEnabled = true;
    flagSettled = true;
    routes.clear();
    credentialsBody = CREDENTIALS;
    fetchMock.mockClear();
    resetAccountProxyServiceForTests();
    mockLocal.phase = 'not-installed';
    mockLocal.port = null;
    mockLocal.nextPort = null;
    mockLocal.startError = null;
    mockLocal.startGate = null;
    mockLocal.portGate = null;
    mockLocal.runtimeGate = null;
    mockLocal.portError = null;
    mockLocal.stopGate = null;
    jest.mocked(startLocalAccountProxy).mockClear();
    jest.mocked(stopLocalAccountProxy).mockClear();
    jest.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);
    routes.set('GET https://proxy.example.com/v8/management/credentials', () =>
      json(credentialsBody),
    );
    routes.set('GET https://proxy.example.com/v8/management/config', () =>
      json(CONFIG),
    );
    clientKeys = ['ck-other-device'];
    routes.set(
      'GET https://proxy.example.com/v8/management/config/access/api-keys',
      () => json(clientKeys),
    );
    routes.set(
      'PUT https://proxy.example.com/v8/management/config/access/api-keys',
      (init) => {
        const next: unknown = JSON.parse(
          typeof init?.body === 'string' ? init.body : '[]',
        );
        clientKeys = Array.isArray(next)
          ? next.filter((key): key is string => typeof key === 'string')
          : clientKeys;
        return json({ status: 'ok' });
      },
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('refreshes quota only on request and keeps a nested provider 401 account-scoped', async () => {
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    routes.set(
      'POST https://proxy.example.com/v8/management/requests/api-call',
      () =>
        json({
          status_code: 401,
          header: {},
          body: JSON.stringify({ error: 'invalid_token' }),
        }),
    );
    fetchMock.mockClear();

    await getAccountProxyStatus({ refresh: true });
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST'),
    ).toHaveLength(0);

    const explicitUsageRefresh = { refresh: false, refreshUsage: true };
    const status = await getAccountProxyStatus(explicitUsageRefresh);
    const quotaRequests = fetchMock.mock.calls.filter(
      ([, init]) => init?.method === 'POST',
    );
    expect(quotaRequests).toHaveLength(1);
    const [url, init] = quotaRequests[0] ?? [];
    expect(url).toBe(
      'https://proxy.example.com/v8/management/requests/api-call',
    );
    expect(init?.body).toEqual(
      expect.stringContaining('"auth_index":"15356e8f5d38e233"'),
    );
    expect(init?.body).toEqual(
      expect.stringContaining('https://api.anthropic.com/api/oauth/usage'),
    );
    expect(init?.body).toEqual(expect.stringContaining('Bearer $TOKEN$'));
    expect(init?.body).toEqual(
      expect.stringContaining(
        '"anthropic-beta":"claude-code-20250219,oauth-2025-04-20"',
      ),
    );
    expect(init?.body).toEqual(
      expect.stringContaining('"anthropic-version":"2023-06-01"'),
    );
    expect(init?.body).not.toEqual(expect.stringContaining('sk-secret'));
    expect(status).toMatchObject({ state: 'connected', error: null });
    expect(
      status.accounts.find(
        (account) => account.authIndex === '15356e8f5d38e233',
      ),
    ).toMatchObject({ usage: { errorInfo: { kind: 'auth' } } });
    const connectionId = preferences.accountProxyConnection?.id ?? '';
    expect(storedCredentials.get(connectionId)?.keyRejection).toBeUndefined();
  });

  it('reads each Claude account type from its own OAuth profile without exposing profile identity', async () => {
    credentialsBody = {
      files: [
        {
          ...CREDENTIALS.files[0],
          auth_index: '15356e8f5d38e233',
        },
        {
          ...CREDENTIALS.files[0],
          auth_index: 'aabbccdd11223344',
          email: 'team@example.com',
          name: 'claude-team@example.com.json',
        },
      ],
    };
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    routes.set(
      'POST https://proxy.example.com/v8/management/requests/api-call',
      (init) => {
        const requestBody = typeof init?.body === 'string' ? init.body : '';
        const isProfile = requestBody.includes('/api/oauth/profile');
        const isTeam = requestBody.includes('aabbccdd11223344');
        return json({
          status_code: 200,
          header: {},
          body: JSON.stringify(
            isProfile
              ? {
                  account: {
                    email: 'profile-only-private@example.com',
                  },
                  organization: {
                    organization_type: isTeam ? 'claude_team' : 'claude_max',
                    rate_limit_tier: isTeam
                      ? 'default_claude_max_5x'
                      : 'default_claude_max_20x',
                  },
                }
              : { five_hour: { utilization: isTeam ? 15 : 85 } },
          ),
        });
      },
    );
    fetchMock.mockClear();

    const status = await getAccountProxyStatus({ refreshUsage: true });

    expect(
      status.accounts.find(
        (account) => account.authIndex === '15356e8f5d38e233',
      ),
    ).toMatchObject({ planType: 'default_claude_max_20x' });
    expect(
      status.accounts.find(
        (account) => account.authIndex === 'aabbccdd11223344',
      ),
    ).toMatchObject({ planType: 'team-premium' });
    expect(
      fetchMock.mock.calls.filter(
        ([, init]) =>
          typeof init?.body === 'string' &&
          init.body.includes('/api/oauth/profile'),
      ),
    ).toHaveLength(2);
    expect(JSON.stringify(status)).not.toContain(
      'profile-only-private@example.com',
    );
    expect(JSON.stringify(status)).not.toContain('rate_limit_tier');
  });

  it('latches a management-key refusal during a Claude profile read', async () => {
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    routes.set(
      'POST https://proxy.example.com/v8/management/requests/api-call',
      (init) =>
        typeof init?.body === 'string' &&
        init.body.includes('/api/oauth/profile')
          ? json({ error: 'invalid management key' }, 401)
          : json({
              status_code: 200,
              body: JSON.stringify({ five_hour: { utilization: 42 } }),
            }),
    );
    await getAccountProxyStatus({ refreshUsage: true });
    const connectionId = preferences.accountProxyConnection?.id ?? '';
    expect(storedCredentials.get(connectionId)?.keyRejection).toBeDefined();
    fetchMock.mockClear();
    await getAccountProxyStatus({ refreshUsage: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps Claude quota windows when its OAuth profile is unavailable', async () => {
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    routes.set(
      'POST https://proxy.example.com/v8/management/requests/api-call',
      (init) =>
        json({
          status_code:
            typeof init?.body === 'string' &&
            init.body.includes('/api/oauth/profile')
              ? 503
              : 200,
          header: {},
          body: JSON.stringify({ five_hour: { utilization: 42 } }),
        }),
    );

    const status = await getAccountProxyStatus({ refreshUsage: true });

    expect(status.accounts[0]).toMatchObject({
      planType: null,
      usage: {
        rateLimits: [{ limitId: 'five_hour', primary: { usedPercent: 42 } }],
      },
    });
  });

  it('sends Codex through the fixed usage endpoint with its account header only', async () => {
    credentialsBody = {
      files: [
        {
          id: 'credential-id',
          auth_index: 'aabbccdd11223344',
          email: 'codex@example.com',
          name: 'codex.json',
          provider: 'codex',
          id_token: {
            access_token: 'do-not-forward-this-token',
            chatgpt_account_id: 'chatgpt-account-id',
            plan_type: 'plus',
          },
          quota: { signals: {} },
        },
      ],
    };
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    routes.set(
      'POST https://proxy.example.com/v8/management/requests/api-call',
      () =>
        json({
          status_code: 200,
          header: {},
          body: JSON.stringify({ plan_type: 'plus', rate_limit: {} }),
        }),
    );
    const target = getAccountProxyUsageInventory()[0];
    if (!target) throw new Error('Expected a Codex usage target');
    fetchMock.mockClear();

    await fetchAccountProxyUsage(target);

    const post = fetchMock.mock.calls.find(
      ([, init]) => init?.method === 'POST',
    );
    const requestBody = typeof post?.[1]?.body === 'string' ? post[1].body : '';
    expect(post?.[0]).toBe(
      'https://proxy.example.com/v8/management/requests/api-call',
    );
    expect(requestBody).toContain('"auth_index":"aabbccdd11223344"');
    expect(requestBody).toContain('"method":"GET"');
    expect(requestBody).toContain('https://chatgpt.com/backend-api/wham/usage');
    expect(requestBody).toContain('"Authorization":"Bearer $TOKEN$"');
    expect(requestBody).toContain('"Chatgpt-Account-Id":"chatgpt-account-id"');
    expect(requestBody).not.toContain('do-not-forward-this-token');
    expect(requestBody).not.toContain('mk-test');
  });

  it('invalidates the prior target when the same credential index changes email', async () => {
    credentialsBody = {
      files: [
        {
          id: 'same-credential-id',
          auth_index: '15356e8f5d38e233',
          email: 'before@example.com',
          name: 'same-credential.json',
          provider: 'claude',
          quota: { signals: {} },
        },
      ],
    };
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    const previous = getAccountProxyUsageInventory()[0];
    if (!previous) throw new Error('Expected a Claude usage target');

    credentialsBody = {
      files: [
        {
          id: 'same-credential-id',
          auth_index: '15356e8f5d38e233',
          email: 'after@example.com',
          name: 'same-credential.json',
          provider: 'claude',
          quota: { signals: {} },
        },
      ],
    };
    await getAccountProxyStatus({ refresh: true });
    const current = getAccountProxyUsageInventory()[0];
    if (!current) throw new Error('Expected the updated Claude usage target');
    expect(current.identity).not.toBe(previous.identity);

    fetchMock.mockClear();
    await fetchAccountProxyUsage(previous);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('invalidates the prior target when a case-sensitive provider subject changes', async () => {
    const credential = {
      id: 'same-credential-id',
      auth_index: '15356e8f5d38e233',
      email: 'stable@example.com',
      name: 'same-credential.json',
      provider: 'claude',
      subject: 'subject-A',
      quota: { signals: {} },
    };
    credentialsBody = { files: [credential] };
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    const previous = getAccountProxyUsageInventory()[0];
    if (!previous) throw new Error('Expected a Claude usage target');

    credentialsBody = { files: [{ ...credential, subject: 'subject-a' }] };
    await getAccountProxyStatus({ refresh: true });
    const current = getAccountProxyUsageInventory()[0];
    if (!current) throw new Error('Expected the updated usage target');
    expect(current.identity).not.toBe(previous.identity);

    fetchMock.mockClear();
    await fetchAccountProxyUsage(previous);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('notifies on inventory refresh and keeps an unchanged identity target active when passive usage changes', async () => {
    const credential = {
      id: 'same-credential-id',
      auth_index: '15356e8f5d38e233',
      email: 'stable@example.com',
      name: 'same-credential.json',
      provider: 'claude',
      quota: { signals: {} },
    };
    credentialsBody = { files: [credential] };
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    const target = getAccountProxyUsageInventory()[0];
    if (!target) throw new Error('Expected a Claude usage target');
    const changed = jest.fn();
    const unsubscribe = onAccountProxyInventoryChanged(changed);
    credentialsBody = {
      files: [
        {
          ...credential,
          quota: {
            observed_at: '2026-10-20T12:00:00.000Z',
            signals: {
              'Anthropic-Ratelimit-Unified-5h-Utilization': '0.25',
            },
          },
        },
      ],
    };
    await getAccountProxyStatus({ refresh: true });
    expect(changed).toHaveBeenCalled();
    expect(getAccountProxyUsageInventory()[0]?.identity).toBe(target.identity);
    routes.set(
      'POST https://proxy.example.com/v8/management/requests/api-call',
      () =>
        json({
          status_code: 200,
          header: {},
          body: JSON.stringify({ five_hour: { utilization: 25 } }),
        }),
    );
    fetchMock.mockClear();

    await fetchAccountProxyUsage(target);

    expect(
      fetchMock.mock.calls.filter(
        ([, init]) =>
          init?.method === 'POST' &&
          typeof init.body === 'string' &&
          init.body.includes('/api/oauth/usage'),
      ),
    ).toHaveLength(1);
    unsubscribe();
  });

  it('notifies usage subscribers when provider routing preferences change', async () => {
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    const changed = jest.fn();
    const unsubscribe = onAccountProxyInventoryChanged(changed);

    fetchMock.mockClear();
    preferences = { ...preferences, accountProxyRouteClaude: false };
    const status = await getAccountProxyStatus();

    expect(status.routeClaude).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('notifies usage subscribers when proxy connectivity errors and recovers', async () => {
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    const changed = jest.fn();
    const unsubscribe = onAccountProxyInventoryChanged(changed);
    routes.set('GET https://proxy.example.com/v8/management/credentials', () =>
      json({ error: 'temporarily unavailable' }, 500),
    );

    const failed = await getAccountProxyStatus({ refresh: true });

    expect(failed.state).toBe('error');
    expect(failed.error).not.toBeNull();
    expect(changed).toHaveBeenCalledTimes(1);

    await getAccountProxyStatus({ refresh: true });
    expect(changed).toHaveBeenCalledTimes(1);

    routes.set('GET https://proxy.example.com/v8/management/credentials', () =>
      json(credentialsBody),
    );
    const recovered = await getAccountProxyStatus({ refresh: true });

    expect(recovered).toMatchObject({ state: 'connected', error: null });
    expect(changed).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('latches an outer management-key refusal and prevents stale targets from resending', async () => {
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    const target = getAccountProxyUsageInventory()[0];
    if (!target) throw new Error('Expected a Claude usage target');
    routes.set(
      'POST https://proxy.example.com/v8/management/requests/api-call',
      () => json({ error: 'do not surface this response body' }, 401),
    );
    fetchMock.mockClear();

    const result = await fetchAccountProxyUsage(target);

    expect(result).toMatchObject({
      status: 'failure',
      errorInfo: { kind: 'unknown' },
    });
    expect(JSON.stringify(result)).not.toContain('response body');
    expect(storedCredentials.get(target.connectionId)?.keyRejection?.code).toBe(
      'unauthorized',
    );
    expect(getAccountProxyUsageInventory()).toEqual([]);
    fetchMock.mockClear();
    await fetchAccountProxyUsage(target);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports typed storage failure instead of a missing key during status refresh', async () => {
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-secret',
    });
    const secureStorageFailure = {
      version: 1,
      code: 'SECURE_STORAGE_DECRYPT_FAILED',
      operation: 'read',
      state: 'locked',
      backend: 'gnome_libsecret',
      retryable: true,
    } as const;
    credentialReadError = Object.assign(new Error('native diagnostic'), {
      secureStorageFailure,
    });
    fetchMock.mockClear();
    const status = await getAccountProxyStatus({ refresh: true });
    expect(status).toMatchObject({
      state: 'error',
      error: {
        code: 'storage-unavailable',
        message: 'Secure storage unavailable',
        secureStorageFailure,
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storedCredentials.size).toBe(1);
    expect(JSON.stringify(status)).not.toContain('native diagnostic');
    credentialReadError = null;
    await expect(getAccountProxyStatus()).resolves.toMatchObject({
      state: 'error',
      error: { code: 'storage-unavailable' },
    });
    await expect(
      getAccountProxyStatus({ refresh: true }),
    ).resolves.toMatchObject({ state: 'connected', error: null });
  });

  it('refuses reconnect without replacing unreadable stored keys', async () => {
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'old-key',
    });
    const before = [...storedCredentials.entries()];
    const beforeClientKeys = [...clientKeys];
    const secureStorageFailure = {
      version: 1,
      code: 'SECURE_STORAGE_DECRYPT_FAILED',
      operation: 'read',
      state: 'secure',
      backend: 'gnome_libsecret',
      retryable: true,
    } as const;
    credentialReadError = Object.assign(new Error('native diagnostic'), {
      secureStorageFailure,
    });
    const result = await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'replacement-key',
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'storage-unavailable', secureStorageFailure },
    });
    expect([...storedCredentials.entries()]).toEqual(before);
    expect(clientKeys).toEqual(beforeClientKeys);
  });

  it('shares cached background reads across waiting sessions', async () => {
    await connectAccountProxy({
      url: 'proxy.example.com',
      managementKey: 'mk-test',
    });
    fetchMock.mockClear();
    const options = { refresh: true, maxAgeMs: 30_000 };
    await Promise.all(
      Array.from({ length: 25 }, () => getAccountProxyStatus(options)),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('coalesces an expired cache across many waiting sessions', async () => {
    await connectAccountProxy({
      url: 'proxy.example.com',
      managementKey: 'mk-test',
    });
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + 30_001);
    fetchMock.mockClear();
    await Promise.all(
      Array.from({ length: 25 }, () =>
        getAccountProxyStatus({ refresh: true, maxAgeMs: 30_000 }),
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('backs off failed background reads instead of retrying for every chat', async () => {
    await connectAccountProxy({
      url: 'proxy.example.com',
      managementKey: 'mk-test',
    });
    routes.set('GET https://proxy.example.com/v8/management/credentials', () =>
      json({}, 503),
    );
    fetchMock.mockClear();
    const options = { refresh: true, maxAgeMs: 30_000 };
    const clock = jest.spyOn(Date, 'now');
    const now = Date.now();
    clock.mockReturnValue(now + 30_001);
    await getAccountProxyStatus(options);
    await getAccountProxyStatus(options);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('connects, saves the key, and lists sign-ins and API keys', async () => {
    const result = await connectAccountProxy({
      url: 'proxy.example.com/v8/management',
      managementKey: '  mk-test  ',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status.state).toBe('connected');
    expect(result.status.version).toBe('8.0.27');
    expect(result.status.routing).toEqual({
      strategy: 'fill-first',
      sessionAffinity: true,
    });
    expect(
      result.status.accounts.map((account) => [account.label, account.source]),
    ).toEqual([
      ['ops@example.com', 'sign-in'],
      ['team-key', 'api-key'],
    ]);
    expect(JSON.stringify(result.status)).not.toContain('sk-secret');
    const connection = preferences.accountProxyConnection;
    expect(connection?.url).toBe('https://proxy.example.com');
    expect(storedCredentials.get(connection?.id ?? '')?.managementKey).toBe(
      'mk-test',
    );
  });

  it('names an account only from the list of the connection asked about', async () => {
    const result = await connectAccountProxy({
      url: 'proxy.example.com/v8/management',
      managementKey: 'mk-test',
    });
    expect(result.ok).toBe(true);
    const connectionId = preferences.accountProxyConnection?.id ?? '';
    expect(findAccountProxyAccount('15356e8f5d38e233')?.label).toBe(
      'ops@example.com',
    );
    expect(
      findAccountProxyAccount('15356e8f5d38e233', connectionId)?.label,
    ).toBe('ops@example.com');
    // Another connection reuses the same ids for other credentials.
    expect(
      findAccountProxyAccount('15356e8f5d38e233', 'other-connection'),
    ).toBeNull();
  });

  it('adds a client key for this device and takes it off on disconnect', async () => {
    const result = await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    expect(result.ok).toBe(true);
    const id = preferences.accountProxyConnection?.id ?? '';
    const deviceKey = storedCredentials.get(id)?.clientKey ?? '';
    expect(deviceKey).toMatch(/^canopy-[a-f0-9]{48}$/);
    expect(clientKeys).toEqual(['ck-other-device', deviceKey]);

    // Reconnecting reuses the key the server still lists.
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    expect(clientKeys).toEqual(['ck-other-device', deviceKey]);

    await disconnectAccountProxy();
    expect(clientKeys).toEqual(['ck-other-device']);
  });

  it('leaves an open server open', async () => {
    clientKeys = [];
    const result = await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    expect(result.ok).toBe(true);
    expect(clientKeys).toEqual([]);
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT'),
    ).toBe(false);
    const id = preferences.accountProxyConnection?.id ?? '';
    expect(storedCredentials.get(id)?.clientKey).toBeNull();
  });

  it('keeps nothing when the server rejects the key', async () => {
    routes.set('GET https://proxy.example.com/v8/management/credentials', () =>
      json({ error: 'invalid management key' }, 401),
    );
    const result = await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'wrong',
    });
    expect(result).toEqual({
      ok: false,
      error: { code: 'unauthorized', message: 'unauthorized' },
    });
    expect(preferences.accountProxyConnection).toBeUndefined();
    expect(storedCredentials.size).toBe(0);
  });

  it('rejects plain HTTP to another host before sending the key', async () => {
    const result = await connectAccountProxy({
      url: 'http://proxy.example.com',
      managementKey: 'mk-test',
    });
    expect(result.ok ? null : result.error.code).toBe('insecure-url');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never resends a key the server rejected', async () => {
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    routes.set('GET https://proxy.example.com/v8/management/credentials', () =>
      json({ error: 'invalid management key' }, 401),
    );
    const first = await getAccountProxyStatus({ refresh: true });
    expect(first.state).toBe('error');
    expect(first.error?.code).toBe('unauthorized');
    // The last good list stays visible.
    expect(first.accounts).toHaveLength(2);
    fetchMock.mockClear();
    const second = await getAccountProxyStatus({ refresh: true });
    expect(second.error?.code).toBe('unauthorized');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('makes no requests while the flag or the opt-in is off', async () => {
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    fetchMock.mockClear();
    flagEnabled = false;
    expect((await getAccountProxyStatus({ refresh: true })).available).toBe(
      false,
    );
    flagEnabled = true;
    preferences = { ...preferences, accountProxyEnabled: false };
    expect((await getAccountProxyStatus({ refresh: true })).available).toBe(
      false,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('turns off and removes signed-in accounts by file name', async () => {
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    const patch = jest.fn(() => json({ status: 'ok' }));
    routes.set(
      'PATCH https://proxy.example.com/v8/management/credentials/status',
      (init) => {
        expect(
          JSON.parse(typeof init?.body === 'string' ? init.body : ''),
        ).toEqual({
          name: 'claude-ops@example.com.json',
          auth_index: '15356e8f5d38e233',
          disabled: true,
        });
        return patch();
      },
    );
    await setAccountProxyAccountDisabled('15356e8f5d38e233', true);
    expect(patch).toHaveBeenCalledTimes(1);

    const remove = jest.fn(() => json({ status: 'ok' }));
    routes.set(
      'DELETE https://proxy.example.com/v8/management/credentials?name=claude-ops%40example.com.json',
      remove,
    );
    await removeAccountProxyAccount('15356e8f5d38e233');
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("changes the server's account order and reads it back", async () => {
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    let serverStrategy = 'fill-first';
    routes.set('GET https://proxy.example.com/v8/management/config', () =>
      json({
        ...CONFIG,
        routing: { ...CONFIG.routing, strategy: serverStrategy },
      }),
    );
    const put = jest.fn((init: RequestInit | undefined) => {
      expect(new Headers(init?.headers).get('authorization')).toBe(
        'Bearer mk-test',
      );
      const body: unknown = JSON.parse(
        typeof init?.body === 'string' ? init.body : '',
      );
      if (typeof body === 'string') serverStrategy = body;
      return json({ status: 'ok', 'config-version': 8 });
    });
    routes.set(
      'PUT https://proxy.example.com/v8/management/config/routing/strategy',
      put,
    );
    const status = await setAccountProxyRoutingStrategy('weighted-round-robin');
    expect(put).toHaveBeenCalledTimes(1);
    expect(serverStrategy).toBe('weighted-round-robin');
    expect(status.routing?.strategy).toBe('weighted-round-robin');
    // The server keeps its own setting; nothing is saved on this device.
    expect(preferences.accountProxyLocalRoutingStrategy).toBeUndefined();
  });

  it('records a key the server rejects while changing the account order', async () => {
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    routes.set(
      'PUT https://proxy.example.com/v8/management/config/routing/strategy',
      () => json({ error: 'invalid management key' }, 401),
    );
    const status = await setAccountProxyRoutingStrategy('fill-first');
    expect(status).toMatchObject({
      state: 'error',
      error: { code: 'unauthorized' },
    });
    fetchMock.mockClear();
    await expect(setAccountProxyRoutingStrategy('fill-first')).rejects.toThrow(
      'management key',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not send a rejected key for account actions', async () => {
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    routes.set('GET https://proxy.example.com/v8/management/credentials', () =>
      json({ error: 'invalid management key' }, 401),
    );
    await getAccountProxyStatus({ refresh: true });
    fetchMock.mockClear();
    await expect(
      setAccountProxyAccountDisabled('15356e8f5d38e233', true),
    ).rejects.toThrow('management key');
    await expect(removeAccountProxyAccount('15356e8f5d38e233')).rejects.toThrow(
      'management key',
    );
    await expect(setAccountProxyRoutingStrategy('fill-first')).rejects.toThrow(
      'management key',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops a refresh that started with a key the user has since replaced', async () => {
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-old',
    });
    let releaseOldKey: (() => void) | undefined;
    const oldKeyGate = new Promise<void>((resolve) => {
      releaseOldKey = resolve;
    });
    routes.set(
      'GET https://proxy.example.com/v8/management/credentials',
      async (init) => {
        const auth = new Headers(init?.headers).get('authorization');
        if (auth === 'Bearer mk-old') {
          // The server has rotated its key; the answer arrives only after
          // the user reconnects with the new one.
          await oldKeyGate;
          return json({ error: 'invalid management key' }, 401);
        }
        return json(CREDENTIALS);
      },
    );
    const staleRefresh = getAccountProxyStatus({ refresh: true });
    const reconnected = await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-new',
    });
    expect(reconnected.ok).toBe(true);
    releaseOldKey?.();
    await staleRefresh;
    const status = await getAccountProxyStatus();
    expect(status.state).toBe('connected');
    expect(status.error).toBeNull();
    // Later refreshes still use the new key.
    expect((await getAccountProxyStatus({ refresh: true })).state).toBe(
      'connected',
    );
  });

  it('drops an account action rejection that arrives after a reconnect', async () => {
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-old',
    });
    let releaseOldKey: (() => void) | undefined;
    const oldKeyGate = new Promise<void>((resolve) => {
      releaseOldKey = resolve;
    });
    routes.set(
      'PATCH https://proxy.example.com/v8/management/credentials/status',
      async () => {
        await oldKeyGate;
        return json({ error: 'invalid management key' }, 401);
      },
    );
    const staleAction = setAccountProxyAccountDisabled(
      '15356e8f5d38e233',
      true,
    );
    // Let the action pass its checks and send its request.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reconnected = await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-new',
    });
    expect(reconnected.ok).toBe(true);
    releaseOldKey?.();
    await staleAction.catch(() => undefined);
    const status = await getAccountProxyStatus();
    expect(status.state).toBe('connected');
    expect(status.error).toBeNull();
    fetchMock.mockClear();
    expect((await getAccountProxyStatus({ refresh: true })).state).toBe(
      'connected',
    );
    expect(fetchMock).toHaveBeenCalled();
  });

  it('keeps a key rejection when an older refresh finishes after it', async () => {
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    let releaseRefresh: (() => void) | undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    routes.set(
      'GET https://proxy.example.com/v8/management/credentials',
      async () => {
        await refreshGate;
        throw new TypeError('fetch failed');
      },
    );
    const olderRefresh = getAccountProxyStatus({ refresh: true });
    routes.set(
      'PATCH https://proxy.example.com/v8/management/credentials/status',
      () => json({ error: 'invalid management key' }, 401),
    );
    const afterAction = await setAccountProxyAccountDisabled(
      '15356e8f5d38e233',
      true,
    );
    expect(afterAction.error?.code).toBe('unauthorized');
    releaseRefresh?.();
    await olderRefresh;
    expect((await getAccountProxyStatus()).error?.code).toBe('unauthorized');
    fetchMock.mockClear();
    await getAccountProxyStatus({ refresh: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not let a pending connect undo Disconnect', async () => {
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-old',
    });
    let releaseCheck: (() => void) | undefined;
    const checkGate = new Promise<void>((resolve) => {
      releaseCheck = resolve;
    });
    routes.set(
      'GET https://proxy.example.com/v8/management/credentials',
      async () => {
        await checkGate;
        return json(CREDENTIALS);
      },
    );
    const pendingConnect = connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-new',
    });
    const disconnected = await disconnectAccountProxy();
    expect(disconnected.connection).toBeNull();
    releaseCheck?.();
    const result = await pendingConnect;
    expect(result.ok).toBe(false);
    expect(preferences.accountProxyConnection ?? null).toBeNull();
    expect(storedCredentials.size).toBe(0);
    expect((await getAccountProxyStatus()).connection).toBeNull();
  });

  it('keeps a key rejection when a refresh that overlapped it fails later', async () => {
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    let releasePoll: (() => void) | undefined;
    const pollGate = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    let calls = 0;
    routes.set(
      'GET https://proxy.example.com/v8/management/credentials',
      async () => {
        calls += 1;
        if (calls === 1) {
          await pollGate;
          throw new TypeError('fetch failed');
        }
        return json({ error: 'invalid management key' }, 401);
      },
    );
    routes.set(
      'PATCH https://proxy.example.com/v8/management/credentials/status',
      () => json({ status: 'ok' }),
    );
    const poll = getAccountProxyStatus({ refresh: true });
    const action = setAccountProxyAccountDisabled('15356e8f5d38e233', true);
    // The action's refresh waits for the poll, so let the poll fail first.
    await new Promise((resolve) => setTimeout(resolve, 0));
    releasePoll?.();
    await poll;
    await action;
    expect((await getAccountProxyStatus()).error?.code).toBe('unauthorized');
    fetchMock.mockClear();
    await getAccountProxyStatus({ refresh: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('remembers a rejected key after the app restarts', async () => {
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    routes.set('GET https://proxy.example.com/v8/management/credentials', () =>
      json({ error: 'invalid management key' }, 401),
    );
    await getAccountProxyStatus({ refresh: true });
    resetAccountProxyServiceForTests();
    fetchMock.mockClear();
    const afterRestart = await getAccountProxyStatus({ refresh: true });
    expect(afterRestart.error?.code).toBe('unauthorized');
    expect(fetchMock).not.toHaveBeenCalled();

    // Entering a new key clears it.
    routes.set('GET https://proxy.example.com/v8/management/credentials', () =>
      json(CREDENTIALS),
    );
    const reconnected = await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-new',
    });
    expect(reconnected.ok).toBe(true);
    resetAccountProxyServiceForTests();
    expect((await getAccountProxyStatus({ refresh: true })).state).toBe(
      'connected',
    );
  });

  it('tries a blocked key again once the block has passed', async () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    routes.set('GET https://proxy.example.com/v8/management/credentials', () =>
      json({ error: 'IP banned due to too many failed attempts' }, 403),
    );
    await getAccountProxyStatus({ refresh: true });
    resetAccountProxyServiceForTests();
    fetchMock.mockClear();
    expect((await getAccountProxyStatus({ refresh: true })).error?.code).toBe(
      'blocked',
    );
    expect(fetchMock).not.toHaveBeenCalled();
    routes.set('GET https://proxy.example.com/v8/management/credentials', () =>
      json(CREDENTIALS),
    );
    clock.mockReturnValue(now + 31 * 60_000);
    resetAccountProxyServiceForTests();
    expect((await getAccountProxyStatus({ refresh: true })).state).toBe(
      'connected',
    );
  });

  it('drops an old-key rejection that arrives while the new key is being saved', async () => {
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-old',
    });
    let releaseOldKey: (() => void) | undefined;
    const oldKeyGate = new Promise<void>((resolve) => {
      releaseOldKey = resolve;
    });
    routes.set(
      'GET https://proxy.example.com/v8/management/credentials',
      async (init) => {
        if (
          new Headers(init?.headers).get('authorization') === 'Bearer mk-old'
        ) {
          await oldKeyGate;
          return json({ error: 'invalid management key' }, 401);
        }
        return json(CREDENTIALS);
      },
    );
    const staleRefresh = getAccountProxyStatus({ refresh: true });
    let releaseSave: (() => void) | undefined;
    saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const reconnect = connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-new',
    });
    // The new key's save is pending when the old key's 401 comes back.
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseOldKey?.();
    await staleRefresh;
    releaseSave?.();
    saveGate = Promise.resolve();
    expect((await reconnect).ok).toBe(true);

    resetAccountProxyServiceForTests();
    const id = preferences.accountProxyConnection?.id ?? '';
    expect(storedCredentials.get(id)?.keyRejection ?? null).toBeNull();
    expect((await getAccountProxyStatus({ refresh: true })).state).toBe(
      'connected',
    );
  });

  it('drops an account action whose key was replaced while it was loading', async () => {
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-old',
    });
    routes.set(
      'PATCH https://proxy.example.com/v8/management/credentials/status',
      (init) =>
        new Headers(init?.headers).get('authorization') === 'Bearer mk-old'
          ? json({ error: 'invalid management key' }, 401)
          : json({ status: 'ok' }),
    );
    let releaseLoad: (() => void) | undefined;
    loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    // The action has read the old key and is waiting on the load.
    const staleAction = setAccountProxyAccountDisabled(
      '15356e8f5d38e233',
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    loadGate = Promise.resolve();
    credentialReadError = null;
    const reconnected = await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-new',
    });
    expect(reconnected.ok).toBe(true);
    releaseLoad?.();
    await staleAction.catch(() => undefined);
    const status = await getAccountProxyStatus();
    expect(status.state).toBe('connected');
    expect(status.error).toBeNull();
    fetchMock.mockClear();
    await getAccountProxyStatus({ refresh: true });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('lets an expired block clear while the app keeps running', async () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    routes.set('GET https://proxy.example.com/v8/management/credentials', () =>
      json({ error: 'IP banned due to too many failed attempts' }, 403),
    );
    await getAccountProxyStatus({ refresh: true });
    fetchMock.mockClear();
    clock.mockReturnValue(now + 10 * 60_000);
    expect((await getAccountProxyStatus({ refresh: true })).error?.code).toBe(
      'blocked',
    );
    expect(fetchMock).not.toHaveBeenCalled();
    routes.set('GET https://proxy.example.com/v8/management/credentials', () =>
      json(CREDENTIALS),
    );
    clock.mockReturnValue(now + 31 * 60_000);
    expect((await getAccountProxyStatus({ refresh: true })).state).toBe(
      'connected',
    );
  });

  it('keeps refusing a wrong key however long the app runs', async () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    routes.set('GET https://proxy.example.com/v8/management/credentials', () =>
      json({ error: 'invalid management key' }, 401),
    );
    await getAccountProxyStatus({ refresh: true });
    fetchMock.mockClear();
    clock.mockReturnValue(now + 24 * 3600_000);
    await getAccountProxyStatus({ refresh: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends nothing more for a refresh once an account action got the key rejected', async () => {
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    let releaseCredentials: (() => void) | undefined;
    const credentialsGate = new Promise<void>((resolve) => {
      releaseCredentials = resolve;
    });
    routes.set(
      'GET https://proxy.example.com/v8/management/credentials',
      async () => {
        await credentialsGate;
        return json(CREDENTIALS);
      },
    );
    routes.set(
      'PATCH https://proxy.example.com/v8/management/credentials/status',
      () => json({ error: 'invalid management key' }, 401),
    );
    const refresh = getAccountProxyStatus({ refresh: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await setAccountProxyAccountDisabled('15356e8f5d38e233', true);
    fetchMock.mockClear();
    releaseCredentials?.();
    await refresh;
    expect(
      fetchMock.mock.calls.some(([input]) =>
        (typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
        ).endsWith('/config'),
      ),
    ).toBe(false);
    expect((await getAccountProxyStatus()).error?.code).toBe('unauthorized');
  });

  it('keeps the last config when reading it fails for a moment', async () => {
    routes.set('GET https://proxy.example.com/v8/management/config', () =>
      json({
        ...CONFIG,
        routing: { strategy: 'fill-first', 'session-affinity': false },
      }),
    );
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    routes.set('GET https://proxy.example.com/v8/management/config', () =>
      json({ error: 'internal error' }, 500),
    );
    const status = await getAccountProxyStatus({ refresh: true });
    expect(status.error?.code).toBe('unexpected');
    expect(status.accounts.map((account) => account.label)).toEqual([
      'ops@example.com',
      'team-key',
    ]);
    expect(status.routing).toEqual({
      strategy: 'fill-first',
      sessionAffinity: false,
    });
  });

  it('lists signed-in accounts from a server that hides its config', async () => {
    routes.set('GET https://proxy.example.com/v8/management/config', () =>
      json({ error: 'not found' }, 404),
    );
    const result = await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status.error).toBeNull();
    expect(result.status.routing).toBeNull();
    expect(result.status.accounts.map((account) => account.label)).toEqual([
      'ops@example.com',
    ]);
  });

  it('never switches the server open by taking off its last client key', async () => {
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    const deviceKey =
      storedCredentials.get(preferences.accountProxyConnection?.id ?? '')
        ?.clientKey ?? '';
    // An admin has since removed every other key.
    clientKeys = [deviceKey];
    fetchMock.mockClear();
    await disconnectAccountProxy();
    expect(clientKeys).toEqual([deviceKey]);
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT'),
    ).toBe(false);
  });

  it('adds one client key when sessions start at the same time', async () => {
    clientKeys = [];
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    // The server starts requiring client keys after this device connected.
    clientKeys = ['ck-admin'];
    const [first, second] = await Promise.all([
      getAccountProxyRouteTarget('claude'),
      getAccountProxyRouteTarget('claude'),
    ]);
    expect(first?.clientKey).toMatch(/^canopy-[a-f0-9]{48}$/);
    expect(second?.clientKey).toBe(first?.clientKey);
    expect(clientKeys).toEqual(['ck-admin', first?.clientKey]);
    const id = preferences.accountProxyConnection?.id ?? '';
    expect(storedCredentials.get(id)?.clientKey).toBe(first?.clientKey);
  });

  it('records a management key rejected while adding a client key', async () => {
    clientKeys = [];
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    routes.set(
      'GET https://proxy.example.com/v8/management/config/access/api-keys',
      () => json({ error: 'invalid management key' }, 401),
    );
    expect(await getAccountProxyRouteTarget('claude')).toBeNull();
    expect((await getAccountProxyStatus()).error?.code).toBe('unauthorized');
    fetchMock.mockClear();
    expect(await getAccountProxyRouteTarget('claude')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps its client key when checking it fails during a reconnect', async () => {
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    const id = preferences.accountProxyConnection?.id ?? '';
    const deviceKey = storedCredentials.get(id)?.clientKey ?? '';
    expect(deviceKey).toMatch(/^canopy-[a-f0-9]{48}$/);
    const listKeys = routes.get(
      'GET https://proxy.example.com/v8/management/config/access/api-keys',
    );
    routes.set(
      'GET https://proxy.example.com/v8/management/config/access/api-keys',
      () => json({ error: 'busy' }, 500),
    );

    const reconnected = await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });

    expect(reconnected.ok).toBe(true);
    // A failed check is not proof the server is open.
    expect(storedCredentials.get(id)?.clientKey).toBe(deviceKey);
    if (listKeys) {
      routes.set(
        'GET https://proxy.example.com/v8/management/config/access/api-keys',
        listKeys,
      );
    }
    const target = await getAccountProxyRouteTarget('claude');
    expect(target?.clientKey).toBe(deviceKey);
    expect(clientKeys).toEqual(['ck-other-device', deviceKey]);
  });

  it('replaces a client key the proxy refused', async () => {
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    const id = preferences.accountProxyConnection?.id ?? '';
    const oldKey = storedCredentials.get(id)?.clientKey ?? '';
    // Someone removed this device's key on the server.
    clientKeys = ['ck-other-device'];
    reportAccountProxyClientKeyRejected(
      accountProxyClientKeyFingerprint(oldKey),
    );
    const target = await getAccountProxyRouteTarget('claude');
    expect(target?.clientKey).toMatch(/^canopy-[a-f0-9]{48}$/);
    expect(target?.clientKey).not.toBe(oldKey);
    expect(clientKeys).toEqual(['ck-other-device', target?.clientKey]);
    expect(storedCredentials.get(id)?.clientKey).toBe(target?.clientKey);
  });

  it('routes lookups that start together right after launch', async () => {
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    // A restart: the connection is saved but nothing has been read yet.
    resetAccountProxyServiceForTests();

    const [first, second] = await Promise.all([
      getAccountProxyRouteTarget('claude'),
      getAccountProxyRouteTarget('claude'),
    ]);

    expect(first?.readyAccounts).toBeGreaterThan(0);
    expect(second?.readyAccounts).toBeGreaterThan(0);
  });

  it('says why a harness with no usable proxy account cannot route', async () => {
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });

    const claude = await getAccountProxyRouteTarget('claude');
    const codex = await getAccountProxyRouteTarget('codex');

    expect(claude?.noUsableAccounts).toBeNull();
    expect(codex?.readyAccounts).toBe(0);
    expect(codex?.noUsableAccounts).toBe(
      'The account proxy has no Codex accounts. Add one in Settings > Multi-account proxy, or turn off Use for Codex there.',
    );
  });

  it('lets sessions that start together share one account list read', async () => {
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    resetAccountProxyServiceForTests();
    let releaseCredentials: (() => void) | undefined;
    const credentialsGate = new Promise<void>((resolve) => {
      releaseCredentials = resolve;
    });
    routes.set(
      'GET https://proxy.example.com/v8/management/credentials',
      async () => {
        await credentialsGate;
        return json(CREDENTIALS);
      },
    );
    const first = getAccountProxyRouteTarget('claude');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = getAccountProxyRouteTarget('claude');
    releaseCredentials?.();
    expect((await first)?.readyAccounts).toBe(2);
    expect((await second)?.readyAccounts).toBe(2);
  });

  it('gives up a route lookup when the user disconnects during it', async () => {
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    let releaseLoad: (() => void) | undefined;
    loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const lookup = getAccountProxyRouteTarget('claude');
    await new Promise((resolve) => setTimeout(resolve, 0));
    loadGate = Promise.resolve();
    credentialReadError = null;
    await disconnectAccountProxy();
    releaseLoad?.();
    await expect(lookup).resolves.toBeNull();
  });

  it('names the proxy settings a session is created under', async () => {
    expect(accountProxySettingsSignature('claude')).toBe('');
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    const id = preferences.accountProxyConnection?.id ?? '';
    expect(accountProxySettingsSignature('claude')).toBe(
      `account-proxy:${id}:on:keep`,
    );
    preferences = {
      ...preferences,
      accountProxyRouteCodex: false,
      accountProxyKeepChatOnOneAccount: false,
    };
    await getAccountProxyStatus();
    expect(accountProxySettingsSignature('codex')).toBe(
      `account-proxy:${id}:off:spread`,
    );
    flagEnabled = false;
    expect(accountProxySettingsSignature('claude')).toBe('');
  });

  it('falls back instead of using a replacement client key it could not save', async () => {
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    const id = preferences.accountProxyConnection?.id ?? '';
    const oldKey = storedCredentials.get(id)?.clientKey ?? '';
    clientKeys = ['ck-other-device'];
    reportAccountProxyClientKeyRejected(
      accountProxyClientKeyFingerprint(oldKey),
    );
    saveGate = Promise.reject(new Error('disk full'));
    saveGate.catch(() => undefined);
    expect(await getAccountProxyRouteTarget('claude')).toBeNull();
    // The old key stays suspect, so the next lookup tries again.
    saveGate = Promise.resolve();
    const target = await getAccountProxyRouteTarget('claude');
    expect(target?.clientKey).toMatch(/^canopy-[a-f0-9]{48}$/);
    expect(storedCredentials.get(id)?.clientKey).toBe(target?.clientKey);
  });

  it('waits a minute before checking an unreachable open server again', async () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    clientKeys = [];
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    routes.set(
      'GET https://proxy.example.com/v8/management/config/access/api-keys',
      () => json({ error: 'internal error' }, 500),
    );
    expect(await getAccountProxyRouteTarget('claude')).toBeNull();
    fetchMock.mockClear();
    expect(await getAccountProxyRouteTarget('claude')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    routes.set(
      'GET https://proxy.example.com/v8/management/config/access/api-keys',
      () => json(clientKeys),
    );
    clock.mockReturnValue(now + 61_000);
    const target = await getAccountProxyRouteTarget('claude');
    expect(target).not.toBeNull();
    expect(target?.clientKey).toBeNull();
  });

  it('refuses to change API-key accounts, which live in the server config', async () => {
    await connectAccountProxy({
      url: 'https://proxy.example.com',
      managementKey: 'mk-test',
    });
    await expect(
      setAccountProxyAccountDisabled('1010d86d0c820746', true),
    ).rejects.toThrow('only be changed on the server');
  });

  describe('the proxy on this device', () => {
    function serveLocal(port: number): void {
      routes.set(
        `GET http://127.0.0.1:${String(port)}/v8/management/credentials`,
        () => json(CREDENTIALS),
      );
      routes.set(
        `GET http://127.0.0.1:${String(port)}/v8/management/config`,
        () => json(CONFIG),
      );
    }

    it('sets up, starts, and reads the proxy on a loopback address', async () => {
      serveLocal(18555);
      const result = await setUpLocalAccountProxy();
      expect(result.ok).toBe(true);
      const connection = preferences.accountProxyConnection;
      expect(connection).toMatchObject({
        kind: 'local',
        url: 'http://127.0.0.1:18555',
      });
      const id = connection?.id ?? '';
      const stored = storedCredentials.get(id);
      expect(stored?.managementKey).toMatch(/^canopy-mk-[a-f0-9]{48}$/);
      // The proxy stores it as a bcrypt hash, which refuses keys over 72 bytes.
      expect(
        Buffer.byteLength(stored?.managementKey ?? ''),
      ).toBeLessThanOrEqual(72);
      expect(stored?.clientKey).toMatch(/^canopy-[a-f0-9]{48}$/);
      expect(jest.mocked(startLocalAccountProxy)).toHaveBeenCalledWith({
        managementKey: stored?.managementKey,
        clientKey: stored?.clientKey,
        preferredPort: 18555,
        routingStrategy: null,
      });
      if (!result.ok) throw new Error('expected a connection');
      expect(result.status.state).toBe('connected');
      expect(
        result.status.accounts.map((account) => account.authIndex),
      ).toContain('15356e8f5d38e233');
      expect(result.status.local).toMatchObject({
        phase: 'running',
        port: 18555,
      });
    });

    it('replaces a server connection and takes its key off the server', async () => {
      await connectAccountProxy({
        url: 'proxy.example.com',
        managementKey: 'mk-test',
      });
      const serverId = preferences.accountProxyConnection?.id ?? '';
      expect(clientKeys).toHaveLength(2);
      serveLocal(18555);
      await expect(setUpLocalAccountProxy()).resolves.toMatchObject({
        ok: true,
      });
      expect(preferences.accountProxyConnection?.kind).toBe('local');
      expect(storedCredentials.has(serverId)).toBe(false);
      expect(clientKeys).toEqual(['ck-other-device']);
    });

    it('keeps the connection when the proxy does not start, so it can be retried', async () => {
      mockLocal.startError = new LocalAccountProxyError(
        'local-failed',
        'The account proxy did not start: it exited (code 3).',
      );
      const result = await setUpLocalAccountProxy();
      expect(result).toEqual({
        ok: false,
        error: {
          code: 'local-failed',
          message: 'The account proxy did not start: it exited (code 3).',
        },
      });
      expect(preferences.accountProxyConnection?.kind).toBe('local');
      mockLocal.startError = null;
      serveLocal(18555);
      const status = await controlLocalAccountProxy({ action: 'start' });
      expect(status.local.phase).toBe('running');
      expect(status.state).toBe('connected');
    });

    it('moves the connection when the proxy lands on another port', async () => {
      serveLocal(18555);
      await setUpLocalAccountProxy();
      await controlLocalAccountProxy({ action: 'stop' });
      mockLocal.nextPort = 18600;
      serveLocal(18600);
      const status = await controlLocalAccountProxy({ action: 'start' });
      expect(preferences.accountProxyConnection?.url).toBe(
        'http://127.0.0.1:18600',
      );
      expect(status.connection?.url).toBe('http://127.0.0.1:18600');
      expect(status.state).toBe('connected');
    });

    it('reports where no release is published for this device', async () => {
      mockLocal.phase = 'unsupported';
      await expect(setUpLocalAccountProxy()).resolves.toEqual({
        ok: false,
        error: { code: 'local-unsupported', message: 'local-unsupported' },
      });
      expect(preferences.accountProxyConnection ?? null).toBeNull();
    });

    it('stops and restarts on request', async () => {
      serveLocal(18555);
      await setUpLocalAccountProxy();
      const stopped = await controlLocalAccountProxy({ action: 'stop' });
      expect(stopped.local.phase).toBe('stopped');
      const restarted = await controlLocalAccountProxy({ action: 'restart' });
      expect(restarted.local.phase).toBe('running');
      expect(jest.mocked(stopLocalAccountProxy)).toHaveBeenCalledTimes(2);
    });

    it('keeps the account order across a restart', async () => {
      serveLocal(18555);
      await setUpLocalAccountProxy();
      const put = jest.fn(() => json({ status: 'ok', 'config-version': 8 }));
      routes.set(
        'PUT http://127.0.0.1:18555/v8/management/config/routing/strategy',
        put,
      );
      await setAccountProxyRoutingStrategy('fill-first');
      expect(put).toHaveBeenCalledTimes(1);
      expect(preferences.accountProxyLocalRoutingStrategy).toBe('fill-first');
      jest.mocked(startLocalAccountProxy).mockClear();
      await controlLocalAccountProxy({ action: 'restart' });
      // The config is written again on every start, with the chosen order.
      expect(jest.mocked(startLocalAccountProxy)).toHaveBeenCalledWith(
        expect.objectContaining({ routingStrategy: 'fill-first' }),
      );
    });

    it('changes the account order only while the proxy runs', async () => {
      serveLocal(18555);
      await setUpLocalAccountProxy();
      await controlLocalAccountProxy({ action: 'stop' });
      fetchMock.mockClear();
      await expect(
        setAccountProxyRoutingStrategy('fill-first'),
      ).rejects.toThrow('Start the proxy on this device first.');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(preferences.accountProxyLocalRoutingStrategy).toBeUndefined();
    });

    it('refuses controls when the proxy on this device is not the connection', async () => {
      await connectAccountProxy({
        url: 'proxy.example.com',
        managementKey: 'mk-test',
      });
      await expect(
        controlLocalAccountProxy({ action: 'start' }),
      ).rejects.toThrow('not set up');
    });

    it('stops the proxy and forgets its keys on disconnect, without a server call', async () => {
      serveLocal(18555);
      await setUpLocalAccountProxy();
      const id = preferences.accountProxyConnection?.id ?? '';
      fetchMock.mockClear();
      await disconnectAccountProxy();
      expect(jest.mocked(stopLocalAccountProxy)).toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(storedCredentials.has(id)).toBe(false);
      expect(preferences.accountProxyConnection).toBeNull();
    });

    it('stops the proxy when the feature is turned off', async () => {
      serveLocal(18555);
      await setUpLocalAccountProxy();
      preferences = { ...preferences, accountProxyEnabled: false };
      await publishAccountProxyStatus();
      expect(jest.mocked(stopLocalAccountProxy)).toHaveBeenCalled();
    });

    it('stops the proxy when the flag is served off', async () => {
      serveLocal(18555);
      await setUpLocalAccountProxy();
      flagEnabled = false;
      await publishAccountProxyStatus();
      expect(jest.mocked(stopLocalAccountProxy)).toHaveBeenCalled();
    });

    it('keeps the proxy running while the flag falls back', async () => {
      serveLocal(18555);
      await setUpLocalAccountProxy();
      jest.mocked(startLocalAccountProxy).mockClear();
      // An account change or a LaunchDarkly restart shows fallbacks until
      // the served values arrive.
      flagEnabled = false;
      flagSettled = false;
      await publishAccountProxyStatus();
      flagEnabled = true;
      flagSettled = true;
      await publishAccountProxyStatus();
      expect(jest.mocked(stopLocalAccountProxy)).not.toHaveBeenCalled();
      expect(jest.mocked(startLocalAccountProxy)).not.toHaveBeenCalled();
      expect(mockLocal.phase).toBe('running');
    });

    it('keeps a start that ends while the flag falls back', async () => {
      serveLocal(18555);
      await setUpLocalAccountProxy();
      await controlLocalAccountProxy({ action: 'stop' });
      jest.mocked(stopLocalAccountProxy).mockClear();
      let releaseStart: () => void = () => undefined;
      mockLocal.startGate = new Promise((resolve) => {
        releaseStart = resolve;
      });
      const starting = controlLocalAccountProxy({ action: 'start' });
      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      flagEnabled = false;
      flagSettled = false;
      await publishAccountProxyStatus();
      releaseStart();
      mockLocal.startGate = null;
      await starting;
      expect(jest.mocked(stopLocalAccountProxy)).not.toHaveBeenCalled();
      expect(mockLocal.phase).toBe('running');
    });

    it('starts with the app once the flag arrives', async () => {
      serveLocal(18555);
      await setUpLocalAccountProxy();
      await controlLocalAccountProxy({ action: 'stop' });
      jest.mocked(startLocalAccountProxy).mockClear();
      resetAccountProxyServiceForTests();
      // LaunchDarkly did not answer when the app opened.
      flagEnabled = false;
      flagSettled = false;
      await initializeLocalAccountProxy();
      expect(jest.mocked(startLocalAccountProxy)).not.toHaveBeenCalled();
      flagEnabled = true;
      flagSettled = true;
      await publishAccountProxyStatus();
      expect(jest.mocked(startLocalAccountProxy)).toHaveBeenCalledTimes(1);
      expect(mockLocal.phase).toBe('running');
      // Later flag changes leave the running proxy alone.
      await publishAccountProxyStatus();
      expect(jest.mocked(startLocalAccountProxy)).toHaveBeenCalledTimes(1);
    });

    it('starts again when the flag is served on after it was served off', async () => {
      serveLocal(18555);
      await setUpLocalAccountProxy();
      jest.mocked(startLocalAccountProxy).mockClear();
      flagEnabled = false;
      await publishAccountProxyStatus();
      expect(mockLocal.phase).toBe('stopped');
      flagEnabled = true;
      await publishAccountProxyStatus();
      expect(jest.mocked(startLocalAccountProxy)).toHaveBeenCalledTimes(1);
    });

    it('does not start a proxy the user stopped, turned off, or that failed', async () => {
      serveLocal(18555);
      await setUpLocalAccountProxy();
      await controlLocalAccountProxy({ action: 'stop' });
      jest.mocked(startLocalAccountProxy).mockClear();
      await publishAccountProxyStatus();
      expect(jest.mocked(startLocalAccountProxy)).not.toHaveBeenCalled();

      await controlLocalAccountProxy({ action: 'start' });
      preferences = { ...preferences, accountProxyEnabled: false };
      await publishAccountProxyStatus();
      preferences = { ...preferences, accountProxyEnabled: true };
      jest.mocked(startLocalAccountProxy).mockClear();
      await publishAccountProxyStatus();
      expect(jest.mocked(startLocalAccountProxy)).not.toHaveBeenCalled();

      await controlLocalAccountProxy({ action: 'start' });
      jest.mocked(startLocalAccountProxy).mockClear();
      // The proxy exited on its own; the status shows why.
      mockLocal.phase = 'error';
      mockLocal.port = null;
      await publishAccountProxyStatus();
      expect(jest.mocked(startLocalAccountProxy)).not.toHaveBeenCalled();
    });

    it('does not start with the app when it is not set to', async () => {
      serveLocal(18555);
      await setUpLocalAccountProxy();
      await controlLocalAccountProxy({ action: 'stop' });
      resetAccountProxyServiceForTests();
      preferences = { ...preferences, accountProxyLocalStartWithApp: false };
      flagEnabled = false;
      flagSettled = false;
      await initializeLocalAccountProxy();
      jest.mocked(startLocalAccountProxy).mockClear();
      flagEnabled = true;
      flagSettled = true;
      await publishAccountProxyStatus();
      expect(jest.mocked(startLocalAccountProxy)).not.toHaveBeenCalled();
    });

    it('does not start with the app once that is turned off before the flag arrives', async () => {
      serveLocal(18555);
      await setUpLocalAccountProxy();
      await controlLocalAccountProxy({ action: 'stop' });
      resetAccountProxyServiceForTests();
      flagEnabled = false;
      flagSettled = false;
      await initializeLocalAccountProxy();
      preferences = { ...preferences, accountProxyLocalStartWithApp: false };
      jest.mocked(startLocalAccountProxy).mockClear();
      flagEnabled = true;
      flagSettled = true;
      await publishAccountProxyStatus();
      expect(jest.mocked(startLocalAccountProxy)).not.toHaveBeenCalled();
    });

    async function settle(): Promise<void> {
      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    it('starts again when the flag is served on while it was stopping', async () => {
      serveLocal(18555);
      await setUpLocalAccountProxy();
      jest.mocked(startLocalAccountProxy).mockClear();
      let releaseStop: () => void = () => undefined;
      mockLocal.stopGate = new Promise((resolve) => {
        releaseStop = resolve;
      });
      flagEnabled = false;
      const servedOff = publishAccountProxyStatus();
      await settle();
      expect(jest.mocked(stopLocalAccountProxy)).toHaveBeenCalled();
      flagEnabled = true;
      const servedOn = publishAccountProxyStatus();
      await settle();
      releaseStop();
      mockLocal.stopGate = null;
      await servedOff;
      await servedOn;
      expect(jest.mocked(startLocalAccountProxy)).toHaveBeenCalledTimes(1);
      expect(mockLocal.phase).toBe('running');
    });

    it('does not start the proxy when the user stops it while the start checks the runtime', async () => {
      serveLocal(18555);
      await setUpLocalAccountProxy();
      await controlLocalAccountProxy({ action: 'stop' });
      resetAccountProxyServiceForTests();
      flagEnabled = false;
      flagSettled = false;
      await initializeLocalAccountProxy();
      jest.mocked(startLocalAccountProxy).mockClear();
      let releaseRuntime: () => void = () => undefined;
      mockLocal.runtimeGate = new Promise((resolve) => {
        releaseRuntime = resolve;
      });
      flagEnabled = true;
      flagSettled = true;
      const publishing = publishAccountProxyStatus();
      await settle();
      const userStop = controlLocalAccountProxy({ action: 'stop' });
      await settle();
      releaseRuntime();
      mockLocal.runtimeGate = null;
      await publishing;
      await userStop;
      expect(jest.mocked(startLocalAccountProxy)).not.toHaveBeenCalled();
      await publishAccountProxyStatus();
      expect(jest.mocked(startLocalAccountProxy)).not.toHaveBeenCalled();
    });

    it('starts again when the flag returns while a superseded start is still pending', async () => {
      serveLocal(18555);
      await setUpLocalAccountProxy();
      await controlLocalAccountProxy({ action: 'stop' });
      resetAccountProxyServiceForTests();
      flagEnabled = false;
      flagSettled = false;
      await initializeLocalAccountProxy();
      jest.mocked(startLocalAccountProxy).mockClear();
      // The automatic start waits on its keys.
      let releaseKeys: () => void = () => undefined;
      loadGate = new Promise((resolve) => {
        releaseKeys = resolve;
      });
      flagEnabled = true;
      flagSettled = true;
      const servedOn = publishAccountProxyStatus();
      await settle();
      // Served off, then on, before that start reads its keys.
      flagEnabled = false;
      const servedOff = publishAccountProxyStatus();
      await settle();
      flagEnabled = true;
      const servedOnAgain = publishAccountProxyStatus();
      await settle();
      releaseKeys();
      loadGate = Promise.resolve();
      await Promise.all([servedOn, servedOff, servedOnAgain]);
      await settle();
      expect(jest.mocked(startLocalAccountProxy)).toHaveBeenCalledTimes(1);
      expect(mockLocal.phase).toBe('running');
    });

    it('does not restart a proxy after a Start the user then stopped', async () => {
      serveLocal(18555);
      await setUpLocalAccountProxy();
      await controlLocalAccountProxy({ action: 'stop' });
      jest.mocked(startLocalAccountProxy).mockClear();
      let releaseRead: () => void = () => undefined;
      nextReadGate = new Promise((resolve) => {
        releaseRead = resolve;
      });
      const userStart = controlLocalAccountProxy({ action: 'start' });
      await controlLocalAccountProxy({ action: 'stop' });
      releaseRead();
      await userStart;
      await publishAccountProxyStatus();
      expect(jest.mocked(startLocalAccountProxy)).not.toHaveBeenCalled();
      expect(mockLocal.phase).toBe('stopped');
    });

    it('gives way to a disconnect made while it sets up', async () => {
      let releasePort: () => void = () => undefined;
      mockLocal.portGate = new Promise((resolve) => {
        releasePort = resolve;
      });
      const setUp = setUpLocalAccountProxy();
      await new Promise((resolve) => setImmediate(resolve));
      await disconnectAccountProxy();
      releasePort();
      await expect(setUp).resolves.toMatchObject({ ok: false });
      expect(preferences.accountProxyConnection ?? null).toBeNull();
      expect(jest.mocked(startLocalAccountProxy)).not.toHaveBeenCalled();
    });

    it('takes no new sessions and sends no keys while stopped', async () => {
      serveLocal(18555);
      await setUpLocalAccountProxy();
      await expect(
        getAccountProxyRouteTarget('claude'),
      ).resolves.not.toBeNull();
      await controlLocalAccountProxy({ action: 'stop' });
      fetchMock.mockClear();
      await expect(getAccountProxyRouteTarget('claude')).resolves.toBeNull();
      await getAccountProxyStatus({ refresh: true });
      expect(
        fetchMock.mock.calls.filter(([input]) =>
          (typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url
          ).includes('127.0.0.1:18555'),
        ),
      ).toEqual([]);
    });

    it('stops a start in progress when the feature is turned off', async () => {
      serveLocal(18555);
      await setUpLocalAccountProxy();
      await controlLocalAccountProxy({ action: 'stop' });
      jest.mocked(stopLocalAccountProxy).mockClear();
      let releaseStart: () => void = () => undefined;
      mockLocal.startGate = new Promise((resolve) => {
        releaseStart = resolve;
      });
      const starting = controlLocalAccountProxy({ action: 'start' });
      await new Promise((resolve) => setImmediate(resolve));
      preferences = { ...preferences, accountProxyEnabled: false };
      await publishAccountProxyStatus();
      expect(jest.mocked(stopLocalAccountProxy)).toHaveBeenCalled();
      mockLocal.startGate = null;
      releaseStart();
      await starting.catch(() => undefined);
    });

    it('stops a proxy whose start finished after the feature was turned off', async () => {
      serveLocal(18555);
      await setUpLocalAccountProxy();
      await controlLocalAccountProxy({ action: 'stop' });
      jest.mocked(stopLocalAccountProxy).mockClear();
      let releaseStart: () => void = () => undefined;
      mockLocal.startGate = new Promise((resolve) => {
        releaseStart = resolve;
      });
      const starting = controlLocalAccountProxy({ action: 'start' });
      await new Promise((resolve) => setImmediate(resolve));
      // Turned off without the status being published, as a direct
      // preferences write would.
      preferences = { ...preferences, accountProxyEnabled: false };
      mockLocal.startGate = null;
      releaseStart();
      await starting.catch(() => undefined);
      expect(jest.mocked(stopLocalAccountProxy)).toHaveBeenCalled();
    });

    it('sends account actions nowhere while stopped', async () => {
      serveLocal(18555);
      await setUpLocalAccountProxy();
      await getAccountProxyStatus({ refresh: true });
      await controlLocalAccountProxy({ action: 'stop' });
      fetchMock.mockClear();
      await expect(
        setAccountProxyAccountDisabled('15356e8f5d38e233', true),
      ).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('keeps a server connected while setup checked the runtime', async () => {
      await connectAccountProxy({
        url: 'https://proxy.example.com',
        managementKey: 'mk-test',
      });
      let releaseRuntime: () => void = () => undefined;
      mockLocal.runtimeGate = new Promise((resolve) => {
        releaseRuntime = resolve;
      });
      const setUp = setUpLocalAccountProxy();
      await new Promise((resolve) => setImmediate(resolve));
      mockLocal.runtimeGate = null;
      const connected = await connectAccountProxy({
        url: 'https://proxy.example.com',
        managementKey: 'mk-newer',
      });
      expect(connected.ok).toBe(true);
      const newer = preferences.accountProxyConnection?.id;
      releaseRuntime();
      await expect(setUp).resolves.toMatchObject({ ok: false });
      expect(preferences.accountProxyConnection).toMatchObject({
        id: newer,
        kind: 'server',
      });
      expect(jest.mocked(startLocalAccountProxy)).not.toHaveBeenCalled();
    });

    it('does not start the proxy after a stop made while it read its keys', async () => {
      serveLocal(18555);
      await setUpLocalAccountProxy();
      await controlLocalAccountProxy({ action: 'stop' });
      jest.mocked(startLocalAccountProxy).mockClear();
      let releaseLoad: () => void = () => undefined;
      loadGate = new Promise((resolve) => {
        releaseLoad = resolve;
      });
      const start = controlLocalAccountProxy({ action: 'start' });
      await new Promise((resolve) => setImmediate(resolve));
      const stop = controlLocalAccountProxy({ action: 'stop' });
      for (let tick = 0; tick < 5; tick++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      releaseLoad();
      loadGate = Promise.resolve();
      await Promise.all([start, stop]);
      expect(jest.mocked(startLocalAccountProxy)).not.toHaveBeenCalled();
      expect(mockLocal.phase).toBe('stopped');
    });

    it('cancels requests to the proxy before it is stopped or after it exits', async () => {
      serveLocal(18555);
      await setUpLocalAccountProxy();
      const beforeStop = accountProxyServingSignal();
      jest.mocked(stopLocalAccountProxy).mockImplementationOnce(() => {
        expect(beforeStop.aborted).toBe(true);
        mockLocal.phase = 'stopped';
        mockLocal.port = null;
        return Promise.resolve();
      });
      await controlLocalAccountProxy({ action: 'stop' });
      expect(beforeStop.aborted).toBe(true);
      await controlLocalAccountProxy({ action: 'start' });
      const beforeExit = accountProxyServingSignal();
      expect(beforeExit.aborted).toBe(false);
      mockLocal.phase = 'error';
      mockLocal.port = null;
      mockLocalListeners.forEach((listener) => {
        listener();
      });
      expect(beforeExit.aborted).toBe(true);
    });

    it('does not start the proxy after the feature is turned off while its keys load', async () => {
      serveLocal(18555);
      await setUpLocalAccountProxy();
      await controlLocalAccountProxy({ action: 'stop' });
      jest.mocked(startLocalAccountProxy).mockClear();
      let releaseLoad: () => void = () => undefined;
      loadGate = new Promise((resolve) => {
        releaseLoad = resolve;
      });
      const start = controlLocalAccountProxy({ action: 'start' });
      await new Promise((resolve) => setImmediate(resolve));
      preferences = { ...preferences, accountProxyEnabled: false };
      const publishing = publishAccountProxyStatus();
      await new Promise((resolve) => setImmediate(resolve));
      releaseLoad();
      loadGate = Promise.resolve();
      await publishing;
      await start.catch(() => undefined);
      expect(jest.mocked(startLocalAccountProxy)).not.toHaveBeenCalled();
    });

    it('lets a stop made while a start reads its settings win', async () => {
      serveLocal(18555);
      await setUpLocalAccountProxy();
      await controlLocalAccountProxy({ action: 'stop' });
      jest.mocked(startLocalAccountProxy).mockClear();
      let releaseRead: () => void = () => undefined;
      nextReadGate = new Promise((resolve) => {
        releaseRead = resolve;
      });
      const start = controlLocalAccountProxy({ action: 'start' });
      await new Promise((resolve) => setImmediate(resolve));
      await controlLocalAccountProxy({ action: 'stop' });
      releaseRead();
      await start;
      expect(jest.mocked(startLocalAccountProxy)).not.toHaveBeenCalled();
    });

    it('leaves a newer connection running when an older start finishes', async () => {
      serveLocal(18555);
      await setUpLocalAccountProxy();
      await controlLocalAccountProxy({ action: 'stop' });
      let releaseOlder: () => void = () => undefined;
      mockLocal.startGate = new Promise((resolve) => {
        releaseOlder = resolve;
      });
      const older = controlLocalAccountProxy({ action: 'start' });
      await new Promise((resolve) => setImmediate(resolve));
      mockLocal.startGate = null;
      await disconnectAccountProxy();
      await setUpLocalAccountProxy();
      const newer = preferences.accountProxyConnection?.id;
      jest.mocked(stopLocalAccountProxy).mockClear();
      releaseOlder();
      await older;
      expect(preferences.accountProxyConnection?.id).toBe(newer);
      expect(jest.mocked(stopLocalAccountProxy)).not.toHaveBeenCalled();
    });

    it('makes new keys when the proxy on this device has none', async () => {
      serveLocal(18555);
      await setUpLocalAccountProxy();
      const id = preferences.accountProxyConnection?.id ?? '';
      await controlLocalAccountProxy({ action: 'stop' });
      storedCredentials.delete(id);
      const result = await setUpLocalAccountProxy();
      expect(result.ok).toBe(true);
      expect(preferences.accountProxyConnection?.id).toBe(id);
      expect(storedCredentials.get(id)?.clientKey).toMatch(/^canopy-/);
    });

    it('keeps the keys when secure storage cannot be read', async () => {
      serveLocal(18555);
      await setUpLocalAccountProxy();
      const id = preferences.accountProxyConnection?.id ?? '';
      const before = storedCredentials.get(id);
      await controlLocalAccountProxy({ action: 'stop' });
      credentialReadError = new Error('locked');
      const result = await setUpLocalAccountProxy();
      credentialReadError = null;
      expect(result.ok).toBe(false);
      expect(storedCredentials.get(id)).toEqual(before);
    });

    it('does not start the proxy when the feature is turned off during setup', async () => {
      let releaseRuntime: () => void = () => undefined;
      mockLocal.runtimeGate = new Promise((resolve) => {
        releaseRuntime = resolve;
      });
      const setUp = setUpLocalAccountProxy();
      await new Promise((resolve) => setImmediate(resolve));
      mockLocal.runtimeGate = null;
      preferences = { ...preferences, accountProxyEnabled: false };
      await publishAccountProxyStatus();
      releaseRuntime();
      await setUp;
      expect(jest.mocked(startLocalAccountProxy)).not.toHaveBeenCalled();
    });

    it('keeps a server connection when the proxy keys cannot be saved', async () => {
      await connectAccountProxy({
        url: 'https://proxy.example.com',
        managementKey: 'mk-test',
      });
      const server = preferences.accountProxyConnection;
      const serverKeys = storedCredentials.get(server?.id ?? '');
      jest
        .mocked(saveAccountProxyCredentials)
        .mockRejectedValueOnce(new Error('Secure storage is locked.'));
      await expect(setUpLocalAccountProxy()).resolves.toMatchObject({
        ok: false,
      });
      expect(preferences.accountProxyConnection).toEqual(server);
      expect(storedCredentials.get(server?.id ?? '')).toEqual(serverKeys);
    });

    it('makes new keys when Start finds the proxy keys gone', async () => {
      serveLocal(18555);
      await setUpLocalAccountProxy();
      const id = preferences.accountProxyConnection?.id ?? '';
      await controlLocalAccountProxy({ action: 'stop' });
      storedCredentials.delete(id);
      jest.mocked(startLocalAccountProxy).mockClear();
      await controlLocalAccountProxy({ action: 'start' });
      expect(jest.mocked(startLocalAccountProxy)).toHaveBeenCalledTimes(1);
      expect(storedCredentials.get(id)?.clientKey).toMatch(/^canopy-/);
    });

    it('keeps a server connection when no port is free for the proxy', async () => {
      await connectAccountProxy({
        url: 'https://proxy.example.com',
        managementKey: 'mk-test',
      });
      const server = preferences.accountProxyConnection;
      mockLocal.portError = new LocalAccountProxyError(
        'local-failed',
        'No free port.',
      );
      await expect(setUpLocalAccountProxy()).resolves.toMatchObject({
        ok: false,
      });
      expect(preferences.accountProxyConnection).toEqual(server);
    });

    it('keeps the port of the newest start', async () => {
      serveLocal(18555);
      serveLocal(25001);
      serveLocal(25002);
      await setUpLocalAccountProxy();
      await controlLocalAccountProxy({ action: 'stop' });
      let finishOlder: () => void = () => undefined;
      jest.mocked(startLocalAccountProxy).mockImplementationOnce(() => {
        mockLocal.phase = 'running';
        mockLocal.port = 25001;
        return new Promise<number>((resolve) => {
          finishOlder = (): void => {
            resolve(25001);
          };
        });
      });
      const older = controlLocalAccountProxy({ action: 'start' });
      await new Promise((resolve) => setImmediate(resolve));
      mockLocal.nextPort = 25002;
      await controlLocalAccountProxy({ action: 'restart' });
      expect(preferences.accountProxyConnection?.url).toBe(
        'http://127.0.0.1:25002',
      );
      finishOlder();
      await older;
      expect(preferences.accountProxyConnection?.url).toBe(
        'http://127.0.0.1:25002',
      );
    });

    it('lets a stop made during a restart win', async () => {
      serveLocal(18555);
      await setUpLocalAccountProxy();
      let releaseStop: () => void = () => undefined;
      jest.mocked(stopLocalAccountProxy).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseStop = (): void => {
              mockLocal.phase = 'stopped';
              mockLocal.port = null;
              resolve();
            };
          }),
      );
      jest.mocked(startLocalAccountProxy).mockClear();
      const restart = controlLocalAccountProxy({ action: 'restart' });
      await new Promise((resolve) => setImmediate(resolve));
      const stop = controlLocalAccountProxy({ action: 'stop' });
      await new Promise((resolve) => setImmediate(resolve));
      releaseStop();
      await Promise.all([restart, stop]);
      expect(jest.mocked(startLocalAccountProxy)).not.toHaveBeenCalled();
      expect(mockLocal.phase).toBe('stopped');
    });

    it('routes again with a refused client key once the proxy restarts', async () => {
      serveLocal(18555);
      await setUpLocalAccountProxy();
      const id = preferences.accountProxyConnection?.id ?? '';
      reportAccountProxyClientKeyRejected(
        accountProxyClientKeyFingerprint(
          storedCredentials.get(id)?.clientKey ?? '',
        ),
      );
      await expect(getAccountProxyRouteTarget('claude')).resolves.toBeNull();
      await controlLocalAccountProxy({ action: 'restart' });
      await expect(
        getAccountProxyRouteTarget('claude'),
      ).resolves.not.toBeNull();
    });

    it('never repairs the client key of the proxy on this device', async () => {
      serveLocal(18555);
      await setUpLocalAccountProxy();
      const id = preferences.accountProxyConnection?.id ?? '';
      const clientKey = storedCredentials.get(id)?.clientKey ?? '';
      reportAccountProxyClientKeyRejected(
        accountProxyClientKeyFingerprint(clientKey),
      );
      fetchMock.mockClear();
      await expect(getAccountProxyRouteTarget('claude')).resolves.toBeNull();
      expect(
        fetchMock.mock.calls.filter(([input]) =>
          (typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url
          ).includes('/v8/management/'),
        ),
      ).toEqual([]);
    });

    it('takes no session when the proxy stops while its keys are read', async () => {
      serveLocal(18555);
      await setUpLocalAccountProxy();
      await expect(
        getAccountProxyRouteTarget('claude'),
      ).resolves.not.toBeNull();
      let releaseLoad: () => void = () => undefined;
      loadGate = new Promise((resolve) => {
        releaseLoad = resolve;
      });
      const lookup = getAccountProxyRouteTarget('claude');
      await new Promise((resolve) => setImmediate(resolve));
      // Stopped without a new generation: only the serving check can tell.
      mockLocal.phase = 'stopped';
      mockLocal.port = null;
      releaseLoad();
      loadGate = Promise.resolve();
      await expect(lookup).resolves.toBeNull();
    });

    it('sends no keys after the proxy exits during a refresh', async () => {
      serveLocal(18555);
      await setUpLocalAccountProxy();
      let releaseLoad: () => void = () => undefined;
      loadGate = new Promise((resolve) => {
        releaseLoad = resolve;
      });
      const refresh = getAccountProxyStatus({ refresh: true });
      await new Promise((resolve) => setImmediate(resolve));
      mockLocal.phase = 'error';
      mockLocal.port = null;
      mockLocalListeners.forEach((listener) => {
        listener();
      });
      fetchMock.mockClear();
      releaseLoad();
      loadGate = Promise.resolve();
      await refresh;
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('names whether the proxy is running in the session settings', async () => {
      serveLocal(18555);
      await setUpLocalAccountProxy();
      const id = preferences.accountProxyConnection?.id ?? '';
      expect(accountProxySettingsSignature('claude')).toBe(
        `account-proxy:${id}:on:keep:local-18555`,
      );
      await controlLocalAccountProxy({ action: 'stop' });
      expect(accountProxySettingsSignature('claude')).toBe(
        `account-proxy:${id}:on:keep:local-stopped`,
      );
    });

    it('cancels refreshes in flight when the feature is turned off', async () => {
      serveLocal(18555);
      await setUpLocalAccountProxy();
      let releaseLoad: () => void = () => undefined;
      loadGate = new Promise((resolve) => {
        releaseLoad = resolve;
      });
      const refresh = getAccountProxyStatus({ refresh: true });
      await new Promise((resolve) => setImmediate(resolve));
      preferences = { ...preferences, accountProxyEnabled: false };
      const publishing = publishAccountProxyStatus();
      await new Promise((resolve) => setImmediate(resolve));
      fetchMock.mockClear();
      releaseLoad();
      loadGate = Promise.resolve();
      await publishing;
      await refresh;
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('keeps a disconnect made while setup replaces a server', async () => {
      await connectAccountProxy({
        url: 'proxy.example.com',
        managementKey: 'mk-test',
      });
      let releaseRevoke: () => void = () => undefined;
      const revokeGate = new Promise<void>((resolve) => {
        releaseRevoke = resolve;
      });
      const put = routes.get(
        'PUT https://proxy.example.com/v8/management/config/access/api-keys',
      );
      routes.set(
        'PUT https://proxy.example.com/v8/management/config/access/api-keys',
        async (init) => {
          await revokeGate;
          return put ? put(init) : json({ status: 'ok' });
        },
      );
      const setUp = setUpLocalAccountProxy();
      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      const userDisconnect = disconnectAccountProxy();
      releaseRevoke();
      await userDisconnect;
      await expect(setUp).resolves.toMatchObject({ ok: false });
      expect(preferences.accountProxyConnection ?? null).toBeNull();
      expect(jest.mocked(startLocalAccountProxy)).not.toHaveBeenCalled();
    });

    it('stops the proxy on this device when a server replaces it', async () => {
      serveLocal(18555);
      await setUpLocalAccountProxy();
      jest.mocked(stopLocalAccountProxy).mockClear();
      await connectAccountProxy({
        url: 'proxy.example.com',
        managementKey: 'mk-test',
      });
      expect(preferences.accountProxyConnection?.kind).toBe('server');
      expect(jest.mocked(stopLocalAccountProxy)).toHaveBeenCalled();
    });

    it('starts with the app only when set to', async () => {
      serveLocal(18555);
      await setUpLocalAccountProxy();
      await controlLocalAccountProxy({ action: 'stop' });
      jest.mocked(startLocalAccountProxy).mockClear();
      preferences = { ...preferences, accountProxyLocalStartWithApp: false };
      await initializeLocalAccountProxy();
      expect(jest.mocked(startLocalAccountProxy)).not.toHaveBeenCalled();
      preferences = { ...preferences, accountProxyLocalStartWithApp: true };
      await initializeLocalAccountProxy();
      expect(jest.mocked(startLocalAccountProxy)).toHaveBeenCalledTimes(1);
    });
  });

  describe('signing an account in on the proxy on this device', () => {
    const LOCAL = 'http://127.0.0.1:18555/v8/management';
    const STATE = 'state0123456789abcdef';
    let authStatus: unknown = { status: 'wait' };
    let cancelled: string[] = [];

    function serveSignIn(
      page = `https://claude.ai/oauth/authorize?state=${STATE}`,
    ): void {
      routes.set(`GET ${LOCAL}/credentials`, () => json(CREDENTIALS));
      routes.set(`GET ${LOCAL}/config`, () => json(CONFIG));
      routes.set(
        `GET ${LOCAL}/oauth/auth-url?provider=claude&is_webui=true`,
        () => json({ status: 'ok', url: page, state: STATE }),
      );
      routes.set(`GET ${LOCAL}/oauth/status?state=${STATE}`, () =>
        json(authStatus),
      );
      routes.set(`DELETE ${LOCAL}/oauth/session?state=${STATE}`, () => {
        cancelled.push(STATE);
        return json({ status: 'ok', cancelled: true });
      });
    }

    beforeEach(async () => {
      authStatus = { status: 'wait' };
      cancelled = [];
      jest.mocked(openExternalGuarded).mockClear();
      serveSignIn();
      await setUpLocalAccountProxy();
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    function holdAuthUrl(): () => void {
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      routes.set(
        `GET ${LOCAL}/oauth/auth-url?provider=claude&is_webui=true`,
        async () => {
          await held;
          return json({
            status: 'ok',
            url: `https://claude.ai/oauth/authorize?state=${STATE}`,
            state: STATE,
          });
        },
      );
      return release;
    }

    it('keeps a starting sign-in when another one finishes', async () => {
      await signInLocalAccountProxyAccount({
        action: 'start',
        provider: 'claude',
      });
      const CODEX_STATE = 'codexstate0123456789';
      routes.set(
        `GET ${LOCAL}/oauth/auth-url?provider=codex&is_webui=true`,
        () =>
          json({
            status: 'ok',
            url: `https://auth.openai.com/oauth/authorize?state=${CODEX_STATE}`,
            state: CODEX_STATE,
          }),
      );
      routes.set(`GET ${LOCAL}/oauth/status?state=${CODEX_STATE}`, () =>
        json({ status: 'wait' }),
      );
      authStatus = { status: 'ok' };
      let releaseRead: () => void = () => undefined;
      nextReadGate = new Promise((resolve) => {
        releaseRead = resolve;
      });
      const codex = signInLocalAccountProxyAccount({
        action: 'start',
        provider: 'codex',
      });
      await new Promise((resolve) => setImmediate(resolve));
      // The Claude sign-in finishes while the Codex one starts.
      await jest.advanceTimersByTimeAsync(2_000);
      releaseRead();
      const status = await codex;
      expect(status.signIn).toMatchObject({
        provider: 'codex',
        phase: 'waiting',
      });
    });

    it('stops waiting on a sign-in when the proxy refuses its key', async () => {
      await signInLocalAccountProxyAccount({
        action: 'start',
        provider: 'claude',
      });
      let polls = 0;
      routes.set(`GET ${LOCAL}/oauth/status?state=${STATE}`, () => {
        polls += 1;
        return json({ error: 'unauthorized' }, 401);
      });
      await jest.advanceTimersByTimeAsync(2_000);
      await jest.advanceTimersByTimeAsync(4_000);
      expect(polls).toBe(1);
      const status = await getAccountProxyStatus();
      expect(status.signIn).toMatchObject({ phase: 'failed' });
    });

    it('does not send a key the proxy refused when sign-in started', async () => {
      let starts = 0;
      routes.set(
        `GET ${LOCAL}/oauth/auth-url?provider=claude&is_webui=true`,
        () => {
          starts += 1;
          return json({ error: 'unauthorized' }, 401);
        },
      );
      await expect(
        signInLocalAccountProxyAccount({ action: 'start', provider: 'claude' }),
      ).rejects.toThrow();
      await expect(
        signInLocalAccountProxyAccount({ action: 'start', provider: 'claude' }),
      ).rejects.toThrow();
      expect(starts).toBe(1);
    });

    it('ends a waiting sign-in when the feature is turned off', async () => {
      await signInLocalAccountProxyAccount({
        action: 'start',
        provider: 'claude',
      });
      let polls = 0;
      routes.set(`GET ${LOCAL}/oauth/status?state=${STATE}`, () => {
        polls += 1;
        return json({ status: 'wait' });
      });
      preferences = { ...preferences, accountProxyEnabled: false };
      await publishAccountProxyStatus();
      preferences = { ...preferences, accountProxyEnabled: true };
      await jest.advanceTimersByTimeAsync(6_000);
      expect(polls).toBe(0);
      expect((await getAccountProxyStatus()).signIn).toBeNull();
    });

    it('lists the new account even when a refresh was already running', async () => {
      await signInLocalAccountProxyAccount({
        action: 'start',
        provider: 'claude',
      });
      const added = {
        ...CREDENTIALS.files[0],
        auth_index: 'b2c3d4e5b2c3d4e5',
        email: 'new@example.com',
        name: 'claude-new@example.com.json',
      };
      let releaseOld: () => void = () => undefined;
      const oldHeld = new Promise<void>((resolve) => {
        releaseOld = resolve;
      });
      let reads = 0;
      routes.set(`GET ${LOCAL}/credentials`, async () => {
        reads += 1;
        if (reads === 1) {
          // A refresh that read the accounts before the sign-in finished.
          await oldHeld;
          return json(CREDENTIALS);
        }
        return json({ files: [...CREDENTIALS.files, added] });
      });
      const older = getAccountProxyStatus({ refresh: true });
      await new Promise((resolve) => setImmediate(resolve));
      authStatus = { status: 'ok' };
      await jest.advanceTimersByTimeAsync(2_000);
      releaseOld();
      await older;
      await jest.advanceTimersByTimeAsync(0);
      for (let tick = 0; tick < 10; tick++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      const status = await getAccountProxyStatus();
      expect(status.accounts.map((account) => account.authIndex)).toContain(
        'b2c3d4e5b2c3d4e5',
      );
    });

    it('refuses a second sign-in while one is starting', async () => {
      const release = holdAuthUrl();
      const first = signInLocalAccountProxyAccount({
        action: 'start',
        provider: 'claude',
      });
      await new Promise((resolve) => setImmediate(resolve));
      await expect(
        signInLocalAccountProxyAccount({ action: 'start', provider: 'claude' }),
      ).rejects.toThrow();
      release();
      await first;
      expect(jest.mocked(openExternalGuarded)).toHaveBeenCalledTimes(1);
    });

    it('drops and closes a sign-in cancelled while it was starting', async () => {
      const release = holdAuthUrl();
      const start = signInLocalAccountProxyAccount({
        action: 'start',
        provider: 'claude',
      });
      await new Promise((resolve) => setImmediate(resolve));
      await signInLocalAccountProxyAccount({ action: 'cancel' });
      release();
      await start.catch(() => undefined);
      expect(jest.mocked(openExternalGuarded)).not.toHaveBeenCalled();
      expect(cancelled).toEqual([STATE]);
      const status = await getAccountProxyStatus();
      expect(status.signIn).toBeNull();
    });

    it('sends no sign-in request when the proxy stops while its keys load', async () => {
      let releaseLoad: () => void = () => undefined;
      loadGate = new Promise((resolve) => {
        releaseLoad = resolve;
      });
      const start = signInLocalAccountProxyAccount({
        action: 'start',
        provider: 'claude',
      });
      await new Promise((resolve) => setImmediate(resolve));
      const stopping = controlLocalAccountProxy({ action: 'stop' });
      await new Promise((resolve) => setImmediate(resolve));
      fetchMock.mockClear();
      releaseLoad();
      loadGate = Promise.resolve();
      await stopping;
      await expect(start).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(jest.mocked(openExternalGuarded)).not.toHaveBeenCalled();
    });

    it('opens the provider page and adds the account when sign-in finishes', async () => {
      const waiting = await signInLocalAccountProxyAccount({
        action: 'start',
        provider: 'claude',
      });
      expect(jest.mocked(openExternalGuarded)).toHaveBeenCalledWith(
        `https://claude.ai/oauth/authorize?state=${STATE}`,
      );
      expect(waiting.signIn).toEqual({
        provider: 'claude',
        phase: 'waiting',
        message: null,
      });
      await jest.advanceTimersByTimeAsync(2_000);
      expect((await getAccountProxyStatus()).signIn?.phase).toBe('waiting');
      authStatus = { status: 'ok' };
      await jest.advanceTimersByTimeAsync(2_000);
      expect((await getAccountProxyStatus()).signIn).toBeNull();
    });

    it('keeps why a sign-in failed', async () => {
      await signInLocalAccountProxyAccount({
        action: 'start',
        provider: 'claude',
      });
      authStatus = {
        status: 'error',
        error: 'Failed to exchange authorization code for tokens',
      };
      await jest.advanceTimersByTimeAsync(2_000);
      expect((await getAccountProxyStatus()).signIn).toEqual({
        provider: 'claude',
        phase: 'failed',
        message: 'Failed to exchange authorization code for tokens',
      });
    });

    it('never opens a page outside the provider sign-in host', async () => {
      serveSignIn('https://claude.ai.example.com/oauth/authorize');
      await expect(
        signInLocalAccountProxyAccount({ action: 'start', provider: 'claude' }),
      ).rejects.toThrow('unexpected sign-in page');
      serveSignIn('http://claude.ai/oauth/authorize');
      await expect(
        signInLocalAccountProxyAccount({ action: 'start', provider: 'claude' }),
      ).rejects.toThrow('unexpected sign-in page');
      expect(jest.mocked(openExternalGuarded)).not.toHaveBeenCalled();
    });

    it('cancels the sign-in on the proxy', async () => {
      await signInLocalAccountProxyAccount({
        action: 'start',
        provider: 'claude',
      });
      const status = await signInLocalAccountProxyAccount({ action: 'cancel' });
      expect(status.signIn).toBeNull();
      expect(cancelled).toEqual([STATE]);
    });

    it('opens the page again on request', async () => {
      await signInLocalAccountProxyAccount({
        action: 'start',
        provider: 'claude',
      });
      await signInLocalAccountProxyAccount({ action: 'reopen' });
      expect(jest.mocked(openExternalGuarded)).toHaveBeenCalledTimes(2);
    });

    it('ends the sign-in when the proxy stops', async () => {
      await signInLocalAccountProxyAccount({
        action: 'start',
        provider: 'claude',
      });
      const status = await controlLocalAccountProxy({ action: 'stop' });
      expect(status.signIn).toBeNull();
    });

    it('refuses while the proxy is stopped', async () => {
      await controlLocalAccountProxy({ action: 'stop' });
      await expect(
        signInLocalAccountProxyAccount({ action: 'start', provider: 'claude' }),
      ).rejects.toThrow('Start the proxy');
    });

    describe('from a controlling computer', () => {
      const PAGE = `https://claude.ai/oauth/authorize?state=${STATE}`;
      let callbacks: unknown[] = [];
      let callbackStatus = 200;

      interface FakeRemoteTarget {
        readonly controllerDeviceId: string;
        readonly open: jest.Mock<
          Promise<void>,
          [AccountProxySignInPageRequest]
        >;
        readonly end: jest.Mock<void, [string]>;
        readonly onClosed: jest.Mock<() => void, [() => void]>;
        close(): void;
      }

      function remoteTarget(
        controllerDeviceId = 'controller-a',
      ): FakeRemoteTarget {
        const closedListeners = new Set<() => void>();
        return {
          controllerDeviceId,
          open: jest.fn<Promise<void>, [AccountProxySignInPageRequest]>(() =>
            Promise.resolve(),
          ),
          end: jest.fn<void, [string]>(),
          onClosed: jest.fn((listener: () => void) => {
            closedListeners.add(listener);
            return (): void => {
              closedListeners.delete(listener);
            };
          }),
          close(): void {
            for (const listener of Array.from(closedListeners)) listener();
          },
        };
      }

      beforeEach(() => {
        callbacks = [];
        callbackStatus = 200;
        routes.set(`GET ${LOCAL}/oauth/auth-url?provider=claude`, () =>
          json({ status: 'ok', url: PAGE, state: STATE }),
        );
        routes.set(`POST ${LOCAL}/oauth/callback`, (init) => {
          callbacks.push(
            JSON.parse(typeof init?.body === 'string' ? init.body : 'null'),
          );
          return callbackStatus === 200
            ? json({ status: 'ok' })
            : json(
                { status: 'error', error: 'unknown or expired state' },
                callbackStatus,
              );
        });
      });

      function requested(path: string): boolean {
        return fetchMock.mock.calls.some(
          ([input]) =>
            (typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.href
                : input.url) === path,
        );
      }

      it('opens the page on that computer and hands its redirect to the proxy', async () => {
        const remote = remoteTarget();
        const status = await signInLocalAccountProxyAccount(
          { action: 'start', provider: 'claude' },
          remote,
        );
        expect(status.signIn).toMatchObject({ phase: 'waiting' });
        expect(remote.open).toHaveBeenCalledWith({
          provider: 'claude',
          url: PAGE,
          state: STATE,
        });
        expect(jest.mocked(openExternalGuarded)).not.toHaveBeenCalled();
        // Nothing on this computer listens for the redirect.
        expect(requested(`${LOCAL}/oauth/auth-url?provider=claude`)).toBe(true);
        expect(
          requested(`${LOCAL}/oauth/auth-url?provider=claude&is_webui=true`),
        ).toBe(false);

        await completeRemoteAccountProxySignIn('controller-a', {
          state: STATE,
          code: 'the-code',
          error: null,
        });
        expect(callbacks).toEqual([{ state: STATE, code: 'the-code' }]);
        authStatus = { status: 'ok' };
        await jest.advanceTimersByTimeAsync(2_000);
        expect((await getAccountProxyStatus()).signIn).toBeNull();
        // That computer stopped listening once it sent the redirect.
        expect(remote.end).not.toHaveBeenCalled();
      });

      it('sends a provider refusal on, and the proxy reports the failure', async () => {
        const remote = remoteTarget();
        await signInLocalAccountProxyAccount(
          { action: 'start', provider: 'claude' },
          remote,
        );
        await completeRemoteAccountProxySignIn('controller-a', {
          state: STATE,
          code: null,
          error: 'access_denied',
        });
        expect(callbacks).toEqual([{ state: STATE, error: 'access_denied' }]);
        authStatus = { status: 'error', error: 'Bad request' };
        await jest.advanceTimersByTimeAsync(2_000);
        expect((await getAccountProxyStatus()).signIn).toMatchObject({
          phase: 'failed',
          message: 'Bad request',
        });
      });

      it('takes no redirect from another computer, for another state, or twice', async () => {
        const remote = remoteTarget();
        await signInLocalAccountProxyAccount(
          { action: 'start', provider: 'claude' },
          remote,
        );
        await expect(
          completeRemoteAccountProxySignIn('controller-b', {
            state: STATE,
            code: 'c',
            error: null,
          }),
        ).rejects.toThrow('no longer waiting');
        await expect(
          completeRemoteAccountProxySignIn('controller-a', {
            state: 'otherstate0123456789',
            code: 'c',
            error: null,
          }),
        ).rejects.toThrow('no longer waiting');
        expect(callbacks).toEqual([]);
        await completeRemoteAccountProxySignIn('controller-a', {
          state: STATE,
          code: 'c',
          error: null,
        });
        await expect(
          completeRemoteAccountProxySignIn('controller-a', {
            state: STATE,
            code: 'c',
            error: null,
          }),
        ).rejects.toThrow('no longer waiting');
        expect(callbacks).toHaveLength(1);
      });

      it('takes no redirect for a sign-in started on this computer', async () => {
        await signInLocalAccountProxyAccount({
          action: 'start',
          provider: 'claude',
        });
        await expect(
          completeRemoteAccountProxySignIn('controller-a', {
            state: STATE,
            code: 'c',
            error: null,
          }),
        ).rejects.toThrow('no longer waiting');
        expect(callbacks).toEqual([]);
      });

      it('ends the sign-in on the proxy when that computer cannot open it', async () => {
        const remote = remoteTarget();
        remote.open.mockRejectedValueOnce(new Error('Port 54545 is in use.'));
        await expect(
          signInLocalAccountProxyAccount(
            { action: 'start', provider: 'claude' },
            remote,
          ),
        ).rejects.toThrow('Port 54545 is in use.');
        expect(cancelled).toEqual([STATE]);
        expect((await getAccountProxyStatus()).signIn).toBeNull();
        expect(jest.mocked(openExternalGuarded)).not.toHaveBeenCalled();
      });

      it('fails the sign-in when the computers disconnect', async () => {
        const remote = remoteTarget();
        await signInLocalAccountProxyAccount(
          { action: 'start', provider: 'claude' },
          remote,
        );
        remote.close();
        expect((await getAccountProxyStatus()).signIn).toMatchObject({
          phase: 'failed',
          message: expect.stringContaining('disconnected') as unknown,
        });
        await expect(
          completeRemoteAccountProxySignIn('controller-a', {
            state: STATE,
            code: 'c',
            error: null,
          }),
        ).rejects.toThrow('no longer waiting');
      });

      it('tells that computer to stop listening when cancelled', async () => {
        const remote = remoteTarget();
        await signInLocalAccountProxyAccount(
          { action: 'start', provider: 'claude' },
          remote,
        );
        await signInLocalAccountProxyAccount({ action: 'cancel' });
        expect(remote.end).toHaveBeenCalledWith(STATE);
        expect(cancelled).toEqual([STATE]);
      });

      it('tells that computer to stop listening when the sign-in times out', async () => {
        const remote = remoteTarget();
        await signInLocalAccountProxyAccount(
          { action: 'start', provider: 'claude' },
          remote,
        );
        await jest.advanceTimersByTimeAsync(10 * 60_000 + 4_000);
        expect((await getAccountProxyStatus()).signIn).toMatchObject({
          phase: 'failed',
          message: 'Sign-in timed out. Try again.',
        });
        expect(remote.end).toHaveBeenCalledTimes(1);
      });

      it('fails the sign-in when the proxy refuses the redirect', async () => {
        const remote = remoteTarget();
        await signInLocalAccountProxyAccount(
          { action: 'start', provider: 'claude' },
          remote,
        );
        callbackStatus = 404;
        await expect(
          completeRemoteAccountProxySignIn('controller-a', {
            state: STATE,
            code: 'c',
            error: null,
          }),
        ).rejects.toThrow('did not accept');
        expect((await getAccountProxyStatus()).signIn).toMatchObject({
          phase: 'failed',
        });
      });

      function statusPolls(): number {
        return fetchMock.mock.calls.filter(([input]) =>
          (typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url
          ).startsWith(`${LOCAL}/oauth/status`),
        ).length;
      }

      it('keeps the disconnect reason and stops polling', async () => {
        const remote = remoteTarget();
        await signInLocalAccountProxyAccount(
          { action: 'start', provider: 'claude' },
          remote,
        );
        await jest.advanceTimersByTimeAsync(2_000);
        const polls = statusPolls();
        remote.close();
        authStatus = { status: 'error', error: 'Bad request' };
        await jest.advanceTimersByTimeAsync(11 * 60_000);
        expect(statusPolls()).toBe(polls);
        expect((await getAccountProxyStatus()).signIn).toEqual({
          provider: 'claude',
          phase: 'failed',
          message:
            'The computers disconnected before the sign-in finished. Try again.',
        });
      });

      it('keeps the refusal reason and stops polling', async () => {
        const remote = remoteTarget();
        await signInLocalAccountProxyAccount(
          { action: 'start', provider: 'claude' },
          remote,
        );
        callbackStatus = 404;
        await expect(
          completeRemoteAccountProxySignIn('controller-a', {
            state: STATE,
            code: 'c',
            error: null,
          }),
        ).rejects.toThrow('did not accept');
        const polls = statusPolls();
        authStatus = { status: 'error', error: 'Bad request' };
        await jest.advanceTimersByTimeAsync(11 * 60_000);
        expect(statusPolls()).toBe(polls);
        expect((await getAccountProxyStatus()).signIn).toEqual({
          provider: 'claude',
          phase: 'failed',
          message: 'The proxy did not accept the sign-in. Try again.',
        });
      });

      it('keeps a newer sign-in when the remote open of an older one fails', async () => {
        const remote = remoteTarget();
        let failOpen: (error: Error) => void = () => undefined;
        remote.open.mockImplementationOnce(
          () =>
            new Promise<void>((_resolve, reject) => {
              failOpen = reject;
            }),
        );
        const older = signInLocalAccountProxyAccount(
          { action: 'start', provider: 'claude' },
          remote,
        );
        await jest.advanceTimersByTimeAsync(0);
        expect(remote.open).toHaveBeenCalledTimes(1);
        let releaseLoad: () => void = () => undefined;
        loadGate = new Promise<void>((resolve) => {
          releaseLoad = resolve;
        });
        const newer = signInLocalAccountProxyAccount({
          action: 'start',
          provider: 'claude',
        });
        await jest.advanceTimersByTimeAsync(0);
        const olderFailed = expect(older).rejects.toThrow(
          'Port 54545 is in use.',
        );
        failOpen(new Error('Port 54545 is in use.'));
        await jest.advanceTimersByTimeAsync(0);
        releaseLoad();
        loadGate = Promise.resolve();
        await olderFailed;
        const status = await newer;
        expect(status.signIn).toEqual({
          provider: 'claude',
          phase: 'waiting',
          message: null,
        });
        expect(jest.mocked(openExternalGuarded)).toHaveBeenCalledTimes(1);
      });

      it('tells that computer again to stop when the sign-in ended while it was opening', async () => {
        const remote = remoteTarget();
        let finishOpen: () => void = () => undefined;
        remote.open.mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              finishOpen = resolve;
            }),
        );
        const start = signInLocalAccountProxyAccount(
          { action: 'start', provider: 'claude' },
          remote,
        );
        await jest.advanceTimersByTimeAsync(0);
        expect(remote.open).toHaveBeenCalledTimes(1);
        await signInLocalAccountProxyAccount({ action: 'cancel' });
        expect(remote.end).toHaveBeenCalledTimes(1);
        finishOpen();
        await start;
        expect(remote.end).toHaveBeenCalledTimes(2);
        expect(remote.end).toHaveBeenLastCalledWith(STATE);
        expect(remote.onClosed).not.toHaveBeenCalled();
      });

      it('opens the page again on that computer', async () => {
        const remote = remoteTarget();
        await signInLocalAccountProxyAccount(
          { action: 'start', provider: 'claude' },
          remote,
        );
        await signInLocalAccountProxyAccount({ action: 'reopen' });
        expect(remote.open).toHaveBeenCalledTimes(2);
        expect(remote.onClosed).toHaveBeenCalledTimes(1);
        expect(jest.mocked(openExternalGuarded)).not.toHaveBeenCalled();
      });
    });
  });
});
