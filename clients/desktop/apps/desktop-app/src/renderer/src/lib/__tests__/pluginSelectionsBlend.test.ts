import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import {
  subtractPluginSelections,
  unionPluginSelections,
} from '../pluginSelectionsBlend';

function makeSelections(
  overrides?: Partial<ChatTabPluginSelections>,
): ChatTabPluginSelections {
  return {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [],
    ...overrides,
  };
}

describe('unionPluginSelections', () => {
  it('normalizes legacy bundleIds before unioning selections', () => {
    const legacy: ChatTabPluginSelections = {
      collectionIds: [],
      bundleIds: ['legacy-collection'],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    };

    expect(
      unionPluginSelections(
        makeSelections({ collectionIds: ['global-collection'] }),
        legacy,
      ),
    ).toEqual({
      collectionIds: ['global-collection', 'legacy-collection'],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    });
  });

  it('unions collectionIds, deduplicating by id', () => {
    const a = makeSelections({ collectionIds: ['a', 'b'] });
    const b = makeSelections({ collectionIds: ['b', 'c'] });
    expect(unionPluginSelections(a, b).collectionIds).toEqual(['a', 'b', 'c']);
  });

  it('unions skillRefs, deduplicating by sourceId+skillName identity', () => {
    const a = makeSelections({
      skillRefs: [{ sourceId: 's1', skillName: 'foo' }],
    });
    const b = makeSelections({
      skillRefs: [
        { sourceId: 's1', skillName: 'foo' },
        { sourceId: 's1', skillName: 'bar' },
        { sourceId: 's2', skillName: 'foo' },
      ],
    });
    expect(unionPluginSelections(a, b).skillRefs).toEqual([
      { sourceId: 's1', skillName: 'foo' },
      { sourceId: 's1', skillName: 'bar' },
      { sourceId: 's2', skillName: 'foo' },
    ]);
  });

  it('unions pluginRefs, deduplicating by marketplaceId+pluginName identity', () => {
    const a = makeSelections({
      pluginRefs: [{ marketplaceId: 'm1', pluginName: 'p1' }],
    });
    const b = makeSelections({
      pluginRefs: [
        { marketplaceId: 'm1', pluginName: 'p1' },
        { marketplaceId: 'm1', pluginName: 'p2' },
      ],
    });
    expect(unionPluginSelections(a, b).pluginRefs).toEqual([
      { marketplaceId: 'm1', pluginName: 'p1' },
      { marketplaceId: 'm1', pluginName: 'p2' },
    ]);
  });

  it('unions mcpServerRefs, deduplicating by serverId+configId identity', () => {
    const a = makeSelections({
      mcpServerRefs: [{ serverId: 'srv1', configId: 'c1' }],
    });
    const b = makeSelections({
      mcpServerRefs: [
        { serverId: 'srv1', configId: 'c1' },
        { serverId: 'srv2', configId: 'c1' },
      ],
    });
    expect(unionPluginSelections(a, b).mcpServerRefs).toEqual([
      { serverId: 'srv1', configId: 'c1' },
      { serverId: 'srv2', configId: 'c1' },
    ]);
  });

  it('treats a missing mcpServerRefs field as empty on either side', () => {
    const a: ChatTabPluginSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
    };
    const b = makeSelections({
      mcpServerRefs: [{ serverId: 'srv1', configId: 'c1' }],
    });
    expect(unionPluginSelections(a, b).mcpServerRefs).toEqual([
      { serverId: 'srv1', configId: 'c1' },
    ]);
    expect(unionPluginSelections(b, a).mcpServerRefs).toEqual([
      { serverId: 'srv1', configId: 'c1' },
    ]);
  });

  it('preserves and merges mcpHttpAuthPreferences by target', () => {
    const a = makeSelections({
      mcpHttpAuthPreferences: [
        {
          target: {
            kind: 'standalone',
            serverId: 'srv1',
            configId: 'c1',
          },
          handler: 'canopy',
        },
        {
          target: {
            kind: 'standalone',
            serverId: 'srv2',
            configId: 'c1',
          },
          handler: 'provider',
        },
      ],
    });
    const b = makeSelections({
      mcpHttpAuthPreferences: [
        {
          target: {
            kind: 'standalone',
            serverId: 'srv1',
            configId: 'c1',
          },
          handler: 'provider',
        },
      ],
    });

    expect(unionPluginSelections(a, b).mcpHttpAuthPreferences).toEqual([
      {
        target: {
          kind: 'standalone',
          serverId: 'srv1',
          configId: 'c1',
        },
        handler: 'provider',
      },
      {
        target: {
          kind: 'standalone',
          serverId: 'srv2',
          configId: 'c1',
        },
        handler: 'provider',
      },
    ]);
  });

  it('returns an equivalent empty selections object when both inputs are empty', () => {
    expect(unionPluginSelections(makeSelections(), makeSelections())).toEqual(
      makeSelections(),
    );
  });
});

