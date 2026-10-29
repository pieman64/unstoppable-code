import type {
  ChatTabPluginSelections,
  PluginSelectionTombstones,
} from '../../types';
import {
  accountMcpConnectionForRef,
  chatSurfaceUsesGlobalPluginDefaults,
  effectiveChatPluginSelections,
  effectiveGlobalPluginSelections,
  effectivePluginSelections,
  hasAnyTombstones,
  inheritedPluginSelections,
  hasLegacyAccountMcpRefs,
  INHERITED_PLUGIN_DEFAULTS_VERSION,
  newChatPluginDefaultsStamp,
  normalizeAccountMcpSelectionRefs,
  normalizeAccountMcpTombstoneRefs,
  normalizePluginSelectionTombstones,
  splitChosenChatPluginSelections,
  splitChosenSelectionsAgainstGlobal,
  subtractPluginSelectionTombstones,
  unionPluginSelections,
} from '../effective-plugin-selections';
import {
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
} from '../../types';

function selections(
  overrides: Partial<ChatTabPluginSelections> = {},
): ChatTabPluginSelections {
  return {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    ...overrides,
  };
}

const skillA = { sourceId: 'src-a', skillName: 'alpha' };
const skillB = { sourceId: 'src-b', skillName: 'beta' };
const pluginA = { marketplaceId: 'mkt', pluginName: 'plug-a' };
const pluginB = { marketplaceId: 'mkt', pluginName: 'plug-b' };
const serverA = { serverId: 'srv-a', configId: 'cfg-a' };

describe('subtractPluginSelectionTombstones', () => {
  it('removes tombstoned entries only', () => {
    const result = subtractPluginSelectionTombstones(
      selections({
        collectionIds: ['col-1', 'col-2'],
        skillRefs: [skillA, skillB],
        pluginRefs: [pluginA],
        mcpServerRefs: [serverA],
      }),
      { collectionIds: ['col-2'], skillRefs: [skillA] },
    );
    expect(result.collectionIds).toEqual(['col-1']);
    expect(result.skillRefs).toEqual([skillB]);
    expect(result.pluginRefs).toEqual([pluginA]);
    expect(result.mcpServerRefs).toEqual([serverA]);
  });

  it('returns the input unchanged for empty tombstones', () => {
    const input = selections({ collectionIds: ['col-1'] });
    expect(subtractPluginSelectionTombstones(input, undefined)).toBe(input);
    expect(subtractPluginSelectionTombstones(input, {})).toBe(input);
  });

  it('preserves auth preferences even when their server is tombstoned', () => {
    const authPreference = {
      target: {
        kind: 'standalone',
        serverId: serverA.serverId,
        configId: serverA.configId,
      },
      handler: 'canopy',
    } as const;
    const result = subtractPluginSelectionTombstones(
      selections({
        mcpServerRefs: [serverA],
        mcpHttpAuthPreferences: [authPreference],
      }),
      { mcpServerRefs: [serverA] },
    );
    expect(result.mcpServerRefs).toEqual([]);
    expect(result.mcpHttpAuthPreferences).toEqual([authPreference]);
  });
});

describe('effectivePluginSelections', () => {
  it('unions the global overlay with local selections', () => {
    const result = effectivePluginSelections(
      selections({ pluginRefs: [pluginB] }),
      selections({ pluginRefs: [pluginA], collectionIds: ['col-g'] }),
    );
    expect(result.pluginRefs).toEqual([pluginA, pluginB]);
    expect(result.collectionIds).toEqual(['col-g']);
  });

  it('applies tombstone layers in order before the union', () => {
    const global = selections({
      pluginRefs: [pluginA, pluginB],
      skillRefs: [skillA],
    });
    const workspaceTombstones: PluginSelectionTombstones = {
      pluginRefs: [pluginA],
    };
    const chatTombstones: PluginSelectionTombstones = { skillRefs: [skillA] };
    const result = effectivePluginSelections(selections(), global, [
      workspaceTombstones,
      chatTombstones,
    ]);
    expect(result.pluginRefs).toEqual([pluginB]);
    expect(result.skillRefs).toEqual([]);
  });

  it('keeps a locally selected entry even when it is tombstoned', () => {
    // Tombstones suppress the overlay, never local selections.
    const result = effectivePluginSelections(
      selections({ pluginRefs: [pluginA] }),
      selections({ pluginRefs: [pluginA] }),
      [{ pluginRefs: [pluginA] }],
    );
    expect(result.pluginRefs).toEqual([pluginA]);
  });

  it('returns local selections untouched without a global layer', () => {
    const local = selections({ pluginRefs: [pluginA] });
    expect(effectivePluginSelections(local, undefined)).toBe(local);
  });

  it('prefers the local auth handler on collision', () => {
    const target = {
      kind: 'standalone',
      serverId: 's',
      configId: 'c',
    } as const;
    const result = effectivePluginSelections(
      selections({
        mcpHttpAuthPreferences: [{ target, handler: 'provider' }],
      }),
      selections({
        mcpHttpAuthPreferences: [{ target, handler: 'canopy' }],
      }),
    );
    expect(result.mcpHttpAuthPreferences).toEqual([
      { target, handler: 'provider' },
    ]);
  });
});

