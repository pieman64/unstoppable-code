import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedPluginsCache } from './seeders/index.mjs';

// Verifies rendering of uninstalled-plugin surfacing affordances:
//
//   - `marketplace-missing-count-<id>`  — badge on the marketplace row
//   - `bulk-install-plugins`            — header bulk action in the modal
//   - `plugin-install-<name>`           — per-row install button (needs install)
//   - `plugin-install-status-<name>`    — per-row status cell (installed/inline)
//
// The spec seeds a v2 plugins-cache.json with one marketplace that has two
// external plugins needing install, one installed external plugin, and one
// inline plugin. It does NOT assert a successful install because the harness is
// offline and install clones a git repo.
//
// The E2E build gates out scheduleDeferredStartupBackgroundTasks (isE2eBuild()
// returns true), so refreshMarketplaces never runs on startup and the seeded
// cache is served unchanged by loadMarketplaces.

test.describe('marketplace uninstalled-plugin surfacing', () => {
  let electronApp;
  let userDataDir;

  test.afterEach(async () => {
    if (electronApp) {
      await closeCanopy(electronApp, userDataDir);
      electronApp = undefined;
      userDataDir = undefined;
    }
  });

  test('shows counter, per-row status, and bulk action', async ({}, testInfo) => {
    test.setTimeout(120_000);

    // Pre-create the temp dir so we can seed before the app starts.
    userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-marketplace-install-'),
    );

    try {
      seedPluginsCache({ userDataDir });

      const launched = await launchCanopy({ userDataDir });
      electronApp = launched.electronApp;

      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();

      await app.openPluginsPage();
      await app.openPluginsTab('marketplace');

      // Marketplace list counter: 2 external plugins need install.
      const badge = window.getByTestId('marketplace-missing-count-demo/market');
      await expect(badge).toBeVisible();
      await expect(badge).toContainText('2');

      // Open the marketplace plugins modal.
      // The table row also contains the "Check for updates" button. Clicking
      // the row locator's center can land on that nested control, which
      // intentionally refreshes the offline fixture and removes its cached
      // plugin rows. Use the name cell so this test exercises the row-open
      // affordance rather than the adjacent refresh action.
      await window
        .getByTestId('marketplace-row-demo/market')
        .locator('td')
        .first()
        .click();

      // Bulk action present with correct count.
      await expect(window.getByTestId('bulk-install-plugins')).toContainText(
        'Install 2 plugins',
      );

      // Per-row: needs-install rows show an install button; installed/inline
      // rows show a status (check) cell.
      await expect(
        window.getByTestId('plugin-install-alpha-tool'),
      ).toBeVisible();
      await expect(
        window.getByTestId('plugin-install-beta-tool'),
      ).toBeVisible();
      await expect(
        window.getByTestId('plugin-install-status-gamma-tool'),
      ).toBeVisible();
      await expect(
        window.getByTestId('plugin-install-status-delta-tool'),
      ).toBeVisible();

      await window.screenshot({
        path: testInfo.outputPath('marketplace-install-surfacing.png'),
      });
    } catch (error) {
      // Clean up the pre-created dir; launchCanopy only cleans up dirs it
      // creates itself, and this spec passes reuseDir=true.
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir).catch(() => undefined);
      } else {
        rmSync(userDataDir, { recursive: true, force: true });
        rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
      }
      electronApp = undefined;
      userDataDir = undefined;
      throw error;
    }
  });
});
