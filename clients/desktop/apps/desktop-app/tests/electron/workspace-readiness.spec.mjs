import { expect, test } from '@playwright/test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWelcomeChecklist } from './seeders/seedWelcomeChecklist.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const WORKSPACE_NAME = 'TypeScript pnpm Vite';

test('AGENTS.md alone satisfies onboarding and missing guidance remains actionable', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'agents-readiness-'));
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const repoPath = seeded.workspaces[0].repoPath;
  rmSync(path.join(repoPath, 'CLAUDE.md'), { force: true });
  rmSync(path.join(repoPath, 'AGENTS.md'), { force: true });
  writeFileSync(
    path.join(repoPath, 'AGENTS.md'),
    '# Repository guidance\nUse npm test.\n',
  );
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openOverviewPage();
    const overview = window.getByTestId('workspace-readiness-overview');
    await expect(overview).toBeVisible();
    await overview.getByRole('button', { name: 'Refresh' }).click();
    await expect(
      overview
        .getByRole('button', { name: /Fix Add .+ in new worktree/ })
        .first(),
    ).toBeEnabled();
    await expect(overview).not.toContainText('Link agent instructions');
    await expect(overview).not.toContainText('Initialize agent instructions');

    rmSync(path.join(repoPath, 'AGENTS.md'));
    await overview.getByRole('button', { name: 'Refresh' }).click();
    await expect(
      overview.getByRole('button', {
        name: `Fix Initialize agent instructions in new worktree for ${WORKSPACE_NAME}`,
      }),
    ).toBeEnabled();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('unsupported AGENTS.md entries remain actionable in Overview', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'agents-invalid-'));
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const repoPath = seeded.workspaces[0].repoPath;
  const agentsPath = path.join(repoPath, 'AGENTS.md');
  rmSync(path.join(repoPath, 'CLAUDE.md'), { force: true });
  rmSync(agentsPath, { force: true });
  mkdirSync(agentsPath);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openOverviewPage();
    const overview = window.getByTestId('workspace-readiness-overview');
    await expect(overview).toBeVisible();
    await overview.getByRole('button', { name: 'Refresh' }).click();
    const repair = overview.getByRole('button', {
      name: `Fix Initialize agent instructions in new worktree for ${WORKSPACE_NAME}`,
    });
    await expect(repair).toBeEnabled();
    rmSync(agentsPath, { recursive: true });
    const outside = path.join(userDataDir, 'outside-guidance.md');
    writeFileSync(outside, 'Synthetic outside guidance.\n');
    symlinkSync(outside, agentsPath);
    await overview.getByRole('button', { name: 'Refresh' }).click();
    await expect(repair).toBeEnabled();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// #3519 retired the standalone Home readiness section: project readiness now
