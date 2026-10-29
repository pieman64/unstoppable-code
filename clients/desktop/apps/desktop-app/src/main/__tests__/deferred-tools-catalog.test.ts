import type * as ClaudeInstalledPolicyModule from '../plugins/claude-enabled-plugins';
jest.mock('../plugins/codex-marketplace-service', () => ({
  listCodexPlugins: jest.fn().mockResolvedValue({
    marketplaces: [],
    marketplaceLoadErrors: [],
    featuredPluginIds: [],
  }),
}));
jest.mock('../plugins/claude-enabled-plugins', () => ({
  ...jest.requireActual<typeof ClaudeInstalledPolicyModule>(
    '../plugins/claude-enabled-plugins',
  ),
  readClaudeDisabledInstalledPlugins: jest.fn(() => []),
}));
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest
    .fn()
    .mockResolvedValue({ disabledInstalledItems: [], parkedCodexPlugins: [] }),
}));
import type * as Fs from 'node:fs';
import type * as Os from 'node:os';
import type * as Path from 'node:path';
import type * as PluginResolver from '../plugins/plugin-resolver';

jest.mock('node:fs/promises', () => ({
  readFile: jest.fn(),
}));
jest.mock('node:fs', () => ({
  ...jest.requireActual<typeof Fs>('node:fs'),
  existsSync: jest.fn(() => true),
}));
jest.mock('../skills/skill-service', () => ({
  loadSkills: jest.fn(),
}));
jest.mock('../plugins/plugin-service', () => ({
  loadMarketplacesCacheOnly: jest.fn(),
}));
jest.mock('../plugins/plugin-resolver', () => ({
  resolveEffectivePluginSelectionRefs: jest.fn(),
  resolvePluginInfoPath: jest.fn(),
  discoverCursorPluginMembers: jest.fn(),
  readPluginMcpAuthEntries: jest.fn(),
}));
jest.mock('../lib/paths', () => ({
  getMcpServersIndexFilePath: jest.fn(() => '/mock/mcp-servers/index.json'),
}));

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import type {
  MarketplaceInfo,
  PluginDetails,
  PluginInfo,
} from '@canopy/desktop-shared/types/plugins';
import type { InstalledSkillInfo } from '@canopy/desktop-shared/types/skills';
import { loadSkills } from '../skills/skill-service';
import { loadMarketplacesCacheOnly } from '../plugins/plugin-service';
import {
  resolveEffectivePluginSelectionRefs,
  resolvePluginInfoPath,
  discoverCursorPluginMembers,
  readPluginMcpAuthEntries,
} from '../plugins/plugin-resolver';
import {
  buildDeferredToolsCatalog,
  classifyLoadItems,
  encodeDeferredCatalogRef,
  searchDeferredCatalog,
  searchDeferredCatalogResult,
  type DeferredCatalog,
  type DeferredCatalogItem,
} from '../deferred-tools/catalog';
import {
  LOAD_DEFERRED_TOOLS_DESCRIPTION,
  SEARCH_DEFERRED_TOOLS_DESCRIPTION,
  loadDeferredToolsJsonSchema,
  searchDeferredToolsJsonSchema,
} from '../deferred-tools/definitions';
import { pinOrgProjectsFlagOff } from './helpers/org-projects-flag';

// This suite covers the legacy (context-free) resource paths.
beforeEach(() => {
  pinOrgProjectsFlagOff();
});

const loadSkillsMock = jest.mocked(loadSkills);
const loadMarketplacesCacheOnlyMock = jest.mocked(loadMarketplacesCacheOnly);
const resolveEffectivePluginSelectionRefsMock = jest.mocked(
  resolveEffectivePluginSelectionRefs,
);
const readFileMock = jest.mocked(readFile);
const existsSyncMock = jest.mocked(existsSync);

function skill(
  name: string,
  sourceId = 'source-a',
  description = `${name} description`,
): InstalledSkillInfo {
  return {
    name,
    sourceId,
    description,
    source: 'Source A',
    installedAt: '',
    updatedAt: '',
    updateAvailable: false,
  };
}

