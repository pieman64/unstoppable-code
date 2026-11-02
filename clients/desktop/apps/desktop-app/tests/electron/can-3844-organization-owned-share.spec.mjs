import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { launchCanopy, closeCanopy } from './launchCanopy.mjs';
import { selectWorkspaceContext } from './workspaceContextMenu.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  registerShareMembership,
  ORG_CONTEXT_A,
  ORG_CONTEXT_ENV,
  ORG_CONTEXT_ORGANIZATIONS,
} from './seeders/index.mjs';
import {
  ORGANIZATION_SHARE_AUTOMATION_ID,
  ORGANIZATION_SHARE_TEAM,
  seedOrganizationShareAutomation,
  readOrganizationShareAutomation,
} from './fixtures/organization-owned-share.mjs';

test('CAN-3844: organization automation disables Public and updates between Organization and Team', async () => {
  test.setTimeout(180_000);
  const apiKey = 'csk_can3844_organization_share';
  await registerShareMembership(apiKey, {
    organizations: [ORG_CONTEXT_ORGANIZATIONS[0]],
    teams: [ORGANIZATION_SHARE_TEAM],
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can3844-share-'));
  let electronApp;
  try {
    seedOrganizationShareAutomation(userDataDir);
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: ORG_CONTEXT_ENV,
    }));
    const page = await electronApp.firstWindow();
    const app = new CanopyAppDriver(page);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(page, apiKey);
    await selectWorkspaceContext(page, ORG_CONTEXT_A);
    await app.openAutomationsPage();

    const dialog = page.getByTestId('share-automation-modal');
    const openShare = async () => {
      await app.chooseWorkflowsLibraryRowAction(
        app.workflowsLibraryAutomationRow(ORGANIZATION_SHARE_AUTOMATION_ID),
        'share',
      );
      await expect(dialog).toBeVisible();
      await dialog.getByTestId('share-automation-advanced-toggle').click();
      await expect(
        dialog.getByTestId('share-automation-preview'),
      ).toBeVisible();
    };
    const submit = async () => {
      await expect(dialog.getByTestId('share-automation-consent')).toHaveCount(
        0,
      );
      await expect(dialog.getByTestId('share-automation-submit')).toBeEnabled();
      await dialog.getByTestId('share-automation-submit').click();
      // A landed share keeps the dialog open on its success notice.
      await expect(dialog.getByTestId('share-automation-success')).toBeVisible({
        timeout: 30_000,
      });
      await dialog.getByTestId('share-automation-done').click();
      await expect(dialog).toHaveCount(0);
    };
    const assertLocked = async (owner) => {
      const publicOption = dialog.getByTestId('share-automation-scope-public');
      const hint = dialog.getByTestId('share-automation-public-locked-hint');
      await expect(publicOption).toBeVisible();
      await expect(publicOption).toBeDisabled();
      await expect(hint).toHaveText(
        "Organization shares can't be made public yet.",
      );
      await expect(publicOption).toHaveAttribute(
        'aria-describedby',
        await hint.getAttribute('id'),
      );
      await expect(
        dialog.getByTestId(`share-automation-scope-${owner}`),
      ).toHaveAttribute('aria-checked', 'true');
      await expect(
        dialog.getByTestId('share-automation-scope-team'),
      ).toBeEnabled();
      await expect(
        dialog.getByTestId('share-automation-scope-organization'),
      ).toBeEnabled();
      await expect(dialog).not.toContainText('Error invoking remote method');
    };

    // The real mock POST path retains the owner; scenario-seeded details do not.
    await openShare();
    await dialog.getByTestId('share-automation-scope-organization').click();
    await dialog
      .getByTestId(
        `share-automation-organization-picker-option-${ORG_CONTEXT_A}`,
      )
      .click();
    await submit();
    await expect
      .poll(async () => (await readOrganizationShareAutomation(page))?.owner)
      .toMatchObject({ type: 'organization', id: ORG_CONTEXT_A });

    await openShare();
    await assertLocked('organization');
    const organizationPicker = dialog.getByTestId(
      'share-automation-organization-picker',
    );
    const ownerRow = organizationPicker.getByTestId(
      `share-automation-organization-picker-option-${ORG_CONTEXT_A}`,
    );
    await organizationPicker.getByRole('searchbox').fill('no-matching-owner');
    await expect(ownerRow).toHaveCount(0);
    await organizationPicker.getByRole('searchbox').fill('');
    await expect(ownerRow).toHaveAttribute('aria-pressed', 'true');
    await dialog.getByTestId('share-automation-scope-team').click();
    await dialog
      .getByTestId(
        `share-automation-team-picker-option-${ORGANIZATION_SHARE_TEAM.id}`,
      )
      .click();
    await submit();
    await expect
      .poll(async () => (await readOrganizationShareAutomation(page))?.owner)
      .toMatchObject({
        type: 'team',
        id: ORGANIZATION_SHARE_TEAM.id,
        organization: { id: ORG_CONTEXT_A },
      });

    await openShare();
    await assertLocked('team');
    await dialog.getByTestId('share-automation-scope-organization').click();
    await dialog
      .getByTestId(
        `share-automation-organization-picker-option-${ORG_CONTEXT_A}`,
      )
      .click();
    await submit();
    await expect
      .poll(async () => (await readOrganizationShareAutomation(page))?.owner)
      .toMatchObject({ type: 'organization', id: ORG_CONTEXT_A });
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});
