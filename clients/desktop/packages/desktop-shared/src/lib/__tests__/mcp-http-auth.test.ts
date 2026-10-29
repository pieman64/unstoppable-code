import {
  getMcpHttpAuthHandler,
  mcpHttpAuthTargetKey,
  setMcpHttpAuthPreference,
} from '../mcp-http-auth';
import type { ChatTabPluginSelections } from '../../types';
import type {
  McpHttpAuthTarget,
  McpPluginHttpAuthTarget,
  McpStandaloneHttpAuthTarget,
} from '../../types/mcp-servers';

const standalone: McpStandaloneHttpAuthTarget = {
  kind: 'standalone',
  serverId: 'srv-1',
  configId: 'cfg-1',
};

const otherStandalone: McpStandaloneHttpAuthTarget = {
  kind: 'standalone',
  serverId: 'srv-2',
  configId: 'cfg-2',
};

const plugin: McpPluginHttpAuthTarget = {
  kind: 'plugin',
  marketplaceId: 'mkt',
  pluginName: 'plug',
  serverName: 'srv',
};

function emptySelections(): ChatTabPluginSelections {
  return {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
  };
}

function fullSelections(): ChatTabPluginSelections {
  return {
    collectionIds: ['collection-a'],
    skillRefs: [{ sourceId: 'src-a', skillName: 'skill-a' }],
    pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'plug' }],
    mcpServerRefs: [{ serverId: 'srv-1', configId: 'cfg-1' }],
  };
}

describe('mcpHttpAuthTargetKey', (): void => {
  it('produces a stable standalone key', (): void => {
    expect(mcpHttpAuthTargetKey(standalone)).toBe(
      '["standalone","srv-1","cfg-1"]',
    );
  });

  it('produces a stable plugin key', (): void => {
    expect(mcpHttpAuthTargetKey(plugin)).toBe('["plugin","mkt","plug","srv"]');
  });

  it('discriminates standalone vs plugin with the same trailing tokens', (): void => {
    const collidingPlugin: McpPluginHttpAuthTarget = {
      kind: 'plugin',
      marketplaceId: 'standalone',
      pluginName: 'srv-1',
      serverName: 'cfg-1',
    };
    expect(mcpHttpAuthTargetKey(standalone)).not.toBe(
      mcpHttpAuthTargetKey(collidingPlugin),
    );
  });
});

describe('getMcpHttpAuthHandler', (): void => {
  it('returns the default for empty selections', (): void => {
    expect(
      getMcpHttpAuthHandler(emptySelections(), standalone, 'canopy'),
    ).toEqual({ handler: 'canopy', source: 'default' });
  });

  it('returns the default when no override matches', (): void => {
    const selections: ChatTabPluginSelections = {
      ...emptySelections(),
      mcpHttpAuthPreferences: [
        { target: otherStandalone, handler: 'provider' },
      ],
    };
    expect(getMcpHttpAuthHandler(selections, standalone, 'canopy')).toEqual({
      handler: 'canopy',
      source: 'default',
    });
  });

  it('returns the override when a matching preference is set', (): void => {
    const selections: ChatTabPluginSelections = {
      ...emptySelections(),
      mcpHttpAuthPreferences: [{ target: standalone, handler: 'provider' }],
    };
    expect(getMcpHttpAuthHandler(selections, standalone, 'canopy')).toEqual({
      handler: 'provider',
      source: 'override',
    });
  });

  it('honours the supplied default when no override is present', (): void => {
    expect(
      getMcpHttpAuthHandler(emptySelections(), standalone, 'provider'),
    ).toEqual({ handler: 'provider', source: 'default' });
  });

  it('ignores corrupted handler values and falls back to default', (): void => {
    const selections: ChatTabPluginSelections = {
      ...emptySelections(),
      mcpHttpAuthPreferences: [
        {
          target: standalone,
          handler: 'canopy',
        },
      ],
    };
    for (const preference of selections.mcpHttpAuthPreferences ?? []) {
      Reflect.set(preference, 'handler', 'garbage');
    }
    expect(getMcpHttpAuthHandler(selections, standalone, 'canopy')).toEqual({
      handler: 'canopy',
      source: 'default',
    });
  });

  it('matches plugin targets independently from standalone targets', (): void => {
    const selections: ChatTabPluginSelections = {
      ...emptySelections(),
      mcpHttpAuthPreferences: [{ target: plugin, handler: 'provider' }],
    };
    expect(getMcpHttpAuthHandler(selections, plugin, 'canopy')).toEqual({
      handler: 'provider',
      source: 'override',
    });
    expect(getMcpHttpAuthHandler(selections, standalone, 'canopy')).toEqual({
      handler: 'canopy',
      source: 'default',
    });
  });
});

