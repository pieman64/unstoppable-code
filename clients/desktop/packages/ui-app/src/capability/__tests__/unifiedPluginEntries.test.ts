import type { CuratedPluginEntry } from '@canopy/protocol/plugin-catalog';
import type { CuratedMcpServerEntry } from '@canopy/protocol/mcp-catalog';
import {
  CURATED_PLUGIN_MARKETPLACE_ID,
  type MarketplaceInfo,
  type MarketplaceProviderStatus,
  type PluginInfo,
  type PluginProvider,
  type SharedPluginSummary,
} from '@canopy/protocol/plugins';
import type { SharedAgentSummary } from '@canopy/protocol/agents';
import type {
  InstalledSkillInfo,
  SharedSkillSummary,
} from '@canopy/protocol/skills';
import type { PipelineInfo } from '@canopy/protocol/pipelines';
import type {
  CollectionIndexEntry,
  SharedCollectionSummary,
} from '@canopy/protocol/collections';
import type {
  AccountMcpConnection,
  McpServerIndexEntry,
  McpServerStatusEntry,
} from '@canopy/protocol/mcp-servers';
import type { SharedAutomationSummary } from '@canopy/protocol/automations';
import type { CuratedAutomationSummary } from '@canopy/protocol/automation-catalog';
import type { WorkspaceTemplateShareSummary } from '@canopy/protocol/workspace-templates';
import type { UnifiedLocalAgentInput } from '@canopy/protocol/unified-entry';
import {
  buildInstalledSkillEntry,
  buildUnifiedPluginEntries,
  collectEntryCategories,
  githubOwnerAvatarUrl,
  localAgentIdFromEntryId,
  marketplacePluginAlternatives,
  marketplacePluginBundledServerRows,
  pendingLocalAgentEntry,
  pendingSharedAutomationEntry,
  pluginOwnerAvatarUrl,
  skillOwnerAvatarUrl,
  searchUnifiedEntries,
  type UnifiedEntryInputs,
  type UnifiedLocalAutomationInput,
  type UnifiedMarketplaceInput,
  type UnifiedMarketplacePluginInput,
  type UnifiedPluginEntry,
} from '../unifiedPluginEntries';
import { MCP_BRAND_LOGOS } from '@canopy/ui-shared/lib/mcp-brand-logos';
import { listedAsItsPlugin } from '../marketplaceBrowse';
import { unifiedEntryIdForRef } from '../unified-entry-id';
import { describeRunUnavailable } from '../../workflows/workflow-library-model';
import {
  installedEntryStatusStates,
  sharedByMeLine,
} from '@canopy/ui-shared/lib';
import {
  sharedByYouAudienceCount,
  sharedByYouAudiences,
} from '../../sharing/sharedByYouAudiences';
import { buildCustomizeTabModel } from '../customizeSections';

describe('author-side shared skill installed identity (CAN-5272)', () => {
  const statuses = ['active', 'available', 'disabled'] as const;
  const shares: SharedSkillSummary[] = [...statuses, 'unlinked'].map(
    (status) => ({
      id: `share-${status}`,
      name: `published-${status}`,
      description: '',
      contentHash: 'hash',
      shareScope: 'organization',
      owner: { type: 'organization', id: 'org-1', name: 'Org' },
      createdBy: { id: 'viewer', name: 'Viewer', email: null },
      createdAt: '2026-10-28T00:00:00Z',
      updatedAt: '2026-10-28T00:00:00Z',
      canUpdate: true,
      canDelete: true,
      publicShare: null,
    }),
  );
  const skills = statuses.map((status) =>
    makeSkill({
      name: `local-${status}`,
      remote: {
        accountId: 'viewer',
        remoteId: `share-${status}`,
        contentHash: 'hash',
        shareScope: 'organization',
        sharedAt: 'now',
      },
    }),
  );
  function projected(
    viewerId: string | null = 'viewer',
    installedSkills = skills,
  ): UnifiedPluginEntry[] {
    return buildUnifiedPluginEntries(
      emptyInputs({ viewerId, installedSkills, sharedSkills: shares }),
    );
  }
  function states(
    entries: UnifiedPluginEntry[],
  ): ReturnType<typeof installedEntryStatusStates> {
    return installedEntryStatusStates(entries, {
      kind: 'ready',
      snapshot: {
        items: statuses.map((status) => ({
          target: {
            kind: 'skill',
            sourceId: 'local',
            skillName: `local-${status}`,
          },
          status,
          removable: true,
          notices: [],
        })),
      },
    });
  }
  it('projects persisted remote identity and the installed status onto differently named owned shares', () => {
    const entries = projected();
    const projectedStates = states(entries);
    for (const status of statuses) {
      const id = `skill:shared:share-${status}`;
      expect(entries.find((row) => row.id === id)).toMatchObject({
        installedEntryId: `skill:local:local-${status}`,
        ownedByViewer: true,
      });
      expect(projectedStates[id]).toMatchObject({
        kind: 'ready',
        item: { status },
      });
      for (const tab of ['all', 'skill'] as const) {
        const model = buildCustomizeTabModel({
          tab,
          entries,
          installedInventory: 'ready',
          ownershipAvailable: true,
          installedStatusFilter: status,
          installedStatusStates: projectedStates,
        });
        expect(
          model.sections.map((section) => [section.id, section.count]),
        ).toEqual([
          ['installed', 1],
          ['shared-by-me', 1],
        ]);
        expect(
          model.sections
            .find((section) => section.id === 'shared-by-me')
            ?.entries.map((row) => row.id),
        ).toEqual([id]);
        expect(model.resultCount).toBe(1);
      }
    }
  });
  it('keeps unlinked shares Any-only and excludes linked installs from Browse on both tabs and search', () => {
    const entries = projected();
    for (const tab of ['all', 'skill'] as const) {
      for (const query of ['', 'published']) {
        const model = buildCustomizeTabModel({
          tab,
          entries,
          query,
          installedInventory: 'ready',
          ownershipAvailable: true,
          installedStatusStates: states(entries),
        });
        expect(
          model.sections
            .find((section) => section.id === 'browse')
            ?.entries.map((row) => row.id),
        ).toEqual(['skill:shared:share-unlinked']);
        expect(
          model.sections.find((section) => section.id === 'shared-by-me')
            ?.count,
        ).toBe(4);
        expect(model.resultCount).toBe(4);
      }
    }
  });
  it('never guesses author links from names, another account, or absent ownership', () => {
    const wrongAccount = skills.map((skill) => ({
      ...skill,
      remote: skill.remote && { ...skill.remote, accountId: 'other' },
    }));
    for (const entries of [
      projected('viewer', wrongAccount),
      projected('other'),
      projected(null),
      projected('viewer', [makeSkill({ name: 'published-active' })]),
    ]) {
      expect(
        entries
          .filter((row) => row.origin === 'shared')
          .every((row) => row.installedEntryId === undefined),
      ).toBe(true);
    }
  });
  it('does not choose a status when multiple installed copies claim the same author share', () => {
    const entries = projected('viewer', [
      ...skills,
      { ...skills[0], name: 'second-copy' },
    ]);
    expect(
      entries.find((row) => row.id === 'skill:shared:share-active')
        ?.installedEntryId,
    ).toBeUndefined();
  });
  it('accepts the existing portable Portal share identity through the same projection', () => {
    const portalSkill = {
      name: 'portal-copy',
      sourceId: 'local',
      description: '',
      shareRemoteId: 'share-active',
    };
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        viewerId: 'viewer',
        sharedSkills: shares,
        installedSkills: [portalSkill],
      }),
    );
    expect(
      entries.find((row) => row.id === 'skill:shared:share-active')
        ?.installedEntryId,
    ).toBe('skill:local:portal-copy');
  });
});

// ---------------------------------------------------------------------------
// Fixture builders — explicit typed literals, no `as`.
// ---------------------------------------------------------------------------

function makeCuratedPlugin(
  overrides: Partial<CuratedPluginEntry> = {},
): CuratedPluginEntry {
  return {
    key: 'acme-plugin',
    name: 'Acme Plugin',
    shortDescription: 'Acme automations for your workflow',
    categories: ['productivity'],
    popular: false,
    sortOrder: 0,
    contentHash: 'hash-acme-plugin',
    mcpServers: [],
    skills: [],
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeProviderStatus(
  provider: PluginProvider,
): MarketplaceProviderStatus {
  return {
    provider,
    state: 'valid',
    accepted: true,
    pluginCount: 0,
    lastCheckedAt: '2026-08-01T00:00:00.000Z',
  };
}

function makeMarketplace(
  overrides: Partial<MarketplaceInfo> = {},
): MarketplaceInfo {
  return {
    id: 'mkt-github-one',
    name: 'Marketplace One',
    sourceType: 'github',
    sourceUrl: 'https://github.com/example/marketplace-one',
    installLocation: '/tmp/marketplace-one',
    pluginCount: 0,
    plugins: [],
    providerStatus: {
      claude: makeProviderStatus('claude'),
      codex: makeProviderStatus('codex'),
    },
    validProviders: ['claude', 'codex'],
    ...overrides,
  };
}

function makePluginInfo(overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    name: 'sample-plugin',
    sourcePath: 'plugins/sample-plugin',
    marketplaceId: 'mkt-github-one',
    providerSupport: { claude: 'native', codex: 'none' },
    facets: {},
    ...overrides,
  };
}

function makeSkill(
  overrides: Partial<InstalledSkillInfo> = {},
): InstalledSkillInfo {
  return {
    name: 'sample-skill',
    sourceId: 'local',
    description: 'A sample installed skill',
    source: 'local',
    installedAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    updateAvailable: false,
    ...overrides,
  };
}

function makeMcpIndexEntry(
  overrides: Partial<McpServerIndexEntry> = {},
): McpServerIndexEntry {
  return {
    id: 'server-1',
    name: 'Sample Server',
    description: 'A sample MCP server',
    type: 'http',
    configs: [],
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeMcpStatus(
  overrides: Partial<McpServerStatusEntry> = {},
): McpServerStatusEntry {
  return {
    serverId: 'server-1',
    transport: 'http',
    connectionStatus: 'connected',
    reachability: 'reachable',
    configs: [],
    ...overrides,
  };
}

function makeCuratedMcp(
  overrides: Partial<CuratedMcpServerEntry> = {},
): CuratedMcpServerEntry {
  return {
    key: 'acme-mcp',
    name: 'Acme MCP',
    shortDescription: 'Acme MCP integration',
    url: 'https://mcp.acme.example/http',
    transport: 'http',
    categories: ['productivity'],
    popular: false,
    sortOrder: 0,
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * The served catalog is the only source of what is advertised — there is no
 * bundled fallback — so every provider-connector test has to supply it.
 */
const CONNECTOR_CATALOG: CuratedMcpServerEntry[] = [
  makeCuratedMcp({
    key: 'gmail-gmailmcp',
    name: 'Gmail',
    providerConnector: { providers: ['claude', 'codex'] },
  }),
  makeCuratedMcp({
    key: 'google-drive-drivemcp',
    name: 'Google Drive',
    providerConnector: { providers: ['claude', 'codex'] },
  }),
  makeCuratedMcp({
    key: 'google-calendar-calendarmcp',
    name: 'Google Calendar',
    providerConnector: { providers: ['claude', 'codex'] },
  }),
];

function emptyInputs(
  overrides: Partial<UnifiedEntryInputs> = {},
): UnifiedEntryInputs {
  return {
    curatedPlugins: [],
    marketplaces: [],
    installedSkills: [],
    mcpServers: [],
    mcpStatuses: [],
    curatedMcpServers: [],
    providerConnectors: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Dedup / state rules
// ---------------------------------------------------------------------------

describe('buildUnifiedPluginEntries — curated plugin dedup (rule 1)', () => {
  it('honors the portal collapsed installed bit when provider status is omitted', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        curatedPlugins: [makeCuratedPlugin()],
        marketplaces: [
          {
            id: CURATED_PLUGIN_MARKETPLACE_ID,
            name: 'Curated',
            curated: true,
            plugins: [
              {
                name: 'acme-plugin',
                marketplaceId: CURATED_PLUGIN_MARKETPLACE_ID,
                providerSupport: { claude: 'native', codex: 'compat' },
                installed: true,
              },
            ],
          },
        ],
      }),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].state).toBe('installed');
  });

  it('merges the curated/cloud marketplace row with its catalog entry into one installed entry', () => {
    const catalogEntry = makeCuratedPlugin({
      key: 'acme-plugin',
      recommended: true,
    });
    const marketplace = makeMarketplace({
      id: CURATED_PLUGIN_MARKETPLACE_ID,
      curated: true,
      plugins: [
        makePluginInfo({
          name: 'acme-plugin',
          marketplaceId: CURATED_PLUGIN_MARKETPLACE_ID,
          globalInstallStatus: {
            claude: { available: true, installed: true },
            checkedAt: '2026-08-01T00:00:00.000Z',
          },
        }),
      ],
    });

    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        curatedPlugins: [catalogEntry],
        marketplaces: [marketplace],
      }),
    );

    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.id).toBe('curated:acme-plugin');
    expect(entry.origin).toBe('curated');
    expect(entry.kind).toBe('plugin');
    expect(entry.state).toBe('installed');
    expect(entry.recommended).toBe(true);
  });

  it('is available when globalInstallStatus reports no provider installed', () => {
    const catalogEntry = makeCuratedPlugin({ key: 'acme-plugin' });
    const marketplace = makeMarketplace({
      id: CURATED_PLUGIN_MARKETPLACE_ID,
      curated: true,
      plugins: [
        makePluginInfo({
          name: 'acme-plugin',
          marketplaceId: CURATED_PLUGIN_MARKETPLACE_ID,
          globalInstallStatus: {
            claude: { available: true, installed: false },
            codex: { available: true, installed: false },
            checkedAt: '2026-08-01T00:00:00.000Z',
          },
        }),
      ],
    });

    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        curatedPlugins: [catalogEntry],
        marketplaces: [marketplace],
      }),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].state).toBe('available');
  });

  it('falls back to available when the catalog entry has no matching marketplace row yet', () => {
    const catalogEntry = makeCuratedPlugin({ key: 'not-yet-synced' });

    const entries = buildUnifiedPluginEntries(
      emptyInputs({ curatedPlugins: [catalogEntry] }),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('curated:not-yet-synced');
    expect(entries[0].state).toBe('available');
  });
});

describe('buildUnifiedPluginEntries — curated MCP dedup (rule 2)', () => {
  it('collapses a local server carrying curatedKey with the matching catalog entry as installed', () => {
    const catalogEntry = makeCuratedMcp({ key: 'acme-mcp' });
    const indexEntry = makeMcpIndexEntry({
      id: 'server-1',
      curatedKey: 'acme-mcp',
    });
    const status = makeMcpStatus({
      serverId: 'server-1',
      connectionStatus: 'connected',
    });

    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        curatedMcpServers: [catalogEntry],
        mcpServers: [indexEntry],
        mcpStatuses: [status],
      }),
    );

    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.id).toBe('mcp-catalog:acme-mcp');
    expect(entry.kind).toBe('app');
    expect(entry.typeLabel).toBe('MCP server');
    expect(entry.origin).toBe('curated');
    expect(entry.state).toBe('installed');
  });

  it('derives needs-auth state from an auth_required connection status', () => {
    const catalogEntry = makeCuratedMcp({ key: 'acme-mcp' });
    const indexEntry = makeMcpIndexEntry({
      id: 'server-1',
      curatedKey: 'acme-mcp',
    });
    const status = makeMcpStatus({
      serverId: 'server-1',
      connectionStatus: 'auth_required',
    });

    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        curatedMcpServers: [catalogEntry],
        mcpServers: [indexEntry],
        mcpStatuses: [status],
      }),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].state).toBe('needs-auth');
  });

  it('projects a catalog entry with no local server as available', () => {
    const catalogEntry = makeCuratedMcp({ key: 'acme-mcp' });

    const entries = buildUnifiedPluginEntries(
      emptyInputs({ curatedMcpServers: [catalogEntry] }),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('mcp-catalog:acme-mcp');
    expect(entries[0].state).toBe('available');
  });

  it('falls back to a standalone app entry when curatedKey does not resolve in the catalog', () => {
    const indexEntry = makeMcpIndexEntry({
      id: 'server-1',
      curatedKey: 'unknown-key',
    });

    const entries = buildUnifiedPluginEntries(
      emptyInputs({ mcpServers: [indexEntry] }),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('mcp-local:server-1');
    expect(entries[0].origin).toBe('installed-standalone');
    // The stored key still travels on the ref: the catalog can be empty or
    // stale (offline, brand-scoped, or trimmed) while the bundled brand mark
    // for that key ships with the app, so the row must keep resolving it.
    expect(entries[0].ref).toEqual({
      type: 'local-mcp',
      serverId: 'server-1',
      curatedKey: 'unknown-key',
    });
  });

  it('omits curatedKey from the local ref when the server never had one', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({ mcpServers: [makeMcpIndexEntry({ id: 'server-2' })] }),
    );

    expect(entries[0].ref).toEqual({ type: 'local-mcp', serverId: 'server-2' });
  });
});

describe('buildUnifiedPluginEntries — non-curated marketplace plugins (rule 3)', () => {
  it('derives installed state from globalInstallStatus for built-in rows', () => {
    const marketplace = makeMarketplace({
      id: 'builtin/app',
      builtIn: true,
      plugins: [
        makePluginInfo({
          name: 'built-in-plugin',
          marketplaceId: 'builtin/app',
          globalInstallStatus: {
            codex: { available: true, installed: true },
            checkedAt: '2026-08-01T00:00:00.000Z',
          },
        }),
      ],
    });

    const entries = buildUnifiedPluginEntries(
      emptyInputs({ marketplaces: [marketplace] }),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].origin).toBe('marketplace');
    expect(entries[0].state).toBe('installed');
  });

  it('defaults to available for regular marketplace plugins with no globalInstallStatus', () => {
    const marketplace = makeMarketplace({
      id: 'mkt-github-one',
      plugins: [
        makePluginInfo({
          name: 'community-plugin',
          marketplaceId: 'mkt-github-one',
        }),
      ],
    });

    const entries = buildUnifiedPluginEntries(
      emptyInputs({ marketplaces: [marketplace] }),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].state).toBe('available');
    expect(entries[0].id).toBe('mkt:mkt-github-one/community-plugin');
  });

  it('reads component counts from PluginInfo.details', () => {
    const marketplace = makeMarketplace({
      id: 'mkt-github-one',
      plugins: [
        makePluginInfo({
          name: 'community-plugin',
          marketplaceId: 'mkt-github-one',
          details: {
            skills: [{ name: 's1', description: 'd', path: 'skills/s1' }],
            agents: [{ name: 'a1', description: 'd', filePath: 'agents/a1' }],
            commands: [
              { name: 'c1', description: 'd', filePath: 'commands/c1' },
              { name: 'c2', description: 'd', filePath: 'commands/c2' },
            ],
            mcpServers: [{ name: 'm1', type: 'http', url: 'https://x' }],
            lspServers: [],
            hooks: [],
            hasReadme: true,
          },
        }),
      ],
    });

    const entries = buildUnifiedPluginEntries(
      emptyInputs({ marketplaces: [marketplace] }),
    );

    expect(entries[0].components).toEqual({
      skills: 1,
      mcpServers: 1,
      commands: 2,
      agents: 1,
    });
  });
});

describe('githubOwnerAvatarUrl', () => {
  it('derives the owner avatar from a normalized GitHub marketplace URL', () => {
    // `normalizeMarketplaceSourceUrl` (main) collapses every recognized GitHub
    // source to exactly this shape before it is persisted, so this is the only
    // form that reaches the renderer.
    expect(
      githubOwnerAvatarUrl(
        'https://github.com/anthropics/claude-plugins-official',
      ),
    ).toBe('https://github.com/anthropics.png?size=128');
  });

  it('accepts a GitHub SSH remote, through the shared owner parser', () => {
    expect(
      githubOwnerAvatarUrl('git@github.com:anthropics/claude-plugins.git'),
    ).toBe('https://github.com/anthropics.png?size=128');
    expect(githubOwnerAvatarUrl('git@github.com:../x.git')).toBeUndefined();
  });

  it('accepts an owner-only URL, since the avatar needs no repo', () => {
    expect(githubOwnerAvatarUrl('https://github.com/anthropics')).toBe(
      'https://github.com/anthropics.png?size=128',
    );
  });

  it('rejects hosts that merely embed github.com', () => {
    // A prefix/suffix match would hand an attacker-controlled host the image
    // request, so the hostname is compared exactly rather than searched for.
    expect(
      githubOwnerAvatarUrl('https://github.com.evil.example/anthropics/x'),
    ).toBeUndefined();
    expect(
      githubOwnerAvatarUrl('https://notgithub.com/anthropics/x'),
    ).toBeUndefined();
    expect(
      githubOwnerAvatarUrl('https://evil.example/github.com/anthropics'),
    ).toBeUndefined();
  });

  it('returns nothing for the non-URL sources other marketplaces carry', () => {
    // Real values seen in the plugin cache for Codex/built-in/curated rows.
    expect(githubOwnerAvatarUrl('openai-bundled')).toBeUndefined();
    expect(githubOwnerAvatarUrl('builtin:app')).toBeUndefined();
    expect(githubOwnerAvatarUrl('curated:cloud')).toBeUndefined();
    expect(githubOwnerAvatarUrl('')).toBeUndefined();
  });

  it('rejects an owner segment that is not a plain GitHub handle', () => {
    // The owner is interpolated into a URL, so anything that could smuggle a
    // path or query out of that position is refused rather than escaped.
    expect(githubOwnerAvatarUrl('https://github.com/..')).toBeUndefined();
    expect(
      githubOwnerAvatarUrl('https://github.com/-leading/x'),
    ).toBeUndefined();
    expect(githubOwnerAvatarUrl('https://github.com//x')).toBeUndefined();
  });

  it('ignores non-http protocols that still parse as URLs', () => {
    expect(
      githubOwnerAvatarUrl('file:///github.com/anthropics'),
    ).toBeUndefined();
  });
});

describe('pluginOwnerAvatarUrl', () => {
  it('prefers the vendored source repo the plugin is pulled from', () => {
    // Shape taken verbatim from a real `plugins-cache.json` row.
    expect(
      pluginOwnerAvatarUrl(
        makePluginInfo({
          name: '42crunch-api-security-testing',
          homepage: 'https://42crunch.com',
          externalSource: {
            source: 'git-subdir',
            url: 'https://github.com/42Crunch-AI/claude-plugins.git',
          },
        }),
      ),
    ).toBe('https://github.com/42Crunch-AI.png?size=128');
  });

  it('falls back to a GitHub homepage when there is no external source', () => {
    // In-repo plugins point their homepage at their own subdirectory, so the
    // owner still resolves — including genuinely first-party ones.
    expect(
      pluginOwnerAvatarUrl(
        makePluginInfo({
          name: 'agent-sdk-dev',
          homepage:
            'https://github.com/anthropics/claude-plugins-public/tree/main/plugins/agent-sdk-dev',
        }),
      ),
    ).toBe('https://github.com/anthropics.png?size=128');
  });

  it('ignores a non-GitHub homepage rather than guessing', () => {
    expect(
      pluginOwnerAvatarUrl(
        makePluginInfo({
          name: 'greptile',
          homepage: 'https://greptile.com/docs',
        }),
      ),
    ).toBeUndefined();
  });

  it('gives nothing when the plugin carries no source of its own', () => {
    expect(
      pluginOwnerAvatarUrl(makePluginInfo({ name: 'lua-lsp' })),
    ).toBeUndefined();
  });
});

describe('buildUnifiedPluginEntries — bundled marks', () => {
  it('gives Codex Security the bundled OpenAI mark in the official marketplace', () => {
    // Codex's marketplaces list a website homepage rather than a repo, so no
    // avatar is derivable for these 42 plugins; the bundled mark is the only
    // offline answer.
    const marketplace = makeMarketplace({
      id: 'openai-curated',
      sourceType: 'codex',
      sourceUrl: 'openai-curated',
      plugins: [
        makePluginInfo({
          name: 'codex-security',
          author: 'OpenAI',
          homepage: 'https://developers.openai.com/codex/security',
        }),
      ],
    });

    const entries = buildUnifiedPluginEntries(
      emptyInputs({ marketplaces: [marketplace] }),
    );

    expect(entries[0].bundledLogo).toBe(MCP_BRAND_LOGOS.openai);
    // The website homepage is still not a repo, so no avatar is invented.
    expect(entries[0].logoUrl).toBeUndefined();
  });

  it('matches the vendor on author, not on plugin name', () => {
    // A plugin merely NAMED `box` is not Box; only the vendor's own claim
    // about itself indexes into the bundled table.
    const marketplace = makeMarketplace({
      plugins: [makePluginInfo({ name: 'openai', author: 'Some Reseller' })],
    });

    const entries = buildUnifiedPluginEntries(
      emptyInputs({ marketplaces: [marketplace] }),
    );

    expect(entries[0].bundledLogo).toBeUndefined();
  });

  it("gives built-in plugins the app's own brand mark", () => {
    const marketplace = makeMarketplace({
      builtIn: true,
      plugins: [makePluginInfo({ name: 'builtin-gh', builtIn: true })],
    });

    const entries = buildUnifiedPluginEntries(
      emptyInputs({ marketplaces: [marketplace] }),
    );

    // A flag, not an image: the brand asset uses `currentColor`, which only
    // resolves when the SVG is inlined rather than set as an <img> src.
    expect(entries[0].brandMark).toBe(true);
    expect(entries[0].bundledLogo).toBeUndefined();
  });

  it("gives built-in skills the app's own brand mark", () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        installedSkills: [
          makeSkill({
            name: 'branch-naming',
            builtIn: true,
            sourceId: 'local',
          }),
        ],
      }),
    );

    expect(entries[0].brandMark).toBe(true);
  });

  it('leaves a third-party plugin without a bundled mark', () => {
    const marketplace = makeMarketplace({
      plugins: [makePluginInfo({ name: 'aiera', author: 'Aiera' })],
    });

    const entries = buildUnifiedPluginEntries(
      emptyInputs({ marketplaces: [marketplace] }),
    );

    expect(entries[0].bundledLogo).toBeUndefined();
    expect(entries[0].brandMark).toBe(false);
  });
});

