import {
  registerSecretsEnvInjector,
  registerUserEnvironmentInjector,
} from '@canopy/desktop-shared/pipelines/config-paths';
import { buildManagedMcpServerName } from '@canopy/desktop-shared/node/plugins/mcp-server-name';
import type { AgentCapabilitySnapshot } from '@canopy/desktop-shared/node/delegation/agent-artifacts';
import type { McpHttpAuthPreference } from '@canopy/desktop-shared/types';
import type { McpStdioBrokerForResolver } from '../../../plugins/plugin-resolver';
import type * as PluginResolver from '../../../plugins/plugin-resolver';
import os from 'node:os';
import {
  accountMcpTransportDigest,
  mcpTransportDigest,
  standaloneMcpTransportDigest,
} from '../agent-mcp-fingerprint';
import {
  delegatedMcpUnavailableGuidance,
  resolveDelegatedMcpCapabilities,
} from '../agent-mcp-capabilities';

const loadMarketplacesCacheOnly = jest.fn();
const resolvePluginInfoPath = jest.fn();
const loadPluginManifest = jest.fn();
const readPluginMcpConfigObjects = jest.fn();
type ResolvePluginOptions = NonNullable<
  Parameters<typeof PluginResolver.resolvePlugins>[4]
>;
type HttpProxyRoute = Parameters<
  NonNullable<ResolvePluginOptions['mcpHttpProxyService']>['registerRoute']
>[0];

const resolvePlugins = jest.fn<
  Promise<unknown>,
  Parameters<typeof PluginResolver.resolvePlugins>
>();

const loadAccountMcpRefConnections = jest.fn();
const resolveAccountMcpProxyTarget = jest.fn();
jest.mock('../../../mcp/account-catalog', () => ({
  accountMcpConnectionsEnabled: (): boolean => true,
  loadAccountMcpRefConnections: (): unknown => loadAccountMcpRefConnections(),
}));
jest.mock('../../../canopy-cloud/mcp-connections', () => ({
  resolveAccountMcpProxyTarget: (...args: unknown[]): unknown =>
    resolveAccountMcpProxyTarget(...args),
}));

jest.mock('../../../plugins/plugin-service', () => ({
  loadMarketplacesCacheOnly: (...args: unknown[]): unknown =>
    loadMarketplacesCacheOnly(...args),
}));
jest.mock('../../../plugins/plugin-resolver', () => ({
  resolvePluginInfoPath: (...args: unknown[]): unknown =>
    resolvePluginInfoPath(...args),
  loadPluginManifest: (...args: unknown[]): unknown =>
    loadPluginManifest(...args),
  readPluginMcpConfigObjects: (...args: unknown[]): unknown =>
    readPluginMcpConfigObjects(...args),
  resolvePlugins: (
    ...args: Parameters<typeof PluginResolver.resolvePlugins>
  ): Promise<unknown> => resolvePlugins(...args),
}));

function proxyRoute(upstreamUrl: string, sessionId: string): HttpProxyRoute {
  return {
    sessionId,
    serverId: 'test-server',
    configId: 'test-config',
    displayName: 'Test server',
    upstreamUrl,
    headers: {},
    oauthEnabled: false,
  };
}

function httpProxyContext(options: ResolvePluginOptions): {
  mcpHttpProxyService: NonNullable<ResolvePluginOptions['mcpHttpProxyService']>;
  sessionId: string;
} {
  const mcpHttpProxyService = options.mcpHttpProxyService;
  const sessionId = options.sessionId;
  if (!mcpHttpProxyService || !sessionId)
    throw new Error('Expected the HTTP proxy resolver context');
  return { mcpHttpProxyService, sessionId };
}

const pluginName = buildManagedMcpServerName({
  kind: 'plugin',
  friendlyParts: ['plugin', 'review'],
  identityParts: ['market', 'plugin', 'review'],
});
const disabledStdioName = buildManagedMcpServerName({
  kind: 'plugin',
  friendlyParts: ['plugin', 'inactive-stdio'],
  identityParts: ['market', 'plugin', 'inactive-stdio'],
});
const disabledHttpName = buildManagedMcpServerName({
  kind: 'plugin',
  friendlyParts: ['plugin', 'inactive-http'],
  identityParts: ['market', 'plugin', 'inactive-http'],
});

function capabilities(
  config: Record<string, unknown>,
  preferences: readonly McpHttpAuthPreference[] = [],
  pins: AgentCapabilitySnapshot['mcpHttpAuthPreferences'] = [],
): AgentCapabilitySnapshot {
  // Explicit preferences are user overrides; `pins` carry their own source.
  const mcpHttpAuthPreferences = [
    ...preferences.map((preference) => ({
      ...preference,
      source: 'override' as const,
    })),
    ...pins,
  ];
  return {
    claudePluginRoots: [],
    claudeSkillNames: [],
    codexCapabilityRoots: ['plugins/pinned'],
    mcpSelections: [
      {
        source: 'plugin',
        marketplaceId: 'market',
        pluginName: 'plugin',
        serverName: 'review',
        root: 'plugins/pinned',
        configDigest: mcpTransportDigest(config, {
          marketplaceId: 'market',
          pluginName: 'plugin',
          serverName: 'review',
        }),
      },
    ],
    mcpHttpAuthPreferences,
    hookDeclarations: [],
  };
}

function stubHttpProxy(): {
  ensureStarted: jest.Mock;
  registerRoute: jest.Mock;
  unregisterRoute: jest.Mock;
  getProxyUrl: jest.Mock;
} {
  return {
    ensureStarted: jest.fn().mockResolvedValue(undefined),
    registerRoute: jest.fn(),
    unregisterRoute: jest.fn(),
    getProxyUrl: jest.fn(),
  };
}