describe('subtractPluginSelections', () => {
  it('removes collectionIds present in b from a', () => {
    const a = makeSelections({ collectionIds: ['a', 'b', 'c'] });
    const b = makeSelections({ collectionIds: ['b'] });
    expect(subtractPluginSelections(a, b).collectionIds).toEqual(['a', 'c']);
  });

  it('removes skillRefs matching by sourceId+skillName identity', () => {
    const a = makeSelections({
      skillRefs: [
        { sourceId: 's1', skillName: 'foo' },
        { sourceId: 's1', skillName: 'bar' },
      ],
    });
    const b = makeSelections({
      skillRefs: [{ sourceId: 's1', skillName: 'foo' }],
    });
    expect(subtractPluginSelections(a, b).skillRefs).toEqual([
      { sourceId: 's1', skillName: 'bar' },
    ]);
  });

  it('removes pluginRefs matching by marketplaceId+pluginName identity', () => {
    const a = makeSelections({
      pluginRefs: [
        { marketplaceId: 'm1', pluginName: 'p1' },
        { marketplaceId: 'm1', pluginName: 'p2' },
      ],
    });
    const b = makeSelections({
      pluginRefs: [{ marketplaceId: 'm1', pluginName: 'p1' }],
    });
    expect(subtractPluginSelections(a, b).pluginRefs).toEqual([
      { marketplaceId: 'm1', pluginName: 'p2' },
    ]);
  });

  it('removes mcpServerRefs matching by serverId+configId identity', () => {
    const a = makeSelections({
      mcpServerRefs: [
        { serverId: 'srv1', configId: 'c1' },
        { serverId: 'srv2', configId: 'c1' },
      ],
    });
    const b = makeSelections({
      mcpServerRefs: [{ serverId: 'srv1', configId: 'c1' }],
    });
    expect(subtractPluginSelections(a, b).mcpServerRefs).toEqual([
      { serverId: 'srv2', configId: 'c1' },
    ]);
  });

  it('is a no-op when b is empty', () => {
    const a = makeSelections({
      collectionIds: ['a'],
      skillRefs: [{ sourceId: 's1', skillName: 'foo' }],
      pluginRefs: [{ marketplaceId: 'm1', pluginName: 'p1' }],
      mcpServerRefs: [{ serverId: 'srv1', configId: 'c1' }],
      mcpHttpAuthPreferences: [
        {
          target: {
            kind: 'standalone',
            serverId: 'srv1',
            configId: 'c1',
          },
          handler: 'canopy',
        },
      ],
    });
    expect(subtractPluginSelections(a, makeSelections())).toEqual(a);
  });

  it('treats a missing mcpServerRefs field on either side as empty', () => {
    const a: ChatTabPluginSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
    };
    const b = makeSelections({
      mcpServerRefs: [{ serverId: 'srv1', configId: 'c1' }],
    });
    expect(subtractPluginSelections(a, b).mcpServerRefs).toEqual([]);
  });

  it('removes unchanged default mcpHttpAuthPreferences but keeps overrides', () => {
    const a = makeSelections({
      mcpHttpAuthPreferences: [
        {
          target: {
            kind: 'standalone',
            serverId: 'srv1',
            configId: 'c1',
          },
          handler: 'provider',
        },
        {
          target: {
            kind: 'standalone',
            serverId: 'srv2',
            configId: 'c1',
          },
          handler: 'canopy',
        },
      ],
    });
    const b = makeSelections({
      mcpHttpAuthPreferences: [
        {
          target: {
            kind: 'standalone',
            serverId: 'srv1',
            configId: 'c1',
          },
          handler: 'canopy',
        },
        {
          target: {
            kind: 'standalone',
            serverId: 'srv2',
            configId: 'c1',
          },
          handler: 'canopy',
        },
      ],
    });

    expect(subtractPluginSelections(a, b).mcpHttpAuthPreferences).toEqual([
      {
        target: {
          kind: 'standalone',
          serverId: 'srv1',
          configId: 'c1',
        },
        handler: 'provider',
      },
    ]);
  });
});

describe('unionPluginSelections + subtractPluginSelections round trip', () => {
  it('subtracting the original defaults back out of a union recovers the manual delta', () => {
    const defaults = makeSelections({ collectionIds: ['core'] });
    const manual = makeSelections({
      collectionIds: ['extra'],
      skillRefs: [{ sourceId: 's1', skillName: 'foo' }],
    });

    const merged = unionPluginSelections(defaults, manual);
    expect(subtractPluginSelections(merged, defaults)).toEqual(manual);
  });
});
