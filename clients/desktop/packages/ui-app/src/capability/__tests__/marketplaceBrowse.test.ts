import {
  DEFAULT_PIPELINE_FILTERS,
  type PipelineFilterValues,
  type UnifiedPipelineFacets,
  type UnifiedPluginEntry,
} from '@canopy/ui-shared/lib';
import {
  buildMarketplaceBrowseGroups,
  filterMarketplaceEntries,
  marketplaceCategoryPageEntries,
  type MarketplaceBrowseGroup,
} from '../marketplaceBrowse';
import { searchUnifiedEntries } from '../unifiedPluginEntries';

function entry(
  overrides: Partial<UnifiedPluginEntry> & Pick<UnifiedPluginEntry, 'id'>,
): UnifiedPluginEntry {
  return {
    kind: 'plugin',
    origin: 'marketplace',
    name: overrides.id,
    description: '',
    categories: [],
    components: { skills: 0, mcpServers: 0, commands: 0, agents: 0 },
    providerSupport: { claude: true, codex: false },
    state: 'available',
    recommended: false,
    ref: {
      type: 'marketplace-plugin',
      marketplaceId: 'acme',
      pluginName: overrides.id,
    },
    ...overrides,
  };
}

function pipeline(
  id: string,
  facets: UnifiedPipelineFacets,
  state: UnifiedPluginEntry['state'] = 'installed',
): UnifiedPluginEntry {
  return entry({
    id,
    kind: 'pipeline',
    origin: facets.source === 'curated' ? 'curated' : 'project',
    state,
    pipeline: facets,
    ref: { type: 'pipeline', pipelineId: id, source: 'project' },
  });
}

const reviewPipeline = pipeline('review', {
  source: 'project',
  scopes: ['worktree'],
  triggerTypes: ['plan_ready'],
});
const nightlyPipeline = pipeline('nightly', {
  source: 'curated',
  scopes: ['global', 'directory'],
  triggerTypes: ['dispatch'],
});
const plugin = entry({ id: 'acme-plugin' });
const collection = entry({
  id: 'bundle',
  kind: 'collection',
  origin: 'installed-standalone',
  state: 'installed',
  ref: { type: 'local-collection', collectionId: 'bundle' },
});
describe('filterMarketplaceEntries', () => {
  const all = [plugin, reviewPipeline, nightlyPipeline, collection];

  it('keeps every entry on the All tab with no pipeline filters', () => {
    expect(
      filterMarketplaceEntries(all, {
        kindFilter: null,
        pipelineFilters: DEFAULT_PIPELINE_FILTERS,
      }),
    ).toEqual(all);
  });

  it('narrows to the selected kind', () => {
    expect(
      filterMarketplaceEntries(all, {
        kindFilter: 'pipeline',
        pipelineFilters: DEFAULT_PIPELINE_FILTERS,
      }).map((item) => item.id),
    ).toEqual(['review', 'nightly']);
  });

  it.each<[string, PipelineFilterValues, string[]]>([
    [
      'source',
      { source: 'curated', scope: 'all', trigger: 'all' },
      ['nightly'],
    ],
    ['scope', { source: 'all', scope: 'worktree', trigger: 'all' }, ['review']],
    [
      'trigger',
      { source: 'all', scope: 'all', trigger: 'dispatch' },
      ['nightly'],
    ],
    ['combined', { source: 'project', scope: 'global', trigger: 'all' }, []],
  ])('filters pipelines by %s', (_label, pipelineFilters, expected) => {
    expect(
      filterMarketplaceEntries(all, {
        kindFilter: 'pipeline',
        pipelineFilters,
      }).map((item) => item.id),
    ).toEqual(expected);
  });

  it('never hides other kinds because of a pipeline filter', () => {
    expect(
      filterMarketplaceEntries(all, {
        kindFilter: null,
        pipelineFilters: { source: 'curated', scope: 'all', trigger: 'all' },
      }).map((item) => item.id),
    ).toEqual(['acme-plugin', 'nightly', 'bundle']);
  });
});

