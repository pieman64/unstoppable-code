import type {
  MarketplaceInfo,
  PluginInfo,
} from '@canopy/desktop-shared/types/plugins';
import { createMarketplaceShareResolver as createResolver } from '../marketplace-share-resolution';

function createMarketplaceShareResolver(
  marketplaces: readonly MarketplaceInfo[],
): ReturnType<typeof createResolver> {
  return createResolver(
    marketplaces,
    (plugin) =>
      plugin.displayName ??
      plugin.name.replace(/^./, (letter) => letter.toUpperCase()),
  );
}

function plugin(
  marketplaceId = 'market',
  overrides: Partial<PluginInfo> = {},
): PluginInfo {
  return {
    name: 'helper',
    marketplaceId,
    sourcePath: '',
    facets: {},
    providerSupport: { claude: 'native', codex: 'none' },
    ...overrides,
  };
}

function marketplace(
  overrides: Partial<MarketplaceInfo> = {},
): MarketplaceInfo {
  return {
    id: 'market',
    name: 'Market',
    sourceType: 'github',
    sourceUrl: 'https://github.com/acme/plugins',
    installLocation: '/private/market',
    pluginCount: 1,
    plugins: [plugin()],
    validProviders: ['claude'],
    providerStatus: {
      claude: {
        provider: 'claude',
        state: 'valid',
        accepted: true,
        pluginCount: 1,
        lastCheckedAt: '',
      },
      codex: {
        provider: 'codex',
        state: 'invalid',
        accepted: false,
        pluginCount: 0,
        lastCheckedAt: '',
      },
    },
    ...overrides,
  };
}

function foldedMarketplace(
  keys: string[],
  overrides: Partial<MarketplaceInfo> = {},
): MarketplaceInfo {
  return marketplace({
    curated: true,
    plugins: [
      plugin('market', {
        details: {
          skills: [],
          agents: [],
          commands: [],
          hooks: [],
          lspServers: [],
          hasReadme: false,
          mcpServers: keys.map((name) => ({ name, type: 'http' })),
        },
      }),
    ],
    ...overrides,
  });
}

const unavailable = {
  status: 'blocked',
  reason: 'Sharing is unavailable for this item.',
};
const unsupported = {
  status: 'blocked',
  reason: 'This plugin has no public source to share.',
};
const standalone = {
  status: 'blocked',
  reason: 'MCP server connections cannot be shared.',
};

describe('cached Marketplace share resolution', () => {
  it.each([undefined, '/private/cache'])(
    'ignores installation state (%s)',
    (cachePath) => {
      const resolver = createMarketplaceShareResolver([
        marketplace({ plugins: [plugin('market', { cachePath })] }),
      ]);
      expect(resolver.plugin('market', 'helper')).toEqual({
        status: 'shareable',
        target: {
          kind: 'plugin',
          marketplaceId: 'market',
          pluginName: 'helper',
          displayName: 'Helper',
          sourceLabel: 'github:acme/plugins',
          refKey: 'claude_plugin:github:acme/plugins:helper',
        },
      });
    },
  );

  it('disambiguates the same plugin name by marketplace identity', () => {
    const resolver = createMarketplaceShareResolver([
      marketplace(),
      marketplace({
        id: 'local',
        sourceUrl: '/private/local',
        plugins: [plugin('local')],
      }),
    ]);
    expect(resolver.plugin('market', 'helper').status).toBe('shareable');
    expect(resolver.plugin('local', 'helper')).toEqual(unsupported);
  });

  it('prefers an exact name and rejects ambiguous case-insensitive fallbacks', () => {
    const resolver = createMarketplaceShareResolver([
      marketplace({
        plugins: [plugin(), plugin('market', { name: 'Helper' })],
      }),
    ]);
    expect(resolver.plugin('market', 'helper')).toMatchObject({
      status: 'shareable',
      target: { pluginName: 'helper' },
    });
    expect(resolver.plugin('market', 'HELPER')).toEqual(unavailable);
  });

  it('rejects duplicate marketplace IDs and duplicate exact plugin names', () => {
    expect(
      createMarketplaceShareResolver([marketplace(), marketplace()]).plugin(
        'market',
        'helper',
      ),
    ).toEqual(unavailable);
    expect(
      createMarketplaceShareResolver([
        marketplace({ plugins: [plugin(), plugin()] }),
      ]).plugin('market', 'helper'),
    ).toEqual(unavailable);
  });

  it('rejects mismatched identity and missing or removed targets', () => {
    expect(
      createMarketplaceShareResolver([
        marketplace({ plugins: [plugin('other')] }),
      ]).plugin('market', 'helper'),
    ).toEqual(unavailable);
    expect(
      createMarketplaceShareResolver([]).plugin('market', 'helper'),
    ).toEqual(unavailable);
    expect(
      createMarketplaceShareResolver([marketplace()]).plugin(
        'market',
        'removed',
      ),
    ).toEqual(unavailable);
  });

  it('uses the synced curated plugin name as its key', () => {
    const resolver = createMarketplaceShareResolver([
      marketplace({
        id: 'curated/cloud',
        curated: true,
        plugins: [
          plugin('curated/cloud', {
            name: 'stable-key',
            displayName: 'Different display name',
          }),
        ],
      }),
    ]);
    expect(resolver.plugin('curated/cloud', 'stable-key')).toMatchObject({
      status: 'shareable',
      target: {
        pluginName: 'stable-key',
        displayName: 'Different display name',
      },
    });
    expect(resolver.plugin('curated/cloud', 'Different display name')).toEqual(
      unavailable,
    );
  });

  it('projects only browser-safe target metadata', () => {
    const resolution = createMarketplaceShareResolver([marketplace()]).plugin(
      'market',
      'helper',
    );
    expect(JSON.stringify(resolution)).not.toContain('/private/');
    expect(JSON.stringify(resolution)).not.toContain('facets');
  });

  it('shares a folded MCP through the same parent-plugin target', () => {
    const resolver = createMarketplaceShareResolver([
      foldedMarketplace(['integration', 'integration']),
    ]);
    expect(resolver.mcp('integration')).toEqual(
      resolver.plugin('market', 'helper'),
    );
    expect(resolver.mcp('integration').status).toBe('shareable');
  });

  it('uses the plugin reason only when a folded parent resolves without a public source', () => {
    expect(
      createMarketplaceShareResolver([
        foldedMarketplace(['integration'], { sourceUrl: '/private/local' }),
      ]).mcp('integration'),
    ).toEqual(unsupported);
  });

  it('never chooses the first of multiple folded parents', () => {
    const first = foldedMarketplace(['integration']);
    const second = { ...first.plugins[0], name: 'another-parent' };
    expect(
      createMarketplaceShareResolver([
        { ...first, plugins: [...first.plugins, second] },
      ]).mcp('integration'),
    ).toEqual(unavailable);
  });

  it('does not fold multi-key plugins or non-curated marketplaces', () => {
    expect(
      createMarketplaceShareResolver([
        foldedMarketplace(['integration', 'other']),
      ]).mcp('integration'),
    ).toEqual(standalone);
    expect(
      createMarketplaceShareResolver([
        foldedMarketplace(['integration'], { curated: false }),
      ]).mcp('integration'),
    ).toEqual(standalone);
    expect(createMarketplaceShareResolver([]).mcp(undefined)).toEqual(
      standalone,
    );
  });
});
