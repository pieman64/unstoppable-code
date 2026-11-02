import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedAutomations } from './seeders/index.mjs';
import { seedPluginsCache } from './seeders/seedPluginsCache.mjs';

// With no saved role, Suggested uses the default role's picks (BigQuery first).
const SHAREABLE_ENTRY_ID = 'mkt:openai-curated/bigquery';

test('keeps parent Share when navigating to an installed plugin member skill', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'plugin-member-share-'),
  );
  const pluginRoot = path.join(userDataDir, 'fixture-plugin');
  mkdirSync(path.join(pluginRoot, 'skills/review'), { recursive: true });
  writeFileSync(
    path.join(pluginRoot, 'skills/review/SKILL.md'),
    '# Review\nMember skill content\n',
  );
  const { cacheFilePath } = seedPluginsCache({
    userDataDir,
    installedPluginCachePaths: { 'gamma-tool': pluginRoot },
  });
  const cache = JSON.parse(readFileSync(cacheFilePath, 'utf8'));
  cache.marketplaces[0].installLocation = pluginRoot;
  const plugin = cache.marketplaces[0].plugins.find(
    (row) => row.name === 'gamma-tool',
  );
  plugin.details.skills = [
    { name: 'Review', description: 'Review code', path: 'skills/review' },
  ];
  writeFileSync(cacheFilePath, JSON.stringify(cache));
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openPluginsPage();
    await window.getByTestId('plugins-search').fill('gamma-tool');
    await window
      .getByTestId('customize-row-mkt:demo/market/gamma-tool')
      .click();
    await expect(window.getByTestId('plugin-detail-share')).toBeVisible();
    await window.getByRole('button', { name: 'Review', exact: true }).click();
    await expect(window.getByText('Member skill content')).toBeVisible();
    await expect(window.getByTestId('plugin-detail-share')).toHaveCount(1);
    await expect(window.getByTestId('plugin-detail-share')).toBeVisible();
    await window.getByTestId('plugin-detail-back').click();
    await expect(window.getByTestId('plugin-detail-share')).toHaveCount(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

function seedSuggestedShareablePlugin(userDataDir) {
  const { cacheFilePath } = seedPluginsCache({ userDataDir });
  const cache = JSON.parse(readFileSync(cacheFilePath, 'utf8'));
  const marketplace = cache.marketplaces[0];
  marketplace.id = 'openai-curated';
  marketplace.name = 'Codex official';
  marketplace.sourceType = 'codex';
  marketplace.sourceUrl = 'openai-curated';
  for (const plugin of marketplace.plugins) {
    plugin.marketplaceId = marketplace.id;
  }
  // Suggested holds only plugins that are still available to add, so the
  // renamed fixture must be one the seeder leaves uninstalled.
  const suggestedPlugin = marketplace.plugins.find(
    (plugin) => plugin.name === 'beta-tool',
  );
  if (!suggestedPlugin) {
    throw new Error('Seeded beta-tool plugin was not found');
  }
  suggestedPlugin.name = 'bigquery';
  suggestedPlugin.displayName = 'BigQuery';
  writeFileSync(cacheFilePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
}

// The Plugins card-level share action is a second entry point into the same
// share flow that `can-2323-plugin-share.spec.mjs` drives from the detail view.
// It carries its own sign-in gate, so both the gated and the connected paths
// are asserted here.
test('shares a plugin from its card and Suggested detail', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'plugins-card-share-'),
  );
  seedSuggestedShareablePlugin(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    await app.openPluginsPage();
    const cardShare = window.getByTestId(
      `plugins-entry-share-${SHAREABLE_ENTRY_ID}`,
    );
    await expect(cardShare).toBeVisible({ timeout: 15_000 });

    await window.getByTestId(`plugins-entry-${SHAREABLE_ENTRY_ID}`).click();
    const detail = window.getByTestId('plugin-catalog-detail');
    await expect(detail).toBeVisible();
    // CAN-3723: this is the page-presented catalog flow, not an installed
    // plugin dialog. Desktop's breadcrumb stays in the titlebar and is not
    // expected to meet the body edge.
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 1920, height: 1080 },
    ]) {
      await window.setViewportSize(viewport);
      await window.evaluate(() => document.fonts.ready);
      const shell = window.getByTestId('plugins-entry-detail');
      const content = shell.locator('..');
      const box = await shell.boundingBox();
      if (!box) throw new Error('Desktop page detail has no bounding box');
      const bounds = await content.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const px = (value) => Number.parseFloat(value) || 0;
        return {
          left: rect.left + px(style.borderLeftWidth) + px(style.paddingLeft),
          right:
            rect.right - px(style.borderRightWidth) - px(style.paddingRight),
        };
      });
      // CAN-4261: the page has no Back; the breadcrumb leads out.
      await expect(window.getByTestId('plugins-entry-detail-back')).toHaveCount(
        0,
      );
      for (const edge of [
        detail,
        // The description sits in a wrapper with "Also available from" (CAN-3653).
        detail.locator(':scope > div > p').first(),
        detail
          .getByRole('heading', { name: 'Included', exact: true })
          .locator('..'),
      ]) {
        await expect(edge).toBeVisible();
        await expect
          .poll(async () => {
            const edgeBox = await edge.boundingBox();
            if (!edgeBox)
              throw new Error('Desktop detail edge has no bounding box');
            return Math.abs(edgeBox.x - box.x);
          })
          .toBeLessThanOrEqual(1);
      }
      expect(
        Math.abs(box.x - bounds.left - (bounds.right - box.x - box.width)),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(box.width - Math.min(768, bounds.right - bounds.left)),
      ).toBeLessThanOrEqual(1);
    }
    await window.setViewportSize({ width: 1280, height: 720 });
    // The standard action bar at the top right of the Back row, above the
    // summary: [Share] [Add], Share immediately left of the primary Add.
    const actionBar = window
      .getByTestId('plugins-entry-detail')
      .getByTestId('detail-action-bar');
    const detailShare = actionBar.getByTestId('plugins-entry-detail-share');
    const detailAdd = actionBar.getByTestId('plugin-catalog-detail-add');
    await expect(detail.getByRole('button')).toHaveCount(0);
    await expect(detailShare).toBeVisible();
    await expect(detailShare).toHaveText('Share');
    await expect(detailShare).toHaveAccessibleName('Share BigQuery');
    await expect(detailAdd).toBeVisible();
    await expect
      .poll(async () => {
        const [shareBox, addBox, detailBox] = await Promise.all([
          detailShare.boundingBox(),
          detailAdd.boundingBox(),
          detail.boundingBox(),
        ]);
        if (!shareBox || !addBox || !detailBox) return null;
        return {
          shareBeforeAdd: shareBox.x + shareBox.width <= addBox.x,
          sameRow:
            Math.abs(
              shareBox.y + shareBox.height / 2 - (addBox.y + addBox.height / 2),
            ) <= 1,
          aboveSummary: addBox.y + addBox.height <= detailBox.y,
        };
      })
      .toEqual({ shareBeforeAdd: true, sameRow: true, aboveSummary: true });

    // Signed out: the detail action reaches the same sign-in gate as the card.
    await detailShare.click();
    const detailGate = window.getByTestId('cloud-sync-modal');
    await expect(detailGate).toBeVisible();
    await expect(detailGate).toContainText('Sign in to share plugins');
    await expect(window.getByTestId('share-plugin-modal')).toHaveCount(0);
    await window.keyboard.press('Escape');
    await expect(detailGate).toHaveCount(0);
    await window.getByTestId('plugins-entry-detail-breadcrumb-root').click();

    // Signed out: the card action must raise the sign-in gate, not the modal.
    await cardShare.click();
    const gate = window.getByTestId('cloud-sync-modal');
    await expect(gate).toBeVisible();
    await expect(gate).toContainText('Sign in to share plugins');
    await expect(window.getByTestId('share-plugin-modal')).toHaveCount(0);
    await window.keyboard.press('Escape');
    await expect(gate).toHaveCount(0);

    // Connected: the same card action opens the share modal directly.
    const account = await window.evaluate(() =>
      window.api.saveCanopyCloudApiKey({
        apiKey: 'csk_plugins_card_share_e2e',
      }),
    );
    expect(account.status).toMatchObject({ authenticated: true });
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });

    await window.getByTestId(`plugins-entry-${SHAREABLE_ENTRY_ID}`).click();
    await window.getByTestId('plugins-entry-detail-share').click();
    const modal = window.getByTestId('share-plugin-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText(
      'Public source: codex-builtin:openai-curated',
    );
    // Public is the only usable audience: every scope still shows, Team and
    // Organization disabled and Public preselected. The dialog says who can
    // see the share, and the note says only what a plugin share is (CAN-3009).
    await expect(modal.getByTestId('share-plugin-scope-team')).toBeDisabled();
    await expect(
      modal.getByTestId('share-plugin-scope-organization'),
    ).toBeDisabled();
    await expect(
      modal.getByTestId('share-plugin-scope-public'),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(
      modal.getByTestId('share-plugin-scope-description'),
    ).toHaveText(
      'Anyone can view this plugin. It may appear in public discovery and search.',
    );
    await expect(modal.getByTestId('share-plugin-reference-note')).toHaveText(
      'Only a reference to this plugin is shared. Credentials, private configuration, and local files are never included.',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

const OWN_AUTOMATION_ID = 'marketplace-own-standup';
const OWN_AUTOMATION_ENTRY_ID = `automation:local:${OWN_AUTOMATION_ID}`;

// CAN-3009: the user's own automations, skills, pipelines and collections
// share from the Marketplace through the same dialog their own pages open.
// An automation is the case with no sign-in gate in front: its dialog carries
// its own connect state, so the Public audience stays reachable.
test("shares the user's own automation from its Marketplace card and detail", async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'plugins-own-share-'));
  seedAutomations({
    userDataDir,
    activities: [
      {
        version: 1,
        id: OWN_AUTOMATION_ID,
        name: 'Morning standup',
        enabled: true,
        schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
        action: { type: 'app_advisor_prompt', prompt: 'Summarize the day' },
        createdAt: '2026-08-19T12:00:00.000Z',
        updatedAt: '2026-08-19T12:00:00.000Z',
        failureCount: 0,
      },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    await app.openPluginsPage();
    await window.getByTestId('plugins-type-tab-workflow').click();

    await window
      .getByTestId(`customize-row-menu-${OWN_AUTOMATION_ENTRY_ID}`)
      .click();
    const cardShare = window.getByTestId(
      `customize-row-menu-${OWN_AUTOMATION_ENTRY_ID}-share`,
    );
    await expect(cardShare).toBeVisible({ timeout: 15_000 });
    await expect(cardShare).toHaveAccessibleName('Share…');

    // The card opens the automation share dialog directly: no sign-in gate.
    await cardShare.click();
    const modal = window.getByTestId('share-automation-modal');
    await expect(modal).toBeVisible();
    await expect(window.getByTestId('cloud-sync-modal')).toHaveCount(0);
    await window.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);

    // The detail header offers the same action.
    await window
      .getByTestId(`customize-row-${OWN_AUTOMATION_ENTRY_ID}`)
      .click();
    const detailShare = window.getByTestId('plugins-entry-detail-share');
    await expect(detailShare).toBeVisible();
    await detailShare.click();
    await expect(window.getByTestId('share-automation-modal')).toBeVisible();
    await window.keyboard.press('Escape');

    // The detail action retains the shared Share glyph. Installed row menus
    // expose Share as a text action.
    await expect(detailShare.locator('svg').first()).toHaveAttribute(
      'data-glyph',
      /.+/,
    );

    // The Installed row menu continues to offer the same authorized action.
    await window.getByTestId('plugins-entry-detail-breadcrumb-type').click();
    await window
      .getByTestId(`customize-row-menu-${OWN_AUTOMATION_ENTRY_ID}`)
      .click();
    await expect(cardShare).toBeVisible();
    await expect(cardShare).toBeEnabled();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('blocks plugin sharing after analysis failure and permits a successful retry', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'plugins-analysis-retry-'),
  );
  seedSuggestedShareablePlugin(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const account = await window.evaluate(() =>
      window.api.saveCanopyCloudApiKey({
        apiKey: 'csk_plugins_analysis_retry_e2e',
      }),
    );
    expect(account.status).toMatchObject({ authenticated: true });
    await window.evaluate(() =>
      window.dispatchEvent(new Event('canopy:cloud-account-changed')),
    );
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('plugins:shared-reference-analyze');
      ipcMain.handle('plugins:shared-reference-analyze', async () => ({
        success: false,
        error: 'Reference analysis failed.',
      }));
    });
    const analysis = await window.evaluate(() =>
      window.plugins.analyzeSharedReference({
        ref: {
          type: 'plugin',
          marketplace: { type: 'github', repo: 'acme/plugins' },
          plugin_name: 'browser',
        },
      }),
    );
    expect(analysis).toEqual({
      success: false,
      error: 'Reference analysis failed.',
    });
    await app.openPluginsPage();
    await window
      .getByTestId(`plugins-entry-share-${SHAREABLE_ENTRY_ID}`)
      .click();
    const modal = window.getByTestId('share-plugin-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText(
      "Couldn't check the included files. Try again.",
    );
    await expect(modal.getByTestId('share-plugin-submit')).toBeDisabled();
    const retry = modal.getByTestId('share-plugin-dependencies-retry');
    await expect(retry).toBeVisible();
    await expect(retry).toHaveText('Try again');
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('plugins:shared-reference-analyze');
      ipcMain.handle('plugins:shared-reference-analyze', async () => ({
        success: true,
        data: {
          analysisId: 'verified-reference-analysis',
          state: 'ready',
          pipelineContentHash: 'a'.repeat(64),
          manifest: {
            version: 1,
            pipelineContentHash: 'a'.repeat(64),
            resources: [],
            bindings: [],
            environmentRequirements: [],
            totalFiles: 0,
            totalBytes: 0,
          },
          blockers: [],
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
      }));
    });
    await retry.click();
    await expect(modal.getByTestId('share-plugin-submit')).toBeEnabled();
    await expect(modal).not.toContainText(
      "Couldn't check the included files. Try again.",
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// CAN-3704: unsupported installed plugins explain blocked sharing from
// the row menu and detail without opening authentication.
test('explains blocked Marketplace sharing on an Installed row and detail at 900px', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can3704-blocked-'));
  seedPluginsCache({ userDataDir });
  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize: null,
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const browserWindow = await electronApp.browserWindow(window);
    await browserWindow.evaluate((host) => host.setSize(900, 800));
    await expect.poll(() => window.evaluate(() => innerWidth)).toBe(900);
    await app.openPluginsPage();
    await window.getByTestId('plugins-search').fill('delta-tool');
    const row = window.getByTestId('customize-row-mkt:demo/market/delta-tool');
    const menu = window.getByTestId(
      'customize-row-menu-mkt:demo/market/delta-tool',
    );
    await expect(row).toBeVisible();
    await menu.click();
    const share = window.getByTestId(
      'customize-row-menu-mkt:demo/market/delta-tool-share',
    );
    await expect(share).toBeVisible();
    await expect(share).toHaveAttribute('aria-disabled', 'true');
    await expect(share).toHaveAttribute(
      'aria-description',
      'This plugin has no public source to share.',
    );
    // A reasoned action is natively disabled (CAN-4844), so the reason
    // reaches assistive tech through its name and description, not focus.
    await expect(share).toHaveJSProperty('disabled', true);
    await expect(share).toHaveAccessibleName(
      'Share…: This plugin has no public source to share.',
    );
    const [rowBox, menuBox] = await Promise.all([
      row.locator('..').boundingBox(),
      menu.boundingBox(),
    ]);
    expect(menuBox.x).toBeGreaterThanOrEqual(rowBox.x);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(
      rowBox.x + rowBox.width,
    );
    await share.click({ force: true });
    await expect(window.getByTestId('cloud-sync-modal')).toHaveCount(0);
    await expect(window.getByTestId('share-plugin-modal')).toHaveCount(0);
    await window.keyboard.press('Escape');
    await row.click();
    const detailShare = window.getByTestId('plugin-detail-share');
    await expect(detailShare).toHaveText('Share');
    await expect(detailShare).toHaveAttribute('aria-disabled', 'true');
    // Top right of the Back row, never inside the install actions.
    await expect(
      window
        .getByTestId('plugin-detail-chrome')
        .getByTestId('plugin-detail-share'),
    ).toHaveCount(1);
    await expect(
      window
        .getByTestId('built-in-install-panel')
        .getByTestId('plugin-detail-share'),
    ).toHaveCount(0);
    await expect(
      window
        .getByTestId('plugin-detail-host')
        .getByRole('button', { name: /Share Delta Tool/i }),
    ).toHaveCount(1);
    await detailShare.click({ force: true });
    await expect(window.getByTestId('cloud-sync-modal')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
