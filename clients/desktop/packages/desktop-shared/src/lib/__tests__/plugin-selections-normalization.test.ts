import {
  countPluginSelections,
  emptyPluginSelections,
  isChatTabPluginSelections,
  normalizePluginSelections,
} from '../plugin-selections-normalization';
import { hasAnySelections } from '../../types';

describe('normalizePluginSelections', () => {
  it('accepts legacy bundle-only selections at read boundaries', () => {
    expect(
      isChatTabPluginSelections({
        bundleIds: ['legacy-collection'],
        skillRefs: [],
        pluginRefs: [],
      }),
    ).toBe(true);
  });

  it('rejects traversal segments in installed skill references', () => {
    const unsafeSelections = {
      collectionIds: [],
      skillRefs: [
        { sourceId: '../../.codex/skills', skillName: 'review' },
        { sourceId: 'custom:local', skillName: '../review' },
      ],
      pluginRefs: [],
    };

    expect(isChatTabPluginSelections(unsafeSelections)).toBe(false);
    expect(normalizePluginSelections(unsafeSelections).skillRefs).toEqual([]);
  });

  it('rejects traversal-bearing MCP server identifiers', () => {
    const unsafeSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [
        { serverId: '../outside', configId: 'default' },
        { serverId: 'nested/server', configId: 'default' },
        { serverId: 'nested\\server', configId: 'default' },
      ],
    };

    expect(isChatTabPluginSelections(unsafeSelections)).toBe(false);
    expect(normalizePluginSelections(unsafeSelections).mcpServerRefs).toEqual(
      [],
    );
  });

  it('rejects empty MCP server identifiers during normalization', () => {
    const selections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [{ serverId: '', configId: 'default' }],
    };

    expect(isChatTabPluginSelections(selections)).toBe(false);
    expect(normalizePluginSelections(selections).mcpServerRefs).toEqual([]);
  });

  it('preserves supported builtin skill source aliases', () => {
    const selections = {
      collectionIds: [],
      skillRefs: [
        { sourceId: 'builtin/app', skillName: 'deep-research' },
        { sourceId: 'builtin/canopy', skillName: 'plan-with-review' },
      ],
      pluginRefs: [],
    };

    expect(isChatTabPluginSelections(selections)).toBe(true);
    const normalized = normalizePluginSelections(selections);
    expect(normalized.skillRefs).toEqual([
      { sourceId: 'builtin:app', skillName: 'deep-research' },
      { sourceId: 'builtin:app', skillName: 'plan-with-review' },
    ]);
    expect(
      `${normalized.skillRefs[0]?.sourceId}/${normalized.skillRefs[0]?.skillName}`,
    ).toBe('builtin:app/deep-research');
  });

  it('returns a canonical empty selections object for missing input', () => {
    expect(normalizePluginSelections(undefined)).toEqual({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
    });
    expect(normalizePluginSelections(null)).toEqual({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
    });
    expect(normalizePluginSelections('not-an-object')).toEqual({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
    });
  });

  it('merges legacy bundleIds into collectionIds and drops bundleIds on output', () => {
    const result = normalizePluginSelections({
      bundleIds: ['legacy-a', 'legacy-b'],
      skillRefs: [],
      pluginRefs: [],
    });
    expect(result.collectionIds).toEqual(['legacy-a', 'legacy-b']);
    expect(result).not.toHaveProperty('bundleIds');
  });

  it('de-duplicates ids when collectionIds and bundleIds overlap', () => {
    const result = normalizePluginSelections({
      collectionIds: ['shared', 'only-new'],
      bundleIds: ['only-old', 'shared'],
      skillRefs: [],
      pluginRefs: [],
    });
    // collectionIds-first ordering, then any legacy-only entries.
    expect(result.collectionIds).toEqual(['shared', 'only-new', 'only-old']);
    expect(result).not.toHaveProperty('bundleIds');
  });

  it('drops malformed skill / plugin entries silently', () => {
    const result = normalizePluginSelections({
      collectionIds: ['a'],
      skillRefs: [
        { sourceId: 'src', skillName: 'good' },
        { sourceId: '', skillName: 'missing-source' },
        { sourceId: 'src', skillName: 'good' }, // duplicate
        'malformed',
      ],
      pluginRefs: [
        { marketplaceId: 'mkt', pluginName: 'p' },
        { marketplaceId: 'mkt' },
      ],
    });
    expect(result.skillRefs).toEqual([{ sourceId: 'src', skillName: 'good' }]);
    expect(result.pluginRefs).toEqual([
      { marketplaceId: 'mkt', pluginName: 'p' },
    ]);
  });

  it('passes mcpServerRefs and mcpHttpAuthPreferences through when present', () => {
    const result = normalizePluginSelections({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [{ serverId: 's', configId: 'c' }],
      mcpHttpAuthPreferences: [
        {
          target: { kind: 'standalone', serverId: 's', configId: 'c' },
          handler: 'provider',
        },
      ],
    });
    expect(result.mcpServerRefs).toEqual([{ serverId: 's', configId: 'c' }]);
    expect(result.mcpHttpAuthPreferences).toEqual([
      {
        target: { kind: 'standalone', serverId: 's', configId: 'c' },
        handler: 'provider',
      },
    ]);
  });

  it('omits mcp fields entirely when absent from input', () => {
    const result = normalizePluginSelections({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
    });
    expect(result).not.toHaveProperty('mcpServerRefs');
    expect(result).not.toHaveProperty('mcpHttpAuthPreferences');
  });
});

describe('emptyPluginSelections', () => {
  it('returns a fresh, mutation-safe object', () => {
    const a = emptyPluginSelections();
    const b = emptyPluginSelections();
    expect(a).toEqual({ collectionIds: [], skillRefs: [], pluginRefs: [] });
    expect(a).not.toBe(b);
    a.collectionIds.push('x');
    expect(b.collectionIds).toEqual([]);
  });
});

describe('countPluginSelections', () => {
  it('counts legacy bundle IDs without double-counting canonical duplicates', () => {
    expect(
      countPluginSelections({
        collectionIds: ['shared'],
        bundleIds: ['legacy', 'shared'],
        skillRefs: [],
        pluginRefs: [],
      }),
    ).toBe(2);
  });
});

describe('hasAnySelections', () => {
  it('accepts legacy bundle-only persisted selection objects', () => {
    expect(
      hasAnySelections({
        bundleIds: ['legacy-collection'],
        skillRefs: [],
        pluginRefs: [],
      } as Parameters<typeof hasAnySelections>[0]),
    ).toBe(true);
  });

  it('treats malformed empty selection objects as empty', () => {
    expect(hasAnySelections({} as Parameters<typeof hasAnySelections>[0])).toBe(
      false,
    );
  });
});

it('retains unresolved Try it capabilities through desktop persistence normalization', () => {
  const capability = {
    kind: 'mcp',
    sourceId: 'curated',
    catalogId: 'github',
    name: 'GitHub',
  };
  const input = {
    collectionIds: [],
    pluginRefs: [],
    skillRefs: [],
    unresolvedCapabilities: [capability],
  };
  expect(normalizePluginSelections(input)).toEqual(input);
  expect(isChatTabPluginSelections(input)).toBe(true);
  expect(countPluginSelections(input)).toBe(1);
  expect(hasAnySelections(input)).toBe(true);
});
