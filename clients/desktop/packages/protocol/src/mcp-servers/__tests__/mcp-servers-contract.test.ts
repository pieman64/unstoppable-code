import type {
  PortalChatTabPluginSelections,
  PortalMcpServerRow,
} from '../../portal';
import type {
  DetectedMcpServerInfo,
  McpHttpAuthPreference,
  McpServerData,
  McpServerHealthCheckResult,
  McpServerIndexEntry,
  McpServerRef,
  McpServerTestConnectionResult,
} from '../index';

describe('mcp-servers catalog contract', () => {
  it('constructs full server data with oauth and curated metadata', () => {
    const server: McpServerData = {
      definition: {
        id: 'srv-1',
        name: 'Search',
        description: 'Search MCP server',
        type: 'http',
        url: 'https://mcp.example.com',
        headers: { 'x-app': 'canopy' },
        oauth: {
          clientId: 'client-1',
          callbackPort: 8123,
          scopes: ['read'],
          usePkce: true,
        },
        curated: {
          key: 'search',
          logoUrl: 'https://example.com/logo.png',
          requiresProviderAuth: false,
        },
        httpAuthHandler: 'canopy',
        createdAt: '2026-08-27T00:00:00Z',
        updatedAt: '2026-08-27T00:00:00Z',
      },
      configs: [
        {
          id: 'cfg-1',
          name: 'Default',
          description: '',
          enabled: true,
          envVars: { TOKEN_ENV: 'x' },
          extraArgs: [],
          extraHeaders: {},
          authToken: 'secret',
          createdAt: '2026-08-27T00:00:00Z',
          updatedAt: '2026-08-27T00:00:00Z',
        },
      ],
    };
    expect(JSON.parse(JSON.stringify(server))).toEqual(server);
  });

  it('constructs index entries and refs', () => {
    const entry: McpServerIndexEntry = {
      id: 'srv-1',
      name: 'Search',
      description: 'Search MCP server',
      type: 'http',
      configs: [{ id: 'cfg-1', name: 'Default', enabled: true }],
      logoUrl: 'https://example.com/logo.png',
      curatedKey: 'search',
      updatedAt: '2026-08-27T00:00:00Z',
    };
    expect(JSON.parse(JSON.stringify(entry))).toEqual(entry);

    const ref: McpServerRef = { serverId: 'srv-1', configId: 'cfg-1' };
    expect(JSON.parse(JSON.stringify(ref))).toEqual(ref);
  });

  it('constructs http auth preferences for both target kinds', () => {
    const standalone: McpHttpAuthPreference = {
      target: { kind: 'standalone', serverId: 'srv-1', configId: 'cfg-1' },
      handler: 'canopy',
    };
    const plugin: McpHttpAuthPreference = {
      target: {
        kind: 'plugin',
        marketplaceId: 'builtin/app',
        pluginName: 'browser',
        serverName: 'search',
      },
      handler: 'provider',
    };
    expect(JSON.parse(JSON.stringify(standalone))).toEqual(standalone);
    expect(JSON.parse(JSON.stringify(plugin))).toEqual(plugin);
  });

  it('constructs health and connection test results', () => {
    const health: McpServerHealthCheckResult = {
      serverId: 'srv-1',
      configId: 'cfg-1',
      status: 'needs_auth',
      statusCode: 401,
      message: 'Authentication required',
      responseTime: 42,
      checkedAt: '2026-08-27T00:00:00Z',
    };
    expect(JSON.parse(JSON.stringify(health))).toEqual(health);

    const test: McpServerTestConnectionResult = {
      serverId: 'srv-1',
      success: true,
      message: 'ok',
      endpointReachable: true,
      tools: ['search', 'fetch'],
      responseTime: 120,
    };
    expect(JSON.parse(JSON.stringify(test))).toEqual(test);
  });

  it('constructs detected server descriptors for each source kind', () => {
    const standalone: DetectedMcpServerInfo = {
      key: 'standalone:srv-1:cfg-1',
      source: 'standalone',
      serverName: 'search',
      displayName: 'Search',
      type: 'http',
      url: 'https://mcp.example.com',
      serverId: 'srv-1',
      configId: 'cfg-1',
      configName: 'Default',
      curatedKey: 'search',
      enabled: true,
      authStatus: 'connected',
      authStatusLabel: 'Connected',
      canConnect: false,
      httpAuthHandler: 'canopy',
      httpAuthHandlerSource: 'server',
      canToggleCanopyProxy: true,
      canopyProxyEnabled: true,
    };
    const fromPlugin: DetectedMcpServerInfo = {
      key: 'plugin:builtin/app:browser:search',
      source: 'plugin',
      serverName: 'plugin__search',
      displayName: 'search',
      type: 'command',
      marketplaceId: 'builtin/app',
      pluginName: 'browser',
      pluginServerName: 'search',
      enabled: true,
      authStatus: 'unsupported',
      authStatusLabel: 'Not applicable',
      canConnect: false,
    };
    expect(JSON.parse(JSON.stringify(standalone))).toEqual(standalone);
    expect(JSON.parse(JSON.stringify(fromPlugin))).toEqual(fromPlugin);
  });
});

it('round-trips an account-scoped index row through the portal alias', () => {
  const entry: McpServerIndexEntry = {
    id: 'srv-account',
    name: 'Linear',
    description: '',
    type: 'http',
    configs: [],
    updatedAt: '2026-09-16T00:00:00Z',
    scope: 'account',
    authHandler: 'account',
    accountConnectionId: 'connection-1',
  };
  const row: PortalMcpServerRow = entry;
  const preference: McpHttpAuthPreference = {
    target: { kind: 'standalone', serverId: entry.id, configId: 'default' },
    handler: 'account',
  };
  expect(JSON.parse(JSON.stringify(row))).toEqual(entry);
  expect(JSON.parse(JSON.stringify(preference))).toEqual(preference);
  const selections: PortalChatTabPluginSelections = {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpHttpAuthPreferences: [preference],
  };
  expect(selections.mcpHttpAuthPreferences?.[0].handler).toBe('account');
  const device: McpServerIndexEntry = { ...entry, scope: 'device' };
  expect(device.scope).toBe('device');
});
