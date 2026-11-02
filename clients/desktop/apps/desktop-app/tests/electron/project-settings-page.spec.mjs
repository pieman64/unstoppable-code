// Project settings as a page shaped like Settings (design review
// 2026-10-22): a rail of pages beside the 640px column, changes that save as
// they are made, scripts and hooks on one page, and removing the project as
// the last row of General.
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  expectStoredProject,
  openProjectSettingsPage,
  projectSettingsNav,
  waitForProjectSettingsSaved,
} from './projectSettingsDriver.mjs';

const WORKSPACE_NAME = 'TypeScript pnpm Vite';
const WORKTREE_ID = 'demo-main';

async function openProjectSettings(window, app) {
  await app.workspaceHeaderLabel(WORKSPACE_NAME).hover();
  await app.workspaceSettingsButton(WORKSPACE_NAME).click();
  const page = window.getByRole('dialog', { name: WORKSPACE_NAME });
  await expect(page).toBeVisible();
  await expect(page.getByTestId('project-settings-page-general')).toBeVisible();
  return page;
}

async function launch(env = undefined) {
  const launched = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-pnpm-vite'],
    ...(env ? { env } : {}),
  });
  const window = await launched.electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.selectWorktree(WORKTREE_ID);
  return { ...launched, window, app };
}