describe('splitChosenSelectionsAgainstGlobal', () => {
  const global = selections({
    pluginRefs: [pluginA],
    collectionIds: ['col-g'],
  });

  it('records unchecked overlay entries as tombstones', () => {
    const { localSelections, tombstones } = splitChosenSelectionsAgainstGlobal(
      selections({ pluginRefs: [pluginB], collectionIds: ['col-g'] }),
      global,
    );
    expect(localSelections.pluginRefs).toEqual([pluginB]);
    expect(localSelections.collectionIds).toEqual([]);
    expect(tombstones).toEqual({ pluginRefs: [pluginA] });
  });

  it('produces no tombstones when everything global stays chosen', () => {
    const { localSelections, tombstones } = splitChosenSelectionsAgainstGlobal(
      selections({ pluginRefs: [pluginA, pluginB], collectionIds: ['col-g'] }),
      global,
    );
    expect(localSelections.pluginRefs).toEqual([pluginB]);
    expect(hasAnyTombstones(tombstones)).toBe(false);
  });

  it('does not re-tombstone entries suppressed by a parent layer', () => {
    const { tombstones } = splitChosenSelectionsAgainstGlobal(
      selections(),
      global,
      [{ pluginRefs: [pluginA] }],
    );
    expect(tombstones).toEqual({ collectionIds: ['col-g'] });
  });

  it('keeps chosen auth preferences local', () => {
    const authPreference = {
      target: {
        kind: 'standalone',
        serverId: 's',
        configId: 'c',
      },
      handler: 'provider',
    } as const;
    const { localSelections } = splitChosenSelectionsAgainstGlobal(
      selections({ mcpHttpAuthPreferences: [authPreference] }),
      global,
    );
    expect(localSelections.mcpHttpAuthPreferences).toEqual([authPreference]);
  });

  it('round-trips: effective(split(chosen)) === chosen', () => {
    const chosen = selections({
      pluginRefs: [pluginB, pluginA],
      skillRefs: [skillA],
    });
    const { localSelections, tombstones } = splitChosenSelectionsAgainstGlobal(
      chosen,
      global,
    );
    const effective = effectivePluginSelections(localSelections, global, [
      tombstones,
    ]);
    expect(new Set(effective.pluginRefs.map((r) => r.pluginName))).toEqual(
      new Set(['plug-a', 'plug-b']),
    );
    expect(effective.skillRefs).toEqual([skillA]);
    expect(effective.collectionIds).toEqual([]);
  });
});

