import type { CollectionConfigFile } from '@canopy/desktop-shared/types/collections';
import { ResourceContextUnavailableError } from '../../lib/resource-context-error';

let mockCopilotHarnessEnabled = false;
jest.mock('../../copilot/feature-flag', () => ({
  isCopilotHarnessEnabled: (): boolean => mockCopilotHarnessEnabled,
}));
jest.mock('../../cursor/feature-flag', () => ({
  isCursorHarnessEnabled: (): boolean => true,
}));
jest.mock('../../opencode/feature-flag', () => ({
  isOpenCodeHarnessEnabled: (): boolean => true,
}));
jest.mock('../../mcp/connection-status', () => ({
  listMcpServerStatuses: jest.fn(() => Promise.resolve([])),
}));
import { listMcpServerStatuses } from '../../mcp/connection-status';
/**
 * Service tests for the read-only portal Plugins-section browse builders
 * (design: docs/planning/2026-08-27-portal-plugins-section/design.md, PR 3).
 * All inventory readers are mocked; the tests pin the security-relevant
 * behavior: cache-only marketplace reads (never the refresh-capable loader),
 * MCP secret redaction, body truncation, and identifier validation before any
 * path-based read.
 */
jest.mock('node:fs/promises', () => ({
  readFile: jest.fn(),
}));
jest.mock('../../lib/paths', () => ({
  getMcpServersIndexFilePath: jest.fn(() => '/mock/mcp-servers/index.json'),
}));
jest.mock('../../plugins/plugin-service', () => ({
  loadMarketplaces: jest.fn(),
  loadMarketplacesCacheOnly: jest.fn(),
  readComponentContent: jest.fn(),
}));
jest.mock('../../skills/skill-service', () => ({
  loadSkills: jest.fn(),
  readSkillContent: jest.fn(),
  readRawSkill: jest.fn(),
  writeSkillRemoteMetadata: jest.fn(),
}));
const mockFilterStoredSkillContexts = jest.fn();
const mockFilterPersonalStoredSkills = jest.fn();
const mockAnnotateSharedSkillInstalls = jest.fn();
jest.mock('../../skills/skill-install-context', () => ({
  annotateSharedSkillInstalls: (...args: unknown[]): unknown =>
    mockAnnotateSharedSkillInstalls(...args),
  assertStoredSkillContext: jest.fn(),
  filterStoredSkillContexts: (...args: unknown[]): unknown =>
    mockFilterStoredSkillContexts(...args),
  filterPersonalStoredSkills: (...args: unknown[]): unknown =>
    mockFilterPersonalStoredSkills(...args),
}));
jest.mock('../../skills/canopy-server-client', () => ({
  assertSharedSkillsSupported: jest.fn(),
  createSharedSkill: jest.fn(),
  deleteSharedSkill: jest.fn(),
  getSharedSkill: jest.fn(),
  publishSkillPublicShare: jest.fn(),
  updateSharedSkill: jest.fn(),
}));
jest.mock('../../pipelines/canopy-server-client', () => ({
  listSharedTeams: jest.fn(),
  listSharedOrganizations: jest.fn(),
}));
jest.mock('../../lib/canopy-cloud-account-store', () => ({
  loadCanopyCloudAccountPublicState: jest.fn(),
  subscribeCanopyCloudAccountChanges: jest.fn(() => jest.fn()),
}));
jest.mock('../../lib/resource-context', () => ({
  resourceContextEnabled: jest.fn(() => false),
  resourceContextSnapshot: jest.fn(() => Promise.resolve('snapshot')),
  assertResourceContextSnapshot: jest.fn(() => Promise.resolve()),
}));
jest.mock(
  '../../collections/canopy-server-client',
  (): {
    createSharedCollection: jest.Mock;
    deleteSharedCollection: jest.Mock;
    getSharedCollection: jest.Mock;
    updateSharedCollection: jest.Mock;
    publishCollectionPublicShare: jest.Mock;
    revokeCollectionPublicShare: jest.Mock;
  } => ({
    createSharedCollection: jest.fn(),
    deleteSharedCollection: jest.fn(),
    getSharedCollection: jest.fn(),
    updateSharedCollection: jest.fn(),
    publishCollectionPublicShare: jest.fn(),
    revokeCollectionPublicShare: jest.fn(),
  }),
);
jest.mock('../../collections/collection-store', () => {
  const mockCollectionSnapshot = jest.fn<
    Promise<CollectionConfigFile | null>,
    [string]
  >();
  return {
    readCollectionIndex: jest.fn(),
    readCollectionConfig: mockCollectionSnapshot,
    readLocalCollectionSnapshot: mockCollectionSnapshot,
    readPersonalCollectionIndex: jest.fn(),
    readPersonalCollectionConfig: jest.fn(),
    saveCollectionConfig: jest.fn(),
    writeCollectionRemoteMetadata: jest.fn(),
  };
});
jest.mock('../../plugins/canopy-server-client', () => ({
  assertSharedPluginsSupported: jest.fn(),
  createSharedPlugin: jest.fn(),
  publishPluginPublicShare: jest.fn(),
  updateSharedPlugin: jest.fn(),
  revokePluginPublicShare: jest.fn(),
}));
jest.mock('../../ipc/mcp-servers', () => ({
  readServer: jest.fn(),
  resolveStandaloneHttpHandler: jest.fn(() => Promise.resolve('canopy')),
}));
jest.mock('../../mcp/provider-connectors', () => ({
  listAdvertisedProviderConnectors: jest.fn().mockResolvedValue([]),
}));
import { listAdvertisedProviderConnectors } from '../../mcp/provider-connectors';
jest.mock('../../mcp/account-catalog', () => ({
  loadAccountMcpRefConnections: jest.fn(),
}));

import { listSharedTeams } from '../../pipelines/canopy-server-client';
import {
  createSharedCollection,
  publishCollectionPublicShare,
  revokeCollectionPublicShare,
  getSharedCollection,
  updateSharedCollection,
} from '../../collections/canopy-server-client';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadCanopyCloudAccountPublicState } from '../../lib/canopy-cloud-account-store';
import { resourceContextEnabled } from '../../lib/resource-context';
import {
  assertSharedSkillsSupported,
  createSharedSkill,
  deleteSharedSkill,
  getSharedSkill,
  publishSkillPublicShare,
  updateSharedSkill,
} from '../../skills/canopy-server-client';
import {
  PORTAL_CATALOG_CONTENT_MAX_BYTES,
  PORTAL_CATALOG_RESULT_MAX_BYTES,
} from '@canopy/desktop-shared/types';
import { stableStringify } from '@canopy/protocol/desktop-inventory';
import type { MarketplaceInfo } from '@canopy/desktop-shared/types/plugins';
import { shareablePluginSourceLabel } from '@canopy/desktop-shared/plugin-refs';
import type {
  SharedPluginDetail,
  SharedPluginPublicShareInfo,
} from '@canopy/protocol/plugins';
import type { CanopyOrganizationSummary } from '@canopy/protocol/pipelines';
import type { McpServerFile } from '@canopy/desktop-shared/types/mcp-servers';
import {
  getPortalCollection,
  savePortalCollection,
  getPortalMcpServer,
  getPortalPluginDetail,
  isPortalMcpServerId,
  listPortalCollections,
  listPersonalPortalCollections,
  listPortalMarketplaces,
  listPortalMcpServers,
  listPortalSkills,
  listPersonalPortalSkills,
  sharePortalSkill,
  sharePortalCollection,
  getPortalSharingAccount,
  getPortalExistingCollectionShare,
  getPortalExistingSkillShare,
  listPortalShareTeams,
  readPortalPluginComponent,
  readPortalSkill,
  sharePortalPlugin,
} from '../plugin-catalog-service';
import {
  loadMarketplaces,
  loadMarketplacesCacheOnly,
  readComponentContent,
} from '../../plugins/plugin-service';
import {
  loadSkills,
  readRawSkill,
  readSkillContent,
  writeSkillRemoteMetadata,
} from '../../skills/skill-service';
import {
  BUILTIN_SOURCE_ID,
  CUSTOM_SOURCE_ID,
  deriveSourceId,
} from '../../skills/paths';
import {
  readCollectionConfig,
  readCollectionIndex,
  readPersonalCollectionConfig,
  readPersonalCollectionIndex,
  saveCollectionConfig,
  writeCollectionRemoteMetadata,
} from '../../collections/collection-store';
import { readServer } from '../../ipc/mcp-servers';
import { loadAccountMcpRefConnections } from '../../mcp/account-catalog';
import type { AccountMcpConnection } from '@canopy/desktop-shared/types/mcp-servers';
import {
  assertSharedPluginsSupported,
  createSharedPlugin,
  publishPluginPublicShare,
  updateSharedPlugin,
  revokePluginPublicShare,
} from '../../plugins/canopy-server-client';
import { pinOrgProjectsFlagOff } from '../../__tests__/helpers/org-projects-flag';

// This suite covers the legacy (context-free) resource paths.
beforeEach(() => {
  pinOrgProjectsFlagOff();
  jest.mocked(loadAccountMcpRefConnections).mockResolvedValue(null);
  jest.mocked(resourceContextEnabled).mockReturnValue(false);
});

const mockedListMcpStatuses = jest.mocked(listMcpServerStatuses);
const mockedCreateSharedCollection = jest.mocked(createSharedCollection);
const mockedListSharedTeams = jest.mocked(listSharedTeams);
const mockedGetSharedCollection = jest.mocked(getSharedCollection);
const mockedUpdateSharedCollection = jest.mocked(updateSharedCollection);
const mockedWriteCollectionRemoteMetadata = jest.mocked(
  writeCollectionRemoteMetadata,
);
const mockedReadFile = jest.mocked(readFile);
const mockedAssertSharedPluginsSupported = jest.mocked(
  assertSharedPluginsSupported,
);
const mockedCreateSharedPlugin = jest.mocked(createSharedPlugin);
const mockedPublishPublicShare = jest.mocked(publishPluginPublicShare);
const mockedLoadMarketplaces = jest.mocked(loadMarketplaces);
const mockedLoadCacheOnly = jest.mocked(loadMarketplacesCacheOnly);
const mockedReadComponentContent = jest.mocked(readComponentContent);
const mockedLoadSkills = jest.mocked(loadSkills);
const mockedReadSkillContent = jest.mocked(readSkillContent);
const mockedReadRawSkill = jest.mocked(readRawSkill);
const mockedLoadAccountPublicState = jest.mocked(
  loadCanopyCloudAccountPublicState,
);
const mockedAssertSharedSkillsSupported = jest.mocked(
  assertSharedSkillsSupported,
);
const mockedCreateSharedSkill = jest.mocked(createSharedSkill);
const mockedDeleteSharedSkill = jest.mocked(deleteSharedSkill);
const mockedGetSharedSkill = jest.mocked(getSharedSkill);
const mockedPublishSkillPublicShare = jest.mocked(publishSkillPublicShare);
const mockedUpdateSharedSkill = jest.mocked(updateSharedSkill);
const mockedWriteSkillRemoteMetadata = jest.mocked(writeSkillRemoteMetadata);
const mockedReadCollectionConfig = jest.mocked(readCollectionConfig);
const mockedReadCollectionIndex = jest.mocked(readCollectionIndex);
const mockedSaveCollectionConfig = jest.mocked(saveCollectionConfig);
const mockedReadPersonalCollectionConfig = jest.mocked(
  readPersonalCollectionConfig,
);
const mockedReadPersonalCollectionIndex = jest.mocked(
  readPersonalCollectionIndex,
);
const mockedReadServer = jest.mocked(readServer);
const mockedLoadAccountConnections = jest.mocked(loadAccountMcpRefConnections);

const CUSTOM_ID = 'custom:3f2b6c1e-8d4a-4b7e-9c2f-1a5d6e7f8a9b';

function accountConnection(
  overrides: Partial<AccountMcpConnection> = {},
): AccountMcpConnection {
  return {
    id: 'conn-1',
    serverKey: CUSTOM_ID,
    configId: 'default',
    displayName: 'Internal Staging Hub',
    status: 'CONNECTED',
    routeId: 'route-secret-1',
    enabledTools: null,
    kind: 'CUSTOM',
    authMode: 'OAUTH',
    upstreamHost: 'hub.example.test',
    hasExtraHeaders: true,
    ...overrides,
  };
}

const providerStatus = {
  claude: {
    provider: 'claude' as const,
    state: 'valid' as const,
    accepted: true,
    pluginCount: 1,
    lastCheckedAt: '2026-08-27T00:00:00.000Z',
    marketplacePath: '/secret/claude/manifest.json',
    installLocation: '/secret/claude/install',
  },
  codex: {
    provider: 'codex' as const,
    state: 'invalid' as const,
    accepted: false,
    pluginCount: 0,
    lastCheckedAt: '2026-08-27T00:00:00.000Z',
    error: 'not supported',
  },
};

