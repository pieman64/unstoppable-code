import path from 'node:path';
import { writeJson } from './fsHelpers.mjs';

const ISO = '2026-06-17T00:00:00.000Z';

const EMPTY_DETAILS = {
  skills: [],
  agents: [],
  commands: [],
  hooks: [],
  mcpServers: [],
  lspServers: [],
  hasReadme: false,
};

function externalNeedsInstall(name) {
  return {
    name,
    description: `${name} (external)`,
    sourcePath: '',
    marketplaceId: 'demo/market',
    details: null,
    externalSource: {
      source: 'github',
      url: `https://example.com/${name}.git`,
    },
    providerSupport: { claude: 'native', codex: 'none' },
    facets: {},
  };
}

function externalInstalled(name, cachePath = `/tmp/${name}`) {
  return {
    name,
    description: `${name} (installed)`,
    sourcePath: '',
    marketplaceId: 'demo/market',
    details: EMPTY_DETAILS,
    externalSource: {
      source: 'github',
      url: `https://example.com/${name}.git`,
    },
    cachePath,
    cachedAt: ISO,
    providerSupport: { claude: 'native', codex: 'none' },
    facets: {},
  };
}

function inlinePlugin(name) {
  return {
    name,
    description: `${name} (inline)`,
    sourcePath: `plugins/${name}`,
    marketplaceId: 'demo/market',
    details: EMPTY_DETAILS,
    providerSupport: { claude: 'native', codex: 'none' },
    facets: {},
  };
}

/**
 * Seed a v2 plugins cache with one github marketplace containing two
 * external plugins needing install, one installed external plugin, and one
 * inline plugin. Writes `<userDataDir>/plugins-cache.json`.
 *
 * Main-process reader: `apps/desktop-app/src/main/plugins/plugin-service.ts`
 *   `getPluginsCacheFilePath()` → `path.join(getDataDir(), 'plugins-cache.json')`
 *
 * The E2E build skips `scheduleDeferredStartupBackgroundTasks` (isE2eBuild()
 * gate), so `refreshMarketplaces` never runs on startup and the seeded v2
 * cache is served directly by `loadMarketplaces` without modification.
 *
 * @param {object} options
 * @param {string} options.userDataDir absolute CANOPY_DATA_DIR
 * @param {Record<string, string>} [options.installedPluginCachePaths] optional
 * cache path overrides keyed by plugin name
 * @param {Array<{ name: string, displayName?: string, description?: string,
 *   providerSupport?: { claude: string, codex: string }, details?: object,
 *   facets?: object }>} [options.additionalPlugins]
 * extra inline plugins appended to the marketplace (e.g. a Codex-only plugin
 * to exercise provider-scoped pickers, or a plugin with `details` and
 * `facets` to exercise member previews); every key is spread onto the row
 * @param {Array<{ name: string, displayName?: string, description?: string }>} [options.builtInPlugins]
 * inline plugins for a second, built-in marketplace (`builtin/app`), the one
 * a project template's `{ type: 'builtin', id: 'app' }` refs resolve against
 * @returns {{ cacheFilePath: string }}
 */
export function seedPluginsCache(options) {
  const {
    userDataDir,
    installedPluginCachePaths = {},
    additionalPlugins = [],
    builtInPlugins = [],
  } = options ?? {};
  if (!userDataDir) {
    throw new Error('seedPluginsCache requires userDataDir');
  }
  const plugins = [
    externalNeedsInstall('alpha-tool'),
    externalNeedsInstall('beta-tool'),
    externalInstalled('gamma-tool', installedPluginCachePaths['gamma-tool']),
    inlinePlugin('delta-tool'),
    ...additionalPlugins.map((extra) => ({
      ...inlinePlugin(extra.name),
      ...extra,
    })),
  ];
  const cache = {
    version: 2,
    lastRefreshed: ISO,
    lastProviderRefreshAt: ISO,
    marketplaces: [
      {
        id: 'demo/market',
        name: 'Demo Market',
        description: 'Seeded marketplace',
        sourceType: 'github',
        // Deliberately NOT github.com. Marketplace plugins now derive their
        // logo from the owner avatar at `github.com/<owner>.png`
        // (`marketplaceOwnerAvatarUrl`), and `github.com/demo` is a real
        // account with a live avatar — pointing at it would make every plugins
        // capture fetch a third party's image over the network and change
        // whenever they change it. `.invalid` is reserved (RFC 2606) and is
        // rejected by the host check before any request is attempted, so these
        // fixtures keep rendering deterministic monogram tiles. The avatar
        // derivation itself is covered by unit tests in
        // `renderer/src/lib/__tests__/unifiedPluginEntries.test.ts`.
        sourceUrl: 'https://github.invalid/demo/market',
        installLocation: '/tmp/demo-market',
        lastUpdated: ISO,
        pluginCount: plugins.length,
        plugins,
        providerStatus: {
          claude: {
            provider: 'claude',
            state: 'valid',
            accepted: true,
            pluginCount: plugins.length,
            lastCheckedAt: ISO,
          },
          codex: {
            provider: 'codex',
            state: 'invalid',
            accepted: false,
            pluginCount: 0,
            lastCheckedAt: ISO,
          },
        },
        validProviders: ['claude'],
      },
      ...(builtInPlugins.length === 0
        ? []
        : [
            {
              id: 'builtin/app',
              name: 'Built-in',
              description: 'Plugins bundled with the app',
              sourceType: 'builtin',
              sourceUrl: 'builtin:app',
              builtIn: true,
              installLocation: '/tmp/builtin-app',
              lastUpdated: ISO,
              pluginCount: builtInPlugins.length,
              plugins: builtInPlugins.map((extra) => ({
                ...inlinePlugin(extra.name),
                ...extra,
                marketplaceId: 'builtin/app',
              })),
              providerStatus: {
                claude: {
                  provider: 'claude',
                  state: 'valid',
                  accepted: true,
                  pluginCount: builtInPlugins.length,
                  lastCheckedAt: ISO,
                },
                codex: {
                  provider: 'codex',
                  state: 'invalid',
                  accepted: false,
                  pluginCount: 0,
                  lastCheckedAt: ISO,
                },
              },
              validProviders: ['claude'],
            },
          ]),
    ],
  };
  const cacheFilePath = path.join(userDataDir, 'plugins-cache.json');
  writeJson(cacheFilePath, cache);
  return { cacheFilePath };
}
