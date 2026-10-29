/**
 * Adapter tests for the read-only portal Plugins-section browse commands
 * (design: docs/planning/2026-08-27-portal-plugins-section/design.md, PR 3).
 * The catalog service is mocked; these tests pin the adapter contract:
 * payload validation → invalid_payload, service results → completed, service
 * throws → execution_failed (or the thrown error's own stable code).
 */
import type {
  PortalCommandEnvelope,
  PortalEventEnvelope,
} from '@canopy/desktop-shared/types';
import {
  handlePortalCollectionsGet,
  handlePortalCollectionsList,
  handlePortalMarketplaceAdd,
  handlePortalMarketplaceRefreshAll,
  handlePortalMarketplaceRemove,
  handlePortalMarketplaceUpdate,
  handlePortalMcpGetServer,
  handlePortalMcpTestConnection,
  handlePortalMcpDeleteServer,
  handlePortalMcpListServers,
  handlePortalMcpSetConfigEnabled,
  handlePortalPluginsGetPluginDetail,
  handlePortalPluginsInstallBuiltin,
  handlePortalPluginsInstallExternal,
  handlePortalPluginsListMarketplaces,
  handlePortalPluginsReadComponentContent,
  handlePortalSkillsList,
  handlePortalSkillsRead,
  handlePortalPluginsSharePlugin,
  handlePortalSharingExistingShare,
} from '../plugin-catalog-adapter';
import type { PortalAdapterContext } from '../types';
import {
  addPortalMarketplace,
  getPortalCollection,
  getPortalMcpServer,
  getPortalPluginDetail,
  installPortalBuiltInPlugin,
  installPortalExternalPlugin,
  listPortalCollections,
  listPortalMarketplaces,
  listPortalMcpServers,
  listPortalSkills,
  readPortalPluginComponent,
  readPortalSkill,
  removePortalMarketplace,
  setPortalMcpConfigEnabled,
  testPortalMcpConnection,
  deletePortalMcpServer,
  startPortalMarketplacesRefresh,
  updatePortalMarketplace,
  sharePortalPlugin,
  getPortalExistingSkillShare,
} from '../../../services/plugin-catalog-service';

const mockNotifyDesktopInventoryChanged = jest.fn();
jest.mock('../../../services/desktop-inventory-sync-signals', () => ({
  notifyDesktopInventoryChanged: (...args: unknown[]): unknown =>
    mockNotifyDesktopInventoryChanged(...args),
}));

jest.mock('../../../services/plugin-catalog-service', () => ({
  addPortalMarketplace: jest.fn(),
  getPortalCollection: jest.fn(),
  getPortalMcpServer: jest.fn(),
  getPortalPluginDetail: jest.fn(),
  installPortalBuiltInPlugin: jest.fn(),
  installPortalExternalPlugin: jest.fn(),
  listPortalCollections: jest.fn(),
  listPortalMarketplaces: jest.fn(),
  listPortalMcpServers: jest.fn(),
  listPortalSkills: jest.fn(),
  readPortalPluginComponent: jest.fn(),
  readPortalSkill: jest.fn(),
  removePortalMarketplace: jest.fn(),
  sharePortalPlugin: jest.fn(),
  getPortalExistingSkillShare: jest.fn(),
  setPortalMcpConfigEnabled: jest.fn(),
  testPortalMcpConnection: jest.fn(),
  deletePortalMcpServer: jest.fn(),
  startPortalMarketplacesRefresh: jest.fn(),
  updatePortalMarketplace: jest.fn(),
}));

