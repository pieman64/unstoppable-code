import { resolvePluginHttpHeaders } from '../../../plugins/plugin-mcp-auth';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentCapabilitySnapshot } from '@canopy/desktop-shared/node/delegation/agent-artifacts';
import { buildManagedMcpServerName } from '@canopy/desktop-shared/node/plugins/mcp-server-name';
import {
  mcpTransportDigest,
  inheritedPluginMcpTransportDigest,
} from '../agent-mcp-fingerprint';
import { resolveDelegatedMcpCapabilities } from '../agent-mcp-capabilities';

const readEnabled = jest.fn();
const readConfig = jest.fn();
const resolvePlugins = jest.fn();
const marketplacePath = jest.fn();
jest.mock('../../../plugins/claude-enabled-plugins', () => ({
  readClaudeEnabledPlugins: (...args: unknown[]): unknown =>
    readEnabled(...args),
}));
jest.mock('../../../cursor/inherited-roots', () => ({
  resolveInheritedCursorRoots: (): { claudeConfigDir: string } => ({
    claudeConfigDir: '/host/claude',
  }),
}));
jest.mock('../../../plugins/plugin-service', () => ({
  loadMarketplacesCacheOnly: (): Promise<unknown> =>
    Promise.resolve({
      success: true,
      data: {
        marketplaces: [
          { id: 'market', name: 'market', plugins: [{ name: 'tool' }] },
        ],
      },
    }),
}));
jest.mock('../../../plugins/plugin-resolver', () => ({
  resolvePluginInfoPath: (...args: unknown[]): unknown =>
    marketplacePath(...args),
  loadPluginManifest: (): { name: string } => ({ name: 'tool' }),
  readPluginMcpConfigObjects: (...args: unknown[]): unknown =>
    readConfig(...args),
  resolvePlugins: (...args: unknown[]): unknown => resolvePlugins(...args),
}));
const installedRoot = mkdtempSync(
  path.join(os.tmpdir(), 'inherited-plugin-pin-'),
);
afterAll(() => rmSync(installedRoot, { recursive: true, force: true }));
const installationDigest = createHash('sha256')
  .update(realpathSync(installedRoot))
  .digest('hex');
