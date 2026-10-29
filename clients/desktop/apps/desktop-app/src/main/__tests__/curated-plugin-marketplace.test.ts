// `fs` is intentionally NOT mocked: the scanner reads the materialized
// marketplace from disk, so the tests materialize a real temp tree instead of
// asserting against a hand-written read mock.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  BuiltInPluginInstallStatus,
  MarketplaceInfo,
  MarketplaceProviderStatus,
  PluginInfo,
  PluginProvider,
  PluginProviderFacet,
} from '@canopy/desktop-shared/types/plugins';

let curatedRoot = '';
let syncLockPath = '';
const mockRecoverCuratedPluginPromotions = jest.fn<Promise<void>, []>();

jest.mock('../lib/paths', () => ({
  getCuratedPluginsMarketplaceDir: (): string => curatedRoot,
  getCuratedPluginsSyncLockFilePath: (): string => syncLockPath,
}));
jest.mock('../plugins/curated-plugin-sync', () => ({
  getCuratedPluginMarketplaceName: (): string => 'canopy-curated',
  recoverCuratedPluginPromotions: mockRecoverCuratedPluginPromotions,
}));

import {
  invalidateCuratedMarketplaceScanCache,
  mergeCuratedMarketplace,
  scanCuratedMarketplace,
  type CuratedMarketplaceScanDeps,
} from '../plugins/curated-plugin-marketplace';

let tempDir = '';