function plugin(
  name: string,
  providerSupport: PluginInfo['providerSupport'],
  details?: PluginDetails,
): PluginInfo {
  const installLocation = `/installed/${name}`;
  const claudeFacet =
    providerSupport.claude === 'native'
      ? {
          provider: 'claude' as const,
          mode: 'native' as const,
          name,
          installLocation,
          sourcePath: `/plugins/${name}`,
          details,
        }
      : undefined;
  const codexFacet =
    providerSupport.codex === 'native'
      ? {
          provider: 'codex' as const,
          mode: 'native' as const,
          name,
          installLocation,
          sourcePath: `/plugins/${name}`,
          details,
        }
      : undefined;
  return {
    name,
    description: `${name} description`,
    sourcePath: `/plugins/${name}`,
    marketplaceId: 'market-a',
    providerSupport,
    details,
    facets: {
      ...(claudeFacet ? { claude: claudeFacet } : {}),
      ...(codexFacet ? { codex: codexFacet } : {}),
    },
  };
}

function pluginDetails(options: {
  skills?: Array<{ name: string; description: string }>;
  commands?: Array<{ name: string; description: string }>;
}): PluginDetails {
  return {
    skills: (options.skills ?? []).map((member) => ({
      ...member,
      path: `skills/${member.name}`,
    })),
    agents: [],
    commands: (options.commands ?? []).map((member) => ({
      ...member,
      filePath: `commands/${member.name}.md`,
    })),
    apps: [],
    hooks: [],
    mcpServers: [],
    lspServers: [],
    hasReadme: false,
  };
}

function marketplace(plugins: PluginInfo[]): MarketplaceInfo {
  return {
    id: 'market-a',
    name: 'Market A',
    description: 'Marketplace A',
    sourceType: 'github',
    sourceUrl: 'https://example.test/market-a',
    installLocation: '/market-a',
    pluginCount: plugins.length,
    plugins,
    providerStatus: {
      claude: { state: 'valid' },
      codex: { state: 'valid' },
    },
    validProviders: ['claude', 'codex'],
  };
}

function schemaPatternAt(schema: unknown, path: string[]): string | undefined {
  let current = schema;
  for (const segment of path) {
    if (
      typeof current !== 'object' ||
      current === null ||
      Array.isArray(current) ||
      !(segment in current)
    ) {
      return undefined;
    }
    current = current[segment];
  }
  return typeof current === 'string' ? current : undefined;
}

function emptySelections(
  overrides: Partial<ChatTabPluginSelections> = {},
): ChatTabPluginSelections {
  return {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [],
    ...overrides,
  };
}

function setupCatalogMocks(): void {
  jest.clearAllMocks();
  loadSkillsMock.mockReturnValue({ success: true, data: [] });
  loadMarketplacesCacheOnlyMock.mockResolvedValue({
    success: true,
    data: { marketplaces: [] },
  });
  resolveEffectivePluginSelectionRefsMock.mockResolvedValue({
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [],
    warnings: [],
  });
  readFileMock.mockResolvedValue(JSON.stringify({ version: 1, servers: [] }));
  existsSyncMock.mockReturnValue(true);
}

function findByIdentity(
  catalog: DeferredCatalog,
  identityRef: string,
): DeferredCatalogItem | undefined {
  return catalog.items.find((item) => item.identityRef === identityRef);
}

const catalog: DeferredCatalog = {
  provider: 'claude',
  items: [
    {
      identityRef: 'skill:source:exact',
      ref: 'skill:source:exact',
      kind: 'skill',
      name: 'Exact',
      description: 'Exact skill',
      sourceLabel: 'Source',
      status: 'available',
      selection: {
        ref: 'skill:source:exact',
        kind: 'skill',
        name: 'Exact',
        sourceLabel: 'Source',
      },
    },
    {
      identityRef: 'plugin:market:prefix',
      ref: 'plugin:market:prefix',
      kind: 'plugin',
      name: 'Prefix Plugin',
      description: 'Plugin that prefixes things',
      sourceLabel: 'Market',
      status: 'already_enabled',
      reason: 'Already enabled in this chat.',
      selection: {
        ref: 'plugin:market:prefix',
        kind: 'plugin',
        name: 'Prefix Plugin',
        sourceLabel: 'Market',
      },
    },
    {
      identityRef: 'mcp:server:config',
      ref: 'mcp:server:config',
      kind: 'mcp',
      name: 'Other Server',
      description: 'Contains exact token in the description',
      sourceLabel: 'Server',
      status: 'available',
      selection: {
        ref: 'mcp:server:config',
        kind: 'mcp',
        name: 'Other Server',
        sourceLabel: 'Server',
      },
    },
  ],
  byRef: new Map(),
  additionsFor(items) {
    return {
      skillRefs: items
        .filter((item) => item.kind === 'skill')
        .map(() => ({ sourceId: 'source', skillName: 'exact' })),
      pluginRefs: [],
      mcpServerRefs: items
        .filter((item) => item.kind === 'mcp')
        .map(() => ({ serverId: 'server', configId: 'config' })),
    };
  },
};
catalog.byRef = new Map(catalog.items.map((item) => [item.ref, item]));

