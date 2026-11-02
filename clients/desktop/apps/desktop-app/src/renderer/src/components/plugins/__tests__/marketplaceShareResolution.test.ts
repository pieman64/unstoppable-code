import {
  getShareablePluginRefKey,
  type SharedPluginSummary,
} from '@canopy/protocol/plugins';
import type {
  MarketplaceInfo,
  PluginInfo,
} from '@canopy/desktop-shared/types/plugins';
import type { InstalledSkillInfo } from '@canopy/desktop-shared/types/skills';
import type { SharedSkillSummary } from '@canopy/protocol/skills';
import type { UnifiedPluginEntry } from '@/lib/unifiedPluginEntries';

jest.mock('@/components/automations/ShareAutomationModal', () => ({
  ShareAutomationModal: (): null => null,
}));
jest.mock('@/components/collections/ShareCollectionModal', () => ({
  ShareCollectionModal: (): null => null,
}));
jest.mock('@/components/pipeline/SharePipelineModal', () => ({
  SharePipelineModal: (): null => null,
}));
jest.mock('@/components/skills/ShareSkillModal', () => ({
  ShareSkillModal: (): null => null,
}));

import {
  createMarketplaceEntryShareResolver,
  marketplaceEntryShareState,
  type MarketplaceShareSources,
} from '../marketplaceShareResolution';

const NO_SOURCE = {
  status: 'blocked',
  reason: 'This plugin has no public source to share.',
};
const STANDALONE = {
  status: 'blocked',
  reason: 'MCP server connections cannot be shared.',
};
const UNAVAILABLE = {
  status: 'blocked',
  reason: 'Sharing is unavailable for this item.',
};

function plugin(
  marketplaceId: string,
  overrides: Partial<PluginInfo> = {},
): PluginInfo {
  return {
    name: 'helper',
    marketplaceId,
    sourcePath: '',
    facets: {},
    providerSupport: { claude: 'native', codex: 'none' },
    ...overrides,
  };
}

function marketplace(
  overrides: Partial<MarketplaceInfo> & { id: string },
): MarketplaceInfo {
  return {
    name: overrides.id,
    sourceType: 'github',
    sourceUrl: `https://github.com/acme/${overrides.id}`,
    installLocation: `/private/${overrides.id}`,
    pluginCount: 1,
    plugins: [plugin(overrides.id)],
    validProviders: ['claude'],
    providerStatus: {
      claude: {
        provider: 'claude',
        state: 'valid',
        accepted: true,
        pluginCount: 1,
        lastCheckedAt: '',
      },
      codex: {
        provider: 'codex',
        state: 'invalid',
        accepted: false,
        pluginCount: 0,
        lastCheckedAt: '',
      },
    },
    ...overrides,
  };
}

/** A curated marketplace whose `integration` plugin folds one MCP key. */
function curated(
  overrides: Partial<MarketplaceInfo> = {},
  mcpKeys: string[] = ['linear'],
): MarketplaceInfo {
  return marketplace({
    id: 'curated',
    curated: true,
    plugins: [
      plugin('curated', {
        name: 'integration',
        displayName: 'Linear',
        details: {
          skills: [],
          agents: [],
          commands: [],
          hooks: [],
          lspServers: [],
          hasReadme: false,
          mcpServers: mcpKeys.map((name) => ({ name, type: 'http' })),
        },
      }),
    ],
    ...overrides,
  });
}

function skill(overrides: Partial<InstalledSkillInfo>): InstalledSkillInfo {
  return {
    name: 'helper',
    sourceId: 'custom:app',
    custom: true,
    description: '',
    source: 'Custom',
    installedAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    updateAvailable: false,
    ...overrides,
  };
}

function sources(
  overrides: Partial<MarketplaceShareSources> = {},
): MarketplaceShareSources {
  return {
    marketplaces: [],
    skills: [],
    sharedSkills: [],
    localCollections: [],
    pipelines: [],
    automationActivities: [],
    context: undefined,
    ...overrides,
  };
}

function entry(
  ref: UnifiedPluginEntry['ref'],
  overrides: Partial<UnifiedPluginEntry> = {},
): Pick<UnifiedPluginEntry, 'ref' | 'kind' | 'components'> {
  return {
    ref,
    kind: 'plugin',
    components: { skills: 0, mcpServers: 0, commands: 0, agents: 0 },
    ...overrides,
  };
}