const identity = {
  marketplaceId: 'market',
  pluginName: 'tool',
  serverName: 'review',
};
const name = buildManagedMcpServerName({
  kind: 'plugin',
  friendlyParts: ['tool', 'review'],
  identityParts: ['market', 'tool', 'review'],
});
function snapshot(
  config: Record<string, unknown>,
  configDigest = mcpTransportDigest(config, identity),
): AgentCapabilitySnapshot {
  const selection = {
    source: 'inherited-plugin' as const,
    installationDigest,
    ...identity,
    root: 'home/tool',
    configDigest,
  };
  return {
    claudePluginRoots: ['home/tool'],
    codexCapabilityRoots: ['home/tool'],
    claudeSkillNames: [],
    mcpSelections: [selection],
    mcpHttpAuthPreferences: [],
    hookDeclarations: [],
  };
}
function options(): Parameters<typeof resolveDelegatedMcpCapabilities>[1] & {
  mcpStdioBroker: { registerStdioMcpRoute: jest.Mock };
  mcpHttpProxyService: {
    ensureStarted: jest.Mock;
    registerRoute: jest.Mock;
    unregisterRoute: jest.Mock;
    getProxyUrl: jest.Mock<string, []>;
  };
} {
  return {
    projectId: 'p',
    worktreeId: 'w',
    chatId: 'c',
    sessionId: 'child',
    stagedRootDir: '/private/retained',
    inheritedPluginProjectPath: '/original/worktree',
    provider: 'copilot' as const,
    signal: new AbortController().signal,
    mcpHttpProxyService: {
      ensureStarted: jest.fn().mockResolvedValue(undefined),
      registerRoute: jest.fn().mockResolvedValue('route'),
      unregisterRoute: jest.fn(),
      getProxyUrl: jest.fn(() => 'http://127.0.0.1:3210/route'),
    },
    mcpStdioBroker: {
      registerStdioMcpRoute: jest.fn().mockResolvedValue({
        routeId: 'route',
        capabilityId: 'cap',
        command: 'broker',
        args: ['scoped'],
      }),
    },
    authorizeToolCall: jest.fn().mockResolvedValue(true),
  };
}
beforeEach(() => {
  jest.clearAllMocks();
  readEnabled.mockReturnValue(new Map([['tool@market', installedRoot]]));
  marketplacePath.mockRejectedValue(
    Error('Marketplace fallback must not execute'),
  );
});
it('launches the retained installed stdio member from the parent scope, through the child gate', async () => {
  const config = { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.js'] };
  readConfig.mockImplementation((root: string) =>
    root === installedRoot ? { review: config } : {},
  );
  resolvePlugins.mockResolvedValue({
    warnings: [],
    mcpServers: {
      [name]: {
        type: 'stdio',
        command: 'node',
        args: [path.join(installedRoot, 'server.js')],
      },
    },
    codexMcpServers: {},
    mcpServerBindings: {},
  });
  const host = options();
  const resolved = await resolveDelegatedMcpCapabilities(
    snapshot(config),
    host,
  );
  expect(resolved.mcpServers[name]).toMatchObject({
    command: 'broker',
    args: ['scoped'],
  });
  expect(readEnabled).toHaveBeenCalledWith(
    '/host/claude',
    '/original/worktree',
  );
  expect(marketplacePath).not.toHaveBeenCalled();
  expect(resolvePlugins).toHaveBeenCalledWith(
    expect.objectContaining({ pluginRefs: [] }),
    'p',
    'w',
    'c',
    expect.objectContaining({
      installExternalPlugins: false,
      inheritedPluginRefs: [
        {
          marketplaceId: 'market',
          pluginName: 'tool',
          installPath: installedRoot,
        },
      ],
    }),
  );
  const anyGate: unknown = expect.any(Function);
  expect(host.mcpStdioBroker.registerStdioMcpRoute).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ toolCallGate: anyGate }),
  );
});
it.each(['missing', 'changed', 'reinstalled'] as const)(
  'rejects %s installed members before launch',
  async (state) => {
    const config = { command: 'node', args: ['server.js'] };
    if (state === 'missing') readEnabled.mockReturnValue(new Map());
    if (state === 'reinstalled')
      readEnabled.mockReturnValue(
        new Map([['tool@market', path.dirname(installedRoot)]]),
      );
    readConfig.mockReturnValue({
      review:
        state === 'changed'
          ? { command: 'node', args: ['different.js'] }
          : config,
    });
    const host = options();
    await expect(
      resolveDelegatedMcpCapabilities(snapshot(config), host),
    ).rejects.toThrow();
    expect(resolvePlugins).not.toHaveBeenCalled();
    expect(host.mcpStdioBroker.registerStdioMcpRoute).not.toHaveBeenCalled();
    expect(marketplacePath).not.toHaveBeenCalled();
  },
);
it('keeps rotating HTTP credentials behind the host proxy while checking the pinned endpoint', async () => {
  const config = {
    url: 'https://installed.test/mcp',
    headers: { Authorization: 'Bearer rotated' },
  };
  readConfig.mockReturnValue({ review: config });
  const host = options();
  resolvePlugins.mockImplementation(
    async (
      _selections: unknown,
      _p: unknown,
      _w: unknown,
      _c: unknown,
      input: {
        sessionId: string;
        mcpHttpProxyService: typeof host.mcpHttpProxyService;
      },
    ) => {
      await input.mcpHttpProxyService.registerRoute({
        sessionId: input.sessionId,
        upstreamUrl: config.url,
      });
      return {
        warnings: [],
        mcpServers: {
          [name]: { type: 'http', url: host.mcpHttpProxyService.getProxyUrl() },
        },
        codexMcpServers: {},
        mcpServerBindings: {},
      };
    },
  );
  const retained = snapshot({
    ...config,
    headers: { Authorization: '<credential>' },
  });
  const resolved = await resolveDelegatedMcpCapabilities(retained, host);
  expect(resolved.mcpServers[name]).toEqual({
    type: 'http',
    url: 'http://127.0.0.1:3210/route',
    alwaysLoad: true,
  });
  expect(JSON.stringify([retained, resolved])).not.toContain('rotated');
  expect(host.mcpHttpProxyService.registerRoute).toHaveBeenCalledWith(
    expect.objectContaining({ requireToolCallGate: true }),
  );
});

it('keeps camelCase credential rotation out of inherited transport identity', () => {
  const config = (token: string): Record<string, unknown> => ({
    command: 'node',
    args: ['server.js'],
    env: {
      accessToken: token,
      refreshToken: token,
      apiKey: token,
      CLIENT_SECRET: token,
    },
    headers: { 'X-Api-Key': token },
    oauth: { clientSecret: token },
  });
  const digest = inheritedPluginMcpTransportDigest(config('first'), identity);
  expect(inheritedPluginMcpTransportDigest(config('rotated'), identity)).toBe(
    digest,
  );
  expect(
    inheritedPluginMcpTransportDigest(
      { ...config('first'), args: ['different.js'] },
      identity,
    ),
  ).not.toBe(digest);
});

