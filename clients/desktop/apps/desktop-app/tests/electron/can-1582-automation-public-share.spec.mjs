import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  seedAutomationTargetPipeline,
  seedAutomationTargetProjects,
} from './automationTargetFixtures.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { automationSharePath } from '../../../../packages/protocol/src/automations/index.ts';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedAutomations,
} from './seeders/index.mjs';

const AUTOMATION_ID = 'shareable-nightly-review';
const PUBLIC_SHARE_ID = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';
const SHARE_PATH = automationSharePath(PUBLIC_SHARE_ID);
const CLOUD_API_KEY = 'csk_brady_scoped_links_e2e';
// Sharing re-validates the automation's target (CAN-3734, #4704), so the
// fixture names a real seeded project and a stored pipeline that exists.
const PIPELINE_ID = 'nightly-code-review';
const ACTIVITIES = [
  {
    version: 1,
    id: AUTOMATION_ID,
    name: 'Nightly review pipeline',
    enabled: false,
    schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
    action: {
      type: 'worktree_pipeline',
      workspaceId: 'demo-ts-pnpm-vite',
      pipelineId: PIPELINE_ID,
      pipelineSource: 'user',
      pipelineName: 'Code Review',
      inputs: { branch: 'develop' },
    },
    createdAt: '2026-08-19T12:00:00.000Z',
    updatedAt: '2026-08-19T12:00:00.000Z',
    failureCount: 0,
  },
];

function emitOpenUrl(electronApp, url) {
  return electronApp.evaluate(({ app }, targetUrl) => {
    app.emit('open-url', { preventDefault: () => {} }, targetUrl);
  }, url);
}

