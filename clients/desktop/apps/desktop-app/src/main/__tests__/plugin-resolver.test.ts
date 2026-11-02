import type * as ClaudeInstalledPolicyModule from '../plugins/claude-enabled-plugins';
jest.mock('../plugins/claude-enabled-plugins', () => ({
  ...jest.requireActual<typeof ClaudeInstalledPolicyModule>(
    '../plugins/claude-enabled-plugins',
  ),
  readClaudeDisabledInstalledPlugins: jest.fn(() => []),
}));
import { installedItemKey } from '@canopy/protocol/installed-items';
const mockAssertSkillContext = jest.fn<Promise<void>, [string, string?]>(() =>
  Promise.resolve(),
);
jest.mock('../skills/skill-install-context', () => ({
  assertStoredSkillContext: (id: string, projectId?: string): Promise<void> =>
    mockAssertSkillContext(id, projectId),
}));
jest.mock('../mcp/oauth-token-store', () => ({
  migratePluginMcpOAuthToken: jest.fn(() => Promise.resolve()),
}));
jest.mock(
  '../mcp/account-catalog',
  (): Record<string, unknown> => ({
    accountMcpConnectionsEnabled: jest.fn((): boolean => true),
    loadAccountMcpRefConnections: jest.fn(),
  }),
);
import {
  accountMcpConnectionsEnabled,
  loadAccountMcpRefConnections,
} from '../mcp/account-catalog';
jest.mock('../canopy-cloud/mcp-connections', (): object => ({
  resolveAccountMcpProxyTarget: jest.fn(),
}));
import { resolveAccountMcpProxyTarget } from '../canopy-cloud/mcp-connections';
jest.mock(
  '../mcp/curated-catalog',
  (): Record<string, unknown> => ({
    readCachedCuratedMcpDesktopOnlyKeys: jest.fn(
      (): Promise<ReadonlySet<string>> => Promise.resolve(new Set()),
    ),
  }),
);
import { readCachedCuratedMcpDesktopOnlyKeys } from '../mcp/curated-catalog';
import type { McpHttpProxyService } from '../mcp/http-proxy-service';
import type * as CodexPluginProjectionModule from '@canopy/desktop-shared/node/plugins/codex-plugin-projection';
import type { InheritedCursorCapabilities } from '@canopy/desktop-shared/node/cursor/inherited-capabilities';

jest.mock('../lib/paths', () => ({
  getBundleConfigFilePath: jest.fn(),
  getChatPluginsRootDir: jest.fn(),
  getChatSkillPluginDir: jest.fn(),
  getDataDir: jest.fn(),
  getMcpServerFilePath: jest.fn(),
  getMcpServersIndexFilePath: jest.fn(),
}));
jest.mock('../skills/paths', () => ({
  getSkillDir: jest.fn(),
  getSkillsRootDir: jest.fn(),
  isBuiltinSourceId: jest.fn(() => false),
}));
jest.mock('../pipelines/config-paths', () => ({
  getBundledSkillDir: jest.fn(),
  getBundledSkillsDir: jest.fn(),
}));
jest.mock('../plugins/plugin-service', () => ({
  loadMarketplacesCacheOnly: jest
    .fn()
    .mockResolvedValue({ success: true, data: { marketplaces: [] } }),
  installPlugin: jest.fn(),
  loadMarketplaces: jest.fn(),
  buildCodexCompatDisabledKey: (
    marketplaceId: string,
    pluginName: string,
  ): string => `${marketplaceId}/${pluginName.toLowerCase()}`,
}));
jest.mock('../collections/collection-store', () => ({
  readCollectionConfig: jest.fn().mockResolvedValue(null),
}));
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn().mockResolvedValue({ mcpProxyPort: 37645 }),
}));
jest.mock('../mcp/http-proxy-service', () => ({
  getMcpHttpProxyService: jest.fn(() => ({
    ensureStarted: jest.fn().mockResolvedValue(undefined),
    registerRoute: jest.fn().mockResolvedValue('route'),
    unregisterRoute: jest.fn(),
    getProxyUrl: jest.fn(() => 'http://127.0.0.1:37645/route'),
  })),
}));
jest.mock('../mcp/oauth-probe', () => ({
  probeMcpHttpOAuthRequirement: jest.fn().mockResolvedValue({
    requirement: 'none',
    requiresOAuth: false,
    challenge: {},
  }),
}));
jest.mock('../plugins/codex-plugin-compat', () => ({
  BUILTIN_APP_PLUGIN_NAME: 'builtin-app-plugin',
  buildCodexQualifiedReferenceMap: jest.fn(() => new Map()),
  ensureAggregateCodexCompatiblePlugin: jest.fn(),
  ensureCodexCompatibleClaudePlugin: jest.fn(),
  readClaudePluginCompatibilitySource: jest.fn(),
  createGeneratedSkillName: jest.fn((name: string) => name),
}));
jest.mock('../plugins/codex-plugin-materialization-runner', () => ({
  materializeCodexPluginsOffMain: jest.fn(
    (options: {
      nativeProjectionRoot: string;
      plugins: Array<{
        pluginName: string;
        pluginPath: string;
        marketplaceId: string;
        category: string;
        removeMcpServers: boolean;
      }>;
    }) => {
      const { projectCodexPluginWithoutMcpServers } = jest.requireActual<
        typeof CodexPluginProjectionModule
      >('@canopy/desktop-shared/node/plugins/codex-plugin-projection');
      const warnings: string[] = [];
      return Promise.resolve({
        selectedPlugins: options.plugins.map((plugin) => ({
          pluginName: plugin.pluginName,
          category: plugin.category,
          cacheDir: plugin.removeMcpServers
            ? projectCodexPluginWithoutMcpServers({
                sourcePluginPath: plugin.pluginPath,
                marketplaceId: plugin.marketplaceId,
                pluginName: plugin.pluginName,
                projectionRootDir: options.nativeProjectionRoot,
                warnings,
              })
            : plugin.pluginPath,
        })),
        warnings,
      });
    },
  ),
}));

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  ChatTabPluginSelections,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import {
  normalizeMcpServerFile,
  type McpServerDefinitionData,
} from '@canopy/desktop-shared/types/mcp-servers';
import type { MarketplaceInfo } from '@canopy/desktop-shared/types/plugins';
import {
  buildManagedMcpServerName,
  MANAGED_MCP_SERVER_NAME_MAX_LENGTH,
} from '@canopy/desktop-shared/node/plugins/mcp-server-name';
import { resolvePlugins as resolveSharedPlugins } from '@canopy/desktop-shared/node/plugins/plugin-resolver';
import {
  mcpHttpAuthTargetKey,
  setMcpHttpAuthPreference,
} from '@canopy/desktop-shared/lib/mcp-http-auth';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';
import { probeMcpHttpOAuthRequirement } from '../mcp/oauth-probe';
import { installPlugin, loadMarketplaces } from '../plugins/plugin-service';
import {
  buildPluginHttpMcpServerForAuth,
  getLegacyPluginMcpOAuthIds,
} from '../plugins/plugin-mcp-auth';
import { migratePluginMcpOAuthToken } from '../mcp/oauth-token-store';
import {
  codexAggregateSkillInvocationNamesForRefs,
  discoverCursorPluginMembers,
  readPluginMcpAuthEntries,
  isConfiguredPromptPluginUsable,
  resolveHttpMcpHandler,
  resolvePlugins,
  type McpStdioBrokerForResolver,
} from '../plugins/plugin-resolver';
import { scanPluginDetails } from '../plugins/plugin-scanner';
import { cursorPluginFacetSupport } from '@canopy/plugin-interop/cursor-support';
import {
  getDataDir,
  getMcpServerFilePath,
  getMcpServersIndexFilePath,
} from '../lib/paths';
import { readPreferencesFile } from '../lib/preferences-store';
import {
  getSkillDir,
  getSkillsRootDir,
  isBuiltinSourceId,
} from '../skills/paths';
import {
  getBundledSkillDir,
  getBundledSkillsDir,
} from '../pipelines/config-paths';
import {
  getDesktopCodexCapabilityStore,
  resetDesktopCodexCapabilityStoreForTests,
} from '../codex/capability-store';
import { resolveDelegatedMcpCapabilities } from '../agents/delegation/agent-mcp-capabilities';
import {
  standaloneMcpTransportDigest,
  mcpTransportDigest,
} from '../agents/delegation/agent-mcp-fingerprint';

const loadMarketplacesMock = jest.mocked(loadMarketplaces);
const getDataDirMock = jest.mocked(getDataDir);
const getMcpServerFilePathMock = jest.mocked(getMcpServerFilePath);
const getSkillDirMock = jest.mocked(getSkillDir);
const getSkillsRootDirMock = jest.mocked(getSkillsRootDir);
const getBundledSkillDirMock = jest.mocked(getBundledSkillDir);
const getBundledSkillsDirMock = jest.mocked(getBundledSkillsDir);
const probeMcpHttpOAuthRequirementMock = jest.mocked(
  probeMcpHttpOAuthRequirement,
);
// Keep the legacy package input intact; these tests cover plugin fragments.
const legacyPluginFragmentKind = 'plugin_fragment' as never;

function makeTreeWritable(directory: string): void {
  if (!fs.existsSync(directory)) return;
  const stats = fs.lstatSync(directory);
  fs.chmodSync(directory, stats.isDirectory() ? 0o700 : 0o600);
  if (stats.isDirectory()) {
    for (const entry of fs.readdirSync(directory)) {
      makeTreeWritable(path.join(directory, entry));
    }
  }
}

function selections(): ChatTabPluginSelections {
  return {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [
      { marketplaceId: 'native-market', pluginName: 'native-plugin' },
    ],
    mcpServerRefs: [],
    mcpHttpAuthPreferences: [],
  };
}

function writeStandaloneMcpFixture(
  filePath: string,
  args: {
    serverId: string;
    definitionName: string;
    configId: string;
    configName: string;
    type: 'command' | 'http';
    httpAuthHandler?: 'canopy' | 'provider' | 'account';
    curatedKey?: string;
  },
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      version: 1,
      server: {
        definition: {
          id: args.serverId,
          name: args.definitionName,
          description: '',
          type: args.type,
          ...(args.curatedKey ? { curated: { key: args.curatedKey } } : {}),
          ...(args.type === 'command'
            ? { command: '/usr/bin/example-mcp', args: ['--serve'] }
            : {
                url: 'https://api.example.test/mcp',
                oauth: { usePkce: true },
                httpAuthHandler: args.httpAuthHandler ?? 'provider',
              }),
          createdAt: '2026-07-31T00:00:00.000Z',
          updatedAt: '2026-07-31T00:00:00.000Z',
        },
        configs: [
          {
            id: args.configId,
            name: args.configName,
            description: '',
            enabled: true,
            envVars: {},
            extraArgs: [],
            extraHeaders: {},
            createdAt: '2026-07-31T00:00:00.000Z',
            updatedAt: '2026-07-31T00:00:00.000Z',
          },
        ],
      },
    }),
  );
}