function payloadHash(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

const marketplace: MarketplaceInfo = {
  id: 'mkt',
  name: 'Marketplace',
  description: 'desc',
  sourceType: 'github',
  // Credentials in userinfo/query/fragment must never cross the boundary.
  sourceUrl:
    'https://mp-user:mp-source-secret@github.com/acme/marketplace?token=mp-query-secret#mp-frag-secret',
  installLocation: '/secret/local/marketplace',
  pluginCount: 1,
  plugins: [
    {
      name: 'plugin',
      description: 'desc',
      version: '1.0.0',
      sourcePath: 'plugins/plugin',
      marketplaceId: 'mkt',
      cachePath: '/secret/local/cache/plugin',
      homepage:
        'https://home-user:home-userinfo-secret@plugin.example/docs?tok=home-query-secret#home-frag',
      providerSupport: { claude: 'native', codex: 'none' },
      facets: {},
      details: {
        skills: [
          { name: 'review', description: 'd', path: 'skills/review/SKILL.md' },
        ],
        agents: [],
        commands: [],
        hooks: [],
        mcpServers: [
          {
            name: 'embedded',
            type: 'http',
            url: 'https://mcp-user:mcp-url-secret@mcp.example/sse?key=mcp-query-secret',
          },
        ],
        lspServers: [],
        hasReadme: true,
      },
    },
  ],
  providerStatus,
  validProviders: ['claude'],
};

/**
 * The default fixture carries a credentialed source URL to prove sanitization;
 * that URL is not a parseable GitHub repo, so shareability needs a marketplace
 * with the plain URL a real cache holds.
 */
function primeShareableMarketplaceCache(): void {
  mockedLoadCacheOnly.mockResolvedValue({
    success: true,
    data: {
      version: 2,
      lastRefreshed: '2026-08-27T00:00:00.000Z',
      marketplaces: [
        marketplace,
        {
          ...marketplace,
          id: 'mkt-share',
          sourceUrl: 'https://github.com/acme/marketplace',
          plugins: marketplace.plugins.map((plugin) => ({
            ...plugin,
            marketplaceId: 'mkt-share',
          })),
        },
      ],
    },
  });
}

function primeMarketplaceCache(): void {
  mockedLoadCacheOnly.mockResolvedValue({
    success: true,
    data: {
      version: 2,
      lastRefreshed: '2026-08-27T00:00:00.000Z',
      marketplaces: [marketplace],
    },
  });
}

describe('portal plugin browse service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFilterStoredSkillContexts.mockImplementation((rows) =>
      Promise.resolve(rows),
    );
    mockAnnotateSharedSkillInstalls.mockImplementation((rows) =>
      Promise.resolve(rows),
    );
    mockedWriteCollectionRemoteMetadata.mockResolvedValue(true);
    mockedLoadAccountPublicState.mockResolvedValue({
      read: 'ok',
      hasApiKey: true,
      authMode: null,
      credentialSource: null,
      capabilities: [],
      account: {
        id: 'account-1',
        name: 'Test account',
        email: 'test@example.com',
        role: 'DEVELOPER',
      },
      storageAvailable: true,
    });
  });

  it('includes each team target owning organization id', async () => {
    mockedListSharedTeams.mockResolvedValue({
      data: [
        {
          id: 'team-1',
          name: 'Platform',
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
          organization: {
            id: 'org-1',
            name: 'Acme',
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z',
          },
        },
      ],
    });

    await expect(listPortalShareTeams(undefined)).resolves.toEqual({
      targets: [
        {
          id: 'team-1',
          name: 'Platform',
          organizationId: 'org-1',
          secondaryLabel: 'Acme',
        },
      ],
    });
  });

  describe('sharePortalPlugin', () => {
    function existingPlugin(
      scope: 'private' | 'team' | 'organization',
    ): SharedPluginDetail {
      return {
        externalId: 'ext-1',
        shareScope: scope,
        createdBy: { id: 'account-1', name: null },
        owner:
          scope === 'team'
            ? {
                type: 'team',
                id: 'old-team',
                name: 'Old team',
                organization: { id: 'org-1', name: 'Org' },
              }
            : scope === 'organization'
              ? { type: 'organization', id: 'old-org', name: 'Old org' }
              : { type: 'user', id: 'account-1', name: null },
        refKey: 'claude_plugin:github:acme/marketplace:plugin',
        ref: {
          type: 'claude_plugin',
          marketplace: { type: 'github', repo: 'acme/marketplace' },
          plugin_name: 'plugin',
        },
        name: 'Plugin',
        description: 'desc',
        marketplaceOrigin: 'github:acme/marketplace',
        createdAt: '2026-08-27T00:00:00.000Z',
        updatedAt: '2026-08-27T00:00:00.000Z',
      };
    }

    it.each(['team', 'organization'] as const)(
      'moves %s plugin ownership to Private before Public publication',
      async (scope) => {
        primeShareableMarketplaceCache();
        const previous = existingPlugin(scope);
        mockedCreateSharedPlugin.mockResolvedValue(previous);
        jest
          .mocked(updateSharedPlugin)
          .mockResolvedValue(existingPlugin('private'));
        mockedPublishPublicShare.mockResolvedValue({
          externalId: 'public-1',
          pinnedRefKey: previous.refKey,
          upToDate: true,
          sharePath: '/portal/plugins/plugins/shared/public-1',
          createdAt: 'c',
          updatedAt: 'u',
        });
        await sharePortalPlugin({
          marketplaceId: 'mkt-share',
          pluginName: 'plugin',
          scope: 'public',
        });
        expect(jest.mocked(updateSharedPlugin)).toHaveBeenCalledWith(
          expect.objectContaining({ remoteId: 'ext-1', shareScope: 'private' }),
        );
        expect(
          jest.mocked(updateSharedPlugin).mock.invocationCallOrder[0],
        ).toBeLessThan(mockedPublishPublicShare.mock.invocationCallOrder[0]);
      },
    );

    it.each(['team', 'organization'] as const)(
      'removes a public plugin link before changing to %s',
      async (scope) => {
        primeShareableMarketplaceCache();
        const previous = existingPlugin('private');
        previous.publicShare = {
          externalId: 'public-1',
          pinnedRefKey: previous.refKey,
          upToDate: true,
          sharePath: '/portal/plugins/plugins/shared/public-1',
          createdAt: 'c',
          updatedAt: 'u',
        };
        mockedCreateSharedPlugin.mockResolvedValue(previous);
        jest
          .mocked(updateSharedPlugin)
          .mockResolvedValue(existingPlugin(scope));
        await sharePortalPlugin({
          marketplaceId: 'mkt-share',
          pluginName: 'plugin',
          scope,
          teamId: 'new-team',
          organizationId: 'new-org',
        });
        expect(jest.mocked(revokePluginPublicShare)).toHaveBeenCalledWith(
          'ext-1',
        );
        expect(
          jest.mocked(revokePluginPublicShare).mock.invocationCallOrder[0],
        ).toBeLessThan(
          jest.mocked(updateSharedPlugin).mock.invocationCallOrder[0],
        );
      },
    );

    it('does not change the plugin owner when public revocation fails', async () => {
      primeShareableMarketplaceCache();
      const previous = existingPlugin('private');
      previous.publicShare = {
        externalId: 'public-1',
        pinnedRefKey: previous.refKey,
        upToDate: true,
        sharePath: '/portal/plugins/plugins/shared/public-1',
        createdAt: 'c',
        updatedAt: 'u',
      };
      mockedCreateSharedPlugin.mockResolvedValue(previous);
      jest
        .mocked(revokePluginPublicShare)
        .mockRejectedValue(new Error('Revoke failed'));
      jest.mocked(updateSharedPlugin).mockResolvedValue(existingPlugin('team'));
      await expect(
        sharePortalPlugin({
          marketplaceId: 'mkt-share',
          pluginName: 'plugin',
          scope: 'team',
          teamId: 'new-team',
        }),
      ).rejects.toThrow('Revoke failed');
      expect(jest.mocked(updateSharedPlugin)).not.toHaveBeenCalled();
    });

    it('changes the selected team even when the plugin was already shared with a team', async () => {
      primeShareableMarketplaceCache();
      mockedCreateSharedPlugin.mockResolvedValue(existingPlugin('team'));
      jest.mocked(updateSharedPlugin).mockResolvedValue(existingPlugin('team'));
      await sharePortalPlugin({
        marketplaceId: 'mkt-share',
        pluginName: 'plugin',
        scope: 'team',
        teamId: 'new-team',
      });
      expect(jest.mocked(updateSharedPlugin)).toHaveBeenCalledWith(
        expect.objectContaining({ shareScope: 'team', teamId: 'new-team' }),
      );
    });
    it('creates the shared plugin in Cloud and publishes its public share', async () => {
      primeShareableMarketplaceCache();
      const created: SharedPluginDetail = {
        owner: { type: 'user', id: 'account-1', name: null },
        shareScope: 'private',
        createdBy: { id: 'account-1', name: null },
        externalId: 'ext-1',
        refKey: 'claude_plugin:github:acme/marketplace:plugin',
        ref: {
          type: 'claude_plugin',
          marketplace: { type: 'github', repo: 'acme/marketplace' },
          plugin_name: 'plugin',
        },
        name: 'Plugin',
        description: 'desc',
        marketplaceOrigin: 'github:acme/marketplace',
        createdAt: '2026-08-27T00:00:00.000Z',
        updatedAt: '2026-08-27T00:00:00.000Z',
      };
      const published: SharedPluginPublicShareInfo = {
        externalId: 'share-1',
        pinnedRefKey: created.refKey,
        upToDate: true,
        sharePath: '/portal/plugins/plugins/shared/abc',
        createdAt: '2026-08-27T00:00:00.000Z',
        updatedAt: '2026-08-27T00:00:00.000Z',
      };
      mockedCreateSharedPlugin.mockResolvedValue(created);
      mockedPublishPublicShare.mockResolvedValue(published);

      const result = await sharePortalPlugin({
        marketplaceId: 'mkt-share',
        pluginName: 'plugin',
        scope: 'public',
      });

      expect(mockedCreateSharedPlugin).toHaveBeenCalledTimes(1);
      const createRequest = mockedCreateSharedPlugin.mock.calls[0][0];
      expect(createRequest.serverId).toBe('canopy-cloud');
      // The display name the desktop modal publishes, not the slug.
      expect(createRequest.name).toBe('Plugin');
      expect(createRequest.ref).toEqual({
        type: 'claude_plugin',
        marketplace: { type: 'github', repo: 'acme/marketplace' },
        plugin_name: 'plugin',
      });
      expect(mockedPublishPublicShare).toHaveBeenCalledWith('ext-1');
      // Capability negotiation runs before any Cloud call, as the IPC path does.
      expect(mockedAssertSharedPluginsSupported).toHaveBeenCalledTimes(1);
      expect(
        mockedAssertSharedPluginsSupported.mock.invocationCallOrder[0],
      ).toBeLessThan(mockedCreateSharedPlugin.mock.invocationCallOrder[0]);
      expect(result).toEqual({
        sharePath: '/portal/plugins/plugins/shared/abc',
      });
    });

    it('fails through capability negotiation when Cloud lacks plugins-crud-v1', async () => {
      primeShareableMarketplaceCache();
      mockedAssertSharedPluginsSupported.mockRejectedValue(
        new Error('Shared plugins are not supported by this Cloud.'),
      );
      await expect(
        sharePortalPlugin({
          marketplaceId: 'mkt-share',
          pluginName: 'plugin',
          scope: 'public',
        }),
      ).rejects.toThrow('not supported');
      expect(mockedCreateSharedPlugin).not.toHaveBeenCalled();
      expect(mockedPublishPublicShare).not.toHaveBeenCalled();
    });

    it('rejects a plugin that is not in the marketplace cache', async () => {
      primeShareableMarketplaceCache();
      await expect(
        sharePortalPlugin({
          marketplaceId: 'mkt-share',
          pluginName: 'missing',
          scope: 'public',
        }),
      ).rejects.toThrow('no longer in the marketplace cache');
      expect(mockedCreateSharedPlugin).not.toHaveBeenCalled();
    });

    it('rejects a plugin whose marketplace has no shareable source', async () => {
      primeShareableMarketplaceCache();
      await expect(
        sharePortalPlugin({
          marketplaceId: 'mkt',
          pluginName: 'plugin',
          scope: 'public',
        }),
      ).rejects.toThrow('This plugin has no public source to share.');
      expect(mockedCreateSharedPlugin).not.toHaveBeenCalled();
    });
  });

  describe('listPortalMarketplaces', () => {
    it('reads ONLY the cache and never the refresh-capable loader', async () => {
      primeMarketplaceCache();
      const result = await listPortalMarketplaces();

      expect(mockedLoadCacheOnly).toHaveBeenCalledTimes(1);
      expect(mockedLoadMarketplaces).not.toHaveBeenCalled();
      expect(result.lastRefreshed).toBe('2026-08-27T00:00:00.000Z');
      expect(result.marketplaces).toHaveLength(1);
      expect(result.marketplaces[0].plugins[0]).toMatchObject({
        name: 'plugin',
        marketplaceId: 'mkt',
        installed: true,
      });
    });

    // CAN-2829: the browser shows the Share affordances the desktop shows, so
    // shareability is decided here from the same rule the desktop Marketplace
    // applies (a GitHub-sourced marketplace plugin is shareable).
    it('flags plugins the desktop can share, and only those', async () => {
      primeShareableMarketplaceCache();
      const result = await listPortalMarketplaces();
      // Credentialed URL: not a parseable GitHub source, so not shareable.
      expect(result.marketplaces[0].plugins[0].shareable).toBeUndefined();
      expect(result.marketplaces[1].plugins[0].shareable).toBe(true);
      // The label the share dialog shows as the public source is computed
      // here from the same ref that gets published (review on #3132).
      expect(result.marketplaces[1].plugins[0].shareSourceLabel).toBe(
        shareablePluginSourceLabel({
          type: 'claude_plugin',
          marketplace: { type: 'github', repo: 'acme/marketplace' },
          plugin_name: 'plugin',
        }),
      );
    });

    it('projects the canonical reference key for shared-plugin owner matching', async () => {
      primeShareableMarketplaceCache();
      const result = await listPortalMarketplaces();
      expect(result.marketplaces[1].plugins[0].sharing).toHaveProperty(
        'target.refKey',
        'claude_plugin:github:acme/marketplace:plugin',
      );
    });

    it('projects a target or an explicit blocked reason regardless of installation', async () => {
      primeShareableMarketplaceCache();
      const cached = await mockedLoadCacheOnly();
      if (!cached.success || !cached.data) throw new Error('Missing fixture');
      const shareable = cached.data.marketplaces[1];
      shareable.plugins[0].cachePath = undefined;
      mockedLoadCacheOnly.mockResolvedValue(cached);
      const result = await listPortalMarketplaces();
      expect(result.marketplaces[0].plugins[0]).toHaveProperty('sharing', {
        status: 'blocked',
        reason: 'This plugin has no public source to share.',
      });
      expect(result.marketplaces[1].plugins[0]).toMatchObject({
        installed: false,
        sharing: {
          status: 'shareable',
          target: {
            kind: 'plugin',
            marketplaceId: 'mkt-share',
            pluginName: 'plugin',
            displayName: 'Plugin',
            sourceLabel: 'github:acme/marketplace',
            refKey: 'claude_plugin:github:acme/marketplace:plugin',
          },
        },
      });
    });

    it('rejects ambiguous plugin identity before contacting Cloud', async () => {
      primeShareableMarketplaceCache();
      const cached = await mockedLoadCacheOnly();
      if (!cached.success || !cached.data) throw new Error('Missing fixture');
      cached.data.marketplaces[1].plugins.push({
        ...cached.data.marketplaces[1].plugins[0],
      });
      mockedLoadCacheOnly.mockResolvedValue(cached);
      await expect(
        sharePortalPlugin({
          marketplaceId: 'mkt-share',
          pluginName: 'plugin',
          scope: 'public',
        }),
      ).rejects.toThrow('Sharing is unavailable for this item.');
      expect(mockedCreateSharedPlugin).not.toHaveBeenCalled();
      const result = await listPortalMarketplaces();
      expect(result.marketplaces[1].plugins[0]).toHaveProperty('sharing', {
        status: 'blocked',
        reason: 'Sharing is unavailable for this item.',
      });
    });

    it('projects folded parent sharing for curated MCP entries without a connection row', async () => {
      primeMarketplaceCache();
      const cached = await mockedLoadCacheOnly();
      if (!cached.success || !cached.data) throw new Error('Missing fixture');
      cached.data.marketplaces[0] = {
        ...marketplace,
        curated: true,
        sourceUrl: 'https://github.com/acme/marketplace',
      };
      mockedLoadCacheOnly.mockResolvedValue(cached);
      const result = await listPortalMarketplaces();
      expect(result.marketplaces[0].plugins[0]).toHaveProperty('foldedMcp', {
        key: 'embedded',
        sharing: {
          status: 'shareable',
          target: {
            kind: 'plugin',
            marketplaceId: 'mkt',
            pluginName: 'plugin',
            displayName: 'Plugin',
            sourceLabel: 'github:acme/marketplace',
            refKey: 'claude_plugin:github:acme/marketplace:plugin',
          },
        },
      });
      expect(mockedReadFile).not.toHaveBeenCalled();
    });

    it('omits machine-local paths from every row', async () => {
      primeMarketplaceCache();
      const result = await listPortalMarketplaces();
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('/secret/');
      expect(serialized).not.toContain('installLocation');
      expect(serialized).not.toContain('cachePath');
      expect(serialized).not.toContain('sourcePath');
    });

    it('sanitizes credentialed marketplace source URLs', async () => {
      primeMarketplaceCache();
      const result = await listPortalMarketplaces();
      expect(result.marketplaces[0].sourceUrl).toBe(
        'https://github.com/acme/marketplace',
      );
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('mp-source-secret');
      expect(serialized).not.toContain('mp-query-secret');
      expect(serialized).not.toContain('mp-frag-secret');
    });

    it('passes opaque source refs through and strips SSH userinfo', async () => {
      mockedLoadCacheOnly.mockResolvedValue({
        success: true,
        data: {
          version: 2,
          lastRefreshed: '2026-08-27T00:00:00.000Z',
          marketplaces: [
            { ...marketplace, id: 'builtin', sourceUrl: 'builtin:app' },
            { ...marketplace, id: 'plain', sourceUrl: 'acme/marketplace' },
            {
              ...marketplace,
              id: 'ssh',
              sourceUrl: 'git@github.com:acme/marketplace.git',
            },
          ],
        },
      });
      const result = await listPortalMarketplaces();
      const bySource = result.marketplaces.map((row) => row.sourceUrl);
      expect(bySource).toEqual([
        'builtin:app',
        'acme/marketplace',
        'github.com:acme/marketplace.git',
      ]);
    });

    it('returns an empty result when the cache is unavailable', async () => {
      mockedLoadCacheOnly.mockResolvedValue({
        success: false,
        error: 'boom',
      });
      await expect(listPortalMarketplaces()).resolves.toEqual({
        marketplaces: [],
        lastRefreshed: '',
      });
    });

    // CAN-3653: the web joins a plugin to the MCP server it bundles and labels
    // the plugin's publisher, so the row carries endpoints and source URL.
    describe('plugin provenance (CAN-3653)', () => {
      function primeSinglePlugin(
        overrides: Partial<MarketplaceInfo['plugins'][number]>,
      ): void {
        mockedLoadCacheOnly.mockResolvedValue({
          success: true,
          data: {
            version: 2,
            lastRefreshed: '2026-08-27T00:00:00.000Z',
            marketplaces: [
              {
                ...marketplace,
                plugins: [{ ...marketplace.plugins[0], ...overrides }],
              },
            ],
          },
        });
      }

      it('projects bundled MCP server endpoints and the external source URL without credentials', async () => {
        const [basePlugin] = marketplace.plugins;
        if (!basePlugin.details) throw new Error('Missing fixture details');
        primeSinglePlugin({
          externalSource: {
            source: 'url',
            url: 'https://github.com/slackapi/slack-mcp-plugin.git',
          },
          details: {
            ...basePlugin.details,
            mcpServers: [
              {
                name: 'slack',
                type: 'http',
                url: 'https://u:p@mcp.slack.com/mcp?x=1',
              },
              {
                name: 'local',
                type: 'command',
                command: '/bin/x',
                args: ['--token', 's'],
              },
            ],
          },
        });
        const result = await listPortalMarketplaces();
        const row = result.marketplaces[0].plugins[0];
        expect(row.mcpServers).toEqual([
          { name: 'slack', type: 'http', url: 'https://mcp.slack.com/mcp' },
          { name: 'local', type: 'command' },
        ]);
        expect(row.externalSourceUrl).toBe(
          'https://github.com/slackapi/slack-mcp-plugin.git',
        );
        const serialized = JSON.stringify(row);
        expect(serialized).not.toContain('--token');
        expect(serialized).not.toContain('/bin/x');
        expect(serialized).not.toContain('u:p');
        expect(serialized).not.toContain('x=1');
      });

      it('strips credentials from the external source URL', async () => {
        primeSinglePlugin({
          externalSource: {
            source: 'url',
            url: 'https://src-user:src-secret@github.com/acme/plugin.git?t=q#f',
          },
        });
        const result = await listPortalMarketplaces();
        expect(result.marketplaces[0].plugins[0].externalSourceUrl).toBe(
          'https://github.com/acme/plugin.git',
        );
        expect(JSON.stringify(result)).not.toContain('src-secret');
      });

      it('omits a non-http(s) external source URL, keeping host paths out', async () => {
        primeSinglePlugin({
          externalSource: {
            source: 'url',
            url: 'file:///Users/someone/plugins/slack',
          },
        });
        const result = await listPortalMarketplaces();
        const row = result.marketplaces[0].plugins[0];
        expect(row).not.toHaveProperty('externalSourceUrl');
        expect(JSON.stringify(row)).not.toContain('/Users/someone');
      });

      it('omits both fields when details and external source are absent', async () => {
        primeSinglePlugin({ details: null, externalSource: undefined });
        const result = await listPortalMarketplaces();
        const row = result.marketplaces[0].plugins[0];
        expect(row).not.toHaveProperty('mcpServers');
        expect(row).not.toHaveProperty('externalSourceUrl');
      });

      it('omits mcpServers when the plugin bundles none', async () => {
        const [basePlugin] = marketplace.plugins;
        if (!basePlugin.details) throw new Error('Missing fixture details');
        primeSinglePlugin({
          details: { ...basePlugin.details, mcpServers: [] },
        });
        const result = await listPortalMarketplaces();
        expect(result.marketplaces[0].plugins[0]).not.toHaveProperty(
          'mcpServers',
        );
      });

      it('drops an http server whose url does not sanitize', async () => {
        const [basePlugin] = marketplace.plugins;
        if (!basePlugin.details) throw new Error('Missing fixture details');
        primeSinglePlugin({
          externalSource: { source: 'git-subdir', url: 'not a url' },
          details: {
            ...basePlugin.details,
            mcpServers: [
              { name: 'broken', type: 'http', url: 'not a url' },
              { name: 'missing', type: 'http' },
              { name: 'ok', type: 'http', url: 'https://ok.example/mcp' },
            ],
          },
        });
        const result = await listPortalMarketplaces();
        const row = result.marketplaces[0].plugins[0];
        expect(row.mcpServers).toEqual([
          { name: 'ok', type: 'http', url: 'https://ok.example/mcp' },
        ]);
        expect(row).not.toHaveProperty('externalSourceUrl');
      });

      // CAN-4844: the browser lists a plugin's skills under its status.
      it('includes bundled skill names and descriptions without paths', async () => {
        const [basePlugin] = marketplace.plugins;
        if (!basePlugin.details) throw new Error('Missing fixture details');
        primeSinglePlugin({
          details: {
            ...basePlugin.details,
            skills: [
              {
                name: 'summarize-channel',
                description: 'Summarize a channel',
                path: '/Users/someone/plugins/slack/skills/x/SKILL.md',
                userInvocable: false,
              },
            ],
          },
        });
        const result = await listPortalMarketplaces();
        const row = result.marketplaces[0].plugins[0];
        expect(row.skills).toEqual([
          { name: 'summarize-channel', description: 'Summarize a channel' },
        ]);
        expect(row.skills?.[0]).not.toHaveProperty('path');
        expect(JSON.stringify(row)).not.toContain('/Users/someone');
      });

      it('omits skills when the plugin bundles none or details were not fetched', async () => {
        const [basePlugin] = marketplace.plugins;
        if (!basePlugin.details) throw new Error('Missing fixture details');
        primeSinglePlugin({ details: { ...basePlugin.details, skills: [] } });
        const bundlesNone = await listPortalMarketplaces();
        expect(bundlesNone.marketplaces[0].plugins[0]).not.toHaveProperty(
          'skills',
        );
        primeSinglePlugin({ details: null });
        const noDetails = await listPortalMarketplaces();
        expect(noDetails.marketplaces[0].plugins[0]).not.toHaveProperty(
          'skills',
        );
      });

      // The browser lists bundled skills only under an installed plugin, so
      // an uninstalled plugin's skills would only spend the result budget.
      it('omits skills when the plugin is not installed', async () => {
        primeSinglePlugin({
          cachePath: undefined,
          globalInstallStatus: undefined,
        });
        const result = await listPortalMarketplaces();
        const row = result.marketplaces[0].plugins[0];
        expect(row.installed).toBe(false);
        expect(row).not.toHaveProperty('skills');
      });

      it('keeps the real-sized marketplace list under PORTAL_CATALOG_RESULT_MAX_BYTES', async () => {
        // The real cache this ticket was reproduced on: 9 marketplaces, 436
        // plugins in total, each with one bundled http server.
        const [basePlugin] = marketplace.plugins;
        const baseDetails = basePlugin.details;
        if (!baseDetails) throw new Error('Missing fixture details');
        const marketplaceCount = 9;
        const pluginTotal = 436;
        const marketplaces: MarketplaceInfo[] = Array.from(
          { length: marketplaceCount },
          (_, marketplaceIndex) => {
            const id = `market-${marketplaceIndex}`;
            const count =
              Math.floor(pluginTotal / marketplaceCount) +
              (marketplaceIndex < pluginTotal % marketplaceCount ? 1 : 0);
            return {
              ...marketplace,
              id,
              sourceUrl: `https://github.com/acme/${id}`,
              pluginCount: count,
              plugins: Array.from({ length: count }, (_, pluginIndex) => ({
                ...basePlugin,
                name: `plugin-${marketplaceIndex}-${pluginIndex}`,
                marketplaceId: id,
                description: 'A plugin description of realistic length.',
                externalSource: {
                  source: 'url',
                  url: `https://github.com/publisher/plugin-${String(pluginIndex).padStart(3, '0')}-repository.git`,
                },
                details: {
                  ...baseDetails,
                  skills: baseDetails.skills ?? [],
                  mcpServers: [
                    {
                      name: `server-${pluginIndex}`,
                      type: 'http' as const,
                      url: `https://mcp.publisher-${pluginIndex}.example/mcp`,
                    },
                  ],
                },
              })),
            };
          },
        );
        mockedLoadCacheOnly.mockResolvedValue({
          success: true,
          data: {
            version: 2,
            lastRefreshed: '2026-08-27T00:00:00.000Z',
            marketplaces,
          },
        });
        const result = await listPortalMarketplaces();
        expect(result.truncated).toBeUndefined();
        expect(
          result.marketplaces.reduce((sum, row) => sum + row.plugins.length, 0),
        ).toBe(pluginTotal);
        expect(
          result.marketplaces.every((row) =>
            row.plugins.every((plugin) => plugin.mcpServers?.length === 1),
          ),
        ).toBe(true);
        expect(
          Buffer.byteLength(JSON.stringify(result), 'utf8'),
        ).toBeLessThanOrEqual(PORTAL_CATALOG_RESULT_MAX_BYTES);
      });
    });
  });

  describe('getPortalPluginDetail', () => {
    it('carries per-provider install state and the Codex compatibility setting (CAN-4842)', async () => {
      mockedReadComponentContent.mockReturnValue({
        success: true,
        data: { frontmatter: {}, body: '# Plugin readme' },
      });
      primeMarketplaceCache();
      expect(await getPortalPluginDetail('mkt', 'plugin')).not.toHaveProperty(
        'harnessInstallation',
      );
      mockedLoadCacheOnly.mockResolvedValue({
        success: true,
        data: {
          version: 2,
          lastRefreshed: '2026-08-27T00:00:00.000Z',
          marketplaces: [
            {
              ...marketplace,
              plugins: [
                {
                  ...marketplace.plugins[0],
                  codexCompatDisabled: true,
                  globalInstallStatus: {
                    checkedAt: '2026-01-01T00:00:00.000Z',
                    claude: { available: true, installed: true },
                    codex: { available: true, installed: false },
                  },
                },
              ],
            },
          ],
        },
      });
      const detail = await getPortalPluginDetail('mkt', 'plugin');
      expect(detail.harnessInstallation).toEqual({
        claude: true,
        codex: false,
      });
      expect(detail.codexCompatDisabled).toBe(true);
    });

    it('carries the harnesses this desktop offers, so the Portal lists the same rows (CAN-4842)', async () => {
      primeMarketplaceCache();
      mockedReadComponentContent.mockReturnValue({
        success: true,
        data: { frontmatter: {}, body: '# Plugin readme' },
      });
      mockCopilotHarnessEnabled = false;
      expect((await getPortalPluginDetail('mkt', 'plugin')).harnesses).toEqual([
        'claude',
        'codex',
        'cursor',
        'opencode',
      ]);
      mockCopilotHarnessEnabled = true;
      try {
        expect(
          (await getPortalPluginDetail('mkt', 'plugin')).harnesses,
        ).toEqual(['claude', 'codex', 'cursor', 'copilot', 'opencode']);
      } finally {
        mockCopilotHarnessEnabled = false;
      }
    });

    it('returns detail rows with a README read from the trusted root', async () => {
      primeMarketplaceCache();
      mockedReadComponentContent.mockReturnValue({
        success: true,
        data: { frontmatter: {}, body: '# Plugin readme' },
      });

      const detail = await getPortalPluginDetail('mkt', 'plugin');

      // Paths come from the CACHED row, never from the caller.
      expect(mockedReadComponentContent).toHaveBeenCalledWith(
        '/secret/local/cache/plugin',
        '',
        'README.md',
      );
      expect(detail.readme).toEqual({
        body: '# Plugin readme',
        truncated: false,
      });
      expect(detail.details?.hasReadme).toBe(true);
      expect(JSON.stringify(detail.plugin)).not.toContain('/secret/');
    });

    it('sanitizes the homepage and embedded component MCP URLs', async () => {
      primeMarketplaceCache();
      mockedReadComponentContent.mockReturnValue({
        success: true,
        data: { frontmatter: {}, body: '# Plugin readme' },
      });

      const detail = await getPortalPluginDetail('mkt', 'plugin');

      expect(detail.homepage).toBe('https://plugin.example/docs');
      expect(detail.details?.mcpServers[0]?.url).toBe(
        'https://mcp.example/sse',
      );
      const serialized = JSON.stringify(detail);
      expect(serialized).not.toContain('home-userinfo-secret');
      expect(serialized).not.toContain('home-query-secret');
      expect(serialized).not.toContain('mcp-url-secret');
      expect(serialized).not.toContain('mcp-query-secret');
    });

    it('truncates an oversized README and flags it', async () => {
      primeMarketplaceCache();
      mockedReadComponentContent.mockReturnValue({
        success: true,
        data: {
          frontmatter: {},
          body: 'x'.repeat(PORTAL_CATALOG_CONTENT_MAX_BYTES + 100),
        },
      });

      const detail = await getPortalPluginDetail('mkt', 'plugin');
      expect(detail.readme?.truncated).toBe(true);
      expect(detail.readme?.body).toHaveLength(
        PORTAL_CATALOG_CONTENT_MAX_BYTES,
      );
    });

    it('fails with not_found for an unknown plugin', async () => {
      primeMarketplaceCache();
      await expect(getPortalPluginDetail('mkt', 'nope')).rejects.toMatchObject({
        code: 'not_found',
      });
    });
  });

  describe('readPortalPluginComponent', () => {
    it('rejects absolute component paths before any read', async () => {
      primeMarketplaceCache();
      await expect(
        readPortalPluginComponent('mkt', 'plugin', '/etc/passwd'),
      ).rejects.toMatchObject({ code: 'invalid_payload' });
      await expect(
        readPortalPluginComponent('mkt', 'plugin', 'C:\\windows\\system32'),
      ).rejects.toMatchObject({ code: 'invalid_payload' });
      expect(mockedReadComponentContent).not.toHaveBeenCalled();
    });

    it('reads a relative component file and truncates the body', async () => {
      primeMarketplaceCache();
      mockedReadComponentContent.mockReturnValue({
        success: true,
        data: {
          frontmatter: { description: 'd' },
          body: 'y'.repeat(PORTAL_CATALOG_CONTENT_MAX_BYTES + 1),
        },
      });

      const content = await readPortalPluginComponent(
        'mkt',
        'plugin',
        'skills/review/SKILL.md',
      );
      expect(mockedReadComponentContent).toHaveBeenCalledWith(
        '/secret/local/cache/plugin',
        '',
        'skills/review/SKILL.md',
      );
      expect(content.truncated).toBe(true);
      expect(content.body).toHaveLength(PORTAL_CATALOG_CONTENT_MAX_BYTES);
      expect(content.frontmatter).toEqual({ description: 'd' });
    });

    it('surfaces the trust-check failure from readComponentContent', async () => {
      primeMarketplaceCache();
      mockedReadComponentContent.mockReturnValue({
        success: false,
        error: 'Invalid component path.',
      });
      await expect(
        readPortalPluginComponent('mkt', 'plugin', '../outside.md'),
      ).rejects.toThrow('Invalid component path.');
    });
  });

  describe('skills', () => {
    it.each([
      { remoteId: 'shared-1' },
      {
        remoteId: 'shared-1',
        shareScope: 'team' as const,
        ownerContext: {
          kind: 'organization' as const,
          organizationId: 'org-1',
        },
        contentHash: 'installed-hash',
        authorizedAt: '2026-10-26T00:00:00Z',
        sharedByName: 'Lena',
        ownerName: 'Acme',
        teamName: 'Release',
        packageDigest: 'sha256:package',
      },
    ])(
      'serializes receipt origins through the existing annotation boundary (%p)',
      async (installedFromShare) => {
        const skill = {
          name: 'review',
          sourceId: 'custom:app',
          description: '',
          source: '',
          installedAt: 'i',
          updatedAt: 'u',
          updateAvailable: false,
          custom: true,
        };
        mockedLoadSkills.mockReturnValue({ success: true, data: [skill] });
        mockAnnotateSharedSkillInstalls.mockResolvedValueOnce([
          { ...skill, installedFromShare },
        ]);
        const result = await listPortalSkills();
        expect(mockAnnotateSharedSkillInstalls).toHaveBeenCalledWith([skill]);
        expect(result.skills[0].installedFromShare).toEqual(installedFromShare);
        expect(JSON.parse(JSON.stringify(result))).toEqual(result);
      },
    );

    it('does not annotate or publish receipt display names in the Personal catalog sync', async () => {
      const skill = {
        name: 'review',
        sourceId: 'custom:app',
        description: '',
        source: '',
        installedAt: 'i',
        updatedAt: 'u',
        updateAvailable: false,
        installedFromShare: { remoteId: 'private', sharedByName: 'Lena' },
      };
      mockedLoadSkills.mockReturnValue({ success: true, data: [skill] });
      mockFilterPersonalStoredSkills.mockResolvedValueOnce([skill]);
      const result = await listPersonalPortalSkills();
      expect(mockAnnotateSharedSkillInstalls).not.toHaveBeenCalled();
      expect(result.skills[0]).not.toHaveProperty('installedFromShare');
    });

    it('annotates only the rows allowed by the existing context boundary', async () => {
      const allowed = {
        name: 'allowed',
        sourceId: 'custom:app',
        description: '',
        source: '',
        installedAt: 'i',
        updatedAt: 'u',
        updateAvailable: false,
      };
      const unrelated = { ...allowed, name: 'unrelated-context' };
      mockedLoadSkills.mockReturnValue({
        success: true,
        data: [allowed, unrelated],
      });
      mockFilterStoredSkillContexts.mockResolvedValueOnce([allowed]);
      const result = await listPortalSkills();
      expect(mockAnnotateSharedSkillInstalls).toHaveBeenCalledWith([allowed]);
      expect(result.skills.map((row) => row.name)).toEqual(['allowed']);
    });

    it('builds the synced list from the Personal filter', async () => {
      const personal = {
        name: 'personal',
        sourceId: 'src',
        description: 'Personal',
        source: 'Local',
        installedAt: 'i',
        updatedAt: 'u',
        updateAvailable: false,
      };
      const organization = { ...personal, name: 'organization' };
      mockedLoadSkills.mockReturnValue({
        success: true,
        data: [personal, organization],
      });
      mockFilterPersonalStoredSkills.mockResolvedValue([personal]);

      await expect(listPersonalPortalSkills()).resolves.toEqual({
        skills: [expect.objectContaining({ name: 'personal' })],
      });
      expect(mockFilterPersonalStoredSkills).toHaveBeenCalledWith([
        personal,
        organization,
      ]);
    });

    it('keeps the Personal payload stable when the live context filter changes or fails', async () => {
      const personal = {
        name: 'personal',
        sourceId: 'src',
        description: 'Personal',
        source: 'Local',
        installedAt: 'i',
        updatedAt: 'u',
        updateAvailable: false,
      };
      const organization = { ...personal, name: 'organization' };
      mockedLoadSkills.mockReturnValue({
        success: true,
        data: [personal, organization],
      });
      mockFilterPersonalStoredSkills.mockResolvedValue([personal]);

      const personalContext = await listPersonalPortalSkills();
      mockFilterStoredSkillContexts.mockResolvedValue([personal, organization]);
      const organizationContext = await listPersonalPortalSkills();
      mockFilterStoredSkillContexts.mockRejectedValue(
        new Error('context unavailable'),
      );
      const unavailableContext = await listPersonalPortalSkills();

      expect(organizationContext).toEqual(personalContext);
      expect(unavailableContext).toEqual(personalContext);
      expect(mockFilterStoredSkillContexts).not.toHaveBeenCalled();
      expect(payloadHash(organizationContext)).toBe(
        payloadHash(personalContext),
      );
      expect(payloadHash(unavailableContext)).toBe(
        payloadHash(personalContext),
      );
    });
    it('lists installed skills without portable-source metadata', async () => {
      mockedLoadSkills.mockReturnValue({
        success: true,
        data: [
          {
            name: 'review',
            sourceId: 'src',
            description: 'd',
            source: 'GitHub',
            installedAt: 'i',
            updatedAt: 'u',
            updateAvailable: false,
            shareableSource: { type: 'github', repo: 'acme/skills' },
          },
        ],
      });
      const result = await listPortalSkills();
      expect(result.skills).toEqual([
        {
          sharing: {
            status: 'blocked',
            reason: 'Sharing is unavailable for this item.',
          },
          name: 'review',
          sourceId: 'src',
          description: 'd',
          source: 'GitHub',
          installedAt: 'i',
          updatedAt: 'u',
          updateAvailable: false,
        },
      ]);
    });

    // CAN-2845: the portal must not guess what is shareable — the desktop
    // answers with the same rule its own Skills tab applies.
    it('flags only the skills its own Skills tab would let you share', async () => {
      mockedLoadSkills.mockReturnValue({
        success: true,
        data: [
          {
            name: 'helper',
            sourceId: 'custom:app',
            custom: true,
            description: 'custom',
            source: 'Local',
            installedAt: 'i',
            updatedAt: 'u',
            updateAvailable: false,
          },
          {
            name: 'bundled',
            sourceId: 'builtin:app',
            builtIn: true,
            description: 'builtin',
            source: 'Bundled',
            installedAt: 'i',
            updatedAt: 'u',
            updateAvailable: false,
          },
          {
            name: 'from-plugin',
            sourceId: 'github:acme:skills',
            description: 'plugin-owned',
            source: 'GitHub',
            installedAt: 'i',
            updatedAt: 'u',
            updateAvailable: false,
          },
        ],
      });
      const result = await listPortalSkills();
      expect(
        result.skills.map((skill) => [skill.name, skill.shareable]),
      ).toEqual([
        ['helper', true],
        ['bundled', true],
        ['from-plugin', undefined],
      ]);
    });

    it('projects owned skill targets and leaves unresolved external skills blocked', async () => {
      mockedLoadSkills.mockReturnValue({
        success: true,
        data: [
          {
            name: 'helper',
            sourceId: 'custom:app',
            custom: true,
            description: '',
            source: 'Local',
            installedAt: 'i',
            updatedAt: 'u',
            updateAvailable: false,
          },
          {
            name: 'external',
            sourceId: 'github:acme:skills',
            description: '',
            source: 'GitHub',
            installedAt: 'i',
            updatedAt: 'u',
            updateAvailable: false,
          },
        ],
      });
      const result = await listPortalSkills();
      expect(result.skills[0]).toHaveProperty('sharing', {
        status: 'shareable',
        target: { kind: 'skill', sourceId: 'custom:app', skillName: 'helper' },
      });
      expect(result.skills[1]).toHaveProperty('sharing', {
        status: 'blocked',
        reason: 'Sharing is unavailable for this item.',
      });
    });

    it('projects the author-side shared skill identity for owner target matching', async () => {
      mockedLoadSkills.mockReturnValue({
        success: true,
        data: [
          {
            name: 'helper',
            sourceId: 'custom:app',
            custom: true,
            description: '',
            source: 'Local',
            installedAt: 'i',
            updatedAt: 'u',
            updateAvailable: false,
            remote: {
              remoteId: 'shared-1',
              contentHash: 'hash',
              shareScope: 'team',
              sharedAt: '2026-10-06T00:00:00.000Z',
            },
          },
        ],
      });
      expect((await listPortalSkills()).skills[0]).toHaveProperty(
        'shareRemoteId',
        'shared-1',
      );
    });

    it('blocks duplicate owned-skill identities in projection and activation', async () => {
      const skill = {
        name: 'helper',
        sourceId: 'custom:app',
        custom: true,
        description: '',
        source: 'Local',
        installedAt: 'i',
        updatedAt: 'u',
        updateAvailable: false,
      };
      mockedLoadSkills.mockReturnValue({
        success: true,
        data: [skill, { ...skill }],
      });
      const result = await listPortalSkills();
      expect(
        result.skills.every(
          (row) => 'sharing' in row && row.sharing?.status === 'blocked',
        ),
      ).toBe(true);
      await expect(
        sharePortalSkill({
          sourceId: skill.sourceId,
          skillName: skill.name,
          scope: 'public',
        }),
      ).rejects.toThrow('Sharing is unavailable for this item.');
      expect(mockedCreateSharedSkill).not.toHaveBeenCalled();
    });

    it('shares a skill from its raw bytes and returns the public link', async () => {
      mockedLoadSkills.mockReturnValue({
        success: true,
        data: [
          {
            name: 'helper',
            sourceId: 'custom:app',
            custom: true,
            description: 'custom',
            source: 'Local',
            installedAt: 'i',
            updatedAt: 'u',
            updateAvailable: false,
          },
        ],
      });
      mockedReadRawSkill.mockResolvedValue('# Raw skill');
      mockedCreateSharedSkill.mockResolvedValue({
        id: 'shared-1',
        canUpdate: true,
      } as never);
      mockedPublishSkillPublicShare.mockResolvedValue({
        externalId: 'share-1',
        pinnedContentHash: 'hash-1',
        upToDate: true,
        sharePath: '/portal/plugins/skills/shared/abc',
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      });

      await expect(
        sharePortalSkill({
          sourceId: 'custom:app',
          skillName: 'helper',
          scope: 'public',
        }),
      ).resolves.toEqual({ sharePath: '/portal/plugins/skills/shared/abc' });

      expect(mockedAssertSharedSkillsSupported).toHaveBeenCalled();
      // The server hashes these bytes, so they must round-trip verbatim.
      expect(mockedCreateSharedSkill).toHaveBeenCalledWith({
        rawSkill: '# Raw skill',
        shareScope: 'private',
      });
    });

    it.each([false, true])(
      'updates the linked skill, preserving a locked legacy link (policy %s)',
      async (policyEnabled) => {
        jest.mocked(resourceContextEnabled).mockReturnValue(policyEnabled);
        mockedLoadSkills.mockReturnValue({
          success: true,
          data: [
            {
              name: 'helper',
              sourceId: 'custom:app',
              custom: true,
              description: 'custom',
              source: 'Local',
              installedAt: 'i',
              updatedAt: 'u',
              updateAvailable: false,
              remote: {
                accountId: 'account-1',
                remoteId: 'shared-1',
                contentHash: 'old-hash',
                shareScope: 'private',
                sharedAt: 'old-u',
              },
            },
          ],
        });
        mockedReadRawSkill.mockResolvedValue('# Updated skill');
        mockedGetSharedSkill.mockResolvedValue({
          id: 'shared-1',
          contentHash: 'server-hash',
          owner: { type: 'organization', id: 'organization-1' },
          publicShare: {
            externalId: 'public-1',
            updatedAt: 'public-u',
          },
        } as never);
        mockedUpdateSharedSkill.mockResolvedValue({
          id: 'shared-1',
          contentHash: 'new-hash',
          canUpdate: true,
          shareScope: 'team',
          updatedAt: 'new-u',
        } as never);

        await expect(
          sharePortalSkill({
            sourceId: 'custom:app',
            skillName: 'helper',
            scope: 'team',
            teamId: 'team-1',
          }),
        ).resolves.toEqual({
          sharePath: '/portal/plugins/skills/shared/shared-1',
        });

        expect(mockedUpdateSharedSkill).toHaveBeenCalledWith({
          skillId: 'shared-1',
          rawSkill: '# Updated skill',
          expectedContentHash: 'server-hash',
          preservePackage: true,
          shareScope: 'team',
          teamId: 'team-1',
          ...(!policyEnabled
            ? {
                revokePublicShare: {
                  externalId: 'public-1',
                  updatedAt: 'public-u',
                },
              }
            : {}),
        });
        expect(mockedCreateSharedSkill).not.toHaveBeenCalled();
        expect(mockedWriteSkillRemoteMetadata).toHaveBeenCalledWith(
          'custom:app/helper',
          {
            accountId: 'account-1',
            remoteId: 'shared-1',
            contentHash: 'new-hash',
            shareScope: 'team',
            sharedAt: 'new-u',
          },
        );
      },
    );

    it('loads the linked Skill audience and refuses a different Cloud account', async () => {
      const remote = {
        accountId: 'account-1',
        remoteId: 'shared-1',
        contentHash: 'old-hash',
        shareScope: 'private' as const,
        sharedAt: 'old-u',
      };
      mockedLoadSkills.mockReturnValue({
        success: true,
        data: [
          {
            name: 'helper',
            sourceId: 'custom:app',
            custom: true,
            description: 'custom',
            source: 'Local',
            installedAt: 'i',
            updatedAt: 'u',
            updateAvailable: false,
            remote,
          },
        ],
      });
      mockedGetSharedSkill.mockResolvedValue({
        id: 'shared-1',
        shareScope: 'private',
        publicShare: { upToDate: false },
        owner: { type: 'user', id: 'account-1' },
      } as never);

      await expect(
        getPortalExistingSkillShare({
          sourceId: 'custom:app',
          skillName: 'helper',
        }),
      ).resolves.toEqual({ audience: 'public', publicLinkStale: true });

      mockedLoadAccountPublicState.mockResolvedValue({
        read: 'ok',
        hasApiKey: true,
        authMode: null,
        credentialSource: null,
        capabilities: [],
        account: {
          id: 'account-2',
          name: 'Test account',
          email: 'test@example.com',
          role: 'DEVELOPER',
        },
        storageAvailable: true,
      });
      mockedGetSharedSkill.mockClear();
      await expect(
        sharePortalSkill({
          sourceId: 'custom:app',
          skillName: 'helper',
          scope: 'private',
        }),
      ).rejects.toThrow('another or unknown Cloud account');
      expect(mockedGetSharedSkill).not.toHaveBeenCalled();
    });

    it('treats a missing linked Skill as unshared after account verification', async () => {
      mockedLoadSkills.mockReturnValue({
        success: true,
        data: [
          {
            name: 'helper',
            sourceId: 'custom:app',
            custom: true,
            description: 'custom',
            source: 'Local',
            installedAt: 'i',
            updatedAt: 'u',
            updateAvailable: false,
            remote: {
              accountId: 'account-1',
              remoteId: 'missing-skill',
              contentHash: 'old-hash',
              shareScope: 'private',
              sharedAt: 'old-u',
            },
          },
        ],
      });
      mockedGetSharedSkill.mockRejectedValue({ status: 404 });

      await expect(
        getPortalExistingSkillShare({
          sourceId: 'custom:app',
          skillName: 'helper',
        }),
      ).resolves.toBeNull();
    });

    it('preserves a possibly deduplicated skill when local link persistence fails', async () => {
      mockedLoadSkills.mockReturnValue({
        success: true,
        data: [
          {
            name: 'helper',
            sourceId: 'custom:app',
            custom: true,
            description: 'custom',
            source: 'Local',
            installedAt: 'i',
            updatedAt: 'u',
            updateAvailable: false,
          },
        ],
      });
      mockedReadRawSkill.mockResolvedValue('# Raw skill');
      mockedCreateSharedSkill.mockResolvedValue({
        id: 'shared-1',
        contentHash: 'same-hash',
        canUpdate: true,
        shareScope: 'private',
        updatedAt: 'new-u',
      } as never);
      mockedWriteSkillRemoteMetadata.mockImplementationOnce(() => {
        throw new Error('links are read-only');
      });

      await expect(
        sharePortalSkill({
          sourceId: 'custom:app',
          skillName: 'helper',
          scope: 'private',
        }),
      ).rejects.toThrow('links are read-only');

      expect(mockedDeleteSharedSkill).not.toHaveBeenCalled();
    });

    it('does not persist a deduplicated Skill owned by another publisher', async () => {
      mockedLoadSkills.mockReturnValue({
        success: true,
        data: [
          {
            name: 'helper',
            sourceId: 'custom:app',
            custom: true,
            description: 'custom',
            source: 'Local',
            installedAt: 'i',
            updatedAt: 'u',
            updateAvailable: false,
          },
        ],
      });
      mockedReadRawSkill.mockResolvedValue('# Raw skill');
      mockedCreateSharedSkill.mockResolvedValue({
        id: 'shared-1',
        contentHash: 'same-hash',
        canUpdate: false,
        shareScope: 'team',
        updatedAt: 'new-u',
      } as never);

      await sharePortalSkill({
        sourceId: 'custom:app',
        skillName: 'helper',
        scope: 'team',
        teamId: 'team-1',
      });

      expect(mockedWriteSkillRemoteMetadata).not.toHaveBeenCalled();
    });

    it('reports a degraded share when the copy lands but publishing fails', async () => {
      mockedLoadSkills.mockReturnValue({
        success: true,
        data: [
          {
            name: 'helper',
            sourceId: 'custom:app',
            custom: true,
            description: 'custom',
            source: 'Local',
            installedAt: 'i',
            updatedAt: 'u',
            updateAvailable: false,
          },
        ],
      });
      mockedReadRawSkill.mockResolvedValue('# Raw skill');
      mockedCreateSharedSkill.mockResolvedValue({
        id: 'shared-1',
        canUpdate: true,
      } as never);
      mockedPublishSkillPublicShare.mockRejectedValue(new Error('nope'));

      const outcome = await sharePortalSkill({
        sourceId: 'custom:app',
        skillName: 'helper',
        scope: 'public',
      });
      expect(outcome.sharePath).toBeUndefined();
      expect(outcome.message).toContain('public link could not be created');
    });

    // Review on #3159: the browser must gate on the DESKTOP's real account.
    it('reports the desktop account state, treating a degraded read as not connected', async () => {
      // Deliberately minimal legacy summary: the projection omits an absent name.
      const organizationWithoutName = {
        id: 'org-1',
      } as unknown as CanopyOrganizationSummary;
      mockedLoadAccountPublicState.mockResolvedValue({
        read: 'ok',
        hasApiKey: true,
        authMode: null,
        credentialSource: null,
        capabilities: ['skills-crud-v1', 'teams-v1'],
        account: {
          id: 'acc-1',
          name: 'Test account',
          email: 'test@example.com',
          role: 'DEVELOPER',
        },
        organizations: [organizationWithoutName],
        teams: [],
        storageAvailable: true,
      });
      await expect(getPortalSharingAccount()).resolves.toEqual({
        connected: true,
        id: 'acc-1',
        capabilities: ['skills-crud-v1', 'teams-v1'],
        organizationOwnershipPolicy: {
          enabled: false,
          personalOrganizationId: null,
        },
        hasOrganization: true,
        hasTeam: false,
        // No billing state: entitlement stays unknown rather than denied.
        organizationAccess: [{ organizationId: 'org-1' }],
      });

      mockedLoadAccountPublicState.mockResolvedValue({
        read: 'error',
        hasApiKey: false,
        authMode: null,
        credentialSource: null,
        capabilities: [],
        storageAvailable: true,
      });
      await expect(getPortalSharingAccount()).resolves.toEqual({
        connected: false,
        capabilities: [],
        organizationOwnershipPolicy: {
          enabled: false,
          personalOrganizationId: null,
        },
      });
    });

    it('projects the desktop policy and Personal exception for Portal sharing', async () => {
      jest.mocked(resourceContextEnabled).mockReturnValue(true);
      mockedLoadAccountPublicState.mockResolvedValue({
        read: 'ok',
        hasApiKey: true,
        authMode: null,
        credentialSource: null,
        capabilities: ['skills-crud-v1'],
        account: {
          id: 'desktop-account',
          name: 'Test account',
          email: 'test@example.com',
          role: 'DEVELOPER',
        },
        personalOrganizationId: 'desktop-personal',
        storageAvailable: true,
      });
      await expect(getPortalSharingAccount()).resolves.toMatchObject({
        organizationOwnershipPolicy: {
          enabled: true,
          personalOrganizationId: 'desktop-personal',
        },
      });
    });

    it('projects advisory organization access facts for Portal sharing', async () => {
      mockedLoadAccountPublicState.mockResolvedValue({
        read: 'ok',
        hasApiKey: true,
        authMode: null,
        credentialSource: null,
        capabilities: ['skills-crud-v1'],
        account: {
          id: 'desktop-account',
          name: 'Test account',
          email: 'test@example.com',
          role: 'DEVELOPER',
        },
        organizations: [
          {
            id: 'org-lapsed',
            name: 'Lapsed Org',
            role: 'OWNER',
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z',
          },
          {
            id: 'org-unknown',
            name: 'Unknown Org',
            role: 'MEMBER',
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z',
          },
        ],
        orgBillingStates: [
          {
            organizationId: 'org-lapsed',
            organizationName: 'Lapsed Org',
            teamsEntitled: false,
            trialEndedAt: '2026-10-07T00:00:00.000Z',
          },
        ],
        storageAvailable: true,
      });
      await expect(getPortalSharingAccount()).resolves.toMatchObject({
        organizationAccess: [
          {
            organizationId: 'org-lapsed',
            organizationName: 'Lapsed Org',
            teamsEntitled: false,
            canChoosePlan: true,
          },
          {
            organizationId: 'org-unknown',
            organizationName: 'Unknown Org',
            canChoosePlan: false,
          },
        ],
      });
      const result = await getPortalSharingAccount();
      expect(result.organizationAccess?.[1]).not.toHaveProperty(
        'teamsEntitled',
      );
    });

    it('refuses to share a skill its own rule excludes', async () => {
      mockedLoadSkills.mockReturnValue({
        success: true,
        data: [
          {
            name: 'from-plugin',
            sourceId: 'github:acme:skills',
            description: 'plugin-owned',
            source: 'GitHub',
            installedAt: 'i',
            updatedAt: 'u',
            updateAvailable: false,
          },
        ],
      });
      await expect(
        sharePortalSkill({
          sourceId: 'github:acme:skills',
          skillName: 'from-plugin',
          scope: 'public',
        }),
      ).rejects.toThrow('cannot be shared');
      expect(mockedCreateSharedSkill).not.toHaveBeenCalled();
    });

    it('fails the list command when the skill inventory cannot be read', async () => {
      mockedLoadSkills.mockReturnValue({
        success: false,
        error: 'Skill index unreadable.',
      });
      await expect(listPortalSkills()).rejects.toThrow(
        'Skill index unreadable.',
      );
    });

    it('rejects skill identifiers containing path separators', async () => {
      await expect(readPortalSkill('../src', 'review')).rejects.toMatchObject({
        code: 'invalid_payload',
      });
      await expect(readPortalSkill('src', 'a\\b')).rejects.toMatchObject({
        code: 'invalid_payload',
      });
      expect(mockedReadSkillContent).not.toHaveBeenCalled();
    });

    it('accepts every real store source-id shape (colon-form ids)', async () => {
      // The desktop's own store mints colon-bearing source ids. Generate the
      // fixtures through the REAL `deriveSourceId` (skills/paths.ts) plus the
      // canonical built-in/custom constants so a future id-format change
      // fails this test instead of silently diverging: the portal read
      // validation must never reject an id the store itself produces — the
      // web layer forwards them verbatim for `portal.skills.read`.
      mockedReadSkillContent.mockReturnValue({
        success: true,
        data: { frontmatter: { name: 'burrow-cli' }, body: 'body' },
      });
      for (const sourceId of [
        // github:unstoppabledomains:burrow — the reported real-world id.
        deriveSourceId('github', 'unstoppabledomains/burrow'),
        BUILTIN_SOURCE_ID,
        CUSTOM_SOURCE_ID,
        // url:a_b_c_d — non-GitHub shape (see skills-paths.test.ts).
        deriveSourceId('url', 'a/b\\c/d'),
        // local:_Users_me_skills — escaped local-path shape.
        deriveSourceId('local', '/Users/me/skills'),
      ]) {
        await expect(
          readPortalSkill(sourceId, 'burrow-cli'),
        ).resolves.toMatchObject({ body: 'body' });
        expect(mockedReadSkillContent).toHaveBeenCalledWith(
          sourceId,
          'burrow-cli',
        );
      }
    });

    it('reads and truncates skill content', async () => {
      mockedReadSkillContent.mockReturnValue({
        success: true,
        data: {
          frontmatter: { name: 'review' },
          body: 'z'.repeat(PORTAL_CATALOG_CONTENT_MAX_BYTES + 5),
        },
      });
      const content = await readPortalSkill('src', 'review');
      expect(mockedReadSkillContent).toHaveBeenCalledWith('src', 'review');
      expect(content.truncated).toBe(true);
      expect(content.body).toHaveLength(PORTAL_CATALOG_CONTENT_MAX_BYTES);
    });

    it('maps a missing skill to not_found', async () => {
      mockedReadSkillContent.mockReturnValue({
        success: false,
        error: 'SKILL.md not found for "review".',
      });
      await expect(readPortalSkill('src', 'review')).rejects.toMatchObject({
        code: 'not_found',
      });
    });
  });

  describe('MCP servers', () => {
    it('returns cached MCP rows promptly while optional provider discovery stays pending (CAN-5272)', async () => {
      jest.useFakeTimers();
      const cachedServer = {
        id: 'cached',
        name: 'Cached MCP',
        description: '',
        type: 'http',
        configs: [{ id: 'default', name: 'Default', enabled: true }],
        updatedAt: '',
      };
      mockedReadFile.mockResolvedValue(
        JSON.stringify({ servers: [cachedServer] }),
      );
      const discovery =
        Promise.withResolvers<
          Awaited<ReturnType<typeof listAdvertisedProviderConnectors>>
        >();
      jest
        .mocked(listAdvertisedProviderConnectors)
        .mockReturnValue(discovery.promise);
      const results: Awaited<ReturnType<typeof listPortalMcpServers>>[] = [];
      const reads = [
        listPortalMcpServers().then((result) => results.push(result)),
        listPortalMcpServers().then((result) => results.push(result)),
      ];
      try {
        await jest.advanceTimersByTimeAsync(250);
        expect(results).toHaveLength(2);
        for (const result of results) {
          expect(result.servers).toEqual([
            expect.objectContaining(cachedServer),
          ]);
          expect(result).not.toHaveProperty('providerConnectors');
        }
        // Later callers must also finish without spawning another discovery.
        reads.push(
          listPortalMcpServers().then((result) => results.push(result)),
        );
        await jest.advanceTimersByTimeAsync(250);
        expect(results).toHaveLength(3);
        expect(
          jest.mocked(listAdvertisedProviderConnectors),
        ).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        // A late failure must be consumed, and release discovery for a retry.
        discovery.reject(new Error('provider health check failed'));
        await Promise.all(reads);
        await discovery.promise.catch(() => undefined);
        jest.mocked(listAdvertisedProviderConnectors).mockResolvedValue([]);
        jest.useRealTimers();
      }
    });

    it('omits failed provider discovery without inventing provider facts (CAN-5272)', async () => {
      mockedReadFile.mockResolvedValue(JSON.stringify({ servers: [] }));
      jest
        .mocked(listAdvertisedProviderConnectors)
        .mockRejectedValueOnce(new Error('provider unavailable'));
      await expect(listPortalMcpServers()).resolves.toEqual({ servers: [] });
    });

    it('carries proven provider links through the existing Portal and sync read (CAN-5272)', async () => {
      mockedReadFile.mockResolvedValue(JSON.stringify({ servers: [] }));
      jest.mocked(listAdvertisedProviderConnectors).mockResolvedValueOnce([
        {
          provider: 'codex',
          connectors: [
            {
              name: 'drive',
              status: 'connected',
              displayName: 'Drive',
              connected: true,
              installUrl: 'https://example.test/private?token=secret',
            },
          ],
          detail: '/private/host/path',
        },
      ]);
      const result = await listPortalMcpServers();
      expect(result).toMatchObject({
        providerConnectors: [
          {
            provider: 'codex',
            connectors: [{ displayName: 'Drive', connected: true }],
          },
        ],
      });
      expect(JSON.stringify(result)).not.toContain('secret');
      expect(JSON.stringify(result)).not.toContain('/private/host/path');
    });

    it('lists servers from the persisted index without extra fields', async () => {
      mockedReadFile.mockResolvedValue(
        JSON.stringify({
          version: 1,
          servers: [
            {
              id: 'abc',
              name: 'GitHub',
              description: 'd',
              type: 'http',
              configs: [
                { id: 'cfg', name: 'Default', enabled: true, extra: 'x' },
              ],
              updatedAt: 'u',
              logoUrl: 'https://cdn.example/logo.png',
              scope: 'account',
              authHandler: 'account',
              accountConnectionId: 'account-id',
              urlHost: 'mcp.github.test',
              urlScheme: 'https',
            },
          ],
        }),
      );
      const result = await listPortalMcpServers();
      expect(result.servers).toEqual([
        {
          sharing: {
            status: 'blocked',
            reason: 'MCP server connections cannot be shared.',
          },
          id: 'abc',
          name: 'GitHub',
          description: 'd',
          type: 'http',
          configs: [{ id: 'cfg', name: 'Default', enabled: true }],
          updatedAt: 'u',
          logoUrl: 'https://cdn.example/logo.png',
          scope: 'account',
          authHandler: 'account',
          accountConnectionId: 'account-id',
          urlHost: 'mcp.github.test',
          urlScheme: 'https',
        },
      ]);
    });

    it('returns an empty list when the index file does not exist', async () => {
      // No index yet is a genuinely empty inventory, not a failure.
      mockedReadFile.mockRejectedValue(
        Object.assign(new Error('ENOENT: no such file or directory'), {
          code: 'ENOENT',
        }),
      );
      await expect(listPortalMcpServers()).resolves.toEqual({ servers: [] });
    });

    it('fails the list command when the index cannot be read', async () => {
      // Same policy as listPortalSkills: a read failure must not collapse to
      // an empty list the web client would render as "no servers".
      mockedReadFile.mockRejectedValue(
        Object.assign(new Error('EACCES: permission denied'), {
          code: 'EACCES',
        }),
      );
      await expect(listPortalMcpServers()).rejects.toThrow(
        'EACCES: permission denied',
      );
    });

    it('fails the list command when the index is malformed JSON', async () => {
      mockedReadFile.mockResolvedValue('{ not json');
      await expect(listPortalMcpServers()).rejects.toThrow();
    });

    it('treats a parseable index with an unexpected shape as empty', async () => {
      mockedReadFile.mockResolvedValue(JSON.stringify({ version: 1 }));
      await expect(listPortalMcpServers()).resolves.toEqual({ servers: [] });
    });

    it('projects folded MCP parent targets and standalone MCP reasons', async () => {
      primeMarketplaceCache();
      const cached = await mockedLoadCacheOnly();
      if (!cached.success || !cached.data) throw new Error('Missing fixture');
      cached.data.marketplaces[0] = {
        ...marketplace,
        curated: true,
        sourceUrl: 'https://github.com/acme/marketplace',
      };
      mockedLoadCacheOnly.mockResolvedValue(cached);
      mockedReadFile.mockResolvedValue(
        JSON.stringify({
          servers: [
            {
              id: 'folded',
              curatedKey: 'embedded',
              name: 'Embedded',
              description: '',
              type: 'http',
              configs: [],
              updatedAt: 'u',
            },
            {
              id: 'standalone',
              name: 'Standalone',
              description: '',
              type: 'http',
              configs: [],
              updatedAt: 'u',
            },
          ],
        }),
      );
      const result = await listPortalMcpServers();
      expect(result.servers[0]).toHaveProperty('sharing', {
        status: 'shareable',
        target: {
          kind: 'plugin',
          marketplaceId: 'mkt',
          pluginName: 'plugin',
          displayName: 'Plugin',
          sourceLabel: 'github:acme/marketplace',
          refKey: 'claude_plugin:github:acme/marketplace:plugin',
        },
      });
      expect(result.servers[1]).toHaveProperty('sharing', {
        status: 'blocked',
        reason: 'MCP server connections cannot be shared.',
      });
      mockedReadServer.mockResolvedValue({
        version: 1,
        server: {
          definition: {
            id: 'folded',
            name: 'Embedded',
            description: '',
            type: 'http',
            curated: { key: 'embedded' },
            createdAt: 'c',
            updatedAt: 'u',
          },
          configs: [],
        },
      });
      const detail = await getPortalMcpServer('folded');
      expect(detail.server.sharing).toEqual(result.servers[0].sharing);
    });

    it.each(['reported', 'thrown'])(
      'keeps curated MCP sharing unavailable when parent inventory fails (%s)',
      async (failure) => {
        mockedReadFile.mockResolvedValue(
          JSON.stringify({
            servers: [
              {
                id: 'folded',
                curatedKey: 'embedded',
                name: 'Embedded',
                description: '',
                type: 'http',
                configs: [],
                updatedAt: 'u',
              },
            ],
          }),
        );
        if (failure === 'reported')
          mockedLoadCacheOnly.mockResolvedValue({
            success: false,
            error: 'Cache unavailable',
          });
        else
          mockedLoadCacheOnly.mockRejectedValueOnce(
            new Error('Cache unavailable'),
          );
        const result = await listPortalMcpServers();
        expect(result.servers[0]).toHaveProperty('sharing', {
          status: 'blocked',
          reason: 'Sharing is unavailable for this item.',
        });
        expect(mockedLoadMarketplaces).not.toHaveBeenCalled();
      },
    );

    it('sanitizes list-row logo URLs and omits unparseable ones', async () => {
      const entry = {
        id: 'abc',
        name: 'GitHub',
        description: 'd',
        type: 'http',
        configs: [{ id: 'cfg', name: 'Default', enabled: true }],
        updatedAt: 'u',
      };
      mockedReadFile.mockResolvedValue(
        JSON.stringify({
          version: 1,
          servers: [
            {
              ...entry,
              id: 'signed',
              logoUrl:
                'https://logo-user:logo-userinfo-secret@cdn.example/logo.png?sig=logo-query-secret',
            },
            { ...entry, id: 'broken', logoUrl: 'not a url ?sig=logo-secret' },
          ],
        }),
      );
      const result = await listPortalMcpServers();
      expect(result.servers[0].logoUrl).toBe('https://cdn.example/logo.png');
      expect('logoUrl' in result.servers[1]).toBe(false);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('logo-userinfo-secret');
      expect(serialized).not.toContain('logo-query-secret');
      expect(serialized).not.toContain('logo-secret');
    });

    it('REDACTS every credential from the server detail', async () => {
      const file: McpServerFile = {
        version: 1,
        server: {
          definition: {
            id: 'abc',
            name: 'GitHub',
            description: 'd',
            type: 'http',
            command: 'npx',
            args: ['--token', 'definition-arg-secret'],
            // Userinfo, query, and fragment can all embed credentials and
            // MUST be stripped from every URL.
            url: 'https://user:url-userinfo-secret@example.com:8443/mcp?token=url-query-secret#frag-secret',
            headers: { Authorization: 'Bearer super-secret-header' },
            oauth: {
              clientId: 'client-id-value',
              clientSecret: 'client-secret-value',
              authorizationUrl:
                'https://oauth-user:oauth-userinfo-secret@idp.example/authorize?client_secret=oauth-query-secret',
              tokenUrl: 'https://idp.example/token?token=token-query-secret',
              scopes: ['repo'],
            },
            curated: {
              key: 'github',
              logoUrl: 'https://cdn.example/logo.png?sig=curated-logo-secret',
              docsUrl:
                'https://docs-user:curated-docs-secret@docs.example/mcp#curated-frag',
              supportUrl: 'not a url ?x=curated-support-secret',
              privacyPolicyUrl: 'https://p.example/privacy',
              authorName: 'Acme',
              authorUrl: 'https://a.example/acme?t=curated-author-secret',
              requiresProviderAuth: true,
            },
            createdAt: 'c',
            updatedAt: 'u',
          },
          configs: [
            {
              id: 'cfg',
              name: 'Default',
              description: '',
              enabled: true,
              envVars: { GITHUB_TOKEN: 'ghp_secret_value' },
              extraArgs: ['--password', 'extra-arg-secret'],
              extraHeaders: { 'X-Auth': 'extra-secret-header' },
              authToken: 'bearer-secret-token',
              createdAt: 'c',
              updatedAt: 'u',
            },
          ],
        },
      };
      mockedReadServer.mockResolvedValue(file);

      const result = await getPortalMcpServer('abc');
      const serialized = JSON.stringify(result);

      // No secret VALUE may appear anywhere in the result.
      expect(serialized).not.toContain('ghp_secret_value');
      expect(serialized).not.toContain('bearer-secret-token');
      expect(serialized).not.toContain('super-secret-header');
      expect(serialized).not.toContain('extra-secret-header');
      expect(serialized).not.toContain('client-secret-value');
      expect(serialized).not.toContain('client-id-value');
      expect(serialized).not.toContain('definition-arg-secret');
      expect(serialized).not.toContain('extra-arg-secret');
      expect(serialized).not.toContain('url-userinfo-secret');
      expect(serialized).not.toContain('url-query-secret');
      expect(serialized).not.toContain('frag-secret');
      expect(serialized).not.toContain('oauth-userinfo-secret');
      expect(serialized).not.toContain('oauth-query-secret');
      expect(serialized).not.toContain('token-query-secret');
      expect(serialized).not.toContain('authToken');
      expect(serialized).not.toContain('envVars');
      expect(serialized).not.toContain('extraArgs');
      expect(serialized).not.toContain('curated-logo-secret');
      expect(serialized).not.toContain('curated-docs-secret');
      expect(serialized).not.toContain('curated-support-secret');
      expect(serialized).not.toContain('curated-author-secret');

      // Names/presence flags/counts survive so the detail page stays useful,
      // and URLs come back sanitized to scheme + host + port + path.
      expect(result.server.url).toBe('https://example.com:8443/mcp');
      expect(result.server.argCount).toBe(2);
      expect(result.server.headerNames).toEqual(['Authorization']);
      expect(result.server.oauth).toEqual({
        hasClientId: true,
        hasClientSecret: true,
        authorizationUrl: 'https://idp.example/authorize',
        tokenUrl: 'https://idp.example/token',
        scopes: ['repo'],
      });
      expect(result.server.configs[0]).toMatchObject({
        envVarNames: ['GITHUB_TOKEN'],
        extraArgCount: 2,
        extraHeaderNames: ['X-Auth'],
        hasAuthToken: true,
      });
      expect('args' in result.server).toBe(false);
      expect('extraArgs' in (result.server.configs[0] ?? {})).toBe(false);

      // Curated metadata is an explicit projection with every URL sanitized;
      // the unparseable supportUrl is omitted rather than forwarded raw.
      expect(result.server.curated).toEqual({
        key: 'github',
        logoUrl: 'https://cdn.example/logo.png',
        docsUrl: 'https://docs.example/mcp',
        privacyPolicyUrl: 'https://p.example/privacy',
        authorName: 'Acme',
        authorUrl: 'https://a.example/acme',
        requiresProviderAuth: true,
      });
    });

    it('omits unparseable URLs instead of forwarding them raw', async () => {
      const file: McpServerFile = {
        version: 1,
        server: {
          definition: {
            id: 'abc',
            name: 'Broken',
            description: '',
            type: 'http',
            url: 'not a url ?token=still-a-secret',
            createdAt: 'c',
            updatedAt: 'u',
          },
          configs: [],
        },
      };
      mockedReadServer.mockResolvedValue(file);
      const result = await getPortalMcpServer('abc');
      expect('url' in result.server).toBe(false);
      expect(JSON.stringify(result)).not.toContain('still-a-secret');
    });

    it('rejects non-safe server ids before any file read', async () => {
      await expect(getPortalMcpServer('../abc')).rejects.toMatchObject({
        code: 'invalid_payload',
      });
      expect(mockedReadServer).not.toHaveBeenCalled();
    });

    it('maps a missing server file to not_found', async () => {
      mockedReadServer.mockRejectedValue(new Error('ENOENT'));
      mockedLoadAccountConnections.mockResolvedValue(null);
      await expect(getPortalMcpServer('abc')).rejects.toMatchObject({
        code: 'not_found',
      });
    });

    describe('server id shape', () => {
      it.each([
        'abc',
        'my_server-1',
        'b7c1e2d4-0f3a-4c5b-8e9d-0a1b2c3d4e5f',
        CUSTOM_ID,
        CUSTOM_ID.toUpperCase().replace('CUSTOM:', 'custom:'),
      ])('accepts %s', (serverId) => {
        expect(isPortalMcpServerId(serverId)).toBe(true);
      });

      it.each([
        '',
        'custom:',
        'custom:not-a-uuid',
        'custom:3f2b6c1e8d4a4b7e9c2f1a5d6e7f8a9b',
        `${CUSTOM_ID}/../x`,
        `${CUSTOM_ID}x`,
        `custom:../../${CUSTOM_ID.slice(7)}`,
        'Custom:3f2b6c1e-8d4a-4b7e-9c2f-1a5d6e7f8a9b',
        'account:conn-1',
        '../abc',
        'a/b',
        'a\\b',
        '%2e%2e',
        'abc\0',
        'a b',
      ])('rejects %j', (serverId) => {
        expect(isPortalMcpServerId(serverId)).toBe(false);
      });

      it('rejects a malformed custom key before any read', async () => {
        await expect(
          getPortalMcpServer('custom:../../etc/passwd'),
        ).rejects.toMatchObject({ code: 'invalid_payload' });
        expect(mockedReadServer).not.toHaveBeenCalled();
        expect(mockedLoadAccountConnections).not.toHaveBeenCalled();
      });
    });

    describe('account servers', () => {
      it.each([
        ['CONNECTED', 'connected'],
        ['REAUTH_REQUIRED', 'auth_required'],
        ['PENDING', 'unknown'],
        ['DISCONNECTED', 'unknown'],
      ] as const)(
        'uses the account fallback for %s without inventing a timestamp',
        async (status, expected) => {
          mockedListMcpStatuses.mockResolvedValue([]);
          mockedLoadAccountConnections.mockResolvedValue([
            accountConnection({ status }),
          ]);
          const result = await getPortalMcpServer(CUSTOM_ID);
          expect(result.server.status?.connectionStatus).toBe(expected);
          expect(result.server.status?.lastCheckedAt).toBeUndefined();
          expect(result.server.managementTarget).toBeUndefined();
        },
      );

      it('serves a custom account server without touching device files', async () => {
        mockedLoadAccountConnections.mockResolvedValue([
          accountConnection({ id: 'conn-2', configId: 'work' }),
          accountConnection(),
          accountConnection({
            id: 'conn-3',
            serverKey: 'custom:00000000-0000-4000-8000-000000000000',
          }),
        ]);
        const result = await getPortalMcpServer(CUSTOM_ID);
        expect(mockedReadServer).not.toHaveBeenCalled();
        expect(result).toEqual({
          server: {
            status: {
              connectionStatus: 'connected',
              reachability: 'unknown',
              handler: 'account',
              configs: [
                { configId: 'default', authStatus: 'connected' },
                { configId: 'work', authStatus: 'connected' },
              ],
            },
            sharing: {
              status: 'blocked',
              reason: 'MCP server connections cannot be shared.',
            },
            id: CUSTOM_ID,
            name: 'Internal Staging Hub',
            description: '',
            type: 'http',
            scope: 'account',
            url: 'https://hub.example.test/',
            // The cloud reports no timestamps, so none are invented.
            configs: [
              expect.objectContaining({
                id: 'default',
                name: 'Default',
                enabled: true,
                hasAuthToken: true,
                // Presence only: account header names never leave the cloud.
                extraHeaderNames: [],
                hasExtraHeaders: true,
              }),
              expect.objectContaining({ id: 'work', name: 'work' }),
            ],
          },
        });
        expect(JSON.stringify(result)).not.toContain('route-secret-1');
      });

      it('reports that an account configuration has no extra headers', async () => {
        mockedLoadAccountConnections.mockResolvedValue([
          accountConnection({ hasExtraHeaders: false }),
        ]);
        const result = await getPortalMcpServer(CUSTOM_ID);
        expect(result.server.configs[0]?.hasExtraHeaders).toBe(false);
      });

      it('omits header presence when an older cloud does not report it', async () => {
        const legacy = accountConnection();
        delete legacy.hasExtraHeaders;
        mockedLoadAccountConnections.mockResolvedValue([legacy]);
        const result = await getPortalMcpServer(CUSTOM_ID);
        expect(result.server.configs[0]).not.toHaveProperty('hasExtraHeaders');
        expect(result.server.configs[0]?.extraHeaderNames).toEqual([]);
      });

      it('reports a signed-out account configuration without a token', async () => {
        mockedLoadAccountConnections.mockResolvedValue([
          accountConnection({ status: 'REAUTH_REQUIRED' }),
        ]);
        const result = await getPortalMcpServer(CUSTOM_ID);
        expect(result.server.configs[0]?.hasAuthToken).toBe(false);
      });

      it('reports a connected auth-free account configuration without a token', async () => {
        mockedLoadAccountConnections.mockResolvedValue([
          accountConnection({ authMode: 'NONE' }),
        ]);
        const result = await getPortalMcpServer(CUSTOM_ID);
        expect(result.server.configs[0]?.hasAuthToken).toBe(false);
      });

      it('drops an upstream host that is not a bare hostname', async () => {
        mockedLoadAccountConnections.mockResolvedValue([
          accountConnection({ upstreamHost: 'user:pw@hub.example.test/path' }),
        ]);
        const result = await getPortalMcpServer(CUSTOM_ID);
        expect('url' in result.server).toBe(false);
        expect(JSON.stringify(result)).not.toContain('pw');
      });

      it('maps a custom key with no account connection to not_found', async () => {
        mockedLoadAccountConnections.mockResolvedValue([
          accountConnection({ kind: 'CURATED' }),
        ]);
        await expect(getPortalMcpServer(CUSTOM_ID)).rejects.toMatchObject({
          code: 'not_found',
        });
        expect(mockedReadServer).not.toHaveBeenCalled();
      });

      it('maps unavailable account connections to not_found', async () => {
        mockedLoadAccountConnections.mockResolvedValue(null);
        await expect(getPortalMcpServer(CUSTOM_ID)).rejects.toMatchObject({
          code: 'not_found',
        });
      });

      it('falls back to the account connection for a curated key with no device file', async () => {
        mockedReadServer.mockRejectedValue(new Error('ENOENT'));
        mockedLoadAccountConnections.mockResolvedValue([
          accountConnection({
            serverKey: 'github',
            kind: 'CURATED',
            displayName: 'GitHub',
          }),
        ]);
        const result = await getPortalMcpServer('github');
        expect(mockedReadServer).toHaveBeenCalledWith('github');
        // Marked as an account server, so the portal shows it read-only.
        expect(result.server).toMatchObject({
          id: 'github',
          name: 'GitHub',
          scope: 'account',
        });
      });
    });
  });

  describe('collections', () => {
    it('builds the synced list and sharing state from the same Personal view', async () => {
      const entry = {
        id: 'personal',
        name: 'Personal',
        description: '',
        updatedAt: '2026-10-01T00:00:00.000Z',
        skillCount: 0,
        pluginCount: 0,
        mcpServerCount: 0,
      };
      mockedReadPersonalCollectionIndex.mockResolvedValue({
        version: 2,
        collections: [entry],
      });
      mockedReadPersonalCollectionConfig.mockResolvedValue({
        version: 2,
        collection: {
          id: entry.id,
          name: entry.name,
          description: '',
          skills: [],
          plugins: [],
          mcpServers: [],
          createdAt: '',
          updatedAt: '',
        },
      });
      mockedLoadSkills.mockReturnValue({ success: true, data: [] });
      mockFilterPersonalStoredSkills.mockResolvedValue([]);
      mockedLoadCacheOnly.mockResolvedValue({
        success: true,
        data: {
          version: 2,
          lastRefreshed: '2026-10-01T00:00:00.000Z',
          marketplaces: [],
        },
      });

      await expect(listPersonalPortalCollections()).resolves.toEqual({
        collections: [expect.objectContaining({ id: 'personal' })],
      });
      expect(mockedReadPersonalCollectionConfig).toHaveBeenCalledWith(
        'personal',
      );
    });

    it('keeps the Personal payload stable when live Collection reads change or fail', async () => {
      const entry = {
        id: 'personal',
        name: 'Personal',
        description: '',
        updatedAt: '2026-10-01T00:00:00.000Z',
        skillCount: 0,
        pluginCount: 0,
        mcpServerCount: 0,
      };
      mockedReadPersonalCollectionIndex.mockResolvedValue({
        version: 2,
        collections: [entry],
      });
      mockedReadPersonalCollectionConfig.mockResolvedValue({
        version: 2,
        collection: {
          id: entry.id,
          name: entry.name,
          description: '',
          skills: [],
          plugins: [],
          mcpServers: [],
          createdAt: '',
          updatedAt: '',
        },
      });
      mockedLoadSkills.mockReturnValue({ success: true, data: [] });
      mockFilterPersonalStoredSkills.mockResolvedValue([]);
      mockedLoadCacheOnly.mockResolvedValue({
        success: true,
        data: {
          version: 2,
          lastRefreshed: '2026-10-01T00:00:00.000Z',
          marketplaces: [],
        },
      });

      const personalContext = await listPersonalPortalCollections();
      mockedReadCollectionIndex.mockResolvedValue({
        version: 2,
        collections: [{ ...entry, id: 'organization' }],
      });
      const organizationContext = await listPersonalPortalCollections();
      mockedReadCollectionIndex.mockRejectedValue(
        new Error('context unavailable'),
      );
      const unavailableContext = await listPersonalPortalCollections();

      expect(organizationContext).toEqual(personalContext);
      expect(unavailableContext).toEqual(personalContext);
      expect(mockedReadCollectionIndex).not.toHaveBeenCalled();
      expect(payloadHash(organizationContext)).toBe(
        payloadHash(personalContext),
      );
      expect(payloadHash(unavailableContext)).toBe(
        payloadHash(personalContext),
      );
    });
    function collectionDetail(): Awaited<
      ReturnType<typeof getSharedCollection>
    > {
      return {
        id: 'shared-1',
        name: 'Pack',
        description: '',
        contentHash: 'new-hash',
        itemCounts: { skills: 0, plugins: 0, customSkills: 0 },
        shareScope: 'private' as const,
        owner: { type: 'user' as const, id: 'account-1', name: null },
        createdBy: { id: 'account-1', name: null, email: null },
        createdAt: 'c',
        updatedAt: 'u',
        canUpdate: true,
        canDelete: true,
        rawCollection: '{}',
        customSkills: [],
        collection: {
          version: 1 as const,
          name: 'Pack',
          description: '',
          items: [],
        },
      };
    }

    it.each([
      ['team', false],
      ['organization', false],
      ['team', true],
      ['organization', true],
    ] as const)(
      'updates the Public collection link for %s (policy %s)',
      async (scope, policyEnabled) => {
        jest.mocked(resourceContextEnabled).mockReturnValue(policyEnabled);
        const previous = collectionDetail();
        const publicShare = {
          externalId: 'public-1',
          pinnedContentHash: previous.contentHash,
          upToDate: true,
          sharePath: '/portal/plugins/collections/shared/public-1',
          createdAt: 'c',
          updatedAt: 'u',
        };
        mockedReadCollectionConfig.mockResolvedValue({
          version: 2,
          collection: {
            id: 'abc',
            name: 'Pack',
            description: '',
            skills: [],
            plugins: [],
            mcpServers: [],
            createdAt: 'c',
            updatedAt: 'u',
            remote: {
              accountId: 'account-1',
              remoteId: previous.id,
              contentHash: previous.contentHash,
              shareScope: 'private',
              sharedAt: 'u',
            },
          },
        });
        mockedLoadSkills.mockReturnValue({ success: true, data: [] });
        mockedGetSharedCollection.mockResolvedValue({
          ...previous,
          owner: { type: 'organization', id: 'org-1', name: 'Acme' },
          publicShare,
        });
        mockedUpdateSharedCollection.mockResolvedValue(previous);
        await sharePortalCollection({
          collectionId: 'abc',
          scope,
          teamId: 'new-team',
          organizationId: 'new-org',
        });
        if (policyEnabled) {
          expect(revokeCollectionPublicShare).not.toHaveBeenCalled();
          expect(mockedUpdateSharedCollection).toHaveBeenCalled();
          return;
        }
        expect(jest.mocked(revokeCollectionPublicShare)).toHaveBeenCalledWith(
          previous.id,
        );
        expect(
          jest.mocked(revokeCollectionPublicShare).mock.invocationCallOrder[0],
        ).toBeLessThan(
          mockedUpdateSharedCollection.mock.invocationCallOrder[0],
        );
      },
    );

    it('does not update or recreate a collection when revoking its public link fails', async () => {
      const previous = collectionDetail();
      mockedReadCollectionConfig.mockResolvedValue({
        version: 2,
        collection: {
          id: 'abc',
          name: 'Pack',
          description: '',
          skills: [],
          plugins: [],
          mcpServers: [],
          createdAt: 'c',
          updatedAt: 'u',
          remote: {
            accountId: 'account-1',
            remoteId: previous.id,
            contentHash: previous.contentHash,
            shareScope: 'private',
            sharedAt: 'u',
          },
        },
      });
      mockedLoadSkills.mockReturnValue({ success: true, data: [] });
      mockedGetSharedCollection.mockResolvedValue({
        ...previous,
        publicShare: {
          externalId: 'public-1',
          pinnedContentHash: previous.contentHash,
          upToDate: true,
          sharePath: '/portal/plugins/collections/shared/public-1',
          createdAt: 'c',
          updatedAt: 'u',
        },
      });
      jest
        .mocked(revokeCollectionPublicShare)
        .mockRejectedValue({ status: 404, message: 'Revoke failed' });
      mockedUpdateSharedCollection.mockResolvedValue(previous);
      await expect(
        sharePortalCollection({
          collectionId: 'abc',
          scope: 'team',
          teamId: 'new-team',
        }),
      ).rejects.toMatchObject({ message: 'Revoke failed' });
      expect(mockedUpdateSharedCollection).not.toHaveBeenCalled();
      expect(mockedCreateSharedCollection).not.toHaveBeenCalled();
    });
    it.each(['new', 'team', 'organization'] as const)(
      'publishes the %s collection with a private canonical owner',
      async (previousScope) => {
        const detail = {
          id: 'shared-1',
          name: 'Pack',
          description: '',
          contentHash: 'new-hash',
          itemCounts: { skills: 0, plugins: 0, customSkills: 0 },
          shareScope: 'private' as const,
          owner: { type: 'user' as const, id: 'account-1', name: null },
          createdBy: { id: 'account-1', name: null, email: null },
          createdAt: 'c',
          updatedAt: 'u',
          canUpdate: true,
          canDelete: true,
          rawCollection: '{}',
          customSkills: [],
          collection: {
            version: 1 as const,
            name: 'Pack',
            description: '',
            items: [],
          },
        };
        mockedReadCollectionConfig.mockResolvedValue({
          version: 2,
          collection: {
            id: 'abc',
            name: 'Pack',
            description: '',
            skills: [],
            plugins: [],
            mcpServers: [],
            createdAt: 'c',
            updatedAt: 'u',
            ...(previousScope === 'new'
              ? {}
              : {
                  remote: {
                    accountId: 'account-1',
                    remoteId: detail.id,
                    contentHash: 'old-hash',
                    shareScope: previousScope,
                    sharedAt: 'old-u',
                  },
                }),
          },
        });
        mockedLoadSkills.mockReturnValue({ success: true, data: [] });
        mockedCreateSharedCollection.mockResolvedValue(detail);
        mockedUpdateSharedCollection.mockResolvedValue(detail);
        mockedGetSharedCollection.mockResolvedValue(detail);
        jest.mocked(publishCollectionPublicShare).mockResolvedValue({
          externalId: 'public-1',
          pinnedContentHash: 'new-hash',
          upToDate: true,
          sharePath: '/portal/plugins/collections/shared/shared-1',
          createdAt: 'c',
          updatedAt: 'u',
        });
        await expect(
          sharePortalCollection({ collectionId: 'abc', scope: 'public' }),
        ).resolves.toEqual({
          sharePath: '/portal/plugins/collections/shared/shared-1',
        });
        const writer =
          previousScope === 'new'
            ? mockedCreateSharedCollection
            : mockedUpdateSharedCollection;
        expect(writer).toHaveBeenCalledWith(
          expect.objectContaining({ shareScope: 'private' }),
        );
        expect(jest.mocked(publishCollectionPublicShare)).toHaveBeenCalledWith(
          detail.id,
        );
      },
    );

    it('treats a missing linked Collection as unshared after account verification', async () => {
      mockedReadCollectionConfig.mockResolvedValue({
        version: 2,
        collection: {
          id: 'abc',
          name: 'Pack',
          description: '',
          skills: [],
          plugins: [],
          mcpServers: [],
          createdAt: 'c',
          updatedAt: 'u',
          remote: {
            accountId: 'account-1',
            remoteId: 'missing-collection',
            contentHash: 'old-hash',
            shareScope: 'private',
            sharedAt: 'old-u',
          },
        },
      });
      mockedGetSharedCollection.mockRejectedValue({ status: 404 });

      await expect(getPortalExistingCollectionShare('abc')).resolves.toBeNull();
    });

    it('shares a Collection from local state with a team and returns no link', async (): Promise<void> => {
      primeShareableMarketplaceCache();
      mockedReadCollectionConfig.mockResolvedValue({
        version: 2,
        collection: {
          id: 'abc',
          name: 'Pack',
          description: 'Local collection',
          skills: [{ sourceId: 'custom:app', skillName: 'helper' }],
          plugins: [{ marketplaceId: 'mkt-share', pluginName: 'plugin' }],
          mcpServers: [],
          createdAt: 'c',
          updatedAt: 'u',
        },
      });
      mockedLoadSkills.mockReturnValue({
        success: true,
        data: [
          {
            name: 'helper',
            sourceId: 'custom:app',
            custom: true,
            description: 'custom',
            source: 'Local',
            installedAt: 'i',
            updatedAt: 'u',
            updateAvailable: false,
          },
        ],
      });
      mockedReadRawSkill.mockResolvedValue('# Raw skill');
      mockedCreateSharedCollection.mockResolvedValue({
        id: 'shared-1',
        name: 'Pack',
        description: 'Local collection',
        contentHash: 'hash',
        itemCounts: { skills: 0, plugins: 1, customSkills: 1 },
        shareScope: 'team',
        owner: {
          type: 'team',
          id: 'team-1',
          name: 'Team',
          organization: { id: 'org-1', name: 'Org' },
        },
        createdBy: { id: 'user-1', name: null, email: null },
        createdAt: 'c',
        updatedAt: 'u',
        canUpdate: true,
        canDelete: true,
        rawCollection: '{}',
        collection: {
          version: 1,
          name: 'Pack',
          description: 'Local collection',
          items: [],
        },
        customSkills: [],
      });

      await expect(
        sharePortalCollection({
          collectionId: 'abc',
          scope: 'team',
          teamId: 'team-1',
        }),
      ).resolves.toEqual({});

      expect(mockedReadCollectionConfig).toHaveBeenCalledWith('abc');
      expect(mockedReadRawSkill).toHaveBeenCalledWith('custom:app/helper');
      expect(mockedLoadCacheOnly).toHaveBeenCalled();
      expect(mockedLoadMarketplaces).not.toHaveBeenCalled();
      expect(mockedCreateSharedCollection).toHaveBeenCalledTimes(1);
      const request = mockedCreateSharedCollection.mock.calls[0]?.[0];
      const stringMatcher: unknown = expect.any(String);
      expect(request).toEqual({
        rawCollection: stringMatcher,
        customSkills: [
          {
            clientKey: stringMatcher,
            name: 'helper',
            rawSkill: '# Raw skill',
          },
        ],
        shareScope: 'team',
        sourceCollectionId: 'abc',
        teamId: 'team-1',
      });
      expect(JSON.parse(request?.rawCollection ?? 'null')).toEqual({
        version: 1,
        name: 'Pack',
        description: 'Local collection',
        items: [
          {
            type: 'custom_skill',
            clientKey: request?.customSkills?.[0]?.clientKey,
            skill_name: 'helper',
          },
          {
            type: 'claude_plugin',
            marketplace: { type: 'github', repo: 'acme/marketplace' },
            plugin_name: 'plugin',
          },
        ],
      });
    });

    it('updates the linked Collection and persists the refreshed metadata', async (): Promise<void> => {
      primeShareableMarketplaceCache();
      mockedReadCollectionConfig.mockResolvedValue({
        version: 2,
        collection: {
          id: 'abc',
          name: 'Pack',
          description: 'Updated collection',
          skills: [],
          plugins: [],
          mcpServers: [],
          createdAt: 'c',
          updatedAt: 'u',
          remote: {
            accountId: 'account-1',
            remoteId: 'shared-1',
            contentHash: 'old-hash',
            shareScope: 'private',
            sharedAt: 'old-u',
          },
        },
      });
      mockedLoadSkills.mockReturnValue({ success: true, data: [] });
      mockedUpdateSharedCollection.mockResolvedValue({
        id: 'shared-1',
        contentHash: 'new-hash',
        shareScope: 'organization',
        updatedAt: 'new-u',
      } as never);
      mockedGetSharedCollection.mockResolvedValue({
        id: 'shared-1',
        contentHash: 'server-hash',
      } as never);
      mockedWriteCollectionRemoteMetadata.mockResolvedValue(true);

      await expect(
        sharePortalCollection({
          collectionId: 'abc',
          scope: 'organization',
          organizationId: 'org-1',
        }),
      ).resolves.toEqual({});

      expect(mockedUpdateSharedCollection).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceCollectionId: 'abc',
          collectionId: 'shared-1',
          expectedContentHash: 'server-hash',
          shareScope: 'organization',
          organizationId: 'org-1',
        }),
      );
      expect(mockedCreateSharedCollection).not.toHaveBeenCalled();
      expect(mockedWriteCollectionRemoteMetadata).toHaveBeenCalledWith('abc', {
        accountId: 'account-1',
        remoteId: 'shared-1',
        contentHash: 'new-hash',
        shareScope: 'organization',
        sharedAt: 'new-u',
      });
    });

    it('refuses Portal sharing when a local skill needs a capability package', async (): Promise<void> => {
      primeShareableMarketplaceCache();
      mockedReadCollectionConfig.mockResolvedValue({
        version: 2,
        collection: {
          id: 'abc',
          name: 'Local package',
          description: '',
          skills: [
            { sourceId: 'local:release-fixture', skillName: 'release-notes' },
          ],
          plugins: [],
          mcpServers: [],
          createdAt: 'c',
          updatedAt: 'u',
        },
      });
      mockedLoadSkills.mockReturnValue({
        success: true,
        data: [
          {
            name: 'release-notes',
            sourceId: 'local:release-fixture',
            custom: false,
            description: 'local',
            source: '/fixtures/release-notes',
            installedAt: 'i',
            updatedAt: 'u',
            updateAvailable: false,
          },
        ],
      });

      await expect(
        sharePortalCollection({
          collectionId: 'abc',
          scope: 'team',
          teamId: 'team-1',
        }),
      ).rejects.toMatchObject({ code: 'invalid_payload' });
      expect(mockedReadRawSkill).not.toHaveBeenCalled();
      expect(mockedCreateSharedCollection).not.toHaveBeenCalled();
    });

    it.each(['team', 'organization', 'public', 'private'] as const)(
      'rejects MCP-backed collections for %s sharing',
      async (scope) => {
        primeShareableMarketplaceCache();
        mockedReadCollectionConfig.mockResolvedValue({
          version: 2,
          collection: {
            id: 'abc',
            name: 'MCP package',
            description: '',
            skills: [],
            plugins: [],
            mcpServers: [{ serverId: 'slack-local', configId: 'work' }],
            createdAt: 'c',
            updatedAt: 'u',
          },
        });
        mockedLoadSkills.mockReturnValue({ success: true, data: [] });

        await expect(
          sharePortalCollection({
            collectionId: 'abc',
            scope,
            teamId: 'team-1',
            organizationId: 'org-1',
          }),
        ).rejects.toMatchObject({ code: 'invalid_payload' });
        expect(mockedCreateSharedCollection).not.toHaveBeenCalled();
        expect(mockedUpdateSharedCollection).not.toHaveBeenCalled();
      },
    );

    it('does not mark an MCP-backed collection shareable', async (): Promise<void> => {
      mockedReadCollectionIndex.mockResolvedValue({
        version: 2,
        collections: [
          {
            id: 'plain',
            name: 'Plain',
            description: '',
            updatedAt: '2026-09-01T00:00:00.000Z',
            skillCount: 1,
            pluginCount: 0,
            mcpServerCount: 0,
          },
          {
            id: 'with-mcp',
            name: 'With MCP',
            description: '',
            updatedAt: '2026-09-01T00:00:00.000Z',
            skillCount: 1,
            pluginCount: 0,
            mcpServerCount: 2,
          },
        ],
      });

      // `plain` must be convertible for its `shareable: true` to mean
      // anything, so pin the config explicitly rather than relying on an
      // ambient mock. MCP rows remain shareable because only server names
      // become requirements; configuration never travels.
      mockedReadCollectionConfig.mockImplementation((id) =>
        Promise.resolve({
          version: 2,
          collection: {
            id,
            name: id === 'plain' ? 'Plain' : 'With MCP',
            description: '',
            skills: [],
            plugins: [],
            mcpServers: id === 'plain' ? [] : [{} as never],
            createdAt: '',
            updatedAt: '',
          },
        }),
      );

      const result = await listPortalCollections();
      expect(result.collections.map((row) => [row.id, row.shareable])).toEqual([
        ['plain', true],
        ['with-mcp', undefined],
      ]);
      expect(mockedReadCollectionConfig).toHaveBeenCalledTimes(2);
      expect(mockedReadCollectionConfig).toHaveBeenCalledWith('plain');
      expect(mockedReadCollectionConfig).toHaveBeenCalledWith('with-mcp');
    });

    it('listPortalCollections carries sharedSource on rows', async (): Promise<void> => {
      mockedReadCollectionIndex.mockResolvedValue({
        version: 2,
        collections: [
          {
            id: 'added',
            revision: 'opaque:index-revision',
            name: 'Added',
            description: '',
            updatedAt: '2026-09-01T00:00:00.000Z',
            skillCount: 0,
            pluginCount: 0,
            mcpServerCount: 0,
            sharedSource: { remoteId: 'remote-1', contentHash: 'hash-1' },
          },
          {
            id: 'own',
            name: 'Own',
            description: '',
            updatedAt: '2026-09-01T00:00:00.000Z',
            skillCount: 0,
            pluginCount: 0,
            mcpServerCount: 0,
          },
        ],
      });
      mockedReadCollectionConfig.mockResolvedValue(null);

      const result = await listPortalCollections();
      expect(result.collections[0]?.revision).toBe('opaque:index-revision');
      expect(result.collections[0]?.sharedSource).toEqual({
        remoteId: 'remote-1',
        contentHash: 'hash-1',
      });
      expect(result.collections[1]).not.toHaveProperty('sharedSource');
    });

    // Review on #3180: MCP is not the only blocker — sharing also rejects a
    // Collection whose skill is missing or whose plugin marketplace is not a
    // shareable source, so those must not advertise Share either.
    it('does not mark a Collection shareable when its refs cannot be converted', async (): Promise<void> => {
      mockedReadCollectionIndex.mockResolvedValue({
        version: 2,
        collections: [
          {
            id: 'dangling',
            name: 'Dangling',
            description: '',
            updatedAt: '2026-09-01T00:00:00.000Z',
            skillCount: 1,
            pluginCount: 0,
            mcpServerCount: 0,
          },
        ],
      });
      mockedReadCollectionConfig.mockResolvedValue({
        version: 2,
        collection: {
          id: 'dangling',
          name: 'Dangling',
          description: '',
          // References a skill that is not installed.
          skills: [{ sourceId: 'github:acme:skills', skillName: 'gone' }],
          plugins: [],
          mcpServers: [],
          createdAt: '',
          updatedAt: '',
        },
      });
      mockedLoadSkills.mockReturnValue({ success: true, data: [] });

      const result = await listPortalCollections();
      expect(result.collections.map((row) => [row.id, row.shareable])).toEqual([
        ['dangling', undefined],
      ]);
    });

    it('does not advertise Portal sharing for a local-skill Collection', async (): Promise<void> => {
      mockedReadCollectionIndex.mockResolvedValue({
        version: 2,
        collections: [
          {
            id: 'local-package',
            name: 'Local package',
            description: '',
            updatedAt: '2026-09-24T00:00:00.000Z',
            skillCount: 1,
            pluginCount: 0,
            mcpServerCount: 0,
          },
        ],
      });
      mockedReadCollectionConfig.mockResolvedValue({
        version: 2,
        collection: {
          id: 'local-package',
          name: 'Local package',
          description: '',
          skills: [
            { sourceId: 'local:release-fixture', skillName: 'release-notes' },
          ],
          plugins: [],
          mcpServers: [],
          createdAt: '',
          updatedAt: '',
        },
      });
      mockedLoadSkills.mockReturnValue({
        success: true,
        data: [
          {
            name: 'release-notes',
            sourceId: 'local:release-fixture',
            custom: false,
            description: 'local',
            source: '/fixtures/release-notes',
            installedAt: 'i',
            updatedAt: 'u',
            updateAvailable: false,
          },
        ],
      });
      primeShareableMarketplaceCache();

      const result = await listPortalCollections();

      expect(result.collections).toEqual([
        expect.objectContaining({ id: 'local-package' }),
      ]);
      expect(result.collections[0]).not.toHaveProperty('shareable');
    });

    it('refuses to share an unknown Collection without calling Cloud', async (): Promise<void> => {
      mockedReadCollectionConfig.mockResolvedValue(null);
      await expect(
        sharePortalCollection({
          collectionId: 'missing',
          scope: 'team',
          teamId: 'team-1',
        }),
      ).rejects.toMatchObject({ code: 'not_found' });
      expect(mockedCreateSharedCollection).not.toHaveBeenCalled();
    });

    it('lists collections from the index, and an MCP-carrying pack is not shareable', async (): Promise<void> => {
      mockedReadCollectionIndex.mockResolvedValue({
        version: 2,
        collections: [
          {
            id: 'abc',
            name: 'Pack',
            description: 'd',
            updatedAt: 'u',
            skillCount: 1,
            pluginCount: 2,
            mcpServerCount: 3,
          },
        ],
      });
      const result = await listPortalCollections();
      expect(result.collections).toEqual([
        {
          id: 'abc',
          name: 'Pack',
          description: 'd',
          updatedAt: 'u',
          skillCount: 1,
          pluginCount: 2,
          mcpServerCount: 3,
        },
      ]);
    });

    it('marks a local Collection that already has a Cloud share', async (): Promise<void> => {
      mockedReadCollectionIndex.mockResolvedValue({
        version: 2,
        collections: [
          {
            id: 'shared-local',
            name: 'Shared local',
            description: '',
            updatedAt: 'u',
            skillCount: 0,
            pluginCount: 0,
            mcpServerCount: 0,
          },
        ],
      });
      mockedReadCollectionConfig.mockResolvedValue({
        version: 2,
        collection: {
          id: 'shared-local',
          name: 'Shared local',
          description: '',
          skills: [],
          plugins: [],
          mcpServers: [],
          createdAt: 'c',
          updatedAt: 'u',
          remote: {
            remoteId: 'remote-1',
            accountId: 'account-1',
            contentHash: 'hash-1',
            shareScope: 'private',
            sharedAt: '2026-10-01T00:00:00.000Z',
          },
        },
      });

      await expect(listPortalCollections()).resolves.toEqual({
        collections: [
          expect.objectContaining({
            id: 'shared-local',
            shareable: true,
            hasExistingShare: true,
          }),
        ],
      });
    });

    it('returns an empty list for a genuinely empty index', async () => {
      // A missing index file resolves to an empty index inside
      // readCollectionIndex (legacy-migration path) — that is empty success.
      mockedReadCollectionIndex.mockResolvedValue({
        version: 2,
        collections: [],
      });
      await expect(listPortalCollections()).resolves.toEqual({
        collections: [],
      });
    });

    it('fails the list command when the Collection index cannot be read', async () => {
      // Same policy as listPortalSkills: a malformed index must not collapse
      // to an empty list the web client would render as "no collections".
      mockedReadCollectionIndex.mockRejectedValue(
        new Error('Malformed collections/index.json: unexpected token'),
      );
      await expect(listPortalCollections()).rejects.toThrow(
        'Malformed collections/index.json',
      );
    });

    it('returns the full config for an existing Collection', async () => {
      mockedReadCollectionConfig.mockResolvedValue({
        version: 2,
        collection: {
          id: 'abc',
          revision: 'opaque-revision:do-not-normalize',
          name: 'Pack',
          description: 'd',
          skills: [{ sourceId: 'src', skillName: 'review' }],
          plugins: [],
          mcpServers: [],
          createdAt: 'c',
          updatedAt: 'u',
        },
      });
      const result = await getPortalCollection('abc');
      expect(mockedReadCollectionConfig).toHaveBeenCalledWith('abc');
      expect(result.collection.skills).toEqual([
        { sourceId: 'src', skillName: 'review' },
      ]);
      expect(result.collection.revision).toBe(
        'opaque-revision:do-not-normalize',
      );
      expect(result.truncated).toBeUndefined();
    });

    it('preserves the exact revision when member lists exceed the response budget', async () => {
      mockedReadCollectionConfig.mockResolvedValue({
        version: 2,
        collection: {
          id: 'abc',
          revision: 'opaque-revision:large-snapshot',
          name: 'Large pack',
          description: '',
          skills: Array.from({ length: 30000 }, (_, index) => ({
            sourceId: 'source',
            skillName: `skill-${index}`,
          })),
          plugins: [],
          mcpServers: [],
          createdAt: 'c',
          updatedAt: 'u',
        },
      });
      const result = await getPortalCollection('abc');
      expect(result.collection.revision).toBe('opaque-revision:large-snapshot');
      expect(result.truncated).toBe(true);
      expect(result.collection.skills.length).toBeLessThan(30000);
      expect(
        Buffer.byteLength(JSON.stringify(result), 'utf8'),
      ).toBeLessThanOrEqual(PORTAL_CATALOG_RESULT_MAX_BYTES);
    });

    it('maps a missing Collection to not_found', async () => {
      mockedReadCollectionConfig.mockResolvedValue(null);
      await expect(getPortalCollection('abc')).rejects.toMatchObject({
        code: 'not_found',
      });
    });

    it('maps a store id rejection to invalid_payload', async () => {
      mockedReadCollectionConfig.mockRejectedValue(
        new Error('Invalid Collection id: ../abc'),
      );
      await expect(getPortalCollection('weird')).rejects.toMatchObject({
        code: 'invalid_payload',
      });
    });

    it('preserves a local snapshot authorization refusal', async () => {
      mockedReadCollectionConfig.mockRejectedValue(
        new ResourceContextUnavailableError('context-mismatch'),
      );
      await expect(getPortalCollection('abc')).rejects.toMatchObject({
        code: 'permission_denied',
        message: 'Resource unavailable (context-mismatch)',
      });
    });

    it('preserves coded store failures and unexpected execution failures', async () => {
      for (const error of [
        Object.assign(new Error('Access revoked'), {
          code: 'permission_denied',
        }),
        Object.assign(new Error('Collection changed'), { code: 'conflict' }),
        new Error('Disk unavailable'),
      ]) {
        mockedReadCollectionConfig.mockRejectedValue(error);
        await expect(getPortalCollection('abc')).rejects.toBe(error);
      }
    });
  });

  describe('savePortalCollection', () => {
    const draft = {
      name: 'Launch kit',
      description: 'Ship it',
      skills: [{ sourceId: 'github:acme/skills', skillName: 'review' }],
      plugins: [{ marketplaceId: 'mkt', pluginName: 'linter' }],
      mcpServers: [],
    };
    const stored = {
      id: 'abc',
      revision: 'rev-1',
      name: 'Old name',
      description: '',
      skills: [],
      plugins: [],
      mcpServers: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      remote: {
        accountId: 'account-a',
        remoteId: 'remote-own',
        contentHash: 'hash-own',
        shareScope: 'team' as const,
        sharedAt: '2026-01-02T00:00:00.000Z',
      },
      sharedSource: {
        remoteId: 'remote-added',
        fetchedAt: '2026-01-03T00:00:00.000Z',
        contentHash: 'hash-added',
      },
    };

    beforeEach(() => {
      mockedSaveCollectionConfig.mockImplementation((input) =>
        Promise.resolve({
          ...stored,
          ...input,
          id: input.id ?? 'new-id',
          skills: input.skills ?? [],
          plugins: input.plugins ?? [],
          mcpServers: input.mcpServers ?? [],
          createdAt: input.createdAt ?? '2026-10-14T00:00:00.000Z',
          updatedAt: '2026-10-14T00:00:00.000Z',
        }),
      );
    });

    it('creates a collection without an id', async () => {
      const result = await savePortalCollection(draft);
      expect(mockedReadCollectionConfig).not.toHaveBeenCalled();
      expect(mockedSaveCollectionConfig).toHaveBeenCalledWith(
        {
          name: 'Launch kit',
          description: 'Ship it',
          skills: draft.skills,
          plugins: draft.plugins,
          mcpServers: [],
        },
        undefined,
        expect.anything(),
      );
      expect(result.collection.id).toBe('new-id');
    });

    it('savePortalCollection ignores sharedSource and remote in the payload and preserves them on edit', async () => {
      mockedReadCollectionConfig.mockResolvedValue({
        version: 2,
        collection: stored,
      });
      await savePortalCollection({
        ...draft,
        id: 'abc',
        expectedRevision: 'rev-1',
        ...{
          sharedSource: { remoteId: 'forged', fetchedAt: 'now' },
          remote: { remoteId: 'forged' },
          createdAt: '1999-01-01T00:00:00.000Z',
        },
      });
      expect(mockedSaveCollectionConfig).toHaveBeenCalledWith(
        {
          id: 'abc',
          name: 'Launch kit',
          description: 'Ship it',
          skills: draft.skills,
          plugins: draft.plugins,
          mcpServers: [],
        },
        undefined,
        expect.objectContaining({ expectedRevision: 'rev-1' }),
      );
    });

    it('rejects an edit of an unknown id with not_found', async () => {
      mockedReadCollectionConfig.mockResolvedValue(null);
      await expect(
        savePortalCollection({
          ...draft,
          id: 'abc',
          expectedRevision: 'rev-1',
        }),
      ).rejects.toMatchObject({ code: 'not_found' });
      expect(mockedSaveCollectionConfig).not.toHaveBeenCalled();
    });

    it.each([undefined, null, '', 42, {}])(
      'refuses an edit with missing or malformed revision %p',
      async (expectedRevision) => {
        mockedReadCollectionConfig.mockResolvedValue({
          version: 2,
          collection: stored,
        });
        await expect(
          savePortalCollection({ ...draft, id: stored.id, expectedRevision }),
        ).rejects.toMatchObject({ code: 'conflict' });
        expect(mockedSaveCollectionConfig).not.toHaveBeenCalled();
      },
    );

    it('rejects a whitespace-only name', async () => {
      await expect(
        savePortalCollection({ ...draft, name: '   ' }),
      ).rejects.toMatchObject({ code: 'invalid_payload' });
      expect(mockedSaveCollectionConfig).not.toHaveBeenCalled();
    });

    it('rejects a malformed member ref', async () => {
      for (const malformed of [
        { ...draft, skills: [{ sourceId: 'src' }] },
        { ...draft, plugins: [{ pluginName: 'linter' }] },
        { ...draft, mcpServers: [{ serverId: 'srv' }] },
        { ...draft, skills: 'review' },
        { ...draft, description: 7 },
      ]) {
        await expect(savePortalCollection(malformed)).rejects.toMatchObject({
          code: 'invalid_payload',
        });
      }
      expect(mockedSaveCollectionConfig).not.toHaveBeenCalled();
    });

    it('rejects unsafe ids, empty references, stale edits and oversized payloads before save', async () => {
      for (const malformed of [
        { ...draft, id: 'not-safe' },
        { ...draft, skills: [{ sourceId: '', skillName: 'review' }] },
        { ...draft, mcpServers: [{ serverId: 'bad-path', configId: 'abc' }] },
        { ...draft, description: 'x'.repeat(PORTAL_CATALOG_RESULT_MAX_BYTES) },
      ]) {
        await expect(savePortalCollection(malformed)).rejects.toMatchObject({
          code: 'invalid_payload',
        });
      }
      mockedReadCollectionConfig.mockResolvedValue({
        version: 2,
        collection: stored,
      });
      await expect(
        savePortalCollection({ ...draft, id: stored.id }),
      ).rejects.toMatchObject({ code: 'conflict' });
      expect(mockedSaveCollectionConfig).not.toHaveBeenCalled();
    });

    it('does not turn resource authorization failures into invalid payload errors', async () => {
      mockedReadCollectionConfig.mockRejectedValue(
        Object.assign(new Error('Resource unavailable'), {
          code: 'permission_denied',
        }),
      );
      await expect(
        savePortalCollection({
          ...draft,
          id: stored.id,
          expectedRevision: 'rev',
        }),
      ).rejects.toMatchObject({ code: 'permission_denied' });
    });

    it('checks the complete result budget before committing metadata-heavy edits', async () => {
      mockedReadCollectionConfig.mockResolvedValue({
        version: 2,
        collection: stored,
      });
      mockedSaveCollectionConfig.mockImplementation(
        (_input, _prepared, guard) => {
          guard?.validatePrepared?.({
            ...stored,
            description: 'x'.repeat(PORTAL_CATALOG_RESULT_MAX_BYTES),
          });
          return Promise.resolve(stored);
        },
      );
      await expect(
        savePortalCollection({
          ...draft,
          id: stored.id,
          expectedRevision: stored.revision,
        }),
      ).rejects.toMatchObject({ code: 'invalid_payload' });
    });

    it('maps a store rejection on save to invalid_payload', async () => {
      mockedSaveCollectionConfig.mockRejectedValue(
        new Error('Invalid MCP server reference in Collection'),
      );
      await expect(savePortalCollection(draft)).rejects.toMatchObject({
        code: 'invalid_payload',
      });
    });
  });

  describe('size budgets', () => {
    it('truncates bodies by UTF-8 BYTES on a code-point boundary', async () => {
      // '€' is 3 UTF-8 bytes but 1 UTF-16 code unit: a char-count cap would
      // let ~3x the byte budget through. Choose a length that is NOT a
      // multiple of 3 away from the cap so a naive byte slice would cut
      // mid-character.
      const euros = '€'.repeat(
        Math.floor(PORTAL_CATALOG_CONTENT_MAX_BYTES / 3) + 10,
      );
      mockedReadSkillContent.mockReturnValue({
        success: true,
        data: { frontmatter: {}, body: euros },
      });

      const content = await readPortalSkill('src', 'review');

      expect(content.truncated).toBe(true);
      const byteLength = Buffer.byteLength(content.body, 'utf8');
      expect(byteLength).toBeLessThanOrEqual(PORTAL_CATALOG_CONTENT_MAX_BYTES);
      // A boundary-safe cut ends on a complete '€' (no replacement char) and
      // sits within one code point of the cap.
      expect(content.body.endsWith('€')).toBe(true);
      expect(content.body.includes('�')).toBe(false);
      expect(byteLength).toBeGreaterThan(PORTAL_CATALOG_CONTENT_MAX_BYTES - 4);
    });

    it('caps an oversized skill inventory at the result byte budget', async () => {
      // ~2000 skills x ~1KB descriptions ≈ 2MB serialized — far over the
      // event cap without the whole-result guard.
      mockedLoadSkills.mockReturnValue({
        success: true,
        data: Array.from({ length: 2000 }, (_, index) => ({
          name: `skill-${index}`,
          sourceId: 'src',
          description: 'd'.repeat(1024),
          source: 'GitHub',
          installedAt: 'i',
          updatedAt: 'u',
          updateAvailable: false,
        })),
      });

      const result = await listPortalSkills();

      expect(result.truncated).toBe(true);
      expect(result.skills.length).toBeGreaterThan(0);
      expect(result.skills.length).toBeLessThan(2000);
      expect(
        Buffer.byteLength(JSON.stringify(result), 'utf8'),
      ).toBeLessThanOrEqual(PORTAL_CATALOG_RESULT_MAX_BYTES);
      // Deterministic prefix cut: the first rows survive in order.
      expect(result.skills[0].name).toBe('skill-0');
      expect(result.skills[1].name).toBe('skill-1');
    });

    it('caps an oversized marketplace inventory at the result byte budget', async () => {
      mockedLoadCacheOnly.mockResolvedValue({
        success: true,
        data: {
          version: 2,
          lastRefreshed: '2026-08-27T00:00:00.000Z',
          marketplaces: Array.from({ length: 400 }, (_, index) => ({
            ...marketplace,
            id: `mkt-${index}`,
            description: 'm'.repeat(4096),
          })),
        },
      });

      const result = await listPortalMarketplaces();

      expect(result.truncated).toBe(true);
      expect(result.marketplaces.length).toBeGreaterThan(0);
      expect(result.marketplaces.length).toBeLessThan(400);
      expect(
        Buffer.byteLength(JSON.stringify(result), 'utf8'),
      ).toBeLessThanOrEqual(PORTAL_CATALOG_RESULT_MAX_BYTES);
      expect(result.marketplaces[0].id).toBe('mkt-0');
    });

    it('drops the README before the component lists on an oversized detail', async () => {
      primeMarketplaceCache();
      mockedReadComponentContent.mockReturnValue({
        success: true,
        data: {
          frontmatter: {},
          // Body at the per-body cap plus a plugin row that is itself huge:
          // the whole result exceeds the budget only with the README present.
          body: 'r'.repeat(PORTAL_CATALOG_CONTENT_MAX_BYTES),
        },
      });
      const bigDescription = 'p'.repeat(
        PORTAL_CATALOG_RESULT_MAX_BYTES - PORTAL_CATALOG_CONTENT_MAX_BYTES,
      );
      mockedLoadCacheOnly.mockResolvedValue({
        success: true,
        data: {
          version: 2,
          lastRefreshed: '2026-08-27T00:00:00.000Z',
          marketplaces: [
            {
              ...marketplace,
              plugins: [
                {
                  ...marketplace.plugins[0],
                  description: bigDescription,
                },
              ],
            },
          ],
        },
      });

      const detail = await getPortalPluginDetail('mkt', 'plugin');

      // Ladder order: the README BODY shrinks first (serialized measurement),
      // keeping a smaller README and the component lists intact.
      expect(detail.truncated).toBe(true);
      expect(detail.readme?.truncated).toBe(true);
      expect(Buffer.byteLength(detail.readme?.body ?? '', 'utf8')).toBeLessThan(
        PORTAL_CATALOG_CONTENT_MAX_BYTES,
      );
      expect(detail.details?.hasReadme).toBe(true);
      expect(
        Buffer.byteLength(JSON.stringify(detail), 'utf8'),
      ).toBeLessThanOrEqual(PORTAL_CATALOG_RESULT_MAX_BYTES);
    });

    it('accounts for JSON escaping expansion of control-character bodies', async () => {
      // A NUL-heavy body at the per-body byte cap serializes to ~6x its raw
      // size ("\u0000" per character) — the SERIALIZED envelope is what must
      // fit the budget.
      mockedReadSkillContent.mockReturnValue({
        success: true,
        data: {
          frontmatter: { name: 'nul' },
          body: '\u0000'.repeat(PORTAL_CATALOG_CONTENT_MAX_BYTES),
        },
      });

      const content = await readPortalSkill('src', 'review');

      expect(content.truncated).toBe(true);
      expect(content.body.length).toBeGreaterThan(0);
      expect(
        Buffer.byteLength(JSON.stringify(content), 'utf8'),
      ).toBeLessThanOrEqual(PORTAL_CATALOG_RESULT_MAX_BYTES);
    });

    it('throws when even the minimal envelope exceeds the budget', async () => {
      // A pathological fixed field (huge server description) survives every
      // ladder step — the command must FAIL rather than emit an undeliverable
      // portal event.
      mockedReadServer.mockResolvedValue({
        version: 1,
        server: {
          definition: {
            id: 'abc',
            name: 'Huge',
            description: 'h'.repeat(2 * PORTAL_CATALOG_RESULT_MAX_BYTES),
            type: 'http',
            createdAt: 'c',
            updatedAt: 'u',
          },
          configs: [],
        },
      });

      await expect(getPortalMcpServer('abc')).rejects.toThrow(/size budget/);
    });

    it('degrades every command result to within the serialized budget', async () => {
      // One oversized fixture per family; every degraded result must pass the
      // budget check.
      primeMarketplaceCache();
      mockedReadComponentContent.mockReturnValue({
        success: true,
        data: {
          frontmatter: { big: ''.repeat(1024) },
          body: '\u0000'.repeat(PORTAL_CATALOG_CONTENT_MAX_BYTES),
        },
      });
      mockedLoadSkills.mockReturnValue({
        success: true,
        data: Array.from({ length: 1500 }, (_, index) => ({
          name: `skill-${index}`,
          sourceId: 'src',
          description: 'd'.repeat(1024),
          source: 'GitHub',
          installedAt: 'i',
          updatedAt: 'u',
          updateAvailable: false,
        })),
      });
      mockedReadSkillContent.mockReturnValue({
        success: true,
        data: {
          frontmatter: {},
          body: '\u0000'.repeat(PORTAL_CATALOG_CONTENT_MAX_BYTES),
        },
      });
      mockedReadFile.mockResolvedValue(
        JSON.stringify({
          version: 1,
          servers: Array.from({ length: 3000 }, (_, index) => ({
            id: `srv-${index}`,
            name: `Server ${index}`,
            description: 's'.repeat(512),
            type: 'http',
            configs: [{ id: 'cfg', name: 'Default', enabled: true }],
            updatedAt: 'u',
          })),
        }),
      );
      mockedReadServer.mockResolvedValue({
        version: 1,
        server: {
          definition: {
            id: 'abc',
            name: 'GitHub',
            description: 'd',
            type: 'http',
            createdAt: 'c',
            updatedAt: 'u',
          },
          configs: Array.from({ length: 5000 }, (_, index) => ({
            id: `cfg-${index}`,
            name: `Config ${index}`,
            description: 'c'.repeat(256),
            enabled: true,
            envVars: {},
            extraArgs: [],
            extraHeaders: {},
            createdAt: 'c',
            updatedAt: 'u',
          })),
        },
      });
      mockedReadCollectionIndex.mockResolvedValue({
        version: 2,
        collections: Array.from({ length: 4000 }, (_, index) => ({
          id: `col-${index}`,
          name: `Collection ${index}`,
          description: 'c'.repeat(256),
          updatedAt: 'u',
          skillCount: 1,
          pluginCount: 0,
          mcpServerCount: 0,
        })),
      });
      mockedReadCollectionConfig.mockResolvedValue({
        version: 2,
        collection: {
          id: 'abc',
          name: 'Pack',
          description: 'd',
          skills: Array.from({ length: 30000 }, (_, index) => ({
            sourceId: `source-${index}`,
            skillName: `skill-${index}`,
          })),
          plugins: [],
          mcpServers: [],
          createdAt: 'c',
          updatedAt: 'u',
        },
      });

      const results: unknown[] = [
        await listPortalMarketplaces(),
        await getPortalPluginDetail('mkt', 'plugin'),
        await readPortalPluginComponent('mkt', 'plugin', 'skills/s/SKILL.md'),
        await listPortalSkills(),
        await readPortalSkill('src', 'review'),
        await listPortalMcpServers(),
        await getPortalMcpServer('abc'),
        await listPortalCollections(),
        await getPortalCollection('abc'),
      ];
      for (const result of results) {
        expect(
          Buffer.byteLength(JSON.stringify(result), 'utf8'),
        ).toBeLessThanOrEqual(PORTAL_CATALOG_RESULT_MAX_BYTES);
      }
    });
  });

  describe('URL sanitization belt-and-braces', () => {
    it('no command result ever carries a URL with userinfo', async () => {
      const userinfoPattern = /:\/\/[^/]*@/;
      primeMarketplaceCache();
      mockedReadComponentContent.mockReturnValue({
        success: true,
        data: { frontmatter: {}, body: '# readme' },
      });
      mockedLoadSkills.mockReturnValue({
        success: true,
        data: [
          {
            name: 'review',
            sourceId: 'src',
            description: 'd',
            source: 'GitHub',
            installedAt: 'i',
            updatedAt: 'u',
            updateAvailable: false,
          },
        ],
      });
      mockedReadSkillContent.mockReturnValue({
        success: true,
        data: { frontmatter: {}, body: 'body' },
      });
      mockedReadFile.mockResolvedValue(
        JSON.stringify({
          version: 1,
          servers: [
            {
              id: 'abc',
              name: 'GitHub',
              description: 'd',
              type: 'http',
              configs: [{ id: 'cfg', name: 'Default', enabled: true }],
              updatedAt: 'u',
              logoUrl: 'https://logo-user:secret@cdn.example/logo.png',
            },
          ],
        }),
      );
      mockedReadServer.mockResolvedValue({
        version: 1,
        server: {
          definition: {
            id: 'abc',
            name: 'GitHub',
            description: 'd',
            type: 'http',
            url: 'https://url-user:secret@example.com/mcp',
            oauth: {
              authorizationUrl: 'https://oauth-user:secret@idp.example/auth',
              tokenUrl: 'https://token-user:secret@idp.example/token',
            },
            curated: {
              key: 'github',
              logoUrl: 'https://curated-user:secret@cdn.example/logo.png',
              docsUrl: 'https://docs-user:secret@docs.example/',
            },
            createdAt: 'c',
            updatedAt: 'u',
          },
          configs: [],
        },
      });
      mockedReadCollectionIndex.mockResolvedValue({
        version: 2,
        collections: [
          {
            id: 'abc',
            name: 'Pack',
            description: 'd',
            updatedAt: 'u',
            skillCount: 0,
            pluginCount: 0,
            mcpServerCount: 0,
          },
        ],
      });
      mockedReadCollectionConfig.mockResolvedValue({
        version: 2,
        collection: {
          id: 'abc',
          name: 'Pack',
          description: 'd',
          skills: [],
          plugins: [],
          mcpServers: [],
          createdAt: 'c',
          updatedAt: 'u',
        },
      });

      const results: Array<[string, unknown]> = [
        ['plugins.list_marketplaces', await listPortalMarketplaces()],
        [
          'plugins.get_plugin_detail',
          await getPortalPluginDetail('mkt', 'plugin'),
        ],
        [
          'plugins.read_component_content',
          await readPortalPluginComponent('mkt', 'plugin', 'skills/s/SKILL.md'),
        ],
        ['skills.list', await listPortalSkills()],
        ['skills.read', await readPortalSkill('src', 'review')],
        ['mcp.list_servers', await listPortalMcpServers()],
        ['mcp.get_server', await getPortalMcpServer('abc')],
        ['collections.list', await listPortalCollections()],
        ['collections.get', await getPortalCollection('abc')],
      ];
      for (const [command, result] of results) {
        const serialized = JSON.stringify(result);
        expect(`${command}:${userinfoPattern.test(serialized)}`).toBe(
          `${command}:false`,
        );
      }
    });
  });
});

