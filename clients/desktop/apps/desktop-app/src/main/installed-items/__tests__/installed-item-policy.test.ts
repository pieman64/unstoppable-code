jest.mock('../../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(),
}));
jest.mock('../../plugins/plugin-service', () => ({
  loadMarketplacesCacheOnly: jest.fn(() =>
    Promise.resolve({
      success: true,
      data: {
        marketplaces: [
          {
            id: 'canonical',
            name: 'Display',
            providerStatus: {
              claude: { marketplaceName: 'provider-name' },
              codex: { marketplaceName: 'Display' },
            },
            plugins: [{ name: 'Plugin', facets: { codex: {} } }],
          },
        ],
      },
    }),
  ),
}));
jest.mock('../../plugins/claude-enabled-plugins', () => ({
  readClaudeDisabledInstalledPlugins: jest.fn(() => []),
}));
jest.mock('../../plugins/codex-marketplace-service', () => ({
  listCodexPlugins: jest.fn(),
}));
import { readInstalledItemPolicy } from '../installed-item-policy';
import { readClaudeDisabledInstalledPlugins } from '../../plugins/claude-enabled-plugins';
import { installedItemKey } from '@canopy/protocol/installed-items';
import { listCodexPlugins } from '../../plugins/codex-marketplace-service';

beforeEach(() => {
  jest.mocked(readClaudeDisabledInstalledPlugins).mockReturnValue([]);
  jest.mocked(listCodexPlugins).mockResolvedValue({
    marketplaces: [],
    marketplaceLoadErrors: [],
    featuredPluginIds: [],
  });
});
test.each([
  { installed: true, enabled: false, disabled: true },
  { installed: true, enabled: true, disabled: false },
  { installed: false, enabled: false, disabled: false },
])(
  'Codex installation $installed, enabled $enabled sets disabled $disabled',
  async ({ installed, enabled, disabled }) => {
    jest.mocked(listCodexPlugins).mockResolvedValue({
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
      marketplaces: [
        {
          name: 'Display',
          path: null,
          interface: null,
          plugins: [
            {
              id: 'Plugin@Display',
              name: 'Plugin',
              installed,
              enabled,
              remotePluginId: null,
              version: null,
              localVersion: null,
              shareContext: null,
              source: { type: 'remote' },
              installedAt: null,
              installPolicy: 'AVAILABLE',
              installPolicySource: null,
              mustShowInstallationInterstitial: null,
              authPolicy: 'ON_USE',
              availability: 'AVAILABLE',
              disabledReason: null,
              eligiblePlanTypes: null,
              interface: null,
              keywords: [],
            },
          ],
        },
      ],
    });
    const policy = await readInstalledItemPolicy({});
    expect(
      policy.isDisabled({
        kind: 'plugin',
        marketplaceId: 'canonical',
        pluginName: 'PLUGIN',
      }),
    ).toBe(disabled);
    expect(policy.hasDisabledKind('plugin')).toBe(disabled);
    if (disabled)
      expect(policy.disabledPluginRefs).toContainEqual({
        marketplaceId: 'canonical',
        pluginName: 'plugin',
      });
  },
);
test('an unavailable Codex state fails the loading policy closed', async () => {
  jest.mocked(listCodexPlugins).mockRejectedValue(new Error('Codex offline'));
  await expect(readInstalledItemPolicy({})).rejects.toThrow('Codex offline');
});
test('external Claude disable suppresses explicit refs under catalog aliases', async () => {
  jest
    .mocked(readClaudeDisabledInstalledPlugins)
    .mockReturnValue(['Plugin@provider-name']);
  const policy = await readInstalledItemPolicy({});
  expect(
    policy.isDisabled({
      kind: 'plugin',
      marketplaceId: 'canonical',
      pluginName: 'PLUGIN',
    }),
  ).toBe(true);
  expect(
    policy.isDisabled({
      kind: 'plugin',
      marketplaceId: 'Display',
      pluginName: 'plugin',
    }),
  ).toBe(true);
  expect(
    policy.isDisabled({
      kind: 'plugin',
      marketplaceId: 'unrelated',
      pluginName: 'plugin',
    }),
  ).toBe(false);
});
test('incomplete uninstall remains excluded without pruning saved selections prematurely', async () => {
  const ref = { kind: 'skill', sourceId: 'source', skillName: 'Name' } as const;
  const policy = await readInstalledItemPolicy({
    pendingInstalledItemUninstalls: [{ target: ref, refs: [ref] }],
  });
  expect(policy.isDisabled(ref)).toBe(true);
  expect(policy.isDisabled({ ...ref, skillName: 'name' })).toBe(false);
});
test('disabled collection membership does not disable independently selected members', async () => {
  const policy = await readInstalledItemPolicy({
    disabledInstalledItems: [
      installedItemKey({ kind: 'collection', collectionId: 'id' }),
    ],
  });
  expect(policy.isDisabled({ kind: 'collection', collectionId: 'id' })).toBe(
    true,
  );
  expect(
    policy.isDisabled({
      kind: 'plugin',
      marketplaceId: 'canonical',
      pluginName: 'member',
    }),
  ).toBe(false);
});
