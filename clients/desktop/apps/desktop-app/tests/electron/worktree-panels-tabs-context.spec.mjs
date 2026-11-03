// Tab context menu + pinned tabs (restored VS Code behavior). Right-clicking a
// panel tab opens a menu (pin/unpin, split, new window/full screen, close,
// close others/right/left/all).
// Pinning moves the tab into a SEPARATE pinned scroll strip
// (`.canopy-panel-tab-strip-wrap-pinned`, `data-pinned="true"`), and bulk
// "Close *" actions never touch pinned tabs.
//
// This exercises the generic panel menu for ANY panel kind: it stacks the two
// default-layout-available singleton kinds (file-explorer, browser) onto the
// chat group, pins one, and drives the menu's close/enablement semantics.
// A chat tab moved to a new window keeps the menu's "Mark as unread" /
// "Mark as read" (CAN-4378); chat-tab-mark-unread.spec.mjs covers the main grid.

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { readChatStorageIndexes } from './readChatStorage.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import {
  collectLeaves,
  DEFAULT_GROUP_IDS,
  getActiveGroupId,
  getLayout,
  seedPanelWorktree,
} from './panelHarness.mjs';

async function chatGroupPanels(window) {
  const layout = await getLayout(window);
  const leaf = collectLeaves(layout.root).find(
    (node) => node.groupId === DEFAULT_GROUP_IDS.chat,
  );
  return leaf ? leaf.panels : [];
}

async function addPanelToChatGroup(window, kind) {
  await window.getByTestId('panel-add-tab-group-chat').click();
  const addMenu = window.getByTestId('panel-add-menu');
  await expect(addMenu).toBeVisible();
  await window.getByTestId(`panel-add-menu-item-${kind}`).click();
  await expect(addMenu).toBeHidden();
}

