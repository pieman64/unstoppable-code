/** @jest-environment jsdom */
import { buildCurrentUiStateSnapshot } from '../buildCurrentUiStateSnapshot';
it('reports bounded account MCP panel metadata without credentials', (): void => {
  const snapshot = buildCurrentUiStateSnapshot({
    'mcp.accountConnections.plugins': {
      available: false,
      loading: false,
      setupOpen: true,
      detailsOpen: true,
      detailsRowId: 'account:one',
      pendingCount: 1,
      rows: [
        {
          id: 'account:one',
          serverKey: 'github',
          status: 'REAUTH_REQUIRED',
          bearerToken: 'secret',
        },
      ],
      bearerToken: 'secret',
      endpointUrl: 'https://private.test',
    },
  });
  expect(snapshot.mcpAccountConnections).toEqual({
    available: false,
    loading: false,
    setupOpen: true,
    detailsOpen: true,
    detailsRowId: 'account:one',
    pendingCount: 1,
    rows: [
      { id: 'account:one', serverKey: 'github', status: 'REAUTH_REQUIRED' },
    ],
  });
  expect(JSON.stringify(snapshot)).not.toContain('secret');
  expect(JSON.stringify(snapshot)).not.toContain('private.test');
  expect(buildCurrentUiStateSnapshot({}).mcpAccountConnections).toBeUndefined();
});

it('reports the promote confirmation on the account MCP panel', (): void => {
  const snapshot = buildCurrentUiStateSnapshot({
    'mcp.accountConnections.plugins': {
      available: true,
      loading: false,
      setupOpen: false,
      detailsOpen: false,
      promoteDialogOpen: true,
      pendingCount: 0,
      rows: [],
    },
  });
  expect(snapshot.mcpAccountConnections?.promoteDialogOpen).toBe(true);
});

it('reports the MCP server editor scope and move confirmation without its fields', (): void => {
  const snapshot = buildCurrentUiStateSnapshot({
    'mcp.serverEditor': {
      mode: 'edit',
      serverId: 'bound-device',
      cloudOnly: false,
      scopeAvailable: true,
      scope: 'device',
      initialScope: 'cloud',
      moveToDeviceDialogOpen: true,
      deleteConfirmOpen: false,
      saving: false,
      errorVisible: true,
      url: 'https://private.test/mcp',
      accessToken: 'secret',
    },
  });
  expect(snapshot.mcpServerEditor).toEqual({
    mode: 'edit',
    serverId: 'bound-device',
    cloudOnly: false,
    scopeAvailable: true,
    scope: 'device',
    initialScope: 'cloud',
    moveToDeviceDialogOpen: true,
    deleteConfirmOpen: false,
    saving: false,
    errorVisible: true,
  });
  expect(JSON.stringify(snapshot)).not.toContain('secret');
  expect(JSON.stringify(snapshot)).not.toContain('private.test');
  expect(
    buildCurrentUiStateSnapshot({
      'mcp.serverEditor': {
        mode: 'edit',
        cloudOnly: true,
        scopeAvailable: true,
        scope: 'device',
        initialScope: 'cloud',
        moveToDeviceDialogOpen: true,
        moveDropsStoredHeaders: true,
        moveWithoutStoredHeaders: true,
        deleteConfirmOpen: false,
        saving: false,
        errorVisible: false,
      },
    }).mcpServerEditor,
  ).toMatchObject({
    moveDropsStoredHeaders: true,
    moveWithoutStoredHeaders: true,
  });
  expect(
    buildCurrentUiStateSnapshot({
      'mcp.serverEditor': {
        mode: 'edit',
        serverId: 'device-server',
        cloudOnly: false,
        scopeAvailable: true,
        scope: 'cloud',
        initialScope: 'device',
        moveToDeviceDialogOpen: false,
        moveToCloudDialogOpen: true,
        deleteConfirmOpen: false,
        saving: false,
        errorVisible: false,
      },
    }).mcpServerEditor,
  ).toMatchObject({ moveToCloudDialogOpen: true });
  expect(
    buildCurrentUiStateSnapshot({ 'mcp.serverEditor': { mode: 'bogus' } })
      .mcpServerEditor,
  ).toBeUndefined();
  expect(buildCurrentUiStateSnapshot({}).mcpServerEditor).toBeUndefined();
});
