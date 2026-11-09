import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogSelectionUnavailableError } from '@canopy/core-runtime/node/catalog';
import {
  mcpServerEntryId,
  type CanopyCallerDescriptor,
  type ExecutionSecretBinding,
} from '@canopy/protocol/canopy-core';
import { INHERITED_PLUGIN_DEFAULTS_VERSION } from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { DEFAULT_PREFERENCES } from '@canopy/desktop-shared/node/preferences/defaults';
import type {
  ChatTabPluginSelections,
  ChatTabsFile,
  WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import type {
  AccountMcpConnection,
  McpServerFile,
  McpServerIndexEntry,
  McpServersIndexFile,
} from '@canopy/execution-engine/types/mcp-servers';
import { accountMcpIndexEntry } from '@canopy/ui-app/capability/accountMcpRows';
import {
  createDesktopMaterializationResolver,
  createDesktopWorkerCatalogHost,
  type DesktopMaterializationDeps,
} from '../catalog-materialization-host';
import {
  createCoreOperationAdapter,
  type CoreOperationAdapter,
} from '../core-operation-adapter';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';
import {
  getDesktopExecutionSecrets,
  resetDesktopExecutionSecretsForTests,
} from '../../execution-secrets/owner';
import { desktopExecutionSecretReader } from '../../execution-secrets/reader';
import { storedSecretRef } from '../../lib/stored-secrets';
import { describeMcpServerForMaterialization } from '../../mcp/mcp-materialization';
import { MCP_OAUTH_CLIENT_SECRET_SLOT } from '../../mcp/server-secret-view';

const mockMcp = { dir: '' };
jest.mock('../../lib/paths', () => ({
  ...jest.requireActual<object>('../../lib/paths'),
  getMcpServersIndexFilePath: (): string => `${mockMcp.dir}/index.json`,
  getMcpServerFilePath: (serverId: string): string =>
    `${mockMcp.dir}/server-${serverId}.json`,
}));
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

const scope = { workspaceId: 'ws', worktreeId: 'wt', chatId: 'chat' };
const origin = { kind: 'client', sourceId: 'test' } as const;
const owner = { kind: 'system', id: 'test' } as const;
const caller: CanopyCallerDescriptor = {
  principalId: 'core',
  clientInstanceId: 'test-core',
  authorityId: 'local-desktop',
  interfaceKind: 'test',
  grants: ['worker.catalog.read'],
};
const CANARIES = [
  'secret-canary-header-1',
  'secret-canary-env-2',
  'secret-canary-oauth-3',
];
const STAMP = '2026-11-06T00:00:00.000Z';
const web = { serverId: 'web', configId: 'default' };
const cmd = { serverId: 'cmd', configId: 'default' };
const account = { serverId: 'acct', configId: 'default' };
const disabled = { serverId: 'off', configId: 'default' };
const missing = { serverId: 'gone', configId: 'default' };

const config = (
  overrides: Partial<McpServerFile['server']['configs'][number]> = {},
): McpServerFile['server']['configs'][number] => ({
  id: 'default',
  name: 'Default',
  description: '',
  enabled: true,
  envVars: {},
  extraArgs: [],
  extraHeaders: {},
  createdAt: STAMP,
  updatedAt: STAMP,
  ...overrides,
});

const servers: Record<'web' | 'cmd' | 'off', McpServerFile> = {
  web: {
    version: 1,
    server: {
      definition: {
        id: 'web',
        name: 'Web',
        description: 'An HTTP server',
        createdAt: STAMP,
        updatedAt: STAMP,
        type: 'http',
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: 'secret-canary-header-1' },
        oauth: {
          clientId: 'client',
          clientSecret: 'secret-canary-oauth-3',
          authorizationUrl: 'https://auth.example.com/authorize',
          tokenUrl: 'https://auth.example.com/token',
        },
      },
      configs: [config()],
    },
  },
  cmd: {
    version: 1,
    server: {
      definition: {
        id: 'cmd',
        name: 'Command',
        description: 'A command server',
        createdAt: STAMP,
        updatedAt: STAMP,
        type: 'command',
        command: 'mcp-command',
        args: ['--stdio'],
      },
      configs: [config({ envVars: { API_KEY: 'secret-canary-env-2' } })],
    },
  },
  off: {
    version: 1,
    server: {
      definition: {
        id: 'off',
        name: 'Off',
        description: 'A disabled server',
        createdAt: STAMP,
        updatedAt: STAMP,
        type: 'command',
        command: 'mcp-off',
      },
      configs: [config({ enabled: false })],
    },
  },
};

