import type { DetectedMcpServerInfo } from '@canopy/desktop-shared/types/mcp-servers';
import { targetForDetectedServer } from '../detectedMcpServerHelpers';

function makeServer(
  overrides: Partial<DetectedMcpServerInfo>,
): DetectedMcpServerInfo {
  return {
    key: 'k',
    source: 'standalone',
    serverName: 'test',
    displayName: 'Test',
    type: 'http',
    enabled: true,
    authStatus: 'not_connected',
    authStatusLabel: 'Needs auth',
    canConnect: false,
    ...overrides,
  };
}

describe('targetForDetectedServer', () => {
  it('produces a standalone target from a standalone HTTP row', () => {
    const target = targetForDetectedServer(
      makeServer({
        source: 'standalone',
        serverId: 'srv-id',
        configId: 'cfg-id',
      }),
    );
    expect(target).toEqual({
      kind: 'standalone',
      serverId: 'srv-id',
      configId: 'cfg-id',
    });
  });

  it('produces a plugin target from a plugin HTTP row', () => {
    const target = targetForDetectedServer(
      makeServer({
        source: 'plugin',
        marketplaceId: 'mkt',
        pluginName: 'Linear',
        pluginServerName: 'linear',
      }),
    );
    expect(target).toEqual({
      kind: 'plugin',
      marketplaceId: 'mkt',
      pluginName: 'Linear',
      serverName: 'linear',
    });
  });

  it('prefers the standalone identity when both standalone and plugin fields are present', () => {
    // The inventory may attach plugin metadata to a standalone-sourced row;
    // standalone identity is the more specific addressing scheme and wins.
    const target = targetForDetectedServer(
      makeServer({
        source: 'standalone',
        serverId: 'srv-id',
        configId: 'cfg-id',
        marketplaceId: 'mkt',
        pluginName: 'Linear',
        pluginServerName: 'linear',
      }),
    );
    expect(target?.kind).toBe('standalone');
  });

  it('returns null when the server lacks identifiable fields', () => {
    const target = targetForDetectedServer(
      makeServer({
        source: 'plugin',
        marketplaceId: 'mkt',
        pluginName: 'Linear',
        // Missing pluginServerName.
      }),
    );
    expect(target).toBeNull();
  });

  it('returns null for command rows with no addressing fields', () => {
    const target = targetForDetectedServer(
      makeServer({ source: 'standalone', type: 'command' }),
    );
    expect(target).toBeNull();
  });
});
