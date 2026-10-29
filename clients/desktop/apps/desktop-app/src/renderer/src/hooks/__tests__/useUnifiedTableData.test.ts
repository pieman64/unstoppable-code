import {
  buildMcpRows,
  collapseDuplicatePluginRows,
  computePluginShareableRef,
  computePluginSourceIcon,
  formatMarketplaceSourceLabel,
  buildProviderConnectorRowsForPicker,
  buildProviderConnectorSourceOptions,
} from '../useUnifiedTableData';
import type {
  MarketplaceInfo,
  PluginInfo,
} from '@canopy/desktop-shared/types/plugins';
import type { McpServerIndexEntry } from '@canopy/desktop-shared/types/mcp-servers';
import { mergeAccountMcpInventory } from '@canopy/ui-app/capability';
import type { UnifiedTableRow } from '../useUnifiedTableData';

function makePlugin(overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    name: 'My Plugin',
    sourcePath: 'plugins/my-plugin',
    marketplaceId: 'mkt-1',
    providerSupport: { claude: 'native', codex: 'none' },
    facets: {},
    ...overrides,
  };
}

function makeMarketplace(
  overrides: Partial<MarketplaceInfo> = {},
): MarketplaceInfo {
  return {
    id: 'mkt-1',
    name: 'Acme Plugins',
    sourceType: 'github',
    sourceUrl: 'acme/plugins',
    installLocation: '/tmp/mkt',
    pluginCount: 1,
    plugins: [],
    providerStatus: {
      claude: {
        provider: 'claude',
        state: 'valid',
        accepted: true,
        pluginCount: 1,
        lastCheckedAt: '2026-05-01T00:00:00.000Z',
      },
      codex: {
        provider: 'codex',
        state: 'valid',
        accepted: true,
        pluginCount: 1,
        lastCheckedAt: '2026-05-01T00:00:00.000Z',
      },
    },
    validProviders: ['claude', 'codex'],
    ...overrides,
  };
}

describe('formatMarketplaceSourceLabel', () => {
  it('formats a full GitHub URL as github:owner:repo', () => {
    expect(
      formatMarketplaceSourceLabel(
        'github',
        'https://github.com/anthropics/claude-plugins-official',
      ),
    ).toBe('github:anthropics:claude-plugins-official');
  });

  it('formats owner/repo shorthand as github:owner:repo', () => {
    expect(formatMarketplaceSourceLabel('github', 'acme/plugins')).toBe(
      'github:acme:plugins',
    );
  });

  it('returns the raw URL when sourceType is not github', () => {
    expect(formatMarketplaceSourceLabel('local', '/some/local/path')).toBe(
      '/some/local/path',
    );
  });

  it('falls back to the raw URL when the GitHub URL is unparseable', () => {
    expect(formatMarketplaceSourceLabel('github', 'not-a-repo')).toBe(
      'not-a-repo',
    );
  });

  it('labels the built-in marketplace with the brand name', () => {
    expect(formatMarketplaceSourceLabel('builtin', 'builtin:app')).toBe(
      'Canopy (built-in)',
    );
  });

  it('labels Codex marketplaces with their source label', () => {
    expect(formatMarketplaceSourceLabel('codex', 'OpenAI Curated')).toBe(
      'OpenAI Curated',
    );
  });
});

