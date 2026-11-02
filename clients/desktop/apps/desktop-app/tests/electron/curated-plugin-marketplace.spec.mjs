import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  registerScenario,
  seedCuratedPlugins,
  seedPluginsCache,
} from './seeders/index.mjs';

// Verifies the curated (cloud-sourced) plugin marketplace row, materialized
// by Tasks 1-9 (curated-plugin-sync.ts + curated-plugin-marketplace.ts +
// PluginsPage/PluginDetailView), renders correctly through the real desktop
// UI:
//
//   - seeded:   the `curated/cloud` Marketplaces source row is visible, carries
//               the curated source label, and hides the destructive/managed
//               affordances (Remove, Update) that regular marketplaces show.
//               Opening its source detail page and a seeded plugin's detail
//               page lists the seeded skill and shows the curated
//               install-status panel.
//   - unseeded: when the served `plugins-cache.json` marketplaces array has
//               no `curated/cloud` entry, the renderer shows no curated source
//               row at all, while the rest of the Marketplaces list still
//               renders normally. This does NOT exercise
//               `scanCuratedMarketplaceUncached()`'s own empty-catalog
//               null-return contract in `curated-plugin-marketplace.ts` — see
//               the E2E-cache-gate note below for why — that contract is
//               covered by the main-process unit tests instead.
//
// `loadMarketplaces()` in `apps/desktop-app/src/main/plugins/plugin-service.ts`
// serves a cached v2 `plugins-cache.json` AS-IS under `isE2eBuild()` — it
// never rescans `curated-plugins/marketplace/` on the load path this spec
// exercises — so the seeded `plugins-cache.json` row (written by
// `seedCuratedPlugins`) is what actually drives the assertions below. The
// on-disk materialized tree is still seeded for fixture fidelity; see the
// seeder's doc comment.

const CURATED_MARKETPLACE_ID = 'curated/cloud';
const CURATED_INSTALL_API_KEY = 'csk_curated_plugin_install_e2e';
const FAKE_CLAUDE_CLI = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/fake-claude-plugin-cli.sh',
);

function marketplaceSourceRow(window, id) {
  return window.locator(
    `[data-testid="marketplace-source-row"][data-source-id="${id}"]`,
  );
}

function marketplaceSourcePlugin(window, key) {
  return window.locator(
    `[data-testid="marketplace-source-plugin"][data-plugin-key="${key}"]`,
  );
}

function makeUserDataDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupUnusedDir(userDataDir) {
  rmSync(userDataDir, { recursive: true, force: true });
  rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
}