describe('skillOwnerAvatarUrl', () => {
  it('reassembles the repo URL from a colon-separated GitHub source id', () => {
    // Real `sourceId` shape from `skills-lock.json` — not a URL.
    expect(
      skillOwnerAvatarUrl(
        makeSkill({ sourceId: 'github:unstoppabledomains:agent-plugins' }),
      ),
    ).toBe('https://github.com/unstoppabledomains.png?size=128');
  });

  it('gives nothing for skills with no remote origin', () => {
    expect(
      skillOwnerAvatarUrl(makeSkill({ sourceId: 'local' })),
    ).toBeUndefined();
    expect(
      skillOwnerAvatarUrl(makeSkill({ sourceId: 'github:owner-only' })),
    ).toBeUndefined();
  });

  it('carries the avatar onto the built skill entry', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        installedSkills: [
          makeSkill({ name: 'workflow', sourceId: 'github:vercel:workflow' }),
        ],
      }),
    );

    expect(entries[0].logoUrl).toBe('https://github.com/vercel.png?size=128');
  });
});

describe('buildUnifiedPluginEntries — marketplace plugin logos', () => {
  it('uses the product logo supplied by the plugin catalog', () => {
    const catalogLogo = 'https://cdn.example.test/air-ops-logo.png';
    const plugin = Object.assign(
      makePluginInfo({ name: 'air-ops', author: 'AirOps' }),
      { logoUrl: catalogLogo },
    );
    const marketplace = makeMarketplace({
      id: 'openai-curated',
      plugins: [plugin],
    });

    const entries = buildUnifiedPluginEntries(
      emptyInputs({ marketplaces: [marketplace] }),
    );

    expect(entries[0].logoUrl).toBe(catalogLogo);
  });

  it('uses product marks instead of the OpenAI publisher mark for official plugins', () => {
    const marketplace = makeMarketplace({
      id: 'openai-curated',
      plugins: [
        makePluginInfo({ name: 'github', author: 'GitHub' }),
        makePluginInfo({ name: 'gmail', author: 'Google' }),
        makePluginInfo({ name: 'google-drive', author: 'Google' }),
        makePluginInfo({ name: 'google-calendar', author: 'Google' }),
        makePluginInfo({ name: 'notion', author: 'Notion' }),
        makePluginInfo({ name: 'slack', author: 'Slack' }),
        makePluginInfo({ name: 'linear', author: 'Linear' }),
        makePluginInfo({ name: 'figma', author: 'Figma' }),
        makePluginInfo({ name: 'atlassian-rovo', author: 'Atlassian' }),
        makePluginInfo({ name: 'canva' }),
      ],
    });

    const entries = buildUnifiedPluginEntries(
      emptyInputs({ marketplaces: [marketplace] }),
    );

    expect(entries.map((entry) => entry.bundledLogo)).toEqual([
      MCP_BRAND_LOGOS.github,
      MCP_BRAND_LOGOS['gmail-gmailmcp'],
      MCP_BRAND_LOGOS['google-drive-drivemcp'],
      MCP_BRAND_LOGOS['google-calendar-calendarmcp'],
      MCP_BRAND_LOGOS.notion,
      MCP_BRAND_LOGOS.slack,
      MCP_BRAND_LOGOS.linear,
      MCP_BRAND_LOGOS.figma,
      MCP_BRAND_LOGOS.atlassian,
      MCP_BRAND_LOGOS.canva,
    ]);
  });

  it('keeps bundled marks for the explicitly mapped official plugin fixtures', () => {
    const marketplace = makeMarketplace({
      id: 'openai-curated',
      plugins: [
        'gmail',
        'github',
        'google-drive',
        'google-calendar',
        'notion',
        'slack',
        'linear',
        'figma',
        'atlassian-rovo',
        'canva',
        'granola',
        'fireflies',
        'outlook-calendar',
        'plaud',
        'otter-ai',
        'asana',
        'box',
        'clickup',
        'dropbox',
        'reclaim',
        'todoist',
        'trello',
      ].map((name) => makePluginInfo({ name })),
    });

    const entries = buildUnifiedPluginEntries(
      emptyInputs({ marketplaces: [marketplace] }),
    );

    expect(
      entries.map((entry) => ({
        name: entry.name,
        hasProductMark: entry.bundledLogo !== undefined,
      })),
    ).toEqual(
      entries.map((entry) => ({ name: entry.name, hasProductMark: true })),
    );
  });

  it('uses the product website favicon when an official plugin has no catalog artwork', () => {
    // A product the bundled table deliberately does not carry a mark for, so
    // the favicon really is the last resort rather than a missed mapping.
    const marketplace = makeMarketplace({
      id: 'openai-curated',
      plugins: [
        makePluginInfo({
          name: 'product-design',
          displayName: 'Product Design',
          homepage: 'https://openai.com/',
        }),
      ],
    });

    const entries = buildUnifiedPluginEntries(
      emptyInputs({ marketplaces: [marketplace] }),
    );

    expect(entries[0].logoUrl).toBe(
      'https://www.google.com/s2/favicons?domain_url=https%3A%2F%2Fopenai.com%2F&sz=128',
    );
  });

  it('gives the whole Microsoft 365 family its product mark, not a favicon', () => {
    // Every `openai-curated` row ships `logoUrl: null`, so the bundled table
    // is the only source of a real mark. `outlook-calendar` was mapped and
    // its three siblings were not, which is why Outlook Email, SharePoint and
    // Teams sat on a monogram beside a correctly-marked Outlook Calendar.
    const marketplace = makeMarketplace({
      id: 'openai-curated',
      plugins: [
        makePluginInfo({
          name: 'outlook-calendar',
          homepage:
            'https://www.microsoft.com/en-us/microsoft-365/outlook/calendar-app',
        }),
        makePluginInfo({
          name: 'outlook-email',
          homepage:
            'https://www.microsoft.com/en-us/microsoft-365/outlook/email-and-calendar-software-microsoft-outlook',
        }),
        makePluginInfo({
          name: 'sharepoint',
          homepage:
            'https://www.microsoft.com/en-us/microsoft-365/sharepoint/collaboration',
        }),
        makePluginInfo({
          name: 'teams',
          homepage:
            'https://www.microsoft.com/en-us/microsoft-teams/group-chat-software',
        }),
      ],
    });

    const entries = buildUnifiedPluginEntries(
      emptyInputs({ marketplaces: [marketplace] }),
    );

    expect(entries.map((entry) => entry.bundledLogo)).toEqual([
      MCP_BRAND_LOGOS['microsoft-365'],
      MCP_BRAND_LOGOS['microsoft-365'],
      MCP_BRAND_LOGOS['microsoft-365'],
      MCP_BRAND_LOGOS['microsoft-365'],
    ]);
    // A bundled mark resolved, so no favicon request is invented behind it.
    expect(entries.map((entry) => entry.logoUrl)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('uses the product website favicon when a curated connector has no catalog artwork', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        curatedMcpServers: [
          makeCuratedMcp({
            key: 'airops',
            name: 'AirOps',
            authorUrl: 'https://www.airops.com/',
            logoUrl: undefined,
          }),
          makeCuratedMcp({
            key: 'appfolio-realm-x',
            name: 'AppFolio Realm-X',
            authorUrl: 'https://www.appfolio.com/',
            logoUrl: undefined,
          }),
        ],
      }),
    );

    expect(entries.map((entry) => entry.logoUrl)).toEqual([
      'https://www.google.com/s2/favicons?domain_url=https%3A%2F%2Fwww.airops.com%2F&sz=128',
      'https://www.google.com/s2/favicons?domain_url=https%3A%2F%2Fwww.appfolio.com%2F&sz=128',
    ]);
  });

  it('does not lend official product marks to same-name third-party plugins', () => {
    const marketplace = makeMarketplace({
      id: 'community-marketplace',
      plugins: [
        makePluginInfo({ name: 'notion', author: 'OpenAI' }),
        makePluginInfo({ name: 'figma', author: 'OpenAI' }),
      ],
    });

    const entries = buildUnifiedPluginEntries(
      emptyInputs({ marketplaces: [marketplace] }),
    );

    expect(entries.map((entry) => entry.bundledLogo)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it('badges each plugin with its own publisher, not the marketplace owner', () => {
    // The regression this guards: `claude-plugins-official` aggregates 286
    // plugins from 179 owners. Deriving the logo from the marketplace stamped
    // Anthropic's mark onto Auth0's, Adobe's and Figma's plugins alike —
    // worse than a blank tile, because it asserts the wrong provenance.
    const marketplace = makeMarketplace({
      sourceUrl: 'https://github.com/anthropics/claude-plugins-official',
      plugins: [
        makePluginInfo({
          name: 'adobe-for-creativity',
          externalSource: {
            source: 'git-subdir',
            url: 'https://github.com/adobe/skills.git',
          },
        }),
        makePluginInfo({
          name: 'auth0',
          externalSource: {
            source: 'git-subdir',
            url: 'https://github.com/auth0/auth0-claude-plugins.git',
          },
        }),
      ],
    });

    const entries = buildUnifiedPluginEntries(
      emptyInputs({ marketplaces: [marketplace] }),
    );

    expect(entries.map((entry) => entry.logoUrl)).toEqual([
      'https://github.com/adobe.png?size=128',
      'https://github.com/auth0.png?size=128',
    ]);
  });

  it('leaves a plugin with no source of its own on the monogram', () => {
    const marketplace = makeMarketplace({
      sourceUrl: 'https://github.com/anthropics/claude-plugins-official',
      plugins: [makePluginInfo({ name: 'lua-lsp' })],
    });

    const entries = buildUnifiedPluginEntries(
      emptyInputs({ marketplaces: [marketplace] }),
    );

    // Deliberately NOT the marketplace owner's avatar.
    expect(entries[0].logoUrl).toBeUndefined();
  });
});

describe('buildUnifiedPluginEntries — official wrapper attribution', () => {
  it('attributes a wrapped product to its vendor, not to the wrapper author', () => {
    // OpenAI declares itself `author` on the connectors it maintains for other
    // vendors' products, so every Microsoft surface read "by OpenAI" beside a
    // Microsoft logo. Same product-identity-over-publisher-identity rule the
    // bundled marks already follow.
    const marketplace = makeMarketplace({
      id: 'openai-curated',
      plugins: [
        makePluginInfo({ name: 'teams', author: 'OpenAI' }),
        makePluginInfo({ name: 'sharepoint', author: 'OpenAI' }),
        makePluginInfo({ name: 'outlook-email', author: 'OpenAI' }),
        makePluginInfo({ name: 'gmail', author: 'OpenAI' }),
        makePluginInfo({ name: 'github', author: 'OpenAI' }),
      ],
    });

    const entries = buildUnifiedPluginEntries(
      emptyInputs({ marketplaces: [marketplace] }),
    );

    expect(entries.map((entry) => entry.authorName)).toEqual([
      'Microsoft',
      'Microsoft',
      'Microsoft',
      'Google',
      'GitHub',
    ]);
    // The ownership line the card renders moves with it.
    expect(entries.map((entry) => entry.ownershipLabel)).toEqual([
      'Microsoft',
      'Microsoft',
      'Microsoft',
      'Google',
      'GitHub',
    ]);
  });

  it("keeps OpenAI's own products attributed to OpenAI", () => {
    const marketplace = makeMarketplace({
      id: 'openai-curated',
      plugins: [
        makePluginInfo({ name: 'codex-security', author: 'OpenAI' }),
        makePluginInfo({ name: 'openai-developers', author: 'OpenAI' }),
      ],
    });

    const entries = buildUnifiedPluginEntries(
      emptyInputs({ marketplaces: [marketplace] }),
    );

    expect(entries.map((entry) => entry.authorName)).toEqual([
      'OpenAI',
      'OpenAI',
    ]);
  });

  it("never overwrites a vendor's own claim about itself", () => {
    // `Linear Orbit, Inc` and `Canva Pty Ltd.` are more precise than the
    // product name the table carries; correcting only the publisher-for-vendor
    // conflation leaves them alone.
    const marketplace = makeMarketplace({
      id: 'openai-curated',
      plugins: [
        makePluginInfo({ name: 'linear', author: 'Linear Orbit, Inc' }),
        makePluginInfo({ name: 'canva', author: 'Canva Pty Ltd.' }),
      ],
    });

    const entries = buildUnifiedPluginEntries(
      emptyInputs({ marketplaces: [marketplace] }),
    );

    expect(entries.map((entry) => entry.authorName)).toEqual([
      'Linear Orbit, Inc',
      'Canva Pty Ltd.',
    ]);
  });

  it('does not lend vendor attribution to same-name third-party plugins', () => {
    // The impersonation guard the bundled marks already carry: a plugin merely
    // NAMED `teams` outside OpenAI's official feed is not Microsoft's.
    const marketplace = makeMarketplace({
      id: 'community-marketplace',
      plugins: [makePluginInfo({ name: 'teams', author: 'OpenAI' })],
    });

    const entries = buildUnifiedPluginEntries(
      emptyInputs({ marketplaces: [marketplace] }),
    );

    expect(entries[0].authorName).toBe('OpenAI');
  });
});

describe('buildUnifiedPluginEntries — installed skills (rule 4)', () => {
  it('projects an installed skill as a single-component skill entry', () => {
    const skill = makeSkill({ sourceId: 'github-org-repo', name: 'my-skill' });

    const entries = buildUnifiedPluginEntries(
      emptyInputs({ installedSkills: [skill] }),
    );

    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.id).toBe('skill:github-org-repo:my-skill');
    expect(entry.kind).toBe('skill');
    expect(entry.origin).toBe('installed-standalone');
    expect(entry.state).toBe('installed');
    expect(entry.components).toEqual({
      skills: 1,
      mcpServers: 0,
      commands: 0,
      agents: 0,
    });
  });

  it('builds the same entry for one skill as the full projection (CAN-3483)', () => {
    const skill = makeSkill({
      sourceId: 'github:octo:skills',
      name: 'my-skill',
      builtIn: false,
    });

    expect(buildInstalledSkillEntry(skill)).toEqual(
      buildUnifiedPluginEntries(emptyInputs({ installedSkills: [skill] }))[0],
    );
  });
});

describe('buildUnifiedPluginEntries — local MCP servers without curatedKey (rule 5)', () => {
  it('projects a plain local server as an installed-standalone app', () => {
    const indexEntry = makeMcpIndexEntry({ id: 'server-9' });

    const entries = buildUnifiedPluginEntries(
      emptyInputs({ mcpServers: [indexEntry] }),
    );

    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.id).toBe('mcp-local:server-9');
    expect(entry.kind).toBe('app');
    expect(entry.typeLabel).toBe('MCP server');
    expect(entry.origin).toBe('installed-standalone');
    expect(entry.state).toBe('installed');
  });
});

describe('buildUnifiedPluginEntries — MCP surface and account state', () => {
  const connection: AccountMcpConnection = {
    id: 'conn-1',
    serverKey: 'custom:def',
    configId: 'default',
    displayName: 'Internal tools',
    status: 'CONNECTED',
    routeId: 'route',
    enabledTools: null,
    kind: 'CUSTOM',
  };

  function onlyEntry(inputs: Partial<UnifiedEntryInputs>): UnifiedPluginEntry {
    const entries = buildUnifiedPluginEntries(emptyInputs(inputs));
    expect(entries).toHaveLength(1);
    return entries[0];
  }

  it('marks account rows cloud and device rows desktop', () => {
    expect(
      onlyEntry({ mcpServers: [makeMcpIndexEntry({ scope: 'account' })] })
        .surface,
    ).toBe('cloud');
    expect(
      onlyEntry({
        mcpServers: [makeMcpIndexEntry({ accountConnection: connection })],
      }).surface,
    ).toBe('cloud');
    expect(onlyEntry({ mcpServers: [makeMcpIndexEntry()] }).surface).toBe(
      'desktop',
    );
  });

  it('marks desktop-only provider connectors and leaves other curated entries unset', () => {
    const connector = makeCuratedMcp({
      providerConnector: { providers: ['claude'] },
    });
    const installed = makeMcpIndexEntry({ curatedKey: connector.key });
    const surfaces = (
      curated: CuratedMcpServerEntry,
    ): Record<string, string | undefined> =>
      Object.fromEntries(
        buildUnifiedPluginEntries(
          emptyInputs({
            curatedMcpServers: [curated],
            mcpServers: [installed],
          }),
        ).map((entry) => [entry.id, entry.surface]),
      );
    // The connector folds into the catalog entry's card (REG-3033), so one
    // id carries the surface for both bindings.
    expect(surfaces(connector)).toEqual({ 'mcp-catalog:acme-mcp': 'desktop' });
    expect(
      surfaces({ ...connector, oauthHints: { scopes: ['read'] } }),
    ).toEqual({ 'mcp-catalog:acme-mcp': undefined });
    expect(
      onlyEntry({ curatedMcpServers: [makeCuratedMcp()] }).surface,
    ).toBeUndefined();
  });

  it('marks a server the catalog flags desktop only, even with an OAuth path (REG-3035)', () => {
    expect(
      onlyEntry({
        curatedMcpServers: [
          makeCuratedMcp({
            availability: 'desktop',
            oauthHints: { scopes: ['read'] },
          }),
        ],
      }).surface,
    ).toBe('desktop');
  });

  describe('a desktop-only card with a cloud connection made before it was marked (REG-3035)', () => {
    const desktopOnly = makeCuratedMcp({
      availability: 'desktop',
      oauthHints: { scopes: ['read'] },
    });
    const accountRow = (
      status: AccountMcpConnection['status'],
    ): McpServerIndexEntry =>
      makeMcpIndexEntry({
        id: desktopOnly.key,
        scope: 'account',
        curatedKey: desktopOnly.key,
        accountConnectionId: 'conn-acme',
        accountConnection: {
          ...connection,
          id: 'conn-acme',
          kind: 'CURATED',
          serverKey: desktopOnly.key,
          status,
        },
        configs: [{ id: 'default', name: 'Default', enabled: true }],
      });

    it.each([
      'DISCONNECTED',
      'REAUTH_REQUIRED',
      'PENDING',
      'CONNECTED',
    ] as const)(
      'offers Add for the device server over a %s cloud connection',
      (status) => {
        // The cloud account never runs this server, so its connection cannot
        // make the card set up, ask for a cloud reconnect, or block Add.
        const entry = onlyEntry({
          curatedMcpServers: [desktopOnly],
          mcpServers: [accountRow(status)],
        });
        expect(entry.state).toBe('available');
        expect(entry.surface).toBe('desktop');
        // The connection stays on the card, so the detail can disconnect it.
        expect(entry.integration?.connections).toEqual([
          expect.objectContaining({
            binding: 'account',
            accountConnectionId: 'conn-acme',
          }),
        ]);
      },
    );

    it('reads the device server alone once it exists', () => {
      const device = (
        authStatus: 'connected' | 'expired',
      ): UnifiedPluginEntry =>
        onlyEntry({
          curatedMcpServers: [desktopOnly],
          mcpServers: [
            {
              ...accountRow('CONNECTED'),
              deviceCopies: [
                makeMcpIndexEntry({
                  id: 'srv-acme',
                  curatedKey: desktopOnly.key,
                  configs: [{ id: 'cfg-1', name: 'Default', enabled: true }],
                }),
              ],
            },
          ],
          mcpStatuses: [
            makeMcpStatus({
              serverId: 'srv-acme',
              connectionStatus:
                authStatus === 'connected' ? 'connected' : 'auth_required',
              configs: [{ configId: 'cfg-1', authStatus }],
            }),
          ],
        });
      expect(device('connected').state).toBe('installed');
      // A connected cloud copy no longer hides a device server needing sign-in.
      expect(device('expired').state).toBe('needs-auth');
    });

    it('keeps account-driven state for a server every surface can connect', () => {
      const curated = makeCuratedMcp({ oauthHints: { scopes: ['read'] } });
      const state = (status: AccountMcpConnection['status']): string =>
        onlyEntry({
          curatedMcpServers: [curated],
          mcpServers: [
            {
              ...accountRow(status),
              id: curated.key,
              curatedKey: curated.key,
            },
          ],
        }).state;
      expect(state('CONNECTED')).toBe('installed');
      expect(state('REAUTH_REQUIRED')).toBe('needs-auth');
      expect(state('DISCONNECTED')).toBe('available');
    });
  });

  it('marks a curated entry cloud once an account connection binds it', () => {
    const curated = makeCuratedMcp();
    const surface = (server: McpServerIndexEntry): string | undefined =>
      onlyEntry({
        curatedMcpServers: [curated],
        mcpServers: [server],
      }).surface;
    expect(
      surface(
        makeMcpIndexEntry({
          scope: 'account',
          curatedKey: curated.key,
          accountConnection: {
            ...connection,
            kind: 'CURATED',
            serverKey: curated.key,
          },
        }),
      ),
    ).toBe('cloud');
    expect(
      surface(makeMcpIndexEntry({ curatedKey: curated.key })),
    ).toBeUndefined();
  });

  it.each([
    ['REAUTH_REQUIRED', 'needs-auth'],
    ['DISCONNECTED', 'available'],
    ['CONNECTED', 'installed'],
    ['PENDING', 'available'],
  ] as const)(
    'derives %s account connections without a status as %s',
    (status, state) => {
      expect(
        onlyEntry({
          mcpServers: [
            makeMcpIndexEntry({
              accountConnection: { ...connection, status },
            }),
          ],
        }).state,
      ).toBe(state);
    },
  );

  it('lets a desktop status refine a connected account row', () => {
    expect(
      onlyEntry({
        mcpServers: [makeMcpIndexEntry({ accountConnection: connection })],
        mcpStatuses: [
          makeMcpStatus({
            connectionStatus: 'auth_required',
            configs: [{ configId: connection.configId, authStatus: 'error' }],
          }),
        ],
      }).state,
    ).toBe('needs-auth');
  });

  /**
   * The desktop's status list describes every account connection that is not
   * CONNECTED as `auth_required` with a `not_connected` configuration. A
   * connection the user never finished (PENDING) or ended (DISCONNECTED) is
   * not something they have, so its lifecycle, not that description, decides
   * whether the row is installed. One account listed 252 abandoned sign-ins
   * under Installed, each reading "Needs attention" (CAN-5303).
   */
  describe('the account connection lifecycle decides whether a row is installed (CAN-5303)', () => {
    /** The status `listMcpServerStatuses` reports for an account row. */
    const accountStatus = (
      authStatus: 'connected' | 'error' | 'expired' | 'not_connected',
    ): McpServerStatusEntry =>
      makeMcpStatus({
        handler: 'account',
        handlerSource: 'server',
        reachability: 'unknown',
        connectionStatus:
          authStatus === 'connected' ? 'connected' : 'auth_required',
        configs: [{ configId: connection.configId, authStatus }],
      });
    const accountRow = (
      status: AccountMcpConnection['status'],
      overrides: Partial<McpServerIndexEntry> = {},
    ): McpServerIndexEntry =>
      makeMcpIndexEntry({
        scope: 'account',
        accountConnectionId: connection.id,
        accountConnection: { ...connection, status },
        configs: [{ id: connection.configId, name: 'Default', enabled: true }],
        ...overrides,
      });

    it.each(['PENDING', 'DISCONNECTED'] as const)(
      'offers a %s connection with a not_connected status as available',
      (status) => {
        const entry = onlyEntry({
          mcpServers: [accountRow(status)],
          mcpStatuses: [accountStatus('not_connected')],
        });
        expect(entry.state).toBe('available');
        expect(entry.pendingSignIns).toBeUndefined();
      },
    );

    it('reads a not_connected Portal account row without its connection as available', () => {
      // The Portal shows the desktop's own account rows until the cloud
      // connection list arrives (or when it fails); they carry the status
      // but not the connection, and `not_connected` is the account
      // handler's word for a pending or disconnected connection.
      const portalRow = (): McpServerIndexEntry =>
        accountRow('PENDING', { accountConnection: undefined });
      expect(
        onlyEntry({
          mcpServers: [portalRow()],
          mcpStatuses: [accountStatus('not_connected')],
        }).state,
      ).toBe('available');
      expect(
        onlyEntry({
          mcpServers: [portalRow()],
          mcpStatuses: [accountStatus('error')],
        }).state,
      ).toBe('needs-auth');
      expect(
        onlyEntry({
          mcpServers: [portalRow()],
          mcpStatuses: [accountStatus('connected')],
        }).state,
      ).toBe('installed');
    });

    it('keeps a REAUTH_REQUIRED connection installed and asking for sign-in', () => {
      const entry = onlyEntry({
        mcpServers: [accountRow('REAUTH_REQUIRED')],
        mcpStatuses: [accountStatus('error')],
      });
      expect(entry.state).toBe('needs-auth');
    });

    it('lets an expired configuration refine a CONNECTED connection', () => {
      const entry = onlyEntry({
        mcpServers: [accountRow('CONNECTED')],
        mcpStatuses: [accountStatus('expired')],
      });
      expect(entry.state).toBe('needs-auth');
      expect(entry.pendingSignIns).toBe(1);
    });

    it('keeps a healthy CONNECTED connection installed', () => {
      const entry = onlyEntry({
        mcpServers: [accountRow('CONNECTED')],
        mcpStatuses: [accountStatus('connected')],
      });
      expect(entry.state).toBe('installed');
      expect(entry.pendingSignIns).toBeUndefined();
    });

    it.each(['PENDING', 'DISCONNECTED'] as const)(
      'offers the integration card for a %s connection with a not_connected status',
      (status) => {
        const curated = makeCuratedMcp({ oauthHints: { scopes: ['read'] } });
        const entry = onlyEntry({
          curatedMcpServers: [curated],
          mcpServers: [
            accountRow(status, {
              id: curated.key,
              curatedKey: curated.key,
              accountConnection: {
                ...connection,
                status,
                kind: 'CURATED',
                serverKey: curated.key,
              },
            }),
          ],
          mcpStatuses: [
            { ...accountStatus('not_connected'), serverId: curated.key },
          ],
        });
        expect(entry.state).toBe('available');
        expect(entry.pendingSignIns).toBeUndefined();
        expect(entry.integration?.connections).toEqual([
          expect.objectContaining({ binding: 'account', state: 'available' }),
        ]);
      },
    );
  });
  describe('pending sign-ins (CAN-4840)', () => {
    it('counts only the device configurations that need sign-in', () => {
      const entry = onlyEntry({
        mcpServers: [makeMcpIndexEntry()],
        mcpStatuses: [
          makeMcpStatus({
            connectionStatus: 'auth_required',
            configs: [
              { configId: 'a', authStatus: 'connected' },
              { configId: 'b', authStatus: 'not_connected' },
            ],
          }),
        ],
      });
      expect(entry.state).toBe('needs-auth');
      expect(entry.pendingSignIns).toBe(1);
    });

    it('omits the count when every configuration is signed in', () => {
      const entry = onlyEntry({
        mcpServers: [makeMcpIndexEntry()],
        mcpStatuses: [
          makeMcpStatus({
            configs: [
              { configId: 'a', authStatus: 'connected' },
              { configId: 'b', authStatus: 'connected' },
            ],
          }),
        ],
      });
      expect(entry.pendingSignIns).toBeUndefined();
    });

    it('reads only its own configuration on an account row', () => {
      const entry = onlyEntry({
        mcpServers: [makeMcpIndexEntry({ accountConnection: connection })],
        mcpStatuses: [
          makeMcpStatus({
            configs: [
              { configId: connection.configId, authStatus: 'expired' },
              { configId: 'sibling', authStatus: 'connected' },
            ],
          }),
        ],
      });
      expect(entry.state).toBe('needs-auth');
      expect(entry.pendingSignIns).toBe(1);
    });

    it('counts an account row that needs reauthorization without a status', () => {
      const entry = onlyEntry({
        mcpServers: [
          makeMcpIndexEntry({
            accountConnection: { ...connection, status: 'REAUTH_REQUIRED' },
          }),
        ],
      });
      expect(entry.pendingSignIns).toBe(1);
    });

    it('counts the connections on an integration card that need sign-in', () => {
      const curated = makeCuratedMcp();
      const entry = onlyEntry({
        curatedMcpServers: [curated],
        mcpServers: [
          makeMcpIndexEntry({ id: 's1', curatedKey: curated.key }),
          makeMcpIndexEntry({
            id: 's2',
            name: 'Second',
            curatedKey: curated.key,
          }),
        ],
        mcpStatuses: [
          makeMcpStatus({ serverId: 's1', connectionStatus: 'auth_required' }),
          makeMcpStatus({ serverId: 's2' }),
        ],
      });
      expect(entry.pendingSignIns).toBe(1);
    });

    it('never counts an auth error as a pending sign-in', () => {
      const device = onlyEntry({
        mcpServers: [makeMcpIndexEntry()],
        mcpStatuses: [
          makeMcpStatus({
            connectionStatus: 'auth_required',
            configs: [
              { configId: 'a', authStatus: 'error' },
              { configId: 'b', authStatus: 'connected' },
            ],
          }),
        ],
      });
      expect(device.state).toBe('needs-auth');
      expect(device.pendingSignIns).toBeUndefined();

      const account = onlyEntry({
        mcpServers: [makeMcpIndexEntry({ accountConnection: connection })],
        mcpStatuses: [
          makeMcpStatus({
            connectionStatus: 'auth_required',
            configs: [{ configId: connection.configId, authStatus: 'error' }],
          }),
        ],
      });
      expect(account.state).toBe('needs-auth');
      expect(account.pendingSignIns).toBeUndefined();
    });

    it('counts a card device server the way its own row counts it', () => {
      const curated = makeCuratedMcp();
      const card = (
        configs: {
          configId: string;
          authStatus: 'connected' | 'error' | 'expired' | 'not_connected';
        }[],
      ): UnifiedPluginEntry =>
        onlyEntry({
          curatedMcpServers: [curated],
          mcpServers: [makeMcpIndexEntry({ curatedKey: curated.key })],
          mcpStatuses: [
            makeMcpStatus({ connectionStatus: 'auth_required', configs }),
          ],
        });
      expect(
        card([
          { configId: 'a', authStatus: 'error' },
          { configId: 'b', authStatus: 'connected' },
        ]).pendingSignIns,
      ).toBeUndefined();
      expect(
        card([
          { configId: 'a', authStatus: 'not_connected' },
          { configId: 'b', authStatus: 'expired' },
        ]).pendingSignIns,
      ).toBe(2);
    });

    it('counts an integration card connection only when it waits for sign-in', () => {
      const curated = makeCuratedMcp();
      const entry = onlyEntry({
        curatedMcpServers: [curated],
        mcpServers: [
          makeMcpIndexEntry({
            accountConnection: connection,
            curatedKey: curated.key,
          }),
        ],
        mcpStatuses: [
          makeMcpStatus({
            connectionStatus: 'auth_required',
            configs: [{ configId: connection.configId, authStatus: 'error' }],
          }),
        ],
      });
      expect(entry.state).toBe('needs-auth');
      expect(entry.pendingSignIns).toBeUndefined();
    });
  });
});

