import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { evaluateWithSyntheticIpcEvent } from './syntheticIpcEvent.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_TAB_ID = 'selection-chat-tab';
const OTHER_CHAT_TAB_ID = 'selection-other-chat-tab';
const FILE_TAB_ID = 'selection-file-tab';
const FILE_NAME = 'SELECTION_SOURCE.txt';
const FILE_CONTENT =
  'alpha line one\n' +
  'beta line two\n' +
  'gamma line three\n' +
  'delta line four\n' +
  'epsilon line five\n';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const GO_TO_START =
  process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home';

test('a follow-up draft does not inherit a pending send selection', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-selection-send-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath).toBeTruthy();
  const filePath = path.join(worktreePath, FILE_NAME);
  writeFileSync(filePath, FILE_CONTENT, 'utf8');
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: FILE_TAB_ID,
    lastActiveEditableChatId: CHAT_TAB_ID,
    tabs: [
      { id: CHAT_TAB_ID, title: 'Chat' },
      {
        id: FILE_TAB_ID,
        title: FILE_NAME,
        kind: 'file',
        filePath,
        fileViewMode: 'raw',
        description: filePath,
        messages: [],
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
    const fileEditor = window.getByTestId('monaco-file-editor');
    await expect(fileEditor).toContainText('alpha line one');
    await fileEditor.click();
    await window.keyboard.press(GO_TO_START);
    await window.keyboard.press('Shift+ArrowDown');
    await window.keyboard.press('Shift+End');
    await window.keyboard.press(`${MOD}+l`);
    await window.getByTestId(`panel-tab-panel-chat-${CHAT_TAB_ID}`).click();
    await expect(window.getByTestId('selection-context-chip')).toHaveCount(1);
    const editor = window.locator('[data-slate-editor="true"]:visible').first();
    await evaluateWithSyntheticIpcEvent(
      electronApp,
      async ({ ipcMain }, { event }) => {
        const { sender } = event;
        const snapshot = await ipcMain._invokeHandlers.get('chat:get-state')(
          event,
          { projectId: 'demo-ts-pnpm-vite', worktreeId: 'demo-main' },
        );
        sender.send('chat:state-changed', {
          projectId: snapshot.projectId,
          worktreeId: snapshot.worktreeId,
          schemaVersion: 1,
          eventId: 'selection-send-streaming',
          occurredAt: new Date().toISOString(),
          baseRevision: snapshot.revision,
          revision: snapshot.revision + 1,
          changes: [
            {
              type: 'runtime.patched',
              chatId: 'selection-chat-tab',
              runtime: { status: 'streaming', queuedMessageIds: [] },
            },
          ],
        });
        globalThis.__selectionSendRequests = [];
        ipcMain.removeHandler('chat:send-message');
        ipcMain.handle('chat:send-message', async (_event, request) => {
          globalThis.__selectionSendRequests.push(request);
          if (globalThis.__selectionSendRequests.length === 1) {
            await new Promise((resolve) => {
              globalThis.__releaseSelectionSend = resolve;
            });
          }
          return {};
        });
      },
    );
    await expect(window.getByTestId('chat-stop-generation')).toBeVisible();
    await editor.fill('First selection draft');
    await editor.press('Enter');
    await expect
      .poll(() =>
        electronApp.evaluate(() => globalThis.__selectionSendRequests.length),
      )
      .toBe(1);
    await editor.fill('Second plain draft');
    await editor.press('Enter');
    await expect
      .poll(() =>
        electronApp.evaluate(() => globalThis.__selectionSendRequests.length),
      )
      .toBe(2);
    const requests = await electronApp.evaluate(
      () => globalThis.__selectionSendRequests,
    );
    expect(requests[0].text).toContain('alpha line one');
    expect(requests[1].text).not.toContain('alpha line one');
  } finally {
    await electronApp
      .evaluate(() => globalThis.__releaseSelectionSend?.())
      .catch(() => {});
    await closeCanopy(electronApp, userDataDir);
  }
});

/**
 * CAN-1250 — highlight text in the Monaco file editor and send it to the chat
 * composer as staged context chips: floating pill + ⌘/Ctrl+L capture (while
 * the composer is hidden behind the same panel leaf), duplicate suppression,
 * untouched draft, chip reveal flash, live staleness against the shared file
 * session, and keyboard/mouse chip removal.
 */
