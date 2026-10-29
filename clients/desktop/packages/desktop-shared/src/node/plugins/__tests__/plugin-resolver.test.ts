import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resetResolvedCanopyDataDirForTests } from '../../../canopy-paths';
import type { ChatTabPluginSelections } from '../../../types';
import type { MarketplaceInfo, PluginsCache } from '../../../types/plugins';
import {
  buildManagedMcpServerName,
  MANAGED_MCP_SERVER_NAME_MAX_LENGTH,
} from '../mcp-server-name';
import { resolveCwdRelativePathArg, resolvePlugins } from '../plugin-resolver';

function selections(
  pluginRefs: ChatTabPluginSelections['pluginRefs'],
  mcpServerRefs: ChatTabPluginSelections['mcpServerRefs'] = [],
): ChatTabPluginSelections {
  return {
    collectionIds: [],
    skillRefs: [],
    pluginRefs,
    mcpServerRefs,
    mcpHttpAuthPreferences: [],
  };
}

function makeMarketplace(
  pluginDir: string,
  facets: MarketplaceInfo['plugins'][number]['facets'],
): MarketplaceInfo {
  return {
    id: 'marketplace',
    name: 'Marketplace',
    description: '',
    sourceType: 'codex',
    sourceUrl: 'local',
    installLocation: path.dirname(pluginDir),
    lastUpdated: '2026-01-01T00:00:00.000Z',
    pluginCount: 1,
    validProviders: ['codex'],
    providerStatus: {
      claude: {
        provider: 'claude',
        state: 'invalid',
        accepted: false,
        pluginCount: 0,
        lastCheckedAt: '2026-01-01T00:00:00.000Z',
      },
      codex: {
        provider: 'codex',
        state: 'valid',
        accepted: true,
        pluginCount: 1,
        lastCheckedAt: '2026-01-01T00:00:00.000Z',
      },
    },
    plugins: [
      {
        name: 'demo-plugin',
        marketplaceId: 'marketplace',
        sourcePath: pluginDir,
        providerSupport: { claude: 'none', codex: 'native' },
        facets,
      },
    ],
  };
}

