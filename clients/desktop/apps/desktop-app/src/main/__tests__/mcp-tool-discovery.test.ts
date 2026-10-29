jest.mock('../canopy-cloud/mcp-connections', (): object => ({
  resolveAccountMcpProxyTarget: jest.fn(),
  findAccountMcpConnection: jest.fn(),
}));
import {
  resolveAccountMcpProxyTarget,
  findAccountMcpConnection,
  type AccountMcpConnection,
} from '../canopy-cloud/mcp-connections';
const mockAccountProxy = {
  ensureStarted: jest.fn(),
  registerRoute: jest.fn(),
  unregisterRoute: jest.fn(),
  getProxyUrl: jest.fn(),
};
jest.mock('../mcp/http-proxy-service', (): object => ({
  getMcpHttpProxyService: (): typeof mockAccountProxy => mockAccountProxy,
}));
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  McpServerConfigData,
  McpServerDefinitionData,
} from '@canopy/desktop-shared/types/mcp-servers';

let mockRoot = '';
const mockReadPreferences = jest.fn();
const mockGetValidMcpAccessToken = jest.fn();
const mockDnsLookup = jest.fn();
const mockPinnedHttpFetch = jest.fn(
  (
    url: URL,
    _addresses: unknown,
    headers: Record<string, string>,
    body: string,
    signal: AbortSignal,
  ): Promise<Response> =>
    global.fetch(url.pathname === '/' ? url.origin : url.toString(), {
      method: 'POST',
      headers,
      body,
      signal,
      redirect: 'manual',
    }),
);

jest.mock('node:dns/promises', () => ({
  lookup: mockDnsLookup,
}));
jest.mock('../mcp/pinned-http-fetch', () => ({
  fetchPinnedHttpResponse: mockPinnedHttpFetch,
}));

jest.mock('../lib/paths', () => ({
  getMcpServerFilePath: (id: string): string =>
    join(mockRoot, `server-${id}.json`),
  getMcpServersIndexFilePath: (): string => join(mockRoot, 'index.json'),
  getMcpServerToolsCacheFilePath: (): string =>
    join(mockRoot, 'tools-cache.json'),
}));
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: mockReadPreferences,
}));
jest.mock('../mcp/oauth-client', () => ({
  getValidMcpAccessToken: mockGetValidMcpAccessToken,
}));
jest.mock('../mcp/oauth-token-store', () => ({
  getMcpOAuthAuthStatusForDefinition: jest.fn(),
  getMcpOAuthTokenRevision: jest.fn(() => Promise.resolve('missing')),
}));

import {
  discoverAndCacheMcpTools,
  discoverHttpTools,
  getMcpToolsCacheEntry,
  MCP_DISCOVERY_MAX_RESPONSE_BYTES,
  MCP_DISCOVERY_MAX_TOOL_PAGES,
  MCP_DISCOVERY_MAX_TOOL_NAME_BYTES,
  mcpToolsSourceFingerprint,
  refreshStaleMcpTools,
  writeMcpToolsCacheEntry,
} from '../mcp/tool-discovery';
import {
  clearMcpServerAuthHealthCache,
  clearMcpServerHealthCache,
  getMcpServerHealth,
} from '../mcp/connection-status';

function fetchResponses(): jest.MockedFunction<typeof fetch> {
  const fetchMock: jest.MockedFunction<typeof fetch> = jest.fn();
  fetchMock
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { protocolVersion: '2025-06-18' },
        }),
        {
          status: 200,
          headers: { 'mcp-session-id': 'session-1' },
        },
      ),
    )
    .mockResolvedValueOnce(new Response(null, { status: 202 }))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          result: { tools: [{ name: 'search' }, { name: 'read' }] },
        }),
        { status: 200 },
      ),
    );
  global.fetch = fetchMock;
  return fetchMock;
}

