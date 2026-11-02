import type {
  InstalledEntryStatusState,
  InstalledEntryStatusStates,
  UnifiedPluginEntry,
} from '@canopy/ui-shared/lib';
import { installedEntryStatusStates } from '@canopy/ui-shared/lib';
import {
  buildCustomizeTabModel,
  CUSTOMIZE_INSTALLED_PREVIEW_LIMIT,
  WORKFLOW_INSTALLED_FOOTNOTE,
  customizeTabHasInstalledStatuses,
  extendInstalledStatusSnapshot,
  installedStatusMatches,
  statusEntryIdOf,
  type CustomizeSectionModel,
  type CustomizeTabModelInput,
  type CustomizeTabModel,
} from '../customizeSections';
import type { SharedSkillSummary } from '@canopy/protocol/skills';
import { buildUnifiedPluginEntries } from '../unifiedPluginEntries';

function entry(
  id: string,
  overrides: Partial<UnifiedPluginEntry> = {},
): UnifiedPluginEntry {
  return {
    id,
    kind: 'skill',
    origin: 'shared',
    name: id,
    description: '',
    categories: [],
    components: { skills: 1, mcpServers: 0, commands: 0, agents: 0 },
    providerSupport: { claude: false, codex: false },
    state: 'available',
    recommended: false,
    ref: { type: 'skill', sourceId: 'github:example:repo', skillName: id },
    ...overrides,
  };
}
function model(
  entries: UnifiedPluginEntry[],
  options: Partial<CustomizeTabModelInput> = {},
): CustomizeTabModel {
  return buildCustomizeTabModel({
    tab: 'all',
    entries,
    installedInventory: 'ready',
    ...options,
  });
}
function ids(rows: readonly UnifiedPluginEntry[]): string[] {
  return rows.map((row) => row.id);
}

it('orders sections and counts overlapping catalog entries only once', () => {
  const row = entry('shared installed', {
    state: 'installed',
    ownedByViewer: true,
    updateAvailable: true,
  });
  const result = model([row, row, entry('browse only')], {
    ownershipAvailable: true,
    supportedUpdateKinds: ['skill'],
  });
  expect(result.sections.map((section) => section.id)).toEqual([
    'updates',
    'installed',
    'shared-by-me',
    'browse',
  ]);
  expect(result.sections.map((section) => section.count)).toEqual([1, 1, 1, 1]);
  expect(result.resultCount).toBe(2);
  expect(result.sections.map((section) => section.domId)).toEqual([
    'customize-section-updates',
    'customize-section-installed',
    'customize-section-shared-by-me',
    'customize-section-browse',
  ]);
});

it('previews eight All installs but counts the full set; search and expansion expose all matches', () => {
  const entries = Array.from({ length: 12 }, (_, i) =>
    entry(`skill ${i}`, { state: 'installed', origin: 'installed-standalone' }),
  );
  expect(CUSTOMIZE_INSTALLED_PREVIEW_LIMIT).toBe(8);
  expect(model(entries).sections[0]).toMatchObject({
    previewLimit: 8,
    count: 12,
  });
  expect(model(entries).resultCount).toBe(12);
  for (const options of [
    { query: 'skill' },
    { installedExpanded: true },
    { tab: 'skill' as const },
  ]) {
    expect(model(entries, options).sections[0].previewLimit).toBeUndefined();
    expect(model(entries, options).sections[0].count).toBe(12);
  }
  expect(model(entries, { query: ' \n ' }).searchActive).toBe(false);
});

it('searches owned shares and every section while preserving stable input order', () => {
  const result = model(
    [
      entry('zebra match', { state: 'installed', updateAvailable: true }),
      entry('absent', { state: 'installed' }),
      entry('alpha match', { ownedByViewer: true }),
    ],
    {
      query: 'match',
      ownershipAvailable: true,
      supportedUpdateKinds: ['skill'],
    },
  );
  expect(
    ids(
      result.sections.find((section) => section.id === 'installed')?.entries ??
        [],
    ),
  ).toEqual(['zebra match']);
  // CAN-5272: the installed match is not repeated in Browse.
  expect(
    ids(
      result.sections.find((section) => section.id === 'browse')?.entries ?? [],
    ),
  ).toEqual(['alpha match']);
  expect(
    result.sections.find((section) => section.id === 'shared-by-me')?.count,
  ).toBe(1);
  expect(result.resultCount).toBe(2);
});

it('keeps pipeline facets exclusive to Browse pipelines, preserving automations and management rows', () => {
  const result = model(
    [
      entry('pipeline', {
        kind: 'pipeline',
        state: 'installed',
        origin: 'curated',
      }),
      entry('automation', { kind: 'automation', origin: 'curated' }),
      entry('owned pipeline', { kind: 'pipeline', ownedByViewer: true }),
    ],
    {
      tab: 'workflow',
      ownershipAvailable: true,
      pipelineFilters: { source: 'user', scope: 'all', trigger: 'all' },
    },
  );
  expect(result.sections.map((section) => section.id)).toEqual([
    'installed',
    'shared-by-me',
    'browse',
  ]);
  expect(ids(result.sections[0].entries)).toEqual(['pipeline']);
  expect(ids(result.sections[1].entries)).toEqual(['owned pipeline']);
  expect(ids(result.sections[2].entries)).toEqual(['automation']);
  expect(result.sections.some((section) => section.showEntryTypes)).toBe(false);
});

