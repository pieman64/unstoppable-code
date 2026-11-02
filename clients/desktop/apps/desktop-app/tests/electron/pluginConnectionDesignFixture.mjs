import path from 'node:path';
import { readFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import { launchCanopy } from './launchCanopy.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedVendorOAuthCatalog } from './mcpOauthCallbackFixture.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';
import { seedPluginsCache, seedMcpServers } from './seeders/index.mjs';

export const TRUST_ERROR =
  'OAuth delegated endpoints are not trusted for this protected resource.';

export function seedPluginConnectionDesign(
  userDataDir,
  { partialInstall = false } = {},
) {
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: { cursorEnabled: true },
  });
  const details = {
    skills: [],
    agents: [],
    commands: [],
    hooks: [],
    lspServers: [],
    mcpServers: [
      { name: 'gmail', type: 'http', url: 'https://gmail.example.test/mcp' },
    ],
    hasReadme: true,
  };
  seedPluginsCache({
    userDataDir,
    additionalPlugins: [
      {
        name: 'gmail',
        displayName: 'Gmail',
        version: '0.1.9',
        description: 'Search, read, and manage your Gmail messages.',
        author: 'OpenAI',
        category: 'Communication',
        homepage: 'https://github.com/openai/plugins/tree/main/plugins/gmail',
        details,
        providerSupport: {
          claude: partialInstall ? 'native' : 'none',
          codex: 'native',
        },
        facets: {
          ...(partialInstall
            ? {
                claude: {
                  provider: 'claude',
                  mode: 'native',
                  name: 'Gmail',
                  details,
                  installLocation: '/tmp/demo-market',
                  sourcePath: 'plugins/gmail',
                },
              }
            : {}),
          codex: {
            provider: 'codex',
            mode: 'native',
            name: 'Gmail',
            description: 'Search, read, and manage your Gmail messages.',
            version: '0.1.9',
            details,
            installLocation: '/tmp/demo-market',
            sourcePath: 'plugins/gmail',
          },
        },
        globalInstallStatus: {
          claude: { available: true, installed: false },
          codex: { available: true, installed: true },
        },
      },
      ...['Outlook Email', 'Slack', 'Teams', 'Zoom', 'Airtable'].map(
        (name) => ({
          name: name.toLowerCase().replaceAll(' ', '-'),
          displayName: name,
          description: `Connect ${name} to your workspace.`,
          author: 'OpenAI',
          category: 'Communication',
        }),
      ),
    ],
  });
}

/** Only the external inventory/auth seams are fixtures; navigation and UI are real. */
export async function installPluginConnectionDesignHandlers(
  electronApp,
  { authenticated = true } = {},
) {
  await electronApp.evaluate(
    ({ ipcMain }, [trustError, signedIn]) => {
      ipcMain.removeHandler('plugins:read-component');
      ipcMain.handle('plugins:read-component', () => ({
        success: true,
        data: {
          frontmatter: {},
          body: 'Search and manage your Gmail messages from your workspace.',
        },
      }));
      for (const channel of [
        'settings:claude-auth-status',
        'settings:codex-auth-status',
      ]) {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, () => ({
          authenticated: signedIn,
          accountLabel: signedIn ? 'Fixture account' : null,
          detail: null,
        }));
      }
      ipcMain.removeHandler('cursor-connection:status');
      ipcMain.handle('cursor-connection:status', () => ({
        supported: true,
        enabled: true,
        installed: signedIn,
      }));
      ipcMain.removeHandler('mcp-servers:list-detected');
      ipcMain.handle('mcp-servers:list-detected', () => ({
        warnings: [],
        servers: [
          {
            key: 'plugin:gmail',
            displayName: 'gmail',
            type: 'http',
            source: 'plugin',
            pluginServerName: 'gmail',
            authStatus: 'not_connected',
            authStatusLabel: 'Not connected',
            canConnect: true,
          },
        ],
      }));
      ipcMain.removeHandler('mcp-servers:start-oauth-login');
      ipcMain.handle('mcp-servers:start-oauth-login', () => {
        throw new Error(trustError);
      });
    },
    [TRUST_ERROR, authenticated],
  );
}

