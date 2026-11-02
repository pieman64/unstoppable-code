import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  backFromWorkflowEdit,
  CanopyAppDriver,
  discardWorkflowEditIfOpen,
  saveWorkflowEdit,
} from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedAdvisorGroups } from './seeders/advisorItemGroupsFixture.mjs';
import { seedAutomations } from './seeders/seedAutomations.mjs';

const APP_ADVISOR_SCOPE = { appAdvisor: true };
const SIDEBAR_GROUP_TEST_ID = 'automations-form-sidebar-group';

function readPersistedActivity(userDataDir, activityId) {
  const file = JSON.parse(
    readFileSync(path.join(userDataDir, 'automations.json'), 'utf8'),
  );
  return file.activities.find((activity) => activity.id === activityId);
}

async function seedSidebarGroups(window) {
  const groups = await window.evaluate(async (scope) => {
    const entries = [
      { itemId: 'advisor-first', name: 'Release', color: 'categorical-2' },
      {
        itemId: 'advisor-second',
        name: 'Experiments',
        color: 'categorical-5',
      },
      { itemId: 'advisor-third', color: 'neutral' },
    ];
    for (const group of entries) {
      await window.api.sidebarItemGroups.create({ scope, ...group });
    }
    return window.api.sidebarItemGroups.list(scope);
  }, APP_ADVISOR_SCOPE);
  expect(groups.map((group) => group.name)).toEqual([
    'Release',
    'Experiments',
    'Group 1',
  ]);
}

test('automations form lists sidebar groups in left-nav order', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-automation-sidebar-group-order-'),
  );
  seedAdvisorGroups(userDataDir, { includeThird: true });
  seedAutomations({ userDataDir, activities: [] });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openAutomationsPage();
    // Created bottom row first, so stored order is the reverse of nav order.
    await window.evaluate(async (scope) => {
      for (const group of [
        { itemId: 'advisor-third', name: 'Third' },
        { itemId: 'advisor-second', name: 'Second' },
        { itemId: 'advisor-first', name: 'First' },
      ])
        await window.api.sidebarItemGroups.create({ scope, ...group });
    }, APP_ADVISOR_SCOPE);
    await app.startNewWorkflow('schedule');
    // A new workflow opens with no project; the sidebar group belongs to
    // App Advisor.
    await window
      .getByTestId('automations-form-action-type-app_advisor')
      .click();

    await window.getByTestId(SIDEBAR_GROUP_TEST_ID).click();
    await expect(
      window.getByRole('option').filter({ hasText: /^(First|Second|Third)$/ }),
    ).toHaveText(['First', 'Second', 'Third']);
    await window.keyboard.press('Escape');
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

test('automations form creates and reuses an App Advisor sidebar group', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-automation-sidebar-group-'),
  );
  seedAdvisorGroups(userDataDir, { includeThird: true });
  seedAutomations({ userDataDir, activities: [] });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openAutomationsPage();
    await seedSidebarGroups(window);
    await app.startNewWorkflow('schedule');
    // A new workflow opens with no project; choose App Advisor.
    await window
      .getByTestId('automations-form-action-type-app_advisor')
      .click();

    await window
      .getByTestId('automations-form-name')
      .fill('Nightly release review');
    await window
      .getByTestId('automations-form-prompt')
      .fill('Summarize release readiness.');
    await expect(
      window.getByTestId('automations-form-run-in-new_chat'),
    ).toHaveAttribute('aria-checked', 'true');

    const groupPicker = window.getByTestId(SIDEBAR_GROUP_TEST_ID);
    await expect(groupPicker).toBeVisible();
    await expect(groupPicker).toContainText('No group');
    await groupPicker.click();
    await expect(
      window.getByTestId(`${SIDEBAR_GROUP_TEST_ID}-option-empty`),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(
      window.getByRole('option', { name: 'Release', exact: true }),
    ).toBeVisible();
    await expect(
      window.getByRole('option', { name: 'Experiments', exact: true }),
    ).toBeVisible();

    const search = window.getByTestId(`${SIDEBAR_GROUP_TEST_ID}-search`);
    await search.fill('Nightly checks');
    const createOption = window.getByTestId(
      `${SIDEBAR_GROUP_TEST_ID}-option-create`,
    );
    await expect(createOption).toContainText('Create “Nightly checks”');
    await createOption.click();
    await expect(groupPicker).toContainText('Nightly checks');
    await expect(groupPicker).toContainText('New group');

    await saveWorkflowEdit(window);
    await backFromWorkflowEdit(window);
    await expect(window.getByTestId('workflow-edit-shell')).toBeHidden();
    // The Library lists pipelines in the same table; automation rows are
    // keyed `automation:<id>`.
    const activityRow = window.locator(
      '[data-testid="workflows-library-row"][data-row-kind="automation"]',
    );
    await expect(activityRow).toHaveCount(1);
    const activityId = (await activityRow.getAttribute('data-row-key')).replace(
      'automation:',
      '',
    );
    expect(activityId).not.toBe('');

    const createdActivity = readPersistedActivity(userDataDir, activityId);
    expect(createdActivity.action).toMatchObject({
      type: 'app_advisor_prompt',
      sidebarGroupName: 'Nightly checks',
      prompt: 'Summarize release readiness.',
    });
    expect(createdActivity.action.workEntryId).toBeUndefined();
    expect(createdActivity.action.existingWorktreeId).toBeUndefined();

    await app.openWorkflowsLibraryRow(activityRow);
    await expect(window.getByTestId('automations-form-body')).toBeVisible();
    const editGroupPicker = window.getByTestId(SIDEBAR_GROUP_TEST_ID);
    await expect(editGroupPicker).toContainText('Nightly checks');
    await expect(editGroupPicker).toContainText('New group');
    await editGroupPicker.click();
    const unmatchedOption = window.getByTestId(
      `${SIDEBAR_GROUP_TEST_ID}-option-unmatched`,
    );
    await expect(unmatchedOption).toContainText('Nightly checks');
    await expect(unmatchedOption).toContainText('New group');
    await window.getByRole('option', { name: 'Release', exact: true }).click();
    await expect(editGroupPicker).toContainText('Release');
    await expect(editGroupPicker).not.toContainText('New group');
    await saveWorkflowEdit(window);
    await backFromWorkflowEdit(window);

    const updatedActivity = readPersistedActivity(userDataDir, activityId);
    expect(updatedActivity.action.sidebarGroupName).toBe('Release');

    await app.openWorkflowsLibraryRow(activityRow);
    await expect(window.getByTestId('automations-form-body')).toBeVisible();
    await expect(window.getByTestId(SIDEBAR_GROUP_TEST_ID)).toBeVisible();
    await window.getByTestId('automations-form-run-in-existing_chat').click();
    await expect(
      window.getByTestId('automations-form-run-in-existing_chat'),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(window.getByTestId(SIDEBAR_GROUP_TEST_ID)).toBeHidden();
    await backFromWorkflowEdit(window, { discard: true });
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});