describe('computePluginShareableRef', () => {
  it('emits a GitHub marketplace ref for GitHub-backed marketplaces', () => {
    const ref = computePluginShareableRef(
      makePlugin({ name: 'browser' }),
      makeMarketplace({ sourceUrl: 'acme/plugins' }),
    );
    expect(ref).toEqual({
      type: 'claude_plugin',
      marketplace: { type: 'github', repo: 'acme/plugins' },
      plugin_name: 'browser',
    });
  });

  it('emits a provider-neutral ref for GitHub plugins with native Claude and Codex facets', () => {
    const ref = computePluginShareableRef(
      makePlugin({
        name: 'browser',
        providerSupport: { claude: 'native', codex: 'native' },
        facets: {
          claude: {
            provider: 'claude',
            mode: 'native',
            name: 'browser',
            installLocation: '/tmp/claude-browser',
            sourcePath: '/tmp/claude-browser',
          },
          codex: {
            provider: 'codex',
            mode: 'native',
            name: 'browser',
            installLocation: '/tmp/codex-browser',
            sourcePath: '/tmp/codex-browser',
          },
        },
      }),
      makeMarketplace({ sourceUrl: 'acme/plugins' }),
    );
    expect(ref).toEqual({
      type: 'plugin',
      marketplace: { type: 'github', repo: 'acme/plugins' },
      plugin_name: 'browser',
    });
  });

  it('emits the built-in marketplace ref shape for built-in marketplaces', () => {
    const ref = computePluginShareableRef(
      makePlugin({ name: 'My Plugin', builtIn: true }),
      makeMarketplace({
        id: 'builtin/app',
        builtIn: true,
        sourceType: 'builtin',
        sourceUrl: 'builtin:app',
      }),
    );
    expect(ref).toEqual({
      type: 'claude_plugin',
      marketplace: { type: 'builtin', id: 'app' },
      plugin_name: 'My Plugin',
    });
  });

  it('emits a Codex-native ref for Codex-only marketplace plugins', () => {
    const ref = computePluginShareableRef(
      makePlugin({
        name: 'codex-security',
        providerSupport: { claude: 'none', codex: 'native' },
        facets: {
          codex: {
            provider: 'codex',
            mode: 'native',
            name: 'codex-security',
            installLocation: '/tmp/codex-security',
            sourcePath: '/tmp/codex-security',
          },
        },
      }),
      makeMarketplace({
        id: 'openai-curated',
        name: 'OpenAI Curated',
        sourceType: 'codex',
        sourceUrl: 'OpenAI Curated',
        validProviders: ['codex'],
      }),
    );
    expect(ref).toEqual({
      type: 'codex_plugin',
      marketplace: { type: 'codex-builtin', id: 'openai-curated' },
      plugin_name: 'codex-security',
    });
  });

  it('returns undefined for a non-GitHub, non-built-in marketplace', () => {
    expect(
      computePluginShareableRef(
        makePlugin(),
        makeMarketplace({ sourceType: 'local', sourceUrl: '/local/path' }),
      ),
    ).toBeUndefined();
  });
});

function makeMcpServer(
  overrides: Partial<McpServerIndexEntry> = {},
): McpServerIndexEntry {
  return {
    id: 'srv-1',
    name: 'GitHub',
    description: 'GitHub MCP server',
    type: 'http',
    configs: [{ id: 'c1', name: 'Default', enabled: true }],
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildMcpRows', () => {
  it('drops the config name when a server has a single enabled config', () => {
    const rows = buildMcpRows([makeMcpServer()]);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('GitHub');
    expect(rows[0].key).toBe('srv-1/c1');
  });

  it('lists device copies nested under an account row', (): void => {
    const rows = buildMcpRows([
      makeMcpServer({
        id: 'account-github',
        name: 'GitHub (account)',
        curatedKey: 'github',
        scope: 'account',
        deviceCopies: [
          makeMcpServer({ id: 'device-github', name: 'GitHub (device)' }),
        ],
      }),
    ]);
    expect(rows.map((row) => row.key)).toEqual([
      'account-github/c1',
      'device-github/c1',
    ]);
  });

  it('keys account rows by server key and config, the shared selection ref', (): void => {
    const connection = {
      status: 'CONNECTED' as const,
      routeId: 'route',
      enabledTools: null,
      configId: 'default',
    };
    const rows = buildMcpRows(
      mergeAccountMcpInventory(
        [makeMcpServer({ id: 'device-github', curatedKey: 'github' })],
        [
          {
            ...connection,
            id: 'connection-github',
            serverKey: 'github',
            displayName: 'GitHub',
            kind: 'CURATED',
          },
          {
            ...connection,
            id: 'connection-custom',
            serverKey: 'custom:11111111-2222-4333-8444-555555555555',
            displayName: 'Internal tools',
            kind: 'CUSTOM',
          },
        ],
      ),
    );
    expect(rows.map((row) => row.key)).toEqual([
      'custom:11111111-2222-4333-8444-555555555555/default',
      'github/default',
      'device-github/c1',
    ]);
  });

  it('keeps the "server — config" name when multiple configs are enabled', () => {
    const rows = buildMcpRows([
      makeMcpServer({
        configs: [
          { id: 'c1', name: 'Prod', enabled: true },
          { id: 'c2', name: 'Staging', enabled: true },
        ],
      }),
    ]);
    expect(rows.map((r) => r.name)).toEqual([
      'GitHub — Prod',
      'GitHub — Staging',
    ]);
  });

  it('ignores disabled configs when deciding the single-config naming', () => {
    const rows = buildMcpRows([
      makeMcpServer({
        configs: [
          { id: 'c1', name: 'Prod', enabled: true },
          { id: 'c2', name: 'Staging', enabled: false },
        ],
      }),
    ]);
    // Only one ENABLED config → server-name-only.
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('GitHub');
  });

  it('propagates the curated logo URL onto the row', () => {
    const rows = buildMcpRows([
      makeMcpServer({ logoUrl: 'https://cdn.example.com/github.png' }),
    ]);
    expect(rows[0].logoUrl).toBe('https://cdn.example.com/github.png');
  });

  it('propagates the curated key onto the row for bundled-logo lookup', () => {
    const rows = buildMcpRows([makeMcpServer({ curatedKey: 'github' })]);
    expect(rows[0].curatedKey).toBe('github');

    const uncurated = buildMcpRows([makeMcpServer({})]);
    expect(uncurated[0].curatedKey).toBeUndefined();
  });
});