it('shows entry types only on the All tab', () => {
  const result = model(
    [
      entry('installed', { state: 'installed', updateAvailable: true }),
      entry('owned', { ownedByViewer: true }),
      entry('browse'),
    ],
    { ownershipAvailable: true, supportedUpdateKinds: ['skill'] },
  );
  expect(result.sections.length).toBeGreaterThan(1);
  expect(result.sections.every((section) => section.showEntryTypes)).toBe(true);
});

it.each([
  ['plugin', 'Installed', 'Browse plugins'],
  ['app', 'Installed', 'Browse MCP servers'],
  ['skill', 'Installed', 'Browse skills'],
  ['collection', 'Added', 'Browse collections'],
  ['agent', 'Your agents', 'Shared with you'],
  ['blueprint', null, 'Browse project templates'],
] as const)(
  'models %s section eligibility and titles',
  (kind, title, browseTitle) => {
    const result = model(
      [
        entry(kind, {
          kind,
          state: 'needs-auth',
          ownedByViewer: true,
          updateAvailable: true,
        }),
        // Browse lists only what is not installed (CAN-5272).
        entry(`${kind} to add`, { kind, ownedByViewer: true }),
      ],
      {
        tab: kind,
        ownershipAvailable: true,
        agentsAvailable: true,
        projectTemplatesAvailable: true,
      },
    );
    expect(
      result.sections.find((section) => section.id === 'installed')?.title ??
        null,
    ).toBe(title);
    expect(
      result.sections.find((section) => section.id === 'browse')?.title,
    ).toBe(browseTitle);
    // CAN-4840: single-kind tabs already name the kind in the tab.
    expect(result.sections.some((section) => section.showEntryTypes)).toBe(
      false,
    );
    expect(result.sections.some((section) => section.id === 'updates')).toBe(
      false,
    );
    expect(
      result.sections.some((section) => section.id === 'shared-by-me'),
    ).toBe(kind !== 'app');
  },
);

it('requires real sharing and explicit ownership independently of inventory access', () => {
  const rows = [
    entry('private', { origin: 'installed-standalone', ownedByViewer: true }),
    entry('owned', { ownedByViewer: true }),
    entry('unknown'),
  ];
  for (const installedInventory of [
    'ready',
    'loading',
    'unavailable',
    'error',
  ] as const) {
    const result = model(rows, {
      installedInventory,
      ownershipAvailable: true,
    });
    expect(
      ids(
        result.sections.find((section) => section.id === 'shared-by-me')
          ?.entries ?? [],
      ),
    ).toEqual(['owned']);
    const installed = result.sections.find(
      (section) => section.id === 'installed',
    );
    expect(installed?.inventoryState).toBe(
      installedInventory === 'ready' ? undefined : installedInventory,
    );
  }
  expect(
    model(rows).sections.some((section) => section.id === 'shared-by-me'),
  ).toBe(false);
});

it('offers updates only for supported skill/automation actions and batches only eligible skills', () => {
  const rows = [
    entry('normal', { state: 'installed', updateAvailable: true }),
    entry('second', { state: 'needs-auth', updateAvailable: true }),
    entry('builtin', {
      state: 'installed',
      updateAvailable: true,
      builtIn: true,
    }),
    entry('custom', {
      state: 'installed',
      updateAvailable: true,
      custom: true,
    }),
    entry('automation', {
      kind: 'automation',
      state: 'installed',
      updateAvailable: true,
      ref: { type: 'automation', activityId: 'local' },
    }),
    entry('plugin', {
      kind: 'plugin',
      state: 'installed',
      updateAvailable: true,
    }),
    entry('available', { updateAvailable: true }),
  ];
  const result = model(rows, { supportedUpdateKinds: ['skill', 'automation'] });
  expect(ids(result.sections[0].entries)).toEqual([
    'normal',
    'second',
    'automation',
  ]);
  expect(ids(result.batchableUpdates)).toEqual(['normal', 'second']);
  expect(result.showUpdateAll).toBe(true);
  expect(model(rows).sections.some((section) => section.id === 'updates')).toBe(
    false,
  );
  expect(
    model(rows, {
      query: 'automation',
      supportedUpdateKinds: ['skill', 'automation'],
    }).showUpdateAll,
  ).toBe(false);
});

it('hides empty sections except filtered/searched Browse workflows and gated inventory', () => {
  expect(model([]).sections).toEqual([]);
  expect(
    model([], { tab: 'workflow', query: 'nothing' }).sections[0],
  ).toMatchObject({ id: 'browse', emptyReason: 'search', count: 0 });
  expect(
    model([], {
      tab: 'workflow',
      pipelineFilters: { source: 'user', scope: 'all', trigger: 'all' },
    }).sections[0],
  ).toMatchObject({ id: 'browse', emptyReason: 'pipeline-filters' });
  expect(
    model([], { installedInventory: 'unavailable' }).sections[0],
  ).toMatchObject({ id: 'installed', inventoryState: 'unavailable' });
});

it('keeps All browse bands and limits and combines plugin/MCP bands during search', () => {
  const rows = [
    entry('shared plugin', { kind: 'plugin' }),
    entry('skill'),
    entry('pipeline', { kind: 'pipeline' }),
    entry('automation', { kind: 'automation' }),
    entry('agent', { kind: 'agent' }),
  ];
  const browse = model(rows).sections.find(
    (section) => section.id === 'browse',
  );
  expect(browse?.groups?.map((group) => group.id)).toEqual([
    'shared-plugins',
    'skills',
    'workflows',
  ]);
  const searched = model(rows, { query: 'shared' }).sections[0];
  expect(searched.groups?.map((group) => group.title)).toEqual([
    'Plugins and MCP servers',
  ]);
});

