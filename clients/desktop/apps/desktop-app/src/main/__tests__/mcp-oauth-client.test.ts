import type { LookupAddress } from 'node:dns';
import { createServer } from 'node:net';
import { get as httpGet } from 'node:http';

const openExternalMock = jest.fn<Promise<void>, [string]>(() =>
  Promise.resolve(),
);
// Not `virtual`: `electron` resolves through moduleNameMapper. A virtual mock
// gets a different module ID, and Jest's worker-shared resolver caches that ID
// for shared importers such as `lib/open-external`. Later suites in the same
// worker then get the shared stub instead of their own `electron` mock.
jest.mock('electron', () => ({
  shell: {
    get openExternal(): typeof openExternalMock {
      return openExternalMock;
    },
  },
}));

const getMcpOAuthTokenMock = jest.fn();
const clearMcpOAuthTokenMock = jest.fn<Promise<void>, [string, string]>(() =>
  Promise.resolve(),
);
type RecordMcpOAuthTokenErrorArgs = [
  string,
  string,
  string,
  { upstreamUrl?: string }?,
  (() => boolean)?,
];
const recordMcpOAuthTokenErrorMock = jest.fn<
  Promise<void>,
  RecordMcpOAuthTokenErrorArgs
>(() => Promise.resolve());
const saveMcpOAuthTokenMock = jest.fn<Promise<void>, [Record<string, unknown>]>(
  () => Promise.resolve(),
);
const saveMcpOAuthTokenIfCurrentMock = jest.fn<
  Promise<boolean>,
  [Record<string, unknown>, Record<string, unknown>?, (() => boolean)?]
>(async (record, _expected, isCurrent) => {
  if (isCurrent && !isCurrent()) return false;
  await saveMcpOAuthTokenMock(record);
  return true;
});
type LookupAllOptions = { all: true; verbatim: true };
const dnsLookupMock = jest.fn<
  Promise<LookupAddress[]>,
  [hostname: string, options: LookupAllOptions]
>(() => Promise.resolve([]));
jest.mock('../mcp/oauth-token-store', () => ({
  get clearMcpOAuthToken(): typeof clearMcpOAuthTokenMock {
    return clearMcpOAuthTokenMock;
  },
  get getMcpOAuthToken(): typeof getMcpOAuthTokenMock {
    return getMcpOAuthTokenMock;
  },
  get recordMcpOAuthTokenError(): typeof recordMcpOAuthTokenErrorMock {
    return recordMcpOAuthTokenErrorMock;
  },
  get saveMcpOAuthToken(): typeof saveMcpOAuthTokenMock {
    return saveMcpOAuthTokenMock;
  },
  get saveMcpOAuthTokenIfCurrent(): typeof saveMcpOAuthTokenIfCurrentMock {
    return saveMcpOAuthTokenIfCurrentMock;
  },
}));
jest.mock('node:dns/promises', () => ({
  get lookup(): typeof dnsLookupMock {
    return dnsLookupMock;
  },
}));
jest.mock('../mcp/pinned-http-fetch', () => ({
  fetchPinnedHttpGetResponse: jest.fn(),
  fetchPinnedHttpResponse: jest.fn(),
}));
const getCanopyCloudBaseUrlMock = jest.fn<string, []>();
jest.mock('../canopy-cloud/config', () => ({
  getCanopyCloudBaseUrl: (): string => getCanopyCloudBaseUrlMock(),
}));

import { DEFAULT_MCP_PROXY_PORT } from '@canopy/desktop-shared/types';
import { MCP_DESKTOP_OAUTH_REDIRECT_URIS } from '@canopy/protocol/mcp-servers';
import type {
  McpServerConfigData,
  McpServerDefinitionData,
} from '@canopy/desktop-shared/types/mcp-servers';
import {
  cancelMcpOAuthFlow,
  getValidMcpAccessToken,
  handleMcpOAuthCallback,
  openExternalUrl,
  setMcpOAuthSettledListener,
  startMcpOAuthFlow,
} from '../mcp/oauth-client';
import { consumeExternalOpenLoopGuard } from '../lib/open-external';
import {
  recordE2eMcpOAuthAuthorizationLaunch,
  resolveE2eMcpOAuthFixtureUrl,
  resolveE2eMcpOAuthPublicAddresses,
} from '../mcp/oauth-e2e-fixture';
import {
  fetchPinnedHttpGetResponse,
  fetchPinnedHttpResponse,
} from '../mcp/pinned-http-fetch';

const fetchMock = jest.fn<
  Promise<Response>,
  [RequestInfo | URL, RequestInit?]
>();
const fetchPinnedHttpGetResponseMock = jest.mocked(fetchPinnedHttpGetResponse);
const fetchPinnedHttpResponseMock = jest.mocked(fetchPinnedHttpResponse);

/** Narrow a fetch target to its href without relying on default stringification. */
function requestUrlHref(target: RequestInfo | URL): string {
  if (target instanceof URL) return target.href;
  if (typeof target === 'string') return target;
  return target.url;
}

/** Narrow a fetch body to text for the form-encoded token requests under test. */
function requestBodyText(body: BodyInit | null | undefined): string {
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  return '';
}

interface SentTokenRequest {
  body: URLSearchParams;
  authorization: string | null;
}

function sentTokenRequest(init: RequestInit | undefined): SentTokenRequest {
  return {
    body: new URLSearchParams(requestBodyText(init?.body)),
    authorization: new Headers(init?.headers).get('authorization'),
  };
}

/** The client secret a token request carried, in its body or its Basic header. */
function sentClientSecret(request: SentTokenRequest): string | null {
  const posted = request.body.get('client_secret');
  if (posted !== null) return posted;
  const basic = /^Basic (.+)$/.exec(request.authorization ?? '');
  if (!basic) return null;
  const credentials = Buffer.from(basic[1], 'base64').toString();
  return new URLSearchParams(
    `secret=${credentials.slice(credentials.indexOf(':') + 1)}`,
  ).get('secret');
}