describe('createMarketplaceEntryShareResolver', () => {
  it.each([undefined, '/private/cache'])(
    'shares a plugin with a public source whether or not it is installed (cachePath %s)',
    (cachePath) => {
      const market = marketplace({
        id: 'market',
        plugins: [plugin('market', { cachePath })],
      });
      const resolve = createMarketplaceEntryShareResolver(
        sources({ marketplaces: [market] }),
      );
      const resolution = resolve(
        entry({
          type: 'marketplace-plugin',
          marketplaceId: 'market',
          pluginName: 'helper',
        }),
      );
      expect(resolution).toMatchObject({
        status: 'shareable',
        activation: { kind: 'plugin', target: { name: 'Helper' } },
      });
    },
  );

  it('explains a plugin with no public source', () => {
    const resolve = createMarketplaceEntryShareResolver(
      sources({
        marketplaces: [
          marketplace({ id: 'local', sourceUrl: '/private/local' }),
        ],
      }),
    );
    expect(
      resolve(
        entry({
          type: 'marketplace-plugin',
          marketplaceId: 'local',
          pluginName: 'helper',
        }),
      ),
    ).toEqual(NO_SOURCE);
  });

  it('resolves duplicate plugin names by marketplace identity', () => {
    const resolve = createMarketplaceEntryShareResolver(
      sources({
        marketplaces: [
          marketplace({ id: 'one' }),
          marketplace({ id: 'two', sourceUrl: '/private/two' }),
        ],
      }),
    );
    expect(
      resolve(
        entry({
          type: 'marketplace-plugin',
          marketplaceId: 'one',
          pluginName: 'helper',
        }),
      )?.status,
    ).toBe('shareable');
    expect(
      resolve(
        entry({
          type: 'marketplace-plugin',
          marketplaceId: 'two',
          pluginName: 'helper',
        }),
      ),
    ).toEqual(NO_SOURCE);
  });

  it('blocks a stale plugin target rather than guessing', () => {
    const resolve = createMarketplaceEntryShareResolver(
      sources({ marketplaces: [marketplace({ id: 'market' })] }),
    );
    expect(
      resolve(
        entry({
          type: 'marketplace-plugin',
          marketplaceId: 'gone',
          pluginName: 'helper',
        }),
      ),
    ).toEqual(UNAVAILABLE);
    expect(resolve(entry({ type: 'curated-plugin', key: 'helper' }))).toEqual(
      UNAVAILABLE,
    );
  });

  it('resolves curated keys against the curated marketplace', () => {
    const resolve = createMarketplaceEntryShareResolver(
      sources({ marketplaces: [curated()] }),
    );
    expect(
      resolve(entry({ type: 'curated-plugin', key: 'integration' })),
    ).toMatchObject({
      status: 'shareable',
      activation: { kind: 'plugin', target: { name: 'Linear' } },
    });
  });

  it('shares the folded plugin from an MCP card, connected or not', () => {
    const resolve = createMarketplaceEntryShareResolver(
      sources({ marketplaces: [curated()] }),
    );
    for (const ref of [
      { type: 'curated-mcp', key: 'linear' },
      { type: 'local-mcp', serverId: 'linear-1', curatedKey: 'linear' },
    ] as const) {
      expect(resolve(entry(ref, { kind: 'app' }))).toMatchObject({
        status: 'shareable',
        activation: { kind: 'plugin', target: { name: 'Linear' } },
      });
    }
  });

  it('uses the plugin reason for a folded parent without a public source', () => {
    const resolve = createMarketplaceEntryShareResolver(
      sources({ marketplaces: [curated({ sourceUrl: '/private/curated' })] }),
    );
    expect(
      resolve(entry({ type: 'curated-mcp', key: 'linear' }, { kind: 'app' })),
    ).toEqual(NO_SOURCE);
  });

  it('explains standalone MCP connections', () => {
    const resolve = createMarketplaceEntryShareResolver(
      sources({ marketplaces: [curated()] }),
    );
    expect(
      resolve(entry({ type: 'curated-mcp', key: 'other' }, { kind: 'app' })),
    ).toEqual(STANDALONE);
    expect(
      resolve(
        entry({ type: 'local-mcp', serverId: 'custom' }, { kind: 'app' }),
      ),
    ).toEqual(STANDALONE);
    expect(
      resolve(
        entry(
          { type: 'mcp-server', serverId: 'cloud', configId: 'a' },
          { kind: 'app' },
        ),
      ),
    ).toEqual(STANDALONE);
  });

  it('shares an owned skill and explains every other installed skill', () => {
    const resolve = createMarketplaceEntryShareResolver(
      sources({
        skills: [
          skill({}),
          skill({ sourceId: 'github:acme:skills', custom: false }),
        ],
      }),
    );
    expect(
      resolve(
        entry(
          { type: 'skill', sourceId: 'custom:app', skillName: 'helper' },
          { kind: 'skill' },
        ),
      ),
    ).toMatchObject({
      status: 'shareable',
      activation: { kind: 'owned', target: { kind: 'skill' } },
    });
    expect(
      resolve(
        entry(
          {
            type: 'skill',
            sourceId: 'github:acme:skills',
            skillName: 'helper',
          },
          { kind: 'skill' },
        ),
      ),
    ).toEqual(UNAVAILABLE);
  });

  it('blocks duplicate owned skill identities', () => {
    const resolve = createMarketplaceEntryShareResolver(
      sources({ skills: [skill({}), skill({})] }),
    );
    expect(
      resolve(
        entry(
          { type: 'skill', sourceId: 'custom:app', skillName: 'helper' },
          { kind: 'skill' },
        ),
      ),
    ).toEqual(UNAVAILABLE);
  });

  it('reads ownership of a team-shared skill only from explicit facts', () => {
    const shared = (canUpdate: boolean): SharedSkillSummary => ({
      id: 'shared-1',
      name: 'helper',
      description: '',
      contentHash: '',
      shareScope: 'team',
      owner: {
        type: 'team',
        id: 'team-1',
        name: 'Team',
        organization: { id: 'org-1', name: 'Org' },
      },
      createdBy: { id: 'user-2', name: null, email: null },
      createdAt: '',
      updatedAt: '',
      canUpdate,
      canDelete: canUpdate,
      publicShare: null,
    });
    const ref = { type: 'shared-skill', skillId: 'shared-1' } as const;
    expect(
      createMarketplaceEntryShareResolver(
        sources({ sharedSkills: [shared(false)] }),
      )(entry(ref, { kind: 'skill' })),
    ).toEqual({
      status: 'blocked',
      reason: 'Only the owner can share this skill.',
    });
    expect(
      createMarketplaceEntryShareResolver(
        sources({ sharedSkills: [shared(true)] }),
      )(entry(ref, { kind: 'skill' })),
    ).toEqual(UNAVAILABLE);
    expect(
      createMarketplaceEntryShareResolver(sources())(
        entry({ type: 'shared-plugin', pluginId: 'p' }),
      ),
    ).toEqual(UNAVAILABLE);
  });

  it('marks public catalog skills and plugins as already public', () => {
    const resolve = createMarketplaceEntryShareResolver(sources());
    expect(
      resolve(
        entry(
          {
            type: 'public-share',
            shareKind: 'skill',
            externalId: 'x',
            sharePath: '/share/skills/x',
          },
          { kind: 'skill' },
        ),
      ),
    ).toEqual({ status: 'blocked', reason: 'This item is already public.' });
  });

  it('leaves out-of-scope entries without a Share', () => {
    const resolve = createMarketplaceEntryShareResolver(sources());
    expect(
      resolve(entry({ type: 'provider-connector', displayName: 'Linear' })),
    ).toBeNull();
    expect(
      resolve(entry({ type: 'curated-pipeline', key: 'release' })),
    ).toBeNull();
    expect(
      resolve(entry({ type: 'local-collection', collectionId: 'missing' })),
    ).toBeNull();
  });
});