const entry = (
  id: string,
  name: string,
  type: 'http' | 'command',
  overrides: Partial<McpServerIndexEntry> = {},
): McpServerIndexEntry => ({
  id,
  name,
  description: '',
  type,
  configs: [{ id: 'default', name: 'Default', enabled: true }],
  updatedAt: STAMP,
  ...overrides,
});

const index: McpServersIndexFile = {
  version: 1,
  servers: [
    entry('web', 'Web', 'http'),
    entry('cmd', 'Command', 'command'),
    entry('acct', 'Account', 'http', {
      scope: 'account',
      accountConnectionId: 'connection-1',
    }),
    entry('off', 'Off', 'command', {
      configs: [{ id: 'default', name: 'Default', enabled: false }],
    }),
  ],
};

const selections = (
  mcpServerRefs: ChatTabPluginSelections['mcpServerRefs'],
): ChatTabPluginSelections => ({
  collectionIds: [],
  skillRefs: [],
  pluginRefs: [],
  mcpServerRefs,
});

function selectionDeps(
  refs: ChatTabPluginSelections['mcpServerRefs'],
): DesktopMaterializationDeps {
  const workspace: WorkspaceConfigFile = {
    version: 1,
    type: 'single-repo',
    repos: [],
  };
  const tabs: ChatTabsFile = {
    version: 1,
    activeTabId: 'chat',
    tabs: [
      {
        id: 'chat',
        title: 'Chat',
        messages: [],
        createdAt: STAMP,
        pluginSelections: selections(refs),
        inheritedPluginDefaultsVersion: INHERITED_PLUGIN_DEFAULTS_VERSION,
      },
    ],
  };
  return {
    readPreferences: () =>
      Promise.resolve({ preferences: DEFAULT_PREFERENCES, authority: 'ok' }),
    readWorkspaceConfig: () =>
      Promise.resolve({ config: workspace, authority: 'ok' }),
    readWorkspaceRevision: () => Promise.resolve(1),
    readChatTabs: () => Promise.resolve(tabs),
    normalizeAccountSelections: (value) => Promise.resolve(value),
    normalizeAccountTombstones: (value) => Promise.resolve(value),
    loadMarketplacesCacheOnly: () =>
      Promise.resolve({
        success: true,
        data: { version: 2, lastRefreshed: STAMP, marketplaces: [] },
      }),
    resolveEffectiveRefs: (value, warnings) =>
      Promise.resolve({
        disabledRefs: [],
        skillRefs: value.skillRefs,
        pluginRefs: value.pluginRefs,
        mcpServerRefs: value.mcpServerRefs ?? [],
        warnings,
      }),
    resolvePluginRoot: () => Promise.resolve(null),
    realpath: (path) => Promise.resolve(path),
    readLockSnapshot: () =>
      Promise.resolve({ state: 'ok', entries: new Map() }),
    readSkillFile: () => Promise.reject(new Error('No skill is selected.')),
    skillExists: () => false,
    resolveSkillDirectory: () => Promise.resolve(null),
    canonicalSkillDirectory: () => Promise.resolve(null),
    describeMcpServer: (ref) => describeMcpServerForMaterialization(ref),
  };
}

let root: string;
let operations: CoreOperationAdapter;
let runtime: DesktopCanopyDispatcher | null;

function start(
  deps: DesktopMaterializationDeps,
  resolver: Partial<DesktopMaterializationDeps> = {},
): DesktopCanopyDispatcher {
  runtime = createDesktopRuntime({
    operationAdapter: operations,
    shutdownTimeoutMs: 25,
    workerCatalogHost: createDesktopWorkerCatalogHost(deps),
    catalogMaterializationResolver: createDesktopMaterializationResolver({
      ...deps,
      ...resolver,
    }),
  });
  return runtime;
}

/** Every MCP file's bytes, by name. */
function mcpFiles(): Record<string, string> {
  return Object.fromEntries(
    readdirSync(mockMcp.dir).map((name) => [
      name,
      readFileSync(join(mockMcp.dir, name), 'utf8'),
    ]),
  );
}

