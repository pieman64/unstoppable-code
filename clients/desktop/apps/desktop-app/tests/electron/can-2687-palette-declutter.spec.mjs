import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// CAN-2687: preserve command shortcuts while removing word hints and category
// pills. The keyboard-hints pattern brings the legend back as key caps only.
test('search palette shows a caps-only key legend, no category pills, and keeps shortcuts', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-palette-declutter-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.getByTestId('sidebar-search').click();
    const palette = window.getByTestId('command-palette');
    await expect(palette).toBeVisible();
    for (const hint of ['Enter to run', 'Esc to close', 'to navigate']) {
      await expect(palette).not.toContainText(hint);
    }
    const legend = palette.getByTestId('key-hint-footer');
    await expect(legend).toBeVisible();
    await expect(legend.locator('kbd')).toHaveCount(4);
    await expect(legend).toContainText('move');
    await expect(legend).toContainText('open');
    await expect(legend).toContainText('close');
    // "Type > for commands" names its key as a cap.
    await expect(
      palette.getByTestId('command-palette-mode-hint').locator('kbd'),
    ).toHaveText('>');
    await window.getByTestId('command-palette-input').fill('>');
    const row = palette
      .getByTestId('command-palette-result')
      .filter({ hasText: 'Keyboard shortcuts' });
    await expect(row).toBeVisible();
    await expect(row.getByTestId('command-palette-shortcut')).toBeVisible();
    await expect(row.getByTestId('command-palette-status-badge')).toHaveCount(
      0,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