it('projects cached status once per list and excludes nested service secrets', async () => {
  mockedListMcpStatuses.mockClear();
  mockedReadFile.mockResolvedValue(
    JSON.stringify({
      servers: [
        {
          id: 'abc',
          name: 'Server',
          description: '',
          type: 'command',
          configs: [{ id: 'def', name: 'Default', enabled: true }],
          updatedAt: '',
        },
      ],
    }),
  );
  mockedListMcpStatuses.mockResolvedValue([
    {
      serverId: 'abc',
      transport: 'command',
      connectionStatus: 'unreachable',
      reachability: 'unreachable',
      lastCheckedAt: '2026-10-18T12:00:00Z',
      configs: [
        {
          configId: 'def',
          authStatus: 'unsupported',
          lastError: 'SECRET',
          authErrorRevision: 'SECRET',
        },
      ],
    },
  ]);
  const result = await listPortalMcpServers();
  expect(listMcpServerStatuses).toHaveBeenCalledTimes(1);
  expect(result.servers[0]?.status).toEqual({
    connectionStatus: 'unreachable',
    reachability: 'unreachable',
    lastCheckedAt: '2026-10-18T12:00:00Z',
    configs: [{ configId: 'def', authStatus: 'unsupported' }],
  });
  expect(JSON.stringify(result)).not.toContain('SECRET');
});