describe('buildUnifiedPluginEntries — id formats', () => {
  it('uses the exact documented id format for every entry shape', () => {
    const inputs = emptyInputs({
      curatedPlugins: [makeCuratedPlugin({ key: 'a-plugin' })],
      marketplaces: [
        makeMarketplace({
          id: 'mkt-1',
          plugins: [
            makePluginInfo({ name: 'b-plugin', marketplaceId: 'mkt-1' }),
          ],
        }),
      ],
      curatedMcpServers: [makeCuratedMcp({ key: 'c-mcp' })],
      mcpServers: [makeMcpIndexEntry({ id: 'server-5' })],
      installedSkills: [makeSkill({ sourceId: 'source-1', name: 'd-skill' })],
    });

    const entries = buildUnifiedPluginEntries(inputs);
    const ids = entries.map((entry) => entry.id).sort();

    expect(ids).toEqual(
      [
        'curated:a-plugin',
        'mkt:mkt-1/b-plugin',
        'mcp-catalog:c-mcp',
        'mcp-local:server-5',
        'skill:source-1:d-skill',
      ].sort(),
    );
  });
});

describe('buildUnifiedPluginEntries — non-mutation', () => {
  it('never mutates its inputs', () => {
    const inputs = emptyInputs({
      curatedPlugins: [makeCuratedPlugin()],
      marketplaces: [makeMarketplace({ plugins: [makePluginInfo()] })],
      curatedMcpServers: [makeCuratedMcp()],
      mcpServers: [makeMcpIndexEntry()],
      mcpStatuses: [makeMcpStatus()],
      installedSkills: [makeSkill()],
    });
    const snapshot = structuredClone(inputs);

    buildUnifiedPluginEntries(inputs);

    expect(structuredClone(inputs)).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// Search / ranking rules
// ---------------------------------------------------------------------------

describe('searchUnifiedEntries — banding', () => {
  it('keeps source-style kebab names searchable after display normalization', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        marketplaces: [
          makeMarketplace({
            plugins: [makePluginInfo({ name: 'alpha-tool' })],
          }),
        ],
      }),
    );

    expect(
      searchUnifiedEntries(entries, 'alpha-tool', null).marketplace,
    ).toEqual([expect.objectContaining({ name: 'Alpha Tool' })]);
  });

  it('bands installed, curated plugins, curated apps, and marketplace entries separately', () => {
    const inputs = emptyInputs({
      curatedPlugins: [
        makeCuratedPlugin({ key: 'installed-curated', name: 'Zeta Tool' }),
      ],
      marketplaces: [
        makeMarketplace({
          id: CURATED_PLUGIN_MARKETPLACE_ID,
          curated: true,
          plugins: [
            makePluginInfo({
              name: 'installed-curated',
              marketplaceId: CURATED_PLUGIN_MARKETPLACE_ID,
              globalInstallStatus: {
                claude: { available: true, installed: true },
                checkedAt: '2026-08-01T00:00:00.000Z',
              },
            }),
          ],
        }),
        makeMarketplace({
          id: 'mkt-github-one',
          plugins: [
            makePluginInfo({
              name: 'browse-plugin',
              marketplaceId: 'mkt-github-one',
              description: 'Zeta community plugin',
            }),
          ],
        }),
      ],
    });
    // Add an available curated plugin and a curated app (needs-auth stays in installed band).
    inputs.curatedPlugins.push(
      makeCuratedPlugin({ key: 'available-curated', name: 'Zeta Available' }),
    );
    inputs.curatedMcpServers.push(
      makeCuratedMcp({ key: 'zeta-app', name: 'Zeta App' }),
    );
    inputs.curatedMcpServers.push(
      makeCuratedMcp({ key: 'zeta-needs-auth', name: 'Zeta Needs Auth' }),
    );
    inputs.mcpServers.push(
      makeMcpIndexEntry({ id: 'server-auth', curatedKey: 'zeta-needs-auth' }),
    );
    inputs.mcpStatuses.push(
      makeMcpStatus({
        serverId: 'server-auth',
        connectionStatus: 'auth_required',
      }),
    );

    const entries = buildUnifiedPluginEntries(inputs);
    const results = searchUnifiedEntries(entries, 'zeta', null);

    expect(results.installed.map((entry) => entry.id)).toEqual([
      'mcp-catalog:zeta-needs-auth',
      'curated:installed-curated',
    ]);
    expect(results.curatedPlugins.map((entry) => entry.id)).toEqual([
      'curated:available-curated',
    ]);
    expect(results.curatedApps.map((entry) => entry.id)).toEqual([
      'mcp-catalog:zeta-app',
    ]);
    expect(results.marketplace.map((entry) => entry.id)).toEqual([
      'mkt:mkt-github-one/browse-plugin',
    ]);
  });
});

describe('buildUnifiedPluginEntries — capability marketplace', () => {
  it.each([
    [{ name: 'dbt', displayName: 'dbt labs' }, 'dbt labs'],
    [{ name: 'crowdstrike-falcon-foundry' }, 'CrowdStrike Falcon Foundry'],
  ])(
    'resolves plugin display metadata verbatim: %s',
    (plugin, expected): void => {
      const entries = buildUnifiedPluginEntries(
        emptyInputs({
          marketplaces: [
            makeMarketplace({ plugins: [makePluginInfo(plugin)] }),
          ],
        }),
      );
      expect(entries.find((entry) => entry.kind === 'plugin')?.name).toBe(
        expected,
      );
    },
  );

  it('presents every capability kind with a title-cased display name', () => {
    const timestamp = '2026-08-01T00:00:00.000Z';
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        curatedPlugins: [
          makeCuratedPlugin({
            key: 'adobe-for-creativity',
            name: 'adobe-for-creativity',
          }),
        ],
        marketplaces: [
          makeMarketplace({
            plugins: [makePluginInfo({ name: 'crowdstrike-falcon-foundry' })],
          }),
        ],
        curatedMcpServers: [
          makeCuratedMcp({ key: 'ai-search', name: 'ai-search-assistant' }),
        ],
        mcpServers: [
          makeMcpIndexEntry({ id: 'local-api', name: 'local-api-bridge' }),
        ],
        installedSkills: [makeSkill({ name: 'design-review-helper' })],
        pipelines: [
          {
            id: 'code-review',
            name: 'code-review-pipeline',
            filename: 'code-review.yaml',
            description: 'Reviews changes',
            icon: '',
            createdAt: timestamp,
            updatedAt: timestamp,
            source: 'user',
            readonly: false,
          },
        ],
        localCollections: [
          {
            id: 'developer-kit',
            name: 'developer-tool-kit',
            description: 'Developer capabilities',
            updatedAt: timestamp,
            skillCount: 1,
            pluginCount: 1,
            mcpServerCount: 1,
          },
        ],
        sharedSkills: [
          {
            id: 'ui-review',
            name: 'ui-review-helper',
            description: 'Reviews interfaces',
            contentHash: 'ui-review-hash',
            shareScope: 'team',
            owner: {
              type: 'team',
              id: 'team-1',
              name: 'Design Team',
              organization: { id: 'org-1', name: 'Acme' },
            },
            createdBy: { id: 'user-1', name: 'Ada', email: 'ada@example.com' },
            createdAt: timestamp,
            updatedAt: timestamp,
            canUpdate: true,
            canDelete: true,
            publicShare: null,
          },
        ],
        sharedCollections: [
          {
            id: 'qa-automation',
            name: 'qa-automation-kit',
            description: 'Quality capabilities',
            contentHash: 'qa-automation-hash',
            itemCounts: { skills: 1, plugins: 1, customSkills: 0 },
            shareScope: 'team',
            owner: {
              type: 'team',
              id: 'team-1',
              name: 'Design Team',
              organization: { id: 'org-1', name: 'Acme' },
            },
            createdBy: { id: 'user-1', name: 'Ada', email: 'ada@example.com' },
            createdAt: timestamp,
            updatedAt: timestamp,
            canUpdate: true,
            canDelete: true,
          },
        ],
      }),
    );

    expect(
      Object.fromEntries(entries.map((entry) => [entry.id, entry.name])),
    ).toEqual({
      'curated:adobe-for-creativity': 'Adobe for Creativity',
      'mcp-catalog:ai-search': 'AI Search Assistant',
      'mcp-local:local-api': 'Local API Bridge',
      'skill:local:design-review-helper': 'Design Review Helper',
      'skill:shared:ui-review': 'UI Review Helper',
      'pipeline:user:code-review': 'Code Review Pipeline',
      'collection:local:developer-kit': 'Developer Tool Kit',
      'collection:shared:qa-automation': 'QA Automation Kit',
      'mkt:mkt-github-one/crowdstrike-falcon-foundry':
        'CrowdStrike Falcon Foundry',
    });
  });

  it('projects pipelines and collections with searchable type/source metadata', () => {
    const pipeline: PipelineInfo = {
      id: 'release',
      name: 'Release Flow',
      filename: 'release.yaml',
      description: 'Publishes the application',
      icon: '',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      source: 'user',
      readonly: false,
    };
    const collection: CollectionIndexEntry = {
      id: 'developer-kit',
      name: 'Developer Kit',
      description: 'Common developer capabilities',
      updatedAt: '2026-08-01T00:00:00.000Z',
      skillCount: 2,
      pluginCount: 1,
      mcpServerCount: 1,
    };
    const sharedSkill: SharedSkillSummary = {
      id: 'review-helper',
      name: 'Review Helper',
      description: 'Reviews product changes',
      contentHash: 'skill-hash',
      shareScope: 'team',
      owner: {
        type: 'team',
        id: 'team-1',
        name: 'Design Team',
        organization: { id: 'org-1', name: 'Acme' },
      },
      createdBy: { id: 'user-1', name: 'Ada', email: 'ada@example.com' },
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      canUpdate: true,
      canDelete: true,
      publicShare: null,
    };
    const sharedCollection: SharedCollectionSummary = {
      id: 'design-team-kit',
      name: 'Design Team Kit',
      description: 'Shared design capabilities',
      contentHash: 'collection-hash',
      itemCounts: { skills: 1, plugins: 2, customSkills: 1 },
      shareScope: 'team',
      owner: {
        type: 'team',
        id: 'team-1',
        name: 'Design Team',
        organization: { id: 'org-1', name: 'Acme' },
      },
      createdBy: { id: 'user-1', name: 'Ada', email: 'ada@example.com' },
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      canUpdate: true,
      canDelete: true,
    };

    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        pipelines: [pipeline],
        localCollections: [collection],
        sharedSkills: [sharedSkill],
        sharedCollections: [sharedCollection],
      }),
    );

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'pipeline:user:release',
          kind: 'pipeline',
          typeLabel: 'Workflow',
          sourceLabel: 'Local',
        }),
        expect.objectContaining({
          id: 'collection:local:developer-kit',
          kind: 'collection',
          typeLabel: 'Collection',
          sourceLabel: 'Local',
        }),
        expect.objectContaining({
          id: 'skill:shared:review-helper',
          sourceLabel: 'Shared',
          ownershipLabel: 'Design Team · Team',
        }),
        expect.objectContaining({
          id: 'collection:shared:design-team-kit',
          sourceLabel: 'Shared',
          ownershipLabel: 'Design Team · Team',
        }),
      ]),
    );
    expect(
      searchUnifiedEntries(entries, 'pipeline', null).pipelines.map(
        (entry) => entry.id,
      ),
    ).toEqual(['pipeline:user:release']);
    const teamResults = searchUnifiedEntries(entries, 'design team', null);
    expect(teamResults.skills.map((entry) => entry.id)).toEqual([
      'skill:shared:review-helper',
    ]);
    expect(teamResults.collections.map((entry) => entry.id)).toEqual([
      'collection:shared:design-team-kit',
    ]);
  });
});

describe('searchUnifiedEntries — scoring', () => {
  function marketplaceEntry(
    name: string,
    description: string,
    categories: string[],
  ): UnifiedPluginEntry {
    return {
      id: `mkt:mkt-1/${name}`,
      kind: 'plugin',
      origin: 'marketplace',
      name,
      description,
      categories,
      components: { skills: 0, mcpServers: 0, commands: 0, agents: 0 },
      providerSupport: { claude: true, codex: true },
      state: 'available',
      recommended: false,
      ref: {
        type: 'marketplace-plugin',
        marketplaceId: 'mkt-1',
        pluginName: name,
      },
    };
  }

  it('scores name-substring matches above description above category matches', () => {
    const nameMatch = marketplaceEntry('Acme Tools', 'unrelated', []);
    const descriptionMatch = marketplaceEntry(
      'Beta Tools',
      'Acme integration helper',
      [],
    );
    const categoryMatch = marketplaceEntry('Gamma Tools', 'unrelated', [
      'acme-vendor',
    ]);

    const results = searchUnifiedEntries(
      [categoryMatch, descriptionMatch, nameMatch],
      'acme',
      null,
    );

    expect(results.marketplace.map((entry) => entry.name)).toEqual([
      'Acme Tools',
      'Beta Tools',
      'Gamma Tools',
    ]);
  });

  it('breaks ties by name when scores are equal', () => {
    const zephyr = marketplaceEntry('Acme Zephyr', 'desc', []);
    const alpha = marketplaceEntry('Acme Alpha', 'desc', []);

    const results = searchUnifiedEntries([zephyr, alpha], 'acme', null);

    expect(results.marketplace.map((entry) => entry.name)).toEqual([
      'Acme Alpha',
      'Acme Zephyr',
    ]);
  });

  // The source label now names provider and owner (CAN-3653), so the catalog
  // must stay searchable on its own.
  it('finds a marketplace plugin by its catalog id', () => {
    const entry = {
      ...marketplaceEntry('Slack', 'desc', []),
      sourceLabel: 'Claude · slackapi',
    };

    const results = searchUnifiedEntries([entry], 'mkt-1', null);

    expect(results.marketplace.map((e) => e.id)).toEqual([entry.id]);
  });

  it('matches case-insensitively', () => {
    const entry = marketplaceEntry('Acme Tools', 'desc', []);

    const results = searchUnifiedEntries([entry], 'ACME', null);

    expect(results.marketplace.map((e) => e.name)).toEqual(['Acme Tools']);
  });

  it('excludes entries that do not match a non-empty query', () => {
    const entry = marketplaceEntry('Beta Tools', 'unrelated', []);

    const results = searchUnifiedEntries([entry], 'acme', null);

    expect(results.marketplace).toEqual([]);
  });
});

describe('searchUnifiedEntries — recommended boost', () => {
  it('sorts recommended entries first within curated bands, ahead of raw score', () => {
    const inputs = emptyInputs({
      curatedPlugins: [
        makeCuratedPlugin({
          key: 'high-score',
          name: 'Acme High Score',
          recommended: false,
        }),
        makeCuratedPlugin({
          key: 'recommended-low-score',
          name: 'Recommended Pick',
          shortDescription: 'Contains acme somewhere in the description',
          categories: ['other'],
          recommended: true,
        }),
      ],
    });

    const entries = buildUnifiedPluginEntries(inputs);
    const results = searchUnifiedEntries(entries, 'acme', null);

    expect(results.curatedPlugins.map((entry) => entry.id)).toEqual([
      'curated:recommended-low-score',
      'curated:high-score',
    ]);
  });
});

describe('searchUnifiedEntries — browse mode (empty query)', () => {
  it('returns all entries banded without filtering when query is empty', () => {
    const inputs = emptyInputs({
      curatedPlugins: [makeCuratedPlugin({ key: 'a' })],
      curatedMcpServers: [makeCuratedMcp({ key: 'b' })],
      installedSkills: [makeSkill({ sourceId: 'src', name: 'c' })],
      marketplaces: [
        makeMarketplace({
          plugins: [
            makePluginInfo({ name: 'd', marketplaceId: 'mkt-github-one' }),
          ],
        }),
      ],
    });
    const entries = buildUnifiedPluginEntries(inputs);

    const results = searchUnifiedEntries(entries, '', null);

    const total =
      results.installed.length +
      results.curatedPlugins.length +
      results.curatedApps.length +
      results.marketplace.length +
      results.skills.length +
      results.pipelines.length +
      results.collections.length;
    expect(total).toBe(entries.length);
  });
});

describe('searchUnifiedEntries — category filter', () => {
  it('filters by category before scoring, case-insensitively', () => {
    function entryWithCategory(
      name: string,
      categories: string[],
    ): UnifiedPluginEntry {
      return {
        id: `mkt:mkt-1/${name}`,
        kind: 'plugin',
        origin: 'marketplace',
        name,
        description: 'desc',
        categories,
        components: { skills: 0, mcpServers: 0, commands: 0, agents: 0 },
        providerSupport: { claude: true, codex: true },
        state: 'available',
        recommended: false,
        ref: {
          type: 'marketplace-plugin',
          marketplaceId: 'mkt-1',
          pluginName: name,
        },
      };
    }

    const finance = entryWithCategory('Finance Tool', ['Finance']);
    const productivity = entryWithCategory('Productivity Tool', [
      'productivity',
    ]);

    const results = searchUnifiedEntries(
      [finance, productivity],
      '',
      'finance',
    );

    expect(results.marketplace.map((entry) => entry.name)).toEqual([
      'Finance Tool',
    ]);
  });
});

describe('searchUnifiedEntries — non-mutation', () => {
  it('never mutates the entries array or its elements', () => {
    const inputs = emptyInputs({
      curatedPlugins: [
        makeCuratedPlugin({
          key: 'acme-alpha',
          name: 'Acme Alpha',
          categories: ['productivity'],
        }),
      ],
      marketplaces: [
        makeMarketplace({
          id: 'mkt-github-one',
          plugins: [
            makePluginInfo({
              name: 'acme-beta',
              marketplaceId: 'mkt-github-one',
              category: 'productivity',
            }),
          ],
        }),
      ],
    });
    const entries = buildUnifiedPluginEntries(inputs);
    // Non-empty query + category filter exercises both the filtering and the
    // sorting paths, not just an empty-query pass-through.
    const elementRefsBefore = [...entries];
    const snapshotBefore = structuredClone(entries);

    searchUnifiedEntries(entries, 'acme', 'productivity');

    expect(structuredClone(entries)).toEqual(snapshotBefore);
    expect(entries).toHaveLength(elementRefsBefore.length);
    entries.forEach((entry, index) => {
      expect(entry).toBe(elementRefsBefore[index]);
    });
  });
});

// ---------------------------------------------------------------------------
// collectEntryCategories
// ---------------------------------------------------------------------------

