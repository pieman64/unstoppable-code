import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedPluginsCache } from './seeders/index.mjs';

// Offline production IPC/cache flow. Real GitHub updates and successful clones
// are deliberately covered by deterministic adapter/controller unit tests.
test('Marketplaces list, invalid recovery, source filters and legacy entry points', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-marketplace-sources-'),
  );
  const { cacheFilePath } = seedPluginsCache({ userDataDir });
  const cache = JSON.parse(readFileSync(cacheFilePath, 'utf8'));
  const source = cache.marketplaces[0];
  cache.marketplaces.push({
    ...source,
    id: 'invalid/source',
    name: 'Invalid source',
    plugins: [],
    pluginCount: 0,
    validProviders: [],
    providerStatus: {
      claude: {
        ...source.providerStatus.claude,
        state: 'invalid',
        error: 'Missing Claude manifest',
      },
      codex: {
        ...source.providerStatus.codex,
        state: 'invalid',
        error: 'Missing Codex manifest',
        structurallyInvalidAtRevision: 'seed',
      },
    },
  });
  writeFileSync(cacheFilePath, JSON.stringify(cache));
  const launch = await launchCanopy({ userDataDir });
  try {
    const page = await launch.electronApp.firstWindow();
    const app = new CanopyAppDriver(page);
    await app.waitForShell();
    await app.openPluginsPage();
    await page.getByTestId('plugins-type-tab-sources').click();
    await expect(page.getByTestId('plugins-search')).toHaveCount(0);
    const row = page
      .getByTestId('marketplace-source-row')
      .filter({ hasText: source.name });
    await expect(
      row.getByTestId('marketplace-source-missing-count'),
    ).toContainText('2');
    await row.getByTestId('marketplace-source-remove').click();
    await expect(
      page.getByTestId('marketplace-source-remove-dialog'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(row).toBeVisible();
    await row.getByTestId('marketplace-source-open').click();
    await expect(page.getByTestId('marketplace-source-detail')).toBeVisible();
    await expect(page.getByTestId('bulk-install-plugins')).toContainText(
      'Install 2 plugins',
    );
    await page.getByTestId('marketplace-source-search').fill('alpha');
    await expect(page.getByTestId('marketplace-source-plugin')).toHaveCount(1);
    await expect(
      page.getByTestId('marketplace-source-detail-missing-count'),
    ).toContainText('2');
    await expect(page.getByTestId('bulk-install-plugins')).toContainText(
      'Install 1 plugin',
    );
    await page.getByTestId('marketplace-source-breadcrumb-sources').click();
    const invalid = page
      .getByTestId('marketplace-source-row')
      .filter({ hasText: 'Invalid source' });
    await expect(
      invalid.getByTestId('marketplace-source-invalid'),
    ).toContainText('Missing Codex manifest');
    await invalid.getByTestId('marketplace-source-open').click();
    await expect(page.getByTestId('marketplace-source-invalid')).toContainText(
      'Missing Codex manifest',
    );
    await page.getByTestId('marketplace-source-breadcrumb-sources').click();
    await page.getByTestId('plugins-type-tab-all').click();
    await app.openPluginsTab('marketplace');
    await expect(
      page.getByTestId(`marketplace-row-${source.id}`),
    ).toBeVisible();
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});
