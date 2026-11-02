import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { startAccountMcpCloud } from './fixtures/accountMcpCloud.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';
import { seedMcpServers } from './seeders/seedMcpServers.mjs';

// REG-3052: releases before the shared Add rule added catalog servers from
// the Plugins page as device servers, and Connect kept signing those in on
// the device, so the web never saw the sign-in. With account connections
// available, the next sign-in on such a card goes through the account and
// the device server is replaced once the account connection is made.
//
// Deterministic: the account cloud is the `accountMcpCloud` fixture, which
// also finishes the browser sign-in on request; the device server and the
// curated catalog are seeded on disk. No live agents, no network.

const NOW = new Date().toISOString();
const DEVICE_ID = '5e1c0a7e-0000-4000-8000-00000000a001';
const DEVICE_CONFIG_ID = '5e1c0a7e-0000-4000-8000-00000000c001';

function seedLinearDeviceServer(userDataDir) {
  seedMcpServers({
    userDataDir,
    servers: [
      {
        definition: {
          id: DEVICE_ID,
          name: 'Linear',
          description: 'Issues, projects, and cycles.',
          type: 'http',
          url: 'https://mcp.linear.example/mcp',
          httpAuthHandler: 'canopy',
          oauth: { usePkce: true },
          curated: { key: 'linear' },
          createdAt: NOW,
          updatedAt: NOW,
        },
        configs: [
          {
            id: DEVICE_CONFIG_ID,
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
      },
    ],
  });
  writeJson(path.join(userDataDir, 'mcp-servers', 'curated-catalog.json'), {
    version: 1,
    fetchedAt: NOW,
    servers: [
      {
        key: 'linear',
        name: 'Linear',
        shortDescription: 'Issues, projects, and cycles.',
        url: 'https://mcp.linear.example/mcp',
        transport: 'http',
        oauthHints: { usePkce: true },
        categories: ['productivity'],
        popular: true,
        sortOrder: 0,
        updatedAt: NOW,
      },
    ],
  });
}

async function linearRows(window) {
  return window.evaluate(async () => {
    const index = await window.mcpServers.loadIndex();
    return index.servers
      .flatMap((row) => [row, ...(row.deviceCopies ?? [])])
      .filter((row) => row.curatedKey === 'linear')
      .map((row) => ({
        id: row.id,
        scope: row.scope ?? 'device',
        status: row.accountConnection?.status ?? null,
      }));
  });
}

test('Connect on a device-only catalog server signs in through the account and replaces the device server', async () => {
  test.setTimeout(150_000);
  const cloud = await startAccountMcpCloud({ includeConnection: false });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-reg-3052-'));
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  seedLinearDeviceServer(userDataDir);
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      viewportSize: { width: 1400, height: 900 },
      env: {
        CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl,
        CANOPY_E2E_MCP_OAUTH_FIXTURE_BASE_URL: cloud.baseUrl,
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          'canopy-shared-mcp-account-connections': true,
        }),
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
    expect(await linearRows(window)).toEqual([
      { id: DEVICE_ID, scope: 'device', status: null },
    ]);

    await app.openPluginsPage();
    await window.getByTestId('plugins-search').fill('Linear');
    await window.getByTestId('customize-row-mcp-catalog:linear').click();
    const connection = window.getByTestId('plugin-account-connection');
    await expect(connection).toContainText(
      "Linear isn't connected to your account",
      { timeout: 30_000 },
    );
    // Signed in without a connection, the shared detail primary is Connect.
    const connect = window.getByTestId('detail-primary-cta');
    await expect(connect).toHaveAttribute('data-state', 'install');
    await expect(connect).toHaveText('Connect');
    await expect(connect).toHaveAccessibleName('Connect Linear');
    await connect.click();

    // The account runs the sign-in; the device server starts none of its own.
    await expect
      .poll(
        () =>
          cloud.calls.filter(
            (call) =>
              call.method === 'POST' && call.body?.serverKey === 'linear',
          ).length,
        { timeout: 30_000 },
      )
      .toBe(1);
    await expect(window.getByTestId('plugin-oauth-browser')).toHaveCount(0);
    await expect(connection).toContainText('Waiting for sign-in', {
      timeout: 30_000,
    });

    cloud.complete('linear');
    await expect
      .poll(() => linearRows(window), { timeout: 30_000 })
      .toEqual([{ id: 'linear', scope: 'account', status: 'CONNECTED' }]);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await cloud.close();
  }
});
