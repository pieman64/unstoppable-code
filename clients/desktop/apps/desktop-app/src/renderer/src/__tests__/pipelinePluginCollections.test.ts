import type {
  PipelineInfo,
  PipelinePluginDefaultPreviewItem,
  PipelinePluginCollectionPreference,
} from '@canopy/desktop-shared/types/pipeline';
import type { BundleIndexEntry } from '@canopy/desktop-shared/types/bundles';
import type {
  UnifiedTableCatalogRow,
  UnifiedTableRow,
} from '@/hooks/useUnifiedTableData';
import {
  annotateRowsForCollection,
  applyToggleForCollection,
  buildExtraSelectionKeys,
  buildSyntheticPipelineRow,
  createEmptyCollectionPreference,
  derivePipelinePreferenceLocator,
  ensureCollectionPreference,
  groupPreviewItemsByCollection,
  toggleExtraSelectionKey,
} from '@/lib/pipelinePluginCollections';

function makeCatalogSkillRow(
  key: string,
  name: string,
  overrides: Partial<UnifiedTableCatalogRow> = {},
): UnifiedTableCatalogRow {
  return {
    rowOrigin: 'catalog',
    kind: 'skill',
    key,
    name,
    description: '',
    source: 'sample-source',
    sourceSubtitle: '',
    sourceIcon: 'repo',
    lastUpdated: '',
    original: {
      name,
      sourceId: 'sample-source',
      description: '',
      source: 'acme/skills',
      installedAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
      updateAvailable: false,
    },
    ...overrides,
  };
}

function makePreviewItem(
  overrides: Partial<PipelinePluginDefaultPreviewItem>,
): PipelinePluginDefaultPreviewItem {
  return {
    defaultKey: 'collection-a:skill:acme/skills:commit-messages',
    collectionId: 'collection-a',
    kind: 'skill',
    required: false,
    enabledByDefault: true,
    matchState: 'matched',
    matchedCatalogKey: 'sample-source/commit-messages',
    displayName: 'commit-messages',
    displayDescription: 'commit-messages',
    displaySource: 'acme/skills',
    ...overrides,
  };
}

describe('derivePipelinePreferenceLocator', () => {
  it('uses file path locator for project pipelines', () => {
    const info: PipelineInfo = {
      id: 'pipe-1',
      name: 'My pipeline',
      filename: 'my-pipeline.yaml',
      description: '',
      icon: '',
      createdAt: '',
      updatedAt: '',
      source: 'project',
      readonly: false,
      filePath: '/abs/path/to/pipeline.yaml',
    };
    expect(derivePipelinePreferenceLocator(info)).toEqual({
      type: 'file',
      value: '/abs/path/to/pipeline.yaml',
    });
  });

  it('uses stored locator for non-project pipelines', () => {
    const info: PipelineInfo = {
      id: 'pipe-1',
      name: 'Bundled',
      filename: 'bundled.yaml',
      description: '',
      icon: '',
      createdAt: '',
      updatedAt: '',
      source: 'bundled',
      readonly: true,
    };
    expect(derivePipelinePreferenceLocator(info)).toEqual({
      type: 'stored',
      source: 'bundled',
      value: 'pipe-1',
    });
  });

  it('uses a stable curated preference identity with the reviewed content hash', () => {
    const info: PipelineInfo = {
      id: 'curated:review',
      name: 'Review',
      filename: 'review.yaml',
      description: '',
      icon: '',
      createdAt: '',
      updatedAt: '',
      source: 'curated',
      readonly: true,
      filePath: '/managed/revision/pipeline.yaml',
      curatedContentHash: 'a'.repeat(64),
    };
    expect(derivePipelinePreferenceLocator(info)).toEqual({
      type: 'stored',
      source: 'curated',
      value: 'curated:review',
      contentHash: 'a'.repeat(64),
    });
  });

  it('uses shared locator for shared pipelines', () => {
    const info: PipelineInfo = {
      id: 'shared:server-1:remote-2',
      name: 'Shared',
      filename: '',
      description: '',
      icon: '',
      createdAt: '',
      updatedAt: '',
      source: 'shared',
      readonly: true,
      serverId: 'server-1',
      remoteId: 'remote-2',
    };
    expect(derivePipelinePreferenceLocator(info)).toEqual({
      type: 'shared',
      value: 'server-1:remote-2',
    });
  });

  it('falls back to file locator keyed by id when project pipeline lacks filePath', () => {
    const info: PipelineInfo = {
      id: 'pipe-1',
      name: 'Inline',
      filename: 'inline.yaml',
      description: '',
      icon: '',
      createdAt: '',
      updatedAt: '',
      source: 'project',
      readonly: false,
    };
    expect(derivePipelinePreferenceLocator(info)).toEqual({
      type: 'file',
      value: 'pipe-1',
    });
  });
});