describe('computePluginSourceIcon', () => {
  it('returns `mixed` for plugins with both Claude and Codex facets', () => {
    expect(computePluginSourceIcon({ claude: 'native', codex: 'native' })).toBe(
      'mixed',
    );
  });

  it('returns `mixed` when Claude has a native facet and Codex falls back to compat', () => {
    expect(computePluginSourceIcon({ claude: 'native', codex: 'compat' })).toBe(
      'mixed',
    );
  });

  it('returns `claude` when only Claude is present', () => {
    expect(computePluginSourceIcon({ claude: 'native', codex: 'none' })).toBe(
      'claude',
    );
  });

  it('returns `codex` when only Codex is present', () => {
    expect(computePluginSourceIcon({ claude: 'none', codex: 'native' })).toBe(
      'codex',
    );
  });

  it('returns `none` for a plugin neither provider supports', () => {
    expect(computePluginSourceIcon({ claude: 'none', codex: 'none' })).toBe(
      'none',
    );
  });
});

describe('buildProviderConnectorRowsForPicker', () => {
  const CATALOG = [
    {
      key: 'gmail-gmailmcp',
      name: 'Gmail',
      shortDescription: 'Read and send mail',
      url: 'https://gmailmcp.googleapis.com/mcp/v1',
      transport: 'http' as const,
      categories: [],
      popular: false,
      sortOrder: 0,
      updatedAt: '2026-08-31T00:00:00.000Z',
      providerConnector: { providers: ['claude' as const, 'codex' as const] },
    },
  ];

  it('surfaces an advertised connector so the picker is not silently missing it', () => {
    // The connector shows on the Plugins page but had no row here at all, so a
    // user who went looking for Gmail in workspace settings found nothing and
    // no explanation.
    const rows = buildProviderConnectorRowsForPicker(CATALOG, []);
    expect(rows.map((r) => r.name)).toEqual(['Gmail']);
  });

  it('does not render an unlinked connector as checked', () => {
    // `UnifiedTable` renders `checked={locked || checked}`, so `locked` claims
    // the capability is active. For a connector nobody has linked that is the
    // same false claim this PR exists to remove — a checked "Gmail" row in
    // every workspace picker for an account that was never connected.
    const [row] = buildProviderConnectorRowsForPicker(CATALOG, []);
    expect(row?.toggleMode).toBe('disabled');
    expect(row?.sourceSubtitle).not.toMatch(/linked on/i);
  });

  it('locks the row once the connector is actually linked', () => {
    // Then `locked` is true: it IS active, and Canopy cannot scope it per
    // workspace, so checked-and-disabled is the honest affordance.
    const [row] = buildProviderConnectorRowsForPicker(CATALOG, [
      {
        provider: 'claude',
        connectors: [
          {
            name: 'claude.ai Gmail',
            displayName: 'Gmail',
            connected: true,
            status: '✔ Connected',
          },
        ],
      },
      { provider: 'codex', connectors: [] },
    ]);
    expect(row?.toggleMode).toBe('locked');
    expect(row?.sourceSubtitle).toMatch(/linked/i);
    expect(row?.toggleReason).toMatch(/account/i);
  });

  it('says it is still checking while a read is outstanding', () => {
    // No result for a provider is not an answer. Claiming "not linked" here is
    // the first-paint bug in a different surface.
    const [row] = buildProviderConnectorRowsForPicker(CATALOG, undefined);
    expect(row?.toggleMode).toBe('disabled');
    expect(row?.sourceSubtitle).toMatch(/checking/i);
  });

  it('disables View, which would parse the key as a local server id', () => {
    // `openUnifiedTableRowDetails` treats every `kind: 'mcp'` key as
    // `serverId/configId` and slices at the first `/`. This key has none, so
    // the slice truncates the last character and the id fails the main
    // process's `SAFE_ID_RE` — the user gets a raw "Invalid MCP server id"
    // error box. There is no local server to view: the connection lives on the
    // provider's account.
    const [row] = buildProviderConnectorRowsForPicker(CATALOG, []);
    expect(row?.viewDisabled).toBe(true);
  });

  it('puts the explanation where the table actually renders it', () => {
    // The Source cell is gated on `row.source`, so leaving it empty meant the
    // subtitle never rendered and the row explained nothing — the whole point
    // of surfacing it here.
    const [row] = buildProviderConnectorRowsForPicker(CATALOG, []);
    expect(row?.source).toBeTruthy();
  });

  it('carries the catalog key so the row resolves its brand mark', () => {
    const [row] = buildProviderConnectorRowsForPicker(CATALOG, []);
    expect(row?.curatedKey).toBe('gmail-gmailmcp');
  });

  it('advertises nothing when no entry is configured as a connector', () => {
    expect(
      buildProviderConnectorRowsForPicker(
        [{ ...CATALOG[0], providerConnector: undefined }],
        [],
      ),
    ).toEqual([]);
  });
});

