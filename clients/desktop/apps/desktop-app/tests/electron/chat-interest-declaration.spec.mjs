// Chat interest declaration (foreground-first streaming, phase 02): the main
// window declares the chats it shows (focused) and showed recently (warm) on
// `chat:set-interest`, and main records it per window. Nothing filters on it
// yet, so this spec reads the record through the E2E-only main-process hook
// `globalThis.__CANOPY_E2E_CHAT_INTEREST__.list()`.
//
// Flow under test:
//   1. two chats of one worktree split side by side are both focused;
//   2. selecting another worktree focuses its chat and keeps the split's
//      chats warm; leaving the Code page focuses nothing;
//   3. a chat pulled out into its own window stays focused while the opener
//      shows another worktree or another page;
//   4. closing the pulled-out window moves that chat to warm.
//
// Declarations are coalesced to animation frames and cross IPC, so every read
// polls.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, getMainWindow, launchCanopy } from './launchCanopy.mjs';
import {
  collectLeaves,
  getLayout,
  movePanelViaApi,
  waitForPanelLayout,
} from './panelHarness.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const OTHER_WORKSPACE_ID = 'demo-ts-npm-next';
const WORKTREE_ID = 'demo-main';
const CHAT_GROUP_ID = 'group-chat';

/** Seeds two worktrees: one with chats `chat-a` and `chat-b`, one with `chat-c`. */
function seedInterestFixture() {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-chat-interest-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite', 'ts-npm-next'],
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [
      { id: 'chat-a', title: 'Chat A' },
      { id: 'chat-b', title: 'Chat B' },
    ],
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: OTHER_WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 'chat-c', title: 'Chat C' }],
  });
  // Advanced layout mode, as the panel harness seeds: chats may leave the
  // chat group.
  const worktreeDataDir = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'worktree-data',
    WORKTREE_ID,
  );
  mkdirSync(worktreeDataDir, { recursive: true });
  writeFileSync(
    path.join(worktreeDataDir, 'panel-layout-mode.json'),
    JSON.stringify({ version: 1, mode: 'advanced' }),
    'utf8',
  );
  return userDataDir;
}

function worktreeRow(window, workspaceId) {
  return window.locator(
    `[data-testid="worktree-row"][data-project-id="${workspaceId}"][data-worktree-id="${WORKTREE_ID}"]`,
  );
}

async function selectWorktreeOf(window, workspaceId) {
  await worktreeRow(window, workspaceId).click();
  await expect(window.getByTestId('panel-grid-root')).toBeVisible();
}

/** The webContents id main records `page`'s interest under. */
async function webContentsIdOf(electronApp, page) {
  const browserWindow = await electronApp.browserWindow(page);
  return browserWindow.evaluate((win) => win.webContents.id);
}

/**
 * The interest main recorded for `webContentsId`, as chat ids (`focused`
 * sorted, `warm` in declared order), or `null` when none is recorded.
 */
async function recordedInterest(electronApp, webContentsId) {
  const interest = await electronApp.evaluate((_electron, id) => {
    const hook = globalThis.__CANOPY_E2E_CHAT_INTEREST__;
    if (!hook) throw new Error('__CANOPY_E2E_CHAT_INTEREST__ is not installed');
    return hook.list().find((entry) => entry.webContentsId === id)?.interest;
  }, webContentsId);
  if (!interest) return null;
  return {
    focused: interest.focused.map((ref) => ref.chatId).sort(),
    warm: interest.warm.map((ref) => ref.chatId),
    hasFocusedRuns: interest.focusedRuns !== undefined,
  };
}

/** Panel ids per group of the selected worktree's main layout. */
async function groupOfPanel(window, panelId) {
  const layout = await getLayout(window);
  const leaf = collectLeaves(layout?.root).find((candidate) =>
    candidate.panels.some((panel) => panel.panelId === panelId),
  );
  return leaf?.groupId ?? null;
}

test('declares split, switched, pulled-out and closed chats', async () => {
  test.setTimeout(180_000);
  const userDataDir = seedInterestFixture();
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await getMainWindow(electronApp);
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await selectWorktreeOf(window, WORKSPACE_ID);
    await waitForPanelLayout(window, { requiredGroupIds: [CHAT_GROUP_ID] });
    await expect
      .poll(async () => groupOfPanel(window, 'panel-chat-chat-b'), {
        timeout: 15_000,
      })
      .toBe(CHAT_GROUP_ID);
    const mainId = await webContentsIdOf(electronApp, window);

    // --- 1. Two chats split side by side are both focused ----------------
    await movePanelViaApi(window, 'panel-chat-chat-b', CHAT_GROUP_ID, 'right');
    await expect
      .poll(async () => groupOfPanel(window, 'panel-chat-chat-b'))
      .not.toBe(CHAT_GROUP_ID);
    await expect
      .poll(async () => (await recordedInterest(electronApp, mainId))?.focused)
      .toEqual(['chat-a', 'chat-b']);
    expect((await recordedInterest(electronApp, mainId))?.hasFocusedRuns).toBe(
      false,
    );

    // --- 2. Another worktree, then another page -----------------------------
    await selectWorktreeOf(window, OTHER_WORKSPACE_ID);
    await expect
      .poll(async () => recordedInterest(electronApp, mainId))
      .toMatchObject({ focused: ['chat-c'] });
    expect(
      [...((await recordedInterest(electronApp, mainId))?.warm ?? [])].sort(),
    ).toEqual(['chat-a', 'chat-b']);

    await app.openOverviewPage();
    await expect
      .poll(async () => recordedInterest(electronApp, mainId))
      .toMatchObject({ focused: [] });
    expect((await recordedInterest(electronApp, mainId))?.warm[0]).toBe(
      'chat-c',
    );

    await app.openMainPage();
    await expect
      .poll(async () => (await recordedInterest(electronApp, mainId))?.focused)
      .toEqual(['chat-c']);

    // --- 3. A pulled-out chat stays focused anywhere -------------------------
    await selectWorktreeOf(window, WORKSPACE_ID);
    await expect
      .poll(async () => (await recordedInterest(electronApp, mainId))?.focused)
      .toEqual(['chat-a', 'chat-b']);
    const chatBGroupId = await groupOfPanel(window, 'panel-chat-chat-b');
    expect(chatBGroupId).toBeTruthy();
    const auxWindowPromise = electronApp.waitForEvent('window');
    await window.getByTestId(`panel-group-menu-${chatBGroupId}`).click();
    await window.getByTestId(`panel-group-pop-out-${chatBGroupId}`).click();
    const aux = await auxWindowPromise;
    await expect(aux.getByTestId('panel-aux-window-root')).toBeVisible();

    await selectWorktreeOf(window, OTHER_WORKSPACE_ID);
    await expect
      .poll(async () => (await recordedInterest(electronApp, mainId))?.focused)
      .toEqual(['chat-b', 'chat-c']);
    await app.openOverviewPage();
    await expect
      .poll(async () => (await recordedInterest(electronApp, mainId))?.focused)
      .toEqual(['chat-b']);

    // --- 4. Closing the pull-out moves its chat to warm ----------------------
    // Merge-back closes this window, which can reject the click itself.
    await aux
      .getByTestId('panel-aux-window-merge-back')
      .click()
      .catch((error) => {
        if (!aux.isClosed()) throw error;
      });
    await expect.poll(() => aux.isClosed()).toBe(true);
    await expect
      .poll(async () => recordedInterest(electronApp, mainId))
      .toMatchObject({ focused: [] });
    expect((await recordedInterest(electronApp, mainId))?.warm[0]).toBe(
      'chat-b',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