function jsonResponse(payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function baseDefinition(
  overrides: Partial<McpServerDefinitionData> = {},
): McpServerDefinitionData {
  return {
    id: 'server-1',
    name: 'OAuth Server',
    description: '',
    type: 'http',
    url: 'https://mcp.example.com/mcp',
    oauth: {},
    createdAt: '2026-04-29T00:00:00.000Z',
    updatedAt: '2026-04-29T00:00:00.000Z',
    ...overrides,
  };
}

function baseConfig(
  overrides: Partial<McpServerConfigData> = {},
): McpServerConfigData {
  return {
    id: 'config-1',
    name: 'Default',
    description: '',
    enabled: true,
    envVars: {},
    extraArgs: [],
    extraHeaders: {},
    createdAt: '2026-04-29T00:00:00.000Z',
    updatedAt: '2026-04-29T00:00:00.000Z',
    ...overrides,
  };
}

describe('MCP OAuth E2E fixture gate', () => {
  const envName = 'CANOPY_E2E_MCP_OAUTH_FIXTURE_BASE_URL';
  const originalValue = process.env[envName];

  afterAll(() => {
    if (originalValue === undefined) delete process.env[envName];
    else process.env[envName] = originalValue;
    delete globalThis.__CANOPY_E2E_MCP_OAUTH_AUTHORIZATION_URL__;
  });

  it('ignores the runtime fixture environment in a production build', () => {
    process.env[envName] = 'http://127.0.0.1:4999';

    expect(
      resolveE2eMcpOAuthFixtureUrl(
        new URL('https://calendarmcp.googleapis.com/mcp/v1'),
      ),
    ).toBeNull();
    expect(resolveE2eMcpOAuthPublicAddresses()).toBeNull();
    expect(
      recordE2eMcpOAuthAuthorizationLaunch(
        'https://accounts.google.com/o/oauth2/v2/auth',
      ),
    ).toBe(false);
    expect(
      globalThis.__CANOPY_E2E_MCP_OAUTH_AUTHORIZATION_URL__,
    ).toBeUndefined();
  });
});

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Expected an IPv4 test listener.');
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

describe('mcp oauth client', () => {
  const actualNow = Date.now.bind(Date);
  let elapsed = 0;
  afterEach(() => jest.restoreAllMocks());
  beforeEach(() => {
    elapsed += 31_000;
    jest.spyOn(Date, 'now').mockReturnValue(actualNow() + elapsed);
    jest.clearAllMocks();
    globalThis.fetch = fetchMock;
    getMcpOAuthTokenMock.mockResolvedValue(null);
    clearMcpOAuthTokenMock.mockResolvedValue(undefined);
    recordMcpOAuthTokenErrorMock.mockResolvedValue(undefined);
    saveMcpOAuthTokenMock.mockResolvedValue(undefined);
    saveMcpOAuthTokenIfCurrentMock.mockImplementation(
      async (record, _expected, isCurrent) => {
        if (isCurrent && !isCurrent()) return false;
        await saveMcpOAuthTokenMock(record);
        return true;
      },
    );
    fetchMock.mockReset();
    dnsLookupMock.mockReset();
    dnsLookupMock.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    fetchPinnedHttpGetResponseMock.mockImplementation(
      (url, _addresses, headers, signal) => fetchMock(url, { headers, signal }),
    );
    fetchPinnedHttpResponseMock.mockImplementation(
      (url, _addresses, headers, body, signal) =>
        fetchMock(url, { method: 'POST', headers, body, signal }),
    );
    setMcpOAuthSettledListener(null);
    getCanopyCloudBaseUrlMock.mockReturnValue('https://app.unstoppable.ai');
  });

  it('rolls back its external-open loop guard when the OS open fails', async () => {
    const url = 'https://auth.example.com/retry-after-open-failure';
    openExternalMock.mockRejectedValueOnce(new Error('no browser available'));

    await expect(openExternalUrl(url)).rejects.toThrow('no browser available');
    await expect(consumeExternalOpenLoopGuard(url)).resolves.toBeNull();
  });

  it('discovers OAuth metadata and registers a loopback public client', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('', {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="files:read"',
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          resource: 'https://mcp.example.com/mcp',
          authorization_servers: ['https://auth.example.com'],
          scopes_supported: ['fallback:scope'],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          issuer: 'https://auth.example.com',
          authorization_endpoint: 'https://auth.example.com/authorize',
          code_challenge_methods_supported: ['S256'],
          token_endpoint: 'https://auth.example.com/token',
          registration_endpoint: 'https://auth.example.com/register',
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ client_id: 'dynamic-client' }));

    await expect(
      startMcpOAuthFlow({
        definition: baseDefinition(),
        config: baseConfig(),
        proxyPort: 37645,
      }),
    ).resolves.toMatchObject({ status: 'started' });

    expect(openExternalMock).toHaveBeenCalledTimes(1);
    const openedUrl = new URL(openExternalMock.mock.calls[0][0]);
    expect(openedUrl.origin).toBe('https://auth.example.com');
    expect(openedUrl.searchParams.get('client_id')).toBe('dynamic-client');
    expect(openedUrl.searchParams.get('redirect_uri')).toBe(
      'http://127.0.0.1:37645/oauth/callback',
    );
    expect(openedUrl.searchParams.get('resource')).toBe(
      'https://mcp.example.com/mcp',
    );
    expect(openedUrl.searchParams.get('scope')).toBe('files:read');
    expect(openedUrl.searchParams.get('code_challenge_method')).toBe('S256');
    // The Google-only refresh-token parameters must not leak into every other
    // provider's authorization request.
    expect(openedUrl.searchParams.get('access_type')).toBeNull();
    expect(openedUrl.searchParams.get('prompt')).toBeNull();

    const registrationRequest = fetchMock.mock.calls[3];
    if (!(registrationRequest[0] instanceof URL)) {
      throw new Error('Expected registration request URL object.');
    }
    expect(registrationRequest[0].href).toBe(
      'https://auth.example.com/register',
    );
    expect(registrationRequest[1]?.body).toContain(
      'http://127.0.0.1:37645/oauth/callback',
    );
  });

  it.each([
    ['omits the resource identifier', undefined],
    ['publishes only its origin', 'https://mcp.example.com'],
  ])(
    'keeps discovering when protected-resource metadata %s',
    async (_case, resource): Promise<void> => {
      fetchMock
        .mockResolvedValueOnce(
          new Response('', {
            status: 401,
            headers: {
              'WWW-Authenticate':
                'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="files:read"',
            },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            ...(resource === undefined ? {} : { resource }),
            authorization_servers: ['https://auth.example.com'],
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            issuer: 'https://auth.example.com',
            authorization_endpoint: 'https://auth.example.com/authorize',
            code_challenge_methods_supported: ['S256'],
            token_endpoint: 'https://auth.example.com/token',
            registration_endpoint: 'https://auth.example.com/register',
          }),
        )
        .mockResolvedValueOnce(jsonResponse({ client_id: 'dynamic-client' }));

      await expect(
        startMcpOAuthFlow({
          definition: baseDefinition(),
          config: baseConfig(),
          proxyPort: 37645,
        }),
      ).resolves.toMatchObject({ status: 'started' });
      const openedUrl = new URL(openExternalMock.mock.calls[0][0]);
      expect(openedUrl.searchParams.get('resource')).toBe(
        resource ?? 'https://mcp.example.com/mcp',
      );
    },
  );

  it('rejects protected-resource metadata bound to another origin', async (): Promise<void> => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('', {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="files:read"',
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          resource: 'https://attacker.example/mcp',
          authorization_servers: ['https://auth.example.com'],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          issuer: 'https://auth.example.com',
          authorization_endpoint: 'https://auth.example.com/authorize',
          code_challenge_methods_supported: ['S256'],
          token_endpoint: 'https://auth.example.com/token',
          registration_endpoint: 'https://auth.example.com/register',
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ client_id: 'dynamic-client' }));

    await expect(
      startMcpOAuthFlow({
        definition: baseDefinition(),
        config: baseConfig(),
        proxyPort: 37645,
      }),
    ).rejects.toThrow(
      'Could not discover OAuth authorization and token endpoints',
    );
    expect(openExternalMock).not.toHaveBeenCalled();
  });

  it('returns a validated authorization URL for an embedded login without opening the system browser', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 404 }));

    const result = await startMcpOAuthFlow({
      definition: baseDefinition({
        oauth: {
          clientId: 'manual-client',
          authorizationUrl: 'https://auth.example.com/authorize',
          tokenUrl: 'https://auth.example.com/token',
        },
      }),
      config: baseConfig(),
      proxyPort: 37645,
      // The regression must exercise runtime behavior before the new input
      // field exists, rather than fail TypeScript compilation.
      ...{ browser: 'embedded' as const },
    });

    expect(result.status).toBe('started');
    expect(result.authorizationUrl).toBeDefined();
    const url = new URL(result.authorizationUrl ?? '');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(openExternalMock).not.toHaveBeenCalled();
  });

  it('forces a fresh OAuth login when an existing token is present', async () => {
    getMcpOAuthTokenMock.mockResolvedValue({
      serverId: 'server-1',
      configId: 'config-1',
      accessToken: 'stored-token',
      upstreamUrl: 'https://mcp.example.com/mcp',
      tokenType: 'Bearer',
      updatedAt: '2026-04-29T00:00:00.000Z',
    });
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 404 }));

    await expect(
      startMcpOAuthFlow({
        definition: baseDefinition({
          oauth: {
            clientId: 'manual-client',
            authorizationUrl: 'https://auth.example.com/authorize',
            tokenUrl: 'https://auth.example.com/token',
          },
        }),
        config: baseConfig(),
        proxyPort: 37645,
        force: true,
      }),
    ).resolves.toMatchObject({ status: 'started' });

    expect(clearMcpOAuthTokenMock).toHaveBeenCalledWith('server-1', 'config-1');
    expect(openExternalMock).toHaveBeenCalledTimes(1);
    const openedUrl = new URL(openExternalMock.mock.calls[0][0]);
    expect(openedUrl.searchParams.get('client_id')).toBe('manual-client');
  });

  it('rejects manual OAuth endpoints split across origins', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 404 }));

    await expect(
      startMcpOAuthFlow({
        definition: baseDefinition({
          oauth: {
            clientId: 'manual-client',
            authorizationUrl: 'https://auth.example.com/authorize',
            tokenUrl: 'https://tokens.evil.test/token',
          },
        }),
        config: baseConfig(),
        proxyPort: 37645,
      }),
    ).rejects.toThrow(
      'OAuth authorization and token endpoints must use the same origin.',
    );
    expect(openExternalMock).not.toHaveBeenCalled();
  });

  it('starts a flow when discovered authorization and token endpoints are split across origins', async () => {
    // Reproduces the Google Calendar connector
    // (https://calendarmcp.googleapis.com/mcp/v1). Google's authorization
    // server metadata delegates token issuance to a different origin, which
    // RFC 8414 explicitly permits:
    //   authorization_endpoint: https://accounts.google.com/o/oauth2/v2/auth
    //   token_endpoint:         https://oauth2.googleapis.com/token
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            serverInfo: { name: 'StatelessServer', version: 'ESF' },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          resource: 'https://calendarmcp.googleapis.com/mcp/v1',
          authorization_servers: ['https://accounts.google.com/'],
          scopes_supported: ['https://www.googleapis.com/auth/calendar'],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          issuer: 'https://accounts.google.com',
          authorization_endpoint:
            'https://accounts.google.com/o/oauth2/v2/auth',
          code_challenge_methods_supported: ['S256'],
          token_endpoint: 'https://oauth2.googleapis.com/token',
        }),
      );

    await expect(
      startMcpOAuthFlow({
        definition: baseDefinition({
          name: 'Google Calendar',
          url: 'https://calendarmcp.googleapis.com/mcp/v1',
          // Google does not support RFC 7591 dynamic client registration, so a
          // client ID always has to be supplied explicitly.
          oauth: { clientId: 'manual-google-client' },
          // The marker is deliberately present to prove it is descriptive,
          // not the security boundary for delegated endpoint trust.
          curated: { key: 'google-calendar-calendarmcp' },
        }),
        config: baseConfig(),
        proxyPort: 37645,
        force: true,
      }),
    ).resolves.toMatchObject({ status: 'started' });

    expect(openExternalMock).toHaveBeenCalledTimes(1);
    const openedUrl = new URL(openExternalMock.mock.calls[0][0]);
    expect(openedUrl.origin).toBe('https://accounts.google.com');
    expect(openedUrl.pathname).toBe('/o/oauth2/v2/auth');
  });

  it('trusts the first-party stateless Google Calendar endpoint (ECW-8473)', async () => {
    // The first-party endpoint forwards the caller's Google token upstream and
    // stores nothing, so it declares Google as its authorization server and
    // needs the same accounts.google.com -> oauth2.googleapis.com delegation
    // the Google-hosted connector uses. It advertises the resource metadata
    // through a 401 challenge rather than answering unauthenticated probes.
    fetchMock
      .mockResolvedValueOnce(
        new Response('', {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://code.unstoppabledomains.com/.well-known/oauth-protected-resource/api/mcp/google-calendar"',
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          resource:
            'https://code.unstoppabledomains.com/api/mcp/google-calendar',
          authorization_servers: ['https://accounts.google.com/'],
          scopes_supported: ['https://www.googleapis.com/auth/calendar.events'],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          issuer: 'https://accounts.google.com',
          authorization_endpoint:
            'https://accounts.google.com/o/oauth2/v2/auth',
          code_challenge_methods_supported: ['S256'],
          token_endpoint: 'https://oauth2.googleapis.com/token',
        }),
      );

    await expect(
      startMcpOAuthFlow({
        definition: baseDefinition({
          name: 'Google Calendar',
          url: 'https://code.unstoppabledomains.com/api/mcp/google-calendar',
          oauth: { clientId: 'first-party-google-client' },
        }),
        config: baseConfig(),
        proxyPort: 37645,
        force: true,
      }),
    ).resolves.toMatchObject({ status: 'started' });

    const openedUrl = new URL(openExternalMock.mock.calls[0][0]);
    expect(openedUrl.origin).toBe('https://accounts.google.com');
    // Google issues a refresh token only with access_type=offline AND a
    // fresh consent; without both the connector dies ~1h after login.
    expect(openedUrl.searchParams.get('access_type')).toBe('offline');
    expect(openedUrl.searchParams.get('prompt')).toBe('consent');
  });

  it('rejects an unlisted host claiming the same Google delegation', async () => {
    // The allowlist is the boundary: any origin may *claim* Google endpoints,
    // but only vetted ones may receive a Google-minted code and verifier.
    fetchMock
      .mockResolvedValueOnce(
        new Response('', {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://calendar-mcp.evil.test/.well-known/oauth-protected-resource/mcp"',
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          resource: 'https://calendar-mcp.evil.test/mcp',
          authorization_servers: ['https://accounts.google.com/'],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          issuer: 'https://accounts.google.com',
          authorization_endpoint:
            'https://accounts.google.com/o/oauth2/v2/auth',
          code_challenge_methods_supported: ['S256'],
          token_endpoint: 'https://oauth2.googleapis.com/token',
        }),
      );

    await expect(
      startMcpOAuthFlow({
        definition: baseDefinition({
          name: 'Not Google Calendar',
          url: 'https://calendar-mcp.evil.test/mcp',
          oauth: { clientId: 'attacker-client' },
        }),
        config: baseConfig(),
        proxyPort: 37645,
        force: true,
      }),
    ).rejects.toThrow(/not trusted for this protected resource|same origin/);
    expect(openExternalMock).not.toHaveBeenCalled();
  });

  it('trusts a vetted delegated endpoint pair without a curated marker', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            serverInfo: { name: 'StatelessServer', version: 'ESF' },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          resource: 'https://calendarmcp.googleapis.com/mcp/v1',
          authorization_servers: ['https://accounts.google.com/'],
          scopes_supported: ['https://www.googleapis.com/auth/calendar'],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          issuer: 'https://accounts.google.com',
          authorization_endpoint:
            'https://accounts.google.com/o/oauth2/v2/auth',
          code_challenge_methods_supported: ['S256'],
          token_endpoint: 'https://oauth2.googleapis.com/token',
        }),
      );

    await expect(
      startMcpOAuthFlow({
        definition: baseDefinition({
          name: 'Google Calendar',
          url: 'https://calendarmcp.googleapis.com/mcp/v1',
          oauth: { clientId: 'manual-google-client' },
        }),
        config: baseConfig(),
        proxyPort: 37645,
        force: true,
      }),
    ).resolves.toMatchObject({ status: 'started' });
    expect(openExternalMock).toHaveBeenCalledTimes(1);
  });

  it('trusts authorization and token endpoints split across one site', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            serverInfo: { name: 'Ramp', version: '1.0.0' },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          resource: 'https://ramp-mcp-remote.ramp.com/mcp',
          authorization_servers: ['https://ramp-mcp-remote.ramp.com'],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          issuer: 'https://ramp-mcp-remote.ramp.com',
          authorization_endpoint:
            'https://ramp-mcp-remote.ramp.com/oauth/authorize?auth_level=auto',
          code_challenge_methods_supported: ['S256'],
          token_endpoint: 'https://api.ramp.com/developer/v1/token/pkce',
          registration_endpoint: 'https://ramp-mcp-remote.ramp.com/register',
          token_endpoint_auth_methods_supported: ['none'],
        }),
      );

    await expect(
      startMcpOAuthFlow({
        definition: baseDefinition({
          name: 'Ramp',
          url: 'https://ramp-mcp-remote.ramp.com/mcp',
          oauth: { clientId: 'manual-ramp-client' },
        }),
        config: baseConfig(),
        proxyPort: 37645,
        force: true,
      }),
    ).resolves.toMatchObject({ status: 'started' });
    const openedUrl = new URL(openExternalMock.mock.calls[0][0]);
    expect(openedUrl.origin + openedUrl.pathname).toBe(
      'https://ramp-mcp-remote.ramp.com/oauth/authorize',
    );
    expect(openedUrl.searchParams.get('auth_level')).toBe('auto');
    expect(openedUrl.searchParams.get('client_id')).toBe('manual-ramp-client');
  });

  it('rejects delegated Google endpoints for an untrusted MCP resource', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            serverInfo: { name: 'AttackerServer', version: '1.0.0' },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          resource: 'https://attacker.example/mcp',
          authorization_servers: ['https://accounts.google.com/'],
          scopes_supported: ['https://www.googleapis.com/auth/calendar'],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          issuer: 'https://accounts.google.com',
          authorization_endpoint:
            'https://accounts.google.com/o/oauth2/v2/auth',
          code_challenge_methods_supported: ['S256'],
          token_endpoint: 'https://oauth2.googleapis.com/token',
        }),
      );

    await expect(
      startMcpOAuthFlow({
        definition: baseDefinition({
          name: 'Attacker MCP',
          url: 'https://attacker.example/mcp',
          oauth: { clientId: 'manual-google-client' },
        }),
        config: baseConfig(),
        proxyPort: 37645,
        force: true,
      }),
    ).rejects.toThrow(
      'OAuth delegated endpoints are not trusted for this protected resource.',
    );
    expect(openExternalMock).not.toHaveBeenCalled();
  });

  it('rejects a forged curated marker with a cross-domain token endpoint', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            serverInfo: { name: 'StatelessServer', version: 'ESF' },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          resource: 'https://calendarmcp.googleapis.com/mcp/v1',
          authorization_servers: ['https://accounts.google.com/'],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          issuer: 'https://accounts.google.com',
          authorization_endpoint:
            'https://accounts.google.com/o/oauth2/v2/auth',
          code_challenge_methods_supported: ['S256'],
          token_endpoint: 'https://tokens.evil.test/token',
        }),
      );

    await expect(
      startMcpOAuthFlow({
        definition: baseDefinition({
          name: 'Forged Google Calendar',
          url: 'https://calendarmcp.googleapis.com/mcp/v1',
          oauth: { clientId: 'manual-google-client' },
          curated: { key: 'unknown-forged-entry' },
        }),
        config: baseConfig(),
        proxyPort: 37645,
        force: true,
      }),
    ).rejects.toThrow(
      'Could not discover OAuth authorization and token endpoints.',
    );
    expect(openExternalMock).not.toHaveBeenCalled();
  });

  it('pre-resolves both delegated OAuth endpoints to public addresses', async () => {
    dnsLookupMock.mockImplementation((hostname) => {
      if (hostname === 'oauth2.googleapis.com') {
        return Promise.resolve([{ address: '127.0.0.1', family: 4 }]);
      }
      return Promise.resolve([{ address: '8.8.8.8', family: 4 }]);
    });
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            serverInfo: { name: 'StatelessServer', version: 'ESF' },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          resource: 'https://calendarmcp.googleapis.com/mcp/v1',
          authorization_servers: ['https://accounts.google.com/'],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          issuer: 'https://accounts.google.com',
          authorization_endpoint:
            'https://accounts.google.com/o/oauth2/v2/auth',
          code_challenge_methods_supported: ['S256'],
          token_endpoint: 'https://oauth2.googleapis.com/token',
        }),
      );

    await expect(
      startMcpOAuthFlow({
        definition: baseDefinition({
          url: 'https://calendarmcp.googleapis.com/mcp/v1',
          oauth: { clientId: 'manual-google-client' },
        }),
        config: baseConfig(),
        proxyPort: 37645,
        force: true,
      }),
    ).rejects.toThrow(
      'OAuth token endpoint must resolve only to public network addresses.',
    );
    expect(openExternalMock).not.toHaveBeenCalled();
  });

  it('ignores cross-origin resource metadata URLs from OAuth challenges', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('', {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://metadata.evil.test/.well-known/oauth-protected-resource"',
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          resource: 'https://mcp.example.com/mcp',
          authorization_servers: ['https://auth.example.com'],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          issuer: 'https://auth.example.com',
          authorization_endpoint: 'https://auth.example.com/authorize',
          code_challenge_methods_supported: ['S256'],
          token_endpoint: 'https://auth.example.com/token',
          registration_endpoint: 'https://auth.example.com/register',
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ client_id: 'dynamic-client' }));

    await expect(
      startMcpOAuthFlow({
        definition: baseDefinition(),
        config: baseConfig(),
        proxyPort: 37645,
      }),
    ).resolves.toMatchObject({ status: 'started' });

    const metadataRequest = fetchMock.mock.calls[1][0];
    if (!(metadataRequest instanceof URL)) {
      throw new Error('Expected metadata request URL object.');
    }
    expect(metadataRequest.origin).toBe('https://mcp.example.com');
  });

  it('allows public DNS names that start with IPv6 private prefixes', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('', {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://fc-example.com/.well-known/oauth-protected-resource"',
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          resource: 'https://fc-example.com/mcp',
          authorization_servers: ['https://auth.example.com'],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          issuer: 'https://auth.example.com',
          authorization_endpoint: 'https://auth.example.com/authorize',
          code_challenge_methods_supported: ['S256'],
          token_endpoint: 'https://auth.example.com/token',
          registration_endpoint: 'https://auth.example.com/register',
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ client_id: 'dynamic-client' }));

    await expect(
      startMcpOAuthFlow({
        definition: baseDefinition({ url: 'https://fc-example.com/mcp' }),
        config: baseConfig(),
        proxyPort: 37645,
      }),
    ).resolves.toMatchObject({ status: 'started' });

    expect(openExternalMock).toHaveBeenCalledTimes(1);
  });

  it('rejects IPv6 ULA authorization servers discovered from metadata', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('', {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          resource: 'https://mcp.example.com/mcp',
          authorization_servers: ['https://[fd00::1]'],
        }),
      );

    await expect(
      startMcpOAuthFlow({
        definition: baseDefinition(),
        config: baseConfig(),
        proxyPort: 37645,
      }),
    ).rejects.toThrow(
      'Could not discover OAuth authorization and token endpoints.',
    );
    expect(openExternalMock).not.toHaveBeenCalled();
  });

  it('rejects discovered OAuth endpoints that do not match the issuer origin', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('', {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          resource: 'https://mcp.example.com/mcp',
          authorization_servers: ['https://auth.example.com'],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          issuer: 'https://auth.example.com',
          authorization_endpoint: 'https://auth.example.com/authorize',
          code_challenge_methods_supported: ['S256'],
          token_endpoint: 'https://tokens.evil.test/token',
          registration_endpoint: 'https://auth.example.com/register',
        }),
      );

    await expect(
      startMcpOAuthFlow({
        definition: baseDefinition(),
        config: baseConfig(),
        proxyPort: 37645,
      }),
    ).rejects.toThrow(
      'Could not discover OAuth authorization and token endpoints.',
    );
    expect(openExternalMock).not.toHaveBeenCalled();
  });

  it('discovers Slack endpoints delegated to a different origin', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('', {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://mcp.slack.com/.well-known/oauth-protected-resource"',
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          resource: 'https://mcp.slack.com',
          authorization_servers: ['https://mcp.slack.com'],
          scopes_supported: ['search:read.public', 'chat:write'],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          issuer: 'https://mcp.slack.com',
          authorization_endpoint: 'https://slack.com/oauth/v2_user/authorize',
          code_challenge_methods_supported: ['S256'],
          token_endpoint: 'https://slack.com/api/oauth.v2.user.access',
        }),
      );

    await expect(
      startMcpOAuthFlow({
        definition: baseDefinition({
          url: 'https://mcp.slack.com/mcp',
          oauth: { clientId: 'slack-client' },
        }),
        config: baseConfig(),
        proxyPort: 37645,
      }),
    ).resolves.toMatchObject({ status: 'started' });

    expect(openExternalMock).toHaveBeenCalledTimes(1);
    const openedUrl = new URL(openExternalMock.mock.calls[0][0]);
    expect(openedUrl.href).toContain(
      'https://slack.com/oauth/v2_user/authorize?',
    );
    expect(openedUrl.searchParams.get('client_id')).toBe('slack-client');
    expect(openedUrl.searchParams.get('resource')).toBe(
      'https://mcp.slack.com',
    );
    expect(openedUrl.searchParams.get('scope')).toBe(
      'search:read.public chat:write',
    );
  });

  it('uses the vendor-registered redirect and serves the shared callback page', async () => {
    // A declared `callbackPort` means the client id belongs to the vendor, not
    // to Canopy: Slack ships `1601185624273...` and port 3118 in a public
    // plugin manifest, and its allowlist holds the shape the reference client
    // sends. Canopy's own `/oauth/callback` on 127.0.0.1 is not in that list,
    // which is why Connect failed with `redirect_uri did not match any
    // configured URIs`. Canopy still owns the shape for its own DCR clients —
    // see the proxy-port case below.
    const callbackPort = await getAvailablePort();
    fetchMock
      .mockResolvedValueOnce(
        new Response('', {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://mcp.slack.com/.well-known/oauth-protected-resource"',
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          resource: 'https://mcp.slack.com',
          authorization_servers: ['https://mcp.slack.com'],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          issuer: 'https://mcp.slack.com',
          authorization_endpoint: 'https://slack.com/oauth/v2_user/authorize',
          code_challenge_methods_supported: ['S256'],
          token_endpoint: 'https://slack.com/api/oauth.v2.user.access',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: 'access-token',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      );

    await expect(
      startMcpOAuthFlow({
        definition: baseDefinition({
          url: 'https://mcp.slack.com/mcp',
          oauth: {
            clientId: 'slack-client',
            callbackPort,
            vendorRegisteredRedirect: true,
          },
        }),
        config: baseConfig(),
        proxyPort: 37645,
      }),
    ).resolves.toMatchObject({ status: 'started' });

    const openedUrl = new URL(openExternalMock.mock.calls[0][0]);
    expect(openedUrl.searchParams.get('redirect_uri')).toBe(
      `http://localhost:${String(callbackPort)}/callback`,
    );

    const state = openedUrl.searchParams.get('state');
    const callbackResponse = await new Promise<{
      statusCode: number | undefined;
      headers: Record<string, string | string[] | undefined>;
      body: string;
    }>((resolve, reject) => {
      httpGet(
        `http://127.0.0.1:${String(callbackPort)}/callback?state=${state ?? ''}&code=auth-code`,
        (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            body += chunk;
          });
          response.on('end', () =>
            resolve({
              statusCode: response.statusCode,
              headers: response.headers,
              body,
            }),
          );
        },
      ).on('error', reject);
    });

    expect(callbackResponse.statusCode).toBe(200);
    expect(callbackResponse.headers['content-type']).toBe(
      'text/html; charset=utf-8',
    );
    expect(callbackResponse.headers['cache-control']).toBe('no-store');
    expect(callbackResponse.headers['referrer-policy']).toBe('no-referrer');
    expect(callbackResponse.headers['content-security-policy']).toContain(
      "default-src 'none'",
    );
    expect(callbackResponse.body).toContain('<h1>Connected</h1>');
    expect(callbackResponse.body).toContain(
      'background:var(--bg-accent-subtle)',
    );
    expect(callbackResponse.body).toContain(
      '<p class="detail">OAuth sign-in completed.</p>',
    );
    expect(callbackResponse.body).toContain(
      "history.replaceState({}, '', location.pathname)",
    );
    expect(callbackResponse.body).not.toContain('code=auth-code');
  });

  it('keeps the legacy shape for a port the user configured themselves', async () => {
    // A hand-authored server with a custom `callbackPort` registered Canopy's
    // historic `127.0.0.1/oauth/callback` with its provider, because that is
    // what the Settings help text said. Inferring "vendor" from the presence of
    // a port would silently switch that flow to a URI the provider has never
    // seen and break it on upgrade, with no migration.
    const callbackPort = await getAvailablePort();
    fetchMock
      .mockResolvedValueOnce(
        new Response('', {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://mcp.slack.com/.well-known/oauth-protected-resource"',
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          resource: 'https://mcp.slack.com',
          authorization_servers: ['https://mcp.slack.com'],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          issuer: 'https://mcp.slack.com',
          authorization_endpoint: 'https://slack.com/oauth/v2_user/authorize',
          code_challenge_methods_supported: ['S256'],
          token_endpoint: 'https://slack.com/api/oauth.v2.user.access',
        }),
      );

    await expect(
      startMcpOAuthFlow({
        definition: baseDefinition({
          url: 'https://mcp.slack.com/mcp',
          oauth: { clientId: 'user-client', callbackPort },
        }),
        config: baseConfig(),
        proxyPort: 37645,
      }),
    ).resolves.toMatchObject({ status: 'started' });

    const openedUrl = new URL(openExternalMock.mock.calls[0][0]);
    expect(openedUrl.searchParams.get('redirect_uri')).toBe(
      `http://127.0.0.1:${String(callbackPort)}/oauth/callback`,
    );
  });

  it("keeps Canopy's own redirect shape when it registered the client itself", async () => {
    // No declared port means Canopy's proxy and a client Canopy registered
    // through DCR, so Canopy chose the redirect URI at registration time and
    // must keep sending that one.
    fetchMock
      .mockResolvedValueOnce(
        new Response('', {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://mcp.slack.com/.well-known/oauth-protected-resource"',
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          resource: 'https://mcp.slack.com',
          authorization_servers: ['https://mcp.slack.com'],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          issuer: 'https://mcp.slack.com',
          authorization_endpoint: 'https://slack.com/oauth/v2_user/authorize',
          code_challenge_methods_supported: ['S256'],
          token_endpoint: 'https://slack.com/api/oauth.v2.user.access',
        }),
      );

    await expect(
      startMcpOAuthFlow({
        definition: baseDefinition({
          url: 'https://mcp.slack.com/mcp',
          oauth: { clientId: 'slack-client' },
        }),
        config: baseConfig(),
        proxyPort: 37645,
      }),
    ).resolves.toMatchObject({ status: 'started' });

    const openedUrl = new URL(openExternalMock.mock.calls[0][0]);
    expect(openedUrl.searchParams.get('redirect_uri')).toBe(
      'http://127.0.0.1:37645/oauth/callback',
    );
  });

  it('rejects authorization and token endpoints split across sites', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('', {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://mcp.slack.com/.well-known/oauth-protected-resource"',
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          resource: 'https://mcp.slack.com',
          authorization_servers: ['https://mcp.slack.com'],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          issuer: 'https://mcp.slack.com',
          authorization_endpoint: 'https://slack.com/oauth/v2_user/authorize',
          code_challenge_methods_supported: ['S256'],
          token_endpoint: 'https://slack-tokens.example.net/oauth.access',
        }),
      );

    await expect(
      startMcpOAuthFlow({
        definition: baseDefinition({
          url: 'https://mcp.slack.com/mcp',
          oauth: { clientId: 'slack-client' },
        }),
        config: baseConfig(),
        proxyPort: 37645,
      }),
    ).rejects.toThrow(
      'Could not discover OAuth authorization and token endpoints.',
    );
    expect(openExternalMock).not.toHaveBeenCalled();
  });

  it('rejects private-network endpoints delegated by public metadata', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('', {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          resource: 'https://mcp.example.com/mcp',
          authorization_servers: ['https://auth.example.com'],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          issuer: 'https://auth.example.com',
          authorization_endpoint: 'https://127.0.0.1/authorize',
          code_challenge_methods_supported: ['S256'],
          token_endpoint: 'https://127.0.0.1/token',
        }),
      );

    await expect(
      startMcpOAuthFlow({
        definition: baseDefinition({
          oauth: { clientId: 'manual-client' },
        }),
        config: baseConfig(),
        proxyPort: 37645,
      }),
    ).rejects.toThrow(
      'Could not discover OAuth authorization and token endpoints.',
    );
    expect(openExternalMock).not.toHaveBeenCalled();
  });

  it.each([
    ['unspecified IPv4', 'https://0.0.0.0'],
    ['carrier-grade NAT', 'https://100.64.0.1'],
    ['link-local IPv6', 'https://[fe80::1]'],
  ])(
    'rejects %s endpoints delegated by public metadata',
    async (_addressType, endpointOrigin) => {
      fetchMock
        .mockResolvedValueOnce(
          new Response('', {
            status: 401,
            headers: {
              'WWW-Authenticate':
                'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
            },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            resource: 'https://mcp.example.com/mcp',
            authorization_servers: ['https://auth.example.com'],
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            issuer: 'https://auth.example.com',
            authorization_endpoint: `${endpointOrigin}/authorize`,
            code_challenge_methods_supported: ['S256'],
            token_endpoint: `${endpointOrigin}/token`,
          }),
        );

      await expect(
        startMcpOAuthFlow({
          definition: baseDefinition({
            oauth: { clientId: 'manual-client' },
          }),
          config: baseConfig(),
          proxyPort: 37645,
        }),
      ).rejects.toThrow(
        'Could not discover OAuth authorization and token endpoints.',
      );
      expect(openExternalMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['loopback', 'https://[::ffff:127.0.0.1]'],
    ['private-network', 'https://[::ffff:10.0.0.1]'],
  ])(
    'rejects IPv4-mapped IPv6 %s endpoints delegated by public metadata',
    async (_addressType, endpointOrigin) => {
      fetchMock
        .mockResolvedValueOnce(
          new Response('', {
            status: 401,
            headers: {
              'WWW-Authenticate':
                'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
            },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            resource: 'https://mcp.example.com/mcp',
            authorization_servers: ['https://auth.example.com'],
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            issuer: 'https://auth.example.com',
            authorization_endpoint: `${endpointOrigin}/authorize`,
            code_challenge_methods_supported: ['S256'],
            token_endpoint: `${endpointOrigin}/token`,
          }),
        );

      await expect(
        startMcpOAuthFlow({
          definition: baseDefinition({
            oauth: { clientId: 'manual-client' },
          }),
          config: baseConfig(),
          proxyPort: 37645,
        }),
      ).rejects.toThrow(
        'Could not discover OAuth authorization and token endpoints.',
      );
      expect(openExternalMock).not.toHaveBeenCalled();
    },
  );

  it('rejects single-label endpoints delegated by public metadata', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('', {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://mcp.slack.com/.well-known/oauth-protected-resource"',
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          resource: 'https://mcp.slack.com',
          authorization_servers: ['https://mcp.slack.com'],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          issuer: 'https://mcp.slack.com',
          authorization_endpoint: 'https://intranet/authorize',
          code_challenge_methods_supported: ['S256'],
          token_endpoint: 'https://intranet/token',
        }),
      );

    await expect(
      startMcpOAuthFlow({
        definition: baseDefinition({
          url: 'https://mcp.slack.com/mcp',
          oauth: { clientId: 'slack-client' },
        }),
        config: baseConfig(),
        proxyPort: 37645,
      }),
    ).rejects.toThrow(
      'Could not discover OAuth authorization and token endpoints.',
    );
    expect(openExternalMock).not.toHaveBeenCalled();
  });

  it.each(['https://localhost', 'https://oauth.localhost'])(
    'rejects loopback hostname endpoints delegated by public metadata: %s',
    async (endpointOrigin) => {
      fetchMock
        .mockResolvedValueOnce(
          new Response('', {
            status: 401,
            headers: {
              'WWW-Authenticate':
                'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
            },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            resource: 'https://mcp.example.com/mcp',
            authorization_servers: ['https://auth.example.com'],
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            issuer: 'https://auth.example.com',
            authorization_endpoint: `${endpointOrigin}/authorize`,
            code_challenge_methods_supported: ['S256'],
            token_endpoint: `${endpointOrigin}/token`,
          }),
        );

      await expect(
        startMcpOAuthFlow({
          definition: baseDefinition({
            oauth: { clientId: 'manual-client' },
          }),
          config: baseConfig(),
          proxyPort: 37645,
        }),
      ).rejects.toThrow(
        'Could not discover OAuth authorization and token endpoints.',
      );
      expect(openExternalMock).not.toHaveBeenCalled();
    },
  );

  describe('a loopback MCP server', () => {
    const mcpUrl = 'http://localhost:3701/api/v1/mcp/account';

    function mockLoopbackDiscovery(authorizationServer: string): void {
      fetchMock
        .mockResolvedValueOnce(
          new Response('', {
            status: 401,
            headers: {
              'WWW-Authenticate':
                'Bearer resource_metadata="http://localhost:3701/.well-known/oauth-protected-resource/api/v1/mcp/account"',
            },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            resource: mcpUrl,
            authorization_servers: [authorizationServer],
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            issuer: authorizationServer,
            authorization_endpoint: `${authorizationServer}/authorize`,
            token_endpoint: `${authorizationServer}/token`,
            code_challenge_methods_supported: ['S256'],
          }),
        );
    }

    it('signs in with an authorization server on its own loopback origin', async () => {
      mockLoopbackDiscovery('http://localhost:3701/api/v1/oauth');

      const result = await startMcpOAuthFlow({
        definition: baseDefinition({
          url: mcpUrl,
          oauth: { clientId: 'manual-client' },
        }),
        config: baseConfig(),
        proxyPort: 37645,
      });

      expect(result.status).toBe('started');
      const url = new URL(result.authorizationUrl ?? '');
      expect(`${url.origin}${url.pathname}`).toBe(
        'http://localhost:3701/api/v1/oauth/authorize',
      );
      expect(url.searchParams.get('resource')).toBe(mcpUrl);
      expect(dnsLookupMock).not.toHaveBeenCalled();
    });

    it('rejects an authorization server on another loopback origin', async () => {
      mockLoopbackDiscovery('http://localhost:4999/api/v1/oauth');

      await expect(
        startMcpOAuthFlow({
          definition: baseDefinition({
            url: mcpUrl,
            oauth: { clientId: 'manual-client' },
          }),
          config: baseConfig(),
          proxyPort: 37645,
        }),
      ).rejects.toThrow(
        'Could not discover OAuth authorization and token endpoints.',
      );
      expect(openExternalMock).not.toHaveBeenCalled();
    });
  });

  it('rejects discovered endpoints that resolve to a non-public address', async () => {
    dnsLookupMock
      .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
      .mockResolvedValueOnce([
        { address: '8.8.4.4', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]);
    fetchMock
      .mockResolvedValueOnce(
        new Response('', {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          resource: 'https://mcp.example.com/mcp',
          authorization_servers: ['https://auth.example.com'],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          issuer: 'https://auth.example.com',
          authorization_endpoint: 'https://oauth.example.net/authorize',
          code_challenge_methods_supported: ['S256'],
          token_endpoint: 'https://oauth.example.net/token',
        }),
      );

    await expect(
      startMcpOAuthFlow({
        definition: baseDefinition({ oauth: { clientId: 'manual-client' } }),
        config: baseConfig(),
        proxyPort: 37645,
      }),
    ).rejects.toThrow(
      'OAuth authorization endpoint must resolve only to public network addresses.',
    );
    expect(openExternalMock).not.toHaveBeenCalled();
  });

  it('rejects shared-hosting public suffix issuer endpoints from authorization server metadata', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('', {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://app.herokuapp.com/.well-known/oauth-protected-resource"',
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          resource: 'https://app.herokuapp.com/mcp',
          authorization_servers: ['https://app.herokuapp.com'],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          issuer: 'https://herokuapp.com',
          authorization_endpoint: 'https://herokuapp.com/authorize',
          code_challenge_methods_supported: ['S256'],
          token_endpoint: 'https://herokuapp.com/token',
        }),
      );

    await expect(
      startMcpOAuthFlow({
        definition: baseDefinition({
          url: 'https://app.herokuapp.com/mcp',
          oauth: { clientId: 'manual-client' },
        }),
        config: baseConfig(),
        proxyPort: 37645,
      }),
    ).rejects.toThrow(
      'Could not discover OAuth authorization and token endpoints.',
    );
    expect(openExternalMock).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['insecure', 'http://auth.example.com'],
    ['different origin', 'https://auth.evil.test'],
    ['different path', 'https://auth.example.com/other-tenant'],
    ['query string', 'https://auth.example.com?tenant=other'],
    ['fragment', 'https://auth.example.com#other'],
  ])(
    'rejects %s issuer metadata even when endpoints match the expected issuer origin',
    async (_case, issuer): Promise<void> => {
      fetchMock
        .mockResolvedValueOnce(
          new Response('', {
            status: 401,
            headers: {
              'WWW-Authenticate':
                'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
            },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            resource: 'https://mcp.example.com/mcp',
            authorization_servers: ['https://auth.example.com'],
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            issuer,
            authorization_endpoint: 'https://auth.example.com/authorize',
            code_challenge_methods_supported: ['S256'],
            token_endpoint: 'https://auth.example.com/token',
          }),
        );

      await expect(
        startMcpOAuthFlow({
          definition: baseDefinition({
            oauth: { clientId: 'manual-client' },
          }),
          config: baseConfig(),
          proxyPort: 37645,
        }),
      ).rejects.toThrow(
        'Could not discover OAuth authorization and token endpoints.',
      );
      expect(openExternalMock).not.toHaveBeenCalled();
      expect(fetchPinnedHttpResponseMock).not.toHaveBeenCalled();
    },
  );

  it('rejects unrelated issuer endpoints from authorization server metadata', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('', {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          resource: 'https://mcp.example.com/mcp',
          authorization_servers: ['https://auth.example.com'],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          issuer: 'https://auth.evil.test',
          authorization_endpoint: 'https://auth.evil.test/authorize',
          code_challenge_methods_supported: ['S256'],
          token_endpoint: 'https://auth.evil.test/token',
        }),
      );

    await expect(
      startMcpOAuthFlow({
        definition: baseDefinition({
          oauth: { clientId: 'manual-client' },
        }),
        config: baseConfig(),
        proxyPort: 37645,
      }),
    ).rejects.toThrow(
      'Could not discover OAuth authorization and token endpoints.',
    );
    expect(openExternalMock).not.toHaveBeenCalled();
  });

  it('stores discovered OAuth context after callback token exchange', async () => {
    const settled = jest.fn();
    setMcpOAuthSettledListener(settled);
    const callbackPort = await getAvailablePort();
    fetchMock
      .mockResolvedValueOnce(
        new Response('', {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          resource: 'https://mcp.example.com/mcp',
          authorization_servers: ['https://auth.example.com'],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          issuer: 'https://auth.example.com',
          authorization_endpoint: 'https://auth.example.com/authorize',
          code_challenge_methods_supported: ['S256'],
          token_endpoint: 'https://auth.example.com/token',
          registration_endpoint: 'https://auth.example.com/register',
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ client_id: 'dynamic-client' }))
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      );

    await startMcpOAuthFlow({
      definition: baseDefinition({ oauth: { callbackPort } }),
      config: baseConfig(),
      proxyPort: 37645,
    });

    const openedUrl = new URL(openExternalMock.mock.calls[0][0]);
    const state = openedUrl.searchParams.get('state');
    expect(state).toBeTruthy();
    // Canopy's own shape: the definition declares a port but is not marked
    // vendor-registered, so it is treated as user-configured. This case also
    // registers dynamically, so the server accepts whatever Canopy sends.
    expect(openedUrl.searchParams.get('redirect_uri')).toBe(
      `http://127.0.0.1:${String(callbackPort)}/oauth/callback`,
    );

    const callbackResult = await new Promise<{
      statusCode: number | undefined;
      contentType: string | undefined;
      body: string;
    }>((resolve, reject) => {
      httpGet(
        `http://127.0.0.1:${String(callbackPort)}/oauth/callback?state=${state ?? ''}&code=auth-code`,
        (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            body += chunk;
          });
          response.on('end', () =>
            resolve({
              statusCode: response.statusCode,
              contentType: response.headers['content-type'],
              body,
            }),
          );
        },
      ).on('error', reject);
    });

    expect(callbackResult.statusCode).toBe(200);
    expect(callbackResult.contentType).toBe('text/html; charset=utf-8');
    expect(callbackResult.body).toContain('<h1>Connected</h1>');
    expect(callbackResult.body).toContain(
      '<p class="detail">OAuth sign-in completed.</p>',
    );
    expect(settled).toHaveBeenCalledWith({
      success: true,
      serverId: 'server-1',
      configId: 'config-1',
    });

    expect(saveMcpOAuthTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: 'server-1',
        configId: 'config-1',
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        upstreamUrl: 'https://mcp.example.com/mcp',
        clientId: 'dynamic-client',
        authorizationUrl: 'https://auth.example.com/authorize',
        tokenUrl: 'https://auth.example.com/token',
        tokenUrlRequiresPublicAddress: true,
        resource: 'https://mcp.example.com/mcp',
      }),
    );
    expect(fetchPinnedHttpResponseMock).toHaveBeenCalledTimes(2);
  });

  describe('first-party Google client secret policy', () => {
    const SECRET_ENV = 'CANOPY_GOOGLE_OAUTH_CLIENT_SECRET';
    const originalSecret = process.env[SECRET_ENV];

    afterAll(() => {
      if (originalSecret === undefined) delete process.env[SECRET_ENV];
      else process.env[SECRET_ENV] = originalSecret;
    });

    /** Drive a full Google-shaped flow and return the token-exchange request. */
    async function exchangeFor(
      definition: McpServerDefinitionData,
    ): Promise<SentTokenRequest> {
      const callbackPort = await getAvailablePort();
      const resourceOrigin = new URL(definition.url ?? '').origin;
      fetchMock
        .mockResolvedValueOnce(
          new Response('', {
            status: 401,
            headers: {
              'WWW-Authenticate': `Bearer resource_metadata="${resourceOrigin}/.well-known/oauth-protected-resource"`,
            },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            resource: definition.url,
            authorization_servers: ['https://accounts.google.com/'],
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            issuer: 'https://accounts.google.com',
            authorization_endpoint:
              'https://accounts.google.com/o/oauth2/v2/auth',
            code_challenge_methods_supported: ['S256'],
            token_endpoint: 'https://oauth2.googleapis.com/token',
            token_endpoint_auth_methods_supported: [
              'client_secret_post',
              'client_secret_basic',
            ],
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            access_token: 'access-token',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
        );

      await startMcpOAuthFlow({
        definition: {
          ...definition,
          oauth: { ...definition.oauth, callbackPort },
        },
        config: baseConfig(),
        proxyPort: 37645,
        force: true,
      });

      const openedUrl = new URL(openExternalMock.mock.calls[0][0]);
      const state = openedUrl.searchParams.get('state') ?? '';
      await new Promise<void>((resolve, reject) => {
        httpGet(
          `http://127.0.0.1:${String(callbackPort)}/oauth/callback?state=${state}&code=auth-code`,
          (response) => {
            response.resume();
            response.on('end', () => resolve());
          },
        ).on('error', reject);
      });

      const tokenCall = fetchMock.mock.calls.find(
        (call) =>
          requestUrlHref(call[0]) === 'https://oauth2.googleapis.com/token',
      );
      return sentTokenRequest(tokenCall?.[1]);
    }

    it('supplies the bundled secret for a first-party origin', async () => {
      // Google rejects an installed-app code exchange without a client secret
      // (`client_secret is missing`), and the catalog cannot carry one.
      process.env[SECRET_ENV] = 'GOCSPX-bundled';

      const request = await exchangeFor(
        baseDefinition({
          name: 'Google Calendar',
          url: 'https://code.unstoppabledomains.com/api/mcp/google-calendar',
          oauth: { clientId: 'first-party-google-client' },
        }),
      );

      expect(sentClientSecret(request)).toBe('GOCSPX-bundled');
      // Google lists client_secret_basic, which a secret prefers.
      expect(request.authorization).toMatch(/^Basic /);
      expect(request.body.has('client_secret')).toBe(false);
    });

    it('does not leak the secret to a non-first-party origin', async () => {
      process.env[SECRET_ENV] = 'GOCSPX-bundled';

      const request = await exchangeFor(
        baseDefinition({
          name: 'Google Calendar',
          url: 'https://calendarmcp.googleapis.com/mcp/v1',
          oauth: { clientId: 'some-client' },
        }),
      );

      expect(sentClientSecret(request)).toBeNull();
    });

    it('withholds the secret when the token endpoint is not Google', async () => {
      // Gating on the resource origin alone would let a first-party `url`
      // paired with manual same-origin overrides carry the secret elsewhere.
      process.env[SECRET_ENV] = 'GOCSPX-bundled';

      const callbackPort = await getAvailablePort();
      fetchMock
        .mockResolvedValueOnce(new Response('', { status: 401 }))
        .mockResolvedValueOnce(new Response('', { status: 404 }))
        .mockResolvedValueOnce(new Response('', { status: 404 }))
        .mockResolvedValueOnce(
          jsonResponse({
            access_token: 'access-token',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
        );

      await startMcpOAuthFlow({
        definition: baseDefinition({
          url: 'https://code.unstoppabledomains.com/api/mcp/google-calendar',
          oauth: {
            clientId: 'first-party-google-client',
            // Same-origin manual overrides bypass the delegated-endpoint
            // policy entirely, so the token-origin check is what protects here.
            authorizationUrl: 'https://tokens.evil.test/authorize',
            tokenUrl: 'https://tokens.evil.test/token',
            callbackPort,
          },
        }),
        config: baseConfig(),
        proxyPort: 37645,
        force: true,
      });

      const openedUrl = new URL(openExternalMock.mock.calls[0][0]);
      const state = openedUrl.searchParams.get('state') ?? '';
      await new Promise<void>((resolve, reject) => {
        httpGet(
          `http://127.0.0.1:${String(callbackPort)}/oauth/callback?state=${state}&code=auth-code`,
          (response) => {
            response.resume();
            response.on('end', () => resolve());
          },
        ).on('error', reject);
      });

      const tokenCall = fetchMock.mock.calls.find(
        (call) => requestUrlHref(call[0]) === 'https://tokens.evil.test/token',
      );
      expect(requestBodyText(tokenCall?.[1]?.body)).not.toContain(
        'client_secret',
      );
    });

    it('ignores an all-whitespace configured secret', async () => {
      process.env[SECRET_ENV] = 'GOCSPX-bundled';

      const request = await exchangeFor(
        baseDefinition({
          url: 'https://code.unstoppabledomains.com/api/mcp/google-calendar',
          oauth: {
            clientId: 'first-party-google-client',
            clientSecret: '   ',
          },
        }),
      );

      expect(sentClientSecret(request)).toBe('GOCSPX-bundled');
    });

    it('trusts app.unstoppable.ai, which brand.json also declares', async () => {
      process.env[SECRET_ENV] = 'GOCSPX-bundled';

      const request = await exchangeFor(
        baseDefinition({
          url: 'https://app.unstoppable.ai/api/mcp/google-calendar',
          oauth: { clientId: 'first-party-google-client' },
        }),
      );

      expect(sentClientSecret(request)).toBe('GOCSPX-bundled');
    });

    it('prefers an explicitly configured secret', async () => {
      process.env[SECRET_ENV] = 'GOCSPX-bundled';

      const request = await exchangeFor(
        baseDefinition({
          name: 'Google Calendar',
          url: 'https://code.unstoppabledomains.com/api/mcp/google-calendar',
          oauth: {
            clientId: 'first-party-google-client',
            clientSecret: 'GOCSPX-explicit',
          },
        }),
      );

      expect(sentClientSecret(request)).toBe('GOCSPX-explicit');
    });
  });

  describe('token endpoint client authentication', () => {
    const basicCredentials = `Basic ${Buffer.from('my-client:my-secret').toString('base64')}`;

    /** Signs in with a configured client and returns the token exchange. */
    async function exchangeWith(
      oauth: { clientId: string; clientSecret?: string },
      methods: string[] | undefined,
    ): Promise<SentTokenRequest> {
      const callbackPort = await getAvailablePort();
      fetchMock
        .mockResolvedValueOnce(
          new Response('', {
            status: 401,
            headers: {
              'WWW-Authenticate':
                'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
            },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            resource: 'https://mcp.example.com/mcp',
            authorization_servers: ['https://auth.example.com'],
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            issuer: 'https://auth.example.com',
            authorization_endpoint: 'https://auth.example.com/authorize',
            code_challenge_methods_supported: ['S256'],
            token_endpoint: 'https://auth.example.com/token',
            ...(methods === undefined
              ? {}
              : { token_endpoint_auth_methods_supported: methods }),
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            access_token: 'access-token',
            refresh_token: 'refresh-token',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
        );
      await startMcpOAuthFlow({
        definition: baseDefinition({ oauth: { ...oauth, callbackPort } }),
        config: baseConfig(),
        proxyPort: 37645,
        force: true,
      });
      const state =
        new URL(openExternalMock.mock.calls[0][0]).searchParams.get('state') ??
        '';
      await new Promise<void>((resolve, reject) => {
        httpGet(
          `http://127.0.0.1:${String(callbackPort)}/oauth/callback?state=${state}&code=auth-code`,
          (response) => {
            response.resume();
            response.on('end', () => resolve());
          },
        ).on('error', reject);
      });
      const tokenCall = fetchMock.mock.calls.find(
        (call) => requestUrlHref(call[0]) === 'https://auth.example.com/token',
      );
      return sentTokenRequest(tokenCall?.[1]);
    }

    /** Refreshes a stored token with the configured secret, if any. */
    async function refreshWith(
      clientSecret: string | undefined,
      tokenEndpointAuthMethod: string | undefined,
    ): Promise<SentTokenRequest> {
      getMcpOAuthTokenMock.mockResolvedValue({
        serverId: 'server-1',
        configId: 'config-1',
        accessToken: 'old-token',
        refreshToken: 'refresh-token',
        upstreamUrl: 'https://mcp.example.com/mcp',
        clientId: 'my-client',
        tokenUrl: 'https://auth.example.com/token',
        resource: 'https://mcp.example.com/mcp',
        tokenType: 'Bearer',
        expiresAt: '2000-01-01T00:00:00.000Z',
        updatedAt: '2026-04-29T00:00:00.000Z',
        ...(tokenEndpointAuthMethod ? { tokenEndpointAuthMethod } : {}),
      });
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ access_token: 'new-token', token_type: 'Bearer' }),
      );
      await expect(
        getValidMcpAccessToken(
          baseDefinition({
            oauth: {
              clientId: 'my-client',
              ...(clientSecret ? { clientSecret } : {}),
            },
          }),
          baseConfig(),
        ),
      ).resolves.toBe('new-token');
      return sentTokenRequest(fetchMock.mock.calls[0][1]);
    }

    it.each([
      ['lists no methods', undefined],
      ['lists only client_secret_basic', ['client_secret_basic']],
      [
        'lists both secret methods',
        ['client_secret_post', 'client_secret_basic'],
      ],
    ])(
      'sends a configured secret in an HTTP Basic header when the server %s',
      async (_label, methods): Promise<void> => {
        const request = await exchangeWith(
          { clientId: 'my-client', clientSecret: 'my-secret' },
          methods,
        );
        expect(request.authorization).toBe(basicCredentials);
        expect(request.body.has('client_secret')).toBe(false);
        expect(saveMcpOAuthTokenMock).toHaveBeenCalledWith(
          expect.objectContaining({
            tokenEndpointAuthMethod: 'client_secret_basic',
          }),
        );
      },
    );

    it('posts a configured secret when the server takes only client_secret_post', async () => {
      const request = await exchangeWith(
        { clientId: 'my-client', clientSecret: 'my-secret' },
        ['client_secret_post'],
      );
      expect(request.authorization).toBeNull();
      expect(request.body.get('client_id')).toBe('my-client');
      expect(request.body.get('client_secret')).toBe('my-secret');
      expect(saveMcpOAuthTokenMock).toHaveBeenCalledWith(
        expect.objectContaining({
          tokenEndpointAuthMethod: 'client_secret_post',
        }),
      );
    });

    it('signs in a public client without a secret where the server lists only secret methods', async () => {
      // Slack lists only client_secret_post yet takes its published desktop
      // client as a public PKCE client.
      const request = await exchangeWith({ clientId: 'my-client' }, [
        'client_secret_post',
      ]);
      expect(request.authorization).toBeNull();
      expect(request.body.get('client_id')).toBe('my-client');
      expect(request.body.has('client_secret')).toBe(false);
      expect(saveMcpOAuthTokenMock).toHaveBeenCalledWith(
        expect.objectContaining({ tokenEndpointAuthMethod: 'none' }),
      );
    });

    it('refreshes with the HTTP Basic method the sign-in stored', async () => {
      const request = await refreshWith('my-secret', 'client_secret_basic');
      expect(request.authorization).toBe(basicCredentials);
      expect(request.body.has('client_secret')).toBe(false);
      expect(saveMcpOAuthTokenMock).toHaveBeenCalledWith(
        expect.objectContaining({
          tokenEndpointAuthMethod: 'client_secret_basic',
        }),
      );
    });

    it('keeps posting the secret of a token stored before its method was', async () => {
      const request = await refreshWith('my-secret', undefined);
      expect(request.authorization).toBeNull();
      expect(request.body.get('client_secret')).toBe('my-secret');
    });

    it('refreshes a public client without a secret whatever method was stored', async () => {
      const request = await refreshWith(undefined, 'client_secret_basic');
      expect(request.authorization).toBeNull();
      expect(request.body.get('client_id')).toBe('my-client');
      expect(request.body.has('client_secret')).toBe(false);
    });
  });

  it('does not reuse a terminally rejected refresh token when re-authorization returns none', async () => {
    const callbackPort = await getAvailablePort();
    getMcpOAuthTokenMock.mockResolvedValue({
      serverId: 'server-1',
      configId: 'config-1',
      accessToken: 'old-access',
      refreshToken: 'rejected-or-foreign-refresh-token',
      lastError: 'OAuth token endpoint returned HTTP 400.',
    });
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(
        jsonResponse({
          resource: 'https://mcp.example.com/mcp',
          authorization_servers: ['https://auth.example.com'],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          issuer: 'https://auth.example.com',
          authorization_endpoint: 'https://auth.example.com/authorize',
          code_challenge_methods_supported: ['S256'],
          token_endpoint: 'https://auth.example.com/token',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: 'new-access',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      );

    await startMcpOAuthFlow({
      definition: baseDefinition({
        oauth: { clientId: 'manual-client', callbackPort },
      }),
      config: baseConfig(),
      proxyPort: 37645,
      force: false,
    });

    const openedUrl = new URL(openExternalMock.mock.calls[0][0]);
    const state = openedUrl.searchParams.get('state') ?? '';
    await new Promise<void>((resolve, reject) => {
      httpGet(
        `http://127.0.0.1:${String(callbackPort)}/oauth/callback?state=${state}&code=auth-code`,
        (response) => {
          response.resume();
          response.on('end', () => resolve());
        },
      ).on('error', reject);
    });

    expect(saveMcpOAuthTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: 'new-access',
        refreshToken: undefined,
      }),
    );
  });

  it('replaces an abandoned fixed-port callback listener on retry', async () => {
    const callbackPort = await getAvailablePort();
    fetchMock.mockResolvedValue(new Response('', { status: 401 }));
    const definition = baseDefinition({
      oauth: {
        callbackPort,
        clientId: 'manual-client',
        authorizationUrl: 'https://auth.example.com/authorize',
        tokenUrl: 'https://auth.example.com/token',
      },
    });

    await expect(
      startMcpOAuthFlow({
        definition,
        config: baseConfig(),
        proxyPort: 37645,
      }),
    ).resolves.toMatchObject({ status: 'started' });
    await expect(
      startMcpOAuthFlow({
        definition,
        config: baseConfig(),
        proxyPort: 37645,
      }),
    ).resolves.toMatchObject({ status: 'started' });

    const latestUrl = new URL(openExternalMock.mock.calls[1][0]);
    const latestState = latestUrl.searchParams.get('state');
    expect(latestState).toBeTruthy();
    await expect(
      handleMcpOAuthCallback(
        new URL(
          `http://127.0.0.1:${String(callbackPort)}/oauth/callback?state=${latestState ?? ''}&error=access_denied`,
        ),
      ),
    ).resolves.toMatchObject({ success: false });
  });

  it('rejects a superseded sign-in callback before saving its credentials', async () => {
    fetchMock.mockImplementation((target) =>
      Promise.resolve(
        requestUrlHref(target).endsWith('/token')
          ? jsonResponse({
              access_token: 'abandoned-account',
              token_type: 'Bearer',
            })
          : new Response('', { status: 404 }),
      ),
    );
    const request = {
      definition: baseDefinition({
        oauth: {
          clientId: 'manual-client',
          authorizationUrl: 'https://auth.example.com/authorize',
          tokenUrl: 'https://auth.example.com/token',
        },
      }),
      config: baseConfig(),
      proxyPort: 37645,
      browser: 'embedded' as const,
    };
    const abandoned = await startMcpOAuthFlow(request);
    await startMcpOAuthFlow(request);
    const state = new URL(abandoned.authorizationUrl ?? '').searchParams.get(
      'state',
    );
    const result = await handleMcpOAuthCallback(
      new URL(
        `http://127.0.0.1:37645/oauth/callback?state=${state}&code=abandoned`,
      ),
    );
    expect(result.success).toBe(false);
    expect(saveMcpOAuthTokenMock).not.toHaveBeenCalled();
  });

  it('does not save credentials when a sign-in is canceled during token exchange', async () => {
    let releaseToken: (response: Response) => void = () => undefined;
    let exchangeStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      exchangeStarted = resolve;
    });
    fetchMock.mockImplementation(async (target) => {
      if (!requestUrlHref(target).endsWith('/token'))
        return new Response('', { status: 404 });
      exchangeStarted();
      return new Promise<Response>((resolve) => {
        releaseToken = resolve;
      });
    });
    const result = await startMcpOAuthFlow({
      definition: baseDefinition({
        oauth: {
          clientId: 'manual-client',
          authorizationUrl: 'https://auth.example.com/authorize',
          tokenUrl: 'https://auth.example.com/token',
          usePkce: true,
        },
      }),
      config: baseConfig(),
      proxyPort: 37645,
      browser: 'embedded',
    });
    if (!result.flowId) throw new Error('Missing pending flow');
    const callback = handleMcpOAuthCallback(
      new URL(
        `http://127.0.0.1:37645/oauth/callback?state=${result.flowId}&code=late`,
      ),
    );
    await started;
    await cancelMcpOAuthFlow(result.flowId);
    releaseToken(
      jsonResponse({ access_token: 'late-token', token_type: 'Bearer' }),
    );
    await expect(callback).resolves.toMatchObject({ success: false });
    expect(saveMcpOAuthTokenMock).not.toHaveBeenCalled();
  });

  it('records callback authorization errors for the pending OAuth config', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('', {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          resource: 'https://mcp.example.com/mcp',
          authorization_servers: ['https://auth.example.com'],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          issuer: 'https://auth.example.com',
          authorization_endpoint: 'https://auth.example.com/authorize',
          code_challenge_methods_supported: ['S256'],
          token_endpoint: 'https://auth.example.com/token',
          registration_endpoint: 'https://auth.example.com/register',
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ client_id: 'dynamic-client' }));

    await startMcpOAuthFlow({
      definition: baseDefinition(),
      config: baseConfig(),
      proxyPort: 37645,
    });

    const openedUrl = new URL(openExternalMock.mock.calls[0][0]);
    const state = openedUrl.searchParams.get('state');

    await expect(
      handleMcpOAuthCallback(
        new URL(
          `http://127.0.0.1:37645/oauth/callback?state=${
            state ?? ''
          }&error=access_denied&error_description=Denied`,
        ),
      ),
    ).resolves.toEqual({
      success: false,
      message: 'access_denied: Denied',
    });

    expect(recordMcpOAuthTokenErrorMock).toHaveBeenCalledWith(
      'server-1',
      'config-1',
      'access_denied: Denied',
      {
        upstreamUrl: 'https://mcp.example.com/mcp',
      },
      expect.any(Function),
    );
  });

  it('returns callback authorization errors when error persistence fails', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('', {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          resource: 'https://mcp.example.com/mcp',
          authorization_servers: ['https://auth.example.com'],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          issuer: 'https://auth.example.com',
          authorization_endpoint: 'https://auth.example.com/authorize',
          code_challenge_methods_supported: ['S256'],
          token_endpoint: 'https://auth.example.com/token',
          registration_endpoint: 'https://auth.example.com/register',
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ client_id: 'dynamic-client' }));
    recordMcpOAuthTokenErrorMock.mockRejectedValueOnce(
      new Error('Secure storage unavailable'),
    );

    await startMcpOAuthFlow({
      definition: baseDefinition(),
      config: baseConfig(),
      proxyPort: 37645,
    });

    const openedUrl = new URL(openExternalMock.mock.calls[0][0]);
    const state = openedUrl.searchParams.get('state');

    await expect(
      handleMcpOAuthCallback(
        new URL(
          `http://127.0.0.1:37645/oauth/callback?state=${
            state ?? ''
          }&error=access_denied`,
        ),
      ),
    ).resolves.toEqual({
      success: false,
      message: 'access_denied',
    });
  });

  it('records token exchange failures for the pending OAuth config', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('', {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          resource: 'https://mcp.example.com/mcp',
          authorization_servers: ['https://auth.example.com'],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          issuer: 'https://auth.example.com',
          authorization_endpoint: 'https://auth.example.com/authorize',
          code_challenge_methods_supported: ['S256'],
          token_endpoint: 'https://auth.example.com/token',
          registration_endpoint: 'https://auth.example.com/register',
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ client_id: 'dynamic-client' }))
      .mockResolvedValueOnce(new Response('', { status: 500 }));

    await startMcpOAuthFlow({
      definition: baseDefinition(),
      config: baseConfig(),
      proxyPort: 37645,
    });

    const openedUrl = new URL(openExternalMock.mock.calls[0][0]);
    const state = openedUrl.searchParams.get('state');

    await expect(
      handleMcpOAuthCallback(
        new URL(
          `http://127.0.0.1:37645/oauth/callback?state=${state ?? ''}&code=auth-code`,
        ),
      ),
    ).resolves.toEqual({
      success: false,
      message: 'OAuth token endpoint returned HTTP 500.',
    });

    expect(recordMcpOAuthTokenErrorMock).toHaveBeenCalledWith(
      'server-1',
      'config-1',
      'OAuth token endpoint returned HTTP 500.',
      {
        upstreamUrl: 'https://mcp.example.com/mcp',
      },
      expect.any(Function),
    );
  });

  it('refreshes tokens using stored discovered OAuth context', async () => {
    getMcpOAuthTokenMock.mockResolvedValue({
      serverId: 'server-1',
      configId: 'config-1',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      upstreamUrl: 'https://mcp.example.com/mcp',
      clientId: 'stored-client',
      tokenUrl: 'https://auth.example.com/token',
      resource: 'https://mcp.example.com/mcp',
      tokenType: 'Bearer',
      expiresAt: '2000-01-01T00:00:00.000Z',
      updatedAt: '2026-04-29T00:00:00.000Z',
    });
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        access_token: 'new-token',
        token_type: 'Bearer',
        expires_in: 3600,
      }),
    );

    await expect(
      getValidMcpAccessToken(
        baseDefinition(),
        baseConfig(),
        AbortSignal.timeout(10_000),
      ),
    ).resolves.toBe('new-token');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestBody = fetchMock.mock.calls[0][1]?.body;
    if (
      typeof requestBody !== 'string' &&
      !(requestBody instanceof URLSearchParams)
    ) {
      throw new Error('Expected a form-encoded token refresh body.');
    }
    const body = new URLSearchParams(requestBody);
    expect(body.get('client_id')).toBe('stored-client');
    expect(body.get('resource')).toBe('https://mcp.example.com/mcp');
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    expect(fetchPinnedHttpResponseMock).toHaveBeenCalledTimes(1);
    expect(saveMcpOAuthTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: 'new-token',
        upstreamUrl: 'https://mcp.example.com/mcp',
        clientId: 'stored-client',
        tokenUrl: 'https://auth.example.com/token',
        resource: 'https://mcp.example.com/mcp',
      }),
    );
  });

  it('adopts newer credentials when a refresh loses its conditional-save race', async () => {
    const expiredToken = {
      serverId: 'race-server',
      configId: 'config-1',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      upstreamUrl: 'https://mcp.example.com/mcp',
      clientId: 'stored-client',
      tokenUrl: 'https://auth.example.com/token',
      tokenType: 'Bearer',
      expiresAt: '2000-01-01T00:00:00.000Z',
      updatedAt: '2026-04-29T00:00:00.000Z',
    };
    getMcpOAuthTokenMock
      .mockResolvedValueOnce(expiredToken)
      .mockResolvedValueOnce({
        ...expiredToken,
        accessToken: 'newer-login-token',
        refreshToken: 'newer-login-refresh',
        expiresAt: '2100-01-01T00:00:00.000Z',
        updatedAt: '2026-04-29T00:00:01.000Z',
      });
    saveMcpOAuthTokenIfCurrentMock.mockResolvedValueOnce(false);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        access_token: 'stale-refresh-token',
        token_type: 'Bearer',
      }),
    );

    await expect(
      getValidMcpAccessToken(
        baseDefinition({ id: 'race-server' }),
        baseConfig(),
      ),
    ).resolves.toBe('newer-login-token');
  });

  it('shares one rotating refresh across concurrent callers', async () => {
    getMcpOAuthTokenMock.mockResolvedValue({
      serverId: 'server-1',
      configId: 'config-1',
      accessToken: 'old-token',
      refreshToken: 'single-use-refresh',
      upstreamUrl: 'https://mcp.example.com/mcp',
      clientId: 'client',
      tokenUrl: 'https://auth.example.com/token',
      expiresAt: '2000-01-01T00:00:00.000Z',
      updatedAt: '2026-04-29T00:00:00.000Z',
    });
    fetchMock.mockImplementation(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return jsonResponse({
        access_token: 'new-token',
        refresh_token: 'rotated-refresh',
        token_type: 'Bearer',
      });
    });
    expect(
      await Promise.all(
        Array.from({ length: 5 }, (_value, index) =>
          getValidMcpAccessToken(
            baseDefinition({ oauth: index % 2 ? {} : { usePkce: true } }),
            baseConfig(),
          ),
        ),
      ),
    ).toEqual(Array.from({ length: 5 }, () => 'new-token'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(saveMcpOAuthTokenMock).toHaveBeenCalledTimes(1);
    expect(saveMcpOAuthTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({ refreshToken: 'rotated-refresh' }),
    );
  });

  it.each([429, 500, 503])(
    'does not permanently invalidate a refresh on HTTP %s',
    async (status) => {
      getMcpOAuthTokenMock.mockResolvedValue({
        serverId: 'server-1',
        configId: 'config-1',
        accessToken: 'old-token',
        refreshToken: 'refresh-token',
        upstreamUrl: 'https://mcp.example.com/mcp',
        clientId: 'client',
        tokenUrl: 'https://auth.example.com/token',
        expiresAt: '2000-01-01T00:00:00.000Z',
        updatedAt: '2026-04-29T00:00:00.000Z',
      });
      fetchMock.mockResolvedValueOnce(new Response('', { status }));
      await expect(
        getValidMcpAccessToken(baseDefinition(), baseConfig()),
      ).rejects.toThrow('temporarily unavailable');
      expect(recordMcpOAuthTokenErrorMock).not.toHaveBeenCalled();
    },
  );

  it('retries a temporary failure after backoff without another login', async () => {
    getMcpOAuthTokenMock.mockResolvedValue({
      serverId: 'server-1',
      configId: 'config-1',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      upstreamUrl: 'https://mcp.example.com/mcp',
      clientId: 'client',
      tokenUrl: 'https://auth.example.com/token',
      expiresAt: '2000-01-01T00:00:00.000Z',
      updatedAt: 'temporary-test',
    });
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'recovered', token_type: 'Bearer' }),
      );
    await expect(
      getValidMcpAccessToken(baseDefinition(), baseConfig()),
    ).rejects.toThrow('temporarily unavailable');
    await expect(
      getValidMcpAccessToken(baseDefinition(), baseConfig()),
    ).rejects.toThrow('temporarily unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
    await expect(
      getValidMcpAccessToken(baseDefinition(), baseConfig()),
    ).resolves.toBe('recovered');
    expect(recordMcpOAuthTokenErrorMock).not.toHaveBeenCalled();
  });

  it('opens interactive authorization when renewal is temporarily unavailable', async () => {
    getMcpOAuthTokenMock.mockResolvedValue({
      serverId: 'server-1',
      configId: 'config-1',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      upstreamUrl: 'https://mcp.example.com/mcp',
      clientId: 'client',
      tokenUrl: 'https://auth.example.com/token',
      expiresAt: '2000-01-01T00:00:00.000Z',
      updatedAt: 'interactive-after-transient',
    });
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const input = {
      definition: baseDefinition({
        oauth: {
          clientId: 'client',
          authorizationUrl: 'https://auth.example.com/authorize',
          tokenUrl: 'https://auth.example.com/token',
        },
      }),
      config: baseConfig(),
      proxyPort: 37645,
    };

    await expect(startMcpOAuthFlow(input)).resolves.toMatchObject({
      status: 'started',
    });
    await expect(startMcpOAuthFlow(input)).resolves.toMatchObject({
      status: 'started',
    });
    expect(
      fetchMock.mock.calls.filter(
        ([target]) =>
          requestUrlHref(target) === 'https://auth.example.com/token',
      ),
    ).toHaveLength(1);
    expect(openExternalMock).toHaveBeenCalledTimes(2);
  });

  it('requires reauthorization for a rejected refresh grant', async () => {
    getMcpOAuthTokenMock.mockResolvedValue({
      serverId: 'server-1',
      configId: 'config-1',
      accessToken: 'old-token',
      refreshToken: 'revoked-refresh',
      upstreamUrl: 'https://mcp.example.com/mcp',
      clientId: 'client',
      tokenUrl: 'https://auth.example.com/token',
      expiresAt: '2000-01-01T00:00:00.000Z',
      updatedAt: 'invalid-grant-test',
    });
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: 'invalid_grant',
          error_description: 'sensitive text must not be retained',
        }),
        { status: 400 },
      ),
    );
    await expect(
      getValidMcpAccessToken(baseDefinition(), baseConfig()),
    ).resolves.toBeNull();
    expect(recordMcpOAuthTokenErrorMock).toHaveBeenCalledWith(
      'server-1',
      'config-1',
      'OAuth token endpoint returned HTTP 400.',
      { upstreamUrl: 'https://mcp.example.com/mcp', accessToken: 'old-token' },
    );
  });

  it('adopts a newer login when a bound refresh error loses its update race', async () => {
    const expiredToken = {
      serverId: 'error-race-server',
      configId: 'config-1',
      accessToken: 'old-token',
      refreshToken: 'revoked-refresh',
      upstreamUrl: 'https://mcp.example.com/mcp',
      clientId: 'client',
      tokenUrl: 'https://auth.example.com/token',
      tokenType: 'Bearer',
      expiresAt: '2000-01-01T00:00:00.000Z',
      updatedAt: 'error-race-old',
    };
    getMcpOAuthTokenMock
      .mockResolvedValueOnce(expiredToken)
      .mockResolvedValueOnce({
        ...expiredToken,
        accessToken: 'newer-login-token',
        refreshToken: 'newer-login-refresh',
        expiresAt: '2100-01-01T00:00:00.000Z',
        updatedAt: 'error-race-new',
      });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    );

    await expect(
      getValidMcpAccessToken(
        baseDefinition({ id: 'error-race-server' }),
        baseConfig(),
      ),
    ).resolves.toBe('newer-login-token');
  });

  it('keeps a shared refresh alive when one caller cancels', async () => {
    getMcpOAuthTokenMock.mockResolvedValue({
      serverId: 'server-1',
      configId: 'config-1',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      upstreamUrl: 'https://mcp.example.com/mcp',
      clientId: 'client',
      tokenUrl: 'https://auth.example.com/token',
      expiresAt: '2000-01-01T00:00:00.000Z',
      updatedAt: 'cancellation-test',
    });
    fetchMock.mockImplementation(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return jsonResponse({
        access_token: 'shared-new-token',
        token_type: 'Bearer',
      });
    });
    const controller = new AbortController();
    const cancelled = getValidMcpAccessToken(
      baseDefinition(),
      baseConfig(),
      controller.signal,
    );
    const surviving = getValidMcpAccessToken(baseDefinition(), baseConfig());
    const rejection = expect(cancelled).rejects.toMatchObject({
      name: 'AbortError',
    });
    controller.abort();
    await rejection;
    await expect(surviving).resolves.toBe('shared-new-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('propagates cancellation instead of swallowing a timed-out refresh', async () => {
    getMcpOAuthTokenMock.mockResolvedValue({
      serverId: 'server-1',
      configId: 'config-1',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      upstreamUrl: 'https://mcp.example.com/mcp',
      clientId: 'stored-client',
      tokenUrl: 'https://auth.example.com/token',
      tokenType: 'Bearer',
      expiresAt: '2000-01-01T00:00:00.000Z',
      updatedAt: '2026-04-29T00:00:00.000Z',
    });
    const controller = new AbortController();
    const timeoutError = new DOMException('Request timed out', 'AbortError');
    controller.abort(timeoutError);
    fetchMock.mockRejectedValueOnce(timeoutError);

    await expect(
      getValidMcpAccessToken(baseDefinition(), baseConfig(), controller.signal),
    ).rejects.toBe(timeoutError);
    expect(recordMcpOAuthTokenErrorMock).not.toHaveBeenCalled();
  });

  it('preserves explicit manual token endpoints during refresh', async () => {
    getMcpOAuthTokenMock.mockResolvedValue({
      serverId: 'server-1',
      configId: 'config-1',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      upstreamUrl: 'https://mcp.example.com/mcp',
      clientId: 'stored-client',
      tokenUrl: 'http://127.0.0.1/token',
      tokenType: 'Bearer',
      expiresAt: '2000-01-01T00:00:00.000Z',
      updatedAt: '2026-04-29T00:00:00.000Z',
    });
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access_token: 'new-token', token_type: 'Bearer' }),
    );

    await expect(
      getValidMcpAccessToken(
        baseDefinition({
          oauth: {
            clientId: 'stored-client',
            tokenUrl: 'http://127.0.0.1/token',
          },
        }),
        baseConfig(),
      ),
    ).resolves.toBe('new-token');

    expect(fetchPinnedHttpResponseMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('clears stored tokens whose upstream binding no longer matches', async () => {
    getMcpOAuthTokenMock.mockResolvedValue({
      serverId: 'server-1',
      configId: 'config-1',
      accessToken: 'old-token',
      upstreamUrl: 'https://mcp.example.com/old',
      tokenType: 'Bearer',
      updatedAt: '2026-04-29T00:00:00.000Z',
    });

    await expect(
      getValidMcpAccessToken(baseDefinition(), baseConfig()),
    ).resolves.toBeNull();

    expect(clearMcpOAuthTokenMock).toHaveBeenCalledWith('server-1', 'config-1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses merged config headers during standalone OAuth discovery', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('', {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          resource: 'https://mcp.example.com/mcp',
          authorization_servers: ['https://auth.example.com'],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          issuer: 'https://auth.example.com',
          authorization_endpoint: 'https://auth.example.com/authorize',
          code_challenge_methods_supported: ['S256'],
          token_endpoint: 'https://auth.example.com/token',
          registration_endpoint: 'https://auth.example.com/register',
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ client_id: 'dynamic-client' }));

    await startMcpOAuthFlow({
      definition: baseDefinition({
        headers: { 'X-Definition': 'definition' },
      }),
      config: baseConfig({
        extraHeaders: { 'X-Config': 'config' },
      }),
      proxyPort: 37645,
    });

    const headers = fetchMock.mock.calls[0][1]?.headers;
    if (!headers || Array.isArray(headers) || headers instanceof Headers) {
      throw new Error('Expected OAuth discovery headers to be a plain object.');
    }

    expect(Object.entries(headers)).toEqual(
      expect.arrayContaining([
        ['X-Definition', 'definition'],
        ['X-Config', 'config'],
      ]),
    );
  });

  it('does not return access tokens from records with a stored auth error', async () => {
    getMcpOAuthTokenMock.mockResolvedValue({
      serverId: 'server-1',
      configId: 'config-1',
      accessToken: 'old-token',
      upstreamUrl: 'https://mcp.example.com/mcp',
      tokenType: 'Bearer',
      lastError: 'OAuth login failed.',
      updatedAt: '2026-04-29T00:00:00.000Z',
    });

    await expect(
      getValidMcpAccessToken(baseDefinition(), baseConfig()),
    ).resolves.toBeNull();
  });
  /** A server that takes metadata document clients and registers others. */
  function serveAuthorizationServer(
    metadata: Record<string, unknown> = {},
  ): void {
    fetchMock.mockImplementation((target) => {
      const url = requestUrlHref(target);
      if (url === 'https://mcp.example.com/mcp')
        return Promise.resolve(
          new Response('', {
            status: 401,
            headers: {
              'WWW-Authenticate':
                'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
            },
          }),
        );
      if (
        url === 'https://mcp.example.com/.well-known/oauth-protected-resource'
      )
        return Promise.resolve(
          jsonResponse({
            resource: 'https://mcp.example.com/mcp',
            authorization_servers: ['https://auth.example.com'],
          }),
        );
      if (
        url ===
        'https://auth.example.com/.well-known/oauth-authorization-server'
      )
        return Promise.resolve(
          jsonResponse({
            issuer: 'https://auth.example.com',
            authorization_endpoint: 'https://auth.example.com/authorize',
            code_challenge_methods_supported: ['S256'],
            token_endpoint: 'https://auth.example.com/token',
            registration_endpoint: 'https://auth.example.com/register',
            token_endpoint_auth_methods_supported: ['none'],
            authorization_response_iss_parameter_supported: true,
            client_id_metadata_document_supported: true,
            ...metadata,
          }),
        );
      if (url === 'https://auth.example.com/register')
        return Promise.resolve(jsonResponse({ client_id: 'dynamic-client' }));
      if (url === 'https://auth.example.com/token')
        return Promise.resolve(
          jsonResponse({
            access_token: 'access-token',
            refresh_token: 'refresh-token',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
        );
      return Promise.resolve(new Response('', { status: 404 }));
    });
  }

  function registered(): boolean {
    return fetchMock.mock.calls.some(
      (call) => requestUrlHref(call[0]) === 'https://auth.example.com/register',
    );
  }

  /** Starts a sign-in and returns the authorization request it opened. */
  async function signIn(
    definition = baseDefinition(),
    proxyPort = 37645,
  ): Promise<URLSearchParams> {
    await startMcpOAuthFlow({
      definition,
      config: baseConfig(),
      proxyPort,
      force: true,
    });
    return new URL(openExternalMock.mock.calls[0][0]).searchParams;
  }

  describe('Client ID Metadata Document clients', () => {
    const documentUrl =
      'https://app.unstoppable.ai/api/mcp-connections/client-metadata/canopy/desktop';
    const proxyRedirectUri = 'http://127.0.0.1:37645/oauth/callback';

    function callbackUrl(params: URLSearchParams, extra: string): URL {
      return new URL(
        `${proxyRedirectUri}?state=${params.get('state') ?? ''}&code=auth-code${extra}`,
      );
    }

    function tokenRequested(): boolean {
      return fetchMock.mock.calls.some(
        (call) => requestUrlHref(call[0]) === 'https://auth.example.com/token',
      );
    }

    it('lists the proxy callback on its default port', () => {
      expect(MCP_DESKTOP_OAUTH_REDIRECT_URIS).toContain(
        `http://127.0.0.1:${String(DEFAULT_MCP_PROXY_PORT)}/oauth/callback`,
      );
    });

    it('signs in with the desktop document instead of registering a client', async () => {
      serveAuthorizationServer();
      const params = await signIn();
      expect(params.get('client_id')).toBe(documentUrl);
      expect(params.get('redirect_uri')).toBe(proxyRedirectUri);
      expect(registered()).toBe(false);

      await expect(
        handleMcpOAuthCallback(
          callbackUrl(params, '&iss=https%3A%2F%2Fauth.example.com'),
        ),
      ).resolves.toMatchObject({ success: true });
      const tokenCall = fetchMock.mock.calls.find(
        (call) => requestUrlHref(call[0]) === 'https://auth.example.com/token',
      );
      const sent = sentTokenRequest(tokenCall?.[1]);
      expect(sent.body.get('client_id')).toBe(documentUrl);
      expect(sentClientSecret(sent)).toBeNull();
      // Refresh reads the client back from the stored token.
      expect(saveMcpOAuthTokenMock).toHaveBeenCalledWith(
        expect.objectContaining({
          clientId: documentUrl,
          tokenEndpointAuthMethod: 'none',
        }),
      );
    });

    it('refreshes with the document client it signed in with', async () => {
      serveAuthorizationServer();
      getMcpOAuthTokenMock.mockResolvedValue({
        serverId: 'server-1',
        configId: 'config-1',
        accessToken: 'old-token',
        refreshToken: 'refresh-token',
        upstreamUrl: 'https://mcp.example.com/mcp',
        clientId: documentUrl,
        tokenUrl: 'https://auth.example.com/token',
        tokenEndpointAuthMethod: 'none',
        resource: 'https://mcp.example.com/mcp',
        tokenType: 'Bearer',
        expiresAt: '2000-01-01T00:00:00.000Z',
        updatedAt: '2026-04-29T00:00:00.000Z',
      });
      await expect(
        getValidMcpAccessToken(baseDefinition(), baseConfig()),
      ).resolves.toBe('access-token');
      const tokenCall = fetchMock.mock.calls.find(
        (call) => requestUrlHref(call[0]) === 'https://auth.example.com/token',
      );
      const sent = sentTokenRequest(tokenCall?.[1]);
      expect(sent.body.get('grant_type')).toBe('refresh_token');
      expect(sent.body.get('client_id')).toBe(documentUrl);
      expect(sentClientSecret(sent)).toBeNull();
    });

    it('registers a client with a server that advertises documents but sends no iss (Canva)', async () => {
      serveAuthorizationServer({
        authorization_response_iss_parameter_supported: false,
      });
      expect((await signIn()).get('client_id')).toBe('dynamic-client');
    });

    // A malicious server relays our authorization request (same client ID,
    // callback, state and challenge) to an honest server; the honest code
    // comes back on our callback, matched to the malicious flow by state.
    it.each([
      ['carries no iss', ''],
      ['names another server', '&iss=https%3A%2F%2Fhonest.example.com'],
    ])(
      'never exchanges a document client’s code whose response %s',
      async (_label, extra) => {
        serveAuthorizationServer();
        const params = await signIn();
        expect(params.get('client_id')).toBe(documentUrl);
        await expect(
          handleMcpOAuthCallback(callbackUrl(params, extra)),
        ).resolves.toEqual({
          success: false,
          message: 'Sign-in came back from a different service. Connect again.',
        });
        expect(tokenRequested()).toBe(false);
        expect(saveMcpOAuthTokenMock).not.toHaveBeenCalled();
      },
    );

    it('requires iss from a server that promises it, for a registered client too', async () => {
      serveAuthorizationServer({
        client_id_metadata_document_supported: false,
      });
      const params = await signIn();
      expect(params.get('client_id')).toBe('dynamic-client');
      await expect(
        handleMcpOAuthCallback(callbackUrl(params, '')),
      ).resolves.toMatchObject({ success: false });
      expect(tokenRequested()).toBe(false);
    });

    it.each([
      ['takes a response without iss', '', true],
      [
        'refuses one naming another server',
        '&iss=https%3A%2F%2Fhonest.example.com',
        false,
      ],
    ])('from a server without RFC 9207, %s', async (_label, extra, success) => {
      serveAuthorizationServer({
        authorization_response_iss_parameter_supported: false,
        client_id_metadata_document_supported: false,
      });
      const params = await signIn();
      await expect(
        handleMcpOAuthCallback(callbackUrl(params, extra)),
      ).resolves.toMatchObject({ success });
      expect(tokenRequested()).toBe(success);
    });

    it('registers a client with a server that does not advertise documents', async () => {
      serveAuthorizationServer({
        client_id_metadata_document_supported: false,
      });
      expect((await signIn()).get('client_id')).toBe('dynamic-client');
    });

    it('registers a client when the proxy listens on a port the document does not list', async () => {
      serveAuthorizationServer();
      const params = await signIn(baseDefinition(), 40123);
      expect(params.get('client_id')).toBe('dynamic-client');
      expect(params.get('redirect_uri')).toBe(
        'http://127.0.0.1:40123/oauth/callback',
      );
    });

    it.each([
      [
        'no cloud',
        (): string => {
          throw new Error('not configured');
        },
      ],
      ['a local cloud', (): string => 'http://localhost:3000'],
    ])(
      'registers a client with %s to publish the document',
      async (_label, cloudBaseUrl) => {
        getCanopyCloudBaseUrlMock.mockImplementation(cloudBaseUrl);
        serveAuthorizationServer();
        expect((await signIn()).get('client_id')).toBe('dynamic-client');
      },
    );

    it('signs in with a configured client before the document', async () => {
      serveAuthorizationServer();
      const params = await signIn(
        baseDefinition({ oauth: { clientId: 'manual-client' } }),
      );
      expect(params.get('client_id')).toBe('manual-client');
      expect(registered()).toBe(false);
    });
  });

  describe('PKCE support', () => {
    it.each<[string, Record<string, unknown>]>([
      [
        'omits its PKCE methods',
        { code_challenge_methods_supported: undefined },
      ],
      [
        'takes only plain PKCE',
        { code_challenge_methods_supported: ['plain'] },
      ],
    ])(
      'refuses a server whose metadata %s before opening the browser',
      async (_label, metadata) => {
        serveAuthorizationServer({
          client_id_metadata_document_supported: false,
          ...metadata,
        });
        await expect(
          startMcpOAuthFlow({
            definition: baseDefinition(),
            config: baseConfig(),
            proxyPort: 37645,
            force: true,
          }),
        ).rejects.toThrow('PKCE');
        expect(openExternalMock).not.toHaveBeenCalled();
        expect(registered()).toBe(false);
      },
    );

    it('signs in with manual endpoints, which have no metadata to check', async () => {
      fetchMock.mockResolvedValue(new Response('', { status: 404 }));
      await expect(
        startMcpOAuthFlow({
          definition: baseDefinition({
            oauth: {
              clientId: 'manual-client',
              authorizationUrl: 'https://auth.example.com/authorize',
              tokenUrl: 'https://auth.example.com/token',
            },
          }),
          config: baseConfig(),
          proxyPort: 37645,
          force: true,
        }),
      ).resolves.toMatchObject({ status: 'started' });
    });
  });
});
