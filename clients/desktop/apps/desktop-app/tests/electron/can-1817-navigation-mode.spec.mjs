import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { writeJson } from './seeders/index.mjs';

// CAN-1817 — Code vs Work navigation mode regression coverage.
//
// The saved `navigationMode` preference decides how much repository detail
// project and task setup shows:
//   - Work mode hides the New Task branch/worktree picker. Add project shows
//     the same options in both modes (CAN-3909 removed Work mode's folded
//     Clone option).
//   - Code mode keeps every repository control visible.
//   - The role submitted through the Home onboarding role tiles seeds the
//     mode (engineering → Code, anything else → Work) and it survives a
//     restart; Settings → General overrides it later.
//
// Deterministic: fresh user-data dirs seeded with the baseline `ts-pnpm-vite`
// demo workspace (or a fresh-onboarding profile), no live agents, no network.

const DEMO_APP_ID = 'ts-pnpm-vite';
const WORKSPACE_ID = 'demo-ts-pnpm-vite';

function seedNavigationMode(userDataDir, navigationMode) {
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: { navigationMode },
  });
}

async function openHomeForDemoWorkspace(window) {
  await window.getByTestId('sidebar-create-task').click();
  const homePage = window.getByTestId('page-home');
  await expect(homePage).toBeVisible();
  await homePage.getByTestId('home-workspace-select').click();
  await window.getByTestId(`home-workspace-option-${WORKSPACE_ID}`).click();
  await expect(homePage.getByTestId('home-surface')).toHaveAttribute(
    'data-workspace-selected',
    'true',
  );
  return homePage;
}

async function openAddWorkspaceModal(window, app) {
  await app.openMainPage();
  await window.getByTestId('sidebar-section-code-toggle').hover();
  await window.getByTestId('sidebar-section-code-add').click();
  const modal = window.getByTestId('add-workspace-modal');
  await expect(modal).toBeVisible();
  return modal;
}

async function closeAddWorkspaceModal(window) {
  await window.keyboard.press('Escape');
  await expect(window.getByTestId('add-workspace-modal')).toBeHidden();
}

async function openNavigationModeSettings(app, window) {
  await app.openSettings();
  await app.openSettingsSection('canopy');
  const section = window.getByTestId('settings-navigation-mode');
  await expect(section).toBeVisible();
  return section;
}

