import type { UnifiedPluginEntry } from '@canopy/ui-shared/lib';
import {
  buildCustomizeTabModel,
  CUSTOMIZE_INSTALLED_PREVIEW_LIMIT,
  type CustomizeTabModelInput,
  type CustomizeTabModel,
} from '../customizeSections';

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
  const result = model([row, row], {
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
  expect(result.resultCount).toBe(1);
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
      result.sections.find((section) => section.id === 'browse')?.entries ?? [],
    ),
  ).toEqual(['zebra match', 'alpha match']);
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
    // CAN-4261: every row carries its tinted type, on single-kind tabs too.
    expect(result.sections.every((section) => section.showEntryTypes)).toBe(
      true,
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

it('lists one canonical install while retaining the installed catalog representation in Browse', () => {
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
    ids(
      result.sections.find((section) => section.id === 'browse')?.entries ?? [],
    ),
  ).toEqual(['catalog']);
  expect(
    result.sections.find((section) => section.id === 'shared-by-me')?.count,
  ).toBe(1);
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
