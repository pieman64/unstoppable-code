import { AccountMcpConnectionError } from '@canopy/desktop-shared/types/mcp-servers';
import {
  mergeAccountMcpInventory,
  withAccountMcpInventory,
} from '../mcp/account-catalog';
import { getFeatureFlagService } from '../feature-flags/service';
import { listAccountMcpConnections } from '../canopy-cloud/mcp-connections';
import { CanopyCloudClientError } from '../canopy-cloud/client';
import type {
  AccountMcpConnection,
  McpServerIndexEntry,
} from '@canopy/desktop-shared/types/mcp-servers';
jest.mock(
  '../feature-flags/service',
  (): Record<string, unknown> => ({
    getFeatureFlagService: jest.fn((): { isEnabled: () => boolean } => ({
      isEnabled: (): boolean => false,
    })),
  }),
);
jest.mock('../canopy-cloud/mcp-connections', (): object => ({
  findAccountMcpConnection: jest.fn(),
  listAccountMcpConnections: jest.fn(),
  getAccountMcpConnection: jest.fn(),
}));
import { findAccountMcpConnection } from '../canopy-cloud/mcp-connections';
jest.mock(
  '../mcp/curated-catalog',
  (): Record<string, unknown> => ({
    readCachedCuratedMcpDesktopOnlyKeys: jest.fn(
      (): Promise<ReadonlySet<string>> => Promise.resolve(new Set()),
    ),
  }),
);
import { readCachedCuratedMcpDesktopOnlyKeys } from '../mcp/curated-catalog';
jest.mock('../lib/paths', () => ({
  getBundleConfigFilePath: jest.fn(),
  getCollectionConfigFilePath: jest.fn(),
  getMcpServerFilePath: jest.fn(),
  getMcpServersIndexFilePath: jest.fn(),
}));
jest.mock('../mcp/oauth-token-store', () => ({
  migratePluginMcpOAuthToken: jest.fn(() => Promise.resolve()),
  getMcpOAuthAuthStatusForDefinition: jest.fn(() =>
    Promise.resolve({ status: 'not_connected' }),
  ),
}));
jest.mock('../mcp/oauth-probe', () => ({
  probeMcpHttpOAuthRequirement: jest.fn(() =>
    Promise.resolve({
      requirement: 'none' as const,
      requiresOAuth: false,
      challenge: {},
    }),
  ),
}));
jest.mock('../plugins/plugin-service', () => ({
  loadMarketplaces: jest.fn(),
}));
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(() =>
    Promise.resolve({ mcpHttpAuthDefaultHandler: 'canopy' }),
  ),
}));

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getBundleConfigFilePath,
  getCollectionConfigFilePath,
  getMcpServerFilePath,
  getMcpServersIndexFilePath,
} from '../lib/paths';
import { probeMcpHttpOAuthRequirement } from '../mcp/oauth-probe';
import type * as OAuthProbeModule from '../mcp/oauth-probe';
import { getMcpOAuthAuthStatusForDefinition } from '../mcp/oauth-token-store';
import {
  CURATED_PLUGIN_MCP_CONNECT_LABEL,
  listDetectedMcpServersForSelections,
} from '../plugins/mcp-inventory';
import { loadMarketplaces } from '../plugins/plugin-service';

const getBundleConfigFilePathMock = jest.mocked(getBundleConfigFilePath);
const getCollectionConfigFilePathMock = jest.mocked(
  getCollectionConfigFilePath,
);
const getMcpServerFilePathMock = jest.mocked(getMcpServerFilePath);
const getMcpOAuthAuthStatusForDefinitionMock = jest.mocked(
  getMcpOAuthAuthStatusForDefinition,
);
const probeMcpHttpOAuthRequirementMock = jest.mocked(
  probeMcpHttpOAuthRequirement,
);
const loadMarketplacesMock = jest.mocked(loadMarketplaces);

