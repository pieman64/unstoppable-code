import {
  inheritedClaudePluginRefs,
  type InheritedPluginMarketplace,
} from '../plugins/inherited-cursor-plugins';

function market(
  id: string,
  pluginNames: readonly string[],
  name?: string,
): InheritedPluginMarketplace {
  return {
    id,
    ...(name === undefined ? {} : { name }),
    plugins: pluginNames.map((pluginName) => ({ name: pluginName })),
  };
}

/** Claude Code's report: `plugin@marketplace` to its verified install folder. */
function installs(
  ...pairs: ReadonlyArray<readonly [string, string]>
): Map<string, string> {
  return new Map(pairs);
}

describe('inheritedClaudePluginRefs', () => {
  it('returns the plugins Claude Code has installed and enabled, each with its verified install path, in marketplace order', () => {
    const refs = inheritedClaudePluginRefs(
      [
        market('mkt-a', ['alpha', 'beta', 'gamma', 'delta']),
        market('mkt-b', ['alpha']),
      ],
      { pluginRefs: [] },
      undefined,
      installs(
        ['alpha@mkt-a', '/claude/plugins/cache/mkt-a/alpha/1.0.0'],
        ['gamma@mkt-a', '/claude/plugins/cache/mkt-a/gamma/2.0.0'],
        ['alpha@mkt-b', '/claude/plugins/cache/mkt-b/alpha/1.0.0'],
      ),
    );
    expect(refs).toEqual([
      {
        marketplaceId: 'mkt-a',
        pluginName: 'alpha',
        installPath: '/claude/plugins/cache/mkt-a/alpha/1.0.0',
      },
      {
        marketplaceId: 'mkt-a',
        pluginName: 'gamma',
        installPath: '/claude/plugins/cache/mkt-a/gamma/2.0.0',
      },
      {
        marketplaceId: 'mkt-b',
        pluginName: 'alpha',
        installPath: '/claude/plugins/cache/mkt-b/alpha/1.0.0',
      },
    ]);
  });

  it('leaves out plugins the chat already selects or has turned off', () => {
    const refs = inheritedClaudePluginRefs(
      [market('mkt', ['alpha', 'beta', 'gamma'])],
      { pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'alpha' }] },
      { pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'beta' }] },
      installs(
        ['alpha@mkt', '/i/alpha'],
        ['beta@mkt', '/i/beta'],
        ['gamma@mkt', '/i/gamma'],
      ),
    );
    expect(refs).toEqual([
      { marketplaceId: 'mkt', pluginName: 'gamma', installPath: '/i/gamma' },
    ]);
  });

  it('inherits an Available plugin and leaves it out once Disabled', () => {
    // Available (enabled, not selected) is inherited on purpose: Claude Code
    // loads it in Claude chats too. Only Disabled keeps it out everywhere.
    const marketplaces = [market('mkt-a', ['alpha'])];
    const enabled = installs([
      'alpha@mkt-a',
      '/claude/plugins/cache/mkt-a/alpha/1.0.0',
    ]);
    expect(
      inheritedClaudePluginRefs(
        marketplaces,
        { pluginRefs: [] },
        undefined,
        enabled,
      ).map((ref) => ref.pluginName),
    ).toEqual(['alpha']);
    expect(
      inheritedClaudePluginRefs(
        marketplaces,
        { pluginRefs: [] },
        undefined,
        enabled,
        [{ marketplaceId: 'mkt-a', pluginName: 'alpha' }],
      ),
    ).toEqual([]);
  });

  it('reports a plugin listed twice only once', () => {
    const refs = inheritedClaudePluginRefs(
      [market('mkt', ['alpha', 'alpha'])],
      { pluginRefs: [] },
      undefined,
      installs(['alpha@mkt', '/i/alpha']),
    );
    expect(refs).toEqual([
      { marketplaceId: 'mkt', pluginName: 'alpha', installPath: '/i/alpha' },
    ]);
  });

  it('matches a Claude-registered marketplace by its registered name as well as its id', () => {
    // A third-party Claude marketplace is keyed in Claude Code by the name
    // it was registered under; Canopy may carry that as `name`.
    const refs = inheritedClaudePluginRefs(
      [market('acme-id', ['alpha', 'beta'], 'acme-marketplace')],
      { pluginRefs: [] },
      undefined,
      installs(['alpha@acme-marketplace', '/i/alpha']),
    );
    expect(refs).toEqual([
      {
        marketplaceId: 'acme-id',
        pluginName: 'alpha',
        installPath: '/i/alpha',
      },
    ]);
  });

  it('matches a marketplace Canopy manages by the name Claude Code registered it under', () => {
    // Canopy's own curated and bundled marketplaces are cached under Canopy
    // ids with display names; Claude Code keys their installs by the name
    // Canopy registered them under, which the cache records in the
    // marketplace's Claude provider status.
    const refs = inheritedClaudePluginRefs(
      [
        {
          id: 'curated/cloud',
          name: 'Canopy Curated Marketplace',
          providerStatus: { claude: { marketplaceName: 'canopy-curated' } },
          plugins: [{ name: 'unslop' }, { name: 'web-research' }],
        },
      ],
      { pluginRefs: [] },
      undefined,
      installs(['unslop@canopy-curated', '/i/unslop']),
    );
    expect(refs).toEqual([
      {
        marketplaceId: 'curated/cloud',
        pluginName: 'unslop',
        installPath: '/i/unslop',
      },
    ]);
  });

  it('matches the bundled marketplace the same way, by its registered name', () => {
    const refs = inheritedClaudePluginRefs(
      [
        {
          id: 'builtin/app',
          name: 'Canopy Marketplace',
          providerStatus: { claude: { marketplaceName: 'canopy-plugins' } },
          plugins: [{ name: 'ud-git' }],
        },
      ],
      { pluginRefs: [] },
      undefined,
      installs(['ud-git@canopy-plugins', '/i/ud-git']),
    );
    expect(refs).toEqual([
      {
        marketplaceId: 'builtin/app',
        pluginName: 'ud-git',
        installPath: '/i/ud-git',
      },
    ]);
  });

  it('inherits one Claude Code install only once when two cached marketplaces share a spelling', () => {
    // A third-party marketplace whose display name equals another entry's id
    // (or registered name) resolves the same `plugin@marketplace` install.
    // Loading it under both ids would start its MCP servers twice; the first
    // marketplace in cache order keeps it.
    const refs = inheritedClaudePluginRefs(
      [market('mkt-a', ['alpha']), market('mkt-b', ['alpha'], 'mkt-a')],
      { pluginRefs: [] },
      undefined,
      installs(['alpha@mkt-a', '/i/alpha']),
    );
    expect(refs).toEqual([
      { marketplaceId: 'mkt-a', pluginName: 'alpha', installPath: '/i/alpha' },
    ]);
  });

  it('treats a selected or turned-off plugin as covering its Claude Code install for every spelling', () => {
    const marketplaces = [
      market('mkt-a', ['alpha']),
      market('mkt-b', ['alpha'], 'mkt-a'),
    ];
    // Selected under the first id: the second entry must not re-inherit it.
    expect(
      inheritedClaudePluginRefs(
        marketplaces,
        { pluginRefs: [{ marketplaceId: 'mkt-a', pluginName: 'alpha' }] },
        undefined,
        installs(['alpha@mkt-a', '/i/alpha']),
      ),
    ).toEqual([]);
    // Turned off for the chat under the first id: likewise.
    expect(
      inheritedClaudePluginRefs(
        marketplaces,
        { pluginRefs: [] },
        { pluginRefs: [{ marketplaceId: 'mkt-a', pluginName: 'alpha' }] },
        installs(['alpha@mkt-a', '/i/alpha']),
      ),
    ).toEqual([]);
  });

  it('treats a plugin selected or turned off under a later marketplace as covering an earlier match', () => {
    // The selection names the second entry, but the first entry resolves the
    // same install first in cache order: it must not be inherited, or the
    // resolver would load the selected copy and the inherited copy together.
    const marketplaces = [
      market('mkt-a', ['alpha']),
      market('mkt-b', ['alpha'], 'mkt-a'),
    ];
    expect(
      inheritedClaudePluginRefs(
        marketplaces,
        { pluginRefs: [{ marketplaceId: 'mkt-b', pluginName: 'alpha' }] },
        undefined,
        installs(['alpha@mkt-a', '/i/alpha']),
      ),
    ).toEqual([]);
    expect(
      inheritedClaudePluginRefs(
        marketplaces,
        { pluginRefs: [] },
        { pluginRefs: [{ marketplaceId: 'mkt-b', pluginName: 'alpha' }] },
        installs(['alpha@mkt-a', '/i/alpha']),
      ),
    ).toEqual([]);
  });

  it('prefers the name Claude Code registered a marketplace under over its display name', () => {
    // A display name that happens to spell another marketplace's registered
    // name must not steal that marketplace's install.
    const refs = inheritedClaudePluginRefs(
      [
        {
          id: 'curated/cloud',
          name: 'acme',
          providerStatus: { claude: { marketplaceName: 'canopy-curated' } },
          plugins: [{ name: 'alpha' }],
        },
        market('acme-id', ['alpha'], 'acme'),
      ],
      { pluginRefs: [] },
      undefined,
      installs(
        ['alpha@canopy-curated', '/i/curated-alpha'],
        ['alpha@acme', '/i/acme-alpha'],
      ),
    );
    expect(refs).toEqual([
      {
        marketplaceId: 'curated/cloud',
        pluginName: 'alpha',
        installPath: '/i/curated-alpha',
      },
      {
        marketplaceId: 'acme-id',
        pluginName: 'alpha',
        installPath: '/i/acme-alpha',
      },
    ]);
  });

  it('falls through a blank registered name to the id and display name', () => {
    // A marketplace scanned before Claude Code reported its registered name
    // still matches by Canopy's id, as it did before the registered name was
    // consulted at all.
    const refs = inheritedClaudePluginRefs(
      [
        {
          id: 'mkt',
          name: '',
          providerStatus: { claude: { marketplaceName: '' } },
          plugins: [{ name: 'alpha' }],
        },
      ],
      { pluginRefs: [] },
      undefined,
      installs(['alpha@mkt', '/i/alpha']),
    );
    expect(refs).toEqual([
      { marketplaceId: 'mkt', pluginName: 'alpha', installPath: '/i/alpha' },
    ]);
  });

  it('never matches on an empty marketplace spelling', () => {
    const refs = inheritedClaudePluginRefs(
      [
        {
          id: 'mkt',
          name: '',
          providerStatus: { claude: { marketplaceName: '' } },
          plugins: [{ name: 'alpha' }],
        },
      ],
      { pluginRefs: [] },
      undefined,
      installs(['alpha@', '/i/alpha']),
    );
    expect(refs).toEqual([]);
  });

  it('inherits nothing when the Claude Code read is unavailable, whatever the marketplace cache recorded', () => {
    // No install file, or one that does not parse: Claude Code itself would
    // load no plugin, and there is no verified folder to load one from. The
    // marketplace cache is never a substitute.
    const refs = inheritedClaudePluginRefs(
      [market('mkt', ['alpha', 'beta'])],
      { pluginRefs: [] },
      undefined,
      null,
    );
    expect(refs).toEqual([]);
  });
});