it('lists one canonical install and keeps its catalog representation out of Browse', () => {
  const local = entry('local', {
    kind: 'automation',
    origin: 'installed-standalone',
    state: 'installed',
    ref: { type: 'automation', activityId: 'a' },
  });
  const catalog = entry('catalog', {
    kind: 'automation',
    origin: 'shared',
    state: 'installed',
    installedEntryId: 'local',
    ownedByViewer: true,
  });
  const result = model([catalog, local], {
    tab: 'workflow',
    ownershipAvailable: true,
  });
  expect(
    ids(
      result.sections.find((section) => section.id === 'installed')?.entries ??
        [],
    ),
  ).toEqual(['local']);
  expect(
    result.sections.find((section) => section.id === 'browse'),
  ).toBeUndefined();
  expect(
    result.sections.find((section) => section.id === 'shared-by-me')?.count,
  ).toBe(1);
});

it('folds an installed shared skill into its local copy (CAN-5223)', () => {
  const share = (id: string, name: string): SharedSkillSummary => ({
    id,
    name,
    description: '',
    contentHash: 'c'.repeat(64),
    shareScope: 'organization',
    owner: { type: 'organization', id: 'org-1', name: 'Northwind' },
    createdBy: { id: 'user-ada', name: 'Ada', email: 'ada@example.com' },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    canUpdate: true,
    canDelete: true,
    publicShare: null,
  });
  const entries = buildUnifiedPluginEntries({
    viewerId: 'user-ada',
    curatedPlugins: [],
    marketplaces: [],
    mcpServers: [],
    mcpStatuses: [],
    curatedMcpServers: [],
    providerConnectors: [],
    installedSkills: [
      {
        name: 'review-helper',
        sourceId: 'custom:app',
        description: '',
        custom: true,
        installedFromShare: { remoteId: 'share-1', sharedByName: 'Ada' },
      },
    ],
    sharedSkills: [
      share('share-1', 'Review Helper'),
      share('share-2', 'Other Helper'),
    ],
  });
  const result = model(entries, { tab: 'skill', ownershipAvailable: true });
  const section = (id: string): readonly UnifiedPluginEntry[] =>
    result.sections.find((candidate) => candidate.id === id)?.entries ?? [];

  expect(ids(section('installed'))).toEqual(['skill:custom:app:review-helper']);
  expect(ids(section('browse'))).toEqual(['skill:shared:share-2']);
  expect(ids(section('shared-by-me'))).toEqual([
    'skill:shared:share-1',
    'skill:shared:share-2',
  ]);
});

it('preserves known cloud/project installs alongside unavailable desktop inventory', () => {
  const result = model(
    [entry('saved cloud skill', { state: 'installed', surface: 'cloud' })],
    { installedInventory: 'unavailable' },
  );
  expect(
    result.sections.find((section) => section.id === 'installed'),
  ).toMatchObject({ inventoryState: 'unavailable', count: 1 });
  expect(result.resultCount).toBe(1);
});

it('excludes unpublished private cloud records from Shared by me and Browse', () => {
  const result = model(
    [
      entry('private cloud', {
        origin: 'shared',
        ownedByViewer: true,
        isShared: false,
      }),
      entry('public link', { ownedByViewer: true, isShared: true }),
    ],
    { ownershipAvailable: true },
  );
  expect(result.sections.map((section) => ids(section.entries))).toEqual([
    ['public link'],
    ['public link'],
  ]);
  expect(result.resultCount).toBe(1);
});

it('retains ranked remote matches without bypassing tab or Browse-only filters', () => {
  const result = model(
    [
      entry('remote', { kind: 'pipeline', state: 'installed' }),
      entry('other kind', { kind: 'skill' }),
    ],
    {
      tab: 'workflow',
      query: 'server-only metadata',
      searchMatchedEntryIds: ['remote', 'other kind'],
      pipelineFilters: { source: 'user', scope: 'all', trigger: 'all' },
    },
  );
  expect(
    result.sections
      .find((section) => section.id === 'installed')
      ?.entries.map((row) => row.id),
  ).toEqual(['remote']);
  expect(
    result.sections.find((section) => section.id === 'browse')?.count,
  ).toBe(0);
  expect(result.resultCount).toBe(1);
});

it('applies pipeline categories only to Browse pipelines', () => {
  const rows = [
    entry('installed', {
      kind: 'pipeline',
      state: 'installed',
      categories: ['other'],
    }),
    entry('browse', { kind: 'pipeline', categories: ['other'] }),
    entry('matching', { kind: 'pipeline', categories: ['Development'] }),
    entry('automation', { kind: 'automation' }),
  ];
  const result = model(rows, {
    tab: 'workflow',
    pipelineCategory: 'development',
  });
  expect(
    result.sections
      .find((section) => section.id === 'installed')
      ?.entries.map((row) => row.id),
  ).toEqual(['installed']);
  expect(
    result.sections
      .find((section) => section.id === 'browse')
      ?.entries.map((row) => row.id),
  ).toEqual(['matching', 'automation']);
});