describe('plugin-resolver capability projection', () => {
  let tempDir: string;
  let previousCanopyDataDir: string | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-plugin-root-'));
    previousCanopyDataDir = process.env.CANOPY_DATA_DIR;
    getDataDirMock.mockReturnValue(tempDir);
    getSkillsRootDirMock.mockReturnValue(path.join(tempDir, 'skills'));
    resetDesktopCodexCapabilityStoreForTests();
  });

  it.each([
    'claude-session',
    'codex-session',
    'cursor-session',
    'copilot-session',
    'opencode-session',
  ] as const)(
    'does not load a Disabled plugin through pinned pipeline resources for %s',
    async (purpose) => {
      const ref = {
        kind: 'plugin',
        marketplaceId: 'market',
        pluginName: 'plugin',
      } as const;
      const rootPath = path.join(tempDir, 'pinned-plugin');
      fs.mkdirSync(rootPath, { recursive: true });
      const preferences = {
        ...(await readPreferencesFile()),
        disabledInstalledItems: [installedItemKey(ref)],
      };
      const resolved = await resolvePlugins(
        { collectionIds: [], skillRefs: [], pluginRefs: [] },
        'project',
        'worktree',
        'chat',
        {
          purpose,
          preferences,
          packageOverlay: {
            packageDigest: 'digest',
            resources: [
              {
                virtualSourceId: 'package:plugin',
                resourceId: 'resource',
                provider: 'claude',
                rootPath,
                kind: 'plugin_skill',
                displayName: 'plugin',
                invocationKeys: ['/plugin'],
                installedItemRef: ref,
              },
              {
                virtualSourceId: 'package:plugin',
                resourceId: 'resource',
                provider: 'codex',
                rootPath,
                kind: 'plugin_skill',
                displayName: 'plugin',
                invocationKeys: ['$plugin'],
                installedItemRef: ref,
              },
            ],
          },
        },
      );
      expect(resolved.sdkPlugins).toEqual([]);
      expect(resolved.selectedCapabilityRoots).toEqual([]);
      expect(
        resolved.warnings.filter((warning) => warning.includes('Disabled')),
      ).toHaveLength(1);
    },
  );

  it('refuses legacy pinned resources whose original identity cannot be checked against Disabled plugins', async () => {
    const rootPath = path.join(tempDir, 'legacy-pinned');
    fs.mkdirSync(rootPath, { recursive: true });
    const resolved = await resolvePlugins(
      { collectionIds: [], skillRefs: [], pluginRefs: [] },
      'project',
      'worktree',
      'chat',
      {
        purpose: 'claude-session',
        preferences: {
          ...(await readPreferencesFile()),
          disabledInstalledItems: [
            installedItemKey({
              kind: 'plugin',
              marketplaceId: 'market',
              pluginName: 'plugin',
            }),
          ],
        },
        packageOverlay: {
          packageDigest: 'legacy',
          resources: [
            {
              virtualSourceId: 'package:legacy',
              resourceId: 'opaque',
              provider: 'claude',
              rootPath,
              kind: 'plugin_skill',
              displayName: 'Plugin',
              invocationKeys: ['/legacy'],
            },
          ],
        },
      },
    );
    expect(resolved.sdkPlugins).toEqual([]);
    expect(resolved.warnings).toContain(
      'Pinned plugin resources without an original installed identity cannot be checked against Disabled items. Re-export the package before executing it.',
    );
  });

  it('keeps native OAuth identity stable while its matching Claude facet disappears and returns', async () => {
    const codexDir = path.join(tempDir, 'identity-codex');
    const claudeDir = path.join(tempDir, 'identity-claude');
    const raw = {
      type: 'http',
      url: 'https://identity.example.test/mcp',
      oauth: { clientId: 'shared-client' },
    };
    for (const [provider, directory] of [
      ['codex', codexDir],
      ['claude', claudeDir],
    ]) {
      fs.mkdirSync(path.join(directory, `.${provider}-plugin`), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(directory, `.${provider}-plugin`, 'plugin.json'),
        JSON.stringify({ name: 'identity', mcpServers: './servers.json' }),
      );
      fs.writeFileSync(
        path.join(directory, 'servers.json'),
        JSON.stringify({ mcpServers: { vendor: raw } }),
      );
    }
    const identity = async (
      primary: string | null,
    ): Promise<string | undefined> => {
      const [entry] = await readPluginMcpAuthEntries(
        codexDir,
        'market',
        'identity',
        'codex',
        primary,
      );
      return buildPluginHttpMcpServerForAuth(
        entry.identity,
        entry.rawValue,
        true,
      )?.definition.id;
    };
    const available = await identity(claudeDir);
    fs.renameSync(claudeDir, `${claudeDir}-away`);
    expect(await identity(null)).toBe(available);
    fs.renameSync(`${claudeDir}-away`, claudeDir);
    expect(await identity(claudeDir)).toBe(available);
    fs.writeFileSync(
      path.join(claudeDir, 'servers.json'),
      JSON.stringify({
        mcpServers: { vendor: { ...raw, oauth: { clientId: 'other-client' } } },
      }),
    );
    expect(await identity(claudeDir)).toBe(available);
  });

  it('retains a previously keyed grant from an equivalent primary declaration', async () => {
    const claudeDir = path.join(tempDir, 'previous-key-claude');
    const codexDir = path.join(tempDir, 'previous-key-codex');
    for (const [provider, directory] of [
      ['claude', claudeDir],
      ['codex', codexDir],
    ]) {
      fs.mkdirSync(path.join(directory, `.${provider}-plugin`), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(directory, `.${provider}-plugin`, 'plugin.json'),
        JSON.stringify({ name: 'normalized', mcpServers: './servers.json' }),
      );
      fs.writeFileSync(
        path.join(directory, 'servers.json'),
        JSON.stringify({
          mcpServers: {
            vendor: {
              url: 'https://vendor.test/mcp',
              oauth: {
                scopes:
                  provider === 'claude' ? ['write', 'read'] : ['read', 'write'],
              },
              headers: {
                [provider === 'claude' ? 'X-Tenant' : 'x-tenant']: 'team',
              },
            },
          },
        }),
      );
    }
    await readPluginMcpAuthEntries(
      codexDir,
      'market',
      'normalized',
      'codex',
      claudeDir,
    );
    // Recorded against the original declaration-key implementation, before normalization.
    expect(
      jest.mocked(migratePluginMcpOAuthToken).mock.calls.at(-1)?.[2],
    ).toEqual(
      expect.arrayContaining([
        {
          serverId: '296cfafd476d00089cef8281db9e51c4',
          configId: '4d5b459007cf491d5a7ef51a69c0b87d',
          allowDiscoveredClient: true,
        },
      ]),
    );
  });

  it('checks the original legacy slot for a distinct Codex declaration with explicit binding', async () => {
    const codexDir = path.join(tempDir, 'legacy-codex');
    const claudeDir = path.join(tempDir, 'legacy-claude');
    for (const [provider, directory, clientId] of [
      ['codex', codexDir, 'codex-client'],
      ['claude', claudeDir, 'claude-client'],
    ]) {
      fs.mkdirSync(path.join(directory, `.${provider}-plugin`), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(directory, `.${provider}-plugin`, 'plugin.json'),
        JSON.stringify({ name: 'legacy', mcpServers: './servers.json' }),
      );
      fs.writeFileSync(
        path.join(directory, 'servers.json'),
        JSON.stringify({
          mcpServers: {
            vendor: { url: 'https://vendor.test/mcp', oauth: { clientId } },
          },
        }),
      );
    }
    await readPluginMcpAuthEntries(
      codexDir,
      'market',
      'legacy',
      'codex',
      claudeDir,
    );
    expect(
      jest.mocked(migratePluginMcpOAuthToken).mock.calls.at(-1)?.[0].oauth
        ?.clientId,
    ).toBe('codex-client');
    expect(migratePluginMcpOAuthToken).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.arrayContaining([
        {
          ...getLegacyPluginMcpOAuthIds({
            marketplaceId: 'market',
            pluginName: 'legacy',
            serverName: 'vendor',
          }),
          allowDiscoveredClient: false,
        },
      ]),
    );
  });

  it.each(['fragment', 'environment'])(
    'preserves the legacy dynamic-client slot when %s equivalence changes',
    async (difference) => {
      const codexDir = path.join(tempDir, 'normalized-codex');
      const claudeDir = path.join(tempDir, 'normalized-claude');
      const names = ['PR3758_CLAUDE_AUTH', 'PR3758_CODEX_AUTH'];
      const previous = names.map((name) => process.env[name]);
      try {
        for (const name of names) process.env[name] = 'matching-test-secret';
        for (const [provider, directory] of [
          ['codex', codexDir],
          ['claude', claudeDir],
        ]) {
          fs.mkdirSync(path.join(directory, `.${provider}-plugin`), {
            recursive: true,
          });
          fs.writeFileSync(
            path.join(directory, `.${provider}-plugin`, 'plugin.json'),
            JSON.stringify({
              name: 'normalized',
              mcpServers: './servers.json',
            }),
          );
          fs.writeFileSync(
            path.join(directory, 'servers.json'),
            JSON.stringify({
              mcpServers: {
                vendor:
                  difference === 'fragment'
                    ? { url: `https://vendor.test/mcp#${provider}` }
                    : {
                        url: 'https://vendor.test/mcp',
                        env_http_headers: {
                          Authorization: `PR3758_${provider.toUpperCase()}_AUTH`,
                        },
                      },
              },
            }),
          );
        }
        const [entry] = await readPluginMcpAuthEntries(
          codexDir,
          'market',
          'normalized',
          'codex',
          claudeDir,
        );
        expect(entry.identity.authNamespace).toBe(
          difference === 'fragment' ? undefined : 'codex',
        );
        expect(migratePluginMcpOAuthToken).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          expect.arrayContaining([
            {
              ...getLegacyPluginMcpOAuthIds({
                marketplaceId: 'market',
                pluginName: 'normalized',
                serverName: 'vendor',
                authNamespace: difference === 'fragment' ? 'codex' : undefined,
              }),
              allowDiscoveredClient: true,
            },
          ]),
        );
      } finally {
        names.forEach((name, index) => {
          if (previous[index] === undefined) delete process.env[name];
          else process.env[name] = previous[index];
        });
      }
    },
  );

  it('requires a locally resolvable and provider-supported configured plugin', async (): Promise<void> => {
    const installedPath = path.join(tempDir, 'installed-plugin');
    fs.mkdirSync(installedPath);
    const marketplace = {
      id: 'test-market',
      name: 'Test Market',
      description: '',
      sourceType: 'local',
      sourceUrl: '',
      installLocation: tempDir,
      pluginCount: 2,
      validProviders: ['claude'],
      providerStatus: {
        claude: {
          provider: 'claude',
          state: 'valid',
          accepted: true,
          pluginCount: 2,
          lastCheckedAt: '2026-09-23T00:00:00.000Z',
        },
        codex: {
          provider: 'codex',
          state: 'invalid',
          accepted: false,
          pluginCount: 0,
          lastCheckedAt: '2026-09-23T00:00:00.000Z',
        },
      },
      plugins: [
        {
          name: 'stale-plugin',
          marketplaceId: 'test-market',
          sourcePath: path.join(tempDir, 'missing-plugin'),
          providerSupport: { claude: 'native', codex: 'none' },
          facets: {
            claude: {
              provider: 'claude',
              mode: 'native',
              name: 'stale-plugin',
              installLocation: path.join(tempDir, 'missing-plugin'),
              sourcePath: path.join(tempDir, 'missing-plugin'),
            },
          },
        },
        {
          name: 'unsupported-plugin',
          marketplaceId: 'test-market',
          sourcePath: installedPath,
          providerSupport: { claude: 'none', codex: 'none' },
          facets: {},
        },
      ],
    } satisfies MarketplaceInfo;

    await expect(
      isConfiguredPromptPluginUsable(
        { marketplaceId: marketplace.id, pluginName: 'stale-plugin' },
        [marketplace],
        'claude',
      ),
    ).resolves.toBe(false);
    await expect(
      isConfiguredPromptPluginUsable(
        { marketplaceId: marketplace.id, pluginName: 'unsupported-plugin' },
        [marketplace],
        'codex',
      ),
    ).resolves.toBe(false);
  });

  it.each([
    'connected',
    'signed out',
    'missing',
    'REAUTH_REQUIRED',
    'unsupported-capability',
    'proxy unavailable',
  ])('resolves account standalone MCP: %s', async (state): Promise<void> => {
    const serverFile = path.join(tempDir, 'account.json');
    writeStandaloneMcpFixture(serverFile, {
      serverId: 'account-local',
      configId: 'local-config',
      definitionName: 'Account server',
      configName: 'Default',
      type: 'http',
      httpAuthHandler: 'account',
      curatedKey: 'github',
    });
    getMcpServerFilePathMock.mockReturnValue(serverFile);
    const indexPath = path.join(tempDir, 'index.json');
    jest.mocked(getMcpServersIndexFilePath).mockReturnValue(indexPath);
    fs.writeFileSync(
      indexPath,
      JSON.stringify({
        servers: [
          {
            id: 'account-local',
            scope: 'account',
            accountConnectionId: 'account-id',
          },
        ],
      }),
    );
    jest.mocked(resolveAccountMcpProxyTarget).mockResolvedValue({
      upstreamUrl: 'https://cloud.example.test/api/v1/mcp-proxy/web-route',
      connection: {
        id: 'account-id',
        serverKey: 'github',
        configId: 'default',
        status: 'CONNECTED',
        routeId: 'web-route',
        enabledTools: null,
        displayName: 'GitHub',
        kind: 'CURATED',
      },
    });
    if (state !== 'connected' && state !== 'proxy unavailable')
      jest
        .mocked(resolveAccountMcpProxyTarget)
        .mockRejectedValue(new Error(state));
    const proxy = {
      ensureStarted: jest.fn().mockResolvedValue(undefined),
      registerRoute: jest.fn().mockResolvedValue('local-route'),
      unregisterRoute: jest.fn(),
      getProxyUrl: jest.fn((): string => 'http://127.0.0.1:37645/local-route'),
    };
    const result = await resolvePlugins(
      {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [
          { serverId: 'account-local', configId: 'local-config' },
        ],
      },
      'project',
      'worktree',
      'chat',
      {
        enableHttpMcpProxy: state !== 'proxy unavailable',
        mcpHttpProxyService: proxy,
      },
    );
    if (state === 'connected') {
      expect(resolveAccountMcpProxyTarget).toHaveBeenCalledWith(
        expect.objectContaining({
          curatedKey: 'github',
          accountConnectionId: 'account-id',
        }),
      );
      expect(proxy.registerRoute).toHaveBeenCalledWith(
        expect.objectContaining({
          upstreamUrl: 'https://cloud.example.test/api/v1/mcp-proxy/web-route',
          authSupplier: 'canopy-cloud',
          oauthEnabled: false,
          headers: {},
        }),
      );
      expect(Object.values(result.mcpServers)).toEqual([
        {
          type: 'http',
          url: 'http://127.0.0.1:37645/local-route',
          headers: undefined,
        },
      ]);
    } else {
      expect(result.mcpServers).toEqual({});
      expect(result.warnings.join(' ')).toContain(
        state === 'proxy unavailable' ? 'proxy is unavailable' : state,
      );
      expect(proxy.registerRoute).not.toHaveBeenCalled();
    }
    expect(probeMcpHttpOAuthRequirement).not.toHaveBeenCalled();
  });

  it('defaults account scope to account while retaining definition and chat precedence', (): void => {
    const definition: McpServerDefinitionData = {
      id: 's',
      name: 'S',
      description: '',
      type: 'http',
      url: 'https://example.test',
      createdAt: '',
      updatedAt: '',
    };
    const target = {
      kind: 'standalone' as const,
      serverId: 's',
      configId: 'c',
    };
    const context: Parameters<typeof resolveHttpMcpHandler>[0]['context'] = {
      capabilityIdentities: {},
      selections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
      defaultHandler: 'canopy' as const,
      proxyAvailable: true,
      proxyFallbackWarningEmitted: false,
      boundServers: new Map(),
    };
    expect(
      resolveHttpMcpHandler({
        warnings: [],
        context,
        definition,
        target,
        indexEntry: { scope: 'account' },
      }).handler,
    ).toBe('account');
    expect(
      resolveHttpMcpHandler({
        warnings: [],
        context,
        definition: { ...definition, httpAuthHandler: 'provider' },
        target,
        indexEntry: { scope: 'account' },
      }).handler,
    ).toBe('provider');
    expect(
      resolveHttpMcpHandler({
        warnings: [],
        context: {
          ...context,
          selections: {
            ...context.selections,
            mcpHttpAuthPreferences: [{ target, handler: 'account' }],
          },
        },
        definition: { ...definition, httpAuthHandler: 'provider' },
        target,
      }).handler,
    ).toBe('account');
  });

  it('rejects installed skill paths outside the skills root', () => {
    const outsideSkillDir = path.join(tempDir, 'outside', 'review');
    fs.mkdirSync(outsideSkillDir, { recursive: true });
    fs.writeFileSync(path.join(outsideSkillDir, 'SKILL.md'), '# Review\n');
    getSkillDirMock.mockReturnValue(outsideSkillDir);
    const warnings: string[] = [];

    expect(
      codexAggregateSkillInvocationNamesForRefs(
        [{ sourceId: 'custom:local', skillName: 'review' }],
        warnings,
      ),
    ).toEqual(new Map());
    expect(warnings).toEqual([
      'Skill "review" (source: custom:local) resolved outside the skills root, skipping.',
    ]);
  });

  it('rejects builtin skill paths outside the bundled skills root', () => {
    const bundledRoot = path.join(tempDir, 'bundled-skills');
    getBundledSkillsDirMock.mockReturnValue(bundledRoot);
    getBundledSkillDirMock.mockReturnValue(path.join(tempDir, 'outside'));
    jest.mocked(isBuiltinSourceId).mockReturnValue(true);
    const warnings: string[] = [];

    expect(
      codexAggregateSkillInvocationNamesForRefs(
        [{ sourceId: 'builtin:app', skillName: '../../outside' }],
        warnings,
      ),
    ).toEqual(new Map());
    expect(warnings).toEqual([
      'Skill "../../outside" (source: builtin:app) resolved outside the skills root, skipping.',
    ]);
  });

  afterEach(() => {
    if (previousCanopyDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = previousCanopyDataDir;
    }
    resetResolvedCanopyDataDirForTests();
    makeTreeWritable(tempDir);
    fs.rmSync(tempDir, { recursive: true, force: true });
    resetDesktopCodexCapabilityStoreForTests();
  });

  it('classifies standalone handler precedence as override, server, or default', () => {
    const target = {
      kind: 'standalone' as const,
      serverId: 'server-1',
      configId: 'config-1',
    };
    const selections: ChatTabPluginSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
      mcpHttpAuthPreferences: [],
    };
    const context: Parameters<typeof resolveHttpMcpHandler>[0]['context'] = {
      capabilityIdentities: {},
      selections,
      defaultHandler: 'provider' as const,
      proxyAvailable: true,
      proxyFallbackWarningEmitted: false,
      boundServers: new Map(),
    };
    const definition: McpServerDefinitionData = {
      id: 'server-1',
      name: 'Server',
      description: '',
      type: 'http',
      url: 'https://mcp.example.test',
      httpAuthHandler: 'canopy',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    };

    expect(
      resolveHttpMcpHandler({
        warnings: [],
        context,
        target,
        definition,
      }),
    ).toEqual({ handler: 'canopy', source: 'server' });
    expect(resolveHttpMcpHandler({ warnings: [], context, target })).toEqual({
      handler: 'provider',
      source: 'default',
    });

    // A delegated pin is the parent's effective handler: it beats the server
    // and global defaults but is never reported as a user override.
    const pinned = {
      ...context,
      pinnedHandlers: new Map([
        [mcpHttpAuthTargetKey(target), 'provider' as const],
      ]),
    };
    expect(
      resolveHttpMcpHandler({
        warnings: [],
        context: pinned,
        target,
        definition,
      }),
    ).toEqual({ handler: 'provider', source: 'pinned' });

    selections.mcpHttpAuthPreferences = [{ target, handler: 'provider' }];
    expect(
      resolveHttpMcpHandler({
        warnings: [],
        context,
        target,
        definition,
      }),
    ).toEqual({ handler: 'provider', source: 'override' });
    expect(
      resolveHttpMcpHandler({
        warnings: [],
        context: {
          ...pinned,
          pinnedHandlers: new Map([
            [mcpHttpAuthTargetKey(target), 'canopy' as const],
          ]),
        },
        target,
        definition,
      }),
    ).toEqual({ handler: 'provider', source: 'override' });
  });

  it('reuses a preference snapshot supplied by the overlay preflight', async () => {
    const preferences = {
      mcpProxyPort: 37645,
    } as PreferencesData;

    await resolvePlugins(
      {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      'project',
      'worktree',
      'chat',
      { preferences },
    );

    expect(readPreferencesFile).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'routes plugin-declared account connections by curated key (available=%s)',
    async (available): Promise<void> => {
      const pluginDir = path.join(tempDir, 'account-plugin');
      fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(
        path.join(pluginDir, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'account-plugin', mcpServers: './.mcp.json' }),
      );
      fs.writeFileSync(
        path.join(pluginDir, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            github: {
              type: 'http',
              url: 'https://upstream.example.test',
              curated: { key: 'github' },
              headers: { Authorization: 'local-secret' },
            },
          },
        }),
      );
      const packageDigest = `pp:v1:${'A'.repeat(43)}`;
      const connection = {
        id: 'a',
        serverKey: 'github',
        configId: 'default',
        displayName: 'GitHub',
        kind: 'CURATED' as const,
        status: 'CONNECTED' as const,
        routeId: 'r',
        enabledTools: null,
      };
      jest.mocked(resolveAccountMcpProxyTarget).mockResolvedValue({
        upstreamUrl: 'https://cloud.example.test/api/v1/mcp-proxy/r',
        connection,
      });
      if (!available)
        jest
          .mocked(resolveAccountMcpProxyTarget)
          .mockRejectedValue(new Error('connection missing'));
      const proxy = {
        ensureStarted: jest.fn().mockResolvedValue(undefined),
        registerRoute: jest.fn().mockResolvedValue('route'),
        unregisterRoute: jest.fn(),
        getProxyUrl: jest.fn((): string => 'http://127.0.0.1:37645/route'),
      };
      const result = await resolvePlugins(
        {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
          mcpHttpAuthPreferences: [
            {
              target: {
                kind: 'plugin',
                marketplaceId: `pipeline-package:${packageDigest}`,
                pluginName: 'account-plugin',
                serverName: 'github',
              },
              handler: 'account',
            },
          ],
        },
        'project',
        'worktree',
        'chat',
        {
          purpose: 'claude-session',
          enableHttpMcpProxy: true,
          mcpHttpProxyService: proxy,
          runtimeDirs: {
            rootDir: tempDir,
            claudePluginDir: path.join(tempDir, 'runtime'),
          },
          packageOverlay: {
            packageDigest,
            resources: [
              {
                virtualSourceId: 'pipeline-package:account-plugin',
                resourceId: 'account-plugin',
                provider: 'claude',
                rootPath: pluginDir,
                kind: legacyPluginFragmentKind,
                displayName: 'Account plugin',
                invocationKeys: [],
              },
            ],
          },
        },
      );
      expect(resolveAccountMcpProxyTarget).toHaveBeenCalledWith(
        expect.objectContaining({ curatedKey: 'github' }),
      );
      if (available) {
        expect(proxy.registerRoute).toHaveBeenCalledWith(
          expect.objectContaining({
            upstreamUrl: 'https://cloud.example.test/api/v1/mcp-proxy/r',
            authSupplier: 'canopy-cloud',
            headers: {},
            oauthEnabled: false,
          }),
        );
        expect(Object.values(result.mcpServers)).toEqual([
          {
            type: 'http',
            url: 'http://127.0.0.1:37645/route',
            headers: undefined,
          },
        ]);
      } else expect(result.mcpServers).toEqual({});
    },
  );

  it('resolves a packaged plugin without a global marketplace entry', async () => {
    const pluginDir = path.join(tempDir, 'pipeline-package-plugin');
    fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, '.claude-plugin', 'plugin.json'),
      '{"name":"pipeline-package-plugin"}',
    );
    loadMarketplacesMock.mockResolvedValue({
      success: true,
      data: { version: 2, lastRefreshed: '', marketplaces: [] },
    });

    const resolved = await resolvePlugins(
      {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      'project',
      'worktree',
      'chat',
      {
        purpose: 'claude-session',
        packageOverlay: {
          packageDigest: `pp:v1:${'A'.repeat(43)}`,
          resources: [
            {
              virtualSourceId: 'pipeline-package:resource-1',
              resourceId: 'resource-1',
              provider: 'claude',
              rootPath: pluginDir,
              kind: legacyPluginFragmentKind,
              displayName: 'Packaged plugin',
              invocationKeys: [],
            },
          ],
        },
      },
    );

    expect(resolved.sdkPlugins).toContainEqual({
      type: 'local',
      path: pluginDir,
    });
  });

  it.each([
    'codex-only',
    'shared',
    'different-url',
    'different-client',
  ] as const)(
    'projects a native Codex plugin with %s auth as a selected capability root',
    async (facetCase) => {
      const pluginDir = path.join(tempDir, 'native-plugin');
      const oauthServer = {
        type: 'http',
        url: 'https://hub.example.test/mcp',
        oauth: { usePkce: true },
      };
      const claudeDir = path.join(tempDir, 'claude-plugin');
      if (facetCase !== 'codex-only') {
        fs.mkdirSync(path.join(claudeDir, '.claude-plugin'), {
          recursive: true,
        });
        fs.writeFileSync(
          path.join(claudeDir, '.claude-plugin', 'plugin.json'),
          JSON.stringify({ name: 'native-plugin', mcpServers: './.mcp.json' }),
        );
        fs.writeFileSync(
          path.join(claudeDir, '.mcp.json'),
          JSON.stringify({
            mcpServers: {
              'oauth-hub': {
                ...oauthServer,
                ...(facetCase === 'different-url'
                  ? { url: 'https://claude.example.test/mcp' }
                  : {}),
                ...(facetCase === 'different-client'
                  ? { oauth: { clientId: 'claude-client', usePkce: true } }
                  : {}),
              },
            },
          }),
        );
      }
      fs.mkdirSync(path.join(pluginDir, '.codex-plugin'), { recursive: true });
      fs.writeFileSync(
        path.join(pluginDir, '.codex-plugin', 'plugin.json'),
        '{"name":"native-plugin","mcpServers":"./.mcp.json"}',
      );
      fs.writeFileSync(
        path.join(pluginDir, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            secret: {
              type: 'stdio',
              command: '/usr/bin/secret-mcp',
              cwd: '.',
              env: { SENTINEL_SECRET: 'sentinel-secret-value' },
            },
            'oauth-hub': oauthServer,
          },
        }),
      );
      loadMarketplacesMock.mockResolvedValue({
        success: true,
        data: {
          version: 2,
          lastRefreshed: '2026-07-21T00:00:00.000Z',
          marketplaces: [
            {
              id: 'native-market',
              name: 'Native Market',
              description: '',
              sourceType: 'local',
              sourceUrl: '',
              installLocation: tempDir,
              pluginCount: 1,
              validProviders: ['codex'],
              providerStatus: {
                claude: {
                  provider: 'claude',
                  state: 'invalid',
                  accepted: false,
                  pluginCount: 0,
                  lastCheckedAt: '2026-07-21T00:00:00.000Z',
                },
                codex: {
                  provider: 'codex',
                  state: 'valid',
                  accepted: true,
                  pluginCount: 1,
                  lastCheckedAt: '2026-07-21T00:00:00.000Z',
                },
              },
              plugins: [
                {
                  name: 'native-plugin',
                  marketplaceId: 'native-market',
                  sourcePath: pluginDir,
                  providerSupport: { claude: 'none', codex: 'native' },
                  facets: {
                    ...(facetCase !== 'codex-only'
                      ? {
                          claude: {
                            provider: 'claude' as const,
                            mode: 'native' as const,
                            name: 'native-plugin',
                            installLocation: claudeDir,
                            sourcePath: claudeDir,
                          },
                        }
                      : {}),
                    codex: {
                      provider: 'codex',
                      mode: 'native',
                      name: 'native-plugin',
                      installLocation: pluginDir,
                      sourcePath: pluginDir,
                    },
                  },
                },
              ],
            },
          ],
        },
      });

      const registerStdioMcpRoute: jest.MockedFunction<
        McpStdioBrokerForResolver['registerStdioMcpRoute']
      > = jest.fn<
        ReturnType<McpStdioBrokerForResolver['registerStdioMcpRoute']>,
        Parameters<McpStdioBrokerForResolver['registerStdioMcpRoute']>
      >(() =>
        Promise.resolve({
          routeId:
            '0123456789abcdef0123456789abcdef.0123456789abcdef0123456789abcdef0123456789abcdef',
          capabilityId:
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          command: '/opt/canopy',
          args: [
            '__codex-mcp-stdio-launcher',
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            '0123456789abcdef0123456789abcdef.0123456789abcdef0123456789abcdef0123456789abcdef',
          ],
        }),
      );
      const mcpHttpProxyService = {
        ensureStarted: jest.fn().mockResolvedValue(undefined),
        registerRoute: jest
          .fn<
            ReturnType<McpHttpProxyService['registerRoute']>,
            Parameters<McpHttpProxyService['registerRoute']>
          >()
          .mockResolvedValue('plugin-oauth-route'),
        unregisterRoute: jest.fn(),
        getProxyUrl: jest.fn(() => 'http://127.0.0.1:37645/plugin-oauth-route'),
      };
      const rename = fs.promises.rename.bind(fs.promises);
      const renameSpy = jest
        .spyOn(fs.promises, 'rename')
        .mockImplementation(async (oldPath, newPath) => {
          const isCapabilityPublication = path
            .basename(String(oldPath))
            .startsWith('.publish-');
          if (isCapabilityPublication) {
            // The QA sandbox denies renaming a read-only directory. Keep the
            // production publication path intact while adapting this test setup.
            await fs.promises.chmod(oldPath, 0o700);
          }
          await rename(oldPath, newPath);
          if (isCapabilityPublication) {
            await fs.promises.chmod(newPath, 0o500);
          }
        });
      let result: Awaited<ReturnType<typeof resolvePlugins>>;
      try {
        result = await resolvePlugins(
          selections(),
          'project',
          'worktree',
          'chat',
          {
            purpose: 'codex-session',
            sessionId: 'chat',
            mcpStdioBroker: {
              registerStdioMcpRoute,
            },
            enableHttpMcpProxy: true,
            mcpHttpProxyService,
          },
        );
      } finally {
        renameSpy.mockRestore();
      }

      const pluginRegistrationCall = registerStdioMcpRoute.mock.calls[0];
      const pluginServerName = buildManagedMcpServerName({
        kind: 'plugin',
        friendlyParts: ['native-plugin', 'secret'],
        identityParts: ['native-market', 'native-plugin', 'secret'],
      });
      expect(pluginRegistrationCall?.[0]).toEqual(
        expect.objectContaining({
          routeKey: pluginServerName,
          cwd: pluginDir,
        }),
      );
      expect(pluginRegistrationCall?.[1]?.signal).toBeInstanceOf(AbortSignal);
      expect(pluginServerName.length).toBeLessThanOrEqual(
        MANAGED_MCP_SERVER_NAME_MAX_LENGTH,
      );
      expect(Object.keys(result.mcpServers)).toContain(pluginServerName);
      expect(Object.keys(result.codexMcpServers)).toContain(pluginServerName);
      const oauthServerName = buildManagedMcpServerName({
        kind: 'plugin',
        friendlyParts: ['native-plugin', 'oauth-hub'],
        identityParts: ['native-market', 'native-plugin', 'oauth-hub'],
      });
      const primaryAuth = buildPluginHttpMcpServerForAuth(
        {
          marketplaceId: 'native-market',
          pluginName: 'native-plugin',
          serverName: 'oauth-hub',
        },
        {
          ...oauthServer,
          ...(facetCase === 'different-url'
            ? { url: 'https://claude.example.test/mcp' }
            : {}),
          ...(facetCase === 'different-client'
            ? { oauth: { clientId: 'claude-client', usePkce: true } }
            : {}),
        },
        true,
      );
      const distinct =
        facetCase === 'different-url' || facetCase === 'different-client';
      const [actualRoute] = mcpHttpProxyService.registerRoute.mock.calls[0];
      if (distinct)
        expect(actualRoute.serverId).not.toBe(primaryAuth?.definition.id);
      else expect(actualRoute.serverId).toBe(primaryAuth?.definition.id);
      const expectedPluginAuth = buildPluginHttpMcpServerForAuth(
        {
          marketplaceId: 'native-market',
          pluginName: 'native-plugin',
          serverName: 'oauth-hub',
          ...(distinct ? { authNamespace: 'codex' as const } : {}),
        },
        oauthServer,
        true,
      );
      expect(expectedPluginAuth).not.toBeNull();
      expect(mcpHttpProxyService.registerRoute).toHaveBeenCalledWith(
        expect.objectContaining({
          serverId: expectedPluginAuth?.definition.id,
          configId: expectedPluginAuth?.config.id,
          displayName: 'native-plugin/oauth-hub',
          oauthDefinition: expectedPluginAuth?.definition,
          oauthConfig: expectedPluginAuth?.config,
        }),
      );
      expect(Object.keys(result.mcpServers)).toContain(oauthServerName);
      expect(Object.keys(result.codexMcpServers)).toContain(oauthServerName);
      expect(result.codexMcpServers[oauthServerName]).toEqual(
        expect.objectContaining({ required: false }),
      );
      expect(result.warnings).toEqual([]);
      expect(result.selectedCapabilityRoots).toHaveLength(1);
      expect(result.selectedCapabilityRoots[0]?.id).toMatch(/^[a-f0-9]{64}$/);
      expect(result.selectedCapabilityRoots[0]?.location).toEqual({
        type: 'environment',
        environmentId: 'local',
        path: pathToFileURL(
          path.join(
            tempDir,
            'codex-capabilities',
            'v1',
            'roots',
            result.selectedCapabilityRoots[0]?.id ?? '',
          ),
        ).href,
      });
      expect(JSON.stringify(result.codexMcpServers)).not.toContain(
        'sentinel-secret-value',
      );
      expect(JSON.stringify(result.codexMcpServers)).not.toContain(
        'CANOPY_CODEX_MCP_ROUTE',
      );
      const publishedRootPath = path.join(
        tempDir,
        'codex-capabilities',
        'v1',
        'roots',
        result.selectedCapabilityRoots[0]?.id ?? '',
      );
      expect(fs.existsSync(path.join(publishedRootPath, '.mcp.json'))).toBe(
        false,
      );
      expect(
        fs.readFileSync(
          path.join(publishedRootPath, '.codex-plugin', 'plugin.json'),
          'utf8',
        ),
      ).not.toContain('mcpServers');
    },
  );

  it('degrades temp-directory creation failures into capability warnings', async () => {
    getDataDirMock.mockReturnValue(path.join(tempDir, 'missing', 'data'));
    loadMarketplacesMock.mockResolvedValue({
      success: true,
      data: { version: 2, lastRefreshed: '', marketplaces: [] },
    });

    const result = await resolvePlugins(
      {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      'project',
      'worktree',
      'chat',
      { purpose: 'codex-session' },
    );

    expect(result.selectedCapabilityRoots).toEqual([]);
    expect(result.warnings.join('\n')).toContain(
      'could not be materialized and were skipped',
    );
  });

  it('reports publication failures as publication warnings', async () => {
    loadMarketplacesMock.mockResolvedValue({
      success: true,
      data: { version: 2, lastRefreshed: '', marketplaces: [] },
    });
    jest
      .spyOn(getDesktopCodexCapabilityStore(), 'publishSelectedRoots')
      .mockRejectedValueOnce(new Error('publish unavailable'));

    const result = await resolvePlugins(
      {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      'project',
      'worktree',
      'chat',
      { purpose: 'codex-session' },
    );

    expect(result.selectedCapabilityRoots).toEqual([]);
    expect(result.warnings).toContain(
      'Codex plugin capabilities could not be published and were skipped: publish unavailable',
    );
    expect(result.warnings.join('\n')).not.toContain(
      'could not be materialized and were skipped',
    );
  });

  it('keeps capability resolution successful when temp cleanup fails', async () => {
    loadMarketplacesMock.mockResolvedValue({
      success: true,
      data: { version: 2, lastRefreshed: '', marketplaces: [] },
    });
    const rmSpy = jest
      .spyOn(fs.promises, 'rm')
      .mockRejectedValueOnce(new Error('temporary directory is busy'));

    try {
      const result = await resolvePlugins(
        {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
        },
        'project',
        'worktree',
        'chat',
        { purpose: 'codex-session' },
      );

      expect(result.selectedCapabilityRoots).toEqual([]);
      expect(result.warnings).toContain(
        'Temporary Codex capability files could not be removed: temporary directory is busy',
      );
    } finally {
      rmSpy.mockRestore();
    }
  });

  describe('account selections', (): void => {
    const connection = {
      id: 'account-id',
      serverKey: 'github',
      configId: 'default',
      displayName: 'GitHub',
      status: 'CONNECTED' as const,
      kind: 'CURATED' as const,
      routeId: 'cloud-route',
      enabledTools: null,
    };
    const custom = {
      ...connection,
      id: 'custom-connection-id',
      serverKey: 'custom:11111111-2222-4333-8444-555555555555',
      displayName: 'Internal tools',
      kind: 'CUSTOM' as const,
      routeId: 'custom-route',
    };
    let proxy: {
      ensureStarted: jest.Mock;
      registerRoute: jest.Mock;
      unregisterRoute: jest.Mock;
      getProxyUrl: jest.Mock;
    };

    beforeEach((): void => {
      jest
        .mocked(loadAccountMcpRefConnections)
        .mockResolvedValue([connection, custom]);
      jest
        .mocked(resolveAccountMcpProxyTarget)
        .mockImplementation(({ accountConnectionId }) => {
          const target = [connection, custom].find(
            (row) => row.id === accountConnectionId,
          );
          if (!target) return Promise.reject(new Error('missing'));
          return Promise.resolve({
            connection: target,
            upstreamUrl: `https://cloud.test/api/v1/mcp-proxy/${target.routeId}`,
          });
        });
      loadMarketplacesMock.mockResolvedValue({
        success: true,
        data: { version: 2, lastRefreshed: '', marketplaces: [] },
      });
      getMcpServerFilePathMock.mockImplementation((serverId: string) =>
        path.join(tempDir, 'missing', `server-${serverId}.json`),
      );
      proxy = {
        ensureStarted: jest.fn().mockResolvedValue(undefined),
        registerRoute: jest.fn().mockResolvedValue('route'),
        unregisterRoute: jest.fn(),
        getProxyUrl: jest.fn((): string => 'http://127.0.0.1:37645/route'),
      };
    });

    async function resolveRefs(
      mcpServerRefs: { serverId: string; configId: string }[],
    ): Promise<Awaited<ReturnType<typeof resolvePlugins>>> {
      return resolvePlugins(
        { collectionIds: [], skillRefs: [], pluginRefs: [], mcpServerRefs },
        'project',
        'worktree',
        'chat',
        {
          purpose: 'claude-session',
          enableHttpMcpProxy: true,
          mcpHttpProxyService: proxy,
        },
      );
    }

    it('resolves a curated key and config to the account connection', async (): Promise<void> => {
      const result = await resolveRefs([
        { serverId: 'github', configId: 'default' },
      ]);
      expect(Object.values(result.mcpServers)).toContainEqual({
        type: 'http',
        url: 'http://127.0.0.1:37645/route',
        headers: undefined,
      });
      expect(resolveAccountMcpProxyTarget).toHaveBeenCalledWith(
        expect.objectContaining({ accountConnectionId: 'account-id' }),
      );
      expect(proxy.registerRoute).toHaveBeenCalledWith(
        expect.objectContaining({
          serverId: 'github',
          configId: 'default',
          authSupplier: 'canopy-cloud',
          oauthEnabled: false,
          headers: {},
        }),
      );
      expect(result.warnings).toEqual([]);
    });

    it('resolves a custom server key without loading a device file', async (): Promise<void> => {
      const result = await resolveRefs([
        { serverId: custom.serverKey, configId: 'default' },
      ]);
      expect(resolveAccountMcpProxyTarget).toHaveBeenCalledWith(
        expect.objectContaining({
          accountConnectionId: 'custom-connection-id',
        }),
      );
      expect(Object.keys(result.mcpServers)).toHaveLength(1);
      expect(getMcpServerFilePathMock).not.toHaveBeenCalledWith(
        custom.serverKey,
      );
    });

    it('maps legacy connection-id refs and warns for deleted connections', async (): Promise<void> => {
      const result = await resolveRefs([
        { serverId: 'account:account-id', configId: 'default' },
        { serverId: 'github', configId: 'default' },
        { serverId: 'account:deleted', configId: 'default' },
      ]);
      expect(proxy.registerRoute).toHaveBeenCalledTimes(1);
      expect(proxy.registerRoute).toHaveBeenCalledWith(
        expect.objectContaining({ serverId: 'github', configId: 'default' }),
      );
      expect(result.warnings).toEqual([
        'Account MCP connection is unavailable. Connect again.',
      ]);
      expect(getMcpServerFilePathMock).not.toHaveBeenCalledWith(
        'account:account-id',
      );
    });

    it('skips account refs while the flag is off', async (): Promise<void> => {
      jest.mocked(accountMcpConnectionsEnabled).mockReturnValue(false);
      try {
        const result = await resolveRefs([
          { serverId: 'account:account-id', configId: 'default' },
          { serverId: custom.serverKey, configId: 'default' },
          { serverId: 'github', configId: 'default' },
        ]);
        expect(proxy.registerRoute).not.toHaveBeenCalled();
        expect(result.warnings).toEqual([
          'Account MCP connections are unavailable.',
          'Account MCP connections are unavailable.',
          'MCP server "github" not found, skipping.',
        ]);
      } finally {
        jest.mocked(accountMcpConnectionsEnabled).mockReturnValue(true);
      }
    });
  });

  describe('curated plugin member binding', (): void => {
    const CURATED_MARKETPLACE_ID = 'curated/cloud';
    const LINEAR_URL = 'https://mcp.linear.app/mcp';
    type Connection = NonNullable<
      Awaited<ReturnType<typeof loadAccountMcpRefConnections>>
    >[number];
    const linearDefault: Connection = {
      id: 'conn-default',
      serverKey: 'linear',
      configId: 'default',
      displayName: 'Linear',
      status: 'CONNECTED' as const,
      kind: 'CURATED' as const,
      routeId: 'route-default',
      enabledTools: null,
    };
    const linearWork = {
      ...linearDefault,
      id: 'conn-work',
      configId: 'work',
      displayName: 'Linear (Work)',
      routeId: 'route-work',
    };
    let proxy: {
      ensureStarted: jest.Mock;
      registerRoute: jest.Mock;
      unregisterRoute: jest.Mock;
      getProxyUrl: jest.Mock;
    };

    function accountName(connection: Connection): string {
      return buildManagedMcpServerName({
        kind: 'proxy',
        friendlyParts: [connection.displayName],
        identityParts: [connection.serverKey, connection.configId],
      });
    }

    function armConnections(connections: Connection[]): void {
      jest.mocked(loadAccountMcpRefConnections).mockResolvedValue(connections);
      jest
        .mocked(resolveAccountMcpProxyTarget)
        .mockImplementation(({ accountConnectionId, curatedKey, configId }) => {
          const target =
            connections.find((row) => row.id === accountConnectionId) ??
            connections.find(
              (row) =>
                row.serverKey === curatedKey && row.configId === configId,
            );
          if (!target) return Promise.reject(new Error('missing'));
          return Promise.resolve({
            connection: target,
            upstreamUrl: `https://cloud.test/api/v1/mcp-proxy/${target.routeId}`,
          });
        });
    }

    function writePlugin(
      marketplaceId: string,
      pluginName: string,
      member: Record<string, unknown>,
    ): void {
      const marketplaceDir = path.join(
        tempDir,
        'marketplaces',
        marketplaceId.replace('/', '-'),
      );
      const pluginDir = path.join(marketplaceDir, pluginName);
      fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(
        path.join(pluginDir, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: pluginName }),
      );
      fs.writeFileSync(
        path.join(pluginDir, '.mcp.json'),
        JSON.stringify({ mcpServers: { [pluginName]: member } }),
      );
      loadMarketplacesMock.mockResolvedValue({
        success: true,
        data: {
          version: 2,
          lastRefreshed: '2026-10-01T00:00:00.000Z',
          marketplaces: [
            {
              id: marketplaceId,
              name: marketplaceId,
              description: '',
              sourceType: 'local',
              sourceUrl: '',
              installLocation: marketplaceDir,
              pluginCount: 1,
              validProviders: ['claude'],
              providerStatus: {
                claude: {
                  provider: 'claude',
                  state: 'valid',
                  accepted: true,
                  pluginCount: 1,
                  lastCheckedAt: '2026-10-01T00:00:00.000Z',
                },
                codex: {
                  provider: 'codex',
                  state: 'invalid',
                  accepted: false,
                  pluginCount: 0,
                  lastCheckedAt: '2026-10-01T00:00:00.000Z',
                },
              },
              plugins: [
                {
                  name: pluginName,
                  marketplaceId,
                  sourcePath: pluginName,
                  providerSupport: { claude: 'native', codex: 'none' },
                  facets: {
                    claude: {
                      provider: 'claude',
                      mode: 'native',
                      name: pluginName,
                      installLocation: pluginDir,
                      sourcePath: pluginName,
                    },
                  },
                },
              ],
            },
          ],
        },
      });
    }

    function writeCuratedLinearPlugin(): void {
      writePlugin(CURATED_MARKETPLACE_ID, 'linear', {
        type: 'http',
        url: LINEAR_URL,
        curated: { key: 'linear' },
      });
    }

    function writeDeviceLinear(serverId: string): void {
      const serverPath = path.join(tempDir, 'mcp', `${serverId}.json`);
      writeStandaloneMcpFixture(serverPath, {
        serverId,
        definitionName: 'Linear Device',
        configId: 'default',
        configName: 'Default',
        type: 'http',
        httpAuthHandler: 'canopy',
        curatedKey: 'linear',
      });
      const indexPath = path.join(tempDir, 'mcp', 'index.json');
      fs.writeFileSync(
        indexPath,
        JSON.stringify({
          version: 1,
          servers: [
            {
              id: serverId,
              name: 'Linear Device',
              description: '',
              type: 'http',
              curatedKey: 'linear',
              configs: [{ id: 'default', name: 'Default', enabled: true }],
              updatedAt: '2026-10-01T00:00:00.000Z',
            },
          ],
        }),
      );
      jest.mocked(getMcpServersIndexFilePath).mockReturnValue(indexPath);
    }

    async function resolve(
      selections: Partial<ChatTabPluginSelections>,
      purpose: NonNullable<
        Parameters<typeof resolvePlugins>[4]
      >['purpose'] = 'claude-session',
    ): Promise<Awaited<ReturnType<typeof resolvePlugins>>> {
      return resolvePlugins(
        {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [
            { marketplaceId: CURATED_MARKETPLACE_ID, pluginName: 'linear' },
          ],
          mcpServerRefs: [],
          ...selections,
        },
        'project',
        'worktree',
        'chat',
        {
          purpose,
          enableHttpMcpProxy: true,
          mcpHttpProxyService: proxy,
          runtimeDirs: {
            rootDir: tempDir,
            claudePluginDir: path.join(tempDir, 'runtime'),
          },
        },
      );
    }

    beforeEach((): void => {
      armConnections([]);
      jest
        .mocked(readCachedCuratedMcpDesktopOnlyKeys)
        .mockResolvedValue(new Set());
      getMcpServerFilePathMock.mockImplementation((serverId: string) =>
        path.join(tempDir, 'mcp', `${serverId}.json`),
      );
      // These tests intentionally preserve the old missing-index-path case.
      jest
        .mocked(getMcpServersIndexFilePath)
        .mockReturnValue(undefined as never);
      proxy = {
        ensureStarted: jest.fn().mockResolvedValue(undefined),
        registerRoute: jest.fn().mockResolvedValue('route'),
        unregisterRoute: jest.fn(),
        getProxyUrl: jest.fn((): string => 'http://127.0.0.1:37645/route'),
      };
    });

    it('resolves an unbound non-curated member through a task desktop override under an account default', async (): Promise<void> => {
      const identity = {
        marketplaceId: 'third-party',
        pluginName: 'repo-search',
        serverName: 'repo-search',
      };
      const member = {
        type: 'http',
        url: 'https://repo-search.example.test/mcp',
        oauth: { clientId: 'repo-search' },
      };
      writePlugin(identity.marketplaceId, identity.pluginName, member);
      const original: ChatTabPluginSelections = {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [
          {
            marketplaceId: identity.marketplaceId,
            pluginName: identity.pluginName,
          },
        ],
      };
      const preferences: Partial<PreferencesData> = {
        mcpHttpAuthDefaultHandler: 'account',
      };
      // A partial fixture: these tests rely on unset preferences staying undefined.
      const options = {
        purpose: 'claude-session' as const,
        preferences: preferences as PreferencesData,
        enableHttpMcpProxy: true,
        mcpHttpProxyService: proxy,
        runtimeDirs: {
          rootDir: tempDir,
          claudePluginDir: path.join(tempDir, 'runtime'),
        },
      };
      const before = await resolvePlugins(
        original,
        'project',
        'worktree',
        'chat',
        options,
      );
      expect(before.mcpServers).toEqual({});
      expect(proxy.registerRoute).not.toHaveBeenCalled();
      expect(resolveAccountMcpProxyTarget).toHaveBeenCalledTimes(1);
      jest.mocked(resolveAccountMcpProxyTarget).mockClear();

      const accepted = setMcpHttpAuthPreference(
        original,
        { kind: 'plugin', ...identity },
        'canopy',
      );
      const auth = buildPluginHttpMcpServerForAuth(identity, member, false);
      if (!auth) throw new Error('Missing HTTP auth fixture');
      const after = await resolvePlugins(
        accepted,
        'project',
        'worktree',
        'chat',
        options,
      );
      expect(Object.values(after.mcpServers)).toEqual([
        {
          type: 'http',
          url: 'http://127.0.0.1:37645/route',
          headers: undefined,
        },
      ]);
      expect(proxy.registerRoute).toHaveBeenCalledWith(
        expect.objectContaining({
          serverId: auth.definition.id,
          configId: auth.config.id,
          upstreamUrl: member.url,
          oauthEnabled: true,
        }),
      );
      expect(resolveAccountMcpProxyTarget).not.toHaveBeenCalled();
      expect(after.mcpServerBindings).toEqual({});
      expect(original).not.toHaveProperty('mcpHttpAuthPreferences');
      expect(preferences).toEqual({ mcpHttpAuthDefaultHandler: 'account' });
    });

    it('collapses a plugin member and a standalone ref onto the same account connection', async (): Promise<void> => {
      writeCuratedLinearPlugin();
      armConnections([linearDefault]);

      const result = await resolve({
        mcpServerRefs: [{ serverId: 'linear', configId: 'default' }],
      });

      expect(Object.keys(result.mcpServers)).toEqual([
        accountName(linearDefault),
      ]);
      expect(proxy.registerRoute).toHaveBeenCalledTimes(1);
      expect(proxy.registerRoute).toHaveBeenCalledWith(
        expect.objectContaining({
          serverId: 'linear',
          configId: 'default',
          authSupplier: 'canopy-cloud',
          upstreamUrl: 'https://cloud.test/api/v1/mcp-proxy/route-default',
        }),
      );
      expect(probeMcpHttpOAuthRequirementMock).not.toHaveBeenCalled();
      expect(result.warnings).toEqual([
        expect.stringMatching(/"linear\/linear".*"Linear"/),
      ]);
      expect(result.warnings.join('\n')).not.toContain('cloud.test');
      expect(result.mcpServerBindings).toEqual({
        [accountName(linearDefault)]: {
          binding: {
            kind: 'account',
            accountConnectionId: 'conn-default',
            serverKey: 'linear',
            configId: 'default',
          },
          displayName: 'Linear',
          sources: [
            { kind: 'standalone', serverId: 'linear', configId: 'default' },
            {
              kind: 'plugin',
              marketplaceId: CURATED_MARKETPLACE_ID,
              pluginName: 'linear',
              serverName: 'linear',
            },
          ],
        },
      });
    });

    it('binds a lone plugin member to the connected account under the connection name', async (): Promise<void> => {
      writeCuratedLinearPlugin();
      armConnections([linearDefault]);

      const result = await resolve({});

      expect(Object.keys(result.mcpServers)).toEqual([
        accountName(linearDefault),
      ]);
      expect(proxy.registerRoute).toHaveBeenCalledTimes(1);
      expect(result.warnings).toEqual([]);
      expect(
        result.mcpServerBindings[accountName(linearDefault)],
      ).toMatchObject({
        binding: { kind: 'account', accountConnectionId: 'conn-default' },
        sources: [
          {
            kind: 'plugin',
            marketplaceId: CURATED_MARKETPLACE_ID,
            pluginName: 'linear',
            serverName: 'linear',
          },
        ],
      });
    });

    it('binds to the device server carrying the curated key when no account connection exists', async (): Promise<void> => {
      writeCuratedLinearPlugin();
      writeDeviceLinear('linear-device');
      const deviceName = buildManagedMcpServerName({
        kind: 'proxy',
        friendlyParts: ['Linear Device'],
        identityParts: ['linear-device', 'default'],
      });

      const result = await resolve({
        mcpServerRefs: [{ serverId: 'linear-device', configId: 'default' }],
      });

      expect(Object.keys(result.mcpServers)).toEqual([deviceName]);
      expect(proxy.registerRoute).toHaveBeenCalledTimes(1);
      expect(proxy.registerRoute).toHaveBeenCalledWith(
        expect.objectContaining({
          serverId: 'linear-device',
          configId: 'default',
          upstreamUrl: 'https://api.example.test/mcp',
          oauthEnabled: true,
        }),
      );
      expect(resolveAccountMcpProxyTarget).not.toHaveBeenCalled();
      expect(result.warnings).toEqual([
        expect.stringMatching(/"linear\/linear".*"Linear Device"/),
      ]);
      expect(result.mcpServerBindings[deviceName]).toEqual({
        binding: {
          kind: 'device',
          serverId: 'linear-device',
          configId: 'default',
        },
        displayName: 'Linear Device',
        sources: [
          {
            kind: 'standalone',
            serverId: 'linear-device',
            configId: 'default',
          },
          {
            kind: 'plugin',
            marketplaceId: CURATED_MARKETPLACE_ID,
            pluginName: 'linear',
            serverName: 'linear',
          },
        ],
      });

      // The same device identity when only the plugin asks for it.
      jest.clearAllMocks();
      proxy.registerRoute.mockResolvedValue('route');
      proxy.getProxyUrl.mockReturnValue('http://127.0.0.1:37645/route');
      armConnections([]);
      writeDeviceLinear('linear-device');
      const alone = await resolve({});
      expect(Object.keys(alone.mcpServers)).toEqual([deviceName]);
      expect(proxy.registerRoute).toHaveBeenCalledTimes(1);
      expect(alone.warnings).toEqual([]);
    });

    it.each(['claude-session', 'codex-session', 'cursor-session'] as const)(
      'skips an unbound member without starting a local OAuth proxy (%s)',
      async (purpose): Promise<void> => {
        writeCuratedLinearPlugin();

        const result = await resolve({}, purpose);

        expect(result.mcpServers).toEqual({});
        expect(result.codexMcpServers).toEqual({});
        expect(proxy.registerRoute).not.toHaveBeenCalled();
        expect(proxy.ensureStarted).not.toHaveBeenCalled();
        expect(probeMcpHttpOAuthRequirementMock).not.toHaveBeenCalled();
        // Codex sessions add unrelated materialization notes for this
        // Claude-only fixture; the member itself reports exactly one skip.
        expect(
          result.warnings.filter((warning) => warning.includes('"linear"')),
        ).toEqual([
          'plugin "linear" mcp server "linear" is not connected; connect it from the MCP Servers panel',
        ]);
        expect(result.warnings.join('\n')).not.toMatch(/proxied|OAuth/);
        expect(result.mcpServerBindings).toEqual({});
      },
    );

    it('fails closed on a matching account connection that is not connected', async (): Promise<void> => {
      writeCuratedLinearPlugin();
      armConnections([{ ...linearDefault, status: 'REAUTH_REQUIRED' }]);

      const result = await resolve({});

      expect(result.mcpServers).toEqual({});
      expect(proxy.registerRoute).not.toHaveBeenCalled();
      expect(probeMcpHttpOAuthRequirementMock).not.toHaveBeenCalled();
      expect(result.warnings).toEqual([
        'Account MCP server "linear/linear" skipped: Account MCP connection is REAUTH_REQUIRED.',
      ]);
    });

    it('fails closed on a connected account connection the user turned off (CAN-3620)', async (): Promise<void> => {
      writeCuratedLinearPlugin();
      const disabledConnection = { ...linearDefault, enabled: false };
      armConnections([disabledConnection]);
      writeDeviceLinear('linear-device');

      const result = await resolve({});

      expect(result.mcpServers).toEqual({});
      expect(proxy.registerRoute).not.toHaveBeenCalled();
      expect(result.warnings).toEqual([
        'Account MCP server "linear/linear" skipped: Account MCP connection is turned off.',
      ]);
    });

    it('fails closed on a non-connected account connection even when a device file carries the key', async (): Promise<void> => {
      writeCuratedLinearPlugin();
      armConnections([{ ...linearDefault, status: 'REAUTH_REQUIRED' }]);
      writeDeviceLinear('linear-device');

      const result = await resolve({});

      expect(result.mcpServers).toEqual({});
      expect(proxy.registerRoute).not.toHaveBeenCalled();
      expect(probeMcpHttpOAuthRequirementMock).not.toHaveBeenCalled();
      expect(result.warnings).toEqual([
        'Account MCP server "linear/linear" skipped: Account MCP connection is REAUTH_REQUIRED.',
      ]);
      expect(result.mcpServerBindings).toEqual({});
    });

    it('fails closed when the account connection list cannot be read, even with a device file', async (): Promise<void> => {
      writeCuratedLinearPlugin();
      jest.mocked(loadAccountMcpRefConnections).mockResolvedValue(null);
      writeDeviceLinear('linear-device');

      const result = await resolve({});

      expect(result.mcpServers).toEqual({});
      expect(proxy.registerRoute).not.toHaveBeenCalled();
      expect(probeMcpHttpOAuthRequirementMock).not.toHaveBeenCalled();
      expect(result.warnings).toEqual([
        'Account MCP server "linear/linear" skipped: the account connection list could not be read.',
      ]);
      expect(result.mcpServerBindings).toEqual({});
    });

    it('fails closed on an ambiguous curated-key match, even with a device file', async (): Promise<void> => {
      writeCuratedLinearPlugin();
      armConnections([
        { ...linearDefault, id: 'conn-personal', configId: 'personal' },
        linearWork,
      ]);
      writeDeviceLinear('linear-device');

      const result = await resolve({});

      expect(result.mcpServers).toEqual({});
      expect(proxy.registerRoute).not.toHaveBeenCalled();
      expect(probeMcpHttpOAuthRequirementMock).not.toHaveBeenCalled();
      expect(result.warnings).toEqual([
        'Account MCP server "linear/linear" skipped: Account MCP connection missing or ambiguous.',
      ]);
      expect(result.mcpServerBindings).toEqual({});
    });

    describe('desktop-only key (REG-3035)', (): void => {
      const deviceName = buildManagedMcpServerName({
        kind: 'proxy',
        friendlyParts: ['Linear Device'],
        identityParts: ['linear-device', 'default'],
      });

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
        'binds the device server over a leftover %s account connection',
        async (status): Promise<void> => {
          writeCuratedLinearPlugin();
          armConnections([{ ...linearDefault, status }]);
          writeDeviceLinear('linear-device');

          const result = await resolve({});

          expect(Object.keys(result.mcpServers)).toEqual([deviceName]);
          expect(proxy.registerRoute).toHaveBeenCalledTimes(1);
          expect(proxy.registerRoute).toHaveBeenCalledWith(
            expect.objectContaining({
              serverId: 'linear-device',
              configId: 'default',
              upstreamUrl: 'https://api.example.test/mcp',
            }),
          );
          expect(resolveAccountMcpProxyTarget).not.toHaveBeenCalled();
          expect(result.warnings).toEqual([]);
          expect(result.mcpServerBindings[deviceName]?.binding).toEqual({
            kind: 'device',
            serverId: 'linear-device',
            configId: 'default',
          });
        },
      );

      it('binds the device server when the account list cannot be read or is ambiguous', async (): Promise<void> => {
        writeCuratedLinearPlugin();
        writeDeviceLinear('linear-device');
        jest.mocked(loadAccountMcpRefConnections).mockResolvedValue(null);

        const unreadable = await resolve({});
        expect(Object.keys(unreadable.mcpServers)).toEqual([deviceName]);
        expect(unreadable.warnings).toEqual([]);

        armConnections([
          { ...linearDefault, id: 'conn-personal', configId: 'personal' },
          linearWork,
        ]);
        const ambiguous = await resolve({});
        expect(Object.keys(ambiguous.mcpServers)).toEqual([deviceName]);
        expect(ambiguous.warnings).toEqual([]);
        expect(resolveAccountMcpProxyTarget).not.toHaveBeenCalled();
      });

      it('binds nothing to a leftover connected account connection without a device server', async (): Promise<void> => {
        writeCuratedLinearPlugin();
        armConnections([linearDefault]);

        const result = await resolve({});

        expect(result.mcpServers).toEqual({});
        expect(proxy.registerRoute).not.toHaveBeenCalled();
        expect(resolveAccountMcpProxyTarget).not.toHaveBeenCalled();
        expect(result.warnings).toEqual([
          'plugin "linear" mcp server "linear" is not connected; connect it from the MCP Servers panel',
        ]);
        expect(result.mcpServerBindings).toEqual({});
      });
    });

    it('keeps the local path for an explicit canopy override beside the account entry', async (): Promise<void> => {
      writeCuratedLinearPlugin();
      armConnections([linearDefault]);

      const result = await resolve({
        mcpServerRefs: [{ serverId: 'linear', configId: 'default' }],
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

      const pluginName = buildManagedMcpServerName({
        kind: 'plugin',
        friendlyParts: ['linear', 'linear'],
        identityParts: [CURATED_MARKETPLACE_ID, 'linear', 'linear'],
      });
      expect(Object.keys(result.mcpServers).sort()).toEqual(
        [accountName(linearDefault), pluginName].sort(),
      );
      expect(proxy.registerRoute).toHaveBeenCalledTimes(2);
      expect(proxy.registerRoute).toHaveBeenCalledWith(
        expect.objectContaining({ upstreamUrl: LINEAR_URL }),
      );
      expect(probeMcpHttpOAuthRequirementMock).toHaveBeenCalledWith(
        LINEAR_URL,
        expect.anything(),
        expect.anything(),
      );
      expect(result.warnings).toEqual([]);
      expect(Object.keys(result.mcpServerBindings)).toEqual([
        accountName(linearDefault),
      ]);
    });

    it('binds the member to the default config while a standalone ref keeps its own config', async (): Promise<void> => {
      writeCuratedLinearPlugin();
      armConnections([linearWork, linearDefault]);

      const result = await resolve({
        mcpServerRefs: [{ serverId: 'linear', configId: 'work' }],
      });

      expect(Object.keys(result.mcpServers).sort()).toEqual(
        [accountName(linearDefault), accountName(linearWork)].sort(),
      );
      expect(proxy.registerRoute).toHaveBeenCalledTimes(2);
      expect(proxy.registerRoute).toHaveBeenCalledWith(
        expect.objectContaining({ serverId: 'linear', configId: 'work' }),
      );
      expect(proxy.registerRoute).toHaveBeenCalledWith(
        expect.objectContaining({ serverId: 'linear', configId: 'default' }),
      );
      expect(result.warnings).toEqual([]);
      expect(
        result.mcpServerBindings[accountName(linearDefault)]?.sources,
      ).toEqual([
        {
          kind: 'plugin',
          marketplaceId: CURATED_MARKETPLACE_ID,
          pluginName: 'linear',
          serverName: 'linear',
        },
      ]);
      expect(
        result.mcpServerBindings[accountName(linearWork)]?.sources,
      ).toEqual([{ kind: 'standalone', serverId: 'linear', configId: 'work' }]);
    });

    function writeAccountHandledDeviceLinear(): void {
      const serverPath = path.join(tempDir, 'mcp', 'linear-device.json');
      writeStandaloneMcpFixture(serverPath, {
        serverId: 'linear-device',
        definitionName: 'Linear Device',
        configId: 'default',
        configName: 'Default',
        type: 'http',
        httpAuthHandler: 'account',
        curatedKey: 'linear',
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
              scope: 'account',
              accountConnectionId: 'conn-default',
              curatedKey: 'linear',
              configs: [{ id: 'default', name: 'Default', enabled: true }],
              updatedAt: '2026-10-01T00:00:00.000Z',
            },
          ],
        }),
      );
      jest.mocked(getMcpServersIndexFilePath).mockReturnValue(indexPath);
    }

    it.each(['account first', 'device first'])(
      'loads one route when an account ref and an account-handled device ref name the same connection (%s)',
      async (order): Promise<void> => {
        armConnections([linearDefault]);
        writeAccountHandledDeviceLinear();
        const refs = [
          { serverId: 'linear', configId: 'default' },
          { serverId: 'linear-device', configId: 'default' },
        ];

        const result = await resolve({
          pluginRefs: [],
          mcpServerRefs: order === 'account first' ? refs : refs.reverse(),
        });

        expect(Object.keys(result.mcpServers)).toEqual([
          accountName(linearDefault),
        ]);
        expect(proxy.registerRoute).toHaveBeenCalledTimes(1);
        expect(proxy.registerRoute).toHaveBeenCalledWith(
          expect.objectContaining({
            authSupplier: 'canopy-cloud',
            upstreamUrl: 'https://cloud.test/api/v1/mcp-proxy/route-default',
          }),
        );
        expect(result.warnings).toEqual([]);
        expect(
          result.mcpServerBindings[accountName(linearDefault)]?.sources,
        ).toEqual(
          expect.arrayContaining([
            { kind: 'standalone', serverId: 'linear', configId: 'default' },
            {
              kind: 'standalone',
              serverId: 'linear-device',
              configId: 'default',
            },
          ]),
        );
        expect(
          result.mcpServerBindings[accountName(linearDefault)]?.binding,
        ).toEqual({
          kind: 'account',
          accountConnectionId: 'conn-default',
          serverKey: 'linear',
          configId: 'default',
        });
      },
    );

    it('binds the plugin member into an account-handled device file already loaded for the same connection', async (): Promise<void> => {
      writeCuratedLinearPlugin();
      armConnections([linearDefault]);
      writeAccountHandledDeviceLinear();

      const result = await resolve({
        mcpServerRefs: [{ serverId: 'linear-device', configId: 'default' }],
      });

      expect(Object.keys(result.mcpServers)).toEqual([
        accountName(linearDefault),
      ]);
      expect(proxy.registerRoute).toHaveBeenCalledTimes(1);
      expect(result.warnings).toEqual([
        expect.stringMatching(/"linear\/linear".*"Linear"/),
      ]);
    });

    it('binds a delegated member whose pin is a synthesized default, and keeps a pinned explicit override local', async (): Promise<void> => {
      writeCuratedLinearPlugin();
      armConnections([linearDefault]);
      const target = {
        kind: 'plugin' as const,
        marketplaceId: CURATED_MARKETPLACE_ID,
        pluginName: 'linear',
        serverName: 'linear',
      };
      const options = {
        purpose: 'claude-session' as const,
        enableHttpMcpProxy: true,
        mcpHttpProxyService: proxy,
        runtimeDirs: {
          rootDir: tempDir,
          claudePluginDir: path.join(tempDir, 'runtime'),
        },
      };
      const selections = {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [
          { marketplaceId: CURATED_MARKETPLACE_ID, pluginName: 'linear' },
        ],
        mcpServerRefs: [],
      };

      const pinnedDefault = await resolvePlugins(
        selections,
        'project',
        'worktree',
        'chat',
        { ...options, mcpHttpAuthPins: [{ target, handler: 'canopy' }] },
      );
      expect(Object.keys(pinnedDefault.mcpServers)).toEqual([
        accountName(linearDefault),
      ]);
      expect(Object.keys(pinnedDefault.mcpServerBindings)).toEqual([
        accountName(linearDefault),
      ]);

      jest.clearAllMocks();
      armConnections([linearDefault]);
      proxy.registerRoute.mockResolvedValue('route');
      proxy.getProxyUrl.mockReturnValue('http://127.0.0.1:37645/route');
      const explicit = await resolvePlugins(
        {
          ...selections,
          mcpHttpAuthPreferences: [{ target, handler: 'canopy' }],
        },
        'project',
        'worktree',
        'chat',
        options,
      );
      expect(Object.keys(explicit.mcpServers)).toEqual([
        buildManagedMcpServerName({
          kind: 'plugin',
          friendlyParts: ['linear', 'linear'],
          identityParts: [CURATED_MARKETPLACE_ID, 'linear', 'linear'],
        }),
      ]);
      expect(explicit.mcpServerBindings).toEqual({});
    });

    it('applies a synthesized pin as the handler default for a member it does not bind', async (): Promise<void> => {
      writePlugin('third-party', 'linear', { type: 'http', url: LINEAR_URL });

      const result = await resolvePlugins(
        {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [{ marketplaceId: 'third-party', pluginName: 'linear' }],
          mcpServerRefs: [],
        },
        'project',
        'worktree',
        'chat',
        {
          purpose: 'claude-session',
          enableHttpMcpProxy: true,
          mcpHttpProxyService: proxy,
          runtimeDirs: {
            rootDir: tempDir,
            claudePluginDir: path.join(tempDir, 'runtime'),
          },
          mcpHttpAuthPins: [
            {
              target: {
                kind: 'plugin',
                marketplaceId: 'third-party',
                pluginName: 'linear',
                serverName: 'linear',
              },
              handler: 'provider',
            },
          ],
        },
      );

      // Provider-handled: injected directly, no proxy route, no OAuth probe.
      expect(Object.values(result.mcpServers)).toEqual([
        { type: 'http', url: LINEAR_URL, headers: undefined },
      ]);
      expect(proxy.registerRoute).not.toHaveBeenCalled();
      expect(probeMcpHttpOAuthRequirementMock).not.toHaveBeenCalled();
    });

    it('never binds a plugin from another marketplace, even with the same URL and key', async (): Promise<void> => {
      writePlugin('third-party', 'linear', {
        type: 'http',
        url: LINEAR_URL,
        curated: { key: 'linear' },
      });
      armConnections([linearDefault]);

      const result = await resolve({
        pluginRefs: [{ marketplaceId: 'third-party', pluginName: 'linear' }],
      });

      expect(Object.keys(result.mcpServers)).toEqual([
        buildManagedMcpServerName({
          kind: 'plugin',
          friendlyParts: ['linear', 'linear'],
          identityParts: ['third-party', 'linear', 'linear'],
        }),
      ]);
      expect(proxy.registerRoute).toHaveBeenCalledTimes(1);
      expect(proxy.registerRoute).toHaveBeenCalledWith(
        expect.objectContaining({ upstreamUrl: LINEAR_URL }),
      );
      expect(resolveAccountMcpProxyTarget).not.toHaveBeenCalled();
      expect(result.mcpServerBindings).toEqual({});
    });
  });

  it('honors a standalone provider handler and keeps the selected Codex HTTP server optional', async () => {
    const serverFile = path.join(tempDir, 'server-provider.json');
    getMcpServerFilePathMock.mockReturnValue(serverFile);
    fs.writeFileSync(
      serverFile,
      JSON.stringify({
        version: 1,
        server: {
          definition: {
            id: 'provider-server',
            name: 'Provider API',
            description: '',
            type: 'http',
            url: 'https://api.example.test/mcp',
            oauth: { usePkce: true },
            httpAuthHandler: 'provider',
            createdAt: '2026-03-22T00:00:00.000Z',
            updatedAt: '2026-03-22T00:00:00.000Z',
          },
          configs: [
            {
              id: 'default',
              name: 'Default',
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
      }),
    );
    loadMarketplacesMock.mockResolvedValue({
      success: true,
      data: { version: 2, lastRefreshed: '', marketplaces: [] },
    });
    const mcpHttpProxyService = {
      ensureStarted: jest.fn().mockResolvedValue(undefined),
      registerRoute: jest.fn().mockResolvedValue('route'),
      unregisterRoute: jest.fn(),
      getProxyUrl: jest.fn(() => 'http://127.0.0.1:37645/route'),
    };

    const result = await resolvePlugins(
      {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [{ serverId: 'provider-server', configId: 'default' }],
        mcpHttpAuthPreferences: [],
      },
      'project',
      'worktree',
      'chat',
      {
        purpose: 'codex-session',
        enableHttpMcpProxy: true,
        mcpHttpProxyService,
      },
    );

    expect(mcpHttpProxyService.registerRoute).not.toHaveBeenCalled();
    const providerServerName = buildManagedMcpServerName({
      kind: 'dynamic',
      friendlyParts: ['Provider API'],
      identityParts: ['provider-server', 'default'],
    });
    expect(result.mcpServers).toEqual({
      [providerServerName]: {
        type: 'http',
        url: 'https://api.example.test/mcp',
        headers: undefined,
      },
    });
    expect(result.codexMcpServers).toEqual({
      [providerServerName]: {
        url: 'https://api.example.test/mcp',
        required: false,
      },
    });
  });

  it.each([false, true])(
    'uses a compact stable identity and configured bearer token for a proxied standalone MCP server (optional OAuth: %s)',
    async (withOAuth) => {
      const serverId = '622d6a60-adde-461c-9888-b1d100efcd26';
      const configId = '59e020b9-764b-48a2-b23f-3f66acb2a165';
      const serverFile = path.join(tempDir, 'server-proxied.json');
      getMcpServerFilePathMock.mockReturnValue(serverFile);
      fs.writeFileSync(
        serverFile,
        JSON.stringify({
          version: 1,
          server: {
            definition: {
              id: serverId,
              name: 'Production MCP Server With An Extremely Long Friendly Name',
              description: '',
              type: 'http',
              url: 'https://api.example.test/mcp',
              httpAuthHandler: 'canopy',
              ...(withOAuth ? { oauth: {} } : {}),
              createdAt: '2026-08-03T00:00:00.000Z',
              updatedAt: '2026-08-03T00:00:00.000Z',
            },
            configs: [
              {
                id: configId,
                name: 'Primary Production Configuration',
                description: '',
                enabled: true,
                authToken: 'configured-token',
                envVars: {},
                extraArgs: [],
                extraHeaders: {},
                createdAt: '2026-08-03T00:00:00.000Z',
                updatedAt: '2026-08-03T00:00:00.000Z',
              },
            ],
          },
        }),
      );
      loadMarketplacesMock.mockResolvedValue({
        success: true,
        data: { version: 2, lastRefreshed: '', marketplaces: [] },
      });
      const mcpHttpProxyService = {
        ensureStarted: jest.fn().mockResolvedValue(undefined),
        registerRoute: jest.fn().mockResolvedValue('route'),
        unregisterRoute: jest.fn(),
        getProxyUrl: jest.fn(() => 'http://127.0.0.1:37645/route'),
      };

      const result = await resolvePlugins(
        {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [{ serverId, configId }],
        },
        'project',
        'worktree',
        'chat',
        {
          purpose: 'claude-session',
          enableHttpMcpProxy: true,
          mcpHttpProxyService,
        },
      );

      const proxyServerName = buildManagedMcpServerName({
        kind: 'proxy',
        friendlyParts: [
          'Production MCP Server With An Extremely Long Friendly Name',
          'Primary Production Configuration',
        ],
        identityParts: [serverId, configId],
      });
      expect(Object.keys(result.mcpServers)).toEqual([proxyServerName]);
      expect(proxyServerName).not.toContain(serverId);
      expect(proxyServerName).not.toContain(configId);
      const qualifiedToolName = `mcp__${proxyServerName}__${'t'.repeat(64)}`;
      expect(qualifiedToolName.length).toBeLessThanOrEqual(128);
      expect(mcpHttpProxyService.registerRoute).toHaveBeenCalledWith(
        expect.objectContaining({
          serverId,
          configId,
          headers: { Authorization: 'Bearer configured-token' },
          oauthEnabled: false,
          oauthRequired: false,
        }),
      );
      expect(result.mcpServers[proxyServerName]).toEqual({
        type: 'http',
        url: 'http://127.0.0.1:37645/route',
        headers: undefined,
      });
    },
  );

  it('bounds an unavailable local OAuth proxy and continues without blocking chat startup', async () => {
    const serverFile = path.join(tempDir, 'server-timeout.json');
    getMcpServerFilePathMock.mockReturnValue(serverFile);
    fs.writeFileSync(
      serverFile,
      JSON.stringify({
        version: 1,
        server: {
          definition: {
            id: 'timeout-server',
            name: 'Timeout Server',
            description: '',
            type: 'http',
            url: 'https://api.example.test/mcp',
            httpAuthHandler: 'canopy',
            createdAt: '2026-03-22T00:00:00.000Z',
            updatedAt: '2026-03-22T00:00:00.000Z',
          },
          configs: [
            {
              id: 'default',
              name: 'Default',
              description: '',
              enabled: true,
              authToken: 'already-configured-token',
              envVars: {},
              extraArgs: [],
              extraHeaders: {},
              createdAt: '2026-03-22T00:00:00.000Z',
              updatedAt: '2026-03-22T00:00:00.000Z',
            },
          ],
        },
      }),
    );
    loadMarketplacesMock.mockResolvedValue({
      success: true,
      data: { version: 2, lastRefreshed: '', marketplaces: [] },
    });
    const mcpHttpProxyService = {
      ensureStarted: jest.fn(() => new Promise<void>(() => undefined)),
      registerRoute: jest.fn().mockResolvedValue('route'),
      unregisterRoute: jest.fn(),
      getProxyUrl: jest.fn(() => 'http://127.0.0.1:37645/route'),
    };

    const result = await resolvePlugins(
      {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [{ serverId: 'timeout-server', configId: 'default' }],
      },
      'project',
      'worktree',
      'chat',
      {
        purpose: 'codex-session',
        enableHttpMcpProxy: true,
        mcpHttpProxyService,
        proxyOperationTimeoutMs: 5,
      },
    );

    expect(result.warnings.join('\n')).toContain('exceeded its 5ms deadline');
    expect(result.warnings.join('\n')).toContain(
      'skipping to keep them parent-owned',
    );
    expect(result.mcpServers).toEqual({});
  });

  it('fails closed when proxy setup fails after an inconclusive OAuth probe', async () => {
    const serverFile = path.join(tempDir, 'server-unknown-auth.json');
    getMcpServerFilePathMock.mockReturnValue(serverFile);
    fs.writeFileSync(
      serverFile,
      JSON.stringify({
        version: 1,
        server: {
          definition: {
            id: 'unknown-auth-server',
            name: 'Unknown Auth Server',
            description: '',
            type: 'http',
            url: 'https://api.example.test/mcp',
            httpAuthHandler: 'canopy',
            createdAt: '2026-03-22T00:00:00.000Z',
            updatedAt: '2026-03-22T00:00:00.000Z',
          },
          configs: [
            {
              id: 'default',
              name: 'Default',
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
      }),
    );
    loadMarketplacesMock.mockResolvedValue({
      success: true,
      data: { version: 2, lastRefreshed: '', marketplaces: [] },
    });
    probeMcpHttpOAuthRequirementMock.mockResolvedValueOnce({
      requirement: 'unknown',
      requiresOAuth: false,
      challenge: {},
    });
    const mcpHttpProxyService = {
      ensureStarted: jest
        .fn()
        .mockRejectedValue(new Error('proxy unavailable')),
      registerRoute: jest.fn().mockResolvedValue('route'),
      unregisterRoute: jest.fn(),
      getProxyUrl: jest.fn(() => 'http://127.0.0.1:37645/route'),
    };

    const result = await resolvePlugins(
      {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [
          { serverId: 'unknown-auth-server', configId: 'default' },
        ],
      },
      'project',
      'worktree',
      'chat',
      {
        purpose: 'codex-session',
        enableHttpMcpProxy: true,
        mcpHttpProxyService,
      },
    );

    expect(result.mcpServers).toEqual({});
    expect(result.warnings.join('\n')).toContain(
      'authentication requirements could not be verified',
    );
  });

  it('retries proxy startup and unregisters a route when URL construction fails', async () => {
    const serverFile = path.join(tempDir, 'server-proxy-retry.json');
    getMcpServerFilePathMock.mockReturnValue(serverFile);
    fs.writeFileSync(
      serverFile,
      JSON.stringify({
        version: 1,
        server: {
          definition: {
            id: 'proxy-retry-server',
            name: 'Proxy Retry Server',
            description: '',
            type: 'http',
            url: 'https://api.example.test/mcp',
            httpAuthHandler: 'canopy',
            createdAt: '2026-03-22T00:00:00.000Z',
            updatedAt: '2026-03-22T00:00:00.000Z',
          },
          configs: [
            {
              id: 'first',
              name: 'First',
              description: '',
              enabled: true,
              envVars: {},
              extraArgs: [],
              extraHeaders: {},
              createdAt: '2026-03-22T00:00:00.000Z',
              updatedAt: '2026-03-22T00:00:00.000Z',
            },
            {
              id: 'second',
              name: 'Second',
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
      }),
    );
    loadMarketplacesMock.mockResolvedValue({
      success: true,
      data: { version: 2, lastRefreshed: '', marketplaces: [] },
    });
    const mcpHttpProxyService = {
      ensureStarted: jest
        .fn()
        .mockRejectedValueOnce(new Error('first startup failed'))
        .mockResolvedValueOnce(undefined),
      registerRoute: jest.fn().mockResolvedValue('second-route'),
      unregisterRoute: jest.fn(),
      getProxyUrl: jest.fn(() => {
        throw new Error('proxy has no current port');
      }),
    };

    const result = await resolvePlugins(
      {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [
          { serverId: 'proxy-retry-server', configId: 'first' },
          { serverId: 'proxy-retry-server', configId: 'second' },
        ],
      },
      'project',
      'worktree',
      'chat',
      {
        purpose: 'codex-session',
        enableHttpMcpProxy: true,
        mcpHttpProxyService,
      },
    );

    expect(mcpHttpProxyService.ensureStarted).toHaveBeenCalledTimes(2);
    expect(mcpHttpProxyService.unregisterRoute).toHaveBeenCalledWith(
      'second-route',
    );
    expect(result.warnings.join('\n')).toContain('first startup failed');
    expect(result.warnings.join('\n')).toContain('proxy has no current port');
  });

  it('prunes a stale saved MCP selection and continues resolving', async () => {
    getMcpServerFilePathMock.mockReturnValue(
      path.join(tempDir, 'missing-server.json'),
    );
    loadMarketplacesMock.mockResolvedValue({
      success: true,
      data: { version: 2, lastRefreshed: '', marketplaces: [] },
    });

    const result = await resolvePlugins(
      {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [{ serverId: 'deleted', configId: 'default' }],
      },
      'project',
      'worktree',
      'chat',
      { purpose: 'codex-session' },
    );

    expect(result.mcpServers).toEqual({});
    expect(result.warnings).toContain(
      'MCP server "deleted" not found, skipping.',
    );
  });

  it('compacts Production Hub names while preserving full proxy identity', async () => {
    const serverId = '8130e671-b9ad-408e-b2f2-3e7563a6a8a9';
    const configId = 'bc90c68e-1c34-426b-858d-7cda9af0fc85';
    const serverFile = path.join(tempDir, 'server-production-hub.json');
    getMcpServerFilePathMock.mockReturnValue(serverFile);
    writeStandaloneMcpFixture(serverFile, {
      serverId,
      definitionName: 'Production Hub MCP',
      configId,
      configName: 'Default',
      type: 'http',
      httpAuthHandler: 'canopy',
    });
    loadMarketplacesMock.mockResolvedValue({
      success: true,
      data: { version: 2, lastRefreshed: '', marketplaces: [] },
    });
    const registeredRoutes: unknown[] = [];
    const mcpHttpProxyService = {
      ensureStarted: jest.fn().mockResolvedValue(undefined),
      registerRoute: jest.fn((route: unknown): Promise<string> => {
        registeredRoutes.push(route);
        return Promise.resolve('production-hub-route');
      }),
      unregisterRoute: jest.fn(),
      getProxyUrl: jest.fn(() => 'http://127.0.0.1:37645/production-hub-route'),
    };
    const baseSelections: ChatTabPluginSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [{ serverId, configId }],
      mcpHttpAuthPreferences: [],
    };

    const directResult = await resolvePlugins(
      {
        ...baseSelections,
        mcpHttpAuthPreferences: [
          {
            target: { kind: 'standalone', serverId, configId },
            handler: 'provider',
          },
        ],
      },
      'project',
      'worktree',
      'direct-chat',
      {
        purpose: 'claude-session',
        enableHttpMcpProxy: true,
        mcpHttpProxyService,
      },
    );
    const proxyResult = await resolvePlugins(
      baseSelections,
      'project',
      'worktree',
      'proxy-chat',
      {
        purpose: 'claude-session',
        enableHttpMcpProxy: true,
        mcpHttpProxyService,
      },
    );

    const [directName] = Object.keys(directResult.mcpServers);
    const [proxyName] = Object.keys(proxyResult.mcpServers);
    expect(directName).toBe(
      buildManagedMcpServerName({
        kind: 'dynamic',
        friendlyParts: ['Production Hub MCP'],
        identityParts: [serverId, configId],
      }),
    );
    expect(proxyName).toBe(
      buildManagedMcpServerName({
        kind: 'proxy',
        friendlyParts: ['Production Hub MCP'],
        identityParts: [serverId, configId],
      }),
    );
    expect(directName?.length).toBeLessThanOrEqual(
      MANAGED_MCP_SERVER_NAME_MAX_LENGTH,
    );
    expect(proxyName?.length).toBeLessThanOrEqual(
      MANAGED_MCP_SERVER_NAME_MAX_LENGTH,
    );
    expect(directName).not.toContain(serverId);
    expect(directName).not.toContain(configId);
    expect(proxyName).not.toContain(serverId);
    expect(proxyName).not.toContain(configId);
    const directParts = directName?.split('--');
    const proxyParts = proxyName?.split('--');
    expect(directParts?.[0]?.replace(/^appdyn-/, '')).toBe(
      proxyParts?.[0]?.replace(/^appproxy-/, ''),
    );
    expect(directParts?.[1]).not.toBe(proxyParts?.[1]);
    for (const toolName of [
      'query-gcp-logs',
      'get-registration-snapshot',
      'get-domain-dns-provider-records',
      'list_agentic_context_account_billing_profile_storages',
    ]) {
      expect(`mcp__${proxyName ?? ''}__${toolName}`.length).toBeLessThanOrEqual(
        128,
      );
    }
    expect(mcpHttpProxyService.registerRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId,
        configId,
        displayName: 'Production Hub MCP',
      }),
    );
    const registeredRoute: unknown =
      registeredRoutes[registeredRoutes.length - 1];
    expect(registeredRoute).toHaveProperty('oauthDefinition.id', serverId);
    expect(registeredRoute).toHaveProperty('oauthConfig.id', configId);
  });

  it.each([
    { configName: 'Default', expectedFriendly: 'parity-server' },
    { configName: 'Prod', expectedFriendly: 'parity-server-prod' },
  ])(
    'generates the same complete standalone key as the shared resolver for $configName',
    async ({ configName, expectedFriendly }) => {
      const serverId = `parity-server-id-${configName.toLowerCase()}`;
      const configId = `parity-config-id-${configName.toLowerCase()}`;
      const dataDir = path.join(tempDir, `shared-data-${configName}`);
      const serverFile = path.join(
        dataDir,
        'mcp-servers',
        `server-${serverId}.json`,
      );
      writeStandaloneMcpFixture(serverFile, {
        serverId,
        definitionName: 'Parity Server',
        configId,
        configName,
        type: 'command',
      });
      getMcpServerFilePathMock.mockReturnValue(serverFile);
      loadMarketplacesMock.mockResolvedValue({
        success: true,
        data: { version: 2, lastRefreshed: '', marketplaces: [] },
      });
      process.env.CANOPY_DATA_DIR = dataDir;
      resetResolvedCanopyDataDirForTests();
      const input: ChatTabPluginSelections = {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [{ serverId, configId }],
        mcpHttpAuthPreferences: [],
      };

      const electronResult = await resolvePlugins(
        input,
        'project',
        'worktree',
        'electron-chat',
        { purpose: 'claude-session' },
      );
      const sharedResult = resolveSharedPlugins(
        input,
        'project',
        'worktree',
        'pipeline-step',
        { purpose: 'claude-session' },
      );
      const [electronName] = Object.keys(electronResult.mcpServers);
      const [sharedName] = Object.keys(sharedResult.mcpServers);

      expect(electronResult).toEqual(
        expect.objectContaining({
          mcpCapabilityIdentities: {
            [electronName]: [{ kind: 'standalone', serverId, configId }],
          },
        }),
      );
      expect(electronName).toBe(sharedName);
      expect(electronName).toMatch(
        new RegExp(`^appdyn-${expectedFriendly}--[a-f0-9]{16}$`),
      );
    },
  );

  it('drops empty friendly parts before applying the fallback label', async () => {
    const serverFile = path.join(tempDir, 'server-empty-name.json');
    getMcpServerFilePathMock.mockReturnValue(serverFile);
    writeStandaloneMcpFixture(serverFile, {
      serverId: 'empty-name-server',
      definitionName: '🚀',
      configId: 'prod-config',
      configName: 'Prod',
      type: 'command',
    });
    loadMarketplacesMock.mockResolvedValue({
      success: true,
      data: { version: 2, lastRefreshed: '', marketplaces: [] },
    });

    const result = await resolvePlugins(
      {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [
          { serverId: 'empty-name-server', configId: 'prod-config' },
        ],
        mcpHttpAuthPreferences: [],
      },
      'project',
      'worktree',
      'chat',
      { purpose: 'claude-session' },
    );

    expect(Object.keys(result.mcpServers)).toEqual([
      buildManagedMcpServerName({
        kind: 'dynamic',
        friendlyParts: ['🚀', 'Prod'],
        identityParts: ['empty-name-server', 'prod-config'],
      }),
    ]);
    expect(Object.keys(result.mcpServers)[0]).toMatch(
      /^appdyn-prod--[a-f0-9]{16}$/,
    );
  });

  it('projects a standalone stdio MCP selection into Codex thread config', async () => {
    const serverFile = path.join(tempDir, 'server-standalone.json');
    getMcpServerFilePathMock.mockReturnValue(serverFile);
    fs.writeFileSync(
      serverFile,
      JSON.stringify({
        version: 1,
        server: {
          definition: {
            id: 'standalone',
            name: 'Standalone',
            description: '',
            type: 'command',
            command: '/usr/bin/standalone-mcp',
            args: ['--serve'],
            createdAt: '2026-07-21T00:00:00.000Z',
            updatedAt: '2026-07-21T00:00:00.000Z',
          },
          configs: [
            {
              id: 'default',
              name: 'Default',
              description: '',
              enabled: true,
              envVars: { SENTINEL_SECRET: 'secret' },
              extraArgs: [],
              extraHeaders: {},
              createdAt: '2026-07-21T00:00:00.000Z',
              updatedAt: '2026-07-21T00:00:00.000Z',
            },
          ],
        },
      }),
    );
    loadMarketplacesMock.mockResolvedValue({
      success: true,
      data: { version: 2, lastRefreshed: '', marketplaces: [] },
    });
    const registerStdioMcpRoute: jest.MockedFunction<
      McpStdioBrokerForResolver['registerStdioMcpRoute']
    > = jest.fn<
      ReturnType<McpStdioBrokerForResolver['registerStdioMcpRoute']>,
      Parameters<McpStdioBrokerForResolver['registerStdioMcpRoute']>
    >(() =>
      Promise.resolve({
        routeId:
          '0123456789abcdef0123456789abcdef.0123456789abcdef0123456789abcdef0123456789abcdef',
        capabilityId:
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        command: '/opt/canopy',
        cwd: '/opt/canopy-runtime',
        args: [
          '__codex-mcp-stdio-launcher',
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          '0123456789abcdef0123456789abcdef.0123456789abcdef0123456789abcdef0123456789abcdef',
        ],
      }),
    );

    const result = await resolvePlugins(
      {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [{ serverId: 'standalone', configId: 'default' }],
      },
      'project',
      'worktree',
      'chat',
      {
        purpose: 'codex-session',
        sessionId: 'chat',
        mcpStdioBroker: { registerStdioMcpRoute },
      },
    );

    const standaloneRegistrationCall = registerStdioMcpRoute.mock.calls[0];
    expect(standaloneRegistrationCall?.[0]).toEqual(
      expect.objectContaining({
        ownerId: 'chat',
        routeKey: buildManagedMcpServerName({
          kind: 'dynamic',
          friendlyParts: ['Standalone'],
          identityParts: ['standalone', 'default'],
        }),
        command: '/usr/bin/standalone-mcp',
        env: { SENTINEL_SECRET: 'secret' },
      }),
    );
    expect(standaloneRegistrationCall?.[1]?.signal).toBeInstanceOf(AbortSignal);
    const standaloneServerName = buildManagedMcpServerName({
      kind: 'dynamic',
      friendlyParts: ['Standalone'],
      identityParts: ['standalone', 'default'],
    });
    const standaloneServer = result.codexMcpServers[standaloneServerName] as
      | {
          command?: string;
          args?: string[];
          cwd?: string;
          env?: Record<string, string>;
          required?: boolean;
        }
      | undefined;
    expect(standaloneServer?.command).toBe('/opt/canopy');
    expect(standaloneServer?.args).toContain(
      '0123456789abcdef0123456789abcdef.0123456789abcdef0123456789abcdef0123456789abcdef',
    );
    expect(standaloneServer?.cwd).toBe('/opt/canopy-runtime');
    expect(standaloneServer?.env).toBeUndefined();
    expect(standaloneServer?.required).toBe(false);
    expect(JSON.stringify(result.codexMcpServers)).not.toContain('secret');

    let timedOutSignal: AbortSignal | undefined;
    const timedOutRegistration = jest.fn(
      (
        _request: unknown,
        registrationOptions?: { signal?: AbortSignal },
      ): Promise<never> => {
        timedOutSignal = registrationOptions?.signal;
        return new Promise<never>(() => undefined);
      },
    );
    const timedOutResult = await resolvePlugins(
      {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [{ serverId: 'standalone', configId: 'default' }],
      },
      'project',
      'worktree',
      'chat-timeout',
      {
        purpose: 'codex-session',
        sessionId: 'chat-timeout',
        mcpStdioBroker: {
          registerStdioMcpRoute: timedOutRegistration,
        },
        proxyOperationTimeoutMs: 5,
      },
    );

    expect(timedOutSignal?.aborted).toBe(true);
    expect(timedOutResult.codexMcpServers).toEqual({});
    expect(timedOutResult.warnings.join('\n')).toContain(
      'exceeded its 5ms deadline',
    );
  });

  it.each([
    ['claude', 'command'],
    ['codex', 'command'],
    ['cursor', 'command'],
    ['cursor', 'http'],
  ] as const)(
    'gates a delegated %s %s transport through the real resolver',
    async (provider, transport) => {
      const serverFile = path.join(tempDir, 'server-standalone.json');
      getMcpServerFilePathMock.mockReturnValue(serverFile);
      writeStandaloneMcpFixture(serverFile, {
        serverId: 'standalone',
        definitionName: 'Standalone',
        configId: 'default',
        configName: 'Default',
        type: transport,
      });
      const parsed: unknown = JSON.parse(fs.readFileSync(serverFile, 'utf8'));
      const { definition, configs } = normalizeMcpServerFile(
        parsed,
        'standalone',
      ).server;
      // A refusal here would block the launch if it were still consulted.
      const authorizeServerLaunch = jest.fn().mockResolvedValue(false);
      const registerStdioMcpRoute: jest.MockedFunction<
        McpStdioBrokerForResolver['registerStdioMcpRoute']
      > = jest.fn<
        ReturnType<McpStdioBrokerForResolver['registerStdioMcpRoute']>,
        Parameters<McpStdioBrokerForResolver['registerStdioMcpRoute']>
      >(() =>
        Promise.resolve({
          routeId:
            '0123456789abcdef0123456789abcdef.0123456789abcdef0123456789abcdef0123456789abcdef',
          capabilityId:
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          command: '/opt/canopy',
          cwd: '/opt/canopy-runtime',
          args: [
            '__codex-mcp-stdio-launcher',
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            '0123456789abcdef0123456789abcdef.0123456789abcdef0123456789abcdef0123456789abcdef',
          ],
        }),
      );
      const result = await resolveDelegatedMcpCapabilities(
        {
          claudePluginRoots: [],
          claudeSkillNames: [],
          codexCapabilityRoots: [],
          mcpSelections: [
            {
              source: 'standalone',
              serverId: 'standalone',
              configId: 'default',
              configDigest: standaloneMcpTransportDigest(
                'standalone',
                'default',
                definition,
                configs[0],
              ),
            },
          ],
          mcpHttpAuthPreferences: [],
          hookDeclarations: [],
        },
        {
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          sessionId: 'child',
          stagedRootDir: tempDir,
          provider,
          signal: new AbortController().signal,
          mcpHttpProxyService: {
            ensureStarted: jest.fn(),
            registerRoute: jest.fn(),
            unregisterRoute: jest.fn(),
            getProxyUrl: jest.fn(),
          },
          mcpStdioBroker: { registerStdioMcpRoute },
          authorizeServerLaunch,
          authorizeToolCall: jest.fn().mockResolvedValue(true),
        },
      );
      // A delegate's stdio server starts the way the parent chat's does, with
      // no separate launch prompt; each tool call passes the approval gate.
      expect(authorizeServerLaunch).not.toHaveBeenCalled();
      if (transport === 'http') {
        expect(registerStdioMcpRoute).not.toHaveBeenCalled();
        expect(result.mcpServers).toEqual({});
        expect(result.unavailable).toEqual([
          { name: 'Standalone', reason: 'provider_unsupported' },
        ]);
        return;
      }
      expect(registerStdioMcpRoute).toHaveBeenCalledTimes(1);
      expect(result.unavailable).toEqual([]);
      expect(
        Object.keys(
          provider === 'codex' ? result.codexMcpServers : result.mcpServers,
        ),
      ).toHaveLength(1);
    },
  );
});

describe('cursor-session resolution purpose', () => {
  let tempDir: string;
  let previousCanopyDataDir: string | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    // realpath: the skills-root containment check compares canonical paths
    // and macOS tmp dirs are symlinked (/var → /private/var).
    tempDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-cursor-plugins-')),
    );
    previousCanopyDataDir = process.env.CANOPY_DATA_DIR;
    process.env.CANOPY_DATA_DIR = tempDir;
    resetResolvedCanopyDataDirForTests();
    getDataDirMock.mockReturnValue(tempDir);
    getSkillsRootDirMock.mockReturnValue(path.join(tempDir, 'skills'));
    // An earlier suite flips this to true and clearAllMocks keeps the value.
    jest.mocked(isBuiltinSourceId).mockReturnValue(false);
    resetDesktopCodexCapabilityStoreForTests();
  });

  afterEach(() => {
    if (previousCanopyDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = previousCanopyDataDir;
    resetResolvedCanopyDataDirForTests();
    makeTreeWritable(tempDir);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it.each(['cursor-session', 'copilot-session', 'opencode-session'] as const)(
    'projects package-only standalone skills for %s without ambient selections',
    async (purpose) => {
      const skillDir = path.join(tempDir, 'package', 'review');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: review\ndescription: Packaged review\n---\nReview changes.\n',
      );
      const packageAlias = path.join(tempDir, 'package-alias');
      fs.symlinkSync(path.join(tempDir, 'package'), packageAlias, 'junction');
      loadMarketplacesMock.mockResolvedValue({
        success: true,
        data: { version: 2, lastRefreshed: '', marketplaces: [] },
      });
      const resolved = await resolvePlugins(
        { collectionIds: [], skillRefs: [], pluginRefs: [], mcpServerRefs: [] },
        'project',
        'worktree',
        'chat',
        {
          purpose,
          packageOverlay: {
            packageDigest: `pp:v1:${'A'.repeat(43)}`,
            resources: [
              {
                virtualSourceId: 'pipeline-package:review',
                resourceId: 'review',
                provider: 'claude',
                rootPath: path.join(packageAlias, 'review'),
                kind: 'standalone_skill',
                displayName: 'Review',
                invocationKeys: [],
              },
            ],
          },
        },
      );
      fs.unlinkSync(packageAlias);
      expect(resolved.cursorCapabilities?.skills).toEqual([
        {
          id: 'review',
          sourceDir: skillDir,
          description: 'Packaged review',
          label: 'review',
          userInvocable: true,
          source: {
            kind: 'skill',
            sourceId: 'pipeline-package:review',
            skillName: 'review',
          },
        },
      ]);
      expect(resolved.skillPluginDir).toBeNull();
      expect(resolved.sdkPlugins).toEqual([]);
    },
  );

  it('resolves MCP servers like a Claude session without materializing Claude skill plugins', async () => {
    const serverFile = path.join(tempDir, 'server-local.json');
    getMcpServerFilePathMock.mockReturnValue(serverFile);
    writeStandaloneMcpFixture(serverFile, {
      serverId: 'local',
      definitionName: 'Local Tools',
      configId: 'default',
      configName: 'Default',
      type: 'command',
    });
    const skillDir = path.join(tempDir, 'skills', 'custom', 'review');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Review\n');
    getSkillDirMock.mockReturnValue(skillDir);
    loadMarketplacesMock.mockResolvedValue({
      success: true,
      data: { version: 2, lastRefreshed: '', marketplaces: [] },
    });

    const resolved = await resolvePlugins(
      {
        collectionIds: [],
        skillRefs: [{ sourceId: 'custom:local', skillName: 'review' }],
        pluginRefs: [],
        mcpServerRefs: [{ serverId: 'local', configId: 'default' }],
      },
      'project',
      'worktree',
      'chat',
      { purpose: 'cursor-session' },
    );

    const serverName = buildManagedMcpServerName({
      kind: 'dynamic',
      friendlyParts: ['Local Tools'],
      identityParts: ['local', 'default'],
    });
    expect(resolved.mcpServers).toEqual({
      [serverName]: {
        type: 'stdio',
        command: '/usr/bin/example-mcp',
        args: ['--serve'],
        env: undefined,
      },
    });
    expect(resolved.skillPluginDir).toBeNull();
    expect(resolved.sdkPlugins).toEqual([]);
    // The skill is projected for the per-chat Cursor root instead of being
    // skipped with a notice.
    expect(resolved.cursorNotices).toEqual([]);
    expect(resolved.cursorCapabilities).toEqual({
      skills: [
        {
          id: 'review',
          sourceDir: skillDir,
          description: '',
          label: 'review',
          userInvocable: true,
          source: {
            kind: 'skill',
            sourceId: 'custom:local',
            skillName: 'review',
          },
        },
      ],
      commands: [],
    });
  });

  function inheritedFixture(
    overrides: Partial<InheritedCursorCapabilities> = {},
  ): InheritedCursorCapabilities {
    return {
      skills: [],
      commands: [],
      skipped: [],
      fingerprint: 'fixture',
      ...overrides,
    };
  }

  function seedSelectedReview(): string {
    const skillDir = path.join(tempDir, 'skills', 'custom', 'review');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Review\n');
    getSkillDirMock.mockReturnValue(skillDir);
    loadMarketplacesMock.mockResolvedValue({
      success: true,
      data: { version: 2, lastRefreshed: '', marketplaces: [] },
    });
    return skillDir;
  }

  it('appends inherited home-folder skills and commands after the selection', async () => {
    const skillDir = seedSelectedReview();
    const homeReview = path.join(
      tempDir,
      'home',
      '.claude',
      'skills',
      'review',
    );
    const homeTriage = path.join(
      tempDir,
      'home',
      '.cursor',
      'skills',
      'triage',
    );

    const resolved = await resolvePlugins(
      {
        collectionIds: [],
        skillRefs: [{ sourceId: 'custom:local', skillName: 'review' }],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      'project',
      'worktree',
      'chat',
      {
        purpose: 'cursor-session',
        inheritedCursorCapabilities: inheritedFixture({
          skills: [
            {
              origin: 'claude',
              name: 'review',
              sourceDir: homeReview,
              description: 'Inherited review',
              userInvocable: true,
            },
            {
              origin: 'cursor',
              name: 'triage',
              sourceDir: homeTriage,
              description: '',
              userInvocable: true,
            },
          ],
          commands: [
            {
              origin: 'cursor',
              name: 'ship',
              markdown: '# Ship\n\nGo.\n',
              description: 'Ship',
            },
          ],
        }),
      },
    );

    // The pick keeps its id; the inherited skill with the same name is
    // suffixed, and labels name the folder the entry came from.
    expect(resolved.cursorCapabilities.skills).toEqual([
      {
        id: 'review',
        sourceDir: skillDir,
        description: '',
        label: 'review',
        userInvocable: true,
        source: {
          kind: 'skill',
          sourceId: 'custom:local',
          skillName: 'review',
        },
      },
      {
        id: 'review-1',
        sourceDir: homeReview,
        description: 'Inherited review',
        label: '~/.claude/skills/review',
        userInvocable: true,
        source: { kind: 'inherited_skill', origin: 'claude', name: 'review' },
      },
      {
        id: 'triage',
        sourceDir: homeTriage,
        description: '',
        label: '~/.cursor/skills/triage',
        userInvocable: true,
        source: { kind: 'inherited_skill', origin: 'cursor', name: 'triage' },
      },
    ]);
    expect(resolved.cursorCapabilities.commands).toEqual([
      {
        id: 'ship',
        markdown: '# Ship\n\nGo.\n',
        description: 'Ship',
        label: '~/.cursor/commands/ship',
        source: { kind: 'inherited_command', origin: 'cursor', name: 'ship' },
      },
    ]);
  });

  it('preserves model-only skills from selections, packages, plugins and inherited roots', async () => {
    const selected = seedSelectedReview();
    const plugin = path.join(tempDir, 'plugins', 'ud-git');
    const pluginSkill = path.join(plugin, 'skills', 'branch-naming');
    const packaged = path.join(tempDir, 'package', 'commit-messages');
    fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(plugin, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'ud-git' }),
    );
    for (const directory of [selected, pluginSkill, packaged]) {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(
        path.join(directory, 'SKILL.md'),
        `---\nname: ${path.basename(directory)}\ndescription: Model guidance\nuser-invocable: false\n---\nFollow this guidance.\n`,
      );
    }
    const resolved = await resolvePlugins(
      {
        collectionIds: [],
        skillRefs: [{ sourceId: 'custom:local', skillName: 'review' }],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      'project',
      'worktree',
      'chat',
      {
        purpose: 'cursor-session',
        inheritedPluginRefs: [
          {
            marketplaceId: 'market',
            pluginName: 'ud-git',
            installPath: plugin,
          },
        ],
        packageOverlay: {
          packageDigest: `pp:v1:${'A'.repeat(43)}`,
          resources: [
            {
              virtualSourceId: 'pipeline-package:commit-messages',
              resourceId: 'commit-messages',
              provider: 'claude',
              rootPath: packaged,
              kind: 'standalone_skill',
              displayName: 'Commit messages',
              invocationKeys: [],
            },
          ],
        },
        inheritedCursorCapabilities: inheritedFixture({
          skills: [
            {
              origin: 'cursor',
              name: 'pr-template',
              sourceDir: path.join(tempDir, 'home', 'pr-template'),
              description: 'PR guidance',
              userInvocable: false,
            },
          ],
        }),
      },
    );
    expect(resolved.cursorNotices).toEqual([]);
    expect(resolved.cursorCapabilities.skills).toHaveLength(4);
    expect(resolved.cursorCapabilities.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'review', userInvocable: false }),
        expect.objectContaining({
          id: 'commit-messages',
          userInvocable: false,
        }),
        expect.objectContaining({
          id: 'ud-git-branch-naming',
          userInvocable: false,
        }),
        expect.objectContaining({ id: 'pr-template', userInvocable: false }),
      ]),
    );
  });

  it('projects inherited entries with an empty selection and drops one that is the selected skill directory', async () => {
    const skillDir = seedSelectedReview();

    const empty = await resolvePlugins(
      { collectionIds: [], skillRefs: [], pluginRefs: [], mcpServerRefs: [] },
      'project',
      'worktree',
      'chat',
      {
        purpose: 'cursor-session',
        inheritedCursorCapabilities: inheritedFixture({
          skills: [
            {
              origin: 'agents',
              name: 'triage',
              sourceDir: path.join(
                tempDir,
                'home',
                '.agents',
                'skills',
                'triage',
              ),
              description: '',
              userInvocable: true,
            },
          ],
        }),
      },
    );
    expect(empty.cursorCapabilities.skills.map((skill) => skill.id)).toEqual([
      'triage',
    ]);

    const duplicate = await resolvePlugins(
      {
        collectionIds: [],
        skillRefs: [{ sourceId: 'custom:local', skillName: 'review' }],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      'project',
      'worktree',
      'chat',
      {
        purpose: 'cursor-session',
        inheritedCursorCapabilities: inheritedFixture({
          skills: [
            {
              origin: 'claude',
              name: 'review',
              sourceDir: skillDir,
              description: '',
              userInvocable: true,
            },
          ],
        }),
      },
    );
    expect(
      duplicate.cursorCapabilities.skills.map((skill) => skill.id),
    ).toEqual(['review']);
  });

  it('keys cached Cursor plugin members by their plugin and labels them by it', async () => {
    seedSelectedReview();
    const superpowers = path.join(
      tempDir,
      'home',
      '.cursor',
      'plugins',
      'cache',
      'cursor-public',
      'superpowers',
      'aaaa',
      'skills',
      'brainstorming',
    );
    const other = path.join(
      tempDir,
      'home',
      '.cursor',
      'plugins',
      'cache',
      'cursor-public',
      'other',
      'bbbb',
      'skills',
      'brainstorming',
    );

    const resolved = await resolvePlugins(
      { collectionIds: [], skillRefs: [], pluginRefs: [], mcpServerRefs: [] },
      'project',
      'worktree',
      'chat',
      {
        purpose: 'cursor-session',
        inheritedCursorCapabilities: inheritedFixture({
          skills: [
            {
              origin: 'cursor-plugin',
              plugin: 'cursor-public/superpowers',
              name: 'brainstorming',
              sourceDir: superpowers,
              description: 'Brainstorm',
              userInvocable: true,
            },
            {
              origin: 'cursor-plugin',
              plugin: 'cursor-public/other',
              name: 'brainstorming',
              sourceDir: other,
              description: '',
              userInvocable: true,
            },
          ],
          commands: [
            {
              origin: 'cursor-plugin',
              plugin: 'cursor-public/parallel',
              name: 'ship',
              markdown: '# Ship\n',
              description: 'Ship',
            },
          ],
        }),
      },
    );

    expect(resolved.cursorCapabilities.skills).toEqual([
      {
        id: 'brainstorming',
        sourceDir: superpowers,
        description: 'Brainstorm',
        label: '~/.cursor/plugins/cursor-public/superpowers/brainstorming',
        userInvocable: true,
        source: {
          kind: 'inherited_skill',
          origin: 'cursor-plugin',
          plugin: 'cursor-public/superpowers',
          name: 'brainstorming',
        },
      },
      {
        id: 'brainstorming-1',
        sourceDir: other,
        description: '',
        label: '~/.cursor/plugins/cursor-public/other/brainstorming',
        userInvocable: true,
        source: {
          kind: 'inherited_skill',
          origin: 'cursor-plugin',
          plugin: 'cursor-public/other',
          name: 'brainstorming',
        },
      },
    ]);
    expect(resolved.cursorCapabilities.commands).toEqual([
      {
        id: 'ship',
        markdown: '# Ship\n',
        description: 'Ship',
        label: '~/.cursor/plugins/cursor-public/parallel/ship',
        source: {
          kind: 'inherited_command',
          origin: 'cursor-plugin',
          plugin: 'cursor-public/parallel',
          name: 'ship',
        },
      },
    ]);
  });

  it('appends inherited plugin refs after the selection and its Collections, so a Collection member keeps the base id', async () => {
    // Two plugins whose commands sanitize to the same id: `ship-it` with
    // `release`, from a selected Collection, and `ship` with `it-release`,
    // inherited from Claude Code. The inventory numbers ids in this order
    // (selection, Collections, inherited), so the resolver must too.
    const pluginOnDisk = (name: string, command: string): string => {
      const dir = path.join(tempDir, 'plugins', name);
      fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name }),
      );
      fs.mkdirSync(path.join(dir, 'commands'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'commands', `${command}.md`),
        `# ${command}\n\nGo.\n`,
      );
      return dir;
    };
    const shipItDir = pluginOnDisk('ship-it', 'release');
    const shipDir = pluginOnDisk('ship', 'it-release');
    const pluginEntry = (name: string, dir: string): unknown => ({
      name,
      marketplaceId: 'market',
      sourcePath: dir,
      providerSupport: { claude: 'native', codex: 'none' },
      facets: {
        claude: {
          provider: 'claude',
          mode: 'native',
          name,
          installLocation: dir,
          sourcePath: dir,
        },
      },
    });
    loadMarketplacesMock.mockReturnValue({
      success: true,
      data: {
        version: 2,
        lastRefreshed: '2026-07-21T00:00:00.000Z',
        marketplaces: [
          {
            id: 'market',
            name: 'Market',
            description: '',
            sourceType: 'local',
            sourceUrl: '',
            installLocation: tempDir,
            pluginCount: 2,
            validProviders: ['claude'],
            providerStatus: {
              claude: {
                provider: 'claude',
                state: 'valid',
                accepted: true,
                pluginCount: 2,
                lastCheckedAt: '2026-07-21T00:00:00.000Z',
              },
              codex: {
                provider: 'codex',
                state: 'invalid',
                accepted: false,
                pluginCount: 0,
                lastCheckedAt: '2026-07-21T00:00:00.000Z',
              },
            },
            plugins: [
              pluginEntry('ship-it', shipItDir),
              pluginEntry('ship', shipDir),
            ],
          },
        ],
      },
    } as never);
    const { readCollectionConfig } =
      await import('../collections/collection-store');
    jest.mocked(readCollectionConfig).mockResolvedValueOnce({
      collection: {
        skills: [],
        plugins: [{ marketplaceId: 'market', pluginName: 'ship-it' }],
        mcpServers: [],
      },
    } as never);

    const resolved = await resolvePlugins(
      {
        collectionIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      'project',
      'worktree',
      'chat',
      {
        purpose: 'cursor-session',
        inheritedPluginRefs: [
          { marketplaceId: 'market', pluginName: 'ship', installPath: shipDir },
          // Already in the Collection: adds nothing a second time.
          {
            marketplaceId: 'market',
            pluginName: 'ship-it',
            installPath: shipItDir,
          },
        ],
      },
    );

    expect(
      resolved.cursorCapabilities.commands.map((command) => [
        command.id,
        command.label,
      ]),
    ).toEqual([
      ['ship-it-release', 'ship-it:release'],
      ['ship-it-release-1', 'ship:it-release'],
    ]);
  });

  it('resolves an inherited plugin from its verified Claude Code install path, never from the marketplace copy or an install', async () => {
    // Claude Code installed one version; the marketplace checkout holds a
    // different one with its own command, skill text, and MCP server. The
    // chat loads what Claude Code has installed and approved, and nothing is
    // fetched to make that happen.
    const writePlugin = (
      dir: string,
      command: string,
      server: string,
    ): void => {
      fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'tool', mcpServers: './.mcp.json' }),
      );
      fs.mkdirSync(path.join(dir, 'commands'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'commands', `${command}.md`),
        `# ${command}\n\nGo.\n`,
      );
      fs.mkdirSync(path.join(dir, 'skills', 'helper'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'skills', 'helper', 'SKILL.md'),
        `---\nname: helper\ndescription: ${server} helper\n---\n`,
      );
      fs.writeFileSync(
        path.join(dir, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            [server]: { type: 'stdio', command: `./bin/${server}` },
          },
        }),
      );
    };
    const installedDir = path.join(
      tempDir,
      'claude',
      'plugins',
      'cache',
      'market',
      'tool',
      '1.0.0',
    );
    const checkoutDir = path.join(tempDir, 'marketplaces', 'market', 'tool');
    writePlugin(installedDir, 'installed-cmd', 'installed-server');
    writePlugin(checkoutDir, 'checkout-cmd', 'checkout-server');
    loadMarketplacesMock.mockClear();
    loadMarketplacesMock.mockReturnValue({
      success: true,
      data: {
        version: 2,
        lastRefreshed: '2026-07-21T00:00:00.000Z',
        marketplaces: [
          {
            id: 'market',
            name: 'Market',
            description: '',
            sourceType: 'local',
            sourceUrl: '',
            installLocation: tempDir,
            pluginCount: 1,
            validProviders: ['claude'],
            providerStatus: {
              claude: {
                provider: 'claude',
                state: 'valid',
                accepted: true,
                pluginCount: 1,
                lastCheckedAt: '2026-07-21T00:00:00.000Z',
              },
              codex: {
                provider: 'codex',
                state: 'invalid',
                accepted: false,
                pluginCount: 0,
                lastCheckedAt: '2026-07-21T00:00:00.000Z',
              },
            },
            plugins: [
              {
                name: 'tool',
                marketplaceId: 'market',
                sourcePath: checkoutDir,
                providerSupport: { claude: 'native', codex: 'none' },
                facets: {
                  claude: {
                    provider: 'claude',
                    mode: 'native',
                    name: 'tool',
                    installLocation: checkoutDir,
                    sourcePath: checkoutDir,
                  },
                },
              },
            ],
          },
        ],
      },
    } as never);
    const installPluginMock = jest.mocked(installPlugin);
    installPluginMock.mockClear();

    const resolved = await resolvePlugins(
      { collectionIds: [], skillRefs: [], pluginRefs: [], mcpServerRefs: [] },
      'project',
      'worktree',
      'chat',
      {
        purpose: 'cursor-session',
        // The session allows installs for picked plugins; an inherited one
        // must never trigger one.
        installExternalPlugins: true,
        inheritedPluginRefs: [
          {
            marketplaceId: 'market',
            pluginName: 'tool',
            installPath: installedDir,
          },
        ],
      },
    );

    expect(
      resolved.cursorCapabilities.commands.map((command) => command.label),
    ).toEqual(['tool:installed-cmd']);
    expect(
      resolved.cursorCapabilities.skills.map((skill) => [
        skill.label,
        fs.realpathSync(skill.sourceDir),
        skill.description,
      ]),
    ).toEqual([
      [
        'tool:helper',
        fs.realpathSync(path.join(installedDir, 'skills', 'helper')),
        'installed-server helper',
      ],
    ]);
    const servers = Object.entries(resolved.mcpServers);
    expect(servers).toHaveLength(1);
    expect(servers[0]?.[1]).toEqual({
      type: 'stdio',
      command: path.join(installedDir, 'bin', 'installed-server'),
    });
    expect(resolved.warnings).toEqual([]);
    expect(installPluginMock).not.toHaveBeenCalled();
    // Nothing selected names a plugin, so the marketplace cache is not even
    // consulted: the inherited plugin's folder is known.
    expect(loadMarketplacesMock).not.toHaveBeenCalled();
  });

  it('captures the resolved installed-plugin MCP identity for Copilot inheritance', async () => {
    // Claude Code installed one version; the marketplace checkout holds a
    // different one with its own command, skill text, and MCP server. The
    // chat loads what Claude Code has installed and approved, and nothing is
    // fetched to make that happen.
    const writePlugin = (
      dir: string,
      command: string,
      server: string,
    ): void => {
      fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'tool', mcpServers: './.mcp.json' }),
      );
      fs.mkdirSync(path.join(dir, 'commands'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'commands', `${command}.md`),
        `# ${command}\n\nGo.\n`,
      );
      fs.mkdirSync(path.join(dir, 'skills', 'helper'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'skills', 'helper', 'SKILL.md'),
        `---\nname: helper\ndescription: ${server} helper\n---\n`,
      );
      fs.writeFileSync(
        path.join(dir, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            [server]: { type: 'stdio', command: `./bin/${server}` },
          },
        }),
      );
    };
    const installedDir = path.join(
      tempDir,
      'claude',
      'plugins',
      'cache',
      'market',
      'tool',
      '1.0.0',
    );
    const checkoutDir = path.join(tempDir, 'marketplaces', 'market', 'tool');
    writePlugin(installedDir, 'installed-cmd', 'installed-server');
    writePlugin(checkoutDir, 'checkout-cmd', 'checkout-server');
    loadMarketplacesMock.mockClear();
    loadMarketplacesMock.mockReturnValue({
      success: true,
      data: {
        version: 2,
        lastRefreshed: '2026-07-21T00:00:00.000Z',
        marketplaces: [
          {
            id: 'market',
            name: 'Market',
            description: '',
            sourceType: 'local',
            sourceUrl: '',
            installLocation: tempDir,
            pluginCount: 1,
            validProviders: ['claude'],
            providerStatus: {
              claude: {
                provider: 'claude',
                state: 'valid',
                accepted: true,
                pluginCount: 1,
                lastCheckedAt: '2026-07-21T00:00:00.000Z',
              },
              codex: {
                provider: 'codex',
                state: 'invalid',
                accepted: false,
                pluginCount: 0,
                lastCheckedAt: '2026-07-21T00:00:00.000Z',
              },
            },
            plugins: [
              {
                name: 'tool',
                marketplaceId: 'market',
                sourcePath: checkoutDir,
                providerSupport: { claude: 'native', codex: 'none' },
                facets: {
                  claude: {
                    provider: 'claude',
                    mode: 'native',
                    name: 'tool',
                    installLocation: checkoutDir,
                    sourcePath: checkoutDir,
                  },
                },
              },
            ],
          },
        ],
      },
    } as never);
    const installPluginMock = jest.mocked(installPlugin);
    installPluginMock.mockClear();

    const resolved = await resolvePlugins(
      { collectionIds: [], skillRefs: [], pluginRefs: [], mcpServerRefs: [] },
      'project',
      'worktree',
      'chat',
      {
        purpose: 'copilot-session',
        // The session allows installs for picked plugins; an inherited one
        // must never trigger one.
        installExternalPlugins: true,
        inheritedPluginRefs: [
          {
            marketplaceId: 'market',
            pluginName: 'tool',
            installPath: installedDir,
          },
        ],
      },
    );

    expect(
      resolved.cursorCapabilities.commands.map((command) => command.label),
    ).toEqual(['tool:installed-cmd']);
    expect(
      resolved.cursorCapabilities.skills.map((skill) => [
        skill.label,
        fs.realpathSync(skill.sourceDir),
        skill.description,
      ]),
    ).toEqual([
      [
        'tool:helper',
        fs.realpathSync(path.join(installedDir, 'skills', 'helper')),
        'installed-server helper',
      ],
    ]);
    const servers = Object.entries(resolved.mcpServers);
    expect(servers).toHaveLength(1);
    expect(servers[0]?.[1]).toEqual({
      type: 'stdio',
      command: path.join(installedDir, 'bin', 'installed-server'),
    });
    expect(resolved).toMatchObject({
      inheritedPluginBindings: [
        {
          marketplaceId: 'market',
          pluginName: 'tool',
          mcpServers: [
            {
              serverName: 'installed-server',
              configDigest: mcpTransportDigest(
                { type: 'stdio', command: './bin/installed-server' },
                {
                  marketplaceId: 'market',
                  pluginName: 'tool',
                  serverName: 'installed-server',
                },
              ),
            },
          ],
          mcpHttpAuthPreferences: [],
        },
      ],
    });
    expect(
      JSON.stringify(Reflect.get(resolved, 'inheritedPluginBindings')),
    ).not.toContain(installedDir);
    expect(resolved.warnings).toEqual([]);
    expect(installPluginMock).not.toHaveBeenCalled();
    // Nothing selected names a plugin, so the marketplace cache is not even
    // consulted: the inherited plugin's folder is known.
    expect(loadMarketplacesMock).not.toHaveBeenCalled();
  });

  it('skips and reports an inherited plugin whose install folder is gone instead of fetching another copy', async () => {
    const missing = path.join(
      tempDir,
      'claude',
      'plugins',
      'cache',
      'market',
      'tool',
      '2.0.0',
    );
    loadMarketplacesMock.mockClear();
    const installPluginMock = jest.mocked(installPlugin);
    installPluginMock.mockClear();

    const resolved = await resolvePlugins(
      { collectionIds: [], skillRefs: [], pluginRefs: [], mcpServerRefs: [] },
      'project',
      'worktree',
      'chat',
      {
        purpose: 'cursor-session',
        installExternalPlugins: true,
        inheritedPluginRefs: [
          { marketplaceId: 'market', pluginName: 'tool', installPath: missing },
        ],
      },
    );

    expect(resolved.cursorCapabilities.skills).toEqual([]);
    expect(resolved.cursorCapabilities.commands).toEqual([]);
    expect(resolved.mcpServers).toEqual({});
    const notice = `Claude Code plugin "tool" in marketplace "market" has no installed folder at ${missing}, so it was not inherited.`;
    expect(resolved.warnings).toEqual([notice]);
    expect(resolved.cursorNotices).toEqual([notice]);
    expect(installPluginMock).not.toHaveBeenCalled();
    expect(loadMarketplacesMock).not.toHaveBeenCalled();
  });

  it('inherits home capabilities for a Copilot session, as for Cursor', async () => {
    seedSelectedReview();
    const homeTriage = path.join(
      tempDir,
      'home',
      '.cursor',
      'skills',
      'triage',
    );
    fs.mkdirSync(homeTriage, { recursive: true });
    fs.writeFileSync(path.join(homeTriage, 'SKILL.md'), '# Triage\n');
    const resolved = await resolvePlugins(
      { collectionIds: [], skillRefs: [], pluginRefs: [], mcpServerRefs: [] },
      'project',
      'worktree',
      'chat',
      {
        purpose: 'copilot-session',
        inheritedCursorCapabilities: inheritedFixture({
          skills: [
            {
              origin: 'cursor',
              name: 'triage',
              sourceDir: homeTriage,
              description: '',
              userInvocable: true,
            },
          ],
          commands: [
            {
              origin: 'claude',
              name: 'ship',
              markdown: '# Ship\n\nGo.\n',
              description: 'Ship',
            },
          ],
        }),
      },
    );
    expect(resolved.cursorCapabilities.skills).toEqual([
      {
        id: 'triage',
        sourceDir: homeTriage,
        description: '',
        label: '~/.cursor/skills/triage',
        userInvocable: true,
        source: { kind: 'inherited_skill', origin: 'cursor', name: 'triage' },
      },
    ]);
    expect(resolved.cursorCapabilities.commands).toMatchObject([
      { id: 'ship', label: '~/.claude/commands/ship' },
    ]);
  });

  it('skips a standalone skill reached through an interior symbolic link, with a warning', async () => {
    // `skills/custom` is a link out of the skills root; the skill directory
    // under it is real, so a last-segment check alone would let it through.
    const outside = path.join(tempDir, 'outside', 'review');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'SKILL.md'), '# Review\n');
    fs.mkdirSync(path.join(tempDir, 'skills'), { recursive: true });
    fs.symlinkSync(
      path.join(tempDir, 'outside'),
      path.join(tempDir, 'skills', 'custom'),
    );
    getSkillDirMock.mockReturnValue(
      path.join(tempDir, 'skills', 'custom', 'review'),
    );
    loadMarketplacesMock.mockResolvedValue({
      success: true,
      data: { version: 2, lastRefreshed: '', marketplaces: [] },
    });
    try {
      const resolved = await resolvePlugins(
        {
          collectionIds: [],
          skillRefs: [{ sourceId: 'custom:local', skillName: 'review' }],
          pluginRefs: [],
          mcpServerRefs: [],
        },
        'project',
        'worktree',
        'chat',
        { purpose: 'cursor-session' },
      );
      expect(resolved.cursorCapabilities.skills).toEqual([]);
      expect(resolved.warnings).toEqual([
        expect.stringContaining('outside the skills root'),
      ]);
      // A Cursor-only rejection is shown to the user, not only logged.
      expect(resolved.cursorNotices).toEqual(resolved.warnings);
    } finally {
      // The suite's recursive cleanup does not cope with a directory link.
      fs.unlinkSync(path.join(tempDir, 'skills', 'custom'));
    }
  });

  it('skips a plugin skills root reached through an interior symbolic link, with a warning', async () => {
    const pluginDir = path.join(tempDir, 'ship-it');
    fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, '.claude-plugin', 'plugin.json'),
      '{"name":"ship-it","skills":"./nested/link/skills"}',
    );
    const outside = path.join(tempDir, 'outside-plugin');
    fs.mkdirSync(path.join(outside, 'skills', 'deploy'), { recursive: true });
    fs.writeFileSync(
      path.join(outside, 'skills', 'deploy', 'SKILL.md'),
      '---\nname: deploy\n---\n',
    );
    fs.mkdirSync(path.join(pluginDir, 'nested'));
    fs.symlinkSync(outside, path.join(pluginDir, 'nested', 'link'));
    loadMarketplacesMock.mockResolvedValue({
      success: true,
      data: {
        version: 2,
        lastRefreshed: '2026-07-21T00:00:00.000Z',
        marketplaces: [
          {
            id: 'market',
            name: 'Market',
            description: '',
            sourceType: 'local',
            sourceUrl: '',
            installLocation: tempDir,
            pluginCount: 1,
            validProviders: ['claude'],
            providerStatus: {
              claude: {
                provider: 'claude',
                state: 'valid',
                accepted: true,
                pluginCount: 1,
                lastCheckedAt: '2026-07-21T00:00:00.000Z',
              },
              codex: {
                provider: 'codex',
                state: 'invalid',
                accepted: false,
                pluginCount: 0,
                lastCheckedAt: '2026-07-21T00:00:00.000Z',
              },
            },
            plugins: [
              {
                name: 'ship-it',
                marketplaceId: 'market',
                sourcePath: pluginDir,
                providerSupport: { claude: 'native', codex: 'none' },
                facets: {
                  claude: {
                    provider: 'claude',
                    mode: 'native',
                    name: 'ship-it',
                    installLocation: pluginDir,
                    sourcePath: pluginDir,
                  },
                },
              },
            ],
          },
        ],
      },
    });
    try {
      const resolved = await resolvePlugins(
        {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [{ marketplaceId: 'market', pluginName: 'ship-it' }],
          mcpServerRefs: [],
        },
        'project',
        'worktree',
        'chat',
        { purpose: 'cursor-session' },
      );
      expect(resolved.cursorCapabilities.skills).toEqual([]);
      expect(resolved.warnings).toEqual([
        expect.stringContaining('resolves outside the plugin'),
      ]);
      expect(resolved.cursorNotices).toEqual(resolved.warnings);
    } finally {
      fs.unlinkSync(path.join(pluginDir, 'nested', 'link'));
    }
  });

  it('projects selected plugin skills and commands into Cursor ids, and renders commands in the shape the CLI reads', async () => {
    const pluginDir = path.join(tempDir, 'ship-it');
    fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, '.claude-plugin', 'plugin.json'),
      '{"name":"ship-it"}',
    );
    fs.mkdirSync(path.join(pluginDir, 'skills', 'deploy'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'skills', 'deploy', 'SKILL.md'),
      '---\nname: deploy\ndescription: Deploy it\n---\nShip.\n',
    );
    fs.mkdirSync(path.join(pluginDir, 'commands'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'commands', 'release.md'),
      '---\ndescription: Cut a release\nallowed-tools: Bash\n---\n\nRelease $ARGUMENTS now.\n',
    );
    loadMarketplacesMock.mockResolvedValue({
      success: true,
      data: {
        version: 2,
        lastRefreshed: '2026-07-21T00:00:00.000Z',
        marketplaces: [
          {
            id: 'market',
            name: 'Market',
            description: '',
            sourceType: 'local',
            sourceUrl: '',
            installLocation: tempDir,
            pluginCount: 1,
            validProviders: ['claude'],
            providerStatus: {
              claude: {
                provider: 'claude',
                state: 'valid',
                accepted: true,
                pluginCount: 1,
                lastCheckedAt: '2026-07-21T00:00:00.000Z',
              },
              codex: {
                provider: 'codex',
                state: 'invalid',
                accepted: false,
                pluginCount: 0,
                lastCheckedAt: '2026-07-21T00:00:00.000Z',
              },
            },
            plugins: [
              {
                name: 'ship-it',
                marketplaceId: 'market',
                sourcePath: pluginDir,
                providerSupport: { claude: 'native', codex: 'none' },
                facets: {
                  claude: {
                    provider: 'claude',
                    mode: 'native',
                    name: 'ship-it',
                    installLocation: pluginDir,
                    sourcePath: pluginDir,
                  },
                },
              },
            ],
          },
        ],
      },
    });
    // A standalone skill whose name is what the plugin skill's id would be:
    // standalone skills are assigned first, so the plugin skill is suffixed.
    const skillDir = path.join(tempDir, 'skills', 'custom', 'ship-it-deploy');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: ship-it-deploy\ndescription: Standalone\n---\n',
    );
    getSkillDirMock.mockReturnValue(skillDir);

    const resolved = await resolvePlugins(
      {
        collectionIds: [],
        skillRefs: [{ sourceId: 'custom:local', skillName: 'ship-it-deploy' }],
        pluginRefs: [{ marketplaceId: 'market', pluginName: 'ship-it' }],
        mcpServerRefs: [],
      },
      'project',
      'worktree',
      'chat',
      { purpose: 'cursor-session' },
    );

    expect(resolved.cursorCapabilities).toEqual({
      skills: [
        {
          id: 'ship-it-deploy',
          sourceDir: skillDir,
          description: 'Standalone',
          label: 'ship-it-deploy',
          userInvocable: true,
          source: {
            kind: 'skill',
            sourceId: 'custom:local',
            skillName: 'ship-it-deploy',
          },
        },
        {
          id: 'ship-it-deploy-1',
          sourceDir: path.join(pluginDir, 'skills', 'deploy'),
          description: 'Deploy it',
          label: 'ship-it:deploy',
          userInvocable: true,
          source: {
            kind: 'plugin_skill',
            marketplaceId: 'market',
            pluginName: 'ship-it',
            memberName: 'deploy',
          },
        },
      ],
      commands: [
        {
          id: 'ship-it-release',
          markdown: '# Cut a release\n\nRelease $ARGUMENTS now.\n',
          description: 'Cut a release',
          label: 'ship-it:release',
          source: {
            kind: 'plugin_command',
            marketplaceId: 'market',
            pluginName: 'ship-it',
            memberName: 'release',
          },
        },
      ],
    });
    // A plugin that contributes skills or commands is not "adding nothing".
    expect(resolved.cursorNotices).toEqual([]);
    expect(resolved.warnings).toEqual([]);
  });

  it('expands ${CLAUDE_PLUGIN_ROOT}, makes plugin-relative commands absolute, and keeps only a declared cwd for Cursor stdio servers', async () => {
    const pluginDir = path.join(tempDir, 'claude-plugin');
    fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, '.claude-plugin', 'plugin.json'),
      '{"name":"claude-plugin","mcpServers":"./.mcp.json"}',
    );
    fs.writeFileSync(
      path.join(pluginDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          bundled: {
            type: 'stdio',
            command: '${CLAUDE_PLUGIN_ROOT}/bin/server',
            args: ['--root', '${CLAUDE_PLUGIN_ROOT}'],
            env: { PLUGIN_HOME: '${CLAUDE_PLUGIN_ROOT}' },
          },
          relative: {
            type: 'stdio',
            command: './bin/rel',
            cwd: './work',
            enabled: false,
          },
        },
      }),
    );
    loadMarketplacesMock.mockResolvedValue({
      success: true,
      data: {
        version: 2,
        lastRefreshed: '2026-07-21T00:00:00.000Z',
        marketplaces: [
          {
            id: 'claude-market',
            name: 'Claude Market',
            description: '',
            sourceType: 'local',
            sourceUrl: '',
            installLocation: tempDir,
            pluginCount: 1,
            validProviders: ['claude'],
            providerStatus: {
              claude: {
                provider: 'claude',
                state: 'valid',
                accepted: true,
                pluginCount: 1,
                lastCheckedAt: '2026-07-21T00:00:00.000Z',
              },
              codex: {
                provider: 'codex',
                state: 'invalid',
                accepted: false,
                pluginCount: 0,
                lastCheckedAt: '2026-07-21T00:00:00.000Z',
              },
            },
            plugins: [
              {
                name: 'claude-plugin',
                marketplaceId: 'claude-market',
                sourcePath: pluginDir,
                providerSupport: { claude: 'native', codex: 'none' },
                facets: {
                  claude: {
                    provider: 'claude',
                    mode: 'native',
                    name: 'claude-plugin',
                    installLocation: pluginDir,
                    sourcePath: pluginDir,
                  },
                },
              },
            ],
          },
        ],
      },
    });

    const resolved = await resolvePlugins(
      {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [
          { marketplaceId: 'claude-market', pluginName: 'claude-plugin' },
        ],
        mcpServerRefs: [],
      },
      'project',
      'worktree',
      'chat',
      { purpose: 'cursor-session' },
    );

    const entries = Object.entries(resolved.mcpServers);
    expect(entries).toHaveLength(2);
    const [serverName, server] = entries[0] ?? [];
    expect(serverName).toContain('claude-plugin');
    // ACP has no cwd field, so the plugin root is not pinned as one; a
    // relative command is made absolute instead, and only a cwd the
    // definition declares is kept (the translator says it merely locates the
    // executable). `enabled` is forwarded so a disabled server is skipped.
    expect(server).toEqual({
      type: 'stdio',
      command: `${pluginDir}/bin/server`,
      args: ['--root', pluginDir],
      env: { PLUGIN_HOME: pluginDir },
    });
    expect(entries[1]?.[1]).toEqual({
      type: 'stdio',
      command: `${pluginDir}/bin/rel`,
      cwd: `${pluginDir}/work`,
      enabled: false,
    });
    expect(resolved.warnings).toEqual([]);
  });

  it.each(['claude-session', 'cursor-session'] as const)(
    'makes a cwd-relative script arg absolute for a %s so the server starts outside its plugin directory',
    async (purpose) => {
      // The Claude CLI ignores a stdio server's cwd and Cursor's ACP shape has
      // none, so a script path written relative to the plugin directory only
      // resolves once it is absolute. A flag and a name that is not a file
      // under cwd are left alone.
      const pluginDir = path.join(tempDir, 'claude-plugin');
      fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
      fs.mkdirSync(path.join(pluginDir, 'mcp'), { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'mcp', 'server.mjs'), '');
      fs.writeFileSync(
        path.join(pluginDir, '.claude-plugin', 'plugin.json'),
        '{"name":"claude-plugin","mcpServers":"./.mcp.json"}',
      );
      fs.writeFileSync(
        path.join(pluginDir, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            security: {
              command: 'node',
              args: ['./mcp/server.mjs', '--stdio', 'mcp', 'serve'],
              cwd: '.',
            },
          },
        }),
      );
      loadMarketplacesMock.mockResolvedValue({
        success: true,
        data: {
          version: 2,
          lastRefreshed: '2026-07-21T00:00:00.000Z',
          marketplaces: [
            {
              id: 'claude-market',
              name: 'Claude Market',
              description: '',
              sourceType: 'local',
              sourceUrl: '',
              installLocation: tempDir,
              pluginCount: 1,
              validProviders: ['claude'],
              providerStatus: {
                claude: {
                  provider: 'claude',
                  state: 'valid',
                  accepted: true,
                  pluginCount: 1,
                  lastCheckedAt: '2026-07-21T00:00:00.000Z',
                },
                codex: {
                  provider: 'codex',
                  state: 'invalid',
                  accepted: false,
                  pluginCount: 0,
                  lastCheckedAt: '2026-07-21T00:00:00.000Z',
                },
              },
              plugins: [
                {
                  name: 'claude-plugin',
                  marketplaceId: 'claude-market',
                  sourcePath: pluginDir,
                  providerSupport: { claude: 'native', codex: 'none' },
                  facets: {
                    claude: {
                      provider: 'claude',
                      mode: 'native',
                      name: 'claude-plugin',
                      installLocation: pluginDir,
                      sourcePath: pluginDir,
                    },
                  },
                },
              ],
            },
          ],
        },
      });

      const resolved = await resolvePlugins(
        {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [
            { marketplaceId: 'claude-market', pluginName: 'claude-plugin' },
          ],
          mcpServerRefs: [],
        },
        'project',
        'worktree',
        'chat',
        {
          purpose,
          runtimeDirs: {
            rootDir: path.join(tempDir, 'runtime'),
            claudePluginDir: path.join(tempDir, 'runtime', 'claude'),
          },
        },
      );

      const [server] = Object.values(resolved.mcpServers);
      expect(server).toMatchObject({
        type: 'stdio',
        command: 'node',
        args: [
          path.join(pluginDir, 'mcp', 'server.mjs'),
          '--stdio',
          'mcp',
          'serve',
        ],
      });
    },
  );

  it.each(['claude-session', 'cursor-session'] as const)(
    'leaves args as written for a %s when the server declares no cwd, even if a same-named file exists in the plugin root',
    async (purpose) => {
      // Without a declared cwd the harness legitimately starts the server in
      // the chat's working directory, so `config.json` is project-relative and
      // must not be redirected to the plugin's own copy.
      const pluginDir = path.join(tempDir, 'claude-plugin');
      fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'config.json'), '{}');
      fs.writeFileSync(
        path.join(pluginDir, '.claude-plugin', 'plugin.json'),
        '{"name":"claude-plugin","mcpServers":"./.mcp.json"}',
      );
      fs.writeFileSync(
        path.join(pluginDir, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            tool: {
              command: 'npx',
              args: ['some-tool', '--config', 'config.json'],
            },
          },
        }),
      );
      loadMarketplacesMock.mockResolvedValue({
        success: true,
        data: {
          version: 2,
          lastRefreshed: '2026-07-21T00:00:00.000Z',
          marketplaces: [
            {
              id: 'claude-market',
              name: 'Claude Market',
              description: '',
              sourceType: 'local',
              sourceUrl: '',
              installLocation: tempDir,
              pluginCount: 1,
              validProviders: ['claude'],
              providerStatus: {
                claude: {
                  provider: 'claude',
                  state: 'valid',
                  accepted: true,
                  pluginCount: 1,
                  lastCheckedAt: '2026-07-21T00:00:00.000Z',
                },
                codex: {
                  provider: 'codex',
                  state: 'invalid',
                  accepted: false,
                  pluginCount: 0,
                  lastCheckedAt: '2026-07-21T00:00:00.000Z',
                },
              },
              plugins: [
                {
                  name: 'claude-plugin',
                  marketplaceId: 'claude-market',
                  sourcePath: pluginDir,
                  providerSupport: { claude: 'native', codex: 'none' },
                  facets: {
                    claude: {
                      provider: 'claude',
                      mode: 'native',
                      name: 'claude-plugin',
                      installLocation: pluginDir,
                      sourcePath: pluginDir,
                    },
                  },
                },
              ],
            },
          ],
        },
      });

      const resolved = await resolvePlugins(
        {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [
            { marketplaceId: 'claude-market', pluginName: 'claude-plugin' },
          ],
          mcpServerRefs: [],
        },
        'project',
        'worktree',
        'chat',
        {
          purpose,
          runtimeDirs: {
            rootDir: path.join(tempDir, 'runtime'),
            claudePluginDir: path.join(tempDir, 'runtime', 'claude'),
          },
        },
      );

      const [server] = Object.values(resolved.mcpServers);
      expect(server).toMatchObject({
        type: 'stdio',
        args: ['some-tool', '--config', 'config.json'],
      });
    },
  );

  it('warns about a Codex-native plugin without MCP servers the way a Claude session does', async () => {
    const pluginDir = path.join(tempDir, 'codex-only-plugin');
    fs.mkdirSync(path.join(pluginDir, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, '.codex-plugin', 'plugin.json'),
      '{"name":"codex-only"}',
    );
    loadMarketplacesMock.mockResolvedValue({
      success: true,
      data: {
        version: 2,
        lastRefreshed: '2026-07-21T00:00:00.000Z',
        marketplaces: [
          {
            id: 'native-market',
            name: 'Native Market',
            description: '',
            sourceType: 'local',
            sourceUrl: '',
            installLocation: tempDir,
            pluginCount: 1,
            validProviders: ['codex'],
            providerStatus: {
              claude: {
                provider: 'claude',
                state: 'invalid',
                accepted: false,
                pluginCount: 0,
                lastCheckedAt: '2026-07-21T00:00:00.000Z',
              },
              codex: {
                provider: 'codex',
                state: 'valid',
                accepted: true,
                pluginCount: 1,
                lastCheckedAt: '2026-07-21T00:00:00.000Z',
              },
            },
            plugins: [
              {
                name: 'codex-only',
                marketplaceId: 'native-market',
                sourcePath: pluginDir,
                providerSupport: { claude: 'none', codex: 'native' },
                facets: {
                  codex: {
                    provider: 'codex',
                    mode: 'native',
                    name: 'codex-only',
                    installLocation: pluginDir,
                    sourcePath: pluginDir,
                  },
                },
              },
            ],
          },
        ],
      },
    });

    const resolved = await resolvePlugins(
      {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [
          { marketplaceId: 'native-market', pluginName: 'codex-only' },
        ],
        mcpServerRefs: [],
      },
      'project',
      'worktree',
      'chat',
      { purpose: 'cursor-session' },
    );

    expect(resolved.mcpServers).toEqual({});
    expect(resolved.cursorNotices).toEqual([
      'Plugin "codex-only" in marketplace "native-market" declares no MCP servers, skills, or commands, so it adds nothing to a Cursor session.',
    ]);
  });
});

