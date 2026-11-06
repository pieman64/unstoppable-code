import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  McpServerConfigData,
  McpServerDefinitionData,
} from '@canopy/desktop-shared/types/mcp-servers';
import type * as CanopyCloudClientModule from '../../canopy-cloud/client';

jest.mock('../oauth-client', () => ({
  getValidMcpAccessToken: jest.fn(),
  handleMcpOAuthCallback: jest.fn(),
}));
jest.mock('../../canopy-cloud/client', () => ({
  CanopyCloudClientError: jest.requireActual<typeof CanopyCloudClientModule>(
    '../../canopy-cloud/client',
  ).CanopyCloudClientError,
  resolveCanopyCloudCredentialContext: jest.fn(),
}));
jest.mock('../oauth-token-store', () => ({
  invalidateMcpOAuthAccessToken: jest.fn(),
}));
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessError: jest.fn(),
}));

import { resolveCanopyCloudCredentialContext } from '../../canopy-cloud/client';
import { getValidMcpAccessToken } from '../oauth-client';
import { invalidateMcpOAuthAccessToken } from '../oauth-token-store';
import * as pendingAuthFailures from '../pending-auth-failures';
import { isAccountMcpReauthRequired } from '../account-route-status';
import {
  AgentMcpConnections,
  type McpProxiedToolCallGate,
  type McpProxyRouteRegistration,
} from '../agent-mcp-connections';

interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

interface ClientResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

type UpstreamHandler = (req: RecordedRequest, res: ServerResponse) => void;

// Headers Node's HTTP client and server add on their own.
const TRANSPORT_HEADERS = new Set([
  'connection',
  'keep-alive',
  'content-length',
  'transfer-encoding',
  'date',
]);

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address: AddressInfo | string | null = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

