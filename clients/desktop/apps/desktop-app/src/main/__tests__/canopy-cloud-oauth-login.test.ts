import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { createHash } from 'node:crypto';
import type { CanopyCloudAccountPublicState } from '@canopy/desktop-shared/types';
import type { AppDiagnosticRecord } from '../observability/service';

const mockOpenExternal = jest.fn<Promise<void>, [string]>();
const mockFocusMainWindow = jest.fn();
const mockRecordAppDiagnostic = jest.fn<void, [AppDiagnosticRecord]>();
const mockElectronApp: { getVersion?: jest.Mock<string, []> } = {
  getVersion: jest.fn(() => '1.2.3'),
};

jest.mock('electron', () => ({
  app: mockElectronApp,
}));
// The opener's E2E gate and loop guards are covered by open-external.test.ts.
// Here the login only has to hand its authorize URL to the opener, so mock it
// and the gate instead of depending on the __CANOPY_E2E__ global.
jest.mock('../lib/open-external', () => ({
  openExternalGuarded: mockOpenExternal,
}));
jest.mock('../lib/e2e-gate', () => ({
  isE2eBuild: (): boolean => false,
}));
jest.mock('../canopy-cloud/config', () => ({
  getCanopyCloudBaseUrl: jest.fn(() => 'https://cloud.example.test'),
}));
jest.mock('../portal/portal-state-store', () => ({
  readPortalStateStore: jest.fn(() =>
    Promise.resolve({ version: 1, clientDeviceId: 'device-1' }),
  ),
}));
jest.mock('../lib/main-window-focus', () => ({
  focusMainWindow: mockFocusMainWindow,
}));
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: mockRecordAppDiagnostic,
  })),
}));
const mockSaveCanopyCloudAccount = jest.fn();
const mockPersistCanopyCloudAccount = jest.fn();
const mockLoadCanopyCloudAccount = jest.fn();
const mockPurgeSharedContainerReplicas = jest.fn(() => Promise.resolve());
const mockWithSharedContainerReplicaPurgeFence = jest.fn(
  async (operation: () => Promise<unknown>): Promise<unknown> => {
    await mockPurgeSharedContainerReplicas();
    return operation();
  },
);
const mockReconcileSharedContainerOrganizationSnapshot = jest.fn(
  async (
    _organizationIds: readonly string[],
    afterCleanup: () => Promise<unknown>,
  ): Promise<unknown> => afterCleanup(),
);
interface SavedAccountEntry {
  apiKey?: string;
  authMode?: string;
  credentialSource?: string;
  serverApiKeyId?: string;
  capabilities?: string[];
}
const mockApplyEnforcedSettings = jest.fn<
  Promise<void>,
  [CanopyCloudAccountPublicState]
>(() => Promise.resolve());
jest.mock('../services/org-enforced-settings', () => ({
  applyEnforcedSettings: mockApplyEnforcedSettings,
}));
jest.mock('../lib/canopy-cloud-account-store', () => ({
  hasCanopyCloudIdentityChanged: (
    previous: { account?: { id?: string }; apiKey?: string } | null,
    next: { account?: { id?: string }; apiKey?: string },
  ): boolean =>
    previous !== null &&
    (previous.account?.id ?? previous.apiKey) !==
      (next.account?.id ?? next.apiKey),
  saveCanopyCloudAccount: mockSaveCanopyCloudAccount,
  loadCanopyCloudAccount: mockLoadCanopyCloudAccount,
  subscribeCanopyCloudAccountChanges: jest.fn(() => jest.fn()),
  toPublicCanopyCloudAccountState: jest.fn(
    (entry: SavedAccountEntry | null) => ({
      hasApiKey: !!entry?.apiKey,
      authMode: entry?.authMode ?? null,
      credentialSource: entry?.credentialSource ?? null,
      serverApiKeyId: entry?.serverApiKeyId,
      capabilities: entry?.capabilities ?? [],
      storageAvailable: true,
    }),
  ),
}));
jest.mock('../shared-containers/reconciliation-service', () => ({
  getSharedContainerReconciliationService: (): {
    purgeAll: () => Promise<void>;
    withReplicaPurgeFence: (
      operation: () => Promise<unknown>,
    ) => Promise<unknown>;
    reconcileOrganizationSnapshot: (
      organizationIds: readonly string[],
      afterCleanup: () => Promise<unknown>,
    ) => Promise<unknown>;
  } => ({
    purgeAll: mockPurgeSharedContainerReplicas,
    withReplicaPurgeFence: mockWithSharedContainerReplicaPurgeFence,
    reconcileOrganizationSnapshot:
      mockReconcileSharedContainerOrganizationSnapshot,
  }),
}));

import {
  cancelCanopyCloudOAuthLogin,
  startCanopyCloudOAuthLogin,
} from '../canopy-cloud/oauth-login';

const originalFetch = global.fetch;
const fetchMock: jest.MockedFunction<typeof fetch> = jest.fn();

const OPEN_EXTERNAL_DEADLINE_MS = 2_000;

/**
 * Summarizes how far the login got, so a missing browser open says whether
 * the callback server ever reported its `start` stage.
 */
function describeOAuthProgress(): string {
  return JSON.stringify({
    openExternalCalls: mockOpenExternal.mock.calls.length,
    diagnostics: mockRecordAppDiagnostic.mock.calls.map(([record]) =>
      [record.kind, record.cloudOAuthStage, record.cloudOAuthOutcome]
        .filter(Boolean)
        .join(':'),
    ),
    jestWorkerId: process.env.JEST_WORKER_ID ?? null,
  });
}

async function waitForOpenExternal(callIndex = 0): Promise<string> {
  const deadline = Date.now() + OPEN_EXTERNAL_DEADLINE_MS;
  for (;;) {
    const url = mockOpenExternal.mock.calls[callIndex]?.[0];
    if (typeof url === 'string') {
      return url;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Browser open #${String(callIndex + 1)} never happened: ${describeOAuthProgress()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function expectCallbackServerClosed(url: URL): Promise<void> {
  await expect(originalFetch(url)).rejects.toThrow();
}

async function requestCallback(input: {
  url: URL;
  hostHeader: string;
  path?: string;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: '127.0.0.1',
        port: Number(input.url.port),
        path: input.path ?? `${input.url.pathname}${input.url.search}`,
        method: 'GET',
        headers: {
          Host: input.hostHeader,
        },
      },
      (response) => {
        let body = '';
        response.on('data', (chunk: Buffer | string) => {
          body += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        });
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body });
        });
      },
    );
    request.on('error', reject);
    request.end();
  });
}

function expectSingleOAuthFailure(
  outcome: AppDiagnosticRecord['cloudOAuthOutcome'],
  stage?: AppDiagnosticRecord['cloudOAuthStage'],
  expected: Record<string, unknown> = {},
): void {
  const failures = mockRecordAppDiagnostic.mock.calls
    .map(([record]) => record)
    .filter((record) => record.kind === 'cloud_oauth_login_failed');
  expect(failures).toHaveLength(1);
  expect(failures[0]).toMatchObject({
    kind: 'cloud_oauth_login_failed',
    cloudOAuthOutcome: outcome,
    ...(stage ? { cloudOAuthStage: stage } : {}),
    ...expected,
  });
}