it('rejects a stored skill before chat prompt/plugin materialization', async () => {
  const { resolveEffectivePluginSelectionRefs } =
    await import('../plugins/plugin-resolver');
  mockAssertSkillContext.mockRejectedValueOnce(
    new Error('Skill unavailable (context-mismatch)'),
  );
  await expect(
    resolveEffectivePluginSelectionRefs(
      {
        skillRefs: [{ sourceId: 'custom:app', skillName: 'org-a' }],
        pluginRefs: [],
        collectionIds: [],
        mcpServerRefs: [],
      },
      [],
      'workspace-a',
    ),
  ).rejects.toThrow('context-mismatch');
  expect(mockAssertSkillContext).toHaveBeenCalledWith(
    'custom:app/org-a',
    'workspace-a',
  );
});

it('refuses a denied Collection before expanding chat capability selections', async () => {
  const { readCollectionConfig } =
    await import('../collections/collection-store');
  const { resolveEffectivePluginSelectionRefs } =
    await import('../plugins/plugin-resolver');
  jest
    .mocked(readCollectionConfig)
    .mockRejectedValueOnce(
      new Error('Resource unavailable (context-mismatch)'),
    );
  await expect(
    resolveEffectivePluginSelectionRefs({
      collectionIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    }),
  ).rejects.toThrow('context-mismatch');
});

