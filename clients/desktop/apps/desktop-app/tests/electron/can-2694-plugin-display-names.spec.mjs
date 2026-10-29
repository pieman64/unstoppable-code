// CAN-2694 — Plugin names use manifest spelling or brand-aware slug labels.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedCuratedPlugins, seedPluginsCache } from './seeders/index.mjs';

test('humanizes marketplace plugin names and preserves manifest names', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can2694-'));
  seedPluginsCache({ userDataDir });
  seedCuratedPlugins({ userDataDir });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPluginsPage();
    await app.openPluginsTab('marketplace');
    await window.getByTestId('marketplace-row-demo/market').click();
    const row = window.getByTestId('plugin-row-alpha-tool');
    await expect(row.getByText('Alpha Tool', { exact: true })).toBeVisible();
    // The fixture description contains "alpha-tool (external)"; assert the
    // name itself, not unrelated description copy.
    await expect(
      row.getByText('alpha-tool', { exact: true }),
    ).not.toBeVisible();
    await row.click();
    const dialog = window.getByRole('dialog').filter({
      has: window.locator('#plugin-detail-title'),
    });
    await expect(dialog.locator('#plugin-detail-title')).toHaveText(
      'Alpha Tool',
    );
    await dialog.getByTestId('plugin-detail-back').click();
    await window
      .getByRole('dialog')
      .filter({ has: row })
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await window.getByTestId('marketplace-row-curated/cloud').click();
    await expect(
      window
        .getByTestId('plugin-row-writer-toolkit')
        .getByText('Writer Toolkit', { exact: true }),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
