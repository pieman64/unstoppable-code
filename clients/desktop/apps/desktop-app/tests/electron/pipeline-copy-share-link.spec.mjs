import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedStoredPipeline } from './seeders/seedStoredPipeline.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const TEST_CLOUD_API_KEY = 'csk_pipeline_trigger_scope_e2e';
// Workflows > Library keys a shared pipeline's row by its remote id.
const SHARED_PIPELINE_REMOTE_ID = 'shared-other-public';
const SHARE_PATH = '/portal/plugins/pipelines/shared/public-other-e2e';
const TEAM_PIPELINE_REMOTE_ID = 'shared-dual';
const PLAN_ONLY_TEAM_PIPELINE_REMOTE_ID = 'shared-plan-only';

/** Opens a Library row's More menu and returns its Copy share link item. */
async function openCopyLinkItem(window, row) {
  await row.getByTestId('workflows-library-menu').click();
  return window.getByTestId('workflows-library-menu-item-copy-link');
}

test('every shared pipeline row offers a share link action', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-pipeline-share-link-all-'),
  );
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    const saveResult = await window.evaluate(async (apiKey) => {
      return window.api.saveCanopyCloudApiKey({ apiKey });
    }, TEST_CLOUD_API_KEY);
    expect(saveResult.status.authenticated).toBe(true);

    await app.openPipelinesPage();
    await expect(window.getByTestId('workflows-library-table')).toBeVisible();

    // A team share has no public link, but members can open its lander.
    const teamRow = app.workflowsLibraryPipelineRow(
      TEAM_PIPELINE_REMOTE_ID,
      'shared',
    );
    await expect(teamRow).toBeVisible({ timeout: 15_000 });
    const teamLink = await openCopyLinkItem(window, teamRow);
    await expect(teamLink).toHaveText('Copy share link');
    await teamLink.click();
    await expect
      .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
      .toMatch(/\/portal\/plugins\/pipelines\/shared\/shared-dual$/);

    // Private is no longer a share audience, so every listed shared row is a
    // team, organization, or public share with a link to copy. A second team
    // share copies its own lander rather than offering to create one.
    const planOnlyLink = await openCopyLinkItem(
      window,
      app.workflowsLibraryPipelineRow(
        PLAN_ONLY_TEAM_PIPELINE_REMOTE_ID,
        'shared',
      ),
    );
    await expect(planOnlyLink).toHaveText('Copy share link');
    await planOnlyLink.click();
    await expect
      .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
      .toMatch(/\/portal\/plugins\/pipelines\/shared\/shared-plan-only$/);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('copies a non-owner pipeline public link from the list and read-only editor', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-pipeline-copy-link-'),
  );
  seedStoredPipeline({
    userDataDir,
    id: 'local-no-public-share',
    name: 'Local Pipeline Without Public Share',
    yaml: [
      'name: Local Pipeline Without Public Share',
      'on: dispatch',
      'jobs:',
      '  local:',
      '    steps:',
      '      - run: echo local',
      '',
    ].join('\n'),
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    const saveResult = await window.evaluate(async (apiKey) => {
      return window.api.saveCanopyCloudApiKey({ apiKey });
    }, TEST_CLOUD_API_KEY);
    expect(saveResult.status.authenticated).toBe(true);

    await app.openPipelinesPage();
    await expect(window.getByTestId('workflows-library-table')).toBeVisible();

    const sharedRow = app.workflowsLibraryPipelineRow(
      SHARED_PIPELINE_REMOTE_ID,
      'shared',
    );
    await expect(sharedRow).toBeVisible({ timeout: 15_000 });

    // A local pipeline with no public share has no link to copy.
    const localRow = app.workflowsLibraryPipelineRow('local-no-public-share');
    await localRow.getByTestId('workflows-library-menu').click();
    await expect(
      window.getByTestId('workflows-library-menu-item-edit'),
    ).toBeVisible();
    await expect(
      window.getByTestId('workflows-library-menu-item-copy-link'),
    ).toHaveCount(0);
    await window.keyboard.press('Escape');

    const copyFromList = await openCopyLinkItem(window, sharedRow);
    await copyFromList.click();
    await expect
      .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
      .toMatch(new RegExp(`${SHARE_PATH}$`));

    await app.openWorkflowsLibraryRow(sharedRow);
    const publicShareRow = window.getByTestId('pipeline-public-share-row');
    await expect(publicShareRow).toBeVisible();
    await expect(publicShareRow).toContainText(SHARE_PATH);
    await expect(
      publicShareRow.getByRole('button', { name: 'Copy link' }),
    ).toBeVisible();
    await expect(
      publicShareRow.getByRole('button', { name: 'Publish', exact: true }),
    ).toHaveCount(0);
    await expect(
      publicShareRow.getByRole('button', { name: 'Update to latest' }),
    ).toHaveCount(0);
    await expect(
      publicShareRow.getByRole('button', { name: 'Remove', exact: true }),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