it('keeps list/detail cached health consistent and positively identifies a device management target', async () => {
  const file: McpServerFile = {
    version: 1,
    server: {
      definition: {
        id: 'abc',
        name: 'Server',
        description: '',
        type: 'command',
        command: 'server',
        createdAt: '',
        updatedAt: '',
      },
      configs: [
        {
          id: 'def',
          name: 'Default',
          description: '',
          enabled: true,
          envVars: {},
          extraArgs: [],
          extraHeaders: {},
          createdAt: '',
          updatedAt: '',
        },
      ],
    },
  };
  mockedReadServer.mockResolvedValue(file);
  mockedListMcpStatuses.mockResolvedValue([
    {
      serverId: 'abc',
      transport: 'command',
      connectionStatus: 'unreachable',
      reachability: 'unreachable',
      configs: [{ configId: 'def', authStatus: 'unsupported' }],
      lastCheckedAt: '2026-10-18T12:00:00Z',
    },
  ]);
  mockedReadFile.mockResolvedValue(
    JSON.stringify({
      servers: [
        {
          id: 'abc',
          name: 'Server',
          description: '',
          type: 'command',
          configs: [{ id: 'def', name: 'Default', enabled: true }],
          updatedAt: '',
        },
      ],
    }),
  );
  const list = await listPortalMcpServers();
  const detail = await getPortalMcpServer('abc');
  expect(detail.server.status).toEqual(list.servers[0]?.status);
  expect(detail.server.managementTarget).toEqual({
    serverId: 'abc',
    testConfigIds: ['def'],
  });
});