describe('marketplaceEntryShareState', () => {
  it('keeps the collection MCP restriction on the card', () => {
    expect(
      marketplaceEntryShareState(
        {
          kind: 'collection',
          components: { skills: 0, mcpServers: 1, commands: 0, agents: 0 },
        },
        null,
      ),
    ).toEqual({
      status: 'blocked',
      reason:
        'Collections with MCP server configs cannot be shared. Remove MCP servers before sharing.',
    });
  });

  it('projects a resolution to the card state', () => {
    const components = { skills: 0, mcpServers: 0, commands: 0, agents: 0 };
    expect(
      marketplaceEntryShareState({ kind: 'plugin', components }, null),
    ).toBeUndefined();
    expect(
      marketplaceEntryShareState(
        { kind: 'plugin', components },
        { status: 'blocked', reason: 'Reason.' },
      ),
    ).toEqual({ status: 'blocked', reason: 'Reason.' });
  });
});

it('uses the server ownership verdict for a shared plugin instead of guessing from its ref', () => {
  const sharedPlugins = [
    {
      externalId: 'shared-plugin',
      canUpdate: false,
      owner: { type: 'user' as const, id: 'other', name: null },
      createdBy: { id: 'other', name: null },
      shareScope: 'team' as const,
      createdAt: '',
      updatedAt: '',
      refKey: 'plugin:github:acme/plugins:helper',
      ref: {
        type: 'plugin' as const,
        marketplace: { type: 'github' as const, repo: 'acme/plugins' },
        plugin_name: 'helper',
      },
      name: 'Helper',
      description: null,
      marketplaceOrigin: 'github:acme/plugins',
    },
  ];
  const resolve = createMarketplaceEntryShareResolver({
    ...sources(),
    sharedPlugins,
  });
  expect(
    resolve(entry({ type: 'shared-plugin', pluginId: 'shared-plugin' })),
  ).toEqual({
    status: 'blocked',
    reason: 'Only the owner can share this plugin.',
  });
});

