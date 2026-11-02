import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { readChatStorageTabs } from './readChatStorage.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  seedUsageLimitedChats,
  seedWorktreeChat,
  registerScenario,
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
} from './seeders/index.mjs';
import {
  seedWaitingSessions,
  waitingUsageScenario,
  WAITING_EXECUTION,
} from './fixtures/usage-waiting-sessions.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  createFixture,
  conversationRequests,
  protocolRequests,
  seedPreferences,
  closeFixture,
} from './codexPipelineRuntime.mjs';

// Usage page interrupted-sessions notice (2026-07-23, consolidated 2026-10).
// When the usage-limited registry holds any idle session in the selected
// workspace context — an application stop, a usage limit, or an
// authentication issue, for any provider — one notice above the Usage groups
// (`usage-interrupted-sessions`) counts them and offers a single Resume…
// button. It opens the same `UsageLimitResumeModal` the Home Continue row
// opens (origin `home`, every interrupted session at once), whatever a
// provider's usage windows say. Confirming resumes the sessions, clears the
// registry, and the notice disappears because nothing resumable is left. The
// notice is shared with the `usage` panel, so this covers the panel
// rendering path too.

const WORKTREE_ID = 'demo-main';
const WORKSPACE = {
  workspaceId: 'demo-ts-pnpm-vite',
  workspaceName: 'TypeScript pnpm Vite',
  app: 'ts-pnpm-vite',
  chatId: 'usage-resume-button-chat',
  chatTitle: 'Usage resume button chat',
};

for (const kind of [
  'chat',
  'multiple',
  'pipeline',
  'mixed',
  'unknown',
  'review',
]) {
  test(`blocked secondary Codex window routes ${kind} sessions without resuming`, async () => {
    test.setTimeout(120_000);
    const fixture = seedWaitingSessions({ kind });
    const registryBefore = readRegistry(fixture.userDataDir);
    let electronApp;
    try {
      await registerScenario(
        DEFAULT_MOCK_BASE_URL,
        'mock',
        waitingUsageScenario({ unknownReset: kind === 'unknown' }),
      );
      ({ electronApp } = await launchCanopy({
        userDataDir: fixture.userDataDir,
      }));
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      const panel = kind === 'mixed';
      if (panel) {
        await app.openMainPage();
        await app.selectWorktree(WORKTREE_ID);
        await window.getByTestId('panel-add-tab-group-chat').click();
        await window.getByTestId('panel-add-menu-usage-submenu').click();
        await window.getByTestId('panel-add-menu-item-usage-all').click();
      } else {
        await app.openUsagePage();
      }
      const card = window
        .getByTestId('usage-provider-card-codex')
        .filter({ visible: true });
      const waiting = card.getByTestId('usage-provider-codex-waiting');
      const count = kind === 'multiple' || kind === 'mixed' ? 2 : 1;
      await expect(waiting).toContainText(
        `${count} interrupted session${count === 1 ? '' : 's'}`,
      );
      await expect(waiting).toContainText(
        kind === 'unknown' ? 'Reset time unavailable' : 'Limit resets at',
      );
      await expect(card.getByTestId('usage-provider-codex-resume')).toHaveCount(
        0,
      );
      await expect(card).toContainText('Limit reached');
      await expect(card.getByRole('progressbar').last()).toHaveAttribute(
        'aria-valuetext',
        /100% used, Limit reached/,
      );
      if (count > 1) {
        await waiting.getByTestId('usage-provider-codex-waiting-view').click();
        const chooser = window.getByTestId(
          'usage-provider-codex-waiting-chooser',
        );
        await expect(chooser).toBeVisible();
        if (kind === 'mixed') {
          await chooser
            .getByTestId(
              `usage-provider-codex-waiting-session-pipeline-${WAITING_EXECUTION}`,
            )
            .click();
        } else {
          await chooser
            .getByTestId(
              `usage-provider-codex-waiting-session-chat-${WORKSPACE.workspaceId}-${WORKTREE_ID}-${fixture.ids[1]}`,
            )
            .click();
        }
      } else {
        await waiting.getByTestId('usage-provider-codex-waiting-open').click();
      }
      if (kind === 'pipeline' || kind === 'mixed') {
        await expect(
          window.locator(
            `[data-testid="pipeline-execution-panel"][data-execution-id="${WAITING_EXECUTION}"]`,
          ),
        ).toBeVisible();
        expect(
          JSON.parse(readFileSync(fixture.pipeline.stateFilePath, 'utf8'))
            .status,
        ).toBe('paused');
      } else if (kind === 'review') {
        const transcript = window.getByTestId('usage-retained-review-chat');
        await expect(transcript).toBeVisible();
        await expect(
          transcript.getByText(`Interrupted transcript for ${fixture.ids[0]}`, {
            exact: true,
          }),
        ).toBeVisible();
        const viewport = transcript.getByTestId('chat-message-list-scroll');
        await expect(viewport).toBeVisible();
        expect((await viewport.boundingBox())?.height).toBeGreaterThan(200);
        await expect(transcript.getByRole('textbox')).toHaveCount(0);
        await expect(
          transcript.getByRole('button', {
            name: /Fork|Good response|Bad response/,
          }),
        ).toHaveCount(0);
        await expect(
          transcript.getByText("Viewing this chat doesn't resume it."),
        ).toBeVisible();
        await transcript
          .getByRole('button', { name: 'Close', exact: true })
          .click();
        await expect(transcript).toBeHidden();
      } else {
        const chatId = kind === 'multiple' ? fixture.ids[1] : fixture.ids[0];
        const chat = window.locator(`[data-panel-id="panel-chat-${chatId}"]`);
        await expect(chat).toBeVisible();
        await expect(chat).toContainText(
          `Interrupted transcript for ${chatId}`,
        );
        await expect(
          chat.getByTestId('chat-input-usage-limit-banner'),
        ).toBeVisible();
        await expect(
          chat.getByTestId('chat-input-usage-limit-schedule-resume'),
        ).toBeVisible();
      }
      await expect(window.getByTestId('usage-limit-resume-modal')).toHaveCount(
        0,
      );
      expect(readRegistry(fixture.userDataDir)).toEqual(registryBefore);
    } finally {
      if (electronApp) await closeCanopy(electronApp, fixture.userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, 'mock');
    }
  });
}