describe('CAN-3653 — plugin-bundled MCP rows', () => {
  const bundled = entry('mcp-local:slack-codex-plugin', {
    kind: 'app',
    origin: 'installed-standalone',
    name: 'Slack',
    state: 'installed',
    ref: { type: 'local-mcp', serverId: 'slack-codex-plugin' },
    bundledBy: { entryId: 'mkt:openai-curated/slack', name: 'Slack' },
  });
  const standalone = entry('mcp-local:team-notes', {
    kind: 'app',
    origin: 'installed-standalone',
    name: 'Team notes MCP',
    state: 'installed',
    ref: { type: 'local-mcp', serverId: 'team-notes' },
  });

  it('excludes explicit installedVia catalog MCPs from Browse while preserving the owner and unclaimed sources', () => {
    const owner = entry('mkt:openai-curated/slack', {
      kind: 'plugin',
      origin: 'marketplace',
      name: 'Slack',
      state: 'installed',
      ref: {
        type: 'marketplace-plugin',
        marketplaceId: 'openai-curated',
        pluginName: 'slack',
      },
      bundledServerRows: [
        {
          serverName: 'slack',
          endpoint: 'http:mcp.slack.example',
          entryId: bundled.id,
          serverId: 'slack-codex-plugin',
        },
      ],
    });
    const catalog = entry('mcp-catalog:slack', {
      kind: 'app',
      origin: 'curated',
      name: 'Slack',
      categories: ['productivity'],
      ref: { type: 'curated-mcp', key: 'slack' },
      installedVia: { entryId: owner.id, name: owner.name },
    });
    const distinctPackage = entry('mkt:claude-plugins-official/slack', {
      kind: 'plugin',
      origin: 'marketplace',
      name: 'Slack',
      ref: {
        type: 'marketplace-plugin',
        marketplaceId: 'claude-plugins-official',
        pluginName: 'slack',
      },
    });
    const unclaimedProvider = entry('mcp-catalog:slack-unclaimed', {
      kind: 'app',
      origin: 'curated',
      name: 'Slack',
      categories: ['productivity'],
      ref: { type: 'curated-mcp', key: 'slack-unclaimed' },
    });
    // All search and the MCP tab expose individual catalog identities;
    // unsearched All separately curates its suggested/category groups.
    for (const [tab, query] of [
      ['all', 'slack'],
      ['app', undefined],
      ['app', 'slack'],
    ] as const) {
      const result = model(
        [owner, bundled, catalog, distinctPackage, unclaimedProvider],
        { tab, query },
      );
      const browseIds = ids(
        result.sections.find((section) => section.id === 'browse')?.entries ??
          [],
      );
      expect(browseIds).not.toContain(catalog.id);
      expect(browseIds.sort()).toEqual(
        (tab === 'all'
          ? [distinctPackage.id, unclaimedProvider.id]
          : [unclaimedProvider.id]
        ).sort(),
      );
      if (tab === 'all') {
        const installed = result.sections.find(
          (section) => section.id === 'installed',
        );
        expect(installed?.entries).toEqual([owner]);
        expect(installed?.entries[0]).toBe(owner);
        expect(installed?.entries[0]?.bundledServerRows?.[0]?.entryId).toBe(
          bundled.id,
        );
      }
    }
    expect(catalog.state).toBe('available');
    expect(catalog.installedVia).toEqual({
      entryId: owner.id,
      name: owner.name,
    });
  });

  it('hides plugin-bundled MCP rows from Installed, Browse, search and the result count', () => {
    for (const tab of ['all', 'app'] as const) {
      for (const query of [undefined, 'slack']) {
        const result = model([bundled, standalone], { tab, query });
        const listed = result.sections.flatMap((section) =>
          ids(section.entries),
        );
        expect(listed).not.toContain(bundled.id);
        expect(result.resultCount).toBe(query === undefined ? 1 : 0);
      }
      expect(
        ids(
          model([bundled, standalone], { tab }).sections.find(
            (section) => section.id === 'installed',
          )?.entries ?? [],
        ),
      ).toEqual([standalone.id]);
    }
  });

  it('keeps a bundled row that needs attention in Installed', () => {
    // Hiding it would also hide its Needs attention badge and Connect action.
    const needsAuth = { ...bundled, state: 'needs-auth' as const };
    expect(
      ids(
        model([needsAuth, standalone], { tab: 'app' }).sections.find(
          (section) => section.id === 'installed',
        )?.entries ?? [],
      ),
    ).toContain(needsAuth.id);
  });

  it('keeps an unreachable bundled row in Installed', () => {
    // Its failure would otherwise show nowhere in Customize.
    const unreachable = {
      ...bundled,
      connection: { status: 'unreachable' as const },
    };
    expect(
      ids(
        model([unreachable, standalone], { tab: 'app' }).sections.find(
          (section) => section.id === 'installed',
        )?.entries ?? [],
      ),
    ).toContain(unreachable.id);
  });

  it('shows the Installed empty state when the only installed MCP row is bundled', () => {
    expect(
      model([bundled], { tab: 'app' }).sections.map((section) => section.id),
    ).toEqual(model([], { tab: 'app' }).sections.map((section) => section.id));
  });
});

describe('CAN-4845 — Workflows Installed footnote', () => {
  function installedSection(
    tab: CustomizeTabModelInput['tab'],
  ): CustomizeTabModel['sections'][number] | undefined {
    const row = entry('nightly', {
      kind: tab === 'skill' ? 'skill' : 'pipeline',
      state: 'installed',
      origin: 'installed-standalone',
      ref:
        tab === 'skill'
          ? { type: 'skill', sourceId: 'local', skillName: 'nightly' }
          : { type: 'pipeline', pipelineId: 'nightly', source: 'user' },
    });
    return model([row], { tab }).sections.find(
      (section) => section.id === 'installed',
    );
  }

  it('explains when workflows run on the Workflows tab only', () => {
    expect(installedSection('workflow')?.footnote).toBe(
      WORKFLOW_INSTALLED_FOOTNOTE,
    );
    expect(installedSection('skill')?.footnote).toBeUndefined();
    expect(installedSection('all')?.footnote).toBeUndefined();
  });
});