describe('collectEntryCategories', () => {
  it('returns the sorted union of categories across every entry', () => {
    const inputs = emptyInputs({
      curatedPlugins: [
        makeCuratedPlugin({ key: 'a', categories: ['Zebra', 'productivity'] }),
      ],
      curatedMcpServers: [
        makeCuratedMcp({ key: 'b', categories: ['analytics'] }),
      ],
    });
    const entries = buildUnifiedPluginEntries(inputs);

    expect(collectEntryCategories(entries)).toEqual([
      'analytics',
      'productivity',
      'Zebra',
    ]);
  });

  it('merges case-variant duplicates, keeping the first-seen casing', () => {
    const inputs = emptyInputs({
      curatedPlugins: [
        makeCuratedPlugin({
          key: 'a',
          categories: ['Productivity', 'Security'],
        }),
      ],
      curatedMcpServers: [
        makeCuratedMcp({ key: 'b', categories: ['productivity', 'security'] }),
      ],
    });
    const entries = buildUnifiedPluginEntries(inputs);

    expect(collectEntryCategories(entries)).toEqual([
      'Productivity',
      'Security',
    ]);
  });
});

describe('buildUnifiedPluginEntries — provider connectors', () => {
  const CONNECTORS = [
    { provider: 'claude' as const, connectors: [] },
    { provider: 'codex' as const, connectors: [] },
  ];

  it('advertises connectors even when neither provider has one linked', () => {
    // Both providers return empty until something is linked, and neither
    // publishes a way to ask "could I connect this?" without asking the
    // account — so an empty list would hide the feature entirely.
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        providerConnectors: CONNECTORS,
        curatedMcpServers: CONNECTOR_CATALOG,
      }),
    );
    // Catalog-advertised connectors fold into their integration cards
    // (REG-3033), so the advertisement is the card's connector binding.
    const names = entries
      .filter((entry) => entry.integration?.connector !== undefined)
      .map((entry) => entry.name);
    expect(names).toEqual(['Gmail', 'Google Drive', 'Google Calendar']);
  });

  it('uses neutral copy without an app name and branded copy when provided', () => {
    const providerConnectors = [
      {
        provider: 'claude' as const,
        connectors: [
          {
            name: 'Uncatalogued',
            displayName: 'Uncatalogued',
            connected: false,
            status: 'Available',
          },
        ],
      },
    ];
    const neutral = buildUnifiedPluginEntries(
      emptyInputs({ providerConnectors }),
    );
    const branded = buildUnifiedPluginEntries(
      emptyInputs({ providerConnectors, appName: 'Canopy' }),
    );

    expect(neutral[0]?.description).toBe(
      'Connect with your Claude or Codex account. The app never sees these credentials.',
    );
    expect(branded[0]?.description).toBe(
      'Connect with your Claude or Codex account. Canopy never sees these credentials.',
    );
  });

  it('installs a linked connector and leaves an unlinked one available', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        providerConnectors: [
          { provider: 'claude', connectors: [] },
          {
            provider: 'codex',
            connectors: [
              {
                displayName: 'Gmail',
                connected: true,
              },
            ],
          },
        ],
        curatedMcpServers: CONNECTOR_CATALOG,
      }),
    );
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    expect(byName.get('Gmail')?.state).toBe('installed');
    // Not needs-auth: that buckets into Installed, and a connector nobody
    // linked was never installed. Listing it there with a "Needs attention"
    // badge reports work the user never started.
    expect(byName.get('Google Drive')?.state).toBe('available');
  });

  it('shows one Gmail, not three', () => {
    // Gmail also exists as a curated catalog entry pointing at Google's Pre-GA
    // endpoint (which cannot authenticate) and as a connector wrapper in the
    // Codex marketplace (whose ON_INSTALL auth Canopy does not implement).
    // Three Gmails, two of them dead ends, is worse than one that works.
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        providerConnectors: CONNECTORS,
        curatedMcpServers: [
          {
            key: 'gmail-gmailmcp',
            name: 'Gmail',
            shortDescription: 'Google Pre-GA endpoint',
            url: 'https://gmailmcp.googleapis.com/mcp/v1',
            transport: 'http',
            categories: [],
            popular: false,
            sortOrder: 0,
            updatedAt: '2026-08-27T00:00:00.000Z',
            providerConnector: { providers: ['claude', 'codex'] },
          },
        ],
      }),
    );
    const gmails = entries.filter((entry) => entry.name === 'Gmail');
    expect(gmails).toHaveLength(1);
    // The curated entry is the card; the connector is its binding (REG-3033).
    expect(gmails[0]?.ref).toEqual({
      type: 'curated-mcp',
      key: 'gmail-gmailmcp',
    });
    expect(gmails[0]?.integration?.connector).toEqual({
      displayName: 'Gmail',
      connected: false,
    });
  });

  it('keeps the catalog logo and copy when it replaces an entry', () => {
    // Replacing the curated entry without carrying its mark left every
    // connector on the monogram fallback — three near-identical grey "G"s
    // where the Gmail, Drive and Calendar logos belong.
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        providerConnectors: CONNECTORS,
        curatedMcpServers: [
          {
            key: 'gmail-gmailmcp',
            name: 'Gmail',
            shortDescription: 'Read and manage Gmail',
            logoUrl: 'https://assets.example.test/gmail.png',
            url: 'https://gmailmcp.googleapis.com/mcp/v1',
            transport: 'http',
            categories: ['Communication'],
            popular: false,
            sortOrder: 0,
            updatedAt: '2026-08-27T00:00:00.000Z',
          },
        ],
      }),
    );
    const gmail = entries.find((entry) => entry.name === 'Gmail');
    expect(gmail?.logoUrl).toBe('https://assets.example.test/gmail.png');
    expect(gmail?.description).toBe('Read and manage Gmail');
    expect(gmail?.categories).toEqual(['Communication']);
  });

  it('still renders a connector the catalog does not describe', () => {
    // A provider can report a linked connector the catalog never described;
    // it must not lose its row for want of a logo.
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        providerConnectors: CONNECTORS,
        curatedMcpServers: CONNECTOR_CATALOG,
      }),
    );
    // Advertised by the served catalog with no catalog entry behind it, so
    // there is no remote logo — the bundled brand mark carries it instead.
    const gmail = entries.find((entry) => entry.name === 'Gmail');
    expect(gmail).toBeDefined();
    expect(gmail?.logoUrl).toBeUndefined();
  });

  it('collapses a duplicate whose name differs only in case', () => {
    // Codex plugin manifests carry no displayName, so their entries fall back
    // to a bare `name` — `gmail`, not `Gmail`. An exact comparison let every
    // one through, which is how two Slacks reached the marketplace band before
    // Slack stopped being a connector at all.
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        providerConnectors: CONNECTORS,
        curatedMcpServers: CONNECTOR_CATALOG,
        marketplaces: [
          makeMarketplace({
            id: 'openai-curated-remote',
            plugins: [
              makePluginInfo({
                name: 'gmail',
                marketplaceId: 'openai-curated-remote',
              }),
            ],
          }),
        ],
      }),
    );
    const gmails = entries.filter(
      (entry) => entry.name.toLowerCase() === 'gmail',
    );
    expect(gmails).toHaveLength(1);
    expect(gmails[0]?.ref.type).toBe('curated-mcp');
  });

  it('leaves unrelated catalog entries alone', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        providerConnectors: CONNECTORS,
        curatedMcpServers: [
          {
            key: 'linear',
            name: 'Linear',
            shortDescription: '',
            url: 'https://mcp.linear.app/mcp',
            transport: 'http',
            categories: [],
            popular: false,
            sortOrder: 0,
            updatedAt: '2026-08-27T00:00:00.000Z',
          },
        ],
      }),
    );
    expect(entries.some((entry) => entry.name === 'Linear')).toBe(true);
  });

  it('adds nothing before the provider reads resolve', () => {
    // Rendering the catalog against zero reads would flash every connector as
    // unlinked before the answer is known.
    const entries = buildUnifiedPluginEntries(emptyInputs());
    expect(
      entries.filter((entry) => entry.ref.type === 'provider-connector'),
    ).toEqual([]);
  });
});

describe('provider connector brand marks', () => {
  it('carries the catalog key so the bundled mark resolves', () => {
    // The bundled brand-mark table is keyed by catalog key. Without it every
    // connector falls back to a monogram, which for the Google three renders
    // as near-identical grey letters in one row.
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        providerConnectors: [
          { provider: 'claude', connectors: [] },
          { provider: 'codex', connectors: [] },
        ],
        curatedMcpServers: CONNECTOR_CATALOG,
      }),
    );
    // The card keeps the catalog key on its ref, so `curatedLogoKey` resolves
    // the bundled mark for the folded connector too (REG-3033).
    const keyed = new Map(
      entries
        .filter((entry) => entry.integration?.connector !== undefined)
        .map((entry) => [
          entry.name,
          entry.ref.type === 'curated-mcp' ? entry.ref.key : undefined,
        ]),
    );
    expect(keyed.get('Gmail')).toBe('gmail-gmailmcp');
    expect(keyed.get('Google Drive')).toBe('google-drive-drivemcp');
    expect(keyed.get('Google Calendar')).toBe('google-calendar-calendarmcp');
  });
});

describe('provider connectors never hide an installed server', () => {
  it('keeps a curated server the user actually installed', () => {
    // `notOwned` exempted only `local-mcp` refs, but an installed server bound
    // to a catalog entry carries a `curated-mcp` ref — so advertising that key
    // as a connector made the user's working, authenticated server vanish from
    // both the grid and the installed list, replaced by a row reading "not set
    // up". Remotely triggerable: a hub checkbox hides local state.
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        providerConnectors: [
          { provider: 'claude' as const, connectors: [] },
          { provider: 'codex' as const, connectors: [] },
        ],
        curatedMcpServers: CONNECTOR_CATALOG,
        mcpServers: [
          {
            id: 'srv-1',
            name: 'Gmail',
            type: 'http',
            curatedKey: 'gmail-gmailmcp',
            description: 'Email access for Gmail.',
            configs: [{ id: 'cfg-1', name: 'Default', enabled: true }],
            updatedAt: '2026-08-28T00:00:00.000Z',
          },
        ],
      }),
    );
    const gmails = entries.filter((entry) => entry.name === 'Gmail');
    expect(gmails.map((entry) => entry.ref.type)).toContain('curated-mcp');
  });

  it('keeps an installed marketplace plugin that shares a connector name', () => {
    // The exemption first covered only curated MCP servers, but `notOwned`
    // guards three lists and the other two fell through to the case-folded
    // name match. Codex's marketplace publishes provider-connector wrappers
    // for these very capabilities, so the collision is the expected shape, not
    // a hypothetical — and it is the same remotely-triggerable disappearance.
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        providerConnectors: [
          { provider: 'claude' as const, connectors: [] },
          { provider: 'codex' as const, connectors: [] },
        ],
        curatedMcpServers: CONNECTOR_CATALOG,
        marketplaces: [
          makeMarketplace({
            id: 'openai-curated-remote',
            plugins: [
              makePluginInfo({
                name: 'gmail',
                marketplaceId: 'openai-curated-remote',
                globalInstallStatus: {
                  claude: { available: true, installed: true },
                  checkedAt: '2026-08-28T00:00:00.000Z',
                },
              }),
            ],
          }),
        ],
      }),
    );
    const installed = entries.filter(
      (entry) =>
        entry.name.toLowerCase() === 'gmail' && entry.state !== 'available',
    );
    expect(installed.length).toBeGreaterThan(0);
  });
});

describe('connector rows do not wait on the provider reads', () => {
  it('advertises from the catalog before any provider has answered', () => {
    // The catalog decides WHICH connectors exist and is available on first
    // paint; the provider read only decides whether each is LINKED and takes
    // seconds. Gating both on the slow input meant the first paint had no
    // connector rows, so nothing was suppressed and the provider's own
    // marketplace plugins rendered — then swapped when the reads landed.
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        providerConnectors: [],
        curatedMcpServers: CONNECTOR_CATALOG,
      }),
    );
    const names = entries
      .filter((entry) => entry.integration?.connector !== undefined)
      .map((entry) => entry.name);
    expect(names).toEqual(['Gmail', 'Google Drive', 'Google Calendar']);
  });

  it('suppresses the provider marketplace duplicate on that same first paint', () => {
    // The swap the user sees: Gmail from openai-curated shows, then vanishes.
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        providerConnectors: [],
        curatedMcpServers: CONNECTOR_CATALOG,
        marketplaces: [
          makeMarketplace({
            id: 'openai-curated-remote',
            plugins: [
              makePluginInfo({
                name: 'gmail',
                marketplaceId: 'openai-curated-remote',
              }),
            ],
          }),
        ],
      }),
    );
    const gmails = entries.filter(
      (entry) => entry.name.toLowerCase() === 'gmail',
    );
    expect(gmails).toHaveLength(1);
    expect(gmails[0]?.ref.type).toBe('curated-mcp');
  });
});

describe('one row per capability across marketplaces', () => {
  it('collapses the same plugin published by two marketplaces', () => {
    // Codex subscribes to Anthropic's marketplace as well as OpenAI's, so
    // `claude-plugins-official/slack` is present twice over — plus OpenAI's own
    // wrapper. Three rows, identical name, identical subtitle (the subtitle is
    // mapped by name), and no way to tell them apart. They are not duplicates
    // of each other, but to a user asking "can I use Slack" they are one thing.
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        marketplaces: [
          makeMarketplace({
            id: 'openai-curated-remote',
            plugins: [
              makePluginInfo({
                name: 'slack',
                marketplaceId: 'openai-curated-remote',
              }),
            ],
          }),
          makeMarketplace({
            id: 'claude-plugins-official',
            plugins: [
              makePluginInfo({
                name: 'slack',
                marketplaceId: 'claude-plugins-official',
              }),
            ],
          }),
        ],
      }),
    );
    const slacks = entries.filter(
      (entry) => entry.name.toLowerCase() === 'slack',
    );
    expect(slacks).toHaveLength(1);
  });

  it('keeps an installed one over an uninstalled duplicate', () => {
    // Collapsing must never hide the copy the user actually has.
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        marketplaces: [
          makeMarketplace({
            id: 'openai-curated-remote',
            plugins: [
              makePluginInfo({
                name: 'slack',
                marketplaceId: 'openai-curated-remote',
              }),
            ],
          }),
          makeMarketplace({
            id: 'claude-plugins-official',
            plugins: [
              makePluginInfo({
                name: 'slack',
                marketplaceId: 'claude-plugins-official',
                globalInstallStatus: {
                  claude: { available: true, installed: true },
                  checkedAt: '2026-08-31T00:00:00.000Z',
                },
              }),
            ],
          }),
        ],
      }),
    );
    const slacks = entries.filter(
      (entry) => entry.name.toLowerCase() === 'slack',
    );
    expect(slacks).toHaveLength(1);
    expect(slacks[0]?.state).not.toBe('available');
    expect(slacks[0]?.ref).toMatchObject({
      marketplaceId: 'claude-plugins-official',
    });
  });

  it('keeps both when the user installed both', () => {
    // Collapsing an installed copy contradicts the invariant `notOwned` spends
    // fifteen lines defending: nothing the user already has is ever hidden.
    // Two installs are two things they can uninstall, and dropping one leaves
    // no way to reach it from this list at all.
    const installed = {
      claude: { available: true, installed: true },
      checkedAt: '2026-08-31T00:00:00.000Z',
    };
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        marketplaces: [
          makeMarketplace({
            id: 'openai-curated-remote',
            plugins: [
              makePluginInfo({
                name: 'slack',
                marketplaceId: 'openai-curated-remote',
                globalInstallStatus: installed,
              }),
            ],
          }),
          makeMarketplace({
            id: 'claude-plugins-official',
            plugins: [
              makePluginInfo({
                name: 'slack',
                marketplaceId: 'claude-plugins-official',
                globalInstallStatus: installed,
              }),
            ],
          }),
        ],
      }),
    );
    const slacks = entries.filter(
      (entry) => entry.name.toLowerCase() === 'slack',
    );
    expect(slacks).toHaveLength(2);
  });

  it('keeps both when neither copy covers the other', () => {
    // A Claude-only copy and a Codex-only copy both "reach one provider", so a
    // count-based tie-break let marketplace order decide — and dropping either
    // removes that capability entirely for users of the other provider. The
    // doc claimed the opposite guarantee.
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        marketplaces: [
          makeMarketplace({
            id: 'openai-curated-remote',
            plugins: [
              makePluginInfo({
                name: 'slack',
                marketplaceId: 'openai-curated-remote',
                providerSupport: { claude: 'none', codex: 'native' },
              }),
            ],
          }),
          makeMarketplace({
            id: 'claude-plugins-official',
            plugins: [
              makePluginInfo({
                name: 'slack',
                marketplaceId: 'claude-plugins-official',
                providerSupport: { claude: 'native', codex: 'none' },
              }),
            ],
          }),
        ],
      }),
    );
    const slacks = entries.filter(
      (entry) => entry.name.toLowerCase() === 'slack',
    );
    expect(slacks).toHaveLength(2);
  });

  it('collapses when one copy covers the other', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        marketplaces: [
          makeMarketplace({
            id: 'openai-curated-remote',
            plugins: [
              makePluginInfo({
                name: 'slack',
                marketplaceId: 'openai-curated-remote',
                providerSupport: { claude: 'none', codex: 'native' },
              }),
            ],
          }),
          makeMarketplace({
            id: 'claude-plugins-official',
            plugins: [
              makePluginInfo({
                name: 'slack',
                marketplaceId: 'claude-plugins-official',
                providerSupport: { claude: 'native', codex: 'native' },
              }),
            ],
          }),
        ],
      }),
    );
    const slacks = entries.filter(
      (entry) => entry.name.toLowerCase() === 'slack',
    );
    expect(slacks).toHaveLength(1);
    expect(slacks[0]?.providerSupport).toEqual({ claude: true, codex: true });
  });

  it('keeps an uninstalled copy the installed one does not cover', () => {
    // The installed branch returned every installed copy and dropped the rest
    // with no coverage check — the exact hazard the uninstalled branch spends a
    // paragraph guarding. Installing the Claude-only copy silently removed the
    // Codex-only one, so Codex users lost the capability from the list.
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        marketplaces: [
          makeMarketplace({
            id: 'claude-plugins-official',
            plugins: [
              makePluginInfo({
                name: 'slack',
                marketplaceId: 'claude-plugins-official',
                providerSupport: { claude: 'native', codex: 'none' },
                globalInstallStatus: {
                  claude: { available: true, installed: true },
                  checkedAt: '2026-08-31T00:00:00.000Z',
                },
              }),
            ],
          }),
          makeMarketplace({
            id: 'openai-curated-remote',
            plugins: [
              makePluginInfo({
                name: 'slack',
                marketplaceId: 'openai-curated-remote',
                providerSupport: { claude: 'none', codex: 'native' },
              }),
            ],
          }),
        ],
      }),
    );
    const slacks = entries.filter(
      (entry) => entry.name.toLowerCase() === 'slack',
    );
    expect(slacks).toHaveLength(2);
  });

  it('does not collapse genuinely different capabilities', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        marketplaces: [
          makeMarketplace({
            id: 'openai-curated-remote',
            plugins: [
              makePluginInfo({
                name: 'slack',
                marketplaceId: 'openai-curated-remote',
              }),
              makePluginInfo({
                name: 'notion',
                marketplaceId: 'openai-curated-remote',
              }),
            ],
          }),
        ],
      }),
    );
    const names = entries
      .filter((entry) => entry.ref.type === 'marketplace-plugin')
      .map((entry) => entry.name.toLowerCase())
      .sort();
    expect(names).toEqual(['notion', 'slack']);
  });
});

// ---------------------------------------------------------------------------
// Automations: local copies, team shares, and the curated catalog.
// ---------------------------------------------------------------------------

const AUTOMATION_HASH = 'a'.repeat(64);
const AUTOMATION_HASH_CHANGED = 'b'.repeat(64);

function makeLocalAutomation(
  overrides: Partial<UnifiedLocalAutomationInput> = {},
): UnifiedLocalAutomationInput {
  return {
    id: 'activity-1',
    name: 'Morning standup',
    description: 'Scheduled · App Advisor prompt: Summarize yesterday',
    ...overrides,
  };
}

function makeSharedAutomation(
  overrides: Partial<SharedAutomationSummary> = {},
): SharedAutomationSummary {
  return {
    id: 'share-1',
    name: 'Triage inbox',
    description: 'Sorts **new** issues every morning.',
    triggerKind: 'cron',
    actionType: 'app_advisor_prompt',
    contentHash: AUTOMATION_HASH,
    shareScope: 'team',
    owner: {
      type: 'team',
      id: 'team-1',
      name: 'Platform',
      organization: { id: 'org-1', name: 'Acme' },
    },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    createdBy: { id: 'user-1', name: 'Ada', email: null },
    canUpdate: false,
    canDelete: false,
    ...overrides,
  };
}