describe('buildProviderConnectorRowsForPicker edge cases', () => {
  const entry = {
    key: 'gmail-gmailmcp',
    name: 'Gmail',
    shortDescription: 'Read and send mail',
    url: 'https://gmailmcp.googleapis.com/mcp/v1',
    transport: 'http' as const,
    categories: [],
    popular: false,
    sortOrder: 0,
    updatedAt: '2026-08-31T00:00:00.000Z',
  };

  it('skips an entry advertising no providers rather than rendering blanks', () => {
    // `resolveProviderConnectorCatalog` tolerates `providers: []` on read for
    // forward-compatibility, so it reaches here — and joining an empty list
    // produced "Managed on your  account", with the gap where a provider name
    // should be.
    expect(
      buildProviderConnectorRowsForPicker(
        [{ ...entry, providerConnector: { providers: [] } }],
        [],
      ),
    ).toEqual([]);
  });

  it('offers the connector source as a filter option, not just on the row', () => {
    // The row carrying a `sourceId` is only half of it. `UnifiedTable`'s source
    // filter is an allowlist — once any source is checked, rows whose
    // `sourceId` is not in that set vanish. Without a matching option the user
    // can never check "provider account", so filtering to anything else
    // silently hides every connector row. Asserting the row field alone passed
    // while that was still broken.
    const [row] = buildProviderConnectorRowsForPicker(
      [{ ...entry, providerConnector: { providers: ['claude' as const] } }],
      [],
    );
    const options = buildProviderConnectorSourceOptions([
      { ...entry, providerConnector: { providers: ['claude' as const] } },
    ]);
    expect(row?.sourceId).toBeTruthy();
    expect(options.map((option) => option.value)).toContain(row?.sourceId);
  });

  it('offers no source option when nothing advertises a connector', () => {
    expect(buildProviderConnectorSourceOptions([entry])).toEqual([]);
  });
});

