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
const CHAT_ID = 'codex-account-model-notice-chat';
const USER_MESSAGE = 'Fix the failing build';
// The E2E Codex catalog is pinned separately from production; these are its
// first and last-but-one entries (see auto-model-routing.spec.mjs).
const REJECTED_MODEL = 'gpt-5.6-sol';
const FALLBACK_MODEL = 'gpt-5.6-luna';
const REJECTION = `The '${REJECTED_MODEL}' model is not supported when using Codex with a ChatGPT account.`;

/**
 * CAN-4716: OpenAI refuses a Codex turn because the signed-in ChatGPT account
 * can't use the model. Main stamps the structured carrier on the terminal
 * `result` event; the reducer copies it onto the `Error:` row, and the shared
 * notice replaces the raw text with a one-click switch to a model the account
 * can run.
 */
function seedChat(userDataDir) {
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    tabs: [
      {
        id: CHAT_ID,
        title: 'Codex Account Model',
        model: REJECTED_MODEL,
        messages: [
          {
            id: 'codex-account-model-user-1',
            role: 'user',
            blocks: [{ type: 'text', text: USER_MESSAGE }],
            timestamp: Date.parse('2026-10-27T12:00:00.000Z'),
          },
        ],
      },
    ],
  });
}

async function injectRejection(electronApp, failure) {
  await injectChatEvent(electronApp, {
    projectId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    chatId: CHAT_ID,
    data: {
      type: 'result',
      is_error: true,
      subtype: 'codex_error',
      result: REJECTION,
      errors: [REJECTION],
      canopy_model_access_failure: failure,
    },
  });
}

test('offers a model the ChatGPT account can run and resends the failed turn', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-codex-account-model-notice-'),
  );
  seedChat(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const panel = window.getByTestId('panel-content-chat');
    await expect(panel.getByText(USER_MESSAGE, { exact: true })).toBeVisible();

    await injectRejection(electronApp, {
      kind: 'model_unsupported',
      model: REJECTED_MODEL,
      modelLabel: 'Sol 5.6',
      fallbackModel: FALLBACK_MODEL,
      fallbackModelLabel: 'Luna 5.6',
    });

    const notice = window.getByTestId('chat-codex-account-model-notice');
    await expect(notice).toHaveCount(1);
    await expect(notice).toContainText(
      "Your ChatGPT account can't use Sol 5.6.",
    );
    await expect(panel).not.toContainText('is not supported when using Codex');

    // The carrier is persisted with the row, so the notice survives a reload.
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const useFallback = window.getByTestId(
      'chat-codex-account-model-notice-use-fallback',
    );
    await expect(useFallback).toHaveText('Use Luna 5.6');
    await expect(useFallback).toBeEnabled();

    await useFallback.click();

    // The failed turn never reached the model, so the original prompt is
    // resent on the fallback model, and the notice becomes history.
    await expect(
      window.getByTestId('panel-content-chat').getByText(USER_MESSAGE, {
        exact: true,
      }),
    ).toHaveCount(2);
    await expect(useFallback).toBeDisabled();
    await expect(window.getByTestId('chat-model-picker')).toContainText('Luna');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('asks for another model when no model the account can run is known', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-codex-account-model-no-fallback-'),
  );
  seedChat(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(
      window
        .getByTestId('panel-content-chat')
        .getByText(USER_MESSAGE, { exact: true }),
    ).toBeVisible();

    await injectRejection(electronApp, {
      kind: 'model_unsupported',
      model: REJECTED_MODEL,
      modelLabel: 'Sol 5.6',
    });

    const notice = window.getByTestId('chat-codex-account-model-notice');
    await expect(notice).toContainText(
      "Your ChatGPT account can't use Sol 5.6. Choose another model.",
    );
    await expect(
      window.getByTestId('chat-codex-account-model-notice-use-fallback'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