function makeCuratedAutomation(
  overrides: Partial<CuratedAutomationSummary> = {},
): CuratedAutomationSummary {
  return {
    key: 'daily-review',
    name: 'Daily review',
    shortDescription: 'Reviews open pull requests each weekday.',
    icon: '',
    triggerKind: 'cron',
    cronExpression: '0 9 * * 1-5',
    actionType: 'worktree_prompt',
    pipelineSource: null,
    referencedCuratedPipelineKey: null,
    pluginCount: 0,
    contentHash: AUTOMATION_HASH,
    contentSizeBytes: 512,
    categories: ['Engineering'],
    popular: true,
    sortOrder: 3,
    revision: 1,
    authorName: 'Canopy',
    authorUrl: null,
    docsUrl: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function automationEntries(
  inputs: Pick<
    UnifiedEntryInputs,
    'localAutomations' | 'sharedAutomations' | 'curatedAutomations'
  >,
): UnifiedPluginEntry[] {
  return buildUnifiedPluginEntries(emptyInputs(inputs)).filter(
    (entry) => entry.kind === 'automation',
  );
}

describe('buildUnifiedPluginEntries — automations', () => {
  it('projects a local, a shared and a curated automation with their ids and refs', () => {
    const entries = automationEntries({
      localAutomations: [makeLocalAutomation()],
      sharedAutomations: [makeSharedAutomation()],
      curatedAutomations: [makeCuratedAutomation()],
    });

    expect(entries).toEqual([
      expect.objectContaining({
        id: 'automation:local:activity-1',
        kind: 'automation',
        origin: 'installed-standalone',
        state: 'installed',
        sourceLabel: 'Local',
        availabilityLabel: 'Installed',
        description: 'Scheduled · App Advisor prompt: Summarize yesterday',
        ref: { type: 'automation', activityId: 'activity-1' },
      }),
      expect.objectContaining({
        id: 'automation:shared:share-1',
        kind: 'automation',
        origin: 'shared',
        state: 'available',
        sourceLabel: 'Shared',
        // Share descriptions are Markdown; a card subtitle is plain text.
        description: 'Sorts new issues every morning.',
        authorName: 'Platform',
        ownershipLabel: 'Platform · Team',
        ref: { type: 'shared-automation', automationId: 'share-1' },
      }),
      expect.objectContaining({
        id: 'automation:curated:daily-review',
        kind: 'automation',
        origin: 'curated',
        state: 'available',
        sourceLabel: 'Curated',
        description: 'Reviews open pull requests each weekday.',
        categories: ['Engineering'],
        recommended: true,
        catalogSortOrder: 3,
        ref: { type: 'curated-automation', key: 'daily-review' },
      }),
    ]);
    expect(entries.every((entry) => entry.updateAvailable === undefined)).toBe(
      true,
    );
  });

  it('lists only the local copy of a share the user installed', () => {
    const entries = automationEntries({
      localAutomations: [
        makeLocalAutomation({
          installedFrom: { remoteId: 'share-1', contentHash: AUTOMATION_HASH },
        }),
      ],
      sharedAutomations: [makeSharedAutomation()],
    });

    expect(entries.map((entry) => entry.id)).toEqual([
      'automation:local:activity-1',
    ]);
    expect(entries[0]?.updateAvailable).toBeUndefined();
  });

  it('lists only the local copy of a share the user published', () => {
    const entries = automationEntries({
      localAutomations: [makeLocalAutomation({ sharedRemoteId: 'share-1' })],
      sharedAutomations: [makeSharedAutomation()],
    });

    expect(entries.map((entry) => entry.id)).toEqual([
      'automation:local:activity-1',
    ]);
  });

  it('lists an owned share beside its local source in the "Shared by me" facet', () => {
    const local = [
      makeLocalAutomation({ sharedRemoteId: 'share-1' }),
      makeLocalAutomation({
        id: 'activity-2',
        installedFrom: {
          remoteId: 'daily-review',
          contentHash: AUTOMATION_HASH,
          sourceKind: 'curated',
        },
      }),
    ];
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        localAutomations: local,
        sharedAutomations: [makeSharedAutomation()],
        curatedAutomations: [makeCuratedAutomation()],
        skipLocalAutomationDedupe: true,
      }),
    ).filter((entry) => entry.kind === 'automation');

    // Shares skip the local-copy rule; curated rows keep it.
    expect(entries.map((entry) => entry.id)).toEqual([
      'automation:local:activity-1',
      'automation:local:activity-2',
      'automation:shared:share-1',
    ]);
  });

  it('keeps one row per share when the facet is off', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        localAutomations: [makeLocalAutomation({ sharedRemoteId: 'share-1' })],
        sharedAutomations: [makeSharedAutomation()],
        skipLocalAutomationDedupe: false,
      }),
    ).filter((entry) => entry.kind === 'automation');

    expect(entries.map((entry) => entry.id)).toEqual([
      'automation:local:activity-1',
    ]);
  });

  it('builds a stand-in entry for a shared automation opened by id', () => {
    expect(pendingSharedAutomationEntry('automation:shared:share-9')).toEqual(
      expect.objectContaining({
        id: 'automation:shared:share-9',
        kind: 'automation',
        origin: 'shared',
        ref: { type: 'shared-automation', automationId: 'share-9' },
      }),
    );
    expect(pendingSharedAutomationEntry('automation:shared:')).toBeNull();
    expect(pendingSharedAutomationEntry('automation:local:a')).toBeNull();
    expect(pendingSharedAutomationEntry('skill:custom:app:x')).toBeNull();
  });

  it('keeps the shared row when the only matching copy came from a public link', () => {
    // A public install records a public-share id, a different namespace from
    // the team-share id, so the collision must not hide the team share.
    const entries = automationEntries({
      localAutomations: [
        makeLocalAutomation({
          installedFrom: {
            remoteId: 'share-1',
            contentHash: AUTOMATION_HASH_CHANGED,
            sourceKind: 'public',
          },
        }),
      ],
      sharedAutomations: [makeSharedAutomation()],
    });

    expect(entries.map((entry) => entry.id)).toEqual([
      'automation:local:activity-1',
      'automation:shared:share-1',
    ]);
    expect(entries[0]?.updateAvailable).toBeUndefined();
  });

  it('keeps a curated row whose key only matches a team-share install', () => {
    const entries = automationEntries({
      localAutomations: [
        makeLocalAutomation({
          installedFrom: {
            remoteId: 'daily-review',
            contentHash: AUTOMATION_HASH,
            sourceKind: 'shared',
          },
        }),
      ],
      curatedAutomations: [makeCuratedAutomation()],
    });

    expect(entries.map((entry) => entry.id)).toEqual([
      'automation:local:activity-1',
      'automation:curated:daily-review',
    ]);
  });

  it('lists only the local copy of a curated automation the user installed', () => {
    const entries = automationEntries({
      localAutomations: [
        makeLocalAutomation({
          installedFrom: {
            remoteId: 'daily-review',
            contentHash: AUTOMATION_HASH,
            sourceKind: 'curated',
          },
        }),
      ],
      curatedAutomations: [makeCuratedAutomation()],
    });

    expect(entries.map((entry) => entry.id)).toEqual([
      'automation:local:activity-1',
    ]);
    expect(entries[0]?.updateAvailable).toBeUndefined();
  });

  it.each<[string, UnifiedLocalAutomationInput['installedFrom']]>([
    ['a team share', { remoteId: 'share-1', contentHash: AUTOMATION_HASH }],
    [
      'the curated catalog',
      {
        remoteId: 'daily-review',
        contentHash: AUTOMATION_HASH,
        sourceKind: 'curated',
      },
    ],
  ])(
    'marks the local copy when its source in %s has changed',
    (_label, installedFrom) => {
      const entries = automationEntries({
        localAutomations: [makeLocalAutomation({ installedFrom })],
        sharedAutomations: [
          makeSharedAutomation({ contentHash: AUTOMATION_HASH_CHANGED }),
        ],
        curatedAutomations: [
          makeCuratedAutomation({ contentHash: AUTOMATION_HASH_CHANGED }),
        ],
      });
      const local = entries.find(
        (entry) => entry.id === 'automation:local:activity-1',
      );

      expect(local).toMatchObject({
        state: 'installed',
        updateAvailable: true,
        availabilityLabel: 'Update available',
      });
    },
  );

  it('does not claim an update when the source is not loaded', () => {
    const [local] = automationEntries({
      localAutomations: [
        makeLocalAutomation({
          installedFrom: {
            remoteId: 'share-gone',
            contentHash: AUTOMATION_HASH,
          },
        }),
      ],
    });

    expect(local?.updateAvailable).toBeUndefined();
  });

  it('uses an independently resolved source hash when the browse page is not loaded', () => {
    const [local] = automationEntries({
      localAutomations: [
        makeLocalAutomation({
          installedFrom: {
            remoteId: 'share-after-page-one',
            contentHash: AUTOMATION_HASH,
          },
          sourceContentHash: AUTOMATION_HASH_CHANGED,
        }),
      ],
    });

    expect(local).toMatchObject({
      updateAvailable: true,
      availabilityLabel: 'Update available',
    });
  });

  it('bands automations after pipelines and before collections', () => {
    const results = searchUnifiedEntries(
      buildUnifiedPluginEntries(
        emptyInputs({
          localAutomations: [makeLocalAutomation()],
          sharedAutomations: [makeSharedAutomation()],
          curatedAutomations: [makeCuratedAutomation()],
        }),
      ),
      '',
      null,
    );

    // Installed and available automations share one band, as pipelines do.
    expect(results.automations.map((entry) => entry.id).sort()).toEqual([
      'automation:curated:daily-review',
      'automation:local:activity-1',
      'automation:shared:share-1',
    ]);
    expect(results.installed).toEqual([]);
    expect(Object.keys(results)).toEqual([
      'installed',
      'curatedPlugins',
      'curatedApps',
      'marketplace',
      'sharedPlugins',
      'skills',
      'pipelines',
      'automations',
      'collections',
      'agents',
      'projectTemplates',
    ]);
  });

  it('finds an automation by its type label', () => {
    const results = searchUnifiedEntries(
      buildUnifiedPluginEntries(
        emptyInputs({ localAutomations: [makeLocalAutomation()] }),
      ),
      'automation',
      null,
    );

    expect(results.automations.map((entry) => entry.id)).toEqual([
      'automation:local:activity-1',
    ]);
  });
});

// ---------------------------------------------------------------------------
// REG-3033: one card per curated integration key.
// ---------------------------------------------------------------------------

describe('buildUnifiedPluginEntries — one card per integration (REG-3033)', () => {
  const LINEAR_MCP = makeCuratedMcp({
    key: 'linear',
    name: 'Linear',
    shortDescription: 'Issues and projects',
    categories: ['productivity'],
  });
  const LINEAR_PLUGIN = makeCuratedPlugin({
    key: 'linear',
    name: 'Linear',
    mcpServers: ['linear'],
    skills: [
      { key: 'triage', name: 'Triage', contentHash: 'h', files: [] },
      { key: 'plan', name: 'Plan', contentHash: 'h', files: [] },
    ],
  });
  const LINEAR_CONNECTOR_MCP = makeCuratedMcp({
    key: 'linear',
    name: 'Linear',
    oauthHints: { scopes: ['read'] },
    providerConnector: { providers: ['claude', 'codex'] },
  });
  const linearRow = (installed: boolean): UnifiedMarketplacePluginInput => ({
    name: 'linear',
    marketplaceId: CURATED_PLUGIN_MARKETPLACE_ID,
    providerSupport: { claude: 'native', codex: 'native' },
    installed: true,
    globalInstallStatus: {
      claude: { available: true, installed },
      codex: { available: true, installed: false },
      checkedAt: '2026-10-01T00:00:00.000Z',
    },
  });
  const curatedMarketplace = (installed: boolean): UnifiedMarketplaceInput => ({
    id: CURATED_PLUGIN_MARKETPLACE_ID,
    name: 'Curated',
    curated: true,
    plugins: [linearRow(installed)],
  });
  const linearAccount: AccountMcpConnection = {
    id: 'conn-linear-default',
    serverKey: 'linear',
    configId: 'default',
    displayName: 'Linear',
    status: 'CONNECTED',
    routeId: 'route',
    enabledTools: null,
    kind: 'CURATED',
  };

  it('folds a curated plugin, the curated MCP entry, and a provider connector sharing a key into one card', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        // The desktop opts into the fold; its card detail installs the plugin.
        foldSingleKeyPlugins: true,
        curatedPlugins: [LINEAR_PLUGIN],
        marketplaces: [curatedMarketplace(false)],
        curatedMcpServers: [LINEAR_CONNECTOR_MCP],
        providerConnectors: [
          { provider: 'claude', connectors: [] },
          { provider: 'codex', connectors: [] },
        ],
      }),
    );
    const linear = entries.filter((entry) => entry.name === 'Linear');
    expect(linear).toHaveLength(1);
    const card = linear[0];
    expect(card.id).toBe('mcp-catalog:linear');
    expect(card.ref).toEqual({ type: 'curated-mcp', key: 'linear' });
    expect(card.kind).toBe('app');
    expect(card.state).toBe('available');
    expect(card.components).toEqual({
      skills: 2,
      mcpServers: 1,
      commands: 0,
      agents: 0,
    });
    expect(card.integration).toEqual({
      curatedKey: 'linear',
      plugin: { key: 'linear', name: 'Linear', skills: 2, installed: false },
      connector: { displayName: 'Linear', connected: false },
      connections: [],
    });
    // Search returns the same single hit.
    const results = searchUnifiedEntries(entries, 'linear', null);
    const hits = [
      ...results.installed,
      ...results.curatedPlugins,
      ...results.curatedApps,
      ...results.marketplace,
    ];
    expect(hits.map((entry) => entry.id)).toEqual(['mcp-catalog:linear']);
  });

  it('reflects the connection and the folded plugin install on the card', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        // The desktop opts into the fold; its card detail installs the plugin.
        foldSingleKeyPlugins: true,
        curatedPlugins: [LINEAR_PLUGIN],
        marketplaces: [curatedMarketplace(true)],
        curatedMcpServers: [LINEAR_MCP],
        mcpServers: [
          makeMcpIndexEntry({
            id: 'linear',
            name: 'Linear',
            scope: 'account',
            curatedKey: 'linear',
            accountConnectionId: linearAccount.id,
            accountConnection: linearAccount,
            configs: [{ id: 'default', name: 'Default', enabled: true }],
          }),
          makeMcpIndexEntry({
            id: 'linear',
            name: 'Linear',
            scope: 'account',
            curatedKey: 'linear',
            accountConnectionId: 'conn-linear-work',
            accountConnection: {
              ...linearAccount,
              id: 'conn-linear-work',
              configId: 'work',
              status: 'REAUTH_REQUIRED',
            },
            configs: [{ id: 'work', name: 'Work', enabled: true }],
          }),
        ],
      }),
    );
    expect(entries.map((entry) => entry.id)).toEqual(['mcp-catalog:linear']);
    const card = entries[0];
    expect(card.state).toBe('installed');
    expect(card.surface).toBe('cloud');
    expect(card.integration?.plugin?.installed).toBe(true);
    expect(card.integration?.connections).toEqual([
      {
        serverId: 'linear',
        configId: 'default',
        name: 'Default',
        binding: 'account',
        state: 'installed',
        accountConnectionId: 'conn-linear-default',
      },
      {
        serverId: 'linear',
        configId: 'work',
        name: 'Work',
        binding: 'account',
        state: 'needs-auth',
        accountConnectionId: 'conn-linear-work',
      },
    ]);
  });

  it('asks for a connection when the folded plugin is installed but nothing is connected', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        // The desktop opts into the fold; its card detail installs the plugin.
        foldSingleKeyPlugins: true,
        curatedPlugins: [LINEAR_PLUGIN],
        marketplaces: [curatedMarketplace(true)],
        curatedMcpServers: [LINEAR_MCP],
      }),
    );
    expect(entries.map((entry) => entry.id)).toEqual(['mcp-catalog:linear']);
    expect(entries[0].state).toBe('needs-auth');
  });

  it('lists a device server as a device binding on the card', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        curatedMcpServers: [LINEAR_MCP],
        mcpServers: [
          makeMcpIndexEntry({
            id: 'srv-linear',
            name: 'Linear',
            curatedKey: 'linear',
            configs: [{ id: 'cfg', name: 'Default', enabled: true }],
          }),
        ],
        mcpStatuses: [
          makeMcpStatus({
            serverId: 'srv-linear',
            connectionStatus: 'connected',
          }),
        ],
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].integration?.connections).toEqual([
      {
        serverId: 'srv-linear',
        configId: 'cfg',
        name: 'Linear',
        binding: 'device',
        state: 'installed',
      },
    ]);
    expect(entries[0].state).toBe('installed');
  });

  it('keeps a plugin that needs several integrations as a plugin card with one chip per key', () => {
    const jira = makeCuratedMcp({ key: 'jira', name: 'Jira' });
    const plugin = makeCuratedPlugin({
      key: 'release-notes',
      name: 'Release Notes',
      mcpServers: ['linear', 'jira'],
    });
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        curatedPlugins: [plugin],
        curatedMcpServers: [LINEAR_MCP, jira],
      }),
    );
    expect(entries.map((entry) => entry.id).sort()).toEqual([
      'curated:release-notes',
      'mcp-catalog:jira',
      'mcp-catalog:linear',
    ]);
    const card = entries.find((entry) => entry.id === 'curated:release-notes');
    expect(card?.kind).toBe('plugin');
    expect(card?.requirements).toEqual([
      { key: 'linear', name: 'Linear', entryId: 'mcp-catalog:linear' },
      { key: 'jira', name: 'Jira', entryId: 'mcp-catalog:jira' },
    ]);
    expect(
      entries.find((entry) => entry.id === 'mcp-catalog:linear')?.integration
        ?.plugin,
    ).toBeUndefined();
  });

  it('keeps a plugin whose single key is not in the catalog as a plugin card', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        curatedPlugins: [LINEAR_PLUGIN],
        marketplaces: [curatedMarketplace(false)],
      }),
    );
    expect(entries.map((entry) => entry.id)).toEqual(['curated:linear']);
    expect(entries[0].requirements).toBeUndefined();
  });

  it('never suppresses anything the user already has', () => {
    // A connector folds into the card, so the card is what carries the
    // user's installed server rather than being hidden behind the connector.
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        curatedMcpServers: [LINEAR_CONNECTOR_MCP],
        providerConnectors: [
          { provider: 'claude', connectors: [] },
          { provider: 'codex', connectors: [] },
        ],
        mcpServers: [
          makeMcpIndexEntry({
            id: 'srv-linear',
            name: 'Linear',
            curatedKey: 'linear',
            configs: [{ id: 'cfg', name: 'Default', enabled: true }],
          }),
        ],
      }),
    );
    const linear = entries.filter((entry) => entry.name === 'Linear');
    expect(linear).toHaveLength(1);
    expect(linear[0].state).toBe('installed');
    expect(linear[0].ref).toEqual({ type: 'curated-mcp', key: 'linear' });
    expect(linear[0].integration?.connector).toEqual({
      displayName: 'Linear',
      connected: false,
    });
  });

  it('marks the card installed when the folded connector is linked', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        curatedMcpServers: [LINEAR_CONNECTOR_MCP],
        providerConnectors: [
          {
            provider: 'claude',
            connectors: [
              {
                displayName: 'Linear',
                connected: true,
              },
            ],
          },
        ],
      }),
    );
    expect(entries.map((entry) => entry.id)).toEqual(['mcp-catalog:linear']);
    expect(entries[0].state).toBe('installed');
    expect(entries[0].integration?.connections).toEqual([
      {
        serverId: 'linear',
        name: 'Claude account',
        binding: 'provider',
        state: 'installed',
      },
    ]);
  });
});

