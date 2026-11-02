// CAN-3354 durable coverage for the shared-pipeline consent boundary.
//
// Recipient: a pinned automation detects a publisher edit, records one failed
// run, enters Review needed, previews the current YAML, and only re-pins after
// an explicit Approve and run click.
// Publisher: a local pinned automation causes shared-pipeline Save to ask for
// confirmation; Cancel preserves the draft and Save sends the update.
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver, discardWorkflowEditIfOpen } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  registerScenario,
  seedAutomations,
} from './seeders/index.mjs';

const NOW = '2026-09-26T12:00:00.000Z';
const REMOTE_ID = 'shared-pin-review';
const ACTIVITY_ID = 'shared-pin-review-activity';
const OLD_HASH = 'a'.repeat(64);
const CURRENT_HASH = 'b'.repeat(64);

function rawPipeline(description = 'Updated by the publisher') {
  return [
    'name: Shared Pin Review',
    `description: ${description}`,
    'on: dispatch',
    'jobs:',
    '  review:',
    '    steps:',
    '      - id: finish',
    '        run: echo reviewed',
    '',
  ].join('\n');
}

function sharedPipeline() {
  return {
    id: REMOTE_ID,
    name: 'Shared Pin Review',
    description: 'Updated by the publisher',
    icon: '',
    version: '1',
    triggerTypes: ['dispatch'],
    scopes: ['directory'],
    contentHash: CURRENT_HASH,
    distributionMode: 'definition_only',
    rawPipeline: rawPipeline(),
    createdBy: { id: 'account-e2e', name: 'Publisher E2E' },
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
  };
}

function pinnedActivity(workspaceId = 'demo-ts-pnpm-vite') {
  return {
    version: 1,
    id: ACTIVITY_ID,
    name: 'Nightly shared review',
    enabled: true,
    schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
    action: {
      type: 'worktree_pipeline',
      workspaceId,
      pipelineId: `shared:canopy-cloud:${REMOTE_ID}`,
      pipelineName: 'Shared Pin Review',
      pipelineSource: 'shared',
      sharedPipeline: {
        serverId: 'canopy-cloud',
        remoteId: REMOTE_ID,
        installPin: {
          pipelineContentHash: OLD_HASH,
          distributionMode: 'definition_only',
        },
      },
    },
    createdAt: NOW,
    updatedAt: NOW,
    failureCount: 0,
  };
}

function persistedActivity(userDataDir) {
  const file = JSON.parse(
    readFileSync(path.join(userDataDir, 'automations.json'), 'utf8'),
  );
  return file.activities.find((activity) => activity.id === ACTIVITY_ID);
}

function persistedRuns(userDataDir) {
  const file = JSON.parse(
    readFileSync(path.join(userDataDir, 'automations.json'), 'utf8'),
  );
  return file.recentRuns.filter((run) => run.activityId === ACTIVITY_ID);
}

