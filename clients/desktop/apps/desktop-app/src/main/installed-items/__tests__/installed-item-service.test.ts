import type { MarketplaceInfo } from '@canopy/protocol/plugins';
import { installedItemService } from '../installed-item-service';
import { loadMarketplacesCacheOnly } from '../../plugins/plugin-service';
import { resolvePluginInfoPath } from '../../plugins/plugin-resolver';
import { accountMcpConnectionsEnabled } from '../../mcp/account-catalog';
import {
  accountMcpConnectionsEditable,
  listAccountMcpConnections,
} from '../../canopy-cloud/mcp-connections';
import { CanopyCloudClientError } from '../../canopy-cloud/client';

jest.mock('node:fs/promises', () => ({
  readFile: (): Promise<string> =>
    Promise.resolve('{"version":1,"servers":[]}'),
}));
jest.mock('../../plugins/plugin-resolver', () => ({
  resolvePluginInfoPath: jest.fn(),
}));
jest.mock('../../plugins/plugin-service', () => ({
  loadMarketplacesCacheOnly: jest.fn(),
  readClaudeInstalledItemState: (): { ids: string[]; enabled: boolean } => ({
    ids: [],
    enabled: true,
  }),
}));
jest.mock('../../lib/preferences-store', () => ({
  readPreferencesFile: (): Promise<object> => Promise.resolve({}),
}));
jest.mock('../../lib/paths', () => ({
  getMcpServersIndexFilePath: (): string => '/nonexistent-can4255-index.json',
}));
jest.mock('../../services/plugin-catalog-service', () => ({
  runSerializedPluginMutation: (
    operation: () => Promise<unknown>,
  ): Promise<unknown> => operation(),
}));
jest.mock('../../plugins/codex-marketplace-service', () => ({}));
jest.mock('../../skills/skill-service', () => ({
  loadSkills: (): { success: boolean; data: unknown[] } => ({
    success: true,
    data: [],
  }),
}));
jest.mock('../../skills/skill-install-context', () => ({
  filterStoredSkillContexts: (skills: unknown[]): Promise<unknown[]> =>
    Promise.resolve(skills),
}));
jest.mock('../../collections/collection-store', () => ({
  readCollectionIndex: (): Promise<{ collections: unknown[] }> =>
    Promise.resolve({ collections: [] }),
}));
jest.mock('../../mcp/account-catalog', () => ({
  accountMcpConnectionsEnabled: jest.fn((): boolean => false),
}));
jest.mock('../../canopy-cloud/mcp-connections', () => ({
  accountMcpConnectionsEditable: jest.fn(),
  listAccountMcpConnections: jest.fn(),
}));
jest.mock('../installed-item-events', () => ({}));

const marketplace: MarketplaceInfo = {
  id: 'local-market',
  name: 'Local market',
  description: '',
  sourceType: 'local',
  sourceUrl: '',
  installLocation: '/market',
  pluginCount: 1,
  validProviders: ['claude'],
  providerStatus: {
    claude: {
      provider: 'claude',
      state: 'valid',
      accepted: true,
      pluginCount: 1,
      lastCheckedAt: '',
    },
    codex: {
      provider: 'codex',
      state: 'invalid',
      accepted: false,
      pluginCount: 0,
      lastCheckedAt: '',
    },
  },
  plugins: [
    {
      name: 'inline',
      marketplaceId: 'local-market',
      sourcePath: './inline',
      providerSupport: { claude: 'native', codex: 'none' },
      facets: {
        claude: {
          provider: 'claude',
          mode: 'native',
          name: 'inline',
          sourcePath: './inline',
          installLocation: '/market/inline',
        },
      },
    },
  ],
};

test('enumerates a usable inline marketplace plugin without installing or offering source deletion', async () => {
  jest.mocked(loadMarketplacesCacheOnly).mockResolvedValue({
    success: true,
    data: {
      version: 2,
      lastRefreshed: '2026-01-01T00:00:00.000Z',
      marketplaces: [marketplace],
    },
  });
  jest.mocked(resolvePluginInfoPath).mockResolvedValue('/market/inline');
  const snapshot = await installedItemService.listStatus();
  expect(snapshot.items).toContainEqual(
    expect.objectContaining({
      target: {
        kind: 'plugin',
        marketplaceId: 'local-market',
        pluginName: 'inline',
      },
      status: 'available',
      removable: false,
    }),
  );
  expect(resolvePluginInfoPath).toHaveBeenCalledWith(
    marketplace.plugins[0],
    marketplace,
    [],
    false,
  );
  jest.mocked(resolvePluginInfoPath).mockResolvedValue(null);
  expect((await installedItemService.listStatus()).items).toEqual([]);
});

describe('account MCP connections', () => {
  beforeEach(() => {
    jest.mocked(loadMarketplacesCacheOnly).mockResolvedValue({
      success: true,
      data: {
        version: 2,
        lastRefreshed: '2026-01-01T00:00:00.000Z',
        marketplaces: [],
      },
    });
    jest.mocked(accountMcpConnectionsEnabled).mockReturnValue(true);
    jest.mocked(accountMcpConnectionsEditable).mockResolvedValue(false);
  });
  afterEach(() => {
    jest.mocked(accountMcpConnectionsEnabled).mockReturnValue(false);
    jest.mocked(listAccountMcpConnections).mockReset();
  });

  // Signed out, or on a server without account connections, the account
  // contributes no items. The rest of the snapshot still loads.
  test.each([
    ['missing-api-key', 'Canopy Cloud API key is required.'],
    ['cloud-not-configured', 'Canopy Cloud is not configured.'],
    ['unsupported-capability', 'mcp-connections-v1 is unsupported.'],
  ] as const)(
    'lists no account items when the account has none (%s)',
    async (code, message) => {
      jest
        .mocked(listAccountMcpConnections)
        .mockRejectedValue(new CanopyCloudClientError(code, message));
      await expect(installedItemService.listStatus()).resolves.toEqual({
        items: [],
      });
    },
  );

  test('fails the snapshot when a signed-in account list cannot be read', async () => {
    jest
      .mocked(listAccountMcpConnections)
      .mockRejectedValue(
        new CanopyCloudClientError('network-error', 'offline'),
      );
    await expect(installedItemService.listStatus()).rejects.toThrow('offline');
  });
});