test.describe('CAN-1817 navigation mode', () => {
  test('Work mode hides repository controls until Settings switches back to Code', async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-can1817-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: [DEMO_APP_ID] });
    seedNavigationMode(userDataDir, 'work');

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      // Work mode: the New Task composer targets the code workspace but
      // never shows the branch/worktree picker.
      let homePage = await openHomeForDemoWorkspace(window);
      await expect(homePage.getByTestId('home-branch-picker')).toHaveCount(0);
      await expect(
        homePage.getByTestId('home-base-branch-separator'),
      ).toHaveCount(0);
      // Hidden, not removed: the plain-language chip says where the task
      // will run and reveals the developer picker one step away.
      const seeMorePicker = homePage.getByTestId('home-branch-picker-see-more');
      await expect(seeMorePicker).toBeVisible();
      await expect(seeMorePicker).toHaveText(/New branch from main/);
      await seeMorePicker.click();
      await expect(homePage.getByTestId('home-branch-picker')).toBeVisible();
      await expect(seeMorePicker).toHaveCount(0);

      // Work mode: Add project shows the same three options as Code mode and
      // opens on Clone (CAN-3909). Only an organization's Create new default
      // type differs.
      let modal = await openAddWorkspaceModal(window, app);
      await expect(
        modal.getByTestId('add-workspace-mode-existing'),
      ).toBeVisible();
      await expect(
        modal.getByTestId('add-workspace-mode-create'),
      ).toBeVisible();
      await expect(
        modal.getByTestId('add-workspace-mode-remote'),
      ).toHaveAttribute('aria-pressed', 'true');
      await expect(
        modal.getByTestId('add-workspace-remote-panel'),
      ).toBeVisible();
      await expect(modal.getByTestId('add-workspace-see-more')).toHaveCount(0);
      await closeAddWorkspaceModal(window);

      // Settings → General shows the persisted mode and lets the user
      // override it.
      let section = await openNavigationModeSettings(app, window);
      await expect(
        section.getByTestId('settings-navigation-mode-work'),
      ).toHaveAttribute('aria-pressed', 'true');
      // The selected segment sits on one raised surface that slides between
      // the segments, outlined with a ring (box-shadow), not a border color
      // utility, because `border-*` colors are inert under the global
      // border-color rule (CAN-2734). Confirm the paint, not the class name.
      const work = section.getByTestId('settings-navigation-mode-work');
      const surface = work.locator(
        'xpath=ancestor::*[@role="group"][1]/span[@aria-hidden="true"]',
      );
      expect(
        await surface.evaluate((el) => getComputedStyle(el).boxShadow),
      ).not.toBe('none');
      await expect
        .poll(async () => {
          const [under, segment] = await Promise.all([
            surface.boundingBox(),
            work.boundingBox(),
          ]);
          return Math.abs(under.x - segment.x);
        })
        .toBeLessThan(1);
      await section.getByTestId('settings-navigation-mode-code').click();
      await expect(
        section.getByTestId('settings-navigation-mode-code'),
      ).toHaveAttribute('aria-pressed', 'true');
      await app.closeSettings();

      // Code mode applies immediately, without a reload.
      homePage = await openHomeForDemoWorkspace(window);
      await expect(homePage.getByTestId('home-branch-picker')).toBeVisible();

      // Pick an existing worktree as the target while the picker is visible.
      await homePage.getByTestId('home-branch-picker-button').click();
      await window.getByTestId('home-branch-picker-worktree-demo-main').click();
      await expect(homePage.getByTestId('home-surface')).toHaveAttribute(
        'data-target-kind',
        'worktree',
      );

      // Switching back to Work hides the picker AND resets the hidden target,
      // so the next send goes to a new worktree rather than an invisible
      // destination. Return to Home without reselecting the workspace, which
      // would reset the target on its own.
      section = await openNavigationModeSettings(app, window);
      await section.getByTestId('settings-navigation-mode-work').click();
      await expect(
        section.getByTestId('settings-navigation-mode-work'),
      ).toHaveAttribute('aria-pressed', 'true');
      await app.closeSettings();
      await window.getByTestId('sidebar-create-task').click();
      await expect(homePage.getByTestId('home-branch-picker')).toHaveCount(0);
      await expect(homePage.getByTestId('home-surface')).toHaveAttribute(
        'data-target-kind',
        'new-worktree',
      );

      // Back to Code for the remaining assertions.
      section = await openNavigationModeSettings(app, window);
      await section.getByTestId('settings-navigation-mode-code').click();
      await app.closeSettings();
      homePage = await openHomeForDemoWorkspace(window);
      await expect(homePage.getByTestId('home-branch-picker')).toBeVisible();

      modal = await openAddWorkspaceModal(window, app);
      await expect(
        modal.getByTestId('add-workspace-mode-remote'),
      ).toHaveAttribute('aria-pressed', 'true');
      await expect(modal.getByTestId('add-workspace-see-more')).toHaveCount(0);
      await closeAddWorkspaceModal(window);

      // Reopening Settings re-reads persisted preferences, so a surviving
      // value proves the save reached the main process.
      section = await openNavigationModeSettings(app, window);
      await expect(
        section.getByTestId('settings-navigation-mode-code'),
      ).toHaveAttribute('aria-pressed', 'true');
      await app.closeSettings();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('a non-engineering onboarding role seeds Work mode and survives a restart', async () => {
    test.setTimeout(240_000);

    const first = await launchCanopy({ freshOnboarding: true });
    const { userDataDir } = first;
    let electronApp = first.electronApp;
    try {
      let window = await electronApp.firstWindow();
      let app = new CanopyAppDriver(window);
      await app.acceptLegalConsent();
      await app.waitForShell();
      await app.skipFirstRunImport();
      await expect(window.getByTestId('page-home')).toBeVisible({
        timeout: 15_000,
      });

      // Fresh profile with no role recorded: Code is the default.
      let section = await openNavigationModeSettings(app, window);
      await expect(
        section.getByTestId('settings-navigation-mode-code'),
      ).toHaveAttribute('aria-pressed', 'true');
      await app.closeSettings();

      // The first non-engineering category picked on the Getting Started
      // tools step flips the initial mode to Work. AI providers and repo
      // setup come first, so skip them to reach the category row.
      // Home is active, so step the queue with the Home card's arrows (the
      // sidebar card is not mounted alongside it).
      for (const entry of ['agent-connections', 'add-repo']) {
        await expect(app.homeChecklistRow(entry)).toBeVisible({
          timeout: 30_000,
        });
        await app.homeChecklistForward(entry).click();
      }
      const designer = window.getByTestId('home-onboarding-category-designer');
      await expect(designer).toBeVisible({ timeout: 30_000 });
      await designer.focus();
      await window.keyboard.press('Enter');
      await expect(designer).toHaveAttribute('aria-pressed', 'true');

      section = await openNavigationModeSettings(app, window);
      await expect(
        section.getByTestId('settings-navigation-mode-work'),
      ).toHaveAttribute('aria-pressed', 'true');
      await app.closeSettings();

      // Restart on the same data dir: the role-derived mode is persisted.
      await closeCanopy(electronApp, userDataDir, { keepUserData: true });
      electronApp = (await launchCanopy({ userDataDir, freshOnboarding: true }))
        .electronApp;
      window = await electronApp.firstWindow();
      app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      section = await openNavigationModeSettings(app, window);
      await expect(
        section.getByTestId('settings-navigation-mode-work'),
      ).toHaveAttribute('aria-pressed', 'true');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
