// CAN-4378: a muted space hides its blue sidebar dot.
//
// With per-space notification choices on (`canopySharedSpaceNotificationSettings`,
// enabled explicitly below), a space set to Mute hides its rows' blue unread
// dot and its group's unread rollup, while the chats inside keep their unread
// state, so the tab marker still shows. Choosing All activity brings the dot
// straight back. Choices are saved through the real producer sync and PATCH
// routes of a per-test cloud server, as in space-notification-settings.spec.mjs.
//
// - Code worktree: the unread comes from "Mark as unread" on a chat tab, so a
//   manual mark inside a muted space shows on the tab only.
// - Cowork Work Entry: the seeded unread chat of
//   `seeders/seedUnreadPreviewWorkspace.mjs`, in a sidebar group so the
//   desktop Cowork group rollup is covered too.
//
//   pnpm run test:electron:built muted-space-hides-unread-dot.spec.mjs --reporter=line

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  seedUnreadPreviewWorkspace,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { startSpaceNotificationsCloudMock } from './spaceNotificationsCloudMock.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const ACTIVE_CHAT = 'muted-space-active';
const MARKED_CHAT = 'muted-space-marked';
const NOTIFY = 'worktree-actions-menu-notifications';
const CHOICES = ['notify-all', 'notify-attention', 'notify-mute'];
const GROUP_UNREAD = 'Unread work in group';

function launchWithMuteControls(userDataDir, cloud) {
  return launchCanopy({
    userDataDir,
    env: {
      CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl,
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
        'canopy-shared-space-notification-settings': true,
      }),
    },
  });
}

async function connectCloud(window) {
  const result = await window.evaluate(
    async (key) => window.api.saveCanopyCloudApiKey({ apiKey: key }),
    'csk_muted_space_unread_e2e',
  );
  expect(result.status.authenticated).toBe(true);
}

async function expectChecked(window, prefix, checkedKey) {
  for (const key of CHOICES) {
    await expect(window.getByTestId(`${prefix}-${key}`)).toHaveAttribute(
      'aria-checked',
      key === checkedKey ? 'true' : 'false',
      { timeout: 15_000 },
    );
  }
}

test('a muted code worktree hides its blue dot and group rollup but keeps the tab marker', async () => {
  test.setTimeout(240_000);
  const cloud = await startSpaceNotificationsCloudMock();
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-muted-space-unread-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    activeTabId: ACTIVE_CHAT,
    tabs: [
      { id: ACTIVE_CHAT, title: 'Working chat' },
      {
        id: MARKED_CHAT,
        title: 'Flag for later',
        messages: [
          {
            id: 'marked-reply',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Ready when you are.' }],
            timestamp: Date.parse('2026-10-20T12:00:00.000Z'),
          },
        ],
      },
    ],
  });
  const { electronApp } = await launchWithMuteControls(userDataDir, cloud);
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    // Put the worktree in a sidebar group so its rollup dot is on screen.
    await window.evaluate(
      ({ workspaceLocalId, itemId }) =>
        window.api.sidebarItemGroups.create({
          scope: { workspaceLocalId },
          itemId,
          name: 'Release work',
        }),
      { workspaceLocalId: WORKSPACE_ID, itemId: WORKTREE_ID },
    );
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await connectCloud(window);
    await app.selectWorktree(WORKTREE_ID);

    const section = window.getByTestId(`sidebar-project-${WORKSPACE_ID}`);
    const row = section.locator(
      `[data-testid="worktree-row"][data-branch="${WORKTREE_ID}"]`,
    );
    const groupHeader = section.getByTestId('sidebar-item-group-header');
    const rowDot = row.getByTestId('worktree-row-unread');
    const groupDot = groupHeader.getByLabel(GROUP_UNREAD);
    const tabMarker = window.getByTestId(`panel-tab-unread-${MARKED_CHAT}`);
    await expect(groupHeader).toContainText('Release work');
    // A group shows its rollup only while collapsed and not hovered; the
    // selected row stays listed under it.
    await section.getByTestId('sidebar-item-group-toggle').click();
    await expect(
      section.getByTestId('sidebar-item-group-toggle'),
    ).toHaveAttribute('aria-expanded', 'false');
    await expect(row).toBeVisible();
    const moveAway = () => window.getByTestId('panel-grid-root').hover();
    await moveAway();
    await expect(rowDot).toHaveCount(0);
    await expect(groupDot).toHaveCount(0);

    // A manual mark on a chat that is not on screen.
    await window
      .getByTestId(`panel-tab-panel-chat-${MARKED_CHAT}`)
      .click({ button: 'right' });
    await window.getByTestId('panel-tab-context-mark-unread').click();
    await moveAway();
    await expect(tabMarker).toBeVisible();
    await expect(rowDot).toBeVisible();
    await expect(groupDot).toBeVisible();

    // Mute from the row menu and wait for the save to be acknowledged.
    await row.click({ button: 'right' });
    await expect(window.getByTestId('worktree-actions-menu')).toBeVisible();
    await window.getByTestId(`${NOTIFY}-notify-mute`).click();
    await expectChecked(window, NOTIFY, 'notify-mute');
    await expect
      .poll(() => cloud.choiceFor(WORKSPACE_ID, WORKTREE_ID))
      .toBe('mute');
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('worktree-actions-menu')).toHaveCount(0);
    await moveAway();

    await expect(rowDot).toHaveCount(0);
    await expect(groupDot).toHaveCount(0);
    // The chat itself is still unread.
    await expect(tabMarker).toBeVisible();

    // All activity brings the dot straight back.
    await row.click({ button: 'right' });
    await window.getByTestId(`${NOTIFY}-notify-all`).click();
    await expectChecked(window, NOTIFY, 'notify-all');
    await expect
      .poll(() => cloud.choiceFor(WORKSPACE_ID, WORKTREE_ID))
      .toBe(null);
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('worktree-actions-menu')).toHaveCount(0);
    await moveAway();

    await expect(rowDot).toBeVisible();
    await expect(groupDot).toBeVisible();
    await expect(tabMarker).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await cloud.close();
  }
});

