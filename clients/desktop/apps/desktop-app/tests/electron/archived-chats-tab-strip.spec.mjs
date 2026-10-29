// Archived chats stay in the worktree header for new profiles and old opt-ins.
// Maximizing or collapsing panel groups must not move or hide the control.
//
// Run after building the implementation:
//   pnpm run test:electron:built archived-chats-tab-strip.spec.mjs --reporter=line
//
// Determinism: the worktree and its chats are seeded on disk; closing a chat
// with messages archives it through the real main-process IPC handlers. No
// provider or network request runs.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
// Imported directly: the seeders barrel is part of the pinned perf harness.
import { seedEarlyAccess } from './seeders/seedEarlyAccess.mjs';
import { closePanelTab } from './canopyApp.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import {
  collectLeaves,
  DEFAULT_GROUP_IDS,
  getLayout,
  seedPanelWorktree,
} from './panelHarness.mjs';

const APP = 'ts-pnpm-vite';
const BRANCH = 'demo-main';
const KEEPER_TAB_ID = 'keeper';
const ARCHIVE_TAB_ID = 'archive-me';
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

async function launchWithArchivedChat({ earlyAccess }) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-archive-strip-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: [APP] });
  const nowIso = new Date().toISOString();
  seedWorktreeChat({
    userDataDir,
    workspaceId: `demo-${APP}`,
    worktreeId: BRANCH,
    providerType: 'claude',
    activeTabId: KEEPER_TAB_ID,
    tabs: [KEEPER_TAB_ID, ARCHIVE_TAB_ID].map((id) => ({
      id,
      title: id === KEEPER_TAB_ID ? 'Keeper' : 'Archive Me',
      providerType: 'claude',
      createdAt: nowIso,
      messages: buildMessages(id),
    })),
  });
  const worktreeDataDir = path.join(
    userDataDir,
    'workspaces',
    `demo-${APP}`,
    'worktree-data',
    BRANCH,
  );
  mkdirSync(worktreeDataDir, { recursive: true });
  writeFileSync(
    path.join(worktreeDataDir, 'panel-layout-mode.json'),
    JSON.stringify({ version: 1, mode: 'advanced' }),
    'utf8',
  );
  if (earlyAccess) {
    const { filePath } = seedEarlyAccess({ userDataDir });
    const choices = JSON.parse(readFileSync(filePath, 'utf8'));
    choices.accounts.local['archived-chat-tabs'] = true;
    writeFileSync(filePath, JSON.stringify(choices), 'utf8');
  }
  const launched = await seedPanelWorktree({
    userDataDir,
    seedDemoWorkspaces: false,
  });
  const { window } = launched;
  await expect(
    window.getByTestId(`panel-tab-panel-chat-${ARCHIVE_TAB_ID}`),
  ).toBeVisible({ timeout: 20_000 });
  // Closing a chat with messages archives it.
  await closePanelTab(window, `panel-chat-${ARCHIVE_TAB_ID}`);
  await expect(
    window.getByTestId(`panel-tab-panel-chat-${ARCHIVE_TAB_ID}`),
  ).toHaveCount(0);
  await expect(window.getByTestId('chat-tab-archive')).toHaveCount(1, {
    timeout: 15_000,
  });
  return { ...launched, userDataDir };
}

// Whether the popover's first row is the topmost element at its center, i.e.
// visible and not clipped by an ancestor.
function popoverRowHitTest(window) {
  return window.getByTestId('chat-tab-archive-popover').evaluate((popover) => {
    const row = popover.querySelector('button, [role="button"], li') ?? popover;
    const rect = row.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return {
      onBody: popover.parentElement === document.body,
      hitsPopover: hit !== null && popover.contains(hit),
      insideViewport:
        rect.top >= 0 &&
        rect.left >= 0 &&
        rect.bottom <= window.innerHeight &&
        rect.right <= window.innerWidth,
    };
  });
}

test('new profile: the archive control stays in the worktree header', async () => {
  const { electronApp, userDataDir, window } = await launchWithArchivedChat({
    earlyAccess: false,
  });
  try {
    await expect(
      window.getByTestId('pr-status-bar').getByTestId('chat-tab-archive'),
    ).toHaveCount(1);
    await expect(window.getByTestId('chat-tab-archive-count')).toHaveText('1');
    await expect(
      window
        .locator('[data-testid^="panel-group-title-"]')
        .locator('[data-testid="chat-tab-archive"]'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('retired opt-in: the archive control stays in the header and remains reachable', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window } = await launchWithArchivedChat({
    earlyAccess: true,
  });
  try {
    const archive = window.getByTestId('chat-tab-archive');
    await expect(
      window.getByTestId('pr-status-bar').getByTestId('chat-tab-archive'),
    ).toHaveCount(1);
    await expect(
      window.locator(
        '[data-testid^="panel-group-title-"] [data-testid="chat-tab-archive"]',
      ),
    ).toHaveCount(0);

    // The header popover renders inline, fully on screen.
    await archive.hover();
    await expect(window.getByTestId('chat-tab-archive-popover')).toBeVisible();
    expect(await popoverRowHitTest(window)).toEqual({
      onBody: false,
      hitsPopover: true,
      insideViewport: true,
    });
    await window.mouse.move(2, 2);
    await expect(window.getByTestId('chat-tab-archive-popover')).toHaveCount(0);

    // Maximizing another group leaves the header control reachable.
    const layout = await getLayout(window);
    const otherGroupId = collectLeaves(layout.root)
      .map((leaf) => leaf.groupId)
      .find((groupId) => groupId !== DEFAULT_GROUP_IDS.chat);
    expect(otherGroupId).toBeTruthy();
    await window.evaluate(
      (groupId) => window.__canopyPanelTestApi.maximizeGroup(groupId, true),
      otherGroupId,
    );
    await expect(archive).toHaveCount(1);
    await expect(
      window.getByTestId('pr-status-bar').getByTestId('chat-tab-archive'),
    ).toBeVisible();
    await archive.click();
    await expect(window.getByTestId('archived-chats-modal')).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('archived-chats-modal')).toHaveCount(0);
    await window.evaluate(
      (groupId) => window.__canopyPanelTestApi.maximizeGroup(groupId, false),
      otherGroupId,
    );
    await expect(
      window.getByTestId('pr-status-bar').getByTestId('chat-tab-archive'),
    ).toBeVisible();

    // Collapsing the chat group leaves the header and its popover reachable.
    await window.evaluate(
      (groupId) => window.__canopyPanelTestApi.collapseGroup(groupId, true),
      DEFAULT_GROUP_IDS.chat,
    );
    await expect(archive).toBeVisible();
    await archive.hover();
    await expect(window.getByTestId('chat-tab-archive-popover')).toBeVisible();
    expect(await popoverRowHitTest(window)).toEqual({
      onBody: false,
      hitsPopover: true,
      insideViewport: true,
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
