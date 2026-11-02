// Chat-tab selection ordering regression.
//
// A tab click is painted optimistically while its main-owned activation
// command is in flight. This spec injects the contiguous commit for the prior
// tab in the same renderer task as the real click, then verifies that the
// delayed commit cannot repaint the old tab while main durably selects the new
// one. The workspace, tabs, and injected event are all local and deterministic.
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver, closePanelTab } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const PRIOR_CHAT_ID = 'selection-prior';
const TARGET_CHAT_ID = 'selection-target';
const THIRD_CHAT_ID = 'selection-third';

async function launchSelectionFixture(tabs, activeTabId) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-chat-tab-selection-ordering-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId,
    tabs,
  });
  const launched = await launchCanopy({ userDataDir });
  const window = await launched.electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  await expect
    .poll(() => window.evaluate(() => Boolean(window.__canopyPanelTestApi)), {
      timeout: 15_000,
    })
    .toBe(true);
  return { app, launched, userDataDir, window };
}

test('delayed tab state cannot revert a newer selection or resurrect a close', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-chat-tab-selection-ordering-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: PRIOR_CHAT_ID,
    tabs: [
      { id: PRIOR_CHAT_ID, title: 'Previous chat' },
      { id: TARGET_CHAT_ID, title: 'Selected chat' },
    ],
  });

  const launched = await launchCanopy({ userDataDir });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const priorTab = window.getByTestId(
      `panel-tab-panel-chat-${PRIOR_CHAT_ID}`,
    );
    const targetTab = window.getByTestId(
      `panel-tab-panel-chat-${TARGET_CHAT_ID}`,
    );
    await expect(priorTab).toHaveAttribute('data-active', 'true', {
      timeout: 15_000,
    });
    await expect(targetTab).toBeVisible();
    await expect
      .poll(() => window.evaluate(() => Boolean(window.__canopyPanelTestApi)), {
        timeout: 15_000,
      })
      .toBe(true);

    // Keep the real DOM interaction and the delayed canonical delivery in one
    // renderer task. Main cannot answer the activation command between them,
    // which deterministically reproduces the high-load ordering window.
    await window.evaluate(
      ([targetChatId, priorChatId]) => {
        const target = document.querySelector(
          `[data-testid="panel-tab-panel-chat-${targetChatId}"]`,
        );
        if (!(target instanceof HTMLElement)) {
          throw new Error('Target chat tab is not mounted');
        }
        const api = window.__canopyPanelTestApi;
        if (!api) throw new Error('__canopyPanelTestApi is not installed');
        target.click();
        api.simulateDelayedChatActivation(priorChatId);
      },
      [TARGET_CHAT_ID, PRIOR_CHAT_ID],
    );

    // The actual command still reaches main and makes the target durable.
    await expect
      .poll(
        () =>
          window.evaluate(
            ([projectId, worktreeId]) =>
              window.api.chat
                .getState({ projectId, worktreeId })
                .then((snapshot) => snapshot.tabsFile.activeTabId),
            [WORKSPACE_ID, WORKTREE_ID],
          ),
        { timeout: 15_000 },
      )
      .toBe(TARGET_CHAT_ID);

    // The visible panel must agree and remain on the user's latest click.
    await expect(targetTab).toHaveAttribute('data-active', 'true');
    await expect(priorTab).toHaveAttribute('data-active', 'false');

    // Exercise the companion regression through the real close control. The
    // unit test deterministically delivers a pre-close upsert after the
    // command result; here we verify the resulting panel lifecycle end to end.
    await closePanelTab(window, `panel-chat-${TARGET_CHAT_ID}`);
    await expect(targetTab).toHaveCount(0);
    await expect
      .poll(
        () =>
          window.evaluate(
            ([projectId, worktreeId, targetChatId]) =>
              window.api.chat
                .getState({ projectId, worktreeId })
                .then((snapshot) =>
                  snapshot.tabsFile.tabs.some((tab) => tab.id === targetChatId),
                ),
            [WORKSPACE_ID, WORKTREE_ID, TARGET_CHAT_ID],
          ),
        { timeout: 15_000 },
      )
      .toBe(false);
    await window.waitForTimeout(1_000);
    await expect(targetTab).toHaveCount(0);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('consecutive rejected selections return to the canonical active tab', async () => {
  const { launched, userDataDir, window } = await launchSelectionFixture(
    [
      { id: PRIOR_CHAT_ID, title: 'Previous chat' },
      { id: TARGET_CHAT_ID, title: 'Selected chat' },
      { id: THIRD_CHAT_ID, title: 'Third chat' },
    ],
    PRIOR_CHAT_ID,
  );
  try {
    const priorTab = window.getByTestId(
      `panel-tab-panel-chat-${PRIOR_CHAT_ID}`,
    );
    await expect(priorTab).toHaveAttribute('data-active', 'true', {
      timeout: 15_000,
    });
    await window.evaluate(async () => {
      const api = window.__canopyPanelTestApi;
      if (!api) throw new Error('__canopyPanelTestApi is not installed');
      api.holdChatCommandsAsRejected('chat.activate_tab');
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    });
    const targetTab = window.getByTestId(
      `panel-tab-panel-chat-${TARGET_CHAT_ID}`,
    );
    const thirdTab = window.getByTestId(
      `panel-tab-panel-chat-${THIRD_CHAT_ID}`,
    );
    await targetTab.click();
    await expect(targetTab).toHaveAttribute('data-active', 'true');
    await thirdTab.click();
    await expect(thirdTab).toHaveAttribute('data-active', 'true');
    await window.evaluate(() => {
      const api = window.__canopyPanelTestApi;
      if (!api) throw new Error('__canopyPanelTestApi is not installed');
      api.releaseRejectedChatCommands();
    });

    await expect(priorTab).toHaveAttribute('data-active', 'true');
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('a rejected later selection returns to a newer canonical tab', async () => {
  const { launched, userDataDir, window } = await launchSelectionFixture(
    [
      { id: PRIOR_CHAT_ID, title: 'Previous chat' },
      { id: TARGET_CHAT_ID, title: 'Selected chat' },
      { id: THIRD_CHAT_ID, title: 'Third chat' },
    ],
    PRIOR_CHAT_ID,
  );
  try {
    const targetTab = window.getByTestId(
      `panel-tab-panel-chat-${TARGET_CHAT_ID}`,
    );
    const thirdTab = window.getByTestId(
      `panel-tab-panel-chat-${THIRD_CHAT_ID}`,
    );
    await expect(
      window.getByTestId(`panel-tab-panel-chat-${PRIOR_CHAT_ID}`),
    ).toHaveAttribute('data-active', 'true', { timeout: 15_000 });
    await window.evaluate(async () => {
      const api = window.__canopyPanelTestApi;
      if (!api) throw new Error('__canopyPanelTestApi is not installed');
      api.holdChatCommandsAsRejected('chat.activate_tab');
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    });

    await targetTab.click();
    await thirdTab.click();
    await expect(thirdTab).toHaveAttribute('data-active', 'true');
    await window.evaluate((targetChatId) => {
      const api = window.__canopyPanelTestApi;
      if (!api) throw new Error('__canopyPanelTestApi is not installed');
      // The first activation's canonical broadcast can arrive while the later
      // click is still optimistic. If that click rejects, this newer durable
      // selection is the rollback target.
      api.simulateDelayedChatActivation(targetChatId);
      api.releaseRejectedChatCommands();
    }, TARGET_CHAT_ID);

    await expect(targetTab).toHaveAttribute('data-active', 'true');
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('a rejected close restores a tab removed by an in-flight commit', async () => {
  const { launched, userDataDir, window } = await launchSelectionFixture(
    [
      { id: PRIOR_CHAT_ID, title: 'Previous chat' },
      { id: TARGET_CHAT_ID, title: 'Selected chat' },
    ],
    PRIOR_CHAT_ID,
  );
  try {
    const targetTab = window.getByTestId(
      `panel-tab-panel-chat-${TARGET_CHAT_ID}`,
    );
    await expect(targetTab).toBeVisible();
    await window.evaluate(() => {
      const api = window.__canopyPanelTestApi;
      if (!api) throw new Error('__canopyPanelTestApi is not installed');
      api.holdChatCommandsAsRejected('chat.close_tab');
    });

    await closePanelTab(window, `panel-chat-${TARGET_CHAT_ID}`);
    await window.evaluate((priorChatId) => {
      const api = window.__canopyPanelTestApi;
      if (!api) throw new Error('__canopyPanelTestApi is not installed');
      api.simulateDelayedChatActivation(priorChatId);
    }, PRIOR_CHAT_ID);
    await expect(targetTab).toHaveCount(0);
    await window.evaluate(() => {
      const api = window.__canopyPanelTestApi;
      if (!api) throw new Error('__canopyPanelTestApi is not installed');
      api.releaseRejectedChatCommands();
    });

    await expect(targetTab).toBeVisible({ timeout: 15_000 });
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

for (const archiveFirst of [false, true]) {
  test(`adding a chat keeps the new panel selected after canonical creation settles (archive first: ${archiveFirst})`, async () => {
    const { launched, userDataDir, window } = await launchSelectionFixture(
      [
        { id: PRIOR_CHAT_ID, title: 'Previous chat' },
        ...(archiveFirst
          ? [TARGET_CHAT_ID, THIRD_CHAT_ID].map((id) => ({
              id,
              title: id,
              messages: [
                {
                  id: `${id}-user`,
                  role: 'user',
                  blocks: [{ type: 'text', text: `History for ${id}` }],
                  timestamp: Date.now(),
                },
              ],
            }))
          : []),
      ],
      PRIOR_CHAT_ID,
    );
    try {
      const priorTab = window.getByTestId(
        `panel-tab-panel-chat-${PRIOR_CHAT_ID}`,
      );
      await expect(priorTab).toHaveAttribute('data-active', 'true', {
        timeout: 15_000,
      });
      if (archiveFirst) {
        for (const chatId of [TARGET_CHAT_ID, THIRD_CHAT_ID]) {
          await window.getByTestId(`panel-tab-panel-chat-${chatId}`).click();
          await closePanelTab(window, `panel-chat-${chatId}`);
          await expect(
            window.getByTestId(`panel-tab-panel-chat-${chatId}`),
          ).toHaveCount(0);
        }
      }
      await window.getByTestId('panel-add-tab-group-chat').click();
      await window.getByTestId('panel-add-menu-item-new-chat').click();
      const newTab = window
        .locator('[data-testid^="panel-tab-panel-chat-"]')
        .filter({ hasNotText: 'Previous chat' });
      await expect(newTab).toHaveCount(1);
      const newChatId = (await newTab.getAttribute('data-testid')).replace(
        'panel-tab-panel-chat-',
        '',
      );
      await expect
        .poll(
          () =>
            window.evaluate(
              async ([projectId, worktreeId, chatId]) => {
                const snapshot = await window.api.chat.getState({
                  projectId,
                  worktreeId,
                });
                return snapshot.tabsFile.tabs.some((tab) => tab.id === chatId);
              },
              [WORKSPACE_ID, WORKTREE_ID, newChatId],
            ),
          { timeout: 15_000 },
        )
        .toBe(true);
      await window.waitForTimeout(2_000);
      await expect(newTab).toHaveAttribute('data-active', 'true');
      await expect(priorTab).toHaveAttribute('data-active', 'false');
    } finally {
      await closeCanopy(launched.electronApp, userDataDir);
    }
  });
}

test('a delayed pre-creation selection cannot steal focus after archiving chats', async () => {
  const { launched, userDataDir, window } = await launchSelectionFixture(
    [
      { id: PRIOR_CHAT_ID, title: 'Previous chat' },
      ...[TARGET_CHAT_ID, THIRD_CHAT_ID].map((id) => ({
        id,
        title: id,
        messages: [
          {
            id: `${id}-user`,
            role: 'user',
            blocks: [{ type: 'text', text: `History for ${id}` }],
            timestamp: Date.now(),
          },
        ],
      })),
    ],
    PRIOR_CHAT_ID,
  );
  try {
    const priorTab = window.getByTestId(
      `panel-tab-panel-chat-${PRIOR_CHAT_ID}`,
    );
    await expect(priorTab).toHaveAttribute('data-active', 'true', {
      timeout: 15_000,
    });
    for (const chatId of [TARGET_CHAT_ID, THIRD_CHAT_ID]) {
      await window.getByTestId(`panel-tab-panel-chat-${chatId}`).click();
      await closePanelTab(window, `panel-chat-${chatId}`);
      await expect(
        window.getByTestId(`panel-tab-panel-chat-${chatId}`),
      ).toHaveCount(0);
    }
    await window.evaluate(() => {
      window.__canopyPanelTestApi.holdChatCommandsAsRejected('chat.create_tab');
    });
    await window.getByTestId('panel-add-tab-group-chat').click();
    await window.getByTestId('panel-add-menu-item-new-chat').click();
    const newTab = window
      .locator('[data-testid^="panel-tab-panel-chat-"]')
      .filter({ hasNotText: 'Previous chat' });
    await expect(newTab).toHaveAttribute('data-active', 'true');
    await window.evaluate((priorChatId) => {
      window.__canopyPanelTestApi.simulateDelayedChatActivation(priorChatId);
    }, PRIOR_CHAT_ID);
    // Keep creation in flight so the assertion covers the visible bounce,
    // rather than letting a later successful creation hide it again.
    await expect(newTab).toHaveAttribute('data-active', 'true');
    await expect(priorTab).toHaveAttribute('data-active', 'false');
  } finally {
    await window.evaluate(() =>
      window.__canopyPanelTestApi?.releaseRejectedChatCommands(),
    );
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('a delayed prior selection cannot steal focus from a file opened in the embedded tree', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-chat-tab-selection-ordering-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();
  const priorFilePath = path.join(worktreePath, 'selection-prior.txt');
  writeFileSync(priorFilePath, 'Prior file tab\n', 'utf8');
  writeFileSync(
    path.join(worktreePath, 'selection-opened.txt'),
    'Opened from the embedded tree\n',
    'utf8',
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: 'selection-prior-file',
    tabs: [
      {
        id: 'selection-prior-file',
        title: 'selection-prior.txt',
        kind: 'file',
        filePath: priorFilePath,
        fileViewMode: 'raw',
        description: priorFilePath,
        messages: [],
      },
    ],
  });
  const launched = await launchCanopy({ userDataDir });
  const window = await launched.electronApp.firstWindow();
  try {
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect
      .poll(() => window.evaluate(() => Boolean(window.__canopyPanelTestApi)), {
        timeout: 15_000,
      })
      .toBe(true);
    const priorTab = window.getByTestId(
      'panel-tab-panel-file-selection-prior-file',
    );
    await expect(priorTab).toHaveAttribute('data-active', 'true', {
      timeout: 15_000,
    });

    // Opening a file from the embedded tree of a file tab creates a new file
    // tab. Hold its main-owned creation in flight so the assertion covers the
    // visible bounce a delayed prior activation commit would cause.
    await window.evaluate(() => {
      window.__canopyPanelTestApi.holdChatCommandsAsRejected(
        'chat.create_file_tab',
      );
    });
    const priorPanel = window.locator(
      '[data-testid="panel-content-file-diff"][data-panel-id="panel-file-selection-prior-file"]',
    );
    await priorPanel.getByTestId('file-tab-tree-toggle').click();
    const row = priorPanel
      .getByTestId('file-tab-tree')
      .locator(
        '[data-testid="files-tree-row"][data-path="selection-opened.txt"]',
      );
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    const openedTab = window
      .locator('[data-testid^="panel-tab-panel-file-"]')
      .filter({ hasText: 'selection-opened.txt' });
    await expect(openedTab).toHaveAttribute('data-active', 'true');

    await window.evaluate(() => {
      window.__canopyPanelTestApi.simulateDelayedChatActivation(
        'selection-prior-file',
      );
    });
    await expect(openedTab).toHaveAttribute('data-active', 'true');
    await expect(priorTab).toHaveAttribute('data-active', 'false');
  } finally {
    await window.evaluate(() =>
      window.__canopyPanelTestApi?.releaseRejectedChatCommands(),
    );
    await closeCanopy(launched.electronApp, userDataDir);
  }
});