describe('Cursor plugin support: the catalog predicate agrees with on-disk discovery', () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-cursor-support-')),
    );
  });
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  type MemberKind =
    | 'mcp'
    | 'skills'
    | 'commands'
    | 'agents-and-hooks'
    | 'empty';

  function writePlugin(provider: 'claude' | 'codex', kind: MemberKind): string {
    const dir = path.join(tempDir, `${provider}-${kind}`);
    const manifestDir = path.join(
      dir,
      provider === 'codex' ? '.codex-plugin' : '.claude-plugin',
    );
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(
      path.join(manifestDir, 'plugin.json'),
      JSON.stringify({ name: `${provider}-${kind}` }),
    );
    switch (kind) {
      case 'mcp':
        fs.writeFileSync(
          path.join(dir, '.mcp.json'),
          JSON.stringify({ mcpServers: { tools: { command: 'tools-mcp' } } }),
        );
        break;
      case 'skills':
        fs.mkdirSync(path.join(dir, 'skills', 'triage'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'skills', 'triage', 'SKILL.md'),
          '---\nname: triage\ndescription: Triage\n---\nTriage.\n',
        );
        break;
      case 'commands':
        fs.mkdirSync(path.join(dir, 'commands'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'commands', 'ship.md'),
          '---\ndescription: Ship\n---\nShip it.\n',
        );
        break;
      case 'agents-and-hooks':
        fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'agents', 'reviewer.md'),
          '---\nname: reviewer\ndescription: Reviews\n---\nReview.\n',
        );
        fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'hooks', 'hooks.json'),
          JSON.stringify({
            hooks: {
              PreToolUse: [{ hooks: [{ type: 'command', command: 'echo' }] }],
            },
          }),
        );
        break;
      case 'empty':
        break;
    }
    return dir;
  }

  // The detail page and the picker read `cursorPluginFacetSupport` over the
  // scanned catalog facet; a Cursor session reads `discoverCursorPluginMembers`
  // and its MCP servers through `readPluginMcpAuthEntries`. Both must agree for
  // every member kind, or the page drifts from the session again (#4889).
  it.each<['claude' | 'codex', MemberKind, boolean]>([
    ['claude', 'mcp', true],
    ['claude', 'skills', true],
    ['claude', 'commands', true],
    ['claude', 'agents-and-hooks', false],
    ['claude', 'empty', false],
    ['codex', 'mcp', true],
    ['codex', 'skills', true],
    ['codex', 'commands', false],
    ['codex', 'agents-and-hooks', false],
    ['codex', 'empty', false],
  ])('%s plugin with %s members', async (provider, kind, expected) => {
    const dir = writePlugin(provider, kind);
    const details = scanPluginDetails(dir, { manifestKind: provider });
    const catalog = cursorPluginFacetSupport(
      provider === 'claude' ? { claude: { details } } : { codex: { details } },
    );
    const members = discoverCursorPluginMembers(dir, provider);
    const resolverMcp =
      (
        await readPluginMcpAuthEntries(
          dir,
          'mkt',
          `${provider}-${kind}`,
          provider,
        )
      ).length > 0;
    const session = members.length > 0 || resolverMcp;
    expect(catalog).toEqual({ provider, supported: expected });
    expect(session).toBe(expected);
  });
});

