import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedStoredPipeline } from './seeders/seedStoredPipeline.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// Workflows > Library lists pipelines in one table with search and capsule
// filters (CAN-3981; it replaced the Pipelines list table). This spec seeds two
// user pipelines with distinct names, descriptions, and trigger types, then
// drives the toolbar to confirm:
//   - both rows render in the `workflows-library-table`
//   - search matches against name AND description
//   - the Trigger filter narrows rows to a single trigger
//
// Testids exercised:
//   - `workflows-library-table`           -> the table wrapper
//   - `workflows-library-search`          -> search input
//   - `workflows-library-filter-trigger`  -> Trigger capsule; its menu rows are
//                                            `-option-<trigger>` and `-any`

const ZEPHYR = {
  id: 'zephyr-deploy',
  name: 'Zephyr Deploy Pipeline',
  description: 'Builds and ships the nightly artifact',
  yaml: [
    'name: Zephyr Deploy Pipeline',
    'description: Builds and ships the nightly artifact',
    'on: dispatch',
    'jobs:',
    '  main:',
    '    steps:',
    '      - run: echo zephyr',
    '',
  ].join('\n'),
};

const QUOKKA = {
  id: 'quokka-review',
  name: 'Quokka Review Pipeline',
  description: 'Reviews approved plans automatically',
  yaml: [
    'name: Quokka Review Pipeline',
    'description: Reviews approved plans automatically',
    'on: plan_ready',
    'jobs:',
    '  main:',
    '    steps:',
    '      - run: echo quokka',
    '',
  ].join('\n'),
};

test('pipelines table supports fuzzy search and trigger filtering', async ({}, testInfo) => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-pipeline-table-'),
  );
  for (const p of [ZEPHYR, QUOKKA]) {
    seedStoredPipeline({
      userDataDir,
      id: p.id,
      name: p.name,
      description: p.description,
      yaml: p.yaml,
    });
  }

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openPipelinesPage();

    const table = window.getByTestId('workflows-library-table');
    await expect(table).toBeVisible();

    const zephyrText = window.getByText('Zephyr Deploy Pipeline', {
      exact: true,
    });
    const quokkaText = window.getByText('Quokka Review Pipeline', {
      exact: true,
    });

    // Both seeded user pipelines render as rows in the table.
    await expect(zephyrText).toBeVisible();
    await expect(quokkaText).toBeVisible();

    const search = window.getByTestId('workflows-library-search');

    // (a) Fuzzy search by name narrows to a single row.
    await search.fill('zephyr');
    await expect(zephyrText).toBeVisible();
    await expect(quokkaText).toHaveCount(0);

    // (b) Fuzzy search by DESCRIPTION ("nightly" only appears in Zephyr's
    // description, not its name) still matches.
    await search.fill('nightly');
    await expect(zephyrText).toBeVisible();
    await expect(quokkaText).toHaveCount(0);

    await search.fill('');
    await expect(zephyrText).toBeVisible();
    await expect(quokkaText).toBeVisible();

    // (c) Trigger filter: Quokka is `plan_ready`, Zephyr is `dispatch`, so
    // filtering to Plan approved hides Zephyr.
    await window.getByTestId('workflows-library-filter-trigger').click();
    await window
      .getByTestId('workflows-library-filter-trigger-option-plan-approved')
      .click();
    await expect(quokkaText).toBeVisible();
    await expect(zephyrText).toHaveCount(0);

    await window.screenshot({
      path: testInfo.outputPath('pipelines-table-trigger-filter.png'),
    });

    // Reset the trigger filter; both rows return. The Trigger menu takes
    // several values, so it is still open.
    await window.getByTestId('workflows-library-filter-trigger-any').click();
    await expect(zephyrText).toBeVisible();
    await expect(quokkaText).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
