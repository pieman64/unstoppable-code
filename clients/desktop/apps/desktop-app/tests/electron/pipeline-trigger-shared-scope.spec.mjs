import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedStoredPipeline } from './seeders/seedStoredPipeline.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_BRANCH = 'demo-main';
const TEST_CLOUD_API_KEY = 'csk_pipeline_trigger_scope_e2e';

const LOCAL_PIPELINE_YAML = [
  'name: Local Dispatch Pipeline',
  'on: dispatch',
  'jobs:',
  '  dispatch:',
  '    steps:',
  '      - run: echo local',
  '',
].join('\n');

test('dispatch trigger modal scopes shared pipeline rows by trigger type', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-shared-pipeline-scope-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedStoredPipeline({
    userDataDir,
    id: 'local-dispatch',
    name: 'Local Dispatch Pipeline',
    yaml: LOCAL_PIPELINE_YAML,
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
    expect(saveResult.status.missingCapabilities).toEqual([]);
    expect(saveResult.account.hasApiKey).toBe(true);

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

    await expect(
      modalBody.getByRole('button', { name: 'Local Dispatch Pipeline' }),
    ).toBeVisible();
    await expect(
      modalBody.getByRole('button', { name: 'Shared Dispatch Pipeline' }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      modalBody.getByRole('button', { name: 'Shared Dual Trigger Pipeline' }),
    ).toBeVisible();
    await expect(
      modalBody.getByRole('button', { name: 'Shared Plan Only Pipeline' }),
    ).toHaveCount(0);

    await modalBody
      .getByRole('button', { name: 'Shared', exact: true })
      .click();
    await expect(
      modalBody.getByTestId('pipeline-trigger-modal-shared-selector'),
    ).toBeVisible();
    await expect(
      modalBody.getByRole('button', { name: 'Shared Dispatch Pipeline' }),
    ).toBeVisible();
    await expect(
      modalBody.getByRole('button', { name: 'Shared Dual Trigger Pipeline' }),
    ).toBeVisible();
    await expect(
      modalBody.getByRole('button', { name: 'Shared Plan Only Pipeline' }),
    ).toHaveCount(0);

    await modalBody
      .getByRole('button', { name: 'Shared Dispatch Pipeline' })
      .click();
    const continueButton = window.getByTestId('pipeline-trigger-modal-run');
    await expect(continueButton).toContainText('Continue');
    await continueButton.click();
    const readiness = window.getByTestId(
      'pipeline-trigger-modal-package-readiness',
    );
    await expect(readiness).toBeVisible();
    await expect(readiness).toContainText('canopy-e2e-shared-missing-cli');
    await expect(readiness).toContainText('Missing');
    await expect(continueButton).toBeDisabled();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
