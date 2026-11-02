import { curateMarketplaceBrowse } from '../marketplace-browse-curation';
import type { UnifiedPluginEntry } from '../unified-plugin-entry';

function entry(
  overrides: Partial<UnifiedPluginEntry> &
    Pick<UnifiedPluginEntry, 'id' | 'ref'>,
): UnifiedPluginEntry {
  return {
    kind: 'plugin',
    origin: 'marketplace',
    name: 'Acmechat',
    description: '',
    categories: ['communication'],
    components: { skills: 0, mcpServers: 1, commands: 0, agents: 0 },
    providerSupport: { claude: true, codex: true },
    state: 'available',
    recommended: false,
    ...overrides,
  };
}

const curatedCard = (
  overrides: Partial<UnifiedPluginEntry> = {},
): UnifiedPluginEntry =>
  entry({
    id: 'mcp-catalog:acmechat',
    kind: 'app',
    origin: 'curated',
    ref: { type: 'curated-mcp', key: 'acmechat' },
    ...overrides,
  });

const codexPlugin = entry({
  id: 'mkt:openai-curated/acmechat',
  ref: {
    type: 'marketplace-plugin',
    marketplaceId: 'openai-curated',
    pluginName: 'acmechat',
  },
});

function browseIds(entries: UnifiedPluginEntry[]): string[] {
  const curation = curateMarketplaceBrowse(entries);
  return [
    ...curation.featured,
    ...curation.categories.flatMap((category) => category.entries),
  ].map((row) => row.id);
}

describe('curateMarketplaceBrowse — same-name plugin and MCP card (CAN-3653)', () => {
  it('shows the plugin, not the curated MCP card, when both share a name', () => {
    expect(browseIds([curatedCard(), codexPlugin])).toEqual([codexPlugin.id]);
  });

  it('prefers an installed curated card over an available plugin of the same name', () => {
    const installed = curatedCard({ state: 'installed' });
    expect(browseIds([codexPlugin, installed])).toEqual([installed.id]);
  });

  it('prefers an installed plugin over the installed server it bundles', () => {
    const installedPlugin = { ...codexPlugin, state: 'installed' as const };
    const bundledServer = entry({
      id: 'mcp-local:acmechat',
      kind: 'app',
      origin: 'installed-standalone',
      state: 'installed',
      ref: { type: 'local-mcp', serverId: 'acmechat' },
      bundledBy: { entryId: codexPlugin.id, name: 'Acmechat' },
    });
    expect(browseIds([bundledServer, installedPlugin])).toEqual([
      installedPlugin.id,
    ]);
  });

  it('keeps a card that folds in its curated plugin ahead of a marketplace plugin', () => {
    const folded = curatedCard({
      integration: {
        curatedKey: 'acmechat',
        plugin: {
          key: 'acmechat',
          name: 'Acmechat',
          skills: 2,
          installed: false,
        },
        connections: [],
      },
    });
    expect(browseIds([codexPlugin, folded])).toEqual([folded.id]);
  });
});