export async function openPluginConnectionDesign(window, app) {
  await window.reload();
  await app.waitForShell();
  await app.openPluginsPage();
  await window.getByTestId('plugins-search').fill('Gmail');
  await window.getByTestId('customize-row-mkt:demo/market/gmail').click();
}

/** Facet combinations exercise the desktop Cursor resolver's precedence. */
export function seedCursorPluginConnectionDesign(userDataDir, kind) {
  seedPluginConnectionDesign(userDataDir);
  const cachePath = path.join(userDataDir, 'plugins-cache.json');
  const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
  const plugin = cache.marketplaces[0].plugins.find(
    (entry) => entry.name === 'gmail',
  );
  if (kind === 'claude-only') {
    plugin.facets.claude = { ...plugin.facets.codex, provider: 'claude' };
    delete plugin.facets.codex;
    plugin.providerSupport = { claude: 'native', codex: 'none' };
    plugin.globalInstallStatus.claude.installed = true;
    plugin.globalInstallStatus.codex.installed = false;
  } else if (kind === 'codex-empty') {
    plugin.facets.codex.details.mcpServers = [];
    plugin.details.mcpServers = [];
  } else if (kind === 'claude-preferred') {
    plugin.facets.claude = { ...plugin.facets.codex, provider: 'claude' };
    plugin.providerSupport.claude = 'native';
  } else if (kind === 'claude-skills-only') {
    // No MCP servers at all: only the plugin's skills reach a Cursor session.
    const details = {
      ...plugin.facets.codex.details,
      mcpServers: [],
      skills: [
        {
          name: 'triage',
          description: 'Triage the inbox.',
          path: 'skills/triage',
        },
      ],
    };
    plugin.facets.claude = {
      ...plugin.facets.codex,
      provider: 'claude',
      details,
    };
    delete plugin.facets.codex;
    plugin.details = details;
    plugin.providerSupport = { claude: 'native', codex: 'none' };
    plugin.globalInstallStatus.claude.installed = true;
    plugin.globalInstallStatus.codex.installed = false;
  }
  writeJson(cachePath, cache);
}