describe('inherited project and global layers', () => {
  const projectDefaults = selections({ mcpServerRefs: [serverA] });
  const global = selections({ pluginRefs: [pluginA, pluginB] });

  it('unions project defaults with the surviving global layer', () => {
    const inherited = inheritedPluginSelections({
      projectDefaults,
      global,
      projectTombstones: { pluginRefs: [pluginB] },
    });
    expect(inherited?.pluginRefs).toEqual([pluginA]);
    expect(inherited?.mcpServerRefs).toEqual([serverA]);
  });

  it('returns undefined without either layer', () => {
    expect(inheritedPluginSelections({})).toBeUndefined();
  });

  it('keeps a project default the workspace tombstoned globally', () => {
    const inherited = inheritedPluginSelections({
      projectDefaults: selections({ pluginRefs: [pluginA] }),
      global,
      projectTombstones: { pluginRefs: [pluginA] },
    });
    expect(inherited?.pluginRefs).toEqual([pluginB, pluginA]);
  });

  it('lets the project auth handler win over the global one', () => {
    const target = {
      kind: 'standalone',
      serverId: 's',
      configId: 'c',
    } as const;
    const inherited = inheritedPluginSelections({
      projectDefaults: selections({
        mcpHttpAuthPreferences: [{ target, handler: 'canopy' }],
      }),
      global: selections({
        mcpHttpAuthPreferences: [{ target, handler: 'provider' }],
      }),
    });
    expect(inherited?.mcpHttpAuthPreferences).toEqual([
      { target, handler: 'canopy' },
    ]);
  });

  it('applies chat tombstones to project defaults and global defaults alike', () => {
    const effective = effectiveChatPluginSelections({
      local: selections({ skillRefs: [skillA] }),
      projectDefaults,
      global,
      chatTombstones: { mcpServerRefs: [serverA], pluginRefs: [pluginB] },
    });
    expect(effective.pluginRefs).toEqual([pluginA]);
    expect(effective.mcpServerRefs).toEqual([]);
    expect(effective.skillRefs).toEqual([skillA]);
  });

  it('keeps a local selection even when the chat tombstoned it', () => {
    const effective = effectiveChatPluginSelections({
      local: selections({ mcpServerRefs: [serverA] }),
      projectDefaults,
      chatTombstones: { mcpServerRefs: [serverA] },
    });
    expect(effective.mcpServerRefs).toEqual([serverA]);
  });

  it('treats a missing local selection as empty', () => {
    const effective = effectiveChatPluginSelections({
      local: undefined,
      projectDefaults,
    });
    expect(effective.mcpServerRefs).toEqual([serverA]);
    expect(effective.pluginRefs).toEqual([]);
  });

  it('splits a picker save into chat tombstones and local additions', () => {
    const { localSelections, tombstones } = splitChosenChatPluginSelections({
      chosen: selections({ pluginRefs: [pluginA], skillRefs: [skillA] }),
      projectDefaults,
      global,
    });
    expect(localSelections.skillRefs).toEqual([skillA]);
    expect(localSelections.pluginRefs).toEqual([]);
    expect(localSelections.mcpServerRefs).toEqual([]);
    expect(tombstones).toEqual({
      pluginRefs: [pluginB],
      mcpServerRefs: [serverA],
    });
  });

  it('keeps a previously-local entry local after it becomes a project default', () => {
    const { localSelections, tombstones } = splitChosenChatPluginSelections({
      chosen: selections({ mcpServerRefs: [serverA] }),
      projectDefaults,
      previousLocal: selections({ mcpServerRefs: [serverA] }),
    });
    expect(localSelections.mcpServerRefs).toEqual([serverA]);
    expect(hasAnyTombstones(tombstones)).toBe(false);
  });

  it('keeps an earlier turn-off while the default is absent, unless re-chosen', () => {
    const kept = splitChosenChatPluginSelections({
      chosen: selections({ skillRefs: [skillA] }),
      projectDefaults: selections(),
      previousTombstones: { mcpServerRefs: [serverA], pluginRefs: [pluginA] },
    });
    expect(kept.tombstones).toEqual({
      pluginRefs: [pluginA],
      mcpServerRefs: [serverA],
    });
    const rechosen = splitChosenChatPluginSelections({
      chosen: selections({ pluginRefs: [pluginA] }),
      projectDefaults: selections(),
      previousTombstones: { pluginRefs: [pluginA] },
    });
    expect(hasAnyTombstones(rechosen.tombstones)).toBe(false);
    expect(rechosen.localSelections.pluginRefs).toEqual([pluginA]);
  });

  it('recomputes tombstones for entries that are inherited right now', () => {
    const { tombstones } = splitChosenChatPluginSelections({
      chosen: selections({ mcpServerRefs: [serverA] }),
      projectDefaults,
      previousTombstones: { mcpServerRefs: [serverA] },
    });
    expect(hasAnyTombstones(tombstones)).toBe(false);
  });

  it('round-trips a save through the effective set', () => {
    const chosen = selections({ pluginRefs: [pluginB], skillRefs: [skillB] });
    const layers = { projectDefaults, global };
    const { localSelections, tombstones } = splitChosenChatPluginSelections({
      ...layers,
      chosen,
    });
    const effective = effectiveChatPluginSelections({
      ...layers,
      local: localSelections,
      chatTombstones: tombstones,
    });
    expect(effective.pluginRefs).toEqual([pluginB]);
    expect(effective.skillRefs).toEqual([skillB]);
    expect(effective.mcpServerRefs).toEqual([]);
  });
});

