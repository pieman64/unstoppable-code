import {
  portalCatalogEntryBlocker,
  portalCatalogMcpServerConnectable,
  type PortalPluginCatalogUnifiedEntry,
} from '../index';

type Entry = Pick<
  PortalPluginCatalogUnifiedEntry,
  'kind' | 'state' | 'connectionState' | 'cloudCapabilities'
>;

const CAPABILITIES: Entry['cloudCapabilities'] = {
  hasSkills: true,
  hasCommands: false,
  hasAgents: false,
  mcpOnly: false,
  hooksStripped: false,
};

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    kind: 'plugin',
    state: 'available',
    cloudCapabilities: CAPABILITIES,
    ...overrides,
  };
}

describe('portalCatalogEntryBlocker', () => {
  it('lets a chat take an available entry', () => {
    expect(portalCatalogEntryBlocker(entry())).toBeNull();
    expect(
      portalCatalogEntryBlocker(
        entry({
          kind: 'app',
          cloudCapabilities: { ...CAPABILITIES, mcpOnly: true },
          connectionState: 'not_connected',
        }),
      ),
    ).toBeNull();
  });

  it('names the most specific reason a chat here cannot take an entry', () => {
    expect(
      portalCatalogEntryBlocker(
        entry({
          kind: 'app',
          state: 'needs-auth',
          connectionState: 'desktop_only',
        }),
      ),
    ).toBe('desktop_only');
    expect(
      portalCatalogEntryBlocker(
        entry({
          state: 'needs-auth',
          cloudCapabilities: { ...CAPABILITIES, mcpOnly: true },
        }),
      ),
    ).toBe('mcp_only_plugin');
    expect(portalCatalogEntryBlocker(entry({ state: 'needs-auth' }))).toBe(
      'unavailable',
    );
  });
});

describe('portalCatalogMcpServerConnectable', () => {
  it('reads only a desktop-only server as one this surface cannot connect', () => {
    expect(portalCatalogMcpServerConnectable({})).toBe(true);
    expect(
      portalCatalogMcpServerConnectable({ connectionState: 'not_connected' }),
    ).toBe(true);
    expect(
      portalCatalogMcpServerConnectable({ connectionState: 'desktop_only' }),
    ).toBe(false);
  });
});
