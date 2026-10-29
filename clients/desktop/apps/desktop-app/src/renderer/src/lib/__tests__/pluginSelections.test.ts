import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import {
  EMPTY_SELECTIONS,
  createEmptySelections,
  normalizeSelections,
  parseSelectionsJson,
} from '../pluginSelections';

describe('parseSelectionsJson', () => {
  it('parses a basic selections payload without auth preferences', () => {
    const json = JSON.stringify({
      collectionIds: ['core'],
      skillRefs: [],
      pluginRefs: [],
    });
    expect(parseSelectionsJson(json)).toEqual({
      collectionIds: ['core'],
      skillRefs: [],
      pluginRefs: [],
    });
  });

  it.each(['provider', 'account'] as const)(
    'preserves a standalone %s HTTP MCP auth preference',
    (handler): void => {
      const json = JSON.stringify({
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpHttpAuthPreferences: [
          {
            target: { kind: 'standalone', serverId: 's1', configId: 'c1' },
            handler,
          },
        ],
      });
      const parsed = parseSelectionsJson(json);
      expect(parsed?.mcpHttpAuthPreferences).toEqual([
        {
          target: { kind: 'standalone', serverId: 's1', configId: 'c1' },
          handler,
        },
      ]);
    },
  );

  it('preserves a plugin HTTP MCP auth preference', () => {
    const json = JSON.stringify({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpHttpAuthPreferences: [
        {
          target: {
            kind: 'plugin',
            marketplaceId: 'mkt',
            pluginName: 'Linear',
            serverName: 'linear',
          },
          handler: 'canopy',
        },
      ],
    });
    const parsed = parseSelectionsJson(json);
    expect(parsed?.mcpHttpAuthPreferences).toEqual([
      {
        target: {
          kind: 'plugin',
          marketplaceId: 'mkt',
          pluginName: 'Linear',
          serverName: 'linear',
        },
        handler: 'canopy',
      },
    ]);
  });

  it('drops malformed override entries silently', () => {
    const json = JSON.stringify({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpHttpAuthPreferences: [
        // Missing target.kind discriminator
        {
          target: { serverId: 's1', configId: 'c1' },
          handler: 'canopy',
        },
        // Unknown handler value
        {
          target: { kind: 'standalone', serverId: 's2', configId: 'c2' },
          handler: 'somethingElse',
        },
        // Missing required string field
        {
          target: { kind: 'plugin', marketplaceId: 'mkt', pluginName: 'X' },
          handler: 'canopy',
        },
        // A valid entry — should survive
        {
          target: { kind: 'standalone', serverId: 's3', configId: 'c3' },
          handler: 'provider',
        },
      ],
    });
    const parsed = parseSelectionsJson(json);
    expect(parsed?.mcpHttpAuthPreferences).toEqual([
      {
        target: { kind: 'standalone', serverId: 's3', configId: 'c3' },
        handler: 'provider',
      },
    ]);
  });

  it('does not throw when mcpHttpAuthPreferences is not an array', () => {
    const json = JSON.stringify({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpHttpAuthPreferences: 'not-an-array',
    });
    const parsed = parseSelectionsJson(json);
    // Non-array input should be coerced to no preferences (silently dropped)
    // rather than throwing or rejecting the entire selection.
    expect(parsed).toEqual({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
    });
  });

  it('returns null on completely malformed JSON', () => {
    expect(parseSelectionsJson('{not-json')).toBeNull();
  });
});

describe('normalizeSelections', () => {
  it('produces a stable sorted output for auth preferences regardless of insertion order', () => {
    const a: ChatTabPluginSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpHttpAuthPreferences: [
        {
          target: {
            kind: 'plugin',
            marketplaceId: 'mkt',
            pluginName: 'B',
            serverName: 'srv',
          },
          handler: 'canopy',
        },
        {
          target: { kind: 'standalone', serverId: 's1', configId: 'c1' },
          handler: 'provider',
        },
      ],
    };
    const b: ChatTabPluginSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpHttpAuthPreferences: [
        {
          target: { kind: 'standalone', serverId: 's1', configId: 'c1' },
          handler: 'provider',
        },
        {
          target: {
            kind: 'plugin',
            marketplaceId: 'mkt',
            pluginName: 'B',
            serverName: 'srv',
          },
          handler: 'canopy',
        },
      ],
    };
    expect(normalizeSelections(a)).toBe(normalizeSelections(b));
  });

  it('treats empty and undefined auth preferences as equivalent', () => {
    const a: ChatTabPluginSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
    };
    const b: ChatTabPluginSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpHttpAuthPreferences: [],
    };
    expect(normalizeSelections(a)).toBe(normalizeSelections(b));
  });

  it('normalizes legacy bundleIds payloads before sorting', () => {
    const legacy = {
      bundleIds: ['legacy-collection'],
      skillRefs: [],
      pluginRefs: [],
    };
    const canonical: ChatTabPluginSelections = {
      collectionIds: ['legacy-collection'],
      skillRefs: [],
      pluginRefs: [],
    };

    expect(normalizeSelections(legacy)).toBe(normalizeSelections(canonical));
  });
});

describe('createEmptySelections / EMPTY_SELECTIONS', () => {
  it('exposes mcpHttpAuthPreferences on the empty payload', () => {
    expect(EMPTY_SELECTIONS.mcpHttpAuthPreferences).toEqual([]);
    expect(createEmptySelections().mcpHttpAuthPreferences).toEqual([]);
  });

  it('returns a fresh object from createEmptySelections', () => {
    const a = createEmptySelections();
    const b = createEmptySelections();
    expect(a).not.toBe(b);
    expect(a.mcpHttpAuthPreferences).not.toBe(b.mcpHttpAuthPreferences);
  });
});

it('preserves account server keys through persisted picker selections', (): void => {
  const selections = {
    ...createEmptySelections(),
    mcpServerRefs: [
      {
        serverId: 'custom:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        configId: 'default',
      },
    ],
  };
  expect(
    parseSelectionsJson(normalizeSelections(selections))?.mcpServerRefs,
  ).toEqual(selections.mcpServerRefs);
});