describe('buildMarketplaceBrowseGroups', () => {
  it('excludes a partial removal from standalone Browse using the same host snapshot as Installed (CAN-5272)', () => {
    const partial = entry({ id: 'partial', categories: ['productivity'] });
    const groups = buildMarketplaceBrowseGroups(
      searchUnifiedEntries([partial], '', null),
      {
        installedStatusStates: {
          partial: {
            kind: 'ready',
            item: {
              target: { kind: 'plugin', marketplaceId: 'm', pluginName: 'p' },
              status: null,
              removable: true,
              notices: [
                { code: 'partial_removal', message: 'Retry.', retryable: true },
              ],
            },
            configurations: [],
          },
        },
      },
    );
    expect(groups.flatMap((group) => group.entries)).toEqual([]);
  });

  it('excludes installed and needs-auth entries from standalone category pages (CAN-5272)', () => {
    const rows = [
      entry({
        id: 'installed',
        state: 'installed',
        categories: ['productivity'],
      }),
      entry({
        id: 'needs-auth',
        state: 'needs-auth',
        categories: ['productivity'],
      }),
      entry({ id: 'available', categories: ['productivity'] }),
      entry({
        id: 'alias',
        installedEntryId: 'installed',
        categories: ['productivity'],
      }),
    ];
    const groups = buildMarketplaceBrowseGroups(
      searchUnifiedEntries(rows, '', null),
    );
    const category = groups.find(
      (group) => group.id === 'category-productivity',
    );
    expect(category?.entries.map((row) => row.id)).toEqual(['available']);
    expect(
      category && marketplaceCategoryPageEntries(category, 'installed'),
    ).toEqual([]);
  });

  it('falls back to the featured picks when the host has no role suggestions', () => {
    const results = searchUnifiedEntries([plugin], '', null);
    expect(buildMarketplaceBrowseGroups(results)[0]).toMatchObject({
      id: 'suggested',
      title: 'Suggested',
    });
  });

  it('uses only host-resolved suggestions when provided', () => {
    const results = searchUnifiedEntries([plugin], '', null);
    const [suggested] = buildMarketplaceBrowseGroups(results, {
      suggestedNames: [],
    });
    expect(suggested.entries).toEqual([]);
  });

  // The category pages build from these groups without the section model,
  // so they must list a bundled server as its plugin too (CAN-3653).
  it('keeps installed bundled servers out of Browse even when they need attention', () => {
    const bundled = entry({
      id: 'mcp-local:team-chat',
      name: 'Team chat server',
      kind: 'app',
      origin: 'installed-standalone',
      state: 'installed',
      ref: { type: 'local-mcp', serverId: 'team-chat' },
      bundledBy: { entryId: 'mkt:acme/team-chat', name: 'Team chat' },
    });
    const unreachable = {
      ...bundled,
      id: 'mcp-local:team-chat-2',
      name: 'Team chat backup',
      connection: { status: 'unreachable' as const },
    };
    const listed = buildMarketplaceBrowseGroups(
      searchUnifiedEntries([bundled, unreachable], '', null),
      { suggestedNames: [] },
    ).flatMap((group) => group.entries.map((row) => row.id));
    expect(listed).not.toContain(bundled.id);
    expect(listed).not.toContain(unreachable.id);
  });
});

describe('marketplaceCategoryPageEntries', () => {
  const group: MarketplaceBrowseGroup = {
    id: 'category-productivity',
    title: 'Productivity',
    entries: [entry({ id: 'notes' }), entry({ id: 'calendar' })],
  };

  it('returns the whole group with no query', () => {
    expect(marketplaceCategoryPageEntries(group, '  ')).toEqual(group.entries);
  });

  it('narrows the group by its own search', () => {
    expect(
      marketplaceCategoryPageEntries(group, 'calen').map((item) => item.id),
    ).toEqual(['calendar']);
  });
});
