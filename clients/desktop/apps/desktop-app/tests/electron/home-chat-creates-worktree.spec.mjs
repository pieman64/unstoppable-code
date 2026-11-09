import { mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

// Golden: a Chat-mode send from the standalone Home page creates a worktree,
// navigates to Code, and the message reaches the transcript.

const DEMO_APP_ID = 'ts-pnpm-vite';

async function waitForHomeWorkspaceSelection(homePage) {
  await expect(homePage.getByTestId('home-surface')).toHaveAttribute(
    'data-workspace-selected',
    'true',
  );
}

test.describe('Home chat send', () => {
  test('an unborn source preserves the draft before any worktree or chat and recovers after a first commit', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-home-unborn-'),
    );
    const summary = seedDemoWorkspaces({
      userDataDir,
      apps: [DEMO_APP_ID],
      createWorktrees: false,
    });
    const repoPath = summary.workspaces[0].repoPath;
    const git = (args) =>
      execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
    // Keep staged files but remove the first commit, like a fresh git init.
    git(['update-ref', '-d', 'HEAD']);
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
      await window.getByTestId('sidebar-create-task').click();
      const home = window.getByTestId('page-home');
      await waitForHomeWorkspaceSelection(home);
      const picker = home.getByTestId('home-branch-picker-button');
      await expect(picker).toHaveAttribute('data-source-no-commits', 'true');
      const prompt = 'Investigate the failing health-check endpoint.';
      await home.getByTestId('home-composer-editor').fill(prompt);
      await home.getByTestId('home-send-button').click();
      await window.keyboard.press('Enter');
      await expect(home.getByTestId('home-composer-error')).toContainText(
        'has no commits yet. Create a first commit on this branch, then send again.',
      );
      await expect(home.getByTestId('home-composer-editor')).toContainText(
        prompt,
      );
      await expect(window.getByTestId('worktree-row')).toHaveCount(0);
      await expect(window.getByTestId('panel-content-chat')).toHaveCount(0);
      const projects = await window.evaluate(() => window.api.loadProjects());
      expect(
        projects.items.find((item) => item.id === `demo-${DEMO_APP_ID}`)
          ?.worktrees,
      ).toEqual([]);

      git([
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.com',
        'commit',
        '--no-verify',
        '-m',
        'First commit',
      ]);
      // Returning from an external editor refreshes the warning and clears
      // only this preflight error, without consuming the preserved draft.
      await window.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(picker).not.toHaveAttribute(
        'data-source-no-commits',
        'true',
      );
      await expect(home.getByTestId('home-composer-error')).toHaveCount(0);
      await home.getByTestId('home-send-button').click();
      await expect(home).toHaveCount(0);
      await expect(window.getByTestId('worktree-row')).toHaveCount(1, {
        timeout: 60_000,
      });
      await expect(
        window.getByTestId('panel-content-chat').getByText(prompt).first(),
      ).toBeVisible({ timeout: 30_000 });
      await expect(window.getByTestId('worktree-error-notice')).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Chat mode send creates a worktree, navigates to Code, and the message reaches the transcript', async () => {
    test.setTimeout(120_000);

    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-home-surface-send-'),
    );
    // No pre-existing worktree so the post-send worktree-row count
    // unambiguously proves the Home send created one.
    seedDemoWorkspaces({
      userDataDir,
      apps: [DEMO_APP_ID],
      createWorktrees: false,
    });

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      await window.getByTestId('sidebar-create-task').click();
      const homePage = window.getByTestId('page-home');
      await expect(homePage).toBeVisible();
      await waitForHomeWorkspaceSelection(homePage);

      // Keep the approval lookup in flight long enough for a premature Code
      // navigation to become a user-visible empty frame. The fixed flow keeps
      // Home mounted until the starter tab has consumed this result.
      await electronApp.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('approval:resolved-default');
        ipcMain.handle('approval:resolved-default', async () => {
          await new Promise((resolve) => setTimeout(resolve, 250));
          return 'ask';
        });
      });

      const taskText = 'Investigate the failing health-check endpoint.';
      await window.evaluate(() => {
        window.__homeSendNoChatSeen = false;
        window.__homeSendTransitionChecked = false;
        let transitionCheckScheduled = false;
        let homeWasMounted = Boolean(
          document.querySelector('[data-testid="page-home"]'),
        );
        new MutationObserver(() => {
          const homeIsMounted = Boolean(
            document.querySelector('[data-testid="page-home"]'),
          );
          if (homeWasMounted && !homeIsMounted && !transitionCheckScheduled) {
            transitionCheckScheduled = true;
            setTimeout(() => {
              const chatPanelIsMounted = document.querySelector(
                '[data-testid="panel-content-chat"]',
              );
              if (!chatPanelIsMounted) window.__homeSendNoChatSeen = true;
              window.__homeSendTransitionChecked = true;
            }, 100);
          }
          homeWasMounted = homeIsMounted;
        }).observe(document.body, { childList: true, subtree: true });
      });
      await homePage.getByTestId('home-composer-editor').click();
      await homePage.getByTestId('home-composer-editor').fill(taskText);
      await homePage.getByTestId('home-send-button').click();

      // Task I1: `dispatchHomeSend`'s new-worktree route does ONE transition —
      // the (now reservation-only, sub-second) create resolves, the created
      // worktree is selected, then it navigates to Code. The Home page unmounts.
      await expect(homePage).toHaveCount(0);

      // The first (and only) new Code-page surface is the real chat panel —
      // there is no special pending page anymore. It is NEVER the embedded
      // no-selection HomeSurface (the "looks broken" regression of earlier
      // rounds).
      const panel = window.getByTestId('panel-content-chat');
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await expect(window.getByTestId('home-surface')).toHaveCount(0);
      await window.waitForFunction(
        () => window.__homeSendTransitionChecked === true,
      );
      expect(await window.evaluate(() => window.__homeSendNoChatSeen)).toBe(
        false,
      );

      const rows = window.getByTestId('worktree-row');
      await expect(rows).toHaveCount(1, { timeout: 60_000 });

      // The user's message shows in the transcript (as a queued bubble while
      // git-pending, or processed once ready).
      await expect(panel.getByText(taskText).first()).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});