describe('buildUnifiedPluginEntries — REG-3033 review follow-ups', () => {
  const LINEAR_MCP = makeCuratedMcp({ key: 'linear', name: 'Linear' });
  const account = (
    configId: string,
    status: AccountMcpConnection['status'],
  ): McpServerIndexEntry =>
    makeMcpIndexEntry({
      id: 'linear',
      name: 'Linear',
      scope: 'account',
      curatedKey: 'linear',
      accountConnectionId: `conn-linear-${configId}`,
      accountConnection: {
        id: `conn-linear-${configId}`,
        serverKey: 'linear',
        configId,
        displayName: 'Linear',
        status,
        routeId: 'route',
        enabledTools: null,
        kind: 'CURATED',
      },
      configs: [{ id: configId, name: configId, enabled: true }],
    });

  it('keeps each account configuration of one key on its own state', () => {
    // Account rows share the provider server id, so a status matched on the
    // id alone handed every connection the first match's state.
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        curatedMcpServers: [LINEAR_MCP],
        mcpServers: [
          account('default', 'CONNECTED'),
          account('work', 'REAUTH_REQUIRED'),
        ],
        mcpStatuses: [
          makeMcpStatus({
            serverId: 'linear',
            connectionStatus: 'connected',
            configs: [
              { configId: 'default', authStatus: 'connected' },
              { configId: 'work', authStatus: 'error' },
            ],
          }),
        ],
      }),
    );
    expect(entries).toHaveLength(1);
    expect(
      entries[0].integration?.connections.map((connection) => [
        connection.configId,
        connection.state,
      ]),
    ).toEqual([
      ['default', 'installed'],
      ['work', 'needs-auth'],
    ]);
  });

  it('keeps a single-key curated plugin card unless the host opts into the fold', () => {
    // The fold moves the plugin's install onto the integration card's
    // detail. A host whose card detail cannot install a plugin (the portal's
    // MCP panel) must keep the plugin's own card, so the fold is opt-in.
    const plugin = makeCuratedPlugin({
      key: 'linear',
      name: 'Linear',
      mcpServers: ['linear'],
      skills: [{ key: 'triage', name: 'Triage', contentHash: '', files: [] }],
    });
    const plain = buildUnifiedPluginEntries(
      emptyInputs({
        curatedPlugins: [plugin],
        curatedMcpServers: [LINEAR_MCP],
      }),
    );
    expect(plain.map((entry) => entry.id)).toEqual([
      'curated:linear',
      'mcp-catalog:linear',
    ]);
    expect(
      plain.find((entry) => entry.id === 'mcp-catalog:linear')?.integration
        ?.plugin,
    ).toBeUndefined();
    const folded = buildUnifiedPluginEntries(
      emptyInputs({
        curatedPlugins: [plugin],
        curatedMcpServers: [LINEAR_MCP],
        foldSingleKeyPlugins: true,
      }),
    );
    expect(folded.map((entry) => entry.id)).toEqual(['mcp-catalog:linear']);
    expect(folded[0]?.integration?.plugin?.key).toBe('linear');
  });

  it('counts a connected device copy nested under a disconnected account row', () => {
    // The inventory folds a same-key device file under the key's account
    // row; the card walked only the top-level rows, so that binding never
    // reached its connections and the card asked for sign-in on a server
    // that was already connected.
    const device = makeMcpIndexEntry({
      id: 'srv-linear',
      name: 'Linear',
      curatedKey: 'linear',
      configs: [{ id: 'cfg-1', name: 'default', enabled: true }],
    });
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        curatedMcpServers: [LINEAR_MCP],
        mcpServers: [
          { ...account('default', 'DISCONNECTED'), deviceCopies: [device] },
        ],
        mcpStatuses: [
          makeMcpStatus({
            serverId: 'srv-linear',
            configs: [{ configId: 'cfg-1', authStatus: 'connected' }],
          }),
        ],
      }),
    );
    const card = entries.find((entry) => entry.id === 'mcp-catalog:linear');
    expect(card?.state).toBe('installed');
    expect(
      card?.integration?.connections.map((connection) => [
        connection.binding,
        connection.serverId,
        connection.state,
      ]),
    ).toEqual([
      ['account', 'linear', 'available'],
      ['device', 'srv-linear', 'installed'],
    ]);
  });

  it('keeps a multi-key curated plugin that shares a folded connector name', () => {
    // Name-based suppression exists for provider marketplace wrappers of a
    // connector. A curated plugin is not a wrapper: one named like a folded
    // connector (a "Linear" plugin needing Linear and GitHub) must keep its
    // card and chips rather than vanish behind the connector's name.
    const plugin = makeCuratedPlugin({
      key: 'linear-github',
      name: 'Linear',
      mcpServers: ['linear', 'github'],
      skills: [{ key: 'sync', name: 'Sync', contentHash: '', files: [] }],
    });
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        foldSingleKeyPlugins: true,
        curatedPlugins: [plugin],
        curatedMcpServers: [
          makeCuratedMcp({
            key: 'linear',
            name: 'Linear',
            oauthHints: { scopes: ['read'] },
            providerConnector: { providers: ['claude'] },
          }),
          makeCuratedMcp({ key: 'github', name: 'GitHub' }),
        ],
        providerConnectors: [{ provider: 'claude', connectors: [] }],
      }),
    );
    const card = entries.find((entry) => entry.id === 'curated:linear-github');
    expect(card?.state).toBe('available');
    expect(card?.requirements?.map((requirement) => requirement.key)).toEqual([
      'linear',
      'github',
    ]);
    expect(
      entries.find((entry) => entry.id === 'mcp-catalog:linear')?.integration
        ?.connector,
    ).toEqual({ displayName: 'Linear', connected: false });
  });

  it('keeps two configurations of one uncatalogued key apart', () => {
    // Without catalog metadata each account row projected as
    // `mcp-local:<serverId>`, and the Personal and Work rows share that id.
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        mcpServers: [
          account('default', 'CONNECTED'),
          account('work', 'REAUTH_REQUIRED'),
        ],
      }),
    );
    expect(entries.map((entry) => entry.id)).toEqual([
      'mcp-local:linear/default',
      'mcp-local:linear/work',
    ]);
    expect(entries.map((entry) => entry.ref)).toEqual([
      {
        type: 'local-mcp',
        serverId: 'linear',
        configId: 'default',
        curatedKey: 'linear',
      },
      {
        type: 'local-mcp',
        serverId: 'linear',
        configId: 'work',
        curatedKey: 'linear',
      },
    ]);
    expect(entries.map((entry) => entry.state)).toEqual([
      'installed',
      'needs-auth',
    ]);
  });

  it('keeps a later single-key plugin for an already folded key as a plugin card that names the integration', () => {
    const first = makeCuratedPlugin({
      key: 'linear-triage',
      name: 'Linear Triage',
      mcpServers: ['linear'],
    });
    const second = makeCuratedPlugin({
      key: 'linear-release',
      name: 'Linear Release',
      mcpServers: ['linear'],
    });
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        // The desktop opts into the fold; its card detail installs the plugin.
        foldSingleKeyPlugins: true,
        curatedPlugins: [first, second],
        curatedMcpServers: [LINEAR_MCP],
      }),
    );
    expect(entries.map((entry) => entry.id).sort()).toEqual([
      'curated:linear-release',
      'mcp-catalog:linear',
    ]);
    expect(
      entries.find((entry) => entry.id === 'mcp-catalog:linear')?.integration
        ?.plugin?.key,
    ).toBe('linear-triage');
    expect(
      entries.find((entry) => entry.id === 'curated:linear-release')
        ?.requirements,
    ).toEqual([
      { key: 'linear', name: 'Linear', entryId: 'mcp-catalog:linear' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// CAN-3009: agents, plugin references and project templates shared with the
// viewer, and who every shared entry is shared with.
// ---------------------------------------------------------------------------

describe('buildUnifiedPluginEntries — shared agents, plugins and project templates', () => {
  const growthTeam = {
    type: 'team',
    id: 'team-1',
    name: 'Growth',
    organization: { id: 'org-1', name: 'Acme' },
  } as const;
  const acmeOrganization = {
    type: 'organization',
    id: 'org-1',
    name: 'Acme',
  } as const;
  const personalOwner = { type: 'user', id: 'user-1', name: 'Aaron' } as const;

  function makeSharedAgent(
    overrides: Partial<SharedAgentSummary> = {},
  ): SharedAgentSummary {
    return {
      id: 'agent-1',
      name: 'release notes writer',
      modelId: 'agent_model_1',
      baseModel: 'claude-sonnet',
      instructionsPreview: 'Drafts release notes from merged pull requests.',
      contentHash: 'hash-agent',
      shareScope: 'team',
      owner: growthTeam,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      createdBy: { id: 'user-1', name: 'Aaron', email: null },
      canUpdate: false,
      canDelete: false,
      ...overrides,
    };
  }

  function makeSharedPlugin(
    overrides: Partial<SharedPluginSummary> = {},
  ): SharedPluginSummary {
    return {
      owner: acmeOrganization,
      shareScope: 'organization',
      createdBy: { id: 'user-1', name: 'Aaron' },
      externalId: 'plugin-share-1',
      refKey: 'plugin:acme/tools:deploy',
      ref: {
        type: 'plugin',
        marketplace: { type: 'github', repo: 'acme/tools' },
        plugin_name: 'deploy',
      },
      name: 'Deploy tools',
      description: null,
      marketplaceOrigin: 'acme/tools',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      ...overrides,
    };
  }

  function makeSharedBlueprint(
    overrides: Partial<WorkspaceTemplateShareSummary> = {},
  ): WorkspaceTemplateShareSummary {
    return {
      externalId: 'template-share-1',
      sharePath: '/share/project-templates/template-share-1',
      pinnedContentHash: 'hash-template',
      name: 'Launch plan',
      description: 'A project for planning a launch.',
      audience: 'TEAM',
      owner: growthTeam,
      createdBy: { id: 'user-1', name: 'Aaron' },
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('projects current Personal labels and returns to ordinary labels after promotion refresh', () => {
    const owner = {
      type: 'organization',
      id: 'current',
      name: 'Old stored name',
    } as const;
    const inputs = emptyInputs({
      sharedAgents: [makeSharedAgent({ owner, shareScope: 'organization' })],
      personalOrganizationId: 'current',
    });
    expect(buildUnifiedPluginEntries(inputs)[0]?.sharedWith).toEqual({
      audience: 'organization',
      organizationId: 'current',
      name: 'Personal',
      personal: true,
    });
    expect(
      buildUnifiedPluginEntries({
        ...inputs,
        personalOrganizationId: 'replacement',
      })[0]?.sharedWith,
    ).toEqual({
      audience: 'organization',
      organizationId: 'current',
      name: 'Old stored name',
    });
  });

  it('lists a shared agent under its own kind and keeps its authored name', () => {
    const [entry] = buildUnifiedPluginEntries(
      emptyInputs({ sharedAgents: [makeSharedAgent()] }),
    );
    expect(entry).toMatchObject({
      id: 'agent:shared:agent-1',
      kind: 'agent',
      origin: 'shared',
      // An authored display name, not a slug: never title-cased.
      name: 'release notes writer',
      description: 'Drafts release notes from merged pull requests.',
      typeLabel: 'Agent',
      state: 'available',
      authorName: 'Aaron',
      sharedWith: { audience: 'team', name: 'Growth' },
      ref: { type: 'shared-agent', agentId: 'agent-1' },
    });
  });

  it('lists a shared plugin reference apart from the catalog', () => {
    const [entry] = buildUnifiedPluginEntries(
      emptyInputs({ sharedPlugins: [makeSharedPlugin()] }),
    );
    expect(entry).toMatchObject({
      id: 'plugin:shared:plugin-share-1',
      kind: 'plugin',
      origin: 'shared',
      name: 'Deploy tools',
      description: '',
      typeLabel: 'Plugin',
      state: 'available',
      sharedWith: { audience: 'organization', name: 'Acme' },
      ref: { type: 'shared-plugin', pluginId: 'plugin-share-1' },
    });
  });

  it('calls a shared blueprint a project template', () => {
    const [entry] = buildUnifiedPluginEntries(
      emptyInputs({ sharedBlueprints: [makeSharedBlueprint()] }),
    );
    expect(entry).toMatchObject({
      id: 'blueprint:shared:template-share-1',
      kind: 'blueprint',
      origin: 'shared',
      name: 'Launch plan',
      typeLabel: 'Project template',
      state: 'available',
      sharedWith: { audience: 'team', name: 'Growth' },
      ref: { type: 'shared-blueprint', blueprintId: 'template-share-1' },
    });
    expect(JSON.stringify(entry)).not.toMatch(/"typeLabel":"Blueprint/);
  });

  it('names no audience for a personal or public share', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        sharedAgents: [
          makeSharedAgent({ shareScope: 'private', owner: personalOwner }),
        ],
        sharedPlugins: [
          makeSharedPlugin({ shareScope: 'private', owner: personalOwner }),
        ],
        sharedBlueprints: [
          makeSharedBlueprint({ audience: 'PUBLIC', owner: personalOwner }),
        ],
      }),
    );
    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      expect(entry.sharedWith).toBeUndefined();
    }
  });

  it('says who every other shared kind is shared with', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        sharedSkills: [
          {
            id: 'skill-1',
            name: 'triage',
            description: '',
            contentHash: 'h',
            shareScope: 'team',
            owner: growthTeam,
            createdBy: { id: 'user-1', name: 'Aaron', email: null },
            createdAt: '2026-09-01T00:00:00.000Z',
            updatedAt: '2026-09-01T00:00:00.000Z',
            canUpdate: false,
            canDelete: false,
            publicShare: null,
          },
        ],
        sharedCollections: [
          {
            id: 'collection-1',
            name: 'review kit',
            description: '',
            contentHash: 'h',
            shareScope: 'organization',
            owner: acmeOrganization,
            itemCounts: {
              skills: 1,
              customSkills: 0,
              plugins: 0,
            },
            createdBy: { id: 'user-1', name: 'Aaron', email: null },
            createdAt: '2026-09-01T00:00:00.000Z',
            updatedAt: '2026-09-01T00:00:00.000Z',
            canUpdate: false,
            canDelete: false,
          },
        ],
      }),
    );
    expect(
      entries.find((entry) => entry.id === 'skill:shared:skill-1')?.sharedWith,
    ).toEqual({ audience: 'team', name: 'Growth' });
    expect(
      entries.find((entry) => entry.id === 'collection:shared:collection-1')
        ?.sharedWith,
    ).toEqual({
      audience: 'organization',
      name: 'Acme',
      organizationId: 'org-1',
    });
  });

  it('bands agents, project templates and shared plugins on their own', () => {
    const results = searchUnifiedEntries(
      buildUnifiedPluginEntries(
        emptyInputs({
          sharedAgents: [makeSharedAgent()],
          sharedPlugins: [makeSharedPlugin()],
          sharedBlueprints: [makeSharedBlueprint()],
        }),
      ),
      '',
      null,
    );
    expect(results.agents.map((entry) => entry.id)).toEqual([
      'agent:shared:agent-1',
    ]);
    expect(results.projectTemplates.map((entry) => entry.id)).toEqual([
      'blueprint:shared:template-share-1',
    ]);
    expect(results.sharedPlugins.map((entry) => entry.id)).toEqual([
      'plugin:shared:plugin-share-1',
    ]);
    // A shared reference has no catalog category, so it never joins the
    // catalog band that the category groups are built from.
    expect(results.marketplace).toEqual([]);
  });

  it('finds a shared entry by the team it is shared with', () => {
    const results = searchUnifiedEntries(
      buildUnifiedPluginEntries(
        emptyInputs({
          sharedAgents: [makeSharedAgent()],
          sharedPlugins: [makeSharedPlugin()],
        }),
      ),
      'growth',
      null,
    );
    expect(results.agents).toHaveLength(1);
    expect(results.sharedPlugins).toEqual([]);
  });

  describe('local agents', () => {
    function makeLocalAgent(
      overrides: Partial<UnifiedLocalAgentInput> = {},
    ): UnifiedLocalAgentInput {
      return {
        id: 'agent_model_reviewer',
        name: 'iOS Reviewer',
        description: 'Reviews Swift pull requests.',
        baseModelLabel: 'Claude Sonnet',
        pluginCount: 2,
        updatedAt: '2026-09-02T00:00:00.000Z',
        available: true,
        ...overrides,
      };
    }

    it('projects a local agent as an installed Local agent row', () => {
      const [entry] = buildUnifiedPluginEntries(
        emptyInputs({ localAgents: [makeLocalAgent()] }),
      );
      expect(entry).toMatchObject({
        id: 'agent:local:agent_model_reviewer',
        kind: 'agent',
        origin: 'installed-standalone',
        name: 'iOS Reviewer',
        description: 'Reviews Swift pull requests.',
        typeLabel: 'Agent',
        sourceLabel: 'Local',
        availabilityLabel: 'Installed',
        state: 'installed',
        components: { skills: 0, mcpServers: 0, commands: 0, agents: 1 },
        ref: { type: 'local-agent', agentId: 'agent_model_reviewer' },
      });
    });

    it('keeps unavailable local agents listed and labels them', () => {
      const [entry] = buildUnifiedPluginEntries(
        emptyInputs({ localAgents: [makeLocalAgent({ available: false })] }),
      );
      expect(entry).toMatchObject({
        state: 'installed',
        availabilityLabel: 'Unavailable',
      });
    });

    it('keeps local and shared ids in separate namespaces', () => {
      const entries = buildUnifiedPluginEntries(
        emptyInputs({
          localAgents: [makeLocalAgent({ id: 'agent-1' })],
          sharedAgents: [makeSharedAgent({ id: 'agent-1' })],
        }),
      );
      expect(entries.map((entry) => entry.id)).toEqual([
        'agent:local:agent-1',
        'agent:shared:agent-1',
      ]);
    });

    it('folds only the shared row a local copy exactly names', () => {
      const entries = buildUnifiedPluginEntries(
        emptyInputs({
          localAgents: [
            makeLocalAgent({ id: 'copy-1', sharedRemoteId: 'agent-1' }),
            makeLocalAgent({ id: 'copy-2', sharedRemoteId: 'agent-1' }),
            makeLocalAgent({
              id: 'other',
              name: 'release notes writer',
              sharedRemoteId: 'missing',
            }),
          ],
          sharedAgents: [
            makeSharedAgent({ id: 'agent-1' }),
            makeSharedAgent({ id: 'agent-2' }),
          ],
        }),
      );
      expect(entries.map((entry) => entry.id)).toEqual([
        'agent:local:copy-1',
        'agent:local:copy-2',
        'agent:local:other',
        'agent:shared:agent-2',
      ]);
    });

    it('dedupes against the full local inventory before search filters it', () => {
      const results = searchUnifiedEntries(
        buildUnifiedPluginEntries(
          emptyInputs({
            localAgents: [
              makeLocalAgent({ name: 'Zeta', sharedRemoteId: 'agent-1' }),
            ],
            sharedAgents: [makeSharedAgent({ id: 'agent-1' })],
          }),
        ),
        'release',
        null,
      );
      expect(results.agents).toEqual([]);
    });

    it('lists local agents first in the Agents section, never as installed', () => {
      const results = searchUnifiedEntries(
        buildUnifiedPluginEntries(
          emptyInputs({
            localAgents: [
              makeLocalAgent({ id: 'b', name: 'Zeta' }),
              makeLocalAgent({ id: 'a', name: 'Zeta' }),
              makeLocalAgent({ id: 'c', name: 'Alpha', available: false }),
            ],
            sharedAgents: [makeSharedAgent({ name: 'Able' })],
          }),
        ),
        '',
        null,
      );
      expect(results.installed).toEqual([]);
      expect(results.agents.map((entry) => entry.id)).toEqual([
        'agent:local:c',
        'agent:local:a',
        'agent:local:b',
        'agent:shared:agent-1',
      ]);
    });

    it('opens a local agent by id before the inventory lists it', () => {
      expect(pendingLocalAgentEntry('agent:local:agent_model_x')).toMatchObject(
        {
          id: 'agent:local:agent_model_x',
          kind: 'agent',
          ref: { type: 'local-agent', agentId: 'agent_model_x' },
        },
      );
      expect(localAgentIdFromEntryId('agent:local:agent_model_x')).toBe(
        'agent_model_x',
      );
      expect(pendingLocalAgentEntry('agent:shared:agent-1')).toBeNull();
      expect(pendingLocalAgentEntry('agent:local:')).toBeNull();
    });

    it('matches local agents by search query', () => {
      const results = searchUnifiedEntries(
        buildUnifiedPluginEntries(
          emptyInputs({
            localAgents: [
              makeLocalAgent(),
              makeLocalAgent({ id: 'other', name: 'Planner' }),
            ],
          }),
        ),
        'reviewer',
        null,
      );
      expect(results.agents.map((entry) => entry.name)).toEqual([
        'iOS Reviewer',
      ]);
    });
  });

  it('records when each share was made (CAN-4840)', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        sharedAgents: [makeSharedAgent()],
        sharedPlugins: [makeSharedPlugin()],
        sharedBlueprints: [makeSharedBlueprint()],
      }),
    );
    const since = (id: string): string | undefined =>
      entries.find((entry) => entry.id === id)?.sharedSince;
    expect(since('agent:shared:agent-1')).toBe('2026-09-01T00:00:00.000Z');
    expect(since('plugin:shared:plugin-share-1')).toBe(
      '2026-09-01T00:00:00.000Z',
    );
    expect(since('blueprint:shared:template-share-1')).toBe(
      '2026-09-01T00:00:00.000Z',
    );
  });
});

describe('unifiedEntryIdForRef', () => {
  it('resolves local agent references in a separate namespace', () => {
    expect(
      unifiedEntryIdForRef({ type: 'local-agent', agentId: 'reviewer' }),
    ).toBe('agent:local:reviewer');
    expect(
      unifiedEntryIdForRef({ type: 'shared-agent', agentId: 'reviewer' }),
    ).toBe('agent:shared:reviewer');
  });

  it("names the same entry the builder made from each entry's ref", () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        curatedPlugins: [makeCuratedPlugin({ key: 'curated-one' })],
        marketplaces: [
          makeMarketplace({
            plugins: [makePluginInfo({ name: 'lint' })],
            pluginCount: 1,
          }),
        ],
        installedSkills: [makeSkill({ sourceId: 'local', name: 'review' })],
        mcpServers: [makeMcpIndexEntry({ id: 'server-1' })],
        mcpStatuses: [makeMcpStatus()],
        curatedMcpServers: [makeCuratedMcp({ key: 'catalog-only' })],
      }),
    );
    expect(entries.length).toBeGreaterThanOrEqual(5);
    for (const entry of entries) {
      expect(unifiedEntryIdForRef(entry.ref)).toBe(entry.id);
    }
  });
});

describe('Customize entry facts', () => {
  it('projects installed skill update/custom flags without requiring them from web sync', () => {
    const row = buildInstalledSkillEntry(
      makeSkill({ updateAvailable: true, custom: true }),
    );
    expect(row).toMatchObject({ updateAvailable: true, custom: true });
    expect(
      buildInstalledSkillEntry({
        name: 'legacy',
        sourceId: 'local',
        description: '',
      }).updateAvailable,
    ).toBeUndefined();
  });

  it('uses actual harness installs and installed versions rather than catalog/provider support', () => {
    const make = (
      claudeVersion?: string,
      codexVersion?: string,
    ): UnifiedPluginEntry =>
      buildUnifiedPluginEntries(
        emptyInputs({
          marketplaces: [
            makeMarketplace({
              plugins: [
                makePluginInfo({
                  version: 'catalog-99',
                  globalInstallStatus: {
                    checkedAt: 'now',
                    claude: {
                      installed: true,
                      available: true,
                      version: claudeVersion,
                    },
                    codex: {
                      installed: true,
                      available: true,
                      version: codexVersion,
                    },
                  },
                }),
              ],
            }),
          ],
        }),
      )[0];
    expect(make('1.2', '1.2')).toMatchObject({
      version: '1.2',
      installedHarnesses: { claude: true, codex: true },
    });
    expect(make('1.2', '1.3').version).toBeUndefined();
    expect(make('1.2').version).toBeUndefined();
    const unsupported = buildUnifiedPluginEntries(
      emptyInputs({
        marketplaces: [
          makeMarketplace({
            plugins: [makePluginInfo({ version: 'catalog-99' })],
          }),
        ],
      }),
    )[0];
    expect(unsupported.version).toBeUndefined();
    expect(unsupported.installedHarnesses).toBeUndefined();
  });

  it('retains explicitly viewer-owned automation shares alongside local copies, deduplicating share reads', () => {
    const share = makeSharedAutomation();
    const inputs = emptyInputs({
      localAutomations: [makeLocalAutomation({ sharedRemoteId: share.id })],
      sharedAutomations: [share, share],
      viewerId: share.createdBy.id,
    });
    const rows = buildUnifiedPluginEntries(inputs).filter(
      (row) => row.kind === 'automation',
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.origin === 'shared')?.ownedByViewer).toBe(
      true,
    );
    expect(
      rows.find((row) => row.origin === 'installed-standalone')?.ownedByViewer,
    ).toBeUndefined();
    expect(
      buildUnifiedPluginEntries({ ...inputs, viewerId: 'someone-else' }).filter(
        (row) => row.kind === 'automation',
      ),
    ).toHaveLength(1);
    expect(
      buildUnifiedPluginEntries({ ...inputs, viewerId: null }).some(
        (row) => row.ownedByViewer,
      ),
    ).toBe(false);
  });
});

it('retains installed automation catalog rows for section hosts while linking the canonical install', () => {
  const share = makeSharedAutomation();
  const rows = buildUnifiedPluginEntries(
    emptyInputs({
      localAutomations: [makeLocalAutomation({ sharedRemoteId: share.id })],
      sharedAutomations: [share],
      retainAutomationCatalogEntries: true,
    }),
  ).filter((row) => row.kind === 'automation');
  expect(rows).toHaveLength(2);
  expect(rows.find((row) => row.origin === 'shared')).toMatchObject({
    state: 'installed',
    installedEntryId: rows[0].id,
  });
});

it('distinguishes private cloud records from actual public-link-only automation shares', () => {
  const privateShare = makeSharedAutomation({
    shareScope: 'private',
    publicShare: null,
  });
  const published = makeSharedAutomation({
    id: 'public-share',
    shareScope: 'private',
    publicShare: {
      externalId: 'public',
      pinnedContentHash: AUTOMATION_HASH,
      upToDate: true,
      sharePath: '/public',
      createdAt: 'now',
      updatedAt: 'now',
    },
  });
  const rows = buildUnifiedPluginEntries(
    emptyInputs({
      viewerId: 'user-1',
      sharedAutomations: [privateShare, published],
    }),
  );
  expect(
    rows.find((row) => row.id === 'automation:shared:share-1'),
  ).toMatchObject({ ownedByViewer: true, isShared: false });
  expect(
    rows.find((row) => row.id === 'automation:shared:public-share'),
  ).toMatchObject({ ownedByViewer: true, isShared: true });
  expect(
    buildUnifiedPluginEntries(
      emptyInputs({ viewerId: 'other', sharedAutomations: [published] }),
    )[0],
  ).toMatchObject({ ownedByViewer: false, isShared: true });
});

describe('buildUnifiedPluginEntries — MCP connection status (CAN-4265)', () => {
  const accountConnection: AccountMcpConnection = {
    id: 'conn-1',
    serverKey: 'custom:def',
    configId: 'default',
    displayName: 'Internal tools',
    status: 'REAUTH_REQUIRED',
    routeId: 'route',
    enabledTools: null,
    kind: 'CUSTOM',
  };

  it('badges a local server from its cached status', () => {
    const [entry] = buildUnifiedPluginEntries(
      emptyInputs({
        mcpServers: [makeMcpIndexEntry({ id: 'local-1' })],
        mcpStatuses: [
          makeMcpStatus({
            serverId: 'local-1',
            connectionStatus: 'unreachable',
          }),
        ],
      }),
    );
    expect(entry.connection).toEqual({ status: 'unreachable' });
  });

  it('reads Not checked when no status was recorded', () => {
    const [entry] = buildUnifiedPluginEntries(
      emptyInputs({ mcpServers: [makeMcpIndexEntry({ id: 'local-1' })] }),
    );
    expect(entry.connection).toEqual({ status: 'unknown' });
  });

  it('marks a provider-managed server by reachability', () => {
    const [entry] = buildUnifiedPluginEntries(
      emptyInputs({
        mcpServers: [makeMcpIndexEntry({ id: 'local-1' })],
        mcpStatuses: [
          makeMcpStatus({
            serverId: 'local-1',
            connectionStatus: 'unknown',
            reachability: 'reachable',
            handler: 'provider',
          }),
        ],
      }),
    );
    expect(entry.connection).toEqual({ status: 'connected', provider: true });
  });

  it('falls back to the cloud connection state for an account row', () => {
    const [entry] = buildUnifiedPluginEntries(
      emptyInputs({
        mcpServers: [
          makeMcpIndexEntry({
            id: 'custom:def',
            scope: 'account',
            accountConnection,
            configs: [{ id: 'default', name: 'Default', enabled: true }],
          }),
        ],
      }),
    );
    expect(entry.connection).toEqual({ status: 'auth_required' });
  });

  it('accepts the Portal row projection as status input', () => {
    const [entry] = buildUnifiedPluginEntries(
      emptyInputs({
        mcpServers: [makeMcpIndexEntry({ id: 'local-1' })],
        mcpStatuses: [
          {
            serverId: 'local-1',
            connectionStatus: 'connected',
            reachability: 'reachable',
            configs: [],
          },
        ],
      }),
    );
    expect(entry.connection).toEqual({ status: 'connected' });
  });

  it('badges a curated card with one binding and omits non-MCP entries', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        curatedMcpServers: [makeCuratedMcp({ key: 'acme-mcp' })],
        mcpServers: [
          makeMcpIndexEntry({ id: 'server-1', curatedKey: 'acme-mcp' }),
        ],
        mcpStatuses: [
          makeMcpStatus({
            serverId: 'server-1',
            connectionStatus: 'connected',
          }),
        ],
        curatedPlugins: [makeCuratedPlugin({ key: 'other-plugin' })],
      }),
    );
    expect(
      entries.find((entry) => entry.id === 'mcp-catalog:acme-mcp')?.connection,
    ).toEqual({ status: 'connected' });
    expect(
      entries.find((entry) => entry.id === 'curated:other-plugin')?.connection,
    ).toBeUndefined();
  });

  it('does not invent one health for a card with several bindings', () => {
    const [entry] = buildUnifiedPluginEntries(
      emptyInputs({
        curatedMcpServers: [makeCuratedMcp({ key: 'acme-mcp' })],
        mcpServers: [
          makeMcpIndexEntry({ id: 'server-1', curatedKey: 'acme-mcp' }),
          makeMcpIndexEntry({ id: 'server-2', curatedKey: 'acme-mcp' }),
        ],
      }),
    );
    expect(entry.connection).toBeUndefined();
  });
});

it('selects cached health for the exact account configuration (CAN-4265 audit)', () => {
  const account: AccountMcpConnection = {
    id: 'personal',
    serverKey: 'custom:shared',
    configId: 'personal',
    displayName: 'Tools',
    status: 'CONNECTED',
    routeId: 'route',
    enabledTools: null,
    kind: 'CUSTOM',
  };
  const entries = buildUnifiedPluginEntries(
    emptyInputs({
      mcpServers: [
        makeMcpIndexEntry({
          id: account.serverKey,
          scope: 'account',
          accountConnection: { ...account, id: 'work', configId: 'work' },
        }),
      ],
      mcpStatuses: [
        makeMcpStatus({
          serverId: account.serverKey,
          connectionStatus: 'auth_required',
          configs: [{ configId: 'personal', authStatus: 'error' }],
        }),
        makeMcpStatus({
          serverId: account.serverKey,
          connectionStatus: 'connected',
          configs: [{ configId: 'work', authStatus: 'connected' }],
        }),
      ],
    }),
  );
  expect(entries[0].connection).toEqual({ status: 'connected' });
});

it('keeps credential-free Portal account row configurations distinct (CAN-4265 seam)', () => {
  const rows = ['default', 'work'].map((id) =>
    makeMcpIndexEntry({
      id: 'custom:shared',
      scope: 'account',
      authHandler: 'account',
      configs: [{ id, name: id, enabled: true }],
    }),
  );
  const entries = buildUnifiedPluginEntries(
    emptyInputs({
      mcpServers: rows,
      mcpStatuses: [
        makeMcpStatus({
          serverId: 'custom:shared',
          handler: 'account',
          connectionStatus: 'auth_required',
          reachability: 'unknown',
          configs: [{ configId: 'default', authStatus: 'error' }],
        }),
        makeMcpStatus({
          serverId: 'custom:shared',
          handler: 'account',
          connectionStatus: 'connected',
          reachability: 'unknown',
          configs: [{ configId: 'work', authStatus: 'connected' }],
        }),
      ],
    }),
  );
  expect(entries.map((entry) => [entry.id, entry.connection?.status])).toEqual([
    ['mcp-local:custom:shared/default', 'auth_required'],
    ['mcp-local:custom:shared/work', 'connected'],
  ]);
});

describe('buildUnifiedPluginEntries — curated pipelines', () => {
  it('projects a curated pipeline template as an available Curated pipeline', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        curatedPipelines: [
          {
            key: 'review',
            name: 'Review workflow',
            shortDescription: 'Review open work',
            icon: '',
            version: '1',
            triggerTypes: ['dispatch'],
            scopes: ['directory'],
            jobCount: 1,
            stepCount: 1,
            contentHash: 'a'.repeat(64),
            contentSizeBytes: 64,
            categories: ['review'],
            popular: true,
            sortOrder: 2,
            revision: 1,
            authorName: 'Canopy',
            authorUrl: null,
            docsUrl: null,
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z',
          },
        ],
      }),
    ).filter((entry) => entry.kind === 'pipeline');

    expect(entries).toEqual([
      expect.objectContaining({
        id: 'pipeline:curated:review',
        origin: 'curated',
        name: 'Review workflow',
        typeLabel: 'Workflow',
        description: 'Review open work',
        categories: ['review'],
        authorName: 'Canopy',
        sourceLabel: 'Curated',
        state: 'available',
        recommended: true,
        catalogSortOrder: 2,
        pipeline: {
          source: 'curated',
          scopes: ['directory'],
          triggerTypes: ['dispatch'],
        },
        ref: { type: 'curated-pipeline', key: 'review' },
      }),
    ]);
    expect(unifiedEntryIdForRef(entries[0].ref)).toBe(entries[0].id);
  });
});

