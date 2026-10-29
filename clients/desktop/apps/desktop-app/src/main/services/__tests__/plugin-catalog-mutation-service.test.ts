/**
 * Service tests for the portal Plugins-section MUTATION entry points
 * (design: docs/planning/2026-08-27-portal-plugins-section/design.md,
 * phase B). The underlying plugin/MCP services are mocked; the tests pin the
 * security- and contract-relevant behavior:
 *
 * - every mutation flows through the shared `refreshAfterSuccess` helper;
 * - external installs resolve the clone URL from the DESKTOP'S cached entry;
 * - `portal.marketplace.add` re-validates the repo with the shared parser;
 * - removal is idempotent at the portal boundary;
 * - the MCP toggle saves through `saveMcpServer` (the renderer's validated
 *   path) and returns the REDACTED detail projection — no secrets;
 * - a manifest-supplied external-plugin URL is re-validated (SSRF gate) before
 *   the clone, and every portal mutation is serialized one-at-a-time.
 */
jest.mock('node:fs/promises', () => ({
  readFile: jest.fn(),
}));
jest.mock('node:dns/promises', () => ({
  lookup: jest.fn(),
}));
jest.mock('../../lib/paths', () => ({
  getMcpServersIndexFilePath: jest.fn(() => '/mock/mcp-servers/index.json'),
}));
jest.mock('../../plugins/plugin-service', () => ({
  addMarketplace: jest.fn(),
  installBuiltInPlugin: jest.fn(),
  installPlugin: jest.fn(),
  loadMarketplaces: jest.fn(),
  loadMarketplacesCacheOnly: jest.fn(),
  refreshMarketplaces: jest.fn(),
  removeMarketplace: jest.fn(),
  updateMarketplace: jest.fn(),
}));
jest.mock('../../plugins/plugin-handlers', () => ({
  refreshAfterSuccess: jest.fn((_reason: string, operation: () => unknown) =>
    Promise.resolve(operation()),
  ),
  reportCuratedPluginInstallBestEffort: jest.fn(),
}));
jest.mock('../../skills/skill-service', () => ({
  loadSkills: jest.fn(),
  readSkillContent: jest.fn(),
}));
jest.mock('../../collections/collection-store', () => ({
  readCollectionIndex: jest.fn(),
  readCollectionConfig: jest.fn(),
}));
jest.mock('../../ipc/mcp-servers', () => ({
  readServer: jest.fn(),
  saveMcpServer: jest.fn(),
  setInstalledMcpConfigEnabled: jest.fn(),
  testMcpServerConnection: jest.fn(),
  deleteMcpServer: jest.fn(),
  resolveStandaloneHttpHandler: jest.fn(),
}));
jest.mock('../../mcp/account-catalog', () => ({
  loadAccountMcpRefConnections: jest.fn(),
}));

import type {
  MarketplaceInfo,
  PluginInfo,
} from '@canopy/desktop-shared/types/plugins';
import type { McpServerFile } from '@canopy/desktop-shared/types/mcp-servers';
import { lookup } from 'node:dns/promises';
import {
  __resetInFlightPortalInstallsForTests,
  __resetPluginMutationChainForTests,
  addPortalMarketplace,
  installPortalBuiltInPlugin,
  installPortalExternalPlugin,
  removePortalMarketplace,
  setPortalMcpConfigEnabled,
  testPortalMcpConnection,
  deletePortalMcpServer,
  startPortalMarketplacesRefresh,
  updatePortalMarketplace,
} from '../plugin-catalog-service';
import {
  addMarketplace,
  installBuiltInPlugin,
  installPlugin,
  loadMarketplacesCacheOnly,
  refreshMarketplaces,
  removeMarketplace,
  updateMarketplace,
} from '../../plugins/plugin-service';
import {
  refreshAfterSuccess,
  reportCuratedPluginInstallBestEffort,
} from '../../plugins/plugin-handlers';
import {
  readServer,
  saveMcpServer,
  setInstalledMcpConfigEnabled,
  testMcpServerConnection,
  deleteMcpServer,
  resolveStandaloneHttpHandler,
} from '../../ipc/mcp-servers';
import { loadAccountMcpRefConnections } from '../../mcp/account-catalog';

const mockedTestMcpConnection = jest.mocked(testMcpServerConnection);
const mockedInstallBuiltIn = jest.mocked(installBuiltInPlugin);
const mockedInstallPlugin = jest.mocked(installPlugin);
const mockedAddMarketplace = jest.mocked(addMarketplace);
const mockedUpdateMarketplace = jest.mocked(updateMarketplace);
const mockedRemoveMarketplace = jest.mocked(removeMarketplace);
const mockedRefreshMarketplaces = jest.mocked(refreshMarketplaces);
const mockedLoadCacheOnly = jest.mocked(loadMarketplacesCacheOnly);
const mockedRefreshAfterSuccess = jest.mocked(refreshAfterSuccess);
const mockedCuratedReport = jest.mocked(reportCuratedPluginInstallBestEffort);
const mockedReadServer = jest.mocked(readServer);
const mockedLoadAccountConnections = jest.mocked(loadAccountMcpRefConnections);
const mockedSaveMcpServer = jest.mocked(saveMcpServer);
const mockedLookup = jest.mocked(lookup);

