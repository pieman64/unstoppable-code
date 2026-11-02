import type {
  InstalledSkillInfo,
  SharedSkillSummary,
} from '@canopy/protocol/skills';
import type {
  MarketplaceInfo,
  PluginDetails,
  PluginInfo,
  PluginProviderFacet,
} from '@canopy/protocol/plugins';
import { loadSkills } from '../../skills/skill-service';
import { filterStoredSkillContexts } from '../../skills/skill-install-context';
import { listSharedSkills } from '../../skills/canopy-server-client';
import { listCodexPlugins } from '../../plugins/codex-marketplace-service';
import {
  loadMarketplacesCacheOnly,
  refreshMarketplaces,
} from '../../plugins/plugin-service';
import {
  listPortalSkills,
  listPortalMarketplaces,
} from '../../services/plugin-catalog-service';
import {
  resourceContextSnapshot,
  assertResourceContextSnapshot,
} from '../../lib/resource-context';
import { readCapabilityInventory } from '../capability-inventory';
import { resolveCapabilities } from '../show-capabilities';

jest.mock('../../skills/skill-service', () => ({ loadSkills: jest.fn() }));
jest.mock('../../skills/skill-install-context', () => ({
  filterStoredSkillContexts: jest.fn(),
}));
jest.mock('../../skills/canopy-server-client', () => ({
  listSharedSkills: jest.fn(),
}));
jest.mock('../../plugins/plugin-service', () => ({
  loadMarketplacesCacheOnly: jest.fn(),
  refreshMarketplaces: jest.fn(),
}));
jest.mock('../../plugins/codex-marketplace-service', () => ({
  listCodexPlugins: jest.fn(),
}));
jest.mock('../../services/plugin-catalog-service', () => ({
  listPortalSkills: jest.fn(),
  listPortalMarketplaces: jest.fn(),
}));
jest.mock('../../lib/resource-context', () => ({
  resourceContextSnapshot: jest.fn(() => Promise.resolve('context')),
  assertResourceContextSnapshot: jest.fn(() => Promise.resolve()),
}));

const builtin: InstalledSkillInfo = {
  name: 'canopy-pipeline-writing',
  sourceId: 'builtin:app',
  description: 'Write a pipeline',
  source: 'builtin',
  installedAt: '',
  updatedAt: '',
  updateAvailable: false,
  builtIn: true,
};
const sharedSkill: SharedSkillSummary = {
  id: 'shared-skill',
  name: 'shared-only',
  description: 'Shared skill',
  contentHash: 'hash',
  shareScope: 'private',
  owner: { type: 'user', id: 'u', name: null },
  createdBy: { id: 'u', name: null, email: null },
  createdAt: '',
  updatedAt: '',
  canUpdate: false,
  canDelete: false,
  publicShare: null,
};
const details = (names = ['writing-plans']): PluginDetails => ({
  skills: names.map((name) => ({
    name,
    description: `Use ${name}`,
    path: `skills/${name}`,
  })),
  agents: [],
  commands: [],
  hooks: [],
  mcpServers: [],
  lspServers: [],
  hasReadme: false,
});
const plugin = (overrides: Partial<PluginInfo> = {}): PluginInfo => ({
  name: 'superpowers',
  marketplaceId: 'm',
  sourcePath: './superpowers',
  cachePath: '/cache',
  providerSupport: { claude: 'native', codex: 'compat' },
  facets: {},
  details: details(),
  ...overrides,
});
const marketplace = (plugins = [plugin()], id = 'm'): MarketplaceInfo => ({
  id,
  name: id,
  sourceType: 'github',
  sourceUrl: 'https://example.com/m',
  installLocation: '/cache',
  pluginCount: plugins.length,
  plugins,
  providerStatus: {
    claude: {
      provider: 'claude',
      state: 'valid',
      accepted: true,
      pluginCount: plugins.length,
      lastCheckedAt: '',
    },
    codex: {
      provider: 'codex',
      state: 'valid',
      accepted: true,
      pluginCount: plugins.length,
      lastCheckedAt: '',
    },
  },
  validProviders: ['claude', 'codex'],
});
const cache = (marketplaces: MarketplaceInfo[]): void => {
  jest.mocked(loadMarketplacesCacheOnly).mockResolvedValue({
    success: true,
    data: { version: 2, lastRefreshed: '', marketplaces },
  });
};
const resolve = async (item: object): Promise<unknown> => {
  const response = await resolveCapabilities(
    { items: [{ kind: 'skill', ...item }] },
    readCapabilityInventory,
  );
  return JSON.parse(response.text);
};
const found = (sourceId: string): object => ({
  result: {
    agentArtifacts: [expect.objectContaining({ sourceId })],
    unresolved: [],
  },
});
const missing = (reason = 'unavailable_source'): object => ({
  result: {
    agentArtifacts: [],
    unresolved: [expect.objectContaining({ reason })],
  },
});

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(listCodexPlugins).mockResolvedValue({
    marketplaces: [],
    marketplaceLoadErrors: [],
    featuredPluginIds: [],
  });
  jest.mocked(loadSkills).mockReturnValue({ success: true, data: [builtin] });
  jest
    .mocked(filterStoredSkillContexts)
    .mockImplementation((rows) => Promise.resolve(rows));
  jest.mocked(listSharedSkills).mockResolvedValue({ skills: [] });
  // Keep the unchanged implementation operational so red tests reproduce behavior.
  jest.mocked(resourceContextSnapshot).mockResolvedValue('context');
  jest.mocked(listPortalSkills).mockImplementation(async () => {
    const result = loadSkills();
    if (!result.success || !result.data)
      throw new Error('installed unavailable');
    const rows = await filterStoredSkillContexts(result.data);
    return {
      skills: rows.map((skill) => ({
        ...skill,
        sharing: {
          status: 'shareable',
          target: {
            kind: 'skill',
            sourceId: skill.sourceId,
            skillName: skill.name,
          },
        },
      })),
      truncated: false,
    };
  });
  jest.mocked(listPortalMarketplaces).mockResolvedValue({
    marketplaces: [],
    lastRefreshed: '',
    truncated: false,
  });
  cache([]);
});
afterEach(() => jest.useRealTimers());

