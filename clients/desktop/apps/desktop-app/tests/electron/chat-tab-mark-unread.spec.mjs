// CAN-4378: "Mark as unread" / "Mark as read" in the chat tab right-click menu.
//
// Walks the real shared tab menu (`PanelTabContextMenu`) on the desktop panel
// grid. A mark goes through the renderer store action and main's
// `chat.mark_unread` with `manual: true`, so the tab marker, the sidebar's
// blue dot and the durable chat index all follow it.
//
// - A chat marked while another tab is selected stays unread across a
//   relaunch (main persisted it, with the manual flag), and "Mark as read"
//   clears it everywhere. After the relaunch the spec enters the worktree
//   through the command palette on the other chat: a sidebar-row entry lands
//   on the unread chat (attention landing, CAN-4957) and reads it, which is
//   the accepted "coming back" re-acknowledgement, not a lost mark.
// - Marking the chat on screen keeps it unread until the reader leaves it and
//   comes back (Slack-style); the menu label toggles meanwhile.
// - The sidebar dot's hover preview says "Marked as unread" for a manual mark,
//   and a later agent reply (committed through the main-process E2E chat-event
//   ingress, the same durable path a provider event takes) replaces it with
//   the reply preview.
//
// Seeded state only; no live agent.
//
//   pnpm run test:electron:built chat-tab-mark-unread.spec.mjs --reporter=line

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { readChatStorageIndexes } from './readChatStorage.mjs';
import { injectChatEvent, seedWorktreeChat } from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const ACTIVE_CHAT = 'mark-unread-active';
const ACTIVE_TITLE = 'Working chat';
const OTHER_CHAT = 'mark-unread-other';
const OTHER_TITLE = 'Release checklist';
const OTHER_REPLY = 'Checklist drafted for review.';
const NEW_REPLY = 'Fresh reply after the manual mark.';
const PALETTE_SHORTCUT = process.platform === 'darwin' ? 'Meta+K' : 'Control+K';

function seedChats(userDataDir) {
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    activeTabId: ACTIVE_CHAT,
    tabs: [
      {
        id: ACTIVE_CHAT,
        title: ACTIVE_TITLE,
        messages: [
          {
            id: 'active-reply',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Working on it.' }],
            timestamp: Date.parse('2026-10-20T12:00:00.000Z'),
          },
        ],
      },
      {
        id: OTHER_CHAT,
        title: OTHER_TITLE,
        messages: [
          {
            id: 'other-user',
            role: 'user',
            blocks: [{ type: 'text', text: 'Draft the release checklist.' }],
            timestamp: Date.parse('2026-10-20T12:01:00.000Z'),
          },
          {
            id: 'other-reply',
            role: 'assistant',
            blocks: [{ type: 'text', text: OTHER_REPLY }],
            timestamp: Date.parse('2026-10-20T12:02:00.000Z'),
          },
        ],
      },
    ],
  });
}

function durableTab(userDataDir, chatId) {
  return readChatStorageIndexes(
    path.join(userDataDir, 'workspaces', WORKSPACE_ID),
    WORKTREE_ID,
  ).live.tabs.find((tab) => tab.id === chatId);
}

// Chat search indexes shortly after boot; retry the palette until the chat
// shows up, then open it. Opening a chat names its tab, so the entry keeps
// that tab rather than landing on an unread one.
async function openChatFromPalette(window, title) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await window.keyboard.press(PALETTE_SHORTCUT);
    await expect(window.getByTestId('command-palette')).toBeVisible();
    await window.getByTestId('command-palette-input').fill(title);
    const option = window
      .getByRole('option')
      .filter({ hasText: title })
      .first();
    try {
      await option.waitFor({ state: 'visible', timeout: 3_000 });
      await option.click();
      await expect(window.getByTestId('command-palette')).toHaveCount(0);
      return;
    } catch {
      await window.keyboard.press('Escape');
      await window.waitForTimeout(2_000);
    }
  }
  throw new Error(`command palette never offered the chat "${title}"`);
}