beforeEach(() => {
  jest.clearAllMocks();
  mockRecoverCuratedPluginPromotions.mockResolvedValue();
  tempDir = mkdtempSync(join(tmpdir(), 'curated-marketplace-'));
  curatedRoot = join(tempDir, 'curated-plugins', 'marketplace');
  syncLockPath = join(tempDir, 'curated-plugins', 'sync-lock.json');
  invalidateCuratedMarketplaceScanCache();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function claudeManifestPath(): string {
  return join(curatedRoot, '.claude-plugin', 'marketplace.json');
}

function codexManifestPath(): string {
  return join(curatedRoot, '.agents', 'plugins', 'marketplace.json');
}

function writeSyncLock(value: unknown): void {
  writeJson(syncLockPath, value);
}

function writeClaudeManifest(
  pluginKeys: string[],
  recommendedKeys: readonly string[] = [],
): void {
  writeJson(claudeManifestPath(), {
    name: 'canopy-curated',
    version: '1.0.0',
    plugins: pluginKeys.map((key) => ({
      name: key,
      description: `${key} description`,
      version: '2.0.0',
      source: `./${key}`,
      ...(recommendedKeys.includes(key) ? { recommended: true } : {}),
    })),
  });
}

function writeCodexManifest(pluginKeys: string[]): void {
  writeJson(codexManifestPath(), {
    name: 'canopy-curated',
    interface: { displayName: 'Canopy Curated Marketplace' },
    plugins: pluginKeys.map((key) => ({
      name: key,
      source: { source: 'local', path: `./${key}` },
    })),
  });
}

/** Materializes the plugin directory the manifests point at. */
function writePluginDir(key: string): void {
  writeJson(join(curatedRoot, key, '.claude-plugin', 'plugin.json'), {
    name: key,
    version: '2.0.0',
  });
  writeJson(join(curatedRoot, key, '.codex-plugin', 'plugin.json'), {
    name: key,
    version: '2.0.0',
  });
}

// ---------------------------------------------------------------------------
// Injected scan primitives
// ---------------------------------------------------------------------------

function facet(
  provider: PluginProvider,
  name: string,
  installLocation: string,
): PluginProviderFacet {
  return {
    provider,
    mode: 'native',
    name,
    description: `${name} description`,
    version: '2.0.0',
    author: '',
    category: '',
    homepage: '',
    installLocation,
    sourcePath: installLocation,
  };
}

interface StubDeps extends CuratedMarketplaceScanDeps {
  calls: { claude: number; codex: number; installStatuses: number };
}

/**
 * Stands in for `plugin-service.ts`'s real scan primitives. `existsOnDisk`
 * models the readers' "no materialized plugin directory -> no facet" rule.
 */
function stubDeps(
  options: {
    installed?: boolean;
    existsOnDisk?: (pluginName: string) => boolean;
  } = {},
): StubDeps {
  const exists = options.existsOnDisk ?? ((): boolean => true);
  const calls = { claude: 0, codex: 0, installStatuses: 0 };
  return {
    calls,
    readClaudeFacets: ({
      marketplaceInstallDir,
      pluginEntries,
    }): PluginProviderFacet[] => {
      calls.claude += 1;
      return pluginEntries
        .filter((entry) => !!entry.name && exists(entry.name))
        .map((entry) =>
          facet('claude', entry.name, join(marketplaceInstallDir, entry.name)),
        );
    },
    readCodexFacets: ({
      marketplaceRoot,
      pluginEntries,
    }): PluginProviderFacet[] => {
      calls.codex += 1;
      return pluginEntries
        .filter(
          (entry): entry is { name: string } =>
            typeof entry.name === 'string' && exists(entry.name),
        )
        .map((entry) =>
          facet('codex', entry.name, join(marketplaceRoot, entry.name)),
        );
    },
    mergeProviderPluginFacets: ({
      marketplaceId,
      claudePlugins,
      codexPlugins,
    }): PluginInfo[] => {
      const byName = new Map<
        string,
        { claude?: PluginProviderFacet; codex?: PluginProviderFacet }
      >();
      for (const claudeFacet of claudePlugins) {
        byName.set(claudeFacet.name.toLowerCase(), {
          ...byName.get(claudeFacet.name.toLowerCase()),
          claude: claudeFacet,
        });
      }
      for (const codexFacet of codexPlugins) {
        byName.set(codexFacet.name.toLowerCase(), {
          ...byName.get(codexFacet.name.toLowerCase()),
          codex: codexFacet,
        });
      }
      return Array.from(byName.values()).map((facets) => {
        const canonical = facets.claude ?? facets.codex;
        const plugin: PluginInfo = {
          name: canonical?.name ?? '',
          description: canonical?.description ?? '',
          version: canonical?.version ?? '',
          sourcePath: canonical?.sourcePath ?? '',
          marketplaceId,
          providerSupport: {
            claude: facets.claude ? 'native' : 'none',
            codex: facets.codex ? 'native' : 'compat',
          },
          facets: { claude: facets.claude, codex: facets.codex },
        };
        return plugin;
      });
    },
    providerStatus: (
      provider: PluginProvider,
      input: Partial<MarketplaceProviderStatus>,
    ): MarketplaceProviderStatus => {
      const accepted = input.accepted === true;
      const pluginCount = input.pluginCount ?? 0;
      return {
        provider,
        state: accepted && pluginCount > 0 ? 'valid' : 'invalid',
        accepted,
        pluginCount,
        lastCheckedAt: '2026-08-01T00:00:00.000Z',
        error: input.error,
        marketplaceName: input.marketplaceName,
        marketplacePath: input.marketplacePath,
        installLocation: input.installLocation,
      };
    },
    readInstallStatuses: ({
      plugins,
      marketplaceName,
    }): Promise<PluginInfo[]> => {
      calls.installStatuses += 1;
      const status: BuiltInPluginInstallStatus = {
        checkedAt: '2026-08-01T00:00:00.000Z',
        claude: {
          available: true,
          installed: options.installed === true,
          // Proves the marketplace name reached the install-status readers.
          installPath: `/installed/${marketplaceName}`,
        },
        codex: { available: true, installed: options.installed === true },
      };
      return Promise.resolve(
        plugins.map((plugin) => ({ ...plugin, globalInstallStatus: status })),
      );
    },
  };
}

function externalMarketplace(id: string): MarketplaceInfo {
  return {
    id,
    name: id,
    sourceType: 'github',
    sourceUrl: `https://github.com/${id}`,
    installLocation: `/marketplaces/${id}`,
    pluginCount: 0,
    plugins: [],
    providerStatus: {
      claude: {
        provider: 'claude',
        state: 'valid',
        accepted: true,
        pluginCount: 0,
        lastCheckedAt: '2026-08-01T00:00:00.000Z',
      },
      codex: {
        provider: 'codex',
        state: 'invalid',
        accepted: false,
        pluginCount: 0,
        lastCheckedAt: '2026-08-01T00:00:00.000Z',
      },
    },
    validProviders: ['claude'],
  };
}

// ---------------------------------------------------------------------------
// scanCuratedMarketplace
// ---------------------------------------------------------------------------

describe('scanCuratedMarketplace', () => {
  it('recovers interrupted promotions before scanning marketplace state', async () => {
    const deps = stubDeps();

    await scanCuratedMarketplace(deps);

    expect(mockRecoverCuratedPluginPromotions).toHaveBeenCalledTimes(1);
  });

  it('returns null when the marketplace has never been materialized', async () => {
    const deps = stubDeps();

    await expect(scanCuratedMarketplace(deps)).resolves.toBeNull();
    expect(deps.calls.claude).toBe(0);
    expect(deps.calls.codex).toBe(0);
  });

  it('returns null when the manifests are present but list zero plugins', async () => {
    writeClaudeManifest([]);
    writeCodexManifest([]);
    const deps = stubDeps();

    await expect(scanCuratedMarketplace(deps)).resolves.toBeNull();
    expect(deps.calls.claude).toBe(0);
  });

  it('returns null when the manifests name plugins but nothing is materialized', async () => {
    writeClaudeManifest(['ghost']);
    writeCodexManifest(['ghost']);
    const deps = stubDeps({ existsOnDisk: () => false });

    await expect(scanCuratedMarketplace(deps)).resolves.toBeNull();
    expect(deps.calls.claude).toBe(1);
    expect(deps.calls.installStatuses).toBe(0);
  });

  it('builds a curated row from both provider manifests', async () => {
    writeClaudeManifest(['alpha', 'beta']);
    writeCodexManifest(['alpha', 'beta']);
    writePluginDir('alpha');
    writePluginDir('beta');

    const marketplace = await scanCuratedMarketplace(stubDeps());

    expect(marketplace).toMatchObject({
      id: 'curated/cloud',
      name: 'Canopy Curated Marketplace',
      sourceType: 'curated',
      sourceUrl: 'curated:cloud',
      installLocation: curatedRoot,
      builtIn: false,
      curated: true,
      removable: false,
      pluginCount: 2,
      validProviders: ['claude', 'codex'],
    });
    expect(marketplace?.providerStatus.claude).toMatchObject({
      provider: 'claude',
      state: 'valid',
      accepted: true,
      pluginCount: 2,
      marketplaceName: 'canopy-curated',
      marketplacePath: claudeManifestPath(),
      installLocation: curatedRoot,
    });
    expect(marketplace?.providerStatus.codex).toMatchObject({
      provider: 'codex',
      state: 'valid',
      accepted: true,
      pluginCount: 2,
      marketplaceName: 'canopy-curated',
      marketplacePath: codexManifestPath(),
      installLocation: curatedRoot,
    });
    expect(marketplace?.plugins.map((plugin) => plugin.name)).toEqual([
      'alpha',
      'beta',
    ]);
    for (const plugin of marketplace?.plugins ?? []) {
      expect(plugin.curated).toBe(true);
      expect(plugin.builtIn).toBeUndefined();
      expect(plugin.marketplaceId).toBe('curated/cloud');
      expect(plugin.facets.claude).toBeDefined();
      expect(plugin.facets.codex).toBeDefined();
      // Keyed as `<plugin>@canopy-curated`, not the built-in marketplace.
      expect(plugin.globalInstallStatus?.claude?.installPath).toBe(
        '/installed/canopy-curated',
      );
    }
  });

  it('preserves per-user recommendation metadata from the curated manifest', async () => {
    writeClaudeManifest(['alpha', 'beta'], ['beta']);
    writeCodexManifest(['alpha', 'beta']);
    writePluginDir('alpha');
    writePluginDir('beta');

    const marketplace = await scanCuratedMarketplace(stubDeps());

    expect(
      marketplace?.plugins.map((plugin) => ({
        name: plugin.name,
        recommended: plugin.recommended,
      })),
    ).toEqual([
      { name: 'alpha', recommended: false },
      { name: 'beta', recommended: true },
    ]);
  });

  it("uses the sync lock's syncedAt as lastUpdated when available", async () => {
    writeClaudeManifest(['alpha']);
    writeCodexManifest(['alpha']);
    writePluginDir('alpha');
    writeSyncLock({
      version: 1,
      syncedAt: '2026-01-02T03:04:05.000Z',
      plugins: {},
    });

    const marketplace = await scanCuratedMarketplace(stubDeps());

    expect(marketplace?.lastUpdated).toBe('2026-01-02T03:04:05.000Z');
  });

  it('falls back to scan time when the sync lock is absent', async () => {
    writeClaudeManifest(['alpha']);
    writeCodexManifest(['alpha']);
    writePluginDir('alpha');
    const before = Date.now();

    const marketplace = await scanCuratedMarketplace(stubDeps());

    const lastUpdated = marketplace?.lastUpdated
      ? Date.parse(marketplace.lastUpdated)
      : Number.NaN;
    expect(lastUpdated).toBeGreaterThanOrEqual(before);
  });

  it('falls back to scan time when the sync lock is corrupt', async () => {
    writeClaudeManifest(['alpha']);
    writeCodexManifest(['alpha']);
    writePluginDir('alpha');
    mkdirSync(dirname(syncLockPath), { recursive: true });
    writeFileSync(syncLockPath, 'not json', 'utf-8');
    const before = Date.now();

    const marketplace = await scanCuratedMarketplace(stubDeps());

    const lastUpdated = marketplace?.lastUpdated
      ? Date.parse(marketplace.lastUpdated)
      : Number.NaN;
    expect(lastUpdated).toBeGreaterThanOrEqual(before);
  });

  it('marks a provider invalid when its manifest is missing', async () => {
    writeClaudeManifest(['alpha']);
    writePluginDir('alpha');

    const marketplace = await scanCuratedMarketplace(stubDeps());

    expect(marketplace?.validProviders).toEqual(['claude']);
    expect(marketplace?.providerStatus.codex).toMatchObject({
      state: 'invalid',
      accepted: false,
      pluginCount: 0,
    });
    expect(marketplace?.plugins[0]?.facets.codex).toBeUndefined();
  });

  it('memoizes the scan until the cache is invalidated', async () => {
    writeClaudeManifest(['alpha']);
    writeCodexManifest(['alpha']);
    writePluginDir('alpha');
    const deps = stubDeps();

    const first = await scanCuratedMarketplace(deps);
    const second = await scanCuratedMarketplace(deps);
    expect(deps.calls.claude).toBe(1);
    expect(second).toEqual(first);
    // Cloned, so downstream mutation can never reach the memo.
    expect(second).not.toBe(first);

    invalidateCuratedMarketplaceScanCache();
    await scanCuratedMarketplace(deps);
    expect(deps.calls.claude).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// mergeCuratedMarketplace
// ---------------------------------------------------------------------------

describe('mergeCuratedMarketplace', () => {
  it('appends the curated row after the existing rows', async () => {
    writeClaudeManifest(['alpha']);
    writeCodexManifest(['alpha']);
    writePluginDir('alpha');

    const merged = await mergeCuratedMarketplace(
      [externalMarketplace('acme/plugins'), externalMarketplace('builtin/app')],
      stubDeps(),
    );

    expect(merged.map((marketplace) => marketplace.id)).toEqual([
      'acme/plugins',
      'builtin/app',
      'curated/cloud',
    ]);
  });

  it('replaces a stale curated row instead of duplicating it', async () => {
    writeClaudeManifest(['alpha']);
    writeCodexManifest(['alpha']);
    writePluginDir('alpha');
    const stale: MarketplaceInfo = {
      ...externalMarketplace('curated/cloud'),
      name: 'Stale Curated',
      pluginCount: 7,
    };

    const merged = await mergeCuratedMarketplace(
      [stale, externalMarketplace('acme/plugins')],
      stubDeps(),
    );

    expect(merged.map((marketplace) => marketplace.id)).toEqual([
      'acme/plugins',
      'curated/cloud',
    ]);
    expect(merged[1]).toMatchObject({
      name: 'Canopy Curated Marketplace',
      pluginCount: 1,
      curated: true,
    });
  });

  it('drops a cached curated row when nothing is materialized', async () => {
    const merged = await mergeCuratedMarketplace(
      [
        externalMarketplace('acme/plugins'),
        { ...externalMarketplace('curated/cloud'), curated: true },
      ],
      stubDeps(),
    );

    expect(merged.map((marketplace) => marketplace.id)).toEqual([
      'acme/plugins',
    ]);
  });
});

it('projects catalog prompts from marketplace metadata into PluginInfo', async () => {
  writeJson(claudeManifestPath(), {
    name: 'canopy-curated',
    plugins: [
      {
        name: 'review-buddy',
        source: './review-buddy',
        tryNowPrompt: 'Review this change.',
      },
    ],
  });
  const marketplace = await scanCuratedMarketplace(stubDeps());
  expect(marketplace?.plugins[0]).toHaveProperty(
    'tryNowPrompt',
    'Review this change.',
  );
});
