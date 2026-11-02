import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { startAccountMcpCloud } from './fixtures/accountMcpCloud.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';
import { seedMcpServers } from './seeders/seedMcpServers.mjs';

// REG-3048: a catalog server the account can't sign in to.
//
// The server lets only approved apps sign in and nothing the account holds
// can, so the cloud refuses the account connection start with
// `sign_in_unavailable` and says whether adding the server to this device
// signs in instead (`desktopSignIn`). Add from Browse used to open the
// client ID setup for such a refusal; it now explains the refusal in the MCP
// tab's error banner and never asks for an OAuth app.
//
// CAN-4267 deleted the Plugins management overlay that hosted that tab. Its
// Browse and banner live on in Settings > MCP servers > Account connections.
//
// The plain-language refusal banner covered here belongs to the MCP servers
// table, which now lives only in Settings > MCP servers > Account connections.
// Customize's catalog detail shows the shared connection notice instead.
//
// Deterministic and offline: the account cloud is the `accountMcpCloud`
// fixture answering the start with the body the web `connectionRoute`
// serializes, and the curated catalog is seeded fresh on disk and answered by
// the fixture. No live agents, no network.

// The catalog cache is honored for an hour; an older stamp triggers a refresh.
const NOW = new Date().toISOString();
const DROPBOX = {
  key: 'dropbox',
  name: 'Dropbox',
  shortDescription: 'Find and share files.',
  url: 'https://mcp.dropbox.example/mcp',
  transport: 'http',
  categories: ['productivity'],
  popular: true,
  sortOrder: 0,
  updatedAt: NOW,
};

for (const { desktopSignIn, title, message } of [
  {
    desktopSignIn: true,
    title: "Your account can't sign in to this server.",
    message: 'Add it to this device instead.',
  },
  {
    desktopSignIn: false,
    title:
      "This server only lets approved apps sign in, so your account can't connect it yet.",
    message: '',
  },
]) {
  test(`Add explains a refused account sign-in (desktopSignIn ${desktopSignIn}) without asking for a client ID`, async () => {
    test.setTimeout(150_000);
    const cloud = await startAccountMcpCloud({
      includeConnection: false,
      curatedServers: [DROPBOX],
      signInUnavailable: { desktopSignIn },
    });
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-reg-3048-'));
    seedMcpServers({ userDataDir, servers: [] });
    writeJson(path.join(userDataDir, 'mcp-servers', 'curated-catalog.json'), {
      version: 1,
      fetchedAt: NOW,
      servers: [DROPBOX],
    });
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
      await app.openSettings();
      await app.openSettingsSection('mcp');
      const panel = window.getByTestId('settings-mcp-account-connections');

      await panel.getByTestId('mcp-add-menu-trigger').click();
      await window.getByTestId('mcp-add-browse').click();
      await window
        .getByTestId('mcp-browse-dialog')
        .getByTestId('mcp-browse-card')
        .filter({ hasText: 'Dropbox' })
        .getByTestId('mcp-browse-card-add')
        .click();

      // The refusal is said in plain copy, its code kept at hand.
      const banner = panel.locator(
        '[data-mcp-error-code="sign_in_unavailable"]',
      );
      await expect(banner).toBeVisible({ timeout: 30_000 });
      await expect(banner).toContainText(title);
      if (message) await expect(banner).toContainText(message);
      else await expect(banner).toHaveText(title);

      // It never asks for an OAuth app and leaves nothing pending.
      await expect(window.getByTestId('mcp-account-setup')).toHaveCount(0);
      await expect(
        window.getByTestId('mcp-account-oauth-client-id'),
      ).toHaveCount(0);
      await expect(window.getByTestId('mcp-client-setup-intro')).toHaveCount(0);
      await expect(panel.getByTestId('mcp-account-pending')).toHaveCount(0);
      expect(
        await electronApp.evaluate(
          () => globalThis.__CANOPY_E2E_MCP_OAUTH_AUTHORIZATION_URL__ ?? null,
        ),
      ).toBeNull();

      // One account start, by catalog key and without an OAuth client.
      const starts = cloud.calls.filter((call) => call.method === 'POST');
      expect(starts).toHaveLength(1);
      expect(starts[0].body).toMatchObject({
        serverKey: 'dropbox',
        configId: 'default',
      });
      expect(starts[0].body).not.toHaveProperty('oauthClient');
    } finally {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
      await cloud.close();
    }
  });
}
