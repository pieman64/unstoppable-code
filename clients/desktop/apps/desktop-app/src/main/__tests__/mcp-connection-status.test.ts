jest.mock('../canopy-cloud/mcp-connections', (): object => ({
  findAccountMcpConnection: jest.fn(),
}));
import { findAccountMcpConnection } from '../canopy-cloud/mcp-connections';
import {
  registerAccountMcpRouteStatus,
  setAccountMcpRouteReauthRequired,
  removeAccountMcpRouteStatus,
} from '../mcp/account-route-status';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let mockRoot = '';
const mockReadPreferences = jest.fn<Promise<unknown>, []>();
const mockGetAuthStatus = jest.fn<Promise<unknown>, unknown[]>();

jest.mock('../lib/paths', () => ({
  getMcpServersIndexFilePath: (): string => join(mockRoot, 'index.json'),
  getMcpServerFilePath: (id: string): string =>
    join(mockRoot, `server-${id}.json`),
}));
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: mockReadPreferences,
}));
jest.mock('../mcp/oauth-token-store', () => ({
  getMcpOAuthAuthStatusForDefinition: mockGetAuthStatus,
}));

import {
  accountMcpAuthState,
  clearMcpServerAuthHealthCache,
  clearMcpServerHealthCache,
  getMcpServerHealth,
  getMcpServerHealthGeneration,
  getMcpServerStatusByCatalogId,
  getMcpServerStatusByName,
  listMcpServerStatuses,
  recordMcpServerHealth,
} from '../mcp/connection-status';

interface ServerOptions {
  id: string;
  type?: 'http' | 'command';
  oauth?: boolean;
  handler?: 'canopy' | 'provider' | 'account';
  scope?: 'account';
  enabled?: boolean;
  authToken?: string;
  configs?: Array<{ id: string; enabled: boolean }>;
  curatedKey?: string;
}

async function writeServers(options: ServerOptions[]): Promise<void> {
  await writeFile(
    join(mockRoot, 'index.json'),
    JSON.stringify({
      version: 1,
      servers: options.map((server) => ({
        id: server.id,
        scope: server.scope,
        name: server.id,
        description: '',
        type: server.type ?? 'http',
        configs: (
          server.configs ?? [{ id: 'default', enabled: server.enabled ?? true }]
        ).map((config) => ({
          ...config,
          name: config.id,
        })),
        ...(server.curatedKey ? { curatedKey: server.curatedKey } : {}),
        updatedAt: '2026-07-14T00:00:00.000Z',
      })),
    }),
    'utf8',
  );
  for (const server of options) {
    await writeFile(
      join(mockRoot, `server-${server.id}.json`),
      JSON.stringify({
        version: 1,
        server: {
          definition: {
            id: server.id,
            name: server.id,
            description: '',
            type: server.type ?? 'http',
            ...(server.type === 'command'
              ? { command: 'node' }
              : { url: 'https://mcp.example.test' }),
            ...(server.oauth ? { oauth: { usePkce: true } } : {}),
            ...(server.handler ? { httpAuthHandler: server.handler } : {}),
            ...(server.curatedKey
              ? { curated: { key: server.curatedKey } }
              : {}),
            createdAt: '2026-07-14T00:00:00.000Z',
            updatedAt: '2026-07-14T00:00:00.000Z',
          },
          configs: (
            server.configs ?? [
              { id: 'default', enabled: server.enabled ?? true },
            ]
          ).map((config) => ({
            id: config.id,
            name: config.id,
            description: '',
            enabled: config.enabled,
            envVars: {},
            extraArgs: [],
            extraHeaders: {},
            ...(server.authToken ? { authToken: server.authToken } : {}),
            createdAt: '2026-07-14T00:00:00.000Z',
            updatedAt: '2026-07-14T00:00:00.000Z',
          })),
        },
      }),
      'utf8',
    );
  }
}

function health(
  serverId: string,
  status: 'healthy' | 'unhealthy' | 'needs_auth',
): void {
  recordMcpServerHealth({
    serverId,
    configId: 'default',
    status,
    message: status,
    checkedAt: '2026-07-14T01:00:00.000Z',
  });
}

