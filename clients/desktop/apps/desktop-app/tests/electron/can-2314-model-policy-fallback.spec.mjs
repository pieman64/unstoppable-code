/**
 * CAN-2314 — a persisted interactive chat whose model becomes blocked falls
 * back to the first allowed catalog model and explains the change visibly.
 *
 * Run after `pnpm run build:e2e` with:
 *   pnpm exec playwright test can-2314-model-policy-fallback.spec.mjs --reporter=line
 *
 * The shared cloud mock keys a deterministic org policy off the API key below;
 * no live account, provider, or network is involved.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  ORG_CONTEXT_A,
  ORG_CONTEXT_ENV,
  ORG_CONTEXT_WORKSPACE,
  seedOrgContextScoping,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { selectWorkspaceContext } from './workspaceContextMenu.mjs';

const MODEL_POLICY_CLOUD_API_KEY = 'csk_model_policy_e2e';
const WORKSPACE_ID = ORG_CONTEXT_WORKSPACE;
const WORKTREE_ID = 'model-policy-owner';
const WORKTREE_BRANCH = WORKTREE_ID;

test('falls back a blocked persisted model and explains why', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can-2314-policy-fallback-'),
  );
  seedOrgContextScoping(userDataDir, {
    organizationWorktreeIds: [WORKTREE_ID],
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    tabs: [
      {
        id: 'can-2314-blocked-chat',
        title: 'Blocked model chat',
        model: 'gpt-5.6-sol',
        executionHarness: 'codex',
      },
    ],
  });

  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const persisted = await window.evaluate(
      (target) => window.api.chat.loadTabs(target),
      { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
    );
    expect(
      persisted.tabs.find((tab) => tab.id === 'can-2314-blocked-chat')?.model,
    ).toBe('gpt-5.6-sol');

    const saveResult = await window.evaluate(
      async (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
      MODEL_POLICY_CLOUD_API_KEY,
    );
    expect(saveResult.status.authenticated).toBe(true);
    // Announce the sign-in so the sidebar's context switcher re-reads it.
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);

    const picker = window
      .locator('[data-testid="chat-model-picker"]:visible')
      .first();

    await expect(picker).not.toContainText('GPT 5.6 Sol');
    await expect(
      window.getByText(/Model Policy E2E blocked .* so this chat switched to/),
    ).toBeVisible();

    await electronApp.evaluate(({ ipcMain }, channel) => {
      ipcMain.removeHandler(channel);
      globalThis.__capturedPolicyFallbackSend = undefined;
      ipcMain.handle(channel, (_event, request) => {
        globalThis.__capturedPolicyFallbackSend = request;
      });
    }, 'chat:send-message');
    const composer = window.getByRole('textbox').first();
    await composer.fill('Continue on the allowed model');
    await window.getByRole('button', { name: 'Send message' }).click();

    await expect
      .poll(() =>
        electronApp.evaluate(
          () => globalThis.__capturedPolicyFallbackSend?.executionHarness,
        ),
      )
      .toBe('claude');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