describe('createEmptyCollectionPreference / ensureCollectionPreference', () => {
  it('produces an empty preference shape', () => {
    expect(createEmptyCollectionPreference()).toEqual({
      disabledDefaultKeys: [],
      extraSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
    });
  });

  it('returns existing preference when present, otherwise an empty one', () => {
    const existing: PipelinePluginCollectionPreference = {
      disabledDefaultKeys: ['x'],
      extraSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
    };
    expect(
      ensureCollectionPreference({ 'collection-a': existing }, 'collection-a'),
    ).toBe(existing);
    expect(ensureCollectionPreference({}, 'collection-a')).toEqual(
      createEmptyCollectionPreference(),
    );
  });
});

describe('buildExtraSelectionKeys', () => {
  it('normalizes every extra kind to its row key', () => {
    expect(
      buildExtraSelectionKeys({
        collectionIds: ['bundle-1'],
        skillRefs: [{ sourceId: 'src', skillName: 'skill-1' }],
        pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'plug-1' }],
        mcpServerRefs: [{ serverId: 'srv', configId: 'cfg' }],
      }),
    ).toEqual(new Set(['bundle-1', 'src/skill-1', 'mkt/plug-1', 'srv/cfg']));
  });
});

describe('toggleExtraSelectionKey', () => {
  it('adds a new skill ref and removes it on second toggle', () => {
    const empty = createEmptyCollectionPreference().extraSelections;
    const skillRow = makeCatalogSkillRow('src/skill-1', 'skill-1');

    const added = toggleExtraSelectionKey(empty, skillRow);
    expect(added.skillRefs).toEqual([
      { sourceId: 'src', skillName: 'skill-1' },
    ]);

    const removed = toggleExtraSelectionKey(added, skillRow);
    expect(removed.skillRefs).toEqual([]);
  });

  it('keeps collectionIds sorted alphabetically when adding', () => {
    const initial = {
      collectionIds: ['b'],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    const collectionRowA: UnifiedTableCatalogRow = {
      rowOrigin: 'catalog',
      kind: 'collection',
      key: 'a',
      name: 'A',
      description: '',
      source: '',
      sourceSubtitle: '',
      sourceIcon: 'none',
      lastUpdated: '',
      original: {
        id: 'a',
        name: 'A',
        description: '',
        updatedAt: '',
        skillCount: 0,
        pluginCount: 0,
        mcpServerCount: 0,
      } satisfies BundleIndexEntry,
    };
    expect(
      toggleExtraSelectionKey(initial, collectionRowA).collectionIds,
    ).toEqual(['a', 'b']);
  });
});

describe('buildSyntheticPipelineRow', () => {
  it('builds an info-badged optional synthetic row', () => {
    const row = buildSyntheticPipelineRow(
      makePreviewItem({
        matchState: 'unmatched',
        matchedCatalogKey: undefined,
        defaultKey: 'collection-a:skill:acme/missing:tool',
        displayName: 'tool',
      }),
    );

    expect(row.rowOrigin).toBe('pipeline-derived');
    expect(row.key).toBe(
      '__pipeline-default__:collection-a:skill:acme/missing:tool',
    );
    expect(row.toggleMode).toBe('normal');
    expect(row.viewDisabled).toBe(true);
    expect(row.badges?.map((b) => b.label)).toEqual(['Pipeline', 'Missing']);
  });

  it('marks required defaults as locked with the Required badge', () => {
    const row = buildSyntheticPipelineRow(
      makePreviewItem({
        matchState: 'unmatched',
        matchedCatalogKey: undefined,
        required: true,
        defaultKey: 'collection-a:skill:acme/missing:must-have',
        displayName: 'must-have',
      }),
    );

    expect(row.toggleMode).toBe('locked');
    expect(row.badges?.map((b) => b.label)).toEqual([
      'Pipeline',
      'Required',
      'Missing',
    ]);
  });
});

describe('annotateRowsForCollection', () => {
  it('badges matched rows with Pipeline and selects them by default', () => {
    const catalog: UnifiedTableRow[] = [
      makeCatalogSkillRow('sample-source/commit-messages', 'commit-messages'),
    ];

    const result = annotateRowsForCollection(
      catalog,
      [makePreviewItem({})],
      createEmptyCollectionPreference(),
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].badges?.map((b) => b.label)).toEqual(['Pipeline']);
    expect(result.selectedKeys.has('sample-source/commit-messages')).toBe(true);
    expect(
      result.defaultKeyToRowKey.get(
        'collection-a:skill:acme/skills:commit-messages',
      ),
    ).toBe('sample-source/commit-messages');
  });

  it('locks required matched rows and ignores user disable for them', () => {
    const catalog: UnifiedTableRow[] = [
      makeCatalogSkillRow('sample-source/commit-messages', 'commit-messages'),
    ];

    const preference: PipelinePluginCollectionPreference = {
      disabledDefaultKeys: ['collection-a:skill:acme/skills:commit-messages'],
      extraSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
    };

    const result = annotateRowsForCollection(
      catalog,
      [makePreviewItem({ required: true })],
      preference,
    );

    expect(result.rows[0].toggleMode).toBe('locked');
    expect(result.rows[0].badges?.map((b) => b.label)).toEqual([
      'Pipeline',
      'Required',
    ]);
    expect(result.selectedKeys.has('sample-source/commit-messages')).toBe(true);
  });

  it('respects disabledDefaultKeys for optional matched rows', () => {
    const catalog: UnifiedTableRow[] = [
      makeCatalogSkillRow('sample-source/commit-messages', 'commit-messages'),
    ];

    const preference: PipelinePluginCollectionPreference = {
      disabledDefaultKeys: ['collection-a:skill:acme/skills:commit-messages'],
      extraSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
    };

    const result = annotateRowsForCollection(
      catalog,
      [makePreviewItem({})],
      preference,
    );

    expect(result.selectedKeys.has('sample-source/commit-messages')).toBe(
      false,
    );
  });

  it('splices a synthetic row in for unmatched defaults', () => {
    const result = annotateRowsForCollection(
      [],
      [
        makePreviewItem({
          matchState: 'unmatched',
          matchedCatalogKey: undefined,
          defaultKey: 'collection-a:skill:acme/missing:tool',
          displayName: 'tool',
        }),
      ],
      createEmptyCollectionPreference(),
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].rowOrigin).toBe('pipeline-derived');
    expect(
      result.selectedKeys.has(
        '__pipeline-default__:collection-a:skill:acme/missing:tool',
      ),
    ).toBe(true);
  });

  it('marks extras as selected via extraSelections', () => {
    const catalog: UnifiedTableRow[] = [
      makeCatalogSkillRow('extra-source/extra-skill', 'extra-skill'),
    ];

    const preference: PipelinePluginCollectionPreference = {
      disabledDefaultKeys: [],
      extraSelections: {
        collectionIds: [],
        skillRefs: [{ sourceId: 'extra-source', skillName: 'extra-skill' }],
        pluginRefs: [],
        mcpServerRefs: [],
      },
    };

    const result = annotateRowsForCollection(catalog, [], preference);
    expect(result.selectedKeys.has('extra-source/extra-skill')).toBe(true);
  });
});