describe('collapseDuplicatePluginRows keeps every reachable copy', () => {
  const overlapping = (
    marketplaceId: string,
    support: { claude: 'native' | 'none'; codex: 'native' | 'compat' | 'none' },
  ): UnifiedTableRow => ({
    kind: 'plugin',
    key: `${marketplaceId}/slack`,
    name: 'slack',
    description: '',
    source: 'label-not-an-id',
    marketplaceId,
    sourceSubtitle: '',
    sourceIcon: 'mixed',
    lastUpdated: '2026-08-31T00:00:00.000Z',
    providerSupport: support,
  });

  it('does not let a selected subset evict the copy that covers it', () => {
    // Pinning a selected row must mean "never hide this one", not "this one
    // wins". Swapping the covering superset out for the selected subset loses
    // the Claude-capable copy entirely: in a Claude-scoped workspace the
    // survivor renders unsupported and the capability is unreachable — worse
    // than not collapsing at all.
    const both = overlapping('claude-plugins-official', {
      claude: 'native',
      codex: 'native',
    });
    const codexOnly = overlapping('openai-curated-remote', {
      claude: 'none',
      codex: 'native',
    });

    const kept = collapseDuplicatePluginRows(
      [both, codexOnly],
      new Set([codexOnly.key]),
    );

    expect(kept.map((row) => row.key).sort()).toEqual(
      [both.key, codexOnly.key].sort(),
    );
  });

  it('agrees with the Plugins page when three copies overlap', () => {
    // Three overlapping marketplaces are concurrent in production, and the
    // reported case named three Slacks. A first-seen comparison only ever
    // measures later copies against the first, so the two surfaces returned
    // different counts for the same catalog.
    const claudeOnly = overlapping('claude-plugins-official', {
      claude: 'native',
      codex: 'none',
    });
    const codexOnly = overlapping('openai-curated-remote', {
      claude: 'none',
      codex: 'native',
    });
    const both = overlapping('openai-curated', {
      claude: 'native',
      codex: 'native',
    });

    const kept = collapseDuplicatePluginRows([claudeOnly, codexOnly, both]);

    expect(kept).toHaveLength(1);
    expect(kept[0]?.key).toBe(both.key);
  });
});

describe('the pinned branch dedupes its remainder too', () => {
  const overlapping = (
    marketplaceId: string,
    support: { claude: 'native' | 'none'; codex: 'native' | 'compat' | 'none' },
  ): UnifiedTableRow => ({
    kind: 'plugin',
    key: `${marketplaceId}/slack`,
    name: 'slack',
    description: '',
    source: 'label-not-an-id',
    marketplaceId,
    sourceSubtitle: '',
    sourceIcon: 'mixed',
    lastUpdated: '2026-08-31T00:00:00.000Z',
    providerSupport: support,
  });

  it('collapses identical copies the pinned one does not cover', () => {
    // Candidates were only ever compared against the pinned set, never against
    // each other — so two identical copies the pinned row did not cover both
    // survived. That is the same "three Slacks" this change exists to remove,
    // still standing whenever one copy happened to be pinned.
    const pinnedClaudeOnly = overlapping('claude-plugins-official', {
      claude: 'native',
      codex: 'none',
    });
    const codexA = overlapping('openai-curated-remote', {
      claude: 'none',
      codex: 'native',
    });
    const codexB = overlapping('openai-curated', {
      claude: 'none',
      codex: 'native',
    });

    const kept = collapseDuplicatePluginRows(
      [pinnedClaudeOnly, codexA, codexB],
      new Set([pinnedClaudeOnly.key]),
    );

    expect(kept).toHaveLength(2);
    expect(kept.map((row) => row.key)).toContain(pinnedClaudeOnly.key);
    expect(kept.filter((row) => row.key.startsWith('openai-'))).toHaveLength(1);
  });
});

describe('a row whose provider support is unknown', () => {
  const overlapping = (
    marketplaceId: string,
    support?: {
      claude: 'native' | 'none';
      codex: 'native' | 'compat' | 'none';
    },
  ): UnifiedTableRow => ({
    kind: 'plugin',
    key: `${marketplaceId}/slack`,
    name: 'slack',
    description: '',
    source: 'label-not-an-id',
    marketplaceId,
    sourceSubtitle: '',
    sourceIcon: 'mixed',
    lastUpdated: '2026-08-31T00:00:00.000Z',
    ...(support ? { providerSupport: support } : {}),
  });

  it('is neither collapsed nor the reason a sibling disappears', () => {
    // An older on-disk marketplace cache can produce a row with no declared
    // support. Treating that as "reaches everything" was meant to keep it
    // safe, but reaching everything is exactly what makes it *cover* — and so
    // evict — every single-provider sibling. Opting it out of grouping is what
    // actually keeps both rows.
    const undescribed = overlapping('claude-plugins-official');
    const codexOnly = overlapping('openai-curated-remote', {
      claude: 'none',
      codex: 'native',
    });

    const kept = collapseDuplicatePluginRows([undescribed, codexOnly]);

    expect(kept.map((row) => row.key).sort()).toEqual(
      [undescribed.key, codexOnly.key].sort(),
    );
  });
});