// The worktree menu drives workspace:combine-worktree-with-existing-worktree.
// Golden: composition must preserve the user's saved chat across a restart.
test('combining repository worktrees opens a temporary destination and preserves its chat after restart', async () => {
  test.setTimeout(60_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-composition-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: [DEMO_APP_ID, 'go-cli'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: `demo-${DEMO_APP_ID}`,
    worktreeId: 'demo-main',
    tabs: [
      {
        id: 'saved-source-chat',
        title: 'Saved source chat',
        blocks: [
          { type: 'text', text: 'Saved transcript survives composition.' },
        ],
      },
    ],
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    let window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    const source = window.locator(
      `[data-testid="worktree-row"][data-project-id="demo-${DEMO_APP_ID}"][data-worktree-id="demo-main"]`,
    );
    await source.click();
    await source.click({ button: 'right' });
    await window.getByTestId('worktree-actions-menu-add-repo').click();
    const dialog = window.getByTestId('add-repo-to-worktree-modal');
    await dialog
      .getByTestId('add-repo-to-worktree-modal-pill-existing')
      .click();
    await dialog
      .getByTestId('existing-worktree-picker-option-demo-go-cli-demo-main')
      .click();
    await dialog.getByTestId('add-repo-to-worktree-modal-submit').click();
    await expect(dialog).toHaveCount(0, { timeout: 30_000 });
    const destination = await window.evaluate(async () =>
      (await window.api.loadProjects()).items.find(
        (item) => item.type === 'multi-repo' && item.temporary,
      ),
    );
    expect(destination).toBeDefined();
    const destinationSelector = `[data-testid="worktree-row"][data-project-id="${destination.id}"]`;
    await expect(
      window.locator(`[data-sidebar-selected-item] ${destinationSelector}`),
    ).toBeVisible();
    await expect(
      window
        .getByText('Saved transcript survives composition.', { exact: true })
        .first(),
    ).toBeVisible();
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = undefined;
    ({ electronApp } = await launchCanopy({ userDataDir }));
    window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await window.locator(destinationSelector).click();
    await expect(
      window
        .getByText('Saved transcript survives composition.', { exact: true })
        .first(),
    ).toBeVisible();
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
  }
});
