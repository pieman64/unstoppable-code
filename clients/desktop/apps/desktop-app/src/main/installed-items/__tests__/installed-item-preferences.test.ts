import { installedItemKey } from '@canopy/protocol/installed-items';
import { normalizePreferences } from '../../lib/preferences-store';

test('legacy preferences default safely without provider reads', () => {
  const preferences = normalizePreferences({}, 'persisted');
  expect(preferences.disabledInstalledItems).toEqual([]);
  expect(preferences.parkedCodexPlugins).toEqual([]);
  expect(preferences.pendingInstalledItemUninstalls).toEqual([]);
});
test('normalization protects every global-selection writer from reactivating Disabled items', () => {
  const plugin = { marketplaceId: 'market/%', pluginName: 'PLUGIN' };
  const skill = { sourceId: 'Source', skillName: 'Skill' };
  const disabled = [
    installedItemKey({ kind: 'plugin', ...plugin }),
    installedItemKey({ kind: 'skill', ...skill }),
    installedItemKey({ kind: 'collection', collectionId: 'collection' }),
  ];
  const preferences = normalizePreferences(
    {
      disabledInstalledItems: disabled,
      globalPluginSelections: {
        collectionIds: ['collection', 'keep'],
        pluginRefs: [plugin],
        skillRefs: [skill, { ...skill, skillName: 'skill' }],
      },
    },
    'persisted',
  );
  expect(preferences.globalPluginSelections).toMatchObject({
    collectionIds: ['keep'],
    pluginRefs: [],
    skillRefs: [{ sourceId: 'Source', skillName: 'skill' }],
  });
  expect(preferences.disabledInstalledItems).toEqual(disabled);
});
test('malformed recovery values and a second MCP disable store are rejected', () => {
  const preferences = normalizePreferences(
    {
      disabledInstalledItems: [
        'bad',
        installedItemKey({
          kind: 'mcp-config',
          serverId: 'id',
          configId: 'config',
        }),
      ],
      parkedCodexPlugins: [{ key: 'bad', state: 'parked' }],
      pendingInstalledItemUninstalls: [
        {
          target: { kind: 'mcp-config', serverId: 'id', configId: 'config' },
          refs: [],
        },
      ],
    },
    'persisted',
  );
  expect(preferences.disabledInstalledItems).toEqual([]);
  expect(preferences.parkedCodexPlugins).toEqual([]);
  expect(preferences.pendingInstalledItemUninstalls).toEqual([]);
});