/** Deferred promise handle for interleaving concurrent mutations in tests. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const publicLookup = [{ address: '140.82.113.3', family: 4 }] as Awaited<
  ReturnType<typeof lookup>
>;

/** Drain microtasks + one macrotask so a queued serialized mutation can start. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const providerStatus = {
  claude: {
    provider: 'claude' as const,
    state: 'valid' as const,
    accepted: true,
    pluginCount: 1,
    lastCheckedAt: '2026-08-27T00:00:00.000Z',
    installLocation: '/secret/claude/install',
  },
  codex: {
    provider: 'codex' as const,
    state: 'invalid' as const,
    accepted: false,
    pluginCount: 0,
    lastCheckedAt: '2026-08-27T00:00:00.000Z',
    error: 'not supported',
  },
};

function pluginInfo(overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    name: 'reviewer',
    sourcePath: '/secret/source/reviewer',
    marketplaceId: 'mkt',
    providerSupport: { claude: 'native', codex: 'none' },
    facets: {},
    ...overrides,
  };
}

function marketplaceInfo(
  overrides: Partial<MarketplaceInfo> = {},
): MarketplaceInfo {
  return {
    id: 'mkt',
    name: 'Marketplace',
    sourceType: 'github',
    sourceUrl: 'acme/marketplace',
    installLocation: '/secret/install/root',
    pluginCount: 1,
    plugins: [pluginInfo()],
    providerStatus,
    validProviders: ['claude'],
    ...overrides,
  };
}

function mcpServerFile(enabled: boolean): McpServerFile {
  return {
    version: 1,
    server: {
      definition: {
        id: 'srv-1',
        name: 'Server',
        description: 'desc',
        type: 'command',
        command: 'run-server',
        args: ['--token', 'super-secret-arg'],
        createdAt: '2026-08-27T00:00:00.000Z',
        updatedAt: '2026-08-27T00:00:00.000Z',
      },
      configs: [
        {
          id: 'cfg-1',
          name: 'default',
          description: '',
          enabled,
          envVars: { API_TOKEN: 'super-secret-env' },
          extraArgs: ['--password', 'super-secret-extra'],
          extraHeaders: { 'X-Auth': 'super-secret-header' },
          authToken: 'super-secret-auth-token',
          createdAt: '2026-08-27T00:00:00.000Z',
          updatedAt: '2026-08-27T00:00:00.000Z',
        },
      ],
    },
  } as McpServerFile;
}

describe('portal plugin mutation services', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetPluginMutationChainForTests();
    __resetInFlightPortalInstallsForTests();
    mockedLookup.mockResolvedValue(publicLookup);
    mockedRefreshMarketplaces.mockResolvedValue({ success: true });
    mockedRefreshAfterSuccess.mockImplementation(
      (_reason: string, operation: () => never) => Promise.resolve(operation()),
    );
  });

  it('installs a built-in plugin through refreshAfterSuccess and projects the reduced row', async () => {
    mockedInstallBuiltIn.mockResolvedValue({
      success: true,
      data: {
        plugin: pluginInfo({
          marketplaceId: 'curated/cloud',
          cachePath: '/secret/cache/reviewer',
        }),
        providerOutcomes: { claude: { installed: true } },
      },
    });

    const result = await installPortalBuiltInPlugin(
      'curated/cloud',
      'reviewer',
      ['claude'],
    );

    expect(mockedInstallBuiltIn).toHaveBeenCalledWith({
      marketplaceId: 'curated/cloud',
      pluginName: 'reviewer',
      providers: ['claude'],
    });
    expect(mockedRefreshAfterSuccess).toHaveBeenCalledWith(
      'portal.plugins.install_builtin',
      expect.any(Function),
    );
    expect(mockedCuratedReport).toHaveBeenCalledWith(
      'curated/cloud',
      'reviewer',
    );
    expect(result.plugin).toMatchObject({
      name: 'reviewer',
      marketplaceId: 'curated/cloud',
      installed: true,
    });
    // Reduced row: machine-local fields never cross the portal boundary.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('/secret/');
    expect(serialized).not.toContain('sourcePath');
    expect(serialized).not.toContain('cachePath');
    expect(serialized).not.toContain('facets');
  });

  it('surfaces a built-in install failure as a thrown execution_failed', async () => {
    mockedInstallBuiltIn.mockResolvedValue({
      success: false,
      error: 'claude: install failed',
    });

    await expect(
      installPortalBuiltInPlugin('builtin/app', 'reviewer', ['claude']),
    ).rejects.toMatchObject({
      code: 'execution_failed',
      message: 'claude: install failed',
    });
    expect(mockedCuratedReport).not.toHaveBeenCalled();
  });

  it('resolves the external install URL from the cached entry, never the browser', async () => {
    mockedLoadCacheOnly.mockResolvedValue({
      success: true,
      data: {
        version: 2,
        lastRefreshed: '2026-08-27T00:00:00.000Z',
        marketplaces: [
          marketplaceInfo({
            plugins: [
              pluginInfo({
                externalSource: {
                  source: 'github',
                  url: 'https://github.com/acme/reviewer.git',
                },
              }),
            ],
          }),
        ],
      },
    });
    mockedInstallPlugin.mockResolvedValue({
      success: true,
      data: pluginInfo({ cachePath: '/secret/cache/reviewer' }),
    });

    const result = await installPortalExternalPlugin('mkt', 'reviewer');

    expect(mockedInstallPlugin).toHaveBeenCalledWith(
      'mkt',
      'reviewer',
      'https://github.com/acme/reviewer.git',
      { disableRedirects: true, skipRefresh: true },
    );
    expect(result.plugin.installed).toBe(true);
  });

  it('rejects an external install for a plugin without an external source', async () => {
    mockedLoadCacheOnly.mockResolvedValue({
      success: true,
      data: {
        version: 2,
        lastRefreshed: '2026-08-27T00:00:00.000Z',
        marketplaces: [marketplaceInfo()],
      },
    });

    await expect(
      installPortalExternalPlugin('mkt', 'reviewer'),
    ).rejects.toMatchObject({ code: 'invalid_payload' });
    expect(mockedInstallPlugin).not.toHaveBeenCalled();
  });

  it('re-validates the marketplace repo with the shared GitHub parser', async () => {
    await expect(
      addPortalMarketplace('https://evil.example.com/acme/mkt'),
    ).rejects.toMatchObject({ code: 'invalid_payload' });
    expect(mockedAddMarketplace).not.toHaveBeenCalled();

    mockedAddMarketplace.mockResolvedValue({
      success: true,
      data: {
        marketplace: marketplaceInfo(),
        providerOutcomes: providerStatus,
      },
    });
    const result = await addPortalMarketplace(
      'https://github.com/acme/marketplace',
    );
    // The canonical owner/repo form is what reaches the provider CLIs.
    expect(mockedAddMarketplace).toHaveBeenCalledWith('acme/marketplace');
    expect(result.marketplace.id).toBe('mkt');
    // Reduced row: install locations and provider paths never cross.
    expect(JSON.stringify(result)).not.toContain('/secret/');
  });

  it('projects the updated marketplace through the reduced row builder', async () => {
    mockedUpdateMarketplace.mockResolvedValue({
      success: true,
      data: marketplaceInfo(),
    });

    const result = await updatePortalMarketplace('mkt');

    expect(mockedRefreshAfterSuccess).toHaveBeenCalledWith(
      'portal.marketplace.update',
      expect.any(Function),
    );
    expect(result.marketplace.plugins[0]).toMatchObject({ name: 'reviewer' });
    expect(JSON.stringify(result)).not.toContain('installLocation');
  });

  it('treats removing an unknown marketplace as idempotent success', async () => {
    mockedRemoveMarketplace.mockResolvedValue({
      success: false,
      error: 'Marketplace "mkt" not found.',
    });

    await expect(removePortalMarketplace('mkt')).resolves.toEqual({
      removed: true,
      alreadyAbsent: true,
    });
  });

  it('fails the removal when a requested provider errored (row kept for retry)', async () => {
    mockedRemoveMarketplace.mockResolvedValue({
      success: true,
      data: {
        marketplace: marketplaceInfo(),
        removedProviders: [],
        providerOutcomes: {
          claude: {
            removed: false,
            alreadyAbsent: false,
            error: 'provider rejected the removal',
          },
          codex: { removed: true, alreadyAbsent: false },
        },
      },
    });

    await expect(removePortalMarketplace('mkt')).rejects.toMatchObject({
      code: 'execution_failed',
      message: 'claude: provider rejected the removal',
    });
  });

  it('reports full removal and alreadyAbsent for the requested providers', async () => {
    mockedRemoveMarketplace.mockResolvedValue({
      success: true,
      data: {
        marketplace: null,
        removedProviders: ['codex'],
        providerOutcomes: {
          claude: { removed: false, alreadyAbsent: false },
          codex: { removed: false, alreadyAbsent: true },
        },
      },
    });

    await expect(removePortalMarketplace('mkt', ['codex'])).resolves.toEqual({
      removed: true,
      alreadyAbsent: true,
    });
    expect(mockedRemoveMarketplace).toHaveBeenCalledWith('mkt', {
      providers: ['codex'],
    });
  });

  it('kicks the full refresh without awaiting its completion', async () => {
    let settled = false;
    mockedRefreshMarketplaces.mockReturnValue(
      new Promise(() => {
        // Never settles: a fan-out refresh can run for minutes.
      }).then(() => {
        settled = true;
        return { success: true as const };
      }) as ReturnType<typeof refreshMarketplaces>,
    );

    await expect(startPortalMarketplacesRefresh()).resolves.toBeUndefined();
    expect(mockedRefreshAfterSuccess).toHaveBeenCalledWith(
      'portal.marketplace.refresh_all',
      expect.any(Function),
    );
    expect(settled).toBe(false);
  });

  describe('setPortalMcpConfigEnabled', () => {
    it('rejects an unsafe server id before touching the store', async () => {
      await expect(
        setPortalMcpConfigEnabled('../etc/passwd', 'cfg-1', true),
      ).rejects.toMatchObject({ code: 'invalid_payload' });
      expect(mockedReadServer).not.toHaveBeenCalled();
    });

    it('refuses an account custom server without touching the store', async () => {
      await expect(
        setPortalMcpConfigEnabled(
          'custom:3f2b6c1e-8d4a-4b7e-9c2f-1a5d6e7f8a9b',
          'default',
          false,
        ),
      ).rejects.toMatchObject({
        code: 'invalid_payload',
        message: 'Account MCP servers are managed in your account.',
      });
      expect(mockedReadServer).not.toHaveBeenCalled();
      expect(mockedSaveMcpServer).not.toHaveBeenCalled();
    });

    it('refuses a curated account fallback the detail page was served', async () => {
      // No device file, but the account connection get_server falls back to.
      mockedReadServer.mockRejectedValue(new Error('ENOENT'));
      mockedLoadAccountConnections.mockResolvedValue([
        {
          id: 'conn-1',
          serverKey: 'github',
          configId: 'default',
          displayName: 'GitHub',
          status: 'CONNECTED',
          routeId: 'route-1',
          enabledTools: null,
          kind: 'CURATED',
        },
      ]);
      await expect(
        setPortalMcpConfigEnabled('github', 'default', false),
      ).rejects.toMatchObject({
        code: 'invalid_payload',
        message: 'Account MCP servers are managed in your account.',
      });
      expect(mockedSaveMcpServer).not.toHaveBeenCalled();
    });

    it('maps a missing server onto not_found', async () => {
      mockedLoadAccountConnections.mockResolvedValue(null);
      mockedReadServer.mockRejectedValue(new Error('ENOENT'));
      await expect(
        setPortalMcpConfigEnabled('srv-1', 'cfg-1', true),
      ).rejects.toMatchObject({ code: 'not_found' });
    });

    it('maps a missing config onto not_found without saving', async () => {
      mockedReadServer.mockResolvedValue(mcpServerFile(false));
      await expect(
        setPortalMcpConfigEnabled('srv-1', 'cfg-missing', true),
      ).rejects.toMatchObject({ code: 'not_found' });
      expect(mockedSaveMcpServer).not.toHaveBeenCalled();
    });

    it('flips only the named config through the validated save path and redacts the result', async () => {
      mockedReadServer
        .mockResolvedValueOnce(mcpServerFile(false))
        .mockResolvedValueOnce(mcpServerFile(true));
      jest
        .mocked(setInstalledMcpConfigEnabled)
        .mockResolvedValue(mcpServerFile(true));

      const result = await setPortalMcpConfigEnabled('srv-1', 'cfg-1', true);

      expect(setInstalledMcpConfigEnabled).toHaveBeenCalledWith(
        'srv-1',
        'cfg-1',
        true,
      );
      expect(mockedSaveMcpServer).not.toHaveBeenCalled();

      // The RESULT is the redacted projection: names/counts/presence only.
      expect(result.server.configs[0]).toMatchObject({
        id: 'cfg-1',
        enabled: true,
        envVarNames: ['API_TOKEN'],
        extraArgCount: 2,
        extraHeaderNames: ['X-Auth'],
        hasAuthToken: true,
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('super-secret');
      expect(serialized).not.toContain('authToken":"');
      expect(serialized).not.toContain('envVars');
      expect(serialized).not.toContain('extraArgs');
    });

    it('skips the save when the config already has the requested state', async () => {
      mockedReadServer.mockResolvedValue(mcpServerFile(true));

      const result = await setPortalMcpConfigEnabled('srv-1', 'cfg-1', true);

      expect(mockedSaveMcpServer).not.toHaveBeenCalled();
      expect(result.server.configs[0]?.enabled).toBe(true);
    });
  });
});

function externalPluginCache(sourceUrl: string): {
  success: true;
  data: {
    version: 2;
    lastRefreshed: string;
    marketplaces: MarketplaceInfo[];
  };
} {
  return {
    success: true,
    data: {
      version: 2,
      lastRefreshed: '2026-08-27T00:00:00.000Z',
      marketplaces: [
        marketplaceInfo({
          plugins: [
            pluginInfo({
              externalSource: { source: 'github', url: sourceUrl },
            }),
          ],
        }),
      ],
    },
  };
}

describe('external install SSRF gate (finding 1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetPluginMutationChainForTests();
    __resetInFlightPortalInstallsForTests();
    mockedLookup.mockResolvedValue(publicLookup);
    mockedRefreshMarketplaces.mockResolvedValue({ success: true });
    mockedRefreshAfterSuccess.mockImplementation(
      (_reason: string, operation: () => never) => Promise.resolve(operation()),
    );
  });

  // A portal session can plant any of these via portal.marketplace.add's
  // manifest, so the "desktop-cached" URL is still attacker-influenced.
  const maliciousUrls: Array<[string, string]> = [
    ['file:///etc/passwd', 'file scheme'],
    ['ssh://git@internal/repo.git', 'ssh scheme'],
    ['https://169.254.169.254/repo.git', 'cloud metadata IP'],
    ['https://user:tok@github.com/acme/repo.git', 'credentialed https'],
  ];

  it.each(maliciousUrls)(
    'refuses to clone a manifest URL using %s (%s) and never reaches installPlugin',
    async (sourceUrl) => {
      mockedLoadCacheOnly.mockResolvedValue(externalPluginCache(sourceUrl));

      await expect(
        installPortalExternalPlugin('mkt', 'reviewer'),
      ).rejects.toMatchObject({ code: 'invalid_payload' });
      expect(mockedInstallPlugin).not.toHaveBeenCalled();
    },
  );

  it('refuses a public name that resolves to a private address', async () => {
    mockedLoadCacheOnly.mockResolvedValue(
      externalPluginCache('https://sneaky.example.com/acme/repo.git'),
    );
    mockedLookup.mockResolvedValue([
      { address: '10.0.0.9', family: 4 },
    ] as Awaited<ReturnType<typeof lookup>>);

    await expect(
      installPortalExternalPlugin('mkt', 'reviewer'),
    ).rejects.toMatchObject({ code: 'invalid_payload' });
    expect(mockedInstallPlugin).not.toHaveBeenCalled();
  });

  it('allows a public GitHub https URL through to installPlugin', async () => {
    mockedLoadCacheOnly.mockResolvedValue(
      externalPluginCache('https://github.com/acme/reviewer.git'),
    );
    mockedInstallPlugin.mockResolvedValue({
      success: true,
      data: pluginInfo(),
    });

    await installPortalExternalPlugin('mkt', 'reviewer');
    expect(mockedInstallPlugin).toHaveBeenCalledWith(
      'mkt',
      'reviewer',
      'https://github.com/acme/reviewer.git',
      { disableRedirects: true, skipRefresh: true },
    );
  });
});

describe('portal install in-flight dedupe (round-2 finding)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetPluginMutationChainForTests();
    __resetInFlightPortalInstallsForTests();
    mockedLookup.mockResolvedValue(publicLookup);
    mockedRefreshMarketplaces.mockResolvedValue({ success: true });
    mockedRefreshAfterSuccess.mockImplementation(
      (_reason: string, operation: () => never) => Promise.resolve(operation()),
    );
  });

  it('runs one install and answers both callers when a duplicate arrives in flight', async () => {
    const gate = deferred<void>();
    mockedInstallBuiltIn.mockImplementation(() =>
      gate.promise.then(() => ({
        success: true as const,
        data: { plugin: pluginInfo(), providerOutcomes: {} },
      })),
    );

    const a = installPortalBuiltInPlugin('builtin/app', 'reviewer', ['claude']);
    const b = installPortalBuiltInPlugin('builtin/app', 'reviewer', ['claude']);
    await flush();

    gate.resolve();
    const [first, second] = await Promise.all([a, b]);

    // The whole point: the non-idempotent install ran exactly once...
    expect(mockedInstallBuiltIn).toHaveBeenCalledTimes(1);
    // ...and the duplicate still got a correct answer rather than an error.
    expect(second).toEqual(first);
    // A collapsed group is one real install, so this fires once, not twice.
    expect(mockedCuratedReport).toHaveBeenCalledTimes(1);
  });

  it('propagates a failure to every collapsed caller', async () => {
    const gate = deferred<void>();
    mockedInstallBuiltIn.mockImplementation(() =>
      gate.promise.then(() => ({
        success: false as const,
        error: 'disk full',
      })),
    );

    const a = installPortalBuiltInPlugin('builtin/app', 'reviewer', ['claude']);
    const b = installPortalBuiltInPlugin('builtin/app', 'reviewer', ['claude']);
    const settled = Promise.all([
      a.catch((e: Error) => e.message),
      b.catch((e: Error) => e.message),
    ]);
    await flush();
    gate.resolve();

    expect(await settled).toEqual(['disk full', 'disk full']);
    expect(mockedInstallBuiltIn).toHaveBeenCalledTimes(1);
  });

  it('does not collapse installs that target different providers', async () => {
    mockedInstallBuiltIn.mockResolvedValue({
      success: true,
      data: { plugin: pluginInfo(), providerOutcomes: {} },
    });

    await Promise.all([
      installPortalBuiltInPlugin('builtin/app', 'reviewer', ['claude']),
      installPortalBuiltInPlugin('builtin/app', 'reviewer', ['codex']),
    ]);

    expect(mockedInstallBuiltIn).toHaveBeenCalledTimes(2);
  });

  it('collapses regardless of provider argument order', async () => {
    mockedInstallBuiltIn.mockResolvedValue({
      success: true,
      data: { plugin: pluginInfo(), providerOutcomes: {} },
    });

    await Promise.all([
      installPortalBuiltInPlugin('builtin/app', 'reviewer', [
        'claude',
        'codex',
      ]),
      installPortalBuiltInPlugin('builtin/app', 'reviewer', [
        'codex',
        'claude',
      ]),
    ]);

    expect(mockedInstallBuiltIn).toHaveBeenCalledTimes(1);
  });

  it('does not collapse installs of different plugins', async () => {
    mockedInstallBuiltIn.mockResolvedValue({
      success: true,
      data: { plugin: pluginInfo(), providerOutcomes: {} },
    });

    await Promise.all([
      installPortalBuiltInPlugin('builtin/app', 'reviewer', ['claude']),
      installPortalBuiltInPlugin('builtin/app', 'formatter', ['claude']),
    ]);

    expect(mockedInstallBuiltIn).toHaveBeenCalledTimes(2);
  });

  it('is pure in-flight: a later identical install does real work again', async () => {
    mockedInstallBuiltIn.mockResolvedValue({
      success: true,
      data: { plugin: pluginInfo(), providerOutcomes: {} },
    });

    await installPortalBuiltInPlugin('builtin/app', 'reviewer', ['claude']);
    await installPortalBuiltInPlugin('builtin/app', 'reviewer', ['claude']);

    // Sequential, not concurrent — nothing to collapse onto, so it is not a
    // result cache.
    expect(mockedInstallBuiltIn).toHaveBeenCalledTimes(2);
  });

  /** Seed the cache lookup that external installs resolve their clone URL from. */
  function seedExternalPlugin(): void {
    mockedLoadCacheOnly.mockResolvedValue({
      success: true,
      data: {
        version: 2,
        lastRefreshed: '2026-08-27T00:00:00.000Z',
        marketplaces: [
          marketplaceInfo({
            plugins: [
              pluginInfo({
                externalSource: {
                  source: 'github',
                  url: 'https://github.com/acme/reviewer.git',
                },
              }),
            ],
          }),
        ],
      },
    });
  }

  it('collapses duplicate external installs onto one clone', async () => {
    seedExternalPlugin();
    const gate = deferred<void>();
    mockedInstallPlugin.mockImplementation(() =>
      gate.promise.then(() => ({ success: true as const, data: pluginInfo() })),
    );

    const a = installPortalExternalPlugin('mkt', 'reviewer');
    const b = installPortalExternalPlugin('mkt', 'reviewer');
    await flush();
    gate.resolve();
    const [first, second] = await Promise.all([a, b]);

    expect(mockedInstallPlugin).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('keeps built-in and external installs of the same name separate', async () => {
    seedExternalPlugin();
    mockedInstallBuiltIn.mockResolvedValue({
      success: true,
      data: { plugin: pluginInfo(), providerOutcomes: {} },
    });
    mockedInstallPlugin.mockResolvedValue({
      success: true,
      data: pluginInfo(),
    });

    await Promise.all([
      installPortalBuiltInPlugin('mkt', 'reviewer', ['claude']),
      installPortalExternalPlugin('mkt', 'reviewer'),
    ]);

    expect(mockedInstallBuiltIn).toHaveBeenCalledTimes(1);
    expect(mockedInstallPlugin).toHaveBeenCalledTimes(1);
  });
});

