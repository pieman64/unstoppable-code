import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

/**
 * The provider-connector surface is reachable and states its case even with no
 * Claude account linked — which is the state a first-time user is in, and the
 * one where an empty panel would be indistinguishable from a broken one.
 *
 * Linked connectors depend on a real claude.ai account, so the populated list
 * is covered by the component tests rather than seeded here.
 *
 * The curated catalog is seeded because it is the only source of which
 * connectors are advertised — there is no bundled fallback, so an unseeded
 * profile shows none, exactly as it shows no other curated MCP server.
 *
 * REG-3033: a connector the catalog advertises for a key no longer has a card
 * of its own. It folds into that key's integration card. Provider-only
 * entries show their provider connections without an app MCP connection.
 */

/** Write the curated catalog cache the app reads at startup. */
function seedConnectorCatalog(userDataDir) {
  const dir = path.join(userDataDir, 'mcp-servers');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'curated-catalog.json'),
    JSON.stringify({
      version: 1,
      fetchedAt: new Date().toISOString(),
      servers: [
        {
          key: 'gmail-gmailmcp',
          name: 'Gmail',
          url: 'https://gmailmcp.googleapis.com/mcp/v1',
        },
        {
          key: 'google-calendar-calendarmcp',
          name: 'Google Calendar',
          url: 'https://calendarmcp.googleapis.com/mcp/v1',
        },
        {
          key: 'google-drive-drivemcp',
          name: 'Google Drive',
          url: 'https://drivemcp.googleapis.com/mcp/v1',
        },
        {
          key: 'linear',
          name: 'Linear',
          url: 'https://mcp.linear.app/mcp',
          oauthHints: { scopes: ['read'] },
        },
      ].map((entry) => ({
        ...entry,
        shortDescription: 'Connect through your provider account.',
        authorName: entry.name === 'Linear' ? 'Linear' : 'Google',
        transport: 'http',
        categories: ['productivity'],
        popular: false,
        sortOrder: 0,
        updatedAt: '2026-08-27T00:00:00.000Z',
        providerConnector: { providers: ['claude', 'codex'] },
      })),
    }),
  );
}
for (const [key, name] of [
  ['gmail-gmailmcp', 'Gmail'],
  ['google-calendar-calendarmcp', 'Google Calendar'],
  ['google-drive-drivemcp', 'Google Drive'],
]) {
  test(`Plugins shows only provider connections for ${name}`, async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-provider-connectors-'),
    );
    seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
      checkRuntimes: false,
    });
    seedConnectorCatalog(userDataDir);

    const { electronApp } = await launchCanopy({
      userDataDir,
      viewportSize: { width: 1200, height: 900 },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openPluginsPage();

      // The connector is reachable through Marketplace search.
      await window.getByTestId('plugins-search').fill(name);

      // The catalog entry and provider connector produce one service card.
      // Select the card, because clicking its text does not open the detail.
      const card = window.getByTestId(`plugins-entry-mcp-catalog:${key}`);
      await expect(card).toBeVisible();
      await expect(
        window.getByTestId(`plugins-entry-provider-connector:${name}`),
      ).toHaveCount(0);
      await expect(
        window
          .locator('[data-marketplace-entry="true"]')
          .filter({ hasText: name }),
      ).toHaveCount(1);
      await card.click();

      // Provider-only catalog entries cannot connect through the app. Keep one
      // identity header and the provider controls, with no app route or actions.
      const direct = window.getByTestId('mcp-browse-detail');
      await expect(direct).toBeVisible();
      await expect(
        direct.getByTestId('mcp-browse-detail-app-route'),
      ).toHaveCount(0);
      await expect(direct.getByTestId('mcp-browse-tools')).toHaveCount(0);
      await expect(window.getByTestId('mcp-browse-detail-add')).toHaveCount(0);
      await expect(
        window.getByTestId('plugin-advanced-configuration'),
      ).toHaveCount(0);
      await expect(window.getByTestId('plugin-account-connection')).toHaveCount(
        0,
      );
      await expect(
        window.getByTestId('mcp-browse-detail-projects'),
      ).toHaveCount(0);
      const binding = direct.getByTestId('plugins-entry-connector-binding');
      await expect(binding).toBeVisible();
      const detail = binding.getByTestId('provider-connector-detail');
      await expect(detail).toBeVisible();
      await expect(
        detail.getByRole('heading', { name: 'Provider connections' }),
      ).toBeVisible();
      await expect(detail).toContainText('Claude or Codex account');

      // One identity header, with the card's mark and vendor. The connector
      // section carries none of its own.
      await expect(
        window.getByTestId('provider-connector-detail-header'),
      ).toHaveCount(0);
      await expect(
        direct.getByRole('heading', { name, exact: true }),
      ).toHaveCount(1);
      await expect(direct).toContainText('Google');
      // Each Google connector keeps its own bundled logo.
      await expect(direct.getByTestId('mcp-curated-logo')).toBeVisible();
      await expect(direct.getByTestId('mcp-curated-logo-fallback')).toHaveCount(
        0,
      );
      await expect(
        window.getByTestId('provider-connector-detail-connect-claude'),
      ).toContainText('Connect with Claude');
      // Codex reads its connector list from an on-disk directory cache that a
      // fresh profile does not have, so it reports unavailable rather than
      // offering a route that would lead nowhere. Claude stays actionable —
      // either provider can supply the connector.
      await expect(
        window.getByTestId('provider-connector-detail-unavailable-codex'),
      ).toBeVisible();

      // Linking finishes in a browser and the re-read takes seconds, so the
      // detail has to offer a way to ask again rather than leaving the user
      // staring at a button that has not changed yet.
      await expect(
        window.getByTestId('provider-connector-detail-refresh'),
      ).toBeVisible();

      // A sub-page opened straight from the marketplace has to offer a way
      // out. CAN-4261: that is the titlebar breadcrumb, not a Back control.
      await expect(window.getByTestId('plugins-entry-detail-back')).toHaveCount(
        0,
      );
      const root = window.getByTestId('plugins-entry-detail-breadcrumb-root');
      await expect(root).toBeVisible();
      await root.click();
      await expect(binding).toHaveCount(0);
      await expect(detail).toHaveCount(0);
      await expect(card).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('a connector with an app OAuth path keeps both connection sections', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-dual-connector-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  seedConnectorCatalog(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize: { width: 1200, height: 900 },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openPluginsPage();
    await window.getByTestId('plugins-search').fill('Linear');
    await window.getByTestId('plugins-entry-mcp-catalog:linear').click();
    const detail = window.getByTestId('mcp-browse-detail');
    await expect(
      detail.getByRole('heading', { name: 'Linear', exact: true }),
    ).toHaveCount(1);
    await expect(
      detail.getByTestId('mcp-browse-detail-app-route'),
    ).toBeVisible();
    await expect(detail.getByTestId('mcp-browse-tools')).toBeVisible();
    await expect(window.getByTestId('mcp-browse-detail-add')).toBeVisible();
    await expect(detail.getByTestId('provider-connector-detail')).toBeVisible();
    // The app's section, with its tools, comes first; Provider connections
    // follows it on the page, not just in the DOM.
    const appRouteBox = await detail
      .getByTestId('mcp-browse-detail-app-route')
      .boundingBox();
    const providerBox = await detail
      .getByTestId('provider-connector-detail')
      .boundingBox();
    expect(appRouteBox).not.toBeNull();
    expect(providerBox).not.toBeNull();
    expect(providerBox.y).toBeGreaterThanOrEqual(
      appRouteBox.y + appRouteBox.height,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