function readRegistry(userDataDir) {
  const registryPath = path.join(userDataDir, 'usage-limited-chats.json');
  return JSON.parse(readFileSync(registryPath, 'utf8'));
}

test.describe('usage page interrupted-sessions notice', () => {
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
        const notice = restarted.getByTestId('usage-interrupted-sessions');
        await expect(notice).toContainText('1 session was interrupted.');
        await notice.getByTestId('usage-interrupted-sessions-resume').click();
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
        await expect(notice).toBeHidden({ timeout: 15_000 });
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

      const notice = window.getByTestId('usage-interrupted-sessions');
      await expect(notice).toBeVisible({ timeout: 15_000 });
      await expect(notice).toContainText('1 session was interrupted.');

      await notice.getByTestId('usage-interrupted-sessions-resume').click();

      const modal = window.getByTestId('usage-limit-resume-modal');
      await expect(modal).toBeVisible({ timeout: 15_000 });
      // The review summarizes the actual interruption reasons, not the
      // account-change copy.
      await expect(
        window.getByText('A Claude usage limit stopped this chat.'),
      ).toBeVisible();

      const chatCheckbox = window.getByTestId(
        `usage-limit-resume-chat-${WORKSPACE.chatId}`,
      );
      await expect(chatCheckbox).toBeChecked();

      await window.getByTestId('usage-limit-resume-confirm').click();
      await expect(modal).toBeHidden({ timeout: 20_000 });

      // One confirmed chat opens directly, which leaves the Usage page
      // before the resume settles.
      await expect(
        window.locator(`[data-panel-id="panel-chat-${WORKSPACE.chatId}"]`),
      ).toBeVisible({ timeout: 15_000 });
      await expect
        .poll(() => readRegistry(userDataDir).entries, { timeout: 15_000 })
        .toEqual([]);

      // The resume cleared the registry, so back on Usage the notice has no
      // reason to exist.
      await app.openUsagePage();
      await expect(
        window.getByTestId('usage-provider-claude-connect'),
      ).toBeVisible({ timeout: 15_000 });
      await expect(notice).toHaveCount(0);
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

      // The Claude usage group renders (both providers always appear in the
      // overview), but with an empty registry there is nothing to resume.
      await expect(
        window.getByTestId('usage-provider-claude-connect'),
      ).toBeVisible({ timeout: 15_000 });
      await window.waitForTimeout(1_500);
      await expect(
        window.getByTestId('usage-interrupted-sessions'),
      ).toBeHidden();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