const mockedTestPortalMcpConnection = jest.mocked(testPortalMcpConnection);
const mockedListMarketplaces = jest.mocked(listPortalMarketplaces);
const mockedGetPluginDetail = jest.mocked(getPortalPluginDetail);
const mockedSharePlugin = jest.mocked(sharePortalPlugin);
const mockedGetExistingSkillShare = jest.mocked(getPortalExistingSkillShare);
const mockedReadComponent = jest.mocked(readPortalPluginComponent);
const mockedListSkills = jest.mocked(listPortalSkills);
const mockedReadSkill = jest.mocked(readPortalSkill);
const mockedListServers = jest.mocked(listPortalMcpServers);
const mockedGetServer = jest.mocked(getPortalMcpServer);
const mockedListCollections = jest.mocked(listPortalCollections);
const mockedGetCollection = jest.mocked(getPortalCollection);
const mockedInstallBuiltIn = jest.mocked(installPortalBuiltInPlugin);
const mockedInstallExternal = jest.mocked(installPortalExternalPlugin);
const mockedAddMarketplace = jest.mocked(addPortalMarketplace);
const mockedUpdateMarketplace = jest.mocked(updatePortalMarketplace);
const mockedRemoveMarketplace = jest.mocked(removePortalMarketplace);
const mockedStartRefresh = jest.mocked(startPortalMarketplacesRefresh);
const mockedSetMcpConfigEnabled = jest.mocked(setPortalMcpConfigEnabled);