it('counts nested status data against the catalog result budget (CAN-4265)', async () => {
  const configId = 'a'.repeat(
    Math.floor(PORTAL_CATALOG_RESULT_MAX_BYTES * 0.6),
  );
  mockedReadFile.mockResolvedValue(
    JSON.stringify({
      servers: [
        {
          id: 'abc',
          name: 'Server',
          description: '',
          type: 'command',
          configs: [{ id: configId, name: 'Default', enabled: true }],
          updatedAt: '',
        },
      ],
    }),
  );
  mockedListMcpStatuses.mockResolvedValue([]);
  expect((await listPortalMcpServers()).servers).toHaveLength(1);
  mockedListMcpStatuses.mockResolvedValue([
    {
      serverId: 'abc',
      transport: 'command',
      connectionStatus: 'unknown',
      reachability: 'unknown',
      configs: [{ configId, authStatus: 'unsupported' }],
    },
  ]);
  const result = await listPortalMcpServers();
  expect(result.truncated).toBe(true);
  expect(result.servers).toEqual([]);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
    PORTAL_CATALOG_RESULT_MAX_BYTES,
  );
});

it('projects exact account configuration health even without a device index (CAN-4265 seam)', async () => {
  mockedLoadAccountConnections.mockClear();
  mockedListMcpStatuses.mockClear();
  mockedReadFile.mockRejectedValue(
    Object.assign(new Error('missing'), { code: 'ENOENT' }),
  );
  const personal: AccountMcpConnection = {
    id: 'personal',
    serverKey: 'linear',
    configId: 'default',
    displayName: 'Linear',
    status: 'CONNECTED',
    routeId: 'route',
    enabledTools: null,
    kind: 'CURATED',
  };
  Object.assign(personal, {
    credentials: { token: 'ACCOUNT_SECRET' },
    routeId: 'ACCOUNT_SECRET',
  });
  mockedLoadAccountConnections.mockResolvedValue([
    personal,
    { ...personal, id: 'work', configId: 'work' },
  ]);
  mockedListMcpStatuses.mockResolvedValue([
    {
      serverId: 'linear',
      transport: 'http',
      handler: 'account',
      connectionStatus: 'auth_required',
      reachability: 'unknown',
      configs: [{ configId: 'default', authStatus: 'error' }],
    },
    {
      serverId: 'linear',
      transport: 'http',
      handler: 'account',
      connectionStatus: 'connected',
      reachability: 'unknown',
      configs: [{ configId: 'work', authStatus: 'connected' }],
    },
  ]);
  const result = await listPortalMcpServers();
  expect(
    result.servers.map((row) => [
      row.configs[0]?.id,
      row.status?.connectionStatus,
    ]),
  ).toEqual([
    ['default', 'auth_required'],
    ['work', 'connected'],
  ]);
  expect(JSON.stringify(result)).not.toContain('ACCOUNT_SECRET');
  expect(mockedLoadAccountConnections).toHaveBeenCalledTimes(1);
  expect(mockedListMcpStatuses).toHaveBeenCalledTimes(1);
});
