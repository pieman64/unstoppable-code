import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedPluginsCache } from './seeders/seedPluginsCache.mjs';
import {
  registerShareMembership,
  SHARE_MEMBERSHIP_ORGANIZATION,
} from './seeders/shareMembership.mjs';

function seedShareablePlugin(userDataDir) {
  const { cacheFilePath } = seedPluginsCache({ userDataDir });
  const cache = JSON.parse(readFileSync(cacheFilePath, 'utf8'));
  cache.marketplaces[0].sourceType = 'codex';
  writeFileSync(cacheFilePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
}

test('shares a portable desktop plugin and copies its public link', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can-2323-pr6-'));
  seedShareablePlugin(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const account = await window.evaluate(() =>
      window.api.saveCanopyCloudApiKey({ apiKey: 'csk_can_2323_pr6_e2e' }),
    );
    expect(account.status).toMatchObject({ authenticated: true });
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });

    await app.openPluginsPage();
    await window.getByTestId('plugins-search').fill('gamma-tool');
    await window
      .getByTestId('customize-row-mkt:demo/market/gamma-tool')
      .click();
    await window.getByTestId('plugin-detail-share').click();

    const modal = window.getByTestId('share-plugin-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText(
      'Credentials, private configuration, and local files are never included.',
    );
    await expect(modal).toContainText(
      'Public source: codex-builtin:demo/market',
    );
    await modal.getByTestId('share-plugin-submit').click();
    // The dialog stays open on its success notice with the new link.
    const publicLink = /\/portal\/plugins\/plugins\/shared\/public-plugin-e2e$/;
    await expect(modal.getByTestId('share-plugin-success')).toContainText(
      'Plugin is now public',
    );
    await expect(modal.getByTestId('share-plugin-link')).toHaveText(publicLink);
    await expect(
      window
        .getByTestId('toast-card')
        .filter({ hasText: 'Plugin is now public' }),
    ).toHaveCount(0);
    await modal.getByTestId('share-plugin-copy-link').click();
    await expect(modal.getByTestId('share-plugin-copy-link')).toContainText(
      'Copied',
    );
    await expect
      .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
      .toMatch(publicLink);
    await modal.getByTestId('share-plugin-done').click();
    await expect(modal).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('moves a plugin share reused from another organization to the chosen one', async () => {
  const apiKey = 'csk_can3009_plugin_share_move';
  await registerShareMembership(apiKey);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can-3009-plugin-'));
  seedShareablePlugin(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await window.evaluate(
      (key) => window.api.saveCanopyCloudApiKey({ apiKey: key }),
      apiKey,
    );
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });
    // The server reuses this creator's existing share, here one another
    // organization owns, without applying the requested audience.
    await electronApp.evaluate(() => {
      const originalFetch = globalThis.fetch;
      globalThis.__pluginShareUpdates = [];
      let listed = [];
      const json = (body) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      const share = (body, owner) => ({
        externalId: 'reused-plugin-share',
        refKey: 'codex_plugin:codex-builtin:demo/market:gamma-tool',
        ref: body.ref,
        name: body.name,
        description: body.description ?? null,
        marketplaceOrigin: 'codex-builtin:demo/market',
        owner,
        shareScope: 'organization',
        createdBy: { id: 'creator', name: null },
        createdAt: '2026-10-02T00:00:00.000Z',
        updatedAt: '2026-10-02T00:00:00.000Z',
        publicShare: null,
      });
      globalThis.fetch = async (input, init) => {
        const { pathname } = new URL(String(input));
        const method = init?.method ?? 'GET';
        if (method === 'GET' && pathname.endsWith('/plugins')) {
          return json({ data: listed });
        }
        if (method === 'POST' && pathname.endsWith('/plugins')) {
          return json(
            share(JSON.parse(String(init.body)), {
              type: 'organization',
              id: 'other-organization',
              name: 'Other',
            }),
          );
        }
        if (
          method === 'PUT' &&
          pathname.endsWith('/plugins/reused-plugin-share')
        ) {
          const body = JSON.parse(String(init.body));
          globalThis.__pluginShareUpdates.push(body);
          const moved = share(body, {
            type: 'organization',
            id: body.organizationId,
            name: 'Acme Robotics',
          });
          listed = [moved];
          return json(moved);
        }
        return originalFetch(input, init);
      };
    });

    await app.openPluginsPage();
    await window.getByTestId('plugins-search').fill('gamma-tool');
    await window
      .getByTestId('customize-row-mkt:demo/market/gamma-tool')
      .click();
    await window.getByTestId('plugin-detail-share').click();
    const modal = window.getByTestId('share-plugin-modal');
    await modal.getByTestId('share-plugin-scope-organization').click();
    await modal
      .getByTestId(
        `share-plugin-organization-picker-option-${SHARE_MEMBERSHIP_ORGANIZATION.id}`,
      )
      .click();
    await modal.getByTestId('share-plugin-submit').click();
    await expect(modal.getByTestId('share-plugin-success')).toBeVisible();
    await modal.getByTestId('share-plugin-done').click();
    await expect(modal).toHaveCount(0);
    expect(
      await electronApp.evaluate(() => globalThis.__pluginShareUpdates),
    ).toEqual([
      expect.objectContaining({
        shareScope: 'organization',
        organizationId: SHARE_MEMBERSHIP_ORGANIZATION.id,
      }),
    ]);
    // The Marketplace lists the new share without a remount or tab change.
    // CAN-4261: the detail page has no Back; its breadcrumb leads out.
    await window.getByTestId('plugins-entry-detail-breadcrumb-root').click();
    await expect(
      window.getByTestId('plugins-entry-plugin:shared:reused-plugin-share'),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
