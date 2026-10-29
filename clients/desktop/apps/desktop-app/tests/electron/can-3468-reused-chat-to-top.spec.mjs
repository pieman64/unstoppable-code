// CAN-3468: a new chat started from the Chats "+" lands at the top of the
// sidebar even when main reuses an existing empty Work Entry for it.
//
// The Chats "+" (`openNewCoworkTaskFromSidebar`) asks main for a Work Entry,
// and main hands back an existing *empty* entry rather than stacking another
// blank one. That reuse used to keep the entry's old registry slot, so in the
// default manual sort order the user's new chat showed up wherever the empty
// entry had been sitting instead of at the top.
//
// The fixture seeds the default Cowork workspace (the Chats section source)
// in manual order: two entries with messages, the older one first, and an
// empty entry below them. Provider traffic goes to the harness mock server.

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';

const WORKSPACE_ID = 'cowork-default';
const OLDER_ENTRY_ID = 'entry-older-busy';
const NEWER_ENTRY_ID = 'entry-newer-busy';
const EMPTY_ENTRY_ID = 'entry-empty';

function seedChat(workspaceDir, entryId, description, timestampIso) {
  const chatId = `chat-${entryId}`;
  writeJson(path.join(workspaceDir, 'chats', `${entryId}.json`), {
    version: 1,
    activeTabId: chatId,
    tabs: [
      {
        id: chatId,
        title: 'New Chat',
        description,
        createdAt: timestampIso,
        kind: 'chat',
        messages: [
          {
            id: `${chatId}-m1`,
            role: 'user',
            blocks: [{ type: 'text', text: `${description}.` }],
            timestamp: Date.parse(timestampIso),
          },
        ],
      },
    ],
  });
}

function seedChatsWithEmptyEntryBelow(userDataDir) {
  const workspacesDir = path.join(userDataDir, 'workspaces');
  const workspaceDir = path.join(workspacesDir, WORKSPACE_ID);
  const cowork = {
    createdAt: '2026-07-01T10:00:00.000Z',
    archiveRetentionDays: null,
  };
  writeJson(path.join(workspacesDir, 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: WORKSPACE_ID,
        name: 'Personal',
        type: 'cowork',
        color: '#7C9B6D',
        collapsed: false,
        order: 0,
        cowork,
      },
    ],
  });
  writeJson(path.join(workspaceDir, 'workspace.json'), {
    version: 1,
    type: 'cowork',
    cowork,
    alwaysShow: true,
  });
  // Registry order is the manual sidebar order: the older chat was dragged
  // to the top, and the empty entry sits at the bottom.
  writeJson(path.join(workspaceDir, 'work-entries.json'), {
    version: 1,
    entries: [
      { id: OLDER_ENTRY_ID, createdAt: '2026-07-01T10:00:00.000Z' },
      { id: NEWER_ENTRY_ID, createdAt: '2026-07-02T10:00:00.000Z' },
      { id: EMPTY_ENTRY_ID, createdAt: '2026-06-30T10:00:00.000Z' },
    ],
  });
  seedChat(
    workspaceDir,
    OLDER_ENTRY_ID,
    'Older planning chat',
    '2026-07-01T10:05:00.000Z',
  );
  seedChat(
    workspaceDir,
    NEWER_ENTRY_ID,
    'Newer research chat',
    '2026-07-02T10:05:00.000Z',
  );
}

async function chatsRowIds(window) {
  return window
    .getByTestId('sidebar-section-chats-content')
    .locator('[data-standalone-chat-id]')
    .evaluateAll((rows) =>
      rows.map((row) => row.getAttribute('data-standalone-chat-id')),
    );
}

test('a chat started from the Chats "+" on a reused empty entry is the top row', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can-3468-reused-chat-'),
  );
  seedChatsWithEmptyEntryBelow(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    // Manual order: the older chat leads, and the empty entry stays hidden.
    await expect
      .poll(() => chatsRowIds(window), { timeout: 15_000 })
      .toEqual([OLDER_ENTRY_ID, NEWER_ENTRY_ID]);

    await window.getByTestId('sidebar-section-chats').hover();
    await window.getByTestId('sidebar-section-chats-new-chat').click();
    await expect(window.getByTestId('cowork-top-bar')).toBeVisible({
      timeout: 15_000,
    });
    // Main reused the empty entry rather than creating another one.
    await expect(
      window.locator(
        `[data-testid="sidebar-work-entry-${EMPTY_ENTRY_ID}"][data-sidebar-selected-item]`,
      ),
    ).toHaveCount(1, { timeout: 15_000 });

    const composer = window
      .locator('[data-chat-textarea][contenteditable="true"]:visible')
      .first();
    await expect(composer).toBeVisible({ timeout: 30_000 });
    await composer.click();
    await composer.fill('Summarize the launch checklist.');
    await composer.press('Enter');
    await expect(
      window.getByText('Summarize the launch checklist.').first(),
    ).toBeVisible({ timeout: 15_000 });

    // The new chat leads the list, above the chat that was on top before.
    await expect
      .poll(() => chatsRowIds(window), { timeout: 15_000 })
      .toEqual([EMPTY_ENTRY_ID, OLDER_ENTRY_ID, NEWER_ENTRY_ID]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