/** Drain the detached off-loop completion chain (import + service + settle). */
async function flushOffLoop(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function command(
  type: PortalCommandEnvelope['type'],
  payload: unknown,
): PortalCommandEnvelope {
  return {
    id: 'cmd-1',
    sequence: 7,
    type,
    payload,
    createdAt: '2026-08-27T00:00:00.000Z',
    expiresAt: null,
  } as PortalCommandEnvelope;
}

function adapterContext(events: PortalEventEnvelope[]): PortalAdapterContext {
  return {
    getWindow: () => null,
    enqueueEvent: (event) => events.push(event),
    complete: (cmd, result): void => {
      events.push({
        type: 'portal.command.completed',
        commandId: cmd.id,
        payload: { result },
      } as PortalEventEnvelope);
    },
    fail: (cmd, code, message): void => {
      events.push({
        type: 'portal.command.failed',
        commandId: cmd.id,
        payload: { error: { code, message } },
      } as PortalEventEnvelope);
    },
  };
}

function failureCode(events: PortalEventEnvelope[]): string | undefined {
  const payload = events[0]?.payload as
    | { error?: { code?: string } }
    | undefined;
  return payload?.error?.code;
}

describe('plugin-catalog portal adapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('completes list_marketplaces with the service result', async () => {
    const events: PortalEventEnvelope[] = [];
    const result = { marketplaces: [], lastRefreshed: '2026-08-27' };
    mockedListMarketplaces.mockResolvedValue(result);

    await handlePortalPluginsListMarketplaces(
      command('portal.plugins.list_marketplaces', {
        projectId: 'ws-1',
      }) as Parameters<typeof handlePortalPluginsListMarketplaces>[0],
      adapterContext(events),
    );

    expect(mockedListMarketplaces).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'portal.command.completed',
        payload: { result },
      }),
    ]);
  });

  it('completes get_plugin_detail with the service result', async () => {
    const events: PortalEventEnvelope[] = [];
    const detail = {
      marketplaceId: 'mkt',
      marketplaceName: 'Marketplace',
      plugin: {
        name: 'plugin',
        marketplaceId: 'mkt',
        providerSupport: { claude: 'native', codex: 'none' },
        installed: true,
      },
      details: null,
      readme: { body: '# Plugin', truncated: false },
    };
    mockedGetPluginDetail.mockResolvedValue(
      detail as Awaited<ReturnType<typeof getPortalPluginDetail>>,
    );

    await handlePortalPluginsGetPluginDetail(
      command('portal.plugins.get_plugin_detail', {
        projectId: 'ws-1',
        marketplaceId: 'mkt',
        pluginName: 'plugin',
      }) as Parameters<typeof handlePortalPluginsGetPluginDetail>[0],
      adapterContext(events),
    );

    expect(mockedGetPluginDetail).toHaveBeenCalledWith('mkt', 'plugin');
    expect(events[0]).toMatchObject({
      type: 'portal.command.completed',
      payload: { result: detail },
    });
  });

  // CAN-2829: the web Marketplace shares a plugin through the paired desktop.
  it('completes share_plugin with the share path the service minted', async () => {
    const events: PortalEventEnvelope[] = [];
    mockedSharePlugin.mockResolvedValue({ sharePath: '/share/plugins/abc' });

    handlePortalPluginsSharePlugin(
      command('portal.plugins.share_plugin', {
        projectId: 'ws-1',
        marketplaceId: 'mkt',
        pluginName: 'plugin',
        scope: 'team',
        teamId: 'team-1',
      }),
      adapterContext(events),
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockedSharePlugin).toHaveBeenCalledWith({
      marketplaceId: 'mkt',
      pluginName: 'plugin',
      scope: 'team',
      teamId: 'team-1',
    });
    expect(events[0]).toMatchObject({
      type: 'portal.command.completed',
      payload: { result: { sharePath: '/share/plugins/abc' } },
    });
  });

  it('fails share_plugin without marketplaceId and pluginName', async () => {
    const events: PortalEventEnvelope[] = [];
    handlePortalPluginsSharePlugin(
      command('portal.plugins.share_plugin', {
        projectId: 'ws-1',
      }),
      adapterContext(events),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockedSharePlugin).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({
      type: 'portal.command.failed',
      payload: { error: { code: 'invalid_payload' } },
    });
  });

  it('loads the existing Skill share off-loop', async () => {
    const events: PortalEventEnvelope[] = [];
    mockedGetExistingSkillShare.mockResolvedValue({
      audience: 'team',
      target: { id: 'team-1', name: 'Team' },
    });

    handlePortalSharingExistingShare(
      command('portal.sharing.existing_share', {
        projectId: 'ws-1',
        resourceType: 'skill',
        sourceId: 'custom:app',
        skillName: 'helper',
      }),
      adapterContext(events),
    );
    await flushOffLoop();

    expect(mockedGetExistingSkillShare).toHaveBeenCalledWith({
      sourceId: 'custom:app',
      skillName: 'helper',
    });
    expect(events[0]).toMatchObject({
      type: 'portal.command.completed',
      payload: {
        result: {
          existingShare: {
            audience: 'team',
            target: { id: 'team-1', name: 'Team' },
          },
        },
      },
    });
  });

  it('completes read_component_content and forwards the file argument', async () => {
    const events: PortalEventEnvelope[] = [];
    const content = { frontmatter: {}, body: 'content', truncated: false };
    mockedReadComponent.mockResolvedValue(content);

    await handlePortalPluginsReadComponentContent(
      command('portal.plugins.read_component_content', {
        projectId: 'ws-1',
        marketplaceId: 'mkt',
        pluginName: 'plugin',
        componentType: 'skill',
        componentFile: 'skills/review/SKILL.md',
      }) as Parameters<typeof handlePortalPluginsReadComponentContent>[0],
      adapterContext(events),
    );

    expect(mockedReadComponent).toHaveBeenCalledWith(
      'mkt',
      'plugin',
      'skills/review/SKILL.md',
    );
    expect(events[0]).toMatchObject({
      type: 'portal.command.completed',
      payload: { result: content },
    });
  });

  it('completes skills.list and skills.read with service results', async () => {
    const events: PortalEventEnvelope[] = [];
    mockedListSkills.mockResolvedValue({ skills: [] });
    mockedReadSkill.mockResolvedValue({
      frontmatter: { description: 'd' },
      body: 'skill body',
      truncated: false,
    });

    await handlePortalSkillsList(
      command('portal.skills.list', { projectId: 'ws-1' }) as Parameters<
        typeof handlePortalSkillsList
      >[0],
      adapterContext(events),
    );
    await handlePortalSkillsRead(
      command('portal.skills.read', {
        projectId: 'ws-1',
        sourceId: 'src',
        skillName: 'review',
      }) as Parameters<typeof handlePortalSkillsRead>[0],
      adapterContext(events),
    );

    expect(mockedReadSkill).toHaveBeenCalledWith('src', 'review');
    expect(events.map((event) => event.type)).toEqual([
      'portal.command.completed',
      'portal.command.completed',
    ]);
    expect(mockNotifyDesktopInventoryChanged).toHaveBeenCalledWith(['skills']);
  });

  it('completes mcp.list_servers and mcp.get_server with service results', async () => {
    const events: PortalEventEnvelope[] = [];
    mockedListServers.mockResolvedValue({ servers: [] });
    const server = {
      server: {
        id: 'abc',
        name: 'GitHub',
        description: '',
        type: 'http' as const,
        createdAt: 'c',
        updatedAt: 'u',
        configs: [],
      },
    };
    mockedGetServer.mockResolvedValue(server);

    await handlePortalMcpListServers(
      command('portal.mcp.list_servers', { projectId: 'ws-1' }) as Parameters<
        typeof handlePortalMcpListServers
      >[0],
      adapterContext(events),
    );
    await handlePortalMcpGetServer(
      command('portal.mcp.get_server', {
        projectId: 'ws-1',
        serverId: 'abc',
      }) as Parameters<typeof handlePortalMcpGetServer>[0],
      adapterContext(events),
    );

    expect(mockedGetServer).toHaveBeenCalledWith('abc');
    expect(events[1]).toMatchObject({
      type: 'portal.command.completed',
      payload: { result: server },
    });
  });

  it('completes collections.list and collections.get with service results', async () => {
    const events: PortalEventEnvelope[] = [];
    mockedListCollections.mockResolvedValue({ collections: [] });
    const collection = {
      collection: {
        id: 'abc',
        name: 'Pack',
        description: '',
        skills: [],
        plugins: [],
        mcpServers: [],
        createdAt: 'c',
        updatedAt: 'u',
      },
    };
    mockedGetCollection.mockResolvedValue(collection);

    await handlePortalCollectionsList(
      command('portal.collections.list', { projectId: 'ws-1' }) as Parameters<
        typeof handlePortalCollectionsList
      >[0],
      adapterContext(events),
    );
    await handlePortalCollectionsGet(
      command('portal.collections.get', {
        projectId: 'ws-1',
        collectionId: 'abc',
      }) as Parameters<typeof handlePortalCollectionsGet>[0],
      adapterContext(events),
    );

    expect(mockedGetCollection).toHaveBeenCalledWith('abc');
    expect(events[1]).toMatchObject({
      type: 'portal.command.completed',
      payload: { result: collection },
    });
    expect(mockNotifyDesktopInventoryChanged).toHaveBeenCalledWith([
      'collections',
    ]);
  });

  it('rejects payloads without a projectId as invalid_payload', async () => {
    const handlers: Array<
      [
        (
          cmd: PortalCommandEnvelope<never>,
          context: PortalAdapterContext,
        ) => Promise<void>,
        PortalCommandEnvelope['type'],
      ]
    > = [
      [
        handlePortalPluginsListMarketplaces as never,
        'portal.plugins.list_marketplaces',
      ],
      [handlePortalSkillsList as never, 'portal.skills.list'],
      [handlePortalMcpListServers as never, 'portal.mcp.list_servers'],
      [handlePortalCollectionsList as never, 'portal.collections.list'],
    ];
    for (const [handler, type] of handlers) {
      const events: PortalEventEnvelope[] = [];
      await handler(
        command(type, 'not-an-object') as never,
        adapterContext(events),
      );
      expect(failureCode(events)).toBe('invalid_payload');
    }
    expect(mockedListMarketplaces).not.toHaveBeenCalled();
    expect(mockedListSkills).not.toHaveBeenCalled();
    expect(mockedListServers).not.toHaveBeenCalled();
    expect(mockedListCollections).not.toHaveBeenCalled();
  });

  it('rejects detail payloads missing their identifiers as invalid_payload', async () => {
    const events: PortalEventEnvelope[] = [];
    await handlePortalPluginsGetPluginDetail(
      command('portal.plugins.get_plugin_detail', {
        projectId: 'ws-1',
        marketplaceId: 'mkt',
      }) as Parameters<typeof handlePortalPluginsGetPluginDetail>[0],
      adapterContext(events),
    );
    await handlePortalSkillsRead(
      command('portal.skills.read', {
        projectId: 'ws-1',
        sourceId: 'src',
      }) as Parameters<typeof handlePortalSkillsRead>[0],
      adapterContext(events),
    );
    await handlePortalMcpGetServer(
      command('portal.mcp.get_server', {
        projectId: 'ws-1',
      }) as Parameters<typeof handlePortalMcpGetServer>[0],
      adapterContext(events),
    );
    await handlePortalCollectionsGet(
      command('portal.collections.get', {
        projectId: 'ws-1',
        collectionId: '',
      }) as Parameters<typeof handlePortalCollectionsGet>[0],
      adapterContext(events),
    );
    await handlePortalPluginsReadComponentContent(
      command('portal.plugins.read_component_content', {
        projectId: 'ws-1',
        marketplaceId: 'mkt',
        pluginName: 'plugin',
        componentType: 'skill',
      }) as Parameters<typeof handlePortalPluginsReadComponentContent>[0],
      adapterContext(events),
    );

    expect(events).toHaveLength(5);
    for (const event of events) {
      expect(event.type).toBe('portal.command.failed');
      expect((event.payload as { error: { code: string } }).error.code).toBe(
        'invalid_payload',
      );
    }
    expect(mockedGetPluginDetail).not.toHaveBeenCalled();
    expect(mockedReadSkill).not.toHaveBeenCalled();
    expect(mockedGetServer).not.toHaveBeenCalled();
    expect(mockedGetCollection).not.toHaveBeenCalled();
    expect(mockedReadComponent).not.toHaveBeenCalled();
  });

  it('maps plain service throws to execution_failed', async () => {
    const events: PortalEventEnvelope[] = [];
    mockedListMarketplaces.mockRejectedValue(new Error('cache exploded'));

    await handlePortalPluginsListMarketplaces(
      command('portal.plugins.list_marketplaces', {
        projectId: 'ws-1',
      }) as Parameters<typeof handlePortalPluginsListMarketplaces>[0],
      adapterContext(events),
    );

    expect(events[0]).toMatchObject({
      type: 'portal.command.failed',
      payload: {
        error: { code: 'execution_failed', message: 'cache exploded' },
      },
    });
  });

  it('passes stable service error codes through (not_found)', async () => {
    const events: PortalEventEnvelope[] = [];
    const notFound = new Error('Collection "missing" not found.') as Error & {
      code: string;
    };
    notFound.code = 'not_found';
    mockedGetCollection.mockRejectedValue(notFound);

    await handlePortalCollectionsGet(
      command('portal.collections.get', {
        projectId: 'ws-1',
        collectionId: 'missing',
      }) as Parameters<typeof handlePortalCollectionsGet>[0],
      adapterContext(events),
    );

    expect(failureCode(events)).toBe('not_found');
  });
});