it('preserves a positively resolved owner skill and blocks ambiguous author identities', () => {
  const summary: SharedSkillSummary = {
    id: 'shared-1',
    canUpdate: true,
    canDelete: true,
    name: 'helper',
    description: '',
    contentHash: '',
    shareScope: 'team',
    owner: {
      type: 'team',
      id: 'team-1',
      name: 'Team',
      organization: { id: 'org-1', name: 'Org' },
    },
    createdBy: { id: 'user-1', name: null, email: null },
    createdAt: '',
    updatedAt: '',
    publicShare: null,
  };
  const local = skill({
    remote: {
      remoteId: 'shared-1',
      contentHash: '',
      shareScope: 'team',
      sharedAt: '',
    },
  });
  const ref = entry({ type: 'shared-skill', skillId: 'shared-1' });
  expect(
    createMarketplaceEntryShareResolver(
      sources({ sharedSkills: [summary], skills: [local] }),
    )(ref),
  ).toMatchObject({
    status: 'shareable',
    activation: {
      kind: 'owned',
      target: {
        kind: 'skill',
        skill: { sourceId: 'custom:app', name: 'helper' },
      },
    },
  });
  expect(
    createMarketplaceEntryShareResolver(
      sources({ sharedSkills: [summary], skills: [local, local] }),
    )(ref),
  ).toEqual(UNAVAILABLE);
});

it('preserves a positively resolved owner plugin and rejects ambiguous local parents', () => {
  const ref = {
    type: 'claude_plugin' as const,
    marketplace: { type: 'github' as const, repo: 'acme/plugins' },
    plugin_name: 'helper',
  };
  const summary: SharedPluginSummary = {
    externalId: 'shared-plugin',
    canUpdate: true,
    owner: { type: 'user', id: 'user-1', name: null },
    createdBy: { id: 'user-1', name: null },
    shareScope: 'private',
    createdAt: '',
    updatedAt: '',
    ref,
    refKey: getShareablePluginRefKey(ref),
    name: 'Helper',
    description: null,
    marketplaceOrigin: 'github:acme/plugins',
  };
  const market = marketplace({
    id: 'market',
    sourceUrl: 'https://github.com/acme/plugins',
  });
  const resolve = createMarketplaceEntryShareResolver(
    sources({ marketplaces: [market], sharedPlugins: [summary] }),
  );
  expect(
    resolve(entry({ type: 'shared-plugin', pluginId: summary.externalId })),
  ).toMatchObject({
    status: 'shareable',
    activation: { kind: 'plugin', target: { pluginRef: ref } },
  });
  expect(
    createMarketplaceEntryShareResolver(
      sources({ marketplaces: [market, market], sharedPlugins: [summary] }),
    )(entry({ type: 'shared-plugin', pluginId: summary.externalId })),
  ).toEqual(UNAVAILABLE);
});