it.each(['url', 'args'])(
  'keeps URL and argument credential rotation out of the %s identity',
  (kind) => {
    const config = (secret: string): Record<string, unknown> =>
      kind === 'url'
        ? {
            url: `https://user:${secret}@installed.test/mcp?access_token=${secret}&tenant=one`,
          }
        : {
            command: 'node',
            args: [
              'server.js',
              '--api-key',
              secret,
              `--client-secret=${secret}`,
              '--tenant',
              'one',
            ],
          };
    const digest = inheritedPluginMcpTransportDigest(config('first'), identity);
    expect(inheritedPluginMcpTransportDigest(config('rotated'), identity)).toBe(
      digest,
    );
    const changed =
      kind === 'url'
        ? {
            url: 'https://user:rotated@different.test/mcp?access_token=rotated&tenant=one',
          }
        : {
            command: 'node',
            args: [
              'different.js',
              '--api-key',
              'rotated',
              '--client-secret=rotated',
              '--tenant',
              'one',
            ],
          };
    expect(inheritedPluginMcpTransportDigest(changed, identity)).not.toBe(
      digest,
    );
  },
);

it.each(['handler', 'endpoint', 'method'])(
  'keeps authentication routing pinned for %s changes',
  (kind) => {
    const config = (value: string): Record<string, unknown> => {
      if (kind === 'handler')
        return { url: 'https://installed.test/mcp', httpAuthHandler: value };
      if (kind === 'endpoint')
        return {
          url: 'https://installed.test/mcp',
          oauth: { tokenEndpoint: `https://${value}.test/token` },
        };
      return { command: 'node', args: ['server.js', '--auth-method', value] };
    };
    expect(
      inheritedPluginMcpTransportDigest(config('changed'), identity),
    ).not.toBe(inheritedPluginMcpTransportDigest(config('original'), identity));
  },
);

it('pins credential environment selectors while allowing rotation under the same selector', () => {
  const config = (selector: string): Record<string, unknown> => ({
    type: 'http',
    url: 'https://installed.test/mcp',
    env_http_headers: { Authorization: selector },
  });
  const scopedBefore = process.env.COPILOT_PIN_SCOPED_TOKEN;
  const privateBefore = process.env.COPILOT_PIN_PRIVATE_SECRET;
  try {
    process.env.COPILOT_PIN_SCOPED_TOKEN = 'scoped-fixture-value';
    process.env.COPILOT_PIN_PRIVATE_SECRET = 'private-fixture-value';
    const original = config('COPILOT_PIN_SCOPED_TOKEN');
    const changed = config('COPILOT_PIN_PRIVATE_SECRET');
    expect(resolvePluginHttpHeaders(original).headers.Authorization).toBe(
      'scoped-fixture-value',
    );
    expect(resolvePluginHttpHeaders(changed).headers.Authorization).toBe(
      'private-fixture-value',
    );
    const digest = inheritedPluginMcpTransportDigest(original, identity);
    expect(inheritedPluginMcpTransportDigest(changed, identity)).not.toBe(
      digest,
    );
    process.env.COPILOT_PIN_SCOPED_TOKEN = 'rotated-fixture-value';
    expect(resolvePluginHttpHeaders(original).headers.Authorization).toBe(
      'rotated-fixture-value',
    );
    expect(inheritedPluginMcpTransportDigest(original, identity)).toBe(digest);
  } finally {
    if (scopedBefore === undefined) delete process.env.COPILOT_PIN_SCOPED_TOKEN;
    else process.env.COPILOT_PIN_SCOPED_TOKEN = scopedBefore;
    if (privateBefore === undefined)
      delete process.env.COPILOT_PIN_PRIVATE_SECRET;
    else process.env.COPILOT_PIN_PRIVATE_SECRET = privateBefore;
  }
});

it('rejects a changed credential selector before resolving inherited plugin secrets', async () => {
  const config = {
    type: 'http',
    url: 'https://installed.test/mcp',
    env_http_headers: { Authorization: 'COPILOT_PIN_SCOPED_TOKEN' },
  };
  const retained = snapshot(
    config,
    inheritedPluginMcpTransportDigest(config, identity),
  );
  readConfig.mockReturnValue({
    review: {
      ...config,
      env_http_headers: { Authorization: 'COPILOT_PIN_PRIVATE_SECRET' },
    },
  });
  resolvePlugins.mockResolvedValue({
    warnings: [],
    mcpServers: {},
    codexMcpServers: {},
    mcpServerBindings: {},
  });
  await expect(
    resolveDelegatedMcpCapabilities(retained, options()),
  ).rejects.toThrow('A selected Agent capability changed');
  expect(resolvePlugins).not.toHaveBeenCalled();
});
