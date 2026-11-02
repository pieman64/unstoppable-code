import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import {
  CUSTOM_ACCOUNT_MCP_ID,
  startAccountMcpCloud,
} from './accountMcpCloud.mjs';
import { CanopyAppDriver } from '../canopyApp.mjs';
import { writeJson } from '../seeders/fsHelpers.mjs';
import { seedMcpServers } from '../seeders/seedMcpServers.mjs';
import { closeCanopy, launchCanopy } from '../launchCanopy.mjs';

// CAN-4258: a signed-in MCP servers table holding the widest action
// combinations it renders, shared by the layout regression and its captures
// so both measure identical rows:
// - a custom cloud connection with a long name and a second device copy
//   (Disconnect, Device copy, Details, Edit);
// - a curated GitHub connection with a device copy (Connect, Device copy,
//   Details), and its second configuration awaiting reconnection;
// - a device HTTP server with a long name, eligible for "Make available in
//   cloud".
// Nothing here contacts a real service.

const NOW = '2026-09-16T12:00:00.000Z';

export const LONG_CUSTOM_NAME =
  'Internal platform engineering tools for the observability and release pipelines';
export const LONG_DEVICE_NAME =
  'Staging analytics warehouse query service for the growth reporting team';
export const DEVICE_HTTP_ID = 'c0ffee00-0000-4000-8000-000000004258';
export const CUSTOM_ROW_TEST_ID = 'mcp-server-row-custom:fixture-long';
export const DEVICE_ROW_TEST_ID = `mcp-server-row-${DEVICE_HTTP_ID}`;

const WORK_CONNECTION_ID = 'eeeeeeee-ffff-4aaa-8bbb-000000000001';
const CUSTOM_COPY_IDS = [
  'c0ffee00-0000-4000-8000-000000004259',
  'c0ffee00-0000-4000-8000-000000004260',
];
const DEVICE_GITHUB_ID = 'c0ffee00-0000-4000-8000-000000004261';

// The table's only remaining mount: CAN-4267 deleted the Plugins → Your
// plugins → MCP mount with the legacy management view; Customize lists MCP
// servers as Installed rows with per-server detail pages instead.
export const MCP_TABLE_MOUNTS = [
  { name: 'settings', panelTestId: 'settings-mcp-account-connections' },
];

function connectionFixture(overrides) {
  return {
    configId: 'default',
    kind: 'CURATED',
    routeId: `fixture-route-${overrides.id}`,
    enabledTools: null,
    ...overrides,
  };
}

