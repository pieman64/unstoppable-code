import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWelcomeChecklist } from './seeders/seedWelcomeChecklist.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  registerScenario,
} from './seeders/index.mjs';

// Settings must preserve the full multi-select role answer from Getting
// Started. The editor stages changes until Save, then writes both the full
// list and its canonical primary role through real preferences IPC.

/** Skips AI providers and repo setup to the tools step's category row. */
async function openCategoryRow(window) {
  // Home is active here, so the sidebar card is not mounted: step the queue
  // with the Home card's own forward arrows.
  const app = new CanopyAppDriver(window);
  for (const entry of ['agent-connections', 'add-repo']) {
    await expect(app.homeChecklistRow(entry)).toBeVisible();
    await app.homeChecklistForward(entry).click();
  }
  await expect(window.getByTestId('home-onboarding-categorys')).toBeVisible();
}

test('clearing every saved role reopens the tools step that asks for them without resetting other progress', async () => {
  const apiKey = 'csk_clear_onboarding_roles_e2e';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {});
  const launch = await launchCanopy({
    userDataDir: seedWelcomeChecklist({ exhausted: true }),
  });
  try {
    const window = await launch.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await connectMockCloudAccount(window, apiKey);
    await window.getByTestId('sidebar-create-task').click();
    const before = await window.evaluate(() => window.api.loadPreferences());
    await app.openSettings();
    await app.openSettingsSection('canopy');
    await window.getByTestId('settings-profile-role-edit').click();
    await window
      .getByTestId('settings-profile-role-option-software-engineer')
      .click();
    const save = window.getByTestId('settings-profile-role-save');
    await expect(save).toBeEnabled();
    await save.click();
    await expect(window.getByTestId('settings-profile-role-modal')).toHaveCount(
      0,
    );
    await expect(
      window.locator('[data-testid^="settings-profile-role-tile-"]'),
    ).toHaveCount(0);
    const after = await window.evaluate(() => window.api.loadPreferences());
    expect(after.profileRole).toBeUndefined();
    expect(after.profileRoles).toEqual([]);
    const preservedEntries = { ...before.homeOnboardingSuggestions.entries };
    delete preservedEntries.github;
    expect(after.homeOnboardingSuggestions.entries).toEqual(preservedEntries);
    expect(after.globalPluginSelections).toEqual(before.globalPluginSelections);
    await expect
      .poll(
        async () =>
          (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey)).activity[
            'onboardingProfileRoles:'
          ] ?? 0,
      )
      .toBeGreaterThan(0);
    await app.closeSettings();
    await expect(window.getByTestId('home-onboarding-categorys')).toBeVisible();
    await expect(app.homeChecklistRow('github')).toBeVisible();
    await window.reload();
    await app.waitForShell();
    await window.getByTestId('sidebar-create-task').click();
    await expect(window.getByTestId('home-onboarding-categorys')).toBeVisible();
    expect(
      (await window.evaluate(() => window.api.loadPreferences())).profileRoles,
    ).toEqual([]);
    // A pick saves at once; the step stays so more can be picked.
    await window.getByTestId('home-onboarding-category-marketing').click();
    await expect(
      window.getByTestId('home-onboarding-category-marketing'),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect
      .poll(
        async () =>
          (await window.evaluate(() => window.api.loadPreferences()))
            .profileRoles,
      )
      .toEqual(['marketing']);
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('Marketing and Sales can be selected together and edited independently', async () => {
  const apiKey = 'csk_marketing_sales_roles_e2e';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {});
  const launch = await launchCanopy({
    userDataDir: seedWelcomeChecklist({ fresh: true }),
    freshOnboardingChecklist: true,
  });
  try {
    const window = await launch.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await connectMockCloudAccount(window, apiKey);
    await window.getByTestId('sidebar-create-task').click();
    await openCategoryRow(window);
    await expect(
      window.getByTestId('home-onboarding-category-marketing-sales'),
    ).toHaveCount(0);
    await window.getByTestId('home-onboarding-category-marketing').click();
    // Sales is not one of the five categories on the tools step; Settings
    // adds it alongside Marketing.
    await app.openSettings();
    await app.openSettingsSection('canopy');
    await window.getByTestId('settings-profile-role-edit').click();
    await window.getByTestId('settings-profile-role-option-sales').click();
    await window.getByTestId('settings-profile-role-save').click();
    await expect(window.getByTestId('settings-profile-role-modal')).toHaveCount(
      0,
    );
    await app.closeSettings();
    await expect
      .poll(
        async () =>
          (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey)).activity[
            'onboardingProfileRoles:marketing,sales'
          ] ?? 0,
      )
      .toBe(1);
    await expect(
      window.getByTestId('home-onboarding-suggestion-add-repo'),
    ).toHaveCount(0);
    await app.openSettings();
    await app.openSettingsSection('canopy');
    await expect(
      window.getByTestId('settings-profile-role-tile-marketing'),
    ).toBeVisible();
    await expect(
      window.getByTestId('settings-profile-role-tile-sales'),
    ).toBeVisible();
    await window.getByTestId('settings-profile-role-edit').click();
    await window.getByTestId('settings-profile-role-option-marketing').click();
    await window.getByTestId('settings-profile-role-save').click();
    await expect(window.getByTestId('settings-profile-role-modal')).toHaveCount(
      0,
    );
    expect(
      (await window.evaluate(() => window.api.loadPreferences())).profileRoles,
    ).toEqual(['sales']);
    await expect
      .poll(
        async () =>
          (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey)).activity[
            'onboardingProfileRoles:sales'
          ] ?? 0,
      )
      .toBe(1);
    await app.closeSettings();
    await app.openSettings();
    await app.openSettingsSection('canopy');
    await expect(
      window.getByTestId('settings-profile-role-tile-marketing'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('settings-profile-role-tile-sales'),
    ).toBeVisible();
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('an existing combined answer becomes two saved tiles and does not return after editing', async () => {
  const userDataDir = seedWelcomeChecklist();
  const prefsPath = path.join(userDataDir, 'preferences.json');
  const data = JSON.parse(readFileSync(prefsPath, 'utf8'));
  data.preferences.profileRole = 'marketing-sales';
  data.preferences.profileRoles = ['marketing-sales'];
  writeJson(prefsPath, data);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('canopy');
    await expect(
      window.getByTestId('settings-profile-role-tile-marketing'),
    ).toBeVisible();
    await expect(
      window.getByTestId('settings-profile-role-tile-sales'),
    ).toBeVisible();
    await window.getByTestId('settings-profile-role-edit').click();
    await window.getByTestId('settings-profile-role-option-sales').click();
    await window.getByTestId('settings-profile-role-save').click();
    await expect(window.getByTestId('settings-profile-role-modal')).toHaveCount(
      0,
    );
    await window.reload();
    await app.waitForShell();
    expect(
      (await window.evaluate(() => window.api.loadPreferences())).profileRoles,
    ).toEqual(['marketing']);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Settings shows all saved roles and edits them in a modal', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-can2336-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.openSettings();
    await app.openSettingsSection('canopy');

    const section = window.getByTestId('settings-profile-role');
    const edit = window.getByTestId('settings-profile-role-edit');
    await expect(
      section.locator('[data-testid^="settings-profile-role-tile-"]'),
    ).toHaveCount(0);
    await expect(edit).toBeEnabled();

    await edit.click();
    const modal = window.getByTestId('settings-profile-role-modal');
    await expect(modal).toBeVisible();
    await modal.getByTestId('settings-profile-role-option-designer').click();
    await modal.getByTestId('settings-profile-role-option-founder').click();
    await modal.getByTestId('settings-profile-role-cancel').click();
    await expect(
      section.locator('[data-testid^="settings-profile-role-tile-"]'),
    ).toHaveCount(0);

    await edit.click();
    await modal.getByTestId('settings-profile-role-option-designer').click();
    await modal.getByTestId('settings-profile-role-option-founder').click();
    await modal.getByTestId('settings-profile-role-save').click();
    await expect(modal).toHaveCount(0);
    await expect(
      window.getByTestId('settings-profile-role-tile-designer'),
    ).toBeVisible();
    await expect(
      window.getByTestId('settings-profile-role-tile-founder'),
    ).toBeVisible();

    await app.closeSettings();
    await app.openSettings();
    await app.openSettingsSection('canopy');
    await expect(
      window.getByTestId('settings-profile-role-tile-designer'),
    ).toBeVisible();
    await expect(
      window.getByTestId('settings-profile-role-tile-founder'),
    ).toBeVisible();

    await edit.click();
    await expect(
      modal.getByTestId('settings-profile-role-option-designer'),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      modal.getByTestId('settings-profile-role-option-founder'),
    ).toHaveAttribute('aria-pressed', 'true');
    await modal.getByTestId('settings-profile-role-option-other').click();
    await modal
      .getByTestId('settings-profile-role-detail-input')
      .fill('Technical writer');
    await modal.getByTestId('settings-profile-role-save').click();
    await expect(modal).toHaveCount(0);
    await expect(
      window.getByTestId('settings-profile-role-tile-other'),
    ).toBeVisible();
    await expect(window.getByTestId('settings-profile-role-detail')).toHaveText(
      'Technical writer',
    );

    await app.closeSettings();
    await app.openSettings();
    await app.openSettingsSection('canopy');
    await expect(
      window.getByTestId('settings-profile-role-tile-other'),
    ).toBeVisible();
    await expect(window.getByTestId('settings-profile-role-detail')).toHaveText(
      'Technical writer',
    );
    expect(
      (await window.evaluate(() => window.api.loadPreferences())).profileRoles,
    ).toEqual(['designer', 'founder', 'other']);

    await edit.click();
    await modal.getByTestId('settings-profile-role-option-other').click();
    await modal.getByTestId('settings-profile-role-save').click();
    await expect(modal).toHaveCount(0);
    await expect(
      window.getByTestId('settings-profile-role-tile-other'),
    ).toHaveCount(0);
    expect(
      (await window.evaluate(() => window.api.loadPreferences()))
        .profileRoleDetail,
    ).toBe('Technical writer');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('editing one role keeps the others and updates the live Home queue', async () => {
  const launch = await launchCanopy({
    userDataDir: seedWelcomeChecklist({ fresh: true }),
    freshOnboardingChecklist: true,
  });
  try {
    const window = await launch.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.getByTestId('sidebar-create-task').click();
    await openCategoryRow(window);
    await window
      .getByTestId('home-onboarding-category-software-engineer')
      .click();
    await window.getByTestId('home-onboarding-category-designer').click();
    await expect
      .poll(
        async () =>
          (await window.evaluate(() => window.api.loadPreferences()))
            .profileRoles,
      )
      .toEqual(['software-engineer', 'designer']);

    await app.openSettings();
    await app.openSettingsSection('canopy');
    await expect(
      window.getByTestId('settings-profile-role-tile-software-engineer'),
    ).toBeVisible();
    await expect(
      window.getByTestId('settings-profile-role-tile-designer'),
    ).toBeVisible();
    await window.getByTestId('settings-profile-role-edit').click();
    const modal = window.getByTestId('settings-profile-role-modal');
    await modal
      .getByTestId('settings-profile-role-option-software-engineer')
      .click();
    await modal.getByTestId('settings-profile-role-save').click();
    await expect(modal).toHaveCount(0);
    await app.closeSettings();
    // The tools step stays for a nontechnical role (it carries the category
    // row), that row reflects the edit, and the steps already resolved
    // before it stay resolved.
    const tools = window.getByTestId('home-onboarding-suggestion-github');
    await expect(tools).toBeVisible();
    await expect(
      tools.getByTestId('home-onboarding-category-designer'),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      tools.getByTestId('home-onboarding-category-software-engineer'),
    ).toHaveAttribute('aria-pressed', 'false');
    await expect(
      window.getByTestId('home-onboarding-suggestion-add-repo'),
    ).toHaveCount(0);
    expect(
      (await window.evaluate(() => window.api.loadPreferences())).profileRoles,
    ).toEqual(['designer']);

    await app.openSettings();
    await app.openSettingsSection('canopy');
    await window.getByTestId('settings-profile-role-edit').click();
    await modal
      .getByTestId('settings-profile-role-option-software-engineer')
      .click();
    await modal.getByTestId('settings-profile-role-save').click();
    await expect(modal).toHaveCount(0);
    await app.closeSettings();
    // Re-adding the technical role shows on the same row at once.
    await expect(
      tools.getByTestId('home-onboarding-category-software-engineer'),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      tools.getByTestId('home-onboarding-category-designer'),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(
      (await window.evaluate(() => window.api.loadPreferences())).profileRoles,
    ).toEqual(['designer', 'software-engineer']);
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});