function expectNoCanary(text: string): void {
  for (const canary of CANARIES) expect(text.includes(canary)).toBe(false);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'can-4125-materialize-'));
  mockMcp.dir = join(root, 'mcp-servers');
  mkdirSync(mockMcp.dir);
  mkdirSync(join(root, 'ledger'));
  writeFileSync(join(mockMcp.dir, 'index.json'), JSON.stringify(index));
  for (const [id, file] of Object.entries(servers))
    writeFileSync(join(mockMcp.dir, `server-${id}.json`), JSON.stringify(file));
  operations = createCoreOperationAdapter({
    ledgerPath: () => join(root, 'ledger', 'ledger.sqlite'),
  });
  runtime = null;
});
afterEach(async () => {
  await runtime?.shutdown();
  resetDesktopExecutionSecretsForTests();
  jest.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('desktop MCP materialization (CAN-4125)', () => {
  it('materializes a selected MCP server with its secrets in worker memory only', async () => {
    const desktop = start(selectionDeps([web, cmd]));
    const outcome = await desktop.catalogMaterializations.materialize({
      scope,
      origin,
      owner,
    });

    expect(outcome.state).toBe('ready');
    expect(outcome.effectiveItems.map((item) => item.kind)).toEqual([
      'mcp_server',
      'mcp_server',
    ]);
    const bundle = desktop.catalogMaterializationReader.resolve(
      outcome.materializationId,
    );
    const pinned = new Map(
      (bundle?.mcpServers ?? []).map((server) => [
        server.serverId,
        server.server,
      ]),
    );
    expect(pinned.get('web')).toMatchObject({
      binding: 'device',
      server: {
        definition: {
          headers: { Authorization: 'secret-canary-header-1' },
          oauth: {
            clientSecret: {
              kind: 'stored-secret',
              ref: storedSecretRef(
                'mcp.server',
                'web',
                MCP_OAUTH_CLIENT_SECRET_SLOT,
              ),
            },
          },
        },
      },
    });
    expect(pinned.get('cmd')).toMatchObject({
      binding: 'device',
      server: { config: { envVars: { API_KEY: 'secret-canary-env-2' } } },
    });
    expectNoCanary(JSON.stringify(outcome));
    expectNoCanary(
      JSON.stringify(
        await desktop.query(
          'worker.catalog.materialization.get',
          { materializationId: outcome.materializationId },
          { caller },
        ),
      ),
    );
    for (const name of readdirSync(join(root, 'ledger')))
      expectNoCanary(
        readFileSync(join(root, 'ledger', name)).toString('latin1'),
      );
  });

  it('a failed materialization leaves every MCP configuration file byte-identical', async () => {
    const read = jest.spyOn(desktopExecutionSecretReader, 'read');
    let after: Record<string, string> = {};
    const desktop = start(selectionDeps([web]), {
      // A save lands between the resolver's read and the worker's lookup.
      describeMcpServer: async (ref) => {
        const described = await describeMcpServerForMaterialization(ref);
        const changed: McpServerFile = structuredClone(servers.web);
        changed.server.definition.description = 'Changed';
        writeFileSync(
          join(mockMcp.dir, 'server-web.json'),
          JSON.stringify(changed),
        );
        after = mcpFiles();
        return described;
      },
    });
    const outcome = await desktop.catalogMaterializations.materialize({
      scope,
      origin,
      owner,
    });

    expect(outcome.state).toBe('failed');
    expect(outcome.error).toMatchObject({
      code: 'worker.catalog.revisionConflict',
    });
    expect(read).not.toHaveBeenCalled();
    expect(mcpFiles()).toEqual(after);
  });

  it('a save while the secrets are read fails instead of pinning a newer credential to the checked endpoint', async () => {
    const deps = selectionDeps([web]);
    let lookups = 0;
    const desktop = start(
      {
        ...deps,
        describeMcpServer: async (ref) => {
          const described = await describeMcpServerForMaterialization(ref);
          lookups += 1;
          if (lookups === 1) {
            // Lands after the worker's check and before the owner reads values.
            const moved: McpServerFile = structuredClone(servers.web);
            moved.server.definition.url = 'https://moved.example.com/mcp';
            moved.server.definition.headers = {
              Authorization: 'secret-canary-moved-4',
            };
            moved.server.definition.updatedAt = '2026-11-07T00:00:00.000Z';
            writeFileSync(
              join(mockMcp.dir, 'server-web.json'),
              JSON.stringify(moved),
            );
          }
          return described;
        },
      },
      deps,
    );
    const outcome = await desktop.catalogMaterializations.materialize({
      scope,
      origin,
      owner,
    });

    expect(outcome.state).toBe('failed');
    expect(outcome.error).toMatchObject({
      code: 'worker.catalog.revisionConflict',
    });
    expect(
      desktop.catalogMaterializationReader.resolve(outcome.materializationId),
    ).toBeNull();
    expect(JSON.stringify(outcome).includes('secret-canary-moved-4')).toBe(
      false,
    );
  });

  it('a damaged MCP file refuses resolution and changes nothing', async () => {
    writeFileSync(join(mockMcp.dir, 'server-web.json'), '{"version": 1,');
    const before = mcpFiles();
    const desktop = start(selectionDeps([web]));

    await expect(
      desktop.catalogMaterializations.materialize({ scope, origin, owner }),
    ).rejects.toBeInstanceOf(CatalogSelectionUnavailableError);
    const listed = await operations.service.list({
      kinds: ['core.catalog.materialization'],
      limit: 10,
    });
    expect(listed.items).toHaveLength(0);
    expect(mcpFiles()).toEqual(before);
  });

  it('an account server materializes with no secret through its account binding', async () => {
    const stage = jest.spyOn(getDesktopExecutionSecrets(), 'stage');
    const described = await describeMcpServerForMaterialization(account);
    expect(described?.descriptor).toMatchObject({
      kind: 'mcp_server',
      binding: 'account',
      transport: 'http',
      secretRefs: [],
    });
    const desktop = start(selectionDeps([account]));
    const outcome = await desktop.catalogMaterializations.materialize({
      scope,
      origin,
      owner,
    });

    expect(outcome.state).toBe('ready');
    expect(stage).not.toHaveBeenCalled();
    const [server] =
      desktop.catalogMaterializationReader.resolve(outcome.materializationId)
        ?.mcpServers ?? [];
    expect(server?.binding).toBe('account');
    expect(server?.server).toEqual({
      binding: 'account',
      index: {
        ...index.servers[2],
        configs: [{ id: 'default', name: 'Default', enabled: true }],
      },
      server: null,
    });
  });

  it('account-only connections materialize from the account list, and an unreadable list leaves them out', async () => {
    const legacy = { serverId: 'account:connection-2', configId: 'default' };
    const custom = {
      serverId: 'custom:3f2a6c1e-9b7d-4e2a-8c51-0d6f4b9a2e17',
      configId: 'default',
    };
    const connections: AccountMcpConnection[] = [
      {
        id: 'connection-2',
        serverKey: 'linear',
        configId: 'default',
        displayName: 'Linear',
        status: 'CONNECTED',
        routeId: 'route-2',
        enabledTools: null,
        kind: 'CURATED',
      },
      {
        id: 'connection-3',
        serverKey: custom.serverId,
        configId: 'default',
        displayName: 'Custom',
        status: 'CONNECTED',
        routeId: 'route-3',
        enabledTools: null,
        kind: 'CUSTOM',
      },
    ];
    let list: AccountMcpConnection[] | null = connections;
    const stage = jest.spyOn(getDesktopExecutionSecrets(), 'stage');
    const deps: DesktopMaterializationDeps = {
      ...selectionDeps([legacy, custom, cmd]),
      describeMcpServer: (ref) =>
        describeMcpServerForMaterialization(ref, {
          loadAccountConnections: () => Promise.resolve(list),
        }),
    };
    const desktop = start(deps);
    const outcome = await desktop.catalogMaterializations.materialize({
      scope,
      origin,
      owner,
    });

    expect(outcome.state).toBe('ready');
    expect(outcome.unavailable).toEqual([]);
    expect(stage).toHaveBeenCalledTimes(1);
    const pinned = new Map(
      (
        desktop.catalogMaterializationReader.resolve(outcome.materializationId)
          ?.mcpServers ?? []
      ).map((server) => [server.serverId, server]),
    );
    for (const [ref, connection] of [
      [legacy, connections[0]],
      [custom, connections[1]],
    ] as const) {
      expect(pinned.get(ref.serverId)).toMatchObject({
        entryId: mcpServerEntryId(ref),
        binding: 'account',
        transport: 'http',
        server: {
          binding: 'account',
          index: accountMcpIndexEntry(connection),
          server: null,
        },
      });
    }

    list = null;
    const signedOut = await desktop.catalogMaterializations.materialize({
      scope,
      origin,
      owner,
    });
    expect(signedOut.state).toBe('ready');
    expect(signedOut.unavailable).toEqual([
      { entryId: mcpServerEntryId(legacy), reason: 'missing' },
      { entryId: mcpServerEntryId(custom), reason: 'missing' },
    ]);
    expect(signedOut.effectiveItems.map((item) => item.entryId)).toEqual([
      mcpServerEntryId(cmd),
    ]);
    expect(signedOut.diagnostics.map((item) => item.message)).toEqual(
      expect.arrayContaining([
        `Account MCP connections could not be read, so "${legacy.serverId}" was left out.`,
        `Account MCP connections could not be read, so "${custom.serverId}" was left out.`,
      ]),
    );
  });

  it('a curated account connection stays retryable when the worker cannot read the account list', async () => {
    const curated = { serverId: 'linear', configId: 'default' };
    const connection: AccountMcpConnection = {
      id: 'connection-4',
      serverKey: 'linear',
      configId: 'default',
      displayName: 'Linear',
      status: 'CONNECTED',
      routeId: 'route-4',
      enabledTools: null,
      kind: 'CURATED',
    };
    // The resolver reads the list, then the worker's read fails.
    let reads = 0;
    const desktop = start({
      ...selectionDeps([curated]),
      describeMcpServer: (ref) =>
        describeMcpServerForMaterialization(ref, {
          loadAccountConnections: () =>
            Promise.resolve(++reads === 2 ? null : [connection]),
        }),
    });
    const materialize = (): ReturnType<
      typeof desktop.catalogMaterializations.materialize
    > => desktop.catalogMaterializations.materialize({ scope, origin, owner });

    const failed = await materialize();
    expect(failed.state).toBe('failed');
    expect(failed.error).toMatchObject({ kind: 'unavailable' });
    const retried = await materialize();
    expect(retried.materializationId).toBe(failed.materializationId);
    expect(retried.state).toBe('ready');
    expect(
      desktop.catalogMaterializationReader.resolve(retried.materializationId)
        ?.mcpServers[0],
    ).toMatchObject({ serverId: 'linear', binding: 'account' });
  });

  it('disabled and missing servers are left out and never read', async () => {
    const read = jest.spyOn(desktopExecutionSecretReader, 'read');
    const desktop = start(selectionDeps([account, disabled, missing]));
    const outcome = await desktop.catalogMaterializations.materialize({
      scope,
      origin,
      owner,
    });

    expect(outcome.state).toBe('ready');
    expect(outcome.unavailable).toEqual(
      expect.arrayContaining([
        { entryId: mcpServerEntryId(disabled), reason: 'disabled' },
        { entryId: mcpServerEntryId(missing), reason: 'missing' },
      ]),
    );
    expect(outcome.effectiveItems.map((item) => item.entryId)).toEqual([
      mcpServerEntryId(account),
    ]);
    expect(
      desktop.catalogMaterializationReader
        .resolve(outcome.materializationId)
        ?.mcpServers.map((server) => server.serverId),
    ).toEqual(['acct']);
    expect(read).not.toHaveBeenCalled();
  });

  it('the owner redeems only slots it can name', async () => {
    const binding = (ref: string): ExecutionSecretBinding => ({
      name: 'CANOPY_MCP_SECRET_0',
      source: {
        kind: 'stored-secret',
        family: 'mcp.server',
        record: 'web',
        ref,
      },
    });
    const header = storedSecretRef(
      'mcp.server',
      'web',
      'definition/headers/Authorization',
    );
    await expect(
      desktopExecutionSecretReader.read(
        [binding(header)],
        new AbortController().signal,
      ),
    ).resolves.toEqual([{ status: 'ok', value: 'secret-canary-header-1' }]);
    const removed: McpServerFile = structuredClone(servers.web);
    removed.server.definition.headers = {};
    writeFileSync(
      join(mockMcp.dir, 'server-web.json'),
      JSON.stringify(removed),
    );

    await expect(
      desktopExecutionSecretReader.read(
        [
          binding(header),
          binding(
            storedSecretRef('mcp.server', 'web', MCP_OAUTH_CLIENT_SECRET_SLOT),
          ),
        ],
        new AbortController().signal,
      ),
    ).resolves.toEqual([{ status: 'missing' }, { status: 'missing' }]);
  });
});