describe('CAN-4838 installed status filter', () => {
  const ready = (
    status: 'active' | 'available' | 'disabled' | null,
  ): InstalledEntryStatusState => ({
    kind: 'ready',
    item: {
      target: { kind: 'skill', sourceId: 's', skillName: 'x' },
      status,
      removable: true,
      notices: [],
    },
    configurations: [],
  });
  const installed = (id: string): UnifiedPluginEntry =>
    entry(id, { state: 'installed', origin: 'installed-standalone' });
  const pipeline = (id: string): UnifiedPluginEntry =>
    entry(id, {
      state: 'installed',
      origin: 'installed-standalone',
      kind: 'pipeline',
      ref: { type: 'pipeline', source: 'bundled', pipelineId: id },
    });
  const installedSection = (
    result: CustomizeTabModel,
  ): CustomizeSectionModel | undefined =>
    result.sections.find((section) => section.id === 'installed');

  it.each(['all', 'plugin', 'app', 'skill', 'collection'] as const)(
    '%s has statuses',
    (tab) => expect(customizeTabHasInstalledStatuses(tab)).toBe(true),
  );
  it.each(['workflow', 'agent', 'sources', 'blueprint'] as const)(
    '%s has none',
    (tab) => expect(customizeTabHasInstalledStatuses(tab)).toBe(false),
  );

  it('narrows Installed and its count to the chosen status and hides Browse', () => {
    const result = model(
      [installed('a'), installed('b'), entry('browse', { origin: 'curated' })],
      {
        installedStatusFilter: 'disabled',
        installedStatusStates: { a: ready('disabled'), b: ready('active') },
      },
    );
    expect(ids(installedSection(result)?.entries ?? [])).toEqual(['a']);
    expect(installedSection(result)?.count).toBe(1);
    expect(
      result.sections.find((section) => section.id === 'browse'),
    ).toBeUndefined();
  });

  it('hides status-less entries on All under a status filter and shows them under Any status', () => {
    const rows = [installed('a'), pipeline('p')];
    const filtered = model(rows, {
      tab: 'all',
      installedStatusFilter: 'active',
      installedStatusStates: { a: ready('active') },
    });
    expect(ids(installedSection(filtered)?.entries ?? [])).toEqual(['a']);
    const unfiltered = model(rows, {
      tab: 'all',
      installedStatusStates: { a: ready('active') },
    });
    expect(installedSection(unfiltered)?.entries).toHaveLength(2);
  });

  it('prefers the membership snapshot over the live status', () => {
    const result = model([installed('a')], {
      tab: 'skill',
      installedStatusFilter: 'disabled',
      installedStatusStates: { a: ready('available') },
      installedStatusSnapshot: { a: true },
    });
    expect(installedSection(result)?.entries).toHaveLength(1);
  });

  it('ignores installedStatusFilter on tabs without statuses', () => {
    const result = model([pipeline('p')], {
      tab: 'workflow',
      installedStatusFilter: 'active',
    });
    expect(installedSection(result)?.entries).toHaveLength(1);
  });

  it('extendInstalledStatusSnapshot pins newly ready entries and returns the same reference when nothing changed', () => {
    const rows = [installed('a'), installed('b')];
    const first = extendInstalledStatusSnapshot({}, 'active', rows, {
      a: ready('active'),
      b: { kind: 'loading' },
    });
    expect(first).toEqual({ a: true });
    expect(
      extendInstalledStatusSnapshot(first, 'active', rows, {
        a: ready('disabled'),
        b: { kind: 'loading' },
      }),
    ).toBe(first);
    const second = extendInstalledStatusSnapshot(first, 'active', rows, {
      a: ready('active'),
      b: ready('available'),
    });
    expect(second).toEqual({ a: true, b: false });
    expect(first).toEqual({ a: true });
  });

  it('installedStatusMatches keeps pending statuses visible and treats null as active', () => {
    expect(
      installedStatusMatches(installed('a'), 'disabled', { kind: 'loading' }),
    ).toBe(true);
    // CAN-5272: an unreadable status proves no match.
    expect(
      installedStatusMatches(installed('a'), 'disabled', {
        kind: 'read-only',
        reason: 'x',
      }),
    ).toBe(false);
    for (const filter of ['active', 'available', 'disabled'] as const)
      expect(
        installedStatusMatches(installed('a'), filter, {
          kind: 'fixed',
          status: 'active',
          reason: 'x',
        }),
      ).toBe(filter === 'active');
    expect(installedStatusMatches(installed('a'), 'disabled', undefined)).toBe(
      true,
    );
    expect(installedStatusMatches(pipeline('p'), 'active', undefined)).toBe(
      false,
    );
    expect(installedStatusMatches(pipeline('p'), 'disabled', undefined)).toBe(
      false,
    );
    // Built-in workflows render a fixed Available status, so they match it.
    expect(installedStatusMatches(pipeline('p'), 'available', undefined)).toBe(
      true,
    );
    expect(
      installedStatusMatches(
        entry('user-p', {
          state: 'installed',
          origin: 'installed-standalone',
          kind: 'pipeline',
          ref: { type: 'pipeline', source: 'user', pipelineId: 'user-p' },
        }),
        'available',
        undefined,
      ),
    ).toBe(false);
    expect(
      installedStatusMatches(installed('a'), 'active', ready('active')),
    ).toBe(true);
    expect(
      installedStatusMatches(installed('a'), 'available', ready('active')),
    ).toBe(false);
    expect(installedStatusMatches(installed('a'), 'active', ready(null))).toBe(
      true,
    );
    expect(
      installedStatusMatches(installed('a'), 'disabled', ready(null)),
    ).toBe(false);
  });
});

