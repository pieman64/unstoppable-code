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
    await window
      .locator(
        '[data-testid="marketplace-source-row"][data-source-id="demo/market"]',
      )
      .getByTestId('marketplace-source-open')
      .click();
    const row = window.locator(
      '[data-testid="marketplace-source-plugin"][data-plugin-key="alpha-tool"]',
    );
    await expect(row.getByText('Alpha Tool', { exact: true })).toBeVisible();
    // The fixture description contains "alpha-tool (external)"; assert the
    // name itself, not unrelated description copy.
    await expect(
      row.getByText('alpha-tool', { exact: true }),
    ).not.toBeVisible();
    await row.getByText('Alpha Tool', { exact: true }).click();
    // A source plugin opens as a Customize detail page (CAN-4267), which
    // leaves through its breadcrumb rather than a dialog Back/Close.
    const detail = window.getByTestId('plugins-entry-detail');
    await expect(detail.locator('#plugin-detail-title')).toHaveText(
      'Alpha Tool',
    );
    await window.getByTestId('plugins-entry-detail-breadcrumb-sources').click();
    await window
      .locator(
        '[data-testid="marketplace-source-row"][data-source-id="curated/cloud"]',
      )
      .getByTestId('marketplace-source-open')
      .click();
    await expect(
      window
        .locator(
          '[data-testid="marketplace-source-plugin"][data-plugin-key="writer-toolkit"]',
        )
        .getByText('Writer Toolkit', { exact: true }),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