export async function openCuratedStatusFixture({
  localSelection = false,
  accountOnly = false,
  nestedDevice = false,
  recordVideoDir,
} = {}) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'plugin-status-recovery-'),
  );
  seedVendorOAuthCatalog(userDataDir, 3118, 'http://127.0.0.1:1');
  const now = new Date().toISOString();
  seedMcpServers({
    userDataDir,
    servers: [
      {
        definition: {
          id: 'aabbcc',
          name: 'Vendor OAuth Callback',
          description: '',
          type: 'http',
          url: 'https://mcp.vendor.test/mcp',
          oauth: { clientId: 'fixture' },
          curated: { key: 'vendor-oauth-callback' },
          createdAt: now,
          updatedAt: now,
        },
        configs: [
          {
            id: 'ddeeff',
            name: 'Default',
            description: '',
            enabled: true,
            envVars: {},
            extraArgs: [],
            extraHeaders: {},
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    ],
  });
  if (localSelection) {
    const target = JSON.parse(
      readFileSync(
        path.join(userDataDir, 'mcp-servers', 'server-aabbcc.json'),
        'utf8',
      ),
    ).server;
    seedMcpServers({
      userDataDir,
      servers: [
        {
          ...target,
          definition: {
            ...target.definition,
            id: '001122',
            name: 'Other vendor connection',
          },
        },
        target,
      ],
    });
  }
  const { electronApp } = await launchCanopy({
    userDataDir,
    recordVideoDir,
    env: {
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
        'canopy-shared-mcp-account-connections': true,
      }),
    },
  });
  if (accountOnly || nestedDevice) {
    await electronApp.evaluate(({ ipcMain }, accountOnly) => {
      const load = ipcMain._invokeHandlers.get('mcp-servers:load-index');
      const connection = (id) => ({
        id,
        serverKey: 'vendor-oauth-callback',
        configId: 'default',
        displayName: 'Vendor OAuth Callback',
        status: 'CONNECTED',
        routeId: 'fixture-route',
        enabledTools: null,
        kind: 'CURATED',
      });
      ipcMain.removeHandler('mcp-servers:load-index');
      ipcMain.handle('mcp-servers:load-index', async (event, ...args) => {
        const result = await load(event, ...args);
        if (!accountOnly && !globalThis.__nestSelectedDevice) return result;
        const device = result.servers.find((row) => row.id === 'aabbcc');
        return {
          ...result,
          accountConnectionsAvailable: true,
          servers: [
            {
              ...device,
              id: 'vendor-oauth-callback',
              scope: 'account',
              accountConnectionId: 'fixture-account',
              accountConnection: connection('fixture-account'),
              deviceCopies: accountOnly ? [] : [device],
            },
          ],
        };
      });
      ipcMain.removeHandler('mcp-servers:get-account');
      ipcMain.handle('mcp-servers:get-account', (_event, id) => connection(id));
      ipcMain.removeHandler('mcp-servers:list-account-upstream-tools');
      ipcMain.handle('mcp-servers:list-account-upstream-tools', () => [
        {
          name: 'search_docs',
          title: 'Search docs',
          description: 'Find pages that match a query.',
        },
        { name: 'read_page', description: 'Read one page.' },
        { name: 'delete_page', description: 'Delete a page.' },
      ]);
      ipcMain.removeHandler('mcp-servers:set-account-tools');
      ipcMain.handle('mcp-servers:set-account-tools', (_event, id, tools) => {
        globalThis.__savedAccountTools = tools;
        return { ...connection(id), enabledTools: tools };
      });
    }, accountOnly);
  }
  if (localSelection) {
    await electronApp.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers.get('mcp-servers:list-curated');
      const ready = new Promise((resolve) =>
        ipcMain.once('e2e:release-curated-catalog', resolve),
      );
      ipcMain.removeHandler('mcp-servers:list-curated');
      ipcMain.handle('mcp-servers:list-curated', async (event, ...args) => {
        await ready;
        return original(event, ...args);
      });
    });
  }
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('mcp-servers:get-tools');
    ipcMain.handle('mcp-servers:get-tools', () => ({ tools: [] }));
    globalThis.__statusFixture = {
      authStatus: 'connected',
      expiresAt: new Date(Date.now() + 2_147_483_647 + 10_000).toISOString(),
    };
    ipcMain.removeHandler('mcp-servers:list-status');
    ipcMain.handle('mcp-servers:list-status', () => [
      {
        serverId: 'aabbcc',
        configs: [{ configId: 'ddeeff', ...globalThis.__statusFixture }],
      },
    ]);
    const load = ipcMain._invokeHandlers.get('mcp-servers:load-server');
    ipcMain.removeHandler('mcp-servers:load-server');
    ipcMain.handle('mcp-servers:load-server', (event, ...args) => {
      if (globalThis.__failStatusRead) {
        globalThis.__failStatusRead = false;
        throw new Error('Temporary status read failure');
      }
      return load(event, ...args);
    });
  });
  const window = await electronApp.firstWindow();
  await window.reload();
  const app = new CanopyAppDriver(window);
  await app.waitForShell();
  await window.clock.install();
  await app.openPluginsPage();
  await window.getByTestId('plugins-search').fill('Vendor OAuth Callback');
  if (localSelection) {
    await window.getByTestId('customize-row-mcp-local:aabbcc').click();
    await window.getByTestId('mcp-browse-detail').waitFor();
    await electronApp.evaluate(({ ipcMain, BrowserWindow }, nestedDevice) => {
      if (nestedDevice) {
        globalThis.__nestSelectedDevice = true;
        for (const win of BrowserWindow.getAllWindows())
          win.webContents.send('mcp-servers:auth-changed');
      }
      ipcMain.emit('e2e:release-curated-catalog');
    }, nestedDevice);
    if (!nestedDevice) await window.getByTestId('mcp-browse-detail').waitFor();
  } else {
    await window
      .getByTestId('customize-row-mcp-catalog:vendor-oauth-callback')
      .click();
  }
  return { electronApp, userDataDir, window };
}

