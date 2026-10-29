// The account menu's Usage row paints the ink its alert names.
//
// The row's caller used to append `fg-destructive` at a critical alert and
// lose it to the stylesheet's order: the row's own `fg-primary` is emitted
// later, so the appended ink never rendered. `DropdownMenuItem alert` replaces
// the row's ink instead. This spec reaches the menu the way a user does, with
// the mock provider's five-hour window at 100% (`usage-limit-reached`, above
// the 98% critical threshold), and reads the computed color back, so a class
// that never rendered fails here. (The More menu's selected Remote Control
// row, the other typed-prop change, is only selected while the Remote Control
// dialog covers the sidebar, so no user flow can hover it; its unit test
// covers that composition.)
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { DEFAULT_MOCK_BASE_URL } from './seeders/index.mjs';
import {
  clearScenario,
  registerScenario,
} from './seeders/registerScenario.mjs';

// The app sends `Bearer mock` to the shared mock server (launchCanopy.mjs), so
// the scenario registered under this key drives its Claude usage probe.
const SCENARIO_KEY = 'mock';

/** The computed value a class resolves to, from a probe carrying only it. */
async function probeColor(window, className, property) {
  return window.evaluate(
    ({ className, property }) => {
      const probe = document.createElement('span');
      probe.className = className;
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).getPropertyValue(property);
      probe.remove();
      return value;
    },
    { className, property },
  );
}

async function computed(locator, property) {
  return locator.evaluate(
    (el, property) => getComputedStyle(el).getPropertyValue(property),
    property,
  );
}

test.describe('sidebar menu inks', () => {
  test('the Usage row reads in the destructive ink at a critical alert', async () => {
    test.setTimeout(120_000);
    await registerScenario(DEFAULT_MOCK_BASE_URL, SCENARIO_KEY, {
      authUsage: { scenario: 'usage-limit-reached' },
    });
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-menu-inks-'),
    );
    seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
      checkRuntimes: false,
    });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await window.addStyleTag({
        content: '*, *::before, *::after { transition: none !important; }',
      });
      await app.openMainPage();

      // Account menu → Usage row at a critical alert. The alert dot proves the
      // mock window reached the store before the ink is read.
      const accountRow = window.locator(
        '[data-onboarding-anchor="sidebar-account-row"]',
      );
      await expect(accountRow).toBeVisible();
      await accountRow.click();
      const accountMenu = window.getByTestId('sidebar-account-menu');
      await expect(accountMenu).toBeVisible();
      const usageRow = accountMenu.getByTestId(
        'sidebar-account-menu-item-usage',
      );
      await expect(usageRow).toBeVisible();
      await expect(
        usageRow.getByTestId('sidebar-account-usage-alert-dot'),
      ).toBeVisible({ timeout: 20_000 });
      const destructive = await probeColor(window, 'fg-destructive', 'color');
      const primary = await probeColor(window, 'fg-primary', 'color');
      expect(destructive).not.toBe(primary);
      await expect.poll(() => computed(usageRow, 'color')).toBe(destructive);
      await window.keyboard.press('Escape');
      await expect(accountMenu).toBeHidden();
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, SCENARIO_KEY);
    }
  });
});
