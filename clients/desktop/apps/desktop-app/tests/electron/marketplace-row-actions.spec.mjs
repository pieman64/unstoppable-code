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

    const first = window.getByTestId('marketplace-row-demo/market');
    const last = window.getByTestId('marketplace-row-demo/third');
    const firstTrigger = first.getByRole('button', {
      name: 'More marketplace actions',
    });
    const lastTrigger = last.getByRole('button', {
      name: 'More marketplace actions',
    });
    await expect(firstTrigger).toBeVisible();
    await expect(lastTrigger).toBeVisible();
    await firstTrigger.click();
    await expect(firstTrigger).toHaveAttribute('aria-expanded', 'true');

    await lastTrigger.click();
    await expect(lastTrigger).toHaveAttribute('aria-expanded', 'true');
    await expect(firstTrigger).toHaveAttribute('aria-expanded', 'false');
    const removeAction = window.getByTestId('remove-marketplace-action');
    await expect(removeAction).toBeVisible();
    const bounds = await removeAction.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const tableFrame = document
        .querySelector('[data-testid="marketplace-row-demo/third"]')
        ?.closest('table')
        ?.parentElement?.getBoundingClientRect();
      const hit = document.elementFromPoint(
        rect.left + rect.width / 2,
        (Math.max(rect.top, tableFrame?.bottom ?? rect.top) + rect.bottom) / 2,
      );
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        tableBottom: tableFrame?.bottom,
        unobscured: hit === element || element.contains(hit),
      };
    });
    expect(bounds.tableBottom).toBeDefined();
    expect(bounds.bottom).toBeGreaterThan(bounds.tableBottom);
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth);
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight);
    expect(bounds.unobscured).toBe(true);

    await removeAction.click();
    const confirmation = window.getByRole('dialog', {
      name: 'Remove plugin marketplace?',
    });
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toContainText('Third Market');
    await expect(
      confirmation.getByTestId('remove-marketplace-confirm-button'),
    ).toBeVisible();
    await confirmation.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirmation).not.toBeVisible();
    await expect(last).toBeVisible();
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});