describe('delegated MCP pinning', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    loadMarketplacesCacheOnly.mockResolvedValue({
      success: true,
      data: {
        marketplaces: [
          {
            id: 'market',
            plugins: [
              {
                name: 'plugin',
                facets: {
                  claude: { name: 'plugin' },
                  codex: { name: 'plugin' },
                },
              },
            ],
          },
        ],
      },
    });
    resolvePluginInfoPath.mockImplementation(
      (plugin: { facets: { codex?: unknown } }) =>
        Promise.resolve(plugin.facets.codex ? '/codex' : '/claude'),
    );
    loadPluginManifest.mockImplementation(
      (_root: string, provider: string) => ({
        name: 'plugin',
        provider,
      }),
    );
    readPluginMcpConfigObjects.mockImplementation((root: string) => ({
      review: {
        url:
          root === '/codex'
            ? 'https://codex.test/mcp'
            : 'https://claude.test/mcp',
      },
    }));
  });

  it('pins transport behavior while allowing standalone credential rotation', () => {
    const identity = { serverId: 'server', configId: 'default' };
    const original = {
      command: 'node',
      args: ['server.js'],
      env: { API_TOKEN: 'old', NODE_OPTIONS: '--max-old-space-size=128' },
      headers: { Authorization: 'Bearer old', 'X-Mode': 'review' },
    };
    const rotated = {
      ...original,
      env: { API_TOKEN: 'new', NODE_OPTIONS: '--max-old-space-size=128' },
      headers: { Authorization: 'Bearer new', 'X-Mode': 'review' },
    };
    expect(mcpTransportDigest(rotated, identity)).not.toBe(
      mcpTransportDigest(original, identity),
    );
    expect(
      mcpTransportDigest(
        {
          ...rotated,
          env: { ...rotated.env, NODE_OPTIONS: '--require /outside.js' },
        },
        identity,
      ),
    ).not.toBe(mcpTransportDigest(original, identity));
    expect(
      standaloneMcpTransportDigest(
        'server',
        'default',
        { type: 'http', url: 'https://one.test' },
        { enabled: true, authToken: 'old' },
      ),
    ).toBe(
      standaloneMcpTransportDigest(
        'server',
        'default',
        { type: 'http', url: 'https://one.test' },
        { enabled: true, authToken: 'new' },
      ),
    );
    expect(
      standaloneMcpTransportDigest(
        'server',
        'default',
        {
          type: 'http',
          url: 'https://one.test',
          name: 'Renamed server',
          updatedAt: 'later',
        },
        { enabled: true, authToken: 'new', name: 'Renamed config' },
      ),
    ).toBe(
      standaloneMcpTransportDigest(
        'server',
        'default',
        { type: 'http', url: 'https://one.test' },
        { enabled: true, authToken: 'old' },
      ),
    );
    const standaloneDefinition = {
      type: 'command',
      command: 'node',
      args: ['server.js'],
    };
    const originalConfig = {
      enabled: true,
      envVars: { API_TOKEN: 'old', NODE_OPTIONS: '--max-old-space-size=128' },
      extraHeaders: { Authorization: 'Bearer old', 'X-Mode': 'review' },
    };
    expect(
      standaloneMcpTransportDigest('server', 'default', standaloneDefinition, {
        ...originalConfig,
        envVars: { ...originalConfig.envVars, API_TOKEN: 'new' },
        extraHeaders: {
          ...originalConfig.extraHeaders,
          Authorization: 'Bearer new',
        },
      }),
    ).toBe(
      standaloneMcpTransportDigest(
        'server',
        'default',
        standaloneDefinition,
        originalConfig,
      ),
    );
    expect(
      standaloneMcpTransportDigest('server', 'default', standaloneDefinition, {
        ...originalConfig,
        envVars: {
          ...originalConfig.envVars,
          NODE_OPTIONS: '--require /outside.js',
        },
      }),
    ).not.toBe(
      standaloneMcpTransportDigest(
        'server',
        'default',
        standaloneDefinition,
        originalConfig,
      ),
    );
    expect(
      standaloneMcpTransportDigest(
        'server',
        'default',
        { type: 'http', url: 'https://one.test' },
        { enabled: true },
      ),
    ).toBe(
      standaloneMcpTransportDigest(
        'server',
        'default',
        { type: 'http', url: 'https://one.test' },
        { enabled: true },
      ),
    );
    expect(
      standaloneMcpTransportDigest(
        'server',
        'default',
        { type: 'http', url: 'https://two.test' },
        { enabled: true },
      ),
    ).not.toBe(
      standaloneMcpTransportDigest(
        'server',
        'default',
        { type: 'http', url: 'https://one.test' },
        { enabled: true },
      ),
    );
  });

  it('rejects a Claude-facet endpoint substituted for a pinned Codex facet', async () => {
    const config = { url: 'https://codex.test/mcp' };
    const routes: string[] = [];
    const proxy = {
      ...stubHttpProxy(),
      registerRoute: jest.fn((route: { upstreamUrl: string }) => {
        routes.push(route.upstreamUrl);
        return Promise.resolve('route-1');
      }),
      getProxyUrl: jest.fn(() => 'http://127.0.0.1:7777/proxy/route-1'),
    };
    resolvePlugins.mockImplementation(
      async (
        _selections: unknown,
        _project: unknown,
        _worktree: unknown,
        _chat: unknown,
        options: ResolvePluginOptions = {},
      ) => {
        const { mcpHttpProxyService, sessionId } = httpProxyContext(options);
        await mcpHttpProxyService.registerRoute(
          proxyRoute('https://claude.test/mcp', sessionId),
        );
        return {
          warnings: [],
          mcpServers: {
            [pluginName]: { type: 'http', url: proxy.getProxyUrl() },
          },
          codexMcpServers: {},
          mcpServerBindings: {},
        };
      },
    );
    await expect(
      resolveDelegatedMcpCapabilities(capabilities(config), {
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'c',
        sessionId: 'child',
        stagedRootDir: '/tmp/staged',
        provider: 'codex',
        signal: new AbortController().signal,
        mcpHttpProxyService: proxy,
        mcpStdioBroker: { registerStdioMcpRoute: jest.fn() },
        authorizeToolCall: jest.fn(),
      }),
    ).rejects.toMatchObject({ code: 'unsupported_capability' });
    expect(routes).toEqual(['https://claude.test/mcp']);
    const resolverOptions: unknown = resolvePlugins.mock.calls[0]?.[4];
    expect(resolverOptions).toMatchObject({
      purpose: 'delegation-codex-mcp',
    });
  });

  it('reads Claude-only inline MCP through the Claude source facet for a Codex child', async () => {
    loadMarketplacesCacheOnly.mockResolvedValue({
      success: true,
      data: {
        marketplaces: [
          {
            id: 'market',
            plugins: [
              { name: 'plugin', facets: { claude: { name: 'plugin' } } },
            ],
          },
        ],
      },
    });
    const config = { url: 'https://claude.test/mcp' };
    const proxy = {
      ...stubHttpProxy(),
      registerRoute: jest.fn().mockResolvedValue('route-1'),
      getProxyUrl: jest.fn(() => 'http://127.0.0.1:7777/proxy/route-1'),
    };
    resolvePlugins.mockImplementation(
      async (
        _selections: unknown,
        _project: unknown,
        _worktree: unknown,
        _chat: unknown,
        options: ResolvePluginOptions = {},
      ) => {
        const { mcpHttpProxyService, sessionId } = httpProxyContext(options);
        await mcpHttpProxyService.registerRoute(
          proxyRoute('https://claude.test/mcp', sessionId),
        );
        return {
          warnings: [],
          mcpServers: {
            [pluginName]: { type: 'http', url: proxy.getProxyUrl() },
          },
          codexMcpServers: {},
          mcpServerBindings: {},
        };
      },
    );
    const result = await resolveDelegatedMcpCapabilities(capabilities(config), {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      sessionId: 'child',
      stagedRootDir: '/tmp/staged',
      provider: 'codex',
      signal: new AbortController().signal,
      mcpHttpProxyService: proxy,
      mcpStdioBroker: { registerStdioMcpRoute: jest.fn() },
      authorizeToolCall: jest.fn(),
    });
    expect(result.codexMcpServers[pluginName]).toMatchObject({
      url: 'http://127.0.0.1:7777/proxy/route-1',
    });
    expect(result.mcpServers[pluginName]).toMatchObject({
      type: 'http',
      alwaysLoad: true,
    });
    expect(result.providerGatedServers).toEqual([]);
    expect(result.unavailable).toEqual([]);
    expect(loadPluginManifest).toHaveBeenCalledWith('/claude', 'claude');
    expect(proxy.registerRoute).toHaveBeenCalledWith(
      expect.objectContaining({ requireToolCallGate: true }),
    );
  });

  it.each([
    ['resolves', 'connection', undefined],
    ['rejects a replaced connection for', 'replacement', 'config_changed'],
  ])(
    '%s a retained account selection through the chat resolver path',
    async (_label, liveId, code) => {
      const connection = {
        id: 'connection',
        serverKey: 'github',
        configId: 'default',
        displayName: 'GitHub',
        kind: 'CURATED',
        status: 'CONNECTED',
        routeId: 'cloud-route',
      };
      const upstreamUrl = 'https://cloud.test/api/v1/mcp-proxy/cloud-route';
      loadAccountMcpRefConnections.mockResolvedValue([
        { ...connection, id: liveId },
      ]);
      resolveAccountMcpProxyTarget.mockResolvedValue({
        connection,
        upstreamUrl,
      });
      const name = buildManagedMcpServerName({
        kind: 'proxy',
        friendlyParts: ['GitHub'],
        identityParts: ['github', 'default'],
      });
      const proxy = {
        ...stubHttpProxy(),
        registerRoute: jest.fn().mockResolvedValue('account-route'),
        getProxyUrl: jest.fn(() => 'http://127.0.0.1:7777/proxy/account'),
      };
      resolvePlugins.mockImplementation(
        async (
          _selections: unknown,
          _project: unknown,
          _worktree: unknown,
          _chat: unknown,
          options: ResolvePluginOptions = {},
        ) => {
          const { mcpHttpProxyService, sessionId } = httpProxyContext(options);
          await mcpHttpProxyService.registerRoute(
            proxyRoute(upstreamUrl, sessionId),
          );
          return {
            warnings: [],
            mcpServers: {
              [name]: {
                type: 'http',
                url: 'http://127.0.0.1:7777/proxy/account',
              },
            },
            codexMcpServers: {},
            mcpServerBindings: {},
          };
        },
      );
      const task = resolveDelegatedMcpCapabilities(
        {
          claudePluginRoots: [],
          claudeSkillNames: [],
          codexCapabilityRoots: [],
          mcpSelections: [
            {
              source: 'account',
              serverId: 'github',
              configId: 'default',
              configDigest: accountMcpTransportDigest(connection),
            },
          ],
          mcpHttpAuthPreferences: [],
          hookDeclarations: [],
        },
        {
          projectId: 'p',
          worktreeId: 'w',
          chatId: 'c',
          sessionId: 'child',
          stagedRootDir: '/tmp/staged',
          provider: 'claude',
          signal: new AbortController().signal,
          mcpHttpProxyService: proxy,
          mcpStdioBroker: { registerStdioMcpRoute: jest.fn() },
          authorizeToolCall: jest.fn(),
        },
      );
      if (code) {
        await expect(task).rejects.toMatchObject({ code });
        expect(resolvePlugins).not.toHaveBeenCalled();
        return;
      }
      await expect(task).resolves.toMatchObject({
        mcpServers: {
          [name]: {
            type: 'http',
            url: 'http://127.0.0.1:7777/proxy/account',
            alwaysLoad: true,
          },
        },
        unavailable: [],
      });
      expect(resolvePlugins.mock.calls[0]?.[0]).toMatchObject({
        mcpServerRefs: [{ serverId: 'github', configId: 'default' }],
      });
      expect(proxy.registerRoute).toHaveBeenCalledWith(
        expect.objectContaining({ requireToolCallGate: true }),
      );
    },
  );

  it('unregisters an HTTP route that finishes registering after cancellation', async () => {
    let completeRegistration: ((value: string) => void) | undefined;
    const waiting = new Promise<string>((resolve) => {
      completeRegistration = resolve;
    });
    const controller = new AbortController();
    const proxy = {
      ...stubHttpProxy(),
      registerRoute: jest.fn<Promise<string>, [route: { upstreamUrl: string }]>(
        () => waiting,
      ),
      getProxyUrl: jest.fn(() => 'http://127.0.0.1:7777/proxy/late'),
    };
    resolvePlugins.mockImplementation(
      async (
        _selections: unknown,
        _project: unknown,
        _worktree: unknown,
        _chat: unknown,
        options: ResolvePluginOptions = {},
      ) => {
        const { mcpHttpProxyService, sessionId } = httpProxyContext(options);
        await mcpHttpProxyService.registerRoute(
          proxyRoute('https://codex.test/mcp', sessionId),
        );
        return {
          warnings: [],
          mcpServers: {},
          codexMcpServers: {},
          mcpServerBindings: {},
        };
      },
    );
    const task = resolveDelegatedMcpCapabilities(
      capabilities({ url: 'https://codex.test/mcp' }),
      {
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'c',
        sessionId: 'child',
        stagedRootDir: '/tmp/staged',
        provider: 'codex',
        signal: controller.signal,
        mcpHttpProxyService: proxy,
        mcpStdioBroker: { registerStdioMcpRoute: jest.fn() },
        authorizeToolCall: jest.fn(),
      },
    );
    for (
      let index = 0;
      index < 10 && proxy.registerRoute.mock.calls.length === 0;
      index += 1
    )
      await Promise.resolve();
    expect(proxy.registerRoute).toHaveBeenCalledTimes(1);
    controller.abort();
    completeRegistration?.('late-route');
    await expect(task).rejects.toMatchObject({
      code: 'unsupported_capability',
    });
    expect(proxy.unregisterRoute).toHaveBeenCalledWith('late-route');
  });

  it.each(['claude', 'codex'] as const)(
    'launches a selected %s stdio server from the installed plugin root with no launch approval',
    async (provider) => {
      const installedRoot = '/installed/plugin/root';
      const config = {
        command: '${CLAUDE_PLUGIN_ROOT}/server.sh',
        args: ['--flag'],
      };
      resolvePluginInfoPath.mockResolvedValue(installedRoot);
      readPluginMcpConfigObjects.mockReturnValue({ review: config });
      const authorizeServerLaunch = jest.fn();
      const authorizeToolCall = jest.fn().mockResolvedValue(true);
      const registerStdioMcpRoute = jest
        .fn<
          ReturnType<McpStdioBrokerForResolver['registerStdioMcpRoute']>,
          Parameters<McpStdioBrokerForResolver['registerStdioMcpRoute']>
        >()
        .mockResolvedValue({
          routeId: 'route',
          capabilityId: 'cap',
          command: 'launcher',
          args: ['route'],
        });
      const liveCommand = `${installedRoot}/server.sh`;
      resolvePlugins.mockImplementation(
        async (
          _selections: unknown,
          _project: unknown,
          _worktree: unknown,
          _chat: unknown,
          options: ResolvePluginOptions = {},
        ) => {
          if (options.mcpStdioBroker) {
            await options.mcpStdioBroker.registerStdioMcpRoute({
              ownerId: 'child',
              routeKey: pluginName,
              command: liveCommand,
              args: ['--flag'],
            });
          }
          return {
            warnings: [],
            mcpServers: {
              [pluginName]: {
                type: 'stdio',
                command: options.mcpStdioBroker ? 'launcher' : liveCommand,
                args: options.mcpStdioBroker ? ['route'] : ['--flag'],
              },
            },
            mcpServerBindings: {},
            codexMcpServers: options.mcpStdioBroker
              ? { [pluginName]: { command: 'launcher', args: ['route'] } }
              : {},
          };
        },
      );
      const result = await resolveDelegatedMcpCapabilities(
        capabilities(config),
        {
          projectId: 'p',
          worktreeId: 'w',
          chatId: 'c',
          sessionId: 'child',
          stagedRootDir: '/tmp/staged',
          provider,
          signal: new AbortController().signal,
          mcpHttpProxyService: stubHttpProxy(),
          mcpStdioBroker: { registerStdioMcpRoute },
          authorizeServerLaunch,
          authorizeToolCall,
        },
      );
      expect(authorizeServerLaunch).not.toHaveBeenCalled();
      const registered = registerStdioMcpRoute.mock.calls[0]?.[0];
      // Launches straight from the installed root — never the staged path.
      expect(registered?.command).toBe(liveCommand);
      expect(registered?.cwd).toBe(installedRoot);
      expect(registered).not.toHaveProperty('baseEnv');
      expect(result.unavailable).toEqual([]);
    },
  );

  it.each(['claude', 'codex'] as const)(
    'passes arbitrary %s stdio environment names straight through with no base environment',
    async (provider) => {
      const env = {
        NODE_OPTIONS: '--max-old-space-size=128',
        DATABASE_URL: 'postgresql://service.test/database',
        RANDOM_CUSTOM_NAME: 'still allowed',
      };
      const config = { command: process.execPath, args: [], env };
      readPluginMcpConfigObjects.mockReturnValue({ review: config });
      const registerStdioMcpRoute = jest
        .fn<
          ReturnType<McpStdioBrokerForResolver['registerStdioMcpRoute']>,
          Parameters<McpStdioBrokerForResolver['registerStdioMcpRoute']>
        >()
        .mockResolvedValue({
          routeId: 'route',
          capabilityId: 'cap',
          command: 'launcher',
          args: ['route'],
        });
      resolvePlugins.mockImplementation(
        async (
          _selections: unknown,
          _project: unknown,
          _worktree: unknown,
          _chat: unknown,
          options: ResolvePluginOptions = {},
        ) => {
          if (options.mcpStdioBroker) {
            await options.mcpStdioBroker.registerStdioMcpRoute({
              ownerId: 'child',
              routeKey: pluginName,
              command: process.execPath,
              args: [],
              env,
            });
          }
          return {
            warnings: [],
            mcpServers: {
              [pluginName]: {
                type: 'stdio',
                command: options.mcpStdioBroker ? 'launcher' : process.execPath,
                args: options.mcpStdioBroker ? ['route'] : [],
                env,
              },
            },
            mcpServerBindings: {},
            codexMcpServers: options.mcpStdioBroker
              ? { [pluginName]: { command: 'launcher', args: ['route'] } }
              : {},
          };
        },
      );
      await resolveDelegatedMcpCapabilities(capabilities(config), {
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'c',
        sessionId: 'child',
        stagedRootDir: '/tmp/staged',
        provider,
        signal: new AbortController().signal,
        mcpHttpProxyService: stubHttpProxy(),
        mcpStdioBroker: { registerStdioMcpRoute },
        authorizeToolCall: jest.fn().mockResolvedValue(true),
      });
      const registered = registerStdioMcpRoute.mock.calls[0]?.[0];
      expect(registered).not.toHaveProperty('baseEnv');
      expect(registered?.env).toEqual(env);
    },
  );

  it('keeps managed credentials out of a delegated OpenCode stdio route while retaining selected credentials', async () => {
    registerSecretsEnvInjector(() => ({ GH_TOKEN: 'synthetic-managed-pat' }));
    registerUserEnvironmentInjector(() => ({
      UNSELECTED_USER_VALUE: 'not-selected',
    }));
    try {
      const config = {
        command: process.execPath,
        args: [],
        env: { SELECTED_TOKEN: 'synthetic-selected-token' },
      };
      readPluginMcpConfigObjects.mockReturnValue({ review: config });
      resolvePlugins.mockResolvedValue({
        warnings: [],
        mcpServers: {
          [pluginName]: { type: 'stdio', ...config },
        },
        codexMcpServers: {},
        mcpServerBindings: {},
      });
      const registerStdioMcpRoute = jest
        .fn<
          ReturnType<McpStdioBrokerForResolver['registerStdioMcpRoute']>,
          Parameters<McpStdioBrokerForResolver['registerStdioMcpRoute']>
        >()
        .mockResolvedValue({
          routeId: 'route',
          capabilityId: 'cap',
          command: 'launcher',
          args: ['route'],
        });
      await resolveDelegatedMcpCapabilities(capabilities(config), {
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'c',
        sessionId: 'child',
        stagedRootDir: '/tmp/staged',
        provider: 'opencode',
        signal: new AbortController().signal,
        mcpHttpProxyService: stubHttpProxy(),
        mcpStdioBroker: { registerStdioMcpRoute },
        authorizeToolCall: jest.fn().mockResolvedValue(false),
      });
      const request = registerStdioMcpRoute.mock.calls[0]?.[0];
      expect(request?.baseEnv).toBeDefined();
      expect(request?.baseEnv?.GH_TOKEN).not.toBe('synthetic-managed-pat');
      expect(request?.baseEnv?.UNSELECTED_USER_VALUE).toBeUndefined();
      expect(request?.baseEnv?.PATH).toBeTruthy();
      expect(request?.env).toEqual({
        SELECTED_TOKEN: 'synthetic-selected-token',
      });
    } finally {
      registerSecretsEnvInjector(null);
      registerUserEnvironmentInjector(null);
    }
  });

  it('waits for a selected Claude stdio server before exposing its tools', async () => {
    const config = { command: process.execPath, args: [] };
    readPluginMcpConfigObjects.mockReturnValue({ review: config });
    resolvePlugins.mockResolvedValue({
      warnings: [],
      mcpServers: {
        [pluginName]: { type: 'stdio', command: process.execPath, args: [] },
      },
      codexMcpServers: {},
      mcpServerBindings: {},
    });
    const registerStdioMcpRoute = jest
      .fn<
        ReturnType<McpStdioBrokerForResolver['registerStdioMcpRoute']>,
        Parameters<McpStdioBrokerForResolver['registerStdioMcpRoute']>
      >()
      .mockResolvedValue({
        routeId: 'route',
        capabilityId: 'cap',
        command: 'launcher',
        args: ['route'],
      });
    const broker = { registerStdioMcpRoute };
    const result = await resolveDelegatedMcpCapabilities(capabilities(config), {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      sessionId: 'child',
      stagedRootDir: '/tmp/staged',
      provider: 'claude',
      signal: new AbortController().signal,
      mcpHttpProxyService: stubHttpProxy(),
      mcpStdioBroker: broker,
      authorizeToolCall: jest.fn().mockResolvedValue(true),
    });
    expect(result.mcpServers[pluginName]).toMatchObject({
      type: 'stdio',
      command: 'launcher',
      alwaysLoad: true,
      env: {
        TMPDIR: os.tmpdir(),
        TMP: os.tmpdir(),
        TEMP: os.tmpdir(),
      },
    });
    const registered = registerStdioMcpRoute.mock.calls[0];
    expect(registered?.[0]).toMatchObject({
      ownerId: 'child',
      routeKey: pluginName,
    });
    expect(registered?.[0]).not.toHaveProperty('baseEnv');
    expect(typeof registered?.[1]?.toolCallGate).toBe('function');
  });

  it.each(['claude', 'codex'] as const)(
    'passes the live signal and selected per-tool gate to the stdio broker (%s)',
    async (provider) => {
      const controller = new AbortController();
      const registerStdioMcpRoute = jest
        .fn<
          ReturnType<McpStdioBrokerForResolver['registerStdioMcpRoute']>,
          Parameters<McpStdioBrokerForResolver['registerStdioMcpRoute']>
        >()
        .mockResolvedValue({
          routeId: 'route',
          capabilityId: 'cap',
          command: 'launcher',
          args: ['route'],
        });
      const broker = { registerStdioMcpRoute };
      const authorizeToolCall = jest.fn().mockResolvedValue(true);
      const config = { command: process.execPath, args: [] };
      readPluginMcpConfigObjects.mockReturnValue({ review: config });
      resolvePlugins.mockImplementation(
        async (
          _selections: unknown,
          _project: unknown,
          _worktree: unknown,
          _chat: unknown,
          options: ResolvePluginOptions = {},
        ) => {
          if (options.mcpStdioBroker)
            await options.mcpStdioBroker.registerStdioMcpRoute({
              ownerId: 'child',
              routeKey: pluginName,
              command: process.execPath,
              args: [],
            });
          return {
            warnings: [],
            mcpServers: {
              [pluginName]: {
                type: 'stdio',
                command: options.mcpStdioBroker ? 'launcher' : process.execPath,
                args: options.mcpStdioBroker ? ['route'] : [],
              },
            },
            mcpServerBindings: {},
            codexMcpServers: options.mcpStdioBroker
              ? { [pluginName]: { command: 'launcher', args: ['route'] } }
              : {},
          };
        },
      );
      const result = await resolveDelegatedMcpCapabilities(
        capabilities(config),
        {
          projectId: 'p',
          worktreeId: 'w',
          chatId: 'c',
          sessionId: 'child',
          stagedRootDir: '/tmp/staged',
          provider,
          signal: controller.signal,
          mcpHttpProxyService: stubHttpProxy(),
          mcpStdioBroker: broker,
          authorizeToolCall,
        },
      );
      expect(result.providerGatedServers).toEqual([]);
      const registered = registerStdioMcpRoute.mock.calls[0];
      expect(registered?.[0]).toMatchObject({
        ownerId: 'child',
        routeKey: pluginName,
      });
      expect(registered?.[1]?.signal).toBe(controller.signal);
      const gate = registerStdioMcpRoute.mock.calls[0]?.[1]?.toolCallGate;
      expect(typeof gate).toBe('function');
      if (!gate) throw new Error('Expected a selected MCP tool gate');
      await expect(
        gate({
          toolName: 'review',
          arguments: { prompt: 'x' },
          signal: controller.signal,
        }),
      ).resolves.toBe(true);
      expect(authorizeToolCall).toHaveBeenCalledWith(
        pluginName,
        'review',
        { prompt: 'x' },
        controller.signal,
      );
    },
  );

  it.each(['claude', 'codex'] as const)(
    'omits disabled MCP entries beside a selected %s plugin server',
    async (provider) => {
      const config = { command: process.execPath, args: [] };
      readPluginMcpConfigObjects.mockReturnValue({
        review: config,
        'inactive-stdio': { command: process.execPath, enabled: false },
        'inactive-http': { url: 'https://inactive.test/mcp', enabled: false },
      });
      const broker = {
        registerStdioMcpRoute: jest.fn().mockResolvedValue({
          routeId: 'route',
          capabilityId: 'cap',
          command: 'launcher',
          args: ['route'],
        }),
      };
      resolvePlugins.mockImplementation(
        async (
          _selections: unknown,
          _project: unknown,
          _worktree: unknown,
          _chat: unknown,
          options: ResolvePluginOptions = {},
        ) => {
          if (options.mcpStdioBroker)
            await options.mcpStdioBroker.registerStdioMcpRoute({
              ownerId: 'child',
              routeKey: pluginName,
              command: process.execPath,
              args: [],
            });
          return {
            warnings: [],
            mcpServers: {
              [pluginName]: {
                type: 'stdio',
                command: provider === 'codex' ? 'launcher' : process.execPath,
                args: provider === 'codex' ? ['route'] : [],
              },
              [disabledStdioName]: {
                type: 'stdio',
                command: process.execPath,
                enabled: false,
              },
              [disabledHttpName]: {
                type: 'http',
                url: 'https://inactive.test/mcp',
                enabled: false,
              },
            },
            mcpServerBindings: {},
            codexMcpServers:
              provider === 'codex'
                ? { [pluginName]: { command: 'launcher', args: ['route'] } }
                : {},
          };
        },
      );
      const result = await resolveDelegatedMcpCapabilities(
        capabilities(config),
        {
          projectId: 'p',
          worktreeId: 'w',
          chatId: 'c',
          sessionId: 'child',
          stagedRootDir: '/tmp/staged',
          provider,
          signal: new AbortController().signal,
          mcpHttpProxyService: stubHttpProxy(),
          mcpStdioBroker: broker,
          authorizeToolCall: jest.fn().mockResolvedValue(true),
        },
      );
      expect(Object.keys(result.mcpServers)).toEqual([pluginName]);
      expect(Object.keys(result.codexMcpServers)).toEqual([pluginName]);
      expect(broker.registerStdioMcpRoute).toHaveBeenCalledTimes(1);
    },
  );

  it('accepts stdio args the resolver made absolute against a subdirectory cwd', async () => {
    const config = {
      command: process.execPath,
      args: ['./server.js'],
      cwd: 'runtime',
    };
    readPluginMcpConfigObjects.mockReturnValue({ review: config });
    resolvePlugins.mockResolvedValue({
      warnings: [],
      mcpServers: {
        [pluginName]: {
          type: 'stdio',
          command: process.execPath,
          args: ['/codex/runtime/server.js'],
          cwd: '/codex/runtime',
        },
      },
      codexMcpServers: {},
      mcpServerBindings: {},
    });
    const registerStdioMcpRoute = jest
      .fn<
        ReturnType<McpStdioBrokerForResolver['registerStdioMcpRoute']>,
        Parameters<McpStdioBrokerForResolver['registerStdioMcpRoute']>
      >()
      .mockResolvedValue({
        routeId: 'route',
        capabilityId: 'cap',
        command: 'launcher',
        args: ['route'],
      });
    const result = await resolveDelegatedMcpCapabilities(capabilities(config), {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      sessionId: 'child',
      stagedRootDir: '/tmp/staged',
      provider: 'claude',
      signal: new AbortController().signal,
      mcpHttpProxyService: stubHttpProxy(),
      mcpStdioBroker: { registerStdioMcpRoute },
      authorizeToolCall: jest.fn().mockResolvedValue(true),
    });
    expect(result.mcpServers[pluginName]).toMatchObject({
      type: 'stdio',
      command: 'launcher',
    });
  });

  it('accepts a bare script name the resolver made absolute against cwd', async () => {
    const config = { command: process.execPath, args: ['server.js'], cwd: '.' };
    readPluginMcpConfigObjects.mockReturnValue({ review: config });
    resolvePlugins.mockResolvedValue({
      warnings: [],
      mcpServers: {
        [pluginName]: {
          type: 'stdio',
          command: process.execPath,
          args: ['/codex/server.js'],
          cwd: '/codex',
        },
      },
      codexMcpServers: {},
      mcpServerBindings: {},
    });
    const registerStdioMcpRoute = jest
      .fn<
        ReturnType<McpStdioBrokerForResolver['registerStdioMcpRoute']>,
        Parameters<McpStdioBrokerForResolver['registerStdioMcpRoute']>
      >()
      .mockResolvedValue({
        routeId: 'route',
        capabilityId: 'cap',
        command: 'launcher',
        args: ['route'],
      });
    const result = await resolveDelegatedMcpCapabilities(capabilities(config), {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      sessionId: 'child',
      stagedRootDir: '/tmp/staged',
      provider: 'claude',
      signal: new AbortController().signal,
      mcpHttpProxyService: stubHttpProxy(),
      mcpStdioBroker: { registerStdioMcpRoute },
      authorizeToolCall: jest.fn().mockResolvedValue(true),
    });
    expect(result.mcpServers[pluginName]).toMatchObject({
      type: 'stdio',
      command: 'launcher',
    });
  });

  it('still rejects a stdio arg resolved against a directory that is neither the root nor the cwd', async () => {
    const config = {
      command: process.execPath,
      args: ['./server.js'],
      cwd: 'runtime',
    };
    readPluginMcpConfigObjects.mockReturnValue({ review: config });
    resolvePlugins.mockResolvedValue({
      warnings: [],
      mcpServers: {
        [pluginName]: {
          type: 'stdio',
          command: process.execPath,
          args: ['/codex/other/server.js'],
          cwd: '/codex/runtime',
        },
      },
      codexMcpServers: {},
      mcpServerBindings: {},
    });
    await expect(
      resolveDelegatedMcpCapabilities(capabilities(config), {
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'c',
        sessionId: 'child',
        stagedRootDir: '/tmp/staged',
        provider: 'claude',
        signal: new AbortController().signal,
        mcpHttpProxyService: stubHttpProxy(),
        mcpStdioBroker: { registerStdioMcpRoute: jest.fn() },
        authorizeToolCall: jest.fn(),
      }),
    ).rejects.toMatchObject({ code: 'config_changed' });
  });

  it('does not accept a bare pinned command resolved against the root or cwd', async () => {
    // Only args are made absolute by the resolver; a command is never
    // resolved against cwd, so a bare `node` must not match `<root>/node`.
    const config = { command: 'node', args: ['./server.js'], cwd: '.' };
    readPluginMcpConfigObjects.mockReturnValue({ review: config });
    resolvePlugins.mockResolvedValue({
      warnings: [],
      mcpServers: {
        [pluginName]: {
          type: 'stdio',
          command: '/codex/node',
          args: ['/codex/server.js'],
          cwd: '/codex',
        },
      },
      codexMcpServers: {},
      mcpServerBindings: {},
    });
    await expect(
      resolveDelegatedMcpCapabilities(capabilities(config), {
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'c',
        sessionId: 'child',
        stagedRootDir: '/tmp/staged',
        provider: 'claude',
        signal: new AbortController().signal,
        mcpHttpProxyService: stubHttpProxy(),
        mcpStdioBroker: { registerStdioMcpRoute: jest.fn() },
        authorizeToolCall: jest.fn(),
      }),
    ).rejects.toMatchObject({ code: 'config_changed' });
  });

  it('rejects a root-resolved arg when the declared cwd is a subdirectory', async () => {
    // The resolver emits only the cwd-resolved form in this case, so the
    // root-resolved form is drift, not an alternate spelling.
    const config = {
      command: process.execPath,
      args: ['./server.js'],
      cwd: 'runtime',
    };
    readPluginMcpConfigObjects.mockReturnValue({ review: config });
    resolvePlugins.mockResolvedValue({
      warnings: [],
      mcpServers: {
        [pluginName]: {
          type: 'stdio',
          command: process.execPath,
          args: ['/codex/server.js'],
          cwd: '/codex/runtime',
        },
      },
      codexMcpServers: {},
      mcpServerBindings: {},
    });
    await expect(
      resolveDelegatedMcpCapabilities(capabilities(config), {
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'c',
        sessionId: 'child',
        stagedRootDir: '/tmp/staged',
        provider: 'claude',
        signal: new AbortController().signal,
        mcpHttpProxyService: stubHttpProxy(),
        mcpStdioBroker: { registerStdioMcpRoute: jest.fn() },
        authorizeToolCall: jest.fn(),
      }),
    ).rejects.toMatchObject({ code: 'config_changed' });
  });

  it('throws config_changed when the resolved stdio command drifts from the pinned selection', async () => {
    const config = { command: '/installed/root/server.sh', args: [] };
    readPluginMcpConfigObjects.mockReturnValue({ review: config });
    resolvePlugins.mockResolvedValue({
      warnings: [],
      mcpServers: {
        [pluginName]: {
          type: 'stdio',
          command: '/installed/root/other-server.sh',
          args: [],
        },
      },
      codexMcpServers: {},
      mcpServerBindings: {},
    });
    await expect(
      resolveDelegatedMcpCapabilities(capabilities(config), {
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'c',
        sessionId: 'child',
        stagedRootDir: '/tmp/staged',
        provider: 'claude',
        signal: new AbortController().signal,
        mcpHttpProxyService: stubHttpProxy(),
        mcpStdioBroker: { registerStdioMcpRoute: jest.fn() },
        authorizeToolCall: jest.fn(),
      }),
    ).rejects.toMatchObject({ code: 'config_changed' });
  });

  it('throws unsupported_capability when a direct HTTP entry drifts from the pinned selection URL', async () => {
    const config = { url: 'https://provider.test/mcp' };
    readPluginMcpConfigObjects.mockReturnValue({ review: config });
    resolvePlugins.mockResolvedValue({
      warnings: [],
      mcpServers: {
        [pluginName]: { type: 'http', url: 'https://other.test/mcp' },
      },
      codexMcpServers: {},
      mcpServerBindings: {},
    });
    await expect(
      resolveDelegatedMcpCapabilities(capabilities(config), {
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'c',
        sessionId: 'child',
        stagedRootDir: '/tmp/staged',
        provider: 'claude',
        signal: new AbortController().signal,
        mcpHttpProxyService: stubHttpProxy(),
        mcpStdioBroker: { registerStdioMcpRoute: jest.fn() },
        authorizeToolCall: jest.fn(),
      }),
    ).rejects.toMatchObject({ code: 'unsupported_capability' });
  });

  it('passes a provider-handled HTTP server through with its headers and lists it as provider-gated for a Claude child', async () => {
    const config = {
      url: 'https://provider.test/mcp',
      headers: { 'X-Api-Key': 'plugin-secret' },
    };
    readPluginMcpConfigObjects.mockReturnValue({ review: config });
    resolvePlugins.mockResolvedValue({
      warnings: [],
      mcpServers: {
        [pluginName]: {
          type: 'http',
          url: 'https://provider.test/mcp',
          headers: { 'X-Api-Key': 'plugin-secret' },
        },
      },
      mcpServerBindings: {},
      codexMcpServers: {
        [pluginName]: { url: 'https://provider.test/mcp', required: false },
      },
    });
    const result = await resolveDelegatedMcpCapabilities(capabilities(config), {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      sessionId: 'child',
      stagedRootDir: '/tmp/staged',
      provider: 'claude',
      signal: new AbortController().signal,
      mcpHttpProxyService: stubHttpProxy(),
      mcpStdioBroker: { registerStdioMcpRoute: jest.fn() },
      authorizeToolCall: jest.fn(),
    });
    expect(result.mcpServers[pluginName]).toEqual({
      type: 'http',
      url: 'https://provider.test/mcp',
      headers: { 'X-Api-Key': 'plugin-secret' },
      alwaysLoad: true,
    });
    expect(result.providerGatedServers).toEqual([pluginName]);
    expect(result.unavailable).toEqual([]);
    expect(result.serverNameByProxyUrl).toEqual({});
  });

  it('marks a headered provider server unavailable for a Codex child instead of failing the run', async () => {
    const config = {
      url: 'https://provider.test/mcp',
      headers: { 'X-Api-Key': 'plugin-secret' },
    };
    readPluginMcpConfigObjects.mockReturnValue({ review: config });
    resolvePlugins.mockResolvedValue({
      // buildCodexPluginMcpServers drops headered HTTP servers for Codex.
      warnings: [
        `Plugin MCP server "${pluginName}" requires HTTP headers but could not use the local credential proxy and was skipped.`,
      ],
      mcpServers: {
        [pluginName]: {
          type: 'http',
          url: 'https://provider.test/mcp',
          headers: { 'X-Api-Key': 'plugin-secret' },
        },
      },
      codexMcpServers: {},
      mcpServerBindings: {},
    });
    const result = await resolveDelegatedMcpCapabilities(capabilities(config), {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      sessionId: 'child',
      stagedRootDir: '/tmp/staged',
      provider: 'codex',
      signal: new AbortController().signal,
      mcpHttpProxyService: stubHttpProxy(),
      mcpStdioBroker: { registerStdioMcpRoute: jest.fn() },
      authorizeToolCall: jest.fn(),
    });
    expect(result.codexMcpServers).toEqual({});
    expect(result.mcpServers).toEqual({});
    expect(result.providerGatedServers).toEqual([]);
    expect(result.unavailable).toEqual([
      { name: 'plugin/review', reason: 'provider_unsupported' },
    ]);
  });

  it('proxies a canopy-handled server with static headers so the child config never holds the secret', async () => {
    const config = {
      url: 'https://claude.test/mcp',
      headers: { Authorization: 'Bearer server-secret' },
    };
    readPluginMcpConfigObjects.mockReturnValue({ review: config });
    const proxy = {
      ...stubHttpProxy(),
      registerRoute: jest.fn().mockResolvedValue('route-1'),
      getProxyUrl: jest.fn(() => 'http://127.0.0.1:7777/proxy/route-1'),
    };
    resolvePlugins.mockImplementation(
      async (
        _selections: unknown,
        _project: unknown,
        _worktree: unknown,
        _chat: unknown,
        options: ResolvePluginOptions = {},
      ) => {
        const { mcpHttpProxyService, sessionId } = httpProxyContext(options);
        await mcpHttpProxyService.registerRoute(
          proxyRoute('https://claude.test/mcp', sessionId),
        );
        return {
          warnings: [],
          mcpServers: {
            [pluginName]: { type: 'http', url: proxy.getProxyUrl() },
          },
          codexMcpServers: {},
          mcpServerBindings: {},
        };
      },
    );
    const result = await resolveDelegatedMcpCapabilities(capabilities(config), {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      sessionId: 'child',
      stagedRootDir: '/tmp/staged',
      provider: 'claude',
      signal: new AbortController().signal,
      mcpHttpProxyService: proxy,
      mcpStdioBroker: { registerStdioMcpRoute: jest.fn() },
      authorizeToolCall: jest.fn(),
    });
    expect(result.mcpServers[pluginName]).not.toHaveProperty('headers');
    expect(result.serverNameByProxyUrl).toEqual({
      'http://127.0.0.1:7777/proxy/route-1': pluginName,
    });
    expect(result.providerGatedServers).toEqual([]);
  });

  it.each(['default', 'override'] as const)(
    'passes a %s pin to the resolver on the matching side',
    async (source) => {
      const config = { url: 'https://plugin-declared.test/mcp' };
      readPluginMcpConfigObjects.mockReturnValue({ review: config });
      resolvePlugins.mockResolvedValue({
        warnings: [],
        mcpServers: {},
        codexMcpServers: {},
        mcpServerBindings: {},
      });
      const pin = {
        target: {
          kind: 'plugin' as const,
          marketplaceId: 'market',
          pluginName: 'plugin',
          serverName: 'review',
        },
        handler: 'canopy' as const,
        source,
      };
      await resolveDelegatedMcpCapabilities(capabilities(config, [], [pin]), {
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'c',
        sessionId: 'child',
        stagedRootDir: '/tmp/staged',
        provider: 'claude',
        signal: new AbortController().signal,
        mcpHttpProxyService: stubHttpProxy(),
        mcpStdioBroker: { registerStdioMcpRoute: jest.fn() },
        authorizeToolCall: jest.fn(),
      });
      const { target, handler } = pin;
      // A synthesized default must not read as a user override in the child,
      // or a curated member skips its connection binding (REG-3033).
      expect(resolvePlugins.mock.calls[0]?.[0]).toMatchObject({
        mcpHttpAuthPreferences:
          source === 'override' ? [{ target, handler }] : [],
      });
      expect(resolvePlugins.mock.calls[0]?.[4]).toMatchObject({
        mcpHttpAuthPins: source === 'default' ? [{ target, handler }] : [],
      });
    },
  );

  it("accepts an account-routed HTTP server whose upstream differs from the pinned definition URL when the chat's preference says 'account'", async () => {
    const config = { url: 'https://plugin-declared.test/mcp' };
    readPluginMcpConfigObjects.mockReturnValue({ review: config });
    const proxy = {
      ...stubHttpProxy(),
      registerRoute: jest.fn().mockResolvedValue('account-route'),
      getProxyUrl: jest.fn(() => 'http://127.0.0.1:7777/proxy/account'),
    };
    resolvePlugins.mockImplementation(
      async (
        _selections: unknown,
        _project: unknown,
        _worktree: unknown,
        _chat: unknown,
        options: ResolvePluginOptions = {},
      ) => {
        const { mcpHttpProxyService, sessionId } = httpProxyContext(options);
        await mcpHttpProxyService.registerRoute(
          proxyRoute('https://account-connection.upstream.test/mcp', sessionId),
        );
        return {
          warnings: [],
          mcpServers: {
            [pluginName]: { type: 'http', url: proxy.getProxyUrl() },
          },
          codexMcpServers: {},
          mcpServerBindings: {},
        };
      },
    );
    const preferences: McpHttpAuthPreference[] = [
      {
        target: {
          kind: 'plugin',
          marketplaceId: 'market',
          pluginName: 'plugin',
          serverName: 'review',
        },
        handler: 'account',
      },
    ];
    const result = await resolveDelegatedMcpCapabilities(
      capabilities(config, preferences),
      {
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'c',
        sessionId: 'child',
        stagedRootDir: '/tmp/staged',
        provider: 'claude',
        signal: new AbortController().signal,
        mcpHttpProxyService: proxy,
        mcpStdioBroker: { registerStdioMcpRoute: jest.fn() },
        authorizeToolCall: jest.fn(),
      },
    );
    expect(result.mcpServers[pluginName]).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:7777/proxy/account',
      alwaysLoad: true,
    });
    expect(result.unavailable).toEqual([]);

    // Without the recorded preference, the same drifted upstream is rejected.
    jest.clearAllMocks();
    loadMarketplacesCacheOnly.mockResolvedValue({
      success: true,
      data: {
        marketplaces: [
          {
            id: 'market',
            plugins: [
              {
                name: 'plugin',
                facets: {
                  claude: { name: 'plugin' },
                  codex: { name: 'plugin' },
                },
              },
            ],
          },
        ],
      },
    });
    resolvePluginInfoPath.mockResolvedValue('/claude');
    loadPluginManifest.mockReturnValue({ name: 'plugin' });
    readPluginMcpConfigObjects.mockReturnValue({ review: config });
    resolvePlugins.mockImplementation(
      async (
        _selections: unknown,
        _project: unknown,
        _worktree: unknown,
        _chat: unknown,
        options: ResolvePluginOptions = {},
      ) => {
        const { mcpHttpProxyService, sessionId } = httpProxyContext(options);
        await mcpHttpProxyService.registerRoute(
          proxyRoute('https://account-connection.upstream.test/mcp', sessionId),
        );
        return {
          warnings: [],
          mcpServers: {
            [pluginName]: { type: 'http', url: proxy.getProxyUrl() },
          },
          codexMcpServers: {},
          mcpServerBindings: {},
        };
      },
    );
    await expect(
      resolveDelegatedMcpCapabilities(capabilities(config), {
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'c',
        sessionId: 'child',
        stagedRootDir: '/tmp/staged',
        provider: 'claude',
        signal: new AbortController().signal,
        mcpHttpProxyService: proxy,
        mcpStdioBroker: { registerStdioMcpRoute: jest.fn() },
        authorizeToolCall: jest.fn(),
      }),
    ).rejects.toMatchObject({ code: 'unsupported_capability' });
  });

  it('reports a resolver OAuth skip as sign_in_required without failing the run', async () => {
    const config = { url: 'https://oauth.test/mcp' };
    readPluginMcpConfigObjects.mockReturnValue({ review: config });
    resolvePlugins.mockResolvedValue({
      warnings: [
        'MCP server "market/plugin:review" requires OAuth, but the local proxy is not available in this context; skipping to avoid provider-side browser login.',
      ],
      mcpServers: {},
      codexMcpServers: {},
      mcpServerBindings: {},
    });
    const result = await resolveDelegatedMcpCapabilities(capabilities(config), {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      sessionId: 'child',
      stagedRootDir: '/tmp/staged',
      provider: 'claude',
      signal: new AbortController().signal,
      mcpHttpProxyService: stubHttpProxy(),
      mcpStdioBroker: { registerStdioMcpRoute: jest.fn() },
      authorizeToolCall: jest.fn(),
    });
    expect(result.mcpServers).toEqual({});
    expect(result.unavailable).toEqual([
      { name: 'plugin/review', reason: 'sign_in_required' },
    ]);
    expect(delegatedMcpUnavailableGuidance(result.unavailable)).toBe(
      'These MCP servers are unavailable in this run: plugin/review (sign-in required). Do not try to call their tools.',
    );
  });

  it('reports a signed-out account connection as account_unavailable without failing the run', async () => {
    const config = { url: 'https://plugin-declared.test/mcp' };
    readPluginMcpConfigObjects.mockReturnValue({ review: config });
    resolvePlugins.mockResolvedValue({
      warnings: [
        'Account MCP server "plugin/review" skipped: connection unavailable',
      ],
      mcpServers: {},
      codexMcpServers: {},
      mcpServerBindings: {},
    });
    const preferences: McpHttpAuthPreference[] = [
      {
        target: {
          kind: 'plugin',
          marketplaceId: 'market',
          pluginName: 'plugin',
          serverName: 'review',
        },
        handler: 'account',
      },
    ];
    const result = await resolveDelegatedMcpCapabilities(
      capabilities(config, preferences),
      {
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'c',
        sessionId: 'child',
        stagedRootDir: '/tmp/staged',
        provider: 'claude',
        signal: new AbortController().signal,
        mcpHttpProxyService: stubHttpProxy(),
        mcpStdioBroker: { registerStdioMcpRoute: jest.fn() },
        authorizeToolCall: jest.fn(),
      },
    );
    expect(result.unavailable).toEqual([
      { name: 'plugin/review', reason: 'account_unavailable' },
    ]);
  });

  it('never surfaces raw resolver warning text, paths, or URLs in unavailable entries or guidance', async () => {
    const config = { url: 'https://oauth.test/mcp/secret-path?token=abc123' };
    readPluginMcpConfigObjects.mockReturnValue({ review: config });
    const rawWarning =
      'MCP server "market/plugin:review" requires OAuth, but https://oauth.test/mcp/secret-path?token=abc123 could not be verified; skipping to avoid provider-side browser login.';
    resolvePlugins.mockResolvedValue({
      warnings: [rawWarning],
      mcpServers: {},
      codexMcpServers: {},
      mcpServerBindings: {},
    });
    const result = await resolveDelegatedMcpCapabilities(capabilities(config), {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      sessionId: 'child',
      stagedRootDir: '/tmp/staged',
      provider: 'claude',
      signal: new AbortController().signal,
      mcpHttpProxyService: stubHttpProxy(),
      mcpStdioBroker: { registerStdioMcpRoute: jest.fn() },
      authorizeToolCall: jest.fn(),
    });
    expect(result.unavailable).toHaveLength(1);
    const [entry] = result.unavailable;
    expect(entry?.name).toBe('plugin/review');
    expect(entry?.name).not.toContain('http');
    expect(entry?.name).not.toContain('token');
    expect(JSON.stringify(result.unavailable)).not.toContain(rawWarning);
    const guidance = delegatedMcpUnavailableGuidance(result.unavailable);
    expect(guidance).not.toContain('http');
    expect(guidance).not.toContain('token');
    expect(guidance).not.toContain(rawWarning);
  });
});
