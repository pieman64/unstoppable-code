import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import type {
  MarketplaceInfo,
  MarketplaceProviderStatus,
  PluginInfo,
  PluginProvider,
  PluginsCache,
} from '@canopy/desktop-shared/types/plugins';
import { CURATED_PLUGIN_MARKETPLACE_ID } from '@canopy/desktop-shared/types/plugins';
import { emptyPluginSelections } from '@canopy/desktop-shared/lib/plugin-selections-normalization';
import {
  curatedPluginKey,
  initialCuratedPluginSelection,
  mergeCuratedPluginSelections,
  selectBlueprintOnboardingPlugins,
  selectBundledOnboardingPlugins,
  selectCuratedOnboardingPlugins,
} from '../curatedOnboardingPlugins';

function plugin(overrides: Partial<PluginInfo> & { name: string }): PluginInfo {
  return {
    sourcePath: `/curated/${overrides.name}`,
    marketplaceId: CURATED_PLUGIN_MARKETPLACE_ID,
    providerSupport: { claude: 'native', codex: 'native' },
    facets: {},
    ...overrides,
  };
}

function providerStatus(provider: PluginProvider): MarketplaceProviderStatus {
  return {
    provider,
    state: 'valid',
    accepted: true,
    pluginCount: 0,
    lastCheckedAt: '2026-08-18T00:00:00.000Z',
  };
}

function marketplace(
  overrides: Partial<MarketplaceInfo> & { id: string; plugins: PluginInfo[] },
): MarketplaceInfo {
  return {
    name: overrides.id,
    sourceType: 'curated',
    sourceUrl: 'curated:cloud',
    installLocation: '/curated',
    pluginCount: overrides.plugins.length,
    providerStatus: {
      claude: providerStatus('claude'),
      codex: providerStatus('codex'),
    },
    validProviders: ['claude'],
    ...overrides,
  };
}

function cache(marketplaces: MarketplaceInfo[]): PluginsCache {
  return {
    version: 2,
    lastRefreshed: '2026-08-18T00:00:00.000Z',
    marketplaces,
  };
}

