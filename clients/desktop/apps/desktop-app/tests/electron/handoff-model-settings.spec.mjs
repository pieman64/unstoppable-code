/**
 * CAN-3894: the Conversation handoff model is its own Feature models row.
 *
 * A fresh install shows Haiku with thinking off. Changing the row saves only
 * `handoffSummaryModel` / `handoffSummaryThinkingLevel`; the chat title and
 * worktree activity summary rows keep their own values, and the selection
 * survives a relaunch.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const HANDOFF_MODEL = 'settings-handoff-summary-model';
const HANDOFF_THINKING = 'settings-handoff-summary-thinking';
const SAVED_HANDOFF_MODEL = 'gpt-6.1-sol';
const SAVED_HANDOFF_THINKING = 'high';

const ROWS = [
  ['Chat title model', 'Generates names for chat tabs.'],
  [
    'Conversation handoff model',
    'Summarizes conversations for provider switching, session recovery, and continuation from archived chats.',
  ],
  [
    'Worktree activity summary model',
    'Generates activity-panel summaries covering the whole worktree.',
  ],
];

async function advisorRequest(electronApp, request) {
  return electronApp.evaluate(async ({ BrowserWindow, ipcMain }, payload) => {
    const mainWindow = BrowserWindow.getAllWindows().find(
      (window) => !window.webContents.getURL().includes('surface=app-advisor'),
    );
    if (!mainWindow) throw new Error('Missing main window');
    ipcMain.removeHandler('app-advisor:tool-response');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Advisor response timed out')),
        5000,
      );
      ipcMain.handle('app-advisor:tool-response', (_event, response) => {
        if (response.requestId !== payload.requestId) return;
        clearTimeout(timer);
        resolve(response);
      });
      mainWindow.webContents.send('app-advisor:tool-request', payload);
    });
  }, request);
}

test('App Advisor reads and changes the same handoff model shown in Settings', async () => {
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const chatTab = await openChatSettings(electronApp);
    const before = readPersistedPreferences(userDataDir);
    const read = await advisorRequest(electronApp, {
      kind: 'dispatch_action',
      requestId: 'handoff-read',
      source: 'assistant',
      action: { type: 'settings.get_handoff_model' },
    });
    expect(read).toMatchObject({
      ok: true,
      result: {
        handoffSummaryModel: 'haiku',
        handoffSummaryThinkingLevel: 'off',
      },
    });
    const saved = await advisorRequest(electronApp, {
      kind: 'dispatch_action',
      requestId: 'handoff-save',
      source: 'assistant',
      action: {
        type: 'settings.set_handoff_model',
        model: SAVED_HANDOFF_MODEL,
        thinkingLevel: SAVED_HANDOFF_THINKING,
      },
    });
    expect(saved).toMatchObject({
      ok: true,
      result: {
        handoffSummaryModel: SAVED_HANDOFF_MODEL,
        handoffSummaryThinkingLevel: SAVED_HANDOFF_THINKING,
      },
    });
    await expect(chatTab.getByTestId(HANDOFF_MODEL)).toHaveValue(
      SAVED_HANDOFF_MODEL,
    );
    await expect(chatTab.getByTestId(HANDOFF_THINKING)).toHaveValue(
      SAVED_HANDOFF_THINKING,
    );
    const rejected = await advisorRequest(electronApp, {
      kind: 'dispatch_action',
      requestId: 'handoff-unavailable',
      source: 'assistant',
      action: {
        type: 'settings.set_handoff_model',
        model: 'ollama:not-installed:claude',
      },
    });
    expect(rejected.ok).toBe(false);
    const after = readPersistedPreferences(userDataDir);
    expect(after.handoffSummaryModel).toBe(SAVED_HANDOFF_MODEL);
    for (const key of [
      'summaryModel',
      'summaryThinkingLevel',
      'worktreeSummaryModel',
      'worktreeSummaryThinkingLevel',
    ])
      expect(after[key]).toEqual(before[key]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

function readPersistedPreferences(userDataDir) {
  return JSON.parse(
    readFileSync(path.join(userDataDir, 'preferences.json'), 'utf8'),
  ).preferences;
}

/** The `SettingsRow` that owns the model controls labelled `title`. */
function modelRow(chatTab, title) {
  return chatTab.getByText(title, { exact: true }).locator('../../..');
}

async function openChatSettings(electronApp) {
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openSettings();
  await app.openSettingsSection('chat');
  const chatTab = window.getByTestId('settings-tab-chat');
  for (const [title, description] of ROWS) {
    const row = modelRow(chatTab, title);
    await expect(row).toBeVisible();
    await expect(row).toContainText(description);
  }
  await expect(chatTab).not.toContainText('Chat description model');
  return chatTab;
}

/** Model and thinking values shown by the two pre-existing summary rows. */
async function otherSummaryRowValues(chatTab) {
  const values = [];
  for (const title of ['Chat title model', 'Worktree activity summary model']) {
    const selects = modelRow(chatTab, title).locator('select');
    values.push([
      await selects.nth(0).inputValue(),
      await selects.nth(1).inputValue(),
    ]);
  }
  return values;
}

test('saves the conversation handoff model independently and keeps it after relaunch', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-handoff-model-settings-'),
  );
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    let chatTab = await openChatSettings(electronApp);
    const handoffModel = chatTab.getByTestId(HANDOFF_MODEL);
    await expect(handoffModel).toHaveValue('haiku');
    await expect(chatTab.getByTestId(HANDOFF_THINKING)).toHaveValue('off');
    const otherRowsBefore = await otherSummaryRowValues(chatTab);
    const persistedBefore = readPersistedPreferences(userDataDir);

    await handoffModel.selectOption(SAVED_HANDOFF_MODEL);
    await chatTab
      .getByTestId(HANDOFF_THINKING)
      .selectOption(SAVED_HANDOFF_THINKING);
    await expect
      .poll(() => {
        const saved = readPersistedPreferences(userDataDir);
        return [saved.handoffSummaryModel, saved.handoffSummaryThinkingLevel];
      })
      .toEqual([SAVED_HANDOFF_MODEL, SAVED_HANDOFF_THINKING]);
    const persistedAfter = readPersistedPreferences(userDataDir);
    for (const key of [
      'summaryModel',
      'summaryThinkingLevel',
      'worktreeSummaryModel',
      'worktreeSummaryThinkingLevel',
    ]) {
      expect(persistedAfter[key], key).toEqual(persistedBefore[key]);
    }
    expect(await otherSummaryRowValues(chatTab)).toEqual(otherRowsBefore);

    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = undefined;

    ({ electronApp } = await launchCanopy({ userDataDir }));
    chatTab = await openChatSettings(electronApp);
    await expect(chatTab.getByTestId(HANDOFF_MODEL)).toHaveValue(
      SAVED_HANDOFF_MODEL,
    );
    await expect(chatTab.getByTestId(HANDOFF_THINKING)).toHaveValue(
      SAVED_HANDOFF_THINKING,
    );
    expect(await otherSummaryRowValues(chatTab)).toEqual(otherRowsBefore);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
  }
});