function writeMcpServer(
  dataDir: string,
  serverId: string,
  options: {
    name: string;
    configId?: string;
    configName?: string;
  },
): void {
  const filePath = path.join(dataDir, 'mcp-servers', `server-${serverId}.json`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${JSON.stringify(
      {
        version: 1,
        server: {
          definition: {
            id: serverId,
            name: options.name,
            description: '',
            type: 'command',
            command: 'node',
            args: ['server.js'],
            createdAt: '2026-03-22T00:00:00.000Z',
            updatedAt: '2026-03-22T00:00:00.000Z',
          },
          configs: [
            {
              id: options.configId ?? 'default',
              name: options.configName ?? 'Default',
              description: '',
              enabled: true,
              envVars: {},
              extraArgs: [],
              extraHeaders: {},
              createdAt: '2026-03-22T00:00:00.000Z',
              updatedAt: '2026-03-22T00:00:00.000Z',
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

describe('pipeline shared plugin resolver', () => {
  let tempDir: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-capabilities-'));
    previousDataDir = process.env.CANOPY_DATA_DIR;
    process.env.CANOPY_DATA_DIR = path.join(tempDir, 'data');
    resetResolvedCanopyDataDirForTests();
  });

  afterEach(() => {
    if (previousDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = previousDataDir;
    }
    resetResolvedCanopyDataDirForTests();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns a thread-scoped capability root for a native Codex plugin', () => {
    const pluginDir = path.join(tempDir, 'demo-plugin');
    fs.mkdirSync(path.join(pluginDir, '.codex-plugin'), { recursive: true });
    const cache: PluginsCache = {
      version: 2,
      lastRefreshed: '2026-01-01T00:00:00.000Z',
      marketplaces: [
        makeMarketplace(pluginDir, {
          codex: {
            provider: 'codex',
            mode: 'native',
            name: 'demo-plugin',
            installLocation: pluginDir,
            sourcePath: pluginDir,
          },
        }),
      ],
    };
    fs.mkdirSync(process.env.CANOPY_DATA_DIR ?? '', { recursive: true });
    fs.writeFileSync(
      path.join(process.env.CANOPY_DATA_DIR ?? '', 'plugins-cache.json'),
      JSON.stringify(cache),
    );

    const result = resolvePlugins(
      selections([{ marketplaceId: 'marketplace', pluginName: 'demo-plugin' }]),
      'project',
      'worktree',
      'step',
      { purpose: 'codex-session' },
    );

    expect(result.warnings).toEqual([]);
    expect(result.selectedCapabilityRoots).toHaveLength(1);
    expect(result.selectedCapabilityRoots[0]?.location).toEqual({
      type: 'environment',
      environmentId: 'local',
      path: pathToFileURL(pluginDir).href,
    });
  });

  it('projects native Codex plugins without MCP declarations', () => {
    const pluginDir = path.join(tempDir, 'demo-plugin');
    fs.mkdirSync(path.join(pluginDir, '.codex-plugin'), { recursive: true });
    fs.mkdirSync(path.join(pluginDir, 'skills', 'demo'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, '.codex-plugin', 'plugin.json'),
      JSON.stringify({ name: 'demo-plugin', mcpServers: '.mcp.json' }),
    );
    fs.writeFileSync(
      path.join(pluginDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          github: {
            command: '${CLAUDE_PLUGIN_ROOT}/bin/server',
            args: ['--plugin-root', '${CLAUDE_PLUGIN_ROOT}'],
            cwd: '.',
            env: { GITHUB_TOKEN: 'secret' },
          },
        },
      }),
    );
    fs.writeFileSync(
      path.join(pluginDir, 'skills', 'demo', 'SKILL.md'),
      '# Demo',
    );
    const cache: PluginsCache = {
      version: 2,
      lastRefreshed: '2026-01-01T00:00:00.000Z',
      marketplaces: [
        makeMarketplace(pluginDir, {
          codex: {
            provider: 'codex',
            mode: 'native',
            name: 'demo-plugin',
            installLocation: pluginDir,
            sourcePath: pluginDir,
          },
        }),
      ],
    };
    fs.mkdirSync(process.env.CANOPY_DATA_DIR ?? '', { recursive: true });
    fs.writeFileSync(
      path.join(process.env.CANOPY_DATA_DIR ?? '', 'plugins-cache.json'),
      JSON.stringify(cache),
    );
    const runtimeRoot = path.join(tempDir, 'runtime');

    const result = resolvePlugins(
      selections([{ marketplaceId: 'marketplace', pluginName: 'demo-plugin' }]),
      'project',
      'worktree',
      'step',
      {
        purpose: 'codex-session',
        runtimeDirs: {
          rootDir: runtimeRoot,
          claudePluginDir: path.join(runtimeRoot, 'claude'),
        },
      },
    );

    const projectedRootUrl = result.selectedCapabilityRoots[0]?.location.path;
    expect(projectedRootUrl).toBeDefined();
    const projectedRoot = new URL(projectedRootUrl ?? '').pathname;
    expect(projectedRoot).not.toBe(pluginDir);
    expect(fs.existsSync(path.join(projectedRoot, '.mcp.json'))).toBe(false);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(projectedRoot, '.codex-plugin', 'plugin.json'),
          'utf8',
        ),
      ),
    ).toEqual({ name: 'demo-plugin' });
    expect(
      fs.existsSync(path.join(projectedRoot, 'skills', 'demo', 'SKILL.md')),
    ).toBe(true);
    const [serverName] = Object.keys(result.mcpServers);
    expect(serverName).toBe(
      buildManagedMcpServerName({
        kind: 'plugin',
        friendlyParts: ['demo-plugin', 'github'],
        identityParts: ['marketplace', 'demo-plugin', 'github'],
      }),
    );
    expect(serverName?.length).toBeLessThanOrEqual(
      MANAGED_MCP_SERVER_NAME_MAX_LENGTH,
    );
    expect(result.mcpServers).toMatchObject({
      [serverName ?? 'missing']: {
        type: 'stdio',
        command: path.join(pluginDir, 'bin', 'server'),
        args: ['--plugin-root', pluginDir],
        cwd: pluginDir,
        env: { GITHUB_TOKEN: 'secret' },
      },
    });
    expect(serverName).not.toContain('secret');
    expect(JSON.stringify(result.selectedCapabilityRoots)).not.toContain(
      'secret',
    );
  });

  it('keeps cwd-relative stdio args of a native Codex plugin as written, since Codex starts the server in cwd', () => {
    // This resolver hands native Codex plugins only to Codex sessions, and
    // Codex honors `cwd`, so nothing is rewritten here. The desktop resolver
    // applies the shared helper for Claude and Cursor sessions instead.
    const pluginDir = path.join(tempDir, 'demo-plugin');
    fs.mkdirSync(path.join(pluginDir, '.codex-plugin'), { recursive: true });
    fs.mkdirSync(path.join(pluginDir, 'mcp'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, '.codex-plugin', 'plugin.json'),
      JSON.stringify({ name: 'demo-plugin', mcpServers: '.mcp.json' }),
    );
    fs.writeFileSync(path.join(pluginDir, 'mcp', 'server.mjs'), '');
    fs.writeFileSync(
      path.join(pluginDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          security: {
            command: 'node',
            args: ['./mcp/server.mjs', '--stdio'],
            cwd: '.',
          },
        },
      }),
    );
    const cache: PluginsCache = {
      version: 2,
      lastRefreshed: '2026-01-01T00:00:00.000Z',
      marketplaces: [
        makeMarketplace(pluginDir, {
          codex: {
            provider: 'codex',
            mode: 'native',
            name: 'demo-plugin',
            installLocation: pluginDir,
            sourcePath: pluginDir,
          },
        }),
      ],
    };
    fs.mkdirSync(process.env.CANOPY_DATA_DIR ?? '', { recursive: true });
    fs.writeFileSync(
      path.join(process.env.CANOPY_DATA_DIR ?? '', 'plugins-cache.json'),
      JSON.stringify(cache),
    );
    const runtimeRoot = path.join(tempDir, 'runtime');

    const result = resolvePlugins(
      selections([{ marketplaceId: 'marketplace', pluginName: 'demo-plugin' }]),
      'project',
      'worktree',
      'step',
      {
        purpose: 'codex-session',
        runtimeDirs: {
          rootDir: runtimeRoot,
          claudePluginDir: path.join(runtimeRoot, 'claude'),
        },
      },
    );

    const [serverName] = Object.keys(result.mcpServers);
    expect(result.mcpServers[serverName ?? 'missing']).toMatchObject({
      type: 'stdio',
      command: 'node',
      args: ['./mcp/server.mjs', '--stdio'],
      cwd: pluginDir,
    });
  });

  describe('resolveCwdRelativePathArg', () => {
    it('makes an explicit relative path and a bare script name absolute when the file exists', () => {
      const cwd = path.join(tempDir, 'plugin');
      fs.mkdirSync(path.join(cwd, 'mcp'), { recursive: true });
      fs.writeFileSync(path.join(cwd, 'mcp', 'server.mjs'), '');
      fs.writeFileSync(path.join(cwd, 'server.mjs'), '');
      expect(resolveCwdRelativePathArg('./mcp/server.mjs', cwd)).toBe(
        path.join(cwd, 'mcp', 'server.mjs'),
      );
      expect(resolveCwdRelativePathArg('server.mjs', cwd)).toBe(
        path.join(cwd, 'server.mjs'),
      );
    });

    it('leaves a bare name without an extension alone even when a same-named file exists', () => {
      // `config` or `serve` is a positional literal far more often than a
      // script, and the manifest cannot tell which; only a bare name that
      // looks like a file is treated as one.
      const cwd = path.join(tempDir, 'plugin');
      fs.mkdirSync(cwd, { recursive: true });
      fs.writeFileSync(path.join(cwd, 'config'), '');
      expect(resolveCwdRelativePathArg('config', cwd)).toBe('config');
    });

    it('leaves directories, flags, missing paths, empty, and absolute args alone', () => {
      const cwd = path.join(tempDir, 'plugin');
      fs.mkdirSync(path.join(cwd, 'mcp'), { recursive: true });
      for (const arg of [
        'mcp',
        '-m',
        '--stdio',
        './missing/server.mjs',
        '',
        '/abs/server.mjs',
      ]) {
        expect(resolveCwdRelativePathArg(arg, cwd)).toBe(arg);
      }
    });

    it('returns an arg unchanged instead of throwing when it cannot be stat-ed', () => {
      const cwd = path.join(tempDir, 'plugin');
      fs.mkdirSync(cwd, { recursive: true });
      const long = `${'a'.repeat(300)}.json`;
      expect(resolveCwdRelativePathArg(long, cwd)).toBe(long);
      expect(resolveCwdRelativePathArg('x\0y.js', cwd)).toBe('x\0y.js');
    });
  });

  it('keeps a bare cwd-relative script name as written for a native Codex plugin', () => {
    const pluginDir = path.join(tempDir, 'demo-plugin');
    fs.mkdirSync(path.join(pluginDir, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, '.codex-plugin', 'plugin.json'),
      JSON.stringify({ name: 'demo-plugin', mcpServers: '.mcp.json' }),
    );
    fs.writeFileSync(path.join(pluginDir, 'server.mjs'), '');
    fs.writeFileSync(
      path.join(pluginDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          bare: { command: 'node', args: ['server.mjs', 'serve'], cwd: '.' },
        },
      }),
    );
    const cache: PluginsCache = {
      version: 2,
      lastRefreshed: '2026-01-01T00:00:00.000Z',
      marketplaces: [
        makeMarketplace(pluginDir, {
          codex: {
            provider: 'codex',
            mode: 'native',
            name: 'demo-plugin',
            installLocation: pluginDir,
            sourcePath: pluginDir,
          },
        }),
      ],
    };
    fs.mkdirSync(process.env.CANOPY_DATA_DIR ?? '', { recursive: true });
    fs.writeFileSync(
      path.join(process.env.CANOPY_DATA_DIR ?? '', 'plugins-cache.json'),
      JSON.stringify(cache),
    );
    const runtimeRoot = path.join(tempDir, 'runtime');

    const result = resolvePlugins(
      selections([{ marketplaceId: 'marketplace', pluginName: 'demo-plugin' }]),
      'project',
      'worktree',
      'step',
      {
        purpose: 'codex-session',
        runtimeDirs: {
          rootDir: runtimeRoot,
          claudePluginDir: path.join(runtimeRoot, 'claude'),
        },
      },
    );

    const [serverName] = Object.keys(result.mcpServers);
    expect(result.mcpServers[serverName ?? 'missing']).toMatchObject({
      args: ['server.mjs', 'serve'],
    });
  });

  it('leaves stdio args that are not existing files under cwd untouched', () => {
    const pluginDir = path.join(tempDir, 'demo-plugin');
    fs.mkdirSync(path.join(pluginDir, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, '.codex-plugin', 'plugin.json'),
      JSON.stringify({ name: 'demo-plugin', mcpServers: '.mcp.json' }),
    );
    fs.mkdirSync(path.join(pluginDir, 'mcp'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          tool: {
            command: 'python',
            args: [
              '-m',
              'mcp',
              './missing/server.mjs',
              'docs/guide',
              '--stdio',
            ],
            cwd: '.',
          },
        },
      }),
    );
    const cache: PluginsCache = {
      version: 2,
      lastRefreshed: '2026-01-01T00:00:00.000Z',
      marketplaces: [
        makeMarketplace(pluginDir, {
          codex: {
            provider: 'codex',
            mode: 'native',
            name: 'demo-plugin',
            installLocation: pluginDir,
            sourcePath: pluginDir,
          },
        }),
      ],
    };
    fs.mkdirSync(process.env.CANOPY_DATA_DIR ?? '', { recursive: true });
    fs.writeFileSync(
      path.join(process.env.CANOPY_DATA_DIR ?? '', 'plugins-cache.json'),
      JSON.stringify(cache),
    );
    const runtimeRoot = path.join(tempDir, 'runtime');

    const result = resolvePlugins(
      selections([{ marketplaceId: 'marketplace', pluginName: 'demo-plugin' }]),
      'project',
      'worktree',
      'step',
      {
        purpose: 'codex-session',
        runtimeDirs: {
          rootDir: runtimeRoot,
          claudePluginDir: path.join(runtimeRoot, 'claude'),
        },
      },
    );

    const [serverName] = Object.keys(result.mcpServers);
    // `mcp` names an existing directory: a module or subcommand, never a
    // script, so it must stay as written.
    expect(result.mcpServers[serverName ?? 'missing']).toMatchObject({
      args: ['-m', 'mcp', './missing/server.mjs', 'docs/guide', '--stdio'],
    });
  });

  it('bounds long native plugin server keys without changing MCP configuration', () => {
    const marketplaceId =
      'production-integrations-marketplace-with-a-realistically-long-name';
    const pluginName =
      'production-hub-integration-plugin-with-a-realistically-long-name';
    const stdioServerName =
      'billing-profile-storage-and-account-context-command-server';
    const httpServerName =
      'registration-snapshot-and-dns-provider-records-http-server';
    const pluginDir = path.join(tempDir, pluginName);
    fs.mkdirSync(path.join(pluginDir, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, '.codex-plugin', 'plugin.json'),
      JSON.stringify({ name: pluginName, mcpServers: '.mcp.json' }),
    );
    fs.writeFileSync(
      path.join(pluginDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          [stdioServerName]: {
            command: '${CLAUDE_PLUGIN_ROOT}/bin/server',
            args: ['--root', '${CLAUDE_PLUGIN_ROOT}'],
            cwd: 'runtime',
            env: { SENTINEL_TOKEN: 'top-secret' },
            enabled_tools: ['lookup'],
            disabled_tools: ['delete'],
          },
          [httpServerName]: {
            type: 'http',
            url: 'https://mcp.example.test/${CLAUDE_PLUGIN_ROOT}',
            headers: { Authorization: 'Bearer top-secret' },
            default_tools_approval_mode: 'never',
          },
        },
      }),
    );
    const marketplace = makeMarketplace(pluginDir, {
      codex: {
        provider: 'codex',
        mode: 'native',
        name: pluginName,
        installLocation: pluginDir,
        sourcePath: pluginDir,
      },
    });
    marketplace.id = marketplaceId;
    const marketplacePlugin = marketplace.plugins[0];
    if (!marketplacePlugin) throw new Error('expected marketplace plugin');
    marketplacePlugin.name = pluginName;
    marketplacePlugin.marketplaceId = marketplaceId;
    const cache: PluginsCache = {
      version: 2,
      lastRefreshed: '2026-07-31T00:00:00.000Z',
      marketplaces: [marketplace],
    };
    fs.mkdirSync(process.env.CANOPY_DATA_DIR ?? '', { recursive: true });
    fs.writeFileSync(
      path.join(process.env.CANOPY_DATA_DIR ?? '', 'plugins-cache.json'),
      JSON.stringify(cache),
    );

    const result = resolvePlugins(
      selections([{ marketplaceId, pluginName }]),
      'project',
      'worktree',
      'step',
      {
        purpose: 'codex-session',
        runtimeDirs: {
          rootDir: path.join(tempDir, 'runtime'),
          claudePluginDir: path.join(tempDir, 'runtime', 'claude'),
        },
      },
    );
    const stdioKey = buildManagedMcpServerName({
      kind: 'plugin',
      friendlyParts: [pluginName, stdioServerName],
      identityParts: [marketplaceId, pluginName, stdioServerName],
    });
    const httpKey = buildManagedMcpServerName({
      kind: 'plugin',
      friendlyParts: [pluginName, httpServerName],
      identityParts: [marketplaceId, pluginName, httpServerName],
    });

    expect(Object.keys(result.mcpServers)).toEqual([stdioKey, httpKey]);
    expect(
      Object.keys(result.mcpServers).every(
        (key) => key.length <= MANAGED_MCP_SERVER_NAME_MAX_LENGTH,
      ),
    ).toBe(true);
    expect(stdioKey).not.toContain('top-secret');
    expect(httpKey).not.toContain('top-secret');
    expect(result.mcpServers[stdioKey]).toEqual({
      type: 'stdio',
      command: path.join(pluginDir, 'bin', 'server'),
      args: ['--root', pluginDir],
      cwd: path.join(pluginDir, 'runtime'),
      env: { SENTINEL_TOKEN: 'top-secret' },
      enabled_tools: ['lookup'],
      disabled_tools: ['delete'],
    });
    expect(result.mcpServers[httpKey]).toEqual({
      type: 'http',
      url: `https://mcp.example.test/${pluginDir}`,
      headers: { Authorization: 'Bearer top-secret' },
      default_tools_approval_mode: 'never',
    });
    expect(JSON.stringify(result.selectedCapabilityRoots)).not.toContain(
      'top-secret',
    );
  });

  it('projects standalone selected skills into a Codex capability root', () => {
    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    const skillDir = path.join(
      dataDir,
      'skills',
      process.platform === 'win32' ? 'custom%3Aapp' : 'custom:app',
      'review',
    );
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Review\n');
    const runtimeRoot = path.join(tempDir, 'runtime');

    const result = resolvePlugins(
      {
        ...selections([]),
        skillRefs: [{ sourceId: 'custom:app', skillName: 'review' }],
      },
      'project',
      'worktree',
      'step',
      {
        purpose: 'codex-session',
        runtimeDirs: {
          rootDir: runtimeRoot,
          claudePluginDir: path.join(runtimeRoot, 'claude'),
        },
      },
    );

    expect(result.warnings).toEqual([]);
    expect(result.selectedCapabilityRoots).toHaveLength(1);
    const rootUrl = result.selectedCapabilityRoots[0]?.location.path;
    expect(rootUrl).toBeDefined();
    const capabilityRoot = new URL(rootUrl ?? '').pathname;
    expect(
      fs.readFileSync(
        path.join(capabilityRoot, 'skills', 'review', 'SKILL.md'),
        'utf8',
      ),
    ).toBe('# Review\n');
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(capabilityRoot, '.codex-plugin', 'plugin.json'),
          'utf8',
        ),
      ),
    ).toEqual({ name: 'canopy-pipeline-skills' });
  });

  it('does not expose a Codex-only plugin to Claude steps', () => {
    const pluginDir = path.join(tempDir, 'demo-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    const cache: PluginsCache = {
      version: 2,
      lastRefreshed: '2026-01-01T00:00:00.000Z',
      marketplaces: [
        makeMarketplace(pluginDir, {
          codex: {
            provider: 'codex',
            mode: 'native',
            name: 'demo-plugin',
            installLocation: pluginDir,
            sourcePath: pluginDir,
          },
        }),
      ],
    };
    fs.mkdirSync(process.env.CANOPY_DATA_DIR ?? '', { recursive: true });
    fs.writeFileSync(
      path.join(process.env.CANOPY_DATA_DIR ?? '', 'plugins-cache.json'),
      JSON.stringify(cache),
    );

    const result = resolvePlugins(
      selections([{ marketplaceId: 'marketplace', pluginName: 'demo-plugin' }]),
      'project',
      'worktree',
      'step',
      { purpose: 'claude-session' },
    );

    expect(result.sdkPlugins).toEqual([]);
    expect(result.selectedCapabilityRoots).toEqual([]);
  });

  it('uses a null-prototype dictionary for standalone MCP servers', () => {
    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    writeMcpServer(dataDir, 'browser', { name: 'Browser' });

    const result = resolvePlugins(
      selections([], [{ serverId: 'browser', configId: 'default' }]),
      'project',
      'worktree',
      'step',
      { purpose: 'claude-session' },
    );

    expect(Object.getPrototypeOf(result.mcpServers)).toBeNull();
    const expectedName = buildManagedMcpServerName({
      kind: 'dynamic',
      friendlyParts: ['Browser'],
      identityParts: ['browser', 'default'],
    });
    expect(result.mcpServers).toMatchObject({
      [expectedName]: {
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
      },
    });
  });

  it('resolves colon-bearing skill source ids through Windows-safe directories', () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(
      process,
      'platform',
    );
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32',
    });

    try {
      const skillDir = path.join(
        process.env.CANOPY_DATA_DIR ?? '',
        'skills',
        'custom%3Aapp',
        'windows-helper',
      );
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Windows helper\n');

      const result = resolvePlugins(
        {
          collectionIds: [],
          skillRefs: [{ sourceId: 'custom:app', skillName: 'windows-helper' }],
          pluginRefs: [],
          mcpServerRefs: [],
          mcpHttpAuthPreferences: [],
        },
        'project',
        'worktree',
        'step',
        { purpose: 'codex-session' },
      );

      expect(result.warnings).toEqual([]);
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, 'platform', platformDescriptor);
      }
    }
  });

  it('resolves formerly reserved MCP server names under safe compact keys', () => {
    writeMcpServer(process.env.CANOPY_DATA_DIR ?? '', 'safe-server', {
      name: '__proto__',
    });
    writeMcpServer(process.env.CANOPY_DATA_DIR ?? '', '__proto__', {
      name: 'constructor',
    });

    const result = resolvePlugins(
      selections(
        [],
        [
          { serverId: 'safe-server', configId: 'default' },
          { serverId: '__proto__', configId: 'default' },
        ],
      ),
      'project',
      'worktree',
      'step',
      { purpose: 'claude-session' },
    );

    const keys = Object.keys(result.mcpServers);
    expect(keys).toHaveLength(2);
    expect(keys).toEqual(
      expect.arrayContaining([
        buildManagedMcpServerName({
          kind: 'dynamic',
          friendlyParts: ['__proto__'],
          identityParts: ['safe-server', 'default'],
        }),
        buildManagedMcpServerName({
          kind: 'dynamic',
          friendlyParts: ['constructor'],
          identityParts: ['__proto__', 'default'],
        }),
      ]),
    );
    expect(new Set(keys).size).toBe(2);
    expect(keys.every((key) => key.startsWith('appdyn-'))).toBe(true);
    expect(
      Object.prototype.hasOwnProperty.call(result.mcpServers, '__proto__'),
    ).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(result.mcpServers, 'constructor'),
    ).toBe(false);
    expect(Object.getPrototypeOf(result.mcpServers)).toBeNull();
    expect(Object.values(result.mcpServers)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'stdio', command: 'node' }),
        expect.objectContaining({ type: 'stdio', command: 'node' }),
      ]),
    );
    expect(result.warnings).toEqual([]);
  });

  it('keeps standalone names distinct when display labels collide', () => {
    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    writeMcpServer(dataDir, 'linear-one', { name: 'Linear' });
    writeMcpServer(dataDir, 'linear-two', { name: 'Linear' });

    const result = resolvePlugins(
      selections(
        [],
        [
          { serverId: 'linear-one', configId: 'default' },
          { serverId: 'linear-two', configId: 'default' },
        ],
      ),
      'project',
      'worktree',
      'step',
      { purpose: 'claude-session' },
    );

    const keys = Object.keys(result.mcpServers);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    expect(keys.every((key) => key.startsWith('appdyn-linear--'))).toBe(true);
  });

  it.each([
    { configName: 'Default', friendlyParts: ['Browser'] },
    { configName: 'Prod', friendlyParts: ['Browser', 'Prod'] },
  ])(
    'matches the Electron standalone key shape for a $configName config',
    ({ configName, friendlyParts }) => {
      const dataDir = process.env.CANOPY_DATA_DIR ?? '';
      const serverId = `shared-parity-${configName.toLowerCase()}`;
      const configId = `config-${configName.toLowerCase()}`;
      writeMcpServer(dataDir, serverId, {
        name: 'Browser',
        configId,
        configName,
      });

      const result = resolvePlugins(
        selections([], [{ serverId, configId }]),
        'project',
        'worktree',
        'step',
        { purpose: 'claude-session' },
      );
      const expectedElectronKey = buildManagedMcpServerName({
        kind: 'dynamic',
        friendlyParts,
        identityParts: [serverId, configId],
      });

      expect(Object.keys(result.mcpServers)).toEqual([expectedElectronKey]);
      expect(expectedElectronKey.length).toBeLessThanOrEqual(
        MANAGED_MCP_SERVER_NAME_MAX_LENGTH,
      );
    },
  );
});