test('publishes, copies, revokes, and republishes an automation public link', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'automation-public-share-'),
  );
  seedAutomationTargetProjects(userDataDir);
  seedAutomations({ userDataDir, activities: ACTIVITIES });
  seedAutomationTargetPipeline(userDataDir, PIPELINE_ID);
  await registerScenario(DEFAULT_MOCK_BASE_URL, CLOUD_API_KEY, {
    cloud: { automationWriteDelayMs: 500 },
  });
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const account = await window.evaluate(
      (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
      CLOUD_API_KEY,
    );
    expect(account.status).toMatchObject({ authenticated: true });
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });

    await app.openAutomationsPage();
    const row = app.workflowsLibraryAutomationRow(AUTOMATION_ID);
    await expect(row).toBeVisible();
    await app.chooseWorkflowsLibraryRowAction(row, 'share');

    // CAN-3135: publishing moved into the scope toggle. Public is a private
    // share plus a publish step, so the modal emits the link directly.
    const shareModal = window.getByTestId('share-automation-modal');
    await shareModal
      .getByTestId('share-automation-scope')
      .getByRole('radio', { name: 'Public' })
      .click();
    await shareModal.getByTestId('share-automation-submit').click();
    await expect(
      shareModal.getByTestId('share-automation-submit-spinner'),
    ).toBeVisible();
    await expect(
      shareModal.getByRole('button', { name: 'Cancel' }),
    ).toHaveCount(0);
    await expect(
      shareModal.getByRole('button', { name: 'Close', exact: true }),
    ).toBeDisabled();
    // The dialog stays open on its success notice with the public link and
    // Copy link; no share toast is raised.
    await expect(
      shareModal.getByTestId('share-automation-success'),
    ).toContainText('Automation is now public');
    await expect(shareModal.getByTestId('share-automation-link')).toHaveText(
      new RegExp(`${SHARE_PATH}$`),
    );
    await expect(
      window
        .getByTestId('toast-card')
        .filter({ hasText: 'Automation is now public' }),
    ).toHaveCount(0);
    const publishedLink = shareModal.getByTestId('share-automation-copy-link');
    await publishedLink.click();
    await expect(publishedLink).toContainText('Copied');
    await expect
      .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
      .toMatch(new RegExp(`${SHARE_PATH}$`));
    await shareModal.getByTestId('share-automation-done').click();
    await expect(shareModal).toHaveCount(0);

    const publicRemoteId = await window.evaluate(async (id) => {
      const { activities } = await window.api.automations.list();
      return activities.find((activity) => activity.id === id)?.remote
        ?.remoteId;
    }, AUTOMATION_ID);
    expect(publicRemoteId).toBeTruthy();
    await app.openSharedByMeAutomations();
    const sharedRow = window
      .getByTestId('customize-section-shared-by-me')
      .getByTestId(`customize-row-automation:shared:${publicRemoteId}`);
    await expect(sharedRow).toBeVisible();
    await expect(sharedRow).toHaveAccessibleDescription(/Public link/);
    await window
      .getByTestId('customize-section-shared-by-me')
      .getByTestId(`customize-row-source-automation:shared:${publicRemoteId}`)
      .hover();
    await expect(window.getByRole('tooltip')).toContainText('Public link');
    await window.mouse.move(0, 0);
    await app.openAutomationsPage();

    // A scoped share and its public snapshot are independent. Moving the
    // underlying share to an organization keeps the public link, and reopening
    // the dialog must preserve that canonical scope rather than selecting
    // Public and silently moving it back to private on the next submit.
    await app.chooseWorkflowsLibraryRowAction(row, 'share');
    const existingLink = shareModal.getByTestId('share-automation-copy-link');
    await expect(existingLink).toBeVisible();
    await existingLink.click();
    await expect(existingLink).toContainText('Copied');
    await expect
      .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
      .toMatch(new RegExp(`${SHARE_PATH}$`));
    await shareModal
      .getByTestId('share-automation-scope')
      .getByRole('radio', { name: 'Organization' })
      .click();
    await shareModal.getByRole('button', { name: 'Acme Release' }).click();
    await shareModal.getByTestId('share-automation-submit').click();
    await expect(
      shareModal.getByTestId('share-automation-success'),
    ).toContainText('Automation updated');
    await expect(
      window
        .getByTestId('toast-card')
        .filter({ hasText: 'Automation updated' }),
    ).toHaveCount(0);
    await shareModal.getByTestId('share-automation-done').click();
    await expect(shareModal).toHaveCount(0);

    await app.chooseWorkflowsLibraryRowAction(row, 'share');
    await expect(
      shareModal
        .getByTestId('share-automation-scope')
        .getByRole('radio', { name: 'Organization' }),
    ).toHaveAttribute('aria-checked', 'true');
    await shareModal
      .getByRole('button', { name: 'Close', exact: true })
      .click();

    // CAN-3135: copy/revoke/republish live on the shared-resource row, not
    // on the local automation's share dialog. CAN-3980 moved that row from
    // the retired Automations › Shared tab to the share's Marketplace detail,
    // reached through Automations › "Shared by me", which lists the share
    // beside its local source.
    const remoteId = await window.evaluate(async (id) => {
      const { activities } = await window.api.automations.list();
      return activities.find((activity) => activity.id === id)?.remote
        ?.remoteId;
    }, AUTOMATION_ID);
    expect(remoteId).toBeTruthy();
    await app.openSharedByMeAutomations();
    await expect(
      window
        .getByTestId('customize-section-installed')
        .getByTestId(`customize-row-automation:local:${AUTOMATION_ID}`),
    ).toBeVisible();
    await window
      .getByTestId('customize-section-shared-by-me')
      .getByTestId(`customize-row-automation:shared:${remoteId}`)
      .click();
    await expect(
      window.getByTestId('shared-automation-marketplace-detail'),
    ).toBeVisible();
    // Shared by you: the detail opens the source, and can also install an
    // independent copy.
    await expect(window.getByTestId('automation-source-open')).toHaveText(
      'Open in Workflows',
    );
    await expect(
      window.getByTestId('automation-catalog-install-another-copy'),
    ).toBeVisible();
    const shareRow = window.getByTestId('automation-public-share-row');
    await expect(shareRow).toBeVisible();
    // Moving away from Public revokes the old snapshot, so the shared row
    // offers a fresh publication for the newly scoped resource.
    await shareRow.getByTestId('automation-public-share-publish').click();
    await expect(shareRow).toContainText(SHARE_PATH);
    await shareRow.getByTestId('automation-public-share-copy').click();
    await shareRow.getByTestId('automation-public-share-revoke').click();
    await expect(
      shareRow.getByTestId('automation-public-share-publish'),
    ).toBeVisible();
    await expect(shareRow).not.toContainText(SHARE_PATH);
    await shareRow.getByTestId('automation-public-share-publish').click();
    await expect(shareRow).toContainText(SHARE_PATH);

    await emitOpenUrl(
      electronApp,
      `canopy://share/automations/${PUBLIC_SHARE_ID}`,
    );
    // CAN-3135 made a public automation link installable; CAN-3651 opens it
    // straight into the install review, whose one click installs it.
    const wizard = window.getByTestId('install-shared-automation-modal');
    await expect(wizard).toContainText('Nightly review pipeline');
    await expect(wizard.getByTestId('install-automation-submit')).toHaveText(
      'Install and enable',
    );
    await expect(window.getByTestId('deep-link-share-landing')).toHaveCount(0);
    // Dismissing the review closes the link without installing anything.
    await window.keyboard.press('Escape');
    await expect(wizard).toHaveCount(0);
    await expect(window.getByTestId('deep-link-share-landing')).toHaveCount(0);
  } finally {
    try {
      await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(DEFAULT_MOCK_BASE_URL, CLOUD_API_KEY).catch(
        () => undefined,
      );
    }
  }
});
