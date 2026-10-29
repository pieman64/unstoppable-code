import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { readChatStorageTabs } from './readChatStorage.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedUsageLimitedChats, seedWorktreeChat } from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  createFixture,
  conversationRequests,
  protocolRequests,
  seedPreferences,
  closeFixture,
} from './codexPipelineRuntime.mjs';

// Usage page "Resume interrupted sessions" button (2026-07-23). When the
// usage-limited registry has entries for a provider and no rate-limit window
// is confirmed at 100% (here: no live rate-limit data at all), the provider's
// usage card offers an info-themed Resume button that opens the same
// `UsageLimitResumeModal` the account-change flow uses — with usage-review
// copy instead of "You switched accounts". Confirming resumes the sessions,
// clears the registry, and the button disappears because nothing resumable is
// left. The card component is shared with the `usage` panel, so this covers
// the panel rendering path too.

const WORKTREE_ID = 'demo-main';
const WORKSPACE = {
  workspaceId: 'demo-ts-pnpm-vite',
  workspaceName: 'TypeScript pnpm Vite',
  app: 'ts-pnpm-vite',
  chatId: 'usage-resume-button-chat',
  chatTitle: 'Usage resume button chat',
};

function readRegistry(userDataDir) {
  const registryPath = path.join(userDataDir, 'usage-limited-chats.json');
  return JSON.parse(readFileSync(registryPath, 'utf8'));
}

