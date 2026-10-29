import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { spawnPanelTerminal } from './panelHarness.mjs';

const WORKTREE_BRANCH = 'demo-main';
const COPY_PROBE_TEXT = 'CANOPY_TERMINAL_COPY_PROBE';

test.describe('integrated terminal selection copy', () => {
  test.setTimeout(120_000);

  test('copies selected terminal text from the selection action menu', async ({}, testInfo) => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-terminal-selection-copy-'),
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

      // Phase 3 panel cutover: the terminal group is always expanded but
      // never auto-spawns — create the first terminal from its empty state.
      const pane = await spawnPanelTerminal(window);
      await pane.click();

      await window.keyboard.type(`printf '\\n${COPY_PROBE_TEXT}\\n\\n'`);
      await window.keyboard.press('Enter');
      await expect
        .poll(() => pane.innerText(), { timeout: 20_000 })
        .toContain(COPY_PROBE_TEXT);

      const outputRow = pane
        .locator('.xterm-rows > div')
        .filter({ hasText: COPY_PROBE_TEXT })
        .last();
      await expect(outputRow).toBeVisible({ timeout: 10_000 });
      const outputBox = await outputRow.boundingBox();
      expect(outputBox).not.toBeNull();

      await window.keyboard.down('Alt');
      await window.mouse.click(
        outputBox.x + Math.min(24, outputBox.width / 2),
        outputBox.y + outputBox.height / 2,
      );
      await window.keyboard.up('Alt');

      const copyButton = window.getByTestId('terminal-selection-copy');
      await expect(copyButton).toBeVisible({ timeout: 10_000 });
      await copyButton.click();
      await expect(copyButton).toHaveAttribute('aria-label', 'Copied');

      await expect
        .poll(
          () => electronApp.evaluate(({ clipboard }) => clipboard.readText()),
          { timeout: 10_000 },
        )
        .toContain(COPY_PROBE_TEXT);

      await window.screenshot({
        path: testInfo.outputPath('terminal-selection-copy.png'),
      });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
