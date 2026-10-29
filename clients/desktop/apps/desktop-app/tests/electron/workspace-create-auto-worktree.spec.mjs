import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

async function openCreateWorkspaceForm(window) {
  // The add-workspace entry point is the sidebar Workspaces section "+" (the
  // Home surface's standalone CTA was removed; the workspace-add onboarding
  // anchor moved here too).
  // The add button is hover-revealed; the keyboard path avoids pointer flake.
  await window.getByTestId('sidebar-section-code-add').focus();
  await window.getByTestId('sidebar-section-code-add').press('Enter');
  await expect(
    window.getByRole('heading', { name: 'Add project' }),
  ).toBeVisible();
  await window.getByRole('button', { name: 'Create new' }).click();
}

async function createWorkspace(window, name, options = {}) {
  const { multiRepo = false } = options;

  await openCreateWorkspaceForm(window);
  if (multiRepo) {
    await window.getByTestId('add-workspace-type-multi-repo').click();
  }
  await window.getByLabel('Project name').fill(name);
  await window.getByRole('button', { name: 'Create project' }).click();
}

test.describe('project creation defaults', () => {
  test('single-repo project creation lands in the New Task composer without creating a worktree', async () => {
    test.setTimeout(180_000);

    const { electronApp, userDataDir } = await launchCanopy();

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell();
      await app.openMainPage();

      await expect(window.getByTestId('home-surface')).toBeVisible({
        timeout: 15_000,
      });

      await createWorkspace(window, 'Auto Worktree Single');

      // Creation lands on the New Task page with the composer aimed at the
      // new workspace — describing a task is the next step, so no worktree or
      // chat panel is created up front. (`:visible` scoping: MainPage stays
      // mounted behind `className="hidden"` with the same testids.)
      const homeSurface = window.locator(
        '[data-testid="home-surface"]:visible',
      );
      await expect(homeSurface).toBeVisible({ timeout: 15_000 });
      await expect(window.getByTestId('overview-page')).toHaveCount(0);
      await expect(homeSurface).toContainText('Auto Worktree Single');
      await expect(
        window.locator('[data-testid="home-composer-editor"]:visible'),
      ).toBeFocused({ timeout: 15_000 });
      await expect(window.getByTestId('worktree-row')).toHaveCount(0);
      await expect(window.getByTestId('panel-content-chat')).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('multi-repo draft creation opens repository settings without creating a worktree', async () => {
    test.setTimeout(120_000);

    const { electronApp, userDataDir } = await launchCanopy();

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell();
      await app.openMainPage();

      await expect(window.getByTestId('home-surface')).toBeVisible({
        timeout: 15_000,
      });

      await createWorkspace(window, 'Auto Worktree Multi', { multiRepo: true });

      await expect(
        window.getByRole('heading', { name: 'Auto Worktree Multi' }),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        window.getByRole('heading', { name: 'Repositories' }),
      ).toBeVisible();
      await expect(window.getByTestId('worktree-row')).toHaveCount(0);
      await expect(window.getByTestId('panel-content-chat')).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