test('recipient reviews and approves a changed shared pipeline before it runs again', async () => {
  test.setTimeout(120_000);
  const key = 'csk_shared_pin_review_recipient';
  await registerScenario(DEFAULT_MOCK_BASE_URL, key, {
    cloud: { sharedPipelines: [sharedPipeline()] },
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-pin-review-recipient-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedAutomations({ userDataDir, activities: [pinnedActivity()] });
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, key);
    await app.openAutomationsPage();

    const row = app.workflowsLibraryAutomationRow(ACTIVITY_ID);
    const runNow = row.getByTestId('workflows-library-run');
    await runNow.click();
    const status = row.getByTestId('workflows-library-attention');
    await expect(status).toContainText('Review needed', { timeout: 15_000 });
    await expect
      .poll(
        () => persistedActivity(userDataDir)?.sharedPipelineReview?.remoteId,
      )
      .toBe(REMOTE_ID);

    // The Library row has no separate Review action: Run on an automation
    // that needs review opens the review instead of running it.
    await expect(runNow).toBeEnabled();
    await runNow.click();
    const modal = window.getByTestId('shared-pipeline-review-modal');
    await expect(modal).toBeVisible();
    const footerSeparator = modal.getByTestId(
      'shared-pipeline-review-footer-separator',
    );
    await expect(footerSeparator).toBeVisible();
    await expect
      .poll(async () => {
        return await footerSeparator.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            backgroundColor: style.backgroundColor,
            height: element.getBoundingClientRect().height,
          };
        });
      })
      .toMatchObject({
        backgroundColor: expect.not.stringMatching(
          /transparent|rgba\(0, 0, 0, 0\)/,
        ),
        height: expect.any(Number),
      });
    await expect(
      window.getByTestId('shared-pipeline-review-yaml'),
    ).toContainText('Updated by the publisher');
    const reviewed = await window.evaluate(async (remoteId) => {
      return await window.api.automations.resolveSharedPipelineInstallPin({
        remoteId,
      });
    }, REMOTE_ID);

    await window.getByTestId('shared-pipeline-review-approve-run').click();
    await expect(modal).toBeHidden({ timeout: 30_000 });
    // The attention line leaves the row with the review, so assert on the row.
    await expect(row).not.toContainText('Review needed');
    await expect
      .poll(
        () =>
          persistedActivity(userDataDir)?.action?.sharedPipeline?.installPin,
      )
      .toEqual(reviewed.installPin);
    expect(
      persistedActivity(userDataDir)?.sharedPipelineReview,
    ).toBeUndefined();
    await expect
      .poll(() => persistedRuns(userDataDir).length, { timeout: 15_000 })
      .toBe(2);
    expect(persistedRuns(userDataDir)[0]?.status).toBe('success');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, key);
  }
});

test('publisher confirms before saving a shared pipeline used by a pinned automation', async () => {
  test.setTimeout(120_000);
  const key = 'csk_shared_pin_review_publisher';
  await registerScenario(DEFAULT_MOCK_BASE_URL, key, {
    cloud: { sharedPipelines: [sharedPipeline()] },
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-pin-review-publisher-'),
  );
  seedAutomations({
    userDataDir,
    activities: [pinnedActivity('publisher-workspace')],
  });
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, key);
    await app.openPipelinesPage();
    await app.openWorkflowsLibraryRow(
      app.workflowsLibraryPipelineRow(REMOTE_ID, 'shared'),
    );

    // The shared pipeline opens editable in the Workflows edit shell.
    const shell = window.getByTestId('workflow-edit-shell');
    await expect(shell).toHaveAttribute('data-kind', 'pipeline');
    await expect(shell).toHaveAttribute('data-readonly', 'false');
    const definition = shell.getByTestId('workflow-edit-section-definition');
    await definition.getByTestId('pipeline-mode-raw').click();
    const textarea = definition.getByTestId('pipeline-raw-yaml-textarea');
    await textarea.fill(rawPipeline('Publisher draft'));
    await expect(shell).toHaveAttribute('data-dirty', 'true');
    const save = shell
      .getByTestId('workflow-edit-actions')
      .getByTestId('pipeline-save');
    await save.click();

    const dialog = window.getByTestId('shared-pipeline-save-impact-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(
      'People using this workflow in their automations will need to approve your changes before they run again.',
    );
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(
      (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, key)).activity
        .sharedPipelineDetachedUpdate,
    ).toBeUndefined();
    await expect(textarea).toHaveValue(/Publisher draft/);
    await expect(shell).toHaveAttribute('data-dirty', 'true');

    await save.click();
    await window.getByTestId('shared-pipeline-save-impact-confirm').click();
    await expect
      .poll(
        async () =>
          (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, key)).activity
            .sharedPipelineDetachedUpdate,
        { timeout: 15_000 },
      )
      .toBe(1);
    await expect(shell).toHaveAttribute('data-dirty', 'false', {
      timeout: 15_000,
    });
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, key);
  }
});
