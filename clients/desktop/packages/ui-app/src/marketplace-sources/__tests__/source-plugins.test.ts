import {
  countSourcePluginsNeedingInstall,
  EMPTY_MARKETPLACE_SOURCE_PLUGIN_FILTERS,
  filterMarketplaceSourcePlugins,
  groupMarketplaceSourcePlugins,
  MARKETPLACE_SOURCE_FILTER_NONE,
  marketplaceSourceAuthorOptions,
  marketplaceSourceCategoryOptions,
  safeMarketplaceSourceUrl,
  sourcePluginNeedsInstall,
} from '../source-plugins';
import {
  installedState,
  marketplaceSource,
  missingInstallState,
  sourcePlugin,
} from './fixtures';

describe('marketplace source plugin helpers', () => {
  it('needs install only for external plugins without content', () => {
    expect(sourcePluginNeedsInstall(sourcePlugin('a'))).toBe(false);
    expect(
      sourcePluginNeedsInstall(
        sourcePlugin('a', { installState: missingInstallState() }),
      ),
    ).toBe(true);
    expect(
      sourcePluginNeedsInstall(
        sourcePlugin('a', { installState: installedState() }),
      ),
    ).toBe(false);
    expect(
      sourcePluginNeedsInstall(
        sourcePlugin('a', {
          installState: {
            externalSource: false,
            hasContent: false,
            providers: {},
          },
        }),
      ),
    ).toBe(false);
  });

  it('counts missing plugins across the whole source', () => {
    const source = marketplaceSource('s', {
      plugins: [
        sourcePlugin('a', { installState: missingInstallState() }),
        sourcePlugin('b', { installState: installedState() }),
        sourcePlugin('c', { installState: missingInstallState() }),
      ],
    });
    expect(countSourcePluginsNeedingInstall(source)).toBe(2);
  });

  it('searches name and key and filters category/author including None', () => {
    const plugins = [
      sourcePlugin('lint-kit', {
        name: 'Linter',
        categories: ['dev'],
        author: 'Ada',
      }),
      sourcePlugin('docs', { name: 'Docs helper' }),
    ];
    const by = (
      overrides: Partial<typeof EMPTY_MARKETPLACE_SOURCE_PLUGIN_FILTERS>,
    ): string[] =>
      filterMarketplaceSourcePlugins(plugins, {
        ...EMPTY_MARKETPLACE_SOURCE_PLUGIN_FILTERS,
        ...overrides,
      }).map((plugin) => plugin.key);

    expect(by({ query: 'KIT' })).toEqual(['lint-kit']);
    expect(by({ query: 'helper' })).toEqual(['docs']);
    expect(by({ category: 'dev' })).toEqual(['lint-kit']);
    expect(by({ category: MARKETPLACE_SOURCE_FILTER_NONE })).toEqual(['docs']);
    expect(by({ author: MARKETPLACE_SOURCE_FILTER_NONE })).toEqual(['docs']);
    expect(by({ author: 'Ada', query: 'docs' })).toEqual([]);
    expect(marketplaceSourceCategoryOptions(plugins)).toEqual({
      values: ['dev'],
      hasNone: true,
    });
    expect(marketplaceSourceAuthorOptions(plugins)).toEqual({
      values: ['Ada'],
      hasNone: true,
    });
  });

  it('deduplicates recommendation groups by stable key', () => {
    const groups = groupMarketplaceSourcePlugins([
      sourcePlugin('a'),
      sourcePlugin('b', { recommended: true }),
      sourcePlugin('b', { recommended: true }),
      sourcePlugin('a'),
      sourcePlugin('same-name-1', { name: 'Same' }),
      sourcePlugin('same-name-2', { name: 'Same' }),
    ]);
    expect(groups.recommended.map((plugin) => plugin.key)).toEqual(['b']);
    expect(groups.others.map((plugin) => plugin.key)).toEqual([
      'a',
      'same-name-1',
      'same-name-2',
    ]);
  });

  it('renders only http(s) source links', () => {
    expect(safeMarketplaceSourceUrl('https://github.com/acme/x')).toBe(
      'https://github.com/acme/x',
    );
    expect(safeMarketplaceSourceUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeMarketplaceSourceUrl('file:///Users/me/repo')).toBeUndefined();
    expect(safeMarketplaceSourceUrl('/Users/me/repo')).toBeUndefined();
    expect(safeMarketplaceSourceUrl(undefined)).toBeUndefined();
  });
});
