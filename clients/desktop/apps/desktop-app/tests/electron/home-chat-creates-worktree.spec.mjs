import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

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
