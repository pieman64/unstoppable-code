import { installedItemKey } from '@canopy/protocol/installed-items';
import { readPreferencesFile } from '../lib/preferences-store';
import { listCodexPlugins } from '../plugins/codex-marketplace-service';
jest.mock('../plugins/codex-marketplace-service', () => ({
  listCodexPlugins: jest.fn(),
}));
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest
    .fn()
    .mockResolvedValue({ disabledInstalledItems: [], parkedCodexPlugins: [] }),
}));
jest.mock('../plugins/claude-enabled-plugins', () => ({
  readClaudeDisabledInstalledPlugins: jest.fn(() => []),
}));
import type * as Fs from 'node:fs';

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
}));
jest.mock('../lib/paths', () => ({
  getMcpServersIndexFilePath: jest.fn(() => '/mock/mcp-servers/index.json'),
}));

import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type {
  ChatTabPluginSelections,
  DeferredToolsReloadScopeKey,
  DeferredToolSearchResult,
  LoadDeferredToolRejectionCode,
  LoadDeferredToolsResult,
} from '@canopy/desktop-shared/types';
import type {
  MarketplaceInfo,
  PluginDetails,
  PluginInfo,
} from '@canopy/desktop-shared/types/plugins';
import type { InstalledSkillInfo } from '@canopy/desktop-shared/types/skills';
import { loadSkills } from '../skills/skill-service';
import { loadMarketplacesCacheOnly } from '../plugins/plugin-service';
import { resolveEffectivePluginSelectionRefs } from '../plugins/plugin-resolver';
import {
  executeLoadDeferredTools,
  executeSearchDeferredTools,
  resetDeferredToolsRefRegistryForTests,
  type DeferredToolsReloadSink,
} from '../deferred-tools/executor';
import * as deferredCatalog from '../deferred-tools/catalog';
import { deferredToolsReloadCoordinator } from '../deferred-tools/reload-coordinator';
import { pinOrgProjectsFlagOff } from './helpers/org-projects-flag';

// This suite covers the legacy (context-free) resource paths.
beforeEach(() => {
  pinOrgProjectsFlagOff();
  jest.mocked(listCodexPlugins).mockReset().mockResolvedValue({
    marketplaces: [],
    marketplaceLoadErrors: [],
    featuredPluginIds: [],
  });
});

const loadSkillsMock = jest.mocked(loadSkills);
const loadMarketplacesCacheOnlyMock = jest.mocked(loadMarketplacesCacheOnly);
const resolveEffectivePluginSelectionRefsMock = jest.mocked(
  resolveEffectivePluginSelectionRefs,
);
const readFileMock = jest.mocked(readFile);

const resourceSummarySchema = z.object({
  ref: z.string(),
  kind: z.enum(['skill', 'plugin', 'mcp']),
  name: z.string(),
  sourceLabel: z.string().optional(),
});

const searchResultSchema = z.object({
  provider: z.enum(['claude', 'codex', 'ollama', 'copilot', 'opencode']),
  results: z.array(
    z.object({
      query: z.string(),
      matches: z.array(
        z.object({
          ref: z.string(),
          kind: z.enum(['skill', 'plugin', 'mcp']),
          name: z.string(),
          description: z.string(),
          sourceLabel: z.string().optional(),
          status: z.enum(['available', 'already_enabled']),
          reason: z.string().optional(),
          matchedMembers: z
            .array(
              z.object({
                kind: z.enum(['skill', 'command']),
                name: z.string(),
                description: z.string(),
              }),
            )
            .optional(),
        }),
      ),
      unsupportedMatches: z.number().optional(),
    }),
  ),
});

const loadResultSchema = z.object({
  status: z.enum(['success', 'partial_success', 'error']),
  willEnable: z.array(resourceSummarySchema),
  rejected: z.array(
    z.object({
      ref: z.string(),
      code: z.enum([
        'invalid_ref',
        'not_found',
        'already_enabled',
        'unsupported',
        'disabled',
        'missing_tool_call_id',
        'reload_in_progress',
        'reload_limit',
      ]),
      message: z.string(),
    }),
  ),
  requestId: z.string().optional(),
});