describe('plugin-catalog portal mutation adapters (phase B)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('completes install_builtin off-loop with the reduced plugin row', async () => {
    const events: PortalEventEnvelope[] = [];
    const result = {
      plugin: {
        name: 'reviewer',
        marketplaceId: 'builtin/app',
        providerSupport: { claude: 'native', codex: 'none' },
        installed: true,
      },
    };
    mockedInstallBuiltIn.mockResolvedValue(
      result as Awaited<ReturnType<typeof installPortalBuiltInPlugin>>,
    );

    handlePortalPluginsInstallBuiltin(
      command('portal.plugins.install_builtin', {
        projectId: 'ws-1',
        marketplaceId: 'builtin/app',
        pluginName: 'reviewer',
        providers: ['claude'],
      }) as Parameters<typeof handlePortalPluginsInstallBuiltin>[0],
      adapterContext(events),
    );
    await flushOffLoop();

    expect(mockedInstallBuiltIn).toHaveBeenCalledWith(
      'builtin/app',
      'reviewer',
      ['claude'],
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: 'portal.command.completed',
        payload: { result },
      }),
    ]);
  });

  it('rejects install_builtin with an unknown provider before dispatch', async () => {
    const events: PortalEventEnvelope[] = [];

    handlePortalPluginsInstallBuiltin(
      command('portal.plugins.install_builtin', {
        projectId: 'ws-1',
        marketplaceId: 'builtin/app',
        pluginName: 'reviewer',
        providers: ['claude', 'gemini'],
      }) as Parameters<typeof handlePortalPluginsInstallBuiltin>[0],
      adapterContext(events),
    );
    await flushOffLoop();

    expect(failureCode(events)).toBe('invalid_payload');
    expect(mockedInstallBuiltIn).not.toHaveBeenCalled();
  });

  it('rejects install_builtin with an empty providers array', async () => {
    const events: PortalEventEnvelope[] = [];

    handlePortalPluginsInstallBuiltin(
      command('portal.plugins.install_builtin', {
        projectId: 'ws-1',
        marketplaceId: 'builtin/app',
        pluginName: 'reviewer',
        providers: [],
      }) as Parameters<typeof handlePortalPluginsInstallBuiltin>[0],
      adapterContext(events),
    );
    await flushOffLoop();

    expect(failureCode(events)).toBe('invalid_payload');
    expect(mockedInstallBuiltIn).not.toHaveBeenCalled();
  });

  it('does NOT block the handler on a slow mutation (off-loop completion)', async () => {
    const events: PortalEventEnvelope[] = [];
    let resolveInstall!: (value: {
      plugin: {
        name: string;
        marketplaceId: string;
        providerSupport: { claude: 'native'; codex: 'none' };
        installed: boolean;
      };
    }) => void;
    mockedInstallBuiltIn.mockReturnValue(
      new Promise((resolve) => {
        resolveInstall = resolve;
      }),
    );

    // The handler must RETURN while the service promise is still pending —
    // this is what keeps a 60s CLI install from stalling the serial portal
    // command loop (chat included).
    handlePortalPluginsInstallBuiltin(
      command('portal.plugins.install_builtin', {
        projectId: 'ws-1',
        marketplaceId: 'builtin/app',
        pluginName: 'reviewer',
        providers: ['claude'],
      }) as Parameters<typeof handlePortalPluginsInstallBuiltin>[0],
      adapterContext(events),
    );
    await flushOffLoop();
    expect(events).toEqual([]); // No terminal event yet: operation running.

    resolveInstall({
      plugin: {
        name: 'reviewer',
        marketplaceId: 'builtin/app',
        providerSupport: { claude: 'native', codex: 'none' },
        installed: true,
      },
    });
    await flushOffLoop();

    expect(events).toEqual([
      expect.objectContaining({ type: 'portal.command.completed' }),
    ]);
  });

  it('fails install_external via the off-loop path when the service throws', async () => {
    const events: PortalEventEnvelope[] = [];
    mockedInstallExternal.mockRejectedValue(new Error('clone failed'));

    handlePortalPluginsInstallExternal(
      command('portal.plugins.install_external', {
        projectId: 'ws-1',
        marketplaceId: 'mkt',
        pluginName: 'reviewer',
      }) as Parameters<typeof handlePortalPluginsInstallExternal>[0],
      adapterContext(events),
    );
    await flushOffLoop();

    expect(mockedInstallExternal).toHaveBeenCalledWith('mkt', 'reviewer');
    expect(failureCode(events)).toBe('execution_failed');
  });

  it('completes marketplace add off-loop with the reduced row', async () => {
    const events: PortalEventEnvelope[] = [];
    const result = { marketplace: { id: 'acme-marketplace' } };
    mockedAddMarketplace.mockResolvedValue(
      result as Awaited<ReturnType<typeof addPortalMarketplace>>,
    );

    handlePortalMarketplaceAdd(
      command('portal.marketplace.add', {
        projectId: 'ws-1',
        repo: 'acme/marketplace',
      }) as Parameters<typeof handlePortalMarketplaceAdd>[0],
      adapterContext(events),
    );
    await flushOffLoop();

    expect(mockedAddMarketplace).toHaveBeenCalledWith('acme/marketplace');
    expect(events).toEqual([
      expect.objectContaining({
        type: 'portal.command.completed',
        payload: { result },
      }),
    ]);
  });

  it('passes stable coded errors through from marketplace update', async () => {
    const events: PortalEventEnvelope[] = [];
    const failed = new Error('Marketplace "mkt" not found.') as Error & {
      code: string;
    };
    failed.code = 'execution_failed';
    mockedUpdateMarketplace.mockRejectedValue(failed);

    handlePortalMarketplaceUpdate(
      command('portal.marketplace.update', {
        projectId: 'ws-1',
        marketplaceId: 'mkt',
      }) as Parameters<typeof handlePortalMarketplaceUpdate>[0],
      adapterContext(events),
    );
    await flushOffLoop();

    expect(failureCode(events)).toBe('execution_failed');
  });

  it('validates optional providers on marketplace remove', async () => {
    const events: PortalEventEnvelope[] = [];

    handlePortalMarketplaceRemove(
      command('portal.marketplace.remove', {
        projectId: 'ws-1',
        marketplaceId: 'mkt',
        providers: ['gemini'],
      }) as Parameters<typeof handlePortalMarketplaceRemove>[0],
      adapterContext(events),
    );
    await flushOffLoop();

    expect(failureCode(events)).toBe('invalid_payload');
    expect(mockedRemoveMarketplace).not.toHaveBeenCalled();
  });

  it('completes marketplace remove off-loop and forwards providers', async () => {
    const events: PortalEventEnvelope[] = [];
    mockedRemoveMarketplace.mockResolvedValue({ removed: true });

    handlePortalMarketplaceRemove(
      command('portal.marketplace.remove', {
        projectId: 'ws-1',
        marketplaceId: 'mkt',
        providers: ['codex'],
      }) as Parameters<typeof handlePortalMarketplaceRemove>[0],
      adapterContext(events),
    );
    await flushOffLoop();

    expect(mockedRemoveMarketplace).toHaveBeenCalledWith('mkt', ['codex']);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'portal.command.completed',
        payload: { result: { removed: true } },
      }),
    ]);
  });

  it('completes refresh_all immediately after kicking the background refresh', async () => {
    const events: PortalEventEnvelope[] = [];
    mockedStartRefresh.mockResolvedValue(undefined);

    await handlePortalMarketplaceRefreshAll(
      command('portal.marketplace.refresh_all', {
        projectId: 'ws-1',
      }) as Parameters<typeof handlePortalMarketplaceRefreshAll>[0],
      adapterContext(events),
    );

    expect(mockedStartRefresh).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'portal.command.completed',
        payload: { result: { started: true } },
      }),
    ]);
  });

  it('completes the MCP config toggle inline with the redacted detail', async () => {
    const events: PortalEventEnvelope[] = [];
    const result = {
      server: {
        id: 'srv-1',
        name: 'Server',
        description: '',
        type: 'http' as const,
        createdAt: '2026-08-27T00:00:00.000Z',
        updatedAt: '2026-08-27T00:00:00.000Z',
        configs: [
          {
            id: 'cfg-1',
            name: 'default',
            description: '',
            enabled: false,
            envVarNames: ['TOKEN_NAME'],
            extraArgCount: 1,
            extraHeaderNames: [],
            hasAuthToken: true,
            createdAt: '2026-08-27T00:00:00.000Z',
            updatedAt: '2026-08-27T00:00:00.000Z',
          },
        ],
      },
    };
    mockedSetMcpConfigEnabled.mockResolvedValue(result);

    await handlePortalMcpSetConfigEnabled(
      command('portal.mcp.set_config_enabled', {
        projectId: 'ws-1',
        serverId: 'srv-1',
        configId: 'cfg-1',
        enabled: false,
      }) as Parameters<typeof handlePortalMcpSetConfigEnabled>[0],
      adapterContext(events),
    );

    expect(mockedSetMcpConfigEnabled).toHaveBeenCalledWith(
      'srv-1',
      'cfg-1',
      false,
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: 'portal.command.completed',
        payload: { result },
      }),
    ]);
    // Redaction contract: the completed payload must never carry raw
    // credential fields — only presence flags / names / counts.
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('authToken');
    expect(serialized).not.toContain('envVars');
    expect(serialized).not.toContain('extraArgs');
  });

  it('rejects the MCP toggle without a boolean enabled', async () => {
    const events: PortalEventEnvelope[] = [];

    await handlePortalMcpSetConfigEnabled(
      command('portal.mcp.set_config_enabled', {
        projectId: 'ws-1',
        serverId: 'srv-1',
        configId: 'cfg-1',
        enabled: 'yes',
      }) as Parameters<typeof handlePortalMcpSetConfigEnabled>[0],
      adapterContext(events),
    );

    expect(failureCode(events)).toBe('invalid_payload');
    expect(mockedSetMcpConfigEnabled).not.toHaveBeenCalled();
  });

  it('passes not_found through from the MCP toggle service', async () => {
    const events: PortalEventEnvelope[] = [];
    const notFound = new Error('MCP server "missing" not found.') as Error & {
      code: string;
    };
    notFound.code = 'not_found';
    mockedSetMcpConfigEnabled.mockRejectedValue(notFound);

    await handlePortalMcpSetConfigEnabled(
      command('portal.mcp.set_config_enabled', {
        projectId: 'ws-1',
        serverId: 'missing',
        configId: 'cfg-1',
        enabled: true,
      }) as Parameters<typeof handlePortalMcpSetConfigEnabled>[0],
      adapterContext(events),
    );

    expect(failureCode(events)).toBe('not_found');
  });
});