export function seedDualFacetConnection(
  userDataDir,
  fixtureBaseUrl,
  proxyPort,
) {
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: { mcpProxyPort: proxyPort },
  });
  const facets = {};
  for (const provider of ['claude', 'codex']) {
    const installLocation = path.join(userDataDir, 'fixture-plugins', provider);
    const rawServers =
      provider === 'claude'
        ? { local: { command: 'fixture-not-executed' } }
        : {
            vendor: {
              type: 'http',
              url: 'https://mcp.vendor.test/mcp',
              oauth: {
                clientId: 'vendor-client',
                authorizationUrl: `${fixtureBaseUrl}/authorize`,
                tokenUrl: `${fixtureBaseUrl}/token`,
              },
            },
          };
    writeJson(
      path.join(installLocation, `.${provider}-plugin`, 'plugin.json'),
      { name: 'dual-auth', mcpServers: './servers.json' },
    );
    writeJson(path.join(installLocation, 'servers.json'), {
      mcpServers: rawServers,
    });
    facets[provider] = {
      provider,
      mode: 'native',
      name: 'dual-auth',
      installLocation,
      details: {
        skills: [],
        commands: [],
        agents: [],
        hooks: [],
        lspServers: [],
        mcpServers: Object.entries(rawServers).map(([name, raw]) => ({
          name,
          ...raw,
        })),
        hasReadme: false,
      },
    };
  }
  seedPluginsCache({
    userDataDir,
    additionalPlugins: [
      {
        name: 'dual-auth',
        displayName: 'Dual Auth',
        description: 'Connect native plugin servers',
        facets,
        details: facets.claude.details,
        providerSupport: { claude: 'native', codex: 'native' },
        globalInstallStatus: {
          claude: { installed: true, available: true },
          codex: { installed: true, available: true },
        },
      },
    ],
  });
}

/** Delay only the native browser seam so the real sign-in loading UI is stable. */
export async function openOAuthLoadingFixture() {
  const fixture = await openCuratedStatusFixture();
  const { electronApp, window } = fixture;
  await electronApp.evaluate(({ ipcMain, BrowserWindow }) => {
    globalThis.__statusFixture = { authStatus: 'not_connected' };
    ipcMain.removeHandler('mcp-servers:start-oauth-login');
    ipcMain.handle('mcp-servers:start-oauth-login', () => ({
      status: 'started',
      authorizationUrl: 'about:blank',
    }));
    const create = ipcMain._invokeHandlers.get('browser:create');
    ipcMain.removeHandler('browser:create');
    ipcMain.handle('browser:create', async (event, request) => {
      if (request.projectId === 'app-oauth') {
        await new Promise((resolve) =>
          ipcMain.once('e2e:release-oauth-browser', resolve),
        );
      }
      return create(event, request);
    });
    for (const win of BrowserWindow.getAllWindows())
      win.webContents.send('mcp-servers:auth-changed');
  });
  await window.getByTestId('mcp-browse-detail-add').click();
  await window.getByTestId('plugin-oauth-browser').waitFor();
  return fixture;
}