function scope(id: string): DeferredToolsReloadScopeKey {
  return {
    projectId: `project-${id}`,
    worktreeId: `worktree-${id}`,
    chatId: `chat-${id}`,
  };
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

function skill(
  name: string,
  description = `${name} description`,
): InstalledSkillInfo {
  return {
    name,
    sourceId: 'source-a',
    description,
    source: 'Source A',
    installedAt: '',
    updatedAt: '',
    updateAvailable: false,
  };
}

function plugin(
  name: string,
  details?: PluginDetails,
  providerSupport: PluginInfo['providerSupport'] = {
    claude: 'native',
    codex: 'native',
  },
): PluginInfo {
  const installLocation = `/installed/${name}`;
  return {
    name,
    description: `${name} description`,
    sourcePath: `/plugins/${name}`,
    marketplaceId: 'market-a',
    providerSupport,
    details,
    facets: {
      ...(providerSupport.claude === 'native'
        ? {
            claude: {
              provider: 'claude' as const,
              mode: 'native' as const,
              name,
              installLocation,
              sourcePath: `/plugins/${name}`,
              details,
            },
          }
        : {}),
      ...(providerSupport.codex === 'native'
        ? {
            codex: {
              provider: 'codex' as const,
              mode: 'native' as const,
              name,
              installLocation,
              sourcePath: `/plugins/${name}`,
              details,
            },
          }
        : {}),
    },
  };
}

function pluginDetails(): PluginDetails {
  return {
    skills: [
      {
        name: 'brainstorming',
        description: 'Explore an idea before implementation',
        path: 'skills/brainstorming',
      },
    ],
    agents: [],
    commands: [
      {
        name: 'brainstorm',
        description: 'Deprecated brainstorming command',
        filePath: 'commands/brainstorm.md',
      },
    ],
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

function parseSearch(text: string): DeferredToolSearchResult {
  return searchResultSchema.parse(JSON.parse(text));
}

type ParsedLoadDeferredToolsResult = Omit<
  LoadDeferredToolsResult,
  'rejected'
> & {
  rejected: Array<
    Omit<LoadDeferredToolsResult['rejected'][number], 'code'> & {
      code: LoadDeferredToolRejectionCode | 'reload_limit';
    }
  >;
  requestId?: string;
};

function parseLoad(text: string): ParsedLoadDeferredToolsResult {
  return loadResultSchema.parse(JSON.parse(text));
}

function setupCatalog(options: {
  skills?: InstalledSkillInfo[];
  plugins?: PluginInfo[];
  enabledSkillRefs?: ChatTabPluginSelections['skillRefs'];
  mcpEnabled?: boolean;
}): void {
  loadSkillsMock.mockReturnValue({
    success: true,
    data: options.skills ?? [],
  });
  loadMarketplacesCacheOnlyMock.mockResolvedValue({
    success: true,
    data: { marketplaces: [marketplace(options.plugins ?? [])] },
  });
  resolveEffectivePluginSelectionRefsMock.mockResolvedValue({
    skillRefs: options.enabledSkillRefs ?? [],
    pluginRefs: [],
    mcpServerRefs: [],
    warnings: [],
  });
  readFileMock.mockResolvedValue(
    JSON.stringify({
      version: 1,
      servers: [
        {
          id: 'mcp-server',
          name: 'Search Server',
          description: 'Server-side search helper',
          type: 'command',
          updatedAt: '',
          configs: [
            {
              id: 'enabled-config',
              name: 'Enabled Config',
              enabled: options.mcpEnabled ?? true,
            },
          ],
        },
      ],
    }),
  );
}

async function searchFirstRef(options: {
  text: string;
  runtimeScope: DeferredToolsReloadScopeKey;
  providerType?: 'claude' | 'codex' | 'ollama';
  pluginSelections?: ChatTabPluginSelections;
}): Promise<string> {
  const searchResult = await executeSearchDeferredTools(
    { queries: [{ text: options.text }] },
    {
      scope: options.runtimeScope,
      providerType: options.providerType ?? 'claude',
      pluginSelections: options.pluginSelections ?? emptySelections(),
    },
  );
  const ref = parseSearch(searchResult.text).results[0]?.matches[0]?.ref;
  if (!ref) {
    throw new Error(`Expected Search to return a ref for ${options.text}.`);
  }
  return ref;
}

describe('deferred tools executor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetDeferredToolsRefRegistryForTests();
    setupCatalog({});
  });

  it('searches the OpenCode projection, including Codex skills and excluding empty plugins and Codex commands', async () => {
    setupCatalog({
      plugins: [
        plugin('native-only', pluginDetails(), {
          claude: 'none',
          codex: 'native',
        }),
        plugin('empty-plugin', {
          ...pluginDetails(),
          skills: [],
          commands: [],
        }),
      ],
    });
    const result = await executeSearchDeferredTools(
      {
        queries: [
          { text: 'native-only' },
          { text: 'native-only:brainstorm' },
          { text: 'empty-plugin' },
        ],
      },
      {
        scope: scope('opencode-catalog'),
        providerType: 'opencode',
        pluginSelections: emptySelections(),
      },
    );
    const parsed = parseSearch(result.text);
    expect(parsed.provider).toBe('opencode');
    expect(parsed.results[0]?.matches).toEqual([
      expect.objectContaining({ name: 'native-only' }),
    ]);
    expect(parsed.results[1]?.matches[0]?.matchedMembers).toEqual([
      expect.objectContaining({
        kind: 'skill',
        name: 'native-only:brainstorming',
      }),
    ]);
    expect(parsed.results[2]).toMatchObject({
      matches: [],
      unsupportedMatches: 1,
    });
  });

  it('returns an OpenCode reload receipt without announcing delivery from the HTTP execution alone', async () => {
    setupCatalog({ skills: [skill('new-skill')] });
    const runtimeScope = scope('opencode-receipt');
    const ref = await searchFirstRef({ text: 'new-skill', runtimeScope });
    const events: unknown[] = [];
    const stop = deferredToolsReloadCoordinator.subscribe((event) =>
      events.push(event),
    );
    try {
      const result = await executeLoadDeferredTools(
        { items: [{ ref }] },
        {
          scope: runtimeScope,
          providerType: 'opencode',
          pluginSelections: emptySelections(),
        },
        { toolUseId: 'http-request-42' },
      );
      expect(parseLoad(result.text).status).toBe('success');
      expect(typeof parseLoad(result.text).requestId).toBe('string');
      expect(events).toEqual([]);
    } finally {
      stop();
      deferredToolsReloadCoordinator.cancelActiveReload(
        runtimeScope,
        'test complete',
      );
    }
  });

  it('rejects calls when deferred tools are disabled', async (): Promise<void> => {
    jest.clearAllMocks();
    const reloadSinkRequest = jest.fn(
      (): { accepted: true; reloadId: string } => ({
        accepted: true,
        reloadId: 'reload-disabled',
      }),
    );
    const reloadSink: DeferredToolsReloadSink = { request: reloadSinkRequest };
    const runtime = {
      scope: scope('disabled'),
      providerType: 'claude' as const,
      pluginSelections: emptySelections(),
      allowed: false,
      reloadSink,
    };

    const [searchResult, loadResult] = await Promise.all([
      executeSearchDeferredTools(
        { queries: [{ text: 'brainstorm' }] },
        runtime,
      ),
      executeLoadDeferredTools(
        { items: [{ ref: 'plugin:market-a/superpowers' }] },
        runtime,
        { toolUseId: 'tool-disabled' },
      ),
    ]);

    expect(searchResult).toEqual({
      text: 'Deferred tools are not available for this chat. Instruct user to enable using the plugin picker from the chat composer.',
      isError: true,
    });
    expect(loadResult).toEqual(searchResult);
    expect(loadSkillsMock).not.toHaveBeenCalled();
    expect(loadMarketplacesCacheOnlyMock).not.toHaveBeenCalled();
    expect(resolveEffectivePluginSelectionRefsMock).not.toHaveBeenCalled();
    expect(readFileMock).not.toHaveBeenCalled();
    expect(reloadSinkRequest).not.toHaveBeenCalled();
  });

  it('routes accepted loads through the delegate sink', async (): Promise<void> => {
    setupCatalog({ skills: [skill('sink-skill')] });
    const runtimeScope = scope('sink-accepted');
    const ref = await searchFirstRef({
      text: 'sink-skill',
      runtimeScope,
    });
    const reloadSinkRequest = jest.fn(
      (): { accepted: true; reloadId: string } => ({
        accepted: true,
        reloadId: 'reload-accepted',
      }),
    );
    const reloadSink: DeferredToolsReloadSink = { request: reloadSinkRequest };
    const createIntent = jest.spyOn(
      deferredToolsReloadCoordinator,
      'createIntent',
    );

    const result = await executeLoadDeferredTools(
      { items: [{ ref }] },
      {
        scope: runtimeScope,
        providerType: 'claude',
        pluginSelections: emptySelections(),
        reloadSink,
      },
      { toolUseId: 'tool-sink-accepted' },
    );

    expect(result.isError).toBeUndefined();
    expect(parseLoad(result.text)).toMatchObject({
      status: 'success',
      willEnable: [{ ref }],
      rejected: [],
    });
    expect(reloadSinkRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: 'tool-sink-accepted',
        refs: [ref],
        enabledResources: [expect.objectContaining({ ref })],
      }),
    );
    expect(createIntent).not.toHaveBeenCalled();
    createIntent.mockRestore();
  });

  it.each([
    ['reload_in_progress', 'Another reload is already pending.'],
    ['reload_limit', 'This run has reached its reload limit.'],
  ] as const)(
    'returns the reload sink refusal %s for every enabled item',
    async (
      code: 'reload_in_progress' | 'reload_limit',
      message: string,
    ): Promise<void> => {
      setupCatalog({ skills: [skill('refused-skill')] });
      const runtimeScope = scope(`sink-${code}`);
      const ref = await searchFirstRef({
        text: 'refused-skill',
        runtimeScope,
      });
      const reloadSink: DeferredToolsReloadSink = {
        request: (): {
          accepted: false;
          code: typeof code;
          message: string;
        } => ({ accepted: false, code, message }),
      };

      const result = await executeLoadDeferredTools(
        { items: [{ ref }] },
        {
          scope: runtimeScope,
          providerType: 'claude',
          pluginSelections: emptySelections(),
          reloadSink,
        },
        { toolUseId: `tool-${code}` },
      );

      expect(result.isError).toBe(true);
      expect(parseLoad(result.text)).toMatchObject({
        status: 'error',
        willEnable: [],
        rejected: [{ ref, code, message }],
      });
    },
  );

  it('returns batched Search groups with per-query limits across resource kinds', async () => {
    setupCatalog({
      skills: [
        skill('Alpha Skill', 'Skill that handles alpha work'),
        skill('Beta Skill', 'Skill that handles beta work'),
      ],
      plugins: [plugin('Search Plugin')],
    });

    const result = await executeSearchDeferredTools(
      {
        queries: [
          { text: 'skill', kinds: ['skill'], limit: 1 },
          { text: 'search', limit: 10 },
        ],
      },
      {
        scope: scope('search'),
        providerType: 'codex',
        pluginSelections: emptySelections(),
      },
    );

    expect(result.isError).toBeUndefined();
    const parsed = parseSearch(result.text);
    expect(parsed.provider).toBe('codex');
    expect(parsed.results.map((group) => group.query)).toEqual([
      'skill',
      'search',
    ]);
    expect(parsed.results[0]?.matches).toHaveLength(1);
    expect(parsed.results[0]?.matches[0]?.kind).toBe('skill');
    expect(parsed.results[1]?.matches.map((match) => match.kind)).toEqual(
      expect.arrayContaining(['plugin', 'mcp']),
    );
  });

  it('returns parent plugin refs and matched members for deep skill searches', async () => {
    setupCatalog({
      plugins: [plugin('superpowers', pluginDetails())],
    });

    const result = await executeSearchDeferredTools(
      {
        queries: [
          { text: 'superpowers brainstorm', kinds: ['skill'] },
          { text: 'superpowers:brainstorm', kinds: ['skill'] },
        ],
      },
      {
        scope: scope('plugin-member-search'),
        providerType: 'claude',
        pluginSelections: emptySelections(),
      },
    );

    const parsed = parseSearch(result.text);
    expect(parsed.results).toHaveLength(2);
    for (const group of parsed.results) {
      expect(group.matches).toHaveLength(1);
      expect(group.matches[0]).toMatchObject({
        kind: 'plugin',
        name: 'superpowers',
        status: 'available',
        matchedMembers: [
          {
            kind: 'skill',
            name: 'superpowers:brainstorming',
          },
          {
            kind: 'command',
            name: 'superpowers:brainstorm',
          },
        ],
      });
    }
  });

  it('reports unsupported match counts without returning unsupported resources', async () => {
    setupCatalog({
      plugins: [
        plugin('superpowers', pluginDetails(), {
          claude: 'none',
          codex: 'native',
        }),
      ],
    });

    const result = await executeSearchDeferredTools(
      {
        queries: [
          { text: 'superpowers:brainstorm', kinds: ['skill'] },
          { text: 'Search Server', kinds: ['mcp'] },
        ],
      },
      {
        scope: scope('unsupported-search'),
        providerType: 'claude',
        pluginSelections: emptySelections(),
      },
    );

    const parsed = parseSearch(result.text);
    expect(parsed.results[0]).toEqual({
      query: 'superpowers:brainstorm',
      matches: [],
      unsupportedMatches: 1,
    });
    expect(parsed.results[1]?.matches).toHaveLength(1);
    expect(parsed.results[1]).not.toHaveProperty('unsupportedMatches');
  });

  it('returns informative error Load results for all-missing and all-enabled refs', async () => {
    setupCatalog({
      skills: [skill('enabled-skill')],
      enabledSkillRefs: [{ sourceId: 'source-a', skillName: 'enabled-skill' }],
    });
    const runtimeScope = scope('noop');
    const enabledRef = await searchFirstRef({
      text: 'enabled-skill',
      runtimeScope,
    });

    const result = await executeLoadDeferredTools(
      {
        items: [{ ref: enabledRef }, { ref: 'skill:source-a:missing-skill' }],
      },
      {
        scope: runtimeScope,
        providerType: 'claude',
        pluginSelections: emptySelections(),
      },
      { toolUseId: 'tool-noop' },
    );

    expect(result.isError).toBe(true);
    const parsed = parseLoad(result.text);
    expect(parsed.status).toBe('error');
    expect(parsed.willEnable).toEqual([]);
    expect(parsed.requestId).toBeUndefined();
    expect(parsed.rejected.map((item) => item.code)).toEqual([
      'already_enabled',
      'not_found',
    ]);
  });

  it('deduplicates duplicate valid Load refs before creating reload intent', async () => {
    setupCatalog({
      skills: [skill('new-skill')],
    });
    const runtimeScope = scope('dedupe');
    const ref = await searchFirstRef({ text: 'new-skill', runtimeScope });

    const result = await executeLoadDeferredTools(
      {
        items: [{ ref }, { ref }],
      },
      {
        scope: runtimeScope,
        providerType: 'claude',
        pluginSelections: emptySelections(),
      },
      { toolUseId: 'tool-dedupe' },
    );

    const parsed = parseLoad(result.text);
    expect(parsed.status).toBe('success');
    expect(parsed.willEnable.map((item) => item.ref)).toEqual([ref]);
    expect(parsed.rejected).toEqual([]);
    expect(parsed.requestId).toBeUndefined();
  });

  it('enables an MCP resource without a separate approval interaction', async () => {
    const runtimeScope = scope('mcp-approval');
    const ref = await searchFirstRef({
      text: 'Search Server',
      runtimeScope,
    });
    const runtime = {
      scope: runtimeScope,
      providerType: 'claude' as const,
      pluginSelections: emptySelections(),
    };

    const result = await executeLoadDeferredTools(
      { items: [{ ref }] },
      runtime,
      { toolUseId: 'tool-mcp' },
    );

    expect(result.isError).toBeUndefined();
    expect(parseLoad(result.text)).toMatchObject({
      status: 'success',
      willEnable: [{ ref, kind: 'mcp' }],
      rejected: [],
    });
  });

  it('returns an error when valid Load refs cannot reload without a provider tool call id', async () => {
    setupCatalog({
      skills: [skill('new-skill')],
    });
    const runtimeScope = scope('missing-tool-call-id');
    const ref = await searchFirstRef({ text: 'new-skill', runtimeScope });

    const result = await executeLoadDeferredTools(
      {
        items: [{ ref }, { ref: 'skill:source-a:missing-skill' }],
      },
      {
        scope: runtimeScope,
        providerType: 'claude',
        pluginSelections: emptySelections(),
      },
    );

    const parsed = parseLoad(result.text);
    expect(result.isError).toBe(true);
    expect(parsed.status).toBe('error');
    expect(parsed.willEnable).toEqual([]);
    expect(parsed.requestId).toBeUndefined();
    expect(parsed.rejected.map((item) => item.code)).toEqual([
      'not_found',
      'missing_tool_call_id',
    ]);
  });

  it('blocks fresh discovery and stale load refs after a Codex-only disable', async () => {
    setupCatalog({
      plugins: [
        plugin('native-blocked', pluginDetails(), {
          claude: 'native',
          codex: 'native',
        }),
      ],
    });
    const runtime = {
      scope: scope('codex-disabled-stale'),
      providerType: 'claude' as const,
      pluginSelections: emptySelections(),
    };
    const query = { queries: [{ text: 'native-blocked' }] };
    const search = await executeSearchDeferredTools(query, runtime);
    const ref = parseSearch(search.text).results[0]?.matches[0]?.ref;
    if (!ref) throw new Error('Expected a discovered plugin');
    jest.mocked(listCodexPlugins).mockResolvedValue({
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
      marketplaces: [
        {
          name: 'Market A',
          path: null,
          interface: null,
          plugins: [
            {
              id: 'native-blocked@Market A',
              name: 'native-blocked',
              installed: true,
              enabled: false,
              remotePluginId: null,
              version: null,
              localVersion: null,
              shareContext: null,
              source: { type: 'remote' },
              installedAt: null,
              installPolicy: 'AVAILABLE',
              installPolicySource: null,
              mustShowInstallationInterstitial: null,
              authPolicy: 'ON_USE',
              availability: 'AVAILABLE',
              disabledReason: null,
              eligiblePlanTypes: null,
              interface: null,
              keywords: [],
            },
          ],
        },
      ],
    });
    const rediscovered = await executeSearchDeferredTools(query, runtime);
    expect(parseSearch(rediscovered.text).results[0]?.matches).toEqual([]);
    const loaded = await executeLoadDeferredTools(
      { items: [{ ref }] },
      runtime,
      { toolUseId: 'codex-disable-after-discovery' },
    );
    expect(loaded.isError).toBe(true);
    expect(parseLoad(loaded.text).willEnable).toEqual([]);
  });

  it('rechecks Disabled after discovery before accepting a previously returned load ref', async () => {
    setupCatalog({ skills: [skill('turn-off')] });
    const runtime = {
      scope: scope('disabled-stale'),
      providerType: 'claude' as const,
      pluginSelections: emptySelections(),
    };
    const search = await executeSearchDeferredTools(
      { queries: [{ text: 'turn-off' }] },
      runtime,
    );
    const ref = parseSearch(search.text).results[0]?.matches[0]?.ref;
    if (!ref) throw new Error('Expected a discovered resource');
    jest.mocked(readPreferencesFile).mockResolvedValueOnce({
      ...(await readPreferencesFile()),
      disabledInstalledItems: [
        installedItemKey({
          kind: 'skill',
          sourceId: 'source-a',
          skillName: 'turn-off',
        }),
      ],
    });
    const loaded = await executeLoadDeferredTools(
      { items: [{ ref }] },
      runtime,
      { toolUseId: 'disable-after-discovery' },
    );
    expect(loaded.isError).toBe(true);
    expect(parseLoad(loaded.text).willEnable).toEqual([]);
  });

  it('revalidates Load refs against the live catalog after Search results go stale', async () => {
    setupCatalog({
      skills: [skill('vanishing-skill')],
    });
    const searchResult = await executeSearchDeferredTools(
      { queries: [{ text: 'vanishing' }] },
      {
        scope: scope('stale-search'),
        providerType: 'claude',
        pluginSelections: emptySelections(),
      },
    );
    const ref = parseSearch(searchResult.text).results[0]?.matches[0]?.ref;
    expect(ref).toEqual(expect.stringMatching(/^deferred:v1:/));
    if (!ref) {
      throw new Error('Expected Search to return a ref.');
    }

    setupCatalog({ skills: [] });
    const loadResult = await executeLoadDeferredTools(
      { items: [{ ref }] },
      {
        scope: scope('stale-load'),
        providerType: 'claude',
        pluginSelections: emptySelections(),
      },
      { toolUseId: 'tool-stale' },
    );

    const parsed = parseLoad(loadResult.text);
    expect(loadResult.isError).toBe(true);
    expect(parsed.status).toBe('error');
    expect(parsed.willEnable).toEqual([]);
    expect(parsed.requestId).toBeUndefined();
    expect(parsed.rejected).toEqual([
      expect.objectContaining({ ref, code: 'not_found' }),
    ]);
  });

  it('rejects guessed semantic refs that were not returned by Search', async () => {
    setupCatalog({
      skills: [skill('new-skill')],
    });

    const result = await executeLoadDeferredTools(
      { items: [{ ref: 'skill:source-a:new-skill' }] },
      {
        scope: scope('guessed-ref'),
        providerType: 'claude',
        pluginSelections: emptySelections(),
      },
      { toolUseId: 'tool-guessed-ref' },
    );

    const parsed = parseLoad(result.text);
    expect(result.isError).toBe(true);
    expect(parsed.status).toBe('error');
    expect(parsed.willEnable).toEqual([]);
    expect(parsed.requestId).toBeUndefined();
    expect(parsed.rejected).toEqual([
      expect.objectContaining({
        ref: 'skill:source-a:new-skill',
        code: 'not_found',
      }),
    ]);
  });
  it('keeps the Copilot provider identity when searching installed capabilities', async () => {
    setupCatalog({ skills: [skill('copilot-skill')] });
    const result = await executeSearchDeferredTools(
      { queries: [{ text: 'copilot-skill' }] },
      {
        scope: scope('copilot-search'),
        providerType: 'copilot',
        allowed: true,
        pluginSelections: emptySelections(),
      },
    );
    expect(parseSearch(result.text).provider).toBe('copilot');
  });
  it('revalidates a pending Copilot load with Copilot compatibility', async () => {
    setupCatalog({ skills: [skill('copilot-skill')] });
    const ref = deferredCatalog.encodeDeferredCatalogRef(
      deferredCatalog.encodeSkillRef('source-a', 'copilot-skill'),
    );
    const runtimeScope = scope('copilot-revalidate');
    const additions = {
      skillRefs: [{ sourceId: 'source-a', skillName: 'copilot-skill' }],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    const enabledResources = [
      { ref, kind: 'skill' as const, name: 'copilot-skill' },
    ];
    const observed = jest.spyOn(deferredCatalog, 'buildDeferredToolsCatalog');
    try {
      const intent = deferredToolsReloadCoordinator.createIntent({
        scope: runtimeScope,
        toolCallId: 'copilot-load',
        providerType: 'copilot',
        additions,
        enabledResources,
      });
      if (!intent.accepted) throw new Error('Fixture intent rejected');
      deferredToolsReloadCoordinator.markToolResultDelivered(
        runtimeScope,
        'copilot-load',
      );
      await deferredToolsReloadCoordinator.begin({
        scope: runtimeScope,
        requestId: intent.requestId,
        toolCallId: 'copilot-load',
        additions,
        enabledResources,
      });
      expect(observed).toHaveBeenCalledWith({
        provider: 'copilot',
        pluginSelections: undefined,
      });
    } finally {
      observed.mockRestore();
      deferredToolsReloadCoordinator.cancelActiveReload(runtimeScope);
    }
  });
});