it('resolves installed exact names when signed-out shared reads reject', async () => {
  jest.mocked(listSharedSkills).mockRejectedValue(new Error('signed out'));
  expect(await resolve({ name: builtin.name })).toMatchObject(
    found('builtin:app/canopy-pipeline-writing'),
  );
});
it('keeps canonical, slash and colon IDs and exact names usable with paginated shared rows', async () => {
  jest
    .mocked(listSharedSkills)
    .mockResolvedValue({ skills: [], nextCursor: 'next' });
  for (const item of [
    { id: 'installed:builtin:app/canopy-pipeline-writing' },
    { id: 'builtin:app/canopy-pipeline-writing' },
    { id: 'builtin:app:canopy-pipeline-writing' },
    { name: builtin.name },
  ]) {
    expect(await resolve(item)).toMatchObject(
      found('builtin:app/canopy-pipeline-writing'),
    );
  }
  expect(await resolve({ name: 'shared-only' })).toMatchObject(missing());
});
it('emits cached plugin members with parent navigation and no network refresh', async () => {
  cache([marketplace()]);
  for (const item of [
    { name: 'SUPERPOWERS:WRITING-PLANS' },
    { id: 'superpowers:writing-plans' },
    { id: 'plugin:m/superpowers:writing-plans' },
  ]) {
    expect(await resolve(item)).toMatchObject({
      result: {
        unresolved: [],
        agentArtifacts: [
          expect.objectContaining({
            source: 'plugin',
            sourceLabel: 'Plugin',
            state: 'installed',
            sourceId: 'm/superpowers:writing-plans',
            description: 'Use writing-plans',
            navigationTarget: {
              kind: 'capability_entry',
              entry: {
                type: 'marketplace-plugin',
                marketplaceId: 'm',
                pluginName: 'superpowers',
              },
            },
          }),
        ],
      },
    });
  }
  expect(listPortalSkills).not.toHaveBeenCalled();
  expect(refreshMarketplaces).not.toHaveBeenCalled();
  expect(listPortalMarketplaces).not.toHaveBeenCalled();
});
it.each([
  { cachePath: '/cache' },
  {
    cachePath: undefined,
    globalInstallStatus: {
      claude: { available: true, installed: true },
      checkedAt: '2026-08-27T00:00:00.000Z',
    },
  },
  {
    cachePath: undefined,
    globalInstallStatus: {
      codex: { available: true, installed: true },
      checkedAt: '2026-08-27T00:00:00.000Z',
    },
  },
] satisfies Partial<PluginInfo>[])(
  'accepts each installation signal: %j',
  async (overrides) => {
    cache([marketplace([plugin(overrides)])]);
    expect(await resolve({ name: 'superpowers:writing-plans' })).toMatchObject(
      found('m/superpowers:writing-plans'),
    );
  },
);
it('emits no uninstalled plugin or fabricated missing members', async () => {
  cache([
    marketplace([
      plugin({ cachePath: undefined }),
      plugin({ name: 'empty', details: undefined }),
      plugin({ name: 'null', details: null }),
      plugin({ name: 'no-skills', details: details([]) }),
    ]),
  ]);
  expect((await readCapabilityInventory('skill')).items).toHaveLength(1);
});
it.each(['claude', 'codex', 'codexCompatibility', 'fallback'] as const)(
  'uses details precedence without facet merging: %s',
  async (preferred) => {
    const facet = (name: string): PluginProviderFacet => ({
      provider: 'codex',
      mode: 'native',
      name,
      installLocation: '/cache',
      sourcePath: '.',
      details: details([name, name.toUpperCase()]),
    });
    cache([
      marketplace([
        plugin({
          facets: {
            ...(preferred === 'claude'
              ? { claude: { ...facet('claude'), provider: 'claude' } }
              : {}),
            ...(['claude', 'codex'].includes(preferred)
              ? { codex: facet('codex') }
              : {}),
            ...(preferred !== 'fallback'
              ? { codexCompatibility: facet('codexCompatibility') }
              : {}),
          },
          details: details(['fallback', 'FALLBACK']),
        }),
      ]),
    ]);
    const members = (await readCapabilityInventory('skill')).items.filter(
      (row) => row.source === 'plugin',
    );
    expect(members.map((row) => row.name)).toEqual([
      `superpowers:${preferred}`,
    ]);
  },
);
it('retains cross-marketplace collisions for ambiguity', async () => {
  cache([
    marketplace(),
    marketplace([plugin({ marketplaceId: 'other' })], 'other'),
  ]);
  expect(await resolve({ id: 'superpowers:writing-plans' })).toMatchObject(
    missing('ambiguous'),
  );
  expect(
    await resolve({ id: 'plugin:other/superpowers:writing-plans' }),
  ).toMatchObject(found('other/superpowers:writing-plans'));
});
it('distinguishes failed or missing cache data from a valid empty cache', async () => {
  expect(await resolve({ name: 'absent' })).toMatchObject(missing('not_found'));
  for (const result of [
    { success: false, error: 'unreadable' },
    { success: true },
  ]) {
    jest.mocked(loadMarketplacesCacheOnly).mockResolvedValue(result);
    expect(await resolve({ name: builtin.name })).toMatchObject(missing());
    expect(await resolve({ id: 'absent' })).toMatchObject(missing());
  }
});
it('filters context before bounding and never leaks filtered installed rows', async () => {
  jest.mocked(loadSkills).mockReturnValue({
    success: true,
    data: Array.from({ length: 2001 }, () => builtin),
  });
  jest.mocked(filterStoredSkillContexts).mockResolvedValue([builtin]);
  expect(await resolve({ name: builtin.name })).toMatchObject(
    found('builtin:app/canopy-pipeline-writing'),
  );
  jest.mocked(filterStoredSkillContexts).mockResolvedValue([]);
  expect(
    await resolve({ id: 'builtin:app/canopy-pipeline-writing' }),
  ).toMatchObject(missing('not_found'));
});
it.each([{ success: false, error: 'failed' }, { success: true }])(
  'treats failed/missing installed data as partial: %j',
  async (result) => {
    jest.mocked(loadSkills).mockReturnValue(result);
    expect(
      await resolve({ id: 'builtin:app/canopy-pipeline-writing' }),
    ).toMatchObject(missing());
    expect(filterStoredSkillContexts).not.toHaveBeenCalled();
  },
);
it('marks context-filter failure partial without leaking its input', async () => {
  jest
    .mocked(filterStoredSkillContexts)
    .mockRejectedValue(new Error('context unavailable'));
  expect(
    await resolve({ id: 'builtin:app/canopy-pipeline-writing' }),
  ).toMatchObject(missing());
});
it.each([2000, 2001])(
  'bounds installed source and aggregate rows at %s',
  async (count) => {
    jest.mocked(loadSkills).mockReturnValue({
      success: true,
      data: Array.from({ length: count }, (_, i) => ({
        ...builtin,
        name: `skill-${i}`,
      })),
    });
    expect(await readCapabilityInventory('skill')).toMatchObject({
      partialTiers: count === 2000 ? [] : ['installed'],
    });
    expect((await readCapabilityInventory('skill')).items).toHaveLength(2000);
    cache([marketplace()]);
    const aggregate = await readCapabilityInventory('skill');
    expect(aggregate.items).toHaveLength(2000);
    expect(aggregate).toMatchObject({
      unavailable: true,
      partialTiers: ['installed', 'available'],
    });
  },
);
it.each([2000, 2001])('bounds plugin source rows at %s', async (count) => {
  jest.mocked(loadSkills).mockReturnValue({ success: true, data: [] });
  cache([
    marketplace([
      plugin({
        details: details(Array.from({ length: count }, (_, i) => `s${i}`)),
      }),
    ]),
  ]);
  expect(await readCapabilityInventory('skill')).toMatchObject({
    partialTiers: count === 2000 ? [] : ['installed'],
  });
  expect((await readCapabilityInventory('skill')).items).toHaveLength(2000);
});
it('propagates mixed-state marketplace truncation to both tiers', async () => {
  jest.mocked(listPortalMarketplaces).mockResolvedValue({
    marketplaces: [],
    lastRefreshed: '',
    truncated: true,
  });
  expect(await readCapabilityInventory('plugin')).toMatchObject({
    unavailable: true,
    partialTiers: ['installed', 'available'],
  });
});
it('retains the five-second source timeout without poisoning installed exact lookup', async () => {
  jest.useFakeTimers();
  jest.mocked(listSharedSkills).mockImplementation(() => new Promise(() => {}));
  const pending = resolve({ name: builtin.name });
  await jest.advanceTimersByTimeAsync(4999);
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  expect(settled).toBe(false);
  await jest.advanceTimersByTimeAsync(1);
  expect(await pending).toMatchObject(
    found('builtin:app/canopy-pipeline-writing'),
  );
  expect(jest.getTimerCount()).toBe(0);
});
it('fails the whole read after resource-context invalidation and issues no stale receipts', async () => {
  jest
    .mocked(assertResourceContextSnapshot)
    .mockRejectedValue(new Error('context changed'));
  await expect(readCapabilityInventory('skill')).rejects.toThrow(
    'context changed',
  );
  expect(
    await resolve({ id: 'installed:builtin:app/canopy-pipeline-writing' }),
  ).toMatchObject(missing());
  expect(assertResourceContextSnapshot).toHaveBeenCalledWith('context');
});