describe('Portal MCP management adapters', () => {
  beforeEach(() => jest.clearAllMocks());
  it('dispatches connection tests off the serial command loop', async () => {
    const events: PortalEventEnvelope[] = [];
    mockedTestPortalMcpConnection.mockResolvedValue({
      serverId: 'abc',
      configId: 'def',
      success: true,
      message: 'Connected',
    });
    handlePortalMcpTestConnection(
      command('portal.mcp.test_connection', {
        projectId: 'ws-1',
        serverId: 'abc',
        configId: 'def',
      }),
      adapterContext(events),
    );
    await flushOffLoop();
    expect(testPortalMcpConnection).toHaveBeenCalledWith('abc', 'def');
    expect(events[0]?.type).toBe('portal.command.completed');
  });
  it.each([
    { serverId: 'abc' },
    { projectId: 'ws-1', serverId: 'abc', configId: 4 },
    { projectId: 'ws-1', serverId: '' },
  ])('rejects invalid payloads %p', async (payload) => {
    const events: PortalEventEnvelope[] = [];
    await handlePortalMcpDeleteServer(
      command('portal.mcp.delete_server', payload),
      adapterContext(events),
    );
    expect(failureCode(events)).toBe('invalid_payload');
    expect(deletePortalMcpServer).not.toHaveBeenCalled();
  });
  it('completes deletion only after successful service execution', async () => {
    const events: PortalEventEnvelope[] = [];
    jest.mocked(deletePortalMcpServer).mockResolvedValue({ deleted: true });
    await handlePortalMcpDeleteServer(
      command('portal.mcp.delete_server', {
        projectId: 'ws-1',
        serverId: 'abc',
      }),
      adapterContext(events),
    );
    expect(events[0]?.type).toBe('portal.command.completed');
  });

  it('does not publish new inventory after a failed deletion', async () => {
    const events: PortalEventEnvelope[] = [];
    jest
      .mocked(deletePortalMcpServer)
      .mockRejectedValueOnce(new Error('locked'));
    await handlePortalMcpDeleteServer(
      command('portal.mcp.delete_server', {
        projectId: 'ws-1',
        serverId: 'abc',
      }),
      adapterContext(events),
    );
    expect(events[0]?.type).toBe('portal.command.failed');
    expect(mockNotifyDesktopInventoryChanged).not.toHaveBeenCalled();
  });
});
