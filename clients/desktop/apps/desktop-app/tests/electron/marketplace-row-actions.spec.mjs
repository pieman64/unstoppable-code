import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedPluginsCache } from './seeders/index.mjs';

test('marketplace row actions switch in one press and stay visible on the last row', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-marketplace-row-actions-'),
  );
  const { cacheFilePath } = seedPluginsCache({ userDataDir });
  const cache = JSON.parse(readFileSync(cacheFilePath, 'utf8'));
  cache.marketplaces.push({
    ...cache.marketplaces[0],
    id: 'demo/second',
    name: 'Second Market',
    sourceUrl: 'https://github.invalid/demo/second',
    installLocation: '/tmp/demo-second',
    plugins: [],
    pluginCount: 0,
  });
  cache.marketplaces.push({
    ...cache.marketplaces[0],
    id: 'demo/third',
    name: 'Third Market',
    sourceUrl: 'https://github.invalid/demo/third',
    installLocation: '/tmp/demo-third',
    plugins: [],
    pluginCount: 0,
  });
  writeFileSync(cacheFilePath, JSON.stringify(cache));

  const launch = await launchCanopy({ userDataDir });
  try {
    const window = await launch.electronApp.firstWindow();
    await window.setViewportSize({ width: 1280, height: 800 });
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPluginsPage();
    await app.openPluginsTab('marketplace');

    const sourceRow = (id) =>
      window.locator(
        `[data-testid="marketplace-source-row"][data-source-id="${id}"]`,
      );
    const first = sourceRow('demo/market');
    const last = sourceRow('demo/third');
    const firstRemove = first.getByTestId('marketplace-source-remove');
    const lastRemove = last.getByTestId('marketplace-source-remove');
    await expect(firstRemove).toBeVisible();
    await expect(lastRemove).toBeVisible();

    // Marketplace source rows show Update and Remove directly, with no per-row
    // menu. After one row's confirmation is cancelled, a single press on
    // another row's Remove opens that row's confirmation.
    await firstRemove.click();
    const firstConfirmation = window.getByRole('dialog', {
      name: 'Remove Demo Market?',
    });
    await expect(firstConfirmation).toBeVisible();
    await firstConfirmation
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();
    await expect(firstConfirmation).not.toBeVisible();

    // The last row's action stays inside the viewport and unobscured. Rows no
    // longer sit in a clipping table frame, so there is no frame edge to
    // compare against.
    await lastRemove.scrollIntoViewIfNeeded();
    const bounds = await lastRemove.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        unobscured: hit === element || element.contains(hit),
      };
    });
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth);
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight);
    expect(bounds.unobscured).toBe(true);

    await lastRemove.click();
    const confirmation = window.getByTestId('marketplace-source-remove-dialog');
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toHaveAccessibleName('Remove Third Market?');
    await expect(confirmation).toContainText('Third Market');
    await expect(confirmation).toContainText(
      'will remove this marketplace from Claude',
    );
    await expect(
      confirmation.getByTestId('marketplace-source-remove-confirm'),
    ).toBeVisible();
    await confirmation.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirmation).not.toBeVisible();
    await expect(last).toBeVisible();
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});