describe('CAN-3653 — plugins are the Customize entity', () => {
  const SLACK_URL = 'https://mcp.slack.example/mcp';
  const CLAUDE_SLACK = 'mkt:claude-plugins-official/slack';
  const CODEX_SLACK = 'mkt:openai-curated/slack';
  const installedCodex = {
    codex: { available: true, installed: true },
    claude: { available: false, installed: false },
    checkedAt: '2026-10-23T00:00:00.000Z',
  };
  const slackDetails = {
    skills: [],
    commands: [],
    agents: [],
    mcpServers: [{ name: 'slack', type: 'http' as const, url: SLACK_URL }],
  };

  function claudeMarketplace(
    pluginOverrides: Partial<PluginInfo> = {},
  ): MarketplaceInfo {
    return makeMarketplace({
      id: 'claude-plugins-official',
      name: 'claude-plugins-official',
      sourceUrl: 'https://github.com/anthropics/claude-plugins-official',
      plugins: [
        makePluginInfo({
          name: 'slack',
          displayName: 'Slack',
          marketplaceId: 'claude-plugins-official',
          providerSupport: { claude: 'native', codex: 'compat' },
          externalSource: {
            source: 'url',
            url: 'https://github.com/slackapi/slack-mcp-plugin.git',
          },
          details: {
            ...slackDetails,
            hooks: [],
            lspServers: [],
            hasReadme: false,
          },
          ...pluginOverrides,
        }),
      ],
    });
  }

  function codexMarketplace(
    pluginOverrides: Partial<PluginInfo> = {},
  ): MarketplaceInfo {
    return makeMarketplace({
      id: 'openai-curated',
      name: 'Codex official',
      sourceUrl: 'https://github.invalid/openai/curated',
      plugins: [
        makePluginInfo({
          name: 'slack',
          displayName: 'Slack',
          marketplaceId: 'openai-curated',
          providerSupport: { claude: 'none', codex: 'native' },
          externalSource: {
            source: 'url',
            url: 'https://github.invalid/openai/slack.git',
          },
          details: {
            ...slackDetails,
            hooks: [],
            lspServers: [],
            hasReadme: false,
          },
          globalInstallStatus: installedCodex,
          ...pluginOverrides,
        }),
      ],
    });
  }

  const bundledRow = makeMcpIndexEntry({
    id: 'slack-codex-plugin',
    name: 'Slack',
    type: 'http',
    urlHost: 'mcp.slack.example',
  });
  const standaloneRow = makeMcpIndexEntry({
    id: 'team-notes',
    name: 'Team notes MCP',
    type: 'http',
    urlHost: 'notes.example.test',
  });
  const slackCatalog = makeCuratedMcp({
    key: 'slack',
    name: 'Slack',
    url: SLACK_URL,
  });

  function byId(
    entries: UnifiedPluginEntry[],
    id: string,
  ): UnifiedPluginEntry | undefined {
    return entries.find((entry) => entry.id === id);
  }

  it('keeps both Slack plugins, hides the bundled server and marks the catalog card installed via the plugin', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        marketplaces: [claudeMarketplace(), codexMarketplace()],
        mcpServers: [bundledRow, standaloneRow],
        curatedMcpServers: [slackCatalog],
      }),
    );
    const plugins = entries.filter(
      (entry) =>
        entry.ref.type === 'marketplace-plugin' && entry.name === 'Slack',
    );
    expect(plugins.map((entry) => entry.id)).toEqual([
      CLAUDE_SLACK,
      CODEX_SLACK,
    ]);
    expect(byId(entries, CLAUDE_SLACK)?.sourceLabel).toBe('Claude · slackapi');
    expect(byId(entries, CODEX_SLACK)?.sourceLabel).toBe('Codex official');

    const link = { entryId: CODEX_SLACK, name: 'Slack' };
    expect(byId(entries, 'mcp-local:slack-codex-plugin')?.bundledBy).toEqual(
      link,
    );
    // The hidden row stays reachable from its plugin's page.
    expect(byId(entries, CODEX_SLACK)?.bundledServerRows).toEqual([
      {
        serverName: 'slack',
        endpoint: 'http:mcp.slack.example',
        entryId: 'mcp-local:slack-codex-plugin',
        serverId: 'slack-codex-plugin',
      },
    ]);
    expect(byId(entries, CLAUDE_SLACK)?.bundledServerRows).toBeUndefined();
    const card = byId(entries, 'mcp-catalog:slack');
    expect(card?.state).toBe('available');
    expect(card?.installedVia).toEqual(link);

    expect(byId(entries, CLAUDE_SLACK)?.alsoAvailableFrom).toEqual([
      {
        entryId: CODEX_SLACK,
        label: 'Codex official',
        ref: {
          type: 'marketplace-plugin',
          marketplaceId: 'openai-curated',
          pluginName: 'slack',
        },
      },
    ]);
    expect(byId(entries, CODEX_SLACK)?.alsoAvailableFrom).toEqual([
      {
        entryId: CLAUDE_SLACK,
        label: 'Claude · slackapi',
        ref: {
          type: 'marketplace-plugin',
          marketplaceId: 'claude-plugins-official',
          pluginName: 'slack',
        },
      },
    ]);
  });

  it('matches the source label in search', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({ marketplaces: [claudeMarketplace(), codexMarketplace()] }),
    );
    expect(
      searchUnifiedEntries(entries, 'slackapi', null).marketplace.map(
        (entry) => entry.id,
      ),
    ).toContain(CLAUDE_SLACK);
  });

  it('leaves a standalone server untouched', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        marketplaces: [codexMarketplace()],
        mcpServers: [bundledRow, standaloneRow],
      }),
    );
    const standalone = byId(entries, 'mcp-local:team-notes');
    expect(standalone?.bundledBy).toBeUndefined();
    expect(standalone?.installedVia).toBeUndefined();
  });

  it('attributes to the first installed plugin when two installed plugins bundle one endpoint', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        marketplaces: [
          claudeMarketplace({
            globalInstallStatus: {
              claude: { available: true, installed: true },
              checkedAt: '2026-10-23T00:00:00.000Z',
            },
          }),
          codexMarketplace(),
        ],
        mcpServers: [bundledRow],
        curatedMcpServers: [slackCatalog],
      }),
    );
    const first = { entryId: CLAUDE_SLACK, name: 'Slack' };
    expect(byId(entries, CLAUDE_SLACK)).toBeDefined();
    expect(byId(entries, CODEX_SLACK)).toBeDefined();
    expect(byId(entries, 'mcp-local:slack-codex-plugin')?.bundledBy).toEqual(
      first,
    );
    expect(byId(entries, 'mcp-catalog:slack')?.installedVia).toEqual(first);
  });

  it('returns a bundled row to Installed once its plugin is uninstalled', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        marketplaces: [
          claudeMarketplace(),
          codexMarketplace({ globalInstallStatus: undefined }),
        ],
        mcpServers: [bundledRow],
        curatedMcpServers: [slackCatalog],
      }),
    );
    expect(
      byId(entries, 'mcp-local:slack-codex-plugin')?.bundledBy,
    ).toBeUndefined();
    const card = byId(entries, 'mcp-catalog:slack');
    expect(card?.installedVia).toBeUndefined();
    expect(card?.state).toBe('available');
  });

  it('leaves the row standalone when the installed plugin has no details', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        marketplaces: [codexMarketplace({ details: null })],
        mcpServers: [bundledRow],
        curatedMcpServers: [slackCatalog],
      }),
    );
    expect(
      byId(entries, 'mcp-local:slack-codex-plugin')?.bundledBy,
    ).toBeUndefined();
    expect(byId(entries, 'mcp-catalog:slack')?.installedVia).toBeUndefined();
  });

  it('leaves every row visible when several rows match one bundled server', () => {
    // Two installed rows on one host with one name: which one the plugin
    // brought is unknown, so neither is hidden behind it.
    const secondRow = makeMcpIndexEntry({
      id: 'slack-manual',
      name: 'Slack',
      type: 'http',
      urlHost: 'mcp.slack.example',
    });
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        marketplaces: [codexMarketplace()],
        mcpServers: [bundledRow, secondRow],
        curatedMcpServers: [slackCatalog],
      }),
    );
    expect(
      byId(entries, 'mcp-local:slack-codex-plugin')?.bundledBy,
    ).toBeUndefined();
    expect(byId(entries, 'mcp-local:slack-manual')?.bundledBy).toBeUndefined();
    expect(byId(entries, CODEX_SLACK)?.bundledServerRows).toBeUndefined();
    // The catalog card still reads installed via the plugin.
    expect(byId(entries, 'mcp-catalog:slack')?.installedVia).toEqual({
      entryId: CODEX_SLACK,
      name: 'Slack',
    });
  });

  it('never attributes a command server row, even with the same name', () => {
    // Index rows carry no executable, so a name match cannot show the plugin
    // installed the row; hiding it could drop a user's own server (CAN-3653).
    const commandDetails = {
      ...slackDetails,
      hooks: [],
      lspServers: [],
      hasReadme: false,
      mcpServers: [
        { name: 'slack', type: 'command' as const, command: '/bin/slack' },
      ],
    };
    const commandRow = makeMcpIndexEntry({
      id: 'slack-command',
      name: 'Slack',
      type: 'command',
    });
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        marketplaces: [codexMarketplace({ details: commandDetails })],
        mcpServers: [bundledRow, commandRow],
      }),
    );
    expect(byId(entries, 'mcp-local:slack-command')?.bundledBy).toBeUndefined();
    expect(
      byId(entries, 'mcp-local:slack-codex-plugin')?.bundledBy,
    ).toBeUndefined();
    expect(entries.some((entry) => entry.bundledBy !== undefined)).toBe(false);
  });

  it('does not tag a curated card that already holds an installed connection', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        marketplaces: [codexMarketplace()],
        mcpServers: [{ ...bundledRow, curatedKey: 'slack' }],
        curatedMcpServers: [slackCatalog],
      }),
    );
    const card = byId(entries, 'mcp-catalog:slack');
    expect(card?.state).not.toBe('available');
    expect(card?.installedVia).toBeUndefined();
    expect(entries.some((entry) => entry.bundledBy !== undefined)).toBe(false);
  });

  it('does not tag a provider-connector card', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        marketplaces: [codexMarketplace()],
        curatedMcpServers: [
          { ...slackCatalog, providerConnector: { providers: ['claude'] } },
        ],
      }),
    );
    expect(byId(entries, 'mcp-catalog:slack')?.installedVia).toBeUndefined();
  });

  it('does not touch a folded integration card', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        foldSingleKeyPlugins: true,
        curatedPlugins: [
          makeCuratedPlugin({
            key: 'slack',
            name: 'Slack',
            mcpServers: ['slack'],
          }),
        ],
        marketplaces: [
          {
            id: CURATED_PLUGIN_MARKETPLACE_ID,
            name: 'Curated',
            curated: true,
            plugins: [
              {
                name: 'slack',
                marketplaceId: CURATED_PLUGIN_MARKETPLACE_ID,
                providerSupport: { claude: 'native', codex: 'native' },
                installed: true,
              },
            ],
          },
          codexMarketplace(),
        ],
        curatedMcpServers: [slackCatalog],
      }),
    );
    const card = byId(entries, 'mcp-catalog:slack');
    expect(card?.integration?.plugin).toBeDefined();
    expect(card?.installedVia).toBeUndefined();
  });

  it('links a curated plugin and a marketplace plugin for the same app', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        foldSingleKeyPlugins: false,
        curatedPlugins: [
          makeCuratedPlugin({
            key: 'slack',
            name: 'Slack',
            mcpServers: ['slack'],
          }),
        ],
        marketplaces: [
          {
            id: CURATED_PLUGIN_MARKETPLACE_ID,
            name: 'Curated',
            curated: true,
            plugins: [
              {
                name: 'slack',
                marketplaceId: CURATED_PLUGIN_MARKETPLACE_ID,
                providerSupport: { claude: 'native', codex: 'native' },
              },
            ],
          },
          codexMarketplace(),
        ],
        curatedMcpServers: [slackCatalog],
      }),
    );
    const curated = entries.find(
      (entry) => entry.ref.type === 'curated-plugin' && entry.name === 'Slack',
    );
    expect(curated?.alsoAvailableFrom?.map((link) => link.entryId)).toEqual([
      CODEX_SLACK,
    ]);
    expect(byId(entries, CODEX_SLACK)?.alsoAvailableFrom).toEqual([
      {
        entryId: curated?.id,
        label: 'the curated catalog',
        ref: { type: 'curated-plugin', key: 'slack' },
      },
    ]);
  });

  it('marks a catalog card installed via an installed curated plugin', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        foldSingleKeyPlugins: false,
        curatedPlugins: [
          makeCuratedPlugin({
            key: 'slack',
            name: 'Slack',
            mcpServers: ['slack'],
          }),
        ],
        marketplaces: [
          {
            id: CURATED_PLUGIN_MARKETPLACE_ID,
            name: 'Curated',
            curated: true,
            plugins: [
              {
                name: 'slack',
                marketplaceId: CURATED_PLUGIN_MARKETPLACE_ID,
                providerSupport: { claude: 'native', codex: 'native' },
                installed: true,
              },
            ],
          },
        ],
        curatedMcpServers: [slackCatalog],
      }),
    );
    const curated = entries.find(
      (entry) => entry.ref.type === 'curated-plugin',
    );
    expect(curated?.state).not.toBe('available');
    expect(byId(entries, 'mcp-catalog:slack')?.installedVia).toEqual({
      entryId: curated?.id,
      name: 'Slack',
    });
  });

  describe('package-keyed collapse', () => {
    function overlapping(
      firstUrl: string | undefined,
      secondUrl: string | undefined,
    ): UnifiedPluginEntry[] {
      const copy = (id: string, url: string | undefined): MarketplaceInfo =>
        makeMarketplace({
          id,
          plugins: [
            makePluginInfo({
              name: 'slack',
              marketplaceId: id,
              ...(url ? { externalSource: { source: 'url', url } } : {}),
            }),
          ],
        });
      return buildUnifiedPluginEntries(
        emptyInputs({
          marketplaces: [
            copy('openai-curated-remote', firstUrl),
            copy('claude-plugins-official', secondUrl),
          ],
        }),
      ).filter((entry) => entry.name.toLowerCase() === 'slack');
    }

    it('still collapses the identical package republished by overlapping marketplaces', () => {
      expect(
        overlapping(
          'https://github.com/slackapi/slack-mcp-plugin.git',
          'https://github.com/SlackAPI/slack-mcp-plugin',
        ),
      ).toHaveLength(1);
    });

    it('still collapses same-name copies that publish no external source', () => {
      expect(overlapping(undefined, undefined)).toHaveLength(1);
    });

    it('never collapses when only one copy has an external source', () => {
      expect(
        overlapping(
          'https://github.com/slackapi/slack-mcp-plugin.git',
          undefined,
        ),
      ).toHaveLength(2);
    });

    it('never collapses copies with different external sources', () => {
      expect(
        overlapping(
          'https://github.com/slackapi/slack-mcp-plugin.git',
          'https://github.com/openai/slack.git',
        ),
      ).toHaveLength(2);
    });
  });

  describe('marketplacePluginBundledServerRows', () => {
    it('returns the installed rows hidden behind a plugin', () => {
      expect(
        marketplacePluginBundledServerRows(
          [claudeMarketplace(), codexMarketplace()],
          [bundledRow, standaloneRow],
          { marketplaceId: 'openai-curated', pluginName: 'slack' },
        ),
      ).toEqual([
        {
          serverName: 'slack',
          endpoint: 'http:mcp.slack.example',
          entryId: 'mcp-local:slack-codex-plugin',
          serverId: 'slack-codex-plugin',
        },
      ]);
    });

    it('returns nothing for a plugin that is not installed', () => {
      expect(
        marketplacePluginBundledServerRows(
          [claudeMarketplace(), codexMarketplace()],
          [bundledRow],
          { marketplaceId: 'claude-plugins-official', pluginName: 'slack' },
        ),
      ).toEqual([]);
    });
  });

  describe('marketplacePluginAlternatives', () => {
    it('returns the other catalog for a plugin', () => {
      expect(
        marketplacePluginAlternatives(
          [claudeMarketplace(), codexMarketplace()],
          { marketplaceId: 'openai-curated', pluginName: 'slack' },
        ).map((link) => [link.entryId, link.label]),
      ).toEqual([[CLAUDE_SLACK, 'Claude · slackapi']]);
    });

    it('returns nothing for an unknown plugin', () => {
      expect(
        marketplacePluginAlternatives([claudeMarketplace()], {
          marketplaceId: 'nowhere',
          pluginName: 'slack',
        }),
      ).toEqual([]);
    });
  });
  it('leaves a bundled server that needs sign-in to count on its own listed row (CAN-4840)', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        marketplaces: [claudeMarketplace(), codexMarketplace()],
        mcpServers: [bundledRow],
        mcpStatuses: [
          makeMcpStatus({
            serverId: 'slack-codex-plugin',
            connectionStatus: 'auth_required',
          }),
        ],
        curatedMcpServers: [slackCatalog],
      }),
    );
    // A server that needs sign-in stays listed on its own row
    // (`listedAsItsPlugin`), so its plugin does not repeat the prompt.
    const listed = byId(entries, 'mcp-local:slack-codex-plugin');
    expect(listed?.state).toBe('needs-auth');
    expect(listed?.bundledBy).toEqual({ entryId: CODEX_SLACK, name: 'Slack' });
    expect(listed && listedAsItsPlugin(listed)).toBe(false);
    expect(listed?.pendingSignIns).toBe(1);
    expect(byId(entries, CODEX_SLACK)?.pendingSignIns).toBeUndefined();
    expect(byId(entries, CLAUDE_SLACK)?.pendingSignIns).toBeUndefined();
  });

  it('counts a bundled server’s waiting configuration even when the server is installed (CAN-4840)', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        marketplaces: [codexMarketplace()],
        mcpServers: [bundledRow],
        mcpStatuses: [
          makeMcpStatus({
            serverId: 'slack-codex-plugin',
            configs: [
              { configId: 'a', authStatus: 'connected' },
              { configId: 'b', authStatus: 'expired' },
            ],
          }),
        ],
        curatedMcpServers: [slackCatalog],
      }),
    );
    const hidden = byId(entries, 'mcp-local:slack-codex-plugin');
    expect(hidden?.state).not.toBe('needs-auth');
    expect(hidden?.pendingSignIns).toBe(1);
    expect(byId(entries, CODEX_SLACK)?.pendingSignIns).toBe(1);
  });

  it('leaves a plugin whose bundled servers are signed in without a count (CAN-4840)', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        marketplaces: [codexMarketplace()],
        mcpServers: [bundledRow],
        mcpStatuses: [makeMcpStatus({ serverId: 'slack-codex-plugin' })],
        curatedMcpServers: [slackCatalog],
      }),
    );
    expect(byId(entries, CODEX_SLACK)?.pendingSignIns).toBeUndefined();
  });
});

describe('CAN-4840 — Customize row data', () => {
  const since = '2026-10-12T00:00:00.000Z';

  it('records when shared skills, collections and automations were shared', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        sharedSkills: [
          {
            id: 'ui-review',
            name: 'ui-review-helper',
            description: 'Reviews interfaces',
            contentHash: 'ui-review-hash',
            shareScope: 'team',
            owner: {
              type: 'team',
              id: 'team-1',
              name: 'Design Team',
              organization: { id: 'org-1', name: 'Acme' },
            },
            createdBy: { id: 'user-1', name: 'Ada', email: 'ada@example.com' },
            createdAt: since,
            updatedAt: since,
            canUpdate: true,
            canDelete: true,
            publicShare: null,
          },
        ],
        sharedCollections: [
          {
            id: 'qa-automation',
            name: 'qa-automation-kit',
            description: 'Quality capabilities',
            contentHash: 'qa-automation-hash',
            itemCounts: { skills: 1, plugins: 1, customSkills: 0 },
            shareScope: 'team',
            owner: {
              type: 'team',
              id: 'team-1',
              name: 'Design Team',
              organization: { id: 'org-1', name: 'Acme' },
            },
            createdBy: { id: 'user-1', name: 'Ada', email: 'ada@example.com' },
            createdAt: since,
            updatedAt: since,
            canUpdate: true,
            canDelete: true,
          },
        ],
        sharedAutomations: [makeSharedAutomation({ createdAt: since })],
      }),
    );
    const sharedSince = (id: string): string | undefined =>
      entries.find((entry) => entry.id === id)?.sharedSince;
    expect(sharedSince('skill:shared:ui-review')).toBe(since);
    expect(sharedSince('collection:shared:qa-automation')).toBe(since);
    expect(sharedSince('automation:shared:share-1')).toBe(since);
  });

  function pluginVersion(
    plugin: UnifiedMarketplacePluginInput,
  ): string | undefined {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        marketplaces: [{ id: 'mkt-1', name: 'Marketplace', plugins: [plugin] }],
      }),
    );
    return entries.find((entry) => entry.id === 'mkt:mkt-1/tool')?.version;
  }
  const basePlugin: UnifiedMarketplacePluginInput = {
    name: 'tool',
    marketplaceId: 'mkt-1',
    providerSupport: { claude: 'native', codex: 'none' },
    version: '1.2.0',
  };

  it('falls back to the manifest version for an installed plugin without provider status', () => {
    expect(pluginVersion({ ...basePlugin, installed: true })).toBe('1.2.0');
  });

  it('shows no version for a plugin that is not installed', () => {
    expect(pluginVersion(basePlugin)).toBeUndefined();
  });

  it('keeps the provider status version over the manifest version', () => {
    expect(
      pluginVersion({
        ...basePlugin,
        globalInstallStatus: {
          claude: { available: true, installed: true, version: '1.1.0' },
          codex: { available: false, installed: false },
          checkedAt: '2026-10-23T00:00:00.000Z',
        },
      }),
    ).toBe('1.1.0');
  });
});

describe('CAN-4844 — custom skill edit dates', () => {
  it('projects a custom skill edit date as editedAt', () => {
    const entry = buildInstalledSkillEntry(
      makeSkill({
        sourceId: 'custom:app',
        custom: true,
        updatedAt: '2026-10-10T12:00:00.000Z',
      }),
    );
    expect(entry.editedAt).toBe('2026-10-10T12:00:00.000Z');
  });

  it('leaves editedAt unset for non-custom skills and empty dates', () => {
    expect(
      buildInstalledSkillEntry(
        makeSkill({ updatedAt: '2026-10-10T12:00:00.000Z' }),
      ).editedAt,
    ).toBeUndefined();
    expect(
      buildInstalledSkillEntry(
        makeSkill({ sourceId: 'custom:app', custom: true, updatedAt: '' }),
      ).editedAt,
    ).toBeUndefined();
  });
});

describe('CAN-4844 — plugin-bundled skills', () => {
  const skillDetails = (
    ...names: string[]
  ): UnifiedMarketplacePluginInput['details'] => ({
    skills: names.map((name) => ({
      name,
      description: `About ${name}`,
      path: `skills/${name}/SKILL.md`,
    })),
    agents: [],
    commands: [],
    mcpServers: [],
  });

  function plugin(
    overrides: Partial<UnifiedMarketplacePluginInput> = {},
  ): UnifiedMarketplacePluginInput {
    return {
      ...makePluginInfo({
        name: 'slack',
        displayName: 'Slack',
        marketplaceId: 'openai-curated',
      }),
      installed: true,
      details: skillDetails('summarize-channel'),
      ...overrides,
    };
  }

  function marketplace(
    plugins: UnifiedMarketplacePluginInput[],
    id = 'openai-curated',
  ): UnifiedMarketplaceInput {
    return { id, name: id, plugins };
  }

  function idsOf(entries: readonly UnifiedPluginEntry[]): string[] {
    return entries
      .filter((entry) => entry.ref.type === 'plugin-skill')
      .map((entry) => entry.id);
  }

  it("lists an installed plugin's skills as bundled skill entries", () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({ marketplaces: [marketplace([plugin()])] }),
    );
    const entry = entries.find(
      (candidate) =>
        candidate.id === 'plugin-skill:openai-curated/slack:summarize-channel',
    );
    expect(entry).toMatchObject({
      kind: 'skill',
      state: 'installed',
      // Title-cased like every other skill row.
      name: 'Summarize Channel',
      description: 'About summarize-channel',
      bundledBy: { entryId: 'mkt:openai-curated/slack', name: 'Slack' },
      ref: {
        type: 'plugin-skill',
        marketplaceId: 'openai-curated',
        pluginName: 'slack',
        skillName: 'summarize-channel',
      },
    });
    expect(entry && unifiedEntryIdForRef(entry.ref)).toBe(entry?.id);
    expect(entry && listedAsItsPlugin(entry)).toBe(false);
  });

  it('links installed curated skills to their canonical plugin row and searches by its name', () => {
    const curatedMarketplace = {
      ...marketplace([plugin()], 'curated-feed'),
      curated: true,
    };
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        curatedPlugins: [makeCuratedPlugin({ key: 'slack', name: 'Slack' })],
        marketplaces: [
          curatedMarketplace,
          { ...curatedMarketplace, curated: false },
        ],
      }),
    );
    const parent = entries.find((entry) => entry.id === 'curated:slack');
    const skills = entries.filter((entry) => entry.ref.type === 'plugin-skill');
    expect(parent?.state).toBe('installed');
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      state: parent?.state,
      name: 'Summarize Channel',
      bundledBy: { entryId: parent?.id, name: 'Slack' },
    });
    expect(
      searchUnifiedEntries(entries, 'Slack', null).installed,
    ).toContainEqual(skills[0]);
  });

  it('reads bundled skills from bundledSkills when a row carries no details', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        marketplaces: [
          marketplace([
            plugin({
              details: undefined,
              bundledSkills: [{ name: 'review', description: 'Review' }],
            }),
          ]),
        ],
      }),
    );
    expect(idsOf(entries)).toEqual([
      'plugin-skill:openai-curated/slack:review',
    ]);
  });

  it('skips skills of plugins that are not installed', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        marketplaces: [marketplace([plugin({ installed: false })])],
      }),
    );
    expect(idsOf(entries)).toEqual([]);
  });

  it('keys bundled skills by plugin', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        marketplaces: [
          marketplace([
            plugin({ details: skillDetails('review') }),
            plugin({
              name: 'linear',
              displayName: 'Linear',
              details: skillDetails('review'),
            }),
          ]),
        ],
      }),
    );
    expect(idsOf(entries).sort()).toEqual([
      'plugin-skill:openai-curated/linear:review',
      'plugin-skill:openai-curated/slack:review',
    ]);
  });

  it('dedupes repeated skill names within a plugin', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        marketplaces: [
          marketplace([plugin({ details: skillDetails('review', 'review') })]),
        ],
      }),
    );
    expect(idsOf(entries)).toEqual([
      'plugin-skill:openai-curated/slack:review',
    ]);
  });

  it('does not collapse a bundled skill into a same-named installed skill', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({
        installedSkills: [makeSkill({ name: 'review', sourceId: 'local' })],
        marketplaces: [
          marketplace([plugin({ details: skillDetails('review') })]),
        ],
      }),
    );
    const ids = entries.map((entry) => entry.id);
    expect(ids).toContain('skill:local:review');
    expect(ids).toContain('plugin-skill:openai-curated/slack:review');
  });

  it('finds a bundled skill by its plugin name', () => {
    const entries = buildUnifiedPluginEntries(
      emptyInputs({ marketplaces: [marketplace([plugin()])] }),
    );
    const results = searchUnifiedEntries(entries, 'Slack', null);
    expect(results.installed.map((entry) => entry.id)).toContain(
      'plugin-skill:openai-curated/slack:summarize-channel',
    );
  });

  it('matches only bundled skills, not other bundled rows, by plugin name', () => {
    const [skill] = buildUnifiedPluginEntries(
      emptyInputs({ marketplaces: [marketplace([plugin()])] }),
    ).filter((entry) => entry.ref.type === 'plugin-skill');
    const server: UnifiedPluginEntry = {
      ...skill,
      id: 'mcp-local:workspace-server',
      kind: 'app',
      name: 'workspace-server',
      description: '',
      sourceLabel: undefined,
    };
    const results = searchUnifiedEntries([server], 'Slack', null);
    expect(results.installed).toEqual([]);
  });
});

