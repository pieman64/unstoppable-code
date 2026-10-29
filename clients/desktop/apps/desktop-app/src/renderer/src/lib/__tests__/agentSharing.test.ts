import type { UnifiedTableRow } from '@/hooks/useUnifiedTableData';
import {
  deriveShareableAgentPlugins,
  deriveShareablePluginsLenient,
} from '../agentSharing';

describe('deriveShareableAgentPlugins', () => {
  it('blocks sharing when legacy bundleIds are still present', () => {
    expect(
      deriveShareableAgentPlugins(
        {
          collectionIds: [],
          bundleIds: ['legacy-collection'],
          skillRefs: [],
          pluginRefs: [],
        },
        [],
      ),
    ).toEqual({ ok: false });
  });
});

describe('deriveShareablePluginsLenient', () => {
  const portableSkillRow: UnifiedTableRow = {
    kind: 'skill',
    key: 'source-a/portable',
    name: 'portable',
    description: '',
    source: 'source-a',
    sourceSubtitle: '',
    sourceIcon: 'folder',
    shareableRef: {
      type: 'skill',
      source: { type: 'builtin', id: 'app' },
      skill_name: 'portable',
    },
  };

  const collectionRow: UnifiedTableRow = {
    kind: 'collection',
    key: 'collection-1',
    name: 'Review kit',
    description: '',
    source: '',
    sourceSubtitle: '',
    sourceIcon: 'folder',
  };

  it('partitions portable refs from local-only entries instead of failing', () => {
    const result = deriveShareablePluginsLenient(
      {
        collectionIds: ['collection-1'],
        skillRefs: [
          { sourceId: 'source-a', skillName: 'portable' },
          { sourceId: 'local', skillName: 'only-here' },
        ],
        pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'private' }],
      },
      [portableSkillRow, collectionRow],
    );

    expect(result.plugins).toEqual([
      {
        type: 'skill',
        source: { type: 'builtin', id: 'app' },
        skill_name: 'portable',
      },
    ]);
    expect(result.dropped).toEqual([
      'Review kit',
      'local/only-here',
      'mkt/private',
    ]);
  });

  it('drops nothing for an empty selection', () => {
    expect(
      deriveShareablePluginsLenient(
        { collectionIds: [], skillRefs: [], pluginRefs: [] },
        [portableSkillRow],
      ),
    ).toEqual({ plugins: [], dropped: [] });
  });

  it('keeps only unpackageable selections in the dropped list after packaging', () => {
    expect(
      deriveShareablePluginsLenient(
        {
          collectionIds: ['collection-1'],
          skillRefs: [{ sourceId: 'local', skillName: 'only-here' }],
          pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'private' }],
          mcpServerRefs: [{ serverId: 'local-server', configId: 'config-1' }],
        },
        [collectionRow],
        { packageLocalCapabilities: true },
      ).dropped,
    ).toEqual(['local-server']);
  });

  it('leaves the strict Agent helper all-or-nothing contract untouched', () => {
    expect(
      deriveShareableAgentPlugins(
        {
          collectionIds: ['collection-1'],
          skillRefs: [],
          pluginRefs: [],
        },
        [portableSkillRow, collectionRow],
      ),
    ).toEqual({ ok: false });
  });
});
