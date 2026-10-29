import {
  aggregateInstalledItemStatus,
  countActiveInstalledItems,
  installedItemTargetForEntry,
  type InstalledItemSnapshot,
  canonicalInstalledItemRef,
  excludeDisabledInstalledItems,
  InstalledItemRefSchema,
  InstalledItemUninstallTargetSchema,
  installedItemKey,
  normalizeDisabledInstalledItems,
  parseInstalledItemKey,
} from '..';

describe('installed item identity', () => {
  test('summary counts canonical plugins and aggregate MCP servers once', () => {
    const targets = [
      { kind: 'plugin', marketplaceId: 'm', pluginName: 'NAME' },
      { kind: 'plugin', marketplaceId: 'm', pluginName: 'name' },
      { kind: 'mcp-server', serverId: 'device' },
      { kind: 'mcp-config', serverId: 'device', configId: 'one' },
      { kind: 'mcp-config', serverId: 'device', configId: 'two' },
      { kind: 'account-mcp', connectionId: 'account' },
    ] as const;
    const snapshot: InstalledItemSnapshot = {
      items: targets.map((target) => ({
        target,
        status: 'active',
        removable: true,
        notices: [],
      })),
    };
    expect(countActiveInstalledItems(snapshot)).toEqual({
      plugins: 1,
      skills: 0,
      collections: 0,
      mcpServers: 2,
    });
    expect(countActiveInstalledItems({ items: [] })).toEqual({
      plugins: 0,
      skills: 0,
      collections: 0,
      mcpServers: 0,
    });
  });
  test('entry conversion requires a real installed target and honors account selection identities', () => {
    const snapshot: InstalledItemSnapshot = {
      items: [
        {
          target: { kind: 'account-mcp', connectionId: 'connection' },
          selectionRef: { serverId: 'provider', configId: 'config' },
          status: 'available',
          removable: true,
          notices: [],
        },
      ],
    };
    expect(
      installedItemTargetForEntry(
        { type: 'local-mcp', serverId: 'provider', configId: 'config' },
        snapshot,
      ),
    ).toEqual({ target: { kind: 'account-mcp', connectionId: 'connection' } });
    const unresolved = installedItemTargetForEntry(
      {
        type: 'marketplace-plugin',
        marketplaceId: 'missing',
        pluginName: 'plugin',
      },
      snapshot,
    );
    expect('reason' in unresolved && unresolved.reason.length > 0).toBe(true);
  });
  test('round trips separators, percent signs, case and Unicode without collisions', () => {
    const refs = [
      { kind: 'plugin', marketplaceId: 'One/two:%', pluginName: 'TeSt/%:a' },
      { kind: 'plugin', marketplaceId: 'One', pluginName: 'two:%/test/%:a' },
      { kind: 'skill', sourceId: 'MiXeD/%', skillName: 'NaMe:💚' },
      { kind: 'collection', collectionId: 'A/%:B' },
      { kind: 'mcp-config', serverId: 'A/%', configId: 'B:%' },
      { kind: 'account-mcp', connectionId: 'Account/%' },
    ] as const;
    expect(new Set(refs.map(installedItemKey)).size).toBe(refs.length);
    for (const ref of refs)
      expect(parseInstalledItemKey(installedItemKey(ref))).toEqual(
        ref.kind === 'plugin'
          ? { ...ref, pluginName: ref.pluginName.toLowerCase() }
          : ref,
      );
  });
  test.each([
    'plugin:a/b',
    '%',
    '[]',
    '["v1","collection","x","extra"]',
    '["v1","plugin","m","UPPER"]',
  ])('rejects malformed or noncanonical key %s', (key) => {
    expect(parseInstalledItemKey(key)).toBeNull();
  });
  test('strict schemas prohibit paths and config-scoped uninstall', () => {
    expect(
      InstalledItemRefSchema.safeParse({
        kind: 'plugin',
        marketplaceId: 'a',
        pluginName: 'b',
        path: '/tmp',
      }).success,
    ).toBe(false);
    expect(
      InstalledItemUninstallTargetSchema.safeParse({
        kind: 'mcp-config',
        serverId: 's',
        configId: 'c',
      }).success,
    ).toBe(false);
  });
  test('MCP never enters a second disabled store', () => {
    const skill = installedItemKey({
      kind: 'skill',
      sourceId: 'S',
      skillName: 'A',
    });
    expect(
      normalizeDisabledInstalledItems([
        skill,
        skill,
        null,
        'bad',
        installedItemKey({ kind: 'mcp-config', serverId: 's', configId: 'c' }),
      ]),
    ).toEqual([skill]);
  });
  test('canonicalizes unambiguous known aliases only', () => {
    const marketplaces = [
      { id: 'real', name: 'Alias' },
      { id: 'other', name: 'Shared' },
      { id: 'third', name: 'Shared' },
    ];
    expect(
      canonicalInstalledItemRef(
        { kind: 'plugin', marketplaceId: 'Alias', pluginName: 'NAME' },
        marketplaces,
      ),
    ).toEqual({ kind: 'plugin', marketplaceId: 'real', pluginName: 'name' });
    expect(
      canonicalInstalledItemRef(
        { kind: 'plugin', marketplaceId: 'Shared', pluginName: 'NAME' },
        marketplaces,
      ),
    ).toEqual({ kind: 'plugin', marketplaceId: 'Shared', pluginName: 'name' });
  });
  test('empty aggregate has no status; active precedes available and disabled', () => {
    expect(aggregateInstalledItemStatus([])).toBeNull();
    expect(
      aggregateInstalledItemStatus(['disabled', 'active', 'available']),
    ).toBe('active');
    expect(aggregateInstalledItemStatus(['disabled', 'available'])).toBe(
      'available',
    );
    expect(aggregateInstalledItemStatus(['disabled'])).toBe('disabled');
  });
  test('Disabled removes global defaults while preserving unrelated identity and fields', () => {
    const selections = {
      collectionIds: ['c'],
      pluginRefs: [{ marketplaceId: 'm', pluginName: 'NAME' }],
      skillRefs: [
        { sourceId: 's', skillName: 'Name' },
        { sourceId: 's', skillName: 'name' },
      ],
      extra: true,
    };
    expect(
      excludeDisabledInstalledItems(selections, [
        installedItemKey({ kind: 'collection', collectionId: 'c' }),
        installedItemKey({
          kind: 'plugin',
          marketplaceId: 'm',
          pluginName: 'name',
        }),
        installedItemKey({ kind: 'skill', sourceId: 's', skillName: 'Name' }),
      ]),
    ).toEqual({
      collectionIds: [],
      pluginRefs: [],
      skillRefs: [{ sourceId: 's', skillName: 'name' }],
      extra: true,
    });
  });
});