function worktreeRow(window) {
  return window.locator(
    `[data-testid="worktree-row"][data-branch="${WORKTREE_ID}"]`,
  );
}

async function openWorktree(electronApp, { viaPalette = false } = {}) {
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  if (viaPalette) {
    await openChatFromPalette(window, ACTIVE_TITLE);
  } else {
    await app.selectWorktree(WORKTREE_ID);
  }
  await expect(chatTab(window, ACTIVE_CHAT)).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(chatTab(window, OTHER_CHAT)).toBeVisible();
  const row = worktreeRow(window);
  await expect(row).toBeVisible();
  return { window, row };
}

function chatTab(window, chatId) {
  return window.getByTestId(`panel-tab-panel-chat-${chatId}`);
}

async function chooseFromTabMenu(window, chatId, item) {
  await chatTab(window, chatId).click({ button: 'right' });
  const menu = window.getByTestId('panel-tab-context-menu');
  await expect(menu).toBeVisible();
  await window.getByTestId(`panel-tab-context-${item}`).click();
  await expect(menu).toBeHidden();
}

async function expectTabMenuItem(window, chatId, shown, hidden) {
  await chatTab(window, chatId).click({ button: 'right' });
  await expect(window.getByTestId('panel-tab-context-menu')).toBeVisible();
  await expect(window.getByTestId(`panel-tab-context-${shown}`)).toBeVisible();
  await expect(window.getByTestId(`panel-tab-context-${hidden}`)).toHaveCount(
    0,
  );
  await window.keyboard.press('Escape');
  await expect(window.getByTestId('panel-tab-context-menu')).toBeHidden();
}

test('a chat marked unread from its tab menu survives a relaunch until marked read', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-chat-mark-unread-'),
  );
  seedChats(userDataDir);

  const first = await launchCanopy({ userDataDir });
  try {
    const { window, row } = await openWorktree(first.electronApp);
    await expect(
      window.getByTestId(`panel-tab-unread-${OTHER_CHAT}`),
    ).toHaveCount(0);
    await expect(row.getByTestId('worktree-row-unread')).toHaveCount(0);

    await chooseFromTabMenu(window, OTHER_CHAT, 'mark-unread');

    await expect(
      window.getByTestId(`panel-tab-unread-${OTHER_CHAT}`),
    ).toBeVisible();
    await expect(row.getByTestId('worktree-row-unread')).toBeVisible();
    // Main owns the mark: the durable index carries it, flagged manual.
    await expect
      .poll(() => durableTab(userDataDir, OTHER_CHAT))
      .toMatchObject({ unread: true, unreadMarkedManually: true });
    // The selected chat was not touched.
    await expect(chatTab(window, ACTIVE_CHAT)).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expectTabMenuItem(window, OTHER_CHAT, 'mark-read', 'mark-unread');
  } finally {
    await closeCanopy(first.electronApp, userDataDir, { keepUserData: true });
  }

  // Relaunch, and keep the marked chat unselected on the way back in.
  const second = await launchCanopy({ userDataDir });
  try {
    const shell = await second.electronApp.firstWindow();
    const shellApp = new CanopyAppDriver(shell);
    await shellApp.waitForShell({ timeout: 30_000 });
    await shellApp.openMainPage();
    // The sidebar dot comes from main's persisted state before any entry.
    await expect(
      worktreeRow(shell).getByTestId('worktree-row-unread'),
    ).toBeVisible();
    const { window, row } = await openWorktree(second.electronApp, {
      viaPalette: true,
    });
    await expect(
      window.getByTestId(`panel-tab-unread-${OTHER_CHAT}`),
    ).toBeVisible();
    await expect(row.getByTestId('worktree-row-unread')).toBeVisible();

    await chooseFromTabMenu(window, OTHER_CHAT, 'mark-read');

    await expect(
      window.getByTestId(`panel-tab-unread-${OTHER_CHAT}`),
    ).toHaveCount(0);
    await expect(row.getByTestId('worktree-row-unread')).toHaveCount(0);
    await expect
      .poll(() => durableTab(userDataDir, OTHER_CHAT)?.unread)
      .toBe(false);
    expect(
      durableTab(userDataDir, OTHER_CHAT)?.unreadMarkedManually,
    ).toBeUndefined();
    await expectTabMenuItem(window, OTHER_CHAT, 'mark-unread', 'mark-read');
  } finally {
    await closeCanopy(second.electronApp, userDataDir);
  }
});