function send(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<ClientResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      { method: options.method ?? 'POST', headers: options.headers ?? {} },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

function nonTransportHeaderNames(headers: IncomingHttpHeaders): string[] {
  return Object.keys(headers)
    .filter((name) => !TRANSPORT_HEADERS.has(name))
    .sort();
}

const TOOL_CALL = JSON.stringify({
  jsonrpc: '2.0',
  id: 7,
  method: 'tools/call',
  params: { name: 'search', arguments: { q: 'x' } },
});

describe('agent MCP connections (CAN-4125)', () => {
  let upstream: Server;
  let upstreamBase: string;
  let upstreamRequests: RecordedRequest[];
  let upstreamHandler: UpstreamHandler;
  let front: Server;
  let frontBase: string;
  let connections: AgentMcpConnections;

  const proxyUrl = (routeId: string): string =>
    `${frontBase}/mcp-proxy/${encodeURIComponent(routeId)}`;

  const route = (
    overrides: Partial<McpProxyRouteRegistration> = {},
  ): McpProxyRouteRegistration => ({
    sessionId: null,
    serverId: 'srv',
    configId: 'cfg',
    displayName: 'Server',
    upstreamUrl: `${upstreamBase}/mcp`,
    headers: {},
    oauthEnabled: false,
    ...overrides,
  });

  beforeEach(async () => {
    jest.mocked(getValidMcpAccessToken).mockReset();
    jest.mocked(resolveCanopyCloudCredentialContext).mockReset();
    jest.mocked(invalidateMcpOAuthAccessToken).mockReset();
    upstreamRequests = [];
    upstreamHandler = (_req, res): void => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    };
    upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const recorded: RecordedRequest = {
          method: req.method ?? '',
          path: req.url ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        upstreamRequests.push(recorded);
        upstreamHandler(recorded, res);
      });
    });
    upstreamBase = `http://127.0.0.1:${String(await listen(upstream))}`;
    connections = new AgentMcpConnections({
      proxyUrl,
      listening: (): boolean => true,
    });
    front = createServer((req, res) => {
      const id = decodeURIComponent(
        new URL(req.url ?? '/', 'http://x').pathname.split('/').pop() ?? '',
      );
      void connections.serve(req, res, id);
    });
    frontBase = `http://127.0.0.1:${String(await listen(front))}`;
  });

  afterEach(async () => {
    connections.clear();
    await close(front);
    await close(upstream);
  });

  it("forwards only safe headers and injects the route's credentials", async () => {
    upstreamHandler = (_req, res): void => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': 'upstream=secret',
        'x-upstream-private': 'hidden',
        'mcp-session-id': 'upstream-session',
      });
      res.end('{"ok":true}');
    };
    const id = await connections.register(
      route({ headers: { 'X-Api-Key': 'route-key' } }),
    );

    const response = await send(proxyUrl(id), {
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'mcp-session-id': 'client-session',
        cookie: 'client=secret',
        authorization: 'Bearer agent',
      },
      body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    });

    expect(response.status).toBe(200);
    expect(upstreamRequests).toHaveLength(1);
    const seen = upstreamRequests[0]?.headers ?? {};
    expect(nonTransportHeaderNames(seen)).toEqual([
      'accept',
      'content-type',
      'host',
      'mcp-session-id',
      'x-api-key',
    ]);
    expect(seen['x-api-key']).toBe('route-key');
    expect(seen['mcp-session-id']).toBe('client-session');
    expect(nonTransportHeaderNames(response.headers)).toEqual([
      'content-type',
      'mcp-session-id',
    ]);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['mcp-session-id']).toBe('upstream-session');
  });

  it('an account route sends the account key and refuses a route outside the configured cloud', async () => {
    jest.mocked(resolveCanopyCloudCredentialContext).mockResolvedValue({
      apiKey: 'acct-key',
      baseUrl: upstreamBase,
    });
    const accountRoute = await connections.register(
      route({
        upstreamUrl: `${upstreamBase}/api/v1/mcp-proxy/r1`,
        authSupplier: 'canopy-cloud',
        headers: { Authorization: 'Bearer route-supplied' },
      }),
    );

    const ok = await send(proxyUrl(accountRoute), { body: '{}' });
    expect(ok.status).toBe(200);
    expect(upstreamRequests[0]?.headers.authorization).toBe('Bearer acct-key');

    const foreignOrigin = upstreamBase.replace('127.0.0.1', 'localhost');
    const foreign = await connections.register(
      route({
        upstreamUrl: `${foreignOrigin}/api/v1/mcp-proxy/r2`,
        authSupplier: 'canopy-cloud',
      }),
    );
    const refused = await send(proxyUrl(foreign), { body: '{}' });
    expect(refused.status).toBe(502);
    expect(JSON.parse(refused.body)).toEqual({
      error: 'account_route_unavailable',
    });
    expect(upstreamRequests).toHaveLength(1);

    jest.mocked(resolveCanopyCloudCredentialContext).mockResolvedValue({
      apiKey: '',
      baseUrl: upstreamBase,
    });
    const signedOut = await send(proxyUrl(accountRoute), { body: '{}' });
    expect(signedOut.status).toBe(401);
    expect(JSON.parse(signedOut.body)).toEqual({
      error: 'mcp_reauth_required',
    });
    expect(connections.routeStatus(accountRoute)).toEqual({
      reauthRequired: true,
    });
    expect(upstreamRequests).toHaveLength(1);
  });

  it('a gated route never forwards without its live session gate', async () => {
    const id = await connections.register(
      route({ sessionId: 's', requireToolCallGate: true }),
    );

    const ungated = await send(proxyUrl(id), { body: TOOL_CALL });
    expect(JSON.parse(ungated.body)).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'Selected MCP route is unavailable.' },
    });
    expect(upstreamRequests).toHaveLength(0);

    const gate = jest.fn<
      ReturnType<McpProxiedToolCallGate>,
      Parameters<McpProxiedToolCallGate>
    >();
    gate.mockResolvedValue(false);
    connections.setSessionToolCallGate('s', gate);
    const denied = await send(proxyUrl(id), { body: TOOL_CALL });
    expect(JSON.parse(denied.body)).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: {
        content: [{ type: 'text', text: 'search was denied.' }],
        isError: true,
      },
    });
    expect(gate).toHaveBeenCalledWith({
      proxyUrl: proxyUrl(id),
      tool: 'search',
      args: { q: 'x' },
      requestId: '7',
    });

    const batched = await send(proxyUrl(id), {
      body: JSON.stringify([JSON.parse(TOOL_CALL)]),
    });
    expect(JSON.parse(batched.body)).toMatchObject({
      error: { code: -32600 },
    });
    expect(upstreamRequests).toHaveLength(0);

    gate.mockResolvedValue(true);
    await send(proxyUrl(id), { body: TOOL_CALL });
    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]?.body).toBe(TOOL_CALL);

    gate.mockClear();
    const notification = JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    await send(proxyUrl(id), { body: notification });
    expect(gate).not.toHaveBeenCalled();
    expect(upstreamRequests[1]?.body).toBe(notification);
  });

  it('disconnecting a session removes every route it owns and nothing else', async () => {
    const clearSpy = jest.spyOn(
      pendingAuthFailures,
      'clearPendingAuthFailures',
    );
    const first = await connections.register(route({ sessionId: 's1' }));
    const second = await connections.register(route({ sessionId: 's1' }));
    const other = await connections.register(route({ sessionId: 's2' }));
    const probe = await connections.register(route({ sessionId: null }));

    connections.disconnectSession('s1');

    expect((await send(proxyUrl(first), { body: '{}' })).status).toBe(404);
    expect((await send(proxyUrl(second), { body: '{}' })).status).toBe(404);
    expect((await send(proxyUrl(other), { body: '{}' })).status).toBe(200);
    expect((await send(proxyUrl(probe), { body: '{}' })).status).toBe(200);
    expect(clearSpy).toHaveBeenCalledWith('s1');

    connections.setSessionToolCallGate('s1', () => Promise.resolve(true));
    connections.disconnectSession('s1');
    const gated = await connections.register(
      route({ sessionId: 's1', requireToolCallGate: true }),
    );
    const unavailable = await send(proxyUrl(gated), { body: TOOL_CALL });
    expect(JSON.parse(unavailable.body)).toMatchObject({
      error: { code: -32000, message: 'Selected MCP route is unavailable.' },
    });
    connections.setSessionToolCallGate('s1', () => Promise.resolve(true));
    expect((await send(proxyUrl(gated), { body: TOOL_CALL })).status).toBe(200);
    clearSpy.mockRestore();
  });

  it('an OAuth route answers 401 without a token, 503 when the token read fails, and invalidates a rejected token before relaying it', async () => {
    const definition = { id: 'srv' } as unknown as McpServerDefinitionData;
    const config = { id: 'cfg' } as unknown as McpServerConfigData;
    const id = await connections.register(
      route({
        oauthEnabled: true,
        oauthDefinition: definition,
        oauthConfig: config,
      }),
    );

    jest.mocked(getValidMcpAccessToken).mockResolvedValue(null);
    const missing = await send(proxyUrl(id), { body: '{}' });
    expect(missing.status).toBe(401);
    expect(JSON.parse(missing.body)).toMatchObject({ error: { code: -32001 } });

    jest
      .mocked(getValidMcpAccessToken)
      .mockRejectedValue(new Error('store unreadable'));
    const unavailable = await send(proxyUrl(id), { body: '{}' });
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers['retry-after']).toBe('30');
    expect(upstreamRequests).toHaveLength(0);

    jest.mocked(getValidMcpAccessToken).mockResolvedValue('tok');
    await send(proxyUrl(id), { body: '{}' });
    expect(upstreamRequests[0]?.headers.authorization).toBe('Bearer tok');

    const order: string[] = [];
    jest.mocked(invalidateMcpOAuthAccessToken).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            order.push('invalidated');
            resolve();
          }, 50);
        }),
    );
    upstreamHandler = (_req, res): void => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"invalid_token"}');
    };
    const rejected = await send(proxyUrl(id), { body: '{}' });
    order.push('client');
    expect(rejected.status).toBe(401);
    expect(invalidateMcpOAuthAccessToken).toHaveBeenCalledWith(
      'srv',
      'cfg',
      'tok',
      `${upstreamBase}/mcp`,
    );
    expect(order).toEqual(['invalidated', 'client']);
  });

  it('register refuses non-HTTP upstreams and a gated route without a session', async () => {
    await expect(
      connections.register(route({ upstreamUrl: 'ftp://127.0.0.1/mcp' })),
    ).rejects.toThrow('MCP proxy only supports HTTP and HTTPS upstream URLs.');
    await expect(
      connections.register(
        route({ sessionId: null, requireToolCallGate: true }),
      ),
    ).rejects.toThrow('A gated MCP route requires a session.');
    expect(connections.size).toBe(0);
  });

  it('start, port change and shutdown keep their routes and statuses as before', async () => {
    const { McpHttpProxyService } = await import('../http-proxy-service');
    const freePort = async (): Promise<number> => {
      const probe = createServer();
      const port = await listen(probe);
      await close(probe);
      return port;
    };
    const p1 = await freePort();
    const p2 = await freePort();
    const p3 = await freePort();
    const service = new McpHttpProxyService();
    try {
      await service.ensureStarted(p1);
      expect(service.getState().status).toBe('running');

      const id = await service.registerRoute(route());
      const accountId = await service.registerRoute(
        route({
          upstreamUrl: `${upstreamBase}/api/v1/mcp-proxy/acct`,
          authSupplier: 'canopy-cloud',
        }),
      );
      jest.mocked(resolveCanopyCloudCredentialContext).mockResolvedValue({
        apiKey: '',
        baseUrl: upstreamBase,
      });
      await send(service.getProxyUrl(accountId), { body: '{}' });
      expect(isAccountMcpReauthRequired('srv', 'cfg')).toBe(true);

      expect((await send(service.getProxyUrl(id), { body: '{}' })).status).toBe(
        200,
      );

      await service.updatePort(p2);
      expect(service.getPort()).toBe(p2);
      expect(service.getProxyUrl(id)).toContain(`:${String(p2)}/`);
      expect((await send(service.getProxyUrl(id), { body: '{}' })).status).toBe(
        200,
      );

      await service.ensureStarted(p3);
      expect(service.getPort()).toBe(p2);

      const health = await send(`http://127.0.0.1:${String(p2)}/health`, {
        method: 'GET',
      });
      expect(JSON.parse(health.body)).toMatchObject({ routeCount: 2 });

      await service.shutdown();
      expect(service.getState().status).toBe('stopped');
      expect(service.getRouteStatus(id)).toBeUndefined();
      expect(isAccountMcpReauthRequired('srv', 'cfg')).toBe(false);
    } finally {
      await service.shutdown();
    }
  }, 60_000);
});