test('project settings opens as a page and saves each change as it is made', async () => {
  const { electronApp, userDataDir, window, app } = await launch();
  try {
    let page = await openProjectSettings(window, app);

    // A rail of pages instead of tabs, with General first and no Danger tab.
    await expect(projectSettingsNav(app, 'general')).toHaveAttribute(
      'aria-current',
      'page',
    );
    for (const id of ['scripts', 'plans', 'plugins', 'environment']) {
      await expect(projectSettingsNav(app, id)).toBeVisible();
    }
    await expect(page.getByRole('tab')).toHaveCount(0);
    await expect(page.getByText('Danger', { exact: true })).toHaveCount(0);

    // No Save button: the line beside the title reports each save.
    const status = page.getByTestId('settings-save-status');
    await expect(status).toHaveText('Changes save automatically');
    await expect(page.getByRole('button', { name: /^Save/ })).toHaveCount(0);

    const alwaysShow = page.getByTestId('project-settings-always-show');
    await expect(alwaysShow).toHaveAttribute('aria-checked', 'true');
    await alwaysShow.click();
    await waitForProjectSettingsSaved(app);
    await expect(status).toContainText('Saved');
    await expectStoredProject(
      app,
      WORKSPACE_NAME,
      (project) => project?.alwaysShow === false,
    );

    // Escape closes the page; the change is there when it opens again.
    await window.keyboard.press('Escape');
    await expect(page).toHaveCount(0);
    page = await openProjectSettings(window, app);
    await expect(
      page.getByTestId('project-settings-always-show'),
    ).toHaveAttribute('aria-checked', 'false');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('scripts edit in place and a hook opens on its own page', async () => {
  const { electronApp, userDataDir, window, app } = await launch();
  try {
    let page = await openProjectSettings(window, app);
    await openProjectSettingsPage(app, 'scripts');

    // Source controlled and Local override tabs, each with its own save;
    // this page never claims it saves automatically.
    const scopeTabs = page.getByTestId('project-settings-scope');
    await expect(scopeTabs).toContainText('Source controlled');
    await expect(scopeTabs).toContainText('Local override');
    await expect(
      page.getByTestId('project-settings-scope-local'),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('settings-save-status')).toHaveCount(0);
    const saveLocal = page.getByTestId('project-settings-save-local');
    await expect(saveLocal).toBeDisabled();

    const setup = page.getByTestId('project-settings-script-setup');
    await expect(setup).toContainText('pnpm install');
    await expect(setup.locator('textarea')).toHaveCount(0);
    await page.getByTestId('project-settings-script-edit-setup').click();
    await setup.locator('textarea').fill('pnpm install --frozen-lockfile');
    // Nothing is written until Save local.
    await window.waitForTimeout(1_500);
    await expectStoredProject(
      app,
      WORKSPACE_NAME,
      (project) =>
        !JSON.stringify(project?.scripts ?? {}).includes('--frozen-lockfile'),
    );
    await saveLocal.click();
    await expectStoredProject(app, WORKSPACE_NAME, (project) =>
      JSON.stringify(project?.scripts ?? {}).includes('--frozen-lockfile'),
    );
    await page.getByTestId('project-settings-script-edit-setup').click();
    await expect(setup.locator('textarea')).toHaveCount(0);
    await expect(setup).toContainText('pnpm install --frozen-lockfile');

    // A new hook opens on its own page, and lands on the hook's page once
    // its first action is added.
    await page.getByTestId('project-settings-add-hook').click();
    await expect(page.getByRole('heading', { name: 'New hook' })).toBeVisible();
    const addForm = page.getByTestId('hook-add-form');
    await addForm.locator('textarea').first().fill('pnpm run lint:fix');
    await addForm.getByRole('button', { name: 'Add action' }).click();
    await expect(
      page.getByRole('heading', { name: 'PR Created' }),
    ).toBeVisible();
    await page.getByTestId('settings-page-back').click();
    await saveLocal.click();
    await expectStoredProject(app, WORKSPACE_NAME, (project) =>
      JSON.stringify(project?.hooks ?? {}).includes('pnpm run lint:fix'),
    );
    await expect(
      page.getByTestId('project-settings-hook-pr:create'),
    ).toContainText('Command · pnpm run lint:fix');

    await page.getByTestId('project-settings-back').click();
    await expect(page).toHaveCount(0);
    page = await openProjectSettings(window, app);
    await openProjectSettingsPage(app, 'scripts');
    await expect(
      page.getByTestId('project-settings-script-setup'),
    ).toContainText('pnpm install --frozen-lockfile');
    await expect(
      page.getByTestId('project-settings-hook-pr:create'),
    ).toContainText('pnpm run lint:fix');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('removing the project is the last row of General, behind a confirmation', async () => {
  const { electronApp, userDataDir, window, app } = await launch();
  try {
    const page = await openProjectSettings(window, app);
    const remove = page.getByTestId('project-settings-remove');
    await remove.scrollIntoViewIfNeeded();
    await remove.click();
    const confirm = window.getByTestId('project-settings-remove-dialog');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(`Remove ${WORKSPACE_NAME}?`);
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page).toBeVisible();
    await expect(app.workspaceHeaderLabel(WORKSPACE_NAME)).toHaveCount(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('plugin tables open as their own pages from the Plugins page', async () => {
  const { electronApp, userDataDir, window, app } = await launch();
  try {
    const page = await openProjectSettings(window, app);
    await openProjectSettingsPage(app, 'plugins');
    await expect(
      page.getByTestId('project-settings-recommended-plugins'),
    ).toBeVisible();
    await expect(page.getByPlaceholder('Search by name…')).toHaveCount(0);

    await page.getByTestId('project-settings-choose-chat-plugins').click();
    await expect(
      page.getByRole('heading', { name: 'Plugins for new chats' }),
    ).toBeVisible();
    await expect(page.getByPlaceholder('Search by name…')).toBeVisible();
    await page.getByTestId('settings-page-back').click();
    await expect(
      page.getByTestId('project-settings-page-plugins'),
    ).toContainText('Recommended for this project');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('the Start page saves a local override with Save local', async () => {
  const { electronApp, userDataDir, window, app } = await launch({
    CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
      'canopy-desktop-start-page': true,
    }),
  });
  try {
    const page = await openProjectSettings(window, app);
    await openProjectSettingsPage(app, 'start-page');
    const scopeTabs = page.getByTestId('project-settings-scope');
    await expect(scopeTabs).toContainText('Source controlled');
    await expect(scopeTabs).toContainText('Local override');
    await expect(page.getByTestId('settings-save-status')).toHaveCount(0);

    // canopy.json goes into a worktree.
    await page.getByTestId('project-settings-scope-source').click();
    await expect(
      page.getByRole('button', { name: 'Add to worktree', exact: true }),
    ).toBeVisible();

    // A choice for this computer waits for Save local.
    await page.getByTestId('project-settings-scope-local').click();
    const saveLocal = page.getByTestId('start-page-save-local');
    await expect(saveLocal).toHaveCSS('height', '28px');
    // The shared settings capsule rounds each end over its full half-height.
    await expect
      .poll(() =>
        saveLocal.evaluate((button) =>
          Number.parseFloat(getComputedStyle(button).borderTopLeftRadius),
        ),
      )
      .toBeGreaterThanOrEqual(14);
    await expect(saveLocal).toBeDisabled();
    await page.getByTestId('start-page-choice-trigger').click();
    await window.getByTestId('start-page-choice-chat').click();
    await expect(saveLocal).toBeEnabled();
    await expect(saveLocal).toHaveClass(/\brounded-full\b/);
    await expect(saveLocal).toHaveCSS('height', '28px');
    await saveLocal.click();
    await expectStoredProject(
      app,
      WORKSPACE_NAME,
      (project) => project?.startPage === null,
    );
    await expect(saveLocal).toBeDisabled();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