describe('portal mutation serialization (finding 2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetPluginMutationChainForTests();
    __resetInFlightPortalInstallsForTests();
    mockedLookup.mockResolvedValue(publicLookup);
    mockedRefreshMarketplaces.mockResolvedValue({ success: true });
    mockedRefreshAfterSuccess.mockImplementation(
      (_reason: string, operation: () => never) => Promise.resolve(operation()),
    );
  });

  // NOTE: this uses two DIFFERENT provider sets on purpose. Two byte-identical
  // installs are now collapsed onto one in-flight promise (see the dedupe
  // describe below), so they could no longer demonstrate serialization.
  it('runs two concurrent non-identical installs one-at-a-time', async () => {
    const first = deferred<{
      success: true;
      data: { plugin: PluginInfo; providerOutcomes: Record<string, never> };
    }>();
    let inFlight = 0;
    let maxInFlight = 0;
    mockedInstallBuiltIn.mockImplementation(() => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const pending =
        inFlight === 1 ? first.promise : Promise.resolve(undefined);
      return Promise.resolve(pending).then(() => {
        inFlight -= 1;
        return {
          success: true as const,
          data: { plugin: pluginInfo(), providerOutcomes: {} },
        };
      });
    });

    const a = installPortalBuiltInPlugin('builtin/app', 'reviewer', ['claude']);
    const b = installPortalBuiltInPlugin('builtin/app', 'reviewer', ['codex']);
    await flush();
    // The second install must NOT have started while the first is pending.
    expect(mockedInstallBuiltIn).toHaveBeenCalledTimes(1);

    first.resolve({
      success: true,
      data: { plugin: pluginInfo(), providerOutcomes: {} },
    });
    await Promise.all([a, b]);

    expect(mockedInstallBuiltIn).toHaveBeenCalledTimes(2);
    // No overlap: at most one install body ran at any instant.
    expect(maxInFlight).toBe(1);
  });

  it('serializes two external installs of different plugins so both entries survive', async () => {
    // A marketplace whose manifest lists two distinct external plugins.
    mockedLoadCacheOnly.mockResolvedValue({
      success: true,
      data: {
        version: 2,
        lastRefreshed: '2026-08-27T00:00:00.000Z',
        marketplaces: [
          marketplaceInfo({
            plugins: [
              pluginInfo({
                name: 'alpha',
                externalSource: {
                  source: 'github',
                  url: 'https://github.com/acme/alpha.git',
                },
              }),
              pluginInfo({
                name: 'beta',
                externalSource: {
                  source: 'github',
                  url: 'https://github.com/acme/beta.git',
                },
              }),
            ],
          }),
        ],
      },
    });
    const cloneOrder: string[] = [];
    const firstClone = deferred<void>();
    mockedInstallPlugin.mockImplementation((_mkt, name) => {
      cloneOrder.push(`start:${name}`);
      const gate =
        cloneOrder.length === 1 ? firstClone.promise : Promise.resolve();
      return Promise.resolve(gate).then(() => {
        cloneOrder.push(`end:${name}`);
        return { success: true as const, data: pluginInfo({ name }) };
      });
    });

    const a = installPortalExternalPlugin('mkt', 'alpha');
    const b = installPortalExternalPlugin('mkt', 'beta');
    await flush();
    // Second clone cannot start until the first finishes (no interleave).
    expect(cloneOrder).toEqual(['start:alpha']);

    firstClone.resolve();
    await Promise.all([a, b]);

    // Strict start→end→start→end ordering: both installs ran, fully serialized,
    // so neither entry's cache write clobbers the other.
    expect(cloneOrder).toEqual([
      'start:alpha',
      'end:alpha',
      'start:beta',
      'end:beta',
    ]);
    expect(mockedInstallPlugin).toHaveBeenCalledTimes(2);
  });

  it('does not interleave an add and a remove of the same marketplace', async () => {
    const order: string[] = [];
    const addGate = deferred<void>();
    mockedAddMarketplace.mockImplementation(() => {
      order.push('add:start');
      return addGate.promise.then(() => {
        order.push('add:end');
        return {
          success: true as const,
          data: {
            marketplace: marketplaceInfo(),
            providerOutcomes: providerStatus,
          },
        };
      });
    });
    mockedRemoveMarketplace.mockImplementation(() => {
      order.push('remove:start');
      return Promise.resolve({ success: true as const, data: undefined }).then(
        () => {
          order.push('remove:end');
          return { success: true as const, data: { removed: true } as never };
        },
      );
    });

    const add = addPortalMarketplace('acme/marketplace');
    const remove = removePortalMarketplace('mkt');
    await flush();
    expect(order).toEqual(['add:start']);

    addGate.resolve();
    await Promise.allSettled([add, remove]);

    expect(order).toEqual([
      'add:start',
      'add:end',
      'remove:start',
      'remove:end',
    ]);
  });

  it('holds an install behind an in-flight refresh_all (no mid-refresh interleave)', async () => {
    const order: string[] = [];
    const refreshGate = deferred<void>();
    mockedRefreshMarketplaces.mockImplementation(() => {
      order.push('refresh:start');
      return refreshGate.promise.then(() => {
        order.push('refresh:end');
        return { success: true as const };
      }) as ReturnType<typeof refreshMarketplaces>;
    });
    mockedInstallBuiltIn.mockImplementation(() => {
      order.push('install:start');
      return Promise.resolve({
        success: true as const,
        data: { plugin: pluginInfo(), providerOutcomes: {} },
      });
    });

    await startPortalMarketplacesRefresh();
    const install = installPortalBuiltInPlugin('builtin/app', 'reviewer', [
      'claude',
    ]);
    await flush();
    // Refresh is running; the install must wait, not interleave.
    expect(order).toEqual(['refresh:start']);

    refreshGate.resolve();
    await install;

    expect(order).toEqual(['refresh:start', 'refresh:end', 'install:start']);
  });

  it('keeps the install-triggered refresh inside the queue slot (finding 2 regression)', async () => {
    // The external install path drives refreshMarketplaces itself (installPlugin
    // is told skipRefresh:true) INSIDE the serialized slot, so the next queued
    // mutation cannot start until that refresh settles — closing the race where
    // installPlugin's own detached refresh ran after the slot released.
    mockedLoadCacheOnly.mockResolvedValue(
      externalPluginCache('https://github.com/acme/reviewer.git'),
    );
    mockedInstallPlugin.mockResolvedValue({
      success: true,
      data: pluginInfo(),
    });
    const order: string[] = [];
    const refreshGate = deferred<void>();
    mockedRefreshMarketplaces.mockImplementation(() => {
      order.push('refresh:start');
      return refreshGate.promise.then(() => {
        order.push('refresh:end');
        return { success: true as const };
      }) as ReturnType<typeof refreshMarketplaces>;
    });
    mockedInstallBuiltIn.mockImplementation(() => {
      order.push('next-install:start');
      return Promise.resolve({
        success: true as const,
        data: { plugin: pluginInfo(), providerOutcomes: {} },
      });
    });

    const first = installPortalExternalPlugin('mkt', 'reviewer');
    const second = installPortalBuiltInPlugin('builtin/app', 'reviewer', [
      'claude',
    ]);
    await flush();

    // installPlugin already resolved, but the slot is held on the triggered
    // refresh, so the second (built-in) install has NOT started.
    expect(order).toEqual(['refresh:start']);
    expect(mockedInstallBuiltIn).not.toHaveBeenCalled();
    // installPlugin was told not to fire its own detached refresh.
    expect(mockedInstallPlugin).toHaveBeenCalledWith(
      'mkt',
      'reviewer',
      'https://github.com/acme/reviewer.git',
      { disableRedirects: true, skipRefresh: true },
    );

    refreshGate.resolve();
    await Promise.all([first, second]);

    expect(order).toEqual([
      'refresh:start',
      'refresh:end',
      'next-install:start',
    ]);
  });
});