describe('CAN-5272 status filter across sections and Browse de-duplication', () => {
  const ready = (
    status: 'active' | 'available' | 'disabled' | null,
  ): InstalledEntryStatusState => ({
    kind: 'ready',
    item: {
      target: { kind: 'skill', sourceId: 's', skillName: 'x' },
      status,
      removable: true,
      notices: [],
    },
    configurations: [],
  });
  const section = (
    result: CustomizeTabModel,
    id: CustomizeSectionModel['id'],
  ): CustomizeSectionModel | undefined =>
    result.sections.find((candidate) => candidate.id === id);
  const sectionIds = (
    result: CustomizeTabModel,
    id: CustomizeSectionModel['id'],
  ): string[] => ids(section(result, id)?.entries ?? []);
  const installedSkill = (
    id: string,
    overrides: Partial<UnifiedPluginEntry> = {},
  ): UnifiedPluginEntry =>
    entry(id, {
      state: 'installed',
      origin: 'installed-standalone',
      updateAvailable: true,
      ...overrides,
    });
  // An owned catalog share whose local install has a different id.
  const share = (id: string, local: string): UnifiedPluginEntry =>
    entry(id, {
      state: 'installed',
      installedEntryId: local,
      ownedByViewer: true,
    });
  const rows = [
    installedSkill('active'),
    installedSkill('available'),
    installedSkill('disabled'),
    share('share active', 'active'),
    share('share available', 'available'),
    entry('browse only', { origin: 'curated' }),
  ];
  const states = {
    active: ready('active'),
    available: ready('available'),
    disabled: ready('disabled'),
    // The catalog row's own read conflicts with its installed copy.
    'share active': ready('disabled'),
    'share available': ready('active'),
  };
  const options: Partial<CustomizeTabModelInput> = {
    ownershipAvailable: true,
    supportedUpdateKinds: ['skill'],
    installedStatusStates: states,
  };

  it.each(['active', 'available', 'disabled'] as const)(
    'narrows Installed, Updates and Shared by me to %s and hides Browse',
    (status) => {
      const result = model(rows, {
        ...options,
        installedStatusFilter: status,
      });
      expect(sectionIds(result, 'installed')).toEqual([status]);
      expect(sectionIds(result, 'updates')).toEqual([status]);
      expect(section(result, 'updates')?.count).toBe(1);
      expect(ids(result.batchableUpdates)).toEqual([status]);
      expect(result.showUpdateAll).toBe(false);
      expect(sectionIds(result, 'shared-by-me')).toEqual(
        status === 'disabled' ? [] : [`share ${status}`],
      );
      expect(section(result, 'browse')).toBeUndefined();
      // The share is the same canonical item as its installed copy.
      expect(result.resultCount).toBe(1);
    },
  );

  it('restores every section and Browse under Any status', () => {
    const result = model(rows, options);
    expect(sectionIds(result, 'installed')).toEqual([
      'active',
      'available',
      'disabled',
    ]);
    expect(ids(result.batchableUpdates)).toHaveLength(3);
    expect(sectionIds(result, 'shared-by-me')).toEqual([
      'share active',
      'share available',
    ]);
    expect(sectionIds(result, 'browse')).toEqual(['browse only']);
    expect(result.resultCount).toBe(4);
  });

  it('keeps Browse on tabs without installed statuses', () => {
    const pipeline = entry('pipe', {
      kind: 'pipeline',
      origin: 'curated',
      ref: { type: 'pipeline', source: 'user', pipelineId: 'pipe' },
    });
    const result = model([pipeline], {
      tab: 'workflow',
      installedStatusFilter: 'active',
    });
    expect(sectionIds(result, 'browse')).toEqual(['pipe']);
  });

  it('excludes resolved read-only rows under every filter and keeps loading rows provisionally', () => {
    const entries = [installedSkill('unreadable'), installedSkill('pending')];
    const installedStatusStates: Record<string, InstalledEntryStatusState> = {
      unreadable: { kind: 'read-only', reason: 'Offline.' },
      pending: { kind: 'loading' },
    };
    for (const status of ['active', 'available', 'disabled'] as const) {
      expect(
        sectionIds(
          model(entries, {
            installedStatusStates,
            installedStatusFilter: status,
          }),
          'installed',
        ),
      ).toEqual(['pending']);
    }
    expect(
      sectionIds(model(entries, { installedStatusStates }), 'installed'),
    ).toEqual(['unreadable', 'pending']);
  });

  it('honours true and false snapshots by canonical id unless a read-only state replaces them', () => {
    const entries = [installedSkill('a'), installedSkill('b')];
    const result = model(entries, {
      tab: 'skill',
      installedStatusFilter: 'active',
      installedStatusStates: { a: ready('disabled'), b: ready('active') },
      installedStatusSnapshot: { a: true, b: false },
    });
    expect(sectionIds(result, 'installed')).toEqual(['a']);
    const unreadable = model([installedSkill('a')], {
      tab: 'skill',
      installedStatusFilter: 'active',
      installedStatusStates: { a: { kind: 'read-only', reason: 'Offline.' } },
      installedStatusSnapshot: { a: true },
    });
    expect(sectionIds(unreadable, 'installed')).toEqual([]);
  });

  it('keys snapshot membership by the installed copy of a catalog alias', () => {
    const local = installedSkill('local');
    const alias = share('alias', 'local');
    expect(
      extendInstalledStatusSnapshot({}, 'active', [alias, local], {
        local: ready('active'),
        alias: ready('disabled'),
      }),
    ).toEqual({ local: true });
    const result = model([alias, local], {
      ownershipAvailable: true,
      installedStatusFilter: 'active',
      installedStatusStates: { local: ready('disabled') },
      installedStatusSnapshot: { local: true },
    });
    expect(sectionIds(result, 'shared-by-me')).toEqual(['alias']);
  });

  it('matches a fixed status only to its own filter, ignoring a stale snapshot', () => {
    const fixed: InstalledEntryStatusState = {
      kind: 'fixed',
      status: 'active',
      reason: 'Connected.',
    };
    for (const status of ['active', 'available', 'disabled'] as const)
      expect(
        sectionIds(
          model([installedSkill('gmail')], {
            installedStatusFilter: status,
            installedStatusStates: { gmail: fixed },
            installedStatusSnapshot: { gmail: true },
          }),
          'installed',
        ),
      ).toEqual(status === 'active' ? ['gmail'] : []);
    expect(
      extendInstalledStatusSnapshot(
        {},
        'available',
        [installedSkill('gmail')],
        {
          gmail: fixed,
        },
      ),
    ).toEqual({});
  });

  it('excludes a mixed provider/device connection with an Available device from Active', () => {
    const gmail = entry('gmail', {
      kind: 'app',
      state: 'installed',
      origin: 'curated',
      ref: { type: 'curated-mcp', key: 'gmail' },
      integration: {
        curatedKey: 'gmail',
        connections: [
          {
            serverId: 'provider',
            name: 'Claude',
            binding: 'provider',
            state: 'installed',
          },
          {
            serverId: 'device',
            name: 'Gmail',
            binding: 'device',
            state: 'installed',
          },
        ],
      },
    });
    const installedStatusStates = installedEntryStatusStates([gmail], {
      kind: 'ready',
      snapshot: {
        items: [
          {
            target: { kind: 'mcp-server', serverId: 'device' },
            status: 'available',
            removable: true,
            notices: [],
          },
        ],
      },
    });
    expect(installedStatusStates.gmail).toMatchObject({
      kind: 'ready',
      item: { status: 'available' },
    });
    expect(
      sectionIds(
        model([gmail], {
          installedStatusStates,
          installedStatusFilter: 'active',
        }),
        'installed',
      ),
    ).toEqual([]);
    expect(
      sectionIds(
        model([gmail], {
          installedStatusStates,
          installedStatusFilter: 'available',
        }),
        'installed',
      ),
    ).toEqual(['gmail']);
  });

  describe('Browse never repeats an installed item', () => {
    const plugin = (
      id: string,
      overrides: Partial<UnifiedPluginEntry> = {},
    ): UnifiedPluginEntry =>
      entry(id, {
        kind: 'plugin',
        origin: 'curated',
        ref: { type: 'curated-plugin', key: id },
        ...overrides,
      });
    const catalog = [
      plugin('ud ecom debugger', { state: 'installed' }),
      plugin('debugger needs auth', { state: 'needs-auth' }),
      plugin('debugger partially removed'),
      plugin('debugger catalog alias', {
        state: 'installed',
        installedEntryId: 'local debugger',
      }),
      plugin('debugger second alias', {
        state: 'installed',
        installedEntryId: 'local debugger',
      }),
      plugin('local debugger', {
        origin: 'installed-standalone',
        state: 'installed',
        name: 'local install',
      }),
      plugin('debugger toolkit'),
    ];
    const partial: InstalledEntryStatusStates = {
      'debugger partially removed': {
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
    };

    it.each([
      ['all', ''],
      ['all', 'debugger'],
      ['plugin', ''],
      ['plugin', 'debugger'],
    ] as const)('on %s with query "%s"', (tab, query) => {
      const result = model(catalog, {
        tab,
        query,
        installedStatusStates: partial,
      });
      expect(sectionIds(result, 'browse')).toEqual(['debugger toolkit']);
      for (const group of section(result, 'browse')?.groups ?? [])
        expect(ids(group.entries)).toEqual(['debugger toolkit']);
      expect(sectionIds(result, 'installed')).toContain('ud ecom debugger');
    });

    it('keeps project templates browseable', () => {
      const result = model(
        [
          entry('template', {
            kind: 'blueprint',
            origin: 'curated',
            state: 'installed',
          }),
        ],
        { tab: 'blueprint', projectTemplatesAvailable: true },
      );
      expect(sectionIds(result, 'browse')).toEqual(['template']);
    });

    it('excludes a catalog-only search match using the unsearched local installation', () => {
      const result = model(
        [
          plugin('local', {
            name: 'Different local name',
            origin: 'installed-standalone',
            state: 'needs-auth',
          }),
          plugin('debugger alias', { installedEntryId: 'local' }),
          plugin('debugger control'),
        ],
        { tab: 'plugin', query: 'debugger' },
      );
      expect(sectionIds(result, 'installed')).toEqual([]);
      expect(sectionIds(result, 'browse')).toEqual(['debugger control']);
    });

    it('excludes installed skills from Browse on the skill tab', () => {
      const result = model(
        [
          entry('installed skill', { state: 'installed' }),
          entry('other skill'),
        ],
        { tab: 'skill' },
      );
      expect(sectionIds(result, 'browse')).toEqual(['other skill']);
    });

    it.each(['app', 'collection', 'automation', 'pipeline', 'agent'] as const)(
      'excludes canonical %s installs in both direct and searched Browse results',
      (kind) => {
        for (const query of ['', 'debugger']) {
          const result = model(
            [
              entry('installed debugger', { kind, state: 'installed' }),
              entry('debugger control', { kind }),
            ],
            {
              tab:
                kind === 'pipeline' || kind === 'automation'
                  ? 'workflow'
                  : kind,
              query,
              agentsAvailable: true,
            },
          );
          expect(sectionIds(result, 'installed')).toEqual([
            'installed debugger',
          ]);
          expect(sectionIds(result, 'browse')).toEqual(['debugger control']);
        }
      },
    );
  });
});

describe('CAN-4844 — plugin-bundled skills', () => {
  const pluginId = 'mkt:openai-curated/slack';
  const plugin = entry(pluginId, {
    kind: 'plugin',
    origin: 'marketplace',
    name: 'Slack',
    state: 'installed',
    ref: {
      type: 'marketplace-plugin',
      marketplaceId: 'openai-curated',
      pluginName: 'slack',
    },
  });
  const bundledSkill = entry(
    'plugin-skill:openai-curated/slack:summarize-channel',
    {
      origin: 'marketplace',
      state: 'installed',
      bundledBy: { entryId: pluginId, name: 'Slack' },
      ref: {
        type: 'plugin-skill',
        marketplaceId: 'openai-curated',
        pluginName: 'slack',
        skillName: 'summarize-channel',
      },
    },
  );
  const bundledServer = entry('mcp-local:slack', {
    kind: 'app',
    origin: 'installed-standalone',
    state: 'installed',
    ref: { type: 'local-mcp', serverId: 'slack' },
    bundledBy: { entryId: pluginId, name: 'Slack' },
  });

  function pluginState(
    status: 'active' | 'disabled',
    notices: {
      code: 'partial_removal';
      message: string;
      retryable: boolean;
    }[] = [],
  ): InstalledEntryStatusState {
    return {
      kind: 'ready',
      item: {
        target: {
          kind: 'plugin',
          marketplaceId: 'openai-curated',
          pluginName: 'slack',
        },
        status,
        removable: true,
        notices,
      },
      configurations: [],
    };
  }

  function section(
    result: CustomizeTabModel,
    id: string,
  ): CustomizeSectionModel | undefined {
    return result.sections.find((candidate) => candidate.id === id);
  }

  it('reads a bundled skill status from its plugin entry id', () => {
    expect(statusEntryIdOf(bundledSkill)).toBe(pluginId);
    expect(statusEntryIdOf(plugin)).toBe(pluginId);
  });

  it('keeps a bundled skill in Installed on the Skills and All tabs and out of Browse and Plugins', () => {
    for (const tab of ['skill', 'all'] as const) {
      const result = model([plugin, bundledSkill], { tab });
      expect(ids(section(result, 'installed')?.entries ?? [])).toContain(
        bundledSkill.id,
      );
      expect(ids(section(result, 'browse')?.entries ?? [])).not.toContain(
        bundledSkill.id,
      );
    }
    const plugins = model([plugin, bundledSkill], { tab: 'plugin' });
    expect(
      plugins.sections.flatMap((candidate) => ids(candidate.entries)),
    ).not.toContain(bundledSkill.id);
  });

  it('still hides a bundled MCP server row behind its plugin', () => {
    const result = model([plugin, bundledServer], { tab: 'all' });
    expect(
      result.sections.flatMap((candidate) => ids(candidate.entries)),
    ).not.toContain(bundledServer.id);
  });

  it('counts a bundled skill under its plugin status in the filter snapshot', () => {
    const states = { [pluginId]: pluginState('disabled') };
    expect(
      extendInstalledStatusSnapshot(
        {},
        'disabled',
        [plugin, bundledSkill],
        states,
      ),
    ).toEqual({ [pluginId]: true, [bundledSkill.id]: true });
    const result = model([plugin, bundledSkill], {
      tab: 'skill',
      installedStatusFilter: 'active',
      installedStatusStates: states,
    });
    expect(section(result, 'installed')?.entries).toEqual([]);
  });

  it('never marks a bundled skill as a partial removal', () => {
    const result = model([{ ...bundledSkill, state: 'available' }], {
      tab: 'skill',
      installedStatusStates: {
        [bundledSkill.id]: pluginState('active', [
          {
            code: 'partial_removal',
            retryable: false,
            message: 'Partly removed',
          },
        ]),
      },
    });
    expect(section(result, 'installed')).toBeUndefined();
  });

  it('sets the Installed footnote only when a visible bundled skill is listed', () => {
    const plain = entry('plain', {
      origin: 'installed-standalone',
      state: 'installed',
    });
    expect(
      section(model([bundledSkill, plain], { tab: 'skill' }), 'installed')
        ?.installedFootnote,
    ).toBe("A skill that comes with a plugin follows that plugin's status.");
    expect(
      section(model([plain], { tab: 'skill' }), 'installed')?.installedFootnote,
    ).toBeUndefined();
    expect(
      section(
        model([bundledSkill, plain], { tab: 'skill', query: 'plain' }),
        'installed',
      )?.installedFootnote,
    ).toBeUndefined();
  });

  it('leaves the footnote off when the All preview hides every bundled skill', () => {
    const plain = Array.from(
      { length: CUSTOMIZE_INSTALLED_PREVIEW_LIMIT },
      (_, i) =>
        entry(`plain ${i}`, {
          origin: 'installed-standalone',
          state: 'installed',
        }),
    );
    expect(
      section(model([...plain, bundledSkill]), 'installed')?.installedFootnote,
    ).toBeUndefined();
    expect(
      section(
        model([...plain, bundledSkill], { installedExpanded: true }),
        'installed',
      )?.installedFootnote,
    ).toBe("A skill that comes with a plugin follows that plugin's status.");
  });
});