describe('chatSurfaceUsesGlobalPluginDefaults', () => {
  it('includes ordinary project and cowork ids', () => {
    expect(chatSurfaceUsesGlobalPluginDefaults('my-workspace')).toBe(true);
    expect(chatSurfaceUsesGlobalPluginDefaults('cowork-abc123')).toBe(true);
  });

  it('excludes every purpose-built chat surface', () => {
    for (const excluded of [
      APP_ADVISOR_PROJECT_ID,
      PLAN_EXPLORE_CHAT_PROJECT_ID,
      CODE_REVIEW_CHAT_PROJECT_ID,
      PIPELINE_EDITOR_PROJECT_ID,
    ]) {
      expect(chatSurfaceUsesGlobalPluginDefaults(excluded)).toBe(false);
    }
  });

  it('stamps new chats only on the surfaces that inherit project defaults', () => {
    expect(newChatPluginDefaultsStamp('my-workspace')).toEqual({
      inheritedPluginDefaultsVersion: INHERITED_PLUGIN_DEFAULTS_VERSION,
    });
    expect(newChatPluginDefaultsStamp(APP_ADVISOR_PROJECT_ID)).toEqual({});
  });
});

describe('splitChosenSelectionsAgainstGlobal with previous local selections', () => {
  const global = selections({ pluginRefs: [pluginA] });

  it('keeps a previously-local entry local even when it is a global default', () => {
    const { localSelections, tombstones } = splitChosenSelectionsAgainstGlobal(
      selections({ pluginRefs: [pluginA, pluginB] }),
      global,
      [],
      selections({ pluginRefs: [pluginA] }),
    );
    expect(localSelections.pluginRefs).toEqual([pluginA, pluginB]);
    expect(hasAnyTombstones(tombstones)).toBe(false);
  });

  it('still tombstones a previously-local entry the user unchecks', () => {
    const { localSelections, tombstones } = splitChosenSelectionsAgainstGlobal(
      selections(),
      global,
      [],
      selections({ pluginRefs: [pluginA] }),
    );
    expect(localSelections.pluginRefs).toEqual([]);
    expect(tombstones).toEqual({ pluginRefs: [pluginA] });
  });

  it('absorbs a never-local overlay entry as before', () => {
    const { localSelections } = splitChosenSelectionsAgainstGlobal(
      selections({ pluginRefs: [pluginA] }),
      global,
      [],
      selections({ pluginRefs: [pluginB] }),
    );
    expect(localSelections.pluginRefs).toEqual([]);
  });
});

describe('effectiveGlobalPluginSelections', () => {
  it('subtracts every layer', () => {
    const result = effectiveGlobalPluginSelections(
      selections({ collectionIds: ['a', 'b', 'c'] }),
      [{ collectionIds: ['a'] }, undefined, { collectionIds: ['c'] }],
    );
    expect(result.collectionIds).toEqual(['b']);
  });
});

describe('normalizePluginSelectionTombstones', () => {
  it('drops malformed entries and empty arrays', () => {
    const result = normalizePluginSelectionTombstones({
      collectionIds: ['ok', '', 42, 'ok'],
      skillRefs: [
        { sourceId: 'src', skillName: 'name' },
        { sourceId: '', skillName: 'x' },
        'junk',
      ],
      pluginRefs: [],
      unrelated: true,
    });
    expect(result).toEqual({
      collectionIds: ['ok'],
      skillRefs: [{ sourceId: 'src', skillName: 'name' }],
    });
  });

  it('returns undefined for non-objects and empty results', () => {
    expect(normalizePluginSelectionTombstones(null)).toBeUndefined();
    expect(normalizePluginSelectionTombstones([])).toBeUndefined();
    expect(normalizePluginSelectionTombstones({})).toBeUndefined();
    expect(
      normalizePluginSelectionTombstones({ collectionIds: [] }),
    ).toBeUndefined();
  });
});