describe('mcp inventory', () => {
  let tempDir = '';

  beforeEach(() => {
    jest.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-mcp-inventory-'));
    getMcpServerFilePathMock.mockImplementation((serverId: string): string =>
      path.join(tempDir, 'mcp', `${serverId}.json`),
    );
    getBundleConfigFilePathMock.mockImplementation((bundleId: string): string =>
      path.join(tempDir, 'bundles', `bundle-${bundleId}.json`),
    );
    getCollectionConfigFilePathMock.mockImplementation(
      (collectionId: string): string =>
        path.join(tempDir, 'collections', `collection-${collectionId}.json`),
    );
    getMcpOAuthAuthStatusForDefinitionMock.mockResolvedValue({
      status: 'not_connected',
    });
    probeMcpHttpOAuthRequirementMock.mockResolvedValue({
      requirement: 'none',
      requiresOAuth: false,
      challenge: {},
    });
    delete process.env.PLUGIN_TOKEN;
    loadMarketplacesMock.mockReturnValue({
      success: true,
      data: {
        version: 1,
        lastRefreshed: '2026-04-29T00:00:00.000Z',
        marketplaces: [],
      },
    });
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('lists account selections by server key and maps legacy refs', async (): Promise<void> => {
    const github: AccountMcpConnection = {
      id: 'account-id',
      serverKey: 'github',
      configId: 'default',
      displayName: 'GitHub account',
      status: 'CONNECTED',
      routeId: 'route',
      enabledTools: null,
      kind: 'CURATED',
    };
    const custom: AccountMcpConnection = {
      ...github,
      id: 'custom-id',
      serverKey: 'custom:11111111-2222-4333-8444-555555555555',
      displayName: 'Internal tools',
      kind: 'CUSTOM',
    };
    const service = getFeatureFlagService();
    const isEnabled = jest.spyOn(service, 'isEnabled').mockReturnValue(true);
    jest.mocked(getFeatureFlagService).mockReturnValue(service);
    jest.mocked(listAccountMcpConnections).mockResolvedValue([github, custom]);
    jest
      .mocked(findAccountMcpConnection)
      .mockImplementation(({ accountConnectionId }) =>
        Promise.resolve(
          [github, custom].find((row) => row.id === accountConnectionId),
        ),
      );
    try {
      const result = await listDetectedMcpServersForSelections({
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [
          { serverId: 'github', configId: 'default' },
          { serverId: 'account:account-id', configId: 'default' },
          { serverId: custom.serverKey, configId: 'default' },
          { serverId: 'account:deleted', configId: 'default' },
        ],
      });
      expect(
        result.servers.map((server) => [
          server.key,
          server.serverId,
          server.accountConnectionId,
          server.authStatus,
        ]),
      ).toEqual([
        ['standalone:github:default', 'github', 'account-id', 'connected'],
        [
          `standalone:${custom.serverKey}:default`,
          custom.serverKey,
          'custom-id',
          'connected',
        ],
      ]);
      expect(result.servers[0]).toMatchObject({
        scope: 'account',
        curatedKey: 'github',
      });
      expect(result.warnings).toEqual([
        'Account MCP connection is unavailable. Connect again.',
      ]);
      expect(getMcpServerFilePathMock).not.toHaveBeenCalledWith(
        custom.serverKey,
      );
    } finally {
      isEnabled.mockReturnValue(false);
    }
  });

  it.each([
    ['CONNECTED', 'connected', 'Connected'],
    ['PENDING', 'not_connected', 'Connect in cloud'],
    ['DISCONNECTED', 'not_connected', 'Connect in cloud'],
    ['REAUTH_REQUIRED', 'error', 'Reconnect in cloud'],
  ] as const)(
    'reports account %s status without local OAuth or a proxy toggle',
    async (status, authStatus, authStatusLabel): Promise<void> => {
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
      writeMcpServer('account', {
        definition: {
          id: 'account',
          name: 'GitHub',
          type: 'http',
          url: 'https://api.example.test/mcp',
          curated: { key: 'github' },
          httpAuthHandler: 'account',
        },
        configs: [
          {
            id: 'default',
            name: 'Default',
            enabled: true,
            authToken: 'ignored',
          },
        ],
      });
      const result = await listDetectedMcpServersForSelections({
        collectionIds: [],
        pluginRefs: [],
        skillRefs: [],
        mcpServerRefs: [{ serverId: 'account', configId: 'default' }],
      });
      expect(result.servers[0]).toMatchObject({
        scope: 'account',
        authHandler: 'account',
        httpAuthHandler: 'account',
        canToggleCanopyProxy: false,
        canConnect: false,
        authStatus,
        authStatusLabel,
      });
      expect(getMcpOAuthAuthStatusForDefinitionMock).not.toHaveBeenCalled();
      expect(probeMcpHttpOAuthRequirementMock).not.toHaveBeenCalled();
    },
  );

  it('skips marketplace discovery when the inventory has no plugin refs', async () => {
    const result = await listDetectedMcpServersForSelections({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    });

    expect(result).toEqual({ servers: [], warnings: [] });
    expect(loadMarketplacesMock).not.toHaveBeenCalled();
  });

  it('lists standalone and Collection MCP refs with auth labels and de-duplication', async () => {
    writeMcpServer('server-1', {
      definition: {
        id: 'server-1',
        name: 'OAuth Server',
        description: 'Needs OAuth',
        type: 'http',
        url: 'https://api.example.test/mcp',
        oauth: {
          clientId: 'client',
          authorizationUrl: 'https://auth.example.test/authorize',
          tokenUrl: 'https://auth.example.test/token',
          scopes: [],
          usePkce: true,
        },
      },
      configs: [
        {
          id: 'default',
          name: 'Default',
          enabled: true,
          authToken: undefined,
        },
      ],
    });
    writeBundle('bundle-1', [{ serverId: 'server-1', configId: 'default' }]);

    const result = await listDetectedMcpServersForSelections({
      collectionIds: ['bundle-1'],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [{ serverId: 'server-1', configId: 'default' }],
    });

    expect(result.warnings).toEqual([]);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]).toMatchObject({
      source: 'standalone',
      serverId: 'server-1',
      configId: 'default',
      displayName: 'OAuth Server',
      authStatus: 'not_connected',
      authStatusLabel: 'Needs auth',
      canConnect: true,
      connectLabel: 'Connect',
    });
    expect(getMcpOAuthAuthStatusForDefinitionMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'server-1' }),
      expect.objectContaining({ id: 'default' }),
    );
  });

  it('exposes the curated catalog key for curated-linked standalone servers', async () => {
    writeMcpServer('curated-server', {
      definition: {
        id: 'curated-server',
        name: 'Curated Server',
        type: 'http',
        url: 'https://api.example.test/mcp',
        curated: { key: 'github' },
      },
      configs: [{ id: 'default', name: 'Default', enabled: true }],
    });
    writeMcpServer('plain-server', {
      definition: {
        id: 'plain-server',
        name: 'Plain Server',
        type: 'command',
        command: 'run-server',
      },
      configs: [{ id: 'default', name: 'Default', enabled: true }],
    });

    const result = await listDetectedMcpServersForSelections({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [
        { serverId: 'curated-server', configId: 'default' },
        { serverId: 'plain-server', configId: 'default' },
      ],
    });

    expect(result.warnings).toEqual([]);
    expect(result.servers).toHaveLength(2);
    const curated = result.servers.find((s) => s.serverId === 'curated-server');
    const plain = result.servers.find((s) => s.serverId === 'plain-server');
    expect(curated?.curatedKey).toBe('github');
    expect(plain?.curatedKey).toBeUndefined();
  });

  it('distinguishes refreshable access tokens from expired account connections', async () => {
    getMcpOAuthAuthStatusForDefinitionMock.mockResolvedValue({
      status: 'expired',
      canRefresh: true,
    });
    writeMcpServer('refreshable', {
      definition: {
        id: 'refreshable',
        name: 'Refreshable',
        type: 'http',
        url: 'https://api.example.test/mcp',
        oauth: {},
      },
      configs: [{ id: 'default', name: 'Default', enabled: true }],
    });
    const result = await listDetectedMcpServersForSelections({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [{ serverId: 'refreshable', configId: 'default' }],
    });
    expect(result.servers[0]).toMatchObject({
      authStatus: 'expired',
      canRefresh: true,
      authStatusLabel: 'Renews automatically',
      canConnect: false,
    });
  });

  it('does not contact remote servers while reading passive inventory', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer' },
      }),
    );
    probeMcpHttpOAuthRequirementMock.mockImplementationOnce(
      jest.requireActual<typeof OAuthProbeModule>('../mcp/oauth-probe')
        .probeMcpHttpOAuthRequirement,
    );
    writeMcpServer('passive', {
      definition: {
        id: 'passive',
        name: 'Passive',
        type: 'http',
        url: 'https://passive.example.test/mcp',
      },
      configs: [{ id: 'default', name: 'Default', enabled: true }],
    });
    try {
      await listDetectedMcpServersForSelections({
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [{ serverId: 'passive', configId: 'default' }],
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('does not infer OAuth for a plain HTTP server from secure-storage failure', async () => {
    getMcpOAuthAuthStatusForDefinitionMock.mockResolvedValue({
      status: 'error',
      lastError: 'Secure storage unavailable',
    });
    writeMcpServer('plain-storage-error', {
      definition: {
        id: 'plain-storage-error',
        name: 'Plain HTTP',
        type: 'http',
        url: 'https://plain.example.test/mcp',
      },
      configs: [{ id: 'default', name: 'Default', enabled: true }],
    });

    const result = await listDetectedMcpServersForSelections({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [{ serverId: 'plain-storage-error', configId: 'default' }],
    });

    expect(result.servers[0]).toMatchObject({
      authStatus: 'not_configured',
      authStatusLabel: 'No auth',
      canConnect: false,
    });
  });

  it.each(['connected', 'expired', 'error'] as const)(
    'retains stored %s OAuth state without discovery metadata or a warm probe cache',
    async (status) => {
      getMcpOAuthAuthStatusForDefinitionMock.mockResolvedValue({
        status,
        hasStoredToken: true,
        canRefresh: status === 'expired',
        ...(status === 'error'
          ? {
              lastError: 'invalid_grant',
              authErrorRevision: '2026-09-07T04:00:00.000Z',
            }
          : {}),
      });
      writeMcpServer('stored', {
        definition: {
          id: 'stored',
          name: 'Stored',
          type: 'http',
          url: 'https://stored.example.test/mcp',
        },
        configs: [{ id: 'default', name: 'Default', enabled: true }],
      });
      writeMarketplacePlugin('demo-market', 'stored-plugin', {
        remote: { type: 'http', url: 'https://stored-plugin.example.test/mcp' },
      });
      const result = await listDetectedMcpServersForSelections({
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [
          { marketplaceId: 'demo-market', pluginName: 'stored-plugin' },
        ],
        mcpServerRefs: [{ serverId: 'stored', configId: 'default' }],
      });
      expect(result.servers).toHaveLength(2);
      for (const server of result.servers) {
        expect(server).toMatchObject({
          authStatus: status,
          canConnect: status === 'error',
        });
        if (status === 'error') {
          expect(server).toMatchObject({
            connectLabel: 'Reconnect',
            authErrorRevision: '2026-09-07T04:00:00.000Z',
          });
        }
      }
    },
  );

  it('uses the configured bearer token when OAuth metadata is also present', async () => {
    writeMcpServer('static-token', {
      definition: {
        id: 'static-token',
        name: 'Static token',
        type: 'http',
        url: 'https://api.example.test/mcp',
        oauth: {},
      },
      configs: [
        {
          id: 'default',
          name: 'Default',
          enabled: true,
          authToken: 'configured-token',
        },
      ],
    });
    const result = await listDetectedMcpServersForSelections({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [{ serverId: 'static-token', configId: 'default' }],
    });
    expect(result.servers[0]).toMatchObject({
      authStatus: 'connected',
      authStatusLabel: 'Bearer token',
    });
    expect(getMcpOAuthAuthStatusForDefinitionMock).not.toHaveBeenCalled();
  });

  it('does not ask connected OAuth accounts to reconnect', async () => {
    getMcpOAuthAuthStatusForDefinitionMock.mockResolvedValue({
      status: 'connected',
    });
    writeMcpServer('server-connected', {
      definition: {
        id: 'server-connected',
        name: 'Connected Server',
        description: '',
        type: 'http',
        url: 'https://api.example.test/mcp',
        oauth: {
          clientId: 'client',
          authorizationUrl: 'https://auth.example.test/authorize',
          tokenUrl: 'https://auth.example.test/token',
        },
      },
      configs: [
        {
          id: 'default',
          name: 'Default',
          enabled: true,
        },
      ],
    });

    const result = await listDetectedMcpServersForSelections({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [{ serverId: 'server-connected', configId: 'default' }],
    });

    expect(result.servers[0]).toMatchObject({
      authStatus: 'connected',
      authStatusLabel: 'Connected',
      canConnect: false,
    });
  });

  it('emits Collection-sourced MCP refs with collection source metadata', async () => {
    writeMcpServer('server-collection', {
      definition: {
        id: 'server-collection',
        name: 'Collection Server',
        description: 'From a Collection',
        type: 'http',
        url: 'https://api.example.test/mcp',
      },
      configs: [
        {
          id: 'default',
          name: 'Default',
          enabled: true,
          authToken: undefined,
        },
      ],
    });
    writeCollection('collection-1', [
      { serverId: 'server-collection', configId: 'default' },
    ]);

    const result = await listDetectedMcpServersForSelections({
      collectionIds: ['collection-1'],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    });

    expect(result.warnings).toEqual([]);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]).toMatchObject({
      source: 'collection',
      collectionId: 'collection-1',
      bundleId: 'collection-1',
      serverId: 'server-collection',
      configId: 'default',
      displayName: 'Collection Server',
    });
  });

  it('resolves Collection MCP refs from a legacy bundleIds-only selection', async () => {
    writeMcpServer('server-legacy-collection', {
      definition: {
        id: 'server-legacy-collection',
        name: 'Legacy Collection Server',
        description: 'From a legacy Collection selection',
        type: 'http',
        url: 'https://api.example.test/mcp',
      },
      configs: [
        {
          id: 'default',
          name: 'Default',
          enabled: true,
          authToken: undefined,
        },
      ],
    });
    writeCollection('legacy-collection', [
      { serverId: 'server-legacy-collection', configId: 'default' },
    ]);

    const result = await listDetectedMcpServersForSelections({
      collectionIds: [],
      bundleIds: ['legacy-collection'],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    });

    expect(result.warnings).toEqual([]);
    expect(result.servers).toEqual([
      expect.objectContaining({
        source: 'collection',
        collectionId: 'legacy-collection',
        serverId: 'server-legacy-collection',
      }),
    ]);
  });

  it('lists plugin-declared MCP servers and exposes OAuth-capable servers', async () => {
    const marketplaceDir = path.join(tempDir, 'marketplaces', 'demo-market');
    const pluginDir = path.join(marketplaceDir, 'demo-plugin');
    fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'demo-plugin', mcpServers: './mcp.json' }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(pluginDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          remote: {
            type: 'http',
            url: 'https://plugin.example.test/mcp',
            bearer_token_env_var: 'PLUGIN_TOKEN',
          },
          oauthRemote: {
            type: 'http',
            url: 'https://oauth.example.test/mcp',
            bearer_token_env_var: 'PLUGIN_TOKEN',
            oauth: { authorizationUrl: 'https://auth.example.test' },
          },
        },
      }),
      'utf8',
    );
    process.env.PLUGIN_TOKEN = 'plugin-token';
    loadMarketplacesMock.mockReturnValue({
      success: true,
      data: {
        version: 1,
        lastRefreshed: '2026-04-29T00:00:00.000Z',
        marketplaces: [
          {
            id: 'demo-market',
            name: 'Demo',
            description: '',
            sourceType: 'local',
            sourceUrl: '',
            installLocation: marketplaceDir,
            lastUpdated: '2026-04-29T00:00:00.000Z',
            pluginCount: 1,
            plugins: [
              {
                name: 'demo-plugin',
                description: '',
                version: '1.0.0',
                author: '',
                category: '',
                homepage: '',
                sourcePath: 'demo-plugin',
                marketplaceId: 'demo-market',
                details: null,
                externalSource: null,
                cachePath: null,
                cachedAt: null,
              },
            ],
          },
        ],
      },
    });

    const result = await listDetectedMcpServersForSelections({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'demo-market', pluginName: 'demo-plugin' }],
      mcpServerRefs: [],
    });

    expect(result.servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'plugin',
          pluginServerName: 'remote',
          authStatus: 'not_configured',
          authStatusLabel: 'Configured by plugin',
          canConnect: false,
        }),
        expect.objectContaining({
          source: 'plugin',
          pluginServerName: 'oauthRemote',
          authStatus: 'not_connected',
          authStatusLabel: 'Needs auth',
          canConnect: true,
          connectLabel: 'Connect',
        }),
      ]),
    );
    expect(probeMcpHttpOAuthRequirementMock).not.toHaveBeenCalled();
  });

  it('uses cached OAuth requirements for plain plugin HTTP MCP servers', async () => {
    const marketplaceDir = path.join(tempDir, 'marketplaces', 'demo-market');
    const pluginDir = path.join(marketplaceDir, 'auth-plugin');
    fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'auth-plugin', mcpServers: './mcp.json' }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(pluginDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          remote: {
            type: 'http',
            url: 'https://plugin.example.test/mcp',
            headers: {},
          },
        },
      }),
      'utf8',
    );
    loadMarketplacesMock.mockReturnValue({
      success: true,
      data: {
        version: 1,
        lastRefreshed: '2026-04-29T00:00:00.000Z',
        marketplaces: [
          {
            id: 'demo-market',
            name: 'Demo',
            description: '',
            sourceType: 'local',
            sourceUrl: '',
            installLocation: marketplaceDir,
            lastUpdated: '2026-04-29T00:00:00.000Z',
            pluginCount: 1,
            plugins: [
              {
                name: 'auth-plugin',
                description: '',
                version: '1.0.0',
                author: '',
                category: '',
                homepage: '',
                sourcePath: 'auth-plugin',
                marketplaceId: 'demo-market',
                details: null,
                externalSource: null,
                cachePath: null,
                cachedAt: null,
              },
            ],
          },
        ],
      },
    });
    probeMcpHttpOAuthRequirementMock.mockResolvedValueOnce({
      requirement: 'oauth',
      requiresOAuth: true,
      challenge: {},
    });

    const result = await listDetectedMcpServersForSelections({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'demo-market', pluginName: 'auth-plugin' }],
      mcpServerRefs: [],
    });

    expect(probeMcpHttpOAuthRequirementMock).toHaveBeenCalledWith(
      'https://plugin.example.test/mcp',
      {},
      undefined,
      { cacheOnly: true },
    );
    expect(result.servers).toEqual([
      expect.objectContaining({
        source: 'plugin',
        pluginServerName: 'remote',
        authStatus: 'not_connected',
        authStatusLabel: 'Needs auth',
        canConnect: true,
        connectLabel: 'Connect',
      }),
    ]);
  });

  it('keeps plain plugin HTTP MCP servers unconnected when OAuth probe is false', async () => {
    writeMarketplacePlugin('demo-market', 'plain-plugin', {
      remote: {
        type: 'http',
        url: 'https://plugin.example.test/mcp',
        headers: {},
      },
    });

    const result = await listDetectedMcpServersForSelections({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [
        { marketplaceId: 'demo-market', pluginName: 'plain-plugin' },
      ],
      mcpServerRefs: [],
    });

    expect(probeMcpHttpOAuthRequirementMock).toHaveBeenCalledWith(
      'https://plugin.example.test/mcp',
      {},
      undefined,
      { cacheOnly: true },
    );
    expect(result.servers).toEqual([
      expect.objectContaining({
        source: 'plugin',
        pluginServerName: 'remote',
        authStatus: 'not_configured',
        authStatusLabel: 'No auth',
        canConnect: false,
      }),
    ]);
  });

  it('ignores failed OAuth probes for plain plugin HTTP MCP servers', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    writeMarketplacePlugin('demo-market', 'plain-plugin', {
      remote: {
        type: 'http',
        url: 'https://plugin.example.test/mcp',
        headers: {},
      },
    });
    probeMcpHttpOAuthRequirementMock.mockRejectedValueOnce(
      new Error('probe failed'),
    );

    const result = await listDetectedMcpServersForSelections({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [
        { marketplaceId: 'demo-market', pluginName: 'plain-plugin' },
      ],
      mcpServerRefs: [],
    });

    expect(probeMcpHttpOAuthRequirementMock).toHaveBeenCalledWith(
      'https://plugin.example.test/mcp',
      {},
      undefined,
      { cacheOnly: true },
    );
    expect(result.servers).toEqual([
      expect.objectContaining({
        source: 'plugin',
        pluginServerName: 'remote',
        authStatus: 'not_configured',
        authStatusLabel: 'Not checked',
        canConnect: false,
      }),
    ]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Failed to read cached HTTP MCP OAuth requirement',
      ),
      {
        source: 'plugin',
        marketplaceId: 'demo-market',
        pluginName: 'plain-plugin',
        serverName: 'remote',
        errorName: 'Error',
      },
    );
    warnSpy.mockRestore();
  });

  it('reports missing plugin auth for managed non-OAuth plugin servers', async () => {
    writeMarketplacePlugin('demo-market', 'managed-plugin', {
      remote: {
        type: 'http',
        url: 'https://plugin.example.test/mcp',
        bearer_token_env_var: 'MISSING_PLUGIN_TOKEN',
      },
    });

    const result = await listDetectedMcpServersForSelections({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [
        { marketplaceId: 'demo-market', pluginName: 'managed-plugin' },
      ],
      mcpServerRefs: [],
    });

    expect(result.servers).toEqual([
      expect.objectContaining({
        source: 'plugin',
        pluginServerName: 'remote',
        authStatus: 'error',
        authStatusLabel: 'Missing plugin auth',
        canConnect: false,
      }),
    ]);
  });

  it('exposes OAuth-declared plugin servers even when managed auth env is missing', async () => {
    writeMarketplacePlugin('demo-market', 'oauth-managed-plugin', {
      remote: {
        type: 'http',
        url: 'https://plugin.example.test/mcp',
        bearer_token_env_var: 'MISSING_PLUGIN_TOKEN',
        oauth: { authorizationUrl: 'https://auth.example.test' },
      },
    });

    const result = await listDetectedMcpServersForSelections({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [
        { marketplaceId: 'demo-market', pluginName: 'oauth-managed-plugin' },
      ],
      mcpServerRefs: [],
    });

    expect(result.servers).toEqual([
      expect.objectContaining({
        source: 'plugin',
        pluginServerName: 'remote',
        authStatus: 'not_connected',
        authStatusLabel: 'Needs auth',
        canConnect: true,
        connectLabel: 'Connect',
      }),
    ]);
    expect(probeMcpHttpOAuthRequirementMock).not.toHaveBeenCalled();
  });

  it('continues listing standalone HTTP MCP servers when OAuth probing fails', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    writeMcpServer('server-probe-fails', {
      definition: {
        id: 'server-probe-fails',
        name: 'Probe Fails',
        description: 'Still listed',
        type: 'http',
        url: 'https://token@example.test/mcp?api_key=secret',
      },
      configs: [
        {
          id: 'default',
          name: 'Default',
          enabled: true,
          authToken: undefined,
        },
      ],
    });
    probeMcpHttpOAuthRequirementMock.mockRejectedValueOnce(
      new Error('network failure with secret detail'),
    );

    const result = await listDetectedMcpServersForSelections({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [{ serverId: 'server-probe-fails', configId: 'default' }],
    });

    expect(result.servers).toEqual([
      expect.objectContaining({
        source: 'standalone',
        serverId: 'server-probe-fails',
        authStatus: 'not_configured',
        authStatusLabel: 'Not checked',
        canConnect: false,
      }),
    ]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Failed to read cached HTTP MCP OAuth requirement',
      ),
      {
        source: 'standalone',
        serverId: 'server-probe-fails',
        configId: 'default',
        errorName: 'Error',
      },
    );
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('secret');
    warnSpy.mockRestore();
  });

  it('continues listing plugin HTTP MCP servers when OAuth probing fails', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const marketplaceDir = path.join(tempDir, 'marketplaces', 'demo-market');
    const pluginDir = path.join(marketplaceDir, 'probe-fail-plugin');
    fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'probe-fail-plugin', mcpServers: './mcp.json' }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(pluginDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          remote: {
            type: 'http',
            url: 'https://token@example.test/mcp?api_key=secret',
            headers: {
              'X-Trace': 'secret',
            },
          },
        },
      }),
      'utf8',
    );
    loadMarketplacesMock.mockReturnValue({
      success: true,
      data: {
        version: 1,
        lastRefreshed: '2026-04-29T00:00:00.000Z',
        marketplaces: [
          {
            id: 'demo-market',
            name: 'Demo',
            description: '',
            sourceType: 'local',
            sourceUrl: '',
            installLocation: marketplaceDir,
            lastUpdated: '2026-04-29T00:00:00.000Z',
            pluginCount: 1,
            plugins: [
              {
                name: 'probe-fail-plugin',
                description: '',
                version: '1.0.0',
                author: '',
                category: '',
                homepage: '',
                sourcePath: 'probe-fail-plugin',
                marketplaceId: 'demo-market',
                details: null,
                externalSource: null,
                cachePath: null,
                cachedAt: null,
              },
            ],
          },
        ],
      },
    });
    probeMcpHttpOAuthRequirementMock.mockRejectedValueOnce(
      new Error('network failure with secret detail'),
    );

    const result = await listDetectedMcpServersForSelections({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [
        { marketplaceId: 'demo-market', pluginName: 'probe-fail-plugin' },
      ],
      mcpServerRefs: [],
    });

    expect(result.servers).toEqual([
      expect.objectContaining({
        source: 'plugin',
        pluginName: 'probe-fail-plugin',
        pluginServerName: 'remote',
        authStatus: 'not_configured',
        authStatusLabel: 'Not checked',
        canConnect: false,
      }),
    ]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Failed to read cached HTTP MCP OAuth requirement',
      ),
      {
        source: 'plugin',
        marketplaceId: 'demo-market',
        pluginName: 'probe-fail-plugin',
        serverName: 'remote',
        errorName: 'Error',
      },
    );
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('secret');
    warnSpy.mockRestore();
  });

  it('lists plugin-declared MCP servers selected through bundles', async () => {
    const marketplaceDir = path.join(tempDir, 'marketplaces', 'demo-market');
    const pluginDir = path.join(marketplaceDir, 'bundle-plugin');
    fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'bundle-plugin', mcpServers: './mcp.json' }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(pluginDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          bundledRemote: {
            type: 'http',
            url: 'https://plugin.example.test/mcp',
          },
        },
      }),
      'utf8',
    );
    writeBundle(
      'bundle-plugins',
      [],
      [{ marketplaceId: 'demo-market', pluginName: 'bundle-plugin' }],
    );
    loadMarketplacesMock.mockReturnValue({
      success: true,
      data: {
        version: 1,
        lastRefreshed: '2026-04-29T00:00:00.000Z',
        marketplaces: [
          {
            id: 'demo-market',
            name: 'Demo',
            description: '',
            sourceType: 'local',
            sourceUrl: '',
            installLocation: marketplaceDir,
            lastUpdated: '2026-04-29T00:00:00.000Z',
            pluginCount: 1,
            plugins: [
              {
                name: 'bundle-plugin',
                description: '',
                version: '1.0.0',
                author: '',
                category: '',
                homepage: '',
                sourcePath: 'bundle-plugin',
                marketplaceId: 'demo-market',
                details: null,
                externalSource: null,
                cachePath: null,
                cachedAt: null,
              },
            ],
          },
        ],
      },
    });

    const result = await listDetectedMcpServersForSelections({
      collectionIds: ['bundle-plugins'],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    });

    expect(result.warnings).toEqual([]);
    expect(result.servers).toEqual([
      expect.objectContaining({
        source: 'plugin',
        pluginName: 'bundle-plugin',
        pluginServerName: 'bundledRemote',
        authStatus: 'not_configured',
        canConnect: false,
      }),
    ]);
  });

  it('resolves standalone handler precedence as chat override, server, then global', async () => {
    writeMcpServer('handler-server', {
      definition: {
        id: 'handler-server',
        name: 'Handler Server',
        type: 'http',
        url: 'https://mcp.example.test',
        oauth: { usePkce: true },
        httpAuthHandler: 'provider',
      },
      configs: [{ id: 'default', name: 'Default', enabled: true }],
    });
    const baseSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [{ serverId: 'handler-server', configId: 'default' }],
    };

    const serverDefault =
      await listDetectedMcpServersForSelections(baseSelections);
    expect(serverDefault.servers[0]).toMatchObject({
      httpAuthHandler: 'provider',
      httpAuthHandlerSource: 'server',
      authStatusLabel: 'Agent provider',
    });
    expect(getMcpOAuthAuthStatusForDefinitionMock).not.toHaveBeenCalled();

    const overridden = await listDetectedMcpServersForSelections({
      ...baseSelections,
      mcpHttpAuthPreferences: [
        {
          target: {
            kind: 'standalone',
            serverId: 'handler-server',
            configId: 'default',
          },
          handler: 'canopy',
        },
      ],
    });
    expect(overridden.servers[0]).toMatchObject({
      httpAuthHandler: 'canopy',
      httpAuthHandlerSource: 'override',
    });
    expect(getMcpOAuthAuthStatusForDefinitionMock).toHaveBeenCalled();

    writeMcpServer('global-server', {
      definition: {
        id: 'global-server',
        name: 'Global Server',
        type: 'http',
        url: 'https://mcp.example.test',
        oauth: { usePkce: true },
      },
      configs: [{ id: 'default', name: 'Default', enabled: true }],
    });
    const globalDefault = await listDetectedMcpServersForSelections({
      ...baseSelections,
      mcpServerRefs: [{ serverId: 'global-server', configId: 'default' }],
    });
    expect(globalDefault.servers[0]).toMatchObject({
      httpAuthHandler: 'canopy',
      httpAuthHandlerSource: 'default',
    });
  });

  it('includes native Codex MCP declarations beside Claude and shares only equivalent connections', async () => {
    const shared = {
      type: 'http',
      url: 'https://shared.example.test/mcp',
      oauth: { clientId: 'shared' },
    };
    writeMarketplacePlugin('dual-market', 'dual-plugin', {
      shared,
      collision: {
        type: 'http',
        url: 'https://claude.example.test/mcp',
        oauth: { clientId: 'claude' },
      },
    });
    const cache = await loadMarketplacesMock();
    if (!cache.success || !cache.data) throw new Error('Missing fixture cache');
    const marketplace = cache.data.marketplaces[0];
    const plugin = marketplace.plugins[0];
    const codexPath = path.join(tempDir, 'codex-plugin');
    fs.mkdirSync(path.join(codexPath, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(codexPath, '.codex-plugin', 'plugin.json'),
      JSON.stringify({ name: plugin.name, mcpServers: './codex-mcp.json' }),
    );
    fs.writeFileSync(
      path.join(codexPath, 'codex-mcp.json'),
      JSON.stringify({
        mcpServers: {
          shared,
          codexOnly: {
            type: 'http',
            url: 'https://codex-only.example.test/mcp',
            oauth: { clientId: 'codex' },
          },
          collision: {
            type: 'http',
            url: 'https://codex.example.test/mcp',
            oauth: { clientId: 'codex' },
          },
        },
      }),
    );
    plugin.facets = {
      claude: {
        provider: 'claude',
        mode: 'native',
        name: plugin.name,
        sourcePath: plugin.sourcePath,
      },
      codex: {
        provider: 'codex',
        mode: 'native',
        name: plugin.name,
        installLocation: codexPath,
      },
    };
    const result = await listDetectedMcpServersForSelections({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [{ marketplaceId: marketplace.id, pluginName: plugin.name }],
    });
    expect(result.warnings).toEqual([]);
    expect(result.servers.map((server) => server.url).sort()).toEqual(
      [
        'https://claude.example.test/mcp',
        'https://codex-only.example.test/mcp',
        'https://codex.example.test/mcp',
        'https://shared.example.test/mcp',
      ].sort(),
    );
    const codex = result.servers.find(
      (server) => server.pluginServerName === 'codexOnly',
    );
    expect(codex).toMatchObject({ pluginProvider: 'codex', canConnect: true });
    const definitions = getMcpOAuthAuthStatusForDefinitionMock.mock.calls.map(
      ([definition]) => definition,
    );
    const collisions = definitions.filter(
      (definition) => definition.name === 'collision',
    );
    expect(new Set(collisions.map((definition) => definition.id)).size).toBe(2);
  });

  describe('curated plugin member binding', (): void => {
    const CURATED_MARKETPLACE_ID = 'curated/cloud';
    const linear: AccountMcpConnection = {
      id: 'conn-default',
      serverKey: 'linear',
      configId: 'default',
      displayName: 'Linear',
      status: 'CONNECTED',
      routeId: 'route',
      enabledTools: null,
      kind: 'CURATED',
    };
    const member = {
      type: 'http',
      url: 'https://mcp.linear.app/mcp',
      curated: { key: 'linear' },
    };
    const pluginRefs = [
      { marketplaceId: CURATED_MARKETPLACE_ID, pluginName: 'linear' },
    ];

    function enableAccountConnections(
      connections: AccountMcpConnection[],
    ): () => void {
      const service = getFeatureFlagService();
      const isEnabled = jest.spyOn(service, 'isEnabled').mockReturnValue(true);
      jest.mocked(getFeatureFlagService).mockReturnValue(service);
      jest.mocked(listAccountMcpConnections).mockResolvedValue(connections);
      jest
        .mocked(findAccountMcpConnection)
        .mockImplementation(({ accountConnectionId, curatedKey }) =>
          Promise.resolve(
            connections.find(
              (row) =>
                row.id === accountConnectionId ||
                (accountConnectionId === undefined &&
                  row.serverKey === curatedKey),
            ),
          ),
        );
      return (): void => isEnabled.mockRestore();
    }

    function writeDeviceLinear(): void {
      writeMcpServer('linear-device', {
        definition: {
          id: 'linear-device',
          name: 'Linear Device',
          type: 'http',
          url: 'https://mcp.linear.app/mcp',
          oauth: { usePkce: true },
          curated: { key: 'linear' },
        },
        configs: [{ id: 'default', name: 'Default', enabled: true }],
      });
      const indexPath = path.join(tempDir, 'mcp', 'index.json');
      fs.writeFileSync(
        indexPath,
        JSON.stringify({
          version: 1,
          servers: [
            {
              id: 'linear-device',
              name: 'Linear Device',
              description: '',
              type: 'http',
              curatedKey: 'linear',
              configs: [{ id: 'default', name: 'Default', enabled: true }],
              updatedAt: '2026-10-01T00:00:00.000Z',
            },
          ],
        }),
        'utf8',
      );
      jest.mocked(getMcpServersIndexFilePath).mockReturnValue(indexPath);
    }

    beforeEach((): void => {
      jest.mocked(getMcpServersIndexFilePath).mockReturnValue(undefined);
      jest
        .mocked(readCachedCuratedMcpDesktopOnlyKeys)
        .mockResolvedValue(new Set());
    });

    describe('desktop-only key (REG-3035)', (): void => {
      beforeEach((): void => {
        jest
          .mocked(readCachedCuratedMcpDesktopOnlyKeys)
          .mockResolvedValue(new Set(['linear']));
      });

      it.each([
        'CONNECTED',
        'REAUTH_REQUIRED',
        'PENDING',
        'DISCONNECTED',
      ] as const)(
        'projects the device server over a leftover %s account connection',
        async (status): Promise<void> => {
          writeMarketplacePlugin(CURATED_MARKETPLACE_ID, 'linear', {
            linear: member,
          });
          writeDeviceLinear();
          const restore = enableAccountConnections([{ ...linear, status }]);
          try {
            const result = await listDetectedMcpServersForSelections({
              collectionIds: [],
              skillRefs: [],
              pluginRefs,
              mcpServerRefs: [],
            });
            expect(result.servers).toEqual([
              expect.objectContaining({
                source: 'plugin',
                pluginName: 'linear',
                serverId: 'linear-device',
                configId: 'default',
                curatedKey: 'linear',
                httpAuthHandler: 'canopy',
                canConnect: true,
              }),
            ]);
            expect(result.servers[0]).not.toHaveProperty('accountConnectionId');
            expect(result.servers[0]?.scope).not.toBe('account');
            expect(result.warnings).toEqual([]);
          } finally {
            restore();
          }
        },
      );

      it('projects the device server when the account list cannot be read', async (): Promise<void> => {
        writeMarketplacePlugin(CURATED_MARKETPLACE_ID, 'linear', {
          linear: member,
        });
        writeDeviceLinear();
        const restore = enableAccountConnections([]);
        jest
          .mocked(listAccountMcpConnections)
          .mockRejectedValue(new Error('offline'));
        try {
          const result = await listDetectedMcpServersForSelections({
            collectionIds: [],
            skillRefs: [],
            pluginRefs,
            mcpServerRefs: [],
          });
          expect(result.servers).toEqual([
            expect.objectContaining({ serverId: 'linear-device' }),
          ]);
          expect(result.warnings).toEqual([]);
        } finally {
          restore();
        }
      });

      it('leaves a member unbound when only a leftover connected account connection exists', async (): Promise<void> => {
        writeMarketplacePlugin(CURATED_MARKETPLACE_ID, 'linear', {
          linear: member,
        });
        const restore = enableAccountConnections([linear]);
        try {
          const result = await listDetectedMcpServersForSelections({
            collectionIds: [],
            skillRefs: [],
            pluginRefs,
            mcpServerRefs: [],
          });
          expect(result.servers).toEqual([
            expect.objectContaining({
              source: 'plugin',
              curatedKey: 'linear',
              authStatus: 'not_connected',
              authStatusLabel: CURATED_PLUGIN_MCP_CONNECT_LABEL,
              canConnect: false,
            }),
          ]);
          expect(result.servers[0]).not.toHaveProperty('accountConnectionId');
        } finally {
          restore();
        }
      });
    });

    it('projects a member bound to the connected account as that connection', async (): Promise<void> => {
      writeMarketplacePlugin(CURATED_MARKETPLACE_ID, 'linear', {
        linear: member,
      });
      const restore = enableAccountConnections([linear]);
      try {
        const result = await listDetectedMcpServersForSelections({
          collectionIds: [],
          skillRefs: [],
          pluginRefs,
          mcpServerRefs: [],
        });
        expect(result.servers).toEqual([
          expect.objectContaining({
            source: 'plugin',
            marketplaceId: CURATED_MARKETPLACE_ID,
            pluginName: 'linear',
            pluginServerName: 'linear',
            scope: 'account',
            accountConnectionId: 'conn-default',
            curatedKey: 'linear',
            httpAuthHandler: 'account',
            httpAuthHandlerSource: 'default',
            canopyProxyEnabled: false,
            authStatus: 'connected',
            authStatusLabel: 'Connected',
            canConnect: false,
          }),
        ]);
        expect(probeMcpHttpOAuthRequirementMock).not.toHaveBeenCalled();
        expect(getMcpOAuthAuthStatusForDefinitionMock).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it('projects a member bound to the device server by that server and its auth', async (): Promise<void> => {
      writeMarketplacePlugin(CURATED_MARKETPLACE_ID, 'linear', {
        linear: member,
      });
      writeDeviceLinear();

      const result = await listDetectedMcpServersForSelections({
        collectionIds: [],
        skillRefs: [],
        pluginRefs,
        mcpServerRefs: [],
      });

      expect(result.servers).toEqual([
        expect.objectContaining({
          key: `plugin:${CURATED_MARKETPLACE_ID}:linear:linear`,
          source: 'plugin',
          marketplaceId: CURATED_MARKETPLACE_ID,
          pluginName: 'linear',
          pluginServerName: 'linear',
          serverId: 'linear-device',
          configId: 'default',
          configName: 'Default',
          curatedKey: 'linear',
          httpAuthHandler: 'canopy',
          canopyProxyEnabled: true,
          authStatus: 'not_connected',
          canConnect: true,
          connectLabel: 'Connect',
        }),
      ]);
      expect(getMcpOAuthAuthStatusForDefinitionMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'linear-device' }),
        expect.objectContaining({ id: 'default' }),
      );
    });

    it('projects a non-connected account connection as reconnect and never falls through to the device server', async (): Promise<void> => {
      writeMarketplacePlugin(CURATED_MARKETPLACE_ID, 'linear', {
        linear: member,
      });
      writeDeviceLinear();
      const restore = enableAccountConnections([
        { ...linear, status: 'REAUTH_REQUIRED' },
      ]);
      try {
        const result = await listDetectedMcpServersForSelections({
          collectionIds: [],
          skillRefs: [],
          pluginRefs,
          mcpServerRefs: [],
        });
        expect(result.servers).toEqual([
          expect.objectContaining({
            source: 'plugin',
            scope: 'account',
            accountConnectionId: 'conn-default',
            curatedKey: 'linear',
            httpAuthHandler: 'account',
            authStatus: 'error',
            authStatusLabel: 'Reconnect in cloud',
            canConnect: false,
          }),
        ]);
        expect(result.servers[0]).not.toHaveProperty('serverId');
        expect(getMcpOAuthAuthStatusForDefinitionMock).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it('fails closed when the account connection list cannot be read, even with a device server', async (): Promise<void> => {
      writeMarketplacePlugin(CURATED_MARKETPLACE_ID, 'linear', {
        linear: member,
      });
      writeDeviceLinear();
      const restore = enableAccountConnections([]);
      jest
        .mocked(listAccountMcpConnections)
        .mockRejectedValue(new Error('offline'));
      try {
        const result = await listDetectedMcpServersForSelections({
          collectionIds: [],
          skillRefs: [],
          pluginRefs,
          mcpServerRefs: [],
        });
        expect(result.servers).toEqual([
          expect.objectContaining({
            source: 'plugin',
            curatedKey: 'linear',
            canopyProxyEnabled: false,
            authStatus: 'not_connected',
            authStatusLabel: CURATED_PLUGIN_MCP_CONNECT_LABEL,
            canConnect: false,
          }),
        ]);
        expect(result.servers[0]).not.toHaveProperty('serverId');
        expect(result.servers[0]).not.toHaveProperty('accountConnectionId');
        expect(result.warnings).toEqual([
          'Account MCP server "linear/linear" skipped: the account connection list could not be read.',
        ]);
        expect(getMcpOAuthAuthStatusForDefinitionMock).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it('fails closed on an ambiguous curated-key match, even with a device server', async (): Promise<void> => {
      writeMarketplacePlugin(CURATED_MARKETPLACE_ID, 'linear', {
        linear: member,
      });
      writeDeviceLinear();
      const restore = enableAccountConnections([
        { ...linear, id: 'conn-personal', configId: 'personal' },
        { ...linear, id: 'conn-work', configId: 'work' },
      ]);
      try {
        const result = await listDetectedMcpServersForSelections({
          collectionIds: [],
          skillRefs: [],
          pluginRefs,
          mcpServerRefs: [],
        });
        expect(result.servers).toEqual([
          expect.objectContaining({
            source: 'plugin',
            curatedKey: 'linear',
            canopyProxyEnabled: false,
            authStatus: 'not_connected',
            authStatusLabel: CURATED_PLUGIN_MCP_CONNECT_LABEL,
            canConnect: false,
          }),
        ]);
        expect(result.servers[0]).not.toHaveProperty('serverId');
        expect(result.servers[0]).not.toHaveProperty('accountConnectionId');
        expect(result.warnings).toEqual([
          'Account MCP server "linear/linear" skipped: Account MCP connection missing or ambiguous.',
        ]);
        expect(getMcpOAuthAuthStatusForDefinitionMock).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it('projects an unbound member as not connected and points at the card', async (): Promise<void> => {
      writeMarketplacePlugin(CURATED_MARKETPLACE_ID, 'linear', {
        linear: member,
      });

      const result = await listDetectedMcpServersForSelections({
        collectionIds: [],
        skillRefs: [],
        pluginRefs,
        mcpServerRefs: [],
      });

      expect(result.servers).toEqual([
        expect.objectContaining({
          source: 'plugin',
          pluginServerName: 'linear',
          curatedKey: 'linear',
          canopyProxyEnabled: false,
          canToggleCanopyProxy: true,
          authStatus: 'not_connected',
          authStatusLabel: CURATED_PLUGIN_MCP_CONNECT_LABEL,
          canConnect: false,
        }),
      ]);
      expect(result.servers[0]).not.toHaveProperty('accountConnectionId');
      expect(result.servers[0]).not.toHaveProperty('scope');
      expect(probeMcpHttpOAuthRequirementMock).not.toHaveBeenCalled();
      expect(getMcpOAuthAuthStatusForDefinitionMock).not.toHaveBeenCalled();
    });

    it('keeps the local projection for an explicit canopy override', async (): Promise<void> => {
      writeMarketplacePlugin(CURATED_MARKETPLACE_ID, 'linear', {
        linear: member,
      });
      const restore = enableAccountConnections([linear]);
      try {
        const result = await listDetectedMcpServersForSelections({
          collectionIds: [],
          skillRefs: [],
          pluginRefs,
          mcpServerRefs: [],
          mcpHttpAuthPreferences: [
            {
              target: {
                kind: 'plugin',
                marketplaceId: CURATED_MARKETPLACE_ID,
                pluginName: 'linear',
                serverName: 'linear',
              },
              handler: 'canopy',
            },
          ],
        });
        expect(result.servers).toEqual([
          expect.objectContaining({
            source: 'plugin',
            httpAuthHandler: 'canopy',
            httpAuthHandlerSource: 'override',
            canopyProxyEnabled: true,
          }),
        ]);
        expect(result.servers[0]).not.toHaveProperty('accountConnectionId');
      } finally {
        restore();
      }
    });

    it('leaves a plugin from another marketplace on its own path', async (): Promise<void> => {
      writeMarketplacePlugin('third-party', 'linear', { linear: member });
      const restore = enableAccountConnections([linear]);
      try {
        const result = await listDetectedMcpServersForSelections({
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [{ marketplaceId: 'third-party', pluginName: 'linear' }],
          mcpServerRefs: [],
        });
        expect(result.servers).toEqual([
          expect.objectContaining({
            source: 'plugin',
            marketplaceId: 'third-party',
            httpAuthHandler: 'canopy',
            canopyProxyEnabled: true,
          }),
        ]);
        expect(result.servers[0]).not.toHaveProperty('accountConnectionId');
        expect(result.servers[0]).not.toHaveProperty('curatedKey');
      } finally {
        restore();
      }
    });
  });

  function writeMarketplacePlugin(
    marketplaceId: string,
    pluginName: string,
    mcpServers: Record<string, Record<string, unknown>>,
  ): void {
    const marketplaceDir = path.join(tempDir, 'marketplaces', marketplaceId);
    const pluginDir = path.join(marketplaceDir, pluginName);
    fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: pluginName, mcpServers: './mcp.json' }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(pluginDir, 'mcp.json'),
      JSON.stringify({ mcpServers }),
      'utf8',
    );
    loadMarketplacesMock.mockReturnValue({
      success: true,
      data: {
        version: 1,
        lastRefreshed: '2026-04-29T00:00:00.000Z',
        marketplaces: [
          {
            id: marketplaceId,
            name: 'Demo',
            description: '',
            sourceType: 'local',
            sourceUrl: '',
            installLocation: marketplaceDir,
            lastUpdated: '2026-04-29T00:00:00.000Z',
            pluginCount: 1,
            plugins: [
              {
                name: pluginName,
                description: '',
                version: '1.0.0',
                author: '',
                category: '',
                homepage: '',
                sourcePath: pluginName,
                marketplaceId,
                details: null,
                externalSource: null,
                cachePath: null,
                cachedAt: null,
              },
            ],
          },
        ],
      },
    });
  }

  function writeMcpServer(
    serverId: string,
    input: {
      definition: Record<string, unknown>;
      configs: Array<Record<string, unknown>>;
    },
  ): void {
    const serverPath = path.join(tempDir, 'mcp', `${serverId}.json`);
    fs.mkdirSync(path.dirname(serverPath), { recursive: true });
    fs.writeFileSync(
      serverPath,
      JSON.stringify({
        version: 1,
        server: {
          definition: {
            description: '',
            createdAt: '2026-04-29T00:00:00.000Z',
            updatedAt: '2026-04-29T00:00:00.000Z',
            ...input.definition,
          },
          configs: input.configs.map((config) => ({
            description: '',
            envVars: {},
            extraArgs: [],
            extraHeaders: {},
            createdAt: '2026-04-29T00:00:00.000Z',
            updatedAt: '2026-04-29T00:00:00.000Z',
            ...config,
          })),
        },
      }),
      'utf8',
    );
  }

  function writeBundle(
    bundleId: string,
    mcpServers: Array<{ serverId: string; configId: string }>,
    plugins: Array<{ marketplaceId: string; pluginName: string }> = [],
  ): void {
    const bundlePath = path.join(tempDir, 'bundles', `bundle-${bundleId}.json`);
    fs.mkdirSync(path.dirname(bundlePath), { recursive: true });
    fs.writeFileSync(
      bundlePath,
      JSON.stringify({
        version: 1,
        bundle: {
          id: bundleId,
          name: bundleId,
          description: '',
          skills: [],
          plugins,
          mcpServers,
          createdAt: '2026-04-29T00:00:00.000Z',
          updatedAt: '2026-04-29T00:00:00.000Z',
        },
      }),
      'utf8',
    );
  }

  function writeCollection(
    collectionId: string,
    mcpServers: Array<{ serverId: string; configId: string }>,
    plugins: Array<{ marketplaceId: string; pluginName: string }> = [],
  ): void {
    const collectionPath = path.join(
      tempDir,
      'collections',
      `collection-${collectionId}.json`,
    );
    fs.mkdirSync(path.dirname(collectionPath), { recursive: true });
    fs.writeFileSync(
      collectionPath,
      JSON.stringify({
        version: 2,
        collection: {
          id: collectionId,
          name: collectionId,
          description: '',
          skills: [],
          plugins,
          mcpServers,
          createdAt: '2026-04-29T00:00:00.000Z',
          updatedAt: '2026-04-29T00:00:00.000Z',
        },
      }),
      'utf8',
    );
  }
});

describe('account catalog merge', (): void => {
  const account: AccountMcpConnection = {
    id: 'account-id',
    serverKey: 'github',
    configId: 'default',
    displayName: 'GitHub account',
    status: 'CONNECTED',
    routeId: 'route',
    enabledTools: null,
    kind: 'CURATED',
  };
  const device: McpServerIndexEntry = {
    id: 'local-id',
    name: 'Local GitHub',
    description: '',
    type: 'http',
    curatedKey: 'github',
    configs: [{ id: 'config', name: 'Default', enabled: true }],
    updatedAt: '',
  };
  it('synthesizes account entries and retains matching device copies as secondary affordances', (): void => {
    const rows = mergeAccountMcpInventory(
      [device, { ...device, id: 'other', curatedKey: 'other' }],
      [account],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: 'github',
      scope: 'account',
      authHandler: 'account',
      accountConnectionId: 'account-id',
      curatedKey: 'github',
      name: 'GitHub account',
      type: 'http',
      deviceCopies: [device],
    });
    expect(rows[0]?.configs).toEqual([
      { id: 'default', name: 'Default', enabled: true },
    ]);
  });
  it('uses default config then id for stable curated-key dedupe, and never dedupes custom names', (): void => {
    const work = { ...account, id: 'aaa', configId: 'work' };
    expect(
      mergeAccountMcpInventory([device], [work, account])[0]
        ?.accountConnectionId,
    ).toBe('account-id');
    expect(
      mergeAccountMcpInventory([device], [{ ...account, kind: 'CUSTOM' }]),
    ).toHaveLength(2);
  });
  it('does not request accounts with the flag off', async (): Promise<void> => {
    const index = { version: 1 as const, servers: [device] };
    expect(await withAccountMcpInventory(index)).toEqual(index);
    expect(listAccountMcpConnections).not.toHaveBeenCalled();
  });
  it.each(['missing-api-key', 'unsupported-capability'] as const)(
    'quietly degrades %s',
    async (code): Promise<void> => {
      const service = getFeatureFlagService();
      jest.spyOn(service, 'isEnabled').mockReturnValue(true);
      jest
        .mocked(getFeatureFlagService)
        .mockReturnValueOnce(service)
        .mockReturnValueOnce(service);
      jest
        .mocked(listAccountMcpConnections)
        .mockRejectedValueOnce(new CanopyCloudClientError(code, 'Unavailable'));
      expect(
        await withAccountMcpInventory({ version: 1, servers: [device] }),
      ).toEqual({
        version: 1,
        servers: [device],
        accountConnectionsAvailable: false,
        accountConnectionsUnavailableReason: 'sign-in-required',
      });
    },
  );
});

it.each([
  new CanopyCloudClientError('http-error', 'Not found', 404),
  Object.assign(new Error('Not found'), { status: 404 }),
])(
  'quietly degrades missing legacy account endpoints: %j',
  async (error): Promise<void> => {
    const service = getFeatureFlagService();
    jest.spyOn(service, 'isEnabled').mockReturnValue(true);
    jest.mocked(getFeatureFlagService).mockReturnValueOnce(service);
    jest.mocked(listAccountMcpConnections).mockRejectedValueOnce(error);
    await expect(
      withAccountMcpInventory({ version: 1, servers: [] }),
    ).resolves.toEqual({
      version: 1,
      servers: [],
      accountConnectionsAvailable: false,
      accountConnectionsUnavailableReason: 'unavailable',
    });
  },
);
it.each([
  new CanopyCloudClientError('network-error', 'Offline'),
  new CanopyCloudClientError('http-error', 'Unauthorized', 401),
  new CanopyCloudClientError('http-error', 'Unavailable', 503),
  new CanopyCloudClientError('invalid-response', 'Invalid response'),
  new AccountMcpConnectionError('account-changed'),
  Object.assign(new Error('HTTP failure'), { status: 500 }),
  Object.assign(new Error('Network failure'), { code: 'ECONNREFUSED' }),
])('keeps the local index available after %j', async (error): Promise<void> => {
  const service = getFeatureFlagService();
  jest.spyOn(service, 'isEnabled').mockReturnValue(true);
  jest.mocked(getFeatureFlagService).mockReturnValueOnce(service);
  jest.mocked(listAccountMcpConnections).mockRejectedValueOnce(error);
  const local: McpServerIndexEntry = {
    id: 'local',
    name: 'Local server',
    description: '',
    type: 'command',
    configs: [],
    updatedAt: '',
  };
  await expect(
    withAccountMcpInventory({ version: 1, servers: [local] }),
  ).resolves.toEqual({
    version: 1,
    servers: [local],
    accountConnectionsAvailable: false,
    accountConnectionsUnavailableReason: 'unavailable',
  });
});
it('propagates programming errors from the account catalog', async (): Promise<void> => {
  const service = getFeatureFlagService();
  jest.spyOn(service, 'isEnabled').mockReturnValue(true);
  jest.mocked(getFeatureFlagService).mockReturnValueOnce(service);
  const error = new TypeError('Invalid implementation');
  jest.mocked(listAccountMcpConnections).mockRejectedValueOnce(error);
  await expect(
    withAccountMcpInventory({ version: 1, servers: [] }),
  ).rejects.toBe(error);
});