describe('Disabled installed items', () => {
  it('drops Disabled account MCP refs while preserving legacy default-enabled connections', async () => {
    const { resolveEffectivePluginSelectionRefs } =
      await import('../plugins/plugin-resolver');
    jest.mocked(accountMcpConnectionsEnabled).mockReturnValue(true);
    jest.mocked(loadAccountMcpRefConnections).mockResolvedValue([
      {
        id: 'off',
        serverKey: 'custom:off',
        configId: 'default',
        displayName: 'Off',
        status: 'CONNECTED',
        kind: 'CUSTOM',
        routeId: 'off',
        enabledTools: null,
        enabled: false,
      },
      {
        id: 'on',
        serverKey: 'custom:on',
        configId: 'default',
        displayName: 'On',
        status: 'CONNECTED',
        kind: 'CUSTOM',
        routeId: 'on',
        enabledTools: null,
      },
    ]);
    const result = await resolveEffectivePluginSelectionRefs({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [
        { serverId: 'custom:off', configId: 'default' },
        { serverId: 'custom:on', configId: 'default' },
      ],
    });
    expect(result.mcpServerRefs).toEqual([
      { serverId: 'custom:on', configId: 'default' },
    ]);
    expect(result.disabledRefs).toEqual([
      { kind: 'mcp-config', serverId: 'custom:off', configId: 'default' },
    ]);
    expect(result.warnings).toEqual([]);
  });
  it('drops Disabled device MCP refs before delegation without missing-selection warnings', async () => {
    const { resolveEffectivePluginSelectionRefs } =
      await import('../plugins/plugin-resolver');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'disabled-mcp-'));
    try {
      const file = path.join(temp, 'server.json');
      writeStandaloneMcpFixture(file, {
        serverId: 'server',
        definitionName: 'Server',
        configId: 'config',
        configName: 'Config',
        type: 'command',
      });
      fs.writeFileSync(
        file,
        fs
          .readFileSync(file, 'utf8')
          .replace('"enabled":true', '"enabled":false'),
      );
      getMcpServerFilePathMock.mockReturnValue(file);
      const ref = { serverId: 'server', configId: 'config' };
      const result = await resolveEffectivePluginSelectionRefs({
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [ref, ref],
      });
      expect(result.mcpServerRefs).toEqual([]);
      expect(result.disabledRefs).toEqual([{ kind: 'mcp-config', ...ref }]);
      expect(result.warnings).toEqual([]);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
  it('drops explicit Disabled refs once without delegation missing-selection warnings', async () => {
    const { resolveEffectivePluginSelectionRefs } =
      await import('../plugins/plugin-resolver');
    const plugin = { marketplaceId: 'market', pluginName: 'Name' };
    const preferences: Partial<PreferencesData> = {
      disabledInstalledItems: [installedItemKey({ kind: 'plugin', ...plugin })],
    };
    // A partial fixture: these tests rely on unset preferences staying undefined.
    jest
      .mocked(readPreferencesFile)
      .mockResolvedValueOnce(preferences as PreferencesData);
    const result = await resolveEffectivePluginSelectionRefs({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [plugin, plugin],
    });
    expect(result).toEqual({
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
      warnings: [],
      disabledRefs: [
        { kind: 'plugin', marketplaceId: 'market', pluginName: 'name' },
      ],
    });
  });
  it('does not expand a Disabled collection or suppress an independent member', async () => {
    const { resolveEffectivePluginSelectionRefs } =
      await import('../plugins/plugin-resolver');
    const { readCollectionConfig } =
      await import('../collections/collection-store');
    const collectionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    jest.mocked(readCollectionConfig).mockClear();
    const preferences: Partial<PreferencesData> = {
      disabledInstalledItems: [
        installedItemKey({ kind: 'collection', collectionId }),
      ],
    };
    // A partial fixture: these tests rely on unset preferences staying undefined.
    jest
      .mocked(readPreferencesFile)
      .mockResolvedValueOnce(preferences as PreferencesData);
    const result = await resolveEffectivePluginSelectionRefs({
      collectionIds: [collectionId],
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'm', pluginName: 'p' }],
    });
    expect(readCollectionConfig).not.toHaveBeenCalled();
    expect(result.pluginRefs).toEqual([
      { marketplaceId: 'm', pluginName: 'p' },
    ]);
    expect(result.warnings).toEqual([]);
  });
});