it('resolves installed exact names before same-named shared rows', async () => {
  jest
    .mocked(listSharedSkills)
    .mockResolvedValue({ skills: [{ ...sharedSkill, name: builtin.name }] });
  expect(await resolve({ name: builtin.name })).toMatchObject(
    found('builtin:app/canopy-pipeline-writing'),
  );
  expect(await resolve({ id: 'shared:shared-skill' })).toMatchObject(
    found('shared-skill'),
  );
});
it('returns shared-only exact names only with complete available and installed tiers', async () => {
  jest.mocked(listSharedSkills).mockResolvedValue({ skills: [sharedSkill] });
  expect(await resolve({ name: 'shared-only' })).toMatchObject(
    found('shared-skill'),
  );
  jest.mocked(loadSkills).mockReturnValue({ success: false });
  expect(await resolve({ name: 'shared-only' })).toMatchObject(missing());
});
it('does not apply the Portal serialized-byte budget to installed skills', async () => {
  // Descriptions stay valid per receipt; the complete list exceeds Portal transport budgets.
  jest.mocked(loadSkills).mockReturnValue({
    success: true,
    data: Array.from({ length: 2000 }, (_, i) => ({
      ...builtin,
      name: `large-${i}`,
      description: 'x'.repeat(1000),
    })),
  });
  jest
    .mocked(listPortalSkills)
    .mockRejectedValue(new Error('Portal byte budget'));
  expect(await resolve({ name: 'large-1999' })).toMatchObject(
    found('builtin:app/large-1999'),
  );
  expect(listPortalSkills).not.toHaveBeenCalled();
});