test('marking the chat on screen unread holds until the reader leaves and returns', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-chat-mark-unread-active-'),
  );
  seedChats(userDataDir);

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const { window, row } = await openWorktree(electronApp);
    const marker = window.getByTestId(`panel-tab-unread-${ACTIVE_CHAT}`);

    await chooseFromTabMenu(window, ACTIVE_CHAT, 'mark-unread');

    await expect(marker).toBeVisible();
    await expect(row.getByTestId('worktree-row-unread')).toBeVisible();
    await expect
      .poll(() => durableTab(userDataDir, ACTIVE_CHAT))
      .toMatchObject({ unread: true, unreadMarkedManually: true });
    // Still on screen and still unread: nothing re-read it, and the menu now
    // offers the way back.
    await expect(chatTab(window, ACTIVE_CHAT)).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expectTabMenuItem(window, ACTIVE_CHAT, 'mark-read', 'mark-unread');
    await expect(marker).toBeVisible();
    expect(durableTab(userDataDir, ACTIVE_CHAT)?.unread).toBe(true);

    // Leaving keeps it unread.
    await chatTab(window, OTHER_CHAT).click();
    await expect(chatTab(window, OTHER_CHAT)).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(marker).toBeVisible();
    await expect(row.getByTestId('worktree-row-unread')).toBeVisible();

    // Coming back reads it.
    await chatTab(window, ACTIVE_CHAT).click();
    await expect(chatTab(window, ACTIVE_CHAT)).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(marker).toHaveCount(0);
    await expect(row.getByTestId('worktree-row-unread')).toHaveCount(0);
    await expect
      .poll(() => durableTab(userDataDir, ACTIVE_CHAT)?.unread)
      .toBe(false);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('focusing the unread dot previews "Marked as unread" until a new reply replaces it', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-chat-mark-unread-preview-'),
  );
  seedChats(userDataDir);

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const { window, row } = await openWorktree(electronApp);
    await chooseFromTabMenu(window, OTHER_CHAT, 'mark-unread');
    const dot = row.getByTestId('worktree-row-unread');
    await expect(dot).toBeVisible();

    const popover = window
      .getByText('Unread Chats', { exact: true })
      .locator('..');
    // Hovering the row reveals its action chip over the dot, so open the
    // preview the keyboard way, as copilot-chat-preview.spec.mjs does.
    await dot.focus();
    await expect(popover).toBeVisible();
    await expect(popover).toContainText(OTHER_TITLE);
    await expect(popover).toContainText('Marked as unread');
    await expect(popover).not.toContainText(OTHER_REPLY);
    await dot.blur();
    await expect(popover).toHaveCount(0);

    // A new agent reply on the chat, committed through main like a provider
    // event, turns the manual mark into an ordinary unread reply.
    for (const event of [
      {
        type: 'item.completed',
        item: {
          id: 'mark-unread-new-reply',
          type: 'agent_message',
          phase: 'final_answer',
          text: NEW_REPLY,
        },
      },
      { type: 'turn.completed', status: 'completed' },
    ]) {
      await injectChatEvent(electronApp, {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        chatId: OTHER_CHAT,
        data: { type: 'codex', event },
      });
    }
    await expect
      .poll(() => durableTab(userDataDir, OTHER_CHAT)?.unreadMarkedManually)
      .toBeUndefined();
    expect(durableTab(userDataDir, OTHER_CHAT)?.unread).toBe(true);

    await dot.focus();
    await expect(popover).toBeVisible();
    await expect(popover).toContainText(OTHER_TITLE);
    await expect(popover).toContainText(NEW_REPLY);
    await expect(popover).not.toContainText('Marked as unread');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