describe('unionPluginSelections (moved implementation)', () => {
  it('dedupes by identity with a-first ordering', () => {
    const result = unionPluginSelections(
      selections({ pluginRefs: [pluginA] }),
      selections({ pluginRefs: [pluginA, pluginB] }),
    );
    expect(result.pluginRefs).toEqual([pluginA, pluginB]);
  });
});

describe('account MCP selection refs', () => {
  const connections = [
    {
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      serverKey: 'github',
      configId: 'default',
      kind: 'CURATED' as const,
    },
    {
      id: 'cccccccc-dddd-4eee-8fff-000000000000',
      serverKey: 'custom:11111111-2222-4333-8444-555555555555',
      configId: 'default',
      kind: 'CUSTOM' as const,
    },
  ];

  it('maps legacy connection-id refs to the server key shape and drops unknown ones', () => {
    const result = normalizeAccountMcpSelectionRefs(
      selections({
        mcpServerRefs: [
          {
            serverId: 'account:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            configId: 'default',
          },
          {
            serverId: 'account:cccccccc-dddd-4eee-8fff-000000000000',
            configId: 'default',
          },
          { serverId: 'account:gone', configId: 'default' },
          { serverId: 'device-server', configId: 'default' },
          { serverId: 'github', configId: 'default' },
        ],
      }),
      connections,
    );
    expect(result.selections.mcpServerRefs).toEqual([
      { serverId: 'github', configId: 'default' },
      {
        serverId: 'custom:11111111-2222-4333-8444-555555555555',
        configId: 'default',
      },
      { serverId: 'device-server', configId: 'default' },
    ]);
    expect(result.dropped).toEqual([
      { serverId: 'account:gone', configId: 'default' },
    ]);
  });

  it('returns the same selections when no legacy ref is present', () => {
    const input = selections({
      mcpServerRefs: [{ serverId: 'github', configId: 'default' }],
    });
    expect(hasLegacyAccountMcpRefs(input)).toBe(false);
    expect(normalizeAccountMcpSelectionRefs(input, connections)).toEqual({
      selections: input,
      dropped: [],
    });
  });

  it('maps legacy tombstones so they still suppress the global default', () => {
    const tombstones = normalizeAccountMcpTombstoneRefs(
      {
        mcpServerRefs: [
          {
            serverId: 'account:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            configId: 'default',
          },
        ],
      },
      connections,
    );
    expect(tombstones).toEqual({
      mcpServerRefs: [{ serverId: 'github', configId: 'default' }],
    });
    expect(
      subtractPluginSelectionTombstones(
        selections({
          mcpServerRefs: [{ serverId: 'github', configId: 'default' }],
        }),
        tombstones,
      ).mcpServerRefs,
    ).toEqual([]);
  });

  it('matches a ref to its connection by server key, config and kind', () => {
    expect(
      accountMcpConnectionForRef(
        { serverId: 'github', configId: 'default' },
        connections,
      )?.id,
    ).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    expect(
      accountMcpConnectionForRef(
        { serverId: 'github', configId: 'work' },
        connections,
      ),
    ).toBeUndefined();
    expect(
      accountMcpConnectionForRef(
        {
          serverId: 'custom:11111111-2222-4333-8444-555555555555',
          configId: 'default',
        },
        connections,
      )?.id,
    ).toBe('cccccccc-dddd-4eee-8fff-000000000000');
    expect(
      accountMcpConnectionForRef(
        {
          serverId: 'account:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          configId: 'default',
        },
        connections,
      )?.serverKey,
    ).toBe('github');
  });
});

it('retains unresolved capability identity while merging inherited desktop selections', () => {
  const unresolvedCapabilities = [
    {
      kind: 'skill' as const,
      sourceId: 'shared:source-id',
      catalogId: 'writer',
      name: 'Writer',
    },
  ];
  const chosen = selections({ unresolvedCapabilities });
  const merged = unionPluginSelections(selections(), chosen);
  expect(merged.unresolvedCapabilities).toEqual(unresolvedCapabilities);
  expect(unionPluginSelections(merged, chosen).unresolvedCapabilities).toEqual(
    unresolvedCapabilities,
  );
});
