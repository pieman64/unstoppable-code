// Shared pipelines stay runnable after they are shared and edited.
//
// 1. A definition-only share (the ordinary share mode) must run from the Run
//    dialog. Main reports `invalid` package readiness for every non-package
//    share and `runPipeline` never gates them (CAN-3021); the dialog used to
//    probe readiness anyway and disabled Run with "Complete the required setup
//    above", which no setup could satisfy.
// 2. Saving an edit to a package share in the pipeline editor must keep it a
//    package share. The server detaches the package on any YAML update that
//    carries no new one, so the editor used to demote the share to
//    definition-only on every save. The shared mock cloud mirrors that server
//    behavior and records which kind of update arrived.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  registerScenario,
} from './seeders/index.mjs';

const WORKTREE_BRANCH = 'demo-main';
const NOW = '2026-09-24T12:00:00.000Z';

function sharedPipeline({ id, name, distributionMode }) {
  return {
    id,
    name,
    description: `${name} fixture`,
    icon: '',
    version: '1',
    triggerTypes: ['dispatch'],
    scopes: ['directory'],
    createdBy: { id: 'account-e2e', name: 'Portal E2E' },
    // Team-owned: shared lists hide user-owned rows without a public link,
    // since there is no Private audience to share to.
    shareScope: 'team',
    owner: {
      type: 'team',
      id: 'team-e2e',
      name: 'E2E Team',
      organization: {
        id: 'org-e2e',
        name: 'E2E Org',
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
    createdAt: NOW,
    updatedAt: NOW,
    canUpdate: true,
    canDelete: true,
    distributionMode,
    ...(distributionMode === 'package'
      ? {
          package: {
            digest: `pp:v1:${'D'.repeat(43)}`,
            version: 1,
            resources: [],
            environmentRequirements: [],
            totalFiles: 0,
            totalBytes: 0,
          },
        }
      : {}),
    rawPipeline: [
      `name: ${name}`,
      'on: dispatch',
      'jobs:',
      '  main:',
      '    steps:',
      '      - id: greet',
      '        run: echo hello',
      '',
    ].join('\n'),
  };
}

test('a definition-only shared pipeline can be run from the Run dialog', async () => {
  test.setTimeout(120_000);
  const key = 'csk_shared_definition_only_run';
  await registerScenario(DEFAULT_MOCK_BASE_URL, key, {
    cloud: {
      sharedPipelines: [
        sharedPipeline({
          id: 'shared-definition-only',
          name: 'Shared Definition Pipeline',
          distributionMode: 'definition_only',
        }),
      ],
    },
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-definition-run-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, key);

    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    await expect(
      window.getByTestId('panel-content-activity-section'),
    ).toBeVisible();

    await window.getByTestId('pipeline-dispatch-open').click();
    const modalBody = window.getByTestId('pipeline-trigger-modal-body');
    await expect(modalBody).toBeVisible();
    await modalBody
      .getByRole('button', { name: 'Shared', exact: true })
      .click();
    await modalBody
      .getByRole('button', { name: 'Shared Definition Pipeline' })
      .click();

    // With no package requirements to review, the dialog goes straight to a
    // runnable Run button instead of a blocked configure step.
    const runButton = window.getByTestId('pipeline-trigger-modal-run');
    await expect(runButton).toHaveText('Run');
    await expect(runButton).toBeEnabled();
    await expect(
      window.getByTestId('pipeline-trigger-modal-setup-blocking'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, key);
  }
});

test('saving an edit to a package share keeps its package', async () => {
  test.setTimeout(120_000);
  const key = 'csk_shared_package_edit_save';
  const remoteId = 'shared-package-edit';
  await registerScenario(DEFAULT_MOCK_BASE_URL, key, {
    cloud: {
      sharedPipelines: [
        sharedPipeline({
          id: remoteId,
          name: 'Shared Package Pipeline',
          distributionMode: 'package',
        }),
      ],
    },
  });
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, key);

    await app.openPipelinesPage();
    const editRow = app.workflowsLibraryPipelineRow(remoteId, 'shared');
    await expect(editRow).toBeVisible({ timeout: 15_000 });
    await app.openWorkflowsLibraryRow(editRow);

    await window.getByTestId('pipeline-mode-raw').click();
    const textarea = window.getByTestId('pipeline-raw-yaml-textarea');
    await expect(textarea).toHaveValue(/Shared Package Pipeline/);
    await textarea.fill(
      [
        'pipeline:',
        '  name: Shared Package Pipeline',
        '  description: Edited after sharing',
        '  on: dispatch',
        '  jobs:',
        '    main:',
        '      steps:',
        '        - id: greet',
        '          run: echo hello again',
      ].join('\n'),
    );
    const saveButton = window.getByTestId('pipeline-save');
    await expect(saveButton).toBeEnabled();
    await saveButton.click();
    // Save is also disabled while the save is in flight, so wait on the update
    // the mock cloud actually received rather than on the button.
    const readActivity = async () =>
      (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, key)).activity;
    await expect
      .poll(async () => (await readActivity()).sharedPipelinePackagedUpdate, {
        timeout: 15_000,
      })
      .toBe(1);
    expect((await readActivity()).sharedPipelineDetachedUpdate).toBeUndefined();
    await expect(saveButton).toBeDisabled();

    const detail = await window.evaluate(
      async (id) => window.pipelines.getShared({ remoteId: id }),
      remoteId,
    );
    expect(detail.success).toBe(true);
    expect(detail.data.distributionMode).toBe('package');
    expect(detail.data.rawPipeline).toContain('echo hello again');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, key);
  }
});