describe('Portal MCP management services', () => {
  const serverId = 'aaa-bbb-111';
  const configId = 'ccc-ddd-222';
  beforeEach(() => {
    jest.clearAllMocks();
    const file = mcpServerFile(true);
    file.server.definition.id = serverId;
    const config = file.server.configs[0];
    if (!config) throw new Error('Missing test config');
    config.id = configId;
    mockedReadServer.mockResolvedValue(file);
    jest.mocked(resolveStandaloneHttpHandler).mockResolvedValue('canopy');
    mockedTestMcpConnection.mockResolvedValue({
      serverId,
      configId,
      success: true,
      message: 'super-secret-env',
      tools: ['list_tools'],
      responseTime: 14,
    });
  });

  it('reuses the selected configuration and projects safe results at runtime', async () => {
    expect(await testPortalMcpConnection(serverId, configId)).toEqual({
      serverId,
      configId,
      success: true,
      message: 'Connection successful.',
      tools: ['list_tools'],
      responseTime: 14,
    });
    expect(testMcpServerConnection).toHaveBeenCalledWith(
      serverId,
      configId,
      expect.any(Function),
    );
  });
  it('requires selection for multiple configurations and rejects removed configs', async () => {
    const file = await readServer(serverId);
    const config = file.server.configs[0];
    if (!config) throw new Error('Missing test config');
    file.server.configs.push({ ...config, id: 'eee-fff-333' });
    await expect(testPortalMcpConnection(serverId)).rejects.toMatchObject({
      code: 'invalid_payload',
    });
    await expect(
      testPortalMcpConnection(serverId, 'removed'),
    ).rejects.toMatchObject({ code: 'invalid_payload' });
    expect(testMcpServerConnection).not.toHaveBeenCalled();
  });
  it('accepts ordinary arguments and non-secret env values in tool names', async () => {
    const file = await readServer(serverId);
    file.server.definition.args = ['run', '-i', '--rm'];
    const config = file.server.configs[0];
    if (!config) throw new Error('Missing config');
    config.envVars = { LOG_LEVEL: 'info', ENABLED: '1', FEATURE: 'true' };
    config.extraArgs = ['info'];
    mockedTestMcpConnection.mockResolvedValue({
      serverId,
      configId,
      success: true,
      message: 'OK',
      tools: ['run_workflow', 'info1_true'],
    });
    await expect(
      testPortalMcpConnection(serverId, configId),
    ).resolves.toMatchObject({ success: true });
  });
  it('rejects a vault token attached to the actual HTTP probe', async () => {
    const file = await readServer(serverId);
    mockedTestMcpConnection.mockImplementation((...args) => {
      const inspect = Reflect.get(args, 2);
      if (typeof inspect === 'function')
        inspect({
          ...file.server.definition,
          headers: { Authorization: 'Bearer vault_secret_identifier' },
        });
      return Promise.resolve({
        serverId,
        configId,
        success: true,
        message: 'OK',
        tools: ['vault_secret_identifier'],
      });
    });
    await expect(
      testPortalMcpConnection(serverId, configId),
    ).rejects.toMatchObject({ code: 'execution_failed' });
  });
  it.each(['token', 'env', 'argument'])(
    'rejects a short known credential from %s',
    async (source) => {
      const file = await readServer(serverId);
      const config = file.server.configs[0];
      if (!config) throw new Error('Missing config');
      if (source === 'token') config.authToken = 'abc';
      if (source === 'env') config.envVars = { API_TOKEN: 'abc' };
      if (source === 'argument') config.extraArgs = ['--api-key=abc'];
      mockedTestMcpConnection.mockResolvedValue({
        serverId,
        configId,
        success: true,
        message: 'OK',
        tools: ['list_abc'],
      });
      await expect(
        testPortalMcpConnection(serverId, configId),
      ).rejects.toMatchObject({ code: 'execution_failed' });
    },
  );
  it('rejects account-only keys before reading a device path', async () => {
    await expect(
      deletePortalMcpServer('custom:12345678-1234-1234-1234-123456789012'),
    ).rejects.toMatchObject({ code: 'invalid_target' });
    expect(readServer).not.toHaveBeenCalled();
    expect(deleteMcpServer).not.toHaveBeenCalled();
  });
  it('rejects provider-managed files for both operations', async () => {
    const file = await readServer(serverId);
    file.server.definition.type = 'http';
    jest.mocked(resolveStandaloneHttpHandler).mockResolvedValue('provider');
    await expect(
      testPortalMcpConnection(serverId, configId),
    ).rejects.toMatchObject({ code: 'invalid_target' });
    await expect(deletePortalMcpServer(serverId)).rejects.toMatchObject({
      code: 'invalid_target',
    });
    expect(deleteMcpServer).not.toHaveBeenCalled();
  });
  it('deletes the canonical device copy through the existing writer', async () => {
    expect(await deletePortalMcpServer(serverId)).toEqual({ deleted: true });
    expect(deleteMcpServer).toHaveBeenCalledWith(serverId);
  });
  it('retains cloud-linked copies when deleting a canonical device file', async () => {
    const file = await readServer(serverId);
    file.server.definition.type = 'http';
    jest.mocked(resolveStandaloneHttpHandler).mockResolvedValue('account');
    expect(await deletePortalMcpServer(serverId)).toEqual({ deleted: true });
    expect(deleteMcpServer).toHaveBeenCalledTimes(1);
    expect(loadAccountMcpRefConnections).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { serverId, configId, success: true, tools: Array(1001).fill('tool') },
    { serverId, configId: 'wrong', success: true },
    { serverId, configId, success: true, responseTime: NaN },
  ])('rejects malformed or oversized runtime results', async (raw) => {
    mockedTestMcpConnection.mockImplementation(() =>
      Promise.resolve(
        JSON.parse(JSON.stringify(raw)) as Awaited<
          ReturnType<typeof testMcpServerConnection>
        >,
      ),
    );
    await expect(
      testPortalMcpConnection(serverId, configId),
    ).rejects.toMatchObject({ code: 'execution_failed' });
  });
  it('never forwards errors or messages that contain server secrets', async () => {
    mockedTestMcpConnection.mockResolvedValue({
      serverId,
      configId,
      success: false,
      message: 'super-secret-auth-token',
      error: 'super-secret-env',
    });
    expect(
      JSON.stringify(await testPortalMcpConnection(serverId, configId)),
    ).not.toContain('super-secret');
    mockedTestMcpConnection.mockRejectedValue(new Error('super-secret-env'));
    await expect(testPortalMcpConnection(serverId, configId)).rejects.toThrow(
      'The MCP connection test failed.',
    );
    jest
      .mocked(deleteMcpServer)
      .mockRejectedValue(new Error('super-secret-env'));
    await expect(deletePortalMcpServer(serverId)).rejects.toThrow(
      'The MCP server could not be deleted.',
    );
  });
});

it('redacts a credential echoed as a syntactically valid tool name (CAN-4265)', async () => {
  const file = mcpServerFile(true);
  file.server.definition.id = 'aaa';
  file.server.definition.headers = {
    Authorization: 'Bearer secret_identifier',
  };
  const config = file.server.configs[0];
  if (!config) throw new Error('Missing test config');
  config.id = 'bbb';
  mockedReadServer.mockResolvedValue(file);
  mockedTestMcpConnection.mockResolvedValue({
    serverId: 'aaa',
    configId: 'bbb',
    success: true,
    message: 'OK',
    tools: ['secret_identifier'],
  });
  await expect(testPortalMcpConnection('aaa', 'bbb')).rejects.toMatchObject({
    code: 'execution_failed',
  });
});
