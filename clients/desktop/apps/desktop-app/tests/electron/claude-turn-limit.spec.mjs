import { connectMockCloudAccount } from './seeders/connectMockCloudAccount.mjs';
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
const CHAT_ID = 'claude-turn-limit-chat';
const PROMPT = 'Finish the change';

function seedTurnLimitChat(userDataDir, providerType = 'claude') {
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Claude turn limit',
        providerType,
        sdkSessionId: '11111111-2222-4333-8444-555555555555',
        messages: [
          {
            id: 'limit-user',
            role: 'user',
            timestamp: Date.parse('2026-10-01T12:00:00Z'),
            blocks: [{ type: 'text', text: PROMPT }],
          },
          {
            id: 'limit-assistant',
            role: 'assistant',
            timestamp: Date.parse('2026-10-01T12:00:01Z'),
            blocks: [{ type: 'text', text: 'The first part is done.' }],
          },
        ],
      },
    ],
  });
}

async function injectTurnLimit(electronApp) {
  await injectChatEvent(electronApp, {
    projectId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    chatId: CHAT_ID,
    data: {
      type: 'result',
      subtype: 'error_max_turns',
      terminal_reason: 'max_turns',
      is_error: true,
      num_turns: 201,
      errors: ['Reached maximum number of turns (200)'],
    },
  });
}

