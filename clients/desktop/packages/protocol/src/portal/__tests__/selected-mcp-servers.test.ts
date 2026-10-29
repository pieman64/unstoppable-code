import {
  addedSelectedMcpServers,
  resolveSelectedMcpServers,
  selectedMcpServerKey,
  type PortalChatTabPluginSelections,
  type SelectedMcpServerCatalogEntry,
} from '../index';

const EMPTY: PortalChatTabPluginSelections = {
  collectionIds: [],
  skillRefs: [],
  pluginRefs: [],
};

function pluginEntry(
  pluginName: string,
  name: string,
  mcpServerRefs?: { serverId: string; configId: string }[],
  marketplaceId = 'cloud-curated',
): SelectedMcpServerCatalogEntry {
  return {
    name,
    selectionRef: { type: 'marketplace-plugin', marketplaceId, pluginName },
    ...(mcpServerRefs === undefined ? {} : { mcpServerRefs }),
  };
}

const LINEAR = pluginEntry('linear', 'Linear', [
  { serverId: 'linear', configId: 'default' },
]);
const WORKSPACE = pluginEntry('workspace', 'Workspace', [
  { serverId: 'gmail', configId: 'default' },
  { serverId: 'calendar', configId: 'default' },
]);

describe('resolveSelectedMcpServers', () => {
  it('returns direct selections in selection order', () => {
    expect(
      resolveSelectedMcpServers(
        {
          ...EMPTY,
          mcpServerRefs: [
            { serverId: 'notion', configId: 'default' },
            { serverId: 'custom:1', configId: 'work' },
          ],
        },
        { entries: [] },
      ),
    ).toEqual([
      { serverId: 'notion', configId: 'default', via: { kind: 'direct' } },
      { serverId: 'custom:1', configId: 'work', via: { kind: 'direct' } },
    ]);
  });

  it('adds the servers each selected plugin brings, naming the plugin', () => {
    expect(
      resolveSelectedMcpServers(
        {
          ...EMPTY,
          pluginRefs: [
            { marketplaceId: 'cloud-curated', pluginName: 'workspace' },
            { marketplaceId: 'cloud-curated', pluginName: 'linear' },
          ],
        },
        { entries: [LINEAR, WORKSPACE] },
      ),
    ).toEqual([
      {
        serverId: 'gmail',
        configId: 'default',
        via: {
          kind: 'plugin',
          marketplaceId: 'cloud-curated',
          pluginName: 'workspace',
          pluginDisplayName: 'Workspace',
        },
      },
      {
        serverId: 'calendar',
        configId: 'default',
        via: {
          kind: 'plugin',
          marketplaceId: 'cloud-curated',
          pluginName: 'workspace',
          pluginDisplayName: 'Workspace',
        },
      },
      {
        serverId: 'linear',
        configId: 'default',
        via: {
          kind: 'plugin',
          marketplaceId: 'cloud-curated',
          pluginName: 'linear',
          pluginDisplayName: 'Linear',
        },
      },
    ]);
  });

  it('lists a server once, preferring its direct selection over a plugin', () => {
    const resolved = resolveSelectedMcpServers(
      {
        ...EMPTY,
        pluginRefs: [
          { marketplaceId: 'cloud-curated', pluginName: 'linear' },
          { marketplaceId: 'cloud-curated', pluginName: 'linear-again' },
        ],
        mcpServerRefs: [{ serverId: 'linear', configId: 'default' }],
      },
      {
        entries: [
          LINEAR,
          pluginEntry('linear-again', 'Linear again', [
            { serverId: 'linear', configId: 'default' },
            { serverId: 'linear', configId: 'eu' },
          ]),
        ],
      },
    );
    expect(resolved.map(selectedMcpServerKey)).toEqual([
      'linear/default',
      'linear/eu',
    ]);
    expect(resolved[0]?.via).toEqual({ kind: 'direct' });
    expect(resolved[1]?.via).toMatchObject({ pluginName: 'linear-again' });
  });

  it('reads plugin servers whatever the state of the plugin inventory', () => {
    // A plugin whose capability artifacts are stale carries no member
    // inventory, only its server list; the servers still resolve.
    const stale = { ...LINEAR, memberInventory: undefined };
    expect(
      resolveSelectedMcpServers(
        {
          ...EMPTY,
          pluginRefs: [
            { marketplaceId: 'cloud-curated', pluginName: 'linear' },
          ],
        },
        { entries: [stale] },
      ).map(selectedMcpServerKey),
    ).toEqual(['linear/default']);
  });

  it('adds nothing for a plugin the catalog does not list or that names no servers', () => {
    expect(
      resolveSelectedMcpServers(
        {
          ...EMPTY,
          pluginRefs: [
            { marketplaceId: 'cloud-curated', pluginName: 'gone' },
            { marketplaceId: 'marketplace:abc', pluginName: 'own-mcp' },
          ],
          mcpServerRefs: [{ serverId: 'notion', configId: 'default' }],
        },
        {
          entries: [
            // Marketplace plugins' own `.mcp.json` servers are not account
            // servers: the catalog names none for them.
            pluginEntry('own-mcp', 'Own MCP', undefined, 'marketplace:abc'),
          ],
        },
      ).map(selectedMcpServerKey),
    ).toEqual(['notion/default']);
  });

  it('resolves direct selections without a catalog', () => {
    expect(
      resolveSelectedMcpServers(
        {
          ...EMPTY,
          pluginRefs: [
            { marketplaceId: 'cloud-curated', pluginName: 'linear' },
          ],
          mcpServerRefs: [{ serverId: 'notion', configId: 'default' }],
        },
        null,
      ).map(selectedMcpServerKey),
    ).toEqual(['notion/default']);
    expect(resolveSelectedMcpServers(undefined, null)).toEqual([]);
  });
});

describe('addedSelectedMcpServers', () => {
  it('returns the servers the next selection adds, directly or through a plugin', () => {
    const catalog = { entries: [LINEAR, WORKSPACE] };
    const previous = {
      ...EMPTY,
      mcpServerRefs: [{ serverId: 'gmail', configId: 'default' }],
    };
    const next = {
      ...previous,
      pluginRefs: [
        { marketplaceId: 'cloud-curated', pluginName: 'workspace' },
        { marketplaceId: 'cloud-curated', pluginName: 'linear' },
      ],
    };
    expect(
      addedSelectedMcpServers(previous, next, catalog).map(
        selectedMcpServerKey,
      ),
    ).toEqual(['calendar/default', 'linear/default']);
    expect(addedSelectedMcpServers(next, previous, catalog)).toEqual([]);
    expect(
      addedSelectedMcpServers(undefined, next, catalog).map(
        selectedMcpServerKey,
      ),
    ).toEqual(['gmail/default', 'calendar/default', 'linear/default']);
  });
});
