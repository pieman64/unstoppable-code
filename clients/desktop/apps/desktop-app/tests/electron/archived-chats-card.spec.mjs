// Labs → Archived chats card: the worktree header's archive hover card on the
// shared menu surface. Off keeps the classic popover; on draws the shared
// `ArchivedChatsCard` with a sentence-case label, menu rows and ghost icon
// buttons, and its actions still restore and open archived chats.
//
// Determinism: the worktree and its chats are seeded on disk; closing a chat
// with messages archives it through the real main-process IPC handlers.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { closePanelTab } from './canopyApp.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import { seedPanelWorktree } from './panelHarness.mjs';

const APP = 'ts-pnpm-vite';
const WORKSPACE_ID = `demo-${APP}`;
const BRANCH = 'demo-main';
const KEEPER_TAB_ID = 'keeper';
const ARCHIVE_TAB_IDS = ['card-1', 'card-2'];
const T = Date.parse('2026-04-10T12:00:00.000Z');

function buildMessages(label) {
  return [
    {
      id: `${label}-user`,
      role: 'user',
      blocks: [{ type: 'text', text: `Question for ${label}.` }],
      timestamp: T,
    },
    {
      id: `${label}-assistant`,
      role: 'assistant',
      blocks: [{ type: 'text', text: `Answer for ${label}.` }],
      timestamp: T + 10_000,
    },
  ];
}

async function launchWithArchivedChats() {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-archived-chats-card-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: [APP] });
  const nowIso = new Date().toISOString();
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: BRANCH,
    providerType: 'claude',
    activeTabId: KEEPER_TAB_ID,
    tabs: [KEEPER_TAB_ID, ...ARCHIVE_TAB_IDS].map((id) => ({
      id,
      title: id === KEEPER_TAB_ID ? 'Keeper' : `Archived ${id}`,
      providerType: 'claude',
      createdAt: nowIso,
      messages: buildMessages(id),
    })),
  });
  const worktreeDataDir = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'worktree-data',
    BRANCH,
  );
  mkdirSync(worktreeDataDir, { recursive: true });
  writeFileSync(
    path.join(worktreeDataDir, 'panel-layout-mode.json'),
    JSON.stringify({ version: 1, mode: 'advanced' }),
    'utf8',
  );
  const launched = await seedPanelWorktree({
    userDataDir,
    seedDemoWorkspaces: false,
  });
  const { window } = launched;
  // Closing a chat with messages archives it.
  for (const id of ARCHIVE_TAB_IDS) {
    await expect(window.getByTestId(`panel-tab-panel-chat-${id}`)).toBeVisible({
      timeout: 20_000,
    });
    await closePanelTab(window, `panel-chat-${id}`);
    await expect(window.getByTestId(`panel-tab-panel-chat-${id}`)).toHaveCount(
      0,
    );
  }
  await expect(window.getByTestId('chat-tab-archive-count')).toHaveText(
    String(ARCHIVE_TAB_IDS.length),
    { timeout: 15_000 },
  );
  return { ...launched, userDataDir };
}

async function setArchivedChatsCard(window, enabled) {
  await window.evaluate(
    (value) =>
      window.api.experiments.setChoice({
        experimentId: 'archived-chats-card',
        enabled: value,
      }),
    enabled,
  );
}

/** Leaves the archive control so its card closes. */
async function leaveArchiveControl(window) {
  await window.mouse.move(2, 400);
  await expect(window.getByTestId('chat-tab-archive-popover')).toHaveCount(0);
}

test('Archived chats card: Labs swaps the header hover card for the shared menu card', async () => {
  test.setTimeout(150_000);
  const { electronApp, userDataDir, window } = await launchWithArchivedChats();
  try {
    const archiveIcon = window
      .getByTestId('pr-status-bar')
      .getByTestId('chat-tab-archive');
    const popover = window.getByTestId('chat-tab-archive-popover');
    const card = popover.getByRole('group', { name: 'Archived chats' });

    // Off (the default): the classic popover, with no shared card in it.
    await archiveIcon.hover();
    await expect(popover).toBeVisible();
    await expect(
      popover.getByTestId('chat-tab-archive-popover-row'),
    ).toHaveCount(ARCHIVE_TAB_IDS.length);
    await expect(card).toHaveCount(0);
    await leaveArchiveControl(window);

    // On: the shared card.
    await setArchivedChatsCard(window, true);
    await archiveIcon.hover();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.getByText('Archived chats', { exact: true })).toHaveCSS(
      'text-transform',
      'none',
    );
    const rows = card.getByTestId('chat-tab-archive-popover-row');
    await expect(rows).toHaveCount(ARCHIVE_TAB_IDS.length);
    const row = rows.filter({ hasText: 'Archived card-1' });
    await expect(row).toHaveCount(1);
    // The visible title carries no tooltip that repeats it.
    await expect(row.locator('[title]')).toHaveCount(0);
    // The row is a menu row: arrow cursor, nested 8px corners.
    const openButton = row.locator('button').first();
    await expect(openButton).toContainText('Archived card-1');
    expect(
      await openButton.evaluate((node) => getComputedStyle(node).cursor),
    ).not.toBe('pointer');
    await expect(row).toHaveCSS('border-radius', '8px');
    const restore = row.getByTestId('archived-chat-restore');
    await expect(restore).toHaveAttribute('aria-label', 'Restore chat');
    await expect(row.getByTestId('archived-chat-summarize')).toHaveAttribute(
      'aria-label',
      'Summarize',
    );

    // Restoring brings the chat back as a tab and drops it from the card.
    await restore.click();
    await expect(window.getByTestId('panel-tab-panel-chat-card-1')).toBeVisible(
      { timeout: 15_000 },
    );
    await expect(window.getByTestId('chat-tab-archive-count')).toHaveText(
      String(ARCHIVE_TAB_IDS.length - 1),
      { timeout: 15_000 },
    );
    await leaveArchiveControl(window);

    // The row itself opens the read-only transcript.
    await archiveIcon.hover();
    await card
      .getByTestId('chat-tab-archive-popover-row')
      .filter({ hasText: 'Archived card-2' })
      .getByText('Archived card-2')
      .click();
    await expect(
      window.getByTestId('archived-chat-transcript-modal'),
    ).toBeVisible({ timeout: 10_000 });
    await window.keyboard.press('Escape');
    await expect(
      window.getByTestId('archived-chat-transcript-modal'),
    ).toHaveCount(0);

    // Off again: back to the classic popover.
    await setArchivedChatsCard(window, false);
    await archiveIcon.hover();
    await expect(popover).toBeVisible();
    await expect(card).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