/** Saved device connections with deterministic status; no vendor network calls. */
export async function openLocalConnectionFixture({
  type = 'http',
  removedCatalog = false,
  recordVideoDir,
} = {}) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'plugin-local-detail-'),
  );
  const now = '2026-09-22T00:00:00.000Z';
  seedMcpServers({
    userDataDir,
    servers: [
      {
        definition: {
          id: 'aabbcc',
          name: type === 'http' ? 'Slack' : 'Local tools',
          description:
            type === 'http'
              ? 'Send messages and fetch Slack data.'
              : 'Tools provided by a local command.',
          type,
          ...(type === 'http'
            ? {
                url: 'https://slack.example.test/mcp',
                httpAuthHandler: 'canopy',
                oauth: { clientId: 'fixture-client', callbackPort: 3118 },
              }
            : { command: 'npx', args: ['--stdio'] }),
          ...(removedCatalog ? { curated: { key: 'removed-slack' } } : {}),
          createdAt: now,
          updatedAt: now,
        },
        configs: [
          {
            id: 'ddeeff',
            name: 'Default',
            description: '',
            enabled: true,
            envVars: {},
            extraArgs: [],
            extraHeaders: {},
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    ],
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    ...(recordVideoDir ? { recordVideoDir } : {}),
  });
  await electronApp.evaluate(({ ipcMain, BrowserWindow }, type) => {
    globalThis.__localDetailCalls = { login: [], health: [], test: [] };
    let authStatus = type === 'http' ? 'required' : 'unsupported';
    const handlers = {
      'mcp-servers:list-curated': () => ({ servers: [] }),
      'mcp-servers:get-tools': () => ({ tools: ['search_messages'] }),
      'mcp-servers:list-status': () => [
        {
          serverId: 'aabbcc',
          transport: type,
          connectionStatus:
            type === 'command'
              ? 'unknown'
              : authStatus === 'connected'
                ? 'connected'
                : 'auth_required',
          reachability: 'unknown',
          configs: [{ configId: 'ddeeff', authStatus }],
        },
      ],
      'mcp-servers:start-oauth-login': (_event, request) => {
        globalThis.__localDetailCalls.login.push(request);
        if (type === 'command')
          throw new Error('OAuth is only supported for HTTP MCP servers.');
        authStatus = 'connected';
        for (const win of BrowserWindow.getAllWindows())
          win.webContents.send('mcp-servers:auth-changed');
        return { status: 'completed' };
      },
      'mcp-servers:check-health': (_event, serverId, configId) => {
        globalThis.__localDetailCalls.health.push({ serverId, configId });
        return { status: 'healthy', message: 'Fixture health is ready' };
      },
      'mcp-servers:test-connection': (_event, serverId, configId) => {
        globalThis.__localDetailCalls.test.push({ serverId, configId });
        return {
          success: true,
          message: 'Connected',
          tools: ['search_messages'],
        };
      },
    };
    for (const [channel, handler] of Object.entries(handlers)) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
    }
  }, type);
  const window = await electronApp.firstWindow();
  await window.reload();
  const app = new CanopyAppDriver(window);
  await app.waitForShell();
  await app.openPluginsPage();
  await window
    .getByTestId('plugins-search')
    .fill(type === 'http' ? 'Slack' : 'Local tools');
  await window.getByTestId('customize-row-mcp-local:aabbcc').click();
  return { electronApp, userDataDir, window };
}

/** Open a real connection page with a prior versioned error and a fresh OAuth flow. */
export async function openUnversionedOAuthFixture(kind) {
  let fixture;
  if (kind === 'curated') {
    fixture = await openCuratedStatusFixture();
  } else {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'plugin-unversioned-'),
    );
    seedPluginConnectionDesign(userDataDir);
    const { electronApp } = await launchCanopy({ userDataDir });
    await installPluginConnectionDesignHandlers(electronApp);
    const window = await electronApp.firstWindow();
    await openPluginConnectionDesign(window, new CanopyAppDriver(window));
    fixture = { electronApp, userDataDir, window };
  }
  await fixture.electronApp.evaluate(({ ipcMain, BrowserWindow }) => {
    globalThis.__statusFixture = {
      authStatus: 'error',
      authErrorRevision: 'previous-error',
      lastError: 'Previous attempt failed',
    };
    ipcMain.removeHandler('mcp-servers:list-detected');
    ipcMain.handle('mcp-servers:list-detected', () => ({
      warnings: [],
      servers: [
        {
          key: 'plugin:gmail',
          displayName: 'gmail',
          type: 'http',
          source: 'plugin',
          pluginServerName: 'gmail',
          authStatusLabel: 'Not connected',
          canConnect: true,
          ...globalThis.__statusFixture,
        },
      ],
    }));
    ipcMain.removeHandler('mcp-servers:start-oauth-login');
    ipcMain.handle('mcp-servers:start-oauth-login', () => ({
      status: 'started',
      authorizationUrl: 'about:blank',
      flowId: 'fixture-flow',
    }));
    ipcMain.removeHandler('mcp-servers:cancel-oauth-login');
    globalThis.__cancelledOAuthFlows = [];
    ipcMain.handle('mcp-servers:cancel-oauth-login', (_event, id) => {
      globalThis.__cancelledOAuthFlows.push(id);
    });
    for (const win of BrowserWindow.getAllWindows())
      win.webContents.send('mcp-servers:auth-changed');
  });
  return fixture;
}

export async function emitUnversionedOAuthFailure(electronApp) {
  await electronApp.evaluate(({ BrowserWindow }) => {
    globalThis.__statusFixture = {
      authStatus: 'error',
      lastError: 'Secure storage unavailable',
    };
    for (const win of BrowserWindow.getAllWindows())
      win.webContents.send('mcp-servers:auth-changed');
  });
}
