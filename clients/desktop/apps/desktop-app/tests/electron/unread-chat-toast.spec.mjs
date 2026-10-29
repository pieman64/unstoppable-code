import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  injectChatEvent,
  seedPipelineExecution,
  seedWorktreeChat,
} from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const CHAT_ID = 'unread-toast-chat';
const CHAT_TITLE = 'Unread Toast';
const ASSISTANT_PREVIEW = 'Seeded answer before toast.';
// The toast headline names the worktree, so the message leaves the branch out.
const TOAST_MESSAGE = `${CHAT_TITLE}: ${ASSISTANT_PREVIEW}`;
const PENDING_PIPELINE_NAME = 'Queued Overview Pipeline';

test('dismissing an unread chat toast does not mark the chat read', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-unread-chat-toast-'),
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
        title: CHAT_TITLE,
        messages: [
          {
            id: 'assistant-preview',
            role: 'assistant',
            blocks: [{ type: 'text', text: ASSISTANT_PREVIEW }],
            timestamp: Date.parse('2026-04-10T12:00:00.000Z'),
          },
        ],
      },
    ],
  });
  seedPipelineExecution({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    execution: {
      id: 'pending-overview-pipeline',
      pipelineName: PENDING_PIPELINE_NAME,
      status: 'pending',
    },
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();

    await app.openOverviewPage();
    await expect(window.getByTestId('overview-page')).toBeVisible();
    await expect(window.getByTestId('overview-unread-chat-card')).toHaveCount(
      0,
    );
    await expect(
      window.getByTestId('overview-in-progress-pipeline-card'),
    ).toContainText(PENDING_PIPELINE_NAME);
    await expect(
      window.getByTestId('overview-in-progress-pipeline-card'),
    ).toContainText('pending');
    await expect(window.getByTestId('worktree-row-unread')).toHaveCount(0);

    await injectChatEvent(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      data: { type: 'result', is_error: false, result: 'Done' },
    });

    const toast = window
      .getByTestId('toast-stack-card')
      .filter({ hasText: TOAST_MESSAGE });
    await expect(toast).toBeVisible({ timeout: 15_000 });
    await expect(toast).not.toContainText(`${WORKTREE_BRANCH}:`);
    // A fixed 352px column, and the message stops at three lines.
    expect((await toast.boundingBox())?.width ?? 0).toBeLessThanOrEqual(352);
    await expect(toast.locator('.line-clamp-3')).toHaveCount(1);
    const overviewCard = window.getByTestId('overview-unread-chat-card');
    await expect(overviewCard).toBeVisible();
    await expect(overviewCard).toContainText(CHAT_TITLE);
    await expect(overviewCard).toContainText(ASSISTANT_PREVIEW);
    await expect(overviewCard).toContainText('Unread');
    await expect(window.getByTestId('worktree-row-unread')).toBeVisible();

    await toast.getByTestId('toast-dismiss').click();
    await expect(toast).toHaveCount(0);

    await expect(overviewCard).toBeVisible();
    await expect(window.getByTestId('worktree-row-unread')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