test.describe('usage page resume button', () => {
  for (const stopMode of ['quit', 'crash']) {
    test(`recovers an active chat after ${stopMode} and resumes the same provider thread`, async () => {
      test.setTimeout(180_000);
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), 'canopy-chat-shutdown-'),
      );
      seedDemoWorkspaces({ userDataDir, apps: [WORKSPACE.app] });
      seedPreferences(userDataDir);
      seedWorktreeChat({
        userDataDir,
        workspaceId: WORKSPACE.workspaceId,
        worktreeId: WORKTREE_ID,
        providerType: 'codex',
        tabs: [{ id: WORKSPACE.chatId, title: WORKSPACE.chatTitle }],
      });
      const fixture = createFixture('staged');
      let { electronApp } = await launchCanopy({
        userDataDir,
        env: fixture.env,
      });
      try {
        const window = await electronApp.firstWindow();
        const app = new CanopyAppDriver(window);
        await app.waitForShell();
        await app.openMainPage();
        await app.selectWorktree(WORKTREE_ID);
        const composer = window
          .getByTestId('panel-content-chat')
          .getByRole('textbox')
          .first();
        await composer.fill('Keep working through an application restart.');
        await composer.press('Enter');
        await expect(
          window.getByText('E2E_CODEX_STREAM_007', { exact: true }),
        ).toBeVisible({ timeout: 30_000 });
        const firstTurn = conversationRequests(fixture.logPath).find(
          (request) =>
            request.method === 'turn/start' &&
            JSON.stringify(request.params.input).includes('Keep working'),
        );
        expect(firstTurn).toBeTruthy();
        if (stopMode === 'crash') {
          const pid = await electronApp.evaluate(() => process.pid);
          process.kill(pid, 'SIGKILL');
          await closeCanopy(electronApp, userDataDir, {
            keepUserData: true,
          }).catch(() => undefined);
        } else {
          await closeCanopy(electronApp, userDataDir, { keepUserData: true });
        }
        if (stopMode === 'quit')
          expect(readRegistry(userDataDir).entries).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                chatId: WORKSPACE.chatId,
                resumeReason: 'app_shutdown',
              }),
            ]),
          );
        ({ electronApp } = await launchCanopy({
          userDataDir,
          env: { ...fixture.env, CANOPY_E2E_CODEX_MODE: 'normal' },
        }));
        const restarted = await electronApp.firstWindow();
        const restartedApp = new CanopyAppDriver(restarted);
        await restartedApp.waitForShell();
        const restoredTabs = readChatStorageTabs(
          path.join(userDataDir, 'workspaces', WORKSPACE.workspaceId),
          WORKTREE_ID,
        );
        const restoredChat = restoredTabs.tabs.find(
          (tab) => tab.id === WORKSPACE.chatId,
        );
        const restoredTimers = restoredChat.messages
          .flatMap((message) => message.blocks)
          .filter((block) => block.type === 'turn_timer');
        expect(restoredTimers.length).toBeGreaterThan(0);
        expect(
          restoredTimers.every(
            (timer) => typeof timer.completedAt === 'number',
          ),
        ).toBe(true);
        await restartedApp.openUsagePage();
        const resumeButton = restarted.getByTestId('usage-shutdown-resume');
        await expect(resumeButton).toBeVisible();
        await resumeButton.click();
        await expect(
          restarted.getByTestId('usage-limit-resume-modal'),
        ).toContainText('Application stopped');
        await restarted.getByTestId('usage-limit-resume-confirm').click();
        await expect
          .poll(() =>
            protocolRequests(fixture.logPath).some(
              (request) =>
                request.method === 'thread/resume' &&
                request.params.threadId === firstTurn.params.threadId,
            ),
          )
          .toBe(true);
        await expect
          .poll(() => readRegistry(userDataDir).entries.length)
          .toBe(0);
        await expect(resumeButton).toBeHidden({ timeout: 5_000 });
        await restartedApp.openMainPage();
        await restartedApp.selectWorktree(WORKTREE_ID);
        await expect(
          restarted.getByText('E2E_CODEX_STREAM_007', { exact: true }),
        ).toHaveCount(1);
        await expect(
          restarted.getByRole('button', { name: 'Stop generation' }),
        ).toHaveCount(0);
      } finally {
        await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
      }
    });
  }

  test('shows for registry entries, opens the resume modal, and hides after resume', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-usage-page-resume-button-'),
    );

    seedDemoWorkspaces({ userDataDir, apps: [WORKSPACE.app] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE.workspaceId,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [{ id: WORKSPACE.chatId, title: WORKSPACE.chatTitle }],
    });
    seedUsageLimitedChats({
      userDataDir,
      entries: [
        {
          projectId: WORKSPACE.workspaceId,
          worktreeId: WORKTREE_ID,
          chatId: WORKSPACE.chatId,
          provider: 'claude',
          detectedAt: Date.parse('2026-04-10T12:00:00.000Z'),
          workspaceName: WORKSPACE.workspaceName,
          chatTitle: WORKSPACE.chatTitle,
        },
      ],
    });

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openUsagePage();

      const resumeButton = window.getByTestId('usage-provider-claude-resume');
      await expect(resumeButton).toBeVisible({ timeout: 15_000 });
      await expect(resumeButton).toContainText('Resume 1 interrupted session');

      await resumeButton.click();

      const modal = window.getByTestId('usage-limit-resume-modal');
      await expect(modal).toBeVisible({ timeout: 15_000 });
      // Usage-review origin copy, not the account-change copy.
      await expect(
        window.getByText(
          'Resume sessions interrupted by a Claude usage limit or authentication issue.',
        ),
      ).toBeVisible();

      const chatCheckbox = window.getByTestId(
        `usage-limit-resume-chat-${WORKSPACE.chatId}`,
      );
      await expect(chatCheckbox).toBeChecked();

      await window.getByTestId('usage-limit-resume-confirm').click();
      await expect(modal).toBeHidden({ timeout: 20_000 });

      // The resume cleared the registry, so the button loses its reason to
      // exist and unrenders on the post-close refetch.
      await expect(resumeButton).toBeHidden({ timeout: 15_000 });
      expect(readRegistry(userDataDir).entries).toEqual([]);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('does not render when the registry is empty', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-usage-page-resume-button-empty-'),
    );

    seedDemoWorkspaces({ userDataDir, apps: [WORKSPACE.app] });
    seedUsageLimitedChats({ userDataDir, entries: [] });

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openUsagePage();

      // The Claude usage card renders (both providers always appear in the
      // overview), but with an empty registry there is nothing to resume.
      await expect(
        window.getByTestId('usage-provider-claude-connect'),
      ).toBeVisible({ timeout: 15_000 });
      await window.waitForTimeout(1_500);
      await expect(
        window.getByTestId('usage-provider-claude-resume'),
      ).toBeHidden();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
