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
        name: `Try again for ${WORKSPACE_NAME}`,
        exact: true,
      }),
    ).toBeEnabled();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

/** Advanced Home rows wait for every basic step, including GitHub sign-in. */
async function installGitHubSignedIn(electronApp) {
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
}

/** Records fix sends without running an agent. */
async function installSendRecorder(electronApp) {
  await electronApp.evaluate(({ ipcMain }) => {
    globalThis.__readinessSends = 0;
    ipcMain.removeHandler('chat:send-message');
    ipcMain.handle('chat:send-message', () => {
      globalThis.__readinessSends += 1;
      return {};
    });
  });
}

function readinessSends(electronApp) {
  return electronApp.evaluate(() => globalThis.__readinessSends);
}

async function worktreeCount(window) {
  return window.evaluate(async () => {
    const file = await window.api.loadProjects();
    return file.items.reduce(
      (total, item) =>
        total + (item.type === 'cowork' ? 0 : item.worktrees.length),
      0,
    );
  });
}

// CAN-5500: launching a Home fix navigates away before the send settles, and
// the audit reads the reference checkout while the fix lives in its worktree.
// Home must link the launched chat instead of offering another full run.
test('a launched readiness fix stays linked from Home across reload and relaunch', async () => {
  test.setTimeout(300_000);
  const userDataDir = seedWelcomeChecklist();
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const repoPath = seeded.workspaces[0].repoPath;
  rmSync(path.join(repoPath, 'CLAUDE.md'), { force: true });
  rmSync(path.join(repoPath, 'AGENTS.md'), { force: true });
  const launchOptions = {
    userDataDir,
    viewportSize: { width: 1400, height: 1000 },
  };
  const instructionsFix =
    '[data-testid="home-readiness-fix-configure-agent-instructions"]';
  const instructionsLink =
    '[data-testid="home-readiness-launched-configure-agent-instructions"]';

  let sends = 0;
  let initialWorktrees = 0;
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy(launchOptions));
    let window = await electronApp.firstWindow();
    let app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await installGitHubSignedIn(electronApp);
    await installSendRecorder(electronApp);
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    initialWorktrees = await worktreeCount(window);

    await window.getByTestId('sidebar-create-task').click();
    let home = window.getByTestId('page-home');
    await expect(home.locator(instructionsFix)).toBeEnabled();
    const otherFixIds = await home
      .locator('[data-testid^="home-readiness-fix-"]')
      .evaluateAll((rows) =>
        rows
          .map((row) => row.getAttribute('data-testid'))
          .filter(
            (id) => id !== 'home-readiness-fix-configure-agent-instructions',
          ),
      );
    expect(otherFixIds.length).toBeGreaterThan(0);
    await home.locator(instructionsFix).click();
    await expect.poll(() => readinessSends(electronApp)).toBe(1);
    await expect.poll(() => worktreeCount(window)).toBe(initialWorktrees + 1);
    const destination = await window.evaluate(() => {
      const saved = JSON.parse(
        localStorage.getItem('canopy.workspaceReadiness.launchedFixes.v1'),
      );
      return saved.records.find(
        (record) => record.issueCode === 'configure-agent-instructions',
      );
    });
    expect(destination?.worktreeId).toBeTruthy();
    expect(destination?.chatId).toBeTruthy();

    const expectLinkedHome = async () => {
      await window.getByTestId('sidebar-create-task').click();
      home = window.getByTestId('page-home');
      const link = home.locator(instructionsLink);
      await expect(link).toBeVisible();
      await expect(link).toContainText('Agent instructions');
      await expect(link).toContainText('Open chat');
      await expect(home.locator(instructionsFix)).toHaveCount(0);
      for (const id of otherFixIds) {
        await expect(home.getByTestId(id)).toBeEnabled();
      }
      return link;
    };

    let link = await expectLinkedHome();
    // The stub accepts the send but main never starts the turn, so the chat
    // keeps its pending turn: active work, never a claimed success.
    await expect(link).toHaveAttribute('data-status', 'in-progress');
    await expect(link).toContainText('in progress on');

    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    link = await expectLinkedHome();

    sends += await readinessSends(electronApp);
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = undefined;

    ({ electronApp } = await launchCanopy(launchOptions));
    window = await electronApp.firstWindow();
    app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await installGitHubSignedIn(electronApp);
    await installSendRecorder(electronApp);
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    link = await expectLinkedHome();

    await link.click();
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();
    await expect(
      window.getByTestId(`panel-tab-panel-chat-${destination.chatId}`),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(
      window.locator(
        `[data-sidebar-selected-item] [data-testid="worktree-row"][data-project-id="${destination.workspaceId}"][data-worktree-id="${destination.worktreeId}"]`,
      ),
    ).toBeVisible();
    expect(await worktreeCount(window)).toBe(initialWorktrees + 1);
    sends += await readinessSends(electronApp);
    expect(sends).toBe(1);

    // Resolving the issue at the audited checkout retires the link too.
    writeFileSync(
      path.join(repoPath, 'AGENTS.md'),
      '# Repository guidance\nUse npm test.\n',
    );
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    await window.getByTestId('sidebar-create-task').click();
    home = window.getByTestId('page-home');
    await expect(
      home.locator('[data-testid^="home-readiness-fix-"]').first(),
    ).toBeVisible();
    await expect(home.locator(instructionsFix)).toHaveCount(0);
    await expect(home.locator(instructionsLink)).toHaveCount(0);
    for (const id of otherFixIds) {
      await expect(home.getByTestId(id)).toBeEnabled();
    }
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    else rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('missing readiness conversations explain recovery in Overview and settings', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-pnpm-vite'],
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await installSendRecorder(electronApp);
    const destination = await window.evaluate(async () => {
      const file = await window.api.loadProjects();
      const workspace = file.items.find((item) => item.type !== 'cowork');
      const worktree = workspace.worktrees[0];
      const audit = await window.api.getWorkspaceReadiness({
        workspaceId: workspace.id,
      });
      const issue = audit.issues.find((entry) => entry.fixPrompt !== null);
      const record = {
        workspaceId: workspace.id,
        issueKey: `${issue.repoId ?? issue.repoName}:${issue.code}`,
        issueCode: issue.code,
        worktreeId: worktree.id,
        chatId: 'missing-readiness-chat',
        launchedAt: new Date().toISOString(),
      };
      localStorage.setItem(
        'canopy.workspaceReadiness.launchedFixes.v1',
        JSON.stringify({
          version: 1,
          records: [record],
        }),
      );
      return { ...record, title: issue.title };
    });
    const initialWorktrees = await worktreeCount(window);
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    const worktreeRow = window.locator(
      `[data-testid="worktree-row"][data-project-id="${destination.workspaceId}"][data-worktree-id="${destination.worktreeId}"]`,
    );
    await worktreeRow.click();
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();
    await app.openOverviewPage();
    const row = window
      .getByTestId('workspace-readiness-overview')
      .getByRole('row')
      .filter({ hasText: destination.title });
    await expect(row).toContainText('Conversation unavailable');
    await row.getByRole('button', { name: /^Open worktree for/ }).click();
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();
    await expect(
      window.locator(
        `[data-sidebar-selected-item] [data-testid="worktree-row"][data-project-id="${destination.workspaceId}"][data-worktree-id="${destination.worktreeId}"]`,
      ),
    ).toBeVisible();

    const sidebar = window.getByTestId('app-sidebar');
    await sidebar
      .getByRole('button', { name: `Collapse ${WORKSPACE_NAME}` })
      .hover();
    await sidebar
      .locator(`button[aria-label="Settings for ${WORKSPACE_NAME}"]:visible`)
      .click();
    const recommendations = window
      .getByRole('dialog', { name: WORKSPACE_NAME })
      .getByTestId('workspace-readiness-recommendations');
    await expect(recommendations).toContainText('Conversation unavailable');
    await recommendations
      .getByRole('button', { name: 'Open worktree', exact: true })
      .click();
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();
    expect(await worktreeCount(window)).toBe(initialWorktrees);
    expect(await readinessSends(electronApp)).toBe(0);
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