// surfaces as advanced Getting started rows once the basic checklist is done.
test('New Task presents project readiness fixes and keeps them while composing', async () => {
  const userDataDir = seedWelcomeChecklist();
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize: { width: 1400, height: 1000 },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    // Advanced rows wait for every basic step, including GitHub sign-in.
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('settings:github-cli-status');
      ipcMain.handle('settings:github-cli-status', () => ({
        authenticated: true,
        username: 'onboarding-fixture',
        error: null,
        tokenSource: 'gh',
        envOverride: false,
        envOverrideName: null,
        hasCredentialStoreLogin: true,
      }));
    });
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    await window.getByTestId('sidebar-create-task').click();
    const fix = window
      .getByTestId('page-home')
      .locator('[data-testid^="home-readiness-fix-"]')
      .first();
    await expect(fix).toBeVisible();
    await expect(fix).toContainText('· ts-pnpm-vite');
    await fix.focus();
    await expect(fix).toBeFocused();
    // Typing must not hide setup recommendations.
    const editor = window
      .getByTestId('page-home')
      .getByTestId('home-composer-editor');
    await editor.fill('Build something');
    await expect(fix).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('project readiness recommendations render in Overview and project settings', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-pnpm-vite'],
  });

  try {
    const window = await electronApp.firstWindow();
    await window.setViewportSize({ width: 1440, height: 1000 });
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    await app.openOverviewPage();
    const overview = window.getByTestId('workspace-readiness-overview');
    await expect(overview).toBeVisible();
    await expect(overview).toContainText(WORKSPACE_NAME);
    await expect(
      overview.getByRole('table', {
        name: 'Project readiness recommendations',
      }),
    ).toBeVisible();
    await expect(
      overview
        .getByRole('button', {
          name: /^Fix .+ in new worktree for TypeScript pnpm Vite$/,
        })
        .first(),
    ).toBeEnabled();

    const sectionGeometry = await window.evaluate(() => {
      const readiness = document.querySelector(
        '[data-testid="workspace-readiness-overview"]',
      );
      const unread = document.querySelector('[data-testid="overview-unread"]');
      const unreadPipelines = document.querySelector(
        '[data-testid="overview-unread-pipelines"]',
      );
      if (
        !(readiness instanceof HTMLElement) ||
        !(unread instanceof HTMLElement) ||
        !(unreadPipelines instanceof HTMLElement)
      ) {
        return null;
      }
      return {
        readiness: readiness.getBoundingClientRect().width,
        unread: unread.getBoundingClientRect().width,
        readinessTop: readiness.getBoundingClientRect().top,
        unreadPipelinesTop: unreadPipelines.getBoundingClientRect().top,
      };
    });
    expect(sectionGeometry).not.toBeNull();
    expect(
      Math.abs(sectionGeometry.readiness - sectionGeometry.unread),
    ).toBeLessThan(2);
    expect(
      Math.abs(
        sectionGeometry.readinessTop - sectionGeometry.unreadPipelinesTop,
      ),
    ).toBeLessThan(2);

    await window.setViewportSize({ width: 700, height: 1000 });
    const narrowGeometry = await window.evaluate(() => {
      const readiness = document.querySelector(
        '[data-testid="workspace-readiness-overview"]',
      );
      const unread = document.querySelector('[data-testid="overview-unread"]');
      if (
        !(readiness instanceof HTMLElement) ||
        !(unread instanceof HTMLElement)
      ) {
        return null;
      }
      return {
        readinessTop: readiness.getBoundingClientRect().top,
        unreadTop: unread.getBoundingClientRect().top,
      };
    });
    expect(narrowGeometry).not.toBeNull();
    expect(narrowGeometry.readinessTop).toBeLessThan(narrowGeometry.unreadTop);
    await window.setViewportSize({ width: 1440, height: 1000 });

    await overview.getByRole('button', { name: 'Refresh' }).click();
    await expect(
      overview
        .getByRole('button', {
          name: /^Fix .+ in new worktree for TypeScript pnpm Vite$/,
        })
        .first(),
    ).toBeEnabled();

    await app.openMainPage();
    const sidebar = window.getByTestId('app-sidebar');
    await sidebar
      .getByRole('button', { name: `Collapse ${WORKSPACE_NAME}` })
      .hover();
    await sidebar
      .locator(`button[aria-label="Settings for ${WORKSPACE_NAME}"]:visible`)
      .click();

    const dialog = window.getByRole('dialog', { name: WORKSPACE_NAME });
    await expect(dialog).toBeVisible();
    const recommendations = dialog.getByTestId(
      'workspace-readiness-recommendations',
    );
    await expect(recommendations).toBeVisible();
    await expect(recommendations).toContainText('Repository readiness');
    await expect(
      recommendations
        .getByRole('button', { name: 'Fix in new worktree' })
        .first(),
    ).toBeEnabled();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('failed readiness masks the project name while keeping recovery readable', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-pnpm-vite'],
  });
  try {
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('workspace:read-readiness');
      ipcMain.handle('workspace:read-readiness', () => {
        throw new Error('Seeded readiness failure');
      });
    });
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openOverviewPage();
    const message = window
      .getByTestId('workspace-readiness-overview')
      .getByText(`Couldn’t check ${WORKSPACE_NAME}.`, { exact: true });
    await expect(message).toBeVisible();
    await expect(message.locator('.ph-mask')).toHaveText(WORKSPACE_NAME);
    await expect(message).not.toHaveClass(/ph-mask/);
    await expect(
      window.getByRole('button', {
        name: `Retry readiness check for ${WORKSPACE_NAME}`,
        exact: true,
      }),
    ).toBeEnabled();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('recovery evidence stays visible without Fix actions or onboarding steps', async () => {
  test.setTimeout(120_000);
  const { seedRecoveryReadiness, installRecoveryReadiness } =
    await import('./seeders/seedRecoveryReadiness.mjs');
  const { userDataDir, issues } = seedRecoveryReadiness();
  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize: { width: 1440, height: 1000 },
  });
  try {
    await installRecoveryReadiness(electronApp, issues);
    const window = await electronApp.firstWindow();
    await window.reload();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openOverviewPage();
    const overview = window.getByTestId('workspace-readiness-overview');
    const recoveries = overview
      .getByRole('row')
      .filter({ hasText: 'Recover interrupted worktree creation' });
    await expect(recoveries).toHaveCount(2);
    for (const name of ['alpha', 'beta']) {
      const row = recoveries.filter({ hasText: `recovery/${name}` });
      await expect(row).toBeVisible();
      await expect(row.getByRole('button', { name: /Fix/ })).toHaveCount(0);
    }
    await app.openMainPage();
    const sidebar = window.getByTestId('app-sidebar');
    await sidebar
      .getByRole('button', { name: `Collapse ${WORKSPACE_NAME}` })
      .hover();
    await sidebar
      .locator(`button[aria-label="Settings for ${WORKSPACE_NAME}"]:visible`)
      .click();
    const dialog = window.getByRole('dialog', { name: WORKSPACE_NAME });
    const recommendations = dialog.getByTestId(
      'workspace-readiness-recommendations',
    );
    for (const name of ['alpha', 'beta']) {
      const description = recommendations.getByText(
        issues.find(
          (issue) => issue.recovery?.branchName === `recovery/${name}`,
        ).message,
        { exact: true },
      );
      await expect(description).toBeVisible();
      await expect(
        description
          .locator('..')
          .locator('..')
          .getByRole('button', { name: /Fix/ }),
      ).toHaveCount(0);
    }
    await window.keyboard.press('Escape');
    await window.getByTestId('sidebar-create-task').click();
    const home = window.getByTestId('page-home');
    await expect(
      home
        .locator('[data-testid^="home-readiness-fix-"]')
        .filter({ hasText: 'Add repository hooks' }),
    ).toBeVisible();
    await expect(
      home.getByText('Recover interrupted worktree creation', { exact: true }),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
