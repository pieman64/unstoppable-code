import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedStoredPipeline } from './seeders/seedStoredPipeline.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// Workflows > Library on/off switch for a pipeline. Turning a pipeline off
// keeps it in the Library (so it can be turned on again) but removes it from
// every run picker. This spec proves the end-to-end contract for the dispatch
// picker:
//   1. seed two dispatch-capable user pipelines
//   2. in the Library, switch one OFF
//   3. the disabled pipeline is gone from the dispatch trigger modal, while
//      the still-enabled one remains
//
// Testids exercised:
//   - `workflows-library-toggle`       -> the per-row on/off switch
//   - `pipeline-dispatch-open`         -> opens the dispatch trigger modal
//   - `pipeline-trigger-modal-body`    -> the modal's pipeline list

const WORKTREE_BRANCH = 'demo-main';

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

test('disabling a pipeline removes it from the dispatch picker but keeps it listed', async ({}, testInfo) => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-pipeline-disable-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedStoredPipeline({
    userDataDir,
    id: 'keepme',
    name: 'Keepme Dispatch Pipeline',
    yaml: dispatchYaml('Keepme Dispatch Pipeline'),
  });
  seedStoredPipeline({
    userDataDir,
    id: 'hideme',
    name: 'Hideme Dispatch Pipeline',
    yaml: dispatchYaml('Hideme Dispatch Pipeline'),
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openPipelinesPage();
    await expect(window.getByTestId('workflows-library-table')).toBeVisible();

    const hideToggle = app
      .workflowsLibraryPipelineRow('hideme')
      .getByTestId('workflows-library-toggle');
    await expect(hideToggle).toBeVisible();
    // The Library toggle is a `role="switch"`, so `aria-checked` is the state
    // signal here (its accessible name also reads "... is on" / "... is off").
    // Enabled by default.
    await expect(hideToggle).toHaveAttribute('aria-checked', 'true');

    // Disable "Hideme".
    await hideToggle.click();
    await expect(hideToggle).toHaveAttribute('aria-checked', 'false');

    // It stays listed on the management table after being disabled.
    await expect(
      window.getByText('Hideme Dispatch Pipeline', { exact: true }),
    ).toBeVisible();

    await window.screenshot({
      path: testInfo.outputPath('pipeline-disabled-row.png'),
    });

    // Open the dispatch trigger modal for the worktree.
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();

    // The activity panel renders expanded inside the panel grid (no collapse
    // chrome); wait for its content to mount before using its sections.
    await expect(
      window.getByTestId('panel-content-activity-section'),
    ).toBeVisible();

    await window.getByTestId('pipeline-dispatch-open').click();
    const modalBody = window.getByTestId('pipeline-trigger-modal-body');
    await expect(modalBody).toBeVisible();

    // The enabled pipeline is offered; the disabled one is excluded.
    await expect(
      modalBody.getByRole('button', { name: 'Keepme Dispatch Pipeline' }),
    ).toBeVisible();
    await expect(
      modalBody.getByRole('button', { name: 'Hideme Dispatch Pipeline' }),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
