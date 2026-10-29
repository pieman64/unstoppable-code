import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedStoredPipeline } from './seeders/seedStoredPipeline.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const PIPELINE_NAME = 'E2E Hidden Input Pipeline';
const PIPELINE_YAML = [
  `name: ${PIPELINE_NAME}`,
  'on:',
  '  dispatch:',
  '    inputs:',
  '      visible_target:',
  '        description: Shown to the operator',
  '        required: true',
  '      hidden_artifact:',
  '        description: Internal artifact path',
  '        required: false',
  '        default: artifact.json',
  '        hint-hide-ui-option: true',
  'jobs:',
  '  main:',
  '    steps:',
  '      - run: echo hi',
  '',
].join('\n');

const WATCHER_PIPELINE_NAME = 'E2E Watcher Notification Pipeline';
const WATCHER_PIPELINE_YAML = [
  `name: ${WATCHER_PIPELINE_NAME}`,
  'on: dispatch',
  'jobs:',
  '  main:',
  '    steps:',
  '      - run: echo watcher',
  '',
].join('\n');

test('dispatch trigger modal hides inputs marked with hint-hide-ui-option', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-hidden-inputs-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedStoredPipeline({
    userDataDir,
    id: 'hidden-inputs',
    name: PIPELINE_NAME,
    yaml: PIPELINE_YAML,
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();

    // The activity panel renders expanded inside the panel grid (no collapse
    // chrome); wait for its content to mount before using its sections.
    await expect(
      window.getByTestId('panel-content-activity-section'),
    ).toBeVisible();

    await app.openPipelineDispatchModal(PIPELINE_NAME);
    await window.getByTestId('pipeline-trigger-modal-run').click();

    const inputs = window.getByTestId('pipeline-trigger-modal-inputs');
    await expect(inputs).toBeVisible();
    await expect(window.locator('#trigger-input-visible_target')).toBeVisible();
    await expect(window.locator('#trigger-input-hidden_artifact')).toHaveCount(
      0,
    );
    await expect(inputs).toContainText('Shown to the operator');
    await expect(inputs).not.toContainText('Internal artifact path');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('dispatch trigger modal configures pipeline completion watcher notification', async ({}, testInfo) => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-pipeline-watcher-ui-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    tabs: [
      {
        id: 'pipeline-watch-destination',
        title: 'Pipeline watcher destination',
      },
    ],
  });
  seedStoredPipeline({
    userDataDir,
    id: 'watcher-notification',
    name: WATCHER_PIPELINE_NAME,
    yaml: WATCHER_PIPELINE_YAML,
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();

    // The activity panel renders expanded inside the panel grid (no collapse
    // chrome); wait for its content to mount before using its sections.
    await expect(
      window.getByTestId('panel-content-activity-section'),
    ).toBeVisible();

    await app.openPipelineDispatchModal(WATCHER_PIPELINE_NAME);

    const toggle = window.getByTestId('pipeline-trigger-modal-watcher-toggle');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    const recipient = window.getByTestId(
      'pipeline-trigger-modal-watcher-recipient-trigger',
    );
    await expect(recipient).toBeVisible();
    await expect(recipient).toContainText('Pipeline watcher destination');

    const followUp = window.getByTestId(
      'pipeline-trigger-modal-watcher-followup-trigger',
    );
    await expect(followUp).toBeVisible();
    await expect(followUp).toHaveAttribute('data-has-instruction', 'false');
    await followUp.click();

    const textarea = window.getByTestId(
      'pipeline-trigger-modal-watcher-followup-textarea',
    );
    await expect(textarea).toBeVisible();
    await textarea.fill('Summarize the pipeline result for the team.');
    await expect(followUp).toHaveAttribute('data-has-instruction', 'true');

    await window.screenshot({
      path: testInfo.outputPath('pipeline-watcher-notification-controls.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
