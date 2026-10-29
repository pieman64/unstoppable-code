import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { spawnPanelTerminal } from './panelHarness.mjs';

const WORKTREE_BRANCH = 'demo-main';

test.describe('integrated terminal shell selector', () => {
  test.setTimeout(120_000);

  test('opens the launch profile menu and launches a selected shell profile', async ({}, testInfo) => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-terminal-shell-selector-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();

      // Start the default panel, then add another terminal through the same
      // outer workspace `+` menu used for Browser tabs.
      await spawnPanelTerminal(window);

      const profiles = await window.evaluate(() =>
        window.api.terminal.listProfiles(),
      );
      expect(profiles.length).toBeGreaterThan(0);
      expect(profiles.filter((profile) => profile.isDefault)).toHaveLength(1);

      const selectedProfile =
        profiles.find((profile) => !profile.isDefault) ?? profiles[0];
      await window.getByTestId('panel-add-panel-group-terminal').click();
      const menu = window.getByTestId('panel-add-menu');
      await expect(menu).toBeVisible();
      await expect(menu).toHaveAttribute('role', 'menu');
      await window.getByTestId('panel-add-menu-terminal-submenu').click();
      for (const profile of profiles) {
        const row = profile.isDefault
          ? window.getByTestId('panel-add-menu-item-terminal')
          : window.getByTestId(`panel-add-menu-item-terminal-${profile.id}`);
        await expect(row).toHaveText(
          profile.isDefault ? `${profile.label}Default` : profile.label,
        );
      }
      const defaultProfile = profiles.find((profile) => profile.isDefault);
      expect(defaultProfile).toBeTruthy();
      if (defaultProfile) {
        await expect(
          window.getByTestId('panel-add-menu-item-terminal-default-badge'),
        ).toHaveText('Default');
      }

      const selectedRow = selectedProfile.isDefault
        ? window.getByTestId('panel-add-menu-item-terminal')
        : window.getByTestId(
            `panel-add-menu-item-terminal-${selectedProfile.id}`,
          );
      await selectedRow.click();

      await expect(menu).toBeHidden();
      await expect(
        window.locator('[data-testid^="panel-tab-panel-terminal"]'),
      ).toHaveCount(2, { timeout: 20_000 });
      await expect(
        window.locator('[data-testid^="panel-tab-panel-terminal"]').last(),
      ).toContainText(selectedProfile.label);

      await window.screenshot({
        path: testInfo.outputPath('terminal-shell-selector.png'),
      });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
