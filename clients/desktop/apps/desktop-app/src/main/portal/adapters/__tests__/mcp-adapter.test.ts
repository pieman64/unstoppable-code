import type {
  ChatTabPluginSelections,
  PortalEventEnvelope,
} from '@canopy/desktop-shared/types';
import type { DetectedMcpServerInfo } from '@canopy/desktop-shared/types/mcp-servers';
import {
  clearPortalMcpServerFingerprints,
  emitPortalMcpServerProjection,
  projectPortalMcpServerEntities,
} from '../mcp-adapter';

const selections: ChatTabPluginSelections = {
  collectionIds: [],
  skillRefs: [],
  pluginRefs: [],
  mcpServerRefs: [],
};

function detectedServer(
  values: Partial<DetectedMcpServerInfo> & {
    key: string;
    source: DetectedMcpServerInfo['source'];
  },
): DetectedMcpServerInfo {
  return {
    serverName: values.serverName ?? values.key,
    displayName: values.displayName ?? values.key,
    type: values.type ?? 'http',
    enabled: values.enabled ?? true,
    authStatus: values.authStatus ?? 'connected',
    authStatusLabel: values.authStatusLabel ?? 'Connected',
    canConnect: values.canConnect ?? false,
    ...values,
  };
}

describe('MCP portal adapter', () => {
  beforeEach((): void => {
    clearPortalMcpServerFingerprints();
  });

  it('preserves renewal availability for shared activity-card badges', () => {
    const [entry] = projectPortalMcpServerEntities(
      { workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-1' },
      [
        detectedServer({
          key: 'renewable',
          source: 'standalone',
          authStatus: 'expired',
          canRefresh: true,
          authStatusLabel: 'Refresh available',
        }),
      ],
    );
    expect(entry).toMatchObject({
      canRefresh: true,
      authStatusLabel: 'Refresh available',
    });
  });

  it('projects an empty inventory', () => {
    expect(
      projectPortalMcpServerEntities(
        { workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-1' },
        [],
      ),
    ).toEqual([]);
  });

  it('projects multiple source kinds without connection secrets', () => {
    const entities = projectPortalMcpServerEntities(
      { workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-1' },
      [
        detectedServer({
          key: 'standalone:github:default',
          source: 'standalone',
          serverName: 'github',
          displayName: 'GitHub',
          serverId: 'github',
          configId: 'default',
          configName: 'Global',
          enabled: false,
          authStatus: 'not_connected',
          authStatusLabel: 'Connect',
          url: 'https://secret.example/mcp',
          lastError: 'secret diagnostic',
        }),
        detectedServer({
          key: 'collection:team:linear',
          source: 'collection',
          collectionId: 'team',
        }),
        detectedServer({
          key: 'plugin:market:plugin:server',
          source: 'plugin',
          marketplaceId: 'market',
          pluginName: 'plugin',
          pluginServerName: 'server',
          type: 'command',
          authStatus: 'unsupported',
          authStatusLabel: 'Command server',
        }),
      ],
    );

    expect(entities).toHaveLength(3);
    // Entities are sorted by localId for stable fingerprints; resolve rows by
    // id, not position.
    const github = entities.find(
      (entity) => entity.localId === 'standalone:github:default',
    );
    expect(github).toEqual({
      localId: 'standalone:github:default',
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      serverName: 'github',
      displayName: 'GitHub',
      source: 'standalone',
      type: 'http',
      enabled: false,
      authStatus: 'not_connected',
      authStatusLabel: 'Connect',
      serverId: 'github',
      configId: 'default',
      configName: 'Global',
    });
    expect(JSON.stringify(entities)).not.toContain('secret.example');
    expect(JSON.stringify(entities)).not.toContain('secret diagnostic');
    expect(entities.map((entity) => entity.source).sort()).toEqual([
      'collection',
      'plugin',
      'standalone',
    ]);
  });

  it('redacts the auth status label for error states', () => {
    const entities = projectPortalMcpServerEntities(
      { workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-1' },
      [
        detectedServer({
          key: 'standalone:broken:default',
          source: 'standalone',
          authStatus: 'error',
          authStatusLabel: 'invalid_grant: token exchange failed at idp',
        }),
      ],
    );
    expect(entities[0]?.authStatusLabel).toBe('Authentication error');
    expect(JSON.stringify(entities)).not.toContain('invalid_grant');
  });

  it('gates inventory work without a portal session', async () => {
    const listInventory = jest.fn(() =>
      Promise.resolve({
        servers: [detectedServer({ key: 'one', source: 'plugin' })],
      }),
    );
    const emit = jest.fn();

    await emitPortalMcpServerProjection(
      {
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        selections,
      },
      { portalActive: () => false, listInventory, emit },
    );

    expect(listInventory).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('emits only on change and resets its per-session fingerprint', async () => {
    const events: PortalEventEnvelope[] = [];
    const inventory = {
      servers: [detectedServer({ key: 'one', source: 'plugin' })],
    };
    const dependencies = {
      portalActive: (): boolean => true,
      listInventory: (): Promise<typeof inventory> =>
        Promise.resolve(inventory),
      emit: (event: PortalEventEnvelope): void => {
        events.push(event);
      },
    };
    const context = {
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      selections,
    };

    await emitPortalMcpServerProjection(context, dependencies);
    await emitPortalMcpServerProjection(context, dependencies);
    expect(events).toHaveLength(1);

    inventory.servers = [];
    await emitPortalMcpServerProjection(context, dependencies);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: 'portal.state.delta',
      payload: {
        entities: [],
        removed: [
          {
            entityType: 'mcp_server',
            localId: 'one',
            parentLocalId: 'ws-1:wt-1',
          },
        ],
      },
    });

    clearPortalMcpServerFingerprints();
    // Post-reset with an empty inventory there is nothing to upsert and no
    // previously-emitted ids to remove — no no-op event is sent.
    await emitPortalMcpServerProjection(context, dependencies);
    expect(events).toHaveLength(2);

    inventory.servers = [detectedServer({ key: 'one', source: 'plugin' })];
    await emitPortalMcpServerProjection(context, dependencies);
    expect(events).toHaveLength(3);
  });
});