test('tab context menu moves one tab to a new window and restores its original group', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window } = await seedPanelWorktree();

  try {
    await addPanelToChatGroup(window, 'file-explorer');
    const before = await chatGroupPanels(window);
    expect(before.map((panel) => panel.kind)).toEqual([
      'chat',
      'file-explorer',
    ]);
    const explorerPanelId = before.find(
      (panel) => panel.kind === 'file-explorer',
    ).panelId;

    const auxWindowPromise = electronApp.waitForEvent('window');
    await window
      .getByTestId(`panel-tab-${explorerPanelId}`)
      .click({ button: 'right' });
    await expect(
      window.getByTestId('panel-tab-context-new-window'),
    ).toBeVisible();
    await window.getByTestId('panel-tab-context-new-window').click();
    const aux = await auxWindowPromise;

    await expect(aux.getByTestId('panel-aux-window-root')).toBeVisible();
    await expect(aux.getByTestId('panel-aux-window-root')).toHaveAttribute(
      'data-source-group-id',
      DEFAULT_GROUP_IDS.chat,
    );
    await expect(aux.getByTestId(`panel-tab-${explorerPanelId}`)).toBeVisible();
    await expect(
      window.getByTestId(`panel-tab-${explorerPanelId}`),
    ).toHaveCount(0);
    expect((await chatGroupPanels(window)).map((panel) => panel.kind)).toEqual([
      'chat',
    ]);

    await aux
      .getByTestId('panel-aux-window-merge-back')
      .click()
      .catch((error) => {
        if (!String(error).includes('has been closed')) {
          throw error;
        }
      });
    await expect.poll(() => aux.isClosed()).toBe(true);

    await expect
      .poll(async () =>
        (await chatGroupPanels(window)).map((panel) => panel.panelId),
      )
      .toEqual(before.map((panel) => panel.panelId));
    await expect(
      window
        .getByTestId(`panel-group-${DEFAULT_GROUP_IDS.chat}`)
        .getByTestId(`panel-tab-${explorerPanelId}`),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('tab context menu pins a tab into its own strip and drives the close actions', async ({}, testInfo) => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();

  try {
    // --- Stack two more tabs onto the chat group (3 tabs total) ------------
    await addPanelToChatGroup(window, 'file-explorer');
    await addPanelToChatGroup(window, 'browser');

    let panels = await chatGroupPanels(window);
    expect(panels.map((p) => p.kind)).toEqual([
      'chat',
      'file-explorer',
      'browser',
    ]);
    const explorerPanelId = panels.find(
      (p) => p.kind === 'file-explorer',
    ).panelId;
    const browserPanelId = panels.find((p) => p.kind === 'browser').panelId;
    const chatPanelId = panels.find((p) => p.kind === 'chat').panelId;

    const explorerTab = window.getByTestId(`panel-tab-${explorerPanelId}`);
    const browserTab = window.getByTestId(`panel-tab-${browserPanelId}`);
    const chatTab = window.getByTestId(`panel-tab-${chatPanelId}`);

    // --- Right-click opens the context menu --------------------------------
    await explorerTab.click({ button: 'right' });
    const menu = window.getByTestId('panel-tab-context-menu');
    await expect(menu).toBeVisible();
    await expect(window.getByTestId('panel-tab-context-pin')).toBeVisible();

    // --- Pin: the tab moves into the pinned strip --------------------------
    await window.getByTestId('panel-tab-context-pin').click();
    await expect(menu).toBeHidden();
    await expect(explorerTab).toHaveAttribute('data-pinned', 'true');
    // The pinned tab now lives inside the dedicated pinned strip wrapper.
    await expect(
      window.locator(
        `.canopy-panel-tab-strip-wrap-pinned [data-testid="panel-tab-${explorerPanelId}"]`,
      ),
    ).toHaveCount(1);
    // Store order: pinned tab is first.
    panels = await chatGroupPanels(window);
    expect(panels[0].panelId).toBe(explorerPanelId);
    expect(panels[0].pinned).toBe(true);

    // Pinned state survives an in-session reselect (switch away and back).
    await browserTab.click();
    await explorerTab.click();
    await expect(explorerTab).toHaveAttribute('data-pinned', 'true');

    // --- Close Others (from the chat tab) keeps pinned + clicked -----------
    // Close Others is driven from the CHAT tab so it closes the unpinned
    // singleton (browser) and leaves the pinned explorer plus the clicked
    // chat. (Bulk-closing the chat panel itself would be re-materialized by
    // the chat ⇄ panel sync bridge, which is orthogonal to this feature.)
    await chatTab.click({ button: 'right' });
    await expect(menu).toBeVisible();
    await window.getByTestId('panel-tab-context-close-others').click();
    await expect(menu).toBeHidden();
    // browser (unpinned, not clicked) is closed; explorer (pinned) + chat stay.
    await expect(browserTab).toHaveCount(0);
    await expect(explorerTab).toHaveCount(1);
    await expect(chatTab).toHaveCount(1);
    panels = await chatGroupPanels(window);
    expect(panels.map((p) => p.panelId).sort()).toEqual(
      [explorerPanelId, chatPanelId].sort(),
    );
    // The pinned explorer still leads the array.
    expect(panels[0].panelId).toBe(explorerPanelId);
    expect(panels[0].pinned).toBe(true);

    // --- Close to the Right / Left disabled at the ends --------------------
    // chat is now the sole unpinned tab: nothing unpinned to its left/right
    // (the pinned explorer is excluded from bulk closes).
    await chatTab.click({ button: 'right' });
    await expect(menu).toBeVisible();
    await expect(
      window.getByTestId('panel-tab-context-close-right'),
    ).toBeDisabled();
    await expect(
      window.getByTestId('panel-tab-context-close-left'),
    ).toBeDisabled();
    await window.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    await window.screenshot({
      path: testInfo.outputPath('worktree-panels-tabs-context.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('tab context menu split actions move the clicked tab into a new group', async ({}, testInfo) => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();

  try {
    // Stack one singleton panel onto the chat group so the split action is
    // enabled; splitting the sole tab out of a group would leave it empty.
    await addPanelToChatGroup(window, 'file-explorer');

    const before = await chatGroupPanels(window);
    expect(before.map((p) => p.kind)).toEqual(['chat', 'file-explorer']);
    const chatPanelId = before.find((p) => p.kind === 'chat').panelId;
    const explorerPanelId = before.find(
      (p) => p.kind === 'file-explorer',
    ).panelId;

    await window
      .getByTestId(`panel-tab-${explorerPanelId}`)
      .click({ button: 'right' });
    const menu = window.getByTestId('panel-tab-context-menu');
    await expect(menu).toBeVisible();
    await expect(
      window.getByTestId('panel-tab-context-split-right'),
    ).toBeEnabled();

    await window.getByTestId('panel-tab-context-split-right').click();
    await expect(menu).toBeHidden();

    await expect
      .poll(async () => collectLeaves((await getLayout(window)).root).length)
      .toBe(4);

    const layout = await getLayout(window);
    const leaves = collectLeaves(layout.root);
    const chatLeaf = leaves.find(
      (leaf) => leaf.groupId === DEFAULT_GROUP_IDS.chat,
    );
    expect(chatLeaf).toMatchObject({
      panels: [{ panelId: chatPanelId, kind: 'chat' }],
    });

    const movedLeaf = leaves.find((leaf) =>
      leaf.panels.some((panel) => panel.panelId === explorerPanelId),
    );
    expect(movedLeaf).toBeTruthy();
    expect(movedLeaf.groupId).not.toBe(DEFAULT_GROUP_IDS.chat);
    expect(movedLeaf).toMatchObject({
      panels: [{ panelId: explorerPanelId, kind: 'file-explorer' }],
      activePanelId: explorerPanelId,
    });
    expect(await getActiveGroupId(window)).toBe(movedLeaf.groupId);

    await expect(
      window
        .getByTestId(`panel-group-${movedLeaf.groupId}`)
        .getByTestId(`panel-tab-${explorerPanelId}`),
    ).toBeVisible();
    await expect(
      window
        .getByTestId(`panel-group-${DEFAULT_GROUP_IDS.chat}`)
        .getByTestId(`panel-tab-${explorerPanelId}`),
    ).toHaveCount(0);

    await window.screenshot({
      path: testInfo.outputPath('worktree-panels-tabs-context-split.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('tab context menu Full screen selects the clicked tab and maximizes its group', async ({}, testInfo) => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();

  try {
    await addPanelToChatGroup(window, 'file-explorer');
    const before = await chatGroupPanels(window);
    const chatPanelId = before.find((p) => p.kind === 'chat').panelId;
    const explorerPanelId = before.find(
      (p) => p.kind === 'file-explorer',
    ).panelId;

    // Leave the chat tab active so Full screen must also select the clicked
    // (inactive) explorer tab.
    await window.getByTestId(`panel-tab-${chatPanelId}`).click();

    await window
      .getByTestId(`panel-tab-${explorerPanelId}`)
      .click({ button: 'right' });
    const menu = window.getByTestId('panel-tab-context-menu');
    await expect(menu).toBeVisible();

    // Same layout as the group overflow menu: splits, divider, New Window +
    // Full screen, divider. The close actions are the menu's last group, as
    // removal rows are in every action menu.
    const itemOrder = await menu.evaluate((node) =>
      Array.from(
        node.querySelectorAll(
          '[role="menuitem"], [role="menuitemradio"], [role="separator"]',
        ),
      ).map((child) =>
        child.getAttribute('role') === 'separator'
          ? '---'
          : child.getAttribute('data-testid'),
      ),
    );
    const splitRightIndex = itemOrder.indexOf('panel-tab-context-split-right');
    expect(itemOrder.slice(splitRightIndex, splitRightIndex + 5)).toEqual([
      'panel-tab-context-split-right',
      '---',
      'panel-tab-context-new-window',
      'panel-tab-context-full-screen',
      '---',
    ]);
    expect(itemOrder.slice(-6)).toEqual([
      '---',
      'panel-tab-context-close',
      'panel-tab-context-close-others',
      'panel-tab-context-close-right',
      'panel-tab-context-close-left',
      'panel-tab-context-close-all',
    ]);

    const fullScreen = window.getByTestId('panel-tab-context-full-screen');
    await expect(fullScreen).toHaveText('Full screen');
    await expect(fullScreen).toBeEnabled();
    await fullScreen.click();
    await expect(menu).toBeHidden();

    await expect(
      window.getByTestId(`panel-group-restore-${DEFAULT_GROUP_IDS.chat}`),
    ).toBeVisible();
    await expect(
      window.getByTestId(`panel-group-${DEFAULT_GROUP_IDS.terminal}`),
    ).toBeHidden();
    const leaves = collectLeaves((await getLayout(window)).root);
    const chatLeaf = leaves.find(
      (leaf) => leaf.groupId === DEFAULT_GROUP_IDS.chat,
    );
    expect(chatLeaf.maximized).toBe(true);
    expect(chatLeaf.activePanelId).toBe(explorerPanelId);
    expect(await getActiveGroupId(window)).toBe(DEFAULT_GROUP_IDS.chat);

    // While maximized the item is hidden, as in the group overflow menu.
    await window
      .getByTestId(`panel-tab-${explorerPanelId}`)
      .click({ button: 'right' });
    await expect(menu).toBeVisible();
    await expect(
      window.getByTestId('panel-tab-context-new-window'),
    ).toBeVisible();
    await expect(
      window.getByTestId('panel-tab-context-full-screen'),
    ).toHaveCount(0);
    await window.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    await window.screenshot({
      path: testInfo.outputPath('worktree-panels-tabs-context-full-screen.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('tab context menu marks a chat in a new window unread and read again', async () => {
  test.setTimeout(120_000);
  const workspaceId = 'demo-ts-pnpm-vite';
  const worktreeId = 'demo-main';
  const poppedChat = 'popped-chat';
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-panels-aux-unread-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId,
    worktreeId,
    activeTabId: 'staying-chat',
    tabs: [
      { id: 'staying-chat', title: 'Staying' },
      { id: poppedChat, title: 'Popped' },
    ],
  });
  const durableTab = () =>
    readChatStorageIndexes(
      path.join(userDataDir, 'workspaces', workspaceId),
      worktreeId,
    ).live.tabs.find((tab) => tab.id === poppedChat);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(worktreeId);
    const row = window.locator(
      `[data-testid="worktree-row"][data-branch="${worktreeId}"]`,
    );
    const tabTestId = `panel-tab-panel-chat-${poppedChat}`;
    await expect(window.getByTestId(tabTestId)).toBeVisible();

    const auxWindowPromise = electronApp.waitForEvent('window');
    await window.getByTestId(tabTestId).click({ button: 'right' });
    await window.getByTestId('panel-tab-context-new-window').click();
    const aux = await auxWindowPromise;
    await expect(aux.getByTestId('panel-aux-window-root')).toBeVisible();
    await expect(aux.getByTestId(tabTestId)).toBeVisible();

    const menu = aux.getByTestId('panel-tab-context-menu');
    await aux.getByTestId(tabTestId).click({ button: 'right' });
    await expect(menu).toBeVisible();
    await expect(aux.getByTestId('panel-tab-context-mark-read')).toHaveCount(0);
    await aux.getByTestId('panel-tab-context-mark-unread').click();
    await expect(menu).toBeHidden();

    // The pop-out tab shows it, and so does the main window's sidebar.
    await expect(
      aux.getByTestId(`panel-tab-unread-${poppedChat}`),
    ).toBeVisible();
    await expect(row.getByTestId('worktree-row-unread')).toBeVisible();
    await expect
      .poll(durableTab)
      .toMatchObject({ unread: true, unreadMarkedManually: true });

    await aux.getByTestId(tabTestId).click({ button: 'right' });
    await expect(menu).toBeVisible();
    await expect(aux.getByTestId('panel-tab-context-mark-unread')).toHaveCount(
      0,
    );
    await aux.getByTestId('panel-tab-context-mark-read').click();
    await expect(menu).toBeHidden();

    await expect(aux.getByTestId(`panel-tab-unread-${poppedChat}`)).toHaveCount(
      0,
    );
    await expect(row.getByTestId('worktree-row-unread')).toHaveCount(0);
    await expect.poll(() => durableTab()?.unread).toBe(false);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