test('editor selection to composer: capture, dedupe, reveal, staleness, removal', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-editor-selection-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();

  const filePath = path.join(worktreePath, FILE_NAME);
  writeFileSync(filePath, FILE_CONTENT, 'utf8');

  // Two chat tabs plus the active file tab. The intended target is not the
  // last chat in persistent tab order, proving capture follows explicit
  // activation history rather than array order.
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: FILE_TAB_ID,
    lastActiveEditableChatId: CHAT_TAB_ID,
    tabs: [
      { id: CHAT_TAB_ID, title: 'Chat' },
      { id: OTHER_CHAT_TAB_ID, title: 'Other chat' },
      {
        id: FILE_TAB_ID,
        title: FILE_NAME,
        kind: 'file',
        filePath,
        fileViewMode: 'raw',
        description: filePath,
        messages: [],
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

    const editor = window.getByTestId('monaco-file-editor');
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await expect(editor).toContainText('alpha line one', { timeout: 20_000 });

    const chips = window.getByTestId('selection-context-chip');

    // --- Keyboard capture: select lines 1-2, then press ⌘L ----------------
    await editor.click();
    await window.keyboard.press(GO_TO_START);
    await window.keyboard.press('Shift+ArrowDown');
    await window.keyboard.press('Shift+End');
    await window.keyboard.press(`${MOD}+l`);
    // A successful capture flashes visible feedback at the pill position — the
    // composer is hidden behind this panel leaf, so without it the capture
    // reads as a silent no-op.
    await expect(
      window.getByTestId('editor-selection-added-confirmation'),
    ).toBeVisible();
    // Repeating the shortcut with the identical selection must not stack a
    // duplicate chip (asserted as exactly two chips after the second capture).
    await window.keyboard.press(`${MOD}+l`);

    // --- Extended keyboard capture becomes a second chip --------------------
    await window.keyboard.press('Shift+ArrowDown');
    await window.keyboard.press(`${MOD}+l`);

    // --- Switch to the chat tab: chips are staged on the composer -----------
    await window.getByTestId(`panel-tab-panel-chat-${CHAT_TAB_ID}`).click();
    const composer = window
      .locator('[data-chat-textarea][contenteditable="true"]')
      .last();
    await expect(composer).toBeVisible({ timeout: 20_000 });
    await expect(chips).toHaveCount(2);
    await expect(chips.first()).toContainText(`${FILE_NAME}:1-2`);
    await expect(chips.nth(1)).toContainText(`${FILE_NAME}:1-3`);

    // The draft itself is never touched — selections ride as chips only.
    await expect(composer).not.toContainText('alpha line one');

    // --- Keyboard-only removal: focus the chip, press Delete ----------------
    await chips.nth(1).focus();
    await window.keyboard.press('Delete');
    await expect(chips).toHaveCount(1);

    // --- Chip activation reveals the range with a flash decoration ----------
    await chips.first().click();
    await expect(editor).toBeVisible({ timeout: 10_000 });
    await expect(
      window.locator('.canopy-editor-reveal-flash').first(),
    ).toBeVisible({ timeout: 3_000 });
    // Focusing and clicking the chip can restart the flash. Every decoration
    // from both reveals must still be removed when the latest flash expires;
    // loaded runners can delay the renderer timer beyond its nominal 1.6s.
    await expect(window.locator('.canopy-editor-reveal-flash')).toHaveCount(0, {
      timeout: 10_000,
    });

    // --- Staleness: editing inside the captured range flips the chip --------
    await editor.click();
    await window.keyboard.press(GO_TO_START);
    await window.keyboard.press('Shift+End');
    await window.keyboard.type('REPLACED');

    await window.getByTestId(`panel-tab-panel-chat-${CHAT_TAB_ID}`).click();
    await expect(chips).toHaveCount(1);
    await expect(
      window.getByTestId('selection-context-chip-stale'),
    ).toHaveCount(1, { timeout: 10_000 });

    // --- Mouse removal: the X button clears the last chip and the row -------
    await chips.first().hover();
    await window.getByTestId('selection-context-chip-remove').first().click();
    await expect(chips).toHaveCount(0);
    await expect(window.getByTestId('selection-context-chips')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

/**
 * Regression (CAN-1250 follow-up): chats files persisted before
 * `lastActiveEditableChatId` existed have no remembered composer target. With
 * a file tab active and MULTIPLE chat tabs (the load-time fallback only covers
 * exactly one), capture must still stage on the first editable chat tab
 * instead of silently doing nothing.
 */
test('editor selection capture works without a remembered composer target', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-editor-selection-legacy-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();

  const filePath = path.join(worktreePath, FILE_NAME);
  writeFileSync(filePath, FILE_CONTENT, 'utf8');

  // Deliberately NO lastActiveEditableChatId: this mirrors a legacy persisted
  // file. Two chat tabs keep the loader's single-editable-tab fallback out of
  // play, so the runtime fallback is what's under test.
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: FILE_TAB_ID,
    tabs: [
      { id: CHAT_TAB_ID, title: 'Chat' },
      { id: OTHER_CHAT_TAB_ID, title: 'Other chat' },
      {
        id: FILE_TAB_ID,
        title: FILE_NAME,
        kind: 'file',
        filePath,
        fileViewMode: 'raw',
        description: filePath,
        messages: [],
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

    const editor = window.getByTestId('monaco-file-editor');
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await expect(editor).toContainText('alpha line one', { timeout: 20_000 });

    await editor.click();
    await window.keyboard.press(GO_TO_START);
    await window.keyboard.press('Shift+ArrowDown');
    await window.keyboard.press('Shift+End');
    await window.keyboard.press(`${MOD}+l`);
    // The confirmation names its destination chat and clicking it jumps
    // there — the chip lands on the FIRST editable chat tab (deterministic
    // fallback when nothing is remembered).
    const confirmation = window.getByTestId(
      'editor-selection-added-confirmation',
    );
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toContainText('Added to chat');
    await confirmation.click();

    const composer = window
      .locator('[data-chat-textarea][contenteditable="true"]')
      .last();
    await expect(composer).toBeVisible({ timeout: 20_000 });
    const chips = window.getByTestId('selection-context-chip');
    await expect(chips).toHaveCount(1);
    await expect(chips.first()).toContainText(`${FILE_NAME}:1-2`);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
