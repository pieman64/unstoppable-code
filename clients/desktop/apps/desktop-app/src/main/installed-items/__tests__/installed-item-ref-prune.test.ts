import { pruneInstalledItemRefs } from '../installed-item-ref-prune';
import { installedItemKey } from '@canopy/protocol/installed-items';

test('prunes plugin selections, tombstones, helpers and collection memberships without editing transcript content', () => {
  const ref = {
    kind: 'plugin',
    marketplaceId: 'market',
    pluginName: 'plugin',
  } as const;
  const selection = {
    pluginRefs: [
      { marketplaceId: 'market', pluginName: 'Plugin' },
      { marketplaceId: 'other', pluginName: 'plugin' },
    ],
  };
  const data = {
    globalPluginSelections: structuredClone(selection),
    appAdvisorPluginSelections: structuredClone(selection),
    disabledGlobalPluginSelections: structuredClone(selection),
    plugins: [{ marketplaceId: 'market', pluginName: 'plugin' }],
    disabledInstalledItems: [installedItemKey(ref)],
    parkedCodexPlugins: [
      { key: installedItemKey(ref), pluginId: 'provider-id' },
    ],
    codexCompatDisabledPlugins: ['market/plugin', 'other/plugin'],
    messages: [{ pluginRefs: selection.pluginRefs }],
  };
  expect(pruneInstalledItemRefs(data, ref)).toBe(true);
  expect(data.globalPluginSelections.pluginRefs).toEqual([
    { marketplaceId: 'other', pluginName: 'plugin' },
  ]);
  expect(data.appAdvisorPluginSelections).toEqual(data.globalPluginSelections);
  expect(data.disabledGlobalPluginSelections).toEqual(
    data.globalPluginSelections,
  );
  expect(data.plugins).toEqual([]);
  expect(data.disabledInstalledItems).toEqual([]);
  expect(data.parkedCodexPlugins).toEqual([]);
  expect(data.codexCompatDisabledPlugins).toEqual(['other/plugin']);
  expect(data.messages[0].pluginRefs).toHaveLength(2);
});
test('removing a collection keeps its members installed and selected independently', () => {
  const data = {
    collectionIds: ['removed', 'kept'],
    skillRefs: [{ sourceId: 's', skillName: 'member' }],
    pluginRefs: [{ marketplaceId: 'm', pluginName: 'member' }],
  };
  expect(
    pruneInstalledItemRefs(data, {
      kind: 'collection',
      collectionId: 'removed',
    }),
  ).toBe(true);
  expect(data.collectionIds).toEqual(['kept']);
  expect(data.skillRefs).toHaveLength(1);
  expect(data.pluginRefs).toHaveLength(1);
});
test('account removal prunes legacy refs without touching sibling device refs', () => {
  const data = {
    mcpServerRefs: [
      { serverId: 'account:id', configId: 'one' },
      { serverId: 'device', configId: 'one' },
    ],
  };
  pruneInstalledItemRefs(data, { kind: 'account-mcp', connectionId: 'id' });
  expect(data.mcpServerRefs).toEqual([{ serverId: 'device', configId: 'one' }]);
});