describe('buildUnifiedPluginEntries — workflow facets (CAN-4845)', () => {
  function makePipeline(overrides: Partial<PipelineInfo> = {}): PipelineInfo {
    return {
      id: 'release',
      name: 'Release Flow',
      filename: 'release.yaml',
      description: 'Publishes the application',
      icon: '',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      source: 'user',
      readonly: false,
      ...overrides,
    };
  }

  function pipelineEntry(
    overrides: Partial<UnifiedEntryInputs> = {},
  ): UnifiedPluginEntry | undefined {
    return buildUnifiedPluginEntries(
      emptyInputs({ pipelines: [makePipeline()], ...overrides }),
    ).find((entry) => entry.kind === 'pipeline');
  }

  // CAN-4551: an automation's own pipeline lists under its automation.
  it('leaves out a user pipeline an automation owns', () => {
    expect(pipelineEntry({ ownedPipelineIds: new Set(['release']) })).toBe(
      undefined,
    );
    expect(
      pipelineEntry({ ownedPipelineIds: new Set(['other']) }),
    ).toBeDefined();
  });

  it('carries readonly from a project pipeline into row availability', () => {
    expect(
      pipelineEntry({
        pipelines: [makePipeline({ source: 'project', readonly: true })],
      })?.workflow?.readonly,
    ).toBe(true);
  });

  it('describes an event-only pipeline as not runnable by hand', () => {
    const entry = pipelineEntry({
      pipelines: [makePipeline({ triggerTypes: ['plan_ready'] })],
    });
    expect(entry?.workflow).toEqual({
      triggers: [
        {
          kind: 'plan-approved',
          label: 'Plan approval',
          explainer: 'Runs automatically when a plan is approved',
        },
      ],
      runnable: false,
      runUnavailableLabel: describeRunUnavailable(['plan-approved']),
    });
  });

  it('marks a dispatchable or trigger-less pipeline as runnable', () => {
    expect(
      pipelineEntry({
        pipelines: [makePipeline({ triggerTypes: ['dispatch'] })],
      })?.workflow,
    ).toEqual({
      triggers: [
        {
          kind: 'manual',
          label: 'Manual',
          explainer: 'Runs when you start it',
        },
      ],
      runnable: true,
    });
    expect(pipelineEntry()?.workflow).toEqual({
      triggers: [
        {
          kind: 'manual',
          label: 'Manual',
          explainer: 'Runs when you start it',
        },
      ],
      runnable: true,
    });
  });

  it('projects the loaded pipeline step count with correct plurality', () => {
    expect(
      pipelineEntry({ pipelines: [makePipeline({ stepCount: 1 })] })?.workflow
        ?.stepCount,
    ).toBe(1);
    expect(
      pipelineEntry({ pipelines: [makePipeline({ stepCount: 4 })] })?.workflow
        ?.stepCount,
    ).toBe(4);
  });

  it('uses the host run-unavailable reason for a manual pipeline', () => {
    expect(
      pipelineEntry({
        pipelineRunUnavailable: new Map([
          ['pipeline:user:release', 'Cannot be started from here'],
        ]),
      })?.workflow,
    ).toEqual({
      triggers: [
        {
          kind: 'manual',
          label: 'Manual',
          explainer: 'Runs when you start it',
        },
      ],
      runnable: false,
      runUnavailableLabel: 'Cannot be started from here',
    });
  });

  it('reads the last run from the host map, null when the map lacks the id', () => {
    const at = Date.UTC(2026, 9, 26);
    expect(
      pipelineEntry({ pipelineLastRuns: new Map() })?.workflow?.lastRun,
    ).toBeNull();
    expect(
      pipelineEntry({
        pipelineLastRuns: new Map([['release', { state: 'success', at }]]),
      })?.workflow?.lastRun,
    ).toEqual({ state: 'success', at });
    expect(pipelineEntry()?.workflow).not.toHaveProperty('lastRun');
  });

  it('copies a local automation’s facets and names the share it came from', () => {
    const workflow = {
      triggerText: 'Every day at 09:00',
      summary: 'App Advisor prompt',
      lastRun: null,
      enabled: true,
    };
    const [installed] = automationEntries({
      localAutomations: [
        makeLocalAutomation({
          workflow,
          installedFrom: { remoteId: 'share-1', contentHash: AUTOMATION_HASH },
        }),
      ],
      sharedAutomations: [makeSharedAutomation()],
    });
    expect(installed?.workflow).toEqual({
      ...workflow,
      sourceText: 'Shared by Platform',
    });

    const [unnamed] = automationEntries({
      localAutomations: [
        makeLocalAutomation({
          workflow,
          installedFrom: { remoteId: 'share-1', contentHash: AUTOMATION_HASH },
        }),
      ],
      sharedAutomations: [
        makeSharedAutomation({
          owner: {
            type: 'team',
            id: 'team-1',
            name: null,
            organization: { id: 'org-1', name: 'Acme' },
          },
        }),
      ],
    });
    expect(unnamed?.workflow).toEqual(workflow);

    const [person] = automationEntries({
      localAutomations: [
        makeLocalAutomation({
          workflow,
          installedFrom: { remoteId: 'share-1', contentHash: AUTOMATION_HASH },
        }),
      ],
      sharedAutomations: [
        makeSharedAutomation({
          owner: { type: 'user', id: 'user-1', name: 'Ada' },
        }),
      ],
    });
    expect(person?.workflow).toEqual({
      ...workflow,
      sourceText: 'Shared by Ada',
      sourceIsPerson: true,
    });
  });

  it('leaves an automation without host facets unchanged', () => {
    const [entry] = automationEntries({
      localAutomations: [makeLocalAutomation()],
    });
    expect(entry?.workflow).toBeUndefined();
  });
});

describe('buildUnifiedPluginEntries — installed shared skills (CAN-5223)', () => {
  const HASH = 'a'.repeat(64);
  const OTHER_HASH = 'b'.repeat(64);

  function makeSharedSkill(
    overrides: Partial<SharedSkillSummary> = {},
  ): SharedSkillSummary {
    return {
      id: 'share-1',
      name: 'Review Helper',
      description: 'Reviews product changes',
      contentHash: HASH,
      shareScope: 'organization',
      owner: { type: 'organization', id: 'org-1', name: 'Northwind' },
      createdBy: { id: 'user-ada', name: 'Ada', email: 'ada@example.com' },
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      canUpdate: false,
      canDelete: false,
      publicShare: null,
      ...overrides,
    };
  }

  function makeReceiptedSkill(
    name: string,
    installedFromShare: InstalledSkillInfo['installedFromShare'],
    overrides: Partial<InstalledSkillInfo> = {},
  ): InstalledSkillInfo {
    return makeSkill({
      name,
      sourceId: 'custom:app',
      custom: true,
      ...(installedFromShare ? { installedFromShare } : {}),
      ...overrides,
    });
  }

  function shareEntry(
    entries: UnifiedPluginEntry[],
    id = 'share-1',
  ): UnifiedPluginEntry | undefined {
    return entries.find((entry) => entry.id === `skill:shared:${id}`);
  }

  function project(
    installedSkills: InstalledSkillInfo[],
    sharedSkills: SharedSkillSummary[] = [makeSharedSkill()],
    overrides: Partial<UnifiedEntryInputs> = {},
  ): UnifiedPluginEntry[] {
    return buildUnifiedPluginEntries(
      emptyInputs({ installedSkills, sharedSkills, ...overrides }),
    );
  }

  it.each([
    ['an unchanged hash', HASH],
    ['a changed hash', OTHER_HASH],
    ['no hash', undefined],
    ['a malformed hash', 'not-a-hash'],
  ])('folds a share into the copy its receipt names, with %s', (_, hash) => {
    const entries = project([
      makeReceiptedSkill('review-helper', {
        remoteId: 'share-1',
        ...(hash === undefined ? {} : { contentHash: hash }),
      }),
    ]);

    expect(shareEntry(entries)).toMatchObject({
      origin: 'shared',
      state: 'installed',
      availabilityLabel: 'Installed',
      installedEntryId: 'skill:custom:app:review-helper',
      ref: { type: 'shared-skill', skillId: 'share-1' },
      ownershipLabel: 'Northwind · Organization',
      sharedSince: '2026-08-01T00:00:00.000Z',
    });
  });

  it('folds a share whose source hash matches a copy installed from another share', () => {
    const entries = project([
      makeReceiptedSkill('review-helper', {
        remoteId: 'older-share',
        contentHash: HASH.toUpperCase(),
      }),
    ]);

    expect(shareEntry(entries)).toMatchObject({
      state: 'installed',
      installedEntryId: 'skill:custom:app:review-helper',
    });
  });

  it.each([
    ['an unequal hash', OTHER_HASH, HASH],
    ['no hash', undefined, ''],
    ['an empty hash', '', ''],
    ['a malformed hash', 'aaaa', 'aaaa'],
  ])(
    'leaves a share available beside a receipt with %s',
    (_, receiptHash, shareHash) => {
      const entries = project(
        [
          makeReceiptedSkill('review-helper', {
            remoteId: 'older-share',
            ...(receiptHash === undefined ? {} : { contentHash: receiptHash }),
          }),
        ],
        [makeSharedSkill({ contentHash: shareHash })],
      );

      expect(shareEntry(entries)).toMatchObject({
        state: 'available',
        availabilityLabel: 'Available',
      });
      expect(shareEntry(entries)?.installedEntryId).toBeUndefined();
    },
  );

  it('never matches a same-name copy without a receipt', () => {
    const entries = project([makeReceiptedSkill('Review Helper', undefined)]);

    expect(shareEntry(entries)?.state).toBe('available');
  });

  it('never matches a receipt outside custom:app or on a built-in skill', () => {
    const receipt = { remoteId: 'share-1', contentHash: HASH };
    const entries = project([
      makeReceiptedSkill('review-helper', receipt, {
        sourceId: 'github:octo:skills',
      }),
      makeReceiptedSkill('bundled-helper', receipt, { builtIn: true }),
    ]);

    expect(shareEntry(entries)?.state).toBe('available');
  });

  it('prefers an exact receipt id over an earlier hash match', () => {
    const entries = project([
      makeReceiptedSkill('hash-copy', {
        remoteId: 'older-share',
        contentHash: HASH,
      }),
      makeReceiptedSkill('id-copy', { remoteId: 'share-1' }),
    ]);

    expect(shareEntry(entries)?.installedEntryId).toBe(
      'skill:custom:app:id-copy',
    );
  });

  it('links to the first matching copy within each match class', () => {
    const entries = project(
      [
        makeReceiptedSkill('first-id', { remoteId: 'share-1' }),
        makeReceiptedSkill('second-id', { remoteId: 'share-1' }),
        makeReceiptedSkill('first-hash', {
          remoteId: 'x',
          contentHash: OTHER_HASH,
        }),
        makeReceiptedSkill('second-hash', {
          remoteId: 'y',
          contentHash: OTHER_HASH,
        }),
      ],
      [
        makeSharedSkill(),
        makeSharedSkill({ id: 'share-2', contentHash: OTHER_HASH }),
      ],
    );

    expect(shareEntry(entries)?.installedEntryId).toBe(
      'skill:custom:app:first-id',
    );
    expect(shareEntry(entries, 'share-2')?.installedEntryId).toBe(
      'skill:custom:app:first-hash',
    );
  });

  it('links several shares to one copy without changing the copy', () => {
    const copy = makeReceiptedSkill('review-helper', {
      remoteId: 'share-1',
      contentHash: HASH,
    });
    const entries = project(
      [copy],
      [makeSharedSkill(), makeSharedSkill({ id: 'share-2' })],
    );

    expect(shareEntry(entries)?.installedEntryId).toBe(
      'skill:custom:app:review-helper',
    );
    expect(shareEntry(entries, 'share-2')?.installedEntryId).toBe(
      'skill:custom:app:review-helper',
    );
    expect(
      entries.find((entry) => entry.id === 'skill:custom:app:review-helper'),
    ).toMatchObject({
      origin: 'installed-standalone',
      state: 'installed',
      custom: true,
    });
    expect(copy.installedFromShare).toEqual({
      remoteId: 'share-1',
      contentHash: HASH,
    });
  });

  it('keeps an installed owned share eligible for Shared by me', () => {
    const entries = project(
      [makeReceiptedSkill('review-helper', { remoteId: 'share-1' })],
      [makeSharedSkill()],
      { viewerId: 'user-ada' },
    );

    expect(shareEntry(entries)).toMatchObject({
      state: 'installed',
      ownedByViewer: true,
      isShared: true,
    });
  });

  it('restores availability once the last matching copy is removed', () => {
    const copy = makeReceiptedSkill('review-helper', { remoteId: 'share-1' });
    expect(shareEntry(project([copy]))?.state).toBe('installed');

    const removed = shareEntry(project([]));
    expect(removed).toMatchObject({
      state: 'available',
      availabilityLabel: 'Available',
    });
    expect(removed?.installedEntryId).toBeUndefined();
  });

  it('carries trimmed receipt names onto the installed copy', () => {
    const entries = project([
      makeReceiptedSkill('review-helper', {
        remoteId: 'share-1',
        sharedByName: '  Ada  ',
        ownerName: 'Northwind ',
        teamName: ' Platform ',
      }),
    ]);

    expect(
      entries.find((entry) => entry.id === 'skill:custom:app:review-helper'),
    ).toMatchObject({
      custom: true,
      installedFrom: {
        sharedByName: 'Ada',
        ownerName: 'Northwind',
        teamName: 'Platform',
      },
    });
  });

  it('records a receipt with no names as an empty attribution', () => {
    const entry = buildInstalledSkillEntry(
      makeReceiptedSkill('review-helper', { remoteId: 'share-1' }),
    );

    expect(entry.installedFrom).toEqual({});
  });

  it('gives a receipt-less or built-in skill no attribution', () => {
    expect(
      buildInstalledSkillEntry(makeReceiptedSkill('mine', undefined))
        .installedFrom,
    ).toBeUndefined();
    expect(
      buildInstalledSkillEntry(
        makeReceiptedSkill(
          'bundled',
          { remoteId: 'share-1', sharedByName: 'Ada' },
          { builtIn: true },
        ),
      ).installedFrom,
    ).toBeUndefined();
  });
});

describe('buildUnifiedPluginEntries — public links on shared entries (CAN-5220)', () => {
  const LINK_CREATED = '2026-09-26T12:00:00.000Z';
  interface PublicLinkFixture {
    externalId: string;
    pinnedContentHash: string;
    pinnedRefKey: string;
    upToDate: boolean;
    sharePath: string;
    createdAt: string;
    updatedAt: string;
  }
  function link(upToDate = true): PublicLinkFixture {
    return {
      externalId: 'link-1',
      pinnedContentHash: 'hash',
      pinnedRefKey: 'plugin:acme/tools:deploy',
      upToDate,
      sharePath: '/share/link-1',
      createdAt: LINK_CREATED,
      updatedAt: LINK_CREATED,
    };
  }
  const base = {
    shareScope: 'organization',
    owner: { type: 'organization', id: 'org-1', name: 'Northwind' },
    createdBy: { id: 'viewer', name: 'Viewer', email: null },
    createdAt: '2026-10-12T00:00:00.000Z',
    updatedAt: '2026-10-12T00:00:00.000Z',
    canUpdate: true,
    canDelete: true,
  } as const;
  function skill(
    id: string,
    publicShare: PublicLinkFixture | null,
  ): SharedSkillSummary {
    return {
      ...base,
      id,
      name: `skill-${id}`,
      description: '',
      contentHash: 'hash',
      publicShare,
    };
  }
  function collection(
    id: string,
    publicShare?: PublicLinkFixture | null,
  ): SharedCollectionSummary {
    return {
      ...base,
      id,
      name: `collection-${id}`,
      description: '',
      contentHash: 'hash',
      itemCounts: { skills: 1, plugins: 0, customSkills: 0 },
      publicShare,
    };
  }
  function agent(
    id: string,
    publicShare?: PublicLinkFixture | null,
  ): SharedAgentSummary {
    return {
      ...base,
      id,
      name: `agent-${id}`,
      modelId: 'agent_model_1',
      baseModel: 'claude-sonnet',
      instructionsPreview: '',
      contentHash: 'hash',
      publicShare,
    };
  }
  function plugin(
    externalId: string,
    publicShare?: PublicLinkFixture | null,
  ): SharedPluginSummary {
    return {
      ...base,
      externalId,
      refKey: 'plugin:acme/tools:deploy',
      ref: {
        type: 'plugin',
        marketplace: { type: 'github', repo: 'acme/tools' },
        plugin_name: 'deploy',
      },
      name: 'Deploy tools',
      description: null,
      marketplaceOrigin: 'acme/tools',
      publicShare,
    };
  }
  function project(
    overrides: Partial<UnifiedEntryInputs>,
  ): UnifiedPluginEntry[] {
    return buildUnifiedPluginEntries(
      emptyInputs({ viewerId: 'viewer', ...overrides }),
    );
  }
  const byId = (
    entries: UnifiedPluginEntry[],
    id: string,
  ): UnifiedPluginEntry | undefined => entries.find((entry) => entry.id === id);

  it('projects the link date and freshness for every kind that reports one', () => {
    const entries = project({
      sharedSkills: [skill('s1', link())],
      sharedCollections: [collection('c1', link(false))],
      sharedAgents: [agent('a1', link())],
      sharedPlugins: [plugin('p1', link(false))],
      sharedAutomations: [
        makeSharedAutomation({
          id: 'au1',
          createdBy: { id: 'viewer', name: 'Viewer', email: null },
          publicShare: link(),
        }),
      ],
    });
    expect(byId(entries, 'skill:shared:s1')?.publicShare).toEqual({
      since: LINK_CREATED,
      upToDate: true,
    });
    expect(byId(entries, 'collection:shared:c1')?.publicShare).toEqual({
      since: LINK_CREATED,
      upToDate: false,
    });
    expect(byId(entries, 'agent:shared:a1')?.publicShare).toEqual({
      since: LINK_CREATED,
      upToDate: true,
    });
    expect(byId(entries, 'plugin:shared:p1')?.publicShare).toEqual({
      since: LINK_CREATED,
      upToDate: false,
    });
    expect(byId(entries, 'automation:shared:au1')?.publicShare).toEqual({
      since: LINK_CREATED,
      upToDate: true,
    });
  });

  it('leaves null, absent and blueprint shares without a public link', () => {
    const entries = project({
      sharedSkills: [skill('s1', null)],
      sharedCollections: [collection('c1')],
      sharedAgents: [agent('a1', null)],
      sharedPlugins: [plugin('p1')],
      sharedAutomations: [makeSharedAutomation({ publicShare: null })],
      sharedBlueprints: [
        {
          externalId: 'bp1',
          sharePath: '/share/project-templates/bp1',
          pinnedContentHash: 'hash',
          name: 'Launch plan',
          description: '',
          audience: 'ORGANIZATION',
          owner: base.owner,
          createdBy: { id: 'viewer', name: 'Viewer' },
          createdAt: base.createdAt,
          updatedAt: base.updatedAt,
        },
      ],
    });
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry.publicShare).toBeUndefined();
  });

  it('keeps public-link presence when a runtime summary has no link metadata', () => {
    const summary = skill('s1', link());
    // Older/incomplete runtime data can omit metadata despite the full wire DTO.
    Reflect.set(summary, 'publicShare', {});
    const entry = byId(project({ sharedSkills: [summary] }), 'skill:shared:s1');
    expect(entry?.publicShare).toEqual({});
    expect(entry && sharedByMeLine(entry)?.publicLink).toBe(true);
  });

  it('clears the link on the next projection once the summary loses it', () => {
    expect(
      byId(project({ sharedSkills: [skill('s1', link())] }), 'skill:shared:s1')
        ?.publicShare,
    ).toBeDefined();
    const refreshed = byId(
      project({ sharedSkills: [skill('s1', null)] }),
      'skill:shared:s1',
    );
    expect(refreshed?.publicShare).toBeUndefined();
    expect(refreshed?.isShared).toBe(true);
  });

  it('does not confuse an owner with an audience on public-only shares of any kind', () => {
    const entries = project({
      sharedSkills: [{ ...skill('s1', link()), shareScope: 'private' }],
      sharedCollections: [
        { ...collection('c1', link()), shareScope: 'private' },
      ],
      sharedAgents: [{ ...agent('a1', link()), shareScope: 'private' }],
      sharedPlugins: [{ ...plugin('p1', link()), shareScope: 'private' }],
      sharedAutomations: [
        makeSharedAutomation({
          id: 'au1',
          owner: base.owner,
          shareScope: 'private',
          createdBy: base.createdBy,
          publicShare: link(false),
        }),
      ],
    });
    const shared = entries.filter((entry) => entry.origin === 'shared');
    expect(shared).toHaveLength(5);
    for (const entry of shared) {
      expect(entry.ownedByViewer).toBe(true);
      expect(entry.isShared).toBe(true);
      expect(entry.sharedWith).toBeUndefined();
      expect(entry.sharedSince).toBeUndefined();
      expect(sharedByMeLine(entry)).toEqual({
        publicLink: true,
        publicLinkTitle: 'Public link · Since Sep 26',
      });
    }
  });

  it('keeps the link on its own kind and off installed counterparts', () => {
    const entries = project({
      sharedSkills: [skill('same', link())],
      sharedAgents: [agent('same', null)],
      installedSkills: [
        makeSkill({
          name: 'local-copy',
          remote: {
            accountId: 'viewer',
            remoteId: 'same',
            contentHash: 'hash',
            shareScope: 'organization',
            sharedAt: 'now',
          },
        }),
      ],
    });
    expect(byId(entries, 'skill:shared:same')?.publicShare).toBeDefined();
    expect(byId(entries, 'agent:shared:same')?.publicShare).toBeUndefined();
    expect(
      entries
        .filter((entry) => entry.origin !== 'shared')
        .some((entry) => entry.publicShare !== undefined),
    ).toBe(false);
  });

  it.each([
    ['account only', 'organization', null],
    ['account and public link', 'organization', link()],
    ['public link only', 'private', link()],
    ['stale public link', 'organization', link(false)],
  ] as const)(
    'agrees with the detail card on the public audience: %s',
    (_label, shareScope, publicShare) => {
      const share = { ...skill('s1', publicShare), shareScope };
      const entry = byId(project({ sharedSkills: [share] }), 'skill:shared:s1');
      const listShowsLink = entry
        ? (sharedByMeLine(entry)?.publicLink ?? false)
        : false;
      const detailPublicRows =
        sharedByYouAudienceCount(share, null) -
        sharedByYouAudienceCount({ ...share, publicShare: null }, null);
      expect(listShowsLink).toBe(detailPublicRows === 1);
      expect(listShowsLink).toBe(publicShare !== null);
      const detail = sharedByYouAudiences(share, null, {
        deleteShare: { available: false, reason: 'Test' },
        revokePublicLink: { available: false, reason: 'Test' },
      });
      const account = detail.find((audience) => audience.id === 'account');
      expect(entry?.sharedWith?.name).toBe(account?.name);
      expect(entry?.sharedSince).toBe(account?.sinceIso);
    },
  );
});