describe('Canopy Cloud OAuth login helper', () => {
  it.each(['cancel', 'success'])(
    'settles %s with an unfinished browser request',
    async (outcome) => {
      const login = startCanopyCloudOAuthLogin();
      const result = login.then(
        () => 'success',
        () => 'cancel',
      );
      const authorizeUrl = new URL(await waitForOpenExternal());
      const callback = new URL(
        authorizeUrl.searchParams.get('redirect_uri') ?? '',
      );
      const socket = connect(Number(callback.port), '127.0.0.1');
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      socket.write('GET / HTTP/1.1\r\n');
      await new Promise((resolve) => setTimeout(resolve, 20));
      let timer: NodeJS.Timeout | undefined;
      try {
        if (outcome === 'cancel') {
          cancelCanopyCloudOAuthLogin();
        } else {
          callback.searchParams.set('code', 'auth-code');
          callback.searchParams.set(
            'state',
            authorizeUrl.searchParams.get('state') ?? '',
          );
          expect(await (await originalFetch(callback)).text()).toContain(
            'Desktop connected',
          );
        }
        const deadline = new Promise<string>((resolve) => {
          timer = setTimeout(
            () => resolve('still waiting for browser socket'),
            1000,
          );
        });
        expect(await Promise.race([result, deadline])).toBe(outcome);
      } finally {
        clearTimeout(timer);
        socket.destroy();
        await result;
      }
    },
  );

  it('opens a brand-neutral desktop-connect callback', async () => {
    const login = startCanopyCloudOAuthLogin();
    void login.catch(() => undefined);
    try {
      const authorizeUrl = new URL(await waitForOpenExternal());
      expect(
        new URL(authorizeUrl.searchParams.get('redirect_uri') ?? '').pathname,
      ).toBe('/desktop-connect');
    } finally {
      cancelCanopyCloudOAuthLogin();
      await login.catch(() => undefined);
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockOpenExternal.mockResolvedValue(undefined);
    mockSaveCanopyCloudAccount.mockImplementation(
      (
        entry: SavedAccountEntry,
        withIdentityTransition?: (
          persist: () => Promise<SavedAccountEntry>,
        ) => Promise<SavedAccountEntry>,
      ) =>
        withIdentityTransition
          ? withIdentityTransition(() => {
              mockPersistCanopyCloudAccount(entry);
              return Promise.resolve(entry);
            })
          : Promise.resolve(entry),
    );
    mockLoadCanopyCloudAccount.mockResolvedValue(null);
    mockApplyEnforcedSettings.mockResolvedValue(undefined);
    fetchMock.mockImplementation((input: Parameters<typeof fetch>[0]) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.startsWith('https://cloud.example.test/')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              token: 'csk_oauth',
              userApiKey: {
                id: 'key-1',
                name: 'Canopy Desktop',
                source: 'OAUTH_DESKTOP',
                createdIp: null,
                createdAt: '2026-06-01T19:00:00.000Z',
                lastUsedAt: null,
              },
              account: {
                id: 'user-1',
                name: 'Alice',
                email: 'alice@example.test',
                role: 'DEVELOPER',
              },
              capabilities: [
                'pipelines-crud-v1',
                'account-v1',
                'organizations-v1',
                'teams-v1',
              ],
              organizations: [],
              teams: [],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      return originalFetch(input);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    cancelCanopyCloudOAuthLogin();
    global.fetch = originalFetch;
  });

  it('persists the exchanged OAuth token without exposing it in the callback HTML', async () => {
    const login = startCanopyCloudOAuthLogin();
    const authorizeUrl = new URL(await waitForOpenExternal());
    const redirectUri = authorizeUrl.searchParams.get('redirect_uri');
    const state = authorizeUrl.searchParams.get('state');
    expect(redirectUri).toEqual(expect.any(String));
    expect(state).toEqual(expect.any(String));
    expect(authorizeUrl.searchParams.get('client_device_id')).toBe('device-1');

    const callback = new URL(redirectUri ?? '');
    callback.searchParams.set('code', 'auth-code');
    callback.searchParams.set('state', state ?? '');
    const callbackResponse = await originalFetch(callback);
    const callbackHtml = await callbackResponse.text();
    const result = await login;

    expect(callbackHtml).toContain('Desktop connected');
    expect(callbackHtml).toContain('<strong>Alice</strong>');
    expect(callbackHtml).not.toContain('csk_oauth');
    expect(callbackHtml).not.toContain('auth-code');
    expect(callbackResponse.headers.get('content-type')).toBe(
      'text/html; charset=utf-8',
    );
    expect(callbackResponse.headers.get('cache-control')).toBe('no-store');
    expect(callbackResponse.headers.get('referrer-policy')).toBe('no-referrer');
    expect(mockFocusMainWindow).toHaveBeenCalledTimes(1);
    expect(mockFocusMainWindow).toHaveBeenCalledWith({ steal: true });
    expect(mockSaveCanopyCloudAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'csk_oauth',
        authMode: 'oauth',
        credentialSource: 'oauth_desktop',
        serverApiKeyId: 'key-1',
      }),
      expect.any(Function),
      expect.any(Function),
    );
    const exchangeBody = fetchMock.mock.calls[0][1]?.body;
    if (typeof exchangeBody !== 'string') {
      throw new Error('Expected OAuth token exchange body to be JSON text.');
    }
    expect(JSON.parse(exchangeBody)).toMatchObject({
      clientDeviceId: 'device-1',
      correlationId: createHash('sha256')
        .update(state ?? '')
        .digest('hex')
        .slice(0, 16),
    });
    expect(result.status.authenticated).toBe(true);
    expect(
      mockRecordAppDiagnostic.mock.calls.map(([record]) => [
        record.kind,
        record.cloudOAuthStage,
        record.cloudOAuthOutcome,
      ]),
    ).toEqual([
      ['cloud_oauth_login_stage', 'start', undefined],
      ['cloud_oauth_login_stage', 'browser_opened', undefined],
      ['cloud_oauth_login_stage', 'callback_received', undefined],
      ['cloud_oauth_login_stage', 'success', undefined],
    ]);
    expect(
      mockRecordAppDiagnostic.mock.calls.every(
        ([record]) =>
          record.cloudOAuthPlatform === process.platform &&
          record.cloudOAuthAppVersion === '1.2.3',
      ),
    ).toBe(true);
    const serializedDiagnostics = JSON.stringify(
      mockRecordAppDiagnostic.mock.calls.map(([record]) => record),
    );
    expect(serializedDiagnostics).not.toContain(state);
    expect(serializedDiagnostics).not.toContain('auth-code');
    expect(serializedDiagnostics).not.toContain('csk_oauth');
    expect(serializedDiagnostics).not.toContain('v'.repeat(43));
    await expectCallbackServerClosed(callback);
  });

  it('purges decrypted replicas before replacing a different OAuth identity', async () => {
    mockLoadCanopyCloudAccount.mockResolvedValue({
      apiKey: 'csk_previous',
      account: { id: 'user-previous' },
    });
    const login = startCanopyCloudOAuthLogin();
    const authorizeUrl = new URL(await waitForOpenExternal());
    const callback = new URL(
      authorizeUrl.searchParams.get('redirect_uri') ?? '',
    );
    callback.searchParams.set('code', 'auth-code');
    callback.searchParams.set(
      'state',
      authorizeUrl.searchParams.get('state') ?? '',
    );

    await originalFetch(callback);
    await login;

    expect(mockPurgeSharedContainerReplicas).toHaveBeenCalledTimes(1);
    expect(mockWithSharedContainerReplicaPurgeFence).toHaveBeenCalledTimes(1);
    expect(
      mockPurgeSharedContainerReplicas.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mockPersistCanopyCloudAccount.mock.invocationCallOrder[0] ??
        Number.MAX_SAFE_INTEGER,
    );
  });

  it('reconciles a confirmed organization snapshot before persisting a same-account OAuth refresh', async () => {
    mockSaveCanopyCloudAccount.mockImplementation(
      async (
        entry: SavedAccountEntry,
        _withIdentityTransition: unknown,
        withSameIdentityTransition: unknown,
      ) => {
        expect(withSameIdentityTransition).toEqual(expect.any(Function));
        return (
          withSameIdentityTransition as (
            persist: () => Promise<SavedAccountEntry>,
          ) => Promise<SavedAccountEntry>
        )(() => {
          mockPersistCanopyCloudAccount(entry);
          return Promise.resolve(entry);
        });
      },
    );
    const login = startCanopyCloudOAuthLogin();
    const authorizeUrl = new URL(await waitForOpenExternal());
    const callback = new URL(
      authorizeUrl.searchParams.get('redirect_uri') ?? '',
    );
    callback.searchParams.set('code', 'auth-code');
    callback.searchParams.set(
      'state',
      authorizeUrl.searchParams.get('state') ?? '',
    );

    await originalFetch(callback);
    await login;

    expect(
      mockReconcileSharedContainerOrganizationSnapshot,
    ).toHaveBeenCalledWith([], expect.any(Function));
    expect(
      mockReconcileSharedContainerOrganizationSnapshot.mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      mockPersistCanopyCloudAccount.mock.invocationCallOrder[0] ??
        Number.MAX_SAFE_INTEGER,
    );
    expect(mockWithSharedContainerReplicaPurgeFence).not.toHaveBeenCalled();
  });

  it('records a terminal diagnostic when the browser cannot be opened', async () => {
    mockOpenExternal.mockRejectedValueOnce(new Error('No browser available'));

    const login = startCanopyCloudOAuthLogin();
    const rejectedLogin = expect(login).rejects.toThrow('No browser available');
    const authorizeUrl = new URL(await waitForOpenExternal());
    const callback = new URL(
      authorizeUrl.searchParams.get('redirect_uri') ?? '',
    );

    await rejectedLogin;
    expect(
      mockRecordAppDiagnostic.mock.calls
        .map(([record]) => record)
        .filter((record) => record.kind === 'cloud_oauth_login_failed'),
    ).toEqual([
      expect.objectContaining({
        cloudOAuthStage: 'start',
        cloudOAuthOutcome: 'browser_open_failed',
      }),
    ]);
    await expectCallbackServerClosed(callback);
  });

  it('keeps recording diagnostics when the Electron app version is unavailable', async () => {
    const getVersion = mockElectronApp.getVersion;
    delete mockElectronApp.getVersion;

    try {
      const login = startCanopyCloudOAuthLogin();
      const rejectedLogin = expect(login).rejects.toThrow('cancelled');
      const authorizeUrl = new URL(await waitForOpenExternal());
      const callback = new URL(
        authorizeUrl.searchParams.get('redirect_uri') ?? '',
      );

      expect(mockRecordAppDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'cloud_oauth_login_stage',
          cloudOAuthStage: 'start',
          cloudOAuthAppVersion: null,
        }),
      );

      cancelCanopyCloudOAuthLogin();
      await rejectedLogin;
      await expectCallbackServerClosed(callback);
    } finally {
      mockElectronApp.getVersion = getVersion;
    }
  });

  it('rejects wrong callback state and closes the local server', async () => {
    const login = startCanopyCloudOAuthLogin();
    const rejectedLogin = expect(login).rejects.toThrow('state did not match');
    const authorizeUrl = new URL(await waitForOpenExternal());
    const redirectUri = authorizeUrl.searchParams.get('redirect_uri');
    const callback = new URL(redirectUri ?? '');
    callback.searchParams.set('code', 'auth-code');
    callback.searchParams.set('state', 'wrong-state');

    const callbackResponse = await originalFetch(callback);

    await rejectedLogin;
    const stateMismatchHtml = await callbackResponse.text();
    expect(stateMismatchHtml).toContain('Couldn&#39;t connect');
    expect(stateMismatchHtml).toContain(
      'This sign-in link doesn&#39;t match the request from your desktop app.',
    );
    expect(mockFocusMainWindow).not.toHaveBeenCalled();
    expectSingleOAuthFailure('state_mismatch', 'callback_received');
    await expectCallbackServerClosed(callback);
  });

  it('validates callback state before handling OAuth error callbacks', async () => {
    const login = startCanopyCloudOAuthLogin();
    const rejectedLogin = expect(login).rejects.toThrow('state did not match');
    const authorizeUrl = new URL(await waitForOpenExternal());
    const redirectUri = authorizeUrl.searchParams.get('redirect_uri');
    const callback = new URL(redirectUri ?? '');
    callback.searchParams.set('error', 'access_denied');
    callback.searchParams.set('state', 'wrong-state');

    const callbackResponse = await originalFetch(callback);

    await rejectedLogin;
    await expect(callbackResponse.text()).resolves.toContain(
      'This sign-in link doesn&#39;t match the request from your desktop app.',
    );
    expect(mockFocusMainWindow).not.toHaveBeenCalled();
    expectSingleOAuthFailure('state_mismatch', 'callback_received');
    await expectCallbackServerClosed(callback);
  });

  it('ignores callback requests whose host identity is not 127.0.0.1', async () => {
    const login = startCanopyCloudOAuthLogin();
    const authorizeUrl = new URL(await waitForOpenExternal());
    const redirectUri = authorizeUrl.searchParams.get('redirect_uri');
    const state = authorizeUrl.searchParams.get('state');
    const callback = new URL(redirectUri ?? '');
    callback.searchParams.set('code', 'auth-code');
    callback.searchParams.set('state', state ?? '');

    const localhostHostResponse = await requestCallback({
      url: callback,
      hostHeader: `localhost:${callback.port}`,
    });
    const localhostAbsoluteResponse = await requestCallback({
      url: callback,
      hostHeader: `127.0.0.1:${callback.port}`,
      path: callback.toString().replace('127.0.0.1', 'localhost'),
    });
    const validCallbackResponse = await originalFetch(callback);
    const result = await login;

    expect(localhostHostResponse).toEqual({ status: 404, body: 'Not found' });
    expect(localhostAbsoluteResponse).toEqual({
      status: 404,
      body: 'Not found',
    });
    expect(mockRecordAppDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudOAuthStage: 'callback_rejected',
        kind: 'cloud_oauth_callback_rejected',
        reason: 'invalid_request_identity',
      }),
    );
    expect(
      mockRecordAppDiagnostic.mock.calls
        .map(([record]) => record)
        .filter((record) => record.kind === 'cloud_oauth_callback_rejected'),
    ).toHaveLength(1);
    await expect(validCallbackResponse.text()).resolves.toContain(
      'Desktop connected',
    );
    expect(result.status.authenticated).toBe(true);
    expect(mockFocusMainWindow).toHaveBeenCalledTimes(1);
    await expectCallbackServerClosed(callback);
  });

  it('rejects callbacks missing an authorization code and closes the local server', async () => {
    const login = startCanopyCloudOAuthLogin();
    const rejectedLogin = expect(login).rejects.toThrow('missing code');
    const authorizeUrl = new URL(await waitForOpenExternal());
    const redirectUri = authorizeUrl.searchParams.get('redirect_uri');
    const state = authorizeUrl.searchParams.get('state');
    const callback = new URL(redirectUri ?? '');
    callback.searchParams.set('state', state ?? '');

    const callbackResponse = await originalFetch(callback);

    await rejectedLogin;
    await expect(callbackResponse.text()).resolves.toContain(
      'The sign-in response was incomplete.',
    );
    expect(mockFocusMainWindow).not.toHaveBeenCalled();
    expectSingleOAuthFailure('missing_code', 'callback_received');
    await expectCallbackServerClosed(callback);
  });

  it('does not focus the main window for a provider error callback', async () => {
    const login = startCanopyCloudOAuthLogin();
    const rejectedLogin = expect(login).rejects.toThrow('access_denied');
    const authorizeUrl = new URL(await waitForOpenExternal());
    const callback = new URL(
      authorizeUrl.searchParams.get('redirect_uri') ?? '',
    );
    callback.searchParams.set('error', 'access_denied');
    callback.searchParams.set(
      'state',
      authorizeUrl.searchParams.get('state') ?? '',
    );

    const callbackResponse = await originalFetch(callback);

    await rejectedLogin;
    await expect(callbackResponse.text()).resolves.toContain('access_denied');
    expect(mockFocusMainWindow).not.toHaveBeenCalled();
    expectSingleOAuthFailure('provider_error', 'callback_received', {
      cloudOAuthProviderError: 'access_denied',
    });
    await expectCallbackServerClosed(callback);
  });

  it('does not focus the main window when token exchange fails', async () => {
    fetchMock.mockRejectedValueOnce(new Error('exchange failed'));
    const login = startCanopyCloudOAuthLogin();
    const rejectedLogin = expect(login).rejects.toThrow('exchange failed');
    const authorizeUrl = new URL(await waitForOpenExternal());
    const callback = new URL(
      authorizeUrl.searchParams.get('redirect_uri') ?? '',
    );
    callback.searchParams.set('code', 'auth-code');
    callback.searchParams.set(
      'state',
      authorizeUrl.searchParams.get('state') ?? '',
    );

    const callbackResponse = await originalFetch(callback);

    await rejectedLogin;
    await expect(callbackResponse.text()).resolves.toContain(
      'We couldn&#39;t finish the handshake with',
    );
    expect(mockFocusMainWindow).not.toHaveBeenCalled();
    expectSingleOAuthFailure('exchange_failed', 'exchange', {
      cloudOAuthFailureClass: 'network_error',
      cloudOAuthHttpStatus: null,
    });
    await expectCallbackServerClosed(callback);
  });

  it('records the HTTP status when token exchange returns an error response', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'code already consumed' }), {
        status: 400,
      }),
    );
    const login = startCanopyCloudOAuthLogin();
    const rejectedLogin = expect(login).rejects.toThrow(
      'code already consumed',
    );
    const authorizeUrl = new URL(await waitForOpenExternal());
    const callback = new URL(
      authorizeUrl.searchParams.get('redirect_uri') ?? '',
    );
    callback.searchParams.set('code', 'auth-code');
    callback.searchParams.set(
      'state',
      authorizeUrl.searchParams.get('state') ?? '',
    );

    const callbackResponse = await originalFetch(callback);

    await rejectedLogin;
    await expect(callbackResponse.text()).resolves.toContain(
      'finish the handshake',
    );
    expectSingleOAuthFailure('exchange_failed', 'exchange', {
      cloudOAuthFailureClass: 'http_error',
      cloudOAuthHttpStatus: 400,
    });
    await expectCallbackServerClosed(callback);
  });

  it('preserves the HTTP classification when reading an error body fails', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller): void {
            controller.error(new Error('response stream failed'));
          },
        }),
        { status: 502 },
      ),
    );
    const login = startCanopyCloudOAuthLogin();
    const rejectedLogin = expect(login).rejects.toThrow('502');
    const authorizeUrl = new URL(await waitForOpenExternal());
    const callback = new URL(
      authorizeUrl.searchParams.get('redirect_uri') ?? '',
    );
    callback.searchParams.set('code', 'auth-code');
    callback.searchParams.set(
      'state',
      authorizeUrl.searchParams.get('state') ?? '',
    );

    const callbackResponse = await originalFetch(callback);

    await rejectedLogin;
    await expect(callbackResponse.text()).resolves.toContain(
      'finish the handshake',
    );
    expectSingleOAuthFailure('exchange_failed', 'exchange', {
      cloudOAuthFailureClass: 'http_error',
      cloudOAuthHttpStatus: 502,
    });
    await expectCallbackServerClosed(callback);
  });

  it('shows an error page and does not focus when account persistence fails', async () => {
    // Regression: the success page and the window handoff used to fire as soon
    // as the token exchange returned, while the account was saved later. A
    // storage failure then left the browser claiming "Desktop connected" and
    // the window pulled forward even though the IPC login rejected.
    mockSaveCanopyCloudAccount.mockRejectedValueOnce(
      new Error('secure storage unavailable'),
    );
    const login = startCanopyCloudOAuthLogin();
    const rejectedLogin = expect(login).rejects.toThrow(
      'secure storage unavailable',
    );
    const authorizeUrl = new URL(await waitForOpenExternal());
    const callback = new URL(
      authorizeUrl.searchParams.get('redirect_uri') ?? '',
    );
    callback.searchParams.set('code', 'auth-code');
    callback.searchParams.set(
      'state',
      authorizeUrl.searchParams.get('state') ?? '',
    );

    const callbackResponse = await originalFetch(callback);
    const callbackHtml = await callbackResponse.text();

    await rejectedLogin;
    expect(callbackHtml).toContain('Couldn&#39;t connect');
    expect(callbackHtml).toContain('couldn&#39;t save your account');
    expect(callbackHtml).not.toContain('Desktop connected');
    expect(mockFocusMainWindow).not.toHaveBeenCalled();
    expectSingleOAuthFailure('persist_failed', 'persist');
    await expectCallbackServerClosed(callback);
  });

  it('completes a login that is cancelled after the commit phase begins', async () => {
    // Regression: persistence runs inside the callback handler, and neither the
    // secure-storage write nor the enforced-settings pass is abortable. A
    // cancel landing mid-write used to reject the login while the credential
    // was still saved and org policy applied, so the renderer reported failure
    // for an account that exists on disk (and the window had already been
    // pulled forward). The commit is now the point of no return.
    let releaseSave: (() => void) | undefined;
    const saveStarted = new Promise<void>((resolveStarted) => {
      mockSaveCanopyCloudAccount.mockImplementationOnce(
        (entry: SavedAccountEntry) =>
          new Promise((resolveSave) => {
            resolveStarted();
            releaseSave = (): void => resolveSave(entry);
          }),
      );
    });

    const login = startCanopyCloudOAuthLogin();
    const authorizeUrl = new URL(await waitForOpenExternal());
    const callback = new URL(
      authorizeUrl.searchParams.get('redirect_uri') ?? '',
    );
    callback.searchParams.set('code', 'auth-code');
    callback.searchParams.set(
      'state',
      authorizeUrl.searchParams.get('state') ?? '',
    );

    const callbackPromise = originalFetch(callback);
    await saveStarted;

    // Cancel lands while the account write is in flight.
    cancelCanopyCloudOAuthLogin();
    releaseSave?.();

    const callbackHtml = await (await callbackPromise).text();
    const result = await login;

    expect(result.status.authenticated).toBe(true);
    expect(callbackHtml).toContain('Desktop connected');
    expect(mockSaveCanopyCloudAccount).toHaveBeenCalledTimes(1);
    // The login promise now resolves only after the enforced-settings
    // apply completes, so this needs no polling.
    expect(mockApplyEnforcedSettings).toHaveBeenCalledTimes(1);
    await expectCallbackServerClosed(callback);
  });

  it('does not persist or claim success when cancelled before the commit phase', async () => {
    // Cancelling while the token exchange is still in flight must leave no
    // credential behind and must not apply org-enforced settings.
    let releaseExchange: ((value: Response) => void) | undefined;
    const exchangeStarted = new Promise<void>((resolveStarted) => {
      fetchMock.mockImplementationOnce(() => {
        resolveStarted();
        return new Promise<Response>((resolveExchange) => {
          releaseExchange = resolveExchange;
        });
      });
    });

    const login = startCanopyCloudOAuthLogin();
    const rejectedLogin = expect(login).rejects.toThrow('cancelled');
    const authorizeUrl = new URL(await waitForOpenExternal());
    const callback = new URL(
      authorizeUrl.searchParams.get('redirect_uri') ?? '',
    );
    callback.searchParams.set('code', 'auth-code');
    callback.searchParams.set(
      'state',
      authorizeUrl.searchParams.get('state') ?? '',
    );

    const callbackPromise = originalFetch(callback);
    await exchangeStarted;

    cancelCanopyCloudOAuthLogin();
    releaseExchange?.(
      new Response(
        JSON.stringify({
          token: 'csk_oauth',
          userApiKey: { id: 'key-1' },
          account: {
            id: 'user-1',
            name: 'Alice',
            email: 'alice@example.test',
            role: 'DEVELOPER',
          },
          capabilities: ['account-v1'],
          organizations: [],
          teams: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const callbackHtml = await (await callbackPromise).text();

    await rejectedLogin;
    expect(callbackHtml).toContain('This sign-in was already cancelled.');
    expect(callbackHtml).not.toContain('Desktop connected');
    expect(mockSaveCanopyCloudAccount).not.toHaveBeenCalled();
    expect(mockApplyEnforcedSettings).not.toHaveBeenCalled();
    expect(mockFocusMainWindow).not.toHaveBeenCalled();
  });

  it('ignores a duplicate callback request instead of saving the account twice', async () => {
    // `server.close()` only stops new connections, so a second callback can
    // still arrive. The handler body is not idempotent — without an entry
    // guard it would re-run the exchange and save the account a second time.
    let releaseSave: (() => void) | undefined;
    const saveStarted = new Promise<void>((resolveStarted) => {
      mockSaveCanopyCloudAccount.mockImplementationOnce(
        (entry: SavedAccountEntry) =>
          new Promise((resolveSave) => {
            resolveStarted();
            releaseSave = (): void => resolveSave(entry);
          }),
      );
    });

    const login = startCanopyCloudOAuthLogin();
    const authorizeUrl = new URL(await waitForOpenExternal());
    const callback = new URL(
      authorizeUrl.searchParams.get('redirect_uri') ?? '',
    );
    callback.searchParams.set('code', 'auth-code');
    callback.searchParams.set(
      'state',
      authorizeUrl.searchParams.get('state') ?? '',
    );

    // Hold the first request inside the commit phase so the duplicate arrives
    // while the callback server is still listening.
    const firstResponse = originalFetch(callback);
    await saveStarted;
    const replay = await requestCallback({
      url: callback,
      hostHeader: `127.0.0.1:${callback.port}`,
    });
    releaseSave?.();

    await firstResponse;
    const result = await login;
    expect(result.status.authenticated).toBe(true);
    expect(replay.status).toBe(200);
    expect(replay.body).toContain('Finishing sign-in');
    expect(mockSaveCanopyCloudAccount).toHaveBeenCalledTimes(1);
    // The login promise now resolves only after the enforced-settings
    // apply completes, so this needs no polling.
    expect(mockApplyEnforcedSettings).toHaveBeenCalledTimes(1);
  });

  it('rejects a duplicate callback that arrives during the token exchange', async () => {
    // Regression: the previous guard only checked a flag set *after* the
    // exchange, so two callbacks delivered while the exchange was in flight
    // both got through — double-saving the account, or (with a single-use
    // code) failing an otherwise-valid sign-in when the second exchange 400s.
    let releaseExchange: ((value: Response) => void) | undefined;
    const exchangeStarted = new Promise<void>((resolveStarted) => {
      fetchMock.mockImplementationOnce(() => {
        resolveStarted();
        return new Promise<Response>((resolveExchange) => {
          releaseExchange = resolveExchange;
        });
      });
    });

    const login = startCanopyCloudOAuthLogin();
    const authorizeUrl = new URL(await waitForOpenExternal());
    const callback = new URL(
      authorizeUrl.searchParams.get('redirect_uri') ?? '',
    );
    callback.searchParams.set('code', 'auth-code');
    callback.searchParams.set(
      'state',
      authorizeUrl.searchParams.get('state') ?? '',
    );

    const firstResponse = originalFetch(callback);
    await exchangeStarted;

    // The duplicate lands while the exchange is still open.
    const replay = await requestCallback({
      url: callback,
      hostHeader: `127.0.0.1:${callback.port}`,
    });
    // Branded, not a bare 404: the sign-in is succeeding on the other request.
    expect(replay.status).toBe(200);
    expect(replay.body).toContain('Finishing sign-in');

    releaseExchange?.(
      new Response(
        JSON.stringify({
          token: 'csk_oauth',
          userApiKey: { id: 'key-1' },
          account: {
            id: 'user-1',
            name: 'Alice',
            email: 'alice@example.test',
            role: 'DEVELOPER',
          },
          capabilities: ['account-v1'],
          organizations: [],
          teams: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    await firstResponse;
    const result = await login;
    expect(result.status.authenticated).toBe(true);
    // Exactly one exchange and one commit.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockSaveCanopyCloudAccount).toHaveBeenCalledTimes(1);
    // The login promise now resolves only after the enforced-settings
    // apply completes, so this needs no polling.
    expect(mockApplyEnforcedSettings).toHaveBeenCalledTimes(1);
  });

  it('serializes overlapping commits so two logins cannot interleave writes', async () => {
    // Cancelling a login that is already writing its credential is a no-op, so
    // a replacement can legitimately coexist with a committing login. The
    // commit mutex is what stops their unsynchronized writes from interleaving
    // against the same account file.
    let releaseFirstSave: (() => void) | undefined;
    const firstSaveStarted = new Promise<void>((resolveStarted) => {
      mockSaveCanopyCloudAccount.mockImplementationOnce(
        (entry: SavedAccountEntry) =>
          new Promise((resolveSave) => {
            resolveStarted();
            releaseFirstSave = (): void => resolveSave(entry);
          }),
      );
    });

    try {
      const firstLogin = startCanopyCloudOAuthLogin();
      void firstLogin.catch(() => undefined);
      const firstUrl = new URL(await waitForOpenExternal());
      const firstCallback = new URL(
        firstUrl.searchParams.get('redirect_uri') ?? '',
      );
      firstCallback.searchParams.set('code', 'auth-code');
      firstCallback.searchParams.set(
        'state',
        firstUrl.searchParams.get('state') ?? '',
      );
      const firstResponse = originalFetch(firstCallback);
      await firstSaveStarted;
      expect(mockSaveCanopyCloudAccount).toHaveBeenCalledTimes(1);

      // Second login gets its own loopback server and its own callback.
      const secondLogin = startCanopyCloudOAuthLogin();
      void secondLogin.catch(() => undefined);
      const secondUrl = new URL(await waitForOpenExternal(1));
      const secondCallback = new URL(
        secondUrl.searchParams.get('redirect_uri') ?? '',
      );
      secondCallback.searchParams.set('code', 'auth-code-2');
      secondCallback.searchParams.set(
        'state',
        secondUrl.searchParams.get('state') ?? '',
      );
      const secondResponse = originalFetch(secondCallback);

      // The second login has reached its commit, but the mutex holds its write
      // until the first one finishes.
      for (let i = 0; i < 30; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(mockSaveCanopyCloudAccount).toHaveBeenCalledTimes(1);

      releaseFirstSave?.();
      await firstResponse;
      await secondResponse;
      await firstLogin;
      await secondLogin;

      // Both wrote, but strictly one after the other.
      expect(mockSaveCanopyCloudAccount).toHaveBeenCalledTimes(2);
    } finally {
      releaseFirstSave?.();
    }
  });

  it('serializes policy application in the same order as overlapping commits', async () => {
    let releaseFirstApply: (() => void) | undefined;
    const firstApplyStarted = new Promise<void>((resolveStarted) => {
      mockApplyEnforcedSettings.mockImplementationOnce(
        () =>
          new Promise<void>((resolveApply) => {
            resolveStarted();
            releaseFirstApply = resolveApply;
          }),
      );
    });
    fetchMock
      .mockImplementationOnce(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              token: 'csk_first',
              userApiKey: { id: 'key-first' },
              account: {
                id: 'user-first',
                name: 'First',
                email: 'first@example.test',
                role: 'DEVELOPER',
              },
              capabilities: ['account-v1'],
              organizations: [],
              teams: [],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
      )
      .mockImplementationOnce(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              token: 'csk_second',
              userApiKey: { id: 'key-second' },
              account: {
                id: 'user-second',
                name: 'Second',
                email: 'second@example.test',
                role: 'DEVELOPER',
              },
              capabilities: ['account-v1'],
              organizations: [],
              teams: [],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
      );

    try {
      const firstLogin = startCanopyCloudOAuthLogin();
      const firstUrl = new URL(await waitForOpenExternal());
      const firstCallback = new URL(
        firstUrl.searchParams.get('redirect_uri') ?? '',
      );
      firstCallback.searchParams.set('code', 'auth-code-first');
      firstCallback.searchParams.set(
        'state',
        firstUrl.searchParams.get('state') ?? '',
      );
      await originalFetch(firstCallback);
      await firstApplyStarted;

      const secondLogin = startCanopyCloudOAuthLogin();
      const secondUrl = new URL(await waitForOpenExternal(1));
      const secondCallback = new URL(
        secondUrl.searchParams.get('redirect_uri') ?? '',
      );
      secondCallback.searchParams.set('code', 'auth-code-second');
      secondCallback.searchParams.set(
        'state',
        secondUrl.searchParams.get('state') ?? '',
      );
      await originalFetch(secondCallback);

      for (let i = 0; i < 30; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(mockSaveCanopyCloudAccount).toHaveBeenCalledTimes(2);
      expect(mockApplyEnforcedSettings).toHaveBeenCalledTimes(1);

      releaseFirstApply?.();
      await firstLogin;
      await secondLogin;

      expect(
        mockApplyEnforcedSettings.mock.calls.map(
          ([account]) => account.serverApiKeyId,
        ),
      ).toEqual(['key-first', 'key-second']);
    } finally {
      releaseFirstApply?.();
    }
  });

  it('does not persist a login cancelled while queued behind another commit', async () => {
    // Regression: `committing` used to be set before the mutex was acquired,
    // so a login waiting its turn ignored cancellation and then wrote its
    // credential anyway once the mutex freed up.
    let releaseFirstSave: (() => void) | undefined;
    const firstSaveStarted = new Promise<void>((resolveStarted) => {
      mockSaveCanopyCloudAccount.mockImplementationOnce(
        (entry: SavedAccountEntry) =>
          new Promise((resolveSave) => {
            resolveStarted();
            releaseFirstSave = (): void => resolveSave(entry);
          }),
      );
    });

    try {
      const firstLogin = startCanopyCloudOAuthLogin();
      void firstLogin.catch(() => undefined);
      const firstUrl = new URL(await waitForOpenExternal());
      const firstCallback = new URL(
        firstUrl.searchParams.get('redirect_uri') ?? '',
      );
      firstCallback.searchParams.set('code', 'auth-code');
      firstCallback.searchParams.set(
        'state',
        firstUrl.searchParams.get('state') ?? '',
      );
      const firstResponse = originalFetch(firstCallback);
      await firstSaveStarted;

      const secondLogin = startCanopyCloudOAuthLogin();
      void secondLogin.catch(() => undefined);
      const secondUrl = new URL(await waitForOpenExternal(1));
      const secondCallback = new URL(
        secondUrl.searchParams.get('redirect_uri') ?? '',
      );
      secondCallback.searchParams.set('code', 'auth-code-2');
      secondCallback.searchParams.set(
        'state',
        secondUrl.searchParams.get('state') ?? '',
      );
      const secondResponse = originalFetch(secondCallback);

      // Let the second login reach the mutex and park there.
      for (let i = 0; i < 20; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(mockSaveCanopyCloudAccount).toHaveBeenCalledTimes(1);

      // Cancel while it is queued but has written nothing.
      cancelCanopyCloudOAuthLogin();
      releaseFirstSave?.();

      await firstResponse;
      const secondHtml = await (await secondResponse).text();
      await firstLogin;
      await expect(secondLogin).rejects.toThrow();

      // The queued login honored the cancel instead of persisting.
      expect(mockSaveCanopyCloudAccount).toHaveBeenCalledTimes(1);
      expect(secondHtml).toContain('already cancelled');
    } finally {
      releaseFirstSave?.();
    }
  });

  it('settles a queued login cancelled while the previous write is still hung', async () => {
    // Regression: cancelling a login parked at the commit mutex only marked it
    // settled — its handler stayed blocked on the mutex, so the `finally` that
    // closes its loopback server could not run until the *previous* login's
    // unbounded write finished. A hung `safeStorage`/`writeFile` therefore held
    // the cancelled login's promise, request, and server open indefinitely.
    // The previous coverage masked this by releasing the first save right after
    // cancelling; this test never releases it.
    let releaseFirstSave: (() => void) | undefined;
    const firstSaveStarted = new Promise<void>((resolveStarted) => {
      mockSaveCanopyCloudAccount.mockImplementationOnce(
        (entry: SavedAccountEntry) =>
          new Promise((resolveSave) => {
            resolveStarted();
            releaseFirstSave = (): void => resolveSave(entry);
          }),
      );
    });

    try {
      const firstLogin = startCanopyCloudOAuthLogin();
      void firstLogin.catch(() => undefined);
      const firstUrl = new URL(await waitForOpenExternal());
      const firstCallback = new URL(
        firstUrl.searchParams.get('redirect_uri') ?? '',
      );
      firstCallback.searchParams.set('code', 'auth-code');
      firstCallback.searchParams.set(
        'state',
        firstUrl.searchParams.get('state') ?? '',
      );
      const firstResponse = originalFetch(firstCallback);
      void firstResponse.catch(() => undefined);
      await firstSaveStarted;

      const secondLogin = startCanopyCloudOAuthLogin();
      void secondLogin.catch(() => undefined);
      const secondUrl = new URL(await waitForOpenExternal(1));
      const secondCallback = new URL(
        secondUrl.searchParams.get('redirect_uri') ?? '',
      );
      secondCallback.searchParams.set('code', 'auth-code-2');
      secondCallback.searchParams.set(
        'state',
        secondUrl.searchParams.get('state') ?? '',
      );
      const secondResponse = originalFetch(secondCallback);
      void secondResponse.catch(() => undefined);

      // Let the second login reach the mutex and park there.
      for (let i = 0; i < 20; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(mockSaveCanopyCloudAccount).toHaveBeenCalledTimes(1);

      // Cancel while queued. The first write is still hung and stays hung.
      cancelCanopyCloudOAuthLogin();

      // The cancelled login settles on its own, without the first save ever
      // completing.
      await expect(secondLogin).rejects.toThrow();
      const secondHtml = await (await secondResponse).text();
      expect(secondHtml).toContain('already cancelled');

      // It wrote nothing, and its loopback server is torn down.
      expect(mockSaveCanopyCloudAccount).toHaveBeenCalledTimes(1);
      await expectCallbackServerClosed(secondCallback);

      // Let the first login finish so its server is torn down inside the test
      // rather than after the suite has moved on.
      releaseFirstSave?.();
      await firstResponse;
      await firstLogin;
      await expectCallbackServerClosed(firstCallback);
    } finally {
      releaseFirstSave?.();
    }
  });

  it('records one commit queue timeout when a previous write stays hung', async () => {
    let releaseFirstSave: (() => void) | undefined;
    const firstSaveStarted = new Promise<void>((resolveStarted) => {
      mockSaveCanopyCloudAccount.mockImplementationOnce(
        (entry: SavedAccountEntry) =>
          new Promise((resolveSave) => {
            resolveStarted();
            releaseFirstSave = (): void => resolveSave(entry);
          }),
      );
    });
    const realSetTimeout = global.setTimeout;
    let queueTimeoutSpy: jest.SpyInstance | undefined;

    try {
      const firstLogin = startCanopyCloudOAuthLogin();
      void firstLogin.catch(() => undefined);
      const firstUrl = new URL(await waitForOpenExternal());
      const firstCallback = new URL(
        firstUrl.searchParams.get('redirect_uri') ?? '',
      );
      firstCallback.searchParams.set('code', 'auth-code');
      firstCallback.searchParams.set(
        'state',
        firstUrl.searchParams.get('state') ?? '',
      );
      const firstResponse = originalFetch(firstCallback);
      void firstResponse.catch(() => undefined);
      await firstSaveStarted;

      queueTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((
        callback,
        delay,
      ) => {
        const delayValue = typeof delay === 'number' ? delay : undefined;
        const timeoutDelay = delayValue === 30_000 ? 25 : delayValue;
        return realSetTimeout(
          callback as (...callbackArgs: unknown[]) => void,
          timeoutDelay,
        );
      }) as typeof setTimeout);

      const secondLogin = startCanopyCloudOAuthLogin();
      void secondLogin.catch(() => undefined);
      const secondUrl = new URL(await waitForOpenExternal(1));
      const secondCallback = new URL(
        secondUrl.searchParams.get('redirect_uri') ?? '',
      );
      secondCallback.searchParams.set('code', 'auth-code-2');
      secondCallback.searchParams.set(
        'state',
        secondUrl.searchParams.get('state') ?? '',
      );
      const secondResponse = originalFetch(secondCallback);

      await expect(secondLogin).rejects.toThrow(
        'Timed out waiting for a previous sign-in to finish saving.',
      );
      const secondHtml = await (await secondResponse).text();
      expect(secondHtml).toContain('still finishing a previous sign-in');
      expect(mockSaveCanopyCloudAccount).toHaveBeenCalledTimes(1);
      expectSingleOAuthFailure('commit_queue_timeout', 'persist');
      await expectCallbackServerClosed(secondCallback);

      releaseFirstSave?.();
      await firstResponse;
      await firstLogin;
      await expectCallbackServerClosed(firstCallback);
    } finally {
      queueTimeoutSpy?.mockRestore();
      releaseFirstSave?.();
    }
  });

  it('resolves the login only after org-enforced settings have been applied', async () => {
    // Regression: the apply was fire-and-forget, so it raced
    // `reprobeAndApplyCanopyCloudEnforcedSettings()`, which runs immediately
    // after this promise resolves and applies again. Both pin telemetry scopes
    // and both trigger an entitlements probe, so the fresher server snapshot
    // could lose. The browser response must still not be gated on it.
    let releaseApply: (() => void) | undefined;
    const applyStarted = new Promise<void>((resolveStarted) => {
      mockApplyEnforcedSettings.mockImplementationOnce(
        () =>
          new Promise<void>((resolveApply) => {
            resolveStarted();
            releaseApply = (): void => resolveApply();
          }),
      );
    });

    try {
      const login = startCanopyCloudOAuthLogin();
      void login.catch(() => undefined);
      const authorizeUrl = new URL(await waitForOpenExternal());
      const callback = new URL(
        authorizeUrl.searchParams.get('redirect_uri') ?? '',
      );
      callback.searchParams.set('code', 'auth-code');
      callback.searchParams.set(
        'state',
        authorizeUrl.searchParams.get('state') ?? '',
      );

      const callbackPromise = originalFetch(callback);
      await applyStarted;

      // The browser is answered without waiting for the apply.
      const callbackHtml = await (await callbackPromise).text();
      expect(callbackHtml).toContain('Desktop connected');

      // But the login promise is still pending while the apply runs.
      let settled = false;
      void login.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      for (let i = 0; i < 20; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(settled).toBe(false);

      releaseApply?.();
      const result = await login;
      expect(result.status.authenticated).toBe(true);
      expect(mockApplyEnforcedSettings).toHaveBeenCalledTimes(1);
    } finally {
      releaseApply?.();
    }
  });

  it('serializes two concurrent login starts', async () => {
    // Regression: both callers used to read the same pending login, both wait,
    // and both proceed — leaving one loopback server orphaned for the full
    // login timeout and unreachable by cancelCanopyCloudOAuthLogin().
    const first = startCanopyCloudOAuthLogin();
    const second = startCanopyCloudOAuthLogin();
    void first.catch(() => undefined);
    void second.catch(() => undefined);

    // The first is superseded before it can bind a port, so exactly one
    // browser flow is opened rather than two.
    await expect(first).rejects.toThrow('replaced');
    expectSingleOAuthFailure('replaced');
    const authorizeUrl = new URL(await waitForOpenExternal());
    expect(mockOpenExternal).toHaveBeenCalledTimes(1);

    const callback = new URL(
      authorizeUrl.searchParams.get('redirect_uri') ?? '',
    );
    callback.searchParams.set('code', 'auth-code');
    callback.searchParams.set(
      'state',
      authorizeUrl.searchParams.get('state') ?? '',
    );
    await originalFetch(callback);

    const result = await second;
    expect(result.status.authenticated).toBe(true);
    expect(mockSaveCanopyCloudAccount).toHaveBeenCalledTimes(1);
  });

  it('cancels a login that is still in setup and never opens a browser', async () => {
    // A login in setup is not yet registered as pending, so cancelling has to
    // reach it by generation or it would go on to bind a port and open a
    // browser after the user already backed out.
    const login = startCanopyCloudOAuthLogin();
    void login.catch(() => undefined);
    cancelCanopyCloudOAuthLogin();

    await expect(login).rejects.toThrow('cancelled');
    expect(mockOpenExternal).not.toHaveBeenCalled();
    expect(mockSaveCanopyCloudAccount).not.toHaveBeenCalled();
  });

  it('still completes the sign-in when enforced settings cannot be applied', async () => {
    // `applyEnforcedSettings` swallows every individual applier failure and
    // resolves, so the only way to throw here is the dynamic import failing.
    // The credential is already on disk by then; rejecting would contradict it
    // and rolling back would sign the user out of the session this login just
    // overwrote. The periodic sync re-probes instead.
    mockApplyEnforcedSettings.mockRejectedValueOnce(
      new Error('enforced settings unavailable'),
    );
    const login = startCanopyCloudOAuthLogin();
    const authorizeUrl = new URL(await waitForOpenExternal());
    const callback = new URL(
      authorizeUrl.searchParams.get('redirect_uri') ?? '',
    );
    callback.searchParams.set('code', 'auth-code');
    callback.searchParams.set(
      'state',
      authorizeUrl.searchParams.get('state') ?? '',
    );

    const callbackHtml = await (await originalFetch(callback)).text();

    const result = await login;
    expect(result.status.authenticated).toBe(true);
    expect(mockSaveCanopyCloudAccount).toHaveBeenCalledTimes(1);
    // The credential stays; nothing is rolled back.
    expect(callbackHtml).toContain('Desktop connected');
    expect(mockFocusMainWindow).toHaveBeenCalledTimes(1);
  });

  it('omits the account name from the success copy when it is blank', async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            token: 'csk_oauth',
            userApiKey: { id: 'key-1' },
            account: {
              id: 'user-1',
              name: '   ',
              email: 'alice@example.test',
              role: 'DEVELOPER',
            },
            capabilities: ['account-v1'],
            organizations: [],
            teams: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const login = startCanopyCloudOAuthLogin();
    const authorizeUrl = new URL(await waitForOpenExternal());
    const callback = new URL(
      authorizeUrl.searchParams.get('redirect_uri') ?? '',
    );
    callback.searchParams.set('code', 'auth-code');
    callback.searchParams.set(
      'state',
      authorizeUrl.searchParams.get('state') ?? '',
    );

    const callbackResponse = await originalFetch(callback);
    const callbackHtml = await callbackResponse.text();

    const result = await login;
    expect(result.status.authenticated).toBe(true);
    expect(callbackHtml).toContain('Desktop connected');
    // No dangling "signed in as ." and no empty emphasis.
    expect(callbackHtml).not.toContain('signed in as');
    expect(callbackHtml).not.toContain('<strong></strong>');
    expect(callbackHtml).toContain('You&#39;re signed in.');
    await expectCallbackServerClosed(callback);
  });

  it('completes login when focusing the main window fails', async () => {
    mockFocusMainWindow.mockImplementationOnce(() => {
      throw new Error('focus failed');
    });
    const login = startCanopyCloudOAuthLogin();
    const authorizeUrl = new URL(await waitForOpenExternal());
    const callback = new URL(
      authorizeUrl.searchParams.get('redirect_uri') ?? '',
    );
    callback.searchParams.set('code', 'auth-code');
    callback.searchParams.set(
      'state',
      authorizeUrl.searchParams.get('state') ?? '',
    );

    await originalFetch(callback);

    const result = await login;
    expect(result.status.authenticated).toBe(true);
    expect(mockFocusMainWindow).toHaveBeenCalledTimes(1);
    await expectCallbackServerClosed(callback);
  });

  it('cancels an in-progress login and closes the local server', async () => {
    const login = startCanopyCloudOAuthLogin();
    const rejectedLogin = expect(login).rejects.toThrow('cancelled');
    const authorizeUrl = new URL(await waitForOpenExternal());
    const callback = new URL(
      authorizeUrl.searchParams.get('redirect_uri') ?? '',
    );

    cancelCanopyCloudOAuthLogin();

    await rejectedLogin;
    expectSingleOAuthFailure('cancelled');
    await expectCallbackServerClosed(callback);
  });

  it('times out an in-progress login and closes the local server', async () => {
    const realSetTimeout = global.setTimeout;
    const timeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((
      callback,
      delay,
    ) => {
      const delayValue = typeof delay === 'number' ? delay : undefined;
      const timeoutDelay = delayValue === 10 * 60_000 ? 25 : delayValue;

      return realSetTimeout(
        callback as (...callbackArgs: unknown[]) => void,
        timeoutDelay,
      );
    }) as typeof setTimeout);

    try {
      const login = startCanopyCloudOAuthLogin();
      const rejectedLogin = expect(login).rejects.toThrow('timed out');
      const authorizeUrl = new URL(await waitForOpenExternal());
      const callback = new URL(
        authorizeUrl.searchParams.get('redirect_uri') ?? '',
      );

      await rejectedLogin;
      expectSingleOAuthFailure('timeout');
      await expectCallbackServerClosed(callback);
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});
