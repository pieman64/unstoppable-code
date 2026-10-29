import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedStoredPipeline } from './seeders/seedStoredPipeline.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// Row-level Share in Workflows > Library. Sharing used to require drilling
// into a pipeline and using the editor toolbar; the table offers the same flow
// from each row's More menu (CAN-3981). A list row only carries
// `PipelineInfo`, so the page fetches the full definition on demand before
// mounting `SharePipelineModal` — this spec proves that round trip.
//
// Walk: Library -> the Custom row's More menu -> Share -> the disconnected
// cloud gate appears -> connect -> Share opens the real Share Pipeline dialog
// for that row's pipeline.
//
// Testids exercised:
//   - `workflows-library-table`     -> the Library table
//   - `workflows-library-toggle`    -> per-row on/off switch
//   - `workflows-library-menu`      -> per-row More menu; its items are
//                                      `workflows-library-menu-item-<action>`
//                                      (edit, duplicate, share, delete)
//   - `cloud-sync-modal`            -> disconnected sign-in gate
//   - `share-pipeline-modal`        -> Share Pipeline dialog
//   - `share-pipeline-scope`        -> connected scope radiogroup

const PIPELINE_ID = 'rowshare';
const PIPELINE_NAME = 'Rowshare Dispatch Pipeline';

function dispatchYaml(name) {
  return [
    `name: ${name}`,
    'on: dispatch',
    'jobs:',
    '  main:',
    '    steps:',
    '      - run: echo hi',
    '',
  ].join('\n');
}

test('a Custom pipeline row shares without opening the editor', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-pipeline-row-share-'),
  );
  seedStoredPipeline({
    userDataDir,
    id: PIPELINE_ID,
    name: PIPELINE_NAME,
    yaml: dispatchYaml(PIPELINE_NAME),
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openPipelinesPage();
    await expect(window.getByTestId('workflows-library-table')).toBeVisible();

    const row = app.workflowsLibraryPipelineRow(PIPELINE_ID);
    await expect(row).toBeVisible();

    // The switch sits on the row; the other actions are in its More menu.
    await expect(row.getByTestId('workflows-library-toggle')).toBeVisible();
    const rowMenu = row.getByTestId('workflows-library-menu');
    await rowMenu.click();
    await expect(
      window.getByTestId('workflows-library-menu-item-edit'),
    ).toBeVisible();
    await expect(
      window.getByTestId('workflows-library-menu-item-delete'),
    ).toBeVisible();
    // Custom rows are already local, so there is nothing to duplicate from.
    await expect(
      window.getByTestId('workflows-library-menu-item-duplicate'),
    ).toHaveCount(0);

    const shareAction = window.getByTestId('workflows-library-menu-item-share');
    await expect(shareAction).toBeVisible();
    await expect(shareAction).toHaveText('Share…');

    // Disconnected: the share gate intercepts before any definition is loaded.
    await shareAction.click();
    const cloudSyncModal = window.getByTestId('cloud-sync-modal');
    await expect(cloudSyncModal).toBeVisible();
    await expect(window.getByTestId('share-pipeline-modal')).toHaveCount(0);
    await cloudSyncModal.getByRole('button', { name: 'Close' }).click();
    await expect(cloudSyncModal).toHaveCount(0);

    const saveResult = await window.evaluate(
      async (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
      'csk_brady_scoped_links_e2e',
    );
    expect(
      saveResult.status,
      saveResult.status.error ?? 'Pipeline sharing account did not connect',
    ).toMatchObject({ authenticated: true });
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });

    // Connected: the row loads its own definition and opens the real dialog,
    // without ever navigating into the editor.
    await rowMenu.click();
    await shareAction.click();
    const shareModal = window.getByTestId('share-pipeline-modal');
    await expect(shareModal).toBeVisible();
    await expect(window.getByTestId('share-pipeline-scope')).toBeVisible();
    const dependencyReview = window.getByTestId('share-pipeline-dependencies');
    await expect(dependencyReview).toBeVisible();
    await expect(dependencyReview).not.toContainText('Analyzing dependencies', {
      timeout: 15_000,
    });
    // Still on the list, not the editor.
    await expect(window.getByTestId('workflows-library-table')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
