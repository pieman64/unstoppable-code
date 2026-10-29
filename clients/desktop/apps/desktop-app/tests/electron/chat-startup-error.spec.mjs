import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { injectChatEvent, seedWorktreeChat } from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'startup-error-chat';
const USER_MESSAGE = 'Start the session';
const STARTUP_ERROR = 'Agent harness failed during startup';

for (const syntheticResult of [false, true]) {
  test(`a harness startup failure is durable in the chat transcript (synthetic result: ${syntheticResult})`, async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-chat-startup-error-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'codex',
      tabs: [
        {
          id: CHAT_ID,
          title: 'Startup Error',
          messages: [
            {
              id: 'startup-user-message',
              role: 'user',
              blocks: [{ type: 'text', text: USER_MESSAGE }],
              timestamp: Date.parse('2026-08-28T12:00:00.000Z'),
            },
          ],
        },
      ],
    });

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);

      const panel = window.getByTestId('panel-content-chat');
      await expect(
        panel.getByText(USER_MESSAGE, { exact: true }),
      ).toBeVisible();

      await injectChatEvent(electronApp, {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        chatId: CHAT_ID,
        data: syntheticResult
          ? {
              type: 'result',
              is_error: true,
              subtype: 'codex_error',
              result: STARTUP_ERROR,
              errors: [STARTUP_ERROR],
            }
          : { type: 'error', error: STARTUP_ERROR },
      });

      await expect(
        panel.getByText(`Error: ${STARTUP_ERROR}`, { exact: true }),
      ).toBeVisible();
      await window.reload();
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
      await expect(
        window
          .getByTestId('panel-content-chat')
          .getByText(`Error: ${STARTUP_ERROR}`, { exact: true }),
      ).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}
