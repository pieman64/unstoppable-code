/** @jest-environment jsdom */

interface ImportedPluginRef {
  marketplaceId: string;
  pluginName: string;
}

const mockImportSharedMarketplacePlugin = jest.fn<
  Promise<ImportedPluginRef>,
  [unknown, string]
>();

jest.mock('@/lib/sharedPluginMarketplaceImport', () => ({
  importSharedMarketplacePlugin: (
    marketplace: unknown,
    pluginName: string,
  ): Promise<ImportedPluginRef> =>
    mockImportSharedMarketplacePlugin(marketplace, pluginName),
}));

import { installSharedPluginRef } from '../publicSharePluginInstall';

describe('installSharedPluginRef', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('installs a GitHub marketplace plugin from its portable repo ref', async () => {
    Object.assign(window, {
      plugins: {
        loadMarketplacesCacheOnly: jest.fn().mockResolvedValue({
          success: false,
          error: 'not cached',
        }),
        loadMarketplaces: jest
          .fn()
          .mockResolvedValue({ success: false, error: 'not cached' }),
      },
      skills: { loadSkills: jest.fn() },
    });
    mockImportSharedMarketplacePlugin.mockResolvedValue({
      marketplaceId: 'acme',
      pluginName: 'browser',
    });
    const ref = {
      type: 'plugin' as const,
      marketplace: { type: 'github' as const, repo: 'acme/plugins' },
      plugin_name: 'browser',
    };

    await expect(installSharedPluginRef(ref)).resolves.toEqual({
      entity: 'plugin',
      marketplaceId: 'acme',
      pluginName: 'browser',
      entryId: 'mkt:acme/browser',
    });
    expect(mockImportSharedMarketplacePlugin).toHaveBeenCalledWith(
      ref.marketplace,
      ref.plugin_name,
    );
  });

  it('installs a missing Codex plugin from its trusted local catalog source', async () => {
    const marketplace = {
      id: 'codex-tools',
      name: 'Codex Tools',
      description: '',
      sourceType: 'codex' as const,
      sourceUrl: 'codex:tools',
      installLocation: '/tmp/codex-tools',
      lastUpdated: '2026-08-01T00:00:00.000Z',
      pluginCount: 1,
      plugins: [
        {
          name: 'browser',
          description: 'Browser tools',
          sourcePath: '',
          marketplaceId: 'codex-tools',
          details: null,
          externalSource: {
            source: 'github' as const,
            url: 'https://github.com/acme/browser.git',
          },
          providerSupport: {
            claude: 'none' as const,
            codex: 'native' as const,
          },
          facets: {},
        },
      ],
      providerStatus: {},
      validProviders: ['codex' as const],
    };
    const cache = {
      version: 2 as const,
      lastRefreshed: '2026-08-01T00:00:00.000Z',
      lastProviderRefreshAt: '2026-08-01T00:00:00.000Z',
      marketplaces: [marketplace],
    };
    const installPlugin = jest.fn().mockResolvedValue({
      success: true,
      data: {
        ...marketplace.plugins[0],
        details: {
          skills: [],
          agents: [],
          commands: [],
          hooks: [],
          mcpServers: [],
          lspServers: [],
          hasReadme: false,
        },
      },
    });
    Object.assign(window, {
      plugins: {
        loadMarketplacesCacheOnly: jest
          .fn()
          .mockResolvedValue({ success: true, data: cache }),
        loadMarketplaces: jest
          .fn()
          .mockResolvedValue({ success: true, data: cache }),
        installPlugin,
      },
      skills: { loadSkills: jest.fn() },
    });

    await expect(
      installSharedPluginRef({
        type: 'codex_plugin',
        marketplace: { type: 'codex-builtin', id: 'codex-tools' },
        plugin_name: 'browser',
      }),
    ).resolves.toEqual({
      entity: 'plugin',
      marketplaceId: 'codex-tools',
      pluginName: 'browser',
      entryId: 'mkt:codex-tools/browser',
    });
    expect(installPlugin).toHaveBeenCalledWith(
      'codex-tools',
      'browser',
      'https://github.com/acme/browser.git',
    );
  });

  it('installs a bundled plugin into its available provider', async () => {
    const plugin = {
      name: 'browser',
      description: 'Browser tools',
      sourcePath: 'plugins/browser',
      marketplaceId: 'builtin/app',
      builtIn: true,
      details: {
        skills: [],
        agents: [],
        commands: [],
        hooks: [],
        mcpServers: [],
        lspServers: [],
        hasReadme: false,
      },
      providerSupport: { claude: 'native' as const, codex: 'none' as const },
      facets: {},
      globalInstallStatus: {
        checkedAt: '2026-08-01T00:00:00.000Z',
        claude: { available: true, installed: false },
      },
    };
    const marketplace = {
      id: 'builtin/app',
      name: 'Built-in Plugins',
      description: '',
      sourceType: 'builtin' as const,
      sourceUrl: 'builtin:app',
      installLocation: '/tmp/builtin-app',
      lastUpdated: '2026-08-01T00:00:00.000Z',
      builtIn: true,
      pluginCount: 1,
      plugins: [plugin],
      providerStatus: {},
      validProviders: ['claude' as const],
    };
    const cache = {
      version: 2 as const,
      lastRefreshed: '2026-08-01T00:00:00.000Z',
      lastProviderRefreshAt: '2026-08-01T00:00:00.000Z',
      marketplaces: [marketplace],
    };
    const installBuiltInPlugin = jest.fn().mockResolvedValue({
      success: true,
      data: {
        plugin: {
          ...plugin,
          globalInstallStatus: {
            ...plugin.globalInstallStatus,
            claude: { available: true, installed: true },
          },
        },
        providerOutcomes: [],
      },
    });
    Object.assign(window, {
      plugins: {
        loadMarketplacesCacheOnly: jest
          .fn()
          .mockResolvedValue({ success: true, data: cache }),
        loadMarketplaces: jest
          .fn()
          .mockResolvedValue({ success: true, data: cache }),
        installBuiltInPlugin,
      },
      skills: { loadSkills: jest.fn() },
    });

    await expect(
      installSharedPluginRef({
        type: 'claude_plugin',
        marketplace: { type: 'builtin', id: 'app' },
        plugin_name: 'browser',
      }),
    ).resolves.toEqual({
      entity: 'plugin',
      marketplaceId: 'builtin/app',
      pluginName: 'browser',
      entryId: 'mkt:builtin/app/browser',
    });
    expect(installBuiltInPlugin).toHaveBeenCalledWith({
      marketplaceId: 'builtin/app',
      pluginName: 'browser',
      providers: ['claude'],
    });
  });

  it('installs a GitHub skill ref and returns the installed skill identity', async () => {
    const loadSkills = jest
      .fn()
      .mockResolvedValueOnce({ success: true, data: [] })
      .mockResolvedValueOnce({
        success: true,
        data: [
          {
            sourceId: 'github:acme/skills',
            name: 'review',
            shareableSource: { type: 'github', repo: 'acme/skills' },
          },
        ],
      });
    const installSkills = jest.fn().mockResolvedValue({ success: true });
    Object.assign(window, {
      skills: { loadSkills, installSkills },
      plugins: { loadMarketplaces: jest.fn() },
    });

    await expect(
      installSharedPluginRef({
        type: 'skill',
        source: { type: 'github', repo: 'acme/skills' },
        skill_name: 'review',
      }),
    ).resolves.toEqual({
      entity: 'skill',
      sourceId: 'github:acme/skills',
      skillName: 'review',
    });
    expect(installSkills).toHaveBeenCalledWith('acme/skills', ['review']);
  });
});