describe('deferred tools catalog helpers', () => {
  it('describes deferred tools as unavailable-to-this-agent resources only', () => {
    expect(SEARCH_DEFERRED_TOOLS_DESCRIPTION).toContain(
      "check the chat's current Skills list and callable tools",
    );
    expect(SEARCH_DEFERRED_TOOLS_DESCRIPTION).toContain(
      'do not search for a skill, plugin, MCP server, or command that is already available',
    );
    expect(LOAD_DEFERRED_TOOLS_DESCRIPTION).toContain(
      "absent from the chat's current Skills list and callable tools",
    );
    expect(LOAD_DEFERRED_TOOLS_DESCRIPTION).toContain(
      'never load something the agent can already use directly',
    );
  });

  beforeEach(() => {
    setupCatalogMocks();
  });

  it('orders exact name matches before token matches', () => {
    const matches = searchDeferredCatalog(catalog, 'exact');
    expect(matches.map((match) => match.ref)).toEqual([
      'skill:source:exact',
      'mcp:server:config',
    ]);
  });

  it('searches plugin-owned skills and commands while ranking standalone skills first', async () => {
    loadSkillsMock.mockReturnValue({
      success: true,
      data: [skill('brainstorming', 'standalone', 'Standalone brainstorm')],
    });
    loadMarketplacesCacheOnlyMock.mockResolvedValue({
      success: true,
      data: {
        marketplaces: [
          marketplace([
            plugin(
              'superpowers',
              { claude: 'native', codex: 'compat' },
              pluginDetails({
                skills: [
                  {
                    name: 'brainstorming',
                    description: 'Explore an idea before implementation',
                  },
                ],
                commands: [
                  {
                    name: 'brainstorm',
                    description: 'Deprecated brainstorming command',
                  },
                ],
              }),
            ),
          ]),
        ],
      },
    });

    const built = await buildDeferredToolsCatalog({
      provider: 'claude',
      pluginSelections: emptySelections(),
    });
    const matches = searchDeferredCatalog(built, 'brainstorm', {
      kinds: ['skill'],
    });

    expect(matches.map((match) => match.kind)).toEqual(['skill', 'plugin']);
    expect(matches[0]?.name).toBe('brainstorming');
    expect(matches[1]).toMatchObject({
      kind: 'plugin',
      name: 'superpowers',
      matchedMembers: [
        {
          kind: 'skill',
          name: 'superpowers:brainstorming',
          description: 'Explore an idea before implementation',
        },
        {
          kind: 'command',
          name: 'superpowers:brainstorm',
          description: 'Deprecated brainstorming command',
        },
      ],
    });
  });

  it('parses plugin:member queries and scopes deep matching to exact plugin names', async () => {
    const brainstormingDetails = pluginDetails({
      skills: [
        {
          name: 'brainstorming',
          description: 'Explore an idea before implementation',
        },
      ],
    });
    loadMarketplacesCacheOnlyMock.mockResolvedValue({
      success: true,
      data: {
        marketplaces: [
          marketplace([
            plugin(
              'superpowers',
              { claude: 'native', codex: 'compat' },
              brainstormingDetails,
            ),
            plugin(
              'superpowers-lab',
              { claude: 'native', codex: 'compat' },
              brainstormingDetails,
            ),
          ]),
        ],
      },
    });

    const built = await buildDeferredToolsCatalog({
      provider: 'claude',
      pluginSelections: emptySelections(),
    });
    const qualified = searchDeferredCatalog(built, 'superpowers:brainstorm', {
      kinds: ['skill'],
    });
    const naturalLanguage = searchDeferredCatalog(
      built,
      'superpowers brainstorm',
      { kinds: ['skill'] },
    );

    expect(qualified).toHaveLength(1);
    expect(qualified[0]).toMatchObject({
      name: 'superpowers',
      matchedMembers: [{ kind: 'skill', name: 'superpowers:brainstorming' }],
    });
    expect(naturalLanguage.map((match) => match.name)).toEqual(['superpowers']);
  });

  it('classifies mixed load items and returns only enable-able additions', () => {
    const result = classifyLoadItems(catalog, [
      'skill:source:exact',
      'plugin:market:prefix',
      'missing',
      'mcp:server:config',
    ]);

    expect(result.willEnable.map((item) => item.ref)).toEqual([
      'skill:source:exact',
      'mcp:server:config',
    ]);
    expect(result.rejected).toEqual([
      expect.objectContaining({
        ref: 'plugin:market:prefix',
        code: 'already_enabled',
      }),
      expect.objectContaining({ ref: 'missing', code: 'not_found' }),
    ]);
    expect(result.additions).toEqual({
      skillRefs: [{ sourceId: 'source', skillName: 'exact' }],
      pluginRefs: [],
      mcpServerRefs: [{ serverId: 'server', configId: 'config' }],
    });
  });

  it('builds the local catalog from all three resource kinds and excludes disabled MCP configs', async () => {
    loadSkillsMock.mockReturnValue({
      success: true,
      data: [skill('collection-skill'), skill('new-skill')],
    });
    loadMarketplacesCacheOnlyMock.mockResolvedValue({
      success: true,
      data: {
        marketplaces: [
          marketplace([
            plugin('Native Plugin', { claude: 'native', codex: 'compat' }),
            plugin('Codex Only', { claude: 'none', codex: 'native' }),
          ]),
        ],
      },
    });
    resolveEffectivePluginSelectionRefsMock.mockResolvedValue({
      skillRefs: [{ sourceId: 'source-a', skillName: 'collection-skill' }],
      pluginRefs: [],
      mcpServerRefs: [{ serverId: 'mcp-server', configId: 'enabled-config' }],
      warnings: [],
    });
    readFileMock.mockResolvedValue(
      JSON.stringify({
        version: 1,
        servers: [
          {
            id: 'mcp-server',
            name: 'MCP Server',
            description: 'MCP description',
            type: 'command',
            updatedAt: '',
            configs: [
              { id: 'enabled-config', name: 'Enabled', enabled: true },
              { id: 'disabled-config', name: 'Disabled', enabled: false },
            ],
          },
        ],
      }),
    );

    const built = await buildDeferredToolsCatalog({
      provider: 'ollama',
      pluginSelections: emptySelections({ collectionIds: ['collection-1'] }),
    });

    expect(resolveEffectivePluginSelectionRefsMock).toHaveBeenCalledWith(
      expect.objectContaining({ collectionIds: ['collection-1'] }),
    );
    expect(built.items.map((item) => item.kind)).toEqual(
      expect.arrayContaining(['skill', 'plugin', 'mcp']),
    );
    expect(
      findByIdentity(built, 'skill:source-a:collection-skill')?.status,
    ).toBe('already_enabled');
    expect(findByIdentity(built, 'mcp:mcp-server:enabled-config')?.status).toBe(
      'already_enabled',
    );
    expect(findByIdentity(built, 'mcp:mcp-server:disabled-config')).toBe(
      undefined,
    );
    expect(findByIdentity(built, 'plugin:market-a:Codex%20Only')?.status).toBe(
      'unsupported',
    );
  });

  it('filters plugin compatibility by active provider', async () => {
    loadMarketplacesCacheOnlyMock.mockResolvedValue({
      success: true,
      data: {
        marketplaces: [
          marketplace([
            plugin('Codex Only', { claude: 'none', codex: 'native' }),
          ]),
        ],
      },
    });

    const codexCatalog = await buildDeferredToolsCatalog({
      provider: 'codex',
      pluginSelections: emptySelections(),
    });
    const ollamaCatalog = await buildDeferredToolsCatalog({
      provider: 'ollama',
      pluginSelections: emptySelections(),
    });

    expect(
      findByIdentity(codexCatalog, 'plugin:market-a:Codex%20Only')?.status,
    ).toBe('available');
    expect(
      findByIdentity(ollamaCatalog, 'plugin:market-a:Codex%20Only')?.status,
    ).toBe('unsupported');
  });

  it('marks Codex compatibility-disabled plugins unsupported', async () => {
    const disabledPlugin = plugin('Compatibility Disabled', {
      claude: 'native',
      codex: 'compat',
    });
    disabledPlugin.codexCompatDisabled = true;
    loadMarketplacesCacheOnlyMock.mockResolvedValue({
      success: true,
      data: { marketplaces: [marketplace([disabledPlugin])] },
    });

    const built = await buildDeferredToolsCatalog({
      provider: 'codex',
      pluginSelections: emptySelections(),
    });
    const item = findByIdentity(
      built,
      'plugin:market-a:Compatibility%20Disabled',
    );

    expect(item?.status).toBe('unsupported');
    expect(classifyLoadItems(built, [item?.ref ?? 'missing']).rejected).toEqual(
      [expect.objectContaining({ code: 'unsupported' })],
    );
  });

  it('omits supported external plugins without a provider-local install', async () => {
    const external = plugin('Remote Only', {
      claude: 'native',
      codex: 'compat',
    });
    const claudeFacet = external.facets.claude;
    if (!claudeFacet) {
      throw new Error('Expected a Claude facet.');
    }
    claudeFacet.externalSource = {
      source: 'github',
      url: 'https://example.test/remote-only.git',
    };
    existsSyncMock.mockReturnValue(false);
    loadMarketplacesCacheOnlyMock.mockResolvedValue({
      success: true,
      data: { marketplaces: [marketplace([external])] },
    });

    const built = await buildDeferredToolsCatalog({
      provider: 'claude',
      pluginSelections: emptySelections(),
    });

    expect(
      findByIdentity(built, 'plugin:market-a:Remote%20Only'),
    ).toBeUndefined();
  });

  it('counts and omits unsupported matches without consuming the supported limit', async () => {
    loadSkillsMock.mockReturnValue({
      success: true,
      data: [skill('Alpha Skill')],
    });
    loadMarketplacesCacheOnlyMock.mockResolvedValue({
      success: true,
      data: {
        marketplaces: [
          marketplace([plugin('Alpha', { claude: 'none', codex: 'native' })]),
        ],
      },
    });

    const built = await buildDeferredToolsCatalog({
      provider: 'claude',
      pluginSelections: emptySelections(),
    });
    const result = searchDeferredCatalogResult(built, 'alpha', { limit: 1 });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      kind: 'skill',
      name: 'Alpha Skill',
      status: 'available',
    });
    expect(result.unsupportedMatches).toBe(1);
    expect(searchDeferredCatalog(built, 'alpha', { limit: 1 })).toEqual(
      result.matches,
    );
  });

  it('deduplicates duplicate load refs and reports no-op classifications normally', () => {
    const duplicate = classifyLoadItems(catalog, [
      'skill:source:exact',
      'skill:source:exact',
    ]);
    expect(duplicate.willEnable.map((item) => item.ref)).toEqual([
      'skill:source:exact',
    ]);
    expect(duplicate.rejected).toEqual([]);

    const allRejected = classifyLoadItems(catalog, [
      'plugin:market:prefix',
      'missing',
    ]);
    expect(allRejected.willEnable).toEqual([]);
    expect(allRejected.rejected.map((item) => item.code)).toEqual([
      'already_enabled',
      'not_found',
    ]);
  });

  it('returns opaque public refs while retaining private catalog identities', async () => {
    loadSkillsMock.mockReturnValue({
      success: true,
      data: [skill('opaque-skill')],
    });

    const built = await buildDeferredToolsCatalog({
      provider: 'claude',
      pluginSelections: emptySelections(),
    });

    const item = built.items.find((candidate) => candidate.kind === 'skill');
    expect(item?.identityRef).toBe('skill:source-a:opaque-skill');
    expect(item?.ref).toBe(
      encodeDeferredCatalogRef('skill:source-a:opaque-skill'),
    );
    expect(item?.ref).toEqual(expect.stringMatching(/^deferred:v1:/));
    expect(item?.ref).not.toBe(item?.identityRef);
    expect(built.byRef.has('skill:source-a:opaque-skill')).toBe(false);
  });

  it('uses stable opaque refs derived from catalog identity', async () => {
    loadSkillsMock.mockReturnValue({
      success: true,
      data: [skill('stable-skill')],
    });

    const first = await buildDeferredToolsCatalog({
      provider: 'claude',
      pluginSelections: emptySelections(),
    });
    const second = await buildDeferredToolsCatalog({
      provider: 'claude',
      pluginSelections: emptySelections(),
    });

    const identityRef = 'skill:source-a:stable-skill';
    const expectedRef = encodeDeferredCatalogRef(identityRef);
    expect(findByIdentity(first, identityRef)?.ref).toBe(expectedRef);
    expect(findByIdentity(second, identityRef)?.ref).toBe(expectedRef);
    expect(expectedRef).toEqual(expect.stringMatching(/^deferred:v1:/));
    expect(expectedRef).not.toContain('source-a');
    expect(expectedRef).not.toContain('stable-skill');
  });

  it('keeps Zod and provider JSON schemas aligned on trimmed non-empty strings', () => {
    const searchPattern = schemaPatternAt(searchDeferredToolsJsonSchema, [
      'properties',
      'queries',
      'items',
      'properties',
      'text',
      'pattern',
    ]);
    const loadPattern = schemaPatternAt(loadDeferredToolsJsonSchema, [
      'properties',
      'items',
      'items',
      'properties',
      'ref',
      'pattern',
    ]);

    expect(searchPattern).toBe('.*\\S.*');
    expect(loadPattern).toBe('.*\\S.*');
    expect(new RegExp(searchPattern ?? '').test('   ')).toBe(false);
    expect(new RegExp(loadPattern ?? '').test('\t\n')).toBe(false);
  });
});