async function writeServer(
  handler: 'canopy' | 'provider' | 'account',
  oauth = true,
  url = 'https://mcp.example.test',
  authToken?: string,
): Promise<void> {
  await writeFile(
    join(mockRoot, 'server-server-1.json'),
    JSON.stringify({
      version: 1,
      server: {
        definition: {
          id: 'server-1',
          name: 'Server',
          description: '',
          type: 'http',
          url,
          ...(oauth ? { oauth: { usePkce: true } } : {}),
          httpAuthHandler: handler,
          createdAt: '2026-07-14T00:00:00.000Z',
          updatedAt: '2026-07-14T00:00:00.000Z',
        },
        configs: [
          {
            id: 'config-1',
            name: 'Default',
            description: '',
            enabled: true,
            envVars: {},
            extraArgs: [],
            extraHeaders: { 'X-Config': 'yes' },
            ...(authToken ? { authToken } : {}),
            createdAt: '2026-07-14T00:00:00.000Z',
            updatedAt: '2026-07-14T00:00:00.000Z',
          },
        ],
      },
    }),
    'utf8',
  );
}

describe('MCP tool discovery/cache', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    jest.mocked(findAccountMcpConnection).mockResolvedValue(undefined);
    mockRoot = await mkdtemp(join(tmpdir(), 'mcp-tools-'));
    await mkdir(mockRoot, { recursive: true });
    mockReadPreferences.mockResolvedValue({
      mcpProxyPort: 37645,
      mcpHttpAuthDefaultHandler: 'canopy',
    });
    mockGetValidMcpAccessToken.mockResolvedValue(null);
    mockDnsLookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    clearMcpServerHealthCache();
  });

  afterEach(async () => {
    await rm(mockRoot, { recursive: true, force: true });
  });

  it('discovers account tools through a temporary loopback route without local credentials', async (): Promise<void> => {
    await writeServer(
      'account',
      true,
      'https://mcp.example.test',
      'ignored-token',
    );
    jest.mocked(resolveAccountMcpProxyTarget).mockResolvedValue({
      upstreamUrl: 'https://cloud.example.test/api/v1/mcp-proxy/r',
      connection: {
        id: 'a',
        serverKey: 'github',
        configId: 'default',
        displayName: 'GitHub',
        kind: 'CURATED',
        status: 'CONNECTED',
        routeId: 'r',
        enabledTools: null,
      },
    });
    mockAccountProxy.ensureStarted.mockResolvedValue(undefined);
    mockAccountProxy.registerRoute.mockResolvedValue('local-route');
    mockAccountProxy.getProxyUrl.mockReturnValue(
      'http://127.0.0.1:37645/local-route',
    );
    mockDnsLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const requests = fetchResponses();
    expect(
      (await discoverAndCacheMcpTools('server-1', 'config-1')).tools,
    ).toEqual(['search', 'read']);
    expect(mockAccountProxy.registerRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        authSupplier: 'canopy-cloud',
        oauthEnabled: false,
        headers: {},
      }),
    );
    expect(requests.mock.calls[0]?.[0]).toBe(
      'http://127.0.0.1:37645/local-route',
    );
    expect(mockGetValidMcpAccessToken).not.toHaveBeenCalled();
    expect(mockAccountProxy.unregisterRoute).toHaveBeenCalledWith(
      'local-route',
    );
  });

  it('round-trips entries by the server/config composite key', async () => {
    await writeMcpToolsCacheEntry('server-a', 'config-a', {
      tools: ['one'],
      discoveredAt: '2026-07-14T00:00:00.000Z',
    });
    await writeMcpToolsCacheEntry('server-a', 'config-b', {
      tools: ['two'],
      discoveredAt: '2026-07-14T01:00:00.000Z',
    });
    await expect(
      getMcpToolsCacheEntry('server-a', 'config-a'),
    ).resolves.toEqual({
      tools: ['one'],
      discoveredAt: '2026-07-14T00:00:00.000Z',
    });
    await expect(
      getMcpToolsCacheEntry('server-a', 'missing'),
    ).resolves.toBeNull();
  });

  it.each(['binding', 'route', 'policy'] as const)(
    'refreshes a fresh account tool cache after changing its %s',
    async (change): Promise<void> => {
      await writeServer('account');
      let connection: AccountMcpConnection = {
        id: 'account-a',
        serverKey: 'custom',
        configId: 'config-1',
        displayName: 'Account',
        kind: 'CUSTOM' as const,
        status: 'CONNECTED' as const,
        routeId: 'route-a',
        enabledTools: null,
      };
      const writeIndex = async (): Promise<void> => {
        await writeFile(
          join(mockRoot, 'index.json'),
          JSON.stringify({
            version: 1,
            servers: [
              {
                id: 'server-1',
                name: 'Server',
                description: '',
                type: 'http',
                configs: [{ id: 'config-1', name: 'Default', enabled: true }],
                updatedAt: '2026-07-14T00:00:00.000Z',
                accountConnectionId: connection.id,
              },
            ],
          }),
        );
      };
      await writeIndex();
      jest
        .mocked(findAccountMcpConnection)
        .mockImplementation(
          (): Promise<AccountMcpConnection> => Promise.resolve(connection),
        );
      jest.mocked(resolveAccountMcpProxyTarget).mockImplementation(
        (): Promise<{
          connection: AccountMcpConnection;
          upstreamUrl: string;
        }> =>
          Promise.resolve({
            connection,
            upstreamUrl: `https://cloud.example.test/api/v1/mcp-proxy/${connection.routeId}`,
          }),
      );
      mockAccountProxy.registerRoute.mockResolvedValue('local-route');
      mockAccountProxy.getProxyUrl.mockReturnValue(
        'http://127.0.0.1:37645/local-route',
      );
      mockDnsLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
      fetchResponses();
      const now = new Date();
      const before = await discoverAndCacheMcpTools(
        'server-1',
        'config-1',
        now,
      );
      const unchanged = fetchResponses();
      await refreshStaleMcpTools(now);
      expect(unchanged).not.toHaveBeenCalled();
      connection = {
        ...connection,
        ...(change === 'binding'
          ? { id: 'account-b' }
          : change === 'route'
            ? { routeId: 'route-b' }
            : { enabledTools: ['read'] }),
      };
      await writeIndex();
      const requests = fetchResponses();
      await refreshStaleMcpTools(now);
      expect(requests).toHaveBeenCalledTimes(3);
      expect(
        (await getMcpToolsCacheEntry('server-1', 'config-1'))
          ?.sourceFingerprint,
      ).not.toBe(before.sourceFingerprint);
    },
  );

  it('treats entries from a different server configuration as stale', async () => {
    await writeMcpToolsCacheEntry('server-a', 'config-a', {
      tools: ['one'],
      discoveredAt: '2026-07-14T00:00:00.000Z',
      sourceFingerprint: 'old-fingerprint',
    });

    await expect(
      getMcpToolsCacheEntry('server-a', 'config-a', 'new-fingerprint'),
    ).resolves.toBeNull();
  });

  it('includes the OAuth revision in the source fingerprint', async (): Promise<void> => {
    const definition = {
      id: 'server-1',
      name: 'Server',
      description: '',
      type: 'http',
      url: 'https://mcp.example.test',
      createdAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:00:00.000Z',
    } satisfies McpServerDefinitionData;
    const config = {
      id: 'config-1',
      name: 'Default',
      description: '',
      enabled: true,
      envVars: {},
      extraArgs: [],
      extraHeaders: {},
      createdAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:00:00.000Z',
    } satisfies McpServerConfigData;

    expect(
      await mcpToolsSourceFingerprint(definition, config, 'revision-1'),
    ).not.toBe(
      await mcpToolsSourceFingerprint(definition, config, 'revision-2'),
    );
  });

  it('serializes concurrent whole-file cache mutations', async () => {
    await Promise.all([
      writeMcpToolsCacheEntry('server-a', 'config-a', {
        tools: ['one'],
        discoveredAt: '2026-07-14T00:00:00.000Z',
      }),
      writeMcpToolsCacheEntry('server-b', 'config-b', {
        tools: ['two'],
        discoveredAt: '2026-07-14T01:00:00.000Z',
      }),
    ]);

    await expect(
      getMcpToolsCacheEntry('server-a', 'config-a'),
    ).resolves.toMatchObject({ tools: ['one'] });
    await expect(
      getMcpToolsCacheEntry('server-b', 'config-b'),
    ).resolves.toMatchObject({ tools: ['two'] });
  });

  it('keeps the endpoint reachable when tools/list fails after initialize', async () => {
    await writeServer('provider');
    const fetchMock: jest.MockedFunction<typeof fetch> = jest.fn();
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { protocolVersion: '2025-06-18' },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(new Response('', { status: 500 }));
    global.fetch = fetchMock;

    await expect(
      discoverAndCacheMcpTools('server-1', 'config-1'),
    ).rejects.toMatchObject({ phase: 'tools', statusCode: 500 });
    expect(getMcpServerHealth('server-1')).toMatchObject({
      status: 'healthy',
      statusCode: 500,
    });
  });

  it('discovers provider-managed OAuth servers directly', async () => {
    await writeServer('provider');
    const fetchMock = fetchResponses();
    const entry = await discoverAndCacheMcpTools('server-1', 'config-1');
    expect(entry.tools).toEqual(['search', 'read']);
    expect(mockGetValidMcpAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mcp.example.test',
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        headers: expect.objectContaining({
          Accept: 'application/json, text/event-stream',
        }),
      }),
    );
  });

  it('probes Canopy-managed OAuth servers directly with the stored token', async () => {
    await writeServer('canopy');
    mockGetValidMcpAccessToken.mockResolvedValue('token-123');
    const fetchMock = fetchResponses();
    const entry = await discoverAndCacheMcpTools('server-1', 'config-1');
    expect(entry.tools).toEqual(['search', 'read']);
    expect(mockGetValidMcpAccessToken).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.any(AbortSignal),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mcp.example.test',
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        headers: expect.objectContaining({
          Accept: 'application/json, text/event-stream',
          Authorization: 'Bearer token-123',
          'X-Config': 'yes',
        }),
      }),
    );
  });

  it('records probe health after credential resolution invalidates older health', async () => {
    await writeServer('canopy');
    mockGetValidMcpAccessToken.mockImplementation(() => {
      clearMcpServerAuthHealthCache(['server-1']);
      return Promise.resolve('refreshed-token');
    });
    fetchResponses();

    await discoverAndCacheMcpTools('server-1', 'config-1');

    expect(getMcpServerHealth('server-1')).toMatchObject({
      status: 'healthy',
      message: 'Server is responding',
    });
  });

  it('preserves a configured static token instead of stored OAuth credentials', async () => {
    await writeServer(
      'canopy',
      true,
      'https://mcp.example.test',
      'static-token',
    );
    mockGetValidMcpAccessToken.mockResolvedValue('stale-oauth-token');
    const fetchMock = fetchResponses();

    await discoverAndCacheMcpTools('server-1', 'config-1');

    expect(mockGetValidMcpAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mcp.example.test',
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        headers: expect.objectContaining({
          Authorization: 'Bearer static-token',
        }),
      }),
    );
  });

  it('does not attach stored OAuth tokens to plaintext HTTP endpoints', async () => {
    await writeServer('canopy', true, 'http://mcp.example.test');
    mockGetValidMcpAccessToken.mockResolvedValue('token-123');
    const fetchMock = fetchResponses();

    await discoverAndCacheMcpTools('server-1', 'config-1');

    expect(mockGetValidMcpAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://mcp.example.test',
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        headers: expect.not.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          Authorization: expect.anything(),
        }),
      }),
    );
  });

  it('uses the stored token when OAuth was discovered after setup', async () => {
    await writeServer('canopy', false);
    mockGetValidMcpAccessToken.mockResolvedValue('token-123');
    const fetchMock = fetchResponses();

    await discoverAndCacheMcpTools('server-1', 'config-1');

    expect(mockGetValidMcpAccessToken).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mcp.example.test',
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        headers: expect.objectContaining({
          Authorization: 'Bearer token-123',
        }),
      }),
    );
  });

  it('probes Canopy-managed servers without Authorization when no token is stored', async () => {
    await writeServer('canopy');
    mockGetValidMcpAccessToken.mockResolvedValue(null);
    const fetchMock = fetchResponses();
    await discoverAndCacheMcpTools('server-1', 'config-1');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mcp.example.test',
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        headers: expect.not.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          Authorization: expect.anything(),
        }),
      }),
    );
  });

  it('parses SSE-format JSON-RPC responses', async () => {
    await writeServer('provider');
    const sse = (payload: unknown): Response =>
      new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    const fetchMock: jest.MockedFunction<typeof fetch> = jest.fn();
    fetchMock
      .mockResolvedValueOnce(
        sse({
          jsonrpc: '2.0',
          id: 1,
          result: { protocolVersion: '2025-06-18' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        sse({
          jsonrpc: '2.0',
          id: 2,
          result: { tools: [{ name: 'sse-tool' }] },
        }),
      );
    global.fetch = fetchMock;
    const entry = await discoverAndCacheMcpTools('server-1', 'config-1');
    expect(entry.tools).toEqual(['sse-tool']);
  });

  it('sends initialized before requesting tools with the negotiated session', async () => {
    await writeServer('provider');
    const fetchMock = fetchResponses();

    await discoverAndCacheMcpTools('server-1', 'config-1');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const initializedRequest = fetchMock.mock.calls[1]?.[1];
    expect(new Headers(initializedRequest?.headers).get('mcp-session-id')).toBe(
      'session-1',
    );
    expect(
      new Headers(initializedRequest?.headers).get('MCP-Protocol-Version'),
    ).toBe('2025-06-18');
    expect(
      new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get(
        'MCP-Protocol-Version',
      ),
    ).toBe('2025-06-18');
    expect(initializedRequest?.body).toBe(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      }),
    );
  });

  it('pins one validated DNS result across the complete discovery session', async () => {
    await writeServer('provider');
    mockDnsLookup
      .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
      .mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    fetchResponses();

    await discoverAndCacheMcpTools('server-1', 'config-1');

    expect(mockDnsLookup).toHaveBeenCalledTimes(1);
    expect(mockPinnedHttpFetch).toHaveBeenCalledTimes(3);
    for (const call of mockPinnedHttpFetch.mock.calls) {
      expect(call[1]).toEqual([{ address: '8.8.8.8', family: 4 }]);
    }
  });

  it('bounds DNS resolution by the initialize timeout', async () => {
    jest.useFakeTimers();
    mockDnsLookup.mockReturnValue(new Promise(() => undefined));
    try {
      const discovery = discoverHttpTools({
        type: 'http',
        url: 'https://mcp.example.test',
      });
      const rejection = expect(discovery).rejects.toMatchObject({
        kind: 'timeout',
        phase: 'initialize',
      });

      await jest.advanceTimersByTimeAsync(30_000);

      await rejection;
      expect(mockPinnedHttpFetch).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects unsupported protocol versions returned by initialize', async () => {
    await writeServer('provider');
    const fetchMock: jest.MockedFunction<typeof fetch> = jest.fn();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { protocolVersion: '2099-01-01' },
        }),
      ),
    );
    global.fetch = fetchMock;

    await expect(
      discoverAndCacheMcpTools('server-1', 'config-1'),
    ).rejects.toMatchObject({ kind: 'invalid', phase: 'initialize' });
  });

  it.each(['169.254.169.254', '100.64.0.1'])(
    'rejects configured endpoints that resolve to non-public address %s',
    async (address) => {
      await writeServer('provider');
      mockDnsLookup.mockResolvedValueOnce([{ address, family: 4 }]);
      const fetchMock: jest.MockedFunction<typeof fetch> = jest.fn();
      global.fetch = fetchMock;

      await expect(
        discoverAndCacheMcpTools('server-1', 'config-1'),
      ).rejects.toMatchObject({ kind: 'invalid', phase: 'initialize' });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['http://127.0.0.1:3000/mcp', '127.0.0.1', '127.0.0.1', 4],
    ['http://[::1]:3000/mcp', '::1', '::1', 6],
    ['http://localhost:3000/mcp', 'localhost', '127.0.0.1', 4],
  ] as const)(
    'allows an explicitly configured loopback endpoint %s',
    async (url, lookupHostname, address, family) => {
      await writeServer('provider', false, url);
      mockDnsLookup.mockResolvedValueOnce([{ address, family }]);
      fetchResponses();

      await expect(
        discoverAndCacheMcpTools('server-1', 'config-1'),
      ).resolves.toMatchObject({ tools: ['search', 'read'] });
      expect(mockDnsLookup).toHaveBeenCalledWith(lookupHostname, {
        all: true,
        verbatim: true,
      });
      expect(mockPinnedHttpFetch).toHaveBeenCalledWith(
        expect.any(URL),
        [{ address, family }],
        expect.any(Object),
        expect.any(String),
        expect.any(AbortSignal),
      );
    },
  );

  it('rejects a public hostname that resolves to loopback', async () => {
    await writeServer('provider');
    mockDnsLookup.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);

    await expect(
      discoverAndCacheMcpTools('server-1', 'config-1'),
    ).rejects.toMatchObject({ kind: 'invalid', phase: 'initialize' });
    expect(mockPinnedHttpFetch).not.toHaveBeenCalled();
  });

  it('follows tools/list cursors and caches the complete inventory', async () => {
    await writeServer('provider');
    const fetchMock: jest.MockedFunction<typeof fetch> = jest.fn();
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { protocolVersion: '2025-06-18' },
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            result: { tools: [{ name: 'first' }], nextCursor: 'page-2' },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 3,
            result: { tools: [{ name: 'second' }] },
          }),
        ),
      );
    global.fetch = fetchMock;

    const entry = await discoverAndCacheMcpTools('server-1', 'config-1');

    expect(entry.tools).toEqual(['first', 'second']);
    expect(global.fetch).toHaveBeenLastCalledWith(
      'https://mcp.example.test',
      expect.objectContaining({
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/list',
          params: { cursor: 'page-2' },
        }),
      }),
    );
  });

  it('rejects repeated tools/list cursors', async () => {
    await writeServer('provider');
    const fetchMock: jest.MockedFunction<typeof fetch> = jest.fn();
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { protocolVersion: '2025-06-18' },
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            result: { tools: [], nextCursor: 'same' },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 3,
            result: { tools: [], nextCursor: 'same' },
          }),
        ),
      );
    global.fetch = fetchMock;

    await expect(
      discoverAndCacheMcpTools('server-1', 'config-1'),
    ).rejects.toThrow(/repeated nextCursor/);
  });

  it('bounds tools/list pagination even when every cursor is unique', async () => {
    await writeServer('provider');
    let page = 0;
    const fetchImpl = (
      _url: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const body: unknown =
        typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      const method =
        body && typeof body === 'object' && 'method' in body
          ? body.method
          : undefined;
      const id =
        body && typeof body === 'object' && 'id' in body ? body.id : undefined;
      if (method === 'initialize') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              result: { protocolVersion: '2025-06-18' },
            }),
          ),
        );
      }
      if (method === 'notifications/initialized') {
        return Promise.resolve(new Response(null, { status: 202 }));
      }
      page += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: { tools: [], nextCursor: `page-${String(page)}` },
          }),
        ),
      );
    };
    global.fetch = jest.fn(fetchImpl);

    await expect(
      discoverAndCacheMcpTools('server-1', 'config-1'),
    ).rejects.toThrow(/pagination exceeded/);
    expect(page).toBe(MCP_DISCOVERY_MAX_TOOL_PAGES);
  });

  it('rejects tools/list JSON-RPC errors instead of caching an empty list', async () => {
    await writeServer('provider');
    const fetchMock: jest.MockedFunction<typeof fetch> = jest.fn();
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { protocolVersion: '2025-06-18' },
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            error: { code: -32_001, message: 'not initialized' },
          }),
        ),
      );
    global.fetch = fetchMock;

    await expect(
      discoverAndCacheMcpTools('server-1', 'config-1'),
    ).rejects.toMatchObject({ kind: 'rpc', phase: 'tools' });
    await expect(
      getMcpToolsCacheEntry('server-1', 'config-1'),
    ).resolves.toBeNull();
  });

  it('rejects oversized response bodies before decoding them', async () => {
    await writeServer('provider');
    const fetchMock: jest.MockedFunction<typeof fetch> = jest.fn();
    fetchMock.mockResolvedValueOnce(
      new Response('x'.repeat(MCP_DISCOVERY_MAX_RESPONSE_BYTES + 1)),
    );
    global.fetch = fetchMock;

    await expect(
      discoverAndCacheMcpTools('server-1', 'config-1'),
    ).rejects.toThrow(/exceeds.*bytes/);
  });

  it('rejects oversized tool names before caching them', async () => {
    await writeServer('provider');
    const fetchMock: jest.MockedFunction<typeof fetch> = jest.fn();
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { protocolVersion: '2025-06-18' },
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            result: {
              tools: [
                { name: 'x'.repeat(MCP_DISCOVERY_MAX_TOOL_NAME_BYTES + 1) },
              ],
            },
          }),
        ),
      );
    global.fetch = fetchMock;

    await expect(
      discoverAndCacheMcpTools('server-1', 'config-1'),
    ).rejects.toThrow(/tool name exceeds/);
  });
});