describe('applyToggleForCollection', () => {
  it('toggles disabledDefaultKeys for an optional matched row', () => {
    const row = makeCatalogSkillRow(
      'sample-source/commit-messages',
      'commit-messages',
    );
    const items = [makePreviewItem({})];
    const preference = createEmptyCollectionPreference();

    // First toggle disables the default.
    const disabled = applyToggleForCollection({
      row,
      items,
      preference,
      selectedKeys: new Set(['sample-source/commit-messages']),
    });
    expect(disabled.disabledDefaultKeys).toEqual([
      'collection-a:skill:acme/skills:commit-messages',
    ]);

    // Second toggle re-enables it.
    const reenabled = applyToggleForCollection({
      row,
      items,
      preference: disabled,
      selectedKeys: new Set(),
    });
    expect(reenabled.disabledDefaultKeys).toEqual([]);
  });

  it('is a no-op for required matched rows', () => {
    const row = makeCatalogSkillRow(
      'sample-source/commit-messages',
      'commit-messages',
    );
    const items = [makePreviewItem({ required: true })];
    const preference = createEmptyCollectionPreference();

    const result = applyToggleForCollection({
      row: { ...row, toggleMode: 'locked' },
      items,
      preference,
      selectedKeys: new Set(['sample-source/commit-messages']),
    });
    expect(result).toBe(preference);
  });

  it('toggles disabledDefaultKeys for a synthetic pipeline-derived row', () => {
    const item = makePreviewItem({
      matchState: 'unmatched',
      matchedCatalogKey: undefined,
      defaultKey: 'collection-a:skill:acme/missing:tool',
      displayName: 'tool',
    });
    const synthetic = buildSyntheticPipelineRow(item);
    const preference = createEmptyCollectionPreference();

    const disabled = applyToggleForCollection({
      row: synthetic,
      items: [item],
      preference,
      selectedKeys: new Set([synthetic.key]),
    });
    expect(disabled.disabledDefaultKeys).toEqual([item.defaultKey]);
  });

  it('toggles plain catalog rows in/out of extraSelections', () => {
    const row = makeCatalogSkillRow('extra/extra-skill', 'extra-skill');
    const preference = createEmptyCollectionPreference();

    const added = applyToggleForCollection({
      row,
      items: [],
      preference,
      selectedKeys: new Set(),
    });
    expect(added.extraSelections.skillRefs).toEqual([
      { sourceId: 'extra', skillName: 'extra-skill' },
    ]);

    const removed = applyToggleForCollection({
      row,
      items: [],
      preference: added,
      selectedKeys: new Set(['extra/extra-skill']),
    });
    expect(removed.extraSelections.skillRefs).toEqual([]);
  });
});

describe('groupPreviewItemsByCollection', () => {
  it('groups items by collectionId preserving order', () => {
    const a1 = makePreviewItem({ defaultKey: 'a:1' });
    const a2 = makePreviewItem({ defaultKey: 'a:2' });
    const b1 = makePreviewItem({
      defaultKey: 'b:1',
      collectionId: 'collection-b',
    });

    expect(groupPreviewItemsByCollection([a1, b1, a2])).toEqual({
      'collection-a': [a1, a2],
      'collection-b': [b1],
    });
  });
});
