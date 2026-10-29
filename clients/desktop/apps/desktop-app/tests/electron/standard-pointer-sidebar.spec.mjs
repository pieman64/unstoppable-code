import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { launchCanopyWithLabsPagesOffered } from './helpers/labsPages.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import { seedChatsSectionFixture } from './seeders/index.mjs';

for (const saved of ['opaque', 'translucent']) {
  test(`standard pointer menus and sidebar material ignore retired ${saved} preferences`, async () => {
    test.setTimeout(90000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'standard-pointer-sidebar-'),
    );
    seedChatsSectionFixture(userDataDir, { worktreeCount: 2 });
    mkdirSync(path.join(userDataDir, 'labs-experiments'), { recursive: true });
    writeFileSync(
      path.join(userDataDir, 'labs-experiments', 'choices.json'),
      JSON.stringify({
        version: 1,
        accounts: {
          local: {
            'early-access': false,
            sidebar: false,
            'pointer-menus': false,
          },
        },
      }),
    );
    const launched = await launchCanopyWithLabsPagesOffered({ userDataDir });
    try {
      const page = await launched.electronApp.firstWindow();
      const app = new CanopyAppDriver(page);
      await app.waitForShell({ timeout: 30000 });
      for (const [mode, material] of [
        ['light', 'translucent'],
        ['dark', 'opaque'],
      ]) {
        // Simulate an older client's saved material arriving via the canonical preference path.
        await page.evaluate(
          (saved) => window.api.savePreferences({ sidebarAppearance: saved }),
          saved,
        );
        await app.openSettings();
        await app.openSettingsSection('display');
        await page.getByTestId('settings-color-mode-select').click();
        await page.getByTestId(`color-mode-${mode}`).click();
        await expect(page.locator('html')).toHaveAttribute(
          'data-sidebar-appearance',
          material,
        );
        await expect(
          page.getByRole('group', { name: 'Sidebar background', exact: true }),
        ).toHaveCount(0);
        await expect(page.getByTestId('sidebar-style-picker')).toContainText(
          'Advanced',
        );
        await app.openSettingsSection('experiments');
        await expect(
          page.getByTestId('labs-experiment-toggle-pointer-menus'),
        ).toHaveCount(0);
        const state = await page.evaluate(() =>
          window.api.experiments.getSnapshot(),
        );
        expect(state.experiments.some((e) => e.id === 'pointer-menus')).toBe(
          false,
        );
        await app.closeSettings();
        await app.openMainPage();
      }
      const row = page.getByTestId('worktree-row').first();
      await expect(row).toBeVisible();
      const box = await row.boundingBox();
      if (!box) throw new Error('Expected worktree row bounds');
      const pointer = { x: box.x + Math.min(70, box.width / 2), y: box.y + 8 };
      await page.mouse.click(pointer.x, pointer.y, { button: 'right' });
      const menu = page.getByTestId('worktree-actions-menu');
      await expect(menu).toBeVisible();
      await expect
        .poll(async () => {
          const bounds = await menu.boundingBox();
          return bounds ? Math.abs(bounds.x - pointer.x - 2) : 1000;
        })
        .toBeLessThan(1);
      const bounds = await menu.boundingBox();
      const viewport = await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
      }));
      expect(bounds.y).toBeGreaterThanOrEqual(7);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height - 7);
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      const resources = page
        .locator('[data-testid="sidebar-resource-diagnostics-pill"]:visible')
        .first();
      await resources.click();
      const popover = page.getByTestId('resource-diagnostics-popover');
      await expect(popover).toBeVisible();
      const popoverBounds = await popover.boundingBox();
      expect(popoverBounds.x).toBeGreaterThanOrEqual(0);
      expect(popoverBounds.x + popoverBounds.width).toBeLessThanOrEqual(
        viewport.width,
      );
      expect(popoverBounds.y).toBeGreaterThanOrEqual(0);
      expect(popoverBounds.y + popoverBounds.height).toBeLessThanOrEqual(
        viewport.height,
      );
      await page.mouse.click(viewport.width - 12, viewport.height - 12);
      await expect(popover).toHaveCount(0);
      await page.reload();
      await app.waitForShell({ timeout: 30000 });
      await expect(page.locator('html')).toHaveAttribute(
        'data-sidebar-appearance',
        'opaque',
      );
    } finally {
      await closeCanopy(launched.electronApp, userDataDir);
    }
  });
}