describe('setMcpHttpAuthPreference', (): void => {
  it('does not mutate the input selections', (): void => {
    const input = fullSelections();
    const snapshot = structuredClone(input);
    setMcpHttpAuthPreference(input, standalone, 'provider');
    expect(input).toEqual(snapshot);
  });

  it('preserves collectionIds, skillRefs, pluginRefs, and mcpServerRefs', (): void => {
    const input = fullSelections();
    const next = setMcpHttpAuthPreference(input, standalone, 'provider');
    expect(next.collectionIds).toEqual(input.collectionIds);
    expect(next.skillRefs).toEqual(input.skillRefs);
    expect(next.pluginRefs).toEqual(input.pluginRefs);
    expect(next.mcpServerRefs).toEqual(input.mcpServerRefs);
  });

  it('round-trips: setting then re-reading returns the override', (): void => {
    const next = setMcpHttpAuthPreference(
      emptySelections(),
      standalone,
      'provider',
    );
    expect(getMcpHttpAuthHandler(next, standalone, 'canopy')).toEqual({
      handler: 'provider',
      source: 'override',
    });
  });

  it('replaces a previous preference for the same target (no duplicates)', (): void => {
    const first = setMcpHttpAuthPreference(
      emptySelections(),
      standalone,
      'provider',
    );
    const second = setMcpHttpAuthPreference(first, standalone, 'canopy');
    expect(second.mcpHttpAuthPreferences).toHaveLength(1);
    expect(second.mcpHttpAuthPreferences?.[0]).toEqual({
      target: standalone,
      handler: 'canopy',
    });
  });

  it('stores preferences for distinct targets independently', (): void => {
    const a = setMcpHttpAuthPreference(
      emptySelections(),
      standalone,
      'provider',
    );
    const b = setMcpHttpAuthPreference(a, plugin, 'canopy');

    expect(b.mcpHttpAuthPreferences).toHaveLength(2);
    expect(getMcpHttpAuthHandler(b, standalone, 'canopy')).toEqual({
      handler: 'provider',
      source: 'override',
    });
    expect(getMcpHttpAuthHandler(b, plugin, 'provider')).toEqual({
      handler: 'canopy',
      source: 'override',
    });
  });

  it('does not affect unrelated preferences when replacing one', (): void => {
    const seeded: ChatTabPluginSelections = {
      ...emptySelections(),
      mcpHttpAuthPreferences: [
        { target: otherStandalone, handler: 'provider' },
        { target: plugin, handler: 'provider' },
      ],
    };
    const next = setMcpHttpAuthPreference(seeded, plugin, 'canopy');
    expect(next.mcpHttpAuthPreferences).toEqual([
      { target: otherStandalone, handler: 'provider' },
      { target: plugin, handler: 'canopy' },
    ]);
  });

  it('accepts heterogeneous targets via the McpHttpAuthTarget union', (): void => {
    const targets: McpHttpAuthTarget[] = [standalone, plugin];
    let selections = emptySelections();
    for (const target of targets) {
      selections = setMcpHttpAuthPreference(selections, target, 'provider');
    }
    expect(selections.mcpHttpAuthPreferences).toHaveLength(2);
  });
});

it('preserves an account override ahead of a device default', (): void => {
  const selected = setMcpHttpAuthPreference(
    emptySelections(),
    standalone,
    'account',
  );
  expect(getMcpHttpAuthHandler(selected, standalone, 'canopy')).toEqual({
    handler: 'account',
    source: 'override',
  });
});

const colonTargets: McpPluginHttpAuthTarget[] = [
  {
    kind: 'plugin',
    marketplaceId: 'market:place',
    pluginName: 'plugin',
    serverName: 'server',
  },
  {
    kind: 'plugin',
    marketplaceId: 'market',
    pluginName: 'place:plugin',
    serverName: 'server',
  },
  {
    kind: 'plugin',
    marketplaceId: 'market',
    pluginName: 'place',
    serverName: 'plugin:server',
  },
];

it('keeps colon-bearing target keys distinct', (): void => {
  expect(new Set(colonTargets.map(mcpHttpAuthTargetKey)).size).toBe(
    colonTargets.length,
  );
  expect(
    mcpHttpAuthTargetKey({
      kind: 'standalone',
      serverId: 'server:config',
      configId: 'id',
    }),
  ).not.toBe(
    mcpHttpAuthTargetKey({
      kind: 'standalone',
      serverId: 'server',
      configId: 'config:id',
    }),
  );
});

it.each(colonTargets)(
  'never transfers an account grant from %j to a different target',
  (target): void => {
    const persisted: ChatTabPluginSelections = {
      ...emptySelections(),
      mcpHttpAuthPreferences: [{ target, handler: 'account' }],
    };
    for (const other of colonTargets) {
      expect(getMcpHttpAuthHandler(persisted, other, 'provider')).toEqual(
        other === target
          ? { handler: 'account', source: 'override' }
          : { handler: 'provider', source: 'default' },
      );
      if (other === target) continue;
      const updated = setMcpHttpAuthPreference(persisted, other, 'canopy');
      expect(updated.mcpHttpAuthPreferences).toHaveLength(2);
      expect(getMcpHttpAuthHandler(updated, target, 'provider')).toEqual({
        handler: 'account',
        source: 'override',
      });
      expect(getMcpHttpAuthHandler(updated, other, 'provider')).toEqual({
        handler: 'canopy',
        source: 'override',
      });
    }
  },
);