test('Claude turn limit survives reload and Resume continues without replaying the prompt', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'claude-turn-limit-'));
  seedTurnLimitChat(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await connectMockCloudAccount(
      window,
      'csk_claude_turn_limit_attachments_e2e',
    );
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await injectTurnLimit(electronApp);
    const banner = window.getByTestId('claude-turn-limit-notice');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Claude turn limit reached');
    await window.reload();
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(banner).toBeVisible();
    const editor = window.locator('[data-slate-editor="true"]').last();
    await editor.fill('My unsent draft');
    await editor.evaluate((element) => {
      const file = new File(['draft content'], 'draft.txt', {
        type: 'text/plain',
      });
      const event = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', {
        value: { types: ['Files'], files: [file], dropEffect: 'copy' },
      });
      element.dispatchEvent(event);
    });
    const attachment = window
      .getByTestId('attachment-pill')
      .filter({ hasText: 'draft.txt' });
    await expect(attachment).toBeVisible();
    await window.getByTestId('claude-turn-limit-resume').click();
    const panel = window.getByTestId('panel-content-chat');
    await expect(
      panel.getByText('Continue', { exact: true }).first(),
    ).toBeVisible();
    await expect(panel.getByText(PROMPT, { exact: true })).toHaveCount(1);
    await expect(banner).toHaveCount(0);
    await expect(editor).toContainText('My unsent draft');
    await expect(attachment).toBeVisible();
    await expect
      .poll(() =>
        window.evaluate(
          async ({ projectId, worktreeId, chatId }) => {
            const page = await window.api.chat.getTranscriptPage({
              projectId,
              worktreeId,
              chatId,
            });
            return page.messages;
          },
          { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID, chatId: CHAT_ID },
        ),
      )
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            blocks: expect.arrayContaining([
              { type: 'text', text: 'Continue' },
            ]),
          }),
        ]),
      );
    const recoveryMessage = await window.evaluate(
      async ({ projectId, worktreeId, chatId }) => {
        const page = await window.api.chat.getTranscriptPage({
          projectId,
          worktreeId,
          chatId,
        });
        return page.messages.find(
          (message) =>
            message.role === 'user' &&
            message.blocks.some(
              (block) => block.type === 'text' && block.text === 'Continue',
            ),
        );
      },
      { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID, chatId: CHAT_ID },
    );
    expect(recoveryMessage.attachmentPaths ?? []).toEqual([]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Ollama max-turns errors do not offer Claude recovery settings', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'ollama-turn-limit-'));
  seedTurnLimitChat(userDataDir, 'ollama');
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await injectTurnLimit(electronApp);
    await expect
      .poll(() =>
        window.evaluate(
          async ({ projectId, worktreeId, chatId }) =>
            (await window.api.chat.getState({ projectId, worktreeId }))
              .runtimeByChatId[chatId]?.status,
          { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID, chatId: CHAT_ID },
        ),
      )
      .toBe('failed');
    await expect(window.getByTestId('claude-turn-limit-notice')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Claude settings saves turn limits, rejects invalid numbers, and retains No limit', async () => {
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('claude');
    const input = window.getByTestId('settings-claude-max-turns');
    await expect(input).toHaveValue('500');
    for (const value of ['1', '9999']) {
      await input.fill(value);
      await input.press('Enter');
      await expect
        .poll(() =>
          window.evaluate(
            async () => (await window.api.loadPreferences()).claudeMaxTurns,
          ),
        )
        .toBe(Number(value));
    }
    for (const value of ['0', '-1', '10000', '1.5', '']) {
      await input.fill(value);
      await input.press('Enter');
      await expect(
        window.getByTestId('settings-claude-max-turns-error'),
      ).toBeVisible();
      expect(
        await window.evaluate(
          async () => (await window.api.loadPreferences()).claudeMaxTurns,
        ),
      ).toBe(9999);
    }
    await input.fill('250');
    await input.press('Enter');
    await expect
      .poll(() =>
        window.evaluate(
          async () => (await window.api.loadPreferences()).claudeMaxTurns,
        ),
      )
      .toBe(250);
    await window.getByTestId('settings-claude-limit-turns').click();
    await expect(input).toHaveCount(0);
    await expect
      .poll(() =>
        window.evaluate(
          async () => (await window.api.loadPreferences()).claudeMaxTurns,
        ),
      )
      .toBeNull();
    await window.reload();
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('claude');
    await expect(
      window.getByTestId('settings-claude-limit-turns'),
    ).not.toBeChecked();
    await expect(input).toHaveCount(0);
    await window.getByTestId('settings-claude-limit-turns').click();
    await expect(input).toHaveValue('500');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('editing the turn limit then clicking its switch disables it in one click', async () => {
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('claude');
    await window.getByTestId('settings-claude-max-turns').fill('750');
    await window.getByTestId('settings-claude-limit-turns').click();
    await expect(
      window.getByTestId('settings-claude-limit-turns'),
    ).toHaveAttribute('aria-checked', 'false');
    await expect(window.getByTestId('settings-claude-max-turns')).toHaveCount(
      0,
    );
    await expect
      .poll(() =>
        window.evaluate(
          async () => (await window.api.loadPreferences()).claudeMaxTurns,
        ),
      )
      .toBeNull();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

async function dispatchAdvisorAction(electronApp, action) {
  return electronApp.evaluate(
    async ({ BrowserWindow, ipcMain }, request) => {
      const responseChannel = 'app-advisor:tool-response';
      const mainWindow = BrowserWindow.getAllWindows().find(
        (candidate) =>
          !candidate.webContents.getURL().includes('surface=app-advisor'),
      );
      if (!mainWindow) throw new Error('Main window not found');
      ipcMain.removeHandler(responseChannel);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Timed out waiting for App Advisor tool')),
          10_000,
        );
        ipcMain.handle(responseChannel, (_event, candidate) => {
          if (candidate?.requestId !== request.requestId) return;
          clearTimeout(timer);
          resolve(candidate);
        });
        mainWindow.webContents.send('app-advisor:tool-request', request);
      });
    },
    {
      kind: 'dispatch_action',
      requestId: `claude-limit-${Date.now()}`,
      action,
    },
  );
}

test('App Advisor reads and changes the turn limit while Claude settings is open', async () => {
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('claude');
    const input = window.getByTestId('settings-claude-max-turns');
    await expect(input).toHaveValue('500');
    const read = await dispatchAdvisorAction(electronApp, {
      type: 'settings.get_claude_max_turns',
    });
    expect(read.ok).toBe(true);
    expect(read.result).toEqual({ claudeMaxTurns: 500 });
    for (const maxTurns of [1, 9999, null]) {
      const response = await dispatchAdvisorAction(electronApp, {
        type: 'settings.set_claude_max_turns',
        maxTurns,
      });
      expect(response.ok).toBe(true);
      expect(response.result).toEqual({ claudeMaxTurns: maxTurns });
      if (maxTurns === null) await expect(input).toHaveCount(0);
      else await expect(input).toHaveValue(String(maxTurns));
      expect(
        (
          await dispatchAdvisorAction(electronApp, {
            type: 'settings.get_claude_max_turns',
          })
        ).result,
      ).toEqual({ claudeMaxTurns: maxTurns });
    }
    const invalid = await dispatchAdvisorAction(electronApp, {
      type: 'settings.set_claude_max_turns',
      maxTurns: 0,
    });
    expect(invalid.ok).toBe(false);
    expect(
      await window.evaluate(
        async () => (await window.api.loadPreferences()).claudeMaxTurns,
      ),
    ).toBeNull();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