describe('selectCuratedOnboardingPlugins', () => {
  test('returns an empty list for a null cache', () => {
    expect(selectCuratedOnboardingPlugins(null)).toEqual([]);
  });

  test('ignores every marketplace except the curated one', () => {
    const rows = selectCuratedOnboardingPlugins(
      cache([
        marketplace({
          id: 'builtin/app',
          builtIn: true,
          plugins: [
            plugin({ name: 'built-in-one', marketplaceId: 'builtin/app' }),
          ],
        }),
        marketplace({
          id: 'owner/repo',
          plugins: [
            plugin({ name: 'external-one', marketplaceId: 'owner/repo' }),
          ],
        }),
      ]),
    );

    expect(rows).toEqual([]);
  });

  test('sorts recommended plugins first, then alphabetically by display name', () => {
    const rows = selectCuratedOnboardingPlugins(
      cache([
        marketplace({
          id: CURATED_PLUGIN_MARKETPLACE_ID,
          curated: true,
          plugins: [
            plugin({ name: 'zeta', curated: true }),
            plugin({ name: 'alpha', curated: true }),
            plugin({ name: 'yankee', curated: true, recommended: true }),
            plugin({ name: 'bravo', curated: true, recommended: true }),
          ],
        }),
      ]),
    );

    expect(rows.map((row) => row.name)).toEqual([
      'bravo',
      'yankee',
      'alpha',
      'zeta',
    ]);
    expect(rows.map((row) => row.recommended)).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  test('prefers displayName for labels and humanizes the fallback name', () => {
    const rows = selectCuratedOnboardingPlugins(
      cache([
        marketplace({
          id: CURATED_PLUGIN_MARKETPLACE_ID,
          curated: true,
          plugins: [
            plugin({
              name: 'linear-tools',
              displayName: 'Linear',
              description: 'Issue tracking',
              curated: true,
            }),
            plugin({ name: 'slack-tools', curated: true }),
          ],
        }),
      ]),
    );

    expect(rows).toEqual([
      {
        key: `${CURATED_PLUGIN_MARKETPLACE_ID}/linear-tools`.toLowerCase(),
        marketplaceId: CURATED_PLUGIN_MARKETPLACE_ID,
        name: 'linear-tools',
        displayName: 'Linear',
        description: 'Issue tracking',
        recommended: false,
      },
      {
        key: `${CURATED_PLUGIN_MARKETPLACE_ID}/slack-tools`.toLowerCase(),
        marketplaceId: CURATED_PLUGIN_MARKETPLACE_ID,
        name: 'slack-tools',
        displayName: 'Slack Tools',
        description: '',
        recommended: false,
      },
    ]);
  });
});

describe('selectBundledOnboardingPlugins', () => {
  test('includes Codex bundled recommendations without admitting external marketplaces', () => {
    const rows = selectBundledOnboardingPlugins(
      cache([
        marketplace({
          id: 'openai-curated',
          sourceType: 'codex',
          plugins: [
            plugin({
              name: 'gmail',
              displayName: 'Gmail',
              marketplaceId: 'openai-curated',
            }),
            plugin({
              name: 'vercel',
              displayName: 'Vercel',
              marketplaceId: 'openai-curated',
            }),
          ],
        }),
        marketplace({
          id: 'third-party/plugins',
          plugins: [
            plugin({
              name: 'external-tool',
              marketplaceId: 'third-party/plugins',
            }),
          ],
        }),
      ]),
    );

    expect(rows.map((row) => row.name)).toEqual(['gmail', 'vercel']);
    expect(rows.map((row) => row.key)).toEqual([
      'openai-curated/gmail',
      'openai-curated/vercel',
    ]);
  });
});

describe('initialCuratedPluginSelection', () => {
  const rows = selectCuratedOnboardingPlugins(
    cache([
      marketplace({
        id: CURATED_PLUGIN_MARKETPLACE_ID,
        curated: true,
        plugins: [
          plugin({ name: 'recommended-one', curated: true, recommended: true }),
          plugin({ name: 'already-on', curated: true }),
          plugin({ name: 'untouched', curated: true }),
        ],
      }),
    ]),
  );

  test('pre-selects recommended plugins', () => {
    expect(
      initialCuratedPluginSelection(rows, emptyPluginSelections()),
    ).toEqual([
      curatedPluginKey(CURATED_PLUGIN_MARKETPLACE_ID, 'recommended-one'),
    ]);
  });

  test('also pre-selects plugins already enabled globally, case-insensitively', () => {
    const selections: ChatTabPluginSelections = {
      ...emptyPluginSelections(),
      pluginRefs: [
        {
          marketplaceId: CURATED_PLUGIN_MARKETPLACE_ID,
          pluginName: 'Already-On',
        },
      ],
    };

    expect(initialCuratedPluginSelection(rows, selections)).toEqual([
      curatedPluginKey(CURATED_PLUGIN_MARKETPLACE_ID, 'recommended-one'),
      curatedPluginKey(CURATED_PLUGIN_MARKETPLACE_ID, 'already-on'),
    ]);
  });
});

describe('mergeCuratedPluginSelections', () => {
  const rows = selectCuratedOnboardingPlugins(
    cache([
      marketplace({
        id: CURATED_PLUGIN_MARKETPLACE_ID,
        curated: true,
        plugins: [
          plugin({ name: 'keep-me', curated: true, recommended: true }),
          plugin({ name: 'drop-me', curated: true }),
        ],
      }),
    ]),
  );

  test('adds the checked curated plugins to the global selections', () => {
    const merged = mergeCuratedPluginSelections(emptyPluginSelections(), rows, [
      curatedPluginKey(CURATED_PLUGIN_MARKETPLACE_ID, 'keep-me'),
    ]);

    expect(merged.pluginRefs).toEqual([
      { marketplaceId: CURATED_PLUGIN_MARKETPLACE_ID, pluginName: 'keep-me' },
    ]);
  });

  test('preserves non-curated selections of every kind', () => {
    const existing: ChatTabPluginSelections = {
      ...emptyPluginSelections(),
      collectionIds: ['collection-1'],
      skillRefs: [{ sourceId: 'builtin:app', skillName: 'writing' }],
      pluginRefs: [{ marketplaceId: 'owner/repo', pluginName: 'external' }],
      mcpServerRefs: [{ serverId: 'server-1', configId: 'config-1' }],
    };

    const merged = mergeCuratedPluginSelections(existing, rows, [
      curatedPluginKey(CURATED_PLUGIN_MARKETPLACE_ID, 'keep-me'),
    ]);

    expect(merged.collectionIds).toEqual(['collection-1']);
    expect(merged.skillRefs).toEqual([
      { sourceId: 'builtin:app', skillName: 'writing' },
    ]);
    expect(merged.mcpServerRefs).toEqual([
      { serverId: 'server-1', configId: 'config-1' },
    ]);
    expect(merged.pluginRefs).toEqual([
      { marketplaceId: 'owner/repo', pluginName: 'external' },
      { marketplaceId: CURATED_PLUGIN_MARKETPLACE_ID, pluginName: 'keep-me' },
    ]);
  });

  test('drops curated plugins the user unchecked', () => {
    const existing: ChatTabPluginSelections = {
      ...emptyPluginSelections(),
      pluginRefs: [
        { marketplaceId: CURATED_PLUGIN_MARKETPLACE_ID, pluginName: 'drop-me' },
        { marketplaceId: CURATED_PLUGIN_MARKETPLACE_ID, pluginName: 'keep-me' },
      ],
    };

    const merged = mergeCuratedPluginSelections(existing, rows, [
      curatedPluginKey(CURATED_PLUGIN_MARKETPLACE_ID, 'keep-me'),
    ]);

    expect(merged.pluginRefs).toEqual([
      { marketplaceId: CURATED_PLUGIN_MARKETPLACE_ID, pluginName: 'keep-me' },
    ]);
  });

  test('preserves curated refs the step never displayed', () => {
    // The catalog comes from the plugins cache, so a partial/stale read yields
    // a short list. Authority is scoped to displayed rows — otherwise Continue
    // would globally disable curated plugins the user was never shown.
    const existing: ChatTabPluginSelections = {
      ...emptyPluginSelections(),
      pluginRefs: [
        {
          marketplaceId: CURATED_PLUGIN_MARKETPLACE_ID,
          pluginName: 'not-in-this-catalog',
        },
        { marketplaceId: CURATED_PLUGIN_MARKETPLACE_ID, pluginName: 'drop-me' },
      ],
    };

    const merged = mergeCuratedPluginSelections(existing, rows, [
      curatedPluginKey(CURATED_PLUGIN_MARKETPLACE_ID, 'keep-me'),
    ]);

    expect(merged.pluginRefs).toEqual([
      {
        marketplaceId: CURATED_PLUGIN_MARKETPLACE_ID,
        pluginName: 'not-in-this-catalog',
      },
      { marketplaceId: CURATED_PLUGIN_MARKETPLACE_ID, pluginName: 'keep-me' },
    ]);
  });

  test('is idempotent when applied twice with the same answer', () => {
    const once = mergeCuratedPluginSelections(emptyPluginSelections(), rows, [
      curatedPluginKey(CURATED_PLUGIN_MARKETPLACE_ID, 'keep-me'),
    ]);
    const twice = mergeCuratedPluginSelections(once, rows, [
      curatedPluginKey(CURATED_PLUGIN_MARKETPLACE_ID, 'keep-me'),
    ]);

    expect(twice).toEqual(once);
  });
});

describe('selectBlueprintOnboardingPlugins (CAN-3032)', () => {
  const everyMarketplace = cache([
    marketplace({
      id: 'owner/repo',
      sourceUrl: 'https://github.com/owner/repo',
      plugins: [
        plugin({ name: 'builtin-git', marketplaceId: 'owner/repo' }),
        plugin({ name: 'Slack', marketplaceId: 'owner/repo' }),
      ],
    }),
    // Two built-in marketplaces: the first lacks the plugin, the second has
    // it, and the seed scans both.
    marketplace({
      id: 'builtin/extras',
      builtIn: true,
      sourceUrl: 'builtin:extras',
      plugins: [plugin({ name: 'other', marketplaceId: 'builtin/extras' })],
    }),
    marketplace({
      id: 'builtin/app',
      builtIn: true,
      sourceUrl: 'builtin:app',
      plugins: [plugin({ name: 'builtin-git', marketplaceId: 'builtin/app' })],
    }),
    marketplace({
      id: 'openai-curated',
      sourceUrl: 'codex:openai-curated',
      plugins: [plugin({ name: 'notion', marketplaceId: 'openai-curated' })],
    }),
  ]);

  test('resolves each template ref against the marketplace its source names, in template order', () => {
    const rows = selectBlueprintOnboardingPlugins(everyMarketplace, [
      {
        type: 'plugin',
        marketplace: { type: 'github', repo: 'Owner/Repo' },
        plugin_name: 'slack',
      },
      {
        type: 'claude_plugin',
        marketplace: { type: 'builtin', id: 'app' },
        plugin_name: 'builtin-git',
      },
      {
        type: 'codex_plugin',
        marketplace: { type: 'codex-builtin', id: 'openai-curated' },
        plugin_name: 'notion',
      },
      {
        type: 'skill',
        source: { type: 'builtin', id: 'app' },
        skill_name: 'campaign-brief-helper',
      },
    ]);
    expect(rows.map((row) => row.key)).toEqual([
      'owner/repo/slack',
      // The built-in ref lands on the built-in install, not the same-named
      // community plugin.
      'builtin/app/builtin-git',
      'openai-curated/notion',
    ]);
  });

  test('drops a ref whose marketplace is not cached, even when another marketplace has the name', () => {
    expect(
      selectBlueprintOnboardingPlugins(everyMarketplace, [
        {
          type: 'claude_plugin',
          marketplace: { type: 'github', repo: 'someone/else' },
          plugin_name: 'builtin-git',
        },
      ]),
    ).toEqual([]);
  });

  test('matches a GitHub source by its source URL, not by a marketplace id that merely looks like one', () => {
    const byId = cache([
      marketplace({
        id: 'owner/repo',
        sourceUrl: 'https://example.invalid/mirror',
        plugins: [plugin({ name: 'slack', marketplaceId: 'owner/repo' })],
      }),
    ]);
    const ref = {
      type: 'claude_plugin' as const,
      marketplace: { type: 'github' as const, repo: 'owner/repo' },
      plugin_name: 'slack',
    };
    expect(selectBlueprintOnboardingPlugins(byId, [ref])).toEqual([]);
    const byShorthandUrl = cache([
      marketplace({
        id: 'mirror',
        sourceUrl: 'owner/repo',
        plugins: [plugin({ name: 'slack', marketplaceId: 'mirror' })],
      }),
    ]);
    expect(
      selectBlueprintOnboardingPlugins(byShorthandUrl, [ref]).map(
        (row) => row.key,
      ),
    ).toEqual(['mirror/slack']);
  });

  test('skips an uncached external copy the seed would also skip, in favor of a later marketplace for the same repo', () => {
    const sameRepoTwice = cache([
      marketplace({
        id: 'first',
        sourceUrl: 'https://github.com/owner/repo',
        plugins: [
          plugin({
            name: 'slack',
            marketplaceId: 'first',
            externalSource: {
              source: 'github',
              url: 'https://github.com/owner/slack.git',
            },
          }),
        ],
      }),
      marketplace({
        id: 'second',
        sourceUrl: 'github.com/owner/repo',
        plugins: [
          plugin({
            name: 'slack',
            marketplaceId: 'second',
            externalSource: {
              source: 'github',
              url: 'https://github.com/owner/slack.git',
            },
            cachePath: '/tmp/slack',
          }),
        ],
      }),
    ]);
    expect(
      selectBlueprintOnboardingPlugins(sameRepoTwice, [
        {
          type: 'claude_plugin',
          marketplace: { type: 'github', repo: 'owner/repo' },
          plugin_name: 'slack',
        },
      ]).map((row) => row.key),
    ).toEqual(['second/slack']);
  });

  test('is empty without refs or without a cache', () => {
    expect(selectBlueprintOnboardingPlugins(everyMarketplace, [])).toEqual([]);
    expect(
      selectBlueprintOnboardingPlugins(null, [
        {
          type: 'claude_plugin',
          marketplace: { type: 'builtin', id: 'app' },
          plugin_name: 'builtin-git',
        },
      ]),
    ).toEqual([]);
  });
});