function httpServer(id, name, url, extra = {}) {
  return {
    definition: {
      id,
      name,
      description: '',
      type: 'http',
      url,
      createdAt: NOW,
      updatedAt: NOW,
      ...extra,
    },
    configs: [
      {
        id: 'default',
        name: 'Default',
        description: '',
        enabled: true,
        envVars: {},
        extraArgs: [],
        extraHeaders: {},
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  };
}

function seedLayoutFixture(userDataDir, { extraServerCount = 0 } = {}) {
  const extraServers = Array.from({ length: extraServerCount }, (_, index) =>
    httpServer(
      `c0ffee00-0000-4000-8000-${String(5000 + index).padStart(12, '0')}`,
      `Vertical scrolling fixture ${String(index + 1).padStart(2, '0')}`,
      `https://list-${index}.example.test/mcp`,
    ),
  );
  const seeded = seedMcpServers({
    userDataDir,
    servers: [
      httpServer(
        DEVICE_HTTP_ID,
        LONG_DEVICE_NAME,
        'https://warehouse.example.test/mcp',
      ),
      httpServer(
        DEVICE_GITHUB_ID,
        'Device GitHub',
        'https://github.example.test/mcp',
        { curated: { key: 'github' }, httpAuthHandler: 'provider' },
      ),
      ...CUSTOM_COPY_IDS.map((id, index) =>
        httpServer(
          id,
          `Internal tools copy ${index + 1}`,
          'https://internal.example.test/mcp',
        ),
      ),
      ...extraServers,
    ],
  });
  // Both copies are bound to the custom cloud connection: the first is the
  // one its Edit opens, so the second renders as a "Device copy" action.
  writeJson(seeded.indexFilePath, {
    ...seeded.index,
    servers: seeded.index.servers.map((entry) =>
      CUSTOM_COPY_IDS.includes(entry.id)
        ? {
            ...entry,
            scope: 'account',
            authHandler: 'account',
            accountConnectionId: CUSTOM_ACCOUNT_MCP_ID,
          }
        : entry,
    ),
  });
  writeJson(path.join(userDataDir, 'mcp-servers', 'curated-catalog.json'), {
    version: 1,
    fetchedAt: NOW,
    servers: [
      {
        key: 'github',
        name: 'GitHub',
        shortDescription: 'GitHub integration',
        longDescription: 'Connect to GitHub.',
        url: 'https://github.example.test/mcp',
        transport: 'http',
        categories: ['development'],
        popular: true,
        sortOrder: 0,
        updatedAt: NOW,
      },
    ],
  });
  return extraServers.map((server) => server.definition.id);
}

/**
 * Starts the account cloud fixture, seeds the table, launches signed in, and
 * opens the table's mount. The caller closes `cloud` and the app.
 */
export async function launchMcpServersLayout(
  mount,
  launchOptions = {},
  fixtureOptions = {},
) {
  const cloud = await startAccountMcpCloud({
    includeConnection: true,
    connections: [
      connectionFixture({
        id: WORK_CONNECTION_ID,
        serverKey: 'github',
        configId: 'work',
        displayName: 'Account GitHub',
        status: 'REAUTH_REQUIRED',
      }),
      connectionFixture({
        id: CUSTOM_ACCOUNT_MCP_ID,
        serverKey: 'custom:fixture-long',
        displayName: LONG_CUSTOM_NAME,
        kind: 'CUSTOM',
        authMode: 'BEARER',
        status: 'CONNECTED',
        upstreamHost: 'internal.example.test',
        hasExtraHeaders: false,
      }),
    ],
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), `canopy-mcp-layout-${mount.name}-`),
  );
  const extraServerIds = seedLayoutFixture(userDataDir, fixtureOptions);
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      // The window size, not an emulated viewport, sets the CSS viewport, so
      // the interface scale divides it exactly as it does for users.
      viewportSize: null,
      ...launchOptions,
      env: {
        CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl,
        CANOPY_E2E_MCP_OAUTH_FIXTURE_BASE_URL: cloud.baseUrl,
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          'canopy-shared-mcp-account-connections': true,
        }),
        ...launchOptions.env,
      },
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const signIn = await window.evaluate(async () =>
      window.api.saveCanopyCloudApiKey({ apiKey: 'csk_account_mcp_fixture' }),
    );
    expect(signIn.status.authenticated, JSON.stringify(signIn.status)).toBe(
      true,
    );
    await app.openSettings();
    await app.openSettingsSection('mcp');
    const panel = window.getByTestId(mount.panelTestId);
    await expect(panel).toBeVisible();
    for (const rowTestId of [CUSTOM_ROW_TEST_ID, DEVICE_ROW_TEST_ID])
      await expect(panel.getByTestId(rowTestId)).toBeVisible();
    return {
      cloud,
      userDataDir,
      electronApp,
      window,
      app,
      panel,
      extraServerIds,
    };
  } catch (error) {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await cloud.close();
    throw error;
  }
}

/** Resizes the page's own window, returning the content and minimum sizes. */
export async function setWindowContentSize(electronApp, window, size) {
  const browserWindow = await electronApp.browserWindow(window);
  return browserWindow.evaluate((mainWindow, { width, height }) => {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    if (mainWindow.isFullScreen()) mainWindow.setFullScreen(false);
    mainWindow.setContentSize(width, height);
    const [contentWidth, contentHeight] = mainWindow.getContentSize();
    const [minWidth, minHeight] = mainWindow.getMinimumSize();
    return { contentWidth, contentHeight, minWidth, minHeight };
  }, size);
}