describe('Copilot installed deferred plugin catalog', () => {
  beforeEach(() => {
    setupCatalogMocks();
    jest
      .mocked(resolvePluginInfoPath)
      .mockReset()
      .mockResolvedValue('/installed/plugin');
    jest
      .mocked(discoverCursorPluginMembers)
      .mockReset()
      .mockReturnValue([
        {
          kind: 'plugin_skill',
          name: 'actual-review',
          skill: {
            name: 'actual-review',
            dirName: 'actual-review',
            sourceDir: '/installed/plugin/skills/actual-review',
            skillMdPath: '/installed/plugin/skills/actual-review/SKILL.md',
            description: 'Actual review from disk',
            metadata: {},
          },
        },
      ]);
    jest.mocked(readPluginMcpAuthEntries).mockReset().mockResolvedValue([]);
  });
  async function build(value: PluginInfo): Promise<DeferredCatalog> {
    loadMarketplacesCacheOnlyMock.mockResolvedValue({
      success: true,
      data: { marketplaces: [marketplace([value])] },
    });
    return buildDeferredToolsCatalog({
      provider: 'copilot',
      pluginSelections: emptySelections(),
    });
  }
  it('loads the installed native Codex facet through the same projection as execution', async () => {
    const built = await build(
      plugin('native-review', { claude: 'none', codex: 'native' }),
    );
    expect(built.items[0]?.status).toBe('available');
    expect(discoverCursorPluginMembers).toHaveBeenCalledWith(
      '/installed/plugin',
      'codex',
    );
    expect(resolvePluginInfoPath).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.any(Array),
      false,
      'codex',
    );
  });
  it('searches actual readable members instead of stale catalog metadata', async () => {
    const built = await build(
      plugin(
        'review',
        { claude: 'native', codex: 'compat' },
        pluginDetails({
          skills: [{ name: 'stale-member', description: 'Removed' }],
        }),
      ),
    );
    expect(
      searchDeferredCatalog(built, 'review:actual-review', {
        kinds: ['skill'],
      }),
    ).toHaveLength(1);
    expect(
      searchDeferredCatalog(built, 'stale-member', { kinds: ['skill'] }),
    ).toHaveLength(0);
  });
  it('excludes hook-only plugins without a Copilot-loadable member', async () => {
    jest.mocked(discoverCursorPluginMembers).mockReturnValue([]);
    const built = await build(
      plugin(
        'native-hooks',
        { claude: 'native', codex: 'compat' },
        pluginDetails({}),
      ),
    );
    expect(built.items[0]?.status).toBe('unsupported');
    expect(
      searchDeferredCatalogResult(built, 'native-hooks').unsupportedMatches,
    ).toBe(1);
  });
  it('omits an absent install instead of treating catalog support as installation', async () => {
    jest.mocked(resolvePluginInfoPath).mockResolvedValue(null);
    const built = await build(
      plugin('missing', { claude: 'native', codex: 'compat' }),
    );
    expect(built.items).toEqual([]);
    expect(discoverCursorPluginMembers).not.toHaveBeenCalled();
  });
  it('prefers the Claude facet even when the native Codex facet has loadable members', async () => {
    jest.mocked(discoverCursorPluginMembers).mockReturnValue([]);
    const built = await build(
      plugin(
        'dual-facet',
        { claude: 'native', codex: 'native' },
        pluginDetails({ skills: [{ name: 'stale', description: '' }] }),
      ),
    );
    expect(discoverCursorPluginMembers).toHaveBeenCalledWith(
      '/installed/plugin',
      'claude',
    );
    expect(built.items[0]?.status).toBe('unsupported');
    expect(resolvePluginInfoPath).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.any(Array),
      false,
      'claude',
    );
  });
  it('includes installed MCP-only plugins without serializing configuration or credentials', async () => {
    jest.mocked(discoverCursorPluginMembers).mockReturnValue([]);
    jest.mocked(readPluginMcpAuthEntries).mockResolvedValue([
      {
        serverName: 'local',
        rawValue: { command: 'fixture', env: { TOKEN: 'private-value' } },
        identity: {
          marketplaceId: 'market-a',
          pluginName: 'mcp-only',
          serverName: 'local',
        },
      },
    ]);
    const built = await build(
      plugin('mcp-only', { claude: 'native', codex: 'compat' }),
    );
    expect(built.items[0]?.status).toBe('available');
    expect(readPluginMcpAuthEntries).toHaveBeenCalledWith(
      '/installed/plugin',
      'market-a',
      'mcp-only',
      'claude',
    );
    expect(JSON.stringify(built.items)).not.toContain('private-value');
  });
  it('rechecks the installed content when classifying a later load', async () => {
    const value = plugin('review', { claude: 'native', codex: 'compat' });
    const first = await build(value);
    const ref = first.items[0]?.ref;
    expect(ref).toBeDefined();
    jest.mocked(discoverCursorPluginMembers).mockReturnValue([]);
    const next = await build(value);
    const classified = classifyLoadItems(next, ref ? [ref] : []);
    expect(classified.willEnable).toEqual([]);
    expect(classified.rejected[0]?.code).toBe('unsupported');
  });
  it('uses real installed files and ignores a skill escaping through a symlink', async () => {
    const fs = jest.requireActual<typeof Fs>('node:fs');
    const os = jest.requireActual<typeof Os>('node:os');
    const path = jest.requireActual<typeof Path>('node:path');
    const resolver = jest.requireActual<typeof PluginResolver>(
      '../plugins/plugin-resolver',
    );
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-catalog-'));
    try {
      existsSyncMock.mockImplementation(fs.existsSync);
      jest
        .mocked(resolvePluginInfoPath)
        .mockImplementation(resolver.resolvePluginInfoPath);
      jest
        .mocked(discoverCursorPluginMembers)
        .mockImplementation(resolver.discoverCursorPluginMembers);
      jest
        .mocked(readPluginMcpAuthEntries)
        .mockImplementation(resolver.readPluginMcpAuthEntries);
      const installed = path.join(root, 'installed');
      const outside = path.join(root, 'outside');
      fs.mkdirSync(path.join(installed, 'skills', 'actual-review'), {
        recursive: true,
      });
      fs.mkdirSync(outside);
      fs.writeFileSync(
        path.join(installed, 'skills', 'actual-review', 'SKILL.md'),
        '---\nname: actual-review\ndescription: Actual review from disk\n---\nReview.',
      );
      fs.writeFileSync(
        path.join(outside, 'SKILL.md'),
        '---\nname: escaped-secret\n---\nOutside.',
      );
      fs.symlinkSync(outside, path.join(installed, 'skills', 'escape'));
      const value = plugin(
        'filesystem',
        { claude: 'native', codex: 'compat' },
        pluginDetails({ skills: [{ name: 'stale', description: 'Gone' }] }),
      );
      if (!value.facets.claude) throw new Error('Missing fixture facet');
      value.facets.claude.installLocation = installed;
      const built = await build(value);
      expect(
        built.items[0]?.pluginMembers?.map((member) => member.name),
      ).toEqual(['actual-review']);
      expect(built.items[0]?.status).toBe('available');
      expect(
        searchDeferredCatalog(built, 'escaped-secret', { kinds: ['skill'] }),
      ).toEqual([]);
      fs.rmSync(path.join(installed, 'skills', 'actual-review'), {
        recursive: true,
      });
      expect((await build(value)).items[0]?.status).toBe('unsupported');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