test('a muted Cowork Work Entry hides its blue dot and group rollup until All activity is chosen', async () => {
  test.setTimeout(180_000);
  const cloud = await startSpaceNotificationsCloudMock();
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-muted-work-entry-unread-'),
  );
  seedUnreadPreviewWorkspace(userDataDir);
  const workspaceId = 'cowork-default';
  const entryId = 'entry-alpha';
  const prefix = `sidebar-work-entry-${entryId}`;
  const { electronApp } = await launchWithMuteControls(userDataDir, cloud);
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    // Put the entry in a sidebar group so its rollup dot can be checked.
    const groupId = await window.evaluate(
      async ({ workspaceLocalId, itemId }) =>
        (
          await window.api.sidebarItemGroups.create({
            scope: { workspaceLocalId },
            itemId,
            name: 'Planning',
          })
        ).id,
      { workspaceLocalId: workspaceId, itemId: entryId },
    );
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    await connectCloud(window);

    const dot = window.getByTestId(`${prefix}-unread`);
    const group = window.locator(`[data-sidebar-item-group-id="${groupId}"]`);
    const groupToggle = group.getByTestId('sidebar-item-group-toggle');
    const groupDot = group
      .getByTestId('sidebar-item-group-header')
      .getByLabel(GROUP_UNREAD);
    // Park the pointer over the main area, away from the sidebar.
    const moveAway = async () => {
      const { width, height } = window.viewportSize() ?? {
        width: 1200,
        height: 800,
      };
      await window.mouse.move(width - 40, height - 40);
    };
    // A group shows its rollup only while collapsed and not hovered.
    const expectGroupDot = async (count) => {
      await groupToggle.click();
      await expect(groupToggle).toHaveAttribute('aria-expanded', 'false');
      await moveAway();
      await expect(groupDot).toHaveCount(count);
      await groupToggle.click();
      await expect(groupToggle).toHaveAttribute('aria-expanded', 'true');
    };
    await expect(dot).toBeVisible();
    await expectGroupDot(1);

    const openMenu = async () => {
      await window.getByTestId(prefix).hover();
      await window.getByTestId(`${prefix}-menu`).click({ force: true });
    };
    await openMenu();
    await window.getByTestId(`${prefix}-notify-mute`).click();
    await expectChecked(window, prefix, 'notify-mute');
    await expect.poll(() => cloud.choiceFor(workspaceId, entryId)).toBe('mute');
    await window.keyboard.press('Escape');

    await expect(dot).toHaveCount(0);
    await expectGroupDot(0);

    await openMenu();
    await window.getByTestId(`${prefix}-notify-all`).click();
    await expectChecked(window, prefix, 'notify-all');
    await expect.poll(() => cloud.choiceFor(workspaceId, entryId)).toBe(null);
    await window.keyboard.press('Escape');

    await expect(dot).toBeVisible();
    await expectGroupDot(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await cloud.close();
  }
});