describe('MCP connection status rollup', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    clearMcpServerHealthCache();
    mockRoot = await mkdtemp(join(tmpdir(), 'mcp-status-'));
    await mkdir(mockRoot, { recursive: true });
    mockReadPreferences.mockResolvedValue({
      mcpHttpAuthDefaultHandler: 'canopy',
    });
    mockGetAuthStatus.mockResolvedValue({ status: 'not_connected' });
  });

  afterEach(async () => {
    await rm(mockRoot, { recursive: true, force: true });
  });

  it.each(['CONNECTED', 'PENDING', 'REAUTH_REQUIRED', 'DISCONNECTED'] as const)(
    'derives account %s status without consulting local tokens or health',
    async (status): Promise<void> => {
      await writeServers([
        {
          id: 'account',
          scope: 'account',
          curatedKey: 'github',
          authToken: 'local-token',
          oauth: true,
        },
      ]);
      jest.mocked(findAccountMcpConnection).mockResolvedValue({
        id: 'a',
        serverKey: 'github',
        configId: 'default',
        displayName: 'GitHub',
        kind: 'CURATED',
        status,
        routeId: 'r',
        enabledTools: null,
      });
      const [entry] = await listMcpServerStatuses();
      expect(entry?.handler).toBe('account');
      expect(entry?.connectionStatus).toBe(
        status === 'CONNECTED' ? 'connected' : 'auth_required',
      );
      expect(entry?.configs[0]?.authStatus).toBe(
        status === 'CONNECTED'
          ? 'connected'
          : status === 'REAUTH_REQUIRED'
            ? 'error'
            : 'not_connected',
      );
      expect(mockGetAuthStatus).not.toHaveBeenCalled();
      if (status === 'CONNECTED') {
        registerAccountMcpRouteStatus('local-route', 'account', 'default', 'r');
        setAccountMcpRouteReauthRequired('local-route', true);
        expect((await listMcpServerStatuses())[0]?.connectionStatus).toBe(
          'auth_required',
        );
        jest.mocked(findAccountMcpConnection).mockResolvedValue({
          id: 'another-account',
          serverKey: 'github',
          configId: 'default',
          displayName: 'GitHub',
          kind: 'CURATED',
          status: 'CONNECTED',
          routeId: 'new-route',
          enabledTools: null,
        });
        expect((await listMcpServerStatuses())[0]?.connectionStatus).toBe(
          'connected',
        );
        removeAccountMcpRouteStatus('local-route');
      }
    },
  );

  it('reports reauth for a device server whose shared account route is keyed by the connection', async () => {
    // REG-3033: a device file routed to an account connection shares the
    // route (and its serverId/configId) with the connection itself, so the
    // device card must find the reauth flag under the connection identity.
    jest.mocked(findAccountMcpConnection).mockResolvedValue({
      id: 'conn-default',
      serverKey: 'linear',
      configId: 'default',
      displayName: 'Linear',
      kind: 'CURATED',
      status: 'CONNECTED',
      routeId: 'cloud-route',
      enabledTools: null,
    });
    registerAccountMcpRouteStatus(
      'shared-route',
      'linear',
      'default',
      'cloud-route',
    );
    setAccountMcpRouteReauthRequired('shared-route', true);
    try {
      await expect(
        accountMcpAuthState({
          serverId: 'linear-device',
          configId: 'default',
          curatedKey: 'linear',
        }),
      ).resolves.toEqual({
        authStatus: 'error',
        accountConnectionId: 'conn-default',
      });
      await expect(
        accountMcpAuthState({
          serverId: 'linear',
          configId: 'default',
          accountConnectionId: 'conn-default',
        }),
      ).resolves.toEqual({
        authStatus: 'error',
        accountConnectionId: 'conn-default',
      });
    } finally {
      removeAccountMcpRouteStatus('shared-route');
    }
  });

  it('drops a health result that started before auth cache invalidation', () => {
    const generation = getMcpServerHealthGeneration('racing-server');
    clearMcpServerAuthHealthCache(['racing-server']);

    const recorded = recordMcpServerHealth(
      {
        serverId: 'racing-server',
        configId: 'default',
        status: 'needs_auth',
        message: 'stale probe',
        checkedAt: '2026-07-14T01:00:00.000Z',
      },
      generation,
    );

    expect(recorded).toBe(false);
    expect(getMcpServerHealth('racing-server')).toBeUndefined();
  });

  it('does not infer OAuth for plain HTTP from secure-storage failure', async () => {
    await writeServers([{ id: 'plain-http' }]);
    mockGetAuthStatus.mockResolvedValue({
      status: 'error',
      lastError: 'Secure storage unavailable',
    });

    const [status] = await listMcpServerStatuses();

    expect(status.configs[0]).toEqual({
      configId: 'default',
      authStatus: 'not_configured',
    });
  });

  it('rolls up Canopy-managed HTTP reachability and auth independently', async () => {
    await writeServers([
      { id: 'needs-auth', oauth: true },
      { id: 'down', oauth: true },
      { id: 'connected', oauth: true },
      { id: 'public' },
      { id: 'unknown', oauth: true },
    ]);
    health('needs-auth', 'needs_auth');
    health('down', 'unhealthy');
    health('connected', 'healthy');
    health('public', 'healthy');
    mockGetAuthStatus.mockImplementation((definition: { id: string }) =>
      Promise.resolve({
        status: definition.id === 'connected' ? 'connected' : 'not_connected',
      }),
    );

    const byId = new Map(
      (await listMcpServerStatuses()).map((entry) => [entry.serverId, entry]),
    );
    expect(byId.get('needs-auth')?.connectionStatus).toBe('auth_required');
    expect(byId.get('needs-auth')?.reachability).toBe('reachable');
    expect(byId.get('down')?.connectionStatus).toBe('unreachable');
    expect(byId.get('connected')?.connectionStatus).toBe('connected');
    expect(byId.get('public')?.connectionStatus).toBe('connected');
    expect(byId.get('unknown')?.connectionStatus).toBe('unknown');
  });

  it('does not require sign-in when the expired token can refresh', async () => {
    await writeServers([{ id: 'refreshable', oauth: true }]);
    health('refreshable', 'healthy');
    mockGetAuthStatus.mockResolvedValue({
      status: 'expired',
      canRefresh: true,
    });

    const [status] = await listMcpServerStatuses();
    expect(status).toMatchObject({
      connectionStatus: 'unknown',
      configs: [{ authStatus: 'expired', canRefresh: true }],
    });
  });

  it('does not treat cached success as valid expired discovery-only credentials', async () => {
    await writeServers([{ id: 'discovered', handler: 'canopy', oauth: false }]);
    health('discovered', 'healthy');
    mockGetAuthStatus.mockResolvedValue({
      status: 'expired',
      hasStoredToken: true,
    });
    const [status] = await listMcpServerStatuses();
    expect(status.connectionStatus).toBe('auth_required');
  });

  it('uses a stored OAuth token for a discovery-only definition', async () => {
    await writeServers([
      { id: 'discovery-only', handler: 'canopy', oauth: false },
    ]);
    health('discovery-only', 'healthy');
    mockGetAuthStatus.mockResolvedValue({
      status: 'connected',
      hasStoredToken: true,
    });

    const [status] = await listMcpServerStatuses();

    expect(status).toMatchObject({
      connectionStatus: 'connected',
      configs: [{ authStatus: 'connected' }],
    });
    expect(mockGetAuthStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'discovery-only' }),
      expect.objectContaining({ id: 'default' }),
    );
  });

  it('reports auth required when a stored static token is rejected', async () => {
    await writeServers([
      {
        id: 'rejected-static-token',
        handler: 'canopy',
        authToken: 'expired-token',
      },
    ]);
    health('rejected-static-token', 'needs_auth');

    const [status] = await listMcpServerStatuses();

    expect(status).toMatchObject({
      connectionStatus: 'auth_required',
      reachability: 'reachable',
    });
  });

  it('requires every enabled configuration to be authenticated', async () => {
    await writeServers([
      {
        id: 'multi-config',
        oauth: true,
        configs: [
          { id: 'connected', enabled: true },
          { id: 'needs-auth', enabled: true },
          { id: 'disabled', enabled: false },
        ],
      },
    ]);
    health('multi-config', 'healthy');
    mockGetAuthStatus.mockImplementation(
      (_definition: unknown, config: { id: string }) =>
        Promise.resolve({
          status: config.id === 'connected' ? 'connected' : 'not_connected',
        }),
    );

    const [status] = await listMcpServerStatuses();

    expect(status?.connectionStatus).toBe('auth_required');
  });

  it('treats provider auth as reachability-only and never reads token state', async () => {
    await writeServers([
      { id: 'provider', oauth: true, handler: 'provider', enabled: false },
    ]);
    health('provider', 'needs_auth');

    const [status] = await listMcpServerStatuses();
    expect(status).toMatchObject({
      connectionStatus: 'connected',
      reachability: 'reachable',
      handler: 'provider',
      handlerSource: 'server',
    });
    expect(mockGetAuthStatus).not.toHaveBeenCalled();
  });

  it('maps command binary health directly and omits handler metadata', async () => {
    await writeServers([
      { id: 'present', type: 'command' },
      { id: 'missing', type: 'command' },
    ]);
    health('present', 'healthy');
    health('missing', 'unhealthy');

    const byId = new Map(
      (await listMcpServerStatuses()).map((entry) => [entry.serverId, entry]),
    );
    expect(byId.get('present')).toMatchObject({
      connectionStatus: 'connected',
      configs: [{ authStatus: 'unsupported' }],
    });
    expect(byId.get('present')).not.toHaveProperty('handler');
    expect(byId.get('missing')?.connectionStatus).toBe('unreachable');
  });

  it('resolves portable package requirements by curated catalog id', async () => {
    await writeServers([{ id: 'local-linear-id', curatedKey: 'linear' }]);
    health('local-linear-id', 'healthy');

    await expect(
      getMcpServerStatusByCatalogId('linear'),
    ).resolves.toMatchObject({
      serverId: 'local-linear-id',
      connectionStatus: 'connected',
    });
    await expect(
      getMcpServerStatusByCatalogId('not-installed'),
    ).resolves.toBeNull();
  });

  it('resolves a skill-referenced server by name, ignoring case and separators', async () => {
    // A shared skill names its MCP servers as written in its instructions
    // (`mcp__Linear_App__...`), not by a curated catalog id.
    await writeServers([{ id: 'linear-app', curatedKey: 'linear' }]);
    health('linear-app', 'healthy');

    await expect(getMcpServerStatusByName('Linear App')).resolves.toMatchObject(
      { serverId: 'linear-app', connectionStatus: 'connected' },
    );
    await expect(getMcpServerStatusByName('LINEAR')).resolves.toMatchObject({
      serverId: 'linear-app',
    });
    await expect(getMcpServerStatusByName('Slack')).resolves.toBeNull();
    await expect(getMcpServerStatusByName('---')).resolves.toBeNull();
  });
});