test.describe('curated plugin marketplace', () => {
  let electronApp;
  let userDataDir;

  test.afterEach(async () => {
    if (electronApp) {
      await closeCanopy(electronApp, userDataDir);
      electronApp = undefined;
      userDataDir = undefined;
    }
    await clearScenario(DEFAULT_MOCK_BASE_URL, CURATED_INSTALL_API_KEY).catch(
      () => undefined,
    );
  });

  test('seeded: shows the curated row with managed affordances and lists a skill', async ({}, testInfo) => {
    test.setTimeout(120_000);

    userDataDir = makeUserDataDir('canopy-curated-plugins-seeded-');

    try {
      seedPluginsCache({ userDataDir });
      seedCuratedPlugins({ userDataDir });

      const launched = await launchCanopy({ userDataDir });
      electronApp = launched.electronApp;

      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();

      await app.openPluginsPage();
      await app.openPluginsTab('marketplace');

      const curatedRow = marketplaceSourceRow(window, CURATED_MARKETPLACE_ID);
      await expect(curatedRow).toBeVisible();

      // The row's source label marks it curated ("<app> curated"), distinct
      // from the row's "...Curated Marketplace" name.
      await expect(curatedRow.getByText(/ curated$/)).toBeVisible();

      // Managed-marketplace affordances are absent for the curated row: no
      // Remove and no Update action.
      await expect(
        curatedRow.getByTestId('marketplace-source-remove'),
      ).toHaveCount(0);
      await expect(
        curatedRow.getByTestId('marketplace-source-update'),
      ).toHaveCount(0);

      // A regular (non-managed) marketplace still shows both affordances, so
      // the assertions above are meaningfully scoped to the curated row and
      // not a global absence.
      const demoRow = marketplaceSourceRow(window, 'demo/market');
      await expect(demoRow).toBeVisible();
      await expect(
        demoRow.getByTestId('marketplace-source-remove'),
      ).toBeVisible();
      await expect(
        demoRow.getByTestId('marketplace-source-update'),
      ).toBeVisible();

      await curatedRow.getByTestId('marketplace-source-open').click();
      await expect(
        window.getByTestId('marketplace-source-detail'),
      ).toBeVisible();
      await expect(
        window.getByTestId('marketplace-source-breadcrumb-current'),
      ).toHaveText('Canopy Curated Marketplace');
      const writerRow = marketplaceSourcePlugin(window, 'writer-toolkit');
      await expect(writerRow).toBeVisible();
      await expect(
        marketplaceSourcePlugin(window, 'repo-search'),
      ).toBeVisible();
      // The source detail marks recommended plugins by grouping them under
      // "Recommended (n)" rather than with a per-row badge.
      const recommended = window.locator(
        'section[aria-labelledby="marketplace-source-recommended"]',
      );
      await expect(recommended).toContainText('Recommended (1)');
      await expect(
        recommended.locator(
          '[data-testid="marketplace-source-plugin"][data-plugin-key="writer-toolkit"]',
        ),
      ).toBeVisible();

      // Open the seeded skill-bearing plugin's detail page.
      await writerRow.getByText('Writer Toolkit', { exact: true }).click();

      // A source plugin opens as a Customize detail page (CAN-4267). The
      // content owns the one visible plugin title, and the page leaves through
      // its breadcrumb back to the source, not a Back/Close pair (CAN-4261).
      const detail = window.getByTestId('plugins-entry-detail');
      await expect(detail.locator('#plugin-detail-title')).toHaveCount(1);
      await expect(detail.locator('#plugin-detail-title')).toHaveText(
        'Writer Toolkit',
      );
      await expect(
        window.getByTestId('plugins-entry-detail-breadcrumb-source'),
      ).toHaveText('Canopy Curated Marketplace');
      await expect(detail.getByTestId('plugin-detail-back')).toHaveCount(0);
      // CAN-4842: the provider toggle heads the content it switches; the
      // chrome row holds page actions only.
      await expect(
        detail
          .getByTestId('plugin-detail-provider-toggle-row')
          .getByTestId('plugin-detail-provider-toggle'),
      ).toBeVisible();
      await expect(
        detail
          .getByTestId('plugin-detail-chrome')
          .getByTestId('plugin-detail-provider-toggle'),
      ).toHaveCount(0);

      // CAN-2696: the toggle is labelled as a view switch — a visible "Show:"
      // prefix, a plain-language accessible name, and a tooltip on each tab
      // explaining what selecting it displays.
      await expect(
        detail.getByTestId('plugin-detail-provider-toggle-label'),
      ).toHaveText('Show:');
      await expect(
        detail.getByRole('tablist', {
          name: 'Show plugin details for Claude or Codex',
        }),
      ).toBeVisible();
      await detail.getByTestId('plugin-detail-toggle-claude').hover();
      await expect(
        window.getByRole('tooltip', {
          name: "Show this plugin's Claude details",
        }),
      ).toBeVisible();
      await detail.getByTestId('plugin-detail-toggle-codex').hover();
      await expect(
        window.getByRole('tooltip', {
          name: "Show this plugin's Codex details",
        }),
      ).toBeVisible();
      await detail.locator('#plugin-detail-title').hover();

      // Materialized curated plugins are defaults before any provider install.
      await expect
        .poll(() =>
          window.evaluate(
            async () =>
              (await window.api.loadPreferences()).globalPluginSelections
                ?.pluginRefs,
          ),
        )
        .toContainEqual({
          marketplaceId: 'curated/cloud',
          pluginName: 'writer-toolkit',
        });

      // Curated plugins show the provider install-status panel (same panel
      // built-in plugins use).
      await expect(window.getByTestId('built-in-install-panel')).toBeVisible();
      await expect(
        window.getByTestId('built-in-install-row-claude'),
      ).toBeVisible();
      await expect(
        window.getByTestId('built-in-install-row-codex'),
      ).toBeVisible();

      // The seeded skill is listed in the plugin's Skills section.
      await expect(
        window.getByRole('heading', { name: 'Skills', exact: true }),
      ).toBeVisible();
      await expect(
        window.getByText('Drafting Notes', { exact: true }),
      ).toBeVisible();

      await window.screenshot({
        path: testInfo.outputPath('curated-plugin-marketplace-seeded.png'),
      });
    } catch (error) {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir).catch(() => undefined);
      } else {
        cleanupUnusedDir(userDataDir);
      }
      electronApp = undefined;
      userDataDir = undefined;
      throw error;
    }
  });

  test('legacy selections survive initial catalog migration and reload', async () => {
    userDataDir = makeUserDataDir('canopy-curated-legacy-');
    seedPluginsCache({ userDataDir });
    seedCuratedPlugins({ userDataDir });
    writeFileSync(
      path.join(userDataDir, 'preferences.json'),
      JSON.stringify({
        version: 1,
        preferences: {
          globalPluginSelections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [
              { marketplaceId: 'curated/cloud', pluginName: 'repo-search' },
            ],
          },
        },
      }),
    );
    const launched = await launchCanopy({ userDataDir });
    electronApp = launched.electronApp;
    const window = await electronApp.firstWindow();
    for (let attempt = 0; attempt < 2; attempt++) {
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openPluginsPage();
      await app.openSettings();
      await app.openSettingsSection('plugins');
      await window.getByTestId('active-items-summary-manage').click();
      await expect(
        window.getByTestId('customize-installed-status-filter'),
      ).toHaveAttribute('data-status', 'active');
      // The Active filter applies to Installed only; Browse cards keep their
      // own status controls.
      const installed = window.getByTestId('customize-section-installed');
      await expect(
        installed.getByTestId('plugins-entry-status-curated:writer-toolkit'),
      ).toBeHidden();
      await expect(
        installed.getByTestId('plugins-entry-status-curated:repo-search'),
      ).toHaveAttribute('data-status', 'active');
      if (attempt === 0) await window.reload();
    }
  });

  test('curated defaults can be removed and stay removed after reloading the catalog', async () => {
    userDataDir = makeUserDataDir('canopy-curated-defaults-');
    seedPluginsCache({ userDataDir });
    seedCuratedPlugins({ userDataDir });
    const launched = await launchCanopy({ userDataDir });
    electronApp = launched.electronApp;
    const window = await electronApp.firstWindow();
    let app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPluginsPage();
    await app.openSettings();
    await app.openSettingsSection('plugins');
    await window.getByTestId('active-items-summary-manage').click();
    // The Active filter applies to Installed only; Browse cards keep their
    // own status controls.
    const writer = window
      .getByTestId('customize-section-installed')
      .getByTestId('plugins-entry-status-curated:writer-toolkit');
    await expect(writer).toHaveAttribute('data-status', 'active');
    await writer.click();
    await window
      .getByTestId(
        'plugins-entry-status-curated:writer-toolkit-option-available',
      )
      .click();
    // CAN-4838: membership stays fixed while filtered, even after a status
    // change. Reloading below takes a fresh Active membership snapshot.
    await expect(writer).toBeVisible();
    await expect(writer).toHaveAttribute('data-status', 'available');
    await window.reload();
    app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPluginsPage();
    await app.openSettings();
    await app.openSettingsSection('plugins');
    await window.getByTestId('active-items-summary-manage').click();
    await expect(writer).toBeHidden();
    const preferences = await window.evaluate(() =>
      window.api.loadPreferences(),
    );
    expect(preferences.initializedCuratedPluginDefaults).toContain(
      'writer-toolkit',
    );
    expect(preferences.globalPluginSelections.pluginRefs).toContainEqual({
      marketplaceId: 'curated/cloud',
      pluginName: 'repo-search',
    });
  });

  test('unseeded: curated row is absent and the rest of the list renders normally', async ({}, testInfo) => {
    test.setTimeout(120_000);

    userDataDir = makeUserDataDir('canopy-curated-plugins-unseeded-');

    try {
      // Only the baseline (non-curated) marketplace cache is seeded — no
      // curated-plugins tree, no curated plugins-cache.json row.
      seedPluginsCache({ userDataDir });

      const launched = await launchCanopy({ userDataDir });
      electronApp = launched.electronApp;

      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();

      await app.openPluginsPage();
      await app.openPluginsTab('marketplace');

      await expect(
        marketplaceSourceRow(window, CURATED_MARKETPLACE_ID),
      ).toHaveCount(0);

      // The page otherwise renders normally: the seeded non-curated
      // marketplace is still present and interactive.
      const demoRow = marketplaceSourceRow(window, 'demo/market');
      await expect(demoRow).toBeVisible();
      await expect(
        demoRow.getByTestId('marketplace-source-open'),
      ).toBeEnabled();

      await window.screenshot({
        path: testInfo.outputPath('curated-plugin-marketplace-unseeded.png'),
      });
    } catch (error) {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir).catch(() => undefined);
      } else {
        cleanupUnusedDir(userDataDir);
      }
      electronApp = undefined;
      userDataDir = undefined;
      throw error;
    }
  });

  test('installing a curated plugin through the UI reports adoption', async () => {
    test.setTimeout(120_000);
    userDataDir = makeUserDataDir('canopy-curated-plugin-install-');

    try {
      seedPluginsCache({ userDataDir });
      seedCuratedPlugins({ userDataDir });
      await registerScenario(
        DEFAULT_MOCK_BASE_URL,
        CURATED_INSTALL_API_KEY,
        {},
      );

      const launched = await launchCanopy({
        userDataDir,
        env: {
          HOME: userDataDir,
          CLAUDE_CODE_EXECUTABLE: FAKE_CLAUDE_CLI,
          CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
        },
      });
      electronApp = launched.electronApp;

      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      const saveResult = await window.evaluate(
        async (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
        CURATED_INSTALL_API_KEY,
      );
      expect(saveResult.status.authenticated).toBe(true);

      await app.openPluginsPage();
      await app.openPluginsTab('marketplace');
      await marketplaceSourceRow(window, CURATED_MARKETPLACE_ID)
        .getByTestId('marketplace-source-open')
        .click();
      await marketplaceSourcePlugin(window, 'writer-toolkit')
        .getByText('Writer Toolkit', { exact: true })
        .click();
      await window.getByTestId('built-in-install-button-claude').click();

      await expect(
        window.getByTestId('built-in-install-message'),
      ).toContainText('Installed to Claude');
      await expect
        .poll(() =>
          window.evaluate(
            async () =>
              (await window.api.loadPreferences()).globalPluginSelections
                ?.pluginRefs,
          ),
        )
        .toContainEqual({
          marketplaceId: 'curated/cloud',
          pluginName: 'writer-toolkit',
        });
      await expect
        .poll(
          async () => {
            const { activity } = await getScenarioActivity(
              DEFAULT_MOCK_BASE_URL,
              CURATED_INSTALL_API_KEY,
            );
            return activity.curatedPluginInstalled ?? 0;
          },
          { timeout: 15_000 },
        )
        .toBe(1);
    } catch (error) {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir).catch(() => undefined);
      } else {
        cleanupUnusedDir(userDataDir);
      }
      electronApp = undefined;
      userDataDir = undefined;
      throw error;
    }
  });
});
